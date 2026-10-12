"""The plugin folder users install, and a copy of it with only the files git tracks."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "ergates"
# Keeps every git hook of this machine out of the commands below.
NO_HOOKS = ("-c", "core.hooksPath=/dev/null")


def copy_tracked_files(destination: Path) -> None:
    """Copies every file git tracks in ``PLUGIN_DIR`` to ``destination``, the tree a git install gets.

    Untracked files stay out, so a stray local file (a virtual environment,
    a cache) cannot change the install scan's verdict.
    """
    listed = subprocess.run(
        ["git", *NO_HOOKS, "-C", str(PLUGIN_DIR), "ls-files", "-z", "--cached", "."],
        capture_output=True, check=True,
    ).stdout.decode("utf-8").split("\0")
    for relative in filter(None, listed):
        source = PLUGIN_DIR / relative
        if source.is_file():  # a tracked file deleted in the working tree is listed too
            (destination / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination / relative)
