'use strict';
// Exercise actual storage rendering, save handlers and navigation guards (#654).
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BBUI_CHROMIUM?{executablePath:process.env.BBUI_CHROMIUM}:{})});
 try {
  for(const language of ['de','en']) for(const type of ['local','usb','smb','storagebox']) {
   const page=await browser.newPage({viewport:{width:1200,height:1000}});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   let fail=false,refreshFailure=false,delay=0,puts=0;
   let data={local_profiles:[{key:'local1',storage_key:'local1',name:'Local',base_path:'/mnt/cache/backup'}],usb_profiles:[{key:'usb1',name:'USB',mount_path:'/mnt/disks/usb'}],smb_profiles:[{key:'smb1',name:'SMB',server:'nas',share:'backup',username:'backup',password_set:true,mount_path:'/mnt/remotes/backup',vers:'3.0',sec:'ntlmssp'}],storage_profiles:[{key:'ssh1',name:'SSH',host:'nas',user:'backup',port:'22',base_path:'/backup',ssh_key_path:'/root/.ssh/key',target_type:'generic'}]};
   await page.route('http://bbui.test/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname==='/'){await route.fulfill({contentType:'text/html',body:'<main id="page-settings"><button id="settings-save-btn"></button><div id="settings-message" class="hidden"></div><div id="settings-content"></div></main>'});return;}
    if(req.method()==='PUT'){
     puts++;if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
     if(fail){await route.fulfill({status:400,contentType:'application/json',body:'{"code":"fixture_save_failed"}'});return;}
     const body=req.postDataJSON();
     assert.equal(Object.keys(body.profile_updates).length,1);
     for(const [key,rows] of Object.entries(body.profile_updates)) data[(key==='storagebox'?'storage':key)+'_profiles']=rows;
     await route.fulfill({contentType:'application/json',body:'{}'});return;
    }
    if(refreshFailure && url.pathname==='/api/settings/basic'){await route.fulfill({status:500,contentType:'application/json',body:'{}'});return;}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
   });
   await page.goto('http://bbui.test/');
   const html=fs.readFileSync('ui/index.html','utf8');
   await page.locator('body').evaluate((body,markup)=>body.insertAdjacentHTML('beforeend',markup),html.slice(html.indexOf('<div id="settings-dialog-modal"'),html.indexOf('<!-- Storage Key Deploy Modal -->')));
   for(const file of ['ui/style.css','ui/design-system.css','ui/settings-redesign.css'])await page.addStyleTag({content:fs.readFileSync(file,'utf8')});
   await page.evaluate(labels=>{
    window.BBUI={components:{i18n:{t:(key,params={})=>{const value=key.split('.').reduce((a,k)=>a?.[k],labels)||key;return value.replace(/\{(\w+)\}/g,(_,key)=>params[key]??'');}}},core:{updateDataDirWarning:async()=>{},invalidateSetupStatusCache:()=>{}}};
    window.escHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
    window.locationIcon=()=>'';window.apiErrorMessage=data=>data.code;
   },JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8')));
   await page.addScriptTag({content:fs.readFileSync('ui/js/utils/dom.js','utf8')});
   await page.addScriptTag({content:fs.readFileSync('ui/js/pages/settings.js','utf8')});
   await page.evaluate(({type,data})=>{
    refreshSettingsConfigBackups=async()=>{};refreshSelectedSmbProfileMountStatus=async()=>{};
    renderSettings=(data)=>{
     const renders={local:renderSettingsLocalProfiles,usb:renderSettingsUsbProfiles,smb:renderSettingsSmbProfiles,storagebox:renderSettingsStorageProfiles};
     const active=settingsState.activeTab;
     document.getElementById('settings-content').innerHTML='<span id="settings-workspace-save-state"></span><div class="settings-tab-panel" data-settings-panel="'+active+'">'+(renders[active]?renders[active](data[(active==='storagebox'?'storage':active)+'_profiles']):'General settings')+'</div>';
     if(renders[active])syncSettingsProfileManager(active);
     _updateUnsavedChangesUi();
    };
    refreshSettings=async()=>{settingsState.data=await fetch('/api/settings/basic').then(r=>r.json());settingsState.dirty=false;renderSettings(settingsState.data);};
    settingsState.activeTab=type;settingsState.data=data;renderSettings(data);
   },{type,data});
   const prefix=type==='storagebox'?'storage':type;
   const name=page.locator(`[data-${prefix}-profile-name]`);
   assert.equal(await name.isDisabled(),true);
   assert.equal(await page.evaluate(()=>canLeaveSettingsPage()),true);
   await page.locator('[data-profile-edit]').click();
   const original=await name.inputValue();
   await name.fill('Edited');assert.equal(await page.evaluate(()=>settingsState.dirty),true);
   await name.fill(original);assert.equal(await page.evaluate(()=>settingsState.dirty),false);
   await name.fill('Saved '+type);
   await page.evaluate(type=>activateSettingsTab(type),type);
   assert.equal(await name.inputValue(),'Saved '+type);
   fail=true;
   await page.locator('[data-profile-save]').click();
   await page.waitForSelector(`#settings-profile-${type}-feedback.error-state`);
   assert.equal(await page.evaluate(()=>settingsState.dirty),true);
   assert.equal(await name.inputValue(),'Saved '+type);
   // Leaving an unsaved storage profile cannot leak its dirty flag into another area.
   await page.evaluate(()=>{void activateSettingsTab('general');});
   assert.equal(await page.locator('#settings-dialog-modal').isVisible(),true);
   await page.locator('#settings-dialog-cancel-btn').click();
   assert.equal(await page.evaluate(()=>settingsState.activeTab),type);
   fail=false;delay=150;
   await page.locator('[data-profile-save]').click();
   assert.equal(await name.isDisabled(),true);
   assert.equal(await page.evaluate(()=>canLeaveSettingsPage()),false);
   await page.waitForSelector(`#settings-profile-${type}-feedback.success-state`);
   assert.equal(await name.inputValue(),'Saved '+type);
   assert.equal(await page.evaluate(()=>settingsState.dirty),false);
   assert.equal(await page.locator('#settings-workspace-save-state').textContent(),JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`,'utf8')).settings.menu.saved);
   assert.equal(await page.evaluate(()=>canLeaveSettingsPage()),true);
   assert.equal(puts,2);
   assert.equal(await page.locator(`#settings-profile-${type}-feedback.page-feedback`).count(),0);
   if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/profile-${type}-${language}.png`,fullPage:true});
   await page.setViewportSize({width:390,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   refreshFailure=true;delay=0;
   await page.locator('[data-profile-edit]').click();
   await name.fill('Saved without refresh');
   await page.locator('[data-profile-save]').click();
   await page.waitForSelector(`#settings-profile-${type}-feedback.warning-state`);
   assert.equal(await page.evaluate(()=>settingsState.dirty),false);
   assert.equal(await page.evaluate(()=>canLeaveSettingsPage()),true);
   refreshFailure=false;
   await page.locator('[data-profile-edit]').click();
   assert.equal(await page.locator('[data-profile-save]').isEnabled(),true);
   await name.fill('Discard this');
   await page.evaluate(()=>{void activateSettingsTab('general');});
   await page.locator('#settings-dialog-confirm-btn').click();
   await page.waitForFunction(()=>settingsState.activeTab==='general');
   assert.equal(await page.evaluate(()=>settingsState.dirty),false);
   assert.equal(data[(type==='storagebox'?'storage':type)+'_profiles'][0].name,'Saved without refresh');
   assert.deepEqual(errors,[]);
   await page.close();
  }
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
