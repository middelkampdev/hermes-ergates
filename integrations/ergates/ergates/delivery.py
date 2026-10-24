"""Push delivery for attention events: the ntfy request, the deep link, and the leased outbox worker.

:class:`DeliveryWorker` sends the ``attention_outbox`` rows that
:class:`~ergates.attention.AttentionService` committed with each event. A
worker first claims a row -- a :data:`LEASE_SECONDS` lease taken inside a
store transaction -- and no other worker (a hook's background thread,
``python -m ergates.flush``, a second flush) claims it while the lease
holds. Push is at least once, which docs/11 section 4.2 allows: a worker
that dies mid-send leaves a lease that runs out, and the next worker sends
the row again; and :meth:`DeliveryWorker.run_due` leases a whole batch at
once, so when sending the batch takes longer than :data:`LEASE_SECONDS`, a
second worker can claim and send its later rows too.

Bookkeeping stays on the outbox row: attempts, backoff (30 s, 120 s, 600 s,
then 600 s) and give-up after five attempts. A completion retry that would
land inside the profile's quiet hours waits until they end, read in the
Hermes timezone like the first attempt; an approval retry ignores quiet
hours. The event's own ``state`` is never written here, so a failed
delivery can never overwrite a resolution. An approval that is no longer
pending, or past its ``expires_at``, is cancelled instead of sent: its push
would point the operator at a request that can no longer be answered.

The stock Hermes ntfy adapter never sets a ``Click`` header;
:func:`build_ntfy_publish` builds the full request -- ``Title``, ``Click``,
``Priority``, ``X-Tags`` and a fixed body -- without sending it. The body is
always ``You have a new request``: a push carries identifiers and a generic
title, never a command, a prompt or an approval decision (docs/04 sections
6-7). The event id goes out as ntfy's ``X-Sequence-ID``: a push sent again
after a lost answer is the same event, and an ntfy client that supports
sequence ids (the Android app from 1.22.2 with server 2.16.0 or later; not
the iOS app as of 1.7.0) replaces the first notification instead of showing
a second one. The app opens the same chat from either notification.

:func:`send_ntfy` posts only to an ``http://`` or ``https://`` URL and
follows no redirect. urllib would copy the ``Authorization`` header to
whatever host a redirect names, and on 301, 302 and 303 turn the POST into a
GET on the topic, which ntfy answers with its subscribe stream. A redirect
fails the attempt instead, and the outbox records it by error class. A
``ntfy.server`` with any other scheme turns push off (:func:`ntfy_settings`).
"""

from __future__ import annotations

import base64
import logging
import os
import re
import socket
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import tzinfo
from typing import Any, Callable, Mapping, Optional

from .attention import APPROVAL, COMPLETION, PENDING, effective_prefs, quiet_until
from .hermes_adapter import configured_timezone
from .store import ControlStore

logger = logging.getLogger(__name__)

GENERIC_BODY = "You have a new request"
APPROVAL_TITLE = "Hermes needs your approval"
COMPLETION_TITLE = "A routine finished"
_TITLES = {APPROVAL: APPROVAL_TITLE, COMPLETION: COMPLETION_TITLE}
_ECHO_TAG = "hermes-agent"

# ntfy's rule for a sequence id (server/server.go `sequenceIDRegex`); anything else is a 400.
_SEQUENCE_ID_RE = re.compile(r"^[-_A-Za-z0-9]{1,64}$")

# Plain http stays allowed: an owner may run ntfy on the same host or on a private network.
ALLOWED_SCHEMES = frozenset({"http", "https"})

RETRY_BACKOFF_SECONDS: tuple[int, ...] = (30, 120, 600)
MAX_ATTEMPTS = 5
LEASE_SECONDS = 60


@dataclass(frozen=True)
class NtfySettings:
    server: str
    topic: str
    token: str = field(default="", repr=False)
    connection_id: str = ""


def is_http_url(url: str) -> bool:
    """True for an ``http://`` or ``https://`` URL with a host, the only kind :func:`send_ntfy` opens."""
    parts = urllib.parse.urlsplit(url)
    return parts.scheme.lower() in ALLOWED_SCHEMES and bool(parts.netloc)


def ntfy_settings(values: Mapping[str, Any]) -> NtfySettings | None:
    """Settings from ``ntfy.*`` values; ``None`` (push disabled) unless ``server`` and ``topic`` are set
    and ``server`` is an ``http://`` or ``https://`` URL.

    A server of any other kind (``file://``, ``ftp://``, no scheme at all)
    is logged once per call, without the value: a URL can carry a user name
    or a token.
    """
    def text(key: str) -> str:
        value = values.get(key)
        return value.strip() if isinstance(value, str) else ""

    server, topic = text("server"), text("topic")
    if not server or not topic:
        return None
    if not is_http_url(server):
        logger.warning("delivery: ntfy.server is not an http:// or https:// URL; push is off")
        return None
    return NtfySettings(server=server, topic=topic, token=text("token"), connection_id=text("connection_id"))


def deep_link(session_id: str, connection_id: str, profile: str) -> str:
    """``ergates://chat/<session>?connection=<id>&profile=<name>``, values url-encoded.

    Opening this link only ever leads to connection selection for an unknown
    ``connection_id``; it never makes the app trust a supplied URL.
    """
    path = urllib.parse.quote(str(session_id), safe="")
    query = urllib.parse.urlencode({"connection": connection_id, "profile": profile})
    return f"ergates://chat/{path}?{query}"


def _authorization_header(token: str) -> dict[str, str]:
    token = (token or "").strip()
    if not token:
        return {}
    if ":" in token:
        encoded = base64.b64encode(token.encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {encoded}"}
    return {"Authorization": f"Bearer {token}"}


def build_ntfy_publish(
    server: str, topic: str, token: str, *, title: str, click_url: str, event_id: str,
) -> dict[str, Any]:
    """Build (never send) an ntfy publish request: ``{"url", "headers", "body", "event_id"}``."""
    headers: dict[str, str] = {}
    headers.update(_authorization_header(token))
    headers["Title"] = title
    headers["Click"] = click_url
    headers["X-Tags"] = _ECHO_TAG
    headers["Priority"] = "default"
    # fullmatch: ``$`` also matches before a final newline, which would put a
    # line break in a header value.
    if _SEQUENCE_ID_RE.fullmatch(event_id or ""):
        headers["X-Sequence-ID"] = event_id
    return {"url": f"{server.rstrip('/')}/{topic}", "headers": headers, "body": GENERIC_BODY, "event_id": event_id}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Follows no redirect: the 3xx answer then raises ``HTTPError`` (see the module docstring)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 - urllib's hook
        return None


def send_ntfy(spec: dict[str, Any], *, timeout: float = 3.0) -> None:
    """The runtime transport for :func:`build_ntfy_publish` output: one plain HTTP POST.

    Standard library only. Raises ``ValueError``, and opens nothing, for a
    URL that is not ``http://`` or ``https://``; a redirect raises
    ``HTTPError`` and is never followed. The socket timeout is short on
    purpose: a failed push is retried from the outbox, while a blocked
    thread is not free.
    """
    if not is_http_url(spec["url"]):
        raise ValueError("ntfy publishes only to an http:// or https:// URL")
    request = urllib.request.Request(
        spec["url"], data=spec["body"].encode("utf-8"), headers=spec["headers"], method="POST",
    )
    with urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout) as response:  # noqa: S310
        response.read()


def backoff_seconds(attempts: int) -> int:
    """Delay before the next attempt after ``attempts`` failures: 30, 120, 600, then 600."""
    return RETRY_BACKOFF_SECONDS[min(attempts - 1, len(RETRY_BACKOFF_SECONDS) - 1)]


class DeliveryWorker:
    """Claims due outbox rows with a lease, publishes them, and records the outcome on the row."""

    def __init__(
        self, store: ControlStore, publish: Callable[[dict], None], settings: NtfySettings, *,
        clock: Callable[[], float] = time.time, owner: str | None = None,
        zone: Callable[[], Optional[tzinfo]] = configured_timezone,
    ) -> None:
        self._store = store
        self._publish = publish
        self._settings = settings
        self._clock = clock
        self._zone = zone
        self._owner = owner or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"

    def deliver(self, event_id: str) -> bool:
        """One immediate attempt for the due push of ``event_id``. True when it was sent."""
        sent = False
        for row in self._claim(event_id=event_id, limit=1):
            sent = self._attempt(row)
        return sent

    def run_due(self, *, limit: int = 20) -> int:
        """Attempt up to ``limit`` due, unleased outbox rows. Returns how many were attempted."""
        claimed = self._claim(event_id=None, limit=limit)
        for row in claimed:
            self._attempt(row)
        return len(claimed)

    def _claim(self, *, event_id: str | None, limit: int) -> list[dict]:
        now = self._clock()
        with self._store.transaction() as conn:
            conn.execute(
                "UPDATE attention_outbox SET state = 'cancelled', lease_owner = NULL, lease_until = NULL, "
                "updated_at = ? WHERE state = 'due' AND event_id IN (SELECT id FROM attention_events "
                "WHERE kind = ? AND (state != ? OR expires_at <= ?))",
                (now, APPROVAL, PENDING, now),
            )
            query = (
                "SELECT o.event_id, o.attempts, e.kind, e.profile, e.session_id "
                "FROM attention_outbox o JOIN attention_events e ON e.id = o.event_id "
                "WHERE o.state = 'due' AND o.next_attempt_at <= ? AND (o.lease_until IS NULL OR o.lease_until <= ?)"
            )
            params: list[Any] = [now, now]
            if event_id is not None:
                query += " AND o.event_id = ?"
                params.append(event_id)
            query += " ORDER BY o.next_attempt_at, o.event_id LIMIT ?"
            params.append(limit)
            claimed = [dict(row) for row in conn.execute(query, params)]
            for row in claimed:
                conn.execute(
                    "UPDATE attention_outbox SET lease_owner = ?, lease_until = ?, updated_at = ? WHERE event_id = ?",
                    (self._owner, now + LEASE_SECONDS, now, row["event_id"]),
                )
        return claimed

    def _attempt(self, row: dict) -> bool:
        settings = self._settings
        spec = build_ntfy_publish(
            settings.server, settings.topic, settings.token,
            title=_TITLES[row["kind"]],
            click_url=deep_link(row["session_id"] or "", settings.connection_id, row["profile"] or ""),
            event_id=row["event_id"],
        )
        try:
            self._publish(spec)
        except Exception as exc:
            # Class name only: an HTTP error can echo headers, and the token is one of them.
            logger.info("delivery: push for event %s failed (%s)", row["event_id"], type(exc).__name__)
            self._finish(row, error=type(exc).__name__)
            return False
        self._finish(row, error=None)
        return True

    def _finish(self, row: dict, *, error: str | None) -> None:
        now = self._clock()
        attempts = row["attempts"] + 1
        if error is None:
            state, next_attempt_at = "sent", None
        elif attempts >= MAX_ATTEMPTS:
            state, next_attempt_at = "gave_up", None
        else:
            state, next_attempt_at = "due", now + backoff_seconds(attempts)
        quiet_hours_apply = state == "due" and row["kind"] == COMPLETION
        # Asked before the write lock: Hermes may read its config.yaml to answer.
        zone = self._zone() if quiet_hours_apply else None
        with self._store.transaction() as conn:
            if quiet_hours_apply:
                prefs = effective_prefs(conn, row["profile"])
                next_attempt_at = quiet_until(
                    next_attempt_at, prefs["quiet_start"], prefs["quiet_end"], zone,
                ) or next_attempt_at
            # "state = 'due' AND lease_owner = ?": a resolution, an expiry, or a
            # worker that took over an expired lease wins over this outcome.
            conn.execute(
                "UPDATE attention_outbox SET state = ?, attempts = ?, "
                "next_attempt_at = COALESCE(?, next_attempt_at), last_error = ?, lease_owner = NULL, "
                "lease_until = NULL, updated_at = ? WHERE event_id = ? AND state = 'due' AND lease_owner = ?",
                (state, attempts, next_attempt_at, error, now, row["event_id"], self._owner),
            )
