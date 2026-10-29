// History remains a chronological table with existing detail/log actions (#627).
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.BBUI_CHROMIUM ? {executablePath:process.env.BBUI_CHROMIUM} : {})});
 try {
 const page = await browser.newPage({viewport:{width:1600,height:1000}});
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 let html = fs.readFileSync('ui/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 html = html.replace(/<link[^>]+href="\/([^\"]+)"[^>]*>/g, (_,path) => path.endsWith('.css') ? `<style>${fs.readFileSync(path,'utf8')}</style>` : '');
 html = html.replace('src="/ui/assets/app-icon.png"', `src="data:image/png;base64,${fs.readFileSync('ui/assets/app-icon.png').toString('base64')}"`);
 await page.setContent(html);
 await page.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation:none!important}'});
 await page.evaluate(dicts => {
  window.lang='de'; window.dicts=dicts; window.logCalls=[]; window.requests=[];
  window.BBUI={components:{logViewer:{open:path=>logCalls.push(path)},i18n:{getLanguage:()=>lang,t:(key,params={})=>{
   const text=key.split('.').reduce((value,part)=>value?.[part],dicts[lang]);return typeof text==='string'?text.replace(/\{(\w+)\}/g,(_,name)=>params[name]??''):key;
  }}}};
  window.translate=()=>document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=BBUI.components.i18n.t(el.dataset.i18n));
  window.jobsFixture=[{job_id:'local-job',name:'Appdata',location:'local'},{job_id:'new-usb-job',name:'Flash',location:'usb'}];
  window.entriesFixture=['success','skipped','error','warning','cancelled'].map((status,i)=>({status,job_id:'local-job',job_name:'Appdata',backup_type:'appdata',location:'local',date:'2026-10-28',time:`13:0${9-i}:00`,duration_fmt:'7m 06s',original_size_fmt:'86.9 GB',deduplicated_size_fmt:'49.3 MB',archive_name:'appdata-2026-10-28',repository_size_fmt:'99 GB',exit_code:status==='success'?0:2,log_file:'/mnt/user/logs/backup.log',files_count:123}));
  entriesFixture.push({...entriesFixture[0],job_name:'Earlier location',location:'storagebox'});
  entriesFixture.push({...entriesFixture[0],entry_kind:'restore_test_report',report_id:'RT-1',job_key:'local-job',steps:[{step_id:'repo_reachable',status:'passed',duration_ms:200,command:'borg info'}],coverage_percent:5});
  window.fetch=async url=>{
   const params=new URL(url,'http://localhost').searchParams;requests.push(Object.fromEntries(params));
   const matching=entriesFixture.filter(e=>(!params.get('location')||e.location===params.get('location'))&&(!params.get('job_key')||e.job_id===params.get('job_key'))&&(!params.get('status')||e.status===params.get('status')));
   const perPage=Number(params.get('per_page')||20),totalPages=Math.max(1,Math.ceil(matching.length/perPage)),current=Math.min(Number(params.get('page')||1),totalPages);
   return {ok:true,json:async()=>({jobs:jobsFixture,entries:matching.slice((current-1)*perPage,current*perPage),total:matching.length,page:current,total_pages:totalPages,location_counts:{local:6,usb:0,smb:0,storagebox:1},location_total:7})};
  };
  document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-history'));
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.page==='history'));
 },Object.fromEntries(['de','en'].map(l=>[l,JSON.parse(fs.readFileSync(`ui/i18n/${l}.json`))])));
 for(const path of ['ui/js/utils/dom.js','ui/js/utils/format.js','ui/js/pages/jobs.js','ui/js/pages/history.js']) await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
 await page.evaluate(()=>{
  document.getElementById('history-content').addEventListener('click',onHistoryContentClick);
  for(const id of ['type','status'])document.getElementById('history-filter-'+id).addEventListener('change',applyHistoryFilters);
 });
 const waitRefresh=async()=>{await page.waitForFunction(()=>!document.getElementById('history-refresh-btn').disabled);};
 for(const lang of ['de','en'])for(const theme of ['light','dark']) {
  await page.setViewportSize({width:1600,height:1000});
  await page.evaluate(async({lang,theme})=>{window.lang=lang;translate();document.documentElement.dataset.theme=theme;document.getElementById('history-filter-location').value='';document.getElementById('history-filter-status').value='';document.getElementById('history-filter-type').value='';BBUI.historyState.page=1;BBUI.historyState.perPage=20;await refreshHistory();},{lang,theme});
  assert.deepEqual(await page.locator('[data-history-location]').evaluateAll(els=>els.map(e=>e.dataset.historyLocation)),['','local','usb']);
  assert.equal(await page.locator('[data-history-location="usb"] .location-nav-count').innerText(),'0');
  assert.equal(await page.locator('#history-tbody > .history-row').count(),7);
  assert.equal(await page.locator('.history-content-table > table > thead th').count(),8);
  assert.equal(await page.locator('#history-tbody > .history-row [data-history-action="open-log"]').count(),0);
  for(const count of await page.locator('#history-location-list .location-nav-count').all())assert.equal(await count.evaluate(el=>getComputedStyle(el).borderTopWidth),'1px');
  for(const status of ['success','skipped','error','warning','cancelled']) {
   const index=['success','skipped','error','warning','cancelled'].indexOf(status);
   const actual=await page.locator(`#hrow-${index} .job-status-icon`).innerHTML();
   const expected=await page.evaluate(status=>{const holder=document.createElement('span');holder.innerHTML=jobStepIcon(status);return holder.innerHTML;},status);assert.equal(actual,expected);
   assert.equal(await page.locator(`#hrow-${index} .history-status-badge`).evaluate(el=>getComputedStyle(el).fontWeight),'400');
   assert.equal(await page.locator(`#hrow-${index} .history-status-badge`).evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
  }
  assert(await page.locator('.history-status-badge.skipped').evaluate(el=>{
   const sample=document.createElement('span');sample.style.background='var(--ui-state-warning-bg)';document.body.append(sample);const match=getComputedStyle(el).backgroundColor===getComputedStyle(sample).backgroundColor;sample.remove();return match;
  }));
  if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/history-${lang}-${theme}.png`,fullPage:true});
  // Existing row expansion and log action remain in the detail area.
  await page.locator('#hrow-0').click();assert(await page.locator('#hdetail-0').isVisible());
  assert.match(await page.locator('#hdetail-0').innerText(),/appdata-2026-10-28/);
  await page.locator('#hdetail-0 [data-history-action="open-log"]').click();
  assert.equal(await page.evaluate(()=>logCalls.at(-1)),'/mnt/user/logs/backup.log');
  assert(await page.locator('#hdetail-0').isVisible());await page.locator('#hrow-0').click();assert(!await page.locator('#hdetail-0').isVisible());
  await page.locator('#hrow-6').click();assert.match(await page.locator('#hdetail-6').innerText(),/borg info/);
  await page.locator('[data-history-location="usb"]').click();await waitRefresh();assert.equal(await page.locator('.history-row').count(),0);
  await page.locator('[data-history-location=""]').click();await waitRefresh();
  await page.selectOption('#history-filter-status','skipped');await waitRefresh();assert.equal(await page.locator('.history-row').count(),1);
  await page.selectOption('#history-filter-status','');await waitRefresh();
  await page.selectOption('#history-filter-type','local-job');await waitRefresh();assert.equal(await page.evaluate(()=>requests.at(-1).job_key),'local-job');
  await page.selectOption('#history-filter-type','');await waitRefresh();
  await page.evaluate(async()=>{BBUI.historyState.perPage=2;await refreshHistory();});
  await page.locator('[data-history-action="page-next"]').click();await waitRefresh();assert.equal(await page.evaluate(()=>requests.at(-1).page),'2');
  await page.locator('[data-history-action="page-prev"]').click();await waitRefresh();assert.equal(await page.evaluate(()=>requests.at(-1).page),'1');
  await page.evaluate(async()=>{BBUI.historyState.perPage=20;await refreshHistory();});
  for(const width of [1920,1280,768,390]) {
   await page.setViewportSize({width,height:1000});
   const dims=await page.evaluate(()=>{const nav=document.querySelector('.history-sidebar').getBoundingClientRect(),table=document.querySelector('.history-content-table').getBoundingClientRect();return {full:document.documentElement.scrollWidth<=innerWidth+2,above:nav.bottom<=table.top,aligned:Math.abs(nav.left-table.left)<2};});assert.deepEqual(dims,{full:true,above:true,aligned:true});
  }
 }
 // Visibility follows configured jobs, not old entries, page size or status filters.
 await page.evaluate(async()=>{document.getElementById('history-filter-location').value='usb';jobsFixture=jobsFixture.filter(j=>j.location!=='usb');BBUI.historyState.page=4;await refreshHistory();});
 assert.equal(await page.locator('[data-history-location="usb"]').count(),0);
 assert.equal(await page.locator('#history-filter-location').inputValue(),'');assert.equal(await page.evaluate(()=>requests.at(-1).page),'1');assert.equal(await page.locator('.history-row').count(),7);
 await page.evaluate(async()=>{jobsFixture.push({job_id:'smb-new',name:'New',location:'smb'});await refreshHistory();});
 assert.equal(await page.locator('[data-history-location="smb"] .location-nav-count').innerText(),'0');
 await page.evaluate(async()=>{jobsFixture=[];await refreshHistory();});assert.equal(await page.locator('[data-history-location]').count(),1);
 assert.deepEqual(errors,[]);console.log('History browser passed: DE/EN, themes, columns, Jobs icons, yellow skipped, job-based locations, filters, paging and unchanged detail/log actions.');
 } finally {await browser.close();}
})();
