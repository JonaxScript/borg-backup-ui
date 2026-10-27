// Browser regression for compact summaries, inline disclosures and responsive telemetry (#607).
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.BBUI_CHROMIUM ? {executablePath:process.env.BBUI_CHROMIUM} : {})});
  try {
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}});
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let html = fs.readFileSync('ui/index.html', 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<link[^>]+href="\/([^\"]+)"[^>]*>/g, (all, path) => path.endsWith('.css') ? `<style>${fs.readFileSync(path, 'utf8')}</style>` : '');
  html = html.replace('src="/ui/assets/app-icon.png"', `src="data:image/png;base64,${fs.readFileSync('ui/assets/app-icon.png').toString('base64')}"`);
  await page.setContent(html);
  const dictionaries = Object.fromEntries(['de','en'].map(l => [l, JSON.parse(fs.readFileSync(`ui/i18n/${l}.json`))]));
  await page.evaluate(dicts => {
    window.lang = 'de'; window.dicts = dicts;
    const backups = ['All-VMs', 'Appdata', 'Flash', 'Photos', 'Portableapps-Dockcase', 'Test-PR-595'].map((name, i) => ({
      key: String(i), name, display_name: name, location: 'local', status: 'success', duration: '14 Min. 17 Sek.',
      restore_verification_status: 'verified', total_size: '162.3 GB', last_backup: '2026-10-26T09:00:00Z',
      archive_name: `${name.toLowerCase()}-backup-2026-10-26_09-00-37`}));
    backups[4].status='error'; backups[4].error_message='Required source is missing <script>not executable</script>';
    for(let i=6;i<14;i++) backups.push({key:String(i),name:`Demo ${i}`,location:i<10?'usb':'storagebox',status:'success',restore_verification_status:'not_required'});
    window.BBUI = {components: {i18n: {getLanguage: () => lang, t: (key, params = {}) => {
      const text = key.split('.').reduce((v,k) => v?.[k], dicts[lang]);
      return typeof text === 'string' ? text.replace(/\{(\w+)\}/g, (_,k) => params[k] ?? '') : key;
    }}}, core: {state: {currentPage: 'dashboard', data: {backups}}, getSchedulesData: () => ({})}};
    window.resolveJobIcon = () => 'archive'; window.resolveJobIconColor = () => '';
    window.isStaleDate = () => false; window.calcNextRun = () => new Date();
    window.demoIdle = true;
    const group = {id:'demo', job_key:'1', cpu_percent:12, memory_bytes:1.3*1024**3, memory_limit_bytes:2*1024**3};
    window.fetch = async () => ({ok:true, json:async () => ({available:true, stale:false,
      host:{cpu_percent:1.3, memory_available_bytes:36.5*1024**3, memory_total_bytes:62.7*1024**3},
      runs_available:true, runs:demoIdle ? [] : [{job_key:'1', operation:'restore_test'}],
      protected_tests:demoIdle ? [] : [group], configured_reserve_bytes:1024**3,
      history:Array.from({length:121}, (_,i) => ({timestamp:Date.now()/1000-600+i*5,
        host:{cpu_percent:1.3+.4*Math.sin(i*.5), memory_available_bytes:(36.5+Math.sin(i*.2)*.2)*1024**3},
        protected_tests:[{...group,cpu_percent:12+3*Math.sin(i*.3),memory_bytes:(1.1+i/600)*1024**3}]}))})});
    document.documentElement.dataset.theme = 'light';
    window.translate = () => document.querySelectorAll('[data-i18n]').forEach(el => {el.textContent=BBUI.components.i18n.t(el.dataset.i18n);});
    translate();
  }, dictionaries);
  for (const path of ['ui/js/utils/format.js','ui/js/pages/dashboard.js','ui/js/components/resource-monitor.js']) await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
  await page.evaluate(() => {renderDashboard(BBUI.core.state.data, null); BBUI.resourceMonitor.start();});
  await page.waitForFunction(() => document.getElementById('resource-active').textContent.includes('0'));
  const capture=async name=>{if(process.env.BBUI_SCREENSHOT_DIR)await page.screenshot({animations:'disabled',path:`${process.env.BBUI_SCREENSHOT_DIR}/${name}.png`});};
  assert.equal(await page.locator('.dashboard-coverage-track .success').count(),6);
  assert.equal(await page.locator('.dashboard-coverage-track .neutral').count(),8);
  assert.notEqual(await page.locator('.dashboard-summary-ring').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
  const cards=await page.locator('.dashboard-summary-pair > section').evaluateAll(nodes=>nodes.map(n=>({top:n.getBoundingClientRect().top,height:n.getBoundingClientRect().height})));
  assert.equal(cards.length,3);assert(cards.every(c=>c.top===cards[0].top));assert(cards.every(c=>c.height<205));
  assert(await page.locator('#resource-history').isHidden());
  assert.equal(await page.locator('.dashboard-attention-disclosure').getAttribute('open'),null);
  await capture('dashboard-closed-de');
  const oldGridTop=await page.locator('.dashboard-location-layout').evaluate(el=>el.getBoundingClientRect().top);
  await page.locator('#dashboard-attention-toggle').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(()=>dashboardAttentionExpanded);
  assert(await page.locator('#dashboard-attention ul').isVisible());
  assert.equal(await page.locator('#dashboard-attention script').count(),0);
  assert.match(await page.locator('#dashboard-attention ul').innerText(),/<script>not executable<\/script>/);
  assert(await page.locator('.dashboard-location-layout').evaluate(el=>el.getBoundingClientRect().top)>oldGridTop);
  await page.evaluate(()=>renderDashboard(BBUI.core.state.data,null));
  assert(await page.locator('#dashboard-attention ul').isVisible());
  assert.equal(await page.evaluate(()=>document.activeElement.id),'dashboard-attention-toggle');
  await capture('dashboard-inline-error-de');
  await page.evaluate(()=>{BBUI.core.state.data.backups[0].backup_overdue=true;renderDashboard(BBUI.core.state.data,null);});
  await page.locator('#dashboard-overdue-toggle').click();await page.waitForFunction(()=>dashboardOverdueExpanded);
  await page.evaluate(()=>renderDashboard(BBUI.core.state.data,null));
  assert(await page.locator('.dashboard-summary-overdue ul').isVisible());
  await page.locator('#dashboard-overdue-toggle').click();
  await page.locator('[data-dashboard-location="usb"]').click();
  assert.equal(await page.locator('.dashboard-summary-ring strong').innerText(),'4');
  assert.equal(await page.locator('.dashboard-summary-ring small').innerText(),'/4');
  assert.match(await page.locator('.dashboard-summary-context').innerText(),/USB/);
  assert.equal(await page.locator('#dashboard-overdue-toggle').count(),0);
  await page.evaluate(()=>renderDashboard(BBUI.core.state.data,null));
  assert.equal(await page.locator('.dashboard-summary-ring small').innerText(),'/4');
  assert.equal(await page.locator('.dashboard-coverage-track span').count(),14);
  await page.locator('[data-dashboard-location="all"]').click();
  assert.equal(await page.locator('.dashboard-summary-ring small').innerText(),'/14');
  const collapsedHeights=await page.locator('.dashboard-summary-pair > section').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
  await page.locator('#resource-history-toggle').click();assert(await page.locator('#resource-history').isVisible());
  const relation=await page.evaluate(()=>({history:document.querySelector('#resource-history').getBoundingClientRect().top,values:document.querySelector('#resource-values').getBoundingClientRect().bottom,position:getComputedStyle(document.querySelector('#resource-history')).position}));
  assert(relation.history>=relation.values);assert.equal(relation.position,'static');
  const expandedCards=await page.locator('.dashboard-summary-pair > section').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
  assert(expandedCards.every((height,i)=>height===collapsedHeights[i]),'History must not stretch summary cards');
  await page.locator('.resource-plot-canvas').first().focus();await page.keyboard.press('ArrowLeft');
  assert(await page.locator('.resource-crosshair').first().isVisible());
  await capture('dashboard-inline-history-de');
  for(const language of ['de','en'])for(const theme of ['light','dark'])for(const width of [1920,1280,1024,768,390]){
    await page.setViewportSize({width,height:1080});
    await page.evaluate(({language,theme})=>{lang=language;translate();document.documentElement.dataset.theme=theme;renderDashboard(BBUI.core.state.data,null);window.dispatchEvent(new Event('bbui:language-changed'));},{language,theme});
    const overflows=await page.locator('.dashboard-summary-pair, .dashboard-summary-pair > section, #resource-history, .resource-plot, #dashboard-attention').evaluateAll(nodes=>nodes.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.id||el.className));
    assert.deepEqual(overflows,[],`${language}/${theme}/${width}`);
    const history=await page.locator('#resource-history').boundingBox();
    const overview=await page.locator('.dashboard-summary-pair').boundingBox();
    assert.equal(history.x,overview.x);assert.equal(history.width,overview.width);
    const plots=await page.locator('.resource-plot-canvas').evaluateAll(nodes=>nodes.slice(0,2).map(n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y})));
    if(width>640){assert.equal(plots[0].y,plots[1].y);assert(plots[1].x>plots[0].x);}
    else assert(plots[1].y>plots[0].y);
    assert(await page.locator('#dashboard-attention ul').isVisible());
    if(width===390||width===1920)await capture(`overview-${language}-${theme}-${width}`);
  }
  assert(await page.locator('#resource-activity').isHidden());
  await page.locator('#resource-history-toggle').click();
  await page.evaluate(()=>{demoIdle=false;BBUI.resourceMonitor.stop();BBUI.resourceMonitor.start();});
  await page.waitForFunction(()=>!document.getElementById('resource-tests').hidden);
  assert.match(await page.locator('#resource-runs').innerText(),/Appdata/);
  assert(await page.locator('#resource-tests progress').isVisible());
  for(const language of ['de','en'])for(const theme of ['light','dark'])for(const width of [1920,1280,1024,768,390]){
    await page.setViewportSize({width,height:1080});
    await page.evaluate(({language,theme})=>{lang=language;translate();document.documentElement.dataset.theme=theme;renderDashboard(BBUI.core.state.data,null);window.dispatchEvent(new Event('bbui:language-changed'));},{language,theme});
    assert(await page.locator('#resource-history').isHidden());
    const activity=await page.locator('#resource-activity').boundingBox();
    const overview=await page.locator('.dashboard-summary-pair').boundingBox();
    assert.equal(activity.x,overview.x);assert.equal(activity.width,overview.width);
    assert(activity.y>=overview.y+overview.height);
    const resourceCard=await page.locator('#dashboard-resources').boundingBox();
    assert(resourceCard.height<205,'Active test details must not stretch the summary card');
    const overflows=await page.locator('#resource-activity, #resource-tests, .resource-test, .resource-budget').evaluateAll(nodes=>nodes.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.id||el.className));
    assert.deepEqual(overflows,[],`${language}/${theme}/${width} active test`);
    if(width===1920){
      const row=await page.locator('.resource-test').evaluate(el=>[...el.children].map(child=>child.getBoundingClientRect()));
      assert(row.every(child=>child.top<row[0].bottom),'Test identity, CPU, RAM and reserve should share a row');
    }
    if(width===1920||width===390)await capture(`active-test-${language}-${theme}-${width}`);
  }
  await page.evaluate(()=>{demoIdle=true;BBUI.resourceMonitor.stop();BBUI.resourceMonitor.start();});
  await page.waitForFunction(()=>document.getElementById('resource-activity').hidden);

  await page.evaluate(()=>BBUI.resourceMonitor.stop());
  assert.deepEqual(errors,[]);
  console.log('PASS: 3 compact cards, 6/14 coverage, native inline detail persistence/focus, full-width paired history, location-scoped outcomes, real history interactions, full-width active tests and idle cleanup, DE/EN light/dark at 390-1920px.');
  } finally { await browser.close(); }
})();
