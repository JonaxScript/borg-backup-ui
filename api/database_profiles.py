"""Validated, credential-free database backup profiles (#591)."""
from __future__ import annotations

import copy
import json
import os
import re
import uuid
from pathlib import Path
from inventory_store import inventory_lock, read_inventory, atomic_write_inventory, atomic_write_bytes


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


def secret_path(config, credential_id):
    """Resolve an immutable managed credential reference inside the plugin Secrets directory."""
    if not isinstance(credential_id, str) or not re.fullmatch(r'[a-f0-9]{32}', credential_id):
        raise DatabaseError('credentials')
    return data_root(config) / 'secrets' / ('.database-' + credential_id + '.json')


def read_password(config, profile):
    """Read a protected password for internal use only; never include it in public results."""
    try:
        path = secret_path(config, profile.get('credential_id'))
        info = path.stat()
        if path.is_symlink() or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise DatabaseError('credentials')
        value = json.loads(path.read_text())['password']
        if not isinstance(value, str) or len(value) > 4096 or any(c in value for c in '\x00\r\n'):
            raise DatabaseError('credentials')
        return value
    except (OSError, ValueError, KeyError, TypeError):
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
    if engine not in ('mariadb', 'postgresql'):
        raise DatabaseError('invalid_profile')
    row = {'engine': engine}
    row['auth_mode'] = raw.get('auth_mode', 'container' if raw.get('credential_file') else 'managed')
    if row['auth_mode'] not in ('managed', 'container'):
        raise DatabaseError('invalid_profile')
    if row['auth_mode'] == 'managed':
        row['credential_id'] = raw.get('credential_id', '')
        if row['credential_id']:
            _text(row['credential_id'], r'[a-f0-9]{32}')
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
    if engine == 'mariadb' and row['include_globals']:
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
    system = {'information_schema', 'performance_schema', 'mysql', 'sys'} if engine == 'mariadb' else {'template0', 'template1'}
    row['databases'] = list(dict.fromkeys(_text(x, r'[A-Za-z0-9_][A-Za-z0-9_.-]*', 63) for x in databases))
    if any(x.lower() in system for x in row['databases']):
        raise DatabaseError('system_database')
    for key, default, minimum, maximum in [('port', 3306 if engine == 'mariadb' else 5432, 1, 65535),
                                         ('timeout_seconds', 1800, 1, 86400), ('min_free_mib', 1024, 1, 104857600)]:
        value = raw.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise DatabaseError('invalid_profile')
        row[key] = value
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

    Secrets never enter the inventory. Old secret versions remain available to
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
            if password or not row['credential_id']:
                row['credential_id'] = uuid.uuid4().hex
                atomic_write_bytes(secret_path(config, row['credential_id']), json.dumps({'password': password}).encode(), mode=0o600)
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
