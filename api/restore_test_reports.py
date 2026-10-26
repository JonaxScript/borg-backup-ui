"""Atomic latest-result updates with immutable restore-test run evidence."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import uuid


def _atomic_write(path: Path, text: str) -> None:
    """Replace a plugin-owned result after flushing its sibling temporary file."""
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def save_report(latest: Path, data: dict) -> None:
    """Archive the previous result before replacing it; retain every new run.

    Existing bytes, including unreadable legacy reports, are preserved by digest.
    Writes fail if history cannot be retained, so a retry cannot discard evidence.
    The latest file remains compatible with existing status/notification readers.
    """
    directory = latest.parent / "runs" / str(data["job_id"])
    directory.mkdir(parents=True, exist_ok=True)
    if latest.exists():
        previous = latest.read_bytes()
        old = directory / f"{hashlib.sha256(previous).hexdigest()}.test"
        if not old.exists():
            with old.open("xb") as handle:
                handle.write(previous)
                handle.flush()
                os.fsync(handle.fileno())
    text = json.dumps(data, indent=2, ensure_ascii=False)
    archive = directory / f"{hashlib.sha256(text.encode()).hexdigest()}.test"
    _atomic_write(archive, text)
    _atomic_write(latest, text)
