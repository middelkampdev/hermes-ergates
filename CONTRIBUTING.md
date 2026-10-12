# Contributing to Ergates

Thanks for wanting to contribute. This is a small, single-maintainer project; keeping the process light keeps it sustainable.

## Branches

This repository uses the maintainer's `gflow` CLI and its gitflow model: `develop` is the integration branch, `master` only changes through releases and hotfixes, and every landing happens through a pull request with green CI.

- Work branches start from `develop`.
- Pull requests target `develop`, not `master`.
- If you don't use gflow yourself, that's fine: branch from `develop`, make your change, and open a pull request into `develop`.

## Setup, and running the checks

`scripts/ci-local.sh` runs the same jobs CI runs (`.github/workflows/ci.yml` calls this script for every job), so you can reproduce a CI failure locally.

```bash
scripts/ci-local.sh              # every job, in order
scripts/ci-local.sh mobile lint  # only these jobs
```

Tools needed, by job:

| Job | Command(s) | Needs |
|---|---|---|
| `lint` | `bash -n` on the shell scripts, then `uvx --from shellcheck-py==0.11.0.1 shellcheck` on them, then `uvx --from actionlint-py==1.7.12.25 actionlint` on the workflow files | `bash`, [`uv`](https://docs.astral.sh/uv/) (for `uvx`) |
| `mobile` | `npm ci` (fresh installs, or when `node_modules` is missing), then `npm run typecheck`, `npm run lint`, `npm run test:coverage`, `npm run depcruise` | Node 26, npm |
| `integration` | `uv run --locked --python 3.11 pytest --cov --cov-fail-under=90` (run from `integrations/ergates-tests`) | `uv`, Python 3.11 |
| `contract` | Prepares a pinned Hermes checkout (`HERMES_SOURCE`, or a local/fetched checkout at the pin), then `pytest contract` and `pytest contract/live` through the same `uv run` invocation as `integration` (run from `integrations/ergates-tests`) | `uv`, Python 3.11, `git`, network access (the first live hot-mount install of a run prepares Hermes's own dependency runtime, about 560 MB, in a temporary folder, and takes about a minute; later installs reuse its downloads) |
| `contract-live` | Only the `pytest contract/live` half of `contract`, after the same checkout preparation; it runs only when named | Same as `contract` |
| `deploy` | `docker compose -f deploy/docker-compose.yml --env-file deploy/.env.example config --quiet`, then `uv run --no-project --python 3.11 --with pytest --with pyyaml pytest -p no:cacheprovider deploy/tests` | Docker (with Compose), `uv`, Python 3.11 |

The workflow `.github/workflows/contract-latest.yml` runs `scripts/ci-local.sh contract-live`, the live half of the `contract` job (`pytest contract/live`), against the newest stable Hermes release. That half includes the install scan of the plugin folder, so the weekly run also checks the newest release's verdict. The text half pins exact Hermes line numbers, which move in nearly every release, so it runs against the pin only. The workflow runs weekly and on manual dispatch, never on a pull request. It sets `HERMES_SOURCE` to a checkout of that release and `HERMES_EXPECTED_REF` to the release commit, and the live tests then expect that commit instead of the pin. To run it by hand, check out a release tag in a clean Hermes clone and run `scripts/ci-local.sh contract-live` with both variables set.

The quick loops from the README, for iterating on one part:

- `cd apps/mobile && npm test && npm run typecheck`
- `cd integrations/ergates-tests && uv run --locked --python 3.11 pytest`

## Tests

Behavior changes need tests. Both the mobile app (Vitest, `apps/mobile/vitest.config.mts`) and the integration package (`pytest --cov-fail-under=90`) enforce coverage gates in CI — a change that drops coverage below the gate fails the build.

The integration package's tests are a separate project, `integrations/ergates-tests`, so the folder users install (`integrations/ergates`) holds only runtime code. Put new tests and fixtures there. The `contract` job runs Hermes's install scan on the files git tracks in `integrations/ergates` and fails unless the verdict is `safe`.

## Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for example `fix(mobile): keep the outbox stall per connection` or `docs: plan the store release pipeline`. Check `git log` for the types and scopes already in use before picking your own.

## Code comments

Write comments and test titles in plain language that explains the *why*, not a planning, task, or code-review id — a reader has no upgrade plan or review ledger at hand, so a number like "Ruling 4" or "C3" tells them nothing. (ADR numbers, docs section numbers, Hermes `file:line` references, and upstream issue numbers are fine — they point at something a reader can open.)

This is enforced by a guard test on each side: `apps/mobile/test/plain-comments.test.ts` on the mobile app, and `integrations/ergates-tests/tests/test_plain_docs.py` on the integration package and its tests.

## Releases

Releases are cut by the maintainer only, through gflow and the GitHub Actions release workflow. See [`apps/mobile/RELEASING.md`](apps/mobile/RELEASING.md) for how a release runs end to end.

## License

By contributing, you agree that your contribution is licensed under this repository's [MIT license](LICENSE). There's no CLA and no DCO sign-off to complete — contributions come in under the repository's license terms (GitHub's inbound = outbound).

## Conduct and security

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, per the [security policy](SECURITY.md) — never in a public issue or pull request.
