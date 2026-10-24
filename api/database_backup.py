"""Bounded Docker database exports, owned staging and archive verification (#591).

Callers hold the existing docker-control resource for the entire operation.
Persistent operation journals prevent stale job locks from allowing an unsafe retry.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import shutil
import stat
import subprocess
import time
import uuid
from pathlib import Path
from datetime import datetime, timezone

from database_profiles import DatabaseError, data_root
from inventory_store import atomic_write_json

SCRIPTS = Path(__file__).resolve().parents[1] / 'runtime' / 'scripts'
# The supervisor remains outside the client's process group. Its terminal marker is
# written only after wait; control also checks for non-zombie group descendants.
SUPERVISOR = r'''
set -eu
umask 077
state=/dev/shm/bbui-db-$1; shift
mkdir -m 700 "$state"
command -v setsid >/dev/null || { echo 20 > "$state/done"; exit 20; }
exec 3<&0
setsid sh -s -- "$state" "$@" <&3 &
child=$!
rc=0
wait "$child" || rc=$?
printf '%s\n' "$rc" > "$state/done"
exit "$rc"
'''
LEADER = r'''
state=$1; shift
printf '%s\n' "$$" > "$state/pid"
IFS= read -r line < /proc/$$/stat
rest=${line##*) }; set -- "$@" # preserve tool parameters
printf '%s\n' "$line" > "$state/identity"
'''
# Never interpolate user data into this program. PID/start time/group membership
# must agree before signalling a process group; unknown state stays blocked.
CONTROL = r'''
set -eu
state=/dev/shm/bbui-db-$1; action=$2
[ -d "$state" ] && [ ! -L "$state" ] || { echo unknown; exit; }
[ "$(stat -c %u "$state")" = "$(id -u)" ] && [ "$(stat -c %a "$state")" = 700 ] || exit 1
if [ ! -f "$state/pid" ]; then
  if [ -f "$state/done" ]; then echo done; else echo unknown; fi
  exit
fi
read -r pid < "$state/pid"
case "$pid" in ''|*[!0-9]*) exit 1;; esac
[ "$pid" -gt 1 ] || exit 1
# Print the start time and process group from a proc stat record.
identity() { rest=${1##*) }; set -- $rest; group=$3; shift 19; printf '%s:%s' "$group" "$1"; }
live=0
for f in /proc/[0-9]*/stat; do
  IFS= read -r line < "$f" 2>/dev/null || continue
  rest=${line##*) }; set -- $rest
  if [ "$3" = "$pid" ] && [ "$1" != Z ]; then live=1; fi
done
if [ "$live" = 0 ] && [ -f "$state/done" ]; then
  if [ "$action" = ack ]; then rm -f "$state/pid" "$state/identity" "$state/done"; rmdir "$state"; fi
  echo done; exit
fi
if [ "$action" = cancel ] || [ "$action" = kill ]; then
  [ -f "$state/identity" ] && [ -r /proc/"$pid"/stat ] || { echo unknown; exit; }
  IFS= read -r old < "$state/identity"
  IFS= read -r current < /proc/"$pid"/stat
  [ "$(identity "$old")" = "$(identity "$current")" ] || { echo unknown; exit; }
  if [ "$action" = cancel ]; then kill -TERM -"$pid"; else kill -KILL -"$pid"; fi
fi
echo running
'''


def utc_now():
    """Return a timezone-qualified timestamp for durable reports."""
    return datetime.now(timezone.utc).isoformat()


def _docker(profile, container=None):
    cmd = ['docker', 'exec']
    if profile.get('execution_user'):
        cmd += ['--user', profile['execution_user']]
    return cmd + ['-i', container or profile['container'], 'env', '-i',
                  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                  'HOME=/nonexistent', 'LC_ALL=C']


def _run(cmd, **kwargs):
    """Run a short control command, suppressing untrusted client diagnostics."""
    try:
        result = subprocess.run(cmd, stderr=subprocess.DEVNULL, timeout=15, **kwargs)
        if result.returncode:
            raise DatabaseError('container_unavailable')
        return result
    except (OSError, subprocess.TimeoutExpired):
        raise DatabaseError('container_unavailable') from None


def container_identity(profile):
    """Resolve a running container once; return only its immutable ID."""
    result = _run(['docker', 'inspect', '--format', '{{.Id}} {{.State.Running}}', profile['container']],
                  stdout=subprocess.PIPE, text=True)
    parts = result.stdout.strip().split()
    if len(parts) != 2 or parts[1] != 'true' or not re.fullmatch(r'[a-f0-9]{64}', parts[0]):
        raise DatabaseError('container_unavailable')
    return parts[0]


def _control(record, action):
    try:
        result = _run(_docker(record, record['container_id']) + ['sh', '-c', CONTROL, 'bbui', record['token'], action],
                      stdout=subprocess.PIPE, text=True)
        return result.stdout.strip()
    except DatabaseError:
        return 'unknown'


def _terminate(record):
    """Stop only the verified client group; return whether termination is confirmed."""
    for action, attempts in [('cancel', 20), ('kill', 10)]:
        if _control(record, action) == 'done':
            return True
        for _ in range(attempts):
            time.sleep(0.1)
            if _control(record, 'status') == 'done':
                return True
    return False


def reconcile_operations(config):
    """Reconcile interrupted exporters while holding docker-control, or fail closed."""
    for path in (data_root(config) / 'database-operations').glob('*.json'):
        try:
            record = json.loads(path.read_text())
            if record['status'] not in ('running', 'unresolved'):
                continue
            # A removed/stopped immutable container cannot still contain an exporter.
            present = _run(['docker', 'ps', '-aq', '--no-trunc', '--filter', 'id=' + record['container_id']], stdout=subprocess.PIPE, text=True)
            if not present.stdout.strip():
                record.update(status='interrupted', finished_at=utc_now())
                atomic_write_json(path, record)
                continue
            info = _run(['docker', 'inspect', '--format', '{{.State.Running}}', record['container_id']],
                        stdout=subprocess.PIPE, text=True)
            stopped = info.stdout.strip() == 'false'
            if not stopped and not _terminate(record):
                raise DatabaseError('unresolved_export')
            record.update(status='interrupted', finished_at=utc_now())
            atomic_write_json(path, record)
            if not stopped:
                _control(record, 'ack')
        except (OSError, KeyError, ValueError):
            raise DatabaseError('unresolved_export') from None


def _operation(config, profile, cid, action, database, output, cancelled):
    """Stream a managed client to output; journal before launch and verify exit/abort."""
    token = uuid.uuid4().hex
    journal = data_root(config) / 'database-operations' / (token + '.json')
    record = {'token': token, 'container_id': cid, 'execution_user': profile['execution_user'],
              'profile_id': profile['id'], 'status': 'running', 'started_at': utc_now()}
    atomic_write_json(journal, record)
    script = LEADER + (SCRIPTS / ('database-dump-' + profile['engine'] + '.sh')).read_text()
    cmd = _docker(profile, cid) + ['sh', '-c', SUPERVISOR, 'bbui', token, action,
                                profile['credential_file'], str(profile['port']), profile['database_user'], database]
    proc = None
    reason = None
    started = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL)
        proc.stdin.write(script.encode())
        proc.stdin.close()
        limit = min(60, profile['timeout_seconds']) if action == 'probe' else profile['timeout_seconds']
        while proc.poll() is None:
            if cancelled():
                reason = 'cancelled'
                break
            if time.monotonic() - started > limit:
                reason = 'timeout'
                break
            time.sleep(0.1)
        if reason:
            if not _terminate(record):
                raise DatabaseError('unresolved_export')
            raise DatabaseError(reason)
        if _control(record, 'status') != 'done':
            if not _terminate(record):
                raise DatabaseError('unresolved_export')
        if proc.returncode:
            raise DatabaseError({21: 'credentials', 22: 'nontransactional'}.get(proc.returncode, 'export_failed'))
        if container_identity(profile) != cid:
            raise DatabaseError('container_changed')
        record['status'] = 'completed'
    except BaseException as exc:
        confirmed = proc is None or _terminate(record)
        record['status'] = 'failed' if confirmed else 'unresolved'
        if not confirmed:
            raise DatabaseError('unresolved_export') from None
        if isinstance(exc, (OSError, BrokenPipeError)):
            raise DatabaseError('export_failed') from None
        raise
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        record['finished_at'] = utc_now()
        atomic_write_json(journal, record)
        if record['status'] != 'unresolved':
            _control(record, 'ack')


def _private_path(path):
    """Reject symlinks and writable ancestors; require a private owned directory."""
    if path.resolve() != path or any(p.is_symlink() for p in [path, *path.parents]):
        raise DatabaseError('invalid_storage')
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise DatabaseError('invalid_storage')
    for parent in path.parents:
        info = parent.stat()
        if info.st_mode & 0o022 or info.st_uid not in (0, os.geteuid()):
            raise DatabaseError('invalid_storage')


def staging_root(profile, *, require_space=True):
    """Validate local persistent storage and free-space reserve; never create the mount."""
    mount, path = Path(profile['staging_mount']), Path(profile['staging_dir'])
    try:
        if not os.path.ismount(mount) or mount.resolve() != mount or mount not in path.parents:
            raise DatabaseError('invalid_storage')
        _private_path(path)
        # Verify the actual filesystem, not just its path/name.
        fs = _run(['stat', '-f', '-c', '%T', str(path)], stdout=subprocess.PIPE, text=True).stdout.strip()
        if fs not in ('btrfs', 'xfs', 'ext2/ext3', 'zfs'):
            raise DatabaseError('invalid_storage')
        if require_space and shutil.disk_usage(path).free < profile['min_free_mib'] * 1024 * 1024:
            raise DatabaseError('no_space')
    except OSError:
        raise DatabaseError('invalid_storage') from None
    return path


def validate_sources(profiles, sources):
    """Reject overlapping ordinary sources so historical/partial dumps cannot enter Borg."""
    for profile in profiles:
        root = Path(profile['staging_dir']).resolve()
        for source in sources:
            src = Path(source).resolve()
            if src == root or src in root.parents or root in src.parents:
                raise DatabaseError('source_overlap')


def _hash(path, cancelled=lambda: False):
    """Hash an artifact incrementally and honor cancellation between bounded reads."""
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            if cancelled():
                raise DatabaseError('cancelled')
            digest.update(chunk)
    return digest.hexdigest()


def _probe(config, profile, cid, database, cancelled, directory):
    """Check connectivity/versions and retain only sanitized metadata, never client diagnostics."""
    # Probe text never enters logs. Bound its disk footprint via the fixed queries.
    path = directory / '.probe'
    try:
        with path.open('xb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            _operation(config, profile, cid, 'probe', database, handle, cancelled)
        if path.stat().st_size > 65536:
            raise DatabaseError('export_failed')
        lines = path.read_text().splitlines()
        if len(lines) < 2:
            raise DatabaseError('export_failed')
        server = re.search(r'\d+(?:\.\d+)+', lines[0])
        client = re.search(r'(?:Distrib |from )?(\d+(?:\.\d+)+)', lines[1].split('Distrib ')[-1])
        if not server or not client:
            raise DatabaseError('version_mismatch')
        sv, cv = server[0], client[1]
        # V1 deliberately requires the same server/client major (major.minor for MariaDB).
        width = 2 if profile['engine'] == 'mariadb' else 1
        if sv.split('.')[:width] != cv.split('.')[:width]:
            raise DatabaseError('version_mismatch')
        return {'server_version': sv, 'client_version': cv,
                'extensions': [line for line in lines[2:] if re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', line)]}
    finally:
        path.unlink(missing_ok=True)


def export_profiles(config, profiles, job_id, run_id, cancelled=lambda: False, progress=None, check_only=False, results=None):
    """Create owned per-profile run directories and manifests; preserve completed files on failure."""
    results = results if results is not None else []
    for profile in profiles:
        if cancelled():
            raise DatabaseError('cancelled')
        root = staging_root(profile)
        directory = root / ('bbui-' + uuid.uuid4().hex)
        directory.mkdir(mode=0o700)
        manifest = {'format_version': 1, 'helper_version': 1, 'job_id': job_id, 'run_id': run_id,
                    'profile_id': profile['id'], 'engine': profile['engine'], 'started_at': utc_now(),
                    'status': 'running', 'archived': False, 'restore_tested': False, 'files': [],
                    'retention': profile['retention'], 'directory': str(directory),
                    'scope': {'databases': profile['databases'], 'globals': profile['include_globals'],
                              'credentials': False, 'application_files_consistent': False},
                    'restore': 'Use matching mariadb client or pg_restore/psql in a separate container. '
                               'Reprovision credentials, roles/grants and required extensions. See database backup guide.'}
        atomic_write_json(directory / 'manifest.json', manifest)
        results.append(manifest)
        try:
            cid = container_identity(profile)
            manifest['container_id'] = cid
            for database in profile['databases']:
                started = time.monotonic()
                versions = _probe(config, profile, cid, database, cancelled, directory)
                if check_only:
                    manifest.setdefault('checks', []).append({'database': database, **versions})
                    continue
                staging_root(profile)
                actions = ['dump']
                if profile['include_globals'] and database == profile['databases'][0]:
                    actions.append('globals')
                for action in actions:
                    name = ('globals.sql' if action == 'globals' else database + ('.sql' if profile['engine'] == 'mariadb' else '.dump'))
                    partial = directory / (name + '.partial')
                    with partial.open('xb') as handle:
                        os.fchmod(handle.fileno(), 0o600)
                        _operation(config, profile, cid, action, database, handle, cancelled)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if not partial.stat().st_size:
                        raise DatabaseError('empty_dump')
                    if profile['engine'] == 'postgresql' and action == 'dump':
                        with partial.open('rb') as handle:
                            if handle.read(5) != b'PGDMP':
                                raise DatabaseError('invalid_dump')
                    final = directory / name
                    partial.rename(final)
                    manifest['files'].append({'name': name, 'database': database, 'kind': action, **versions,
                                              'bytes': final.stat().st_size, 'sha256': _hash(final, cancelled),
                                              'duration_seconds': round(time.monotonic() - started, 3), 'status': 'dump_completed'})
                    atomic_write_json(directory / 'manifest.json', manifest)
                    if progress:
                        progress(manifest)
            manifest['status'] = 'checked' if check_only else 'dump_completed'
        except BaseException:
            manifest['status'] = 'failed'
            raise
        finally:
            manifest['finished_at'] = utc_now()
            atomic_write_json(directory / 'manifest.json', manifest)
    return results


def artifact_paths(results):
    """Return the exact completed files plus manifest from this run, never a staging tree."""
    return [Path(r['directory']) / name for r in results for name in [*[f['name'] for f in r['files']], 'manifest.json']]


def verify_archive(repo, archive, results, cancelled=lambda: False):
    """Stream required artifacts back from Borg and compare hashes without a second disk copy."""
    for path in artifact_paths(results):
        expected = _hash(path, cancelled)
        cmd = ['borg', 'extract', '--stdout', repo + '::' + archive, str(path).lstrip('/')]
        digest, size = hashlib.sha256(), 0
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        started = time.monotonic()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if cancelled() or time.monotonic() - started > 86400:
                        raise DatabaseError('cancelled' if cancelled() else 'timeout')
                    for key, _ in selector.select(timeout=.2):
                        block = os.read(key.fd, 1024 * 1024)
                        if not block:
                            selector.unregister(key.fileobj)
                        else:
                            digest.update(block)
                            size += len(block)
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    raise DatabaseError('archive_verification') from None
            if proc.returncode != 0 or size != path.stat().st_size or digest.hexdigest() != expected:
                raise DatabaseError('archive_verification')
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            proc.stdout.close()
    for result in results:
        result.update(archived=True, archive=archive, status='archived')
    return results


def cleanup_run(directory, profile, *, verified=False):
    """Remove only explicitly authorized, owned manifest-listed files; reject unknown contents."""
    root = staging_root(profile, require_space=False)
    path = Path(directory)
    if path.parent != root or not re.fullmatch(r'bbui-[a-f0-9]{32}', path.name):
        raise DatabaseError('invalid_storage')
    _private_path(path)
    if (path / 'manifest.json').is_symlink():
        raise DatabaseError('cleanup_blocked')
    manifest = json.loads((path / 'manifest.json').read_text())
    if manifest.get('profile_id') != profile['id'] or manifest.get('status') == 'running':
        raise DatabaseError('cleanup_blocked')
    if verified and manifest.get('status') != 'archived':
        raise DatabaseError('cleanup_blocked')
    allowed = {'manifest.json', '.probe', '.verify'}
    databases = manifest.get('scope', {}).get('databases', [])
    if not isinstance(databases, list) or any(not isinstance(db, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}', db) for db in databases):
        raise DatabaseError('cleanup_blocked')
    for database in databases:
        name = database + ('.sql' if manifest['engine'] == 'mariadb' else '.dump')
        allowed.update((name, name + '.partial'))
    if manifest.get('scope', {}).get('globals'):
        allowed.update(('globals.sql', 'globals.sql.partial'))
    children = list(path.iterdir())
    if any(p.name not in allowed or p.is_symlink() or not p.is_file() or p.stat().st_uid != os.geteuid() for p in children):
        raise DatabaseError('cleanup_blocked')
    for child in children:
        child.unlink()
    path.rmdir()
