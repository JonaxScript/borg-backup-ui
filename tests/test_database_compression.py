"""Streaming gzip, readable run identity and retained pre-gzip data (#591)."""
import gzip
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import Mock

import pytest
from test_database_backups import backup, profiles, database_api, config, profile, fake_export


def test_compressed_export_metadata_and_original_bytes(config, profile, monkeypatch):
    fake_export(monkeypatch, profile)
    results = backup.export_profiles(config, [profile], 'job', 'run')
    try:
        result = results[0]
        item = result['files'][0]
        compressed = backup.result_directory(result) / item['name']
        content = gzip.decompress(compressed.read_bytes())
        assert content == b'CREATE TABLE items(id integer);'
        assert item['uncompressed_bytes'] == len(content)
        assert item['bytes'] == compressed.stat().st_size
        assert item['sha256'] == hashlib.sha256(compressed.read_bytes()).hexdigest()
        assert result['profile_name'] == profile['name']
        assert result['archive_directory'].startswith('bbui-db-')
        assert backup.is_run_directory_name(result['archive_directory'])
    finally:
        backup.close_results(results)


@pytest.mark.parametrize('name', ['Photos & Apps', '../../escape', 'Übung 2026', '日本語', 'a'*100])
def test_run_names_are_bounded_safe_and_readable(name):
    stamp = '2026-10-24T10:15:30+02:00'
    first = backup.run_directory_name(name, stamp)
    assert backup.is_run_directory_name(first) and '/' not in first and '..' not in first
    assert len(first) <= 91
    assert first == backup.run_directory_name(name, stamp)
    assert __import__("re").search(r"_[0-9]{2}-[0-9]{2}-[0-9]{2}[+-][0-9]{4}$", first)
    assert '2026-10-24_' in first


@pytest.mark.parametrize("name", ["bbui-"+"a"*32, "bbui-db-2026-10-24_12-36-26+0200-"+"b"*32, "bbui-db-2026-10-24_12-36-26+0200"])
def test_legacy_dump_listing_and_cleanup(config, profile, monkeypatch, name):
    fake_export(monkeypatch, profile)
    directory = Path(profile['staging_dir']) / name
    directory.mkdir(mode=0o700)
    (directory/'app.sql').write_text('legacy dump')
    (directory/'manifest.json').write_text(json.dumps({'profile_id':profile['id'], 'engine':'mariadb',
        'status':'dump_completed', 'scope':{'databases':['app']}, 'files':[{'name':'app.sql','bytes':11}]}))
    monkeypatch.setattr(database_api,'list_profiles',lambda _: {'profiles':[profile]})
    listing=database_api.retained_runs(config)
    assert not listing['errors'] and len(listing['runs']) == 1
    assert listing['runs'][0]['profile_name'] == profile['name']
    assert listing['runs'][0]['compression'] == 'none'
    backup.cleanup_run(directory,profile)
    assert not directory.exists()


def fixture_process(monkeypatch, producer):
    """Substitute only Docker transport; exercise real pipes, sinks and process cleanup."""
    real_popen = subprocess.Popen
    processes=[]
    def popen(cmd, **kwargs):
        proc=real_popen([sys.executable,'-c','import sys,time\nsys.stdin.buffer.read()\n'+producer], **kwargs)
        processes.append(proc)
        return proc
    monkeypatch.setattr(backup.subprocess,'Popen',popen)
    monkeypatch.setattr(backup,'_control',lambda *_:'done')
    monkeypatch.setattr(backup,'container_identity',lambda _:'a'*64)
    terminate=Mock(return_value=True)
    monkeypatch.setattr(backup,'_terminate',terminate)
    return processes,terminate


def test_real_pipe_to_gzip_has_bounded_chunks(config, profile, tmp_path, monkeypatch):
    size = int(os.environ.get('BBUI_COMPRESSION_TEST_MIB','16'))
    fixture_process(monkeypatch, f"for _ in range({size}): sys.stdout.buffer.write(b'x'*1048576)")
    output=tmp_path/'stream.gz'
    with output.open('wb') as raw, gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0,compresslevel=6) as sink:
        original_write=sink.write
        def bounded(block):
            assert len(block) <= 1024*1024
            return original_write(block)
        monkeypatch.setattr(sink,'write',bounded)
        backup._operation(config,profile,'a'*64,'dump','app',sink,lambda:False)
        assert sink.tell() == size*1024*1024
    restored=0
    with gzip.open(output,'rb') as stream:
        while block := stream.read(1024*1024):
            assert block == b'x'*len(block)
            restored+=len(block)
    assert restored == size*1024*1024
    assert output.stat().st_size < restored//100


@pytest.mark.parametrize('failure',['disk','cancelled','timeout'])
def test_stream_failure_terminates_export_and_retains_failure(config, profile, tmp_path, monkeypatch, failure):
    processes,terminate=fixture_process(monkeypatch,"while True:\n sys.stdout.buffer.write(b'x'*65536); sys.stdout.buffer.flush(); time.sleep(.01)")
    profile={**profile,'timeout_seconds':1}
    started=time.monotonic()
    with gzip.open(tmp_path/'partial.gz','wb') as sink:
        if failure=='disk':
            monkeypatch.setattr(sink,'write',Mock(side_effect=OSError('private disk error')))
        with pytest.raises(profiles.DatabaseError, match='export_failed' if failure=='disk' else failure):
            backup._operation(config,profile,'a'*64,'dump','app',sink,
                              lambda:failure=='cancelled' and time.monotonic()-started>.1)
    assert terminate.called and all(p.poll() is not None for p in processes)
    records=[json.loads(p.read_text()) for p in (Path(config['BACKUP_SCRIPTS_DIR'])/'database-operations').glob('*.json')]
    assert records and all(r['status']=='failed' for r in records)
    assert 'private disk error' not in json.dumps(records)


def test_duplicate_dump_timestamp_preserves_existing_run(config, profile, monkeypatch):
    fake_export(monkeypatch, profile)
    monkeypatch.setattr(backup, 'utc_now', lambda: '2026-10-24T10:15:30+00:00')
    first = backup.export_profiles(config, [profile], 'job', 'first')
    directory = backup.result_directory(first[0])
    before = {p.name:p.read_bytes() for p in directory.iterdir()}
    try:
        with pytest.raises(profiles.DatabaseError, match='dump_exists'):
            backup.export_profiles(config, [profile], 'job', 'second')
        assert {p.name:p.read_bytes() for p in directory.iterdir()} == before
    finally:
        backup.close_results(first)
