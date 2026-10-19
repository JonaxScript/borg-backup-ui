"""Execute browser schedule-editor regressions without writing real schedules."""
from pathlib import Path
import os
import subprocess


def test_schedule_editor_round_trip_and_preview():
    root = Path(__file__).resolve().parents[1]
    subprocess.run(['node', 'tests/schedule_editor.cjs'], cwd=root,
                   env={**os.environ, 'TZ': 'Europe/Berlin'}, check=True)
