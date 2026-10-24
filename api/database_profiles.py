"""Validated, credential-free database backup profiles (#591)."""
from __future__ import annotations

import copy
import json
import os
import re
import uuid
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from inventory_store import inventory_lock, read_inventory, atomic_write_inventory


class DatabaseError(ValueError):
    """Expose a safe, localized database operation error without client output."""

    def __init__(self, reason: str):
        self.reason = reason
        self.api_code = 'database_' + reason
        super().__init__('Database backup: ' + reason)


def data_root(config):
    """Return the configured persistent plugin data root."""
    from jobs_api import resolve_data_root
    return resolve_data_root(config)


def store_path(config):
    """Return the canonical profile inventory path."""
    return data_root(config) / 'config' / 'database-profiles.json'


LEGACY_CREDENTIAL = r'[a-f0-9]{32}'
NAMED_CREDENTIAL = r'database-[a-z0-9][a-z0-9-]{0,59}-v[0-9]{3,9}'


def profile_slug(name):
    """Return a bounded descriptive ASCII slug; profile IDs remain authoritative."""
    ascii_name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', ascii_name.lower()).strip('-')[:60].rstrip('-') or 'profile'


def secret_path(config, credential_id):
    """Resolve a readable versioned reference or a retained legacy UUID secret."""
    if not isinstance(credential_id, str):
        raise DatabaseError('credentials')
    if re.fullmatch(LEGACY_CREDENTIAL, credential_id):
        name = '.database-' + credential_id
    elif re.fullmatch(NAMED_CREDENTIAL, credential_id):
        name = credential_id
    else:
        raise DatabaseError('credentials')
    return data_root(config) / 'secrets' / (name + '.json')


def next_credential_id(config, profile, reserved=()):
    """Choose an unused readable version under the caller's inventory lock.

    Existing names, including dangling symlinks and other profiles with the same
    slug, are never reused. Reserved references cover a multi-profile migration.
    """
    stem = 'database-' + profile_slug(profile['name']) + '-v'
    for version in range(1, 1000000000):
        candidate = f'{stem}{version:03d}'
        if candidate not in reserved and not os.path.lexists(secret_path(config, candidate)):
            return candidate
    raise DatabaseError('credentials')


def credential_payload(profile, password, created_at=None):
    """Describe a secret's profile/connection snapshot without changing its password."""
    return {'schema_version': 1, 'profile_id': profile['id'], 'profile_name': profile['name'],
            'engine': profile['engine'], 'container': profile['container'],
            'database_user': profile['database_user'], 'credential_id': profile['credential_id'],
            'created_at': created_at or datetime.now(timezone.utc).isoformat(), 'password': password}


def create_secret(config, reference, payload):
    """Write a new private secret exclusively; never replace a file or symlink.

    Callers publish its reference only after this function succeeds. An interrupted
    write can leave an unreferenced file, whose version is never reused. This works
    on flash filesystems that do not support hard links.
    """
    target = secret_path(config, reference)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def read_password(config, profile):
    """Read a protected password for internal use only; never include it in public results."""
    try:
        path = secret_path(config, profile.get('credential_id'))
        info = path.stat()
        if path.is_symlink() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise DatabaseError('credentials')
        payload = json.loads(path.read_text())
        if re.fullmatch(NAMED_CREDENTIAL, profile.get('credential_id', '')) and (
                payload.get('profile_id') != profile.get('id') or
                payload.get('credential_id') != profile.get('credential_id')):
            raise DatabaseError('credentials')
        value = payload['password']
        if not isinstance(value, str) or len(value) > 4096 or any(c in value for c in '\x00\r\n'):
            raise DatabaseError('credentials')
        return value
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise DatabaseError('credentials') from None


def _text(value, pattern=None, maximum=256):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise DatabaseError('invalid_profile')
    if pattern and not re.fullmatch(pattern, value):
        raise DatabaseError('invalid_profile')
    return value


def validate_profile(raw):
    """Return a normalized profile; reject unsafe names, paths and unsupported scope."""
    if not isinstance(raw, dict):
        raise DatabaseError('invalid_profile')
    engine = raw.get('engine')
    if engine not in ('mariadb', 'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite'):
        raise DatabaseError('invalid_profile')
    row = {'engine': engine}
    row['auth_mode'] = raw.get('auth_mode', 'container' if raw.get('credential_file') else 'managed')
    if row['auth_mode'] not in ('managed', 'container', 'none'):
        raise DatabaseError('invalid_profile')
    if engine == 'sqlite':
        row['auth_mode'] = 'none'
    if row['auth_mode'] == 'none' and engine not in ('sqlite', 'redis', 'mongodb'):
        raise DatabaseError('invalid_profile')
    if row['auth_mode'] == 'container' and engine in ('redis', 'mongodb'):
        raise DatabaseError('invalid_profile')
    if row['auth_mode'] == 'managed':
        row['credential_id'] = raw.get('credential_id', '')
        if row['credential_id']:
            _text(row['credential_id'], f'(?:{LEGACY_CREDENTIAL}|{NAMED_CREDENTIAL})')
    for key, default in [('enabled', True), ('include_globals', False)]:
        row[key] = raw.get(key, default)
        if not isinstance(row[key], bool):
            raise DatabaseError('invalid_profile')
    row['id'] = _text(raw.get('id'), r'db-[a-f0-9]{12}')
    row['name'] = _text(raw.get('name'), maximum=100)
    row['container'] = _text(raw.get('container'), r'[A-Za-z0-9][A-Za-z0-9_.-]*', 128)
    row['execution_user'] = raw.get('execution_user', '')
    if not isinstance(row['execution_user'], str):
        raise DatabaseError('invalid_profile')
    if row['execution_user']:
        _text(row['execution_user'], r'[A-Za-z0-9_][A-Za-z0-9_.:-]*', 128)
    row['database_user'] = raw.get('database_user', '')
    if not isinstance(row['database_user'], str):
        raise DatabaseError('invalid_profile')
    if row['auth_mode'] == 'managed' or engine == 'postgresql' or row['database_user']:
        _text(row['database_user'], r'[A-Za-z0-9_][A-Za-z0-9_.-]*', 63)
    if engine != 'postgresql' and row['include_globals']:
        raise DatabaseError('invalid_profile')
    for key in (['credential_file'] if row['auth_mode'] == 'container' else []) + ['staging_mount', 'staging_dir']:
        value = _text(raw.get(key))
        path = Path(value)
        if not path.is_absolute() or '..' in path.parts or str(path) != value:
            raise DatabaseError('invalid_profile')
        row[key] = value
    mount, staging = Path(row['staging_mount']), Path(row['staging_dir'])
    if mount == Path('/') or mount not in staging.parents or any(
        mount == Path(p) or Path(p) in mount.parents for p in ('/boot', '/proc', '/sys', '/dev', '/run', '/tmp')):
        raise DatabaseError('invalid_storage')
    databases = raw.get('databases')
    if not isinstance(databases, list) or len(databases) > 64:
        raise DatabaseError('invalid_profile')
    system = {'information_schema', 'performance_schema', 'mysql', 'sys'} if engine in ('mariadb', 'mysql') else {'admin', 'config', 'local'} if engine == 'mongodb' else {'template0', 'template1'}
    row['databases'] = list(dict.fromkeys(_text(x, r'[A-Za-z0-9_][A-Za-z0-9_.-]*', 63) for x in databases))
    if any(x.lower() in system for x in row['databases']):
        raise DatabaseError('system_database')
    for key, default, minimum, maximum in [('port', {'mariadb':3306, 'mysql':3306, 'postgresql':5432, 'mongodb':27017, 'redis':6379, 'sqlite':1}[engine], 1, 65535),
                                         ('timeout_seconds', 1800, 1, 86400), ('min_free_mib', 1024, 1, 104857600)]:
        value = raw.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise DatabaseError('invalid_profile')
        row[key] = value
    if engine in ('redis', 'mongodb') and any(x != 'all' for x in row['databases']):
        raise DatabaseError('invalid_profile')
    if engine == 'sqlite':
        value = _text(raw.get('sqlite_path'), maximum=4096)
        path = Path(value)
        if not path.is_absolute() or '..' in path.parts or str(path) != value:
            raise DatabaseError('invalid_profile')
        row['sqlite_path'] = value
        if any(x != 'database' for x in row['databases']):
            raise DatabaseError('invalid_profile')
    if engine == 'mongodb':
        row['authentication_database'] = _text(raw.get('authentication_database', 'admin'), r'[A-Za-z0-9_][A-Za-z0-9_.-]*', 63)
    row['retention'] = raw.get('retention', 'keep')
    if row['retention'] not in ('keep', 'after_archive'):
        raise DatabaseError('invalid_profile')
    return row


def list_profiles(config):
    """Read validated profiles; corrupt inventories fail closed."""
    inventory = read_inventory(store_path(config), collection_key='profiles', schema_version=1)
    if inventory.get('schema_version') != 1:
        raise DatabaseError('invalid_profile')
    rows = [validate_profile(row) for row in inventory['profiles']]
    if len({r['id'] for r in rows}) != len(rows):
        raise DatabaseError('invalid_profile')
    return {'profiles': rows, 'schema_version': 1}


def snapshot_profiles(config, identifiers, *, allow_disabled=False, require_databases=True):
    """Resolve required IDs into an independent snapshot, rejecting disabled/missing rows."""
    if identifiers is None:
        return []
    if not isinstance(identifiers, list) or len(identifiers) > 32 or any(not isinstance(x, str) for x in identifiers):
        raise DatabaseError('invalid_profile')
    if not identifiers:
        return []
    with inventory_lock(store_path(config).parent):
        rows = {r['id']: r for r in list_profiles(config)['profiles']}
        if any(x not in rows or (not allow_disabled and not rows[x]['enabled']) for x in identifiers):
            raise DatabaseError('profile_unavailable')
        if require_databases and any(not rows[x]['databases'] for x in identifiers):
            raise DatabaseError('selection_required')
        return copy.deepcopy([rows[x] for x in dict.fromkeys(identifiers)])


def save_profile(config, raw):
    """Save a profile and optionally a new immutable secret; blank/omitted updates retain credentials.

    Passwords never enter the inventory. Profile/connection changes create a new
    descriptive secret snapshot. Old secret versions remain available to
    running snapshots and the explicit encrypted Secrets backup.
    """
    if not isinstance(raw, dict):
        raise DatabaseError('invalid_profile')
    creating = not raw.get('id')
    with inventory_lock(store_path(config).parent):
        rows = list_profiles(config)['profiles']
        old = next((p for p in rows if p['id'] == raw.get('id')), {})
        merged = {**raw, 'id': raw.get('id') or 'db-' + uuid.uuid4().hex[:12], 'credential_id': old.get('credential_id', '')}
        row = validate_profile(merged)
        if not creating and not any(r['id'] == row['id'] for r in rows):
            raise DatabaseError('profile_unavailable')
        if row['auth_mode'] == 'managed':
            password = raw.get('password')
            if password is not None and (not isinstance(password, str) or len(password) > 4096 or any(c in password for c in '\x00\r\n')):
                raise DatabaseError('credentials')
            if not row['credential_id'] and password is None:
                raise DatabaseError('credentials')
            identity_changed = any(old.get(key) != row.get(key) for key in ('name', 'engine', 'container', 'database_user'))
            if password or not row['credential_id'] or identity_changed:
                if not password and row['credential_id']:
                    password = read_password(config, old)
                row['credential_id'] = next_credential_id(config, row, {p.get('credential_id') for p in rows})
                create_secret(config, row['credential_id'], credential_payload(row, password))
        rows = [r for r in rows if r['id'] != row['id']] + [row]
        atomic_write_inventory(store_path(config), {'schema_version': 1, 'profiles': rows})
    return {'profile': row}


def delete_profile(config, identifier):
    """Delete only an unreferenced profile; disabled jobs also retain their references."""
    with inventory_lock(store_path(config).parent):
        rows = list_profiles(config)['profiles']
        for path in (store_path(config).parent / 'jobs').glob('*.json'):
            job = json.loads(path.read_text())
            if identifier in job.get('database_profile_ids', []):
                raise DatabaseError('profile_in_use')
        if not any(r['id'] == identifier for r in rows):
            raise DatabaseError('profile_unavailable')
        atomic_write_inventory(store_path(config), {'schema_version': 1, 'profiles': [r for r in rows if r['id'] != identifier]})
    return {'deleted': True}
