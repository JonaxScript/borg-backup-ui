'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({
  URL, console,
  window: { location: { origin: 'http://127.0.0.1:8766' }, addEventListener() {} },
  document: { addEventListener() {} },
  escHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
});
vm.runInContext(fs.readFileSync('ui/js/pages/help.js', 'utf8'), context);
const render = text => context._renderHelpMarkdown(text);
assert.match(render('| A | B |\n| --- | --- |\n| L2 | `--dry-run` |'), /<table><thead><tr><th scope="col">A<\/th>/);
assert.match(render('| A | B |\n| --- | --- |\n| x\\|y | `a|b` |'), /<td>x\|y<\/td><td><code>a\|b<\/code>/);
assert.match(render('1. Parent\n   - Child\n     - Grandchild\n2. Next'), /<ol><li>Parent<ul><li>Child<ul><li>Grandchild<\/li><\/ul><\/li><\/ul><\/li><li>Next/);
assert.match(render('1. One\n\n   Continued\n\n2. Two'), /One<p>Continued<\/p><\/li><li>Two/);
assert.match(render('```bash\necho "<b>&"\n```'), /&lt;b&gt;&amp;/);
assert.match(render('`[literal](javascript:alert)` and `x`'), /<code>\[literal\]\(javascript:alert\)<\/code> and <code>x<\/code>/);
for (const md of ['[bad](javascript:alert)', '[bad](data:text/html,x)', '![x](javascript:bad)', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>']) {
  assert.doesNotMatch(render(md), /<script|<img|href="(?:javascript|data):/);
}
assert.match(render('[external](https://example.org/?a=1&b=2)'), /&amp;b=2.*rel="noopener noreferrer".*↗/);
vm.runInContext("_helpDocumentUrl = '/ui/docs/manual/de/user-manual.md'", context);
assert.match(render('[companion](../../integrations/prometheus.md#setup)'), /href="http:\/\/127.0.0.1:8766\/ui\/docs\/integrations\/prometheus.md#setup" data-help-document/);
assert.match(render('![Übersicht](../assets/de/dashboard.png)'), /\/ui\/docs\/manual\/assets\/de\/dashboard.png/);
assert.match(render('> [!WARNING] Achtung\n> Zwei Zeilen'), /help-callout--warning.*Zwei Zeilen/);
assert.equal(context._helpSlug('7. Browse & Restore'), '7-browse--restore');
assert.equal(context._helpSlug('Wiederherstellung für Anfänger'), 'wiederherstellung-für-anfänger');
const headings = ['7. Browse & Restore', 'Wiederherstellung für Anfänger', 'Same', 'Same'].map(text => ({ textContent: text, tagName: 'H2', dataset: {} }));
const toc = { innerHTML: '' };
context.document.getElementById = id => id === 'help-toc' ? toc : headings.find(h => h.id === id);
context.document.querySelectorAll = () => headings;
context._renderHelpToc({ querySelectorAll: () => headings, children: [] });
assert.deepEqual(headings.map(h => h.id), ['help-7-browse--restore', 'help-wiederherstellung-für-anfänger', 'help-same', 'help-same-1']);
assert.match(toc.innerHTML, /#help-7-browse--restore/);
let scrolled = false;
headings[0].scrollIntoView = () => { scrolled = true; };
context.openHelpTopic('7-browse-restore');
assert.equal(scrolled, true, 'Old normalized help anchor still resolves');
console.log('Help renderer: tables, nested lists, code, escaping, links, Unicode and legacy anchors OK');

// Exercise async navigation, tab selection and stale-response protection.
(async () => {
  const tabs = ['quick', 'manual'].map(view => ({
    dataset: { helpView: view }, classList: { toggle() {} },
    setAttribute(name, value) { this[name] = value; },
  }));
  const box = { innerHTML: '', children: [], querySelectorAll: () => [], scrollIntoView() {} };
  const input = { value: '', focus() {} };
  const pending = [];
  context.document.getElementById = id => ({ 'help-content': box, 'help-toc': toc, 'help-search-input': input }[id]);
  context.document.querySelectorAll = selector => selector === '[data-help-view]' ? tabs : [];
  context.hideEl = () => {};
  context.showMsg = () => { throw new Error('Unexpected document load error'); };
  context.fetch = path => new Promise(resolve => pending.push({ path, resolve }));
  const first = context.helpInit(true, new URL('http://127.0.0.1:8766/ui/docs/manual/de/user-manual.md'));
  const second = context.helpInit(true, new URL('http://127.0.0.1:8766/ui/docs/help.md'));
  pending[1].resolve({ ok: true, text: async () => '# Latest quick help' });
  await second;
  pending[0].resolve({ ok: true, text: async () => '# Stale manual' });
  await first;
  assert.match(box.innerHTML, /Latest quick help/);
  assert.doesNotMatch(box.innerHTML, /Stale manual/);
  assert.equal(tabs[0]['aria-selected'], 'true');
  const manual = context.helpInit(true, new URL('http://127.0.0.1:8766/ui/docs/manual/de/user-manual.md'));
  pending[2].resolve({ ok: true, text: async () => '# Current manual' });
  await manual;
  assert.equal(tabs[1]['aria-selected'], 'true', 'Quick-help link selects the manual tab');
  assert.match(box.innerHTML, /Current manual/);
  console.log('Help navigation: current document, tab state and stale responses OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
