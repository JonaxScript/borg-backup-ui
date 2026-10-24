"""Unraid writable-pool access and descriptor lifetime regressions (#591)."""
import copy
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import database_backup as backup
import database_api
from database_profiles import DatabaseError
from test_database_backups import config, profile, fake_export


@pytest.fixture
def pool(monkeypatch, profile):
    """Keep real directory/FD checks; substitute only mount/type detection."""
    mount = Path(profile['staging_mount'])
    mount.chmod(0o777)
    monkeypatch.setattr(backup.os.path, 'ismount', lambda p: p == mount)
    monkeypatch.setattr(backup, '_run', lambda *a, **kw: Mock(stdout='xfs'))
    return mount


def test_writable_pool_and_foreign_pool_owner_are_accepted(monkeypatch, profile, pool):
    original = backup.os.fstat
    def foreign_pool_owner(fd):
        info = original(fd)
        if info.st_ino == pool.stat().st_ino:
            values = list(info); values[4] = 65534; values[5] = 100
            return os.stat_result(values)
        return info
    monkeypatch.setattr(backup.os, 'fstat', foreign_pool_owner)
    with backup.open_staging(profile) as fd:
        assert backup._descriptor_path(fd).samefile(profile['staging_dir'])
    assert pool.stat().st_mode & 0o777 == 0o777
    with pytest.raises(OSError): os.fstat(fd)


@pytest.mark.parametrize('mode', [0o755, 0o770, 0o777])
def test_only_dump_directory_must_be_private(profile, pool, mode):
    Path(profile['staging_dir']).chmod(mode)
    with pytest.raises(DatabaseError, match='storage_permissions'):
        backup.staging_root(profile)


def test_foreign_dump_owner_is_rejected(monkeypatch, profile, pool):
    original = backup.os.fstat
    inode = Path(profile['staging_dir']).stat().st_ino
    def foreign_dump_owner(fd):
        info = original(fd)
        if info.st_ino == inode:
            values = list(info); values[4] = os.geteuid() + 1
            return os.stat_result(values)
        return info
    monkeypatch.setattr(backup.os, 'fstat', foreign_dump_owner)
    with pytest.raises(DatabaseError, match='storage_permissions'): backup.staging_root(profile)


def test_only_export_creates_missing_direct_child(profile, pool):
    root = Path(profile['staging_dir']); root.rmdir()
    with pytest.raises(DatabaseError, match='storage_path'):
        backup.staging_root(profile, require_space=False)
    assert not root.exists()
    backup.staging_root(profile)
    assert root.stat().st_mode & 0o777 == 0o700
    assert pool.stat().st_mode & 0o777 == 0o777


def test_missing_mount_and_unsupported_filesystem_do_not_create(monkeypatch, profile, pool):
    root = Path(profile['staging_dir']); root.rmdir()
    monkeypatch.setattr(backup.os.path, 'ismount', lambda p: False)
    with pytest.raises(DatabaseError, match='storage_mount'): backup.staging_root(profile)
    monkeypatch.setattr(backup.os.path, 'ismount', lambda p: True)
    monkeypatch.setattr(backup, '_run', lambda *a, **kw: Mock(stdout='tmpfs'))
    with pytest.raises(DatabaseError, match='storage_filesystem'): backup.staging_root(profile)
    assert not root.exists()


@pytest.mark.parametrize('component', ['mount', 'intermediate', 'dump'])
def test_symlink_components_are_rejected(profile, pool, component):
    root = Path(profile['staging_dir'])
    if component == 'mount':
        alias = pool / 'alias'; alias.symlink_to(pool, target_is_directory=True)
        profile.update(staging_mount=str(alias), staging_dir=str(alias / root.name))
    elif component == 'intermediate':
        alias = pool / 'alias'; alias.symlink_to(pool, target_is_directory=True)
        profile['staging_dir'] = str(alias / root.name)
    else:
        root.rmdir(); root.symlink_to(pool, target_is_directory=True)
    with pytest.raises(DatabaseError, match='storage_path'): backup.staging_root(profile)


def test_nested_dump_under_writable_parent(profile, pool):
    parent = pool / 'shared'; parent.mkdir(mode=0o777); parent.chmod(0o777)
    root = parent / 'private'; root.mkdir(mode=0o700)
    profile['staging_dir'] = str(root)
    assert backup.staging_root(profile) == root


def test_path_replacement_during_export_cannot_redirect_io(config, profile, pool, monkeypatch):
    fake_export(monkeypatch, profile)
    root = Path(profile['staging_dir']); original = root.with_name('original')
    def replace_during_probe(*args):
        root.rename(original)
        root.mkdir(mode=0o700)
        return {'server_version':'11.4.9', 'client_version':'11.4.9', 'extensions':[]}
    monkeypatch.setattr(backup, '_probe', replace_during_probe)
    results = backup.export_profiles(config, [profile], 'job', 'run')
    try:
        run = Path(results[0]['directory']).name
        import gzip
        assert gzip.decompress((original/run/'app.sql.gz').read_bytes()).startswith(b'CREATE TABLE')
        assert list(root.iterdir()) == []
        backup.write_manifest(results[0])
        assert copy.deepcopy(results) == json.loads(json.dumps(results))
        assert type(copy.deepcopy(results)[0]) is dict
        backup.cleanup_run(results[0], profile)
        assert list(original.iterdir()) == []
        assert list(root.iterdir()) == []
    finally:
        fd = results[0]._root_fd
        backup.close_results(results)
        backup.close_results(results)
        with pytest.raises(OSError): os.fstat(fd)


def test_retained_listing_reports_precise_storage_error(config, profile, pool, monkeypatch):
    monkeypatch.setattr(database_api, 'list_profiles', lambda config: {'profiles':[profile]})
    Path(profile['staging_dir']).chmod(0o755)
    assert database_api.retained_runs(config) == {'runs':[], 'errors':[{'profile_id':profile['id'], 'error_code':'database_storage_permissions'}]}


def test_retained_cleanup_on_writable_pool_and_no_fd_in_json(config, profile, pool, monkeypatch):
    fake_export(monkeypatch, profile)
    results = backup.export_profiles(config, [profile], 'job', 'run')
    backup.close_results(results)
    monkeypatch.setattr(database_api, 'list_profiles', lambda config: {'profiles':[profile]})
    listing = database_api.retained_runs(config)
    assert not listing['errors'] and listing['runs'][0]['directory'] == results[0]['directory']
    assert '/proc/' not in json.dumps(results)
    backup.cleanup_run(results[0]['directory'], profile)
    assert database_api.retained_runs(config)['runs'] == []


@pytest.mark.skipif(shutil.which('borg') is None, reason='Borg executable required')
def test_real_borg_uses_held_directory_after_replacement(config, profile, pool, monkeypatch, tmp_path):
    fake_export(monkeypatch, profile)
    results = backup.export_profiles(config, [profile], 'job', 'run')
    try:
        root = Path(profile['staging_dir']); root.rename(root.with_name('original'))
        root.mkdir(mode=0o700)
        for key in ('BORG_CACHE_DIR', 'BORG_SECURITY_DIR'):
            monkeypatch.setenv(key, str(tmp_path/key))
        monkeypatch.setenv('BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK', 'yes')
        repo = str(tmp_path/'repo')
        def borg(*args):
            return subprocess.check_output(['borg', *args], stderr=subprocess.PIPE, text=True, timeout=60)
        borg('init', '--encryption=none', repo)
        archive = 'appdata-backup-2026-10-24_12-40-29'
        borg('create', repo+'::'+archive, *backup.borg_artifact_paths(results))
        before = borg('list', '--json', repo)
        with pytest.raises(subprocess.CalledProcessError):
            borg('create', repo+'::'+archive, *backup.borg_artifact_paths(results))
        assert borg('list', '--json', repo) == before
        paths = borg('list', '--short', repo+'::'+archive).splitlines()
        assert sorted(paths) == sorted(results[0]['archive_directory']+'/'+name for name in ['app.sql.gz','manifest.json'])
        backup.verify_archive(repo, archive, results)
        backup.write_manifest(results[0])
        backup.cleanup_run(results[0], profile, verified=True)
        assert not list(root.iterdir())
    finally:
        backup.close_results(results)


def test_nested_unsupported_filesystem_is_rejected(monkeypatch, profile, pool):
    values = iter(['xfs', 'nfs'])
    monkeypatch.setattr(backup, '_run', lambda *a, **kw: Mock(stdout=next(values)))
    with pytest.raises(DatabaseError, match='storage_filesystem'): backup.staging_root(profile)


def test_export_failure_retains_manifest_and_releases_handle(config, profile, pool, monkeypatch):
    fake_export(monkeypatch, profile, 'export_failed')
    results = []
    try:
        with pytest.raises(DatabaseError, match='export_failed'):
            backup.export_profiles(config, [profile], 'job', 'run', results=results)
        assert results[0]['status'] == 'failed'
        fd = results[0]._root_fd
    finally:
        backup.close_results(results)
    with pytest.raises(OSError): os.fstat(fd)
    assert (Path(results[0]['directory'])/'app.sql.gz.partial').is_file()
