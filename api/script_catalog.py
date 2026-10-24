"""Read-only, administrator-only catalog of managed database helpers and practical hook templates.

Catalog IDs are resolved against fixed application/documentation roots, never
against the configurable data or Secrets directory. Reading never executes code.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
MAX_SOURCE_BYTES = 2 * 1024 * 1024


def _template_root():
    """Return canonical source locations in a checkout or installed package."""
    templates = APP_ROOT / 'ui/docs/examples/job-hooks'
    if not templates.is_dir():
        templates = APP_ROOT / 'docs/examples/job-hooks'
    return templates / 'practical'


def _regular_source(path):
    """Reject links, special files and oversized sources before listing them."""
    try:
        info = path.lstat()
        return (path.resolve() == path and stat.S_ISREG(info.st_mode)
                and info.st_size <= MAX_SOURCE_BYTES)
    except OSError:
        return False


def _entries():
    """Build an ID-to-file allowlist from managed database helpers and four explicitly selected hook templates, excluding user data."""
    templates = _template_root()
    entries = {}
    for name in ('database-dump-mariadb.sh', 'database-dump-postgresql.sh', 'database-dump-mysql.sh', 'database-dump-mongodb.sh', 'database-dump-redis.sh', 'database-dump-sqlite.py'):
        path = APP_ROOT / 'runtime/scripts' / name
        if _regular_source(path):
            relative = 'runtime/scripts/' + name
            entries['managed:' + relative] = (path, 'managed', relative)
    # Database exports belong to managed profiles, not the editable hook catalog.
    for name in ('post-json-webhook.sh', 'pre-check-free-space.sh', 'pre-check-source.sh', 'pre-wake-server.sh'):
        path = templates / name
        if _regular_source(path):
            relative = 'practical/' + path.name
            entries['template:' + relative] = (path, 'template', relative)

    return entries


def _metadata(identifier, entry):
    """Describe source ownership and language without loading source contents."""
    path, kind, relative = entry
    return {'id': identifier, 'kind': kind, 'name': path.name, 'path': relative,
            'language': 'python' if path.suffix == '.py' else 'bash',
            'timeout_seconds': 1800 if path.name.startswith('pre-dump-') else 150 if path.name == 'pre-wake-server.sh' else 30}


def list_catalog():
    """List shipped templates and managed sources; no passwords, user files or execution."""
    return {'entries': [_metadata(identifier, entry) for identifier, entry in _entries().items()]}


def read_catalog_source(identifier):
    """Read one allowlisted source with O_NOFOLLOW; reject arbitrary paths and IDs.

    Returns metadata and UTF-8 content, bounded to 2 MiB. Missing/unsafe sources
    raise FileNotFoundError with a fixed message. No caller-selected path is opened.
    """
    entry = _entries().get(identifier)
    if entry is None:
        raise FileNotFoundError('Script source is unavailable')
    path = entry[0]
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SOURCE_BYTES:
                raise ValueError
            content = source.read(MAX_SOURCE_BYTES + 1)
        if len(content) > MAX_SOURCE_BYTES:
            raise ValueError
        return {'script': {**_metadata(identifier, entry), 'content': content.decode('utf-8')}}
    except (OSError, ValueError, UnicodeError):
        raise FileNotFoundError('Script source is unavailable') from None
