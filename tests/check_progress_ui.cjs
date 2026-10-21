'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const nodes = new Map();
const element = id => {
  if (!nodes.has(id)) nodes.set(id, {innerHTML: '', textContent: '', classes: new Set(),
    classList: {toggle(name, value) {value ? nodes.get(id).classes.add(name) : nodes.get(id).classes.delete(name);}}});
  return nodes.get(id);
};
const context = vm.createContext({
  window: {addEventListener(){}, BBUI: {components: {i18n: {t: (key, params = {}) => `${key} ${Object.values(params).join(' ')}`}}}},
  document: {addEventListener(){}, getElementById: element, querySelectorAll: () => []},
  escHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
});
vm.runInContext(fs.readFileSync('ui/js/pages/jobs.js', 'utf8'), context);
const runtime = {running: true, phase: 'borg_check', run_id: 'first', check_progress: {percent: 63, started_at: 100, updated_at: 180}};
let html = context.renderCheckProgress(runtime, 200);
assert.match(html, /value="63"/);
assert.match(html, /jobs.checkElapsed 1:40/);
assert.match(html, /jobs.checkUpdated 0:20/);
assert.match(html, /jobs.checkStep/);
assert.equal(context.renderCheckProgress({...runtime, running: false}), '');
assert.equal(context.renderCheckProgress({...runtime, phase: 'post_script'}), '');
assert.equal(context.renderCheckProgress({...runtime, check_progress: null}), '');
html = context.renderCheckProgress({...runtime, check_progress: {percent: null, started_at: 100}}, 200);
assert.doesNotMatch(html, / value=/);
assert.match(html, /jobs.checkWaiting/);
html = context.renderCheckProgress({...runtime, check_progress: {percent: '63" onload="bad'}}, 200);
assert.doesNotMatch(html, /onload| value=/);
const state = context.window.BBUI.jobsState;
state.jobs = [{key:'demo'}]; state.logJobKey = 'demo'; state.logRunId = 'first';
element('log-output').textContent = 'Existing log\n';
context.updateCheckProgressDisplays({demo:runtime});
assert.match(element('job-check-progress-demo').innerHTML, /value="63"/);
assert.match(element('log-check-progress').innerHTML, /value="63"/);
context.updateCheckProgressDisplays({demo:{...runtime, check_progress:{...runtime.check_progress, percent:70}}});
assert.match(element('log-check-progress').innerHTML, /value="70"/);
assert.doesNotMatch(element('log-check-progress').innerHTML, /value="63"/);
assert.equal(element('log-output').textContent, 'Existing log\n');
context.updateCheckProgressDisplays({demo:{...runtime, run_id:'second'}});
assert.equal(element('log-check-progress').innerHTML, '', 'Never show a newer run inside an older log');
context.updateCheckProgressDisplays({});
assert.equal(element('job-check-progress-demo').innerHTML, '');
context.updateLogCheckProgress({...runtime, running:false});
assert.equal(element('log-check-progress').innerHTML, '');
assert.ok(element('log-check-progress').classes.has('hidden'));
console.log('Check progress: percentage, indeterminate state, age, run identity and log isolation passed.');
