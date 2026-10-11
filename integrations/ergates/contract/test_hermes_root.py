"""`paths.hermes_root()` uses `hermes_constants.get_default_hermes_root()`.

The control store lives under the Hermes ROOT, shared by every profile. Pins
that the function unwraps `<root>/profiles/<name>` to `<root>`, and that
`hermes_constants` stays importable anywhere (standard library only).
"""

from __future__ import annotations

import ast
import sys

from pinned import PinnedSource

CONSTANTS = "hermes_constants.py"


def test_the_default_root_unwraps_a_profile_home(hermes: PinnedSource) -> None:
    assert hermes.function(CONSTANTS, "get_default_hermes_root").lineno == 216
    # hermes_constants.py:226-233 (env_path is HERMES_HOME, expanded, from line 221)
    assert hermes.lines(CONSTANTS, 226, 233) == (
        "    result = native_home\n"
        "    if env_path is not None:\n"
        "        try:\n"
        "            env_path.resolve().relative_to(native_home.resolve())  # under ~/.hermes (normal or profile mode)\n"
        "        except ValueError:  # Docker/custom root: <root>/profiles/<name> -> <root>, else HERMES_HOME itself\n"
        '            result = env_path.parent.parent if env_path.parent.name == "profiles" else env_path\n'
        "    _default_hermes_root_memo = (*memo_key, result)\n"
        "    return result"
    )


def test_hermes_constants_imports_only_the_standard_library_at_module_level(hermes: PinnedSource) -> None:
    body = hermes.tree(CONSTANTS).body
    names = {alias.name.split(".")[0] for node in body if isinstance(node, ast.Import) for alias in node.names}
    names |= {node.module.split(".")[0] for node in body if isinstance(node, ast.ImportFrom) and node.module}
    # v0.21.6 adds `from collections.abc import MutableMapping` (hermes_constants.py:12).
    assert names == {"collections", "contextlib", "contextvars", "os", "pathlib", "re", "shutil", "stat", "sys"}
    assert names <= set(sys.stdlib_module_names)
