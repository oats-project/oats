/** What a Stop or Retire plan and its answer say, and the client's half of the transaction: decide, then build.
 * No DOM and no IO: a client draws `planView`'s and `outcomeView`'s data its own way, and reaches its lifecycle
 * boundary (instance-lifecycle.mjs) through the `request` it gives `createLifecycleConfirmation`.
 *
 * What happened is shared; what to do next is each client's. Every sentence here is a fact about the plan or
 * its answer, or a next step that names an act every confirmation has (review again: `refresh`; check again:
 * `check-again`; update OATS). A next step that names a client's own furniture (a window, a roster, a command
 * line) is not here: a view names it by a code (`next`), and the client words it. Labels of controls are the
 * client's too; which controls exist is `state().offers`, and which choices, `planView(…).choices`.
 *
 * A client switches on codes and kinds, never on the words. Every wording function takes the client's terms
 * (client-terms.mjs) and refuses a call without them.
 *
 *   planView(plan, { operation, choices, leftover }, terms)
 *     -> { question, happening, state, warning, choices, applicable, notice, targets, own, at }
 *        happening: [{ text, path?, tone?, title? }]      tone: 'note' | 'attention'
 *        state:     { rows: [{ label, value, title }], notes: [{ text, tone, title? }] }
 *        choices:   [{ id, sentence, value, applies, offered }]   one per option the plan can carry
 *        notice:    null | { code: 'E_OPTION_UNAVAILABLE', sentence }   when the choices do not apply
 *   outcomeView(result, { target, operation, choices, plan, leftover }, terms)
 *     -> { kind, title, status, blocks, uncertain, plan?, planRef?, running? }
 *        kind:   'stale' | 'pending' | 'complete' | 'partial' | 'refused' | 'unknown' | 'invalid'
 *        status: { headline, more: [{ text } | { quote }], next: null | 'retire-with-force' | 'check-roster', code? }
 *        blocks: what is shown under the status, in order:
 *          { type: 'details', reason, bare }   a code and the kernel's line behind a disclosure
 *          { type: 'quote', text }             the kernel's own line, quoted
 *          { type: 'note', text }
 *          { type: 'rows', rows: [{ text, quote? }] }   a stop's results or a retire's children
 *          { type: 'lines', lines: [{ text, path? }] }  what a retire did
 *   applyRunningSentence(running, terms) -> the sentence for an apply of this client that is still running
 *   createLifecycleConfirmation({ request, target, operation, terms, onSettled, onChange, label, leftover, retires })
 *     -> { state(), view(), setChoice(id, value), refresh(), apply(), checkAgain(), close() }
 */
import { lifecyclePlan, lifecycleOptions, planReference, lifecycleReason, lifecycleDetailCode, publicLifecycleReceipt, decodedStoppedTargets,
  stoppedRowKind, stoppedRowText, stopResultWords, childrenRefusedMessage, busyRefusal, undescribedRefusal, lifecycleChoicesApplicable,
  ownWorktreeOf } from './lifecycle-contract.mjs';
import { gitTargetKey } from './instance-git-contract.mjs';
import { remoteReason, readingFrom } from './remote-address.mjs';
import { cleanLine, displayLine } from './display-text.mjs';
import { requireTerms } from './client-terms.mjs';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = values => values.map(v => v.instance).join(', ');
/** What a person reads for a session: whether it runs, never the backend's raw state word. */
const sessionText = s => !s.established ? "Unknown (couldn't be checked)" : s.present ? 'Running' : 'Not running';
/** The kernel's reason for unobserved work is a code or a sentence for operators (E_NO_WORKTREE, a path):
 * never inline, only in the row's title. */
const workText = w => !w.observed ? "Unknown (couldn't be checked)" : !w.changed && !w.untracked ? 'None'
  : [w.changed && `${w.changed} changed`, w.untracked && `${w.untracked} untracked`].filter(Boolean).join(', ');
/** The worktree's branch as observed, else the one recorded at spawn; null when detached or unknown. Not asked
 * for a tree the kernel's fact answers and that was not observed (treeOf `unchecked`): no branch is named there. */
const branchOf = f => f.work.observed ? f.work.branch : f.recordedBranch;
/** A retire the kernel refuses as busy for a home a spawn left (`rollbackIncomplete`): the spawn may still run.
 * For a kernel that does not say who holds the claim. One that does (feature lifecycle-claim-stop) has its
 * answer read by `details.holder`, and its own sentence names the check and the command: never this one.
 * What to do next (`next: 'retire-with-force'`) is the client's to word. */
const LEFTOVER_HELD = "OATS can't confirm that the spawn which left this home has stopped, so it won't retire it yet.";
/** How a retire plan's tree reads, for the words about it. `own`: the tree at `work/` is the instance's
 * (ownWorktreeOf), by the kernel's fact or, for a plan without one, by the record. The other two are for a
 * plan with the fact alone; a plan without one is `own` or neither, by the record.
 *   unchecked  the kernel says the tree is the instance's and `work/` was not observed. The fact is the
 *              reading's answer by the record where nothing, or a file, is at `work/`, so the words promise
 *              no tree and name no branch: the only branch known there is the record's. One wording for
 *              every reason of unobserved work; no code of `facts.work.reason` is read.
 *   notOwn     the kernel says the tree is not the instance's: no worktree is kept or deleted, and
 *              `facts.work`, an observation through any link, is another's tree. */
const treeOf = value => { const whose = ownWorktreeOf(value), fact = whose.from === 'fact';
  return { own: whose.own, unchecked: fact && whose.own && !value.facts.work.observed, notOwn: fact && !whose.own }; };
/** The worktree line of "What will happen" and the warning under the checked choice, for an own tree that
 * could not be checked. They follow the line for a session that could not be checked. */
const KEEPS_UNCHECKED = "Keeps its worktree, moved aside, if there is one. It couldn't be checked.";
const DELETES_UNCHECKED = "Deletes its worktree, if there is one. It couldn't be checked.";
const WARNS_UNCHECKED = "Deletes the worktree folder, if there is one, with any uncommitted changes (a recovery copy is saved first). It couldn't be checked.";
/** In the place of the worktree line when the kernel says the tree is not the instance's. True of every such
 * home: it names no owner and does not claim there is a link. What happens to what is at `work/` is the
 * line above it (the recovery copy and the home). */
const NOT_ITS_OWN = 'It has no worktree of its own, so no worktree is kept or deleted. A tree it links to is not touched.';
const ambiguousText = v => `Not included: ${v.instance} (another instance has the same parent name, so OATS can't tell whose child it is).`;
/** The sentence of each choice a plan can carry, by the id lifecycleOptions reads. */
const CHOICES = Object.freeze({ stop: [['recursive', 'Include child instances']], retire: [['discardWorktree', 'Also delete the worktree']] });
const REPLAYED = 'This is the result already recorded for this confirmation; nothing ran again.';
const UNCONFIRMED = 'Result not confirmed';

/** Deleting the worktree keeps its branch, except on a leftover row: there the kernel deletes the branch the
 * interrupted spawn created when it holds no work, so the plan's next line is the only word on branches. */
const stays = (b, leftover) => b && !leftover ? ` Branch ${b} stays in the repository.` : '';
const line = (text, path, tone) => ({ text, ...(path ? { path } : {}), ...(tone ? { tone } : {}) });
/** What will happen, in plain words, built from the plan; each line only when it applies. */
function happening(value, requested, leftover) {
  const lines = [];
  if (value.action === 'stop') {
    const t = value.targets;
    lines.push(line(value.recursive && t.length > 1 ? `Stops ${t.length} sessions, children first: ${names(t)}.` : `Stops the session of ${value.instance}.`));
    lines.push(line('Nothing is deleted. Its home, worktree, transcript and launch settings are kept; you can start it again.'));
    lines.push(line('A session that refuses to stop is left running; nothing is forced.', undefined, 'note'));
    for (const x of t.filter(x => x.midTask === true)) lines.push(line(`${x.instance} reports it is in the middle of a task.`, undefined, 'attention'));
    if (value.skipped.length) lines.push(line(`Not stopped: ${names(value.skipped)} (children not included).`, undefined, 'note'));
    return lines;
  }
  const f = value.facts, tree = treeOf(value);
  if (f.session.established && f.session.present) lines.push(line('Stops its session.'));
  else if (!f.session.established) lines.push(line("Stops its session, if one is running (its state couldn't be checked)."));
  if (f.children.length) lines.push({ ...line(`Stops its ${plural(f.children.length, 'child instance')} first: ${names(f.children)}. They are kept, with their homes.`),
    title: f.children.map(c => c.home).join('\n') });
  lines.push(line('Saves a recovery copy of any uncommitted work, then deletes its home folder.', value.home));
  if (tree.notOwn) lines.push(line(NOT_ITS_OWN));
  else if (tree.unchecked) lines.push(line(requested.discardWorktree ? DELETES_UNCHECKED : KEEPS_UNCHECKED));
  else if (tree.own) { const b = branchOf(f); lines.push(line(requested.discardWorktree ? `Deletes its worktree.${stays(b, leftover)}`
    : `Keeps its worktree, moved aside${b ? `, on branch ${b}` : ''}.`)); }
  // A home a spawn left (rollbackIncomplete): retire finishes its compensation, which deletes the branch
  // the spawn created when it holds no work (the result's spawnCompensation says which).
  lines.push(line(leftover ? 'Branches and pull requests are not changed, except a branch an interrupted spawn left with no work, which is deleted.'
    : 'Branches and pull requests are not changed.'));
  if (f.children.length) lines.push(line("If a child won't stop, nothing is retired.", undefined, 'note'));
  return lines;
}
/** Current state: plain values by label, then what is not included and why. */
function current(value) {
  const rows = [], notes = [];
  const row = (label, value, title = '') => rows.push({ label, value, title });
  if (value.action === 'stop') {
    for (const t of value.targets) row(t.instance, sessionText(t.session));
    for (const v of value.ambiguous) notes.push({ text: ambiguousText(v), tone: 'note' });
  } else {
    const f = value.facts, tree = treeOf(value);
    row('Session', sessionText(f.session));
    // Without a worktree of its own there is no Git work to report: the recovery line under What will happen covers it.
    // When the kernel says the tree is not the instance's, nothing of `facts.work` is shown: it is an observation
    // through any link, so for an attached instance it is its owner's tree, which this retire does not touch.
    // A plan with no fact keeps the rows it had: what was observed, whoever's it is.
    if (!tree.notOwn) {
      if (f.work.observed || tree.own) row('Uncommitted work', workText(f.work), f.work.observed ? '' : f.work.reason);
      if (f.work.observed) row('Branch', f.work.detached ? 'Detached' : f.work.branch);
      if (f.work.observed && f.work.drift) notes.push({ text: `The worktree is on ${f.work.detached ? 'a detached commit' : f.work.branch}, not the branch it was spawned on${f.recordedBranch ? ` (${f.recordedBranch})` : ''}.`, tone: 'attention' });
    }
    for (const v of f.ambiguous) notes.push({ text: ambiguousText(v), tone: 'note', title: v.home });
  }
  return { rows, notes };
}
/** The warning under a checked "Also delete the worktree": in words, not colour alone. None when the kernel
 * says the tree is not the instance's: the choice then stays on screen only to be undone, the notice says
 * that it cannot be confirmed, and a warning would count another tree's changes and promise their deletion. */
function discardWarning(value, leftover) {
  const f = value.facts, tree = treeOf(value);
  if (tree.notOwn) return '';
  if (tree.unchecked) return WARNS_UNCHECKED;
  const n = f.work.observed ? f.work.changed + f.work.untracked : null;
  const including = n === null ? ', including uncommitted changes, if any (a recovery copy is saved first)'
    : n ? `, including ${plural(n, 'uncommitted change')} (a recovery copy is saved first)` : '';
  return `Deletes the worktree folder${including}.${stays(branchOf(f), leftover)}`;
}
const question = (operation, target) => `${operation === 'retire' ? 'Retire' : 'Stop'} ${target.instance}?`;

/** What a plan says, for review. `choices`: the ones this plan was read for. `leftover`: the row is a home a
 * failed spawn left (`rollbackIncomplete`). A choice is `offered` when the plan offers it (deleting the
 * worktree: only an instance's own tree); a client keeps a choice that is set on screen, so it can be undone. */
export function planView(plan, { operation = plan.action, choices, leftover = false } = {}, terms) {
  requireTerms(terms, 'planView');
  const own = plan.action === 'retire' ? treeOf(plan).own : true, applicable = lifecycleChoicesApplicable(plan, choices);
  return { question: question(operation, plan), happening: happening(plan, choices, leftover), state: current(plan),
    warning: plan.action === 'retire' && choices.discardWorktree ? discardWarning(plan, leftover) : '',
    choices: CHOICES[plan.action].map(([id, sentence]) => ({ id, sentence, value: choices[id], applies: lifecycleChoicesApplicable(plan, { [id]: choices[id] }),
      offered: plan.action === 'retire' ? own : true })),
    applicable, notice: applicable ? null : { code: 'E_OPTION_UNAVAILABLE', sentence: lifecycleReason('E_OPTION_UNAVAILABLE', terms).message },
    targets: plan.action === 'stop' ? plan.targets.length : 1, own, at: plan.at };
}

/** One line per row of a stop's results or of a retire's child list; what a row is, and its words, are the contract's.
 * The kernel's own sentence for a child whose home it could not lock is its quote. */
const rowsOf = values => values.map(v => ({ text: `${v.instance}: ${stoppedRowText(v)}`,
  ...(stoppedRowKind(v) === 'locked' && cleanLine(v.detail) ? { quote: v.detail } : {}) }));
/** The branch an interrupted spawn left, which this retire deleted or kept (spawnCompensation); else nothing. */
function compensated(c) {
  const branch = displayLine(c?.branch);
  if (!branch) return null;
  return line(c.branchDeleted ? `Branch ${branch} deleted: an interrupted spawn left it, and it held no work.`
    : `Branch ${branch} kept: ${displayLine(c.reason) ?? 'no reason given'}`);
}
/** What a retire receipt says happened, each fact on its own line; paths beside them. */
function retired(receipt, snapshot, complete) {
  const r = receipt.retention, children = receipt.childrenStopped;
  return [complete && snapshot.facts.session.present === true && line('Session stopped.'),
    children.length && line(`${plural(children.length, 'child instance')} stopped and kept.`),
    line(receipt.removedDir ? 'Home folder deleted.' : 'Home folder kept.', receipt.removedDir ? undefined : receipt.retainedHome ?? undefined),
    r?.worktree === 'retained' && line('Worktree kept at', r.movedTo), r?.worktree === 'removed' && line('Worktree deleted.'),
    receipt.recoveryPath && line('Recovery copy saved at', receipt.recoveryPath),
    compensated(receipt.spawnCompensation),
    receipt.incomplete && line("Cleanup didn't finish.")].filter(Boolean);
}
/** A local reason's code and the CLI's own message, re-validated here (a reply is relayed as it is), or null: a
 * code that may show one (lifecycleDetailCode) and a detail that is already a display line. The headline stays
 * the fixed sentence for the code; the detail is only ever shown behind a disclosure. */
const localDetail = reason => reason && typeof reason === 'object' && !Object.hasOwn(reason, 'remote')
  && lifecycleDetailCode(reason.code) && cleanLine(reason.detail) ? { code: reason.code, detail: reason.detail } : null;
/** A refusal: a remote host's headline, else the fixed sentence for the code (the shared table's); the code and
 * the kernel's message behind a disclosure when there is one to show. `plan`: the snapshot the refusal is about,
 * when there is one. Every status it answers carries the reason's `code` (and the kernel's busy `holder` when it
 * is read by it): a client switches on the code, never on the words, and words a code only it raises itself. */
function refusal(reason, plan, { target, operation, leftover }, terms) {
  // The kernel's busy answer, read by who holds the claim: the headline, the target it is about when that
  // is another one of this plan, and the kernel's own sentence as the main text when it names what ends it.
  const busy = busyRefusal(reason, plan);
  if (busy) {
    const more = [busy.about, busy.lead].filter(Boolean).map(text => ({ text }));
    if (busy.sentence) more.push({ quote: busy.sentence });
    return { status: { headline: busy.headline, more, next: null, code: reason.code, holder: reason.holder }, blocks: busy.details ? [{ type: 'details', reason: busy.details, bare: false }] : [] };
  }
  // An error the kernel answered that has no sentence here: the fallback sentence, and its code behind the disclosure.
  const remote = remoteReason(reason), undescribed = undescribedRefusal(remote || reason, terms), shown = remote || undescribed || localDetail(reason);
  // The kernel's own busy refusal (it carries the kernel's message; a client's own busy does not) for a home
  // a spawn left: its sentence, and the kernel's message, which names the process, quoted under it.
  if (!remote && shown && reason.code === 'E_LIFECYCLE_BUSY' && operation === 'retire' && leftover)
    return { status: { headline: LEFTOVER_HELD, more: [], next: 'retire-with-force', code: reason.code }, blocks: [{ type: 'quote', text: shown.detail }] };
  // A reason with no code reads as the table's fallback, and says that fallback's code; a code only the client
  // raises (one the table does not know) keeps its own, so the client can word it.
  const table = lifecycleReason(reason?.code, terms, { operation, instance: target.instance, routed: !!remote || target.server != null, server: target.server });
  const own = typeof reason?.code === 'string' && reason.code ? reason.code : table.code;
  // Rebuild this command from the view's route, including the missing-server fallback, never a relayed sentence.
  const status = remote ? { headline: remote.code === 'E_UNIDENTIFIED_INSTANCE_HOME' ? table.message : remote.message, code: remote.code } : undescribed ? { headline: undescribed.message, code: reason.code }
    : { headline: table.message, code: own };
  return { status: { more: [], next: null, ...status }, blocks: shown ? [{ type: 'details', reason: shown, bare: !!undescribed }] : [] };
}
/** A reply's `running` (this client's own apply that is still running), re-validated, or null: a target that names
 * an instance, the act, and when it started (ms since the epoch). Read only beside this client's own busy refusal
 * or an unknown outcome; the kernel's busy answer never carries it, and one that names a holder is never read so. */
function runningOf(result) {
  const r = result?.running;
  return r && typeof r === 'object' && typeof r.target?.instance === 'string' && ['stop', 'retire'].includes(r.operation) && Number.isFinite(r.since)
    ? { target: { ...r.target }, operation: r.operation, since: r.since } : null;
}
const validTarget = (result, target) => result?.lifecycleApi === 1 && !!result.target && gitTargetKey(result.target) === gitTargetKey(target);

/** What a plan read that did not give a plan says: `reason` is the reply's (`null`: no reply that names this
 * target, read as a protocol failure). */
export function unavailableView(reason, { target, operation }, terms) {
  requireTerms(terms, 'unavailableView');
  const { status, blocks } = refusal(reason ?? { code: 'E_CLI_PROTOCOL' }, null, { target, operation, leftover: false }, terms);
  return { kind: 'unavailable', title: `Couldn't check what ${operation === 'retire' ? 'retiring' : 'stopping'} ${target.instance} will do`,
    status, blocks, uncertain: false };
}

/** What an apply's answer says. `plan`: the snapshot that was confirmed; `choices`: the client's current ones (a
 * stale answer's fresh plan is read for them). Any answer that does not read whole (another target, a receipt
 * whose status its fields do not imply, child rows that are not the plan's) is `invalid`, shown as "Result not
 * confirmed": never a second apply. */
export function outcomeView(result, { target, operation, choices, plan, leftover = false }, terms) {
  requireTerms(terms, 'outcomeView');
  const invalid = { kind: 'invalid', title: UNCONFIRMED, status: { headline: lifecycleReason('E_OUTCOME_UNKNOWN', terms).message, more: [], next: null, code: 'E_OUTCOME_UNKNOWN' },
    blocks: [], uncertain: true };
  try { return read(); } catch { return invalid; }
  function read() {
    if (!validTarget(result, target)) return invalid;
    const name = target.instance, retire = operation === 'retire', uncertain = ['unknown', 'pending'].includes(result.status);
    if (result.status === 'stale') {
      const fresh = lifecyclePlan(result.plan, target, operation, choices);
      if (!fresh) return invalid;
      return { kind: 'stale', plan: fresh, planRef: planReference(result.planRef) ? result.planRef : null,
        notice: { code: 'E_PLAN_STALE', sentence: lifecycleReason('E_PLAN_STALE', terms).message }, uncertain: false };
    }
    if (result.receipt) {
      const receipt = publicLifecycleReceipt(result.receipt, plan); if (!receipt) return invalid;
      const expected = receipt.deferred ? 'pending' : (receipt.action === 'stop' ? receipt.ok : receipt.removedDir && !receipt.incomplete) ? 'complete' : 'partial';
      if (result.status !== expected) return invalid;
      const replay = receipt.replayed || result.repeated ? [{ type: 'note', text: REPLAYED }] : [];
      if (receipt.deferred) return { kind: 'pending', title: 'Retirement accepted', uncertain,
        status: { headline: 'Retirement was accepted and will finish in the background.', more: [], next: 'check-roster' }, blocks: replay };
      const done = receipt.action === 'stop' ? { type: 'rows', rows: rowsOf(receipt.results) } : { type: 'lines', lines: retired(receipt, plan, expected === 'complete') };
      if (expected === 'complete') {
        const title = receipt.action === 'stop' && receipt.results.length > 1 ? `${receipt.results.length} sessions stopped` : `${name} ${retire ? 'retired' : 'stopped'}`;
        return { kind: 'complete', title, status: { headline: `${title}.`, more: [], next: null }, blocks: [done, ...replay], uncertain };
      }
      // A stop that is not ok: the sentence above the rows is chosen from the rows, so it agrees with them.
      const words = receipt.action === 'stop' ? stopResultWords(receipt.results) : { status: "Retirement didn't finish. Some steps ran:", title: "Retirement didn't finish" };
      const code = result.reason?.code ?? (receipt.action === 'stop' ? 'E_SESSION_STOP_FAILED' : 'E_RETIRE_INCOMPLETE');
      return { kind: 'partial', title: words.title, status: { headline: words.status, more: [], next: null, code }, blocks: [done, ...replay], uncertain };
    }
    // The rows are the server's, already decoded: validated here, never decoded again.
    const children = result.childrenStopped ? decodedStoppedTargets(result.childrenStopped, plan.facts?.children || []) : null;
    if (result.childrenStopped && !children) return invalid;
    let { status, blocks } = refusal(result.reason?.code ? result.reason : { code: 'E_OUTCOME_UNKNOWN' }, plan, { target, operation, leftover }, terms);
    // This client's own apply is running (its busy refusal, or the answer of an apply whose wait ended): which one
    // is said, in place of the general sentence of the busy refusal. Never for the kernel's busy answer.
    const running = runningOf(result), own = running && !Object.hasOwn(result.reason ?? {}, 'holder');
    if (own && result.reason?.code === 'E_LIFECYCLE_BUSY') status = { headline: applyRunningSentence(running, terms), more: [], next: null, code: 'E_LIFECYCLE_BUSY' };
    if (children && result.reason?.code === 'E_CHILDREN_RUNNING') status = { headline: childrenRefusedMessage(children), more: [], next: null, code: 'E_CHILDREN_RUNNING' };
    // Why the outcome is unknown: a remote transport or host cause keeps its headline and its line; a
    // local one says its fixed sentence, with the CLI's own message behind the disclosure when it carries one.
    // An apply whose wait ended is still running: that is said in place of the timeout, which ended only the wait.
    if (own && uncertain) return { kind: 'unknown', title: UNCONFIRMED, status, uncertain, running,
      blocks: [...blocks, { type: 'note', text: `The ${running.operation === 'retire' ? 'removal' : 'stop'} of ${displayLine(running.target.instance) ?? 'this instance'} is still running. Check again to read its result.` }] };
    const cause = result.cause && remoteReason(result.cause);
    const undescribed = result.cause && undescribedRefusal(cause || result.cause, terms);
    blocks = [...blocks];
    if (cause) blocks.push({ type: 'note', text: cause.message }, { type: 'details', reason: cause, bare: !!undescribed });
    else if (result.cause) {
      blocks.push({ type: 'note', text: undescribed ? undescribed.message : lifecycleReason(result.cause.code, terms).message });
      const local = undescribed || localDetail(result.cause); if (local) blocks.push({ type: 'details', reason: local, bare: !!undescribed });
    }
    if (children) blocks.push({ type: 'note', text: 'Child instances:' }, { type: 'rows', rows: rowsOf(children) });
    return { kind: uncertain ? 'unknown' : 'refused', title: uncertain ? UNCONFIRMED : `${name} wasn't ${retire ? 'retired' : 'stopped'}`, status, blocks, uncertain,
      ...(own ? { running } : {}) };
  }
}

/** The sentence for this client's own apply that is still running (`running`: { target, operation, since }, on
 * the client's own busy refusal and on the unknown answer of an apply whose wait ended). The name is shown
 * through the display filter. When it started is `running.since`, a field: each client words a time its own way. */
export function applyRunningSentence(running, terms) {
  requireTerms(terms, 'applyRunningSentence');
  const name = displayLine(running?.target?.instance) ?? 'this instance';
  return `The ${running?.operation === 'retire' ? 'removal' : 'stop'} of ${name} is still running. Wait for it to finish, then review again.`;
}

/** What each settled outcome offers, and no other (the table of #855's 5a): a key is one intent. "Check again"
 * asks for the answer to the confirmation already sent, by the same reference; trying again is a new plan. */
const SETTLED_OFFERS = Object.freeze({ complete: ['close'], partial: ['refresh', 'close'], refused: ['refresh', 'close'],
  unknown: ['check-again', 'close'], pending: ['check-again', 'close'], invalid: ['check-again', 'close'], unavailable: ['refresh', 'close'] });

/** One confirmation of one act on one row: the client's half of the transaction. `request(body)` is the client's
 * way to its boundary. `onChange(event, detail)` is told every step, synchronously, so the client can draw it:
 *   'reading'      a plan is being read: { cause, kept, view }   kept: the plan on screen stays until the new one
 *   'plan'         a plan to review: { plan, planRef, view }
 *   'unavailable'  the plan could not be read: { view }
 *   'applying'     the confirmation was sent: { view }
 *   'stale'        the plan changed: back to review with the fresh plan: { plan, planRef, view, notice }
 *   'settled'      an apply's answer: { view, result }
 * `onSettled(result, target)` is called once for every apply answer that reads and is not a return to review;
 * what it does or throws changes nothing here. `label`: the server's label for a routed row; `leftover`: the row
 * is a home a failed spawn left. Each step carries this confirmation's latest-intent token: an answer to an
 * earlier step, or one after close, changes nothing and is not told. Nothing is kept beyond the instance.
 * `retires` (#1247): the client's retires in flight (retire-in-flight.mjs). Every apply of a retire is begun
 * there before it is sent and settled with its answer's kind, whether or not the confirmation is still open
 * or that answer is still the latest: the row reads Retiring… from the send until the roster was read after it. */
export function createLifecycleConfirmation({ request, target, operation, terms, onSettled = () => {}, onChange = () => {}, label = null, leftover = false, choices: initial = null, retires = null } = {}) {
  requireTerms(terms, 'createLifecycleConfirmation');
  if (typeof request !== 'function' || !target?.instance || !['stop', 'retire'].includes(operation)) throw new TypeError('createLifecycleConfirmation: a request, a target and an operation (stop or retire)');
  let choices = lifecycleOptions(operation, initial) ?? (operation === 'stop' ? { recursive: true } : { discardWorktree: false });
  let phase = 'reading', outcome = null, notice = null, plan = null, planRef = null, shown = null, submission = null, settledView = null, ticket = 0, closed = false, current = null;
  const tell = (event, detail) => { try { onChange(event, detail); } catch { /* a client's drawing changes nothing here */ } };
  const verb = operation === 'retire' ? 'retiring' : 'stopping';
  const applicable = () => !!plan && lifecycleChoicesApplicable(plan, choices);
  function offers() {
    if (closed) return [];
    if (phase === 'reading' || phase === 'applying') return ['close'];
    if (phase === 'review') return [...(planRef && applicable() ? ['apply'] : []), 'refresh', 'close'];
    return [...SETTLED_OFFERS[outcome]];
  }
  /** Read a plan. The reference on screen is revoked at once; the plan on screen stays while a new one is read
   * only when it was under review (`kept`). */
  async function read(cause) {
    const mine = ++ticket, requested = { ...choices }, kept = !!shown && phase === 'review' || !!shown && phase === 'reading' && current?.kept;
    plan = null; planRef = null; submission = null; notice = null; outcome = null; settledView = null; phase = 'reading';
    if (!kept) shown = null;
    current = { kind: 'reading', cause, kept, title: question(operation, target),
      message: kept ? (cause === 'check' ? 'Checking again…' : 'Updating for this choice…') : label ? readingFrom(label) : `Checking what ${verb} ${target.instance} will do…` };
    tell('reading', { cause, kept, view: current });
    const failed = reason => {
      if (mine !== ticket || closed) return;
      phase = 'settled'; outcome = 'unavailable'; shown = null; settledView = current = unavailableView(reason, { target, operation }, terms);
      tell('unavailable', { view: current });
    };
    try {
      const result = await request({ action: 'plan', operation, selector: { instance: target.instance, agent: target.agent, agentsRoot: target.agentsRoot, server: target.server ?? null }, options: requested });
      if (mine !== ticket || closed) return;
      if (!validTarget(result, target) || result.status !== 'plan') { failed(validTarget(result, target) ? result.reason : { code: result?.reason?.code }); return; }
      const value = lifecyclePlan(result.plan, target, operation, requested);
      if (!value || !planReference(result.planRef) || JSON.stringify(lifecycleOptions(operation, result.options)) !== JSON.stringify(requested)) throw new Error('Invalid plan');
      plan = value; planRef = result.planRef; shown = value; phase = 'review'; current = planView(value, { operation, choices: requested, leftover }, terms);
      tell('plan', { plan, planRef, view: current });
    } catch { failed({ code: 'E_CLI_PROTOCOL' }); }
  }
  /** Send the reference: the one under review (`apply`), or the one already sent (`checkAgain`). */
  async function send(again) {
    const mine = ++ticket, snapshot = again ? submission.plan : plan, reference = again ? submission.reference : planRef;
    submission = { reference, plan: snapshot, uncertain: true };
    phase = 'applying'; planRef = null; outcome = null; notice = null; settledView = null;
    current = { kind: 'applying', title: `${operation === 'retire' ? 'Retiring' : 'Stopping'} ${target.instance}…`,
      message: operation === 'retire' ? `Retiring ${target.instance}. This can take up to a minute while sessions stop.` : `Stopping ${target.instance}. This can take up to a minute.` };
    tell('applying', { view: current });
    let own = null;
    if (operation === 'retire') { try { own = retires?.begin(target) ?? null; } catch { /* the hold is a drawing aid only */ } }
    let result = null, view;
    try { result = await request({ action: 'apply', planRef: reference }); view = outcomeView(result, { target, operation, choices, plan: snapshot, leftover }, terms); }
    catch { view = outcomeView(null, { target, operation, choices, plan: snapshot, leftover }, terms); }
    try { own?.settle(view.kind); } catch { /* as above */ }
    if (mine !== ticket || closed) return;
    if (view.kind === 'stale') {
      plan = view.plan; planRef = view.planRef; shown = view.plan; notice = view.notice; phase = 'review';
      current = planView(view.plan, { operation, choices, leftover }, terms);
      tell('stale', { plan, planRef, view: current, notice });
      return;
    }
    submission.uncertain = view.uncertain; phase = 'settled'; outcome = view.kind; settledView = current = view;
    tell('settled', { view, result });
    if (view.kind !== 'invalid') { try { Promise.resolve(onSettled(result, target)).catch(() => {}); } catch { /* a refresh cannot erase a recorded outcome */ } }
  }
  void read('open');
  return {
    /** `running`: this client's own apply that is still running, when the settled answer says so (when it
     * started is `running.since`, ms since the epoch, for the client to word). */
    state: () => ({ phase, outcome: phase === 'settled' ? outcome : null, notice, offers: offers(), running: phase === 'settled' && settledView?.running ? { ...settledView.running } : null }),
    view: () => current,
    /** Set one choice of the plan (an id of `planView(…).choices`) and read the plan for it: while a plan is read
     * or reviewed, the latest choice wins. */
    setChoice(id, value) {
      if (closed || !['reading', 'review'].includes(phase) || !CHOICES[operation].some(([c]) => c === id) || typeof value !== 'boolean') return false;
      choices = { [id]: value }; void read('option'); return true;
    },
    refresh(cause = 'review') { if (!offers().includes('refresh')) return false; void read(cause === 'check' ? 'check' : 'review'); return true; },
    apply() { if (!offers().includes('apply')) return false; void send(false); return true; },
    checkAgain() { if (!offers().includes('check-again') || !submission) return false; void send(true); return true; },
    /** Closing cancels nothing that was sent: the answer is no longer told. */
    close() { closed = true; ticket++; },
  };
}
