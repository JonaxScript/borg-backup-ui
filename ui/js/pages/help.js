'use strict';

let _helpLoadedLanguage = '';
let _helpRequestId = 0;
let _helpSections = [];
let _helpView = 'quick';
let _helpDocumentUrl = '';

function helpT(key, params = {}) {
  return window.BBUI?.components?.i18n?.t?.(`help.${key}`, params) || key;
}

function helpLanguage() {
  return window.BBUI?.components?.i18n?.getLanguage?.() === 'en' ? 'en' : 'de';
}

/** Resolve a supported help document path for the selected locale and view. */
function helpDocumentPath(language, view = _helpView) {
  if (view === 'manual') return `/ui/docs/manual/${language}/user-manual.md`;
  return language === 'en' ? '/ui/docs/help.en.md' : '/ui/docs/help.md';
}

async function fetchHelpDocument(language) {
  const primaryPath = helpDocumentPath(language);
  const primary = await fetch(primaryPath, { cache: 'no-store' });
  if (primary.ok) return { markdown: await primary.text(), path: primaryPath };
  if (language === 'de') throw new Error(`HTTP ${primary.status}`);

  const fallbackPath = helpDocumentPath('de');
  const fallback = await fetch(fallbackPath, { cache: 'no-store' });
  if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
  return { markdown: await fallback.text(), path: fallbackPath };
}

/** Resolve documentation references without allowing executable URL schemes.
 * Returns a URL for HTTP(S) or null for unsupported/invalid input.
 */
function _helpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim(), new URL(_helpDocumentUrl || '/ui/docs/help.md', window.location.origin));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch (_err) { return null; }
}

/** GitHub-style heading slug; punctuation is removed, spaces stay distinct. */
function _helpSlug(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
}

/** Render the supported inline Markdown subset; source HTML remains escaped. */
function _helpInline(text) {
  const source = String(text || '');
  const pattern = /\x60([^\x60\n]+)\x60|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let result = '', cursor = 0;
  for (const match of source.matchAll(pattern)) {
    result += escHtml(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) result += `<code>${escHtml(match[1])}</code>`;
    else if (match[2] !== undefined) {
      const url = _helpUrl(match[3]);
      // Offline documentation images must stay within the bundled docs tree.
      if (url && url.origin === window.location.origin && url.pathname.startsWith('/ui/docs/')) {
        const alt = escHtml(match[2]);
        result += `<figure class="help-figure"><img src="${escHtml(url.href)}" alt="${alt}" loading="lazy"><figcaption>${alt}</figcaption></figure>`;
      } else result += escHtml(match[2]);
    } else if (match[4] !== undefined) {
      const label = escHtml(match[4]);
      const raw = match[5];
      const url = _helpUrl(raw);
      if (raw.startsWith('#')) result += `<a href="#help-${escHtml(raw.slice(1).replace(/^help-/, ''))}" data-help-anchor="${escHtml(raw.slice(1))}">${label}</a>`;
      else if (url) {
        const internal = url.origin === window.location.origin && url.pathname.startsWith('/ui/docs/');
        const documentLink = internal && url.pathname.endsWith('.md');
        const attrs = documentLink ? ' data-help-document="true"' : (internal ? '' : ' target="_blank" rel="noopener noreferrer"');
        result += `<a href="${escHtml(url.href)}"${attrs}>${label}${internal ? '' : ' ↗'}</a>`;
      } else result += label;
    } else if (match[6] !== undefined) result += `<strong>${escHtml(match[6])}</strong>`;
    else result += `<em>${escHtml(match[7])}</em>`;
  }
  return result + escHtml(source.slice(cursor));
}

/** Split GFM table cells while preserving escaped pipes and inline code. */
function _helpCells(line) {
  const cells = []; let cell = '', code = false;
  const text = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '|') { cell += '|'; i += 1; }
    else if (text[i] === '`') { code = !code; cell += text[i]; }
    else if (text[i] === '|' && !code) { cells.push(cell.trim()); cell = ''; }
    else cell += text[i];
  }
  cells.push(cell.trim()); return cells;
}

/** Render bundled Markdown: headings, paragraphs, nested lists, tables and code.
 * This is a restricted renderer, not an HTML interpreter; no raw HTML is trusted.
 */
function _renderHelpMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [], lists = [], paragraph = [];
  let inCode = false, callout = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${_helpInline(paragraph.splice(0).join(' '))}</p>`);
  };
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > indent) {
      out.push(`</li></${lists.pop().type}>`);
    }
  };
  const closeCallout = () => {
    if (!callout.length) return;
    const directive = callout[0].match(/^\[!(NOTE|TIP|WARNING|IMPORTANT)\]\s*(.*)$/i);
    const emphasized = callout[0].match(/^\*\*(Hinweis|Tipp|Warnung|Wichtig|Note|Tip|Warning|Important):\*\*\s*(.*)$/i);
    const kinds = { hinweis: 'note', note: 'note', tipp: 'tip', tip: 'tip', warnung: 'warning', warning: 'warning', wichtig: 'important', important: 'important' };
    const kind = directive ? directive[1].toLowerCase() : (kinds[String(emphasized?.[1] || '').toLowerCase()] || 'note');
    const title = directive?.[2] || emphasized?.[1] || helpT(`callout.${kind}`);
    const body = directive ? callout.slice(1) : (emphasized ? [emphasized[2], ...callout.slice(1)] : callout);
    out.push(`<aside class="help-callout help-callout--${kind}"><strong>${_helpInline(title)}</strong><p>${_helpInline(body.join(' '))}</p></aside>`);
    callout = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\t/g, '    '), t = line.trim();
    const indent = line.length - line.trimStart().length;
    if (t.startsWith('```')) {
      flushParagraph(); closeCallout();
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { if (!lists.length || indent <= lists[lists.length - 1].indent) closeLists(); out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(`${escHtml(line)}\n`); continue; }
    if (!t) { flushParagraph(); closeCallout(); continue; }
    if (t.startsWith('>')) {
      flushParagraph(); closeLists(); callout.push(t.replace(/^>\s?/, '')); continue;
    }
    closeCallout();
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(t)) { flushParagraph(); closeLists(); out.push(_helpInline(t)); continue; }
    const heading = t.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeLists();
      const level = Math.max(2, heading[1].length);
      out.push(`<h${level}${heading[1].length === 1 ? ' class="help-document-title"' : ''}>${_helpInline(heading[2])}</h${level}>`); continue;
    }
    const nextCells = i + 1 < lines.length ? _helpCells(lines[i + 1]) : [];
    if (t.includes('|') && nextCells.length > 1 && nextCells.every(cell => /^:?-{3,}:?$/.test(cell))) {
      flushParagraph(); closeLists();
      const headers = _helpCells(t);
      out.push('<div class="help-table-scroll"><table><thead><tr>');
      headers.forEach(cell => out.push(`<th scope="col">${_helpInline(cell)}</th>`));
      out.push('</tr></thead><tbody>'); i += 1;
      while (i + 1 < lines.length && lines[i + 1].trim().includes('|') && lines[i + 1].trim()) {
        const cells = _helpCells(lines[++i]); out.push('<tr>');
        headers.forEach((_cell, col) => out.push(`<td>${_helpInline(cells[col] || '')}</td>`)); out.push('</tr>');
      }
      out.push('</tbody></table></div>'); continue;
    }
    const item = t.match(/^(?:([-*])|([0-9]+)\.)\s+(.+)$/);
    if (item) {
      flushParagraph(); closeLists(indent);
      const type = item[1] ? 'ul' : 'ol';
      if (lists.length && lists[lists.length - 1].indent === indent && lists[lists.length - 1].type !== type) closeLists(indent - 1);
      if (lists.length && lists[lists.length - 1].indent === indent) out.push('</li><li>');
      else { out.push(`<${type}${type === 'ol' && item[2] !== '1' ? ` start="${Number(item[2])}"` : ''}><li>`); lists.push({ indent, type }); }
      out.push(_helpInline(item[3])); continue;
    }
    if (t === '---') { flushParagraph(); closeLists(); out.push('<hr>'); continue; }
    if (lists.length && indent <= lists[lists.length - 1].indent) { flushParagraph(); closeLists(); }
    paragraph.push(t);
  }
  flushParagraph();
  if (inCode) out.push('</code></pre>');
  closeLists(); closeCallout();
  return out.join('');
}

function _renderHelpToc(content) {
  const toc = document.getElementById('help-toc');
  if (!toc || !content) return;
  const usedIds = new Set();
  const allHeadings = [...content.querySelectorAll('h2, h3, h4, h5, h6')];
  allHeadings.forEach((heading, index) => {
    const text = heading.textContent || `section-${index + 1}`;
    const base = _helpSlug(text);
    let id = `help-${base}`, suffix = 1;
    while (usedIds.has(id)) id = `help-${base}-${suffix++}`;
    usedIds.add(id); heading.id = id;
    heading.dataset.helpAlias = `help-${text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  });
  const headings = allHeadings.filter(heading => ['H2', 'H3'].includes(heading.tagName));
  toc.innerHTML = headings.map((heading, index) => `
    <a class="ui-context-nav__item help-toc-entry ${heading.tagName === 'H3' ? 'is-subsection' : ''}"
      href="#${heading.id}" data-help-target="${heading.id}" ${index === 0 ? 'aria-current="page"' : ''}>
      <span>${escHtml(heading.textContent || '')}</span>
    </a>`).join('');

  _helpSections = [];
  let current = null;
  [...content.children].forEach((node) => {
    if (node.tagName === 'H2') {
      current = { heading: node, nodes: [node], text: '' };
      _helpSections.push(current);
    } else if (current) {
      current.nodes.push(node);
    }
  });
  _helpSections.forEach((section) => {
    section.text = section.nodes.map(node => node.textContent || '').join(' ').toLocaleLowerCase();
    section.tocTargets = section.nodes
      .filter(node => node.matches?.('h2, h3'))
      .map(node => node.id)
      .filter(Boolean);
  });
}

function helpFilter(rawQuery = '') {
  const query = String(rawQuery || '').trim().toLocaleLowerCase();
  const clear = document.getElementById('help-search-clear-btn');
  const status = document.getElementById('help-search-status');
  clear?.classList.toggle('hidden', !query);
  let visible = 0;
  _helpSections.forEach((section) => {
    const match = !query || section.text.includes(query);
    section.nodes.forEach(node => node.classList.toggle('help-search-hidden', !match));
    section.tocTargets.forEach((target) => {
      document.querySelectorAll(`[data-help-target="${target}"]`).forEach(link => link.classList.toggle('help-search-hidden', !match));
    });
    if (match) visible += 1;
  });
  if (status) status.textContent = query ? helpT('searchResults', { count: visible }) : helpT('searchHint');
}

/** Clear the query and filter without moving keyboard focus or the viewport. */
function _helpResetSearch() {
  const input = document.getElementById('help-search-input');
  if (input) input.value = '';
  helpFilter('');
}

/** Clear search on request and return focus without scrolling the page. */
function helpClearSearch() {
  _helpResetSearch();
  document.getElementById('help-search-input')?.focus({ preventScroll: true });
}

/** Update the selected view and its tab state without fetching a document. */
function _helpSelectView(view) {
  _helpView = view;
  document.querySelectorAll('[data-help-view]').forEach((button) => {
    const active = button.dataset.helpView === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function helpSetView(rawView) {
  const view = rawView === 'manual' ? 'manual' : 'quick';
  if (_helpView === view && _helpLoadedLanguage && _helpDocumentUrl === helpDocumentPath(helpLanguage(), view)) return;
  _helpSelectView(view);
  _helpLoadedLanguage = '';
  _helpResetSearch();
  helpInit(true);
}

function openHelpTopic(topic) {
  const input = document.getElementById('help-search-input');
  if (input) input.value = '';
  helpFilter('');
  const normalized = String(topic || '').replace(/^#/, '');
  const target = document.getElementById(normalized) || document.getElementById(`help-${normalized}`)
    || [...document.querySelectorAll('[data-help-alias]')].find(node => node.dataset.helpAlias === normalized || node.dataset.helpAlias === `help-${normalized}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Load help with stale-request protection. Active views reset the reading pane and show the page header;
 * explicit document fragments navigate to their chapter instead. Hidden help
 * reloads never change the current page's scroll position.
 * @param {boolean|Event} [force=false] Bypass the cached-language check.
 * @param {URL|null} [documentUrl=null] Optional bundled document and chapter.
 * @returns {Promise<void>} Completes after rendering or displaying a load error.
 */
async function helpInit(force = false, documentUrl = null) {
  const language = helpLanguage();
  if (_helpLoadedLanguage === language && !force) return;
  const box = document.getElementById('help-content');
  if (!box) return;
  const requestId = ++_helpRequestId;
  hideEl('help-message');
  const toc = document.getElementById('help-toc');
  if (toc) toc.innerHTML = '';
  box.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><span>${escHtml(helpT('loading'))}</span></div>`;
  try {
    let helpDocument;
    if (documentUrl) {
      const response = await fetch(documentUrl.pathname, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      helpDocument = { markdown: await response.text(), path: documentUrl.pathname };
    } else helpDocument = await fetchHelpDocument(language);
    if (requestId !== _helpRequestId) return;
    _helpDocumentUrl = helpDocument.path;
    if (/^\/ui\/docs\/manual\/(de|en)\/user-manual\.md$/.test(_helpDocumentUrl)) _helpSelectView('manual');
    else if (/^\/ui\/docs\/help(?:\.en)?\.md$/.test(_helpDocumentUrl)) _helpSelectView('quick');
    box.innerHTML = _renderHelpMarkdown(helpDocument.markdown);
    _renderHelpToc(box);
    helpFilter(document.getElementById('help-search-input')?.value || '');
    _helpLoadedLanguage = language;
    if (box.closest('.page')?.classList.contains('active')) {
      if (documentUrl?.hash) openHelpTopic(decodeURIComponent(documentUrl.hash.slice(1)));
      else {
        box.scrollTop = 0;
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    }
  } catch (err) {
    if (requestId !== _helpRequestId) return;
    _helpLoadedLanguage = '';
    box.innerHTML = '';
    showMsg('help-message', 'error', helpT('loadFailed', { message: err.message }));
  }
}

window.addEventListener?.('bbui:language-changed', () => helpInit(true));
window.helpInit = helpInit;
window.helpFilter = helpFilter;
window.helpClearSearch = helpClearSearch;
window.helpSetView = helpSetView;
window.openHelpTopic = openHelpTopic;

/** Keep bundled Markdown links in the offline reader and resolve legacy anchors. */
document.addEventListener('click', event => {
  const link = event.target.closest?.('#help-content a');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (link.dataset.helpAnchor !== undefined) {
    event.preventDefault(); openHelpTopic(decodeURIComponent(link.dataset.helpAnchor));
  } else if (link.dataset.helpDocument) {
    const url = _helpUrl(link.getAttribute('href'));
    if (!url || url.origin !== window.location.origin || !url.pathname.startsWith('/ui/docs/') || !url.pathname.endsWith('.md')) return;
    event.preventDefault(); _helpResetSearch(); helpInit(true, url);
  }
});
