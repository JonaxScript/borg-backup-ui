'use strict';
// Execute the actual schedule modal with DOM/network substitutes (#547).
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const nodes = new Map();
const element = id => {
  if (!nodes.has(id)) nodes.set(id, {value: '', checked: false, textContent: '', style: {},
    classList: {toggle(){}, add(){}, remove(){}, contains(){ return false; }}});
  return nodes.get(id);
};
let schedules = {}, saved;
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-09-29T12:00:00'])); }
}
const context = vm.createContext({Date: FixedDate, Intl, console,
  window: {addEventListener(){}, BBUI: {core: {
    getSchedulesData: () => schedules, setSchedulesData: next => { schedules = next; },
  }, components: {i18n: {t: (key, params) => params.date || key}}}},
  document: {addEventListener(){}, getElementById: element, querySelectorAll: () => []},
  fetch: async (url, options) => {
    assert.equal(url, '/api/schedules'); assert.equal(options.method, 'PUT');
    saved = JSON.parse(options.body);
    return {ok: true, json: async () => ({saved: true})};
  },
});
vm.runInContext(fs.readFileSync('ui/js/pages/jobs.js', 'utf8'), context);
vm.runInContext('_onScheduleChanged = () => {};', context);
(async () => {
  for (const [cron, mode] of [
    ['15 3 * * 1,3,5', 'custom'], ['15 3 * * 1-5', 'custom'],
    ['*/15 * * * *', 'custom'], ['0 1,3 * * *', 'custom'],
    ['0 3 29 * *', 'custom'], ['0 3 31 * *', 'custom'],
    ['15 03 * * 1', 'custom'], ['0 3 * 1 *', 'custom'], ['0 3 * * 7', 'custom'],
    ['15 3 * * *', 'daily'], ['15 3 * * 0', 'weekly'],
    ['15 3 * * 6', 'weekly'], ['15 3 28 * *', 'monthly'],
  ]) {
    schedules = {demo: {cron, enabled: true}};
    context.showScheduleModal('demo');
    assert.equal(context.window.BBUI.scheduleModalState.frequency, mode, cron);
    assert.equal(context.buildCronExpression(), cron);
    await context.saveScheduleAction();
    assert.equal(saved.cron, cron, 'Opening and saving must preserve the schedule');
  }
  schedules = {demo: {cron: '15 3 * * 1,3,5', enabled: true}};
  context.showScheduleModal('demo');
  const correct = context.fmtDateShort(context.calcNextRun(schedules.demo.cron));
  assert.match(correct, /30.09.2026/);
  assert.equal(element('schedule-next-run-text').textContent, correct);
  context.selectDow(1);
  context.setFrequency('weekly');
  assert.match(element('schedule-next-run-text').textContent, /05.10.2026/);
  context.setFrequency('custom');
  assert.equal(element('schedule-next-run-text').textContent, correct);
  element('schedule-cron-custom').value = '15 4 * * 1,3,5';
  context.updateSchedulePreview();
  assert.match(element('schedule-next-run-text').textContent, /04:15/);
  console.log('Schedule editor: custom/preset round trips, Sunday, month end and preview updates passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
