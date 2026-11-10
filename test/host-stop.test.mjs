// A stop with the host (oats-project/oats#1789): what `oats host run` does to each running home
// when the host stops. The stop is the one `oats instance stop`, a retire and a restart use
// (lib/core.mjs stopInstanceSession), with one difference: its record (`.oats-stop.json`) says
// `resume: true` and `reason: "host-stop"`, is written before anything is signalled, and reads
// `lost`, never `stopped`, so the next start's sweep brings the home back. No fourth `sessionEnd`.
//
// The reading is tested on files; the stop itself on a real session on the fixture's own tmux
// server, its only seam the `kill` the stop already takes, which here sends the real signal after
// noting what the home held at that moment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { leaveEnclosingInstance, waitUntil } from "./helpers/host-fixture.mjs";
import { inspectInstanceSession, listInstances, shq, startInstanceSession, stopInstanceSession } from "../lib/core.mjs";
import { HOST_STOP_REASON, lostReasonOf, sessionEndOf } from "../lib/session-end.mjs";
import { SESSION_END } from "../lib/session-resume-contract.mjs";
import { readSeen, resumeEligible, homeKey } from "../lib/session-seen.mjs";
import { lostLine } from "../lib/status-words.mjs";

const STOP_CHILD = fileURLToPath(new URL("../lib/host-stop-child.mjs", import.meta.url));
const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !hasTmux && "tmux is not installed" };
const scratch = (t) => { const d = mkdtempSync(join(tmpdir(), "oats-host-stop-")); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const write = (home, name, value) => writeFileSync(join(home, name), JSON.stringify(value));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the reason's name is host-stop", () => {
  assert.equal(HOST_STOP_REASON, "host-stop");
});

test("sessionEnd: a stop record that asks for a resume reads lost, whatever the exit marker says, and only for the start it names", (t) => {
  const created = "2026-10-01T10:00:00.000Z", restarted = "2026-10-02T10:00:00.000Z";
  const meta = { startId: "s2", createdAt: created, restarts: [{ startedAt: restarted }] };
  const before = "2026-10-01T12:00:00.000Z", after = "2026-10-02T12:00:00.000Z";
  const withHost = { resume: true, reason: "host-stop" };
  const rows = [
    ["stopped with the host, nothing else: the record written before the signal", { stop: { at: after, startId: "s2", stop: null, ...withHost } }, SESSION_END.LOST, "host-stop"],
    ["stopped with the host, the harness then ended with status 0", { stop: { at: after, startId: "s2", ...withHost }, exited: { startId: "s2", status: 0 } }, SESSION_END.LOST, "host-stop"],
    ["stopped with the host, beside its 143", { stop: { at: after, startId: "s2", ...withHost }, exited: { startId: "s2", status: 143 } }, SESSION_END.LOST, "host-stop"],
    ["stopped with the host, a record without a start id, after this start", { stop: { at: after, ...withHost } }, SESSION_END.LOST, "host-stop"],
    ["an earlier start was stopped with the host, this one ended on its own", { stop: { at: after, startId: "s1", ...withHost }, exited: { startId: "s2", status: 0 } }, SESSION_END.EXITED, null],
    ["an earlier start was stopped with the host, before this start, no start id", { stop: { at: before, ...withHost } }, SESSION_END.LOST, null],
    ["a resume that is not true is an ordinary stop", { stop: { at: after, startId: "s2", resume: "yes", reason: "host-stop" } }, SESSION_END.STOPPED, null],
    ["an ordinary stop", { stop: { at: after, startId: "s2" } }, SESSION_END.STOPPED, null],
    ["a resume for a reason this kernel does not know still reads lost, with no reason to show", { stop: { at: after, startId: "s2", resume: true, reason: "something-else" } }, SESSION_END.LOST, null],
    ["neither file", {}, SESSION_END.LOST, null],
  ];
  for (const [what, files, end, reason] of rows) {
    const home = scratch(t);
    if (files.stop) write(home, ".oats-stop.json", { instance: "x", retained: [], ...files.stop });
    if (files.exited) write(home, ".oats-start-exited", files.exited);
    assert.equal(sessionEndOf(home, meta), end, what);
    assert.equal(lostReasonOf(home, meta), reason, `${what}: the reason`);
  }
});

test("where a lost row says how to bring it back, a home stopped with the host says so", (t) => {
  const home = scratch(t);
  const row = { instance: "dev-1", home, running: false, sessionEnd: SESSION_END.LOST, startId: "s1", createdAt: "2026-10-01T10:00:00.000Z" };
  const way = `oats session start --resume --home ${home} brings it back; so does the next oats session resume (run when OATS Desktop or oats tui opens) if it can vouch for the loss`;
  assert.equal(lostLine(row), `lost: ${way}`, "no record: any other loss, as before");
  write(home, ".oats-stop.json", { instance: "dev-1", at: "2026-10-01T12:00:00.000Z", startId: "s1", resume: true, reason: "host-stop" });
  assert.equal(lostLine(row), `lost (stopped with the host): ${way}`);
  assert.equal(lostLine(row, { host: "build-host" }), `lost: on build-host, run oats session start --resume --home ${home} there, or its next oats session resume`, "a host's row: its home is not this machine's to read");
  assert.equal(lostLine({ ...row, sessionEnd: SESSION_END.STOPPED }), null);
});

// ------------------------------------------------------------- a real session

const fixtures = [];
test.afterEach(() => { for (const fx of fixtures.splice(0)) fx.cleanup(); });

/** A deployment with one home whose session, once started on the fixture's own `oats` server, runs
 *  a fixture in place of a harness: it writes its pid to `harness-ready` in the home and execs a
 *  sleep (as test/schedule-gone-server.test.mjs does). → { fx, home, instance }. */
async function runningHome(t, purpose) {
  const fx = v2Deployment({ souls: { dev: { soul: { work: "directory" } } } });
  fixtures.push(fx);
  await fx.prepare("dev");
  t.after(leaveEnclosingInstance(fx.base)); // this worker starts a tmux server: as no instance
  const harness = join(fx.base, "fixture-harness");
  writeFileSync(harness, `#!/bin/sh\necho $$ > "$OATS_INSTANCE_HOME/harness-ready.tmp"\n/bin/mv "$OATS_INSTANCE_HOME/harness-ready.tmp" "$OATS_INSTANCE_HOME/harness-ready"\nexec sleep 600\n`, { mode: 0o755 });
  const r = fx.cli(["spawn", "dev", "--purpose", purpose, "--harness", "claude", "--no-launch", "--json"]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const { home, instance } = r.json().result;
  const metaPath = join(home, "instance.json");
  const { launch: _recipe, ...meta } = readJson(metaPath);
  writeFileSync(metaPath, JSON.stringify({ ...meta, command: `OATS_INSTANCE=${shq(instance)} OATS_INSTANCE_HOME=${shq(home)} ${shq(harness)} --dangerously-skip-permissions -- "$(cat TASK.md)"`, launched: false }));
  await fx.inEnv(() => startInstanceSession(home));
  const sleeps = () => {
    try {
      const pid = readFileSync(join(home, "harness-ready"), "utf8").trim();
      return execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim().split("/").pop() === "sleep";
    } catch { return false; }
  };
  await waitUntil(() => sleeps() && fx.inEnv(() => { try { return inspectInstanceSession(home).state === "unknown"; } catch { return false; } }), "the home's command runs");
  return { fx, home, instance };
}
/** The home's status row, as a local listing of its deployment reads it (and records what it saw). */
const rowOf = (fx, home) => fx.inEnv(() => listInstances(join(fx.dep, "agents")).flatMap((a) => a.instances).find((i) => homeKey(i.home) === homeKey(home)));

test("a stop with the host writes its record before it signals the harness, and the home then reads lost and is one the sweep resumes", TMUX, async (t) => {
  const { fx, home, instance } = await runningHome(t, "with-host");
  const startId = readJson(join(home, "instance.json")).startId;
  assert.equal(typeof startId, "string");
  assert.equal((await rowOf(fx, home)).running, true, "a listing saw it running");
  let atSignal = null;
  const kill = (pid, signal) => {
    if (signal !== 0 && atSignal === null) atSignal = existsSync(join(home, ".oats-stop.json")) ? readJson(join(home, ".oats-stop.json")) : "no record";
    return process.kill(pid, signal);
  };
  const stopped = await fx.inEnv(() => stopInstanceSession(home, { graceMs: 10000, withHost: true, io: { kill } }));
  assert.equal(stopped.stopped, true);
  assert.deepEqual([atSignal.instance, atSignal.startId, atSignal.resume, atSignal.reason, atSignal.stop], [instance, startId, true, "host-stop", null], "the record was there, asking for a resume, when the first signal was sent");
  const record = readJson(join(home, ".oats-stop.json"));
  assert.deepEqual([record.startId, record.resume, record.reason, record.stop.signal, record.stop.exited], [startId, true, "host-stop", "SIGTERM", true], "after the stop it also says what was done to the harness");
  await waitUntil(() => existsSync(join(home, ".oats-start-exited")), "the session's start wrapper to exit");
  const row = await rowOf(fx, home);
  assert.deepEqual([row.running, row.sessionEnd], [false, SESSION_END.LOST]);
  assert.equal(lostReasonOf(home, row), "host-stop");
  // What the listings recorded of it is what the sweep needs: seen running, then seen lost.
  const seen = await fx.inEnv(() => readSeen(join(fx.dep, "agents")).homes[homeKey(home)]);
  assert.deepEqual(resumeEligible(seen, row, { now: Date.now() }), { eligible: true });
});

test("an ordinary stop of the same kind of home reads stopped: only a stop with the host is resumed", TMUX, async (t) => {
  const { fx, home } = await runningHome(t, "ordinary");
  await fx.inEnv(() => stopInstanceSession(home, { graceMs: 10000 }));
  const record = readJson(join(home, ".oats-stop.json"));
  assert.deepEqual([Object.hasOwn(record, "resume"), Object.hasOwn(record, "reason")], [false, false]);
  await waitUntil(() => existsSync(join(home, ".oats-start-exited")), "the session's start wrapper to exit");
  assert.equal((await rowOf(fx, home)).sessionEnd, SESSION_END.STOPPED);
  // Found idle afterwards, a stop with the host signals nothing and records nothing: the home keeps reading stopped.
  const idle = await fx.inEnv(() => stopInstanceSession(home, { withHost: true }));
  assert.deepEqual([idle.stopped, idle.alreadyIdle], [false, true]);
  assert.deepEqual(readJson(join(home, ".oats-stop.json")), record);
});

test("the private child of oats host run stops one home with the host and answers one JSON line; a home it cannot stop is an answer too, never a crash", TMUX, async (t) => {
  const { fx, home } = await runningHome(t, "by-child");
  const child = (...argv) => new Promise((done) => execFile(process.execPath, [STOP_CHILD, ...argv], { env: fx.env, encoding: "utf8" }, (error, stdout, stderr) => done({ status: error ? error.code : 0, stdout, stderr })));
  const r = await child(home, "10000");
  assert.equal(r.status, 0, r.stderr);
  const answer = JSON.parse(r.stdout);
  assert.deepEqual([answer.ok, answer.home, answer.stopped, answer.alreadyIdle], [true, home, true, false]);
  assert.deepEqual([readJson(join(home, ".oats-stop.json")).resume, readJson(join(home, ".oats-stop.json")).reason], [true, "host-stop"]);
  await waitUntil(() => existsSync(join(home, ".oats-start-exited")), "the session's start wrapper to exit");
  assert.equal((await rowOf(fx, home)).sessionEnd, SESSION_END.LOST);
  const bad = await child("relative/home", "10000");
  assert.equal(bad.status, 0, bad.stderr);
  assert.deepEqual([JSON.parse(bad.stdout).ok, JSON.parse(bad.stdout).code], [false, "E_BAD_ARGS"]);
});
