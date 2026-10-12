"""Install-wide Ergates settings: the push settings every profile shares.

One control store serves every profile of an install, and so do the push
settings. Every hook, in every profile, and ``python -m ergates.flush`` read
``ntfy.server``, ``ntfy.topic`` and ``ntfy.connection_id`` from the Hermes
root's ``config.yaml`` (the default profile's config,
``<hermes root>/config.yaml``) at ``plugins.entries.ergates.settings.ntfy.*``.
A profile's own ``config.yaml`` keeps only per-profile settings, such as
``attention.completed_platforms``.

The ntfy token is a Hermes plugin secret: ``plugin.yaml`` declares
``ntfy.token`` in its ``config_schema`` as ``type: secret`` stored as
``ERGATES_NTFY_TOKEN`` (:data:`TOKEN_ENV`), so Hermes keeps it in ``.env``,
and the plugin reads it through Hermes from the root's ``.env``
(:func:`ergates.hermes_adapter.install_secret`), never from a file it opens
itself. A ``ntfy.token`` still in ``config.yaml`` is ignored, with a warning
that names the key and the variable, never the value.

The same section holds ``sweep.interval_seconds``, how often ``hermes serve``
runs the periodic sweep (:func:`sweep_interval`, :mod:`ergates.sweep`).

Values are read as written: PyYAML parses the file, and ``${VAR}``
references are not expanded. A value that still contains ``${`` after
loading is refused loudly -- logged (the setting key only, never the value)
and never sent to ntfy -- and treated as unset, so an owner who pasted a
template reference by mistake gets a skipped push instead of a literal
``${...}`` string on the wire. PyYAML is imported lazily; it ships with the
Hermes runtime and is a test dependency of this package, never a runtime
dependency.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Mapping

from . import hermes_adapter
from .delivery import NtfySettings, is_http_url, ntfy_settings
from .sweep import SWEEP_INTERVAL_SECONDS

logger = logging.getLogger(__name__)

PLUGIN_ID = "ergates"
SETTING_KEYS = ("server", "topic", "connection_id")
# Its own name, never NTFY_TOKEN or NTFY_TOPIC: Hermes's bundled ntfy platform
# reads those and takes every message on its topic as user input.
TOKEN_ENV = "ERGATES_NTFY_TOKEN"

_UNEXPANDED_MARKER = "${"


def settings_from_config(config: Any, plugin_id: str = PLUGIN_ID) -> Dict[str, str]:
    """Extract ``plugins.entries.<plugin_id>.settings.ntfy.*`` from a parsed config.

    Missing keys come back absent rather than empty, and a non-mapping
    anywhere along the path counts as absent rather than raising: a sweep
    or a hook must not die on a config typo. A value that still contains
    ``${`` (an unexpanded template reference) comes back absent too, logged
    by key name only, never by value. A ``token`` key is ignored, with one
    warning that says where the token goes now.
    """
    node = _ntfy_node(config, plugin_id)
    if node is None:
        return {}
    if "token" in node:
        logger.warning(
            "ergates: plugins.entries.%s.settings.ntfy.token in config.yaml is ignored; "
            "set %s in the Hermes root's .env instead", plugin_id, TOKEN_ENV,
        )
    settings: Dict[str, str] = {}
    for key in SETTING_KEYS:
        value = _text(node.get(key))
        if value is None:
            continue
        if _UNEXPANDED_MARKER in value:
            logger.warning(
                "ergates: push setting %r still contains an unexpanded \"${\" reference; skipped", key,
            )
            continue
        settings[key] = value
    return settings


def _ntfy_node(config: Any, plugin_id: str) -> Mapping | None:
    """The ``plugins.entries.<plugin_id>.settings.ntfy`` mapping of a parsed config, or ``None``."""
    node: Any = config
    for segment in ("plugins", "entries", plugin_id, "settings", "ntfy"):
        if not isinstance(node, Mapping) or segment not in node:
            return None
        node = node[segment]
    return node if isinstance(node, Mapping) else None


def _text(value: Any) -> str | None:
    """A setting's text without surrounding blanks; ``None`` unless it is a non-blank string."""
    return value.strip() or None if isinstance(value, str) else None


def load_settings(root: Path, plugin_id: str = PLUGIN_ID) -> Dict[str, str]:
    """The ``ntfy.*`` settings in ``<root>/config.yaml``, plus ``token`` when the install secret
    :data:`TOKEN_ENV` is set; empty when the file is missing."""
    config = _root_config(root)
    if config is None:
        logger.info("ergates: no config at %s; push settings unavailable", Path(root) / "config.yaml")
        return {}
    settings = settings_from_config(config, plugin_id)
    token = hermes_adapter.install_secret(TOKEN_ENV)
    if token:
        settings["token"] = token
    return settings


def push_status(root: Path, plugin_id: str = PLUGIN_ID) -> Dict[str, bool]:
    """What the install has for push, as booleans for ``GET /health``; never a value.

    ``configured``: ``ntfy.server`` and ``ntfy.topic`` are both set in the
    root's ``config.yaml`` and the server is an ``http://`` or ``https://``
    URL, the rule :func:`push_settings` applies, so push is on.
    ``token_set``: the install secret :data:`TOKEN_ENV` has a value.
    ``legacy_config_token``: a ``ntfy.token`` key still sits in
    ``config.yaml``, which is ignored (see :func:`settings_from_config`).

    Logs nothing, unlike :func:`load_settings`, because the app asks for
    this on every health check. Raises what the reads raise: a
    ``config.yaml`` that cannot be parsed, a Hermes failure.
    """
    node = _ntfy_node(_root_config(root), plugin_id) or {}
    usable = {key: _text(node.get(key)) for key in ("server", "topic")}
    configured = all(value is not None and _UNEXPANDED_MARKER not in value for value in usable.values())
    return {
        "configured": configured and is_http_url(usable["server"]),
        "token_set": hermes_adapter.install_secret(TOKEN_ENV) is not None,
        "legacy_config_token": "token" in node,
    }


def sweep_interval(root: Path, plugin_id: str = PLUGIN_ID) -> int:
    """Seconds between two passes of the periodic sweep: ``plugins.entries.<plugin_id>.settings.sweep.interval_seconds``
    in ``<root>/config.yaml``. ``0`` turns the sweep off.

    Unset, the interval is :data:`~ergates.sweep.SWEEP_INTERVAL_SECONDS`. A
    value that is not a whole number of 0 or more, or a ``config.yaml`` that
    cannot be read, gives that default too, with a warning that names the
    key or the error class, never the value or the file's text: a config
    typo must not stop the sweep.
    """
    path = ("plugins", "entries", plugin_id, "settings", "sweep", "interval_seconds")
    try:
        value: Any = _root_config(root)
    except Exception as exc:
        logger.warning("ergates: config.yaml unreadable (%s); the sweep runs every %d s", type(exc).__name__,
                       SWEEP_INTERVAL_SECONDS)
        return SWEEP_INTERVAL_SECONDS
    for segment in path:
        if not isinstance(value, Mapping) or segment not in value:
            return SWEEP_INTERVAL_SECONDS
        value = value[segment]
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        logger.warning("ergates: %s must be a whole number of seconds, 0 or more; the sweep runs every %d s",
                       ".".join(path), SWEEP_INTERVAL_SECONDS)
        return SWEEP_INTERVAL_SECONDS
    return value


def _root_config(root: Path) -> Any:
    """``<root>/config.yaml`` as PyYAML parses it (``{}`` for an empty file), or ``None`` when it is missing."""
    config_path = Path(root) / "config.yaml"
    if not config_path.exists():
        return None
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover - PyYAML ships with the Hermes runtime
        raise RuntimeError(
            "ergates needs PyYAML to read config.yaml -- run it inside the Hermes runtime"
        ) from exc
    with open(config_path, "r", encoding="utf-8") as handle:
        return yaml.safe_load(handle) or {}


def push_settings(root: Path) -> NtfySettings | None:
    """The install's push settings, or ``None`` (push off) unless ``ntfy.server`` and ``ntfy.topic`` are set."""
    return ntfy_settings(load_settings(root))
