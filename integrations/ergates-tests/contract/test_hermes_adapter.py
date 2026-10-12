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

import yaml

from ergates import hermes_adapter, reminders, settings
from pinned import PinnedSource
from plugin_tree import PLUGIN_DIR

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
MODEL_SWITCH = "tui_gateway/model_switch.py"
PROMPT_TURN = "tui_gateway/prompt_turn.py"
PROMPT_SCAN = "tools/cronjob_prompt_scan.py"
SECRET_SCOPE = "agent/secret_scope.py"
PLUGINS_SETTINGS = "hermes_cli/plugins_settings.py"
PLUGINS_MANIFEST = "hermes_cli/plugins_manifest.py"
PLUGINS_CMD = "hermes_cli/plugins_cmd.py"
PLUGINS_CMD_GIT = "hermes_cli/plugins_cmd_git.py"
PLUGINS_CMD_INSTALL = "hermes_cli/plugins_cmd_install.py"
PLUGINS_CMD_CATALOG = "hermes_cli/plugins_cmd_catalog.py"


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
    """``profile_exists`` delegates to this, so the adapter follows Hermes's own idea of a live
    profile. Since v0.21.6 a named profile folder is live only with an identity marker in it
    (``config.yaml``, ``.env``, ``SOUL.md``, ``profile.yaml``, ``auth.json`` or ``state.db``):
    an empty folder under ``profiles/`` no longer exists for Hermes."""
    assert _arguments(hermes.function(PROFILES, "profile_exists")) == ["name"]
    assert _arguments(hermes.function(PROFILES, "get_profile_dir")) == ["name"]
    # hermes_cli/profiles.py:441-450: `default` always exists; a named profile is a live folder.
    assert hermes.lines(PROFILES, 441, 450) == (
        "def profile_exists(name: str) -> bool:\n"
        '    """Check whether a live (non-tombstoned) profile directory exists."""\n'
        "    try:\n"
        "        canon = normalize_profile_name(name)\n"
        "        profile_dir = get_profile_dir(canon)\n"
        "    except ValueError:\n"
        "        return False\n"
        '    if canon == "default":\n'
        "        return True\n"
        "    return named_profile_is_live(profile_dir)"
    )
    # hermes_constants.py:352-357 and 318: live = a folder with an identity marker, not deleted.
    assert hermes.lines(CONSTANTS, 357, 357) == (
        "    return home.is_dir() and named_profile_has_identity(home) and not named_profile_is_deleted(home)"
    )
    assert hermes.assigned(CONSTANTS, "_PROFILE_IDENTITY_MARKERS") == (
        "config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"
    )


def test_a_profile_scope_is_the_context_local_home_override(hermes: PinnedSource) -> None:
    """The adapter binds the home part of the cron.manage RPC's profile scope: the profile
    folder from ``get_profile_dir`` (refused when it is not a folder) as the context-local home
    override. Since v0.21.6 the RPC also binds that profile's secret scope and terminal policy
    (``_session_profile_runtime_scope``); the adapter does not, because no setting it reads or
    writes is a secret and it runs no command (see the ``hermes_adapter`` module docstring)."""
    assert _arguments(hermes.function(CONSTANTS, "set_hermes_home_override")) == ["path"]
    assert _arguments(hermes.function(CONSTANTS, "reset_hermes_home_override")) == ["token"]
    # tui_gateway/methods_tools.py:55-61: the cron.manage RPC's own profile scope.
    assert hermes.lines(RPC, 55, 61) == (
        '                profile = _str_arg(params, "profile")\n'
        "                try:\n"
        "                    try:\n"
        "                        home = _profile_home(profile)\n"
        "                    except ProfileUnavailableError:\n"
        "                        return _err(rid, 4064, f\"profile '{profile}' not found\")\n"
        '                    scope = _session_profile_runtime_scope({"profile_home": str(home) if home else None})'
    )
    # tui_gateway/server.py:580-584: the folder comes from get_profile_dir and must be a folder.
    assert hermes.lines(TUI_SERVER, 580, 584) == (
        "    try:\n"
        "        home = Path(profiles_mod.get_profile_dir(name))\n"
        "    except ValueError:\n"
        "        home = None\n"
        "    if home is None or not home.is_dir():"
    )
    # tui_gateway/model_switch.py:78-80: the scope's home part is the context-local override.
    assert hermes.lines(MODEL_SWITCH, 78, 80) == (
        "            secrets = build_profile_secret_scope(home)\n"
        "            overlay = None\n"
        "            scopes.home = set_hermes_home_override(str(home))"
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
TOOLSET_VALIDATION = "hermes_cli/toolset_validation.py"
CRON_SCHEDULER = "cron/scheduler.py"
BOT_MODE_PROBE = "tools/bot_mode_probe.py"


def test_the_toolset_pin_is_what_profiles_configure_writes(hermes: PinnedSource) -> None:
    """Since v0.21.6 the pin is ``platform_toolsets.cli``; before, it was ``tools.enabled_toolsets``."""
    # tui_gateway/methods_profiles.py:673-683: `enabled_toolsets` replaces platform_toolsets.cli;
    # an empty list removes the pin.
    assert hermes.lines(PROFILES_RPC, 673, 683) == (
        "def _save_toolset_pin(cfg, enabled, save_config) -> None:\n"
        '    """Pin ``platform_toolsets.cli``: the key ``_load_enabled_toolsets`` reads and ``hermes tools`` writes.\n'
        '    An empty selection clears the pin so the platform default applies again."""\n'
        "    from hermes_cli.tools_config import _save_platform_tools\n"
        "\n"
        "    wanted = _clean_names(enabled)\n"
        "    if wanted:\n"
        '        _save_platform_tools(cfg, "cli", wanted)\n'
        '    elif isinstance(cfg.get("platform_toolsets"), dict):\n'
        '        cfg["platform_toolsets"].pop("cli", None)\n'
        "    save_config(cfg)"
    )
    # hermes_cli/tools_config.py:745: the list stored (plus MCP server names it already held).
    assert hermes.lines(TOOLS_CONFIG, 745, 745) == (
        '    config["platform_toolsets"][platform] = sorted(enabled_toolset_keys | preserved_entries)'
    )
    # tui_gateway/methods_profiles.py:571: profiles.describe reads the same key as the profile's toolsets.
    assert hermes.lines(PROFILES_RPC, 571, 571) == (
        '    pinned = _coerce_platform_toolsets_value((cfg.get("platform_toolsets") or {}).get("cli"), "cli")'
    )
    # hermes_cli/tools_config.py:552: every reader parses the value with the parser the grant uses.
    assert hermes.lines(TOOLS_CONFIG, 552, 552) == "    parsed = parse_platform_toolsets_value(value)"
    assert _arguments(hermes.function(TOOLSET_VALIDATION, "parse_platform_toolsets_value")) == ["value"]
    # tools/bot_mode_probe.py:388: nothing writes the previous pin any more.
    assert hermes.lines(BOT_MODE_PROBE, 388, 388) == (
        "        # tools.enabled_toolsets is written by no surface, so watching it left Bot Chats"
    )


def test_hermes_builds_app_sessions_from_the_pin_and_other_platforms_from_their_own_list(hermes: PinnedSource) -> None:
    """Hermes now applies the pin itself, to app sessions when it builds them (the gate's
    grant is redundant there). The gate still enforces it on gateway turns and cron runs,
    which Hermes builds from their own platform's list, and at the next call of a running
    session: ``profiles.configure`` rebuilds none, and only a Bot Chat session is rebuilt,
    at the start of its next turn, when its capability fingerprint changed."""
    # tui_gateway/server.py:2087 (in _load_enabled_toolsets, which _build_agent calls at 2695).
    assert hermes.lines(TUI_SERVER, 2087, 2087) == '        enabled = _get_platform_tools(cfg, "cli", include_default_mcp_servers=True)'
    assert hermes.lines(TUI_SERVER, 2695, 2695) == "        enabled_toolsets=_load_enabled_toolsets(platform),"
    # gateway/run_turn.py:2403 (gateway turns) and cron/scheduler.py:482 (cron runs).
    assert hermes.lines(GATEWAY_TURN, 2403, 2403) == "        return sorted(_get_platform_tools(user_config, platform_key))"
    assert hermes.lines(CRON_SCHEDULER, 482, 482) == '        return sorted(_get_platform_tools(cfg or {}, "cron"))'
    # hermes_cli/tools_config.py:579-580: that function reads the platform's own list.
    assert hermes.lines(TOOLS_CONFIG, 579, 580) == (
        '    platform_toolsets = config.get("platform_toolsets") or {}\n'
        "    toolset_names = _coerce_platform_toolsets_value(platform_toolsets.get(platform), platform)"
    )
    # profiles.configure rebuilds no running session.
    assert "_refresh_live_sessions" not in hermes.text(PROFILES_RPC)
    # tui_gateway/prompt_turn.py:690 and model_switch.py:412, 425-426: at turn start Hermes
    # rebuilds a session's agent only when it is a Bot Chat whose capabilities changed.
    assert hermes.lines(PROMPT_TURN, 690, 690) == (
        "    _sync_bot_capabilities(sid, session)  # Bot Chat: adopt Settings->Capabilities edits"
    )
    assert hermes.lines(MODEL_SWITCH, 412, 412) == "def _sync_bot_capabilities(sid: str, session: dict) -> None:"
    assert hermes.lines(MODEL_SWITCH, 425, 426) == '        if title != "Bot Chat":\n            return'


def test_the_app_grant_is_hermes_s_own_resolution_of_the_cli_list(hermes: PinnedSource) -> None:
    """granted_toolsets calls this for ``platform_toolsets.cli``, the call an app session is built
    with (tui_gateway/server.py:2087): it expands the legacy alias ``hermes`` and adds the toolsets
    Hermes turns on beyond the list. The client-surface toolsets tui_gateway adds to a session after
    this call (``project``, and ``desktop_ui`` and ``catalog`` on Desktop: ``_with_session_toolsets``,
    server.py:1980-2000, 2091) are not in it, so the gate refuses their tools unless the pin lists them."""
    function = hermes.function(TOOLS_CONFIG, "_get_platform_tools")
    assert [a.arg for a in function.args.args] == ["config", "platform"]
    assert [a.arg for a in function.args.kwonlyargs] == ["include_default_mcp_servers"]
    assert [ast.unparse(d) for d in function.args.kw_defaults] == ["True"]
    # hermes_cli/tools_config.py:585-587: an explicitly saved list (even []) is used as saved.
    assert hermes.lines(TOOLS_CONFIG, 585, 587) == (
        "    explicitly_configured = isinstance(toolset_names, list)\n"
        "    if not explicitly_configured:\n"
        "        toolset_names = [_platform_default_toolset(platform)]"
    )
    # hermes_cli/tools_config.py:598-600: the legacy alias.
    assert hermes.lines(TOOLS_CONFIG, 598, 600) == (
        "    _LEGACY_TOOLSET_ALIASES: dict = {\n"
        '        "hermes": ("hermes-cli", "hermes-api-server"),\n'
        "    }"
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
    # cron/lifecycle_guard.py:65: "Remind me to kill time before the Hermes gateway meeting" matches.
    assert hermes.lines(LIFECYCLE_GUARD, 65, 65) == (
        '    r"|(?:\\b(?:p?kill|taskkill|stop-process)\\b[^\\n]*\\bhermes\\b[^\\n]*\\bgateway)"'
    )
    # cron/lifecycle_guard.py:372-376: `hermes -p <name> gateway restart` is refused only for the
    # profile the guard runs as ...
    assert hermes.lines(LIFECYCLE_GUARD, 372, 376) == (
        "def _current_profile_name() -> Optional[str]:\n"
        '    """Profile running the guard (``hermes_cli.profiles.current_profile_name``); ``None`` if none."""\n'
        "    from hermes_cli.profiles import current_profile_name\n"
        "\n"
        "    return current_profile_name()"
    )
    # ... which, under a context-local home override (the adapter's profile scope), is the name
    # of the active Hermes home: the HERMES_PROFILE_NAME / HERMES_PROFILE env pins count only
    # without an override (hermes_cli/profiles.py:2124-2131).
    assert hermes.lines(PROFILES, 2124, 2131) == (
        "    from hermes_constants import get_hermes_home_override\n"
        "    if get_hermes_home_override() is None:\n"
        '        for env_name in ("HERMES_PROFILE_NAME", "HERMES_PROFILE"):\n'
        '            value = (os.environ.get(env_name) or "").strip()\n'
        "            if value:\n"
        "                return value\n"
        "    try:\n"
        "        return get_active_profile_name() or default"
    )


def test_the_profile_listing_names_default_and_every_profile_folder(hermes: PinnedSource) -> None:
    """profile_names() keeps only the live ones. Since v0.21.6 this listing already does: it
    skips deleted profiles and folders without an identity marker. The adapter's own
    ``profile_exists`` filter is kept as a safeguard (redundant at this pin)."""
    assert _arguments(hermes.function(PROFILES, "list_profile_names")) == []
    # hermes_cli/profiles.py:494-497
    assert hermes.lines(PROFILES, 494, 497) == (
        '    names = ["default"]\n'
        "    with contextlib.suppress(OSError):\n"
        "        names.extend(entry.name for entry in _iter_named_profile_dirs())\n"
        "    return names"
    )
    # hermes_cli/profiles.py:469 and 484-485: the default `live_only=True` skips tombstoned
    # profiles, and only folders with an identity marker are listed at all.
    assert hermes.lines(PROFILES, 469, 469) == "def _iter_named_profile_dirs(*, live_only: bool = True) -> List[Path]:"
    assert hermes.lines(PROFILES, 484, 485) == (
        "        and named_profile_has_identity(entry)\n"
        "        and not (live_only and named_profile_is_deleted(entry))"
    )


def test_the_secret_scope_functions_the_plugin_calls(hermes: PinnedSource) -> None:
    """``install_secret`` binds the Hermes root's secret scope for one read, the way Hermes binds a
    profile's scope for a turn: ``build_profile_secret_scope(<root>)``, then
    ``set_secret_scope(mapping, profile_home=<root>)``, ``get_secret(name)`` and
    ``reset_secret_scope(token)``."""
    for name, line, arguments in (
        ("set_secret_scope", 143, ["secrets", "profile_home"]),
        ("reset_secret_scope", 154, ["token"]),
        ("get_secret", 219, ["name", "default"]),
        ("build_profile_secret_scope", 391, ["hermes_home"]),
    ):
        function = hermes.function(SECRET_SCOPE, name)
        assert function.lineno == line, name
        assert _arguments(function) == arguments, name
    assert [a.arg for a in hermes.function(SECRET_SCOPE, "set_secret_scope").args.kwonlyargs] == ["profile_home"]
    # agent/secret_scope.py:395: the scope is the home's .env (plus its external and managed sources).
    assert hermes.lines(SECRET_SCOPE, 395, 395) == '    secrets = load_env_file(Path(hermes_home) / ".env")'
    # agent/secret_scope.py:231-236: the bound scope answers first. A miss returns the default
    # when the task serves a routed profile, and only falls through to os.environ otherwise ...
    assert hermes.lines(SECRET_SCOPE, 231, 236) == (
        "    bound = _SECRET_SCOPE.get()\n"
        "    if bound is not None:\n"
        "        val = bound.mapping.get(name)\n"
        "        if val is not None:\n"
        "            return val\n"
        "        return default if serves_routed_profile() else _environ_or(name, default)"
    )
    # ... and every task under multiplexing serves a routed profile (agent/secret_scope.py:101-102).
    assert hermes.lines(SECRET_SCOPE, 101, 102) == "    if is_multiplex_active():\n        return True"


def test_a_secret_field_with_env_is_stored_under_that_name(hermes: PinnedSource) -> None:
    """``plugin.yaml`` declares ``ntfy.token`` as ``type: secret`` with ``env: ERGATES_NTFY_TOKEN``.
    Hermes keeps a secret field's value in the active profile's ``.env`` under that name, never
    in ``config.yaml``, and its settings form writes it there."""
    # hermes_cli/plugins_settings.py:58-64
    assert hermes.lines(PLUGINS_SETTINGS, 58, 64) == (
        "def secret_env_name(plugin_id: str, key: str, spec: Mapping[str, Any]) -> str:\n"
        '    """``.env`` variable a ``type: secret`` field is stored under: the manifest\'s ``env:`` or\n'
        "    ``<PLUGIN_ID>_<KEY>`` upper-snaked (``image_gen/fal`` + ``api_key`` \u2192 ``IMAGE_GEN_FAL_API_KEY``).\"\"\"\n"
        '    declared = str(spec.get("env") or "").strip()\n'
        "    if declared:\n"
        "        return declared\n"
        '    return _ENV_NAME_CLEAN_RE.sub("_", f"{plugin_id}_{key}".upper()).strip("_")'
    )
    # hermes_cli/plugins_settings.py:7-9
    assert hermes.lines(PLUGINS_SETTINGS, 7, 9) == (
        "setting lives. Secrets are declared with ``type: secret`` and never touch ``config.yaml``: the\n"
        "field carries the ``.env`` name (``env:`` or ``<PLUGIN>_<KEY>``) plus a presence flag, and the\n"
        "client writes the value through the existing ``PUT /api/env`` credential route."
    )
    assert hermes.assigned(PLUGINS_SETTINGS, "_FIELD_TYPES")["secret"] == "secret"
    # hermes_cli/plugins_manifest.py:50: the loader and `hermes plugins validate` know the type.
    assert hermes.lines(PLUGINS_MANIFEST, 50, 50) == '    "secret": (str,),'

    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    token = manifest["config_schema"]["ntfy.token"]
    assert token["type"] == "secret"
    assert token["env"] == settings.TOKEN_ENV == "ERGATES_NTFY_TOKEN"


def test_a_scope_stamped_with_another_home_than_the_launch_home_never_reads_the_process_environment(
        hermes: PinnedSource) -> None:
    """Why ``install_secret`` stamps the root's scope with the root: in a process launched for a
    named profile (``HERMES_HOME=<root>/profiles/<name>``, whose ``.env`` Hermes loaded into
    ``os.environ``), a scope stamped with another home than the launch home counts as a routed
    profile, so a miss in the root's ``.env`` returns the default instead of the process
    environment, also without multiplexing."""
    # agent/secret_scope.py:104-107
    assert hermes.lines(SECRET_SCOPE, 104, 107) == (
        "    own = hermes_home_key(get_routing_process_hermes_home())\n"
        "    bound = _SECRET_SCOPE.get()\n"
        "    if bound is not None and bound.profile_home and hermes_home_key(bound.profile_home) != own:\n"
        "        return True"
    )
    # hermes_constants.py:199-202 and 168-169: the launch home is the host's pin, else the
    # process's own HERMES_HOME (never the context-local override).
    assert hermes.lines(CONSTANTS, 199, 202) == (
        "def get_routing_process_hermes_home() -> Path:\n"
        '    """Launch home for routed-profile decisions: the pinned home, else :func:`get_process_hermes_home`."""\n'
        "    pinned = _PINNED_PROCESS_HERMES_HOME\n"
        "    return _expand_hermes_home(pinned) if pinned else get_process_hermes_home()"
    )
    assert hermes.lines(CONSTANTS, 168, 169) == (
        '    val = os.environ.get("HERMES_HOME", "").strip()\n'
        "    return _expand_hermes_home(val) if val else _get_platform_default_hermes_home()"
    )


def test_hermes_records_a_git_installs_source_and_revision(hermes: PinnedSource) -> None:
    """``install_record`` reads the record Hermes keeps of an install, which ``GET /health`` turns into the
    install kind: a record with a 40-hex ``revision`` and a real plugin folder is a git install, and a
    ``catalog`` block names the catalog entry. Hermes keeps the records of a home in
    ``<home>/plugins/.install-metadata.json``, keyed by the manifest's plugin name, and the facade
    ``hermes_cli.plugins_cmd`` re-exports the reader."""
    function = hermes.function(PLUGINS_CMD_GIT, "_read_install_metadata")
    assert _arguments(function) == []
    assert ast.unparse(function.returns) == "dict[str, dict[str, object]]"
    # hermes_cli/plugins_cmd_git.py:33-34: the home is the context-local one, which the adapter binds.
    assert hermes.lines(PLUGINS_CMD_GIT, 33, 34) == (
        "def _install_metadata_path() -> Path:\n"
        '    return get_hermes_home() / "plugins" / ".install-metadata.json"'
    )
    # hermes_cli/plugins_cmd.py:34: the facade the adapter imports the reader from.
    assert "_read_install_metadata" in hermes.lines(PLUGINS_CMD, 34, 34)
    exported = next(
        node for node in hermes.tree(PLUGINS_CMD).body
        if isinstance(node, ast.ImportFrom) and node.module == "hermes_cli.plugins_cmd_git"
    )
    assert "_read_install_metadata" in [alias.name for alias in exported.names]
    # hermes_cli/plugins_cmd_install.py:386-387 and 460: the key is the manifest's name, ``ergates`` here.
    assert hermes.lines(PLUGINS_CMD_INSTALL, 386, 387) == (
        '        plugin_name = manifest.get("name") or (\n'
        "            subdir.rstrip(\"/\").rsplit(\"/\", 1)[-1] if subdir else _pc()._repo_name_from_url(git_url))"
    )
    assert hermes.lines(PLUGINS_CMD_INSTALL, 460, 460) == "        new_metadata = {**old_metadata, plugin_name: record}"
    assert yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))["name"] == hermes_adapter.PLUGIN_NAME
    # hermes_cli/plugins_cmd_install.py:433-437: the record of a git install.
    assert hermes.lines(PLUGINS_CMD_INSTALL, 433, 437) == (
        "        record: dict[str, object] = {\n"
        '            "pinned": requested_revision is not None,\n'
        '            "revision": installed_revision,\n'
        '            "source": source,\n'
        "        }"
    )
    # hermes_cli/plugins_cmd_install.py:451-455: a catalog install adds the catalog block.
    assert hermes.lines(PLUGINS_CMD_INSTALL, 451, 455) == (
        '            record["catalog"] = {\n'
        "                **catalog,\n"
        '                "sha": installed_revision,\n'
        '                "pin": reviewed_pin if at_reviewed_pin else "",\n'
        "            }"
    )
    # hermes_cli/plugins_cmd_catalog.py:252: the catalog block starts with the entry's name.
    assert hermes.lines(PLUGINS_CMD_CATALOG, 252, 252) == (
        '        catalog={"name": entry.name, "repo": entry.repo, "tier": entry.tier, "pin": entry.sha})'
    )
    # hermes_cli/plugins_cmd_install.py:379 and hermes_cli/plugins_cmd_git.py:131-135 and 257: the
    # revision is the clone's HEAD, 40 lowercase hex.
    assert hermes.lines(PLUGINS_CMD_INSTALL, 379, 379) == (
        "        installed_revision = _pc()._clone_plugin_repo(tmp_clone, git_url, requested_revision, subdir)"
    )
    assert hermes.lines(PLUGINS_CMD_GIT, 131, 135) == (
        "def _git_head_revision(repo: Path, git_exe: str) -> str:\n"
        "    return _git_or_raise(\n"
        '        git_exe, repo, "rev-parse", "HEAD", timeout=15,\n'
        '        failure_prefix="Could not determine installed Git revision:\\n",\n'
        "    ).stdout.strip().lower()"
    )
    assert hermes.lines(PLUGINS_CMD_GIT, 257, 257) == "    return _pc()._git_head_revision(tmp_clone, git_exe)"
