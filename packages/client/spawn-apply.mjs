/** One client's confirmed-spawn broker across all workspaces: a client makes its own (createSpawnApplyBoundary)
 * and owns it, and two share nothing (references, keys, the active applies, byte reservations).
 * RAM custody only. No kernel imports, placement logic, persistent instructions,
 * implicit retry, name-based recovery, or mutation from result/prepare.
 *
 * Long spawns (#802): an apply runs the CLI for the deadline its confirmed preview implies
 * (spawnApplyDeadlineMs: 60 s, or 60 s + n × 30 min + 60 s for n `worktree` hooks). The apply
 * request answers within ANSWER_WITHIN_MS: with the outcome if the CLI settled, else `pending`;
 * the CLI keeps running here and `result` reads its outcome. Up to MAX_APPLIES applies run at
 * once per boundary, one per workspace and soul. */
import { retainedSpawnDetails, LAUNCH_DIAGNOSTIC_BYTES, FLAG_IGNORED_BYTES } from './launch-prompt-outcome.mjs';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cliSpawnApply } from './spawn-apply-cli.mjs';
import { admitSpawnSelection, PREVIEW_MAX_AGE_S } from './spawn-preview.mjs';
import { record } from './spawn-preview-contract.mjs';
import { spawnApplySupported, spawnApplyChoicesSupported, spawnPrepareInput, spawnRefInput, spawnPreparedData, spawnReference,
  spawnCreationReceipt, spawnApplyFailure, spawnApplyDeadlineMs, ROLLED_BACK_CODES, KERNEL_WORDED_CODES, WAKE_OUTCOME_UNKNOWN } from './spawn-apply-contract.mjs';
/** The apply request answers within this; the proxy's own 65 s timeout then never fires on a healthy spawn. */
export const ANSWER_WITHIN_MS = 50000;
export const MAX_APPLIES = 4;
const clone = v => structuredClone(v);
const byteSize = v => Buffer.byteLength(JSON.stringify(v));
const scopeKey = c => JSON.stringify([c?.workspace?.id, c?.workspace?.scope, c?.workspace?.remote, c?.workspace?.server,
  c?.cli?.bin, c?.cli?.version, c?.cli?.spawnPreviewApi, c?.cli?.spawnApplyApi, c?.cli?.features, c?.cli?.harnesses, c?.cli?.sessionBackends, c?.cli?.launchOptions]);
/** `read` is required: the client's own preview's `prepareRead` (spawn-preview.mjs createSpawnPreview). Prepare
 * reads through the dialog's cache: a fresh held answer for exactly these choices is the decision (no second
 * CLI read); apply's --expect-decision is the drift guard. No held answer: a fresh read.
 *   exec  optional: the client's own execFile, passed to `invoke` as `invoke(cli, options, { exec })` for every
 *         apply (cli-adapter.mjs `runJson` has the rule); without it (and without `applyTimer`) `invoke` is
 *         given no third argument and cliSpawnApply's own default runs. An apply is a change: its options carry `detached: true`
 *         whatever exec is given, which runs it in a session of its own (as execFileInSession does). On a
 *         worktree-event kernel cliSpawnApply ends the child at the deadline through what exec returns
 *         (`child.kill`): a given exec must return the child. One that returns nothing leaves that apply
 *         unended at its deadline; there is no fallback here. On a kernel without worktree-event the options'
 *         `timeout` is the apply's only deadline: exec must honour it as execFileInSession does, killing the
 *         child when it passes and reporting `killed` even if the child then exits cleanly.
 *   applyTimer  optional: the timer the apply's own deadline and its SIGTERM grace are armed on, passed to
 *         `invoke` as `io.timer` beside `exec` (cliSpawnApply's `timer(fn, ms)`, which returns its cancel).
 *         Without it `invoke` is given none, and cliSpawnApply arms them on setTimeout, as before. It is for
 *         a client that lets go of an apply when it ends (the TUI on quit): it gives its own timer and clears
 *         it then, so its process neither signals the apply nor is kept alive by its deadline, and the apply
 *         runs to its own end, unsupervised (the kernel's own limits bound it). `timer` is the boundary's own
 *         wait for an answer (answerWithinMs), which it does not pass on.
 *   maxAge  seconds the kernel may reuse its deployment observations for the apply (#1246 K1: the member heads'
 *         ls-remote wave at the press). Passed to `invoke` only where the apply's CLI lists spawn-apply-max-age;
 *         null never. The fence is unchanged: apply's --expect-decision refuses a drifted decision (E_DECISION_STALE). */
export function createSpawnApplyBoundary({ read, invoke = cliSpawnApply, exec, applyTimer, maxAge = PREVIEW_MAX_AGE_S,
  now = () => performance.now(), mint = () => randomBytes(32).toString('hex'), answerWithinMs = ANSWER_WITHIN_MS,
  timer = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } } = {}) {
  if (typeof read !== 'function') throw new TypeError('createSpawnApplyBoundary: read (the client\'s prepareRead) is required');
  if (applyTimer !== undefined && typeof applyTimer !== 'function') throw new TypeError('createSpawnApplyBoundary: applyTimer, when given, is a timer(fn, ms) that returns its cancel');
  const given = { ...(exec ? { exec } : {}), ...(applyTimer ? { timer: applyTimer } : {}) };
  const prepared = new Map(), submitted = new Map(), active = new Set(), io = Object.keys(given).length ? [given] : [];
  let preparing = 0, reservedBytes = 0;
  const denied = (code, entry = null, status = 'unavailable', message) => spawnApplyFailure(code, { target: entry?.target, spawnRef: entry?.ref, status, message });
  const sweep = () => { for (const map of [prepared, submitted]) for (const [ref, entry] of map) if (!entry.pending && entry.expires <= now()) map.delete(ref); };
  const usedBytes = () => reservedBytes + [...prepared.values(), ...submitted.values()].reduce((sum, e) => sum + e.bytes, 0);
  const freshId = () => {
    const id = mint();
    return spawnReference(id) && !prepared.has(id) && !submitted.has(id) && ![...submitted.values()].some(e => e.key === id) ? id : null;
  };
  function select(input, getContext) {
    const c = getContext();
    if (!spawnApplySupported(c?.cli)) return { error: 'E_APPLY_UNAVAILABLE' };
    if (!spawnApplyChoicesSupported(c.cli, input.choices, !!input.wake)) return { error: 'E_UNSUPPORTED_OPTION' };
    const s = admitSpawnSelection(input.selector, input.choices, c);
    if (s.error) return s;
    const soul = c.agents.find(a => a.name === input.selector.soul && a.agentsRoot === input.selector.agentsRoot);
    const anchor = input.choices.relation.anchor;
    if (soul?.captured || anchor && c.instances?.some(i => i.instance === anchor.instance && i.agentsRoot === anchor.agentsRoot && i.captured)) return { error: 'E_UNSUPPORTED_MODE' };
    return { ...s, scope: scopeKey(c) };
  }
  const same = (a, b) => !b.error && a.identity === b.identity && a.scope === b.scope;
  const ownsScope = (e, getContext) => { try { const c = getContext(); return spawnApplySupported(c?.cli) && !c.workspace?.remote && !c.workspace?.server && scopeKey(c) === e.scope; } catch { return false; } };
  const display = (entry, status, receipt = null, reason = null, extra = {}) => ({ spawnApplyViewApi: 1, status, target: entry.target, spawnRef: entry.ref,
    preview: entry.preview, wakeRequested: !!entry.input.wake, receipt, reason, applyWithinMs: entry.deadlineMs, ...extra });
  async function prepare(input, getContext) {
    const selection = select(input, getContext);
    if (selection.error) return denied(selection.error);
    const reservation = byteSize(input);
    if (prepared.size + preparing >= 32 || usedBytes() + reservation > 8 * 1024 * 1024) return denied('E_BUSY');
    preparing++; reservedBytes += reservation;
    let observed;
    try { observed = await read({ action: 'preview', selector: clone(input.selector), choices: clone(input.choices) }, getContext); }
    catch { observed = { status: 'unavailable', reason: { code: 'E_CLI_FAILED' } }; }
    finally { preparing--; reservedBytes -= reservation; }
    const current = select(input, getContext);
    if (!same(selection, current)) return denied('E_PLAN_CHANGED', { target: selection.target });
    if (observed?.status !== 'available') return denied(observed?.reason?.code, { target: selection.target });
    if (observed.data?.preflight?.status !== 'complete') return denied('E_PREFLIGHT_INCOMPLETE', { target: selection.target });
    const preview = spawnPreparedData(observed.data, selection.target);
    if (!preview) return denied('E_CLI_PROTOCOL', { target: selection.target });
    if (!preview.backendStatus.installed) return denied('E_BACKEND_UNAVAILABLE', { target: selection.target });
    const entry = { ...selection, input: clone(input), preview, ref: freshId(), key: null, expires: now() + 300000,
      pending: false, reply: null, final: false, seenHome: false, seenBirth: null, bytes: 0, deadlineMs: spawnApplyDeadlineMs(selection.cli, preview) };
    if (!entry.ref) return denied('E_BUSY', entry);
    // Reserve bounded outcome storage before dispatch. A settled reply shares
    // this immutable preview internally; public responses are always cloned.
    // A reply keeps one of two bounded texts, never both: a retained launch's diagnostics, or the
    // fact a receipt carries when Claude Code ignored the channel option. The larger bound covers either.
    entry.bytes = byteSize(entry) + 3 * byteSize(preview.decision) + 2 * byteSize(entry.target) + 4096 + Math.max(LAUNCH_DIAGNOSTIC_BYTES, FLAG_IGNORED_BYTES);
    if (usedBytes() + entry.bytes > 8 * 1024 * 1024) return denied('E_BUSY', entry);
    prepared.set(entry.ref, entry);
    return display(entry, 'prepared');
  }
  function observedGone(entry, getContext) {
    // A prior positive observation can block retry after disappearance/replacement.
    // Absence alone is NOT success/retirement proof and does not close a concurrent
    // retire race. The kernel key's documented lifetime is only its surviving home.
    const rows = getContext().instances || [];
    const matches = rows.filter(i => i.instance === entry.preview.decision.instance && i.home === entry.preview.decision.home
      && i.agent === entry.input.selector.soul && i.agentsRoot === entry.input.selector.agentsRoot && !i.server && !i.remote);
    const own = matches.length === 1 && matches[0].spawnIdempotencyKey === entry.key ? matches[0] : null;
    if (own) {
      const birth = typeof own.createdAt === 'string' && own.createdAt.length <= 128 ? own.createdAt : null;
      if (entry.seenBirth !== null && entry.seenBirth !== birth) return true;
      entry.seenHome = true; entry.seenBirth = birth; return false;
    }
    return entry.seenHome || matches.some(i => typeof i.spawnIdempotencyKey === 'string' && i.spawnIdempotencyKey !== entry.key);
  }
  function interpret(result, entry, cli) {
    const envelope = result?.envelope;
    if (typeof result?.started !== 'boolean' || envelope?.schemaVersion !== 1 || typeof envelope.ok !== 'boolean') return denied('E_OUTCOME_UNKNOWN', entry, 'unknown');
    if (envelope.ok) {
      if (!result.started) return denied('E_OUTCOME_UNKNOWN', entry, 'unknown');
      const receipt = spawnCreationReceipt(envelope.result, { target: entry.target, preview: entry.preview, wakeRequested: !!entry.input.wake });
      if (!receipt) return denied('E_OUTCOME_UNKNOWN', entry, 'unknown');
      const partial = !!entry.input.wake && receipt.wake.saved !== true;
      const reason = !partial ? null : receipt.wake.error ?? { code: 'E_WAKE_OUTCOME_UNKNOWN', message: WAKE_OUTCOME_UNKNOWN };
      return display(entry, partial ? 'partial' : 'complete', receipt, reason);
    }
    const code = envelope.error?.code;
    if (!result.started) return denied(code, entry, 'refused');
    if (code === 'E_SPAWN_INCOMPLETE') {
      const d = retainedSpawnDetails(envelope.error.details);
      if (!d || d.instance !== entry.preview.decision.instance || d.home !== entry.preview.decision.home) return denied('E_OUTCOME_UNKNOWN', entry, 'unknown');
      return { ...denied(code, entry, 'incomplete'), incomplete: d };
    }
    // worktree-event: the kernel rolled these back. Without the unconfirmed marker its compensation
    // was confirmed: refused, nothing created. With it, cleanup is owed: unknown, and final (a
    // re-apply of the same key would not finish it; retiring the quarantined home does).
    if (ROLLED_BACK_CODES.includes(code) && cli?.features?.includes('worktree-event')) {
      const message = envelope.error.message;
      if (envelope.error.details?.unconfirmed === true) { entry.final = true; return denied(code, entry, 'unknown', message); }
      return denied(code, entry, 'refused', message);
    }
    // Feature sandboxes (D-S1-4): a spawn into a sandbox is refused before anything is minted, kept or
    // created (docs/desktop-cli-api.md, Sandbox refusals): refused, in the kernel's words, which end with
    // what a person does next.
    if (KERNEL_WORDED_CODES.includes(code)) return denied(code, entry, 'refused', envelope.error.message);
    // A taken explicit name (spawn-name) refuses before any home is kept: the
    // confirmation is consumed and a fresh preview reports the taken name.
    if (['E_DECISION_STALE', 'E_IDEMPOTENCY_CONFLICT', 'E_PLACEMENT_TAKEN', 'E_INSTANCE_NAME_TAKEN'].includes(code)) return denied(code, entry, 'stale');
    // Do not infer rollback from arbitrary kernel/hook failures. Only the
    // explicit binding/reservation/incomplete contracts above establish scope.
    return denied('E_OUTCOME_UNKNOWN', entry, 'unknown');
  }
  function get(ref, getContext) {
    const e = submitted.get(ref) || prepared.get(ref);
    if (!e) return { failure: denied('E_INTENT_EXPIRED') };
    if (!ownsScope(e, getContext)) return { failure: denied('E_PLAN_CHANGED', e) };
    return { entry: e };
  }
  const sameSoul = (a, b) => a.target.workspace === b.target.workspace && a.input.selector.soul === b.input.selector.soul
    && a.input.selector.agentsRoot === b.input.selector.agentsRoot;
  async function apply(entry, getContext, settled) {
    if (entry.pending) return display(entry, 'pending');
    if (entry.reply && (entry.reply.status !== 'unknown' || entry.final)) return { ...entry.reply, repeated: true };
    if (active.size >= MAX_APPLIES || [...active].some(e => sameSoul(e, entry)) || !submitted.has(entry.ref) && submitted.size >= 32) return denied('E_BUSY', entry);
    const current = select(entry.input, getContext);
    if (!same(entry, current)) return denied('E_PLAN_CHANGED', entry);
    if (entry.key && observedGone(entry, getContext)) {
      entry.reply = denied('E_INSTANCE_GONE', entry, 'refused'); return entry.reply;
    }
    const key = entry.key || freshId();
    if (!key) return denied('E_BUSY', entry);
    // Reserve key, slot and submitted record BEFORE any await. Key persists on
    // this intent through unknown results; neither result nor retry can mint one.
    entry.key = key; entry.pending = true; entry.expires = Infinity; active.add(entry);
    prepared.delete(entry.ref); submitted.set(entry.ref, entry);
    const run = (async () => {
      let reply;
      try {
        const latest = select(entry.input, getContext);
        if (!same(entry, latest)) reply = denied('E_PLAN_CHANGED', entry, 'refused');
        else {
          const result = await invoke(latest.cli, { target: clone(entry.target), choices: clone(entry.input.choices), task: entry.input.task,
            ...(entry.input.wake ? { wake: clone(entry.input.wake) } : {}), decision: clone(entry.preview.decision), key: entry.key, deadlineMs: entry.deadlineMs,
            ...(maxAge !== null && latest.cli?.features?.includes('spawn-apply-max-age') ? { maxAge } : {}) }, ...io);
          reply = interpret(result, entry, latest.cli);
        }
      } catch { reply = denied('E_OUTCOME_UNKNOWN', entry, 'unknown'); }
      // This result belongs to its original entry even if a view/workspace changed.
      // The caller's current context is checked separately on both settlement paths.
      entry.reply = reply; // internal preview sharing; every outward response is cloned
      entry.pending = false; entry.expires = now() + 30 * 60000; active.delete(entry);
      return reply;
    })();
    // Answer within answerWithinMs: the outcome, or `pending` while the CLI keeps running here.
    let cancel = () => {};
    const late = new Promise(resolve => { cancel = timer(() => resolve(null), answerWithinMs); });
    const reply = await Promise.race([run, late]);
    cancel();
    if (!reply) {
      void run.then(() => { try { settled?.(); } catch { /* a refresh must not lose an outcome */ } });
      return display(entry, 'pending');
    }
    return ownsScope(entry, getContext) ? reply : denied('E_OUTCOME_UNKNOWN', entry, 'unknown');
  }
  /** `settled()` is called when an apply answered `pending` settles later (the route refreshes then). */
  return async function spawnApplyRequest(request, getContext, { settled } = {}) {
    try {
      sweep();
      if (!record(request)) return denied('E_BAD_ARGS');
      if (request.action === 'prepare') {
        const input = spawnPrepareInput(request);
        return clone(input ? await prepare(input, getContext) : denied('E_BAD_ARGS'));
      }
      const r = spawnRefInput(request);
      if (!r) return denied('E_BAD_ARGS');
      const found = get(r.spawnRef, getContext);
      if (found.failure) return clone(found.failure);
      const e = found.entry;
      if (r.action === 'result') return clone(e.pending ? display(e, 'pending') : e.reply || display(e, 'prepared'));
      return clone(await apply(e, getContext, settled));
    } catch { return denied('E_CLI_FAILED'); }
  };
}
