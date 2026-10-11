"""Serve Hermes's dashboard app on a free loopback port, in a process of its own.

``conftest.py``'s ``serve_hermes`` runs this file as a child process for a
test that needs a dashboard on its own Hermes root: ``hermes_cli.web_server``
mounts plugin routes per process, starting at import, so the session's ``web``
cannot be moved to another root. The parent sets HOME, HERMES_HOME, the
dashboard session token and HERMES_SOURCE; this prints the port, then serves
until it is stopped.

The app is imported the way ``hermes serve`` loads it and runs without its
lifespan, like the session's ``web`` (a ``TestClient`` used without ``with``).
The lifespan starts Hermes's background services (hosted rooms, the gateway
warm-up, cron for a Desktop-owned backend); the plugin routes, their auth and
the hot mount do not depend on them. ``bound_host`` is set the way
``start_server`` sets it, so Hermes's Host check applies.

The test runner's environment has this checkout's ``ergates`` package
installed in editable mode (``uv run``). A server has no such package: the
plugin's ``dashboard/api.py`` imports ``ergates`` from the plugin's own folder.
So this drops that import hook and stops when anything named ``ergates`` can
still be imported, and every route it serves runs the plugin copy that Hermes
installed or linked into the root.
"""

import importlib.util
import os
import socket
import sys

sys.dont_write_bytecode = True  # never write .pyc files into the pinned checkout
sys.meta_path[:] = [finder for finder in sys.meta_path
                    if not str(getattr(finder, "__module__", "")).startswith("__editable___ergates_")]
if importlib.util.find_spec("ergates") is not None:
    sys.exit(f"hermes_serve.py: an ergates package is importable outside the plugin: {importlib.util.find_spec('ergates')}")
sys.path.insert(0, os.environ["HERMES_SOURCE"])

import uvicorn  # noqa: E402
from hermes_cli.web_server import app  # noqa: E402

app.state.bound_host = "127.0.0.1"
listener = socket.create_server(("127.0.0.1", 0))
print(listener.getsockname()[1], flush=True)
uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="warning")).run(sockets=[listener])
