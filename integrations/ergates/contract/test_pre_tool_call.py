"""The Ergates tool gate is a `pre_tool_call` callback.

Pins what the gate relies on: a `{"action": "block", "message": str}` return
vetoes the tool, a callback that raises is skipped (fail OPEN, so the Ergates
callback must catch everything itself), a `register()` that raises loses every
registration (so it must not raise), and a timed-out callback blocks.
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
    # hermes_cli/plugins.py:1815-1824: the first valid block or approve wins; a block needs a message.
    assert hermes.lines(PLUGINS, 1815, 1824) == (
        '        if action not in ("block", "approve"):\n'
        "            continue\n"
        '        message = result.get("message")\n'
        "        message = message if isinstance(message, str) and message else None\n"
        "        # A block directive requires a message (it becomes the tool result); approve's is optional.\n"
        '        if action == "block" and not message:\n'
        "            continue\n"
        '        rule_key = result.get("rule_key") if action == "approve" else None\n'
        "        rule_key = (rule_key.strip() or None) if isinstance(rule_key, str) else None\n"
        "        return _PreToolCallDirective(action=action, message=message, rule_key=rule_key, modified_args=modified_args)"
    )
    # hermes_cli/plugins.py:1859-1860: the block message is what the tool call returns.
    assert hermes.lines(PLUGINS, 1859, 1860) == ('    if details.action == "block":\n' "        return details.message")


def test_a_raising_callback_fails_open(hermes: PinnedSource) -> None:
    # hermes_cli/plugins_dispatch.py:196-198: the exception is logged and the next callback runs.
    assert hermes.lines(DISPATCH, 196, 198) == (
        "            except Exception as exc:\n"
        "                logger.warning(\n"
        '                    "Hook \'%s\' callback %s raised: %s", hook_name, getattr(cb, "__name__", repr(cb)), exc)'
    )
    invoke_hook = hermes.function(DISPATCH, "invoke_hook", owner="PluginDispatchMixin")
    loop = next(node for node in ast.walk(invoke_hook) if isinstance(node, ast.For))
    handler = loop.body[0].handlers[0]
    assert ast.unparse(handler.type) == "Exception"
    # Only the warning: no block directive is appended and nothing is re-raised.
    assert len(handler.body) == 1
    assert ast.unparse(handler.body[0].value.func) == "logger.warning"


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
