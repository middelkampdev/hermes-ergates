"""Installing the plugin through a running ``hermes serve``, the way the app's one-tap setup will.

Since v0.21.6 a plugin enabled after the server started gets its routes on the
first request to ``/api/plugins/<name>/`` (``hermes_cli/web_server_dashboard.py``
``_PluginApiHotMount``), so the app needs no restart after the install. The
hot-mount test starts its own server (``serve_hermes``) on a Hermes root
without the plugin, and installs ``plugin_git_repo``: one commit holding the
files git tracks in ``integrations/ergates``, the way a user's server would
clone it.

Hermes scans every install (``tools/plugin_guard.py``): ``safe`` installs,
``caution`` needs confirmation, and ``dangerous`` is blocked even with
``force``. The hot-mount root's ``config.yaml`` sets only
``security.allow_lazy_installs: false`` (as ``conftest.py`` does for the
session root) and leaves ``plugins.scan_on_install`` at Hermes's default, on,
so its install passes through that scan; it never passes ``force``. The
plugin's tests live in ``integrations/ergates-tests`` so the installed tree
holds only runtime code; ``contract/test_install_scan.py`` runs the same
scanner on the same files without the live suite.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
import yaml

API = "/api/plugins/ergates"
INSTALL = "/api/dashboard/agent-plugins/install"
SWEEP_WAIT_SECONDS = 60


@pytest.fixture
def root_without_plugin(tmp_path) -> Path:
    """A new Hermes root with no plugin in it, and the install scan on (Hermes's default)."""
    root = tmp_path / "hermes"
    root.mkdir()
    # Same reason as conftest.py: no lazy `uv pip install` of optional provider stacks.
    (root / "config.yaml").write_text(yaml.safe_dump({"security": {"allow_lazy_installs": False}}),
                                      encoding="utf-8")
    return root


@pytest.fixture
def web_without_plugin(serve_hermes, root_without_plugin):
    """A dashboard started on ``root_without_plugin``, before any plugin is installed."""
    return serve_hermes(root_without_plugin)


def install_through_dashboard(web, headers: dict, *, identifier: str, ref: str, enable: bool) -> dict:
    """What a dashboard client sends to install a plugin from a URL at one commit; the answer's JSON."""
    reply = web.post(INSTALL, json={"identifier": identifier, "ref": ref, "enable": enable, "force": False},
                     headers=headers)
    print(f"POST {INSTALL} -> {reply.status_code}\n{json.dumps(reply.json(), indent=2)}")
    return reply.json()


def scan(tree: Path):
    """Hermes's install scan of ``tree``: its verdict, and every finding that would stop an install.

    A ``high`` finding makes the verdict ``caution``, which needs confirmation;
    a ``critical`` one makes it ``dangerous`` (``tools/skills_guard.py``
    ``_determine_verdict``).
    """
    from tools.plugin_guard import format_scan_report, scan_plugin

    result = scan_plugin(tree)
    print(format_scan_report(result))
    blocking = sorted((finding.severity, finding.pattern_id, finding.file) for finding in result.findings
                      if finding.severity in {"high", "critical"})
    return result, blocking


def test_plugin_installed_after_start_serves_health_without_restart(web_without_plugin, root_without_plugin,
                                                                    token_headers, plugin_git_repo):
    web = web_without_plugin
    assert web.get(f"{API}/health", headers=token_headers).status_code == 404

    result = install_through_dashboard(web, token_headers, identifier=plugin_git_repo.url, ref=plugin_git_repo.sha,
                                       enable=True)

    assert (result["ok"], result["plugin_name"], result["enabled"]) == (True, "ergates", True)
    health = web.get(f"{API}/health", headers=token_headers)
    assert health.status_code == 200
    print(json.dumps(health.json(), indent=2))
    assert health.json()["plugin_version"] == plugin_git_repo.version
    # Hermes records the install in plugins/.install-metadata.json; the app offers going back to a commit
    # only for a git install. The first request installed the templates, and the plugin is enabled in the
    # root's one profile.
    assert health.json()["install"] == {"kind": "git install", "commit": plugin_git_repo.sha, "catalog_name": None}
    assert health.json()["setup"] == {"finished": True, "templates": "installed",
                                      "profiles": [{"name": "default", "enabled": True}]}
    # The whole router dashboard/manifest.json names is live, not only the route that mounted it.
    assert web.get(f"{API}/attention/prefs", params={"scope": "*"}, headers=token_headers).status_code == 200
    installed = root_without_plugin / "plugins" / "ergates"
    assert installed.is_dir() and not installed.is_symlink()
    scanned, blocking = scan(installed)
    assert (scanned.verdict, blocking) == ("safe", [])


def test_a_subdirectory_install_keeps_no_git_folder_and_health_still_names_its_commit(
        web_without_plugin, root_without_plugin, token_headers, plugin_monorepo):
    """The plugin lives in ``integrations/ergates`` of its repository, so a user installs from that subdirectory.
    Hermes copies only that folder: the installed plugin has no ``.git``, and its commit is known from Hermes's
    record alone (an install of a repository's root keeps its ``.git``)."""
    web = web_without_plugin

    result = install_through_dashboard(web, token_headers, identifier=plugin_monorepo.identifier,
                                       ref=plugin_monorepo.sha, enable=True)

    assert (result["ok"], result["plugin_name"], result["enabled"]) == (True, "ergates", True)
    installed = root_without_plugin / "plugins" / "ergates"
    assert installed.is_dir() and not installed.is_symlink()
    assert not (installed / ".git").exists()
    health = web.get(f"{API}/health", headers=token_headers).json()
    assert health["install"] == {"kind": "git install", "commit": plugin_monorepo.sha, "catalog_name": None}


def test_the_installed_plugin_sweeps_inside_hermes_serve(web_without_plugin, token_headers, plugin_git_repo):
    """The hot mount imports ``dashboard/api.py``, which starts the periodic sweep in the server
    itself: its first pass ends seconds later, with no host cron line and no restart."""
    web = web_without_plugin
    result = install_through_dashboard(web, token_headers, identifier=plugin_git_repo.url, ref=plugin_git_repo.sha,
                                       enable=True)
    assert result["ok"] is True

    deadline = time.monotonic() + SWEEP_WAIT_SECONDS
    sweep = web.get(f"{API}/health", headers=token_headers).json()["sweep"]
    while sweep["last_run_at"] is None and time.monotonic() < deadline:
        time.sleep(0.5)
        sweep = web.get(f"{API}/health", headers=token_headers).json()["sweep"]

    assert sweep["interval_seconds"] == 120
    assert isinstance(sweep["last_run_at"], float)
    assert sweep["last_error"] is None


def test_the_install_scan_finds_this_plugin_safe(plugin_git_repo):
    """The verdict Hermes's install scan gives the tree a user installs, before any server runs.

    ``safe`` installs without ``force`` and without a confirmation prompt,
    which the app's one-tap setup cannot show.
    """
    from tools.plugin_guard import should_allow_plugin_install

    result, blocking = scan(plugin_git_repo.path)

    assert (result.verdict, blocking) == ("safe", [])
    assert should_allow_plugin_install(result, force=False)[0] is True
