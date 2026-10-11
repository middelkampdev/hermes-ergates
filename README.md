# Ergates

[![CI](https://github.com/middelkampdev/hermes-ergates/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/middelkampdev/hermes-ergates/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A clean React Native messaging app for a team of Hermes Agent assistants on your own server. Hermes owns the agents; Ergates is the phone app, a small server integration package and the deployment configuration.

| Part | Path | Status |
|---|---|---|
| Mobile app (Expo SDK 57) | [apps/mobile](apps/mobile/README.md) | Runs on the iOS simulator against a local `hermes serve`; see the app README |
| Integration package (Hermes plugin, Python) | [integrations/ergates](integrations/ergates/README.md) | Unit-tested and run against the pinned Hermes in the contract tests; not yet installed on a live gateway |
| Deployment (Compose, profile and role templates, runbook) | [deploy](deploy/README.md) | Checked by CI; not yet run on a VPS; the live checks are [deploy/VERIFY.md](deploy/VERIFY.md) |
| Design documents | [docs](docs/README.md) | Authoritative specification for vision, architecture, security, data model, API contract and mobile design |

## Quick start (simulator)

```bash
# 1. backend, loopback token mode
export HERMES_DASHBOARD_SESSION_TOKEN="$(openssl rand -hex 16)"; echo "$HERMES_DASHBOARD_SESSION_TOKEN"
hermes serve --host 127.0.0.1 --port 9119 --skip-build

# 2. app
cd apps/mobile && npm install && npx expo run:ios
```

Connect in the app with `http://127.0.0.1:9119` and the token.

The app's proposal, reminder and notification screens need the Ergates
plugin in that Hermes (`integrations/ergates/README.md`, "Install"): link
`integrations/ergates` to `~/.hermes/plugins/ergates`, then, from the
repository root and with the Python your Hermes runs on, run
`PYTHONPATH=integrations/ergates python -m ergates.install --templates deploy/templates`
and restart `hermes serve` so it loads the plugin's hooks and tools. On
Hermes v0.21.6 the routes alone would mount on their first request without a
restart. The installer edits `~/.hermes/config.yaml` and the `config.yaml` of
every profile.

## Verification

`scripts/ci-local.sh` runs the CI jobs locally; `.github/workflows/ci.yml` runs the same script on GitHub Actions.

| Job | What it checks |
|---|---|
| `lint` | the workflow files (actionlint) and the runner script |
| `mobile` | `npm run typecheck`, ESLint (`npm run lint`, no warnings allowed), Vitest with the coverage gate (including a guard against planning ids in comments and test titles), the ADR-029 dependency rules |
| `integration` | the Python suite with a 90% branch-coverage gate, including the Hermes boundary guard and a guard against planning ids in comments, docstrings, test names and docs |
| `contract` | facts about the pinned Hermes source the integration relies on, and the integration running inside the pinned Hermes (its adapter, routes, tool gate and installer) |
| `deploy` | `docker compose config` and static checks of `deploy/`: published ports, the internal network and the egress proxy, image digests, mounts, profiles, templates and the live checklist |

Run one job with `scripts/ci-local.sh mobile`, several with `scripts/ci-local.sh integration contract`. The quick loops:

- `cd apps/mobile && npm test && npm run typecheck`
- `cd integrations/ergates && uv run --python 3.11 --with pytest --with pytest-cov --with pyyaml pytest`
- Live backend smoke: `ERGATES_LIVE=1 ERGATES_TOKEN=… npx vitest run test/live` (from `apps/mobile`)

Hermes pin: `818c13be1dc4fd28987e1e881a9408224afd4535` (v0.21.6). The vendored gateway client and theme sources come from that commit (`apps/mobile/vendor/hermes/PIN.md`). Re-verify the vendored client against [06 - Client contract](docs/06-hermes-api-contract.md) on every upgrade; `scripts/ci-local.sh contract` checks the pinned integration automatically.

A weekly CI job, `contract-latest`, runs the same contract tests against the newest stable Hermes release, so a break shows up before the pin moves. It also runs on manual dispatch and never on a pull request.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for branches, setup, and the checks a change needs to pass. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md), and security issues should be reported privately, per the [security policy](SECURITY.md).

## Releases

Releases go to TestFlight and the Google Play internal testing track through gflow and GitHub Actions; see [`apps/mobile/RELEASING.md`](apps/mobile/RELEASING.md) for how a release runs.

## License

Ergates is licensed under the [MIT License](LICENSE), copyright Middelkamp Development. `apps/mobile/LICENSE` is a separate notice that covers the Expo template code the mobile app started from and stays with that code.
