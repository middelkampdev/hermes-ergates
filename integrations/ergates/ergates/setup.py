"""The plugin sets itself up: the proposal templates it ships.

The templates live in the plugin folder (``paths.bundled_templates_dir``),
so a git install and a read-only mount of that folder both carry them.
:func:`ensure_templates` copies them into ``<hermes root>/ergates/templates/``,
where the accept route reads them. ``hermes serve`` runs it once, when it
builds its operations, and ``python -m ergates.install`` runs the same code.

Every ``<template_id>.json`` in the source folder must be a template the
accept route would serve (:func:`ergates.templates.load_template`). The
target then holds exactly the source set: a template the source no longer
has is removed there. When any source template is invalid, or the source is
missing or empty, nothing is written and the target keeps what it has.

``ensure_templates`` and ``templates_state`` return a state and do not raise,
because the router must keep serving when a template cannot be installed: a
missing template is a 422 on accept for that template, not a dead API.
"""

from __future__ import annotations

import errno
import logging
import os
import secrets
from contextlib import ExitStack, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .proposals import ProposalError
from .store import give_open_file_to_hermes_owner, hermes_owner
from .templates import load_template

logger = logging.getLogger(__name__)

INSTALLED = "installed"  # the target holds exactly the source set
DIFFER = "differ"  # the target holds something else (``templates_state`` only)
INVALID = "invalid"  # a source template is one the accept route would refuse
MISSING = "missing"  # the source folder is absent or holds no ``*.json``
FAILED = "failed"  # the source or target could not be read or written


class TemplateSourceError(Exception):
    """A source template the accept route would refuse; ``names`` lists the files."""

    def __init__(self, names: list[str]) -> None:
        super().__init__(f"invalid templates: {', '.join(names)}")
        self.names = names


def source_templates(source: Path) -> dict[str, bytes]:
    """``{template_id: file bytes}`` of every template in ``source``; raises ``TemplateSourceError``."""
    templates: dict[str, bytes] = {}
    invalid: list[str] = []
    for path in sorted(Path(source).glob("*.json")):
        try:
            load_template(path.parent, path.stem)
        except ProposalError:
            invalid.append(path.name)
            continue
        templates[path.stem] = path.read_bytes()
    if invalid:
        raise TemplateSourceError(invalid)
    return templates


def install_templates(templates: dict[str, bytes], target: Path) -> None:
    """Make ``target`` hold exactly ``templates``; each file is replaced atomically.

    ``hermes serve`` may run as root, while ``<hermes root>/ergates`` belongs
    to the ``hermes`` user, whose agents have a terminal. A process of that
    user can put a symlink in these folders, or swap a folder for one, at any
    moment. So the install never works through a symlink: the store folder
    and ``target`` are opened with ``O_NOFOLLOW`` (a symlink there raises
    ``OSError``), every name below them is resolved against those open
    folders, so a folder swapped later changes nothing, and owners change
    through descriptors only (:func:`_replace_file`). Windows has no
    ``dir_fd`` and no root, so names are resolved by path there.

    ``hermes serve`` installs the templates before it opens the store, so a
    root process on a fresh root owned by the ``hermes`` user creates the
    store folder here and the store finds it. Every folder and file this call
    makes is therefore handed to the owner of the Hermes root the way the
    store hands over its own (:func:`ergates.store.give_to_hermes_owner`).
    Both folders are made 0700, one at a time, because the store folder must
    be private even when the install runs before the store first opens.
    """
    target = Path(target)
    hermes_root = target.parent.parent
    hermes_root.mkdir(parents=True, exist_ok=True)
    owner = hermes_owner(hermes_root)
    with ExitStack() as open_folders:
        root_folder = _open_hermes_root(hermes_root, open_folders)
        store_folder = _open_folder(root_folder, target.parent.name, owner, open_folders)
        templates_folder = _open_folder(store_folder, target.name, owner, open_folders)

        for template_id, content in templates.items():
            _replace_file(templates_folder, f"{template_id}.json", content, owner)

        for name in templates_folder.names():
            if name.endswith(".json") and Path(name).stem not in templates:
                os.unlink(templates_folder.entry(name), dir_fd=templates_folder.fd)  # never follows a symlink


# Linux and macOS resolve a name against an open folder (``dir_fd``).
# ``os.replace`` takes ``dir_fd`` wherever ``os.rename`` does, although only
# ``os.rename`` is listed in ``os.supports_dir_fd``.
_HAS_DIR_FD = {os.open, os.mkdir, os.rename, os.unlink} <= os.supports_dir_fd and os.listdir in os.supports_fd
_FOLDER_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
# O_CREAT with O_EXCL fails on any name that exists, a symlink included, and never follows one.
_STAGING_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)


@dataclass(frozen=True)
class _Folder:
    """A folder of the install: its path and, where the platform has ``dir_fd``, the descriptor it is open at."""

    path: Path
    fd: Optional[int]

    def entry(self, name: str) -> str:
        """``name`` in this folder, as an ``os`` call that also gets ``dir_fd=self.fd`` takes it."""
        return name if self.fd is not None else str(self.path / name)

    def names(self) -> list[str]:
        return os.listdir(self.fd if self.fd is not None else self.path)


def _open_hermes_root(hermes_root: Path, open_folders: ExitStack) -> _Folder:
    """The Hermes root, opened following a symlink: the operator chooses the root, not the ``hermes`` user."""
    if not _HAS_DIR_FD:
        return _Folder(hermes_root, None)
    fd = os.open(hermes_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    open_folders.callback(os.close, fd)
    return _Folder(hermes_root, fd)


def _open_folder(parent: _Folder, name: str, owner: Optional[tuple[int, int]], open_folders: ExitStack) -> _Folder:
    """The folder ``name`` in ``parent``, made 0700 and handed to ``owner`` when this call creates it.

    Raises ``OSError`` when ``name`` is a symlink or, where the platform has
    ``dir_fd``, a file.
    """
    try:
        os.mkdir(parent.entry(name), 0o700, dir_fd=parent.fd)
        is_new = True
    except FileExistsError:
        is_new = False

    path = parent.path / name
    if parent.fd is None:
        _refuse_a_symlink(path)
        return _Folder(path, None)

    fd = os.open(name, _FOLDER_FLAGS, dir_fd=parent.fd)
    open_folders.callback(os.close, fd)
    if is_new:
        give_open_file_to_hermes_owner(fd, name, owner)
    return _Folder(path, fd)


def _replace_file(folder: _Folder, name: str, content: bytes, owner: Optional[tuple[int, int]]) -> None:
    """Make ``name`` in ``folder`` hold ``content``, swapped in whole by ``os.replace``.

    The staging file gets a random name and is created with ``O_EXCL``, so
    nothing another process put there is ever opened, and two processes
    installing at the same moment each write their own. It is handed to
    ``owner`` through its descriptor before it takes the final name;
    ``os.replace`` then replaces a symlink at that name instead of following
    it. A failure removes the staging file before the error goes up. The
    file is created 0644 less the umask, the mode a plain write gave it.
    """
    staging = f".{Path(name).stem}.{secrets.token_hex(8)}.tmp"
    fd = os.open(folder.entry(staging), _STAGING_FLAGS, 0o644, dir_fd=folder.fd)
    try:
        with open(fd, "wb") as staged:  # closes fd before the rename: Windows renames no open file
            staged.write(content)
            give_open_file_to_hermes_owner(fd, name, owner)
        os.replace(folder.entry(staging), folder.entry(name), src_dir_fd=folder.fd, dst_dir_fd=folder.fd)
    except BaseException:
        with suppress(OSError):
            os.unlink(folder.entry(staging), dir_fd=folder.fd)
        raise


def _refuse_a_symlink(folder: Path) -> None:
    if folder.is_symlink():
        raise OSError(errno.ELOOP, "the install does not work through a symlink")


def templates_match(templates: dict[str, bytes], target: Path) -> bool:
    """True when ``target`` holds exactly ``templates``, byte for byte.

    Raises ``OSError`` when ``target`` or the store folder above it is a
    symlink, which :func:`install_templates` refuses, so ``ensure_templates``
    is then ``FAILED`` and ``templates_state`` is ``DIFFER``.
    """
    target = Path(target)
    for folder in (target.parent, target):
        _refuse_a_symlink(folder)
    installed = {path.stem: path.read_bytes() for path in target.glob("*.json")}
    return installed == templates


def ensure_templates(source: Path, target: Path) -> str:
    """Make ``target`` hold exactly the templates in ``source``; the state it ends in.

    ``INSTALLED`` when the target now equals the source (a target that
    already did is not written again), else ``INVALID``, ``MISSING`` or
    ``FAILED``, and then nothing more is written. Never raises. A state other
    than ``INSTALLED`` is logged by state and exception class only: a path or
    a template's text must not reach the log.
    """
    error: Optional[Exception] = None
    try:
        templates = source_templates(source)
        if not templates:
            state = MISSING
        else:
            if not templates_match(templates, target):
                install_templates(templates, target)
            state = INSTALLED
    except TemplateSourceError as exc:
        state, error = INVALID, exc
    except Exception as exc:  # the router must keep serving whatever went wrong here
        state, error = FAILED, exc
    if state != INSTALLED:
        if error is None:
            logger.warning("setup: templates %s", state)
        else:
            logger.warning("setup: templates %s (%s)", state, type(error).__name__)
    return state


def templates_state(source: Path, target: Path) -> str:
    """``INSTALLED``, ``DIFFER``, ``INVALID`` or ``MISSING``; reads only, writes nothing.

    A source that cannot be read counts as ``MISSING``, a target that cannot
    be read as ``DIFFER``, so a health report built on this never raises.
    """
    try:
        templates = source_templates(source)
    except TemplateSourceError:
        return INVALID
    except OSError:
        return MISSING
    if not templates:
        return MISSING
    try:
        return INSTALLED if templates_match(templates, target) else DIFFER
    except OSError:
        return DIFFER
