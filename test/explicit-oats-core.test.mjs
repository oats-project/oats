import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retireInstance, fingerprintTree } from '../lib/core.mjs';
import { killGroup } from '../lib/process-group.mjs';
import { CLI, git as gitIn, v2Deployment } from './helpers/v2-deployment.mjs';

// Every spawn here is a workspace-model spawn (test/helpers/v2-deployment.mjs). An
// in-process spawn reads process.env, so for the test's duration it gets the
// fixture's HOME, remote cache, PATH and tmux session, and no ambient instance identity.
const ISOLATED = ['HOME', 'OATS_HOME_DIR', 'OATS_REMOTE_CACHE', 'PATH', 'OATS_TMUX_SESSION', 'PI_AGENTS_TMUX_SESSION'];
const IDENTITY = ['OATS_INSTANCE', 'OATS_INSTANCE_HOME', 'OATS_HOME', 'OATS_AGENT', 'OATS_SOUL', 'OATS_ROOT', 'OATS_CONTEXT', 'OATS_WORKSPACE', 'PI_AGENT_INSTANCE', 'PI_AGENT_HOME', 'PI_AGENTS_ROOT'];
/** A deployment for this test, plus `bin` (the test's fakes, first on PATH) and CLI helpers. */
function deployment(t, opts) {
  const fx = v2Deployment(opts), prior = {};
  fx.bin = join(fx.base, 'bin'); mkdirSync(fx.bin);
  fx.path = `${fx.bin}:${fx.env.PATH}`;
  for (const key of [...ISOLATED, ...IDENTITY]) prior[key] = process.env[key];
  for (const key of IDENTITY) delete process.env[key];
  for (const key of ISOLATED) process.env[key] = key === 'PATH' ? fx.path : fx.env[key];
  t.after(() => { for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fx.cleanup(); });
  fx.run = (args, env = {}) => fx.cli(args, { env: { PATH: fx.path, TMUX: '', ...env } });
  fx.last = (args, env) => JSON.parse(fx.run(args, env).stdout.trim().split('\n').pop());
  return fx;
}
const homes = (fx, soul) => { const dir = join(fx.root, soul, 'instances'); return existsSync(dir) ? readdirSync(dir).filter(n => !n.startsWith('.')) : []; };
const metaOf = home => JSON.parse(readFileSync(join(home, 'instance.json'), 'utf8'));
// Harness and model are spawn flags or a launch configuration, never soul fields.
const OPUS = { 'launch-configs': { opus: { harness: 'claude', model: 'opus' } } };
const WORKTREE = { wt: { soul: { work: 'worktree' } } };

// ---- K5: enforced child-spawn policy (readiness --policy is covered on a workspace home in inspect-readiness) ----
test('K5 policy: --no-child-spawns is recorded at spawn and ENFORCED by the spawn route for --parent / --relation child; --allow-child-spawns overrides with its origin', async t => {
  const fx = deployment(t, { souls: { boss: {}, minion: {} } });
  const boss = await fx.spawn('boss', { purpose: 'p', allowChildSpawns: false });
  assert.deepEqual(metaOf(boss.home).policy.childSpawns, { allowed: false, origin: { kind: 'spawn-option', detail: '--no-child-spawns' } });
  // Route enforcement: a child of boss is refused, attributed to boss's policy; nothing spawned.
  await assert.rejects(fx.spawn('minion', { purpose: 'kid', parent: boss.instance }),
    e => e.code === 'E_CHILD_SPAWNS_DISABLED' && e.parent === boss.instance && e.policy.allowed === false && e.policy.origin.kind === 'spawn-option');
  await assert.rejects(fx.spawn('minion', { purpose: 'kid2', relation: 'child', relativeTo: boss.instance }), e => e.code === 'E_CHILD_SPAWNS_DISABLED');
  assert.deepEqual(homes(fx, 'minion'), [], 'refusal created no home');
  const cli = fx.run(['spawn', 'minion', '--parent', boss.instance, '--no-launch', '--json']);
  assert.equal(cli.status, 1); const env = JSON.parse(cli.stdout.trim().split('\n').pop()); assert.equal(env.error.code, 'E_CHILD_SPAWNS_DISABLED'); assert.equal(env.error.details.parent, boss.instance);
  // Unrelated spawn of minion is fine; an operator override at spawn records its origin and the route honours it.
  const free = await fx.spawn('minion', { purpose: 'free' }); assert.ok(free.home);
  const boss2 = await fx.spawn('boss', { purpose: 'open', allowChildSpawns: true });
  assert.deepEqual(metaOf(boss2.home).policy.childSpawns, { allowed: true, origin: { kind: 'spawn-option', detail: '--allow-child-spawns' } });
  const kid = await fx.spawn('minion', { purpose: 'kid3', parent: boss2.instance }); assert.equal(metaOf(kid.home).parentInstance, boss2.instance);
  for (const h of [boss.home, boss2.home, free.home, kid.home]) retireInstance(fx.root, metaOf(h).instance);
});

test('K6 preview: spawn --preview decides instance/home/branch/base/harness/model/policy and creates NOTHING; --base selects the worktree start point; --model @native-default is explicit; E_BRANCH_EXISTS / E_BASE_UNKNOWN before any side effect; apply agrees with the preview', async t => {
  const fx = deployment(t, { souls: WORKTREE, local: OPUS });
  const git = (...a) => gitIn(fx.member, ...a);
  git('branch', 'release'); const release = git('rev-parse', 'release');
  const head = fx.commit({}, 'second');
  const p = fx.run(['spawn', 'wt', '--purpose', 'fix-login', '--launch-config', 'opus', '--preview', '--json']); assert.equal(p.status, 0, p.stdout + p.stderr);
  const pv = JSON.parse(p.stdout.trim().split('\n').pop()).result;
  assert.equal(pv.spawnPreviewApi, 2); assert.equal(pv.preview, true); assert.equal(pv.instance, 'wt-fix-login'); assert.equal(pv.branch, 'agents/wt-fix-login');
  assert.deepEqual(pv.base, { ref: fx.key, oid: head }, 'without --base, the commit the spawn observed the soul\'s repository at'); assert.equal(pv.worktree, join(fx.root, 'wt', 'instances', 'wt-fix-login', 'work'));
  assert.equal(pv.harness, 'claude'); assert.equal(pv.model, 'opus'); assert.equal(pv.policy.childSpawns.allowed, true);
  assert.deepEqual(homes(fx, 'wt'), [], 'preview created no home');
  assert.equal(git('branch', '--list', 'agents/wt-fix-login'), '', 'preview created no branch');
  const nd = fx.last(['spawn', 'wt', '--launch-config', 'opus', '--preview', '--base', 'release', '--model', '@native-default', '--json']).result;
  assert.deepEqual(nd.base, { ref: 'release', oid: release }); assert.equal(nd.model, null); assert.equal(nd.modelSource, 'native default (explicit)');
  const inherit = fx.last(['spawn', 'wt', '--launch-config', 'opus', '--preview', '--json']).result;
  assert.equal(inherit.model, 'opus', 'omitting --model still inherits the launch configuration\'s model; only @native-default forces the harness default');
  assert.equal(fx.last(['spawn', 'wt', '--preview', '--base', 'nope', '--json']).error.code, 'E_BASE_UNKNOWN');
  git('branch', 'agents/wt-taken');
  assert.equal(fx.last(['spawn', 'wt', '--purpose', 'taken', '--preview', '--json']).error.code, 'E_BRANCH_EXISTS');
  // Apply with the same inputs agrees with the preview: branch created FROM the chosen base.
  const applied = await fx.spawn('wt', { purpose: 'fix-login', baseRef: 'release', launchConfig: 'opus' });
  assert.equal(applied.instance, pv.instance); assert.equal(applied.branch, pv.branch);
  assert.equal(gitIn(join(applied.home, 'work'), 'rev-parse', 'HEAD'), release, 'worktree starts at the selected base');
  retireInstance(fx.root, applied.instance, { discardWorktree: true });
});

test('K7 events: spawn writes spawned (+launched when launching); a refused child spawn writes child-spawn-refused on the PARENT; oats instance events reads them', async t => {
  const fx = deployment(t, { souls: { evboss: {}, evkid: {} } });
  const boss = await fx.spawn('evboss', { purpose: 'p', allowChildSpawns: false });
  await assert.rejects(fx.spawn('evkid', { purpose: 'k', parent: boss.instance }), e => e.code === 'E_CHILD_SPAWNS_DISABLED');
  const r = fx.run(['instance', 'events', boss.instance, '--json']); assert.equal(r.status, 0, r.stdout + r.stderr);
  const ev = JSON.parse(r.stdout.trim().split('\n').pop()).result;
  assert.deepEqual(ev.events.map(e => e.kind), ['spawned', 'child-spawn-refused']);
  assert.equal(ev.events[0].data.launched, false); assert.equal(ev.events[1].data.policy.allowed, false); assert.match(ev.events[1].data.child, /^evkid-k/);
  assert.equal(ev.waitingOnYou, null);
  retireInstance(fx.root, boss.instance);
});

test('K6b (spawnPreviewApi 2): a preview — success OR refusal — leaves the deployment byte-identical (no event, no daemon, no soul write); --agents-root binds the exact root with no fallback; decision.revision binds the apply via --expect-decision (drift → E_DECISION_STALE, nothing created); preflight is bounded and reported', async t => {
  const fx = deployment(t, { souls: { ...WORKTREE, boss: {} }, local: OPUS });
  const git = (...a) => gitIn(fx.member, ...a);
  // A tmux that records every call: a session or window it was asked to create is a started backend.
  writeFileSync(join(fx.bin, 'tmux'), `#!/bin/sh\necho "$*" >> "${fx.base}/tmux-calls"; exit 1\n`, { mode: 0o700 });
  const tmuxStarted = () => existsSync(join(fx.base, 'tmux-calls')) && /new-session|new-window/.test(readFileSync(join(fx.base, 'tmux-calls'), 'utf8'));
  const boss = await fx.spawn('boss', { purpose: 'p', allowChildSpawns: false });
  const treeHash = () => { const out = spawnSync('bash', ['-c', `cd "${fx.dep}" && find . -name .git -prune -o -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256`], { encoding: 'utf8' }); return out.stdout.trim(); };
  // The FIRST preview of a never-spawned soul is inside the hashed window too: a
  // preview fetches the soul to a temporary copy, never into agents/<soul>/.
  const bossSoul = join(fx.member, 'souls', 'boss', 'soul.yaml');
  const before = treeHash(), eventsBefore = existsSync(join(boss.home, '.oats-events.jsonl')) ? readFileSync(join(boss.home, '.oats-events.jsonl'), 'utf8') : '';
  // Success preview with the backend requested: nothing started, backend reported as installed but not started.
  const ok = fx.last(['spawn', 'wt', '--purpose', 'a', '--launch-config', 'opus', '--preview', '--backend', 'tmux', '--agents-root', fx.root, '--json']).result;
  assert.equal(ok.soulFetched, true, 'the first preview fetched the soul source'); assert.equal(existsSync(join(fx.root, 'wt')), false, 'and wrote no soul copy');
  assert.equal(ok.spawnPreviewApi, 2); assert.deepEqual(ok.subject, { soul: 'wt', agentsRoot: fx.root, dir: null });
  assert.deepEqual(ok.backendStatus, { name: 'tmux', installed: true, started: false }); assert.equal(tmuxStarted(), false, 'preview started no session');
  assert.match(ok.decision.revision, /^[a-f0-9]{24}$/); assert.equal(ok.decision.instance, 'wt-a'); assert.equal(ok.decision.base.oid, git('rev-parse', 'HEAD'));
  assert.equal(ok.preflight.status, 'complete'); assert.equal(ok.preflight.budgetMs, 20000);
  // Refusal preview (child of a parent that forbids children): typed refusal, NO event appended to the parent.
  const refused = fx.last(['spawn', 'wt', '--purpose', 'kid', '--preview', '--parent', boss.instance, '--json']);
  assert.equal(refused.error.code, 'E_CHILD_SPAWNS_DISABLED');
  assert.equal(existsSync(join(boss.home, '.oats-events.jsonl')) ? readFileSync(join(boss.home, '.oats-events.jsonl'), 'utf8') : '', eventsBefore, 'a refusal preview appends no event');
  // Unknown soul in preview: never creates a soul; exact-root mismatch refuses.
  assert.equal(fx.last(['spawn', 'ghost', '--preview', '--json']).error.code, 'E_SOUL_UNKNOWN'); assert.equal(existsSync(join(fx.root, 'ghost')), false, 'no soul written');
  assert.equal(fx.last(['spawn', 'wt', '--preview', '--agents-root', join(fx.base, 'elsewhere'), '--json']).error.code, 'E_SOUL_UNKNOWN');
  assert.equal(fx.last(['spawn', 'wt', '--preview', '--instructions-file', bossSoul, '--json']).error.code, 'E_BAD_ARGS');
  assert.equal(treeHash(), before, 'deployment tree byte-identical after success + refusal + unknown-soul previews');
  assert.deepEqual(homes(fx, 'wt'), []);
  // Apply bound to the decision: same decision → spawns; a moved base → E_DECISION_STALE with the fresh decision, nothing created.
  const stale = ok.decision.revision;
  fx.commit({}, 'moved');
  const drift = fx.last(['spawn', 'wt', '--purpose', 'a', '--launch-config', 'opus', '--expect-decision', stale, '--no-launch', '--json']);
  assert.equal(drift.error.code, 'E_DECISION_STALE'); assert.equal(drift.error.details.decision.base.oid, git('rev-parse', 'HEAD')); assert.notEqual(drift.error.details.decision.revision, stale);
  assert.deepEqual(homes(fx, 'wt'), [], 'stale decision created nothing'); assert.equal(git('branch', '--list', 'agents/wt-a'), '', 'and no branch');
  const fresh = fx.last(['spawn', 'wt', '--purpose', 'a', '--launch-config', 'opus', '--preview', '--json']).result.decision.revision;
  const applied = fx.last(['spawn', 'wt', '--purpose', 'a', '--launch-config', 'opus', '--expect-decision', fresh, '--no-launch', '--json']);
  assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 300)); assert.equal(applied.result.instance, 'wt-a');
  // Name now taken: a re-used old decision is stale (the kernel would have auto-suffixed to wt-a-2 without the flag).
  const again = fx.last(['spawn', 'wt', '--purpose', 'a', '--launch-config', 'opus', '--expect-decision', fresh, '--no-launch', '--json']);
  assert.equal(again.error.code, 'E_DECISION_STALE'); assert.equal(again.error.details.decision.instance, 'wt-a-2'); assert.deepEqual(homes(fx, 'wt'), ['wt-a'], 'stale decision created no second home');
});

test('K6b preflight custody: a hanging `pi --list-models` probe cannot hang a preview — bounded by the shared budget, reported as preflight.status timeout, probe group killed', async t => {
  const fx = deployment(t);
  // A provider-qualified preference LIST forces the pi catalog probe; the fake pi hangs forever.
  // The fake probe records its own pid and its forked child's, so custody is
  // checked on exactly this fixture's processes (never a machine-wide match that
  // a concurrent test file's probe could satisfy), and it never finishes.
  const pids = join(fx.base, 'probe.pids');
  writeFileSync(join(fx.bin, 'pi'), `#!/bin/sh\ncase "$1" in --list-models) echo $$ > '${pids}'; sleep 600 & echo $! >> '${pids}'; wait; echo finished > '${pids}.finished';; esac\nexit 0\n`, { mode: 0o700 });
  const out = spawnSync(process.execPath, [CLI, 'spawn', 'dev', '--harness', 'pi', '--model', 'openai/gpt-x, anthropic/claude-y', '--preview', '--json'], { cwd: fx.dep, env: { ...fx.env, PATH: fx.path, OATS_PREVIEW_PREFLIGHT_BUDGET_MS: '1500' }, encoding: 'utf8', timeout: 60000 });
  // The 60 s spawn timeout is only a safety net: the preview must return on its own (no signal).
  assert.equal(out.signal, null, `the preview was killed by the test's safety timeout: the hanging probe hung it (${out.stderr.slice(0, 400)})`);
  assert.ok(out.stdout.trim(), `no output (status ${out.status}): ${out.stderr.slice(0, 400)}`);
  const pv = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.equal(pv.ok, true, out.stdout + out.stderr); assert.equal(pv.result.preflight.status, 'timeout'); assert.equal(pv.result.preflight.budgetMs, 1500);
  assert.equal(existsSync(pids + '.finished'), false, 'the preview returned while its probe was still hanging');
  const probe = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
  assert.equal(probe.length, 2, `the probe started and forked its child: ${JSON.stringify(probe)}`);
  // SIGKILL delivery and reaping are asynchronous: wait, bounded, for this
  // group to be gone. A probe that was never killed sleeps 600 s and fails this.
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const deadline = Date.now() + 10000;
  while (probe.some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(probe.filter(alive), [], 'probe process group killed');
});

test('process-group: killGroup never signals pid 0 / negative / non-integer — a FAILED spawn (ENOENT → pid 0) must not SIGKILL the caller\'s own process group', () => {
  const calls = []; const real = process.kill; process.kill = (pid, sig) => { calls.push([pid, sig]); return true; };
  try {
    for (const bad of [{ pid: 0, error: { code: 'ENOENT' } }, { pid: -5 }, { pid: undefined }, { pid: NaN }, { pid: 1.5 }, {}, null, undefined, { pid: '123' }]) assert.equal(killGroup(bad), false, JSON.stringify(bad));
    assert.deepEqual(calls, [], 'no signal was sent for any failed-spawn shape');
    assert.equal(killGroup({ pid: 424242 }), true); assert.deepEqual(calls, [[-424242, 'SIGKILL'], [424242, 'SIGKILL']]);
  } finally { process.kill = real; }
  // The real path: a probe whose binary does not exist reports pid 0 and must not kill us.
  const r = spawnSync('/nonexistent/binary-' + process.pid, ['x'], { detached: true, timeout: 1000 });
  assert.equal(r.error?.code, 'ENOENT'); assert.equal(r.pid, 0); assert.equal(killGroup(r), false, 'and we are still alive to assert this');
});

test('K6c spawn idempotency: --expect-decision + --idempotency-key — a retry of the SAME confirmed decision replays the recorded home (found by key, never by name) instead of spawning twice; the same key for a different decision refuses E_IDEMPOTENCY_CONFLICT; a different key spawns anew', t => {
  const fx = deployment(t, { souls: WORKTREE, local: OPUS });
  const spawn = (...args) => fx.last(['spawn', 'wt', '--launch-config', 'opus', ...args, '--json']);
  const rev = spawn('--purpose', 'a', '--preview').result.decision.revision;
  const first = spawn('--purpose', 'a', '--expect-decision', rev, '--idempotency-key', 'k-1', '--no-launch');
  assert.equal(first.ok, true, JSON.stringify(first).slice(0, 300)); assert.equal(first.result.instance, 'wt-a'); assert.equal(first.result.replayed, false);
  const meta = metaOf(join(fx.root, 'wt', 'instances', 'wt-a'));
  assert.equal(meta.spawnIdempotencyKey, 'k-1'); assert.equal(meta.decision.revision, rev);
  // The receipt echoes the FULL bound decision — the same shape the preview showed, effective included.
  const shown = spawn('--purpose', 'a', '--preview').result.decision; // placement now differs (taken) but the SHAPE is what we check
  assert.deepEqual(Object.keys(first.result.decision).sort(), Object.keys(shown).sort()); assert.deepEqual(Object.keys(first.result.decision.effective).sort(), Object.keys(shown.effective).sort());
  assert.equal(first.result.decision.effective.model, 'opus'); assert.equal(first.result.decision.effective.work, 'worktree');
  // Lost response → retry with the same key: replay, nothing new.
  const again = spawn('--purpose', 'a', '--expect-decision', rev, '--idempotency-key', 'k-1', '--no-launch');
  assert.equal(again.ok, true, JSON.stringify(again).slice(0, 300)); assert.equal(again.result.replayed, true); assert.equal(again.result.instance, 'wt-a'); assert.equal(again.result.home, first.result.home);
  assert.equal(typeof first.result.attach, 'string'); assert.equal(again.result.attach, first.result.attach, 'a replay answers the attach command the first apply answered');
  assert.deepEqual(homes(fx, 'wt'), ['wt-a'], 'replay spawned nothing');
  assert.ok(JSON.parse(fx.run(['instance', 'events', 'wt-a', '--json']).stdout).result.events.filter(e => e.kind === 'spawned').length === 1, 'one spawned event');
  // Same key, different decision (name now taken → fresh decision is wt-a-2): conflict, not a second spawn.
  const fresh = spawn('--purpose', 'a', '--preview').result.decision.revision; assert.notEqual(fresh, rev);
  const conflict = spawn('--purpose', 'a', '--expect-decision', fresh, '--idempotency-key', 'k-1', '--no-launch');
  assert.equal(conflict.error.code, 'E_IDEMPOTENCY_CONFLICT'); assert.equal(conflict.error.details.instance, 'wt-a');
  assert.deepEqual(homes(fx, 'wt'), ['wt-a']);
  // A different key with the fresh decision is a genuinely new confirmation: spawns wt-a-2.
  const second = spawn('--purpose', 'a', '--expect-decision', fresh, '--idempotency-key', 'k-2', '--no-launch');
  assert.equal(second.ok, true, JSON.stringify(second).slice(0, 300)); assert.equal(second.result.instance, 'wt-a-2');
  // Without --expect-decision the key is recorded but replay is not offered (no decision to bind to): documented legacy path.
  assert.ok(JSON.parse(fx.run(['version', '--json']).stdout).features.includes('spawn-idempotency'));
  assert.equal(spawn('--purpose', 'b', '--idempotency-key', 'bad key!', '--no-launch').error.code, 'E_BAD_ARGS');
});

test('K6d (spawn-apply-2): the decision binds EFFECTIVE launch facts (a changed inherited model drifts it); a stale launching apply starts no session; two concurrent applies of one decision create exactly one home (E_PLACEMENT_TAKEN for the loser)', async t => {
  const fx = deployment(t, { souls: WORKTREE, local: OPUS });
  // A tmux that records every call: a session or window it was asked to create is a started backend.
  // Its OATS server lists no session (a launch reads that before it places anything); everything else fails.
  writeFileSync(join(fx.bin, 'tmux'), `#!/bin/sh\necho "$*" >> "${fx.base}/tmux-calls"\ncase " $* " in *" list-sessions "*) exit 0 ;; esac\nexit 1\n`, { mode: 0o700 });
  const tmuxStarted = () => existsSync(join(fx.base, 'tmux-calls')) && /new-session|new-window/.test(readFileSync(join(fx.base, 'tmux-calls'), 'utf8'));
  const spawnArgs = ['spawn', 'wt', '--purpose', 'a', '--launch-config', 'opus'];
  // A. effective facts are hashed: same placement, different inherited model (the launch configuration's) → stale.
  const pv = fx.last([...spawnArgs, '--preview', '--json']).result;
  assert.equal(pv.decision.effective.model, 'opus'); assert.equal(pv.decision.effective.work, 'worktree'); assert.equal(pv.decision.effective.repo, fx.member);
  const local = join(fx.dep, 'oats-local.yaml'); writeFileSync(local, readFileSync(local, 'utf8').replace('model: opus', 'model: haiku'));
  const drift = fx.last([...spawnArgs, '--expect-decision', pv.decision.revision, '--no-launch', '--json']);
  assert.equal(drift.error.code, 'E_DECISION_STALE'); assert.equal(drift.error.details.decision.effective.model, 'haiku'); assert.equal(drift.error.details.decision.instance, 'wt-a', 'placement unchanged — only the effective model moved');
  assert.deepEqual(homes(fx, 'wt'), []);
  // B. a stale LAUNCHING apply starts no session.
  const stale = fx.last([...spawnArgs, '--backend', 'tmux', '--expect-decision', pv.decision.revision, '--json']);
  assert.equal(stale.error.code, 'E_DECISION_STALE'); assert.equal(tmuxStarted(), false, 'stale apply started no backend');
  // C. two concurrent applies of ONE fresh decision → exactly one home; the loser refuses E_PLACEMENT_TAKEN having touched nothing.
  const fresh = fx.last([...spawnArgs, '--preview', '--json']).result.decision.revision;
  const run = () => new Promise(res => { const p = spawnChild(process.execPath, [CLI, ...spawnArgs, '--expect-decision', fresh, '--no-launch', '--json'], { cwd: fx.dep, env: { ...fx.env, PATH: fx.path, TMUX: '' } }); let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d); p.on('close', code => { let doc; try { doc = JSON.parse(out.trim().split('\n').pop()); } catch { doc = { ok: false, error: { code: 'UNPARSEABLE', raw: (out + err).slice(0, 400) } }; } res({ code, doc }); }); });
  const results = await Promise.all([run(), run(), run()]);
  const wins = results.filter(r => r.doc.ok), losses = results.filter(r => !r.doc.ok);
  assert.equal(wins.length, 1, JSON.stringify(results.map(r => r.doc.ok ? 'ok' : r.doc.error.code)));
  // A loser refuses with whichever pre-placement check it reaches first after the winner's
  // side effects landed: the exclusive mkdir (E_PLACEMENT_TAKEN), the bound decision
  // (E_DECISION_STALE), or — in worktree mode — the winner's freshly created branch
  // (E_BRANCH_EXISTS). All three are honest "nothing created" refusals.
  // All three applies bind ONE decision, so they plan the same branch by design:
  // the branch is not a per-run name to make unique, it is what they race for.
  assert.ok(losses.every(l => ['E_PLACEMENT_TAKEN', 'E_DECISION_STALE', 'E_BRANCH_EXISTS'].includes(l.doc.error.code)), JSON.stringify(losses.map(l => l.doc.error)));
  assert.deepEqual(homes(fx, 'wt'), ['wt-a'], 'exactly one home');
  const git = (...a) => gitIn(fx.member, ...a);
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/agents/'), 'agents/wt-a', 'the losers created no branch');
  assert.deepEqual(git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => realpathSync(l.slice(9))), [fx.member, join(fx.root, 'wt', 'instances', 'wt-a', 'work')], 'and no worktree');
  assert.ok(JSON.parse(fx.run(['version', '--json']).stdout).features.includes('spawn-apply-2'));
});

test('K6e replay custody: key recovery runs BEFORE placement/branch checks (an explicit-branch spawn replays instead of E_BRANCH_EXISTS); a home whose spawn did not complete replays E_SPAWN_INCOMPLETE, never success; wake outcome is recorded and returned on replay (saved:null when not recorded)', async t => {
  const fx = deployment(t, { souls: WORKTREE });
  const spawn = (...args) => fx.last(['spawn', 'wt', '--purpose', 'b', '--branch', 'feat/explicit', ...args, '--json']);
  // Explicit branch: after the first spawn the branch EXISTS; the same-key retry must replay, not E_BRANCH_EXISTS.
  const rev = spawn('--preview').result.decision.revision;
  const first = spawn('--expect-decision', rev, '--idempotency-key', 'kb', '--wake-every', '10', '--wake-message', 'hello', '--no-launch');
  assert.equal(first.ok, true, JSON.stringify(first).slice(0, 400)); assert.equal(first.result.branch, 'feat/explicit');
  const retry = spawn('--expect-decision', rev, '--idempotency-key', 'kb', '--wake-every', '10', '--wake-message', 'hello', '--no-launch');
  assert.equal(retry.ok, true, `explicit-branch retry must replay, got ${JSON.stringify(retry).slice(0, 300)}`); assert.equal(retry.result.replayed, true); assert.equal(retry.result.instance, 'wt-b');
  // Wake outcome travels with the replay.
  assert.equal(typeof retry.result.wake, 'object', JSON.stringify(retry.result).slice(0, 400)); assert.equal(retry.result.wake.requested, true, JSON.stringify({ first: first.result.wake, retry: retry.result.wake })); assert.ok([true, false].includes(retry.result.wake.saved), JSON.stringify(retry.result.wake));
  assert.deepEqual(first.result.wake?.requested, true);
  // Completion custody: a home written for a key but never completed → E_SPAWN_INCOMPLETE, not a replayed success, not a second spawn.
  const home = join(fx.root, 'wt', 'instances', 'wt-b'); const m = metaOf(home);
  assert.equal(m.spawnCompleted, true, 'a finished spawn is marked completed');
  m.spawnCompleted = false; delete m.wake; writeFileSync(join(home, 'instance.json'), JSON.stringify(m, null, 2));
  const inc = spawn('--expect-decision', rev, '--idempotency-key', 'kb', '--no-launch');
  assert.equal(inc.error.code, 'E_SPAWN_INCOMPLETE'); assert.equal(inc.error.details.home, home); assert.match(inc.error.message, /do not spawn again/);
  assert.equal(inc.ok, false);
  assert.equal(inc.error.details.unconfirmed, true);
  assert.equal(inc.error.details.instance, 'wt-b');
  assert.equal(inc.error.details.launched, false);
  // The kernel producer carries the marker before CLI serialization, preserving
  // the existing recovery context for both pre-launch and possibly launched homes.
  for (const launched of [false, true]) {
    m.launched = launched; writeFileSync(join(home, 'instance.json'), JSON.stringify(m, null, 2));
    await assert.rejects(fx.spawn('wt', { purpose: 'b', branch: 'feat/explicit', expectDecision: rev, idempotencyKey: 'kb' }), (error) => {
      assert.equal(error.code, 'E_SPAWN_INCOMPLETE');
      assert.equal(error.details?.unconfirmed, true);
      assert.equal(error.instance, 'wt-b');
      assert.equal(error.home, home);
      assert.equal(error.launched, launched ? 'unknown' : false);
      return true;
    });
    const replay = spawn('--expect-decision', rev, '--idempotency-key', 'kb', '--no-launch');
    assert.equal(replay.error.code, 'E_SPAWN_INCOMPLETE');
    assert.equal(replay.error.details.unconfirmed, true);
    assert.equal(replay.error.details.instance, 'wt-b');
    assert.equal(replay.error.details.home, home);
    assert.equal(replay.error.details.launched, launched ? 'unknown' : false);
  }
  m.launched = false;
  assert.deepEqual(homes(fx, 'wt'), ['wt-b'], 'nothing else created');
  // Wake not recorded (crash in the interval): replay says saved:null, never true/false.
  m.spawnCompleted = true; writeFileSync(join(home, 'instance.json'), JSON.stringify(m, null, 2));
  const unrec = spawn('--expect-decision', rev, '--idempotency-key', 'kb', '--no-launch');
  assert.equal(unrec.result.replayed, true); assert.deepEqual(unrec.result.wake, { requested: null, saved: null, error: null });
  assert.ok(JSON.parse(fx.run(['version', '--json']).stdout).features.includes('spawn-idempotency-2'));
});

test('K6f retention: a fresh keyed (decision-bound, idempotent) spawn with a wake retires CLEAN — the completion marker and wake record are kernel writes, not "changed instance-home bytes"', t => {
  const fx = deployment(t, { souls: WORKTREE });
  const rev = fx.last(['spawn', 'wt', '--purpose', 'r', '--preview', '--json']).result.decision.revision;
  const sp = fx.last(['spawn', 'wt', '--purpose', 'r', '--expect-decision', rev, '--idempotency-key', 'kr', '--wake-every', '10', '--wake-message', 'hi', '--no-launch', '--json']);
  assert.equal(sp.ok, true, JSON.stringify(sp).slice(0, 300)); assert.equal(sp.result.wake.saved, true);
  const plan = JSON.parse(fx.run(['retire', 'wt-r', '--plan', '--json']).stdout).result;
  const r = JSON.parse(fx.run(['retire', 'wt-r', '--plan-revision', plan.planRevision, '--idempotency-key', 'ret-1', '--json']).stdout);
  assert.equal(r.retired, 'wt-r', JSON.stringify(r).slice(0, 400));
  assert.ok(!(r.workRecovery?.classes || []).includes('changed instance-home bytes'), `kernel writes must not read as user changes: ${JSON.stringify(r.workRecovery ?? r).slice(0, 400)}`);
  assert.equal(r.workRecovery ?? null, null, `a fresh, untouched home needs no work recovery: ${JSON.stringify(r.workRecovery ?? null)}`);
});

test('K6g retention authority: kernel post-spawn fields (spawnCompleted, wake) never read as changes, but authored home bytes written in the launch→completion interval are STILL recovered at retire — nothing but the kernel fields is ever re-blessed', t => {
  const fx = deployment(t, { souls: WORKTREE });
  // The "harness": tmux is faked so the launch writes an authored STATE.md into the home the moment it starts —
  // i.e. BEFORE the kernel's completion marker and the CLI's wake record are written.
  const wins = join(fx.base, 'tmux-wins'); writeFileSync(wins, '');
  // The kernel addresses a server first (-u, then -L oats or -S <socket>): the command follows. No
  // session exists (list-sessions prints nothing), so the launch creates it and is answered its
  // socket and first window; new-window answers the window's id.
  const fakeTmux = (writeState) => `#!/bin/sh
while :; do case "$1" in -u) shift ;; -L|-S) shift 2 ;; *) break ;; esac; done
case "$1" in
  new-session) printf '/tmp/oats-k6g-fake.sock\\t@0\\n' ;;
  show-environment) printf 'PATH="%s"; export PATH;\\n' "$PATH" ;;
  new-window) prev=""; for a in "$@"; do case "$prev" in -n) echo "$a" >> ${wins};; -c) ${writeState ? `printf 'agent wrote this at launch\\n' > "$a/STATE.md"` : ':'};; esac; prev="$a"; done; echo @1 ;;
  list-windows) cat ${wins} ;;
  kill-window) : > ${wins} ;;
esac
exit 0
`;
  writeFileSync(join(fx.bin, 'tmux'), fakeTmux(true), { mode: 0o700 });
  const rev = fx.last(['spawn', 'wt', '--purpose', 'g', '--preview', '--json']).result.decision.revision;
  const sp = fx.last(['spawn', 'wt', '--purpose', 'g', '--expect-decision', rev, '--idempotency-key', 'kg', '--wake-every', '10', '--wake-message', 'hi', '--backend', 'tmux', '--json']);
  assert.equal(sp.ok, true, JSON.stringify(sp).slice(0, 400));
  const home = join(fx.root, 'wt', 'instances', 'wt-g');
  assert.equal(readFileSync(join(home, 'STATE.md'), 'utf8'), 'agent wrote this at launch\n', 'the launch wrote authored bytes into the home');
  const meta = metaOf(home); assert.equal(meta.spawnCompleted, true); assert.equal(meta.wake?.saved, true, 'kernel fields were written AFTER the authored bytes');
  const plan = JSON.parse(fx.run(['retire', 'wt-g', '--plan', '--json']).stdout).result;
  const r = JSON.parse(fx.run(['retire', 'wt-g', '--plan-revision', plan.planRevision, '--idempotency-key', 'rg', '--json']).stdout);
  assert.equal(r.retired, 'wt-g', JSON.stringify(r).slice(0, 300));
  assert.ok(r.workRecovery, 'authored STATE.md must be recovered — the kernel fields must not have blessed it into the baseline');
  assert.ok(r.workRecovery.classes.includes('changed instance-home bytes'), JSON.stringify(r.workRecovery.classes));
  assert.equal(readFileSync(join(r.workRecovery.path, 'home', 'STATE.md'), 'utf8'), 'agent wrote this at launch\n', 'recovered bytes are the authored ones');
  // And the pure kernel-fields case still retires clean (K6f's original point).
  writeFileSync(join(fx.bin, 'tmux'), fakeTmux(false), { mode: 0o700 });
  const rev2 = fx.last(['spawn', 'wt', '--purpose', 'h', '--preview', '--json']).result.decision.revision;
  assert.equal(fx.last(['spawn', 'wt', '--purpose', 'h', '--expect-decision', rev2, '--idempotency-key', 'kh', '--wake-every', '10', '--wake-message', 'hi', '--backend', 'tmux', '--json']).ok, true);
  const plan2 = JSON.parse(fx.run(['retire', 'wt-h', '--plan', '--json']).stdout).result;
  const r2 = JSON.parse(fx.run(['retire', 'wt-h', '--plan-revision', plan2.planRevision, '--idempotency-key', 'rh', '--json']).stdout);
  assert.equal(r2.workRecovery ?? null, null, `kernel fields alone: clean — ${JSON.stringify(r2.workRecovery ?? null)}`);
});

test('K6h fingerprint scope: kernel-field neutrality and receipt exclusions are OPT-IN for an instance home — in any other tree (work, recovery) an instance.json is the agent\'s bytes: changing only its spawnCompleted/wake keys CHANGES the fingerprint, and a .oats-events.jsonl is significant', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'oats-k6h-'))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const tree = join(base, 'tree'); mkdirSync(tree);
  writeFileSync(join(tree, 'instance.json'), JSON.stringify({ spawnCompleted: false, wake: null, payload: 'v1' }));
  const a = fingerprintTree(tree);
  writeFileSync(join(tree, 'instance.json'), JSON.stringify({ spawnCompleted: true, wake: { saved: true }, payload: 'v1' }));
  const b = fingerprintTree(tree);
  assert.notEqual(a, b, 'work-tree instance.json: kernel-named keys are fully significant');
  assert.equal(fingerprintTree(tree, { instanceHome: true }), (() => { writeFileSync(join(tree, 'instance.json'), JSON.stringify({ spawnCompleted: false, wake: null, payload: 'v1' })); return fingerprintTree(tree, { instanceHome: true }); })(), 'instance home: the same two files fingerprint equal — only there');
  writeFileSync(join(tree, '.oats-events.jsonl'), 'x\n');
  assert.notEqual(fingerprintTree(tree), a, 'a receipt-named file in a work tree is agent bytes');
});
