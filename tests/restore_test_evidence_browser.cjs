// Real-browser coverage for compact planning and cumulative inline evidence (#610).
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BBUI_CHROMIUM?{executablePath:process.env.BBUI_CHROMIUM}:{})});
 try {
 const page=await browser.newPage({viewport:{width:1600,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let html=fs.readFileSync('ui/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 html=html.replace(/<link[^>]+href="\/([^\"]+)"[^>]*>/g,(all,path)=>path.endsWith('.css')?`<style>${fs.readFileSync(path,'utf8')}</style>`:'');
 html=html.replace('src="/ui/assets/app-icon.png"',`src="data:image/png;base64,${fs.readFileSync('ui/assets/app-icon.png').toString('base64')}"`);
 await page.setContent(html);
 await page.evaluate(dicts=>{
  window.lang='de';window.dicts=dicts;window.BBUI={components:{i18n:{getLanguage:()=>lang,t:(key,params={})=>{
   const text=key.split('.').reduce((v,k)=>v?.[k],dicts[lang]);return typeof text==='string'?text.replace(/\{(\w+)\}/g,(_,k)=>params[k]??''):key;
  }}}};
  window.resolveJobIcon=()=> 'archive';window.resolveJobIconColor=()=>'';window.isStaleDate=()=>false;
  window.translate=()=>document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=BBUI.components.i18n.t(el.dataset.i18n));
  window.showMsg=()=>{};
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-restore-tests'));
  document.documentElement.dataset.theme='light';document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page==='restore-tests'));translate();
 },Object.fromEntries(['de','en'].map(l=>[l,JSON.parse(fs.readFileSync(`ui/i18n/${l}.json`))])));
 for(const path of ['ui/js/utils/dom.js','ui/js/utils/format.js','ui/js/pages/dashboard.js','ui/js/pages/restore-tests.js'])await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
 await page.evaluate(()=>{
  const state=BBUI.restoreTestsState;
  state.plan={jobs:['Appdata','All-VMs','Flash','Photos','Sonstiges'].map((name,i)=>({job_key:String(i),key:String(i),name,display_name:name,location:i<3?'local':'storagebox',enabled:true,scheduler_state:i===4?'off':'active',policy:{mode:i===4?'manual_only':'scheduled',level:3,cron:i===4?'':'0 20 1 * *',validity_days:30},last_test_date:i===4?'':'2026-10-27 10:14:22',last_test_result:i===0?'cancelled':i===3?'failed':i===4?'':'success',next_run_at:'2026-11-01 20:00:00',verification_status:i===3?'failed':'verified',verification_evidence_date:'2026-10-26 23:10:52',verification_valid_until:'2026-11-25 23:10:52'}))};
  state.jobs=state.plan.jobs;
  const success={job_key:'0',job_name:'Appdata',test_date:'2026-10-26 23:10:52',test_level:3,test_result:'success',tested_archive:'appdata-backup-2026-10-26_09-00-37',repository:'/mnt/user/backup/appdata',location:'local',report_id:'RT-DEMO',log_file:'/mnt/user/borg_backup_ui/logs/Borg-Restore-Test-2026-10-26.log',test_exit_code:0,duration_formatted:'14 Min. 32 Sek.',tested_files_count:1000,tested_folders_count:0,coverage_basis:'1000/416901',test_coverage_percentage:.2,archive_stats:{files_count:416901},archive_stats_formatted:{original:'86.8 GiB'},level3_details:{enabled:true,success_count:5,checksums:['data/file.txt:deadbeef']},steps:['repo_reachable','archive_readable','metadata_check','restore_probe','integrity_check','cleanup'].map(step_id=>({step_id,status:'passed',duration_ms:500,timestamp:step_id==='archive_readable'?'2026-10-26 23:00:00':undefined}))};
  state.data=[{...success,test_date:'2026-10-27 10:14:22',test_result:'failed',failure_code:'RT_CANCELLED',report_id:'RT-CANCEL'},success,{...success,job_key:'3',test_result:'failed',failure_code:'RT_SAMPLE_RESTORE_FAILED',error_analysis:{error_details:'Failure <script>alert(1)</script>\n'+ 'missing-file/'.repeat(30)},report_id:'RT-FAIL'}];
  document.getElementById('restore-tests-plan-content').addEventListener('click',onRestoreTestsPlanClick);
  document.getElementById('restore-tests-content').addEventListener('click',onRestoreTestsContentClick);
  document.getElementById('rt-subtab-plan-btn').onclick=()=>switchRestoreTestsSubtab('plan');
  document.getElementById('rt-subtab-reports-btn').onclick=()=>switchRestoreTestsSubtab('reports');
  window.renderDemo=()=>{renderRestorePlan(state.plan);renderRestoreTestsSidebar();renderRTReportFilterOptions(state.data);renderRestoreTests(state.data);renderRestoreTestsSubtab();updateRestoreTestsWorkspace();};renderDemo();
 });
 const capture=async name=>{await page.evaluate(()=>window.scrollTo(0,0));if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({fullPage:true,path:`${process.env.BBUI_SCREENSHOT_DIR}/${name}.png`});};
 for(const language of ['de','en']){
  await page.evaluate(l=>{lang=l;translate();BBUI.restoreTestsState.selectedJob='all';BBUI.restoreTestsState.subtab='plan';renderDemo();},language);
  assert.equal(await page.locator('#restore-tests-plan-content th').count(),4);
  assert.equal(await page.locator('.restore-tests-hint').getAttribute('open'),null);
  await capture(`restore-plan-${language}`);
  const row=page.locator('[data-rt-job-key="0"]');
  await row.locator('.rt-plan-menu summary').click();await row.locator('[data-rt-plan-action=edit]').click();
  await page.locator('#rt-plan-dialog[open]').waitFor();await page.locator('#rt-plan-dialog [data-close]').first().click();
  await row.locator('[data-rt-plan-action=reports]').click();
  assert(await page.locator('#rtr-0[open]').count());
  assert.equal(await page.locator('#rtr-0 .rt-proof-document').count(),0);
  await page.locator('#rtr-0 [data-rt-action=evidence]').click();
  assert.equal(await page.locator('#rtr-1[open] .rt-proof-document').count(),1);
  assert.equal(await page.locator('#rtr-1 .rt-level-row .rt-attempt-status.success').count(),3);
  await page.evaluate(()=>renderRestoreTests(BBUI.restoreTestsState.data));
  assert.equal(await page.locator('#rtr-1[open]').count(),1);
  assert.equal(await page.locator('#rtr-1 .rt-technical-evidence').count(),1);
  await page.locator('#rtr-1 .rt-technical-evidence > summary').click();
  const technical=page.locator('#rtr-1 .rt-technical-evidence');
  assert.equal(await technical.getByText(language==='de'?'Report-ID':'Report ID',{exact:true}).count(),0);
  assert.equal(await technical.getByText(language==='de'?'Ausführung':'Execution',{exact:true}).count(),0);
  const archiveStep=technical.locator('.rt-step-row').filter({hasText:language==='de'?'Archiv lesbar':'Archive readable'});
  await archiveStep.locator('.rt-check-evidence > summary').click();
  const hashStep=technical.locator('.rt-step-row').filter({hasText:language==='de'?'Integritätsprüfung':'Integrity check'});
  await hashStep.locator('.rt-check-evidence > summary').click();
  await hashStep.locator('.rt-step-detail-section > summary').click();
  await hashStep.getByText('deadbeef',{exact:true}).waitFor();
  await capture(`restore-proof-${language}`);
  await page.evaluate(()=>{BBUI.restoreTestsState.selectedJob='all';renderDemo();});
  await page.locator('#rtr-2 > summary').click();
  assert.equal(await page.locator('#rtr-2 script').count(),0);
  assert.match(await page.locator('#rtr-2').innerText(),/<script>/);
  await page.evaluate(()=>{document.getElementById('rt-report-filter-status').value='cancelled';renderRestoreTests(BBUI.restoreTestsState.data);});
  assert.equal(await page.locator('.rt-report-entry').count(),1);
  await page.evaluate(()=>{document.getElementById('rt-report-filter-status').value='all';renderDemo();});
 }
 for(const theme of ['light','dark'])for(const width of [1920,1100,768,390]){
  await page.setViewportSize({width,height:1000});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;BBUI.restoreTestsState.selectedJob='all';switchRestoreTestsSubtab('plan');renderDemo();},theme);
  assert(await page.locator('#restore-tests-plan-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`plan overflow ${width}`);
  await page.locator('[data-rt-job-key="0"] [data-rt-plan-action=reports]').click();
  await page.locator('[data-rt-action=evidence]').click();
  await page.locator('#rtr-1 .rt-technical-evidence').evaluate(el=>{el.open=true;el.querySelectorAll('.rt-check-evidence').forEach(detail=>detail.open=true);});
  const factGroups=await page.locator('#rtr-1 .rt-technical-evidence .rt-step-details').evaluateAll(groups=>groups.map(group=>({gap:getComputedStyle(group).gap,items:[...group.children].map(item=>({background:getComputedStyle(item).backgroundColor,expected:getComputedStyle(item.closest('.rt-report-card').querySelector('.rt-step-row')).backgroundColor}))})));
  assert(factGroups.length>1,'diagnostics and check data are rendered');
  for(const group of factGroups){
   assert.equal(group.gap,'1px',`thin fact separators in ${theme} at ${width}`);
   for(const item of group.items)assert.equal(item.background,item.expected,`fact surface matches report in ${theme} at ${width}`);
  }
  assert(await page.locator('#restore-tests-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1),`report overflow ${width}`);
  if(width===390)await capture(`restore-proof-mobile-${theme}`);
 }
 assert.deepEqual(errors,[]);console.log('Restore test planning/evidence browser checks passed: DE/EN, desktop/mobile, both themes, editing, report navigation, cancellation and escaping.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
