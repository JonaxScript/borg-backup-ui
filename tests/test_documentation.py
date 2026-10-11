"""Documentation contracts: links, shipped dependencies and executed rendering."""
import importlib.util
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'plugin' / f'{name}.py')
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def test_source_links_and_assets():
    audit = module('documentation_audit')
    assert not audit.check_links(audit.source_files(), boundary=ROOT)


def test_actual_offline_copy_has_resolvable_companions_and_assets(tmp_path):
    app = tmp_path / 'application'
    shutil.copytree(ROOT / 'ui/docs', app / 'ui/docs')
    module('package_documentation').package_documentation(ROOT, app)
    assert not module('documentation_audit').check_links(list((app / 'ui/docs').rglob('*.md')), boundary=app / 'ui/docs')
    for relative in ['manual/apprise-providers.md', 'examples/job-hooks/pre-success.sh',
                     'integrations/prometheus.md', 'integrations/homepage-widget.md',
                     'auth-user-store-recovery.md']:
        assert (app / 'ui/docs' / relative).is_file()
    assert not (app / 'ui/docs/maintainer').exists()


def test_executed_help_renderer():
    subprocess.run(['node', 'tests/help_markdown.cjs'], cwd=ROOT, check=True)


def test_bilingual_safety_contracts_match_executable_formats_and_methods():
    """Require each language's explicit limitations alongside implementation tokens."""
    transfer = (ROOT / 'api/settings_transfer_api.py').read_text()
    runner = (ROOT / 'runtime/scripts/borg_restore_test.py').read_text()
    assert '["list", "--short", "--last", "1", path]' in runner
    assert '"extract", "--dry-run"' in runner and '"extract", "--stdout"' in runner
    formats = ('bbui-job-bundle-v3', 'bbui-job-bundle-v4', 'bbui-job-bundle-secure-v3',
               'bbui-profile-secrets-v2', 'bbui-secrets-backup-v1', 'bbui-repository-keys-v1')
    required = {
        'de': ('kein unabhängiger Soll-Hash-Vergleich', 'die Archivauswahl ist repositoryweit',
               'Exit-Code 124', 'keine zentralen Skriptdefinitionen', 'Job-ID', 'cmp /mnt/user/demo'),
        'en': ('No independent expected-hash comparison', 'archive selection is repository-wide',
               'exit 124', 'central script definitions', 'Job ID', 'cmp /mnt/user/demo'),
    }
    for language in ('de', 'en'):
        text = (ROOT / f'docs/user-manual/{language}/user-manual.md').read_text()
        for term in required[language]:
            assert term.lower() in text.lower(), (language, term)
        for fmt in formats:
            assert fmt in text and fmt in transfer
        envelope_version = re.search(r'_AUTHENTICATED_EXPORT_VERSION = (\d+)', transfer)[1]
        assert f'`{envelope_version}`' in text.split('`bbui-authenticated-export`', 1)[1][:30]
        assert 'job-scripts.json' in text
        short = (ROOT / ('ui/docs/help.md' if language == 'de' else 'ui/docs/help.en.md')).read_text()
        for term in ('--dry-run', '--stdout', 'SHA-256', 'L1', 'L2', 'L3', 'Timeout' if language == 'de' else 'timeout'):
            assert term in short
        assert f'../../docs/user-manual/{language}/user-manual.md#16-' in short
        assert re.search(r'^10\. \*\*Flow', short, re.M)


def test_old_menu_anchors_are_retained():
    audit = module('documentation_audit')
    for language, basics, settings, tasks in [('de', 'grundlagen', 'einstellungen', 'typische-aufgaben'), ('en', 'basics', 'settings', 'typical-tasks')]:
        ids = audit.headings((ROOT / f'docs/user-manual/{language}/user-manual.md').read_text())
        assert {f'1-{basics}', '3-jobs', '7-browse--restore', '8-restore-tests', f'9-{settings}', f'11-{tasks}', 'homepage-widget'} <= ids


def test_packaged_documentation_is_covered_by_candidate_source_digest():
    workflow = module('release_workflow')
    assert workflow.is_deployable_path('plugin/package_documentation.py')
    for tree in ('docs/user-manual', 'docs/integrations', 'docs/examples/job-hooks'):
        for path in (ROOT / tree).rglob('*'):
            if path.is_file():
                assert workflow.is_deployable_path(path.relative_to(ROOT).as_posix()), path
    assert workflow.is_deployable_path('docs/auth-user-store-recovery.md')
