"""Give current database credentials readable names without losing old references."""
import copy
import hashlib
import json
import os
import re
import uuid
from pathlib import Path

from database_profiles import (LEGACY_CREDENTIAL, create_secret, credential_payload,
                               list_profiles, next_credential_id, read_password,
                               secret_path, store_path)
from inventory_store import atomic_write_bytes, atomic_write_json, inventory_lock
from .audit import append_event, config_dir, now, write_pending_state

MIGRATION_ID = 'database_secret_names_v1'
INTRODUCED_IN = '2026.10.24'
RECHECK_AFTER_FINAL = True


def _journal(config):
    """Return the resumable metadata-only migration journal."""
    return config_dir(config) / 'database-secret-names-migration.json'


def _read(path):
    """Read migration metadata; malformed journals stop startup."""
    return json.loads(path.read_text())


def _legacy(row):
    """Identify a current managed profile with a legacy UUID reference."""
    return row['auth_mode'] == 'managed' and bool(re.fullmatch(LEGACY_CREDENTIAL, row['credential_id']))


def detect(config):
    """Request migration for a pending journal or imported/current legacy profiles."""
    journal = _journal(config)
    pending = journal.exists() and _read(journal)['status'] != 'applied'
    return {'required': pending or any(_legacy(row) for row in list_profiles(config)['profiles'])}


def _plan(config):
    """Snapshot profile references and reserve readable targets without copying passwords."""
    source = store_path(config)
    before = source.read_bytes()
    inventory = json.loads(before)
    rows = list_profiles(config)['profiles']
    run_id = str(uuid.uuid4())
    backup = config_dir(config) / 'migration-backups' / f'{MIGRATION_ID}-{run_id}'
    backup.mkdir(parents=True, mode=0o700)
    atomic_write_bytes(backup / 'profiles.before.json', before)
    operations = []
    reserved = {row.get('credential_id') for row in rows}
    for row in rows:
        if not _legacy(row):
            continue
        # Validate every source before preparing any credential changes.
        read_password(config, row)
        reference = next_credential_id(config, row, reserved)
        reserved.add(reference)
        operations.append({'profile': copy.deepcopy(row), 'target_reference': reference})
        for raw in inventory['profiles']:
            if raw['id'] == row['id']:
                raw['credential_id'] = reference
    after = (json.dumps(inventory, ensure_ascii=False, indent=2) + '\n').encode()
    atomic_write_bytes(backup / 'profiles.after.json', after)
    return {'migration_id': MIGRATION_ID, 'status': 'pending', 'run_id': run_id,
            'timestamp': now(), 'backup_directory': str(backup), 'source': str(source),
            'before_sha256': hashlib.sha256(before).hexdigest(),
            'after_sha256': hashlib.sha256(after).hexdigest(), 'operations': operations}


def apply(config):
    """Copy active legacy secrets, then atomically switch profile references.

    Original secrets remain readable for historical exports and running snapshots.
    A durable plan and inventory snapshot allow retries without duplicate versions.
    Conflicts or unavailable credentials fail closed through the central runner.
    """
    with inventory_lock(store_path(config).parent):
        journal = _journal(config)
        plan = _read(journal) if journal.exists() else None
        if not plan or plan['status'] == 'applied':
            if not any(_legacy(row) for row in list_profiles(config)['profiles']):
                return {'status': 'not_required'}
            plan = _plan(config)
            atomic_write_json(journal, plan)
        write_pending_state(config, migration_id=MIGRATION_ID, introduced_in=INTRODUCED_IN,
                            run_id=plan['run_id'], source_classification='database_profiles')
        append_event(config, {'event': 'migration_started', 'migration_id': MIGRATION_ID,
                              'run_id': plan['run_id'], 'backup_directory': plan['backup_directory']})
        backup = Path(plan['backup_directory'])
        before = (backup / 'profiles.before.json').read_bytes()
        after = (backup / 'profiles.after.json').read_bytes()
        if (hashlib.sha256(before).hexdigest() != plan['before_sha256'] or
                hashlib.sha256(after).hexdigest() != plan['after_sha256']):
            raise ValueError('Database profile migration snapshot checksum mismatch')
        source = store_path(config)
        if source.read_bytes() not in (before, after):
            raise ValueError('Database profiles changed since migration snapshot')
        affected = [str(source)]
        for op in plan['operations']:
            old = op['profile']
            new = {**old, 'credential_id': op['target_reference']}
            payload = credential_payload(new, read_password(config, old), plan['timestamp'])
            target = secret_path(config, new['credential_id'])
            if os.path.lexists(target):
                # Check privacy before reading/comparing a previously completed copy.
                read_password(config, new)
                if _read(target) != payload:
                    raise ValueError('Database secret migration target conflict')
            else:
                create_secret(config, new['credential_id'], payload)
            affected.append(str(target))
            append_event(config, {'event': 'migration_file_applied', 'migration_id': MIGRATION_ID,
                                  'source': str(secret_path(config, old['credential_id'])),
                                  'target': str(target), 'action': 'copy_readable_secret_preserve_original'})
        if source.read_bytes() != after:
            atomic_write_bytes(source, after)
        plan.update(status='applied', applied_at=now())
        atomic_write_json(journal, plan)
        details = {'affected_files': affected, 'backup_directory': plan['backup_directory'],
                   'actions': ['Preserved original profiles and legacy secret files',
                               'Created readable credential snapshots', 'Updated current profile references']}
        append_event(config, {'event': 'migration_applied', 'migration_id': MIGRATION_ID, **details})
        return {'status': 'applied', 'details': details}
