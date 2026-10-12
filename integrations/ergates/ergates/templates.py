"""Proposal templates: the role a proposed agent is provisioned from.

One JSON file per template, ``<hermes root>/ergates/templates/<template_id>.json``,
with exactly the ``ProposalTemplate`` fields::

    {"template_id": "bookkeeper", "soul": "...",
     "enabled_toolsets": ["file"], "enabled_mcp_servers": []}

The plugin ships them in its own ``templates/`` folder and installs them
(``ergates.setup.ensure_templates``, run by ``hermes serve`` on its first
request and by ``python -m ergates.install``); the server only reads the
installed copies. The accept route answers the template with the accepted
proposal, so the app configures the new profile from what the server holds,
never from what the model proposed.

``enabled_toolsets`` must name at least one toolset: ``profiles.configure``
treats an empty list as "remove the toolset pin", and the new agent would
get Hermes's default toolsets instead of none.

The agents of a Hermes install have a terminal, so one of their processes
can put a symlink, a FIFO or a huge file at a template name. A template is
read relative to its folder, opened without following a symlink, and only
when it is a regular file of at most :data:`MAX_TEMPLATE_BYTES`
(:func:`read_regular_file`); anything else is an unknown template.
``ergates.setup`` installs the templates with the same folder helpers.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import re
import stat
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .proposals import ProposalError

logger = logging.getLogger(__name__)

TEMPLATE_FIELDS = ("template_id", "soul", "enabled_toolsets", "enabled_mcp_servers")
# A template id is a file name: no separators, no leading dot.
_TEMPLATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# Linux and macOS resolve a name against an open folder (``dir_fd``).
# ``os.replace`` takes ``dir_fd`` wherever ``os.rename`` does, although only
# ``os.rename`` is listed in ``os.supports_dir_fd``.
HAS_DIR_FD = {os.open, os.mkdir, os.rename, os.unlink} <= os.supports_dir_fd and os.listdir in os.supports_fd
_FOLDER_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
# O_NOFOLLOW: a symlink fails with ELOOP. O_NONBLOCK: a FIFO opens at once instead of waiting for a writer.
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
# A bundled template is under 2 KB; 1 MiB leaves room and bounds what one planted file makes the plugin read.
MAX_TEMPLATE_BYTES = 1024 * 1024


def read_template(directory: Path, template_id: Any) -> tuple[dict, bytes]:
    """The ``ProposalTemplate`` of ``template_id`` in ``directory``, and the bytes of its file.

    Raises ``ProposalError`` ``unknown_template`` (HTTP 422) when the id is not
    a safe file name, the file is missing, ``directory`` is a symlink, the
    file is not a regular file of at most :data:`MAX_TEMPLATE_BYTES`, or it
    does not hold a valid template for that id. A broken file is logged by
    error class or reason only.
    """
    if not isinstance(template_id, str) or not _TEMPLATE_ID_RE.fullmatch(template_id):
        raise ProposalError("the proposal names no known template", code="unknown_template")
    directory = Path(directory)
    name = f"{template_id}.json"
    try:
        with ExitStack() as open_folders:
            parent = open_root_folder(directory.parent, open_folders)
            folder = open_folder(parent, directory.name, open_folders)
            content = read_regular_file(folder, name)
    except FileNotFoundError:
        raise ProposalError(f"there is no template {template_id!r}", code="unknown_template") from None
    except OSError as exc:
        logger.warning("templates: %s cannot be read (%s)", name, type(exc).__name__)
        raise ProposalError(f"template {template_id!r} cannot be read", code="unknown_template") from None
    if content is None:
        logger.warning("templates: %s is not a regular file of at most %d bytes", name, MAX_TEMPLATE_BYTES)
        raise ProposalError(f"template {template_id!r} cannot be read", code="unknown_template")
    try:
        data = json.loads(content.decode("utf-8"))
    except ValueError as exc:
        logger.warning("templates: %s cannot be read (%s)", name, type(exc).__name__)
        raise ProposalError(f"template {template_id!r} cannot be read", code="unknown_template") from None
    if not _is_template(data, template_id):
        logger.warning("templates: %s is not a valid template", name)
        raise ProposalError(f"template {template_id!r} is not valid", code="unknown_template")
    return {field: data[field] for field in TEMPLATE_FIELDS}, content


def load_template(directory: Path, template_id: Any) -> dict:
    """The ``ProposalTemplate`` of ``template_id`` in ``directory``; see :func:`read_template`."""
    return read_template(directory, template_id)[0]


def _is_template(data: Any, template_id: str) -> bool:
    def strings(value: Any) -> bool:
        return isinstance(value, list) and all(isinstance(item, str) and item for item in value)

    return (
        isinstance(data, dict)
        and data.get("template_id") == template_id
        and isinstance(data.get("soul"), str)
        and strings(data.get("enabled_toolsets"))
        and bool(data["enabled_toolsets"])
        and strings(data.get("enabled_mcp_servers"))
    )


@dataclass(frozen=True)
class Folder:
    """A folder of the install: its path and, where the platform has ``dir_fd``, the descriptor it is open at."""

    path: Path
    fd: Optional[int]

    def entry(self, name: str) -> str:
        """``name`` in this folder, as an ``os`` call that also gets ``dir_fd=self.fd`` takes it."""
        return name if self.fd is not None else str(self.path / name)

    def names(self) -> list[str]:
        return os.listdir(self.fd if self.fd is not None else self.path)


def open_root_folder(path: Path, open_folders: ExitStack) -> Folder:
    """The folder ``path``, opened following a symlink: the operator chooses where the Hermes root is, not an agent."""
    if not HAS_DIR_FD:
        return Folder(path, None)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    open_folders.callback(os.close, fd)
    return Folder(path, fd)


def open_folder(parent: Folder, name: str, open_folders: ExitStack) -> Folder:
    """The existing folder ``name`` in ``parent``.

    Raises ``OSError`` when ``name`` is a symlink or, where the platform has
    ``dir_fd``, a file or missing.
    """
    path = parent.path / name
    if parent.fd is None:
        refuse_a_symlink(path)
        return Folder(path, None)
    fd = os.open(name, _FOLDER_FLAGS, dir_fd=parent.fd)
    open_folders.callback(os.close, fd)
    return Folder(path, fd)


def refuse_a_symlink(folder: Path) -> None:
    if folder.is_symlink():
        raise OSError(errno.ELOOP, "the install does not work through a symlink")


def read_regular_file(folder: Folder, name: str) -> Optional[bytes]:
    """The bytes of ``name`` in ``folder``; ``None`` unless it is a regular file within :data:`MAX_TEMPLATE_BYTES`.

    A symlink is not followed and a FIFO does not block. Raises ``OSError``
    when the name cannot be opened for another reason, such as a missing file.
    """
    try:
        fd = os.open(folder.entry(name), _READ_FLAGS, dir_fd=folder.fd)
    except OSError as exc:
        if exc.errno == errno.ELOOP:  # a symlink
            return None
        raise
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_TEMPLATE_BYTES:
            return None
        content = b""
        while len(content) <= MAX_TEMPLATE_BYTES:  # the file can grow after the fstat
            chunk = os.read(fd, MAX_TEMPLATE_BYTES + 1 - len(content))
            if not chunk:
                break
            content += chunk
    finally:
        os.close(fd)
    return content if len(content) <= MAX_TEMPLATE_BYTES else None
