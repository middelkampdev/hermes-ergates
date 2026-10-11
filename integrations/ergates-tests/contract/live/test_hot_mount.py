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
from pathlib import Path

import pytest
import yaml

API = "/api/plugins/ergates"
INSTALL = "/api/dashboard/agent-plugins/install"


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
    assert health.json()["plugin_version"] == plugin_git_repo.version
    # The whole router dashboard/manifest.json names is live, not only the route that mounted it.
    assert web.get(f"{API}/attention/prefs", params={"scope": "*"}, headers=token_headers).status_code == 200
    installed = root_without_plugin / "plugins" / "ergates"
    assert installed.is_dir() and not installed.is_symlink()
    scanned, blocking = scan(installed)
    assert (scanned.verdict, blocking) == ("safe", [])


def test_the_install_scan_finds_this_plugin_safe(plugin_git_repo):
    """The verdict Hermes's install scan gives the tree a user installs, before any server runs.

    ``safe`` installs without ``force`` and without a confirmation prompt,
    which the app's one-tap setup cannot show.
    """
    from tools.plugin_guard import should_allow_plugin_install

    result, blocking = scan(plugin_git_repo.path)

    assert (result.verdict, blocking) == ("safe", [])
    assert should_allow_plugin_install(result, force=False)[0] is True
