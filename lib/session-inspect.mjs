/** inspectInstanceSession: what a home's session is, read under the home's runtime authority (its
 *  recorded launch and receipts, the retirement baseline, the Herdr refusal): a tmux session's agent
 *  pane and its liveness, or, for a home on a session provider (lib/session-providers.mjs), the
 *  provider's own answer. A leaf (awebai/oats#1630): `oats session inspect` reads it without loading core.mjs, which
 *  imports these helpers and re-exports what it exported. */
import { realPathOrNearest, canonicalHomePath } from "./real-path.mjs";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, basename } from "node:path";
import { RETIRE_BASELINE_VERSION, findRetirementBaseline, instancesRetirementRoot, isPlainObject, legacyRetirementBaselinePath, readJsonOrUndefined, receiptHomeIdentity, receiptRecordsHome, retirementBaselinePath } from "./session-receipt.mjs";
import { inspectSessionTarget } from "./session-input.mjs";
import { liveWaiting } from "./instance-events.mjs";
import { oatsError, herdrInstanceRemoved } from "./errors.mjs";
import { HOST_STOP_REASON, lostReasonOf } from "./session-end.mjs";
import { receiptTrust, trustedRecord } from "./home-integrity.mjs";
import { harnessAlive, homeSessionProvider, isSessionProviderName, inspectProviderSession, launchSentOf, providerEndpointDifferences, providerRuntimeOf, unsettledLaunchSaid } from "./session-providers.mjs";

/** A cleanup descriptor is usable only if it can DRIVE the retry, so it is checked
 * as the strict contract its one producer writes — the rollback above — and to the
 * depth the retry CONSUMES it. Three rounds of review landed on this: validating
 * the outer shape only moved the failure from "unparseable" to "parseable and
 * useless", and every tolerance ("field optional", "array is enough") turned into
 * a retry that resolved nothing, reported no failures, and CLEARED the quarantine
 * — deleting the credential while the external state it was holding survived.
 *
 * Required, because the producer always writes them and the retry needs each one:
 * `version` (the contract), `repo` (resolves capabilities and reruns hooks),
 * `work` + `branch`-when-worktree (the rollback-owned Git steps; an unrecognised
 * mode silently skips them), `capabilityRuntime` (handed to runLifecycleHooks AS
 * the capability set, so it must BE one and must contain every outstanding hook),
 * and `outstanding.hooks` (what the retry has to prove it reran).
 *
 * Anything else reads as ABSENT — no more retryable than a missing marker — so the
 * home fails closed by default and `--force` can clear it. */

/** Herdr (removed in 0.31.0) is recognised in a home only to refuse: its instance.json records a
 *  Herdr session target or `backend: "herdr"`, or its independent receipt records a session target
 *  (a tmux receipt never does). Either source is enough. */
function recordsHerdr(meta, baseline) {
  return (isPlainObject(meta) && (meta.sessionTarget !== undefined || meta.backend === "herdr"))
    || (isPlainObject(baseline?.runtime) && baseline.runtime.sessionTarget !== undefined);
}
/** Refuse any session operation on a home opened in Herdr, from its files as they are (either may be
 *  missing or unreadable): before any receipt validation, so the refusal is never an endpoint error. */
function refuseHerdrHome(home) {
  if (recordsHerdr(readJsonOrUndefined(join(home, "instance.json")), readJsonOrUndefined(findRetirementBaseline(home)))) throw herdrInstanceRemoved(basename(home));
}

/** What a receipt authorises: `{ launched: false }` (with `planned: { backend, provider }` for a home
 *  that will launch on a session provider), `{ launched: true, tmux }` for a tmux session, or
 *  `{ launched: true, session }` for a session provider's (`session`: providerRuntimeOf's
 *  `{ backend, provider, endpoint, stoppedAt }`); undefined when it is none of these. */
function runtimeAuthorityOf(baseline) {
  const runtime = baseline?.runtime;
  if (!isPlainObject(runtime) || typeof runtime.launched !== "boolean") return undefined;
  if (!runtime.launched) {
    if (runtime.backend === undefined && runtime.provider === undefined) return { launched: false };
    if (!isSessionProviderName(runtime.backend) || typeof runtime.provider !== "string" || !runtime.provider || runtime.launchSent !== undefined) return undefined;
    return { launched: false, planned: { backend: runtime.backend, provider: runtime.provider, launchSent: null } };
  }
  if (runtime.sessionTarget !== undefined) return undefined;
  // A launch that was sent for a home never launched, and has no recorded outcome (lib/session-providers.mjs
  // launchSentOf): no endpoint yet. The home is still a planned one, whose record says not launched.
  if (runtime.tmux === undefined && runtime.endpoint === undefined) {
    const launchSent = launchSentOf(runtime);
    if (!launchSent || !isSessionProviderName(runtime.backend) || typeof runtime.provider !== "string" || !runtime.provider) return undefined;
    return { launched: false, planned: { backend: runtime.backend, provider: runtime.provider, launchSent } };
  }
  if (runtime.tmux === undefined) {
    const session = providerRuntimeOf(runtime);
    return session ? { launched: true, session: { backend: session.backend, provider: session.provider, endpoint: session.endpoint, stoppedAt: session.stoppedAt, launchSent: session.launchSent } } : undefined;
  }
  const tmux = runtime.tmux;
  if (!isPlainObject(tmux) || ![tmux.session, tmux.window, tmux.socket].every((v) => typeof v === "string" && v.length > 0)) return undefined;
  return { launched: true, tmux: { session: tmux.session, window: tmux.window, socket: resolve(tmux.socket) } };
}
/** The fields of instance.json's session that differ from the receipt's, for a home on a session
 *  provider, launched (`authority.session`) or planned (`authority.planned`: no endpoint yet). */
function providerDifferences(meta, authority) {
  // While the receipt says a launch is unsettled, the record's endpoint is not compared: the
  // launch that would have written it may have ended at any point (docs/design/2026-11-20-provider-home-lifecycle.md).
  if (authority.session && !authority.session.launchSent) return providerEndpointDifferences(meta, authority.session);
  const named = authority.session ?? authority.planned;
  return [
    ...(meta?.backend === named.backend ? [] : ["backend"]),
    ...(meta?.session?.provider === named.provider ? [] : ["session.provider"]),
  ];
}
/** The fields of instance.json's endpoint, of whichever backend the receipt records, that differ
 *  from the receipt's: tmux's labels, or a session provider's. A receipt that records no endpoint
 *  (never launched, planned on tmux) has none to differ from. */
function endpointDifferences(meta, authority) {
  if (authority.session || authority.planned) return providerDifferences(meta, authority);
  return authority.launched ? tmuxEndpointDifferences(meta, authority) : [];
}

/** The fields of instance.json's tmux endpoint that differ from the one the independent receipt
 *  authorises, as fixed labels in a fixed order: `tmux.session`, `tmux.window`, `tmux.socket`. */
function tmuxEndpointDifferences(meta, authority) {
  return [
    ...(meta.tmux?.session === authority.tmux?.session ? [] : ["tmux.session"]),
    ...(meta.tmux?.window === authority.tmux?.window ? [] : ["tmux.window"]),
    ...(resolve(meta.tmux?.socket || ".") === authority.tmux?.socket ? [] : ["tmux.socket"]),
  ];
}
/** instance.json's tmux endpoint is the one the independent receipt authorises. */
function tmuxEndpointAgrees(meta, authority) { return tmuxEndpointDifferences(meta, authority).length === 0; }
/** instance.json's endpoint, of whichever backend the receipt records, is the one it authorises. */
function endpointAgrees(meta, authority) { return endpointDifferences(meta, authority).length === 0; }

/** Whether a blocked or incomplete launch prompt explains metadata's `launched: false` beside a
 *  launched receipt. */
function promptRetained(meta, authority) {
  return authority.launched === true && meta.launched === false && ["blocked", "incomplete"].includes(meta.launchPrompts?.status);
}
/** A blocked prompt is a retained runtime, not evidence that no process exists.
 * The independent launched receipt and exact endpoint agreement remain mandatory. */
function launchStateAgrees(meta, authority) {
  // A launch that was sent for a home never launched (lib/session-providers.mjs launchSentOf): the
  // record says `launched: true` meanwhile, so that a kernel from before session providers refuses
  // the home; the two files are written one after the other, so either value agrees.
  if ((authority.session ?? authority.planned)?.launchSent) return true;
  return meta.launched === authority.launched || (promptRetained(meta, authority) && !authority.session && tmuxEndpointAgrees(meta, authority));
}

/** The refusal for instance.json that disagrees with the independent receipt. `details.fields` names
 *  what differs, from a fixed vocabulary in a fixed order: `launched` (unless a blocked or incomplete
 *  launch prompt explains metadata's `launched: false`), then each differing endpoint field: for a
 *  launched tmux receipt `tmux.session`, `tmux.window`, `tmux.socket`; for a session provider's
 *  `backend`, `session.provider`, `session.endpoint`. Labels only: never a path, a value or the receipt. Callers throw it only once
 *  their own comparison has refused, so these labels diagnose a refusal and never decide one. */
function authorityMismatch(message, meta, authority) {
  const fields = [
    ...(meta.launched === authority.launched || promptRetained(meta, authority) || (authority.session ?? authority.planned)?.launchSent ? [] : ["launched"]),
    ...endpointDifferences(meta, authority),
  ];
  return Object.assign(oatsError("E_RUNTIME_AUTHORITY_MISMATCH", message), { details: { fields } });
}

/** The refusal for a home whose session receipt is at neither key its path gives (findRetirementBaseline):
 *  the canonical one, and the one an earlier kernel used for this spelling when that differs. The
 *  receipt is keyed by the home's path, so a moved deployment looks elsewhere. */
function missingSessionReceipt(home) {
  const canonical = retirementBaselinePath(home), legacy = legacyRetirementBaselinePath(home);
  const where = legacy === canonical ? canonical : `${canonical} (nor at ${legacy}, where a kernel before 0.49.0 kept it for this spelling)`;
  return oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `no session receipt for ${home} at ${where}. First address the home exactly as \`oats status\` prints it (a deployment directory moved since spawn looks for the receipt elsewhere, and so does a letter-case spelling other than the spawn's, for a home spawned before 0.49.0). Otherwise the home was copied, the .oats-retirement beside it was removed, or its creation did not finish: stop its session yourself if one runs, then \`oats retire ${basename(home)} --plan\` and \`oats retire ${basename(home)}\` (work is preserved), and respawn.`);
}

/** Why a file could not be read or parsed, in the system's or the parser's words, without the path
 *  the sentence already names: `EACCES: permission denied`; a missing file is "it is missing". */
const unreadableBecause = (e) => e?.code === "ENOENT" ? "it is missing" : String(e?.message ?? e).replace(/, [a-z]+ '.*'$/s, "");

/** Session control uses the independent endpoint receipt. The receipt and the record are read
 *  apart, so that a failure names the file that failed (#1092): one `catch` over both cannot know. */
function instanceSessionTarget(home, { absentMeta } = {}) {
  if (typeof home !== "string" || !isAbsolute(home)) throw oatsError("E_BAD_ARGS", "session needs an absolute instance home");
  home = realPathOrNearest(home);
  refuseHerdrHome(home);
  const receiptPath = findRetirementBaseline(home), recordPath = join(home, "instance.json");
  let baseline, meta;
  try { baseline = JSON.parse(readFileSync(receiptPath, "utf8")); } catch (e) {
    if (e.code === "ENOENT" && e.path === receiptPath) throw missingSessionReceipt(home);
    throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot read session receipt for ${home} at ${receiptPath}: ${unreadableBecause(e)}`);
  }
  try { meta = JSON.parse(readFileSync(recordPath, "utf8")); }
  catch (e) {
    // Upgrade may be between the two metadata renames. Its durable journal
    // supplies only the missing record; the independent endpoint still decides.
    if (e.code === "ENOENT" && isPlainObject(absentMeta)) meta = absentMeta;
    else throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot read ${recordPath}: ${unreadableBecause(e)}`);
  }
  // A record that is JSON and no object gives no endpoint to compare the receipt with.
  if (!isPlainObject(meta)) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `cannot read ${recordPath}: it holds no JSON object`);
  const authority = baseline.version === RETIRE_BASELINE_VERSION && receiptRecordsHome(baseline, canonicalHomePath(home)) && runtimeAuthorityOf(baseline);
  if (!authority) throw oatsError("E_RUNTIME_ENDPOINT_UNKNOWN", `independent session receipt is missing or invalid for ${home}`);
  // A home that is being spawned: its receipt is there (a directory home's is written before the
  // spawn's hooks run; planned, never launched) and its record is still the one its files were
  // composed with (lib/materialize.mjs: its modules, and no agent, no launch, no backend yet).
  // The spawn's hooks, and a provider's readiness check, run in between. Nothing contradicts
  // anything: the session is not recorded yet, and a read says so (a presence read that a hook
  // sets off lands here on every spawn).
  const composedOnly = meta.agent === undefined && meta.launch === undefined && meta.backend === undefined && meta.tmux === undefined;
  if (composedOnly && (authority.planned ? !authority.planned.launchSent : authority.launched !== true)) {
    // (Whether that spawn still runs is not told here: one that ended before its record reads the same.)
    throw oatsError("E_SESSION_UNAVAILABLE", `${basename(home)} is being spawned, or its spawn ended before its record was written: its session ${authority.planned ? `is planned on ${authority.planned.backend}` : "is planned"}, and its record is not there yet`);
  }
  if (!launchStateAgrees(meta, authority) || !endpointAgrees(meta, authority)) throw authorityMismatch("instance metadata disagrees with independent session receipt", meta, authority);
  // `unsettled`: a launch that was sent to the home's provider and never recorded, whether the home
  // was launched before or not: `{ backend, provider, launchSent }`, or null. The one place that says so.
  const recorded = authority.session ?? authority.planned ?? null;
  // A provider home's capability rows (settings, hook commands) are its receipt's, never its own
  // record's, which its agent can write (lib/home-integrity.mjs): every verb reads them here.
  meta = trustedRecord(meta, receiptTrust(baseline, home));
  return { home, target: authority.tmux ? { backend: "tmux", ...authority.tmux } : undefined, meta,
    ...(authority.session ? { session: authority.session } : {}), ...(authority.planned ? { planned: authority.planned } : {}),
    unsettled: recorded?.launchSent ? { backend: recorded.backend, provider: recorded.provider, launchSent: recorded.launchSent } : null };
}
/** The answer for a tmux-only path that meets a home on a session provider (`s`: instanceSessionTarget's
 *  answer): the home has no tmux endpoint to read or act on. Undefined for any other home. */
function providerHomeOf(s) { return s.session ?? s.planned; }

/** `wakeHold` (feature wake-hold): whether this home's capabilities said its dialogs become the claims
 *  a wake holds on, from the home's record (instance.json `dialogClaims`): `on-claims` if any entry is
 *  `reported`, else `not-exposed` if any is `none`, else `unknown`, which covers no record and an
 *  unreadable one. It answers for the kernel's wake delivery only, and the hold never reads it. */
function wakeHoldOf(meta) {
  const answers = isPlainObject(meta?.dialogClaims) ? Object.values(meta.dialogClaims) : [];
  return answers.includes("reported") ? "on-claims" : answers.includes("none") ? "not-exposed" : "unknown";
}

/** What a provider home's `session` is in an answer: the capability that supplies its backend and
 *  the endpoint the kernel recorded (null before the first launch). */
export function sessionOf(session) { return { provider: session.provider, endpoint: session.endpoint ?? null }; }
/** A launched provider home's session, as inspect answers it (docs/desktop-cli-api.md): the
 *  provider's own `{ present, state, running, open }`, with the kernel's `backend`, `session`,
 *  `waitingOnYou` and `wakeHold`; no pane and no size. Kernel-owned: a home OATS stopped (`stoppedAt`)
 *  answers stopped WITHOUT calling the provider, so a session the provider would restart on the next
 *  input reads as OATS left it. A provider that fails, refuses or answers outside the contract's
 *  words is E_SESSION_UNAVAILABLE, never stopped. `waitingOnYou` is a producer's claim, read
 *  whenever the session is not stopped (providerMayWait): an idle session can be the one waiting
 *  on a person. */
function inspectProviderHome(s, wakeHold, io) {
  const answer = { home: s.home, backend: s.session.backend };
  const kernel = { wakeHold, session: sessionOf(s.session) };
  if (s.session.stoppedAt !== null) return { ...answer, present: false, state: "stopped", running: false, waitingOnYou: null, ...kernel, open: null };
  const found = homeSessionProvider(s.home, s.meta, s.session.provider, s.session.backend);
  if (found.problem) throw oatsError("E_SESSION_UNAVAILABLE", `cannot inspect session: ${found.problem}`);
  const inspected = inspectProviderSession(found.binding, s.session.endpoint, { io });
  if (inspected.unavailable) throw oatsError("E_SESSION_UNAVAILABLE", `cannot inspect session: ${inspected.unavailable}`);
  const { present, state, running, open } = inspected.observed;
  return { ...answer, present, state, running, waitingOnYou: providerMayWait(inspected.observed) ? liveWaiting(s.home) : null, ...kernel, open };
}
/** Whether a provider home is one OATS stopped to keep down: its receipt records `stoppedAt`, and
 *  that stop was not the host's shutdown. What a due wake starts (lib/schedule.mjs performWake), as
 *  it starts a stopped tmux home. False for everything else:
 *  - a home stopped with the host: OATS means it to run, and its session is resumed in its own
 *    conversation (`sessionEnd: "lost"`; lib/session-resume.mjs);
 *  - a session that is gone and that OATS did not stop (lost: an input to it is its resume);
 *  - a home with a launch sent and not recorded, one never launched, a tmux home, and a home whose
 *    record cannot be read.
 *  Only read: the provider is not called. */
export function providerHomeStoppedByOats(home) {
  let s;
  try { s = instanceSessionTarget(home); } catch { return false; }
  if (!s.session || s.unsettled || s.session.stoppedAt === null) return false;
  return lostReasonOf(s.home, s.meta) !== HOST_STOP_REASON;
}
/** For a verb that must not act under a running harness (`oats instance upgrade`): whether the
 *  provider of a home OATS recorded stopped, by an operator or with the host, answers a live
 *  harness there (features provider-outside-oats; a home stopped with the host whose harness came
 *  back) → the backend's name, or null: for a home that is not a provider home, one OATS did not
 *  stop (its session is inspect's to read), and one whose provider cannot be asked, fails, refuses,
 *  answers outside the contract's words or cannot tell (`running: null`). One `inspect`, under its own timeout. Only read: no
 *  record is written, cleared or moved, and nothing is resumed. */
export function stoppedHomeHarness(home, { io, absentMeta } = {}) {
  const s = instanceSessionTarget(home, { absentMeta });
  if (!s.session || s.session.stoppedAt === null || s.unsettled) return null;
  const found = homeSessionProvider(s.home, s.meta, s.session.provider, s.session.backend);
  if (found.problem) return null;
  const inspected = inspectProviderSession(found.binding, s.session.endpoint, { io });
  return inspected.observed && harnessAlive(inspected.observed) ? s.session.backend : null;
}
/** Whether a provider's session, as observed, can be waiting on a human: whenever it is not stopped
 *  (`running` true or null). An agent that waits on a question is idle where its provider runs it,
 *  so it reads `running: null`: the claim is shown then too. Never for a session that is gone (a
 *  lost one included) or in error, nor for a home OATS stopped, which is never observed. */
function providerMayWait(observed) { return observed.present === true && observed.running !== false; }

/** `io` (`{ exec }`) is the tmux and process-table seam inspectSessionTarget takes; for a home on a
 *  session provider, `io.spawnSync` is the provider call's. */
export function inspectInstanceSession(home, { io, absentMeta } = {}) {
  if (typeof home === "string" && isAbsolute(home) && !existsSync(home)) return { home: realPathOrNearest(home), backend: null, present: false, state: "stopped", running: false, waitingOnYou: null, wakeHold: wakeHoldOf(null) };
  const s = instanceSessionTarget(home, { absentMeta });
  const wakeHold = wakeHoldOf(s.meta);
  // A launch that was sent and never recorded (launchSentOf), on a home launched before or not: a
  // session may run that no record names. Unknown, never "not launched" or "stopped", until a stop
  // or a start has settled it.
  if (s.unsettled) throw oatsError("E_SESSION_UNAVAILABLE", unsettledLaunchSaid(basename(s.home), s.unsettled.backend, s.unsettled.launchSent));
  if (s.session) return inspectProviderHome(s, wakeHold, io);
  // A home that will launch on a session provider says which: nothing was launched yet.
  if (s.planned) return { home: s.home, backend: s.planned.backend, present: false, state: "not-launched", running: false, waitingOnYou: null, wakeHold, session: sessionOf(s.planned), open: null };
  if (!s.target) return { home: s.home, backend: null, present: false, state: "not-launched", running: false, waitingOnYou: null, wakeHold };
  let observed;
  try { observed = inspectSessionTarget(s.target, io, { includeSize: true }); }
  // The tmux failure stays the cause: sessionServerGone judges it.
  catch (e) { throw Object.assign(oatsError("E_SESSION_UNAVAILABLE", `cannot inspect session: ${e.message}`), { cause: e }); }
  // Features session-inspect-running and waiting-on-you: beside `state`, whose enum is unchanged.
  // `running` is status's own liveness predicate over this observation, never a second reading.
  const running = harnessRunning(observed);
  return { home: s.home, ...observed, running, waitingOnYou: running ? liveWaiting(s.home) : null, wakeHold };
}
/** Whether an observed session runs a harness: present, and neither a
 *  fallback shell nor a dead pane. Only such a session can be waiting on a human. */
function harnessRunning(observed) { return observed?.present === true && observed.state !== "shell" && observed.state !== "stopped"; }

// (The receipt's own primitives are lib/session-receipt.mjs's, exported here as they were.)
export { RETIRE_BASELINE_VERSION, findRetirementBaseline, retirementBaselinePath, authorityMismatch, endpointAgrees, harnessRunning, providerHomeOf, providerMayWait, instanceSessionTarget, instancesRetirementRoot, isPlainObject, launchStateAgrees, missingSessionReceipt, readJsonOrUndefined, receiptHomeIdentity, receiptRecordsHome, recordsHerdr, refuseHerdrHome, runtimeAuthorityOf, tmuxEndpointAgrees };
