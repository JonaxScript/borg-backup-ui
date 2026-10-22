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
state.jobs = [{key:'demo'}];
element('log-output').textContent = 'Existing log\n';
context.updateBorgProgressDisplays({demo:runtime});
assert.match(element('job-borg-progress-demo').innerHTML, /value="63"/);
context.updateBorgProgressDisplays({demo:{...runtime, borg_progress:{...runtime.borg_progress, percent:70}}});
assert.match(element('job-borg-progress-demo').innerHTML, /value="70"/);
assert.doesNotMatch(element('job-borg-progress-demo').innerHTML, /value="63"/);
assert.equal(element('log-output').textContent, 'Existing log\n');
context.updateBorgProgressDisplays({});
assert.equal(element('job-borg-progress-demo').innerHTML, '');
assert.ok(!nodes.has('log-borg-progress'), 'Progress never creates a live-log status field');
console.log('Check progress: percentage, indeterminate state, age, run identity and log isolation passed.');

// Visibility is per process, independent of opening logs. Never flash short runs.
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
  if(!fileActivity) assert.match(state.activeEventSource.url, /run=first/);
  else {
    onStatus({...runtime, borg_progress:{...runtime.borg_progress, percent:70}});
    assert.ok(!nodes.has('log-borg-progress'));
  }
  context.closeLogPanel();
  assert.ok(!nodes.has('log-borg-progress'));
  job.borg_progress={...job.borg_progress, percent:75};
  context.openLogPanel('demo');
  context.updateBorgProgressDisplays({demo:job});
  assert.match(element('job-borg-progress-demo').innerHTML, /value="75"/);
  assert.equal(element('log-output').textContent, '', 'Opening the log does not insert progress lines');
  context.closeLogPanel();
  job.borg_progress={started_at:Date.now()/1000, percent:1};
  context.openLogPanel('demo');
  context.updateBorgProgressDisplays({demo:job});
  assert.equal(element('job-borg-progress-demo').innerHTML, '', 'Short processes stay hidden on open');
  assert.ok(!nodes.has('log-borg-progress'));
  context.closeLogPanel();
}
console.log('Borg progress: 60-second per-process gate, create counters and late log opening passed.');

// The four-step ledger persists independently of transient progress.
const steps = {create:{status:'success',duration_seconds:492},prune:{status:'warning',duration_seconds:18},
  compact:{status:'skipped',reason:'keep_all'},check:{status:'running',started_at:100}};
let timeline = context.renderBorgRun({...runtime, run_borg_steps:steps}, 159);
assert.equal((timeline.match(/class="borg-step is-/g)||[]).length,4);
assert.match(timeline, /8:12/);
assert.match(timeline, /is-warning/);
assert.match(timeline, /is-skipped/);
assert.match(timeline, /jobs.borgStep.keep_all/);
assert.doesNotMatch(timeline, /<progress/,'The stepper is visible immediately; detailed progress waits 60 seconds');
timeline = context.renderBorgRun({...runtime,run_borg_steps:steps},160);
assert.match(timeline, /<progress/);
const saved = {...steps,check:{status:'error',duration_seconds:193}};
const completed = {running:false,last_borg_steps:saved,last_timestamp:'2026-10-22 14:32:00',last_duration_seconds:768};
timeline = context.renderBorgRun(completed,500);
assert.match(timeline,/is-error/);
assert.match(timeline,/3:13/);
assert.match(timeline,/jobs.borgTotalDuration 12:48/);
assert.doesNotMatch(timeline,/<progress|aria-current/);
assert.equal(context.renderBorgRun({running:false,last_status:'success'},500),'','Old successful reports must not invent step successes');
assert.equal(context.renderBorgRun({...completed,running:true,run_borg_steps:{}},500),'','New runs never show old completed steps');
assert.match(context.renderBorgRun({running:false,last_borg_steps:steps},500),/is-interrupted/);
for(const phase of ['borg_prune','borg_compact']) {
  const maintenance={running:true,phase,borg_progress:{phase,started_at:100,updated_at:110,percent:40}};
  assert.equal(context.renderBorgProgress(maintenance,159),'');
  assert.match(context.renderBorgProgress(maintenance,160),/value="40"/);
  assert.equal(context.renderBorgProgress({...maintenance,borg_progress:{...maintenance.borg_progress,updated_at:null}},200),'','Do not invent maintenance progress without events');
}
// The regular timer must preserve completed results even with no live state.
state.jobs=[{key:'demo',...completed}];
context.updateBorgProgressDisplays({});
assert.match(element('job-borg-progress-demo').innerHTML,/is-error/);
assert.doesNotMatch(element('job-borg-progress-demo').innerHTML,/<progress/);
console.log('Four-step timeline: durations, saved results, skip/warning/error states, new-run reset and maintenance gate passed.');

(async () => {
  // A cron-run disappearing from the live API must reload its saved final result.
  context.window.BBUI.core = {state:{currentPage:'jobs'}};
  state.jobs=[{key:'demo',running:true,run_borg_steps:steps}];
  state.lastRunningSnapshot='previous';
  context.fetch=async()=>({ok:true,json:async()=>({})});
  context.renderJobsGrid=()=>{};
  let scheduled;
  context.setTimeout=(callback)=>{scheduled=callback;};
  await context._pollRunningStates();
  assert.equal(typeof scheduled,'function','Finishing cron jobs must refresh saved results');
  // Simulate a full reload after server restart with only a saved report.
  context.window.BBUI.core.updateDataDirWarning=async()=>{};
  context.window.BBUI.core.setSchedulesData=()=>{};
  context.fetch=async url=>({ok:true,json:async()=>url==='/api/jobs'?{jobs:[{key:'demo'}]}:
    url==='/api/status'?{backups:[{key:'demo',status:'success',timestamp:'2026-10-22 14:32:00',duration_seconds:768,borg_steps:saved,run_id:'finished-579'}]}:{}});
  context.hideJobsMessage=()=>{};
  context.showJobsError=message=>{throw Error(message);};
  await context.refreshJobs();
  assert.match(element('job-borg-progress-demo').innerHTML,/is-error/);
  assert.match(element('job-borg-progress-demo').innerHTML,/12:48/);
  console.log('Cron completion refresh and persisted timeline after full page reload passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
