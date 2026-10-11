"""How ``ergates/hermes_adapter.py`` calls Hermes.

``test_hermes_root.py`` pins what ``get_default_hermes_root`` computes; this
file pins every other Hermes name the adapter calls, as text and syntax, so a
pin bump that renames or reshapes one fails here with the fact spelled out.
``live/test_adapter.py`` runs the same calls against the pinned Hermes.

``configured_timezone()`` calls ``hermes_time.get_timezone()`` with no
arguments. Quiet hours are read in that zone because Hermes cron computes a
routine's next run from ``hermes_time.now()``, which is in that zone.
"""

from __future__ import annotations

import ast

from ergates import hermes_adapter, reminders
from pinned import PinnedSource

CONSTANTS = "hermes_constants.py"
HERMES_TIME = "hermes_time.py"
CRON_JOBS = "cron/jobs.py"
PROFILES = "hermes_cli/profiles.py"
CONFIG = "hermes_cli/config.py"
DISCOVERY = "hermes_cli/plugins_discovery.py"
PLUGINS = "hermes_cli/plugins.py"
JOBS = "cron/jobs.py"
CRONJOB = "tools/cronjob_tools.py"
PROVIDER = "cron/scheduler_provider.py"
RPC = "tui_gateway/methods_tools.py"
PROMPT_SCAN = "tools/cronjob_prompt_scan.py"


def _arguments(function: ast.FunctionDef) -> list[str]:
    arguments = function.args
    return [a.arg for a in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs)]


def test_get_default_hermes_root_takes_no_arguments_and_returns_a_path(hermes: PinnedSource) -> None:
    """The adapter calls it with no arguments. At v0.21.6 it also takes an optional
    keyword-only ``home``; without it the function reads ``HERMES_HOME`` from the process
    environment, never the context-local override a profile scope sets."""
    function = hermes.function(CONSTANTS, "get_default_hermes_root")
    arguments = function.args
    assert arguments.posonlyargs == []
    assert arguments.args == []
    assert arguments.vararg is None
    assert [a.arg for a in arguments.kwonlyargs] == ["home"]
    assert [ast.unparse(d) for d in arguments.kw_defaults] == ["None"]
    assert arguments.kwarg is None
    assert ast.unparse(function.returns) == "Path"
    # hermes_constants.py:220
    assert hermes.lines(CONSTANTS, 220, 220) == (
        '    env_home = str(home).strip() if home is not None else os.environ.get("HERMES_HOME", "").strip()'
    )


def test_get_timezone_takes_no_arguments_and_returns_a_zone_or_none(hermes: PinnedSource) -> None:
    function = hermes.function(HERMES_TIME, "get_timezone")
    assert function.lineno == 129
    arguments = function.args
    assert arguments.posonlyargs == []
    assert arguments.args == []
    assert arguments.vararg is None
    assert arguments.kwonlyargs == []
    assert arguments.kwarg is None
    assert ast.unparse(function.returns) == "Optional[ZoneInfo]"
    # hermes_time.py:129-131
    assert hermes.lines(HERMES_TIME, 129, 131) == (
        "def get_timezone() -> Optional[ZoneInfo]:\n"
        '    """Return the active profile\'s configured ZoneInfo, or None (server-local)."""\n'
        "    return _timezone_entry()[1]"
    )


def test_hermes_time_now_is_in_the_configured_zone(hermes: PinnedSource) -> None:
    # hermes_time.py:146-149
    assert hermes.lines(HERMES_TIME, 146, 149) == (
        "def now() -> datetime:\n"
        '    """Current time as a tz-aware datetime: configured zone, else server-local."""\n'
        "    tz = get_timezone()\n"
        "    return datetime.now(tz) if tz is not None else datetime.now().astimezone()"
    )


def test_cron_computes_the_next_run_from_hermes_time_now(hermes: PinnedSource) -> None:
    # cron/jobs.py:40-41
    assert hermes.lines(CRON_JOBS, 40, 41) == "from hermes_time import now as _hermes_now\nfrom hermes_time import get_timezone"
    assert hermes.function(CRON_JOBS, "compute_next_run").lineno == 1178
    # cron/jobs.py:1180 and 1187: base_time is now without a last run
    assert hermes.lines(CRON_JOBS, 1180, 1180) == "    now = _hermes_now()"
    assert hermes.lines(CRON_JOBS, 1187, 1187) == "    base_time = (_parse_aware(last_run_at) if last_run_at else None) or now"
    # cron/jobs.py:1218-1220: the cron branch matches the expression against the wall clock of
    # get_timezone()'s zone (the base's own zone only when none is configured).
    assert hermes.lines(CRON_JOBS, 1218, 1220) == (
        "        zone = get_timezone() or base_time.tzinfo\n"
        "        base_wall = base_time.astimezone(zone).replace(tzinfo=None)\n"
        "        it = croniter(expr, base_wall)"
    )


def test_the_adapter_accepts_exactly_the_profile_names_hermes_accepts(hermes: PinnedSource) -> None:
    # hermes_cli/profiles.py:29 aliases the canonical pattern, hermes_constants.py:320.
    assert hermes.lines(PROFILES, 29, 29) == (
        "_PROFILE_ID_RE = PROFILE_ID_RE  # legacy alias; hermes_constants.PROFILE_ID_RE is canonical"
    )
    assert hermes.lines(CONSTANTS, 320, 320) == 'PROFILE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")'
    assert hermes_adapter._PROFILE_RE.pattern == "^[a-z0-9][a-z0-9_-]{0,63}$"


def test_profile_lookups_take_a_name(hermes: PinnedSource) -> None:
    assert _arguments(hermes.function(PROFILES, "profile_exists")) == ["name"]
    assert _arguments(hermes.function(PROFILES, "get_profile_dir")) == ["name"]
    # hermes_cli/profiles.py:240-246: `default` always exists; a named profile is a live folder.
    assert hermes.lines(PROFILES, 240, 246) == (
        "def profile_exists(name: str) -> bool:\n"
        '    """Check whether a live (non-tombstoned) profile directory exists."""\n'
        "    canon = normalize_profile_name(name)\n"
        '    if canon == "default":\n'
        "        return True\n"
        "    profile_dir = get_profile_dir(canon)\n"
        "    return profile_dir.is_dir() and not named_profile_is_deleted(profile_dir)"
    )


def test_a_profile_scope_is_the_context_local_home_override(hermes: PinnedSource) -> None:
    assert _arguments(hermes.function(CONSTANTS, "set_hermes_home_override")) == ["path"]
    assert _arguments(hermes.function(CONSTANTS, "reset_hermes_home_override")) == ["token"]
    # tui_gateway/methods_tools.py:44-47: the cron.manage RPC's own profile scope, which the adapter mirrors.
    assert hermes.lines(RPC, 44, 47) == (
        '                    profile_dir = _tools_mod("hermes_cli.profiles").get_profile_dir(profile)\n'
        "                    if not profile_dir or not profile_dir.is_dir():\n"
        "                        return _err(rid, 4064, f\"profile '{profile}' not found\")\n"
        '                    token = _tools_mod("hermes_constants").set_hermes_home_override(str(profile_dir))'
    )


def test_profile_name_is_derived_from_the_active_home_at_every_read(hermes: PinnedSource) -> None:
    # hermes_cli/plugins.py:393-402: a property, evaluated per access. When the
    # lookup raises it answers "default", the same text as the default profile's own name.
    assert hermes.lines(PLUGINS, 393, 402) == (
        "    @property\n"
        "    def profile_name(self) -> str:\n"
        '        """Active profile name (``"default"``, the ``~/.hermes/profiles/<name>`` id, or ``"custom"``),\n'
        "        derived from ``HERMES_HOME`` — not ``_cli_ref``, which is None outside the interactive CLI —\n"
        '        so gateway and kanban workers get it too."""\n'
        "        try:\n"
        "            from hermes_cli.profiles import get_active_profile_name\n"
        "            return get_active_profile_name()\n"
        "        except Exception:\n"
        '            return "default"'
    )


def test_the_lookup_behind_profile_name_answers_default_only_for_the_root_home(hermes: PinnedSource) -> None:
    """``current_profile`` accepts a "default" only when this lookup, asked again, names the default profile."""
    assert _arguments(hermes.function(PROFILES, "get_active_profile_name")) == []
    # hermes_cli/profiles.py:2098-2104
    assert hermes.lines(PROFILES, 2098, 2104) == (
        "def get_active_profile_name() -> str:\n"
        '    """Profile name inferred from HERMES_HOME: ``"default"`` when unset or ``~/.hermes``, the\n'
        '    name under ``~/.hermes/profiles/<name>``, ``"custom"`` for any other path."""\n'
        "    from hermes_constants import get_hermes_home\n"
        "    resolved = get_hermes_home().resolve()\n"
        "    if resolved == _get_default_hermes_home().resolve():\n"
        '        return "default"'
    )


def test_config_is_read_and_written_through_load_config_and_save_config(hermes: PinnedSource) -> None:
    assert _arguments(hermes.function(CONFIG, "load_config")) == []
    save = hermes.function(CONFIG, "save_config")
    assert _arguments(save)[0] == "config"
    assert {"strip_defaults", "preserve_keys", "merge_existing"} <= set(_arguments(save))


def test_plugin_discovery_can_be_asked_without_loading_anything(hermes: PinnedSource) -> None:
    assert _arguments(hermes.function(DISCOVERY, "collect_directory_manifests")) == []
    assert _arguments(hermes.function(DISCOVERY, "gate_manifest")) == ["manifest", "disabled", "enabled"]
    assert '    return ManifestGate("load")' in hermes.text(DISCOVERY).splitlines()


def test_cron_create_is_the_cronjob_function_behind_the_cron_manage_rpc(hermes: PinnedSource) -> None:
    assert {"action", "name", "schedule", "prompt"} <= set(_arguments(hermes.function(CRONJOB, "cronjob")))
    # tools/cronjob_tools.py:712: a successful create reports the new job's id.
    assert hermes.lines(CRONJOB, 712, 712) == (
        '        "success": True, "job_id": job["id"], "name": job["name"], "skill": job.get("skill"),'
    )


def test_a_create_refuses_what_the_private_prompt_scan_reports(hermes: PinnedSource) -> None:
    """``check_prompt`` calls the scan ``cronjob(action="create")`` runs on the
    prompt as given, so ``POST /reminders`` and the reminder tool answer 400 for
    a prompt the create would refuse on every try. The scan is private: this pin
    is what notices a rename or a new meaning of its answer."""
    scan = hermes.function(PROMPT_SCAN, "_scan_cron_prompt")
    assert _arguments(scan) == ["prompt"]
    # tools/cronjob_prompt_scan.py:121-123: an error string when blocked, else "".
    assert hermes.lines(PROMPT_SCAN, 121, 123) == (
        "def _scan_cron_prompt(prompt: str) -> str:\n"
        '    """Strict scan of the USER-SUPPLIED prompt (create/update + runtime defense-in-depth).\n'
        '    Returns an error string when blocked, else "". Invisible unicode is reported first, in'
    )
    # tools/cronjob_prompt_scan.py:29: one of the phrases it refuses.
    assert hermes.lines(PROMPT_SCAN, 29, 29) == """    (r'do\\s+not\\s+tell\\s+the\\s+user', "deception_hide"),"""
    # tools/cronjob_tools.py:48, 661-662 and 674-675: the create scans the prompt first and
    # answers the scan's error instead of creating a job.
    assert hermes.lines(CRONJOB, 48, 48) == "from tools.cronjob_prompt_scan import _scan_cron_prompt"
    assert hermes.function(CRONJOB, "_action_create").lineno == 642
    assert hermes.lines(CRONJOB, 661, 662) == "    error = (\n        (prompt and _scan_cron_prompt(prompt))"
    assert hermes.lines(CRONJOB, 674, 675) == "    if error:\n        return tool_error(error, success=False)"
    assert hermes.lines(CRONJOB, 957, 957) == '_JOBLESS_ACTIONS = {"create": _action_create, "list": _action_list}'


def test_cron_lookups_and_schedule_checks(hermes: PinnedSource) -> None:
    assert _arguments(hermes.function(JOBS, "get_job")) == ["job_id"]
    assert _arguments(hermes.function(JOBS, "list_jobs")) == ["include_disabled"]
    assert _arguments(hermes.function(JOBS, "parse_schedule")) == ["schedule"]
    assert _arguments(hermes.function(JOBS, "compute_next_run")) == ["schedule", "last_run_at"]
    # cron/jobs.py:1893: a given name is stored as given, so an exact-name match finds it.
    assert hermes.lines(JOBS, 1893, 1893) == "    name = name or label_source[:50].strip()"


def test_a_one_shot_that_ran_is_kept_as_a_completed_job_for_seven_days(hermes: PinnedSource) -> None:
    """``HermesCron.get_job`` reports ``completed`` from the job's state, and the
    reminder service counts a completed job as gone for a receipt keyed by its
    payload (the agent tool's path): the same request after the run is a new
    reminder, not a 7-day-old record."""
    # cron/jobs.py:1866-1867: a one-shot runs once.
    assert hermes.lines(JOBS, 1866, 1867) == (
        '    if parsed_schedule["kind"] == "once" and repeat is None:\n'
        "        repeat = 1"
    )
    # cron/jobs.py:2429-2433 and 2451-2452: after its run the job is retired in place, not removed.
    assert hermes.lines(JOBS, 2429, 2433) == (
        "        if finite and completed >= times:\n"
        "            # Limit reached: retain a terminal record instead of popping it, so the status just\n"
        "            # written stays inspectable in `cronjob list`; the retention sweep prunes it later.\n"
        "            _complete_job_record(job)\n"
        "            return"
    )
    assert hermes.lines(JOBS, 2451, 2452) == "    else:\n        _complete_job_record(job)  # one-shot: terminal completion"
    # cron/jobs.py:1632-1634
    assert hermes.lines(JOBS, 1632, 1634) == (
        "def _complete_job_record(job: Dict[str, Any]) -> None:\n"
        '    """Retire *job* in place as a terminal completion (record kept for `cronjob list`)."""\n'
        '    job.update(enabled=False, state="completed", next_run_at=None)'
    )
    # cron/jobs.py:2822-2824: the retention sweep removes it only after 7 days.
    assert hermes.assigned(JOBS, "COMPLETED_ONESHOT_RETENTION_DAYS") == 7
    # cron/jobs.py:1951-1954, 527 and 545-547: get_job returns the record with "completed" kept.
    assert hermes.lines(JOBS, 1951, 1954) == (
        "def get_job(job_id: str) -> Optional[Dict[str, Any]]:\n"
        '    """Get a job by ID."""\n'
        '    job = next((j for j in load_jobs() if j["id"] == job_id), None)\n'
        "    return _normalize_job_record(job) if job is not None else None"
    )
    assert hermes.lines(JOBS, 527, 527) == '    normalized["state"] = effective_job_state(normalized)'
    assert hermes.lines(JOBS, 545, 547) == (
        '    stored = _coerce_job_text(job.get("state")).strip()\n'
        '    if stored in {"completed", "error"}:\n'
        "        return stored"
    )


def test_a_create_ends_well_inside_the_reminder_in_flight_window(hermes: PinnedSource) -> None:
    """The only wait inside a create is the jobs lock, bounded at 30 s; the
    built-in scheduler registers nothing. A second identical request takes
    over a claim only after reminders.IN_FLIGHT_SECONDS."""
    timeout = hermes.assigned(JOBS, "_JOBS_LOCK_TIMEOUT_SECONDS")
    assert timeout == 30.0
    assert timeout < reminders.IN_FLIGHT_SECONDS
    register = hermes.function(PROVIDER, "register_job", owner="CronScheduler")
    assert ast.unparse(register.body[-1]) == "return None"
    in_process = next(
        node for node in hermes.tree(PROVIDER).body
        if isinstance(node, ast.ClassDef) and node.name == "InProcessCronScheduler"
    )
    assert "register_job" not in {node.name for node in in_process.body if isinstance(node, ast.FunctionDef)}
    # cron/scheduler_provider.py:397-398: no configured provider means the built-in one.
    assert hermes.lines(PROVIDER, 397, 398) == (
        '    if not name or name in ("builtin", "in-process", "inprocess"):\n'
        "        return InProcessCronScheduler()"
    )


# --- the tool grant: granted_toolsets() and toolset_for_tool() -----------------

PROFILES_RPC = "tui_gateway/methods_profiles.py"
MODEL_TOOLS = "model_tools.py"
TOOLSETS = "toolsets.py"
MCP_REGISTRATION = "tools/mcp_tool_registration.py"
MCP_COMMON = "tools/mcp_tool_common.py"
MIGRATIONS = "hermes_cli/config_migrations.py"
UTILS = "utils.py"
TUI_SERVER = "tui_gateway/server.py"
GATEWAY_TURN = "gateway/run_turn.py"
TOOLS_CONFIG = "hermes_cli/tools_config.py"


def test_the_toolset_pin_is_what_profiles_configure_writes(hermes: PinnedSource) -> None:
    # tui_gateway/methods_profiles.py:509-517: `enabled_toolsets` replaces tools.enabled_toolsets; an empty list removes the pin.
    assert hermes.lines(PROFILES_RPC, 509, 517) == (
        "def _save_toolset_pin(cfg, enabled, save_config) -> None:\n"
        "    wanted = sorted(_clean_names(enabled))\n"
        '    tools_cfg = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}\n'
        "    if wanted:\n"
        '        tools_cfg["enabled_toolsets"] = wanted\n'
        "    else:\n"
        '        tools_cfg.pop("enabled_toolsets", None)\n'
        '    cfg["tools"] = tools_cfg\n'
        "    save_config(cfg)"
    )
    # tui_gateway/methods_profiles.py:384: profiles.describe reads the same key as the profile's toolsets.
    assert hermes.lines(PROFILES_RPC, 384, 384) == (
        '    pinned = (cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}).get("enabled_toolsets")'
    )


def test_hermes_builds_a_sessions_tools_from_platform_toolsets_not_from_the_pin(hermes: PinnedSource) -> None:
    """Why the gate enforces the pin: Hermes does not, when it builds a session."""
    # tui_gateway/server.py:1869 (app sessions) and gateway/run_turn.py:2151 (gateway turns).
    assert hermes.lines(TUI_SERVER, 1869, 1869) == '        enabled = _get_platform_tools(cfg, "cli", include_default_mcp_servers=True)'
    assert hermes.lines(GATEWAY_TURN, 2151, 2151) == "        return sorted(_get_platform_tools(user_config, platform_key))"
    # hermes_cli/tools_config.py:553-554: that function reads platform_toolsets.
    assert hermes.lines(TOOLS_CONFIG, 553, 554) == (
        '    platform_toolsets = config.get("platform_toolsets") or {}\n'
        "    toolset_names = platform_toolsets.get(platform)"
    )


def test_config_is_read_without_a_copy_for_every_tool_call(hermes: PinnedSource) -> None:
    assert _arguments(hermes.function(CONFIG, "load_config_readonly")) == []


def test_the_registry_names_the_toolset_of_a_tool(hermes: PinnedSource) -> None:
    # model_tools.py:976-977
    assert hermes.lines(MODEL_TOOLS, 976, 977) == (
        "def get_toolset_for_tool(tool_name: str) -> Optional[str]:\n"
        "    return registry.get_toolset_for_tool(tool_name)"
    )
    assert _arguments(hermes.function(TOOLSETS, "resolve_toolset")) == ["name", "visited", "include_registry"]


def test_an_mcp_servers_tools_are_the_toolset_mcp_server_name(hermes: PinnedSource) -> None:
    # tools/mcp_tool_registration.py:334 (in _register_candidates)
    assert hermes.lines(MCP_REGISTRATION, 334, 334) == '    toolset_name = f"mcp-{name}"'
    # tools/mcp_tool_common.py:140-144: the one reader of `enabled` (v0.21.6 removed the
    # registration module's private `_server_enabled`, which the adapter read before).
    assert _arguments(hermes.function(MCP_COMMON, "mcp_server_enabled")) == ["cfg"]
    assert hermes.lines(MCP_COMMON, 144, 144) == '    return _parse_boolish(cfg.get("enabled", True), default=True)'
    # tools/mcp_tool_registration.py:551-553: Hermes connects a server unless `enabled` says no.
    assert hermes.lines(MCP_REGISTRATION, 551, 553) == (
        "    for name, config in servers.items():\n"
        "        if not mcp_server_enabled(config):\n"
        "            continue"
    )


def test_profiles_configure_turns_an_mcp_server_off_with_enabled_false(hermes: PinnedSource) -> None:
    """Since v0.21.6 profiles.configure writes `enabled`, the key the MCP runtime reads, and
    drops `disabled`; config migration 46 turns a legacy `disabled: true` into `enabled: false`.
    Until that migration runs on a config the previous pin wrote, `disabled: true` is still
    there and the runtime ignores it, so granted_toolsets keeps checking both keys (the
    `disabled` check is redundant once migrated)."""
    # tui_gateway/methods_profiles.py:702-705
    assert hermes.lines(PROFILES_RPC, 702, 705) == (
        "    for srv, entry in mcp_cfg.items():\n"
        "        if isinstance(entry, dict):\n"
        '            entry["enabled"] = srv in wanted\n'
        '            entry.pop("disabled", None)'
    )
    # hermes_cli/config_migrations.py:620 and 624-626, registered as version 46 at 820.
    assert hermes.lines(MIGRATIONS, 620, 620) == (
        '    legacy = {n: e for n, e in servers.items() if isinstance(e, dict) and "disabled" in e}'
    )
    assert hermes.lines(MIGRATIONS, 624, 626) == (
        "    for name in turned_off:\n"
        '        del legacy[name]["disabled"]\n'
        '        legacy[name]["enabled"] = False'
    )
    assert hermes.lines(MIGRATIONS, 820, 820) == "    (46, _migrate_to_46),"
    assert _arguments(hermes.function(UTILS, "is_truthy_value")) == ["value", "default"]


# --- the gateway lifecycle guard: check_gateway_lifecycle() ----------------------

LIFECYCLE_GUARD = "cron/lifecycle_guard.py"


def test_a_create_refuses_a_prompt_the_gateway_lifecycle_guard_blocks(hermes: PinnedSource) -> None:
    """``check_gateway_lifecycle`` asks the guard ``create_job`` runs, on the same
    stripped prompt and in the profile's home, so ``POST /reminders`` and the
    reminder tool answer 400 for a prompt the create would refuse on every try."""
    # cron/jobs.py:1880-1885: the create strips the prompt and runs the guard without a script.
    assert hermes.lines(JOBS, 1880, 1885) == (
        "    prompt_text = _coerce_job_text(prompt).strip()\n"
        "    if not prompt_text and not f[\"script\"] and not normalized_skills:\n"
        "        raise ValueError(EMPTY_PAYLOAD_ERROR)\n"
        "    # Reject gateway-lifecycle commands (respawn loops) here, not just in the CLI: covers the tool.\n"
        "    from cron.lifecycle_guard import check_gateway_lifecycle\n"
        "    check_gateway_lifecycle(prompt_text, f[\"script\"])"
    )
    assert _arguments(hermes.function(LIFECYCLE_GUARD, "check_gateway_lifecycle")) == ["prompt", "script"]
    # cron/lifecycle_guard.py:24: a refusal is a ValueError.
    assert hermes.lines(LIFECYCLE_GUARD, 24, 24) == "class GatewayLifecycleBlocked(ValueError):"
    # tools/cronjob_tools.py:1037-1038: cronjob() turns the refusal into an error answer, never a job.
    assert hermes.lines(CRONJOB, 1037, 1038) == "    except Exception as e:\n        return tool_error(str(e), success=False)"


def test_the_gateway_lifecycle_guard_refuses_prose_and_depends_on_the_active_profile(hermes: PinnedSource) -> None:
    """Why the check runs before a create, and inside the profile's home."""
    # cron/lifecycle_guard.py:59: "Remind me to kill time before the Hermes gateway meeting" matches.
    assert hermes.lines(LIFECYCLE_GUARD, 59, 59) == '    r"|(?:\\bp?kill\\b[^\\n]*\\bhermes\\b[^\\n]*\\bgateway)"'
    # cron/lifecycle_guard.py:217-219: `hermes -p <name> gateway restart` is refused only for the
    # profile the guard runs as, which it reads from the active Hermes home.
    assert hermes.lines(LIFECYCLE_GUARD, 217, 219) == (
        "        from hermes_cli.profiles import get_active_profile_name\n"
        "\n"
        "        return get_active_profile_name() or None"
    )


def test_the_profile_listing_names_default_and_every_profile_folder(hermes: PinnedSource) -> None:
    """profile_names() keeps only the live ones: this listing includes deleted profiles."""
    assert _arguments(hermes.function(PROFILES, "list_profile_names")) == []
    # hermes_cli/profiles.py:282-285
    assert hermes.lines(PROFILES, 282, 285) == (
        '    names = ["default"]\n'
        "    with contextlib.suppress(OSError):\n"
        "        names.extend(entry.name for entry in _iter_named_profile_dirs(live_only=False))\n"
        "    return names"
    )
