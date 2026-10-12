"""Tests for ergates.store: the transactional SQLite control store."""

from __future__ import annotations

import os
import re
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from conftest import HERMES_UID, rows
from ergates import store as store_module
from ergates.paths import store_path
from ergates.store import (
    MIGRATIONS, MIN_SCHEMA_KEY, ROOT_REFUSAL, SCHEMA_VERSION, ControlStore, Migration, StoreError, StoreReadOnly,
    root_run_would_break,
)

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "ergates"
TABLES = {
    "reminder_receipts", "proposal_receipts", "proposal_steps",
    "attention_events", "attention_outbox", "attention_prefs", "store_meta",
}


def _add_prefs(conn: sqlite3.Connection, profile: str, now: float = 1.0) -> None:
    conn.execute(
        "INSERT INTO attention_prefs (profile, muted, updated_at) VALUES (?, 0, ?)", (profile, now),
    )


def test_a_new_store_is_at_the_current_schema_version(store):
    assert SCHEMA_VERSION == len(MIGRATIONS)
    assert store.schema_version == SCHEMA_VERSION


def test_a_new_store_is_at_schema_2_with_the_oldest_plugin_marker_2(tmp_path):
    store = ControlStore(tmp_path / "s.sqlite3")

    assert (store.schema_version, store.min_schema_version, store.writable) == (2, 2, True)


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


def _tree(folder: Path) -> dict:
    """Every path under ``folder`` with its bytes, ``None`` for a folder."""
    return {path.relative_to(folder): None if path.is_dir() else path.read_bytes() for path in folder.rglob("*")}


@pytest.mark.parametrize("existing_store", [False, True], ids=["fresh root", "existing store"])
def test_root_on_a_hermes_root_another_user_owns_opens_no_store_and_creates_nothing(tmp_path, as_root, monkeypatch,
                                                                                    existing_store):
    """Root writes nothing into a Hermes root another user owns: SQLite would make the -wal and -shm files root's,
    and that user's processes could no longer open the store."""
    if existing_store:
        monkeypatch.setattr(os, "geteuid", lambda: HERMES_UID)
        ControlStore(store_path(tmp_path)).close()
        monkeypatch.setattr(os, "geteuid", lambda: 0)
    before = _tree(tmp_path)

    with pytest.raises(StoreError, match=f"^{re.escape(ROOT_REFUSAL)}$"):
        ControlStore(store_path(tmp_path))

    assert ROOT_REFUSAL == "run hermes serve as the owner of the Hermes root"
    assert _tree(tmp_path) == before
    assert as_root.owner_changes == []


def _root_on_its_own_hermes_root(as_root, monkeypatch):
    as_root.root_owner = 0


def _not_root(as_root, monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: HERMES_UID)


def _no_geteuid(as_root, monkeypatch):
    monkeypatch.delattr(os, "geteuid")


@pytest.mark.parametrize("process", [_root_on_its_own_hermes_root, _not_root, _no_geteuid],
                         ids=["root on a root it owns", "not root", "no geteuid"])
def test_every_other_process_opens_the_store_as_before_and_changes_no_owner(tmp_path, as_root, monkeypatch, process):
    process(as_root, monkeypatch)

    store = ControlStore(store_path(tmp_path))
    with store.transaction() as conn:
        _add_prefs(conn, "thijs")

    assert store.schema_version == SCHEMA_VERSION
    assert stat.S_IMODE(os.lstat(store.path).st_mode) == 0o600
    assert as_root.owner_changes == []


def test_a_root_run_breaks_only_a_hermes_root_that_another_user_owns(tmp_path, as_root, monkeypatch):
    assert root_run_would_break(tmp_path) is True

    as_root.root_owner = 0
    assert root_run_would_break(tmp_path) is False  # root owns the Hermes root, so root is the Hermes user

    assert root_run_would_break(tmp_path / "not-there-yet") is False  # root would make it its own

    monkeypatch.setattr(os, "geteuid", lambda: HERMES_UID)
    assert root_run_would_break(tmp_path) is False

    monkeypatch.delattr(os, "geteuid")
    assert root_run_would_break(tmp_path) is False


def test_root_creates_a_missing_hermes_root_as_its_own(tmp_path, as_root):
    """A root that does not exist yet has no other owner: root makes it, and it is root's."""
    assert ControlStore(store_path(tmp_path / "new-root")).schema_version == SCHEMA_VERSION


def test_reopening_keeps_the_data_and_does_not_migrate_again(store):
    with store.transaction() as conn:
        _add_prefs(conn, "thijs")

    again = ControlStore(store.path)

    assert again.schema_version == SCHEMA_VERSION
    assert [row["profile"] for row in rows(again, "attention_prefs")] == ["thijs"]


def _schema_1_store(path: Path) -> None:
    """The store as plugin 0.2.0 leaves it: schema 1 in WAL mode, with one prefs row for ``thijs``."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("BEGIN")
        for statement in MIGRATIONS[0].statements:
            conn.execute(statement)
        conn.execute("PRAGMA user_version = 1")
        _add_prefs(conn, "thijs")
        conn.execute("COMMIT")
    finally:
        conn.close()


def _file_state(path: Path) -> tuple[int, set[str], list[str]]:
    """``(user_version, table names, attention_prefs profiles)``, read straight from the file."""
    conn = sqlite3.connect(path)
    try:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        profiles = [row[0] for row in conn.execute("SELECT profile FROM attention_prefs")] if tables else []
    finally:
        conn.close()
    return version, tables, profiles


def _store_moved_on_by_a_newer_plugin(path: Path, *, version: int, marker: str | None) -> None:
    """Take the store at ``path`` to ``version`` the way a newer plugin would, with one table this
    plugin does not know. ``marker`` is the new ``min_schema_version`` value; ``None`` leaves it."""
    with ControlStore(path).transaction() as conn:
        conn.execute("CREATE TABLE added_by_a_newer_plugin (value TEXT)")
        if marker is not None:
            conn.execute("UPDATE store_meta SET value = ? WHERE key = ?", (marker, MIN_SCHEMA_KEY))
        conn.execute(f"PRAGMA user_version = {version}")


def test_a_schema_1_store_migrates_to_2_and_keeps_its_rows(tmp_path):
    path = tmp_path / "ergates" / "control.sqlite3"
    _schema_1_store(path)

    store = ControlStore(path)

    assert (store.schema_version, store.min_schema_version, store.writable) == (2, 2, True)
    assert [row["profile"] for row in rows(store, "attention_prefs")] == ["thijs"]


def test_a_failing_migration_leaves_a_schema_1_store_as_it_was(tmp_path, monkeypatch):
    path = tmp_path / "ergates" / "control.sqlite3"
    _schema_1_store(path)
    before = _file_state(path)
    broken_v2 = Migration((*MIGRATIONS[1].statements, "CREATE TABLE attention_prefs (profile TEXT)"))
    monkeypatch.setattr(store_module, "MIGRATIONS", (MIGRATIONS[0], broken_v2))

    with pytest.raises(sqlite3.OperationalError, match="already exists"):
        ControlStore(path)

    assert before == (1, TABLES - {"store_meta"}, ["thijs"])
    assert _file_state(path) == before


def test_a_failing_migration_leaves_an_empty_file_at_version_zero(tmp_path, monkeypatch):
    """Every missing version runs in one transaction: v1 is rolled back with the v2 that failed."""
    broken_v2 = Migration((*MIGRATIONS[1].statements, "CREATE TABLE attention_prefs (profile TEXT)"))
    monkeypatch.setattr(store_module, "MIGRATIONS", (MIGRATIONS[0], broken_v2))
    path = tmp_path / "ergates" / "control.sqlite3"

    with pytest.raises(sqlite3.OperationalError, match="already exists"):
        ControlStore(path)

    assert _file_state(path) == (0, set(), [])
    monkeypatch.undo()
    reopened = ControlStore(path)
    assert reopened.schema_version == SCHEMA_VERSION


def test_a_newer_additive_store_opens_writable_and_is_not_migrated(tmp_path):
    path = tmp_path / "ergates" / "control.sqlite3"
    _store_moved_on_by_a_newer_plugin(path, version=3, marker=None)

    store = ControlStore(path)
    with store.transaction() as conn:
        _add_prefs(conn, "nora")

    assert (store.schema_version, store.min_schema_version, store.writable) == (3, 2, True)
    assert [row["profile"] for row in rows(store, "attention_prefs")] == ["nora"]
    assert rows(store, "added_by_a_newer_plugin") == []


def test_a_newer_store_whose_marker_is_past_this_plugin_refuses_writes_and_still_reads(tmp_path, caplog):
    path = tmp_path / "ergates" / "control.sqlite3"
    with ControlStore(path).transaction() as conn:
        _add_prefs(conn, "thijs")
    _store_moved_on_by_a_newer_plugin(path, version=4, marker="4")

    with caplog.at_level("WARNING", logger="ergates.store"):
        store = ControlStore(path)
        with pytest.raises(StoreReadOnly):
            with store.transaction() as conn:
                _add_prefs(conn, "nora")
        with pytest.raises(StoreReadOnly):
            with store.transaction():
                pass

    assert (store.schema_version, store.min_schema_version, store.writable) == (4, 4, False)
    assert [row["profile"] for row in rows(store, "attention_prefs")] == ["thijs"]
    assert issubclass(StoreReadOnly, StoreError)
    warnings = [record.getMessage() for record in caplog.records if record.name == "ergates.store"]
    assert len(warnings) == 1
    assert "4" in warnings[0] and str(tmp_path) not in warnings[0]


@pytest.mark.parametrize("remove_the_marker", [
    "DROP TABLE store_meta",
    f"DELETE FROM store_meta WHERE key = '{MIN_SCHEMA_KEY}'",
    f"UPDATE store_meta SET value = 'two' WHERE key = '{MIN_SCHEMA_KEY}'",
    f"UPDATE store_meta SET value = '' WHERE key = '{MIN_SCHEMA_KEY}'",
    f"UPDATE store_meta SET value = X'32' WHERE key = '{MIN_SCHEMA_KEY}'",
], ids=["no-table", "no-row", "not-a-number", "empty", "blob"])
def test_a_newer_store_without_a_marker_is_read_only(tmp_path, remove_the_marker):
    """Without a marker it can read, this plugin cannot tell which writes the newer one allows."""
    path = tmp_path / "ergates" / "control.sqlite3"
    with ControlStore(path).transaction() as conn:
        _add_prefs(conn, "thijs")
        conn.execute(remove_the_marker)
        conn.execute("PRAGMA user_version = 3")

    store = ControlStore(path)

    assert (store.schema_version, store.min_schema_version, store.writable) == (3, 3, False)
    assert [row["profile"] for row in rows(store, "attention_prefs")] == ["thijs"]
    with pytest.raises(StoreReadOnly):
        with store.transaction():
            pass


def test_a_store_a_newer_plugin_moves_on_while_this_one_has_it_open_refuses_further_writes(store):
    """Profiles can run different plugin copies on one store, and a running process keeps
    its plugin code until it restarts: a store opened writable can become read-only."""
    _store_moved_on_by_a_newer_plugin(store.path, version=4, marker="4")

    with pytest.raises(StoreReadOnly):
        with store.transaction() as conn:
            _add_prefs(conn, "nora")

    assert store.writable is False
    assert rows(store, "attention_prefs") == []


_ADDITIVE_STATEMENT = re.compile(
    r"(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE \w+ ADD COLUMN|INSERT INTO store_meta)\b"
)


def test_every_additive_migration_only_adds():
    """An older plugin keeps reading and writing a store an additive migration changed,
    so such a migration may only add: tables, indexes, columns that need no value, and
    ``store_meta`` rows."""
    for version, migration in enumerate(MIGRATIONS, start=1):
        if not migration.additive:
            continue
        for statement in migration.statements:
            flat = " ".join(statement.split())
            assert _ADDITIVE_STATEMENT.match(flat), (version, flat)
            if " ADD COLUMN " in flat:
                assert "NOT NULL" not in flat.upper() or "DEFAULT" in flat.upper(), (version, flat)


def test_a_non_additive_migration_raises_the_marker_to_its_version(tmp_path, monkeypatch):
    path = tmp_path / "ergates" / "control.sqlite3"
    with ControlStore(path).transaction() as conn:
        _add_prefs(conn, "thijs")
    not_additive = Migration(("CREATE TABLE x (a)",), additive=False)
    monkeypatch.setattr(store_module, "MIGRATIONS", MIGRATIONS + (not_additive,))
    monkeypatch.setattr(store_module, "SCHEMA_VERSION", 3)

    newer = ControlStore(path)

    assert (newer.schema_version, newer.min_schema_version, newer.writable) == (3, 3, True)
    monkeypatch.undo()
    older = ControlStore(path)
    assert (older.min_schema_version, older.writable) == (3, False)
    assert [row["profile"] for row in rows(older, "attention_prefs")] == ["thijs"]


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
    env = {**os.environ, "PYTHONPATH": str(PLUGIN_DIR)}
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
    assert [out.strip() for out, _err in results] == [str(SCHEMA_VERSION)] * 2


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
