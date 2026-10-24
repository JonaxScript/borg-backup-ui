"""Conservative retention of completed database operation metadata (#593).

Never prune dumps, Secrets or unclassified crash remnants. All inspection and
deletion takes place under docker-control, using private directory descriptors.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
import re
import stat

from database_profiles import data_root

RETENTION_DAYS = 30


@contextmanager
def _directory(path, *, parent=None):
    """Open an owned directory without following links; close it on every exit."""
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError('unsafe_directory')
        yield fd
    finally:
        os.close(fd)


def _record(fd, name):
    """Read bounded regular owned JSON; reject links and incomplete records."""
    source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(source, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_size > 4 * 1024 * 1024:
            raise ValueError('unsafe_record')
        row = json.loads(stream.read(4 * 1024 * 1024 + 1))
    if not isinstance(row, dict):
        raise ValueError('invalid_record')
    return row


def _expired(row, kind, cutoff):
    """Require a known terminal status and valid ordered, timezone-aware dates."""
    statuses = {'completed', 'failed', 'interrupted'} if kind == 'database-operations' else {'completed', 'failed', 'cancelled'}
    if row.get('status') not in statuses or row.get('error_code') in ('database_unresolved_export', 'database_operation_failed'):
        return False
    try:
        start = datetime.fromisoformat(row['started_at'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(row['finished_at'].replace('Z', '+00:00'))
        return start.tzinfo is not None and end.tzinfo is not None and start <= end < cutoff
    except (KeyError, ValueError, TypeError, AttributeError):
        return False


def _discovery(root, name):
    """Remove only a journal-linked discovery directory containing owned names output.

    Unknown children or symlinks preserve the entire directory and its journal.
    Already absent directories are harmless after interrupted housekeeping.
    """
    if not isinstance(name, str) or not re.fullmatch(r'discovery-[a-z0-9_]{8}', name):
        raise ValueError('unknown_discovery')
    try:
        with _directory('database-discovery', parent=root) as parent:
            with _directory(name, parent=parent) as fd:
                children = os.listdir(fd)
                if any(child != 'names' for child in children):
                    raise ValueError('unknown_discovery_content')
                for child in children:
                    info = os.stat(child, dir_fd=fd, follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                        raise ValueError('unsafe_discovery_content')
                for child in children:
                    os.unlink(child, dir_fd=fd)
            os.rmdir(name, dir_fd=parent)
        return 1
    except FileNotFoundError:
        return 0


def prune_completed(config, *, now=None):
    """Prune confirmed terminal records older than 30 days; return count-only results.

    Busy resources defer the pass. Invalid timestamps, unknown names/statuses,
    symlinks, malformed JSON and unlinked discovery leftovers are retained.
    No reconciliation, process termination or database export is performed here.
    """
    from jobs_api import resolve_resource_lock_dir
    from wizard_runner import ResourceLockSet
    result = {'removed': 0, 'discovery_removed': 0, 'preserved': 0, 'busy': False}
    locks = ResourceLockSet(resolve_resource_lock_dir(config), job_key='database-housekeeping', operation='database-housekeeping')
    ok, _ = locks.acquire(['docker-control'])
    if not ok:
        result['busy'] = True
        return result
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=RETENTION_DAYS)
    try:
        with _directory(data_root(config)) as root:
            for kind, key in [('database-operations', 'token'), ('database-tests', 'id')]:
                try:
                    with _directory(kind, parent=root) as fd:
                        for name in os.listdir(fd):
                            try:
                                if not re.fullmatch(r'[a-f0-9]{32}\.json', name):
                                    raise ValueError('unknown_name')
                                row = _record(fd, name)
                                if row.get(key) != name[:-5] or not _expired(row, kind, cutoff):
                                    raise ValueError('not_expired')
                                if 'discovery_directory' in row:
                                    result['discovery_removed'] += _discovery(root, row['discovery_directory'])
                                os.unlink(name, dir_fd=fd)
                                result['removed'] += 1
                            except (OSError, ValueError, TypeError):
                                result['preserved'] += 1
                except FileNotFoundError:
                    pass
                except (OSError, ValueError):
                    result['preserved'] += 1
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        result['preserved'] += 1
    finally:
        locks.release()
    return result
