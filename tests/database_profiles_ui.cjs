'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.BBUI_CHROMIUM ? {executablePath:process.env.BBUI_CHROMIUM} : {})});
  try {
    for (const language of ['de','en']) {
      const page = await browser.newPage({viewport:{width:1200,height:1000}});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      let profiles=[], actions=0, action='';
      await page.route('http://bbui.test/**', async route => {
        const req=route.request(),url=new URL(req.url());
        let body={};
        if (url.pathname==='/') {await route.fulfill({contentType:'text/html',body:'<main id="page-settings" style="max-width:850px;margin:20px auto"><div class="settings-tab-panel" data-settings-panel="databases"><div id="settings-databases-panel"></div></div><div id="wiz-databases"></div><div id="managed-preview"></div></main>'});return;}
        if (url.pathname==='/api/settings/databases') {
          if (req.method()==='POST') {const {password,...payload}=req.postDataJSON(); const row={...payload,id:'db-aaaaaaaaaaaa',credential_id:'b'.repeat(32)};profiles=[row];body={profile:row};}
          else body={profiles};
        } else if(url.pathname.endsWith('/runs')) body={runs:[],errors:[]};
        else if(url.pathname.endsWith('/action')) {actions++;action=req.postDataJSON().action;body={id:'a'.repeat(32),status:'running'};}
        else if(url.pathname.endsWith('/status')) body={status:'completed',profile_id:'db-aaaaaaaaaaaa',action,results:[],...(action==='discover'?{databases:['app','photos','new_unselected']}:{})};
        else if(url.pathname.endsWith('/runtime-inventory')) body={docker_containers:['mariadb-test','postgres-test']};
        await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      });
      await page.goto('http://bbui.test/');
      await page.evaluate(lang=>document.documentElement.dataset.theme=lang==='en'?'light':'dark',language);
      for (const file of ['ui/style.css','ui/design-system.css','ui/settings-redesign.css']) await page.addStyleTag({content:fs.readFileSync(file,'utf8')});
      await page.evaluate(labels=>{
        window.BBUI={components:{i18n:{t:(key,params={})=>{
          const s=key.split('.').reduce((a,k)=>a?.[k],labels)||key;
          return s.replace(/\{(\w+)\}/g,(_,k)=>params[k]??'');
        }}}};
        window.escHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
        window.settingsState={};window._updateUnsavedChangesUi=()=>{};
        window.settingsFmtBytes=v=>`${v} B`;window.apiErrorMessage=d=>d.code||'error';
        window.wizardState={jobIdRequest:1};window._wizardShowError=()=>{};
      },JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8')));
      const settings=fs.readFileSync('ui/js/pages/settings.js','utf8');
      await page.addScriptTag({content:settings.match(/function settingsCard[\s\S]*?\n}/)[0] + settings.match(/function settingsMenuIcon[\s\S]*?\n}/)[0]});
      await page.addScriptTag({content:fs.readFileSync('ui/js/pages/databases.js','utf8')});
      await page.evaluate(()=>loadDatabaseSettings());
      assert.equal(await page.locator('#db-container').evaluate(el=>el.tagName), 'SELECT');
      assert.equal(await page.locator('#db-container option').count(), 3);
      assert.equal(await page.locator('#settings-databases-panel').textContent().then(text=>text.includes(language==='de'?'Mitgelieferte Skripte':'Bundled scripts')), false);
      await page.locator('#db-name').fill('<img src=x onerror=alert(1)>');
      await page.locator('#db-container').selectOption('mariadb-test');
      await page.locator('#db-password').fill('fixture-secret');
      await page.locator('#db-staging_mount').fill('/mnt/cache');
      await page.locator('#db-staging_dir').fill('/mnt/cache/db-dumps');
      await page.locator('[data-db-discover]').click();
      await page.waitForSelector('#db-databases input[value=app]');
      assert.equal(await page.locator('#db-databases input:checked').count(),0);
      assert.equal(await page.locator('#db-password').inputValue(),'');
      assert.equal(JSON.stringify(profiles).includes('fixture-secret'),false);
      await page.locator('#db-databases input[value=app]').check();
      await page.locator('#db-databases input[value=photos]').check();
      await page.locator('.database-footer button[type=submit]').click();
      await page.waitForFunction(()=>document.getElementById('db-select').value==='db-aaaaaaaaaaaa' && !settingsState.databaseDirty);
      assert.equal(profiles[0].databases.length,2);assert.equal(profiles[0].retention,'keep');
      assert.equal(await page.locator('#settings-databases-panel img').count(),0);
      await page.locator('[data-db-action=dump]').click();
      await page.waitForFunction(()=>document.getElementById('db-result').textContent.includes('Borg')===false && document.getElementById('db-cancel').disabled);
      assert.equal(actions,2);
      await page.locator('#db-name').fill('unsaved');
      await page.locator('[data-db-action=dump]').click();assert.equal(actions,2);
      await page.evaluate(()=>wizardLoadDatabases(1));
      await page.evaluate(()=>wizardApplyDatabases(['db-aaaaaaaaaaaa','db-bbbbbbbbbbbb']));
      assert.equal(await page.locator('#wiz-databases input:checked').count(),2);
      assert.equal(await page.locator('#wiz-databases img').count(),0);
      if (process.env.BBUI_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/databases-${language}.png`,fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
