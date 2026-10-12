"""Tests for ergates.install_info: how the plugin on this server got there, as ``GET /health`` says it.

The app offers going back to an earlier commit only for a git install, so the
three kinds must not be mixed up: a deployment's read-only mount, a plugin
Hermes cloned from a commit, and a folder copied or linked by hand.
"""

import pytest

from ergates.install_info import INSTALL_KIND_ENV, install_info

SHA = "0123456789abcdef0123456789abcdef01234567"
RECORD = {"pinned": True, "revision": SHA, "source": "https://github.com/middelkampdev/hermes-ergates"}
GIT_INSTALL = {"kind": "git install", "commit": SHA, "catalog_name": None}
MANUAL_COPY = {"kind": "manual copy", "commit": None, "catalog_name": None}
DEPLOYMENT = {"kind": "deployment", "commit": None, "catalog_name": None}


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


def test_install_info_never_carries_the_record_or_the_path_beyond_the_three_fields(tmp_path):
    record = {**RECORD, "source": "https://example.invalid/private?token=secret", "update_url": "https://x.invalid"}

    info = install_info(record, _folder(tmp_path, "folder"), None)

    assert sorted(info) == ["catalog_name", "commit", "kind"]
    assert "secret" not in repr(info) and str(tmp_path) not in repr(info)
