"""Credential-safe command/exit evidence for Borg subprocesses (#648)."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import uuid
from collections.abc import Callable, Mapping, Sequence

_SECRET_NAME = re.compile(r"(?i)(password|passphrase|passcommand|(?:^|[_-])pass(?:$|[_-])|token|secret|credential|authorization|private[_-]?key|api[_-]?key|access[_-]?key|key[_-]?file)")
_ASSIGNMENT = re.compile(r"(?i)((?:[\w-]*(?:password|passphrase|passcommand|token|secret|credential|authorization|api[_-]?key|access[_-]?key)[\w-]*)\s*=).*", re.S)
_URL_PASSWORD = re.compile(r"(?is)([a-z][a-z0-9+.-]*://[^/@:]*:).*@")
_QUERY_KEY = re.compile(r"(?i)([?&]key=)[^&]*")
_SECRET_PATH = re.compile(r"(/boot/config/borg-backup/secrets/).*", re.S)
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def format_borg_command(command: Sequence[str], env: Mapping[str, str] | None = None) -> str:
    """Quote actual argv for a single log line without changing execution argv.

    Mask secret options/assignments, URL passwords, secret-file paths and known
    secret environment values. Shell-bearing --rsh/--remote-path values are
    hidden conservatively. Environment variables themselves are never rendered.
    Control characters use visible hex escapes; such lines are diagnostic, not
    a byte-exact replay script. Other argument boundaries survive shell parsing.
    """
    environment = os.environ if env is None else env
    secrets = sorted({str(value) for key, value in environment.items()
                      if value and _SECRET_NAME.search(str(key))}, key=len, reverse=True)
    output = []
    hide_next = False
    for argument in command:
        value = str(argument)
        if hide_next:
            output.append('***')
            hide_next = False
            continue
        name, sep, _ = value.partition('=')
        if name.startswith('-') and (_SECRET_NAME.search(name) or name in {'--rsh', '--remote-path'}):
            value = name + '=***' if sep else name
            hide_next = not sep
        else:
            value = _URL_PASSWORD.sub(lambda match: match.group(1) + '***@', value)
            value = _QUERY_KEY.sub(lambda match: match.group(1) + "***", value)
            value = _ASSIGNMENT.sub(lambda match: match.group(1) + '***', value)
            value = _SECRET_PATH.sub(lambda match: match.group(1) + '***', value)
        for secret in secrets:
            value = value.replace(secret, '***')
        output.append(_CONTROL.sub(lambda match: f'\\x{ord(match.group()):02x}', value))
    return shlex.join(output)


class BorgExecutionLog:
    """Emit a correlated start and terminal record through a supplied log sink.

    Construction emits the start before Popen/run. Call finished with the raw
    subprocess return code (negative means signal), or failed when no code is
    available. Error messages and subprocess output are never included here.
    records holds at most the start and latest terminal line for bounded result
    summaries. Logging uses the caller's existing sink/error policy.
    """

    def __init__(self, command: Sequence[str], emit: Callable[[str], None],
                 env: Mapping[str, str] | None = None):
        operation = str(command[1]) if len(command) > 1 else 'command'
        self.operation = ('version' if operation == '--version' else operation
                          if operation in {'create', 'prune', 'compact', 'check', 'info'} else 'command')
        self.identifier = uuid.uuid4().hex
        self.emit = emit
        self.records = []
        self._write('BORG_EXEC', ': ' + format_borg_command(command, env))

    def _write(self, kind: str, suffix: str) -> None:
        """Send one generated single-line record to the configured sink."""
        line = f'{kind} [{self.operation}] id={self.identifier}{suffix}'
        self.records[:] = self.records[:1] + [line] if self.records else [line]
        self.emit(line)

    def finished(self, returncode: int | None) -> None:
        """Record the actual process exit code, preserving negative signal codes."""
        code = returncode if type(returncode) is int else 'unknown'
        self._write('BORG_EXIT', f': exit_code={code}')

    def failed(self, error: BaseException) -> None:
        """Record a start error or timeout without leaking exception arguments."""
        timeout = isinstance(error, subprocess.TimeoutExpired)
        status = 'timeout' if timeout else 'start_failed'
        code = 'unknown' if timeout else 'not_started'
        self._write('BORG_EXIT', f': exit_code={code} status={status} error={type(error).__name__}')
