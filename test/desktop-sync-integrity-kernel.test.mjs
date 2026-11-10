// The Desktop's sync sheet explains E_PACKAGE_INTEGRITY truthfully for each case the REAL kernel refuses
// (oats-project/oats#1765). `oats sync` uses that one code for several causes and names the case in
// `details.why` (docs/packages.md, `oats sync`): a pin on a branch, a manifest naming another package id,
// a lock whose capabilities or souls were edited, and, with no `why`, a tag that moved. Each refusal is
// produced by the repository's kernel in a scratch deployment (test/helpers/v2-deployment.mjs), read the
// way the Desktop reads it (packages/client/workspace-cli.mjs, the exec owner that builds the argv and
// parses the envelope), then worded by the sheet's own reader (syncProblem). The kernel's raw envelope is
// asserted too, so each case means something on its own. Everything runs in mkdtemp directories with HOME,
// the remote cache and tmux isolated by the helper: never the operator's deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliWorkspace } from '../packages/client/workspace-cli.mjs';
import { syncProblem } from '../packages/desktop/renderer/workspace-sync-view.mjs';
import { DESKTOP_TERMS } from '../packages/desktop/renderer/desktop-terms.mjs';
import { v2Deployment, CLI } from './helpers/v2-deployment.mjs';
import { packageRepo } from './helpers/package-repo.mjs';

/** A deployment pinning each package repo at `at`; the repos are cleaned up with it. */
function deployment(t, packages, at = 'v1.0.0') {
  const fx = v2Deployment({ name: 'acme', souls: { dev: {} }, workspace: { packages: Object.fromEntries(Object.entries(packages).map(([id, pkg]) => [id, `${pkg.ref}@${at}`])) } });
  t.after(() => { fx.cleanup(); for (const pkg of Object.values(packages)) pkg.cleanup(); });
  const probe = fx.cli(['version', '--json']);
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  fx.probe = { ...JSON.parse(probe.stdout), ok: true, bin: CLI }; // what the Desktop's locator keeps for an accepted CLI
  fx.lockFile = join(fx.dep, 'oats-lock.json');
  return fx;
}

/** `oats sync` the Desktop's way → { reason (what the Desktop holds), kernel (the raw envelope's error) }. */
async function desktopSync(fx) {
  let stdout = '';
  const exec = (bin, argv, options, done) => execFile(bin, argv, { ...options, env: options.env ?? fx.env }, (error, out, err) => { stdout = out; done(error, out, err); });
  const result = await cliWorkspace(fx.probe, { action: 'sync', context: fx.dep }, DESKTOP_TERMS, { env: fx.env, exec });
  return { result, kernel: JSON.parse(stdout.trim().split('\n').pop()).error };
}

/** The refusal is E_PACKAGE_INTEGRITY with `why` as the kernel sent it, carried to the sheet, whose
 *  sentence matches `says`; the kernel's own message is the sheet's Details. */
async function assertSheet(fx, why, says) {
  const { result, kernel } = await desktopSync(fx);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(kernel.code, 'E_PACKAGE_INTEGRITY', JSON.stringify(kernel));
  assert.equal(kernel.details?.why, why, JSON.stringify(kernel));
  assert.equal(result.reason.code, 'E_PACKAGE_INTEGRITY');
  assert.equal(result.reason.why, why, JSON.stringify(result.reason));
  const problem = syncProblem(result.reason);
  assert.match(problem.text, says, problem.text);
  assert.equal(problem.detail, `E_PACKAGE_INTEGRITY · ${kernel.message.trim()}`);
  return problem;
}

const LOCK_EDITED = /^The lock’s record of a package doesn’t match what that package ships: the lock was edited\. Remove the package’s entry from the lock file, then sync again\.$/;

test('a pin on a branch: the sheet says the package is pinned to a branch', async (t) => {
  const fx = deployment(t, { 'acme.pkg': packageRepo({ id: 'acme.pkg' }) }, 'main');
  await assertSheet(fx, 'branch', /pinned to a branch.*Pin a tag or a full commit/);
});

test('a manifest naming another package id: the sheet says so, not a moved tag', async (t) => {
  const fx = deployment(t, { 'acme.tools': packageRepo({ id: 'acme.tools', manifest: { package: 'acme.tools-renamed' } }) });
  const problem = await assertSheet(fx, 'package-id', /manifest names a different package id/);
  assert.doesNotMatch(problem.text, /tag|branch/);
});

test('an edited lock (capabilities, souls) and a moved tag: each its own sentence', async (t) => {
  const pkg = packageRepo({ id: 'acme.pkg' });
  const fx = deployment(t, { 'acme.pkg': pkg });
  const synced = fx.cli(['sync', '--json']);
  assert.equal(synced.status, 0, synced.stdout + synced.stderr);
  const good = readFileSync(fx.lockFile, 'utf8');
  const edit = (change) => { const lock = JSON.parse(good); change(lock.packages['acme.pkg']); writeFileSync(fx.lockFile, JSON.stringify(lock, null, 2) + '\n'); };

  edit((entry) => { entry.capabilities = [...entry.capabilities, 'acme-extra']; });
  await assertSheet(fx, 'capabilities', LOCK_EDITED);

  edit((entry) => { assert.ok(entry.souls?.length, 'the package ships a soul'); entry.souls[0].digest = `sha256-${'0'.repeat(64)}`; });
  await assertSheet(fx, 'souls', LOCK_EDITED);

  // The tag moves under the locked version: the kernel names no `why`, so the sheet keeps the family's meaning.
  writeFileSync(fx.lockFile, good);
  pkg.release('1.0.0', { keeper: {} }, { force: true });
  const problem = await assertSheet(fx, undefined, /^A package doesn’t match what the workspace file or the lock records for it\./);
  assert.equal(Object.hasOwn((await desktopSync(fx)).result.reason, 'why'), false);
  assert.doesNotMatch(problem.text, /edited|branch|manifest/);
});
