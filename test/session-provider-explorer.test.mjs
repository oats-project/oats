// The explorer: schedules the hand-written tables (test/session-provider-lifecycle.test.mjs) do not
// list one by one. For each verb of a provider home, the kernel is KILLED at each seam it passes
// (every point between two writes, and each provider call: before it, during it, after it); then
// another verb runs, then an input; and once everything a killed kernel left behind has had the
// time to act, the invariants of docs/design/2026-11-20-provider-home-lifecycle.md are checked
// against a provider that HAS sessions (the fixture's stateful fake: a launch creates one, a stop
// stops it, an input restarts a stopped one):
//
//   1. no session runs that no record names;
//   2. a home recorded planned has no session, and one recorded stopped none but the one its
//      record names, and not that one either once a stop of it was confirmed (the fence is written
//      first: a kernel killed between the fence and the provider's answer leaves that session to
//      the next stop, start or retire, and no input reaches it meanwhile);
//   3. no home is left that no verb can act on: every verb answers a kernel code, never a record
//      it cannot read, and a retire takes the home, after which nothing of it runs;
//   4. no input is delivered after a stop was confirmed;
//   5. a home whose start, restart or resume was answered, or whose input was submitted, has the
//      session its record names running: nothing a kernel left behind stops it afterwards.
//
// Deterministic: the schedules are enumerated, shuffled by a seed and cut to a sample, so a run
// in the suite takes seconds. EVERY schedule runs with `npm run test:provider-lifecycle`, which
// pull-request CI does for a change that touches the lifecycle (scripts/provider-lifecycle-changed.mjs)
// and a nightly run does on main. A failure prints the seed and the schedule's steps.
//   OATS_EXPLORER_SEED=<n>    another sample           OATS_EXPLORER_COUNT=<n>|all   its size
//   OATS_EXPLORER_ONLY="<a> | <seam> | <b>"            one schedule, as a failure prints it
// What it does NOT enumerate, and the tables pin instead: two LIVE commands side by side (a verb
// that runs while another is paused, not ended), and a write that fails without its process ending.
//   OATS_EXPLORER_VERBOSE=1   a refusal's message beside its code, in a failure's steps
//   OATS_EXPLORER_WORKERS=<n> how many schedules run side by side (6)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventsOf, providerDeployment, sessionsOf } from "./helpers/session-provider-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "oats.mjs");
const VERB = join(HERE, "helpers", "session-provider-verb.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a provider's command sleeps before it acts, when its kernel dies during it: long
 *  enough that the next verb has answered by then, so what the command does comes AFTER it. */
const LATE_MS = 1500;

// ------------------------------------------------------------------ the schedules
const CALL = (verb) => [`call:${verb}:before`, `call:${verb}:during`, `call:${verb}:after`];
const MARK = ["mark:receipt-written", ...CALL("launch"), "outcome:receipt-written", "outcome:record-written"];
const STOP_RULE = ["stop:stoppedAt-written", "stop:receipt-written", ...CALL("stop")];
/** The verb that is killed: from which state of the home, and the seams it passes: every verb,
 *  from every state of the page in which it calls the provider or writes a record. A seam listed
 *  here must kill it (the explorer says so when it does not), so the list cannot rot. Where a verb
 *  calls the provider more than once, a `call:` seam is its FIRST such call; the later ones are
 *  reached from the state the first leaves (a stop of resent: stop {E}, then the settle's). */
const KILLED = [
  { a: "spawn", from: "none", verb: "spawn", seams: ["spawn:record-written", ...MARK, "spawn:recorded", "spawn:published"] },
  { a: "spawn without a launch", from: "none", verb: "spawn planned", seams: ["spawn:record-written"] },
  // (A retire keeps the receipt of the home it removed, by its path: the spawn must not be paired with it.)
  { a: "spawn over the name of a retired home", from: "retired", verb: "spawn again", seams: ["spawn:record-written", "mark:receipt-written", "outcome:record-written"] },
  { a: "spawn, its launch lost", from: "none", verb: "spawn", provider: { launch: { exit: 1 } }, seams: [...CALL("stop"), "rollback:record-written"] },
  { a: "start of planned", from: "planned", verb: "start", seams: MARK },
  { a: "start of planned, refused", from: "planned", verb: "start", provider: { launch: { error: { code: "E_BACKEND_NOT_READY", message: "down" } } }, seams: ["unmark:record-written"] },
  { a: "start of stopped", from: "stopped", verb: "start", seams: [...CALL("stop"), ...MARK] },
  { a: "start of lost", from: "lost", verb: "start", seams: [...MARK, ...CALL("stop")] },
  { a: "start of sent", from: "sent", verb: "start", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "start of resent", from: "resent", verb: "start", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "start of stopped, its launch lost", from: "stopped", verb: "start", provider: { launch: { exit: 1 } }, seams: ["settle:record-written"] },
  { a: "restart of stopped", from: "stopped", verb: "restart", seams: [...CALL("stop"), ...MARK] },
  { a: "restart of lost", from: "lost", verb: "restart", seams: [...MARK, ...CALL("stop")] },
  { a: "restart of running", from: "running", verb: "restart", seams: [...STOP_RULE, ...MARK] },
  { a: "stop of running", from: "running", verb: "stop", seams: STOP_RULE },
  { a: "stop of resent", from: "resent", verb: "stop", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "stop of sent", from: "sent", verb: "stop", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "stop of stopped", from: "stopped", verb: "stop", seams: CALL("stop") },
  { a: "host stop of running", from: "running", verb: "host stop", seams: STOP_RULE },
  { a: "retire of running", from: "running", verb: "retire", seams: STOP_RULE },
  { a: "retire of stopped", from: "stopped", verb: "retire", seams: CALL("stop") },
  { a: "retire of sent", from: "sent", verb: "retire", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "retire of resent", from: "resent", verb: "retire", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "input to running", from: "running", verb: "input", seams: CALL("input") },
  { a: "input to lost", from: "lost", verb: "input", seams: CALL("input") },
  { a: "resume of stopped with the host", from: "host-stopped", verb: "resume", seams: [...CALL("input"), "resume:notice-sent", "resume:stop-cleared"] },
  { a: "resume of lost", from: "lost", verb: "resume", seams: CALL("input") },
  // From a home stopped with the host (its stop receipt asks for a resume), and from a resent home
  // that was stopped before its launch (`stoppedAt` set), which settle by another branch.
  { a: "stop of stopped with the host", from: "host-stopped", verb: "stop", seams: CALL("stop") },
  { a: "start of stopped with the host", from: "host-stopped", verb: "start", seams: [...CALL("stop"), ...MARK] },
  { a: "restart of stopped with the host", from: "host-stopped", verb: "restart", seams: [...CALL("stop"), ...MARK] },
  { a: "retire of stopped with the host", from: "host-stopped", verb: "retire", seams: CALL("stop") },
  { a: "stop of resent, stopped before", from: "resent (stopped)", verb: "stop", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "start of resent, stopped before", from: "resent (stopped)", verb: "start", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "retire of resent, stopped before", from: "resent (stopped)", verb: "retire", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "host stop of sent", from: "sent", verb: "host stop", seams: [...CALL("stop"), "settle:record-written"] },
  { a: "host stop of resent", from: "resent", verb: "host stop", seams: ["stop:stoppedAt-written", ...CALL("stop"), "settle:record-written"] },
  { a: "host stop of resent, stopped before", from: "resent (stopped)", verb: "host stop", seams: [...CALL("stop"), "settle:record-written"] },
  // (The host's stop of a home that is stopped already asks the provider nothing and writes nothing: it passes no seam.)
];
/** The verb that comes next, on whatever the killed one left. */
const NEXT = ["start", "restart", "stop", "host stop", "retire", "input", "resume"];
const ALL = KILLED.flatMap((k) => k.seams.flatMap((seam) => NEXT.map((b) => ({ ...k, seam, b }))));

/** A seeded shuffle (mulberry32): the same seed, the same sample. */
function shuffled(items, seed) {
  let t = seed >>> 0;
  const random = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
const SEED = Number(process.env.OATS_EXPLORER_SEED ?? 20261120);
const COUNT = process.env.OATS_EXPLORER_COUNT === "all" ? ALL.length : Number(process.env.OATS_EXPLORER_COUNT ?? 28);
const ONLY = process.env.OATS_EXPLORER_ONLY?.split("|").map((part) => part.trim());
const SAMPLE = ONLY ? ALL.filter((s) => s.a === ONLY[0] && s.seam === ONLY[1] && s.b === ONLY[2]) : shuffled(ALL, SEED).slice(0, COUNT);

// ------------------------------------------------------------------ running one
/** A command as a process of its own → `{ signal, out }`. */
function run(fx, argv, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: fx.dep, env: { ...fx.env, ...env }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (_code, signal) => resolve({ signal, out }));
  });
}
/** A command's JSON answer: its whole output, or its last line. */
const lastJson = (out) => { for (const text of [out, out.trim().split("\n").pop()]) { try { return JSON.parse(text); } catch { /* the other form */ } } return null; };
/** One verb on a home → `{ signal }` when it was killed, else `{ ok, code }` (`code` null: a defect). */
async function verb(fx, what, name, home, env) {
  if (what.startsWith("spawn")) {
    // "spawn in a worktree", then "spawn again" over its name once it is retired, on a branch of its own.
    const more = { "spawn planned": ["--no-launch"], "spawn in a worktree": ["--work", "worktree"], "spawn again": ["--work", "worktree", "--branch", `agents/${name}-again`] }[what] ?? [];
    const r = await run(fx, [CLI, "spawn", "dev", "--name", name, "--backend", "fake", "--launch-config", "claude", ...more, "--json"], env);
    const said = lastJson(r.out);
    return r.signal ? { signal: r.signal } : { ok: said?.ok !== false && said !== null, code: said?.error?.code ?? null, message: r.out.slice(0, 400) };
  }
  if (what === "retire") {
    const r = await run(fx, [CLI, "retire", name, "--json"], env);
    const said = lastJson(r.out);
    return r.signal ? { signal: r.signal } : { ok: said?.retired === name, code: said?.error?.code ?? null, message: r.out.slice(0, 400) };
  }
  const r = await run(fx, [VERB, what, home], env);
  return r.signal ? { signal: r.signal } : (lastJson(r.out) ?? { ok: false, code: null, message: r.out.slice(0, 400) });
}
const receiptOf = (home) => { try { return JSON.parse(readFileSync(join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`), "utf8")).runtime; } catch { return null; } };
/** The state the records spell, by the page's names. */
function stateOf(home) {
  if (!existsSync(home)) return "gone";
  const r = receiptOf(home);
  if (!r) return "no receipt";
  if (r.launchSent !== undefined) return r.endpoint === undefined ? "sent" : "resent";
  if (r.launched !== true) return "planned";
  return r.stoppedAt === null ? "running" : "stopped";
}
/** Bring a new home to the state a schedule starts from. */
async function prepare(fx, from, name, home) {
  const must = async (what, env) => { const r = await verb(fx, what, name, home, env); if (r.ok !== true && !(env && r.signal)) throw Object.assign(new Error(`setting up "${from}": ${what} answered ${JSON.stringify(r)}`), { setup: true }); };
  if (from === "none") return;
  if (from === "retired") { await must("spawn in a worktree"); return must("retire"); }
  if (from === "planned") return must("spawn planned");
  if (from === "sent") return must("spawn", { OATS_TEST_PROVIDER_DIE_AT: "mark:receipt-written" });
  await must("spawn");
  if (from === "stopped" || from === "resent" || from === "resent (stopped)") await must("stop");
  if (from === "resent (stopped)") await must("start", { OATS_TEST_PROVIDER_DIE_AT: "mark:receipt-written" });
  if (from === "resent") await must("start", { OATS_TEST_PROVIDER_DIE_AT: "outcome:receipt-written" });
  if (from === "host-stopped") await must("host stop");
  if (from === "lost") fx.emit({ ev: "gone", thread: receiptOf(home).endpoint.threadId });
}
/** What a verb may answer on a home in any state of the page: a refusal of its own. Not these:
 *  a record the kernel cannot read is a home no verb can act on. */
const NO_STATE = new Set(["E_RUNTIME_AUTHORITY_MISMATCH", "E_RUNTIME_ENDPOINT_UNKNOWN", "E_RUNTIME_ENDPOINT_INVALID"]);

async function explore(fx, setControl, n, { a, from, verb: killed, provider = {}, seam, b }, again = "") {
  const name = `x${n}${again}`, home = join(fx.root, "dev", "instances", name);
  const steps = [`${a}, killed at ${seam}`];
  const broken = [];
  const answered = (what, r) => { steps.push(`${what}: ${r.ok ? "ok" : r.code ?? `NO CODE ${r.message}`}`); if (!r.ok && process.env.OATS_EXPLORER_VERBOSE) steps.push(String(r.message).slice(0, 500)); if (!r.ok && (r.code === null || NO_STATE.has(r.code))) broken.push(`${what} answered ${r.code ?? "an error that is no kernel answer"}: ${String(r.message).slice(0, 300)}`); return r; };
  await prepare(fx, from, name, home);
  // The provider's commands act late, so that one whose kernel died during it would act after the next verb.
  const lateFor = (v) => (provider[v] ? {} : { [v]: { sleepMs: LATE_MS } });
  const late = seam.endsWith(":during");
  setControl(name, late ? { ...provider, ...lateFor("launch"), ...lateFor("input"), ...lateFor("stop") } : provider);
  const died = await verb(fx, killed, name, home, { OATS_TEST_PROVIDER_DIE_AT: seam });
  setControl(name, null);
  if (died.signal !== "SIGKILL") return { name, steps, broken: [`"${a}" does not pass the seam ${seam} (it answered ${JSON.stringify(died).slice(0, 200)}): fix the explorer's list`] };
  steps.push(`left: ${stateOf(home)}`);
  const mine = () => [...sessionsOf(fx.events())].filter(([, s]) => s.home === name);
  /** Invariants 1, 2, 4 and 5, as the records and the provider's sessions stand now. */
  const check = (when, { stoppedAt, launched }) => {
    const state = stateOf(home);
    steps.push(`${when}: ${state}`);
    const running = mine().filter(([, s]) => s.running).map(([thread]) => thread);
    const named = receiptOf(home)?.endpoint?.threadId ?? null;
    // 1 and 2. (An unsettled home is unknown to the kernel, which says so to every read: what runs
    // for it is settled by the next verb, and by the retire below.)
    if (state === "running") { for (const thread of running) if (thread !== named) broken.push(`${when}: a session runs that no record names: ${thread} (the home's record names ${named})`); }
    else if (state === "planned" || state === "gone") { if (running.length) broken.push(`${when}: the home is ${state}, and a session of it runs: ${running.join(", ")}`); }
    else if (state === "stopped") {
      // The fence comes first: a kernel that ended after `stoppedAt` and before the provider
      // confirmed leaves the home stopped and its RECORDED session running, which no input
      // reaches, until a stop, a start or a retire asks again (the page, "The holder died"). Once
      // a stop is confirmed nothing runs; and a session the record does not name never does.
      for (const thread of running) {
        if (thread !== named) broken.push(`${when}: the home is stopped, and a session runs that its record does not name: ${thread}`);
        else if (stoppedAt !== null) broken.push(`${when}: the ${b} was confirmed, and the session it stopped runs: ${thread}`);
      }
    }
    else if (state === "no receipt") broken.push(`${when}: the home has a record and no receipt`);
    // 4.
    if (stoppedAt !== null && (state === "stopped" || state === "gone")) {
      const threads = new Set(mine().map(([thread]) => thread));
      const delivered = fx.events().filter((e) => e.ev === "input" && threads.has(e.thread) && e.at > stoppedAt);
      if (delivered.length) broken.push(`${when}: an input was delivered after the ${b} was confirmed (${delivered.length})`);
    }
    // 5.
    if (launched && !(state === "running" && named !== null && running.includes(named))) broken.push(`${when}: ${launched} was answered, and the home is ${state} with ${running.includes(named) ? "its" : "no"} named session running`);
  };
  // The next verb. Then everything a kernel left behind has the time to act, and the invariants
  // are checked BEFORE the input, which would restart a session that something had stopped.
  const next = existsSync(home) ? answered(b, await verb(fx, b, name, home)) : null;
  // A stop that was confirmed: a retire's, an operator's stop (which asks the provider also of a
  // home that is stopped already), and the host's stop when it says it stopped a session (of a
  // home that is stopped already it asks nothing, and says so).
  const stoppedAt = next?.ok && (b === "stop" || b === "retire" || (b === "host stop" && next.stopped)) ? Date.now() : null;
  await sleep(late ? LATE_MS + 300 : 100);
  check(`after ${b}`, { stoppedAt, launched: next?.ok && ["start", "restart", "resume", "input"].includes(b) ? b : null });
  // Then an input, and the same again.
  const input = b !== "input" && existsSync(home) ? answered("input", await verb(fx, "input", name, home)) : null;
  await sleep(100);
  check("after the input", { stoppedAt, launched: input?.ok ? "the input" : null });
  if (input?.ok && stateOf(home) !== "running") broken.push(`an input was answered as submitted to a home that is ${stateOf(home)}`);
  // 3. A retire takes the home, whatever is left of it, and nothing of it runs afterwards.
  if (existsSync(home)) {
    const retired = answered("retire", await verb(fx, "retire", name, home));
    if (!retired.ok) broken.push(`a retire does not take the home (${retired.code}): ${String(retired.message).slice(0, 300)}`);
    await sleep(100);
  }
  const left = mine().filter(([, s]) => s.running).map(([thread]) => thread);
  if (left.length && !existsSync(home)) broken.push(`the home is gone, and a session of it runs: ${left.join(", ")}`);
  return { name, steps, broken };
}

test(`the explorer: a kernel killed at any seam of any verb, then another verb and an input, leaves nothing the page forbids (seed ${SEED}, ${SAMPLE.length} of ${ALL.length} schedules)`, async (t) => {
  assert.ok(SAMPLE.length > 0, "a schedule to run");
  const fx = providerDeployment(t);
  // The provider's behaviour, per home: one writer, written whole (a provider's command reads it at any time).
  const control = { stateful: true };
  const setControl = (name, behaviour) => {
    if (behaviour === null) delete control[name]; else control[name] = behaviour;
    const path = join(fx.fake, "control.json");
    writeFileSync(`${path}.next`, JSON.stringify(control));
    renameSync(`${path}.next`, path);
  };
  setControl("-", null);
  const failures = [];
  let next = 0;
  const worker = async () => {
    for (let n = next++; n < SAMPLE.length; n = next++) {
      const schedule = SAMPLE[n];
      let result;
      // (A setup that did not complete is no schedule: it is made once more, on a new home.)
      try { result = await explore(fx, setControl, n, schedule).catch((e) => { if (!e?.setup) throw e; return explore(fx, setControl, n, schedule, "again"); }); }
      catch (e) { result = { steps: [], broken: [`the explorer itself failed: ${e?.stack ?? e}`] }; }
      if (result.broken.length) failures.push(`\n  OATS_EXPLORER_ONLY="${schedule.a} | ${schedule.seam} | ${schedule.b}" (seed ${SEED}, #${n})\n    steps: ${result.steps.join("; ")}\n    ${result.broken.join("\n    ")}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(process.env.OATS_EXPLORER_WORKERS ?? 6), SAMPLE.length) }, worker));
  assert.equal(failures.length, 0, `${failures.length} of ${SAMPLE.length} schedules broke an invariant:${failures.join("")}`);
});

// The schedules run side by side and share the fake's event log: a read can land while a command
// is appending its line.
test("the fake's events are read by whole lines: a line that is still being written is left for the next read", () => {
  const first = JSON.stringify({ ev: "created", thread: "thr_a_1", home: "a", at: 1 });
  const second = JSON.stringify({ ev: "input", thread: "thr_a_1", at: 2 });
  assert.deepEqual(eventsOf(""), []);
  assert.deepEqual(eventsOf(`${first}\n`), [JSON.parse(first)]);
  // Every cut inside the second line: the first is read, the second not yet.
  for (let cut = 0; cut <= second.length; cut++) assert.deepEqual(eventsOf(`${first}\n${second.slice(0, cut)}`), [JSON.parse(first)], `cut at ${cut}`);
  assert.deepEqual(eventsOf(`${first}\n${second}\n`), [JSON.parse(first), JSON.parse(second)]);
  // A whole line that is no JSON is a damaged log, and says so.
  assert.throws(() => eventsOf(`${first}\n{"ev":\n`), SyntaxError);
});
