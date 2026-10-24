"""Opt-in native MongoDB/Redis online restore tests (#593).

BBUI_DATABASE_ONLINE_DOCKER_TESTS=1 requires pre-pulled mongo:7.0 and redis:7.4.
Only generated bind storage under pytest's repository-local basetemp is used.
No network ports are published and only uniquely named fixture containers stop.
"""
import gzip
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from unittest.mock import Mock

import pytest
from test_database_docker_integration import command
import database_backup as backup
from database_profiles import save_profile, DatabaseError

pytestmark=pytest.mark.skipif(os.environ.get('BBUI_DATABASE_ONLINE_DOCKER_TESTS')!='1',reason='Opt-in online Docker integration')


@pytest.fixture
def containers(tmp_path):
    """Launch isolated fixture containers and remove only those we created."""
    names=[]
    def launch(engine,suffix,replica=False):
        name='bbui593-'+uuid.uuid4().hex[:12]+'-'+suffix
        directory=tmp_path/suffix;directory.mkdir()
        image='mongo:7.0' if engine=='mongodb' else 'redis:7.4'
        target='/data/db' if engine=='mongodb' else '/data'
        command(['docker','run','-d','--name',name,'--network','none','--mount',f'type=bind,source={directory},target={target}',image,*(['--replSet','rs0','--bind_ip','127.0.0.1'] if replica else [])])
        names.append(name)
        for _ in range(120):
            try:
                command(['docker','exec',name,*(['mongosh','--quiet','--eval','db.runCommand({ping:1})'] if engine=='mongodb' else ['redis-cli','PING'])]);break
            except subprocess.CalledProcessError:time.sleep(.5)
        else:raise AssertionError('fixture startup timed out: '+command(['docker','logs',name]).decode(errors='replace')[-2000:])
        if replica:
            command(['docker','exec',name,'mongosh','--quiet','--eval','rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]});'])
            for _ in range(120):
                if b'true' in command(['docker','exec',name,'mongosh','--quiet','--eval','print(db.hello().isWritablePrimary)']):break
                time.sleep(.5)
            else:raise AssertionError('replica initialization timed out')
        return name,directory
    try:yield launch
    finally:
        for name in reversed(names):command(['docker','rm','-f',name])


def profile_for(tmp_path,engine,container):
    """Create a managed-credential profile using generated test-only credentials."""
    staging=tmp_path/'staging';staging.mkdir(mode=0o700,exist_ok=True)
    cfg={'BACKUP_SCRIPTS_DIR':str(tmp_path/'config')}
    row=save_profile(cfg,dict(name=engine,engine=engine,container=container,databases=['all'],auth_mode='managed',database_user='backup' if engine=='mongodb' else 'default',password='fixture-only-593',staging_mount=str(tmp_path),staging_dir=str(staging)))['profile']
    return cfg,row


@pytest.mark.parametrize('engine',['mongodb','redis'])
def test_online_export_and_native_restore(containers,tmp_path,monkeypatch,engine):
    source,_=containers(engine,'source',replica=engine=='mongodb')
    cfg,row=profile_for(tmp_path,engine,source)
    def shell(name,code):return command(['docker','exec','-i',name,'mongosh','--quiet','--eval',code])
    writer=None
    if engine=='mongodb':
        shell(source,'db.getSiblingDB("admin").createUser({user:"backup",pwd:"fixture-only-593",roles:["root"]}); const d=db.getSiblingDB("app"); d.a.insertOne({_id:1}); d.b.insertOne({_id:1});')
        writer=subprocess.Popen(['docker','exec',source,'mongosh','--quiet','--eval','const s=db.getMongo().startSession();const d=s.getDatabase("app");for(let i=2;i<150;i++){s.startTransaction();d.a.insertOne({_id:i});d.b.insertOne({_id:i});s.commitTransaction();sleep(20);}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    else:
        command(['docker','exec',source,'redis-cli','SET','fixture','593'])
        command(['docker','exec',source,'redis-cli','-n','2','SET','other','593'])
        command(['docker','exec','-i',source,'redis-cli','-x','CONFIG','SET','requirepass'],input=b'fixture-only-593')
    results=[]
    try:
        assert backup.discover_databases(cfg,row)==['all']
        monkeypatch.setattr(backup.os.path,'ismount',lambda p:True)
        original=backup._run
        monkeypatch.setattr(backup,'_run',lambda cmd,**kw:Mock(stdout='xfs') if cmd[0]=='stat' else original(cmd,**kw))
        backup.export_profiles(cfg,[row],'fixture','run',results=results)
        content=gzip.decompress((backup.result_directory(results[0])/('all'+backup.dump_suffix(engine)+'.gz')).read_bytes())
        assert backup.container_identity(row)==results[0]['container_id']
        target,directory=containers(engine,'restore')
        if engine=='mongodb':
            command(['docker','exec','-i',target,'mongorestore','--archive','--oplogReplay'],input=content)
            values=json.loads(shell(target,'const d=db.getSiblingDB("app");print(JSON.stringify([d.a.countDocuments({}),d.b.countDocuments({})]));'))
            assert values[0]==values[1] and values[0]>=1
            # A standalone source must fail before producing a purported online dump.
            unsupported={**row,'container':target,'auth_mode':'none'}
            with pytest.raises(DatabaseError,match='mongodb_replica_required'):backup.discover_databases(cfg,unsupported)
        else:
            assert content.startswith(b'REDIS')
            # Restore via the native DEBUG RELOAD command in an isolated fixture is
            # disabled by default; start a separate clean server from the RDB.
            command(['docker','exec','-i',target,'sh','-c','cat > /data/fixture.rdb'],input=content)
            command(['docker','exec',target,'redis-check-rdb','/data/fixture.rdb'])
            command(['docker','exec',target,'redis-server','--port','6380','--dbfilename','fixture.rdb','--dir','/data','--daemonize','yes'])
            assert b'593' in command(['docker','exec',target,'redis-cli','-p','6380','GET','fixture'])
            assert b'593' in command(['docker','exec',target,'redis-cli','-p','6380','-n','2','GET','other'])
        assert not command(['docker','exec',source,'sh','-c','find /dev/shm -name credentials -print'])
        print(engine,results[0]['files'][0]['server_version'],'online restore verified')
    finally:
        backup.close_results(results)
        if writer:writer.wait(timeout=90)
