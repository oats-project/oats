// Package-owned offline diagnosis. No writable DB/store, lock acquisition,
// manager, repair or capture; warnings never publish new run evidence.
import { homedir, hostname, platform as hostPlatform } from "node:os";
import { join } from "node:path";
import { readCaptureStatus } from "./capture-status.mjs";
import { readCurrentIssueBacklog } from "./capture-issues.mjs";
import { emptyFailureBacklog } from "./capture-failures.mjs";
import { captureInstallation } from "./capture-health-installation.mjs";
import { readCaptureLockOwner, shellQuote } from "./capture-lock.mjs";
import { holderLiveness } from "./lock-holder.mjs";

const setAsideRemedy = (command, root) => `Restore the captured prefix and run ${command} capture --retry-set-aside; or add the source to ${root}/ignore (later turns from that session will not be captured). Retry revalidates; it never authorizes a changed prefix.`;
export const SET_ASIDE_REMEDY = setAsideRemedy("turn-record", "<root>");
// Retry re-reads an unchanged oversized record and sets it aside again: only an
// edited source or an ignore of the whole input moves past it.
const oversizedRemedy = (command, root) => `Edit the source so no record exceeds 8 MiB, leaving its captured prefix unchanged, then run ${command} capture --retry-set-aside; or add the whole input to ${root}/ignore, which discards the whole input, its records after the oversized one included, and later turns from that session.`;
// The one rule for remedy wording: the kernel's own entry points say `oats`,
// the standalone package says `turn-record`. Each entry point states which it is.
export const captureRemedyCommand = viaKernel => viaKernel ? "oats" : "turn-record";
const emptyBacklog = () => ({ pending: false, setAsideCount: 0, setAside: [], truncated: false, ...emptyFailureBacklog() });
const noHistory = () => ({ lastRun: null, lastSuccess: null, lastFailure: null, lastProgressAt: null, backlog: emptyBacklog() });
const time = value => typeof value === "string" ? Date.parse(value) : NaN;

function deadExecution(root, run, host, liveness, now) {
  // A receipt has no host field. Never signal-probe its PID without matching
  // local registration. Both owner and worker must be dead: a live supervisor
  // can still replace a child and finish this same pass. A process that runs or
  // cannot be read (holderLiveness judges each record), and changed/foreign/hostless
  // lock records, supply no death evidence.
  const owner = readCaptureLockOwner(root), worker = owner?.worker;
  if (owner?.host !== host || worker?.host !== host || worker.pid !== run.pid ||
      !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid === worker.pid ||
      typeof owner.nonce !== "string" || !owner.nonce || typeof worker.nonce !== "string" || !worker.nonce ||
      !(time(owner.startedAt) <= time(run.startedAt)) || !(time(worker.startedAt) >= time(owner.startedAt)) ||
      !(time(worker.startedAt) <= now)) return false;
  if (liveness(owner) !== "dead" || liveness(worker) !== "dead") return false;
  return JSON.stringify(readCaptureLockOwner(root)) === JSON.stringify(owner) &&
    JSON.stringify(readCaptureStatus(root, { now })?.lastRun) === JSON.stringify(run);
}

// Optional caller/clock/liveness context is for isolated readers and fixtures;
// no CLI option selects an alternate reader, executable or resource policy.
export function captureHealth(root, options = {}) { return diagnose(root, options, captureRemedyCommand(false)); }

// Private kernel presentation: choose only authored command literals, before
// interpolating paths/receipt data. Never replace words in completed messages.
export function captureHealthForDoctor(root, options = {}) { return diagnose(root, options, captureRemedyCommand(true)); }

function diagnose(root, { home = homedir(), platform = hostPlatform(), now = Date.now(),
  host = hostname(), liveness = holderLiveness } = {}, command) {
  const began = performance.now();
  const check = () => { if (performance.now() - began > 15000) throw new Error("capture health reader deadline exceeded"); };
  let installation;
  try { installation = captureInstallation(root, { home, platform, check }); }
  catch (error) { throw new Error(`Capture installation evidence is unknown: ${error.message}`, { cause: error }); }
  const rows = [], path = join(root, "capture-status.json");
  let status = noHistory();
  const result = backlog => ({ schemaVersion: 1, status: rows.length ? "warning" : "ok", rows,
    lastRun: status.lastRun, lastSuccess: status.lastSuccess, lastFailure: status.lastFailure, backlog });
  if (!installation.installed) { check(); return result(emptyBacklog()); }

  const setup = `Run ${command} setup --root ${shellQuote(root)} with your existing --owner to inspect and refresh installation.`;
  try {
    const saved = readCaptureStatus(root, { now });
    if (saved) status = saved;
    else rows.push({ code: "capture-status-missing", message: `Capture status is missing at ${path}. ${setup}` });
  } catch (error) { rows.push({ code: "capture-status-invalid", message: `Cannot read capture status at ${path}: ${error.message}. ${setup}` }); }
  check();
  let backlog;
  try {
    backlog = readCurrentIssueBacklog(root);
    if (!backlog && (status.backlog.setAsideCount || status.backlog.failedCount))
      throw new Error("capture.db is missing but the last command reported active capture issues");
  } catch (error) { throw new Error(`Cannot read current capture issues at ${join(root, "index", "capture.db")}: ${error.message}`, { cause: error }); }
  check(); backlog ??= emptyBacklog();
  if (backlog.setAsideCount) {
    // Remedies follow each listed entry's reason. Reasons beyond the bounded
    // sample are unknown here, so a truncated list says so rather than guess.
    const oversized = backlog.setAside.filter(entry => entry.reason === "record-too-large").length;
    const others = backlog.setAsideCount - oversized, general = setAsideRemedy(command, root);
    const message = !oversized ? general + (backlog.truncated ? ` Unlisted entries: see each entry's reason; record-too-large entries need: ${oversizedRemedy(command, root)}` : "") :
      `${oversized} listed as record-too-large: ${oversizedRemedy(command, root)}` + (!others ? "" : backlog.truncated ?
        ` The other ${others}, including unlisted entries: see each entry's reason; record-too-large entries need the edit-or-ignore remedy above. Otherwise: ${general}` :
        ` The other ${others}: ${general}`);
    rows.push({ code: "capture-input-set-aside", message: `${backlog.setAsideCount} capture inputs set aside. ${message}` });
  }

  const failures = [];
  if (backlog.failedCount) failures.push(`${backlog.failedCount} capture stream units failed. Deferred retries remain unresolved; offsets name unit starts, not exact failing frames.`);
  const successAt = time(status.lastSuccess?.finishedAt);
  const failure = status.lastFailure;
  if (failure && (!status.lastSuccess || time(failure.finishedAt) > successAt))
    failures.push(`Last recorded failure ${failure.finishedAt} (${failure.reason}) is newer than any recorded success.`);
  const run = status.lastRun;
  if (run?.outcome === "failed" && (!status.lastSuccess || time(run.finishedAt) > successAt) && run.id !== failure?.id)
    failures.push(`Last run ${run.id} failed at ${run.finishedAt} (${run.reason}).`);
  if (run?.outcome === "running") {
    if (now - time(run.startedAt) > status.policy.deadlineSeconds * 1000)
      failures.push(`Run ${run.id} has no final receipt after its ${status.policy.deadlineSeconds}s deadline. This does not identify why execution stopped or prove that it stopped.`);
    else if (deadExecution(root, run, host, liveness, now))
      failures.push(`Run ${run.id} is unfinished and its matching local registered supervisor and worker are no longer alive.`);
  }
  if (failures.length) rows.push({ code: "capture-pass-failed", message:
    `${failures.join(" ")} Inspect ${command} capture --health --json and the retained receipt; counters are durably confirmed accounting, not all physical writes. A sleeping or off-host execution can leave old observations; no process is killed or lock reclaimed by health.` });
  if (!status.lastSuccess || now - successAt > 3600 * 1000) rows.push({ code: "capture-success-stale", message:
    `Last successful capture: ${status.lastSuccess?.finishedAt ?? "none recorded"}; last committed progress: ${status.lastProgressAt ?? "none recorded"}. No success within 3600s. This may reflect a sleeping machine or off-host execution; recent progress is not full success. ${setup}` });
  if (installation.legacy) rows.push({ code: "capture-setup-required", message:
    `An owned legacy continuous-watch definition remains. ${setup} Definition files do not prove manager registration or enabled scheduling; health invokes no manager.` });
  if (installation.earlierHooks?.length) rows.push({ code: "capture-setup-required", message:
    `Capture hooks in ${installation.earlierHooks.join(", ")} use a form an earlier release's setup wrote, not this release's hook entry. ${setup}` });
  // Activation is "not verified", never "not running": a crash after a
  // verified activation can leave the marker until the next setup clears it.
  const retry = `Run ${command} setup --root ${shellQuote(root)} with your existing --owner`;
  if (installation.pending) rows.push({ code: "capture-service-pending", message: installation.pending.stale
    ? `The pending-activation marker ${installation.pending.path} is stale: no setup-marked capture service definition remains. ${retry}; it removes the stale marker and activates nothing on its account.`
    : `Setup started activating the periodic capture service and did not verify it (marker ${installation.pending.path}): capture hooks may be installed, but the periodic schedule is not verified. ${retry} to retry the activation.` });
  check(); return result(backlog);
}
