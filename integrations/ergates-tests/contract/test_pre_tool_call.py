"""The Ergates tool gate is a `pre_tool_call` callback.

Pins what the gate relies on: a `{"action": "block", "message": str}` return
vetoes the tool, a `register()` that raises loses every registration (so it
must not raise), and a timed-out callback blocks.

A callback that raises was skipped at the previous pin (fail OPEN). Since
v0.21.6 Hermes blocks the call instead, with a message that quotes the
exception text. The Ergates callback still catches everything itself
(`policy.guarded`), so its block carries fixed text and never an exception
message, which can quote tool arguments.
"""

from __future__ import annotations

import ast

from pinned import PinnedSource

DISPATCH = "hermes_cli/plugins_dispatch.py"
LOADER = "hermes_cli/plugins_loader.py"
PLUGINS = "hermes_cli/plugins.py"


def test_the_callback_receives_the_tool_name_and_its_arguments(hermes: PinnedSource) -> None:
    # hermes_cli/plugins.py:1987-1991
    assert hermes.lines(PLUGINS, 1987, 1991) == (
        "    hook_results = invoke_lifecycle_hook(\n"
        '        "pre_tool_call", tool_name=tool_name, args=args if isinstance(args, dict) else {},\n'
        "        task_id=task_id, session_id=session_id, tool_call_id=tool_call_id, turn_id=turn_id,\n"
        "        api_request_id=api_request_id, middleware_trace=list(middleware_trace or []),\n"
        "    )"
    )


def test_a_block_directive_with_a_message_vetoes_the_tool(hermes: PinnedSource) -> None:
    # hermes_cli/plugins.py:2007-2015: a block needs a message; the first valid block wins, and
    # since v0.21.6 it also wins over an approve that another plugin returned before it.
    assert hermes.lines(PLUGINS, 2007, 2015) == (
        '        if action not in ("block", "approve"):\n'
        "            continue\n"
        '        message = result.get("message")\n'
        "        message = message if isinstance(message, str) and message else None\n"
        "        # A block directive requires a message (it becomes the tool result); approve's is optional.\n"
        '        if action == "block" and not message:\n'
        "            continue\n"
        '        if action == "block":\n'
        "            return _PreToolCallDirective(action=\"block\", message=message, modified_args=modified_args)"
    )
    # hermes_cli/plugins.py:2057-2058: the block message is what the tool call returns.
    assert hermes.lines(PLUGINS, 2057, 2058) == ('    if details.action == "block":\n' "        return details.message")


def test_a_raising_callback_blocks_with_the_exception_text(hermes: PinnedSource) -> None:
    """Hermes now fails closed itself; ``policy.guarded`` stays so the block names no exception text."""
    # hermes_cli/plugins_dispatch.py:241-244: the failure is reported and, for pre_tool_call, a block appended.
    assert hermes.lines(DISPATCH, 241, 244) == (
        "            except (Exception, SystemExit) as exc:\n"
        "                self._report_hook_failure(hook_name, cb, kwargs, exc)\n"
        "                if fail_closed:  # a guard that raised made no decision: same veto as a timeout\n"
        "                    results.append(_policy_error_block_directive(hook_name, cb, exc))"
    )
    invoke_hook = hermes.function(DISPATCH, "invoke_hook", owner="PluginDispatchMixin")
    loop = next(node for node in ast.walk(invoke_hook) if isinstance(node, ast.For))
    handler = loop.body[0].handlers[0]
    assert ast.unparse(handler.type) == "(Exception, SystemExit)"
    # hermes_cli/plugins_dispatch.py:66-67: that block's message quotes the exception.
    assert hermes.lines(DISPATCH, 66, 67) == (
        '    return {"action": "block",\n'
        '            "message": f"{hook_name} plugin callback {callback_name} raised {type(exc).__name__}: {str(exc)[:200]}"}'
    )


def test_a_register_that_raises_loses_every_registration_the_gate_included(hermes: PinnedSource) -> None:
    """Registering the gate first would not save it: a raise anywhere in
    register() disposes of everything the plugin registered. So ``tool.register``
    never raises for the control store; it opens the store at first use."""
    # hermes_cli/plugins_loader.py:481, 515, 525 and 530-532
    assert hermes.lines(LOADER, 481, 481) == "        ctx = PluginContext(manifest, self)"
    assert hermes.lines(LOADER, 515, 515) == "            register_fn(ctx)"
    assert hermes.lines(LOADER, 525, 525) == "        except (Exception, SystemExit) as exc:"
    assert hermes.lines(LOADER, 530, 532) == (
        "            owned = [r for r in self._registration_order if r.plugin_key == plugin_key]\n"
        "            self._dispose_registrations(owned)\n"
        "            self._forget_registrations(owned)"
    )


def test_a_timed_out_or_skipped_callback_fails_closed(hermes: PinnedSource) -> None:
    assert hermes.assigned(DISPATCH, "_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS") == frozenset({"pre_tool_call"})
    assert hermes.assigned(DISPATCH, "_HOOK_CALLBACK_TIMEOUT_SECS") == 30.0
    # hermes_cli/plugins_dispatch.py:233-236
    assert hermes.lines(DISPATCH, 233, 236) == (
        "                    if ret is _HOOK_SKIPPED:\n"
        "                        if fail_closed:  # policy hook: fail closed with a block directive\n"
        '                            results.append({"action": "block", "message": _PRE_TOOL_CALL_TIMEOUT_BLOCK_MESSAGE})\n'
        "                        continue"
    )
