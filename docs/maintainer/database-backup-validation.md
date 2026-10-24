# Database backup validation (#591)

Automated coverage uses the real managed helper, Docker process-group supervisor,
Borg archive/readback and restore into fresh network-isolated containers. Start
with pre-pulled `mariadb:11.4` and `postgres:16` and the bundled Borg executable
on PATH. Keep TMPDIR and pytest's base directory inside this repository.

```
BBUI_DATABASE_DOCKER_TESTS=1 pytest -q -s tests/test_database_docker_integration.py --basetemp=.release-tmp/database-docker-tests
pytest -q tests/test_database_backups.py tests/test_database_profiles_ui.py
```

The Docker test substitutes only the host staging mount guard because the
repository test filesystem is not an Unraid pool. Production mount, permissions,
space and overlap rules have isolated tests. Clients and database processes are
real. Test images expose no ports; generated data is disposable. Failed fixture
startup is not an application export failure. Successful cancellation excludes
zombies (which cannot run) and checks that no active client child remains.

Validated on Linux/Docker with Borg 1.4.5:

| Image | Server/client | Image digest |
| --- | --- | --- |
| `mariadb:11.4` | 11.4.13 | `sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873` |
| `postgres:16` | 16.15 | `sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54` |

Real exports also verify native password authentication with special characters,
database discovery, and removal of temporary in-container credentials. Managed
secrets remain separate from public configuration and preserve running snapshots.

Browser interaction tests use Node.js, Playwright and Chromium; set
`BBUI_CHROMIUM` to an installed executable if it is outside Playwright's default
cache. Without those optional dependencies the browser test is skipped.
Fresh Unraid installation and upgrade acceptance remain maintainer tests.

Manual test-channel acceptance on Unraid:

- Fresh install: open both translated settings pages, confirm both helpers ship
  executable with the bilingual ownership warning and appear read-only under Scripts. No export runs at install.
- Enter database users/passwords in Settings, load database lists, select scope
  and save. No manual container files/mounts are needed. Test Secrets export/import
  and credential rotation during a run. Check unavailable/wrong staging mounts.
- Save a profile, check its connection, export a test dump, cancel an active dump
  and reconcile an interrupted operation. Check per-run status/space and cleanup.
- Run a mixed file/database job and a database-only job. Verify current dumps and
  manifest in Borg, missing/excluded artifacts cause failure, warnings retain
  local dumps, and no previous/partial dump appears in the current archive.
- Restore into separate database containers and verify data, views, routines,
  triggers/events and PostgreSQL extensions/roles. Reprovision omitted passwords
  and MariaDB global grants; do not claim a common snapshot with application files.
- Upgrade from the current stable plugin: save profiles and an unrelated custom
  script, then install the candidate. Confirm bundled helpers are refreshed and
  profiles, job references, credential files and custom scripts are unchanged.
- Exercise existing jobs without database profiles and concurrent Docker jobs.
- Export/import job configuration, confirm profile preservation and collision
  rejection, then recheck container credentials on the destination.

Record Unraid version, image digests, client/server versions and outcomes in the
implementation PR before stable promotion. These host-specific checks are not
replaced by the Linux Docker suite.
