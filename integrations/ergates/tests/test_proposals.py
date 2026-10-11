"""Tests for ergates.proposals: validate_proposal, payload_hash and the proposal receipts."""

import json
import threading
import time

import pytest

from conftest import FakeClock, raw_bytes, rows
from ergates.proposals import (
    HERMES_RESERVED_PROFILE_NAMES,
    PROPOSAL_EXPIRY,
    PROPOSAL_KIND,
    PROPOSAL_RETENTION_GRACE_SECONDS,
    PROVISION_STEPS,
    ProposalError,
    ProposalService,
    parse_expires_at,
    payload_hash,
    validate_proposal,
)


def _valid_args(**overrides):
    args = {
        "name": "thijs",
        "title": "Thijs",
        "role": "Bookkeeper",
        "description": "Read invoices and prepare reconciliation notes.",
        "template_id": "bookkeeper",
        "provider": "operator-selected-provider",
        "model": "operator-selected-model",
        "briefing": "Role, boundaries, seed facts and reporting instructions.",
    }
    args.update(overrides)
    return args


def test_validate_proposal_returns_expected_shape():
    proposal = validate_proposal(_valid_args())

    assert proposal["kind"] == PROPOSAL_KIND == "ergates.agent-proposal.v1"
    assert isinstance(proposal["proposal_id"], str) and proposal["proposal_id"]
    assert isinstance(proposal["expires_at"], str) and proposal["expires_at"]
    assert proposal["agent"] == {
        "name": "thijs",
        "title": "Thijs",
        "role": "Bookkeeper",
        "description": "Read invoices and prepare reconciliation notes.",
        "template_id": "bookkeeper",
        "provider": "operator-selected-provider",
        "model": "operator-selected-model",
    }
    assert proposal["briefing"] == "Role, boundaries, seed facts and reporting instructions."


def test_validate_proposal_rejects_a_bad_name():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(name="Thijs_Bad!"))


def test_validate_proposal_rejects_a_name_with_a_trailing_newline():
    """``$`` also matches before a final newline: "pim\\n" would reserve a name
    Hermes creates as "pim", and the gate would admit "pim" while it is set up."""
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(name="pim\n"))


@pytest.mark.parametrize("name", ["hermes", "default", "test", "tmp", "root", "sudo"])
def test_validate_proposal_rejects_a_name_hermes_reserves(name):
    """``profiles.create`` refuses these, so an accepted proposal could never
    finish and would keep the name reserved with no way to release it."""
    with pytest.raises(ProposalError) as raised:
        validate_proposal(_valid_args(name=name))
    assert raised.value.code == "invalid"
    assert "reserved" in str(raised.value)


def test_the_reserved_names_are_exactly_the_ones_the_test_above_checks():
    # `contract/test_reserved_profile_names.py` keeps this set equal to the pin.
    assert HERMES_RESERVED_PROFILE_NAMES == frozenset({"hermes", "default", "test", "tmp", "root", "sudo"})


def test_validate_proposal_accepts_a_name_that_only_contains_a_reserved_one():
    assert validate_proposal(_valid_args(name="hermes-helper"))["agent"]["name"] == "hermes-helper"


def test_validate_proposal_rejects_a_name_starting_with_a_hyphen():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(name="-thijs"))


def test_validate_proposal_rejects_a_single_character_name():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(name="t"))


def test_validate_proposal_accepts_a_name_at_the_length_boundary():
    proposal = validate_proposal(_valid_args(name="a" * 32))
    assert proposal["agent"]["name"] == "a" * 32


def test_validate_proposal_rejects_a_name_over_the_length_boundary():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(name="a" * 33))


def test_validate_proposal_rejects_an_overlong_briefing():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(briefing="x" * 4001))


def test_validate_proposal_accepts_briefing_at_the_length_boundary():
    proposal = validate_proposal(_valid_args(briefing="x" * 4000))
    assert len(proposal["briefing"]) == 4000


def test_validate_proposal_rejects_an_overlong_title():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(title="x" * 61))


def test_validate_proposal_accepts_title_at_the_length_boundary():
    proposal = validate_proposal(_valid_args(title="x" * 60))
    assert len(proposal["agent"]["title"]) == 60


def test_validate_proposal_rejects_an_overlong_role():
    with pytest.raises(ProposalError):
        validate_proposal(_valid_args(role="x" * 41))


def test_validate_proposal_accepts_role_at_the_length_boundary():
    proposal = validate_proposal(_valid_args(role="x" * 40))
    assert len(proposal["agent"]["role"]) == 40


def test_validate_proposal_rejects_missing_required_field():
    args = _valid_args()
    del args["template_id"]
    with pytest.raises(ProposalError):
        validate_proposal(args)


def test_payload_hash_is_stable_across_key_order():
    proposal = validate_proposal(_valid_args())

    # Same content, deliberately re-built with reversed / shuffled key order at
    # every level (top level and the nested "agent" object).
    shuffled = {
        "briefing": proposal["briefing"],
        "agent": {
            "model": proposal["agent"]["model"],
            "provider": proposal["agent"]["provider"],
            "template_id": proposal["agent"]["template_id"],
            "description": proposal["agent"]["description"],
            "role": proposal["agent"]["role"],
            "title": proposal["agent"]["title"],
            "name": proposal["agent"]["name"],
        },
        "expires_at": proposal["expires_at"],
        "proposal_id": proposal["proposal_id"],
        "kind": proposal["kind"],
    }

    assert payload_hash(proposal) == payload_hash(shuffled)
    # Sanity: the two dicts really do have different literal key order.
    assert list(proposal.keys()) != list(shuffled.keys())
    assert list(json.dumps(proposal)) != list(json.dumps(shuffled))


def test_payload_hash_changes_when_content_changes():
    a = validate_proposal(_valid_args())
    b = validate_proposal(_valid_args(role="Analyst"))

    assert payload_hash(a) != payload_hash(b)


def test_payload_hash_is_a_hex_sha256_digest():
    proposal = validate_proposal(_valid_args())

    digest = payload_hash(proposal)

    assert len(digest) == 64
    int(digest, 16)  # raises ValueError if not valid hex


# --- parsing expires_at -----------------------------------------------------


def test_parse_expires_at_handles_the_z_suffix_this_module_writes():
    proposal = validate_proposal(_valid_args())

    parsed = parse_expires_at(proposal["expires_at"])

    assert parsed is not None
    assert abs(parsed - (time.time() + PROPOSAL_EXPIRY.total_seconds())) < 60


def test_parse_expires_at_returns_none_for_junk_rather_than_raising():
    assert parse_expires_at(None) is None
    assert parse_expires_at("") is None
    assert parse_expires_at("not a timestamp") is None
    assert parse_expires_at(12345) is None
    assert parse_expires_at("2026-09-25T10:00:00") == parse_expires_at("2026-09-25T10:00:00Z")


# --- the proposal receipts --------------------------------------------------


@pytest.fixture
def clock():
    """Real time as the start: validate_proposal stamps expires_at from the wall clock."""
    return FakeClock(time.time())


@pytest.fixture
def service(store, clock):
    return ProposalService(store, clock=clock)


def _proposal(name="thijs", **overrides):
    proposal = validate_proposal(_valid_args(name=name, **overrides))
    proposal["source_session_id"] = "concierge-session-42"
    return proposal


def _recorded(service, name="thijs"):
    proposal = _proposal(name)
    service.record(proposal)
    return proposal


def _code(caught):
    return caught.value.code, caught.value.http_status


def test_record_returns_the_receipt_without_a_template(service):
    proposal = _proposal()

    receipt = service.record(proposal)

    assert receipt == {
        "proposal_id": proposal["proposal_id"],
        "state": "proposed",
        "reserved_profile_name": "thijs",
        "expires_at": proposal["expires_at"],
        "completed_steps": [],
        "step_status": {},
        "next_step": "profile_created",
    }
    assert service.get(proposal["proposal_id"]) == receipt


def test_the_store_keeps_the_hash_never_the_briefing_or_the_description(service, store):
    """docs/11 section 4.1: the receipt is the proposal hash, not the payload."""
    briefing = "Seed fact: the IBAN for the payroll account is NL00BANK0123456789."
    description = "Reconcile the payroll ledger every Monday."
    proposal = _proposal(briefing=briefing, description=description)

    service.record(proposal)

    row = rows(store, "proposal_receipts")[0]
    assert row["proposal_hash"] == payload_hash(proposal)
    assert row["source_session_id"] == "concierge-session-42"
    stored = raw_bytes(store)
    for content in (briefing, description, "Bookkeeper"):
        assert content.encode("utf-8") not in stored


def test_a_proposal_without_a_readable_expiry_is_refused(service, store):
    proposal = _proposal()
    proposal["expires_at"] = "soon"

    with pytest.raises(ProposalError) as caught:
        service.record(proposal)

    assert _code(caught) == ("invalid", 400)
    assert rows(store, "proposal_receipts") == []


def test_recording_the_same_proposal_twice_is_refused(service):
    proposal = _recorded(service)

    with pytest.raises(ProposalError) as caught:
        service.record(proposal)

    assert _code(caught) == ("invalid", 400)


def test_an_unknown_proposal_is_not_found(service):
    for call in (
        lambda: service.get("nope"),
        lambda: service.accept("nope", {"proposal_id": "nope"}, profile_exists=lambda name: False),
        lambda: service.reject("nope"),
        lambda: service.record_step("nope", "profile_created", "done"),
        lambda: service.complete("nope", profile_exists=lambda name: True, plugin_enabled=lambda name: True),
    ):
        with pytest.raises(ProposalError) as caught:
            call()
        assert _code(caught) == ("not_found", 404)


def test_a_proposal_past_its_expiry_reads_as_expired(service, clock):
    proposal = _recorded(service)
    clock.advance(PROPOSAL_EXPIRY.total_seconds() + 1)

    assert service.get(proposal["proposal_id"])["state"] == "expired"


# --- accept -----------------------------------------------------------------


def test_accept_reserves_the_profile_and_starts_provisioning(service):
    proposal = _recorded(service)

    receipt = service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    assert receipt["state"] == "accepted"
    assert receipt["next_step"] == "profile_created"
    assert service.is_admitted("thijs") is False


def test_accept_is_idempotent(service):
    proposal = _recorded(service)
    service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    again = service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: True)

    assert again["state"] == "accepted"


def test_accept_with_a_changed_payload_is_a_hash_mismatch(service):
    """The operator accepts the proposal exactly as the agent proposed it: no edits."""
    proposal = _recorded(service)
    edited = json.loads(json.dumps(proposal))
    edited["agent"]["role"] = "Administrator"

    with pytest.raises(ProposalError) as caught:
        service.accept(proposal["proposal_id"], edited, profile_exists=lambda name: False)

    assert _code(caught) == ("hash_mismatch", 409)


def test_accept_with_another_proposal_is_a_hash_mismatch(service):
    proposal = _recorded(service)
    other = _recorded(service, name="nora")

    with pytest.raises(ProposalError) as caught:
        service.accept(proposal["proposal_id"], other, profile_exists=lambda name: False)

    assert _code(caught) == ("hash_mismatch", 409)


def test_accept_after_expiry_is_gone(service, clock):
    proposal = _recorded(service)
    clock.advance(PROPOSAL_EXPIRY.total_seconds() + 1)

    with pytest.raises(ProposalError) as caught:
        service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    assert _code(caught) == ("expired", 410)


def test_accept_of_a_rejected_proposal_is_not_acceptable(service):
    proposal = _recorded(service)
    service.reject(proposal["proposal_id"])

    with pytest.raises(ProposalError) as caught:
        service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    assert _code(caught) == ("not_acceptable", 409)


def test_accept_when_the_profile_already_exists_is_name_taken(service):
    """docs/11 section 4.1: an unrelated name collision is an error, never an overwrite."""
    proposal = _recorded(service)

    with pytest.raises(ProposalError) as caught:
        service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: name == "thijs")

    assert _code(caught) == ("name_taken", 409)


def test_two_proposals_for_one_name_cannot_both_be_accepted(service, store):
    first = _recorded(service)
    second = _recorded(service)
    service.accept(first["proposal_id"], first, profile_exists=lambda name: False)

    with pytest.raises(ProposalError) as caught:
        service.accept(second["proposal_id"], second, profile_exists=lambda name: False)

    assert _code(caught) == ("name_taken", 409)
    assert service.get(second["proposal_id"])["state"] == "proposed"


def test_two_accepts_racing_for_one_name_accept_exactly_one(service):
    proposals = [_recorded(service) for _ in range(2)]
    barrier = threading.Barrier(2)
    results = []

    def accept(proposal):
        barrier.wait()
        try:
            results.append(service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)["state"])
        except ProposalError as exc:
            results.append(exc.code)

    threads = [threading.Thread(target=accept, args=(proposal,)) for proposal in proposals]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(results) == ["accepted", "name_taken"]


# --- reject -----------------------------------------------------------------


def test_reject_is_final_and_idempotent(service):
    proposal = _recorded(service)

    first = service.reject(proposal["proposal_id"])
    again = service.reject(proposal["proposal_id"])

    assert first["state"] == again["state"] == "rejected"
    assert first["next_step"] is None


def test_an_accepted_proposal_cannot_be_rejected(service):
    proposal = _recorded(service)
    service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    with pytest.raises(ProposalError) as caught:
        service.reject(proposal["proposal_id"])

    assert _code(caught) == ("not_acceptable", 409)


# --- provisioning steps and completion -------------------------------------


def _accepted(service, name="thijs"):
    proposal = _recorded(service, name)
    service.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)
    return proposal["proposal_id"]


def test_steps_are_recorded_in_order(service):
    proposal_id = _accepted(service)

    for step in PROVISION_STEPS[:3]:
        receipt = service.record_step(proposal_id, step, "done")

    assert receipt["completed_steps"] == ["profile_created", "plugin_enabled", "configured"]
    assert receipt["next_step"] == "bot_chat"


def test_a_step_before_its_predecessor_is_out_of_order(service):
    proposal_id = _accepted(service)

    with pytest.raises(ProposalError) as caught:
        service.record_step(proposal_id, "configured", "done")

    assert _code(caught) == ("out_of_order", 409)


def test_a_step_before_accept_is_out_of_order(service):
    proposal = _recorded(service)

    with pytest.raises(ProposalError) as caught:
        service.record_step(proposal["proposal_id"], "profile_created", "done")

    assert _code(caught) == ("out_of_order", 409)


def test_an_unknown_step_or_status_is_invalid(service):
    proposal_id = _accepted(service)

    for step, status in (("launch_rockets", "done"), ("profile_created", "maybe")):
        with pytest.raises(ProposalError) as caught:
            service.record_step(proposal_id, step, status)
        assert _code(caught) == ("invalid", 400)


def test_a_non_string_step_or_status_is_invalid_not_a_typeerror(service):
    """``status`` was checked with ``in`` against a frozenset: an unhashable value
    (a list or dict) raised ``TypeError`` there instead of the documented
    ``ProposalError``."""
    proposal_id = _accepted(service)

    for step, status in ((["profile_created"], "done"), ("profile_created", ["done"]), ({}, {})):
        with pytest.raises(ProposalError) as caught:
            service.record_step(proposal_id, step, status)
        assert _code(caught) == ("invalid", 400)


def test_an_uncertain_or_failed_step_does_not_advance(service):
    """docs/11 section 4.1: an uncertain briefing needs a deliberate retry."""
    proposal_id = _accepted(service)

    uncertain = service.record_step(proposal_id, "profile_created", "uncertain")
    failed = service.record_step(proposal_id, "profile_created", "failed")
    done = service.record_step(proposal_id, "profile_created", "done")

    assert uncertain["step_status"] == {"profile_created": "uncertain"}
    assert uncertain["next_step"] == "profile_created"
    assert failed["step_status"] == {"profile_created": "failed"}
    assert done["next_step"] == "plugin_enabled"


def test_a_done_step_reported_again_changes_nothing(service):
    """The app retries a step report after a crash: a done step stays done."""
    proposal_id = _accepted(service)
    service.record_step(proposal_id, "profile_created", "done")

    again = service.record_step(proposal_id, "profile_created", "failed")

    assert again["step_status"] == {"profile_created": "done"}
    assert again["next_step"] == "plugin_enabled"


def _all_steps_done(service, proposal_id):
    for step in PROVISION_STEPS:
        service.record_step(proposal_id, step, "done")


def test_complete_needs_every_step_done(service):
    proposal_id = _accepted(service)
    service.record_step(proposal_id, "profile_created", "done")

    with pytest.raises(ProposalError) as caught:
        service.complete(proposal_id, profile_exists=lambda name: True, plugin_enabled=lambda name: True)

    assert _code(caught) == ("not_ready", 409)


def test_complete_verifies_the_profile_and_the_plugin(service):
    """The server marks the proposal complete only after it checks both."""
    proposal_id = _accepted(service)
    _all_steps_done(service, proposal_id)

    for exists, enabled in ((False, True), (True, False)):
        with pytest.raises(ProposalError) as caught:
            service.complete(proposal_id, profile_exists=lambda name: exists, plugin_enabled=lambda name: enabled)
        assert _code(caught) == ("not_ready", 409)

    receipt = service.complete(proposal_id, profile_exists=lambda name: True, plugin_enabled=lambda name: True)
    assert receipt["state"] == "complete"
    assert receipt["next_step"] is None
    assert service.is_admitted("thijs") is True


def test_complete_is_idempotent(service):
    proposal_id = _accepted(service)
    _all_steps_done(service, proposal_id)
    service.complete(proposal_id, profile_exists=lambda name: True, plugin_enabled=lambda name: True)

    again = service.complete(proposal_id, profile_exists=lambda name: False, plugin_enabled=lambda name: False)

    assert again["state"] == "complete"
    assert service.record_step(proposal_id, "briefing", "done")["state"] == "complete"


def test_complete_of_a_proposed_proposal_is_not_ready(service):
    proposal = _recorded(service)

    with pytest.raises(ProposalError) as caught:
        service.complete(proposal["proposal_id"], profile_exists=lambda name: True, plugin_enabled=lambda name: True)

    assert _code(caught) == ("not_ready", 409)


def test_is_admitted_blocks_only_the_reserved_profile_while_it_is_provisioned(service):
    assert service.is_admitted("thijs") is True
    _accepted(service, "thijs")

    assert service.is_admitted("thijs") is False
    assert service.is_admitted("nora") is True


def test_a_profile_is_provisioned_once_its_configure_step_was_reported(service):
    """The toolset rule of the tool gate applies to this profile from then on (ADR-034)."""
    assert service.provisioned("thijs") is False
    proposal_id = _accepted(service, "thijs")
    assert service.provisioned("thijs") is False
    for step in ("profile_created", "plugin_enabled"):
        service.record_step(proposal_id, step, "done")
    assert service.provisioned("thijs") is False

    service.record_step(proposal_id, "configured", "failed")

    assert service.provisioned("thijs") is True
    assert service.provisioned("nora") is False


def test_a_completed_proposal_keeps_its_profile_provisioned(service):
    proposal_id = _accepted(service)
    _all_steps_done(service, proposal_id)
    service.complete(proposal_id, profile_exists=lambda name: True, plugin_enabled=lambda name: True)

    assert service.provisioned("thijs") is True


def test_a_proposed_or_rejected_proposal_provisions_nothing(service):
    _recorded(service, "thijs")
    rejected = _recorded(service, "nora")
    service.reject(rejected["proposal_id"])

    assert service.provisioned("thijs") is False
    assert service.provisioned("nora") is False


def test_the_default_profile_is_never_provisioned(service):
    assert service.provisioned("default") is False


# --- retention (04 section 8; 11 section 4.1) ------------------------------


def test_prune_drops_an_unaccepted_proposal_past_expiry_plus_grace(service, store, clock):
    _recorded(service, "thijs")
    rejected = _recorded(service, "nora")
    service.reject(rejected["proposal_id"])
    clock.advance(PROPOSAL_EXPIRY.total_seconds() + PROPOSAL_RETENTION_GRACE_SECONDS + 1)

    assert service.prune(clock()) == 2
    assert rows(store, "proposal_receipts") == []


def test_prune_keeps_a_proposal_inside_the_grace_window(service, clock):
    _recorded(service)
    clock.advance(PROPOSAL_EXPIRY.total_seconds() + 3600)

    assert service.prune(clock()) == 0


def test_prune_boundary_is_expiry_plus_the_documented_grace(service):
    proposal = _recorded(service)
    boundary = parse_expires_at(proposal["expires_at"]) + PROPOSAL_RETENTION_GRACE_SECONDS

    assert service.prune(boundary) == 0
    assert service.prune(boundary + 1) == 1


def test_prune_never_drops_an_accepted_or_complete_receipt(service, store, clock):
    """An accepted receipt is the provisioning record resume-by-receipt needs."""
    _accepted(service, "thijs")
    finished = _accepted(service, "nora")
    _all_steps_done(service, finished)
    service.complete(finished, profile_exists=lambda name: True, plugin_enabled=lambda name: True)
    clock.advance(30 * 86400)

    assert service.prune(clock()) == 0
    assert len(rows(store, "proposal_receipts")) == 2


def test_pruning_a_receipt_removes_its_steps(service, store, clock):
    proposal = _recorded(service)
    with store.transaction() as conn:
        conn.execute(
            "INSERT INTO proposal_steps (proposal_id, step, status, updated_at) VALUES (?, 'profile_created', 'failed', 1)",
            (proposal["proposal_id"],),
        )
    clock.advance(PROPOSAL_EXPIRY.total_seconds() + PROPOSAL_RETENTION_GRACE_SECONDS + 1)

    service.prune(clock())

    assert rows(store, "proposal_steps") == []


def test_proposal_error_maps_each_code_to_its_http_status():
    assert (ProposalError("x").code, ProposalError("x").http_status) == ("invalid", 400)
    assert ProposalError("x", code="unknown_template").http_status == 422
    with pytest.raises(ValueError):
        ProposalError("x", code="made_up")


# --- check_payload (the accept route's first check) ------------------------------


def test_check_payload_passes_the_recorded_proposal_and_changes_nothing(service):
    proposal = _recorded(service)

    service.check_payload(proposal["proposal_id"], proposal)

    assert service.get(proposal["proposal_id"])["state"] == "proposed"


def test_check_payload_refuses_an_unknown_id_and_every_other_payload(service):
    proposal = _recorded(service)
    cases = (
        ("nope", proposal, ("not_found", 404)),
        (proposal["proposal_id"], {**proposal, "briefing": "Another briefing."}, ("hash_mismatch", 409)),
        (proposal["proposal_id"], {**proposal, "proposal_id": "other"}, ("hash_mismatch", 409)),
        (proposal["proposal_id"], None, ("hash_mismatch", 409)),
    )
    for proposal_id, payload, expected in cases:
        with pytest.raises(ProposalError) as caught:
            service.check_payload(proposal_id, payload)
        assert _code(caught) == expected
