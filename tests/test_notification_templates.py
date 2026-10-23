"""Custom backup notification texts from Settings > Notifications."""

from job_fixtures import job_id
from pathlib import Path
import json
import logging
import os
import stat
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for _path in (ROOT / "runtime", ROOT / "api"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from lib.backup_job import BackupJob, BackupJobConfig  # noqa: E402
from lib.notification_events import NotificationEvent, send_event  # noqa: E402
from lib.notification_templates import (  # noqa: E402
    PLACEHOLDERS,
    TEMPLATE_EVENTS,
    read_notification_templates,
    render_template_text,
)
from lib.notifications import (  # noqa: E402
    BACKUP_NOTIFICATION_TITLES,
    MailConfig,
    build_backup_notification_context,
    build_backup_notification_message,
)
from inventory_store import InventoryCorruptError  # noqa: E402
import notification_templates_api  # noqa: E402


def _write_templates(root: Path, rows) -> Path:
    path = root / "config" / "notification-templates.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schema_version": 1, "templates": rows}), encoding="utf-8")
    return path


def _failed_backup_event() -> NotificationEvent:
    details = {
        "job_name": "Flash",
        "status": "Error",
        "timestamp": "2026-07-01 08:05:30",
        "duration_seconds": 65,
        "repository": "/mnt/disks/usb/borg-flash",
        "backup_location": "usb",
        "error_message": "Repository could not be opened",
    }
    return NotificationEvent(
        event_type="backup_failed",
        title=BACKUP_NOTIFICATION_TITLES["backup_failed"],
        message=build_backup_notification_message(**details),
        severity="alert",
        job_name="Flash",
        exit_code=2,
        template_context=build_backup_notification_context(**details, exit_code=2),
    )


def _capture_unraid_and_email(monkeypatch) -> list:
    calls = []
    monkeypatch.setattr(
        "lib.notification_events.notify",
        lambda **kwargs: calls.append(("unraid", kwargs["subject"], kwargs["description"])) or True,
    )
    monkeypatch.setattr(
        "lib.notification_events.send_mail",
        lambda config, subject, body: calls.append(("email", subject, body)) or True,
    )
    monkeypatch.setattr("lib.notification_templates._hostname", lambda: "Tower")
    return calls


def _config(root: Path) -> dict:
    return {
        "BACKUP_SCRIPTS_DIR": str(root),
        "NOTIFY_UNRAID_EVENTS": ",".join(TEMPLATE_EVENTS),
        "NOTIFY_EMAIL_EVENTS": ",".join(TEMPLATE_EVENTS),
        "NOTIFY_APPRISE_ASYNC": "false",
    }


def _usb_job(tmp_path: Path) -> BackupJob:
    return BackupJob(BackupJobConfig(
        job_name="Flash",
        backup_type="flash",
        backup_location="usb",
        job_id=job_id("flash_usb"),
        lock_file=tmp_path / "job.lock",
        log_dir=tmp_path / "logs",
        log_file=tmp_path / "logs" / "backup.log",
        backup_paths=[],
        borg_cache_dir=tmp_path / "cache",
        borg_repo="/mnt/disks/usb/borg-flash",
        date_tag="2026-07-01",
        status_dir=tmp_path / "status",
    ))


def test_render_template_text_replaces_known_placeholders_in_one_pass():
    values = {"job": "Flash {error}", "error": "boom"}

    assert render_template_text("{job}: {error} {unknown} {Job} {}", values) == "Flash {error}: boom {unknown} {Job} {}"


def test_backup_context_formats_facts_like_the_default_message():
    context = build_backup_notification_context(
        job_name="Flash",
        status="Successful",
        timestamp="2026-07-01 08:05:30",
        duration_seconds=3725,
        repository="ssh://u1@u1.your-storagebox.de:23/./backup/borg-backup-flash",
        backup_location="storagebox",
        archive_name="flash-2026-07-01_08-05-11",
        exit_code=0,
    )

    assert context == {
        "job": "Flash",
        "status": "Successful",
        "time": "2026-07-01 08:05",
        "duration": "1 h 2 min 5 sec",
        "target": "Storagebox / borg-backup-flash",
        "location": "Storagebox",
        "repository": "ssh://u1@u1.your-storagebox.de:23/./backup/borg-backup-flash",
        "archive": "flash-2026-07-01_08-05-11",
        "error": "",
        "exit_code": "0",
    }
    assert set(context) | {"hostname", "default_title", "default_message"} == set(PLACEHOLDERS)


def test_send_event_applies_custom_text_to_every_channel(monkeypatch, tmp_path):
    calls = _capture_unraid_and_email(monkeypatch)
    _write_templates(tmp_path, [{
        "event": "backup_failed",
        "title": "{hostname}: {job} failed ({exit_code})",
        "message": "Error on {target}: {error}\n\n{default_message}\n{unknown}",
    }])
    store = tmp_path / "config" / "apprise-profiles.json"
    store.write_text(json.dumps({"schema_version": 1, "profiles": [{
        "id": "alerts-main",
        "name": "Alerts",
        "enabled": True,
        "provider": "ntfy",
        "selected_events": ["backup_failed"],
    }]}), encoding="utf-8")
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets" / ".apprise-profile-alerts-main.url").write_text("json://token@example.test\n", encoding="utf-8")
    monkeypatch.setattr(
        "lib.notification_events.send_notification",
        lambda url, *, title, body, **kwargs: calls.append(("apprise", title, body)) or SimpleNamespace(ok=True, message="sent"),
    )
    event = _failed_backup_event()

    result = send_event(_config(tmp_path), event, mail_config=MailConfig(recipient="admin@example.test"))

    expected_message = f"Error on USB / borg-flash: Repository could not be opened\n\n{event.message}\n{{unknown}}"
    assert result == {"unraid": True, "email": True, "apprise": True}
    assert calls == [
        ("unraid", "Tower: Flash failed (2)", expected_message),
        ("email", "Tower: Flash failed (2)", expected_message),
        ("apprise", "Alerts - Tower: Flash failed (2)", expected_message),
    ]


def test_custom_text_keeps_defaults_for_empty_fields_and_joins_title_lines(monkeypatch, tmp_path):
    calls = _capture_unraid_and_email(monkeypatch)
    _write_templates(tmp_path, [
        {"event": "backup_failed", "title": "{job}: {default_message}", "message": ""},
        {"event": "backup_success", "title": "{archive}", "message": "   "},
    ])
    event = _failed_backup_event()

    send_event(_config(tmp_path), event)

    joined_default = " ".join(event.message.splitlines())
    assert calls == [("unraid", f"Flash: {joined_default}", event.message)]
    assert "\n" not in calls[0][1]

    calls.clear()
    success = NotificationEvent(
        event_type="backup_success",
        title=BACKUP_NOTIFICATION_TITLES["backup_success"],
        message="Job: Flash",
        template_context={"job": "Flash", "archive": ""},
    )
    send_event(_config(tmp_path), success)

    assert calls == [("unraid", BACKUP_NOTIFICATION_TITLES["backup_success"], "Job: Flash")]


def test_events_without_template_or_context_keep_their_text(monkeypatch, tmp_path):
    calls = _capture_unraid_and_email(monkeypatch)
    _write_templates(tmp_path, [{"event": "backup_success", "title": "Custom {job}", "message": "Custom"}])
    failed = _failed_backup_event()
    without_context = NotificationEvent(event_type="backup_success", title="Backup OK", message="done")

    send_event(_config(tmp_path), failed)
    send_event(_config(tmp_path), without_context)

    assert calls == [
        ("unraid", failed.title, failed.message),
        ("unraid", "Backup OK", "done"),
    ]


def test_unreadable_store_and_render_errors_never_block_delivery(monkeypatch, tmp_path, caplog):
    calls = _capture_unraid_and_email(monkeypatch)
    store = _write_templates(tmp_path, [])
    store.write_text("{not json", encoding="utf-8")
    event = _failed_backup_event()

    with caplog.at_level(logging.WARNING):
        send_event(_config(tmp_path), event)
    assert calls == [("unraid", event.title, event.message)]
    assert "Custom notification texts are not readable" in caplog.text

    calls.clear()
    _write_templates(tmp_path, [{"event": "backup_failed", "title": "Custom", "message": "Custom"}])

    def broken(*_args, **_kwargs):
        raise RuntimeError("render failed")

    monkeypatch.setattr("lib.notification_events.render_notification_text", broken)
    with caplog.at_level(logging.WARNING):
        result = send_event(_config(tmp_path), event)
    assert result["unraid"] is True
    assert calls == [("unraid", event.title, event.message)]
    assert "Custom notification text skipped (event=backup_failed): render failed" in caplog.text


def test_runtime_reader_ignores_invalid_rows_and_clips_texts(tmp_path):
    _write_templates(tmp_path, [
        {"event": "backup_failed", "title": "  T  ", "message": "M" * 2500},
        {"event": "restore_test_failed", "title": "Not supported", "message": "x"},
        {"event": "backup_success", "title": 5, "message": None},
        "not a row",
    ])

    templates = read_notification_templates({"BACKUP_SCRIPTS_DIR": str(tmp_path)})

    assert templates == {"backup_failed": {"title": "T", "message": "M" * 2000}}


def test_normalize_trims_texts_and_drops_empty_events():
    rows = notification_templates_api.normalize_notification_templates({
        "backup_overdue": {"title": None, "message": "{job} is overdue"},
        "backup_failed": {"title": "  {job} failed  ", "message": "Line 1\r\nLine 2\rLine 3\n"},
        "backup_success": {"title": "", "message": "   "},
    })

    assert rows == [
        {"event": "backup_failed", "title": "{job} failed", "message": "Line 1\nLine 2\nLine 3"},
        {"event": "backup_overdue", "title": "", "message": "{job} is overdue"},
    ]


@pytest.mark.parametrize("payload,code,params", [
    ({"restore_test_failed": {"title": "x"}}, "notification_template_event", {}),
    ([{"event": "backup_failed"}, {"event": "backup_failed"}], "notification_template_event", {}),
    ({"backup_failed": {"title": "Line 1\nLine 2"}}, "notification_template_title", {"max": 200}),
    ({"backup_failed": {"title": "x" * 201}}, "notification_template_title", {"max": 200}),
    ({"backup_failed": {"message": "x" * 2001}}, "notification_template_message", {"max": 2000}),
    ({"backup_failed": {"title": 5}}, "notification_template_payload", {}),
    ({"backup_failed": "text"}, "notification_template_payload", {}),
    ("text", "notification_template_payload", {}),
])
def test_normalize_rejects_invalid_texts_with_localized_codes(payload, code, params):
    with pytest.raises(notification_templates_api.NotificationTemplateError) as excinfo:
        notification_templates_api.normalize_notification_templates(payload)

    assert isinstance(excinfo.value, ValueError)
    assert excinfo.value.api_code == code
    assert excinfo.value.api_message_params == params


def test_save_writes_only_changes_and_settings_read_back_all_events(tmp_path):
    config = {"BACKUP_SCRIPTS_DIR": str(tmp_path)}
    path = tmp_path / "config" / "notification-templates.json"
    rows = notification_templates_api.normalize_notification_templates({
        "backup_failed": {"title": "{job} failed", "message": "{error}"},
    })

    assert notification_templates_api.save_notification_templates(config, []) is False
    assert not path.exists()
    assert notification_templates_api.save_notification_templates(config, rows) is True
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["schema_version"] == 1
    assert stored["templates"] == rows
    if os.name == "posix":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    written = path.stat().st_mtime_ns
    assert notification_templates_api.save_notification_templates(config, rows) is False
    assert path.stat().st_mtime_ns == written

    settings = notification_templates_api.get_notification_template_settings(config)
    assert settings["readable"] is True
    assert settings["events"] == list(TEMPLATE_EVENTS)
    assert settings["placeholders"] == list(PLACEHOLDERS)
    assert settings["limits"] == {"title": 200, "message": 2000}
    assert settings["templates"]["backup_failed"] == {"title": "{job} failed", "message": "{error}"}
    assert settings["templates"]["backup_success"] == {"title": "", "message": ""}
    assert read_notification_templates(config) == {"backup_failed": {"title": "{job} failed", "message": "{error}"}}

    assert notification_templates_api.save_notification_templates(config, []) is True
    assert json.loads(path.read_text(encoding="utf-8"))["templates"] == []


def test_unreadable_store_is_reported_and_never_overwritten(tmp_path):
    config = {"BACKUP_SCRIPTS_DIR": str(tmp_path)}
    path = _write_templates(tmp_path, [])
    path.write_text("{not json", encoding="utf-8")

    settings = notification_templates_api.get_notification_template_settings(config)

    assert settings["readable"] is False
    assert all(row == {"title": "", "message": ""} for row in settings["templates"].values())
    with pytest.raises(InventoryCorruptError):
        notification_templates_api.save_notification_templates(config, [{"event": "backup_failed", "title": "x", "message": ""}])
    assert path.read_text(encoding="utf-8") == "{not json"


def test_examples_provide_default_text_and_every_placeholder():
    examples = notification_templates_api.notification_template_examples()

    assert list(examples) == list(TEMPLATE_EVENTS)
    for event, example in examples.items():
        assert example["title"] == BACKUP_NOTIFICATION_TITLES[event]
        assert example["message"].startswith("Job: Appdata\n")
        assert set(example["values"]) == set(PLACEHOLDERS)
        assert example["values"]["default_title"] == example["title"]
        assert example["values"]["default_message"] == example["message"]
    assert examples["backup_success"]["values"]["archive"] == "appdata-2026-07-01_03-00-05"
    assert examples["backup_failed"]["values"]["error"] == "Repository could not be opened"
    assert examples["backup_overdue"]["values"]["location"] == "USB"
    assert examples["backup_overdue"]["values"]["exit_code"] == ""
    assert "Target: borg-appdata" in examples["backup_overdue"]["message"]


@pytest.mark.parametrize("exit_code,event,status", [
    (0, "backup_success", "Successful"),
    (1, "backup_warning", "Warning"),
    (2, "backup_failed", "Error"),
])
def test_backup_job_events_carry_template_context(monkeypatch, tmp_path, exit_code, event, status):
    captured = []
    monkeypatch.setattr("lib.notification_events.send_event", lambda config, item, *, mail_config=None: captured.append(item))
    job = _usb_job(tmp_path)
    job._completion_repo_info = (0, ("unknown", "unknown", "unknown"))
    monkeypatch.setattr(job, "_emit_lifecycle_finished", lambda **kwargs: None)
    monkeypatch.setattr(job, "_refresh_unraid_dashboard_widget_cache", lambda *args: None)
    job.set_result(exit_code)

    job._do_finish()

    assert [item.event_type for item in captured] == [event]
    sent = captured[0]
    assert sent.title == BACKUP_NOTIFICATION_TITLES[event]
    assert sent.template_context["job"] == "Flash"
    assert sent.template_context["status"] == status
    assert sent.template_context["target"] == "USB / borg-flash"
    assert sent.template_context["exit_code"] == str(exit_code)
    assert f"Result: {status}" in sent.message


def test_skipped_backup_event_carries_reason(monkeypatch, tmp_path):
    captured = []
    monkeypatch.setattr("lib.notification_events.send_event", lambda config, item, *, mail_config=None: captured.append(item))
    job = _usb_job(tmp_path)
    monkeypatch.setattr(job, "_save_skip_status", lambda: None)
    job._skip_reason = "USB is not mounted"

    job._persist_skip_status_once()

    assert [item.event_type for item in captured] == ["backup_skipped"]
    assert captured[0].template_context["error"] == "USB is not mounted"
    assert captured[0].template_context["archive"] == ""
    assert captured[0].template_context["exit_code"] == "0"


def test_placeholders_and_errors_are_translated_in_both_languages():
    for language in ("de", "en"):
        labels = json.loads((ROOT / "ui" / "i18n" / f"{language}.json").read_text(encoding="utf-8"))
        texts = labels["settings"]["notificationTemplates"]
        assert set(texts["placeholders"]) == set(PLACEHOLDERS), language
        for code in ("event", "title", "message", "payload"):
            assert labels["api"]["errors"][f"notification_template_{code}"], (language, code)
