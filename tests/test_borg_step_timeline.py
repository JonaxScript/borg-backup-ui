"""Measured four-command timelines, durable results and real Borg maintenance (#579)."""
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT, ROOT / 'api', ROOT / 'runtime', ROOT / 'runtime/lib'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import job_control
import jobs_api
from runtime.lib import borg_runner
from runtime.lib.status import BackupStatus


def make_runner(tmp_path, **config):
    control = job_control.JobControl('files_local', 'timeline-run-579', tmp_path / 'control')
    control.update_phase('preparing', cancel_allowed=True)
    runner = borg_runner.BorgRunner(
        borg_runner.BorgConfig(repo='test-repo', check_flag_file=tmp_path / 'checked', **config),
        process_controller=control,
        phase_callback=lambda phase: control.update_phase(phase, cancel_allowed=True),
    )
    return runner, control


@pytest.mark.parametrize('code,status', [(0,'success'), (1,'warning'), (2,'error'), (130,'cancelled'), (-9,'error')])
def test_step_measures_actual_result_and_survives_phase_changes(tmp_path, monkeypatch, code, status):
    runner, control = make_runner(tmp_path)
    tick = [100.0]
    monkeypatch.setattr(borg_runner.time, 'monotonic', lambda:tick[0])
    def execute(cmd, controller):
        state = json.loads(control.state_file.read_text())
        assert state['borg_steps']['compact']['status'] == 'running'
        assert state['phase'] == 'borg_compact'
        assert state['borg_progress']['percent'] is None
        tick[0] += 65.5
        return code
    monkeypatch.setattr(borg_runner, '_run_borg', execute)
    assert runner.compact() == code
    result = runner.steps['compact']
    assert result['status'] == status and result['duration_seconds'] == 65.5
    assert result['exit_code'] == code
    assert runner.steps['check']['status'] == 'pending'
    control.update_phase('post_script', cancel_allowed=False)
    control.update_phase('completed', cancel_allowed=False, finished=True, exit_code=code)
    state = json.loads(control.state_file.read_text())
    assert state['borg_steps'] == runner.steps and state['borg_progress'] is None


def test_exception_is_not_recorded_as_success(tmp_path, monkeypatch):
    runner, control = make_runner(tmp_path)
    def fail(*args):
        raise OSError('simulated process failure')
    monkeypatch.setattr(borg_runner, '_run_borg', fail)
    with pytest.raises(OSError):
        runner.prune('demo')
    assert runner.steps['prune']['status'] == 'error'
    assert runner.steps['prune']['duration_seconds'] >= 0
    assert json.loads(control.state_file.read_text())['borg_progress'] is None


def test_skips_are_explicit_and_have_no_fabricated_duration(tmp_path, monkeypatch):
    runner, control = make_runner(tmp_path, retention_policy={'mode':'all'})
    runner.config.check_flag_file.touch()
    monkeypatch.setattr(borg_runner, '_run_borg', lambda *args:0)
    assert runner.maintenance('demo') == 0
    assert runner.steps['prune'] == {'status':'skipped', 'reason':'keep_all'}
    assert runner.steps['check'] == {'status':'skipped', 'reason':'not_due'}
    assert runner.steps['compact']['status'] == 'success'
    assert runner.steps['create']['status'] == 'pending'


@pytest.mark.parametrize('code', [2, 130])
def test_maintenance_does_not_claim_later_steps_ran(tmp_path, monkeypatch, code):
    runner, control = make_runner(tmp_path)
    monkeypatch.setattr(borg_runner, '_run_borg', lambda *args:code)
    assert runner.maintenance('demo') == code
    assert runner.steps['prune']['status'] == ('cancelled' if code == 130 else 'error')
    assert runner.steps['compact']['status'] == runner.steps['check']['status'] == 'pending'


def test_status_report_retains_steps_without_live_control_files(tmp_path, monkeypatch):
    steps = {'create': {'status':'warning', 'duration_seconds':4.5}, 'check': {'status':'skipped', 'reason':'not_due'}}
    from job_fixtures import write_job
    meta = write_job(tmp_path, 'files_local')
    report = BackupStatus(job_id=meta['job_id'], run_id='saved-run-579', status='warning', exit_code=1,
                          timestamp='2026-10-22 14:32:00', duration_seconds=12, borg_steps=steps)
    path = report.save(tmp_path)
    loaded = BackupStatus.from_file(path)
    assert loaded.borg_steps == steps and loaded.run_id == 'saved-run-579'
    import status_api
    config = {'STATUS_DIR':str(tmp_path), 'BACKUP_SCRIPTS_DIR':str(tmp_path)}
    data = status_api.get_status_data(config)['backups'][0]
    assert data['borg_steps'] == steps and data['run_id'] == 'saved-run-579'
    jobs = jobs_api.list_jobs(config, {meta['job_id']:data})
    assert jobs[0]['last_borg_steps'] == steps and jobs[0]['last_duration_seconds'] == 12
    # Verify the persisted wire format, including a new instance after save.
    assert json.loads(path.read_text())['borg_steps'] == steps
    legacy = tmp_path / 'legacy.status'
    legacy.write_text('{"status":"success", "exit_code":0}')
    assert BackupStatus.from_file(legacy).borg_steps == {}


def test_ui_write_failure_does_not_change_command_result(tmp_path, monkeypatch):
    runner, control = make_runner(tmp_path)
    monkeypatch.setattr(borg_runner, '_run_borg', lambda *args:0)
    monkeypatch.setattr(control, 'update_borg_steps', lambda steps: (_ for _ in ()).throw(OSError('readonly')))
    assert runner.compact() == 0
    assert runner.steps['compact']['status'] == 'success'


def test_real_borg_prune_compact_progress_is_not_written_to_log(tmp_path, monkeypatch, caplog):
    borg = shutil.which('borg')
    if not borg:
        pytest.skip('Borg executable required for maintenance integration')
    for name in ('CACHE','SECURITY','KEYS'):
        monkeypatch.setenv(f'BORG_{name}_DIR', str(tmp_path / name.lower()))
    repo = tmp_path / 'repo'
    source = tmp_path / 'source.txt'
    subprocess.run([borg,'init','--encryption=none',str(repo)],check=True,capture_output=True)
    for i in range(2):
        source.write_text(f'Content {i}\n' * 1000)
        subprocess.run([borg,'create',f'{repo}::timeline-{i}',str(source)],check=True,capture_output=True)
    events = []
    controller = SimpleNamespace(update_borg_progress=events.append, attach_process=lambda p:None,
                                 detach_process=lambda:None, is_cancel_requested=lambda:False)
    runner = borg_runner.BorgRunner(borg_runner.BorgConfig(repo=str(repo),retention_policy={'mode':'last','last':1}),
                                   process_controller=controller)
    with caplog.at_level(logging.INFO, logger=borg_runner.logger.name):
        assert runner.prune('timeline') == 0
        prune_events = [e for e in events if e]
        events.clear()
        assert runner.compact() == 0
        compact_events = [e for e in events if e]
    assert prune_events and compact_events
    assert all(e['type'].startswith('progress_') for e in prune_events + compact_events)
    assert 'progress_percent' not in caplog.text and 'progress_message' not in caplog.text
    assert 'Borg prune succeeded' in caplog.text and 'Borg compact succeeded' in caplog.text
    assert 'Keeping archive' in caplog.text and 'Pruning archive (1/1)' in caplog.text
    assert 'Initializing cache transaction' not in caplog.text
    assert 'Saving chunks cache' not in caplog.text and 'Saving cache config' not in caplog.text
    assert all(record.getMessage().strip() for record in caplog.records
               if record.name == borg_runner.logger.name and record.levelno == logging.INFO)
    assert runner.steps['prune']['status'] == runner.steps['compact']['status'] == 'success'
    archives=json.loads(subprocess.check_output([borg,'list','--json',str(repo)]))['archives']
    assert len(archives) == 1


def test_backup_job_final_report_keeps_borg_outcomes_when_job_fails_later(tmp_path):
    from job_fixtures import job_id
    from runtime.lib.backup_job import BackupJob, BackupJobConfig
    config = BackupJobConfig(job_id=job_id('files_local'),job_name='files',backup_location='local',
                             status_dir=tmp_path,log_file=tmp_path/'run.log',backup_type='files',
                             lock_file=tmp_path/'backup.lock',log_dir=tmp_path,backup_paths=[tmp_path],
                             borg_cache_dir=tmp_path/'cache',date_tag='2026-10-22')
    job = BackupJob(config)
    job._borg_exit = 2  # e.g. a failed post hook must not erase successful commands.
    job._completion_repo_info = (0, ('unknown','unknown','unknown'))
    job.borg_steps = {name:{'status':'success','duration_seconds':2.5} for name in ('create','prune','compact','check')}
    path = job._save_status(20)
    report = BackupStatus.from_file(path)
    assert report.status == 'error' and report.borg_steps == job.borg_steps
    assert report.duration_seconds == 20
