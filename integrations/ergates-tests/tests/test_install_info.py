"""Tests for ergates.install_info: how the plugin on this server got there, as ``GET /health`` says it.

The app offers going back to an earlier commit only for a git install, so the
three kinds must not be mixed up: a deployment's read-only mount, a plugin
Hermes cloned from a commit, and a folder copied or linked by hand.

The module also keeps the commit its own code was installed at, read once when
it was imported (``loaded_commit``). These tests run outside Hermes, where the
import reads no record, so that commit is ``None`` unless a test imports the
module again under a record of its own.
"""

import ast
import importlib
from pathlib import Path

import pytest

from ergates import hermes_adapter, install_info as install_info_module
from ergates.install_info import INSTALL_KIND_ENV, install_info

SHA = "0123456789abcdef0123456789abcdef01234567"
OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98"
RECORD = {"pinned": True, "revision": SHA, "source": "https://github.com/middelkampdev/hermes-ergates"}
GIT_INSTALL = {"kind": "git install", "commit": SHA, "catalog_name": None, "loaded_commit": None}
MANUAL_COPY = {"kind": "manual copy", "commit": None, "catalog_name": None, "loaded_commit": None}
DEPLOYMENT = {"kind": "deployment", "commit": None, "catalog_name": None, "loaded_commit": None}


def _folder(tmp_path, kind):
    """The plugin folder of one kind: a real folder, a symlink to one, a file, a missing path or no path."""
    if kind is None:
        return None
    path = tmp_path / "plugins" / "ergates"
    path.parent.mkdir()
    if kind == "folder":
        path.mkdir()
    elif kind == "symlink":
        (tmp_path / "checkout").mkdir()
        path.symlink_to(tmp_path / "checkout", target_is_directory=True)
    elif kind == "file":
        path.write_text("not a folder", encoding="utf-8")
    return path


def test_the_deployment_marker_is_an_environment_variable_of_the_serving_process():
    assert INSTALL_KIND_ENV == "ERGATES_INSTALL_KIND"


@pytest.mark.parametrize("record, folder, marker, expected", [
    (RECORD, "folder", "deployment", DEPLOYMENT),
    (None, "symlink", "deployment", DEPLOYMENT),
    (None, None, "deployment", DEPLOYMENT),
    (RECORD, "folder", None, GIT_INSTALL),
    ({**RECORD, "pinned": False}, "folder", None, GIT_INSTALL),
    ({**RECORD, "revision": SHA.upper()}, "folder", None, GIT_INSTALL),
    ({**RECORD, "catalog": {"name": "ergates", "tier": "community"}}, "folder", None,
     {**GIT_INSTALL, "catalog_name": "ergates"}),
    ({**RECORD, "catalog": {"name": 7}}, "folder", None, GIT_INSTALL),
    ({**RECORD, "catalog": "ergates"}, "folder", None, GIT_INSTALL),
    (RECORD, "symlink", None, MANUAL_COPY),
    (RECORD, "file", None, MANUAL_COPY),
    (RECORD, "missing", None, MANUAL_COPY),
    (RECORD, None, None, MANUAL_COPY),
    (None, "folder", None, MANUAL_COPY),
    ([RECORD], "folder", None, MANUAL_COPY),
    ({"pinned": True, "source": "x"}, "folder", None, MANUAL_COPY),
    ({**RECORD, "revision": SHA[:7]}, "folder", None, MANUAL_COPY),
    ({**RECORD, "revision": "g" * 40}, "folder", None, MANUAL_COPY),
    ({**RECORD, "revision": SHA + "0"}, "folder", None, MANUAL_COPY),
    ({**RECORD, "revision": 12345}, "folder", None, MANUAL_COPY),
    ({**RECORD, "revision": f"{SHA}\n"}, "folder", None, MANUAL_COPY),
    ({**RECORD, "catalog": {"name": "ergates"}}, "symlink", None, MANUAL_COPY),
    (RECORD, "folder", "", GIT_INSTALL),
    (RECORD, "folder", "git install", GIT_INSTALL),
    (RECORD, "folder", "Deployment", GIT_INSTALL),
], ids=[
    "deployment-wins-over-a-git-install", "deployment-on-a-symlink", "deployment-with-nothing-else",
    "pinned-record-and-real-folder", "unpinned-record-and-real-folder", "revision-is-lowercased",
    "catalog-record-names-the-catalog-entry", "catalog-name-that-is-no-string", "catalog-that-is-no-mapping",
    "symlinked-folder", "folder-that-is-a-file", "folder-that-is-missing", "no-folder", "no-record",
    "record-that-is-no-mapping", "record-without-a-revision", "short-revision", "non-hex-revision",
    "revision-too-long", "revision-that-is-no-string", "revision-with-a-newline", "catalog-on-a-symlink",
    "empty-marker", "other-marker", "marker-in-another-case",
])
def test_install_info_tells_the_three_kinds(record, folder, marker, expected, tmp_path):
    assert install_info(record, _folder(tmp_path, folder), marker) == expected


def test_install_info_never_carries_the_record_or_the_path_beyond_the_four_fields(tmp_path):
    record = {**RECORD, "source": "https://example.invalid/private?token=secret", "update_url": "https://x.invalid"}

    info = install_info(record, _folder(tmp_path, "folder"), None)

    assert sorted(info) == ["catalog_name", "commit", "kind", "loaded_commit"]
    assert "secret" not in repr(info) and str(tmp_path) not in repr(info)


@pytest.fixture
def import_again(monkeypatch, tmp_path):
    """``import_again(record, marker=None)`` imports ``ergates.install_info`` again on a server whose install
    record is ``record`` and whose plugin folder is a real folder, the way Hermes imports the plugin's code.

    The module is imported once more when the test ends, outside Hermes, so the next test finds it as before.
    """
    folder = _folder(tmp_path, "folder")
    monkeypatch.setattr(hermes_adapter, "root_plugin_dir", lambda: folder)

    def run(record, marker=None):
        if isinstance(record, Exception):
            def failing():
                raise record
            monkeypatch.setattr(hermes_adapter, "install_record", failing)
        else:
            monkeypatch.setattr(hermes_adapter, "install_record", lambda: record)
        if marker is None:
            monkeypatch.delenv(INSTALL_KIND_ENV, raising=False)
        else:
            monkeypatch.setenv(INSTALL_KIND_ENV, marker)
        importlib.reload(install_info_module)
        return folder

    yield run
    monkeypatch.undo()
    importlib.reload(install_info_module)


def test_the_loaded_commit_is_the_record_s_commit_when_the_module_was_imported(import_again):
    folder = import_again(RECORD)

    assert install_info(RECORD, folder, None) == {**GIT_INSTALL, "loaded_commit": SHA}


def test_a_later_record_moves_the_commit_and_not_the_loaded_commit(import_again):
    """A reinstall replaces the files and the record, but the code Hermes imported keeps running until Hermes
    restarts, so ``commit`` and ``loaded_commit`` then differ: the app reads that as a restart to ask for."""
    folder = import_again(RECORD)

    info = install_info({**RECORD, "revision": OTHER_SHA}, folder, None)

    assert (info["commit"], info["loaded_commit"]) == (OTHER_SHA, SHA)


def test_the_loaded_commit_comes_with_every_answer_even_from_a_caller_that_does_not_ask_for_it(import_again):
    """An older ``dashboard/api.py`` returns ``install_info(...)`` as it is. When Hermes mounts it over this
    package, already imported from another commit, the answer still names the commit of the package code that
    answers, so a mixed load reads as a restart to ask for."""
    folder = import_again({**RECORD, "revision": OTHER_SHA})

    assert install_info(RECORD, folder, None)["loaded_commit"] == OTHER_SHA


@pytest.mark.parametrize("record", [None, {"pinned": True, "source": "x"}, OSError("unreadable record")],
                         ids=["no-record", "record-without-a-revision", "read-that-raises"])
def test_the_loaded_commit_is_none_when_the_import_finds_no_commit_and_the_import_never_fails(import_again, record):
    folder = import_again(record)

    assert install_info(RECORD, folder, None)["loaded_commit"] is None


def test_a_deployment_was_loaded_from_no_commit_whatever_its_record_says(import_again):
    folder = import_again(RECORD, marker="deployment")

    assert install_info(RECORD, folder, None)["loaded_commit"] is None


def test_the_tools_and_hooks_never_import_the_loaded_commit():
    """Only the dashboard routes read the install: the code Hermes loads for tools and hooks does not import
    this module, so nothing it does at import can reach a tool call."""
    plugin = Path(install_info_module.__file__).resolve().parents[1]
    importers = []
    for path in sorted(plugin.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names = [alias.name for alias in node.names] if isinstance(node, (ast.Import, ast.ImportFrom)) else []
            module = node.module if isinstance(node, ast.ImportFrom) else None
            if "install_info" in (module or "").split(".") or any("install_info" in name.split(".") for name in names):
                importers.append(path.relative_to(plugin).as_posix())

    assert importers == ["dashboard/api.py"]
