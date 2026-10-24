"""Managed database profiles, staging, archive proofs and owned cleanup (#591)."""
import copy
import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
import database_profiles as profiles
import database_backup as backup
import database_api
from inventory_store import atomic_write_json


@pytest.fixture
def profile(tmp_path):
    root = tmp_path / 'dump'; root.mkdir(mode=0o700)
    return profiles.validate_profile({'id':'db-aaaaaaaaaaaa', 'name':'DB', 'engine':'mariadb', 'container':'mariadb',
        'databases':['app'], 'credential_file':'/run/secrets/backup.cnf', 'staging_mount':str(tmp_path), 'staging_dir':str(root)})


@pytest.fixture
def config(tmp_path):
    return {'BACKUP_SCRIPTS_DIR':str(tmp_path / 'data')}


def test_profiles_preserve_credentials_outside_inventory_and_references(config, profile):
    created = profiles.save_profile(config, {k:v for k,v in profile.items() if k != 'id'})['profile']
    snap = profiles.snapshot_profiles(config, [created['id']])
    changed = profiles.save_profile(config, {**created, 'name':'Changed', 'password':'never-save-me'})['profile']
    assert snap[0]['name'] == 'DB'
    assert 'never-save-me' not in profiles.store_path(config).read_text()
    jobs = profiles.store_path(config).parent / 'jobs'; jobs.mkdir()
    (jobs/'disabled.json').write_text(json.dumps({'enabled':False, 'database_profile_ids':[created['id']]}))
    with pytest.raises(profiles.DatabaseError, match='profile_in_use'):
        profiles.delete_profile(config, created['id'])
    profiles.save_profile(config, {**changed,'enabled':False})
    with pytest.raises(profiles.DatabaseError, match='profile_unavailable'):
        profiles.snapshot_profiles(config, [created['id']])
    assert profiles.snapshot_profiles(config, [created['id']], allow_disabled=True)


@pytest.mark.parametrize('field,value', [('databases',['--help']),('databases',['mysql']),('databases',['x; touch /x']),
    ('container','--privileged'),('execution_user','root; id'),('credential_file','/run/../x'),('staging_mount','/'),
    ('staging_mount','/boot'),('timeout_seconds',0),('include_globals',True),('enabled','yes'),('retention','delete-all')])
def test_profile_rejects_unsafe_or_unsupported_inputs(profile, field, value):
    with pytest.raises(profiles.DatabaseError): profiles.validate_profile({**profile, field:value})


def test_staging_and_source_overlap_fail_closed(monkeypatch, profile):
    monkeypatch.setattr(backup.os.path,'ismount',lambda p:False)
    with pytest.raises(profiles.DatabaseError, match='invalid_storage'): backup.staging_root(profile)
    with pytest.raises(profiles.DatabaseError, match='source_overlap'): backup.validate_sources([profile],[profile['staging_mount']])
    backup.validate_sources([profile],[str(Path(profile['staging_mount'])/'other')])


def test_staging_rejects_unsafe_permissions_and_low_space(monkeypatch, profile):
    root=Path(profile['staging_dir'])
    root.chmod(0o777)
    with pytest.raises(profiles.DatabaseError,match='invalid_storage'):backup._private_path(root)
    root.chmod(0o700)
    monkeypatch.setattr(backup.os.path,'ismount',lambda p:True)
    monkeypatch.setattr(backup,'_private_path',lambda p:None)
    monkeypatch.setattr(backup,'_run',lambda *a,**kw:Mock(stdout='xfs'))
    monkeypatch.setattr(backup.shutil,'disk_usage',lambda p:Mock(free=1))
    with pytest.raises(profiles.DatabaseError,match='no_space'):backup.staging_root(profile)
    assert backup.staging_root(profile,require_space=False)==root


def fake_export(monkeypatch, profile, failure=None):
    # Repository test directories may have group-writable ancestors; production rejects those.
    monkeypatch.setattr(backup, '_private_path', lambda p: None)
    monkeypatch.setattr(backup, 'staging_root', lambda p, **kw: Path(p['staging_dir']))
    monkeypatch.setattr(backup, 'container_identity', lambda p:'a'*64)
    monkeypatch.setattr(backup, '_probe', lambda *a: {'server_version':'11.4.9', 'client_version':'11.4.9','extensions':[]})
    def export(config,p,cid,action,database,output,cancelled):
        output.write(b'partial' if failure else b'CREATE TABLE items(id integer);')
        if failure: raise profiles.DatabaseError(failure)
    monkeypatch.setattr(backup,'_operation',export)


def test_export_uses_only_current_completed_files_and_retains_previous(config, profile, monkeypatch):
    fake_export(monkeypatch,profile)
    first=backup.export_profiles(config,[profile],'job','one')
    second=backup.export_profiles(config,[profile],'job','two')
    assert first[0]['directory'] != second[0]['directory']
    paths=backup.artifact_paths(second)
    assert {p.name for p in paths} == {'app.sql','manifest.json'}
    assert all(p.parent == Path(second[0]['directory']) for p in paths)
    assert all(p.is_file() and p.stat().st_mode & 0o777 == 0o600 for p in paths)
    assert first[0]['restore_tested'] is False


def test_failed_export_does_not_publish_or_reuse_old_dump(config, profile, monkeypatch):
    fake_export(monkeypatch,profile)
    first=backup.export_profiles(config,[profile],'job','one')
    fake_export(monkeypatch,profile,'export_failed')
    with pytest.raises(profiles.DatabaseError,match='export_failed'):
        backup.export_profiles(config,[profile],'job','two')
    runs=list(Path(profile['staging_dir']).iterdir())
    failed=next(p for p in runs if str(p)!=first[0]['directory'])
    assert (failed/'app.sql.partial').is_file() and not (failed/'app.sql').exists()
    assert json.loads((failed/'manifest.json').read_text())['status']=='failed'
    assert (Path(first[0]['directory'])/'app.sql').is_file()


def test_empty_export_fails(config, profile, monkeypatch):
    fake_export(monkeypatch,profile)
    monkeypatch.setattr(backup,'_operation',lambda *a:None)
    with pytest.raises(profiles.DatabaseError, match='empty_dump'):
        backup.export_profiles(config,[profile],'job','empty')


def test_archive_verification_reads_actual_content_and_rejects_missing(config, profile, monkeypatch):
    fake_export(monkeypatch,profile)
    results=backup.export_profiles(config,[profile],'job','one')
    import subprocess
    original = subprocess.Popen
    def popen(cmd, **kw):
        source=Path('/'+cmd[-1])
        return original([sys.executable, '-c', 'import sys;sys.stdout.buffer.write(open(sys.argv[1],"rb").read())', str(source)], **kw)
    monkeypatch.setattr(backup.subprocess,'Popen',popen)
    backup.verify_archive('repo','archive',results)
    assert results[0]['archived'] and not results[0]['restore_tested']
    monkeypatch.setattr(backup.subprocess,'Popen',lambda *a,**k:original([sys.executable,'-c','pass'],**k))
    with pytest.raises(profiles.DatabaseError,match='archive_verification'):
        backup.verify_archive('repo','archive',results)
    assert (Path(results[0]['directory'])/'app.sql').is_file()


def test_cleanup_is_owned_and_explicit(config, profile, monkeypatch, tmp_path):
    fake_export(monkeypatch,profile)
    result=backup.export_profiles(config,[profile],'job','one')[0]
    directory=Path(result['directory'])
    unexpected=directory/'user-data'; unexpected.write_text('keep')
    with pytest.raises(profiles.DatabaseError,match='cleanup_blocked'):
        backup.cleanup_run(directory,profile)
    unexpected.unlink()
    outside=tmp_path/'valuable'; outside.write_text('keep')
    (directory/'app.sql').unlink(); (directory/'app.sql').symlink_to(outside)
    with pytest.raises(profiles.DatabaseError,match='cleanup_blocked'):
        backup.cleanup_run(directory,profile)
    assert outside.read_text()=='keep'
    (directory/'app.sql').unlink(); (directory/'app.sql').write_text('dump')
    backup.cleanup_run(directory,profile)
    assert not directory.exists() and outside.exists()


def test_unconfirmed_termination_stays_blocked(config, monkeypatch):
    path=profiles.data_root(config)/'database-operations'/'pending.json'
    atomic_write_json(path,{'status':'unresolved','container_id':'a'*64,'token':'b'*32,'execution_user':''})
    monkeypatch.setattr(backup,'_run',lambda cmd,**kw:Mock(stdout='true' if 'inspect' in cmd else 'a'*64))
    monkeypatch.setattr(backup,'_terminate',lambda r:False)
    with pytest.raises(profiles.DatabaseError,match='unresolved_export'): backup.reconcile_operations(config)
    assert json.loads(path.read_text())['status']=='unresolved'
    monkeypatch.setattr(backup,'_terminate',lambda r:True)
    monkeypatch.setattr(backup,'_control',lambda *a:'done')
    backup.reconcile_operations(config)
    assert json.loads(path.read_text())['status']=='interrupted'


def test_scripts_are_managed_executable_and_credential_free():
    for engine in ('mariadb','postgresql'):
        p=backup.SCRIPTS/f'database-dump-{engine}.sh'
        text=p.read_text()
        assert 'Managed by Borg Backup UI' in text and 'Verwaltet durch Borg Backup UI' in text
        assert 'overwritten' in text and 'ueberschrieben' in text
        assert os.access(p,os.X_OK)
        assert 'Protocol 1' in text


def test_database_only_sources_require_explicit_opt_in():
    from job_source_paths import normalize_source_paths
    assert normalize_source_paths([],allow_empty=True)==[]
    with pytest.raises(ValueError):normalize_source_paths([])
    import wizard_runner
    assert 'docker-control' in wizard_runner._build_resources({}, {'database_profile_ids':['db-aaaaaaaaaaaa']})

# Exercise the actual job lifecycle and its failure/cancellation policy.
from test_runtime_before_maintenance import run_backup

@pytest.mark.parametrize('outcome', ['ok','failed','cancelled','archive_failed','warning','cleanup'])
def test_runner_database_step_precedes_container_stop(run_backup, monkeypatch, tmp_path, outcome):
    import wizard_runner
    state=run_backup
    original=wizard_runner._load_env_from_job
    profile={'id':'db-aaaaaaaaaaaa','retention':'after_archive' if outcome in ('warning','cleanup') else 'keep'}
    if outcome=='warning':state.create_exit=1
    def load(*a):
        env,meta=original(*a)
        meta.update(database_profile_ids=[profile['id']],_database_profiles=[profile])
        return env,meta
    monkeypatch.setattr(wizard_runner,'_load_env_from_job',load)
    monkeypatch.setattr(backup,'validate_sources',lambda *a:None)
    monkeypatch.setattr(backup,'reconcile_operations',lambda *a:None)
    result={'directory':str(tmp_path/'result'),'files':[], 'profile_id':profile['id']}
    def export(*a,**kw):
        state.actions.append('database')
        if outcome in ('failed','cancelled'):raise profiles.DatabaseError('export_failed' if outcome=='failed' else 'cancelled')
        return [result]
    def verify(*a,**kw):
        state.actions.append('verify')
        if outcome=='archive_failed':raise profiles.DatabaseError('archive_verification')
    monkeypatch.setattr(backup,'export_profiles',export)
    monkeypatch.setattr(backup,'verify_archive',verify)
    monkeypatch.setattr(backup,'cleanup_run',lambda *a,**kw:state.actions.append('cleanup'))
    code=state.run()
    assert state.actions[0]=='database'
    if outcome in ('failed','cancelled'):
        assert 'create' not in state.actions and 'stop_docker' not in state.actions
        assert code==(130 if outcome=='cancelled' else 2)
    else:
        assert state.actions.index('database') < state.actions.index('stop_docker') < state.actions.index('create') < state.actions.index('verify')
        assert code==(2 if outcome=='archive_failed' else 1 if outcome=='warning' else 0)
    assert ('cleanup' in state.actions)==(outcome=='cleanup')


def test_database_only_configuration_roundtrip(tmp_path, profile):
    from test_settings_transfer_repository_model import _canonical_source
    from settings_transfer_api import export_jobs_bundle, import_jobs_bundle, ConfigurationExportError
    from wizard_api import load_job_for_wizard
    config,_=_canonical_source(tmp_path/'source')
    created=profiles.save_profile(config,{k:v for k,v in profile.items() if k!='id'})['profile']
    job_path=next((Path(config['BACKUP_SCRIPTS_DIR'])/'config/jobs').glob('*.json'))
    row=json.loads(job_path.read_text());row.update(source_paths=[],database_profile_ids=[created['id']]);atomic_write_json(job_path,row)
    bundle=export_jobs_bundle(config)['bundle']
    assert bundle['database_profiles']==[created]
    target={'BACKUP_SCRIPTS_DIR':str(tmp_path/'target')}
    import_jobs_bundle(target,bundle,dry_run=False,settings_mode='ignore')
    assert profiles.list_profiles(target)['profiles']==[created]
    imported=next((Path(target['BACKUP_SCRIPTS_DIR'])/'config/jobs').glob('*.json'))
    assert json.loads(imported.read_text())['source_paths']==[]
    form=load_job_for_wizard(imported.stem,Path(target['BACKUP_SCRIPTS_DIR'])/'scripts',target)
    assert form['database_profile_ids']==[created['id']] and form['source_paths']==[]
    profiles.save_profile(target,{**created,'name':'Keep my edit'})
    with pytest.raises(ConfigurationExportError):import_jobs_bundle(target,bundle,dry_run=False,settings_mode='ignore')
    assert profiles.list_profiles(target)['profiles'][0]['name']=='Keep my edit'


def test_database_http_profile_routes(tmp_path, monkeypatch, profile):
    from http.server import ThreadingHTTPServer
    from urllib.request import Request,urlopen
    from urllib.error import HTTPError
    import threading
    import borg_backup_ui
    monkeypatch.setattr(borg_backup_ui,'_log',lambda *_:None)
    class Handler(borg_backup_ui.BackupUIHandler):
        config={'BACKUP_SCRIPTS_DIR':str(tmp_path/'data')}
        def _authorize_api_request(self,*_):return True
        def log_message(self,*_):pass
    handler=Handler.__new__(Handler)
    assert handler._required_role_for_request('/api/settings/databases','GET')=='admin'
    assert handler._required_role_for_request('/api/settings/databases/action','POST')=='admin'
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    def request(method,body=None,suffix=''):
        req=Request(f'http://127.0.0.1:{server.server_port}/api/settings/databases'+suffix,
                    data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json'})
        try:response=urlopen(req,timeout=5)
        except HTTPError as error:response=error
        return response.status,json.load(response)
    try:
        assert request('GET')[1]['profiles']==[]
        code,payload=request('POST',{k:v for k,v in profile.items() if k!='id'})
        assert code==200 and payload['profile']['name']=='DB'
        created=payload['profile']
        code,error=request('POST',{**created,'container':'--privileged'})
        assert code==400 and error['code']=='database_invalid_profile'
        assert request('GET')[1]['profiles'][0]['container']=='mariadb'
        assert request('DELETE',suffix='?id='+created['id'])[0]==200
    finally:server.shutdown();server.server_close();worker.join(5)


def test_async_actions_share_configured_docker_lock_and_honor_cancel(config, profile, monkeypatch, tmp_path):
    import time
    import threading
    from jobs_api import resolve_resource_lock_dir
    from wizard_runner import ResourceLockSet
    config['BORG_RESOURCE_LOCK_DIR']=str(tmp_path/'custom-locks')
    saved=profiles.save_profile(config,{k:v for k,v in profile.items() if k!='id'})['profile']
    entered=threading.Event()
    monkeypatch.setattr(database_api,'reconcile_operations',lambda _:None)
    def export(config,profiles,job,run,cancelled,**kw):
        entered.set()
        while not cancelled():time.sleep(.01)
        raise profiles_module.DatabaseError('cancelled')
    profiles_module=profiles
    monkeypatch.setattr(database_api,'export_profiles',export)
    state=database_api.start_operation(config,{'action':'dump','profile_id':saved['id']})
    assert state['status']=='running' and entered.wait(2)
    contender=ResourceLockSet(resolve_resource_lock_dir(config),'other')
    assert contender.acquire(['docker-control'])[0] is False
    database_api.cancel_operation(config,state['id'])
    for _ in range(100):
        status=database_api.operation_status(config,state['id'])
        if status['status']!='running':break
        time.sleep(.02)
    assert status['status']=='cancelled'
    assert contender.acquire(['docker-control'])[0] is True
    contender.release()
