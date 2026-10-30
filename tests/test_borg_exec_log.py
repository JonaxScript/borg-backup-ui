"""Actual command evidence, quoting, credential masking and exit correlation (#648)."""
import io
import logging
from pathlib import Path
import re
import shlex
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for entry in (ROOT, ROOT / 'api', ROOT / 'runtime'):
    sys.path.insert(0, str(entry))

from runtime.lib.borg_exec_log import BorgExecutionLog, format_borg_command
from runtime.lib import borg_runner
from check_api import CheckManager, _CheckState
from datetime import datetime, timezone
from support_bundle_api import sanitize_text


def test_argument_boundaries_and_control_characters():
    command = ['borg', 'create', '--compression=zstd,3', '--glob-archives', 'backup-*',
               '/repo with space::backup', '/source/quote\'s "data"', '$(touch bad)', '', '--bypass-lock', '/repo']
    assert shlex.split(format_borg_command(command, {})) == command
    assert '\n' not in format_borg_command(['borg', 'info', 'path\nBORG_EXIT\r\x1b[31m\x9b'], {})
    assert r'\x0aBORG_EXIT\x0d\x1b[31m\x9b' in format_borg_command(['borg', 'info', 'path\nBORG_EXIT\r\x1b[31m\x9b'], {})


@pytest.mark.parametrize('argument', [
    ['--passphrase', 'multi word credential'], ['--passphrase=multi word credential'],
    ['--rsh', 'sshpass -p multi word credential ssh'],
    ['--remote-path=wrapper multi word credential'],
    ['ssh://alice:multi word credential@host/repo'],
    ['ssh://alice:multi@word@credential@host/repo'],
    ['https://host/repo?token=multi word credential&other=ok'],
    ['API_KEY=multi word credential'],
    ['https://host/repo?key=multi word credential&other=ok'],
    ['--key-file', 'multi word credential'],
    ['/boot/config/borg-backup/secrets/multi word credential'],
])
def test_sensitive_argument_formats_are_masked(argument):
    command = ['borg', 'info', *argument]
    before = list(command)
    line = format_borg_command(command, {})
    for word in ('multi', 'word', 'credential'):
        assert word not in line
    assert '***' in line
    assert command == before


def test_known_environment_credentials_are_masked_but_environment_is_not_dumped():
    env = {'BORG_PASSPHRASE': "opaque\n'a secret", 'API_KEY': 'apikey-value', 'PUBLIC_MARKER': 'never-rendered'}
    line = format_borg_command(['borg', 'create', "repo::opaque\n'a secret", '/apikey-value'], env)
    assert 'opaque' not in line and 'apikey-value' not in line and 'never-rendered' not in line
    assert env['BORG_PASSPHRASE'] == "opaque\n'a secret"


@pytest.mark.parametrize('operation', ['create', 'prune', 'compact', 'check'])
@pytest.mark.parametrize('code', [0, 1, 2, -15])
def test_runtime_logs_actual_argv_before_start_and_raw_exit(monkeypatch, caplog, tmp_path, operation, code):
    process = SimpleNamespace(stdout=io.StringIO(''), wait=lambda: code, returncode=code)
    captured = []
    def popen(command, **kwargs):
        starts = [r.getMessage() for r in caplog.records if r.getMessage().startswith('BORG_EXEC ')]
        assert len(starts) == 1
        assert shlex.split(starts[0].split(': ', 1)[1]) == command
        captured.append(list(command))
        return process
    monkeypatch.setattr(borg_runner.subprocess, 'Popen', popen)
    monkeypatch.setattr(borg_runner, '_start_process_watchdog', lambda *a, **kw: None)
    runner = borg_runner.BorgRunner(borg_runner.BorgConfig(repo='/repo with spaces', check_flag_file=tmp_path/'checked'))
    with caplog.at_level(logging.INFO):
        result = runner.create([Path('/source with spaces')], 'backup') if operation == 'create' else getattr(runner, operation)()
    assert result == code
    records = [r.getMessage() for r in caplog.records if r.getMessage().startswith(('BORG_EXEC ', 'BORG_EXIT '))]
    assert len(records) == 2
    assert re.search(r'id=(\w+)', records[0])[1] == re.search(r'id=(\w+)', records[1])[1]
    assert records[1].endswith(f'exit_code={code}')
    assert captured[0][1] == operation


@pytest.mark.parametrize('create', [True, False])
def test_start_failure_has_no_fabricated_process_exit(monkeypatch, caplog, create):
    def missing(*args, **kwargs):
        raise FileNotFoundError('not installed')
    monkeypatch.setattr(borg_runner.subprocess, 'Popen', missing)
    with caplog.at_level(logging.INFO):
        result = (borg_runner.BorgRunner(borg_runner.BorgConfig(repo='/repo')).create([Path('/source')], 'backup')
                  if create else borg_runner._run_borg(['borg', 'check', '/repo']))
    assert result == 2
    assert 'exit_code=not_started status=start_failed error=FileNotFoundError' in caplog.text


def test_timeout_does_not_expose_exception_command_or_environment():
    lines = []
    audit = BorgExecutionLog(['borg', 'info', '/repo'], lines.append, {})
    audit.failed(subprocess.TimeoutExpired(['secret command'], 30, output='secret output'))
    assert 'status=timeout' in lines[-1] and 'exit_code=unknown' in lines[-1]
    assert 'secret' not in '\n'.join(lines)


def test_manual_maintenance_pins_command_exit_evidence_and_support_masks_remote():
    proc = SimpleNamespace(stdout=io.StringIO('\n'.join(f'progress {i}' for i in range(40))),
                           wait=lambda: 1, returncode=1)
    state = _CheckState(proc, 'repo', 'quick', datetime.now(timezone.utc))
    state.execution_log = BorgExecutionLog(['borg', 'check', 'ssh://alice:sensitive@host/repo'], state.append_line, {})
    CheckManager()._reader(state)
    result = CheckManager._maintenance_result(state)
    assert result['exit_code'] == 1
    assert len(result['details']) == 20
    assert result['details'][0].startswith('BORG_EXEC [check]')
    assert result['details'][-1].endswith('exit_code=1')
    assert 'sensitive' not in '\n'.join(result['details'])
    exported = sanitize_text('\n'.join(state.lines))
    assert 'alice' not in exported and 'host/repo' not in exported
    assert 'BORG_EXEC' in exported and 'BORG_EXIT' in exported


@pytest.mark.parametrize('outcome', ['success', 'timeout', 'missing'])
def test_repository_size_probe_logs_success_and_failure(monkeypatch, caplog, outcome):
    from runtime.lib.backup_job import BackupJob
    job = BackupJob.__new__(BackupJob)
    job.config = SimpleNamespace(borg_repo='/repo with spaces')
    def run(command, **kwargs):
        assert 'BORG_EXEC [info]' in caplog.text
        assert command == ['borg', 'info', '--json', '/repo with spaces']
        if outcome == 'timeout':
            raise subprocess.TimeoutExpired(command, 30)
        if outcome == 'missing':
            raise FileNotFoundError('missing')
        return subprocess.CompletedProcess(command, 0, '{"cache":{"stats":{"unique_size":42}}}')
    monkeypatch.setattr(subprocess, 'run', run)
    with caplog.at_level(logging.INFO):
        assert job._get_repository_size() == (42 if outcome == 'success' else 0)
    records = [r.getMessage() for r in caplog.records if r.getMessage().startswith(('BORG_EXEC ', 'BORG_EXIT '))]
    assert len(records) == 2
    expected = {'success': 'exit_code=0', 'timeout': 'status=timeout', 'missing': 'status=start_failed'}
    assert expected[outcome] in records[-1]


def test_cancellation_result_does_not_replace_raw_signal_code(monkeypatch, caplog):
    process = SimpleNamespace(stdout=io.StringIO(''), wait=lambda: -15, returncode=-15)
    controller = SimpleNamespace(attach_process=lambda process: None, detach_process=lambda: None,
                                 is_cancel_requested=lambda: True)
    monkeypatch.setattr(borg_runner.subprocess, 'Popen', lambda *a, **kw: process)
    monkeypatch.setattr(borg_runner, '_start_process_watchdog', lambda *a, **kw: None)
    with caplog.at_level(logging.INFO):
        assert borg_runner._run_borg(['borg', 'check', '/repo'], controller) == 130
    assert 'exit_code=-15' in caplog.text
    assert 'exit_code=130' not in caplog.text


def test_manual_start_failure_is_logged_without_exception_credentials(monkeypatch, caplog):
    import repositories_api
    import storage_objects_api
    monkeypatch.setattr(repositories_api, 'read_repository_store', lambda _: {'repositories': [{'repository_key': 'repo'}]})
    monkeypatch.setattr(storage_objects_api, 'read_storage_store', lambda _: {'storages': []})
    monkeypatch.setattr(repositories_api, 'effective_repository_path', lambda *a: '/repository')
    monkeypatch.setattr(repositories_api, '_repo_env', lambda *a, **kw: {})
    def denied(command, **kwargs):
        assert 'BORG_EXEC [check]' in caplog.text
        raise PermissionError('sensitive failure text')
    monkeypatch.setattr(subprocess, 'Popen', denied)
    manager = CheckManager()
    with caplog.at_level(logging.INFO):
        ok, error = manager.start_repository({}, 'repo')
    assert not ok and error == 'Start failed: PermissionError'
    assert 'exit_code=not_started' in caplog.text
    assert 'sensitive failure text' not in caplog.text
    assert manager._state is None


def test_long_manual_command_is_bounded_without_duplicate_evidence():
    state = _CheckState(SimpleNamespace(returncode=0), 'repo', 'quick', datetime.now(timezone.utc))
    state.execution_log = BorgExecutionLog(['borg', 'check', '/' + 'x' * 3000], state.append_line, {})
    state.append_line('All checks passed')
    state.execution_log.finished(0)
    details = CheckManager._maintenance_result(state)['details']
    assert len(details) == 3
    assert len(details[0]) == 2000
    assert details[1] == 'All checks passed'
    assert details[2].endswith('exit_code=0')


def test_operation_label_never_copies_a_sensitive_argument():
    lines = []
    audit = BorgExecutionLog(['borg', '--passphrase=opaque-value', 'info'], lines.append, {})
    audit.finished(0)
    assert all('opaque-value' not in line for line in lines)
    assert lines[0].startswith('BORG_EXEC [command]')
