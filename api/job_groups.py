"""Persistent ordered groups of existing backup jobs (#570).

Groups coordinate only their own members. Existing job/resource locks remain
unchanged; a group guard prevents duplicate starts of that group, not other jobs.
No group or child is automatically replayed after loss of its coordinator.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from inventory_store import atomic_write_json, atomic_write_inventory, inventory_lock, read_inventory
from jobs_api import resolve_data_root
from security_utils import mask_secrets

_ACTIVE = {}
_ACTIVE_LOCK = threading.RLock()
_ID = re.compile(r"group-[a-f0-9]{32}\Z")
TERMINAL = {"success", "warning", "failed", "skipped", "cancelled", "stopped", "interrupted"}


def now():
    """Return a UTC timestamp for persisted group events."""
    return datetime.now(timezone.utc).isoformat()


def new_run_id():
    """Allocate an immutable run identity before any child can start."""
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:12]


def directory(config):
    """Return group state storage inside the existing data directory."""
    return resolve_data_root(config) / 'group-runs'


def store_path(config):
    """Return the group definition inventory."""
    return resolve_data_root(config) / 'config' / 'job-groups.json'


def identifier(value):
    """Validate an opaque group identity before filesystem access."""
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError('Invalid job group ID')
    return value


def definitions(config):
    """Read definitions without modifying existing configuration; fail on corruption."""
    data = read_inventory(store_path(config), collection_key='groups', schema_version=1)
    seen = set()
    for row in data['groups']:
        if not isinstance(row, dict) or identifier(row.get('id')) in seen:
            raise ValueError('Invalid or duplicate job group')
        seen.add(row['id'])
        validate_definition(row)
    return data


def validate_definition(payload):
    """Validate editable group fields without changing jobs, scripts or schedules."""
    from schedule_api import _validate_cron
    from job_identity import validate_job_id
    if not isinstance(payload, dict):
        raise ValueError('Job group must be an object')
    name = payload.get('name', '')
    description = payload.get('description', '')
    if not isinstance(name, str) or not name.strip() or len(name) > 100 or any(c in name for c in '\r\n\0'):
        raise ValueError('Group name must contain 1-100 characters on one line')
    if not isinstance(description, str) or len(description) > 2000:
        raise ValueError('Group description exceeds 2000 characters')
    members = payload.get('jobs')
    if not isinstance(members, list) or not 1 <= len(members) <= 100:
        raise ValueError('Select 1-100 jobs')
    members = [validate_job_id(key) for key in members]
    if len(set(members)) != len(members):
        raise ValueError('A job may occur only once in a group')
    policy = payload.get('on_error', 'stop')
    if policy not in ('stop', 'continue'):
        raise ValueError('Invalid group error policy')
    schedule = payload.get('schedule', {})
    if not isinstance(schedule, dict) or not isinstance(schedule.get('enabled', False), bool):
        raise ValueError('Invalid group schedule')
    cron = schedule.get('cron', '')
    if not isinstance(cron, str):
        raise ValueError('Invalid group cron expression')
    if cron or schedule.get('enabled'):
        _validate_cron(cron)
    return dict(name=name.strip(), description=description.strip(), jobs=members,
                on_error=policy, schedule={'enabled': schedule.get('enabled', False), 'cron': cron.strip()})


def save_group(config, payload, *, apply_schedule=True):
    """Create/update one group. Explicit edits never change individual jobs.

    Unknown jobs are rejected. A schedule installation error is returned as
    ``schedule_error`` with the saved ID so retrying does not duplicate a group.
    """
    from job_identity import active_job_ids
    row = validate_definition(payload)
    with inventory_lock(store_path(config).parent):
        if set(row['jobs']) - active_job_ids(config):
            raise ValueError('One or more selected jobs no longer exist')
        data = definitions(config)
        key = payload.get('id')
        if key:
            identifier(key)
            old = next((g for g in data['groups'] if g['id'] == key), None)
            if old is None:
                raise ValueError('Job group no longer exists')
        else:
            old = None
            key = 'group-' + uuid.uuid4().hex
        row['id'] = key
        row['schedule_since'] = (old or {}).get('schedule_since', now()) if old and old['schedule'] == row['schedule'] else now()
        data['groups'] = [g for g in data['groups'] if g['id'] != key] + [row]
        atomic_write_inventory(store_path(config), data)
    result = {'group': row, 'saved': True}
    if apply_schedule:
        _schedule_result(config, result)
    return result


def _apply_schedules(config):
    """Reinstall the existing combined crontab; propagate installation errors."""
    from schedule_api import apply_all_schedules
    return apply_all_schedules(config)


def _schedule_result(config, result):
    """Expose a failed cron installation without hiding a completed inventory edit."""
    try:
        _apply_schedules(config)
    except Exception as exc:
        result['schedule_error'] = mask_secrets(str(exc))


def _guard(config, group_id):
    """Return an exclusively locked handle, or reject an already running group."""
    path = directory(config) / (identifier(group_id) + '.guard')
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open('a+')
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise RuntimeError('This job group is already running') from None
    return handle


def _read(path):
    """Read one optional JSON object; malformed state raises instead of resetting it."""
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('Invalid group run state')
    return value


def _persist(config, run):
    """Durably replace latest state and archive terminal runs; update its timestamp."""
    run['updated_at'] = now()
    # The latest snapshot is durable at every transition. Archive terminal runs
    # once, avoiding two fsyncs for every live step on slower data volumes.
    if run['status'] in TERMINAL:
        atomic_write_json(directory(config) / 'history' / (run['run_id'] + '.json'), run)
    atomic_write_json(directory(config) / (run['group_id'] + '.json'), run)


def _owner_token(pid):
    """Identify the coordinator process across PID reuse and machine restarts."""
    try:
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        stat = Path(f'/proc/{int(pid)}/stat').read_text().rsplit(')', 1)[1].split()
        return boot + ':' + stat[19]
    except (OSError, ValueError, IndexError):
        return ''


def current_run(config, group_id):
    """Return latest run, recording a lost coordinator as interrupted once.

    The inherited guard may remain held by a surviving backup. It continues to
    prevent a duplicate group start, but no remaining steps are replayed.
    """
    key = identifier(group_id)
    with _ACTIVE_LOCK:
        run = _read(directory(config) / (key + '.json'))
        if run and run['status'] not in TERMINAL and (str(directory(config)), key) not in _ACTIVE:
            # Another server process can own a real coordinator. Never steal it.
            from jobs_api import _pid_alive
            if (not _pid_alive(int(run.get('owner_pid') or 0)) or run.get('owner_pid') == os.getpid()
                    or not run.get('owner_token') or run['owner_token'] != _owner_token(run.get('owner_pid'))):
                run['status'] = 'interrupted'
                run['finished_at'] = now()
                for step in run['steps']:
                    if step['status'] in ('running', 'pending'):
                        step['status'] = 'interrupted' if step['status'] == 'running' else 'not_run'
                _persist(config, run)
        return run


def list_groups(config):
    """Return definitions plus latest run and safe job hook labels for the UI."""
    from jobs_api import discover_jobs, resolve_scripts_dir
    from job_scripts import list_scripts
    jobs = {j.key: j for j in discover_jobs(resolve_scripts_dir(config), resolve_data_root(config))}
    scripts = {s['id']: s['name'] for s in list_scripts(config)['scripts']}
    hooks = {}
    for key in jobs:
        path = resolve_data_root(config) / 'config' / 'jobs' / (key + '.json')
        meta = _read(path) or {}
        hook = meta.get('hooks') or {}
        hooks[key] = {p: scripts.get(hook.get(p), '') for p in ('pre', 'post')}
    return {'groups': [{**g, 'run': current_run(config, g['id']),
                       'missing_jobs': [k for k in g['jobs'] if k not in jobs]}
                      for g in definitions(config)['groups']], 'hooks': hooks}


def delete_group(config, group_id):
    """Remove an idle definition, retaining its history and all referenced jobs."""
    key = identifier(group_id)
    with inventory_lock(store_path(config).parent), _guard(config, key):
        data = definitions(config)
        if not any(g['id'] == key for g in data['groups']):
            raise ValueError('Job group no longer exists')
        data['groups'] = [g for g in data['groups'] if g['id'] != key]
        atomic_write_inventory(store_path(config), data)
    result = {'deleted': True}
    _schedule_result(config, result)
    return result


def require_unassigned(config, job_id):
    """Reject deletion of a job referenced by a definition or active snapshot."""
    if any(job_id in g['jobs'] for g in definitions(config)['groups']):
        raise ValueError('Remove this job from its job groups before deleting it')
    for path in directory(config).glob('group-*.json'):
        run = current_run(config, path.stem)
        if run and run['status'] not in TERMINAL and any(s['job_key'] == job_id for s in run['steps']):
            raise ValueError('The job belongs to an active group run')


def start_group(config, group_id, *, scheduled=False, app_version='', actor='', request_id=''):
    """Snapshot and start a group asynchronously; never acquire repository locks.

    The guard only excludes another run of this same group. It is inherited by
    each backup so a service exit cannot release it while that child is alive.
    """
    from job_identity import active_job_ids
    key = identifier(group_id)
    with inventory_lock(store_path(config).parent), _ACTIVE_LOCK:
        group = next((g for g in definitions(config)['groups'] if g['id'] == key), None)
        if group is None:
            raise ValueError('Job group no longer exists')
        if scheduled and not group['schedule']['enabled']:
            return {'started': False, 'reason': 'schedule_disabled'}
        if set(group['jobs']) - active_job_ids(config):
            raise ValueError('A group member no longer exists')
        guard = _guard(config, key)
        token = (str(directory(config)), key)
        try:
            current_run(config, key)
            run = dict(group_id=key, group_name=group['name'], run_id=new_run_id(),
                       started_at=now(), owner_pid=os.getpid(), owner_token=_owner_token(os.getpid()), status='running',
                       on_error=group['on_error'], source='schedule' if scheduled else 'manual',
                       stop_requested=False, steps=[dict(job_key=j, status='pending') for j in group['jobs']])
            _persist(config, run)
            _ACTIVE[token] = run
            thread = threading.Thread(target=_execute, args=(dict(config), run, guard),
                                      kwargs={'app_version': app_version, 'actor': actor, 'request_id': request_id},
                                      name='job-group-' + key, daemon=True)
            thread.start()
        except Exception:
            _ACTIVE.pop(token, None)
            guard.close()
            raise
    return {'started': True, 'group_id': key, 'run_id': run['run_id']}


def stop_group(config, group_id, run_id):
    """Request stop after the current job, rejecting stale run identities."""
    with _ACTIVE_LOCK:
        run = _ACTIVE.get((str(directory(config)), identifier(group_id)))
        if not run or run['run_id'] != run_id or run['status'] in TERMINAL:
            raise ValueError('This group run is no longer active')
        run['stop_requested'] = True
        _persist(config, run)
    return {'stop_requested': True}


def _execute(config, run, guard, *, app_version='', actor='', request_id=''):
    """Run a fixed sequence and persist each transition before the next launch."""
    from job_launch import start_backup
    from job_control import read_control_state
    token = (str(directory(config)), run['group_id'])
    try:
        for step in run['steps']:
            with _ACTIVE_LOCK:
                if run['stop_requested']:
                    run['status'] = 'stopped'
                    break
                step.update(status='running', run_id=new_run_id(), started_at=now())
                _persist(config, run)
            child = {}
            try:
                start_backup(config, step['job_key'], app_version=app_version, actor=actor,
                             request_id=request_id, source='group', run_id=step['run_id'],
                             inherited_fds=(guard.fileno(),), state_sink=child, group_env={
                                 'BORG_UI_GROUP_ID': run['group_id'],
                                 'BORG_UI_GROUP_NAME': run['group_name'],
                                 'BORG_UI_GROUP_RUN_ID': run['run_id']})
            except Exception as exc:
                with _ACTIVE_LOCK:
                    step.update(status='failed', error=mask_secrets(str(exc)), finished_at=now())
                    _persist(config, run)
            if step['status'] == 'running':
                # Pin the process state: another manual run of the same job must
                # never replace the child whose completion this group awaits.
                state = child.get('state')
                if state is None or state.run_id != step['run_id']:
                    raise RuntimeError('Group child identity was lost')
                while not state.finished:
                    threading.Event().wait(0.1)
                control = read_control_state(step['run_id'])
                code = state.exit_code
                outcome = 'cancelled' if code == 130 or control.get('cancel_requested') else (
                    'skipped' if control.get('phase') == 'skipped' else
                    'success' if code == 0 else 'warning' if code == 1 else 'failed')
                with _ACTIVE_LOCK:
                    step.update(status=outcome, exit_code=code, finished_at=now(),
                                log_file=control.get('log_file', ''))
                    _persist(config, run)
            if step['status'] == 'cancelled':
                run['status'] = 'cancelled'
                break
            if step['status'] in ('failed', 'skipped') and run['on_error'] == 'stop':
                run['status'] = 'failed'
                break
        with _ACTIVE_LOCK:
            if run['status'] == 'running':
                statuses = {s['status'] for s in run['steps']}
                run['status'] = 'failed' if statuses & {'failed', 'skipped'} else (
                    'warning' if 'warning' in statuses else 'success')
    except Exception as exc:
        with _ACTIVE_LOCK:
            run['status'] = 'interrupted'
            run['error'] = mask_secrets(str(exc))
    finally:
        with _ACTIVE_LOCK:
            for step in run['steps']:
                if step['status'] == 'pending':
                    step['status'] = 'not_run'
                elif step['status'] == 'running':
                    step['status'] = 'interrupted'
            run['finished_at'] = now()
            try:
                _persist(config, run)
            finally:
                _ACTIVE.pop(token, None)
                guard.close()


def group_history(config, group_id, limit=50):
    """Return bounded historical snapshots for a group, newest first."""
    key = identifier(group_id)
    rows = []
    for path in sorted((directory(config) / 'history').glob('*.json'), reverse=True):
        row = _read(path)
        if row and row.get('group_id') == key:
            rows.append(row)
            if len(rows) >= limit:
                break
    return {'runs': rows}


def memberships(config):
    """Derive per-job membership metadata without copying job configuration."""
    result = {}
    for g in definitions(config)['groups']:
        for index, key in enumerate(g['jobs']):
            result.setdefault(key, []).append(dict(id=g['id'], name=g['name'], position=index + 1,
                                                  total=len(g['jobs']), schedule=g['schedule']))
    return result


def add_reminder_context(config, schedules, jobs, latest):
    """Monitor group schedules once per group, not prematurely per queued member.

    Running groups suppress missed-start reminders until their sequence ends.
    The activation timestamp prevents retroactive reminders for new schedules.
    Ordinary individual schedules are kept, including additional starts.
    """
    for group in definitions(config)['groups']:
        if not group['schedule']['enabled']:
            continue
        key = group['id']
        schedules[key] = dict(group['schedule'])
        jobs[key] = {'enabled': True, 'display_name': group['name'], 'name': group['name']}
        run = current_run(config, key)
        stamp = group.get('schedule_since') or now()
        if run and run['status'] not in TERMINAL:
            stamp = now()
        elif run and run['started_at'] > stamp:
            stamp = run['started_at']
        local = datetime.fromisoformat(stamp).astimezone().replace(tzinfo=None)
        latest[key] = {'timestamp': local.strftime('%Y-%m-%d %H:%M:%S'),
                       'status': run['status'] if run else 'configured'}


def prepare_import(config, exported, key_map, mode):
    """Validate complete groups before import writes; remap selected job IDs.

    Partial selections are reported and not imported. Existing group IDs are
    preserved for skip/overwrite or replaced for explicit rename imports.
    """
    if not isinstance(exported, list):
        raise ValueError('Job groups in an export must be a list')
    existing = {g['id'] for g in definitions(config)['groups']}
    rows, report, seen = [], [], set()
    for raw in exported:
        row = validate_definition(raw)
        key = identifier(raw.get('id'))
        if key in seen:
            raise ValueError('Duplicate group identity in import bundle')
        seen.add(key)
        if any(j not in key_map for j in row['jobs']):
            report.append({'name': row['name'], 'status': 'skipped_partial'})
            continue
        if key in existing and mode == 'skip':
            report.append({'name': row['name'], 'status': 'skipped_existing'})
            continue
        row['id'] = 'group-' + uuid.uuid4().hex if key in existing and mode == 'rename' else key
        row['jobs'] = [key_map[j] for j in row['jobs']]
        validate_definition(row)
        row['schedule_since'] = now()
        rows.append(row)
        report.append({'name': row['name'], 'status': 'imported'})
    return rows, report


def apply_import(config, rows):
    """Merge already validated group definitions without touching job schedules."""
    if not rows:
        return
    with inventory_lock(store_path(config).parent):
        data = definitions(config)
        keys = {r['id'] for r in rows}
        data['groups'] = [r for r in data['groups'] if r['id'] not in keys] + rows
        atomic_write_inventory(store_path(config), data)
