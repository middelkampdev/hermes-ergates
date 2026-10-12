# Ergates deployment (single VPS)

## Status: checked by CI, not yet run on a VPS

`scripts/ci-local.sh deploy` (the CI `deploy` job) runs
`docker compose config` on `docker-compose.yml` and
`tests/test_static.py`, which checks the wiring contract of
`docs/03-technical-design.md` section 9 as rules: published ports, networks
and the egress proxy, image digests, the plugin mount, profile
settings, templates. **It has not been run on a VPS.** `VERIFY.md` is the
list of live checks that must pass before this stack holds real data; it
is not a footnote.

## Layout

```
deploy/
  docker-compose.yml               # hermes-serve, hermes-gateway, ntfy, egress-proxy, ingress
                                   #  + read-only mount of ../integrations/ergates
                                   #    at /opt/data/plugins/ergates in both controllers;
                                   #    its templates/ folder holds the reviewed role templates
  proxy/squid.conf                 # egress: settings shared by both modes, includes the mode file
  proxy/mode-standard.conf         # egress mode "standard" (default): any public host, no private ranges
  proxy/mode-strict.conf           # egress mode "strict": HTTPS to listed hosts only (today's original)
  proxy/allowed-domains.txt        # strict-mode hosts; ntfy.sh active, one commented block per provider
  ingress/haproxy.cfg              # the two published ports, forwarded as TCP
  .env.example                     # copy to .env, fill in real values, never commit .env
  profiles/
    concierge/{config.yaml,SOUL.md}            # default/launch profile
    specialist-template/{config.yaml,SOUL.md}  # copy per specialist during provisioning
  tests/test_static.py             # the wiring rules below, checked in CI
  README.md                        # this file
```

## Install

Prerequisites on the VPS: Docker Engine 28.0 or later with Docker Compose
v2, and Tailscale already installed and connected (`tailscale ip -4` must
return an address). Engine 28.0 added the isolated gateway mode the
`internal` network uses (see "Egress and ingress"), and it includes the fix
for CVE-2024-29018, DNS lookups leaking out of internal networks (fixed in
23.0.11 and 25.0.5). This draft assumes Docker and Tailscale exist on the
host already -- neither is a compose service here (see "Deliberately out of
scope" in `docker-compose.yml`).

**Generate the dashboard credentials before the first `up -d`, not after.**
The dashboard bind is non-loopback, so Hermes's auth gate is on from the
first second the container serves (`web_server.py`'s `should_require_auth`
is host-based and `--insecure` does not bypass it) -- and a placeholder
trio *satisfies* that gate. Starting with `change-me` / `change-me` puts a
working login on the tailnet until you get around to fixing it. Nothing in
the first-run flow needs the stack running to mint these.

**What goes in `.env` is the password *hash*, not the password** (04 section
6: "password hash where supported"). The stock provider prefers
`password_hash` and only hashes a plaintext in memory as a fallback
(`plugins/dashboard_auth/basic/__init__.py`), so the plaintext form leaves
the password at rest in `.env` for no benefit.

```bash
git clone <this repo> && cd <this repo>/deploy
cp .env.example .env

# 1. Session secret.
openssl rand -hex 32          # -> HERMES_DASHBOARD_BASIC_AUTH_SECRET in .env

# 2. Data directories first: the throwaway container below bind-mounts them,
#    and Docker would otherwise create them owned by root, which the
#    privilege-dropped hermes user cannot write.
mkdir -p data/hermes data/ntfy

# 3. Password hash. Prompted, so the password never reaches your shell history
#    or a process listing. `run --rm --no-deps` uses a throwaway container and
#    does NOT need the stack up.
docker compose run --rm --no-deps --entrypoint python hermes-serve -c \
  "import getpass; from plugins.dashboard_auth.basic import hash_password; \
   print(hash_password(getpass.getpass('dashboard password: ')))"

# 4. Escape every '$' as '$$' before pasting the hash into .env -- Compose
#    interpolates .env values, and an unescaped scrypt hash silently loses
#    everything after its first '$16384'.
printf '%s\n' 'scrypt$16384$8$1$...' | sed 's/\$/$$/g'
#    -> HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH in .env

# 5. Also set in .env: HERMES_DASHBOARD_BASIC_AUTH_USERNAME, TAILSCALE_IP,
#    DOCKER_SOCK_GID (stat -c '%g' /var/run/docker.sock).
#    Leave HERMES_DASHBOARD_BASIC_AUTH_PASSWORD empty.
#    Standard egress mode (the default) needs nothing further here. To
#    switch to strict mode instead, see "Egress and ingress" below.

# 6. Then validate and start.
docker compose -f docker-compose.yml config   # validate before starting anything
docker compose -f docker-compose.yml up -d
```

Check the interpolation before starting, since a mangled hash fails closed as
a login you cannot use:

```bash
docker compose -f docker-compose.yml config | grep BASIC_AUTH_PASSWORD_HASH
# every '$' must still be there (config output re-escapes them as '$$'),
# and the value must end in the same base64 the hash command printed
```

`HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` (plaintext) remains wired as a
**fallback only**, normally empty. A non-empty value takes *precedence* over
the hash -- the provider hashes it in memory on every start and logs that it
did -- so use it only if the hash command is unavailable in your image, and
replace it with a hash afterwards. UNVERIFIED: the hash command's import path
(`plugins.dashboard_auth.basic`) depends on the image's working directory
being the Hermes app root; if it fails, fall back to the plaintext variable
and record it as a gap.

The plugin is not copied anywhere: `docker-compose.yml` bind-mounts
`../integrations/ergates` read-only at `/opt/data/plugins/ergates`, which is
the user-plugin directory Hermes scans (`get_hermes_home()/plugins`, per
`hermes_cli/plugins_discovery.py`). Step 4 of the first-run provisioning
below enables it in every profile. The reviewed proposal templates travel
inside the plugin folder (`../integrations/ergates/templates/`), so the mount
carries them too. `hermes serve` copies them into `/opt/data/ergates/templates`
the first time the plugin's routes are used, and step 4 does the same right
away.

## Egress and ingress

The controllers and ntfy sit only on the Compose network `internal`, which
has no route out and, in the isolated gateway mode, no address on the host,
so they cannot reach a service listening on the host either. Their one
network path out is `egress-proxy` (Squid). Every service behind the proxy
gets `HTTP_PROXY`/`HTTPS_PROXY` pointing at it, but that is only the
address: a client that ignores the variables has no network path out at all
(04 section 7). This constrains network clients, not a compromised
controller: both controllers hold the Docker socket, so code running in one
can start a container outside `internal` and past the proxy.

The proxy has two modes, picked by `EGRESS_MODE` in `.env`
(`proxy/squid.conf` includes `proxy/mode-${EGRESS_MODE:-standard}.conf`):

### Standard mode (default, no setup)

HTTPS (a CONNECT tunnel to 443) and plain HTTP (port 80) to any public
host; every other port is denied. Every private, internal or special-use
address range is denied first -- loopback, the carrier-grade NAT range
Tailscale addresses also live in, link-local addresses (cloud metadata
lives at `169.254.169.254`), Docker's own default networks, multicast and
the rest -- checked on the IP Squid actually connects to, so a hostname
that resolves to one of them is denied exactly like a literal IP. This is
what lets a fresh install, and Hermes's `browser` toolset (any website),
work with no file to edit first.

The honest risk: standard mode cannot tell a legitimate request to a public
host apart from one a hostile web page talked an agent into making -- both
look like "a public host on port 443" to the proxy. What it does block is
that request reaching somewhere more damaging: the VPS's own services, the
Docker host, cloud metadata, or another device on your tailnet. Every
request the proxy handles is one line in `docker compose logs egress-proxy`,
naming the host; an unexpected one there is the thing to look for.

### Strict mode (more setup, safer)

HTTPS to a host listed in `proxy/allowed-domains.txt` only -- today's
original behavior, kept for an owner who wants an allowlist instead. Plain
HTTP, other ports, IP addresses and unlisted hosts are all denied.

1. Set `EGRESS_MODE=strict` in `.env`.
2. In `proxy/allowed-domains.txt`, remove the `#` in front of the hosts
   your model provider and connectors use. The file ships with `ntfy.sh`
   active (the iOS wake-up upstream) and one commented block per common
   built-in provider, with the hosts of Hermes v0.21.6 (the image and the
   contract pin are the same commit):

   | Provider | Hosts |
   |---|---|
   | Anthropic | `api.anthropic.com`; a Claude sign-in token also refreshes at `platform.claude.com` (Hermes falls back to `console.anthropic.com`, which its own source says returns 404, so that one is optional) |
   | OpenAI API | `api.openai.com` |
   | OpenAI Codex (ChatGPT sign-in) | `chatgpt.com`, `auth.openai.com` |
   | GitHub Copilot | `api.githubcopilot.com`, `api.github.com` (token exchange), `github.com` (device sign-in) |
   | xAI | `api.x.ai`; xAI sign-in also `auth.x.ai` |
   | OpenRouter | `openrouter.ai` |
   | Nous Portal | `inference-api.nousresearch.com`, `portal.nousresearch.com` |

   For any other provider, list the host of its base URL in Hermes's
   provider registry (`hermes_cli/auth.py`). The allowlist is per host: a
   listed host allows every path on it, so `api.github.com` opens all of
   GitHub's API.
3. Add any other host your connectors need, one per line.
4. `docker compose up -d egress-proxy` to reload Squid with the new mode
   and allowlist -- Squid does not watch its config files for changes, and
   this is also the command that fails if `EGRESS_MODE` is misspelled,
   instead of Docker silently creating an empty directory for a missing
   mode file.

In either mode, denied requests show in `docker compose logs egress-proxy`
as `TCP_DENIED` lines; in strict mode, add a host only when you know why
the stack needs it.

Hermes installs some optional backends from PyPI the first time they are
used (`tools/lazy_deps.py`, on unless `security.allow_lazy_installs: false`).
Strict mode blocks those installs with `TCP_DENIED` unless `pypi.org` and
`files.pythonhosted.org` are listed; listing them lets any code in the
controllers download any package from PyPI, so leaving them out and
setting `security.allow_lazy_installs: false` turns the failed install
into a message that names the missing feature instead. Standard mode
allows PyPI already, the same trade-off as any other public host.

The only published ports belong to `ingress` (HAProxy), on `TAILSCALE_IP`:
9119 for `hermes serve` and `NTFY_PORT` for ntfy, forwarded as plain TCP, so
the app's WebSocket passes through unchanged. Docker publishes no port of a
container that sits only on an internal network, which is why this hop
exists. Both services therefore see every client as the ingress's address:
a per-address limit in Hermes or ntfy applies to all phones together.

## First-run credential provisioning

Credentials are provisioned once, interactively -- never baked into
`docker-compose.yml`, `.env.example`, or any file in `profiles/`
(docs/04-security-and-compliance.md section 6). The dashboard trio is
already done above, before first start.

1. **Hermes setup wizard** (API keys, model/provider auth):
   ```bash
   docker compose exec hermes-serve hermes setup
   ```
   Writes to the mounted `/opt/data/.env` -- inside the volume, never in this
   repo.

2. **ntfy accounts and tokens** (deny-by-default ACL, 03 section 9; 04
   section 6 requires *separate scoped tokens*: a server publisher and
   device subscriptions). Two ordinary users, each with the narrowest
   access that works -- never an admin, whose rights no ACL entry
   constrains:

   ```bash
   # Server publisher: may publish to the topic, may not read it.
   docker compose exec ntfy ntfy user add --role=user ergates-publisher
   docker compose exec ntfy ntfy access ergates-publisher 'ergates-*' write-only

   # Device subscriber: may read the topic, may not publish to it.
   docker compose exec ntfy ntfy user add --role=user ergates-phone
   docker compose exec ntfy ntfy access ergates-phone 'ergates-*' read-only

   # One token for the server, and one token per device, from the right account.
   docker compose exec ntfy ntfy token add --label="hermes publisher" ergates-publisher
   docker compose exec ntfy ntfy token add --label="<device name>" ergates-phone
   ```

   `--role=user` is the whole point: an `--role=admin` account ignores ACL
   entries, so `ntfy access` on an admin is decoration and a token minted
   from it hands whoever holds it full control of the ntfy server. The phone
   is the device most likely to be lost, so it gets a read-only subscriber
   token and nothing else. One token per device keeps revocation per device
   (`ntfy token remove`). ([ntfy user/access/token CLI][ntfy-config])

   The publisher token goes **only** into the plugin's install-wide
   settings (`plugins.entries.ergates.settings.ntfy.token` in the Hermes
   root's `config.yaml`, `/opt/data/config.yaml`, which every profile's
   hooks and the sweep read -- see `integrations/ergates/README.md`); the subscriber
   tokens go **only** into the ntfy app on each device. Neither belongs in
   this `deploy/` tree, in `.env`, or on any command line other than the
   `ntfy token add` above.

   The topic itself must match the ACL pattern: set
   `plugins.entries.ergates.settings.ntfy.topic` to an `ergates-`-prefixed
   name (for example `ergates-attention`), and subscribe the devices to the
   same one.

3. **Concierge and specialist profiles**: the concierge is the default
   profile, so `profiles/concierge/config.yaml` is the Hermes root's
   `config.yaml`: merge its keys into `data/hermes/config.yaml` (the file
   `hermes setup` wrote) and copy `profiles/concierge/SOUL.md` to
   `data/hermes/SOUL.md`. It enables the plugin and holds the install-wide
   push settings; add the publisher token from step 2 as
   `plugins.entries.ergates.settings.ntfy.token`, and the app's connection
   id (the app's Settings, "Connection id (for push links)") as
   `...ntfy.connection_id`. Then fill in every `TODO` each `config.yaml`
   calls out (workspace volumes, effective toolset, MCP include list) before
   treating a profile as ready. Specialists are normally created by the app
   from a template in `../integrations/ergates/templates/`, with
   `mirror_credentials: false`; a
   specialist made by hand from `profiles/specialist-template/` goes to
   `data/hermes/profiles/<name>/` -- never copy the concierge's credentials
   (04 section 6; 11 section 4.1).

4. **Install the plugin into every profile, and the templates**, as the
   `hermes` user, then restart the controllers so both load the plugin's
   hooks and tools. (On Hermes v0.21.6 `hermes serve` would mount the
   plugin's routes on their first request without a restart.)

   ```bash
   docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.install
   docker compose restart hermes-serve hermes-gateway
   docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.install --check
   # ergates.install: templates=installed (bookkeeper, general-assistant)
   # ergates.install: profile=default plugin=enabled
   ```

   `--check` exits 0 only when every profile would load the plugin and the
   installed templates equal the plugin's `templates/` folder. Run step 4
   again after every update of this repository and after making a profile by
   hand; the app enables the plugin in the profiles it creates.

5. **Schedule the plugin's retry/retention sweep** (below). A failed push is
   scheduled for a retry that nothing in Hermes runs, so without this step
   the retry machinery and every retention rule are dead code.

## Periodic sweep: ntfy retries and retention

The plugin's hooks fire only on an approval or a finished turn -- there is
no periodic-timer hook in that surface -- so the push outbox and the
retention rules need an external driver. `python -m ergates.flush` is that
driver: it sends every due push from the outbox of the control store
(`/opt/data/ergates/control.sqlite3`), expires approvals older than the
approval timeout, and applies retention to attention events, proposal
receipts and reminder receipts.

It reads the ntfy server, topic, token and connection id from the Hermes root's `config.yaml`
(the same install-wide `plugins.entries.ergates.settings.ntfy.*` keys every hook reads),
so **no credential is ever passed as an argument** and none appears in a
process listing or in the log line it prints (04 section 6). The only
argument is `--quiet`. It also asks Hermes cron whether each reminder's job
still exists, so a job deleted in the Routines screen drops its receipt.

Add this to the host's crontab (`crontab -e`), every two minutes:

```cron
*/2 * * * * cd /srv/ergates/deploy && /usr/bin/docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.flush >> /var/log/ergates-flush.log 2>&1
```

- `-T` disables the pseudo-TTY, which a cron job has no use for.
- `-u hermes` runs the sweep as the image's `hermes` user, the user every
  Hermes service runs as. `docker compose exec` runs as root otherwise, and
  a root sweep is not supported: SQLite creates the store's `-wal` and
  `-shm` files as root and does not hand them over, and then every Hermes
  hook fails to open the store. The sweep refuses to start as root. If a
  root process opened the store anyway, repair it with
  `docker compose exec hermes-serve chown -R hermes:hermes /opt/data/ergates`.
- `PYTHONPATH=/opt/data/plugins/ergates` puts the mounted plugin directory
  on the import path; the package inside it is `ergates/`.
- Adjust `cd /srv/ergates/deploy` to wherever you cloned this repo, and
  `/usr/bin/docker` to `which docker` on the host (cron's `PATH` is minimal).

Run it once by hand first; it prints one line of counts:

```bash
docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.flush
# ergates.flush: retried=0 expired_notifications=0 pruned_notifications=0 pruned_proposals=0 pruned_reminders=0
```

A systemd timer is equally fine; the requirement is only that *something*
runs it on a short interval. Two minutes is chosen against the plugin's
30s / 2min / 10min publish backoff, so a due retry waits at most ~2 minutes
past its schedule.

## Update

Every image is pinned as `repository:tag@sha256:<digest>`; Docker uses the
digest. To move one forward, read the new tag's index digest from the
registry (for an official image such as `haproxy` the repository is
`library/haproxy`):

```bash
image=binwiederhier/ntfy tag=v2.28.0
token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${image}:pull" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
curl -fsSI -H "Authorization: Bearer ${token}" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
  "https://registry-1.docker.io/v2/${image}/manifests/${tag}" | grep -i '^docker-content-digest'
# docker-content-digest: sha256:6ef4b819f722fccdc036af611c4774cfdc2de821ab74fdd48bbf4c9d6f8973da
```

Put tag and digest into `docker-compose.yml` (both controllers use the same
Hermes image), then:

```bash
cd deploy
docker compose pull
docker compose up -d
```

Then run the installer again, as in step 4 of the first-run provisioning,
after every image update and after every `git pull` of this repository: the
plugin's code and its `templates/` folder come from the checkout, and
`hermes serve` mounts the plugin's routes only when it starts.

```bash
docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.install
docker compose restart hermes-serve hermes-gateway
docker compose exec -T -u hermes -e PYTHONPATH=/opt/data/plugins/ergates hermes-serve python -m ergates.install --check
```

A new Hermes image is a new Hermes. The integration's contract tests are
pinned to one Hermes commit (`HERMES_PIN` in `scripts/ci-local.sh`), and the
image in `docker-compose.yml` is built from that same commit, v0.21.6. Move
both together: change `HERMES_PIN`, put the digest of the new commit's image
in `docker-compose.yml`, and rerun `scripts/ci-local.sh contract` before you
deploy. Take the digest from the release's final candidate tag, here
`rc.4-v0.21.6`, or from `stable` while the release is the newest. The
registry's plain `v0.21.6` tag is an older build from an abandoned
candidate.

Both `hermes-serve` and `hermes-gateway` read from the same `/opt/data`
volume, so no separate data migration step is expected for a same-major
update -- confirm this against Hermes's own update notes before a real
upgrade, since neither controller has been updated in this draft.

## Backup

Initial policy (04 section 8): **seven daily and four weekly encrypted
off-host snapshots**, covering:

- `${HERMES_DATA_DIR}` (`/opt/data`): profile workspaces, `config.yaml`,
  `.env`, `SOUL.md`, sessions, cron jobs, state database, and this
  package's control store (`ergates/control.sqlite3` with its `-wal` file).
- `${NTFY_DATA_DIR}`: the ntfy auth and cache databases.

A consistency-aware procedure is required, not a raw `cp` of a live SQLite
file:

```bash
# Example only -- not exercised against this stack. Adjust for your actual
# backup target/encryption tooling.
docker compose stop hermes-serve hermes-gateway
tar czf "backup-$(date +%Y%m%d-%H%M%S).tar.gz" data/hermes data/ntfy
docker compose start hermes-serve hermes-gateway
# Encrypt and ship the archive off-host; do not leave it next to the volumes.
```

Stopping both controllers for the backup window is the simplest way to
guarantee a consistent snapshot in this draft; a hot-backup procedure (WAL
checkpoint + copy) is a P0 follow-up if the stop window becomes too
disruptive. Record backup encryption-key recovery separately from the
server itself (04 section 8) -- losing both together makes the backup
worthless.

## Restore drill

Not yet performed against this stack. Before relying on backups:

1. Provision a second, disposable VPS (or a local Docker host).
2. Restore the most recent daily archive to fresh `data/hermes` and
   `data/ntfy` directories.
3. Bring the stack up against the restored data and confirm: the dashboard
   logs in with the restored basic-auth credentials, at least one known
   profile's sessions/memory are present, and a known cron job still lists
   correctly.
4. Record how long the restore took and anything that had to be fixed by
   hand. Repeat quarterly, or after any change to the backup procedure.

## Live checks

`VERIFY.md` holds every check that needs the real VPS, a phone and a real
model, with a place to record each result: Squid and HAProxy parsing their
configs, Docker socket access under the image's privilege drop, egress and
ingress isolation, the plugin install and the sweep, the two concurrency
checks of Hermes's in-flight hook guard, locked-phone and repeated pushes,
notification settings, deep links, the encrypted device data, provisioning,
tool revocation, a routine saved twice from the app, approval events with no
app connected, sandbox workspace paths, the restore drill, the Hermes image
version against the integration's contract pin, a green CI run on a real
remote, and a closing set of app-only checks (proposal cards, offline chat
sends) that do not depend on this deployment.

## Corrections applied after review

- The runbook used to bring the stack up with a placeholder basic-auth trio
  and generate real values afterwards. Because the gate is on from the first
  request, that served a `change-me` login on the tailnet in between;
  credentials now come first.
- ntfy provisioning used to create the publisher as `--role=admin` and then
  mint the "narrowly-scoped subscriber token" from that same admin account,
  so a lost phone carried full control of the ntfy server and the
  `ntfy access` line next to it had no effect. Now: two `--role=user`
  accounts, write-only for the server, read-only per device.
- The plugin was never installed into the stack (no mount, no copy step),
  and nothing drove `flush_retries`. Both are wired above.
- The dashboard password was passed as plaintext where the provider prefers a
  hash. `.env` now carries `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH`,
  generated before the first start, with the plaintext variable kept as a
  documented fallback.

[ntfy-config]: https://docs.ntfy.sh/config/
