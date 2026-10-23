"""The in-flight hook guard: what Hermes does when two sessions call tools at once.

Hermes skips a callback that is still running, and for `pre_tool_call` a skip
is a block. At the previous pin the in-flight key was the hook and the
callback only, so two sessions calling tools at the same moment could block
each other. Since v0.21.6 the in-flight key also holds the call's identity
(its `tool_call_id`, else its `turn_id`), so concurrent calls no longer skip
each other. The back-off after a timeout is still keyed on the hook and the
callback alone: once the Ergates gate times out, every session's tool calls
are blocked for the suppression window.
"""

from __future__ import annotations

from pinned import PinnedSource

DISPATCH = "hermes_cli/plugins_dispatch.py"


def test_the_in_flight_key_is_the_call_and_the_back_off_key_is_the_callback(hermes: PinnedSource) -> None:
    # hermes_cli/plugins_dispatch.py:281-282
    assert hermes.lines(DISPATCH, 281, 282) == (
        "        suppression_key = (hook_name, id(cb))\n"
        "        gate_key = (*suppression_key, _hook_call_identity(kwargs))"
    )
    # hermes_cli/plugins_dispatch.py:169-173: the call identity.
    assert hermes.lines(DISPATCH, 169, 173) == (
        '    for field in ("tool_call_id", "turn_id"):\n'
        "        value = kwargs.get(field)\n"
        "        if isinstance(value, str) and value:\n"
        "            return value\n"
        "    return None"
    )
    # hermes_cli/plugins_dispatch.py:55: the back-off window after a timeout.
    assert hermes.assigned(DISPATCH, "_HOOK_TIMEOUT_SUPPRESSION_SECONDS") == 60.0


def test_a_callback_still_running_is_skipped(hermes: PinnedSource) -> None:
    # hermes_cli/plugins_dispatch.py:284-291
    assert hermes.lines(DISPATCH, 284, 291) == (
        "        with self._hook_timeout_lock:\n"
        "            suppressed_until = self._hook_timeout_suppressed_until.get(suppression_key)\n"
        "            if (gate_key in self._hook_running_callbacks\n"
        "                    or (suppressed_until is not None and suppressed_until > time.monotonic())):\n"
        "                logger.warning(\n"
        '                    "Hook \'%s\' callback %s skipped after previous "\n'
        '                    "timeout or while still running", hook_name, callback_name)\n'
        "                return _HOOK_SKIPPED"
    )
