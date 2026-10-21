'use strict';
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const nodes = new Map();
const fakeNode = () => ({style: {}, append(){}, textContent: ''});
const element = id => {
  if (!nodes.has(id)) nodes.set(id, {innerHTML: '', textContent: '', classes: new Set(),
    removeAttribute(){}, append(){}, appendChild(){},
    classList: {add(name) {nodes.get(id).classes.add(name);}, remove(name) {nodes.get(id).classes.delete(name);},
      toggle(name, value) {value ? nodes.get(id).classes.add(name) : nodes.get(id).classes.delete(name);}}});
  return nodes.get(id);
};
const context = vm.createContext({
  window: {addEventListener(){}, BBUI: {components: {i18n: {t: (key, params = {}) => `${key} ${Object.values(params).join(' ')}`}}}},
  document: {addEventListener(){}, getElementById: element, querySelectorAll: () => [], createElement: fakeNode, createTextNode: value => ({textContent: value})},
  EventSource: class {constructor(url){this.url=url;} addEventListener(){} close(){}},
  escHtml: value => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
});
vm.runInContext(fs.readFileSync('ui/js/pages/jobs.js', 'utf8'), context);
const runtime = {running: true, phase: 'borg_check', run_id: 'first', borg_progress: {percent: 63, started_at: 100, updated_at: 180}};
let html = context.renderBorgProgress(runtime, 200);
assert.match(html, /value="63"/);
assert.match(html, /jobs.borgElapsed 1:40/);
assert.match(html, /jobs.borgUpdated 0:20/);
assert.match(html, /jobs.checkStep/);
assert.equal(context.renderBorgProgress({...runtime, running: false}), '');
assert.equal(context.renderBorgProgress({...runtime, phase: 'post_script'}), '');
assert.equal(context.renderBorgProgress({...runtime, borg_progress: null}), '');
html = context.renderBorgProgress({...runtime, borg_progress: {percent: null, started_at: 100}}, 200);
assert.doesNotMatch(html, / value=/);
assert.match(html, /jobs.borgWaiting/);
html = context.renderBorgProgress({...runtime, borg_progress: {percent: '63" onload="bad'}}, 200);
assert.doesNotMatch(html, /onload| value=/);
const state = context.window.BBUI.jobsState;
state.jobs = [{key:'demo'}]; state.logJobKey = 'demo'; state.logRunId = 'first';
element('log-output').textContent = 'Existing log\n';
context.updateBorgProgressDisplays({demo:runtime});
assert.match(element('job-borg-progress-demo').innerHTML, /value="63"/);
assert.match(element('log-borg-progress').innerHTML, /value="63"/);
context.updateBorgProgressDisplays({demo:{...runtime, borg_progress:{...runtime.borg_progress, percent:70}}});
assert.match(element('log-borg-progress').innerHTML, /value="70"/);
assert.doesNotMatch(element('log-borg-progress').innerHTML, /value="63"/);
assert.equal(element('log-output').textContent, 'Existing log\n');
context.updateBorgProgressDisplays({demo:{...runtime, run_id:'second'}});
assert.equal(element('log-borg-progress').innerHTML, '', 'Never show a newer run inside an older log');
context.updateBorgProgressDisplays({});
assert.equal(element('job-borg-progress-demo').innerHTML, '');
context.updateLogBorgProgress({...runtime, running:false});
assert.equal(element('log-borg-progress').innerHTML, '');
assert.ok(element('log-borg-progress').classes.has('hidden'));
console.log('Check progress: percentage, indeterminate state, age, run identity and log isolation passed.');

// Visibility is per process, including late-opened logs. Never flash short runs.
assert.equal(context.renderBorgProgress(runtime, 159.999), '');
assert.match(context.renderBorgProgress(runtime, 160), /value="63"/);
assert.equal(context.renderBorgProgress({...runtime, running:false}, 160), '');
const creating = {...runtime, phase:'borg_create', borg_progress:{...runtime.borg_progress, nfiles:123, original_size:1073741824}};
html = context.renderBorgProgress(creating, 160);
assert.match(html, /jobs.createRunning/);
assert.match(html, /123/);
assert.match(html, /1.0 GiB/);
assert.doesNotMatch(html, / value=|jobs.checkStep|jobs.checkPercent/);
assert.equal(context.renderBorgProgress(creating, 159), '');
const nextCheck = {...runtime, borg_progress:{phase:'borg_check', started_at:200, percent:5}};
assert.equal(context.renderBorgProgress(nextCheck, 259), '', 'A long create does not bypass the next check delay');
assert.match(context.renderBorgProgress(nextCheck, 260), /value="5"/);
assert.equal(context.renderBorgProgress({...runtime, borg_progress:{phase:'borg_create',started_at:100}}, 200), '');

// Open/close/reopen the actual live-log entrypoint for both transports.
for(const fileActivity of [false,true]) {
  let onStatus;
  context.window.BBUI.components.activityLog = {create(options) {
    onStatus=options.onStatus; return {close(){}};
  }};
  const job = {...runtime, key:'demo', location:'local', run_file_activity:fileActivity};
  state.jobs=[job];
  context.openLogPanel('demo');
  assert.match(element('log-borg-progress').innerHTML, /value="63"/);
  if(!fileActivity) assert.match(state.activeEventSource.url, /run=first/);
  else {
    onStatus({...runtime, borg_progress:{...runtime.borg_progress, percent:70}});
    assert.match(element('log-borg-progress').innerHTML, /value="70"/);
  }
  context.closeLogPanel();
  assert.equal(element('log-borg-progress').innerHTML, '');
  job.borg_progress={...job.borg_progress, percent:75};
  context.openLogPanel('demo');
  assert.match(element('log-borg-progress').innerHTML, /value="75"/);
  assert.equal(element('log-output').textContent, '', 'Opening the log does not insert progress lines');
  context.closeLogPanel();
  job.borg_progress={started_at:Date.now()/1000, percent:1};
  context.openLogPanel('demo');
  assert.equal(element('log-borg-progress').innerHTML, '', 'Short processes stay hidden on open');
  context.closeLogPanel();
}
console.log('Borg progress: 60-second per-process gate, create counters and late log opening passed.');
