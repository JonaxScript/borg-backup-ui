'use strict';
// Real wizard markup: large source selections must stay readable and retain their payload (#591).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.BBUI_CHROMIUM ? {executablePath:process.env.BBUI_CHROMIUM} : {})});
  try { for (const language of ['de','en']) {
    const page = await browser.newPage({viewport:{width:1040,height:720}});
    const errors=[]; page.on('pageerror', error=>errors.push(error.message));
    await page.setContent(fs.readFileSync('ui/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
    for (const path of ['ui/style.css','ui/design-system.css','ui/settings-redesign.css']) await page.addStyleTag({content:fs.readFileSync(path,'utf8')});
    await page.evaluate(({labels,language})=>{
      document.documentElement.dataset.theme=language==='de'?'light':'dark';
      const t=(key,params={})=>String(key.split('.').reduce((value,part)=>value?.[part],labels)||key).replace(/\{(\w+)\}/g,(_,key)=>params[key]??'');
      window.BBUI={components:{i18n:{t}}};
      window.escHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
      document.querySelectorAll('[data-i18n]').forEach(node=>node.textContent=t(node.dataset.i18n));
      document.querySelectorAll('.modal-backdrop').forEach(node=>node.classList.add('hidden'));
      document.getElementById('wizard-modal').classList.remove('hidden');
      document.querySelectorAll('.wizard-step-body').forEach(node=>node.classList.toggle('hidden',node.id!=='wizard-step-2'));
    },{labels:JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8')),language});
    for (const path of ['ui/js/pages/wizard.js','ui/js/pages/databases.js']) await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
    await page.evaluate(()=>{
      // Runtime-risk integration is unrelated to the source-list layout.
      wizardUpdateRuntimeRiskWarnings=()=>{};
      wizardState.sourcePaths=Array.from({length:45},(_,i)=>`/mnt/user/long-share-name-${i}/documents/archive/with-a-long-directory-name`);
      wizardState.databaseProfiles=Array.from({length:35},(_,i)=>({id:`db-${i}`,name:`Database profile ${i}`,engine:'mariadb',enabled:true,databases:['nextcloud','paperless','another_long_database_name']}));
      wizardRenderSourcePaths(); wizardApplyDatabases(['db-0','db-34','missing-id']);
      // Bind the same handlers used by app-bindings.js.
      const tabs=document.getElementById('wiz-source-tabs');tabs.addEventListener('click',wizardSourceTabEvent);tabs.addEventListener('keydown',wizardSourceTabEvent);
      document.getElementById('wiz-databases').addEventListener('change',wizardUpdateDatabaseCount);
      document.getElementById('wiz-source-path-list').addEventListener('click',wizardSourcePathsClick);
    });
    assert.equal(await page.locator('#wiz-source-folder-count').textContent(),'45');
    assert.equal(await page.locator('#wiz-source-database-count').textContent(),'3');
    const list=page.locator('#wiz-source-path-list');
    assert.ok(await list.evaluate(node=>node.scrollHeight>node.clientHeight && node.clientHeight<=260));
    const footerBefore=await page.locator('#wizard-modal .modal-footer').boundingBox();
    assert.ok(footerBefore.y+footerBefore.height<=720);
    await page.locator('[data-source-tab=databases]').click();
    assert.equal(await list.isVisible(),false);
    assert.ok(await page.locator('#wiz-databases').evaluate(node=>node.scrollHeight>node.clientHeight && node.clientHeight<=260));
    await page.locator('#wiz-databases input[value="db-1"]').check();
    assert.equal(await page.locator('#wiz-source-database-count').textContent(),'4');
    assert.equal(await page.locator('#wiz-databases input[value="missing-id"]').isChecked(),true);
    if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/wizard-databases-${language}.png`});
    await page.locator('[data-source-tab=databases]').focus();await page.keyboard.press('ArrowLeft');
    assert.equal(await list.isVisible(),true);
    assert.equal(await page.locator('#wiz-databases input:checked').count(),4);
    await page.locator('[data-wiz-src-del="44"]').click();
    assert.equal(await page.locator('#wiz-source-folder-count').textContent(),'44');
    assert.equal((await page.locator('#wiz-source-paths').inputValue()).split('\n').length,44);
    assert.equal(await page.evaluate(()=>wizardState.sourcePaths.length),44);
    if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/wizard-folders-${language}.png`});
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('[data-source-tab=databases]').click();
    const footer=await page.locator('#wizard-modal .modal-footer').boundingBox();assert.ok(footer.y+footer.height<=844);
    if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/wizard-sources-${language}-mobile.png`});
    assert.deepEqual(errors,[]);await page.close();
  }} finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
