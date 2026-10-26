'use strict';

/** Lightweight dashboard polling and bounded server-side trends (#602). */
(function resourceMonitor() {
  const root = window.BBUI = window.BBUI || {};
  let timer = null;
  let controller = null;
  let generation = 0;
  let running = false;
  let data = null;
  let failed = false;
  let expanded = false;
  const el = id => document.getElementById(id);
  const t = (key, params = {}) => root.components.i18n.t(`resources.${key}`, params);
  const valid = value => typeof value === 'number' && Number.isFinite(value);
  const number = value => new Intl.NumberFormat(root.components.i18n.getLanguage(), {maximumFractionDigits: 1}).format(value);
  const percent = value => valid(value) ? `${number(value)} %` : '—';
  const gib = value => valid(value) ? `${number(value / 1073741824)} GiB` : '—';
  const visible = () => !document.hidden && root.core?.state?.currentPage === 'dashboard';

  /** Draw a ten-minute SVG trend with explicit gaps for missing/reset samples. */
  function chart(history, getter, maximum, label, large = false) {
    if (!history?.length || !valid(maximum) || maximum <= 0) return '';
    const end = history[history.length - 1].timestamp;
    let path = '';
    let previous = null;
    for (const sample of history) {
      const value = getter(sample);
      if (!valid(value) || !valid(sample.timestamp)) { previous = null; continue; }
      const x = Math.max(0, Math.min(400, 400 * (sample.timestamp - end + 600) / 600));
      const y = 60 - Math.max(0, Math.min(60, value / maximum * 60));
      const connected = previous !== null && sample.timestamp - previous <= 20;
      path += `${connected ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      // A short mark keeps a single observation visible without inventing history.
      if (!connected) path += `l0.1,0 `;
      previous = sample.timestamp;
    }
    return `<svg class="resource-chart${large ? ' resource-chart-large' : ''}" viewBox="0 0 400 64" preserveAspectRatio="none" role="img" aria-label="${escHtml(label)}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  /** Resolve job labels from the dashboard's existing metadata, never fetch Borg. */
  function jobName(key) {
    const job = root.core?.state?.data?.backups?.find(row => row.key === key);
    return job?.display_name || job?.name || key;
  }

  function operation(name) {
    return t(({backup: 'backup', restore: 'restore', restore_test: 'restoreTest'})[name] || 'otherRun');
  }

  /** Update only the resource card; retain the focused history toggle across polls. */
  function render() {
    if (!el('resource-values')) return;
    const unavailable = failed || !data?.available || data.stale;
    const host = unavailable ? {} : data.host || {};
    const runs = unavailable || !data.runs_available ? null : data.runs || [];
    const tests = unavailable ? [] : data.protected_tests || [];
    const history = unavailable ? [] : data.history || [];
    const active = runs?.length > 0;
    el('resource-live').textContent = unavailable ? t('unavailable') : t('live', {seconds: active ? 2 : 10});
    el('resource-live').classList.toggle('is-unavailable', unavailable);
    const description = runs?.map(run => `${jobName(run.job_key)} · ${operation(run.operation)}`).join(', ');
    const cell = (label, value, detail, spark) => `<div class="resource-value"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong><small>${escHtml(detail)}</small>${spark}</div>`;
    el('resource-values').innerHTML =
      cell(t('cpu'), percent(host.cpu_percent), t('cpuScale'), chart(history, s => s.host.cpu_percent, 100, t('cpu'))) +
      cell(t('ram'), gib(host.memory_available_bytes), t('ramTotal', {total: gib(host.memory_total_bytes)}),
        chart(history, s => s.host.memory_available_bytes, host.memory_total_bytes, t('ram'))) +
      cell(t('active'), runs === null ? '—' : String(runs.length), description || (runs === null ? t('unavailable') : t('idle')), '');
    el('resource-tests').hidden = !tests.length;
    el('resource-tests').innerHTML = tests.map(test => {
      const ratio = valid(test.memory_bytes) && test.memory_limit_bytes > 0 ? Math.min(100, 100 * test.memory_bytes / test.memory_limit_bytes) : null;
      return `<div class="resource-test"><strong>${escHtml(jobName(test.job_key))}<small>${escHtml(t('protectedTest'))}</small></strong>
        <span>CPU <b>${escHtml(percent(test.cpu_percent))}</b></span>
        <div class="resource-budget"><span>RAM <b>${escHtml(gib(test.memory_bytes))} / ${escHtml(gib(test.memory_limit_bytes))}</b></span>
        ${ratio === null ? '' : `<progress max="100" value="${ratio}" aria-label="${escHtml(t('budget'))}"></progress>`}</div>
        <span class="resource-reserve">${escHtml(t('reserve', {value: gib(data.configured_reserve_bytes)}))}</span></div>`;
    }).join('') + (tests.length ? `<p class="resource-note">${escHtml(t('accounting'))}</p>` : '');
    el('resource-history-toggle').textContent = t(expanded ? 'hideHistory' : 'showHistory');
    el('resource-history-toggle').setAttribute('aria-expanded', String(expanded));
    el('resource-history').hidden = !expanded;
    if (expanded) {
      const plot = (label, getter, max, unit) => `<div><h3>${escHtml(label)}</h3><small>0 – ${escHtml(unit)}</small>${chart(history, getter, max, label, true)}<div class="resource-axis"><span>−10 min</span><span>${escHtml(t('now'))}</span></div></div>`;
      el('resource-history').innerHTML = `<p class="resource-note">${escHtml(t('historyNote'))}</p><div class="resource-plots">` +
        plot(t('cpu'), s => s.host.cpu_percent, 100, '100 %') +
        plot(t('ram'), s => s.host.memory_available_bytes, host.memory_total_bytes, gib(host.memory_total_bytes)) +
        tests.map(test => plot(`${jobName(test.job_key)} · CPU`, s => s.protected_tests.find(row => row.id === test.id)?.cpu_percent, 100, '100 %') +
          plot(`${jobName(test.job_key)} · RAM`, s => s.protected_tests.find(row => row.id === test.id)?.memory_bytes,
            test.memory_limit_bytes, gib(test.memory_limit_bytes))).join('') + '</div>';
    }
  }

  /** Poll sequentially with timeout and generation checks so obsolete responses cannot render. */
  async function poll(epoch) {
    if (!running || epoch !== generation || !visible()) return;
    controller = new AbortController();
    const request = controller;
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const response = await fetch('/api/system-resources', {signal: request.signal, cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json();
      if (epoch !== generation) return;
      data = next;
      failed = false;
    } catch (_) {
      if (epoch !== generation) return;
      failed = true;
    } finally {
      clearTimeout(timeout);
      if (epoch === generation) controller = null;
    }
    if (epoch !== generation || !visible()) return;
    render();
    const delay = !failed && data?.runs?.length ? 2000 : 10000;
    timer = setTimeout(() => poll(epoch), delay);
  }

  /** Start once when the dashboard is visible; no whole-dashboard reloads. */
  function start() {
    if (!visible() || running) return;
    running = true;
    failed = true; // Never label an old snapshot live when returning to this page.
    render();
    poll(++generation);
  }

  /** Cancel timers and pending requests on navigation, logout or hidden tabs. */
  function stop() {
    running = false;
    generation++;
    clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
  }

  el('resource-history-toggle')?.addEventListener('click', () => { expanded = !expanded; render(); });
  document.addEventListener('visibilitychange', () => { if (visible()) start(); else stop(); });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', () => { if (visible()) start(); });
  window.addEventListener('bbui:language-changed', render);
  root.resourceMonitor = {start, stop};
})();
