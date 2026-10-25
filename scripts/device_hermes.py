"""A throwaway Hermes at the pin, for the device check of plugin updates.

Run it through ``scripts/device-hermes.sh``, which prepares the pinned Hermes
source (``HERMES_SOURCE``) and runs this file with Hermes's locked runtime
dependencies. Everything it makes lives in ``.cache/device-check``:

* ``root/``: the Hermes root (``HERMES_HOME``). The plugin installs here.
* ``home/``, ``locks/`` and ``state/``: the server's ``HOME``,
  ``HERMES_GATEWAY_LOCK_DIR`` and ``XDG_STATE_HOME``. Hermes keeps its
  one-server-per-user record in that lock dir (``gateway/status.py``
  ``_get_lock_dir``), so this server never sees a Hermes the user runs, and
  ``hermes serve --isolated`` binds its own port instead of attaching to one.
* ``token`` and ``metro.env``: the dashboard session token, and the app's
  DEV connect variables (``EXPO_PUBLIC_DEV_GATEWAY_URL`` and ``_TOKEN``),
  both readable by the user only. The token is never printed.
* ``serve.pid``, ``serve.port`` and ``serve.log``.

The plugin installs with the command the app's Finish screen shows
(``manual-commands.json``), from GitHub, so the commit must be pushed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATE = REPO / ".cache" / "device-check"
ROOT = STATE / "root"
MANUAL_COMMANDS = REPO / "apps/mobile/src/features/server/manual-commands.json"
BUILD_RECORD = REPO / "apps/mobile/src/features/server/build-record.ts"
DEFAULT_PORT = 9131
COMMIT = re.compile(r"[0-9a-f]{40}")
# A first plugin install prepares Hermes's own dependency runtime, downloads included.
INSTALL_TIMEOUT_SECONDS = 900
START_TIMEOUT_SECONDS = 180
STOP_TIMEOUT_SECONDS = 15
# What `break` appends to the installed plugin's routes: Hermes then cannot import them at the next load.
BROKEN = '\nraise RuntimeError("device check: this plugin version is broken on purpose")\n'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="device-hermes.sh", description="A throwaway Hermes for the device check of plugin updates.")
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="install the plugin at a commit of this repository from GitHub, then serve")
    start.add_argument("--commit", required=True, help="a full commit that is pushed to GitHub")
    start.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"loopback port (default {DEFAULT_PORT})")
    commands.add_parser("break", help="make the installed plugin fail at its next load")
    restart = commands.add_parser("restart", help="restart the server")
    restart.add_argument("--new-token", action="store_true", help="with a new session token, so the app has to sign in again")
    commands.add_parser("status", help="say whether the server runs, and what the plugin reports")
    commands.add_parser("stop", help="stop the server and remove everything")
    args = parser.parse_args(argv)
    handlers = {"start": cmd_start, "break": cmd_break, "restart": cmd_restart, "status": cmd_status, "stop": cmd_stop}
    return handlers[args.command](args)


def cmd_start(args: argparse.Namespace) -> int:
    if not COMMIT.fullmatch(args.commit):
        return fail("--commit must be a full commit of 40 lowercase hex characters")
    if running() is not None:
        return fail("a device-check Hermes runs already; run `stop` first")
    shutil.rmtree(STATE, ignore_errors=True)
    for folder in (ROOT, STATE / "home", STATE / "locks", STATE / "state"):
        folder.mkdir(parents=True)
    # No lazy `uv pip install` of optional provider stacks (tools/lazy_deps.py), as in the live contract tests.
    (ROOT / "config.yaml").write_text("security:\n  allow_lazy_installs: false\n", encoding="utf-8")
    write_private(STATE / "token", secrets.token_urlsafe(16))
    try:
        installed = hermes(install_args(args.commit))
    except subprocess.TimeoutExpired:
        return fail(f"the plugin install did not finish within {INSTALL_TIMEOUT_SECONDS} s; run `stop` to clean up")
    if installed.returncode != 0:
        return fail(f"the plugin install failed:\n{installed.stdout}{installed.stderr}")
    if not serve(args.port):
        return 1
    print(f"Hermes serves on http://127.0.0.1:{args.port} with the plugin at {args.commit[:7]}.")
    print(f"For Metro: set -a; . {STATE / 'metro.env'}; set +a")
    return 0


def cmd_break(args: argparse.Namespace) -> int:
    routes = ROOT / "plugins" / "ergates" / "dashboard" / "api.py"
    if not routes.is_file():
        return fail(f"no installed plugin at {routes.parent.parent}")
    text = routes.read_text(encoding="utf-8")
    if BROKEN not in text:
        routes.write_text(text + BROKEN, encoding="utf-8")
    print("The installed plugin fails to load from the next start on. Run `restart`.")
    return 0


def cmd_restart(args: argparse.Namespace) -> int:
    port_file = STATE / "serve.port"
    if not port_file.is_file():
        return fail("nothing to restart; run `start` first")
    stop_server()
    if args.new_token:
        write_private(STATE / "token", secrets.token_urlsafe(16))
    if not serve(int(port_file.read_text(encoding="utf-8"))):
        return 1
    print("Hermes runs again" + (" with a new session token: the app has to sign in again." if args.new_token else "."))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    pid = running()
    if pid is None:
        print("No device-check Hermes runs.")
        return 1
    port = int((STATE / "serve.port").read_text(encoding="utf-8"))
    status, body = get(port, "/api/plugins/ergates/health")
    print(f"Hermes runs on http://127.0.0.1:{port} (pid {pid}).")
    if status == 200 and isinstance(body, dict):
        install = body.get("install") or {}
        print(f"Plugin {body.get('plugin_version')}: {install.get('kind')} at {install.get('commit')}, code loaded from {install.get('loaded_commit')}.")
    else:
        print(f"The plugin's health answers {status}.")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    stop_server()
    shutil.rmtree(STATE, ignore_errors=True)
    print("Stopped, and .cache/device-check is removed.")
    return 0


def install_args(commit: str) -> list[str]:
    """The arguments after ``hermes`` of the app's install command for ``commit``."""
    template = json.loads(MANUAL_COMMANDS.read_text(encoding="utf-8"))["install"]
    identifier = re.search(r"PLUGIN_IDENTIFIER = '([^']+)'", BUILD_RECORD.read_text(encoding="utf-8"))
    if identifier is None:
        raise SystemExit(f"device-hermes: no PLUGIN_IDENTIFIER in {BUILD_RECORD}")
    words = shlex.split(template.replace("{identifier}", identifier.group(1)).replace("{commit}", commit))
    if words[0] != "hermes":
        raise SystemExit(f"device-hermes: the install command does not start with hermes: {template}")
    return words[1:]


def env() -> dict[str, str]:
    """The environment of every Hermes process here. Inherited ``HERMES_*`` settings are dropped, so a
    shell set up for another Hermes (a public URL, a password) cannot change this one."""
    base = {key: value for key, value in os.environ.items() if not key.startswith("HERMES_")}
    return {
        **base,
        "HOME": str(STATE / "home"),
        "HERMES_HOME": str(ROOT),
        "HERMES_GATEWAY_LOCK_DIR": str(STATE / "locks"),
        "XDG_STATE_HOME": str(STATE / "state"),
        "HERMES_DASHBOARD_SESSION_TOKEN": (STATE / "token").read_text(encoding="utf-8"),
        "PYTHONPATH": os.environ["HERMES_SOURCE"],
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def hermes(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Runs a ``hermes`` command the way a script on a server runs it: no terminal, so every question gets its
    non-interactive answer."""
    return subprocess.run([sys.executable, "-B", "-m", "hermes_cli.main", *args], cwd=STATE, env=env(),
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False,
                          timeout=INSTALL_TIMEOUT_SECONDS)


def runtime_python() -> str:
    """The Python of the dependency environment Hermes committed for the pinned source, or this one.

    The first plugin install makes Hermes prepare that environment, and from then on every ``hermes``
    process loads its packages at boot (``pm/environments.py`` ``activate_dependencies``). Its compiled
    modules fit only its own Python, so the server runs on that Python, as Hermes runs itself.
    """
    probe = ("import pathlib, sys\nfrom pm.environments import committed_venv\n"
             "venv = committed_venv(pathlib.Path(sys.argv[1]))\nprint(venv or '')")
    found = subprocess.run([sys.executable, "-B", "-c", probe, os.environ["HERMES_SOURCE"]], cwd=STATE, env=env(),
                           capture_output=True, text=True, check=False).stdout.strip()
    python = Path(found) / "bin" / "python" if found else None
    return str(python) if python is not None and python.is_file() else sys.executable


def serve(port: int) -> bool:
    """Starts ``hermes serve`` in its own process group and waits until it answers."""
    # A server already on the port would answer the readiness check below in place of this one.
    if port_answers(port):
        fail(f"something already listens on port {port}; stop it, or pick another port with `start --port`")
        return False
    token = (STATE / "token").read_text(encoding="utf-8")
    write_private(STATE / "metro.env", f"EXPO_PUBLIC_DEV_GATEWAY_URL=http://127.0.0.1:{port}\nEXPO_PUBLIC_DEV_GATEWAY_TOKEN={token}\n")
    with (STATE / "serve.log").open("a", encoding="utf-8") as log:
        process = subprocess.Popen(
            [runtime_python(), "-B", "-m", "hermes_cli.main", "serve", "--host", "127.0.0.1", "--port", str(port), "--isolated", "--skip-build"],
            cwd=STATE, env=env(), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (STATE / "serve.pid").write_text(str(process.pid), encoding="utf-8")
    (STATE / "serve.port").write_text(str(port), encoding="utf-8")
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        if get(port, "/api/status")[0] == 200:
            return True
        time.sleep(1)
    tail = (STATE / "serve.log").read_text(encoding="utf-8")[-4000:]
    fail(f"hermes serve did not come up on port {port}:\n{tail}")
    return False


def running() -> int | None:
    """The pid of this check's ``hermes serve``, or None. A pid file whose process is gone, or now runs
    something else, does not count."""
    pid_file = STATE / "serve.pid"
    if not pid_file.is_file():
        return None
    pid = int(pid_file.read_text(encoding="utf-8"))
    port_file = STATE / "serve.port"
    port = port_file.read_text(encoding="utf-8").strip() if port_file.is_file() else None
    command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=False).stdout
    ours = port is not None and "hermes_cli.main serve" in command and "--isolated" in command and f"--port {port}" in command
    return pid if ours else None


def stop_server() -> None:
    pid = running()
    if pid is None:
        return
    try:
        os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + STOP_TIMEOUT_SECONDS
        while time.monotonic() < deadline and running() is not None:
            time.sleep(0.5)
        if running() is not None:
            os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # it ended on its own in between


def port_answers(port: int) -> bool:
    """Whether something already accepts connections on the loopback port."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def get(port: int, path: str) -> tuple[int | None, object]:
    """``(status, JSON body)`` of a GET with the session token; ``(None, None)`` when nothing answers."""
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"X-Hermes-Session-Token": (STATE / "token").read_text(encoding="utf-8")})
    try:
        with urllib.request.urlopen(request, timeout=5) as reply:
            return reply.status, json.loads(reply.read() or b"null")
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return None, None


def write_private(path: Path, text: str) -> None:
    """Writes ``text`` to a file only the user can read, from the moment it exists."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as out:
        out.write(text)
    path.chmod(0o600)


def fail(message: str) -> int:
    print(f"device-hermes: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
