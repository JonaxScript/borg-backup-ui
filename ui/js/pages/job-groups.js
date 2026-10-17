/** Ordered job groups sharing the existing job list, runner and themed log panel. */
(function () {
  'use strict';
  const state = { view: 'jobs', groups: [], hooks: {}, selected: '', editor: null, history: [], historyRun: '', follow: true, followedRun: '', signature: '', saving: false, logRequest: 0, picker: null, editorBaseline: '', confirming: false };
  const t = (key, values) => jobsT('jobGroups.' + key, values);
  const escape = value => escHtml(String(value ?? ''));
  const admin = () => _coreState().currentRole === 'admin';
  const operator = () => _coreState().currentRole !== 'viewer';
  const active = run => run && run.status === 'running';
  const group = () => state.groups.find(g => g.id === state.selected);
  const jobName = key => { const j = jobsState.jobs.find(j => j.key === key); return j?.name || j?.display_name || key; };
  const status = value => t('states.' + (value || 'pending'));
  const scheduleText = schedule => {
    if (!schedule?.enabled) return t('scheduleOff');
    const form = parseSchedule(schedule.cron);
    return form.mode === 'custom' ? schedule.cron : t(form.mode) + ' · ' + form.time
      + (form.mode === 'weekly' ? ' · ' + t('days.' + form.weekday) : form.mode === 'monthly' ? ' · ' + t('day') + ' ' + form.day : '');
  };

  /** JSON requests preserve the server's validation errors and never mutate schedules implicitly. */
  async function request(url, method = 'GET', body) {
    const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.message || data.error?.message || data.error || `HTTP ${response.status}`);
    return data;
  }

  /** Reload group state; retain editor values and reuse the live log DOM across updates. */
  async function load() {
    const data = await request('/api/job-groups');
    state.groups = data.groups || [];
    state.hooks = data.hooks || {};
    if (!group()) state.selected = state.groups[0]?.id || '';
    if (group()?.run) state.history = [group().run, ...state.history.filter(r => r.group_id === state.selected && r.run_id !== group().run.run_id)].slice(0, 50);
    if (state.view === 'groups' && !state.editor) render();
  }

  /** Render group links; compact dashboard badges retain the full step in accessible text. */
  function membership(job, compact = false) {
    return (job.groups || []).map(g => {
      const step = t('step', { current: g.position, total: g.total });
      const detail = `${t('groupLabel')} ${g.name} · ${step}`;
      if (compact) return `<div class="job-group-membership job-group-membership--compact" title="${escape(detail)}"><span aria-hidden="true">↗</span><button class="job-group-link" data-group-action="open" data-group-id="${escape(g.id)}" aria-label="${escape(detail)}">${escape(g.name)}</button><span class="job-group-position" aria-label="${escape(step)}">${escape(g.position)}/${escape(g.total)}</span></div>`;
      return `<div class="job-group-membership">↗ ${escape(t('groupLabel'))} <button class="job-group-link" data-group-action="open" data-group-id="${escape(g.id)}">${escape(g.name)}</button> · ${escape(step)}</div>`;
    }).join('');
  }

  /** Show group schedules separately from the unchanged individual schedule. */
  function schedules(job) {
    return (job.groups || []).map(g => `<div class="job-schedule-info">↗ ${escape(t('groupSchedule', { name: g.name, schedule: scheduleText(g.schedule) }))}</div>`).join('');
  }

  /** Switch only the Jobs workspace; standalone job actions remain available. */
  async function view(next, selected) {
    if (!await confirmDiscardEditor()) return;
    state.editor = null;
    if (selected) { state.selected = selected; state.historyRun = ''; state.followedRun = ''; }
    state.view = next;
    state.followedRun = ''; state.logRequest++;
    document.getElementById('jobs-new-btn').classList.toggle('hidden', next !== 'jobs');
    document.getElementById('groups-new-btn').classList.toggle('hidden', next !== 'groups' || !admin());
    closeLogPanel();
    document.querySelector('#page-jobs .jobs-location-layout').classList.toggle('hidden', next !== 'jobs');
    document.getElementById('job-groups-pane').classList.toggle('hidden', next !== 'groups');
    document.querySelectorAll('[data-group-view]').forEach(b => {
      b.classList.toggle('is-active', b.dataset.groupView === next);
      b.setAttribute('aria-selected', String(b.dataset.groupView === next));
    });
    if (next === 'groups') { state.signature = ''; render(); history().catch(e => showJobsError(e.message)); }
    else { document.querySelector('#page-jobs .jobs-workspace').appendChild(document.getElementById('log-panel')); renderJobsGrid(jobsState.jobs); }
  }

  function button(action, label, extra = '', cls = 'btn btn-secondary btn-sm') {
    return `<button type="button" class="${cls}" data-group-action="${action}" ${extra}>${escape(label)}</button>`;
  }

  /** Reuse the Jobs context navigation, including icons, counts and selection state. */
  function sidebar() {
    return `<aside class="ui-context-sidebar"><div class="ui-context-sidebar__header"><small>${escape(t('sequences'))}</small><strong>${escape(t('title'))}</strong></div><nav class="ui-context-nav">${state.groups.map(g => `<button type="button" class="ui-context-nav__item group-nav-item ${g.id === state.selected ? 'is-active' : ''}" data-group-action="select" data-group-id="${escape(g.id)}" ${g.id === state.selected ? 'aria-current="page"' : ''}><span class="location-nav-glyph all">${jobsLocationGlyph('all')}</span><span class="location-nav-copy"><strong>${escape(g.name)}</strong><small>${escape(scheduleText(g.schedule))}</small></span><span class="ui-badge">${g.jobs.length}</span></button>`).join('')}</nav>${admin() ? button('new', '+ ' + t('new'), '', 'btn btn-secondary group-new') : ''}</aside>`;
  }

  /** Render the same configured icon as the individual job card. */
  function jobIcon(key) {
    const job = jobsState.jobs.find(j => j.key === key);
    const color = resolveJobIconColor(job);
    return `<span class="type-icon${color ? ' type-icon-color-' + color : ''}">${typeIcon(resolveJobIcon(job))}</span>`;
  }

  function badge(value, label) {
    const kind = ({ success: 'success', failed: 'error', interrupted: 'error', running: 'running', warning: 'warning' })[value] || 'neutral';
    return `<span class="ui-badge ui-badge--${kind}">${escape(label || status(value))}</span>`;
  }

  /** Combine queue position and outcome without relying on color alone. */
  function stepMarker(step, index) {
    const value = step.status || 'pending';
    const symbol = value === 'success' ? '✓' : ['failed', 'interrupted'].includes(value) ? '!' : value === 'warning' ? '!' : index + 1;
    return `<span class="group-order group-order--${escape(value)}" title="${escape(String(index + 1) + ': ' + status(value))}" aria-label="${escape(String(index + 1) + ': ' + status(value))}">${symbol}</span>`;
  }

  /** Render group progress without replacing the active log transport or editor. */
  function render() {
    if (state.view !== 'groups') return;
    const el = document.getElementById('job-groups-pane');
    if (!el || state.editor) return;
    const signature = JSON.stringify([state.groups, state.selected, state.historyRun, state.history, _coreState().currentRole, jobsState.jobs.map(j => [j.key, j.running, j.run_id, j.run_phase, j.cancel_allowed, j.cancel_requested])]);
    if (signature === state.signature) return;
    state.signature = signature;
    const log = document.getElementById('log-panel');
    if (el.contains(log)) el.after(log);
    const g = group();
    if (!g) { closeLogPanel(); el.innerHTML = sidebar() + `<section class="ui-workspace"><div class="ui-empty">${escape(t('empty'))}</div></section>`; return; }
    const run = state.historyRun ? state.history.find(r => r.run_id === state.historyRun) : g.run;
    const steps = run?.steps || g.jobs.map(job_key => ({ job_key, status: 'pending' }));
    const selectedIndex = steps.findIndex(s => s.status === 'running');
    const running = active(g.run);
    const ownSchedule = g.jobs.filter(key => _coreSchedules()[key]?.enabled);
    const canRun = operator() && _isDataDirReady() && !g.missing_jobs?.length;
    el.innerHTML = sidebar() + `<section class="ui-workspace group-workspace">
      <header class="ui-workspace-header"><div class="ui-workspace-header__title"><span class="group-eyebrow">${escape(t('sequence'))}</span><h2>${escape(g.name)}</h2><p>${escape(g.description)}</p><span>${escape(t('groupStart', { schedule: scheduleText(g.schedule) }))} · ${g.jobs.length} ${escape(t('jobs'))}</span></div><div class="group-actions">
      ${admin() ? button('edit', t('edit'), '', 'btn btn-secondary') : ''}
      ${admin() && !running ? button('delete', t('delete'), '', 'btn btn-secondary') : ''}
      ${running ? (operator() ? button('stop', g.run.stop_requested ? t('stopRequested') : t('stop'), g.run.stop_requested ? 'disabled' : '', 'btn btn-secondary') : '') : (operator() ? button('start', t('start'), canRun ? '' : 'disabled', 'btn btn-primary') : '')}</div></header>
      ${g.missing_jobs?.length ? `<div class="status-message error">${escape(t('missing'))}</div>` : ''}
      ${ownSchedule.length ? `<div class="status-message warning">${escape(t('additionalSchedules', { count: ownSchedule.length }))}</div>` : ''}
      <div class="group-run-header"><div><strong>${escape(t('execution'))}</strong> ${badge(run?.status, selectedIndex >= 0 ? t('progress', { current: selectedIndex + 1, total: steps.length }) : run ? status(run.status) : t('ready'))}</div>
      <label>${escape(t('history'))} <select id="group-history-select"><option value="">${escape(t('latest'))}</option>${state.history.filter(r => r.run_id !== g.run?.run_id).map(r => `<option value="${escape(r.run_id)}" ${r.run_id === state.historyRun ? 'selected' : ''}>${escape(new Date(r.started_at).toLocaleString())} · ${escape(status(r.status))}</option>`).join('')}</select></label></div>
      <div class="group-run-list">${steps.map((step, index) => {
        const job = jobsState.jobs.find(j => j.key === step.job_key);
        const isLive = step.status === 'running' && job?.running && job.run_id === step.run_id;
        return `<article class="group-run-row ${step.status === 'running' ? 'is-running' : ''}">${stepMarker(step, index)}${jobIcon(step.job_key)}<div class="group-job-title"><strong>${escape(jobName(step.job_key))}</strong><small>${escape(job?.archive_prefix || '')}</small><span>${escape(t('step', { current: index + 1, total: steps.length }))}</span>${step.error ? `<span class="group-error">${escape(step.error)}</span>` : ''}</div><div class="group-run-status">${badge(step.status)}${isLive && job.run_phase ? `<small>${escape(t('phases.' + job.run_phase) === 'jobGroups.phases.' + job.run_phase ? job.run_phase : t('phases.' + job.run_phase))}</small>` : ''}</div><div class="group-actions">${isLive || step.log_file ? button('log', isLive ? t('liveLog') : t('log'), `data-step="${index}"`) : ''}${isLive && operator() && job.cancel_allowed && !job.cancel_requested ? button('cancel', t('cancelJob'), `data-step="${index}"`) : ''}</div></article>`;
      }).join('')}</div>
      <label class="group-follow"><input id="group-follow" type="checkbox" ${state.follow ? 'checked' : ''}> ${escape(t('follow'))}</label><div id="group-log-slot"></div>
      <p class="group-help">${escape(t('coordination'))}</p>${run?.error ? `<p class="group-error">${escape(run.error)}</p>` : ''}
    </section>`;
    document.getElementById('group-log-slot').appendChild(log);
    followLog(run);
  }

  /** Follow the active step or latest saved log, including steps completed between polls. */
  function followLog(run) {
    if (!state.follow || state.historyRun || !run) return;
    const steps = run.steps || [];
    const step = steps.find(s => s.status === 'running')
      || [...steps].reverse().find(s => s.log_file);
    if (!step) return;
    const job = jobsState.jobs.find(j => j.key === step.job_key);
    const live = step.status === 'running' && job?.running && job.run_id === step.run_id;
    // A stale jobs response must not pin a run before its live transport is available.
    if (step.status === 'running' && !live) return;
    const key = JSON.stringify([run.run_id, step.job_key, step.run_id, live ? 'live' : step.log_file]);
    if (key === state.followedRun) return;
    state.followedRun = key;
    showLog(step, run).catch(e => {
      if (state.followedRun !== key) return;
      state.followedRun = '';
      state.signature = '';
      showJobsError(e.message);
    });
  }

  /** Reuse the fixed-size themed log viewport; historical logs use confined history access. */
  async function showLog(step, run) {
    const requestId = ++state.logRequest;
    const selected = state.selected;
    const job = jobsState.jobs.find(j => j.key === step.job_key);
    if (step.status === 'running' && job?.running && job.run_id === step.run_id) {
      openLogPanel(step.job_key, step.run_id);
      document.getElementById('group-log-slot').appendChild(document.getElementById('log-panel'));
    } else if (step.log_file) {
      closeLogPanel();
      const data = await request('/api/history/log?file=' + encodeURIComponent(step.log_file));
      if (requestId !== state.logRequest || selected !== state.selected || state.view !== 'groups' || state.editor) return;
      document.getElementById('group-log-slot').appendChild(document.getElementById('log-panel'));
      document.getElementById('log-output').textContent = data.content || t('noLog');
      document.getElementById('log-panel').classList.remove('hidden');
      setLogStatus(step.status === 'failed' ? 'error' : step.status, step.exit_code);
    }
    document.getElementById('log-panel-title-text').removeAttribute('data-i18n');
    document.getElementById('log-panel-title-text').textContent = t('logTitle', { job: jobName(step.job_key), group: run?.group_name || group()?.name });
  }

  /** Load archived runs only for the still-selected group; propagate API failures. */
  async function history() {
    const id = state.selected;
    if (!id) return;
    const data = await request('/api/job-groups/history?id=' + encodeURIComponent(id));
    if (id !== state.selected) return;
    state.history = data.runs || [];
    render();
  }

  /** Convert supported simple expressions to form fields; preserve all others as custom cron. */
  function parseSchedule(cron) {
    const parts = (cron || '0 2 * * *').split(/\s+/);
    if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return { mode: 'custom', time: '02:00', day: '1', weekday: '0' };
    const time = parts[1].padStart(2, '0') + ':' + parts[0].padStart(2, '0');
    if (parts.slice(2).join(' ') === '* * *') return { mode: 'daily', time, day: '1', weekday: '0' };
    if (parts[2] === '*' && parts[3] === '*' && /^[0-6]$/.test(parts[4])) return { mode: 'weekly', time, weekday: parts[4], day: '1' };
    if (/^\d+$/.test(parts[2]) && parts[3] === '*' && parts[4] === '*') return { mode: 'monthly', time, day: parts[2], weekday: '0' };
    return { mode: 'custom', time, day: '1', weekday: '0' };
  }

  /** Preserve unsaved fields before reordering or changing schedule controls. */
  function readEditor() {
    const form = document.getElementById('group-editor');
    if (!form || !state.editor) return;
    const get = name => form.elements.namedItem(name);
    Object.assign(state.editor, { name: get('name').value, description: get('description').value, on_error: get('on_error').value,
      schedule: { enabled: get('enabled').checked, cron: get('cron').value }, mode: get('mode').value,
      time: get('time').value, day: get('day').value, weekday: get('weekday').value });
  }

  /** Open a detached draft; editing a running group only affects future runs. */
  function edit(isNew) {
    const g = isNew ? { name: '', description: '', jobs: [], on_error: 'stop', schedule: { enabled: false, cron: '0 2 * * *' } } : group();
    if (!g) return;
    closeLogPanel(); state.logRequest++; state.followedRun = '';
    state.editor = { ...JSON.parse(JSON.stringify(g)), ...parseSchedule(g.schedule.cron) };
    state.picker = { open: false, query: '', location: '', selected: [] };
    renderEditor();
    readEditor();
    state.editorBaseline = editorSnapshot();
  }

  /** Build the group form from its draft using existing Settings surfaces. */
  function renderEditor() {
    const g = state.editor;
    const pane = document.getElementById('job-groups-pane');
    const log = document.getElementById('log-panel');
    if (pane.contains(log)) pane.after(log);
    const withSchedules = g.jobs.filter(k => _coreSchedules()[k]?.enabled);
    pane.innerHTML = sidebar() + `<section class="ui-workspace group-workspace"><form id="group-editor"><header class="ui-workspace-header"><div class="ui-workspace-header__title"><span class="group-eyebrow">${escape(t('settings'))}</span><h2>${escape(g.id ? g.name : t('new'))}</h2><span class="ui-workspace-header__subtitle">${escape(t('nextRunChanges'))}</span></div><div class="group-actions">${button('discard', t('cancel'))}<button type="submit" class="btn btn-primary">${escape(t('save'))}</button></div></header><section class="ui-panel group-section"><div class="ui-panel__header"><h3>${escape(t('general'))}</h3></div><div class="group-section-body group-basics">
      <label>${escape(t('name'))}<input name="name" required maxlength="100" value="${escape(g.name)}"></label>
      <label>${escape(t('description'))}<textarea name="description" maxlength="2000">${escape(g.description)}</textarea></label>
      </div></section><section class="ui-panel group-section"><div class="ui-panel__header"><h3>${escape(t('order'))}</h3><span>${escape(t('orderHint'))}</span></div><div class="group-section-body"><div class="group-editor-jobs">${g.jobs.map((key, i) => `<div class="group-editor-row" draggable="true" data-group-drag="${i}"><span class="group-drag-handle" title="${escape(t('drag'))}" aria-hidden="true">⠿</span><span class="group-order">${i + 1}</span>${jobIcon(key)}<div><strong>${escape(jobName(key))}</strong><small>${escape(jobsLocationLabel(jobsState.jobs.find(j => j.key === key)?.location))} · ${escape(jobsState.jobs.find(j => j.key === key)?.archive_prefix || '')}</small><small>${['pre', 'post'].filter(p => state.hooks[key]?.[p]).map(p => `${p === 'pre' ? 'Pre' : 'Post'}: ${escape(state.hooks[key][p])}`).join(' · ') || escape(t('noScripts'))}</small></div><div class="group-actions">${button('up', '↑', `data-step="${i}" aria-label="${escape(t('up'))}" ${i === 0 ? 'disabled' : ''}`)}${button('down', '↓', `data-step="${i}" aria-label="${escape(t('down'))}" ${i === g.jobs.length - 1 ? 'disabled' : ''}`)}${button('remove', t('remove'), `data-step="${i}"`)}</div></div>`).join('')}</div>
      ${pickerMarkup()}
      <p class="group-help">${escape(t('jobSettings'))}</p>
      </div></section><div class="group-settings-columns"><section class="ui-panel group-section"><div class="ui-panel__header"><h3>${escape(t('schedule'))}</h3></div><div class="group-section-body"><label class="group-checkbox"><input type="checkbox" name="enabled" ${g.schedule.enabled ? 'checked' : ''}>${escape(t('scheduleEnabled'))}</label>
      <div id="group-schedule-fields" class="group-schedule-fields ${g.schedule.enabled ? '' : 'hidden'}"><label>${escape(t('frequency'))}<select name="mode">${['daily', 'weekly', 'monthly', 'custom'].map(mode => `<option value="${mode}" ${g.mode === mode ? 'selected' : ''}>${escape(t(mode))}</option>`).join('')}</select></label>
      <label class="${g.mode === 'custom' ? 'hidden' : ''}">${escape(t('time'))}<input name="time" type="time" value="${escape(g.time)}"></label>
      <label class="${g.mode === 'weekly' ? '' : 'hidden'}">${escape(t('weekday'))}<select name="weekday">${Array.from({ length: 7 }, (_, i) => `<option value="${i}" ${String(i) === g.weekday ? 'selected' : ''}>${escape(t('days.' + i))}</option>`).join('')}</select></label>
      <label class="${g.mode === 'monthly' ? '' : 'hidden'}">${escape(t('day'))}<input name="day" type="number" min="1" max="31" value="${escape(g.day)}"></label>
      <label class="${g.mode === 'custom' ? '' : 'hidden'}">Cron<input name="cron" value="${escape(g.schedule.cron)}"></label></div>
      </div></section><section class="ui-panel group-section"><div class="ui-panel__header"><h3>${escape(t('behavior'))}</h3></div><div class="group-section-body"><label>${escape(t('errorPolicy'))}<select name="on_error"><option value="stop" ${g.on_error === 'stop' ? 'selected' : ''}>${escape(t('stopOnError'))}</option><option value="continue" ${g.on_error === 'continue' ? 'selected' : ''}>${escape(t('continueOnError'))}</option></select></label><p class="group-help">${escape(t('coordination'))}</p></div></section></div>
      ${withSchedules.length ? `<div class="status-message warning">${escape(t('additionalSchedules', { count: withSchedules.length }))}${withSchedules.map(key => button('schedule', t('editSchedule', { name: jobName(key) }), `data-job-key="${escape(key)}"`)).join('')}</div>` : ''}
      <p class="group-help">${escape(t('scheduleUnchanged'))}</p>
      <div class="group-actions group-editor-footer">${button('discard', t('cancel'))}<button type="submit" class="btn btn-primary">${escape(t('save'))}</button></div>
    </form></section>`;
  }

  /** Return selectable existing jobs; group members cannot be added twice. */
  function availableJobs() {
    return jobsState.jobs.filter(j => !state.editor.jobs.includes(j.key));
  }

  /** Render the expandable picker; search/filter updates replace only its results. */
  function pickerMarkup() {
    const available = availableJobs();
    const picker = state.picker;
    if (!available.length) return `<p class="group-help">${escape(t('allJobsAdded'))}</p>`;
    return `<div class="group-picker">
      ${button('picker-toggle', t('addJobs'), `aria-expanded="${picker.open}" aria-controls="group-picker-panel"`, 'btn btn-secondary')}
      <section id="group-picker-panel" class="group-picker-panel ${picker.open ? '' : 'hidden'}" aria-label="${escape(t('addJobs'))}">
        <p class="group-help">${escape(t('pickerHint'))}</p>
        <div class="group-picker-filters"><label>${escape(t('searchJobs'))}<input id="group-picker-query" type="search" autocomplete="off" value="${escape(picker.query)}" placeholder="${escape(t('searchPlaceholder'))}"></label>
        <label>${escape(t('location'))}<select id="group-picker-location"><option value="">${escape(jobsT('jobs.allLocations'))}</option>${[...new Set(available.map(j => j.location || ''))].filter(Boolean).map(location => `<option value="${escape(location)}" ${picker.location === location ? 'selected' : ''}>${escape(jobsLocationLabel(location))}</option>`).join('')}</select></label></div>
        <div id="group-picker-results" class="group-picker-results">${pickerResults()}</div>
        <div class="group-picker-footer"><span id="group-picker-count" aria-live="polite">${escape(t('selectedJobs', { count: picker.selected.length }))}</span><div class="group-actions">${button('picker-toggle', t('cancel'))}${button('add', t('addSelection'), picker.selected.length ? '' : 'disabled', 'btn btn-primary')}</div></div>
      </section></div>`;
  }

  /** Return escaped checkbox rows matching name, prefix and localized location. */
  function pickerResults() {
    const picker = state.picker;
    const query = picker.query.trim().toLocaleLowerCase();
    const available = availableJobs().filter(j => (!picker.location || j.location === picker.location)
      && [j.name, j.display_name, j.archive_prefix, j.location, jobsLocationLabel(j.location)].join(' ').toLocaleLowerCase().includes(query));
    return available.map(j => `<label class="group-picker-row ${picker.selected.includes(j.key) ? 'is-selected' : ''}">
      <input type="checkbox" data-group-pick="${escape(j.key)}" ${picker.selected.includes(j.key) ? 'checked' : ''}>
      ${jobIcon(j.key)}<span class="group-picker-identity"><strong>${escape(j.name || j.display_name || j.key)}</strong><small>${escape(j.archive_prefix || '')}</small></span>
      <span class="group-picker-location">${escape(jobsLocationLabel(j.location))}${j.enabled === false ? `<small>${escape(jobsT('jobs.disabled'))}</small>` : ''}</span>
    </label>`).join('') || `<p class="group-picker-empty" role="status">${escape(t('noMatchingJobs'))}</p>`;
  }

  /** Update the selected count without replacing the focused checkbox. */
  function updatePickerSelection() {
    document.getElementById('group-picker-count').textContent = t('selectedJobs', { count: state.picker.selected.length });
    document.querySelector('[data-group-action="add"]').disabled = !state.picker.selected.length;
  }

  /** Snapshot persisted editor fields; picker searches alone are not unsaved changes. */
  function editorSnapshot() {
    const g = state.editor;
    return g ? JSON.stringify([g.name, g.description, g.jobs, g.on_error, g.schedule,
      g.mode, g.time, g.day, g.weekday]) : '';
  }

  /** Check draft edits and pending job selections before leaving or unloading. */
  function hasEditorChanges() {
    if (!state.editor) return false;
    readEditor();
    return editorSnapshot() !== state.editorBaseline || !!state.picker?.selected.length;
  }

  /** Ask through the existing themed dialog; block duplicate prompts and restore focus. */
  async function confirmAction(options) {
    if (state.confirming) return false;
    state.confirming = true;
    const previous = document.activeElement;
    try {
      return !!await _openSettingsDialog({ ...options,
        onOpen: ({ modal }) => modal.querySelector('#settings-dialog-cancel-btn')?.focus() });
    } finally {
      state.confirming = false;
      if (previous?.isConnected) previous.focus();
    }
  }

  /** Resolve true for a clean draft or explicit discard, false when editing should continue. */
  async function confirmDiscardEditor() {
    if (state.confirming) return false;
    if (!hasEditorChanges()) return true;
    return confirmAction({ title: jobsT('common.unsavedChangesTitle'), message: t('discard'),
      confirmText: jobsT('common.discardChanges'), confirmClass: 'btn-danger' });
  }

  /** Dispatch group actions; callers display rejected API requests in Jobs. */
  async function action(el) {
    const a = el.dataset.groupAction;
    if (a === 'open') {
      if (_coreState().currentPage !== 'jobs') {
        navigate('jobs');
        await refreshJobs();
        if (_coreState().currentPage !== 'jobs') return;
      }
      await view('groups', el.dataset.groupId);
      return;
    }
    if (a === 'select') { await view('groups', el.dataset.groupId); return; }
    if (a === 'new' || a === 'edit') {
      if (!await confirmDiscardEditor()) return;
      if (admin()) edit(a === 'new');
      return;
    }
    const g = group();
    if (a === 'start') { await request('/api/job-groups/run', 'POST', { id: g.id }); await refreshJobs(); await history(); return; }
    if (a === 'stop') { await request('/api/job-groups/stop', 'POST', { id: g.id, run_id: g.run.run_id }); await load(); return; }
    if (a === 'delete') { if (await confirmAction({ title: t('delete'), message: g.name + '\n\n' + t('deleteConfirm'), confirmText: t('delete'), confirmClass: 'btn-danger' })) { const result = await request('/api/job-groups', 'DELETE', { id: g.id }); await refreshJobs(); if (result.schedule_error) showJobsError(t('scheduleApplyFailed', { error: result.schedule_error })); } return; }
    if (a === 'log' || a === 'cancel') {
      const run = state.historyRun ? state.history.find(r => r.run_id === state.historyRun) : g.run;
      const step = run.steps[Number(el.dataset.step)];
      if (a === 'log') {
        const job = jobsState.jobs.find(j => j.key === step.job_key);
        const currentLive = !state.historyRun && step.status === 'running'
          && job?.running && job.run_id === step.run_id;
        if (!currentLive) state.follow = false;
        document.getElementById('group-follow').checked = state.follow;
        await showLog(step, run);
      }
      else { await request('/api/jobs/cancel', 'POST', { job_key: step.job_key, run_id: step.run_id }); await refreshJobs(); }
      return;
    }
    if (!state.editor) return;
    readEditor();
    if (a === 'discard') { await canLeave(); return; }
    if (a === 'schedule') { showScheduleModal(el.dataset.jobKey, jobName(el.dataset.jobKey)); return; }
    const index = Number(el.dataset.step);
    if (a === 'picker-toggle') {
      state.picker = { open: !state.picker.open, query: '', location: '', selected: [] };
      renderEditor();
      if (state.picker.open) document.getElementById('group-picker-query')?.focus();
      else document.querySelector('[data-group-action="picker-toggle"]')?.focus();
      return;
    }
    if (a === 'add') {
      const available = new Set(availableJobs().map(j => j.key));
      state.editor.jobs.push(...state.picker.selected.filter(key => available.has(key)));
      state.picker = { open: false, query: '', location: '', selected: [] };
    }
    if (a === 'remove') state.editor.jobs.splice(index, 1);
    if (a === 'up' && index > 0) [state.editor.jobs[index - 1], state.editor.jobs[index]] = [state.editor.jobs[index], state.editor.jobs[index - 1]];
    if (a === 'down' && index < state.editor.jobs.length - 1) [state.editor.jobs[index + 1], state.editor.jobs[index]] = [state.editor.jobs[index], state.editor.jobs[index + 1]];
    renderEditor();
  }

  document.addEventListener('click', event => {
    const tab = event.target.closest('[data-group-view]');
    if (tab) view(tab.dataset.groupView).catch(e => showJobsError(e.message));
    const el = event.target.closest('[data-group-action]');
    if (el) action(el).catch(e => showJobsError(e.message));
  });
  document.addEventListener('keydown', event => {
    if (event.target.id === 'group-picker-query' && event.key === 'Enter') event.preventDefault();
  });
  document.addEventListener('input', event => {
    if (event.target.id !== 'group-picker-query' || !state.editor) return;
    state.picker.query = event.target.value;
    document.getElementById('group-picker-results').innerHTML = pickerResults();
  });
  document.addEventListener('change', event => {
    if (state.editor && event.target.id === 'group-picker-location') {
      state.picker.location = event.target.value;
      document.getElementById('group-picker-results').innerHTML = pickerResults();
    }
    if (state.editor && event.target.matches('[data-group-pick]')) {
      const key = event.target.dataset.groupPick;
      state.picker.selected = state.picker.selected.filter(value => value !== key);
      if (event.target.checked) state.picker.selected.push(key);
      event.target.closest('.group-picker-row').classList.toggle('is-selected', event.target.checked);
      updatePickerSelection();
    }
    if (event.target.id === 'group-follow') { state.follow = event.target.checked; state.followedRun = ''; state.signature = ''; render(); }
    if (event.target.id === 'group-history-select') { state.logRequest++; state.historyRun = event.target.value; closeLogPanel(); state.followedRun = ''; render(); }
    if (event.target.closest('#group-editor') && ['mode', 'enabled'].includes(event.target.name)) { readEditor(); renderEditor(); }
  });
  document.addEventListener('submit', async event => {
    if (event.target.id !== 'group-editor') return;
    event.preventDefault();
    if (state.saving) return;
    readEditor();
    const g = state.editor;
    if (!g.jobs.length) { showJobsError(t('selectJobs')); return; }
    const [hour, minute] = (g.time || '02:00').split(':').map(Number);
    const cron = g.mode === 'custom' ? g.schedule.cron : `${minute} ${hour} ${g.mode === 'monthly' ? g.day : '*'} * ${g.mode === 'weekly' ? g.weekday : '*'}`;
    const payload = { ...(g.id ? { id: g.id } : {}), name: g.name, description: g.description, jobs: g.jobs, on_error: g.on_error, schedule: { enabled: g.schedule.enabled, cron } };
    state.saving = true;
    document.querySelectorAll('#group-editor button[type=submit]').forEach(b => { b.disabled = true; });
    try {
      const result = await request('/api/job-groups', 'POST', payload);
      state.editor = null; state.selected = result.group.id; state.signature = ''; state.historyRun = ''; state.history = [];
      await refreshJobs();
      if (result.schedule_error) showJobsError(t('scheduleApplyFailed', { error: result.schedule_error }));
    } catch (e) { showJobsError(e.message); }
    finally {
      state.saving = false;
      document.querySelectorAll('#group-editor button[type=submit]').forEach(b => { b.disabled = false; });
    }
  });
  let dragged = null;
  document.addEventListener('dragstart', event => { const row = event.target.closest('[data-group-drag]'); if (row) { dragged = Number(row.dataset.groupDrag); row.classList.add('is-dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(dragged)); } });
  document.addEventListener('dragover', event => {
    const row = event.target.closest('[data-group-drag]');
    if (!state.editor || dragged === null || !row) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.group-editor-row.is-drop-target').forEach(el => el.classList.remove('is-drop-target', 'is-drop-after'));
    row.classList.add('is-drop-target');
    row.classList.toggle('is-drop-after', Number(row.dataset.groupDrag) > dragged);
  });
  document.addEventListener('dragend', () => {
    dragged = null;
    document.querySelectorAll('.group-editor-row').forEach(el => el.classList.remove('is-dragging', 'is-drop-target', 'is-drop-after'));
  });
  document.addEventListener('drop', event => {
    const row = event.target.closest('[data-group-drag]');
    if (!row || dragged === null || !state.editor) return;
    event.preventDefault(); readEditor();
    const [key] = state.editor.jobs.splice(dragged, 1); state.editor.jobs.splice(Number(row.dataset.groupDrag), 0, key); dragged = null; renderEditor();
  });
  window.addEventListener('beforeunload', event => { if (hasEditorChanges()) { event.preventDefault(); event.returnValue = ''; } });
  /** Resolve whether navigation may leave the editor; retain unsaved edits on cancellation.
   * @returns {Promise<boolean>} True when navigation may continue.
   */
  async function canLeave() {
    if (!await confirmDiscardEditor()) return false;
    if (!state.editor) return true;
    state.editor = null; state.signature = ''; render();
    return true;
  }
  window.BBUI.jobGroups = { state, load, render, membership, schedules, parseSchedule, canLeave };
})();
