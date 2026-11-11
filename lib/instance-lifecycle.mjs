/** K3 — lifecycle plans for the Desktop's Stop and Remove confirmations.
 *
 * A plan is a read-only statement of what an action WOULD touch, with the
 * facts a human needs to decide (session state, children, dirty work) and a
 * `planRevision` hashed from the facts that make the action safe. Apply
 * takes that revision back: if reality moved, apply refuses with the fresh
 * plan instead of acting on a world the human did not see. Idempotency keys
 * make a retried apply return the first receipt rather than act twice.
 * Unknown is reported as unknown — never as "clean" or "no children". */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { attachedWorkLink, claimHomeFor, extraWorktreePlan, homeClaimHolder, identifiedHomeRecord, refuseBesideRetire, inspectInstanceSession, instanceWork, listAgents, listInstances, observeSessionWithoutReceipt, readHomeRecord, READ_CLAIM_WHEN_UNWRITABLE, releaseHomeClaim, requireStopGrace, retireClaimPath, retirePendingMarkerPath, retirementRecoveryFacts, shq, stillRunningOf, stopInstanceSession, STOP_UNDER_CLAIM } from "./core.mjs";
import { retireCarried } from "./instance-listing.mjs";
import { groupedByOwner } from "./retire-output.mjs";
import { observeInstanceGit } from "./instance-git.mjs";
import { appendEvent } from "./instance-events.mjs";
import { afterFirstEffect, isAnswerCode, kernelCode, lifecycleBusy, oatsError, reportDefect } from "./errors.mjs";
import { writeThroughPrivateFile } from "./write-through-private-file.mjs";
import { INSTANCE_COLOR_API, INSTANCE_COLORS, writeInstanceColor } from "./instance-color.mjs";
import { INSTANCE_BACKGROUND_API, writeInstanceBackground } from "./instance-background.mjs";
import { sameWorkOf, writeSameWork } from "./instance-same-work.mjs";
import { resolveInstance } from "./instance-address.mjs";
export { resolveInstance } from "./instance-address.mjs";

export const LIFECYCLE_API = 1;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A reserved name: a kernel before feature `lifecycle-claim-stop` wrote this file into each target
 *  of a stop apply and left it there when it was killed. This kernel neither writes nor reads it;
 *  a stop apply removes one it finds, once it holds that home's claim. */
const leftoverStopMarkerPath = (home) => join(home, ".oats-stop-pending.json");
/** An option of planStop: the nonces of the lifecycle claims the caller holds (a stop apply reads
 *  its plan again under its own claims), which the plan does not report as a stop in progress. A
 *  symbol, so no caller can set it from parsed arguments or JSON. */
const OWN_HOLDINGS = Symbol("oats.stopPlanOwnHoldings");
/** The warnings of a stop apply (a leftover marker that could not be removed), on its receipt
 *  under a symbol: the receipt's JSON, printed or stored, does not carry them. */
export const STOP_WARNINGS = Symbol("oats.stopWarnings");
const stopReceiptPath = (home, key) => join(home, `.oats-stop-receipt.${key}.json`);

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function planRevision(facts) { return createHash("sha256").update(JSON.stringify(facts)).digest("hex").slice(0, 24); }

/** The home a stop or a retire is about: resolved (resolveInstance), and refused when its record is
 *  there and cannot be read (core identifiedHomeRecord), before a plan reads anything of it. */
function resolveTarget(ctx, root, name, opts) {
  const me = resolveInstance(ctx, root, name, opts);
  identifiedHomeRecord(me.home);
  return me;
}
/** The record of the home a plan is about, read for the plan's facts: the same reader and the same
 *  refusal as the resolution, so that a record which became unreadable since then (the listing
 *  reads it in between) refuses the plan instead of giving it empty facts. → the record's object,
 *  or undefined for a home without one. */
const targetRecord = (home) => identifiedHomeRecord(home).meta;
/** The record of ANOTHER home (a child's, any home's lineage) → its object, or undefined when it is
 *  absent or cannot be read: such a home decides only for itself, and is nobody's parent or child. */
function otherRecord(home) {
  const record = readHomeRecord(home);
  return record.state === "record" ? record.meta : undefined;
}

/** The words a colour that is not in the palette is refused with (E_BAD_ARGS), awebai/oats#1421 §2. */
export const instanceColorRefusal = (value) => `${JSON.stringify(value)} is not an instance colour: use one of ${INSTANCE_COLORS.join(", ")}, or --clear`;

/** `oats instance color <instance> (<color> | --clear)` (feature instance-color): set or clear the colour of
 *  the home `name` resolves to, addressed as `oats instance stop` addresses it (resolveTarget: not found,
 *  ambiguous, --home mismatch, an unreadable record). A home on its way out is refused before anything is
 *  written: a retire in flight (its pending marker, or the home's lifecycle claim, read and never taken, as
 *  `oats worktree add` reads it) is E_INSTANCE_RETIRING, as is a quarantined home. `color` is a palette name
 *  or null (--clear); the caller refused anything else. → `{ instanceColorApi, instance, home, color, changed }`. */
export function setInstanceColor(ctx, root, name, { home, color }) {
  if (color !== null && !INSTANCE_COLORS.includes(color)) throw oatsError("E_BAD_ARGS", instanceColorRefusal(color));
  const me = resolveTarget(ctx, root, name, { home });
  if (existsSync(join(me.home, ".oats-rollback-incomplete.json"))) throw oatsError("E_INSTANCE_RETIRING", `${me.home} is a quarantined home (or a spawn still in progress); finish its retirement (oats retire); the colour was not changed`);
  if (existsSync(retirePendingMarkerPath(me.home))) throw oatsError("E_INSTANCE_RETIRING", `${name} is being retired; the colour was not changed`);
  refuseBesideRetire("instance color", me.home);
  const { changed } = writeInstanceColor(me.home, color);
  return { instanceColorApi: INSTANCE_COLOR_API, instance: name, home: me.home, color, changed };
}

/** `oats instance background <instance> on|off` (feature instance-background, awebai/oats#1579): record or
 *  remove the background record of the home `name` resolves to, with the authority and the refusals of
 *  `instance color` above (setInstanceColor), a stopped home included. `background` is a boolean; the caller
 *  refused anything else. → `{ instanceBackgroundApi, instance, home, background, changed }`. */
export function setInstanceBackground(ctx, root, name, { home, background }) {
  if (typeof background !== "boolean") throw oatsError("E_BAD_ARGS", "background must be on or off");
  const me = resolveTarget(ctx, root, name, { home });
  if (existsSync(join(me.home, ".oats-rollback-incomplete.json"))) throw oatsError("E_INSTANCE_RETIRING", `${me.home} is a quarantined home (or a spawn still in progress); finish its retirement (oats retire); the background was not changed`);
  if (existsSync(retirePendingMarkerPath(me.home))) throw oatsError("E_INSTANCE_RETIRING", `${name} is being retired; the background was not changed`);
  refuseBesideRetire("instance background", me.home);
  const { changed } = writeInstanceBackground(me.home, background);
  return { instanceBackgroundApi: INSTANCE_BACKGROUND_API, instance: name, home: me.home, background, changed };
}

/** `oats instance same-work <instance> on|off` (feature instance-same-work, awebai/oats#1577): bind the flag
 *  of the home `name` resolves to to its recorded parent (`on`), or remove it (`off`). Addressed, and refused
 *  beside a retire or in a quarantined home, exactly as setInstanceColor is. `on` needs a recorded
 *  `parentInstance` (E_BAD_ARGS without one) and rebinds a record bound to an old parent; the same parent
 *  again writes nothing. `off` succeeds whatever stands there, parent or none. → `{ instance, sameWork }`,
 *  the rule (sameWorkOf) read after the write. */
export function setInstanceSameWork(ctx, root, name, { home, on }) {
  if (typeof on !== "boolean") throw oatsError("E_BAD_ARGS", "instance same-work takes on or off");
  const me = resolveTarget(ctx, root, name, { home });
  if (existsSync(join(me.home, ".oats-rollback-incomplete.json"))) throw oatsError("E_INSTANCE_RETIRING", `${me.home} is a quarantined home (or a spawn still in progress); finish its retirement (oats retire); the flag was not changed`);
  if (existsSync(retirePendingMarkerPath(me.home))) throw oatsError("E_INSTANCE_RETIRING", `${name} is being retired; the flag was not changed`);
  refuseBesideRetire("instance same-work", me.home);
  const recorded = targetRecord(me.home)?.parentInstance;
  const parent = typeof recorded === "string" && recorded !== "" ? recorded : null;
  if (on && parent === null) throw oatsError("E_BAD_ARGS", `${name} has no parent instance: same work is declared against a recorded parent; the flag was not changed`);
  writeSameWork(me.home, on ? parent : null);
  return { instance: name, sameWork: sameWorkOf(me.home, parent) };
}

/** Every instance under the roots whose recorded parent chain reaches `name`,
 *  deepest first (children are acted on before their parent). Recorded
 *  parentage is the only relation the kernel knows; it is reported as such. */
export function descendantsOf(root, name) {
  const rows = [];
  for (const a of listAgents(root)) for (const i of listInstances(root).filter((x) => x.name === a.name)) for (const inst of i.instances || []) {
    const home = join(a._dir, "instances", inst.instance);
    const meta = otherRecord(home);
    if (meta) rows.push({ instance: inst.instance, agent: a.name, home, parent: meta.parentInstance ?? null });
  }
  // Recorded parentage is a BARE name, and names are unique only per agent
  // directory. An edge whose parent name resolves to several homes under this
  // root is ambiguous: it is reported, never acted on (nothing is inferred).
  const homesByName = new Map();
  for (const r of rows) { if (!homesByName.has(r.instance)) homesByName.set(r.instance, []); homesByName.get(r.instance).push(r); }
  const byParent = new Map();
  const ambiguous = [];
  for (const r of rows) {
    if (r.parent && (homesByName.get(r.parent) || []).length > 1) { ambiguous.push({ ...r, reason: `parent name ${JSON.stringify(r.parent)} resolves to ${homesByName.get(r.parent).length} homes; edge not followed` }); continue; }
    if (!byParent.has(r.parent)) byParent.set(r.parent, []); byParent.get(r.parent).push(r);
  }
  const out = [];
  const walk = (parent, depth) => { for (const c of byParent.get(parent) || []) { if (c.instance === parent) continue; walk(c.instance, depth + 1); out.push({ ...c, depth }); } };
  walk(name, 1);
  out.ambiguous = ambiguous.filter((r) => r.parent === name); // edges pointing at THIS name that could not be followed
  return out; // deepest first
}

/** `state` is the session backend's word: "shell"/"stopped"/"not-launched" are
 *  idle; "unknown" means a NON-shell process is running whose identity tmux
 *  cannot name (the ordinary case for a launched harness). "Could not be
 *  established" is a different thing and is `present: null` with a reason:
 *  the kernel code of what failed, never a system error's (E_SESSION_UNAVAILABLE
 *  for one that has none; workFacts: E_GIT_FAILED). */
function sessionFacts(home) {
  try { const s = inspectInstanceSession(home); return { state: s.state, present: s.present, backend: s.backend ?? null, established: true }; }
  catch (e) { return { state: "unestablished", present: null, backend: null, established: false, reason: kernelCode(e, "E_SESSION_UNAVAILABLE") }; }
}
/** The instances attached to `tree`, a tree of the home of the instance `name` under `root` (its
 *  `work/` or an extra tree; #964) → [{ instance, home, session }]. `session` is the session as a
 *  stop plan reads it (sessionFacts), in one word: "running", "stopped", or "unknown" when it could
 *  not be established, which is never taken for stopped. Who is looked at: the recorded
 *  descendants of `name`, as a plan lists them, and the instances that record `name` as their
 *  parent under a name that is not unique (a plan's `ambiguous`). Lineage does not make an
 *  instance attached: its `work` link does (core attachedWorkLink), so these are read too. For
 *  `oats worktree remove`, which removes a tree under nobody's running session. Read-only. */
export function attachedToTree(root, name, tree) {
  const kids = descendantsOf(root, name);
  return [...kids, ...(kids.ambiguous || [])].filter((c) => attachedWorkLink(c.home, tree) !== null).map((c) => {
    const s = sessionFacts(c.home);
    return { instance: c.instance, home: c.home, session: running(s) ? "running" : s.established ? "stopped" : "unknown" };
  });
}
/** Retire's view of a home without its session receipt (before 0.25.9): the
 *  retirement needs only absence, which it can observe — `{state: "absent",
 *  present: false, established: true, note}`; live or ambiguous stays
 *  unestablished, with the note saying why (retire refuses it). */
function retireSessionFacts(home, session, meta) {
  if (session.established || session.reason !== "E_RUNTIME_ENDPOINT_UNKNOWN") return session;
  if (!meta) return session;
  const seen = observeSessionWithoutReceipt(home, meta);
  return seen.absent ? { state: "absent", present: false, backend: seen.backend, established: true, note: seen.note } : { ...session, note: seen.note };
}
const running = (s) => s.established && s.present === true && !["shell", "stopped", "not-launched"].includes(s.state);
function workFacts(home) {
  if (!existsSync(join(home, "work"))) {
    // Not there, unless the home cannot be looked into: then nothing is known of its work.
    try { lstatSync(join(home, "work")); } catch (e) { if (e?.code !== "ENOENT") return { observed: false, reason: "E_WORK_INSPECTION_FAILED" }; }
    return { observed: false, reason: "no-worktree" };
  }
  try {
    const g = observeInstanceGit(home);
    return { observed: true, revision: g.observation.revision, branch: g.observation.branch, detached: g.observation.detached, drift: g.recorded.drift,
      changed: g.summary.changed + g.summary.renamed + g.summary.copied + g.summary.unmerged, untracked: g.summary.untracked,
      upstream: g.upstream, base: { ref: g.base.ref, ahead: g.base.ahead, behind: g.base.behind }, remote: g.remote ? { host: g.remote.host, path: g.remote.path } : null };
  } catch (e) { return { observed: false, reason: kernelCode(e, "E_GIT_FAILED") }; }
}
/** The facts of one target of a plan. `meta` is its record's object: the plan's own home's
 *  (targetRecord) or a child's (otherRecord). `retiring` and `stopPending` are read from the
 *  home's lifecycle claim (core homeClaimHolder), by the holder's verb: a holder that is not gone
 *  (alive, or of a liveness that cannot be read) counts, and `retiring` is also true while a
 *  self-retire is scheduled (its pending marker, unless the completion it names is gone:
 *  retireCarried). A claim in `own` is the caller's and is not reported. */
function targetFacts(row, meta = {}, own) {
  const held = homeClaimHolder(row.home);
  const holds = (action) => !!held && held.action === action && held.state !== "gone" && !own?.has(held.holder.nonce);
  return { instance: row.instance, agent: row.agent, home: row.home, depth: row.depth ?? 0, workMode: meta.work ?? null, launched: meta.launched === true,
    session: sessionFacts(row.home), work: workFacts(row.home),
    retiring: retireCarried(row.home) || holds("retire"), stopPending: holds("stop") };
}

/** Facts for Stop: the instance, its recorded descendants (deepest first),
 *  each with session state and dirty-work counts. `midTask` is REPORTED
 *  activity: dirty work or a running session; unknown says unknown. */
export function planStop(ctx, root, name, { home, recursive = true, [OWN_HOLDINGS]: own } = {}) {
  const me = resolveTarget(ctx, root, name, { home });
  const kids = recursive ? descendantsOf(me.root, name) : [];
  const targets = [...kids.map((kid) => targetFacts(kid, otherRecord(kid.home), own)), targetFacts({ ...me, instance: name, depth: 0 }, targetRecord(me.home), own)];
  // Reported activity: a running session or dirty work is mid-task; when the
  // session could not be established and work is not observed, say unknown.
  for (const t of targets) t.midTask = running(t.session) || (t.work.observed && t.work.changed + t.work.untracked > 0) ? true : (!t.session.established || !t.work.observed) ? "unknown" : false;
  const safety = targets.map((t) => [t.home, t.session.state, t.session.present, t.launched, t.retiring]);
  const ambiguousEdges = (kids.ambiguous || []).map((c) => ({ instance: c.instance, agent: c.agent, home: c.home, reason: c.reason }));
  const plan = { lifecycleApi: LIFECYCLE_API, action: "stop", instance: name, home: me.home, recursive, at: new Date().toISOString(),
    targets, skipped: recursive ? [] : descendantsOf(me.root, name).map((c) => ({ instance: c.instance, agent: c.agent, home: c.home, reason: "recursive=false" })),
    ambiguous: ambiguousEdges,
    planRevision: planRevision(safety),
    notes: [...(ambiguousEdges.length ? [`${ambiguousEdges.length} instance(s) record this name as parent but the name is not unique under this root; they are listed under ambiguous and NOT acted on`] : []),
      ...(targets.some((t) => t.retiring) ? ["a target is being retired; apply will refuse it"] : []),
      ...(targets.some((t) => t.stopPending) ? ["a stop holds a target's claim; apply will refuse it until that stop has ended"] : []), ...(targets.some((t) => !t.session.established) ? ["a session state could not be established; it is reported unestablished, not idle"] : [])] };
  return plan;
}

/** The field of a stop receipt FILE, never of an answer, that says its rows were written under the
 *  rules of feature `lifecycle-kernel-codes`: a kernel code in every failed row, and `stillRunning:
 *  []` only for a harness that exited (core.mjs stillRunningOf). A replay strips it. */
const STORED_UNDER_KERNEL_CODES = "lifecycleKernelCodes";
/** The results of a receipt stored WITHOUT that field, by a kernel from before the feature, as this
 *  kernel answers them: a replay is an answer of this kernel. Such a failed row can hold the
 *  system's own code, which becomes E_SESSION_STOP_FAILED (the row's message keeps the system's
 *  text), and `stillRunning: []`, which that kernel wrote only for a stop whose signalled processes
 *  were gone while the session did not read as idle: null, nothing established. The stored file is
 *  evidence and is never rewritten. */
function replayedResults(results) {
  if (!Array.isArray(results)) return results;
  return results.map((r) => {
    if (!r || typeof r !== "object" || r.ok !== false) return r;
    const code = "code" in r && !isAnswerCode(r.code) ? { code: "E_SESSION_STOP_FAILED" } : {};
    const none = Array.isArray(r.stillRunning) && !r.stillRunning.length ? { stillRunning: null } : {};
    return { ...r, ...code, ...none };
  });
}

/** How many times a stop apply takes its targets' claims before it gives up on a set of targets
 *  that is another one under each read (applyStop, step 4). One pass is every stop there is but
 *  the one that meets a child appearing between its two reads. */
const STOP_CLAIM_PASSES = 3;

/** Apply a Stop plan. A stop holds the lifecycle claim of EVERY target (core claimHomeFor, the
 *  retire's file) before it stops the first one, and until it has written its receipt
 *  (awebai/oats#866, #890). The one exception (awebai/oats#946): a target whose claim cannot be
 *  WRITTEN, for a reason of the system's that stops every other writer of this user as well
 *  (lib/claim.mjs CLAIM_UNWRITABLE_CODES: a full disk, a directory that is not writable), is
 *  read where it would have been taken, and the stop goes on when nobody holds it, holding
 *  nothing for that target and saying so (STOP_WARNINGS). In this order:
 *  1. the plan, read for its targets and for the home of the receipt;
 *  2. a receipt recorded under the same key is replayed (STORED_UNDER_KERNEL_CODES,
 *     replayedResults): read-only, before any claim;
 *  3. the claim of every target, in one fixed order (by claim path), so that two overlapping
 *     stops cannot each hold half: one wins the first file both want, the other is refused at
 *     once and releases what it took. A holder is answered here, before a stale plan:
 *     E_INSTANCE_RETIRING beside a retire, E_LIFECYCLE_BUSY beside a stop, with the plan read
 *     before the claims. A claim that is only read answers the same for whoever holds it;
 *  4. the plan again, under the claims: the plan that is acted on. Every target IT names is held
 *     by this apply before anything is done: one it does not hold (a child recorded, or readable
 *     again, since the read of 1) sends the apply back to 3 with this plan's targets, every claim
 *     released first, so that the order of 3 holds (STOP_CLAIM_PASSES bounds it). A target whose
 *     claim was only read counts as covered, and is read once more here, with the same read: the
 *     last look before the first signal, answered before a stale plan as a holder is in 3. Then
 *     the one comparison with the revision the caller sent: a child retired or re-made, a session started
 *     or ended, a self-retire scheduled since the plan was shown is E_PLAN_STALE with the fresh
 *     plan (the guarded retire's pattern, core RETIRE_UNDER_CLAIM). The plan's own refusals come
 *     from this read too: the instance itself retired since (E_SESSION_UNKNOWN), its record no
 *     longer readable (E_UNIDENTIFIED_INSTANCE_HOME);
 *  5. a scheduled self-retire the caller was shown: E_INSTANCE_RETIRING;
 *  6. a marker an older kernel left in a target is removed (leftoverStopMarkerPath);
 *  7. each target is stopped, deepest first; 8. the receipt is written; 9. the claims are released.
 *  Everything through 6 is before any effect. From 7 on no answer says that nothing happened: a
 *  target's failure is a row of the receipt, and an error that would leave with a code this verb
 *  answers only before any effect is a kernel defect (lib/errors.mjs afterFirstEffect). */
export function applyStop(ctx, root, name, { home, recursive = true, planRevision: expected, idempotencyKey, graceMs } = {}) {
  if (typeof expected !== "string" || !expected) throw oatsError("E_BAD_ARGS", "apply needs --plan-revision from a prior `--plan`");
  if (typeof idempotencyKey !== "string" || !KEY.test(idempotencyKey)) throw oatsError("E_BAD_ARGS", "apply needs --idempotency-key (1-128 chars of [A-Za-z0-9._:-])");
  // Here, for the whole apply: refused per target it would be one row each, after the key was used.
  requireStopGrace(graceMs);
  const shown = planStop(ctx, root, name, { home, recursive });
  const prior = readJson(stopReceiptPath(shown.home, idempotencyKey));
  if (prior && prior.idempotencyKey === idempotencyKey) {
    // A receipt this kernel stored is replayed as stored, without the file's own field.
    const { [STORED_UNDER_KERNEL_CODES]: current, ...stored } = prior;
    return { ...stored, results: current === true ? stored.results : replayedResults(stored.results), replayed: true };
  }
  const held = [];
  const release = () => { for (const h of held.splice(0)) releaseHomeClaim(h); };
  // Whether the first target's stop began: the one fact that says an effect may have happened.
  let began = false;
  try {
    let plan;
    for (let before = shown, pass = 1; ; pass++) {
      const order = before.targets.map((t) => ({ t, lock: retireClaimPath(t.home) })).sort((a, b) => (a.lock < b.lock ? -1 : a.lock > b.lock ? 1 : 0));
      for (const { t } of order) {
        // The refusal's details are of the target whose claim refused, which may be a child.
        // A claim that cannot be written is read in its place (#946): held, or held by nobody.
        try { held.push({ ...claimHomeFor("stop", t.instance, t.home, { [READ_CLAIM_WHEN_UNWRITABLE]: true }), instance: t.instance }); } catch (e) { throw Object.assign(e, { plan: before }); }
      }
      const fresh = planStop(ctx, root, name, { home, recursive, [OWN_HOLDINGS]: new Set(held.filter((h) => h.me).map((h) => h.me.nonce)) });
      const mine = new Set(held.map((h) => h.lock));
      // A claim it holds for a home the fresh plan no longer names is released with the rest.
      if (fresh.targets.every((t) => mine.has(retireClaimPath(t.home)))) { plan = fresh; break; }
      release();
      if (pass === STOP_CLAIM_PASSES) throw Object.assign(lifecycleBusy("none", `the instances a stop of ${name} would stop changed each of the ${pass} times their claims were taken; nothing was stopped`, "run the command again", { instance: name, home: fresh.home }), { plan: fresh });
      before = fresh;
    }
    // The targets whose claim was only read, of this plan: nothing is held for them, so the same
    // read is made again here, the last look before the first signal. A holder that came since
    // is answered as a held claim's is, before a stale plan.
    const targets = new Set(plan.targets.map((t) => retireClaimPath(t.home)));
    const unheld = held.filter((h) => !h.me && targets.has(h.lock));
    for (const h of unheld) { try { h.look(); } catch (e) { throw Object.assign(e, { plan }); } }
    if (plan.planRevision !== expected) throw Object.assign(oatsError("E_PLAN_STALE", `the stop plan changed since it was shown (${expected} → ${plan.planRevision}); review the fresh plan`), { plan });
    const retiring = plan.targets.filter((t) => t.retiring);
    if (retiring.length) throw Object.assign(oatsError("E_INSTANCE_RETIRING", `${retiring.map((t) => t.instance).join(", ")} ${retiring.length === 1 ? "is" : "are"} being retired; nothing was stopped`), { plan });
    // The system's code, never its message. The claim's own path, also when the write that
    // failed was a takeover's.
    const warnings = unheld.map((h) => `${h.instance}: stopping without its claim: ${h.lock} could not be written (${h.unwritable}), and nobody holds it. A retire or a stop of ${h.instance} that starts while this one runs will not see it.`);
    for (const t of plan.targets) {
      const left = leftoverStopMarkerPath(t.home);
      try { rmSync(left, { force: true }); } catch (e) { warnings.push(`${left}, a stop marker an older OATS left, could not be removed (${e?.message ?? e}); it refuses nothing, and the stop went on`); }
    }
    const results = [];
    for (const t of plan.targets) {
      began = true;
      try {
        const r = stopInstanceSession(t.home, { graceMs, [STOP_UNDER_CLAIM]: true });
        results.push({ instance: t.instance, home: t.home, ok: true, stopped: r.stopped, alreadyIdle: r.alreadyIdle, state: r.state });
      } catch (e) {
        reportDefect(e); // the error becomes a row here: its stack would otherwise be lost
        results.push({ instance: t.instance, home: t.home, ok: false, code: kernelCode(e, "E_SESSION_STOP_FAILED"), message: e.message, stillRunning: stillRunningOf(e) });
      }
    }
    const receipt = { lifecycleApi: LIFECYCLE_API, action: "stop", instance: name, home: plan.home, idempotencyKey, planRevision: expected, at: new Date().toISOString(),
      ok: results.every((r) => r.ok), results, retained: ["home", "work", "transcript", "launch"], replayed: false };
    // One receipt file per key: a retry of ANY earlier key replays its own
    // receipt for as long as the home exists (the replay horizon).
    try { writeFileSyncAtomic(stopReceiptPath(plan.home, idempotencyKey), { ...receipt, [STORED_UNDER_KERNEL_CODES]: true }); } catch { /* receipt is evidence, not authority */ }
    return warnings.length ? Object.defineProperty(receipt, STOP_WARNINGS, { value: warnings }) : receipt;
  } catch (e) {
    throw began ? afterFirstEffect(e, "instance stop", "a target's stop had begun") : e;
  } finally {
    release();
  }
}

/** Write `value` as JSON at `path` through a private file beside it (`<path>.<pid>.tmp`), renamed
 *  over it, by the kernel's one such writer (lib/write-through-private-file.mjs): when the write or
 *  the rename fails the private file is removed and the error thrown is that failure's
 *  (awebai/oats#963, #1076). Exported for its test alone (test/stop-private-files.test.mjs): its one
 *  caller keeps the error to itself, so nothing but a call of it shows what it throws. */
export function writeFileSyncAtomic(path, value) {
  writeThroughPrivateFile(path, `${path}.${process.pid}.tmp`, JSON.stringify(value, null, 2));
}

/** The sentence a stop's text closes with, chosen from the receipt's rows as a client reads them
 *  (docs/desktop-cli-api.md, `stillRunning`): a failed row whose `stillRunning` names a process,
 *  or is `null` or absent (nothing established), may still run; `[]` says stopped. A receipt that
 *  is not `ok` while no failed row has anything still running is a stop that stopped its targets
 *  and could not complete its record (a write into the home refused: a full disk), and the text
 *  must not say that something still runs (awebai/oats#963). Fixed sentences; the JSON receipt
 *  is not made from this. */
export function stopClosingLine(receipt) {
  if (receipt.ok) return `stopped${receipt.replayed ? " (replayed receipt)" : ""}; home, work, transcript and launch configuration retained — restart with \`oats session restart\``;
  const mayRun = receipt.results.some((r) => !r.ok && !(Array.isArray(r.stillRunning) && r.stillRunning.length === 0));
  return mayRun ? "some targets are still running; nothing was escalated" : "the stop did not complete its record; nothing is still running";
}

/** What the Desktop reads of a plan's notes (packages/client/lifecycle-contract.mjs): at
 *  most 64, each at most 4096 characters; it refuses a plan with more, so every note is built to fit
 *  (#658). A path is never cut: what does not fit is left to the plan JSON or the receipt. */
const PLAN_NOTES_MAX = 64;
const PLAN_NOTE_MAX = 4096;
/** The characters a note spends listing names (declared roots, attached children) before `, and N more`. */
const PLAN_LIST_BUDGET = 1024;
const SEE_EXTRA = "facts.extraWorktrees in the plan JSON";
/** The first `max` of `items` that fit `budget` characters as `render(shown)`, the rest counted as
 *  `, and N more`. → the text, or null when not even one fits. */
function listWithin(items, render, budget, max = items.length) {
  for (let n = Math.min(items.length, max); n > 0; n--) {
    const text = `${render(items.slice(0, n))}${n < items.length ? `, and ${items.length - n} more` : ""}`;
    if (text.length <= budget) return text;
  }
  return null;
}

/** `render(parts)` within PLAN_NOTE_MAX: `parts` maps each name to [its full text, a pointer to where
 *  the plan JSON holds it]; while the note is too long, the longest part that a pointer shortens is
 *  replaced by it. → the note, or null when it still does not fit. */
function fitParts(render, parts) {
  const shown = Object.fromEntries(Object.entries(parts).map(([key, [full]]) => [key, full]));
  let note = render(shown);
  for (const key of Object.keys(parts).sort((a, b) => String(parts[b][0]).length - String(parts[a][0]).length)) {
    if (note.length <= PLAN_NOTE_MAX) return note;
    if (String(parts[key][0]).length <= parts[key][1].length) continue; // the pointer would not shorten it
    shown[key] = parts[key][1];
    note = render(shown);
  }
  return note.length <= PLAN_NOTE_MAX ? note : null;
}

/** A retire plan's note for one extra tree (core extraWorktreePlan row). Too long for the Desktop, its
 *  longest parts go to the plan JSON, longest first; the tree's path stays whole, or the note says it
 *  is too long and where it is. `attached`: the names of the recorded children whose work is this
 *  tree (#964). The note names them and says what the retire leaves each with: its link repointed to
 *  the tree where it is re-homed, or pointing at a path that is gone where the tree is removed. A
 *  tree the retire refuses is neither moved nor removed, and nothing is said of them. `others`: the
 *  names of the instances attached to it that the plan lists under `ambiguous`. The retire does not
 *  act on them, and the note says what that leaves them with, in a clause of its own. */
function extraWorktreeNote(t, attached = [], others = []) {
  const said = t.disposition !== "refuse";
  const kids = attached.length && said ? (p) => `; attached child instance(s) ${p.kids} use it as their work, and ${t.disposition === "remove" ? "their work link would then point at a path that is gone" : "the retire repoints their work link to it"}` : () => "";
  const rest = others.length && said ? (p) => `; attached instance(s) ${p.others}, listed under ambiguous, use it as their work: ${t.disposition === "remove" ? "the retire does not stop them, and their work link would then point at a path that is gone" : `the retire neither stops them nor repoints their work link, which would then point at a path that is gone (the tree would be at ${p.movedTo})`}` : () => "";
  const parts = {
    ...(attached.length ? { kids: [listWithin(attached, (shown) => shown.join(", "), PLAN_LIST_BUDGET) ?? String(attached.length), `${attached.length} of the recorded children`] } : {}),
    ...(others.length ? { others: [listWithin(others, (shown) => shown.join(", "), PLAN_LIST_BUDGET) ?? String(others.length), `(${others.length} of them)`] } : {}),
    at: [t.branch ? `branch ${t.branch}` : t.detachedAt ? `detached at ${t.detachedAt.slice(0, 12)}` : "a HEAD that could not be read", `its HEAD: see ${SEE_EXTRA}`],
    repo: [t.repo, `its repository (see ${SEE_EXTRA})`],
    movedTo: [t.movedTo, `the path ${SEE_EXTRA} names`],
    reason: [t.reason, `${SEE_EXTRA} says why`],
  };
  const render = (p) => t.disposition === "remove" ? `extra worktree ${t.path} (${p.at}) is clean and would be removed; its branch and commits stay in ${p.repo}${kids(p)}${rest(p)}`
    : t.disposition === "retain" ? `extra worktree ${t.path} (${p.at}) would be re-homed to ${p.movedTo}: ${p.reason}${kids(p)}${rest(p)}`
    : `extra worktree ${t.path} (${p.at}): retire refuses, ${p.reason}`;
  const note = fitParts(render, parts);
  if (note !== null) return note;
  const outcome = t.disposition === "remove" ? "would be removed" : t.disposition === "retain" ? "would be re-homed" : "makes retire refuse";
  return `an extra worktree whose path is too long for this note ${outcome}; ${SEE_EXTRA} lists it${kids({ kids: `${attached.length} of the recorded children` })}${rest({ others: `(${others.length} of them)`, movedTo: `the path ${SEE_EXTRA} names` })}`;
}
/** The plan's note when the worktree is not on the recorded branch: both names, or, too long for the
 *  note, pointers to the plan JSON fields that hold them. */
function driftNote(work, recordedBranch) {
  const on = work.branch ?? (work.detached ? "a detached HEAD" : "a ref OATS carries no branch name for");
  return fitParts((p) => `the worktree is on ${p.on}, not the recorded ${p.recorded}`, {
    on: [on, "the branch facts.work.branch in the plan JSON names"],
    recorded: [recordedBranch, "branch, which facts.recordedBranch in the plan JSON names"],
  }) ?? "the worktree is not on the recorded branch; facts.work.branch and facts.recordedBranch in the plan JSON name both";
}
/** The plan's note on a home without its session receipt: the observation's reason, or, too long
 *  for the note (a process's command line, a tmux error), a pointer to facts.session.note. */
function sessionNote(session) {
  const [head, tail] = session.established ? ["session absent", "nothing needs quiescing"] : ["session not observably absent", "retire refuses until it is stopped"];
  const note = `${head}: ${session.note}; ${tail}`;
  return note.length <= PLAN_NOTE_MAX ? note : `${head}: the reason is too long for this note (facts.session.note in the plan JSON); ${tail}`;
}
/** The plan's recovery note: where a recovery would be written, and the declared roots it leaves
 *  out, listed within PLAN_LIST_BUDGET (at most 16). A recovery path too long for the note is named
 *  by where to find it instead. */
function recoveryNote(recovery) {
  const roots = recovery.disposableHome;
  const notCopied = (head) => {
    if (!roots.length) return "";
    const room = Math.min(PLAN_LIST_BUDGET, PLAN_NOTE_MAX - head.length - "; not copied: ".length);
    const listed = room > 0 ? listWithin(roots, (shown) => groupedByOwner(shown, "root"), room, PLAN_NOT_COPIED_CAP) : null;
    return `; not copied: ${listed ?? `${roots.length} declared root${roots.length === 1 ? "" : "s"}, too long to list here`}`;
  };
  const head = `recovery: the home is copied to ${recovery.recoveryRoot} before the home is removed, when it changed since spawn`;
  const note = `${head}${notCopied(head)}`;
  if (note.length <= PLAN_NOTE_MAX) return note;
  const elsewhere = "recovery: the home is copied to the recovery directory beside the home before the home is removed, when it changed since spawn (its path is too long for this note: the retire receipt names it as workRecovery.path, and the retire summary prints it)";
  return `${elsewhere}${notCopied(elsewhere)}`;
}
/** How many declared roots a retire plan's recovery note lists before `, and N more`. */
const PLAN_NOT_COPIED_CAP = 16;
/** Facts for Remove (retire): what retirement would touch, with the design's
 *  defaults (retain worktree and branch; never touch a PR). `oats retire`
 *  itself applies them: plain retire re-homes the worktree; --discard-worktree
 *  is the dialog's opt-in. No retire deletes a branch: `deleteBranch` is
 *  always false. */
export function planRetire(ctx, root, name, { home } = {}) {
  const me = resolveTarget(ctx, root, name, { home });
  const kids = descendantsOf(me.root, name);
  // Read once, after the lineage: every fact of the plan that the record gives is of this read.
  const recorded = targetRecord(me.home);
  const meta = recorded || {};
  const target = targetFacts({ ...me, instance: name, depth: 0 }, recorded);
  target.session = retireSessionFacts(me.home, target.session, recorded);
  // The home's extra trees and what retire does with each: listed, and bound
  // into the revision (below), so that an apply refuses as stale when a tree
  // was created, removed, dirtied or cleaned, or its target was taken.
  const extraWorktrees = extraWorktreePlan(me.home, me.root);
  // What work/ is, by the one function the retire reads too (core instanceWork, #962): the plan says
  // what the retire will do with it.
  const workIs = instanceWork(me.home, meta);
  const ownTree = workIs.is === "own-tree", homeDirectory = workIs.is === "home-directory";
  // A home spawned before #641 may record the word "HEAD" for a detached checkout: not a branch name.
  // `ownWorktree` (#988, feature retire-plan-own-worktree) is that reading as a fact: whether work/
  // is the instance's own work tree, the one this retire retains or removes. `workMode` is the
  // record's value, which the instance can write, and `work` observes through any link: neither
  // says whose tree it is. A stop plan does not carry it.
  const facts = { session: target.session, work: target.work, workMode: meta.work ?? null, ownWorktree: ownTree, repo: meta.repo ?? null, recordedBranch: meta.branch === "HEAD" ? null : meta.branch ?? null,
    extraWorktrees,
    children: kids.map((c) => ({ instance: c.instance, agent: c.agent, home: c.home, session: sessionFacts(c.home) })),
    ambiguous: (kids.ambiguous || []).map((c) => ({ instance: c.instance, agent: c.agent, home: c.home, reason: c.reason })),
    pullRequest: "unknown" /* forge facts are the ADE's (P1); the kernel never claims 'no PR' */ };
  // `retainWorktree` is the default of one option, whether the instance's own tree is retained. It
  // follows the reading of work/ today, as the fact above does: a default is what the retire would
  // do if nobody chose, a fact is what is there, and a client reads neither as the other.
  // A link under a record that says `worktree` (#973): the link decides, and the plan says so.
  const linkNotOwn = workIs.is === "link" && meta.work === "worktree";
  const defaults = { retainWorktree: ownTree, deleteBranch: false, stopChildren: true, retainChildren: true };
  // The repository the retire would read from Git for an own tree whose record names none.
  const repoFromGit = ownTree && !meta.repo ? workIs.tree?.repo ?? null : null;
  // Attached children whose work is this home's work/ (#718): a retire that keeps the worktree
  // repoints them to it. One note holds whatever the dialog then picks.
  const attached = ownTree ? kids.filter((c) => attachedWorkLink(c.home, join(me.home, "work")) !== null) : [];
  // The instances attached to a tree of this home that record it as their parent under a name that
  // is not unique (`ambiguous`): the retire does not act on them, so each tree's note says what the
  // retire leaves them with (#964). Lineage does not make an instance attached: its link does.
  const attachedAmbiguous = (tree) => (kids.ambiguous || []).filter((c) => attachedWorkLink(c.home, tree) !== null);
  const ambiguousOnWork = ownTree ? attachedAmbiguous(join(me.home, "work")) : [];
  // Each extra tree's attached instances, as its note names them: the recorded children, and those
  // of an ambiguous name.
  const extraAttached = extraWorktrees.map((t) => ({ kids: kids.filter((c) => attachedWorkLink(c.home, t.path) !== null), others: attachedAmbiguous(t.path) }));
  // The session as the plan shows it, whole: its state, and the reason or the note of one that is
  // not established, which the record's launch and endpoint fields decide (awebai/oats#1065). The
  // children as the plan names them (a child's agent is the name its soul's file gives, which its
  // home's path does not hold), and with them what the plan shows of other homes' records: the edges
  // it could not follow (facts.ambiguous, whole: each edge's reason counts the homes of the name)
  // and the instances attached to this work and to each extra tree, which the notes name (#964;
  // attached instances are made by spawns, so they do not move by themselves). Where Git gives no answer for work/, the
  // reason the plan shows for that (facts.work.reason): nothing at work/ and a file there are one
  // answer of the reading under a record that says `worktree`, and two plans. Where Git answers,
  // what the plan shows of the tree that does not move by itself: the commit, the branch and
  // whether HEAD is detached, whether that branch is not the record's (drift, as shown: it comes
  // from a second read of the record, after this plan's, in observeInstanceGit, so it is not
  // derived from facts.recordedBranch), the counts of changed and untracked files, and what
  // the clone's configuration names (the branch's upstream, the remote's host and path). Left
  // out, because a fetch by anyone who shares the clone moves it: the counts against the upstream
  // and the default branch, and the default branch's name (a fetch creates a missing origin/HEAD).
  // docs/desktop-cli-api.md names what is left out, and why.
  const tree = facts.work.observed ? [facts.work.revision, facts.work.branch, facts.work.changed, facts.work.untracked, facts.work.detached, facts.work.drift, facts.work.upstream.ref, facts.work.remote] : { unobserved: facts.work.reason };
  // What retire would preserve and where, read from the spawn baseline and the work mode. A plan
  // hashes no file for it. The declared roots are listed in a note as written, bounded so one
  // note stays short, and are part of the plan's revision (awebai/oats#1065).
  const recovery = retirementRecoveryFacts(me.home);
  const safety = [me.home, target.session, target.launched, tree, kids.map((c) => [c.instance, c.agent, c.home]),
    { ambiguous: facts.ambiguous, attached: attached.map((c) => c.home), ambiguousOnWork: ambiguousOnWork.map((c) => c.home),
      extra: extraWorktrees.map((t, i) => [t.path, extraAttached[i].kids.map((c) => c.home), extraAttached[i].others.map((c) => c.home)]) },
    // The home's extra trees, when there are any.
    ...(extraWorktrees.length ? [extraWorktrees] : []),
    // What the plan reports of the record about work/ (its work mode, its repository, its branch),
    // which the instance can write, and what work/ is by the reading the retire makes too (#962,
    // #973), with the repository Git names for work/ wherever it is a registered work tree: all
    // of it is part of every retire plan's revision, in every home (awebai/oats#1065). So no two
    // plans of one home that the record or the reading makes different, in a fact, a default, a
    // note or the text's line, share a revision, and a guarded apply refuses as stale when one of
    // them moved since the plan was shown. Unconditional: no home, no value of the record and no
    // answer of the reading is left out. A field of the record that a plan comes to show joins
    // this binding (test/retire-plan-revision.test.mjs rewrites each in turn).
    { mode: facts.workMode, repo: facts.repo, branch: facts.recordedBranch, work: workIs.is, tree: workIs.tree?.repo ?? null },
    // Where a recovery would be written and the declared roots it leaves out, as the spawn's
    // receipt gives them: the roots with their owners, not the note made from them, which is
    // shortened past its budget and then reads alike for two lists of one length.
    recovery];
  appendEvent(me.home, { kind: "retire-planned", data: { planRevision: planRevision(safety), children: kids.length, dirty: facts.work.observed ? facts.work.changed + facts.work.untracked : null } }, { workspaceOnly: true });
  const plan = { lifecycleApi: LIFECYCLE_API, action: "retire", instance: name, home: me.home, at: new Date().toISOString(), facts, defaults, planRevision: planRevision(safety),
    notes: boundedNotes(extraWorktrees.map((t, i) => extraWorktreeNote(t, extraAttached[i].kids.map((c) => c.instance), extraAttached[i].others.map((c) => c.instance))), [
      // The two notes about a worktree that is retained are for the instance's own tree alone (#973).
      // Not for a directory of the home (what it holds is copied and removed), not for a directory
      // instance whose work/ is a repository of its own (the recovery note below says what is done),
      // and not for a link: facts.work observes what the link leads to, which is another's tree
      // (its owner's, the shared checkout, the deployment) that the retire neither keeps nor moves.
      ...(ownTree && facts.work.observed && facts.work.drift ? [driftNote(facts.work, facts.recordedBranch)] : []),
      ...(ownTree && facts.work.observed && facts.work.changed + facts.work.untracked > 0 ? [`${facts.work.changed} changed and ${facts.work.untracked} untracked file(s) would be retained with the worktree`] : []),
      ...(homeDirectory ? [HOME_DIRECTORY_NOTE] : []),
      ...(linkNotOwn ? [LINK_NOTE] : []),
      ...(homeDirectory && workIs.tree ? [`work/ is registered as a worktree of ${workIs.tree.repo}: the retire leaves its entry there until a prune (git -C ${shq(workIs.tree.repo)} worktree prune), and does not touch its branch or its commits`] : []),
      ...(repoFromGit ? [`the record names no repository for the work tree: the retire uses the one Git names for it, ${repoFromGit}, and does not write it into the record`] : []),
    ], [
      ...(kids.length ? [`${kids.length} recorded child instance(s) are stopped first (bounded SIGTERM, never escalated) and retained (their homes are not removed); a child still running after the grace refuses the retirement`] : []),
      ...(attached.length ? [`attached child instance(s) ${listWithin(attached.map((c) => c.instance), (shown) => shown.join(", "), PLAN_LIST_BUDGET) ?? attached.length} use this home's work/ as their work: a retire that keeps the worktree repoints their work link to it; with --discard-worktree the worktree is removed and their work link will dangle`] : []),
      ...(ambiguousOnWork.length ? [`attached instance(s) ${listWithin(ambiguousOnWork.map((c) => c.instance), (shown) => shown.join(", "), PLAN_LIST_BUDGET) ?? ambiguousOnWork.length}, listed under ambiguous, use this home's work/ as their work: the retire neither stops them nor repoints their work link, which will then point at a path that is gone, whether the worktree is retained (the receipt names where) or removed with --discard-worktree`] : []),
      ...((kids.ambiguous || []).length ? [`${kids.ambiguous.length} instance(s) record this name as parent but the name is not unique under this root; they are listed under ambiguous and NOT acted on`] : []),
      ...(target.session.note ? [sessionNote(target.session)] : []),
      "pull request state is unknown to the kernel; the ADE reports it when a forge connection exists",
      recoveryNote(recovery),
      ...(ownTree ? ["recovery: uncommitted worktree state is copied there too"] : homeDirectory || meta.work === "directory" ? ["recovery: work/ is copied there when it is not empty"] : []),
    ]) };
  // For the plan's text alone (retireDefaultsLine): not part of the plan's JSON.
  Object.defineProperty(plan, PLAN_WORK, { value: workIs.is });
  return plan;
}

/** A retire plan's own answer to what work/ is (core instanceWork), kept on the plan object for its
 *  text line and never serialised: the plan's JSON has no field for it. */
const PLAN_WORK = Symbol("oats.retire-plan.work");
/** The plan's note for a real directory at work/ that is not the instance's own tree (#962). */
const HOME_DIRECTORY_NOTE = "work/ is a real directory of the home and not a work tree of the instance's own: the retire copies it to recovery when it is not empty (a .git in it included), checks the copy, and removes it with the home";
/** The same, as the plan's text says it where a `worktree` instance's says "retain worktree". */
const HOME_DIRECTORY_SENTENCE = "no work tree of its own (work/ is a real directory of the home: copied to recovery when not empty and then removed with the home)";

/** The plan's note for a link at work/ under a record that says `worktree` (#973). It names no
 *  target: the plan's revision does not bind where the link leads. It names the flag: a plan takes
 *  no option (`--plan --discard-worktree` answers this same plan), and no worktree step runs for a
 *  link with the flag either, which the plan says before the receipt does. */
const LINK_NOTE = "the record says work mode worktree, but work/ is a link and not a work tree of the instance's own: the retire removes the link with the home and does not touch what it leads to, with --discard-worktree as well";
/** The same, as the plan's text says it where a `worktree` instance's says "retain worktree". */
const LINK_SENTENCE = "no work tree of its own (work/ is a link, though the record says worktree: what it leads to is not touched)";

/** What a retire does with `work/` in each work mode that has no work tree of its own, as the plan's
 *  text says it where a `worktree` instance's says "retain worktree" (awebai/oats#959). Each is what
 *  retireInstance does (lib/core.mjs): `work/` of an attached, checkout or workspace instance is a
 *  link the spawn made, which goes with the home and whose target no step of the retire reads as a
 *  tree to move or remove; `work/` of a directory instance is the home's own directory, copied to
 *  recovery when it holds anything and then removed with the home. */
const RETIRE_WORK_SENTENCES = {
  attached: "no work tree of its own (work/ links to its owner's tree and that tree is not touched)",
  checkout: "no work tree of its own (work/ links to the shared checkout and that checkout is not touched)",
  workspace: "no work tree of its own (work/ links to the deployment directory and that directory is not touched)",
  directory: "no work tree (work/ is the home's own directory: copied to recovery when not empty and then removed with the home)",
};
/** The `defaults:` line of a retire plan's text. `defaults.retainWorktree` is the default of one
 *  option, whether the instance's OWN work tree is retained, and is `true` only when `work/` is
 *  that tree (below): printed as `false` for a home without one it reads as if a tree were
 *  removed, so the line says what is true of that mode's work instead. A record with no work mode, or one this kernel does not know
 *  (a value that is not a string included: it is never read as a mode's name), says so, in the
 *  kernel's words alone: the value is the record's, which the instance can write, and is never
 *  printed (`facts.workMode` of the JSON holds it). The plan's JSON is not changed by any of this.
 *
 *  What is at `work/` comes first (#962, the plan's own answer, PLAN_WORK): a real directory that is
 *  not the instance's own tree is said as that, whatever the mode, and the instance's own tree is
 *  "retain worktree", whatever the mode (a record with no work mode whose `work/` Git confirms is a
 *  registered worktree). A link under a record that says `worktree` is said as a link, never as
 *  "retain worktree false" (#973). A plan object without that answer is read by its mode alone. */
export function retireDefaultsLine(plan) {
  const mode = plan.facts.workMode;
  const work = plan[PLAN_WORK] === "home-directory" ? HOME_DIRECTORY_SENTENCE
    : plan[PLAN_WORK] === "link" && mode === "worktree" ? LINK_SENTENCE
    : mode === "worktree" || plan[PLAN_WORK] === "own-tree" ? `retain worktree ${plan.defaults.retainWorktree}`
    : typeof mode === "string" && Object.hasOwn(RETIRE_WORK_SENTENCES, mode) ? RETIRE_WORK_SENTENCES[mode]
    : mode === null || mode === undefined ? "work mode not recorded"
    : "work mode not known to this kernel";
  return `defaults: ${work}, delete branch ${plan.defaults.deleteBranch}, stop children ${plan.defaults.stopChildren}`;
}

/** A retire plan's notes in order: `before`, one per extra tree, `after`. The extra trees are the
 *  only notes without a fixed count: past PLAN_NOTES_MAX the last one kept counts the rest. Each note
 *  is built to fit PLAN_NOTE_MAX; one that still does not (a new note that forgot to) is replaced
 *  rather than let the Desktop refuse the whole plan. */
function boundedNotes(trees, before, after) {
  const room = PLAN_NOTES_MAX - before.length - after.length;
  const shown = trees.length <= room ? trees : [...trees.slice(0, room - 1), `and ${trees.length - room + 1} more extra worktrees (${SEE_EXTRA} lists every one)`];
  return [...before, ...shown, ...after].map((note) => note.length <= PLAN_NOTE_MAX ? note : "a note too long for this plan was left out; the plan JSON's facts hold what it said");
}
