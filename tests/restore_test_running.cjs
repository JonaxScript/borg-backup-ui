const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function fixture(language = 'en') {
  const elements = new Map(['restore-tests-plan-summary', 'restore-tests-plan-content', 'rt-run-btn']
    .map(id => [id, { innerHTML: '', classList: { toggle() {} } }]));
  const translations = JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`, 'utf8'));
  const requests = [];
  let snapshot = { running: false, runs: [], active_job_keys: [] };
  let failed = false;
  let posted = false;
  const plan = { jobs: ['alpha', 'beta', 'disabled'].map(job_key => ({
    job_key, name: job_key, display_name: job_key, location: 'local',
    enabled: job_key !== 'disabled', scheduler_state: 'active', policy: { mode: 'scheduled', level: 2 },
  })) };
  const context = vm.createContext({
    window: { BBUI: { components: { i18n: {
      t: key => key.split('.').reduce((v, part) => v?.[part], translations) || key,
      getLanguage: () => language,
    } } } },
    document: { getElementById: id => elements.get(id) || null },
    escHtml: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    setInterval: () => 1, clearInterval() {}, showMsg() {}, apiErrorMessage: () => 'error',
    fetch: async (url, options = {}) => {
      requests.push([url, options.method || 'GET']);
      if (options.method === 'POST') {
        posted = true;
        snapshot = { running: true, active_job_keys: ['alpha'], run_key: 'restore_test_alpha' };
        return { ok: true, json: async () => snapshot };
      }
      if (url.includes('/running')) {
        if (failed === 'network') throw new Error('offline');
        return { ok: !failed, json: async () => {
          if (failed === 'json') throw new SyntaxError('invalid JSON');
          return snapshot;
        } };
      }
      return { ok: true, json: async () => url.endsWith('/plan') ? plan : { tests: [] } };
    },
  });
  vm.runInContext(fs.readFileSync('ui/js/pages/restore-tests.js', 'utf8'), context);
  // Isolate the plan from unrelated report/sidebar/log rendering.
  vm.runInContext(`
    _openRTLogPanel = () => {};
    renderRTReportFilterOptions = renderRestoreTests = renderRestoreTestsSubtab =
      _updateRTScheduleBtn = refreshRestoreTestJobsForSelection = renderRestoreTestsSidebar =
      updateRestoreTestsWorkspace = () => {};
  `, context);
  context.window.BBUI.core = { getSchedulesData: () => ({}), setSchedulesData() {} };
  const state = context.window.BBUI.restoreTestsState;
  state.plan = plan;
  return { context, state, requests, plan, setSnapshot: value => { snapshot = value; },
    fail: value => { failed = value; }, posted: () => posted,
    row: key => elements.get('restore-tests-plan-content').innerHTML.match(new RegExp(`<tr[^>]*data-rt-job-key="${key}"[\\s\\S]*?</tr>`))?.[0],
  };
}

for (const language of ['de', 'en']) test(`opening plan restores parallel run labels (${language})`, async () => {
  const f = fixture(language);
  f.setSnapshot({ running: true, run_key: 'restore_test_alpha', active_job_keys: ['alpha', 'beta'] });
  await f.context.refreshRestoreTests();
  for (const key of ['alpha', 'beta']) {
    assert.match(f.row(key), /rt-plan-running/);
    assert.match(f.row(key), /btn-danger[^>]*aria-busy="true" disabled/);
    assert.match(f.row(key), language === 'de' ? /Läuft/ : /Running/);
  }
  assert.doesNotMatch(f.row('disabled'), /rt-plan-running/);
  assert.ok(f.state.pollingTimer);
});

test('polling detects scheduled starts, batch transitions and completion without affecting other jobs', async () => {
  const f = fixture();
  await f.context.refreshRestoreTests();
  f.setSnapshot({ active_job_keys: ['alpha'] });
  await f.context._pollRTRunning();
  assert.match(f.row('alpha'), /btn-danger/);
  assert.match(f.row('beta'), /btn-primary[^>]*aria-busy="false" >/);
  f.state.selectedJob = 'beta';
  f.setSnapshot({ active_job_keys: ['beta'] });
  await f.context._pollRTRunning();
  assert.equal(f.row('alpha'), undefined);
  assert.match(f.row('beta'), /btn-danger/);
  f.setSnapshot({ active_job_keys: [] });
  await f.context._pollRTRunning();
  assert.doesNotMatch(f.row('beta'), /rt-plan-running/);
  assert.match(f.row('beta'), /btn-primary[^>]*aria-busy="false" >/);
  assert.ok(f.state.pollingTimer, 'keep watching for externally started tests');
});

test('failed polling retains the last known running status', async () => {
  const f = fixture();
  f.setSnapshot({ active_job_keys: ['alpha'] });
  await f.context.refreshRestorePlanOnly();
  for (const error of [true, 'network', 'json']) {
    f.fail(error);
    await f.context._pollRTRunning();
    assert.match(f.row('alpha'), /btn-danger/);
  }
});

test('manual start stays marked after request busy state clears and prevents duplicate starts', async () => {
  const f = fixture();
  await f.context.runRestorePlanJob('alpha');
  assert.ok(f.posted());
  assert.equal(f.state.rowBusy.alpha, false);
  assert.match(f.row('alpha'), /btn-danger/);
  await f.context.runRestorePlanJob('alpha');
  assert.equal(f.requests.filter(([, method]) => method === 'POST').length, 1);
});

test('managed run snapshots match exact job keys and ignore completed or global runs', () => {
  const f = fixture();
  f.context.updateRTRunningJobs({ runs: [
    { running: true, run_key: 'restore_test_alpha' },
    { running: false, run_key: 'restore_test_beta' },
    { running: true, run_key: 'restore_test' },
  ] });
  f.context.renderRestorePlan(f.plan);
  assert.match(f.row('alpha'), /btn-danger/);
  assert.doesNotMatch(f.row('beta'), /btn-danger/);
});
