// Remembered remote identities (#482): server/remote-identity.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRemoteIdentityStore, parseRemoteIdentities, atomicWrite, REMOTE_IDENTITY_VERSION } from '../server/remote-identity.mjs';

const NOW = '2026-10-02T09:00:00.000Z';
const FILE = '/data/remote-identity.json';
const identity = (over = {}) => ({ key: 'github.com/awebai/oats', ref: 'git:github.com/awebai/oats', keyFrom: 'workspace', standalone: false,
  defaultTeam: { label: 'default', team: 'aweb:oats' }, teams: { default: 'aweb:oats' }, teamsFrom: 'observed', ...over });
const group = (over = {}) => ({ id: 'devbox:a1b2', server: 'devbox', label: 'devbox', registrationPresent: true,
  target: { sshHost: 'devbox.lan', workspace: '/Users/alex/Agents/oats' }, probe: { ok: true },
  workspace: { reachable: true, ...identity() }, instances: [], ...over });
const entry = (over = {}) => ({ server: 'devbox', label: 'devbox', targetKey: 'a1b2', path: '/Users/alex/Agents/oats', workspace: identity(), reportedAt: NOW, ...over });
const fileText = groups => JSON.stringify({ version: REMOTE_IDENTITY_VERSION, groups });
function store({ source = null, file = FILE, write } = {}) {
  const writes = [];
  const s = createRemoteIdentityStore({ file, now: () => NOW,
    read: () => { if (source === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return source; },
    write: write || ((f, text) => writes.push({ f, doc: JSON.parse(text) })) });
  return Object.assign(s, { writes });
}

test('a fresh report is remembered and written at once (identity only, keyed by the group id)', () => {
  const s = store();
  assert.deepEqual(s.all(), [], 'a missing file is an empty memory');
  assert.equal(s.observe([group()]), true);
  assert.deepEqual(s.get('devbox:a1b2'), entry(), 'reachability is not part of the identity');
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].f, FILE);
  assert.deepEqual(s.writes[0].doc, { version: 1, groups: { 'devbox:a1b2': entry() } });
  assert.deepEqual(s.all(), [{ id: 'devbox:a1b2', ...entry() }]);
  // What was written reads back.
  const again = store({ source: JSON.stringify(s.writes[0].doc) });
  assert.deepEqual(again.get('devbox:a1b2'), entry());
  assert.deepEqual([...parseRemoteIdentities(JSON.stringify(s.writes[0].doc))], [['devbox:a1b2', entry()]]);
});

test('an unchanged report does not rewrite; a changed label or path does', () => {
  const s = store({ source: fileText({ 'devbox:a1b2': entry() }) });
  assert.equal(s.observe([group()]), false);
  assert.equal(s.observe([group({ workspace: { reachable: false, ...identity() } })]), false, 'reachability is not the identity');
  assert.equal(s.writes.length, 0);
  assert.equal(s.observe([group({ label: 'Devbox' })]), true);
  assert.equal(s.get('devbox:a1b2').label, 'Devbox');
  assert.equal(s.observe([group({ label: 'Devbox', target: { sshHost: 'devbox.lan', workspace: '/Users/alex/Agents/oats2' } })]), true);
  assert.equal(s.get('devbox:a1b2').path, '/Users/alex/Agents/oats2');
  assert.equal(s.writes.length, 2);
});

test('a failed probe changes nothing (the remembered identity stays, nothing is written)', () => {
  const s = store({ source: fileText({ 'devbox:a1b2': entry() }) });
  for (const probe of [{ ok: false, error: { code: 'E_SSH', message: 'ssh failed' } }, { ok: false }, {}, undefined]) {
    assert.equal(s.observe([group({ probe, workspace: null })]), false);
    assert.equal(s.observe([group({ probe, workspace: identity({ key: 'github.com/x/other' }) })]), false, 'even with a workspace on it');
  }
  assert.deepEqual(s.get('devbox:a1b2'), entry());
  assert.equal(s.note('devbox:a1b2'), null);
  assert.equal(s.writes.length, 0);
});

test('a group the roster answer no longer lists is dropped (and written)', () => {
  const s = store({ source: fileText({ 'devbox:a1b2': entry(), 'laptop:c3': entry({ server: 'laptop', label: 'laptop', targetKey: 'c3' }) }) });
  assert.equal(s.all().length, 2);
  assert.equal(s.observe([group()]), true);
  assert.equal(s.get('laptop:c3'), null);
  assert.deepEqual(s.writes.at(-1).doc.groups, { 'devbox:a1b2': entry() });
  assert.equal(s.observe([]), true);
  assert.deepEqual(s.all(), []);
  assert.deepEqual(s.writes.at(-1).doc, { version: 1, groups: {} });
});

test('a report with another identity moves view: stored, and noted once stored', () => {
  const s = store({ source: fileText({ 'devbox:a1b2': entry() }) });
  assert.equal(s.note('devbox:a1b2'), null);
  const web = identity({ key: 'github.com/Northwind/web', ref: 'git:github.com/Northwind/web', defaultTeam: { label: 'default', team: 'nw:web' }, teams: { default: 'nw:web' } });
  assert.equal(s.observe([group({ workspace: web })]), true);
  assert.deepEqual(s.get('devbox:a1b2').workspace, web);
  assert.equal(s.note('devbox:a1b2'), 'devbox now reports workspace web.');
  assert.equal(s.writes.length, 1);
  // The same view under another ref (ref is never compared) is no move.
  const quiet = store({ source: fileText({ 'devbox:a1b2': entry() }) });
  assert.equal(quiet.observe([group({ workspace: identity({ ref: 'git@github.com:awebai/oats.git' }) })]), true, 'stored');
  assert.equal(quiet.note('devbox:a1b2'), null);
  // Another team of the same key is another view: a move.
  const team = store({ source: fileText({ 'devbox:a1b2': entry() }) });
  team.observe([group({ label: 'Devbox box', workspace: identity({ defaultTeam: { label: 'ops', team: 'aweb:ops' } }) })]);
  assert.equal(team.note('devbox:a1b2'), 'Devbox box now reports workspace oats.');
  // A dropped group's note goes with it.
  team.observe([]);
  assert.equal(team.note('devbox:a1b2'), null);
});

test('a reachability-only object (a host before 0.36.0), an invalid one or none is never stored', () => {
  const s = store();
  for (const workspace of [{ reachable: true }, { reachable: false, code: 'E_X', message: 'm' }, null, undefined, identity({ keyFrom: 'bogus' })]) {
    assert.equal(s.observe([group({ workspace })]), false, JSON.stringify(workspace));
  }
  assert.deepEqual(s.all(), []);
  assert.equal(s.writes.length, 0);
  // A remembered entry is not overwritten by an old answer either.
  const kept = store({ source: fileText({ 'devbox:a1b2': entry() }) });
  assert.equal(kept.observe([group({ workspace: { reachable: true } })]), false);
  assert.deepEqual(kept.get('devbox:a1b2'), entry());
});

test('a malformed file or entry is ignored; valid entries survive beside bad ones', () => {
  for (const source of ['', 'not json', 'null', '[]', JSON.stringify({ version: 2, groups: { 'devbox:a1b2': entry() } }),
    JSON.stringify({ version: 1, groups: [] }), JSON.stringify({ version: 1 })]) {
    assert.deepEqual(store({ source }).all(), [], source);
  }
  const groups = {
    'devbox:a1b2': entry(),
    'laptop:c3': entry({ server: 'devbox', targetKey: 'c3' }),             // id is not <server>:<targetKey>
    'build:d4': entry({ server: 'build', targetKey: 'd4', path: 'relative/path' }),
    'box:e5': entry({ server: 'box', targetKey: 'e5', reportedAt: 'yesterday' }),
    'builder:f6': entry({ server: 'builder', targetKey: 'f6', workspace: { reachable: true } }),
    'garnet:g7': entry({ server: 'garnet', targetKey: 'g7', workspace: identity({ teamsFrom: 'nowhere' }) }),
    'Bad:h8': entry({ server: 'Bad', targetKey: 'h8' }),
    'kb-host:i9': entry({ server: 'kb-host', targetKey: 'i9', label: '' }),
    '/Users/alex/Agents/oats': entry(),                                    // a local deployment id is never an entry
    'fixture-laptop:j0': null,
  };
  assert.deepEqual(store({ source: fileText(groups) }).all().map(e => e.id), ['devbox:a1b2']);
});

test('only remote groups are ever remembered: there is no way to store a local deployment', () => {
  const s = store();
  assert.deepEqual(Object.keys(s).filter(k => k !== 'writes').sort(), ['all', 'get', 'note', 'observe'], 'no setter beside observe');
  // A local deployment shaped like a group (its path as the id) is not a report.
  for (const id of ['/Users/alex/Agents/oats', 'remote:devbox:a1b2', 'devbox', '']) {
    assert.equal(s.observe([group({ id })]), false, id);
  }
  assert.equal(s.observe([group({ server: '/Users/alex' })]), false, 'a server id that is not one');
  assert.equal(s.observe([group({ target: { workspace: 'Agents/oats' } })]), false, 'a remote path must be absolute');
  assert.equal(s.observe([group(), group({ id: 'laptop:c3', server: 'laptop', label: 'laptop' })]), true);
  for (const { id } of s.all()) assert.match(id, /^[a-z0-9][a-z0-9-]*:[A-Za-z0-9._-]+$/, 'every key is a <server>:<targetKey> group id');
  assert.deepEqual(Object.keys(s.writes.at(-1).doc.groups), ['devbox:a1b2', 'laptop:c3']);
});

test('without a file the memory lives in this process only; a failed write keeps it', () => {
  let wrote = 0;
  const memory = store({ file: null, write: () => { wrote++; } });
  assert.equal(memory.observe([group()]), true);
  assert.equal(wrote, 0);
  assert.deepEqual(memory.get('devbox:a1b2'), entry());
  const failing = store({ write: () => { throw new Error('disk full'); } });
  assert.equal(failing.observe([group()]), true);
  assert.deepEqual(failing.get('devbox:a1b2'), entry());
});

test('atomicWrite: a temporary file then rename, mode 0600, no leftover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oats-remote-identity-'));
  try {
    const file = join(dir, 'remote-identity.json');
    atomicWrite(file, '{"a":1}\n');
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['remote-identity.json']);
    writeFileSync(file, 'old', { mode: 0o644 });
    atomicWrite(file, 'new');
    assert.equal(readFileSync(file, 'utf8'), 'new');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the replaced file takes the new file\'s mode');
    assert.deepEqual(readdirSync(dir), ['remote-identity.json']);
    // A rename that fails (the target is a non-empty directory) throws and leaves no temporary file.
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked); writeFileSync(join(blocked, 'x'), 'x');
    assert.throws(() => atomicWrite(blocked, 'y'));
    assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'remote-identity.json']);
    // The store writes through it.
    const s = createRemoteIdentityStore({ file, now: () => NOW });
    s.observe([group()]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, groups: { 'devbox:a1b2': entry() } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(createRemoteIdentityStore({ file }).get('devbox:a1b2'), entry());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
