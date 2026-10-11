"""Ergates operations are routes of a dashboard plugin API router (ADR-031).

Pins that `hermes serve` imports `<plugin>/dashboard/<api>` named by
`dashboard/manifest.json`, mounts its `router` under `/api/plugins/<name>`,
only for an enabled user plugin, and that those routes sit behind the
dashboard auth (session token on loopback, the gated cookie auth otherwise).

Since v0.21.6 the same mount also runs on the first request for a plugin
enabled after the server started (the hot mount).
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
    # hermes_cli/web_server_dashboard.py:1028-1037 (in _mount_one_plugin_api)
    assert hermes.lines(DASHBOARD, 1028, 1037) == (
        '        router = getattr(mod, "router", None)\n'
        "        if router is None:\n"
        "            _log.warning(\"Plugin %s api file has no 'router' attribute\", plugin[\"name\"])\n"
        "            return False\n"
        "        app.include_router(\n"
        "            router,\n"
        "            prefix=f\"/api/plugins/{plugin['name']}\",\n"
        "            dependencies=[Depends(_plugin_route_secret_scope)],\n"
        "        )\n"
        '        _log.info("Mounted plugin API routes: /api/plugins/%s/", plugin["name"])'
    )
    # hermes_cli/web_server.py:1066: mounted when the server module loads.
    assert hermes.lines(WEB, 1066, 1066) == "_mount_plugin_api_routes()"


def test_a_plugin_enabled_after_start_is_mounted_on_its_first_request(hermes: PinnedSource) -> None:
    """The hot mount: the startup sweep registers a fallback for unmatched plugin paths, and
    that fallback rediscovers the plugin and runs the same mount, with the same gates."""
    # hermes_cli/web_server_dashboard.py:887-890: the startup sweep, then the fallback.
    assert hermes.lines(DASHBOARD, 887, 890) == (
        "    for plugin in _get_dashboard_plugins():\n"
        "        with _plugin_api_mount_lock:\n"
        "            _mount_one_plugin_api(app, plugin, enabled_set, disabled_set)\n"
        "    _register_plugin_api_fallback(app)"
    )
    # hermes_cli/web_server_dashboard.py:965: the fallback route.
    assert hermes.lines(DASHBOARD, 965, 965) == (
        '    app.router.add_route("/api/plugins/{name}/{path:path}", _plugin_api_hot_mount,'
    )
    # hermes_cli/web_server_dashboard.py:950-952: on a miss it mounts the plugin and re-routes the same request.
    assert hermes.lines(DASHBOARD, 950, 952) == (
        "        if await asyncio.to_thread(_try_hot_mount_plugin_api, name):\n"
        '            _log.info("Hot-mounted plugin API routes on first request: /api/plugins/%s/", name)\n'
        "            await app.router(dict(scope, path_params={}), receive, send)"
    )
    # hermes_cli/web_server_dashboard.py:907 and 911-914: rediscovery, the launch profile's
    # enable lists, and the shared mount.
    assert hermes.lines(DASHBOARD, 907, 907) == "    enabled_set, disabled_set = _get_enabled_set(), _get_disabled_set()"
    assert hermes.lines(DASHBOARD, 911, 914) == (
        '        plugin = next((p for p in _get_dashboard_plugins(force_rescan=True) if p.get("name") == name), None)\n'
        "        routes = app.router.routes\n"
        "        before = len(routes)\n"
        "        if plugin is None or not _mount_one_plugin_api(app, plugin, enabled_set, disabled_set):"
    )


def test_a_user_plugin_api_mounts_only_when_enabled(hermes: PinnedSource) -> None:
    # hermes_cli/web_server_dashboard.py:796-797
    assert hermes.lines(DASHBOARD, 796, 797) == (
        '    if source == "user" and plugin_name not in enabled_set:\n' '        return "not in plugins.enabled"'
    )
    # hermes_cli/web_server_dashboard.py:982-985: both mount paths apply it in _mount_one_plugin_api.
    assert hermes.lines(DASHBOARD, 982, 985) == (
        "    skip = _plugin_api_mount_skip_reason(plugin, enabled_set, disabled_set)\n"
        "    if skip:\n"
        '        _log.debug("Plugin %s: skipping API mount (%s)", plugin.get("name", ""), skip)\n'
        "        return False"
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
