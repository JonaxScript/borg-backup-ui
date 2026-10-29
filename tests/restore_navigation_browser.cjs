// Shared Restore tabs retain the complete archive/restore/history workflow (#631).
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.BBUI_CHROMIUM ? {executablePath:process.env.BBUI_CHROMIUM} : {})});
 try {
 const page = await browser.newPage({viewport:{width:1600,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let html=fs.readFileSync('ui/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 html=html.replace(/<link[^>]+href="\/([^\"]+)"[^>]*>/g,(_,path)=>path.endsWith('.css')?`<style>${fs.readFileSync(path,'utf8')}</style>`:'');
 html=html.replace('src="/ui/assets/app-icon.png"',`src="data:image/png;base64,${fs.readFileSync('ui/assets/app-icon.png').toString('base64')}"`);
 await page.setContent(html);
 await page.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation:none!important}'});
 await page.evaluate(dicts=>{
  window.lang='de';window.dicts=dicts;
  window.BBUI={core:{state:{currentPage:'restore'}},components:{i18n:{getLanguage:()=>lang,t:(key,params={})=>{
   const text=key.split('.').reduce((value,part)=>value?.[part],dicts[lang]);return typeof text==='string'?text.replace(/\{(\w+)\}/g,(_,name)=>params[name]??''):key;
  }}}};
  window.translate=()=>document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=BBUI.components.i18n.t(el.dataset.i18n));
  window.jobsFixture=[
   {key:'local-app',name:'Appdata',location:'local',backup_type:'appdata',icon:'box',icon_color:'orange',archive_prefix:'appdata-backup',repository_name:'Local repository'},
   {key:'local-vm',name:'All-VMs',location:'local',backup_type:'vms',icon:'server',icon_color:'green'},
   {key:'usb-app',name:'Appdata',location:'usb',backup_type:'appdata'},
   {key:'ssh-photo',name:'Photos with a very long name for a backup job',location:'storagebox',backup_type:'photos'},
   {key:'utility',name:'Maintenance',location:'smb',is_utility:true},
  ];
  window.historyFixture=[{restore_id:'history-1',job_key:'local-app',job_name:'Appdata',archive:'saved-archive',target_dir:'/mnt/user/restore',state:'done',dry_run:true,duration_seconds:12,started_at:'2026-10-28 10:30:00',finished_at:'2026-10-28 10:30:12'}];
  window.calls=[];window.posts=[];window.runResult='running';
  window.fetch=async(url,options={})=>{
   calls.push(url);let data={};const u=new URL(url,'http://localhost');
   if(options.body)posts.push({url,body:JSON.parse(options.body)});
   if(url==='/api/jobs')data={jobs:jobsFixture};
   else if(u.pathname==='/api/restore/target-dirs')data={allowed_roots:['/mnt/user'],dirs:[]};
   else if(u.pathname==='/api/restore/archives')data={archives:[{name:`${u.searchParams.get('job')}-2026-10-28`,start:'2026-10-28T09:00:00'}],archive_filters:[{filter:'appdata-backup-*',current:true}]};
   else if(u.pathname==='/api/restore/files')data={files:u.searchParams.get('path')==='folder'?[{name:'child.txt',path:'folder/child.txt',type:'-',size:12}]:[{name:'folder',path:'folder',type:'d'},{name:'readme.txt',path:'readme.txt',type:'-',size:20}]};
   else if(u.pathname==='/api/restore/runs')data={runs:[]};
   else if(u.pathname==='/api/restore/history')data={runs:historyFixture,total:historyFixture.length};
   else if(u.pathname==='/api/restore/history/detail')data={...historyFixture[0],lines:['Saved restore log'],source_paths:['folder'],counts_complete:true,counts:{files:1,directories:1}};
   else if(u.pathname==='/api/restore/precheck'){
    const body=JSON.parse(options.body);data={ok:true,target_dir:body.target_dir,source_paths:body.source_paths,items:body.source_paths.map(path=>({source_path:path,source_type:path==='folder'?'directory':'file',destination_path:body.target_dir+'/'+path,status:'ok'})),checks:{target_exists:true,target_writable:true,space_ok:true}};
   }else if(u.pathname==='/api/restore/start')data={restore_id:'run-1'};
   else if(u.pathname==='/api/restore/state')data={state:runResult,dry_run:true,job_name:'Appdata',archive:'local-app-2026-10-28',target_dir:'/mnt/user/restore',source_paths:['folder','readme.txt'],duration_seconds:12};
   else throw Error('Unexpected URL '+url);
   return {ok:true,status:200,json:async()=>data};
  };
  document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-restore'));
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.page==='restore'));
 },Object.fromEntries(['de','en'].map(l=>[l,JSON.parse(fs.readFileSync(`ui/i18n/${l}.json`))])));
 for(const path of ['ui/js/utils/dom.js','ui/js/utils/format.js','ui/js/pages/dashboard.js','ui/js/pages/jobs.js','ui/js/pages/settings.js','ui/js/pages/restore.js'])await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
 await page.evaluate(()=>{
  for(const [id,event,fn] of [
   ['restore-wizard','click',onRestoreRedesignClick],['restore-step-next-btn','click',restoreStepNext],['restore-step-back-btn','click',restoreStepBack],
   ['restore-browser','click',onRestoreBrowserClick],['restore-target-path','input',restoreTargetInputChanged],['restore-confirm-check','change',restoreUpdateConfirmState],
   ['restore-conflict-mode','change',restorePrecheckInputsChanged],['restore-dry-run','change',restorePrecheckInputsChanged],['restore-start-btn','click',restoreStart],
   ['restore-history-content','click',onRestoreHistoryClick],['restore-archive-filter-mode','change',restoreChangeArchiveFilter],
   ['restore-archive-filter-pattern','input',restoreEditArchiveFilter],['restore-archive-filter-apply','click',restoreApplyArchiveFilter],
  ])document.getElementById(id).addEventListener(event,fn);
  document.getElementById('restore-view-history-btn').onclick=()=>restoreSwitchView('history');
  document.getElementById('restore-view-wizard-btn').onclick=()=>restoreSwitchView('wizard');
 });
 const capture=async name=>{if(process.env.BBUI_SCREENSHOT_DIR){fs.mkdirSync(process.env.BBUI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/${name}.png`,fullPage:true});}};
 for(const language of ['de','en'])for(const theme of ['light','dark']){
  await page.setViewportSize({width:1600,height:1100});
  await page.evaluate(async({language,theme})=>{lang=language;translate();document.documentElement.dataset.theme=theme;BBUI.restoreState.job='';BBUI.restoreState.view='wizard';await restoreInit();},{language,theme});
  assert.deepEqual(await page.locator('[data-restore-location]').evaluateAll(es=>es.map(e=>e.dataset.restoreLocation)),['local','usb','storagebox']);
  assert.equal(await page.locator('#restore-stepper button').count(),4);
  assert.equal(await page.locator('[data-restore-location=local] .location-nav-count').innerText(),'2');
  assert.equal(await page.locator('[data-restore-location=local] .location-nav-count').evaluate(e=>getComputedStyle(e).borderTopWidth),'1px');
  assert.equal(await page.locator('[data-restore-job=local-app][aria-pressed=true]').count(),1);
  const footer=await page.locator('.restore-wizard-actions').evaluate(e=>e.getBoundingClientRect().top+scrollY);
  await capture(`restore-archive-${language}-${theme}`);
  await page.locator('[data-restore-step="5"]').click();
  assert.equal(await page.evaluate(()=>BBUI.restoreState.step),2); // Cannot skip prerequisites.
  await page.locator('[data-restore-archive]').click();
  await page.waitForFunction(()=>BBUI.restoreState.files.length===2);
  await page.locator('#restore-step-next-btn').click();
  await page.locator('input[data-restore-action=select][data-path=folder]').check();
  await page.locator('input[data-restore-action=select][data-path="readme.txt"]').check();
  assert.equal(await page.locator('[data-restore-action=download]').count(),2);
  await capture(`restore-selection-${language}-${theme}`);
  await page.locator('#restore-step-next-btn').click();
  await page.locator('#restore-target-path').fill('/etc/forbidden');await page.locator('#restore-step-next-btn').click();
  assert.equal(await page.evaluate(()=>BBUI.restoreState.step),4);
  await page.locator('#restore-msg .page-feedback-close').click();
  await page.locator('#restore-target-path').fill('/mnt/user/restore');
  await page.locator('#restore-conflict-mode').selectOption('rename');
  await page.locator('#restore-preserve-owner').check();
  await page.locator('#restore-step-next-btn').click();
  await page.waitForFunction(()=>BBUI.restoreState.precheck?.ok&&!BBUI.restoreState.assistBusy);
  assert.deepEqual(await page.evaluate(()=>posts.filter(p=>p.url==='/api/restore/precheck').at(-1).body.source_paths),['folder','readme.txt']);
  assert.equal(await page.locator('#restore-start-btn').isDisabled(),true);
  assert.ok(Math.abs((await page.locator('.restore-wizard-actions').evaluate(e=>e.getBoundingClientRect().top+scrollY))-footer)<2,'Stable wizard footer');
  await capture(`restore-review-${language}-${theme}`);
  // Location filtering does not discard the existing draft. Switching job does.
  await page.locator('[data-restore-location=usb]').click();
  assert.equal(await page.evaluate(()=>BBUI.restoreState.job),'local-app');
  await page.locator('[data-restore-job=usb-app]').click();
  await page.locator('#settings-dialog-cancel-btn').click();
  assert.equal(await page.evaluate(()=>BBUI.restoreState.job),'local-app');
  await page.locator('[data-restore-job=usb-app]').click();
  await page.locator('#settings-dialog-confirm-btn').click();
  await page.waitForFunction(()=>BBUI.restoreState.job==='usb-app'&&!BBUI.restoreState.changingJob);
  assert.equal(await page.evaluate(()=>BBUI.restoreState.step),2);
  assert.equal(await page.evaluate(()=>BBUI.restoreState.archive),'');
  assert.equal(await page.locator('#restore-target-path').inputValue(),'/mnt/user/');
  assert.equal(await page.locator('#restore-conflict-mode').inputValue(),'skip');
  assert.equal(await page.locator('#restore-preserve-owner').isChecked(),false);
  assert.equal(await page.locator('#restore-dry-run').isChecked(),true);
  await page.locator('#restore-view-history-btn').click();
  await page.locator('[data-restore-history-action=detail]').click();
  await page.waitForFunction(()=>document.getElementById('restore-history-detail-history-1').textContent.includes('Saved restore log'));
  assert.equal(await page.locator('[data-restore-history-action=delete]').count(),1);
  await capture(`restore-history-${language}-${theme}`);
  await page.locator('#restore-view-wizard-btn').click();
  assert.equal(await page.evaluate(()=>BBUI.restoreState.job),'usb-app');
  for(const width of [390,768,1024]){
   await page.setViewportSize({width,height:1000});
   await page.locator('[data-restore-location=storagebox]').click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow at ${width}`);
   if(width===390)await capture(`restore-mobile-${language}-${theme}`);
  }
 }
 // Exercise the existing explicit start confirmation, actual payload and completion path.
 await page.setViewportSize({width:1600,height:1100});
 await page.evaluate(async()=>{await restoreInit();document.getElementById('restore-archive-sel').value=BBUI.restoreState.archives[0].name;await restoreBrowse('');restoreSetStep(3);});
 await page.locator('input[data-restore-action=select][data-path=folder]').check();await page.locator('#restore-step-next-btn').click();
 await page.locator('#restore-target-path').fill('/mnt/user/restore');await page.locator('#restore-conflict-mode').selectOption('overwrite');await page.locator('#restore-preserve-owner').check();
 await page.locator('#restore-step-next-btn').click();await page.waitForFunction(()=>BBUI.restoreState.precheck?.ok&&!BBUI.restoreState.assistBusy);
 await page.locator('#restore-confirm-check').check();await page.locator('#restore-start-btn').click();
 await page.waitForFunction(()=>!!BBUI.restoreState.confirmResolver);await page.evaluate(()=>closeRestoreConfirmModal(true));
 await page.waitForFunction(()=>BBUI.restoreState.activeRestoreId==='run-1');
 assert.equal(await page.locator('[data-restore-job]').first().isDisabled(),true);
 assert.equal(await page.locator('#restore-step-back-btn').isDisabled(),true);
 assert.deepEqual(await page.evaluate(()=>posts.find(p=>p.url==='/api/restore/start').body),{confirm:true,job_key:'usb-app',archive:'usb-app-2026-10-28',source_path:'folder',source_paths:['folder'],target_dir:'/mnt/user/restore',conflict_mode:'overwrite',preserve_owner:true,dry_run:true});
 await page.evaluate(async()=>{runResult='done';_stopRestorePolling();await _pollRestoreState('run-1');});
 assert.equal(await page.evaluate(()=>BBUI.restoreState.completed),true);
 assert.equal(await page.locator('#restore-step-badge-5 > span').innerText(),'✓');
 await page.locator('#restore-step-back-btn').click();await page.waitForFunction(()=>BBUI.restoreState.step===2&&BBUI.restoreState.archives.length===1);
 assert.equal(await page.locator('#restore-step-back-btn').isDisabled(),true);
 assert.deepEqual(errors,[]);
 console.log('Restore navigation, selection, precheck, start, completion and history passed in DE/EN light/dark and mobile.');
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
