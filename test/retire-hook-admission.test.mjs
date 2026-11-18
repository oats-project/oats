import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { v2Deployment } from './helpers/v2-deployment.mjs';
import { createLifecycleBoundary } from '../packages/client/instance-lifecycle.mjs';
import { unavailableView } from '../packages/client/lifecycle-confirmation.mjs';
import { DESKTOP_TERMS } from '../packages/desktop/renderer/desktop-terms.mjs';
import { context, request } from '../packages/desktop/test/helpers/lifecycle-fixture.mjs';
const read = path => JSON.parse(readFileSync(path, 'utf8'));
async function spawn(fx, name, extra = {}) {
  const prior = process.env.PATH; process.env.PATH = fx.env.PATH;
  try { return await fx.inEnv(() => fx.spawn('dev', { name, ...extra })); }
  finally { process.env.PATH = prior; }
}
const cases = {
  legacy: meta => { delete meta.capabilityRuntime; },
  captured: meta => { meta.captured = { hookOrder: ['test.identity'] }; meta.capabilityMeta = { 'test.identity': {} }; },
  'captured-unknown': meta => { meta.captured = {}; },
  'missing-context': meta => { delete meta.repo; meta.capabilityRuntime = [{ id: 'test.identity', hooks: { retire: 'hook.mjs' } }]; },
};
test('unrunnable retire hooks refuse plan and apply before children, hooks or removal', async t => {
  const fx = v2Deployment({ t });
  for (const [name, mutate] of Object.entries(cases)) {
    const { home } = await spawn(fx, name);
    const child = await spawn(fx, `${name}-child`, { relativeTo: name, relation: 'child' });
    const childClaim = join(dirname(child.home), '.oats-retirement', 'claims', `${name}-child.lock`);
    mkdirSync(dirname(childClaim), { recursive: true }); writeFileSync(childClaim, 'unreadable claim');
    const file = join(home, 'instance.json'), meta = read(file); mutate(meta); writeFileSync(file, JSON.stringify(meta));
    for (const flags of [['--plan'], []]) {
      const r = fx.cli(['retire', name, '--json', ...flags]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const error = r.json().error;
      assert.equal(error.code, 'E_UNIDENTIFIED_INSTANCE_HOME', r.stdout);
      assert.match(error.message, /identit|membership/);
      assert.match(error.message, /--force/);
      assert.match(error.message, /[Nn]othing was stopped, run or removed/);
      if (name === 'captured' || name === 'missing-context') assert.match(error.message, /test.identity/);
      assert.equal(existsSync(home), true); assert.equal(existsSync(child.home), true);
      assert.equal(readFileSync(childClaim, 'utf8'), 'unreadable claim');
      if (flags.length) {
        const boundary = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: async () => ({ ...r.json(), origin: 'kernel' }) });
        const ctx = context(), shown = await boundary(request('retire'), () => ctx);
        assert.equal(shown.status, 'unavailable');
        assert.equal(shown.reason.code, 'E_UNIDENTIFIED_INSTANCE_HOME');
        assert.match(shown.reason.detail, /--force/);
        const view = unavailableView(shown.reason, { target: ctx.instances[0], operation: 'retire' }, DESKTOP_TERMS);
        assert.ok(view.blocks.some(block => block.type === 'details' && /--force/.test(block.reason.detail)), 'Desktop Remove renders the refusal and remedy in Details');
      }
      if (error.details?.reached) assert.equal(error.details.reached.sessionStopAttempted, false);
    }
  }
});
test('positive record proof permits hookless retirement; force preserves cleanup warnings', async t => {
  const fx = v2Deployment({ t });
  for (const [name, mutate, forced] of [
    ['no-retire-hooks', m => { m.capabilityRuntime = []; }, false],
    ['captured-no-spawn', m => { m.captured = { hookOrder: [] }; m.capabilityMeta = {}; }, false],
    ['forced-legacy', m => { delete m.capabilityRuntime; }, true],
    ['forced-captured', m => { m.captured = { hookOrder: ['test.identity'] }; m.capabilityMeta = { 'test.identity': {} }; }, true],
  ]) {
    const { home } = await spawn(fx, name); const file = join(home, 'instance.json'), meta = read(file);
    mutate(meta); writeFileSync(file, JSON.stringify(meta));
    const r = fx.cli(['retire', name, '--json', ...(forced ? ['--force'] : [])]);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(existsSync(home), false);
    if (forced) assert.match(JSON.parse(r.stdout).warnings.join('\n'), /no retire hook ran|retire hook did NOT run/);
    if (name === 'forced-captured') assert.match(JSON.parse(r.stdout).warnings.join('\n'), /test.identity.*not revoked/);
  }
});
