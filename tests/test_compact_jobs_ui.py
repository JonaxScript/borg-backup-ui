"""Real browser regression checks for compact Jobs and retained polling behavior (#619)."""
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('script', ['compact_jobs_browser.cjs', 'job_workflow_browser.cjs', 'dashboard_overview_browser.cjs', 'restore_test_evidence_browser.cjs', 'history_layout_browser.cjs', 'reports_navigation_browser.cjs', 'job_picker_browser.cjs', 'restore_navigation_browser.cjs'])
def test_compact_jobs_browser(script):
    """Exercise the actual renderers when optional Node/Playwright/Chromium tools exist."""
    if not shutil.which('node'):
        pytest.skip('Node.js is required for browser checks')
    available = subprocess.run(['node', '-e', "const fs=require('fs');const {chromium}=require('playwright');process.exit(fs.existsSync(process.env.BBUI_CHROMIUM || chromium.executablePath())?0:1)"], capture_output=True)
    if available.returncode:
        pytest.skip('Playwright and Chromium are required for browser checks')
    subprocess.run(['node', f'tests/{script}'], cwd=Path(__file__).resolve().parents[1], check=True)
