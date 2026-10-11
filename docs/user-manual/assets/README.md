# Screenshot inventory (#560)

Captured 2026-10-11 from the current repository application (stable behavior
baseline `2026.10.09.1435`, Borg `1.4.5`, source based on `41831a5` plus the
updated documentation). The help view includes this documentation candidate.
Lossless PNG captures from a local headless browser, explicitly requested by
the maintainer after JPEG compression artifacts were visible in the initial
preview. No painted controls or generated UI. Numbered guide images add documentation-only
SVG outlines and callouts to the current UI before the PNG capture. Light theme, 2000 x
1125 CSS-pixel viewport, device scale factor 2; longer settings pages are
captured in full. Browser scrollbar decorations are hidden for captures; the
application layout and data are unchanged. Dimensions are listed below.

## Application demo

The full HTTP application, normal login, migration runner, job runner and Borg
run in an isolated mount/PID namespace. `/mnt/user/demo` maps exclusively to
repository-local fixtures, not production shares. All names, accounts, paths
and files are synthetic. No password or token is visible. Settings for USB,
SMB and SSH show current forms without claiming real target connectivity.

Project Documents completed a real backup with successful Pre and Post hooks.
A real L2 dry-run finished, and Browse & Restore restored Welcome.txt plus the
Projects folder (14 files). A separate byte-for-byte comparison matched all
14 originals. The L2 report itself is not proof of that write/compare operation.
This is not an Unraid hardware, Docker/VM shutdown or fresh-host recovery test.
The second sample job has no run yet; its empty status is intentional.
Notification screenshots were recaptured after mounting the verified packaged
Apprise 1.13.1 runtime into the demo. Both languages were captured only after
provider loading succeeded (148 entries) and no feedback/alert was visible.

| Screen | German | English | Native pixels DE / EN |
| --- | --- | --- | --- |
| dashboard | [DE](de/current/dashboard.png) | [EN](en/current/dashboard.png) | 4000 x 2250 / 4000 x 2250 |
| help | [DE](de/current/help.png) | [EN](en/current/help.png) | 4000 x 2250 / 4000 x 2250 |
| history | [DE](de/current/history.png) | [EN](en/current/history.png) | 4000 x 2250 / 4000 x 2250 |
| jobs | [DE](de/current/jobs.png) | [EN](en/current/jobs.png) | 4000 x 2250 / 4000 x 2250 |
| reports | [DE](de/current/reports.png) | [EN](en/current/reports.png) | 4000 x 2250 / 4000 x 2250 |
| repositories | [DE](de/current/repositories.png) | [EN](en/current/repositories.png) | 4000 x 2250 / 4000 x 2250 |
| restore-history | [DE](de/current/restore-history.png) | [EN](en/current/restore-history.png) | 4000 x 2250 / 4000 x 2250 |
| restore-review | [DE](de/current/restore-review.png) | [EN](en/current/restore-review.png) | 4000 x 2310 / 4000 x 2276 |
| restore-selection | [DE](de/current/restore-selection.png) | [EN](en/current/restore-selection.png) | 4000 x 2250 / 4000 x 2250 |
| restore-success | [DE](de/current/restore-success.png) | [EN](en/current/restore-success.png) | 4000 x 2250 / 4000 x 2250 |
| restore-target | [DE](de/current/restore-target.png) | [EN](en/current/restore-target.png) | 4000 x 2250 / 4000 x 2250 |
| restore-tests-plan | [DE](de/current/restore-tests-plan.png) | [EN](en/current/restore-tests-plan.png) | 4000 x 2250 / 4000 x 2250 |
| restore-tests-reports | [DE](de/current/restore-tests-reports.png) | [EN](en/current/restore-tests-reports.png) | 4000 x 2250 / 4000 x 2250 |
| scripts | [DE](de/current/scripts.png) | [EN](en/current/scripts.png) | 4000 x 2690 / 4000 x 2690 |
| settings-advanced | [DE](de/current/settings-advanced.png) | [EN](en/current/settings-advanced.png) | 4000 x 2690 / 4000 x 2690 |
| settings-backup | [DE](de/current/settings-backup.png) | [EN](en/current/settings-backup.png) | 4000 x 2690 / 4000 x 2690 |
| settings-general | [DE](de/current/settings-general.png) | [EN](en/current/settings-general.png) | 4000 x 2720 / 4000 x 2720 |
| settings-import-export | [DE](de/current/settings-import-export.png) | [EN](en/current/settings-import-export.png) | 4000 x 2690 / 4000 x 2690 |
| settings-integrations | [DE](de/current/settings-integrations.png) | [EN](en/current/settings-integrations.png) | 4000 x 2690 / 4000 x 2690 |
| settings-local | [DE](de/current/settings-local.png) | [EN](en/current/settings-local.png) | 4000 x 2690 / 4000 x 2690 |
| settings-notifications | [DE](de/current/settings-notifications.png) | [EN](en/current/settings-notifications.png) | 4000 x 3688 / 4000 x 3688 |
| settings-restore | [DE](de/current/settings-restore.png) | [EN](en/current/settings-restore.png) | 4000 x 2740 / 4000 x 2740 |
| settings-smb | [DE](de/current/settings-smb.png) | [EN](en/current/settings-smb.png) | 4000 x 2690 / 4000 x 2690 |
| settings-storagebox | [DE](de/current/settings-storagebox.png) | [EN](en/current/settings-storagebox.png) | 4000 x 2690 / 4000 x 2690 |
| settings-usb | [DE](de/current/settings-usb.png) | [EN](en/current/settings-usb.png) | 4000 x 2690 / 4000 x 2690 |
| settings-users | [DE](de/current/settings-users.png) | [EN](en/current/settings-users.png) | 4000 x 2690 / 4000 x 2690 |
| wizard-basics | [DE](de/current/wizard-basics.png) | [EN](en/current/wizard-basics.png) | 4000 x 2250 / 4000 x 2250 |
| wizard-exclusions | [DE](de/current/wizard-exclusions.png) | [EN](en/current/wizard-exclusions.png) | 4000 x 2250 / 4000 x 2250 |
| wizard-flow | [DE](de/current/wizard-flow.png) | [EN](en/current/wizard-flow.png) | 4000 x 2250 / 4000 x 2250 |
| wizard-retention | [DE](de/current/wizard-retention.png) | [EN](en/current/wizard-retention.png) | 4000 x 2250 / 4000 x 2250 |
| wizard-schedule | [DE](de/current/wizard-schedule.png) | [EN](en/current/wizard-schedule.png) | 4000 x 2250 / 4000 x 2250 |
| wizard-scripts | [DE](de/current/wizard-scripts.png) | [EN](en/current/wizard-scripts.png) | 4000 x 2250 / 4000 x 2250 |
| wizard-sources | [DE](de/current/wizard-sources.png) | [EN](en/current/wizard-sources.png) | 4000 x 2250 / 4000 x 2250 |

## Grafana examples

Real Grafana 12.1.1, provisioned from the shipped
`ui/integrations/borg-backup-ui-grafana.json`; only the data-source binding is
adapted for local provisioning. Prometheus uses synthetic example metrics for
13 jobs with deliberately different success, overdue and recovery states.
These are illustrative values, not measurements of the application demo.
Dashboard language: English, with localized explanations in both manuals.

- [Main dashboard overview and charts](shared/grafana-overview.png) (4000 x 4612 pixels)

The single main dashboard capture includes the overview and charts, without
separate detail-table or history images. It uses lossless PNG at device scale
factor 2 and a taller viewport to include complete chart panels. Status
snapshots do not establish application recovery or live transfer throughput.

## Existing paths and numbered guides

All 50 existing PNG files (25 per language) were refreshed on 2026-10-11.
Their paths remain stable for existing links. The 42 ordinary images use the
corresponding current captures; the eight guide images have newly positioned
numbered outlines. The manual captions explain every number in both languages.

| Guide | German | English |
| --- | --- | --- |
| Dashboard | [DE](de/dashboard-guide.png) | [EN](en/dashboard-guide.png) |
| Jobs | [DE](de/jobs-guide.png) | [EN](en/jobs-guide.png) |
| Restore | [DE](de/restore-guide.png) | [EN](en/restore-guide.png) |
| Settings | [DE](de/settings-guide.png) | [EN](en/settings-guide.png) |

## Remaining environment checks

Fresh Unraid installation/setup, hardware-backed USB/SMB/SSH access and actual
Docker/VM operation still need maintainer captures and environment tests. No
staged or simulated screen is substituted for those missing demonstrations.
