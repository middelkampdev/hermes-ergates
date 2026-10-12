"""The folder users install holds runtime code only."""

from __future__ import annotations

from pathlib import Path

from plugin_tree import copy_tracked_files


def _tracked_tree(tmp_path: Path) -> Path:
    tree = tmp_path / "ergates"
    copy_tracked_files(tree)
    assert (tree / "plugin.yaml").is_file() and (tree / "__init__.py").is_file()
    return tree


def test_the_plugin_tree_holds_no_test_code(tmp_path: Path) -> None:
    """Tests, fixtures and their sample credentials stay in ``integrations/ergates-tests``."""
    tree = _tracked_tree(tmp_path)

    found = sorted(
        path.relative_to(tree).as_posix()
        for path in tree.rglob("*")
        if path.name in {"tests", "contract", "conftest.py"} or path.name.startswith("test_")
    )
    assert found == []
