"""Installing the plugin through a running ``hermes serve``, the way the app's one-tap setup will.

Since v0.21.6 a plugin enabled after the server started gets its routes on the
first request to ``/api/plugins/<name>/`` (``hermes_cli/web_server_dashboard.py``
``_PluginApiHotMount``), so the app needs no restart after the install. Each
test starts its own server (``serve_hermes``) on a Hermes root without the
plugin, and installs ``plugin_git_repo``: one commit holding a copy of this
plugin, the way a user's server would clone it.

Hermes scans every install (``tools/plugin_guard.py``). It blocks this
plugin's tree today, so the hot-mount test turns ``plugins.scan_on_install``
off in its own root, and the scan's verdict is recorded on its own below. The
install never passes ``force``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

API = "/api/plugins/ergates"
INSTALL = "/api/dashboard/agent-plugins/install"


def _root_without_plugin(base: Path, *, scan_on_install: bool) -> Path:
    """A new Hermes root with no plugin in it; ``scan_on_install`` true is Hermes's default."""
    root = base / "hermes"
    root.mkdir()
    # Same reason as conftest.py: no lazy `uv pip install` of optional provider stacks.
    config: dict = {"security": {"allow_lazy_installs": False}}
    if not scan_on_install:
        config["plugins"] = {"scan_on_install": False}
    (root / "config.yaml").write_text(yaml.safe_dump(config), encoding="utf-8")
    return root


@pytest.fixture
def root_without_plugin(tmp_path) -> Path:
    """A root for the hot-mount test: no plugin, and the install scan off (see the module docstring)."""
    return _root_without_plugin(tmp_path, scan_on_install=False)


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


def test_the_install_route_refuses_this_plugin_while_the_install_scan_is_on(serve_hermes, tmp_path, token_headers,
                                                                            plugin_git_repo):
    """The answer a dashboard client gets today from a Hermes with its default settings: Hermes's
    ``{"detail"}`` error with the scan report as text."""
    root = _root_without_plugin(tmp_path, scan_on_install=True)
    web = serve_hermes(root)

    reply = web.post(INSTALL, json={"identifier": plugin_git_repo.url, "ref": plugin_git_repo.sha, "enable": True,
                                    "force": False}, headers=token_headers)

    print(f"POST {INSTALL} -> {reply.status_code}\n{reply.json()['detail']}")
    assert reply.status_code == 400
    assert list(reply.json()) == ["detail"]
    assert reply.json()["detail"].startswith("Security scan blocked plugin install: Blocked (dangerous verdict")
    assert not (root / "plugins" / "ergates").exists()
    assert web.get(f"{API}/health", headers=token_headers).status_code == 404


def test_the_install_scan_finds_this_plugin_dangerous_and_force_cannot_override_it(plugin_git_repo):
    """The verdict Hermes's install scan gives this plugin's tree today, and why.

    A ``dangerous`` verdict blocks every install, ``force`` included; ``caution``
    would install with ``force``. The one critical finding is the live suite's
    own session token in ``contract/live/conftest.py``: the scanner steps a
    finding down one severity only in a test tree (a top-level ``tests/`` and
    the like) or a ``test_*`` file, and that file is neither.
    """
    from tools.plugin_guard import format_scan_report, scan_plugin, should_allow_plugin_install

    result = scan_plugin(plugin_git_repo.path, source=plugin_git_repo.url)

    print(format_scan_report(result))
    critical = sorted((finding.pattern_id, finding.file) for finding in result.findings
                      if finding.severity == "critical")
    assert (result.verdict, critical) == ("dangerous", [("hardcoded_secret", "contract/live/conftest.py")])
    assert should_allow_plugin_install(result, force=True)[0] is False
