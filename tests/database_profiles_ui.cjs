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
      let profiles=[], actions=0, action='', deletes=0, lastAction;
      const browserDialogs=[];page.on('dialog',async dialog=>{browserDialogs.push(dialog.message());await dialog.dismiss();});
      const credential=language==='de'?'b'.repeat(32):'database-'+'a'.repeat(60)+'-v001';
      await page.route('http://bbui.test/**', async route => {
        const req=route.request(),url=new URL(req.url());
        let body={};
        if (url.pathname==='/') {await route.fulfill({contentType:'text/html',body:'<main id="page-settings" style="max-width:850px;margin:20px auto"><div class="settings-tab-panel" data-settings-panel="databases"><div id="settings-databases-panel"></div></div><div id="wiz-databases"></div><div id="managed-preview"></div></main>'});return;}
        if (url.pathname==='/api/settings/databases') {
          if (req.method()==='POST') {const {password,...payload}=req.postDataJSON(); const row={...payload,id:'db-aaaaaaaaaaaa',credential_id:credential};profiles=[row];body={profile:row};}
          else if(req.method()==='DELETE'){deletes++;profiles=[];body={deleted:true};}
          else body={profiles};
        } else if(url.pathname.endsWith('/runs')) body={runs:[{profile_id:'db-aaaaaaaaaaaa',profile_name:'MariaDB Apps',started_at:'2026-10-24T09:35:10Z',status:'dump_completed',compression:'gzip',bytes:123456789,uncompressed_bytes:5700000000,directory:'/mnt/cache/db-dumps/bbui-mariadb-apps-2026-10-24_11-35-10+0200-'+'a'.repeat(32)}],errors:[]};
        else if(url.pathname.endsWith('/action')) {actions++;lastAction=req.postDataJSON();action=lastAction.action;body={id:'a'.repeat(32),status:'running'};}
        else if(url.pathname.endsWith('/status')) body={status:'completed',profile_id:'db-aaaaaaaaaaaa',action,results:[],...(action==='discover'?{databases:['app','photos','new_unselected']}:{})};
        else if(url.pathname.endsWith('/runtime-inventory')) body={docker_containers:['mariadb-test','postgres-test']};
        await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
      });
      await page.goto('http://bbui.test/');
      const index=fs.readFileSync('ui/index.html','utf8');
      await page.locator('body').evaluate((body,markup)=>body.insertAdjacentHTML('beforeend',markup),index.slice(index.indexOf('<div id="settings-dialog-modal"'),index.indexOf('<!-- Storage Key Deploy Modal -->')));
      await page.evaluate(lang=>document.documentElement.dataset.theme=lang==='en'?'light':'dark',language);
      for (const file of ['ui/style.css','ui/design-system.css','ui/settings-redesign.css']) await page.addStyleTag({content:fs.readFileSync(file,'utf8')});
      await page.evaluate(labels=>{
        window.BBUI={components:{i18n:{t:(key,params={})=>{
          const s=key.split('.').reduce((a,k)=>a?.[k],labels)||key;
          return s.replace(/\{(\w+)\}/g,(_,k)=>params[k]??'');
        }}}};
        window.escHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
        window.settingsT=(key,params)=>window.BBUI.components.i18n.t('settings.'+key,params);
        window.settingsState={};window._updateUnsavedChangesUi=()=>{};
        window.settingsLocale=()=> 'de-DE';window.settingsFmtBytes=v=>`${v} B`;window.apiErrorMessage=d=>d.code||'error';
        window.wizardState={jobIdRequest:1};window._wizardShowError=()=>{};
      },JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8')));
      const settings=fs.readFileSync('ui/js/pages/settings.js','utf8');
      await page.addScriptTag({content:settings.match(/function settingsCard[\s\S]*?\n}/)[0] + settings.match(/function settingsMenuIcon[\s\S]*?\n}/)[0]});
      await page.addScriptTag({content:settings.match(/function _openSettingsDialog[\s\S]*?\n}/)[0]});
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
      assert.equal(await page.locator('.database-secret-file code').textContent(), 'secrets/'+(language==='de'?'.database-':'')+credential+'.json');
      assert.equal(profiles[0].databases.length,2);assert.equal(profiles[0].retention,'keep');
      assert.equal(await page.locator('#settings-databases-panel img').count(),0);
      await page.locator('[data-db-action=dump]').click();
      await page.waitForFunction(()=>document.getElementById('db-result').textContent.includes('Borg')===false && document.getElementById('db-cancel').disabled);
      assert.equal(actions,2);
      assert.ok((await page.locator('#db-runs').textContent()).includes('MariaDB Apps'));
      assert.ok((await page.locator('#db-runs').textContent()).includes('5700000000'));
      assert.equal(await page.locator('#db-runs time').getAttribute('datetime'),'2026-10-24T09:35:10Z');
      await page.locator('[data-cleanup]').click();
      assert.equal(await page.locator('#settings-dialog-modal').isVisible(),true);
      assert.equal(actions,2);
      assert.ok((await page.locator('#settings-dialog-description').textContent()).includes(language==='de'?'Borg-Archive bleiben unverändert':'Borg archives remain unchanged'));
      assert.ok((await page.locator('#settings-dialog-description').textContent()).includes('/mnt/cache/db-dumps/'));
      assert.ok((await page.locator('#settings-dialog-confirm-btn').getAttribute('class')).includes('btn-danger'));
      if(process.env.BBUI_SCREENSHOT_DIR)await page.locator('#settings-dialog-modal .modal').screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/cleanup-${language}.png`});
      await page.locator('#settings-dialog-cancel-btn').click();
      assert.equal(actions,2);
      await page.locator('[data-cleanup]').click();
      await page.locator('#settings-dialog-confirm-btn').click();
      await page.waitForFunction(()=>document.getElementById('db-cancel').disabled);
      assert.equal(actions,3);
      assert.equal(lastAction.action,'cleanup');assert.equal(lastAction.profile_id,'db-aaaaaaaaaaaa');
      assert.ok(lastAction.directory.startsWith('/mnt/cache/db-dumps/bbui-mariadb-apps-'));
      await page.locator('#db-name').fill('unsaved');
      await page.locator('[data-db-action=dump]').click();assert.equal(actions,3);
      await page.evaluate(()=>wizardLoadDatabases(1));
      await page.evaluate(()=>wizardApplyDatabases(['db-aaaaaaaaaaaa','db-bbbbbbbbbbbb']));
      assert.equal(await page.locator('#wiz-databases input:checked').count(),2);
      assert.equal(await page.locator('#wiz-databases img').count(),0);
      if (process.env.BBUI_SCREENSHOT_DIR) await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/databases-${language}.png`,fullPage:true});
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
      await page.locator('#db-select').selectOption('');
      assert.equal(await page.locator('#settings-dialog-modal').isVisible(),true);
      await page.locator('#settings-dialog-cancel-btn').click();
      assert.equal(await page.locator('#db-select').inputValue(),'db-aaaaaaaaaaaa');
      assert.equal(await page.locator('#db-name').inputValue(),'unsaved');
      await page.locator('#db-select').selectOption('');
      await page.locator('#settings-dialog-confirm-btn').click();
      await page.waitForFunction(()=>document.getElementById('db-select').value==='');
      assert.equal(await page.locator('#db-name').inputValue(),'');
      await page.locator('#db-select').selectOption('db-aaaaaaaaaaaa');
      await page.locator('#db-delete').click();
      assert.equal(await page.locator('#settings-dialog-description img').count(),0);
      assert.ok((await page.locator('#settings-dialog-description').textContent()).includes('<img'));
      await page.locator('#settings-dialog-close-btn').click();assert.equal(deletes,0);
      await page.locator('#db-delete').click();
      await page.locator('#settings-dialog-confirm-btn').click();
      await page.waitForFunction(()=>document.querySelectorAll('#db-select option').length===1);
      assert.equal(deletes,1);
      for (const engine of ['mysql','mongodb','redis','sqlite']) {
        await page.locator('#db-engine').selectOption(engine);
        assert.equal(await page.locator('#db-globals-label').isVisible(),false);
        assert.equal(await page.locator('#db-sqlite-field').isVisible(),engine==='sqlite');
        assert.ok((await page.locator('#db-engine-scope').textContent()).length>30);
        if (engine==='sqlite') {
          assert.equal(await page.locator('#db-password').isVisible(),false);
          assert.equal(await page.locator('#db-sqlite_path').getAttribute('required'),'');
          assert.equal(await page.locator('#db-databases input[value=database]:checked').count(),1);
        }
        if (engine==='redis') {
          assert.equal(await page.locator('#db-port').inputValue(),'6379');
          assert.equal(await page.locator('#db-databases input[value=all]:checked').count(),1);
          await page.locator('#db-auth-mode').selectOption('none');
          assert.equal(await page.locator('#db-password').isVisible(),false);
        }
      }
      assert.deepEqual(browserDialogs,[]);
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
