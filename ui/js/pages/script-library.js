'use strict';
/** Administrator source browser: templates create drafts; managed files have no write action. */
function scriptLibraryT(key, params = {}) { return settingsT(`scripts.library.${key}`, params); }

/** Resolve documented shipped sources by filename; never treat server text as HTML. */
function scriptLibraryDetail(script, field) {
  const key = {'database-dump-mariadb.sh':'mariadb', 'database-dump-postgresql.sh':'postgresql',
    'pre-check-source.sh':'source', 'pre-check-free-space.sh':'space', 'pre-wake-server.sh':'wake',
    'pre-dump-mariadb.sh':'mariaTemplate', 'pre-dump-postgresql.sh':'pgTemplate', 'post-json-webhook.sh':'webhook'}[script.name];
  return key ? scriptLibraryT(`details.${key}.${field}`) : (field === 'title' ? script.name : '');
}

/** Render ownership navigation and a separate, initially empty source browser. */
function renderScriptLibraryChrome() {
  return `<nav class="script-library-nav" aria-label="${escHtml(scriptLibraryT('navigation'))}">${['own','template','managed'].map(kind => `<button type="button" class="btn ${kind === 'own' ? 'btn-primary' : 'btn-secondary'}" data-script-kind="${kind}" aria-pressed="${kind === 'own'}">${escHtml(scriptLibraryT(kind))}</button>`).join('')}</nav>
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
    button.classList.toggle('btn-primary', selected); button.classList.toggle('btn-secondary', !selected);
  });
  if (kind === 'own') return;
  panel.dataset.libraryKind = kind;
  panel.innerHTML = `<p role="status">${escHtml(settingsT('scripts.loading'))}</p>`;
  try {
    const entries = settingsState.scriptCatalog || (await scriptLibraryRequest('catalog')).entries;
    if (!panel.isConnected || request !== settingsState.scriptLibraryRequest) return;
    settingsState.scriptCatalog = entries;
    panel.innerHTML = `<div class="script-library-intro"><h3>${escHtml(scriptLibraryT(kind))}</h3><p>${escHtml(scriptLibraryT(`${kind}Help`))}</p></div>
      <div class="script-library-layout"><aside class="script-library-files">
        <label class="form-label" for="script-library-filter">${escHtml(scriptLibraryT('search'))}</label><input id="script-library-filter" class="form-input" type="search" autocomplete="off">

        <div id="script-library-files" class="script-library-file-list"></div></aside>
        <div id="script-library-source" class="script-library-source"><p class="form-help">${escHtml(scriptLibraryT('choose'))}</p></div></div>`;
    const rows = entries.filter(row => row.kind === kind);
    rows.sort((a,b) => a.path.localeCompare(b.path));
    const renderFiles = () => {
      const search = document.getElementById('script-library-filter').value.toLowerCase();
      const filtered = rows.filter(row => `${row.name} ${row.path}`.toLowerCase().includes(search));
      const list = document.getElementById('script-library-files');
      list.innerHTML = filtered.map(row => `<button type="button" class="script-library-file" data-source-id="${escHtml(row.id)}"><strong>${escHtml(scriptLibraryDetail(row, 'title'))}</strong><small>${escHtml(row.name)}</small></button>`).join('') || `<p class="form-help">${escHtml(scriptLibraryT('empty'))}</p>`;
      list.querySelectorAll('[data-source-id]').forEach(button => button.addEventListener('click', () => loadScriptLibrarySource(button.dataset.sourceId)));
    };
    document.getElementById('script-library-filter').addEventListener('input', renderFiles);
    renderFiles();
  } catch (error) { if (panel.isConnected && request === settingsState.scriptLibraryRequest) panel.textContent = error.message; }
}

/** Load a selected source, escaping markup via Prism or textContent; stale responses are ignored. */
async function loadScriptLibrarySource(id) {
  const panel = document.getElementById('script-library-source');
  if (!panel) return;
  const request = ++settingsState.scriptLibraryRequest;
  panel.innerHTML = `<p role="status">${escHtml(settingsT('scripts.loading'))}</p>`;
  document.querySelectorAll('[data-source-id]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sourceId === id)));
  try {
    const {script} = await scriptLibraryRequest(`source?id=${encodeURIComponent(id)}`);
    if (!panel.isConnected || request !== settingsState.scriptLibraryRequest) return;
    panel.innerHTML = settingsCard(escHtml(scriptLibraryDetail(script, 'title')), settingsMenuIcon(script.kind === 'template' ? 'advanced' : 'backup'), `
      <div class="settings-body script-library-description">
        <span class="script-library-ownership badge">${escHtml(scriptLibraryT(script.kind === 'template' ? 'copyEditable' : 'pluginOwned'))}</span>
        <p class="script-library-purpose">${escHtml(scriptLibraryDetail(script, 'purpose'))}</p>
        <dl class="script-library-details">${['prerequisites','configuration','behavior'].map(field => `<div><dt>${escHtml(scriptLibraryT(field))}</dt><dd>${escHtml(scriptLibraryDetail(script, field))}</dd></div>`).join('')}</dl>
        ${script.kind === 'template' ? `<button type="button" class="btn btn-primary" id="script-template-use">${escHtml(scriptLibraryT('use'))}</button>` : ''}
      </div>`) + settingsCard(escHtml(scriptLibraryT('codeTitle')), settingsMenuIcon('advanced'), `
      <div class="settings-body script-library-code-body"><div class="script-library-source-meta"><code>${escHtml(script.path)}</code><span>Bash / Shell · ${escHtml(scriptLibraryT('lines', {count:script.content.split('\n').length}))}</span></div>
      <div class="script-source-code"><div class="script-source-lines" aria-hidden="true"></div><pre tabindex="0" aria-label="${escHtml(scriptLibraryT('source'))}"><code></code></pre></div></div>`);
    // Select the source code explicitly: metadata also contains a code element.
    const source = panel.querySelector('pre code');
    const grammar = window.Prism?.languages?.[script.language];
    if (grammar) source.innerHTML = window.Prism.highlight(script.content, grammar, script.language);
    else source.textContent = script.content;
    panel.querySelector('.script-source-lines').textContent = script.content.split('\n').map((_, i) => i + 1).join('\n');
    const pre = panel.querySelector('pre');
    pre.addEventListener('scroll', () => { panel.querySelector('.script-source-lines').scrollTop = pre.scrollTop; });
    panel.querySelector('#script-template-use')?.addEventListener('click', async () => {
      if (settingsState.scriptDirty && !await _openSettingsDialog({title:settingsT('forms.unsavedTitle'), message:settingsT('forms.leaveUnsavedMessage'), confirmText:settingsT('forms.leave'), confirmClass:'btn-danger'})) return;
      if (!panel.isConnected || request !== settingsState.scriptLibraryRequest) return;
      renderSettingsScriptEditor('', {name:uniqueSettingsScriptName(script.name.replace(/\.sh$/, '')), description:scriptLibraryDetail(script, 'purpose'), content:script.content, timeout_seconds:script.timeout_seconds});
      showMsg('settings-script-result', 'success', scriptLibraryT('draft'));
      document.getElementById('settings-script-name').focus();
    });
  } catch (error) { if (panel.isConnected && request === settingsState.scriptLibraryRequest) panel.textContent = error.message; }
}
