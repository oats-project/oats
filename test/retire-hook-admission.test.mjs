import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  'malformed-runtime': meta => { meta.capabilityRuntime = [null]; },
  legacy: meta => { delete meta.capabilityRuntime; },
  captured: meta => { meta.captured = { hookOrder: ['test.identity'] }; meta.capabilityMeta = { 'test.identity': {} }; },
  'captured-unknown': meta => { meta.captured = {}; },
  'captured-intent': meta => { meta.captured = { hookOrder: [], hookIntents: { 'test.identity': { state: 'unconfirmed' } } }; meta.capabilityMeta = {}; },
  'captured-failure': meta => { meta.captured = { hookOrder: [], hookFailures: [{ capability: 'test.identity', unconfirmed: true }] }; meta.capabilityMeta = {}; },
  'captured-lifecycle': meta => { meta.captured = { hookOrder: [], lifecycle: 'spawn-failed-cleanup-required' }; meta.capabilityMeta = {}; },
  'captured-contradicted': meta => { meta.captured = { hookOrder: [], lifecycle: 'spawn-failed-cleanup-required', hookFailures: [{ capability: 'test.identity', unconfirmed: true }], hookIntents: { 'test.identity': { state: 'unconfirmed' } } }; meta.capabilityMeta = {}; },
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
      if (['captured', 'captured-intent', 'captured-failure', 'captured-contradicted', 'missing-context'].includes(name)) assert.match(error.message, /test.identity/);
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
      if (!flags.length) assert.equal(error.details.reached.sessionStopAttempted, false);
    }
  }
});
test('positive record proof permits hookless retirement; force preserves cleanup warnings', async t => {
  const fx = v2Deployment({ t });
  for (const [name, mutate, forced] of [
    ['no-retire-hooks', m => { m.capabilityRuntime = []; }, false],
    ['captured-no-spawn', m => { m.captured = { hookOrder: [] }; m.capabilityMeta = {}; }, false],
    ['captured-empty-evidence', m => { m.captured = { hookOrder: [], hookIntents: {}, hookFailures: [], lifecycle: 'spawned-launch-pending' }; m.capabilityMeta = {}; }, false],
    ['forced-contradicted', cases['captured-contradicted'], true],
    ['forced-missing-context', m => { delete m.repo; m.capabilityRuntime = [{ id: 'test.identity', hooks: { retire: 'hook.mjs' } }]; }, true],
    ['forced-malformed', m => { m.capabilityRuntime = [null]; }, true],
    ['forced-malformed-hook', m => { m.capabilityRuntime = [{ id: 'test.identity', hooks: { retire: null } }]; }, true],
    ['forced-legacy', m => { delete m.capabilityRuntime; }, true],
    ['forced-captured', m => { m.captured = { hookOrder: ['test.identity'] }; m.capabilityMeta = { 'test.identity': {} }; }, true],
  ]) {
    const { home } = await spawn(fx, name); const file = join(home, 'instance.json'), meta = read(file);
    mutate(meta); writeFileSync(file, JSON.stringify(meta));
    const r = fx.cli(['retire', name, '--json', ...(forced ? ['--force'] : [])]);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(existsSync(home), false);
    if (name === 'captured-no-spawn' || name === 'captured-empty-evidence') assert.doesNotMatch((JSON.parse(r.stdout).warnings || []).join('\n'), /captured home: no retire hook ran|not revoked/);
    if (name.startsWith('forced-malformed')) {
      assert.match(JSON.parse(r.stdout).warnings.join('\n'), /recorded capability hooks cannot be identified/);
      assert.doesNotMatch(JSON.parse(r.stdout).warnings.join('\n'), /earlier kernel spawned it/);
    }
    if (forced) assert.match(JSON.parse(r.stdout).warnings.join('\n'), /no retire hook ran|retire hook did NOT run/);
    if (['forced-captured', 'forced-missing-context', 'forced-contradicted'].includes(name)) assert.match(JSON.parse(r.stdout).warnings.join('\n'), /test.identity.*not revoked/);
  }
});

test('forced self retirement carries admission authority through the detached completion', async t => {
  const { retireInstance, retirePendingMarkerPath, deferredRetireResultPath } = await import('../lib/core.mjs');
  const { waitUntil, killAndReap } = await import('./helpers/host-fixture.mjs');
  const { processLiveness, processStartToken } = await import('../lib/worktree-hooks.mjs');
  const fx = v2Deployment({ t });
  for (const kind of ['legacy', 'captured']) {
    const name = `self-${kind}`, { home } = await spawn(fx, name);
    const file = join(home, 'instance.json'), meta = read(file); cases[kind](meta); writeFileSync(file, JSON.stringify(meta));
    await fx.inEnv(async () => {
      assert.throws(() => retireInstance(fx.root, name, { self: true, selfKillDelaySec: 0 }), e => e.code === 'E_UNIDENTIFIED_INSTANCE_HOME');
      assert.equal(existsSync(retirePendingMarkerPath(home)), false, 'unforced self retirement schedules nothing');
      const scheduled = retireInstance(fx.root, name, { self: true, force: true, selfKillDelaySec: 0 });
      assert.equal(scheduled.deferred, true);
      const completion = { pid: scheduled.completionPid, processStart: processStartToken(scheduled.completionPid) };
      try {
        await waitUntil(() => (existsSync(deferredRetireResultPath(home)) || !existsSync(home)) && processLiveness(completion).state === 'gone', 'the private deferred retirement to finish', 60000);
        assert.equal(existsSync(deferredRetireResultPath(home)), false, existsSync(deferredRetireResultPath(home)) ? JSON.stringify(read(deferredRetireResultPath(home))) : 'successful completion leaves no failure record');
        assert.equal(existsSync(home), false, 'the detached completion removed the forced home');
      } finally {
        if (processLiveness(completion).state === 'alive') await killAndReap(completion.pid);
      }
    });
  }
});


test('an unusable directory-spawn marker still reports live or unknown spawn liveness first', async t => {
  const { processStartToken } = await import('../lib/worktree-hooks.mjs');
  const fx = v2Deployment({ t });
  for (const known of [true, false]) {
    const name = known ? 'spawning' : 'spawn-unknown', { home } = await spawn(fx, name);
    const marker = join(home, '.oats-rollback-incomplete.json');
    const inProgress = { pid: process.pid, processStart: known ? processStartToken(process.pid) : null, startedAt: new Date().toISOString() };
    writeFileSync(marker, JSON.stringify({ inProgress, cleanup: { version: 1, repo: fx.dep, work: 'directory', capabilityRuntime: [], outstanding: { hooks: [], git: [] } } }));
    for (const flags of [['--plan'], [], ...(known ? [['--force'], ['--plan', '--force']] : [])]) {
      const r = fx.cli(['retire', name, '--json', ...flags]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.equal(r.json().error.code, 'E_LIFECYCLE_BUSY', r.stdout);
      assert.match(r.json().error.message, known ? /still being spawned/ : /whether its spawn.*still runs cannot be read/);
      assert.equal(existsSync(home), true);
      assert.deepEqual(read(marker).inProgress, inProgress);
    }
  }
});


test('core forwards the admission readers and constants by reference without extending its API', async () => {
  const core = await import('../lib/core.mjs'), leaf = await import('../lib/retire-admission.mjs');
  for (const key of ['identifiedHomeRecord', 'capturedHomeCapabilities', 'WORK_MODES', 'QUARANTINE_CLEANUP_VERSION', 'QUARANTINE_GIT_DEBT']) assert.equal(core[key], leaf[key], key);
  assert.equal(Object.hasOwn(core, 'retireCleanupAdmission'), false);
});


test('a Git-derived own-tree repository admits cleanup and is the retire hook context without rewriting the record', async t => {
  const cap = 'test.repo-context';
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: 'worktree', capabilities: { [cap]: { from: 'here' } } } } },
    capabilities: { [cap]: { manifest: { hooks: { retire: 'retire.mjs' } }, files: {
      'retire.mjs': `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(join(process.env.OATS_ROOT, 'hook-context.json'), JSON.stringify({ context: process.env.OATS_CONTEXT, homeThere: existsSync(home), record: JSON.parse(readFileSync(join(home, 'instance.json'), 'utf8')) }));
console.log(JSON.stringify({ meta: { retired: true } }));
`,
    } } },
  });
  const name = 'derived-repo', { home } = await spawn(fx, name);
  const file = join(home, 'instance.json'), meta = read(file);
  assert.equal(meta.work, 'worktree');
  assert.equal(meta.capabilityRuntime[0].id, cap);
  assert.equal(meta.capabilityRuntime[0].hooks.retire, `node '${join(home, '.oats', 'modules', cap, 'retire.mjs')}'`);
  delete meta.repo;
  const bytes = JSON.stringify(meta);
  writeFileSync(file, bytes);
  const witness = join(fx.root, 'hook-context.json');
  const planned = fx.cli(['retire', name, '--plan', '--json']);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = planned.json().result, repo = realpathSync(fx.member);
  assert.equal(plan.facts.repo, null, 'the plan keeps the recorded repository fact');
  assert.equal(plan.facts.ownWorktree, true);
  assert.ok(plan.notes.includes(`the record names no repository for the work tree: the retire uses the one Git names for it, ${repo}, and does not write it into the record`));
  assert.equal(readFileSync(file, 'utf8'), bytes, 'planning does not rewrite the record');
  assert.equal(existsSync(witness), false, 'planning runs no hook');
  const applied = fx.cli(['retire', name, '--plan-revision', plan.planRevision, '--idempotency-key', 'derived-repo-retire', '--json']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const ran = read(witness);
  assert.equal(ran.context, repo, 'apply runs cleanup in the same repository admission accepted');
  assert.equal(ran.homeThere, true, 'the hook runs before removal');
  assert.deepEqual(ran.record, meta, 'apply does not rewrite the record before cleanup');
  assert.equal(JSON.parse(applied.stdout).retired, name);
  assert.equal(existsSync(home), false);
});
