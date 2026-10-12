"""Tests for ergates.sweep: the periodic sweep thread that ``hermes serve`` runs.

``dashboard/api.py`` starts one ``Sweep`` when Hermes imports it; each run is
``flush.sweep_once``, the same pass ``python -m ergates.flush`` makes. More
than one sweep can run on one store (a leftover host cron line, Hermes
Desktop and ``hermes serve`` on one root, or one plugin host per profile), so
the outbox lease must keep each due push sent once.
"""

from __future__ import annotations

import logging
import threading
import time

import pytest

from conftest import FakeClock, rows
from ergates import flush
from ergates.attention import AttentionService
from ergates.flush import flush_once
from ergates.store import MIN_SCHEMA_KEY, ControlStore
from ergates.sweep import SWEEP_FIRST_DELAY_SECONDS, SWEEP_INTERVAL_SECONDS, Sweep

SETTINGS = {"server": "https://ntfy.example.internal", "topic": "ergates-alerts", "token": "tok",
            "connection_id": "conn-1"}
WAIT_SECONDS = 5.0


@pytest.fixture
def sweeps():
    """``sweeps(run_once, **options)`` builds a ``Sweep``; every one is stopped when the test ends."""
    made: list[Sweep] = []

    def make(run_once, **options) -> Sweep:
        sweep = Sweep(run_once, **options)
        made.append(sweep)
        return sweep

    yield make
    for sweep in made:
        sweep.stop()


def _sweep_threads() -> list[threading.Thread]:
    return [thread for thread in threading.enumerate() if thread.name == "ergates-sweep"]


def _wait_for(condition, timeout: float = WAIT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.005)
    return condition()


class Runs:
    """A ``run_once`` that counts its calls; ``fail_with`` makes the next calls raise."""

    def __init__(self) -> None:
        self.count = 0
        self.fail_with: list[BaseException] = []

    def __call__(self) -> dict:
        self.count += 1
        if self.fail_with:
            raise self.fail_with.pop(0)
        return {"retried": 0}


def test_the_defaults_are_two_minutes_and_five_seconds():
    assert (SWEEP_INTERVAL_SECONDS, SWEEP_FIRST_DELAY_SECONDS) == (120, 5)


def test_the_first_run_comes_after_the_first_delay(sweeps):
    runs = Runs()
    sweep = sweeps(runs, interval=60, first_delay=0.05)

    assert sweep.start() is True
    assert runs.count == 0
    assert sweep.status()["last_run_at"] is None

    assert _wait_for(lambda: runs.count == 1)
    time.sleep(0.1)
    assert runs.count == 1  # the next run waits a whole interval


def test_a_failing_run_is_recorded_by_class_and_the_next_run_still_happens(sweeps, caplog):
    clock = FakeClock()
    runs = Runs()
    runs.fail_with.append(ValueError("/secret/path in the message"))
    allow_the_second_run = threading.Event()

    def run_once():
        if runs.count == 1:
            assert allow_the_second_run.wait(WAIT_SECONDS)
        return runs()

    sweep = sweeps(run_once, interval=0.01, first_delay=0, clock=clock)
    with caplog.at_level(logging.WARNING, logger="ergates.sweep"):
        sweep.start()
        assert _wait_for(lambda: sweep.status()["last_error"] is not None)
        failed = sweep.status()
        clock.advance(120)
        allow_the_second_run.set()
        assert _wait_for(lambda: sweep.status()["last_error"] is None)

    assert (failed["last_run_at"], failed["last_error"]) == (1_800_000_000.0, "ValueError")
    assert sweep.status()["last_run_at"] == 1_800_000_120.0
    assert "ValueError" in caplog.text
    assert "secret" not in caplog.text


def test_a_failure_of_the_same_class_is_logged_once(sweeps, caplog):
    runs = Runs()
    runs.fail_with.extend([OSError("one"), OSError("two"), OSError("three"), KeyError("four")])
    sweep = sweeps(runs, interval=0.005, first_delay=0)

    with caplog.at_level(logging.WARNING, logger="ergates.sweep"):
        sweep.start()
        assert _wait_for(lambda: runs.count >= 5 and sweep.status()["last_error"] is None)

    logged = [record.getMessage() for record in caplog.records if record.name == "ergates.sweep"]
    assert len(logged) == 2
    assert "OSError" in logged[0] and "KeyError" in logged[1]


def test_stop_ends_the_thread_promptly(sweeps):
    runs = Runs()
    sweep = sweeps(runs, interval=60, first_delay=0)
    sweep.start()
    assert _wait_for(lambda: runs.count == 1)

    started = time.monotonic()
    sweep.stop()

    assert time.monotonic() - started < 1.0
    assert _sweep_threads() == []


@pytest.mark.parametrize("interval", [0, -30])
def test_an_interval_of_0_starts_nothing(sweeps, interval):
    runs = Runs()
    sweep = sweeps(runs, interval=interval, first_delay=0)

    assert sweep.start() is False
    time.sleep(0.05)

    assert _sweep_threads() == []
    assert runs.count == 0
    assert sweep.status() == {"interval_seconds": interval, "last_run_at": None, "last_error": None}


def test_start_twice_runs_one_thread(sweeps):
    sweep = sweeps(Runs(), interval=60, first_delay=60)

    assert sweep.start() is True
    assert sweep.start() is False

    threads = _sweep_threads()
    assert len(threads) == 1 and threads[0].daemon


def test_an_interval_too_long_for_a_timer_still_waits_and_stops(sweeps):
    """A typo such as 10**12 seconds: the wait must not raise OverflowError and kill the thread."""
    runs = Runs()
    sweep = sweeps(runs, interval=10**12, first_delay=0)
    sweep.start()
    assert _wait_for(lambda: runs.count == 1)
    time.sleep(0.05)

    assert [thread.is_alive() for thread in _sweep_threads()] == [True]
    sweep.stop()
    assert _sweep_threads() == []


# --- one store, several sweeps ------------------------------------------------


def test_two_sweeps_on_one_store_send_each_due_push_once(store, tmp_path):
    """Two sweeps start their pass at the same moment. The first to claim the due row holds
    its send open until the other pass has ended, so the other one runs while the row is
    leased: it must find nothing to send."""
    AttentionService(store).approval_requested(
        session_key="s1", pattern_key="p1", command="cmd", surface="gateway", profile="thijs")
    barrier = threading.Barrier(2)
    a_pass_ended = threading.Event()
    sent = []
    counts = []

    def publish(spec):
        sent.append(spec["event_id"])
        a_pass_ended.wait(WAIT_SECONDS)

    def sweep():
        barrier.wait(WAIT_SECONDS)
        counts.append(flush_once(tmp_path, SETTINGS, publish=publish)["retried"])
        a_pass_ended.set()

    threads = [threading.Thread(target=sweep) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(2 * WAIT_SECONDS)

    assert len(sent) == 1
    assert sorted(counts) == [0, 1]
    assert [row["state"] for row in rows(store, "attention_outbox")] == ["sent"]


# --- what a pass does when it must not write ------------------------------------


def _move_the_store_on(store):
    """What a newer plugin leaves: schema 4, and only schema 4 or newer may write."""
    with store.transaction() as conn:
        conn.execute("UPDATE store_meta SET value = '4' WHERE key = ?", (MIN_SCHEMA_KEY,))
        conn.execute("PRAGMA user_version = 4")


def test_on_a_store_too_new_each_pass_skips_logs_once_and_the_next_still_runs(store, tmp_path, sweeps, caplog):
    AttentionService(store, clock=lambda: 1.0).approval_requested(
        session_key="s1", pattern_key="p1", command="cmd", surface="gateway", profile="thijs")
    _move_the_store_on(store)
    before = rows(store, "attention_events")
    passes = []

    def run_once():
        passes.append(1)
        return flush.sweep_once(tmp_path)

    sweep = sweeps(run_once, interval=0.005, first_delay=0)
    with caplog.at_level(logging.WARNING):
        sweep.start()
        assert _wait_for(lambda: len(passes) >= 3 and sweep.status()["last_run_at"] is not None)
        sweep.stop()

    assert sweep.status()["last_error"] == "StoreReadOnly"
    assert rows(store, "attention_events") == before  # the expired approval stays as it was
    swept = [record for record in caplog.records if record.name == "ergates.sweep"]
    opened = [record for record in caplog.records if record.name == "ergates.store"]
    assert len(swept) == 1 and "StoreReadOnly" in swept[0].getMessage()
    assert len(opened) == 1


def test_as_root_on_a_hermes_root_another_user_owns_every_pass_writes_nothing(as_root, tmp_path, sweeps):
    """The sweep thread starts, and each pass stops where the store refuses to open, before
    anything is created; ``as_root`` fails the test on any owner change."""
    passes = []

    def run_once():
        passes.append(1)
        return flush.sweep_once(tmp_path)

    sweep = sweeps(run_once, interval=0.005, first_delay=0)
    sweep.start()
    assert _wait_for(lambda: len(passes) >= 3 and sweep.status()["last_error"] is not None)
    sweep.stop()

    assert sweep.status()["last_error"] == "StoreError"
    assert list(tmp_path.iterdir()) == []
    assert as_root.owner_changes == []


def test_a_store_too_new_is_logged_once_by_the_store_however_often_it_is_opened(store, caplog):
    _move_the_store_on(store)

    with caplog.at_level(logging.WARNING, logger="ergates.store"):
        for _ in range(3):
            assert ControlStore(store.path).writable is False

    assert len([record for record in caplog.records if record.name == "ergates.store"]) == 1
