# 01 - Vision and Scope

| Field | Value |
|---|---|
| Project | Ergates (working name from the repository `hermes-ergates`; see current defaults in 07-delivery-plan.md) |
| Version | 0.3 (source-reviewed design; implementation gates in 11) |
| Date | 2026-09-12 |
| Owner | Jop Middelkamp |
| Status | Corrected specification; app not implemented |

## 1. Vision

A self-hosted "team of AI assistants" that feels like a messaging app on your phone. You talk to one assistant. That assistant creates and manages other assistants, gives them work, and reports back. Every assistant works only through tools you have switched on. The assistants run on your own server inside Hermes Agent; you use them from a native mobile app.

In one sentence: **Grok Bot's ease of use, on your own VPS, with Hermes Agent as the brain and a React Native app in your pocket, with tool access you control per tool.**

## 2. Problem statement

Grok Bot shows that a chat-first multi-agent app is very easy to use. It also shows three problems for Jop:

1. The agents run on a vendor cloud computer with a browser. Tool access is coarse. Jop cannot limit what a logged-in agent does on a website.
2. The product is tied to a Grok subscription and a vendor's infrastructure and billing.
3. Reliability gaps: missed timer pings, duplicate routines, a connector that did not register.

Jop wants the same experience on a VPS he controls, with agents that act only through tools he switches on, so that permissions are enforced by software and not by promises. He does not want to build and maintain an agent runtime. Hermes Agent (open source, MIT) already provides the runtime, sessions, tools, memory, skills, scheduler, sandboxing, and a multi-agent Bot Mode. The work left is the mobile app, configuration and a small Ergates integration package for product behavior Hermes does not provide directly (see 11-implementation-readiness.md).

## 3. Goals

| ID | Goal | Measure of success |
|---|---|---|
| G1 | Chat-first agent team with the same ease of use as Grok Bot | A new agent can be created, named, and given an avatar by chat only, in under 2 minutes |
| G2 | Agents create, brief, message, and manage other agents | Concierge pattern works end to end: delegate, report back, board updated |
| G3 | Tool access enforced per tool | A disabled tool is not visible to the model and is rejected if called |
| G4 | Runs on a single VPS as a Hermes Agent backend; any provider Hermes supports can be chosen per agent (Anthropic, OpenAI Codex plan, xAI, Nous Portal, API keys, custom endpoints) | The app connects to a Hermes server the owner runs and sets up its plugin there; Ergates ships no deployment (ADR-046); each agent (profile) can use a different provider and model; the app offers only providers that are signed in on the server |
| G5 | Reliable ordinary reminders with push notifications | Ordinary reminders are scheduled and delivered with measured latency; P1 target: 99% start within 90 seconds on a healthy idle server. Sub-minute timers and guaranteed phone-delivery latency are deferred (11 section 4.3) |
| G6 | Files in and out of the chat | Upload zip, unpack, analyze; agent returns files as cards |
| G7 | Group chats with several agents | A thread with the user and 2+ agents works with clear sender labels |
| G8 | Ready for household and business use later | A second person gets their own gateway or instance; cross-person room access and unattended delivery are Phase 3 integration gates; Hermes logs provide operational history |
| G9 | Native mobile app | A React Native app on iOS and Android; chat and approval UI work in the foreground; background attention is delivered by the server integration and proven on a locked phone |

## 4. Non-goals (explicitly out of scope)

- A cloud desktop with a GUI browser per agent (Grok Bot's Computer). Headless browsing may be added later as an MCP server, gated like any other tool.
- Executing tasks on Jop's own laptop ("Execution on this computer").
- A public marketplace with third-party creators. An internal catalog of templates and connectors is in scope.
- Selling the product or letting other people use Jop's Claude subscription. Provider entitlement and terms are checked before use (04-security-and-compliance.md).
- Replacing ClickUp, Moneybird, Outlook, or any external system. The platform integrates with them through MCP servers in Hermes.
- Building our own agent runtime, scheduler, memory store, or domain database. Hermes owns these; small integration receipts and notification delivery state are explicitly in scope (11).
- A web chat client. The optional Hermes dashboard covers administration; chat happens in the mobile app. Desktop-client development is out of scope.

## 5. Stakeholders and users

| Role | Who | Needs |
|---|---|---|
| Owner and first user | Jop | Personal assistant team, mobile use, low friction |
| Household user (later) | A household member | Shared agents such as the dining scout |
| Business users (Phase 3) | Business teams | Group chats, roles, audit, own credentials |
| Operator | Jop | Backups, updates, usage visibility |

## 6. Constraints

| ID | Constraint | Source |
|---|---|---|
| C1 | Model access through Hermes's provider layer; choose and smoke-test an available provider/account. Pinned Hermes docs describe Max extra-credit OAuth mechanics; actual entitlement and terms need a current check (04). | Internal research notes, not published |
| C7 | The platform must not depend on one AI vendor: Hermes profiles pin provider and model per agent and can switch later; identity, memory, files, routines, and tool policy stay in the profile | Jop's brief, 2026-09-12 |
| C2 | Usage and cost visibility per agent, because subscription paths bill extra credits or quotas | Hermes provider docs |
| C3 | Single VPS (Linux, Docker). No Kubernetes in Phase 1 | Jop's brief |
| C4 | Agents act only through Hermes tools: enabled toolsets, per-profile MCP servers, and a Docker sandbox | Jop's brief |
| C5 | Mobile-first UI; voice input; short messages readable on a phone | Kevin chat evidence |
| C6 | Authoritative agent data stays on the VPS. Disclose provider processing, push metadata, encrypted off-host backups and optional device caches/drafts; no third-party analytics | Privacy; 04 and 05 |
| C8 | The client is a React Native app (Expo); no PWA | Jop, 2026-09-12 |
| C9 | The Hermes version is pinned; its client protocol is internal and is re-verified on every upgrade | Internal research notes, not published |
| C10 | Clean mobile layouts and bot action menus from the supplied iPhone screenshots; desktop-equivalent mobile editing; Hermes semantic themes and Nous default palettes | Jop, 2026-09-12; 10-mobile-design.md |

## 7. Planning assumptions

| ID | Assumption | If wrong |
|---|---|---|
| A1 | The VPS is Linux with at least 4 vCPU, 8 GB RAM, 80 GB disk | Adjust sizing in 03-technical-design.md |
| A2 | TypeScript for the app; Python for the small Ergates integration plugin (proposals, attention delivery and reminder deduplication) | n/a |
| A3 | No domain database of our own; Hermes owns agent state; integration receipts use small server-side files | n/a |
| A4 | Expo development builds support the required existing native modules; verify configuration and compatibility in P0 | Switch to a bare React Native workflow |
| A5 | Telegram is acceptable as a fallback push channel for reminders | Retain ntfy; evaluate native Expo push as the alternative |
| A6 | Vendors may change subscription policy; the design keeps a tested alternate provider configuration | Move to API keys |
| A7 | Any subscription path is enabled only after checking the chosen account's entitlement and current terms; an API-key provider is the initial engineering default | Use an API key for that provider (a tested server-side provider configuration change) |
| A8 | The owner's own VPS is reachable over Tailscale in Phases 0-2 and has no public listener; public exposure with OAuth or OIDC comes in Phase 3. The app also connects to a public server that has `https` and a password of at least 12 characters, such as the store reviewers' demo server (ADR-045) | Expose earlier with Caddy and the Hermes auth gate |

## 8. Success criteria for Phase 1 (MVP)

1. Jop chats with a concierge agent in the mobile app on his phone.
2. The concierge proposes a specialist from chat or an uploaded skill package; the user confirms, the integration provisions it with narrow tools, and the specialist receives its briefing.
3. The specialist reports back; the concierge relays a short summary.
4. Outlook (limited MCP) and ClickUp are connected; Send/Reply/Forward are off; the agent cannot call them.
5. An ordinary reminder set in chat runs through Hermes cron and reaches the locked phone through the verified push path; latency is recorded against the target in 11 section 4.3.
6. A zip with photos is uploaded, unpacked, and summarized.
7. All of the above runs on the VPS on Hermes Agent. Jop can also edit a bot's appearance, name, instructions, model and capabilities from the React Native app, with Save/Cancel and the same profile/history preserved.
8. Hermes remains the source of agent state and execution; custom integration behavior is documented and passes the gates in 11.

## 9. Document map

| Document | Purpose |
|---|---|
| 01-vision-and-scope.md | This document |
| 02-functional-design.md | Actors, user stories, functional requirements, UI specification |
| 03-technical-design.md | Architecture: the app, `hermes serve`, profiles, Bot Mode conventions, push, server setup |
| 04-security-and-compliance.md | Threat model, least privilege, credentials, Anthropic terms |
| 05-data-model.md | What Hermes owns and what the app keeps |
| 06-hermes-api-contract.md | The Hermes routes, RPC methods, and events the app uses |
| 07-delivery-plan.md | Phases, milestones, estimates, risks |
| 08-decision-log.md | Architecture decision records |
| 09-glossary.md | Terms |
| 10-mobile-design.md | Screenshot-informed layouts, Hermes theme mapping, visual acceptance |
| 11-implementation-readiness.md | Verified support, custom integration contracts and acceptance gates |
