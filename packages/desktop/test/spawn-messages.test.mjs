import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnProblem, catalogProblem } from '../../client/spawn-messages.mjs';
import { spawnText } from '../renderer/spawn-words.mjs';
import { previewFailure } from '../../client/spawn-preview-contract.mjs';
import { spawnApplyReason } from '../../client/spawn-apply-contract.mjs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { cli, target } from './helpers/spawn-preview-fixture.mjs';

// Every code the preview and apply contracts can report, read from their tables.
const codes = file => {
  const source = readFileSync(new URL(`../../client/${file}`, import.meta.url), 'utf8'), start = source.indexOf('const errors = {');
  const table = source.slice(start, source.indexOf('\n};', start));
  return [...table.matchAll(/'?(E_[A-Z0-9_]+|unsupported-remote-operation)'?:\s*'/g)].map(m => m[1]);
};
const PREVIEW = codes('spawn-preview-contract.mjs'), APPLY = codes('spawn-apply-contract.mjs');
// One code's sentences are longer than the rest: their words were set on awebai/oats#1015 (comment 6135931972),
// by both maintainer sides. The bound of every other code's sentence stays 200.
const UNMATCHED = 'E_LAUNCH_PREFERENCE_UNMATCHED', SET_ON_1015 = 280;
const plain = (text, code) => { assert.ok(text && text.length < (code === UNMATCHED ? SET_ON_1015 : 200), text); assert.doesNotMatch(text, /E_[A-Z]|`|\/|--|sha256|[0-9a-f]{12}/, text); };

test('every contract code has a plain sentence, for reading defaults and for spawning', () => {
  assert.ok(PREVIEW.length > 25 && APPLY.length > 15, 'the tables were found');
  for (const code of [...PREVIEW, ...APPLY]) for (const stage of ['preview', 'spawn']) {
    const problem = spawnProblem({ code, message: 'technical text' }, stage);
    plain(spawnText(problem, stage), code); assert.equal(problem.code, code); assert.equal(problem.detail, `${code} · technical text`);
  }
});

test('kernel refusals keep their own text only behind Details; unknown codes still read plainly', () => {
  const clone = spawnProblem({ code: 'E_CLONE_MISSING', message: 'soul x … `git clone /r /d` …' });
  plain(spawnText(clone)); assert.match(clone.detail, /git clone \/r \/d/);
  for (const stage of ['preview', 'spawn']) {
    const odd = spawnProblem({ code: 'E_SOMETHING_NEW', message: 'raw' }, stage);
    plain(spawnText(odd, stage)); assert.equal(odd.detail, 'E_SOMETHING_NEW · raw');
  }
  assert.equal(spawnProblem(undefined).code, 'E_CLI_FAILED'); assert.equal(spawnProblem({ code: 'E_BUSY' }).detail, 'E_BUSY');
  assert.notEqual(spawnText(spawnProblem({ code: 'E_CLI_TIMEOUT' }, 'preview'), 'preview'), spawnText(spawnProblem({ code: 'E_CLI_TIMEOUT' }, 'spawn'), 'spawn'),
    'a timed-out spawn may have created the instance; a timed-out read did not');
});

// E_REQUIREMENT_INACTIVE was written by kernels below the Desktop's accepted floor; it stands here for a kernel code the
// Desktop holds no sentence for. The refusal's texts here are this file's own.
test('a kernel code the Desktop has no sentence for reads as the general one, its message under Details; at a press it is the general failure (E_REQUIREMENT_INACTIVE)', async () => {
  const CODE = 'E_REQUIREMENT_INACTIVE', SAID = 'soul "planner" asks for a capability this deployment has not turned on: turn it on in the workspace, then spawn again';
  assert.equal(PREVIEW.includes(CODE) || APPLY.includes(CODE), false, 'the code is in no table of the contracts');
  // The dialog's preview, from what the CLI prints: the exec owner keeps the kernel's code and message.
  const printed = { schemaVersion: 1, ok: false, error: { code: CODE, message: SAID, details: { soul: 'planner', capabilities: ['example.pkg'], context: 'soul', remedy: 'turn it on' } } };
  const read = await cliSpawnPreview(cli, { target, choices: {} }, { env: {}, exec: (_bin, _argv, _options, done) => done(Object.assign(new Error('exit 1'), { code: 1 }), JSON.stringify(printed)) });
  assert.deepEqual(read.error, { code: CODE, message: SAID });
  const reason = previewFailure(read.error.code, null, read.error.message).reason;
  assert.deepEqual(reason, { code: CODE, message: SAID });
  assert.deepEqual(spawnProblem(reason, 'preview'), { fact: 'OATS couldn’t work out this soul’s defaults.', next: 'details', code: CODE, detail: `${CODE} · ${SAID}` });
  assert.equal(spawnText(spawnProblem(reason, 'preview'), 'preview'), 'OATS couldn’t work out this soul’s defaults. Try again, or see Details.');
  // A message that cannot travel leaves no code of the tables to fall back on: the general failure.
  assert.equal(previewFailure(CODE, null, `${SAID} ${'x'.repeat(2048)}`).reason.code, 'E_CLI_FAILED');
  // A press: no kernel text travels, and the code is in no table.
  const pressed = spawnApplyReason(CODE);
  assert.equal(pressed.code, 'E_CLI_FAILED');
  assert.equal(spawnText(spawnProblem(pressed, 'spawn'), 'spawn'), 'OATS couldn’t complete the spawn. Try again, or see Details.');
});

test('the soul chooser explains a catalog problem without codes', () => {
  assert.equal(catalogProblem(null), '');
  plain(catalogProblem({ reason: { code: 'E_WORKSPACE', message: '/abs/path failed' }, ambiguous: [] }));
  assert.match(catalogProblem({ reason: null, ambiguous: ['twin', 'other'] }), /twin, other\.$/);
});

test('there is no package approval: no sentence mentions it; integrity names the lock', () => {
  for (const code of [...PREVIEW, ...APPLY]) for (const stage of ['preview', 'spawn']) {
    assert.doesNotMatch(spawnText(spawnProblem({ code, message: 'x' }, stage), stage), /approv/i, code);
  }
  assert.equal(spawnText(spawnProblem({ code: 'E_PACKAGE_INTEGRITY', message: 'x' })), 'A package this soul uses no longer matches the lock. Run Sync in the Workspace view.');
});

test('an invalid instance name says every rule, including the 64-character cap (#159)', () => {
  const text = spawnText(spawnProblem({ code: 'E_INSTANCE_NAME_INVALID', message: 'instance names are at most 64 characters; "a…" is 65 — pass a shorter --name' }));
  assert.match(text, /at most 64 characters/); assert.match(text, /lowercase/); assert.match(text, /soul/);
});

/* ── E_LAUNCH_PREFERENCE_UNMATCHED (OATS 0.53.0, awebai/oats#1015): the Desktop's own sentence, and the kernel's
 *    two texts as parts for the client to quote. The texts here are this file's own, never a kernel sentence. ── */
const OPENS = 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul. To spawn now, pick a harness above, or a launch configuration in Advanced. To fix it for every spawn, correct the preference (Details).';
// The shared fact (#855, 6b-2): the sentence's lead where the Desktop goes on to name its controls; the whole
// shorter sentence, which names none, everywhere else.
const LEAD = 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul.';
const PRESSED = 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul. To spawn now, pick a harness or a launch configuration for this spawn. To fix it for every spawn, correct the preference.';
const TABLE = 'A launch preference on this machine names a soul the workspace does not offer, and this spawn names no launch.';
const SAID = 'the file points "ghost" at a launch and no soul answers to that name', REMEDY = 'point the entry at a soul, then drop "ghost"';

test('an unmatched launch preference: the code is in the preview table, so it survives a press with the table\'s sentence', () => {
  assert.ok(PREVIEW.includes(UNMATCHED));
  assert.deepEqual(previewFailure(UNMATCHED).reason, { code: UNMATCHED, message: TABLE });
  assert.deepEqual(spawnApplyReason(UNMATCHED), { code: UNMATCHED, message: TABLE });
  assert.deepEqual(spawnApplyReason(UNMATCHED, SAID), { code: UNMATCHED, message: TABLE }, 'no kernel text travels with a press');
});

test('an unmatched launch preference: the long sentence is read at the preview with the kernel\'s texts, the shorter one everywhere else', () => {
  plain(OPENS, UNMATCHED); plain(PRESSED, UNMATCHED);
  // As the dialog opens: the reason carries the kernel's message and its fix.
  const opens = spawnProblem({ code: UNMATCHED, message: SAID, fix: REMEDY }, 'preview');
  assert.deepEqual(opens, { fact: LEAD, next: 'change-options', code: UNMATCHED, detail: UNMATCHED, kernel: { message: SAID, fix: REMEDY } });
  assert.equal(spawnText(opens, 'preview'), OPENS, 'the Desktop names its controls after the shared lead');
  // The parts are the strings as they came: nothing trimmed, joined or taken out.
  const raw = spawnProblem({ code: UNMATCHED, message: `  ${SAID}\n${REMEDY}  `, fix: ` ${REMEDY} ` }, 'preview');
  assert.deepEqual(raw.kernel, { message: `  ${SAID}\n${REMEDY}  `, fix: ` ${REMEDY} ` });
  assert.equal(raw.detail, UNMATCHED, 'no kernel text in detail: no consumer of it may show one without its speaker');
  // A press: the table's sentence travelled, no fix; the shorter sentence, and Details as for any code.
  const pressed = spawnProblem(spawnApplyReason(UNMATCHED), 'spawn');
  assert.deepEqual(pressed, { fact: PRESSED, next: null, code: UNMATCHED, detail: `${UNMATCHED} · ${TABLE}` });
  assert.equal(spawnText(pressed, 'spawn'), PRESSED);
  // "(Details)" never points at Details that hold no kernel text: at the preview without a fix, the shorter one.
  assert.deepEqual(spawnProblem(previewFailure(UNMATCHED).reason, 'preview'), { fact: PRESSED, next: null, code: UNMATCHED, detail: `${UNMATCHED} · ${TABLE}` });
  assert.deepEqual(spawnProblem({ code: UNMATCHED, message: SAID }, 'preview'), { fact: PRESSED, next: null, code: UNMATCHED, detail: `${UNMATCHED} · ${SAID}` });
  assert.deepEqual(spawnProblem({ code: UNMATCHED }, 'preview'), { fact: PRESSED, next: null, code: UNMATCHED, detail: UNMATCHED });
  // The stage's sentence at a press, whatever the reason carries.
  assert.equal(spawnText(spawnProblem({ code: UNMATCHED, message: SAID, fix: REMEDY }, 'spawn'), 'spawn'), PRESSED);
});

test('an unmatched launch preference: a reader stays tolerant of a fix that is not a usable string', () => {
  for (const fix of [undefined, null, '', '   ', 7, true, [REMEDY], { fix: REMEDY }]) {
    const problem = spawnProblem({ code: UNMATCHED, message: SAID, fix }, 'preview');
    assert.deepEqual(problem, { fact: PRESSED, next: null, code: UNMATCHED, detail: `${UNMATCHED} · ${SAID}` }, JSON.stringify(fix) ?? 'undefined');
  }
  // A message that is not a string, beside a fix: the fix is still the kernel's, and it is the part there is.
  assert.deepEqual(spawnProblem({ code: UNMATCHED, message: 7, fix: REMEDY }, 'preview').kernel, { message: '', fix: REMEDY });
  assert.deepEqual(spawnProblem({ code: UNMATCHED, fix: REMEDY }, 'preview').kernel, { message: '', fix: REMEDY });
});

test('the parts are this one code\'s: every other code with a fix reads as before', () => {
  for (const code of [...PREVIEW, ...APPLY, 'E_SOMETHING_NEW'].filter(c => c !== UNMATCHED)) for (const stage of ['preview', 'spawn']) {
    const problem = spawnProblem({ code, message: SAID, fix: REMEDY }, stage);
    assert.equal(Object.hasOwn(problem, 'kernel'), false, code); assert.equal(problem.detail, `${code} · ${SAID}`, code);
  }
});

test('previewFailure: no fix without the kernel\'s message, so a fix never stands beside a sentence of a table', () => {
  // The kernel's message travelled: its fix travels with it.
  assert.deepEqual(previewFailure(UNMATCHED, null, SAID, REMEDY).reason, { code: UNMATCHED, message: SAID, fix: REMEDY });
  // The message did not (missing, blank, not a string, over the bound, a control character): the table's sentence, and no fix.
  for (const message of [undefined, null, '', '   ', 7, `${SAID} ${'x'.repeat(2048)}`, `${SAID}\tmore`, `${SAID}\u001b[2J`]) {
    assert.deepEqual(previewFailure(UNMATCHED, null, message, REMEDY).reason, { code: UNMATCHED, message: TABLE }, JSON.stringify(message) ?? 'undefined');
  }
  // The same for a code of no table: the fallback's own sentence, and no fix.
  assert.equal(Object.hasOwn(previewFailure('E_SOMETHING_NEW', null, '', REMEDY).reason, 'fix'), false);
  // A fix that is not bounded, printable text does not travel; the message still does.
  for (const fix of [undefined, '', '   ', 7, 'x'.repeat(1025), `${REMEDY}\n`, `${REMEDY}\u0007`]) {
    assert.deepEqual(previewFailure(UNMATCHED, null, SAID, fix).reason, { code: UNMATCHED, message: SAID }, JSON.stringify(fix) ?? 'undefined');
  }
});
