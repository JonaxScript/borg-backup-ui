"""Cancelled attempts retain dated evidence without reviving failed or expired proof (#609)."""
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from job_fixtures import job_id
from restore_test_reports import save_report
from restore_tests_api import build_restore_verification_map, list_restore_test_plan
from test_restore_tests_policy_contract import _make_job
from test_restore_test_runner_profiles import _load_restore_runner


@pytest.fixture
def reports(tmp_path):
    key = job_id('flash_local')
    directory = tmp_path / 'restore-status'
    directory.mkdir()
    latest = directory / f'{key}.test'
    now = datetime.now().replace(microsecond=0)
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path), 'RESTORE_TEST_STATUS_DIR': str(directory)}
    job = {'key': key, 'location': 'local', 'restore_test_policy': {'mode': 'scheduled', 'validity_days': 30}}

    def publish(result, days=0, **fields):
        report = {'job_id': key, 'test_result': result, 'test_date': (now-timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S'), **fields}
        save_report(latest, report)
        return report

    return latest, config, job, publish


def cancelled(publish):
    return publish('failed', failure_code='RT_CANCELLED', test_exit_code=130)


def test_cancel_preserves_success_expiry_and_latest_attempt(reports):
    latest, config, job, publish = reports
    success = publish('success', 2)
    before = build_restore_verification_map(config, [job])[job['key']]
    attempt = cancelled(publish)
    original = latest.read_bytes()
    after = build_restore_verification_map(config, [job])[job['key']]
    assert after['status'] == 'verified'
    assert after['valid_until'] == before['valid_until']
    assert after['evidence_test_date'] == success['test_date']
    assert after['last_test_date'] == attempt['test_date']
    assert after['last_test_result'] == 'cancelled'
    assert after['failure_code'] == ''
    assert latest.read_bytes() == original  # No rewrite/migration and no loss of the cancellation report.
    cancelled(publish)
    assert build_restore_verification_map(config, [job])[job['key']] == after


@pytest.mark.parametrize('mode,expected', [('scheduled','stale'), ('manual_only','verified'), ('off','not_required')])
def test_cancel_does_not_renew_expired_proof(reports, mode, expected):
    _, config, job, publish = reports
    job['restore_test_policy']['mode'] = mode
    publish('success', 40)
    before = build_restore_verification_map(config, [job])[job['key']]
    cancelled(publish)
    after = build_restore_verification_map(config, [job])[job['key']]
    assert after['status'] == expected
    assert after['valid_until'] == before['valid_until']
    assert after['is_overdue'] == before['is_overdue']


@pytest.mark.parametrize('result', ['failed', 'unavailable', 'unknown'])
def test_cancel_never_revives_success_over_later_failure(reports, result):
    _, config, job, publish = reports
    publish('success', 3)
    publish(result, 1, failure_code='RT_CHECK_FAILED', failure_hint='Actual failure')
    cancelled(publish)
    out = build_restore_verification_map(config, [job])[job['key']]
    assert out['status'] == 'failed'
    assert out['failure_code'] == 'RT_CHECK_FAILED'
    assert out['failure_hint'] == 'Actual failure'
    assert out['last_test_result'] == 'cancelled'


def test_same_second_failure_takes_precedence(reports):
    _, config, job, publish = reports
    publish('failed', 1)
    publish('success', 1)
    cancelled(publish)
    assert build_restore_verification_map(config, [job])[job['key']]['status'] == 'failed'


@pytest.mark.parametrize('prior', ['none', 'corrupt', 'undated', 'foreign', 'future'])
def test_unavailable_history_cannot_invent_proof(reports, prior):
    latest, config, job, publish = reports
    if prior == 'corrupt':
        latest.write_text('unreadable legacy evidence')
    elif prior == 'undated':
        publish('success', test_date='')
    elif prior == 'foreign':
        publish('success', job_id='another-job')
    elif prior == 'future':
        publish('success', -1)
    cancelled(publish)
    out = build_restore_verification_map(config, [job])[job['key']]
    assert out['status'] == 'never'
    assert out['last_test_result'] == 'cancelled'
    assert out['valid_until'] == ''


def test_busy_report_does_not_replace_prior_success(reports):
    _, config, job, publish = reports
    publish('success', 2)
    publish('skipped', 1, failure_code='RT_REPO_BUSY')
    cancelled(publish)
    assert build_restore_verification_map(config, [job])[job['key']]['status'] == 'verified'


def test_actual_failure_after_cancel_is_not_hidden(reports):
    _, config, job, publish = reports
    publish('success', 2)
    cancelled(publish)
    publish('failed', failure_code='RT_CHECK_FAILED')
    assert build_restore_verification_map(config, [job])[job['key']]['status'] == 'failed'


def test_plan_and_runner_keep_original_due_date_after_cancel(reports, tmp_path, monkeypatch):
    latest, config, job, publish = reports
    _make_job(tmp_path, job['key'])
    monkeypatch.setattr('schedule_api.installed_schedule_lines', lambda: [])
    publish('success', 2)
    before = list_restore_test_plan(config)['jobs'][0]
    cancelled(publish)
    after = list_restore_test_plan(config)['jobs'][0]
    assert after['last_test_result'] == 'cancelled'
    assert after['verification_status'] == 'verified'
    assert not after['is_overdue']
    assert after['next_due_at'] == before['next_due_at']
    runner = _load_restore_runner()
    tester = object.__new__(runner.RestoreTest)
    tester.args = SimpleNamespace(force=False)
    tester.status_dir = latest.parent
    tester.test_interval = 30
    tester.log = lambda *_: None
    assert not tester._should_test(job['key'])
    tester.args.force = True
    assert tester._should_test(job['key'])


def test_deleted_latest_does_not_resurrect_retained_history(reports):
    latest, config, job, publish = reports
    publish('success', 2)
    cancelled(publish)
    latest.unlink()
    assert build_restore_verification_map(config, [job])[job['key']]['status'] == 'never'
