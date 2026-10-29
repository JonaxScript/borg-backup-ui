"""Read-only availability checks for backup sources on Unassigned Devices (#639)."""

from dataclasses import dataclass, field
import errno
import os
from pathlib import Path
from typing import Iterable

from .usb_storage import _read_mounts


@dataclass
class SourceAvailability:
    """Separate unavailable UD mount roots from missing configured source paths."""

    unmounted: list[Path] = field(default_factory=list)
    missing: list[Path] = field(default_factory=list)


def unassigned_source_mount(path: Path) -> Path | None:
    """Return the UD mount root for an absolute source, including child paths.

    Normalize lexical dot segments without resolving links or accessing the source.
    Other source locations and the UD container directories return None.
    """
    if not path.is_absolute():
        return None
    parts = Path(os.path.abspath(path)).parts
    if len(parts) >= 4 and parts[1] == 'mnt' and parts[2] in {'disks', 'remotes'}:
        return Path(*parts[:4])
    return None


def inspect_backup_sources(paths: Iterable[Path]) -> SourceAvailability:
    """Inspect mounts first, then stat available sources without changing storage.

    Missing UD mounts are reported without touching their paths. Real mounts may
    be read-only. Missing paths on mounted devices remain configuration errors.
    Mount-table, access/I/O and escaping-symlink errors propagate as OSError;
    they must never be interpreted as an ordinary unavailable device. This is a
    point-in-time check, not protection against unplugging during a backup.
    """
    sources = [Path(path) for path in paths]
    roots = {path: unassigned_source_mount(path) for path in sources}
    mounts = _read_mounts() if any(roots.values()) else []
    result = SourceAvailability()
    pseudo = {'rootfs', 'ramfs', 'tmpfs', 'devtmpfs', 'overlay', 'proc', 'sysfs', 'devpts', 'autofs'}
    for source in sources:
        root = roots[source]
        if root is not None:
            matches = [mount for mount in mounts if mount.path == root]
            if len(matches) > 1:
                raise OSError(errno.EBUSY, 'Ambiguous source mounts', str(root))
            if not matches or matches[0].filesystem in pseudo:
                if root not in result.unmounted:
                    result.unmounted.append(root)
                continue
        try:
            source.stat()
            if root is not None:
                resolved = source.resolve(strict=True)
                if resolved != root and root not in resolved.parents:
                    raise OSError(errno.EINVAL, 'Source resolves outside its expected mount', str(source))
        except (FileNotFoundError, NotADirectoryError):
            result.missing.append(source)
    return result
