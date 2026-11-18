// An answer the kernel gave never reads as "OATS couldn't be run for this." (#866): a kernel code without a
// sentence keeps its own code under the fallback sentence, E_RUNTIME_QUIESCE_FAILED and
// E_UNIDENTIFIED_INSTANCE_HOME have their own (the second one is a refusal, nothing was done), and a code
// Desktop raises itself always has its own and never reaches the fallback. Its own is the shared table's, but
// for main's frame code, whose sentence is the Desktop's alone (renderer/lifecycle-frame.mjs).
// Kernel messages are display text, never input to the client's decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createLifecycleDialog } from '../renderer/lifecycle-dialog.mjs';
import { createLifecycleBoundary, BEFORE_EFFECT_CODES } from '../../client/instance-lifecycle.mjs';
import { lifecycleReason, lifecycleDetailCode, undescribedAnswer, undescribedRefusal, stoppedTargets } from '../../client/lifecycle-contract.mjs';
import { DETAIL_WITHHELD } from '../../client/display-text.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { cliLifecycle } from '../../client/lifecycle-cli.mjs';
import { LIFECYCLE_FORBIDDEN_FRAME, lifecycleFrameRefusal } from '../renderer/lifecycle-frame.mjs';
import { remoteReason } from '../../client/remote-address.mjs';
import { cli, context, envelope, instance, stopPlan, retirePlan, tick } from './helpers/lifecycle-fixture.mjs';
import { assertIsolatedDetail, MESSY, MESSY_LINE } from './helpers/detail-line.mjs';

// Each sentence whole, once: every assertion below names it.
const UNDESCRIBED = 'OATS answered with an error that Desktop has no description for.';
const NOT_RUN = "OATS couldn't be run for this.";
const QUIESCE = "OATS tried to end a session or a process and couldn't confirm that it ended.";
const UNKNOWN = "OATS didn't confirm the result. Check again before assuming nothing happened.";
const HOME_CLEANUP = "OATS can't tell what this home's capabilities created, or can't run their cleanup. Nothing was removed. If Details allows removal, clean up by hand, then run `oats retire <name> --force` in a terminal.";
const SAID = 'a stand-in for the kernel message';
/** The kernel's error envelope as the adapter passes it on (`origin: 'kernel'`), and one that does not say so. */
const answered = (code, ...message) => ({ schemaVersion: 1, ok: false, origin: 'kernel', error: { code, message: message.length ? message[0] : SAID } });
const unmarked = (code, message = SAID) => ({ schemaVersion: 1, ok: false, error: { code, message } });
const routedContext = () => ({ cli: { ...structuredClone(cli), remote: ['lifecycle-plans'] }, localCwd: '/Users/me/work',
  workspace: { id: 'team', name: 'Build box', scope: '/srv', remote: true, server: 'build' },
  instances: [{ ...instance, server: 'build', addressable: true, missingRemotely: false, savedRoute: false, running: true }] });
const selectorOf = ctx => ({ instance: instance.instance, agent: instance.agent, agentsRoot: instance.agentsRoot, server: ctx.workspace.server ?? null });
const optionsOf = operation => operation === 'stop' ? { recursive: true } : { discardWorktree: false };
const planOf = operation => operation === 'stop' ? stopPlan() : retirePlan();
/** The boundary's replies when the kernel answers the plan read with `planAnswer`, or the apply with `answer`. */
async function replies(ctx, operation, { planAnswer, answer } = {}) {
  const service = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: async (_bin, args) => args.phase === 'plan' ? planAnswer ?? envelope(planOf(operation)) : answer });
  const planned = await service({ action: 'plan', operation, selector: selectorOf(ctx), options: optionsOf(operation) }, () => ctx);
  return { planned, applied: planned.status === 'plan' ? await service({ action: 'apply', planRef: planned.planRef }, () => ctx) : null };
}
/** The dialog over the real server boundary. */
function mount(t, { ctx = context(), operation = 'retire', planAnswer, answer }) {
  const dom = new JSDOM('<!doctype html><button id="opener">Actions</button>', { pretendToBeVisual: true }), doc = dom.window.document;
  const service = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: async (_bin, args) => args.phase === 'plan' ? planAnswer ?? envelope(planOf(operation)) : answer });
  const dialog = createLifecycleDialog({ doc, request: (_ws, body) => service(body, () => ctx) });
  t.after(() => { dialog.dispose(); dom.window.close(); });
  const row = ctx.workspace.server ? { ...instance, server: ctx.workspace.server, repoName: ctx.workspace.name, addressable: true } : instance;
  return { doc, async open() { dialog.open({ operation, instance: row, workspace: 'team' }); await tick(); },
    async confirm() { await this.open(); doc.querySelector('.lifecycle-confirm').click(); await tick(); },
    status: () => doc.querySelector('.lifecycle-dialog [role=status]').textContent, title: () => doc.querySelector('.lifecycle-dialog h2').textContent,
    note: () => doc.querySelector('.lifecycle-result .lifecycle-note')?.textContent ?? null, details: () => doc.querySelector('.lifecycle-details'),
    footer: () => [...doc.querySelectorAll('.lifecycle-footer button')].filter(b => !b.hidden).map(b => b.textContent) };
}

test('E_RUNTIME_QUIESCE_FAILED has its own sentence, may show the kernel message, and is never a refusal before any effect', () => {
  assert.deepEqual(lifecycleReason('E_RUNTIME_QUIESCE_FAILED', DESKTOP_TERMS), { code: 'E_RUNTIME_QUIESCE_FAILED', message: QUIESCE });
  assert.equal(lifecycleDetailCode('E_RUNTIME_QUIESCE_FAILED'), true);
  assert.equal(BEFORE_EFFECT_CODES.includes('E_RUNTIME_QUIESCE_FAILED'), false, 'the outcome is unknown: a session or a process may still run');
  assert.equal(undescribedAnswer('E_RUNTIME_QUIESCE_FAILED', DESKTOP_TERMS), null);
});

test("E_RUNTIME_QUIESCE_FAILED answered to an apply: an unknown outcome, its sentence as the cause, and the kernel's message in Details, local and routed", async t => {
  for (const operation of ['stop', 'retire']) {
    const { applied } = await replies(context(), operation, { answer: answered('E_RUNTIME_QUIESCE_FAILED', MESSY) });
    assert.equal(applied.status, 'unknown', operation); assert.deepEqual(applied.reason, { code: 'E_OUTCOME_UNKNOWN', message: UNKNOWN });
    assert.deepEqual(applied.cause, { code: 'E_RUNTIME_QUIESCE_FAILED', message: QUIESCE, detail: MESSY_LINE }, operation);
    const routed = await replies(routedContext(), operation, { answer: answered('E_RUNTIME_QUIESCE_FAILED', MESSY) });
    assert.equal(routed.applied.status, 'unknown'); assert.deepEqual(routed.applied.cause, { code: 'E_RUNTIME_QUIESCE_FAILED', message: QUIESCE, detail: MESSY_LINE, remote: true });
  }
  for (const ctx of [context(), routedContext()]) {
    const u = mount(t, { ctx, answer: answered('E_RUNTIME_QUIESCE_FAILED', MESSY) });
    await u.confirm();
    assert.equal(u.title(), 'Result not confirmed'); assert.equal(u.status(), UNKNOWN); assert.equal(u.note(), QUIESCE);
    assert.equal(u.details().querySelector('summary').textContent, 'Details');
    assertIsolatedDetail(u.details().querySelector('p'), { before: 'E_RUNTIME_QUIESCE_FAILED: ', detail: MESSY_LINE });
    assert.equal(u.doc.body.textContent.split(MESSY_LINE).length, 2, 'the kernel message is in Details only, never the main text');
    assert.deepEqual(u.footer(), ['Check again', 'Close']);
    assert.equal(u.doc.body.textContent.includes(NOT_RUN), false);
  }
});

test("a kernel's error answer whose code has no sentence keeps its own code under the fallback sentence, with the kernel's message as its detail", async () => {
  // E_LIFECYCLE_FAILED: the kernel's code for a failure it has no other code for. It never gets a sentence
  // here, nor a place in the list: the code alone does not say that nothing happened.
  for (const code of ['E_LIFECYCLE_FAILED', 'E_NOT_IN_THE_TABLE']) {
    assert.deepEqual(undescribedAnswer(code, DESKTOP_TERMS), { code, message: UNDESCRIBED }, code);
    assert.deepEqual(lifecycleReason(code, DESKTOP_TERMS), { code: 'E_CLI_FAILED', message: NOT_RUN }, 'lifecycleReason knows no origin and keeps its reply');
    for (const operation of ['stop', 'retire']) {
      const { applied } = await replies(context(), operation, { answer: answered(code, MESSY) });
      // No status changes with it: refused and unknown are decided by BEFORE_EFFECT_CODES, as before.
      assert.equal(applied.status, 'unknown', code); assert.deepEqual(applied.reason, { code: 'E_OUTCOME_UNKNOWN', message: UNKNOWN });
      assert.deepEqual(applied.cause, { code, message: UNDESCRIBED, detail: MESSY_LINE }, `${operation} ${code}`);
      const { planned } = await replies(context(), operation, { planAnswer: answered(code, MESSY) });
      assert.equal(planned.status, 'unavailable'); assert.deepEqual(planned.reason, { code, message: UNDESCRIBED, detail: MESSY_LINE }, `${operation} ${code}`);
      // Routed: the same sentence under the host's code, as a remote reason.
      const routed = await replies(routedContext(), operation, { planAnswer: answered(code, MESSY) });
      assert.deepEqual(routed.planned.reason, { code, message: UNDESCRIBED, detail: MESSY_LINE, remote: true }, `routed ${operation} ${code}`);
      assert.deepEqual(remoteReason(routed.planned.reason), routed.planned.reason);
    }
    // No message, or nothing to show: the code and the sentence alone. A message that looks like a credential: withheld whole.
    for (const none of [undefined, null, '', ' \n\t ', 7]) assert.deepEqual((await replies(context(), 'retire', { answer: answered(code, none) })).applied.cause, { code, message: UNDESCRIBED }, String(none));
    assert.deepEqual((await replies(context(), 'retire', { answer: answered(code, 'see token=abc123') })).applied.cause, { code, message: UNDESCRIBED, detail: DETAIL_WITHHELD });
  }
});

test('the fallback is chosen by where the code came from: an envelope that does not say the kernel answered, and a system code, keep today\'s sentence and show no text', async () => {
  for (const answer of [unmarked('E_NOT_IN_THE_TABLE'), { ...answered('E_NOT_IN_THE_TABLE'), origin: 'adapter' }, { ...answered('E_NOT_IN_THE_TABLE'), origin: true }]) {
    const { applied } = await replies(context(), 'retire', { answer }), { planned } = await replies(context(), 'retire', { planAnswer: answer });
    assert.deepEqual(applied.cause, { code: 'E_CLI_FAILED', message: NOT_RUN }, JSON.stringify(answer)); assert.deepEqual(planned.reason, { code: 'E_CLI_FAILED', message: NOT_RUN });
    assert.doesNotMatch(JSON.stringify([applied, planned]), /stand-in|E_NOT_IN_THE_TABLE/);
  }
  // An answer that is no error envelope, whatever origin it claims: to an apply it is an unknown outcome with no cause at all.
  for (const answer of [{ ...answered('E_NOT_IN_THE_TABLE'), schemaVersion: 2 }, { ...answered('E_NOT_IN_THE_TABLE'), ok: 'false' }]) {
    const { applied } = await replies(context(), 'retire', { answer }), { planned } = await replies(context(), 'retire', { planAnswer: answer });
    assert.equal(applied.status, 'unknown'); assert.deepEqual(planned.reason, { code: 'E_CLI_FAILED', message: NOT_RUN }, JSON.stringify(answer));
    assert.doesNotMatch(JSON.stringify([applied, planned]), /stand-in|E_NOT_IN_THE_TABLE|no description/);
  }
  // An older kernel's system code is not in the kernel's code shape: the shape is only this guard.
  for (const code of ['ENOENT', 'EACCES', 'unsafe-config-key', 'e_lower', 'E_', `E_${'A'.repeat(65)}`, '', undefined, null, 7]) {
    assert.equal(undescribedAnswer(code, DESKTOP_TERMS), null, String(code));
    const { applied } = await replies(context(), 'retire', { answer: answered(code) });
    assert.equal(applied.status, 'unknown'); assert.deepEqual(applied.cause, { code: 'E_CLI_FAILED', message: NOT_RUN }, String(code));
    assert.doesNotMatch(JSON.stringify(applied), /stand-in/, String(code));
  }
  // Routed: a code the remote table already heads keeps its headline.
  const ssh = await replies(routedContext(), 'retire', { planAnswer: answered('E_SSH') });
  assert.deepEqual(ssh.planned.reason, { code: 'E_SSH', message: "Couldn't reach Build box.", detail: SAID, remote: true });
});

/** The codes each part of Desktop raises itself, read from its source: `name('E_…'` and `name(cond ? 'E_…' : 'E_…'`. */
const raisedIn = (path, names, ...more) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const call = new RegExp(`\\b(?:${names})\\((?:[^'(),]*\\? )?'([^']+)'(?: : '([^']+)')?`, 'g');
  return [...new Set([call, ...more].flatMap(re => [...source.matchAll(re)].flatMap(m => m.slice(1).filter(Boolean))))].sort();
};
/** main's frame guard answers through `lifecycleFrameRefusal()`, which names no code where main calls it: the
 * code it raises is the one lifecycle-frame.mjs holds. */
const frameRaisedIn = path => /\blifecycleFrameRefusal\(\)/.test(readFileSync(new URL(path, import.meta.url), 'utf8')) ? [LIFECYCLE_FORBIDDEN_FRAME.code] : [];
const RAISED = {
  adapter: ['E_BAD_ARGS', 'E_CLI_FAILED', 'E_CLI_OUTPUT_LIMIT', 'E_CLI_PROTOCOL', 'E_CLI_TIMEOUT'],
  // E_CLI_TIMEOUT: the cause of the `unknown` an apply answers when the boundary's wait for it ends (APPLY_WAIT_MS).
  boundary: ['E_BAD_ARGS', 'E_CLI_FAILED', 'E_CLI_PROTOCOL', 'E_CLI_TIMEOUT', 'E_LIFECYCLE_BUSY', 'E_LIFECYCLE_UNAVAILABLE', 'E_OPTION_UNAVAILABLE', 'E_OUTCOME_UNKNOWN', 'E_PLAN_CHANGED', 'E_PLAN_EXPIRED', 'E_WORKSPACE_UNKNOWN'],
  main: ['E_CLI_FAILED', 'E_CLI_PROTOCOL', 'E_FORBIDDEN_FRAME', 'E_OUTCOME_UNKNOWN', 'E_PLAN_CHANGED'],
  admission: ['E_AMBIGUOUS_INSTANCE', 'E_BAD_ARGS', 'E_HOME_MISMATCH', 'E_SESSION_UNKNOWN', 'E_SNAPSHOT_UNKNOWN', 'E_WORKSPACE_UNKNOWN', 'cli-unavailable', 'unsupported-remote-operation'],
  // The reason the boundary gives a partial receipt, and the code of the old retire route: not found by the reading above.
  other: ['E_SESSION_STOP_FAILED', 'E_RETIRE_INCOMPLETE', 'E_PLAN_REQUIRED'],
};

test('every code Desktop raises itself (the adapter, the boundary, admission, main) has its own sentence; reading the sources finds no other', () => {
  assert.deepEqual(raisedIn('../../client/lifecycle-cli.mjs', 'failure'), RAISED.adapter);
  assert.deepEqual(raisedIn('../../client/instance-lifecycle.mjs', 'denied|failure|lifecycleReason', /error: \{ code: '([^']+)' \}/g, /\|\| '([^']+)'/g), RAISED.boundary);
  assert.deepEqual([...raisedIn('../main.mjs', 'failure'), ...frameRaisedIn('../main.mjs')].sort(), RAISED.main);
  for (const path of ['../../client/lifecycle-cli.mjs', '../../client/instance-lifecycle.mjs', '../../client/instance-admission.mjs']) assert.deepEqual(frameRaisedIn(path), [], path);
  assert.deepEqual(raisedIn('../../client/instance-admission.mjs', 'denied'), RAISED.admission);
  for (const code of new Set(Object.values(RAISED).flat())) {
    // A remote row that is not addressable is refused by admission with its own sentence, which names the server.
    if (code === 'E_SNAPSHOT_UNKNOWN') continue;
    // main's frame code: its own sentence is the Desktop's, held in lifecycle-frame.mjs and not in the shared
    // table. The answer main sends carries that code and that sentence, and never reads by the fallback.
    if (code === 'E_FORBIDDEN_FRAME') {
      assert.deepEqual(LIFECYCLE_FORBIDDEN_FRAME, { code, message: 'This window cannot request a lifecycle operation.' });
      const { reason } = lifecycleFrameRefusal();
      assert.deepEqual(reason, LIFECYCLE_FORBIDDEN_FRAME); assert.notEqual(reason.message, UNDESCRIBED); assert.notEqual(reason.message, NOT_RUN);
      assert.equal(undescribedRefusal(reason, DESKTOP_TERMS), null, `${code} never reads by the fallback`); assert.equal(lifecycleDetailCode(code), false);
      continue;
    }
    assert.deepEqual(Object.keys(lifecycleReason(code, DESKTOP_TERMS)), ['code', 'message']); assert.equal(lifecycleReason(code, DESKTOP_TERMS).code, code, `${code} has its own sentence`);
    assert.notEqual(lifecycleReason(code, DESKTOP_TERMS).message, UNDESCRIBED); if (code !== 'E_CLI_FAILED') assert.notEqual(lifecycleReason(code, DESKTOP_TERMS).message, NOT_RUN, code);
    assert.equal(undescribedAnswer(code, DESKTOP_TERMS), null, `${code} never reads by the fallback`);
  }
});

test('none of those codes reaches the fallback, whatever came with it: not even in an envelope that says the kernel answered', async () => {
  for (const code of new Set(Object.values(RAISED).flat())) {
    // main's frame code is not the boundary's to read: main answers it without asking the boundary. See below.
    if (['E_SNAPSHOT_UNKNOWN', 'E_PLAN_REQUIRED', 'E_FORBIDDEN_FRAME'].includes(code)) continue;
    for (const ctx of [context, routedContext]) {
      const { applied } = await replies(ctx(), 'stop', { answer: answered(code) }), { planned } = await replies(ctx(), 'stop', { planAnswer: answered(code) });
      for (const reason of [applied.reason, applied.cause, planned.reason].filter(Boolean)) assert.notEqual(reason.message, UNDESCRIBED, code);
      assert.equal(JSON.stringify([applied, planned]).includes(UNDESCRIBED), false, code);
    }
  }
  // Admission's own refusal of a remote row carries its own sentence and reaches no table.
  const ctx = routedContext(); ctx.instances[0].addressable = false; ctx.instances[0].missingRemotely = true;
  const { planned } = await replies(ctx, 'stop');
  assert.equal(planned.reason.code, 'E_SNAPSHOT_UNKNOWN'); assert.match(planned.reason.message, /^dev-1 is no longer on Build box\./);
  // The boundary's own failures: a command that could not be run, and an answer that is no envelope.
  const thrown = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: async () => { throw new Error('PRIVATE'); } }), c = context();
  assert.deepEqual((await thrown({ action: 'plan', operation: 'stop', selector: selectorOf(c), options: optionsOf('stop') }, () => c)).reason, { code: 'E_CLI_FAILED', message: NOT_RUN });
  assert.deepEqual((await replies(context(), 'stop', { planAnswer: 'not an envelope' })).planned.reason, lifecycleReason('E_CLI_PROTOCOL', DESKTOP_TERMS));
  // The frame code reaches the boundary only if a kernel answers it, and none does. To the shared table it is
  // then a kernel code without a sentence, like any other: never main's sentence for an answer main did not give.
  const frame = { ...await replies(context(), 'stop', { planAnswer: answered('E_FORBIDDEN_FRAME') }), applied: (await replies(context(), 'stop', { answer: answered('E_FORBIDDEN_FRAME') })).applied };
  assert.deepEqual(frame.planned.reason, { code: 'E_FORBIDDEN_FRAME', message: UNDESCRIBED, detail: SAID });
  assert.equal(frame.applied.reason.code, 'E_OUTCOME_UNKNOWN'); assert.deepEqual(frame.applied.cause, { code: 'E_FORBIDDEN_FRAME', message: UNDESCRIBED, detail: SAID });
  assert.equal(JSON.stringify(frame).includes(LIFECYCLE_FORBIDDEN_FRAME.message), false);
});

test("a failed row's code still goes through the table's own lookup (lifecycleCode): a code without a sentence in a row is unchanged by the fallback", () => {
  const plan = retirePlan(); plan.facts.children = [{ instance: 'kid', agent: 'dev', home: '/team/agents/dev/instances/kid', session: { state: 'running', present: true, established: true, backend: 'tmux' } }];
  const row = code => stoppedTargets([{ instance: 'kid', home: '/team/agents/dev/instances/kid', ok: false, code, message: SAID, stillRunning: null }], plan.facts.children)[0];
  assert.equal(row('E_SESSION_UNAVAILABLE').code, 'E_CLI_FAILED'); assert.equal(row('E_SESSION_STOP_FAILED').code, 'E_SESSION_STOP_FAILED');
  assert.equal(row('E_RUNTIME_QUIESCE_FAILED').code, 'E_RUNTIME_QUIESCE_FAILED');
});

test('undescribedRefusal re-validates a relayed reason: a kernel code without a sentence, the fixed fallback sentence, a detail that is a display line', () => {
  assert.deepEqual(undescribedRefusal({ code: 'E_LIFECYCLE_FAILED', message: UNDESCRIBED, detail: SAID }, DESKTOP_TERMS), { code: 'E_LIFECYCLE_FAILED', message: UNDESCRIBED, detail: SAID });
  assert.deepEqual(undescribedRefusal({ code: 'E_LIFECYCLE_FAILED', message: UNDESCRIBED, detail: SAID, remote: true }, DESKTOP_TERMS), { code: 'E_LIFECYCLE_FAILED', message: UNDESCRIBED, detail: SAID });
  // A detail that is not a display line is not shown; the reason still reads by the sentence, with its code.
  for (const detail of [undefined, null, 'UNSHOWN two\nlines', 'UNSHOWN two  spaces', 'UNSHOWN token=abc123', 7])
    assert.deepEqual(undescribedRefusal({ code: 'E_NOT_IN_THE_TABLE', message: UNDESCRIBED, detail }, DESKTOP_TERMS), { code: 'E_NOT_IN_THE_TABLE', message: UNDESCRIBED, detail: null }, JSON.stringify(detail));
  // Not it: a code that has its own sentence, a code outside the kernel's shape, and any other sentence, whatever
  // else the reply claims. The dialog decides from the reason it is given; it trusts no `origin` of a reply.
  for (const reason of [{ code: 'E_WORK_INSPECTION_FAILED', message: UNDESCRIBED }, { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: UNDESCRIBED }, { code: 'E_CLI_FAILED', message: UNDESCRIBED }, { code: 'ENOENT', message: UNDESCRIBED },
    { code: 'E_NOT_IN_THE_TABLE', message: 'A HEADLINE FROM THE REPLY' }, { code: 'E_NOT_IN_THE_TABLE', message: `${UNDESCRIBED} ` }, { code: 'E_NOT_IN_THE_TABLE', message: NOT_RUN, origin: 'kernel' },
    { code: 'E_NOT_IN_THE_TABLE', origin: 'kernel' }, { message: UNDESCRIBED }, null, UNDESCRIBED, [{ code: 'E_NOT_IN_THE_TABLE', message: UNDESCRIBED }]])
    assert.equal(undescribedRefusal(reason, DESKTOP_TERMS), null, JSON.stringify(reason));
});

test('the dialog: a refused plan and an apply answered with a code nothing describes show the fallback sentence, and the code with the kernel message in Details', async t => {
  for (const ctx of [context, routedContext]) {
    const planned = mount(t, { ctx: ctx(), planAnswer: answered('E_LIFECYCLE_FAILED', MESSY) });
    await planned.open();
    assert.equal(planned.title(), "Couldn't check what retiring dev-1 will do"); assert.equal(planned.status(), UNDESCRIBED);
    assert.equal(planned.details().querySelector('summary').textContent, 'Details');
    assertIsolatedDetail(planned.details().querySelector('p'), { before: 'E_LIFECYCLE_FAILED: ', detail: MESSY_LINE });
    assert.deepEqual(planned.footer(), ['Review again', 'Close']);
    assert.equal(planned.doc.body.textContent.includes(NOT_RUN), false);

    const applied = mount(t, { ctx: ctx(), operation: 'stop', answer: answered('E_LIFECYCLE_FAILED', MESSY) });
    await applied.confirm();
    assert.equal(applied.title(), 'Result not confirmed'); assert.equal(applied.status(), UNKNOWN); assert.equal(applied.note(), UNDESCRIBED);
    assertIsolatedDetail(applied.details().querySelector('p'), { before: 'E_LIFECYCLE_FAILED: ', detail: MESSY_LINE });
    assert.equal(applied.doc.body.textContent.split(MESSY_LINE).length, 2, 'the kernel message is in Details only');
    assert.deepEqual(applied.footer(), ['Check again', 'Close']);
    assert.equal(applied.doc.body.textContent.includes(NOT_RUN), false);
  }
});

test('the fallback with no kernel message: Details shows the code alone, since the sentence does not name it', async t => {
  for (const ctx of [context, routedContext]) for (const message of [undefined, '', ' \n ']) {
    const planned = mount(t, { ctx: ctx(), planAnswer: answered('E_NOT_IN_THE_TABLE', message) });
    await planned.open();
    assert.equal(planned.status(), UNDESCRIBED); assert.equal(planned.details().querySelector('p').textContent, 'E_NOT_IN_THE_TABLE');
    assert.equal(planned.details().querySelector('bdi'), null);
    const applied = mount(t, { ctx: ctx(), answer: answered('E_NOT_IN_THE_TABLE', message) });
    await applied.confirm();
    assert.equal(applied.note(), UNDESCRIBED); assert.equal(applied.details().querySelector('p').textContent, 'E_NOT_IN_THE_TABLE');
  }
  // Any other code keeps today's rule: no message, no Details.
  const known = mount(t, { planAnswer: answered('E_INSTANCE_RETIRING', undefined) });
  await known.open(); assert.equal(known.status(), lifecycleReason('E_INSTANCE_RETIRING', DESKTOP_TERMS).message); assert.equal(known.details(), null);
});

test("the dialog decides from the reason it is given: a reply that only claims the kernel answered still reads as today", async t => {
  const target = { ...instance, workspace: 'team', server: null };
  const dom = new JSDOM('<!doctype html>', { pretendToBeVisual: true }), doc = dom.window.document;
  let cause;
  const dialog = createLifecycleDialog({ doc, request: async (_ws, body) => body.action === 'plan'
    ? { lifecycleApi: 1, status: 'plan', target, planRef: 'd'.repeat(64), plan: retirePlan(), options: { discardWorktree: false }, receipt: null, reason: null }
    : { lifecycleApi: 1, status: 'unknown', target, planRef: 'd'.repeat(64), plan: null, receipt: null, reason: lifecycleReason('E_OUTCOME_UNKNOWN', DESKTOP_TERMS), cause, origin: 'kernel' } });
  t.after(() => { dialog.dispose(); dom.window.close(); });
  const shown = async value => { cause = value; dialog.open({ operation: 'retire', instance, workspace: 'team' }); await tick(); doc.querySelector('.lifecycle-confirm').click(); await tick();
    return { note: doc.querySelector('.lifecycle-result .lifecycle-note').textContent, details: doc.querySelector('.lifecycle-details p')?.textContent ?? null }; };
  assert.deepEqual(await shown({ code: 'E_NOT_IN_THE_TABLE', message: UNDESCRIBED, detail: 'one line' }), { note: UNDESCRIBED, details: 'E_NOT_IN_THE_TABLE: one line' });
  for (const value of [{ code: 'E_NOT_IN_THE_TABLE', message: 'A HEADLINE FROM THE REPLY', detail: 'UNSHOWN line', origin: 'kernel' }, { code: 'E_NOT_IN_THE_TABLE', detail: 'UNSHOWN line', origin: 'kernel' },
    { code: 'ENOENT', message: UNDESCRIBED, detail: 'UNSHOWN line' }]) {
    assert.deepEqual(await shown(value), { note: NOT_RUN, details: null }, JSON.stringify(value));
    assert.doesNotMatch(doc.body.textContent, /UNSHOWN|A HEADLINE/);
  }
  // A code with its own sentence keeps it, whatever sentence the reply carries.
  assert.deepEqual(await shown({ code: 'E_WORK_INSPECTION_FAILED', message: UNDESCRIBED, detail: 'one line' }), { note: lifecycleReason('E_WORK_INSPECTION_FAILED', DESKTOP_TERMS).message, details: 'E_WORK_INSPECTION_FAILED: one line' });
});

test("E_UNIDENTIFIED_INSTANCE_HOME at each place the kernel raises it for a Stop or a Retire: a refusal with its own sentence and the kernel's in Details, from the adapter to the dialog, local and routed", async t => {
  // The admission refusals, each message in the form the kernel writes it. Nothing reads its words:
  // the sentence shown is the code's, and the kernel's is one line in Details.
  const home = instance.home, withForce = 'Inspect it, then re-run with `--force` to remove it anyway.';
  const SITES = [
    { what: 'the record is there and cannot be read', operations: ['stop', 'retire'], phases: ['plan', 'apply'],
      said: `${home}/instance.json cannot be read (Unexpected end of JSON input); nothing was done. Restoring the file from a copy makes the home usable again; removing such a home through OATS is not possible yet.` },
    { what: 'a rollback marker that cannot drive a retry', operations: ['retire'], phases: ['apply'],
      said: `${home} carries a rollback marker that cannot drive a retry (unreadable, or missing the cleanup descriptor fields the retry consumes), so OATS cannot tell what external state still depends on this home. ${withForce}` },
    { what: 'no instance.json and no cleanup descriptor', operations: ['retire'], phases: ['apply'],
      said: `${home} has no instance.json and no cleanup descriptor, so OATS cannot tell whether external state (identities, worktrees) still depends on it. Retiring it would delete whatever it holds without running any cleanup. ${withForce}` },
    // K1 PR2's shared retire admission, before effects in a plan and an apply alike.
    ...[
      { what: 'missing capabilityRuntime', ids: [],
        cause: 'does not record capabilityRuntime, or its recorded capability hooks cannot be identified (homes spawned before capabilityRuntime need manual cleanup)' },
      { what: 'malformed capabilityRuntime', ids: ['oats.aweb'],
        cause: 'does not record capabilityRuntime, or its recorded capability hooks cannot be identified (homes spawned before capabilityRuntime need manual cleanup)' },
      { what: 'no repository for recorded retire hooks', ids: ['oats.aweb'],
        cause: 'names no repository in which its recorded retire hooks can run' },
      { what: 'captured home without proof of zero spawn-hook activity', ids: ['oats.aweb', 'oats.core'],
        cause: "is a captured home from before 0.26 whose retire hooks cannot run, and its record does not prove that no capability's spawn hook ran" },
    ].map(({ what, ids, cause }) => ({ what, operations: ['retire'], phases: ['plan', 'apply'],
      said: `${home}/instance.json ${cause}. ${ids.length ? `Capabilities that may have left state: ${ids.join(', ')}. ` : ''}External identities or memberships may still depend on this home. Nothing was stopped, run or removed, including children. Inspect the home and clean up that state with the provider's tooling, then remove it with \`oats retire ${instance.instance} --force\`; --force removes the home without revoking state whose retire hooks cannot run.` })),
  ];
  // The answer's shape: the code, a message, and no `details`; a retire that refused under its claim also
  // carries `details.reached`, and nothing of `details` is read or relayed.
  const reached = { phase: 'before-effects', sessionStopAttempted: false, hooksStarted: false, home: 'kept', recovery: null };
  const printed = (said, details) => JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: said, ...(details ? { details } : {}) } });
  // The real adapter over a CLI that exits 1 with that envelope on stdout; `refuse` says which phase it refuses.
  const kernel = (operation, refuse, said, details) => (bin, args) => cliLifecycle(bin, args, { exec: (_b, argv, _o, done) => argv.includes('--plan') !== (refuse === 'plan')
    ? done(null, JSON.stringify(envelope(planOf(operation))), '') : done(Object.assign(new Error('exit 1'), { code: 1 }), printed(said, details), '') });
  assert.equal(BEFORE_EFFECT_CODES.includes('E_UNIDENTIFIED_INSTANCE_HOME'), true); assert.equal(lifecycleDetailCode('E_UNIDENTIFIED_INSTANCE_HOME'), true);
  assert.deepEqual(lifecycleReason('E_UNIDENTIFIED_INSTANCE_HOME', DESKTOP_TERMS), { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: HOME_CLEANUP });
  assert.equal(undescribedAnswer('E_UNIDENTIFIED_INSTANCE_HOME', DESKTOP_TERMS), null);
  /** The dialog over the real adapter and the boundary. */
  const dialogOver = (ctx, operation, invoke) => {
    const dom = new JSDOM('<!doctype html><button id="opener">Actions</button>', { pretendToBeVisual: true }), doc = dom.window.document;
    const service = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke }), c = ctx();
    const dialog = createLifecycleDialog({ doc, request: (_ws, body) => service(body, () => c) });
    t.after(() => { dialog.dispose(); dom.window.close(); });
    const row = c.workspace.server ? { ...instance, server: c.workspace.server, repoName: c.workspace.name, addressable: true } : instance;
    dialog.open({ operation, instance: row, workspace: 'team' });
    return doc;
  };
  for (const { what, operations, phases, said } of SITES) for (const operation of operations) for (const ctx of [context, routedContext]) {
    const where = `${what}, ${operation}, ${ctx === context ? 'local' : 'routed'}`;
    // The kernel's sentence passes the display filter whole, as one line.
    const reason = { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: HOME_CLEANUP, detail: said, ...(ctx === routedContext ? { remote: true } : {}) };
    const ask = async (refuse, details) => {
      const service = createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: kernel(operation, refuse, said, details) }), c = ctx();
      const planned = await service({ action: 'plan', operation, selector: selectorOf(c), options: optionsOf(operation) }, () => c);
      return { planned, applied: planned.status === 'plan' ? await service({ action: 'apply', planRef: planned.planRef }, () => c) : null };
    };
    if (phases.includes('plan')) {
      const { planned } = await ask('plan');
      assert.equal(planned.status, 'unavailable', where); assert.deepEqual(planned.reason, reason, where);
      const review = dialogOver(ctx, operation, kernel(operation, 'plan', said)); await tick(); await tick();
      assert.equal(review.querySelector('.lifecycle-dialog [role=status]').textContent, HOME_CLEANUP, where);
      assertIsolatedDetail(review.querySelector('.lifecycle-details p'), { before: 'E_UNIDENTIFIED_INSTANCE_HOME: ', detail: said });
      assert.equal(review.querySelector('.lifecycle-confirm').hidden, true, where);
      for (const other of [UNDESCRIBED, NOT_RUN, UNKNOWN]) assert.equal(review.body.textContent.includes(other), false, where);
    }
    // An apply: refused, never unknown. The reason is the answer; there is no cause.
    for (const details of operation === 'retire' ? [undefined, { reached }] : [undefined]) {
      const { applied } = await ask('apply', details);
      assert.equal(applied.status, 'refused', where); assert.deepEqual(applied.reason, reason, where); assert.equal(Object.hasOwn(applied, 'cause'), false, where);
      assert.doesNotMatch(JSON.stringify(applied), /before-effects|sessionStopAttempted/, 'nothing of details is relayed');
    }
    const confirmed = dialogOver(ctx, operation, kernel(operation, 'apply', said, operation === 'retire' ? { reached } : undefined)); await tick(); await tick();
    confirmed.querySelector('.lifecycle-confirm').click(); await tick(); await tick();
    assert.equal(confirmed.querySelector('.lifecycle-dialog h2').textContent, `dev-1 wasn't ${operation === 'retire' ? 'retired' : 'stopped'}`, where);
    assert.equal(confirmed.querySelector('.lifecycle-dialog [role=status]').textContent, HOME_CLEANUP, where);
    assertIsolatedDetail(confirmed.querySelector('.lifecycle-details p'), { before: 'E_UNIDENTIFIED_INSTANCE_HOME: ', detail: said });
    assert.equal(confirmed.body.textContent.split(said).length, 2, 'the kernel message is in Details only');
    for (const other of [UNDESCRIBED, NOT_RUN, UNKNOWN, 'Result not confirmed']) assert.equal(confirmed.body.textContent.includes(other), false, where);
  }
  // A message the display filter withholds, and no message: Details as for any other code with its own sentence.
  const withheld = await createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: kernel('retire', 'plan', `${home}/instance.json cannot be read (token=abc123)`) })({ action: 'plan', operation: 'retire', selector: selectorOf(context()), options: optionsOf('retire') }, context);
  assert.deepEqual(withheld.reason, { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: HOME_CLEANUP, detail: DETAIL_WITHHELD });
  const silent = await createLifecycleBoundary({ terms: DESKTOP_TERMS, invoke: kernel('retire', 'plan', undefined) })({ action: 'plan', operation: 'retire', selector: selectorOf(context()), options: optionsOf('retire') }, context);
  assert.deepEqual(silent.reason, { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: HOME_CLEANUP });
  // An envelope that does not say the kernel answered carries no detail, as for every code: the sentence alone.
  const { planned } = await replies(context(), 'retire', { planAnswer: unmarked('E_UNIDENTIFIED_INSTANCE_HOME') });
  assert.deepEqual(planned.reason, { code: 'E_UNIDENTIFIED_INSTANCE_HOME', message: HOME_CLEANUP });
});
