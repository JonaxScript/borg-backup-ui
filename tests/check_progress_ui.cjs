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
// This suite uses a string-only DOM; real node reconciliation is covered separately.
context.patchJobMarkup = (target, html) => {target.innerHTML = html;};
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
assert.doesNotMatch(timeline, /<progress/, 'Progress is in the operating-status cell, not duplicated in the timeline');
const saved = {...steps,check:{status:'error',duration_seconds:193}};
const completed = {running:false,last_borg_steps:saved,last_timestamp:'2026-10-22 14:32:00',last_duration_seconds:768};
timeline = context.renderBorgRun(completed,500);
assert.match(timeline,/is-error/);
assert.match(timeline,/3:13/);
assert.match(timeline,/jobs.borgTotalDuration 12:48/);
assert.doesNotMatch(timeline,/<progress|aria-current/);
assert.equal(context.renderBorgRun({running:false,last_status:'success'},500),'','Old successful reports must not invent step successes');
assert.doesNotMatch(context.renderBorgRun({...completed,running:true,run_borg_steps:{}},500),/borg-step is-/,'New runs never show old completed steps');
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
assert.match(element('job-workflow-demo').innerHTML,/is-error/);
assert.doesNotMatch(element('job-borg-progress-demo').innerHTML,/<progress/);
console.log('Four-step timeline: durations, saved results, skip/warning/error states, new-run reset and maintenance gate passed.');

(async () => {
  // Starting a job only refreshes the card. A log opens only after a click.
  const savedRefresh = context.refreshJobs;
  const savedOpen = context.openLogPanel;
  let opened = 0, refreshed = 0;
  context.closeModal = () => {};
  context.refreshJobs = async () => {refreshed++;};
  context.openLogPanel = () => {opened++;};
  context.fetch = async () => ({ok:true,json:async()=>({})});
  state.pendingJobKey = 'demo';
  await context.confirmJobStart();
  assert.equal(refreshed, 1);
  assert.equal(opened, 0, 'Starting must not open a log');
  context.onJobsGridClick({target:{closest:()=>({dataset:{jobsAction:'open-log',jobKey:'demo'}})}});
  assert.equal(opened, 1, 'The explicit live-log button opens the log');
  context.refreshJobs = savedRefresh;
  context.openLogPanel = savedOpen;
  // A cron-run disappearing from the live API must reload its saved final result.
  context.window.BBUI.core = {state:{currentPage:'jobs'}};
  state.jobs=[{key:'demo',running:true,run_borg_steps:steps}];
  state.lastRunningSnapshot='previous';
  context.fetch=async()=>({ok:true,json:async()=>({})});
  context.renderJobsGrid=()=>{};
  let finishedRefresh = false;
  context.refreshJobs = async () => {
    finishedRefresh = true;
    assert.equal(state.jobs[0].running, true, 'Keep the live ledger until the report is available');
    assert.ok(state.jobs[0].run_borg_steps.create);
  };
  await context._pollRunningStates();
  assert.equal(finishedRefresh, true, 'Finishing cron jobs must immediately load saved results');
  context.refreshJobs = savedRefresh;
  // Simulate a full reload after server restart with only a saved report.
  context.window.BBUI.core.updateDataDirWarning=async()=>{};
  context.window.BBUI.core.setSchedulesData=()=>{};
  context.fetch=async url=>({ok:true,json:async()=>url==='/api/jobs'?{jobs:[{key:'demo'}]}:
    url==='/api/status'?{backups:[{key:'demo',status:'success',timestamp:'2026-10-22 14:32:00',duration_seconds:768,borg_steps:saved,run_id:'finished-579'}]}:{}});
  context.hideJobsMessage=()=>{};
  context.showJobsError=message=>{throw Error(message);};
  await context.refreshJobs();
  assert.match(element('job-workflow-demo').innerHTML,/is-error/);
  assert.match(element('job-workflow-demo').innerHTML,/12:48/);
  console.log('Cron completion refresh and persisted timeline after full page reload passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Configured non-Borg steps keep their order, remain named when collapsed and use SVG states.
const workflow = [
  {id:'pre_script',status:'warning',duration_seconds:2,details:{script_name:'<img src=x onerror=bad>',exit_code:1}},
  {id:'stop_docker',status:'success',duration_seconds:18,details:{target_count:3,completed_count:3}},
  {id:'create',status:'success',duration_seconds:738,details:{nfiles:58738,original_size:1024}},
  {id:'start_docker',status:'success',duration_seconds:8},
  {id:'compact',status:'success',duration_seconds:6},
  {id:'check',status:'running',started_at:100},
  {id:'post_script',status:'pending'},
];
const workflowJob={key:'workflow',running:true,run_job_steps:workflow,run_phase:'borg_check',
  borg_progress:{phase:'borg_check',started_at:100,updated_at:160,percent:63},
  last_successful_backup:{timestamp:'2026-10-21 10:16:00',duration_seconds:892}};
state.jobs=[workflowJob];
let configured=context.renderBorgRun(workflowJob,200);
assert.equal((configured.match(/class="borg-step is-/g)||[]).length,7);
assert.doesNotMatch(configured,/borg prune|<table|<progress/);
assert.match(configured,/jobs.workflow.names.stop_docker/);
assert.match(configured,/<svg/);
assert.match(configured,/aria-current="step"/);
assert.match(configured,/jobs.workflow.lastSuccess/);
assert.match(configured,/aria-expanded="false"/);
const click={target:{closest:()=>({dataset:{jobsAction:'toggle-workflow',jobKey:'workflow'}})}};
context.onJobsGridClick(click);
assert.match(element('job-workflow-workflow').innerHTML,/<table/);
assert.match(element('job-workflow-workflow').innerHTML,/&lt;img/);
assert.doesNotMatch(element('job-workflow-workflow').innerHTML,/<img/);
context.updateBorgProgressDisplays({workflow:{running:true,job_steps:workflow,phase:'borg_check',borg_progress:workflowJob.borg_progress}});
assert.match(element('job-workflow-workflow').innerHTML,/aria-expanded="true"/);
assert.match(element('job-borg-progress-workflow').innerHTML,/value="63"/);
context.onJobsGridClick(click);
assert.doesNotMatch(element('job-workflow-workflow').innerHTML,/<table/);
assert.match(element('job-workflow-workflow').innerHTML,/jobs.workflow.lastSuccess/);
const failedLater={...workflowJob,running:false,last_status:'error',last_timestamp:'2026-10-22 10:20:00',last_job_steps:workflow};
assert.match(context.renderBorgRun(failedLater,200),/jobs.borgCompletedAt/);
assert.match(context.renderBorgRun(failedLater,200),/jobs.workflow.lastSuccess/);
assert.match(context.renderBorgRun(failedLater,200),/is-interrupted/);
console.log('Configured workflow: named steps, SVG states, disclosure persistence, escaped details and last success passed.');

// Compact results distinguish original/processed data from new deduplicated data.
const successView = {state:'success',status:'Success'};
const dataDetails=context.jobStepDetails({id:'create',exit_code:0,details:{nfiles:1000,original_size:1073741824,deduplicated_size:1024}},successView);
assert.match(dataDetails,/jobs.createFiles 1,000/);
assert.match(dataDetails,/jobs.createBytes 1.0 GiB/);
assert.match(dataDetails,/jobs.workflow.newData 1.0 KiB/);
assert.doesNotMatch(dataDetails,/exitCode|Success/);
assert.match(context.jobStepDetails({id:'compact',details:{freed_bytes:0}},successView),/jobs.workflow.freedSpace 0 B/);
assert.doesNotMatch(context.jobStepDetails({id:'compact'},successView),/freedSpace/);
assert.match(context.jobStepDetails({id:'create',exit_code:2,details:{nfiles:2}}, {state:'error',status:'Failed'}),/Failed.*exitCode 2/);
assert.doesNotMatch(context.jobStepDetails({id:'create',details:{original_size:-1,deduplicated_size:'bogus'}},successView),/createBytes|newData/);
// Empty destination sections never render, while selected locations need no duplicate header.
assert.equal(context.renderJobsLocationGroup('smb',[]),'');
context.locationIcon=()=>'';
context.renderJobCard=job=>`<article>${job.key}</article>`;
state.selectedLocation='all';
assert.match(context.renderJobsLocationGroup('usb',[{key:'a'},{key:'b'}]),/jobs-location-group__header/);
state.selectedLocation='usb';
assert.doesNotMatch(context.renderJobsLocationGroup('usb',[{key:'a'}]),/jobs-location-group__header/);
state.selectedLocation='all';
console.log('Compact metrics, empty locations and explicit log opening passed.');

for (const id of ['stop_docker', 'stop_vms', 'start_docker', 'start_vms']) {
  assert.match(context.jobStepDetails({id,details:{target_count:31,completed_count:30}},successView),
    new RegExp(`jobs.workflow.${id.startsWith('stop') ? 'targetsStopped' : 'targetsStarted'} 30 31`));
}
const metricLines = context.renderBorgProgress({...creating,borg_progress:{...creating.borg_progress,deduplicated_size:1024}},200);
assert.equal((metricLines.match(/class="borg-progress-metric"/g)||[]).length,3);
assert.doesNotMatch(metricLines,/createFiles[^<]* · /);

// Managed database exports must be visible before Docker/Borg work starts (#591).
const dbWorkflow = [
  {id:'pre_script',status:'success',duration_seconds:2,details:{script_name:'Prepare backup'}},
  {id:'database_backup',status:'running',started_at:170},
  {id:'stop_docker',status:'pending'},
  {id:'create',status:'pending'},
  {id:'post_script',status:'pending'},
];
const dbJob={key:'database',running:true,run_phase:'database_backup',run_job_steps:dbWorkflow};
const dbTimeline=context.renderBorgRun(dbJob,200);
assert.equal((dbTimeline.match(/class="borg-step is-/g)||[]).length,5);
assert.ok(dbTimeline.indexOf('data-step="pre_script"')<dbTimeline.indexOf('data-step="database_backup"'));
assert.ok(dbTimeline.indexOf('data-step="database_backup"')<dbTimeline.indexOf('data-step="stop_docker"'));
assert.match(dbTimeline,/is-running" data-step="database_backup" aria-current="step"/);
assert.match(context.renderJobOperation(dbJob,200),/jobs.workflow.names.database_backup.*0:30/);
assert.doesNotMatch(context.renderJobOperation(dbJob,200),/<progress/);
assert.match(context.renderJobOperation({...dbJob,run_job_steps:[]},200),/jobGroups.phases.database_backup/);
assert.doesNotMatch(context.renderBorgRun({...dbJob,run_job_steps:[{id:'unknown',status:'running'}]},200),/data-step="unknown"/);
for (const status of ['success','error','cancelled','skipped']) {
  const lastSteps=dbWorkflow.map(step=>step.id==='database_backup'?{...step,status,duration_seconds:30}:step);
  assert.match(context.renderBorgRun({...dbJob,running:false,last_job_steps:lastSteps},200),new RegExp(`is-${status}.*data-step="database_backup"`));
}
state.jobs=[dbJob];
context.onJobsGridClick({target:{closest:()=>({dataset:{jobsAction:'toggle-workflow',jobKey:'database'}})}});
const dbCompleted={id:'database_backup',status:'success',duration_seconds:30,details:{results:[{archived:true,files:[{database:'<img src=x>',bytes:1024,duration_seconds:12}]}]}};
const persisted=context.renderBorgRun({...dbJob,running:false,last_job_steps:[dbCompleted]},200);
assert.match(persisted,/&lt;img src=x>.*1.0 KiB.*0:12.*jobs.databaseArchived/);
assert.doesNotMatch(persisted,/<img/);
for (const id of ['pre_script','post_script']) {
  assert.match(context.renderJobOperation({...dbJob,run_job_steps:[{id,status:'running',started_at:190}]},200),new RegExp(`jobs.workflow.names.${id}.*0:10`));
}
console.log('Database and hook steps: immediate active phase, ordered timeline, final outcomes and escaped saved details passed.');
