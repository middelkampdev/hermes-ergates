"""The Ergates HTTP operations, free of any web framework.

``dashboard/api.py`` maps each route under ``/api/plugins/ergates`` onto one
method here and turns the returned :class:`Reply` into a JSON response. A
method never raises for a problem with the request: every answer is a
``Reply`` with the HTTP status and body, so the router stays a thin shim and
the behavior is unit-tested without FastAPI. A failure no method maps (a
Hermes call that raised) propagates, and the router answers it with
:func:`internal_error`.

Error body: ``{"error": {"code": "<code>", "message": "<safe text>"}}``. A
message names fields, states and profile names; it never carries prompt,
briefing or description text.

Hermes is reached only through the functions an ``Operations`` is given
(``hermes_adapter`` in production, fakes in the tests), so this module
imports no Hermes code
(``integrations/ergates-tests/tests/test_hermes_boundary.py``). Methods
block: a store write can wait up to the store's busy timeout, and a second
identical reminder request waits up to ``reminders.IN_FLIGHT_WAIT_SECONDS``
for the first. The router runs them on a worker thread.
"""

from __future__ import annotations

import functools
import logging
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import __version__
from .attention import AttentionError, AttentionService
from .proposals import ProposalError, ProposalService
from .reminders import CronPort, ReminderError, ReminderService, _REQUEST_ID_RE
from .setup import enable_everywhere, ensure_templates, setup_report
from .store import ControlStore, StoreError, StoreReadOnly
from .templates import load_template

logger = logging.getLogger(__name__)

LABEL_MAX_LEN = 64
PREFS_KEYS = ("profile", "muted", "quiet_start", "quiet_end")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")  # Hermes profile ids at the pin
_REMINDER_STATUS = {"created": 201, "existing": 200, "uncertain": 202}
_REMINDER_ERROR_STATUS = {"invalid": 400, "unknown_profile": 404}
_NOT_AN_OBJECT = "the request body must be a JSON object"
_STEP_STATUS_NOT_STRINGS = "step and status must be strings"
PROMPT_REFUSED = "prompt is not one Hermes cron accepts"
PROMPT_STOPS_GATEWAY = "prompt reads as a command to stop or restart the Hermes gateway, which Hermes cron refuses"


@dataclass(frozen=True)
class Reply:
    """One HTTP answer: status code and JSON body."""

    status: int
    body: dict


def error_reply(status: int, code: str, message: str, **extra: Any) -> Reply:
    """The error body, plus any ``extra`` top-level keys (a conflict carries its ``receipt``)."""
    return Reply(status, {"error": {"code": code, "message": message}, **extra})


def store_unavailable() -> Reply:
    """503 ``store_unavailable``: the control store cannot be opened or read."""
    return error_reply(503, "store_unavailable", "the Ergates control store is unavailable")


def store_too_new() -> Reply:
    """503 ``store_too_new``: a newer plugin changed the control store so that this one may only read it."""
    return error_reply(503, "store_too_new", "the Ergates control store needs a newer Ergates plugin")


def internal_error() -> Reply:
    """500 ``internal``: a failure no route maps, such as a Hermes call that raised.

    Fixed text: the exception's own message can carry a path or prompt text.
    """
    return error_reply(500, "internal", "The request could not be completed.")


def reminder_problem(*, schedule: Any, timezone: Any, prompt: Any, label: Any) -> str | None:
    """Why a reminder request is refused before any Hermes call, or ``None``.

    Shared by ``POST /reminders`` and the ``ergates_create_reminder`` tool.
    ``timezone`` must be an IANA zone name (``Europe/Amsterdam``); ``label``
    is optional, at most 64 printable characters, and becomes part of the
    cron job's name, which the prompt never does. Text must encode as UTF-8:
    JSON can carry a lone surrogate (``"\\ud800"``), which the idempotency
    hash cannot encode.
    """
    for name, value in (("schedule", schedule), ("timezone", timezone), ("prompt", prompt)):
        if not isinstance(value, str) or not value.strip():
            return f"{name} is required and must be a non-empty string"
        if not _encodes_as_utf8(value):
            return f"{name} must be valid Unicode text"
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return "timezone must be an IANA time zone name, for example Europe/Amsterdam"
    if label is not None and not (
        isinstance(label, str) and label.strip() and len(label) <= LABEL_MAX_LEN and label.isprintable()
    ):
        return f"label must be 1 to {LABEL_MAX_LEN} printable characters"
    return None


def _encodes_as_utf8(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _guard_store(method: Callable[..., "Reply"]) -> Callable[..., "Reply"]:
    """Map a control-store failure from any route to 503 ``store_unavailable``, or
    to 503 ``store_too_new`` for a write the store refuses.

    The store opens a fresh connection per operation (``store.py``
    ``transaction``/``read``), so any route that touches it -- not only
    ``health()`` -- can hit a closed store. A write can also hit a store a
    newer plugin changed so that this one may only read it; the store logs
    that once itself, so the guard does not log it per request.
    A bare ``OSError`` is deliberately not caught here: ``hermes_adapter``
    raises it for reasons that have nothing to do with the store, and this
    guard must not turn one of those into a false "store unavailable"; the
    router answers it 500 ``internal``.
    """

    @functools.wraps(method)
    def wrapper(self: "Operations", *args: Any, **kwargs: Any) -> Reply:
        try:
            return method(self, *args, **kwargs)
        except StoreReadOnly:
            return store_too_new()
        except (StoreError, sqlite3.Error) as exc:
            logger.warning("operations: the control store is unavailable (%s)", type(exc).__name__)
            return store_unavailable()

    return wrapper


class Operations:
    """Every HTTP route as a method that returns a :class:`Reply`."""

    def __init__(
        self, store: ControlStore, *, cron: CronPort,
        profile_exists: Callable[[str], bool], plugin_enabled: Callable[[str], bool],
        enable_plugin: Callable[[str], None], profile_names: Callable[[], list[str]],
        check_schedule: Callable[[str, str], None], check_prompt: Callable[[str], None],
        check_gateway_lifecycle: Callable[[str, str], None], templates: Path, bundled_templates: Path,
        sweep_status: Callable[[], dict], clock: Callable[[], float] = time.time,
    ) -> None:
        self._store = store
        self._sweep_status = sweep_status
        self._profile_exists = profile_exists
        self._plugin_enabled = plugin_enabled
        self._enable_plugin = enable_plugin
        self._profile_names = profile_names
        self._check_schedule = check_schedule
        self._check_prompt = check_prompt
        self._check_gateway_lifecycle = check_gateway_lifecycle
        self._templates = Path(templates)
        self._bundled_templates = Path(bundled_templates)
        self._reminders = ReminderService(store, cron, clock=clock)
        self._proposals = ProposalService(store, clock=clock)
        self._attention = AttentionService(store, clock=clock)

    # GET /health
    @_guard_store
    def health(self) -> Reply:
        """The store's schema, the plugin version and the periodic sweep's ``status()`` (``ergates.sweep``)."""
        schema_version = self._store.schema_version
        return Reply(200, {"ok": True, "schema_version": schema_version, "plugin_version": __version__,
                           "sweep": self._sweep_status()})

    # POST /reminders
    @_guard_store
    def create_reminder(self, body: Any) -> Reply:
        try:
            request = self._reminder_request(body)
            outcome = self._reminders.create(**request)
        except ReminderError as exc:
            return error_reply(_REMINDER_ERROR_STATUS[exc.code], exc.code, str(exc))
        if outcome.status == "conflict":
            return error_reply(
                409, "conflict", "this request_id was already used for a different reminder",
                receipt=outcome.receipt,
            )
        return Reply(_REMINDER_STATUS[outcome.status], {"receipt": outcome.receipt})

    # GET /proposals/{proposal_id}
    @_guard_store
    def get_proposal(self, proposal_id: str) -> Reply:
        return self._proposal_reply(lambda: self._proposals.get(proposal_id))

    # POST /proposals/{proposal_id}/accept
    @_guard_store
    def accept_proposal(self, proposal_id: str, body: Any) -> Reply:
        if not isinstance(body, dict):
            return error_reply(400, "invalid", _NOT_AN_OBJECT)
        proposal = body.get("proposal")
        try:
            self._proposals.check_payload(proposal_id, proposal)
            # Before accept: an unknown template must not reserve the profile name.
            template = load_template(self._templates, proposal["agent"]["template_id"])
            receipt = self._proposals.accept(proposal_id, proposal, profile_exists=self._profile_exists)
        except ProposalError as exc:
            return _proposal_error(exc)
        return Reply(200, {"proposal": {**receipt, "template": template}})

    # POST /proposals/{proposal_id}/reject
    @_guard_store
    def reject_proposal(self, proposal_id: str) -> Reply:
        return self._proposal_reply(lambda: self._proposals.reject(proposal_id))

    # POST /proposals/{proposal_id}/steps
    @_guard_store
    def record_step(self, proposal_id: str, body: Any) -> Reply:
        if not isinstance(body, dict):
            return error_reply(400, "invalid", _NOT_AN_OBJECT)
        step, status = body.get("step"), body.get("status")
        if not isinstance(step, str) or not isinstance(status, str):
            return error_reply(400, "invalid", _STEP_STATUS_NOT_STRINGS)

        def record() -> dict:
            receipt = self._proposals.record_step(proposal_id, step, status)
            if step == "briefing" and status == "done":
                receipt = self._proposals.complete(
                    proposal_id, profile_exists=self._profile_exists, plugin_enabled=self._plugin_enabled,
                )
            return receipt

        return self._proposal_reply(record)

    # POST /profiles/{profile}/plugin
    @_guard_store
    def enable_plugin(self, profile: str) -> Reply:
        if not _is_profile_name(profile):
            return error_reply(404, "unknown_profile", "there is no profile with that name")
        if not self._profile_exists(profile):
            return error_reply(404, "unknown_profile", f"profile {profile!r} does not exist")
        self._enable_plugin(profile)
        return Reply(200, {"profile": profile, "enabled": True})

    # POST /setup
    def setup(self, body: Any) -> Reply:
        """Install the templates the plugin ships, then enable it in every profile; one report for both.

        The body must be a JSON object (``{}``), so that a request the router
        could not read as JSON is refused before anything is touched.
        Profiles that fail are named in the report and do not make the reply
        an error. It touches no store table, but the router builds an
        ``Operations`` only once the store opens, so as root on a Hermes root
        another user owns it writes nothing (``store.root_run_would_break``).
        """
        if not isinstance(body, dict):
            return error_reply(400, "invalid", _NOT_AN_OBJECT)
        templates = ensure_templates(self._bundled_templates, self._templates)
        profiles = enable_everywhere(self._profile_names(), self._enable_plugin, self._plugin_enabled)
        return Reply(200, {"setup": setup_report(templates, profiles)})

    # GET /attention/prefs?scope=<name or *>, or ?profile=<name>
    @_guard_store
    def get_prefs(self, scope: Any, named_profile: Any = None) -> Reply:
        """The prefs of ``scope``, a profile name or ``*`` for every agent.

        Without a scope, ``named_profile`` (the ``?profile=`` query) names one
        agent and nothing else: Hermes runs a request in the profile its
        ``profile`` parameter names and refuses ``*`` there itself.
        """
        if scope is None and named_profile is not None:
            if not _is_profile_name(named_profile):
                return error_reply(400, "invalid", "?profile= names one agent; ask for every agent with ?scope=*")
            scope = named_profile
        try:
            prefs = self._attention.get_prefs(scope)
        except AttentionError as exc:
            return error_reply(400, "invalid", str(exc))
        return Reply(200, {"prefs": prefs})

    # PUT /attention/prefs
    @_guard_store
    def set_prefs(self, body: Any) -> Reply:
        if not isinstance(body, dict):
            return error_reply(400, "invalid", _NOT_AN_OBJECT)
        if any(key not in body for key in PREFS_KEYS):
            return error_reply(400, "invalid", "prefs need profile, muted, quiet_start and quiet_end")
        try:
            prefs = self._attention.set_prefs(
                body["profile"], muted=body["muted"], quiet_start=body["quiet_start"], quiet_end=body["quiet_end"],
            )
        except AttentionError as exc:
            return error_reply(400, "invalid", str(exc))
        return Reply(200, {"prefs": prefs})

    def _reminder_request(self, body: Any) -> dict:
        """The service arguments of a valid request; ``ReminderError`` otherwise.

        Order: the body's fields (400) -- profile, request_id and the rest --
        then the profile's existence (404), then the schedule as Hermes cron
        reads it (400), then the prompt as Hermes cron's scan reads it (400),
        then the prompt as its gateway lifecycle guard reads it in the
        profile (400), so a malformed field is always a 400 and never races
        an unknown profile for which status wins, and Hermes is never asked
        about a schedule or prompt the request already fails on some other
        field.
        """
        if not isinstance(body, dict):
            raise ReminderError(_NOT_AN_OBJECT)
        profile, request_id = body.get("profile"), body.get("request_id")
        if not _is_profile_name(profile):
            raise ReminderError("profile must be a Hermes profile name")
        if not isinstance(request_id, str) or not request_id:
            raise ReminderError("request_id is required and must be a non-empty string")
        if not _REQUEST_ID_RE.fullmatch(request_id):
            raise ReminderError(
                "request_id must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit"
            )
        problem = reminder_problem(
            schedule=body.get("schedule"), timezone=body.get("timezone"), prompt=body.get("prompt"),
            label=body.get("label"),
        )
        if problem is not None:
            raise ReminderError(problem)
        if not self._profile_exists(profile):
            raise ReminderError(f"profile {profile!r} does not exist", code="unknown_profile")
        try:
            self._check_schedule(profile, body["schedule"])
        except (ValueError, OverflowError):
            # hermes_adapter.check_schedule maps OverflowError to ValueError itself;
            # this also catches it directly so a check_schedule that does not (a
            # future adapter, or a test double) never turns into an unhandled 500.
            raise ReminderError("schedule is not one Hermes cron accepts") from None
        try:
            self._check_prompt(body["prompt"])
        except ValueError:
            # Fixed text: the scan's reason names what matched in the prompt.
            raise ReminderError(PROMPT_REFUSED) from None
        try:
            self._check_gateway_lifecycle(profile, body["prompt"])
        except ValueError:
            raise ReminderError(PROMPT_STOPS_GATEWAY) from None
        return {
            "profile": profile, "schedule": body["schedule"], "timezone": body["timezone"],
            "prompt": body["prompt"], "request_id": request_id, "label": body.get("label"),
        }

    def _proposal_reply(self, call: Callable[[], dict]) -> Reply:
        """Run a proposal call; its receipt with ``template: null``, or its error reply."""
        try:
            receipt = call()
        except ProposalError as exc:
            return _proposal_error(exc)
        return Reply(200, {"proposal": {**receipt, "template": None}})


def _is_profile_name(value: Any) -> bool:
    return isinstance(value, str) and bool(_PROFILE_RE.fullmatch(value))


def _proposal_error(exc: ProposalError) -> Reply:
    return error_reply(exc.http_status, exc.code, str(exc))
