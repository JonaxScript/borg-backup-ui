"""Validate saved paths against the real HTTP endpoint and browser form (#656)."""
import os
import shutil

import pytest
import subprocess
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from test_database_backups import config, profile


def test_real_profile_validation_and_live_dump_browser(config, profile, monkeypatch):
    if not shutil.which('node'):
        pytest.skip('Node.js is required for browser validation')
    available = subprocess.run(['node', '-e', "const fs=require('fs'); const {chromium}=require('playwright'); process.exit(fs.existsSync(process.env.BBUI_CHROMIUM || chromium.executablePath()) ? 0 : 1)"], capture_output=True)
    if available.returncode:
        pytest.skip('Playwright and Chromium are required for browser validation')
    import borg_backup_ui
    from database_profiles import save_profile
    save_profile(config, {k: v for k, v in profile.items() if k != 'id'})
    monkeypatch.setattr(borg_backup_ui, '_log', lambda *_: None)

    class Handler(borg_backup_ui.BackupUIHandler):
        def _authorize_api_request(self, *_):
            return True

        def log_message(self, *_):
            pass

    Handler.config = config
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        subprocess.run(['node', 'tests/database_path_validation_ui.cjs'], check=True,
                       cwd=Path(__file__).resolve().parents[1],
                       env={**os.environ, 'BBUI_PROFILE_API': f'http://127.0.0.1:{server.server_port}'})
    finally:
        server.shutdown()
        server.server_close()
        worker.join(5)
