"""Install-wide Ergates settings: the push settings every profile shares.

One control store serves every profile of an install, and so do the push
settings. Every hook, in every profile, and ``python -m ergates.flush`` read
them from the Hermes root's ``config.yaml`` (the default profile's config,
``<hermes root>/config.yaml``) at ``plugins.entries.ergates.settings.ntfy.*``.
A profile's own ``config.yaml`` keeps only per-profile settings, such as
``attention.completed_platforms``.

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

from .delivery import NtfySettings, ntfy_settings
from .sweep import SWEEP_INTERVAL_SECONDS

logger = logging.getLogger(__name__)

PLUGIN_ID = "ergates"
SETTING_KEYS = ("server", "topic", "token", "connection_id")

_UNEXPANDED_MARKER = "${"


def settings_from_config(config: Any, plugin_id: str = PLUGIN_ID) -> Dict[str, str]:
    """Extract ``plugins.entries.<plugin_id>.settings.ntfy.*`` from a parsed config.

    Missing keys come back absent rather than empty, and a non-mapping
    anywhere along the path counts as absent rather than raising: a sweep
    or a hook must not die on a config typo. A value that still contains
    ``${`` (an unexpanded template reference) comes back absent too, logged
    by key name only, never by value.
    """
    node: Any = config
    for segment in ("plugins", "entries", plugin_id, "settings", "ntfy"):
        if not isinstance(node, Mapping) or segment not in node:
            return {}
        node = node[segment]
    if not isinstance(node, Mapping):
        return {}
    settings: Dict[str, str] = {}
    for key in SETTING_KEYS:
        value = node.get(key)
        if not isinstance(value, str):
            continue
        value = value.strip()
        if not value:
            continue
        if _UNEXPANDED_MARKER in value:
            logger.warning(
                "ergates: push setting %r still contains an unexpanded \"${\" reference; skipped", key,
            )
            continue
        settings[key] = value
    return settings


def load_settings(root: Path, plugin_id: str = PLUGIN_ID) -> Dict[str, str]:
    """The ``ntfy.*`` settings in ``<root>/config.yaml``; empty when the file is missing."""
    config = _root_config(root)
    if config is None:
        logger.info("ergates: no config at %s; push settings unavailable", Path(root) / "config.yaml")
        return {}
    return settings_from_config(config, plugin_id)


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
