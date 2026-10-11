# User manual / Benutzerhandbuch

The canonical long-form sources are maintained here and packaged unchanged for
offline Help. The short guides in `ui/docs` summarize operational tasks.

| Access | Deutsch | English |
| --- | --- | --- |
| Tutorial | [Erstes Backup und Restore](de/user-manual.md#schnellstart-erstes-backup-und-geprüfter-restore) | [First backup and restore](en/user-manual.md#tutorial-first-backup-and-verified-restore) |
| Tasks | [Aufgaben](de/user-manual.md#11-typische-aufgaben) | [Tasks](en/user-manual.md#11-typical-tasks) |
| Reference | [Aktionen und Einstellungen](de/user-manual.md#17-aktions--und-einstellungsreferenz) | [Actions and settings](en/user-manual.md#17-actions-and-settings-reference) |
| Concepts | [Ablauf und Grenzen](de/user-manual.md#18-konzepte-und-ablauf) | [Lifecycle and limits](en/user-manual.md#18-concepts-and-lifecycle) |
| Emergency | [Notfallwiederherstellung](de/user-manual.md#16-notfallwiederherstellung) | [Disaster recovery](en/user-manual.md#16-disaster-recovery) |

Behavior baseline: stable `2026.10.09.1435`, bundled Borg `1.4.5`.
Documentation audit: 2026-10-11. Renderer/packaging improvements ship in the
subsequent documentation test candidate; no backup behavior is changed.

## Images

The embedded screenshots were replaced on 2026-10-11: 33 current application
views per language and one shared Grafana main dashboard. They use synthetic data;
backup, hooks, restore and L2 execution in the application demo use real Borg.
Grafana uses the shipped template with separate synthetic Prometheus metrics.
See the [capture inventory and boundaries](assets/README.md).

All 50 existing PNG paths now contain refreshed lossless captures, including
all eight numbered guide images. Captions and marker positions match the
current controls. Initial Unraid installation, real devices and Docker/VM
operations still require hardware-specific verification.

## Maintenance

- [Documentation maintenance guide](../maintainer/documentation-style.md)
- [Audit and coverage matrix](../maintainer/documentation-audit-560.md)
- [Historical UI suggestions](help-improvements.md) (proposals, not features)
- [Apprise providers](apprise-providers.md)
