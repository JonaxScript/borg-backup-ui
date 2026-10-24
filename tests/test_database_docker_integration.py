"""Opt-in real Docker/Borg restore and cancellation tests (#591).

Set BBUI_DATABASE_DOCKER_TESTS=1. Requires pre-pulled mariadb:11.4 and postgres:16,
Docker, Borg and repository-local TMPDIR/pytest --basetemp. No ports are published.
Only uniquely named test containers and generated fixture data are touched.
"""
import json
import gzip
import os
import subprocess
import time
import uuid
from pathlib import Path

import pytest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
import database_backup as backup
from database_profiles import validate_profile, save_profile, DatabaseError

pytestmark=pytest.mark.skipif(os.environ.get('BBUI_DATABASE_DOCKER_TESTS') != '1', reason='Opt-in real Docker integration')


def command(args, **kwargs):
    """Run a fixture-only command with bounded lifetime; capture output for assertions."""
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,**kwargs).stdout


@pytest.fixture(params=['mariadb','postgresql'])
def database_container(request,tmp_path):
    engine=request.param
    names=[]
    def launch(suffix):
        name='bbui591-test-'+uuid.uuid4().hex[:12]+'-'+suffix
        directory=tmp_path/suffix; directory.mkdir()
        image='mariadb:11.4' if engine=='mariadb' else 'postgres:16'
        target='/var/lib/mysql' if engine=='mariadb' else '/var/lib/postgresql/data'
        env=['-e','MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=yes','-e','MARIADB_ROOT_HOST=%'] if engine=='mariadb' else ['-e','POSTGRES_HOST_AUTH_METHOD=trust']
        command(['docker','run','-d','--name',name,'--network','none','--mount',f'type=bind,source={directory},target={target}',*env,image])
        names.append(name)
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            cmd=['mariadb','--protocol=tcp','-h127.0.0.1','-uroot','-e','SELECT 1'] if engine=='mariadb' else ['psql','-h127.0.0.1','-U','postgres','-c','SELECT 1']
            try:
                command(['docker','exec',name,*cmd]);break
            except subprocess.CalledProcessError:time.sleep(.3)
        else:
            logs=subprocess.run(['docker','logs',name],capture_output=True,timeout=15)
            raise AssertionError('fixture database not ready: '+logs.stdout.decode(errors='replace')+logs.stderr.decode(errors='replace'))
        return name
    try:yield engine,launch('source'),launch
    finally:
        for name in names:command(['docker','rm','-f',name])


def test_real_export_borg_readback_restore(database_container,tmp_path,monkeypatch):
    engine,source,launch=database_container
    def sql(name,text,database=None):
        args=['mariadb','-uroot'] if engine=='mariadb' else ['psql','-U','postgres','-v','ON_ERROR_STOP=1','-tA']
        if database:args += [database] if engine=='mariadb' else ['-d',database]
        return command(['docker','exec','-i',name,*args],input=text.encode())
    sql(source,'CREATE DATABASE fixture;')
    sql(source,"CREATE TABLE items(id integer primary key, value varchar(80)); INSERT INTO items VALUES(1,'backed-up'); CREATE VIEW item_view AS SELECT * FROM items;",'fixture')
    if engine=='mariadb':
        sql(source,'CREATE PROCEDURE fixture.answer() SELECT 42; CREATE EVENT fixture.inactive ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1; CREATE TRIGGER fixture.items_trigger BEFORE INSERT ON fixture.items FOR EACH ROW SET NEW.value = NEW.value;')
    else:
        sql(source,'CREATE ROLE fixture_owner; ALTER DATABASE fixture OWNER TO fixture_owner;')
        sql(source,'CREATE EXTENSION IF NOT EXISTS hstore;','fixture')
    password='fixture:p\\ass"$word'
    user='fixture_login'
    if engine=='mariadb':
        sql(source, "SET sql_mode='NO_BACKSLASH_ESCAPES'; CREATE USER 'fixture_login'@'127.0.0.1' IDENTIFIED BY '"+password+"'; GRANT ALL PRIVILEGES ON *.* TO 'fixture_login'@'127.0.0.1';")
    else:
        sql(source,"CREATE ROLE fixture_login WITH LOGIN SUPERUSER PASSWORD '"+password+"';")
        command(['docker','exec','-i',source,'sh','-c','cat > /var/lib/postgresql/data/pg_hba.conf'],input=b'local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n')
        sql(source,'SELECT pg_reload_conf();')
    staging=tmp_path/'staging'; staging.mkdir(mode=0o700)
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path/'config')}
    profile=save_profile(cfg,dict(name='fixture',engine=engine,container=source,databases=['fixture'],auth_mode='managed',password=password,database_user=user,staging_mount=str(tmp_path),staging_dir=str(staging),include_globals=engine=='postgresql'))['profile']
    assert 'fixture' in backup.discover_databases(cfg,profile)
    assert profile['databases']==['fixture']
    leftovers=command(['docker','exec',source,'sh','-c','find /dev/shm -name credentials -print'])
    assert not leftovers
    # Host filesystem/mount safety is covered separately; all exporter/Borg/database operations are real.
    monkeypatch.setattr(backup.os.path, 'ismount', lambda p: True)
    original_run = backup._run
    from unittest.mock import Mock
    monkeypatch.setattr(backup, '_run', lambda cmd, **kw: Mock(stdout='xfs') if cmd[0]=='stat' else original_run(cmd, **kw))
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path/'config')}
    results=backup.export_profiles(cfg,[profile],'fixture-job','fixture-run')
    monkeypatch.setenv('BORG_CACHE_DIR',str(tmp_path/'cache'))
    monkeypatch.setenv('BORG_SECURITY_DIR',str(tmp_path/'security'))
    monkeypatch.setenv('BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK','yes')
    repo=tmp_path/'borg-repository'
    command(['borg','init','--encryption=none',str(repo)])
    paths=backup.artifact_paths(results)
    command(['borg','create',str(repo)+'::fixture',*backup.borg_artifact_paths(results)])
    backup.verify_archive(str(repo),'fixture',results)
    assert results[0]['archived'] and not results[0]['restore_tested']
    target=launch('restore')
    dump=next(p for p in paths if p.name in ('fixture.sql.gz','fixture.dump.gz'))
    content=command(['borg','extract','--stdout',str(repo)+'::fixture',results[0]['archive_directory'] + '/' + dump.name])
    content=gzip.decompress(content)
    if engine=='mariadb':
        sql(target,content.decode())
        assert b'backed-up' in sql(target,'SELECT value FROM item_view;','fixture')
        assert b'42' in sql(target,'CALL fixture.answer();')
        assert b'inactive' in sql(target,'SHOW EVENTS FROM fixture;')
        assert b'items_trigger' in sql(target,'SHOW TRIGGERS FROM fixture;')
    else:
        globals_path=Path(results[0]['directory'])/'globals.sql.gz'
        globals_sql=command(['borg','extract','--stdout',str(repo)+'::fixture',results[0]['archive_directory'] + '/' + globals_path.name])
        globals_sql=gzip.decompress(globals_sql)
        assert b'PASSWORD' not in globals_sql and password.encode() not in globals_sql
        # The bootstrap role already exists in a fresh official image; skip only its CREATE.
        sql(target,globals_sql.decode().replace('CREATE ROLE postgres;',''))
        command(['docker','exec','-i',target,'pg_restore','-U','postgres','--exit-on-error','--create','--dbname=postgres'],input=content)
        assert b'backed-up' in sql(target,'SELECT value FROM item_view;','fixture')
        assert b'fixture_owner' in sql(target,"SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='fixture';")
        assert b'hstore' in sql(target,'SELECT extname FROM pg_extension;','fixture')
    # Missing artifacts must fail even though Borg itself successfully created the archive.
    command(['borg','create',str(repo)+'::missing',backup.borg_artifact_paths(results)[-1]])
    with pytest.raises(DatabaseError,match='archive_verification'):backup.verify_archive(str(repo),'missing',results)
    if engine=='mariadb':
        sql(source,'CREATE TABLE unsupported(id integer) ENGINE=MyISAM;','fixture')
        with pytest.raises(DatabaseError,match='nontransactional'):backup.export_profiles(cfg,[profile],'fixture-job','unsupported')
    print(engine,results[0]['files'][0]['server_version'],'restore verified')
    backup.close_results(results)


def test_real_owned_group_cancellation(database_container,tmp_path,monkeypatch):
    engine,container,_=database_container
    helpers=tmp_path/'helpers';helpers.mkdir()
    # Run a long-lived client tree through the production supervisor/control protocol.
    (helpers/f'database-dump-{engine}.sh').write_text('sleep 60 &\nwait\n')
    monkeypatch.setattr(backup,'SCRIPTS',helpers)
    profile=dict(id='db-aaaaaaaaaaaa',engine=engine,container=container,execution_user='',credential_file='/unused',port=1,database_user='',timeout_seconds=30)
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path/'config')}
    start=time.monotonic()
    with gzip.open(tmp_path/'output.gz', 'wb') as handle:
        with pytest.raises(DatabaseError,match='cancelled'):
            backup._operation(cfg,profile,backup.container_identity(profile),'dump','fixture',handle,lambda:time.monotonic()-start>.8)
    records=[json.loads(p.read_text()) for p in (tmp_path/'config/database-operations').glob('*.json')]
    assert records and all(r['status']=='failed' for r in records)
    # No worker or child sleep survives; no database/server process was terminated.
    processes=command(['docker','exec',container,'sh','-c','for f in /proc/[0-9]*/stat; do read -r line < "$f" 2>/dev/null || continue; rest=${line##*) }; set -- $rest; [ "$1" = Z ] || printf "%s\\n" "$line"; done'])
    assert b'(sleep)' not in processes
    assert backup.container_identity(profile)
