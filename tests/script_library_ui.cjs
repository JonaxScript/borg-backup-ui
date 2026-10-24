'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BBUI_CHROMIUM?{executablePath:process.env.BBUI_CHROMIUM}:{})});
 try {for(const language of ['de','en']) {
  const page=await browser.newPage({viewport:{width:1400,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const sources=[
   {id:'managed:db',kind:'managed',group:'helpers',name:'database-dump-mariadb.sh',path:'runtime/scripts/database-dump-mariadb.sh',language:'bash',content:fs.readFileSync('runtime/scripts/database-dump-mariadb.sh','utf8')},
   {id:'managed:postgresql',kind:'managed',name:'database-dump-postgresql.sh',path:'runtime/scripts/database-dump-postgresql.sh',language:'bash',content:fs.readFileSync('runtime/scripts/database-dump-postgresql.sh','utf8')},
   {id:'template:source',kind:'template',group:'practical',name:'pre-check-source.sh',path:'practical/pre-check-source.sh',language:'bash',timeout_seconds:30,content:fs.readFileSync('docs/examples/job-hooks/practical/pre-check-source.sh','utf8')},
   {id:'managed:xss',kind:'managed',name:'<img onerror=alert(1)>',path:'malicious.sh',language:'bash',content:'# <img src=x onerror=alert(1)>\nprint("<script>alert(1)</script>")'},
  ];
  sources.push({id:'managed:sqlite',kind:'managed',name:'database-dump-sqlite.py',path:'runtime/scripts/database-dump-sqlite.py',language:'python',content:fs.readFileSync('runtime/scripts/database-dump-sqlite.py','utf8')});
  let saved=[],writes=0, holdPostgres=false, releaseSource, sourceBlocked;
  await page.route('http://bbui.test/**',async route=>{
   const request=route.request(),url=new URL(request.url());let body={};
   if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:'<main id="page-settings" style="max-width:1200px;margin:24px auto"><div class="settings-tab-panel" id="settings-scripts-panel"></div></main>'});return;}
   if(url.pathname.endsWith('/catalog'))body={entries:sources.map(({content,...row})=>row)};
   else if(url.pathname.endsWith('/source')) {
    if(holdPostgres && url.searchParams.get('id')==='managed:postgresql') {sourceBlocked(); await new Promise(resolve=>{releaseSource=resolve;});}
    body={script:sources.find(row=>row.id===url.searchParams.get('id'))};
   }
   else if(url.pathname==='/api/settings/scripts'){
    if(request.method()==='POST'){writes++;const script={...request.postDataJSON(),id:'script-own'};saved=[script];body={script};}
    else body={scripts:saved};
   }
   await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('http://bbui.test/');
  await page.evaluate(lang=>document.documentElement.dataset.theme=lang==='de'?'dark':'light',language);
  for(const file of ['ui/style.css','ui/design-system.css','ui/settings-redesign.css'])await page.addStyleTag({content:fs.readFileSync(file,'utf8')});
  await page.evaluate(labels=>{
   window.BBUI={components:{i18n:{t:(key,params={})=>(key.split('.').reduce((a,k)=>a?.[k],labels)||key).replace(/\{(\w+)\}/g,(_,k)=>params[k]??'')}}};
   window.settingsT=(key,params={})=>BBUI.components.i18n.t('settings.'+key,params);
   window.escHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
   window.settingsState={activeTab:'scripts',jobScripts:[]};window._updateUnsavedChangesUi=()=>{};
   window.apiErrorMessage=data=>data.code||'error';window.historyLocationLabel=value=>value;
   window._openSettingsDialog=async()=>window.approveDiscard!==false;
   window.showMsg=(id,kind,text)=>{const node=document.getElementById(id);node.textContent=text;node.classList.remove('hidden');};
  },JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8')));
  for(const file of ['ui/vendor/prism/prism-core.min.js','ui/vendor/prism/prism-bash.min.js','ui/vendor/prism/prism-python.min.js','ui/js/components/bash-editor.js','ui/js/pages/script-library.js'])await page.addScriptTag({content:fs.readFileSync(file,'utf8')});
  const settings=fs.readFileSync('ui/js/pages/settings.js','utf8');
  for(const name of ['settingsCard','settingsMenuIcon','loadSettingsScripts','renderSettingsScriptEditor','settingsScriptValues','uniqueSettingsScriptName','persistSettingsScript']){
   const expression=new RegExp('(?:async )?function '+name+'[\\s\\S]*?\\n}');
   await page.addScriptTag({content:settings.match(expression)[0]});
  }
  await page.evaluate(()=>loadSettingsScripts());
  const ownSurface=await page.locator('#settings-own-scripts .settings-section').first().evaluate(node=>getComputedStyle(node).backgroundColor);
  await page.locator('#settings-script-name').fill('Unsaved');
  await page.locator('[data-script-kind=managed]').click();
  assert.equal(await page.locator('.script-library-selection .settings-section').evaluate(node=>getComputedStyle(node).backgroundColor),ownSurface);
  await page.locator('#script-library-select').selectOption('managed:db');
  await page.locator('[data-script-detail=code]').click();
  await page.waitForSelector('.script-source-code .token.comment');
  assert.equal(await page.locator('pre code').textContent(),sources[0].content);
  assert.equal(await page.locator('#script-library-source textarea, #script-template-use').count(),0);
  assert.equal(writes,0);
  await page.locator('#script-library-select').selectOption('managed:postgresql');
  await page.waitForFunction(()=>document.querySelector('pre code')?.textContent.includes('pg_dump'));
  assert.ok(await page.locator('pre .token.keyword').count()>0);
  await page.locator('#script-library-select').selectOption('managed:sqlite');
  await page.waitForFunction(()=>document.querySelector('pre code')?.textContent.includes('sqlite3.connect'));
  assert.ok(await page.locator('pre .token.keyword').count()>0);
  assert.ok((await page.locator('.script-library-source-meta').textContent()).includes('Python / SQLite'));
  assert.equal(await page.locator('pre code').textContent(),sources.at(-1).content);
  await page.locator('#script-library-select').selectOption('managed:xss');
  await page.waitForFunction(()=>document.querySelector('pre code')?.textContent.includes('alert(1)'));
  assert.equal(await page.locator('#script-library-browser img, #script-library-browser script').count(),0);
  await page.locator('[data-script-kind=own]').click();
  assert.equal(await page.locator('#settings-script-name').inputValue(),'Unsaved');
  await page.locator('[data-script-kind=template]').click();
  await page.locator('#script-library-select').selectOption('template:source');
  await page.locator('[data-script-detail=description]').click();
  await page.waitForSelector('#script-template-use');
  assert.equal(await page.locator('.script-library-source .settings-section').count(),1);
  assert.equal(await page.locator('.script-library-selection .settings-section').evaluate(node=>getComputedStyle(node).backgroundColor),ownSurface);
  assert.equal(await page.locator('.script-library-detail-tabs').evaluate(node=>getComputedStyle(node).backgroundColor),ownSurface);
  assert.ok((await page.locator('.script-library-details').textContent()).includes('MOUNT_PATH'));
  assert.equal(await page.locator('.script-library-details dt').count(),3);
  assert.notEqual(await page.locator('.script-library-source .settings-section-header').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('#script-library-panel-code').isVisible(),false);
  await page.locator('[data-script-detail=description]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-script-detail=code]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#script-library-panel-description').isVisible(),false);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#script-library-panel-description').isVisible(),true);
  assert.equal(await page.locator('#script-library-select option').count(),1);
  if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/script-templates-${language}.png`,fullPage:true});
  await page.evaluate(()=>window.approveDiscard=false);
  await page.locator('#script-template-use').click();assert.equal(writes,0);
  assert.equal(await page.locator('#settings-script-name').inputValue(),'Unsaved');
  await page.evaluate(()=>window.approveDiscard=true);
  await page.locator('#script-template-use').click();
  assert.equal(await page.locator('#settings-script-content').inputValue(),sources[2].content);
  assert.equal(await page.evaluate(()=>settingsState.scriptDirty),true);assert.equal(writes,0);
  await page.locator('#settings-script-content').fill('#!/bin/bash\n# My own copy\nexit 0\n');
  await page.locator('#settings-script-form button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('settings-script-select').value==='script-own');
  assert.equal(writes,1);assert.equal(saved[0].content.includes('My own copy'),true);assert.equal(sources[2].content.includes('My own copy'),false);
  await page.locator('[data-script-kind=managed]').click();
  await page.locator('#script-library-select').selectOption('managed:db');
  await page.locator('[data-script-detail=code]').click();await page.waitForSelector('pre .token');
  await page.locator('.script-source-code pre').evaluate(node=>node.scrollTop=680);
  if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/script-library-${language}.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/script-library-${language}-mobile.png`,fullPage:true});
  // A slow response must not replace the newer dropdown choice.
  holdPostgres=true;
  const blocked=new Promise(resolve=>{sourceBlocked=resolve;});
  await page.locator('#script-library-select').selectOption('managed:postgresql');await blocked;
  await page.locator('#script-library-select').selectOption('managed:db');
  await page.waitForFunction(()=>document.querySelector('pre code')?.textContent.includes('mariadb-dump'));
  const returned=page.waitForResponse(response=>response.url().includes(encodeURIComponent('managed:postgresql')));
  releaseSource();await returned;
  await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#script-library-select').inputValue(),'managed:db');
  assert.equal(await page.locator('pre code').textContent(),sources[0].content);
  await page.evaluate(()=>{settingsState.scriptCatalog=[];return showScriptLibrary('template');});
  assert.equal(await page.locator('#script-library-select').isDisabled(),true);
  assert.equal(await page.locator('[data-script-detail]').count(),0);
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
