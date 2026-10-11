"""The legacy tool-name alias the raw-cron gate relies on.

`policy.py` blocks `cronjob_manage` with `action: create` and tells agents to
use `ergates_create_reminder` instead (`test_pre_tool_call.py` pins the gate
mechanics themselves). That only closes the raw creation path
because Hermes canonicalizes a model's `cronjob` tool call to `cronjob_manage`
*before* dispatch and *before* the `pre_tool_call` hook runs, on both of its
call paths -- so a model that asks for the legacy name `cronjob` is blocked
exactly like one that asks for `cronjob_manage`, and the gate never sees the
alias.
"""

from __future__ import annotations

import ast

from pinned import PinnedSource

MODEL_TOOLS = "model_tools.py"
TOOL_EXECUTOR = "agent/tool_executor.py"


def _literal_entries(hermes: PinnedSource, relative: str, name: str) -> dict[object, object]:
    """The constant `key: value` entries of the module-level dict `name`; `**spread` entries are skipped."""
    node = next(
        n for n in hermes.tree(relative).body
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)
    )
    assert isinstance(node.value, ast.Dict)
    return {
        key.value: value.value for key, value in zip(node.value.keys, node.value.values)
        if isinstance(key, ast.Constant) and isinstance(value, ast.Constant)
    }


def test_the_legacy_alias_maps_cronjob_to_cronjob_manage(hermes: PinnedSource) -> None:
    # model_tools.py:613-616. The dict now opens with a `**dict.fromkeys(...)` spread for the
    # todo aliases, so it is no longer a plain literal; the cronjob entry is still a constant.
    aliases = _literal_entries(hermes, MODEL_TOOLS, "_LEGACY_TOOL_ALIASES")
    assert aliases["cronjob"] == "cronjob_manage"


def test_model_tools_own_dispatch_canonicalizes_before_running_the_tool(hermes: PinnedSource) -> None:
    # model_tools.py:892
    assert hermes.lines(MODEL_TOOLS, 892, 892) == (
        "    function_name = _LEGACY_TOOL_ALIASES.get(function_name, function_name)"
    )


def test_the_agent_loop_canonicalizes_before_the_pre_tool_call_hook_too(hermes: PinnedSource) -> None:
    # agent/tool_executor.py:460 (in `_parse_tool_call`, which both the sequential and the
    # concurrent path run before the hook), calling the helper defined at 388-392
    assert hermes.lines(TOOL_EXECUTOR, 460, 460) == "    name = _canonical_tool_name(tool_call.function.name)"
    assert hermes.lines(TOOL_EXECUTOR, 388, 392) == (
        "def _canonical_tool_name(function_name: str) -> str:\n"
        '    """Map legacy tool-name aliases BEFORE agent-loop dispatch."""\n'
        "    from model_tools import _LEGACY_TOOL_ALIASES as _lta\n"
        "\n"
        "    return _lta.get(function_name, function_name)"
    )
