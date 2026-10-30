"""Cooperative control state for long-running backup jobs."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import signal
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


CONTROL_ROOT = Path("/run/borg-backup-ui/jobs")
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,96}$")
_JOB_KEY_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_CREAT | os.O_TRUNC | os.O_WRONLY
    fd = os.open(tmp, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _safe_component(value: str, pattern: re.Pattern[str], label: str) -> str:
    clean = str(value or "").strip()
    if not pattern.fullmatch(clean):
        raise ValueError(f"Invalid {label}")
    return clean


class JobControl:
    """Manage runner-owned phase state and an API-owned cancellation marker.

    Constructing an instance validates job/run IDs and creates a private run
    directory. An attached process receives SIGINT once when cancellation is
    requested; callers must detach it when the process completes.
    """

    def __init__(self, job_key: str, run_id: str, root: Path = CONTROL_ROOT) -> None:
        self.job_key = _safe_component(job_key, _JOB_KEY_RE, "job key")
        self.run_id = _safe_component(run_id, _RUN_ID_RE, "run id")
        self.run_dir = Path(root) / self.run_id
        self.state_file = self.run_dir / "state.json"
        self.cancel_file = self.run_dir / "cancel.request.json"
        self._process_lock = threading.Lock()
        self._active_process = None
        self._last_borg_progress_write = float("-inf")
        self._processing_samples = deque(maxlen=64)
        self._monitor_stop = threading.Event()
        self._monitor_thread: Optional[threading.Thread] = None
        self.run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.run_dir.chmod(0o700)
        except OSError:
            pass

    def update_phase(
        self,
        phase: str,
        *,
        cancel_allowed: bool,
        cancellation_deferred: bool = False,
        message_key: str = "",
        finished: bool = False,
        exit_code: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Persist phase/cancellation policy and return the state.

        Starts transient timing for each Borg command. Other phases and finished
        runs clear progress while preserving command and configured job steps.
        In-memory detail counters reset at each phase boundary.
        Writes may raise OSError.
        """
        previous = read_control_state(self.run_id, self.run_dir.parent)
        data: Dict[str, Any] = {
            "group_id": os.environ.get("BORG_UI_GROUP_ID", ""),
            "group_name": os.environ.get("BORG_UI_GROUP_NAME", ""),
            "group_run_id": os.environ.get("BORG_UI_GROUP_RUN_ID", ""),
            "log_file": os.environ.get("BORG_UI_GROUP_LOG_FILE", ""),
            "schema_version": 1,
            "job_key": self.job_key,
            "run_id": self.run_id,
            "pid": os.getpid(),
            "phase": str(phase),
            "cancel_allowed": bool(cancel_allowed),
            "cancellation_deferred": bool(cancellation_deferred),
            "cancel_requested": self.is_cancel_requested(),
            "message_key": str(message_key or ""),
            "started_at": str(previous.get("started_at") or _utc_now()),
            "updated_at": _utc_now(),
            "finished": bool(finished),
            "exit_code": exit_code,
        }
        data["job_steps"] = previous.get("job_steps", [])
        self._borg_details = {}
        self._processing_samples.clear()
        data["borg_steps"] = previous.get("borg_steps", {
            name: {"status": "pending"} for name in ("create", "prune", "compact", "check")
        })
        # A phase transition must never retain the preceding process's progress.
        data["borg_progress"] = ({
            "phase": phase, "started_at": time.time(), "updated_at": None, "percent": None,
        } if phase in {"borg_create", "borg_prune", "borg_compact", "borg_check"} and not finished else None)
        self._last_borg_progress_write = float("-inf")
        _atomic_json(self.state_file, data)
        return data

    def update_job_steps(self, steps: list) -> None:
        """Persist ordered configured workflow steps; phase updates preserve them."""
        state = read_control_state(self.run_id, self.run_dir.parent)
        state["job_steps"] = copy.deepcopy(steps)
        _atomic_json(self.state_file, state)

    def update_borg_details(self, details: dict) -> None:
        """Accumulate numeric command results in memory, without per-line disk I/O."""
        if not hasattr(self, "_borg_details"):
            self._borg_details = {}
        self._borg_details.update({key: value for key, value in details.items()
                                   if type(value) is int and value >= 0})

    def get_borg_details(self) -> dict:
        """Return the current command's counters, reset on phase transitions."""
        return dict(getattr(self, "_borg_details", {}))

    def update_borg_steps(self, steps: Dict[str, Any]) -> None:
        """Persist the runner's command ledger separately from transient progress.

        Called at command boundaries, including skips; phase updates preserve it.
        Raises OSError on write failures, which callers must keep non-fatal.
        """
        state = read_control_state(self.run_id, self.run_dir.parent)
        state["borg_steps"] = copy.deepcopy(steps)
        _atomic_json(self.state_file, state)

    def update_borg_progress(self, event: Optional[Dict[str, Any]]) -> None:
        """Persist transient Borg process progress with throttled status writes.

        Accepts Borg progress events; None clears progress immediately. Only
        finite counters are exposed, never Borg messages or repository paths.
        Operation changes and step completion bypass throttling. A finished
        step is indeterminate until another step or the process result arrives.
        Archive events expose only non-negative file/size counters, not paths.
        Create events also expose a rolling 30-second logical-byte processing
        rate and, with a valid optional source estimate, approximate progress
        and remaining create time. At least two seconds of samples are required.
        Writes can raise OSError; callers must keep progress failures non-fatal.
        """
        state = read_control_state(self.run_id, self.run_dir.parent)
        progress = state.get("borg_progress")
        if state.get("phase") not in {"borg_create", "borg_prune", "borg_compact", "borg_check"} or state.get("finished") or not isinstance(progress, dict):
            return
        now = time.monotonic()
        if event is None:
            state["borg_progress"] = None
            self._processing_samples.clear()
        else:
            kind = event.get("type")
            if kind == "archive_progress" and state["phase"] != "borg_create":
                return
            operation = event.get("operation")
            if not isinstance(operation, int) or isinstance(operation, bool):
                operation = None
            finished = event.get("finished") is True
            if (not finished and operation == progress.get("operation")
                    and now - self._last_borg_progress_write < 1.0):
                return
            percent = None
            current, total = event.get("current"), event.get("total")
            if (event.get("type") == "progress_percent" and not finished
                    and type(current) in (int, float) and type(total) in (int, float)):
                try:
                    if math.isfinite(current) and math.isfinite(total) and 0 <= current <= total and total > 0:
                        percent = round(100 * (current / total), 1)
                except (OverflowError, ValueError):
                    pass
            if state["phase"] == "borg_create":
                percent = None
                self._update_source_estimate(progress, event.get("source_estimate"))
            if kind == "archive_progress":
                for key in ("nfiles", "original_size", "compressed_size", "deduplicated_size"):
                    value = event.get(key)
                    if type(value) is int and 0 <= value <= 2**53 - 1:
                        progress[key] = value
                if finished:
                    for key in ("nfiles", "original_size", "compressed_size", "deduplicated_size"):
                        progress.pop(key, None)
                self._update_processing_metrics(progress, event, now, finished)
            progress.update(percent=percent, operation=operation, updated_at=time.time())
        state["updated_at"] = _utc_now()
        _atomic_json(self.state_file, state)
        self._last_borg_progress_write = now

    @staticmethod
    def _update_source_estimate(progress: dict, result: Any) -> None:
        """Copy allowlisted scan status and complete logical bytes, never errors."""
        if not isinstance(result, dict):
            return
        status = result.get("status")
        if not isinstance(status, str) or status not in {"scanning", "ready", "unsupported", "failed", "timed_out", "cancelled"}:
            return
        progress["source_size_status"] = status
        progress.pop("estimated_total_bytes", None)
        value = result.get("bytes")
        if status == "ready":
            if type(value) is int and 0 <= value <= 2**53 - 1:
                progress["estimated_total_bytes"] = value
            else:
                progress["source_size_status"] = "failed"

    def _update_processing_metrics(self, progress: dict, event: dict, now: float, finished: bool) -> None:
        """Derive create-only estimates; reset on invalid/regressing counters.

        Byte samples use monotonic time and cover at most 30 seconds. Equal
        counters yield a measured zero rate. Estimates never declare completion
        and are hidden when the source total has been exceeded.
        """
        for key in ("processing_speed_bytes_per_sec", "rate_updated_at", "estimated_percent", "estimated_remaining_seconds"):
            progress.pop(key, None)
        current = event.get("original_size")
        if finished or type(current) is not int or not 0 <= current <= 2**53 - 1:
            self._processing_samples.clear()
            if finished:
                progress.pop("estimated_total_bytes", None)
                progress.pop("source_size_status", None)
            return
        samples = self._processing_samples
        if samples and (current < samples[-1][1] or now <= samples[-1][0]):
            samples.clear()
        while samples and samples[0][0] < now - 30:
            samples.popleft()
        samples.append((now, current))
        speed = None
        if len(samples) > 1 and now - samples[0][0] >= 2:
            speed = (current - samples[0][1]) / (now - samples[0][0])
            progress["processing_speed_bytes_per_sec"] = speed
            progress["rate_updated_at"] = time.time()
        total = progress.get("estimated_total_bytes")
        if type(total) is not int or total <= 0:
            return
        if current > total:
            progress["source_size_status"] = "outgrown"
            return
        progress["estimated_percent"] = min(99.9, round(100 * current / total, 1))
        if speed and current < total:
            remaining = (total - current) / speed
            if remaining <= 2**53 - 1:
                progress["estimated_remaining_seconds"] = round(remaining)

    def is_cancel_requested(self) -> bool:
        return self.cancel_file.is_file()

    def attach_process(self, process: Any) -> None:
        """Monitor a live subprocess for cancellation and send one SIGINT."""
        with self._process_lock:
            self._active_process = process
        self._monitor_stop.clear()

        def _monitor() -> None:
            signalled = False
            while not self._monitor_stop.wait(0.2):
                if not self.is_cancel_requested() or signalled:
                    continue
                with self._process_lock:
                    current = self._active_process
                if current is None or current.poll() is not None:
                    continue
                try:
                    current.send_signal(signal.SIGINT)
                    signalled = True
                except (OSError, ProcessLookupError):
                    return

        self._monitor_thread = threading.Thread(
            target=_monitor,
            daemon=True,
            name=f"cancel-monitor-{self.job_key}",
        )
        self._monitor_thread.start()

    def detach_process(self) -> None:
        """Stop the cancellation monitor and forget the attached process."""
        self._monitor_stop.set()
        if self._monitor_thread is not None:
            self._monitor_thread.join(timeout=1.0)
        self._monitor_thread = None
        with self._process_lock:
            self._active_process = None


def read_control_state(run_id: str, root: Path = CONTROL_ROOT) -> Dict[str, Any]:
    """Read a run's control JSON, returning an empty mapping if unavailable.

    Raises ValueError for an invalid run ID. A present cancellation marker is
    reflected in the returned state even if the JSON has not been updated.
    """
    safe_run_id = _safe_component(run_id, _RUN_ID_RE, "run id")
    path = Path(root) / safe_run_id / "state.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    if (path.parent / "cancel.request.json").is_file():
        data["cancel_requested"] = True
    return data


def request_cancel(
    job_key: str,
    run_id: str,
    *,
    requested_by: str = "",
    root: Path = CONTROL_ROOT,
) -> Dict[str, Any]:
    """Request cancellation by creating an idempotent marker for an active run.

    Raises FileNotFoundError for an inactive run, ValueError for mismatched IDs,
    or RuntimeError when its current phase forbids cancellation. Returns the
    control state marked as cancellation requested.
    """
    safe_job_key = _safe_component(job_key, _JOB_KEY_RE, "job key")
    safe_run_id = _safe_component(run_id, _RUN_ID_RE, "run id")
    state = read_control_state(safe_run_id, root)
    if not state or state.get("finished"):
        raise FileNotFoundError("The backup run is no longer active")
    if str(state.get("job_key") or "") != safe_job_key:
        raise ValueError("The run does not belong to this job")
    if not bool(state.get("cancel_allowed")):
        raise RuntimeError("Cancellation is no longer possible during runtime recovery")

    run_dir = Path(root) / safe_run_id
    marker = run_dir / "cancel.request.json"
    payload = {
        "schema_version": 1,
        "job_key": safe_job_key,
        "run_id": safe_run_id,
        "requested_at": _utc_now(),
        "requested_by": str(requested_by or ""),
    }
    if not marker.exists():
        _atomic_json(marker, payload)
    state["cancel_requested"] = True
    state["cancel_requested_at"] = payload["requested_at"]
    return state
