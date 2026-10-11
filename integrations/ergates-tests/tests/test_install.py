"""Tests for ergates.install: the templates and the plugin in every profile.

The Hermes calls are replaced by ``FakeHermes``; ``contract/live/test_install.py``
runs the same command against the pinned Hermes.
"""

import json
import os
import sys

import pytest

from ergates import hermes_adapter, install
from ergates.install import main
from ergates.paths import templates_dir


def _template(template_id, toolsets=("file", "memory")):
    return {"template_id": template_id, "soul": f"You are the {template_id}.",
            "enabled_toolsets": list(toolsets), "enabled_mcp_servers": []}


def _write(folder, name, content):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(content if isinstance(content, str) else json.dumps(content),
                                         encoding="utf-8")


class FakeHermes:
    """The adapter calls install makes, over an in-memory set of profiles."""

    def __init__(self, *profiles, broken=()):
        self.profiles = list(profiles)
        self.enabled = set()
        self.broken = set(broken)
        self.enable_calls = []

    def profile_names(self):
        return list(self.profiles)

    def enable_plugin(self, profile):
        self.enable_calls.append(profile)
        if profile in self.broken:
            raise FileExistsError("plugins/ergates exists and is not a link")
        self.enabled.add(profile)

    def plugin_enabled(self, profile):
        return profile in self.enabled


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A Hermes root outside a Hermes runtime; ``HERMES_HOME`` points at it."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.fixture
def hermes(monkeypatch):
    fake = FakeHermes("default", "thijs")
    for name in ("profile_names", "enable_plugin", "plugin_enabled"):
        monkeypatch.setattr(hermes_adapter, name, getattr(fake, name))
    return fake


@pytest.fixture
def source(tmp_path):
    folder = tmp_path / "source"
    _write(folder, "bookkeeper", _template("bookkeeper"))
    _write(folder, "general-assistant", _template("general-assistant", ("web", "file")))
    return folder


def test_it_installs_the_templates_and_enables_the_plugin_in_every_profile(root, hermes, source, capsys):
    assert main(["--templates", str(source)]) == 0

    target = templates_dir(root)
    assert sorted(path.name for path in target.iterdir()) == ["bookkeeper.json", "general-assistant.json"]
    assert (target / "general-assistant.json").read_bytes() == (source / "general-assistant.json").read_bytes()
    assert hermes.enabled == {"default", "thijs"}
    assert capsys.readouterr().out.splitlines() == [
        "ergates.install: templates=installed (bookkeeper, general-assistant)",
        "ergates.install: profile=default plugin=enabled",
        "ergates.install: profile=thijs plugin=enabled",
    ]


def test_the_server_ends_with_exactly_the_source_templates(root, hermes, source):
    _write(templates_dir(root), "retired-role", _template("retired-role"))
    _write(templates_dir(root), "general-assistant", _template("general-assistant", ("terminal",)))

    assert main(["--templates", str(source)]) == 0

    target = templates_dir(root)
    assert sorted(path.stem for path in target.glob("*.json")) == ["bookkeeper", "general-assistant"]
    assert json.loads((target / "general-assistant.json").read_text())["enabled_toolsets"] == ["web", "file"]
    assert [path.name for path in target.iterdir() if path.name.startswith(".")] == []


def test_running_it_again_changes_nothing_and_passes(root, hermes, source, capsys):
    assert main(["--templates", str(source)]) == 0
    before = {path.name: path.read_bytes() for path in templates_dir(root).iterdir()}

    assert main(["--templates", str(source)]) == 0

    assert {path.name: path.read_bytes() for path in templates_dir(root).iterdir()} == before


@pytest.mark.parametrize("broken", [
    "{not json",
    json.dumps(_template("other-id")),
    json.dumps(_template("general-assistant", ())),
])
def test_one_invalid_source_template_installs_nothing(root, hermes, source, capsys, broken):
    _write(source, "general-assistant", broken)

    assert main(["--templates", str(source)]) == 1

    assert not templates_dir(root).exists()
    assert hermes.enable_calls == []
    assert "invalid templates: general-assistant.json; nothing was installed" in capsys.readouterr().err


def test_check_reports_without_changing_anything(root, hermes, source, capsys):
    assert main(["--templates", str(source), "--check"]) == 1

    assert not templates_dir(root).exists()
    assert hermes.enable_calls == []
    assert capsys.readouterr().out.splitlines() == [
        "ergates.install: templates=differ (bookkeeper, general-assistant)",
        "ergates.install: profile=default plugin=not enabled",
        "ergates.install: profile=thijs plugin=not enabled",
    ]

    assert main(["--templates", str(source)]) == 0
    assert main(["--templates", str(source), "--check"]) == 0


def test_a_profile_that_cannot_be_enabled_is_reported_and_the_others_still_are(root, monkeypatch, source, capsys):
    fake = FakeHermes("default", "thijs", "nora", broken={"thijs"})
    for name in ("profile_names", "enable_plugin", "plugin_enabled"):
        monkeypatch.setattr(hermes_adapter, name, getattr(fake, name))

    assert main(["--templates", str(source)]) == 1

    assert fake.enabled == {"default", "nora"}
    assert "ergates.install: profile=thijs plugin=failed (FileExistsError)" in capsys.readouterr().out


def test_it_refuses_to_run_as_root_on_a_hermes_root_another_user_owns(root, hermes, source, monkeypatch, capsys):
    monkeypatch.setattr(os, "geteuid", lambda: 0)

    assert main(["--templates", str(source)]) == 2

    assert not templates_dir(root).exists()
    assert "refusing to run as root" in capsys.readouterr().err


def test_it_needs_the_hermes_runtime(root, source, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "hermes_cli", None)
    monkeypatch.setitem(sys.modules, "hermes_cli.profiles", None)

    assert main(["--templates", str(source)]) == 2

    assert "needs the Hermes runtime" in capsys.readouterr().err


def test_it_names_a_missing_template_folder(root, hermes, tmp_path, capsys):
    assert main(["--templates", str(tmp_path / "nope")]) == 2
    assert "no template folder" in capsys.readouterr().err


def test_an_empty_template_folder_refuses_to_install_and_keeps_what_is_there(root, hermes, source, tmp_path, capsys):
    """An empty source (a missing bind-mount source Docker creates as an empty
    folder is a realistic trigger) must not be read as "the reviewed set is
    now empty": that would delete every installed template and leave every
    proposal accept failing until the next correct install."""
    assert main(["--templates", str(source)]) == 0
    before = {path.name: path.read_bytes() for path in templates_dir(root).iterdir()}
    hermes.enable_calls.clear()
    capsys.readouterr()
    empty = tmp_path / "empty"
    empty.mkdir()

    assert main(["--templates", str(empty)]) == 2

    assert {path.name: path.read_bytes() for path in templates_dir(root).iterdir()} == before
    assert hermes.enable_calls == []
    assert "no templates found" in capsys.readouterr().err


def test_check_on_an_empty_template_folder_still_reports_differ(root, hermes, source, tmp_path, capsys):
    """``--check`` must keep reaching the per-profile lines a live gateway check
    depends on, so an empty source stays a plain mismatch there, not a refusal."""
    assert main(["--templates", str(source)]) == 0
    capsys.readouterr()
    empty = tmp_path / "empty"
    empty.mkdir()

    assert main(["--templates", str(empty), "--check"]) == 1

    assert capsys.readouterr().out.splitlines()[0] == "ergates.install: templates=differ (none)"
    assert sorted(path.name for path in templates_dir(root).iterdir()) == ["bookkeeper.json", "general-assistant.json"]


def test_it_names_a_missing_hermes_home(tmp_path, monkeypatch, source, capsys):
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nope"))

    assert main(["--templates", str(source)]) == 2
    assert "no Hermes home" in capsys.readouterr().err


def test_the_default_source_is_where_compose_mounts_deploy_templates():
    assert install.DEFAULT_SOURCE.as_posix() == "/opt/ergates/templates"
