import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_notification_templates_browser_logic():
    subprocess.run(["node", "tests/notification_templates_ui.cjs"], cwd=ROOT, check=True)


def test_notification_templates_are_saved_with_the_notifications_tab():
    script = (ROOT / "ui" / "js" / "pages" / "settings.js").read_text(encoding="utf-8")
    css = (ROOT / "ui" / "settings-redesign.css").read_text(encoding="utf-8")

    assert "renderSettingsNotificationTemplates(data.notification_templates || {})" in script
    assert "activeTab === 'notifications' ? collectNotificationTemplates(activePanel) : null" in script
    assert "...(notificationTemplates ? { notification_templates: notificationTemplates } : {})" in script
    assert "if (action === 'notification-template-reset') return resetNotificationTemplate(el);" in script
    assert "window.onNotificationTemplateInput = onNotificationTemplateInput;" in script
    for selector in (".notification-template-fields", ".notification-template-preview", ".notification-template-placeholders"):
        assert selector in css


def test_localized_editor_templates_match_saved_delivery(tmp_path, monkeypatch):
    """Both languages and all events preview the same texts the runtime sends."""
    import json
    monkeypatch.syspath_prepend(str(ROOT / "api"))
    monkeypatch.syspath_prepend(str(ROOT / "runtime" / "lib"))
    from notification_templates_api import (
        get_notification_template_settings,
        normalize_notification_templates,
        save_notification_templates,
    )
    from notification_templates import render_notification_text

    config = {"BACKUP_SCRIPTS_DIR": str(tmp_path)}
    settings = get_notification_template_settings(config)
    script = r'''
const fs = require('node:fs'), vm = require('node:vm');
const config = JSON.parse(fs.readFileSync(0, 'utf8')), output = [];
for (const language of ['de', 'en']) {
  const labels = JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`, 'utf8'));
  const context = vm.createContext({locationIcon: () => '', window: {BBUI: {api: {_fetch401Wrapped: true}, components: {
    i18n: {t: key => key.split('.').reduce((value, part) => value?.[part], labels)}
  }}, addEventListener() {}}, document: {addEventListener() {}, getElementById() { return null; }}});
  for (const file of ['ui/js/api/client.js', 'ui/js/pages/settings.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  const templates = {}, previews = {}, rows = [];
  for (const event of config.events) {
    const texts = context._notificationTemplateEditorValues(event, config, true);
    previews[event] = context._notificationTemplatePreview(config.examples[event], texts.title, texts.message);
    rows.push({dataset: {notificationTemplateEvent: event}, querySelector: selector => ({
      value: texts[selector.includes('"title"') ? 'title' : 'message']
    })});
  }
  Object.assign(templates, context.collectNotificationTemplates({querySelector: () => ({querySelectorAll: () => rows})}));
  output.push({language, templates, previews});
}
process.stdout.write(JSON.stringify(output));
'''
    result = subprocess.run(
        ["node", "-e", script], cwd=ROOT, input=json.dumps(settings),
        text=True, capture_output=True, check=False,
    )
    assert result.returncode == 0, result.stderr
    for result in json.loads(result.stdout):
        save_notification_templates(config, normalize_notification_templates(result["templates"]))
        for event, preview in result["previews"].items():
            example = settings["examples"][event]
            actual = render_notification_text(
                config, event, example["title"], example["message"], example["values"],
            )
            assert actual == (preview["title"], preview["message"])
            assert actual[0].endswith(": Appdata")
            assert example["values"]["status"] in actual[1]
            assert example["values"]["error"] in actual[1]
        reloaded = get_notification_template_settings(config)
        assert reloaded["templates"] == result["templates"]
