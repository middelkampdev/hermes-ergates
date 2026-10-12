"""Shared fixtures: a control store in a temporary Hermes root, a settable clock, a fake cron."""

from __future__ import annotations

import os
import sys
import threading
import types
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from ergates.paths import store_path
from ergates.store import ControlStore


class FakeClock:
    """``clock()`` returns ``clock.now``; tests move it with ``advance``."""

    def __init__(self, start: float = 1_800_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += seconds
        return self.now


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


HERMES_UID = 1000  # the `hermes` user of the Hermes image
OWNER_CHANGES = ("chown", "fchown", "lchown")


@dataclass
class RootRun:
    """What ``as_root`` fakes: the owner of the Hermes root, and every owner change the code under test tried."""

    root_owner: int = HERMES_UID
    owner_changes: list[str] = field(default_factory=list)


@pytest.fixture
def as_root(tmp_path, monkeypatch) -> RootRun:
    """This process runs as root (a fake euid 0), and the Hermes root ``tmp_path`` belongs to ``HERMES_UID``.

    A test sets ``root_owner = 0`` for a Hermes root that root owns. Any
    ``os.chown``, ``os.fchown`` or ``os.lchown`` is recorded and fails the
    test through ``pytest.fail``, a ``BaseException``, so no ``except`` in
    the code under test can swallow it.
    """
    run = RootRun()
    real_stat = os.stat

    def stat_with_the_root_owner(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if not isinstance(path, (str, os.PathLike)) or Path(path) != tmp_path:
            return result
        values = list(result)
        values[4] = values[5] = run.root_owner
        return os.stat_result(values)

    def refuse(name):
        def change_owner(*args, **kwargs):
            run.owner_changes.append(name)
            pytest.fail(f"os.{name} was called: the plugin changes the owner of nothing")
        return change_owner

    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(os, "stat", stat_with_the_root_owner)
    for name in OWNER_CHANGES:
        if hasattr(os, name):
            monkeypatch.setattr(os, name, refuse(name))
    return run


@pytest.fixture
def store(tmp_path):
    """The store of a Hermes root at ``tmp_path``: ``tmp_path/ergates/control.sqlite3``."""
    control = ControlStore(store_path(tmp_path))
    yield control
    control.close()


def rows(store: ControlStore, table: str) -> list[dict]:
    """Every row of ``table`` as a dict, read through the store's own snapshot."""
    with store.read() as conn:
        return [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]


def raw_bytes(store: ControlStore) -> bytes:
    """The database file plus its write-ahead log, exactly as they sit on disk."""
    files = (store.path, store.path.with_name(store.path.name + "-wal"))
    return b"".join(item.read_bytes() for item in files if item.exists())


def hermes_profile_lookup(monkeypatch, lookup) -> None:
    """Stand in for Hermes's ``hermes_cli.profiles.get_active_profile_name``, where the adapter imports it."""
    profiles = types.ModuleType("hermes_cli.profiles")
    profiles.get_active_profile_name = lookup
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", profiles)


class FakeCron:
    """In-memory ``reminders.CronPort``. Records every call; knobs simulate failures and races."""

    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self.create_calls: list[dict] = []
        self.fail_create: str | None = None   # "before": nothing created; "after": created, answer lost
        self.fail_lookup = False
        self.fail_find = False
        self.on_create = None                 # one-shot callable run inside the next create_job
        self.on_get = None                    # one-shot callable run inside the next get_job
        self._lock = threading.Lock()
        self._next = 0

    def _new_id(self) -> str:
        with self._lock:
            self._next += 1
            return f"job-{self._next}"

    def add_job(self, profile: str, name: str) -> str:
        """A job that exists in cron without the service knowing about it."""
        job_id = self._new_id()
        self.jobs[job_id] = {"id": job_id, "profile": profile, "name": name}
        return job_id

    def delete_job(self, job_id: str) -> None:
        """What the Routines screen does through native cron (docs/11 section 4.3)."""
        self.jobs.pop(job_id, None)

    def complete_job(self, job_id: str) -> None:
        """What Hermes does after a one-shot runs: it keeps the job, marked completed, for 7 days."""
        self.jobs[job_id]["completed"] = True

    def create_job(self, profile, *, schedule, prompt, name):
        self.create_calls.append({"profile": profile, "schedule": schedule, "prompt": prompt, "name": name})
        hook, self.on_create = self.on_create, None
        if hook is not None:
            hook()
        if self.fail_create == "before":
            raise ConnectionError("connection refused")
        job_id = self.add_job(profile, name)
        if self.fail_create == "after":
            raise TimeoutError("the answer was lost after the job was created")
        return {"id": job_id}

    def get_job(self, profile, job_id):
        hook, self.on_get = self.on_get, None
        if hook is not None:
            hook()
        if self.fail_lookup:
            raise ConnectionError("cron API unreachable")
        return self.jobs.get(job_id)

    def find_job_ids_by_name(self, profile, name):
        if self.fail_find:
            raise ConnectionError("cron API unreachable")
        return [job["id"] for job in self.jobs.values() if job["profile"] == profile and job["name"] == name]


@pytest.fixture
def cron() -> FakeCron:
    return FakeCron()


def returns_within(seconds, call):
    """What ``call()`` returns; fails the test when it has not returned after ``seconds``, as a blocked open never
    does. The thread is a daemon, so a blocked one does not keep the test run alive."""
    results = []
    worker = threading.Thread(target=lambda: results.append(call()), daemon=True)
    worker.start()
    worker.join(seconds)
    assert not worker.is_alive(), "the call blocked"
    return results[0]
