"""The periodic sweep inside ``hermes serve``: one daemon thread that runs a pass every interval.

Nothing in Hermes runs a timer for a plugin, so ``dashboard/api.py`` starts a
:class:`Sweep` when Hermes imports it (at server start or on the first
request after an install). Only a process that loads Hermes's dashboard
server imports that file; the gateway and cron processes load only the
plugin's hooks and start no sweep. Each pass is ``flush.sweep_once``, the
same work as ``python -m ergates.flush``: due pushes, expiry and retention.

Several sweeps may run on one store at once (a leftover host cron line,
Hermes Desktop and ``hermes serve`` on one root, or one plugin host per
profile under ``plugins.isolation: host``). That is safe: every write takes
the store's write lock, and the outbox lease keeps a due push from being sent
twice (:class:`~ergates.delivery.DeliveryWorker`).

A pass that raises never stops the thread. Its error class is kept for
``status()``, which ``GET /health`` reports, and logged once until a pass of
another class fails or a pass succeeds; the message is never logged, because
it can carry a path. A store that a newer plugin made read-only fails every
pass with ``StoreReadOnly``, and the pass writes nothing, until this install
runs that newer plugin.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Mapping, Optional

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 120
SWEEP_FIRST_DELAY_SECONDS = 5
THREAD_NAME = "ergates-sweep"


class Sweep:
    """Runs ``run_once`` on a daemon thread, ``first_delay`` seconds after ``start()`` and then every ``interval``."""

    def __init__(
        self, run_once: Callable[[], Mapping[str, int]], *, interval: float,
        first_delay: float = SWEEP_FIRST_DELAY_SECONDS, clock: Callable[[], float] = time.time,
    ) -> None:
        self._run_once = run_once
        self._interval = interval
        self._first_delay = first_delay
        self._clock = clock
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._last_run_at: Optional[float] = None
        self._last_error: Optional[str] = None

    def start(self) -> bool:
        """Start the thread. False, and nothing started, when ``interval <= 0`` (the sweep is off) or it already runs."""
        with self._lock:
            if self._interval <= 0 or self._thread is not None:
                return False
            thread = threading.Thread(target=self._loop, name=THREAD_NAME, daemon=True)
            thread.start()
            self._thread = thread
            return True

    def stop(self, timeout: float = 5.0) -> None:
        """End the thread: wake its wait, then wait up to ``timeout`` seconds for a pass in progress to end."""
        self._stopping.set()
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout)

    def status(self) -> dict:
        """``interval_seconds``, ``last_run_at`` (when the last pass ended, or ``None``) and ``last_error``
        (that pass's error class, or ``None`` when it succeeded)."""
        with self._lock:
            return {"interval_seconds": int(self._interval), "last_run_at": self._last_run_at,
                    "last_error": self._last_error}

    def _loop(self) -> None:
        delay = self._first_delay
        # A wait longer than the platform's timer limit raises OverflowError, so cap it.
        while not self._stopping.wait(min(delay, threading.TIMEOUT_MAX)):
            self._run()
            delay = self._interval

    def _run(self) -> None:
        try:
            self._run_once()
        except Exception as exc:
            error: Optional[str] = type(exc).__name__
        else:
            error = None
        with self._lock:
            if error is not None and error != self._last_error:
                logger.warning("ergates: a periodic sweep pass failed (%s); the next pass runs as planned", error)
            self._last_run_at = self._clock()
            self._last_error = error
