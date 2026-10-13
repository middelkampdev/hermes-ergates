"""The Ergates HTTP operations as a Hermes dashboard plugin router (ADR-031).

``hermes serve`` imports this file by path, because ``manifest.json`` next to
it names it as the plugin's ``api``, and mounts ``router`` under
``/api/plugins/ergates``. Hermes's own middleware authenticates every request
before it reaches a route: the dashboard session token on loopback, the
cookie gate when dashboard auth is on. There is no Ergates HTTP service of its
own.

Each route reads its input, runs one ``Operations`` method on the server's
worker thread pool, and answers that method's status and JSON body. The work
blocks (a store write may wait up to its busy timeout; a second identical
reminder request waits up to five seconds for the first), so it never runs on
the event loop.

One ``Operations`` -- one ``ControlStore`` -- serves every request of the
process. It is built on first use, not at import, so a store that cannot be
opened answers 503 ``store_unavailable`` instead of keeping the router from
mounting. Building it also installs the plugin's proposal templates.

Importing this file also starts the plugin's periodic sweep (``ergates.sweep``):
due pushes, expiry and retention, on one daemon thread, every
``sweep.interval_seconds`` (``ergates.settings.sweep_interval``). Only Hermes's
dashboard server imports this file, at its start or when it mounts the routes
on their first request after an install, so the gateway and cron processes
start no sweep. A sweep that cannot start is logged by error class and named
in ``GET /health``; the router still mounts.

Importing it also records the commit the plugin was installed at, which
``GET /health`` reports as ``install.loaded_commit`` (see ``install``).

Hermes imports this file under its own module name, outside any package, so
the plugin folder is added to ``sys.path`` to import the ``ergates`` package.
The Hermes boundary
(``integrations/ergates-tests/tests/test_hermes_boundary.py``) allows Hermes
imports here; this file needs none, because every Hermes call goes through
``ergates.hermes_adapter``.
"""

import functools
import json
import logging
import os
import sqlite3
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

_PLUGIN_DIR = str(Path(__file__).resolve().parents[1])
if _PLUGIN_DIR not in sys.path:
    sys.path.append(_PLUGIN_DIR)

from ergates import flush, hermes_adapter, setup  # noqa: E402
from ergates.install_info import INSTALL_KIND_ENV, install_info  # noqa: E402
from ergates.operations import Operations, Reply, internal_error, store_unavailable  # noqa: E402
from ergates.paths import bundled_templates_dir, hermes_root, store_path, templates_dir  # noqa: E402
from ergates.settings import push_status, sweep_interval  # noqa: E402
from ergates.store import ControlStore, StoreError  # noqa: E402
from ergates.sweep import SWEEP_INTERVAL_SECONDS, Sweep  # noqa: E402

logger = logging.getLogger("ergates.dashboard")

router = APIRouter()

_lock = threading.Lock()
_operations: Optional[Operations] = None
_sweep: Optional[Sweep] = None
_sweep_failure: Optional[dict] = None


def _start_sweep() -> None:
    """Start the periodic sweep of this Hermes root. Never raises: a failure is logged and kept for ``sweep_status``.

    As root on a Hermes root another user owns, the thread starts and every
    pass stops where the store refuses to open, before it creates anything
    (``flush.sweep_once``); ``GET /health`` answers 503 there anyway.
    """
    global _sweep, _sweep_failure
    interval = SWEEP_INTERVAL_SECONDS
    try:
        root = hermes_root()
        interval = sweep_interval(root)
        sweep = Sweep(functools.partial(flush.sweep_once, root), interval=interval)
        sweep.start()
    except Exception as exc:
        logger.warning("ergates: the periodic sweep did not start (%s)", type(exc).__name__)
        _sweep, _sweep_failure = None, {"interval_seconds": interval, "last_run_at": None,
                                        "last_error": type(exc).__name__}
        return
    _sweep, _sweep_failure = sweep, None


def sweep_status() -> dict:
    """The sweep's ``status()``, or the interval and the error class when it could not start."""
    if _sweep is None:
        return dict(_sweep_failure or {})
    return _sweep.status()


def _read_install() -> dict:
    return install_info(
        hermes_adapter.install_record(), hermes_adapter.root_plugin_dir(), os.environ.get(INSTALL_KIND_ENV),
    )


# The commit Hermes's install record named when Hermes imported this file. A reinstall replaces the plugin's files
# and the record, but a running server keeps the routes it mounted, so this stays the commit of the code that
# answers until the server restarts.
_loaded_commit: Optional[str] = _read_install()["commit"]


def install() -> dict:
    """How the plugin got here, for ``GET /health`` (``ergates.install_info``), read at each call.

    The ``ERGATES_INSTALL_KIND`` marker is read from the environment at each
    call, not when the operations are built. ``loaded_commit`` is the
    exception: it was read once, when this file was imported, so it differs
    from ``commit`` after a reinstall until Hermes restarts. It is ``None``
    for a manual copy and a deployment, which have no commit.
    """
    return {**_read_install(), "loaded_commit": _loaded_commit}


def operations() -> Operations:
    """The process's one ``Operations``, built on first use.

    The plugin's own proposal templates are installed first, before the store
    opens (``ergates.setup.ensure_templates``): a root that never ran
    ``python -m ergates.install`` still serves them. That call logs and
    returns a state; it never raises, so a template that cannot be installed
    does not stop the routes.
    """
    global _operations
    with _lock:
        if _operations is None:
            root = hermes_root()
            bundled = bundled_templates_dir()
            setup.ensure_templates(bundled, templates_dir(root))
            _operations = Operations(
                ControlStore(store_path(root)),
                cron=hermes_adapter.HermesCron(),
                profile_exists=hermes_adapter.profile_exists,
                plugin_enabled=hermes_adapter.plugin_enabled,
                enable_plugin=hermes_adapter.enable_plugin,
                profile_names=hermes_adapter.profile_names,
                check_schedule=hermes_adapter.check_schedule,
                check_prompt=hermes_adapter.check_prompt,
                check_gateway_lifecycle=hermes_adapter.check_gateway_lifecycle,
                templates=templates_dir(root),
                bundled_templates=bundled,
                sweep_status=sweep_status,
                install=install,
                push_status=functools.partial(push_status, root),
            )
        return _operations


def _call(method: Callable[[Operations], Reply]) -> Reply:
    """Run ``method`` on the process's ``Operations``; always a ``Reply``.

    A store that cannot be opened is 503 ``store_unavailable``. Any other
    exception -- one an ``Operations`` method does not map, such as a Hermes
    call that raised -- is 500 ``internal`` with a fixed message, never
    Starlette's plain-text 500. The log names the exception class only: its
    message can carry a path or prompt text.
    """
    try:
        ops = operations()
    except (StoreError, sqlite3.Error, OSError) as exc:
        logger.warning("ergates: the control store cannot be opened (%s)", type(exc).__name__)
        return store_unavailable()
    except Exception as exc:
        return _internal(exc)
    try:
        return method(ops)
    except Exception as exc:
        return _internal(exc)


def _internal(exc: Exception) -> Reply:
    logger.warning("ergates: the request could not be completed (%s)", type(exc).__name__)
    return internal_error()


async def _answer(method: Callable[[Operations], Reply]) -> JSONResponse:
    reply = await run_in_threadpool(_call, method)
    return JSONResponse(status_code=reply.status, content=reply.body)


def _sent_as_json(content_type: str) -> bool:
    """True for ``application/json`` or a ``.../*+json`` subtype; parameters (``; charset=...``) are allowed."""
    media_type = content_type.split(";", 1)[0].strip().lower()
    return media_type == "application/json" or media_type.endswith("+json")


async def _body(request: Request) -> Any:
    """The JSON body, or ``None`` when it is missing, not JSON, or not sent as JSON.

    Only a request whose ``Content-Type`` is ``application/json`` (or a
    ``+json`` subtype) is parsed, matching what Hermes's own JSON routes
    accept -- a missing or different content type answers ``None`` the same
    as unparsable JSON, never parsing the body anyway. That forces a CORS
    preflight before a cross-origin request can reach a mutating route:
    Hermes checks no Origin or CSRF token, and a gated session cookie is
    ``SameSite=Lax``, so without this check a same-site page could send a
    no-preflight ``text/plain`` body straight into ``POST /reminders``.
    Deeply nested JSON raises ``RecursionError``, not ``ValueError``; it is
    treated the same as any other unparsable body rather than left to escape
    as an unhandled 500.
    """
    if not _sent_as_json(request.headers.get("content-type", "")):
        return None
    raw = await request.body()
    try:
        return json.loads(raw) if raw else None
    except (ValueError, RecursionError):
        return None


@router.get("/health")
async def health() -> JSONResponse:
    return await _answer(lambda ops: ops.health())


@router.post("/reminders")
async def create_reminder(request: Request) -> JSONResponse:
    body = await _body(request)
    return await _answer(lambda ops: ops.create_reminder(body))


@router.get("/proposals/{proposal_id}")
async def get_proposal(proposal_id: str) -> JSONResponse:
    return await _answer(lambda ops: ops.get_proposal(proposal_id))


@router.post("/proposals/{proposal_id}/accept")
async def accept_proposal(proposal_id: str, request: Request) -> JSONResponse:
    body = await _body(request)
    return await _answer(lambda ops: ops.accept_proposal(proposal_id, body))


@router.post("/proposals/{proposal_id}/reject")
async def reject_proposal(proposal_id: str) -> JSONResponse:
    return await _answer(lambda ops: ops.reject_proposal(proposal_id))


@router.post("/proposals/{proposal_id}/steps")
async def record_step(proposal_id: str, request: Request) -> JSONResponse:
    body = await _body(request)
    return await _answer(lambda ops: ops.record_step(proposal_id, body))


# Hermes runs every route of this router in the profile scope of a parameter
# named ``profile`` (a path parameter of that name, else the query) and answers
# a name it refuses itself, before the route runs, in its own error shape
# (``integrations/ergates-tests/contract/test_dashboard_api_mount.py``). The
# path parameter is ``name`` so this route still answers an unknown profile:
# 404 ``unknown_profile``, which the app reads as "the profile was deleted".
@router.post("/profiles/{name}/plugin")
async def enable_plugin(name: str) -> JSONResponse:
    return await _answer(lambda ops: ops.enable_plugin(name))


# The body goes through ``_body`` like every other JSON route: a request that is
# not sent as JSON reaches ``setup`` as ``None`` and is a 400 before any profile
# is touched. Named ``run_setup`` because ``setup`` is the module imported above.
@router.post("/setup")
async def run_setup(request: Request) -> JSONResponse:
    body = await _body(request)
    return await _answer(lambda ops: ops.setup(body))


# ``?scope=<name or *>``. Hermes refuses ``?profile=*`` before this route runs
# (``*`` is no profile name), so ``?profile=`` names one agent only.
@router.get("/attention/prefs")
async def get_prefs(request: Request) -> JSONResponse:
    scope = request.query_params.get("scope")
    return await _answer(
        lambda ops: ops.get_prefs(scope, named_profile=request.query_params.get("profile"))
    )


@router.put("/attention/prefs")
async def set_prefs(request: Request) -> JSONResponse:
    body = await _body(request)
    return await _answer(lambda ops: ops.set_prefs(body))


# Last, so a file that fails to import part way never leaves a sweep running.
_start_sweep()
