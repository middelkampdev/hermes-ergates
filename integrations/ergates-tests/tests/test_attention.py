"""Tests for ergates.attention: attention events, the outbox rows they commit, prefs, expiry, retention."""

from __future__ import annotations

import sys
import time
import types
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from conftest import raw_bytes, rows
from ergates.attention import (
    APPROVAL_TTL_SECONDS,
    RETENTION_SECONDS,
    AttentionError,
    AttentionService,
    command_hash,
    correlation,
    duplicate_hook_call,
    quiet_until,
)

COMPLETION_PLATFORMS = frozenset({"cron"})
AMSTERDAM = ZoneInfo("Europe/Amsterdam")


@pytest.fixture
def attention(store, clock) -> AttentionService:
    return AttentionService(store, clock=clock)


@pytest.fixture
def utc(monkeypatch):
    """Without a Hermes timezone, quiet hours are server local time; pin the server to UTC."""
    monkeypatch.setenv("TZ", "UTC")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def _approval(attention, **overrides):
    values = dict(session_key="session-1", pattern_key="rm_recursive", command="rm -rf /tmp/x",
                  surface="gateway", profile="thijs")
    values.update(overrides)
    return attention.approval_requested(**values)


def _resolve(attention, **overrides):
    values = dict(session_key="session-1", pattern_key="rm_recursive", command="rm -rf /tmp/x",
                  surface="gateway", choice="once")
    values.update(overrides)
    return attention.approval_resolved(**values)


def _utc(text: str) -> float:
    """The epoch of an ISO time read as UTC, whatever the server's own zone."""
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc).timestamp()


def _event(store, event_id):
    return next(row for row in rows(store, "attention_events") if row["id"] == event_id)


def _outbox(store, event_id):
    return next((row for row in rows(store, "attention_outbox") if row["event_id"] == event_id), None)


# --- helpers ----------------------------------------------------------------


def test_command_hash_is_none_for_no_command_and_stable_otherwise():
    assert command_hash(None) is None
    assert command_hash("") is None
    assert command_hash("rm -rf /tmp/x") == command_hash("rm -rf /tmp/x") != command_hash("rm -rf /tmp/y")
    assert len(command_hash("rm -rf /tmp/x")) == 64


def test_correlation_separates_session_pattern_command_and_surface():
    base = correlation("s1", "p1", "cmd", "gateway")

    assert base == correlation("s1", "p1", "cmd", "gateway")
    assert len({base, correlation("s2", "p1", "cmd", "gateway"), correlation("s1", "p2", "cmd", "gateway"),
                correlation("s1", "p1", "other", "gateway"), correlation("s1", "p1", "cmd", "cli")}) == 5


def test_duplicate_hook_call_flags_coalesced_followers_and_the_smart_surface():
    assert duplicate_hook_call("gateway", True) is True
    assert duplicate_hook_call("smart", None) is True
    assert duplicate_hook_call("gateway", None) is False
    assert duplicate_hook_call("cli", False) is False
    assert duplicate_hook_call(None, None) is False


def test_quiet_until_handles_a_window_that_wraps_midnight(utc):
    """22:00-07:00 holds a 23:30 push until 07:00 the next morning."""
    at = lambda text: datetime.fromisoformat(text).timestamp()  # noqa: E731 - local time, pinned to UTC

    assert quiet_until(at("2026-09-25T23:30"), "22:00", "07:00") == at("2026-09-26T07:00")
    assert quiet_until(at("2026-09-26T06:59"), "22:00", "07:00") == at("2026-09-26T07:00")
    assert quiet_until(at("2026-09-26T07:00"), "22:00", "07:00") is None
    assert quiet_until(at("2026-09-25T21:59"), "22:00", "07:00") is None


def test_quiet_hours_are_read_in_the_zone_hermes_is_configured_for():
    """21:30 UTC is 23:30 in Amsterdam (CEST): inside 22:00-07:00 there, outside it in UTC."""
    instant = _utc("2026-09-25T21:30")

    assert quiet_until(instant, "22:00", "07:00", AMSTERDAM) == _utc("2026-09-26T05:00")
    assert quiet_until(instant, "22:00", "07:00", timezone.utc) is None


def test_quiet_until_handles_a_window_inside_one_day(utc):
    at = lambda text: datetime.fromisoformat(text).timestamp()  # noqa: E731

    assert quiet_until(at("2026-09-25T13:15"), "12:00", "14:00") == at("2026-09-25T14:00")
    assert quiet_until(at("2026-09-25T14:00"), "12:00", "14:00") is None
    assert quiet_until(at("2026-09-25T13:15"), None, None) is None
    assert quiet_until(at("2026-09-25T13:15"), "07:00", "07:00") is None


# --- approvals --------------------------------------------------------------


def test_an_approval_and_its_push_commit_together(attention, store, clock):
    """The first push was once saved with next_retry=None, so a crash
    during the first send lost it. The outbox row now commits with the event,
    due at once, before anything is sent."""
    event_id = _approval(attention)

    event = _event(store, event_id)
    outbox = _outbox(store, event_id)
    assert (event["kind"], event["state"], event["profile"], event["session_id"]) == (
        "approval", "pending", "thijs", "session-1")
    assert event["expires_at"] == clock() + APPROVAL_TTL_SECONDS
    assert (outbox["state"], outbox["attempts"], outbox["next_attempt_at"]) == ("due", 0, clock())


def test_an_approval_never_stores_the_command_or_the_description(attention, store):
    """docs/11 section 4.2: event id, owning profile/session, approval id, state,
    attempts, next retry, delivery result -- never the command."""
    _approval(attention, command="rm -rf /srv/secret-project")

    event = rows(store, "attention_events")[0]
    assert event["correlation"] == correlation("session-1", "rm_recursive", "rm -rf /srv/secret-project", "gateway")
    assert b"secret-project" not in raw_bytes(store)


def test_duplicate_hook_calls_write_nothing(attention, store):
    """A coalesced follower or the smart guardian pre-check is not a new prompt."""
    assert _approval(attention, coalesced=True) is None
    assert _approval(attention, surface="smart") is None
    assert _resolve(attention, coalesced=True) is None
    assert rows(store, "attention_events") == []


def test_one_prompt_with_two_coalesced_followers_is_one_event_and_one_push(attention, store):
    _approval(attention)
    _approval(attention, coalesced=True)
    _approval(attention, coalesced=True)

    assert len(rows(store, "attention_events")) == 1
    assert len(rows(store, "attention_outbox")) == 1


def test_a_muted_profile_gets_the_event_but_no_push(attention, store):
    attention.set_prefs("thijs", muted=True, quiet_start=None, quiet_end=None)

    event_id = _approval(attention)

    assert _event(store, event_id)["state"] == "pending"
    assert _outbox(store, event_id) is None


def test_approval_pushes_ignore_quiet_hours(attention, store, clock, utc):
    """The approval times out after 30 minutes; holding its push would only hide it."""
    clock.now = datetime.fromisoformat("2026-09-25T23:30").timestamp()
    attention.set_prefs("*", muted=False, quiet_start="22:00", quiet_end="07:00")

    event_id = _approval(attention)

    assert _outbox(store, event_id)["next_attempt_at"] == clock()


def test_a_response_resolves_the_matching_approval_and_cancels_its_push(attention, store, clock):
    event_id = _approval(attention)
    clock.advance(5)

    assert _resolve(attention, choice="deny") == event_id

    event = _event(store, event_id)
    assert (event["state"], event["choice"], event["resolved_at"]) == ("resolved", "deny", clock())
    assert _outbox(store, event_id)["state"] == "cancelled"


def test_a_response_resolves_the_right_one_of_several_pending_approvals(attention, store):
    """Several approvals can be pending in one session; correlate on
    (session, pattern, command hash, surface) and touch only the match."""
    a = _approval(attention, command="cmd-a", pattern_key="pattern-a")
    b = _approval(attention, command="cmd-b", pattern_key="pattern-b")

    _resolve(attention, command="cmd-b", pattern_key="pattern-b")

    assert (_event(store, a)["state"], _event(store, b)["state"]) == ("pending", "resolved")


def test_a_response_resolves_the_oldest_identical_approval_first(attention, clock):
    first = _approval(attention)
    clock.advance(1)
    _approval(attention)

    assert _resolve(attention) == first


def test_a_response_correlates_within_its_own_surface(attention, store):
    gateway = _approval(attention, surface="gateway")
    cli = _approval(attention, surface="cli")

    _resolve(attention, surface="cli")

    assert (_event(store, gateway)["state"], _event(store, cli)["state"]) == ("pending", "resolved")


def test_a_request_id_correlates_when_hermes_supplies_one(attention, store):
    first = _approval(attention, request_id="approval-1")
    second = _approval(attention, request_id="approval-2")

    assert _resolve(attention, request_id="approval-2", command="something else") == second
    assert _event(store, first)["state"] == "pending"


def test_a_response_with_no_match_changes_nothing(attention, store):
    event_id = _approval(attention)

    assert _resolve(attention, command="a different command") is None
    assert _event(store, event_id)["state"] == "pending"


# --- completions ------------------------------------------------------------


def test_a_finished_routine_turn_is_an_event_with_a_push(attention, store, clock):
    event_id = attention.turn_completed(session_id="cron-session", profile="thijs", platform="cron",
                                        platforms=COMPLETION_PLATFORMS)

    event = _event(store, event_id)
    assert (event["kind"], event["state"], event["resolved_at"]) == ("completion", "resolved", clock())
    assert _outbox(store, event_id)["next_attempt_at"] == clock()


def test_other_platforms_are_ignored_by_default(attention, store):
    assert attention.turn_completed(session_id="s", profile="thijs", platform="cli",
                                    platforms=COMPLETION_PLATFORMS) is None
    assert attention.turn_completed(session_id="s", profile="thijs", platform=None,
                                    platforms=COMPLETION_PLATFORMS) is None
    assert rows(store, "attention_events") == []


def test_quiet_hours_hold_a_completion_push_until_they_end(attention, store, clock, utc):
    """A window that wraps midnight: 23:30 waits until 07:00."""
    clock.now = datetime.fromisoformat("2026-09-25T23:30").timestamp()
    attention.set_prefs("thijs", muted=False, quiet_start="22:00", quiet_end="07:00")

    event_id = attention.turn_completed(session_id="s", profile="thijs", platform="cron",
                                        platforms=COMPLETION_PLATFORMS)

    assert _outbox(store, event_id)["next_attempt_at"] == datetime.fromisoformat("2026-09-26T07:00").timestamp()


def test_quiet_hours_follow_the_hermes_timezone_not_the_server_clock(store, clock, utc):
    """Hermes cron runs routines in its configured timezone (hermes_time), so
    quiet hours must too. The server here runs on UTC; Hermes on Amsterdam."""
    clock.now = _utc("2026-09-25T21:30")
    attention = AttentionService(store, clock=clock, zone=lambda: AMSTERDAM)
    attention.set_prefs("thijs", muted=False, quiet_start="22:00", quiet_end="07:00")

    event_id = attention.turn_completed(session_id="s", profile="thijs", platform="cron",
                                        platforms=COMPLETION_PLATFORMS)

    assert _outbox(store, event_id)["next_attempt_at"] == _utc("2026-09-26T05:00")


def test_by_default_the_service_asks_hermes_for_its_timezone(store, clock, utc, monkeypatch):
    fake = types.ModuleType("hermes_time")
    fake.get_timezone = lambda: AMSTERDAM
    monkeypatch.setitem(sys.modules, "hermes_time", fake)
    clock.now = _utc("2026-09-25T21:30")
    attention = AttentionService(store, clock=clock)
    attention.set_prefs("thijs", muted=False, quiet_start="22:00", quiet_end="07:00")

    event_id = attention.turn_completed(session_id="s", profile="thijs", platform="cron",
                                        platforms=COMPLETION_PLATFORMS)

    assert _outbox(store, event_id)["next_attempt_at"] == _utc("2026-09-26T05:00")


def test_a_muted_profile_gets_no_completion_push(attention, store):
    attention.set_prefs("*", muted=True, quiet_start=None, quiet_end=None)

    event_id = attention.turn_completed(session_id="s", profile="thijs", platform="cron",
                                        platforms=COMPLETION_PLATFORMS)

    assert _outbox(store, event_id) is None


# --- preferences (AttentionPrefs) -------------------------------------------


def test_prefs_default_to_unmuted_without_quiet_hours(attention):
    assert attention.get_prefs("thijs") == {"profile": "thijs", "muted": False, "quiet_start": None, "quiet_end": None}
    assert attention.get_prefs("*")["muted"] is False


def test_a_profile_falls_back_to_the_default_row_until_it_has_its_own(attention):
    attention.set_prefs("*", muted=True, quiet_start="22:00", quiet_end="07:00")
    assert attention.get_prefs("thijs") == {"profile": "thijs", "muted": True, "quiet_start": "22:00", "quiet_end": "07:00"}

    stored = attention.set_prefs("thijs", muted=False, quiet_start=None, quiet_end=None)

    assert stored == {"profile": "thijs", "muted": False, "quiet_start": None, "quiet_end": None}
    assert attention.get_prefs("thijs") == stored
    assert attention.get_prefs("nora")["muted"] is True


@pytest.mark.parametrize("profile, muted, start, end", [
    ("Not A Profile", False, None, None),
    ("thijs", "yes", None, None),
    ("thijs", False, "22:00", None),
    ("thijs", False, "24:00", "07:00"),
    ("thijs", False, "7:00", "08:00"),
    ("thijs", False, "07:00", "07:00"),
])
def test_invalid_prefs_are_refused(attention, profile, muted, start, end):
    with pytest.raises(AttentionError) as caught:
        attention.set_prefs(profile, muted=muted, quiet_start=start, quiet_end=end)

    assert (caught.value.code, caught.value.http_status) == ("invalid", 400)


def test_get_prefs_refuses_an_invalid_profile(attention):
    with pytest.raises(AttentionError):
        attention.get_prefs("../etc")


# --- expiry and retention ----------------------------------------------------


def test_an_approval_expires_after_the_approval_timeout_and_its_push_is_cancelled(attention, store, clock):
    """docs/11 section 4.2: never retry an expired approval notification."""
    event_id = _approval(attention)

    assert attention.expire(clock() + APPROVAL_TTL_SECONDS - 1) == 0
    assert attention.expire(clock() + APPROVAL_TTL_SECONDS) == 1

    event = _event(store, event_id)
    assert (event["state"], event["resolved_at"]) == ("expired", clock() + APPROVAL_TTL_SECONDS)
    assert _outbox(store, event_id)["state"] == "cancelled"
    assert attention.expire(clock() + APPROVAL_TTL_SECONDS + 60) == 0


def test_the_approval_timeout_is_configurable(store, clock):
    short = AttentionService(store, clock=clock, approval_ttl_seconds=60)
    _approval(short)

    assert short.expire(clock() + 60) == 1


def test_an_expired_approval_is_never_resolved_later(attention, store, clock):
    event_id = _approval(attention)
    attention.expire(clock() + APPROVAL_TTL_SECONDS)

    assert _resolve(attention) is None
    assert _event(store, event_id)["state"] == "expired"


def test_terminal_events_age_out_after_seven_days_with_their_outbox_rows(attention, store, clock):
    resolved = _approval(attention)
    _resolve(attention)
    pending = _approval(attention, command="still waiting")

    assert attention.prune(clock() + RETENTION_SECONDS) == 0
    assert attention.prune(clock() + RETENTION_SECONDS + 1) == 1

    assert [row["id"] for row in rows(store, "attention_events")] == [pending]
    assert [row["event_id"] for row in rows(store, "attention_outbox")] == [pending]
    assert resolved not in {row["id"] for row in rows(store, "attention_events")}


def test_an_expired_approval_ages_out_seven_days_after_it_expired(attention, store, clock):
    _approval(attention)
    expired_at = clock() + APPROVAL_TTL_SECONDS
    attention.expire(expired_at)

    assert attention.prune(expired_at + RETENTION_SECONDS) == 0
    assert attention.prune(expired_at + RETENTION_SECONDS + 1) == 1
