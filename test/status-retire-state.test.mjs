// `retire` on status rows (feature status-retire-state, awebai/oats#1247): whether a retire of a
// home is running, cannot be told, failed or was interrupted, read only from what is beside the
// home (lib/core.mjs retireStateOf, lib/retire-state.mjs readRetireState).
//
// The local half lists a hand-made deployment root with listInstances, one home per case, and
// writes beside it exactly the files a retire leaves: the self-retire marker, its result, the
// home's claim. A live process is a child of this test, recorded with its real start time; a gone
// one is a pid that exited and was reaped. The remote half feeds a fake host's status rows to the
// real rosterGroups, as test/needs-input-desktop.test.mjs does for `waitingOnYou`.
//
// The file leaves nothing behind and prints no warning (docs/implementation.md, Tests and gates):
// status asks tmux for windows, so TMUX_TMPDIR is a private directory removed with the fixture, and
// OATS_HOME_DIR is `<short base>/h`, which keeps the roster's ssh control socket path in bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deferredRetireResultPath, listInstances, retireClaimPath, retirePendingMarkerPath } from "../lib/core.mjs";
import { RETIRE_REFUSED_REASON_MAX } from "../lib/instance-events.mjs";
import { readRetireState } from "../lib/retire-state.mjs";
import { REMOTE_ROW_FACTS, rosterGroups, writeServers } from "../lib/servers.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { fixtureBase, privateTmuxTmpdir, removeTmuxTmpdir } from "./helpers/host-fixture.mjs";

const REQUESTED = "2026-10-10T00:00:00.000Z";
const COMPLETED = "2026-10-10T00:00:09.500Z";
const CLAIMED = "2026-10-10T01:00:00.000Z";

let base, tmuxTmpdir;
const prevEnv = { OATS_HOME_DIR: process.env.OATS_HOME_DIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
const children = [];
test.before(() => {
  base = fixtureBase("o-rs-");
  tmuxTmpdir = privateTmuxTmpdir();
  process.env.OATS_HOME_DIR = join(base, "h");
  process.env.TMUX_TMPDIR = tmuxTmpdir;
});
test.after(() => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tmuxTmpdir) removeTmuxTmpdir(tmuxTmpdir);
  if (base) rmSync(base, { recursive: true, force: true });
});

/** A process that runs until the test ends, as a record names it: { pid, processStart }. */
function liveProcess() {
  const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
  children.push(child);
  const processStart = processStartToken(child.pid);
  assert.ok(processStart, "the child's start time reads");
  return { pid: child.pid, processStart, child };
}
/** A real pid whose process has exited and been reaped. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

let n = 0;
/** A fresh deployment root with one soul and one home, and the files beside it that `facts` names:
 *  `marker` (an object, or a string written as is), `result` (likewise), `claim` (an object).
 *  → { root, home } */
function homeWith({ marker, result, claim } = {}) {
  const root = join(base, `root-${++n}`, "agents");
  mkdirSync(join(root, "dev", "soul"), { recursive: true });
  writeFileSync(join(root, "dev", "soul", "soul.yaml"), "name: dev\ndescription: Fixture soul.\nwork: directory\n");
  const home = join(root, "dev", "instances", "dev-a");
  mkdirSync(home, { recursive: true });
  const put = (path, v) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof v === "string" ? v : JSON.stringify(v)); };
  if (marker !== undefined) put(retirePendingMarkerPath(home), marker);
  if (result !== undefined) put(deferredRetireResultPath(home), result);
  if (claim !== undefined) put(retireClaimPath(home), claim);
  return { root, home };
}
/** The row of `home` as `oats status --json` lists it. */
function rowOf({ root }) {
  const rows = listInstances(root, "oats-test-nosuch").find((a) => a.name === "dev").instances;
  assert.equal(rows.length, 1);
  return rows[0];
}
const retireOf = (fx) => rowOf(fx).retire;
/** Every file under `dir` with its bytes and mtime: two equal listings are a tree nothing touched. */
function listing(dir, rel = "") {
  const rows = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(rel, e.name);
    if (e.isDirectory()) rows.push([p, "dir"], ...listing(dir, p));
    else rows.push([p, readFileSync(join(dir, p), "utf8"), statSync(join(dir, p)).mtimeMs]);
  }
  return rows;
}
const failedResult = (extra = {}) => ({ instance: "dev-a", agent: "dev", requestedAt: REQUESTED, completedAt: COMPLETED, ok: false,
  error: { code: "E_RETIRE_FAILED", message: "the retire hook of oats.aweb failed" }, retry: "oats retire dev-a", ...extra });

// ---- the marker: a self-retire, self: true ---------------------------------------------------------

test("a marker beside a failed result reads failed, with the result's time, code and message", () => {
  const done = liveProcess();
  const fx = homeWith({ marker: { requestedAt: REQUESTED, completionPid: done.pid, completionStart: done.processStart }, result: failedResult() });
  assert.deepEqual(retireOf(fx), { state: "failed", since: COMPLETED, self: true, code: "E_RETIRE_FAILED", message: "the retire hook of oats.aweb failed" },
    "the result decides, whatever the completion's liveness");
  const noTime = homeWith({ marker: { requestedAt: REQUESTED }, result: failedResult({ completedAt: "not a time" }) });
  assert.equal(retireOf(noTime).since, REQUESTED, "no completedAt: the marker's requestedAt");
  const MTIME = new Date("2026-10-09T08:07:06.000Z");
  const neither = homeWith({ marker: { requestedAt: null }, result: failedResult({ completedAt: null }) });
  utimesSync(retirePendingMarkerPath(neither.home), MTIME, MTIME);
  assert.equal(retireOf(neither).since, MTIME.toISOString(), "neither: the marker file's mtime");
});

test("a marker whose completion is alive reads running; gone reads interrupted; since is the marker's requestedAt", () => {
  const live = liveProcess();
  assert.deepEqual(retireOf(homeWith({ marker: { requestedAt: REQUESTED, completionPid: live.pid, completionStart: live.processStart } })),
    { state: "running", since: REQUESTED, self: true });
  assert.deepEqual(retireOf(homeWith({ marker: { requestedAt: REQUESTED, completionPid: exitedPid(), completionStart: live.processStart } })),
    { state: "interrupted", since: REQUESTED, self: true });
  assert.deepEqual(retireOf(homeWith({ marker: { requestedAt: REQUESTED, completionPid: live.pid, completionStart: `${live.processStart}0` } })),
    { state: "interrupted", since: REQUESTED, self: true }, "its pid runs with another start: a reused pid, the completion is gone");
});

test("a marker whose completion's liveness cannot be read, or that names no completion, reads unknown", () => {
  const live = liveProcess();
  assert.deepEqual(retireOf(homeWith({ marker: { requestedAt: REQUESTED, completionPid: live.pid } })),
    { state: "unknown", since: REQUESTED, self: true }, "a running pid with no start recorded");
  for (const completionPid of [undefined, null, 0, -1, 1.5, "123"]) {
    assert.deepEqual(retireOf(homeWith({ marker: { requestedAt: REQUESTED, ...(completionPid === undefined ? {} : { completionPid }) } })),
      { state: "unknown", since: REQUESTED, self: true }, `completionPid ${JSON.stringify(completionPid)}`);
  }
});

test("a marker that does not parse as an object reads unknown, since the marker file's mtime", () => {
  const MTIME = new Date("2026-10-09T08:07:06.000Z");
  for (const text of ["{ cut off", "", "[1,2]", "\"retire\"", "42"]) {
    const fx = homeWith({ marker: text });
    utimesSync(retirePendingMarkerPath(fx.home), MTIME, MTIME);
    assert.deepEqual(retireOf(fx), { state: "unknown", since: MTIME.toISOString(), self: true }, JSON.stringify(text));
  }
});

test("a result with ok: true beside a marker still there reads as no result; an unreadable result too", () => {
  const live = liveProcess();
  const marker = { requestedAt: REQUESTED, completionPid: live.pid, completionStart: live.processStart };
  assert.deepEqual(retireOf(homeWith({ marker, result: { ...failedResult(), ok: true } })), { state: "running", since: REQUESTED, self: true });
  assert.deepEqual(retireOf(homeWith({ marker, result: "{ not json" })), { state: "running", since: REQUESTED, self: true });
});

test("the marker comes first: a row with one is self: true whatever the claim says", () => {
  const holder = liveProcess();
  const fx = homeWith({ marker: { requestedAt: REQUESTED, completionPid: exitedPid(), completionStart: holder.processStart },
    claim: { pid: holder.pid, processStart: holder.processStart, at: CLAIMED, action: "retire" } });
  assert.deepEqual(retireOf(fx), { state: "interrupted", since: REQUESTED, self: true });
});

test("a failed result's code is kept only with a kernel code's shape; the state stays failed", () => {
  for (const code of ["ENOENT", "E_lower", "e_RETIRE", "E_", "E_RETIRE FAILED", 42, null, undefined]) {
    const r = retireOf(homeWith({ marker: { requestedAt: REQUESTED }, result: failedResult({ error: { code, message: "m" } }) }));
    assert.deepEqual(r, { state: "failed", since: COMPLETED, self: true, message: "m" }, JSON.stringify(code));
  }
  const noError = retireOf(homeWith({ marker: { requestedAt: REQUESTED }, result: failedResult({ error: undefined }) }));
  assert.deepEqual(noError, { state: "failed", since: COMPLETED, self: true }, "no error object: failed, no code, no message");
});

test("a failed result's message is one line, bounded to a retire's one-line reason, and left out when empty", () => {
  const long = `first line\n\tsecond ${"x".repeat(RETIRE_REFUSED_REASON_MAX * 2)}`;
  const { message } = retireOf(homeWith({ marker: { requestedAt: REQUESTED }, result: failedResult({ error: { code: "E_X", message: long } }) }));
  assert.equal(message.length, RETIRE_REFUSED_REASON_MAX);
  assert.ok(message.startsWith("first line second x"), "whitespace collapsed to one space");
  assert.ok(message.endsWith("…"));
  for (const empty of ["", "  \n ", 7, null]) {
    const r = retireOf(homeWith({ marker: { requestedAt: REQUESTED }, result: failedResult({ error: { code: "E_X", message: empty } }) }));
    assert.deepEqual(r, { state: "failed", since: COMPLETED, self: true, code: "E_X" }, JSON.stringify(empty));
  }
});

test("since is always there, a toISOString() instant: a recorded time that is not one gives the marker file's mtime", () => {
  const MTIME = new Date("2026-10-09T08:07:06.000Z");
  for (const requestedAt of [undefined, null, "yesterday", "2026-10-10T00:00:00Z", "2026-02-30T00:00:00.000Z", 1760000000000]) {
    const fx = homeWith({ marker: { ...(requestedAt === undefined ? {} : { requestedAt }) } });
    utimesSync(retirePendingMarkerPath(fx.home), MTIME, MTIME);
    assert.deepEqual(retireOf(fx), { state: "unknown", since: MTIME.toISOString(), self: true }, JSON.stringify(requestedAt));
  }
});

// ---- no marker: another process's retire, self: false ----------------------------------------------

test("an external retire's claim held alive reads running, self: false, since the claim's time", () => {
  const holder = liveProcess();
  const fx = homeWith({ claim: { pid: holder.pid, processStart: holder.processStart, at: CLAIMED, action: "retire" } });
  const row = rowOf(fx);
  assert.deepEqual(row.retire, { state: "running", since: CLAIMED, self: false });
  assert.equal(Object.hasOwn(row, "retirePending"), false, "retirePending is unchanged: no marker, no retirePending");
  const older = homeWith({ claim: { pid: holder.pid, processStart: holder.processStart, at: CLAIMED } });
  assert.deepEqual(retireOf(older), { state: "running", since: CLAIMED, self: false }, "a claim that names no verb is a retire's (an older kernel's)");
  const MTIME = new Date("2026-10-09T08:07:06.000Z");
  const badTime = homeWith({ claim: { pid: holder.pid, processStart: holder.processStart, at: "soon", action: "retire" } });
  utimesSync(retireClaimPath(badTime.home), MTIME, MTIME);
  assert.deepEqual(retireOf(badTime), { state: "running", since: MTIME.toISOString(), self: false }, "a claim time that is not an instant: the claim file's mtime");
});

test("a retire's claim whose holder's liveness cannot be read reads unknown, self: false", () => {
  const holder = liveProcess();
  assert.deepEqual(retireOf(homeWith({ claim: { pid: holder.pid, at: CLAIMED, action: "retire" } })), { state: "unknown", since: CLAIMED, self: false });
});

test("no retire field: a gone holder, a stop's claim, an unreadable claim, or no claim", () => {
  const holder = liveProcess();
  const cases = {
    "a gone holder": { claim: { pid: exitedPid(), processStart: holder.processStart, at: CLAIMED, action: "retire" } },
    "a stop's claim, alive": { claim: { pid: holder.pid, processStart: holder.processStart, at: CLAIMED, action: "stop" } },
    "a stop's claim, unknown": { claim: { pid: holder.pid, at: CLAIMED, action: "stop" } },
    "a claim that does not parse": { claim: "{ cut" },
    "nothing": {},
  };
  for (const [what, facts] of Object.entries(cases)) {
    const row = rowOf(homeWith(facts));
    assert.equal(Object.hasOwn(row, "retire"), false, what);
  }
  const failedNoMarker = homeWith({ result: failedResult() });
  const listed = listInstances(failedNoMarker.root, "oats-test-nosuch").find((a) => a.name === "dev");
  assert.equal(Object.hasOwn(listed.instances[0], "retire"), false, "a failed result without a marker: the home is owed nothing");
  assert.equal(listed.retireFailures.length, 1, "and the agent row's retireFailures holds it, as before");
});

test("status only reads: no file beside the home changes, and no process is signalled", () => {
  const holder = liveProcess(), completion = liveProcess();
  const fx = homeWith({ marker: { requestedAt: REQUESTED, completionPid: completion.pid, completionStart: completion.processStart },
    result: { ...failedResult(), ok: true }, claim: { pid: holder.pid, processStart: holder.processStart, at: CLAIMED, action: "retire" } });
  const gone = homeWith({ claim: { pid: exitedPid(), processStart: holder.processStart, at: CLAIMED, action: "retire" } });
  const before = [listing(join(fx.root, "..")), listing(join(gone.root, ".."))];
  assert.equal(retireOf(fx).state, "running");
  assert.equal(Object.hasOwn(rowOf(gone), "retire"), false);
  assert.deepEqual([listing(join(fx.root, "..")), listing(join(gone.root, ".."))], before, "a gone holder's claim is not taken over or removed");
  assert.ok(isAlive(holder.pid) && isAlive(completion.pid));
  assert.equal(holder.child.signalCode, null); assert.equal(completion.child.signalCode, null);
});

test("a retire recorded in instance.json never stands in for the one read beside the home", () => {
  const live = liveProcess();
  for (const recorded of [{ state: "running", since: CLAIMED, self: false }, null, { state: "not-a-state", since: null, self: 123 }, "retiring"]) {
    const none = homeWith();
    writeFileSync(join(none.home, "instance.json"), JSON.stringify({ instance: "dev-a", agent: "dev", retire: recorded }));
    assert.equal(Object.hasOwn(rowOf(none), "retire"), false, `no marker, no claim: ${JSON.stringify(recorded)}`);
    const marked = homeWith({ marker: { requestedAt: REQUESTED, completionPid: live.pid, completionStart: live.processStart } });
    writeFileSync(join(marked.home, "instance.json"), JSON.stringify({ instance: "dev-a", agent: "dev", retire: recorded }));
    assert.deepEqual(rowOf(marked).retire, { state: "running", since: REQUESTED, self: true }, `with a marker: ${JSON.stringify(recorded)}`);
  }
});

const hasMkfifo = !spawnSync("mkfifo", ["--version"], { stdio: "ignore" }).error;
test("a pipe or a directory at the claim or the result path is no value, and status does not hang on it", { skip: !hasMkfifo && "mkfifo is not installed" }, () => {
  const holder = liveProcess();
  const atClaim = homeWith(), atResult = homeWith({ marker: { requestedAt: REQUESTED, completionPid: holder.pid, completionStart: holder.processStart } });
  const dirClaim = homeWith(), dirResult = homeWith({ marker: { requestedAt: REQUESTED, completionPid: holder.pid, completionStart: holder.processStart } });
  mkdirSync(join(retireClaimPath(atClaim.home), ".."), { recursive: true });
  for (const path of [retireClaimPath(atClaim.home), deferredRetireResultPath(atResult.home)]) assert.equal(spawnSync("mkfifo", [path]).status, 0);
  mkdirSync(retireClaimPath(dirClaim.home), { recursive: true }); mkdirSync(deferredRetireResultPath(dirResult.home));
  // In a child, bounded: a read that blocks on the pipe would never return to this test.
  const script = `import { listInstances } from ${JSON.stringify(new URL("../lib/core.mjs", import.meta.url).href)};
    const rows = (root) => listInstances(root, "oats-test-nosuch").find((a) => a.name === "dev").instances;
    console.log(JSON.stringify(${JSON.stringify([atClaim.root, atResult.root, dirClaim.root, dirResult.root])}.map((r) => rows(r)[0].retire ?? null)));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.error, undefined, "status returned"); assert.equal(r.status, 0, r.stderr);
  const running = { state: "running", since: REQUESTED, self: true };
  assert.deepEqual(JSON.parse(r.stdout), [null, running, null, running], "a claim that is not a file is no claim; a result that is not a file is no result");
});

// ---- the read rule, on its own -----------------------------------------------------------------------

test("readRetireState: since is required; code and message belong to failed only, strings or absent, never null", () => {
  assert.deepEqual(readRetireState({ state: "running", since: REQUESTED, self: true, code: "E_X", message: "m" }), { state: "running", since: REQUESTED, self: true });
  assert.deepEqual(readRetireState({ state: "failed", since: REQUESTED, self: false, code: "E_X", message: "m", extra: 1 }), { state: "failed", since: REQUESTED, self: false, code: "E_X", message: "m" });
  assert.deepEqual(readRetireState({ state: "failed", since: REQUESTED, self: true, code: null, message: null }), { state: "failed", since: REQUESTED, self: true });
  const S = { since: REQUESTED };
  for (const v of [undefined, null, "running", 1, [], [{ state: "running", self: true, ...S }], {}, { state: "done", self: true, ...S }, { state: "running", ...S },
    { state: "running", self: "true", ...S }, { state: "Running", self: true, ...S }, { state: "running", self: true }, { state: "failed", self: true, since: null },
    { state: "running", self: true, since: "yesterday" }, { state: "running", self: true, since: "2026-10-10T00:00:00Z" }]) {
    assert.equal(readRetireState(v), undefined, JSON.stringify(v));
  }
});

// ---- remote rows: relayed only when present, by the same rule ------------------------------------------

const PROBE = { schemaVersion: 1, name: "@awebai/oats", version: "0.69.15", desktopApi: 1, harnesses: ["claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["session"], features: ["harness"] };
const HOME = (name) => `/srv/ws/agents/dev/instances/${name}`;
const hostRow = (name, extra = {}) => ({ instance: name, home: HOME(name), harness: "claude", running: true, tmux: { session: "oats-agents", window: name }, ...extra });
/** The one group rosterGroups builds from a fake host answering `status --json` with `rows`, plus a
 *  saved route (`dev-gone`) the host does not list. */
async function roster(rows, server = "build") {
  writeServers({ [server]: { sshHost: `${server}-host`, workspace: "/srv/ws" } });
  const snapDir = join(process.env.OATS_HOME_DIR, "remote", server);
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "dev-gone.json"), JSON.stringify({ serverId: server, instance: "dev-gone", agent: "dev", home: HOME("dev-gone"), agentsRoot: "/srv/ws/agents", target: { sshHost: `${server}-host`, workspace: "/srv/ws", oatsPath: "oats" } }));
  const status = { root: "/srv/ws/agents", agents: [{ name: "dev", harness: "claude", instances: rows }] };
  const exec = async (_bin, argv) => (String(argv.at(-1)).endsWith("version --json") ? JSON.stringify(PROBE) : JSON.stringify(status));
  try {
    const out = await rosterGroups({ server, io: { execFileAsync: exec, serverId: `${server}-${Math.random()}` } });
    assert.equal(out.groups.length, 1);
    return out.groups[0];
  } finally { rmSync(snapDir, { recursive: true, force: true }); }
}
const remoteRow = (group, name) => group.instances.find((r) => r.instance === name);

test("rosterGroups relays a host row's retire as the kernel reads it, and only when the host's row has the key", async () => {
  const FAILED = { state: "failed", since: COMPLETED, self: true, code: "E_RETIRE_FAILED", message: "the hook failed" };
  const g = await roster([hostRow("dev-a", { retire: FAILED }), hostRow("dev-b", { retire: { state: "running", since: CLAIMED, self: false } }), hostRow("dev-old")]);
  assert.deepEqual(remoteRow(g, "dev-a").retire, FAILED);
  assert.deepEqual(remoteRow(g, "dev-b").retire, { state: "running", since: CLAIMED, self: false });
  assert.equal(Object.hasOwn(remoteRow(g, "dev-old"), "retire"), false, "a host whose kernel predates the feature: no key");
  assert.equal(Object.hasOwn(remoteRow(g, "dev-gone"), "retire"), false, "a saved route the host does not list: no key");
  assert.equal(REMOTE_ROW_FACTS.includes("retire"), false, "it is not a fact that reads null when missing");
  const { retire: _relayed, ...rest } = remoteRow(g, "dev-a");
  assert.deepEqual(Object.keys(rest).sort(), Object.keys(remoteRow(g, "dev-old")).sort(), "nothing else on the row changes");
});

test("rosterGroups drops a host's retire that the kernel's read refuses, and trims what it leaves out", async () => {
  const refused = { "null": null, "a string": "running", "an array": [{ state: "running", self: true }], "an empty object": {},
    "an unknown state": { state: "done", since: CLAIMED, self: true }, "no self": { state: "running", since: CLAIMED }, "a self that is a string": { state: "running", since: CLAIMED, self: "false" },
    "no since": { state: "failed", self: true, code: "E_X" }, "a null since": { state: "running", since: null, self: false }, "a since that is not an instant": { state: "interrupted", since: "yesterday", self: true } };
  const names = Object.keys(refused).map((_, i) => `dev-r${i}`);
  const g = await roster([
    ...Object.values(refused).map((retire, i) => hostRow(names[i], { retire })),
    hostRow("dev-trim", { retire: { state: "interrupted", since: CLAIMED, self: true, code: "E_X", message: "m", extra: "x" } }),
    hostRow("dev-long", { retire: { state: "failed", since: COMPLETED, self: true, code: "not a code", message: `a\n${"y".repeat(RETIRE_REFUSED_REASON_MAX)}` } }),
  ]);
  Object.keys(refused).forEach((what, i) => assert.equal(Object.hasOwn(remoteRow(g, names[i]), "retire"), false, what));
  assert.deepEqual(remoteRow(g, "dev-trim").retire, { state: "interrupted", since: CLAIMED, self: true });
  const long = remoteRow(g, "dev-long").retire;
  assert.deepEqual(Object.keys(long), ["state", "since", "self", "message"]);
  assert.equal(long.message.length, RETIRE_REFUSED_REASON_MAX); assert.ok(long.message.startsWith("a y") && long.message.endsWith("…"));
});
