const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function setup(language) {
  const labels = JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`, 'utf8'));
  const context = vm.createContext({
    window: {BBUI: {}, addEventListener() {}, confirm: () => false},
    document: {addEventListener() {}},
    escHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    jobsT: (key, params = {}) => (key.split('.').reduce((v, k) => v?.[k], labels) || key)
      .replace(/\{(\w+)\}/g, (_, name) => params[name] ?? ''),
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
