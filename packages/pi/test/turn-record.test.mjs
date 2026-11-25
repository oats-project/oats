// The bridge records each turn's start and end in <home>/.oats/turn.json, for the home's status row
// (`activity`, the kernel's feature status-activity, KP-5): turn-start at agent_start, turn-end at
// agent_end, an aborted run's included, each write replacing the file whole. The kernel reads the
// record the bridge writes (lib/turn-activity.mjs), so every case reads it through the kernel's own
// reader. The events are driven by hand here; turn-record-real-pi.test.mjs runs them in pi itself.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storedTreeDigest } from "../../../lib/core.mjs";
import { TURN_EVENT, TURN_FILE, tmuxActivity } from "../../../lib/turn-activity.mjs";

import { TURN_END, TURN_START, TURN_WRITER, recordTurns, takeTurnWriter, turnPath, writeTurn } from "../extension/turn-record.mjs";
import { processStart } from "../extension/waiting-claim.mjs";

/** A home, as spawn leaves one: its record and its `.oats` directory. */
function homeOf(t, { oats = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-turn-")));
  t.after(() => { chmodSync(join(home, ".oats"), 0o700); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(home, "instance.json"), "{}\n");
  mkdirSync(join(home, ".oats"));
  if (!oats) rmSync(join(home, ".oats"), { recursive: true });
  return home;
}
/** The bridge's recorder in `home`, with pi's events driven by hand and a clock the test moves.
 *  `env`: the process environment it reads and sets its writer's mark in (a fresh one by default:
 *  a pi with no pi above it). */
function session(home, clock, env = {}) {
  const handlers = new Map();
  const pi = { on: (event, handler) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } };
  recordTurns(pi, home, { now: () => new Date(clock.at), env });
  return async (event, payload = {}) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }); };
}
const recordOf = (home) => JSON.parse(readFileSync(turnPath(home), "utf8"));
const STARTED = Date.parse("2026-11-25T10:00:00.000Z");
/** What the kernel reads of the home, for a start at STARTED. */
const activityOf = (home) => tmuxActivity(home, { startedAt: new Date(STARTED).toISOString(), harness: "pi", now: STARTED + 3_600_000 });

test("the record is the kernel's: the same file and the same two events", () => {
  assert.deepEqual([TURN_START, TURN_END], [TURN_EVENT.START, TURN_EVENT.END]);
  assert.equal(turnPath("/h"), join("/h", TURN_FILE));
});

test("the first turn of a start: the opening task's run reads working before its first end, then idle", async (t) => {
  const home = homeOf(t), clock = { at: STARTED + 1500 };
  const fire = session(home, clock);
  assert.equal(activityOf(home), null, "no run yet: nothing is written when the session starts");
  // pi sends the launch's `@TASK.md` as the session's first prompt: a run like any other.
  await fire("agent_start");
  assert.deepEqual(recordOf(home), { event: "turn-start", at: "2026-11-25T10:00:01.500Z" });
  assert.equal(activityOf(home), "working");
  clock.at = STARTED + 9000;
  await fire("agent_end", { messages: [{ role: "user" }, { role: "assistant", stopReason: "stop" }] });
  assert.deepEqual(recordOf(home), { event: "turn-end", at: "2026-11-25T10:00:09.000Z" });
  assert.equal(activityOf(home), "idle");
  clock.at = STARTED + 20_000;
  await fire("agent_start");
  assert.equal(activityOf(home), "working", "and the next turn");
});

test("an abort writes turn-end: pi fires agent_end for a run a person aborted, and for one that failed", async (t) => {
  const home = homeOf(t), clock = { at: STARTED + 1000 };
  const fire = session(home, clock);
  for (const stopReason of ["aborted", "error", "length"]) {
    await fire("agent_start");
    assert.equal(activityOf(home), "working", stopReason);
    clock.at += 1000;
    await fire("agent_end", { messages: [{ role: "assistant", stopReason, ...(stopReason === "error" ? { errorMessage: "503" } : {}) }] });
    assert.equal(recordOf(home).event, "turn-end", stopReason);
    assert.equal(activityOf(home), "idle", stopReason);
    // agent_settled follows an abort and a failure; it is no boundary.
    await fire("agent_settled", { aborted: stopReason === "aborted" });
    assert.equal(activityOf(home), "idle", stopReason);
    clock.at += 1000;
  }
  // An agent_end with no messages at all (an abort before the first reply).
  await fire("agent_start");
  await fire("agent_end", {});
  assert.equal(activityOf(home), "idle");
});

test("each write replaces the file whole, leaves no draft, and is not work to the kernel's retire digest", async (t) => {
  const home = homeOf(t), clock = { at: STARTED + 1000 };
  const digest = () => storedTreeDigest(home, 2, { instanceHome: true });
  const before = digest();
  const fire = session(home, clock);
  for (let i = 0; i < 20; i++) {
    await fire(i % 2 ? "agent_end" : "agent_start");
    const bytes = readFileSync(turnPath(home), "utf8");
    assert.match(bytes, /^\{"event":"turn-(start|end)","at":"[^"]+"\}\n$/);
    assert.deepEqual(readdirSync(join(home, ".oats")), ["turn.json"]);
  }
  assert.equal(digest(), before, "the record");
  // A draft a killed write left: the name the bridge gives one is passed over too.
  writeFileSync(`${turnPath(home)}.4242.0b0e3c4e-7f7c-4c59-9b55-0a4f3a6f2a11`, "{\"event\":");
  assert.equal(digest(), before, "a draft");
  assert.equal(activityOf(home), "idle", "and the kernel never reads one");
});

test("a record a pi left when it was killed mid-turn is not this start's: it reads null until this start's first boundary", async (t) => {
  const home = homeOf(t);
  const killed = session(home, { at: STARTED - 60_000 });
  await killed("agent_start");
  assert.equal(recordOf(home).event, "turn-start");
  assert.equal(activityOf(home), null, "from before startedAt");
  // (The killed pi's process is gone, and its bridges with it: here, its session ends.)
  await killed("session_shutdown");
  await session(home, { at: STARTED + 1 })("agent_start");
  assert.equal(activityOf(home), "working");
});

test("recording never breaks a session: a home with no .oats directory, or one that cannot be written, drops the write and leaves nothing", async (t) => {
  const bare = homeOf(t, { oats: false });
  assert.equal(writeTurn(bare, TURN_START), false);
  await session(bare, { at: STARTED })("agent_start");
  assert.deepEqual(readdirSync(bare), ["instance.json"], "no .oats directory is made");
  mkdirSync(join(bare, ".oats"));

  const home = homeOf(t), clock = { at: STARTED + 1000 };
  const fire = session(home, clock);
  await fire("agent_start");
  // The record's own name taken by a directory: the draft is written, the rename fails, and the draft goes.
  rmSync(turnPath(home));
  mkdirSync(turnPath(home));
  writeFileSync(join(turnPath(home), "x"), "");
  assert.equal(writeTurn(home, TURN_END), false);
  await fire("agent_end");
  assert.deepEqual(readdirSync(join(home, ".oats")), ["turn.json"], "no draft is left");
  assert.equal(activityOf(home), null, "and the kernel reads no record there");
  rmSync(turnPath(home), { recursive: true });
  // A directory that refuses the write (not for root, which no mode stops).
  if (process.getuid?.() !== 0) {
    chmodSync(join(home, ".oats"), 0o500);
    assert.equal(writeTurn(home, TURN_END), false);
    await fire("agent_end");
    chmodSync(join(home, ".oats"), 0o700);
    assert.deepEqual(readdirSync(join(home, ".oats")), []);
  }
  assert.equal(writeTurn(home, TURN_END, { now: () => new Date(STARTED + 5000) }), true);
  assert.equal(activityOf(home), "idle");
});

// ---- only the home's own pi writes

const MODULE = fileURLToPath(new URL("../extension/turn-record.mjs", import.meta.url));
/** A second pi's bridge in `home`, as a process started below this one with `env`: it runs one
 *  turn (a start, then an end) and prints the mark it leaves in its own environment. */
const CHILD = `import { recordTurns, TURN_WRITER } from ${JSON.stringify(MODULE)};
const handlers = new Map();
recordTurns({ on: (event, handler) => handlers.set(event, handler) }, process.argv[1]);
handlers.get("agent_start")();
handlers.get("agent_end")();
process.stdout.write(process.env[TURN_WRITER]);
`;
const childTurn = (home, env) => spawnSync(process.execPath, ["--input-type=module", "-e", CHILD, home], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 30000 });

test("a second pi in the home writes nothing while the home's own pi lives: its run's end never reads idle over the outer turn", async (t) => {
  const home = homeOf(t), clock = { at: STARTED + 1000 }, env = {};
  const fire = session(home, clock, env);
  await fire("agent_start");
  // The mark names this process, when it started, and the home.
  assert.equal(env[TURN_WRITER], `${process.pid}:${processStart(process.pid) ?? ""}:${home}`);
  const outer = readFileSync(turnPath(home), "utf8");
  // A subagent's pi, started below this one: it inherits the mark, and its whole turn writes nothing.
  const child = childTurn(home, env);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, env[TURN_WRITER], "the mark stays the outer pi's");
  assert.equal(readFileSync(turnPath(home), "utf8"), outer);
  assert.equal(activityOf(home), "working", "the outer turn goes on");
  await fire("agent_end");
  assert.equal(activityOf(home), "idle");
});

test("a second session in the same process (a subagent's, a workflow agent's) writes nothing while the home's own session lives; a reload hands the writer on", async (t) => {
  const home = homeOf(t), clock = { at: STARTED + 1000 }, env = {};
  // The home's own session: the first bridge the process loads.
  const main = session(home, clock, env);
  await main("agent_start");
  const outer = readFileSync(turnPath(home), "utf8");
  // A subagent's session, made inside the main run, in this process: pi loads the bridge again for it.
  clock.at += 1000;
  const sub = session(home, clock, env);
  await sub("agent_start");
  await sub("agent_end");
  assert.equal(readFileSync(turnPath(home), "utf8"), outer, "the subagent's whole turn wrote nothing");
  assert.equal(activityOf(home), "working", "the main turn goes on");
  // Two more at once, and their sessions ending, change nothing: none of them held the writer.
  const others = [session(home, clock, env), session(home, clock, env)];
  for (const other of others) await other("agent_start");
  for (const other of others) { await other("agent_end"); await other("session_shutdown"); }
  await sub("session_shutdown");
  assert.equal(readFileSync(turnPath(home), "utf8"), outer);
  clock.at += 1000;
  await main("agent_end");
  assert.deepEqual(recordOf(home), { event: "turn-end", at: new Date(clock.at).toISOString() });
  // A subagent that works on after the main turn ended is not the home's turn.
  await sub("agent_start");
  assert.equal(activityOf(home), "idle");

  // A /reload, or a replaced session: the next bridge loads, the holder's session shuts down
  // (in either order), and the next bridge is the writer from its next run.
  const next = session(home, clock, env);
  await next("agent_start");
  assert.equal(activityOf(home), "idle", "the holder still lives: the next bridge waits");
  await next("agent_end");
  await main("session_shutdown");
  clock.at += 1000;
  await next("agent_start");
  assert.deepEqual(recordOf(home), { event: "turn-start", at: new Date(clock.at).toISOString() });
  // The session that shut down writes nothing more, and takes nothing back.
  await main("agent_start");
  await main("agent_end");
  assert.equal(recordOf(home).event, "turn-start");
  await next("agent_end");
  assert.equal(activityOf(home), "idle");
  await next("session_shutdown");
});

test("the mark is the home's and its holder's: one for another home, of a process that is gone, of a reused pid, or that is no mark, is not in the way", async (t) => {
  const home = homeOf(t);
  // A process that has exited, and was reaped: its pid names nobody (or, reused, another start).
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => gone.on("exit", resolve));
  const other = homeOf(t);
  const cases = [
    ["no mark", undefined], ["an empty mark", ""], ["no pid", `x:1:${home}`], ["a mark with no home", `${process.pid}:1`],
    ["another home's writer, alive", `${process.pid}:${processStart(process.pid) ?? ""}:${other}`],
    ["a writer that is gone", `${gone.pid}:1:${home}`],
    ["a pid that is another process now", `${process.pid}:not-its-start:${home}`],
  ];
  for (const [what, mark] of cases) {
    rmSync(turnPath(home), { force: true });
    const child = childTurn(home, { [TURN_WRITER]: mark });
    assert.equal(child.status, 0, `${what}: ${child.stderr}`);
    assert.equal(recordOf(home).event, "turn-end", what);
    assert.match(child.stdout, new RegExp(`^\\d+:[^:]*:${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), `${what}: the child took the mark`);
    assert.notEqual(child.stdout, mark, what);
  }
  // In process: the holder is asked when a run starts, so a pi whose writer has gone takes over then.
  const env = { [TURN_WRITER]: `${process.pid}:${processStart(process.pid) ?? ""}:${home}` };
  assert.equal(takeTurnWriter(home, env), true, "its own mark");
  // (Linux reads a start for every pid; elsewhere `ps` does. Where neither does, an unreadable start counts as alive.)
  const parent = `${process.ppid}:${processStart(process.ppid) ?? ""}:${home}`;
  assert.equal(takeTurnWriter(home, { [TURN_WRITER]: parent }), false, "a live other process holds it");
  const after = { [TURN_WRITER]: `${gone.pid}:1:${home}` };
  assert.equal(takeTurnWriter(home, after), true);
  assert.equal(after[TURN_WRITER].startsWith(`${process.pid}:`), true);
});
