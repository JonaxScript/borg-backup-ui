"""Bounded Docker database exports, owned staging and archive verification (#591).

Callers hold the existing docker-control resource for the entire operation.
Persistent operation journals prevent stale job locks from allowing an unsafe retry.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import time
import tempfile
import uuid
from pathlib import Path
from datetime import datetime, timezone
from contextlib import contextmanager

from database_profiles import DatabaseError, data_root, read_password, profile_slug
from inventory_store import atomic_write_json

SCRIPTS = Path(__file__).resolve().parents[1] / 'runtime' / 'scripts'
# The supervisor remains outside the client's process group. Its terminal marker is
# written only after wait; control also checks for non-zombie group descendants.
SUPERVISOR = r'''
set -eu
umask 077
state=/dev/shm/bbui-db-$1; shift
mkdir -m 700 "$state"
trap 'rm -f "$state/credentials"' EXIT
command -v setsid >/dev/null || { echo 24 > "$state/done"; exit 24; }
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
  if [ -f "$state/done" ]; then
    if [ "$action" = ack ]; then rm -f "$state/done" "$state/credentials"; rmdir "$state"; fi
    echo done
  else echo unknown; fi
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
  if [ "$action" = ack ]; then rm -f "$state/pid" "$state/identity" "$state/done" "$state/credentials"; rmdir "$state"; fi
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
    """Stream bounded chunks to a binary sink, including a gzip writer.

    Journal before launch; monitor timeout/cancellation while draining Docker stdout.
    Sink/pipe failures terminate the owned exporter group and never mark completion.
    """
    if profile['engine'] == 'sqlite':
        return _sqlite_operation(profile, cid, action, output, cancelled)
    token = uuid.uuid4().hex
    journal = data_root(config) / 'database-operations' / (token + '.json')
    record = {'token': token, 'container_id': cid, 'execution_user': profile['execution_user'],
              'profile_id': profile['id'], 'status': 'running', 'started_at': utc_now()}
    if action == 'discover':
        record['discovery_directory'] = Path(output.name).parent.name
    credentials = ''
    credential_file = profile.get('credential_file', '')
    if profile.get('auth_mode') in ('managed', 'none'):
        password = read_password(config, profile) if profile['auth_mode'] == 'managed' else ''
        if profile['engine'] in ('mariadb', 'mysql'):
            escaped = password.replace('\\', '\\\\').replace('"', '\\"').replace('\t', '\\t')
            content = '[client]\nuser=' + profile['database_user'] + '\npassword="' + escaped + '"\n'
        elif profile['engine'] == 'mongodb':
            content = json.dumps({'password': password}) + '\n'
        elif profile['engine'] == 'redis':
            content = password + '\n'
        else:
            escaped = password.replace('\\', '\\\\').replace(':', '\\:')
            content = f"127.0.0.1:{profile['port']}:*:{profile['database_user']}:{escaped}\n"
        delimiter = 'BBUI_SECRET_' + uuid.uuid4().hex
        # Only stdin carries secret bytes. A quoted here-document disables shell expansion.
        credentials = f'cat > "$state/credentials" <<\'{delimiter}\'\n{content}{delimiter}\n'
        credential_file = '/dev/shm/bbui-db-' + token + '/credentials'
    script = LEADER + credentials + (SCRIPTS / ('database-dump-' + profile['engine'] + '.sh')).read_text()
    journal.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic_write_json(journal, record)
    cmd = _docker(profile, cid) + ['sh', '-c', SUPERVISOR, 'bbui', token, action,
                                credential_file, str(profile['port']), '' if profile.get('auth_mode') == 'none' else profile['database_user'], database]
    if profile['engine'] == 'mongodb':
        cmd += [profile['authentication_database']]
    proc = None
    reason = None
    started = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        proc.stdin.write(script.encode())
        proc.stdin.close()
        limit = min(60, profile['timeout_seconds']) if action in ('probe', 'discover') else profile['timeout_seconds']
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            while selector.get_map() or proc.poll() is None:
                if cancelled():
                    reason = 'cancelled'
                    break
                if time.monotonic() - started > limit:
                    reason = 'timeout'
                    break
                for key, _ in selector.select(timeout=.1):
                    block = os.read(key.fd, 1024 * 1024)
                    if block:
                        output.write(block)
                    else:
                        selector.unregister(key.fileobj)
        if reason:
            if not _terminate(record):
                raise DatabaseError('unresolved_export')
            raise DatabaseError(reason)
        if _control(record, 'status') != 'done':
            if not _terminate(record):
                raise DatabaseError('unresolved_export')
        if proc.returncode:
            raise DatabaseError({21: 'credentials', 22: 'nontransactional', 23: 'mongodb_replica_required', 24: 'tools_missing'}.get(proc.returncode, 'export_failed'))
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
        if proc and proc.stdout:
            proc.stdout.close()
        record['finished_at'] = utc_now()
        atomic_write_json(journal, record)
        if record['status'] != 'unresolved':
            _control(record, 'ack')


def _sqlite_operation(profile, cid, action, output, cancelled):
    """Back up an explicit SQLite path from local Docker bind storage in this process.

    No background exporter survives cancellation or process exit. Named volumes,
    network/FUSE paths, links, missing files and paths outside directory binds are
    rejected. The container path is mapped using the captured immutable Docker ID.
    """
    import importlib.util
    try:
        import sqlite3
    except ImportError:
        raise DatabaseError('tools_missing') from None
    from contextlib import ExitStack
    started = time.monotonic()
    def check():
        if cancelled():
            raise DatabaseError('cancelled')
        if time.monotonic() - started > profile['timeout_seconds']:
            raise DatabaseError('timeout')
    try:
        mounts = json.loads(_run(['docker', 'inspect', '--format', '{{json .Mounts}}', cid], stdout=subprocess.PIPE, text=True).stdout)
        source = Path(profile['sqlite_path'])
        matches = [m for m in mounts if source == Path(m['Destination']) or Path(m['Destination']) in source.parents]
        if not matches:
            raise DatabaseError('sqlite_source')
        mount = max(matches, key=lambda m: len(Path(m['Destination']).parts))
        if mount['Type'] != 'bind' or source == Path(mount['Destination']):
            raise DatabaseError('sqlite_source')
        host = Path(mount['Source']) / source.relative_to(mount['Destination'])
        # Anchor every parent and validate the final source; WAL must remain next
        # to the opened database, so use the held parent path, not a file FD URI.
        with ExitStack() as stack:
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
            stack.callback(os.close, fd)
            for part in host.parent.parts[1:]:
                fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                stack.callback(os.close, fd)
            try:
                _local_filesystem(fd)
            except DatabaseError:
                raise DatabaseError('sqlite_source') from None
            anchored = _descriptor_path(fd) / host.name
            for suffix in ('', '-wal', '-shm', '-journal'):
                p = Path(str(anchored) + suffix)
                if p.is_symlink():
                    raise DatabaseError('sqlite_source')
            source_fd = os.open(host.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            stack.callback(os.close, source_fd)
            info = os.fstat(source_fd)
            if not stat.S_ISREG(info.st_mode) or os.read(source_fd, 16) != b'SQLite format 3\x00':
                raise DatabaseError('sqlite_source')
            filename = output.fileobj.name if isinstance(output, gzip.GzipFile) else output.name
            directory = Path(filename).parent
            spec = importlib.util.spec_from_file_location('bbui_sqlite_helper', SCRIPTS / 'database-dump-sqlite.py')
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            helper.run(anchored, action, output, check, directory if action == 'dump' else None)
            if not os.path.samestat(info, anchored.stat()):
                raise DatabaseError('sqlite_source')
        if container_identity(profile) != cid:
            raise DatabaseError('container_changed')
    except DatabaseError:
        raise
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        check()
        raise DatabaseError('sqlite_source') from None


def _private_path(path):
    """Require an owned 0700 directory without following a final symlink.

    Call only below an already opened private staging directory; ancestor pool
    permissions vary and are deliberately not checked here.
    """
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise DatabaseError('storage_permissions')


def _descriptor_path(fd):
    """Return a parent-process descriptor path usable by Python and Borg children."""
    return Path('/proc') / str(os.getpid()) / 'fd' / str(fd)


def _local_filesystem(fd):
    """Reject unsupported backing filesystems using the already opened directory."""
    try:
        fs = _run(['stat', '-f', '-c', '%T', str(_descriptor_path(fd))], stdout=subprocess.PIPE, text=True).stdout.strip()
    except DatabaseError:
        raise DatabaseError('storage_filesystem') from None
    if fs not in ('btrfs', 'xfs', 'ext2/ext3', 'zfs'):
        raise DatabaseError('storage_filesystem')


@contextmanager
def open_staging(profile, *, require_space=True):
    """Yield an owned private directory FD on a mounted local filesystem.

    Pool/ancestor ownership and modes are left unchanged. Every component is
    opened without following symlinks. All later I/O must use the held FD so a
    rename/replacement in a writable pool cannot redirect exports or cleanup.
    Only an explicit export may create a missing direct child of the mount.
    Descriptors are closed on all exits; errors contain safe diagnostic codes.
    """
    mount, path = Path(profile['staging_mount']), Path(profile['staging_dir'])
    fd = None
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        if not mount.is_absolute() or not path.is_absolute() or '..' in path.parts or '..' in mount.parts or mount not in path.parents:
            raise DatabaseError('storage_path')
        fd = os.open('/', flags)
        for component in mount.parts[1:]:
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        if not os.path.ismount(mount) or not os.path.samestat(os.fstat(fd), mount.stat()):
            raise DatabaseError('storage_mount')
        _local_filesystem(fd)
        parts = path.relative_to(mount).parts
        for component in parts:
            try:
                child = os.open(component, flags, dir_fd=fd)
            except FileNotFoundError:
                if not require_space or len(parts) != 1:
                    raise
                os.mkdir(component, mode=0o700, dir_fd=fd)
                child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise DatabaseError('storage_permissions')
        _local_filesystem(fd)
        if require_space:
            space = os.fstatvfs(fd)
            if space.f_bavail * space.f_frsize < profile['min_free_mib'] * 1024 * 1024:
                raise DatabaseError('no_space')
        yield fd
    except OSError:
        raise DatabaseError('storage_path') from None
    finally:
        if fd is not None:
            os.close(fd)


def staging_root(profile, *, require_space=True):
    """Validate storage without retaining a handle; use open_staging for actual I/O."""
    with open_staging(profile, require_space=require_space):
        return Path(profile['staging_dir'])


class DumpResult(dict):
    """Serializable manifest with a process-local staging FD, never serialized.

    Keep the handle until archive verification/cleanup finishes. close_results
    releases it explicitly; the destructor also covers abandoned failed calls.
    """

    def __init__(self, root_fd, **manifest):
        super().__init__(manifest)
        self._root_fd = os.dup(root_fd)

    @property
    def path(self):
        """Return this run below its held staging directory; reject closed handles."""
        if self._root_fd is None:
            raise DatabaseError('storage_path')
        return _descriptor_path(self._root_fd) / Path(self['directory']).name

    def close(self):
        """Release the staging descriptor, idempotently, without deleting dumps."""
        fd, self._root_fd = self._root_fd, None
        if fd is not None:
            os.close(fd)

    def __copy__(self):
        """Copy only manifest data; a report must never own the live descriptor."""
        return dict(self)

    def __deepcopy__(self, memo):
        """Return detached report data without copying or closing the live handle."""
        return copy.deepcopy(dict(self), memo)

    def __del__(self):
        if getattr(self, '_root_fd', None) is not None:
            self.close()


def close_results(results):
    """Release all live export handles after the caller's final file operation."""
    for result in results:
        if isinstance(result, DumpResult):
            result.close()


def result_directory(result):
    """Return an anchored directory for live exports, or a stored manifest path."""
    return result.path if isinstance(result, DumpResult) else Path(result['directory'])


def write_manifest(result):
    """Persist a manifest through the held private directory when available."""
    atomic_write_json(result_directory(result) / 'manifest.json', result)


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
        if profile['engine'] == 'mongodb' and tuple(map(int, cv.split('.')[:2])) < (100, 3):
            raise DatabaseError('tools_missing')
        # SQL/Redis major versions match (major.minor for MySQL/MariaDB).
        # MongoDB Database Tools use independent 100.x version numbers.
        width = 2 if profile['engine'] in ('mariadb', 'mysql') else 1
        if profile['engine'] != 'mongodb' and sv.split('.')[:width] != cv.split('.')[:width]:
            raise DatabaseError('version_mismatch')
        return {'server_version': sv, 'client_version': cv,
                'extensions': [line for line in lines[2:] if re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', line)]}
    finally:
        path.unlink(missing_ok=True)


def run_directory_name(profile_name, started_at):
    """Return a safe profile slug and server-local timestamp/offset, without a UUID."""
    stamp = datetime.fromisoformat(started_at).astimezone().strftime('%Y-%m-%d_%H-%M-%S%z')
    return f'bbui-{profile_slug(profile_name)}-{stamp}'


def is_run_directory_name(name):
    """Accept readable names and retained UUID-only or profile/time/UUID runs."""
    stamp = r'[a-z0-9][a-z0-9-]{0,59}-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}[+-][0-9]{4}'
    return bool(re.fullmatch(r'bbui-(?:' + stamp + r'(?:-[a-f0-9]{32})?|[a-f0-9]{32})', name))


def export_profiles(config, profiles, job_id, run_id, cancelled=lambda: False, progress=None, check_only=False, results=None):
    """Export into held private directories; retain completed files on failure.

    New runs use profile/time directory names and stream raw client bytes through
    gzip level 6 without an uncompressed staging copy. Publish .gz files only after
    successful client exit, nonempty input, gzip close and fsync. Manifests record
    original byte counts and compressed sizes/hashes; failed partial files remain.
    Returns JSON-serializable DumpResult manifests. Call close_results after the
    final archive/cleanup operation; pass results to retain partial manifests and
    explicitly close handles even when this function raises.
    """
    results = results if results is not None else []
    for profile in profiles:
        if cancelled():
            raise DatabaseError('cancelled')
        started_at = utc_now()
        name = run_directory_name(profile['name'], started_at)
        with open_staging(profile) as fd:
            try:
                os.mkdir(name, mode=0o700, dir_fd=fd)
            except FileExistsError:
                raise DatabaseError('dump_exists') from None
            manifest = DumpResult(fd)
        directory = _descriptor_path(manifest._root_fd) / name
        manifest.update({'format_version': 1, 'helper_version': 1, 'job_id': job_id, 'run_id': run_id,
                    'profile_id': profile['id'], 'profile_name': profile['name'], 'engine': profile['engine'], 'started_at': started_at,
                    'compression': 'gzip',
                    'status': 'running', 'archived': False, 'restore_tested': False, 'files': [],
                    'retention': profile['retention'], 'directory': str(Path(profile['staging_dir']) / name),
                    'archive_directory': name,
                    'scope': {'databases': profile['databases'], 'globals': profile['include_globals'],
                              'credentials': profile['engine'] == 'mongodb', 'application_files_consistent': False,
                              **({'oplog': True, 'users_roles_included': True} if profile['engine'] == 'mongodb' else {}),
                              **({'container_database_path': profile['sqlite_path']} if profile['engine'] == 'sqlite' else {})},
                    'restore': restore_hint(profile['engine'])})
        results.append(manifest)
        try:
            atomic_write_json(directory / 'manifest.json', manifest)
            cid = container_identity(profile)
            manifest['container_id'] = cid
            for database in profile['databases']:
                started = time.monotonic()
                versions = _probe(config, profile, cid, database, cancelled, directory)
                if check_only:
                    manifest.setdefault('checks', []).append({'database': database, **versions})
                    continue
                space = os.statvfs(directory)
                if space.f_bavail * space.f_frsize < profile['min_free_mib'] * 1024 * 1024:
                    raise DatabaseError('no_space')
                actions = ['dump']
                if profile['include_globals'] and database == profile['databases'][0]:
                    actions.append('globals')
                for action in actions:
                    name = ('globals.sql' if action == 'globals' else database + dump_suffix(profile['engine'])) + '.gz'
                    partial = directory / (name + '.partial')
                    with partial.open('xb') as handle:
                        os.fchmod(handle.fileno(), 0o600)
                        with gzip.GzipFile(filename='', mode='wb', fileobj=handle, compresslevel=6, mtime=0) as compressed:
                            _operation(config, profile, cid, action, database, compressed, cancelled)
                            uncompressed_bytes = compressed.tell()
                        handle.flush()
                        os.fsync(handle.fileno())
                    if not uncompressed_bytes:
                        raise DatabaseError('empty_dump')
                    if profile['engine'] in ('postgresql', 'redis', 'sqlite') and action == 'dump':
                        magic = {'postgresql': b'PGDMP', 'redis': b'REDIS', 'sqlite': b'SQLite format 3\x00'}[profile['engine']]
                        with gzip.open(partial, 'rb') as handle:
                            if handle.read(len(magic)) != magic:
                                raise DatabaseError('invalid_dump')
                    final = directory / name
                    partial.rename(final)
                    manifest['files'].append({'name': name, 'database': database, 'kind': action, **versions,
                                              'bytes': final.stat().st_size, 'uncompressed_bytes': uncompressed_bytes, 'compression': 'gzip', 'sha256': _hash(final, cancelled),
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
    return [result_directory(r) / name for r in results for name in [*[f['name'] for f in r['files']], 'manifest.json']]


def borg_artifact_paths(results):
    """Return anchored Borg inputs; slashdot keeps process/FD paths out of archives."""
    return [str(result_directory(r).parent) + '/./' + Path(r['directory']).name + '/' + name
            if isinstance(r, DumpResult) else str(Path(r['directory']) / name)
            for r in results for name in [*[f['name'] for f in r['files']], 'manifest.json']]


def discover_databases(config, profile, cancelled=lambda: False):
    """List selectable names using the configured account; never change saved backup scope.

    Caller holds docker-control. Query output is bounded and temporary, and does
    not require dump storage or an existing database selection.
    """
    parent = data_root(config) / 'database-discovery'
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="discovery-", dir=parent) as temporary:
        path = Path(temporary) / 'names'
        with path.open('xb') as output:
            os.fchmod(output.fileno(), 0o600)
            _operation(config, profile, container_identity(profile), 'discover', '', output, cancelled)
        if path.stat().st_size > 1024 * 1024:
            raise DatabaseError('export_failed')
        names = path.read_text().splitlines()
    excluded = {'mysql', 'information_schema', 'performance_schema', 'sys'} if profile['engine'] in ('mariadb', 'mysql') else {'admin', 'config', 'local'} if profile['engine'] == 'mongodb' else {'template0', 'template1'}
    return sorted(set(name for name in names if name.lower() not in excluded and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}', name)))


def restore_hint(engine):
    """Return artifact-specific recovery requirements stored alongside every dump."""
    instructions = {
        'mariadb': 'Import SQL with a compatible mariadb client; reprovision users/grants.',
        'mysql': 'Import SQL with a compatible mysql client; reprovision users/grants.',
        'postgresql': 'Use pg_restore for custom dumps and psql for optional globals; reprovision role passwords and extensions.',
        'mongodb': 'Use compatible mongorestore --archive=<file> --oplogReplay. Full archive includes users/roles and credential hashes.',
        'redis': 'Restore the RDB with compatible Redis persistence settings; existing AOF must not override it. Reprovision config/ACLs.',
        'sqlite': 'Stop the destination application; preserve old database/sidecars separately and restore the snapshot with correct ownership. Follow app WAL/SHM handling; external blobs/config are separate.',
    }
    return 'Decompress .gz files first. Restore into an isolated destination. ' + instructions[engine]


def dump_suffix(engine):
    """Return the native artifact suffix; reject unrecognized manifest engines."""
    try:
        return {'mariadb': '.sql', 'mysql': '.sql', 'postgresql': '.dump',
                'mongodb': '.archive', 'redis': '.rdb', 'sqlite': '.sqlite'}[engine]
    except KeyError:
        raise DatabaseError('invalid_dump') from None


def managed_scripts():
    """Return fixed bundled helper sources for an administrator's read-only view."""
    return [{'name': 'database-dump-' + engine + suffix, 'engine': engine,
             'content': (SCRIPTS / ('database-dump-' + engine + suffix)).read_text()}
            for engine in ('mariadb', 'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite')
            for suffix in ['.py' if engine == 'sqlite' else '.sh']]


def verify_archive(repo, archive, results, cancelled=lambda: False):
    """Stream required artifacts back from Borg and compare hashes without a second disk copy."""
    entries = [(r, path) for r in results for path in artifact_paths([r])]
    for result, path in entries:
        expected = _hash(path, cancelled)
        archive_path = result['archive_directory'] + '/' + path.name if result.get('archive_directory') else str(path).lstrip('/')
        cmd = ['borg', 'extract', '--stdout', repo + '::' + archive, archive_path]
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


def cleanup_run(directory, profile, *, verified=False, interrupted=False):
    """Remove only owned manifest-listed files through an anchored staging handle.

    A live DumpResult retains its original directory even after a pool rename.
    interrupted permits an orphaned running manifest only after the caller has
    reconciled exporters while holding docker-control. Unknown files block cleanup.
    """
    if isinstance(directory, DumpResult):
        _cleanup_run(directory.path, profile, verified=verified, interrupted=interrupted)
        return
    logical = Path(directory)
    if logical.parent != Path(profile['staging_dir']) or not is_run_directory_name(logical.name):
        raise DatabaseError('storage_path')
    with open_staging(profile, require_space=False) as fd:
        _cleanup_run(_descriptor_path(fd) / logical.name, profile, verified=verified, interrupted=interrupted)


def _cleanup_run(path, profile, *, verified, interrupted):
    """Validate and remove one run below an already held private staging directory."""
    _private_path(path)
    if (path / 'manifest.json').is_symlink():
        raise DatabaseError('cleanup_blocked')
    manifest = json.loads((path / 'manifest.json').read_text())
    if manifest.get('profile_id') != profile['id'] or (manifest.get('status') == 'running' and not interrupted):
        raise DatabaseError('cleanup_blocked')
    if verified and manifest.get('status') != 'archived':
        raise DatabaseError('cleanup_blocked')
    allowed = {'manifest.json', '.probe', '.verify'}
    if manifest.get('engine') == 'sqlite':
        allowed.update('.sqlite-snapshot' + suffix for suffix in ('', '-journal', '-wal', '-shm'))
    databases = manifest.get('scope', {}).get('databases', [])
    if not isinstance(databases, list) or any(not isinstance(db, str) or not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}', db) for db in databases):
        raise DatabaseError('cleanup_blocked')
    for database in databases:
        name = database + dump_suffix(manifest['engine'])
        if manifest.get('compression') == 'gzip':
            name += '.gz'
        allowed.update((name, name + '.partial'))
    if manifest.get('scope', {}).get('globals'):
        name = 'globals.sql.gz' if manifest.get('compression') == 'gzip' else 'globals.sql'
        allowed.update((name, name + '.partial'))
    children = list(path.iterdir())
    if any(p.name not in allowed or p.is_symlink() or not p.is_file() or p.stat().st_uid != os.geteuid() for p in children):
        raise DatabaseError('cleanup_blocked')
    for child in children:
        child.unlink()
    path.rmdir()
