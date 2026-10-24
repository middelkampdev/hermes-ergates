"""How the plugin on this server got there, as ``GET /health`` reports it.

Two kinds:

* ``git install``: Hermes recorded a 40-hex ``revision`` for the plugin
  (``hermes plugins install``, the dashboard's install route, the catalog)
  and the plugin folder is a real folder. Hermes can reinstall such a plugin
  at a commit, so a client may offer going back to one for this kind only.
* ``manual copy``: anything else. The folder was copied or linked by hand,
  or Hermes's record could not be read.

The answer carries the commit and the catalog entry name only, never the
record's ``source`` (a git URL can hold a credential) or any path.

It also carries ``loaded_commit``: the commit the record named when Hermes
imported this module, the commit of the package code that answers. A
reinstall replaces the files and the record, but Hermes keeps the modules it
imported until it restarts, so ``commit`` and ``loaded_commit`` then differ.
The value lives here, in the package, and not in ``dashboard/api.py``: Hermes
can mount the ``api.py`` of a new install over package modules it imported
from an older tree, and the package is the code that runs then. Reading it
never raises: a read that fails leaves ``None``, and the import goes on.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Mapping, Optional

from . import hermes_adapter

# The step-3 ``dashboard/api.py`` imports this name and passes the marker as a third argument. Both stay so
# that file still mounts over this package until Hermes restarts; the marker itself is ignored.
INSTALL_KIND_ENV = "ERGATES_INSTALL_KIND"
GIT_INSTALL = "git install"
MANUAL_COPY = "manual copy"

_COMMIT = re.compile(r"[0-9a-fA-F]{40}")


def install_info(record: Optional[Mapping], plugin_dir: Optional[Path], _marker: Optional[str] = None) -> dict:
    """``{"kind", "commit", "catalog_name", "loaded_commit"}`` for the install described by Hermes's ``record`` of it.

    ``record`` is Hermes's install record of this plugin (``None`` when there
    is none) and ``plugin_dir`` the plugin folder of the Hermes root.
    ``commit`` is the record's revision in lower case and ``catalog_name`` the
    name of its ``catalog`` entry; both are ``None`` unless the kind is
    ``git install``.
    A symlink at ``plugin_dir`` is a manual copy even with a record: Hermes
    installs a real folder, so the link points at a checkout somebody else
    manages. ``loaded_commit`` is the ``commit`` this module found when it was
    imported, whatever the arguments say (see the module's docstring).
    """
    return {**_described(record, plugin_dir), "loaded_commit": _loaded_commit}


def read_install() -> dict:
    """:func:`install_info` for this server now: Hermes's record and the plugin folder, read at each call."""
    return install_info(hermes_adapter.install_record(), hermes_adapter.root_plugin_dir())


def _described(record: Optional[Mapping], plugin_dir: Optional[Path]) -> dict:
    commit = _commit(record)
    if commit is None or not _is_real_folder(plugin_dir):
        return _info(MANUAL_COPY)
    return _info(GIT_INSTALL, commit, _catalog_name(record))


def _info(kind: str, commit: Optional[str] = None, catalog_name: Optional[str] = None) -> dict:
    return {"kind": kind, "commit": commit, "catalog_name": catalog_name}


def _commit(record: Optional[Mapping]) -> Optional[str]:
    revision = record.get("revision") if isinstance(record, Mapping) else None
    if isinstance(revision, str) and _COMMIT.fullmatch(revision):
        return revision.lower()
    return None


def _catalog_name(record: Mapping) -> Optional[str]:
    catalog = record.get("catalog")
    name = catalog.get("name") if isinstance(catalog, Mapping) else None
    return name if isinstance(name, str) else None


def _is_real_folder(path: Optional[Path]) -> bool:
    """A folder that is not a symlink; ``os.path`` answers ``False`` for anything it cannot read."""
    return path is not None and os.path.isdir(path) and not os.path.islink(path)


def _commit_at_import() -> Optional[str]:
    """The record's commit as :func:`read_install` would read it now, or ``None``. Never raises: it runs at import."""
    try:
        described = _described(hermes_adapter.install_record(), hermes_adapter.root_plugin_dir())
    except Exception:  # an import that raised would keep the routes from mounting
        return None
    return described["commit"]


_loaded_commit: Optional[str] = _commit_at_import()
