"""Tests for ergates.store: the transactional SQLite control store."""

from __future__ import annotations

import os
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from conftest import rows
from ergates import store as store_module
from ergates.store import MIGRATIONS, SCHEMA_VERSION, ControlStore, StoreError, root_run_would_break

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
TABLES = {
    "reminder_receipts", "proposal_receipts", "proposal_steps",
    "attention_events", "attention_outbox", "attention_prefs",
}


def _add_prefs(conn: sqlite3.Connection, profile: str, now: float = 1.0) -> None:
    conn.execute(
        "INSERT INTO attention_prefs (profile, muted, updated_at) VALUES (?, 0, ?)", (profile, now),
    )


def test_a_new_store_is_at_the_current_schema_version(store):
    assert SCHEMA_VERSION == 1 == len(MIGRATIONS)
    assert store.schema_version == SCHEMA_VERSION


def test_a_new_store_has_every_table(store):
    with store.read() as conn:
        names = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert names == TABLES


def test_the_store_runs_in_wal_mode(store):
    with store.read() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_a_commit_asks_sqlite_to_flush_the_drive_not_just_the_os_cache(store):
    """On macOS, fsync() alone does not survive a power loss (man 2 fsync);
    only F_FULLFSYNC does, and SQLite issues it only when PRAGMA fullfsync is
    on. Without this, PRAGMA synchronous = FULL is not the durability
    guarantee it looks like."""
    with store.transaction() as conn:
        assert conn.execute("PRAGMA fullfsync").fetchone()[0] == 1


def test_the_store_file_and_folder_are_private(store):
    assert stat.S_IMODE(os.stat(store.path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(store.path.parent).st_mode) == 0o700


HERMES_OWNER = (4242, 4343)


@pytest.fixture
def as_root(tmp_path, monkeypatch):
    """This process runs as root, and the Hermes root ``tmp_path`` belongs to ``HERMES_OWNER``.

    Returns the list of ``(path, uid, gid)`` calls to ``os.chown``, which is
    recorded instead of run.
    """
    real_stat = os.stat

    def stat_with_hermes_owner(path, *args, **kwargs):
        result = real_stat(path, *args, **kwargs)
        if not isinstance(path, (str, os.PathLike)) or Path(path) != tmp_path:
            return result
        values = list(result)
        values[4], values[5] = HERMES_OWNER
        return os.stat_result(values)

    calls: list[tuple[Path, int, int]] = []
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(os, "stat", stat_with_hermes_owner)
    monkeypatch.setattr(os, "chown", lambda path, uid, gid: calls.append((Path(path), uid, gid)))
    return calls


def test_a_store_created_by_root_belongs_to_the_owner_of_the_hermes_root(tmp_path, as_root):
    """A root `docker compose exec ... python -m ergates.flush` that runs before
    any Hermes service must not leave a store the `hermes` user cannot open."""
    path = tmp_path / "ergates" / "control.sqlite3"

    ControlStore(path)

    assert as_root == [(path.parent, *HERMES_OWNER), (path, *HERMES_OWNER)]


def test_root_also_hands_over_the_wal_files_sqlite_created_in_that_call(tmp_path, as_root, monkeypatch):
    """Another connection that stays open keeps -wal and -shm on disk after the store is created."""
    path = tmp_path / "ergates" / "control.sqlite3"
    keeper: list[sqlite3.Connection] = []
    use_wal = ControlStore._use_wal

    def use_wal_then_hold_the_file_open(self, conn):
        use_wal(self, conn)
        keeper.append(sqlite3.connect(path))
        keeper[0].execute("SELECT count(*) FROM sqlite_master").fetchone()

    monkeypatch.setattr(ControlStore, "_use_wal", use_wal_then_hold_the_file_open)
    try:
        ControlStore(path)
        wal, shm = (path.with_name(path.name + suffix) for suffix in ("-wal", "-shm"))
        assert wal.exists() and shm.exists()
    finally:
        keeper[0].close()

    assert as_root == [(path.parent, *HERMES_OWNER), (path, *HERMES_OWNER), (wal, *HERMES_OWNER),
                       (shm, *HERMES_OWNER)]


def test_a_file_that_vanished_before_its_chown_is_skipped(tmp_path, monkeypatch):
    """A -wal or -shm file disappears when the last connection closes."""
    monkeypatch.setattr(os, "geteuid", lambda: 0)

    def chown_a_vanished_file(path, uid, gid):
        raise FileNotFoundError(path)

    monkeypatch.setattr(os, "chown", chown_a_vanished_file)

    assert ControlStore(tmp_path / "ergates" / "control.sqlite3").schema_version == SCHEMA_VERSION


def test_root_without_the_right_to_change_owners_warns_and_continues(tmp_path, as_root, monkeypatch, caplog):
    """A rootless container's root has no CAP_CHOWN. Hermes's own container setup
    warns and continues when its chown fails; so does the store."""
    def chown_refused(path, uid, gid):
        raise PermissionError(1, "Operation not permitted")

    monkeypatch.setattr(os, "chown", chown_refused)

    assert ControlStore(tmp_path / "ergates" / "control.sqlite3").schema_version == SCHEMA_VERSION
    assert "could not hand ergates to the Hermes user (PermissionError)" in caplog.text
    assert str(tmp_path) not in caplog.text


def test_a_root_run_breaks_only_a_hermes_root_that_another_user_owns(tmp_path, as_root, monkeypatch):
    """SQLite creates -wal and -shm as the user that opens the store and does not
    hand them over, so root must not open a store the Hermes user owns."""
    assert root_run_would_break(tmp_path) is True

    real_stat = os.stat

    def owned_by_root(path, *args, **kwargs):
        values = list(real_stat(path, *args, **kwargs))
        values[4] = values[5] = 0
        return os.stat_result(values)

    monkeypatch.setattr(os, "stat", owned_by_root)
    assert root_run_would_break(tmp_path) is False  # root owns the Hermes root, so root is the Hermes user

    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    assert root_run_would_break(tmp_path) is False

    monkeypatch.delattr(os, "geteuid")
    assert root_run_would_break(tmp_path) is False


def test_a_store_created_by_another_user_changes_no_owner(tmp_path, as_root, monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: 1000)

    ControlStore(tmp_path / "ergates" / "control.sqlite3")

    assert as_root == []


def test_a_platform_without_geteuid_changes_no_owner(tmp_path, as_root, monkeypatch):
    monkeypatch.delattr(os, "geteuid")

    ControlStore(tmp_path / "ergates" / "control.sqlite3")

    assert as_root == []


def test_root_leaves_an_existing_store_alone(tmp_path, monkeypatch):
    path = tmp_path / "ergates" / "control.sqlite3"
    ControlStore(path)
    calls = []
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setattr(os, "chown", lambda *args: calls.append(args))

    ControlStore(path)

    assert calls == []


def test_root_leaves_an_existing_folder_alone_and_hands_over_only_the_new_file(tmp_path, as_root):
    path = tmp_path / "ergates" / "control.sqlite3"
    path.parent.mkdir()

    ControlStore(path)

    assert as_root == [(path, *HERMES_OWNER)]


def test_reopening_keeps_the_data_and_does_not_migrate_again(store):
    with store.transaction() as conn:
        _add_prefs(conn, "thijs")

    again = ControlStore(store.path)

    assert again.schema_version == SCHEMA_VERSION
    assert [row["profile"] for row in rows(again, "attention_prefs")] == ["thijs"]


def test_a_schema_written_by_a_newer_plugin_is_refused(store):
    with store.transaction() as conn:
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")

    with pytest.raises(StoreError, match="upgrade the plugin"):
        ControlStore(store.path)


def test_a_failing_migration_leaves_an_empty_file_at_version_zero(tmp_path, monkeypatch):
    broken = ((*MIGRATIONS[0], "CREATE TABLE attention_prefs (profile TEXT)"),)
    monkeypatch.setattr(store_module, "MIGRATIONS", broken)
    path = tmp_path / "ergates" / "control.sqlite3"

    with pytest.raises(sqlite3.OperationalError, match="already exists"):
        ControlStore(path)

    monkeypatch.undo()
    reopened = ControlStore(path)
    assert reopened.schema_version == SCHEMA_VERSION


def test_a_transaction_commits_on_success(store):
    with store.transaction() as conn:
        _add_prefs(conn, "thijs")

    assert len(rows(store, "attention_prefs")) == 1


def test_a_transaction_rolls_back_on_an_error(store):
    with pytest.raises(RuntimeError):
        with store.transaction() as conn:
            _add_prefs(conn, "thijs")
            raise RuntimeError("boom")

    assert rows(store, "attention_prefs") == []


def test_a_read_cannot_write(store):
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        with store.read() as conn:
            _add_prefs(conn, "thijs")


def test_a_read_sees_one_snapshot_while_another_writer_commits(store):
    with store.read() as conn:
        before = conn.execute("SELECT COUNT(*) FROM attention_prefs").fetchone()[0]
        writer = threading.Thread(target=lambda: _write_one(store, "nora"))
        writer.start()
        writer.join()
        during = conn.execute("SELECT COUNT(*) FROM attention_prefs").fetchone()[0]

    assert (before, during) == (0, 0)
    assert len(rows(store, "attention_prefs")) == 1


def _write_one(store: ControlStore, profile: str) -> None:
    with store.transaction() as conn:
        _add_prefs(conn, profile)


def test_begin_immediate_serializes_read_modify_write_across_threads(store):
    """Each writer reads a counter, then writes it back plus one. With the write
    lock taken at BEGIN, no increment is lost."""
    with store.transaction() as conn:
        _add_prefs(conn, "counter", now=0.0)
    barrier = threading.Barrier(8)

    def bump() -> None:
        barrier.wait()
        for _ in range(25):
            with store.transaction() as conn:
                value = conn.execute("SELECT updated_at FROM attention_prefs").fetchone()[0]
                conn.execute("UPDATE attention_prefs SET updated_at = ?", (value + 1,))

    threads = [threading.Thread(target=bump) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert rows(store, "attention_prefs")[0]["updated_at"] == 200


def test_a_second_writer_waits_for_the_first_instead_of_failing(store):
    """A flush holds the write lock while a hook writes: the hook waits, then commits."""
    holding = threading.Event()
    finished = []

    def slow_writer() -> None:
        with store.transaction() as conn:
            _add_prefs(conn, "first")
            holding.set()
            time.sleep(0.5)

    first = threading.Thread(target=slow_writer)
    first.start()
    assert holding.wait(timeout=5)
    started = time.monotonic()
    with store.transaction() as conn:
        _add_prefs(conn, "second")
        finished.append(time.monotonic() - started)
    first.join()

    assert finished[0] >= 0.3
    assert sorted(row["profile"] for row in rows(store, "attention_prefs")) == ["first", "second"]


def test_a_writer_gives_up_after_its_busy_timeout(store):
    impatient = ControlStore(store.path, busy_timeout_ms=50)
    holding = threading.Event()
    release = threading.Event()

    def holder() -> None:
        with store.transaction():
            holding.set()
            release.wait(timeout=5)

    thread = threading.Thread(target=holder)
    thread.start()
    assert holding.wait(timeout=5)
    try:
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            with impatient.transaction():
                pass
    finally:
        release.set()
        thread.join()


def test_two_processes_open_a_fresh_store_at_the_same_moment(tmp_path):
    """The gateway and `hermes serve` start together on a new install."""
    path = tmp_path / "ergates" / "control.sqlite3"
    go = tmp_path / "go"
    script = (
        "import sys, time, pathlib\n"
        "from ergates.store import ControlStore\n"
        "go = pathlib.Path(sys.argv[2])\n"
        "while not go.exists():\n"
        "    time.sleep(0.001)\n"
        "print(ControlStore(sys.argv[1]).schema_version)\n"
    )
    env = {**os.environ, "PYTHONPATH": str(PACKAGE_ROOT)}
    workers = [
        subprocess.Popen(
            [sys.executable, "-c", script, str(path), str(go)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )
        for _ in range(2)
    ]
    time.sleep(0.3)
    go.touch()
    results = [worker.communicate(timeout=30) for worker in workers]

    assert [worker.returncode for worker in workers] == [0, 0], results
    assert [out.strip() for out, _err in results] == ["1", "1"]


def test_a_closed_store_refuses_further_use(store):
    store.close()

    with pytest.raises(StoreError, match="closed"):
        with store.transaction():
            pass
    with pytest.raises(StoreError, match="closed"):
        with store.read():
            pass


def test_foreign_keys_are_enforced(store):
    with pytest.raises(sqlite3.IntegrityError):
        with store.transaction() as conn:
            conn.execute(
                "INSERT INTO attention_outbox (event_id, state, next_attempt_at, updated_at) "
                "VALUES ('no-such-event', 'due', 1.0, 1.0)"
            )


def test_no_table_has_a_column_for_user_content(store):
    """docs/04 sections 4 and 8: the store keeps hashes, never prompt, command,
    briefing or description text. The schema has nowhere to put them."""
    forbidden = {"prompt", "command", "briefing", "description", "body", "text", "message"}
    with store.read() as conn:
        columns = {
            (table, row["name"])
            for table in TABLES
            for row in conn.execute(f"PRAGMA table_info({table})")
        }
    assert not {column for _table, column in columns} & forbidden
