# 02 - Functional Design

| Field | Value |
|---|---|
| Version | 0.3 (corrected requirements and mobile direction) |
| Date | 2026-09-12 |
| Basis | Internal research notes, not published (business rules BR-01..BR-40), Jop's brief |
| Mapping | Hermes primitives are mapped in 03; gaps, integration work and acceptance checks are explicit in 11. Requirement status is not proof of implementation. |

Requirement IDs: **FR-xxx** functional, **NFR-xxx** non-functional, **BR-xx** business rules from the research. Priority: **M** must (Phase 1), **S** should (Phase 2), **C** could (Phase 3+).

## 1. Actors

| Actor | Description |
|---|---|
| User (Owner) | The person who chats with agents. Phase 1: Jop only. |
| Concierge agent | The default agent the user talks to. Creates and manages specialists. |
| Specialist agent | An agent created for one role (bookkeeper, trainer, dining scout, coach). |
| Platform | Hermes on the VPS owns execution/state; the Ergates integration supplies proposal and attention delivery gaps. The mobile app is the client. |
| Connector | An MCP server configured on an agent's Hermes profile (Outlook, ClickUp, Moneybird, and so on). |
| Operator | Person who deploys, updates, backs up (Jop). |
| Org admin / Member | Phase 3 business roles. |

## 2. Epics and user stories

### Epic E1 - Conversations
- US-1.1 As a user I open the app and see my agents on Home with avatar, name, title, last message, and time, so I can pick who to talk to. (M)
- US-1.2 As a user I send text, voice-to-text, images, and files to an agent and get replies with rich formatting. (M)
- US-1.3 As a user I answer a question by tapping a choice card, by typing a letter, or by typing my own answer, so interviews are fast on my phone. (M)
- US-1.4 As a user I quote-reply to a specific message so the agent knows what I mean. (S)
- US-1.5 As a user I see compact event rows (routine created, renamed, messaged X) so I always know what happened. (M)
- US-1.6 As a user I start a new chat with one or more agents (group chat) from a "+" button. (S)
- US-1.7 As a user I search my conversations. (S)

### Epic E2 - Agent lifecycle
- US-2.1 As a user I create an agent by telling the concierge, optionally with a zip that contains a skill package. (M)
- US-2.2 As a user I name an agent and give it an avatar by chatting with it. (M)
- US-2.3 As a user I edit a bot on my phone with desktop-equivalent appearance, display name, description, instructions, provider/model, skills, tools and connectors; role badge and notification settings are also available, with Save/Cancel. (M)
- US-2.4 As a user I delete an agent. (M)
- US-2.5 As a user I export an agent as a template and import a template. (S)
- US-2.6 As a user I choose per agent which provider and model it uses (any provider Hermes supports, including a custom model name), and I can change it later without losing the agent's memory. (M)
- US-2.7 As an operator I see which providers are signed in on the server (Hermes `model.options`), and the app only offers those. (M)
- US-2.8 As a user I organize bots with unread markers, pins, sections and Hide, recover hidden bots, and open editing from a compact action menu. Copy ID and Delete are under More; template export and duplication follow in Phase 2. (M; export/duplicate S)

### Epic E3 - Agent collaboration
- US-3.1 As a concierge I create a specialist, brief it, and get an acknowledgement. (M)
- US-3.2 As a concierge I delegate a task with a report template and get lifecycle pings (start, waiting, done, blocked). (M)
- US-3.3 As a user I open a merged read-only exchange transcript between two agents. (S; individual Bot Chat events are Phase 1)
- US-3.4 As a concierge I broadcast one instruction to several agents. (S)

### Epic E4 - Routines and time
- US-4.1 As a user I ask for an ordinary reminder in chat and receive a push with measured scheduling/delivery latency. Precise short timers are deferred. (M)
- US-4.2 As a user I create or edit a routine in a form: name, instruction, trigger (schedule; webhook in Phase 2), active toggle, test run, run history. (M)
- US-4.3 As an agent I create, update, merge, reschedule, and delete my routines. (M)

### Epic E5 - Tools and connectors
- US-5.1 As a user I add a connector from a catalog, connect my account (OAuth or token), and switch tools on or off one by one. (M)
- US-5.2 As a user I decide per agent which connectors it may use. (M)
- US-5.3 As an agent I ask the user to add or connect a connector through a card in the chat. (S)
- US-5.4 As an agent I can report my available tools; the user can inspect verified connector/auth state in details. (M)

### Epic E6 - Safety and approvals
- US-6.1 As a user I approve or deny a risky action from a card in the chat, also on my phone. (M)
- US-6.2 As a user I understand which actions require approval and which tools are excluded. Plain-language policy rules are deferred; Hermes does not provide this UI or general policy guarantee. (C)
- US-6.3 As a user I can rely on built-in hard limits that no rule can override (no sending mail when the tool is off). (M)

### Epic E7 - Files and memory
- US-7.1 As a user I upload a zip; the agent unpacks, converts, and analyzes it. (M)
- US-7.2 As an agent I return files as downloadable cards. (M)
- US-7.3 As a user I say "remember this" and the agent keeps it; I can view its memories and ask the agent to update them; a direct mobile editor is deferred. (M)

### Epic E8 - Operations
- US-8.1 As an operator I see usage per agent and per day, and a warning against a configured token/cost threshold where measurements are available. (S)
- US-8.2 As an operator I deploy, update, back up, and restore with documented commands. (M)

### Epic E9 - Business (Phase 3)
- US-9.1 As an operator I configure separate user gateways and verified sharing access; roles inside one gateway are out of scope. (C)
- US-9.2 As a member I take part in group chats with agents and colleagues. (C)
- US-9.3 As an operator I inspect operational history and define any additional business audit requirements. (C)

## 3. Functional requirements

### 3.1 Conversations and threads
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-101 | The system keeps threads. Phase 1 has one owner and one agent per primary thread; multiple participants use Phase 2 rooms. | M | BR-39 |
| FR-102 | Each agent has a primary 1:1 thread with the owner, shown on Home with name, optional title badge, avatar, last message preview, time, unread dot; optional device-local pinned shortcuts. | M | F1 |
| FR-103 | Messages support Markdown: bold, italics, lists, numbered lists, tables, links, inline code, code blocks, block quotes. Tables must degrade to stacked lists on narrow screens. | M | F2, Kevin |
| FR-104 | Messages carry attachments: images (gallery with +N overflow), files (card with name, size, download), link previews. | M | F5, F6, F7 |
| FR-105 | Long messages collapse with "Show more". | S | F8 |
| FR-106 | Date separators and per-message time stamps in the user's time zone. | M | F2 |
| FR-107 | Quote-reply: any message can be replied to; the reply shows the quoted line and "jump to" link. Agents can quote-reply too. | S | BR (F4) |
| FR-108 | Event rows (centered, small): routine created/updated/deleted (with open link), agent renamed, messaged X, message from X, N messages with X, messaged N agents (click shows the list). | M | F9 |
| FR-109 | Group thread: the header shows stacked avatars and a title (list of names, editable); each agent message shows a sender label; clicking a sender opens the agent's primary thread. | S | F17 |
| FR-110 | New chat flow: a "To:" field that searches agents, offers "Create '<name>' agent", and accepts several agents as chips before the first message. Keyboard focus must stay in the "To:" field until the user leaves it (see P9). | S | F17, P9 |
| FR-111 | Search across threads and messages. | S | F1 |
| FR-112 | Voice input (speech to text) in the mobile composer; on-device processing when supported, with any remote processing disclosed. | M | F21 |
| FR-113 | Live updates for subscribed sessions use Hermes events; target foreground event rendering within one second after receipt. Refresh roster/config/routines after relevant events and on foregrounding. Replay uses `session.events.since(last_seen)`; history refetch is required on truncation or epoch change. | M | discussion 2026-09-12 |

### 3.2 Choice cards and questions
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-120 | An agent can ask a question with a card: title, optional subtitle, options with letter, label and optional description, single or multi select, optional free-text field, dismiss (X). | M | F3 |
| FR-121 | Answering by tap, by typing letters ("A, C"), or by free text. Free text marks the card "Dismissed" and the text is the answer. | M | BR-14 |
| FR-122 | An answered card shows the chosen options greyed with a check; unanswered cards follow the backend waiting/expiry state. The app does not promise the agent can continue while a blocking clarify request is pending. | M | F3 |
| FR-123 | Cards are usable on a phone with one thumb (large tap targets, no hover). | M | C5 |

### 3.3 Agents
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-130 | Agent record = Hermes profile: profile id (directory name), friendly display name (`ui_meta['hermes-bots'].title`), avatar/color/hidden metadata, optional Ergates role badge, description, instructions (`SOUL.md`), provider/model/effort (`config.yaml`), capabilities, memories, routines, workspace and sessions. Mobile pins, sections and reading markers are device-local (05); preserve desktop organization metadata. Parent agent and creator are included in the creation briefing. | M | section 3 research |
| FR-131 | Create an agent from: chat instruction to the concierge (typed proposal, confirmation and journaled provisioning in 11); Home > New Agent; an uploaded skill package. Profile import is Phase 2. | M | BR-02 |
| FR-132 | An agent can propose changing its name, avatar or description; the user confirms through the typed action path in 11, and the chat records the result. | M | BR-10 |
| FR-133 | The Ergates concierge proposal capability can request creation, naming and description changes for specialists; the operator confirms. This is custom integration work, not a Hermes role. Pause and deletion are explicit user actions; deletion always needs confirmation. | M | BR-01, BR-09 |
| FR-134 | Agent details panel: live activity (current tool call, current job), routines list, settings (name, label, description, notifications, model, connectors, memories, workspace files). | M | F12 |
| FR-135 | Each agent has an isolated workspace: its profile working directory mounted in its own Docker sandbox. Upload paths and transfer into the owning sandbox are explicit and tested; a server path is not assumed to exist in the sandbox. The agent may read, write, and run scripts there. The user browses and downloads files only after the integration resolves the owning managed root and sandbox transfer. | M | BR-33 |
| FR-136 | Default concierge: the default profile seeded at onboarding; runs the onboarding interview (BR-13); has the custom proposal capability from 11. | M | BR-01 |
| FR-137 | Agent settings include: Provider (dropdown of providers signed in on the server, from `model.options`), Model (known models for that provider plus "Custom model..." free text), reasoning effort, and an Advanced section (approvals mode, terminal backend, max iterations). | M | Jop's screenshot 2026-09-12 |
| FR-138 | Changing an agent's provider or model keeps its identity, memory, files, routines, and connectors. Hermes stores the transcript independently of the provider; apply the switch between turns, verify tool/model compatibility and surface failures. Changing provider can reset its prompt cache; success is verified with a resumed turn. | M | C7 |
| FR-139 | Provider detection: the app reads Hermes `model.options` (providers with credentials, curated models, pricing) and offers only signed-in providers, with a Refresh action. Signing in to a provider happens on the server (`hermes model`) or through the dashboard OAuth routes; the app links there. | M | Buzz-like behavior |
| FR-13A | Every agent uses the Hermes core; acceptance checks cover each enabled provider path, including any alternative runtime, before claiming equivalent tool policy and approval behavior. | M | |
| FR-13B | Mobile Edit Bot provides all fields and save semantics in 10. Entry points: chat name > Edit Bot and roster action menu. Stage edits, support Cancel, handle partial saves/revision conflicts, and preserve profile identity/history when changing the display name. | M | Jop's mobile editing request |
| FR-13C | Roster actions and accessible alternatives follow 10: unread/read, pin/unpin, sections, hide/recover, Copy ID and confirmed Delete. Hidden agents continue running. Share as Template and Duplicate use reviewed, sanitized configuration in Phase 2. | M / S | IMG_3491–3492 |
| FR-13D | Home organization sections have a small grey name and expandable/collapsible chevron. Section membership persists independently of pin state: pinned members appear only in the pinned area, and unpinning returns them to their assigned section. Collapsing a section does not hide its pinned members. Preserve membership, pins and collapsed state across app restarts; full Prive example and edge cases in 10. | M | Jop, 2026-09-13; Prive screenshot |

### 3.4 Agent-to-agent collaboration
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-140 | Agents exchange messages through Hermes Bot Mode: `message_agent` delivers into the teammate's Bot Chat and triggers its turn; the reply arrives in the sender's Bot Chat as a background completion. | M | BR-03..05 |
| FR-141 | The exchange is visible in both agents' Bot Chats with sender attribution ("Message from <Bot>" rows). A separate read-only exchange overlay that merges both sides is Phase 2. | S | F10 |
| FR-142 | Broadcast: the concierge sends the same message to N agents one by one; the event rows show "Messaged <Bot>" per agent. A single "Messaged N agents" row is Phase 2. | S | BR-08 |
| FR-143 | Loop protection: Hermes caps rooms at 3 rounds and 10 messages per send; Bot Chat messaging is fire-and-forget, which is not a global hop or spend limit. The protocol discourages chaining; iteration limits and an operator Stop action remain necessary. Verify cross-agent loop behavior before unattended delegation. | M | safety |
| FR-144 | Creation briefing: the approved proposal carries creator, user, role, scope, seed facts, boundaries and standing instructions. Provisioning submits it after verifying the new profile; a receipt tracks confirmed or uncertain delivery (11). | M | BR-03 |
| FR-145 | Delegation template and lifecycle pings (start, waiting on user, done, blocked) are provided in the concierge's instructions; work is tracked on the Hermes kanban board (FR-160). | M | BR-04 |

### 3.5 Jobs and visibility (replaces "task tracker" pattern)
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-160 | Every unit of agent work is a Hermes kanban card: title "[Agent] verb + object", goal, status, assignee profile, comments, attachments. Agents create and update cards with the `kanban_*` tools; the `kanban` toolset is enabled on every agent. | M | Linh 28-29 |
| FR-161 | The user sees a board view (columns by status) and a per-agent list in the app over the Hermes kanban API; optional mirror to ClickUp through a connector. | S | BR-05 |
| FR-162 | Agents also log their own work (the concierge included). | M | BR-05, P8 |

### 3.6 Routines and timers
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-170 | Routine record = Hermes cron job named `[bot:<agent>] <name>`: prompt, schedule (one-shot or recurring; natural language or cron expression), paused flag, delivery target (origin chat, ntfy), skills, model pin, run history. Webhook triggers are Hermes's webhook platform (Phase 2). | M | F11 |
| FR-171 | Agents create reminders through the integration path in 11 and use Hermes cron operations for updates and lifecycle. Event rows refresh after `cron.changed`; creation is not declared complete before its receipt is confirmed. | M | BR-21, BR-22 |
| FR-172 | One-shot routines run once; the app hides finished one-shots. Whether Hermes removes them is to verify per version. | M | BR-22 |
| FR-173 | A routine run starts an agent turn with the prompt; the output lands in the agent's Bot Chat history and is delivered to the push channel. | M | BR-22 |
| FR-174 | Ordinary reminders use the verified default 60-second scheduler tick. Target 99% job starts within 90 seconds on a healthy idle server; measure push separately (11 section 4.3). Sub-minute timers and guaranteed five-second delivery are deferred. | M | BR-23, P1 |
| FR-175 | Duplicate-free reminder creation requires the integration idempotency/serialization path in 11 section 4.3 for both app and agent calls. List-before-create alone is insufficient. This is a release gate, not a verified property of raw `cronjob create`. | M | P2 |
| FR-176 | Routine editor in the details panel: name, instruction, trigger picker, active toggle, test run, run history. | M | F11 |

### 3.7 Connectors and tools
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-180 | Connector catalog: the Hermes MCP catalog (`/api/mcp/catalog`) plus manual add by URL or command; each entry shows name, description, transport (stdio or remote), auth type, and contributed tools. | M | F14 |
| FR-181 | Connector accounts: connect through Hermes MCP OAuth (browser or device-code flow) or a token in the profile's `.env`; show Connected state from `/api/mcp/servers/{name}/test`; reconnect on expiry. | M | F15 |
| FR-182 | Per-tool switches at connector level: the MCP server's contributed-tool include/exclude list. | M | F15, BR-25 |
| FR-183 | Per-agent connector assignment: MCP servers are configured per profile, so each agent has its own list. The profile's own MCP server list on the owner's server is the "connector default"; the app copies it narrower, never wider. | M | P5 |
| FR-184 | Enforcement: tools outside the active session's effective grant are rejected. Saving profile config does not revoke a running session: stop/rebuild affected sessions and verify the grant before showing Off (04 section 5). Test direct, delegated and alternative execution paths. | M | BR-29 |
| FR-185 | The user can inspect connector/auth state in details (M). Agent-initiated connect cards require a typed integration proposal in Phase 2 (S); do not interpret ordinary text or tool output as a privileged connection action. | M / S | BR-26, BR-27 |
| FR-186 | Adding a remote MCP server by URL is a user action (or agent proposal with user confirmation). | S | BR-26 |
| FR-187 | "Private skills": skills created by agents are stored in the catalog and can be assigned to other agents. | S | F14 |

### 3.8 Safety and approvals
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-190 | Approval cards: when Hermes needs approval (an `approval` server request), the agent's turn pauses and a card appears with the command or tool, and the choices Allow once, Allow this chat, Always, Deny; the server attention bridge sends a push when that integration passes the locked-phone gate in 11. Deny returns a clear result to the agent. The wait is `approvals.timeout` per profile. | M | BR-28, P4 |
| FR-191 | Approval rules: Hermes `smart` and `manual` apply to eligible dangerous shell commands; exemptions and persisted allows still matter. `manual` is not an approval gate for every MCP action. The Always choice remembers an approval pattern. Plain-language custom rules are not a Hermes feature. | C | F20 |
| FR-192 | Hard limits are verified for the deployed paths: excluded session tools, shell in the owning Docker sandbox, restricted mounts and air-gapped shell by default. Limits on the server's outbound traffic are the server owner's to set (ADR-046). Host-side MCP/memory/plugin tools are separate trusted processes (04); Docker does not sandbox every Hermes tool. | M | BR-29 |
| FR-193 | The user can pause an agent: pause its active cron jobs and interrupt its running sessions. Record which jobs this action paused; resume restores only those, preserving jobs already paused. Hermes has no profile-level pause flag; this is separate from Hide. | S | ops |
| FR-194 | Sending email, payments, and deletions are excluded from the contributed tools by default and must be added by hand; conditional shell approval behavior is documented in 04; actions needing business approval require a tool-specific gate even after the tool is enabled. | M | BR-30, BR-31 |

### 3.9 Files
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-200 | Upload from composer (+ button): images, documents, zip; limits follow each endpoint (25 MiB for REST image upload); validate before transfer. Byte RPC and document limits are recorded from the pinned backend, not a universal 50 MB default. | M | F5 |
| FR-201 | Uploads use the managed-file policy and explicit target path; transfer/mount visibility in the owning sandbox is verified before sending the prompt. | M | BR-32 |
| FR-202 | Images use `image.attach_bytes` from the phone or JSON image upload followed by `image.attach(path)` so the model sees them; the app converts HEIC to JPEG before upload. | M | BR-32 |
| FR-203 | The app indexes supported output references as file cards, resolving server/sandbox paths before managed download. It does not assume every file write generates an artifact event. | M | F6 |
| FR-204 | Nothing received is deleted by the app: files stay in the profile workspace and messages in the Hermes session database; agents find past content with Hermes session search. | S | discussion 2026-09-12 |

### 3.10 Memory
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-210 | Memory per agent: Hermes `MEMORY.md` (agent notes) and `USER.md` (user profile), written by the agent with the `memory` tool; the user views them in the details panel and edits them on the server. | M | BR-34, BR-35 |
| FR-211 | Memory files are injected into the agent's system prompt at session start. | M | |
| FR-212 | Hermes compresses long conversations. If compression or the provider limit fails, show the error and a recovery action; do not promise infallible context handling. | M | Hermes context compression |
| FR-213 | An agent's memory is shared across all its sessions and rooms (it is per profile). | M | BR-40 |
| FR-214 | The agent's brain is Hermes's: memory files plus session search; an external memory provider (Honcho) can be enabled per profile later. | M | discussion 2026-09-12 |
| FR-215 | Open loops: unfinished work is a kanban card in the Blocked column with a note saying what it waits on. | S | Linh Outlook example |
| FR-216 | Retrieval: memory files are injected whole (bounded size); the agent searches past sessions on demand with session search. No vector index of our own. | M | |
| FR-217 | Automatic memory capture: Hermes nudges the agent to persist knowledge; Honcho adds automatic user modeling if enabled. | S | |
| FR-218 | Capability change wake-up: a per-agent routine (cron, daily) asks the agent to review its Blocked cards against its current tools and ask the user once before acting. Not an event in Hermes. | C | Linh Outlook example |
| FR-219 | Turn-start briefing: background completions and teammate messages arrive as messages in the Bot Chat; new files are listed by the app in the composer's attachment note. | C | |

### 3.11 Templates and catalog
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-220 | Export an agent with Hermes profile export (`POST /api/profiles/{name}/export`); the app shows what the archive contains (config, `SOUL.md`, skills, memory) and lets the user exclude memory before export. | S | BR-36 |
| FR-221 | Import a profile archive (`POST /api/profiles/import`) or clone an existing profile; the new agent is briefed by the concierge. | S | BR-37 |
| FR-222 | Skill package format: agentskills.io (`SKILL.md` with name and description, optional references and scripts), which Hermes loads per profile. Compatible with Claude Code skills. | M | BR-38 |
| FR-223 | Catalog is a secondary destination with Connectors, Skills and Templates sections over their supported Hermes surfaces. | S | F14, F16 |

### 3.12 Notifications and mobile
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-230 | Push notifications for: new agent message when the chat is not open, approval needed, routine fired, teammate message. Phase 1 through ntfy (Hermes ntfy platform, ntfy app on the phone, deep links); Phase 2 through the app's own Expo push plugin. Per-agent subscription/toggle state must reach the server attention bridge; device-local preferences alone cannot suppress server ntfy publication. | M | F12 |
| FR-231 | Optional Telegram channel through the Hermes gateway: the same agents reachable from Telegram. | S | A5 |
| FR-232 | The client is a React Native app (Expo) for iOS and Android, distributed as development builds first; store distribution optional. | M | F22, Jop 2026-09-12 |

### 3.13 Usage and settings
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-240 | Usage view: tokens and estimated cost per agent from `session.usage` and Hermes analytics; a configurable monthly warning threshold. | S | P7 |
| FR-241 | Settings: gateways (connection registry), theme, language, notifications, per-agent provider and model, tools and connectors, link to the Hermes dashboard for server-side settings, version of app and backend. | M | F20 |
| FR-242 | Auth: Hermes auth gate. The app grades the server address before it signs in (ADR-045). A private address (this device, Tailscale, the local network) accepts the session token or a username and password. A public address, and a `*.ts.net` name, is accepted only over `https` in password mode, with a password of at least 12 characters. The app refuses an unsafe address: a public address over plain `http`, which it refuses before any request, and a public address that signs in without a password. Phase 3: OAuth or OIDC with native PKCE sign-in. | M | |

### 3.14 Mobile design
| ID | Requirement | Pri | BR |
|---|---|---|---|
| FR-250 | Home, Chat, Search, creation menu and grouped settings follow the supplied iPhone layouts in 10-mobile-design.md. | M | Jop mobile screenshots |
| FR-251 | Use Hermes semantic themes, Nous default, System/Light/Dark appearance, and valid backend skin events. No independently invented palette. | M | Jop, 2026-09-12 |
| FR-252 | Tool details, model controls, usage and the board are secondary destinations; default Home and Chat stay visually quiet. | M | mobile references |

## 4. Agent behavior specification (prompts and protocols)

These become the default instruction files of the concierge and of every specialist.

### 4.1 Shared rules for all agents
1. Mirror the user's language per message (Dutch or English). (BR-12)
2. Keep replies short. On mobile, prefer stacked lists over tables. (BR-15)
3. When work takes longer than a few seconds, post one interim status line, then the result. (BR-17)
4. Attach evidence for external actions (screenshots, links, file names). (BR-19)
5. Say plainly when something failed or was blocked and what you will do next. (BR-20)
6. Never invent facts; ask when unknown. (Nico brief)
7. Persist new rules and preferences the user states, and confirm in one line what was stored. (BR-15, BR-34)
8. Log every job you start, wait on, finish, or block on the kanban board. (FR-160)
9. If something matters later, save it now: the `memory` tool for facts and rules, a Blocked kanban card for unfinished work with what it waits on. (FR-214, FR-215)
10. When a tool you were waiting for becomes available, ask the user once before acting. (FR-218)

### 4.2 Concierge protocol
- Onboarding interview with choice cards, one question at a time. (BR-13)
- Create specialists on request; give each a person name and a role title; send the creation briefing (FR-144). (BR-02, BR-03)
- Delegate with the template: task, boundaries, numbered report format, "ping me when you start, when you wait on the user, when you are done". (BR-04)
- Relay a short natural-language version of reports to the user; board links only on request. (BR-06)
- Keep the board: own jobs too. (BR-05, P8)
- Ask for a go/no-go before building anything or spending money. (BR-30)

### 4.3 Specialist protocol
- Lock scope from the briefing; refuse scope creep politely. (Thijs)
- Report to the concierge only, unless the user talks to you directly. (BR-05)
- Verify briefings against primary sources when they matter; send corrections to the parent. (BR-07)
- Use only your assigned connectors; if a tool is missing, say so and ask. (BR-27)

## 5. UI specification

The authoritative mobile layout, token mapping, states and accessibility checks are in [10-mobile-design.md](10-mobile-design.md). Research records observations; 10 specifies what Ergates builds.

| Screen | Content | Phase |
|---|---|---|
| Home | Account avatar, Search, Add, pinned agents, flat conversation rows under small grey collapsible section headings; pins retain section membership | 1 |
| Chat | Back, agent name/details, bubbles, compact event/working rows, Attach, composer, Mic/Send | 0–1 |
| Search | Focused input and roster results; conversation-content search later | 1; content search 2 |
| Agent details | Edit Bot, routines, tools/connectors, memory, files, actions overflow | 1 |
| Edit Bot | Avatar/name/role/description; instructions, provider/model and capabilities on focused subpages; Save/Cancel and partial-save recovery | 1 |
| Bot action menu | Edit, unread/read, pin, sections, hide; More contains Copy ID/Delete; template/duplicate later | 1; template/duplicate 2 |
| Settings sheet | Gateway/account, implemented usage, appearance/theme, language, haptics, notifications, About, sign-out | 1 |
| Routine editor | Prompt, timezone and next run, active toggle, test, history | 1 |
| Approval / proposal | Inline request, brief description, explicit actions, pending/expired/failed state | 0–1 |
| Rooms, exchange overlay, board, templates | Secondary destinations, no permanent dashboard chrome | 2 |

Offline composer text remains a draft or an explicitly queued-unsent message. Only a message known never to have been submitted may auto-send on reconnect. Delivery-unconfirmed messages need reconciliation and deliberate retry (05).

## 6. Non-functional requirements
| ID | Requirement |
|---|---|
| NFR-01 | Measure time to first token by provider and network. Target under 3 seconds for a warm ordinary turn; show waiting state when slower. |
| NFR-02 | Ordinary reminder timing target and delivery measurements are defined in 11 section 4.3; precise short timers are deferred. |
| NFR-03 | VPS owns authoritative agent data; encrypted off-host backups. Device drafts and opt-in caches follow explicit retention and clearing rules in 05. |
| NFR-04 | Hermes session logs supply operational history. Verify coverage of tool calls, approvals and teammate messages; do not claim immutable auditing or argument hashes without additional implementation. |
| NFR-05 | Distinguish unsent, acknowledged and uncertain messages. Recover history after crash; uncertain submissions are never automatically retried. Show interrupted work and require deliberate recovery. |
| NFR-06 | Upgrades with zero data loss and a documented rollback. |
| NFR-07 | Accessibility: keyboard navigation and screen-reader labels on all controls. |
| NFR-08 | The system must keep working when the model provider is rate limited: turns queue and the user is told. |
