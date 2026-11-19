// The agent's board (feature instance-board; contract D30 v4): the shared contract module both clients read it
// through (packages/client/instance-board.mjs), its pass-through on the roster's rows, local and routed, and the
// `inspect --home --board` read's admission and argv. Pure data: no DOM, no CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardData, boardDetailData, rowHasBoard, answerText, dialogOpen, factsView, sparkValues, updatedText, boardLink,
  boardClaim, questionCount, turnQuestion, BOARD_FEATURE, FACTS_SHOWN } from '../../client/instance-board.mjs';
import { capabilityAdmission, capabilityCall } from '../../client/inspect-boundary.mjs';
import { cliCapability } from '../../client/cli-adapter.mjs';
import { remotePanel } from '../../client/remote-roster.mjs';
import { panelInstance } from '../../client/deployment-panel.mjs';
import { AT, NOW, fact, question, board } from './helpers/board-fixture.mjs';

test('board: the row field validated; facts in the order set, questions in the order asked', () => {
  const out = boardData(board());
  assert.deepEqual(out.facts.map(f => f.key), ['score', 'pr']);
  assert.deepEqual(out.questions.map(q => q.id), ['q1', 'q2']);
  assert.deepEqual(out.facts[1].link, { href: 'https://github.com/oats-project/oats/pull/1990', host: 'github.com' });
  assert.equal(boardData(null), null, 'null: the home has no board file');
  assert.equal(boardData(undefined), null);
  assert.deepEqual(boardData({}), { facts: [], questions: [] });
});

test('board: a malformed entry drops only itself, within the kernel bounds', () => {
  const out = boardData({ facts: [fact('ok'), fact('Bad Key'), fact('long', { label: 'x'.repeat(41) }), fact('ctl', { value: 'a\u0007b' }),
    fact('http', { link: 'http://example.com' }), fact('cred', { link: 'https://u:p@example.com' }), fact('ok')],
  questions: [question('q1', { options: ['only one'] }), question('q2', { options: ['a', 'b', 'c', 'd', 'e'] }), question('q3', { question: 'two\nlines' }), question('q4')] });
  assert.deepEqual(out.facts.map(f => f.key), ['ok'], 'bad key, long label, control character, http, credentials, a repeated key');
  assert.deepEqual(out.questions.map(q => q.id), ['q4'], '2 to 4 options, one line');
  const many = boardData({ facts: Array.from({ length: 20 }, (_, i) => fact(`f${i}`)), questions: Array.from({ length: 12 }, (_, i) => question(`q${i}`)) });
  assert.equal(many.facts.length, 12); assert.equal(many.questions.length, 9);
});

test('board: without the feature the tab is today\'s terminal; null with the feature is a board with nothing on it', () => {
  assert.equal(rowHasBoard({ instance: 'a' }, [BOARD_FEATURE]), false, 'absent: an older kernel');
  assert.equal(rowHasBoard({ instance: 'a', board: null }, ['other']), false, 'the CLI does not list the feature');
  assert.equal(rowHasBoard({ instance: 'a', board: null }, [BOARD_FEATURE]), true);
  assert.equal(rowHasBoard({ instance: 'a', board: null }, null), false, 'an unknown feature list');
});

test('board answer: the id on the input line, never a bare digit, never a line end, never withheld text', () => {
  const q = boardData({ questions: [question('q2', { options: ['Yes, one clean commit', 'token=abcdefgh'] })] }).questions[0];
  assert.equal(answerText(q, 0), 'q2: Yes, one clean commit');
  assert.equal(answerText(q, 1), null, 'an option the display filter withholds is not typed');
  assert.equal(answerText(q, 2), null, 'no such option');
  for (const i of [0]) assert.doesNotMatch(answerText(q, i), /^\d+$|[\r\n]/);
});

test('board dialog: a live permission or question claim from any producer disables the numbers; unknown does not', () => {
  assert.equal(dialogOpen([{ producer: 'pi.harness', waiting: true, reason: 'permission', since: AT }]), true);
  assert.equal(dialogOpen([{ producer: 'oats.board', reason: 'attention', since: AT }, { producer: 'x', reason: 'question', since: AT }]), true);
  assert.equal(dialogOpen([{ producer: 'x', waiting: false, reason: 'permission', since: AT }]), false, 'a cleared claim');
  assert.equal(dialogOpen([{ producer: 'oats.board', reason: 'attention', since: AT }]), false);
  assert.equal(dialogOpen([null]), false, 'unknown is not a dialog');
  assert.equal(boardClaim({ producer: 'oats.board' }), true);
});

test('board facts: three shown, the rest folded; a hidden fact shows again when its value changes', () => {
  const facts = boardData({ facts: ['a', 'b', 'c', 'd', 'e'].map(k => fact(k)) }).facts;
  const view = factsView(facts);
  assert.equal(FACTS_SHOWN, 3);
  assert.deepEqual(view.shown.map(f => f.key), ['a', 'b', 'c']); assert.deepEqual(view.folded.map(f => f.key), ['d', 'e']);
  const hidden = factsView(facts, new Map([['a', '0.4312'], ['b', 'an older value']]));
  assert.deepEqual(hidden.hidden.map(f => f.key), ['a']); assert.deepEqual(hidden.shown.map(f => f.key), ['b', 'c', 'd']);
  assert.equal(factsView(facts, new Map(), { unfolded: true }).shown.length, 5);
});

test('board detail: history and context from inspect --board; a sparkline needs two numbers', () => {
  const d = boardDetailData({ board: { facts: [{ key: 'score', history: [{ value: '0.40', at: AT }, { value: '41 %', at: AT }, { value: 'x\u0007', at: AT }] }],
    questions: [{ id: 'q1', context: 'a\nb' }, { id: 'q2', context: 'a\u0007' }] } });
  assert.deepEqual(d.facts.get('score').history.map(h => h.value), ['0.40', '41 %']);
  assert.equal(d.questions.get('q1').context, 'a\nb'); assert.equal(d.questions.get('q2').context, null);
  assert.deepEqual(sparkValues(d.facts.get('score').history), [0.4, 41]);
  assert.equal(sparkValues([{ value: '1', at: AT }]), null);
  assert.equal(boardDetailData({ instance: { board: { facts: [], questions: [] } } }).facts.size, 0, 'instance.board read too');
  assert.equal(boardDetailData({ operationsApi: 2 }), null);
});

test('board words: updated <time>, question n of N, turning wraps', () => {
  assert.equal(updatedText(AT, NOW), 'updated 4 min ago');
  assert.equal(updatedText(AT, Date.parse(AT) + 10_000), 'updated just now');
  assert.equal(questionCount(1, 3), 'question 2 of 3'); assert.equal(questionCount(0, 1), null);
  assert.equal(turnQuestion(2, 1, 3), 0); assert.equal(turnQuestion(0, -1, 3), 2);
  assert.deepEqual(boardLink('https://example.com/a'), { href: 'https://example.com/a', host: 'example.com' });
  assert.equal(boardLink(`https://example.com/${'a'.repeat(600)}`), null);
});

test('board on the rows: the panel keeps it; a routed row only from a host whose own features name it', () => {
  assert.deepEqual(panelInstance({ instance: 'a', home: '/h/a', agentsRoot: '/h', board: boardData(board()) }).board.facts.length, 2);
  assert.equal(Object.hasOwn(panelInstance({ instance: 'a', home: '/h/a', agentsRoot: '/h' }), 'board'), false);
  const group = features => ({ id: 's', server: 's', label: 's', registrationPresent: true, agentsRoot: '/r', target: { workspace: '/w' }, souls: [],
    probe: { ok: true, features }, instances: [{ instance: 'a', agent: 'dev', home: '/r/dev/instances/a', running: true, board: board() }] });
  assert.equal(remotePanel(group([BOARD_FEATURE]), AT).instances[0].board.questions.length, 2);
  assert.equal(Object.hasOwn(remotePanel(group([]), AT).instances[0], 'board'), false, 'a host without the feature');
  assert.equal(Object.hasOwn(remotePanel(group(null), AT).instances[0], 'board'), false, 'an unknown list');
});

test('board read: inspect --home --board, admitted for a home only, sent only to a CLI with the feature', async () => {
  const instance = { instance: 'a', home: '/w/agents/dev/instances/a', createdAt: AT };
  const cli = features => ({ ok: true, operationsApi: 2, bin: '/bin/oats', features });
  const context = features => ({ workspace: { id: 'w', scope: '/w' }, cli: cli(features), instances: [instance] });
  const admitted = capabilityAdmission({ action: 'inspect', selector: { home: instance.home }, board: true }, context([BOARD_FEATURE]), ['inspect']);
  assert.equal(admitted.board, true);
  assert.equal(capabilityAdmission({ action: 'inspect', selector: { home: instance.home }, board: true }, context([]), ['inspect']).board, false);
  assert.throws(() => capabilityAdmission({ action: 'inspect', selector: { soul: 'dev', agentsRoot: '/w/agents' }, board: true }, context([BOARD_FEATURE]), ['inspect']), /Invalid board flag/);
  assert.throws(() => capabilityAdmission({ action: 'inspect', selector: { home: instance.home }, board: 'yes' }, context([BOARD_FEATURE]), ['inspect']), /Invalid board flag/);
  assert.notEqual(admitted.key, capabilityAdmission({ action: 'inspect', selector: { home: instance.home } }, context([BOARD_FEATURE]), ['inspect']).key, 'its own cache key');
  let argv = null;
  const exec = (bin, args, opts, done) => { argv = args; done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: {} }), ''); };
  const call = capabilityCall({ action: 'inspect' }, admitted, { workspace: { scope: '/w' }, cli: cli([BOARD_FEATURE]), localCwd: '/w' });
  await cliCapability('/bin/oats', call, { exec }).catch(() => {});
  assert.ok(argv?.includes('--board') && argv.includes('--home'), `argv: ${argv}`);
  await assert.rejects(cliCapability('/bin/oats', { action: 'inspect', soul: 'dev', board: true, features: [BOARD_FEATURE] }), /home inspection/);
});
