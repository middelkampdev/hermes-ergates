"""Hermes's own catalog validator admits the plugin tree.

`hermes plugins validate` is the command the catalog's admission CI runs on a
candidate plugin (`hermes_cli/plugin_validate.py` at the pin). It imports the
plugin in a scratch process and compares what `register()` actually
registered with the manifest's `provides_*` lists (rule 6), refuses a plugin
that rebinds Hermes core at runtime (rule 9), reads the dependency
declaration (rule 10), runs the install scan and parses `requires_hermes`
(rule 14). This test runs it on the files git tracks in `integrations/ergates`,
the tree a catalog install gets, and asks for no warnings at all.

The plugin declares no Python dependency, so `--install-deps` has nothing to
install; it would also build a dependency environment from the Hermes
checkout (`hermes_cli/plugins_cmd_catalog.py` `cmd_validate`), which this
suite keeps untouched.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from pinned import HERMES_PIN_VERSION
from plugin_tree import copy_tracked_files


def test_hermes_plugins_validate_admits_the_plugin_tree(tmp_path: Path) -> None:
    tree = tmp_path / "ergates"
    copy_tracked_files(tree)
    home, root = tmp_path / "home", tmp_path / "hermes"
    home.mkdir()
    root.mkdir()
    # security.allow_lazy_installs: false blocks Hermes's lazy `uv pip install`, which would
    # otherwise wait out its install timeout for a provider stack the validator never needs.
    (root / "config.yaml").write_text("security:\n  allow_lazy_installs: false\n", encoding="utf-8")
    env = {**os.environ, "HOME": str(home), "HERMES_HOME": str(root), "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHONPATH": str(Path(os.environ["HERMES_SOURCE"]).expanduser().resolve())}

    run = subprocess.run([sys.executable, "-B", "-m", "hermes_cli.main", "plugins", "validate", "--json", str(tree)],
                         cwd=tmp_path, env=env, capture_output=True, text=True, check=False, timeout=300)

    print(run.stdout)
    print(run.stderr)
    report = json.loads(run.stdout)
    details = {check["name"]: check["detail"] for check in report["checks"]}
    passed = {check["name"]: check["ok"] for check in report["checks"]}
    assert run.returncode == 0 and report["ok"] is True and report["warnings"] == []
    assert details["requires_hermes"] == f"spec '>={HERMES_PIN_VERSION}' parses"
    assert details["config schema"] == "shape valid"
    assert details["python dependencies"] == "none declared"
    assert details["security scan"] == "safe"
    assert {details[name] for name in ("declared tools", "declared hooks", "declared middleware")} == {"matches registrations"}
    assert passed["no core override"] is True
