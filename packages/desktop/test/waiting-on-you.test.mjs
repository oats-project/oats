// Spec D ("Needs input"): the waitingOnYou validator, its one liveness gate, the words and the collapsed roll-up.
// Pure module: no DOM, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { waitingOnYouData, waitingMessage, waitingClaim, waitingLabel, waitingDetail, waitedText, waitingClock, waitingNames,
  waitingBelowText, waitingSentence } from '../../client/waiting-on-you.mjs';
import { EVENTS_WITHHELD, eventsDetail } from '../../client/instance-events-contract.mjs';
import { collapseKey, instanceId, waitingRollup } from '../../client/instance-tree.mjs';

const since = '2026-10-03T10:00:00.000Z';
const claim = (extra = {}) => ({ since, producer: 'claude-hook', reason: 'permission', message: 'Allow Bash(rm -rf build)?', ...extra });

test('a valid claim validates to exactly { since, producer, reason, message }; extra keys are ignored', () => {
  assert.deepEqual(waitingOnYouData(claim({ future: { nested: true } })),
    { since, producer: 'claude-hook', reason: 'permission', message: 'Allow Bash(rm -rf build)?' });
});

for (const [label, value] of [
  ['null', null], ['a string', 'waiting'], ['an array', [claim()]], ['a number', 1],
  ['missing since', claim({ since: undefined })], ['a date-only since', claim({ since: '2026-10-03' })],
  ['a since without millis', claim({ since: '2026-10-03T10:00:00Z' })], ['an impossible since', claim({ since: '2026-02-30T00:00:00.000Z' })],
  ['an offset since', claim({ since: '2026-10-03T10:00:00.000+02:00' })], ['a numeric since', claim({ since: 1759485600000 })],
  ['missing producer', claim({ producer: undefined })], ['an empty producer', claim({ producer: '' })],
  ['a 257-char producer', claim({ producer: 'p'.repeat(257) })], ['a producer with a newline', claim({ producer: 'a\nb' })],
  ['a producer with a control char', claim({ producer: 'a\x07b' })], ['a producer that is a URL', claim({ producer: 'https://evil.example/x' })],
  ['a producer carrying a token', claim({ producer: 'token=abcdef' })], ['a producer carrying a GitHub token', claim({ producer: `ghp_${'a'.repeat(20)}` })],
  ['a non-string producer', claim({ producer: 7 })],
]) test(`a claim with ${label} is dropped (null), never thrown`, () => {
  assert.doesNotThrow(() => waitingOnYouData(value));
  assert.equal(waitingOnYouData(value), null);
});

test('a 256-char producer is accepted', () => {
  assert.equal(waitingOnYouData(claim({ producer: 'p'.repeat(256) })).producer, 'p'.repeat(256));
});

for (const [label, reason] of [['missing', undefined], ['null', null], ['a number', 3], ['an object', { kind: 'permission' }], ['over 64 chars', 'r'.repeat(65)]]) {
  test(`a ${label} reason keeps the claim with reason null (only since and producer drop a claim)`, () => {
    const value = claim(); if (reason === undefined) delete value.reason; else value.reason = reason;
    const out = waitingOnYouData(value);
    assert.ok(out); assert.equal(out.reason, null); assert.equal(out.producer, 'claude-hook');
  });
}
test('a 64-char unknown reason is kept verbatim for mapping', () => {
  assert.equal(waitingOnYouData(claim({ reason: 'r'.repeat(64) })).reason, 'r'.repeat(64));
});

for (const [label, message] of [['absent', undefined], ['null', null], ['empty', ''], ['a newline', 'line one\nline two'],
  ['a carriage return', 'a\rb'], ['a tab', 'a\tb'], ['a control char', 'a\x1bb'], ['DEL', 'a\x7fb'], ['201 chars', 'm'.repeat(201)],
  ['a number', 42], ['an object', { text: 'x' }],
  // The exact refused set (maintainer decision on #553): code points; Cc, U+2028–2029, U+202A–202E,
  // U+2066–2069, U+200B, U+2060, U+FEFF and U+E0000–E007F, each range at both ends.
  ['201 code points (emoji)', '\u{1F600}'.repeat(201)], ['a C1 control (U+0085)', 'a\u0085b'], ['a line separator (U+2028)', 'a\u2028b'],
  ['a paragraph separator (U+2029)', 'a\u2029b'], ['a bidi embedding (U+202A)', 'a\u202Ab'], ['a bidi override (U+202E)', 'a\u202Eb'],
  ['a bidi isolate (U+2066)', 'a\u2066b'], ['a pop directional isolate (U+2069)', 'a\u2069b'], ['a zero-width space (U+200B)', 'a\u200Bb'],
  ['a word joiner (U+2060)', 'a\u2060b'], ['a BOM (U+FEFF)', '\uFEFFab'], ['a tag character (U+E0041)', 'a\u{E0041}b'],
  ['the first tag code point (U+E0000)', 'a\u{E0000}b'], ['the last tag code point (U+E007F)', 'a\u{E007F}b']]) {
  test(`a message that is ${label} reads null and the claim is kept`, () => {
    const value = claim(); if (message === undefined) delete value.message; else value.message = message;
    const out = waitingOnYouData(value);
    assert.ok(out); assert.equal(out.message, null); assert.equal(out.since, since);
  });
}
test('format characters outside the refused set are text: ZWJ emoji, ZWNJ, LRM, RLM, ALM and the soft hyphen are kept', () => {
  for (const text of ['\u{1F469}\u200D\u{1F4BB}', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645' /* می‌خواهم */,
    'a\u200Eb', '\u05D0\u200Fb', '\u0627\u061Cb', 'co\u00ADop', 'a\u2065b', 'a\u202Fb', 'a\u{E0080}b']) {
    assert.equal(waitingMessage(text), text, JSON.stringify(text));
  }
});
test('a 200-char message is kept; markup is kept verbatim (rendered as text by the caller)', () => {
  assert.equal(waitingMessage('m'.repeat(200)), 'm'.repeat(200));
  // 101 emoji: 202 UTF-16 units, 101 code points — valid; the rule counts code points, as the kernel does.
  const emoji = '\u{1F600}'.repeat(101);
  assert.equal(emoji.length, 202); assert.equal(waitingMessage(emoji), emoji);
  assert.equal(waitingMessage('\u{1F600}'.repeat(200)), '\u{1F600}'.repeat(200), '200 code points is the limit');
  assert.equal(waitingMessage('<b>x</b><script>alert(1)</script>'), '<b>x</b><script>alert(1)</script>');
});
test('the message rule never throws, whatever the value (no length-throwing helper on this path)', () => {
  for (const v of ['\u{1F600}'.repeat(5000), 'x'.repeat(5000), 'https://x.example/' + 'a'.repeat(3000), Symbol('s'), 10n, () => 1, ['a']]) {
    assert.doesNotThrow(() => waitingMessage(v)); assert.equal(waitingMessage(v), null);
  }
});
// What eventsUnsafe refuses in a note (#584 finding 12): the reviewer's three ordinary notes, and the
// kind of text the rule is for.
const WITHHELD_NOTES = ['See https://github.com/awebai/oats/pull/552', 'Which token: A or B?', 'api key: rotate now?',
  'open https://private.example/secret', 'password: hunter2', 'api_key=abc123'];
test('an unsafe message (a URL, a token assignment) is withheld by the validator: the marker, still a valid note', () => {
  assert.equal(EVENTS_WITHHELD, '[withheld]');
  for (const note of WITHHELD_NOTES) assert.equal(waitingMessage(note), EVENTS_WITHHELD, note);
  assert.equal(eventsDetail('Which token: A or B?'), EVENTS_WITHHELD, 'the same marker as an event detail');
});
test('the sidebar\'s claim never carries the withheld marker: a withheld note reads null and the claim is kept (#584)', () => {
  for (const note of WITHHELD_NOTES) {
    const out = waitingOnYouData(claim({ message: note }));
    assert.deepEqual(out, { since, producer: 'claude-hook', reason: 'permission', message: null }, note);
    assert.deepEqual(waitingOnYouData(out), out, 'validated again (server, then renderer): the same');
    assert.equal(waitingClaim({ running: true, runtimeState: 'running', waitingOnYou: claim({ message: note }) }).message, null, note);
  }
  // The marker itself, as a note (an older Desktop server, or an agent that typed it): no note either.
  assert.equal(waitingOnYouData(claim({ message: EVENTS_WITHHELD })).message, null);
  assert.equal(waitingOnYouData(claim({ message: 'Allow Bash(rm -rf build)?' })).message, 'Allow Bash(rm -rf build)?', 'a safe note is kept');
});
test('the withheld marker is one literal: display-text.mjs exports it, the contracts and the claim module only import it', () => {
  const source = name => readFileSync(new URL(`../../client/${name}`, import.meta.url), 'utf8');
  assert.equal(source('display-text.mjs').split(`'${EVENTS_WITHHELD}'`).length - 1, 1);
  for (const name of ['instance-events-contract.mjs', 'readiness-contract.mjs', 'waiting-on-you.mjs']) assert.equal(source(name).includes(EVENTS_WITHHELD), false, name);
});

test('reasons map to fixed words; an unknown or null reason reads "Needs input" and the raw value is never returned', () => {
  assert.equal(waitingLabel({ reason: 'permission' }), 'Waiting for a tool approval');
  assert.equal(waitingLabel({ reason: 'question' }), 'Asked you a question');
  assert.equal(waitingLabel({ reason: 'attention' }), 'Asked for your attention');
  for (const reason of ['approval', null, '', 'toString', '__proto__', 'constructor']) assert.equal(waitingLabel({ reason }), 'Needs input', String(reason));
  assert.equal(waitingLabel(null), 'Needs input');
});

test('waitingDetail: the words after a "Needs input" tag: the message, else a known reason\'s words, else null, so the tag is said once (#1502)', () => {
  assert.equal(waitingDetail(waitingOnYouData(claim())), 'Allow Bash(rm -rf build)?');
  assert.equal(waitingDetail(waitingOnYouData(claim({ message: null, reason: 'question' }))), 'Asked you a question');
  for (const reason of ['approval', null, '', 'toString', '__proto__']) {
    assert.equal(waitingDetail(waitingOnYouData(claim({ message: null, reason }))), null, String(reason));
    assert.equal(waitingDetail(waitingOnYouData(claim({ message: '   ', reason }))), null, `${reason}: a message of only spaces adds nothing either`);
  }
  assert.equal(waitingDetail(waitingOnYouData(claim({ message: 'Pick one?', reason: 'approval' }))), 'Pick one?', 'a message is said whatever the reason');
});

test('a message with no character but white space reads null in the claim, as a withheld one does; waitingMessage still accepts it (#1502)', () => {
  for (const message of ['   ', ' ', '\u00A0\u00A0', '\u3000', ' \u2003 ', '\u2002\u200A', '\u202F']) {
    assert.notEqual(waitingMessage(message), null, `${JSON.stringify(message)} is a valid note, as the kernel's rule says`);
    const out = waitingOnYouData(claim({ message }));
    assert.ok(out, 'the claim is kept'); assert.equal(out.message, null, JSON.stringify(message));
  }
  assert.equal(waitingOnYouData(claim({ message: '  Pick one?  ' })).message, '  Pick one?  ', 'text with spaces around it is kept verbatim');
  assert.equal(waitingOnYouData(claim({ message: '\u00A0x' })).message, '\u00A0x');
});

test('waitedText floors into under a minute / min / h / d buckets; a future since reads under a minute', () => {
  const at = Date.parse(since), min = 60000, h = 60 * min;
  for (const [offset, text] of [[0, 'under a minute'], [59999, 'under a minute'], [-5 * min, 'under a minute'], [min, '1 min'],
    [59 * min + 59999, '59 min'], [60 * min, '1 h'], [23 * h + 59 * min, '23 h'], [24 * h, '1 d'], [3 * 24 * h + 5 * h, '3 d']]) {
    assert.equal(waitedText(since, at + offset), text, String(offset));
  }
  assert.equal(waitedText('not a date', at), 'under a minute');
});

// Built from LOCAL calendar fields, so these hold in any time zone (#559).
const localAt = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
test('waitingClock: HH:MM on now\'s local day, "Mon D, HH:MM" on another day, "YYYY-MM-DD HH:MM" in another year', () => {
  const now = localAt(2026, 9, 3, 15, 0);
  assert.equal(waitingClock(new Date(localAt(2026, 9, 3, 14, 3)).toISOString(), now), '14:03', 'same day');
  assert.equal(waitingClock(new Date(localAt(2026, 9, 3, 0, 0)).toISOString(), now), '00:00', 'local midnight is the same day');
  assert.equal(waitingClock(new Date(localAt(2026, 9, 2, 14, 3)).toISOString(), now), 'Oct 2, 14:03', 'yesterday');
  assert.equal(waitingClock(new Date(localAt(2026, 0, 31, 9, 5)).toISOString(), now), 'Jan 31, 09:05', 'earlier this year');
  assert.equal(waitingClock(new Date(localAt(2025, 9, 2, 14, 3)).toISOString(), now), '2025-10-02 14:03', 'another year');
  assert.equal(waitingClock(new Date(localAt(2025, 11, 31, 23, 59)).toISOString(), localAt(2026, 0, 1, 0, 1)), '2025-12-31 23:59', 'across New Year');
  assert.equal(waitingClock(new Date(localAt(2026, 9, 4, 0, 1)).toISOString(), now), 'Oct 4, 00:01', 'a future start (clock skew) on another day says so');
  assert.equal(waitingClock('not a time', now), '');
});

test('waitingNames lists up to three names, then "and N more"', () => {
  const rows = names => names.map(instance => ({ instance }));
  assert.equal(waitingNames(rows(['a'])), 'a');
  assert.equal(waitingNames(rows(['a', 'b', 'c'])), 'a, b, c');
  assert.equal(waitingNames(rows(['a', 'b', 'c', 'd', 'e'])), 'a, b, c and 2 more');
  assert.equal(waitingBelowText(rows(['a', 'b'])), '2 need input: a, b');
  assert.equal(waitingBelowText(rows(['a'])), '1 needs input: a');
});

test('waitingSentence (unavailable rows) names the message or label and an absolute time, dated against the paint time', () => {
  const sameDay = Date.parse(since) + 60000, at = waitingClock(since, sameDay);
  assert.equal(waitingSentence(waitingOnYouData(claim()), [], sameDay), ` · Needs input: Allow Bash(rm -rf build)? since ${at}`);
  assert.equal(waitingSentence(waitingOnYouData(claim({ message: null, reason: 'question' })), [], sameDay), ` · Needs input: Asked you a question since ${at}`);
  // A withheld note reads as the reason in words, never "[withheld]" (#584 finding 12).
  for (const [note, reason, label] of [['See https://github.com/awebai/oats/pull/552', 'attention', 'Asked for your attention'],
    ['Which token: A or B?', 'question', 'Asked you a question'], ['api key: rotate now?', 'approval', null]]) {
    assert.equal(waitingSentence(waitingOnYouData(claim({ message: note, reason })), [], sameDay), ` · Needs input${label ? `: ${label}` : ''} since ${at}`, note);
  }
  // A start built from LOCAL fields, so its local date is known in any time zone.
  const lastYear = waitingOnYouData(claim({ since: new Date(localAt(2026, 9, 3, 10, 0)).toISOString() }));
  assert.equal(waitingSentence(lastYear, [], localAt(2027, 0, 5, 12, 0)), ' · Needs input: Allow Bash(rm -rf build)? since 2026-10-03 10:00', 'a claim from another year carries its date');
  assert.equal(waitingSentence(null, [{ instance: 'dev-a' }, { instance: 'dev-b' }]), ' · 2 below need input: dev-a, dev-b');
  assert.equal(waitingSentence(null, []), '');
});

// The gate: liveness decides, whatever the kernel said about the claim.
const row = (extra = {}) => ({ instance: 'dev-1', running: true, runtimeState: 'running', waitingOnYou: claim(), ...extra });
// A remote row as the kernel's roster sends it and remotePanel projects it: `runtimeState: null` (#582).
const remoteRow = (extra = {}) => row({ server: 's1', runtimeState: null, serverUnreached: false, ...extra });
test('waitingClaim: a running row (Desktop liveness running, or runtimeState absent) shows its claim', () => {
  assert.deepEqual(waitingClaim(row()), waitingOnYouData(claim()));
  const { runtimeState: _absent, ...noState } = row();
  assert.ok(waitingClaim(noState));
});
test('waitingClaim: a null runtimeState is "not reported", not "not running" — a kernel-shaped remote row shows its claim (#582)', () => {
  assert.deepEqual(waitingClaim(remoteRow()), waitingOnYouData(claim()));
  assert.deepEqual(waitingClaim(row({ runtimeState: null })), waitingOnYouData(claim()), 'one rule for every row, not a remote-only branch');
});
for (const [label, extra, options] of [
  ['tmux says shell', { running: false, runtimeState: 'shell' }], ['shell even if running were true', { runtimeState: 'shell' }],
  ['stopped', { running: false, runtimeState: 'stopped' }], ['unreachable', { running: null, runtimeState: 'unreachable' }],
  ['unsupported', { running: null, runtimeState: 'unsupported' }], ['running false', { running: false, runtimeState: undefined }],
  ['unreachable even if running were true', { runtimeState: 'unreachable' }], ['unsupported even if running were true', { runtimeState: 'unsupported' }],
  ['stopped even if running were true', { runtimeState: 'stopped' }], ['an unknown reported state', { runtimeState: 'paused' }],
  ['running null', { running: null, runtimeState: undefined }], ['running "true" (string)', { running: 'true' }],
  ['held stale', {}, { stale: true }],
  ['no claim', { waitingOnYou: null }], ['an absent claim', { waitingOnYou: undefined }], ['a malformed claim', { waitingOnYou: { since: 'now', producer: 'x' } }],
]) test(`waitingClaim: ${label} → null`, () => {
  assert.equal(waitingClaim(row(extra), options), null);
});
// Each hides a remote row that shows its claim without it (the positive case above).
for (const [label, extra, options] of [
  ['not running by its host', { running: false }], ['state unknown', { running: null }],
  ['reported unreachable', { running: null, runtimeState: 'unreachable' }], ['reported unsupported', { running: null, runtimeState: 'unsupported' }],
  ['server unreached', { serverUnreached: true }], ['server unreached, last-known rows', { running: null, serverUnreached: true }],
  ['held stale', {}, { stale: true }], ['no claim', { waitingOnYou: null }],
]) test(`waitingClaim: a remote row (runtimeState null), ${label} → null`, () => {
  assert.equal(waitingClaim(remoteRow(extra), options), null);
});
test('waitingClaim never throws on a non-record row', () => {
  for (const value of [null, undefined, 'row', 3, []]) assert.equal(waitingClaim(value), null);
});

// Roll-up: waiting rows hidden by a collapse, attributed to the nearest visible ancestor.
const ws = 'ws';
const inst = (name, parentInstance, extra = {}) => ({ instance: name, agent: 'dev', home: `/d/agents/dev/instances/${name}`, agentsRoot: '/d/agents',
  running: true, runtimeState: 'running', ...(parentInstance ? { parentInstance } : {}), ...extra });
const waiting = (name, parent, extra = {}) => inst(name, parent, { waitingOnYou: claim(), ...extra });
const collapsedOf = (...rows) => new Set(rows.map(r => collapseKey(ws, instanceId(r))));
const rollup = (rows, collapsed, options) => Object.fromEntries([...waitingRollup(rows, collapsed, ws, options)].map(([id, list]) => [id, list.map(r => r.instance)]));

test('a collapsed parent collects its hidden waiting children', () => {
  const root = inst('root'), a = waiting('dev-a', 'root'), b = waiting('dev-b', 'root'), quiet = inst('dev-c', 'root');
  assert.deepEqual(rollup([root, a, b, quiet], collapsedOf(root)), { [instanceId(root)]: ['dev-a', 'dev-b'] });
});
test('a grandchild under a collapsed root and a collapsed middle goes to the nearest VISIBLE ancestor', () => {
  const root = inst('root'), mid = inst('mid', 'root'), leaf = waiting('leaf', 'mid');
  assert.deepEqual(rollup([root, mid, leaf], collapsedOf(root, mid)), { [instanceId(root)]: ['leaf'] });
  assert.deepEqual(rollup([root, mid, leaf], collapsedOf(mid)), { [instanceId(mid)]: ['leaf'] });
});
test('a visible waiting row is not rolled up (expanding the parent removes the roll-up)', () => {
  const root = inst('root'), a = waiting('dev-a', 'root');
  assert.deepEqual(rollup([root, a], new Set()), {});
  const other = inst('other');
  assert.deepEqual(rollup([root, a, other], collapsedOf(other)), {});
});
test('filtering on: nothing is collapsed, no roll-up', () => {
  const root = inst('root'), a = waiting('dev-a', 'root');
  assert.deepEqual(rollup([root, a], collapsedOf(root), { filtering: true }), {});
});
test('a hidden row that is not running, or held stale, contributes nothing', () => {
  const root = inst('root'), shell = waiting('dev-a', 'root', { running: false, runtimeState: 'shell' }), stale = waiting('dev-b', 'root');
  assert.deepEqual(rollup([root, shell, stale], collapsedOf(root), { stale: r => r.instance === 'dev-b' }), {});
});
test('a parent cycle or a missing parent degrades to no roll-up, never a crash', () => {
  const a = waiting('a', 'b'), b = inst('b', 'a');
  assert.doesNotThrow(() => waitingRollup([a, b], collapsedOf(a, b), ws));
  assert.deepEqual(rollup([a, b], collapsedOf(a, b)), {});
  const orphan = waiting('orphan', 'ghost'), other = inst('other');
  assert.deepEqual(rollup([orphan, other], collapsedOf(other)), {});
});
test('a roll-up never crosses a remote server boundary', () => {
  const local = inst('root'), remote = waiting('dev-r', 'root', { server: 's1', runtimeState: null, home: '/r/agents/dev/instances/dev-r', agentsRoot: '/r/agents' });
  assert.ok(waitingClaim(remote), 'the remote row is waiting (kernel shape: runtimeState null)');
  assert.deepEqual(rollup([local, remote], collapsedOf(local)), {});
  // The same row rolls up under a collapsed parent on its own server: the boundary is what stopped it above.
  const remoteRoot = inst('root', undefined, { server: 's1', runtimeState: null, home: '/r/agents/dev/instances/root', agentsRoot: '/r/agents' });
  assert.deepEqual(rollup([remoteRoot, remote], collapsedOf(remoteRoot)), { [instanceId(remoteRoot)]: ['dev-r'] });
});

test('waitingRollup: a chain that leaves the waiting row\'s section (deployment) rolls up nowhere', () => {
  const row = (name, root, parentInstance, extra = {}) => ({ instance: name, parentInstance, home: `${root}/agents/dev/instances/${name}`, agentsRoot: `${root}/agents`,
    running: true, runtimeState: 'running', ...extra });
  const lead = row('lead', '/d1'), own = row('own', '/d1', 'lead', { waitingOnYou: { since, producer: 'p' } }),
    orphan = row('orphan', '/d2', 'lead', { waitingOnYou: { since, producer: 'p' } });
  const all = [lead, own, orphan], collapsed = new Set([collapseKey('A', instanceId(lead))]);
  const section = r => r.agentsRoot;
  assert.deepEqual([...waitingRollup(all, collapsed, 'A', { section }).get(instanceId(lead))].map(r => r.instance), ['own']);
  assert.deepEqual([...waitingRollup(all, collapsed, 'A').get(instanceId(lead))].map(r => r.instance), ['own', 'orphan'], 'without sections: one section');
});

test('layering: the claim contract imports only contract modules and the display filter, which imports nothing (the server loads it; the tree roll-up lives in instance-tree.mjs)', () => {
  const source = readFileSync(new URL('../../client/waiting-on-you.mjs', import.meta.url), 'utf8');
  const importsOf = text => [...text.matchAll(/^import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]).sort();
  // instance-presentation.mjs (spec C1): the one rule of which row runs on a session provider, whose claim has its
  // own liveness gate. A pure module the server already loads (deployment-data.mjs): no tree, no DOM.
  assert.deepEqual(importsOf(source), ['./display-text.mjs', './instance-events-contract.mjs', './instance-presentation.mjs', './readiness-contract.mjs']);
  const presentation = readFileSync(new URL('../../client/instance-presentation.mjs', import.meta.url), 'utf8');
  assert.deepEqual(importsOf(presentation), ['./client-terms.mjs', './soul-colors.mjs', './terminal-contract.mjs']);
  assert.doesNotMatch(presentation, /from\s+['"][^'"]*instance-tree|\bimport\s*\(|\bdocument\b/, 'no tree import, no dynamic import, no DOM');
  assert.doesNotMatch(source, /from\s+['"][^'"]*instance-tree|import\s*\(/, 'no tree import, static or dynamic');
  const filter = readFileSync(new URL('../../client/display-text.mjs', import.meta.url), 'utf8');
  assert.deepEqual(importsOf(filter), []); assert.doesNotMatch(filter, /\bimport\s*\(|\bdocument\b/, 'pure: no import, no DOM');
});
