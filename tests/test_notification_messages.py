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



def _capture_unraid_delivery(tmp_path, monkeypatch, text):
    """Run notify and a child Bash agent, returning only captured transport fields."""
    import json
    import shlex

    argv_path = tmp_path / "argv.json"
    agent_path = tmp_path / "agent.json"
    recorder = tmp_path / "record.py"
    recorder.write_text(
        "import json, os, pathlib, sys\n"
        "keys = ['DESCRIPTION', 'CONTENT', 'IMPORTANCE', 'BASH_ENV', "
        "'BBUI_UNRAID_AGENT_DESCRIPTION', 'BBUI_UNRAID_PREVIOUS_BASH_ENV', 'BBUI_TEST_STARTUP_FLAG']\n"
        "pathlib.Path(sys.argv[1]).write_text(json.dumps({key: os.environ.get(key) for key in keys}))\n"
    )
    agent = tmp_path / "agent.sh"
    agent.write_text("exec " + " ".join(map(shlex.quote, [sys.executable, str(recorder), str(agent_path)])) + "\n")
    binary = tmp_path / "notify"
    binary.write_text(
        f"#!{sys.executable}\nimport json, os, pathlib, subprocess, sys\n"
        "args = dict(zip(sys.argv[1::2], sys.argv[2::2]))\n"
        f"pathlib.Path({str(argv_path)!r}).write_text(json.dumps(args))\n"
        "env = dict(os.environ, DESCRIPTION=args['-d'], CONTENT=args.get('-m', ''), IMPORTANCE=args['-i'])\n"
        f"subprocess.run(['bash', {str(agent)!r}], env=env, check=True)\n",
        encoding="utf-8",
    )
    binary.chmod(0o755)
    monkeypatch.setattr(notifications, "_NOTIFY_BIN", str(binary))
    assert notifications.notify("ok", "Backup erfolgreich: Flash", text, "Flash")
    return json.loads(argv_path.read_text()), json.loads(agent_path.read_text())


def test_unraid_panel_and_agent_receive_the_complete_message(tmp_path, monkeypatch):
    """The full description survives INI/API decoding and the agent boundary."""
    import html
    import json
    from html.parser import HTMLParser

    monkeypatch.delenv("BASH_ENV", raising=False)
    text = (
        'Job: Flash\nZiel: Local / borg-backup-flash\n'
        'Speicherpfad: /mnt/backup/with "quotes" and spaces\n'
        '\nErgebnis: Successful\nDauer: 23 sec\n'
        'Zeitpunkt: 2026-10-23 09:27\nArchiv: flash-backup-2026-10-23_09-27-37\n'
        'Grund: <img src=x onerror=alert(1)> & **literal** C:\\backup'
    )
    args, agent = _capture_unraid_delivery(tmp_path, monkeypatch, text)
    assert args["-e"] == "Flash" and args["-s"] == "Backup erfolgreich: Flash"
    assert args["-i"] == "normal" and "-m" not in args
    assert "\n" not in args["-d"] and "\r" not in args["-d"]
    assert "Archiv:" in args["-d"], "the sidebar must not receive only the first line"
    # Unraid's writer quotes strings and escapes quotes/backslashes. The API
    # decodes entities BEFORE parsing INI; raw quote entities would corrupt it.
    record = 'description="' + args['-d'].replace('\\', '\\\\').replace('"', '\\"') + '"\nimportance="normal"\n'
    decoded_record = html.unescape(record)
    fields = dict(line.split("=", 1) for line in decoded_record.strip().split("\n"))
    assert len(fields) == 2
    description = json.loads(fields["description"])
    assert description.startswith("<div>") and description.endswith("</div>")
    assert "<img" not in description
    assert "&lt;img" in description and "&amp; **literal**" in description

    class PlainDescription(HTMLParser):
        """Collect displayed text and explicit breaks from the generated fragment."""
        def __init__(self):
            super().__init__()
            self.parts = []
            self.tags = []

        def handle_starttag(self, tag, attrs):
            self.tags.append(tag)
            if tag == "br":
                self.parts.append("\n")

        def handle_data(self, data):
            self.parts.append(data)

    parser = PlainDescription()
    parser.feed(description)
    assert "".join(parser.parts) == text
    assert set(parser.tags) == {"div", "br"}
    assert agent["DESCRIPTION"].replace(r"\n", "\n") == text
    assert agent["CONTENT"] == "" and agent["IMPORTANCE"] == "normal"
    assert agent["BASH_ENV"] is None
    assert agent["BBUI_UNRAID_AGENT_DESCRIPTION"] is None
    assert agent["BBUI_UNRAID_PREVIOUS_BASH_ENV"] is None


def test_agent_adapter_preserves_inherited_bash_startup(tmp_path, monkeypatch):
    previous = tmp_path / "previous.sh"
    previous.write_text("export BBUI_TEST_STARTUP_FLAG=preserved\n")
    monkeypatch.setenv("BASH_ENV", str(previous))
    _, agent = _capture_unraid_delivery(tmp_path, monkeypatch, "Job: Flash\nZiel: Local")
    assert agent["BBUI_TEST_STARTUP_FLAG"] == "preserved"
    assert agent["BASH_ENV"] == str(previous)
    assert agent["DESCRIPTION"] == r"Job: Flash\nZiel: Local"
    assert notifications.os.environ["BASH_ENV"] == str(previous), "parent environment must not change"


def test_single_line_unraid_notification_has_no_spurious_long_message(tmp_path, monkeypatch):
    import subprocess

    binary = tmp_path / "notify"
    binary.touch()
    monkeypatch.setattr(notifications, "_NOTIFY_BIN", str(binary))
    calls = []
    monkeypatch.setattr(notifications.subprocess, "run", lambda cmd, **kwargs: calls.append(cmd) or subprocess.CompletedProcess(cmd, 0))
    assert notifications.notify("warn", "VM paused", "Please check LinuxMint", "LinuxMint")
    args = dict(zip(calls[0][1::2], calls[0][2::2]))
    assert args["-d"] == "<div>Please check LinuxMint</div>"
    assert args["-i"] == "warning" and "-m" not in args


def test_unraid_text_normalizes_windows_endings_and_retains_blank_lines():
    display, agent = notifications._unraid_text_fields("Job: Flash\r\n\r\nZiel: Local\rDauer: 23 sec")
    assert display == "<div>Job: Flash<br><br>Ziel: Local<br>Dauer: 23 sec</div>"
    assert agent == r"Job: Flash\n\nZiel: Local\nDauer: 23 sec"
