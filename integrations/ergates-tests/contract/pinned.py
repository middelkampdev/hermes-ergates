"""Read-only helpers over the pinned Hermes source tree."""

from __future__ import annotations

import ast
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Same pin in scripts/ci-local.sh (HERMES_PIN) and .github/workflows/ci.yml (contract job `ref`).
HERMES_PIN = "818c13be1dc4fd28987e1e881a9408224afd4535"
# The release HERMES_PIN is (its tag `v0.21.6`). Move it with HERMES_PIN: the plugin's `requires_hermes`
# floor is this release, and the catalog refuses a floor newer than the current release.
HERMES_PIN_VERSION = "0.21.6"


def expected_ref() -> str:
    """The commit the Hermes checkout must be at: HERMES_EXPECTED_REF when set
    and not empty, else HERMES_PIN. The CI job `contract-latest` sets it to the
    commit of the newest stable Hermes release; scripts/ci-local.sh reads the
    same variable.
    """
    return os.environ.get("HERMES_EXPECTED_REF") or HERMES_PIN


def check_pin(root: Path, pin: str) -> str | None:
    """None if `root` is a git checkout at `pin` with no local edits and no
    untracked files, else an error message naming `root`. Mirrors `check_pin()`
    in scripts/ci-local.sh so the guarantee holds for every way the contract
    tests get invoked, not only the one that goes through that script.
    """
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
    if head.returncode != 0 or head.stdout.strip() != pin:
        found = head.stdout.strip() or head.stderr.strip()
        return f"{root} is not a Hermes checkout at {pin} (found: {found})"
    # `git status --porcelain` also lists untracked files, which `git diff` ignores.
    status = subprocess.run(["git", "-C", str(root), "status", "--porcelain"], capture_output=True, text=True, check=False)
    if status.returncode != 0 or status.stdout.strip():
        return f"{root} is a Hermes checkout at {pin} but has local edits or untracked files; the contract tests need the pinned files as committed"
    return None


@dataclass(frozen=True)
class PinnedSource:
    root: Path

    def text(self, relative: str) -> str:
        return (self.root / relative).read_text(encoding="utf-8")

    def lines(self, relative: str, first: int, last: int) -> str:
        """Lines `first`..`last` (1-based, inclusive), joined with newlines."""
        return "\n".join(self.text(relative).splitlines()[first - 1 : last])

    def tree(self, relative: str) -> ast.Module:
        return ast.parse(self.text(relative), filename=relative)

    def function(self, relative: str, name: str, owner: str | None = None) -> ast.FunctionDef:
        """A module-level function, or a method of the class `owner`."""
        body = self.tree(relative).body
        if owner is not None:
            body = next(n for n in body if isinstance(n, ast.ClassDef) and n.name == owner).body
        return next(n for n in body if isinstance(n, ast.FunctionDef) and n.name == name)

    def assigned(self, relative: str, name: str) -> object:
        """The literal value of a module-level `name = ...` or `name: T = ...`."""
        for node in self.tree(relative).body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
                return _literal(node.value)
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name and node.value is not None:
                return _literal(node.value)
        raise KeyError(f"{relative} assigns no {name}")


def _literal(node: ast.expr) -> object:
    """`ast.literal_eval`, also accepting `frozenset({...})` and `set({...})`."""
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"frozenset", "set"} and len(node.args) == 1:
        return frozenset(ast.literal_eval(node.args[0]))
    return ast.literal_eval(node)
