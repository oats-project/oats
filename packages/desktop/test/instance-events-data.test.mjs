import test from 'node:test';
import assert from 'node:assert/strict';
import { eventsData, eventsIncomplete, eventIncarnation, EVENT_TITLES } from '../renderer/instance-events-data.mjs';
import { EVENTS_WITHHELD } from '../../client/instance-events-contract.mjs';
import { target, birth, event, data, launchPromptEvent, launchPromptEvent052, launchPromptMiss052 } from './helpers/instance-events-fixture.mjs';
import { differed, DIFFERED } from './helpers/launch-prompt-fixture.mjs';

test('launch-prompt audit rows preserve bounded reported outcomes across private and public projection', () => {
  assert.equal(EVENT_TITLES['launch-prompt'], 'Launch prompt');
  const rows = [launchPromptEvent(), event({ kind: 'launch-prompt', data: { action: 'restore-geometry', status: 'failed',
    consentSource: null, previous: { width: 80, height: 24 } } })];
  const out = eventsData(data(rows), target);
  assert.ok(out);
  assert.deepEqual(out.events.map(row => row.data), [
    { status: 'submitted', class: 'awebDevelopmentChannel', consentSource: rows[0].data.consentSource, signatureId: 'fixture-aweb' },
    { status: 'failed', action: 'restore-geometry', consentSource: null },
  ]);
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
  const blocked = event({ kind: 'launch-prompt', data: { startId: 'fixture-launch', status: 'blocked', reason: 'blocked: unexpected prompt' } });
  assert.deepEqual(eventsData(data([blocked]), target).events[0].data, { status: 'blocked', reason: 'blocked: unexpected prompt' });
  const incomplete = event({ kind: 'launch-prompt', data: { status: 'incomplete', reason: 'launch prompt audit failed' } });
  assert.deepEqual(eventsData(data([incomplete]), target).events[0].data, { status: 'incomplete', reason: 'launch prompt audit failed' });
});

test('launch-prompt facts retain event detail bounds and redaction without exposing receipt payloads', () => {
  for (const key of ['status', 'class', 'action', 'consentSource', 'reason']) {
    const out = eventsData(data([launchPromptEvent({ [key]: 'token: PRIVATE', screen: 'PRIVATE', receipt: [{ secret: 'PRIVATE' }] })]), target);
    assert.ok(out); assert.equal(out.events[0].data[key], EVENTS_WITHHELD);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
    assert.equal(eventsData(data([launchPromptEvent({ [key]: 'x'.repeat(4097) })]), target), null);
    assert.equal(eventsData(data([launchPromptEvent({ [key]: {} })]), target), null);
  }
  const out = eventsData(data([launchPromptEvent({ consentSource: null })]), target);
  assert.equal(out.events[0].data.consentSource, null);
});

// OATS 0.52.0 (#917): the Claude version, the entry of the recognised screen and, on a miss, what differed.
test('launch-prompt rows of 0.52: the version, the entry of the recognised screen and what a miss differed in; pane, digest and key stay unread', () => {
  const rows = [launchPromptEvent052({ status: 'attempted' }), launchPromptEvent052(), launchPromptMiss052(differed())];
  const out = eventsData(data(rows), target);
  assert.deepEqual(out.events.map(row => row.data), [
    { status: 'attempted', class: 'awebDevelopmentChannel', claudeVersion: '2.1.296', signatureId: 'aweb-dev-channel-confirmation-1' },
    { status: 'submitted', class: 'awebDevelopmentChannel', claudeVersion: '2.1.296', signatureId: 'aweb-dev-channel-confirmation-1' },
    { status: 'blocked', reason: 'blocked: unexpected prompt', claudeVersion: '2.1.296', differed: DIFFERED },
  ]);
  // The server projects, then main and the renderer project again: the same answer.
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
  assert.deepEqual(eventsData(JSON.parse(JSON.stringify(out)), target, 100, { publicView: true }), out);
  assert.doesNotMatch(JSON.stringify(out.events.map(row => row.data)), /executable-path|fixture-launch-052|"key"|bbbb|cccc|inert|%2/);
  // "unknown" is a version as the kernel reports it.
  assert.equal(eventsData(data([launchPromptEvent052({ claudeVersion: 'unknown', claudeVersionSource: 'unknown' })]), target).events[0].data.claudeVersion, 'unknown');
});
test('launch-prompt: a log holds rows of both generations, each with the facts its kernel wrote', () => {
  const out = eventsData(data([launchPromptEvent(), launchPromptMiss052(differed()), launchPromptEvent052()]), target);
  assert.deepEqual(out.events.map(row => Object.keys(row.data)), [['status', 'class', 'consentSource', 'signatureId'],
    ['status', 'reason', 'claudeVersion', 'differed'], ['status', 'class', 'claudeVersion', 'signatureId']]);
  assert.equal(out.events[0].data.consentSource, launchPromptEvent().data.consentSource);
});
test('launch-prompt: a malformed new fact drops that fact, never the read', () => {
  const plain = eventsData(data([launchPromptMiss052(undefined)]), target).events[0].data;
  assert.deepEqual(plain, { status: 'blocked', reason: 'blocked: unexpected prompt', claudeVersion: '2.1.296' });
  for (const bad of ['a string', 7, null, [], {}, differed({ index: -1 }), differed({ found: 7 }), differed({ expected: 'x'.repeat(41) })]) {
    const out = eventsData(data([launchPromptMiss052(bad)]), target);
    assert.ok(out, JSON.stringify(bad)); assert.deepEqual(out.events[0].data, plain);
  }
  for (const key of ['claudeVersion', 'signatureId']) for (const bad of [2.1, null, {}, [], '', 'x'.repeat(4097), true]) {
    const out = eventsData(data([launchPromptEvent052({ [key]: bad })]), target);
    assert.ok(out, `${key}: ${JSON.stringify(bad)}`); assert.equal(Object.hasOwn(out.events[0].data, key), false);
    assert.equal(out.events[0].data.status, 'submitted');
  }
  // Unsafe text is withheld, as every event detail is.
  assert.equal(eventsData(data([launchPromptEvent052({ claudeVersion: 'token: PRIVATE' })]), target).events[0].data.claudeVersion, EVENTS_WITHHELD);
  // A listed key still refuses the read when malformed: the tolerance is for the new facts only.
  assert.equal(eventsData(data([launchPromptEvent052({ status: {} })]), target), null);
});
test('launch-prompt: what differed is read only on a blocked row', () => {
  for (const status of ['incomplete', 'completed', 'submitted', 'attempted']) {
    const out = eventsData(data([launchPromptMiss052(differed(), { status })]), target);
    assert.equal(Object.hasOwn(out.events[0].data, 'differed'), false, status);
  }
  // Each side is a display line; the terminal's bidi controls are replaced.
  const out = eventsData(data([launchPromptMiss052(differed({ found: 'a\u202Eb\tc', expected: '' }))]), target);
  assert.deepEqual(out.events[0].data.differed, { ...DIFFERED, expected: null, found: 'a\uFFFDb c' });
});

test('address history preserves earlier/current/unknown incarnations without runtime inference', () => {
  const rows = [event({ incarnation: '2025-01-01T00:00:00.000Z' }), event({ incarnation: null }), event()];
  const out = eventsData(data(rows), target);
  assert.ok(out); assert.deepEqual(out.events.map(r => eventIncarnation(r, out)), ['earlier', 'unknown', 'current']);
  assert.equal(out.waitingOnYou, null); assert.equal(Object.hasOwn(out, 'running'), false);
  assert.equal(eventsIncomplete(out), false);
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
});
test('empty is recorded-empty, not idle/not-waiting; absent sources remain typed', () => {
  const value = data([]); value.integrity.sources.forEach(s => { s.status = 'absent'; s.bytes = 0; });
  const out = eventsData(value, target); assert.ok(out); assert.equal(out.returned, 0);
  assert.equal(out.lastEvent, null); assert.equal(out.waitingOnYou, null); assert.deepEqual(out.waitingClaims, []);
  assert.equal(eventsIncomplete(out), false);
});
for (const [label, alter] of [
  ['torn', v => v.integrity.unreadableRows = 2], ['foreign', v => v.integrity.foreignRows = 1],
  ['refused home', v => { v.integrity.sources[0].status = 'refused'; v.integrity.sources[0].bytes = 0; }],
  ['tail source', v => { v.integrity.sources[0].status = 'tail'; v.integrity.sources[0].bytes = 5000000; v.truncated = true; }],
]) test(`${label} incompleteness survives even an empty selected window`, () => {
  const value = data([]); alter(value);
  const out = eventsData(value, target); assert.ok(out); assert.equal(out.returned, 0); assert.equal(eventsIncomplete(out), true);
  assert.deepEqual(out.integrity, value.integrity);
});
test('source byte count is total size, not bytes read; window count is observed rows, not current instances', () => {
  const rows = Array.from({ length: 50 }, () => event()); const value = data(rows);
  value.count = 9535; value.truncated = true; value.integrity.sources[0] = { path: 'home', status: 'tail', bytes: 5000000 };
  const out = eventsData(value, target, 50); assert.ok(out); assert.equal(out.count, 9535); assert.equal(out.returned, 50);
  assert.equal(eventsData(value, target, 100), null, 'echo must agree with the requested limit');
  assert.equal(out.events.length, 50, 'never dedup already projected rows by guessed identity');
});
test('the top claim follows the kernel: the newest with a message, a newer text-less claim adding only its reason (#1502)', () => {
  const value = data();
  // The board's question (a message), then a harness dialog (none): the kernel's top is the board's.
  value.waitingClaims = [{ producer: 'oats.board', waiting: true, since: '2026-09-22T01:00:00.000Z', reason: 'attention', message: 'Squash?' },
    { producer: 'pi.harness', waiting: true, since: '2026-09-22T02:00:00.000Z', reason: 'permission', message: null }];
  value.waitingOnYou = { producer: 'oats.board', since: '2026-09-22T01:00:00.000Z', reason: 'attention', message: 'Squash?' };
  const out = eventsData(value, target); assert.ok(out, 'not a protocol error');
  assert.equal(out.waitingOnYou.producer, 'oats.board'); assert.equal(out.waitingClaims[1].reason, 'permission');
  value.waitingOnYou = { producer: 'pi.harness', since: '2026-09-22T02:00:00.000Z', reason: 'permission', message: null };
  assert.equal(eventsData(value, target), null, 'the text-less claim is not the top');
  // A message without a reason takes the newer text-less claim's.
  value.waitingClaims[0].reason = null;
  value.waitingOnYou = { producer: 'oats.board', since: '2026-09-22T01:00:00.000Z', reason: 'permission', message: 'Squash?' };
  assert.ok(eventsData(value, target));
});
test('positive claims are attributed; cleared producers stay false and top must match newest positive', () => {
  const value = data();
  value.waitingClaims = [{ producer: 'provider.a', waiting: true, since: '2026-09-22T01:00:00.000Z', reason: 'review requested' },
    { producer: 'provider.b', waiting: true, since: '2026-09-22T02:00:00.000Z', reason: 'answer requested' },
    { producer: 'provider.c', waiting: false, since: '2026-09-22T03:00:00.000Z', reason: null }];
  value.waitingOnYou = { producer: 'provider.b', since: '2026-09-22T02:00:00.000Z', reason: 'answer requested' };
  const out = eventsData(value, target); assert.ok(out); assert.equal(out.waitingOnYou.producer, 'provider.b'); assert.equal(out.waitingClaims[2].waiting, false);
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
  value.waitingOnYou.producer = 'provider.a'; assert.equal(eventsData(value, target), null);
});
test('claim can predate row window; consumer does not infer a clear from absence in selected rows', () => {
  const value = data(Array.from({ length: 50 }, () => event())); value.count = 500; value.truncated = true;
  value.waitingClaims = [{ producer: 'provider.a', waiting: true, since: birth, reason: null }];
  value.waitingOnYou = { producer: 'provider.a', since: birth, reason: null };
  assert.ok(eventsData(value, target, 50));
});
test('null incarnation never licenses a current waiting state, even from a previously tagged row', () => {
  const value = data(); value.incarnation = null;
  assert.ok(eventsData(value, { ...target, incarnation: null }), 'address history remains observable, not current-incarnation proof');
  value.waitingClaims = [{ producer: 'old', waiting: true, since: birth, reason: null }];
  value.waitingOnYou = { producer: 'old', since: birth, reason: null };
  assert.equal(eventsData(value, { ...target, incarnation: null }), null);
  value.waitingClaims[0].waiting = false; value.waitingOnYou = null;
  assert.equal(eventsData(value, { ...target, incarnation: null }), null, 'an unknown incarnation cannot certify cleared state either');
});
for (const [label, alter] of [
  ['API1 result', v => v.eventsApi = 1], ['wrong address', v => v.home = '/elsewhere'], ['wrong name', v => v.instance = 'other'],
  ['wrong birth', v => v.incarnation = '2025-01-01T00:00:00.000Z'], ['invalid birth', v => v.incarnation = 'today'],
  ['future row', v => v.events[0].eventsApi = 3], ['foreign row', v => v.events[0].home = '/foreign'],
  ['foreign row name', v => v.events[0].instance = 'other'], ['row missing birth', v => delete v.events[0].incarnation],
  ['invalid ISO', v => v.events[0].at = '2026-02-30T00:00:00.000Z'], ['row count', v => v.returned = 0],
  ['unsafe count', v => v.count = Number.MAX_SAFE_INTEGER + 1], ['missing truncation', v => v.count = 500],
  ['false truncation', v => v.truncated = true], ['stale summary', v => v.lastEvent.kind = 'stopped'],
  ['missing summary', v => v.lastEvent = null], ['incorrect summary birth', v => v.lastEvent.incarnation = null],
  ['negative corruption', v => v.integrity.unreadableRows = -1], ['source missing', v => v.integrity.sources.pop()],
  ['source duplicated', v => v.integrity.sources[1].path = 'home'], ['source filesystem path', v => v.integrity.sources[0].path = '/private/log'],
  ['tail without flag', v => { v.integrity.sources[0].status = 'tail'; v.integrity.sources[0].bytes = 5000000; }],
  ['oversize ok source', v => v.integrity.sources[0].bytes = 5000000], ['absent with bytes', v => v.integrity.sources[0].status = 'absent'],
  ['unbacked rows', v => v.integrity.sources.forEach(s => { s.status = 'refused'; s.bytes = 0; })],
  ['invented waiting', v => v.waitingOnYou = { producer: 'x', since: birth, reason: null }],
  ['oversize claims', v => v.waitingClaims = Array(201).fill({ producer: 'x', waiting: false, since: birth, reason: null })],
  ['nonboolean claim', v => v.waitingClaims = [{ producer: 'x', waiting: 'false', since: birth, reason: null }]],
  ['duplicate claim', v => v.waitingClaims = Array(2).fill({ producer: 'x', waiting: false, since: birth, reason: null })],
  ['false reason', v => v.waitingClaims = [{ producer: 'x', waiting: false, since: birth, reason: 'not current' }]],
  ['unbounded reason', v => v.events[0].data.reason = 'x'.repeat(2049)],
]) test(`malformed or contradictory ${label} refuses instead of certifying healthy evidence`, () => {
  const value = data(); alter(value); assert.equal(eventsData(value, target), null);
});
test('rows must preserve producer chronology; earlier-incarnation last row is not replaced with current', () => {
  const value = data([event({ at: '2026-09-22T02:00:00.000Z' }), event()]); assert.equal(eventsData(value, target), null);
  const earlier = data([event({ incarnation: '2025-01-01T00:00:00.000Z', kind: 'retired', data: {} })]);
  const out = eventsData(earlier, target); assert.equal(out.lastEvent.kind, 'retired'); assert.equal(eventIncarnation(out.lastEvent, out), 'earlier');
});
test('allowlisted facts redact reason credentials/URLs, omit task/env/commands and expose target counts only', () => {
  const value = data([event({ kind: 'stopped', data: { signal: 'SIGTERM', waitedMs: 10, state: 'shell', stillRunning: [{ pid: 123, comm: 'PRIVATE' }],
    reason: 'token=PRIVATE', task: 'PRIVATE', env: { secret: 'PRIVATE' }, command: 'PRIVATE' } })]);
  value.notes = ['PRIVATE']; value.recipe = 'PRIVATE';
  const out = eventsData(value, target); assert.ok(out);
  assert.deepEqual(out.events[0].data, { signal: 'SIGTERM', state: 'shell', waitedMs: 10, reason: EVENTS_WITHHELD, stillRunningCount: 1 });
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE|"pid"|"comm"|"task"|"env"|"recipe"/);
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
  value.events[0].data.reason = 'visit https://private.example/secret'; assert.equal(eventsData(value, target).events[0].data.reason, EVENTS_WITHHELD);
});
test('unknown kinds remain explicit rows, not fabricated current activity or silently omitted', () => {
  const value = data([event({ kind: 'future-kind', data: { task: 'PRIVATE' } })]);
  const out = eventsData(value, target); assert.equal(out.events.length, 1); assert.equal(out.lastEvent.kind, 'future-kind');
  assert.deepEqual(out.events[0].data, {}); assert.equal(out.waitingOnYou, null);
});
test('projection owns copied data and does not mutate producer rows, claims or integrity', () => {
  const raw = data(), before = structuredClone(raw), out = eventsData(raw, target);
  assert.deepEqual(raw, before); out.events[0].data.agent = 'changed'; out.integrity.sources[0].bytes = 0;
  assert.deepEqual(raw, before);
});

// Spec D (waiting-on-you): a claim's optional `message`, validated like the status row's.
const claimed = (claimMessage, topMessage) => {
  const value = data();
  const claim = { producer: 'provider.a', waiting: true, since: birth, reason: 'permission' };
  const top = { producer: 'provider.a', since: birth, reason: 'permission' };
  if (claimMessage !== undefined) claim.message = claimMessage;
  if (topMessage !== undefined) top.message = topMessage;
  value.waitingClaims = [claim]; value.waitingOnYou = top;
  return value;
};
test('a claim message is passed through on the claim and on waitingOnYou, as text', () => {
  const out = eventsData(claimed('Allow <b>rm</b>?', 'Allow <b>rm</b>?'), target); assert.ok(out);
  assert.equal(out.waitingOnYou.message, 'Allow <b>rm</b>?'); assert.equal(out.waitingClaims[0].message, 'Allow <b>rm</b>?');
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
});
test('a kernel without messages (key absent on both sides) passes, and message reads null', () => {
  const out = eventsData(claimed(undefined, undefined), target); assert.ok(out);
  assert.equal(out.waitingOnYou.message, null); assert.equal(out.waitingClaims[0].message, null);
  assert.deepEqual(eventsData(out, target, 100, { publicView: true }), out);
  const cleared = data(); cleared.waitingClaims = [{ producer: 'provider.a', waiting: false, since: birth, reason: null }];
  assert.equal(eventsData(cleared, target).waitingClaims[0].message, null);
});
for (const [label, claimMessage, topMessage] of [
  ['mismatched', 'Allow rm?', 'Allow ls?'], ['top-only', undefined, 'Allow rm?'], ['claim-only', 'Allow rm?', undefined],
  ['null against text', null, 'Allow rm?'],
]) test(`a ${label} waiting message refuses the read (waitingOnYou must be the newest positive claim)`, () => {
  assert.equal(eventsData(claimed(claimMessage, topMessage), target), null);
});
for (const [label, message] of [['newline', 'a\nb'], ['control character', 'a\x07b'], ['over 200 chars', 'x'.repeat(201)], ['empty', ''], ['non-string', 42]]) {
  test(`an invalid (${label}) claim message is null and the claim is kept`, () => {
    const out = eventsData(claimed(message, message), target); assert.ok(out);
    assert.equal(out.waitingOnYou.producer, 'provider.a'); assert.equal(out.waitingOnYou.message, null); assert.equal(out.waitingClaims[0].message, null);
  });
}
// The activity view keeps its house rule: the sidebar shows the reason label for these notes (#584 finding
// 12, waitingOnYouData), this read still says the detail was withheld.
const WITHHELD_NOTES = ['see https://private.example/x', 'See https://github.com/awebai/oats/pull/552', 'Which token: A or B?', 'api key: rotate now?'];
test('an unsafe claim message is withheld, never shown', () => {
  for (const note of WITHHELD_NOTES) {
    const out = eventsData(claimed(note, note), target); assert.ok(out, note);
    assert.equal(out.waitingOnYou.message, EVENTS_WITHHELD, note); assert.equal(out.waitingClaims[0].message, EVENTS_WITHHELD, note);
  }
});

// Kernel PR K's `waiting` lifecycle rows, in the shape K writes them (captured from K @ e85ff4ec): a set row
// carries waitingOnYou true, reason and message; a cleared row carries waitingOnYou false only.
const kSet = (data = {}) => event({ producer: 'agent', kind: 'waiting', at: '2026-09-22T01:00:00.000Z',
  data: { waitingOnYou: true, reason: 'attention', message: 'e2e: needs input check', ...data } });
const kCleared = () => event({ producer: 'agent', kind: 'waiting', at: '2026-09-22T01:00:14.607Z', data: { waitingOnYou: false } });

test('K waiting rows: titled "Waiting claim"; the set row projects waitingOnYou, reason and message; the cleared row only false', () => {
  assert.equal(EVENT_TITLES.waiting, 'Waiting claim');
  const out = eventsData(data([kSet(), kCleared()]), target);
  assert.ok(out);
  assert.deepEqual(out.events.map(e => e.data), [{ waitingOnYou: true, reason: 'attention', message: 'e2e: needs input check' }, { waitingOnYou: false }]);
});

test('K waiting rows: a malformed note is null and the read stays valid; an unsafe one is withheld', () => {
  for (const message of ['two\nlines', 'x'.repeat(201), '', 7]) {
    const out = eventsData(data([kSet({ message })]), target);
    assert.ok(out, JSON.stringify(message)); assert.equal(out.events[0].data.message, null);
  }
  for (const message of ['see https://evil.example/x', ...WITHHELD_NOTES]) {
    assert.equal(eventsData(data([kSet({ message })]), target).events[0].data.message, EVENTS_WITHHELD, message);
  }
  assert.equal(eventsData(data([kSet({ message: '<b>bold</b>' })]), target).events[0].data.message, '<b>bold</b>', 'kept verbatim; the view sets text');
});

test('a message on any other event kind is not projected', () => {
  const out = eventsData(data([event({ kind: 'launched', data: { backend: 'tmux', message: 'not a claim note' } })]), target);
  assert.ok(out); assert.equal(Object.hasOwn(out.events[0].data, 'message'), false);
});

test('a 101-emoji message (202 UTF-16 units, 101 code points) on both waitingOnYou and its claim is accepted and kept', () => {
  const message = '\u{1F600}'.repeat(101), value = data([event()]);
  value.waitingClaims = [{ producer: 'provider.b', waiting: true, since: birth, reason: 'attention', message }];
  value.waitingOnYou = { producer: 'provider.b', since: birth, reason: 'attention', message };
  const out = eventsData(value, target);
  assert.ok(out, 'the read is accepted');
  assert.equal(out.waitingOnYou.message, message); assert.equal(out.waitingClaims[0].message, message);
});
