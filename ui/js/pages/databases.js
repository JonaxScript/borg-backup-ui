'use strict';
/** Managed database profiles and bounded test operations; credentials never enter this editor. */
const databaseState = {profiles: [], containers: [], selected: '', operation: null, polling: false};
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
    engine:'mariadb', enabled:true, port:3306, timeout_seconds:1800, min_free_mib:1024, retention:'keep', databases:[],
  };
  const input = (key, type='text', extra='') => `<label class="form-label" for="db-${key}">${escHtml(dbT(key))}</label><input class="form-input" id="db-${key}" name="${key}" type="${type}" value="${escHtml(row[key] ?? '')}" ${extra}>`;
  panel.innerHTML = `<div class="settings-body">
    <p class="status-message info">${escHtml(dbT('managed'))}</p>
    <p>${escHtml(dbT('scope'))}</p><p>${escHtml(dbT('credentials'))}</p>
    <label class="form-label" for="db-select">${escHtml(dbT('profile'))}</label>
    <select class="form-select" id="db-select"><option value="">${escHtml(dbT('new'))}</option>${databaseState.profiles.map(p => `<option value="${escHtml(p.id)}" ${p.id === row.id ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('')}</select>
    <form id="database-form" class="database-form">
      <div class="form-group">${input('name','text','required maxlength="100"')}</div>
      <div class="form-group"><label class="form-label" for="db-engine">${escHtml(dbT('engine'))}</label><select class="form-select" id="db-engine" name="engine"><option value="mariadb">MariaDB</option><option value="postgresql">PostgreSQL</option></select></div>
      <div class="form-group">${input('container','text','required list="db-containers"')}<datalist id="db-containers">${databaseState.containers.map(p => `<option value="${escHtml(typeof p === 'string' ? p : p.name || p.Name || '')}"></option>`).join('')}</datalist></div>
      <div class="form-group">${input('execution_user')}</div>
      <div class="form-group">${input('database_user')}</div>
      <div class="form-group">${input('port','number','required min="1" max="65535"')}</div>
      <div class="form-group">${input('credential_file','text','required placeholder="/run/secrets/backup.cnf"')}</div>
      <div class="form-group"><label class="form-label" for="db-databases">${escHtml(dbT('databases'))}</label><textarea class="form-input" id="db-databases" name="databases" rows="3" required>${escHtml(row.databases.join('\n'))}</textarea></div>
      <p class="form-help">${escHtml(dbT('storageHint'))}</p>
      <div class="form-group">${input('staging_mount','text','required placeholder="/mnt/cache"')}</div>
      <div class="form-group">${input('staging_dir','text','required placeholder="/mnt/cache/borg-database-dumps"')}</div>
      <div class="form-group">${input('min_free_mib','number','required min="1" max="104857600"')}</div>
      <div class="form-group">${input('timeout_seconds','number','required min="1" max="86400"')}</div>
      <div class="form-group"><label class="form-label" for="db-retention">${escHtml(dbT('retention'))}</label><select class="form-select" id="db-retention" name="retention"><option value="keep">${escHtml(dbT('keep'))}</option><option value="after_archive">${escHtml(dbT('after_archive'))}</option></select></div>
      <div class="database-flags"><label><input type="checkbox" id="db-enabled" ${row.enabled ? 'checked' : ''}> ${escHtml(dbT('enabled'))}</label>
      <label><input type="checkbox" id="db-globals" ${row.include_globals ? 'checked' : ''}> ${escHtml(dbT('globals'))}</label></div>
      <p class="form-help">${escHtml(dbT('globalsHint'))}</p>
      <div class="job-script-actions"><button class="btn btn-primary" type="submit">${escHtml(dbT('save'))}</button>
        <button class="btn btn-danger" id="db-delete" type="button" ${row.id ? '' : 'disabled'}>${escHtml(dbT('delete'))}</button></div>
    </form>
    <p>${escHtml(dbT('savedActions'))}</p><div class="job-script-actions">${['check','dump','reconcile'].map(action => `<button class="btn btn-secondary" data-db-action="${action}" ${row.id && row.enabled ? '' : 'disabled'}>${escHtml(dbT(action))}</button>`).join('')}
      <button class="btn btn-secondary" id="db-cancel" ${databaseState.operation ? '' : 'disabled'}>${escHtml(dbT('cancel'))}</button></div>
    <p id="db-result" role="status" aria-live="polite"></p>
    <h3>${escHtml(dbT('runs'))}</h3><button class="btn btn-secondary" id="db-refresh">${escHtml(dbT('refresh'))}</button><div id="db-runs"></div>
  </div>`;
  document.getElementById('db-engine').value = row.engine;
  document.getElementById('db-retention').value = row.retention;
  settingsState.databaseDirty = false;
  const form = document.getElementById('database-form');
  form.addEventListener('input', () => { settingsState.databaseDirty = true; _updateUnsavedChangesUi(); });
  databaseEngineFields(row.engine);
  document.getElementById('db-engine').addEventListener('change', e => {
    databaseEngineFields(e.target.value);
    document.getElementById('db-port').value = e.target.value === 'postgresql' ? 5432 : 3306;
    document.getElementById('db-globals').checked = false;
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    if (row.id) body.id = row.id;
    body.databases = body.databases.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const k of ['port','timeout_seconds','min_free_mib']) body[k] = Number(body[k]);
    body.enabled = document.getElementById('db-enabled').checked;
    body.include_globals = document.getElementById('db-globals').checked;
    try {
      const data = await databaseRequest('', body);
      settingsState.databaseDirty = false;
      await loadDatabaseSettings(data.profile.id);
      databaseFeedback(dbT('saved'));
    } catch (err) { databaseFeedback(err.message); }
  });
  document.getElementById('db-select').addEventListener('change', e => {
    if (settingsState.databaseDirty && !window.confirm(dbT('discard'))) { e.target.value = databaseState.selected; return; }
    databaseState.selected = e.target.value; renderDatabaseSettings(); loadDatabaseRuns();
  });
  document.getElementById('db-delete').addEventListener('click', async () => {
    if (!window.confirm(dbT('confirmDelete'))) return;
    try { await databaseRequest(`?id=${encodeURIComponent(row.id)}`, {}, 'DELETE'); await loadDatabaseSettings(''); }
    catch (e) { databaseFeedback(e.message); }
  });
  panel.querySelectorAll('[data-db-action]').forEach(button => button.addEventListener('click', () => startDatabaseAction(row.id, button.dataset.dbAction)));
  document.getElementById('db-cancel').addEventListener('click', async () => {
    try { if (databaseState.operation) await databaseRequest('/cancel', {id:databaseState.operation}); databaseFeedback(dbT('cancelling')); }
    catch (e) { databaseFeedback(e.message); }
  });
  document.getElementById('db-refresh').addEventListener('click', loadDatabaseRuns);
  _updateUnsavedChangesUi();
}
/** Show only applicable engine options, retaining shared profile fields. */
function databaseEngineFields(engine) {
  const pg = engine === 'postgresql';
  const user = document.getElementById('db-database_user');
  user.closest('.form-group').classList.toggle('hidden', !pg);
  user.required = pg;
  document.getElementById('db-globals').closest('label').classList.toggle('hidden', !pg);
  document.getElementById('db-credential_file').placeholder = pg ? '/run/secrets/backup.pgpass' : '/run/secrets/backup.cnf';
}
function databaseFeedback(message) { const node = document.getElementById('db-result'); if (node) node.textContent = message; }

/** Start only saved profile operations; local cleanup always requires an explicit confirmation. */
async function startDatabaseAction(profile_id, action, directory) {
  if (settingsState.databaseDirty) { databaseFeedback(dbT('saveFirst')); return; }
  if (action === 'cleanup' && !window.confirm(dbT('confirmCleanup'))) return;
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
      if (status.status !== 'running') { databaseState.operation = null; await loadDatabaseRuns(); break; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch (e) { databaseFeedback(e.message); }
  finally { databaseState.polling = false; const b = document.getElementById('db-cancel'); if (b) b.disabled = !databaseState.operation; }
}

/** Show retained/orphaned exports and their owned cleanup action, never dump contents. */
async function loadDatabaseRuns() {
  const node = document.getElementById('db-runs'); if (!node) return;
  try {
    const data = await databaseRequest('/runs', undefined);
    node.innerHTML = data.runs.map((r,i) => `<div class="form-group"><strong>${escHtml(dbT(r.status))}</strong> · ${escHtml(settingsFmtBytes(r.bytes))}<br><code>${escHtml(r.directory)}</code><br>${escHtml(r.archived ? dbT('archived') : dbT('notArchived'))} <button class="btn btn-secondary" data-cleanup="${i}">${escHtml(dbT('cleanup'))}</button></div>`).join('') || `<p>${escHtml(dbT('noRuns'))}</p>`;
    for (const error of data.errors || []) { const p = document.createElement('p'); p.textContent = `${error.profile_id}: ${apiErrorMessage({code:error.error_code})}`; node.append(p); }
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
    wizardState.databaseProfiles = data.profiles;
    wizardState.databasesLoaded = true;
    wizardApplyDatabases([]);
  } catch (_) { if (request === wizardState.jobIdRequest) { wizardState.databasesLoaded = false; _wizardShowError(2, dbT('loadError')); } }
}
function wizardApplyDatabases(selected) {
  const node = document.getElementById('wiz-databases'); if (!node) return;
  const rows = [...(wizardState.databaseProfiles || [])];
  for (const id of selected) if (!rows.some(p => p.id === id)) rows.push({id,name:dbT('missing'),databases:[]});
  node.innerHTML = rows.map(p => `<label class="form-label"><input type="checkbox" value="${escHtml(p.id)}" ${selected.includes(p.id) ? 'checked' : ''}> ${escHtml(p.name)} · ${escHtml(p.engine || '')}: ${escHtml(p.databases.join(', '))}${p.enabled ? '' : ' ('+escHtml(dbT('missing'))+')'}${p.include_globals ? ' · '+escHtml(dbT('globals')) : ''}</label>`).join('') || `<p>${escHtml(dbT('noProfiles'))}</p>`;
}
