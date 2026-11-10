/** Process identity: what a lock record names its holder by, and how a recorded holder is judged.
 *  The start token of a pid (processStart, processStartToken), whether the process a record names
 *  can still act (processLiveness), this boot's identity (bootId, thisBoot) and the rule for a
 *  record taken in another boot (takenInAnotherBoot), with the lookup of the system tools they run
 *  (systemTool: `ps`, `sysctl`). The kernel reads all of them from here (lib/system-tools.mjs,
 *  lib/worktree-hooks.mjs, lib/session-seen.mjs), and so do this package's locks. Dependency-free. */
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// ---------- system tools: programs run from the system's own directories ----------

/** Where a system tool is looked for, in order. */
export const SYSTEM_TOOL_DIRS = Object.freeze(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/** The directories a system tool is looked for in → { dirs } | { reason }. SYSTEM_TOOL_DIRS, or for a
 *  test only, OATS_TEST_SYSTEM_TOOL_DIRS: absolute directories separated by `:`. A seam with any other
 *  value names no tool at all, never a PATH-like lookup. */
export function systemToolDirs() {
  const seam = process.env.OATS_TEST_SYSTEM_TOOL_DIRS;
  if (seam === undefined) return { dirs: SYSTEM_TOOL_DIRS };
  const dirs = seam.split(":");
  if (dirs.some((dir) => !isAbsolute(dir))) return { reason: `OATS_TEST_SYSTEM_TOOL_DIRS is ${JSON.stringify(seam)}, not absolute directories` };
  return { dirs };
}

/** `name` in the system directories (`dirs`, else systemToolDirs) → { file } (the first regular
 *  executable file, an absolute path) or { reason } (none, and where it looked). Nothing is run. */
export function systemTool(name, { dirs } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._+-]+$/.test(name) || name === "." || name === "..") return { reason: `${JSON.stringify(name)} is not a tool name` };
  if (dirs === undefined) {
    const where = systemToolDirs();
    if (where.reason) return { reason: where.reason };
    dirs = where.dirs;
  }
  for (const dir of dirs) {
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return { file };
    } catch { /* not here */ }
  }
  return { reason: `no executable ${name} in ${dirs.join(", ")}` };
}

// ---------- process identity: a pid is verified by its start time ----------

/** Where a start time is read: /proc when this host has procfs, else `ps`. The test seam
 *  OATS_TEST_PROCESS_START_PS (not a setting; a launch configuration cannot set it) takes the `ps`
 *  path on any host: `1` runs the system `ps`, an absolute path runs that file as `ps`, and any
 *  other value reads no start at all (psProgram). */
const readsProc = () => process.env.OATS_TEST_PROCESS_START_PS === undefined && existsSync("/proc/self/stat");
/** `ps` runs with a fixed environment, nothing inherited (runPs). Its PATH is the system directories only (SYSTEM_TOOL_DIRS),
 *  never the caller's: what `ps` reports is the identity a claim is held or taken over on, so the
 *  caller's PATH must not choose the program, and a caller whose PATH holds no `ps` reads the same
 *  start as any other. `lstart` is local time in the locale's format, and two readers with another
 *  TZ or LANG would otherwise read one live process's start differently, and take it for another. */
export const PS_ENV = Object.freeze({ PATH: SYSTEM_TOOL_DIRS.join(":"), LC_ALL: "C", TZ: "UTC" });
/** The `ps` a start is read with → { file, name } | { reason }: the system one, or the file the
 *  test seam names by absolute path, run directly (no shell). A seam that names neither is never a
 *  fallback to /proc or to a `ps` found on PATH; nor is a named file that cannot be run (readStart). */
function psProgram() {
  const seam = process.env.OATS_TEST_PROCESS_START_PS;
  if (seam === undefined || seam === "1") return { file: "ps", name: "ps" };
  if (isAbsolute(seam)) return { file: seam, name: `the ps OATS_TEST_PROCESS_START_PS names (${seam})` };
  return { reason: `OATS_TEST_PROCESS_START_PS is ${JSON.stringify(seam)}, neither 1 nor an absolute path` };
}

/** Whether `pid` exists, from the kernel itself: kill(pid, 0). ESRCH is gone; EPERM (another user's
 *  process) and success are "exists"; anything else is unknown. Never from how procfs or `ps`
 *  word an absence: macOS's `ps` answers a pid that does not exist with an error and exit 1, which
 *  says nothing a failing `ps` does not also say. */
function existence(pid) {
  try { process.kill(pid, 0); return { state: "exists" }; }
  catch (e) {
    if (e.code === "ESRCH") return { state: "gone" };
    if (e.code === "EPERM") return { state: "exists" };
    return { state: "unknown", reason: `kill(${pid}, 0) failed (${e.code || e.message})` };
  }
}

/** Run the system `ps` once: `ps -o <column>= … <selection>`, each column without its header.
 *  → { out } — its stdout as it was written, when it exited 0 and answered something;
 *  → { reason } — it could not be run, was ended, failed or answered nothing: one line saying which.
 *  The one way the kernel calls `ps` (awebai/oats#870, #882): the program (psProgram), the fixed
 *  environment (PS_ENV), the time it is given and how its answer is classified are decided here.
 *  `selection` is the rest of its arguments (`["-p", "<pid>"]`, `["-ax"]`). The environment is
 *  PS_ENV whoever calls: what `ps` answers under it is the same for every reader. `path`, when
 *  given, is the PATH the program is found on, in place of PS_ENV's and of nothing else in it: an
 *  explicit argument, never read from the caller's environment here. The start reader passes
 *  none, so the caller's PATH never chooses the program an identity is read with (#878). */
export function runPs(columns, selection, { path } = {}) {
  const ps = psProgram();
  if (ps.reason) return { reason: ps.reason };
  const argv = [...columns.flatMap((column) => ["-o", `${column}=`]), ...selection];
  const r = spawnSync(ps.file, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: path === undefined ? PS_ENV : { ...PS_ENV, PATH: path }, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error) return { reason: `${ps.name} could not be run (${r.error.code || r.error.message})` };
  const out = String(r.stdout ?? ""), err = String(r.stderr ?? "").trim();
  if (r.status === 0 && out.trim()) return { out };
  return { reason: `ps ${argv.join(" ")} answered ${r.status === null ? `signal ${r.signal}` : `exit ${r.status}`}${err ? `: ${err.split("\n")[0]}` : out.trim() ? " with output" : " with no output"}` };
}

/** The start of a pid that exists, and whether it is a zombie (it exited, or was killed, and its
 *  parent has not reaped it): one read gives both.
 *  Linux: /proc/<pid>/stat, field 22 (clock ticks since boot) and field 3 (its state: `Z`, or `X`,
 *  a process being removed). Elsewhere `ps -o lstart= -o stat=` (runPs): the start, then a state
 *  that begins with `Z` (procps `Z`, macOS `Z` and `Z+`).
 *  → { state: "alive", token, zombie? } | { state: "unknown", reason }. `zombie` is set only when
 *  it is true. A state that cannot be read makes no zombie, and the start is what it was before
 *  there was a second column: whatever `ps` prints as a state (`?` included) is only ever cut off
 *  the start, and a `ps` that answers the start alone gives the start.
 *  The token is what released kernels recorded, byte for byte (`proc:<ticks>`, `ps:<lstart>`): a
 *  claim, a tree record or a marker written by an older kernel names its live holder by it, and a
 *  reader that gave that holder another token would take it for a reused pid, which is gone. */
function readStart(pid) {
  if (readsProc()) {
    let stat;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
    catch (e) { return { state: "unknown", reason: `/proc/${pid}/stat could not be read (${e.code || e.message})` }; }
    // comm (field 2) is in parentheses and may hold spaces or parentheses itself.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19]; // field 22 overall: after pid, comm and the 19 before it
    if (!/^[0-9]+$/.test(start ?? "")) return { state: "unknown", reason: `/proc/${pid}/stat has no start time` };
    return { state: "alive", token: `proc:${start}`, ...(fields[0] === "Z" || fields[0] === "X" ? { zombie: true } : {}) };
  }
  const r = runPs(["lstart", "stat"], ["-p", String(pid)]);
  if (r.reason) return { state: "unknown", reason: r.reason };
  // `Thu Jan  1 00:00:00 2026 Ss`: the state is the last field, one word whatever it says, and the
  // start before it is taken whole, as `ps -o lstart=` alone prints it. A start ends with its year,
  // so a last field of digits only is the start's own: that `ps` answered no state.
  const out = r.out.trim();
  const column = /^(.*\S)\s+(\S+)$/s.exec(out);
  if (!column || /^[0-9]+$/.test(column[2])) return { state: "alive", token: `ps:${out}` };
  return { state: "alive", token: `ps:${column[1]}`, ...(column[2].startsWith("Z") ? { zombie: true } : {}) };
}

/** Whether `token` has a shape readStart writes: `proc:` and a count of clock ticks (64 bits: at
 *  most 20 digits), or `ps:` and a start as `ps -o lstart=` prints it under PS_ENV
 *  (`Thu Jan  1 00:00:00 2026`). The shape is said here, beside its writer, and nowhere else.
 *  It decides only what of a record may be SHOWN: a record is a file that others than its writer
 *  can write, and text that is not the kernel's enters an answer only as an id or a code. It is
 *  never a liveness decision: processLiveness compares the recorded string as it is, and a real
 *  token this does not know (a `ps` that prints a start otherwise) is shown as none, never read
 *  as gone. */
const START_TOKEN = /^(?:proc:[0-9]{1,20}|ps:[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})$/;
export const isStartToken = (token) => typeof token === "string" && START_TOKEN.test(token);

/** When `pid` started, read three ways apart (lessons/observation-must-not-harm-the-observer.md:
 *  "absent" never collapses with "unreadable"). One rule on every host: whether the pid exists is
 *  the kernel's answer (existence), and only a pid that exists has its start read.
 *  → { state: "alive", token, zombie? } — an opaque token for its start; two processes that held
 *      one pid at different times never share it, so a pid is only ever compared WITH its token;
 *  → { state: "gone" } — kill(pid, 0) answers ESRCH, before the read or (it exited in between)
 *      after a read that failed;
 *  → { state: "unknown", reason } — anything else: the pid exists and its start could not be read,
 *      or kill(pid, 0) failed otherwise. Every caller fails safe on it.
 *
 *  This answers WHOSE the pid is, and a zombie still holds its pid and its start: it is "alive"
 *  here, with `zombie: true` as a fact beside it. That is what a recorded process group needs
 *  (terminateRecordedGroup): while its leader is a zombie the group's id cannot be reused, so a
 *  zombie leader with the recorded start is the best proof there is that the group is still that
 *  run's, and its members are ended. Whether a process can still ACT is another question, and
 *  processLiveness answers it (awebai/oats#870). */
export function processStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "gone" };
  const before = existence(pid);
  if (before.state !== "exists") return before;
  const read = readStart(pid);
  if (read.state === "alive") return read;
  return existence(pid).state === "gone" ? { state: "gone" } : read;
}

/** The token of `processStart(pid)` when it is running, else null: for recording a process. A
 *  liveness decision never uses this, since null merges "gone" with "unknown" (processLiveness). */
export function processStartToken(pid) {
  const s = processStart(pid);
  return s.state === "alive" ? s.token : null;
}

/** Whether the COMMAND a record names (`{ pid, processStart }`) can still act:
 *  → { state: "alive" } — its pid runs with the recorded start;
 *  → { state: "gone", zombie? } — its pid does not run, or runs with another start (a reused pid),
 *    or is a zombie (`zombie: true`): it exited or was killed and its parent has not reaped it;
 *  → { state: "unknown", reason } — the start could not be read, or the record has none to
 *    compare while its pid runs. Every caller fails safe on it: nothing is taken over, rolled back,
 *    retired or signalled, and the refusal names the way out.
 *
 *  A zombie is gone here (awebai/oats#870), though processStart still reads its pid and start. It
 *  will never run again, and a parent that never waits for it would otherwise keep its claim or
 *  marker refused for ever, with the advice to wait for it. Taking over from it is as safe as from
 *  a holder that was killed and reaped: a process's children are re-parented when it exits, not
 *  when it is reaped, so what a zombie leaves behind is exactly what that holder leaves: the steps
 *  it recorded, which each takeover ends (lib/claim.mjs `endHolderStep`; the hook group of a tree
 *  record or a spawn's marker), and for a retire its hook children (awebai/oats#865). The zombie
 *  adds nothing to that; it only delays the takeover until a reap that may never come.
 *  It is decided before the start is compared: a pid that is a zombie now is not a running
 *  holder whichever start the record names (it is that holder, or the pid was reused), and so
 *  neither when the record names none.
 *
 *  WHOM THIS MAY BE ASKED ABOUT: the process of an `oats` command itself, which is what every
 *  record read with it names (a claim's holder, the adder of a tree record, a spawn's `inProgress`,
 *  a self-retire's completion). That is what makes "a zombie cannot act" true. On Linux a process
 *  whose main thread has exited while other threads run also reads `Z` in /proc/<pid>/stat, and
 *  it still acts; Node exits as a whole, so it does not arise for those records. Never ask this
 *  about a hook's or a harness's pid: for a process that is not the kernel's own, a `Z` does not
 *  say it is finished. (A recorded group's leader is asked through processStart, not through this.) */
export function processLiveness(record) {
  const pid = record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "gone" };
  const s = processStart(pid);
  if (s.state !== "alive") return s;
  if (s.zombie) return { state: "gone", zombie: true };
  if (typeof record.processStart !== "string" || !record.processStart) return { state: "unknown", reason: `pid ${pid} runs, and the record names no start time to compare it with` };
  return s.token === record.processStart ? { state: "alive" } : { state: "gone" };
}

// ---------- the boot a record was taken in ----------

/** What says this process runs in a container: a file each runtime puts in its containers, or the
 *  variable Kubernetes sets in every pod. Docker writes `/.dockerenv`, Podman `/run/.containerenv`. */
const CONTAINER_FILES = ["/.dockerenv", "/run/.containerenv"];
const inContainer = (exists, env) => CONTAINER_FILES.some((file) => exists(file)) || Boolean(env.KUBERNETES_SERVICE_HOST);

/** When PID 1 started, as this process sees PID 1: field 22 of `/proc/1/stat`, in clock ticks after
 *  the kernel's boot, as the digits the kernel printed; null when the file cannot be read or does
 *  not hold it. The fields are counted after the last ")": the name (field 2) may hold spaces and
 *  parentheses. */
function initStart(read) {
  try {
    const stat = read("/proc/1/stat"), named = stat.lastIndexOf(")");
    const start = named < 0 ? undefined : stat.slice(named + 1).trim().split(/\s+/)[19];
    return typeof start === "string" && /^\d+$/.test(start) ? start : null;
  } catch { return null; }
}

/** macOS's boot time, from the system's sysctl (systemTool), never one the caller's PATH names: a
 *  PATH without /usr/sbin, or with another sysctl first, must not change or lose the boot id. */
function systemSysctl() {
  const tool = systemTool("sysctl");
  if (!tool.file) throw new Error(tool.reason);
  return execFileSync(tool.file, ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
}
/** This boot's identity, or null where the kernel cannot read one. A boot is what ends every
 *  process the kernel may have recorded: the sessions, their terminal server, a sweep.
 *   - macOS: the boot time (`sysctl -n kern.boottime`, its `sec`/`usec`).
 *   - Linux: the kernel's boot id (`/proc/sys/kernel/random/boot_id`).
 *   - Linux in a container (inContainer): `<boot id>:<PID 1's start>`. A container shares its
 *     host's kernel and so its boot id, which outlives a stop and start of the container; its PID 1
 *     does not. PID 1 starts once per run of the container and ends every process of the run when
 *     it ends, so its start is the same for every process of one run and another in the next; the
 *     boot id keeps a start apart from the same number of ticks after another kernel boot. When
 *     PID 1's start cannot be read there, the boot id alone: the sweep then counts a home's starts
 *     across the runs and applies the in-boot clause across them, so it starts less, never more.
 *  PID 1's start is read only in a container. A process in a PID namespace of its own on a host (a
 *  command a harness runs in a sandbox) reads that namespace's PID 1, which is not the machine's,
 *  and it is on the host's boot all the same.
 *  Each is read from the kernel without privileges and written nowhere. */
export function bootId({ platform = process.platform, read = (p) => readFileSync(p, "utf8"), exists = existsSync, env = process.env, sysctl = systemSysctl } = {}) {
  try {
    if (platform === "linux") {
      const id = read("/proc/sys/kernel/random/boot_id").trim();
      if (!id) return null;
      const start = inContainer(exists, env) ? initStart(read) : null;
      return start === null ? id : `${id}:${start}`;
    }
    if (platform === "darwin") { const m = /sec = (\d+), usec = (\d+)/.exec(sysctl()); return m ? `${m[1]}.${m[2]}` : null; }
  } catch { /* unknown */ }
  return null;
}
let processBoot;
/** bootId, read once per process: a process never outlives its boot. */
export const thisBoot = () => (processBoot === undefined ? (processBoot = bootId()) : processBoot);
/** Whether the lock record `holder` (the sweep's lock, a cache write lock: lib/remote.mjs) was taken
 *  in another boot than `boot`: its holder is gone then, whatever its pid reads as. A boot ends
 *  every process, and a pid and a start counted from the boot can both come again in the next (in a
 *  container, a boot is one run: bootId). Without a boot id on either side the process alone is
 *  judged. */
export const takenInAnotherBoot = (boot) => (holder) => Boolean(boot) && typeof holder.bootId === "string" && holder.bootId !== "" && holder.bootId !== boot;
