# Documentation audit and coverage (#560)

## Baseline and evidence

Audit started 2026-10-11 against `origin/main`
`6df5bb0614c04af345f493a36c820ba855645934`. Stable manifest fetched from the
published main URL matches the checkout: `2026.10.09.1435`. Its package provenance
records source `54785a9720ba525d77f2e037d169b88410a78953`, base
`d3b2e70bd7ae73c253f0051ca2b0c9ec2cfcc29f`, source digest
`4100019c1a79340538d7cf1f33ab7b7c9f028e142f49f14eb85ce776a3bd10cb`.
The test channel also advertised `2026.10.09.1435` at the start of the audit.
GitHub Releases has no entries; publication is the plugin manifest/package,
not a GitHub Release. Website branch #559 and hook-example branch #557 are
excluded. No product behavior from either branch is documented as released.

The existing 25 PNGs per language claim stable `2026.08.31.0907`, captured
2026-09-03. Dimensions alone are not UI verification. They remain historical
illustrations until a current, synthetic Unraid capture is reviewed.

## Inventory and structural decision

Reviewed README, docs index, manual entry/readme, both canonical manuals, both
quick-help files, historical help proposal, Apprise provider catalog, integration
and hook-example guides, authentication recovery, maintainer release/support
instructions, changelog/manifest/package provenance, help JS/CSS and packaging
and language tests. There are 50 historical PNG assets (25 per language), with
20 embedded images per manual. Assets are retained and explicitly dated.

Keep the two canonical long manuals and existing menu chapters. Four entry routes
and sections 16-18 provide tutorial, tasks, reference and concepts without a new
framework or independently maintained copies. Promote notification/integration
subheadings, preserving their anchors. Homepage remains in General; Prometheus
and notification settings have their own UI areas.

## Findings

Locations below use stable section/function names rather than line numbers
that change while editing. P0 concerns data safety or false assurance; P1
incorrect workflows/navigation; P2 editorial quality.

| Priority | Location and finding | Executable evidence | User impact | Correction and verification |
| --- | --- | --- | --- | --- |
| P0 | help.md/help.en.md Restore Tests; manuals 8.3: L2 described as sample restore, L3 vague | `runtime/scripts/borg_restore_test.py:RestoreTest._test_repo_locked` (class method); `extract --dry-run`, `extract --stdout`, SHA-256 accumulation | False confidence in written files/application recovery | Explicit methods, scope, writes and limitations in both manuals/help; semantic regression checks |
| P0 | Manual 8: report is stored per job but latest archive is repository-wide | runner uses `list --short --last 1`, no archive filter | A different job's archive can supply the evidence | Prominent limitation and manual archive selection; separate product finding below |
| P0 | Manual 8: successful status/coverage can overstate verification | full dry-run timeout 124 accepted if sampled entries exist; L1 returns success even after `info` failure | Incomplete checks can look successful | Document concrete limits, require command/step review and actual restore; product fixes excluded |
| P0 | Manual 9.10 and recovery scattered | `settings_transfer_api.py:export_jobs_bundle`, `export_jobs_bundle_encrypted`, `export_profile_secrets_backup`; `job_scripts.py:store_path` | Missing secrets or central hook definitions after disaster | Exact format matrix, separate key/script backup and recovery order |
| P1 | Manuals header and assets README: mixed dates/functions | stable package provenance; current UI/source | Reader cannot identify applicable version | Separate behavior baseline, documentation revision, screenshot date and new renderer candidate |
| P1 | Manual 3.5: type/location key | `job_identity.py`, `wizard_api.py`, `wizard.js`, actual `wiz-job-id`/`wiz-archive-prefix` inputs | Wrong expectations for rename/repository change | UUID/name/prefix/history distinction and ten actual steps |
| P1 | Manual 11.4 vs 8.2, short help: interval-only plan | `restore_tests_api.py`, `schedule_api.py`, `restore-tests.js` | Wrong calendar and evidence-expiry setup | Calendar/manual/legacy distinction; missed-slot and timezone guidance |
| P1 | `help.js:_renderHelpMarkdown`, `_renderHelpToc` | Existing renderer has no table branch, strips accents and collapses hyphens unlike GitHub links | Broken tables, TOC and companion links | Safe focused renderer, consistent heading IDs and legacy alias resolution; executable JS tests |
| P1 | `plugin/build.sh` manual copy block | Only two manuals and assets copied | Offline provider/hook links fail | Explicit companion packaging plus link/asset/package tests |
| P1 | `test_i18n_resources.py` | Old version and exact line-count assertions | Green tests preserve wrong content | Semantic contracts, real links and executed renderer checks |
| P1 | Manual 10 and 11; settings 9.1 | actual help tabs and settings navigation | Tasks buried, notification/integration location wrong | Four entry routes, complete tutorial/recovery and task prerequisites/checks |
| P2 | `help-improvements.md`, terminology, historic issue references | Existing proposals are not implemented behavior | Confuses planning and released features | Mark historical review, separate maintenance guide, remove issue asides from normal prose |

## Separate product findings (no product logic changed)

1. Restore evidence can use another job's archive in a shared repository.
2. A full L2 dry-run timing out with exit 124 can be recorded as passed based on
   a preselected list, without proof that those files were read. Never interpret
   that percentage as independently measured coverage.
3. L1 reports overall success after failed `borg info`; inspect individual steps.
4. L2 reports an integrity command labelled `sha256 sample compare` without that
   operation; L3 computes hashes but has no independent expected-hash comparison.
5. L3 streams have no explicit per-file timeout in this path. Global dry-run
   limits are not a timeout guarantee for that phase.
6. Job bundles carry hook references but no central script inventory. Recreate
   definitions and reassign hooks before enabling imported jobs.

These are source findings, not claims of a reproduced production incident.

## Coverage matrix

C = executable code inspected; S = documentation/static checks; P = practical
execution; O = still requires an actual Unraid/environment test. A passing text
or unit test does not imply a successful real backup or restored application.

| Task/function | Authoritative code/UI | German | English | Short help | Image need | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Install/setup/first backup and restore | control page, setup-wizard.js, wizard_api.py, restore_api.py | Tutorial, 1.3 | Tutorial, 1.3 | First steps | New setup + final restore | C/S; Borg CLI P, complete Unraid flow O |
| Job identity/ten steps | job_identity.py, wizard.js, ui/index.html | 3.5 | 3.5 | Job wizard | Current step 1/9/10 | C |
| Local/USB/SMB/SSH | storage_objects_api.py, storage_profiles_api.py, usb_storage.py, smb_profiles_api.py, storagebox_api.py | 9.6-9.9 | 9.6-9.9 | Profiles | Existing historic profiles | C; devices O |
| Encryption/key recovery | repositories_api.py, borg_key_store.py, settings_transfer_api.py | 4, 16 | 4, 16 | Repository/recovery | Key export | C |
| Sources/exclusions | job_source_paths.py, job_exclusions.py, wizard_runner.py | 3.5 | 3.5 | Sources | Current exclusions | C |
| Docker/VM and hooks | wizard_runner.py, backup_job.py, job_scripts.py | 3.5, 18 | 3.5, 18 | Jobs | Current scripts | C; Unraid O |
| Schedules/retention | schedule_api.py, retention_policy.py, borg_runner.py, check_api.py | 3.5-3.6, 17 | 3.5-3.6, 17 | Jobs/tests | Current retention | C |
| Selection/conflicts/foreign archives | restore_api.py, restore_selection.py, restore.js | 7, 11.3 | 7, 11.3 | Restore | Current multi-select | C |
| L1/L2/L3 and validity | borg_restore_test.py, restore_tests_api.py | 8, 17 | 8, 17 | Tests | New report limits | C; product findings above |
| Maintenance/delete | check_api.py, repositories_api.py | 4, 17 | 4, 17 | Repositories | Current maintenance | C |
| Roles/tokens | borg_backup_ui.py:_required_role_for_request, prometheus_api.py, homepage_widget_api.py | 17 | 17 | Roles | No image needed | C |
| Export/recovery/update | settings_transfer_api.py, job_scripts.py, migrations/registry.py | 9.10, 16 | 9.10, 16 | Recovery | Export summary | C; new host O |
| Notifications/reminders | notification_events.py, notification_reminder_api.py | 9, 11.5 | 9, 11.5 | Notifications | Current navigation | C; delivery O |
| Sizes/dashboard/reports | status_api.py, reports_api.py, borg_runner.py | 2, 5-6, 18 | 2, 5-6, 18 | Dashboard/reports | Historic overview | C |
| Reset/uninstall/support | factory_reset_api.py, support_bundle_api.py, manifest REMOVE | 9.12, 13-14 | 9.12, 13-14 | Support | No destructive demo | C |
| Offline help/links/themes | help.js, build.sh, remaining-ui-redesign.css | All | All | All | Current help both themes | C/S/P; actual help component tested |

## Validation record

Recorded 2026-10-11 before the final source commit:

- **Static/source checks:** all maintained local links, fragments and image
  references resolve. Both languages retain the original menu anchors. Review
  covers tutorial, recovery, roles, exports, retention and restore-test limits;
  this is a reviewed coverage matrix, not a claim derived from keyword counts.
- **Focused automated tests:** 55 passed across documentation, i18n, remaining UI
  and release workflow. Executed JS covers tables, nested lists, code escaping,
  blocked executable URLs, Unicode/duplicate/legacy anchors, selected view and
  out-of-order responses. The actual packaging copier is exercised and every
  shipped companion is covered by the candidate source digest.
- **GitHub rendering:** both manuals passed through GitHub's Markdown API;
  each produced 9 tables, 20 images, lists and code blocks. The API does not emit
  heading IDs; fragment resolution is checked separately by the source checker
  and real help DOM. This is not a claim that the API checked browser navigation.
- **Browser/component execution:** real help markup, JS, CSS, translations and
  staged offline documents served by the application's HTTP handler on loopback.
  Verified German/English, quick/manual/companion return, search, TOC, Unicode
  fragments, loaded images, light/dark and 390x844 viewport. Page width did not
  overflow; tables scroll within their containers. No console errors observed.
  Test-only screenshots are under `.release-tmp/docs-560/help-*.png`, not installed
  product screenshots. The component harness adds language/theme controls and
  is not represented as a full Unraid application session.
- **Practical Borg test:** bundled Borg 1.4.5, isolated repository-local synthetic
  data, `repokey-blake2` initialization/key export, `lz4` create, archive listing,
  info, dry-run (destination stayed empty), stdout read, real extract, independent
  `cmp`, and `check --verify-data` all returned 0. One known 29-byte text file
  compared byte-for-byte. This validates Borg methods, not the complete plugin
  wizard, L1/L2/L3 runner, or application-data recovery. Local execution record:
  `.release-tmp/docs-560/borg-smoke/result.json`.
- **Final gates:** full preflight, candidate build and published package checks
  are recorded against the exact final commit in the PR. They cannot be claimed
  before execution and must not require editing this commit afterward.

## Remaining validation and acceptance limits

The real application started and login worked, but initial setup correctly
requires an Unraid `/mnt` data root; this workspace is not an Unraid host. No
production roots were added or bypassed. A full UI tutorial, fresh-host recovery,
real devices, mail delivery and Docker/VM shutdown remain maintainer tests.

Current setup, wizard identity/exclusions/scripts/retention, restore multi-select,
report limitations and notification-navigation screenshots remain missing in both
languages. Existing images are historical and were not relabelled current. The
coverage matrix names those gaps. Product findings above remain open; this change
corrects the documentation and help delivery without changing their behavior.

