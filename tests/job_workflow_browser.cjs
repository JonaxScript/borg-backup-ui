'use strict';
// Run with Node, Playwright and its Chromium available; no production dependency.
// Exercises actual DOM/CSS animation identity, polling and completion publication (#579).
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true,...(process.env.BBUI_CHROMIUM?{executablePath:process.env.BBUI_CHROMIUM}:{})});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    await page.setContent('<div id="jobs-grid"></div>');
    await page.addStyleTag({content:fs.readFileSync('ui/dashboard-jobs.css','utf8')});
    await page.evaluate(() => {
      window.BBUI = {core:{state:{currentPage:'jobs'}, updateDataDirWarning:async()=>{},setSchedulesData(){}}};
      window.escHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    });
    await page.addScriptTag({content:fs.readFileSync('ui/js/pages/jobs.js','utf8')});
    await page.evaluate(() => {
      // Keep the real workflow renderer, reconciliation, refresh and polling.
      renderJobsLocationSidebar = updateJobsSelection = hideJobsMessage = () => {};
      showJobsError = () => {};
      locationIcon = () => '';
      renderJobCard = job => `<article class="jobs-redesign-row" id="job-card-${job.key}"><div id="job-borg-progress-${job.key}">${renderJobOperation(job)}</div><div class="job-workflow" id="job-workflow-${job.key}">${renderBorgRun(job)}</div></article>`;
      const now = Date.now()/1000;
      window.live = {running:true,run_id:'run-one',phase:'borg_create',job_steps:[
        {id:'stop_docker',status:'success',duration_seconds:35,details:{target_count:31,completed_count:31}},
        {id:'create',status:'running',started_at:now-75},
        {id:'check',status:'pending'}],borg_progress:{phase:'borg_create',started_at:now-75,updated_at:now,nfiles:100,original_size:1024,deduplicated_size:10}};
      jobsState.jobs = [{key:'demo',location:'local',...jobRuntimeState(live)}];
      renderJobsGrid(jobsState.jobs);
      document.addEventListener('click',onJobsGridClick);
      window.spinner = document.querySelector('.is-running svg');
      window.animation = spinner.getAnimations()[0];
      window.progress = document.querySelector('progress');
      window.timeline = document.querySelector('.borg-stepper');
      window.fetch = async () => ({ok:true,json:async()=>({demo:live})});
    });
    await page.waitForFunction(() => animation.currentTime > 100);
    await page.evaluate(async () => {
      window.before = animation.currentTime;
      live.borg_progress.nfiles = 200;
      await _pollRunningStates();
      updateBorgProgressDisplays({demo:live});
      renderJobsGrid(jobsState.jobs);
    });
    assert.equal(await page.evaluate(() => spinner === document.querySelector('.is-running svg') && animation === spinner.getAnimations()[0] && animation.currentTime >= before),true);
    assert.equal(await page.evaluate(() => progress === document.querySelector('progress')),true);
    assert.equal(await page.locator('.borg-progress-metric').count(),3);
    await page.locator('[data-jobs-action="toggle-workflow"]').click();
    await page.evaluate(() => {window.detailSpinner=document.querySelector('tr.is-running svg');});
    await page.evaluate(async () => {live.borg_progress.nfiles++; await _pollRunningStates();});
    assert.equal(await page.evaluate(() => detailSpinner === document.querySelector('tr.is-running svg') && spinner === document.querySelector('.borg-step.is-running svg')),true);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.jobsAction),'toggle-workflow');
    // An unchanged snapshot must update elapsed text without replacing nodes.
    await page.evaluate(async () => {await _pollRunningStates();});
    assert.equal(await page.evaluate(() => spinner === document.querySelector('.borg-step.is-running svg')),true);
    // A delayed final report must not clear or remove the existing timeline.
    await page.evaluate(() => {
      window.finalSteps=live.job_steps.map(step=>({...step,status:'success',duration_seconds:90}));
      window.requests=[];
      window.fetch=async url=>{
        requests.push(url);
        if(url==='/api/status') await new Promise(resolve=>{window.releaseReport=resolve;});
        return {ok:true,json:async()=>url==='/api/jobs'?{jobs:[{key:'demo',location:'local'}]}:
          url==='/api/status'?{backups:[{key:'demo',status:'success',run_id:'run-one',job_steps:finalSteps}]}:{}};
      };
      window.finishPoll=_pollRunningStates();
    });
    await page.waitForFunction(() => typeof releaseReport === 'function');
    assert.equal(await page.evaluate(() => timeline === document.querySelector('.borg-stepper') && jobsState.jobs[0].running),true);
    await page.evaluate(async () => {releaseReport();await finishPoll;});
    assert.equal(await page.evaluate(() => timeline === document.querySelector('.borg-stepper')),true);
    assert.equal(await page.locator('.borg-step.is-success').count(),3);
    assert.equal(await page.locator('.borg-step.is-running').count(),0);
    assert.equal(await page.locator('progress').count(),0);
    assert.equal(await page.evaluate(() => requests.indexOf('/api/status')>requests.lastIndexOf('/api/jobs/running')),true);
    // Old polls cannot overwrite a newer manual refresh; overlapping polls are skipped.
    await page.evaluate(() => {
      window.fetch=async url=>{
        if(url==='/api/jobs/running' && !window.releasePoll) await new Promise(resolve=>{window.releasePoll=resolve;});
        return {ok:true,json:async()=>url==='/api/jobs/running'?{demo:live}:url==='/api/jobs'?{jobs:[{key:'demo',name:'Fresh',location:'local'}]}:{}};
      };
      window.stalePoll=_pollRunningStates();
    });
    await page.waitForFunction(() => typeof releasePoll === 'function');
    await page.evaluate(async () => {await _pollRunningStates(); await refreshJobs();live.job_steps=[];releasePoll();await stalePoll;});
    assert.equal(await page.evaluate(() => jobsState.jobs[0].name),'Fresh');
    assert.equal(await page.locator('.borg-step').count(),3,'Late poll must not clear newer workflow');
    // A slower refresh cannot overwrite a newer completed refresh.
    await page.evaluate(() => {
      let first = true;
      window.fetch=async url=>{
        const delayed=url==='/api/jobs' && first;
        if(delayed) {first=false;await new Promise(resolve=>{window.releaseOldRefresh=resolve;});}
        return {ok:true,json:async()=>url==='/api/jobs'?{jobs:[{key:'demo',location:'local',name:delayed?'Old':'Newest'}]}:{}};
      };
      window.oldRefresh=refreshJobs();
    });
    await page.waitForFunction(() => typeof releaseOldRefresh === 'function');
    await page.evaluate(async () => {await refreshJobs();releaseOldRefresh();await oldRefresh;});
    assert.equal(await page.evaluate(() => jobsState.jobs[0].name),'Newest');
    // A report-fetch failure keeps the existing run visible and allows a retry.
    await page.evaluate(async () => {
      live.job_steps=[{id:'create',status:'running',started_at:Date.now()/1000-70}];
      jobsState.jobs=[{key:'demo',location:'local',...jobRuntimeState(live)}];
      renderJobsGrid(jobsState.jobs);
      window.retained=document.querySelector('.borg-stepper');
      window.fetch=async url=>{if(url==='/api/status') throw Error('offline');return {ok:true,json:async()=>({})};};
      await _pollRunningStates();
    });
    assert.equal(await page.evaluate(() => retained === document.querySelector('.borg-stepper') && jobsState.jobs[0].running),true);
    // Keyed insertion/removal/reordering keeps the correct job and step identity.
    await page.evaluate(() => {
      const root=document.createElement('div');document.body.append(root);
      patchJobMarkup(root,'<div id="a">A</div><div id="b"><span data-step="create">B</span></div>');
      window.kept=root.lastChild;
      patchJobMarkup(root,'<div id="b"><span data-step="create">B2</span></div><div id="c">C</div>');
      if(root.firstChild!==kept || root.textContent!=='B2C' || root.children.length!==2) throw Error('Keyed reconciliation failed');
    });
    // The managed export is active before any Docker/Borg work, even under 60 seconds.
    await page.evaluate(() => {
      const now=Date.now()/1000;
      jobsState.jobs=[{key:'database',location:'local',running:true,run_phase:'database_backup',run_job_steps:[
        {id:'pre_script',status:'success',duration_seconds:2},
        {id:'database_backup',status:'running',started_at:now-30},
        {id:'stop_docker',status:'pending'}, {id:'create',status:'pending'}, {id:'post_script',status:'pending'}]}];
      renderJobsGrid(jobsState.jobs);
    });
    assert.equal(await page.locator('.borg-step[data-step="database_backup"].is-running').count(),1);
    assert.equal(await page.locator('.borg-step[data-step="database_backup"]').getAttribute('aria-current'),'step');
    assert.ok((await page.locator('#job-borg-progress-database').textContent()).includes('jobs.workflow.names.database_backup'));
    assert.equal(await page.locator('progress').count(),0);
    await page.locator('[data-jobs-action="toggle-workflow"]').click();
    assert.equal(await page.locator('tr[data-step="database_backup"].is-running').count(),1);
    await page.evaluate(() => {
      const job=jobsState.jobs[0];job.running=false;job.last_job_steps=job.run_job_steps.map(step=>({...step,status:'success',duration_seconds:30}));
      renderJobsGrid(jobsState.jobs);
    });
    assert.equal(await page.locator('.borg-step[data-step="database_backup"].is-success').count(),1);
    assert.equal(await page.locator('tr[data-step="database_backup"].is-success').count(),1);
    // Seven steps fit a desktop card; longer workflows scroll locally in one row.
    for (const file of ['ui/style.css','ui/design-system.css']) await page.addStyleTag({content:fs.readFileSync(file,'utf8')});
    await page.evaluate(labels => {
      BBUI.components={i18n:{t:(key)=>key.split('.').reduce((value,part)=>value?.[part],labels)||key}};
      document.documentElement.dataset.theme='light';
      document.getElementById('jobs-grid').style.maxWidth='1280px';
      const ids=['database_backup','stop_docker','create','start_docker','prune','compact','check'];
      jobsState.jobs=[{key:'row',location:'local',running:false,last_job_steps:ids.map(id=>({id,status:'success',duration_seconds:30}))}];
      renderJobsGrid(jobsState.jobs);
    },JSON.parse(fs.readFileSync('ui/i18n/de.json','utf8')));
    const strip=page.locator('.borg-stepper');
    const geometry=()=>strip.evaluate(node=>({tops:[...node.children].map(child=>child.getBoundingClientRect().top),width:node.clientWidth,scrollWidth:node.scrollWidth}));
    let sizes=await geometry();
    assert.equal(new Set(sizes.tops).size,1);
    assert.equal(sizes.scrollWidth,sizes.width);
    assert.notEqual(await strip.locator('li').nth(5).evaluate(node=>getComputedStyle(node,'::after').display),'none');
    if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/workflow-seven.png`});
    await page.evaluate(()=>{
      const ids=['pre_script','database_backup','stop_docker','stop_vms','create','start_docker','start_vms','prune','compact','check','post_script'];
      jobsState.jobs[0].last_job_steps=ids.map(id=>({id,status:'success',duration_seconds:30}));
      renderJobsGrid(jobsState.jobs);
    });
    for(const width of [1280,640,390]) {
      await page.setViewportSize({width,height:900});
      sizes=await geometry();
      assert.equal(new Set(sizes.tops).size,1);
      assert.ok(sizes.scrollWidth>sizes.width,JSON.stringify({width,...sizes}));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await strip.evaluate(node=>node.scrollLeft=0);
      await strip.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(()=>document.querySelector('.borg-stepper').scrollLeft>0);
      await strip.evaluate(node=>node.scrollLeft=node.scrollWidth);
      const position=await strip.evaluate(node=>node.scrollLeft);
      await page.evaluate(()=>renderJobsGrid(jobsState.jobs));
      assert.equal(await strip.evaluate(node=>node.scrollLeft),position);
      assert.equal(await strip.evaluate(node=>node===document.activeElement),true);
      assert.equal(await strip.locator('li').last().evaluate(node=>node.getBoundingClientRect().right<=node.parentElement.getBoundingClientRect().right+1),true);
    }
    if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/workflow-mobile.png`});
    console.log('Browser workflow: continuous animation/node identity, live counters, disclosure/focus, atomic completion, stale polls and keyed reconciliation passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
