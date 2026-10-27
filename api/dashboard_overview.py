"""Bounded dashboard statistics from saved backup outcomes, without Borg I/O."""

import json
import math
from datetime import datetime, timedelta
from pathlib import Path

OUTCOMES = ("success", "warning", "error", "skipped", "cancelled", "unknown")
LOCATIONS = ("all", "local", "usb", "smb", "storagebox")


def get_dashboard_overview(config, days=30, location="all", *, now=None):
    """Aggregate 7/30/90 local calendar days for existing backup jobs.

    Raises ValueError for invalid filters. Unreadable/malformed reports are ignored.
    Repository samples use current job assignments (old reports have no repository
    ID), count each repository once, and carry the latest real sample forward.
    Missing/nonpositive sizes stay unknown; no deduplicated-size fallback is used.
    No repositories are opened and no files are changed.
    """
    from jobs_api import discover_jobs, resolve_scripts_dir, resolve_data_root
    from repository_context import load_job_metadata

    if days not in (7, 30, 90) or location not in LOCATIONS:
        raise ValueError("Expected days=7, 30 or 90 and a known location")
    now = now or datetime.now().astimezone()
    if now.tzinfo is None:
        now = now.astimezone()
    start = now.date() - timedelta(days=days - 1)
    jobs = {job.key: job for job in discover_jobs(resolve_scripts_dir(config), resolve_data_root(config))
            if not job.is_utility and (location == "all" or job.location == location)}
    repositories = {}
    for key in jobs:
        try:
            metadata = load_job_metadata(config, key)
            repository = str(metadata.get("repository_key") or "")
            if repository:
                repositories[key] = repository
        except (OSError, ValueError):
            continue
    points = {str(start + timedelta(days=i)): {"date": str(start + timedelta(days=i)),
              **dict.fromkeys(OUTCOMES, 0)} for i in range(days)}
    records = []
    for path in sorted(Path(config["STATUS_DIR"]).glob("*.status")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict) or raw.get("job_id") not in jobs:
                continue
            stamp = datetime.fromisoformat(str(raw.get("timestamp", "")))
            stamp = stamp.astimezone(now.tzinfo)
            if stamp > now:
                continue
            records.append((stamp, path.name, {key: raw.get(key) for key in
                            ("job_id", "run_id", "status", "duration_seconds", "repository_size")}))
        except (OSError, ValueError, UnicodeError, TypeError, OverflowError):
            continue
    records.sort(key=lambda row: (row[0], row[1]))
    samples = {}
    seen = set()
    durations = []
    cursor = 0
    for day, point in points.items():
        while cursor < len(records) and str(records[cursor][0].date()) <= day:
            stamp, filename, raw = records[cursor]
            cursor += 1
            run_id = raw.get("run_id")
            identity = (raw["job_id"], run_id if isinstance(run_id, str) and run_id else stamp.isoformat())
            if identity in seen:
                continue
            seen.add(identity)
            if str(stamp.date()) == day:
                status = raw.get("status")
                point[status if status in OUTCOMES else "unknown"] += 1
                duration = raw.get("duration_seconds")
                if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration) and duration >= 0:
                    durations.append(duration)
            size = raw.get("repository_size")
            repo = repositories.get(raw["job_id"])
            if repo and isinstance(size, (int, float)) and not isinstance(size, bool) and math.isfinite(size) and size > 0:
                samples[repo] = {"bytes": int(size), "timestamp": stamp.isoformat()}
        point["repository_bytes"] = sum(sample["bytes"] for sample in samples.values()) if samples else None
        point["measured_repositories"] = len(samples)
    counts = {status: sum(point[status] for point in points.values()) for status in OUTCOMES}
    denominator = counts["success"] + counts["warning"] + counts["error"]
    return {"days": days, "location": location, "from": str(start), "to": str(now.date()),
            "counts": counts, "run_count": sum(counts.values()),
            "success_rate": counts["success"] / denominator * 100 if denominator else None,
            "average_duration_seconds": sum(durations) / len(durations) if durations else None,
            "repository_count": len(set(repositories.values())),
            "unassigned_jobs": len(jobs) - len(repositories),
            "repository_last_sample": max((sample["timestamp"] for sample in samples.values()), default=None),
            "daily": list(points.values())}
