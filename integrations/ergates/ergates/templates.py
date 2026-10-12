"""Proposal templates: the role a proposed agent is provisioned from.

One JSON file per template, ``<hermes root>/ergates/templates/<template_id>.json``,
with exactly the ``ProposalTemplate`` fields::

    {"template_id": "bookkeeper", "soul": "...",
     "enabled_toolsets": ["file"], "enabled_mcp_servers": []}

The plugin ships them in its own ``templates/`` folder and installs them
(``ergates.setup.ensure_templates``, run by ``hermes serve`` on its first
request and by ``python -m ergates.install``); the server only reads the
installed copies. The accept route answers the template with the accepted
proposal, so the app configures the new profile from what the server holds,
never from what the model proposed.

``enabled_toolsets`` must name at least one toolset: ``profiles.configure``
treats an empty list as "remove the toolset pin", and the new agent would
get Hermes's default toolsets instead of none.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from .proposals import ProposalError

logger = logging.getLogger(__name__)

TEMPLATE_FIELDS = ("template_id", "soul", "enabled_toolsets", "enabled_mcp_servers")
# A template id is a file name: no separators, no leading dot.
_TEMPLATE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def load_template(directory: Path, template_id: Any) -> dict:
    """The ``ProposalTemplate`` of ``template_id`` in ``directory``.

    Raises ``ProposalError`` ``unknown_template`` (HTTP 422) when the id is not
    a safe file name, the file is missing, or it does not hold a valid
    template for that id. A broken file is logged by error class only.
    """
    if not isinstance(template_id, str) or not _TEMPLATE_ID_RE.fullmatch(template_id):
        raise ProposalError("the proposal names no known template", code="unknown_template")
    path = Path(directory) / f"{template_id}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ProposalError(f"there is no template {template_id!r}", code="unknown_template") from None
    except (OSError, ValueError) as exc:
        logger.warning("templates: %s cannot be read (%s)", path.name, type(exc).__name__)
        raise ProposalError(f"template {template_id!r} cannot be read", code="unknown_template") from None
    if not _is_template(data, template_id):
        logger.warning("templates: %s is not a valid template", path.name)
        raise ProposalError(f"template {template_id!r} is not valid", code="unknown_template")
    return {field: data[field] for field in TEMPLATE_FIELDS}


def _is_template(data: Any, template_id: str) -> bool:
    def strings(value: Any) -> bool:
        return isinstance(value, list) and all(isinstance(item, str) and item for item in value)

    return (
        isinstance(data, dict)
        and data.get("template_id") == template_id
        and isinstance(data.get("soul"), str)
        and strings(data.get("enabled_toolsets"))
        and bool(data["enabled_toolsets"])
        and strings(data.get("enabled_mcp_servers"))
    )
