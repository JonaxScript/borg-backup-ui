"""Mount-aware source validation without touching real Unraid devices (#639)."""

import errno
from pathlib import Path

import pytest

from runtime.lib import source_availability as sources
from runtime.lib.usb_storage import Mount


@pytest.mark.parametrize("path,root", [
    ("/mnt/disks/USB Drive/photos", "/mnt/disks/USB Drive"),
    ("/mnt/remotes/server_share", "/mnt/remotes/server_share"),
    ("/mnt/remotes/server_share/a/../b", "/mnt/remotes/server_share"),
    ("/mnt/disks/USB/../../user/data", None),
    ("/mnt/disks", None), ("/mnt/remotes", None),
    ("/mnt/disk1/data", None), ("/mnt/user/data", None),
    ("/mnt/disks-other/USB", None), ("mnt/disks/USB", None),
])
def test_only_ud_source_roots_are_classified(path, root):
    assert sources.unassigned_source_mount(Path(path)) == (Path(root) if root else None)


@pytest.mark.parametrize("mounts", [
    [], [Mount(Path("/mnt"), "tmpfs", False)],
    [Mount(Path("/mnt/disks/USB/child"), "ext4", False)],
    [Mount(Path("/mnt/disks/USB"), "tmpfs", False)],
])
def test_absent_mount_never_stats_leftover_mountpoint(monkeypatch, mounts):
    monkeypatch.setattr(sources, "_read_mounts", lambda: mounts)

    def unexpected_stat(*args, **kwargs):
        raise AssertionError("Unmounted source must not be accessed")

    with monkeypatch.context() as patch:
        patch.setattr(Path, "stat", unexpected_stat)
        result = sources.inspect_backup_sources([
            Path("/mnt/disks/USB"), Path("/mnt/disks/USB/child"),
        ])
    assert result.unmounted == [Path("/mnt/disks/USB")]
    assert result.missing == []


@pytest.mark.parametrize("filesystem,read_only", [("ext4", False), ("btrfs", True), ("cifs", True), ("nfs4", False)])
def test_real_mount_including_readonly_accepts_existing_source(monkeypatch, filesystem, read_only):
    root = Path("/mnt/remotes/share")
    source = root / "file.txt"
    monkeypatch.setattr(sources, "_read_mounts", lambda: [Mount(root, filesystem, read_only)])
    with monkeypatch.context() as patch:
        patch.setattr(Path, "stat", lambda *_args, **_kwargs: object())
        patch.setattr(Path, "resolve", lambda self, **_kwargs: self)
        result = sources.inspect_backup_sources([source])
    assert result == sources.SourceAvailability()


@pytest.mark.parametrize("error", [FileNotFoundError(), NotADirectoryError()])
def test_mounted_source_with_missing_subpath_is_missing(monkeypatch, error):
    root = Path("/mnt/disks/USB")
    monkeypatch.setattr(sources, "_read_mounts", lambda: [Mount(root, "ext4", False)])
    def fail(*_args, **_kwargs):
        raise error
    with monkeypatch.context() as patch:
        patch.setattr(Path, "stat", fail)
        result = sources.inspect_backup_sources([root / "missing"])
    assert result.unmounted == []
    assert result.missing == [root / "missing"]


@pytest.mark.parametrize("code", [errno.EACCES, errno.EIO, errno.ESTALE])
def test_access_and_io_errors_are_not_unavailability(monkeypatch, code):
    root = Path("/mnt/remotes/share")
    monkeypatch.setattr(sources, "_read_mounts", lambda: [Mount(root, "cifs", False)])
    def fail(*_args, **_kwargs):
        raise OSError(code, "Source inspection failed")
    with monkeypatch.context() as patch:
        patch.setattr(Path, "stat", fail)
        with pytest.raises(OSError) as caught:
            sources.inspect_backup_sources([root])
    assert caught.value.errno == code


def test_unreadable_mount_table_is_not_unmounted(monkeypatch):
    def fail():
        raise OSError(errno.EIO, "Mount table unavailable")
    monkeypatch.setattr(sources, "_read_mounts", fail)
    with pytest.raises(OSError, match="Mount table unavailable"):
        sources.inspect_backup_sources([Path("/mnt/disks/USB")])


def test_ambiguous_mount_and_symlink_escape_fail_closed(monkeypatch):
    root = Path("/mnt/disks/USB")
    mounts = [Mount(root, "ext4", False)] * 2
    monkeypatch.setattr(sources, "_read_mounts", lambda: mounts)
    with pytest.raises(OSError, match="Ambiguous"):
        sources.inspect_backup_sources([root])
    mounts.pop()
    with monkeypatch.context() as patch:
        patch.setattr(Path, "stat", lambda *_args, **_kwargs: object())
        patch.setattr(Path, "resolve", lambda *_args, **_kwargs: Path("/mnt/user/other"))
        with pytest.raises(OSError, match="outside"):
            sources.inspect_backup_sources([root / "link"])


def test_ordinary_sources_need_no_mount_table(tmp_path, monkeypatch):
    def unexpected_read():
        raise AssertionError("Ordinary sources do not require a mount lookup")
    monkeypatch.setattr(sources, "_read_mounts", unexpected_read)
    file = tmp_path / "file.txt"
    file.write_text("data")
    result = sources.inspect_backup_sources([tmp_path, file, tmp_path / "missing"])
    assert result.unmounted == []
    assert result.missing == [tmp_path / "missing"]
