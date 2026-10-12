"""The plugin sets itself up: the proposal templates it ships, and its own enablement in every profile.

The templates live in the plugin folder (``paths.bundled_templates_dir``),
so a git install and a read-only mount of that folder both carry them.
:func:`ensure_templates` copies them into ``<hermes root>/ergates/templates/``,
where the accept route reads them. ``hermes serve`` runs it once, when it
builds its operations, and ``python -m ergates.install`` runs the same code.
``POST /setup`` and ``python -m ergates.install`` then enable the plugin in
every profile with :func:`enable_everywhere` and report it with
:func:`setup_report`.

Every ``<template_id>.json`` in the source folder must be a template the
accept route would serve (:func:`ergates.templates.load_template`). The
target then holds exactly the source set: a template the source no longer
has is removed there. When any source template is invalid, the source is
missing or empty, or this process runs as root on a Hermes root another user
owns, nothing is written and the target keeps what it has.

``ensure_templates`` and ``templates_state`` return a state and do not raise,
because the router must keep serving when a template cannot be installed: a
missing template is a 422 on accept for that template, not a dead API.
"""

from __future__ import annotations

import errno
import logging
import os
import secrets
import stat
from contextlib import ExitStack, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .proposals import ProposalError
from .store import ROOT_REFUSAL, root_run_would_break
from .templates import load_template

logger = logging.getLogger(__name__)

INSTALLED = "installed"  # the target holds exactly the source set
DIFFER = "differ"  # the target holds something else (``templates_state`` only)
INVALID = "invalid"  # a source template the accept route would refuse (``templates_state``: also a bad target file)
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

    The agents of a Hermes install have a terminal, so one of their
    processes can put a symlink in these folders, or swap a folder for one,
    at any moment. The install never works through a symlink: the store
    folder and ``target`` are opened with ``O_NOFOLLOW`` (a symlink there
    raises ``OSError``), and every name below them is resolved against
    those open folders, so a folder swapped later changes nothing
    (:func:`_replace_file`). Windows has no ``dir_fd``, so names are
    resolved by path there.

    Both folders are made 0700, one at a time, because ``hermes serve``
    installs the templates before it opens the store, and the store folder
    must be private from the start. Callers go through
    :func:`ensure_templates`, which installs nothing as root on a Hermes
    root another user owns.
    """
    target = Path(target)
    hermes_root = target.parent.parent
    hermes_root.mkdir(parents=True, exist_ok=True)
    with ExitStack() as open_folders:
        root_folder = _open_hermes_root(hermes_root, open_folders)
        store_folder = _make_folder(root_folder, target.parent.name, open_folders)
        templates_folder = _make_folder(store_folder, target.name, open_folders)

        for template_id, content in templates.items():
            _replace_file(templates_folder, f"{template_id}.json", content)

        # Names only: no file is opened, and unlink removes a symlink itself.
        for name in templates_folder.names():
            if name.endswith(".json") and Path(name).stem not in templates:
                os.unlink(templates_folder.entry(name), dir_fd=templates_folder.fd)


# Linux and macOS resolve a name against an open folder (``dir_fd``).
# ``os.replace`` takes ``dir_fd`` wherever ``os.rename`` does, although only
# ``os.rename`` is listed in ``os.supports_dir_fd``.
_HAS_DIR_FD = {os.open, os.mkdir, os.rename, os.unlink} <= os.supports_dir_fd and os.listdir in os.supports_fd
_FOLDER_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
# O_CREAT with O_EXCL fails on any name that exists, a symlink included, and never follows one.
_STAGING_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
# O_NOFOLLOW: a symlink fails with ELOOP. O_NONBLOCK: a FIFO opens at once instead of waiting for a writer.
_READ_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
# A bundled template is under 2 KB; 1 MiB leaves room and bounds what one planted file makes the plugin read.
MAX_TEMPLATE_BYTES = 1024 * 1024


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
    """The Hermes root, opened following a symlink: the operator chooses the root, not an agent."""
    if not _HAS_DIR_FD:
        return _Folder(hermes_root, None)
    fd = os.open(hermes_root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    open_folders.callback(os.close, fd)
    return _Folder(hermes_root, fd)


def _make_folder(parent: _Folder, name: str, open_folders: ExitStack) -> _Folder:
    """The folder ``name`` in ``parent``, made 0700 when it does not exist; see :func:`_open_folder`."""
    with suppress(FileExistsError):
        os.mkdir(parent.entry(name), 0o700, dir_fd=parent.fd)
    return _open_folder(parent, name, open_folders)


def _open_folder(parent: _Folder, name: str, open_folders: ExitStack) -> _Folder:
    """The existing folder ``name`` in ``parent``.

    Raises ``OSError`` when ``name`` is a symlink or, where the platform has
    ``dir_fd``, a file or missing.
    """
    path = parent.path / name
    if parent.fd is None:
        _refuse_a_symlink(path)
        return _Folder(path, None)
    fd = os.open(name, _FOLDER_FLAGS, dir_fd=parent.fd)
    open_folders.callback(os.close, fd)
    return _Folder(path, fd)


def _replace_file(folder: _Folder, name: str, content: bytes) -> None:
    """Make ``name`` in ``folder`` hold ``content``, swapped in whole by ``os.replace``.

    The staging file gets a random name and is created with ``O_EXCL``, so
    nothing another process put there is ever opened, and two processes
    installing at the same moment each write their own. ``os.replace``
    then replaces a symlink at the final name instead of following it. A
    failure removes the staging file before the error goes up. The file is
    created 0644 less the umask, the mode a plain write gave it.
    """
    staging = f".{Path(name).stem}.{secrets.token_hex(8)}.tmp"
    fd = os.open(folder.entry(staging), _STAGING_FLAGS, 0o644, dir_fd=folder.fd)
    try:
        with open(fd, "wb") as staged:  # closes fd before the rename: Windows renames no open file
            staged.write(content)
        os.replace(folder.entry(staging), folder.entry(name), src_dir_fd=folder.fd, dst_dir_fd=folder.fd)
    except BaseException:
        with suppress(OSError):
            os.unlink(folder.entry(staging), dir_fd=folder.fd)
        raise


def _refuse_a_symlink(folder: Path) -> None:
    if folder.is_symlink():
        raise OSError(errno.ELOOP, "the install does not work through a symlink")


def _installed_templates(target: Path) -> Optional[dict[str, bytes]]:
    """``{template_id: bytes}`` of every ``*.json`` in ``target``; ``{}`` when a folder on the way is missing.

    The files are read relative to the open folder, the way
    :func:`install_templates` writes them. ``None`` when one of them is not
    a regular file of at most :data:`MAX_TEMPLATE_BYTES` (a symlink, a
    FIFO, a folder, an oversized file): it is not followed and not read.
    Raises ``OSError`` when the store folder or ``target`` is a symlink or
    a file.
    """
    target = Path(target)
    with ExitStack() as open_folders:
        try:
            root_folder = _open_hermes_root(target.parent.parent, open_folders)
            store_folder = _open_folder(root_folder, target.parent.name, open_folders)
            templates_folder = _open_folder(store_folder, target.name, open_folders)
            names = templates_folder.names()
        except FileNotFoundError:
            return {}
        installed: dict[str, bytes] = {}
        for name in sorted(names):
            if not name.endswith(".json"):
                continue
            content = _read_template_file(templates_folder, name)
            if content is None:
                return None
            installed[Path(name).stem] = content
        return installed


def _read_template_file(folder: _Folder, name: str) -> Optional[bytes]:
    """The bytes of ``name`` in ``folder``; ``None`` unless it is a regular file within :data:`MAX_TEMPLATE_BYTES`."""
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


def templates_match(templates: dict[str, bytes], target: Path) -> bool:
    """True when ``target`` holds exactly ``templates``, byte for byte.

    False as well when an entry there is not a regular file of at most
    :data:`MAX_TEMPLATE_BYTES`, which the install then replaces or
    removes. Raises ``OSError`` when ``target`` or the store folder above
    it is a symlink, which :func:`install_templates` refuses, so
    ``ensure_templates`` is then ``FAILED`` and ``templates_state`` is
    ``DIFFER``.
    """
    installed = _installed_templates(target)
    return installed is not None and installed == templates


def ensure_templates(source: Path, target: Path) -> str:
    """Make ``target`` hold exactly the templates in ``source``; the state it ends in.

    ``INSTALLED`` when the target now equals the source (a target that
    already did is not written again), else ``INVALID``, ``MISSING`` or
    ``FAILED``, and then nothing more is written. ``FAILED`` without reading
    or writing the target when this process runs as root and another user
    owns the Hermes root (:func:`ergates.store.root_run_would_break`).
    Never raises. A state other than ``INSTALLED`` is logged by state and
    exception class, or by that short reason: a path or a template's text
    must not reach the log.
    """
    error: Optional[Exception] = None
    try:
        if root_run_would_break(Path(target).parent.parent):
            logger.warning("setup: templates %s (%s)", FAILED, ROOT_REFUSAL)
            return FAILED
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

    ``INVALID`` also when an entry in the target is not a regular file of at
    most :data:`MAX_TEMPLATE_BYTES`. A source that cannot be read counts as
    ``MISSING``, a target that cannot be read as ``DIFFER``, so a health
    report built on this never raises.
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
        installed = _installed_templates(target)
    except OSError:
        return DIFFER
    if installed is None:
        return INVALID
    return INSTALLED if installed == templates else DIFFER


def enable_everywhere(
    profiles: list[str], enable: Callable[[str], None], enabled: Callable[[str], bool],
) -> list[dict]:
    """Enable the plugin in each of ``profiles`` and say, per profile, whether it is.

    ``{"name": ..., "enabled": ...}`` for each, in order, plus ``"error"``
    (the exception class only: its message can carry a path) when ``enable``
    or ``enabled`` raised for that profile. A profile that fails never stops
    the others, so one hand-copied ``plugins/ergates`` folder leaves the rest
    set up and shows in the report. ``enabled`` is asked after ``enable``, so
    the report shows what Hermes would load.
    """
    report = []
    for name in profiles:
        item = {"name": name, "enabled": False}
        try:
            enable(name)
            item["enabled"] = bool(enabled(name))
        except Exception as exc:  # one broken profile must not stop the others
            item["error"] = type(exc).__name__
        report.append(item)
    return report


def setup_report(templates: str, profiles: list[dict]) -> dict:
    """The body of ``POST /setup``: ``templates`` is the state :func:`ensure_templates` ended in.

    ``finished`` is true only when the templates are ``INSTALLED``, there is
    at least one profile, and every profile is enabled.
    """
    finished = templates == INSTALLED and bool(profiles) and all(item["enabled"] for item in profiles)
    return {"finished": finished, "templates": templates, "profiles": profiles}
