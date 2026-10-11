"""Agent proposals: validation, the canonical hash, and the proposal receipts.

Implements the ``ergates.agent-proposal.v1`` payload from
docs/11-implementation-readiness.md section 4.1. ``validate_proposal`` never
creates a profile or touches Hermes state -- it only validates model-supplied
arguments and returns a typed, self-contained proposal dict. Caller identity
and session context are backend-owned and are attached by the tool handler
(see ``tool.py``), never accepted here from model-supplied parameters.

:class:`ProposalService` keeps one receipt per proposal in the control store:
the proposal hash, the reserved profile name, ``expires_at``, the source
session id and the status of each provisioning step -- never the briefing or
the description (docs/04 sections 4 and 8). States (the ``ProposalReceipt`` of the HTTP API)::

    proposed --accept--> accepted --every step done + complete()--> complete
    proposed --reject--> rejected
    proposed past expires_at: read as "expired"; accept answers 410

The app performs the provisioning steps and reports each one (ADR-032);
the server verifies the profile and the plugin before it marks
the proposal complete.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional

from .store import ControlStore

PROPOSAL_KIND = "ergates.agent-proposal.v1"

NAME_PATTERN_DESCRIPTION = "^[a-z0-9][a-z0-9-]{1,31}$"
_NAME_RE = re.compile(NAME_PATTERN_DESCRIPTION)

# The profile names Hermes refuses to create: ``_RESERVED_NAMES`` in
# ``hermes_cli/profiles.py`` (``default`` is the built-in profile). Hermes keeps
# them in a private constant, so this is a copy;
# ``contract/test_reserved_profile_names.py`` keeps it equal to the pin.
HERMES_RESERVED_PROFILE_NAMES = frozenset({"hermes", "default", "test", "tmp", "root", "sudo"})

TITLE_MAX_LEN = 60
ROLE_MAX_LEN = 40
BRIEFING_MAX_LEN = 4000

PROPOSAL_EXPIRY = timedelta(hours=24)

# How long an unaccepted proposal receipt is kept past its own expiry before
# the retention sweep drops it (04 section 8: integration records are covered
# by the retention policy, not kept forever). The grace window leaves room for
# the app to show "this proposal expired" after the fact instead of the record
# vanishing the same second it stops being acceptable.
PROPOSAL_RETENTION_GRACE = timedelta(hours=24)
PROPOSAL_RETENTION_GRACE_SECONDS = int(PROPOSAL_RETENTION_GRACE.total_seconds())

PROPOSED_STATE = "proposed"
ACCEPTED = "accepted"
COMPLETE = "complete"
REJECTED = "rejected"
EXPIRED = "expired"

PROVISION_STEPS: tuple[str, ...] = ("profile_created", "plugin_enabled", "configured", "bot_chat", "briefing")
STEP_STATUSES = frozenset({"done", "uncertain", "failed"})

# The error codes of the HTTP API and their statuses. The template loader
# raises ``unknown_template``; every code has its one home here.
ERROR_HTTP_STATUS: Dict[str, int] = {
    "invalid": 400,
    "not_found": 404,
    "hash_mismatch": 409,
    "not_acceptable": 409,
    "name_taken": 409,
    "out_of_order": 409,
    "not_ready": 409,
    "expired": 410,
    "unknown_template": 422,
}

_REQUIRED_STRING_FIELDS = ("name", "title", "role", "template_id", "provider", "model", "briefing")


class ProposalError(ValueError):
    """A proposal request that cannot be served. ``code`` and ``http_status`` are the HTTP answer.

    ``validate_proposal`` raises it with ``code="invalid"``; the tool handler
    turns it into an ``{"error": ...}`` result and never raises it into Hermes.
    """

    def __init__(self, message: str, *, code: str = "invalid") -> None:
        if code not in ERROR_HTTP_STATUS:
            raise ValueError(f"unknown proposal error code {code!r}")
        super().__init__(message)
        self.code = code
        self.http_status = ERROR_HTTP_STATUS[code]


def _require_string(args: Dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProposalError(f"{key!r} is required and must be a non-empty string")
    return value


def validate_proposal(args: Dict[str, Any]) -> Dict[str, Any]:
    """Validate model-supplied proposal arguments and return a typed proposal.

    Raises :class:`ProposalError` on any invalid input. Never creates a
    profile, never changes permissions, and never persists anything -- that
    is the tool handler's and :class:`ProposalService`'s job.
    """
    if not isinstance(args, dict):
        raise ProposalError("proposal arguments must be an object")

    for field in _REQUIRED_STRING_FIELDS:
        _require_string(args, field)

    name = args["name"]
    if not _NAME_RE.fullmatch(name):
        raise ProposalError(f"name must match {NAME_PATTERN_DESCRIPTION}")
    if name in HERMES_RESERVED_PROFILE_NAMES:
        # An accept would reserve a name Hermes then refuses to create.
        raise ProposalError(f"name {name!r} is reserved by Hermes; pick another")

    title = args["title"]
    if len(title) > TITLE_MAX_LEN:
        raise ProposalError(f"title must be at most {TITLE_MAX_LEN} characters")

    role = args["role"]
    if len(role) > ROLE_MAX_LEN:
        raise ProposalError(f"role must be at most {ROLE_MAX_LEN} characters")

    briefing = args["briefing"]
    if len(briefing) > BRIEFING_MAX_LEN:
        raise ProposalError(f"briefing must be at most {BRIEFING_MAX_LEN} characters")

    description = args.get("description", "")
    if not isinstance(description, str):
        raise ProposalError("description must be a string")

    template_id = args["template_id"]
    provider = args["provider"]
    model = args["model"]

    expires_at = (
        datetime.now(timezone.utc) + PROPOSAL_EXPIRY
    ).isoformat(timespec="seconds").replace("+00:00", "Z")

    return {
        "kind": PROPOSAL_KIND,
        "proposal_id": str(uuid.uuid4()),
        "expires_at": expires_at,
        "agent": {
            "name": name,
            "title": title,
            "role": role,
            "description": description,
            "template_id": template_id,
            "provider": provider,
            "model": model,
        },
        "briefing": briefing,
    }


def payload_hash(proposal: Dict[str, Any]) -> str:
    """Stable sha256 hex digest of ``proposal``'s canonical JSON (key order never matters)."""
    canonical = json.dumps(proposal, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def parse_expires_at(value: Any) -> Optional[float]:
    """Epoch seconds for an ISO-8601 ``expires_at`` (``...Z`` included), or ``None``.

    Returns ``None`` for anything unparseable rather than raising. A value
    without a zone is read as UTC.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _receipt(conn: sqlite3.Connection, proposal_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM proposal_receipts WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise ProposalError(f"no proposal {proposal_id!r}", code="not_found")
    return row


def _step_status(conn: sqlite3.Connection, proposal_id: str) -> Dict[str, str]:
    found = conn.execute("SELECT step, status FROM proposal_steps WHERE proposal_id = ?", (proposal_id,))
    return {row["step"]: row["status"] for row in found}


def _next_step(status: Dict[str, str]) -> Optional[str]:
    return next((step for step in PROVISION_STEPS if status.get(step) != "done"), None)


def _view(row: sqlite3.Row, status: Dict[str, str], now: float) -> dict:
    """The ``ProposalReceipt`` of a stored receipt, without ``template``."""
    state = row["state"]
    if state == PROPOSED_STATE and now > row["expires_at_epoch"]:
        state = EXPIRED
    return {
        "proposal_id": row["id"],
        "state": state,
        "reserved_profile_name": row["reserved_profile_name"],
        "expires_at": row["expires_at"],
        "completed_steps": [step for step in PROVISION_STEPS if status.get(step) == "done"],
        "step_status": {step: status[step] for step in PROVISION_STEPS if step in status},
        "next_step": _next_step(status) if state in (PROPOSED_STATE, ACCEPTED) else None,
    }


def _swap(conn: sqlite3.Connection, row: sqlite3.Row, state: str, now: float) -> bool:
    """Compare-and-set: move ``row`` to ``state`` iff it is still at ``row["version"]``."""
    cursor = conn.execute(
        "UPDATE proposal_receipts SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        (state, now, row["id"], row["version"]),
    )
    return cursor.rowcount == 1


class ProposalService:
    """Proposal receipts: record, accept or reject, provisioning steps, completion, retention."""

    def __init__(self, store: ControlStore, *, clock: Callable[[], float] = time.time) -> None:
        self._store = store
        self._clock = clock

    def record(self, proposal: dict) -> dict:
        """Store the receipt of a validated proposal as ``proposed``.

        ``proposal`` is exactly what the tool returns, ``source_session_id``
        included, so the stored hash is the hash the accept call must match.
        """
        expires_at_epoch = parse_expires_at(proposal["expires_at"])
        if expires_at_epoch is None:
            raise ProposalError("expires_at is not an ISO-8601 time")
        now = self._clock()
        try:
            with self._store.transaction() as conn:
                conn.execute(
                    "INSERT INTO proposal_receipts (id, state, proposal_hash, reserved_profile_name, expires_at, "
                    "expires_at_epoch, source_session_id, version, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                    (proposal["proposal_id"], PROPOSED_STATE, payload_hash(proposal), proposal["agent"]["name"],
                     proposal["expires_at"], expires_at_epoch, proposal.get("source_session_id"), now, now),
                )
                row = _receipt(conn, proposal["proposal_id"])
        except sqlite3.IntegrityError:
            raise ProposalError(f"proposal {proposal['proposal_id']!r} is already recorded") from None
        return _view(row, {}, now)

    def get(self, proposal_id: str) -> dict:
        """The receipt, or ``ProposalError`` ``not_found``."""
        with self._store.read() as conn:
            row = _receipt(conn, proposal_id)
            status = _step_status(conn, proposal_id)
        return _view(row, status, self._clock())

    def check_payload(self, proposal_id: str, proposal: Any) -> None:
        """Raise ``not_found`` for an unknown id, and ``hash_mismatch`` unless ``proposal`` is the recorded one.

        Read-only. The accept route calls it before it looks up the template
        the payload names, so a payload that is not the proposal is a 409,
        never a 422 for a template it made up.
        """
        with self._store.read() as conn:
            row = _receipt(conn, proposal_id)
        if not isinstance(proposal, dict) or proposal.get("proposal_id") != proposal_id \
                or payload_hash(proposal) != row["proposal_hash"]:
            raise ProposalError("the approved payload is not the recorded proposal", code="hash_mismatch")

    def accept(self, proposal_id: str, proposal: dict, *, profile_exists: Callable[[str], bool]) -> dict:
        """Accept the proposal exactly as the agent proposed it: accept takes no edits.

        In order: an unknown id is ``not_found``; a payload that is not this
        proposal is ``hash_mismatch``; an accepted or complete proposal is
        returned as is (a retry); a rejected one is ``not_acceptable``; a
        proposed one past ``expires_at`` is ``expired``; a name that already
        belongs to a profile or to another accepted proposal is ``name_taken``.
        """
        now = self._clock()
        with self._store.read() as conn:
            row = _receipt(conn, proposal_id)
        if not isinstance(proposal, dict) or proposal.get("proposal_id") != proposal_id \
                or payload_hash(proposal) != row["proposal_hash"]:
            raise ProposalError("the approved payload is not the recorded proposal", code="hash_mismatch")
        if row["state"] in (ACCEPTED, COMPLETE):
            return self.get(proposal_id)
        if row["state"] == REJECTED:
            raise ProposalError("this proposal was rejected", code="not_acceptable")
        if now > row["expires_at_epoch"]:
            raise ProposalError("this proposal has expired", code="expired")
        name = row["reserved_profile_name"]
        if profile_exists(name):
            raise ProposalError(f"a profile named {name!r} already exists", code="name_taken")
        try:
            with self._store.transaction() as conn:
                swapped = _swap(conn, row, ACCEPTED, now)
        except sqlite3.IntegrityError:
            raise ProposalError(f"another accepted proposal reserves {name!r}", code="name_taken") from None
        receipt = self.get(proposal_id)
        if not swapped and receipt["state"] not in (ACCEPTED, COMPLETE):
            raise ProposalError("this proposal was rejected", code="not_acceptable")
        return receipt

    def reject(self, proposal_id: str) -> dict:
        """``proposed`` becomes ``rejected``. Idempotent; an accepted proposal is ``not_acceptable``."""
        now = self._clock()
        with self._store.transaction() as conn:
            row = _receipt(conn, proposal_id)
            if row["state"] in (ACCEPTED, COMPLETE):
                raise ProposalError("an accepted proposal cannot be rejected", code="not_acceptable")
            if row["state"] == PROPOSED_STATE:
                _swap(conn, row, REJECTED, now)
        return self.get(proposal_id)

    def record_step(self, proposal_id: str, step: str, status: str) -> dict:
        """Record one provisioning step the app reports.

        A step can be reported only for an accepted proposal and only after
        every earlier step is ``done``. A ``done`` step stays done: reporting
        it again changes nothing. ``uncertain`` and ``failed`` are recorded
        without advancing ``next_step``.
        """
        if not isinstance(step, str) or step not in PROVISION_STEPS:
            raise ProposalError(f"unknown provisioning step {step!r}")
        if not isinstance(status, str) or status not in STEP_STATUSES:
            raise ProposalError(f"unknown step status {status!r}")
        now = self._clock()
        with self._store.transaction() as conn:
            row = _receipt(conn, proposal_id)
            current = _step_status(conn, proposal_id)
            if current.get(step) != "done":
                if row["state"] != ACCEPTED:
                    raise ProposalError("steps are recorded only for an accepted proposal", code="out_of_order")
                pending = _next_step(current)
                if pending != step:
                    raise ProposalError(f"{step!r} cannot be reported before {pending!r} is done", code="out_of_order")
                conn.execute(
                    "INSERT INTO proposal_steps (proposal_id, step, status, updated_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (proposal_id, step) DO UPDATE SET status = excluded.status, "
                    "updated_at = excluded.updated_at",
                    (proposal_id, step, status, now),
                )
        return self.get(proposal_id)

    def complete(
        self, proposal_id: str, *,
        profile_exists: Callable[[str], bool], plugin_enabled: Callable[[str], bool],
    ) -> dict:
        """``accepted`` becomes ``complete`` once every step is done and the profile is verified."""
        receipt = self.get(proposal_id)
        if receipt["state"] == COMPLETE:
            return receipt
        if receipt["state"] != ACCEPTED or receipt["next_step"] is not None:
            raise ProposalError("provisioning is not finished", code="not_ready")
        name = receipt["reserved_profile_name"]
        if not profile_exists(name) or not plugin_enabled(name):
            raise ProposalError(f"profile {name!r} is not ready yet", code="not_ready")
        with self._store.transaction() as conn:
            row = _receipt(conn, proposal_id)
            if row["state"] == ACCEPTED:
                _swap(conn, row, COMPLETE, self._clock())
        return self.get(proposal_id)

    def is_admitted(self, profile: str) -> bool:
        """False while an accepted, not yet complete proposal reserves ``profile``."""
        with self._store.read() as conn:
            found = conn.execute(
                "SELECT 1 FROM proposal_receipts WHERE state = ? AND reserved_profile_name = ?", (ACCEPTED, profile),
            ).fetchone()
        return found is None

    def provisioned(self, profile: str) -> bool:
        """True when Ergates provisioned ``profile``: an accepted or complete proposal reserves it
        and its ``configured`` step was reported (done, uncertain or failed).

        From then on the app has configured the profile from a template, so
        the tool gate's toolset rule applies to it (ADR-034). Never true for
        the default profile, which no proposal may name.
        """
        if profile == "default":
            return False
        with self._store.read() as conn:
            found = conn.execute(
                "SELECT 1 FROM proposal_receipts r JOIN proposal_steps s ON s.proposal_id = r.id "
                "WHERE r.reserved_profile_name = ? AND r.state IN (?, ?) AND s.step = ?",
                (profile, ACCEPTED, COMPLETE, "configured"),
            ).fetchone()
        return found is not None

    def prune(self, now: float) -> int:
        """Drop unaccepted (proposed or rejected) receipts 24 h past ``expires_at``.

        An accepted or complete receipt is the provisioning record that
        resume-by-receipt needs and is never pruned. Returns how many were removed.
        """
        with self._store.transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM proposal_receipts WHERE state IN (?, ?) AND expires_at_epoch + ? < ?",
                (PROPOSED_STATE, REJECTED, PROPOSAL_RETENTION_GRACE_SECONDS, now),
            )
        return cursor.rowcount
