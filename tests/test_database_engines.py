"""Native SQLite WAL snapshots and additional profile contracts (#593)."""
import gzip
import importlib.util
import io
import json
import sqlite3
from pathlib import Path
from unittest.mock import Mock

import pytest
from test_database_backups import profile, config
import database_backup as backup
import database_profiles as profiles


@pytest.mark.parametrize('engine,port', [('mysql',3306),('mongodb',27017),('redis',6379),('sqlite',1)])
def test_additional_profile_contracts(profile, engine, port):
    raw={**profile,'engine':engine,'auth_mode':'none' if engine in ('sqlite','redis','mongodb') else 'container'}
    raw.pop('port',None)
    raw['databases']=['all'] if engine in ('redis','mongodb') else ['database'] if engine=='sqlite' else ['app']
    if engine=='sqlite':raw['sqlite_path']='/data/stash-go.sqlite'
    row=profiles.validate_profile(raw)
    assert row['port']==port
    if engine in ('redis','mongodb','sqlite'):
        with pytest.raises(profiles.DatabaseError):profiles.validate_profile({**raw,'databases':['wrong']})
    with pytest.raises(profiles.DatabaseError):profiles.validate_profile({**raw,'include_globals':True})


def test_mongodb_requires_complete_instance_scope(config, profile):
    raw={**profile,'id':'','engine':'mongodb','auth_mode':'none','databases':['all']}
    row=profiles.save_profile(config,raw)['profile']
    assert profiles.snapshot_profiles(config,[row['id']])[0]['databases']==['all']
    with pytest.raises(profiles.DatabaseError):profiles.validate_profile({**row,'databases':['app']})


def sqlite_helper():
    spec=importlib.util.spec_from_file_location('sqlite_test_helper',backup.SCRIPTS/'database-dump-sqlite.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def test_sqlite_snapshot_includes_committed_wal_and_excludes_uncommitted_changes(tmp_path):
    path=tmp_path/'live.sqlite'
    source=sqlite3.connect(path)
    try:
        source.execute('PRAGMA journal_mode=WAL');source.execute('CREATE TABLE items(value)')
        source.execute('INSERT INTO items VALUES (42)');source.commit()
        source.execute('INSERT INTO items VALUES (99)')
        assert Path(str(path)+'-wal').stat().st_size>0
        output=io.BytesIO()
        sqlite_helper().run(path,'dump',output,lambda:None,tmp_path)
        restored=tmp_path/'restored.sqlite';restored.write_bytes(output.getvalue())
        with sqlite3.connect(restored) as conn:
            assert conn.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
            assert conn.execute('SELECT value FROM items').fetchall()==[(42,)]
        assert not (tmp_path/'.sqlite-snapshot').exists()
        assert source.execute('SELECT value FROM items').fetchall()==[(42,),(99,)]
    finally:source.close()


def test_sqlite_cancel_removes_private_scratch_and_preserves_source(tmp_path):
    path=tmp_path/'live.sqlite'
    with sqlite3.connect(path) as conn:conn.execute('CREATE TABLE items(value)')
    before=path.read_bytes();calls=[]
    def cancel():
        calls.append(1)
        if len(calls)>1:raise profiles.DatabaseError('cancelled')
    with pytest.raises(profiles.DatabaseError,match='cancelled'):
        sqlite_helper().run(path,'dump',io.BytesIO(),cancel,tmp_path)
    assert not (tmp_path/'.sqlite-snapshot').exists() and path.read_bytes()==before


def test_sqlite_container_mapping_and_gzip_export(profile, config, tmp_path, monkeypatch):
    path=tmp_path/'data.sqlite'
    with sqlite3.connect(path) as conn:conn.execute('CREATE TABLE items(value)');conn.execute('INSERT INTO items VALUES (5)')
    row=profiles.validate_profile({**profile,'engine':'sqlite','auth_mode':'none','sqlite_path':'/data/data.sqlite','databases':['database']})
    monkeypatch.setattr(backup,'container_identity',lambda p:'a'*64)
    monkeypatch.setattr(backup,'_run',lambda cmd,**kw:Mock(stdout=json.dumps([{'Type':'bind','Source':str(tmp_path),'Destination':'/data'}]) if 'inspect' in cmd else 'ext2/ext3'))
    monkeypatch.setattr(backup.os.path,'ismount',lambda p:True)
    results=[]
    try:
        backup.export_profiles(config,[row],'job','run',results=results)
        file=backup.result_directory(results[0])/'database.sqlite.gz'
        restored=tmp_path/'restored.sqlite';restored.write_bytes(gzip.decompress(file.read_bytes()))
        with sqlite3.connect(restored) as conn: assert conn.execute('SELECT * FROM items').fetchall()==[(5,)]
        backup.cleanup_run(results[0],row)
    finally:backup.close_results(results)
    path.unlink();path.symlink_to(restored)
    with (tmp_path/'output').open('wb') as output:
        with pytest.raises(profiles.DatabaseError,match='sqlite_source'):
            backup._sqlite_operation(row,'a'*64,'probe',output,lambda:False)


def test_mongodb_tools_have_independent_versions_and_require_config_support(config, profile, tmp_path, monkeypatch):
    row={**profile,'engine':'mongodb'}
    def probe(*args):args[5].write(b'7.0.45\nmongodump version: 100.14.0\n')
    monkeypatch.setattr(backup,'_operation',probe)
    assert backup._probe(config,row,'a'*64,'all',lambda:False,tmp_path)['client_version']=='100.14.0'
    monkeypatch.setattr(backup,'_operation',lambda *args:args[5].write(b'7.0.45\nmongodump version: 100.2.0\n'))
    with pytest.raises(profiles.DatabaseError,match='tools_missing'):backup._probe(config,row,'a'*64,'all',lambda:False,tmp_path)
