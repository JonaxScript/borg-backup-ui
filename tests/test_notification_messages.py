from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = ROOT / "runtime"
RUNTIME_LIB = ROOT / "runtime" / "lib"
for path in (ROOT, RUNTIME_ROOT, RUNTIME_LIB):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from lib import notifications  # noqa: E402


def test_build_backup_notification_message_is_english():
    msg = notifications.build_backup_notification_message(
        job_name="appdata_daily",
        status="Error",
        timestamp="2026-06-28 10:00:00",
        duration_seconds=65,
        repository="usb_backup_01",
        backup_location="usb",
        error_message="Repository could not be opened",
    )

    assert "Job: appdata_daily" in msg
    assert "Result: Error" in msg
    assert "Duration: 00:01:05" in msg
    assert "Target: USB / usb_backup_01" in msg
    assert "Repository: usb_backup_01" in msg
    assert "Error: Repository could not be opened" in msg
    assert "Action: Review the backup log and storage connection." in msg


def test_build_backup_notification_success_message_is_compact():
    msg = notifications.build_backup_notification_message(
        job_name="Flash",
        status="Successful",
        timestamp="2026-07-01 08:05:30",
        duration_seconds=19,
        repository="ssh://u525674@u525674.your-storagebox.de:23/./backup/borg-backup-flash",
        backup_location="storagebox",
        archive_name="flash-backup-2026-07-01_08-05-11",
    )

    assert msg.splitlines() == [
        "Job: Flash",
        "Result: Successful",
        "Duration: 19 sec",
        "Finished: 2026-07-01 08:05",
        "Target: Storagebox / borg-backup-flash",
        "Archive: flash-backup-2026-07-01_08-05-11",
    ]
    assert "Repository:" not in msg


def test_build_restore_test_notification_message_is_english():
    msg = notifications.build_restore_test_notification_message(
        job_name="appdata_local",
        status="Failed",
        timestamp="2026-06-28 11:00:00",
        duration_seconds=125,
        repository="/mnt/backup/borg-backup-appdata",
        level=3,
        coverage="partial",
        error_message="Archive could not be read",
    )

    assert "Job: appdata_local" in msg
    assert "Status: Failed" in msg
    assert "Duration: 00:02:05" in msg
    assert "Repository: /mnt/backup/borg-backup-appdata" in msg
    assert "Level: L3" in msg
    assert "Coverage: partial" in msg
    assert "Error: Archive could not be read" in msg


def test_unraid_notify_preserves_multiline_fields_at_process_boundary(tmp_path, monkeypatch):
    """The Unraid command survives argv and line-based archive serialization."""
    import json

    capture = tmp_path / "argv.json"
    binary = tmp_path / "notify"
    binary.write_text(
        f"#!{sys.executable}\nimport json, pathlib, sys\n"
        f"pathlib.Path({str(capture)!r}).write_text(json.dumps(sys.argv[1:]))\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    monkeypatch.setattr(notifications, "_NOTIFY_BIN", str(binary))
    text = (
        'Job: Flash\nZiel: Local / borg-backup-flash\n'
        'Speicherpfad: /mnt/backup/with "quotes" and spaces\n'
        '\nErgebnis: Successful\nDauer: 23 sec\n'
        'Zeitpunkt: 2026-10-23 09:27\nArchiv: flash-backup-2026-10-23_09-27-37'
    )
    assert notifications.notify("ok", "Backup erfolgreich: Flash", text, "Flash")
    argv = json.loads(capture.read_text())
    args = dict(zip(argv[::2], argv[1::2]))
    assert args["-e"] == "Flash"
    assert args["-s"] == "Backup erfolgreich: Flash"
    assert args["-i"] == "normal"
    assert args["-d"] == "Job: Flash"
    assert "\n" not in args["-d"] and "\n" not in args["-m"]
    assert args["-m"] != "normal"
    details = args["-m"].replace(r"\n", "\n")
    assert args["-d"] + "\n" + details == text
    # Unraid 7.3.4 archive storage replaces literal \n with <br> and reads
    # key=value records one physical line at a time (notify get).
    fields = {"description": args["-d"], "message": args["-m"].replace(r"\n", "<br>"), "importance": args["-i"]}
    lines = [f'{key}="' + value.replace("\\", "\\\\").replace('"', '\\"') + '"' for key, value in fields.items()]
    stored = dict(line.split("=", 1) for line in "\n".join(lines).splitlines())
    assert len(stored) == 3, "details must not turn into additional INI records"
    assert stored["description"] == '"Job: Flash"', "no unmatched opening quote"
    assert "<br><br>Ergebnis: Successful" in stored["message"]
    # Discord combines the short description and decoded long message.
    discord_text = args["-d"] + "\n\n" + details
    assert "\nZiel:" in discord_text and "\nSpeicherpfad:" in discord_text
    assert discord_text.endswith("Archiv: flash-backup-2026-10-23_09-27-37")


def test_single_line_unraid_notification_has_no_spurious_long_message(tmp_path, monkeypatch):
    import subprocess

    binary = tmp_path / "notify"
    binary.touch()
    monkeypatch.setattr(notifications, "_NOTIFY_BIN", str(binary))
    calls = []
    monkeypatch.setattr(notifications.subprocess, "run", lambda cmd, **kwargs: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0))
    assert notifications.notify("warn", "VM paused", "Please check LinuxMint", "LinuxMint")
    args = dict(zip(calls[0][1::2], calls[0][2::2]))
    assert args["-d"] == "Please check LinuxMint"
    assert args["-i"] == "warning"
    assert "-m" not in args


def test_unraid_details_normalize_windows_line_endings_and_retain_blank_lines():
    summary, details = notifications._unraid_text_fields("Job: Flash\r\n\r\nZiel: Local\rDauer: 23 sec")
    assert summary == "Job: Flash"
    assert details == r"\nZiel: Local\nDauer: 23 sec"
