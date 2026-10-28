"""Browser regression coverage for registry-backed repository cards (#621)."""
import shutil
import subprocess
from pathlib import Path

import pytest


def test_repository_cards_browser():
    """Check real rendering and action routing when Playwright/Chromium are available."""
    if not shutil.which('node'):
        pytest.skip('Node.js is required for browser checks')
    available = subprocess.run(['node', '-e', "const fs=require('fs');const {chromium}=require('playwright');process.exit(fs.existsSync(process.env.BBUI_CHROMIUM || chromium.executablePath())?0:1)"], capture_output=True)
    if available.returncode:
        pytest.skip('Playwright and Chromium are required for browser checks')
    subprocess.run(['node', 'tests/repository_cards_browser.cjs'], cwd=Path(__file__).resolve().parents[1], check=True)
