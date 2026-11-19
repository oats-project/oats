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

test('main prints the notices on stderr once per launch, at module level, before the single-instance handoff', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(main, /^import \{ retiredSettingNotices \} from "\.\/retired-settings\.mjs";$/m);
  const call = /^for \(const line of retiredSettingNotices\(process\.env\)\) console\.error\(line\);$/gm;
  const calls = [...main.matchAll(call)];
  assert.equal(calls.length, 1, 'one call, at module level (no indentation): it runs once in every launch');
  assert.equal([...main.matchAll(/retiredSettingNotices\(/g)].length, 1, 'called nowhere else');
  const handoff = main.indexOf('const primaryInstance = startSingleInstance(app,');
  assert.ok(handoff > 0, 'main hands a repeated launch to the running instance here');
  assert.ok(calls[0].index < handoff, 'before the handoff: a launch made while the Desktop runs is told too');
});
