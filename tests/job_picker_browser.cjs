'use strict';
// Shared dialog: many jobs, bounded scrolling, keyboard, persistence and missing storage (#642).
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.BBUI_CHROMIUM?{executablePath:process.env.BBUI_CHROMIUM}:{})});
 try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let html=fs.readFileSync('ui/index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 html=html.replace(/<link[^>]+href="\/([^\"]+)"[^>]*>/g,(_,path)=>path.endsWith('.css')?`<style>${fs.readFileSync(path,'utf8')}</style>`:'');
 await page.route('http://bbui.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.goto('http://bbui.test/');
 const init=async()=>{
  await page.evaluate(dict=>{
   window.BBUI={core:{state:{currentRole:'admin',currentPage:'berichte'}},components:{i18n:{t:key=>key.split('.').reduce((o,k)=>o?.[k],dict)||key}}};
   window.items=Array.from({length:81},(_,i)=>({key:'job-'+i,name:i===0?'Appdata <test>':'Job '+i,archive_prefix:'archive-'+i,location:['local','usb','storagebox'][Math.floor(i/27)]}));
   window.selection='job-27';window.changes=[];
   document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-berichte'));
   document.getElementById('bericht-body').style.display='none';
   document.getElementById('report-selection-title').textContent='Appdata';document.getElementById('report-selection-subtitle').textContent='USB';
  },JSON.parse(fs.readFileSync('ui/i18n/de.json')));
  for(const file of ['utils/dom','utils/format','pages/dashboard','pages/jobs','components/job-picker'])await page.addScriptTag({content:fs.readFileSync(`ui/js/${file}.js`,'utf8')});
  await page.evaluate(()=>{
   const trigger=document.getElementById('report-source-toggle');
   trigger.onclick=()=>BBUI.components.jobPicker.open({jobs:items,selected:selection,icon:()=>'<span class="type-icon">▣</span>',locationLabel:key=>({local:'Lokal',usb:'USB',storagebox:'Storagebox (SSH)'})[key],trigger,onSelect:key=>{selection=key;changes.push(key);BBUI.components.jobPicker.remember('reports',items.find(j=>j.key===key));}});
  });
 };
 await init();
 for(const theme of ['light','dark'])for(const [width,height] of [[1920,1080],[1366,768],[390,844],[320,568],[844,390]]){
  await page.setViewportSize({width,height});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.locator('#report-source-toggle').click();
  assert.equal(await page.locator('[data-picker-job]').count(),27);
  assert.equal(await page.locator('[data-picker-location=usb]').getAttribute('aria-pressed'),'true');
  assert(await page.locator('.job-picker-results').evaluate(el=>el.scrollHeight>el.clientHeight));
  const bounds=await page.locator('#job-picker-dialog').boundingBox();assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=height+1);
  assert(await page.locator('#job-picker-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
  await page.locator('[data-picker-location=local]').click();
  assert.equal(await page.evaluate(()=>selection),'job-27');
  await page.locator('#job-picker-search').fill('<test>');assert.equal(await page.locator('[data-picker-job]').count(),1);
  assert.equal(await page.locator('.job-picker-results test').count(),0);
  await page.locator('#job-picker-search').fill('no match');assert.equal(await page.locator('[data-picker-job]').count(),0);
  await page.locator('[data-picker-location=usb]').click();assert.equal(await page.locator('#job-picker-search').inputValue(),'');
  const last=page.locator('[data-picker-close]').last();await last.focus();await page.keyboard.press('Tab');assert(await page.locator('[data-picker-close]').first().evaluate(el=>el===document.activeElement));
  await page.keyboard.press('Shift+Tab');assert(await last.evaluate(el=>el===document.activeElement));
  if(process.env.BBUI_SCREENSHOT_DIR&&width!==320){fs.mkdirSync(process.env.BBUI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/job-picker-${width}-${height}-${theme}.png`});}
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#job-picker-dialog'));
  assert(await page.locator('#report-source-toggle').evaluate(el=>el===document.activeElement));assert.deepEqual(await page.evaluate(()=>changes),[]);
 }
 await page.locator('#report-source-toggle').click();await page.locator('[data-picker-job=job-28]').click();
 await page.waitForFunction(()=>selection==='job-28');
 assert.equal(await page.evaluate(()=>selection),'job-28');
 await page.reload();await init();assert.equal(await page.evaluate(()=>BBUI.components.jobPicker.recalled('reports')),'job-28');
 assert.equal(await page.evaluate(()=>BBUI.components.jobPicker.recalled('restore')),'');
 await page.evaluate(()=>localStorage.setItem('bbui.jobPicker.reports','not json'));assert.equal(await page.evaluate(()=>BBUI.components.jobPicker.recalled('reports')),'');
 await page.evaluate(()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new Error('Storage blocked');}});BBUI.components.jobPicker.remember('reports',items[0]);});
 assert.equal(await page.evaluate(()=>BBUI.components.jobPicker.recalled('reports')),'');
 // Real empty group renderer: the pane stays below the attached tabs (#643).
 await page.addScriptTag({content:fs.readFileSync('ui/js/pages/job-groups.js','utf8')});
 await page.evaluate(async()=>{window.closeLogPanel=()=>{};BBUI.jobGroups.state.view='groups';BBUI.jobGroups.render();document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-jobs'));document.getElementById('job-groups-pane').classList.remove('hidden');document.querySelector('.jobs-location-layout').classList.add('hidden');document.querySelectorAll('[data-group-view]').forEach(el=>el.classList.toggle('is-active',el.dataset.groupView==='groups'));});
 for(const width of [1503,390]){
  await page.setViewportSize({width,height:900});
  assert(await page.evaluate(()=>document.getElementById('job-groups-pane').getBoundingClientRect().top-document.querySelector('.jobs-view-header').getBoundingClientRect().bottom>=15));
  if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({path:`${process.env.BBUI_SCREENSHOT_DIR}/job-groups-gap-${width}.png`});
 }
 assert.deepEqual(errors,[]);console.log('Job picker passed: 81 jobs, keyboard, DE labels, themes, small windows, persistence, blocked storage and job group spacing.');
 }finally{await browser.close();}
})();
