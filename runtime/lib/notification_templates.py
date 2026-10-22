"""
Custom notification texts for backup events.

Administrators can replace the default title and message of backup
notifications under Settings > Notifications. The texts are stored in
``<BACKUP_SCRIPTS_DIR>/config/notification-templates.json`` and apply to all
channels (Unraid, email and Apprise). Named ``{placeholder}`` tokens are
replaced with facts about the notified backup; unknown tokens stay unchanged,
so a saved text can always be rendered.
"""

from __future__ import annotations

import json
import logging
import re
import socket
from pathlib import Path
from typing import Any, Dict, Mapping, Tuple

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
COLLECTION_KEY = "templates"
STORE_FILENAME = "notification-templates.json"
MAX_TITLE_LENGTH = 200
MAX_MESSAGE_LENGTH = 2000

# Backup events whose title and message can be replaced, in display order.
TEMPLATE_EVENTS: Tuple[str, ...] = (
    "backup_success",
    "backup_warning",
    "backup_failed",
    "backup_skipped",
    "backup_overdue",
)

# Supported placeholder names, in display order.
PLACEHOLDERS: Tuple[str, ...] = (
    "job",
    "status",
    "time",
    "duration",
    "target",
    "location",
    "repository",
    "archive",
    "error",
    "exit_code",
    "hostname",
    "default_title",
    "default_message",
)

_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")


def template_store_path(config: Mapping[str, Any]) -> Path:
    """Return the custom text store below the configured data root."""
    root = str(config.get("BACKUP_SCRIPTS_DIR") or "/boot/config/borg-backup").strip()
    return Path(root or "/boot/config/borg-backup") / "config" / STORE_FILENAME


def read_notification_templates(config: Mapping[str, Any]) -> Dict[str, Dict[str, str]]:
    """Return saved custom texts by event for notification delivery.

    A missing store yields ``{}``. An unreadable or malformed store is logged
    and also yields ``{}``, so notifications fall back to the default texts.
    """
    path = template_store_path(config)
    try:
        if not path.is_file():
            return {}
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        logger.warning("Custom notification texts are not readable; using default texts: %s", exc)
        return {}
    rows = payload.get(COLLECTION_KEY) if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        logger.warning("Custom notification texts have an invalid format; using default texts: %s", path)
        return {}
    return parse_template_rows(rows)


def parse_template_rows(rows: Any) -> Dict[str, Dict[str, str]]:
    """Return usable custom texts by event from stored rows.

    Rows for unsupported events or without text are ignored, and texts are
    clipped to the supported lengths. Never raises for malformed rows.
    """
    templates: Dict[str, Dict[str, str]] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        event = str(row.get("event") or "").strip()
        if event not in TEMPLATE_EVENTS:
            continue
        title = row.get("title") if isinstance(row.get("title"), str) else ""
        message = row.get("message") if isinstance(row.get("message"), str) else ""
        title = title.strip()[:MAX_TITLE_LENGTH]
        message = message.strip()[:MAX_MESSAGE_LENGTH]
        if title or message:
            templates[event] = {"title": title, "message": message}
    return templates


def render_template_text(text: str, values: Mapping[str, str]) -> str:
    """Replace known ``{name}`` placeholders in one pass and keep unknown ones.

    Inserted values are not scanned again, so job names or error messages that
    contain braces cannot inject further placeholders.
    """
    def _replace(match: re.Match) -> str:
        name = match.group(1)
        return str(values[name]) if name in values else match.group(0)

    return _PLACEHOLDER_RE.sub(_replace, str(text or ""))


def template_values(title: str, message: str, values: Mapping[str, Any]) -> Dict[str, str]:
    """Return values for every supported placeholder.

    ``values`` holds facts about the notified backup; missing facts become empty
    strings. The default title and message of the event and the server host
    name are added here.
    """
    result = {name: "" for name in PLACEHOLDERS}
    for name, value in values.items():
        if name in result:
            result[name] = "" if value is None else str(value)
    result["hostname"] = _hostname()
    result["default_title"] = str(title or "")
    result["default_message"] = str(message or "")
    return result


def render_notification_text(
    config: Mapping[str, Any],
    event_type: str,
    title: str,
    message: str,
    values: Mapping[str, Any],
) -> Tuple[str, str]:
    """Return the title and message to send, using a saved custom text if any.

    Empty template fields, and fields that render to empty text, keep the
    default text. Rendered titles are joined into one line because email
    subjects and Unraid notification subjects cannot contain line breaks.
    """
    template = read_notification_templates(config).get(str(event_type or "").strip())
    if not template:
        return title, message
    context = template_values(title, message, values)
    custom_title = " ".join(
        part.strip() for part in render_template_text(template["title"], context).splitlines() if part.strip()
    )
    custom_message = render_template_text(template["message"], context).strip()
    return custom_title or title, custom_message or message


def _hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return ""
