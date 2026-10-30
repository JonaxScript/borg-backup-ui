"""Optional, bounded logical-size estimates for mounted backup sources (#646)."""

from __future__ import annotations

import glob
import os
import subprocess
import threading
import time
from pathlib import Path


class SourceSizeEstimate:
    """Run GNU du asynchronously without reading file contents or logging paths.

    Paths must be the resolved local paths passed to Borg. Explicit excluded
    subtrees are supported; Borg marker/pattern exclusions disable estimation
    because du cannot reproduce their semantics. Results are approximate even
    with supported exclusions (the source can change during the backup).
    Startup, access and command errors are non-fatal. Call close at create end.
    unsupported skips the scan, cancelled is a no-argument predicate checked
    while scanning, and timeout bounds scan time in seconds (default 300).
    snapshot returns a status and, only on success, a non-negative byte total.
    """

    def __init__(self, paths, excluded=(), *, unsupported=False, cancelled=None, timeout=300):
        self._result = {"status": "unsupported" if unsupported else "scanning"}
        self._stop = threading.Event()
        self._thread = None
        if unsupported:
            return
        self._paths = [os.path.normpath(str(path)) for path in paths]
        # Borg ignores an empty archive prefix (for example an excluded '/').
        self._excluded = [os.path.normpath(str(path)) for path in excluded if str(path).strip('/')]
        self._cancelled = cancelled or (lambda: False)
        self._timeout = timeout
        self._thread = threading.Thread(target=self._run, name="source-size-estimate", daemon=True)
        try:
            self._thread.start()
        except RuntimeError:
            self._thread = None
            self._result = {"status": "failed"}

    def snapshot(self):
        """Return a copy of the latest numeric result; never expose paths/errors."""
        return dict(self._result)

    def close(self):
        """Cancel unfinished measurement and wait at most one second for cleanup.

        Uninterruptible filesystem I/O can delay process reaping; the daemon
        worker keeps cleanup separate from Borg and service recovery.
        """
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)

    def _run(self):
        """Publish one complete result; discard partial output on any du failure."""
        process = None
        try:
            roots = []
            for path in sorted(set(self._paths), key=len):
                if not Path(path).is_absolute():
                    self._result = {"status": "failed"}
                    return
                if any(path == excluded or path.startswith(excluded.rstrip('/') + '/') for excluded in self._excluded):
                    continue
                if not any(path == root or path.startswith(root.rstrip('/') + '/') for root in roots):
                    roots.append(path)
            if not roots:
                self._result = {"status": "ready", "bytes": 0}
                return
            # NUL-separated input avoids argument length limits and shell parsing.
            # Full path glob escaping preserves literal [, * and ? in exclusions.
            command = ["du", "--bytes", "--summarize", "--total", "--null", "--files0-from=-"]
            for path in self._excluded:
                command.append("--exclude=" + glob.escape(path).replace('\\', '\\\\'))
            if self._stop.is_set() or self._cancelled():
                self._result = {"status": "cancelled"}
                return
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, env={"PATH": os.defpath, "LC_ALL": "C"})
            payload = b"".join(os.fsencode(path) + b"\0" for path in roots)
            deadline = time.monotonic() + self._timeout
            while True:
                if self._stop.is_set() or self._cancelled():
                    self._result = {"status": "cancelled"}
                    return
                if time.monotonic() >= deadline:
                    self._result = {"status": "timed_out"}
                    return
                try:
                    output, _ = process.communicate(input=payload, timeout=0.2)
                    break
                except subprocess.TimeoutExpired:
                    payload = None
            total = output.rstrip(b"\0").split(b"\0")[-1].split(b"\t")
            if process.returncode != 0 or len(total) != 2 or total[1] != b"total":
                self._result = {"status": "failed"}
                return
            size = int(total[0])
            self._result = ({"status": "ready", "bytes": size} if 0 <= size <= 2**53 - 1
                            else {"status": "failed"})
        except (OSError, ValueError, OverflowError):
            self._result = {"status": "failed"}
        finally:
            if process is not None:
                if process.poll() is None:
                    try:
                        process.kill()
                    except OSError:
                        pass
                # May wait on uninterruptible I/O, but only in this daemon worker.
                try:
                    process.communicate()
                except (OSError, ValueError):
                    pass
