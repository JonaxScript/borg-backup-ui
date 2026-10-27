"""Bounded Borg output handling and uniform streaming restore-test samples."""

from __future__ import annotations

import json
import os
import random
import selectors
import signal
import subprocess
import time


class ArchiveSample:
    """Count regular files and retain a uniform reservoir of at most ``limit`` paths.

    Feed binary JSON-lines chunks to ``feed`` and call ``finish`` at EOF.
    Malformed or oversized entries fail the listing instead of claiming coverage.
    ``first=True`` retains the first paths for the existing legacy L3 policy.
    """

    def __init__(self, limit: int, *, first: bool = False):
        self.limit = max(1, limit)
        self.first = first
        self.count = 0
        self.paths: list[str] = []
        self.pending = b""

    def feed(self, chunk: bytes) -> None:
        """Consume a bounded chunk; reject JSON lines larger than one MiB."""
        lines = (self.pending + chunk).split(b"\n")
        self.pending = lines.pop()
        for line in lines:
            self._entry(line)
        if len(self.pending) > 1024 * 1024:
            raise ValueError("Archive listing entry exceeds one MiB")

    def finish(self) -> None:
        """Consume the final unterminated JSON line, if present."""
        self._entry(self.pending)
        self.pending = b""

    def _entry(self, line: bytes) -> None:
        """Validate one JSON entry and update the regular-file reservoir."""
        if not line.strip():
            return
        if len(line) > 1024 * 1024:
            raise ValueError("Archive listing entry exceeds one MiB")
        entry = json.loads(line)
        if not isinstance(entry, dict):
            raise ValueError("Invalid archive listing entry")
        path = entry.get("path")
        if entry.get("type") != "-" or not isinstance(path, str) or not path:
            return
        self.count += 1
        if len(self.paths) < self.limit:
            self.paths.append(path)
        elif not self.first:
            index = random.randrange(self.count)
            if index < self.limit:
                self.paths[index] = path


def run_borg(args: list[str], env: dict, timeout: int,
             consume=None, *, cancel_requested=None) -> subprocess.CompletedProcess:
    """Run Borg with bounded capture, or stream stdout bytes to ``consume``.

    Drain both pipes concurrently. A timeout kills and reaps the command's
    process group and returns exit 124. Capture overflow or callback errors
    fail the command; stderr retains its final 64 KiB. No output is spooled to
    disk. Child processes use a separate session for reliable timeout cleanup.
    An optional cancellation predicate raises ResourceGuardError (RT_CANCELLED)
    after killing/reaping the command group; callers must record interruption.
    """
    from restore_test_resources import check_cancelled
    check_cancelled(cancel_requested)
    command = ["borg", *args]
    stdout = bytearray()
    stderr = bytearray()
    deadline = time.monotonic() + timeout if timeout > 0 else None
    error = ""
    returncode = None
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env, start_new_session=True) as proc:
        try:
            with selectors.DefaultSelector() as selector:
                for stream in (proc.stdout, proc.stderr):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ)
                while selector.get_map() or proc.poll() is None:
                    check_cancelled(cancel_requested)
                    if deadline is not None and time.monotonic() >= deadline:
                        returncode = 124
                        error = f"Borg command timed out after {timeout}s"
                        break
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fileobj.fileno(), 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        elif key.fileobj is proc.stderr:
                            stderr.extend(chunk)
                            del stderr[:-65536]
                        elif consume is not None:
                            consume(chunk)
                        else:
                            stdout.extend(chunk)
                            if len(stdout) > 1024 * 1024:
                                raise ValueError("Borg stdout exceeds the capture limit")
        except (ValueError, UnicodeError) as exc:
            returncode = 2
            error = f"Invalid Borg output: {type(exc).__name__}"
        finally:
            # Also stop descendants that kept a pipe open after Borg exited.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
        return subprocess.CompletedProcess(command, proc.returncode if returncode is None else returncode,
                                           stdout.decode("utf-8", errors="replace"),
                                           error + ("\n" if error else "") + stderr.decode("utf-8", errors="replace"))
