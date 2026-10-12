"""Live contract tests: Ergates code against the pinned Hermes itself.

`scripts/ci-local.sh contract` runs this folder as its own pytest run, with
the pinned Hermes's locked runtime dependencies installed (exported from the
pin's `uv.lock`). `contract/conftest.py` keeps it out of a plain
`pytest contract`, which has neither.

Hermes computes some paths when a module is first imported, so
`pytest_configure` prepares everything before any test module imports
Hermes: HOME and HERMES_HOME point at a fresh temporary folder, HERMES_SOURCE
goes first on `sys.path`, and the temporary Hermes root holds this plugin the
way an install does (`plugins/ergates` links to this repository's
`integrations/ergates`, and `config.yaml` enables it). Nothing here reads or
writes the real `~/.hermes`.

Hermes mounts plugin routes per process, so a test that needs a dashboard on
another Hermes root (one without the plugin, or one an old version left)
starts its own server in a child process with ``serve_hermes``
(``hermes_serve.py``).
"""

from __future__ import annotations

import os
import secrets
import select
import shutil
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml

from pinned import check_pin, expected_ref
from plugin_tree import NO_HOOKS, PLUGIN_DIR, copy_tracked_files

# The dashboard session token `hermes serve` expects (hermes_cli/web_server.py reads the variable at import).
# A new one for every test session: pytest imports this file once.
SESSION_TOKEN = secrets.token_urlsafe(16)
SERVE_SCRIPT = Path(__file__).with_name("hermes_serve.py")
# A first plugin install on a Hermes that runs from a source checkout prepares Hermes's own
# dependency runtime first (downloads included), which takes about a minute.
SERVER_TIMEOUT_SECONDS = 600
_temporary: list[Path] = []


def pytest_configure(config: pytest.Config) -> None:
    raw = os.environ.get("HERMES_SOURCE", "").strip()
    if not raw:
        pytest.exit(f"HERMES_SOURCE is not set; point it at a Hermes checkout at {expected_ref()}", returncode=4)
    source = Path(raw).expanduser().resolve()
    failure = check_pin(source, expected_ref())
    if failure is not None:
        pytest.exit(failure, returncode=4)
    base = Path(tempfile.mkdtemp(prefix="ergates-live-")).resolve()
    _temporary.append(base)
    home, root = base / "home", base / "hermes"
    home.mkdir()
    (root / "plugins").mkdir(parents=True)
    (root / "plugins" / "ergates").symlink_to(PLUGIN_DIR, target_is_directory=True)
    # security.allow_lazy_installs: false blocks Hermes's lazy `uv pip install` in both
    # sealed and unsealed venvs (tools/lazy_deps.py:321-322); without it a test that
    # imports an optional provider stack can wait out the whole 300 s install timeout.
    # sweep.interval_seconds: 0 keeps the session server's periodic sweep off, so no
    # background pass expires, prunes or sends while another test reads the store.
    (root / "config.yaml").write_text(
        "plugins:\n  enabled:\n  - ergates\n  entries:\n    ergates:\n      settings:\n        sweep:\n"
        "          interval_seconds: 0\nsecurity:\n  allow_lazy_installs: false\n", encoding="utf-8",
    )
    os.environ.update({"HOME": str(home), "HERMES_HOME": str(root), "HERMES_DASHBOARD_SESSION_TOKEN": SESSION_TOKEN})
    # Hermes computes some paths at import time; nothing has imported it yet here, so
    # this keeps every .pyc the live suite would otherwise write into the pinned
    # checkout (it must stay clean: contract/pinned.py's check_pin refuses local edits
    # or untracked files there).
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source))
    # Starlette at the pin prefers httpx2 for its TestClient; the pinned Hermes ships httpx.
    config.addinivalue_line("filterwarnings", "ignore:Using `httpx` with `starlette.testclient`")


def pytest_unconfigure(config: pytest.Config) -> None:
    for base in _temporary:
        shutil.rmtree(base, ignore_errors=True)


@pytest.fixture(scope="session")
def root() -> Path:
    """The temporary Hermes root (the default profile's home)."""
    return Path(os.environ["HERMES_HOME"])


@pytest.fixture
def make_profile():
    """``make_profile(name)`` creates the named profile with Hermes's ``create_profile`` and returns its home.

    ``create_profile`` is what ``hermes profile create`` and the app's
    ``profiles.create`` RPC run. Since v0.21.6 a folder under ``profiles/`` is a
    profile only when it holds an identity marker (``hermes_constants.py``
    ``named_profile_is_live``), which a bare ``mkdir`` does not make.
    """
    from hermes_cli.profiles import create_profile

    def make(name: str) -> Path:
        return Path(create_profile(name))

    return make


@pytest.fixture(scope="session")
def web():
    """Hermes's dashboard app, imported the way ``hermes serve`` loads it; the
    import mounts every enabled plugin's API router.

    The plugin installs its own proposal templates when the router builds its
    operations, on the first request, and removes any other template then. One
    request here makes that happen before any test runs, so a test that writes
    a template of its own (``provision``, the accept test) can write after it.
    """
    from fastapi.testclient import TestClient
    from hermes_cli.web_server import app

    client = TestClient(app)
    first = client.get("/api/plugins/ergates/health", headers={"X-Hermes-Session-Token": SESSION_TOKEN})
    assert first.status_code == 200, first.text
    return client


@pytest.fixture(scope="session")
def token_headers() -> dict[str, str]:
    return {"X-Hermes-Session-Token": SESSION_TOKEN}


@dataclass(frozen=True)
class PluginRepo:
    """A git repository whose one commit holds this plugin, the way a user installs it from a URL.

    ``subdir`` is the folder of the repository that holds the plugin, empty when it sits at the root.
    """

    path: Path
    url: str
    sha: str
    version: str
    subdir: str = ""

    @property
    def identifier(self) -> str:
        """What a client gives Hermes to install it: the URL, and ``#<subdir>`` when the plugin is in a folder."""
        return f"{self.url}#{self.subdir}" if self.subdir else self.url


def _commit_plugin(path: Path, subdir: str) -> PluginRepo:
    """Commits a copy of ``integrations/ergates`` (every file git tracks) to a new repository at ``path``.

    Untracked files stay out (``plugin_tree.copy_tracked_files``), so a stray
    local file cannot change the install scan's verdict, and no git hook of
    this machine runs.
    """
    plugin = path / subdir if subdir else path
    plugin.mkdir(parents=True, exist_ok=True)
    copy_tracked_files(plugin)
    git = ["git", *NO_HOOKS, "-C", str(path), "-c", "user.name=Ergates contract", "-c", "user.email=contract@ergates.invalid",
           "-c", "commit.gpgsign=false"]
    subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "Ergates plugin"], check=True)
    sha = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    version = yaml.safe_load((plugin / "plugin.yaml").read_text(encoding="utf-8"))["version"]
    return PluginRepo(path=path, url=path.as_uri(), sha=sha, version=version, subdir=subdir)


@pytest.fixture(scope="session")
def plugin_git_repo(tmp_path_factory) -> PluginRepo:
    """The plugin at the root of a new repository."""
    return _commit_plugin(tmp_path_factory.mktemp("plugin-repo"), "")


@pytest.fixture(scope="session")
def plugin_monorepo(tmp_path_factory) -> PluginRepo:
    """The plugin in ``integrations/ergates`` of a new repository, the layout of its own repository: Hermes
    installs it from that subdirectory."""
    return _commit_plugin(tmp_path_factory.mktemp("plugin-monorepo"), "integrations/ergates")


@pytest.fixture
def serve_hermes():
    """``serve_hermes(root)`` starts ``hermes_serve.py`` on Hermes root ``root`` and returns an HTTP client for it.

    The child gets its own empty HOME next to ``root`` and the same session
    token as ``web``, so ``token_headers`` works for it; its stderr, and its
    stdout after the port line, go to ``hermes-serve.log`` next to ``root``
    (a thread drains stdout, so a chatty child never blocks on a full pipe).
    When the test ends, every server is
    stopped and its root removed: a first plugin install leaves Hermes's own
    dependency runtime there, about half a gigabyte.
    """
    import httpx

    started: list[tuple[Path, subprocess.Popen, threading.Thread, httpx.Client]] = []

    def start(root: Path) -> httpx.Client:
        home = root.parent / "home"
        home.mkdir(exist_ok=True)
        log = root.parent / "hermes-serve.log"
        log.write_text("", encoding="utf-8")
        env = {**os.environ, "HOME": str(home), "HERMES_HOME": str(root),
               "HERMES_DASHBOARD_SESSION_TOKEN": SESSION_TOKEN, "PYTHONDONTWRITEBYTECODE": "1"}
        # Append mode for the child and the drain thread alike, so neither overwrites the other.
        with log.open("a", encoding="utf-8") as stderr:
            process = subprocess.Popen([sys.executable, "-I", "-B", str(SERVE_SCRIPT)], cwd=root.parent, env=env,
                                       stdout=subprocess.PIPE, stderr=stderr, text=True)
        ready, _, _ = select.select([process.stdout], [], [], 120)
        line = process.stdout.readline() if ready else ""
        if not line.strip().isdigit():
            _stop(process)
            pytest.fail(f"hermes_serve.py did not start:\n{log.read_text(encoding='utf-8')[-4000:]}")
        drain = threading.Thread(target=_drain, args=(process.stdout, log), daemon=True)
        drain.start()
        client = httpx.Client(base_url=f"http://127.0.0.1:{int(line)}", timeout=SERVER_TIMEOUT_SECONDS)
        started.append((root, process, drain, client))
        return client

    yield start
    for root, process, drain, client in started:
        client.close()
        _stop(process, drain)
        shutil.rmtree(root, ignore_errors=True)


def _drain(stream, log: Path) -> None:
    """Appends what the child writes to ``stream`` to ``log`` until the child closes it."""
    with log.open("a", encoding="utf-8") as out:
        for line in stream:
            out.write(line)
            out.flush()


def _stop(process: subprocess.Popen, drain: threading.Thread | None = None) -> None:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    if drain is not None:
        # The child is gone, so the thread reads to the end of the pipe and stops.
        drain.join(timeout=10)
    process.stdout.close()
