"""What the mobile app shares with the contract tests, in JSON files both read: the Hermes texts the app
matches, and the commands its Finish screen shows."""

from __future__ import annotations

import json
from pathlib import Path

MOBILE_SRC = Path(__file__).resolve().parents[2] / "apps" / "mobile" / "src"
MESSAGES_FILE = MOBILE_SRC / "gateway" / "real" / "hermes-plugin-messages.json"
COMMANDS_FILE = MOBILE_SRC / "features" / "server" / "manual-commands.json"


def hermes_plugin_messages() -> dict:
    """``pluginNotFound`` (the 404 detail of a plugin Hermes does not serve) and ``install``
    (an install failure code -> the prefixes of the 400 details that mean it)."""
    return json.loads(MESSAGES_FILE.read_text(encoding="utf-8"))


def manual_commands() -> dict:
    """The command templates the Finish screen fills in: ``install`` and ``update`` (``{identifier}``,
    ``{commit}``) and ``enable`` (``{name}``)."""
    return json.loads(COMMANDS_FILE.read_text(encoding="utf-8"))
