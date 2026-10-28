// ══════════════════════════════════════════════════════════════════════════════
// STORAGE PAGE
// ══════════════════════════════════════════════════════════════════════════════

window.BBUI = window.BBUI || {};
window.BBUI.storageState = window.BBUI.storageState || {
  loaded: false,
  data: null,
  jobs: [],
  selectedRepositoryKey: '',
  selectedTab: 'overview',
  expanded: false,
  target: 'all',
  archivePages: {},
  archiveCache: {},
  archiveBrowser: { repositoryKey: '', archive: '', path: '', files: [], loading: false, error: '' },
  lifecycleCache: {},
  maintenanceState: { running: false },
  pendingRepositoryKeyImportGuide: false,
};
const storageState = window.BBUI.storageState;
storageState.archivePages = storageState.archivePages || {};
storageState.target = storageState.target || 'all';
storageState.archiveCache = storageState.archiveCache || {};
storageState.archiveBrowser = storageState.archiveBrowser || { repositoryKey: '', archive: '', path: '', files: [], loading: false, error: '' };
storageState.lifecycleCache = storageState.lifecycleCache || {};
storageState.maintenanceState = storageState.maintenanceState || { running: false };
storageState.maintenanceConfirmation = null;
storageState.archiveDeleteConfirmation = null;
storageState.lifecycleConfirmation = null;
storageState.pendingRepositoryKeyImportGuide = !!storageState.pendingRepositoryKeyImportGuide;
storageState.repositoryManagerCloseSnapshot = '';
storageState.lifecycleCloseSnapshot = '';
storageState.maintenanceCloseSnapshot = '';

function storageT(key, params = {}) {
  return window.BBUI?.components?.i18n?.t?.(key, params) || key;
}

function storageModalHelpers() {
  return window.BBUI?.components?.modal || {};
}

function storageConfirmDiscard(dirty, onConfirm) {
  return storageModalHelpers().confirmDiscardIfDirty?.(dirty, onConfirm) !== false;
}

function storageModalSnapshot(modalId) {
  const modal = document.getElementById(modalId);
  return storageModalHelpers().formSnapshot?.(modal) || '';
}

/** Compare the visible storage dialog with its captured form snapshot. */
function storageModalDirty(modalId, snapshot) {
  const modal = document.getElementById(modalId);
  if (!modal || modal.classList.contains('hidden')) return false;
  return !!snapshot && storageModalSnapshot(modalId) !== snapshot;
}

function storageBorgVersionLabel() {
  const version = String(
    window.BBUI?.appInfo?.borgVersion
      || window.BBUI?.settingsState?.appInfo?.borgVersion
      || ''
  ).trim();
  return version && version.toLowerCase() !== 'unknown' ? version : '';
}

function storageCount(count, singularKey, pluralKey) {
  return storageT(count === 1 ? singularKey : pluralKey, { count });
}

const STORAGE_LOCATION_ORDER = ['local', 'usb', 'smb', 'storagebox'];

function storageLocationIcon(key) {
  const icons = {
    all: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 6h16M4 12h16M4 18h16"/>
    </svg>`,
    local: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2"/>
      <rect x="2" y="14" width="20" height="8" rx="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6" stroke-width="3"/>
      <line x1="6" y1="18" x2="6.01" y2="18" stroke-width="3"/>
    </svg>`,
    usb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 8h1a4 4 0 0 1 0 8h-1"/>
      <path d="M3 8h11v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"/>
      <line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/>
      <line x1="8" y1="4" x2="8" y2="10"/>
    </svg>`,
    smb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M3 7h18"/><path d="M3 12h18"/><path d="M3 17h18"/>
    </svg>`,
    storagebox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>`,
  };
  return icons[key] || icons.all;
}

function storageLocationLabel(key) {
  return {
    all: storageT('storage.allLocations'),
    local: storageT('storage.local'),
    usb: storageT('storage.usbDrive'),
    smb: storageT('storage.smb'),
    storagebox: storageT('storage.storagebox'),
  }[key] || key;
}

function storageTypeLabel(repo) {
  return {
    flash: 'FLASH',
    appdata: 'APPDATA',
    photos: 'PHOTOS',
    VMs: 'VMs',
    vms: 'VMs',
    sonstiges: storageT('storage.typeOther'),
  }[repo.backup_type] || String(repo.backup_type || '').toUpperCase();
}

function storageRepositoryTitle(repo, job) {
  return String(
    repo?.display_name
    || repo?.repository_name
    || job?.name
    || storageTypeLabel(repo)
    || repo?.repository_key
    || '',
  ).trim();
}

function storageRepositoryName(repo) {
  const explicit = String(repo?.repository_name || '').trim();
  if (explicit) return explicit;
  const path = String(repo?.path_display || repo?.path_raw || '').trim().replace(/\/+$/, '');
  if (!path) return String(repo?.repository_key || repo?.conf_key || '').trim();
  const pathOnly = path.includes('://') ? path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '') : path;
  const leaf = (pathOnly.split('/').filter(Boolean).pop() || path).trim();
  try {
    return decodeURIComponent(leaf);
  } catch (_) {
    return leaf;
  }
}

function storageJobName(repo, job) {
  return String(job?.name || job?.display_name || repo?.job_name || repo?.display_name || '').trim();
}

function storageJobsForRepository(repo) {
  const jobs = Array.isArray(storageState.jobs) ? storageState.jobs : [];
  const confKey = String(repo?.conf_key || '');
  const jobKey = confKey.startsWith('JOB:') ? confKey.slice(4) : '';
  const usedBy = Array.isArray(repo?.used_by) ? repo.used_by.map((x) => String(x || '')) : [];
  const sourceJobKeys = Array.isArray(repo?.source_job_keys) ? repo.source_job_keys.map((x) => String(x || '')) : [];
  const matches = jobs.filter((job) => usedBy.includes(String(job.key || '')) || sourceJobKeys.includes(String(job.key || '')));
  if (!matches.length && jobKey) {
    const direct = jobs.find((job) => String(job.key || '') === jobKey);
    if (direct) matches.push(direct);
  }
  const seen = new Set();
  return matches.filter((job) => {
    const key = String(job?.key || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => storageJobName(repo, a).localeCompare(storageJobName(repo, b)));
}

function storageArchivePrefixFromJob(job) {
  return String(job?.archive_prefix || '').trim();
}

function storageArchiveFilterFromJob(job) {
  const prefix = storageArchivePrefixFromJob(job);
  return prefix ? `${prefix}-*` : '';
}

function storageRetentionFromJob(job) {
  const raw = job?.retention && typeof job.retention === 'object' ? job.retention : {};
  return {
    mode: raw.mode || 'tiered',
    last: raw.last || '0',
    hourly: raw.hourly || '0',
    within: raw.within || '',
    daily: String(job?.retention_daily ?? raw.daily ?? '').trim(),
    weekly: String(job?.retention_weekly ?? raw.weekly ?? '').trim(),
    monthly: String(job?.retention_monthly ?? raw.monthly ?? '').trim(),
    yearly: String(job?.retention_yearly ?? raw.yearly ?? '').trim(),
  };
}

function storageRetentionTableHtml(job) {
  const retention = storageRetentionFromJob(job);
  if (retention.mode === 'all') return `<p class="status-message warning">${escHtml(storageT('wizard.retentionAllSummary'))}</p>`;
  if (retention.mode === 'last') return `<p>${escHtml(storageT('wizard.retentionLastSummary', {count: retention.last}))}</p>`;
  const rows = ['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly'].map((period) => {
    const value = storageT(`storage.repositoryRetention${period}`, { count: retention[period.toLowerCase()] || '0' });
    const limit = storageT(`storage.repositoryRetention${period}Limit`);
    return `<tr><td>${escHtml(value)}</td><td>${escHtml(limit)}</td></tr>`;
  }).join('');
  return `${retention.within ? `<p>${escHtml(storageT('wizard.retentionWithinSummary', {count: retention.within}))}</p>` : ''}<table class="retention-table storage-maintenance-retention-table">
    <caption>${escHtml(storageT('storage.repositoryMaintenanceRetention'))}</caption>
    <thead><tr><th scope="col">${escHtml(storageT('storage.repositoryRetentionPoints'))}</th><th scope="col">${escHtml(storageT('storage.repositoryRetentionMaximum'))}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function storageMaintenancePruneDetailsHtml(repo, job) {
  if (!job) return '';
  const source = storageT('storage.repositoryMaintenanceRetentionSource', {
    job: storageJobName(repo || {}, job) || String(job.key || ''),
  });
  const filter = storageT('storage.repositoryMaintenanceArchiveFilter', {
    filter: storageArchiveFilterFromJob(job) || '-',
  });
  return `<div>${escHtml(source)}</div><div>${escHtml(filter)}</div>${storageRetentionTableHtml(job)}`;
}

function updateStorageMaintenanceRetentionPreview() {
  const pending = storageState.maintenanceConfirmation;
  if (!pending || pending.action !== 'prune') return;
  const selectedJobKey = String(document.getElementById('storage-maintenance-retention-job')?.value || pending.selectedJobKey || '').trim();
  const job = (pending.jobs || []).find((item) => String(item?.key || '') === selectedJobKey) || pending.jobs?.[0] || null;
  pending.selectedJobKey = String(job?.key || selectedJobKey || '').trim();
  const preview = document.getElementById('storage-maintenance-retention-preview');
  if (preview) preview.innerHTML = storageMaintenancePruneDetailsHtml(pending.repo || {}, job);
  const start = document.getElementById('storage-maintenance-confirm-start-btn');
  if (start) start.disabled = !job || storageRetentionFromJob(job).mode === 'all';
}

function storageName(repo) {
  const raw = String(repo?.storage_name || '').trim();
  const location = String(repo?.location || '').trim().toLowerCase();
  if (!raw || raw.toLowerCase() === location) return storageLocationLabel(location);
  if ({ local: true, usb: true, smb: true, storagebox: true }[raw.toLowerCase()]) return storageLocationLabel(raw.toLowerCase());
  return raw;
}

function storageTargetLabel(storage) {
  const name = String(storage?.display_name || storage?.storage_key || '').trim();
  const meta = String(storage?.base_path || storage?.mount_path || storage?.endpoint || storage?.identity || '').trim();
  return meta ? `${name} — ${meta}` : name;
}

function storageTargets(data) {
  const rows = Array.isArray(data?.storages) ? data.storages : [];
  return rows
    .filter((row) => String(row?.storage_key || '').trim())
    .sort((a, b) => {
      const ai = STORAGE_LOCATION_ORDER.indexOf(String(a.location || a.storage_type || '').toLowerCase());
      const bi = STORAGE_LOCATION_ORDER.indexOf(String(b.location || b.storage_type || '').toLowerCase());
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
        || String(a.display_name || '').localeCompare(String(b.display_name || ''));
    });
}

function storageRepositories(data) {
  const groups = data?.groups || {};
  return [...new Set([...STORAGE_LOCATION_ORDER, ...Object.keys(groups)])].flatMap((location) =>
    (Array.isArray(groups[location]) ? groups[location] : []).map((repo) => ({ ...repo, location }))
  );
}

/** Select registered repositories by exact storage target, including unassigned entries. */
function storageVisibleRepositories(data) {
  return storageRepositories(data).filter(repo => storageState.target === 'all' || storageTargetKey(repo) === storageState.target);
}

async function refreshStorage() {
  hideEl('storage-message');
  try {
    const [storageRes, jobsRes, maintenanceRes] = await Promise.all([
      fetch('/api/storage'),
      fetch('/api/jobs'),
      fetch('/api/storage/check/state'),
    ]);
    if (!storageRes.ok) throw new Error(`HTTP ${storageRes.status}`);
    storageState.data = await storageRes.json();
    storageState.jobs = jobsRes.ok ? (await jobsRes.json()).jobs || [] : [];
    storageState.maintenanceState = maintenanceRes.ok ? await maintenanceRes.json() : { running: false };
    storageState.loaded = true;
    renderStorage(storageState.data);
    if (storageState.selectedTab === 'archives' && storageState.selectedRepositoryKey) {
      await loadRepositoryArchives(storageState.selectedRepositoryKey, true);
    }
    if (storageState.selectedTab === 'management' && storageState.selectedRepositoryKey) {
      await loadRepositoryLifecycle(storageState.selectedRepositoryKey, true);
    }
    if (storageState.pendingRepositoryKeyImportGuide) {
      storageState.pendingRepositoryKeyImportGuide = false;
      showMsg('storage-message', 'info', storageT('storage.repositoryKeyImportGuide'));
    }
  } catch (err) {
    showMsg('storage-message', 'error', storageT('storage.errorPrefix', { message: err.message }));
  }
}

/** Render registry-backed cards, retaining the opened repository across refreshes. */
function renderStorage(data) {
  const el = document.getElementById('storage-content');
  if (!el) return;
  const focus = el.contains(document.activeElement) ? document.activeElement : null;
  const focusData = focus?.dataset?.storageAction ? { ...focus.dataset } : null;
  const visible = storageVisibleRepositories(data);
  if (!visible.some(repo => storageRepositoryKey(repo) === storageState.selectedRepositoryKey)) {
    storageState.selectedRepositoryKey = '';
    storageState.expanded = false;
  }
  if (storageState.archiveBrowser.repositoryKey !== storageState.selectedRepositoryKey) resetStorageArchiveBrowser();
  renderStorageLocationSidebar(data, storageRepositories(data));
  const groups = storageGroupRows(data, visible);
  const title = storageState.target === 'all' ? storageT('storage.allStorageTargets') : groups[0]?.target.display_name || storageT('storage.storageTargets');
  const countLabel = count => storageT(count === 1 ? 'storage.repositoryCountOne' : 'storage.repositoryCountMany', { count });
  el.innerHTML = `<div class="storage-selection-summary"><h2>${escHtml(title)}</h2><span class="storage-target-count">${escHtml(countLabel(visible.length))}</span></div>` + (visible.length
    ? groups.map(({ target, rows }) => `<section class="storage-target-group"><header class="storage-target-group-heading"><span class="type-icon">${storageLocationIcon(target.location)}</span><h2>${escHtml(target.display_name)}</h2><span class="storage-group-count">${escHtml(countLabel(rows.length))}</span><span class="storage-group-line"></span><span class="storage-target-count">${rows.length}</span></header><div class="storage-column-headings" aria-hidden="true">${['storage.columns.repository', 'storage.columns.storageTarget', 'storage.columns.linkedJobs', 'storage.columns.archiveData'].map(column => `<span>${escHtml(storageT(column))}</span>`).join('')}</div>${rows.map(renderStorageRepositoryCard).join('')}</section>`).join('')
    : `<section class="ui-panel storage-empty">${storageT('storage.noMatchingRepositories')}</section>`);

  if (focusData) Array.from(el.querySelectorAll('[data-storage-action]')).find(node => Object.entries(focusData).every(([key, value]) => node.dataset[key] === value))?.focus({ preventScroll: true });
}

/** Use the storage object's identity, with a location fallback for unassigned records. */
function storageTargetKey(repo) {
  return repo.storage_key ? `target:${repo.storage_key}` : `location:${repo.location}`;
}

/** List every linked job; an unassigned repository remains a first-class entry. */
function storageRepositoryJobsLabel(repo) {
  const jobs = storageJobsForRepository(repo);
  return jobs.length ? jobs.map(job => storageJobName(repo, job)).join(', ') : storageT('storage.repositoryNoLinkedJobs');
}

/** Describe the configured transport without claiming that its target is reachable. */
function storageRepositoryTransport(repo) {
  return { local: storageT('storage.local'), usb: 'USB', smb: 'SMB', storagebox: 'SSH', ssh: 'SSH' }[repo.location] || storageLocationLabel(repo.location);
}

/** Render four aligned repository facts and an expandable management workspace. */
function renderStorageRepositoryCard(repo) {
  const key = storageRepositoryKey(repo);
  const open = storageState.expanded && storageState.selectedRepositoryKey === key;
  const job = storageJobForRepository(repo);
  const status = storageRepositoryStatus(repo);
  const iconStatus = status && { warning: 'warning', error: 'error', info: 'running' }[status.className];
  const size = repo.repository_stats?.unique_csize;
  const count = storageRepositoryArchiveCount(repo);
  const updatedAt = repo.last_info_refresh_at;
  const label = column => `<span class="storage-card-mobile-label">${escHtml(storageT(column))}</span>`;
  const jobs = storageJobsForRepository(repo).length
    ? storageT('storage.columns.jobs', { names: storageRepositoryJobsLabel(repo) })
    : storageT('storage.columns.noJobs');
  return `<article class="storage-repository-card" data-repository-card="${escHtml(key)}">
    <div class="storage-card-summary">
      <div class="storage-card-identity">
        <button type="button" class="job-details-disclosure storage-card-toggle" data-storage-action="toggle-repository" data-repository-key="${escHtml(key)}" aria-expanded="${!!open}" aria-controls="repository-details-${escHtml(key)}" aria-label="${escHtml(storageT(open ? 'storage.hideDetails' : 'storage.showDetails'))}: ${escHtml(storageRepositoryTitle(repo, null))}"><span aria-hidden="true">${open ? '⌄' : '›'}</span></button>
        ${storageRepositoryIcon(repo, job)}<div><h2>${escHtml(storageRepositoryTitle(repo, null))}</h2><small>${escHtml(storageRepositoryName(repo))}</small>
        ${status ? `<span class="storage-card-status ${status.className}">${storageMaintenanceIcon(iconStatus)}${escHtml(status.label)}</span>` : ''}
        ${storageRepositoryNeedsExternalKeyBackup(repo) ? `<button type="button" class="storage-card-status warning storage-card-key-warning" data-storage-action="open-repository-key-export-settings">${storageMaintenanceIcon('warning')}${escHtml(storageT('storage.repositoryKeyBackupMissing'))}</button>` : ''}</div>
      </div>
      <div class="storage-card-target">${label('storage.columns.storageTarget')}${escHtml(storageName(repo))}<small>${escHtml(storageRepositoryTransport(repo))}</small></div>
      <div class="storage-card-jobs">${label('storage.columns.linkedJobs')}${escHtml(jobs)}</div>
      <div class="storage-card-size">${label('storage.columns.archiveData')}<div class="storage-card-facts"><span>${escHtml(storageT(count === 1 ? 'storage.columns.archiveOne' : 'storage.columns.archiveMany', { count: count ?? '—' }))}</span><span>${escHtml(storageT('storage.columns.diskUsed', { size: size === undefined || size === null ? '—' : storageFormatBytes(size) }))}</span></div><small>${escHtml(updatedAt ? storageT('storage.columns.asOf', { date: storageFormatDateTime(updatedAt) }) : storageT('storage.columns.dateUnknown'))}</small></div>
    </div>
    ${open ? renderStorageRepositoryWorkspace(repo, job) : ''}
  </article>`;
}

function storageRepositoryKey(repo) {
  return String(repo?.repository_key || repo?.conf_key || repo?.path_raw || '').trim();
}

function storageRepositoryArchiveCount(repo) {
  const inventory = storageState.archiveCache[storageRepositoryKey(repo)]?.data;
  const rawCount = inventory
    ? (inventory.archive_count ?? (Array.isArray(inventory.archives) ? inventory.archives.length : null))
    : repo?.repository_stats?.archives_count;
  if (rawCount === null || rawCount === undefined || rawCount === '') return null;
  const count = Number(rawCount);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** Return active work or recorded actionable outcomes; no reachability assertions. */
function storageRepositoryStatus(repo) {
  const running = storageState.maintenanceState?.running
    && String(storageState.maintenanceState?.target_key || '') === storageRepositoryKey(repo);
  if (running) return { className: 'info', label: storageT('storage.repositoryStatusRunning') };
  const results = Object.values(repo?.maintenance_results || {}).filter((row) => row && typeof row === 'object');
  const latest = results.sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')))[0];
  if (latest?.status === 'error') return { className: 'error', label: storageT('storage.repositoryLastMaintenanceFailed') };
  if (latest?.status === 'warning') return { className: 'warning', label: storageT('storage.repositoryLastMaintenanceWarning') };
  if (String(repo?.last_info_refresh_status || '').toLowerCase() === 'busy') {
    return { className: 'info', label: storageT('storage.repositoryStatusBusy') };
  }
  if (String(repo?.last_info_refresh_status || '').toLowerCase() === 'error') {
    return { className: 'warning', label: storageT('storage.repositoryLastInfoFailed') };
  }
  return null;
}

/** Reuse a consistent linked-job icon; mixed/unassigned repositories use their type. */
function storageRepositoryIcon(repo, job, large = false) {
  const linked = storageJobsForRepository(repo);
  const coherent = job && linked.every(row => row.icon === job.icon && row.icon_color === job.icon_color);
  const type = String(repo.backup_type || '').toLowerCase();
  const colors = { flash: 'blue', appdata: 'orange', photos: 'purple', vms: 'green', sonstiges: 'gray' };
  const source = coherent && job.icon ? job : { icon: repo.icon || (colors[type] ? type : 'archive'), icon_color: repo.icon_color || colors[type] || '' };
  const icon = typeof resolveJobIcon === 'function' ? resolveJobIcon(source) : 'archive';
  const color = typeof resolveJobIconColor === 'function' ? resolveJobIconColor(source) : '';
  const colorClass = color ? ` type-icon-color-${color}` : '';
  return `<span class="type-icon${colorClass}${large ? ' storage-repository-icon-large' : ''}">${typeIcon(icon)}</span>`;
}

function storageGroupRows(data, repos) {
  const targets = storageTargets(data);
  const groups = [];
  targets.forEach((target) => {
    const rows = repos.filter((repo) => String(repo.storage_key || '') === String(target.storage_key || ''));
    if (rows.length) groups.push({ target, rows });
  });
  const assigned = new Set(groups.flatMap((group) => group.rows.map((repo) => storageRepositoryKey(repo))));
  const remaining = new Map();
  repos.filter(repo => !assigned.has(storageRepositoryKey(repo))).forEach(repo => {
    const key = storageTargetKey(repo);
    if (!remaining.has(key)) remaining.set(key, { target: { display_name: storageName(repo), location: repo.location }, rows: [] });
    remaining.get(key).rows.push(repo);
  });
  groups.push(...remaining.values());
  return groups;
}

/** Render exact storage-target filters with consistently outlined repository counts. */
function renderStorageLocationSidebar(data, repos) {
  const nav = document.getElementById('storage-location-list');
  if (!nav) return;
  const groups = storageGroupRows(data, repos);
  const entries = [{ key: 'all', name: storageT('storage.allStorageTargets'), count: repos.length },
    ...groups.map(({ target, rows }) => ({ key: storageTargetKey(rows[0]), name: target.display_name, count: rows.length }))];
  nav.innerHTML = `<span class="storage-target-label">${escHtml(storageT('storage.storageTargets'))}</span>` + entries.map(entry =>
    `<button type="button" data-storage-target="${escHtml(entry.key)}" aria-pressed="${storageState.target === entry.key}">${escHtml(entry.name)}<span class="storage-target-count">${entry.count}</span></button>`).join('');
}

function onStorageLocationClick(event) {
  const button = event.target.closest('[data-storage-target]');
  if (!button || !storageState.data) return;
  storageState.target = button.dataset.storageTarget;
  renderStorage(storageState.data);
  Array.from(document.querySelectorAll('[data-storage-target]')).find(node => node.dataset.storageTarget === storageState.target)?.focus({ preventScroll: true });
}

/** Cached info timestamps and existing settings/key-backup links for an expanded card. */
function renderStorageWorkspaceHeader(repo) {
  const infoUpdatedAt = repo.last_info_refresh_at || repo.last_seen_at || '';
  const infoRefreshEnabled = storageState.data?.repository_info_refresh?.enabled !== false;
  let infoState = storageT('storage.repositoryInfoPending');
  if (!infoRefreshEnabled) {
    infoState = storageT('storage.repositoryInfoAutoRefreshDisabled');
  } else if (infoUpdatedAt) {
    infoState = storageT('storage.repositoryInfoLastUpdated', { date: storageFormatDateTime(infoUpdatedAt) });
  }
  const infoStateMarkup = infoRefreshEnabled
    ? `<small>${escHtml(infoState)}</small>`
    : `<button type="button" class="storage-repository-info-disabled" data-storage-action="open-repository-refresh-settings">${escHtml(infoState)}</button>`;
  return `<div class="storage-repository-workspace-status">${infoStateMarkup}</div>`;
}

function openRepositoryRefreshSettings() {
  if (window.BBUI?.settingsState) window.BBUI.settingsState.activeTab = 'repository';
  window.BBUI?.core?.navigate?.('settings');
  let attempts = 0;
  const activate = () => {
    attempts += 1;
    if (typeof activateSettingsTab === 'function' && document.querySelector('#settings-content [data-settings-tab="repository"]')) {
      activateSettingsTab('repository');
      document.querySelector('#settings-content [data-settings-panel="repository"]')?.scrollIntoView({ block: 'start' });
      return;
    }
    if (attempts < 12) window.setTimeout(activate, 100);
  };
  window.setTimeout(activate, 80);
}

function openRepositoryKeyExportSettings() {
  if (window.BBUI?.settingsState) window.BBUI.settingsState.activeTab = 'transfer';
  window.BBUI?.core?.navigate?.('settings');
  let attempts = 0;
  const activate = () => {
    attempts += 1;
    if (typeof activateSettingsTab === 'function' && document.querySelector('#settings-content [data-settings-tab="transfer"]')) {
      activateSettingsTab('transfer');
      document.querySelector('#settings-content [data-settings-action="export-repository-keys"]')?.scrollIntoView({ block: 'center' });
      return;
    }
    if (attempts < 12) window.setTimeout(activate, 100);
  };
  window.setTimeout(activate, 80);
}

function openRepositoryManagementTab() {
  storageState.expanded = true;
  storageState.selectedTab = 'management';
  renderStorage(storageState.data);
  loadRepositoryLifecycle(storageState.selectedRepositoryKey);
}

function storageFormatDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString(document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function storageFormatDuration(value, startedAt = '', finishedAt = '') {
  const seconds = Math.max(0, Number(value || 0));
  const started = startedAt ? new Date(startedAt) : null;
  const finished = finishedAt ? new Date(finishedAt) : null;
  if (started && finished && !Number.isNaN(started.getTime()) && !Number.isNaN(finished.getTime()) && finished < started) {
    return '—';
  }
  if (seconds === 0 && started && finished) return storageT('storage.durationLessThanSecond');
  if (seconds < 60) return storageT('storage.durationSeconds', { count: Math.round(seconds) });
  return storageT('storage.durationMinutes', { count: Math.round(seconds / 60) });
}

function storageMaintenanceResult(repo, key) {
  const value = repo?.maintenance_results?.[key];
  return value && typeof value === 'object' ? value : null;
}

function storageMaintenanceRunning(repo, key) {
  const state = storageState.maintenanceState || {};
  if (!state.running || String(state.target_key || '') !== storageRepositoryKey(repo)) return false;
  const activeKey = state.action === 'check' && state.mode === 'verify_data' ? 'verify_data' : state.action;
  return activeKey === key;
}

function storageMaintenanceTitle(key) {
  return {
    check: storageT('storage.repositoryCheck'),
    verify_data: storageT('storage.repositoryVerifyData'),
    prune: storageT('storage.repositoryPrune'),
    compact: storageT('storage.repositoryCompact'),
  }[key] || key;
}

function storageMaintenanceSummary(key, result) {
  if (!result) return storageT('storage.repositoryNotRun');
  if (result.failure_code === 'borg_ssh_connection_interrupted') {
    return storageT('storage.repositorySshInterrupted');
  }
  if (result.status === 'error') return storageT('storage.repositoryActionFailed');
  if (result.status === 'warning') return storageT('storage.repositoryActionWarning');
  if (key === 'prune') {
    return storageT('storage.repositoryPruneResult', { count: Number(result.deleted_archives_count || 0) });
  }
  if (key === 'compact') {
    return result.freed_space !== undefined && result.freed_space !== null && String(result.freed_space).trim() !== ''
      ? storageT('storage.repositoryCompactResult', { value: result.freed_space })
      : storageT('storage.repositoryCompactAmountUnknown');
  }
  return storageT('storage.repositoryCheckSuccessful');
}

function storageMaintenanceIcon(status) {
  const icons = {
    idle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
    success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.5 2.2 2.2 4.8-5.4"/>',
    warning: '<path d="M10.3 4.4a2 2 0 0 1 3.4 0l7.4 12.8a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z"/><path d="M12 8.8v4.8"/><path d="M12 17h.01"/>',
    error: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
    running: '<path class="storage-maintenance-spinner" d="M21 12a9 9 0 1 1-6.2-8.6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[status] || icons.idle}</svg>`;
}

function renderStorageMaintenanceCard(repo, key, { withAction = false, job = null } = {}) {
  const running = storageMaintenanceRunning(repo, key);
  const result = storageMaintenanceResult(repo, key);
  const status = running ? 'running' : (result?.status || 'idle');
  const repositoryKey = storageRepositoryKey(repo);
  const action = key === 'verify_data' ? 'check' : key;
  const mode = key === 'verify_data' ? 'verify_data' : 'quick';
  const disabled = storageState.maintenanceState?.running || key === 'prune' && (!job || (storageRetentionFromJob(job).mode === 'all' && !storageJobsForRepository(repo).some(j => storageRetentionFromJob(j).mode !== 'all'))) ? ' disabled' : '';
  const details = Array.isArray(result?.details) ? result.details : [];
  const deletedArchives = Array.isArray(result?.deleted_archives) ? result.deleted_archives : [];
  const userHint = result?.failure_code === 'borg_ssh_connection_interrupted'
    ? `<p class="storage-maintenance-user-hint">${escHtml(storageT('storage.repositorySshInterruptedHint'))}</p>`
    : '';
  const resultDetails = [
    key === 'prune' && deletedArchives.length
      ? `<details class="storage-maintenance-result-details"${withAction && deletedArchives.length <= 3 ? ' open' : ''}><summary>${escHtml(storageT('storage.repositoryPruneDetails', { count: deletedArchives.length }))}</summary><ul>${deletedArchives.map((archive) => `<li>${escHtml(archive)}</li>`).join('')}</ul></details>`
      : '',
    details.length
      ? `<details class="storage-maintenance-result-details ${status === 'error' ? 'status-error' : ''}"><summary>${escHtml(storageT('storage.repositoryExecutionDetails'))}</summary><pre>${escHtml(details.join('\n'))}</pre></details>`
      : '',
  ].join('');
  return `<article class="storage-maintenance-card status-${escHtml(status)}">
    <div class="storage-maintenance-title"><span class="storage-maintenance-icon">${storageMaintenanceIcon(status)}</span><small>${escHtml(storageMaintenanceTitle(key))}</small></div>
    <div class="storage-maintenance-copy">
      <strong>${escHtml(running ? storageT('storage.repositoryActionRunning') : storageMaintenanceSummary(key, result))}</strong>
      <span>${running ? storageT('storage.repositoryPleaseWait') : (result ? `${storageFormatDateTime(result.finished_at)} · ${storageFormatDuration(result.duration_seconds, result.started_at, result.finished_at)}` : storageT('storage.repositoryNoResult'))}</span>
      ${withAction && !running && result?.status === 'success' && ['check', 'verify_data'].includes(key) ? `<p class="storage-maintenance-scope">${escHtml(storageT(key === 'check' ? 'storage.repositoryCheckScope' : 'storage.repositoryVerifyScope'))}</p>` : ''}
      ${withAction && !running && result?.status === 'success' && key === 'compact' ? `<p class="storage-maintenance-scope">${escHtml(storageT('storage.repositoryCompactScope'))}</p>` : ''}
      ${!running ? userHint : ''}
      ${!running ? resultDetails : ''}
      ${withAction && !running && result && !resultDetails ? `<small>${escHtml(storageT('storage.repositoryDetailsNotRecorded'))}</small>` : ''}
    </div>
    ${withAction ? `<button class="btn btn-secondary btn-sm" data-storage-action="repository-maintenance" data-repository-key="${escHtml(repositoryKey)}" data-repository-action="${escHtml(action)}" data-check-mode="${escHtml(mode)}"${disabled}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m8 4 12 8-12 8z"/></svg>${escHtml(storageT('storage.repositoryStartAction'))}</button>` : ''}
  </article>`;
}

function renderStorageRepositoryOverview(repo, job) {
  const infoError = String(repo?.last_info_refresh_error || '').trim();
  const infoBusy = String(repo?.last_info_refresh_status || '').toLowerCase() === 'busy';
  const stats = renderRepositoryStats(repo) || `<div class="storage-repository-empty-state"><p>${storageT(infoBusy ? 'storage.repositoryInfoBusy' : 'storage.repositoryInfoMissing')}</p>${!infoBusy && infoError ? `<small>${escHtml(infoError)}</small>` : ''}<button class="btn btn-secondary btn-sm" data-storage-action="repository-info" data-repository-key="${escHtml(storageRepositoryKey(repo))}">${storageT('storage.repositoryRefreshInfo')}</button></div>`;
  return `<div class="storage-repository-overview">
    ${stats}
    <div class="storage-section-heading"><div><h3>${storageT('storage.repositoryHealth')}</h3><p>${storageT('storage.repositoryHealthHint')}</p></div><button class="btn btn-secondary btn-sm" data-storage-action="repository-info" data-repository-key="${escHtml(storageRepositoryKey(repo))}">${storageT('storage.repositoryRefreshInfo')}</button></div>
    <div class="storage-maintenance-summary-grid">
      ${renderStorageMaintenanceCard(repo, 'check')}
      ${renderStorageMaintenanceCard(repo, 'verify_data')}
      ${renderStorageMaintenanceCard(repo, 'prune', { job })}
      ${renderStorageMaintenanceCard(repo, 'compact')}
    </div>
    <div class="storage-section-heading"><div><h3>${storageT('storage.repositoryDetails')}</h3><p>${storageT('storage.repositoryDetailsHint')}</p></div></div>
    ${renderStorageWorkspaceHeader(repo)}
    <div class="storage-repository-detail-grid storage-repository-facts">
      ${storageDetailItem('storage.repositoryDisplayNameLabel', storageRepositoryTitle(repo, job))}
      ${storageDetailItem('storage.repositoryDirectoryLabel', storageRepositoryName(repo))}
      ${storageDetailItem('storage.storageNameLabel', storageName(repo))}
      ${storageDetailItem('storage.repositoryLinkedJobs', storageRepositoryJobsLabel(repo))}
      ${storageDetailItem('storage.repositoryEncryption', storageRepositoryEncryption(repo, job))}
      ${storageDetailItem('storage.repositoryPathLabel', repo.path_display || repo.path_raw || '', 'span-3')}
    </div>
  </div>`;
}

/** Render paged archives beside a reserved browser pane, retaining navigation geometry. */
function renderStorageRepositoryArchives(repo) {
  const key = storageRepositoryKey(repo);
  const cache = storageState.archiveCache[key];
  if (!cache || cache.loading) return `<div class="storage-repository-loading"><div class="spinner"></div><span>${storageT('storage.repositoryArchivesLoading')}</span></div>`;
  if (cache.error) return `<div class="status-message error">${escHtml(cache.error)}</div>`;
  const archives = Array.isArray(cache.data?.archives) ? cache.data.archives : [];
  if (!archives.length) return `<div class="storage-repository-empty-state"><p>${storageT('storage.repositoryNoArchives')}</p></div>`;
  const browser = storageState.archiveBrowser.repositoryKey === key ? storageState.archiveBrowser : null;
  const page = Math.max(0, Math.min(Number(storageState.archivePages[key] || 0), Math.ceil(archives.length / 5) - 1));
  storageState.archivePages[key] = page;
  const pageRows = archives.slice(page * 5, page * 5 + 5);
  const canDelete = cache.data.can_delete === true && !!cache.data.repository_id;
  return `<div class="storage-archive-toolbar"><strong>${storageCount(storageRepositoryArchiveCount(repo) ?? archives.length, 'storage.archiveCountOne', 'storage.archiveCountMany')}</strong><button class="btn btn-secondary btn-sm" data-storage-action="refresh-repository-archives" data-repository-key="${escHtml(key)}">${storageT('storage.refresh')}</button></div>
    <p class="storage-archive-intro">${escHtml(storageT('storage.repositoryArchiveBrowseHint'))}</p>
    <div class="storage-archive-layout ${browser?.archive ? 'has-browser' : ''}">
      <div class="storage-archive-list ${canDelete ? 'can-delete' : ''}"><header><span></span><strong>${storageT('storage.repositoryArchiveName')}</strong><strong>${storageT('storage.repositoryArchiveCreated')}</strong><span></span></header>${pageRows.map((archive) => {
        const name = String(archive.name || '');
        const selected = !!browser && name === browser.archive;
        return `<div class="storage-archive-entry"><button type="button" class="storage-archive-row ${selected ? 'is-selected' : ''}" data-storage-action="open-repository-archive" data-repository-key="${escHtml(key)}" data-archive="${escHtml(name)}" ${selected ? 'aria-current="true"' : ''}><span class="storage-archive-dot"></span><span><strong>${escHtml(name || '—')}</strong></span><time>${escHtml(storageFormatDateTime(archive.start))}</time><span class="storage-archive-open" aria-hidden="true">›</span></button>${canDelete && archive.id ? `<button type="button" class="storage-archive-delete" data-storage-action="delete-repository-archive" data-repository-key="${escHtml(key)}" data-archive="${escHtml(name)}" title="${escHtml(storageT('storage.archiveDelete'))}" aria-label="${escHtml(storageT('storage.archiveDeleteLabel', { name }))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button>` : ''}</div>`;
      }).join('')}</div>
      ${browser?.archive ? renderStorageArchiveBrowser(browser) : `<section class="storage-archive-browser storage-archive-browser-placeholder"><div class="storage-archive-browser-state">${escHtml(storageT('storage.repositoryArchiveBrowseHint'))}</div></section>`}
    </div>
    <div class="storage-archive-pagination"><button type="button" class="btn btn-secondary btn-sm" data-storage-action="archive-page" data-page="${page - 1}"${page === 0 ? ' disabled' : ''}>${escHtml(storageT('storage.previousPage'))}</button><span>${escHtml(storageT('storage.archivePage', { start: page * 5 + 1, end: Math.min(archives.length, page * 5 + 5), count: archives.length }))}</span><button type="button" class="btn btn-secondary btn-sm" data-storage-action="archive-page" data-page="${page + 1}"${(page + 1) * 5 >= archives.length ? ' disabled' : ''}>${escHtml(storageT('storage.nextPage'))}</button></div>
    ${storageRepositoryArchiveCount(repo) > archives.length ? `<small>${escHtml(storageT('storage.archiveListLimited', { count: archives.length, total: storageRepositoryArchiveCount(repo) }))}</small>` : ''}`;
}

function openRepositoryArchiveDelete(repositoryKey, name, trigger) {
  const cache = storageState.archiveCache[repositoryKey]?.data;
  const archive = cache?.archives?.find(row => row.name === name);
  if (!cache?.can_delete || !cache.repository_id || !archive?.id || storageState.archiveDeleteConfirmation?.running) return;
  const repo = storageRepositories(storageState.data).find(row => storageRepositoryKey(row) === repositoryKey);
  if (!repo) return;
  const modal = document.getElementById('repository-archive-delete-modal');
  if (!modal) return;
  storageState.archiveDeleteConfirmation = {
    repositoryKey, repositoryId: cache.repository_id, archive: { ...archive }, trigger, running: false,
  };
  document.getElementById('repository-archive-delete-info').innerHTML = `<dl class="storage-archive-delete-details">
    <div><dt>${escHtml(storageT('storage.repository'))}</dt><dd><strong>${escHtml(storageRepositoryTitle(repo, storageJobForRepository(repo)))}</strong></dd></div>
    <div><dt>${escHtml(storageT('storage.repositoryPathLabel'))}</dt><dd class="storage-archive-delete-path">${escHtml(repo.path_display || repo.path_raw || '')}</dd></div>
    <div><dt>${escHtml(storageT('storage.repositoryArchiveName'))}</dt><dd><strong>${escHtml(archive.name)}</strong></dd></div>
    <div><dt>${escHtml(storageT('storage.repositoryArchiveCreated'))}</dt><dd>${escHtml(storageFormatDateTime(archive.start))}</dd></div>
  </dl>`;
  hideEl('repository-archive-delete-message');
  document.getElementById('repository-archive-delete-phrase-input').value = '';
  updateRepositoryArchiveDeleteConfirmation();
  modal.classList.remove('hidden');
  document.getElementById('repository-archive-delete-cancel-btn')?.focus();
}

function updateRepositoryArchiveDeleteConfirmation() {
  const pending = storageState.archiveDeleteConfirmation;
  const phrase = document.getElementById('repository-archive-delete-phrase-input')?.value;
  const button = document.getElementById('repository-archive-delete-confirm-btn');
  if (button) button.disabled = !pending || pending.running || phrase !== 'DELETE';
}

function closeRepositoryArchiveDelete() {
  const pending = storageState.archiveDeleteConfirmation;
  if (pending?.running) return;
  document.getElementById('repository-archive-delete-modal')?.classList.add('hidden');
  storageState.archiveDeleteConfirmation = null;
  document.getElementById('repository-archive-delete-phrase-input').value = '';
  updateRepositoryArchiveDeleteConfirmation();
  if (pending?.trigger?.isConnected) pending.trigger.focus();
  else document.querySelector('[data-storage-action="refresh-repository-archives"]')?.focus();
}

async function confirmRepositoryArchiveDelete() {
  const pending = storageState.archiveDeleteConfirmation;
  const phrase = document.getElementById('repository-archive-delete-phrase-input')?.value;
  if (!pending || pending.running || phrase !== 'DELETE') return;
  const modal = document.getElementById('repository-archive-delete-modal');
  pending.running = true;
  modal?.setAttribute('aria-busy', 'true');
  modal?.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
  showMsg('repository-archive-delete-message', 'info', storageT('storage.archiveDeleting'));
  try {
    const response = await fetch('/api/repositories/archive', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository_key: pending.repositoryKey,
        archive: pending.archive.name,
        expected_archive_id: pending.archive.id,
        expected_repository_id: pending.repositoryId,
        confirmed: true,
        confirmation_phrase: phrase,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(result, response.status));
    pending.running = false;
    closeRepositoryArchiveDelete();
    if (storageState.archiveBrowser.repositoryKey === pending.repositoryKey) resetStorageArchiveBrowser();
    delete storageState.lifecycleCache[pending.repositoryKey];
    delete storageState.archiveCache[pending.repositoryKey];
    // Browse & Restore reloads the archive inventory on entry. Clear any previous
    // selection now as well, so deleted files cannot remain selected there.
    if (typeof restoreClearArchives === 'function') restoreClearArchives();
    await refreshStorage();
    await loadRepositoryArchives(pending.repositoryKey);
    showMsg('storage-message', result.refresh_warning ? 'warning' : 'success',
      storageT(result.refresh_warning ? 'storage.archiveDeletedRefreshWarning' : 'storage.archiveDeleted'));
  } catch (error) {
    showMsg('repository-archive-delete-message', 'error', error.message || storageT('storage.error'));
  } finally {
    pending.running = false;
    modal?.removeAttribute('aria-busy');
    modal?.querySelectorAll('button, input').forEach(control => { control.disabled = false; });
    updateRepositoryArchiveDeleteConfirmation();
  }
}

function resetStorageArchiveBrowser() {
  storageState.archiveBrowser = { repositoryKey: '', archive: '', path: '', files: [], loading: false, error: '' };
}

function storageArchiveBrowserBreadcrumb(browser) {
  const parts = String(browser.path || '').split('/').filter(Boolean);
  const buttons = [`<button type="button" data-storage-action="browse-repository-archive-path" data-path="">/</button>`];
  for (let index = 0; index < parts.length; index += 1) {
    const path = parts.slice(0, index + 1).join('/');
    const current = index === parts.length - 1;
    buttons.push(current
      ? `<span aria-current="location">${escHtml(parts[index])}</span>`
      : `<button type="button" data-storage-action="browse-repository-archive-path" data-path="${escHtml(path)}">${escHtml(parts[index])}</button>`);
  }
  return buttons.join('<i aria-hidden="true">/</i>');
}

function storageArchiveEntryIcon(type) {
  if (type === 'd') return '📁';
  if (type === 'l') return '🔗';
  return '📄';
}

function renderStorageArchiveBrowser(browser) {
  let content = '';
  if (browser.loading) {
    content = `<div class="storage-archive-browser-state"><div class="spinner"></div><span>${escHtml(storageT('storage.repositoryArchiveBrowserLoading'))}</span><small>${escHtml(storageT('storage.repositoryArchiveBrowserFirstLoad'))}</small></div>`;
  } else if (browser.error) {
    content = `<div class="status-message error">${escHtml(browser.error)}</div>`;
  } else if (!browser.files.length) {
    content = `<div class="storage-archive-browser-state"><span>${escHtml(storageT('storage.repositoryArchiveBrowserEmpty'))}</span></div>`;
  } else {
    content = `<div class="storage-archive-browser-table-viewport"><div class="storage-archive-browser-table" role="table"><div class="storage-archive-browser-table-header" role="row"><span role="columnheader">${escHtml(storageT('storage.repositoryArchiveBrowserName'))}</span><span role="columnheader">${escHtml(storageT('storage.repositoryArchiveBrowserSize'))}</span><span role="columnheader">${escHtml(storageT('storage.repositoryArchiveBrowserModified'))}</span></div><div class="storage-archive-browser-table-wrap" role="rowgroup">${browser.files.map((file) => {
      const type = String(file.type || '-');
      const name = String(file.name || '');
      const label = `${storageArchiveEntryIcon(type)} ${escHtml(name)}`;
      const nameCell = type === 'd'
        ? `<button type="button" data-storage-action="browse-repository-archive-path" data-path="${escHtml(file.path || '')}">${label}</button>`
        : `<span>${label}</span>`;
      return `<div class="storage-archive-browser-table-row" role="row"><div role="cell">${nameCell}</div><div role="cell">${type === 'd' ? '—' : escHtml(storageFormatBytes(file.size))}</div><div role="cell">${escHtml(storageFormatDateTime(file.mtime))}</div></div>`;
    }).join('')}</div></div></div>`;
  }
  return `<section class="storage-archive-browser" aria-label="${escHtml(storageT('storage.repositoryArchiveBrowserTitle'))}">
    <header><div><small>${escHtml(storageT('storage.repositoryArchiveBrowserReadOnly'))}</small><h3>${escHtml(browser.archive)}</h3></div><button type="button" class="storage-archive-browser-close" data-storage-action="close-repository-archive" aria-label="${escHtml(storageT('storage.repositoryArchiveBrowserClose'))}">×</button></header>
    <nav class="storage-archive-browser-breadcrumb" aria-label="${escHtml(storageT('storage.repositoryArchiveBrowserPath'))}">${storageArchiveBrowserBreadcrumb(browser)}</nav>
    ${content}
  </section>`;
}

async function loadRepositoryArchiveFiles(repositoryKey, archive, path = '') {
  const key = String(repositoryKey || '').trim();
  const archiveName = String(archive || '');
  const archivePath = String(path || '');
  if (!key || !archiveName) return;
  storageState.archiveBrowser = {
    repositoryKey: key,
    archive: archiveName,
    path: archivePath,
    files: [],
    loading: true,
    error: '',
  };
  if (storageState.data && storageState.selectedRepositoryKey === key) renderStorage(storageState.data);
  try {
    const query = new URLSearchParams({ repository_key: key, archive: archiveName, path: archivePath });
    const response = await fetch(`/api/repositories/archive-files?${query.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
    const current = storageState.archiveBrowser;
    if (current.repositoryKey !== key || current.archive !== archiveName || current.path !== archivePath) return;
    storageState.archiveBrowser = { ...current, files: Array.isArray(data.files) ? data.files : [], loading: false, error: '' };
  } catch (error) {
    const current = storageState.archiveBrowser;
    if (current.repositoryKey !== key || current.archive !== archiveName || current.path !== archivePath) return;
    storageState.archiveBrowser = { ...current, files: [], loading: false, error: error.message || storageT('storage.error') };
  }
  if (storageState.data && storageState.selectedRepositoryKey === key && storageState.selectedTab === 'archives') renderStorage(storageState.data);
}

function renderStorageRepositoryMaintenance(repo, job) {
  return `<div class="storage-maintenance-page">
    <div class="storage-section-heading"><div><h3>${storageT('storage.repositoryMaintenance')}</h3><p>${storageT('storage.repositoryMaintenanceHint')}</p></div></div>
    <div class="storage-maintenance-action-grid">
      ${renderStorageMaintenanceCard(repo, 'check', { withAction: true, job })}
      ${renderStorageMaintenanceCard(repo, 'verify_data', { withAction: true, job })}
      ${renderStorageMaintenanceCard(repo, 'prune', { withAction: true, job })}
      ${renderStorageMaintenanceCard(repo, 'compact', { withAction: true, job })}
    </div>
  </div>`;
}

function storageLifecycleJobLabel(jobKey) {
  const job = (storageState.jobs || []).find((row) => String(row.key || '') === String(jobKey || ''));
  return String(job?.display_name || job?.name || jobKey || '').trim();
}

function renderStorageRepositoryManagement(repo) {
  const key = storageRepositoryKey(repo);
  const state = storageState.lifecycleCache[key];
  if (!state || state.loading) {
    return `<div class="storage-repository-loading"><div class="spinner"></div><span>${storageT('storage.repositoryManagementLoading')}</span></div>`;
  }
  if (state.error) {
    return `<div class="status-message error">${escHtml(state.error)}</div><button class="btn btn-secondary btn-sm" data-storage-action="refresh-repository-lifecycle" data-repository-key="${escHtml(key)}">${storageT('storage.refresh')}</button>`;
  }
  const jobs = Array.isArray(state.job_keys) ? state.job_keys : [];
  const blockers = Array.isArray(state.blockers) ? state.blockers : [];
  const blocked = !state.allowed;
  const keyActionBlocked = blockers.some((item) => String(item || '') !== 'jobs_linked');
  const jobList = jobs.length
    ? `<div class="storage-lifecycle-jobs"><strong>${storageT('storage.repositoryLinkedJobs')}</strong><div>${jobs.map((jobKey) => `<span>${escHtml(storageLifecycleJobLabel(jobKey))}</span>`).join('')}</div></div>`
    : `<div class="status-message success">${storageT('storage.repositoryNoLinkedJobs')}</div>`;
  const blockerText = blockers.length
    ? `<p class="storage-lifecycle-blocker">${escHtml(storageT('storage.repositoryLifecycleBlocked'))}</p>`
    : '';
  const keyRecoverySupported = storageRepositoryKeyRecoverySupported(repo);
  const keyExportedAt = String(repo?.borg_key_exported_at || '').trim();
  const keyImportedAt = String(repo?.borg_key_imported_at || '').trim();
  const keyRepositoryId = String(repo?.borg_key_repository_id || repo?.borg_repository_id || state.repository_id || '').trim();
  const keyStatus = keyRecoverySupported
    ? `<dl><div><dt>${storageT('storage.repositoryKeyRecoveryRepositoryId')}</dt><dd>${escHtml(keyRepositoryId || '—')}</dd></div><div><dt>${storageT('storage.repositoryKeyRecoveryLastExport')}</dt><dd>${escHtml(keyExportedAt ? storageFormatDateTime(keyExportedAt) : storageT('storage.repositoryKeyRecoveryNeverExported'))}</dd></div><div><dt>${storageT('storage.repositoryKeyRecoveryLastImport')}</dt><dd>${escHtml(keyImportedAt ? storageFormatDateTime(keyImportedAt) : storageT('storage.repositoryKeyRecoveryNeverImported'))}</dd></div></dl>`
    : `<p class="storage-lifecycle-blocker">${escHtml(storageT('storage.repositoryKeyRecoveryUnsupported'))}</p>`;
  return `<div class="storage-repository-management">
    <div class="storage-section-heading"><div><h3>${storageT('storage.repositoryManagement')}</h3><p>${storageT('storage.repositoryManagementHint')}</p></div><button class="btn btn-secondary btn-sm" data-storage-action="refresh-repository-lifecycle" data-repository-key="${escHtml(key)}">${storageT('storage.refresh')}</button></div>
    ${jobList}
    ${blockerText}
    <section class="storage-lifecycle-card">
      <div><h4>${storageT('storage.repositoryKeyRecovery')}</h4><p>${storageT('storage.repositoryKeyRecoveryHint')}</p></div>
      ${keyStatus}
      <div class="storage-lifecycle-actions">
        <button class="btn btn-primary" data-storage-action="repository-key-import-select" data-repository-key="${escHtml(key)}"${(!keyRecoverySupported || keyActionBlocked) ? ' disabled' : ''}>${storageT('storage.repositoryKeyImportUpload')}</button>
        <input type="file" class="hidden" data-storage-key-import-file data-repository-key="${escHtml(key)}" accept=".keys.enc,application/octet-stream">
      </div>
    </section>
    <section class="storage-lifecycle-card">
      <div><h4>${storageT('storage.repositoryRemoveFromUi')}</h4><p>${storageT('storage.repositoryRemoveFromUiHint')}</p></div>
      <button class="btn btn-secondary" data-storage-action="repository-lifecycle" data-lifecycle-mode="remove" data-repository-key="${escHtml(key)}"${blocked ? ' disabled' : ''}>${storageT('storage.repositoryRemoveFromUi')}</button>
    </section>
    <section class="storage-lifecycle-card danger">
      <div><h4>${storageT('storage.repositoryDangerZone')}</h4><p>${storageT('storage.repositoryDeletePermanentHint')}</p></div>
      <dl><div><dt>${storageT('storage.repositoryPathLabel')}</dt><dd>${escHtml(state.repository_path || repo.path_display || repo.path_raw || '')}</dd></div><div><dt>${storageT('storage.repositoryArchiveCount')}</dt><dd>${Number(state.archive_count || 0)}</dd></div><div><dt>${storageT('storage.repositoryDeduplicatedSize')}</dt><dd>${storageFormatBytes(state.deduplicated_size)}</dd></div></dl>
      <button class="btn-danger" data-storage-action="repository-lifecycle" data-lifecycle-mode="delete" data-repository-key="${escHtml(key)}"${blocked ? ' disabled' : ''}>${storageT('storage.repositoryDeletePermanent')}</button>
    </section>
  </div>`;
}

/** Share intrinsic content height across tabs; inactive panels stay inert and invisible. */
function renderStorageRepositoryWorkspace(repo, job) {
  const selected = ['overview', 'archives', 'maintenance', 'management'].includes(storageState.selectedTab)
    ? storageState.selectedTab
    : 'overview';
  storageState.selectedTab = selected;
  const archiveCount = storageRepositoryArchiveCount(repo);
  const tabs = [
    ['overview', storageT('storage.repositoryTabOverview')],
    ['archives', `${storageT('storage.repositoryTabArchives')} ${archiveCount !== null ? `<b>${archiveCount}</b>` : ''}`],
    ['maintenance', storageT('storage.repositoryTabMaintenance')],
    ['management', storageT('storage.repositoryTabManagement')],
  ];
  const content = {
    overview: renderStorageRepositoryOverview(repo, job),
    archives: renderStorageRepositoryArchives(repo),
    maintenance: renderStorageRepositoryMaintenance(repo, job),
    management: renderStorageRepositoryManagement(repo),
  };
  return `<section class="storage-repository-master-detail" id="repository-details-${escHtml(storageRepositoryKey(repo))}">
    <nav class="storage-repository-tabs" aria-label="${escHtml(storageT('storage.repository'))}">${tabs.map(([key, label]) => `<button type="button" class="${selected === key ? 'is-active' : ''}" aria-pressed="${selected === key}" data-storage-action="select-repository-tab" data-repository-tab="${key}">${label}</button>`).join('')}</nav>
    <div class="storage-repository-panels">${tabs.map(([key]) => `<div class="storage-repository-tab-content ${key === selected ? 'is-active' : ''}" data-repository-panel="${key}" ${key === selected ? '' : 'inert aria-hidden="true"'}>${content[key]}</div>`).join('')}</div>
  </section>`;
}

async function loadRepositoryArchives(repositoryKey, force = false) {
  const key = String(repositoryKey || '').trim();
  const previous = storageState.archiveCache[key];
  if (!key || (!force && (previous?.loading || (previous?.data && !previous.error)))) return;
  const request = { loading: true, data: previous?.data };
  storageState.archiveCache[key] = request;
  if (storageState.data && storageState.selectedRepositoryKey === key) renderStorage(storageState.data);
  try {
    const response = await fetch(`/api/repositories/archives?repository_key=${encodeURIComponent(key)}&limit=100`);
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
    if (storageState.archiveCache[key] !== request) return;
    storageState.archiveCache[key] = { loading: false, data };
  } catch (error) {
    if (storageState.archiveCache[key] !== request) return;
    storageState.archiveCache[key] = { loading: false, data: previous?.data, error: error.message || storageT('storage.error') };
  }
  if (storageState.data && storageState.selectedRepositoryKey === key) renderStorage(storageState.data);
}

async function loadRepositoryLifecycle(repositoryKey, force = false) {
  const key = String(repositoryKey || '').trim();
  if (!key || (!force && storageState.lifecycleCache[key])) return;
  storageState.lifecycleCache[key] = { loading: true };
  if (storageState.data && storageState.selectedRepositoryKey === key) renderStorage(storageState.data);
  try {
    const response = await fetch('/api/repositories/lifecycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_key: key, mode: 'remove' }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
    storageState.lifecycleCache[key] = { loading: false, ...data };
  } catch (error) {
    storageState.lifecycleCache[key] = { loading: false, error: error.message || storageT('storage.error') };
  }
  if (storageState.data && storageState.selectedRepositoryKey === key) renderStorage(storageState.data);
}

function storageDetailValue(value) {
  const text = String(value || '').trim();
  return text ? escHtml(text) : '—';
}

function storageDetailItem(labelKey, value, extraClass = '') {
  return `<div class="storage-repository-detail-item ${extraClass}">
    <span>${escHtml(storageT(labelKey))}</span>
    <strong>${storageDetailValue(value)}</strong>
  </div>`;
}

function storageFormatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function renderRepositoryStats(repo) {
  const stats = repo?.repository_stats && typeof repo.repository_stats === 'object' ? repo.repository_stats : {};
  if (!Object.keys(stats).length) return '';
  const total = Number(stats.total_size || 0);
  const unique = Number(stats.unique_csize || 0);
  const saving = total > 0 ? `${Math.max(0, (1 - (unique / total)) * 100).toFixed(0)}%` : '—';
  return `<div class="storage-repository-stats">
    ${storageDetailItem('storage.repositoryTotalSize', storageFormatBytes(total))}
    ${storageDetailItem('storage.repositoryCompressedSize', storageFormatBytes(stats.total_csize))}
    ${storageDetailItem('storage.repositoryDeduplicatedSize', storageFormatBytes(unique))}
    ${storageDetailItem('storage.repositorySaving', saving)}
    ${storageDetailItem('storage.repositoryArchiveCount', String(storageRepositoryArchiveCount(repo) ?? '—'))}
  </div>`;
}

function storageRepositoryEncryption(repo, job) {
  return String(repo?.encryption || job?.encryption || '').trim() || storageT('storage.unknown');
}

function storageRepositoryKeyRecoverySupported(repo) {
  const mode = String(repo?.encryption || '').trim().toLowerCase();
  return !!mode && mode !== 'none' && mode !== 'unknown';
}

function storageRepositoryNeedsExternalKeyBackup(repo) {
  const mode = String(repo?.encryption || '').trim().toLowerCase();
  if (!(mode.startsWith('repokey') || mode.startsWith('authenticated'))) return false;
  return !String(repo?.borg_key_exported_at || '').trim();
}

function storageJobForRepository(repo) {
  return storageJobsForRepository(repo)[0] || null;
}

function onStorageContentClick(event) {
  const el = event.target.closest('[data-storage-action]');
  if (!el) return;
  const action = el.dataset.storageAction || '';
  if (action === 'open-repository-refresh-settings') return openRepositoryRefreshSettings();
  if (action === 'open-repository-key-export-settings') return openRepositoryKeyExportSettings();
  if (action === 'toggle-repository') {
    const key = el.dataset.repositoryKey;
    const same = key === storageState.selectedRepositoryKey;
    storageState.expanded = same ? !storageState.expanded : true;
    storageState.selectedRepositoryKey = key;
    if (!same) storageState.selectedTab = 'overview';
    renderStorage(storageState.data);
    if (storageState.expanded && storageState.selectedTab === 'archives') loadRepositoryArchives(key);
    if (storageState.expanded) loadRepositoryLifecycle(key);
    return;
  }
  if (action === 'archive-page') {
    storageState.archivePages[storageState.selectedRepositoryKey] = Number(el.dataset.page || 0);
    renderStorage(storageState.data);
    return;
  }

  if (action === 'open-repository-manager') {
    return openRepositoryManager();
  }
  if (action === 'repository-maintenance') {
    return checkRun(
      el.dataset.repositoryKey || '',
      el.dataset.repositoryAction || 'check',
      el.dataset.checkMode || 'quick',
    );
  }
  if (action === 'repository-info') {
    return refreshRepositoryInfo(el.dataset.repositoryKey || '', el);
  }
  if (action === 'select-repository-tab') {
    storageState.selectedTab = el.dataset.repositoryTab || 'overview';
    const workspace = el.closest('.storage-repository-master-detail');
    workspace.querySelectorAll('[data-repository-tab]').forEach(button => {
      const active = button.dataset.repositoryTab === storageState.selectedTab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    workspace.querySelectorAll('[data-repository-panel]').forEach(panel => {
      const active = panel.dataset.repositoryPanel === storageState.selectedTab;
      panel.classList.toggle('is-active', active);
      panel.inert = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    if (storageState.selectedTab === 'archives') loadRepositoryArchives(storageState.selectedRepositoryKey);
    if (storageState.selectedTab === 'management') loadRepositoryLifecycle(storageState.selectedRepositoryKey);
  }
  if (action === 'refresh-repository-archives') {
    resetStorageArchiveBrowser();
    return loadRepositoryArchives(el.dataset.repositoryKey || storageState.selectedRepositoryKey, true);
  }
  if (action === 'delete-repository-archive') {
    return openRepositoryArchiveDelete(el.dataset.repositoryKey, el.dataset.archive, el);
  }
  if (action === 'open-repository-archive') {
    return loadRepositoryArchiveFiles(
      el.dataset.repositoryKey || storageState.selectedRepositoryKey,
      el.dataset.archive || '',
      '',
    );
  }
  if (action === 'browse-repository-archive-path') {
    const browser = storageState.archiveBrowser;
    return loadRepositoryArchiveFiles(browser.repositoryKey, browser.archive, el.dataset.path || '');
  }
  if (action === 'close-repository-archive') {
    resetStorageArchiveBrowser();
    renderStorage(storageState.data);
    return;
  }
  if (action === 'refresh-repository-lifecycle') {
    return loadRepositoryLifecycle(el.dataset.repositoryKey || storageState.selectedRepositoryKey, true);
  }
  if (action === 'repository-lifecycle') {
    return openRepositoryLifecycle(
      el.dataset.repositoryKey || storageState.selectedRepositoryKey,
      el.dataset.lifecycleMode || 'remove',
    );
  }
  if (action === 'repository-key-import-select') {
    const key = el.dataset.repositoryKey || storageState.selectedRepositoryKey;
    const input = Array.from(document.querySelectorAll('[data-storage-key-import-file]'))
      .find((node) => String(node.dataset.repositoryKey || '') === String(key || ''));
    if (input) input.click();
  }
}

function onStorageContentChange(event) {
  const input = event.target.closest('[data-storage-key-import-file]');
  if (!input) return;
  const key = input.dataset.repositoryKey || storageState.selectedRepositoryKey;
  const file = input.files && input.files[0] ? input.files[0] : null;
  importRepositoryKey(key, file, input);
}

async function storageReadFileAsBase64(file) {
  if (!file) throw new Error(storageT('storage.repositoryKeyImportFileMissing'));
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function storageRepositoryKeyWizardHeader(step, title, text) {
  const stepper = typeof renderSettingsTransferStepper === 'function'
    ? renderSettingsTransferStepper(step, 3)
    : '';
  return `<div class="settings-transfer-step-header">
    <div class="settings-transfer-step-top">
      <span>${escHtml(storageT('storage.repositoryKeyImportStep', { step, total: 3 }))}</span>
      ${stepper}
    </div>
    <strong>${escHtml(title)}</strong>
    <small>${escHtml(text)}</small>
  </div>`;
}

function storageRepositoryKeyFileSummary(file, preview = null) {
  return `<div class="settings-transfer-wizard-summary">
    <strong>${escHtml(file?.name || storageT('storage.repositoryKeyBackupFile'))}</strong>
    <span>${escHtml(preview?.repository_id ? storageT('storage.repositoryKeyBackupFound', { count: 1 }) : storageT('storage.repositoryKeyBackupEncrypted'))}</span>
  </div>`;
}

async function importRepositoryKey(repositoryKey, file, input) {
  const key = String(repositoryKey || '').trim();
  if (!key) return;
  showMsg('storage-message', 'info', storageT('storage.repositoryKeyImportReading'));
  try {
    const payload_b64 = await storageReadFileAsBase64(file);
    const password = await _openSettingsDialog({
      title: storageT('storage.repositoryKeyBackupPasswordTitle'),
      dialogClass: 'modal-transfer-wizard',
      html: `
        ${storageRepositoryKeyWizardHeader(1, storageT('storage.repositoryKeyBackupSelectTitle'), storageT('storage.repositoryKeyBackupSelectText'))}
        ${storageRepositoryKeyFileSummary(file)}
        <div class="settings-transfer-info-box settings-transfer-info-box-warning">
          <strong>${escHtml(storageT('storage.repositoryKeyBackupEmergencyTitle'))}</strong>
          <span>${escHtml(storageT('storage.repositoryKeyBackupPasswordMessage'))}</span>
        </div>
      `,
      input: { label: storageT('storage.repositoryKeyBackupPassword'), type: 'password', value: '', validate: (v) => String(v || '').length >= 1 },
      confirmText: storageT('storage.repositoryKeyBackupCheck'),
    });
    if (!password) return;
    const previewResponse = await fetch('/api/repositories/key-backup-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_key: key, password, payload_b64 }),
    });
    const preview = await previewResponse.json();
    if (!previewResponse.ok) throw new Error(apiErrorMessage(preview, previewResponse.status));
    const confirmed = await _openSettingsDialog({
      title: storageT('storage.repositoryKeyBackupReviewTitle'),
      dialogClass: 'modal-transfer-wizard',
      html: `
        ${storageRepositoryKeyWizardHeader(3, storageT('storage.repositoryKeyBackupConfirmTitle'), storageT('storage.repositoryKeyBackupConfirmText'))}
        ${storageRepositoryKeyFileSummary(file, preview)}
        <div class="settings-transfer-review-stats settings-transfer-review-stats-key">
          <div class="settings-transfer-stat-card state-info"><span>${escHtml(storageT('storage.repository'))}</span><strong>${escHtml(preview.repository_name || key)}</strong><small>${escHtml(preview.repository_path || '')}</small></div>
          <div class="settings-transfer-stat-card settings-transfer-stat-card-key-id state-success"><span>${escHtml(storageT('storage.repositoryKeyIdCheck'))}</span><strong>OK</strong><small>${escHtml(preview.repository_id || '')}</small></div>
          <div class="settings-transfer-stat-card state-warning"><span>${escHtml(storageT('storage.repositoryKeyAction'))}</span><strong>${escHtml(storageT('storage.repositoryKeyActionReplace'))}</strong><small>${escHtml(storageT('storage.repositoryKeyActionReplaceHint'))}</small></div>
        </div>
        <div class="settings-transfer-info-box settings-transfer-info-box-warning">
          <strong>${escHtml(storageT('storage.repositoryKeyBackupEmergencyTitle'))}</strong>
          <span>${escHtml(storageT('storage.repositoryKeyBackupReviewMessage'))}</span>
        </div>
        <div class="settings-transfer-plan-list">
          <div class="settings-transfer-plan-row">
            <header><span><strong>${escHtml(storageT('storage.repositoryKeyPlannedChange'))}</strong><small>${escHtml(storageT('storage.repositoryKeyPlannedChangeText', { id: preview.repository_id || '', name: preview.repository_name || key }))}</small></span><em>${escHtml(storageT('storage.repositoryKeyBackupImportConfirm'))}</em></header>
          </div>
        </div>
        <label class="settings-transfer-confirm-check">
          <input type="checkbox" data-storage-key-import-confirm>
          <span>${escHtml(storageT('storage.repositoryKeyImportAck'))}</span>
        </label>`,
      confirmText: storageT('storage.repositoryKeyBackupImportConfirm'),
      onOpen: ({ modal, okBtn, addCleanup }) => {
        const cb = modal.querySelector('[data-storage-key-import-confirm]');
        const update = () => { okBtn.disabled = !cb?.checked; };
        if (cb) {
          cb.addEventListener('change', update);
          addCleanup(() => cb.removeEventListener('change', update));
        }
        update();
      },
    });
    if (!confirmed) return;
    const response = await fetch('/api/repositories/key-backup-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_key: key, password, payload_b64 }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
    await refreshStorage();
    showMsg('storage-message', 'success', storageT('storage.repositoryKeyImported'));
  } catch (error) {
    showMsg('storage-message', 'error', error.message || storageT('storage.error'));
  } finally {
    if (input) input.value = '';
  }
}

async function refreshRepositoryInfo(repositoryKey, button) {
  if (!repositoryKey) return;
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/repositories/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_key: repositoryKey }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data?.code === 'repository_busy') {
        await refreshStorage();
        showMsg('storage-message', 'warning', storageT('storage.repositoryInfoBusy'));
        return;
      }
      throw new Error(apiErrorMessage(data, response.status));
    }
    delete storageState.archiveCache[repositoryKey];
    await refreshStorage();
    showMsg('storage-message', 'success', storageT('storage.repositoryInfoUpdated'));
  } catch (error) {
    showMsg('storage-message', 'error', error.message || storageT('storage.error'));
  } finally {
    if (button) button.disabled = false;
  }
}

function repositoryManagerSetMessage(type, message) {
  const el = document.getElementById('repository-manager-message');
  if (!el) return;
  if (!message) {
    el.className = 'status-message hidden';
    el.textContent = '';
    return;
  }
  el.className = `status-message ${type || 'info'}`;
  el.textContent = message;
}

window.BBUI.repositoryManagerState = window.BBUI.repositoryManagerState || {
  step: 1,
  storageKey: '',
  browserPath: '',
  browserVisible: false,
};
const repositoryManagerState = window.BBUI.repositoryManagerState;
repositoryManagerState.browserPath = repositoryManagerState.browserPath || '';
repositoryManagerState.browserVisible = false;
repositoryManagerState.browserController = null;

function repositoryManagerRenderStep(step) {
  const target = Math.max(1, Math.min(3, Number(step) || 1));
  repositoryManagerState.step = target;
  [1, 2, 3].forEach((number) => {
    document.getElementById(`repository-manager-step-${number}`)?.classList.toggle('hidden', number !== target);
    const dot = document.getElementById(`repository-manager-dot-${number}`);
    dot?.classList.toggle('is-active', number === target);
    dot?.classList.toggle('is-complete', number < target);
  });
  document.getElementById('repository-manager-back-btn')?.classList.toggle('hidden', target === 1);
  document.getElementById('repository-manager-next-btn')?.classList.toggle('hidden', target === 3);
  document.getElementById('repository-manager-save-btn')?.classList.toggle('hidden', target !== 3);
  if (target === 3) repositoryManagerUpdateSummary();
}

function repositoryManagerSyncFields() {
  const action = document.getElementById('repository-manager-action')?.value || 'create';
  const encryption = document.getElementById('repository-manager-encryption')?.value || 'repokey-blake2';
  const passphraseRequired = action === 'create' && encryption !== 'none';
  document.getElementById('repository-manager-encryption-group')?.classList.toggle('hidden', action !== 'create');
  document.getElementById('repository-manager-key-data-group')?.classList.toggle('hidden', action !== 'import');
  document.getElementById('repository-manager-passphrase-group')
    ?.classList.toggle('hidden', action === 'create' && encryption === 'none');
  document.getElementById('repository-manager-passphrase-required-marker')?.classList.toggle('hidden', !passphraseRequired);
  document.getElementById('repository-manager-passphrase-required-marker')?.closest('.form-label')?.classList.toggle('form-label-required', passphraseRequired);
  ['repository-manager-storage-quota', 'repository-manager-append-only', 'repository-manager-make-parent-dirs'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = action !== 'create';
  });
  document.getElementById('repository-manager-storage-quota')?.closest('.form-group')?.classList.toggle('hidden', action !== 'create');
  document.querySelector('.repository-manager-checks')?.classList.toggle('hidden', action !== 'create');
  document.getElementById('repository-manager-browser-btn')?.classList.toggle('hidden', action !== 'import');
  document.getElementById('repository-manager-browser-hint')?.classList.toggle('hidden', action !== 'import');
  const importCompatibilityNotice = document.getElementById('repository-manager-import-compatibility-notice');
  if (importCompatibilityNotice) {
    const version = storageBorgVersionLabel();
    importCompatibilityNotice.textContent = version
      ? storageT('storage.repositoryImportCompatibilityNotice', { version })
      : storageT('storage.repositoryImportCompatibilityNoticeGeneric');
    importCompatibilityNotice.classList.toggle('hidden', action !== 'import');
  }
  if (action !== 'import') repositoryManagerCloseBrowser();
  const encryptionDescription = document.getElementById('repository-manager-encryption-description');
  if (encryptionDescription) {
    const family = encryption.startsWith('keyfile')
      ? 'Keyfile'
      : (encryption.startsWith('authenticated') ? 'Authenticated' : (encryption === 'none' ? 'None' : 'Repokey'));
    encryptionDescription.textContent = storageT(`storage.repositoryEncryption${family}Hint`);
  }
  repositoryManagerUpdateSummary();
}

window.BBUI.storage = window.BBUI.storage || {};
window.BBUI.storage.updateRepositoryImportCompatibilityNotice = repositoryManagerSyncFields;

function repositoryManagerFillStorages() {
  const sel = document.getElementById('repository-manager-storage');
  if (!sel) return;
  const rows = storageTargets(storageState.data || {});
  sel.innerHTML = rows.length
    ? rows.map((storage) => `<option value="${escHtml(storage.storage_key || '')}">${escHtml(storageTargetLabel(storage))}</option>`).join('')
    : `<option value="">${storageT('storage.noStorageTargets')}</option>`;
  repositoryManagerUpdateSummary();
}

async function repositoryManagerEnsureStorages(force = false) {
  if (!force && storageState.loaded && storageState.data) return;
  await refreshStorage();
}

function repositoryManagerSelectedStorageLabel() {
  const sel = document.getElementById('repository-manager-storage');
  if (!sel) return '';
  return String(sel.options?.[sel.selectedIndex]?.textContent || sel.value || '').trim();
}

function repositoryManagerSelectedStorageKey() {
  return String(repositoryManagerState.storageKey || document.getElementById('repository-manager-storage')?.value || '').trim();
}

function repositoryManagerSelectedActionLabel() {
  const sel = document.getElementById('repository-manager-action');
  if (!sel) return '';
  return String(sel.options?.[sel.selectedIndex]?.textContent || sel.value || '').trim();
}

function repositoryManagerSummaryRow(labelKey, value) {
  return `<div>
    <span>${escHtml(storageT(labelKey))}</span>
    <strong>${escHtml(String(value || '').trim() || '—')}</strong>
  </div>`;
}

function repositoryManagerUpdateSummary() {
  const el = document.getElementById('repository-manager-summary');
  if (!el) return;
  const action = document.getElementById('repository-manager-action')?.value || 'create';
  const encryption = action === 'import'
    ? storageT('storage.repositoryEncryptionAutomatic')
    : String(document.getElementById('repository-manager-encryption')?.value || '').trim();
  const passphrase = String(document.getElementById('repository-manager-passphrase')?.value || '').trim();
  const repositoryName = String(document.getElementById('repository-manager-repository-name')?.value || '').trim();
  const displayName = String(document.getElementById('repository-manager-display-name')?.value || '').trim();
  const relativePath = String(document.getElementById('repository-manager-relative-path')?.value || '').trim();
  const passphraseState = encryption === 'none'
    ? storageT('storage.repositorySummaryPassphraseNone')
    : (passphrase
      ? storageT('storage.repositorySummaryPassphraseStored')
      : storageT('storage.repositorySummaryPassphraseNone'));
  const hint = action === 'create'
    ? storageT('storage.repositorySummaryCreateHint')
    : storageT('storage.repositorySummaryImportHint');
  el.innerHTML = `
    <div class="repository-manager-summary-list">
      ${repositoryManagerSummaryRow('storage.repositorySummaryAction', repositoryManagerSelectedActionLabel())}
      ${repositoryManagerSummaryRow('storage.repositorySummaryStorage', repositoryManagerSelectedStorageLabel())}
      ${repositoryManagerSummaryRow('storage.repositorySummaryRepository', displayName || repositoryName)}
      ${repositoryManagerSummaryRow('storage.repositorySummaryPath', relativePath || repositoryName)}
      ${repositoryManagerSummaryRow('storage.repositorySummaryEncryption', encryption || '—')}
      ${repositoryManagerSummaryRow('storage.repositorySummaryPassphrase', passphraseState)}
    </div>
    <p>${escHtml(hint)}</p>`;
}

async function openRepositoryManager(options = {}) {
  const modal = document.getElementById('repository-manager-modal');
  if (!modal) return;
  repositoryManagerSetMessage('', '');
  const forceRefresh = !!(options && typeof options === 'object' && options.forceRefresh);
  if (forceRefresh || !storageState.loaded || !storageState.data) {
    const sel = document.getElementById('repository-manager-storage');
    if (sel) sel.innerHTML = `<option value="">${escHtml(storageT('storage.loading'))}</option>`;
    try {
      await repositoryManagerEnsureStorages(forceRefresh);
    } catch (error) {
      repositoryManagerSetMessage('error', error.message || storageT('storage.error'));
    }
  }
  repositoryManagerFillStorages();
  const defaults = {
    'repository-manager-action': 'create',
    'repository-manager-display-name': '',
    'repository-manager-repository-name': '',
    'repository-manager-relative-path': '',
    'repository-manager-encryption': 'repokey-blake2',
    'repository-manager-passphrase': '',
    'repository-manager-key-data': '',
    'repository-manager-storage-quota': '',
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  const appendOnly = document.getElementById('repository-manager-append-only');
  const parentDirs = document.getElementById('repository-manager-make-parent-dirs');
  if (appendOnly) appendOnly.checked = false;
  if (parentDirs) parentDirs.checked = true;
  repositoryManagerState.storageKey = '';
  repositoryManagerState.browserPath = '';
  repositoryManagerCloseBrowser();
  repositoryManagerSyncFields();
  repositoryManagerRenderStep(1);
  modal.classList.remove('hidden');
  storageState.repositoryManagerCloseSnapshot = storageModalSnapshot('repository-manager-modal');
}

function closeRepositoryManager(options = {}) {
  if (!options?.force && !storageConfirmDiscard(
    storageModalDirty('repository-manager-modal', storageState.repositoryManagerCloseSnapshot),
    () => closeRepositoryManager({ force: true })
  )) return false;
  const passphrase = document.getElementById('repository-manager-passphrase');
  const keyData = document.getElementById('repository-manager-key-data');
  if (passphrase) passphrase.value = '';
  if (keyData) keyData.value = '';
  repositoryManagerCloseBrowser();
  document.getElementById('repository-manager-modal')?.classList.add('hidden');
  storageState.repositoryManagerCloseSnapshot = '';
  return true;
}

function repositoryManagerCloseBrowser() {
  if (repositoryManagerState.browserController) {
    repositoryManagerState.browserController.abort();
    repositoryManagerState.browserController = null;
  }
  repositoryManagerState.browserVisible = false;
  const browser = document.getElementById('repository-manager-browser');
  const input = document.getElementById('repository-manager-relative-path');
  browser?.classList.add('hidden');
  input?.setAttribute('aria-expanded', 'false');
}

function repositoryManagerBrowserStartPath() {
  const value = String(document.getElementById('repository-manager-relative-path')?.value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!value || !value.includes('/')) return '';
  const parts = value.split('/');
  parts.pop();
  return parts.join('/');
}

function repositoryManagerRenderBrowser(data) {
  const browser = document.getElementById('repository-manager-browser');
  const list = document.getElementById('repository-manager-browser-list');
  const path = document.getElementById('repository-manager-browser-path');
  const up = document.getElementById('repository-manager-browser-up-btn');
  const input = document.getElementById('repository-manager-relative-path');
  if (!browser || !list || !path) return;
  const current = String(data?.relative_path || '').trim();
  repositoryManagerState.browserPath = current;
  const storageName = String(data?.storage_name || repositoryManagerSelectedStorageLabel() || '').trim();
  path.textContent = `${storageName}${current ? ` / ${current}` : ' /'}`;
  if (up) up.disabled = !current;
  const rows = Array.isArray(data?.directories) ? data.directories : [];
  list.innerHTML = rows.length ? rows.map((row) => {
    const relative = String(row.relative_path || '').trim();
    const managed = !!row.managed;
    const borgRepository = !!row.borg_repository;
    const supported = row.supported !== false;
    const status = managed
      ? storageT('storage.repositoryBrowseManaged', { name: row.display_name || row.name || '' })
      : (borgRepository ? storageT('storage.repositoryBrowseBorgRepository') : (!supported ? storageT('storage.repositoryBrowseUnsupported') : storageT('storage.repositoryBrowseAvailable')));
    const selectDisabled = managed || !supported;
    const openDisabled = managed || !supported || borgRepository;
    const importableBorg = borgRepository && !managed && supported;
    const rowClass = managed
      ? ' repository-manager-browser-row-managed'
      : (importableBorg ? ' repository-manager-browser-row-repository' : '');
    const selectClass = importableBorg ? 'btn btn-primary' : 'btn btn-secondary';
    return `<div class="repository-manager-browser-row${rowClass}">
      <button type="button" class="repository-manager-browser-open" data-repository-browser-open="${escHtml(relative)}" ${openDisabled ? 'disabled' : ''}>
        <span class="repository-manager-browser-folder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v9H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>
        <span class="repository-manager-browser-name"><strong>${escHtml(row.name || relative)}</strong><small>${escHtml(status)}</small></span>
      </button>
      <button type="button" class="${selectClass}" data-repository-browser-select="${escHtml(relative)}" ${selectDisabled ? 'disabled' : ''}>${escHtml(storageT('storage.repositoryBrowseSelect'))}</button>
    </div>`;
  }).join('') : `<div class="repository-manager-browser-state">${escHtml(storageT('storage.repositoryBrowseEmpty'))}</div>`;
  browser.classList.remove('hidden');
  input?.setAttribute('aria-expanded', 'true');
  repositoryManagerState.browserVisible = true;
}

async function repositoryManagerLoadBrowser(path = '') {
  if ((document.getElementById('repository-manager-action')?.value || 'create') !== 'import') return;
  const storageKey = repositoryManagerSelectedStorageKey();
  if (!storageKey) return;
  const browser = document.getElementById('repository-manager-browser');
  const list = document.getElementById('repository-manager-browser-list');
  const pathLabel = document.getElementById('repository-manager-browser-path');
  const input = document.getElementById('repository-manager-relative-path');
  if (!browser || !list) return;
  if (repositoryManagerState.browserController) repositoryManagerState.browserController.abort();
  const controller = new AbortController();
  repositoryManagerState.browserController = controller;
  repositoryManagerState.browserVisible = true;
  browser.classList.remove('hidden');
  input?.setAttribute('aria-expanded', 'true');
  if (pathLabel) pathLabel.textContent = repositoryManagerSelectedStorageLabel();
  list.innerHTML = `<div class="repository-manager-browser-state">${escHtml(storageT('storage.repositoryBrowseLoading'))}</div>`;
  try {
    const response = await fetch(`/api/repositories/browse?storage_key=${encodeURIComponent(storageKey)}&path=${encodeURIComponent(path || '')}`, {
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
    if (repositoryManagerState.browserController !== controller) return;
    repositoryManagerRenderBrowser(data);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const details = String(error?.message || '').trim();
    const message = details
      ? `${storageT('storage.repositoryBrowseFailed')} ${details}`
      : storageT('storage.repositoryBrowseFailed');
    list.innerHTML = `<div class="repository-manager-browser-state error">${escHtml(message)}</div>`;
  } finally {
    if (repositoryManagerState.browserController === controller) repositoryManagerState.browserController = null;
  }
}

function repositoryManagerOpenBrowser() {
  if ((document.getElementById('repository-manager-action')?.value || 'create') !== 'import') return;
  if (repositoryManagerState.browserVisible) return;
  repositoryManagerLoadBrowser(repositoryManagerBrowserStartPath());
}

function repositoryManagerBrowserUp() {
  const current = String(repositoryManagerState.browserPath || '');
  const parts = current.split('/').filter(Boolean);
  parts.pop();
  repositoryManagerLoadBrowser(parts.join('/'));
}

function repositoryManagerBrowserClick(event) {
  const open = event.target.closest('[data-repository-browser-open]');
  if (open) {
    repositoryManagerLoadBrowser(open.dataset.repositoryBrowserOpen || '');
    return;
  }
  const select = event.target.closest('[data-repository-browser-select]');
  if (!select || select.disabled) return;
  const input = document.getElementById('repository-manager-relative-path');
  if (input) input.value = select.dataset.repositoryBrowserSelect || '';
  repositoryManagerPathChanged();
  repositoryManagerCloseBrowser();
}

function repositoryManagerSlug(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function repositoryManagerNameFromRelativePath(value) {
  const path = repositoryManagerSlug(value);
  const parts = path.split('/').map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function repositoryManagerPathInputChanged() {
  const repoName = document.getElementById('repository-manager-repository-name');
  const relative = document.getElementById('repository-manager-relative-path');
  if (!repoName || !relative) return;
  relative.value = String(relative.value || '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+/, '');
  repoName.value = repositoryManagerNameFromRelativePath(relative.value);
  repositoryManagerUpdateSummary();
}

function repositoryManagerPathChanged() {
  const repoName = document.getElementById('repository-manager-repository-name');
  const relative = document.getElementById('repository-manager-relative-path');
  if (!repoName || !relative) return;
  relative.value = repositoryManagerSlug(relative.value);
  repoName.value = repositoryManagerNameFromRelativePath(relative.value);
  repositoryManagerUpdateSummary();
}

async function repositoryManagerPrepareStorage() {
  const storageKey = document.getElementById('repository-manager-storage')?.value || '';
  if (!storageKey) throw new Error(storageT('storage.storageTargetRequired'));
  const testResponse = await fetch('/api/storages/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storage_key: storageKey }),
  });
  const tested = await testResponse.json();
  if (!testResponse.ok || !tested.ok) {
    throw new Error(apiMessage(tested?.details || tested, storageT('storage.storageTargetTestFailed')));
  }
  repositoryManagerState.storageKey = storageKey;
  return storageKey;
}

function repositoryManagerPayload() {
  const action = document.getElementById('repository-manager-action')?.value || 'create';
  return {
    action,
    storage_key: repositoryManagerSelectedStorageKey(),
    display_name: document.getElementById('repository-manager-display-name')?.value || '',
    repository_name: document.getElementById('repository-manager-repository-name')?.value || '',
    relative_path: document.getElementById('repository-manager-relative-path')?.value || '',
    encryption: action === 'import' ? 'auto' : (document.getElementById('repository-manager-encryption')?.value || 'repokey-blake2'),
    passphrase: document.getElementById('repository-manager-passphrase')?.value || '',
    key_data: action === 'import' ? (document.getElementById('repository-manager-key-data')?.value || '') : '',
    storage_quota: action === 'create' ? (document.getElementById('repository-manager-storage-quota')?.value || '') : '',
    append_only: action === 'create' && !!document.getElementById('repository-manager-append-only')?.checked,
    make_parent_dirs: action === 'create' && !!document.getElementById('repository-manager-make-parent-dirs')?.checked,
  };
}

function repositoryManagerErrorMessage(data, status = 0) {
  const code = String(data?.code || '').trim();
  const keyByCode = {
    repository_already_managed: 'storage.repositoryAlreadyManaged',
    repository_target_borg_exists: 'storage.repositoryTargetBorgExists',
    repository_target_not_empty: 'storage.repositoryTargetNotEmpty',
    repository_target_empty: 'storage.repositoryTargetEmpty',
    repository_target_missing: 'storage.repositoryTargetMissing',
    repository_target_not_directory: 'storage.repositoryTargetNotDirectory',
    repository_target_inaccessible: 'storage.repositoryTargetInaccessible',
    repository_relocated: 'storage.repositoryRelocated',
  };
  if (code === 'repository_target_borg_exists') {
    const action = document.getElementById('repository-manager-action');
    if (action) action.value = 'import';
    repositoryManagerSyncFields();
  }
  return keyByCode[code] ? storageT(keyByCode[code]) : apiErrorMessage(data, status);
}

async function repositoryManagerValidateTarget() {
  const response = await fetch('/api/repositories/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(repositoryManagerPayload()),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(repositoryManagerErrorMessage(data, response.status));
  return data;
}

async function repositoryManagerNext() {
  repositoryManagerSetMessage('', '');
  const button = document.getElementById('repository-manager-next-btn');
  if (button) button.disabled = true;
  try {
    if (repositoryManagerState.step === 1) {
      await repositoryManagerPrepareStorage();
      repositoryManagerRenderStep(2);
      return;
    }
    repositoryManagerPathChanged();
    const action = document.getElementById('repository-manager-action')?.value || 'create';
    const displayName = String(document.getElementById('repository-manager-display-name')?.value || '').trim();
    const relativePath = String(document.getElementById('repository-manager-relative-path')?.value || '').trim();
    const encryption = document.getElementById('repository-manager-encryption')?.value || 'repokey-blake2';
    const passphrase = String(document.getElementById('repository-manager-passphrase')?.value || '').trim();
    if (!displayName || !relativePath) throw new Error(storageT('storage.repositoryIdentityRequired'));
    if (action === 'create' && encryption !== 'none' && !passphrase) {
      throw new Error(storageT('storage.repositoryPassphraseRequired'));
    }
    await repositoryManagerValidateTarget();
    repositoryManagerRenderStep(3);
  } catch (err) {
    repositoryManagerSetMessage('error', err.message || storageT('storage.error'));
  } finally {
    if (button) button.disabled = false;
  }
}

function repositoryManagerBack() {
  repositoryManagerSetMessage('', '');
  repositoryManagerRenderStep(repositoryManagerState.step - 1);
}

async function saveRepositoryManager() {
  repositoryManagerSetMessage('', '');
  repositoryManagerPathChanged();
  const payload = repositoryManagerPayload();
  const btn = document.getElementById('repository-manager-save-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/repositories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(repositoryManagerErrorMessage(data, res.status));
    closeRepositoryManager({ force: true });
    await refreshStorage();
    showMsg('storage-message', 'success', storageT('storage.repositorySaved'));
    await window.BBUI?.setupWizard?.resumeAfterExternalSave?.('repository');
  } catch (err) {
    repositoryManagerSetMessage('error', err.message || storageT('storage.error'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// BORG CHECK (Storage Page)
// ══════════════════════════════════════════════════════════════════════════════

window.BBUI.storageCheckState = window.BBUI.storageCheckState || { es: null };
const checkState = window.BBUI.storageCheckState;

function openStorageMaintenanceConfirm(repositoryKey, action, mode) {
  return new Promise((resolve) => {
    const modal = document.getElementById('storage-maintenance-confirm-modal');
    if (!modal) {
      resolve({ confirmed: false });
      return;
    }
    const repo = storageRepositories(storageState.data || {})
      .find((row) => storageRepositoryKey(row) === String(repositoryKey || ''));
    const jobs = action === 'prune' && repo ? storageJobsForRepository(repo) : [];
    const job = repo ? (jobs.find(j => storageRetentionFromJob(j).mode !== 'all') || jobs[0] || storageJobForRepository(repo)) : null;
    const resultKey = action === 'check' && mode === 'verify_data' ? 'verify_data' : action;
    const confirmKey = action === 'prune'
      ? 'storage.repositoryPruneConfirm'
      : (action === 'compact' ? 'storage.repositoryCompactConfirm' : 'storage.repositoryVerifyConfirm');
    const title = document.getElementById('storage-maintenance-confirm-title');
    const description = document.getElementById('storage-maintenance-confirm-description');
    const info = document.getElementById('storage-maintenance-confirm-info');
    if (title) title.textContent = storageT('storage.repositoryMaintenanceConfirmTitle');
    if (description) description.textContent = storageT(confirmKey);
    const pruneDetails = action === 'prune'
      ? `<div id="storage-maintenance-retention-preview">${storageMaintenancePruneDetailsHtml(repo || {}, job)}</div>`
      : '';
    const selector = action === 'prune' && jobs.length > 1
      ? `<label class="ui-field storage-maintenance-retention-source"><span>${escHtml(storageT('storage.repositoryMaintenanceSelectRetentionSource'))}</span><select id="storage-maintenance-retention-job" class="form-select">${jobs.map((item) => `<option value="${escHtml(String(item.key || ''))}"${storageRetentionFromJob(item).mode === 'all' ? ' disabled' : ''}${item.key === job?.key ? ' selected' : ''}>${escHtml(storageJobName(repo || {}, item) || String(item.key || ''))} - ${escHtml(storageArchiveFilterFromJob(item) || '-')}</option>`).join('')}</select><small>${escHtml(storageT('storage.repositoryMaintenanceMultipleJobsHint'))}</small></label>`
      : '';
    if (info) info.innerHTML = `<div class="modal-info-item warning"><div class="modal-info-text"><strong>${escHtml(storageRepositoryTitle(repo || {}, job))}</strong><br>${escHtml(storageT('storage.repositoryMaintenanceConfirmAction', { action: storageMaintenanceTitle(resultKey) }))}${pruneDetails}${selector}</div></div>`;
    storageState.maintenanceConfirmation = {
      resolve,
      action,
      selectedJobKey: action === 'prune' ? String(job?.key || '') : '',
      repo: repo || {},
      jobs,
    };
    const start = document.getElementById('storage-maintenance-confirm-start-btn');
    if (start) start.disabled = action === 'prune' && (!job || storageRetentionFromJob(job).mode === 'all');
    modal.classList.remove('hidden');
    storageState.maintenanceCloseSnapshot = storageModalSnapshot('storage-maintenance-confirm-modal');
  });
}

function closeStorageMaintenanceConfirm(confirmed = false, options = {}) {
  if (!confirmed && !options?.force && !storageConfirmDiscard(
    storageModalDirty('storage-maintenance-confirm-modal', storageState.maintenanceCloseSnapshot),
    () => closeStorageMaintenanceConfirm(false, { force: true })
  )) return false;
  const pending = storageState.maintenanceConfirmation;
  storageState.maintenanceConfirmation = null;
  document.getElementById('storage-maintenance-confirm-modal')?.classList.add('hidden');
  storageState.maintenanceCloseSnapshot = '';
  const selectedJobKey = confirmed && pending?.action === 'prune'
    ? String(document.getElementById('storage-maintenance-retention-job')?.value || pending.selectedJobKey || '').trim()
    : '';
  if (typeof pending?.resolve === 'function') {
    pending.resolve({ confirmed: !!confirmed, jobKey: selectedJobKey });
  }
}

async function openRepositoryLifecycle(repositoryKey, mode = 'remove') {
  const key = String(repositoryKey || '').trim();
  const requestedMode = mode === 'delete' ? 'delete' : 'remove';
  if (!key) return;
  showMsg('storage-message', 'info', storageT('storage.repositoryLifecycleReviewing'));
  try {
    const response = await fetch('/api/repositories/lifecycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository_key: key, mode: requestedMode }),
    });
    const preview = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(preview, response.status));
    storageState.lifecycleCache[key] = { loading: false, ...preview };
    if (!preview.allowed) {
      if (storageState.data) renderStorage(storageState.data);
      showMsg('storage-message', 'warning', storageT('storage.repositoryLifecycleBlocked'));
      return;
    }
    const modal = document.getElementById('repository-lifecycle-modal');
    if (!modal) return;
    storageState.lifecycleConfirmation = { repositoryKey: key, mode: requestedMode, preview };
    const title = document.getElementById('repository-lifecycle-title');
    const description = document.getElementById('repository-lifecycle-description');
    const info = document.getElementById('repository-lifecycle-info');
    const nameLabel = document.getElementById('repository-lifecycle-name-label');
    const phraseGroup = document.getElementById('repository-lifecycle-phrase-group');
    const nameInput = document.getElementById('repository-lifecycle-name-input');
    const phraseInput = document.getElementById('repository-lifecycle-phrase-input');
    const confirm = document.getElementById('repository-lifecycle-confirm-btn');
    if (title) title.textContent = storageT(requestedMode === 'delete' ? 'storage.repositoryDeletePermanent' : 'storage.repositoryRemoveFromUi');
    if (description) description.textContent = storageT(requestedMode === 'delete' ? 'storage.repositoryDeleteConfirmHint' : 'storage.repositoryRemoveConfirmHint');
    if (info) info.innerHTML = `<div class="modal-info-item ${requestedMode === 'delete' ? 'error' : 'warning'}"><span class="modal-info-text"><strong>${escHtml(preview.display_name || '')}</strong><br>${escHtml(preview.repository_path || '')}<br>${escHtml(storageT('storage.repositoryArchiveCount'))}: ${Number(preview.archive_count || 0)} · ${escHtml(storageT('storage.repositoryDeduplicatedSize'))}: ${escHtml(storageFormatBytes(preview.deduplicated_size))}</span></div>`;
    if (nameLabel) {
      nameLabel.classList.add('form-label-required');
      nameLabel.innerHTML = `<span class="form-required-marker" aria-hidden="true">*</span><span>${escHtml(storageT('storage.repositoryConfirmName', { name: preview.display_name || '' }))}</span>`;
    }
    const phraseLabel = phraseGroup?.querySelector('label');
    if (phraseLabel) {
      phraseLabel.classList.add('form-label-required');
      phraseLabel.innerHTML = `<span class="form-required-marker" aria-hidden="true">*</span><span>${escHtml(storageT('storage.repositoryConfirmDeletePhrase'))}</span>`;
    }
    phraseGroup?.classList.toggle('hidden', requestedMode !== 'delete');
    if (nameInput) nameInput.value = '';
    if (phraseInput) phraseInput.value = '';
    if (confirm) {
      confirm.textContent = storageT(requestedMode === 'delete' ? 'storage.repositoryDeletePermanent' : 'storage.repositoryRemoveFromUi');
      confirm.className = requestedMode === 'delete' ? 'btn-danger' : 'btn btn-primary';
      confirm.disabled = true;
    }
    hideEl('storage-message');
    modal.classList.remove('hidden');
    storageState.lifecycleCloseSnapshot = storageModalSnapshot('repository-lifecycle-modal');
    nameInput?.focus();
  } catch (error) {
    showMsg('storage-message', 'error', error.message || storageT('storage.error'));
  }
}

function updateRepositoryLifecycleConfirmation() {
  const pending = storageState.lifecycleConfirmation;
  const confirm = document.getElementById('repository-lifecycle-confirm-btn');
  if (!pending || !confirm) return;
  const name = String(document.getElementById('repository-lifecycle-name-input')?.value || '');
  const phrase = String(document.getElementById('repository-lifecycle-phrase-input')?.value || '');
  const nameMatches = name === String(pending.preview?.display_name || '');
  confirm.disabled = !(nameMatches && (pending.mode !== 'delete' || phrase === 'DELETE'));
}

function closeRepositoryLifecycle(options = {}) {
  if (!options?.force && !storageConfirmDiscard(
    storageModalDirty('repository-lifecycle-modal', storageState.lifecycleCloseSnapshot),
    () => closeRepositoryLifecycle({ force: true })
  )) return false;
  storageState.lifecycleConfirmation = null;
  document.getElementById('repository-lifecycle-modal')?.classList.add('hidden');
  const nameInput = document.getElementById('repository-lifecycle-name-input');
  const phraseInput = document.getElementById('repository-lifecycle-phrase-input');
  if (nameInput) nameInput.value = '';
  if (phraseInput) phraseInput.value = '';
  storageState.lifecycleCloseSnapshot = '';
  return true;
}

async function confirmRepositoryLifecycle() {
  const pending = storageState.lifecycleConfirmation;
  const button = document.getElementById('repository-lifecycle-confirm-btn');
  if (!pending || !button || button.disabled) return;
  button.disabled = true;
  try {
    const preview = pending.preview || {};
    const response = await fetch('/api/repositories', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository_key: pending.repositoryKey,
        mode: pending.mode,
        confirmation_name: String(document.getElementById('repository-lifecycle-name-input')?.value || ''),
        confirmation_phrase: String(document.getElementById('repository-lifecycle-phrase-input')?.value || ''),
        expected_repository_id: preview.repository_id || '',
        expected_repository_path: preview.repository_path || '',
        expected_archive_count: Number(preview.archive_count || 0),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
    const key = pending.repositoryKey;
    const mode = pending.mode;
    closeRepositoryLifecycle({ force: true });
    delete storageState.lifecycleCache[key];
    delete storageState.archiveCache[key];
    storageState.selectedRepositoryKey = '';
    storageState.selectedTab = 'overview';
    await refreshStorage();
    showMsg('storage-message', 'success', storageT(mode === 'delete' ? 'storage.repositoryDeleted' : 'storage.repositoryRemovedFromUi'));
  } catch (error) {
    showMsg('storage-message', 'error', error.message || storageT('storage.error'));
    button.disabled = false;
  }
}

async function checkRun(repositoryKey, action = 'check', mode = 'quick') {
  if (!repositoryKey) return;
  let confirmation = { confirmed: true, jobKey: '' };
  if (['prune', 'compact', 'verify_data'].includes(action === 'check' ? mode : action)) {
    confirmation = await openStorageMaintenanceConfirm(repositoryKey, action, mode);
    if (!confirmation?.confirmed) return;
  }
  if (checkState.es) { checkState.es.close(); checkState.es = null; }
  storageState.maintenanceState = {
    running: true,
    target_key: repositoryKey,
    action,
    mode,
    start_time: new Date().toISOString(),
  };
  if (storageState.data) renderStorage(storageState.data);

  try {
    const payload = { repository_key: repositoryKey, action, mode };
    if (action === 'prune' && confirmation.jobKey) payload.job_key = confirmation.jobKey;
    const res = await fetch('/api/storage/check/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      storageState.maintenanceState = { running: false };
      if (storageState.data) renderStorage(storageState.data);
      showMsg('storage-message', 'error', err.error || `HTTP ${res.status}`);
      return;
    }
  } catch (err) {
    storageState.maintenanceState = { running: false };
    if (storageState.data) renderStorage(storageState.data);
    showMsg('storage-message', 'error', storageT('storage.errorPrefix', { message: err.message }));
    return;
  }

  const es = new EventSource('/api/storage/check/stream');
  checkState.es = es;

  es.onmessage = () => {};

  es.addEventListener('done', async () => {
    es.close(); checkState.es = null;
    delete storageState.archiveCache[repositoryKey];
    await refreshStorage();
  });

  es.addEventListener('error', async (e) => {
    if (e.data) showMsg('storage-message', 'error', storageT('storage.check.logError', { message: e.data }));
    es.close(); checkState.es = null;
    delete storageState.archiveCache[repositoryKey];
    await refreshStorage();
  });
}

window.addEventListener('bbui:language-changed', () => {
  if (storageState.loaded && storageState.data) renderStorage(storageState.data);
});
