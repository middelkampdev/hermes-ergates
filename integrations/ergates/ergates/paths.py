"""Where the Ergates control store lives on disk.

One store serves every profile and every process of one Hermes install
(ADR-030): ``<hermes root>/ergates/control.sqlite3``. The Hermes
root is not the ``HERMES_HOME`` of the running process: a named profile runs
with ``HERMES_HOME=<root>/profiles/<name>``, and a store opened there would
split the integration's state per profile.
"""

from __future__ import annotations

import os
from pathlib import Path

from .hermes_adapter import default_hermes_root

STORE_DIR_NAME = "ergates"
STORE_FILE_NAME = "control.sqlite3"
TEMPLATES_DIR_NAME = "templates"


def hermes_root() -> Path:
    """The Hermes root directory that every profile shares.

    Inside Hermes this is ``hermes_constants.get_default_hermes_root()``.
    Outside Hermes (``python -m ergates.flush`` without the Hermes runtime,
    the test suite) it is ``$HERMES_HOME``, mapped from
    ``<root>/profiles/<name>`` back to ``<root>`` the way Hermes maps it, and
    else ``~/.hermes``.
    """
    root = default_hermes_root()
    if root is not None:
        return root
    env_home = os.environ.get("HERMES_HOME", "").strip()
    if not env_home:
        return Path.home() / ".hermes"
    home = Path(env_home).expanduser()
    return home.parent.parent if home.parent.name == "profiles" else home


def store_path(root: Path) -> Path:
    """``<root>/ergates/control.sqlite3``: the one control store of a Hermes install."""
    return Path(root) / STORE_DIR_NAME / STORE_FILE_NAME


def templates_dir(root: Path) -> Path:
    """``<root>/ergates/templates``: the proposal templates of a Hermes install."""
    return Path(root) / STORE_DIR_NAME / TEMPLATES_DIR_NAME


def bundled_templates_dir() -> Path:
    """``<plugin folder>/templates``: the proposal templates the plugin ships.

    They sit in the plugin folder, so a git install and a read-only mount of
    that folder carry them. :func:`ergates.setup.ensure_templates` copies
    them into :func:`templates_dir`, the folder the accept route reads.
    """
    return Path(__file__).resolve().parents[1] / TEMPLATES_DIR_NAME
