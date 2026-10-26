'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(lang = 'de') {
  const dict = JSON.parse(fs.readFileSync(`ui/i18n/${lang}.json`));
  const elements = new Map();
  for (const id of ['resource-values', 'resource-live', 'resource-tests', 'resource-history', 'resource-history-toggle']) {
    elements.set(id, {innerHTML: '', textContent: '', hidden: false, attrs: {}, listeners: {},
      classList: {toggle() {}}, setAttribute(k, v) {this.attrs[k] = v;}, addEventListener(k, v) {this.listeners[k] = v;}});
  }
  const timers = new Map(); let timerId = 0;
  const listeners = {}; const requests = [];
  let next = () => Promise.resolve({ok: true, json: async () => sample()});
  const window = {BBUI: {components: {i18n: {
    t: (key, params = {}) => key.split('.').reduce((v, k) => v?.[k], dict).replace(/\{(\w+)\}/g, (_, k) => params[k] ?? ''),
    getLanguage: () => lang}}, core: {state: {currentPage: 'dashboard', data: {backups: [{key: 'appdata', name: '<img onerror="oops">'}]}}}},
    addEventListener: (key, callback) => {listeners[key] = callback;}};
  const document = {hidden: false, getElementById: id => elements.get(id), addEventListener: (key, callback) => {listeners[key] = callback;}};
  const context = vm.createContext({window, document, Intl, AbortController,
    escHtml: s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c])),
    setTimeout: (fn, delay) => {timers.set(++timerId, {fn, delay}); return timerId;},
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => {requests.push({url, options}); return next();}});
  vm.runInContext(fs.readFileSync('ui/js/components/resource-monitor.js', 'utf8'), context);
  return {elements, timers, window, document, listeners, requests, monitor: window.BBUI.resourceMonitor,
    setResponse: callback => {next = callback;}, tick: delay => {const [id, task] = [...timers].find(([, t]) => t.delay === delay); timers.delete(id); task.fn();}};
}
function sample(active = true) {
  const group = {id: 'one', job_key: 'appdata', cpu_percent: 12.5, memory_bytes: 1.3 * 1024**3, memory_limit_bytes: 2 * 1024**3};
  return {available: true, stale: false, host: {cpu_percent: 38, memory_available_bytes: 5.7 * 1024**3, memory_total_bytes: 32 * 1024**3},
    runs_available: true, runs: active ? [{job_key: 'appdata', operation: 'restore_test'}] : [],
    protected_tests: active ? [group] : [], configured_reserve_bytes: 1024**3,
    history: [{timestamp: 1000, host: {cpu_percent: null, memory_available_bytes: null}, protected_tests: []},
      {timestamp: 1005, host: {cpu_percent: 38, memory_available_bytes: 5.7 * 1024**3}, protected_tests: [group]}]};
}

for (const lang of ['de', 'en']) {
  test(`${lang}: render active values safely, preserve toggle and switch idle cadence`, async () => {
    const h = harness(lang); h.monitor.start(); h.monitor.start(); await flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/system-resources');
    assert.match(h.elements.get('resource-values').innerHTML, /38 %/);
    assert.doesNotMatch(h.elements.get('resource-tests').innerHTML, /<img/);
    assert.match(h.elements.get('resource-tests').innerHTML, /&lt;img/);
    assert.match(h.elements.get('resource-tests').innerHTML, /<progress/);
    const toggle = h.elements.get('resource-history-toggle'); toggle.listeners.click();
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    assert.match(h.elements.get('resource-history').innerHTML, /resource-chart-large/);
    assert.doesNotMatch(h.elements.get('resource-history').innerHTML, /NaN|undefined/);
    h.setResponse(async () => ({ok: true, json: async () => sample(false)}));
    h.tick(2000); await flush();
    assert.equal(h.elements.get('resource-tests').hidden, true);
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    assert.ok([...h.timers.values()].some(t => t.delay === 10000));
    h.monitor.stop(); assert.equal(h.timers.size, 0);
  });
}

test('failed and stale samples do not display old numbers as live', async () => {
  const h = harness(); h.monitor.start(); await flush();
  h.setResponse(async () => {throw new Error('offline');}); h.tick(2000); await flush();
  assert.doesNotMatch(h.elements.get('resource-values').innerHTML, /38 %/);
  assert.match(h.elements.get('resource-values').innerHTML, /—/);
  assert.match(h.elements.get('resource-live').textContent, /nicht verfügbar/);
  h.setResponse(async () => ({ok: true, json: async () => ({...sample(), stale: true})}));
  h.tick(10000); await flush();
  assert.doesNotMatch(h.elements.get('resource-values').innerHTML, /38 %/);
  h.monitor.stop();
});

test('visibility/navigation abort in-flight requests and discard obsolete responses', async () => {
  const h = harness(); let resolve;
  h.setResponse(() => new Promise(done => {resolve = done;}));
  h.monitor.start();
  h.document.hidden = true; h.listeners.visibilitychange();
  assert.equal(h.requests[0].options.signal.aborted, true);
  resolve({ok: true, json: async () => sample()}); await flush();
  assert.doesNotMatch(h.elements.get('resource-values').innerHTML, /38 %/);
  assert.equal(h.timers.size, 0);
  h.setResponse(async () => ({ok: true, json: async () => sample()}));
  h.document.hidden = false; h.listeners.visibilitychange(); await flush();
  assert.equal(h.requests.length, 2);
  h.window.BBUI.core.state.currentPage = 'jobs'; h.monitor.stop();
  h.monitor.start(); await flush(); assert.equal(h.requests.length, 2);
  assert.equal(h.timers.size, 0);
});
