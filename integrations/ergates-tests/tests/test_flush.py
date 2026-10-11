"""Tests for ergates.flush: the periodic delivery and retention entry point.

Nothing in Hermes runs a timer for this plugin, so this module is what the
deployment schedules (see ``deploy/README.md``). No network: every test
injects its own publisher.
"""

import logging
import os
import sys
import time

import pytest

from conftest import FakeCron, raw_bytes, rows
from ergates import flush
from ergates.attention import APPROVAL_TTL_SECONDS, RETENTION_SECONDS, AttentionService
from ergates.delivery import LEASE_SECONDS
from ergates.flush import flush_once, main
from ergates.proposals import ProposalService, validate_proposal
from ergates.reminders import REMINDER_MAX_IDLE_SECONDS, ReminderService

SETTINGS = {"server": "https://ntfy.example.internal", "topic": "ergates-alerts", "token": "tok",
            "connection_id": "conn-1"}


def _write_config(home, **ntfy):
    """Write a config.yaml shaped exactly like the one the runbook edits."""
    settings = ntfy or SETTINGS
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        "plugins:\n"
        "  entries:\n"
        "    ergates:\n"
        "      settings:\n"
        "        ntfy:\n"
        + "".join(f"          {key}: {value}\n" for key, value in settings.items()),
        encoding="utf-8",
    )


def _approval(store, now, command="rm -rf /tmp/x"):
    return AttentionService(store, clock=lambda: now).approval_requested(
        session_key="s1", pattern_key="p1", command=command, surface="gateway", profile="thijs",
    )


# --- the delivery pass --------------------------------------------------------


def test_flush_once_sends_a_due_push_with_its_own_routing(tmp_path, store):
    now = time.time()
    event_id = _approval(store, now)
    published = []

    counts = flush_once(tmp_path, SETTINGS, now=now, publish=published.append)

    assert counts["retried"] == 1
    assert published[0]["url"] == "https://ntfy.example.internal/ergates-alerts"
    assert published[0]["headers"]["Click"] == "ergates://chat/s1?connection=conn-1&profile=thijs"
    assert rows(store, "attention_outbox")[0]["state"] == "sent"
    assert rows(store, "attention_outbox")[0]["event_id"] == event_id


def test_flush_once_skips_the_delivery_pass_when_push_is_not_configured(tmp_path, store):
    now = time.time()
    _approval(store, now)
    published = []

    counts = flush_once(tmp_path, {}, now=now, publish=published.append)

    assert counts["retried"] == 0
    assert published == []
    assert rows(store, "attention_outbox")[0]["state"] == "due"   # still due for a later flush


def test_flush_once_never_pushes_an_expired_approval(tmp_path, store):
    created = time.time()
    _approval(store, created)
    published = []

    counts = flush_once(tmp_path, SETTINGS, now=created + APPROVAL_TTL_SECONDS, publish=published.append)

    assert (counts["retried"], counts["expired_notifications"], counts["pruned_notifications"]) == (0, 1, 0)
    assert published == []
    assert rows(store, "attention_events")[0]["state"] == "expired"   # kept for its seven-day audit window
    assert rows(store, "attention_outbox")[0]["state"] == "cancelled"


def test_the_lease_counts_from_the_claim_not_from_the_start_of_the_sweep(tmp_path, store, clock, monkeypatch):
    """Expiry and retention share one timestamp, the start of the sweep. The
    delivery pass must not: after a slow retention phase, a lease counted from
    the start would already have run out when the worker claims the row, and
    a second worker could send the same push."""
    event_id = _approval(store, clock())
    prune = ProposalService.prune

    def slow_prune(self, now):
        clock.advance(300)
        return prune(self, now)

    monkeypatch.setattr(ProposalService, "prune", slow_prune)
    leases = []

    def publish(spec):
        claimed = next(row for row in rows(store, "attention_outbox") if row["event_id"] == event_id)
        leases.append((claimed["lease_until"], clock()))

    counts = flush_once(tmp_path, SETTINGS, clock=clock, publish=publish)

    assert counts["retried"] == 1
    assert leases == [(clock() + LEASE_SECONDS, clock())]


# --- the retention pass -----------------------------------------------------


def test_flush_once_prunes_events_proposals_and_reminders(tmp_path, store, cron):
    """Each service has a prune and nothing inside Hermes calls it (04 section 8)."""
    now = time.time()
    old = now - RETENTION_SECONDS - APPROVAL_TTL_SECONDS - 60
    _approval(store, old)
    proposal = validate_proposal({
        "name": "thijs", "title": "Thijs", "role": "Bookkeeper", "template_id": "bookkeeper",
        "provider": "p", "model": "m", "briefing": "Role and boundaries.",
    })
    proposal["expires_at"] = "2020-01-01T00:00:00Z"
    ProposalService(store).record(proposal)
    idle_since = now - REMINDER_MAX_IDLE_SECONDS - 60
    ReminderService(store, cron, clock=lambda: idle_since).create("thijs", "0 9 * * *", "UTC", "Check invoices.")

    counts = flush_once(tmp_path, {}, now=now)

    assert counts == {"retried": 0, "expired_notifications": 1, "pruned_notifications": 1,
                      "pruned_proposals": 1, "pruned_reminders": 1}
    for table in ("attention_events", "attention_outbox", "proposal_receipts", "reminder_receipts"):
        assert rows(store, table) == []


def test_flush_once_drops_a_reminder_receipt_whose_job_is_gone(tmp_path, store, cron):
    outcome = ReminderService(store, cron).create("thijs", "0 9 * * *", "UTC", "Check invoices.")
    cron.delete_job(outcome.receipt["job_id"])

    counts = flush_once(tmp_path, {}, cron=cron)

    assert counts["pruned_reminders"] == 1
    assert rows(store, "reminder_receipts") == []


def test_flush_once_on_an_untouched_root_is_a_no_op(tmp_path):
    counts = flush_once(tmp_path, {})

    assert counts == {
        "retried": 0, "expired_notifications": 0,
        "pruned_notifications": 0, "pruned_proposals": 0, "pruned_reminders": 0,
    }


def test_the_store_never_carries_content_after_a_flush(tmp_path, store):
    """Belt and braces over the retention rules: whatever survives a sweep must
    still be free of commands and prompts."""
    _approval(store, time.time(), command="rm -rf /srv/secret-project")

    flush_once(tmp_path, {})

    assert b"secret-project" not in raw_bytes(store)


# --- the command line -------------------------------------------------------


def test_main_reports_counts_and_never_prints_a_secret(tmp_path, capsys, monkeypatch, store):
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _write_config(tmp_path)
    _approval(store, time.time() - RETENTION_SECONDS - APPROVAL_TTL_SECONDS - 60)

    exit_code = main([])

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "expired_notifications=1 pruned_notifications=1" in out
    assert SETTINGS["token"] not in out


def test_main_survives_a_malformed_root_config_and_still_prunes(tmp_path, capsys, monkeypatch, store, caplog):
    """settings.py's own invariant -- "a sweep or a hook must not die on a
    config typo" -- must hold for main() too, not only for the hooks
    (tool.py's _delivery_worker already catches this the same way). A
    config.yaml a YAML parser refuses must not stop expiry, retention or
    pruning; main() still exits 0, and the log names the exception class
    only, never the file's content."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text("plugins: [unclosed\n", encoding="utf-8")
    _approval(store, time.time() - RETENTION_SECONDS - APPROVAL_TTL_SECONDS - 60)

    with caplog.at_level(logging.WARNING, logger="ergates.flush"):
        exit_code = main([])

    out = capsys.readouterr().out
    assert exit_code == 0
    assert "expired_notifications=1 pruned_notifications=1" in out
    assert "ParserError" in caplog.text
    assert "unclosed" not in caplog.text


def test_main_sweeps_the_shared_store_with_the_install_settings_from_a_profile_process(
        tmp_path, capsys, monkeypatch, store):
    """With HERMES_HOME=<root>/profiles/<name> the sweep once opened the
    profile's own journals. It sweeps the one store under the Hermes root, and it
    pushes with the install-wide settings in the root's config.yaml, not with
    whatever the profile's own config says. This also replaces the former
    --profile coverage: there is no --profile any more, so the store opening
    under the Hermes root when the process runs as a named profile is the whole
    of the remaining behavior, and
    test_main_takes_no_credential_arguments_and_no_profile below shows --profile
    is refused outright."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    profile = tmp_path / "profiles" / "thijs"
    _write_config(profile, server="https://profile-only.example.internal", topic="ignored")
    _write_config(tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    swept = []
    sweep = flush.flush_once

    def spy(root, settings, **kwargs):
        swept.append((root, dict(settings)))
        return sweep(root, {}, **kwargs)  # no network in a test: the delivery pass is skipped

    monkeypatch.setattr(flush, "flush_once", spy)
    _approval(store, time.time() - RETENTION_SECONDS - APPROVAL_TTL_SECONDS - 60)

    assert main([]) == 0

    assert swept == [(tmp_path, SETTINGS)]
    assert "pruned_notifications=1" in capsys.readouterr().out
    assert sorted(path.name for path in profile.iterdir()) == ["config.yaml"]


def test_main_asks_hermes_cron_so_a_job_deleted_natively_drops_its_receipt(tmp_path, capsys, monkeypatch, store):
    """The sweep's cron is Hermes's own (hermes_adapter.HermesCron), so a job the
    operator deleted in the Routines screen does not keep its receipt for 30 days."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    cron = FakeCron()
    monkeypatch.setattr(flush, "HermesCron", lambda: cron)
    outcome = ReminderService(store, cron).create("thijs", "0 9 * * *", "UTC", "Check invoices.")
    cron.delete_job(outcome.receipt["job_id"])

    assert main([]) == 0

    assert "pruned_reminders=1" in capsys.readouterr().out
    assert rows(store, "reminder_receipts") == []


def test_main_without_hermes_keeps_a_receipt_it_cannot_check(tmp_path, capsys, monkeypatch, store, cron):
    """Outside the Hermes runtime HermesCron answers "could not tell": only the 30-day rule applies."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setitem(sys.modules, "cron", None)
    monkeypatch.setitem(sys.modules, "cron.jobs", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    ReminderService(store, cron).create("thijs", "0 9 * * *", "UTC", "Check invoices.")

    assert main([]) == 0

    assert "pruned_reminders=0" in capsys.readouterr().out
    assert len(rows(store, "reminder_receipts")) == 1


def test_main_fails_cleanly_on_a_missing_hermes_home(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nope"))

    assert main([]) == 2
    assert "no Hermes home" in capsys.readouterr().err


def test_main_refuses_to_run_as_root_when_another_user_owns_the_hermes_root(tmp_path, monkeypatch, capsys):
    """A root sweep can leave -wal and -shm files the Hermes user cannot open, and
    every hook then fails. It refuses before it opens the store."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(os, "geteuid", lambda: 0)

    assert main([]) == 2

    err = capsys.readouterr().err
    assert "refusing to run as root" in err
    assert "docker compose exec -u hermes" in err
    assert not (tmp_path / "ergates").exists()


def test_main_takes_no_credential_arguments_and_no_profile():
    """The whole point of reading config.yaml: a token must never reach a process
    listing (04 section 6). argparse rejects anything token-shaped. The push
    settings are install-wide, so there is no profile to choose either."""
    with pytest.raises(SystemExit):
        main(["--token", "secret"])
    with pytest.raises(SystemExit):
        main(["--profile", "thijs"])
