#!/usr/bin/env python3
"""Managed by Borg Backup UI; local changes may be overwritten by plugin updates.

Verwaltet durch Borg Backup UI; lokale Aenderungen koennen bei Updates
ueberschrieben werden. Configure Settings > Database backups, not a Pre/Post hook.

Purpose: use SQLite's native Online Backup API on a local Docker bind-mounted
file, including committed WAL transactions. The source opens read-only (never
immutable, which would ignore WAL). No sqlite3 executable inside the container is
required. SQLCipher/encrypted databases and network/FUSE filesystems are excluded.

The caller validates the Docker mapping and local filesystem, owns docker-control
and private staging, and provides cancellation/deadline checks. The API produces
one independently usable SQLite file, runs quick_check and streams it to the
caller's gzip sink. Temporary uncompressed space approximately the database size
is needed on dump storage; no snapshot is written to the boot stick or RAM.

Only database contents are included, not application config, media or external
blobs. Stash users must also back up those files, or use Stash's own full-backup
function. Restore while the application is stopped, using the application's
restore procedure; the dump must not be overlaid on live WAL/SHM sidecars.
"""
from contextlib import closing
from pathlib import Path
import os
import sqlite3
from urllib.parse import quote


def run(source, action, output, check, directory=None):
    """Read a SQLite source; report versions or stream a verified online snapshot.

    check() raises on timeout/cancellation. directory is private local staging for
    dump only. Errors propagate to the caller for safe localization. No process
    survives this function or its hosting process; all connections close on exit.
    """
    uri = 'file:' + quote(str(source), safe='/') + '?mode=ro'
    check()
    with closing(sqlite3.connect(uri, uri=True, timeout=1)) as origin:
        origin.execute('PRAGMA trusted_schema=OFF')
        origin.set_progress_handler(lambda: (check(), 0)[1], 1000)
        # Read actual schema: an empty/missing/non-SQLite file is not a valid source.
        origin.execute('SELECT count(*) FROM sqlite_schema').fetchone()
        if action == 'discover':
            output.write(b'database\n')
            return
        if action == 'probe':
            output.write((sqlite3.sqlite_version + '\n' + sqlite3.sqlite_version + '\n').encode())
            return
        if action != 'dump' or directory is None:
            raise ValueError('invalid_action')
        target = Path(directory) / '.sqlite-snapshot'
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        try:
            with closing(sqlite3.connect(str(target))) as destination:
                origin.backup(destination, pages=256, progress=lambda *args: check(), sleep=.05)
                destination.execute('PRAGMA trusted_schema=OFF')
                destination.set_progress_handler(lambda: (check(), 0)[1], 1000)
                if destination.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                    raise ValueError('invalid_snapshot')
            with target.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    check()
                    output.write(block)
        finally:
            for suffix in ('', '-journal', '-wal', '-shm'):
                Path(str(target) + suffix).unlink(missing_ok=True)
