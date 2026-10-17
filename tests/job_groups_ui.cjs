const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function setup(language, globals = {}) {
  const labels = JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`, 'utf8'));
  const context = vm.createContext({
    window: {BBUI: {}, addEventListener() {}, confirm: () => false},
    document: {addEventListener() {}},
    escHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    jobsT: (key, params = {}) => (key.split('.').reduce((v, k) => v?.[k], labels) || key)
      .replace(/\{(\w+)\}/g, (_, name) => params[name] ?? ''),
    ...globals,
  });
  vm.runInContext(fs.readFileSync('ui/js/pages/job-groups.js', 'utf8'), context);
  return context.window.BBUI.jobGroups;
}
for (const language of ['de', 'en']) {
  test(`membership identifies every group and preserves unsafe names as text (${language})`, () => {
    const ui = setup(language);
    const rendered = ui.membership({groups: [
      {id: 'group-a', name: '<script>alert(1)</script>', position: 2, total: 3},
      {id: 'group-b', name: 'Other', position: 1, total: 2},
    ]});
    assert.ok(!rendered.includes('<script>'));
    assert.ok(rendered.includes('&lt;script>'));
    assert.equal((rendered.match(/data-group-action="open"/g) || []).length, 2);
    assert.ok(rendered.includes(language === 'de' ? 'Schritt 2 von 3' : 'Step 2 of 3'));
  });
  test(`schedule editor preserves complex cron expressions (${language})`, () => {
    const ui = setup(language);
    assert.equal(ui.parseSchedule('15 3 * * 6').mode, 'weekly');
    assert.equal(ui.parseSchedule('15 3 * * 6').weekday, '6');
    assert.equal(ui.parseSchedule('15 3 12 * *').mode, 'monthly');
    assert.equal(ui.parseSchedule('15 3 * * *').time, '03:15');
    for (const cron of ['*/15 * * * *', '0 2 * 1 *', '0 2 * * 1-5', '0 2 1 * 0']) {
      assert.equal(ui.parseSchedule(cron).mode, 'custom');
    }
    assert.ok(ui.schedules({groups: [{name: 'Nightly', schedule: {enabled: false, cron: '0 2 * * *'}}]})
      .includes(language === 'de' ? 'Zeitplan deaktiviert' : 'Schedule disabled'));
  });
  test(`cancelled navigation retains the group editor (${language})`, () => {
    const ui = setup(language);
    ui.state.editor = {name: 'Unsaved'};
    assert.equal(ui.canLeave(), false);
    assert.equal(ui.state.editor.name, 'Unsaved');
  });
}

/** Exercise production rendering and click dispatch with controllable polling snapshots. */
function logScenario() {
  const elements = new Map();
  const listeners = {};
  const opened = [], fetched = [], errors = [];
  const jobs = ['Flash', 'Appdata', 'Photos'].map((name, i) => ({key: String(i), name, running: i === 1, run_id: `run-${i}`}));
  const run = {run_id: 'group-run', group_name: 'Local', status: 'running', steps: [
    {job_key: '0', run_id: 'run-0', status: 'success', log_file: 'flash.log'},
    {job_key: '1', run_id: 'run-1', status: 'running', log_file: 'appdata.log'},
    {job_key: '2', status: 'pending'},
  ]};
  const node = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', checked: true,
      classList: {add() {}, remove() {}},
      contains: () => false, after() {}, appendChild() {}, removeAttribute() {},
    });
    return elements.get(id);
  };
  const ui = setup('en', {
    document: {addEventListener: (name, fn) => { listeners[name] = fn; }, getElementById: node},
    jobsState: {jobs}, _coreState: () => ({currentRole: 'admin', currentPage: 'jobs'}),
    _coreSchedules: () => ({}), _isDataDirReady: () => true,
    jobsLocationGlyph: () => '', resolveJobIconColor: () => '', resolveJobIcon: () => '', typeIcon: () => '',
    openLogPanel: (key, id) => { opened.push([key, id]); node('log-output').textContent = `live ${key}`; },
    closeLogPanel() {}, setLogStatus() {}, showJobsError: message => errors.push(message),
    fetch: async url => {
      fetched.push(url);
      return {ok: true, json: async () => ({content: `saved ${url}`})};
    },
  });
  Object.assign(ui.state, {view: 'groups', selected: 'g', groups: [{id: 'g', name: 'Local', jobs: ['0','1','2'], schedule: {}, run}]});
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const clickLog = async index => {
    const el = {dataset: {groupAction: 'log', step: String(index)}};
    listeners.click({target: {closest: selector => selector === '[data-group-action]' ? el : null}});
    await flush();
  };
  const finish = () => {
    run.status = 'success';
    run.steps[1].status = 'success';
    run.steps[2] = {job_key: '2', run_id: 'run-2', status: 'success', log_file: 'photos.log'};
    jobs[1].running = false;
  };
  return {ui, run, jobs, node, opened, fetched, errors, flush, clickLog, finish};
}

test('following selects Photos when the final job starts and finishes between polls', async () => {
  const s = logScenario();
  s.ui.render();
  assert.deepEqual(s.opened, [['1', 'run-1']]);
  s.finish();
  s.ui.render();
  await s.flush();
  assert.match(s.node('log-panel-title-text').textContent, /Photos/);
  assert.match(s.node('log-output').textContent, /photos\.log/);
  s.ui.render();
  assert.equal(s.fetched.length, 1, 'Completed logs are not fetched again on unchanged refresh');
  assert.deepEqual(s.errors, []);
});

test('clicking the current live log preserves following through completion', async () => {
  const s = logScenario();
  s.ui.render();
  await s.clickLog(1);
  assert.equal(s.ui.state.follow, true);
  assert.equal(s.node('group-follow').checked, true);
  s.finish(); s.ui.render(); await s.flush();
  assert.match(s.node('log-output').textContent, /photos\.log/);
});

test('selecting an older log keeps that explicit selection after group completion', async () => {
  const s = logScenario();
  s.ui.render(); await s.clickLog(0);
  assert.equal(s.ui.state.follow, false);
  s.finish(); s.ui.render(); await s.flush();
  assert.match(s.node('log-output').textContent, /flash\.log/);
  assert.equal(s.fetched.length, 1);
});

test('opening a live log does not re-enable following that the user disabled', async () => {
  const s = logScenario();
  s.ui.state.follow = false;
  await s.clickLog(1);
  assert.equal(s.ui.state.follow, false);
  s.finish(); s.ui.render(); await s.flush();
  assert.equal(s.fetched.length, 0);
});

test('a completed live step switches to its retained log with the same run id', async () => {
  const s = logScenario();
  s.run.steps[1].status = 'success'; s.jobs[1].running = false;
  s.run.steps[2] = {job_key: '2', status: 'running', run_id: 'run-2', log_file: 'photos.log'};
  s.jobs[2].running = true;
  s.ui.render();
  assert.deepEqual(s.opened, [['2', 'run-2']]);
  s.finish(); s.jobs[2].running = false;
  s.ui.render(); await s.flush();
  assert.match(s.node('log-output').textContent, /photos\.log/);
});

test('following resumes when job runtime metadata catches up with the group snapshot', () => {
  const s = logScenario();
  s.jobs[1].running = false; s.jobs[1].run_id = '';
  s.ui.render(); assert.equal(s.opened.length, 0);
  s.jobs[1].running = true; s.jobs[1].run_id = 'run-1';
  s.ui.render(); assert.deepEqual(s.opened, [['1', 'run-1']]);
});

test('stopped groups select the last available log, not an unstarted pending job', async () => {
  const s = logScenario();
  s.run.status = 'failed'; s.run.steps[1].status = 'failed'; s.jobs[1].running = false;
  s.ui.render(); await s.flush();
  assert.match(s.node('log-output').textContent, /appdata\.log/);
});
