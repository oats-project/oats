// A pause, or a fault, at one named call. Loaded into ONE kernel CLI child process with
// `node --import <this file> bin/oats.mjs …`, it holds one named `node:fs` sync call of that
// process until the test releases it, or makes that call fail with a code of the system's. A gate
// that pauses changes no argument, no result and no kernel file: the call it holds is the kernel's
// own, made with the kernel's own arguments, and it returns or throws what it would have. A gate
// that throws (`throws`) changes one thing, and says so in the test that sets it: that call fails.
//
// Why it exists: some answers of the kernel need a second writer at an exact moment, an entry that
// vanishes between a walk's listing and its read (awebai/oats#892), a claim taken between two
// steps of a lifecycle command (awebai/oats#866). Such a window is a few microseconds wide. A test
// must not race the wall clock for it: it holds the kernel at the call, does what the second
// writer does, and lets the kernel go on. Others need the system to refuse a write that no file
// shape refuses on every host and for every user: a full file system (awebai/oats#946). A test
// must not fill one: it names the call and the code.
//
// This file has two parts.
//
// 1. The preload (the kernel child). It installs gates only when OATS_TEST_GATES is set, so
//    importing this file in a test process installs nothing.
//
//    OATS_TEST_GATE_DIR  a directory OUTSIDE the deployment. `<name>.entered` is written when a
//                        gate is reached, and the held call goes on once `<name>.release` exists.
//    OATS_TEST_GATES     JSON, a list of gates:
//                        { name, fn, path | prefix, when?, nth?, arg?, contains?, armed?, waitMs?,
//                          throws?, every? }
//      name      the gate's name: the stem of its files in the gate directory
//      fn        a `node:fs` sync function (`lstatSync`, `readFileSync`, `linkSync`…), or
//                `appendEventRow`: the kernel's one write of an event row
//                (lib/instance-events.mjs `eventLog.appendRow(path, line)`), whose first
//                argument is the log's path and whose second is the row's text
//      path      the call matches when argument `arg` (default 0) is exactly this path;
//      prefix    or when it starts with this one. A path may reach the call as text or as bytes
//                (the kernel's walk reads names as bytes: `lstatSync(Buffer)`): both match.
//      when      "before" (default): hold the call before it is made; "after": once it has
//                returned or thrown
//      nth       the gate fires on the Nth matching call (default 1), once. A retire inspects
//                the home three times: `nth` picks which inspection is held.
//      contains  the call matches only when its second argument (the bytes a write is given)
//                holds this text
//      armed     the call matches only once this file exists
//      waitMs    how long a held call waits for its release (default 30 s)
//      throws    a code of the system's (`ENOSPC`, `EACCES`, `EIO`…). The gate does not hold the
//                call: it makes it fail with an error shaped as Node's own for that code (`code`,
//                `errno`, `syscall`, `path`, and a message that starts with the code). "before":
//                the call is not made, as when the system refuses it outright; "after": the call
//                is made, and fails once it has returned (a file that was created, and whose
//                write then found no space). `<name>.entered` is written the first time it
//                fires, and nothing waits for a release.
//      every     the gate fires on every matching call from the Nth on, not once: a file system
//                that is full refuses each write. Only with `throws`.
//
//    The wait is bounded and fails loudly: a release that never comes writes `<name>.timeout`
//    and lets the call go on, so no kernel process is left held, and the driver below reports the
//    gate in `timedOut`, which a test asserts is empty. Both variables are removed from the
//    process's environment once read: what the kernel hands its own children (hooks, git, a
//    detached completion) is what it would hand them without this file.
//
// 2. The driver (the test process): `startGated` and `runFaulted`, named exports. The driver
//    lives here, not in each test file, so that every suite that needs a pause or a fault starts
//    and ends its child the same way.
//
//      const run = startGated([CLI, "retire", name, "--json"], { cwd: fx.dep, env: fx.env,
//        gateDir: join(fx.base, "gates"), gates: [{ name: "walk", fn: "lstatSync", path }] });
//      try {
//        await run.waitGate("walk");          // the kernel is held at that call
//        rmSync(path);                        // the second writer
//        run.release("walk");
//        const { code, stdout, stderr, timedOut } = await run.done;
//        …
//      } finally { await run.finish(); }      // releases every gate and waits for the exit
//
//    No sleep synchronises anything: `waitGate` polls for `<name>.entered` with a bound and
//    rejects, with the child's output, when the bound passes or the child exits first. Always
//    `finish()` in a `finally`: a failed assertion must not leave a held kernel process behind
//    (a fixture's cleanup fails the test when a process still works in its base).
//
//    A child whose gates all throw is held nowhere, so it is run to its end in one call:
//
//      const r = runFaulted([CLI, "instance", "stop", name, "--apply", …], { cwd: fx.dep,
//        env: fx.env, gateDir: join(fx.base, "faults"),
//        gates: [{ name: "full", fn: "writeFileSync", prefix: fx.dep, throws: "ENOSPC", every: true }] });
//      assert.deepEqual(r.fired, ["full"]);   // the fault was met: the answer is the kernel's to it
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { constants } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE_DIR = "OATS_TEST_GATE_DIR";
const GATES = "OATS_TEST_GATES";
/** How long a held call waits for its release before it goes on and says so (`<name>.timeout`). */
const RELEASE_WAIT_MS = 30000;

// ---- 1. the preload ---------------------------------------------------------------------------

// The pause's own reads and writes, taken before any gate is installed: they never meet a gate.
const exists = fs.existsSync.bind(fs), write = fs.writeFileSync.bind(fs);

function validGate(g) {
  const bad = (why) => new Error(`${GATES}: a gate ${why}: ${JSON.stringify(g)}`);
  if (!g || typeof g !== "object") throw bad("is not an object");
  if (typeof g.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(g.name)) throw bad("needs a name of letters, digits, - and _");
  if (typeof g.fn !== "string" || !(Object.hasOwn(SEAMS, g.fn) || (g.fn.endsWith("Sync") && typeof fs[g.fn] === "function"))) throw bad("needs fn, a node:fs sync function or a kernel seam");
  if ((typeof g.path === "string") === (typeof g.prefix === "string")) throw bad("needs either path or prefix");
  if (g.when !== undefined && g.when !== "before" && g.when !== "after") throw bad('has a when that is neither "before" nor "after"');
  if (g.nth !== undefined && !(Number.isInteger(g.nth) && g.nth >= 1)) throw bad("has an nth that is not a positive integer");
  if (g.throws !== undefined && !(typeof g.throws === "string" && Number.isInteger(constants.errno[g.throws]))) throw bad("has a throws that is not a code of the system's");
  if (g.every !== undefined && !(g.every === true && g.throws !== undefined)) throw bad("has an every that is not true, or has it without throws");
  return { ...g, when: g.when ?? "before", nth: g.nth ?? 1, arg: g.arg ?? 0, waitMs: g.waitMs ?? RELEASE_WAIT_MS, seen: 0, fired: false };
}

/** The kernel's own seams a gate may name beside a `node:fs` function → the object that holds
 *  the function, and its key there. */
const SEAMS = {
  appendEventRow: async () => [(await import(new URL("../../lib/instance-events.mjs", import.meta.url))).eventLog, "appendRow"],
};
async function installGates(specs, dir) {
  if (!dir) throw new Error(`${GATES} is set without ${GATE_DIR}`);
  if (!Array.isArray(specs)) throw new Error(`${GATES} is not a JSON list of gates`);
  const gates = specs.map(validGate);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const pause = (g) => {
    write(join(dir, `${g.name}.entered`), `${process.pid}\n`);
    const release = join(dir, `${g.name}.release`);
    const end = Date.now() + g.waitMs;
    while (!exists(release)) {
      if (Date.now() >= end) { write(join(dir, `${g.name}.timeout`), `${g.fn} was held ${g.waitMs} ms and never released\n`); return; }
      Atomics.wait(cell, 0, 0, 2); // blocks this thread and starts no process
    }
  };
  // What the system calls the operation a function fails in, where it is not the function's own
  // name without "Sync": a write that finds no space fails in `write`, whatever opened the file.
  const SYSCALL = { writeFileSync: "write", appendFileSync: "write", writeSync: "write", rmSync: "rm", readFileSync: "open" };
  /** An error as Node gives it for the system's `code` at `fn(...args)`. */
  const fault = (g, args) => {
    const syscall = SYSCALL[g.fn] ?? g.fn.slice(0, -"Sync".length).toLowerCase(), path = String(args[g.arg] ?? "");
    return Object.assign(new Error(`${g.throws}: made by the test's gate ${g.name}, ${syscall} '${path}'`), { errno: -constants.errno[g.throws], code: g.throws, syscall, path });
  };
  const met = (g) => { if (!g.met) { g.met = true; write(join(dir, `${g.name}.entered`), `${process.pid}\n`); } };
  // A path is compared as text: String() of a Buffer is its UTF-8 text.
  const matches = (g, args) => {
    const value = String(args[g.arg] ?? "");
    if (g.armed !== undefined && !exists(g.armed)) return false;
    if (g.contains !== undefined && !String(args[1] ?? "").includes(g.contains)) return false;
    return g.path !== undefined ? value === g.path : value.startsWith(g.prefix);
  };
  for (const fn of new Set(gates.map((g) => g.fn))) {
    const [holder, key] = Object.hasOwn(SEAMS, fn) ? await SEAMS[fn]() : [fs, fn];
    const original = holder[key];
    const gated = function (...args) {
      const hit = [];
      for (const g of gates) {
        if (g.fn !== fn || g.fired || !matches(g, args)) continue;
        if (++g.seen === g.nth || (g.every && g.seen > g.nth)) { g.fired = !g.every; hit.push(g); }
      }
      if (!hit.length) return original.apply(this, args);
      const failing = hit.find((g) => g.throws !== undefined);
      for (const g of hit) if (g.when === "before") { if (g.throws === undefined) pause(g); else met(g); }
      if (failing?.when === "before") throw fault(failing, args);
      let result;
      try { result = original.apply(this, args); } finally { for (const g of hit) if (g.when === "after") { if (g.throws === undefined) pause(g); else met(g); } }
      if (failing) throw fault(failing, args);
      return result;
    };
    // What the function carries besides its body (its name, its length, `realpathSync.native`) stays.
    for (const key of Reflect.ownKeys(original)) if (key !== "prototype") Object.defineProperty(gated, key, Object.getOwnPropertyDescriptor(original, key));
    holder[key] = gated;
  }
  syncBuiltinESMExports(); // `import { lstatSync } from "node:fs"` reads the gated one too
}

const PRELOADED = !!process.env[GATES];
if (PRELOADED) {
  const specs = JSON.parse(process.env[GATES]), dir = process.env[GATE_DIR];
  delete process.env[GATES];
  delete process.env[GATE_DIR];
  await installGates(specs, dir);
}

// ---- 2. the driver ----------------------------------------------------------------------------

// The child's environment, when a caller gives none: this worker's, less what a fixture never
// inherits (host-fixture.mjs inheritedEnv), never the raw one. Loaded only where the driver runs: a
// gated child preloads this file and loads nothing beside it.
const inheritedEnv = PRELOADED ? null : (await import("./host-fixture.mjs")).inheritedEnv;

/** This file's path: what `node --import` is given. */
export const FS_GATE_PRELOAD = fileURLToPath(import.meta.url);

/** What both drivers ask of their arguments: gates, and a gate directory of the child's own, made here. */
function newGateDir(who, gates, gateDir) {
  if (!gateDir) throw new Error(`${who} needs gateDir, a directory outside the deployment`);
  if (!Array.isArray(gates) || !gates.length) throw new Error(`${who} needs at least one gate`);
  fs.mkdirSync(gateDir, { recursive: true });
  if (fs.readdirSync(gateDir).length) throw new Error(`the gate directory ${gateDir} is not empty: each gated child needs its own`);
}

/** Run `node --import <this file> ...args` to its end with `gates` installed, every one of which
 *  throws (`throws`): nothing holds the child, so nothing is to be released. `cwd`, `env` and
 *  `gateDir` as startGated takes them.
 *  → what `spawnSync` gives ({ status, signal, stdout, stderr, error }), with
 *    fired     the names of the gates that were met, in the order they were given: a test asserts
 *              that its fault was reached, or its answer is not an answer to that fault
 *    json()    the last line of stdout, parsed (the one envelope of a JSON-mode answer) */
export function runFaulted(args, { cwd, env = inheritedEnv(), gates, gateDir } = {}) {
  newGateDir("runFaulted", gates, gateDir);
  const held = gates.filter((g) => g.throws === undefined).map((g) => g.name);
  if (held.length) throw new Error(`runFaulted runs a child that nothing holds: the gates ${held.join(", ")} would pause it (startGated drives those)`);
  const r = spawnSync(process.execPath, ["--import", FS_GATE_PRELOAD, ...args], { cwd, env: { ...env, [GATE_DIR]: gateDir, [GATES]: JSON.stringify(gates) }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { ...r, fired: gates.map((g) => g.name).filter((name) => fs.existsSync(join(gateDir, `${name}.entered`))), json: () => JSON.parse(r.stdout.trim().split("\n").pop()) };
}

/** Start `node --import <this file> ...args` as a child with `gates` installed, and return the
 *  handle that drives it. `cwd` and `env` are the child's (a fixture's `fx.dep` and `fx.env`: the
 *  gate variables are added to `env` here; with no `env`, the child gets inheritedEnv()). `gateDir`
 *  is a directory outside the deployment, made here, for this one child: it must be new or empty.
 *  → { child, done, waitGate(name, timeoutMs?), entered(name), release(name), finish() }
 *    done      resolves when the child has exited and its output is read:
 *              { code, signal, stdout, stderr, timedOut }, `timedOut` the gates that were never
 *              released in time (a test asserts it is empty)
 *    waitGate  resolves once the child is held at that gate; rejects after `timeoutMs` (20 s), or
 *              when the child exits without reaching it
 *    entered   whether that gate was reached (for one that throws: whether it was met)
 *    release   lets the call held at that gate go on (before or after it is reached)
 *    finish    releases every gate and waits for the exit: for a `finally`
 *  A gate that throws holds nothing: `waitGate` and `release` are for the others. */
export function startGated(args, { cwd, env = inheritedEnv(), gates, gateDir } = {}) {
  newGateDir("startGated", gates, gateDir);
  const file = (name, suffix) => join(gateDir, `${name}.${suffix}`);
  const child = spawn(process.execPath, ["--import", FS_GATE_PRELOAD, ...args], { cwd, env: { ...env, [GATE_DIR]: gateDir, [GATES]: JSON.stringify(gates) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", exited = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", (e) => { exited = true; reject(e); });
    child.on("close", (code, signal) => {
      exited = true;
      resolve({ code, signal, stdout, stderr, timedOut: gates.map((g) => g.name).filter((name) => fs.existsSync(file(name, "timeout"))) });
    });
  });
  done.catch(() => {}); // a test that only awaits waitGate still sees the error there, never an unhandled rejection
  const entered = (name) => fs.existsSync(file(name, "entered"));
  const release = (name) => { fs.writeFileSync(file(name, "release"), ""); };
  const waitGate = async (name, timeoutMs = 20000) => {
    if (!gates.some((g) => g.name === name)) throw new Error(`no gate named ${name}`);
    const deadline = Date.now() + timeoutMs;
    const output = () => `stdout: ${stdout || "(empty)"}\nstderr: ${stderr || "(empty)"}`;
    while (!entered(name)) {
      if (exited) throw new Error(`the child exited without reaching the gate ${name}\n${output()}`);
      if (Date.now() >= deadline) throw new Error(`the child did not reach the gate ${name} within ${timeoutMs} ms\n${output()}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const finish = async () => {
    for (const g of gates) release(g.name);
    return done.catch(() => undefined);
  };
  return { child, done, waitGate, entered, release, finish };
}
