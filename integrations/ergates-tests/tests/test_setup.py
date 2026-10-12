"""Tests for ergates.setup: the proposal templates the plugin ships install themselves.

``contract/live/test_dashboard_api.py`` proves the same install when
``hermes serve`` builds the routes' operations; this file needs no Hermes.
"""

import json
import logging
import os
import secrets
import stat
import threading

import pytest

from conftest import HERMES_OWNER
from ergates.paths import bundled_templates_dir, store_path, templates_dir
from ergates.setup import (
    DIFFER,
    FAILED,
    INSTALLED,
    INVALID,
    MISSING,
    TemplateSourceError,
    ensure_templates,
    install_templates,
    source_templates,
    templates_match,
    templates_state,
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


@pytest.fixture
def source(tmp_path):
    folder = tmp_path / "source"
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


# --- a root run on a fresh root the Hermes user owns -----------------------


def _handed_over(calls, root):
    """The paths ``calls`` gave to ``HERMES_OWNER``; a file changed through its descriptor by where it is now."""
    return [changed if isinstance(changed, os.PathLike) else changed.path_under(root)
            for changed, uid, gid in calls if (uid, gid) == HERMES_OWNER]


def test_the_first_use_as_root_hands_every_path_it_makes_to_the_owner_of_the_hermes_root(tmp_path, as_root):
    """`hermes serve` may run as root on a fresh root the `hermes` user owns, and it installs the templates
    before the store opens. The store only hands over what it creates itself, so the install must hand over
    `<root>/ergates` too, or the hermes user's gateway hooks cannot open the store."""
    ensure_templates(bundled_templates_dir(), templates_dir(tmp_path))
    ControlStore(store_path(tmp_path))

    folder = tmp_path / "ergates"
    everything_made = {folder, *folder.rglob("*")}
    assert _handed_over(as_root, tmp_path) == [
        folder, folder / "templates", folder / "templates" / "bookkeeper.json",
        folder / "templates" / "general-assistant.json", folder / "control.sqlite3",
    ]
    assert set(_handed_over(as_root, tmp_path)) == everything_made
    assert all(call[1:] == HERMES_OWNER for call in as_root)


def test_root_hands_over_the_template_files_it_writes_but_not_the_folders_that_exist(tmp_path, as_root, source):
    target = templates_dir(tmp_path)
    ensure_templates(source, target)
    as_root.clear()
    _write(source, "bookkeeper", _template("bookkeeper", ("terminal",)))

    assert ensure_templates(source, target) == INSTALLED

    assert _handed_over(as_root, tmp_path) == [target / "bookkeeper.json", target / "general-assistant.json"]


def test_root_changes_no_owner_when_the_installed_set_is_already_right(tmp_path, as_root, source):
    target = templates_dir(tmp_path)
    ensure_templates(source, target)
    as_root.clear()

    ensure_templates(source, target)

    assert as_root == []


def test_root_installs_into_a_hermes_root_that_does_not_exist_yet(tmp_path, as_root, source):
    assert ensure_templates(source, templates_dir(tmp_path / "new-root")) == INSTALLED


def test_a_process_that_is_not_root_changes_no_owner(tmp_path, as_root, source, monkeypatch):
    monkeypatch.setattr(os, "geteuid", lambda: 1000)

    ensure_templates(source, templates_dir(tmp_path))

    assert as_root == []


# --- symlinks and races: the hermes user's processes share these folders with a root run --


def _tree(folder):
    """Every path under ``folder`` with its bytes, ``None`` for a folder."""
    return {path.relative_to(folder): None if path.is_dir() else path.read_bytes() for path in folder.rglob("*")}


def _installed(folder):
    """``{template_id: bytes}`` of the templates in ``folder``, the shape ``source_templates`` returns."""
    return {path.stem: path.read_bytes() for path in folder.glob("*.json")}


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
    """The staging names were predictable: a process of the `hermes` user could plant a symlink there, and a root
    run wrote the template into the file it points to."""
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
    messages = [record.getMessage() for record in caplog.records if record.name == "ergates.setup"]
    assert messages == ["setup: templates failed (OSError)"]


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


def test_as_root_every_owner_change_stays_in_the_store_folder_and_follows_no_symlink(
        tmp_path, source, outside, as_root, monkeypatch):
    """`as_root` fails any `os.chown` that would follow a symlink. A process of the `hermes` user planted symlinks
    at an old staging name, at a template's name and at a template the bundle lacks, and swaps the folder for a
    symlink during the install."""
    target = templates_dir(tmp_path)
    target.mkdir(parents=True)
    for name in (".bookkeeper.json.tmp", "bookkeeper.json", "retired-role.json"):
        (target / name).symlink_to(outside / "victim.json")
    moved = tmp_path / "ergates" / "moved"
    _swap_for_a_symlink_after_the_first_file(monkeypatch, target, moved, outside / "templates")
    before = _tree(outside)

    ensure_templates(source, target)
    ControlStore(store_path(tmp_path)).close()

    assert _handed_over(as_root, tmp_path) == [
        moved / "bookkeeper.json", moved / "general-assistant.json", tmp_path / "ergates" / "control.sqlite3",
    ]
    assert len(as_root) == 3
    assert _tree(outside) == before


def test_a_symlink_at_a_template_name_is_replaced_and_one_the_bundle_lacks_removed_never_followed(
        source, target, outside):
    target.mkdir(parents=True)
    (target / "bookkeeper.json").symlink_to(outside / "victim.json")
    (target / "retired-role.json").symlink_to(outside / "victim.json")
    before = _tree(outside)

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


def test_a_target_that_cannot_be_read_has_the_state_differ(source, target, monkeypatch):
    ensure_templates(source, target)

    def unreadable(templates, folder):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr("ergates.setup.templates_match", unreadable)

    assert templates_state(source, target) == DIFFER


def test_a_source_that_cannot_be_read_has_the_state_missing(source, target, monkeypatch):
    def unreadable(folder):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr("ergates.setup.source_templates", unreadable)

    assert templates_state(source, target) == MISSING


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
