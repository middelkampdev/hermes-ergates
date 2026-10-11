"""Comments, docstrings, test names and docs of this package give the reason, not a planning id.

A reader of the code has no upgrade plan or review ledger at hand, so a bug,
decision, ruling or review finding number from one tells them nothing. ADR
numbers (docs/08), docs section numbers, Hermes file:line references and
upstream issue numbers stay: they point at documents in this repository, at
the pinned Hermes or at a public tracker.
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
SKIPPED_PARTS = {"__pycache__", "node_modules"}
PLAN_ID = re.compile(
    r"(?i:\broadmap\b|\breview focus\b|\.superpowers\b|\bimplementer-rules\b"
    r"|\brulings? \d+(?:(?:,| and) \d+)*\b|\bruling,? (?:Critical|Important|Minor) \d+[a-z]?"
    r"|\breview (?:issue|finding|point|comment)s? #?\d+)"
    r"|\b(?:[Dd]ecisions?|[Cc]ontracts?) [CD]\d+\b|\b[CD]\d{1,2}\b|\bPlan \d+\b|\bTask \d+\b|\b[Bb]ug \d+\b"
    r"|\([IM]\d{1,2}\b|\((?:Critical|Important|Minor) \d+[a-z]?\)|\b(?:Critical|Important|Minor) \d+(?:\([a-z]\)|[a-z]\))"
)
# The same ids inside a function or class name, e.g. ``test_bug8_...`` or ``..._c3_body``.
PLAN_ID_IN_NAME = re.compile(
    r"(?i)(?:^|_)(?:bug_?\d+|review_focus|review_(?:issue|finding|point|comment)_?\d+|rulings?_?\d+|roadmap"
    r"|[cd]\d{1,2}|plan_?\d+|task_?\d+)(?=_|$)"
)


def _skipped(path: Path) -> bool:
    """Caches, virtual environments and build output: not written by hand."""
    parts = path.relative_to(PACKAGE).parts[:-1]
    return any(part in SKIPPED_PARTS or part.startswith(".") or part.endswith(".egg-info") for part in parts)


def _python_texts(path: Path):
    """``(line, text)`` of every comment, docstring, function name and class name in a Python file."""
    source = path.read_text(encoding="utf-8")
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            yield token.start[0], token.string
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            docstring = ast.get_docstring(node, clean=False)
            if docstring:
                first = node.body[0].lineno
                for offset, line in enumerate(docstring.splitlines()):
                    yield first + offset, line


def _names(path: Path):
    """``(line, name)`` of every function and class a Python file defines."""
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node.lineno, node.name


def _files():
    for path in sorted(PACKAGE.rglob("*")):
        if not path.is_file() or _skipped(path) or path == Path(__file__):
            continue
        if path.suffix in {".py", ".md", ".yaml", ".json", ".js"}:
            yield path


def test_no_comment_docstring_or_doc_names_a_planning_id():
    found = []
    for path in _files():
        if path.suffix == ".py":
            texts = _python_texts(path)
        else:
            texts = enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        for line, text in texts:
            for match in PLAN_ID.finditer(text):
                found.append(f"{path.relative_to(PACKAGE)}:{line}: {match.group(0)!r} in {text.strip()[:80]!r}")
    assert found == []


def test_no_function_or_class_name_carries_a_planning_id():
    found = [
        f"{path.relative_to(PACKAGE)}:{line}: {name}"
        for path in _files()
        if path.suffix == ".py"
        for line, name in _names(path)
        if PLAN_ID_IN_NAME.search(name)
    ]
    assert found == []


def test_the_patterns_catch_each_kind_of_planning_id():
    for text in (
        "roadmap bug 8",
        "(decision D10: no edits)",
        "roadmap contract C3",
        "Review Focus 3",
        "Plan 5 Task 7",
        "see .superpowers/sdd",
        "implementer-rules",
        "finding (I3)",
        "finding (M13)",
        "precomputed once (review issue 4)",
        "Review finding #2",
        "review point 3",
        "review comments 12",
        "(spec 5.4, ruling 11)",
        "ruling 12",
        "Ruling 12: the last turn",
        "rulings 5 and 6",
        "rulings 3, 4 and 7",
        "(Critical 1a)",
        "(Important 2)",
        "Critical 1(a)",
        "ruling, Critical 1a",
        "(ruling, Critical 1a)",
        "Ruling, Critical 1b: the turn",
        "(spec 12.3 anchor, ruling Critical 1b)",
        "Critical 1b).",
    ):
        assert PLAN_ID.search(text), text
    for name in ("test_bug8_x", "test_review_focus_3_x", "test_x_c3_body", "test_x_c5_shape",
                 "test_review_issue_4_x", "test_ruling_12_x"):
        assert PLAN_ID_IN_NAME.search(name), name


def test_the_patterns_leave_adr_docs_and_hermes_references_alone():
    for text in (
        "ADR-031",
        "docs/04 sections 4 and 8",
        "hermes_cli/plugins.py:397-406",
        "HTTP 400",
        "a SHA-256 digest",
        "cron.manage add",
        "Hermes issue #26847",
        "fixed upstream in issue #123",
        "a GitHub issue",
        "SQLite issues F_FULLFSYNC",
        "a review comment on the pull request",
        "the critical path",
        "a minor version bump",
        "a court ruling",
        "the judge's ruling was final",
        "a controller ruling",
        "Important 3 steps remain",
        "bump to Minor 12",
        "Critical 5 users were affected",
    ):
        assert not PLAN_ID.search(text), text
    for name in ("test_ci_local", "test_decode_utf8", "test_a_template_file_is_read", "test_review_is_skipped",
                 "test_a_court_ruling_stands"):
        assert not PLAN_ID_IN_NAME.search(name), name
