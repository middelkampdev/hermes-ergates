"""Tests for ergates.setup: the proposal templates the plugin ships install themselves.

``contract/live/test_dashboard_api.py`` proves the same install when
``hermes serve`` builds the routes' operations; this file needs no Hermes.
"""

import json
import logging
import os

import pytest

from ergates.paths import bundled_templates_dir, templates_dir
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

    def refuse(src, dst):
        raise PermissionError(13, "Permission denied", str(dst))

    monkeypatch.setattr(os, "replace", refuse)

    assert ensure_templates(source, target) == FAILED

    assert {name: content for name, content in _files(target).items() if name.endswith(".json")} == before


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

    def refuse(src, dst):
        raise AssertionError("the installed set was written again")

    monkeypatch.setattr(os, "replace", refuse)

    assert ensure_templates(source, target) == INSTALLED


def test_a_state_other_than_installed_is_logged_by_state_and_exception_class_only(source, target, tmp_path, monkeypatch,
                                                                                  caplog):
    caplog.set_level(logging.INFO, logger="ergates.setup")

    def refuse(src, dst):
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
