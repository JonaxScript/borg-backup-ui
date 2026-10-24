"""Shipped source transparency without arbitrary-file access or execution (#591)."""
import sys
from pathlib import Path

import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'api'))
import script_catalog as catalog
from job_scripts import save_script, list_scripts


def test_catalog_contains_only_database_helpers_and_practical_templates():
    entries = catalog.list_catalog()['entries']
    paths = {row['path'] for row in entries if row['kind'] == 'managed'}
    assert paths == {'runtime/scripts/database-dump-mariadb.sh','runtime/scripts/database-dump-postgresql.sh'}
    assert len([row for row in entries if row['kind']=='template']) == 6
    assert all('content' not in row for row in entries)
    for row in entries:
        result = catalog.read_catalog_source(row['id'])['script']
        assert result['content'] and result['kind'] == row['kind']


@pytest.mark.parametrize('identifier', ['../../etc/passwd', '/etc/passwd', 'managed:../secrets/password', 'managed:runtime/scripts/../../../../etc/passwd', 'template:../README.md', 'managed:api/wizard_runner.py', 'managed:runtime/scripts/borg_restore_test.py', 'managed:runtime/scripts/unraid-notification-agent-env.sh', ''])
def test_source_rejects_non_catalog_ids(identifier):
    with pytest.raises(FileNotFoundError, match='Script source is unavailable'):
        catalog.read_catalog_source(identifier)


def test_catalog_excludes_symlinks_and_user_secrets(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, 'APP_ROOT', tmp_path)
    scripts = tmp_path/'runtime/scripts'; scripts.mkdir(parents=True)
    private = tmp_path/'secrets/password.py'; private.parent.mkdir(); private.write_text('secret')
    (scripts/'database-dump-postgresql.sh').symlink_to(private)
    (scripts/'directory').symlink_to(private.parent, target_is_directory=True)
    (scripts/'database-dump-mariadb.sh').write_text('#!/bin/sh\nexit 0\n')
    ids = {row['id'] for row in catalog.list_catalog()['entries']}
    assert 'managed:runtime/scripts/database-dump-mariadb.sh' in ids
    assert ids == {'managed:runtime/scripts/database-dump-mariadb.sh'}
    with pytest.raises(FileNotFoundError):
        catalog.read_catalog_source('managed:runtime/scripts/database-dump-postgresql.sh')


def test_template_copy_is_separate_and_does_not_execute_or_modify_source(tmp_path):
    template = catalog.read_catalog_source('template:practical/pre-check-source.sh')['script']
    cfg = {'BACKUP_SCRIPTS_DIR':str(tmp_path/'data')}
    first = save_script(cfg, {'name':'My check','description':'','timeout_seconds':30,'content':template['content']})['script']
    assert first['id'].startswith('script-')
    save_script(cfg, {**first,'content':'#!/bin/bash\n# my edited copy\nexit 0\n'})
    assert catalog.read_catalog_source(template['id'])['script']['content'] == template['content']
    assert list_scripts(cfg)['scripts'][0]['content'] != template['content']
    managed = catalog.read_catalog_source('managed:runtime/scripts/database-dump-mariadb.sh')['script']
    with pytest.raises(ValueError, match='no longer exists'):
        save_script(cfg, {'id':managed['id'],'name':'Cannot edit installed helper','description':'','timeout_seconds':30,'content':'exit 0'})
    assert catalog.read_catalog_source(managed['id'])['script']['content'] == managed['content']


def test_installed_documentation_layout_is_used(tmp_path, monkeypatch):
    monkeypatch.setattr(catalog, 'APP_ROOT', tmp_path)
    folder=tmp_path/'ui/docs/examples/job-hooks/practical'; folder.mkdir(parents=True)
    (folder/'sample.sh').write_text('#!/bin/bash\nexit 0')
    assert catalog.read_catalog_source('template:practical/sample.sh')['script']['content'].endswith('exit 0')


def test_catalog_routes_are_admin_only():
    import borg_backup_ui
    handler=borg_backup_ui.BackupUIHandler.__new__(borg_backup_ui.BackupUIHandler)
    for path in ['/api/settings/scripts/catalog','/api/settings/scripts/source']:
        assert handler._required_role_for_request(path,'GET') == 'admin'
