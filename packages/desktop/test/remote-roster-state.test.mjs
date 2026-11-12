// What an answer of `oats server roster --json` becomes for a client (packages/client/remote-roster.mjs
// `remoteRosterState` and `remotePanelEntries`, #855 3a), called as a second client calls them: with what
// it holds, the outcome of its read and the time of its call. The Desktop's own loop over them is
// server/oats-web.mjs `refreshRemoteSnapshot` and `readRemoteRoster`; this file reads its source to show it holds no second copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as roster from '../../client/remote-roster.mjs';
import { remoteRosterState, remotePanelEntries, remotePanel, unavailableGroups } from '../../client/remote-roster.mjs';
import { cliReadsRemotes } from '../../client/panel-views.mjs';
import { cliRemoteRoster } from '../../client/cli-adapter.mjs';
import { group, identity, remoteRow, LAB } from './helpers/workspace-views-fixture.mjs';

const AT = '2026-10-11T12:00:00.000Z';
const devbox = () => group('devbox:a1', 'devbox', '/home/alex/oats', identity(), [remoteRow('far-a', '/home/alex/oats')]);
const laptop = () => group('laptop:v1', 'laptop', '/srv/lab', identity(LAB, 'aweb:lab'), [remoteRow('lab-a', '/srv/lab', { running: false })]);
const ok = (groups) => ({ schemaVersion: 1, ok: true, result: { groups } });
const refused = (error) => ({ schemaVersion: 1, ok: false, ...(error === undefined ? {} : { error }) });
const NONE = { remoteGroups: [], rosterAnswered: false, rosterFailure: null };
const ROSTER = (message) => ({ code: 'E_REMOTE_ROSTER', message });
/** The three values a client keeps between reads, out of an answer. */
const kept = ({ remoteGroups, rosterAnswered, rosterFailure }) => ({ remoteGroups, rosterAnswered, rosterFailure });
/** Frozen at every depth: a write to any object or array of it throws. */
const frozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(frozen); }
  return value;
};

test('an ok envelope with groups: those groups, answered, no failure, and the groups reported', () => {
  const groups = [devbox(), laptop()];
  const next = remoteRosterState(NONE, { envelope: ok(groups) }, AT);
  assert.deepEqual(next, { remoteGroups: groups, rosterAnswered: true, rosterFailure: null, reported: groups });
  assert.equal(next.remoteGroups, groups, 'the answer\'s own groups, not a copy');
  assert.equal(next.reported, groups);
  // An answer that lists nothing is an answer: no groups held, and the memory is told so.
  assert.deepEqual(remoteRosterState(kept(next), { envelope: ok([]) }, AT), { remoteGroups: [], rosterAnswered: true, rosterFailure: null, reported: [] });
  // A failure sentence kept from before the first answer is cleared by it.
  assert.equal(remoteRosterState({ ...NONE, rosterFailure: 'Remote roster unavailable: timeout' }, { envelope: ok(groups) }, AT).rosterFailure, null);
});

test('gated: no groups and not answered, the failure sentence as it was, nothing reported', () => {
  assert.deepEqual(remoteRosterState(NONE, { gated: true }, AT), { remoteGroups: [], rosterAnswered: false, rosterFailure: null, reported: null });
  // After a good answer: the groups go, and the roster is no longer answered.
  const answered = kept(remoteRosterState(NONE, { envelope: ok([devbox(), laptop()]) }, AT));
  assert.deepEqual(remoteRosterState(answered, { gated: true }, AT), { remoteGroups: [], rosterAnswered: false, rosterFailure: null, reported: null });
  // The sentence is not this outcome's to clear (the Desktop clears it where it accepts another CLI).
  assert.deepEqual(remoteRosterState({ remoteGroups: [devbox()], rosterAnswered: false, rosterFailure: 'ssh: no route' }, { gated: true }, AT),
    { remoteGroups: [], rosterAnswered: false, rosterFailure: 'ssh: no route', reported: null });
});

test('an envelope that is not ok: the groups held, marked with its error; the sentence only while no answer has ever arrived', () => {
  const error = { code: 'E_SERVERS_UNREADABLE', message: 'the server registry is not valid JSON' };
  const held = [devbox(), laptop()];
  // Before any answer: the sentence is the error's message.
  const first = remoteRosterState({ ...NONE, remoteGroups: held }, { envelope: refused(error) }, AT);
  assert.deepEqual(first, { remoteGroups: unavailableGroups(held, error), rosterAnswered: false, rosterFailure: 'the server registry is not valid JSON', reported: null });
  for (const g of first.remoteGroups) { assert.deepEqual(g.probe, { ok: false, error }); assert.ok(g.instances.every(i => i.running === null)); }
  // After an answer: the groups are kept, marked, and there is no sentence.
  const answered = kept(remoteRosterState(NONE, { envelope: ok(held) }, AT));
  assert.deepEqual(remoteRosterState(answered, { envelope: refused(error) }, AT),
    { remoteGroups: unavailableGroups(held, error), rosterAnswered: true, rosterFailure: null, reported: null });
  // An error with no message, and no error at all: the sentence, and for no error the roster's own error on each group.
  assert.equal(remoteRosterState(NONE, { envelope: refused({ code: 'E_X' }) }, AT).rosterFailure, 'Remote roster unavailable');
  assert.deepEqual(remoteRosterState({ ...NONE, remoteGroups: held }, { envelope: refused({ code: 'E_X' }) }, AT).remoteGroups[0].probe, { ok: false, error: { code: 'E_X' } });
  const bare = remoteRosterState({ ...NONE, remoteGroups: held }, { envelope: refused() }, AT);
  assert.deepEqual([bare.rosterFailure, bare.remoteGroups[1].probe], ['Remote roster unavailable', { ok: false, error: ROSTER('Remote roster unavailable') }]);
  // A second failure before any answer replaces the sentence.
  assert.equal(remoteRosterState(kept(first), { envelope: refused({ code: 'E_SSH', message: 'ssh: no route' }) }, AT).rosterFailure, 'ssh: no route');
});

test('an ok envelope without a groups array: the groups held, marked, yet answered, with no sentence, and the marked groups reported', () => {
  const held = [devbox(), laptop()];
  for (const result of [{}, { groups: null }, { groups: 'devbox' }, { groups: { 0: devbox() } }]) {
    const next = remoteRosterState({ remoteGroups: held, rosterAnswered: false, rosterFailure: 'ssh: no route' }, { envelope: { schemaVersion: 1, ok: true, result } }, AT);
    const marked = unavailableGroups(held, ROSTER('Remote roster unavailable'));
    assert.deepEqual(next, { remoteGroups: marked, rosterAnswered: true, rosterFailure: null, reported: marked }, JSON.stringify(result));
    assert.equal(next.reported, next.remoteGroups);
    assert.ok(next.reported.every(g => g.probe.ok === false), 'no group in them is reached, so a memory of identities takes no report from it');
  }
  // With nothing held it is an answer with no groups.
  assert.deepEqual(remoteRosterState(NONE, { envelope: { schemaVersion: 1, ok: true, result: {} } }, AT), { remoteGroups: [], rosterAnswered: true, rosterFailure: null, reported: [] });
});

test('thrown: the groups held, marked with the sentence that carries the message; the sentence kept only while no answer has ever arrived', () => {
  const held = [devbox()], sentence = 'Remote roster unavailable: spawn oats ENOENT';
  assert.deepEqual(remoteRosterState({ ...NONE, remoteGroups: held }, { thrown: 'spawn oats ENOENT' }, AT),
    { remoteGroups: unavailableGroups(held, ROSTER(sentence)), rosterAnswered: false, rosterFailure: sentence, reported: null });
  assert.deepEqual(remoteRosterState({ remoteGroups: held, rosterAnswered: true, rosterFailure: null }, { thrown: 'spawn oats ENOENT' }, AT),
    { remoteGroups: unavailableGroups(held, ROSTER(sentence)), rosterAnswered: true, rosterFailure: null, reported: null });
  // No previous groups: nothing to mark, the sentence still said.
  assert.deepEqual(remoteRosterState(NONE, { thrown: 'timeout' }, AT), { remoteGroups: [], rosterAnswered: false, rosterFailure: 'Remote roster unavailable: timeout', reported: null });
  // What was thrown had no message (the Desktop passes `e.message`): the sentence the Desktop has always built.
  assert.equal(remoteRosterState(NONE, { thrown: undefined }, AT).rosterFailure, 'Remote roster unavailable: undefined');
});

test('a group that cannot be projected makes the whole answer a thrown one: the last readable roster is never replaced by an unreadable one', () => {
  const held = [devbox(), laptop()], answered = { remoteGroups: held, rosterAnswered: true, rosterFailure: null };
  for (const bad of [null, {}, { id: 'build:r1', server: 'build' }, { ...devbox(), probe: undefined }, { ...devbox(), target: null }, { ...devbox(), instances: [null] }]) {
    let message; try { remotePanel(bad, AT); } catch (e) { message = e.message; }
    assert.equal(typeof message, 'string', 'remotePanel throws on it');
    const sentence = `Remote roster unavailable: ${message}`;
    // One unreadable group among readable ones, in any place.
    for (const groups of [[bad], [devbox(), bad], [bad, laptop()]]) {
      assert.deepEqual(remoteRosterState(answered, { envelope: ok(groups) }, AT),
        { remoteGroups: unavailableGroups(held, ROSTER(sentence)), rosterAnswered: true, rosterFailure: null, reported: null }, JSON.stringify(bad));
      assert.equal(remoteRosterState({ ...answered, rosterAnswered: false }, { envelope: ok(groups) }, AT).rosterFailure, sentence);
    }
  }
  // An envelope that cannot be read at all is the same case, with the message of what reading it threw.
  for (const envelope of [null, undefined]) {
    let message; try { envelope.ok; } catch (e) { message = e.message; }
    const next = remoteRosterState({ ...answered, rosterAnswered: false }, { envelope }, AT);
    assert.deepEqual(next, { remoteGroups: unavailableGroups(held, ROSTER(`Remote roster unavailable: ${message}`)), rosterAnswered: false,
      rosterFailure: `Remote roster unavailable: ${message}`, reported: null });
  }
});

test('a failed first answer, then a good one, then a failed one: the sentence is kept, cleared, and not said again', () => {
  let state = NONE;
  const take = (outcome) => { const next = remoteRosterState(state, outcome, AT); state = kept(next); return next; };
  assert.deepEqual(take({ thrown: 'timeout' }), { remoteGroups: [], rosterAnswered: false, rosterFailure: 'Remote roster unavailable: timeout', reported: null });
  assert.deepEqual(take({ envelope: refused({ code: 'E_SSH', message: 'ssh: no route' }) }), { remoteGroups: [], rosterAnswered: false, rosterFailure: 'ssh: no route', reported: null });
  const groups = [devbox(), laptop()];
  assert.deepEqual(take({ envelope: ok(groups) }), { remoteGroups: groups, rosterAnswered: true, rosterFailure: null, reported: groups });
  const failed = take({ thrown: 'timeout' });
  assert.deepEqual(failed, { remoteGroups: unavailableGroups(groups, ROSTER('Remote roster unavailable: timeout')), rosterAnswered: true, rosterFailure: null, reported: null });
  assert.deepEqual(failed.remoteGroups.map(g => g.id), ['devbox:a1', 'laptop:v1'], 'the groups are kept');
  // A second failure marks the same groups again, with the newer error; then the roster is back.
  assert.deepEqual(take({ envelope: refused({ code: 'E_SSH', message: 'ssh: no route' }) }).remoteGroups.map(g => g.probe.error.code), ['E_SSH', 'E_SSH']);
  const back = take({ envelope: ok(groups) });
  assert.deepEqual([back.remoteGroups, back.reported, back.rosterFailure], [groups, groups, null]);
});

test('the time is required, and it is the caller\'s: no outcome is answered without one, and nothing reads the clock', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2031-03-04T05:06:07.000Z') });
  for (const outcome of [{ gated: true }, { thrown: 'x' }, { envelope: ok([devbox()]) }, { envelope: refused() }]) {
    for (const at of [undefined, null, '', 0, new Date(0)]) {
      assert.throws(() => remoteRosterState(NONE, outcome, at), (e) => e instanceof TypeError && e.message === 'remoteRosterState: at must be the time of the call, a non-empty string');
    }
    assert.doesNotMatch(JSON.stringify(remoteRosterState(NONE, outcome, AT)), /2031-/);
  }
  for (const at of [undefined, null, '', 0]) {
    assert.throws(() => remotePanelEntries([], at), (e) => e instanceof TypeError && e.message === 'remotePanelEntries: at must be the time of the call, a non-empty string');
  }
  // A missing time is the caller's mistake, never a roster that "could not be read".
  assert.throws(() => remoteRosterState(NONE, { envelope: ok([devbox()]) }), TypeError);
});

test('remotePanelEntries: each group\'s panel under the key the snapshot gives it, in the roster\'s order, all made at the one time', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2031-03-04T05:06:07.000Z') });
  const groups = [laptop(), devbox(), ...unavailableGroups([group('build:r1', 'build', '/home/alex/web', null, [remoteRow('web-a', '/home/alex/web')])], { code: 'E_SSH', message: 'Connection refused' })];
  const entries = remotePanelEntries(groups, AT);
  assert.deepEqual(entries.map(([id]) => id), ['remote:laptop:v1', 'remote:devbox:a1', 'remote:build:r1']);
  assert.deepEqual(entries, groups.map(g => [`remote:${g.id}`, remotePanel(g, AT)]));
  for (const [id, panel] of entries) { assert.equal(panel.workspace.id, id); assert.equal(panel.generatedAt, AT); }
  assert.equal(entries[2][1].error, 'Connection refused');
  assert.deepEqual(remotePanelEntries([], AT), []);
  // They fill a Map as the Desktop fills its snapshot.
  assert.deepEqual([...new Map(entries).keys()], entries.map(([id]) => id));
});

test('cliReadsRemotes: an accepted CLI whose `remote` lists roster, and nothing else', () => {
  assert.equal(cliReadsRemotes({ ok: true, remote: ['roster'] }), true);
  assert.equal(cliReadsRemotes({ ok: true, remote: ['connect', 'roster', 'remove'] }), true);
  for (const cli of [{ ok: false, remote: ['roster'] }, { ok: true }, { ok: true, remote: [] }, { ok: true, remote: ['connect'] }, { ok: true, remote: null }, { ok: false, probedAt: 0, tried: [] }, {}]) {
    assert.equal(cliReadsRemotes(cli), false, JSON.stringify(cli));
  }
  // The gate a client applies before its read: without it the outcome is `gated`.
  const cli = { ok: true, remote: [] };
  assert.deepEqual(remoteRosterState(NONE, cliReadsRemotes(cli) ? { thrown: 'never read' } : { gated: true }, AT).reported, null);
});

test('nothing given is changed: every outcome over a frozen previous, a frozen outcome and frozen groups', () => {
  const held = () => frozen([devbox(), laptop()]);
  const outcomes = () => [{ gated: true }, { thrown: 'timeout' }, { envelope: ok([devbox(), laptop()]) }, { envelope: ok([]) }, { envelope: ok([null]) },
    { envelope: { schemaVersion: 1, ok: true, result: {} } }, { envelope: refused({ code: 'E_SSH', message: 'ssh: no route' }) }, { envelope: refused() }];
  for (const answered of [false, true]) {
    outcomes().forEach((outcome, n) => {
      const previous = frozen({ remoteGroups: held(), rosterAnswered: answered, rosterFailure: answered ? null : 'ssh: no route' });
      const before = JSON.stringify([previous, outcome]);
      const next = remoteRosterState(previous, frozen(outcome), AT);
      assert.equal(JSON.stringify([previous, outcome]), before, `outcome ${n}`);
      // And the same call answers the same.
      assert.deepEqual(remoteRosterState(previous, outcome, AT), next, `outcome ${n}`);
      assert.doesNotThrow(() => remotePanelEntries(frozen(next.remoteGroups), AT));
    });
  }
  const groups = held(), before = JSON.stringify(groups);
  remotePanelEntries(groups, AT);
  assert.equal(JSON.stringify(groups), before);
});

// Who made the text of a row of a machine that was not reached (#982): the kernel's when the installed CLI
// printed the error, the client's read otherwise. The kernel's mark is on the error object, set where the
// answer is parsed, so each case here is read as a client reads it: `cliRemoteRoster` over what was printed,
// its answer to `remoteRosterState`, the groups it answers to `remotePanel`.
test('the speaker of a not-reached row through a client\'s whole path: read, held groups, a later failed read, and back', async () => {
  const printing = (document) => (_bin, _argv, _options, done) => done(null, typeof document === 'string' ? document : JSON.stringify(document));
  const read = (exec) => cliRemoteRoster('/abs/oats', { exec });
  const speakers = (groups) => groups.map(g => remotePanel(g, AT).instances.map(i => [i.runtimeError, i.runtimeErrorOrigin]));
  let state = NONE;
  const take = (outcome) => { const next = remoteRosterState(state, outcome, AT); state = kept(next); return speakers(next.remoteGroups); };

  // A roster the kernel answered: one server reached, one not, with the kernel's own error for it.
  const down = { ...laptop(), probe: { ok: false, error: { code: 'E_SSH', message: 'ssh: connect to host laptop: No route to host' } } };
  assert.deepEqual(take({ envelope: await read(printing(ok([devbox(), down]))) }),
    [[[undefined, undefined]], [['ssh: connect to host laptop: No route to host', 'kernel']]]);
  // Held, and projected again later from the same objects: still the kernel's.
  assert.deepEqual(speakers(state.remoteGroups)[1], [['ssh: connect to host laptop: No route to host', 'kernel']]);

  // The next read threw: the groups are kept, and each row's text is now the read's own sentence.
  const thrown = 'Remote roster unavailable: spawn oats ENOENT';
  assert.deepEqual(take({ thrown: 'spawn oats ENOENT' }), [[[thrown, 'roster-read']], [[thrown, 'roster-read']]]);

  // The kernel refused the whole read, in an envelope it printed: the kernel's, on every kept row.
  assert.deepEqual(take({ envelope: await read(printing(refused({ code: 'E_LOCK_HELD', message: 'another oats command holds the lock' }))) }),
    [[['another oats command holds the lock', 'kernel']], [['another oats command holds the lock', 'kernel']]]);

  // The read wrote the envelope itself: it timed out, or what the CLI printed is not the contract's. The client's, never "OATS says".
  const killed = (_bin, _argv, _options, done) => done(Object.assign(new Error('killed'), { killed: true }), '');
  assert.deepEqual(take({ envelope: await read(killed) }), [[['oats did not answer within 60s', 'roster-read']], [['oats did not answer within 60s', 'roster-read']]]);
  for (const garbage of ['', 'not json', '{"schemaVersion":2}', JSON.stringify({ schemaVersion: 1, ok: false })]) {
    const text = 'oats did not print a valid JSON envelope on stdout';
    assert.deepEqual(take({ envelope: await read(printing(garbage)) }), [[[text, 'roster-read']], [[text, 'roster-read']]], garbage);
  }

  // An answer that cannot be kept: no groups array, or a group that cannot be projected. The read's own sentence.
  assert.deepEqual(take({ envelope: await read(printing({ schemaVersion: 1, ok: true, result: {} })) }),
    [[['Remote roster unavailable', 'roster-read']], [['Remote roster unavailable', 'roster-read']]]);
  const [[[unreadable, origin]]] = take({ envelope: await read(printing(ok([devbox(), { id: 'build:r1', server: 'build' }]))) });
  assert.match(unreadable, /^Remote roster unavailable: /); assert.equal(origin, 'roster-read');

  // An envelope made by hand (not parsed from the CLI) carries no mark, whatever it says of itself.
  assert.deepEqual(take({ envelope: refused({ code: 'E_SSH', message: 'ssh: no route', origin: 'kernel', runtimeErrorOrigin: 'kernel' }) }),
    [[['ssh: no route', 'roster-read']], [['ssh: no route', 'roster-read']]]);

  // And the roster is back: the reached server's rows have no text and no key.
  assert.deepEqual(take({ envelope: await read(printing(ok([devbox(), laptop()]))) }), [[[undefined, undefined]], [[undefined, undefined]]]);
});

test('the Desktop\'s server hands the roster\'s answer on as it was read: the same objects reach remoteRosterState, so the kernel\'s mark is kept', () => {
  const server = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const read = server.match(/async function readRemoteRoster\([^]*?\n\}/)[0], take = server.match(/function takeRosterOutcome\([^]*?\n\}/)[0];
  // Filtered or not (#1124), the envelope is handed on as the adapter answered it.
  assert.match(read, /const envelope = await \(asked \? adapter\.cliRemoteRoster\(probe\.bin, \{ workspaceKeys: asked\.keys \}\) : adapter\.cliRemoteRoster\(probe\.bin\)\);\s*if \(cliState !== probe\) return;\s*takeRosterOutcome\(asked \? \{ envelope, asked \} : \{ envelope \}\);/);
  assert.match(take, /\(\{ remoteGroups, rosterAnswered, rosterFailure \} = next\);/);
  // Between the read and the panel nothing copies a group: no clone and no JSON round trip of what is held.
  for (const body of [read, take, server.match(/function mergeRemotePanels\([^]*?\n\}/)[0]]) assert.doesNotMatch(body, /structuredClone|JSON\.(parse|stringify)|\.\.\.\s*(g|group|envelope)\b/);
});

test('the Desktop\'s server holds none of the rule: it calls the shared functions and builds no roster sentence of its own', () => {
  const server = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const cut = (name) => server.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
  const loop = cut('refreshRemoteSnapshot'), read = cut('readRemoteRoster'), merge = cut('mergeRemotePanels'), take = cut('takeRosterOutcome');
  assert.match(take, /const at = new Date\(\)\.toISOString\(\);\s*const next = remote\.remoteRosterState\(\{ remoteGroups, rosterAnswered, rosterFailure \}, outcome, at\)/);
  assert.match(take, /if \(next\.reported\) remoteIdentities\.observe\(next\.reported\)/);
  assert.match(merge, /remote\.remotePanelEntries\(remoteGroups, new Date\(\)\.toISOString\(\), keptReadAt\)/);
  assert.match(read, /if \(!cliReadsRemotes\(probe\)\) \{ takeRosterOutcome\(\{ gated: true \}\); return; \}/);
  // No second copy: the sentence, the roster's error code, the marking of groups and the projection of one are named nowhere in the server.
  assert.doesNotMatch(server, /Remote roster unavailable|E_REMOTE_ROSTER|unavailableGroups|remote\.remotePanel\(|remote\?\.includes\("roster"\)/);
  // What stays the Desktop's: one read at a time (a caller that asks while one runs joins it), and an answer read
  // under another kernel record is dropped and read again.
  assert.match(loop, /remoteRead \|\|= /);
  assert.equal(read.match(/if \(cliState !== probe\) return;/g).length, 2);
  assert.match(loop, /do \{ probe = cliState; await readRemoteRoster\(probe\); \} while \(cliState !== probe\);/);
  assert.match(loop, /\.finally\(\(\) => \{ remoteRead = null; \}\)/);
  // The names read are the shared module's own.
  for (const name of ['remoteRosterState', 'remotePanelEntries']) assert.equal(typeof roster[name], 'function', name);
});
