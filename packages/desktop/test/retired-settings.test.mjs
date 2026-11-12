import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retiredSettingNotices } from '../retired-settings.mjs';

const PORT_NOTICE = 'oats-desktop: OATS_DESKTOP_PORT is no longer used and is ignored: the backend listens on a private socket the app makes for it (see docs/desktop.md, Security posture)';

test('no retired setting in the environment: no notice', () => {
  assert.deepEqual(retiredSettingNotices({}), []);
});

test('OATS_DESKTOP_PORT set, to a port or empty: exactly the one notice', () => {
  assert.deepEqual(retiredSettingNotices({ OATS_DESKTOP_PORT: '4820' }), [PORT_NOTICE]);
  assert.deepEqual(retiredSettingNotices({ OATS_DESKTOP_PORT: '' }), [PORT_NOTICE]);
});

test('an unrelated variable: no notice', () => {
  assert.deepEqual(retiredSettingNotices({ OATS_DESKTOP_OATS_BIN: '/usr/local/bin/oats' }), []);
});
