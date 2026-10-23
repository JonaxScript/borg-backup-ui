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
  const preview = {title: {innerHTML: ''}, message: {innerHTML: ''}};
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
    assert.ok(html.includes('<code>{job}</code>'));
    assert.ok(html.includes(translate('settings.notificationTemplates.placeholders.job')));
    assert.ok(!html.includes('settings.notificationTemplates.'), 'untranslated key');
    assert.ok(html.includes('data-notification-template-event="backup_failed" hidden'));
    assert.ok(html.includes('data-notification-event="backup_success" aria-pressed="true"'));
    assert.ok(html.includes('value="&lt;b&gt;{job}&lt;/b&gt; failed"'));
    assert.ok(html.includes('&lt;b&gt;<mark>Appdata</mark>&lt;/b&gt; failed'));
    assert.ok(html.includes('placeholder="{default_message}"'));
    assert.ok(html.includes('>Job: {job}\n'));
    assert.ok(!html.includes('placeholder="Job: Appdata'));
    assert.ok(html.includes('maxlength="200"') && html.includes('maxlength="2000"'));
    assert.ok(!html.includes(' disabled'));

    const unreadable = context.renderSettingsNotificationTemplates({...config, readable: false});
    assert.ok(unreadable.includes('data-notification-templates="unreadable"'));
    assert.ok(unreadable.includes(translate('settings.notificationTemplates.unreadable')));
    assert.equal((unreadable.match(/ disabled/g) || []).length, config.events.length * 4 + config.placeholders.length + 1);
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
  assert.equal(edited.preview.title.innerHTML, '<mark>Appdata</mark> failed');
  assert.equal(edited.preview.message.innerHTML, failedExample.message);
  assert.ok(edited.classes.has('is-custom'));
  assert.equal(edited.badge.textContent, translate('settings.notificationTemplates.custom'));
  assert.equal(state.dirty, true);

  context.resetNotificationTemplate(edited.button);
  assert.equal(edited.fields.title.value, '');
  assert.equal(edited.preview.title.innerHTML, failedExample.title);
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
    JSON.stringify({backup_success: {title: 'A', message: '{default_message}'}, backup_failed: {title: '{default_title}', message: 'B'}}),
  );
  assert.equal(context.collectNotificationTemplates(panel('unreadable')), null);
  assert.equal(context.collectNotificationTemplates(null), null);
});

for (const language of ['de', 'en']) {
  test(`all event examples contain tokens and no sample backup data (${language})`, () => {
    const {context} = loadSettings(language);
    for (const event of ['backup_success', 'backup_warning', 'backup_failed', 'backup_skipped', 'backup_overdue']) {
      const example = context._notificationTemplateExample(event);
      assert.ok(example.title.includes('{job}'));
      for (const token of ['job', 'target', 'repository', 'status', 'duration', 'time']) {
        assert.ok(example.message.includes(`{${token}}`));
      }
      assert.equal(example.message.includes('{error}'), event !== 'backup_success');
      assert.equal(example.message.includes('{archive}'), ['backup_success', 'backup_warning'].includes(event));
      assert.ok(!/Appdata|backup_usb|2026-|settings\./.test(example.title + example.message));
    }
  });
}

function plainPreview(html) {
  return html.replace(/<\/?mark>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

test('highlighted previews escape every source and match plain delivery formatting', () => {
  const {context} = loadSettings('en');
  const example = {...failedExample, values: {...failedExample.values, job: '<img src=x onerror=alert(1)> {error}', error: ' \r\n First \u2028 Second\n '}};
  for (const text of ['  <b>{job}</b> {unknown} ', '{error}', '{archive}', '  ', '{error}\r\n\r\n{job}', '{job}{error} tail', '\x85\x1c']) {
    for (const field of ['title', 'message']) {
      const html = context._notificationTemplatePreviewHtml(example, text, field);
      assert.equal(plainPreview(html), context._notificationTemplatePreview(example, text, text)[field]);
      assert.ok(!/<(?:img|b|script)\b/.test(html));
    }
  }
  assert.ok(context._notificationTemplatePreviewHtml(example, '{job}', 'message').includes('{error}'), 'inserted tokens must not recurse');
});

test('drafts survive a redraw and resetting changes only the selected event', () => {
  const {context, state} = loadSettings('en');
  state.data = {notification_templates: config};
  const failed = fakeRow('backup_failed', 'Edited {job}', 'Draft');
  context.onNotificationTemplateInput(failed.fields.title);
  assert.ok(context.renderSettingsNotificationTemplates(config).includes('value="Edited {job}"'));
  const success = fakeRow('backup_success', 'Keep this', 'Keep message');
  context.onNotificationTemplateInput(success.fields.title);
  context.resetNotificationTemplate(failed.button);
  assert.equal(state.notificationTemplateDrafts.backup_failed.title, '');
  assert.equal(state.notificationTemplateDrafts.backup_success.title, 'Keep this');
  assert.equal(state.notificationTemplateDrafts.backup_success.message, 'Keep message');
});

test('central reference uses current event values and never renders sample HTML', () => {
  const {context, state} = loadSettings('en');
  state.notificationTemplateShowAll = true;
  const source = {...config, examples: {...config.examples, backup_failed: {...failedExample, values: {...failedExample.values, job: '<b>Appdata</b>'}}}};
  const html = context._notificationTemplateReferenceRows(source, 'backup_failed', true);
  assert.ok(html.includes('&lt;b&gt;Appdata&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Appdata</b>'));
  assert.ok(html.includes('Repository could not be opened'));
});

test('event selection retains hidden inputs; insertion respects selection and maxlength', () => {
  const {context, state} = loadSettings('en');
  state.data = {notification_templates: config};
  const success = fakeRow('backup_success', 'Success draft', 'Kept');
  const failed = fakeRow('backup_failed', 'Failed draft', 'xx');
  const rows = [success.row, failed.row];
  const destination = {value: 'message'}, feedback = {textContent: ''}, reference = {innerHTML: ''};
  const choices = config.events.map(event => ({dataset: {notificationEvent: event}, setAttribute(name, value) {this[name] = value;}}));
  const root = {
    dataset: {notificationTemplates: 'ready', notificationActive: 'backup_success'},
    querySelectorAll: selector => selector === '[data-notification-template-event]' ? rows : choices,
    querySelector: selector => ({'[data-notification-destination]': destination, '[data-notification-reference-feedback]': feedback, '[data-notification-reference]': reference}[selector]),
  };
  const button = {dataset: {notificationEvent: 'backup_failed', notificationToken: 'job'}, closest: () => root};
  state.dirty = false;
  context.handleNotificationTemplateAction(button, 'notification-template-select');
  assert.equal(success.row.hidden, true);
  assert.equal(failed.row.hidden, false);
  assert.equal(success.fields.title.value, 'Success draft');
  assert.equal(state.dirty, false, 'selection alone does not change settings');
  const field = failed.fields.message;
  Object.assign(field, {selectionStart: 0, selectionEnd: 2, maxLength: 5, focus() {}, setRangeText(value, start, end) {this.value = this.value.slice(0, start) + value + this.value.slice(end);}});
  context.handleNotificationTemplateAction(button, 'notification-template-insert');
  assert.equal(field.value, '{job}');
  assert.equal(state.dirty, true);
  field.selectionStart = field.selectionEnd = 5;
  context.handleNotificationTemplateAction(button, 'notification-template-insert');
  assert.equal(field.value, '{job}', 'insertion must not silently truncate existing content');
  assert.ok(feedback.textContent.includes('5'));
  root.dataset.notificationTemplates = 'unreadable';
  context.handleNotificationTemplateAction(button, 'notification-template-example');
  assert.equal(field.value, '{job}', 'unreadable stores remain protected');
});

for (const language of ['de', 'en']) {
  test(`initial templates and previews share the actual title and message (${language})`, () => {
    const {context, state} = loadSettings(language);
    const events = ['backup_success', 'backup_warning', 'backup_failed', 'backup_skipped', 'backup_overdue'];
    const values = {job: 'Appdata', target: 'USB / borg-appdata', repository: '/mnt/backup',
      status: 'Warning', error: 'Repository could not be opened', duration: '12 min 34 sec',
      time: '2026-07-01 03:12', archive: 'appdata-archive'};
    const source = {...config, events, templates: {}};
    const before = JSON.stringify(source);
    for (const event of events) {
      const texts = context._notificationTemplateEditorValues(event, source, true);
      assert.ok(texts.title.endsWith(': {job}'));
      const preview = context._notificationTemplatePreview({values}, texts.title, texts.message);
      assert.equal(preview.title, texts.title.replace('{job}', 'Appdata'));
      assert.equal(preview.message, texts.message.replace(/\{([a-z_]+)\}/g, (_, key) => values[key]));
      assert.ok(preview.message.includes(language === 'de' ? 'Ergebnis: Warning' : 'Result: Warning'));
      if (event !== 'backup_success') assert.ok(preview.message.includes('Repository could not be opened'));
      assert.equal(context._notificationTemplateState(event, texts.title, texts.message), 'example');
    }
    assert.equal(JSON.stringify(source), before, 'opening the editor must not change stored settings');
    assert.ok(!state.dirty, 'showing starter examples must not dirty unrelated settings tabs');
  });
}

test('saved texts, partial defaults and cleared drafts are never translated or replaced', () => {
  for (const language of ['de', 'en']) {
    const {context, state} = loadSettings(language);
    const saved = {title: 'Mein Backup: {job}', message: 'Custom error: {error}'};
    const source = {...config, templates: {backup_success: saved, backup_failed: {title: 'Custom', message: ''}}};
    assert.equal(JSON.stringify(context._notificationTemplateEditorValues('backup_success', source, true)), JSON.stringify(saved));
    assert.equal(context._notificationTemplateEditorValues('backup_failed', source, true).message, '');
    state.notificationTemplateDrafts = {backup_success: {title: '', message: ''}};
    assert.equal(context._notificationTemplateEditorValues('backup_success', source, true).title, '');
    assert.equal(context._notificationTemplateEditorValues('backup_success', source, false).title, '');
    const fallback = {title: '{default_title}', message: '{default_message}'};
    state.notificationTemplateDrafts = {};
    source.templates.backup_success = fallback;
    assert.equal(JSON.stringify(context._notificationTemplateEditorValues('backup_success', source, true)), JSON.stringify(fallback));
    assert.equal(context._notificationTemplateState('backup_success', fallback.title, fallback.message), 'default');
  }
});
