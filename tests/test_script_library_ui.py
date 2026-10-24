"""Browser interaction checks for both script library translations (#591)."""
import subprocess
import shutil
from pathlib import Path

import pytest


def test_script_library_browser():
    if not shutil.which('node'):
        pytest.skip('Node.js is required for the script library browser test')
    available = subprocess.run(['node', '-e', "const fs=require('fs'); const {chromium}=require('playwright'); process.exit(fs.existsSync(process.env.BBUI_CHROMIUM || chromium.executablePath()) ? 0 : 1)"], capture_output=True)
    if available.returncode:
        pytest.skip('Playwright and Chromium are required for the script library browser test')
    subprocess.run(['node','tests/script_library_ui.cjs'], cwd=Path(__file__).resolve().parents[1], check=True)
