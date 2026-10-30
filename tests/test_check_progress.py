"""Immediate create/check feedback and quiet persisted logs (#579, #646)."""
import io
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT, ROOT / 'api', ROOT / 'runtime'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import job_control
import jobs_api
from runtime.lib import borg_runner


@pytest.fixture
def control(tmp_path):
    controller = job_control.JobControl('files_local', 'progress-run-579', tmp_path / 'control')
    controller.update_phase('borg_check', cancel_allowed=True)
    return controller


def progress(current=63, total=100, **extra):
    return dict(type='progress_percent', operation=1, current=current, total=total, **extra)


def test_progress_throttles_writes_and_resets_between_steps(control, monkeypatch):
    tick = [10.0]
    monkeypatch.setattr(job_control.time, 'monotonic', lambda: tick[0])
    control.update_borg_progress(progress())
    original = control.state_file.read_bytes()
    control.update_borg_progress(progress(65))
    assert control.state_file.read_bytes() == original
    tick[0] += 1
    control.update_borg_progress(progress(70))
    state = job_control.read_control_state(control.run_id, control.run_dir.parent)
    assert state['borg_progress']['percent'] == 70
    assert state['borg_progress']['started_at'] > 0
    assert state['borg_progress']['updated_at'] > 0
    assert 'current' not in state['borg_progress']
    control.update_borg_progress({'type': 'progress_percent', 'operation': 1, 'finished': True})
    assert json.loads(control.state_file.read_text())['borg_progress']['percent'] is None
    control.update_borg_progress({'type': 'progress_message', 'operation': 2, 'message': 'private repository'})
    assert 'private repository' not in control.state_file.read_text()
    control.update_phase('post_script', cancel_allowed=False)
    control.update_borg_progress(progress())
    assert json.loads(control.state_file.read_text())['borg_progress'] is None


@pytest.mark.parametrize('current,total', [(1, 0), (-1, 10), (11, 10), (float('nan'), 10), (1, float('inf')), ('63', 100), (True, 1), (10**1000, 10**1001)])
def test_invalid_counters_are_indeterminate(control, current, total):
    control.update_borg_progress(progress(current, total))
    assert json.loads(control.state_file.read_text())['borg_progress']['percent'] is None


@pytest.mark.parametrize('code,outcome', [(0, 'succeeded'), (1, 'warnings'), (2, 'failed'), (130, 'cancelled')])
def test_check_routes_progress_without_log_flooding(control, monkeypatch, caplog, tmp_path, code, outcome):
    events = [progress(63), progress(65), progress(70),
              {'type': 'log_message', 'levelname': 'INFO', 'message': 'Starting check'},
              {'type': 'progress_percent', 'operation': 1, 'finished': True}]
    process = SimpleNamespace(stdout=io.StringIO('\n'.join(map(json.dumps, events))),
                              wait=lambda: code, returncode=code)
    commands = []
    def popen(cmd, **kwargs):
        commands.append(cmd)
        return process
    monkeypatch.setattr(borg_runner.subprocess, 'Popen', popen)
    monkeypatch.setattr(control, 'attach_process', lambda proc: None)
    monkeypatch.setattr(control, 'detach_process', lambda: None)
    monkeypatch.setattr(borg_runner, '_start_process_watchdog', lambda *a, **kw: None)
    if code == 130:
        control.cancel_file.write_text('{}')
    cfg = borg_runner.BorgConfig(repo='test-repo', check_flag_file=tmp_path / 'checked')
    runner = borg_runner.BorgRunner(cfg, process_controller=control)
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        assert runner.check() == code
    messages = [r.getMessage() for r in caplog.records if r.name == borg_runner.logger.name
                and not r.getMessage().startswith(('BORG_EXEC ', 'BORG_EXIT '))]
    assert len(messages) == 1
    assert outcome in messages[0]
    assert not any(str(n) + ' %' in caplog.text for n in (63, 65, 70))
    assert '--progress' in commands[0] and '--log-json' in commands[0]
    assert '--show-rc' not in commands[0]
    assert cfg.check_flag_file.exists() == (code == 0)
    assert json.loads(control.state_file.read_text())['borg_progress'] is None


def test_check_diagnostics_and_plaintext_errors_survive(control, caplog):
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        borg_runner._consume_borg_output(json.dumps({'type':'log_message', 'levelname':'WARNING', 'message':'Segment warning'}), control)
        borg_runner._consume_borg_output(json.dumps({'type':'log_message', 'levelname':'ERROR', 'message':'Segment damaged'}), control)
        borg_runner._consume_borg_output('borg: error: invalid argument', control)
        for malformed in ('{broken json', '[]', 'null', '{"type": []}'):
            borg_runner._consume_borg_output(malformed, control)
    assert 'Segment warning' in caplog.text and 'Segment damaged' in caplog.text
    assert 'invalid argument' in caplog.text
    assert '{broken json' not in caplog.text


def test_status_write_failure_does_not_abort_check_output(caplog):
    def fail(_event):
        raise OSError('unavailable')
    borg_runner._consume_borg_output(json.dumps(progress()), SimpleNamespace(update_borg_progress=fail))
    assert not caplog.records


@pytest.mark.parametrize('operation', ['create', 'prune', 'compact', 'check'])
def test_empty_info_and_borg_progress_logger_do_not_pollute_log(control, caplog, operation):
    messages = [
        '', ' \t\r\n',
        'Initializing cache transaction: Reading config',
        'Initializing cache transaction: Reading chunks',
        'Initializing cache transaction: Reading files',
        'Saving chunks cache', 'Saving cache config',
    ]
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        for message in messages:
            borg_runner._consume_borg_output(json.dumps(dict(
                type='log_message', levelname='INFO', name='borg.output.progress', message=message,
            )), control, operation=operation)
        for message in ('', ' \t\r\n'):
            borg_runner._consume_borg_output(json.dumps(dict(
                type='log_message', levelname='INFO', name='borg.archiver', message=message,
            )), control, operation=operation)
            borg_runner._consume_borg_output(message, control, operation=operation)
        expected = []
        for level in ('WARNING', 'ERROR', 'CRITICAL'):
            message = f'Cache diagnostic: {level}'
            expected.append(message)
            borg_runner._consume_borg_output(json.dumps(dict(
                type='log_message', levelname=level, name='borg.output.progress', message=message,
            )), control, operation=operation)
        if operation != 'check':
            for message in ('Keeping archive: example', 'Pruning archive (1/1): example'):
                expected.append(message)
                borg_runner._consume_borg_output(json.dumps(dict(
                    type='log_message', levelname='INFO', name='borg.output.list', message=message,
                )), control, operation=operation)
    assert [record.getMessage() for record in caplog.records] == expected


def test_skipped_check_does_not_enter_check_phase(tmp_path, monkeypatch):
    flag = tmp_path / 'checked'
    flag.touch()
    phases = []
    runner = borg_runner.BorgRunner(borg_runner.BorgConfig(check_flag_file=flag), phase_callback=phases.append)
    monkeypatch.setattr(borg_runner, '_run_borg', lambda *args: pytest.fail('Skipped checks must not execute Borg'))
    assert runner.check() == 0
    assert phases == []


def test_progress_reaches_runtime_api(control, monkeypatch):
    control.update_borg_progress(progress())
    state = json.loads(control.state_file.read_text())
    monkeypatch.setattr(job_control, 'read_control_state', lambda run: state)
    assert jobs_api._control_state_for_run(control.run_id)['borg_progress']['percent'] == 63


def test_real_borg_check_keeps_only_final_summary(tmp_path, monkeypatch, caplog):
    borg = shutil.which('borg')
    if not borg:
        pytest.skip('Borg executable required for real check integration')
    monkeypatch.setenv('BORG_CACHE_DIR', str(tmp_path / 'cache'))
    monkeypatch.setenv('BORG_SECURITY_DIR', str(tmp_path / 'security'))
    monkeypatch.setenv('BORG_KEYS_DIR', str(tmp_path / 'keys'))
    repo = tmp_path / 'repo'
    subprocess.run([borg, 'init', '--encryption=none', str(repo)], check=True, capture_output=True)
    source = tmp_path / 'file.txt'
    source.write_text('Check progress integration\n' * 500)
    subprocess.run([borg, 'create', f'{repo}::test', str(source)], check=True, capture_output=True)
    events = []
    controller = SimpleNamespace(update_borg_progress=events.append, attach_process=lambda p: None,
                                 detach_process=lambda: None, is_cancel_requested=lambda: False)
    runner = borg_runner.BorgRunner(borg_runner.BorgConfig(repo=str(repo), check_flag_file=tmp_path / 'checked'), process_controller=controller)
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        assert runner.check() == 0
    assert any(event and event.get('type') == 'progress_percent' for event in events)
    assert events[-1] is None
    messages = [r.getMessage() for r in caplog.records if r.name == borg_runner.logger.name
                and not r.getMessage().startswith(('BORG_EXEC ', 'BORG_EXIT '))]
    assert len(messages) == 1 and 'succeeded' in messages[0]


def test_browser_borg_progress():
    subprocess.run(['node', 'tests/check_progress_ui.cjs'], cwd=ROOT, check=True)


def test_create_counters_and_phase_timing_reset(control, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(job_control.time, 'time', lambda: clock[0])
    control.update_phase('borg_create', cancel_allowed=True)
    control.update_borg_progress({'type': 'archive_progress', 'nfiles': 25, 'original_size': 4096,
                                  'compressed_size': 2048, 'deduplicated_size': 1024,
                                  'path': '/private/source'})
    state = json.loads(control.state_file.read_text())['borg_progress']
    assert state['phase'] == 'borg_create'
    assert state['started_at'] == 100
    assert state['nfiles'] == 25 and state['original_size'] == 4096
    assert state['percent'] is None and 'path' not in state
    clock[0] = 200.0
    control.update_phase('borg_check', cancel_allowed=True)
    state = json.loads(control.state_file.read_text())['borg_progress']
    assert state['started_at'] == 200
    assert state['phase'] == 'borg_check' and 'nfiles' not in state
    control.update_phase('completed', cancel_allowed=False, finished=True)
    assert json.loads(control.state_file.read_text())['borg_progress'] is None


def test_create_json_preserves_stats_and_optional_file_activity(control, caplog, tmp_path):
    control.update_phase('borg_create', cancel_allowed=True)
    events = [
        {'type': 'archive_progress', 'nfiles': 25, 'original_size': 4096, 'path': '/hidden/progress-path'},
        {'type': 'archive_progress', 'nfiles': 26, 'original_size': 8192, 'path': '/hidden/progress-path'},
        {'type': 'file_status', 'status': 'A', 'path': 'new-file.txt'},
        {'type': 'file_status', 'status': 'M', 'path': 'changed-file.txt'},
        {'type': 'file_status', 'status': 'E', 'path': 'unreadable-file.txt'},
        {'type': 'log_message', 'levelname': 'WARNING', 'message': 'Permission denied'},
        {'type': 'log_message', 'levelname': 'INFO', 'message': 'Archive name: test\nNumber of files: 26\nThis archive: 8.19 kB 4.10 kB 2.05 kB'},
    ]
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        for event in events:
            borg_runner._consume_borg_output(json.dumps(event), control, operation='create')
    assert 'archive_progress' not in caplog.text and '/hidden/progress-path' not in caplog.text
    assert 'A new-file.txt' in caplog.text and 'M changed-file.txt' in caplog.text
    assert 'E unreadable-file.txt' in caplog.text and 'Permission denied' in caplog.text
    log_file = tmp_path / 'stats.log'
    log_file.write_text(caplog.text)
    stats = borg_runner.parse_borg_stats(log_file)
    assert stats.archive_name == 'test' and stats.files == 26 and stats.original_size > 8000


@pytest.mark.parametrize('file_activity', [False, True])
def test_real_borg_create_progress_and_final_statistics(tmp_path, monkeypatch, caplog, file_activity):
    borg = shutil.which('borg')
    if not borg:
        pytest.skip('Borg executable required for real create integration')
    for name in ('CACHE', 'SECURITY', 'KEYS'):
        monkeypatch.setenv(f'BORG_{name}_DIR', str(tmp_path / name.lower()))
    repo = tmp_path / 'repo'
    subprocess.run([borg, 'init', '--encryption=none', str(repo)], check=True, capture_output=True)
    source = tmp_path / 'create-source.txt'
    source.write_text('Archive progress integration\n' * 500)
    events = []
    controller = SimpleNamespace(update_borg_progress=events.append, attach_process=lambda p: None,
                                 detach_process=lambda: None, is_cancel_requested=lambda: False)
    runner = borg_runner.BorgRunner(borg_runner.BorgConfig(repo=str(repo), file_activity=file_activity), process_controller=controller)
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        assert runner.create([source], 'progress-test') == 0
    assert any(event and event.get('type') == 'archive_progress' for event in events)
    assert events[-1] is None
    assert 'archive_progress' not in caplog.text
    activity_line = 'A ' + str(source)
    assert (activity_line in caplog.text) is file_activity
    log_file = tmp_path / 'create.log'
    log_file.write_text(caplog.text)
    stats = borg_runner.parse_borg_stats(log_file)
    assert stats.files == 1 and stats.original_size > 0
    assert stats.archive_name.startswith('progress-test-')
    estimates = [event['source_estimate'] for event in events if event and 'source_estimate' in event]
    assert {'status': 'ready', 'bytes': source.stat().st_size} in estimates
