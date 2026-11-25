// Whether a bb thread's harness is still loaded on this host: asked of the processes
// themselves, never taken from bb's word (contract r23, A13(1) and A14).
//
// bb gives a thread's harness process, and everything that harness starts, the variable
// BB_THREAD_ID=<the thread's id> (its own context variable; the catalog pi a bridge worker
// starts to list models has none). The variable alone does not say the harness lives: a
// command the agent started and left running (a dev server, a watcher, a `sleep`) carries
// it too, and outlives a harness that died. Counted, it would keep a thread in `error`
// reading as present for good, and every input to it would then go past the kernel's
// resume cap. So "the thread's harness lives" is: some process of this host carries that
// variable with that id AND is the harness itself, by its name: `pi` for a thread of bb's
// pi provider, `claude` for one of its claude-code provider. Seen at bb-app 0.50.1: pi
// runs as a process named `pi` (it sets its own title: its command line is that one
// word), and Claude Code as `claude` (argv[0] `<dir>/claude`); the name is looked for in
// the process's name and in the first word of its command line, and in the second where
// the first is an interpreter (a harness that is a script and sets no title).
//
// The provider reads this where the operating system shows a process's environment to the
// user that owns it: Linux's /proc. bb's server and this provider run as one user (the
// provider's data directory default rests on the same), so the thread's processes are
// readable; a process of another user is not, and is not counted.
//
// Two questions are asked of the same look. Whether a thread in `error` still has its
// harness (above): any harness-named process that carries the thread's id. And whether a
// thread at rest RUNS in a home (contract r25, A16; the release lane's condition): the
// same process, whose working directory is also that home. There a false "it runs" is the
// dangerous answer (the kernel would take a home stopped with the host for one that came
// back, and send it no resume), so only the home's own harness counts: never a process
// that merely carries the id, and never a harness that works somewhere else. And only a
// harness bb itself started for the thread: an agent can start a `pi` or a `claude` of its
// own in its home and leave it running detached, with the id it inherited, and that one
// outlives a stop of the thread. bb's own is told from it by its parent (seen at bb-app
// 0.50.1, pinned by the contract tests): bb's host daemon runs one process per thread,
// `node …/bb-app/host-daemon/dist/bb-provider-bridge-worker.mjs <artifact> provider-<bb's
// provider id> <data dir>`, and the thread's harness is its direct child. A detached
// process's parent is whatever adopted it (init, a subreaper), and one the agent started
// and did not detach is a child of a shell under the harness. The worker's own command
// line and environment do not name the thread: the thread is named by the harness's
// environment, and the worker by its file name and its provider. Those are names of
// bb-app's own layout, not of its CLI. A bb that moves them is another version than the
// provider's pin: there a loaded harness is one "bb's known runner did not start", which
// reads null (it cannot be told), never true (UNRECOGNISED, below; lib/inspect.mjs).
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fail } from "./errors.mjs";
import { BB_PROVIDER } from "./mode.mjs";
import { samePath } from "./threads.mjs";

/** What `runsIn` answers where a harness is in the home, by its name, the thread's id and
 *  its working directory, and what started it can be read and is not bb's runner for the
 *  thread's provider. Which of two things that is depends on bb's version, which this
 *  module does not read (lib/inspect.mjs does): at the version the provider is pinned to,
 *  the runner's command line is known (the contract tests pin it), so the process is one
 *  the agent started; at another version bb may have moved its runner, and it cannot be told. */
export const UNRECOGNISED = Symbol("a harness in the home that bb's known runner did not start");

const VARIABLE = "BB_THREAD_ID=";
// The file bb-app's host daemon runs as a thread's runner, and how its command line names
// the provider it runs.
const RUNNER_FILE = "bb-provider-bridge-worker.mjs";
const RUNNER_PROVIDER = /^provider-(.+)$/;
/** The harness's process name, by bb's provider id (a thread row's `providerId`). */
const HARNESS_PROCESS = Object.freeze({ [BB_PROVIDER.pi]: "pi", [BB_PROVIDER.claude]: "claude" });
// What a person does where the look cannot be made (macOS: oats-bb#22). The look is asked of
// a thread at rest too, where its failure reads as `running: null`; this is shown only for a
// thread in `error`, and while the thread stays so the kernel can neither start the home nor
// send to it (it cannot establish whether the home runs). The one route is bb's own: a
// message to the thread in bb starts a turn and brings it back to idle.
const REMEDY = "To get a thread in error back, send it a message in bb itself (bb thread tell <thread id> <text>): bb starts a turn, and the thread is idle again. Until then oats session start and oats session input refuse for this home";

// The programs that run a harness that is a script: then the harness is the second word.
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);

/** The names a process goes by: its own name, the base name of the first word of its
 *  command line, and of the second where the first is an interpreter (`node <dir>/pi`).
 *  Never another argument: `tail -f pi` is no pi. A file that cannot be read gives none. */
function namesOf(proc, pid, read) {
  const names = new Set();
  try { names.add(read(join(proc, pid, "comm"), "latin1").trim()); } catch { /* ended meanwhile */ }
  try {
    const [program, script] = read(join(proc, pid, "cmdline"), "latin1").split("\0");
    if (program) names.add(basename(program));
    if (script && INTERPRETERS.has(basename(program ?? ""))) names.add(basename(script));
  } catch { /* ended meanwhile */ }
  names.delete("");
  return names;
}

/** What started a process: the bb providers its parent is the runner of (bb-app's bridge
 *  worker, by its command line: `[…, <dir>/bb-provider-bridge-worker.mjs, …, provider-<id>, …]`),
 *  [] where its parent is something else, null where the parent cannot be read (the
 *  process or its parent ended meanwhile): then it cannot be told. */
function runnerOf(proc, pid, read) {
  try {
    const stat = read(join(proc, pid, "stat"), "latin1");
    // "<pid> (<name>) <state> <ppid> …": the name may hold spaces and parentheses.
    const parent = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
    if (!/^[0-9]+$/.test(parent ?? "")) return null;
    const argv = read(join(proc, parent, "cmdline"), "latin1").split("\0");
    if (!argv.some((word) => basename(word) === RUNNER_FILE)) return [];
    return argv.map((word) => RUNNER_PROVIDER.exec(word)?.[1]).filter((id) => id !== undefined);
  } catch { return null; }
}

/** For each bb thread that has a live harness-named process on this host, those
 *  processes: Map<thread id, [{names, cwd, runner}]>. `names`: the harness names the
 *  process goes by. `cwd`: its working directory, or null where it cannot be read (a
 *  process that ended meanwhile, or another user's). `runner`: what started it (runnerOf).
 *
 *  A process's name and command line are read first, and its environment only where one of
 *  its names is a harness's: the environment of every other program of this user (which
 *  may hold a secret) is never opened, and never held in memory. Its working directory
 *  and its parent are read only where that environment names a thread. `read` and `link` are the file read
 *  and the link read (the tests watch which files they are asked for). Throws
 *  E_SESSION_UNAVAILABLE where processes cannot be looked at (no /proc: not Linux): the
 *  caller then cannot tell, and says so, never guesses. */
export function threadProcesses({ proc = "/proc", read = readFileSync, link = readlinkSync } = {}) {
  let entries;
  try { entries = readdirSync(proc); }
  catch (error) { throw fail("E_SESSION_UNAVAILABLE", `whether a bb thread's agent process is still loaded cannot be read on this host (${proc}: ${error.code ?? error.message}): the provider reads it from Linux's /proc. ${REMEDY}`); }
  const pids = entries.filter((name) => /^[0-9]+$/.test(name));
  // A /proc that lists no process at all is not one.
  if (pids.length === 0) throw fail("E_SESSION_UNAVAILABLE", `whether a bb thread's agent process is still loaded cannot be read on this host (${proc} lists no process). ${REMEDY}`);
  const harnesses = new Set(Object.values(HARNESS_PROCESS));
  const threads = new Map();
  for (const pid of pids) {
    // Not a harness by any of its names: its environment is none of the provider's business.
    const names = new Set([...namesOf(proc, pid, read)].filter((name) => harnesses.has(name)));
    if (names.size === 0) continue;
    let environ;
    // A process that ended meanwhile, a zombie (an empty environment) or another user's.
    try { environ = read(join(proc, pid, "environ"), "latin1"); } catch { continue; }
    let process = null; // made once, for a harness that carries a thread's id
    for (const entry of environ.split("\0")) {
      if (!entry.startsWith(VARIABLE) || entry.length === VARIABLE.length) continue;
      if (process === null) {
        let cwd = null;
        try { cwd = link(join(proc, pid, "cwd")); } catch { /* ended meanwhile, or not ours to read */ }
        process = { names, cwd, runner: runnerOf(proc, pid, read) };
      }
      const id = entry.slice(VARIABLE.length);
      threads.set(id, [...(threads.get(id) ?? []), process]);
    }
  }
  return threads;
}

/** A reader that looks once, and only when asked. One look serves every home of an
 *  inspectMany, and a look that could not be made is not tried again.
 *  - `has(thread)` → whether the harness of that thread (a row of bb's: its `id` and
 *    `providerId`) lives on this host. A thread of a provider this module does not know
 *    the harness of is asked for either name.
 *  - `runsIn(thread, home)` → whether the harness bb started for that thread works in the
 *    home: true where one process is the thread's harness by its name, carries the
 *    thread's id, has the home as its working directory (exactly the home, as bb starts a
 *    harness in the thread's environment), AND is a child of bb's runner for the thread's
 *    provider. false where no harness of the thread is in the home at all. null where
 *    one is and what started it cannot be read: it cannot be told. UNRECOGNISED where one
 *    is and what started it is not bb's runner for the provider: the caller decides by
 *    bb's version. A harness whose working directory cannot be read is not counted.
 *  Both throw E_SESSION_UNAVAILABLE where the processes cannot be looked at. */
export function processLook(options) {
  let threads = null, failure = null;
  /** The thread's own harness processes, by its provider's harness name. */
  const harnessesOf = (thread) => {
    if (failure !== null) throw failure;
    try { threads ??= threadProcesses(options); }
    catch (error) { failure = error; throw error; }
    const wanted = Object.hasOwn(HARNESS_PROCESS, thread.providerId) ? [HARNESS_PROCESS[thread.providerId]] : Object.values(HARNESS_PROCESS);
    return (threads.get(thread.id) ?? []).filter((process) => wanted.some((name) => process.names.has(name)));
  };
  return {
    has: (thread) => harnessesOf(thread).length > 0,
    runsIn(thread, home) {
      const here = harnessesOf(thread).filter((process) => process.cwd !== null && samePath(process.cwd, home));
      if (here.length === 0) return false;
      // bb's runner for this thread's provider, and no other's.
      if (here.some((process) => process.runner !== null && process.runner.includes(thread.providerId))) return true;
      return here.some((process) => process.runner === null) ? null : UNRECOGNISED;
    },
  };
}
