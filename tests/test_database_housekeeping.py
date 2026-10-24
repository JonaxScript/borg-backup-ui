"""Retention must never discard active, unknown or unproven database state (#593)."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from database_housekeeping import prune_completed
from inventory_store import atomic_write_json
from jobs_api import resolve_resource_lock_dir
from wizard_runner import ResourceLockSet

NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)


def record(root, kind, *, age=31, status='completed', identifier='a'*32, **extra):
    """Build a real, private metadata record with controlled UTC completion age."""
    end = NOW - timedelta(days=age)
    row = {'token' if kind == 'database-operations' else 'id': identifier,
           'status': status, 'started_at': (end-timedelta(minutes=1)).isoformat(),
           'finished_at': end.isoformat(), **extra}
    path = root / kind / (identifier+'.json')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    atomic_write_json(path, row)
    return path


@pytest.mark.parametrize('kind,status', [('database-operations','completed'),('database-operations','failed'),
    ('database-operations','interrupted'),('database-tests','completed'),('database-tests','failed'),('database-tests','cancelled')])
def test_removes_only_expired_terminal_records(tmp_path, kind, status):
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path)}
    old=record(tmp_path,kind,status=status)
    boundary=record(tmp_path,kind,age=30,identifier='b'*32)
    recent=record(tmp_path,kind,age=1,identifier='c'*32)
    assert prune_completed(cfg,now=NOW)['removed']==1
    assert not old.exists() and boundary.exists() and recent.exists()
    assert prune_completed(cfg,now=NOW)['removed']==0


@pytest.mark.parametrize('change', [{'status':'running'}, {'status':'unresolved'}, {'status':'unknown'},
    {'finished_at':None}, {'finished_at':'2026-01-01'}, {'finished_at':'bad'}, {'started_at':'2026-11-01T00:00:00Z'},
    {'error_code':'database_unresolved_export'}, {'error_code':'database_operation_failed'}, {'token':'bad'}])
def test_preserves_uncertain_metadata(tmp_path, change):
    path=record(tmp_path,'database-operations',**change)
    prune_completed({'BACKUP_SCRIPTS_DIR':str(tmp_path)},now=NOW)
    assert path.exists()


def test_busy_resources_defer_cleanup(tmp_path):
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path)}
    path=record(tmp_path,'database-operations')
    locks=ResourceLockSet(resolve_resource_lock_dir(cfg),job_key='test')
    assert locks.acquire(['docker-control'])[0]
    try:
        assert prune_completed(cfg,now=NOW)['busy']
        assert path.exists()
    finally: locks.release()


def test_discovery_cleanup_requires_expired_linked_journal(tmp_path):
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path)}
    parent=tmp_path/'database-discovery';parent.mkdir(mode=0o700)
    completed=parent/'discovery-12345678';completed.mkdir(mode=0o700);(completed/'names').write_text('app')
    unknown=parent/'tmpoldstuff';unknown.mkdir(mode=0o700);(unknown/'names').write_text('keep')
    journal=record(tmp_path,'database-operations',discovery_directory=completed.name)
    pending=record(tmp_path,'database-operations',identifier='c'*32,status='running',discovery_directory=unknown.name)
    dumps=tmp_path/'dumps';dumps.mkdir();(dumps/'dump.gz').write_text('keep')
    secrets=tmp_path/'secrets';secrets.mkdir();(secrets/'secret.json').write_text('keep')
    result=prune_completed(cfg,now=NOW)
    assert result['removed']==1 and result['discovery_removed']==1
    assert not journal.exists() and not completed.exists()
    assert pending.exists() and unknown.exists() and (dumps/'dump.gz').exists() and (secrets/'secret.json').exists()


def test_symlinks_malformed_and_unknown_contents_preserved(tmp_path):
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path)}
    path=record(tmp_path,'database-tests');path.write_text('not json')
    outside=tmp_path/'outside';outside.write_text('keep')
    (path.parent/('b'*32+'.json')).symlink_to(outside)
    (path.parent/'notes.json').write_text('{}')
    parent=tmp_path/'database-discovery';parent.mkdir(mode=0o700)
    folder=parent/'discovery-12345678';folder.mkdir(mode=0o700);(folder/'names').symlink_to(outside)
    op=record(tmp_path,'database-operations',discovery_directory=folder.name)
    assert prune_completed(cfg,now=NOW)['removed']==0
    assert path.exists() and op.exists() and outside.read_text()=='keep'


def test_directory_symlink_is_never_followed(tmp_path):
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path/'data')}
    target=tmp_path/'other';path=record(target,'database-tests')
    (tmp_path/'data').mkdir(mode=0o700)
    (tmp_path/'data'/'database-tests').symlink_to(path.parent,target_is_directory=True)
    assert prune_completed(cfg,now=NOW)['removed']==0
    assert path.exists()
