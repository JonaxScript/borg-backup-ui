'use strict';
/** Administrator source browser: templates create drafts; managed files have no write action. */
function scriptLibraryT(key, params = {}) { return settingsT(`scripts.library.${key}`, params); }

/** Resolve documented shipped sources by filename; never treat server text as HTML. */
function scriptLibraryDetail(script, field) {
  const key = {'database-dump-mariadb.sh':'mariadb', 'database-dump-postgresql.sh':'postgresql',
    'pre-check-source.sh':'source', 'pre-check-free-space.sh':'space', 'pre-wake-server.sh':'wake',
    'post-json-webhook.sh':'webhook'}[script.name];
  return key ? scriptLibraryT(`details.${key}.${field}`) : (field === 'title' ? script.name : '');
}

/** Render ownership navigation and a separate, initially empty source browser. */
function renderScriptLibraryChrome() {
  return `<nav class="script-library-nav" aria-label="${escHtml(scriptLibraryT('navigation'))}">${['own','template','managed'].map(kind => `<button type="button" data-script-kind="${kind}" aria-pressed="${kind === 'own'}">${escHtml(scriptLibraryT(kind))}</button>`).join('')}</nav>
    <section id="script-library-browser" class="hidden script-library-browser" aria-label="${escHtml(scriptLibraryT('navigation'))}"></section>`;
}

/** Attach category navigation without replacing or discarding the custom-script draft. */
function initScriptLibrary() {
  settingsState.scriptLibraryRequest = (settingsState.scriptLibraryRequest || 0) + 1;
  document.querySelectorAll('[data-script-kind]').forEach(button => button.addEventListener('click', () => showScriptLibrary(button.dataset.scriptKind)));
}

/** Fetch a catalog response and surface localized API failures; never execute returned source. */
async function scriptLibraryRequest(suffix) {
  const response = await fetch(`/api/settings/scripts/${suffix}`);
  const data = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
  return data;
}

/** Show a source category; native controls preserve keyboard access and unsaved own scripts. */
async function showScriptLibrary(kind) {
  const panel = document.getElementById('script-library-browser');
  const own = document.getElementById('settings-own-scripts');
  if (!panel || !own || !['own','template','managed'].includes(kind)) return;
  const request = ++settingsState.scriptLibraryRequest;
  own.classList.toggle('hidden', kind !== 'own');
  panel.classList.toggle('hidden', kind === 'own');
  document.querySelectorAll('[data-script-kind]').forEach(button => {
    const selected = button.dataset.scriptKind === kind;
    button.setAttribute('aria-pressed', String(selected));
  });
  if (kind === 'own') return;
  panel.dataset.libraryKind = kind;
  panel.innerHTML = `<p role="status">${escHtml(settingsT('scripts.loading'))}</p>`;
  try {
    const entries = settingsState.scriptCatalog || (await scriptLibraryRequest('catalog')).entries;
    if (!panel.isConnected || request !== settingsState.scriptLibraryRequest) return;
    settingsState.scriptCatalog = entries;
    const rows = entries.filter(row => row.kind === kind);
    rows.sort((a,b) => scriptLibraryDetail(a, 'title').localeCompare(scriptLibraryDetail(b, 'title')));
    panel.innerHTML = `<div class="script-library-selection">${settingsCard(escHtml(scriptLibraryT(kind)), settingsMenuIcon(kind === 'template' ? 'advanced' : 'backup'), `<div class="settings-body">
      <p class="script-library-intro">${escHtml(scriptLibraryT(`${kind}Help`))}</p>
      <div class="script-library-picker"><label for="script-library-select">${escHtml(scriptLibraryT(kind === 'template' ? 'selectTemplate' : 'selectManaged'))}</label>
      <select id="script-library-select" class="form-select" ${rows.length ? '' : 'disabled'}>${rows.map(row => `<option value="${escHtml(row.id)}">${escHtml(scriptLibraryDetail(row, 'title'))}</option>`).join('') || `<option>${escHtml(scriptLibraryT('empty'))}</option>`}</select></div></div>`)}</div>
      <div id="script-library-source" class="script-library-source"></div>`;
    const select = document.getElementById('script-library-select');
    select.addEventListener('change', () => loadScriptLibrarySource(select.value));
    settingsState.scriptLibrarySelection ||= {};
    select.value = rows.find(row => row.id === settingsState.scriptLibrarySelection[kind])?.id || rows[0]?.id || '';
    if (rows.length) await loadScriptLibrarySource(select.value);
  } catch (error) { if (panel.isConnected && request === settingsState.scriptLibraryRequest) panel.textContent = error.message; }
}

/** Switch local detail panels without refetching source; retain the selected view across scripts. */
function showScriptLibraryDetail(view) {
  const panel = document.getElementById('script-library-source');
  if (!panel || !['description','code'].includes(view)) return;
  settingsState.scriptLibraryDetail = view;
  panel.querySelectorAll('[data-script-detail]').forEach(button => {
    const active = button.dataset.scriptDetail === view;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    document.getElementById(button.getAttribute('aria-controls')).classList.toggle('hidden', !active);
  });
}

/** Load a selected source, escaping markup via Prism or textContent; stale responses are ignored. */
async function loadScriptLibrarySource(id) {
  const panel = document.getElementById('script-library-source');
  if (!panel) return;
  const request = ++settingsState.scriptLibraryRequest;
  panel.innerHTML = `<p role="status">${escHtml(settingsT('scripts.loading'))}</p>`;
  const kind = document.getElementById('script-library-browser').dataset.libraryKind;
  settingsState.scriptLibrarySelection[kind] = id;
  try {
    const {script} = await scriptLibraryRequest(`source?id=${encodeURIComponent(id)}`);
    if (!panel.isConnected || request !== settingsState.scriptLibraryRequest) return;
    panel.innerHTML = settingsCard(escHtml(scriptLibraryDetail(script, 'title')), settingsMenuIcon(script.kind === 'template' ? 'advanced' : 'backup'), `
      <div class="script-library-detail-tabs" role="tablist" aria-label="${escHtml(scriptLibraryT('detailNavigation'))}">${['description','code'].map(view => `<button type="button" role="tab" id="script-library-tab-${view}" data-script-detail="${view}" aria-controls="script-library-panel-${view}" aria-selected="false" tabindex="-1">${escHtml(scriptLibraryT(view === 'description' ? 'descriptionTitle' : 'codeTitle'))}</button>`).join('')}</div>
      <div id="script-library-panel-description" role="tabpanel" aria-labelledby="script-library-tab-description" class="settings-body script-library-description">
        <span class="script-library-ownership">${escHtml(scriptLibraryT(script.kind === 'template' ? 'copyEditable' : 'pluginOwned'))}</span>
        <p class="script-library-purpose">${escHtml(scriptLibraryDetail(script, 'purpose'))}</p>
        <dl class="script-library-details">${['prerequisites','configuration','behavior'].map(field => `<div><dt>${escHtml(scriptLibraryT(field))}</dt><dd>${escHtml(scriptLibraryDetail(script, field))}</dd></div>`).join('')}</dl>
        ${script.kind === 'template' ? `<div class="script-library-actions"><button type="button" class="btn btn-primary" id="script-template-use">${escHtml(scriptLibraryT('use'))}</button></div>` : ''}
      </div>
      <div id="script-library-panel-code" role="tabpanel" aria-labelledby="script-library-tab-code" class="settings-body script-library-code-body hidden"><div class="script-library-source-meta"><code>${escHtml(script.path)}</code><span>Bash / Shell · ${escHtml(scriptLibraryT('lines', {count:script.content.split('\n').length}))}</span></div>
      <div class="script-source-code"><div class="script-source-lines" aria-hidden="true"></div><pre tabindex="0" aria-label="${escHtml(scriptLibraryT('source'))}"><code></code></pre></div></div>`);
    // Select the source code explicitly: metadata also contains a code element.
    const source = panel.querySelector('pre code');
    const grammar = window.Prism?.languages?.[script.language];
    if (grammar) source.innerHTML = window.Prism.highlight(script.content, grammar, script.language);
    else source.textContent = script.content;
    panel.querySelector('.script-source-lines').textContent = script.content.split('\n').map((_, i) => i + 1).join('\n');
    const pre = panel.querySelector('pre');
    pre.addEventListener('scroll', () => { panel.querySelector('.script-source-lines').scrollTop = pre.scrollTop; });
    const tabs = [...panel.querySelectorAll('[data-script-detail]')];
    tabs.forEach((button, index) => {
      button.addEventListener('click', () => showScriptLibraryDetail(button.dataset.scriptDetail));
      button.addEventListener('keydown', event => {
        const next = {ArrowRight:(index + 1) % tabs.length, ArrowLeft:(index + tabs.length - 1) % tabs.length, Home:0, End:tabs.length - 1}[event.key];
        if (next === undefined) return;
        event.preventDefault();
        showScriptLibraryDetail(tabs[next].dataset.scriptDetail);
        tabs[next].focus();
      });
    });
    showScriptLibraryDetail(settingsState.scriptLibraryDetail || 'description');
    panel.querySelector('#script-template-use')?.addEventListener('click', async () => {
      if (settingsState.scriptDirty && !await _openSettingsDialog({title:settingsT('forms.unsavedTitle'), message:settingsT('forms.leaveUnsavedMessage'), confirmText:settingsT('forms.leave'), confirmClass:'btn-danger'})) return;
      if (!panel.isConnected || request !== settingsState.scriptLibraryRequest) return;
      renderSettingsScriptEditor('', {name:uniqueSettingsScriptName(script.name.replace(/\.sh$/, '')), description:scriptLibraryDetail(script, 'purpose'), content:script.content, timeout_seconds:script.timeout_seconds});
      showMsg('settings-script-result', 'success', scriptLibraryT('draft'));
      document.getElementById('settings-script-name').focus();
    });
  } catch (error) { if (panel.isConnected && request === settingsState.scriptLibraryRequest) panel.textContent = error.message; }
}
