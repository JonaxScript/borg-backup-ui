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
