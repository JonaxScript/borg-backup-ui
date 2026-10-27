// Browser regression for compact summaries, inline disclosures and responsive telemetry (#607).
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.BBUI_CHROMIUM ? {executablePath:process.env.BBUI_CHROMIUM} : {})});
  try {
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let html = fs.readFileSync('ui/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<link[^>]+href="\/([^\"]+)"[^>]*>/g, (all, path) => path.endsWith('.css') ? `<style>${fs.readFileSync(path, 'utf8')}</style>` : '');
  html = html.replace('src="/ui/assets/app-icon.png"', `src="data:image/png;base64,${fs.readFileSync('ui/assets/app-icon.png').toString('base64')}"`);
  await page.setContent(html);
  const dictionaries = Object.fromEntries(['de','en'].map(l => [l, JSON.parse(fs.readFileSync(`ui/i18n/${l}.json`))]));
  await page.evaluate(dicts => {
    window.lang = 'de'; window.dicts = dicts;
    const backups = ['All-VMs', 'Appdata', 'Flash', 'Photos', 'Portableapps-Dockcase', 'Test-PR-595'].map((name, i) => ({
      key: String(i), name, display_name: name, location: 'local', status: 'success', duration: '14 Min. 17 Sek.',
      restore_verification_status: 'verified', total_size: '162.3 GB', last_backup: '2026-10-26T09:00:00Z',
      archive_name: `${name.toLowerCase()}-backup-2026-10-26_09-00-37`}));
    backups[4].status='error'; backups[4].error_message='Required source is missing <script>not executable</script>';
    for(let i=6;i<14;i++) backups.push({key:String(i),name:`Demo ${i}`,location:i<10?'usb':'storagebox',status:'success',restore_verification_status:'not_required'});
    window.BBUI = {components: {i18n: {getLanguage: () => lang, t: (key, params = {}) => {
      const text = key.split('.').reduce((v,k) => v?.[k], dicts[lang]);
      return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_,k) => params[k] ?? '') : key;
    }}}, core: {state: {currentPage: 'dashboard', data: {backups}}, getSchedulesData: () => ({})}};
    window.resolveJobIcon = () => 'archive'; window.resolveJobIconColor = () => '';
    window.isStaleDate = () => false; window.calcNextRun = () => new Date();
    window.demoIdle = true;
    const group = {id:'demo', job_key:'1', cpu_percent:12, memory_bytes:1.3*1024**3, memory_limit_bytes:2*1024**3};
    window.fetch = async () => ({ok:true, json:async () => ({available:true, stale:false,
      host:{cpu_percent:1.3, memory_available_bytes:36.5*1024**3, memory_total_bytes:62.7*1024**3},
      runs_available:true, runs:demoIdle ? [] : [{job_key:'1', operation:'restore_test'}],
      protected_tests:demoIdle ? [] : [group], configured_reserve_bytes:1024**3,
      history:Array.from({length:121}, (_,i) => ({timestamp:Date.now()/1000-600+i*5,
        host:{cpu_percent:1.3+.4*Math.sin(i*.5), memory_available_bytes:(36.5+Math.sin(i*.2)*.2)*1024**3},
        protected_tests:[{...group,cpu_percent:12+3*Math.sin(i*.3),memory_bytes:(1.1+i/600)*1024**3}]}))})});
    document.documentElement.dataset.theme = 'light';
    window.translate = () => document.querySelectorAll('[data-i18n]').forEach(el => {el.textContent=BBUI.components.i18n.t(el.dataset.i18n);});
    translate();
  }, dictionaries);
  for (const path of ['ui/js/utils/dom.js','ui/js/utils/format.js','ui/js/pages/dashboard.js','ui/js/components/resource-monitor.js','ui/js/pages/jobs.js']) await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
  await page.evaluate(() => {
    const data = BBUI.core.state.data;
    const steps = ['stop_vms','create','start_vms','prune','compact','check'].map(id => ({id,status:'success',duration_seconds:60}));
    data.backups[0] = {...data.backups[0], job_steps:steps, timestamp:'2026-10-24 00:47:00', original_size:1500, original_size_formatted:'1.5 TB', repository_size:991, repository_size_formatted:'991 GB', deduplicated_size_formatted:'194 GB', compressed_size_formatted:'562 GB', error_message:''};
    data.backups[4].error_message += '\nMissing path: /mnt/disks/' + 'long-path-'.repeat(20);
    window.demoJobs = data.backups.map(b => ({...b, enabled:true, archive_prefix:b.name, compression:'lz4', retention_daily:7,retention_weekly:4,retention_monthly:6,retention_yearly:3}));
    window.telemetryFetch = window.fetch;
    window.overviewQueries=[];
    window.fetch = async url => {
      if (url.startsWith('/api/reports/overview')) {
        overviewQueries.push(url);
        const params=new URL('http://local'+url).searchParams;
        const days=Number(params.get('days'));
        return {ok:true,json:async()=>({days,location:params.get('location'),from:'2026-10-01',to:'2026-10-27',run_count:days*3,success_rate:200/3,counts:{success:days*2,warning:0,error:days,skipped:0,cancelled:0,unknown:0},repository_count:2,unassigned_jobs:0,repository_last_sample:'2026-10-27T09:00:00Z',daily:Array.from({length:days},(_,i)=>({date:'2026-10-'+String(i+1).padStart(2,'0'),success:2,warning:0,error:1,skipped:0,cancelled:0,unknown:0,repository_bytes:(300+i)*1024**3,measured_repositories:2}))})};
      }
      if(url==='/api/jobs')return {ok:true,json:async()=>({jobs:demoJobs})};
      if(url==='/api/status')return {ok:true,json:async()=>data};
      if(url==='/api/schedules'||url==='/api/jobs/running')return {ok:true,json:async()=>({})};
      return telemetryFetch(url);
    };
    Object.assign(BBUI.core,{isGlobalDataDirReady:()=>true,updateDataDirWarning:async()=>{},setSchedulesData:()=>{},navigate:page=>{
      document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page));
      BBUI.core.state.currentPage=page;
      if(page==='jobs') {BBUI.resourceMonitor.stop(); refreshJobs();}
    }});
    document.getElementById('jobs-grid').addEventListener('click',onJobsGridClick);
    renderDashboard(data,null); refreshDashboardOverview(); BBUI.resourceMonitor.start();
  });
  const capture=async name=>{if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({animations:'disabled',fullPage:true,path:`${process.env.BBUI_SCREENSHOT_DIR}/${name}.png`});};
  await page.waitForSelector('.management-bars');
  assert.equal(await page.locator('.dashboard-summary-section').count(),3);
  assert.equal(await page.locator('.dashboard-coverage-track .success').count(),6);
  assert.equal(await page.locator('#backup-grid').count(),0);
  assert.match(await page.locator('#dashboard-attention').innerText(),/<script>not executable<\/script>/);
  assert.equal(await page.locator('#dashboard-attention script').count(),0);
  const cards=await page.locator('.dashboard-summary-pair > section').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));
  assert(cards.every(top=>top===cards[0]));
  await capture('management-dashboard-de');
  // Background refresh must preserve chart geometry, SVG/table identity and focus.
  assert.deepEqual(await page.locator('#dashboard-location-filter option').evaluateAll(nodes=>nodes.map(n=>n.value)), ['all','local','usb','storagebox']);
  assert.equal(await page.locator('#dashboard-locations tbody tr').count(), 3);
  assert.equal(await page.locator('#dashboard-location-filter option[value="all"]').innerText(), 'Alle Standorte');
  const stability = await page.evaluate(async () => {
    const trends = document.getElementById('dashboard-trends');
    const locations = document.getElementById('dashboard-locations');
    const bars = trends.querySelector('.management-bars');
    const svg = trends.querySelector('svg');
    const line = svg.querySelector('.management-chart-line');
    const row = document.getElementById('dashboard-location-local');
    const action = row.querySelector('button');
    action.focus({preventScroll:true});
    const height = trends.getBoundingClientRect().height;
    const savedFetch = window.fetch;
    let mutations=0;
    const observer = new MutationObserver(records=>{mutations+=records.length;});
    for (const node of [trends,locations]) observer.observe(node,{childList:true,subtree:true,attributes:true,characterData:true});
    const unchanged = [];
    for (let i=0; i<3; i++) {
      window.fetch = () => new Promise(resolve=>{window.releaseOverview=resolve;});
      renderDashboard(BBUI.core.state.data,null);
      const refresh = refreshDashboardOverview();
      unchanged.push(bars === trends.querySelector('.management-bars') && height === trends.getBoundingClientRect().height);
      releaseOverview({ok:true,json:async()=>structuredClone(dashboardOverview)});
      await refresh;
      unchanged.push(svg === trends.querySelector('svg') && row === document.getElementById('dashboard-location-local') && action === document.activeElement);
    }
    const writes = mutations + observer.takeRecords().length;
    observer.disconnect();
    // New values update existing text/paths instead of rebuilding the view.
    const overview = structuredClone(dashboardOverview);
    const originalStatus = BBUI.core.state.data.backups[0].status;
    BBUI.core.state.data.backups[0].status='error';
    renderDashboard(BBUI.core.state.data,null);
    dashboardOverview.success_rate=75;
    dashboardOverview.daily[0].repository_bytes=100*1024**3;
    const previousPath=line.getAttribute('d');
    renderDashboardTrends();
    const changed = svg === trends.querySelector('svg') && line === svg.querySelector('.management-chart-line') && previousPath !== line.getAttribute('d') && row.cells[2].textContent === '4/6' && trends.querySelector('strong').textContent === '75 %';
    BBUI.core.state.data.backups[0].status=originalStatus;
    dashboardOverview=overview;
    window.fetch=savedFetch;
    renderDashboard(BBUI.core.state.data,null);
    return {unchanged,writes,changed};
  });
  assert(stability.unchanged.every(Boolean));
  assert.equal(stability.writes,0);
  assert(stability.changed);
  // Removing the selected location resets the filter; unaffected rows survive removals.
  const emptyLocations = await page.evaluate(() => {
    const data=BBUI.core.state.data;
    const backups=data.backups;
    const storagebox=document.getElementById('dashboard-location-storagebox');
    data.backups=backups.filter(b=>b.location!=='usb');
    renderDashboard(data,null);
    const preserved=storagebox===document.getElementById('dashboard-location-storagebox');
    dashboardSelectedLocation='usb';
    renderDashboard(data,null);
    const reset=dashboardSelectedLocation==='all' && document.getElementById('dashboard-location-filter').value==='all' && !document.querySelector('#dashboard-location-filter option[value="usb"]');
    data.backups=[];
    renderDashboard(data,null);
    const empty=document.querySelectorAll('#dashboard-locations tbody tr').length===0 && document.querySelectorAll('#dashboard-location-filter option').length===1;
    data.backups=backups;
    renderDashboard(data,null);
    return {preserved,reset,empty};
  });
  assert.deepEqual(emptyLocations,{preserved:true,reset:true,empty:true});
  await page.locator('#dashboard-location-filter').selectOption('usb');
  await page.waitForFunction(()=>dashboardOverview?.location==='usb');
  assert.equal(await page.locator('.dashboard-summary-ring strong').innerText(),'4');
  assert.equal(await page.locator('.dashboard-summary-ring small').innerText(),'/4');
  assert.equal(await page.locator('.dashboard-coverage-track .success').count(),0);
  assert.equal(await page.locator('#dashboard-attention li').count(),0);
  await page.locator('#dashboard-period').selectOption('7');
  await page.waitForFunction(()=>dashboardOverview?.days===7);
  assert.equal(await page.locator('.management-bar').count(),7);
  await page.locator('#dashboard-location-filter').selectOption('all');
  await page.evaluate(()=>{demoIdle=false;BBUI.resourceMonitor.stop();BBUI.resourceMonitor.start();});
  await page.waitForSelector('#resource-tests .resource-test');
  const full=await page.locator('#resource-activity').boundingBox();
  const summary=await page.locator('.dashboard-summary-pair').boundingBox();
  assert(Math.abs(full.width-summary.width)<2);
  assert(await page.locator('#resource-history').isHidden());
  await page.locator('#resource-history-toggle').click();
  const plots=await page.locator('#resource-history [data-resource-plot-key="host-cpu"], #resource-history [data-resource-plot-key="host-ram"]').evaluateAll(nodes=>nodes.map(n=>({top:n.getBoundingClientRect().top,left:n.getBoundingClientRect().left})));
  assert.equal(plots.length,2);assert.equal(plots[0].top,plots[1].top);
  await page.locator('#dashboard-attention [data-dashboard-jobs="4"]').click();
  await page.waitForSelector('#job-card-4 .job-saved-status .dashboard-job-details', {timeout:5000}).catch(async error => { console.error(errors, await page.locator('#jobs-message').innerText()); throw error; });
  assert(await page.locator('#job-card-4 .dashboard-job-details').isVisible());
  assert.match(await page.locator('#job-card-4 .job-saved-message').innerText(),/Missing path:/);
  assert.equal(await page.locator('#jobs-grid script').count(),0);
  assert.equal(await page.locator('#job-card-0 .borg-step').count(),6);
  const timeline=await page.locator('#job-card-0 .borg-stepper').innerHTML();
  await page.locator('#job-card-0 [data-jobs-action="toggle-status"]').click();
  assert.equal(await page.locator('#job-card-0 .borg-stepper').innerHTML(),timeline);
  await page.locator('#job-card-0 [data-jobs-action="toggle-workflow"]').click();
  assert(await page.locator('#job-card-0 .job-workflow-details').isVisible());
  assert(await page.locator('#job-card-0 .dashboard-job-details').isVisible());
  await page.evaluate(()=>refreshJobs());
  assert(await page.locator('#job-card-0 .job-workflow-details').isVisible());
  assert(await page.locator('#job-card-0 .dashboard-job-details').isVisible());
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.jobsAction),'toggle-workflow');
  await page.evaluate(()=>{jobsState.jobs[4].running=true;renderJobsGrid(jobsState.jobs);});
  assert.match(await page.locator('#job-card-4 .job-saved-message').innerText(),/Letztes gespeichertes Ergebnis/);
  // The latest cancelled attempt must not replace a still-valid restore proof.
  for (const language of ['de','en']) {
    const proof = await page.evaluate(language => {
      window.lang=language;
      const row={...jobsState.jobs[0], restore_verification_status:'verified', restore_verification_last_test_result:'cancelled',
        restore_verification_last_test_date:'2026-10-27 10:14:22', restore_verification_evidence_date:'2026-10-26 23:10:52',
        restore_verification_valid_until:'2026-11-25 23:10:52'};
      Object.assign(demoJobs[0], row);
      Object.assign(BBUI.core.state.data.backups[0], {
        restore_verification_status:row.restore_verification_status,
        restore_verification_last_test_result:row.restore_verification_last_test_result,
        restore_verification_last_test_date:row.restore_verification_last_test_date,
        restore_verification_evidence_date:row.restore_verification_evidence_date,
        restore_verification_valid_until:row.restore_verification_valid_until,
      });
      return {card:renderJobRestoreVerification(row),details:renderDashboardRestoreVerificationBadge(row)};
    },language);
    await page.evaluate(()=>refreshJobs());
    assert.match(await page.locator('#job-card-0 .job-restore-proof').innerText(), language==='de'?/[Aa]bgebrochen/:/[Cc]ancelled/);
    assert.equal(await page.locator('#job-card-0 .job-restore-proof .restore-v-badge.success').count(),1);
    for (const html of Object.values(proof)) {
      assert.match(html,/restore-v-badge success/);
      assert.match(html,language==='de'?/[Aa]bgebrochen/:/[Cc]ancelled/);
      assert.match(html,/2026-10-26 23:10:52/);
      assert.match(html,/2026-10-27 10:14:22/);
      assert.match(html,/2026-11-25 23:10:52/);
    }
  }
  await page.evaluate(()=>{window.lang='de';});
  await capture('management-jobs-de');
  for(const lang of ['de','en'])for(const theme of ['light','dark']) {
    await page.evaluate(({lang,theme})=>{window.lang=lang;document.documentElement.dataset.theme=theme;translate();renderJobsGrid(jobsState.jobs);},{lang,theme});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await capture(`management-jobs-${lang}-${theme}-mobile`);
    await page.evaluate(()=>{BBUI.core.navigate('dashboard');renderDashboard(BBUI.core.state.data,null);});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.equal(await page.locator('#dashboard-location-filter option[value="all"]').innerText(), lang==='de'?'Alle Standorte':'All locations');
    await capture(`management-dashboard-${lang}-${theme}-mobile`);
    await page.evaluate(()=>BBUI.core.navigate('jobs'));
  }
  assert.deepEqual(errors,[]);
  console.log('Management dashboard / Jobs browser checks passed (DE/EN, desktop/mobile, light/dark, independent disclosures, full errors, live tests, stable refresh, empty locations).');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
