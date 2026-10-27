"""Atomic latest-result updates with immutable restore-test run evidence."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import uuid
from datetime import datetime


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


def report_cancelled(data: dict) -> bool:
    """Identify explicit cancellation without treating real verification failures as aborts."""
    return data.get("failure_code") == "RT_CANCELLED" or data.get("test_result") == "cancelled"


def verification_evidence(latest: Path, data: dict) -> tuple[dict, Path]:
    """Return the latest conclusive report behind an explicitly cancelled attempt.

    Reads retained reports only after cancellation; never writes or extends validity.
    Skipped/cancelled attempts do not replace evidence. A newer failure blocks older
    success; failures win same-second ties. Missing, unreadable or undated history
    yields no proof rather than guessing from archive file creation times. Retains
    only the newest candidate in memory while scanning.
    """
    if not report_cancelled(data):
        return data, latest
    try:
        cutoff = datetime.strptime(data["test_date"], "%Y-%m-%d %H:%M:%S")
        newest = None
        for path in (latest.parent / "runs" / latest.stem).glob("*.test"):
            report = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(report, dict):
                return {}, latest
            if report.get("job_id", latest.stem) != latest.stem:
                continue
            if report_cancelled(report) or report.get("test_result") == "skipped":
                continue
            timestamp = datetime.strptime(report["test_date"], "%Y-%m-%d %H:%M:%S")
            if timestamp <= cutoff:
                candidate = (timestamp, report.get("test_result") != "success", path.name, report, path)
                if newest is None or candidate[:3] > newest[:3]:
                    newest = candidate
        if newest:
            *_, report, path = newest
            return report, path
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return {}, latest
