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
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

from pinned import HERMES_PIN, check_pin

PLUGIN_DIR = Path(__file__).resolve().parents[2]
# The dashboard session token `hermes serve` expects (hermes_cli/web_server.py reads the variable at import).
SESSION_TOKEN = "ergates-contract-live-token"
_temporary: list[Path] = []


def pytest_configure(config: pytest.Config) -> None:
    raw = os.environ.get("HERMES_SOURCE", "").strip()
    if not raw:
        pytest.exit(f"HERMES_SOURCE is not set; point it at a Hermes checkout at {HERMES_PIN}", returncode=4)
    source = Path(raw).expanduser().resolve()
    failure = check_pin(source, HERMES_PIN)
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
    (root / "config.yaml").write_text(
        "plugins:\n  enabled:\n  - ergates\nsecurity:\n  allow_lazy_installs: false\n", encoding="utf-8",
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
    import mounts every enabled plugin's API router."""
    from fastapi.testclient import TestClient
    from hermes_cli.web_server import app

    return TestClient(app)


@pytest.fixture(scope="session")
def token_headers() -> dict[str, str]:
    return {"X-Hermes-Session-Token": SESSION_TOKEN}
