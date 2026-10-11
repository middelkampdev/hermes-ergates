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
mounting.

Hermes imports this file under its own module name, outside any package, so
the plugin folder is added to ``sys.path`` to import the ``ergates`` package.
The Hermes boundary (``tests/test_hermes_boundary.py``) allows Hermes
imports here; this file needs none, because every Hermes call goes through
``ergates.hermes_adapter``.
"""

import json
import logging
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

from ergates import hermes_adapter  # noqa: E402
from ergates.operations import Operations, Reply, internal_error, store_unavailable  # noqa: E402
from ergates.paths import hermes_root, store_path, templates_dir  # noqa: E402
from ergates.store import ControlStore, StoreError  # noqa: E402

logger = logging.getLogger("ergates.dashboard")

router = APIRouter()

_lock = threading.Lock()
_operations: Optional[Operations] = None


def operations() -> Operations:
    """The process's one ``Operations``, built on first use."""
    global _operations
    with _lock:
        if _operations is None:
            root = hermes_root()
            _operations = Operations(
                ControlStore(store_path(root)),
                cron=hermes_adapter.HermesCron(),
                profile_exists=hermes_adapter.profile_exists,
                plugin_enabled=hermes_adapter.plugin_enabled,
                enable_plugin=hermes_adapter.enable_plugin,
                check_schedule=hermes_adapter.check_schedule,
                check_prompt=hermes_adapter.check_prompt,
                check_gateway_lifecycle=hermes_adapter.check_gateway_lifecycle,
                templates=templates_dir(root),
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
# (``contract/test_dashboard_api_mount.py``). The path parameter is ``name`` so
# this route still answers an unknown profile: 404 ``unknown_profile``, which
# the app reads as "the profile was deleted".
@router.post("/profiles/{name}/plugin")
async def enable_plugin(name: str) -> JSONResponse:
    return await _answer(lambda ops: ops.enable_plugin(name))


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
