"""Ergates operations are routes of a dashboard plugin API router (ADR-031).

Pins that `hermes serve` imports `<plugin>/dashboard/<api>` named by
`dashboard/manifest.json`, mounts its `router` under `/api/plugins/<name>`,
only for an enabled user plugin, and that those routes sit behind the
dashboard auth (session token on loopback, the gated cookie auth otherwise).

Since v0.21.6 the same mount also runs on the first request for a plugin
enabled after the server started (the hot mount), and every route of the
router runs inside Hermes's profile scope for the request's `profile`
parameter: a path parameter of that name, else the `?profile=` query.
"""

from __future__ import annotations

from pinned import PinnedSource

DASHBOARD = "hermes_cli/web_server_dashboard.py"
WEB = "hermes_cli/web_server.py"
WEB_PROFILES = "hermes_cli/web_server_profiles.py"
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


def test_every_plugin_route_runs_in_the_profile_scope_of_its_profile_parameter(hermes: PinnedSource) -> None:
    """The router dependency takes ``profile`` by name: FastAPI fills it from a route path
    parameter called ``profile``, else from the ``?profile=`` query. A name Hermes refuses is
    answered by Hermes (400, or 404 when no live profile has it), before the route runs, in
    FastAPI's ``{"detail": ...}`` shape. So ``dashboard/api.py`` names no path parameter
    ``profile`` (``tests/test_dashboard_files.py``), and ``GET /attention/prefs?profile=*``
    is refused here: ``*`` is no profile name."""
    # hermes_cli/web_server_dashboard.py:806 and 815-817
    assert hermes.lines(DASHBOARD, 806, 806) == "async def _plugin_route_secret_scope(profile: Optional[str] = None):"
    assert hermes.lines(DASHBOARD, 815, 817) == (
        "    from hermes_cli.web_server_profiles import _config_profile_scope\n"
        "    with _config_profile_scope(profile):\n"
        "        yield"
    )
    # hermes_cli/web_server_profiles.py:299-302: no name is the dashboard's own profile ...
    assert hermes.lines(WEB_PROFILES, 299, 302) == (
        "    if _is_current_profile(profile):\n"
        "        profile_dir, scoped = None, None  # the dashboard's own profile: no home override\n"
        "    else:\n"
        "        profile_dir = _resolve_profile_dir(profile.strip())"
    )
    # ... any other is resolved or refused (hermes_cli/web_server_profiles.py:192-198).
    assert hermes.lines(WEB_PROFILES, 192, 198) == (
        "    from hermes_cli import profiles as profiles_mod\n"
        "    try:\n"
        "        profiles_mod.validate_profile_name(name)\n"
        "    except ValueError as e:\n"
        "        raise HTTPException(status_code=400, detail=str(e))\n"
        "    if not profiles_mod.profile_exists(name):\n"
        "        raise HTTPException(status_code=404, detail=f\"Profile '{name}' does not exist.\")"
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
