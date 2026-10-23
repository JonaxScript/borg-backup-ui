"""Custom backup notification texts for Settings > Notifications."""

from __future__ import annotations

import sys
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_RUNTIME_LIB = Path(__file__).resolve().parents[1] / "runtime" / "lib"
if str(_RUNTIME_LIB) not in sys.path:
    sys.path.insert(0, str(_RUNTIME_LIB))

from inventory_store import (  # noqa: E402
    InventoryError,
    atomic_write_inventory,
    inventory_lock,
    read_inventory,
)
from notification_templates import (  # type: ignore  # noqa: E402
    COLLECTION_KEY,
    MAX_MESSAGE_LENGTH,
    MAX_TITLE_LENGTH,
    PLACEHOLDERS,
    SCHEMA_VERSION,
    TEMPLATE_EVENTS,
    parse_template_rows,
    template_store_path,
    template_values,
)
from notifications import (  # type: ignore  # noqa: E402
    BACKUP_NOTIFICATION_TITLES,
    build_backup_notification_context,
    build_backup_notification_message,
)


# Sample backup per event for the settings preview. The arguments mirror the
# notification producers in backup_job.py and notification_reminder_api.py.
_EXAMPLE_BACKUP = {
    "job_name": "Appdata",
    "timestamp": "2026-07-01 03:12:34",
    "repository": "/mnt/disks/backup_usb/borg-appdata",
    "backup_location": "usb",
}
_EXAMPLE_EVENTS: dict[str, dict[str, Any]] = {
    "backup_success": {
        "status": "Successful",
        "duration_seconds": 754,
        "archive_name": "appdata-2026-07-01_03-00-05",
        "exit_code": 0,
    },
    "backup_warning": {
        "status": "Warning",
        "duration_seconds": 801,
        "archive_name": "appdata-2026-07-01_03-00-05",
        "error_message": "Borg exited with warning status 1.",
        "exit_code": 1,
    },
    "backup_failed": {
        "status": "Error",
        "duration_seconds": 65,
        "error_message": "Repository could not be opened",
        "exit_code": 2,
    },
    "backup_skipped": {
        "status": "Skipped",
        "duration_seconds": 2,
        "error_message": "USB is not mounted",
        "exit_code": 0,
    },
    "backup_overdue": {
        "status": "Overdue",
        "duration_seconds": 0,
        "error_message": "Scheduled backup missed the expected run at 2026-07-01 03:00:00.",
    },
}


class NotificationTemplateError(ValueError):
    """Expose a localized validation code and safe interpolation parameters."""

    def __init__(self, code: str, message: str, **params: Any) -> None:
        super().__init__(message)
        self.api_code = "notification_template_" + code
        self.api_message_params = params


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _text(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise NotificationTemplateError("payload", "Notification texts must be strings")
    return value.strip()


def normalize_notification_templates(value: Any) -> list[dict[str, str]]:
    """Validate submitted custom texts and return the rows to store.

    Accepts ``{event: {"title": ..., "message": ...}}`` or a list of rows with
    an ``event`` field. Texts are trimmed, message line endings become ``\\n``
    and events with an empty title and message are dropped, which restores the
    default text. Raises NotificationTemplateError for unsupported or repeated
    events, non-string texts, multi-line titles and texts above the limits.
    """
    if isinstance(value, Mapping):
        items = list(value.items())
    elif isinstance(value, list):
        items = [(row.get("event") if isinstance(row, Mapping) else None, row) for row in value]
    else:
        raise NotificationTemplateError("payload", "Notification texts must be an object")

    rows: dict[str, dict[str, str]] = {}
    seen: set[str] = set()
    for raw_event, row in items:
        event = str(raw_event or "").strip()
        if event not in TEMPLATE_EVENTS:
            raise NotificationTemplateError("event", f"Unsupported notification text event: {event}")
        if event in seen:
            raise NotificationTemplateError("event", f"Duplicate notification text event: {event}")
        seen.add(event)
        if not isinstance(row, Mapping):
            raise NotificationTemplateError("payload", "Notification texts must be an object")
        title = _text(row.get("title"))
        message = _text(row.get("message")).replace("\r\n", "\n").replace("\r", "\n")
        if len(title.splitlines()) > 1 or len(title) > MAX_TITLE_LENGTH:
            raise NotificationTemplateError(
                "title",
                f"Notification titles must be one line with at most {MAX_TITLE_LENGTH} characters",
                max=MAX_TITLE_LENGTH,
            )
        if len(message) > MAX_MESSAGE_LENGTH:
            raise NotificationTemplateError(
                "message",
                f"Notification messages must not exceed {MAX_MESSAGE_LENGTH} characters",
                max=MAX_MESSAGE_LENGTH,
            )
        if title or message:
            rows[event] = {"event": event, "title": title, "message": message}
    return [rows[event] for event in TEMPLATE_EVENTS if event in rows]


def notification_template_examples() -> dict[str, dict[str, Any]]:
    """Return default title, message and placeholder values of a sample backup per event."""
    examples: dict[str, dict[str, Any]] = {}
    for event in TEMPLATE_EVENTS:
        details = {**_EXAMPLE_BACKUP, **_EXAMPLE_EVENTS[event]}
        exit_code = details.pop("exit_code", None)
        message_details = dict(details)
        if event == "backup_overdue":
            # Overdue reminders name only the repository in the default text.
            message_details.pop("backup_location")
        title = BACKUP_NOTIFICATION_TITLES[event]
        message = build_backup_notification_message(**message_details)
        values = build_backup_notification_context(**details, exit_code=exit_code)
        examples[event] = {
            "title": title,
            "message": message,
            "values": template_values(title, message, values),
        }
    return examples


def get_notification_template_settings(config: dict) -> dict[str, Any]:
    """Return custom texts, supported events, placeholders and preview examples.

    ``templates`` lists every supported event; empty fields use the default
    text. A malformed or unreadable store is reported as ``readable: False``
    with empty texts instead of raising, so other settings stay available and
    the UI can avoid overwriting the file.
    """
    templates = {event: {"title": "", "message": ""} for event in TEMPLATE_EVENTS}
    readable = True
    try:
        payload = read_inventory(
            template_store_path(config),
            collection_key=COLLECTION_KEY,
            schema_version=SCHEMA_VERSION,
        )
    except InventoryError:
        readable = False
    else:
        templates.update(parse_template_rows(payload.get(COLLECTION_KEY)))
    return {
        "templates": templates,
        "events": list(TEMPLATE_EVENTS),
        "placeholders": list(PLACEHOLDERS),
        "limits": {"title": MAX_TITLE_LENGTH, "message": MAX_MESSAGE_LENGTH},
        "examples": notification_template_examples(),
        "readable": readable,
    }


def save_notification_templates(config: dict, rows: list[dict[str, str]]) -> bool:
    """Persist rows from normalize_notification_templates() atomically.

    The store is written with owner-only permissions and only when its content
    changes, which avoids needless writes to the Unraid flash device. Returns
    True when the store was written. An existing store that cannot be read is
    not overwritten; the inventory error propagates to the caller.
    """
    path = template_store_path(config)
    with inventory_lock(path.parent):
        store = read_inventory(path, collection_key=COLLECTION_KEY, schema_version=SCHEMA_VERSION)
        if store.get(COLLECTION_KEY) == rows:
            return False
        store["schema_version"] = SCHEMA_VERSION
        store["updated_at"] = _utc_now()
        store[COLLECTION_KEY] = rows
        atomic_write_inventory(path, store)
    return True
