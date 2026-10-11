"""Hermes boundary guard.

Only ``ergates/hermes_adapter.py`` and ``dashboard/api.py`` may import a Hermes
module. Every other module reaches Hermes through them, so a Hermes upgrade has
two files to check. ``contract/test_boundary_names.py`` keeps HERMES_TOP_LEVEL
equal to the top-level names the pinned Hermes source installs.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "ergates"

ALLOWED = frozenset({"ergates/hermes_adapter.py", "dashboard/api.py"})

# Folders that hold tests, tooling or build output, never integration code.
SKIPPED_DIRS = frozenset({"tests", "contract", ".venv", "__pycache__", ".pytest_cache", "ergates.egg-info"})

# Every top-level import name Hermes installs at the pin: the packages in its
# pyproject.toml plus each root module (setup.py ships every root *.py file).
HERMES_TOP_LEVEL = frozenset({
    "acp_adapter", "agent", "cron", "gateway", "hermes_cli", "hermes_platform", "plugins", "pm", "providers", "tools",
    "tui_gateway",
    "batch_runner", "cli", "hermes_bootstrap", "hermes_constants", "hermes_constants_scratch", "hermes_logging",
    "hermes_startup_watchdog", "hermes_state", "hermes_state_common", "hermes_state_compression",
    "hermes_state_coverage", "hermes_state_dbfile", "hermes_state_errors", "hermes_state_fts", "hermes_state_gateway",
    "hermes_state_guard", "hermes_state_health", "hermes_state_holders", "hermes_state_identity", "hermes_state_ids",
    "hermes_state_lockguard", "hermes_state_lockowners", "hermes_state_maintenance", "hermes_state_messages",
    "hermes_state_pidns", "hermes_state_portability", "hermes_state_profile_repair", "hermes_state_readpool",
    "hermes_state_registry", "hermes_state_repair", "hermes_state_rewind", "hermes_state_schema",
    "hermes_state_search", "hermes_state_sessions", "hermes_state_telegram", "hermes_state_timeline",
    "hermes_state_titles", "hermes_state_tool_retries", "hermes_state_usage", "hermes_state_user_copy",
    "hermes_state_wal", "hermes_time", "hermes_yaml", "mcp_serve", "mini_swe_runner", "model_tools",
    "registration_lifecycle", "run_agent", "toolset_distributions", "toolsets", "trajectory_compressor", "utils",
})


def integration_modules(root: Path = PLUGIN_DIR) -> list[Path]:
    """Every .py file of the integration, relative paths sorted, skipping SKIPPED_DIRS."""
    found: list[Path] = []
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(d for d in subdirs if d not in SKIPPED_DIRS)
        found.extend(Path(directory) / name for name in files if name.endswith(".py"))
    return sorted(found)


def _imported_names(node: ast.AST) -> list[str]:
    """The absolute module names one AST node imports, static or dynamic."""
    if isinstance(node, ast.Import):
        return [alias.name for alias in node.names]
    if isinstance(node, ast.ImportFrom):
        return [node.module] if node.level == 0 and node.module else []
    if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
        func = node.func
        dynamic = (isinstance(func, ast.Name) and func.id in {"__import__", "import_module"}) or (
            isinstance(func, ast.Attribute) and func.attr == "import_module"
        )
        return [node.args[0].value] if dynamic else []
    return []


def hermes_imports(path: Path, root: Path = PLUGIN_DIR) -> list[str]:
    """`<relative path>:<line>: <module>` for each Hermes import in one file."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    relative = path.relative_to(root).as_posix()
    found = [
        (node.lineno, name)
        for node in ast.walk(tree)
        for name in _imported_names(node)
        if name.split(".")[0] in HERMES_TOP_LEVEL
    ]
    return [f"{relative}:{line}: {name}" for line, name in sorted(found)]


def test_only_the_adapter_and_the_dashboard_api_import_hermes() -> None:
    offenders = [
        line
        for path in integration_modules()
        if path.relative_to(PLUGIN_DIR).as_posix() not in ALLOWED
        for line in hermes_imports(path)
    ]
    assert offenders == []


def test_the_guard_sees_every_import_form(tmp_path: Path) -> None:
    probe = tmp_path / "probe.py"
    probe.write_text(
        "import json\n"
        "import hermes_constants\n"
        "from hermes_cli.plugins import invoke_hook\n"
        "from . import sibling\n"
        "import importlib\n"
        "importlib.import_module('tools.registry')\n"
        "__import__('cron.jobs')\n",
        encoding="utf-8",
    )

    assert hermes_imports(probe, root=tmp_path) == [
        "probe.py:2: hermes_constants",
        "probe.py:3: hermes_cli.plugins",
        "probe.py:6: tools.registry",
        "probe.py:7: cron.jobs",
    ]


def test_the_guard_scans_the_entry_point_and_the_package_but_not_tests() -> None:
    scanned = {path.relative_to(PLUGIN_DIR).as_posix() for path in integration_modules()}

    assert {"__init__.py", "ergates/tool.py", "ergates/reminders.py"} <= scanned
    assert not any(name.startswith(("tests/", "contract/", ".venv/")) for name in scanned)
