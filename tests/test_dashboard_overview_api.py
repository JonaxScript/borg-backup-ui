"""Management overview: actual outcomes, shared repositories and honest gaps (#607)."""
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from job_fixtures import write_job
from dashboard_overview import get_dashboard_overview


@pytest.fixture
def overview(tmp_path):
    status = tmp_path / 'status'
    status.mkdir()
    a = write_job(tmp_path, 'appdata_local', repository_key='shared')['job_id']
    b = write_job(tmp_path, 'photos_local', repository_key='shared')['job_id']
    c = write_job(tmp_path, 'flash_usb', repository_key='other')['job_id']
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path), 'STATUS_DIR': str(status)}
    def save(key, date, outcome='success', **extra):
        row = dict(job_id=key, timestamp=date, status=outcome, **extra)
        (status / f'{len(list(status.glob("*.status")))}.status').write_text(json.dumps(row))
    def read(days=7, location='all'):
        return get_dashboard_overview(config, days, location, now=datetime(2026, 10, 27, 12, tzinfo=timezone.utc))
    return a, b, c, save, read, status


def test_outcomes_date_range_duplicates_and_current_location(overview):
    a, b, c, save, read, status = overview
    save(a, '2026-10-20T23:59:00+00:00')  # outside seven calendar days
    save(a, '2026-10-21T00:00:00+00:00', run_id='once', duration_seconds=60)
    save(a, '2026-10-21T00:00:00+00:00', run_id='once', duration_seconds=60)
    save(b, '2026-10-22T10:00:00+00:00', 'error', duration_seconds=0)
    save(b, '2026-10-23T10:00:00+00:00', 'warning')
    save(c, '2026-10-24T10:00:00+00:00', 'skipped')
    save(c, '2026-10-25T10:00:00+00:00', 'cancelled')
    save(c, '2026-10-26T10:00:00+00:00', 'future-outcome')
    save(a, '2026-10-28T10:00:00+00:00')
    save('removed', '2026-10-26T10:00:00+00:00')
    save(a, 'invalid')
    (status / 'broken.status').write_text('not json')
    (status / 'array.status').write_text('[]')
    data = read()
    assert data['run_count'] == 6
    assert data['counts'] == dict(success=1, warning=1, error=1, skipped=1, cancelled=1, unknown=1)
    assert data['success_rate'] == pytest.approx(100 / 3)
    assert data['average_duration_seconds'] == 30
    assert len(data['daily']) == 7
    assert read(location='usb')['run_count'] == 3
    assert read(location='usb')['success_rate'] is None
    assert read(30)['run_count'] == 7


def test_repository_samples_deduplicate_shared_storage_and_keep_missing_unknown(overview):
    a, b, c, save, read, _ = overview
    save(a, '2026-10-20T10:00:00+00:00', repository_size=1000)
    save(b, '2026-10-22T10:00:00+00:00', repository_size=1200)
    save(a, '2026-10-23T10:00:00+00:00', 'error', deduplicated_size=9999, repository_size=0)
    save(c, '2026-10-24T10:00:00+00:00', repository_size=2000)
    data = read()
    assert data['repository_count'] == 2
    assert data['daily'][0]['repository_bytes'] == 1000
    assert data['daily'][0]['measured_repositories'] == 1
    assert data['daily'][-1]['repository_bytes'] == 3200
    assert read(location='local')['daily'][-1]['repository_bytes'] == 1200
    assert read(location='usb')['daily'][0]['repository_bytes'] is None
    assert data['repository_last_sample'].startswith('2026-10-24')


def test_empty_unknown_and_invalid_filters(overview):
    a, _, _, save, read, _ = overview
    assert read()['success_rate'] is None
    assert read()['daily'][-1]['repository_bytes'] is None
    save(a, '2026-10-24T10:00:00+00:00', repository_size=-4, duration_seconds=float('nan'))
    save(a, '2026-10-25T10:00:00+00:00', repository_size=True)
    assert read()['daily'][-1]['repository_bytes'] is None
    assert read()['average_duration_seconds'] is None
    for days, location in [(8, 'all'), (7, 'invalid')]:
        with pytest.raises(ValueError):
            read(days, location)


def test_http_overview_authentication_and_validation(monkeypatch, tmp_path):
    import http.client
    import threading
    import borg_backup_ui
    from borg_backup_ui import BackupUIHandler, ThreadedHTTPServer
    monkeypatch.setattr(borg_backup_ui, '_log', lambda *_: None)
    class Handler(BackupUIHandler):
        def _auth_store_failure(self): return ''
        def _ui_auth_enabled(self): return False
        def _get_api_token(self): return 'overview-test-token'
        def _get_current_role(self): return 'viewer'
        def _security_audit(self, *_args, **_kwargs): pass
    Handler.config = {'BACKUP_SCRIPTS_DIR': str(tmp_path), 'STATUS_DIR': str(tmp_path)}
    assert Handler.__new__(Handler)._required_role_for_request('/api/reports/overview', 'GET') == 'viewer'
    server = ThreadedHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for query, token, expected in [('?days=7', '', 401), ('?days=7', 'overview-test-token', 200),
                                       ('?days=999', 'overview-test-token', 400), ('?location=bad', 'overview-test-token', 400)]:
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
            conn.request('GET', '/api/reports/overview' + query, headers={'Authorization': 'Bearer ' + token} if token else {})
            response = conn.getresponse()
            body = json.loads(response.read())
            assert response.status == expected
            if expected == 200:
                assert body['run_count'] == 0 and len(body['daily']) == 7
            conn.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
