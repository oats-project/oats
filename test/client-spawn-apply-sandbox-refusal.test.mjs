// The confirmed-spawn transport (packages/client/spawn-apply-cli.mjs cliSpawnApply) and a kernel refusal
// that says what a person does next: E_SANDBOX_PLACEMENT (feature sandboxes, the sandboxes record's
// D-S1-4). A spawn into a sandbox is bound and keyed by the kernel itself, so the Desktop's confirmed apply
// (`--expect-decision`, `--idempotency-key`) of a soul placed in one is refused, reason `caller-bound`, with
// a remedy in `details.remedy` that also ends the message. The transport keeps the code, the kernel's
// message and `details: {reason, remedy}`, each bounded, and nothing else of the details; an unknown code is
// still E_CLI_FAILED. The confirmed-spawn broker (spawn-apply.mjs) answers it refused (nothing was created),
// in the kernel's words, and the sheet's shared words (spawn-messages.mjs) say so with the remedy behind
// Details. The kernel is a scripted `execFile`: this is the reader's rule, not the kernel's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cliSpawnApply } from '../packages/client/spawn-apply-cli.mjs';
import { spawnApplyReason, kernelWordedDetails } from '../packages/client/spawn-apply-contract.mjs';
import { spawnProblem } from '../packages/client/spawn-messages.mjs';
import { cli, target, data, selector } from '../packages/desktop/test/helpers/spawn-preview-fixture.mjs';
import { applyContext, applyPreview } from '../packages/desktop/test/helpers/spawn-apply-fixture.mjs';

const brokerModules = async () => ({ ...(await import('../packages/client/spawn-apply.mjs')), ...(await import('../packages/client/spawn-apply-contract.mjs')) });

const capable = () => ({ ...structuredClone(cli), spawnApplyApi: 1, features: [...cli.features, 'spawn-apply-2', 'spawn-idempotency-2'] });
const options = () => ({ target: structuredClone(target), choices: {}, decision: data().decision, key: 'a'.repeat(64), task: 'Ingest the feed.' });
const REMEDY = "Spawn it with `oats spawn ingester` (OATS binds it to the sandbox itself) or from a schedule; the Desktop can't spawn into a sandbox yet.";
const MESSAGE = `ingester runs in sandbox ingest, and a spawn into a sandbox is bound and keyed by OATS, never by its caller (--expect-decision, --idempotency-key); nothing was minted, kept or spawned — ${REMEDY}`;

/** The transport, the kernel answering `error` with exit 1. */
const applied = (error) => cliSpawnApply(capable(), options(), { env: { PATH: '/inert/bin', HOME: '/inert/home' },
  exec: (_bin, _argv, _options, done) => done({ code: 1 }, JSON.stringify({ schemaVersion: 1, ok: false, error })) });

test('E_SANDBOX_PLACEMENT caller-bound crosses with its code, the kernel\'s message, its reason and its remedy, unchanged', async () => {
  const result = await applied({ code: 'E_SANDBOX_PLACEMENT', message: MESSAGE,
    details: { reason: 'caller-bound', sandbox: 'ingest', flags: ['--expect-decision', '--idempotency-key'], remedy: REMEDY, task: 'PRIVATE' } });
  assert.equal(result.started, true);
  assert.deepEqual(result.envelope, { schemaVersion: 1, ok: false, error: { code: 'E_SANDBOX_PLACEMENT', message: MESSAGE, details: { reason: 'caller-bound', remedy: REMEDY } } });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/, 'nothing else of the details travels');
});

test('an unknown code is still E_CLI_FAILED, its message and details dropped', async () => {
  const result = await applied({ code: 'E_SOMETHING_NEW', message: 'PRIVATE kernel words', details: { reason: 'caller-bound', remedy: 'PRIVATE' } });
  assert.equal(result.envelope.error.code, 'E_CLI_FAILED');
  assert.equal(result.envelope.error.details, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('an over-long or unsafe message falls back to the fixed sentence; an over-long or unsafe remedy and a malformed reason are dropped', async () => {
  const fixed = spawnApplyReason('E_SANDBOX_PLACEMENT').message;
  assert.match(fixed, /sandbox/);
  for (const message of ['m'.repeat(2049), 'a control\u0007character', 'see https://user:PRIVATE@example.org', '   ', undefined]) {
    const result = await applied({ code: 'E_SANDBOX_PLACEMENT', message, details: { reason: 'caller-bound', remedy: REMEDY } });
    assert.equal(result.envelope.error.code, 'E_SANDBOX_PLACEMENT');
    assert.equal(result.envelope.error.message, fixed, JSON.stringify(message)?.slice(0, 40));
    assert.deepEqual(result.envelope.error.details, { reason: 'caller-bound', remedy: REMEDY });
  }
  // At the bound, it travels.
  assert.equal((await applied({ code: 'E_SANDBOX_PLACEMENT', message: 'm'.repeat(2048) })).envelope.error.message, 'm'.repeat(2048));
  for (const remedy of ['r'.repeat(1025), `token ghp_${'A'.repeat(20)}`, 'a\u0000b', 42]) {
    const result = await applied({ code: 'E_SANDBOX_PLACEMENT', message: MESSAGE, details: { reason: 'caller-bound', remedy } });
    assert.deepEqual(result.envelope.error.details, { reason: 'caller-bound' }, JSON.stringify(remedy).slice(0, 40));
  }
  assert.deepEqual(kernelWordedDetails({ reason: 'r'.repeat(1024), remedy: 'r'.repeat(1024) }), { remedy: 'r'.repeat(1024) });
  for (const reason of ['Caller-Bound', 'caller bound', 'r'.repeat(65), '', 7]) assert.equal(kernelWordedDetails({ reason }), null, String(reason));
  // No valid detail: no details at all.
  const bare = await applied({ code: 'E_SANDBOX_PLACEMENT', message: MESSAGE, details: { reason: 'NOT A SLUG' } });
  assert.equal(Object.hasOwn(bare.envelope.error, 'details'), false);
});

test('through the confirmed-spawn broker: refused, nothing created, in the kernel\'s words; the view and the sheet\'s words keep the remedy', async () => {
  const { createSpawnApplyBoundary, spawnApplyView } = await brokerModules();
  const c = applyContext();
  const error = { code: 'E_SANDBOX_PLACEMENT', message: MESSAGE, details: { reason: 'caller-bound', sandbox: 'ingest', flags: ['--expect-decision', '--idempotency-key'], remedy: REMEDY } };
  const exec = (_bin, _argv, _options, done) => { done({ code: 1 }, JSON.stringify({ schemaVersion: 1, ok: false, error })); return { kill() { return true; } }; };
  const broker = createSpawnApplyBoundary({ read: async () => ({ status: 'available', data: applyPreview(target) }), exec });
  const send = (request) => broker(request, () => c);
  const prepared = await send({ action: 'prepare', selector, choices: {}, task: '' });
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  const answered = await send({ action: 'apply', spawnRef: prepared.spawnRef });
  assert.equal(answered.status, 'refused', JSON.stringify(answered));
  assert.deepEqual(answered.reason, { code: 'E_SANDBOX_PLACEMENT', message: MESSAGE });
  // The Desktop's HTTP view, projected again at its trust boundary, keeps it.
  const view = spawnApplyView(JSON.parse(JSON.stringify(answered)), { workspace: target.workspace });
  assert.equal(view.status, 'refused');
  assert.deepEqual(view.reason, { code: 'E_SANDBOX_PLACEMENT', message: MESSAGE });
  // The sheet's words (every client's): what happened, and the kernel's remedy behind Details.
  const problem = spawnProblem(view.reason, 'spawn');
  assert.match(problem.fact, /runs in a sandbox/);
  assert.match(problem.fact, /Nothing was created/);
  assert.ok(problem.detail.endsWith(REMEDY), problem.detail);
  assert.equal(problem.next, null, 'no act to try again: a confirmed spawn cannot reach a sandbox');
  // The sentence the Desktop composes from it names no retry.
  const { spawnText } = await import('../packages/desktop/renderer/spawn-words.mjs');
  const sentence = spawnText(problem, 'spawn');
  assert.match(sentence, /runs in a sandbox/);
  assert.doesNotMatch(sentence, /try again/i, sentence);
  // Any other dispatched refusal the broker does not know is still unknown, never refused.
  const other = createSpawnApplyBoundary({ read: async () => ({ status: 'available', data: applyPreview(target) }),
    exec: (_b, _a, _o, done) => { done({ code: 1 }, JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_SOMETHING_NEW', message: 'm' } })); return { kill() { return true; } }; } });
  const p2 = await other({ action: 'prepare', selector, choices: {}, task: '' }, () => c);
  assert.equal((await other({ action: 'apply', spawnRef: p2.spawnRef }, () => c)).status, 'unknown');
});
