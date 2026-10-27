// ══════════════════════════════════════════════════════════════════════════════
// RESTORE TESTS PAGE
// ══════════════════════════════════════════════════════════════════════════════

window.BBUI = window.BBUI || {};
window.BBUI.restoreTestsState = window.BBUI.restoreTestsState || {
  loaded: false,
  data: null,
  plan: null,
  pollingTimer: null,
  activeEventSource: null,
  logTransportCheckTimer: null,
  jobs: [],
  defaultsInitialized: false,
  rowBusy: {},
  runningJobs: [],
  runningRuns: [],
  subtab: 'plan',
  filteredReports: [],
  logState: null,
  logExitCode: null,
  selectedJob: 'all',
};
const restoreTestsState = window.BBUI.restoreTestsState;

function restoreTestsT(key, params = {}) {
  return window.BBUI?.components?.i18n?.t?.(`restoreTests.${key}`, params) || `restoreTests.${key}`;
}

function restoreTestsStatusIcon(status) {
  const icons = {
    success: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.5 2.2 2.2 4.8-5.4"/>',
    warning: '<path d="M10.3 4.4a2 2 0 0 1 3.4 0l7.4 12.8a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z"/><path d="M12 8.8v4.8"/><path d="M12 17h.01"/>',
    neutral: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    error: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6"/><path d="m15 9-6 6"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[status] || icons.warning}</svg>`;
}

function restoreTestJobName(result) {
  const job = (restoreTestsState.jobs || []).find((item) => String(item.key) === String(result.job_key));
  return job?.name || job?.display_name || result.type || '—';
}

function restoreTestsLocale() {
  return window.BBUI?.components?.i18n?.getLanguage?.() === 'en' ? 'en-US' : 'de-DE';
}

function resumeRestoreTestLiveLog(messageKey) {
  showMsg('restore-tests-message', 'warning', restoreTestsT(messageKey));
  if (!restoreTestsState.activeEventSource) {
    _openRTLogPanel();
  }
  startRTPolling();
}

function handleRestoreTestAlreadyRunning(payload) {
  if (String(payload?.code || '') !== 'restore_test_already_running') {
    return false;
  }
  resumeRestoreTestLiveLog('alreadyRunningOpenLog');
  refreshRestorePlanOnly();
  return true;
}

function restoreTestsLocationLabel(location) {
  const keys = { local: 'local', usb: 'usbDrive', smb: 'smb', storagebox: 'storagebox' };
  const normalized = String(location || '').toLowerCase();
  const key = keys[normalized];
  return key
    ? (window.BBUI?.components?.i18n?.t?.(`storage.${key}`) || normalized)
    : (location || '—');
}

function restoreTestsJobCount(count) {
  return restoreTestsT(count === 1 ? 'jobCountOne' : 'jobCountMany', { count });
}

function restoreTestsJobIcon(job) {
  const icon = resolveJobIcon(job);
  const color = resolveJobIconColor(job);
  const colorClass = color ? ` type-icon-color-${color}` : '';
  return `<span class="type-icon rt-sidebar-job-icon${colorClass}">${typeIcon(icon)}</span>`;
}

/** Render the job/location navigation for restore-test planning. */
function renderRestoreTestsSidebar() {
  const list = document.getElementById('rt-sidebar-job-list');
  if (!list) return;
  const query = String(document.getElementById('rt-sidebar-search')?.value || '').trim().toLowerCase();
  const jobs = (restoreTestsState.jobs || []).filter((job) => `${job.display_name || ''} ${job.name || ''} ${job.key || ''} ${job.location || ''}`.toLowerCase().includes(query));
  if (!jobs.length) {
    list.innerHTML = `<div class="ui-empty rt-sidebar-empty">${escHtml(restoreTestsT('noMatchingJobs'))}</div>`;
    return;
  }
  const planByKey = new Map((restoreTestsState.plan?.jobs || []).map((job) => [String(job.job_key), job]));
  const allActive = restoreTestsState.selectedJob === 'all';
  const allEntry = `<button class="rt-sidebar-job is-all ${allActive ? 'is-active' : ''}" data-rt-sidebar-job="all" ${allActive ? 'aria-current="page"' : ''}><span class="location-nav-glyph all">${locationIcon('all')}</span><span><strong>${escHtml(restoreTestsT('allJobs'))}</strong><small>${escHtml(restoreTestsT('overview'))}</small></span><span class="ui-badge">${jobs.length}</span></button>`;
  const order = ['local', 'usb', 'smb', 'storagebox'];
  const groups = order.map((location) => {
    const locationJobs = jobs.filter((job) => String(job.location || '').toLowerCase() === location);
    if (!locationJobs.length) return '';
    return `<section class="rt-sidebar-group"><header>${escHtml(restoreTestsLocationLabel(location))}<span>${locationJobs.length}</span></header>${locationJobs.map((job) => {
      const planJob = planByKey.get(String(job.key));
      const configured = !!planJob && planJob.enabled !== false && String(planJob.policy?.mode || 'off') !== 'off';
      const stateClass = planJob?.is_overdue ? 'warning' : configured ? 'success' : 'disabled';
      const active = restoreTestsState.selectedJob === String(job.key);
      return `<button class="rt-sidebar-job ${active ? 'is-active' : ''}" data-rt-sidebar-job="${escHtml(job.key)}" ${active ? 'aria-current="page"' : ''}>${restoreTestsJobIcon(job)}<span><strong>${escHtml(job.name || job.display_name || job.key)}</strong><small>${escHtml(job.archive_prefix || '')}</small></span><span class="rt-sidebar-state ${stateClass}"></span></button>`;
    }).join('')}</section>`;
  }).join('');
  list.innerHTML = allEntry + groups;
  list.querySelectorAll('[data-rt-sidebar-job]').forEach((button) => button.addEventListener('click', () => {
    restoreTestsState.selectedJob = button.dataset.rtSidebarJob || 'all';
    renderRestoreTestsSidebar();
    renderRestorePlan(restoreTestsState.plan);
    renderRestoreTests(restoreTestsState.data || []);
    updateRestoreTestsWorkspace();
  }));
}

function updateRestoreTestsWorkspace() {
  const selected = restoreTestsState.selectedJob;
  const selectedJob = (restoreTestsState.jobs || []).find((job) => String(job.key) === selected);
  const visibleCount = selected === 'all' ? (restoreTestsState.jobs || []).length : (selectedJob ? 1 : 0);
  const title = document.getElementById('rt-workspace-title');
  const count = document.getElementById('rt-workspace-count');
  const kicker = document.getElementById('rt-workspace-kicker');
  const subtitle = document.getElementById('rt-workspace-subtitle');
  if (title) title.textContent = selectedJob?.display_name || selectedJob?.name || (selected === 'all' ? restoreTestsT('allJobs') : selected);
  if (count) count.textContent = restoreTestsJobCount(visibleCount);
  if (kicker) kicker.textContent = restoreTestsT(restoreTestsState.subtab === 'reports' ? 'reportsTab' : 'planTab');
  if (subtitle) subtitle.textContent = restoreTestsT(restoreTestsState.subtab === 'reports' ? 'reportsWorkspaceSubtitle' : 'planWorkspaceSubtitle');
}

function restoreTestFailureMessage(test) {
  const code = String(test?.failure_code || 'RT_UNKNOWN');
  const key = `restoreTests.failures.${code}`;
  const translated = window.BBUI?.components?.i18n?.t?.(key);
  return translated && translated !== key ? translated : restoreTestsT('failures.RT_UNKNOWN');
}

function restoreTestStepMessage(step) {
  const label = rtStepLabel(String(step?.step_id || ''));
  if (step?.step_id === 'cleanup' && step?.status === 'passed') return restoreTestsT('cleanupCompleted');
  if (step?.status === 'passed') return restoreTestsT('stepPassed', { step: label });
  if (step?.status === 'failed') return restoreTestsT('stepFailed', { step: label });
  if (step?.status === 'not_tested') return restoreTestsT('notTested');
  return restoreTestsT('noStepMessage');
}

function _updateRTScheduleBtn() {
  // Schedule icon removed in consolidated UI.
}

function showRestoreTestScheduleModal() {
  // Schedule icon removed in consolidated UI.
}

/** Confirm a restore-test start or cancellation without changing the selected run.
 * @param {string} summaryText User-facing job/batch summary.
 * @param {boolean} cancelling Whether to present the cancellation action.
 * @returns {Promise<boolean>} Whether the user confirmed.
 */
function _openRTStartConfirmModal(summaryText, cancelling = false) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('modal-title');
    const descEl = document.getElementById('modal-description');
    const infoEl = document.getElementById('modal-info');
    const btn = document.getElementById('modal-confirm-btn');
    const closeBtn = document.getElementById('confirm-modal-close-btn');
    const cancelBtn = document.getElementById('confirm-modal-cancel-btn');
    const inputWrap = document.getElementById('modal-confirm-input-wrap');
    const passWrap = document.getElementById('modal-passphrase-delete-wrap');

    if (!modal || !titleEl || !descEl || !infoEl || !btn || !closeBtn || !cancelBtn) {
      resolve(window.confirm(cancelling ? summaryText : restoreTestsT('confirmFallback', { summary: summaryText })));
      return;
    }

    if (inputWrap) inputWrap.classList.add('hidden');
    if (passWrap) passWrap.classList.add('hidden');
    titleEl.textContent = cancelling ? restoreTestsT('cancelTitle') : restoreTestsT('confirmTitle');
    descEl.textContent = cancelling ? restoreTestsT('cancelDescription') : restoreTestsT('confirmDescription');
    infoEl.innerHTML = '<div class="modal-info-item info"><span class="modal-info-text" id="rt-confirm-summary-text"></span></div>';
    const summaryEl = document.getElementById('rt-confirm-summary-text');
    if (summaryEl) {
      summaryEl.textContent = String(summaryText || '');
      summaryEl.style.whiteSpace = 'pre-line';
    }
    btn.className = cancelling ? 'btn btn-danger' : 'btn btn-primary';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${escHtml(restoreTestsT('confirmAction'))}`;
    if (cancelling) btn.textContent = restoreTestsT('cancelTest');
    btn.disabled = false;

    const prevConfirm = btn.onclick;
    const prevClose = closeBtn.onclick;
    const prevCancel = cancelBtn.onclick;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      btn.onclick = prevConfirm;
      closeBtn.onclick = prevClose;
      cancelBtn.onclick = prevCancel;
      closeModal();
      resolve(!!ok);
    };

    btn.onclick = () => finish(true);
    closeBtn.onclick = () => finish(false);
    cancelBtn.onclick = () => finish(false);
    modal.classList.remove('hidden');
  });
}

async function runRestoreTestNow() {
  const summary = [
    restoreTestsT('runSummaryDue'),
    restoreTestsT('runSummaryPolicy'),
  ].join('\n');
  if (!await _openRTStartConfirmModal(summary)) {
    return;
  }

  const btn = document.getElementById('rt-run-btn');
  if (btn) btn.classList.add('loading');
  try {
    const res = await fetch('/api/restore-tests/run', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scheduled: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (handleRestoreTestAlreadyRunning(data)) return;
      throw new Error(apiErrorMessage(data, res.status));
    }
    if (data.started === false && data.reason === 'no_due_jobs') {
      showMsg(
        'restore-tests-message',
        'info',
        restoreTestsT('noDueJobs')
      );
      await refreshRestorePlanOnly();
      return;
    }
    restoreTestsState.runKey = data.run_key || '';
    _openRTLogPanel();
    startRTPolling();
    await refreshRestorePlanOnly();
  } catch (err) {
    showMsg('restore-tests-message', 'error', restoreTestsT('errorValue', { message: err.message }));
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

function _openRTLogPanel() {
  const panel = document.getElementById('rt-log-panel');
  const output = document.getElementById('rt-log-output');
  if (!panel || !output) return;
  output.textContent = '';
  panel.classList.remove('hidden');
  setRTLogStatus('running', null);

  if (restoreTestsState.activeEventSource) {
    restoreTestsState.activeEventSource.close();
  }
  if (restoreTestsState.logTransportCheckTimer) {
    clearTimeout(restoreTestsState.logTransportCheckTimer);
    restoreTestsState.logTransportCheckTimer = null;
  }
  const query = restoreTestsState.runKey ? `?job=${encodeURIComponent(restoreTestsState.runKey)}` : '';
  const es = new EventSource('/api/restore-tests/log/stream' + query);
  restoreTestsState.activeEventSource = es;

  es.addEventListener('open', () => {
    if (restoreTestsState.activeEventSource !== es) return;
    setRTLogStatus('running', null);
    if (restoreTestsState.logTransportCheckTimer) {
      clearTimeout(restoreTestsState.logTransportCheckTimer);
      restoreTestsState.logTransportCheckTimer = null;
    }
  });

  es.onmessage = (e) => {
    if (restoreTestsState.activeEventSource === es) setRTLogStatus('running', null);
    output.textContent += e.data + '\n';
    output.scrollTop = output.scrollHeight;
  };
  es.addEventListener('done', (e) => {
    const code = parseInt(e.data);
    setRTLogStatus(code === 0 ? 'success' : code === 130 ? 'cancelled' : code === 2 ? 'skipped' : 'error', code);
    es.close();
    restoreTestsState.activeEventSource = null;
    if (restoreTestsState.logTransportCheckTimer) {
      clearTimeout(restoreTestsState.logTransportCheckTimer);
      restoreTestsState.logTransportCheckTimer = null;
    }
    stopRTPolling();
    refreshRestoreTests();
  });
  es.addEventListener('error', (e) => {
    if (typeof e.data === 'string' && e.data) {
      setRTLogStatus('error', -1);
      es.close();
      restoreTestsState.activeEventSource = null;
      return;
    }
    handleRTLogTransportError(es);
  });
}

function handleRTLogTransportError(es) {
  if (restoreTestsState.activeEventSource !== es) return;
  startRTPolling();
  if (restoreTestsState.logTransportCheckTimer) {
    return;
  }
  setRTLogStatus('running', null);
  restoreTestsState.logTransportCheckTimer = setTimeout(async () => {
    restoreTestsState.logTransportCheckTimer = null;
    if (restoreTestsState.activeEventSource !== es) return;
    try {
      const res = await fetch('/api/restore-tests/running');
      if (!res.ok) return;
      const snapshot = await res.json().catch(() => ({}));
      const state = snapshot.runs?.find(run => run.run_key === restoreTestsState.runKey) || snapshot;
      if (state.running) {
        setRTLogStatus('running', null);
        return;
      }
      es.close();
      restoreTestsState.activeEventSource = null;
      stopRTPolling();
      setRTLogStatus('unknown', null);
      refreshRestoreTests();
    } catch (_) {
      // Keep the running state; a later browser reconnect or manual refresh can resolve it.
    }
  }, 1500);
}

function setRTLogStatus(state, exitCode) {
  restoreTestsState.logState = state;
  restoreTestsState.logExitCode = exitCode;
  const badge = document.getElementById('rt-log-status-badge');
  if (!badge) return;
  const exit = String(exitCode ?? '');
  if (state === 'running') {
    badge.className = 'badge';
    badge.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'running-dot';
    dot.style.marginRight = '4px';
    badge.append(dot, document.createTextNode(restoreTestsT('running')));
  } else if (state === 'success') {
    badge.className = 'badge success';
    badge.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'badge-dot';
    badge.append(dot, document.createTextNode(restoreTestsT('finishedExit', { exit })));
  } else if (state === 'skipped') {
    badge.className = 'badge warning';
    badge.textContent = restoreTestsT('skipped');
  } else if (state === 'cancelled') {
    badge.className = 'badge warning';
    badge.textContent = restoreTestsT('cancelled');
  } else if (state === 'unknown') {
    badge.className = 'badge warning';
    badge.textContent = restoreTestsT('logStatusUnknown');
  } else {
    badge.className = 'badge error';
    badge.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'badge-dot';
    badge.append(dot, document.createTextNode(restoreTestsT('errorExit', { exit })));
  }
}

function closeRTLogPanel() {
  const panel = document.getElementById('rt-log-panel');
  if (panel) panel.classList.add('hidden');
  if (restoreTestsState.activeEventSource) {
    restoreTestsState.activeEventSource.close();
    restoreTestsState.activeEventSource = null;
  }
  if (restoreTestsState.logTransportCheckTimer) {
    clearTimeout(restoreTestsState.logTransportCheckTimer);
    restoreTestsState.logTransportCheckTimer = null;
  }
}

function startRTPolling() {
  if (restoreTestsState.pollingTimer) return;
  restoreTestsState.pollingTimer = setInterval(_pollRTRunning, 10000);
}

function stopRTPolling() {
  if (restoreTestsState.pollingTimer) {
    clearInterval(restoreTestsState.pollingTimer);
    restoreTestsState.pollingTimer = null;
  }
}

/** Apply a successful running snapshot, including cancellation identities and state.
 * @param {Object} snapshot Running API response, including active job IDs.
 * @returns {boolean} Whether the plan needs repainting. Failed requests must not call this.
 */
function updateRTRunningJobs(snapshot) {
  const keys = snapshot.active_job_keys || (snapshot.runs || [snapshot])
    .filter(run => run.running && String(run.run_key || '').startsWith('restore_test_'))
    .map(run => run.run_key.slice('restore_test_'.length));
  const next = [...new Set(keys)].sort();
  const runs = snapshot.active_jobs || [];
  const changed = JSON.stringify(next) !== JSON.stringify(restoreTestsState.runningJobs)
    || JSON.stringify(runs) !== JSON.stringify(restoreTestsState.runningRuns);
  restoreTestsState.runningJobs = next;
  restoreTestsState.runningRuns = runs;
  return changed;
}

/** Refresh row status while the page is open, including externally started tests. */
async function _pollRTRunning() {
  try {
    const res = await fetch('/api/restore-tests/running');
    if (!res.ok) return;
    const state = await res.json();
    if (updateRTRunningJobs(state)) renderRestorePlan(restoreTestsState.plan);
  } catch (_) {
    // Preserve the last known state until a successful snapshot arrives.
  }
}

async function refreshRestoreTests() {
  const btn = document.getElementById('restore-tests-refresh-btn');
  if (btn) btn.classList.add('loading');
  try {
    const [testsRes, planRes, schedsRes, settingsRes, runningRes] = await Promise.all([
      fetch('/api/restore-tests?history=1'),
      fetch('/api/restore-tests/plan'),
      fetch('/api/schedules'),
      fetch('/api/settings/basic'),
      fetch('/api/restore-tests/running'),
    ]);
    if (!testsRes.ok) throw new Error(`HTTP ${testsRes.status}`);
    const testsData = await testsRes.json();
    if (schedsRes.ok) {
      const sData = await schedsRes.json();
      const schedules = window.BBUI.core.getSchedulesData();
      Object.assign(schedules, sData);
      window.BBUI.core.setSchedulesData(schedules);
    }
    if (settingsRes.ok && !restoreTestsState.defaultsInitialized) {
      restoreTestsState.defaultsInitialized = true;
    }
    restoreTestsState.data = testsData.tests || [];
    restoreTestsState.plan = planRes.ok ? await planRes.json() : null;
    restoreTestsState.jobs = (restoreTestsState.plan?.jobs || [])
      .filter((j) => !j.is_utility)
      .map((job) => ({
        ...job,
        key: job.job_key,
      }));
    if (runningRes.ok) {
      const runningState = await runningRes.json();
      updateRTRunningJobs(runningState);
      if (runningState.running) {
        restoreTestsState.runKey = runningState.run_key || '';
        resumeRestoreTestLiveLog('runningWithoutFinalLog');
      }
    }
    restoreTestsState.loaded = true;
    startRTPolling();
    renderRestorePlan(restoreTestsState.plan);
    renderRTReportFilterOptions(restoreTestsState.data);
    renderRestoreTests(restoreTestsState.data);
    renderRestoreTestsSubtab();
    _updateRTScheduleBtn();
    refreshRestoreTestJobsForSelection();
    renderRestoreTestsSidebar();
    updateRestoreTestsWorkspace();
  } catch (err) {
    showMsg('restore-tests-message', 'error', restoreTestsT('errorValue', { message: err.message }));
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

function switchRestoreTestsSubtab(tab) {
  restoreTestsState.subtab = tab === 'reports' ? 'reports' : 'plan';
  renderRestoreTestsSubtab();
  updateRestoreTestsWorkspace();
}

function renderRestoreTestsSubtab() {
  const isReports = restoreTestsState.subtab === 'reports';
  const planCard = document.getElementById('restore-tests-plan');
  const reportsCard = document.getElementById('restore-tests-reports');
  const planBtn = document.getElementById('rt-subtab-plan-btn');
  const reportsBtn = document.getElementById('rt-subtab-reports-btn');
  const hint = document.querySelector('#page-restore-tests .restore-tests-hint');
  if (planCard) planCard.classList.toggle('hidden', isReports);
  if (reportsCard) reportsCard.classList.toggle('hidden', !isReports);
  if (hint) hint.classList.toggle('hidden', isReports);
  if (planBtn) planBtn.classList.toggle('active', !isReports);
  if (reportsBtn) reportsBtn.classList.toggle('active', isReports);
}

function renderRestorePlan(plan) {
  const summaryEl = document.getElementById('restore-tests-plan-summary');
  const contentEl = document.getElementById('restore-tests-plan-content');
  if (!summaryEl || !contentEl) return;
  if (!plan || !Array.isArray(plan.jobs)) {
    summaryEl.textContent = restoreTestsT('planUnavailable');
    contentEl.innerHTML = `<div class="status-message warning">${escHtml(restoreTestsT('planLoadFailed'))}</div>`;
    return;
  }
  const locOrder = { local: 1, usb: 2, smb: 3, storagebox: 4, custom: 5 };
  const sortedJobs = [...plan.jobs].filter((job) => restoreTestsState.selectedJob === 'all' || String(job.job_key) === restoreTestsState.selectedJob).sort((a, b) => {
    const la = String(a?.location || '').toLowerCase();
    const lb = String(b?.location || '').toLowerCase();
    const oa = locOrder[la] || 99;
    const ob = locOrder[lb] || 99;
    if (oa !== ob) return oa - ob;
    const na = String(a?.display_name || a?.job_key || '').toLowerCase();
    const nb = String(b?.display_name || b?.job_key || '').toLowerCase();
    return na.localeCompare(nb, restoreTestsLocale());
  });
  const planSummary = {
    total: sortedJobs.length,
    scheduled: sortedJobs.filter(job => ['active', 'legacy'].includes(job.scheduler_state)).length,
    manual: sortedJobs.filter((job) => String(job.policy?.mode || 'off') === 'manual_only').length,
    off: sortedJobs.filter((job) => String(job.policy?.mode || 'off') === 'off').length,
    overdue: sortedJobs.filter((job) => job.is_overdue).length,
  };
  summaryEl.innerHTML = `<div class="rt-plan-summary rt-compact-summary">${[['summaryTotal', planSummary.total], ['summaryScheduled', planSummary.scheduled], ['summaryManual', planSummary.manual], ['summaryOff', planSummary.off], ['summaryOverdue', planSummary.overdue]].map(([label, count]) => `<span class="${label === 'summaryOverdue' && count ? 'attention' : ''}"><b>${count}</b> ${escHtml(restoreTestsT(label))}</span>`).join('')}</div>`;
  const legacyRun = document.getElementById('rt-run-btn');
  if (legacyRun) legacyRun.classList.toggle('hidden', !plan.jobs.some(job => job.scheduler_state === 'legacy'));
  const rows = sortedJobs.map((j) => {
    const p = j.policy || {};
    const mode = String(p.mode || 'off');
    const busy = restoreTestsState.rowBusy[j.job_key];
    const running = restoreTestsState.runningJobs.includes(j.job_key);
    const run = restoreTestsState.runningRuns.find(item => item.job_key === j.job_key);
    const cancelling = run?.cancel_requested || busy === 'cancel';
    const state = j.scheduler_state || 'needs_schedule';
    const schedule = p.cron ? rtScheduleLabel(p.cron)
      : (state === 'legacy' ? restoreTestsT('legacySchedule', { days: p.interval_days, cron: j.legacy_cron }) : '—');
    const result = rtAttemptStatus({ test_result: j.last_test_result, test_date: j.last_test_date });
    const activeSchedule = ['active', 'legacy'].includes(state);
    const planning = mode === 'scheduled' ? schedule : restoreTestsT(mode === 'manual_only' ? 'manualOnly' : 'off');
    return `<tr class="${running ? 'rt-plan-running' : ''}" data-rt-job-key="${escHtml(j.job_key)}">
      <td data-label="${escHtml(restoreTestsT('job'))}"><strong>${escHtml(j.name || j.display_name || j.job_key)}</strong><small>${escHtml(restoreTestsLocationLabel(j.location))}</small>${running ? `<span class="rt-plan-running-label"><span class="running-dot" aria-hidden="true"></span>${escHtml(restoreTestsT('running'))}</span>` : ''}</td>
      <td data-label="${escHtml(restoreTestsT('testPlanning'))}" class="rt-plan-schedule"><strong>${escHtml(planning)} · L${Number(p.level || 2)}</strong><small>${escHtml(activeSchedule && j.next_run_at ? `${restoreTestsT('nextTest')}: ${j.next_run_at}` : restoreTestsT('noAutomaticTest'))}</small>${mode === 'scheduled' && !activeSchedule ? `<small class="rt-text-warning">${escHtml(restoreTestsT(`schedulerStates.${state}`))}</small>` : ''}${j.is_overdue ? `<small class="rt-text-warning">${escHtml(restoreTestsT('evidenceDue'))}</small>` : ''}</td>
      <td data-label="${escHtml(restoreTestsT('lastTest'))}"><span class="rt-attempt-status ${result.className}">${restoreTestsStatusIcon(result.className)}${escHtml(result.label)}</span><small>${escHtml(j.last_test_date || '—')}</small>${j.last_test_date ? `<button type="button" class="rt-text-button" data-rt-plan-action="reports" data-job-key="${escHtml(j.job_key)}">${escHtml(restoreTestsT('evidenceAndHistory'))} →</button>` : ''}</td>
      <td data-label="${escHtml(restoreTestsT('actions'))}"><div class="rt-plan-actions">
        <button type="button" class="btn ${running ? 'btn-danger' : 'btn-primary'} btn-sm" data-rt-plan-action="${running ? 'cancel' : 'run'}" data-job-key="${escHtml(j.job_key)}" aria-busy="${!!cancelling || busy === 'run'}" ${busy || (running ? cancelling || !run?.cancel_allowed : j.enabled === false) ? 'disabled' : ''} title="${escHtml(restoreTestsT(running && !run?.cancel_allowed && !cancelling ? 'cancelUnavailable' : running ? 'cancelTest' : 'testNow'))}">${escHtml(restoreTestsT(running ? cancelling ? 'cancelling' : 'cancelTest' : busy === 'run' ? 'startingTest' : 'testNow'))}</button>
        <details class="rt-plan-menu"><summary aria-label="${escHtml(restoreTestsT('actions'))}">⋯</summary><button type="button" class="btn btn-secondary btn-sm" data-rt-plan-action="edit" data-job-key="${escHtml(j.job_key)}" ${busy ? 'disabled' : ''}>${escHtml(restoreTestsT('editPlan'))}</button></details>
      </div></td>
    </tr>`;
  }).join('');
  contentEl.innerHTML = `<table class="history-table"><thead><tr>${['job', 'testPlanning', 'lastTest', 'actions'].map(key => `<th>${escHtml(restoreTestsT(key))}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="4">${escHtml(restoreTestsT('noJobs'))}</td></tr>`}</tbody></table>`;
}

function rtScheduleLabel(cron) {
  const [minute, hour, dom, month, dow] = String(cron).split(' ');
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (month !== '*') return cron;
  if (dom !== '*') return restoreTestsT('monthlyAt', { day: dom, time });
  if (dow !== '*') {
    const day = restoreTestsT(`weekdays.${dow}`);
    return day.includes('restoreTests.') ? cron : restoreTestsT('weeklyAt', { day, time });
  }
  return restoreTestsT('dailyAt', { time });
}

function editRestorePlan(jobKey) {
  const row = restoreTestsState.plan?.jobs?.find(job => job.job_key === jobKey);
  if (!row) return;
  const p = row.policy || {};
  const parts = String(p.cron || '').split(' ');
  const frequency = p.cron ? (parts[2] !== '*' ? 'monthly' : parts[4] !== '*' ? 'weekly' : 'daily') : (row.legacy_cron ? 'legacy' : 'weekly');
  const options = (values, selected, prefix = '') => values.map(value => `<option value="${value}" ${String(selected) === String(value) ? 'selected' : ''}>${escHtml(restoreTestsT(prefix + value))}</option>`).join('');
  document.getElementById('rt-plan-dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'rt-plan-dialog';
  dialog.className = 'modal rt-plan-dialog';
  dialog.setAttribute('aria-labelledby', 'rt-plan-dialog-title');
  dialog.innerHTML = `<form>
    <div class="modal-header"><h3 id="rt-plan-dialog-title">${escHtml(restoreTestsT('editPlan'))}</h3><button type="button" class="modal-close" data-close aria-label="${escHtml(restoreTestsT('close'))}">×</button></div>
    <div class="modal-body">
      <p><strong>${escHtml(row.name || row.display_name)}</strong></p>
      <div class="rt-plan-fields">
        <label>${escHtml(restoreTestsT('policy'))}<select name="mode" class="form-select">${options(['scheduled', 'manualOnly', 'off'], p.mode === 'manual_only' ? 'manualOnly' : p.mode)}</select></label>
        <label>${escHtml(restoreTestsT('level'))}<select name="level" class="form-select">${[1,2,3].map(level => `<option value="${level}" ${level === p.level ? 'selected' : ''}>L${level}</option>`).join('')}</select></label>
        <label>${escHtml(restoreTestsT('frequency'))}<select name="frequency" class="form-select">${options(row.legacy_cron && !p.cron ? ['legacy', 'daily', 'weekly', 'monthly'] : ['daily', 'weekly', 'monthly'], frequency)}</select></label>
        <label>${escHtml(restoreTestsT('time'))}<input name="time" type="time" class="form-input" required value="${p.cron ? `${parts[1].padStart(2,'0')}:${parts[0].padStart(2,'0')}` : ''}"></label>
        <label data-weekday>${escHtml(restoreTestsT('weekday'))}<select name="weekday" class="form-select">${options([1,2,3,4,5,6,0], p.cron ? parts[4] : 0, 'weekdays.')}</select></label>
        <label data-monthday>${escHtml(restoreTestsT('monthday'))}<input name="monthday" type="number" class="form-input" min="1" max="28" required value="${frequency === 'monthly' ? parts[2] : 1}"></label>
        <label>${escHtml(restoreTestsT('validityDays'))}<input name="validity" type="number" class="form-input" min="1" required value="${Number(p.validity_days || 30)}"></label>
      </div>
      <p class="rt-plan-help">${escHtml(restoreTestsT('scheduleHelp'))}</p>
      <p class="rt-plan-help">${escHtml(restoreTestsT('validityHelp'))}</p>
      <p class="rt-plan-help">${escHtml(restoreTestsT('conflictHelp'))}</p>
      <div class="message error hidden" data-error role="alert"></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn btn-secondary" data-close>${escHtml(restoreTestsT('cancel'))}</button><button type="submit" class="btn btn-primary">${escHtml(restoreTestsT('save'))}</button></div>
  </form>`;
  const form = dialog.querySelector('form');
  const update = () => {
    const active = form.elements.mode.value === 'scheduled';
    const freq = form.elements.frequency.value;
    form.elements.frequency.disabled = !active;
    form.elements.time.disabled = !active || freq === 'legacy';
    form.elements.weekday.disabled = !active || freq !== 'weekly';
    form.elements.monthday.disabled = !active || freq !== 'monthly';
    dialog.querySelector('[data-weekday]').hidden = freq !== 'weekly';
    dialog.querySelector('[data-monthday]').hidden = freq !== 'monthly';
  };
  // Native constraint validation runs before submit and otherwise uses the browser language.
  form.addEventListener('invalid', event => {
    const key = { time: 'validationTime', monthday: 'validationMonthday', validity: 'validationValidity' }[event.target.name];
    if (key) event.target.setCustomValidity(restoreTestsT(key));
  }, true);
  form.addEventListener('input', event => event.target.setCustomValidity?.(''));
  form.addEventListener('change', event => {
    event.target.setCustomValidity?.('');
    update();
  });
  form.addEventListener('submit', event => { event.preventDefault(); saveRestorePlanPolicy(jobKey); });
  dialog.querySelectorAll('[data-close]').forEach(button => button.onclick = () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  update();
  dialog.showModal();
}

async function saveRestorePlanPolicy(jobKey) {
  const dialog = document.getElementById('rt-plan-dialog');
  const form = dialog?.querySelector('form');
  if (!form || !form.reportValidity()) return;
  const row = restoreTestsState.plan?.jobs?.find(job => job.job_key === jobKey);
  const policy = { ...row.policy };
  const fields = form.elements;
  policy.mode = fields.mode.value === 'manualOnly' ? 'manual_only' : fields.mode.value;
  policy.level = Number(fields.level.value);
  policy.validity_days = Number(fields.validity.value);
  if (policy.mode === 'scheduled' && fields.frequency.value !== 'legacy') {
    const [hour, minute] = fields.time.value.split(':').map(Number);
    policy.cron = `${minute} ${hour} ${fields.frequency.value === 'monthly' ? fields.monthday.value : '*'} * ${fields.frequency.value === 'weekly' ? fields.weekday.value : '*'}`;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = restoreTestsT('saving');
  try {
    const res = await fetch('/api/restore-tests/policy', {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_key: jobKey, policy }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(data, res.status));
    dialog.close();
    showMsg('restore-tests-message', 'success', restoreTestsT('policySaved', { job: row.display_name }));
    await refreshRestorePlanOnly();
  } catch (err) {
    const error = dialog.querySelector('[data-error]');
    error.textContent = restoreTestsT('policySaveFailed', { message: err.message });
    error.classList.remove('hidden');
  } finally {
    submit.disabled = false;
    submit.textContent = restoreTestsT('save');
  }
}

async function runRestorePlanJob(jobKey) {
  if (restoreTestsState.runningJobs.includes(jobKey) || restoreTestsState.rowBusy[jobKey]) return;
  restoreTestsState.runKey = `restore_test_${jobKey}`;
  restoreTestsState.rowBusy[jobKey] = 'run';
  renderRestorePlan(restoreTestsState.plan);
  try {
    const res = await fetch('/api/restore-tests/run-job', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_key: jobKey }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (handleRestoreTestAlreadyRunning(data)) return;
      throw new Error(apiErrorMessage(data, res.status));
    }
    updateRTRunningJobs({ active_job_keys: [...restoreTestsState.runningJobs, jobKey], active_jobs: restoreTestsState.runningRuns });
    const jobLabel = restoreTestsState.plan?.jobs?.find(job => job.job_key === jobKey)?.display_name || jobKey;
    showMsg('restore-tests-message', 'success', restoreTestsT('testStarted', { job: jobLabel }));
    restoreTestsState.runKey = data.run_key || '';
    _openRTLogPanel();
    startRTPolling();
    await refreshRestorePlanOnly();
  } catch (err) {
    showMsg('restore-tests-message', 'error', restoreTestsT('startFailed', { message: err.message }));
  } finally {
    restoreTestsState.rowBusy[jobKey] = false;
    renderRestorePlan(restoreTestsState.plan);
  }
}

/** Confirm and cancel the captured run ID, keeping the row active until cleanup finishes.
 * @param {string} jobKey Job whose active test should stop (including its batch).
 * @returns {Promise<void>} Reports API errors inline and refreshes run state.
 */
async function cancelRestorePlanJob(jobKey) {
  const run = restoreTestsState.runningRuns.find(item => item.job_key === jobKey);
  if (!run?.run_id || !run.cancel_allowed || run.cancel_requested || restoreTestsState.rowBusy[jobKey]) return;
  const name = restoreTestsState.plan?.jobs?.find(job => job.job_key === jobKey)?.display_name || jobKey;
  const summary = restoreTestsT('cancelConfirm', { job: name })
    + (run.run_key === 'restore_test' ? '\n' + restoreTestsT('cancelBatch') : '');
  if (!await _openRTStartConfirmModal(summary, true)) return;
  restoreTestsState.rowBusy[jobKey] = 'cancel';
  renderRestorePlan(restoreTestsState.plan);
  try {
    const res = await fetch('/api/restore-tests/cancel', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_key: jobKey, run_id: run.run_id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(apiErrorMessage(data, res.status));
    restoreTestsState.runningRuns.forEach(item => {
      if (item.run_id === run.run_id) item.cancel_requested = true;
    });
    showMsg('restore-tests-message', 'info', restoreTestsT('cancelRequested'));
  } catch (err) {
    showMsg('restore-tests-message', 'error', restoreTestsT('cancelFailed', { message: err.message }));
  } finally {
    restoreTestsState.rowBusy[jobKey] = false;
    renderRestorePlan(restoreTestsState.plan);
    await refreshRestorePlanOnly();
  }
}

function onRestoreTestsPlanClick(event) {
  const btn = event.target.closest('[data-rt-plan-action]');
  if (!btn || btn.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const action = btn.dataset.rtPlanAction || '';
  const jobKey = btn.dataset.jobKey || '';
  if (!jobKey) return;
  if (action === 'reports') return openRTRJobReports(jobKey);
  if (action === 'edit') return editRestorePlan(jobKey);
  if (action === 'run') return runRestorePlanJob(jobKey);
  if (action === 'cancel') return cancelRestorePlanJob(jobKey);
}

async function refreshRestorePlanOnly() {
  try {
    const [planRes, runningRes] = await Promise.all([
      fetch('/api/restore-tests/plan', { credentials: 'include' }),
      fetch('/api/restore-tests/running', { credentials: 'include' }),
    ]);
    if (planRes.ok) {
      restoreTestsState.plan = await planRes.json();
    }
    if (runningRes.ok) {
      const running = await runningRes.json();
      updateRTRunningJobs(running);
    }
    renderRestorePlan(restoreTestsState.plan);
    startRTPolling();
  } catch (_) {}
}

function refreshRestoreTestJobsForSelection() {
  const wrap = document.getElementById('rt-job-selector-wrap');
  const list = document.getElementById('rt-job-selector-list');
  const location = document.getElementById('rt-location-select')?.value || 'all';
  const selectAll = document.getElementById('rt-select-all-jobs')?.checked ?? true;
  if (!wrap || !list) return;
  wrap.classList.toggle('hidden', selectAll);
  if (selectAll) return;

  const rows = (restoreTestsState.jobs || [])
    .filter(j => location === 'all' || String(j.location || '').toLowerCase() === location)
    .sort((a, b) => String(a.display_name || a.name || a.key).localeCompare(String(b.display_name || b.name || b.key)));

  if (!rows.length) {
    list.innerHTML = `<span class="muted">${escHtml(restoreTestsT('noJobsForSelection'))}</span>`;
    return;
  }

  list.innerHTML = rows.map((j) => `
    <label class="form-checkbox-row" style="display:inline-flex;margin-right:12px">
      <input type="checkbox" class="rt-job-checkbox" value="${escHtml(j.key || '')}">
      ${(escHtml(j.display_name || j.name || j.key || '') || '-')}
    </label>
  `).join('');
}

function toggleRestoreTestJobSelectionMode() {
  refreshRestoreTestJobsForSelection();
}

function renderRestoreTests(tests) {
  const summaryEl = document.getElementById('restore-tests-summary');
  const contentEl = document.getElementById('restore-tests-content');
  if (!summaryEl || !contentEl) return;
  const list = Array.isArray(tests) ? tests : [];
  const filtered = _getFilteredRTReports(list);
  const ok = filtered.filter(t => rtAttemptStatus(t).className === 'success').length;
  const failed = filtered.filter(t => rtAttemptStatus(t).className === 'error').length;
  const cancelled = filtered.filter(rtCancelled).length;
  summaryEl.innerHTML = `<div class="rt-compact-summary"><span><b>${filtered.length}</b> ${escHtml(restoreTestsT('reports'))}</span><span><b>${ok}</b> ${escHtml(restoreTestsT('successful'))}</span><span><b>${failed}</b> ${escHtml(restoreTestsT('failed'))}</span><span><b>${cancelled}</b> ${escHtml(restoreTestsT('cancelled'))}</span></div>`;
  summaryEl.classList.remove('hidden');

  if (!filtered.length) {
    contentEl.innerHTML = `<div class="status-message empty-state">${escHtml(restoreTestsT('noFilteredReports'))}</div>`;
    return;
  }
  const opened = new Set(Array.from(contentEl.querySelectorAll('details.rt-report-entry[open]')).map(el => el.dataset.reportIdentity));
  contentEl.innerHTML = filtered.map((t, i) => renderRTReportRow(t, i, opened.has(rtReportIdentity(t)))).join('');
  restoreTestsState.filteredReports = filtered;
}

function rtEvidenceStale(test) {
  const policy = restoreTestsState.plan?.jobs?.find(job => job.job_key === test.job_key)?.policy;
  if (!policy) return isStaleDate(test.test_date);
  if (policy.mode === 'manual_only' || policy.mode === 'off') return false;
  const timestamp = _rtTs(test);
  if (policy.cron) return timestamp > 0 && Date.now() >= timestamp + Number(policy.validity_days || 30) * 86400000;
  return timestamp > 0 && Math.floor((Date.now() - timestamp) / 86400000) > Number(policy.validity_days || 30);
}

function _rtStatus(t) {
  if (t.failure_code === 'RT_CANCELLED') return { label: restoreTestsT('cancelled'), className: 'warning' };
  if (t.test_result === 'skipped') return { className: 'warning', label: restoreTestsT('skipped') };
  if (t.test_result === 'success' && rtEvidenceStale(t)) return { className: 'warning', label: restoreTestsT('overdue') };
  if (t.test_result === 'success') return { className: 'success', label: restoreTestsT('verified') };
  if (t.test_result === 'failed') return { className: 'error', label: restoreTestsT('failed') };
  return { className: 'warning', label: restoreTestsT('unavailable') };
}

function _rtTs(test) {
  const raw = String(test?.test_date || '').trim();
  if (!raw) return 0;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

function _getFilteredRTReports(tests) {
  const jobNeedle = String(document.getElementById('rt-report-filter-job')?.value || '').trim().toLowerCase();
  const location = String(document.getElementById('rt-report-filter-location')?.value || 'all').toLowerCase();
  const status = String(document.getElementById('rt-report-filter-status')?.value || 'all');
  const range = String(document.getElementById('rt-report-filter-range')?.value || 'all');
  const problemOnly = !!document.getElementById('rt-report-filter-problem')?.checked;
  const now = Date.now();
  const rangeDays = Number(range || 0);
  const filtered = [...tests].filter((t) => {
    const key = String(t.job_key || t.type || '').toLowerCase();
    if (restoreTestsState.selectedJob !== 'all' && key !== String(restoreTestsState.selectedJob).toLowerCase()) return false;
    if (jobNeedle && !`${key} ${restoreTestJobName(t).toLowerCase()}`.includes(jobNeedle)) return false;
    if (location !== 'all' && String(t.location || '').toLowerCase() !== location) return false;
    const stale = t.test_result === 'success' && rtEvidenceStale(t);
    if (status === 'success' && rtAttemptStatus(t).className !== 'success') return false;
    if (status === 'failed' && rtAttemptStatus(t).className !== 'error') return false;
    if (status === 'cancelled' && !rtCancelled(t)) return false;
    if (status === 'unavailable' && t.test_result !== 'unavailable') return false;
    if (status === 'stale' && !stale) return false;
    if (problemOnly && !(rtAttemptStatus(t).className === 'error' || t.test_result === 'unavailable' || t.test_result === 'skipped' || stale)) return false;
    if (range !== 'all' && rangeDays > 0) {
      const ts = _rtTs(t);
      if (!ts) return false;
      if (ts < (now - rangeDays * 86400000)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => _rtTs(b) - _rtTs(a));
  return filtered;
}

function _rtRuntimeBand(durationSeconds, durationFormatted) {
  let sec = Number(durationSeconds || 0);
  if (!Number.isFinite(sec) || sec <= 0) {
    const text = String(durationFormatted || '').toLowerCase();
    const m = text.match(/(\d+)\s*h/);
    if (m) sec += Number(m[1]) * 3600;
    const mm = text.match(/(\d+)\s*m/);
    if (mm) sec += Number(mm[1]) * 60;
    const ss = text.match(/(\d+)\s*s/);
    if (ss) sec += Number(ss[1]);
  }
  if (sec >= 3600) return { label: restoreTestsT('runtimeLong'), short: restoreTestsT('runtimeLong'), cls: 'long' };
  if (sec >= 900) return { label: restoreTestsT('runtimeMedium'), short: restoreTestsT('runtimeMedium'), cls: 'medium' };
  return { label: restoreTestsT('runtimeShort'), short: restoreTestsT('runtimeShort'), cls: 'short' };
}

function formatCoveragePercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return new Intl.NumberFormat(restoreTestsLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(0) + '%';
  return `${new Intl.NumberFormat(restoreTestsLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n)}%`;
}

function toggleRTDetail(detailId, row) {
  const detail = document.getElementById(detailId);
  const idx    = detailId.replace('rtd-', '');
  const chev   = document.getElementById(`rtchev-${idx}`);
  if (!detail) return;
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'table-row';
  row?.classList.toggle('history-expanded', !open);
  chev?.classList.toggle('open', !open);
}

function toggleRTEntries(headerEl) {
  const body = headerEl.nextElementSibling;
  const chev = headerEl.querySelector('.history-chevron');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chev?.classList.toggle('open', !open);
}

function onRestoreTestsContentClick(event) {
  const el = event.target.closest('[data-rt-action]');
  if (!el) return;
  const action = el.dataset.rtAction || '';
  if (action === 'evidence') return openRTRJobReports(el.dataset.jobKey, el.dataset.evidenceDate);
  if (action === 'toggle-detail') {
    const rowId = el.dataset.rowId || '';
    const detailId = el.dataset.detailId || '';
    return toggleRTDetailById(rowId, detailId);
  }
  if (action === 'toggle-entries') {
    return toggleRTEntries(el);
  }
}

function onRTReportFilterChange() {
  renderRestoreTests(restoreTestsState.data || []);
}

function renderRTReportFilterOptions(tests) {
  const locationEl = document.getElementById('rt-report-filter-location');
  if (!locationEl) return;
  const current = locationEl.value || 'all';
  const locations = Array.from(new Set((tests || []).map((t) => String(t.location || '').toLowerCase()).filter(Boolean))).sort();
  locationEl.innerHTML = `<option value="all">${escHtml(restoreTestsT('allLocations'))}</option>`
    + locations.map((loc) => `<option value="${escHtml(loc)}">${escHtml(restoreTestsLocationLabel(loc))}</option>`).join('');
  locationEl.value = locations.includes(current) || current === 'all' ? current : 'all';
}

function toggleRTDetailById(rowId, detailId) {
  const detail = document.getElementById(detailId);
  const row = document.getElementById(rowId);
  const idx = detailId.replace('rtd-', '');
  const chev = document.getElementById(`rtchev-${idx}`);
  if (!detail) return;
  const open = detail.style.display !== 'none';
  detail.style.display = open ? 'none' : 'table-row';
  row?.classList.toggle('history-expanded', !open);
  chev?.classList.toggle('open', !open);
}

/** Classify a test attempt independently of evidence age or scheduling policy. */
function rtAttemptStatus(t) {
  if (rtCancelled(t)) return { label: restoreTestsT('cancelled'), className: 'neutral' };
  const keys = {success: ['successful', 'success'], failed: ['failed', 'error'], unavailable: ['unavailable', 'warning'], skipped: ['skipped', 'neutral']};
  const [key, className] = keys[t.test_result] || [t.test_date ? 'resultUnknown' : 'neverTested', 'neutral'];
  return {label: restoreTestsT(key), className};
}

/** Recognize both retained legacy cancellation reports and explicit cancelled results. */
function rtCancelled(t) {
  return t.failure_code === 'RT_CANCELLED' || t.test_result === 'cancelled';
}

/** Use report content as identity: legacy IDs can be missing or shared across attempts. */
function rtReportIdentity(t) {
  const {time_ago, ...persisted} = t;
  const value = JSON.stringify(persisted);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `${t.report_id || t.test_id || ''}:${t.job_key || ''}:${t.test_date || ''}:${hash >>> 0}`;
}

/** Open a job's reports without stale filters; optionally expand its evidence by date. */
function openRTRJobReports(jobKey, evidenceDate = '') {
  restoreTestsState.selectedJob = jobKey;
  for (const id of ['job', 'location', 'status', 'range']) {
    const el = document.getElementById(`rt-report-filter-${id}`);
    if (el) el.value = id === 'job' ? '' : 'all';
  }
  const problems = document.getElementById('rt-report-filter-problem');
  if (problems) problems.checked = false;
  switchRestoreTestsSubtab('reports');
  renderRestoreTestsSidebar();
  renderRestorePlan(restoreTestsState.plan);
  renderRestoreTests(restoreTestsState.data || []);
  const index = restoreTestsState.filteredReports.findIndex(t => !evidenceDate || (t.test_date === evidenceDate && t.test_result === 'success' && !rtCancelled(t)));
  document.querySelectorAll('#restore-tests-content > details[open]').forEach(entry => { entry.open = false; });
  const entry = document.getElementById(`rtr-${index}`);
  if (entry) { entry.open = true; entry.querySelector('summary')?.focus(); }
}

/** Describe the recorded cumulative scope without inventing a restore or checksum comparison. */
function renderRTLevelEvidence(t, steps) {
  const level = Number(t.test_level);
  const groups = [
    {level: 1, ids: ['repo_reachable', 'archive_readable', 'metadata_check']},
    {level: 2, ids: ['restore_probe', 'sample_restore']},
    {level: 3, ids: ['integrity_check', 'integrity_compare']},
  ];
  return `<section class="rt-level-evidence"><h3>${escHtml(restoreTestsT('cumulativeScope'))}</h3>${groups.map(group => {
    const included = Number.isFinite(level) && level >= group.level;
    const relevant = steps.filter(s => group.ids.includes(s.step_id));
    let label = 'notInScope';
    let status = 'neutral';
    if (included) {
      if (relevant.some(s => s.status === 'failed')) { label = 'failed'; status = 'error'; }
      else if (relevant.length && relevant.every(s => s.status === 'passed') && (group.level !== 1 || group.ids.every(id => relevant.some(s => s.step_id === id))) && (group.level !== 3 || (t.level3_details?.enabled === true && Number(t.level3_details.success_count) > 0 && !Number(t.level3_details.failed_count)))) { label = 'successful'; status = 'success'; }
      else label = 'scopeNotDocumented';
    }
    const l3 = t.level3_details || {};
    const count = Number(l3.success_count);
    return `<div class="rt-level-row"><span class="rt-level-tag">L${group.level}</span><div><strong>${escHtml(restoreTestsT(`scopeL${group.level}`))}</strong><small>${escHtml(restoreTestsT(`scopeL${group.level}Detail`))}</small>${included && group.level === 3 && l3.enabled === true && Number.isFinite(count) ? `<small>${escHtml(restoreTestsT('sampleReadCount', {count}))}</small>` : ''}</div><span class="rt-attempt-status ${status}">${restoreTestsStatusIcon(status)}${escHtml(restoreTestsT(label))}</span></div>`;
  }).join('')}</section>`;
}

/** Render an inline report; success is scoped evidence, cancellation is only an attempt. */
function renderRTReportRow(t, idx, opened = false) {
  const status = rtAttemptStatus(t);
  const successful = t.test_result === 'success' && !rtCancelled(t);
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const plan = restoreTestsState.plan?.jobs?.find(job => job.job_key === t.job_key);
  const stats = t.archive_stats || {};
  const fmt = t.archive_stats_formatted || {};
  const coverage = t.test_coverage_percentage ?? t.coverage_percent;
  const validUntil = t.valid_until || t.valid_until_date || (plan?.verification_evidence_date === t.test_date ? plan.verification_valid_until : '');
  const validity = rtEvidenceStale(t) ? 'evidenceExpired' : 'evidencePolicy';
  const archivedProof = (restoreTestsState.data || []).some(r => r.job_key === t.job_key && r.test_date === plan?.verification_evidence_date && r.test_result === 'success' && !rtCancelled(r));
  const previous = rtCancelled(t) && plan?.verification_status === 'verified' && archivedProof
    && _rtTs({test_date: plan.verification_evidence_date}) > 0
    && _rtTs({test_date: plan.verification_evidence_date}) <= _rtTs(t);
  const errorText = !successful && !rtCancelled(t) && t.test_result !== 'skipped' ? restoreTestFailureMessage(t) : '';
  const detailText = t.error_analysis?.error_details || t.failure_hint || '';
  return `<details id="rtr-${idx}" class="rt-report-entry" data-report-identity="${escHtml(rtReportIdentity(t))}" ${opened ? 'open' : ''}>
    <summary><span class="rt-report-list-job"><strong>${escHtml(restoreTestJobName(t))}</strong><small>${escHtml(t.test_date || '—')} · ${escHtml(restoreTestsLocationLabel(t.location))}</small></span><span class="rt-attempt-status ${status.className}">${restoreTestsStatusIcon(status.className)}${escHtml(status.label)}</span></summary>
    <article class="rt-report-card ${successful ? 'rt-proof-document' : 'rt-attempt-document'}">
      <header class="rt-report-card-head rt-report-hero"><div><div class="rt-report-kicker">Borg Backup UI · ${escHtml(restoreTestsT('report'))}</div><h3 class="rt-report-title">${escHtml(restoreTestsT(successful ? 'restorationEvidence' : 'attemptReport'))}</h3><div class="rt-report-subtitle">${escHtml(restoreTestJobName(t))}</div></div><div class="rt-report-result ${status.className}"><span class="rt-report-result-mark">${restoreTestsStatusIcon(status.className)}</span><strong>${escHtml(status.label)}</strong></div></header>
      <div class="rt-report-verdict"><strong>${escHtml(restoreTestsT(successful ? 'scopePassed' : rtCancelled(t) ? 'cancelledNoEvidence' : 'noNewEvidence'))}</strong>${successful ? `<small>${escHtml(validUntil ? restoreTestsT('proofValidUntil', {date: validUntil}) : restoreTestsT(validity))}${validUntil && rtEvidenceStale(t) ? ` · ${escHtml(restoreTestsT('evidenceExpired'))}` : ''}</small>` : ''}</div>
      ${previous ? `<div class="rt-previous-proof"><span>${escHtml(restoreTestsT('previousEvidenceValid', {date: plan.verification_evidence_date}))}</span><button type="button" class="rt-text-button" data-rt-action="evidence" data-job-key="${escHtml(t.job_key)}" data-evidence-date="${escHtml(plan.verification_evidence_date)}">${escHtml(restoreTestsT('openEvidence'))} →</button></div>` : ''}
      ${errorText ? `<div class="rt-report-alert">${escHtml(errorText)}${detailText ? `<p>${escHtml(detailText)}</p>` : ''}</div>` : ''}
      ${!successful ? `<details class="rt-attempt-details"><summary>${escHtml(restoreTestsT('attemptDetails'))}</summary>` : ''}
      <div class="rt-report-sections">${rtReportSection(restoreTestsT('execution'), [
        [restoreTestsT('archive'), t.tested_archive || t.archive_name || restoreTestsT('noArchive'), true],
        [restoreTestsT('repository'), t.repository, true],
        [restoreTestsT('testTime'), t.test_date],
        [restoreTestsT('duration'), t.duration_formatted || '—'],
        [restoreTestsT('level'), t.test_level != null ? `L${t.test_level}` : '—'],
      ])}${rtReportSection(restoreTestsT('testScope'), [
        [restoreTestsT('originalSize'), fmt.original || '—'],
        [restoreTestsT('archiveFiles'), stats.files_count],
        [restoreTestsT('testedFiles'), t.tested_files_count ?? t.tested_files],
        [restoreTestsT('testedFolders'), t.tested_folders_count],
        [restoreTestsT('coverage'), coverage != null ? formatCoveragePercent(coverage) : '—'],
        [restoreTestsT('basis'), t.coverage_basis],
      ])}</div>
      ${renderRTLevelEvidence(t, steps)}
      <p class="rt-proof-scope-note">${escHtml(restoreTestsT(successful ? 'evidenceScopeLimit' : 'attemptScopeLimit'))}</p>
      ${renderRTTechnicalEvidence(t, steps)}
      ${!successful ? '</details>' : ''}
      <footer class="rt-proof-footer">${escHtml(restoreTestsT('evidenceSource'))}</footer>
    </article>
  </details>`;
}

function rtReportSection(title, items) {
  const rows = (items || []).filter(([, value]) => value != null && value !== '').map(([label, value, mono]) => `
    <div><dt>${escHtml(label)}</dt><dd class="${mono ? 'rt-report-mono' : ''}">${escHtml(String(value))}</dd></div>`).join('');
  return `<section><header>${escHtml(title)}</header><dl>${rows}</dl></section>`;
}

/** Render each recorded check once, keeping its evidence alongside the outcome.
 * @param {Array<object>} steps Recorded checks in execution order.
 * @param {object} report Source report for file lists, hashes and check metadata.
 * @returns {string} Escaped check markup, or an empty string without recorded steps.
 */
function renderRTStepsTable(steps, report = {}) {
  const rows = Array.isArray(steps) ? steps : [];
  if (!rows.length) return '';
  const list = rows.map((s, i) => {
    const ms = Number(s.duration_ms || 0);
    const dur = ms > 0 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : '—';
    const st = String(s.status || '').toLowerCase();
    const statusText = st === 'passed' ? 'OK' : (st === 'failed' ? restoreTestsT('failed') : (st === 'not_tested' ? restoreTestsT('notTested') : st));
    const statusClass = st === 'passed' ? 'success' : (st === 'failed' ? 'error' : 'warning');
    const evidence = renderRTStepDetails(s, report) + rtStepDetailsBlock([[restoreTestsT('errorCode'), s.error_code]]);
    return `<div class="rt-step-row">
      <div class="rt-step-index">${i + 1}</div>
      <div class="rt-step-main">
        <div class="rt-step-head">
          <div class="rt-step-title">${escHtml(rtStepLabel(String(s.step_id || '')))}</div>
        </div>
        <div class="rt-step-message">${escHtml(restoreTestStepMessage(s))}</div>
        <div class="rt-step-command">${escHtml(s.command || '—')}</div>
        ${evidence ? `<details class="rt-check-evidence"><summary>${escHtml(restoreTestsT('checkEvidence'))}</summary>${evidence}</details>` : ''}
      </div>
      <span class="rt-step-status ${statusClass}">${escHtml(statusText || '—')}</span>
      <div class="rt-step-duration">${escHtml(dur)}</div>
    </div>`;
  }).join('');
  const passed = rows ? steps.filter((step) => String(step.status || '').toLowerCase() === 'passed').length : 0;
  return `<div class="rt-steps-panel">
    <div class="rt-steps-heading"><span><strong>${escHtml(restoreTestsT('steps'))}</strong><small>${escHtml(restoreTestsT('stepsSubtitle'))}</small></span><span class="history-status-badge ${passed === steps.length ? 'success' : 'warning'}">${escHtml(restoreTestsT('stepsPassedCount', { passed, total: steps.length }))}</span></div>
    <div class="rt-steps-list">${list}</div>
  </div>`;
}

/** Render the single technical disclosure, with diagnostics and per-check evidence.
 * Legacy reports without matching checks retain their file lists and hashes here.
 * Report ID and repeated run start/end are intentionally not presented.
 * @param {object} report Stored report; never modified by this renderer.
 * @param {Array<object>} steps Recorded checks.
 * @returns {string} Escaped disclosure markup, or empty when no evidence is available.
 */
function renderRTTechnicalEvidence(report, steps) {
  const rows = Array.isArray(steps) ? steps : [];
  const diagnostics = rtStepDetailsBlock([
    [restoreTestsT('runLogFile'), report.log_file, true],
    [restoreTestsT('exitCode'), report.test_exit_code],
    [restoreTestsT('errorCode'), report.failure_code],
  ]);
  const remainingEntries = rows.some(step => ['restore_probe', 'sample_restore'].includes(step.step_id))
    ? '' : rtStepEntriesBlock(Array.isArray(report.tested_entries) ? report.tested_entries : []);
  const remainingHashes = rows.some(step => ['integrity_check', 'integrity_compare'].includes(step.step_id))
    ? '' : rtStepChecksumsBlock(report.level3_details || {});
  const metadata = rows.some(step => step.step_id === 'metadata_check') ? '' : rtStepDetailsBlock([
    [restoreTestsT('compressedSize'), report.archive_stats_formatted?.compressed],
    [restoreTestsT('deduplicatedSize'), report.archive_stats_formatted?.deduplicated],
    [restoreTestsT('reportSchema'), report.report_schema_version],
  ]);
  const checks = renderRTStepsTable(rows, report);
  if (!diagnostics && !metadata && !checks && !remainingEntries && !remainingHashes) return '';
  return `<details class="rt-technical-evidence"><summary>${escHtml(restoreTestsT('technicalEvidence'))}</summary><div>
    ${diagnostics ? `<div class="rt-report-diagnostics">${diagnostics}</div>` : ''}
    ${checks}${metadata}${remainingEntries}${remainingHashes}
  </div></details>`;
}

function rtStepLabel(stepId) {
  const map = {
    resource_guard: restoreTestsT('stepResourceGuard'),
    repo_reachable: restoreTestsT('stepRepoReachable'),
    archive_readable: restoreTestsT('stepArchiveReadable'),
    metadata_check: restoreTestsT('stepMetadata'),
    sample_restore: restoreTestsT('stepSampleRestore'),
    restore_probe: restoreTestsT('stepRestoreProbe'),
    integrity_compare: restoreTestsT('stepIntegrityCompare'),
    integrity_check: restoreTestsT('stepIntegrityCheck'),
    cleanup: restoreTestsT('stepCleanup'),
  };
  return map[stepId] || stepId || restoreTestsT('stepDefault');
}

function renderRTStepDetails(step, report) {
  const stepId = String(step?.step_id || '');
  const stats = report.archive_stats || {};
  const fmt = report.archive_stats_formatted || {};
  const l3 = report.level3_details || {};
  const entries = Array.isArray(report.tested_entries) ? report.tested_entries : [];
  const compression = stats.original_size > 0 && stats.compressed_size > 0
    ? `${Math.round((1 - stats.compressed_size / stats.original_size) * 100)}%`
    : '';

  if (stepId === 'repo_reachable') {
    return rtStepDetailsBlock([
      [restoreTestsT('repository'), report.repository, true],
      [restoreTestsT('site'), restoreTestsLocationLabel(report.location || '')],
      [restoreTestsT('testTime'), step.timestamp],
    ]);
  }
  if (stepId === 'archive_readable') {
    return rtStepDetailsBlock([
      [restoreTestsT('archive'), report.tested_archive || report.archive_name, true],
      [restoreTestsT('repository'), report.repository, true],
      [restoreTestsT('foundAt'), step.timestamp],
    ]);
  }
  if (stepId === 'metadata_check') {
    return rtStepDetailsBlock([
      [restoreTestsT('archiveFiles'), stats.files_count],
      [restoreTestsT('originalSize'), fmt.original],
      [restoreTestsT('compressedSize'), fmt.compressed],
      [restoreTestsT('deduplicatedSize'), fmt.deduplicated],
      [restoreTestsT('compressionRate'), compression],
      [restoreTestsT('reportSchema'), report.report_schema_version],
    ]);
  }
  if (stepId === 'restore_probe' || stepId === 'sample_restore') {
    return rtStepDetailsBlock([
      [restoreTestsT('testedFiles'), report.tested_files_count || report.tested_files],
      [restoreTestsT('testedFolders'), report.tested_folders_count],
      [restoreTestsT('testedEntries'), report.tested_total_count],
      [restoreTestsT('coverageMode'), report.test_coverage],
      [restoreTestsT('coverage'), formatCoveragePercent(report.test_coverage_percentage || report.coverage_percent || 0)],
      [restoreTestsT('basis'), report.coverage_basis],
    ]) + rtStepEntriesBlock(entries);
  }
  if (stepId === 'integrity_check' || stepId === 'integrity_compare') {
    return rtStepDetailsBlock([
      [restoreTestsT('sampleSize'), l3.sample_size],
      [restoreTestsT('successful'), l3.success_count],
      [restoreTestsT('failed'), l3.failed_count],
    ]) + rtStepChecksumsBlock(l3);
  }
  if (stepId === 'cleanup') {
    return rtStepDetailsBlock([
      [restoreTestsT('cleanupStatus'), restoreTestStepMessage(step)],
      [restoreTestsT('testTime'), step.timestamp],
      [restoreTestsT('exitCode'), report.test_exit_code],
    ]);
  }
  return rtStepDetailsBlock([
    [restoreTestsT('testTime'), step.timestamp],
  ]);
}

function rtStepDetailsBlock(items) {
  const rows = (items || [])
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value, mono]) => `<div class="rt-step-detail-item">
      <span>${escHtml(label)}</span>
      <strong class="${mono ? 'rt-report-mono' : ''}">${escHtml(String(value))}</strong>
    </div>`)
    .join('');
  if (!rows) return '';
  return `<div class="rt-step-details">${rows}</div>`;
}

function rtStepChecksumsBlock(l3) {
  const checksums = (l3?.checksums || []).map((item) => {
    const raw = String(item || '');
    const sep = raw.lastIndexOf(':');
    const path = sep > 0 ? raw.slice(0, sep) : raw;
    const sha = sep > 0 ? raw.slice(sep + 1) : '';
    return `<div class="rt-checksum-row">
      <div class="rt-checksum-path">${escHtml(path)}</div>
      ${sha ? `<div class="rt-checksum-hash">${escHtml(sha)}</div>` : ''}
    </div>`;
  }).join('');
  const failed = (l3?.failed_files || []).map((path) =>
    `<div class="rt-checksum-row failed"><div class="rt-checksum-path">${escHtml(path)}</div></div>`
  ).join('');
  if (!checksums && !failed) return '';
  return `<details class="rt-step-detail-section">
    <summary>${escHtml(restoreTestsT('sampleFiles', { count: (l3?.checksums || []).length + (l3?.failed_files || []).length }))}</summary>
    <div class="rt-checksum-list">${checksums}${failed}</div>
  </details>`;
}

function rtStepEntriesBlock(entries) {
  if (!entries.length) return '';
  const items = entries.map((entry) => {
    const raw = String(entry || '');
    const isDir = raw.startsWith('d ');
    const isFile = raw.startsWith('- ');
    const path = isDir || isFile ? raw.slice(2) : raw;
    return `<div class="rt-tested-entry ${isDir ? 'dir' : 'file'}">
      <span>${escHtml(isDir ? restoreTestsT('folder') : restoreTestsT('file'))}</span>
      <strong>${escHtml(path)}</strong>
    </div>`;
  }).join('');
  return `<details class="rt-step-detail-section">
    <summary>${escHtml(restoreTestsT('testedEntriesCount', { count: entries.length }))}</summary>
    <div class="rt-tested-entry-list">${items}</div>
  </details>`;
}

window.addEventListener?.('bbui:language-changed', () => {
  if (!restoreTestsState.loaded) return;
  renderRestorePlan(restoreTestsState.plan);
  renderRTReportFilterOptions(restoreTestsState.data || []);
  renderRestoreTests(restoreTestsState.data || []);
  renderRestoreTestsSubtab();
  renderRestoreTestsSidebar();
  updateRestoreTestsWorkspace();
  refreshRestoreTestJobsForSelection();
  if (restoreTestsState.logState) {
    setRTLogStatus(restoreTestsState.logState, restoreTestsState.logExitCode);
  }
});
