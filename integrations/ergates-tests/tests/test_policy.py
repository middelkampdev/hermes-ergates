"""Tests for ergates.policy: the pre_tool_call gate."""

import logging

import pytest

from ergates.policy import (
    BLOCK_RAW_CRON,
    BLOCK_REVOKED,
    BLOCK_SETUP,
    BLOCK_UNVERIFIED,
    decide,
    guarded,
)

OPEN = {"admitted": True, "granted_toolsets": None, "tool_toolset": None}


def test_rule_1_a_profile_still_being_set_up_is_blocked_for_every_tool():
    for tool_name in ("terminal", "memory", "ergates_propose_agent", "cronjob_manage"):
        assert decide(tool_name, {}, **{**OPEN, "admitted": False}) == {"action": "block", "message": BLOCK_SETUP}


@pytest.mark.parametrize("action", ["create", "CREATE", " Create "])
def test_rule_2_a_raw_cron_create_is_blocked(action):
    assert decide("cronjob_manage", {"action": action}, **OPEN) == {"action": "block", "message": BLOCK_RAW_CRON}


@pytest.mark.parametrize(("tool_name", "args"), [
    ("cronjob_manage", {"action": "list"}),
    ("cronjob_manage", {"action": "remove", "job_id": "j"}),
    ("cronjob_manage", {}),
    ("ergates_create_reminder", {"schedule": "0 9 * * *", "prompt": "p"}),
    ("terminal", {"action": "create"}),
])
def test_rule_4_every_other_call_runs(tool_name, args):
    assert decide(tool_name, args, **OPEN) is None


def test_rule_1_comes_before_rule_2():
    assert decide("cronjob_manage", {"action": "create"}, **{**OPEN, "admitted": False})["message"] == BLOCK_SETUP


GRANT = frozenset({"web", "file"})


def test_rule_3_a_tool_whose_toolset_the_profile_no_longer_grants_is_blocked():
    assert decide("terminal", {}, admitted=True, granted_toolsets=GRANT, tool_toolset="terminal") == {
        "action": "block", "message": BLOCK_REVOKED}


def test_rule_3_a_tool_of_a_granted_toolset_runs():
    assert decide("web_search", {}, admitted=True, granted_toolsets=GRANT, tool_toolset="web") is None


def test_rule_3_never_blocks_the_ergates_tools():
    """A template needs no `ergates` entry for its agent to propose or make reminders."""
    for tool_name in ("ergates_create_reminder", "ergates_propose_agent"):
        assert decide(tool_name, {}, admitted=True, granted_toolsets=frozenset(), tool_toolset="ergates") is None


@pytest.mark.parametrize(("granted", "toolset"), [(None, "terminal"), (GRANT, None), (None, None)])
def test_rule_3_applies_only_when_both_the_grant_and_the_toolset_are_known(granted, toolset):
    """No toolset pin, or a tool Hermes does not know: Hermes alone decides."""
    assert decide("terminal", {}, admitted=True, granted_toolsets=granted, tool_toolset=toolset) is None


def test_rules_1_and_2_come_before_rule_3():
    revoked = {"admitted": True, "granted_toolsets": frozenset(), "tool_toolset": "cronjob"}
    assert decide("terminal", {}, **{**revoked, "admitted": False})["message"] == BLOCK_SETUP
    assert decide("cronjob_manage", {"action": "create"}, **revoked)["message"] == BLOCK_RAW_CRON
    assert decide("cronjob_manage", {"action": "list"}, **revoked)["message"] == BLOCK_REVOKED


def test_a_gate_that_raises_blocks_the_tool(caplog):
    """A gate that raises must block. Hermes blocks too since v0.21.6, but quotes the
    exception text in its block, so the gate turns its own failure into a fixed one."""

    @guarded
    def broken(tool_name, args):
        raise RuntimeError(f"store unreadable while checking {args['secret']}")

    with caplog.at_level(logging.WARNING):
        result = broken("terminal", {"secret": "rm -rf /srv/data"})

    assert result == {"action": "block", "message": BLOCK_UNVERIFIED}
    assert "RuntimeError" in caplog.text
    assert "rm -rf" not in caplog.text


def test_guarded_passes_a_result_through_and_keeps_the_name():
    @guarded
    def gate(tool_name, args):
        return decide(tool_name, args, **OPEN)

    assert gate("cronjob_manage", {"action": "create"})["message"] == BLOCK_RAW_CRON
    assert gate("terminal", {}) is None
    assert gate.__name__ == "gate"


def test_non_dict_arguments_are_a_block_not_a_crash():
    @guarded
    def gate(tool_name, args):
        return decide(tool_name, args, **OPEN)

    assert gate("cronjob_manage", None) == {"action": "block", "message": BLOCK_UNVERIFIED}
