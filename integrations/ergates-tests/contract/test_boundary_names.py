"""The boundary guard knows every name Hermes installs.

`tests/test_hermes_boundary.py` flags imports whose top-level name is in its
HERMES_TOP_LEVEL. This test keeps that set equal to the pinned source: the
packages in Hermes's pyproject.toml plus every root module (Hermes's setup.py
ships each root *.py file except setup.py).
"""

from __future__ import annotations

import importlib.util
import tomllib
from pathlib import Path

from pinned import PinnedSource

GUARD = Path(__file__).resolve().parents[1] / "tests" / "test_hermes_boundary.py"


def test_the_guard_lists_every_hermes_top_level_name(hermes: PinnedSource) -> None:
    pyproject = tomllib.loads(hermes.text("pyproject.toml"))
    packages = {name.split(".")[0] for name in pyproject["tool"]["setuptools"]["packages"]["find"]["include"]}
    root_modules = {path.stem for path in hermes.root.glob("*.py") if path.name != "setup.py"}

    spec = importlib.util.spec_from_file_location("ergates_boundary_guard", GUARD)
    assert spec is not None and spec.loader is not None
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)

    assert guard.HERMES_TOP_LEVEL == frozenset(packages | root_modules)
