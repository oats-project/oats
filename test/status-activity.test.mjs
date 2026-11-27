// Feature status-activity (KP-5, oats-project/oats#2122): the turn fact. `activity` on `oats status --json`
// instance rows and on `oats server roster --json` rows: "working" (the harness started a turn that has
// not ended), "idle" (its last turn ended and no new one started) or null (OATS cannot tell), present
// only on a row whose session is there, and never stale (lib/turn-activity.mjs):
// - a tmux home: only with `running: true`, from `<home>/.oats/turn.json`, the last boundary the
//   harness's own hooks wrote, counted only from the row's `startedAt`;
// - a provider home: the provider's own answer at that read (`activity` in its inspect result), on a
//   session that is there and that OATS started; the file is never read there.
// The tmux homes are real spawns recorded on a private tmux server; the provider homes are real
// spawns on the fake provider (test/helpers/session-provider-fixture.mjs). Who writes the record is
// each harness's own test: packages/pi/test/turn-record.test.mjs for pi; oats.core's Claude Code
// hooks bring theirs with them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retirePendingMarkerPath, storedTreeDigest } from "../lib/core.mjs";
import { KERNEL_FEATURES, STATUS_ACTIVITY_FEATURE } from "../lib/kernel-features.mjs";
import { rosterGroups, writeServers } from "../lib/servers.mjs";
import { judgeInspect } from "../lib/session-providers.mjs";
import { ACTIVITY, CLAUDE_OPEN_TURN_MAX_MS, RECORD_MAX, START_PENDING_FILE, TURN_EVENT, TURN_FILE, readActivity, tmuxActivity } from "../lib/turn-activity.mjs";
import { deploymentStatusData } from "../packages/client/deployment-data.mjs";
import { remotePanel } from "../packages/client/remote-roster.mjs";
import { endServers, recordLaunch, startServer, tmuxOn, SESSION } from "./helpers/recorded-tmux-server.mjs";
import { LOST, fakeManifest, fakeProvider, providerDeployment } from "./helpers/session-provider-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const rowsOf = (fx) => JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((agent) => agent.instances);
const rowOf = (fx, name) => rowsOf(fx).find((row) => row.instance === name);
/** What a row says of the turn: its value, or "absent" for a row with no key. */
const said = (row) => (Object.hasOwn(row, "activity") ? row.activity : "absent");
const metaOf = (home) => JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
const record = (home, fields) => writeFileSync(join(home, "instance.json"), JSON.stringify({ ...metaOf(home), ...fields }, null, 2) + "\n");
/** Write the home's turn record as a hook does: `event` at `at` (an instant in ms). */
const turn = (home, event, at) => writeFileSync(join(home, TURN_FILE), `${JSON.stringify({ event, at: new Date(at).toISOString() })}\n`);

// ------------------------------------------------------------------------------------ the read's rule

test("the feature is listed by version and by status, and a row's value is one of three", (t) => {
  const fx = v2Deployment({ t });
  assert.equal(STATUS_ACTIVITY_FEATURE, "status-activity");
  assert.equal(KERNEL_FEATURES.includes("status-activity"), true);
  assert.equal(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("status-activity"), true);
  assert.equal(JSON.parse(fx.cli(["status", "--json"]).stdout).features.includes("status-activity"), true);
  assert.deepEqual([readActivity("working"), readActivity("idle"), readActivity(null)], ["working", "idle", null]);
  for (const value of [undefined, "", "busy", "Working", "IDLE", true, false, 0, 1, {}, [], ["idle"]]) assert.equal(readActivity(value), undefined, JSON.stringify(value));
});

test("a tmux home's record: counted from startedAt, and anything that is not a record reads null", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-turn-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const started = Date.parse("2026-11-25T10:00:00.000Z"), startedAt = new Date(started).toISOString();
  const read = (extra = {}) => tmuxActivity(home, { startedAt, now: started + 60_000, ...extra });
  const file = join(home, TURN_FILE);
  // No `.oats` directory, then no file: a harness or a hook that never wrote one.
  assert.equal(read(), null, "no .oats directory");
  mkdirSync(join(home, ".oats"));
  assert.equal(read(), null, "no file");

  // The first turn of a start: a launch prompt's turn-start, dated after the start, reads working
  // before its first turn-end; then the turn ends.
  turn(home, TURN_EVENT.START, started + 1000);
  assert.equal(read(), ACTIVITY.WORKING);
  turn(home, TURN_EVENT.END, started + 2000);
  assert.equal(read(), ACTIVITY.IDLE);
  // A boundary at the start's own instant counts; one from before it is the last session's.
  turn(home, TURN_EVENT.START, started);
  assert.equal(read(), ACTIVITY.WORKING, "at startedAt");
  for (const event of [TURN_EVENT.START, TURN_EVENT.END]) {
    turn(home, event, started - 1);
    assert.equal(read(), null, `${event} one millisecond before startedAt`);
  }
  // A row with no start, or one that is no instant, has nothing to count from.
  turn(home, TURN_EVENT.END, started + 1000);
  for (const bad of [null, undefined, "", "yesterday", 1764064800000, {}]) assert.equal(tmuxActivity(home, { startedAt: bad }), null, JSON.stringify(bad));
  // A record's other keys are not read.
  writeFileSync(file, JSON.stringify({ event: "turn-end", at: new Date(started + 5).toISOString(), session: "s-1", activity: "working" }));
  assert.equal(read(), ACTIVITY.IDLE);

  // A start under way: its pending receipt names its instant before the row does (the record is
  // written once the pane is made and the launch prompt seen), and the new harness already runs. A
  // record dated between the row's startedAt and the pending start is the previous session's.
  const pendingFile = join(home, START_PENDING_FILE);
  const pendingAt = (ms) => writeFileSync(pendingFile, JSON.stringify({ id: "s-2", target: { backend: "tmux" }, command: "pi", model: null, startedAt: new Date(ms).toISOString() }));
  for (const event of [TURN_EVENT.START, TURN_EVENT.END]) {
    turn(home, event, started + 30_000);
    pendingAt(started + 40_000);
    assert.equal(read(), null, `${event} before a pending start`);
    // The new start's own boundary counts, at its instant and after.
    turn(home, event, started + 40_000);
    assert.equal(read(), event === TURN_EVENT.START ? ACTIVITY.WORKING : ACTIVITY.IDLE);
  }
  // Once the start is recorded the receipt stays, with the row's own instant: nothing changes.
  assert.equal(tmuxActivity(home, { startedAt: new Date(started + 40_000).toISOString(), now: started + 60_000 }), ACTIVITY.IDLE);
  // An older receipt (an earlier start's) never moves the count back before the row's startedAt.
  pendingAt(started - 60_000);
  turn(home, TURN_EVENT.END, started - 1);
  assert.equal(read(), null);
  // With no startedAt on the row (a start whose record was never written), the receipt's counts.
  turn(home, TURN_EVENT.START, started - 30_000);
  assert.equal(tmuxActivity(home, { startedAt: null }), ACTIVITY.WORKING);
  turn(home, TURN_EVENT.START, started - 60_001);
  assert.equal(tmuxActivity(home, { startedAt: null }), null);
  // A receipt that is none says nothing: bad JSON, no instant, a link.
  turn(home, TURN_EVENT.END, started + 30_000);
  for (const bytes of ["{", "null", JSON.stringify({ startedAt: "soon" }), JSON.stringify({ startedAt: started + 40_000 })]) {
    writeFileSync(pendingFile, bytes);
    assert.equal(read(), ACTIVITY.IDLE, bytes);
  }
  rmSync(pendingFile);
  writeFileSync(join(home, "later.json"), JSON.stringify({ startedAt: new Date(started + 40_000).toISOString() }));
  symlinkSync(join(home, "later.json"), pendingFile);
  assert.equal(read(), ACTIVITY.IDLE, "a linked receipt is not followed");
  rmSync(pendingFile);

  // Bad JSON, a missing field, an unknown event, an `at` that is no instant, no object.
  const at = new Date(started + 1000).toISOString();
  for (const [what, bytes] of [
    ["empty", ""], ["bad JSON", "{\"event\":\"turn-start\","], ["a torn write", "{\"event\":\"turn-en"], ["no event", JSON.stringify({ at })], ["no at", JSON.stringify({ event: "turn-start" })],
    ["an unknown event", JSON.stringify({ event: "turn-pause", at })], ["an event in another case", JSON.stringify({ event: "Turn-Start", at })], ["an event that is no string", JSON.stringify({ event: 1, at })],
    ["the value itself as the event", JSON.stringify({ event: "working", at })], ["an at that is no instant", JSON.stringify({ event: "turn-start", at: "soon" })],
    ["an at that is a number", JSON.stringify({ event: "turn-start", at: started + 1000 })], ["null", "null"], ["an array", JSON.stringify([{ event: "turn-start", at }])], ["a string", "\"turn-start\""],
    ["over the bound", JSON.stringify({ event: "turn-start", at, pad: "x".repeat(RECORD_MAX) })],
  ]) {
    writeFileSync(file, bytes);
    assert.equal(read(), null, what);
  }
  // Not a regular file: a link is never followed, to a good record either; a directory.
  const elsewhere = join(home, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify({ event: "turn-start", at }));
  rmSync(file);
  symlinkSync(elsewhere, file);
  assert.equal(read(), null, "a link to a record");
  rmSync(file);
  mkdirSync(file);
  assert.equal(read(), null, "a directory");
  // Nor is `.oats` itself followed when it is a link.
  rmSync(join(home, ".oats"), { recursive: true });
  mkdirSync(join(home, "real"));
  writeFileSync(join(home, "real", "turn.json"), JSON.stringify({ event: "turn-start", at }));
  symlinkSync(join(home, "real"), join(home, ".oats"));
  assert.equal(read(), null, "a linked .oats");
});

test("Claude Code: a turn that started and wrote no end reads working for 30 minutes, then null; an ended one stays idle; pi is not bounded, and Codex reads null always", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-turn-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".oats"));
  const started = Date.parse("2026-11-25T10:00:00.000Z"), startedAt = new Date(started).toISOString(), at = started + 1000;
  assert.equal(CLAUDE_OPEN_TURN_MAX_MS, 30 * 60 * 1000);
  turn(home, TURN_EVENT.START, at);
  const read = (harness, age) => tmuxActivity(home, { startedAt, harness, now: at + age });
  assert.equal(read("claude", 0), "working");
  assert.equal(read("claude", CLAUDE_OPEN_TURN_MAX_MS), "working", "at 30 minutes");
  assert.equal(read("claude", CLAUDE_OPEN_TURN_MAX_MS + 1), null, "past 30 minutes: an interrupt fires no hook, so OATS cannot tell");
  for (const harness of ["pi", null, undefined]) assert.equal(read(harness, 24 * 60 * 60 * 1000), "working", `${harness}: its end is always written`);
  // Codex reads null, always: nothing is written for it, and a record that stands in its home
  // (written by hand, or by a pi started inside it) is never read as its turn.
  for (const event of [TURN_EVENT.START, TURN_EVENT.END]) {
    turn(home, event, at);
    assert.equal(read("codex", 0), null, `codex: ${event}`);
  }
  turn(home, TURN_EVENT.START, at);
  turn(home, TURN_EVENT.END, at);
  assert.equal(read("claude", 24 * 60 * 60 * 1000), "idle", "a turn that ended is idle however long ago");
});

test("the turn record is not work: a home's stored digest passes over it and over a write's temporary file", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-turn-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".oats"));
  writeFileSync(join(home, "AGENTS.md"), "# x\n");
  const digest = () => storedTreeDigest(home, 2, { instanceHome: true });
  const before = digest();
  turn(home, TURN_EVENT.START, Date.now());
  writeFileSync(join(home, ".oats", "turn.json.4242.tmp"), "{");
  writeFileSync(join(home, ".oats", "turn.json.tmp-4242"), "{");
  assert.equal(digest(), before);
  // Only those names, and only under `.oats`.
  writeFileSync(join(home, "turn.json"), "{}");
  const withRootFile = digest();
  assert.notEqual(withRootFile, before, "a turn.json at the home's root is the agent's own file");
  writeFileSync(join(home, ".oats", "turn.jsonx"), "{}");
  assert.notEqual(digest(), withRootFile, "another name under .oats is not passed over");
});

// --------------------------------------------------------------------------------------- tmux homes

test("tmux rows: the key is on a row that runs and on no other; it reads the record from this start only", async (t) => {
  const fx = v2Deployment({ t });
  t.after(endServers);
  // Short: a tmux socket's path must fit in 104 bytes.
  const scratch = realpathSync(mkdtempSync("/tmp/oats-act-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const socket = join(scratch, "s.sock");
  const homes = {};
  for (const name of ["live", "shell", "gone", "never", "retiring"]) homes[name] = (await fx.spawn("dev", { name })).home;
  for (const name of ["live", "shell", "gone", "retiring"]) recordLaunch(homes[name], name, socket);
  startServer(socket, "live");
  tmuxOn(socket, "new-window", "-d", "-t", `${SESSION}:`, "-n", "retiring", "sleep 600");
  // A harness that left its pane: the window is at its fallback shell.
  tmuxOn(socket, "new-window", "-d", "-t", `${SESSION}:`, "-n", "shell", "sh");
  const started = Date.parse(rowOf(fx, "live").startedAt);
  assert.equal(Number.isFinite(started), true, "a launched home has a startedAt");

  // Every home holds a record that says working: only the row that runs reads it.
  const now = Date.now();
  for (const home of Object.values(homes)) turn(home, TURN_EVENT.START, now);
  writeFileSync(retirePendingMarkerPath(homes.retiring), JSON.stringify({ reason: "retire pending" }));
  const rows = Object.fromEntries(rowsOf(fx).map((row) => [row.instance, row]));
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, [row.running, row.runtimeState ?? null, said(row)]])), {
    live: [true, null, "working"],
    // A harness killed mid-turn never reads working: its row has no key.
    shell: [false, "shell", "absent"],
    gone: [false, null, "absent"],
    never: [false, null, "absent"],
    retiring: [true, null, "absent"],
  });

  // The row that runs: no file reads null (the key is there), then each boundary as it is written.
  const live = homes.live, file = join(live, TURN_FILE);
  rmSync(file);
  assert.equal(said(rowOf(fx, "live")), null, "no record yet: an older oats.core or bridge, or Codex");
  turn(live, TURN_EVENT.START, started + 1);
  assert.equal(said(rowOf(fx, "live")), "working", "the first turn of a start: its launch prompt");
  turn(live, TURN_EVENT.END, started + 2);
  assert.equal(said(rowOf(fx, "live")), "idle");
  turn(live, TURN_EVENT.END, started - 1000);
  assert.equal(said(rowOf(fx, "live")), null, "a boundary from before startedAt");
  writeFileSync(file, "{\"event\":");
  assert.equal(said(rowOf(fx, "live")), null, "bad JSON");
  writeFileSync(file, JSON.stringify({ event: "turn-start" }));
  assert.equal(said(rowOf(fx, "live")), null, "a missing field");
  writeFileSync(file, JSON.stringify({ event: "thinking", at: new Date(started + 5).toISOString() }));
  assert.equal(said(rowOf(fx, "live")), null, "an unknown event");

  // A later start moves the row's startedAt, and the last session's record no longer counts.
  turn(live, TURN_EVENT.START, started + 5000);
  assert.equal(said(rowOf(fx, "live")), "working");
  const restarted = new Date(started + 60_000).toISOString();
  record(live, { restarts: [{ startedAt: restarted, model: null, reused: "pane" }] });
  const after = rowOf(fx, "live");
  assert.deepEqual([after.startedAt, said(after)], [restarted, null], "the record is from before this start");
  turn(live, TURN_EVENT.START, started + 61_000);
  assert.equal(said(rowOf(fx, "live")), "working", "and this start's own launch prompt counts");

  // A start under way: its pending receipt names a later start than the row does, and the last
  // session's record, which the row's own startedAt would count, reads null on the row that runs.
  const pendingFile = join(live, START_PENDING_FILE);
  writeFileSync(pendingFile, JSON.stringify({ id: "s-2", startedAt: new Date(started + 120_000).toISOString() }));
  assert.equal(said(rowOf(fx, "live")), null, "the previous session's turn-start, while the next start is under way");
  turn(live, TURN_EVENT.START, started + 121_000);
  assert.equal(said(rowOf(fx, "live")), "working", "the new start's launch prompt");
  rmSync(pendingFile);

  // Claude Code: an open turn older than 30 minutes reads null; pi's reads working.
  const old = Date.now() - CLAUDE_OPEN_TURN_MAX_MS - 60_000;
  record(live, { harness: "claude", restarts: [{ startedAt: new Date(old - 1000).toISOString(), model: null, reused: "pane" }] });
  turn(live, TURN_EVENT.START, old);
  assert.equal(said(rowOf(fx, "live")), null);
  record(live, { harness: "pi" });
  assert.equal(said(rowOf(fx, "live")), "working");
  // A Codex row that runs carries the key, and it is null whatever the record says.
  record(live, { harness: "codex" });
  assert.equal(said(rowOf(fx, "live")), null);
  record(live, { harness: "pi" });

  // The key is only ever the listing's own read: one written into the home's record is not on a row.
  record(homes.never, { activity: "working" });
  record(live, { activity: "idle" });
  assert.deepEqual([said(rowOf(fx, "never")), said(rowOf(fx, "live"))], ["absent", "working"]);
  // The status text is unchanged: the field is for clients to show.
  assert.doesNotMatch(fx.cli(["status"]).stdout, /working|turn/);
});

// ----------------------------------------------------------------------------------- provider homes

const LIVE = Object.freeze({ present: true, state: "unknown", running: true });

test("the inspect key: optional, one of the three values, and only null for a session that is not there", () => {
  assert.deepEqual(judgeInspect({ ...LIVE, activity: "working" }), { ...LIVE, open: null, activity: "working" });
  assert.deepEqual(judgeInspect({ ...LIVE, running: null, activity: "idle" }), { ...LIVE, running: null, open: null, activity: "idle" });
  assert.deepEqual(judgeInspect({ ...LIVE, activity: null }), { ...LIVE, open: null, activity: null });
  // An old provider's silence reads null.
  assert.deepEqual(judgeInspect(LIVE), { ...LIVE, open: null, activity: null });
  assert.deepEqual(judgeInspect({ ...LOST, activity: null }), { ...LOST, open: null, activity: null });
  for (const [what, answer] of [
    ["a word outside the contract", { ...LIVE, activity: "busy" }], ["bb's own status word", { ...LIVE, activity: "active" }], ["a boolean", { ...LIVE, activity: true }],
    ["an object", { ...LIVE, activity: { turn: "working" } }], ["a turn on a session that is gone", { ...LOST, activity: "idle" }],
  ]) assert.equal(judgeInspect(answer), null, what);
});

test("provider rows: the provider's answer is relayed on a session that is there and that OATS started, whatever its running; the file is never read", async (t) => {
  const fx = providerDeployment(t);
  const names = ["turn", "waiting", "unloaded", "untold", "silent", "shell", "lost", "badword", "refused"];
  const homes = {};
  for (const name of names) homes[name] = (await fx.launch(name)).home;
  // The pi bridge writes the record in every home, a provider's too: it says the opposite of each
  // provider's answer here, and is never read.
  for (const home of Object.values(homes)) { mkdirSync(join(home, ".oats"), { recursive: true }); turn(home, TURN_EVENT.END, Date.now()); }
  turn(homes.waiting, TURN_EVENT.START, Date.now());
  turn(homes.unloaded, TURN_EVENT.START, Date.now());
  fx.control({
    turn: { inspect: { result: { ...LIVE, activity: "working" } } },
    // An agent waiting on a person: the provider cannot tell a live idle session from a settled one.
    waiting: { inspect: { result: { ...LIVE, running: null, activity: "idle" } } },
    // The provider unloaded an idle harness between turns: the session is still there, and idle.
    unloaded: { inspect: { result: { ...LIVE, running: false, activity: "idle" } } },
    // The harness ended and something else holds the session: no turn to report, whatever it sends.
    shell: { inspect: { result: { present: true, state: "shell", running: false, activity: "working" } } },
    untold: { inspect: { result: { ...LIVE, activity: null } } },
    silent: { inspect: { result: LIVE } },
    lost: { inspect: { result: LOST } },
    badword: { inspect: { result: { ...LIVE, activity: "active" } } },
    refused: { inspect: { error: { code: "E_BACKEND_NOT_READY", message: "two live threads" } } },
  });
  const expected = {
    turn: [true, "working"], waiting: [null, "idle"], unloaded: [false, "idle"],
    untold: [true, null], silent: [true, null],
    // A session left at its shell, one that is gone, an answer outside the contract's words and a refusal: no key.
    shell: [false, "absent"], lost: [false, "absent"], badword: [null, "absent"], refused: [null, "absent"],
  };
  const read = () => Object.fromEntries(rowsOf(fx).map((row) => [row.instance, [row.running, said(row)]]));
  fx.clearCalls();
  assert.deepEqual(read(), expected, "through inspectMany");
  assert.equal(fx.verbs()[0].verb, "inspectMany");
  const rows = Object.fromEntries(rowsOf(fx).map((row) => [row.instance, row]));
  assert.deepEqual([rows.unloaded.runtimeState, rows.shell.runtimeState, rows.lost.sessionEnd, rows.badword.runtimeState, rows.refused.runtimeState], ["unknown", "shell", "lost", "unreachable", "unreachable"]);

  // A home being retired has no key, whatever its provider answers.
  writeFileSync(retirePendingMarkerPath(homes.turn), JSON.stringify({ reason: "retire pending" }));
  assert.deepEqual(read().turn, [true, "absent"]);
  rmSync(retirePendingMarkerPath(homes.turn));
  // Nor does a record that names the key stand in for the provider's answer.
  record(homes.silent, { activity: "working" });
  assert.deepEqual(read().silent, [true, null]);
});

test("provider rows through inspect, for a provider that declares no inspectMany", async (t) => {
  const fx = providerDeployment(t, { manifest: fakeManifest({ fake: fakeProvider({ inspectMany: false }) }) });
  for (const name of ["turn", "idle", "silent"]) await fx.launch(name);
  fx.control({ turn: { inspect: { result: { ...LIVE, activity: "working" } } }, idle: { inspect: { result: { ...LIVE, running: null, activity: "idle" } } } });
  fx.clearCalls();
  assert.deepEqual(rowsOf(fx).map((row) => [row.instance, said(row)]), [["idle", "idle"], ["silent", null], ["turn", "working"]]);
  assert.deepEqual([...new Set(fx.verbs().map((call) => call.verb))], ["inspect"]);
});

test("a provider home OATS stopped has no key, whether its provider answers a harness that runs there (outsideOats) or an idle session", async (t) => {
  const fx = providerDeployment(t);
  const stop = (name) => {
    const plan = fx.cli(["instance", "stop", name, "--plan", "--json"]).json();
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const applied = fx.cli(["instance", "stop", name, "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", `stop-${name}-${Date.now()}`, "--json"]).json();
    assert.equal(applied.ok, true, JSON.stringify(applied));
  };
  for (const name of ["stray", "tame", "runs"]) await fx.launch(name);
  stop("stray");
  stop("tame");
  fx.control({
    stray: { inspect: { result: { ...LIVE, activity: "working" } } },
    tame: { inspect: { result: { ...LIVE, running: null, activity: "idle" } } },
    runs: { inspect: { result: { ...LIVE, activity: "working" } } },
  });
  const rows = Object.fromEntries(rowsOf(fx).map((row) => [row.instance, row]));
  assert.deepEqual([rows.stray.outsideOats?.code, rows.stray.sessionEnd, said(rows.stray)], ["running-outside-oats", "stopped", "absent"], "OATS reports only on the sessions it started");
  assert.deepEqual([rows.tame.runtimeState, rows.tame.sessionEnd, said(rows.tame)], ["stopped", "stopped", "absent"]);
  assert.equal(said(rows.runs), "working");
});

// --------------------------------------------------------------------------------- the remote roster

test("a remote roster relays the key as its host's status gave it, from a host that lists the feature, on a row that can carry it; a saved route's row has none", async (t) => {
  const fx = v2Deployment({ t });
  const saved = process.env.OATS_HOME_DIR;
  // Short (`<base>/h`): it holds ssh's control socket, whose path ssh needs within 86 bytes.
  process.env.OATS_HOME_DIR = join(fx.base, "h");
  t.after(() => { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; });
  writeServers({ build: { sshHost: "build-host", workspace: fx.dep } });
  let n = 0;
  const relayed = async (stdout) => (await rosterGroups({ server: "build", io: { execFileAsync: async () => stdout, serverId: `build-${Date.now()}-${n++}` } })).groups[0].instances;
  const tmuxRow = { instance: "far", home: "/srv/far", backend: "tmux", running: true, tmux: { session: "oats-agents", window: "far", socket: "/s" } };
  const bbRow = { instance: "far", home: "/srv/far", backend: "bb", running: null, runtimeState: "unknown", session: { provider: "oats.bb" }, tmux: null, open: null };
  const host = (row, features = [STATUS_ACTIVITY_FEATURE]) => JSON.stringify({ root: join(fx.dep, "agents"), features, agents: [{ name: "dev", instances: [row] }] });
  const far = async (...args) => said((await relayed(host(...args))).find((row) => row.instance === "far"));

  for (const value of ["working", "idle", null]) {
    assert.equal(await far({ ...tmuxRow, activity: value }), value, `tmux: ${value}`);
    assert.equal(await far({ ...bbRow, activity: value }), value, `provider: ${value}`);
  }
  // A provider row relays it whatever its running: an idle harness the provider unloaded.
  assert.equal(await far({ ...bbRow, running: false, runtimeState: "unknown", activity: "idle" }), "idle");
  // A host that sends no key says nothing, and nothing is added.
  assert.equal(await far(tmuxRow), "absent");
  // A value that is not one of the three drops the key.
  for (const value of ["busy", "Working", true, 1, {}, ["idle"], ""]) assert.equal(await far({ ...tmuxRow, activity: value }), "absent", JSON.stringify(value));
  // A host that does not list the feature says nothing by it.
  for (const features of [[], ["session-providers"], null, "status-activity"]) assert.equal(await far({ ...tmuxRow, activity: "working" }, features), "absent", JSON.stringify(features));
  // Only a row that can carry it: never a tmux row that does not run or reads unknown, a row that
  // says how its session ended, one that runs outside OATS, or one being retired.
  for (const row of [
    { ...tmuxRow, running: false }, { ...tmuxRow, running: null }, { ...tmuxRow, running: false, runtimeState: "shell" },
    { ...tmuxRow, running: false, sessionEnd: "lost" }, { ...bbRow, running: false, runtimeState: "stopped", sessionEnd: "stopped" },
    { ...bbRow, running: false, runtimeState: "stopped", sessionEnd: "stopped", outsideOats: { code: "running-outside-oats", backend: "bb", message: "x" } },
    { ...tmuxRow, retirePending: true }, { ...tmuxRow, retire: { state: "running" } },
    // A provider's session left at its shell: its harness ended.
    { ...bbRow, running: false, runtimeState: "shell" },
    // Neither a tmux row nor a provider's.
    { instance: "far", home: "/srv/far", running: true },
  ]) assert.equal(await far({ ...row, activity: "working" }), "absent", JSON.stringify(row));

  // A row this roster did not read from its host has no key: one whose host was not reached.
  const unreached = (await rosterGroups({ server: "build", io: { execFileAsync: async () => { throw Object.assign(new Error("ssh: connect to host build-host: Connection refused"), { code: 255 }); }, serverId: `build-${Date.now()}-${n++}` } })).groups[0];
  assert.equal(unreached.probe.ok, false);
  assert.equal(unreached.instances.some((row) => Object.hasOwn(row, "activity")), false);
});

// ------------------------------------------------------------------------------- an older reader

test("an older reader ignores the field: the clients' row readers give the same rows with it and without it", () => {
  const home = "/d/agents/dev/instances/dev-a";
  const tmuxRow = { instance: "dev-a", home, backend: "tmux", harness: "pi", running: true, tmux: { session: "oats", window: "dev-a", socket: "/s" }, waitingOnYou: null, startedAt: "2026-11-25T10:00:00.000Z" };
  const bbRow = { instance: "dev-b", home: `${home}-b`, backend: "bb", session: { provider: "oats.bb", threadId: "thr_x" }, tmux: null, running: null, runtimeState: "unknown", waitingOnYou: null, open: { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" } };
  const statusOf = (instances) => ({ root: "/d/agents", features: ["status-activity"], agents: [{ name: "dev", dir: "/d/agents/dev", instances }] });
  const local = (instances) => deploymentStatusData(statusOf(instances), "/d");
  const without = local([tmuxRow, bbRow]);
  for (const value of ["working", "idle", null, "a word a later kernel adds"]) {
    const withField = local([{ ...tmuxRow, activity: value }, { ...bbRow, activity: value }]);
    assert.deepEqual(withField, without, JSON.stringify(value));
    for (const row of withField.agents[0].instances) assert.equal(Object.hasOwn(row, "activity"), false);
  }
  // The remote roster's reader copies a row's keys through and reads the ones it knows: the panel
  // with the field is the panel without it, and that one key beside the row, which no client reads.
  const group = (instances) => ({ id: "build", server: "build", label: "build", registrationPresent: true, target: { sshHost: "build-host", workspace: "/srv/ws" }, probe: { ok: true, features: ["status-activity"] }, agentsRoot: "/srv/agents", souls: [], retireFailures: [], instances });
  const remoteRow = { server: "build", instance: "far", agent: "dev", home: "/srv/agents/dev/instances/far", agentsRoot: "/srv/agents", harness: "pi", backend: "tmux", running: true, retirePending: false, rollbackIncomplete: false, savedRoute: false, addressable: true, missingRemotely: false };
  const at = "2026-11-25T10:00:00.000Z";
  const plain = remotePanel(group([remoteRow]), at);
  for (const value of ["working", "idle", null]) {
    const panel = remotePanel(group([{ ...remoteRow, activity: value }]), at);
    const { activity, ...row } = panel.instances[0];
    assert.equal(activity, value);
    assert.deepEqual({ ...panel, instances: [row] }, plain, JSON.stringify(value));
  }
});
