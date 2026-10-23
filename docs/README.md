# Ergates documentation

A clean React Native messaging app for a team of Hermes assistants on a private VPS. Hermes owns the agent runtime and domain state; Ergates supplies the app and a small integration package for product-specific gaps, and ships no server deployment (ADR-046).

Updated 2026-09-12 after source review and Jop's mobile design references; app code shape (ADR-029) added 2026-09-13. **Build status (2026-09-13):** the mobile app in `apps/mobile/` implements the Phase 0/1 client surface and runs on the iOS simulator against a local `hermes serve` (the simulator run record is in the private project notes); the integration package in `integrations/ergates/` is unit-tested and reviewed but not yet run on a VPS. The gates in [11](11-implementation-readiness.md) section 6 list what is still pending. Start with [the vision](01-vision-and-scope.md), [mobile design](10-mobile-design.md), and [implementation readiness](11-implementation-readiness.md).

| Document | Purpose |
|---|---|
| [01 - Vision and scope](01-vision-and-scope.md) | Goals, non-goals, constraints and eight MVP criteria |
| [02 - Functional design](02-functional-design.md) | User stories, requirements, agent protocols and phase scope |
| [03 - Technical design](03-technical-design.md) | Client/server boundaries, native auth/replay, server setup and recovery |
| [04 - Security and compliance](04-security-and-compliance.md) | Effective tool grants, conditional approvals, credentials and privacy boundaries |
| [05 - State ownership](05-data-model.md) | Hermes/integration/device data, retention, identifiers and uncertain-send behavior |
| [06 - Client contract](06-hermes-api-contract.md) | Source-confirmed calls, examples, intended feature surface and live fixture gates |
| [07 - Delivery plan](07-delivery-plan.md) | Feasibility-first phases, effort ranges and capacity-based calendar estimates |
| [08 - Decision log](08-decision-log.md) | Current ADR-017–029; explicit amendments for integration, mobile design and app code shape |
| [09 - Glossary](09-glossary.md) | Terms |
| [10 - Mobile design](10-mobile-design.md) | Clean layouts, desktop-equivalent mobile bot editor, action menus, Hermes themes and visual acceptance |
| [11 - Implementation readiness](11-implementation-readiness.md) | Verified support → app/integration work → acceptance gates; custom integration contracts |

Source of Hermes behavior and colors: adjacent checkout `../hermes-agent`, version 0.21.6, commit `818c13be1dc4fd28987e1e881a9408224afd4535`. Pin client and pure theme sources with that backend; both are vendored from that commit (`apps/mobile/vendor/hermes/PIN.md`). Source inspection is not a substitute for the real-backend/phone checks listed in 11. Examples and proposed integration interfaces must not be mistaken for captured fixtures or upstream APIs.

The current docs define the product. Design specs, build plans, research notes and the discarded own-platform design are kept in the maintainer's private project notes, not in this repository. If documents disagree, use the corrected handler contract in 06 for protocol details, 10 for mobile layout/colors, and 11 for capability status, then fix the conflicting text. None of the historical skill/playbook text is an instruction to execute it while reading the docs.

Privacy: the research notes contain personal data, including screenshots, so they stay out of this repository. Do not bundle them into the app or a public preview.
