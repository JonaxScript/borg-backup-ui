"""Asynchronous administrator actions for managed database backups (#591)."""
from __future__ import annotations
import json
import threading
import uuid
from pathlib import Path

from database_profiles import DatabaseError, data_root, snapshot_profiles, list_profiles
from database_backup import export_profiles, reconcile_operations, open_staging, _descriptor_path, _private_path, cleanup_run, is_run_directory_name, utc_now, discover_databases, close_results
from inventory_store import atomic_write_json

_active = {}
_guard = threading.Lock()


def _state_path(config, identifier):
    import re
    if not re.fullmatch(r'[a-f0-9]{32}', identifier):
        raise DatabaseError('invalid_operation')
    return data_root(config) / 'database-tests' / (identifier + '.json')


def operation_status(config, identifier):
    """Return durable test status; mark a lost worker interrupted after process restart."""
    result = json.loads(_state_path(config, identifier).read_text())
    with _guard:
        active = identifier in _active
    if result['status'] == 'running' and not active:
        result.update(status='interrupted', error_code='database_unresolved_export')
    return result


def cancel_operation(config, identifier):
    """Request cancellation; the worker confirms container termination before completion."""
    _state_path(config, identifier)
    with _guard:
        event = _active.get(identifier)
        if event:
            event.set()
    return operation_status(config, identifier)


def start_operation(config, payload):
    """Start a bounded check/export/cleanup worker using the existing Docker resource lock."""
    from wizard_runner import ResourceLockSet
    from jobs_api import resolve_resource_lock_dir
    action = payload.get('action')
    if action not in ('discover', 'check', 'dump', 'cleanup', 'reconcile'):
        raise DatabaseError('invalid_operation')
    profiles = snapshot_profiles(config, [payload.get('profile_id')], allow_disabled=action != 'dump', require_databases=action == 'dump')
    profile = profiles[0]
    identifier = uuid.uuid4().hex
    event = threading.Event()
    state = {'id': identifier, 'profile_id': profile['id'], 'action': action, 'status': 'running', 'started_at': utc_now()}
    path = _state_path(config, identifier)
    locks = ResourceLockSet(resolve_resource_lock_dir(config),
                            job_key='database-test-' + identifier, operation='database-test', run_id=identifier)
    ok, _ = locks.acquire(['docker-control'])
    if not ok:
        raise DatabaseError('busy')
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write_json(path, state)
        with _guard:
            _active[identifier] = event
    except BaseException:
        locks.release()
        raise

    def worker():
        """Own locks through termination/reconciliation and persist only safe diagnostics."""
        try:
            reconcile_operations(config)
            if action in ('discover', 'check'):
                state['databases'] = discover_databases(config, profile, event.is_set)
            elif action == 'dump':
                state['results'] = []
                export_profiles(config, profiles, 'test', identifier, event.is_set, results=state['results'])
            elif action == 'cleanup':
                # Successful reconciliation under docker-control proves no exporter remains.
                cleanup_run(Path(str(payload.get('directory', ''))), profile, interrupted=True)
            state['status'] = 'completed'
        except DatabaseError as exc:
            state.update(status='cancelled' if exc.reason == 'cancelled' else 'failed', error_code=exc.api_code)
        except Exception:
            state.update(status='failed', error_code='database_operation_failed')
        finally:
            close_results(state.get('results', []))
            state['finished_at'] = utc_now()
            try:
                locks.release()
            finally:
                try:
                    atomic_write_json(path, state)
                finally:
                    with _guard:
                        _active.pop(identifier, None)
    try:
        threading.Thread(target=worker, name='database-' + identifier, daemon=True).start()
    except BaseException:
        locks.release()
        with _guard:
            _active.pop(identifier, None)
        raise
    return state.copy()


def retained_runs(config):
    """List current/legacy runs with profile snapshots, dates and byte counts.

    Never follow links or open an absent mount. Original sizes come from completed
    manifest entries; bytes includes all regular run files, including the manifest.
    """
    rows, errors = [], []
    for profile in list_profiles(config)['profiles']:
        try:
            with open_staging(profile, require_space=False) as fd:
                root = _descriptor_path(fd)
                for directory in sorted(root.glob('bbui-*'))[-500:]:
                    if not is_run_directory_name(directory.name) or directory.is_symlink() or not directory.is_dir():
                        continue
                    _private_path(directory)
                    path = directory / 'manifest.json'
                    if path.is_symlink() or not path.is_file():
                        continue
                    row = json.loads(path.read_text())
                    if row.get('profile_id') != profile['id']:
                        continue
                    rows.append({'profile_id': profile['id'], 'profile_name': row.get('profile_name') or profile['name'],
                                 'compression': row.get('compression', 'none'),
                                 'uncompressed_bytes': sum(f.get('uncompressed_bytes', f.get('bytes', 0)) for f in row.get('files', [])),
                                 'directory': str(Path(profile['staging_dir']) / directory.name), 'status': row.get('status'),
                                 'started_at': row.get('started_at'), 'archived': row.get('archived', False),
                                 'bytes': sum(p.stat().st_size for p in directory.iterdir() if p.is_file() and not p.is_symlink())})
        except DatabaseError as exc:
            errors.append({'profile_id': profile['id'], 'error_code': exc.api_code})
        except Exception:
            errors.append({'profile_id': profile['id'], 'error_code': 'database_invalid_storage'})
    return {'runs': rows, 'errors': errors}
