"""Ergates operations are routes of a dashboard plugin API router (ADR-031).

Pins that `hermes serve` imports `<plugin>/dashboard/<api>` named by
`dashboard/manifest.json`, mounts its `router` under `/api/plugins/<name>`,
only for an enabled user plugin, and that those routes sit behind the
dashboard auth (session token on loopback, the gated cookie auth otherwise).
"""

from __future__ import annotations

from pinned import PinnedSource

DASHBOARD = "hermes_cli/web_server_dashboard.py"
WEB = "hermes_cli/web_server.py"
PUBLIC = "hermes_cli/dashboard_auth/public_paths.py"


def test_a_plugin_declares_its_api_file_in_dashboard_manifest_json(hermes: PinnedSource) -> None:
    # hermes_cli/web_server_dashboard.py:573 and 531-532
    assert hermes.lines(DASHBOARD, 573, 573) == '            manifest_file = child / "dashboard" / "manifest.json"'
    assert hermes.lines(DASHBOARD, 531, 532) == (
        '    raw_api = data.get("api")\n' "    safe_api = _safe_plugin_api_relpath(raw_api, dashboard_dir=dashboard_dir)"
    )


def test_the_router_is_mounted_under_api_plugins_name(hermes: PinnedSource) -> None:
    # hermes_cli/web_server_dashboard.py:829-834
    assert hermes.lines(DASHBOARD, 829, 834) == (
        '            router = getattr(mod, "router", None)\n'
        "            if router is None:\n"
        "                _log.warning(\"Plugin %s api file has no 'router' attribute\", plugin[\"name\"])\n"
        "                continue\n"
        "            app.include_router(router, prefix=f\"/api/plugins/{plugin['name']}\")\n"
        '            _log.info("Mounted plugin API routes: /api/plugins/%s/", plugin["name"])'
    )
    # hermes_cli/web_server.py:984: mounted when the server module loads.
    assert hermes.lines(WEB, 984, 984) == "_mount_plugin_api_routes()"


def test_a_user_plugin_api_mounts_only_when_enabled(hermes: PinnedSource) -> None:
    # hermes_cli/web_server_dashboard.py:796-797
    assert hermes.lines(DASHBOARD, 796, 797) == (
        '    if source == "user" and plugin_name not in enabled_set:\n' '        return "not in plugins.enabled"'
    )


def test_plugin_routes_sit_behind_the_dashboard_auth(hermes: PinnedSource) -> None:
    public = hermes.assigned(PUBLIC, "PUBLIC_API_PATHS")
    assert "/api/status" in public
    assert not any(path.startswith("/api/plugins") for path in public)
    # hermes_cli/web_server.py:710-719: every other /api/ path needs the session token ...
    assert hermes.lines(WEB, 710, 719) == (
        "    if (\n"
        '        not getattr(request.state, "token_authenticated", False)\n'
        '        and not getattr(request.app.state, "auth_required", False)\n'
        '        and path.startswith("/api/")\n'
        "        and path not in _PUBLIC_API_PATHS\n"
        '        and not path.startswith("/api/mcp/oauth/callback/")\n'
        "        and not _has_valid_session_token(request)\n"
        "        and not _has_valid_query_token(request, path)\n"
        "    ):\n"
        '        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})'
    )
    # ... and, when the gate is on, the cookie auth decides (hermes_cli/web_server.py:697-698).
    assert hermes.lines(WEB, 697, 698) == (
        "    from hermes_cli.dashboard_auth.middleware import gated_auth_middleware\n"
        "    return await gated_auth_middleware(request, call_next)"
    )
