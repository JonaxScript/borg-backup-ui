'use strict';
// Real profile GET/POST validation and production feedback helpers (#656).
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BBUI_CHROMIUM?{executablePath:process.env.BBUI_CHROMIUM}:{})});
 try {
  for(const language of ['de','en']) {
   const page=await browser.newPage({viewport:{width:1100,height:950}}), errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   let polls=0, finished=false;
   const started=new Date(Date.now()-35000).toISOString();
   await page.route('http://bbui.test/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:'<main id="page-settings" style="max-width:950px;margin:20px auto"><span id="settings-workspace-save-state"></span><div id="settings-content"><div class="settings-tab-panel" data-settings-panel="databases"><div id="settings-databases-panel"></div></div></div></main>'});return;}
    let body;
    if(url.pathname.endsWith('/runtime-inventory'))body={docker_containers:['mariadb']};
    else if(url.pathname.endsWith('/runs'))body={runs:[],errors:[]};
    else if(url.pathname.endsWith('/action'))body={id:'d'.repeat(32),action:'dump',status:'running',started_at:started};
    else if(url.pathname.endsWith('/status')){polls++;body={id:'d'.repeat(32),action:'dump',status:finished?'completed':'running',started_at:started,progress:{phase:polls===1?'checking':'exporting',database:'digikam',database_index:1,databases_total:1,processed_bytes:polls===1?0:6*1024**3,written_bytes:polls===1?0:1024**3},results:[]};}
    else {const response=await route.fetch({url:process.env.BBUI_PROFILE_API+url.pathname+url.search});await route.fulfill({response});return;}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.goto('http://bbui.test/');
   for(const file of ['ui/style.css','ui/design-system.css','ui/settings-redesign.css'])await page.addStyleTag({content:fs.readFileSync(file,'utf8')});
   await page.evaluate(({labels,language})=>{
    document.documentElement.dataset.theme=language==='de'?'light':'dark';
    window.BBUI={components:{i18n:{t:(key,params={})=>{const s=key.split('.').reduce((a,k)=>a?.[k],labels)||key;return s.replace(/\{(\w+)\}/g,(_,k)=>params[k]??'');}}}};
    window.escHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.locationIcon=()=>'';
   },{language,labels:JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8'))});
   for(const file of ['ui/js/utils/dom.js','ui/js/api/client.js','ui/js/pages/settings.js','ui/js/pages/databases.js'])await page.addScriptTag({content:fs.readFileSync(file,'utf8')});
   await page.evaluate(async()=>{settingsState.activeTab='databases';const data=await databaseRequest('',undefined);await loadDatabaseSettings(data.profiles[0].id);});
   const mount=await page.locator('#db-staging_mount').inputValue();
   const path=mount+'/borg-database-dumps/';
   await page.locator('#db-staging_dir').fill(path);
   await page.locator('.database-footer button[type=submit]').click();
   await page.waitForSelector('#db-save-feedback.success-state');
   assert.equal(await page.locator('#db-staging_dir').inputValue(),path.slice(0,-1));
   assert.equal(await page.locator('#db-save-feedback.page-feedback').count(),0);
   assert.equal(await page.evaluate(()=>settingsState.databaseDirty),false);
   await page.locator('#db-staging_dir').fill('relative/path');
   await page.locator('.database-footer button[type=submit]').click();
   await page.waitForSelector('#db-staging_dir[aria-invalid=true]');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'db-staging_dir');
   assert.equal(await page.locator('.database-field-error').count(),1);
   assert.ok((await page.locator('.database-field-error').textContent()).includes('/mnt/cache/borg-database-dumps'));
   assert.equal(await page.locator('#db-save-feedback.page-feedback').count(),0);
   if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/path-error-${language}.png`,fullPage:true});
   await page.locator('#db-staging_dir').fill(path);
   await page.locator('.database-footer button[type=submit]').click();
   await page.waitForSelector('#db-save-feedback.success-state');
   assert.equal(await page.locator('[aria-invalid=true]').count(),0);
   // Server-side numeric validation opens the collapsed group and focuses the field.
   await page.evaluate(()=>{document.getElementById('database-form').noValidate=true;document.getElementById('db-port').value='70000';});
   await page.locator('.database-footer button[type=submit]').click();
   await page.waitForSelector('#db-port[aria-invalid=true]');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'db-port');
   assert.equal(await page.locator('#db-port').evaluate(el=>el.closest('details').open),true);
   assert.ok((await page.locator('.database-field-error').textContent()).includes('65535'));
   await page.locator('#db-port').fill('3306');
   await page.locator('.database-footer button[type=submit]').click();
   await page.waitForSelector('#db-save-feedback.success-state');
   await page.locator('[data-db-action=dump]').click();
   await page.waitForSelector('#db-progress:not(.hidden)');
   assert.equal(await page.locator('#db-progress progress').getAttribute('value'),null);
   await page.waitForFunction(()=>document.getElementById('db-progress').textContent.includes('6.0 GB'));
   assert.ok((await page.locator('#db-progress').textContent()).includes('digikam (1/1)'));
   assert.ok((await page.locator('#db-progress').textContent()).includes('1.0 GB'));
   assert.equal((await page.locator('#db-progress').textContent()).includes('%'),false);
   if(process.env.BBUI_SCREENSHOT_DIR)await page.locator('#db-progress').screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/live-dump-${language}.png`});
   finished=true;
   await page.waitForSelector('#db-progress', {state:'hidden'});
   assert.ok((await page.locator('#db-result').textContent()).includes(language==='de'?'erstellt':'created'));
   await page.setViewportSize({width:390,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.deepEqual(errors,[]);
   await page.close();
  }
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
