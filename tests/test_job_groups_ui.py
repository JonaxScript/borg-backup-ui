"""Execute group UI behavior without requiring browser packages in the plugin."""
import shutil
import subprocess
from pathlib import Path
import pytest


def test_group_ui_behaviors():
    node = shutil.which('node')
    if not node:
        pytest.skip('Node.js is not installed')
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([node, '--test', 'tests/job_groups_ui.cjs'], cwd=root,
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
