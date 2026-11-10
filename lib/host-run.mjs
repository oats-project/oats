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
 *    another boot (in a container, another run), is taken over at once; a holder that runs, and a
 *    lock that cannot be judged, are E_HOST_RUN_BUSY, `details` `{ lock, found }`.
 *  - `plan` says what a run would refuse, the scopes it would tick (the host schedule registry) and
 *    what its sweep would do (lib/session-resume.mjs, its own plan), and changes nothing.
 *  The answer's shape is a contract (docs/desktop-cli-api.md). Dependency-free. */
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, dirLockHeld, stuckLockRemedy } from "./dir-lock.mjs";
import { oatsError } from "./errors.mjs";
import { hostUnitStatus } from "./schedule-host.mjs";
import { readRegistry } from "./schedule.mjs";
import { resumeSessions } from "./session-resume.mjs";
import { bootId, takenInAnotherBoot } from "./session-seen.mjs";

export const HOST_RUN_SCHEMA = 1;
/** What a run and a plan say when the host schedule registry lists no scope. */
export const NO_SCOPE_SAID = "no scope is registered, so nothing is ticked: register a deployment with oats schedule host install --register-only --dir <deployment>";

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

/** What refuses a run before it takes its lock, in the order a run meets them → kernel errors. The
 *  host timer is asked only outside an instance session; `unit` is what it answered, or null. */
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
 *  the lock's included, `scopes` the registered scopes it would tick, `sweep` the resume sweep's own plan. Read only. */
export async function hostRunPlan({ env = process.env, boot = bootId(), hostStatus = hostUnitStatus } = {}) {
  const refuse = refusalsBeforeLock({ env, hostStatus }), unit = hostStatus();
  // The lock as a run would find it, read where the run takes it and not taken (dirLockHeld).
  const path = hostRunLockPath(), held = dirLockHeld(path, { holderGone: takenInAnotherBoot(boot) });
  const refusals = [refuse.inInstance, refuse.timer(unit), held && hostRunBusy(path, held.why, held.found)].filter(Boolean).map((e) => ({ code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }));
  return { schemaVersion: HOST_RUN_SCHEMA, plan: true, refusals, warnings: inactiveUnitWarnings(unit), scopes: readRegistry().workspaces, sweep: await resumeSessions({ plan: true, env }) };
}

/** `oats host run`: refuses (above), then runs until the host stops it. */
export async function hostRun({ env = process.env, boot = bootId(), hostStatus = hostUnitStatus } = {}) {
  const refuse = refusalsBeforeLock({ env, hostStatus });
  if (refuse.inInstance) throw refuse.inInstance;
  const timer = refuse.timer(hostStatus());
  if (timer) throw timer;
  const release = acquireHostRunLock({ boot });
  release();
}
