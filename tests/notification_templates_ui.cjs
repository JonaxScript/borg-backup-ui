const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const failedExample = {
  title: 'Borg Backup UI: Backup failed',
  message: 'Job: Appdata\nResult: Error',
  values: {job: 'Appdata', error: 'Repository could not be opened', archive: '', default_message: 'Job: Appdata\nResult: Error'},
};
const config = {
  events: ['backup_success', 'backup_failed'],
  placeholders: ['job', 'error', 'default_message'],
  limits: {title: 200, message: 2000},
  readable: true,
  templates: {
    backup_success: {title: '', message: ''},
    backup_failed: {title: '<b>{job}</b> failed', message: 'Error: {error}'},
  },
  examples: {
    backup_success: {title: 'Borg Backup UI: Backup successful', message: 'Job: Appdata\nResult: Successful', values: {job: 'Appdata'}},
    backup_failed: failedExample,
  },
};

function loadSettings(language) {
  const labels = JSON.parse(fs.readFileSync(`ui/i18n/${language}.json`, 'utf8'));
  const translate = (key, params = {}) => {
    const text = key.split('.').reduce((value, part) => value?.[part], labels);
    if (typeof text !== 'string') return key;
    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
  const context = vm.createContext({
    window: {BBUI: {api: {_fetch401Wrapped: true}, components: {i18n: {t: translate}}}, addEventListener() {}},
    document: {addEventListener() {}, getElementById: () => null},
    escHtml: (value) => (value ? String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''),
    locationIcon: () => '',
  });
  vm.runInContext(fs.readFileSync('ui/js/api/client.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('ui/js/pages/settings.js', 'utf8'), context);
  return {context, translate, state: context.window.BBUI.settingsState};
}

function fakeRow(event, title, message) {
  const fields = {title: {value: title}, message: {value: message}};
  const preview = {title: {textContent: ''}, message: {textContent: ''}};
  const classes = new Set();
  const badge = {textContent: '', classList: {toggle: (name, on) => (on ? classes.add(name) : classes.delete(name))}};
  const selectors = {
    '[data-notification-template-field="title"]': fields.title,
    '[data-notification-template-field="message"]': fields.message,
    '[data-notification-template-preview="title"]': preview.title,
    '[data-notification-template-preview="message"]': preview.message,
    '[data-notification-template-state]': badge,
  };
  const row = {
    dataset: {notificationTemplateEvent: event},
    querySelector: (selector) => selectors[selector] || null,
    querySelectorAll: (selector) => (selector === '[data-notification-template-field]' ? [fields.title, fields.message] : []),
  };
  fields.title.closest = () => row;
  fields.message.closest = () => row;
  return {row, fields, preview, badge, classes, button: {closest: () => row}};
}

for (const language of ['de', 'en']) {
  test(`notification text card renders translated, escaped rows (${language})`, () => {
    const {context, translate} = loadSettings(language);
    const html = context.renderSettingsNotificationTemplates(config);

    assert.ok(html.includes('data-notification-templates="ready"'));
    assert.ok(html.includes(translate('settings.notificationTemplates.title')));
    assert.ok(html.includes(translate('settings.forms.notifyEventBackupFailed')));
    assert.ok(html.includes(`<code>{job}</code></dt><dd>${translate('settings.notificationTemplates.placeholders.job')}`));
    assert.ok(!html.includes('settings.notificationTemplates.'), 'untranslated key');
    assert.ok(html.includes('data-notification-template-event="backup_failed" open'));
    assert.ok(html.includes('data-notification-template-event="backup_success" >'));
    assert.ok(html.includes('value="&lt;b&gt;{job}&lt;/b&gt; failed"'));
    assert.ok(html.includes('>&lt;b&gt;Appdata&lt;/b&gt; failed</strong>'));
    assert.ok(html.includes('placeholder="Job: Appdata\nResult: Error"'));
    assert.ok(html.includes('maxlength="200"') && html.includes('maxlength="2000"'));
    assert.ok(!html.includes(' disabled'));

    const unreadable = context.renderSettingsNotificationTemplates({...config, readable: false});
    assert.ok(unreadable.includes('data-notification-templates="unreadable"'));
    assert.ok(unreadable.includes(translate('settings.notificationTemplates.unreadable')));
    assert.equal((unreadable.match(/ disabled/g) || []).length, config.events.length * 3);
  });
}

test('preview renders placeholders once and falls back to the default text', () => {
  const {context} = loadSettings('en');
  const preview = (title, message) => {
    const result = context._notificationTemplatePreview(failedExample, title, message);
    return [result.title, result.message];
  };

  assert.deepEqual(preview('', ''), [failedExample.title, failedExample.message]);
  assert.deepEqual(preview(' {job}: {default_message} ', '{error} {unknown}\n'), [
    'Appdata: Job: Appdata Result: Error',
    'Repository could not be opened {unknown}',
  ]);
  assert.deepEqual(preview('{archive}', '  '), [failedExample.title, failedExample.message]);
  assert.equal(context._renderNotificationTemplateText('{job}', {job: '{error}', error: 'x'}), '{error}');
});

test('editing, resetting and collecting texts keep the notifications tab consistent', () => {
  const {context, translate, state} = loadSettings('en');
  state.data = {notification_templates: config};
  const edited = fakeRow('backup_failed', '{job} failed', '');

  context.onNotificationTemplateInput(edited.fields.title);
  assert.equal(edited.preview.title.textContent, 'Appdata failed');
  assert.equal(edited.preview.message.textContent, failedExample.message);
  assert.ok(edited.classes.has('is-custom'));
  assert.equal(edited.badge.textContent, translate('settings.notificationTemplates.custom'));
  assert.equal(state.dirty, true);

  context.resetNotificationTemplate(edited.button);
  assert.equal(edited.fields.title.value, '');
  assert.equal(edited.preview.title.textContent, failedExample.title);
  assert.ok(!edited.classes.has('is-custom'));
  assert.equal(edited.badge.textContent, translate('settings.notificationTemplates.default'));

  const rows = [fakeRow('backup_success', 'A', '').row, fakeRow('backup_failed', '', 'B').row];
  const panel = (attribute) => ({
    querySelector: (selector) => (selector === `[data-notification-templates="${attribute}"]` && attribute === 'ready'
      ? {querySelectorAll: () => rows}
      : null),
  });
  assert.equal(
    JSON.stringify(context.collectNotificationTemplates(panel('ready'))),
    JSON.stringify({backup_success: {title: 'A', message: ''}, backup_failed: {title: '', message: 'B'}}),
  );
  assert.equal(context.collectNotificationTemplates(panel('unreadable')), null);
  assert.equal(context.collectNotificationTemplates(null), null);
});
