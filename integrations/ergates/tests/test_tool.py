"""Tests for ergates.tool: propose_handler, the approval-attention hooks and register().

propose_handler and the two approval hooks are the load-bearing glue described
in 11 section 4.1-4.2 ("never creates a profile", "records the proposal as
'proposed'", "writes a pending attention event ... and publishes to ntfy when
configured").
"""

import contextvars
import json
import logging
import sqlite3
import sys
import threading
import time
import types
from contextlib import contextmanager
from pathlib import Path

import pytest
import yaml

from conftest import FakeCron, hermes_profile_lookup, raw_bytes, rows
from ergates import hermes_adapter, policy, tool
from ergates.attention import AttentionService
from ergates.delivery import DeliveryWorker, NtfySettings
from ergates.paths import store_path
from ergates.policy import BLOCK_RAW_CRON, BLOCK_REVOKED, BLOCK_SETUP, BLOCK_UNVERIFIED
from ergates.proposals import ProposalService, payload_hash, validate_proposal
from ergates.reminders import ReminderService
from ergates.store import ControlStore, StoreError
from ergates.tool import (
    _resolve_profile,
    completed_platforms,
    create_reminder_handler,
    on_approval_request,
    on_approval_response,
    on_turn_completed,
    propose_handler,
)

_THREAD_TIMEOUT = 5.0
SETTINGS = NtfySettings(server="https://ntfy.example.internal", topic="hermes-alerts", token="tok",
                        connection_id="conn-1")


def _join(thread):
    """Wait for the background push thread (never longer than a watchdog)."""
    if thread is not None:
        thread.join(timeout=_THREAD_TIMEOUT)
        assert not thread.is_alive(), "push thread did not finish"
    return thread


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


@pytest.fixture
def proposals(store):
    return ProposalService(store)


@pytest.fixture
def attention(store):
    return AttentionService(store)


def _worker(store, publish):
    return DeliveryWorker(store, publish, SETTINGS)


# --- the propose tool ---------------------------------------------------------


def test_propose_handler_returns_json_and_records_it_as_proposed(proposals):
    result = propose_handler(_valid_args(), service=proposals)

    proposal = json.loads(result)
    assert "error" not in proposal
    assert proposal["kind"] == "ergates.agent-proposal.v1"
    assert proposals.get(proposal["proposal_id"])["state"] == "proposed"


def test_propose_handler_never_creates_a_profile_only_a_receipt(proposals, store, tmp_path):
    """propose_handler has no access to any profile-creation API at all --
    the only side effect it can have is one proposal receipt."""
    propose_handler(_valid_args(), service=proposals)

    assert [path.name for path in tmp_path.iterdir()] == ["ergates"]
    assert len(rows(store, "proposal_receipts")) == 1
    assert rows(store, "proposal_steps") == []


def test_propose_handler_returns_an_error_payload_for_invalid_input(proposals, store):
    result = propose_handler(_valid_args(name="Bad Name!"), service=proposals)

    payload = json.loads(result)
    assert "error" in payload
    assert rows(store, "proposal_receipts") == []


def _drop_the_receipts_table(store):
    with store.transaction() as conn:
        conn.execute("DROP TABLE proposal_steps")
        conn.execute("DROP TABLE proposal_receipts")


@pytest.mark.parametrize(
    ("break_the_store", "error_class"),
    [(lambda store: store.close(), StoreError), (_drop_the_receipts_table, sqlite3.OperationalError)],
    ids=["closed-store", "missing-table"],
)
def test_propose_handler_returns_an_error_payload_when_the_store_fails(proposals, store, caplog, break_the_store,
                                                                       error_class):
    """The Hermes tool contract: a handler always returns a JSON string. The
    error names the exception class only; its message can carry a file path."""
    break_the_store(store)

    with caplog.at_level(logging.WARNING, logger="ergates.tool"):
        result = propose_handler(_valid_args(), service=proposals)

    assert json.loads(result) == {"error": f"the proposal could not be recorded ({error_class.__name__})"}
    assert error_class.__name__ in caplog.text
    assert "proposal_receipts" not in result + caplog.text
    assert "closed" not in result + caplog.text


def test_propose_handler_attaches_the_backend_session_id_never_a_model_supplied_one(proposals, store):
    """source_session_id is backend-owned: it comes only from the handler's own
    session_id/task_id kwargs (how Hermes actually dispatches tool handlers --
    tools/registry.py's dispatch_kwargs), never from a model-supplied `args` field,
    even when a caller tries to smuggle one in."""
    args = _valid_args(source_session_id="model-supplied-fake-session")
    result = propose_handler(
        args, service=proposals, session_id="concierge-session-42", task_id="task-99",
    )

    proposal = json.loads(result)
    assert proposal["source_session_id"] == "concierge-session-42"
    assert rows(store, "proposal_receipts")[0]["source_session_id"] == "concierge-session-42"


def test_propose_handler_falls_back_to_task_id_when_session_id_is_absent(proposals):
    result = propose_handler(_valid_args(), service=proposals, task_id="task-only-77")

    proposal = json.loads(result)
    assert proposal["source_session_id"] == "task-only-77"


def test_propose_handler_source_session_id_is_none_when_hermes_supplies_neither(proposals):
    result = propose_handler(_valid_args(), service=proposals)

    proposal = json.loads(result)
    assert proposal["source_session_id"] is None


def test_the_returned_proposal_is_exactly_what_accept_verifies(proposals):
    """The app sends the tool result back unchanged; its hash must match the receipt."""
    proposal = json.loads(propose_handler(_valid_args(), service=proposals, session_id="s-1"))

    receipt = proposals.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    assert receipt["state"] == "accepted"


def test_propose_handler_stores_the_proposal_hash_never_the_briefing(proposals, store):
    """11 section 4.1: the receipt is "proposal hash, reserved profile name,
    completed steps, session id and briefing delivery state" -- the hash, not the
    text. The briefing is up to 4,000 characters of user content."""
    briefing = "Seed fact: the IBAN for the payroll account is NL00BANK0123456789."
    description = "Reconcile the payroll ledger every Monday."

    result = propose_handler(
        _valid_args(briefing=briefing, description=description),
        service=proposals, session_id="concierge-session-42",
    )

    proposal = json.loads(result)
    stored = rows(store, "proposal_receipts")[0]
    assert stored["proposal_hash"] == payload_hash(proposal)
    assert stored["reserved_profile_name"] == "thijs"
    assert stored["source_session_id"] == "concierge-session-42"
    on_disk = raw_bytes(store)
    for content in (briefing, description, "Bookkeeper", "Thijs"):
        assert content.encode("utf-8") not in on_disk


def test_extra_proposal_arguments_never_reach_the_proposal_or_the_receipt(proposals, store):
    """proposals.py builds from an allowlist."""
    result = propose_handler(
        _valid_args(mirror_credentials=True, share_auth="concierge", scopes=["*"]),
        service=proposals,
    )

    assert "mirror_credentials" not in result
    assert "share_auth" not in result
    assert b"mirror_credentials" not in raw_bytes(store)
    assert b"share_auth" not in raw_bytes(store)
    assert validate_proposal(_valid_args(mirror_credentials=True)).get("mirror_credentials") is None


# --- the approval hooks -----------------------------------------------------


class _CtxWhoseProfileNameRaises:
    @property
    def profile_name(self):
        raise RuntimeError("no active profile in this context")

    def get_config(self, key, default=None):
        return default


def test_resolve_profile_is_the_profile_hermes_reports_now():
    class Ctx:
        profile_name = "thijs"

    assert _resolve_profile(Ctx()) == "thijs"


def test_resolve_profile_is_none_when_hermes_cannot_tell():
    assert _resolve_profile(_CtxWhoseProfileNameRaises()) is None
    assert _resolve_profile(object()) is None


def test_on_approval_request_records_a_pending_event_with_its_push(attention, store):
    on_approval_request(attention, command="rm -rf /tmp/x", description="Delete a temp directory",
                        session_key="session-1", surface="cli", profile="thijs")

    event = rows(store, "attention_events")[0]
    assert (event["state"], event["session_id"], event["profile"], event["surface"]) == (
        "pending", "session-1", "thijs", "cli")
    assert rows(store, "attention_outbox")[0]["state"] == "due"


def test_on_approval_request_publishes_when_ntfy_is_configured(attention, store):
    published = []

    thread = on_approval_request(
        attention, worker=_worker(store, published.append), command="rm -rf /tmp/x",
        session_key="session-1", surface="cli", profile="thijs",
    )
    _join(thread)

    assert len(published) == 1
    assert published[0]["body"] == "You have a new request"
    assert published[0]["headers"]["Click"] == "ergates://chat/session-1?connection=conn-1&profile=thijs"
    assert rows(store, "attention_outbox")[0]["state"] == "sent"


def test_on_approval_request_without_ntfy_still_records_the_event(attention, store):
    assert on_approval_request(attention, command="rm -rf /tmp/x", session_key="session-1") is None

    assert len(rows(store, "attention_events")) == 1


def test_on_approval_request_never_stores_the_raw_command_or_description(attention, store):
    on_approval_request(attention, command="rm -rf /tmp/secret-project",
                        description="Delete the secret project directory", session_key="session-1")

    assert b"secret-project" not in raw_bytes(store)
    assert b"Delete the secret" not in raw_bytes(store)


def test_a_failed_first_push_stays_due_for_the_next_flush(attention, store):
    def failing_publish(spec):
        raise RuntimeError("connection refused")

    _join(on_approval_request(attention, worker=_worker(store, failing_publish), command="rm -rf /tmp/x",
                              session_key="session-1"))

    outbox = rows(store, "attention_outbox")[0]
    assert (outbox["state"], outbox["attempts"], outbox["last_error"]) == ("due", 1, "RuntimeError")
    assert rows(store, "attention_events")[0]["state"] == "pending"


def test_on_approval_request_returns_before_a_slow_publisher_completes(attention, store):
    """`pre_approval_request` is NOT in Hermes's _HOOK_TIMEOUT_BOUNDED_HOOKS
    (plugins_dispatch.py: "Hooks not listed below run synchronously to
    completion") and on the gateway path it fires BEFORE notify_cb reaches the
    app (approval_gateway_wait.py), so anything slow here delays the in-app
    approval card itself. The store write stays synchronous; the network call
    must not."""
    entered = threading.Event()
    release = threading.Event()

    def blocking_publish(spec):
        entered.set()
        assert release.wait(timeout=_THREAD_TIMEOUT), "publisher was never released"

    started = time.monotonic()
    thread = on_approval_request(attention, worker=_worker(store, blocking_publish), command="rm -rf /tmp/x",
                                 session_key="session-1")
    elapsed = time.monotonic() - started

    assert entered.wait(timeout=_THREAD_TIMEOUT)
    assert thread is not None and thread.is_alive()
    assert elapsed < 1.0
    # The event and its push were committed before the hook returned, so the
    # next flush sends the push even if this process dies now.
    assert rows(store, "attention_events")[0]["state"] == "pending"
    assert rows(store, "attention_outbox")[0]["state"] == "due"

    release.set()
    _join(thread)


_ROUTED_HOME = contextvars.ContextVar("routed_home", default=None)


def test_a_push_thread_runs_in_the_context_of_the_hook_call(attention, store):
    """A multiplexed gateway routes each session to its profile with a
    context-local Hermes home (Hermes's _HERMES_HOME_OVERRIDE). The push reads
    that profile's settings, its time zone for quiet hours included, so the
    thread must run in a copy of the caller's context, not a fresh one."""
    seen = []

    class Probe:
        def deliver(self, event_id):
            seen.append(_ROUTED_HOME.get())

    token = _ROUTED_HOME.set("profiles/nora")
    try:
        thread = on_approval_request(attention, worker=Probe(), command="cmd", session_key="s-1")
    finally:
        _ROUTED_HOME.reset(token)
    _join(thread)

    assert seen == ["profiles/nora"]


def test_a_push_thread_that_hits_a_store_error_only_logs(attention, store, caplog):
    class BrokenWorker:
        def deliver(self, event_id):
            raise OSError("disk full")

    _join(on_approval_request(attention, worker=BrokenWorker(), command="cmd", session_key="session-1"))

    assert "OSError" in caplog.text


def test_duplicate_hook_calls_record_and_push_nothing(attention, store):
    """A coalesced follower (approval_gateway_wait.py) or the smart guardian
    pre-check (approval_smart.py) is not a new prompt for the operator."""
    published = []
    worker = _worker(store, published.append)

    assert on_approval_request(attention, worker=worker, command="cmd", session_key="s1",
                               surface="gateway", coalesced=True) is None
    assert on_approval_request(attention, worker=worker, command="cmd", session_key="s1", surface="smart") is None

    assert rows(store, "attention_events") == []
    assert published == []


def test_on_approval_response_resolves_the_matching_pending_event(attention, store):
    on_approval_request(attention, command="rm -rf /tmp/x", session_key="session-1", surface="gateway")

    on_approval_response(attention, choice="once", decided_by="user", command="rm -rf /tmp/x",
                         session_key="session-1", surface="gateway")

    event = rows(store, "attention_events")[0]
    assert (event["state"], event["choice"]) == ("resolved", "once")
    assert event["resolved_at"] is not None
    assert rows(store, "attention_outbox")[0]["state"] == "cancelled"


def test_on_approval_response_ignores_a_coalesced_follower_response(attention, store):
    """A follower's post hook must not close out the leader's still-open request."""
    on_approval_request(attention, command="cmd", session_key="session-1", surface="gateway")

    assert on_approval_response(attention, choice="session", command="cmd", session_key="session-1",
                                surface="gateway", coalesced=True) is None
    assert rows(store, "attention_events")[0]["state"] == "pending"


# --- finished turns ---------------------------------------------------------


def test_completed_platforms_default_to_routines_only():
    assert completed_platforms(None) == frozenset({"cron"})
    assert completed_platforms(["cron", " telegram "]) == frozenset({"cron", "telegram"})
    assert completed_platforms([]) == frozenset()
    assert completed_platforms("cron") == frozenset({"cron"})
    assert completed_platforms(["cron", 7]) == frozenset({"cron"})


def test_a_finished_routine_turn_is_pushed_without_its_text(attention, store):
    """post_llm_call carries the user message and the reply; neither is stored."""
    published = []

    _join(on_turn_completed(
        attention, worker=_worker(store, published.append), profile="thijs", platforms=frozenset({"cron"}),
        session_id="cron-session-1", platform="cron", task_id="t", turn_id="u", model="m",
        user_message="Summarize the secret ledger", assistant_response="The secret ledger says",
        conversation_history=[{"role": "user", "content": "Summarize the secret ledger"}],
    ))

    assert published[0]["headers"]["Title"] == "A routine finished"
    assert published[0]["headers"]["Click"] == "ergates://chat/cron-session-1?connection=conn-1&profile=thijs"
    assert b"secret ledger" not in raw_bytes(store)


def test_a_finished_turn_on_another_platform_writes_nothing(attention, store):
    assert on_turn_completed(attention, worker=None, profile="thijs", platforms=frozenset({"cron"}),
                             session_id="s", platform="cli") is None
    assert rows(store, "attention_events") == []


# --- register(): one store under the Hermes root ----------------------------


class _RecordingCtx:
    """The parts of Hermes's PluginContext that register() uses."""

    profile_name = "thijs"

    def __init__(self, config=None):
        self.config = config or {}
        self.tools = {}
        self.hooks = {}

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, *, name, toolset, schema, handler, description, emoji):
        self.tools[name] = handler

    def register_hook(self, name, callback):
        self.hooks[name] = callback


@pytest.fixture
def profile_process(tmp_path, monkeypatch):
    """A Hermes process of the named profile `thijs`, outside a Hermes runtime."""
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    profile_home = tmp_path / "profiles" / "thijs"
    profile_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    return profile_home


def test_register_opens_the_store_under_the_hermes_root_not_the_profile_home(tmp_path, profile_process):
    """register() once put its journals under $HERMES_HOME, which is the
    profile's own home in a named profile. Every profile now shares one store."""
    ctx = _RecordingCtx()

    tool.register(ctx)
    ctx.tools["ergates_propose_agent"](_valid_args(), session_id="s-1")
    ctx.hooks["pre_approval_request"](command="cmd", session_key="s-1", surface="gateway")

    assert (tmp_path / "ergates" / "control.sqlite3").exists()
    assert list(profile_process.iterdir()) == []


def _write_root_settings(root, **ntfy):
    """The install-wide push settings: plugins.entries.ergates.settings.ntfy in the root's config.yaml."""
    (root / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"entries": {"ergates": {"settings": {"ntfy": ntfy}}}}}), encoding="utf-8")


def test_register_wires_the_tool_and_every_hook_end_to_end(tmp_path, profile_process, monkeypatch):
    published = []
    monkeypatch.setattr(tool, "send_ntfy", published.append)
    _write_root_settings(tmp_path, server="https://ntfy.example.internal", topic="alerts", connection_id="conn-1")
    ctx = _RecordingCtx()
    tool.register(ctx)

    proposal = json.loads(ctx.tools["ergates_propose_agent"](_valid_args(), session_id="s-1"))
    ctx.hooks["pre_approval_request"](command="cmd", session_key="s-1", surface="gateway",
                                      description="ignored", pattern_keys=["p"])
    deadline = time.monotonic() + _THREAD_TIMEOUT
    while not published and time.monotonic() < deadline:
        time.sleep(0.01)
    ctx.hooks["post_approval_response"](command="cmd", session_key="s-1", surface="gateway", choice="once",
                                        decided_by="user")
    ctx.hooks["post_llm_call"](session_id="cron-1", platform="cron", user_message="hi", assistant_response="done")
    ctx.hooks["post_llm_call"](session_id="chat-1", platform="cli", user_message="hi", assistant_response="done")

    store = ControlStore(store_path(tmp_path))
    assert rows(store, "proposal_receipts")[0]["id"] == proposal["proposal_id"]
    events = {row["kind"]: row for row in rows(store, "attention_events")}
    assert set(events) == {"approval", "completion"}
    assert events["approval"]["state"] == "resolved"
    assert events["completion"]["session_id"] == "cron-1"
    assert published[0]["headers"]["Click"] == "ergates://chat/s-1?connection=conn-1&profile=thijs"


def test_plugin_yaml_declares_exactly_what_register_registers(profile_process):
    """`hermes plugins doctor` fails on an undeclared hook; this is the same check in the suite."""
    manifest = yaml.safe_load((Path(__file__).resolve().parents[1] / "plugin.yaml").read_text(encoding="utf-8"))
    ctx = _RecordingCtx()

    tool.register(ctx)

    assert sorted(manifest["provides_tools"]) == sorted(ctx.tools)
    assert sorted(manifest["provides_hooks"]) == sorted(ctx.hooks)


def test_register_reads_the_completed_platforms_setting(tmp_path, profile_process):
    ctx = _RecordingCtx({"attention.completed_platforms": ["cli"]})
    tool.register(ctx)

    ctx.hooks["post_llm_call"](session_id="cron-1", platform="cron")
    ctx.hooks["post_llm_call"](session_id="chat-1", platform="cli")

    store = ControlStore(store_path(tmp_path))
    assert [row["session_id"] for row in rows(store, "attention_events")] == ["chat-1"]


# --- per-call profile -------------------------------------------------------


class _MultiplexedCtx(_RecordingCtx):
    """One plugin context serving several profiles, like a multiplexed gateway's."""

    def __init__(self, *names, config=None):
        super().__init__(config)
        self._names = iter(names)

    @property
    def profile_name(self):
        return next(self._names)


class _ProfilelessCtx(_RecordingCtx):
    """A plugin context whose profile Hermes cannot report."""

    @property
    def profile_name(self):
        raise RuntimeError("no active profile in this context")


def test_each_hook_call_records_the_profile_it_runs_in(tmp_path, profile_process):
    """The profile was once fixed by the process's HERMES_HOME. Hermes
    reports it per call, and a multiplexed gateway switches it per session."""
    ctx = _MultiplexedCtx("concierge", "thijs")
    tool.register(ctx)

    ctx.hooks["pre_approval_request"](command="cmd", session_key="s-1", surface="gateway")
    ctx.hooks["pre_approval_request"](command="cmd", session_key="s-2", surface="gateway")

    store = ControlStore(store_path(tmp_path))
    assert [row["profile"] for row in rows(store, "attention_events")] == ["concierge", "thijs"]


# --- the tool gate ----------------------------------------------------------


def _gate(ctx):
    tool.register(ctx)
    return ctx.hooks["pre_tool_call"]


def test_the_gate_blocks_a_raw_cron_create_and_lets_everything_else_run(profile_process):
    gate = _gate(_RecordingCtx())

    assert gate(tool_name="cronjob_manage", args={"action": "create", "prompt": "p"}, task_id="t") == {
        "action": "block", "message": BLOCK_RAW_CRON}
    assert gate(tool_name="cronjob_manage", args={"action": "list"}, task_id="t") is None
    assert gate(tool_name="ergates_create_reminder", args={"schedule": "0 9 * * *"}, task_id="t") is None


def test_the_gate_blocks_every_tool_of_a_profile_still_being_provisioned(tmp_path, profile_process):
    proposals = ProposalService(ControlStore(store_path(tmp_path)))
    proposal = validate_proposal(_valid_args(name="thijs"))
    proposals.record(proposal)
    proposals.accept(proposal["proposal_id"], proposal, profile_exists=lambda name: False)

    assert _gate(_RecordingCtx())(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_SETUP}
    assert _gate(_MultiplexedCtx("concierge"))(tool_name="terminal", args={}) is None


def test_a_gate_whose_check_raises_blocks_the_tool(profile_process, monkeypatch):
    """Hermes runs the tool when a pre_tool_call callback raises. The registered
    callback itself must never raise: a failed check is a block."""
    def broken(*args, **kwargs):
        raise RuntimeError("the control store is unreadable")

    monkeypatch.setattr(policy, "decide", broken)

    assert _gate(_RecordingCtx())(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}
    assert _gate(_ProfilelessCtx())(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}


def test_the_gate_asks_for_the_grant_of_the_calling_profile_at_every_call(profile_process, monkeypatch):
    """Rule 3 reads the profile's grant and the tool's toolset at the moment of the
    call: a toolset taken out of the pin is blocked without a new session, and
    a multiplexed gateway asks for each call's own profile."""
    grants = {"thijs": frozenset({"web"}), "nora": None}
    monkeypatch.setattr(hermes_adapter, "granted_toolsets", grants.__getitem__)
    monkeypatch.setattr(hermes_adapter, "toolset_for_tool", {"terminal": "terminal", "web_search": "web"}.get)
    gate = _gate(_MultiplexedCtx("thijs", "thijs", "nora"))

    assert gate(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_REVOKED}
    assert gate(tool_name="web_search", args={}) is None
    assert gate(tool_name="terminal", args={}) is None  # nora pins no toolsets


def test_a_grant_that_cannot_be_read_blocks_the_call(profile_process, monkeypatch):
    def unreadable(profile):
        raise OSError("the profile config cannot be read")

    monkeypatch.setattr(hermes_adapter, "granted_toolsets", unreadable)

    assert _gate(_RecordingCtx())(tool_name="web_search", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}


@contextmanager
def _fake_profile_home(profile):
    yield Path("/hermes/profiles") / profile


def _stub_hermes_grant_modules(monkeypatch, config, *, drop_mcp_reader=False):
    """Fake the Hermes modules ``granted_toolsets`` imports, so its real import
    and config-reading logic runs without a Hermes install. ``drop_mcp_reader``
    leaves ``tools.mcp_tool_common`` without the symbol the grant reads, the
    way a Hermes upgrade that renames or removes it would (v0.21.6 removed the
    one read before, ``tools.mcp_tool_registration._server_enabled``)."""
    monkeypatch.setattr(hermes_adapter, "_profile_home", _fake_profile_home)
    hermes_config = types.ModuleType("hermes_cli.config")
    hermes_config.load_config_readonly = lambda: config
    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.config", hermes_config)
    model_tools = types.ModuleType("model_tools")
    model_tools.get_toolset_for_tool = lambda tool_name: None
    monkeypatch.setitem(sys.modules, "model_tools", model_tools)
    toolsets_module = types.ModuleType("toolsets")
    toolsets_module.resolve_toolset = lambda name: []
    monkeypatch.setitem(sys.modules, "toolsets", toolsets_module)
    utils_module = types.ModuleType("utils")
    utils_module.is_truthy_value = lambda value, default=False: bool(value)
    monkeypatch.setitem(sys.modules, "utils", utils_module)
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    mcp_common = types.ModuleType("tools.mcp_tool_common")
    if not drop_mcp_reader:
        mcp_common.mcp_server_enabled = lambda entry: entry.get("enabled", True) is not False
    monkeypatch.setitem(sys.modules, "tools.mcp_tool_common", mcp_common)


def test_a_hermes_symbol_the_grant_needs_going_missing_blocks_instead_of_disarming_the_gate(
        profile_process, monkeypatch):
    """Only "Hermes is not here" (``hermes_cli.config`` unimportable) may read as
    "no toolsets pinned". A Hermes present but missing a private symbol the
    grant also reads, the way an upgrade renaming it would look, must not be
    swallowed the same way: the pre_tool_call hook blocks."""
    _stub_hermes_grant_modules(monkeypatch, {"tools": {"enabled_toolsets": ["web"]}}, drop_mcp_reader=True)

    assert _gate(_RecordingCtx())(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}


def test_a_toolset_pin_that_is_not_a_list_blocks_instead_of_granting_nothing(profile_process, monkeypatch):
    """A hand-edited ``enabled_toolsets: web`` (a string, not a list) must not
    read as "no toolsets pinned", which would let Hermes decide every tool:
    the pre_tool_call hook blocks until it is fixed."""
    _stub_hermes_grant_modules(monkeypatch, {"tools": {"enabled_toolsets": "web"}})

    assert _gate(_RecordingCtx())(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}


def _store_folder_is_a_file(root):
    (root / "ergates").write_text("", encoding="utf-8")


def _store_from_a_newer_plugin(root):
    store = ControlStore(store_path(root))
    with store.transaction() as conn:
        conn.execute("PRAGMA user_version = 99")


@pytest.mark.parametrize(
    ("break_the_store", "error_class"),
    [(_store_folder_is_a_file, NotADirectoryError), (_store_from_a_newer_plugin, StoreError)],
    ids=["folder-is-a-file", "newer-schema"],
)
def test_register_registers_the_gate_when_the_store_cannot_open(tmp_path, profile_process, caplog, break_the_store,
                                                                error_class):
    """Hermes disposes of every registration of a plugin whose register() raises,
    the gate included, and then runs every tool call unchecked (fail open). So
    register() never raises for the store; the gate blocks until the store opens."""
    break_the_store(tmp_path)
    ctx = _RecordingCtx()

    with caplog.at_level(logging.WARNING, logger="ergates.tool"):
        tool.register(ctx)
        gate_result = ctx.hooks["pre_tool_call"](tool_name="terminal", args={})
        proposed = json.loads(ctx.tools["ergates_propose_agent"](_valid_args(), session_id="s-1"))
        reminded = json.loads(ctx.tools["ergates_create_reminder"](_reminder_args(), session_id="s-1"))

    assert sorted(ctx.hooks) == ["post_approval_response", "post_llm_call", "pre_approval_request", "pre_tool_call"]
    assert sorted(ctx.tools) == ["ergates_create_reminder", "ergates_propose_agent"]
    assert gate_result == {"action": "block", "message": BLOCK_UNVERIFIED}
    assert proposed == {"error": f"the proposal could not be recorded ({error_class.__name__})"}
    assert reminded == {"error": f"the reminder could not be recorded ({error_class.__name__})"}
    assert error_class.__name__ in caplog.text
    assert str(tmp_path) not in caplog.text


def test_the_gate_opens_the_store_once_it_can(tmp_path, profile_process):
    _store_folder_is_a_file(tmp_path)
    gate = _gate(_RecordingCtx())
    assert gate(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}

    (tmp_path / "ergates").unlink()

    assert gate(tool_name="terminal", args={}) is None
    assert store_path(tmp_path).exists()


class _DefaultCtx(_RecordingCtx):
    profile_name = "default"


def test_the_gate_blocks_when_default_is_hermes_fallback_for_a_failed_lookup(profile_process, monkeypatch):
    """Hermes's profile_name answers "default" when its own lookup raises. The
    default profile is always admitted, so a profile still being set up would
    run every tool. The adapter asks the lookup itself, and the gate blocks."""
    def lookup_fails():
        raise OSError("the Hermes home cannot be resolved")

    hermes_profile_lookup(monkeypatch, lookup_fails)
    assert _gate(_DefaultCtx())(tool_name="terminal", args={}) == {"action": "block", "message": BLOCK_UNVERIFIED}

    hermes_profile_lookup(monkeypatch, lambda: "default")
    assert _gate(_DefaultCtx())(tool_name="terminal", args={}) is None


# --- ergates_create_reminder ---------------------------------------------------------


def _reminder_args(**overrides):
    args = {"schedule": "0 9 * * *", "prompt": "Check the unpaid invoices.", "timezone": "Europe/Amsterdam",
            "label": "Invoices"}
    args.update(overrides)
    return args


def _no_check(profile, schedule):
    return None


def _no_prompt_check(prompt):
    return None


def _no_lifecycle_check(profile, prompt):
    return None


def _ask(args, service, *, profile="thijs", check_schedule=_no_check, check_prompt=_no_prompt_check,
         check_gateway_lifecycle=_no_lifecycle_check):
    """The reminder tool's answer, parsed."""
    return json.loads(create_reminder_handler(args, service=service, profile=profile,
                                              check_schedule=check_schedule, check_prompt=check_prompt,
                                              check_gateway_lifecycle=check_gateway_lifecycle))


def test_the_reminder_tool_creates_once_and_returns_the_same_reminder_again(store, cron):
    service = ReminderService(store, cron)

    first = _ask(_reminder_args(), service)
    again = _ask(_reminder_args(), service)

    assert (first["status"], again["status"]) == ("created", "existing")
    assert first["receipt"]["job_id"] == again["receipt"]["job_id"]
    assert len(cron.jobs) == 1
    assert cron.create_calls[0]["name"].startswith("[bot:thijs] Invoices · ")


def test_the_reminder_tool_makes_a_one_shot_again_once_hermes_ran_it(store, cron):
    """Hermes keeps a one-shot that ran as a completed job for 7 days. The model
    asking for the same one-shot again wants a new reminder, not that record."""
    service = ReminderService(store, cron)

    first = _ask(_reminder_args(schedule="in 30m"), service)
    cron.complete_job(first["receipt"]["job_id"])
    second = _ask(_reminder_args(schedule="in 30m"), service)

    assert (first["status"], second["status"]) == ("created", "created")
    assert second["receipt"]["job_id"] != first["receipt"]["job_id"]
    assert len(cron.create_calls) == 2


@pytest.mark.parametrize(("args", "message"), [
    ("not an object", "the arguments must be an object"),
    (_reminder_args(timezone="Mars/Olympus"), "timezone must be an IANA time zone name, for example Europe/Amsterdam"),
    (_reminder_args(label="x" * 65), "label must be 1 to 64 printable characters"),
    (_reminder_args(prompt=""), "prompt is required and must be a non-empty string"),
])
def test_the_reminder_tool_refuses_bad_arguments_before_cron(store, cron, args, message):
    result = _ask(args, ReminderService(store, cron))

    assert result == {"error": message}
    assert cron.create_calls == []


def test_the_reminder_tool_refuses_a_schedule_hermes_refuses(store, cron):
    def refuse(profile, schedule):
        raise ValueError("Invalid schedule")

    result = _ask(_reminder_args(schedule="soon"), ReminderService(store, cron), check_schedule=refuse)

    assert result == {"error": "schedule is not one Hermes cron accepts"}
    assert cron.create_calls == []


def test_the_reminder_tool_refuses_a_schedule_out_of_range_like_post_reminders(store, cron):
    def overflow(profile, schedule):
        raise OverflowError("date value out of range")

    result = _ask(_reminder_args(schedule="in 99999999999m"), ReminderService(store, cron), check_schedule=overflow)

    assert result == {"error": "schedule is not one Hermes cron accepts"}
    assert cron.create_calls == []


def test_the_reminder_tool_refuses_a_prompt_hermes_cron_refuses(store, cron):
    """Hermes's create would refuse it on every try: an error, never an uncertain reminder."""
    def refuse(prompt):
        raise ValueError(f"Blocked: {prompt!r} contains invisible unicode U+200B")

    result = _ask(_reminder_args(prompt="Pay\u200b the rent."), ReminderService(store, cron), check_prompt=refuse)

    assert result == {"error": "prompt is not one Hermes cron accepts"}
    assert cron.create_calls == [] and rows(store, "reminder_receipts") == []


def test_the_reminder_tool_refuses_a_prompt_that_reads_as_stopping_the_gateway(store, cron):
    """Hermes's create would refuse it on every try: an error, never an uncertain reminder."""
    seen = []

    def refuse(profile, prompt):
        seen.append((profile, prompt))
        raise ValueError(f"Blocked: {prompt!r} contains a gateway lifecycle command")

    prompt = "Remind me to kill time before the Hermes gateway meeting."
    result = _ask(_reminder_args(prompt=prompt), ReminderService(store, cron), check_gateway_lifecycle=refuse)

    assert result == {
        "error": "prompt reads as a command to stop or restart the Hermes gateway, which Hermes cron refuses"}
    assert seen == [("thijs", prompt)]
    assert cron.create_calls == [] and rows(store, "reminder_receipts") == []


def test_the_reminder_tool_answers_an_error_when_the_prompt_cannot_be_checked(store, cron, caplog):
    def vanished(profile, prompt):
        raise FileNotFoundError("profile 'thijs' does not exist at /secret/hermes/profiles/thijs")

    with caplog.at_level(logging.WARNING, logger="ergates.tool"):
        result = _ask(_reminder_args(), ReminderService(store, cron), check_gateway_lifecycle=vanished)

    assert result == {"error": "the prompt could not be checked"}
    assert "FileNotFoundError" in caplog.text and "/secret" not in caplog.text
    assert cron.create_calls == []


def test_the_reminder_tool_refuses_a_lone_surrogate_in_the_prompt(store, cron):
    result = _ask(_reminder_args(prompt="Pay the \ud800 rent."), ReminderService(store, cron))

    assert result == {"error": "prompt must be valid Unicode text"}
    assert cron.create_calls == []


def test_the_reminder_tool_answers_an_error_when_the_schedule_cannot_be_checked(store, cron, caplog):
    """The profile's home can vanish between the call and the check: still a JSON
    answer, naming the exception class only in the log (its message has a path)."""
    def vanished(profile, schedule):
        raise FileNotFoundError("profile 'thijs' does not exist at /secret/hermes/profiles/thijs")

    with caplog.at_level(logging.WARNING, logger="ergates.tool"):
        result = _ask(_reminder_args(), ReminderService(store, cron), check_schedule=vanished)

    assert result == {"error": "the schedule could not be checked"}
    assert "FileNotFoundError" in caplog.text and "/secret" not in caplog.text
    assert cron.create_calls == []


def test_the_reminder_tool_reports_a_service_refusal_as_an_error(store, cron):
    result = _ask(_reminder_args(), ReminderService(store, cron), profile="Not A Profile")

    assert result == {"error": "profile must be a Hermes profile name"}


def test_the_reminder_tool_reports_a_store_failure_as_an_error(store, cron, caplog):
    """The Hermes tool contract: a handler always returns a JSON string. The
    error names the exception class only; its message can carry a file path."""
    store.close()

    with caplog.at_level(logging.WARNING, logger="ergates.tool"):
        result = _ask(_reminder_args(), ReminderService(store, cron))

    assert result == {"error": "the reminder could not be recorded (StoreError)"}
    assert "StoreError" in caplog.text
    assert "closed" not in caplog.text
    assert cron.create_calls == []


def test_register_wires_the_reminder_tool_to_the_profile_hermes_reports(tmp_path, profile_process, monkeypatch):
    cron = FakeCron()
    monkeypatch.setattr(hermes_adapter, "HermesCron", lambda: cron)
    monkeypatch.setattr(hermes_adapter, "check_schedule", _no_check)
    monkeypatch.setattr(hermes_adapter, "check_prompt", _no_prompt_check)
    lifecycle_checks = []
    monkeypatch.setattr(hermes_adapter, "check_gateway_lifecycle",
                        lambda profile, prompt: lifecycle_checks.append((profile, prompt)))
    ctx = _MultiplexedCtx("nora")
    tool.register(ctx)

    result = json.loads(ctx.tools["ergates_create_reminder"](_reminder_args(), task_id="t", session_id="s"))

    assert result["status"] == "created"
    assert result["receipt"]["profile"] == "nora"
    assert cron.create_calls[0]["profile"] == "nora"
    assert lifecycle_checks == [("nora", "Check the unpaid invoices.")]


def test_the_reminder_tool_answers_an_error_when_hermes_cannot_tell_the_profile(profile_process):
    ctx = _ProfilelessCtx()
    tool.register(ctx)

    assert json.loads(ctx.tools["ergates_create_reminder"](_reminder_args())) == {
        "error": "Ergates could not tell which agent is asking"}


# --- install-wide push settings -------------------------------------------------------


def _wait_for(published):
    deadline = time.monotonic() + _THREAD_TIMEOUT
    while not published and time.monotonic() < deadline:
        time.sleep(0.01)


def test_every_profile_pushes_with_the_install_settings_in_the_root_config(tmp_path, profile_process, monkeypatch):
    """One store serves every profile, and so do the push settings: a profile's own
    config (or its plugin settings) no longer decides where a push goes."""
    published = []
    monkeypatch.setattr(tool, "send_ntfy", published.append)
    _write_root_settings(tmp_path, server="https://ntfy.example.internal", topic="alerts", connection_id="conn-1")
    (profile_process / "config.yaml").write_text("plugins: {entries: {ergates: {settings: {ntfy: "
                                                  "{server: 'https://elsewhere.example', topic: x}}}}}\n")
    ctx = _RecordingCtx({"ntfy.server": "https://elsewhere.example", "ntfy.topic": "x"})
    tool.register(ctx)

    ctx.hooks["pre_approval_request"](command="cmd", session_key="s-1", surface="gateway")
    _wait_for(published)

    assert [spec["url"] for spec in published] == ["https://ntfy.example.internal/alerts"]


def test_unreadable_push_settings_still_record_the_event_for_the_flush(tmp_path, profile_process, caplog):
    (tmp_path / "config.yaml").write_text("plugins: [unclosed\n", encoding="utf-8")
    ctx = _RecordingCtx()
    tool.register(ctx)

    ctx.hooks["pre_approval_request"](command="cmd", session_key="s-1", surface="gateway")

    store = ControlStore(store_path(tmp_path))
    assert rows(store, "attention_outbox")[0]["state"] == "due"
    assert "push settings unreadable" in caplog.text
