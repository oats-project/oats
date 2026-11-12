// A machine that stops answering keeps its place in its workspace (packages/client/remote-identity-memory.mjs,
// #855 3a): the rule of the Desktop's remembered remote identities as two pure functions over Maps a client
// holds, called here as a second client calls them. The Desktop's store over them, with its file, is
// test/remote-identity.test.mjs; this file reads the store's source to show it holds no second copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observeIdentities, identityMemory, entryOf } from '../../client/remote-identity-memory.mjs';
import { remoteRosterState, remotePanelEntries } from '../../client/remote-roster.mjs';
import * as views from '../../client/panel-views.mjs';
import { clientTerms } from '../../client/client-terms.mjs';
import { deploymentState } from '../../client/roster-sections.mjs';
import { createRemoteIdentityStore } from '../server/remote-identity.mjs';
import { CLI, group, identity, observed, row, remoteRow, OATS, LAB, WEB, A, R, V, V_OATS, V_LAB } from './helpers/workspace-views-fixture.mjs';

const AT = '2026-10-11T12:00:00.000Z', LATER = '2026-10-11T12:00:10.000Z';
const TUI = clientTerms({ name: 'oats tui', self: 'oats tui', selfInitial: 'oats tui', update: 'OATS', thisMachine: 'This machine' });
const devbox = (ws = identity(), extra = {}) => group('devbox:a1', 'devbox', '/home/alex/oats', ws, [remoteRow('far-a', '/home/alex/oats')], extra);
const laptop = (ws = identity(LAB, 'aweb:lab'), extra = {}) => group('laptop:v1', 'laptop', '/srv/lab', ws, [], extra);
const entry = (g, over = {}) => ({ server: g.server, label: g.label, targetKey: g.id.slice(g.server.length + 1), path: g.target.workspace,
  workspace: (({ reachable: _reachable, ...ws }) => ws)(g.workspace), reportedAt: AT, ...over });
const down = (g, error = { code: 'E_SSH', message: 'Connection timed out' }) => ({ ...g, probe: { ok: false, error }, workspace: null });
/** A Map that fails the test that writes to it. */
const sealed = (entries = []) => { const map = new Map(entries); map.set = map.delete = map.clear = () => assert.fail('a Map that was given is never changed'); return map; };
const frozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(frozen); }
  return value;
};
const EMPTY = () => ({ memory: new Map(), notes: new Map() });
/** A run of answers, as a client keeps them: each answer's Maps are the next call's. */
const run = (answers, held = EMPTY()) => answers.reduce((h, groups) => observeIdentities(h, groups, AT), held);

test('a fresh report is remembered under its group id, with the time the caller gave; new Maps are answered', () => {
  const held = EMPTY();
  const next = observeIdentities(held, [devbox(), laptop()], AT);
  assert.equal(next.changed, true);
  assert.deepEqual([...next.memory], [['devbox:a1', entry(devbox())], ['laptop:v1', entry(laptop())]]);
  assert.deepEqual([...next.notes], []);
  assert.ok(next.memory !== held.memory && next.notes !== held.notes, 'not the Maps that were given');
  assert.deepEqual([held.memory.size, held.notes.size], [0, 0]);
  // The same report again changes nothing, and still answers Maps of its own.
  const again = observeIdentities(next, [devbox(), laptop()], LATER);
  assert.equal(again.changed, false);
  assert.deepEqual([...again.memory], [...next.memory], 'the time of the first report is kept');
  assert.ok(again.memory !== next.memory && again.notes !== next.notes);
});

test('an answer that lists no groups drops all memory, and each dropped group\'s note with it', () => {
  const moved = run([[devbox(), laptop()], [devbox(identity(WEB, 'nw:web')), laptop()]]);
  assert.deepEqual([moved.memory.size, [...moved.notes.keys()]], [2, ['devbox:a1']]);
  const none = observeIdentities(moved, [], AT);
  assert.deepEqual([none.changed, [...none.memory], [...none.notes]], [true, [], []]);
  assert.equal(observeIdentities(none, [], AT).changed, false, 'nothing held, nothing listed: nothing changed');
  // One group no longer listed: only it is dropped.
  const one = observeIdentities(moved, [laptop()], AT);
  assert.deepEqual([one.changed, [...one.memory.keys()], [...one.notes]], [true, ['laptop:v1'], []]);
});

test('a group reached without an identity is not a report; what is remembered of it is kept', () => {
  for (const workspace of [{ reachable: true }, { reachable: false, code: 'E_X', message: 'm' }, null, undefined, { reachable: true, ...identity(), keyFrom: 'bogus' }]) {
    const fresh = observeIdentities(EMPTY(), [{ ...devbox(), workspace }], AT);
    assert.deepEqual([fresh.changed, fresh.memory.size], [false, 0], JSON.stringify(workspace));
    const kept = observeIdentities(run([[devbox()]]), [{ ...devbox(), workspace }], LATER);
    assert.deepEqual([kept.changed, [...kept.memory]], [false, [['devbox:a1', entry(devbox())]]], JSON.stringify(workspace));
  }
  // Nor is a group whose id or server has not the kernel's form, or whose path is not absolute.
  for (const g of [{ ...devbox(), id: '/Users/alex/Agents/oats' }, { ...devbox(), id: 'remote:devbox:a1' }, { ...devbox(), id: 'devbox' }, { ...devbox(), id: undefined },
    { ...devbox(), server: '/Users/alex' }, { ...devbox(), server: undefined }, { ...devbox(), target: { workspace: 'Agents/oats' } }, { ...devbox(), target: undefined }]) {
    assert.deepEqual([...observeIdentities(EMPTY(), [g], AT).memory], [], JSON.stringify([g.id, g.server, g.target]));
  }
});

test('a failed probe changes nothing for its group, and the group is not dropped while it is listed', () => {
  const held = run([[devbox(), laptop()]]);
  for (const probe of [{ ok: false, error: { code: 'E_SSH', message: 'ssh failed' } }, { ok: false }, {}, undefined, { ok: 'true' }, { ok: 1 }]) {
    for (const workspace of [null, { reachable: true, ...identity(WEB, 'nw:web') }]) {
      const next = observeIdentities(held, [{ ...devbox(), probe, workspace }, laptop()], LATER);
      assert.deepEqual([next.changed, [...next.memory], [...next.notes]], [false, [...held.memory], []], JSON.stringify([probe, workspace]));
    }
  }
  // Every group marked not reached by a failed roster read (remote-roster.mjs): the whole memory stays.
  const marked = remoteRosterState({ remoteGroups: [devbox(), laptop()], rosterAnswered: true, rosterFailure: null }, { envelope: { schemaVersion: 1, ok: true, result: {} } }, AT).reported;
  assert.deepEqual([...observeIdentities(held, marked, LATER).memory], [...held.memory]);
});

test('a label change only, or a path change only, is stored and leaves no note', () => {
  const held = run([[devbox()]]);
  const renamed = observeIdentities(held, [devbox(identity(), { label: 'Devbox box' })], LATER);
  assert.deepEqual([renamed.changed, renamed.memory.get('devbox:a1'), [...renamed.notes]], [true, entry(devbox(), { label: 'Devbox box', reportedAt: LATER }), []]);
  const moved = observeIdentities(held, [{ ...devbox(), target: { sshHost: 'devbox.lan', workspace: '/home/alex/oats2' } }], LATER);
  assert.deepEqual([moved.changed, moved.memory.get('devbox:a1').path, [...moved.notes]], [true, '/home/alex/oats2', []]);
  // A group with no label is remembered, and compared, by its server.
  const bare = observeIdentities(EMPTY(), [devbox(identity(), { label: '' })], AT);
  assert.equal(bare.memory.get('devbox:a1').label, 'devbox');
  assert.equal(observeIdentities(bare, [devbox(identity(), { label: undefined })], LATER).changed, false);
});

test('a move between two views leaves the sentence; a change inside one view is stored without one', () => {
  const held = run([[devbox()]]);
  // Another workspace: another view.
  const web = observeIdentities(held, [devbox(identity(WEB, 'nw:web'))], LATER);
  assert.deepEqual([web.changed, [...web.notes]], [true, [['devbox:a1', 'devbox now reports workspace web.']]]);
  assert.equal(web.memory.get('devbox:a1').workspace.key, WEB);
  // Another team of the same key is another view; the sentence names the machine by its label.
  const ops = observeIdentities(held, [devbox(identity(OATS, 'aweb:ops'), { label: 'Devbox box' })], LATER);
  assert.deepEqual([...ops.notes], [['devbox:a1', 'Devbox box now reports workspace oats.']]);
  // The same view under another ref (a ref is never compared): stored, no sentence.
  const ref = observeIdentities(held, [devbox({ ...identity(), ref: 'git@github.com:awebai/oats.git' })], LATER);
  assert.deepEqual([ref.changed, ref.memory.get('devbox:a1').workspace.ref, [...ref.notes]], [true, 'git@github.com:awebai/oats.git', []]);
  // To an identity with no workspace key (a member's): the other sentence.
  const member = observeIdentities(held, [devbox({ ...identity(), key: null, ref: null, keyFrom: null })], LATER);
  assert.deepEqual([...member.notes], [['devbox:a1', 'devbox now reports another workspace.']]);
  // A note stays while its group is listed, through answers that change nothing and through a failed probe.
  const quiet = run([[devbox(identity(WEB, 'nw:web'))], [down(devbox())]], web);
  assert.deepEqual([...quiet.notes], [['devbox:a1', 'devbox now reports workspace web.']]);
  // A later move replaces it.
  assert.deepEqual([...observeIdentities(quiet, [devbox(identity(LAB, 'aweb:lab'))], LATER).notes], [['devbox:a1', 'devbox now reports workspace lab.']]);
});

test('nothing caps the memory: 257 reports are 257 entries; the 256 is the Desktop file\'s', () => {
  const many = Array.from({ length: 257 }, (_, n) => group(`host-${n}:k${n}`, `host-${n}`, `/srv/${n}`, identity()));
  const next = observeIdentities(EMPTY(), many, AT);
  assert.equal(next.memory.size, 257);
  assert.deepEqual([...next.memory.keys()], many.map(g => g.id), 'in the answer\'s order');
  assert.equal(identityMemory(next).all().length, 257);
  // The Desktop's store holds as many in this process and writes the first 256.
  const writes = [];
  const store = createRemoteIdentityStore({ file: '/data/remote-identity.json', now: () => AT, read: () => { throw new Error('missing'); }, write: (f, text) => writes.push(JSON.parse(text)) });
  assert.equal(store.observe(many), true);
  assert.equal(store.all().length, 257);
  assert.deepEqual(Object.keys(writes.at(-1).groups), many.slice(0, 256).map(g => g.id));
});

test('identityMemory: the three readers of `held.remembered`, which read and change nothing', () => {
  const held = run([[devbox(), laptop()], [devbox(identity(WEB, 'nw:web')), laptop()]]);
  const memory = sealed(held.memory), notes = sealed(held.notes);
  const reading = identityMemory(frozen({ memory, notes }));
  assert.deepEqual(Object.keys(reading).sort(), ['all', 'get', 'note'], 'no writing method');
  assert.deepEqual(reading.get('laptop:v1'), entry(laptop()));
  assert.equal(reading.get('laptop:v1'), memory.get('laptop:v1'), 'the entry itself');
  assert.equal(reading.get('build:r1'), null);
  assert.equal(reading.note('devbox:a1'), 'devbox now reports workspace web.');
  assert.equal(reading.note('laptop:v1'), null);
  assert.equal(reading.note('devbox:a1'), 'devbox now reports workspace web.', 'reading a note does not consume it');
  assert.deepEqual(reading.all(), [{ id: 'devbox:a1', ...memory.get('devbox:a1') }, { id: 'laptop:v1', ...entry(laptop()) }]);
  assert.deepEqual(identityMemory(EMPTY()).all(), []);
  // It reads the Maps it was given, so the Maps of a later answer need a reading of their own.
  const later = observeIdentities({ memory, notes }, [laptop()], LATER);
  assert.deepEqual([reading.all().length, identityMemory(later).all().length], [2, 1]);
});

test('the time is required: without one nothing is remembered and nothing is answered', () => {
  for (const at of [undefined, null, '', 0, new Date(0)]) {
    assert.throws(() => observeIdentities(EMPTY(), [devbox()], at), (e) => e instanceof TypeError && e.message === 'observeIdentities: at must be the time of the call, a non-empty string');
  }
});

test('nothing given is changed: sealed Maps, frozen entries, frozen groups, and the same call answers the same', () => {
  const start = run([[devbox(), laptop()]]);
  const answers = [[], [devbox(), laptop()], [devbox(identity(WEB, 'nw:web'), { label: 'Devbox box' })], [down(devbox()), laptop()], [laptop(), devbox(), group('build:r1', 'build', '/home/alex/web', identity(WEB, 'nw:web'))]];
  for (const groups of answers) {
    const held = frozen({ memory: sealed([...start.memory].map(([id, e]) => [id, frozen(structuredClone(e))])), notes: sealed([['laptop:v1', 'laptop now reports workspace lab.']]) });
    const before = JSON.stringify([[...held.memory], [...held.notes]]), given = frozen(structuredClone(groups)), text = JSON.stringify(given);
    const next = observeIdentities(held, given, LATER);
    assert.equal(JSON.stringify([[...held.memory], [...held.notes]]), before);
    assert.equal(JSON.stringify(given), text);
    const again = observeIdentities(held, given, LATER);
    assert.deepEqual([[...again.memory], [...again.notes], again.changed], [[...next.memory], [...next.notes], next.changed]);
    // An entry that did not change is the same object, so an answer shares nothing a caller could not already reach.
    for (const [id, e] of next.memory) if (held.memory.get(id) && JSON.stringify(held.memory.get(id)) === JSON.stringify(e)) assert.equal(e, held.memory.get(id));
  }
});

test('entryOf: an entry read from outside is kept only when it is what observeIdentities would have stored', () => {
  const good = entry(devbox());
  assert.deepEqual(entryOf('devbox:a1', good), good);
  assert.deepEqual(entryOf('devbox:a1', { ...good, extra: 'dropped', workspace: { ...good.workspace, reachable: true } }), good, 'only the entry\'s own fields');
  for (const [id, raw] of [['devbox:a1', null], ['devbox:a1', 'text'], ['laptop:a1', good], ['/Users/alex/oats', good], ['Devbox:a1', { ...good, server: 'Devbox' }],
    ['devbox:a1', { ...good, label: '' }], ['devbox:a1', { ...good, path: 'relative/path' }], ['devbox:a1', { ...good, reportedAt: 'yesterday' }],
    ['devbox:a1', { ...good, reportedAt: undefined }], ['devbox:a1', { ...good, workspace: { reachable: true } }], ['devbox:a1', { ...good, targetKey: 'other' }]]) {
    assert.equal(entryOf(id, raw), null, JSON.stringify([id, raw]));
  }
  // What observeIdentities stores reads back through it.
  for (const [id, e] of run([[devbox(), laptop()]]).memory) assert.deepEqual(entryOf(id, JSON.parse(JSON.stringify(e))), e);
});

/* ── The roster answer and the memory together, and the view a client shows from them ── */

/** What a terminal client holds in one run: nothing on disk, two empty Maps at the start. */
function client() {
  let rosterHeld = { remoteGroups: [], rosterAnswered: false, rosterFailure: null }, remembered = EMPTY();
  const local = [A, observed(A, { reachable: true, ...identity() }, [row(A, 'dev-a')])];
  return {
    /** One outcome of its roster read at `at`: the roster's three values, then the memory from what was reported. */
    take(outcome, at = AT) {
      const { reported, ...next } = remoteRosterState(rosterHeld, outcome, at);
      rosterHeld = next;
      if (reported) remembered = observeIdentities(remembered, reported, at);
      return reported;
    },
    /** `held` for panel-views.mjs, built per call from what it holds. */
    held(at = AT) {
      return { ctxs: [A], snapshot: { byWs: new Map([local, ...remotePanelEntries(rosterHeld.remoteGroups, at)]) }, ...rosterHeld, remembered: identityMemory(remembered),
        cli: CLI, observing: new Set(), remoteCollecting: false, home: '/Users/alex', at };
    },
    /** Where a machine is shown, and how: [the view that holds it, its state's key, where its identity is from, its note]. */
    shown(id) {
      const held = this.held(), model = views.viewModel(held, TUI), view = views.viewFor(held, id, TUI, model);
      if (!view) return null;
      const info = model.infos.get(id);
      return [view.id, deploymentState(views.deploymentEntry(info, view.primary)).key, info.identityFrom, info.note];
    },
    memory: () => [...remembered.memory.keys()],
  };
}
const answer = (groups) => ({ envelope: { schemaVersion: 1, ok: true, result: { groups } } });

test('answered, then unreachable, then back: the machine stays in its workspace, shown as not reached from memory', () => {
  const tui = client();
  // Before any answer: no machine, and nothing remembered to show one by.
  assert.deepEqual([tui.shown(R), tui.memory(), views.viewModel(tui.held(), TUI).views.map(v => v.id)], [null, [], [V_OATS]]);
  // Answered: devbox is in the oats view beside this machine's deployment, live, by its own report.
  assert.deepEqual(tui.take(answer([devbox(), laptop()])).map(g => g.id), ['devbox:a1', 'laptop:v1']);
  assert.deepEqual(tui.shown(R), [V_OATS, 'live', 'reported', null]);
  assert.deepEqual(tui.shown(V), [V_LAB, 'live', 'reported', null]);
  assert.deepEqual(views.viewModel(tui.held(), TUI).views.map(v => [v.id, v.deployments]), [[V_OATS, [A, R]], [V_LAB, [V]]]);
  // Unreachable, as the kernel reports one machine that did not answer: still in the oats view, from memory.
  tui.take(answer([down(devbox()), laptop()]));
  assert.deepEqual(tui.shown(R), [V_OATS, 'remembered', 'remembered', null]);
  assert.deepEqual(tui.shown(V), [V_LAB, 'live', 'reported', null]);
  assert.deepEqual(views.viewModel(tui.held(), TUI).views.map(v => [v.id, v.deployments]), [[V_OATS, [A, R]], [V_LAB, [V]]], 'the views are the same');
  assert.equal(views.panelData(tui.held(), V_OATS, TUI).deployments[1].reachable, false);
  // Unreachable, as a roster read that failed altogether: every machine keeps its place, and nothing is forgotten.
  assert.equal(tui.take({ thrown: 'spawn oats ETIMEDOUT' }), null);
  assert.deepEqual([tui.shown(R), tui.shown(V)], [[V_OATS, 'remembered', 'remembered', null], [V_LAB, 'remembered', 'remembered', null]]);
  assert.deepEqual(tui.memory(), ['devbox:a1', 'laptop:v1']);
  assert.equal(tui.held().rosterFailure, null, 'an answer has arrived: no failure sentence');
  const rows = views.panelData(tui.held(), V_OATS, TUI).instances.filter(i => i.deployment.id === R);
  assert.deepEqual(rows.map(i => [i.instance, i.running, i.serverUnreached]), [['far-a', null, true]], 'its last rows, their state unknown');
  // And the same through an envelope the kernel refused.
  tui.take({ envelope: { schemaVersion: 1, ok: false, error: { code: 'E_SERVERS_UNREADABLE', message: 'the server registry is not valid JSON' } } });
  assert.deepEqual(tui.shown(R), [V_OATS, 'remembered', 'remembered', null]);
  // Back: live again, by its own report.
  tui.take(answer([devbox(), laptop()]), LATER);
  assert.deepEqual([tui.shown(R), tui.shown(V)], [[V_OATS, 'live', 'reported', null], [V_LAB, 'live', 'reported', null]]);
});

test('a machine that never answered in this run is shown under its own name, not matched; one that moved says so', () => {
  const tui = client();
  // The first answer of the run lists devbox as not reached: nothing is remembered, so nothing places it.
  tui.take(answer([down(devbox()), laptop()]));
  assert.deepEqual(tui.shown(R), [R, 'unreached', null, null]);
  assert.deepEqual(views.viewModel(tui.held(), TUI).views.map(v => [v.id, v.name, v.unattached === true]), [[V_OATS, 'oats', false], [V_LAB, 'lab', false], [R, 'devbox', true]]);
  assert.deepEqual(tui.memory(), ['laptop:v1']);
  // It answers: it joins its workspace, and is remembered from then on.
  tui.take(answer([devbox(), laptop()]));
  assert.deepEqual([tui.shown(R), tui.memory()], [[V_OATS, 'live', 'reported', null], ['laptop:v1', 'devbox:a1']]);
  // It reports another workspace: it moves to that view, with the sentence.
  tui.take(answer([devbox(identity(LAB, 'aweb:lab')), laptop()]));
  assert.deepEqual(tui.shown(R), [V_LAB, 'live', 'reported', 'devbox now reports workspace lab.']);
  // Unreachable after the move: remembered in the view it moved to, the sentence kept.
  tui.take(answer([down(devbox()), laptop()]));
  assert.deepEqual(tui.shown(R), [V_LAB, 'remembered', 'remembered', 'devbox now reports workspace lab.']);
  // The answer no longer lists it: gone from the roster, and from the memory.
  tui.take(answer([laptop()]));
  assert.deepEqual([tui.shown(R), tui.memory()], [null, ['laptop:v1']]);
  // A gated read (the accepted CLI reads no other machine) empties the roster and reports nothing: the memory is as it was.
  tui.take({ gated: true });
  assert.deepEqual([tui.shown(V), tui.memory(), tui.held().rosterAnswered], [[V_LAB, 'remembered', 'remembered', null], ['laptop:v1'], false]);
});

test('the Desktop\'s store holds none of the rule: it keeps the Maps and the file, and calls the shared functions', () => {
  const store = readFileSync(new URL('../server/remote-identity.mjs', import.meta.url), 'utf8');
  assert.match(store, /import \{ entryOf, observeIdentities, identityMemory \} from '\.\.\/\.\.\/client\/remote-identity-memory\.mjs';/);
  assert.match(store, /observeIdentities\(held, groups, now\(\)\)/);
  assert.equal(store.match(/identityMemory\(held\)\.(get|all|note)\(/g).length, 3);
  // No second copy: the sentence, the patterns, the identity's reading and its view are named nowhere in the store.
  assert.doesNotMatch(store, /now reports (?:workspace|another workspace)|GROUP_ID|SERVER\b|readIdentity|attachment|viewId|sameIdentity|\.probe\b/);
  const declared = name => new RegExp(`(?:function\\*?|const|let|var|class)\\s+${name}\\b`).test(store);
  assert.deepEqual(['entryOf', 'observeIdentities', 'identityMemory'].filter(declared), []);
  // What stays the Desktop's: the file's cap, its parse and its atomic write.
  for (const name of ['MAX_ENTRIES', 'atomicWrite', 'parseRemoteIdentities', 'createRemoteIdentityStore']) assert.equal(declared(name), true, name);
});
