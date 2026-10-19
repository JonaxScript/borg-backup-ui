"""Schedule activation and overdue regressions for #547 (no real crontab writes)."""
from datetime import datetime
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
for directory in (ROOT / 'api', ROOT / 'runtime'):
    sys.path.insert(0, str(directory))
import schedule_api
import notification_reminder_api as reminders


@pytest.fixture
def schedules(tmp_path, monkeypatch):
    """Provide stored schedules, a controlled server clock and a fake crontab."""
    clock = [datetime(2026, 9, 29, 12)]
    class Clock(datetime):
        @classmethod
        def now(cls):
            return clock[0]
    monkeypatch.setattr(schedule_api, 'datetime', Clock)
    monkeypatch.setattr(schedule_api, '_known_job_keys', lambda c: {'demo', 'other'})
    monkeypatch.setattr(schedule_api, 'restore_test_cron_lines', lambda c: {})
    monkeypatch.setattr('job_groups.definitions', lambda c: {'groups': []})
    monkeypatch.setattr(schedule_api, '_update_crontab', lambda lines: {'changed': True})
    config = {'BACKUP_SCRIPTS_DIR': str(tmp_path)}
    path = tmp_path / 'config' / 'schedules.json'
    path.parent.mkdir()
    path.write_text(json.dumps({'demo': {'cron': '30 1 * * 1,3,5', 'enabled': True}}))
    return config, clock, path


def evaluate(config, now, last=None):
    """Evaluate the actual stored row against a successful historical backup."""
    return reminders._backup_overdue_item(
        'demo', schedule_api.get_schedules(config)['demo'], {'name': 'Demo'},
        last if last is not None else {'timestamp': '2026-09-28 01:40:09', 'status': 'success'},
        {}, now, 24, 6,
    )


def test_changed_schedule_does_not_invent_past_run_but_detects_next_missed_run(schedules):
    config, clock, _ = schedules
    schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    row = schedule_api.get_schedules(config)['demo']
    assert row['effective_since'] == '2026-09-29T12:00:00'
    assert 'pending_apply' not in row
    item = evaluate(config, clock[0])
    assert item['state'] == 'current'
    assert item['expected_run'] == '2026-09-30T03:15:00'
    assert item['next_scheduled_run'] == item['expected_run']
    assert item['latest_status_at'] == '2026-09-28T01:40:09'
    assert evaluate(config, datetime(2026, 9, 30, 9, 15))['state'] == 'current'
    assert evaluate(config, datetime(2026, 9, 30, 9, 15, 1))['state'] == 'overdue_ready'
    assert evaluate(config, datetime(2026, 9, 30, 12), {'timestamp': '2026-09-30 03:25:00', 'status': 'success'})['state'] == 'current'


def test_noop_save_and_reapply_preserve_effective_time_and_genuine_overdue(schedules):
    config, clock, _ = schedules
    schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    original = schedule_api.get_schedules(config)['demo']
    clock[0] = datetime(2026, 9, 30, 12)
    schedule_api.save_schedule(config, 'demo', ' 15  3 * * 1,3,5 ', True)
    schedule_api.apply_all_schedules(config)
    assert schedule_api.get_schedules(config)['demo'] == original
    assert evaluate(config, clock[0])['state'] == 'overdue_ready'


def test_legacy_noop_save_keeps_previous_detection_without_inventing_activation(schedules):
    config, clock, _ = schedules
    before = schedule_api.get_schedules(config)
    schedule_api.save_schedule(config, 'demo', '30 1 * * 1,3,5', True)
    schedule_api.apply_all_schedules(config)
    assert schedule_api.get_schedules(config) == before
    assert evaluate(config, datetime(2026, 9, 30, 12))['state'] == 'overdue_ready'
    assert evaluate(config, clock[0], {})['state'] == 'missing_status'


def test_reenable_starts_new_window_but_disabled_noop_does_not_activate(schedules):
    config, clock, _ = schedules
    schedule_api.save_schedule(config, 'demo', '30 1 * * 1,3,5', False)
    schedule_api.save_schedule(config, 'demo', '30 1 * * 1,3,5', False)
    assert schedule_api.get_schedules(config)['demo'] == {'cron': '30 1 * * 1,3,5', 'enabled': False}
    clock[0] = datetime(2026, 9, 30, 12)
    schedule_api.save_schedule(config, 'demo', '30 1 * * 1,3,5', True)
    assert schedule_api.get_schedules(config)['demo']['effective_since'] == '2026-09-30T12:00:00'
    assert evaluate(config, clock[0])['state'] == 'current'
    assert evaluate(config, datetime(2026, 10, 2, 8))['state'] == 'overdue_ready'


def test_failed_apply_is_pending_and_successful_retry_uses_retry_time(schedules, monkeypatch):
    config, clock, _ = schedules
    def fail(lines):
        raise RuntimeError('crontab unavailable')
    monkeypatch.setattr(schedule_api, '_update_crontab', fail)
    with pytest.raises(RuntimeError, match='Schedule saved but could not be applied'):
        schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    assert schedule_api.get_schedules(config)['demo'] == {
        'cron': '15 3 * * 1,3,5', 'enabled': True, 'pending_apply': True,
    }
    assert evaluate(config, clock[0])['state'] == 'schedule_pending'
    clock[0] = datetime(2026, 9, 30, 12)
    monkeypatch.setattr(schedule_api, '_update_crontab', lambda lines: {'changed': True})
    schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    assert schedule_api.get_schedules(config)['demo']['effective_since'] == '2026-09-30T12:00:00'
    assert evaluate(config, clock[0])['expected_run'] == '2026-10-02T03:15:00'


def test_failed_noop_apply_does_not_reset_existing_overdue(schedules, monkeypatch):
    config, clock, _ = schedules
    before = schedule_api.get_schedules(config)
    monkeypatch.setattr(schedule_api, '_update_crontab', lambda lines: (_ for _ in ()).throw(RuntimeError('failed')))
    with pytest.raises(RuntimeError):
        schedule_api.save_schedule(config, 'demo', '30 1 * * 1,3,5', True)
    assert schedule_api.get_schedules(config) == before
    assert evaluate(config, datetime(2026, 9, 30, 12))['state'] == 'overdue_ready'


def test_import_does_not_trust_foreign_activation_metadata(schedules):
    config, clock, _ = schedules
    schedule_api.write_schedules(config, {'demo': {
        'cron': '15 3 * * 1,3,5', 'enabled': True,
        'effective_since': '2099-01-01T00:00:00', 'pending_apply': False,
    }})
    assert evaluate(config, clock[0])['state'] == 'schedule_pending'
    schedule_api.apply_all_schedules(config)
    original = schedule_api.get_schedules(config)['demo']
    assert original['effective_since'] == '2026-09-29T12:00:00'
    schedule_api.write_schedules(config, {'demo': {**original, 'effective_since': '2099-01-01T00:00:00'}})
    assert schedule_api.get_schedules(config)['demo'] == original


def test_new_schedule_without_status_detects_only_post_activation_misses(schedules):
    config, clock, path = schedules
    path.write_text('{}')
    schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    assert evaluate(config, clock[0], {})['state'] == 'current'
    assert evaluate(config, datetime(2026, 9, 30, 12), {})['state'] == 'overdue_ready'


def test_unrelated_save_and_delete_preserve_activation_metadata(schedules):
    config, clock, _ = schedules
    schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    original = schedule_api.get_schedules(config)['demo']
    clock[0] = datetime(2026, 9, 30, 12)
    schedule_api.save_schedule(config, 'other', '0 2 * * *', True)
    schedule_api.delete_schedule(config, 'other')
    assert schedule_api.get_schedules(config)['demo'] == original
    assert evaluate(config, clock[0])['state'] == 'overdue_ready'


def test_pending_survives_failure_to_persist_activation(schedules, monkeypatch):
    config, clock, _ = schedules
    schedule_api.write_schedules(config, {'demo': {'cron': '15 3 * * 1,3,5', 'enabled': True}})
    monkeypatch.setattr(schedule_api, 'atomic_write_json', lambda *args: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(OSError, match='disk full'):
        schedule_api.apply_all_schedules(config)
    assert evaluate(config, clock[0])['state'] == 'schedule_pending'


def test_dashboard_and_reminder_sender_agree_on_activation(schedules, monkeypatch):
    import status_api
    from lib.notifications import MailConfig
    config, clock, _ = schedules
    config.update(NOTIFY_BACKUP_OVERDUE_TOLERANCE_HOURS='6')
    monkeypatch.setattr(reminders, 'datetime', schedule_api.datetime)
    jobs = [{'key': 'demo', 'name': 'Demo', 'enabled': True, 'repo_path': '/repo'}]
    backup = {'key': 'demo', 'timestamp': '2026-09-28 01:40:09', 'status': 'success'}
    monkeypatch.setattr('jobs_api.list_jobs', lambda *args: jobs)
    monkeypatch.setattr(status_api, 'get_status_data', lambda c: {'backups': [dict(backup)]})
    delivered = []
    monkeypatch.setattr('lib.notification_events.send_event', lambda c, event, **kw: delivered.append(event) or {'test': True})
    monkeypatch.setattr('lib.notification_events.mark_reminder_sent', lambda *args, **kw: None)
    mail = MailConfig.from_config(config)
    schedule_api.write_schedules(config, {'demo': {'cron': '15 3 * * 1,3,5', 'enabled': True}})
    assert reminders._send_backup_overdue_reminders(config, mail)['sent'] == 0
    rows = [dict(backup)]
    status_api._apply_backup_overdue_metadata(config, rows, now=clock[0])
    assert rows[0]['backup_overdue_state'] == 'schedule_pending'
    schedule_api.apply_all_schedules(config)
    assert reminders._send_backup_overdue_reminders(config, mail)['sent'] == 0
    status_api._apply_backup_overdue_metadata(config, rows, now=clock[0])
    assert rows[0]['backup_overdue'] is False
    assert rows[0]['backup_overdue_expected_run'] == '2026-09-30T03:15:00'
    clock[0] = datetime(2026, 9, 30, 12)
    schedule_api.save_schedule(config, 'demo', '15 3 * * 1,3,5', True)
    assert reminders._send_backup_overdue_reminders(config, mail)['sent'] == 1
    assert len(delivered) == 1
    assert delivered[0].extra['expected_run'] == '2026-09-30 03:15:00'
    status_api._apply_backup_overdue_metadata(config, rows, now=clock[0])
    assert rows[0]['backup_overdue'] is True


def test_parallel_saves_do_not_lose_other_jobs_or_activation(schedules):
    from concurrent.futures import ThreadPoolExecutor
    config, clock, _ = schedules
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(schedule_api.save_schedule, config, key, cron, True)
                 for key, cron in [('demo', '15 3 * * 1,3,5'), ('other', '0 2 * * *')]]
        for task in tasks:
            assert task.result(timeout=10)['applied'] is True
    rows = schedule_api.get_schedules(config)
    assert set(rows) == {'demo', 'other'}
    assert all(row['effective_since'] == '2026-09-29T12:00:00' for row in rows.values())
