# Agent-traffic fixtures

Recorded on 2026-09-14 from a local `hermes serve` v0.21.2 (pin d76856cc) with two profiles: `default` (handle `hermes`, Hermes) and `kevin` (Kevin). Sanitized per docs/04 section 9: home paths → `/opt/data`, temp paths → `/opt/data/tmp`, no system prompt, no reasoning sidecars, no e-mail, no account name, install id → `install-fixture`, the owner's first name → "the owner".

What the backend actually produced: every delivery ran through the local CLI (`hermes -p kevin chat …`), even with Kevin's Bot Chat resumed on a second socket (the live admission needs the canonical live-owner lease, which a plain `session.resume` does not create). Kevin also answers through his own `message_agent`, so the sender's chat holds, per exchange, an inbound `Message from 🤖 kevin (@kevin): …` row followed by a receipt row. The refusal for an unknown teammate is a tool result (`{error, reason: "unknown", teammates, peers}`), not a receipt. Two sends in one turn produced two separate receipts, not a batch.

Five synthetic rows cite lines of Hermes v0.21.6 (818c13be), where the behavior they model only moved: `receipt-live-json`, `receipt-live-ambiguous`, `receipt-live-failed`, `receipt-batch-two` and `receipt-watch-match`. `receipt-batch-three` uses the same formatter as `receipt-batch-two`. Every other synthetic row models a 0.21.2 shape that v0.21.6 changed: the `message_agent` acknowledgment `sent` is now `queued` with a `delivery_id`, a reply cut short now carries a marker, and the relay waiter now runs `bot_mode_dm.py --wait-reply`. Task 5c on this branch redoes those fixtures and the recorded ones.

| File | Shape | Synthetic | Provenance |
|---|---|---|---|
| `receipt-cli.json` | cli | no | Recorded: local CLI delivery; stdout holds the reply, a "Resumed session" line and a "session_id:" line. |
| `receipt-cli-second.json` | cli | no | Recorded: second CLI delivery from the two-sends turn. |
| `receipt-refusal-json.json` | refusal-json | yes | Synthetic from tools/bot_mode_dm.py:391-396 (SESSION_NOT_OWNED refusal printed by --run-delivery). |
| `receipt-live-json.json` | live-json | yes | Synthetic from tools/bot_mode_dm.py:556-568 (_wait_live_dm payload) and :678-689 (queued result). |
| `receipt-live-ambiguous.json` | live-json | yes | Synthetic from tools/bot_mode_dm.py:556-568 (ambiguous exits 1). |
| `receipt-live-failed.json` | live-json | yes | Synthetic: terminal failed record (tui_gateway/session_notifications.py:657-667 classify_agent_error). |
| `receipt-batch-two.json` | batch | yes | Synthetic join of two recorded receipts per tools/process_registry_notifications.py:24-33 (ProcessNotificationBatch.render). |
| `receipt-batch-three.json` | batch | yes | Synthetic join of three recorded receipts (same formatter). |
| `receipt-relay-reply.json` | relay-reply | yes | Synthetic from tools/bot_relay.py:326-366 (waiter prints "Reply from <label>:" then the reply). |
| `receipt-relay-empty.json` | relay-reply | yes | Synthetic from tools/bot_relay.py:326-366 ("(empty reply)"). |
| `receipt-relay-failure.json` | relay-failure | yes | Synthetic from tools/bot_relay.py:326-366 (failure with a typed reason tag). |
| `receipt-relay-timeout.json` | relay-timeout | yes | Synthetic from tools/bot_relay.py:326-366 (timeout exits 1 while delivery may still succeed). |
| `receipt-subagent-trimmed.json` | subagent-trimmed | yes | Synthetic from tools/process_registry_notifications.py:326-376 (attribution line + 600-char trim marker). |
| `receipt-damaged.json` | damaged | yes | Synthetic: the 2,000-char tail of a long live payload (tools/process_registry.py:1288 keeps the tail, no marker); the paired result carries delivery_id. |
| `receipt-damaged-brace.json` | damaged | yes | Synthetic: a payload cut after the opening brace. |
| `receipt-exit-none.json` | exit-none | yes | Synthetic from tools/process_registry.py:719 (recovered process, exit code None) and :375-379. |
| `receipt-sigterm.json` | sigterm | yes | Synthetic from tools/process_registry_notifications.py:360-376 (", SIGTERM" for -15/143). |
| `receipt-lost.json` | lost | yes | Synthetic from tools/process_registry_notifications.py:_REASON_STATUS. |
| `receipt-watch-match.json` | watch-match | yes | Synthetic from tools/process_registry_notifications.py:432-437. |
| `result-refusal.json` | refusal-result | no | Recorded `tool.complete` result for a nonexistent target. |
| `transcript-sender.json` | REST page | no | `GET /api/sessions/{id}/messages?profile=default&limit=500&offset=0&order=latest` for Hermes's Bot Chat. |
| `transcript-sender-page1.json`, `transcript-sender-page2.json` | REST pages | cut | The same rows split at row 99: page 1 starts with the receipt for `proc_782bd84d7f2a`, whose send (rows 94/95) is on page 2. |
| `history-sender.json` | `session.history` | no | Hermes's Bot Chat over the socket (tool rows carry no ids; tool-call assistant rows have empty text and a reasoning summary). |
| `history-receiver.json` | `session.history` | no | Kevin's Bot Chat: inbound rows, reasoning-only assistant rows, tool rows and the terminal answer. |
| `events-sender.json` | event frames | no | One send-and-reply turn on Hermes's socket: `tool.start`, `tool.complete`, `message.complete`, `status.update {kind:"process"}`, the doubled `message.start`, `message.complete`. |

Re-record with `ERGATES_LIVE=1 ERGATES_RECORD=1 ERGATES_TOKEN=… ERGATES_OUT=… npx vitest run test/live/agent-traffic-record.live.test.ts`, then sanitize by hand.
