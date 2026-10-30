from job_fixtures import job_id
import json
import logging
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = ROOT / "runtime"
if str(RUNTIME_ROOT) not in sys.path:
    sys.path.insert(0, str(RUNTIME_ROOT))

from runtime.lib.backup_job import (
    REQUIRED_SOURCE_PATHS_MISSING,
    BackupJob,
    BackupJobConfig,
    RequiredSourcePathsMissing,
)
from runtime.lib.status import BackupStatus


def _config(tmp_path: Path, source_paths: list[Path]) -> BackupJobConfig:
    return BackupJobConfig(
        job_name="Required sources",
        job_id=job_id("data_local"),
        backup_type="data",
        backup_location="local",
        lock_file=tmp_path / "job.lock",
        log_dir=tmp_path / "logs",
        log_file=tmp_path / "logs" / "backup.log",
        backup_paths=source_paths,
        borg_cache_dir=tmp_path / "cache",
        date_tag="2026-07-14_12-00-00",
        status_dir=tmp_path / "status",
    )


class _RuntimeManager:
    def __init__(self) -> None:
        self.stop_calls = 0

    def stop_all(self, _log_file: str):
        self.stop_calls += 1
        raise AssertionError("runtime services must not be stopped")


def _run_validation(config: BackupJobConfig, manager: _RuntimeManager) -> None:
    with BackupJob(config, docker_manager=manager) as job:
        job.check_prerequisites()
        job.stop_docker()
        raise AssertionError("borg create and maintenance must remain unreachable")


def test_one_missing_required_source_aborts_before_runtime_and_persists_failure(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing = tmp_path / "missing"
    manager = _RuntimeManager()
    config = _config(tmp_path, [missing])
    config.borg_repo = str(tmp_path / "repository")
    borg_calls = []

    def reject_borg_call(*args, **kwargs):
        borg_calls.append((args, kwargs))
        raise AssertionError("Borg must not run when a required source is missing")

    monkeypatch.setattr("runtime.lib.backup_job.subprocess.run", reject_borg_call)

    with caplog.at_level(logging.INFO), pytest.raises(RequiredSourcePathsMissing):
        _run_validation(config, manager)

    assert manager.stop_calls == 0
    assert borg_calls == []
    assert str(missing) in caplog.text
    assert "prune, or compact" in caplog.text
    status_file = next((tmp_path / "status").glob("*.status"))
    payload = json.loads(status_file.read_text(encoding="utf-8"))
    assert payload["status"] == "error"
    assert payload["exit_code"] == 2
    assert payload["failure_code"] == REQUIRED_SOURCE_PATHS_MISSING
    assert str(missing) in payload["error_message"]

    parsed = BackupStatus.from_file(status_file)
    assert parsed.failure_code == REQUIRED_SOURCE_PATHS_MISSING


def test_all_missing_required_sources_are_reported_together(
    tmp_path: Path,
) -> None:
    missing = [tmp_path / "first missing", tmp_path / "second missing"]
    manager = _RuntimeManager()

    with pytest.raises(RequiredSourcePathsMissing) as exc_info:
        _run_validation(_config(tmp_path, missing), manager)

    assert exc_info.value.missing_paths == missing
    assert all(str(path) in str(exc_info.value) for path in missing)
    assert manager.stop_calls == 0
    status_file = next((tmp_path / "status").glob("*.status"))
    payload = json.loads(status_file.read_text(encoding="utf-8"))
    assert payload["missing_source_paths"] == [str(path) for path in missing]


def test_existing_file_and_directory_sources_keep_valid_job_behavior(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_dir = tmp_path / "directory"
    source_dir.mkdir()
    source_file = tmp_path / "single-file.txt"
    source_file.write_text("data", encoding="utf-8")
    config = _config(tmp_path, [source_dir, source_file])

    monkeypatch.setattr("runtime.lib.backup_job.shutil.which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        "runtime.lib.backup_job.subprocess.run",
        lambda *args, **kwargs: type("Result", (), {"stdout": "borg 1.4.5\n", "returncode": 0})(),
    )

    job = BackupJob(config)
    job.check_prerequisites()

    assert config.borg_cache_dir.is_dir()


@pytest.mark.parametrize('paths,reason', [
    (['/mnt/disks/USB/photos'], 'source_disk_not_mounted'),
    (['/mnt/remotes/server_share/data'], 'source_remote_not_mounted'),
    (['/mnt/disks/USB', '/mnt/remotes/server_share'], 'source_mounts_not_mounted'),
])
def test_absent_ud_sources_skip_entire_local_target_job(tmp_path, monkeypatch, paths, reason):
    from runtime.lib import source_availability
    monkeypatch.setattr(source_availability, '_read_mounts', lambda: [])
    config = _config(tmp_path, [Path(path) for path in paths] + [tmp_path])
    config.borg_repo = str(tmp_path / 'repository')
    manager = _RuntimeManager()
    def reject_borg(*args, **kwargs):
        raise AssertionError('No Borg operation is allowed for an unmounted source')
    monkeypatch.setattr('runtime.lib.backup_job.subprocess.run', reject_borg)
    with pytest.raises(SystemExit) as caught:
        _run_validation(config, manager)
    assert caught.value.code == 0
    assert manager.stop_calls == 0
    payload = json.loads(next(config.status_dir.glob('*.status')).read_text())
    assert payload['status'] == 'skipped'
    assert payload['exit_code'] == 0
    assert payload['skip_reason_code'] == reason
    assert payload['location'] == 'local'
    assert config.backup_paths == [Path(path) for path in paths] + [tmp_path]


def test_unmounted_source_does_not_hide_missing_required_source(tmp_path, monkeypatch):
    from runtime.lib import source_availability
    monkeypatch.setattr(source_availability, '_read_mounts', lambda: [])
    missing = tmp_path / 'missing'
    with pytest.raises(RequiredSourcePathsMissing) as caught:
        _run_validation(_config(tmp_path, [Path('/mnt/disks/USB'), missing]), _RuntimeManager())
    assert caught.value.missing_paths == [missing]
    payload = json.loads(next((tmp_path / 'status').glob('*.status')).read_text())
    assert payload['status'] == 'error'
