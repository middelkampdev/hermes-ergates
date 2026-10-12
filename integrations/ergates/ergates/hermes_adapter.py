"""The one module of the ergates package that imports Hermes.

Every other module reaches Hermes through the functions here, so a Hermes
upgrade has one file to check in this package (plus ``dashboard/api.py``).
``integrations/ergates-tests/tests/test_hermes_boundary.py`` fails the build
when any other module imports Hermes.
``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins each
Hermes fact used here in the pinned source, and
``integrations/ergates-tests/contract/live/`` runs these functions against
the pinned Hermes itself.

Imports happen inside each function, so importing this module never needs
Hermes: the test suite and ``python -m ergates.flush`` run without it.

Every call about one profile binds the home part of the scope Hermes's own
``cron.manage`` RPC binds for a ``profile`` parameter
(``tui_gateway/methods_tools.py`` at the pin): ``get_profile_dir(profile)``,
refused unless it is a folder, becomes the context-local Hermes home
(``set_hermes_home_override``) for the call and is reset afterwards. Config,
cron and plugin discovery all resolve ``get_hermes_home()`` at call time, so
they act on that profile, and no other thread sees the override.

Since v0.21.6 the RPC also binds the profile's secret scope and terminal
policy (``_session_profile_runtime_scope`` in ``tui_gateway/model_switch.py``).
These per-profile calls do not: no setting they read or write is a secret,
and none runs a command. A ``${VAR}`` reference in the profile's
``config.yaml`` expands against whatever secret scope the caller already
holds (the request's in a dashboard route, the turn's in a hook), and
``save_config`` writes the reference back, not the value. The one secret
this module reads, :func:`install_secret`, comes from the Hermes root's own
secret scope, bound for that read only.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from contextlib import contextmanager
from datetime import tzinfo
from pathlib import Path
from typing import Any, Callable, Iterator

from .reminders import CronUnavailable

logger = logging.getLogger(__name__)

PLUGIN_NAME = "ergates"

# Hermes profile ids at the pin (hermes_cli/profiles.py `_PROFILE_ID_RE`). A
# name that fails it never reaches Hermes: `get_profile_dir("../x")` would
# build a path outside the profiles folder.
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def default_hermes_root() -> Path | None:
    """``hermes_constants.get_default_hermes_root()``, or ``None`` outside a Hermes runtime.

    Hermes maps a profile home (``<root>/profiles/<name>``) back to the root
    that every profile shares.
    ``integrations/ergates-tests/contract/test_hermes_root.py`` pins that rule
    and ``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins
    the call.
    """
    try:
        from hermes_constants import get_default_hermes_root
    except ImportError:
        return None
    return Path(get_default_hermes_root())


def install_secret(name: str) -> str | None:
    """The secret ``name`` of the whole install, from the Hermes root's ``.env``; ``None`` when unset or blank.

    Hermes keeps a plugin's ``type: secret`` setting in ``.env`` under the
    name its ``config_schema`` gives (``hermes_cli/plugins_settings.py``),
    and a plugin reads it with ``agent.secret_scope.get_secret``, which
    answers from the secret scope bound to the current task: a hook runs in
    its turn's profile scope, a dashboard route in the request's. The
    Ergates push settings are one feed for the whole install, so their
    secret lives in the root's ``.env`` only. This binds the root's own
    scope (``build_profile_secret_scope(<root>)``, stamped with the root as
    its home) for this one read and puts the caller's scope back
    afterwards, the way Hermes binds a profile's scope for a turn.

    A miss is ``None`` under multiplexing and in a process launched for a
    named profile: Hermes then never reads the process environment. Only a
    process launched for the root, without multiplexing, falls back to its
    own environment, as Hermes does for every credential there. The stamp
    is what covers the named-profile process, whose environment holds that
    profile's ``.env``: Hermes counts a scope stamped with another home
    than the process's launch home as a routed profile
    (``agent/secret_scope.py`` ``serves_routed_profile``).
    ``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins the
    calls and that rule, and ``contract/live/test_adapter.py`` runs the
    multiplexed and the named-profile cases. ``None`` outside a Hermes
    runtime. The value is never logged.
    """
    try:
        from agent.secret_scope import build_profile_secret_scope, get_secret, reset_secret_scope, set_secret_scope
    except ImportError:
        return None
    root = default_hermes_root()
    if root is None:
        return None
    token = set_secret_scope(build_profile_secret_scope(root), profile_home=str(root))
    try:
        value = get_secret(name)
    finally:
        reset_secret_scope(token)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def install_record() -> dict | None:
    """Hermes's install record of this plugin, or ``None``.

    Hermes keeps one record per installed plugin, keyed by the plugin's
    name, in ``<home>/plugins/.install-metadata.json`` of the home that
    installed it (``hermes_cli.plugins_cmd._read_install_metadata``). A
    git install, the dashboard's install route and the catalog all write
    it: ``revision`` (the commit), ``source``, ``pinned`` and, for a catalog
    install, ``catalog``. This install lives in the Hermes root, whose home
    is the default profile's, so the record is read in that home.

    ``None`` outside a Hermes runtime, when there is no record (a plugin
    copied or mounted by hand), and when Hermes raises (an unreadable file):
    the log then names the exception class only, because its message
    carries a path. ``GET /health`` asks at every call, so a failure is
    logged once, until a read fails with another class or succeeds.
    ``integrations/ergates-tests/contract/test_hermes_adapter.py``
    pins the record's shape and where Hermes keeps it.
    """
    global _install_record_error
    try:
        from hermes_cli.plugins_cmd import _read_install_metadata
    except ImportError:
        return None
    try:
        with _profile_home("default"):
            record = _read_install_metadata().get(PLUGIN_NAME)
    except Exception as exc:  # health must answer whatever Hermes does here
        error = type(exc).__name__
        with _install_record_lock:
            if error != _install_record_error:
                logger.warning("ergates: Hermes's install record of the plugin could not be read (%s)", error)
            _install_record_error = error
        return None
    with _install_record_lock:
        _install_record_error = None
    return record if isinstance(record, dict) else None


# The error class of the last install_record call that failed, or None after a read that succeeded.
_install_record_error: str | None = None
_install_record_lock = threading.Lock()


def root_plugin_dir() -> Path | None:
    """``<hermes root>/plugins/ergates``: where this install keeps its copy of the plugin.

    The path alone, whether or not a folder is there; ``None`` outside a
    Hermes runtime.
    """
    root = default_hermes_root()
    return None if root is None else root / "plugins" / PLUGIN_NAME


def configured_timezone() -> tzinfo | None:
    """``hermes_time.get_timezone()``: the zone Hermes cron runs routines in.

    That is ``HERMES_TIMEZONE``, else ``timezone`` in the active profile's
    ``config.yaml``. ``None`` when neither is set (Hermes then uses server
    local time) and outside a Hermes runtime.
    ``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins the
    call and that cron evaluates its schedules in this zone.
    """
    try:
        from hermes_time import get_timezone

        # Imports agent.secret_scope on its first call.
        return get_timezone()
    except ImportError:
        return None


def current_profile(ctx: object) -> str:
    """The profile a hook or tool call runs in: ``ctx.profile_name``, read at this call.

    Hermes derives ``PluginContext.profile_name`` from the
    active Hermes home every time it is read, and a multiplexed gateway
    switches that home per session with a context-local override. A name
    read once in ``register()`` would pin every later call to the profile
    that loaded the plugin. Raises when ``ctx`` has no usable name.

    ``profile_name`` answers ``"default"`` for the default profile, and also
    when its own lookup, ``hermes_cli.profiles.get_active_profile_name()``,
    raises (``integrations/ergates-tests/contract/test_hermes_adapter.py``
    pins both). The default profile is always admitted, so the fallback would
    let a profile that is still being set up run every tool. A ``"default"``
    therefore stands only when that lookup, asked again here, names the
    default profile; otherwise this raises and the tool gate blocks.
    """
    name = getattr(ctx, "profile_name")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("the plugin context has no profile name")
    name = name.strip()
    if name == "default" and not _hermes_names_the_default_profile():
        raise ValueError("Hermes could not tell the active profile")
    return name


def _hermes_names_the_default_profile() -> bool:
    """True when Hermes's own profile lookup names the default profile now.

    False when it names another profile, raises, or Hermes is not importable
    (the lookup cannot be asked, so the answer is unknown).
    """
    try:
        from hermes_cli.profiles import get_active_profile_name

        return get_active_profile_name() == "default"
    except Exception:
        return False


def profile_exists(profile: str) -> bool:
    """True when ``profile`` is a live profile of this Hermes install (``default`` always is)."""
    if not _is_profile_name(profile):
        return False
    from hermes_cli.profiles import profile_exists as hermes_profile_exists

    return bool(hermes_profile_exists(profile))


def profile_names() -> list[str]:
    """``default`` and every live named profile of this Hermes install, in Hermes's order.

    Hermes's ``list_profile_names`` also lists a deleted profile whose
    folder is still there; :func:`profile_exists` leaves those out.
    """
    from hermes_cli.profiles import list_profile_names

    return [name for name in list_profile_names() if profile_exists(name)]


def check_schedule(profile: str, schedule: str) -> None:
    """Raise ``ValueError`` unless Hermes cron would accept ``schedule`` for ``profile`` now.

    The same checks ``cron.jobs.create_job`` makes before it stores a job:
    ``parse_schedule`` understands the text, and ``compute_next_run`` finds a
    next run -- for every schedule kind, not only a one-shot. A cron
    expression naming a calendar date that never occurs (Feb 30, Apr 31)
    raises inside croniter there, which is already a ``ValueError``
    (``CroniterBadDateError``). A duration far enough out that the resulting
    time cannot be represented raises ``OverflowError`` instead -- while
    parsing an "in ..." one-shot, or while computing a recurring schedule's
    next run -- and is mapped to ``ValueError`` here so it is refused the
    same way. A one-shot with no next run (the time has already passed) is
    refused too. The ``POST /reminders`` route runs this first, so a
    schedule Hermes refuses is a 400, not an uncertain create.
    """
    from cron.jobs import compute_next_run, parse_schedule

    with _profile_home(profile):
        try:
            parsed = parse_schedule(schedule)
            next_run = compute_next_run(parsed)
        except OverflowError as exc:
            raise ValueError(f"schedule {schedule!r} is out of range") from exc
        if parsed.get("kind") == "once" and next_run is None:
            raise ValueError("the one-shot time is in the past")


def check_prompt(prompt: str) -> None:
    """Raise ``ValueError`` when Hermes cron's prompt scan would refuse ``prompt`` in a create.

    ``cronjob(action="create")``, which :class:`HermesCron` calls, runs the
    private ``tools.cronjob_prompt_scan._scan_cron_prompt`` on the prompt as
    given and answers an error instead of a job when it reports one
    (invisible Unicode, "do not tell the user" and other injection or
    exfiltration phrases). The scan needs no profile. It refuses the same
    prompt on every try, so ``POST /reminders`` and the reminder tool ask
    here first: a refused prompt is a 400, never an uncertain create the app
    would keep retrying. The error is fixed text, never Hermes's reason,
    which names what matched.
    ``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins the
    scan and its call in the create.
    """
    from tools.cronjob_prompt_scan import _scan_cron_prompt

    if _scan_cron_prompt(prompt):
        raise ValueError("Hermes cron's prompt scan refuses this prompt")


def check_gateway_lifecycle(profile: str, prompt: str) -> None:
    """Raise ``ValueError`` when Hermes cron's gateway lifecycle guard would refuse ``prompt`` in ``profile``.

    Before it stores a job, ``cron.jobs.create_job`` strips the prompt and
    runs ``cron.lifecycle_guard.check_gateway_lifecycle`` on it, which raises
    ``GatewayLifecycleBlocked`` (a ``ValueError``) for a prompt that reads as
    a command to restart or stop the Hermes gateway; ``cronjob(action="create")``
    then answers an error instead of a job. The guard matches plain prose too
    ("Remind me to kill time before the Hermes gateway meeting"), and it
    refuses ``hermes -p <name> gateway restart`` only in the profile it
    names, which it reads from the active Hermes home. So this runs the
    guard the way the create does: on the stripped prompt, inside the
    profile's home. The guard refuses the same prompt on every try, so
    ``POST /reminders`` and the reminder tool ask here right after
    :func:`check_prompt`: a refused prompt is a 400, never an uncertain
    create the app would keep retrying. The error is fixed text.
    ``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins the
    guard and its call in the create.
    """
    from cron.lifecycle_guard import check_gateway_lifecycle as run_hermes_guard

    refused = False
    with _profile_home(profile):
        try:
            run_hermes_guard(prompt.strip())
        except ValueError:
            refused = True
    # Raised outside the handler, so the error carries no trace of Hermes's own.
    if refused:
        raise ValueError("Hermes cron's gateway lifecycle guard refuses this prompt")


class HermesCron:
    """``reminders.CronPort`` on Hermes's own cron, scoped to one profile per call.

    ``create_job`` calls ``tools.cronjob_tools.cronjob(action="create")``,
    the function behind the ``cron.manage`` RPC the app's Routines screen
    uses, so Hermes's prompt scan and scheduler registration apply and the
    job lands in the profile's own ``cron/jobs.json``. The returned dicts
    carry the job id and name only, never the prompt.

    Time bound: the only wait inside a create is Hermes's cross-process jobs
    lock, which gives up after ``cron.jobs._JOBS_LOCK_TIMEOUT_SECONDS`` (30 s
    at the pin), and the built-in scheduler's ``register_job`` does nothing.
    A create therefore ends well inside ``reminders.IN_FLIGHT_SECONDS``
    (60 s), after which a second request may take over the claim.
    ``integrations/ergates-tests/contract/test_hermes_adapter.py`` pins both
    facts.

    Outside a Hermes runtime every call raises ``CronUnavailable``, the
    signal the reminder service already treats as "could not tell".
    """

    def create_job(self, profile: str, *, schedule: str, prompt: str, name: str) -> dict:
        try:
            from tools.cronjob_tools import cronjob
        except ImportError as exc:
            raise CronUnavailable("Hermes cron is not importable in this process") from exc
        with _profile_home(profile):
            raw = cronjob(action="create", name=name, schedule=schedule, prompt=prompt)
        return {"id": _created_job_id(raw), "name": name}

    def get_job(self, profile: str, job_id: str) -> dict | None:
        """The job's id, name and ``completed``; ``None`` when cron has no such job.

        ``completed`` is True for a job Hermes retired after its last run: a
        one-shot that ran stays in ``jobs.json`` with ``state: "completed"``
        for 7 days by default (both pinned by
        ``integrations/ergates-tests/contract/test_hermes_adapter.py``).
        """
        try:
            from cron.jobs import get_job
        except ImportError as exc:
            raise CronUnavailable("Hermes cron is not importable in this process") from exc
        with _profile_home(profile):
            job = get_job(job_id)
        if job is None:
            return None
        return {"id": str(job["id"]), "name": job.get("name"), "completed": job.get("state") == "completed"}

    def find_job_ids_by_name(self, profile: str, name: str) -> list[str]:
        """Ids of every job, paused ones included, whose name is exactly ``name``."""
        try:
            from cron.jobs import list_jobs
        except ImportError as exc:
            raise CronUnavailable("Hermes cron is not importable in this process") from exc
        with _profile_home(profile):
            jobs = list_jobs(include_disabled=True)
        return [str(job["id"]) for job in jobs if job.get("name") == name]


def enable_plugin(profile: str) -> None:
    """Make Hermes load this plugin in ``profile``.

    Hermes discovers user plugins in the ACTIVE home's ``plugins/`` folder and
    loads one only when that home's ``config.yaml`` lists it in
    ``plugins.enabled``. So: link ``<profile home>/plugins/ergates`` to the
    install's ``<root>/plugins/ergates``, then add ``ergates`` to the
    profile's ``plugins.enabled`` (and drop it from ``plugins.disabled``)
    with Hermes's own ``load_config``/``save_config`` under the profile's
    home, the way Hermes's dashboard writes another profile's config. The
    default profile's home is the root, so it gets no link. Safe to repeat.
    Takes effect on the profile's next session.
    """
    from hermes_cli.config import load_config, save_config

    source = _root_plugin_dir()
    with _profile_home(profile) as home:
        link = home / "plugins" / PLUGIN_NAME
        # The default profile's home is the root, where the plugin already is.
        if link.resolve() != source.resolve():
            _link_plugin(source, link)
        config = load_config()
        if _enable_in(config):
            save_config(config)


def plugin_enabled(profile: str) -> bool:
    """True when Hermes would load this install's plugin in ``profile``.

    Asks Hermes's own discovery, under the profile's home: the user-plugin
    scan finds a manifest named ``ergates`` whose folder is the install's
    plugin, and ``gate_manifest`` answers ``load`` for it with that
    profile's ``plugins.enabled`` and ``plugins.disabled``.
    """
    if not profile_exists(profile):
        return False
    from hermes_cli.config import load_config
    from hermes_cli.plugins_discovery import collect_directory_manifests, gate_manifest

    source = _root_plugin_dir().resolve()
    with _profile_home(profile):
        manifest = next(
            (m for m in collect_directory_manifests() if m.name == PLUGIN_NAME and m.source == "user"), None,
        )
        if manifest is None or manifest.path is None or Path(manifest.path).resolve() != source:
            return False
        enabled, disabled = _plugin_lists(load_config())
        return gate_manifest(manifest, disabled, enabled).action == "load"


def granted_toolsets(profile: str) -> frozenset[str] | None:
    """The toolsets ``profile``'s configuration grants now, or ``None`` when it pins none.

    The tool gate asks only for a profile Ergates provisioned
    (``ProposalService.provisioned``, ADR-034): a toolset list that
    ``hermes tools``, a setup or the Desktop editor wrote for any other
    profile narrows nothing.

    The grant is the toolset pin that ``profiles.configure`` writes, which is
    how the app configures a new agent from its template. Since v0.21.6 that
    is ``platform_toolsets.cli`` in the profile's ``config.yaml``, the list
    Hermes builds an app session's tools from. Hermes builds a gateway turn's
    and a cron run's tools from their own platform's list, and most running
    sessions keep the tools they were built with (only a Bot Chat session is
    rebuilt, at the start of its next turn, when its capability fingerprint
    changed: ``tui_gateway/model_switch.py`` ``_sync_bot_capabilities``). So
    the tool gate is what makes a template's toolsets binding on every
    platform and at the next call.
    Before v0.21.6 ``profiles.configure`` wrote ``tools.enabled_toolsets``,
    which no Hermes surface reads any more; a profile configured then still
    has that pin, so it counts while the profile has no
    ``platform_toolsets.cli``. Once it has one (the app configured it again
    on v0.21.6), the legacy key is ignored.

    For ``platform_toolsets.cli`` the granted names are what Hermes's own
    reader, ``hermes_cli.tools_config._get_platform_tools(config, "cli")``,
    resolves the list to, the call an app session is built with: it expands
    the legacy alias ``hermes``, keeps an explicit ``[]`` as zero toolsets and
    adds default-on plugin toolsets, ``context_engine`` and platform-native
    toolsets. The legacy pin is its names as listed. A granted name whose
    tools Hermes registers under other toolsets (``browser`` bundles
    ``browser-cdp``) grants those toolsets too.
    An MCP server's toolset is ``mcp-<server>``. On ``platform_toolsets.cli``
    the answer of ``_get_platform_tools`` also holds the MCP servers an app
    session gets: none when the list holds ``no_mcp``, only the listed ones
    when the list names at least one enabled server (an MCP allowlist), and
    every enabled server otherwise. Each server in it that
    ``enabled_mcp_server_names`` names adds its ``mcp-`` toolset. A name in
    the list that resolves to a server's tools grants that server's toolset
    too, as for any toolset: ``mcp-<server>`` itself, ``all``, or the server's
    name, which is an alias of its toolset once the server connects. On the
    legacy pin, which Hermes no longer reads, every server the config enables
    adds its toolset (``tools.mcp_tool_common.mcp_server_enabled``:
    ``enabled``, true unless set), and so does a listed name that resolves to
    a server's tools. The legacy ``disabled`` key, which ``profiles.configure``
    wrote before v0.21.6 and Hermes's MCP runtime never reads, counts
    differently on the two pins. On ``platform_toolsets.cli`` the ``mcp-``
    toolset of such a server is taken out of the finished grant, whichever way
    it got in; a built-in toolset of the same name stays. On the legacy pin it
    only keeps the server from adding its toolset, so a listed name that
    resolves to its tools still grants them.

    ``None`` means the profile pins no toolsets, so Hermes alone decides its
    tools and Ergates cannot tell a narrower grant; outside a Hermes runtime
    (``hermes_cli.config`` itself is not importable) it is ``None`` too. The
    config is read at every call, so a toolset taken out of the pin is
    blocked at the next tool call, without a new session.

    Only "Hermes is not here" is read as "no toolsets pinned". A Hermes
    present but missing one of the other symbols this reads (renamed or
    moved by an upgrade) raises instead of returning ``None``, so the tool
    gate blocks rather than silently granting every tool. A pin present but
    not a list (a hand-edited config) raises for the same reason; for
    ``platform_toolsets.cli`` that is a value Hermes's own parser
    (``hermes_cli.toolset_validation.parse_platform_toolsets_value``) cannot
    read as a list. Any other failure raises too, and the tool gate blocks
    the call.
    """
    try:
        from hermes_cli.config import load_config_readonly
    except ImportError:
        return None
    from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names
    from hermes_cli.toolset_validation import parse_platform_toolsets_value
    from model_tools import get_toolset_for_tool
    from tools.mcp_tool_common import mcp_server_enabled
    from toolsets import resolve_toolset
    from utils import is_truthy_value

    def toolsets_granted_by(pinned) -> set[str]:
        names = {str(name).strip() for name in pinned if str(name).strip()}
        owners = {owner for name in names for tool in resolve_toolset(name) if (owner := get_toolset_for_tool(tool))}
        return names | owners

    with _profile_home(profile):
        config = load_config_readonly() or {}
        pin = _toolset_pin(config, parse_platform_toolsets_value)
        if pin is None:
            return None
        key, pinned = pin
        servers = config.get("mcp_servers")
        servers = servers if isinstance(servers, dict) else {}
        legacy_off = {str(server) for server, entry in servers.items()
                      if isinstance(entry, dict) and is_truthy_value(entry.get("disabled", False))}
        if key == _APP_PIN:
            # Read-only: _get_platform_tools never writes to the config it is given.
            selected = set(_get_platform_tools(config, _APP_PLATFORM, include_default_mcp_servers=True))
            granted = toolsets_granted_by(selected)
            granted.update(f"mcp-{server}" for server in selected & enabled_mcp_server_names(config))
            # Last, so it holds however the toolset got in: the server's name, `mcp-<server>` or `all`.
            granted -= {f"mcp-{server}" for server in legacy_off}
        else:
            granted = toolsets_granted_by(pinned)
            granted.update(f"mcp-{server}" for server, entry in servers.items()
                           if isinstance(entry, dict) and mcp_server_enabled(entry) and str(server) not in legacy_off)
    return frozenset(granted)


def toolset_for_tool(tool_name: str) -> str | None:
    """The toolset Hermes registered ``tool_name`` under, or ``None`` for a tool it does not know.

    Asks Hermes's tool registry (``model_tools.get_toolset_for_tool``) in the
    active Hermes home, which Hermes sets to the calling profile's home for a
    hook call, so a plugin tool that only one profile loads is found there.
    ``None`` outside a Hermes runtime.
    """
    try:
        from model_tools import get_toolset_for_tool
    except ImportError:
        return None
    return get_toolset_for_tool(tool_name)


def _is_profile_name(profile: object) -> bool:
    return isinstance(profile, str) and bool(_PROFILE_RE.fullmatch(profile))


@contextmanager
def _profile_home(profile: str) -> Iterator[Path]:
    """Make ``profile``'s home the context-local Hermes home for the block."""
    if not _is_profile_name(profile):
        raise ValueError(f"{profile!r} is not a Hermes profile name")
    from hermes_cli.profiles import get_profile_dir
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home = Path(get_profile_dir(profile))
    if not home.is_dir():
        raise FileNotFoundError(f"profile {profile!r} does not exist")
    token = set_hermes_home_override(str(home))
    try:
        yield home
    finally:
        reset_hermes_home_override(token)


def _root_plugin_dir() -> Path:
    """:func:`root_plugin_dir`, which must hold the plugin: raises when Hermes is not here or the folder is empty."""
    source = root_plugin_dir()
    if source is None:
        raise RuntimeError("Hermes is not importable in this process")
    if not (source / "plugin.yaml").is_file():
        raise FileNotFoundError(f"the {PLUGIN_NAME} plugin is not installed at {source}")
    return source


def _link_plugin(source: Path, link: Path) -> None:
    """Create ``link`` -> ``source``; accept an existing link to it, refuse anything else."""
    if not link.is_symlink() and not link.exists():
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            link.symlink_to(source, target_is_directory=True)
        except FileExistsError:
            pass  # a concurrent call made it first; checked below
    if not (link.is_symlink() and link.resolve() == source.resolve()):
        raise FileExistsError(f"{link} exists and is not a link to {source}")


def _enable_in(config: dict[str, Any]) -> bool:
    """Put ``ergates`` in ``plugins.enabled`` and out of ``plugins.disabled``. True when ``config`` changed."""
    plugins = config.get("plugins")
    if not isinstance(plugins, dict):
        plugins = config["plugins"] = {}
    enabled = plugins.get("enabled")
    enabled = list(enabled) if isinstance(enabled, list) else []
    disabled = plugins.get("disabled")
    changed = False
    if PLUGIN_NAME not in enabled:
        plugins["enabled"] = [*enabled, PLUGIN_NAME]
        changed = True
    if isinstance(disabled, list) and PLUGIN_NAME in disabled:
        plugins["disabled"] = [name for name in disabled if name != PLUGIN_NAME]
        changed = True
    return changed


def _plugin_lists(config: dict[str, Any]) -> tuple[set[str] | None, set[str]]:
    """``(plugins.enabled, plugins.disabled)`` the way Hermes's discovery reads them (``None`` = unset)."""
    plugins = config.get("plugins")
    plugins = plugins if isinstance(plugins, dict) else {}
    enabled = plugins.get("enabled")
    disabled = plugins.get("disabled")
    return (
        set(enabled) if isinstance(enabled, list) else None,
        set(disabled) if isinstance(disabled, list) else set(),
    )


# The platform whose toolset list ``profiles.configure`` writes: the app's sessions.
_APP_PLATFORM = "cli"
_APP_PIN = f"platform_toolsets.{_APP_PLATFORM}"
_LEGACY_PIN = "tools.enabled_toolsets"


def _toolset_pin(
    config: dict[str, Any], parse_platform_list: Callable[[object], list | None],
) -> tuple[str, list] | None:
    """``(key, list)`` of the toolset pin in ``config``: ``platform_toolsets.cli`` when present,
    else the legacy ``tools.enabled_toolsets``; ``None`` when neither is set (or both are ``null``).

    ``parse_platform_list`` is Hermes's parser for a ``platform_toolsets``
    value. Raises ``ValueError`` for a pin, or a ``platform_toolsets`` section,
    that is not one Hermes would read as a list.
    """
    platforms = config.get("platform_toolsets")
    if platforms is not None and not isinstance(platforms, dict):
        raise ValueError("config platform_toolsets is not a mapping")
    raw = platforms.get(_APP_PLATFORM) if platforms else None
    if raw is not None:
        parsed = parse_platform_list(raw)
        if not isinstance(parsed, list):
            raise ValueError(f"config {_APP_PIN} is not a list")
        return _APP_PIN, parsed
    tools = config.get("tools")
    legacy = tools.get("enabled_toolsets") if isinstance(tools, dict) else None
    if legacy is None:
        return None
    if not isinstance(legacy, list):
        raise ValueError(f"config {_LEGACY_PIN} is not a list")
    return _LEGACY_PIN, legacy


def _created_job_id(raw: str) -> str:
    """The job id in ``cronjob(action="create")``'s JSON result.

    Raises when the result reports no created job. The error never carries
    Hermes's own message, which can quote the prompt.
    """
    result = json.loads(raw)
    job_id = result.get("job_id") if isinstance(result, dict) else None
    if not (isinstance(result, dict) and result.get("success") is True and isinstance(job_id, str) and job_id):
        raise RuntimeError("Hermes cron did not report a created job")
    return job_id
