// The capability-show boundary (server/capability-show.mjs): the renderer's selector must match one
// held catalog row, the verb runs through the fixed-argv adapter with that row's coordinates,
// refusals pass verbatim, undecodable answers are protocol failures, and successful answers are
// held per (deployment, selector, commit[, path]) with in-flight coalescing. No kernel is spawned:
// `invoke` is a fake, except in the last test, which drives the real cliWorkspace with a fake exec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capabilityShowRequest, createCapabilityShowCache, capabilityShowKey } from '../server/capability-show.mjs';
import { cliWorkspace, WORKSPACE_READ_TIMEOUT } from '../../client/workspace-cli.mjs';
import { capabilityShowUnreadable, capabilityShowData } from '../../client/capability-show-contract.mjs';
import { startLoadPathServer } from './helpers/load-path-server.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';

const deployment = '/fixture/base/northwind-workspace';
const workspace = { id: deployment, scope: deployment, name: 'northwind' };
const C1 = 'a'.repeat(40), C2 = 'b'.repeat(40);
const REPO = 'local//fixture/base/fx/remotes/agents.git';
const cli = (extra = {}) => ({ ok: true, bin: '/fixture/bin/oats', version: '0.30.0', workspaceApi: 2,
  features: ['workspace-v2', 'packages-no-approval', 'capability-show'], capabilityShowApi: 1, ...extra });
const rows = (commit = C1) => [
  { name: 'nw-house-style', kind: 'member', repoKey: REPO, commit },
  { name: 'oats.core', kind: 'package', package: 'oats.framework', commit },
  { name: 'ext-thing', kind: 'external', commit },
  { name: 'no-commit', kind: 'member', repoKey: REPO },
];
const member = { name: 'nw-house-style', kind: 'member', repoKey: REPO };
const pkg = { name: 'oats.core', kind: 'package', package: 'oats.framework' };
const show = (name, kind, commit = C1, over = {}) => ({
  capabilityShowApi: 1, name, kind, repoKey: kind === 'member' ? REPO : null, package: kind === 'package' ? 'oats.framework' : null,
  version: kind === 'package' ? '1.0.0' : null, commit, path: `capabilities/${name}`,
  inject: { path: 'inject.md', bytes: 6, text: '# Hi\n', binary: false, truncated: false },
  skills: [{ name: 'oats-operate', path: 'skills/oats-operate', description: 'Operate.', files: [{ path: 'skills/oats-operate/SKILL.md', bytes: 10 }], filesTruncated: false }],
  problems: [], ...over,
});
const fileAnswer = (name, path, commit = C1) => ({ capabilityShowApi: 1, name, kind: 'member', commit,
  file: { path, bytes: 4, text: 'text', binary: false, truncated: false } });
const ok = result => ({ ok: true, document: { schemaVersion: 1, ok: true, result } });

/** A fake adapter: records every call and answers with `answer(options)` (a value or a promise). */
function fake(answer) {
  const calls = [];
  const invoke = async (state, options) => { calls.push(options); return answer(options, state); };
  return { calls, invoke };
}
const answering = () => fake(o => ok(o.path ? fileAnswer(o.name, o.path) : show(o.name, o.member ? 'member' : 'package')));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const rejects = (promise, code, message) => assert.rejects(promise, e => e.code === code && (message === undefined || e.message === message));

test('show: the matched row is invoked with its coordinates and the answer comes back decoded', async () => {
  const f = answering();
  const result = await capabilityShowRequest({ action: 'show', capability: member }, { workspace, cli: cli(), catalog: rows(), invoke: f.invoke, maxAge: 60 });
  assert.deepEqual(f.calls, [{ action: 'capability-show', context: deployment, name: 'nw-house-style', member: REPO, maxAge: 60 }]);
  assert.equal(result.name, 'nw-house-style'); assert.equal(result.kind, 'member'); assert.equal(result.commit, C1);
  assert.equal(result.inject.text, '# Hi\n'); assert.equal(result.skills[0].files[0].path, 'skills/oats-operate/SKILL.md', 'capability-relative, as the kernel reports it');
  const p = await capabilityShowRequest({ action: 'show', capability: pkg }, { workspace, cli: cli(), catalog: rows(), invoke: f.invoke });
  assert.deepEqual(f.calls[1], { action: 'capability-show', context: deployment, name: 'oats.core', package: 'oats.framework' }, 'no maxAge key when none is given');
  assert.equal(p.package, 'oats.framework');
});

test('file: --file travels as path and the answer is decoded against it', async () => {
  const f = answering();
  const result = await capabilityShowRequest({ action: 'file', capability: member, path: 'skills/oats-operate/SKILL.md' },
    { workspace, cli: cli(), catalog: rows(), invoke: f.invoke });
  assert.deepEqual(f.calls.map(c => c.path ?? null), [null, 'skills/oats-operate/SKILL.md'], 'the listing, then the listed file');
  assert.deepEqual(result.file, { path: 'skills/oats-operate/SKILL.md', bytes: 4, text: 'text', binary: false, truncated: false });
  // An answer about another file is not this file.
  const wrong = fake(o => ok(o.path ? fileAnswer('nw-house-style', 'inject.md') : show(o.name, 'member')));
  await rejects(capabilityShowRequest({ action: 'file', capability: member, path: 'skills/oats-operate/SKILL.md' }, { workspace, cli: cli(), catalog: rows(), invoke: wrong.invoke }),
    'E_CLI_PROTOCOL', capabilityShowUnreadable(DESKTOP_TERMS));
});

test('a refusal passes its code and message verbatim (bounded); a thrown adapter is E_CLI_FAILED', async () => {
  // The kernel's own codes (the renderer special-cases some) travel as they are.
  for (const code of ['E_CAPABILITY_FILE_UNKNOWN', 'E_REMOTE_FILE_OVERSIZE', 'E_CAPABILITY_UNKNOWN', 'E_CAPABILITY_FILE_UNSAFE', 'E_CAPABILITY_AMBIGUOUS',
    'E_PACKAGE_INTEGRITY', 'E_REMOTE_UNREADABLE', 'E_REMOTE_TREE_UNSAFE', 'E_LOCK_SCHEMA', 'E_LOCAL_MISSING']) {
    const f = fake(o => (o.path ? { ok: false, reason: { code, message: `kernel: ${code}` } } : ok(show(o.name, 'member'))));
    await rejects(capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, { workspace, cli: cli(), catalog: rows(), invoke: f.invoke }),
      code, `kernel: ${code}`);
    assert.equal(f.calls.length, 2);
  }
  const long = fake(() => ({ ok: false, reason: { code: 'E_PATH', message: 'x'.repeat(8000) } }));
  await rejects(capabilityShowRequest({ action: 'show', capability: member }, { workspace, cli: cli(), catalog: rows(), invoke: long.invoke }), 'E_PATH', 'x'.repeat(4096));
  const thrown = fake(() => { throw new Error('SECRET'); });
  await assert.rejects(capabilityShowRequest({ action: 'show', capability: member }, { workspace, cli: cli(), catalog: rows(), invoke: thrown.invoke }),
    e => e.code === 'E_CLI_FAILED' && !/SECRET/.test(e.message));
});

test('an undecodable answer is E_CLI_PROTOCOL with the unreadable message', async () => {
  for (const result of [show('nw-house-style', 'member', C1, { capabilityShowApi: 2 }), show('other-name', 'member'), null, { nope: 1 }]) {
    const f = fake(() => ok(result));
    await rejects(capabilityShowRequest({ action: 'show', capability: member }, { workspace, cli: cli(), catalog: rows(), invoke: f.invoke }),
      'E_CLI_PROTOCOL', capabilityShowUnreadable(DESKTOP_TERMS));
  }
});

test('the selector must match exactly one held row: unknown, mismatched, external, ambiguous or no catalog never reach the CLI', async () => {
  const f = fake(() => assert.fail('no CLI call'));
  const unknown = "This capability is not in the workspace's capability list. Refresh the list and try again.";
  for (const [capability, catalog] of [
    [{ ...member, name: 'nw-missing' }, rows()],
    [{ ...member, repoKey: 'local//elsewhere.git' }, rows()],
    [{ name: 'oats.core', kind: 'package', package: 'oats.other' }, rows()],
    [{ name: 'oats.core', kind: 'member', repoKey: REPO }, rows()],
    [member, null], [member, []], [member, 'rows'],
    [member, [...rows(), rows()[0]]],
    [member, () => { throw new Error('catalog read failed'); }],
  ]) await rejects(capabilityShowRequest({ action: 'show', capability }, { workspace, cli: cli(), catalog, invoke: f.invoke }), 'E_CAPABILITY_UNKNOWN', unknown);
  // An external row has no selector the verb can address; the request cannot even name one.
  await rejects(capabilityShowRequest({ action: 'show', capability: { name: 'ext-thing', kind: 'external' } }, { workspace, cli: cli(), catalog: rows(), invoke: f.invoke }), 'E_BAD_ARGS');
  assert.equal(f.calls.length, 0);
  // A catalog function is awaited (the held table, or one catalog read).
  const g = answering();
  await capabilityShowRequest({ action: 'show', capability: member }, { workspace, cli: cli(), catalog: async () => rows(), invoke: g.invoke });
  assert.equal(g.calls.length, 1);
});

test('remote, unknown workspace and a missing gate never reach the CLI (nor the catalog)', async () => {
  const f = fake(() => assert.fail('no CLI call'));
  const catalog = () => assert.fail('no catalog read');
  const request = { action: 'show', capability: member };
  await rejects(capabilityShowRequest(request, { workspace: null, cli: cli(), catalog, invoke: f.invoke }), 'E_WORKSPACE_UNKNOWN');
  await rejects(capabilityShowRequest(request, { workspace: { ...workspace, remote: true }, cli: cli(), catalog, invoke: f.invoke }), 'E_REMOTE_UNSUPPORTED', 'Not available for a remote workspace yet.');
  await rejects(capabilityShowRequest(request, { workspace: { ...workspace, server: 'lab' }, cli: cli(), catalog, invoke: f.invoke }), 'E_REMOTE_UNSUPPORTED');
  for (const state of [cli({ capabilityShowApi: undefined }), cli({ features: ['workspace-v2', 'packages-no-approval'] }), cli({ capabilityShowApi: 2 }), cli({ ok: false }), null])
    await rejects(capabilityShowRequest(request, { workspace, cli: state, catalog, invoke: f.invoke }), 'E_CAPABILITY_SHOW_FEATURE',
      "The installed OATS CLI can't show what a capability ships. Update OATS and retry.");
});

test('bad request shapes are E_BAD_ARGS before anything else', async () => {
  const f = fake(() => assert.fail('no CLI call'));
  for (const request of [
    null, [], 'show', { action: 'inspect', capability: member }, { capability: member },
    { action: 'show', capability: member, path: 'a.md' }, { action: 'show', capability: member, extra: 1 },
    { action: 'file', capability: member }, { action: 'file', capability: member, path: '../x' }, { action: 'file', capability: member, path: '/abs' },
    { action: 'file', capability: member, path: '-x' }, { action: 'file', capability: member, path: 'a/./b' }, { action: 'file', capability: member, path: 3 },
    { action: 'show' }, { action: 'show', capability: { ...member, extra: 1 } }, { action: 'show', capability: { ...member, package: 'p' } },
    { action: 'show', capability: { name: 'x', kind: 'member', repoKey: '--upload-pack=evil' } },
  ]) await rejects(capabilityShowRequest(request, { workspace, cli: cli(), catalog: rows(), invoke: f.invoke }), 'E_BAD_ARGS');
  assert.equal(f.calls.length, 0);
});

test('cache: a second identical read is a hit (no CLI run, a copy); another commit or path is another key', async () => {
  const f = answering(), cache = createCapabilityShowCache();
  const ctx = (catalog = rows()) => ({ workspace, cli: cli(), catalog, invoke: f.invoke, cache });
  const first = await capabilityShowRequest({ action: 'show', capability: member }, ctx());
  first.name = 'mutated';
  const second = await capabilityShowRequest({ action: 'show', capability: member }, ctx());
  assert.equal(f.calls.length, 1); assert.equal(second.name, 'nw-house-style', 'a hit is a copy');
  await capabilityShowRequest({ action: 'show', capability: member }, ctx(rows(C2)));
  assert.equal(f.calls.length, 2, 'the row moved to another commit: a miss');
  await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, ctx());
  await capabilityShowRequest({ action: 'file', capability: member, path: 'skills/oats-operate/SKILL.md' }, ctx());
  await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, ctx());
  assert.equal(f.calls.length, 4, 'files are keyed by path');
  await capabilityShowRequest({ action: 'show', capability: member }, { ...ctx(), workspace: { id: '/other', scope: '/other' } });
  assert.equal(f.calls.length, 5, 'another deployment is another key');
  cache.clear();
  await capabilityShowRequest({ action: 'show', capability: member }, ctx());
  assert.equal(f.calls.length, 6, 'clear() drops every held answer');
  assert.notEqual(capabilityShowKey({ deployment, selector: member, commit: C1 }), capabilityShowKey({ deployment, selector: member, commit: C2 }));
});

test('cache: identical concurrent reads share one run; a row without a commit coalesces but is never held', async () => {
  const gate = deferred();
  const f = fake(async o => { await gate.promise; return ok(show(o.name, 'member', C1)); });
  const cache = createCapabilityShowCache();
  const ctx = { workspace, cli: cli(), catalog: rows(), invoke: f.invoke, cache };
  const pair = Promise.all([capabilityShowRequest({ action: 'show', capability: member }, ctx), capabilityShowRequest({ action: 'show', capability: member }, ctx)]);
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 1, 'one CLI run for two concurrent requests');
  gate.resolve();
  const [a, b] = await pair;
  assert.deepEqual(a, b); assert.notEqual(a, b, 'each caller gets its own copy');
  const noCommit = { name: 'no-commit', kind: 'member', repoKey: REPO };
  const g = fake(o => ok(show(o.name, 'member')));
  const ctx2 = { ...ctx, invoke: g.invoke };
  await Promise.all([capabilityShowRequest({ action: 'show', capability: noCommit }, ctx2), capabilityShowRequest({ action: 'show', capability: noCommit }, ctx2)]);
  assert.equal(g.calls.length, 1, 'coalesced');
  await capabilityShowRequest({ action: 'show', capability: noCommit }, ctx2);
  assert.equal(g.calls.length, 2, 'not held: nothing would tell its content moved');
});

test('cache: failures are never held; a flight that straddles clear() does not store', async () => {
  let n = 0;
  const f = fake(o => (++n === 1 ? { ok: false, reason: { code: 'E_CLI_TIMEOUT', message: 'slow' } } : ok(show(o.name, 'member'))));
  const cache = createCapabilityShowCache();
  const ctx = { workspace, cli: cli(), catalog: rows(), invoke: f.invoke, cache };
  await rejects(capabilityShowRequest({ action: 'show', capability: member }, ctx), 'E_CLI_TIMEOUT', 'slow');
  await capabilityShowRequest({ action: 'show', capability: member }, ctx);
  assert.equal(f.calls.length, 2, 'the failure was not held');
  assert.equal(cache.size, 1);
  const decode = fake(() => ok({ garbage: true }));
  await rejects(capabilityShowRequest({ action: 'show', capability: pkg }, { ...ctx, invoke: decode.invoke }), 'E_CLI_PROTOCOL');
  assert.equal(cache.size, 1, 'an undecodable answer is not held either');
  // A read in flight while the CLI changes must not land in the new CLI's cache.
  const gate = deferred();
  const late = fake(async o => { await gate.promise; return ok(show(o.name, 'package')); });
  const flying = capabilityShowRequest({ action: 'show', capability: pkg }, { ...ctx, invoke: late.invoke });
  await new Promise(setImmediate);
  cache.clear(); gate.resolve(); await flying;
  assert.equal(cache.size, 0);
});

test('cache: LRU eviction past max; a hit refreshes recency', async () => {
  const cache = createCapabilityShowCache({ max: 2 });
  let runs = 0;
  const read = key => cache.read(key, async () => { runs++; return { key }; });
  await read('a'); await read('b');
  await read('a');            // hit: a becomes most recent
  await read('c');            // evicts b
  assert.equal(runs, 3); assert.equal(cache.size, 2);
  await read('a'); await read('c');
  assert.equal(runs, 3, 'a and c still held');
  await read('b');
  assert.equal(runs, 4, 'b was evicted');
});

test('through the real cliWorkspace: fixed argv, no shell, and the failure envelope verbatim', async () => {
  const seen = [];
  const exec = (bin, argv, options, done) => {
    seen.push({ bin, argv, options });
    if (argv.includes('--file')) return done(Object.assign(new Error('exit 1'), { code: 1 }),
      JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_REMOTE_FILE_OVERSIZE', message: 'skills/oats-operate/SKILL.md is too large to read', details: { x: 1 } } }));
    return done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: show('nw-house-style', 'member') }));
  };
  const invoke = (state, options) => cliWorkspace(state, options, DESKTOP_TERMS, { exec, env: {} });
  const result = await capabilityShowRequest({ action: 'show', capability: member }, { workspace, cli: cli(), catalog: rows(), invoke, maxAge: 60 });
  assert.equal(result.commit, C1);
  assert.deepEqual(seen[0].argv, ['capabilities', 'show', 'nw-house-style', '--member', REPO, '--dir', deployment, '--json'], 'no observe-max-age feature: no --max-age');
  assert.equal(seen[0].bin, '/fixture/bin/oats'); assert.equal(seen[0].options.shell, false); assert.equal(seen[0].options.cwd, deployment);
  assert.equal(seen[0].options.timeout, WORKSPACE_READ_TIMEOUT);
  await rejects(capabilityShowRequest({ action: 'file', capability: member, path: 'skills/oats-operate/SKILL.md' }, { workspace, cli: cli({ features: [...cli().features, 'observe-max-age'] }), catalog: rows(), invoke, maxAge: 60 }),
    'E_REMOTE_FILE_OVERSIZE', 'skills/oats-operate/SKILL.md is too large to read');
  // No cache here: the listing is read first (it decides the path is listed), then the file.
  assert.deepEqual(seen.slice(1).map(c => c.argv), [
    ['capabilities', 'show', 'nw-house-style', '--member', REPO, '--dir', deployment, '--max-age', '60', '--json'],
    ['capabilities', 'show', 'nw-house-style', '--member', REPO, '--file', 'skills/oats-operate/SKILL.md', '--dir', deployment, '--max-age', '60', '--json']]);
});

test('HTTP: POST /api/capabilities show|file against the shipped server, the held catalog and a fake kernel', async () => {
  const s = await startLoadPathServer({ probe: v => ({ ...v, features: [...v.features, 'capability-show'], capabilityShowApi: 1 }) });
  try {
    const post = async body => { const r = await s.request(`/api/capabilities${s.ws}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const cliState = await s.post('/api/cli/reprobe', {});
    assert.equal(cliState.capabilityShowApi, 1, 'the probe integer reaches /api/cli');
    await s.until(async () => (await s.panel()).deployment?.status === 'observed');
    const HOUSE = { name: 'nw-house-style', kind: 'member', repoKey: 'local//fixture/base/fx/remotes/agents.git' };
    const commit = 'd06ff014b1eadbb1f0093a3df1fe3e90e72f8a2b';
    s.reconfigure(c => { c.capabilityShow = { schemaVersion: 1, ok: true, result: { ...show('nw-house-style', 'member', commit), repoKey: HOUSE.repoKey } }; });
    const shows = () => s.calls().filter(c => c.verb === 'capability-show');
    const first = await post({ action: 'show', capability: HOUSE });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.name, first.body.commit, first.body.inject.text], ['nw-house-style', commit, '# Hi\n']);
    assert.deepEqual(shows().map(c => c.argv), [['capabilities', 'show', 'nw-house-style', '--member', HOUSE.repoKey, '--dir', s.deployment, '--json']]);
    assert.deepEqual((await post({ action: 'show', capability: HOUSE })).body, first.body);
    assert.equal(shows().length, 1, 'held: the second read ran no kernel');
    // The server's catalog decides, not the renderer: an unlisted selector never reaches the kernel.
    const unknown = await post({ action: 'show', capability: { ...HOUSE, repoKey: 'local//elsewhere.git' } });
    assert.deepEqual([unknown.status, unknown.body.code], [409, 'E_CAPABILITY_UNKNOWN']);
    const bad = await post({ action: 'file', capability: HOUSE, path: '../etc/passwd' });
    assert.deepEqual([bad.status, bad.body.code], [400, 'E_BAD_ARGS']);
    const long = 'm'.repeat(1000);
    s.reconfigure(c => { c.capabilityShow = { schemaVersion: 1, ok: false, error: { code: 'E_REMOTE_FILE_OVERSIZE', message: long } }; });
    const refused = await post({ action: 'file', capability: HOUSE, path: 'skills/oats-operate/SKILL.md' });
    assert.deepEqual(refused, { status: 409, body: { error: long, code: 'E_REMOTE_FILE_OVERSIZE' } }, 'verbatim, past the 300-char spawn cut');
    assert.equal(shows().length, 2, 'the listing was held: the file request ran only --file');
    const unlisted = await post({ action: 'file', capability: HOUSE, path: 'skills/oats-operate/secret.md' });
    assert.deepEqual(unlisted, { status: 409, body: { error: 'Not available.', code: 'E_CAPABILITY_FILE_UNKNOWN' } });
    assert.equal(shows().length, 2, 'an unlisted path never reaches the kernel');
    // The operations-API gate of inspect/run does not apply; the capability-show gate does.
    s.reconfigure(c => { c.version = { ...c.version, capabilityShowApi: undefined }; });
    await s.post('/api/cli/reprobe', {});
    const gated = await post({ action: 'show', capability: HOUSE });
    assert.deepEqual([gated.status, gated.body.code], [409, 'E_CAPABILITY_SHOW_FEATURE']);
    assert.equal(shows().length, 2);
  } finally { await s.stop(); }
});

test('file: only a path the show listing names is read; the listing comes from the same cache', async () => {
  const f = answering(), cache = createCapabilityShowCache();
  const ctx = { workspace, cli: cli(), catalog: rows(), invoke: f.invoke, cache };
  const fileCalls = () => f.calls.filter(c => c.path !== undefined);
  // Cold cache: the listing is read first, then the one listed file.
  await capabilityShowRequest({ action: 'file', capability: member, path: 'skills/oats-operate/SKILL.md' }, ctx);
  assert.deepEqual(f.calls.map(c => c.path ?? null), [null, 'skills/oats-operate/SKILL.md']);
  // Listing held: a file request is exactly one CLI call (the file).
  await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, ctx);
  assert.deepEqual(f.calls.map(c => c.path ?? null), [null, 'skills/oats-operate/SKILL.md', 'inject.md']);
  // Unlisted (a real path shape, a skill directory, a sibling of a listed file): refused without --file.
  for (const path of ['skills/oats-operate/other.md', 'skills/oats-operate', 'SKILL.md', 'skills/oats-operate/SKILL.md/x'])
    await rejects(capabilityShowRequest({ action: 'file', capability: member, path }, ctx), 'E_CAPABILITY_FILE_UNKNOWN', 'Not available.');
  assert.equal(fileCalls().length, 2); assert.equal(f.calls.length, 3, 'the held listing answered every check');
  // A failed listing fails the file request with the listing's own error, and no file is read.
  const broken = fake(o => (o.path ? assert.fail('no file read') : { ok: false, reason: { code: 'E_CAPABILITY_UNKNOWN', message: 'kernel: no such capability' } }));
  await rejects(capabilityShowRequest({ action: 'file', capability: pkg, path: 'inject.md' }, { ...ctx, invoke: broken.invoke }), 'E_CAPABILITY_UNKNOWN', 'kernel: no such capability');
  assert.equal(broken.calls.length, 1);
});

test('cache: an answer about another commit than the held row (or than its listing) is returned but never held', async () => {
  const cache = createCapabilityShowCache();
  // The member head moved between the catalog read (C1) and the show read (C2).
  const moved = fake(o => ok(o.path ? fileAnswer(o.name, o.path, C2) : show(o.name, 'member', C2)));
  const ctx = { workspace, cli: cli(), catalog: rows(C1), invoke: moved.invoke, cache };
  const first = await capabilityShowRequest({ action: 'show', capability: member }, ctx);
  assert.equal(first.commit, C2, 'returned as the kernel answered');
  await capabilityShowRequest({ action: 'show', capability: member }, ctx);
  assert.equal(moved.calls.length, 2, 'not held under the row\'s commit');
  assert.equal(cache.size, 0);
  // A held listing at C1, a file answered at C2: returned, not held.
  const later = fake(o => ok(o.path ? fileAnswer(o.name, o.path, C2) : show(o.name, 'member', C1)));
  const ctx2 = { ...ctx, invoke: later.invoke };
  await capabilityShowRequest({ action: 'show', capability: member }, ctx2);
  assert.equal(cache.size, 1, 'the listing matches the row: held');
  const file = await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, ctx2);
  assert.equal(file.commit, C2);
  await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, ctx2);
  assert.deepEqual(later.calls.map(c => c.path ?? null), [null, 'inject.md', 'inject.md'], 'the file was never held; the listing was');
  assert.equal(cache.size, 1);
  // Everything at the row's commit is held.
  const steady = fake(o => ok(o.path ? fileAnswer(o.name, o.path, C1) : show(o.name, 'member', C1)));
  await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, { ...ctx, invoke: steady.invoke });
  await capabilityShowRequest({ action: 'file', capability: member, path: 'inject.md' }, { ...ctx, invoke: steady.invoke });
  assert.deepEqual(steady.calls.map(c => c.path ?? null), ['inject.md'], 'the listing was already held; the file is held now');
});

// Feature `trigger-sources`: the kernel's recorded answers (test/fixtures/trigger-sources/capability-show.json,
// capability-show-problems.json and capability-show-not-object.json; the answer is the envelope's `.result`).
test('trigger sources: both keys reach the relayed answer and the held copy, projected, for the three recorded answers', async () => {
  const graph = { name: 'acme.graph', kind: 'member', repoKey: 'local//fixture/base/remotes/ws.git' };
  const DESCRIPTION = 'Ready harvest branches, one event per judged head';
  const usable = { events: ['opened', 'updated'], description: DESCRIPTION };
  for (const [name, sources, problems] of [
    ['capability-show', { 'harvest-branches': usable }, undefined],
    ['capability-show-problems', { 'harvest-branches': usable, good: usable, 'Bad Name': null }, 3],
    ['capability-show-not-object', null, 1],
  ]) {
    const envelope = JSON.parse(readFileSync(new URL(`./fixtures/trigger-sources/${name}.json`, import.meta.url), 'utf8'));
    const f = fake(() => ({ ok: true, document: structuredClone(envelope) })), cache = createCapabilityShowCache();
    const ctx = { workspace, cli: cli({ features: [...cli().features, 'trigger-sources'] }), catalog: [{ ...graph, commit: envelope.result.commit }], invoke: f.invoke, cache };
    const first = await capabilityShowRequest({ action: 'show', capability: graph }, ctx);
    assert.deepEqual(first.triggerSources, sources, name);
    assert.deepEqual(first.triggerSourceProblems, problems === undefined ? undefined : envelope.result.triggerSourceProblems, name);
    assert.equal(first.triggerSourceProblems?.length, problems, name);
    assert.deepEqual(first.problems, [], `${name}: never the capability's problems`);
    assert.doesNotMatch(JSON.stringify({ ...first, triggerSourceProblems: null }), /review-source|urlHosts|parameters|fields|<script>/, `${name}: only what the page shows is relayed`);
    // Held at the row's commit: the second read runs no kernel and carries the same two keys.
    const held = await capabilityShowRequest({ action: 'show', capability: graph }, ctx);
    assert.equal(f.calls.length, 1, name); assert.equal(cache.size, 1, name);
    assert.deepEqual(held, first, name); assert.notEqual(held, first, 'a copy');
    assert.equal(Object.hasOwn(held, 'triggerSources'), true); assert.equal(Object.hasOwn(held, 'triggerSourceProblems'), problems !== undefined);
    // What the renderer does with the relayed answer (JSON over HTTP, then the same decoder): itself.
    assert.deepEqual(capabilityShowData(JSON.parse(JSON.stringify(held)), { selector: graph }), held, `${name}: idempotent across the relay`);
  }
  // An older kernel's answer still has neither key, relayed or held.
  const older = answering(), cache = createCapabilityShowCache();
  const ctx = { workspace, cli: cli(), catalog: rows(), invoke: older.invoke, cache };
  for (let i = 0; i < 2; i++) {
    const answer = await capabilityShowRequest({ action: 'show', capability: member }, ctx);
    assert.equal(Object.hasOwn(answer, 'triggerSources'), false); assert.equal(Object.hasOwn(answer, 'triggerSourceProblems'), false);
  }
  assert.equal(older.calls.length, 1);
});
