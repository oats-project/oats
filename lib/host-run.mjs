/** `oats host run` (oats-project/oats#1789): the kernel's periodic work in one foreground process,
 *  for a host where no timer can run it (a container, a machine without launchd or a systemd user
 *  manager). Every `oats` command is short-lived and agents sit under a daemonised tmux server, so
 *  without it nothing there runs the resume sweep at start or the schedule tick each minute, and
 *  nothing stops the agents in order when the host stops.
 *
 *  - Refused before any effect: inside an instance session (OATS_INSTANCE_HOME set), E_USAGE; while
 *    the host timer is active (lib/schedule-host.mjs hostUnitStatus), E_HOST_RUN_TIMER_ACTIVE: two
 *    tickers would run. Unit files that are installed and not active are a warning. Nothing asks
 *    whether this is a container: the command is as right on a machine without a user manager.
 *  - One host run per machine: the lock `host-run/lock` under OATS_HOME_DIR (default ~/.oats), taken
 *    as the resume sweep takes its own (lib/dir-lock.mjs acquireDirLock): a claim that names its
 *    holder by pid, process start and boot id. A lock whose holder is gone, or that was taken in
 *    another kernel boot, is taken over at once; a holder that runs, and a
 *    lock that cannot be judged, are E_HOST_RUN_BUSY, `details` `{ lock, found }`.
 *  - A run, in order: the lock; the resume sweep once (`oats session resume`); then, at second 0 of
 *    each minute, `oats schedule tick --host` when the host schedule registry lists a scope (with
 *    none it ticks nothing and says so), and a listing of every deployment's instances, which
 *    records what runs for the next start's sweep. Each is an `oats` child, so this process's
 *    loop stays free for the signal. A minute whose tick still runs is skipped; a minute missed is
 *    never replayed (the host timer's own rule).
 *  - SIGTERM or SIGINT stops it (hostRun): ticking first, then every running home, so that the
 *    next start resumes them; then it answers and exits 0.
 *  - `plan` says what a run would refuse, the scopes it would tick (the host schedule registry) and
 *    what its sweep would do (lib/session-resume.mjs, its own plan), and changes nothing.
 *  The answers' shapes and the two codes are a contract (docs/desktop-cli-api.md). */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDirLock, dirLockHeld, stuckLockRemedy } from "./dir-lock.mjs";
import { oatsError } from "./errors.mjs";
import { hostUnitStatus } from "./schedule-host.mjs";
import { readRegistry } from "./schedule.mjs";
import { kernelAnswer, resumeSessions } from "./session-resume.mjs";
import { hostRunWork } from "./host-run-work.mjs";
import { OUTCOME } from "./session-resume-contract.mjs";
import { bootId, takenInAnotherBoot } from "./session-seen.mjs";

export const HOST_RUN_SCHEMA = 1;
/** What a run and a plan say when the host schedule registry lists no scope. */
export const NO_SCOPE_SAID = "no scope is registered, so nothing is ticked: register a deployment with oats schedule host install --register-only --dir <deployment>";

/** The signals that stop a run: what a container runtime sends, and Ctrl-C. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT"];
const oatsHomeDir = () => process.env.OATS_HOME_DIR || join(homedir(), ".oats");
export const hostRunLockPath = () => join(oatsHomeDir(), "host-run", "lock");

/** E_HOST_RUN_BUSY for the lock `path`, found as lib/dir-lock.mjs says it (`why`, `found`): a host
 *  run that runs, or a lock that needs a person, with what to do about it. */
function hostRunBusy(path, why, found) {
  const said = found === "running" ? `another oats host run on this machine holds ${path} (${why})` : `the host run lock ${path} cannot be taken (${why}); ${stuckLockRemedy(path, found, "oats host run")}`;
  return Object.assign(oatsError("E_HOST_RUN_BUSY", `${said}; nothing was started`), { details: { lock: path, found } });
}
/** Take the machine's host run lock → its release function. Its record also names the boot it was
 *  taken in (lib/session-seen.mjs bootId, takenInAnotherBoot), as the resume sweep's does. */
export function acquireHostRunLock({ boot = bootId() } = {}) {
  const path = hostRunLockPath();
  return acquireDirLock(path, { bootId: boot }, { busy: (why, { found }) => hostRunBusy(path, why, found), holderGone: takenInAnotherBoot(boot) });
}

/** What refuses a run before it takes its lock, in the order a run meets them: `inInstance`, the
 *  refusal inside an instance session, or null; `timer(unit)`, the refusal for what the host timer
 *  answered (hostUnitStatus), or null. A run asks the timer only once it is not refused as an instance. */
function refusalsBeforeLock({ env, hostStatus }) {
  const home = env.OATS_INSTANCE_HOME;
  const inInstance = home ? oatsError("E_USAGE", `oats host run runs as the host, never inside an instance session: OATS_INSTANCE_HOME is set (${home}); nothing was started`) : null;
  return { inInstance, timer: (unit) => (unit.active ? Object.assign(oatsError("E_HOST_RUN_TIMER_ACTIVE", `the host timer is active (${unit.unit}) and already runs oats schedule tick --host every minute; remove it (oats schedule host uninstall) before oats host run; nothing was started`), { details: { unit: unit.unit } }) : null) };
}
/** The warning for unit files that are installed while the timer is not active, or none. */
const inactiveUnitWarnings = (unit) => (unit.installed && !unit.active
  ? [`the host timer's unit files are installed but not active (${unit.unit}): oats host run ticks in its place; remove them (oats schedule host uninstall) so that the timer cannot start beside it`] : []);

/** `oats host run --plan` → `{ schemaVersion, plan: true, refusals, warnings, scopes, sweep }`:
 *  `refusals` every refusal a run would meet now (`{ code, message, details? }`, in a run's order),
 *  the lock's included, `scopes` the registered scopes it would tick, `sweep` the resume sweep's
 *  own plan. Read only. */
export async function hostRunPlan({ env = process.env, boot = bootId(), hostStatus = hostUnitStatus } = {}) {
  const refuse = refusalsBeforeLock({ env, hostStatus }), unit = hostStatus();
  // The lock as a run would find it, read where the run takes it and not taken (dirLockHeld).
  const path = hostRunLockPath(), held = dirLockHeld(path, { holderGone: takenInAnotherBoot(boot) });
  const refusals = [refuse.inInstance, refuse.timer(unit), held && hostRunBusy(path, held.why, held.found)].filter(Boolean).map((e) => ({ code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }));
  return { schemaVersion: HOST_RUN_SCHEMA, plan: true, refusals, warnings: inactiveUnitWarnings(unit), scopes: readRegistry().workspaces, sweep: await resumeSessions({ plan: true, env }) };
}

const MINUTE = 60_000;
/** How long a stopped home's harness is given when `--stop-grace` says nothing: the stop's own default. */
const STOP_GRACE_MS = 20_000;
const STOP_CHILD = fileURLToPath(new URL("./host-stop-child.mjs", import.meta.url));
/** A timer that fires this long before its minute, or less, is early: nothing runs then. */
const EARLY_MS = 1000;
const plural = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
/** A child's failure as the run says it. */
const failed = (answer) => `(${answer?.error?.code ?? "E_HOST_RUN_FAILED"}): ${answer?.error?.message ?? "no answer"}`;
/** The sweep's rows by outcome, in the order they first appear: `2 resumed, 1 skipped`. */
function sweepSaid(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  return counts.size ? [...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ") : "nothing to resume";
}

/** `oats host run`: refuses (above), then runs until SIGTERM or SIGINT →
 *  `{ schemaVersion, plan: false, signal, warnings, sweep, ticks, stopped }`: `sweep` the resume
 *  sweep's answer, or `{ error: { code, message } }`; `ticks` the minutes counted (`run`,
 *  `skipped` while the tick before still ran, `failed`, `noScope` with no scope registered);
 *  `stopped` one row per home that ran when it stopped, in the listing's order (stopHome).
 *
 *  On the signal, in this order: no minute is armed any more; a tick or a sweep that runs is
 *  given 10 s to finish, then new admissions are fenced and owned children are cancelled
 *  within a further 5 s (a tick's wake job may start a home, so owned work ends before any
 *  home is stopped); one bounded listing; then every running home is stopped, side by side, each by a child of its
 *  own (lib/host-stop-child.mjs: the stop `oats session restart` and a retire use, its record
 *  written first and asking for a resume, the harness given `stopGraceMs` and never escalated).
 *  The next start's sweep resumes those homes.
 *
 *  `stopHome(home, graceMs)` → Promise of `{ ok: true, home, stopped, alreadyIdle, state }` or
 *  `{ ok: false, home, code, message, stillRunning }`, which never rejects.
 *  `kernel` is `{ execPath, bin }`, how an `oats` child is run. The other options are the process
 *  boundary, for the tests: `run(argv)` → Promise of a child's JSON answer, which never rejects;
 *  `now()` and `timer(fn, ms)` → its cancel; `onSignal(handler)` → the function that stops
 *  listening; `scopes()` the registered scopes; `say(line)` one line of progress. */
export async function hostRun({
  kernel, env = process.env, boot = bootId(), hostStatus = hostUnitStatus,
  scopes = () => readRegistry().workspaces,
  run,
  stopGraceMs = STOP_GRACE_MS,
  stopHome = async (home, graceMs) => {
    const answer = await kernelAnswer({ execPath: kernel.execPath, bin: STOP_CHILD, env }, [home, String(graceMs)], { code: "E_SESSION_STOP_FAILED", what: "the stop" });
    return answer.error ? { ok: false, home, code: answer.error.code, message: answer.error.message, stillRunning: null } : answer;
  },
  now = Date.now,
  timer = (fn, ms) => { const armed = setTimeout(fn, ms); return () => clearTimeout(armed); },
  onSignal = (handler) => {
    for (const signal of STOP_SIGNALS) process.on(signal, handler);
    return () => { for (const signal of STOP_SIGNALS) process.off(signal, handler); };
  },
  say = (line) => { process.stderr.write(`oats host run: ${line}\n`); },
} = {}) {
  const refuse = refusalsBeforeLock({ env, hostStatus });
  if (refuse.inInstance) throw refuse.inInstance;
  const unit = hostStatus(), active = refuse.timer(unit);
  if (active) throw active;
  const release = acquireHostRunLock({ boot });
  let signal = null, disarm = null, stopListening = () => {}, work = null, draining = null;
  try {
    work = run ? null : hostRunWork({ kernel, env, say });
    const execute = run ?? work.run;
    const warnings = inactiveUnitWarnings(unit);
    const stopRequested = new Promise((requested) => {
      // The first signal ends the ticking at once: no minute is armed after it. A later one changes nothing.
      stopListening = onSignal((received) => {
        if (signal) return;
        signal = received;
        disarm?.();
        // Start the grace clock even while the initial sweep is awaited.
        draining = work?.drain();
        requested();
      });
    });
    say(`started (pid ${process.pid}); it holds ${hostRunLockPath()}`);
    for (const warning of warnings) say(`warning: ${warning}`);

    // The sweep, once: a home lost while this runs is a crash, and the sweep's bound is per boot.
    const swept = await execute(["session", "resume", "--json"]);
    const sweep = swept?.ok === true ? swept.result : { error: { code: swept?.error?.code ?? "E_HOST_RUN_FAILED", message: swept?.error?.message ?? "no answer" } };
    say(swept?.ok === true ? `resume sweep: ${sweepSaid(sweep.rows ?? [])}` : `resume sweep failed ${failed(swept)}`);

    // The minutes. Each is armed from the clock as it reads then, for second 0 of the next one: a
    // minute missed while this process did not run is never armed again.
    const ticks = { run: 0, skipped: 0, failed: 0, noScope: 0 };
    let ticking = null, listing = null, ticked;
    const list = (options) => execute(["session", "resume", "--plan", "--json"], options);
    const arm = () => { disarm = timer(minute, MINUTE - (now() % MINUTE)); };
    const minute = () => {
      if (signal) return;
      // Early: a tick started now would evaluate the minute before (it reads its own start).
      if (now() % MINUTE >= MINUTE - EARLY_MS) return arm();
      let registered;
      try { registered = scopes(); } catch (e) { registered = null; ticks.failed += 1; say(`tick failed (${e?.code ?? "E_HOST_RUN_FAILED"}): ${e?.message ?? e}`); }
      if (registered && registered.join("\n") !== ticked) {
        ticked = registered.join("\n");
        say(registered.length ? `ticking ${plural(registered.length, "scope")} each minute: ${registered.join(", ")}` : NO_SCOPE_SAID);
      }
      if (registered && !registered.length) ticks.noScope += 1;
      else if (registered && ticking) { ticks.skipped += 1; say("tick skipped: the tick of the minute before still runs"); }
      else if (registered) {
        ticks.run += 1;
        ticking = execute(["schedule", "tick", "--host", "--json"]).then((answer) => {
          ticking = null;
          if (answer?.ok !== true) { ticks.failed += 1; say(`tick failed ${failed(answer)}`); }
        });
      }
      // The listing each minute writes what the sweep of the next start needs: that each running
      // home was seen running (lib/session-seen.mjs recordSeen, by the sweep's own read of every
      // deployment, which its plan does and nothing else).
      listing ??= list().then((answer) => {
        listing = null;
        if (answer?.ok !== true) say(`listing failed ${failed(answer)}`);
      });
      arm();
    };
    if (!signal) arm();
    await stopRequested;

    // Ticking has ended. The signal started the bounded owned-work drain even
    // when it arrived during the initial sweep. No launch may race agent stops.
    say(`${signal}: ticking ended`);
    await draining;
    await Promise.all([ticking, listing]);
    const last = await list({ timeoutMs: 3000 });
    if (last?.ok !== true) say(`listing failed ${failed(last)}: no instance is stopped`);
    const homes = last?.ok === true ? (last.result?.rows ?? []).filter((row) => row.outcome === OUTCOME.ALREADY_RUNNING && typeof row.home === "string").map((row) => row.home) : [];
    if (homes.length) say(`stopping ${plural(homes.length, "running instance")}, each given ${stopGraceMs / 1000} s`);
    // Side by side: each stop waits for its own harness, and the host's patience is one span for all.
    const stopped = await Promise.all(homes.map(async (home) => {
      const row = await stopHome(home, stopGraceMs);
      say(row.ok ? (row.stopped ? `stopped ${home}` : `${home} was already idle`) : `could not stop ${home} (${row.code}): ${row.message}`);
      return row;
    }));
    say("ended");
    return { schemaVersion: HOST_RUN_SCHEMA, plan: false, signal, warnings, sweep, ticks, stopped };
  } finally {
    disarm?.();
    stopListening();
    try { await work?.close(); }
    finally { if (!work || work.quiescent) release(); }
  }
}
