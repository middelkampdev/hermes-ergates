"""Installing the plugin through a running ``hermes serve``, the way the app's one-tap setup will.

Since v0.21.6 a plugin enabled after the server started gets its routes on the
first request to ``/api/plugins/<name>/`` (``hermes_cli/web_server_dashboard.py``
``_PluginApiHotMount``), so the app needs no restart after the install. The
hot-mount test starts its own server (``web_without_plugin`` in
``conftest.py``) on a Hermes root without the plugin, and installs
``plugin_git_repo``: one commit holding the files git tracks in
``integrations/ergates``, the way a user's server would clone it.

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

from app_messages import hermes_plugin_messages

API = "/api/plugins/ergates"
HUB = "/api/dashboard/plugins/hub"
AGENT_PLUGINS = "/api/dashboard/agent-plugins"
INSTALL = f"{AGENT_PLUGINS}/install"
SWEEP_WAIT_SECONDS = 60


def request_install(web, headers: dict, *, identifier: str, ref: str, enable: bool):
    """What a dashboard client sends to install a plugin from a URL at one commit; the whole answer."""
    reply = web.post(INSTALL, json={"identifier": identifier, "ref": ref, "enable": enable, "force": False},
                     headers=headers)
    print(f"POST {INSTALL} -> {reply.status_code}\n{json.dumps(reply.json(), indent=2)}")
    return reply


def install_through_dashboard(web, headers: dict, *, identifier: str, ref: str, enable: bool) -> dict:
    """What a dashboard client sends to install a plugin from a URL at one commit; the answer's JSON."""
    return request_install(web, headers, identifier=identifier, ref=ref, enable=enable).json()


def hub_row(web, headers: dict, name: str = "ergates") -> dict | None:
    """The plugin's row in the plugin list the app reads, or None when the list has none."""
    reply = web.get(HUB, headers=headers)
    assert reply.status_code == 200, reply.text
    return next((row for row in reply.json()["plugins"] if row["name"] == name), None)


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
    assert health.json()["install"] == {"kind": "git install", "commit": plugin_git_repo.sha, "catalog_name": None,
                                        "loaded_commit": plugin_git_repo.sha}
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
    assert health["install"] == {"kind": "git install", "commit": plugin_monorepo.sha, "catalog_name": None,
                                 "loaded_commit": plugin_monorepo.sha}


def test_the_plugin_list_and_the_enable_routes_follow_the_plugin_the_app_installs(
        web_without_plugin, token_headers, plugin_monorepo):
    """The app reads the plugin list to tell a plugin that is not installed from one that is turned off, and
    turns it on again with the enable route. Hermes answers 404 ``Plugin not found`` for a plugin it does not
    serve, installed and disabled or not installed at all, and only the list tells those apart."""
    web = web_without_plugin
    not_served = {"detail": hermes_plugin_messages()["pluginNotFound"]}
    assert hub_row(web, token_headers) is None
    absent = web.get(f"{API}/health", headers=token_headers)
    assert (absent.status_code, absent.json()) == (404, not_served)

    result = install_through_dashboard(web, token_headers, identifier=plugin_monorepo.identifier,
                                       ref=plugin_monorepo.sha, enable=True)
    assert (result["ok"], result["plugin_name"], result["enabled"]) == (True, "ergates", True)
    row = hub_row(web, token_headers)
    assert (row["runtime_status"], row["version"]) == ("enabled", plugin_monorepo.version)
    assert web.get(f"{API}/health", headers=token_headers).status_code == 200

    disabled = web.post(f"{AGENT_PLUGINS}/ergates/disable", headers=token_headers)
    assert (disabled.status_code, disabled.json()["ok"]) == (200, True)
    gone = web.get(f"{API}/health", headers=token_headers)
    assert (gone.status_code, gone.json()) == (404, not_served)
    row = hub_row(web, token_headers)
    assert (row["runtime_status"], row["version"]) == ("disabled", plugin_monorepo.version)

    enabled = web.post(f"{AGENT_PLUGINS}/ergates/enable", headers=token_headers)
    assert (enabled.status_code, enabled.json()["ok"]) == (200, True)
    assert web.get(f"{API}/health", headers=token_headers).status_code == 200
    assert hub_row(web, token_headers)["runtime_status"] == "enabled"


def test_a_refused_install_answers_400_with_a_text_that_starts_as_the_app_expects(
        web_without_plugin, token_headers, plugin_monorepo):
    """The app maps a failed install by the start of the 400's ``detail``: a commit that cannot be fetched is a
    failed download, and installing the plugin again finds it already there (the second phone, or a retry
    after the phone lost the first answer). The refused install changes nothing."""
    web = web_without_plugin
    messages = hermes_plugin_messages()["install"]

    unknown = request_install(web, token_headers, identifier=plugin_monorepo.identifier, ref="0" * 40, enable=True)
    assert unknown.status_code == 400
    assert any(unknown.json()["detail"].startswith(prefix) for prefix in messages["download_failed"]), unknown.text
    assert hub_row(web, token_headers) is None

    installed = request_install(web, token_headers, identifier=plugin_monorepo.identifier, ref=plugin_monorepo.sha,
                                enable=True)
    assert installed.status_code == 200

    again = request_install(web, token_headers, identifier=plugin_monorepo.identifier, ref=plugin_monorepo.sha,
                            enable=True)
    assert again.status_code == 400
    assert any(again.json()["detail"].startswith(prefix) for prefix in messages["already_installed"]), again.text
    assert web.get(f"{API}/health", headers=token_headers).status_code == 200
    assert hub_row(web, token_headers)["runtime_status"] == "enabled"


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
