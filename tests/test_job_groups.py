"""Behavioral tests for sequential groups, recovery, schedules and references (#570)."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT, ROOT / 'api', ROOT / 'runtime'):
    sys.path.insert(0, str(path))
import job_groups as groups
import jobs_api
import job_launch
import job_control
from job_fixtures import job_id


@pytest.fixture
def context(tmp_path, monkeypatch):
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path)}
    keys = [job_id('group-' + str(i)) for i in range(3)]
    monkeypatch.setattr('job_identity.active_job_ids', lambda c: set(keys))
    monkeypatch.setattr(groups, '_apply_schedules', lambda c: None)
    manager = SimpleNamespace(_lock=threading.Lock(), _states={})
    monkeypatch.setattr(jobs_api.JobManager, 'get', classmethod(lambda cls: manager))
    controls = {}
    monkeypatch.setattr(job_control, 'read_control_state', lambda run: controls.get(run, {}))
    launched = []
    def launch(config, key, **kwargs):
        index = len(launched)
        state = SimpleNamespace(run_id=kwargs['run_id'], finished=False, exit_code=None)
        manager._states[key] = state
        kwargs["state_sink"]["state"] = state
        launched.append((key, kwargs, state))
        return {'run_id': state.run_id}
    monkeypatch.setattr(job_launch, 'start_backup', launch)
    yield config, keys, launched, controls, manager
    # Stop and drain this fixture's coordinators before monkeypatch teardown.
    # A slow fsync must not leave a later child running with expired fixtures.
    directory = str(groups.directory(config))
    with groups._ACTIVE_LOCK:
        for (root, _), run in groups._ACTIVE.items():
            if root == directory:
                run['stop_requested'] = True
    deadline = time.monotonic() + 30
    while True:
        with groups._ACTIVE_LOCK:
            if not any(root == directory for root, _ in groups._ACTIVE):
                break
        for _, _, state in launched:
            state.exit_code = 0
            state.finished = True
        if time.monotonic() > deadline:
            raise AssertionError('Group fixture did not finish')
        time.sleep(.01)


def definition(config, keys, **extra):
    return groups.save_group(config, {'name': 'Nightly', 'jobs': keys, **extra})['group']


def wait_for(predicate):
    deadline = time.monotonic() + 30
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError('Group did not reach expected state')
        time.sleep(.01)


def finish(entry, code=0):
    entry[2].exit_code = code
    entry[2].finished = True


def test_order_waits_for_complete_job_and_snapshots_definition(context):
    config, keys, launched, controls, _ = context
    group = definition(config, keys)
    result = groups.start_group(config, group['id'])
    wait_for(lambda: len(launched) == 1)
    time.sleep(.15)
    assert len(launched) == 1
    groups.save_group(config, {**group, 'jobs': keys[::-1]})
    finish(launched[0])
    wait_for(lambda: len(launched) == 2)
    finish(launched[1], 1)
    wait_for(lambda: len(launched) == 3)
    finish(launched[2])
    wait_for(lambda: groups.current_run(config, group['id'])['status'] == 'warning')
    assert [row[0] for row in launched] == keys
    assert len({row[1]['run_id'] for row in launched}) == 3
    assert all(row[1]['group_env']['BORG_UI_GROUP_RUN_ID'] == result['run_id'] for row in launched)
    assert groups.group_history(config, group['id'])['runs'][0]['status'] == 'warning'


@pytest.mark.parametrize('outcome,policy,count,expected', [
    ('failed', 'stop', 1, 'failed'), ('skipped', 'stop', 1, 'failed'),
    ('failed', 'continue', 3, 'failed'), ('skipped', 'continue', 3, 'failed'),
    ('cancelled', 'continue', 1, 'cancelled'),
])
def test_failure_skip_and_cancel_semantics(context, outcome, policy, count, expected):
    config, keys, launched, controls, _ = context
    group = definition(config, keys, on_error=policy)
    groups.start_group(config, group['id'])
    wait_for(lambda: len(launched) == 1)
    controls[launched[0][1]['run_id']] = {'phase': outcome, 'cancel_requested': outcome == 'cancelled'}
    finish(launched[0], 130 if outcome == 'cancelled' else 2)
    for i in range(1, count):
        wait_for(lambda: len(launched) > i)
        finish(launched[i])
    wait_for(lambda: groups.current_run(config, group['id'])['status'] == expected)
    assert len(launched) == count
    assert all(s['status'] == 'not_run' for s in groups.current_run(config, group['id'])['steps'][count:])


def test_duplicate_start_and_stop_after_current(context):
    config, keys, launched, controls, _ = context
    group = definition(config, keys)
    result = groups.start_group(config, group['id'])
    wait_for(lambda: launched)
    with pytest.raises(RuntimeError, match='already running'):
        groups.start_group(config, group['id'])
    with pytest.raises(ValueError, match='no longer active'):
        groups.stop_group(config, group['id'], 'stale')
    groups.stop_group(config, group['id'], result['run_id'])
    assert not launched[0][2].finished
    finish(launched[0])
    wait_for(lambda: groups.current_run(config, group['id'])['status'] == 'stopped')
    assert len(launched) == 1


def test_schedule_and_delete_do_not_modify_jobs_or_individual_schedule(context):
    config, keys, *_ = context
    path = Path(config['BACKUP_SCRIPTS_DIR']) / 'config' / 'schedules.json'
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({keys[0]: {'enabled': True, 'cron': '0 1 * * *'}}))
    before = path.read_bytes()
    group = definition(config, keys, schedule={'enabled': False, 'cron': '0 2 * * *'})
    assert groups.start_group(config, group['id'], scheduled=True) == {'started': False, 'reason': 'schedule_disabled'}
    with pytest.raises(ValueError, match='Remove this job'):
        groups.require_unassigned(config, keys[0])
    groups.delete_group(config, group['id'])
    assert path.read_bytes() == before
    assert not groups.definitions(config)['groups']


def test_recovery_never_replays_and_preserves_child_guard(context):
    config, keys, *_ = context
    group = definition(config, keys)
    guard = groups._guard(config, group['id'])
    run = dict(group_id=group['id'], run_id=groups.new_run_id(), owner_pid=os.getpid(),
               status='running', steps=[{'job_key': keys[0], 'status': 'running'}, {'job_key': keys[1], 'status': 'pending'}])
    groups._persist(config, run)
    recovered = groups.current_run(config, group['id'])
    assert recovered['status'] == 'interrupted'
    assert [s['status'] for s in recovered['steps']] == ['interrupted', 'not_run']
    with pytest.raises(RuntimeError):
        groups.start_group(config, group['id'])
    guard.close()
    assert not groups._ACTIVE


def test_inherited_guard_survives_coordinator_close(tmp_path):
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path)}
    key = 'group-' + 'a' * 32
    guard = groups._guard(config, key)
    proc = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'],
                            stdin=subprocess.PIPE, pass_fds=(guard.fileno(),))
    guard.close()
    try:
        with pytest.raises(RuntimeError):
            groups._guard(config, key)
    finally:
        proc.communicate(timeout=3)
    with groups._guard(config, key):
        pass


def test_invalid_group_does_not_overwrite_inventory(context):
    config, keys, *_ = context
    group = definition(config, keys)
    before = groups.store_path(config).read_bytes()
    for change in ({'jobs': [keys[0], keys[0]]}, {'jobs': []}, {'on_error': 'ignore'},
                   {'schedule': {'enabled': True, 'cron': '* * * * *; touch bad'}}):
        with pytest.raises(ValueError):
            groups.save_group(config, {**group, **change})
        assert groups.store_path(config).read_bytes() == before


def test_import_remaps_complete_groups_and_rejects_partial(context):
    config, keys, *_ = context
    g = definition(config, keys)
    rows, report = groups.prepare_import(config, [g], {k: job_id(k) for k in keys}, 'rename')
    assert rows[0]['id'] != g['id']
    assert rows[0]['jobs'] == [job_id(k) for k in keys]
    rows, report = groups.prepare_import(config, [g], {keys[0]: keys[0]}, 'overwrite')
    assert not rows and report[0]['status'] == 'skipped_partial'


def test_cron_includes_group_and_preserves_individual(context, monkeypatch):
    import schedule_api
    config, keys, *_ = context
    g = definition(config, keys, schedule={'enabled': True, 'cron': '0 2 * * *'})
    monkeypatch.setattr(schedule_api, 'get_schedules', lambda c: {})
    monkeypatch.setattr(schedule_api, 'restore_test_cron_lines', lambda c: {})
    monkeypatch.setattr(schedule_api, '_update_crontab', lambda lines: lines)
    lines = schedule_api.apply_all_schedules(config)
    assert len(lines) == 1 and lines[0].startswith('0 2 * * * ')
    assert '/api/job-groups/run' in lines[0] and g['id'] in lines[0]


def test_roles_for_group_endpoints():
    from borg_backup_ui import BackupUIHandler as Handler
    handler = object.__new__(Handler)
    for path in ('/api/job-groups', '/api/job-groups/history'):
        assert handler._required_role_for_request(path, 'GET') == 'viewer'
    for path in ('/api/job-groups/run', '/api/job-groups/stop'):
        assert handler._required_role_for_request(path, 'POST') == 'operator'
    for method in ('POST', 'PUT', 'DELETE'):
        assert handler._required_role_for_request('/api/job-groups', method) == 'admin'


def test_waits_for_process_exit_including_post_script(tmp_path, monkeypatch):
    """The next member starts only after the previous process's final cleanup."""
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path)}
    keys = [job_id('process-first'), job_id('process-last')]
    monkeypatch.setattr('job_identity.active_job_ids', lambda c: set(keys))
    monkeypatch.setattr(groups, '_apply_schedules', lambda c: None)
    monkeypatch.setattr(job_control, 'read_control_state', lambda run: {})
    manager = jobs_api.JobManager()
    marker = tmp_path / 'phases.txt'
    release = tmp_path / 'finish-post'
    script = tmp_path / 'runner.py'
    script.write_text('''import sys, time
from pathlib import Path
marker, release, name = map(Path, sys.argv[1:])
with marker.open('a') as f: f.write(str(name) + ':pre,backup,maintenance,post\\n')
if str(name) == 'first':
    while not release.exists(): time.sleep(.02)
with marker.open('a') as f: f.write(str(name) + ':cleanup-finished\\n')
''')
    launched = []
    def launch(config, key, **kw):
        launched.append(key)
        ok, error = manager.start(key, [sys.executable, str(script), str(marker), str(release),
                                       'first' if key == keys[0] else 'last'], tmp_path,
                                  run_id=kw['run_id'], inherited_fds=kw['inherited_fds'],
                                  state_sink=kw['state_sink'])
        assert ok, error
    monkeypatch.setattr(job_launch, 'start_backup', launch)
    group = definition(config, keys)
    groups.start_group(config, group['id'])
    try:
        wait_for(lambda: marker.exists())
        time.sleep(.15)
        assert launched == keys[:1]
    finally:
        release.touch()
    wait_for(lambda: groups.current_run(config, group['id'])['status'] == 'success')
    assert marker.read_text().splitlines() == [
        'first:pre,backup,maintenance,post', 'first:cleanup-finished',
        'last:pre,backup,maintenance,post', 'last:cleanup-finished']


def test_later_standalone_start_cannot_replace_waited_child(context):
    config, keys, launched, _, manager = context
    group = definition(config, keys[:2])
    groups.start_group(config, group['id'])
    wait_for(lambda: launched)
    manager._states[keys[0]] = SimpleNamespace(run_id='unrelated', finished=False)
    finish(launched[0])
    wait_for(lambda: len(launched) == 2)
    finish(launched[1])
    wait_for(lambda: groups.current_run(config, group['id'])['status'] == 'success')


def test_log_stream_rejects_a_later_job_run(tmp_path):
    manager = jobs_api.JobManager()
    key = job_id('log-test')
    ok, error = manager.start(key, [sys.executable, '-c', "print('private later output')"],
                              tmp_path, run_id='20261017T150000Z-aaaaaaaaaaaa')
    assert ok, error
    wait_for(lambda: not manager.is_running(key))
    assert 'private later output' not in ''.join(manager.stream_output(key, '20261017T140000Z-bbbbbbbbbbbb'))
    assert 'private later output' in ''.join(manager.stream_output(key, '20261017T150000Z-aaaaaaaaaaaa'))


def test_group_reminder_context_keeps_individual_schedules(context, monkeypatch):
    config, keys, *_ = context
    group = definition(config, keys, schedule={'enabled': True, 'cron': '0 2 * * *'})
    schedules = {keys[0]: {'enabled': True, 'cron': '0 1 * * *'}}
    jobs, latest = {}, {}
    monkeypatch.setattr(groups, 'current_run', lambda c, k: {
        'started_at': '2098-01-01T00:00:00+00:00', 'status': 'running'})
    monkeypatch.setattr(groups, 'now', lambda: '2099-01-01T00:00:00+00:00')
    groups.add_reminder_context(config, schedules, jobs, latest)
    assert schedules[keys[0]]['cron'] == '0 1 * * *'
    assert schedules[group['id']]['cron'] == '0 2 * * *'
    assert set(latest) == {group['id']}
    assert latest[group['id']]['timestamp'].startswith('2099-01-01')


def test_http_group_crud_and_validation(context, monkeypatch):
    from http.server import ThreadingHTTPServer
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError
    import borg_backup_ui
    config, keys, *_ = context
    monkeypatch.setattr(borg_backup_ui, '_log', lambda *_: None)
    class Handler(borg_backup_ui.BackupUIHandler):
        def _authorize_api_request(self, *_): return True
        def _require_data_dir_ready(self): pass
        def log_message(self, *_): pass
    Handler.config = config
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    def request(method, body=None, suffix=''):
        payload = json.dumps(body).encode() if body is not None else None
        try:
            response = urlopen(Request(f'http://127.0.0.1:{server.server_port}/api/job-groups' + suffix,
                                       data=payload, method=method, headers={'Content-Type': 'application/json'}), timeout=5)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, json.load(response)
    try:
        status, saved = request('POST', {'name': 'HTTP Group', 'jobs': keys})
        assert status == 200
        key = saved['group']['id']
        status, data = request('GET')
        assert status == 200 and data['groups'][0]['id'] == key
        status, _ = request('PUT', {**saved['group'], 'jobs': []})
        assert status == 400
        assert request('GET', suffix='/history?id=' + key)[1] == {'runs': []}
        assert request('DELETE', {'id': key}) == (200, {'deleted': True})
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_cron_failure_keeps_saved_identity_for_retry(context, monkeypatch):
    config, keys, *_ = context
    def fail(_): raise OSError('crontab unavailable')
    monkeypatch.setattr(groups, '_apply_schedules', fail)
    result = groups.save_group(config, {'name': 'Saved', 'jobs': keys})
    assert result['saved'] is True
    assert result['schedule_error'] == 'crontab unavailable'
    again = groups.save_group(config, result['group'])
    assert again['group']['id'] == result['group']['id']
    assert len(groups.definitions(config)['groups']) == 1
