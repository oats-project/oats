// Kernel-owned lifecycle contract: package-specific suites may be retired,
// but these real paths keep the documented hook outcome vocabulary pinned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { v2Deployment } from './helpers/v2-deployment.mjs';
const CAP = 'test.cleanup';
const outcomes = [
  { retired: false, reason: 'nothing-to-delete' },
  { retired: false, reason: 'nothing-to-revoke' },
  { retired: false, reason: 'service-unavailable' },
  { retired: false },
  { retired: true },
  {},
];
function fixture(t, rollback) {
  const hook = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const config = JSON.parse(readFileSync(join(process.env.OATS_ROOT, 'answer.json'), 'utf8'));
if (process.env.OATS_EVENT === 'spawn') {
  console.log(JSON.stringify({meta:{created:true}}));
  process.exit(config.failSpawn ? 1 : 0);
}
console.log(JSON.stringify({meta:config.meta}));`;
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: 'directory', capabilities: { [CAP]: { from: 'here' } } } } },
    capabilities: { [CAP]: { manifest: { hooks: { ...(rollback ? { spawn: { command: 'hook.mjs', required: true } } : {}), retire: 'hook.mjs' } }, files: { 'hook.mjs': hook } } },
  });
  const set = meta => writeFileSync(join(fx.root, 'answer.json'), JSON.stringify({ meta, failSpawn: rollback }));
  const spawn = async name => {
    const before = process.env.PATH; process.env.PATH = fx.env.PATH;
    try { return await fx.inEnv(() => fx.spawn('dev', { name })); }
    finally { process.env.PATH = before; }
  };
  return { fx, set, spawn };
}
for (const rollback of [false, true]) test(`hook cleanup contract through ${rollback ? 'spawn rollback' : 'ordinary retire'} and quarantine retry`, async t => {
  const { fx, set, spawn } = fixture(t, rollback);
  for (const [index, meta] of outcomes.entries()) {
    const complete = meta.retired !== false || meta.reason === 'nothing-to-delete';
    const name = `case-${index}`, home = join(fx.root, 'dev', 'instances', name);
    set(meta);
    if (rollback) await assert.rejects(spawn(name), e => e.code === 'E_REQUIRED_HOOK_FAILED');
    else {
      await spawn(name);
      const r = fx.cli(['retire', name, '--json']);
      assert.equal(r.status, complete ? 0 : 1, r.stdout + r.stderr);
    }
    assert.equal(existsSync(home), !complete, JSON.stringify(meta));
    if (complete) continue;
    const marker = join(home, '.oats-rollback-incomplete.json');
    const debt = () => JSON.parse(readFileSync(marker, 'utf8')).cleanup.outstanding.hooks;
    assert.deepEqual(debt(), [CAP], 'incomplete outcomes record outstanding hook debt');
    let retry = fx.cli(['retire', name, '--json']);
    assert.equal(retry.status, 1, retry.stdout + retry.stderr);
    assert.equal(existsSync(home), true);
    assert.deepEqual(debt(), [CAP], 'retry keeps uncompleted hook debt');
    set({ retired: false, reason: 'nothing-to-delete' });
    retry = fx.cli(['retire', name, '--json']);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(existsSync(home), false, 'documented nothing-to-delete clears debt and removes the home');
  }
});
