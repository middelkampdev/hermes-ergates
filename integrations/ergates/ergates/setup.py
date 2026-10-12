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

import logging
import os
from pathlib import Path
from typing import Optional

from .proposals import ProposalError
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

    ``Path.mkdir(parents=True)`` gives only the leaf its ``mode``; a missing
    parent gets the default mode. The store folder must be 0700 even when the
    installer runs before the store first opens, so it is created first, on
    its own.
    """
    target = Path(target)
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target.mkdir(mode=0o700, exist_ok=True)
    for template_id, content in templates.items():
        staging = target / f".{template_id}.json.tmp"
        staging.write_bytes(content)
        os.replace(staging, target / f"{template_id}.json")
    for installed in target.glob("*.json"):
        if installed.stem not in templates:
            installed.unlink()


def templates_match(templates: dict[str, bytes], target: Path) -> bool:
    """True when ``target`` holds exactly ``templates``, byte for byte."""
    installed = {path.stem: path.read_bytes() for path in Path(target).glob("*.json")}
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
