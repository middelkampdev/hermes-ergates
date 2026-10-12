"""Tests for ergates.setup: the proposal templates the plugin ships install themselves, and the plugin is
enabled in every profile.

``contract/live/test_dashboard_api.py`` proves the same install when
``hermes serve`` builds the routes' operations; this file needs no Hermes.
"""

import json
import logging
import os
import re
import secrets
import stat
import threading
from pathlib import Path

import pytest

from conftest import HERMES_UID, OWNER_CHANGES
from ergates import setup
from ergates.paths import bundled_templates_dir, store_path, templates_dir
from ergates.setup import (
    BAD_BUNDLE,
    BAD_INSTALLED,
    DIFFER,
    FAILED,
    INSTALLED,
    INVALID,
    MISSING,
    TemplateSourceError,
    enable_everywhere,
    ensure_templates,
    install_templates,
    setup_report,
    source_templates,
    templates_match,
    templates_state,
    templates_status,
)
from ergates.store import ControlStore
from ergates.templates import load_template


def _template(template_id, toolsets=("file", "memory")):
    return {"template_id": template_id, "soul": f"You are the {template_id}.",
            "enabled_toolsets": list(toolsets), "enabled_mcp_servers": []}


def _write(folder, name, content):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(content if isinstance(content, str) else json.dumps(content),
                                         encoding="utf-8")


def _files(folder):
    return {path.name: path.read_bytes() for path in folder.iterdir()}


def _tree(folder):
    """Every path under ``folder`` with its bytes, ``None`` for a folder."""
    return {path.relative_to(folder): None if path.is_dir() else path.read_bytes() for path in folder.rglob("*")}


def _installed(folder):
    """``{template_id: bytes}`` of the templates in ``folder``, the shape ``source_templates`` returns."""
    return {path.stem: path.read_bytes() for path in folder.glob("*.json")}


@pytest.fixture
def source(tmp_path):
    folder = tmp_path / "source"
    _write(folder, "bookkeeper", _template("bookkeeper"))
    _write(folder, "general-assistant", _template("general-assistant", ("web", "file")))
    return folder


@pytest.fixture
def source_outside(tmp_path_factory):
    """The ``source`` templates in a folder outside the Hermes root ``tmp_path``."""
    folder = tmp_path_factory.mktemp("bundle")
    _write(folder, "bookkeeper", _template("bookkeeper"))
    _write(folder, "general-assistant", _template("general-assistant", ("web", "file")))
    return folder


@pytest.fixture
def target(tmp_path):
    """Where a Hermes root at ``tmp_path`` keeps its installed templates."""
    return templates_dir(tmp_path)


# --- the bundled set ----------------------------------------------------------


def test_ensure_templates_installs_the_bundled_set_and_is_idempotent(tmp_path):
    assert ensure_templates(bundled_templates_dir(), tmp_path / "t") == "installed"
    assert ensure_templates(bundled_templates_dir(), tmp_path / "t") == "installed"
    assert templates_state(bundled_templates_dir(), tmp_path / "t") == "installed"


def test_the_installed_files_are_the_bundled_files_byte_for_byte(tmp_path):
    ensure_templates(bundled_templates_dir(), tmp_path / "t")

    assert _files(tmp_path / "t") == {path.name: path.read_bytes() for path in bundled_templates_dir().glob("*.json")}


def test_every_bundled_template_is_one_the_accept_route_serves():
    assert sorted(p.stem for p in bundled_templates_dir().glob("*.json")) == ["bookkeeper", "general-assistant"]
    for path in bundled_templates_dir().glob("*.json"):
        assert load_template(bundled_templates_dir(), path.stem)["template_id"] == path.stem


# --- ensure_templates ---------------------------------------------------------


def test_the_target_ends_with_exactly_the_source_templates(source, target):
    _write(target, "retired-role", _template("retired-role"))
    _write(target, "general-assistant", _template("general-assistant", ("terminal",)))

    assert ensure_templates(source, target) == INSTALLED

    assert sorted(path.stem for path in target.glob("*.json")) == ["bookkeeper", "general-assistant"]
    assert json.loads((target / "general-assistant.json").read_text())["enabled_toolsets"] == ["web", "file"]
    assert [path.name for path in target.iterdir() if path.name.startswith(".")] == []


def test_a_template_the_bundle_lacks_is_removed(source, target):
    _write(target, "gate-thijs", _template("gate-thijs"))

    ensure_templates(source, target)

    assert not (target / "gate-thijs.json").exists()


@pytest.mark.parametrize("broken", [
    "{not json",
    json.dumps(_template("other-id")),
    json.dumps(_template("general-assistant", ())),
])
def test_one_invalid_bundled_template_installs_none_and_keeps_the_old_set(source, target, broken):
    _write(target, "bookkeeper", _template("bookkeeper", ("terminal",)))
    _write(target, "retired-role", _template("retired-role"))
    before = _files(target)
    _write(source, "general-assistant", broken)

    assert ensure_templates(source, target) == INVALID

    assert _files(target) == before


def test_one_invalid_bundled_template_creates_no_target_folder(source, target):
    _write(source, "general-assistant", "{not json")

    assert ensure_templates(source, target) == INVALID

    assert not target.exists()


@pytest.mark.parametrize("make_source", [
    lambda tmp_path: tmp_path / "nope",
    lambda tmp_path: (tmp_path / "empty").mkdir() or tmp_path / "empty",
], ids=["absent", "empty"])
def test_a_missing_source_writes_nothing(tmp_path, target, make_source):
    _write(target, "bookkeeper", _template("bookkeeper"))
    before = _files(target)

    assert ensure_templates(make_source(tmp_path), target) == MISSING

    assert _files(target) == before


def test_a_missing_source_creates_no_target_folder(tmp_path, target):
    assert ensure_templates(tmp_path / "nope", target) == MISSING

    assert not target.exists()


def test_a_target_that_cannot_be_written_is_failed(source, target, monkeypatch):
    _write(target, "bookkeeper", _template("bookkeeper", ("terminal",)))
    before = _files(target)

    def refuse(source_name, target_name, **folders):
        raise PermissionError(13, "Permission denied", str(target_name))

    monkeypatch.setattr(os, "replace", refuse)

    assert ensure_templates(source, target) == FAILED

    assert _files(target) == before  # no staging file is left behind either


def test_a_target_folder_that_is_a_file_is_failed(tmp_path, source):
    (tmp_path / "ergates").write_text("a file where the store folder should be", encoding="utf-8")

    assert ensure_templates(source, templates_dir(tmp_path)) == FAILED


def test_ensure_templates_never_raises(source, target, monkeypatch):
    def broken(source):
        raise RuntimeError("something nobody planned for")

    monkeypatch.setattr("ergates.setup.source_templates", broken)

    assert ensure_templates(source, target) == FAILED


def test_a_set_that_is_already_installed_is_not_written_again(source, target, monkeypatch):
    ensure_templates(source, target)

    def refuse(source_name, target_name, **folders):
        raise AssertionError("the installed set was written again")

    monkeypatch.setattr(os, "replace", refuse)

    assert ensure_templates(source, target) == INSTALLED


def test_a_state_other_than_installed_is_logged_by_state_and_exception_class_only(source, target, tmp_path, monkeypatch,
                                                                                  caplog):
    caplog.set_level(logging.INFO, logger="ergates.setup")

    def refuse(source_name, target_name, **folders):
        raise PermissionError(13, "Permission denied", "/secret/hermes/root")

    monkeypatch.setattr(os, "replace", refuse)
    ensure_templates(source, target)
    _write(source, "general-assistant", "{not json with a secret soul")
    ensure_templates(source, target)
    ensure_templates(tmp_path / "nope", target)

    messages = [record.getMessage() for record in caplog.records if record.name == "ergates.setup"]
    assert messages == [
        "setup: templates failed (PermissionError)",
        "setup: templates invalid (TemplateSourceError)",
        "setup: templates missing",
    ]


def test_an_installed_set_is_not_logged(source, target, caplog):
    caplog.set_level(logging.INFO, logger="ergates.setup")

    ensure_templates(source, target)

    assert [record for record in caplog.records if record.name == "ergates.setup"] == []


def test_the_store_folder_is_private_when_the_install_runs_first(tmp_path, source):
    ensure_templates(source, templates_dir(tmp_path))

    assert (tmp_path / "ergates").stat().st_mode & 0o777 == 0o700
    assert templates_dir(tmp_path).stat().st_mode & 0o777 == 0o700


# --- root on a Hermes root another user owns writes nothing ---------------------


def _setup_messages(caplog):
    return [record.getMessage() for record in caplog.records if record.name == "ergates.setup"]


@pytest.mark.parametrize("installed_before", [False, True], ids=["fresh root", "installed set differs"])
def test_root_on_a_hermes_root_another_user_owns_installs_nothing_and_reads_nothing(
        tmp_path, as_root, source_outside, monkeypatch, caplog, installed_before):
    caplog.set_level(logging.INFO, logger="ergates.setup")
    target = templates_dir(tmp_path)
    if installed_before:
        monkeypatch.setattr(os, "geteuid", lambda: HERMES_UID)
        ensure_templates(source_outside, target)
        _write(source_outside, "bookkeeper", _template("bookkeeper", ("terminal",)))
        monkeypatch.setattr(os, "geteuid", lambda: 0)
    before = _tree(tmp_path)

    def touched(*args, **kwargs):
        pytest.fail("the templates folder was read or written")

    monkeypatch.setattr(setup, "templates_match", touched)
    monkeypatch.setattr(setup, "install_templates", touched)

    assert ensure_templates(source_outside, target) == FAILED

    assert _tree(tmp_path) == before
    assert _setup_messages(caplog) == ["setup: templates failed (run hermes serve as the owner of the Hermes root)"]
    assert as_root.owner_changes == []


def test_root_on_its_own_hermes_root_installs_as_before(tmp_path, as_root, source_outside):
    as_root.root_owner = 0

    assert ensure_templates(source_outside, templates_dir(tmp_path)) == INSTALLED

    assert _installed(templates_dir(tmp_path)) == source_templates(source_outside)
    assert as_root.owner_changes == []


def test_a_process_that_is_not_root_installs_as_before(tmp_path, as_root, source_outside, monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: HERMES_UID)

    assert ensure_templates(source_outside, templates_dir(tmp_path)) == INSTALLED

    assert _installed(templates_dir(tmp_path)) == source_templates(source_outside)
    assert as_root.owner_changes == []


def test_root_installs_into_a_hermes_root_that_does_not_exist_yet(tmp_path, as_root, source_outside):
    """A root that does not exist yet has no other owner: root makes it, and it is root's."""
    assert ensure_templates(source_outside, templates_dir(tmp_path / "new-root")) == INSTALLED


def test_the_plugin_changes_the_owner_of_nothing():
    """No module of the plugin names `os.chown`, `os.fchown` or `os.lchown`, or calls a function of those names."""
    plugin = Path(setup.__file__).resolve().parents[1]
    names = "|".join(OWNER_CHANGES)
    owner_change = re.compile(rf"\bos\.(?:{names})\b|\b(?:{names})\s*\(")

    assert [str(path.relative_to(plugin)) for path in sorted(plugin.rglob("*.py"))
            if owner_change.search(path.read_text(encoding="utf-8"))] == []


# --- symlinks and races: the agents' processes share these folders with the install --


@pytest.fixture
def outside(tmp_path_factory):
    """A folder outside the Hermes root, with a file each step of the install could write over or remove."""
    folder = tmp_path_factory.mktemp("outside")
    _write(folder, "victim", {"belongs": "to someone else"})
    _write(folder / "templates", "victim", {"belongs": "to someone else"})
    return folder


def _swap_for_a_symlink_after_the_first_file(monkeypatch, folder, moved_to, points_to):
    """After the first ``os.replace``, move ``folder`` to ``moved_to`` and put a symlink to ``points_to`` in its
    place, as a process of the folder's owner can at any moment."""
    real_replace = os.replace

    def replace_then_swap(*args, **kwargs):
        real_replace(*args, **kwargs)
        if not moved_to.exists():
            os.rename(folder, moved_to)
            folder.symlink_to(points_to, target_is_directory=True)

    monkeypatch.setattr(os, "replace", replace_then_swap)


symlinked_folders = pytest.mark.parametrize("linked, points_to", [
    ("ergates", "."),
    ("ergates/templates", "templates"),
], ids=["store folder", "templates folder"])


def test_a_symlink_at_a_staging_name_is_never_written_through(source, target, outside):
    """The staging names were predictable: an agent's process could plant a symlink there, and the install wrote
    the template into the file it points to."""
    target.mkdir(parents=True)
    for template_id in ("bookkeeper", "general-assistant"):
        (target / f".{template_id}.json.tmp").symlink_to(outside / "victim.json")
    before = _tree(outside)

    assert ensure_templates(source, target) == INSTALLED

    assert _tree(outside) == before
    assert _installed(target) == source_templates(source)
    assert not any(path.is_symlink() for path in target.glob("*.json"))


def test_a_staging_name_that_is_taken_is_never_opened(source, target, outside, monkeypatch):
    """The staging name is random; when it is taken all the same, the install stops instead of opening it."""
    target.mkdir(parents=True)
    (target / ".bookkeeper.taken.tmp").symlink_to(outside / "victim.json")
    before = _tree(outside)
    monkeypatch.setattr(secrets, "token_hex", lambda nbytes=None: "taken")

    assert ensure_templates(source, target) == FAILED

    assert _tree(outside) == before


@symlinked_folders
def test_a_symlinked_store_or_templates_folder_is_failed_and_nothing_outside_the_root_changes(
        tmp_path, source, outside, linked, points_to, caplog):
    caplog.set_level(logging.INFO, logger="ergates.setup")
    link = tmp_path / linked
    link.parent.mkdir(exist_ok=True)
    link.symlink_to(outside / points_to, target_is_directory=True)
    before = _tree(outside)

    assert ensure_templates(source, templates_dir(tmp_path)) == FAILED

    assert _tree(outside) == before
    # O_DIRECTORY | O_NOFOLLOW on a symlink is ENOTDIR on Linux and macOS.
    assert _setup_messages(caplog) == ["setup: templates failed (NotADirectoryError)"]


@symlinked_folders
def test_the_install_itself_refuses_a_symlinked_store_or_templates_folder(tmp_path, source, outside, linked,
                                                                         points_to):
    """A folder can turn into a symlink after `ensure_templates` looked, so the install refuses one as well."""
    link = tmp_path / linked
    link.parent.mkdir(exist_ok=True)
    link.symlink_to(outside / points_to, target_is_directory=True)
    before = _tree(outside)

    with pytest.raises(OSError):
        install_templates(source_templates(source), templates_dir(tmp_path))

    assert _tree(outside) == before


def test_a_templates_folder_swapped_for_a_symlink_during_the_install_is_never_written_through(
        tmp_path, source, outside, monkeypatch):
    target = templates_dir(tmp_path)
    _write(target, "retired-role", _template("retired-role"))
    moved = tmp_path / "ergates" / "moved"
    _swap_for_a_symlink_after_the_first_file(monkeypatch, target, moved, outside / "templates")
    before = _tree(outside)

    ensure_templates(source, target)

    assert _tree(outside) == before
    assert _installed(moved) == source_templates(source)  # every write stayed in the folder the install opened


def test_a_symlink_at_a_template_name_is_replaced_and_one_the_bundle_lacks_removed_never_followed(
        source, target, outside):
    target.mkdir(parents=True)
    (target / "bookkeeper.json").symlink_to(outside / "victim.json")
    (target / "retired-role.json").symlink_to(outside / "victim.json")
    before = _tree(outside)

    assert templates_state(source, target) == INVALID
    assert ensure_templates(source, target) == INSTALLED

    assert not any(path.is_symlink() for path in target.iterdir())
    assert _installed(target) == source_templates(source)
    assert _tree(outside) == before


def test_two_installs_of_a_changed_set_at_the_same_moment_both_end_complete(source, target, monkeypatch):
    """The dashboard API runs in one plugin host per profile (`plugins.isolation: host`), so two processes can
    install a changed set at once. With one shared staging name, one truncated or moved the other's file."""
    ensure_templates(source, target)
    _write(source, "bookkeeper", _template("bookkeeper", ("terminal",)))
    both_staged = threading.Barrier(2, timeout=5)
    real_replace = os.replace

    def replace_once_both_have_staged(*args, **kwargs):
        both_staged.wait()
        real_replace(*args, **kwargs)

    monkeypatch.setattr(os, "replace", replace_once_both_have_staged)
    start = threading.Barrier(2, timeout=5)
    states = []

    def install():
        start.wait()
        states.append(ensure_templates(source, target))

    installs = [threading.Thread(target=install) for _ in range(2)]
    for thread in installs:
        thread.start()
    for thread in installs:
        thread.join()

    assert states == [INSTALLED, INSTALLED]
    assert _installed(target) == source_templates(source)
    assert [name for name in os.listdir(target) if name.startswith(".")] == []


def test_the_installed_files_are_0644_under_the_usual_umask(source, target):
    """The staging file is the installed file, so its mode is the one a plain write gave."""
    previous_umask = os.umask(0o022)
    try:
        ensure_templates(source, target)
    finally:
        os.umask(previous_umask)

    assert {stat.S_IMODE(path.stat().st_mode) for path in target.glob("*.json")} == {0o644}


def test_without_dir_fd_the_install_works_by_path_and_still_refuses_a_symlinked_folder(tmp_path, source, outside,
                                                                                       monkeypatch):
    """Windows has no `dir_fd`, and no root to escalate from, so there the install resolves names by path."""
    monkeypatch.setattr("ergates.setup._HAS_DIR_FD", False)
    target = templates_dir(tmp_path)

    assert ensure_templates(source, target) == INSTALLED
    assert _installed(target) == source_templates(source)

    other_root = tmp_path / "other"
    (other_root / "ergates").mkdir(parents=True)
    (other_root / "ergates" / "templates").symlink_to(outside / "templates", target_is_directory=True)
    before = _tree(outside)
    with pytest.raises(OSError):
        install_templates(source_templates(source), templates_dir(other_root))
    assert _tree(outside) == before


# --- templates_state ----------------------------------------------------------


def test_the_state_of_an_empty_target_is_differ_and_it_reads_only(source, target):
    assert templates_state(source, target) == DIFFER

    assert not target.exists()


def test_the_state_after_an_install_is_installed(source, target):
    ensure_templates(source, target)

    assert templates_state(source, target) == INSTALLED


def test_a_changed_or_extra_template_makes_the_state_differ(source, target):
    ensure_templates(source, target)
    _write(target, "retired-role", _template("retired-role"))
    assert templates_state(source, target) == DIFFER

    (target / "retired-role.json").unlink()
    _write(target, "bookkeeper", _template("bookkeeper", ("terminal",)))
    assert templates_state(source, target) == DIFFER


def test_the_state_changes_nothing_in_the_target(source, target):
    _write(target, "retired-role", _template("retired-role"))
    before = _files(target)

    templates_state(source, target)

    assert _files(target) == before


def test_an_invalid_source_has_the_state_invalid(source, target):
    _write(source, "general-assistant", "{not json")

    assert templates_state(source, target) == INVALID


def test_a_missing_or_empty_source_has_the_state_missing(tmp_path, target):
    (tmp_path / "empty").mkdir()

    assert templates_state(tmp_path / "nope", target) == MISSING
    assert templates_state(tmp_path / "empty", target) == MISSING


@pytest.mark.skipif(getattr(os, "geteuid", lambda: -1)() == 0, reason="root reads a folder without permissions")
def test_a_target_that_cannot_be_read_has_the_state_differ(source, target):
    ensure_templates(source, target)
    target.chmod(0)
    try:
        assert templates_state(source, target) == DIFFER
    finally:
        target.chmod(0o700)


def _returns_within(seconds, call):
    """What ``call()`` returns; fails the test when it has not returned after ``seconds``, as a blocked open never
    does. The thread is a daemon, so a blocked one does not keep the test run alive."""
    results = []
    worker = threading.Thread(target=lambda: results.append(call()), daemon=True)
    worker.start()
    worker.join(seconds)
    assert not worker.is_alive(), "the call blocked"
    return results[0]


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="no FIFOs on this platform")
def test_a_fifo_in_the_templates_folder_never_blocks_and_is_never_read(source, target):
    """An open for reading waits for a writer on a FIFO nobody writes to, so a plain read stalls the process."""
    ensure_templates(source, target)
    (target / "bookkeeper.json").unlink()
    os.mkfifo(target / "bookkeeper.json")
    os.mkfifo(target / "retired-role.json")

    assert _returns_within(5, lambda: templates_state(source, target)) == INVALID
    assert _returns_within(5, lambda: templates_match(source_templates(source), target)) is False
    assert _returns_within(5, lambda: ensure_templates(source, target)) == INSTALLED

    assert sorted(os.listdir(target)) == ["bookkeeper.json", "general-assistant.json"]
    assert _installed(target) == source_templates(source)


def test_an_oversized_template_file_is_never_read(source, target, monkeypatch):
    ensure_templates(source, target)
    oversized = target / "bookkeeper.json"
    with open(oversized, "r+b") as file:
        file.truncate(setup.MAX_TEMPLATE_BYTES + 1)  # sparse: no disk space, but its size is past the limit
    oversized_file = (oversized.stat().st_dev, oversized.stat().st_ino)
    real_read = os.read
    read_from_it = []

    def read(fd, size):
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) == oversized_file:
            read_from_it.append(size)
        return real_read(fd, size)

    monkeypatch.setattr(os, "read", read)

    assert templates_state(source, target) == INVALID
    assert templates_match(source_templates(source), target) is False
    assert read_from_it == []
    assert ensure_templates(source, target) == INSTALLED
    assert _installed(target) == source_templates(source)


def test_a_template_file_that_grows_past_the_limit_while_it_is_read_does_not_match(source, target, monkeypatch):
    templates = source_templates(source)
    install_templates(templates, target)
    grown = target / "bookkeeper.json"
    grown.write_bytes(b"x" * (setup.MAX_TEMPLATE_BYTES + 1))
    grown_file = (grown.stat().st_dev, grown.stat().st_ino)
    real_fstat = os.fstat

    def fstat_from_before_it_grew(fd):
        result = real_fstat(fd)
        if (result.st_dev, result.st_ino) != grown_file:
            return result
        values = list(result)
        values[6] = 1  # st_size
        return os.stat_result(values)

    monkeypatch.setattr(os, "fstat", fstat_from_before_it_grew)

    assert templates_match(templates, target) is False


@pytest.mark.skipif(getattr(os, "geteuid", lambda: -1)() == 0, reason="root reads a file without permissions")
def test_an_installed_template_that_cannot_be_opened_fails_the_install_and_makes_the_state_differ(source, target):
    ensure_templates(source, target)
    (target / "bookkeeper.json").chmod(0)

    assert templates_state(source, target) == DIFFER
    assert ensure_templates(source, target) == FAILED


def test_a_template_file_at_the_size_limit_is_read(source, target):
    templates = {"bookkeeper": b"x" * setup.MAX_TEMPLATE_BYTES}
    _write(target, "bookkeeper", "x" * setup.MAX_TEMPLATE_BYTES)

    assert templates_match(templates, target) is True


def test_a_source_that_cannot_be_read_has_the_state_missing(source, target, monkeypatch):
    def unreadable(folder):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr("ergates.setup.source_templates", unreadable)

    assert templates_state(source, target) == MISSING


def test_a_failure_nobody_foresaw_reading_the_source_has_the_state_invalid_and_is_the_bundle(source, target, monkeypatch):
    """The state never raises: a health report is built on it."""
    def broken(folder):
        raise RuntimeError("/secret/plugin/templates")

    monkeypatch.setattr("ergates.setup.source_templates", broken)

    assert templates_state(source, target) == INVALID
    assert templates_status(source, target) == (INVALID, BAD_BUNDLE)


def test_a_failure_nobody_foresaw_reading_the_target_has_the_state_invalid_and_is_the_installed_set(
        source, target, monkeypatch):
    def broken(folder):
        raise RuntimeError("/secret/hermes/ergates/templates")

    monkeypatch.setattr("ergates.setup._installed_templates", broken)

    assert templates_state(source, target) == INVALID
    assert templates_status(source, target) == (INVALID, BAD_INSTALLED)


# --- templates_status: the state, and for an invalid one where the bad file is ---


def test_an_invalid_bundled_template_is_named_as_the_bundle(source, target):
    ensure_templates(source, target)
    _write(source, "general-assistant", "{not json")

    assert templates_status(source, target) == (INVALID, "bundle")
    assert (BAD_BUNDLE, BAD_INSTALLED) == ("bundle", "installed")


def test_an_installed_file_that_is_no_regular_file_is_named_as_the_installed_set(source, target, outside):
    ensure_templates(source, target)
    (target / "bookkeeper.json").unlink()
    (target / "bookkeeper.json").symlink_to(outside / "victim.json")

    assert templates_status(source, target) == (INVALID, "installed")


def test_a_bad_bundle_wins_over_a_bad_installed_file(source, target, outside):
    ensure_templates(source, target)
    (target / "bookkeeper.json").unlink()
    (target / "bookkeeper.json").symlink_to(outside / "victim.json")
    _write(source, "general-assistant", "{not json")

    assert templates_status(source, target) == (INVALID, "bundle")


@pytest.mark.parametrize("state", [INSTALLED, DIFFER, MISSING])
def test_every_other_state_has_no_detail(state, source, target, tmp_path):
    if state == INSTALLED:
        ensure_templates(source, target)
    elif state == MISSING:
        source = tmp_path / "empty"
        source.mkdir()

    assert templates_status(source, target) == (state, None)


# --- the parts ensure_templates is made of ------------------------------------


def test_source_templates_names_every_file_the_accept_route_would_refuse(source):
    _write(source, "a-broken", "{not json")
    _write(source, "general-assistant", _template("other-id"))

    with pytest.raises(TemplateSourceError) as raised:
        source_templates(source)

    assert raised.value.names == ["a-broken.json", "general-assistant.json"]


def test_source_templates_reads_the_files_as_they_are(source):
    assert source_templates(source) == {"bookkeeper": (source / "bookkeeper.json").read_bytes(),
                                        "general-assistant": (source / "general-assistant.json").read_bytes()}


def test_templates_match_compares_byte_for_byte(source, target):
    templates = source_templates(source)
    install_templates(templates, target)
    assert templates_match(templates, target)

    (target / "bookkeeper.json").write_bytes(templates["bookkeeper"] + b" ")
    assert not templates_match(templates, target)


# --- enable_everywhere and setup_report ---------------------------------------


def test_enable_everywhere_enables_each_profile_in_order_and_reports_each():
    enabled = set()

    result = enable_everywhere(["default", "mira"], enabled.add, enabled.__contains__)

    assert result == [{"name": "default", "enabled": True}, {"name": "mira", "enabled": True}]


def test_enable_everywhere_reports_a_profile_that_cannot_be_enabled_by_class_and_goes_on():
    enabled = set()

    def enable(profile):
        if profile == "mira":
            raise FileExistsError("/secret/path/plugins/ergates exists and is not a link")
        enabled.add(profile)

    result = enable_everywhere(["default", "mira", "zoe"], enable, enabled.__contains__)

    assert result == [{"name": "default", "enabled": True},
                      {"name": "mira", "enabled": False, "error": "FileExistsError"},
                      {"name": "zoe", "enabled": True}]
    assert "secret" not in json.dumps(result)


def test_enable_everywhere_reports_a_profile_whose_check_raises_as_not_enabled_and_goes_on():
    def enabled(profile):
        if profile == "mira":
            raise RuntimeError("Hermes could not be asked")
        return True

    result = enable_everywhere(["mira", "zoe"], lambda profile: None, enabled)

    assert result == [{"name": "mira", "enabled": False, "error": "RuntimeError"}, {"name": "zoe", "enabled": True}]


def test_enable_everywhere_reports_a_profile_that_stays_off_without_an_error():
    assert enable_everywhere(["mira"], lambda profile: None, lambda profile: False) == [
        {"name": "mira", "enabled": False}]


def test_enable_everywhere_with_no_profile_enables_nothing():
    assert enable_everywhere([], lambda profile: pytest.fail("no profile to enable"), lambda profile: True) == []


def test_setup_report_is_finished_only_with_installed_templates_and_every_profile_enabled():
    on = {"name": "default", "enabled": True}
    off = {"name": "mira", "enabled": False, "error": "FileExistsError"}

    assert setup_report(INSTALLED, [on]) == {"finished": True, "templates": "installed", "profiles": [on]}
    assert setup_report(INSTALLED, [on, off])["finished"] is False
    assert setup_report(INSTALLED, [])["finished"] is False
    for state in (DIFFER, INVALID, MISSING, FAILED):
        report = setup_report(state, [on])
        assert (report["finished"], report["templates"]) == (False, state)
