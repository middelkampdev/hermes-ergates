"""The Hermes texts the app matches are still what the pinned Hermes writes.

Hermes answers a refused plugin install as HTTP 400 with a plain-text
``detail`` and no error code, and a plugin it does not serve as 404
``{"detail": "Plugin not found"}``. The app tells those apart by the start of
the text (``apps/mobile/src/gateway/real/hermes-plugin-messages.json``). A
Hermes release that rewords one would make the app show a failure as an
unknown error, so each text must still be one the pinned source can produce.

Hermes builds some texts with an f-string, for example
``f"Plugin '{plugin_name}' already exists. ..."``. The app's prefix has the
value the app installs filled in (``ergates``), so a prefix matches an f-string
when its literal parts match around each placeholder. ``live/test_hot_mount.py``
checks the same texts against a running server.
"""

from __future__ import annotations

import ast
from collections.abc import Mapping, Sequence
from typing import NamedTuple

import pytest

from app_messages import hermes_plugin_messages
from pinned import PinnedSource

WEB = "hermes_cli/web_server.py"
GIT = "hermes_cli/plugins_cmd_git.py"
# Where a failed install gets its text: the scan, the clone and fetch, the install itself.
INSTALL_SOURCES = ("tools/plugin_guard.py", "hermes_cli/plugins_cmd*.py")

MESSAGES = hermes_plugin_messages()
PREFIXES = [(code, prefix) for code, prefixes in MESSAGES["install"].items() for prefix in prefixes]


class Hole(NamedTuple):
    """A ``{placeholder}`` of an f-string, by its expression."""

    expression: str


Template = list[str | Hole]


def string_templates(tree: ast.AST) -> list[Template]:
    """Every string in ``tree`` as its parts: the text, and a ``Hole`` for each ``{placeholder}`` of an f-string.

    The pieces inside an f-string are not strings of their own; the whole f-string is the one text Hermes writes.
    """
    inside_f_strings = {id(part) for node in ast.walk(tree) if isinstance(node, ast.JoinedStr) for part in node.values}
    templates: list[Template] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in inside_f_strings:
            templates.append([node.value])
        elif isinstance(node, ast.JoinedStr):
            templates.append([part.value if isinstance(part, ast.Constant) else Hole(ast.unparse(part.value)) for part in node.values])
    return templates


def can_start(template: Template, text: str, filled: Mapping[str, Sequence[str]] = {}) -> bool:
    """Whether ``text`` can be the start of what ``template`` writes.

    The template must open with literal text, so a template made of placeholders alone (``f"{a}/{b}"``) matches
    nothing. A placeholder whose expression is in ``filled`` takes one of those values; any other placeholder
    stands for any text, up to the next literal part: a placeholder followed by more template cannot swallow
    the rest of ``text``, or any text would match.
    """
    return bool(template) and isinstance(template[0], str) and _starts(template, text, filled)


def _starts(template: Template, text: str, filled: Mapping[str, Sequence[str]]) -> bool:
    if not text:
        return True
    if not template:
        return False
    head, rest = template[0], template[1:]
    if isinstance(head, Hole):
        if head.expression in filled:
            return any(_starts(rest, text[len(value):], filled) if text.startswith(value) else value.startswith(text)
                       for value in filled[head.expression])
        return not rest or any(_starts(rest, text[taken:], filled) for taken in range(len(text)))
    if text.startswith(head):
        return _starts(rest, text[len(head):], filled)
    return head.startswith(text)


def checkout_verbs(hermes: PinnedSource) -> list[str]:
    """The git phases ``_checkout_exact_revision`` runs, in order: the ``verb`` its failure texts name."""
    function = hermes.function(GIT, "_checkout_exact_revision")
    loop = next(node for node in ast.walk(function) if isinstance(node, ast.For))
    assert isinstance(loop.iter, ast.Tuple)
    return [phase.elts[0].value for phase in loop.iter.elts
            if isinstance(phase, ast.Tuple) and isinstance(phase.elts[0], ast.Constant)]


def install_templates(hermes: PinnedSource) -> list[Template]:
    paths = sorted(path for pattern in INSTALL_SOURCES for path in hermes.root.glob(pattern))
    assert paths, f"the pinned Hermes has no {INSTALL_SOURCES}"
    return [template for path in paths for template in string_templates(ast.parse(path.read_text(encoding="utf-8")))]


def test_the_matching_reads_f_strings_by_their_literal_parts() -> None:
    template = string_templates(ast.parse("""f"Plugin '{name}' already exists. Use {how}." """))[0]

    assert template == ["Plugin '", Hole("name"), "' already exists. Use ", Hole("how"), "."]
    assert can_start(template, "Plugin 'ergates' already exists.")
    assert can_start(template, "Plugin 'ergates' already exists. Use force.")
    assert not can_start(template, "Plugin 'ergates' is pinned.")
    assert not can_start(template, "A plugin 'ergates' already exists.")


def test_a_template_of_placeholders_alone_matches_nothing() -> None:
    template = string_templates(ast.parse("""f"{prefix}/{name}" """))[0]

    assert template == [Hole("prefix"), "/", Hole("name")]
    assert not can_start(template, "Git fetch/checkout of commit '")


def test_a_filled_placeholder_takes_only_its_values() -> None:
    template = string_templates(ast.parse("""f"Git {verb} of commit '{revision}' failed" """))[0]
    verbs = {"verb": ["fetch", "checkout"]}

    assert can_start(template, "Git fetch of commit '", verbs)
    assert can_start(template, "Git checkout of commit '", verbs)
    assert can_start(template, "Git che", verbs)
    assert not can_start(template, "Git fetch/checkout of commit '", verbs)
    assert can_start(template, "Git fetch/checkout of commit '")


@pytest.mark.parametrize(("code", "prefix"), PREFIXES, ids=[f"{code}:{prefix}" for code, prefix in PREFIXES])
def test_every_install_failure_prefix_is_a_text_the_pinned_hermes_writes(hermes: PinnedSource, code: str, prefix: str) -> None:
    """The app installs ``ergates``, so ``plugin_name`` is that, and ``verb`` is a phase of the commit checkout."""
    filled = {"plugin_name": ["ergates"], "verb": checkout_verbs(hermes)}

    assert any(can_start(template, prefix, filled) for template in install_templates(hermes)), (
        f"no string in {INSTALL_SOURCES} at the pin can start with {prefix!r} ({code})"
    )


def test_the_git_phases_that_name_themselves_in_a_failure_are_fetch_and_checkout(hermes: PinnedSource) -> None:
    """``Git {verb} of commit '{revision}' timed out`` fills ``verb`` from the phases of the loop above it."""
    assert checkout_verbs(hermes) == ["fetch", "checkout"]
    function = hermes.function(GIT, "_checkout_exact_revision")
    start = ["Git ", Hole("verb"), " of commit '", Hole("revision"), "' timed out after "]
    assert any(template[:len(start)] == start for template in string_templates(function))


def test_a_plugin_hermes_does_not_serve_answers_404_with_the_detail_the_app_reads(hermes: PinnedSource) -> None:
    """``GET /api/plugins/<name>/...`` for a plugin that is not installed, not enabled or disabled."""
    gate = next(node for node in ast.walk(hermes.tree(WEB)) if isinstance(node, ast.AsyncFunctionDef) and node.name == "_plugin_api_runtime_gate")

    answers = [(call.func.id, {keyword.arg: ast.literal_eval(keyword.value) for keyword in call.keywords})
               for call in ast.walk(gate) if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "JSONResponse"]

    assert answers == [("JSONResponse", {"status_code": 404, "content": {"detail": MESSAGES["pluginNotFound"]}})]


def test_the_messages_file_names_the_failures_the_app_handles() -> None:
    assert sorted(MESSAGES["install"]) == ["already_installed", "download_failed", "enable_refused", "no_git", "scan_blocked"]
    assert all(prefixes and all(isinstance(prefix, str) and prefix for prefix in prefixes) for prefixes in MESSAGES["install"].values())
    assert isinstance(MESSAGES["pluginNotFound"], str) and MESSAGES["pluginNotFound"]
