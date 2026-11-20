// The confirmed-spawn transport (packages/client/spawn-apply-cli.mjs cliSpawnApply) and a kernel refusal
// that says what a person does next: E_SANDBOX_PLACEMENT (feature sandboxes, the sandboxes record's
// D-S1-4). A spawn into a sandbox is bound and keyed by the kernel itself, so the Desktop's confirmed apply
// (`--expect-decision`, `--idempotency-key`) of a soul placed in one is refused, reason `caller-bound`, with
// a remedy in `details.remedy` that also ends the message. The transport keeps the code, the kernel's
// message and `details: {reason, remedy}`, each bounded, and nothing else of the details; an unknown code is
// still E_CLI_FAILED. The kernel is a scripted `execFile`: this is the reader's rule, not the kernel's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cliSpawnApply } from '../packages/client/spawn-apply-cli.mjs';
import { spawnApplyReason, kernelWordedDetails } from '../packages/client/spawn-apply-contract.mjs';
import { cli, target, data } from '../packages/desktop/test/helpers/spawn-preview-fixture.mjs';

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
