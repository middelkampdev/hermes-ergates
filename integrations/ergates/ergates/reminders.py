"""Idempotent reminder creation on top of Hermes cron, recorded in the control store.

Hermes remains the scheduler (docs/11 section 4.3); this module never runs a
timer. A reminder request becomes one row in ``reminder_receipts``, and every
change to that row is a versioned compare-and-set: it names the ``version``
it read and fails when another writer got there first. That makes the retry
cases safe:

- Two identical requests at the same moment: one claims the receipt and
  calls cron; the other waits for it and returns the same receipt.
- A job deleted natively (Routines screen): only the request that still
  holds the version that saw the job missing creates it again, so two
  retries never make two jobs.
- A one-shot that already ran: Hermes keeps it as a completed job (7 days
  by default). For a receipt keyed by its payload (no request id: the
  agent tool) that job counts as gone, so the same request after the run
  makes a new reminder. A receipt with a request id keeps it: the app sends
  a new id per attempt, so the same id again is a retry of a request
  already served.
- A create whose answer was lost: the receipt is ``uncertain``, and the next
  request reconciles it through the job's unique name instead of creating
  blindly. A ``creating`` receipt older than :data:`IN_FLIGHT_SECONDS` is
  treated the same way: its creator died.
- The retention sweep deletes only the receipt version it inspected, never
  a receipt claimed again after it looked.

Cron is reached only through :class:`CronPort` and never inside a store
transaction, so a slow scheduler never holds the store's write lock. The
production port is ``hermes_adapter.HermesCron``.
A process without cron access prunes with :class:`UnavailableCron`, which
applies only the 30-day idle rule.

The receipt keeps hashes, never the prompt (docs/04 sections 4 and 8).

**Timezone is advisory.** Hermes 0.21.2 has no per-job timezone:
``CronJobCreate``, ``cron.jobs.create_job`` and the ``cron.manage`` RPC accept
none, and ``timezone`` is one global config key. The zone stays in the
idempotency key, so two requests that differ only in zone stay two
reminders, and comes back on the receipt as ``timezone_advisory``. A
reminder fires in the timezone Hermes is configured for (``HERMES_TIMEZONE``
or ``timezone`` in ``config.yaml``; server local time when neither is set).
"""

from __future__ import annotations

import hashlib
import logging
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Callable, Literal, Protocol

from .store import ControlStore

logger = logging.getLogger(__name__)

SECONDS_PER_DAY = 86400
REMINDER_MAX_IDLE_SECONDS = 30 * SECONDS_PER_DAY
# A `creating` receipt younger than this belongs to a creator that is still
# inside find_job_ids_by_name or create_job (a fresh claim reconciles by name
# before it creates). The in-process Hermes cron answers in milliseconds.
IN_FLIGHT_SECONDS = 60
# How long a second request waits for that creator before it answers uncertain.
IN_FLIGHT_WAIT_SECONDS = 5.0
POLL_SECONDS = 0.02
# Decisions per request; each extra round means another writer changed the receipt.
MAX_ROUNDS = 3

CREATING = "creating"
CREATED = "created"
UNCERTAIN = "uncertain"

_FIELD_SEPARATOR = "\x1f"  # ASCII unit separator: never appears in normal text input
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")  # Hermes profile ids at the pin
_VIEW_KEYS = ("id", "request_id", "profile", "state", "job_id", "timezone_advisory", "payload_hash")


class CronPort(Protocol):
    """The cron operations reminders need. Every call is scoped to one profile."""

    def create_job(self, profile: str, *, schedule: str, prompt: str, name: str) -> dict: ...

    # None = no such job; raise = could not tell. ``"completed": True`` = a job
    # that already ran its last time (Hermes keeps a one-shot that ran for 7 days).
    def get_job(self, profile: str, job_id: str) -> dict | None: ...

    def find_job_ids_by_name(self, profile: str, name: str) -> list[str]: ...


class CronUnavailable(RuntimeError):
    """Raised by :class:`UnavailableCron`: this process cannot reach cron."""


class UnavailableCron:
    """A :class:`CronPort` for a process without cron access.

    Every call raises :class:`CronUnavailable`, which callers treat as "could
    not tell": the retention sweep then applies only its 30-day idle rule.
    """

    def create_job(self, profile: str, *, schedule: str, prompt: str, name: str) -> dict:
        raise CronUnavailable("cron is not reachable from this process")

    def get_job(self, profile: str, job_id: str) -> dict | None:
        raise CronUnavailable("cron is not reachable from this process")

    def find_job_ids_by_name(self, profile: str, name: str) -> list[str]:
        raise CronUnavailable("cron is not reachable from this process")


@dataclass(frozen=True)
class ReminderOutcome:
    """What :meth:`ReminderService.create` did, and the receipt it did it with."""

    status: Literal["created", "existing", "conflict", "uncertain"]
    receipt: dict


class ReminderError(Exception):
    """A request that cannot be served. ``code`` is ``"invalid"`` or ``"unknown_profile"``."""

    def __init__(self, message: str, *, code: str = "invalid") -> None:
        super().__init__(message)
        self.code = code


def _normalize(value: str) -> str:
    """Collapse incidental whitespace so cosmetic differences don't change the key."""
    return re.sub(r"\s+", " ", str(value).strip())


def idempotency_key(profile: str, schedule: str, timezone: str, prompt: str) -> str:
    """Stable content hash of one (profile, schedule, timezone, prompt) request.

    The ``payload_hash`` of every receipt, and the receipt id when the caller
    supplies no ``request_id``.
    """
    parts = (_normalize(profile), _normalize(schedule), _normalize(timezone), _normalize(prompt))
    return hashlib.sha256(_FIELD_SEPARATOR.join(parts).encode("utf-8")).hexdigest()


def prompt_hash(prompt: str) -> str:
    """sha256 hex digest of the normalized prompt. The receipt stores this, never the prompt."""
    return hashlib.sha256(_normalize(prompt).encode("utf-8")).hexdigest()


def routine_name(profile: str, label: str | None, receipt_id: str, payload_hash: str) -> str:
    """``[bot:<profile>] <label or "reminder"> · <first 8 hex of sha256(receipt_id + payload_hash)>``.

    The ``[bot:<profile>] `` prefix is the display convention clients filter
    routines on (docs/06 section 6). The tag is unique per receipt **and**
    payload, which is what lets a fresh claim or an uncertain create be
    reconciled by name: a ``request_id`` reused with a different payload
    (an edited prompt resent under the same id, after the receipt that would
    have caught it as a ``conflict`` was pruned) must compute a different
    name, or the fresh claim would find the old job by name and adopt it --
    reporting success while the reminder actually requested is never made.
    The name never carries prompt text.
    """
    tag = hashlib.sha256(f"{receipt_id}\n{payload_hash}".encode("utf-8")).hexdigest()[:8]
    text = _normalize(label) if label and label.strip() else "reminder"
    return f"[bot:{_normalize(profile)}] {text} · {tag}"


def _validate(profile, schedule, timezone, prompt, request_id, label) -> None:
    for name, value in (("profile", profile), ("schedule", schedule), ("prompt", prompt)):
        if not isinstance(value, str) or not value.strip():
            raise ReminderError(f"{name} is required and must be a non-empty string")
    if not _PROFILE_RE.fullmatch(profile.strip()):
        raise ReminderError("profile must be a Hermes profile name")
    if not isinstance(timezone, str):
        raise ReminderError("timezone must be a string")
    if request_id is not None and not (isinstance(request_id, str) and _REQUEST_ID_RE.fullmatch(request_id)):
        raise ReminderError("request_id must be 1-128 letters, digits, '.', '_' or '-', starting with a letter or digit")
    if label is not None and not isinstance(label, str):
        raise ReminderError("label must be a string")


def _counts_as_gone(row, job: dict | None) -> bool:
    """Whether ``job``, as ``CronPort.get_job`` answered it, no longer serves receipt ``row``.

    A job cron does not have is gone. A completed job (a one-shot Hermes
    already ran and keeps for 7 days) is gone only for a receipt without a
    request id: that receipt is keyed by its payload, so the same request
    after the run asks for a new reminder. A receipt with a request id keeps
    its completed job: the app sends a new id per attempt, so the same id
    again is a retry of a request that was served.
    """
    if job is None:
        return True
    return row["request_id"] is None and job.get("completed") is True


def _view(row: sqlite3.Row | dict) -> dict:
    """The ``ReminderReceipt`` of a stored receipt."""
    return {key: row[key] for key in _VIEW_KEYS}


def _get(conn: sqlite3.Connection, receipt_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM reminder_receipts WHERE id = ?", (receipt_id,)).fetchone()


def _swap(conn: sqlite3.Connection, row, *, state: str, job_id: str | None, now: float) -> sqlite3.Row | None:
    """Compare-and-set: move ``row`` to ``state``/``job_id`` iff it is still at ``row["version"]``."""
    cursor = conn.execute(
        "UPDATE reminder_receipts SET state = ?, job_id = ?, version = version + 1, updated_at = ? "
        "WHERE id = ? AND version = ?",
        (state, job_id, now, row["id"], row["version"]),
    )
    return _get(conn, row["id"]) if cursor.rowcount == 1 else None


class ReminderService:
    """Creates Hermes cron reminders exactly once per receipt id."""

    def __init__(self, store: ControlStore, cron: CronPort, *, clock: Callable[[], float] = time.time) -> None:
        self._store = store
        self._cron = cron
        self._clock = clock

    def create(
        self, profile: str, schedule: str, timezone: str, prompt: str, *,
        request_id: str | None = None, label: str | None = None,
    ) -> ReminderOutcome:
        """Create, return, or reconcile the reminder of one request.

        The receipt id is ``request_id`` (the app's per-attempt outbox id) when
        given, else the payload hash. The same id with a different payload is
        a ``conflict`` and creates nothing. A failed ``create_job`` is not
        raised: the receipt and the outcome are ``uncertain``, and the next
        request reconciles.
        """
        _validate(profile, schedule, timezone, prompt, request_id, label)
        payload = idempotency_key(profile, schedule, timezone, prompt)
        receipt_id = request_id if request_id is not None else payload
        fresh = {
            "id": receipt_id,
            "request_id": request_id,
            "profile": _normalize(profile),
            "job_name": routine_name(profile, label, receipt_id, payload),
            "timezone_advisory": _normalize(timezone),
            "payload_hash": payload,
            "prompt_hash": prompt_hash(prompt),
        }
        row = None
        for _ in range(MAX_ROUNDS):
            step, row = self._decide(fresh)
            if step == "conflict":
                logger.warning("reminders: request id %r reused with a different payload", receipt_id)
                return ReminderOutcome("conflict", _view(row))
            if step == "verify":
                outcome = self._verify(row, schedule, prompt)
            elif step == "wait":
                outcome = self._wait(row)
            else:
                outcome = self._reconcile(row, schedule, prompt)
            if outcome is not None:
                return outcome
        logger.warning("reminders: receipt %r kept changing during this request; reporting it uncertain", receipt_id)
        return ReminderOutcome("uncertain", _view(self._current(row)))

    def prune(self, now: float) -> int:
        """Drop receipts idle for 30 days, and ``created`` receipts whose job is gone.

        Each deletion names the version the sweep inspected, so a receipt that
        a request changed in the meantime survives. Returns how many were removed.
        A pass whose cron lookups fail keeps those receipts and logs one line
        with their count and error classes, not one line per receipt.
        """
        with self._store.read() as conn:
            snapshot = conn.execute("SELECT * FROM reminder_receipts").fetchall()
        removed = 0
        failed: list[str] = []  # the error class of each lookup that failed
        for row in snapshot:
            if now - row["updated_at"] <= REMINDER_MAX_IDLE_SECONDS and not self._job_is_gone(row, failed):
                continue
            with self._store.transaction() as conn:
                cursor = conn.execute(
                    "DELETE FROM reminder_receipts WHERE id = ? AND version = ?", (row["id"], row["version"]),
                )
            removed += cursor.rowcount
        if failed:
            logger.warning("reminders: the cron lookup failed for %d receipt(s) (%s); keeping them",
                           len(failed), ", ".join(sorted(set(failed))))
        return removed

    def _decide(self, fresh: dict) -> tuple[str, sqlite3.Row]:
        """One transaction: claim a new receipt, or pick the next step for an existing one."""
        now = self._clock()
        with self._store.transaction() as conn:
            row = _get(conn, fresh["id"])
            if row is None:
                conn.execute(
                    "INSERT INTO reminder_receipts (id, request_id, profile, state, job_id, job_name, "
                    "timezone_advisory, payload_hash, prompt_hash, version, created_at, updated_at) "
                    "VALUES (:id, :request_id, :profile, 'creating', NULL, :job_name, :timezone_advisory, "
                    ":payload_hash, :prompt_hash, 1, :now, :now)",
                    {**fresh, "now": now},
                )
                # A fresh claim's receipt id is deterministic (the request id, or
                # else the payload hash), so its job name is too: a prior job by
                # that name can still be alive even though this row is brand new
                # (the receipt that named it was pruned, or its creator died
                # after create_job actually succeeded). Reconcile by name first
                # instead of calling create_job blindly, so a repeat of an
                # already-satisfied request adopts the surviving job instead of
                # making a second one.
                return "reconcile", _get(conn, fresh["id"])
            if row["payload_hash"] != fresh["payload_hash"]:
                return "conflict", row
            if row["state"] == CREATED:
                return "verify", row
            if row["state"] == CREATING and now - row["updated_at"] < IN_FLIGHT_SECONDS:
                return "wait", row
            return "reconcile", _swap(conn, row, state=CREATING, job_id=None, now=now)

    def _create(self, row, schedule: str, prompt: str) -> ReminderOutcome:
        try:
            job = self._cron.create_job(row["profile"], schedule=schedule, prompt=prompt, name=row["job_name"])
        except Exception as exc:
            # Class name only: an adapter error can carry a response body with prompt text.
            logger.warning("reminders: create_job for receipt %r failed (%s)", row["id"], type(exc).__name__)
            return self._settle(row, UNCERTAIN, None, "uncertain")
        job_id = job.get("id") if isinstance(job, dict) else None
        if not job_id:
            logger.warning("reminders: create_job for receipt %r returned no job id", row["id"])
            return self._settle(row, UNCERTAIN, None, "uncertain")
        return self._settle(row, CREATED, str(job_id), "created")

    def _verify(self, row, schedule: str, prompt: str) -> ReminderOutcome | None:
        """Trust a ``created`` receipt only while cron still has its job (see :func:`_counts_as_gone`)."""
        try:
            gone = _counts_as_gone(row, self._cron.get_job(row["profile"], row["job_id"]))
        except Exception as exc:
            logger.warning("reminders: lookup of job %r failed (%s); keeping the receipt", row["job_id"], type(exc).__name__)
            gone = False
        if gone:
            with self._store.transaction() as conn:
                claimed = _swap(conn, row, state=CREATING, job_id=None, now=self._clock())
            if claimed is None:
                return None
            logger.info("reminders: job %r of receipt %r is gone; creating it again", row["job_id"], row["id"])
            return self._create(claimed, schedule, prompt)
        with self._store.transaction() as conn:
            # A use restarts the idle clock and bumps the version, so a
            # retention sweep that read the receipt earlier cannot delete it.
            cursor = conn.execute(
                "UPDATE reminder_receipts SET version = version + 1, updated_at = ? "
                "WHERE id = ? AND state = ? AND job_id = ?",
                (self._clock(), row["id"], CREATED, row["job_id"]),
            )
            touched = _get(conn, row["id"]) if cursor.rowcount == 1 else None
        return ReminderOutcome("existing", _view(touched)) if touched is not None else None

    def _wait(self, row) -> ReminderOutcome | None:
        """Another request is inside create_job: wait for its answer, then decide again."""
        deadline = time.monotonic() + IN_FLIGHT_WAIT_SECONDS
        while time.monotonic() < deadline:
            time.sleep(POLL_SECONDS)
            current = self._read(row["id"])
            if current is None or current["version"] != row["version"]:
                return None
        return ReminderOutcome("uncertain", _view(row))

    def _reconcile(self, row, schedule: str, prompt: str) -> ReminderOutcome:
        """Find the job a fresh claim, an uncertain receipt, or an abandoned create
        may already have, by its name -- unique per receipt and payload."""
        try:
            job_ids = self._cron.find_job_ids_by_name(row["profile"], row["job_name"])
        except Exception as exc:
            logger.warning("reminders: cannot reconcile receipt %r (%s)", row["id"], type(exc).__name__)
            return self._settle(row, UNCERTAIN, None, "uncertain")
        if row["request_id"] is None:
            # The same rule as _verify: a job this receipt's payload made and
            # Hermes already ran is not its reminder.
            job_ids = [job_id for job_id in job_ids if not self._job_counts_as_gone(row, job_id)]
        if len(job_ids) == 1:
            return self._settle(row, CREATED, str(job_ids[0]), "existing")
        if not job_ids:
            return self._create(row, schedule, prompt)
        logger.warning("reminders: %d cron jobs carry the name of receipt %r", len(job_ids), row["id"])
        return self._settle(row, UNCERTAIN, None, "uncertain")

    def _job_counts_as_gone(self, row, job_id: str) -> bool:
        """:func:`_counts_as_gone` for ``job_id``; False when cron cannot tell."""
        try:
            return _counts_as_gone(row, self._cron.get_job(row["profile"], job_id))
        except Exception as exc:
            logger.warning("reminders: lookup of job %r failed (%s); keeping it as a match", job_id, type(exc).__name__)
            return False

    def _settle(self, row, state: str, job_id: str | None, status: str) -> ReminderOutcome:
        with self._store.transaction() as conn:
            settled = _swap(conn, row, state=state, job_id=job_id, now=self._clock())
        if settled is not None:
            return ReminderOutcome(status, _view(settled))
        current = self._current(row)
        logger.warning("reminders: receipt %r changed while its cron call ran", row["id"])
        return ReminderOutcome("existing" if current["state"] == CREATED else "uncertain", _view(current))

    def _read(self, receipt_id: str) -> sqlite3.Row | None:
        with self._store.read() as conn:
            return _get(conn, receipt_id)

    def _current(self, row) -> dict:
        """The receipt as stored now; ``row`` marked uncertain when it was deleted meanwhile."""
        current = self._read(row["id"])
        return dict(current) if current is not None else {**dict(row), "state": UNCERTAIN}

    def _job_is_gone(self, row, failed: list[str]) -> bool:
        """True only when cron positively reports the job of a ``created`` receipt as absent.

        A lookup that raises keeps the receipt; its error class goes into ``failed`` for :meth:`prune` to log.
        """
        if row["state"] != CREATED:
            return False
        try:
            return self._cron.get_job(row["profile"], row["job_id"]) is None
        except CronUnavailable:
            return False
        except Exception as exc:
            failed.append(type(exc).__name__)
            return False
