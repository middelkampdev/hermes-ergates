"""A finished routine turn is a `post_llm_call` with `platform="cron"`.

`tool.on_turn_completed` reads only the `session_id` and `platform` keywords
of `post_llm_call`, and pushes "A routine finished" for the platforms in
`attention.completed_platforms` (default: `cron`). Pins the chain that makes
that work: cron builds its agent with `platform="cron"`, the agent keeps the
value as `agent.platform`, and the turn finalizer passes it, with the session
id, to `post_llm_call`.
"""

from __future__ import annotations

import ast

from pinned import PinnedSource

FINALIZER = "agent/turn_finalizer.py"
AGENT_INIT = "agent/agent_init.py"
SCHEDULER = "cron/scheduler.py"


def _keywords(call: ast.Call) -> dict[str, str]:
    return {keyword.arg: ast.unparse(keyword.value) for keyword in call.keywords}


def test_post_llm_call_receives_the_session_id_and_the_platform(hermes: PinnedSource) -> None:
    function = hermes.function(FINALIZER, "_apply_output_hooks")
    assert function.lineno == 450
    call = next(
        node for node in ast.walk(function)
        if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant)
        and node.args[0].value == "post_llm_call"
    )
    keywords = _keywords(call)
    assert keywords["session_id"] == "agent.session_id"
    assert keywords["platform"] == "platform"
    # agent/turn_finalizer.py:466-476
    assert hermes.lines(FINALIZER, 466, 476) == (
        "        _invoke_hook_safely(\n"
        '            "post_llm_call", logger,\n'
        "            session_id=agent.session_id,\n"
        "            task_id=effective_task_id,\n"
        "            turn_id=turn_id,\n"
        "            user_message=original_user_message,\n"
        "            assistant_response=final_response,\n"
        "            conversation_history=list(messages),\n"
        "            model=agent.model,\n"
        "            platform=platform,\n"
        "        )"
    )


def test_the_platform_passed_to_the_hook_is_the_agents_own(hermes: PinnedSource) -> None:
    # agent/turn_finalizer.py:651 and 655-656
    assert hermes.lines(FINALIZER, 651, 651) == '    _platform = getattr(agent, "platform", None) or ""'
    assert hermes.lines(FINALIZER, 655, 656) == (
        "        final_response, _response_transformed, _pre_transform_response = _apply_output_hooks(\n"
        "            agent, final_response, logger, platform=_platform, effective_task_id=effective_task_id,"
    )


def test_the_agent_keeps_its_platform_argument_as_is(hermes: PinnedSource) -> None:
    assert "platform" in hermes.assigned(AGENT_INIT, "_PASSTHROUGH_PARAMS")
    # agent/agent_init.py:2402-2403
    assert hermes.lines(AGENT_INIT, 2402, 2403) == (
        "    for _name in _PASSTHROUGH_PARAMS:\n"
        "        setattr(agent, _name, _params[_name])"
    )


def test_cron_runs_its_turns_with_platform_cron(hermes: PinnedSource) -> None:
    function = hermes.function(SCHEDULER, "_construct_cron_agent")
    assert function.lineno == 2465
    call = next(
        node for node in ast.walk(function)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "AIAgent"
    )
    assert _keywords(call)["platform"] == "'cron'"
    # cron/scheduler.py:2496
    assert hermes.lines(SCHEDULER, 2496, 2496) == '        platform="cron",'
