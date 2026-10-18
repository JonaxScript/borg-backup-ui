"""Shared job hook edits from groups preserve job data and running snapshots (#573)."""
import json
import sys
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

ROOT = Path(__file__).resolve().parents[1]
for directory in (ROOT, ROOT / 'api', ROOT / 'runtime'):
    sys.path.insert(0, str(directory))
import job_scripts
import job_groups
import jobs_api
import borg_backup_ui
from borg_backup_ui import BackupUIHandler
from job_fixtures import job_id


@pytest.fixture
def job(tmp_path):
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path)}
    key = job_id('shared-scripts')
    rows = [job_scripts.save_script(config, {'name': name, 'content': content})['script']
            for name, content in [('Original', 'exit 0'), ('Replacement', 'exit 42')]]
    meta = {'job_id': key, 'job_key': key, 'name': 'Appdata', 'enabled': False,
            'repository_key': 'repo-keep', 'source_paths': ['/mnt/user/appdata'],
            'retention': {'daily': 7}, 'restore_test_policy': {'enabled': True},
            'custom_future_field': {'preserve': True}, 'updated_at': 'before',
            'hooks': {'pre': rows[0]['id'], 'post': rows[0]['id'], 'post_when': 'always'}}
    path = tmp_path / 'config/jobs' / (key + '.json')
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(meta))
    return config, key, rows, meta, path


def test_shared_edit_preserves_other_fields_groups_and_running_snapshot(job, monkeypatch):
    config, key, rows, meta, path = job
    monkeypatch.setattr('job_identity.active_job_ids', lambda _: {key})
    definitions = [job_groups.save_group(config, {'name': name, 'jobs': [key]}, apply_schedule=False)
                   for name in ['Nightly', 'Weekend']]
    group_bytes = job_groups.store_path(config).read_bytes()
    current_hooks, current_scripts = job_scripts.snapshot_hooks(config, meta['hooks'])
    editor = job_scripts.get_job_hooks(config, key)
    assert editor['scripts'] == [{'id': row['id'], 'name': row['name']} for row in rows]
    assert 'content' not in json.dumps(editor)
    # An unrelated edit after opening the dialog must survive.
    meta['description'] = 'Edited elsewhere'
    path.write_text(json.dumps(meta))
    desired = {'pre': rows[1]['id'], 'post': '', 'post_when': 'success'}
    job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': editor['hooks'], 'hooks': desired})
    saved = json.loads(path.read_text())
    assert {k: v for k, v in saved.items() if k not in ('hooks', 'updated_at')} == {
        k: v for k, v in meta.items() if k not in ('hooks', 'updated_at')}
    assert saved['hooks'] == desired and saved['updated_at'] != 'before'
    assert path.stat().st_mode & 0o777 == 0o600
    assert job_groups.store_path(config).read_bytes() == group_bytes
    assert current_hooks == meta['hooks'] and current_scripts['pre']['content'] == 'exit 0'
    assert job_scripts.snapshot_hooks(config, saved['hooks'])[1]['pre']['content'] == 'exit 42'
    assert job_scripts.get_job_hooks(config, key)['hooks'] == desired
    # Both groups resolve labels from the same updated job, without duplicating settings.
    monkeypatch.setattr(jobs_api, 'discover_jobs', lambda *args: [type('Job', (), {'key': key})()])
    overview = job_groups.list_groups(config)
    assert {g['id'] for g in overview['groups']} == {g['group']['id'] for g in definitions}
    assert overview['hooks'][key] == {'pre': 'Replacement', 'post': '', 'post_when': 'success'}
    before = path.read_bytes()
    with pytest.raises(job_scripts.ScriptValidationError) as conflict:
        job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': editor['hooks'], 'hooks': {}})
    assert conflict.value.api_status == 409 and conflict.value.api_code == 'job_script_conflict'
    assert path.read_bytes() == before


def test_remove_and_add_assignments_without_group_overrides(job):
    config, key, rows, meta, path = job
    job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': meta['hooks'], 'hooks': {}})
    empty = job_scripts.get_job_hooks(config, key)['hooks']
    assert empty == {'pre': '', 'post': '', 'post_when': 'success'}
    job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': empty,
                                      'hooks': {'post': rows[1]['id'], 'post_when': 'always'}})
    assert json.loads(path.read_text())['hooks']['post'] == rows[1]['id']
    assert all(not row['assignments'] for row in job_scripts.list_scripts_with_assignments(config)['scripts'] if row['id'] == rows[0]['id'])


@pytest.mark.parametrize('change', [
    {'hooks': {'pre': 'script-' + 'f' * 32}}, {'hooks': {'post_when': 'never'}},
    {'hooks': 'invalid'}, {'expected_hooks': None}, {'job_id': '../escape'},
    {'job_id': job_id('deleted')},
])
def test_invalid_edits_never_write(job, change):
    config, key, rows, meta, path = job
    before = path.read_bytes()
    with pytest.raises(ValueError):
        job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': meta['hooks'], 'hooks': {}, **change})
    assert path.read_bytes() == before


def test_concurrent_edits_only_one_writer_wins(job):
    config, key, rows, meta, path = job
    barrier = threading.Barrier(2)
    results = []
    def edit(hooks):
        barrier.wait()
        try:
            job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': meta['hooks'], 'hooks': hooks})
            results.append('saved')
        except job_scripts.ScriptValidationError as exc:
            results.append(exc.api_code)
    threads = [threading.Thread(target=edit, args=(hooks,)) for hooks in [{}, {'pre': rows[1]['id']}]]
    for thread in threads: thread.start()
    for thread in threads: thread.join(timeout=5)
    assert sorted(results) == ['job_script_conflict', 'saved']


def test_unreadable_job_does_not_get_replaced(job):
    config, key, rows, meta, path = job
    path.write_text('{broken')
    with pytest.raises(ValueError):
        job_scripts.save_job_hooks(config, {'job_id': key, 'expected_hooks': {}, 'hooks': {}})
    assert path.read_text() == '{broken'


def test_job_hook_http_routes_and_roles(job, monkeypatch):
    config, key, rows, meta, path = job
    handler = BackupUIHandler.__new__(BackupUIHandler)
    for method in ['GET', 'POST']:
        assert handler._required_role_for_request('/api/settings/job-hooks', method) == 'admin'
    monkeypatch.setattr(borg_backup_ui, '_log', lambda *_: None)
    class Handler(BackupUIHandler):
        def _authorize_api_request(self, *_): return True
        def _require_data_dir_ready(self): pass
        def log_message(self, *_): pass
    Handler.config = config
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    def request(method, payload=None):
        url = f'http://127.0.0.1:{server.server_port}/api/settings/job-hooks?job_id={key}'
        body = json.dumps(payload).encode() if payload is not None else None
        try:
            response = urlopen(Request(url, data=body, method=method,
                headers={'Content-Type': 'application/json'}), timeout=5)
        except HTTPError as exc:
            response = exc
        with response: return response.status, json.load(response)
    try:
        status, data = request('GET')
        assert status == 200 and data['hooks'] == meta['hooks']
        payload = {'job_id': key, 'expected_hooks': data['hooks'], 'hooks': {}}
        assert request('POST', payload)[0] == 200
        status, error = request('POST', payload)
        assert status == 409 and error['code'] == 'job_script_conflict'
        assert request('GET')[1]['hooks']['pre'] == ''
    finally:
        server.shutdown(); server.server_close(); worker.join(timeout=5)
