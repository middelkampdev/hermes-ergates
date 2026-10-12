"""The Hermes texts the mobile app matches, kept in one JSON file the app and the contract tests share."""

from __future__ import annotations

import json
from pathlib import Path

MESSAGES_FILE = Path(__file__).resolve().parents[2] / "apps" / "mobile" / "src" / "gateway" / "real" / "hermes-plugin-messages.json"


def hermes_plugin_messages() -> dict:
    """``pluginNotFound`` (the 404 detail of a plugin Hermes does not serve) and ``install``
    (an install failure code -> the prefixes of the 400 details that mean it)."""
    return json.loads(MESSAGES_FILE.read_text(encoding="utf-8"))
