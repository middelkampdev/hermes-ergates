"""Hermes's install scan rates the plugin tree a user installs ``safe``.

Hermes scans every plugin install (``tools/plugin_guard.py``): ``safe``
installs, ``caution`` needs a confirmation the app's one-tap setup cannot
show, and ``dangerous`` is blocked even with ``force``. The scan reads the
files git tracks in ``integrations/ergates``, the tree a git install gets.
The plugin's tests live in ``integrations/ergates-tests`` so that tree holds
only runtime code.

The pinned scanner is standard-library Python, so this test runs it in a
child process, with ``-B`` so no bytecode lands in the pinned checkout, and
this test process never imports Hermes. ``live/test_hot_mount.py`` checks the
same verdict through a real install.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from pinned import PinnedSource
from plugin_tree import copy_tracked_files

# Prints the verdict and every finding of ``scan_plugin(<tree>)``, run with the Hermes root first on sys.path.
SCAN = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from tools.plugin_guard import format_scan_report, scan_plugin
result = scan_plugin(Path(sys.argv[2]))
print(format_scan_report(result), file=sys.stderr)
print(json.dumps({"verdict": result.verdict,
                  "findings": [[f.severity, f.pattern_id, f.file] for f in result.findings]}))
"""


def _tracked_tree(tmp_path: Path) -> Path:
    tree = tmp_path / "ergates"
    copy_tracked_files(tree)
    assert (tree / "plugin.yaml").is_file() and (tree / "__init__.py").is_file()
    return tree


def test_the_install_scan_rates_the_plugin_tree_safe(hermes: PinnedSource, tmp_path: Path) -> None:
    tree = _tracked_tree(tmp_path)

    run = subprocess.run([sys.executable, "-I", "-B", "-c", SCAN, str(hermes.root), str(tree)],
                         capture_output=True, text=True, check=False, timeout=300)

    print(run.stderr)
    assert run.returncode == 0, run.stderr
    report = json.loads(run.stdout)
    blocking = sorted(finding for finding in report["findings"] if finding[0] in {"high", "critical"})
    assert (report["verdict"], blocking) == ("safe", [])
