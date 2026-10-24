"""Supported online engines and preservation of withdrawn test profiles (#593)."""
import io
import json
from pathlib import Path

import pytest
from test_database_backups import profile, config
import database_backup as backup
import database_profiles as profiles
from inventory_store import atomic_write_json


@pytest.mark.parametrize('engine,port', [('mariadb',3306),('mysql',3306),('postgresql',5432)])
def test_supported_profile_contracts(profile, engine, port):
    raw={**profile,'engine':engine,'database_user':'root'}
    raw.pop('port',None)
    assert profiles.validate_profile(raw)['port']==port
    with pytest.raises(profiles.DatabaseError):
        profiles.validate_profile({**raw,'auth_mode':'none'})
    if engine!='postgresql':
        with pytest.raises(profiles.DatabaseError):
            profiles.validate_profile({**raw,'include_globals':True})


@pytest.mark.parametrize('engine', ['mongodb','redis','sqlite'])
def test_retired_profiles_preserved_but_never_executed(config, profile, engine, monkeypatch):
    retired={**profile,'id':'db-bbbbbbbbbbbb','engine':engine,'name':'Old test',
             'auth_mode':'managed','credential_id':'c'*32,'database_user':'root',
             'databases':['all'],'authentication_database':'admin','sqlite_path':'/data/old.sqlite'}
    atomic_write_json(profiles.store_path(config),{'schema_version':1,'profiles':[profile,retired]})
    secret=profiles.secret_path(config,retired['credential_id'])
    atomic_write_json(secret,{'password':'retained-private-value'})
    dump=Path(profile['staging_dir'])/'old-export.gz';dump.write_bytes(b'preserved')
    original=profiles.store_path(config).read_bytes()
    listed=profiles.list_profiles(config)
    assert [r['id'] for r in listed['profiles']]==[profile['id']]
    assert listed['unsupported_profiles']==[{'id':retired['id'],'name':'Old test','engine':engine}]
    assert profiles.store_path(config).read_bytes()==original
    with pytest.raises(profiles.DatabaseError,match='invalid_profile'):
        profiles.save_profile(config,{**retired,'id':''})
    for allow_disabled in (True,False):
        with pytest.raises(profiles.DatabaseError,match='profile_unavailable'):
            profiles.snapshot_profiles(config,[retired['id']],allow_disabled=allow_disabled)
    with pytest.raises(profiles.DatabaseError,match='profile_unavailable'):
        profiles.save_profile(config,{**profile,'id':retired['id']})
    monkeypatch.setattr(backup,'container_identity',lambda _:pytest.fail('must not contact container'))
    with pytest.raises(profiles.DatabaseError,match='profile_unavailable'):
        backup.export_profiles(config,[retired],'job','run')
    with pytest.raises(profiles.DatabaseError,match='profile_unavailable'):
        backup._operation(config,retired,'x','dump','all',io.BytesIO(),lambda:False)
    changed=profiles.save_profile(config,{**profile,'name':'Updated'})['profile']
    assert profiles.snapshot_profiles(config,[changed['id']])[0]['name']=='Updated'
    assert next(r for r in profiles.stored_profiles(config) if r['id']==retired['id'])==retired
    profiles.delete_profile(config,changed['id'])
    assert profiles.stored_profiles(config)==[retired]
    assert secret.read_text().find('retained-private-value')!=-1 and dump.read_bytes()==b'preserved'


@pytest.mark.parametrize('engine', ['mongodb','redis','sqlite'])
def test_retired_configuration_transfer_is_lossless_and_inert(config, profile, tmp_path, engine):
    from settings_transfer_api import export_jobs_bundle, import_jobs_bundle
    retired={**profile,'engine':engine,'id':'db-bbbbbbbbbbbb','auth_mode':'none',
             'databases':['all'],'sqlite_path':'/data/old.sqlite'}
    atomic_write_json(profiles.store_path(config),{'schema_version':1,'profiles':[profile,retired]})
    bundle=export_jobs_bundle(config)['bundle']
    assert retired in bundle['database_profiles']
    target={'BACKUP_SCRIPTS_DIR':str(tmp_path/'target')}
    import_jobs_bundle(target,bundle,dry_run=False,settings_mode='ignore')
    assert profiles.stored_profiles(target)==[profile,retired]
    assert profiles.snapshot_profiles(target,[profile['id']])
    with pytest.raises(profiles.DatabaseError):profiles.snapshot_profiles(target,[retired['id']])
    # Importing another supported profile must not silently drop existing retired metadata.
    bundle['database_profiles']=[{**profile,'id':'db-cccccccccccc'}]
    import_jobs_bundle(target,bundle,dry_run=False,settings_mode='ignore')
    assert retired in profiles.stored_profiles(target)
    with pytest.raises(profiles.DatabaseError):
        profiles.validate_stored_profile({**retired,'password':'must-not-export'})


def test_active_secret_migration_preserves_retired_metadata(config, profile):
    from test_database_secret_names import legacy
    from migrations import database_secret_names_v1 as migration
    active, _ = legacy(config, profile)
    retired={**profile,'engine':'sqlite','id':'db-bbbbbbbbbbbb','auth_mode':'none',
             'databases':['database'],'sqlite_path':'/data/old.sqlite'}
    atomic_write_json(profiles.store_path(config),{'schema_version':1,'profiles':[active,retired]})
    assert migration.detect(config)['required']
    assert migration.apply(config)['status']=='applied'
    assert retired in profiles.stored_profiles(config)
    assert not migration.detect(config)['required']
