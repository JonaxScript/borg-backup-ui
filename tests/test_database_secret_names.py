"""Readable immutable database credentials and resumable legacy migration (#591)."""
import json
from pathlib import Path

import pytest
from test_database_backups import profiles, config, profile
from inventory_store import atomic_write_json
from migrations import database_secret_names_v1 as migration


def legacy(config, profile):
    """Create an old profile/secret pair without using the new save path."""
    row = {**profile, 'auth_mode':'managed', 'database_user':'root', 'credential_id':'a'*32}
    row.pop('credential_file')
    secret = profiles.secret_path(config, row['credential_id'])
    atomic_write_json(secret, {'password':'legacy-private-value'})
    atomic_write_json(profiles.store_path(config), {'schema_version':1, 'profiles':[row]})
    return row, secret


def test_legacy_migration_is_idempotent_private_and_restorable(config, profile):
    old, original = legacy(config, profile)
    before = profiles.store_path(config).read_bytes()
    assert migration.detect(config)['required']
    result = migration.apply(config)
    assert result['status']=='applied'
    new = profiles.list_profiles(config)['profiles'][0]
    assert new['credential_id']=='database-db-v001'
    assert profiles.read_password(config,new)==profiles.read_password(config,old)=='legacy-private-value'
    assert original.exists()
    backup = Path(result['details']['backup_directory'])
    assert (backup/'profiles.before.json').read_bytes()==before
    assert backup.stat().st_mode & 0o777==0o700
    assert profiles.secret_path(config,new['credential_id']).stat().st_mode & 0o777==0o600
    assert not migration.detect(config)['required']
    assert migration.apply(config)['status']=='not_required'
    assert len(list(original.parent.glob('database-*.json')))==1
    assert 'legacy-private-value' not in migration._journal(config).read_text()
    assert 'legacy-private-value' not in (profiles.store_path(config).parent/'migrations.log.jsonl').read_text()
    # Restored old configuration references still work; rechecking produces no data loss.
    profiles.store_path(config).write_bytes(before)
    assert profiles.read_password(config,profiles.list_profiles(config)['profiles'][0])=='legacy-private-value'
    assert migration.detect(config)['required']


def test_migration_resumes_after_secret_copy_without_duplicate_versions(config, profile, monkeypatch):
    old, original = legacy(config, profile)
    real_write = migration.atomic_write_bytes
    def fail_profile(path, content):
        if path==profiles.store_path(config):
            raise OSError('simulated profile write failure')
        return real_write(path, content)
    monkeypatch.setattr(migration,'atomic_write_bytes',fail_profile)
    with pytest.raises(OSError):migration.apply(config)
    assert profiles.list_profiles(config)['profiles'][0]['credential_id']==old['credential_id']
    assert migration.detect(config)['required']
    monkeypatch.setattr(migration,'atomic_write_bytes',real_write)
    assert migration.apply(config)['status']=='applied'
    assert len(list(original.parent.glob('database-*.json')))==1


def test_migration_failure_blocks_later_registry_actions(config, profile, monkeypatch):
    from migrations import registry
    old, secret = legacy(config, profile)
    secret.unlink()
    class Later:
        MIGRATION_ID='after_database'
        INTRODUCED_IN='2026.10.24'
        @staticmethod
        def detect(_):raise AssertionError('must not run after failure')
    monkeypatch.setattr(registry,'MIGRATIONS',[migration,Later])
    result = registry.run_startup_migrations(config)
    assert result['status']=='failed'
    state = registry.read_central_migration_state(config)['migrations']
    assert state[migration.MIGRATION_ID]['state']=='failed'
    assert state[Later.MIGRATION_ID]['state']=='blocked'
    assert profiles.list_profiles(config)['profiles'][0]['credential_id']==old['credential_id']


def test_duplicate_names_rotation_and_renaming_keep_old_snapshots(config, profile):
    raw = {**profile,'id':None,'auth_mode':'managed','database_user':'root','name':'Sicherung MariaDB','password':'one'}
    first = profiles.save_profile(config,raw)['profile']
    second = profiles.save_profile(config,{**raw,'password':'two'})['profile']
    assert first['credential_id']=='database-sicherung-mariadb-v001'
    assert second['credential_id']=='database-sicherung-mariadb-v002'
    rotated = profiles.save_profile(config,{**first,'password':'new'})['profile']
    assert rotated['credential_id']=='database-sicherung-mariadb-v003'
    renamed = profiles.save_profile(config,{**rotated,'name':'Neue Sicherung','password':''})['profile']
    assert renamed['credential_id']=='database-neue-sicherung-v001'
    assert profiles.read_password(config,first)=='one'
    assert profiles.read_password(config,second)=='two'
    assert profiles.read_password(config,renamed)=='new'
    metadata=json.loads(profiles.secret_path(config,renamed['credential_id']).read_text())
    assert metadata['profile_id']==first['id'] and metadata['profile_name']=='Neue Sicherung'


def test_secret_target_never_overwrites_existing_files_or_symlinks(config, profile, tmp_path):
    secret = profiles.secret_path(config,'database-db-v001')
    secret.parent.mkdir(parents=True)
    other = tmp_path/'existing';other.write_text('unchanged')
    secret.symlink_to(other)
    assert profiles.next_credential_id(config,profile)=='database-db-v002'
    with pytest.raises(FileExistsError):profiles.create_secret(config,'database-db-v001',{'password':'new'})
    assert other.read_text()=='unchanged'


@pytest.mark.parametrize('reference',['../database-a-v001','database-../../a-v001','/database-a-v001','database-A-v001','database-a-v1'])
def test_invalid_credential_references(config,reference):
    with pytest.raises(profiles.DatabaseError):profiles.secret_path(config,reference)


def test_named_secret_cannot_be_used_by_another_profile(config,profile):
    first=profiles.save_profile(config,{**profile,'id':None,'auth_mode':'managed','database_user':'root','password':'one'})['profile']
    with pytest.raises(profiles.DatabaseError,match='credentials'):
        profiles.read_password(config,{**first,'id':'db-bbbbbbbbbbbb'})


def test_migration_rejects_modified_target_without_overwrite(config,profile,monkeypatch):
    old,_=legacy(config,profile)
    real_create=migration.create_secret
    def interrupt(*args):
        real_create(*args)
        raise OSError('after copy')
    monkeypatch.setattr(migration,'create_secret',interrupt)
    with pytest.raises(OSError):migration.apply(config)
    target=profiles.secret_path(config,'database-db-v001')
    content=json.loads(target.read_text());content['password']='modified'
    target.write_text(json.dumps(content))
    monkeypatch.setattr(migration,'create_secret',real_create)
    with pytest.raises(ValueError,match='conflict'):migration.apply(config)
    assert json.loads(target.read_text())['password']=='modified'
    assert profiles.list_profiles(config)['profiles'][0]['credential_id']==old['credential_id']
