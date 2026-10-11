"""Hermes plugin wiring: the Ergates tools, the attention hooks and the tool gate.

Registered by ``register(ctx)`` in the top-level ``__init__.py`` (the Hermes
plugin entry point). Kept separate from ``ctx`` so every function here stays
plain and unit-testable: each takes its dependencies (a service, a delivery
worker, config values) as explicit arguments rather than reaching into a
global ``ctx``.

Every handler writes to the one control store of the Hermes install,
``<hermes root>/ergates/control.sqlite3``, whichever profile it runs in. The
profile itself is read from Hermes at every call
(:func:`~ergates.hermes_adapter.current_profile`), never once at
registration: a multiplexed gateway serves several profiles from one
process.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sqlite3
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from . import hermes_adapter, policy
from .attention import AttentionService
from .delivery import DeliveryWorker, send_ntfy
from .operations import PROMPT_REFUSED, PROMPT_STOPS_GATEWAY, reminder_problem
from .paths import hermes_root, store_path
from .proposals import HERMES_RESERVED_PROFILE_NAMES, ProposalError, ProposalService, validate_proposal
from .reminders import ReminderError, ReminderService
from .settings import push_settings
from .store import ControlStore, StoreError

logger = logging.getLogger(__name__)

PROPOSE_TOOL_NAME = "ergates_propose_agent"

PROPOSE_SCHEMA: Dict[str, Any] = {
    "name": PROPOSE_TOOL_NAME,
    "description": (
        "Propose a new Ergates specialist agent for operator approval. Validates the "
        "request and returns a typed, time-limited proposal. Never creates a profile "
        "or changes any permission by itself -- provisioning happens only after the "
        "operator approves the proposal in the app."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": (
                    "Unique lowercase profile identifier, e.g. 'thijs'. "
                    "Must match ^[a-z0-9][a-z0-9-]{1,31}$ and must not be a name "
                    f"Hermes reserves: {', '.join(sorted(HERMES_RESERVED_PROFILE_NAMES))}."
                ),
            },
            "title": {
                "type": "string",
                "description": "Friendly display name shown to the user, e.g. 'Thijs'. Max 60 characters.",
            },
            "role": {
                "type": "string",
                "description": "Short role badge, e.g. 'Bookkeeper'. Max 40 characters.",
            },
            "description": {
                "type": "string",
                "description": "One-line summary of what this agent does.",
            },
            "template_id": {
                "type": "string",
                "description": "Identifier of the approved role template to provision from.",
            },
            "provider": {
                "type": "string",
                "description": "Operator-selected model provider for this agent.",
            },
            "model": {
                "type": "string",
                "description": "Operator-selected model for this agent.",
            },
            "briefing": {
                "type": "string",
                "description": (
                    "Role, boundaries, seed facts and reporting instructions. Max 4000 characters."
                ),
            },
        },
        "required": [
            "name", "title", "role", "template_id", "provider", "model", "briefing",
        ],
    },
}


def propose_handler(
    args: Dict[str, Any],
    *,
    service: ProposalService,
    session_id: Optional[str] = None,
    task_id: Optional[str] = None,
    **_kwargs: Any,
) -> str:
    """Validate a proposal, record its receipt as ``"proposed"``, and return it as JSON.

    Always returns a JSON string, per the Hermes tool contract: a validation
    failure, a proposal-id collision or a store failure comes back as
    ``{"error": "..."}`` rather than raising. A store failure names the
    exception class only. Never creates a profile.

    ``source_session_id`` is backend-owned: Hermes dispatches tool handlers
    as ``handler(args, task_id=..., session_id=...)`` (``tools/registry.py``'s
    ``dispatch`` via ``_execute_tool``'s ``dispatch_kwargs`` in the pinned
    checkout), never as a model-supplied argument. ``validate_proposal``
    never reads a ``source_session_id`` key out of ``args`` at all, and the
    line below always sets it from these handler kwargs -- so a caller that
    sneaks a ``source_session_id`` into ``args`` has it silently overwritten,
    never honored. ``session_id`` is preferred; ``task_id`` is the fallback
    for contexts (e.g. cron) that may carry a task id but no session id.

    The stored receipt is **not** the proposal. 11 section 4.1 defines it
    as "proposal hash, reserved profile name, completed steps, session id
    and briefing delivery state" -- so :meth:`ProposalService.record` keeps
    the sha256 of the proposal exactly as returned to the caller, which is
    what the accept operation verifies the approved payload against, and
    never the ``briefing`` (up to 4,000 characters of user content) or the
    ``description``. The full proposal still reaches the app through the
    tool result, which is a transport, not a retained store.
    """
    try:
        proposal = validate_proposal(args)
        proposal["source_session_id"] = session_id or task_id
        service.record(proposal)
    except ProposalError as exc:
        return json.dumps({"error": str(exc)})
    except (StoreError, sqlite3.Error) as exc:
        return _not_recorded("proposal", exc)
    return json.dumps(proposal)


def _not_recorded(what: str, exc: BaseException) -> str:
    """The tool result for a store failure: ``{"error": ...}`` naming the exception class only.

    Class name only, in the log and the result: a store error message can carry the file path.
    """
    logger.warning("ergates: the %s could not be recorded (%s)", what, type(exc).__name__)
    return json.dumps({"error": f"the {what} could not be recorded ({type(exc).__name__})"})


REMINDER_TOOL_NAME = "ergates_create_reminder"

REMINDER_SCHEMA: Dict[str, Any] = {
    "name": REMINDER_TOOL_NAME,
    "description": (
        "Create a reminder: a Hermes cron job in this agent's profile that runs the prompt on "
        "the schedule. Asking again with the same schedule, time zone and prompt returns the "
        "reminder that already exists instead of making a second one; a one-time reminder that "
        "already ran is made again. Use this, not cronjob_manage, to create reminders."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "schedule": {
                "type": "string",
                "description": (
                    "When it runs: cron syntax ('0 9 * * *'), 'every monday 9am', 'every 2h', "
                    "or once ('in 30m')."
                ),
            },
            "prompt": {
                "type": "string",
                "description": "The full, self-contained instruction the reminder runs.",
            },
            "timezone": {
                "type": "string",
                "description": (
                    "The user's IANA time zone, for example 'Europe/Amsterdam'; 'UTC' when unknown. "
                    "Advisory: Hermes runs every job in its own configured time zone."
                ),
            },
            "label": {
                "type": "string",
                "description": "Short name for the Routines list, at most 64 characters. Never the prompt itself.",
            },
        },
        "required": ["schedule", "prompt", "timezone"],
    },
}


def create_reminder_handler(
    args: Dict[str, Any],
    *,
    service: ReminderService,
    profile: str,
    check_schedule: Callable[[str, str], None],
    check_prompt: Callable[[str], None],
    check_gateway_lifecycle: Callable[[str, str], None],
    **_kwargs: Any,
) -> str:
    """Create or return the reminder of one request in ``profile``; always a JSON string.

    The same checks as ``POST /reminders`` run first, so a schedule or a
    prompt Hermes cron refuses is an error, never an uncertain create. There
    is no request id: the receipt id is the payload hash, so the same
    schedule, time zone and prompt in one profile is one reminder however
    often the model asks -- until a one-shot has run: then the same request
    makes a new one (``reminders._counts_as_gone``). A store failure is an
    error naming the exception class, as in :func:`propose_handler`; asking
    again after it never makes a second job.
    """
    if not isinstance(args, dict):
        return json.dumps({"error": "the arguments must be an object"})
    label = args.get("label")
    problem = reminder_problem(
        schedule=args.get("schedule"), timezone=args.get("timezone"), prompt=args.get("prompt"), label=label,
    )
    if problem is not None:
        return json.dumps({"error": problem})
    try:
        check_schedule(profile, args["schedule"])
    except (ValueError, OverflowError):
        # hermes_adapter.check_schedule maps OverflowError itself; POST /reminders catches both too.
        return json.dumps({"error": "schedule is not one Hermes cron accepts"})
    except OSError as exc:
        # The profile's home vanished (FileNotFoundError) or cannot be read. Class name
        # only: the message carries the path.
        logger.warning("ergates: the reminder schedule could not be checked (%s)", type(exc).__name__)
        return json.dumps({"error": "the schedule could not be checked"})
    try:
        check_prompt(args["prompt"])
    except ValueError:
        return json.dumps({"error": PROMPT_REFUSED})
    try:
        check_gateway_lifecycle(profile, args["prompt"])
    except ValueError:
        return json.dumps({"error": PROMPT_STOPS_GATEWAY})
    except OSError as exc:
        # The profile's home vanished since the schedule check. Class name only: the message carries the path.
        logger.warning("ergates: the reminder prompt could not be checked (%s)", type(exc).__name__)
        return json.dumps({"error": "the prompt could not be checked"})
    try:
        outcome = service.create(profile, args["schedule"], args["timezone"], args["prompt"], label=label)
    except ReminderError as exc:
        return json.dumps({"error": str(exc)})
    except (StoreError, sqlite3.Error) as exc:
        return _not_recorded("reminder", exc)
    return json.dumps({"status": outcome.status, "receipt": outcome.receipt})


# By default only routine (cron) turns push when they finish: `post_llm_call`
# fires for every finished turn, and a push per chat reply would be noise.
DEFAULT_COMPLETED_PLATFORMS = frozenset({"cron"})


def completed_platforms(value: Any) -> frozenset[str]:
    """The ``attention.completed_platforms`` setting as a set of platform names.

    Unset or malformed means routines only. An empty list turns completion
    pushes off.
    """
    if not isinstance(value, (list, tuple)):
        return DEFAULT_COMPLETED_PLATFORMS
    return frozenset(item.strip() for item in value if isinstance(item, str) and item.strip())


def _deliver_in_background(worker: DeliveryWorker, event_id: str) -> threading.Thread:
    """Send the push of ``event_id`` off the caller's thread. Never raises.

    ``pre_approval_request`` is deliberately **not** in
    ``_HOOK_TIMEOUT_BOUNDED_HOOKS`` (``hermes_cli/plugins_dispatch.py`` at
    the pin: "Hooks not listed below run synchronously to completion"), and
    on the gateway path it fires *before* ``notify_cb`` reaches the app
    (``tools/approval_gateway_wait.py``). So anything slow here delays the
    in-app approval card itself. The event and its outbox row are already
    committed when this starts; the network call runs on a short-lived daemon
    thread. A push this thread cannot finish stays due in the outbox, and
    the next ``python -m ergates.flush`` sends it.

    The thread runs in a copy of the caller's context. A multiplexed gateway
    routes each session to its profile with a context-local Hermes home, and
    the worker reads that profile's settings (its time zone, for quiet
    hours); a plain thread would start with none of it.
    """
    def _run() -> None:
        try:
            worker.deliver(event_id)
        except Exception as exc:
            logger.warning("ergates: push for event %s failed (%s)", event_id, type(exc).__name__)

    context = contextvars.copy_context()
    thread = threading.Thread(target=context.run, args=(_run,), name=f"ergates-ntfy-{event_id}", daemon=True)
    thread.start()
    return thread


def on_approval_request(
    attention: AttentionService,
    *,
    worker: Optional[DeliveryWorker] = None,
    profile: Optional[str] = None,
    **hook_kwargs: Any,
) -> Optional[threading.Thread]:
    """``pre_approval_request`` hook: record a pending approval with its push, then send it.

    ``hook_kwargs`` are Hermes's own hook arguments (``command``,
    ``description``, ``pattern_key``, ``pattern_keys``, ``session_key``,
    ``surface``, ``coalesced``). The store keeps a correlation hash, never
    the command or its description. A coalesced follower or the ``smart``
    guardian pre-check records nothing. ``worker`` is ``None`` when push is
    not configured; the event is still recorded. Returns the push thread
    when one was started (for tests); Hermes ignores observer return values.
    """
    event_id = attention.approval_requested(
        session_key=hook_kwargs.get("session_key"),
        pattern_key=hook_kwargs.get("pattern_key"),
        command=hook_kwargs.get("command"),
        surface=hook_kwargs.get("surface"),
        coalesced=hook_kwargs.get("coalesced"),
        profile=profile,
        request_id=hook_kwargs.get("request_id"),
    )
    if event_id is None or worker is None:
        return None
    return _deliver_in_background(worker, event_id)


def on_approval_response(attention: AttentionService, **hook_kwargs: Any) -> Optional[str]:
    """``post_approval_response`` hook: resolve the matching pending approval and cancel its push.

    The approval hooks carry no stable approval id at the pin, and several
    approvals can be pending in one session, so the service correlates on
    ``(session_key, pattern_key, command hash, surface)`` and resolves the
    oldest match. When nothing matches, nothing changes.
    """
    return attention.approval_resolved(
        session_key=hook_kwargs.get("session_key"),
        pattern_key=hook_kwargs.get("pattern_key"),
        command=hook_kwargs.get("command"),
        surface=hook_kwargs.get("surface"),
        coalesced=hook_kwargs.get("coalesced"),
        choice=hook_kwargs.get("choice"),
        request_id=hook_kwargs.get("request_id"),
    )


def on_turn_completed(
    attention: AttentionService,
    *,
    worker: Optional[DeliveryWorker] = None,
    profile: Optional[str] = None,
    platforms: frozenset[str] = DEFAULT_COMPLETED_PLATFORMS,
    **hook_kwargs: Any,
) -> Optional[threading.Thread]:
    """``post_llm_call`` hook: record a finished turn from one of ``platforms`` and push it.

    Hermes fires this hook once per finished turn with the user message, the
    reply and the history (``agent/turn_finalizer.py`` at the pin). Only
    ``session_id`` and ``platform`` are read; nothing else is stored. A turn
    from any other platform returns at once without touching the store.
    """
    event_id = attention.turn_completed(
        session_id=hook_kwargs.get("session_id") or "",
        profile=profile,
        platform=hook_kwargs.get("platform"),
        platforms=platforms,
    )
    if event_id is None or worker is None:
        return None
    return _deliver_in_background(worker, event_id)


def _resolve_profile(ctx: Any) -> Optional[str]:
    """The profile this hook call runs in, or ``None`` when Hermes cannot tell.

    An attention event without a profile is still recorded and pushed; its
    deep link then carries an empty profile and the app asks which chat.
    """
    try:
        return hermes_adapter.current_profile(ctx)
    except Exception:
        return None


def _delivery_worker(store: ControlStore) -> Optional[DeliveryWorker]:
    """A worker for the install's push settings, read at call time; ``None`` when push is off.

    The settings are install-wide (:mod:`ergates.settings`): the Hermes
    root's ``config.yaml``, whichever profile this hook runs in. A settings
    file that cannot be read turns push off for this call; the event and its
    outbox row are still recorded, and the flush sends the push later.
    """
    try:
        settings = push_settings(hermes_root())
    except Exception as exc:
        logger.warning("ergates: push settings unreadable (%s); the flush sends it later", type(exc).__name__)
        return None
    if settings is None:
        return None
    return DeliveryWorker(store, send_ntfy, settings)


@dataclass(frozen=True)
class _Services:
    store: ControlStore
    proposals: ProposalService
    attention: AttentionService
    reminders: ReminderService


# What opening the control store raises when it cannot serve: a folder or file
# this process cannot create or open (OSError), SQLite refusing the file, or a
# schema a newer plugin wrote (StoreError).
_OPEN_ERRORS = (StoreError, sqlite3.Error, OSError)


def _services_on_first_use() -> Callable[[], _Services]:
    """``services()``: the control store and its services, opened by the first call that needs them.

    Opening can fail. ``register`` must not: Hermes then disposes of every
    registration the plugin made, the tool gate included, and every tool call
    runs unchecked (``contract/test_pre_tool_call.py`` pins it). So the store
    opens here, and a failed open raises to that one caller and is tried again
    by the next call.
    """
    lock = threading.Lock()
    opened: list[_Services] = []

    def services() -> _Services:
        with lock:
            if not opened:
                store = ControlStore(store_path(hermes_root()))
                opened.append(_Services(
                    store, ProposalService(store), AttentionService(store),
                    ReminderService(store, hermes_adapter.HermesCron()),
                ))
            return opened[0]

    return services


def register(ctx: Any) -> None:
    """Wire the tool gate, the Ergates tools and the attention hooks into Hermes. Never raises for the store.

    The gate is registered first. While the control store cannot open, the
    gate blocks every tool call (``policy.BLOCK_UNVERIFIED``), the tools
    answer an error, and the attention hooks raise, which Hermes logs.
    """
    services = _services_on_first_use()

    @policy.guarded
    def handle_pre_tool_call(**kwargs: Any) -> Optional[dict]:
        # Any exception, from here or from the store, is a block (policy.guarded).
        profile = hermes_adapter.current_profile(ctx)
        proposals = services().proposals
        return policy.decide(
            kwargs.get("tool_name") or "", kwargs.get("args"),
            admitted=proposals.is_admitted(profile),
            # The toolset rule covers only profiles Ergates provisioned (ADR-034).
            granted_toolsets=hermes_adapter.granted_toolsets(profile) if proposals.provisioned(profile) else None,
            tool_toolset=hermes_adapter.toolset_for_tool(kwargs.get("tool_name") or ""),
        )

    def handle_propose(args: Dict[str, Any], **kwargs: Any) -> str:
        try:
            proposals = services().proposals
        except _OPEN_ERRORS as exc:
            return _not_recorded("proposal", exc)
        return propose_handler(args, service=proposals, **kwargs)

    def handle_create_reminder(args: Dict[str, Any], **kwargs: Any) -> str:
        try:
            profile = hermes_adapter.current_profile(ctx)
        except Exception:
            return json.dumps({"error": "Ergates could not tell which agent is asking"})
        try:
            reminders = services().reminders
        except _OPEN_ERRORS as exc:
            return _not_recorded("reminder", exc)
        return create_reminder_handler(
            args, service=reminders, profile=profile, check_schedule=hermes_adapter.check_schedule,
            check_prompt=hermes_adapter.check_prompt, check_gateway_lifecycle=hermes_adapter.check_gateway_lifecycle,
            **kwargs,
        )

    def handle_pre_approval(**kwargs: Any) -> None:
        opened = services()
        on_approval_request(
            opened.attention, worker=_delivery_worker(opened.store), profile=_resolve_profile(ctx), **kwargs,
        )

    def handle_post_approval(**kwargs: Any) -> None:
        on_approval_response(services().attention, **kwargs)

    def handle_turn_completed(**kwargs: Any) -> None:
        platforms = completed_platforms(ctx.get_config("attention.completed_platforms", None))
        if kwargs.get("platform") not in platforms:
            return
        opened = services()
        on_turn_completed(
            opened.attention, worker=_delivery_worker(opened.store), profile=_resolve_profile(ctx),
            platforms=platforms, **kwargs,
        )

    ctx.register_hook("pre_tool_call", handle_pre_tool_call)
    ctx.register_tool(
        name=PROPOSE_TOOL_NAME,
        toolset=policy.ERGATES_TOOLSET,
        schema=PROPOSE_SCHEMA,
        handler=handle_propose,
        description="Propose a new Ergates specialist agent for operator approval.",
        emoji="\U0001FA84",  # magic wand
    )
    ctx.register_tool(
        name=REMINDER_TOOL_NAME,
        toolset=policy.ERGATES_TOOLSET,
        schema=REMINDER_SCHEMA,
        handler=handle_create_reminder,
        description="Create a reminder that a retry never duplicates.",
        emoji="\u23F0",  # alarm clock
    )
    ctx.register_hook("pre_approval_request", handle_pre_approval)
    ctx.register_hook("post_approval_response", handle_post_approval)
    ctx.register_hook("post_llm_call", handle_turn_completed)
    try:
        services()
    except Exception as exc:
        # Class name only: the message can carry the store path.
        logger.warning(
            "ergates: the control store could not be opened (%s); tool calls are blocked until it opens",
            type(exc).__name__,
        )
