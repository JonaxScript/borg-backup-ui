"""Live processing estimates, source scans and automatic source measurement (#646)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT, ROOT / 'api', ROOT / 'runtime'):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import job_control
from runtime.lib import source_size


def measured(scan):
    """Wait for a test scan with a finite deadline, then always stop the worker."""
    try:
        deadline = time.monotonic() + 5
        while scan.snapshot()['status'] == 'scanning' and time.monotonic() < deadline:
            time.sleep(.01)
        return scan.snapshot()
    finally:
        scan.close()


def test_du_logical_size_overlap_hardlinks_and_literal_exclusions(tmp_path):
    source = tmp_path / 'source with spaces'
    source.mkdir()
    nested = source / 'nested'
    nested.mkdir()
    sparse = nested / 'sparse'
    with sparse.open('wb') as handle:
        handle.truncate(16 * 1024**2)
    os.link(sparse, nested / 'hardlink')
    excluded = source / 'exclude [a]*?\\name'
    excluded.mkdir()
    (excluded / 'large').write_bytes(b'x' * 8192)
    # A similarly named sibling must not be excluded by glob expansion.
    sibling = source / 'exclude aZZname'
    sibling.write_bytes(b'y' * 73)
    expected = sparse.stat().st_size + sibling.stat().st_size
    assert measured(source_size.SourceSizeEstimate([nested, source, source], [excluded])) == {
        'status': 'ready', 'bytes': expected}



def test_source_below_excluded_parent_is_not_counted(tmp_path):
    child = tmp_path / 'excluded' / 'child'
    child.mkdir(parents=True)
    (child / 'file').write_text('not in archive')
    assert measured(source_size.SourceSizeEstimate([child], [child.parent])) == {'status': 'ready', 'bytes': 0}

def test_du_discards_partial_size_on_missing_source(tmp_path):
    existing = tmp_path / 'existing'
    existing.write_text('data')
    assert measured(source_size.SourceSizeEstimate([existing, tmp_path / 'missing'])) == {'status': 'failed'}


def test_unsupported_exclusions_do_not_start_du(monkeypatch, tmp_path):
    monkeypatch.setattr(source_size, 'Popen', lambda *a, **kw: pytest.fail('must not scan'))
    assert measured(source_size.SourceSizeEstimate([tmp_path], unsupported=True)) == {'status': 'unsupported'}


@pytest.mark.parametrize('mode', ['cancel', 'timeout', 'close'])
def test_running_scan_is_killed_and_reaped(monkeypatch, tmp_path, mode):
    popen = subprocess.Popen
    processes = []

    def sleeping_du(*args, **kwargs):
        proc = popen([sys.executable, '-c', 'import time; time.sleep(60)'], **kwargs)
        processes.append(proc)
        return proc

    monkeypatch.setattr(source_size, 'Popen', sleeping_du)
    cancelled = [False]
    scan = source_size.SourceSizeEstimate([tmp_path], cancelled=lambda: cancelled[0], timeout=.3 if mode == 'timeout' else 10)
    deadline = time.monotonic() + 5
    while not processes and time.monotonic() < deadline:
        time.sleep(.01)
    assert processes
    if mode == 'cancel':
        cancelled[0] = True
    if mode == 'close':
        scan.close()
    result = measured(scan)
    assert result['status'] == ('timed_out' if mode == 'timeout' else 'cancelled')
    assert processes[0].poll() is not None


def test_missing_du_is_nonfatal(monkeypatch, tmp_path):
    def missing(*args, **kwargs):
        raise FileNotFoundError('not installed')
    monkeypatch.setattr(source_size, 'Popen', missing)
    assert measured(source_size.SourceSizeEstimate([tmp_path])) == {'status': 'failed'}


@pytest.fixture
def metrics(tmp_path, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(job_control.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(job_control.time, 'time', lambda: clock[0])
    control = job_control.JobControl('files_local', 'live-metrics-646', tmp_path / 'control')
    control.update_phase('borg_create', cancel_allowed=True)

    def update(seconds, size, **extra):
        clock[0] = 100 + seconds
        control.update_borg_progress(dict(type='archive_progress', original_size=size, **extra))
        return json.loads(control.state_file.read_text())['borg_progress']
    return control, update


def test_rate_uses_rolling_window_and_real_samples(metrics):
    control, update = metrics
    assert 'processing_speed_bytes_per_sec' not in update(0, 1000)
    assert 'processing_speed_bytes_per_sec' not in update(1, 1100)
    result = update(10, 2000, source_estimate={'status': 'ready', 'bytes': 10000})
    assert result['processing_speed_bytes_per_sec'] == 100
    assert result['estimated_percent'] == 20
    assert result['estimated_remaining_seconds'] == 80
    update(30, 5000)
    result = update(40, 6000)
    assert result['processing_speed_bytes_per_sec'] == pytest.approx(4000 / 30)
    assert len(control._processing_samples) <= 31
    assert 'processing_speed_bytes_per_sec' not in update(71, 6100)


def test_stationary_regressing_invalid_and_finished_counters(metrics):
    control, update = metrics
    update(0, 1000)
    result = update(10, 1000, source_estimate={'status': 'ready', 'bytes': 2000})
    assert result['processing_speed_bytes_per_sec'] == 0
    assert 'estimated_remaining_seconds' not in result
    assert 'processing_speed_bytes_per_sec' not in update(20, 500)
    assert 'processing_speed_bytes_per_sec' not in update(22, True)
    assert 'processing_speed_bytes_per_sec' not in update(24, 700)
    assert 'estimated_remaining_seconds' in update(26, 800)
    result = update(27, 2000, finished=True)
    assert 'original_size' not in result and 'estimated_total_bytes' not in result
    assert 'processing_speed_bytes_per_sec' not in result
    control.update_phase('borg_check', cancel_allowed=True)
    assert not control._processing_samples


def test_estimates_never_signal_success_and_fail_closed(metrics):
    _, update = metrics
    update(0, 0)
    result = update(10, 100, source_estimate={'status': 'ready', 'bytes': 100})
    assert result['estimated_percent'] == 99.9
    assert 'estimated_remaining_seconds' not in result
    result = update(12, 120, source_estimate={'status': 'ready', 'bytes': 100})
    assert result['source_size_status'] == 'outgrown'
    assert 'estimated_percent' not in result and 'estimated_remaining_seconds' not in result
    result = update(14, 130, source_estimate={'status': 'ready', 'bytes': True, 'secret': '/private'})
    assert result['source_size_status'] == 'failed'
    assert 'estimated_total_bytes' not in result and 'secret' not in result
    result = update(16, 140, source_estimate={'status': 'ready', 'bytes': 0})
    assert 'estimated_percent' not in result
