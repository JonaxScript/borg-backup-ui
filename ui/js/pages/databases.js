'use strict';
/** Managed database profiles and bounded test operations; password inputs are write-only and never populated from API responses. */
const databaseState = {profiles: [], unsupportedProfiles: [], containers: [], selected: '', operation: null, polling: false, available: {}};
function dbT(key, params = {}) { return window.BBUI.components.i18n.t(`database.${key}`, params); }

/** Fetch a database API response and expose only localized server error codes. */
async function databaseRequest(path, body, method = 'POST') {
  const response = await fetch(`/api/settings/databases${path}`, body === undefined ? {} : {
    method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(data, response.status));
  return data;
}

/** Load inventory before rendering; never replace a dirty draft during background polling. */
async function loadDatabaseSettings(selected = databaseState.selected) {
  const panel = document.getElementById('settings-databases-panel');
  if (!panel) return;
  try {
    const [data, inventory] = await Promise.all([
      databaseRequest('', undefined), fetch('/api/wizard/runtime-inventory').then(r => r.json()).catch(() => ({})),
    ]);
    databaseState.profiles = data.profiles;
    databaseState.unsupportedProfiles = data.unsupported_profiles || [];
    databaseState.containers = inventory.docker_containers || [];
    databaseState.selected = selected;
    renderDatabaseSettings();
    await loadDatabaseRuns();
    if (databaseState.operation) pollDatabaseOperation();
  } catch (e) { panel.textContent = e.message; }
}

/** Render escaped profile fields and attach event handlers without embedding user code. */
function renderDatabaseSettings() {
  const panel = document.getElementById('settings-databases-panel');
  if (!panel) return;
  const row = databaseState.profiles.find(p => p.id === databaseState.selected) || {
    engine:'mariadb', enabled:true, port:3306, timeout_seconds:1800, min_free_mib:1024, retention:'keep', databases:[], auth_mode:'managed', database_user:'root', staging_mount:'/mnt/cache', staging_dir:'/mnt/cache/borg-database-dumps',
  };
  const input = (key, type='text', extra='') => `<label class="form-label" for="db-${key}">${escHtml(dbT(key))}</label><input class="form-input" id="db-${key}" name="${key}" type="${type}" value="${escHtml(key === 'database_user' ? (row[key] || (row.engine === 'postgresql' ? 'postgres' : 'root')) : (row[key] ?? ''))}" ${extra}>`;
  const containers = [...new Set(databaseState.containers.map(p => typeof p === 'string' ? p : p.name || p.Name || '').filter(Boolean))].sort();
  if (row.container && !containers.includes(row.container)) containers.unshift(row.container);
  panel.innerHTML = `<div class="database-settings">
    <div class="database-intro"><span class="settings-menu-icon">${settingsMenuIcon('repository')}</span><div><h3>${escHtml(dbT('title'))}</h3><p>${escHtml(dbT('intro'))}</p></div></div>
    ${databaseState.unsupportedProfiles.length ? `<p class="status-message warning" id="db-unsupported">${escHtml(dbT('unsupportedProfiles'))}<br>${databaseState.unsupportedProfiles.map(p => `${escHtml(p.name)} (${escHtml(p.engine)})`).join(', ')}</p>` : ''}
    <div class="form-group"><label class="form-label" for="db-select">${escHtml(dbT('profile'))}</label>
    <select class="form-select" id="db-select"><option value="">${escHtml(dbT('new'))}</option>${databaseState.profiles.map(p => `<option value="${escHtml(p.id)}" ${p.id === row.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}</select></div>
    <p class="profile-workflow-hint">${escHtml(dbT('workflowHint'))}</p>
    <form id="database-form" class="database-form">
    ${settingsCard(escHtml(dbT('connection')), settingsMenuIcon('repository'), `<div class="settings-body database-fields">
      <div class="form-group">${input('name','text','required maxlength="100"')}</div>
      <div class="form-group"><label class="form-label" for="db-engine">${escHtml(dbT('engine'))}</label><select class="form-select" id="db-engine" name="engine"><option value="mariadb">MariaDB</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option></select></div>
      <div class="form-group"><label class="form-label" for="db-container">${escHtml(dbT('container'))}</label><div><select class="form-select" id="db-container" name="container" required aria-describedby="db-container-hint"><option value="" disabled ${row.container ? '' : 'selected'}>${escHtml(dbT('chooseContainer'))}</option>${containers.map(name => `<option value="${escHtml(name)}" ${name === row.container ? 'selected' : ''}>${escHtml(name)}</option>`).join('')}</select><p class="form-help" id="db-container-hint">${escHtml(dbT(databaseState.containers.length ? 'containerHint' : 'containersEmpty'))}</p></div></div>
      <div class="form-group database-auth-field">${input('database_user','text','required autocomplete="username"')}</div>
      <div class="form-group database-auth-field"><label class="form-label" for="db-password">${escHtml(dbT('password'))}</label><input class="form-input" id="db-password" name="password" type="password" autocomplete="new-password" maxlength="4096" placeholder="${escHtml(dbT(row.credential_id ? 'passwordKeep' : 'passwordEnter'))}"></div>
      <p class="form-help database-auth-field">${escHtml(dbT('credentials'))}</p>
      <p class="form-help" id="db-engine-scope"></p>
      ${row.auth_mode === 'managed' && row.credential_id ? `<p class="form-help database-secret-file">${escHtml(dbT('secretFile'))}: <code>${escHtml('secrets/' + (/^[a-f0-9]{32}$/.test(row.credential_id) ? '.database-' : '') + row.credential_id + '.json')}</code></p>` : ''}
      ${row.auth_mode === 'container' ? `<p class="status-message info">${escHtml(dbT('legacyCredentials'))} <code>${escHtml(row.credential_file)}</code></p>` : ''}
      <details class="database-advanced"><summary>${escHtml(dbT('advancedConnection'))}</summary>
        <div class="form-group">${input('port','number','required min="1" max="65535"')}</div>
        <div class="form-group">${input('execution_user')}</div>
      </details>
    </div>`)}
    ${settingsCard(escHtml(dbT('databases')), settingsMenuIcon('backup'), `<div class="settings-body">
      <p class="form-help">${escHtml(dbT('selectionHint'))}</p>
      <button class="btn btn-secondary" type="submit" data-db-discover>${escHtml(dbT('discover'))}</button>
      <div id="db-databases" class="database-selection"></div>
      <div class="database-flags"><label id="db-globals-label"><input type="checkbox" id="db-globals" ${row.include_globals ? 'checked' : ''}> ${escHtml(dbT('globals'))}</label></div>
      <p class="form-help">${escHtml(dbT('globalsHint'))}</p><p class="form-help">${escHtml(dbT('scope'))}</p>
    </div>`)}
    ${settingsCard(escHtml(dbT('storageTitle')), settingsMenuIcon('backup'), `<div class="settings-body database-fields">
      <p class="form-help">${escHtml(dbT('storageHint'))}</p>
      <div class="form-group">${input('staging_mount','text','required placeholder="/mnt/cache"')}</div>
      <div class="form-group">${input('staging_dir','text','required placeholder="/mnt/cache/borg-database-dumps"')}</div>
      <div class="form-group"><label class="form-label" for="db-retention">${escHtml(dbT('retention'))}</label><select class="form-select" id="db-retention" name="retention"><option value="keep">${escHtml(dbT('keep'))}</option><option value="after_archive">${escHtml(dbT('after_archive'))}</option></select></div>
      <details class="database-advanced"><summary>${escHtml(dbT('limits'))}</summary>
        <div class="form-group">${input('min_free_mib','number','required min="1" max="104857600"')}</div>
        <div class="form-group">${input('timeout_seconds','number','required min="1" max="86400"')}</div>
      </details>
    </div>`)}
      <p id="db-save-feedback" class="status-message hidden" role="status" aria-live="polite"></p>
      <div class="database-footer profile-save-bar"><span data-profile-save-status></span><label><input type="checkbox" id="db-enabled" ${row.enabled ? 'checked' : ''}> ${escHtml(dbT('enabled'))}</label>
      <div class="job-script-actions"><button class="btn btn-primary" type="submit">${escHtml(dbT('save'))}</button>
        <button class="btn btn-danger" id="db-delete" type="button" ${row.id ? '' : 'disabled'}>${escHtml(dbT('delete'))}</button></div></div>
    </form>
    ${settingsCard(escHtml(dbT('actions')), settingsMenuIcon('restore'), `<div class="settings-body">
      <p class="form-help">${escHtml(dbT('savedActions'))}</p><div class="job-script-actions">${['check','dump','reconcile'].map(action => `<button class="btn btn-secondary" type="button" data-db-action="${action}" ${row.id && (row.enabled || action === 'reconcile') ? '' : 'disabled'}>${escHtml(dbT(action))}</button>`).join('')}
      <button class="btn btn-secondary" id="db-cancel" ${databaseState.operation ? '' : 'disabled'}>${escHtml(dbT('cancel'))}</button></div>
      <p id="db-result" class="status-message hidden" role="status" aria-live="polite"></p>
    </div>`)}
    ${settingsCard(escHtml(dbT('runs')), settingsMenuIcon('backup'), `<div class="settings-body"><p class="form-help">${escHtml(dbT('runsHint'))}</p><p class="form-help">${escHtml(dbT('housekeeping'))}</p><button class="btn btn-secondary" id="db-refresh">${escHtml(dbT('refresh'))}</button><div id="db-runs"></div></div>`)}
  </div>`;
  document.getElementById('db-engine').value = row.engine;
  document.getElementById('db-retention').value = row.retention;
  settingsState.databaseDirty = false;
  const form = document.getElementById('database-form');
  const updateDraft = () => {
    settingsState.databaseDirty = settingsFormSignature(form) !== databaseState.savedDraft;
    document.getElementById('db-save-feedback')?.classList.add('hidden');
    _updateUnsavedChangesUi();
  };
  form.addEventListener('input', updateDraft);
  form.addEventListener('change', updateDraft);
  databaseEngineFields(row.engine);
  renderDatabaseChoices(databaseState.available[row.id] || [], row.databases);
  document.getElementById('db-engine').addEventListener('change', e => {
    databaseEngineFields(e.target.value);
    document.getElementById('db-port').value = {mariadb:3306,mysql:3306,postgresql:5432}[e.target.value];
    renderDatabaseChoices([], []);
    document.getElementById('db-globals').checked = false;
    document.getElementById('db-database_user').value = e.target.value === 'postgresql' ? 'postgres' : 'root';
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (settingsState.profileSaving) return;
    const body = Object.fromEntries(new FormData(form));
    if (row.id) body.id = row.id;
    body.databases = [...form.querySelectorAll('#db-databases input:checked')].map(el => el.value);
    body.auth_mode = row.auth_mode === 'container' && !body.password ? 'container' : 'managed';
    if (body.engine !== row.engine && body.auth_mode === 'container') body.auth_mode = 'managed';
    if (body.auth_mode === 'container') body.credential_file = row.credential_file;
    if (!body.password && row.credential_id) delete body.password;
    const discover = e.submitter?.hasAttribute('data-db-discover');
    for (const k of ['port','timeout_seconds','min_free_mib']) body[k] = Number(body[k]);
    body.enabled = document.getElementById('db-enabled').checked;
    body.include_globals = document.getElementById('db-globals').checked;
    const controls = [...panel.querySelectorAll('input, select, button')].map(el => [el, el.disabled]);
    controls.forEach(([el]) => { el.disabled = true; });
    settingsState.profileSaving = true;
    _updateUnsavedChangesUi();
    let savedProfile = null;
    try {
      const data = await databaseRequest('', body);
      // The acknowledged profile is authoritative; a later inventory GET must
      // not turn a successful save into a failed save or overwrite the draft.
      databaseState.profiles = [...databaseState.profiles.filter(p => p.id !== data.profile.id), data.profile];
      databaseState.selected = data.profile.id;
      settingsState.databaseDirty = false;
      renderDatabaseSettings();
      void loadDatabaseRuns();
      showMsg('db-save-feedback', 'success', dbT(discover ? 'connectionSaved' : 'saved'));
      savedProfile = data.profile.id;
    } catch (err) { showMsg('db-save-feedback', 'error', err.message); }
    finally {
      settingsState.profileSaving = false;
      controls.forEach(([el, disabled]) => { el.disabled = disabled; });
      _updateUnsavedChangesUi();
    }
    if (discover && savedProfile) await startDatabaseAction(savedProfile, 'discover');
  });
  document.getElementById('db-select').addEventListener('change', async e => {
    const selected = e.target.value;
    if (settingsState.databaseDirty) {
      e.target.value = databaseState.selected;
      if (!await _openSettingsDialog({title:dbT('discardTitle'), message:dbT('discard'), confirmText:dbT('discardAction'), confirmClass:'btn-danger'})) return;
    }
    databaseState.selected = selected; renderDatabaseSettings(); loadDatabaseRuns();
  });
  document.getElementById('db-delete').addEventListener('click', async () => {
    if (!await _openSettingsDialog({dialogClass:'database-confirmation', title:dbT('delete'), message:dbT('confirmDelete') + '\n\n' + row.name, confirmText:dbT('delete'), confirmClass:'btn-danger'})) return;
    try { await databaseRequest(`?id=${encodeURIComponent(row.id)}`, {}, 'DELETE'); await loadDatabaseSettings(''); }
    catch (e) { databaseFeedback(e.message); }
  });
  panel.querySelectorAll('[data-db-action]').forEach(button => button.addEventListener('click', () => startDatabaseAction(row.id, button.dataset.dbAction)));
  document.getElementById('db-cancel').addEventListener('click', async () => {
    try { if (databaseState.operation) await databaseRequest('/cancel', {id:databaseState.operation}); databaseFeedback(dbT('cancelling')); }
    catch (e) { databaseFeedback(e.message); }
  });
  document.getElementById('db-refresh').addEventListener('click', loadDatabaseRuns);
  databaseState.savedDraft = settingsFormSignature(form);
  _updateUnsavedChangesUi();
}
/** Show only applicable engine options, retaining shared profile fields. */
function databaseEngineFields(engine) {
  const pg = engine === 'postgresql';
  document.getElementById('db-globals-label').classList.toggle('hidden', !pg);
  document.getElementById('db-engine-scope').textContent = ['mariadb','mysql'].includes(engine) ? dbT('mysqlScope') : '';

}
function databaseFeedback(message) {
  const node = document.getElementById('db-result');
  if (node) { node.textContent = message; node.classList.remove('hidden'); }
}

/** Render discovered names and retain explicit selections even when no longer discoverable. */
function renderDatabaseChoices(available, selected) {
  const node = document.getElementById('db-databases');
  if (!node) return;
  const names = [...new Set([...available, ...selected])].sort();
  node.innerHTML = names.map(name => `<label class="database-choice"><input type="checkbox" value="${escHtml(name)}" ${selected.includes(name) ? 'checked' : ''}><span>${escHtml(name)}</span></label>`).join('') || `<p class="form-help">${escHtml(dbT('notLoaded'))}</p>`;
}

/** Start only saved profile operations; local cleanup always requires an explicit confirmation. */
async function startDatabaseAction(profile_id, action, directory) {
  if (databaseState.operation) { databaseFeedback(dbT('running')); return; }
  if (settingsState.databaseDirty) { databaseFeedback(dbT('saveFirst')); return; }
  if (action === 'cleanup' && !await _openSettingsDialog({dialogClass:'database-confirmation', title:dbT('cleanup'), message:dbT('confirmCleanup') + '\n\n' + directory, confirmText:dbT('cleanup'), confirmClass:'btn-danger'})) return;
  try {
    const result = await databaseRequest('/action', {profile_id, action, directory});
    databaseState.operation = result.id;
    document.getElementById('db-cancel').disabled = false;
    pollDatabaseOperation();
  } catch (e) { databaseFeedback(e.message); }
}

/** Poll the asynchronous operation, stopping after completion or an HTTP error. */
async function pollDatabaseOperation() {
  if (databaseState.polling || !databaseState.operation) return;
  databaseState.polling = true;
  try {
    while (databaseState.operation) {
      const status = await databaseRequest(`/status?id=${encodeURIComponent(databaseState.operation)}`, undefined);
      const error = status.error_code ? apiErrorMessage({code:status.error_code}) : '';
      const locations = (status.results || []).map(r => r.directory).join(', ');
      databaseFeedback([dbT(status.status), error, locations, status.action === 'dump' && status.status === 'completed' ? dbT('testOnly') : ''].filter(Boolean).join(' · '));
      if (status.status !== 'running') {
        if (status.status === 'completed' && Array.isArray(status.databases) && status.profile_id === databaseState.selected) {
          databaseState.available[status.profile_id] = status.databases;
          const selected = [...document.querySelectorAll('#db-databases input:checked')].map(el => el.value);
          renderDatabaseChoices(status.databases, selected);
          databaseFeedback(dbT('discovered', {count: status.databases.length}));
        }
        databaseState.operation = null; await loadDatabaseRuns(); break;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch (e) { databaseFeedback(e.message); }
  finally { databaseState.polling = false; const b = document.getElementById('db-cancel'); if (b) b.disabled = !databaseState.operation; }
}

/** Show retained exports across saved profiles, with local cleanup; never dump contents. */
async function loadDatabaseRuns() {
  const node = document.getElementById('db-runs'); if (!node) return;
  try {
    const data = await databaseRequest('/runs', undefined);
    node.innerHTML = data.runs.map((r,i) => {
      const date = new Date(r.started_at || NaN);
      const timestamp = Number.isNaN(date.getTime()) ? (r.started_at || '') : date.toLocaleString(settingsLocale(), {dateStyle:'medium', timeStyle:'long'});
      return `<article class="database-run"><header><strong>${escHtml(r.profile_name || r.profile_id)}</strong><time datetime="${escHtml(r.started_at || '')}">${escHtml(timestamp)}</time></header>
        <div class="database-run-meta"><span class="badge">${escHtml(dbT(r.status))}</span><span>${escHtml(r.compression === 'gzip' ? dbT('compressedSize', {size:settingsFmtBytes(r.bytes)}) : settingsFmtBytes(r.bytes))}</span>${r.compression === 'gzip' ? `<span>${escHtml(dbT('originalSize', {size:settingsFmtBytes(r.uncompressed_bytes)}))}</span>` : ''}</div>
        <code>${escHtml(r.directory)}</code><span>${escHtml(r.archived ? dbT('archived') : dbT('notArchived'))}</span><button class="btn btn-secondary" data-cleanup="${i}">${escHtml(dbT('cleanup'))}</button></article>`;
    }).join('') || `<p>${escHtml(dbT(data.errors?.length ? 'runsUnavailable' : 'noRuns'))}</p>`;
    for (const error of data.errors || []) { const p = document.createElement('p'); p.textContent = `${error.profile_name || error.profile_id}${error.staging_dir ? " (" + error.staging_dir + ")" : ""}: ${apiErrorMessage({code:error.error_code})}`; node.append(p); }
    node.querySelectorAll('[data-cleanup]').forEach(button => button.addEventListener('click', () => {
      const r=data.runs[Number(button.dataset.cleanup)]; startDatabaseAction(r.profile_id, 'cleanup', r.directory);
    }));
  } catch (e) { node.textContent = e.message; }
}

/** Load wizard profile choices; retain unavailable selections instead of silently dropping them. */
async function wizardLoadDatabases(request) {
  try {
    const data = await databaseRequest('', undefined);
    if (request !== wizardState.jobIdRequest) return;
    wizardState.databaseProfiles = [...data.profiles, ...(data.unsupported_profiles || []).map(p => ({...p, enabled:false, databases:[]}))];
    wizardState.databasesLoaded = true;
    wizardApplyDatabases([]);
  } catch (_) { if (request === wizardState.jobIdRequest) { wizardState.databasesLoaded = false; _wizardShowError(2, dbT('loadError')); } }
}
/** Render all available and missing selected profiles without changing the requested selection. */
function wizardApplyDatabases(selected) {
  const node = document.getElementById('wiz-databases'); if (!node) return;
  const rows = [...(wizardState.databaseProfiles || [])];
  for (const id of selected) if (!rows.some(p => p.id === id)) rows.push({id,name:dbT('missing'),databases:[]});
  node.innerHTML = rows.map(p => `<label class="wizard-database-choice"><input type="checkbox" value="${escHtml(p.id)}" ${selected.includes(p.id) ? 'checked' : ''}><span><strong>${escHtml(p.name)}${p.enabled ? '' : ' ('+escHtml(dbT('missing'))+')'}</strong><small>${escHtml(p.engine || '')}${p.databases.length ? ' · '+escHtml(p.databases.join(', ')) : ''}${p.include_globals ? ' · '+escHtml(dbT('globals')) : ''}</small></span></label>`).join('') || `<p>${escHtml(dbT('noProfiles'))}</p>`;
  wizardUpdateDatabaseCount();
}

/** Update the selected-profile count, including unavailable profiles retained for explicit correction. */
function wizardUpdateDatabaseCount() {
  const count = document.getElementById('wiz-source-database-count');
  if (count) count.textContent = String(document.querySelectorAll('#wiz-databases input:checked').length);
}
