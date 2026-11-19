// A freshly spawned pi home gets no "continue from STATE.md's Next" nudge;
// a home that has worked gets it on restart (awebai/oats#1251). The bridge
// decides from pi's own sessions of the home, never from what a knowledge
// capability seeded into STATE.md, and writes nothing to tell. Each run is
// one pi process; a restart is another run on the same home.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./run-session-start.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// What oats.okf's spawn hook seeds (oats.okf 5.x): headings with nothing under them.
const OKF_SEED = "# Working state\n\n# Task\n\n# Next\n";
// The template text the bridge used to look for (no package writes it now).
const OLD_TEMPLATE = "# State\n\n_No task assigned yet._\n\n## Next\n\n_(the single next action)_\n";

function home(t, state) {
  const root = mkdtempSync(join(tmpdir(), "oats-pi-memory-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "home");
  mkdirSync(dir);
  // Entries come after the home's creation, as at spawn, so its ctime moves
  // past its birth time (equal, the bridge takes the birth time as unknown).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  writeFileSync(join(dir, "instance.json"), "{}\n");
  if (state !== undefined) writeFileSync(join(dir, "STATE.md"), state);
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  return { dir, sessions };
}
function knownBirth(dir) {
  const { birthtimeMs, ctimeMs } = statSync(dir);
  return birthtimeMs !== 0 && birthtimeMs !== ctimeMs;
}
/** A session pi filed: its header (docs/session-format.md, SessionHeader), then a turn. */
function session(h, { cwd = h.dir, timestamp = new Date().toISOString(), name } = {}) {
  const id = `${readdirSync(h.sessions).length}`.padStart(8, "0");
  const file = join(h.sessions, name ?? `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd })}\n{"type":"message","id":"a1","parentId":null,"timestamp":"${timestamp}","message":{"role":"assistant","content":[]}}\n`);
  return file;
}
function start(h, { reason = "startup", current = join(h.sessions, "current.jsonl") } = {}) {
  const env = { ...process.env, OATS_PKG_ROOT: REPO_ROOT };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", RUNNER, reason, h.dir, h.sessions, current], { env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  return JSON.parse(r.stdout).memory;
}
function assertNudge(memory, h) {
  assert.equal(memory.length, 1);
  assert.match(memory[0].message.content, /Read \.\/STATE\.md and the recent entries of \.\/log\.md now/);
  assert.ok(memory[0].message.content.includes(h.dir));
  assert.deepEqual(memory[0].options, { deliverAs: "steer", triggerTurn: false });
}

test("a fresh home seeded by oats.okf gets no nudge at its first startup, and the home is left as it was", (t) => {
  const h = home(t, OKF_SEED);
  assert.deepEqual(start(h), []);
  assert.deepEqual(readdirSync(h.dir).sort(), ["STATE.md", "instance.json"]);
});

test("a fresh home with no STATE.md gets no nudge, at its first startup or after it has worked", (t) => {
  const h = home(t);
  assert.deepEqual(start(h), []);
  session(h);
  assert.deepEqual(start(h), []);
});

test("a home that has worked gets the nudge on restart", (t) => {
  const h = home(t, OKF_SEED);
  assert.deepEqual(start(h), []);
  session(h);
  writeFileSync(join(h.dir, "STATE.md"), "# Working state\n\n# Task\nfix it\n\n# Next\nrun the tests\n");
  assertNudge(start(h), h);
});

test("this session's own file is not an earlier session", (t) => {
  const h = home(t, OKF_SEED);
  assert.deepEqual(start(h, { current: session(h) }), []);
});

test("sessions of another working directory in a shared sessions directory are not this home's", (t) => {
  const h = home(t, OKF_SEED);
  session(h, { cwd: `${h.dir}-other` });
  assert.deepEqual(start(h), []);
});

test("an earlier instance's sessions at the same home path are not this home's", (t) => {
  const h = home(t, OKF_SEED);
  if (!knownBirth(h.dir)) return t.skip("the home's birth time is unknown on this filesystem");
  session(h, { timestamp: new Date(statSync(h.dir).birthtimeMs - 60000).toISOString() });
  assert.deepEqual(start(h), []);
  session(h);
  assertNudge(start(h), h);
});

test("a file last written before the home was created is skipped unread", (t) => {
  const h = home(t, OKF_SEED);
  if (!knownBirth(h.dir)) return t.skip("the home's birth time is unknown on this filesystem");
  const old = new Date(statSync(h.dir).birthtimeMs - 60000);
  utimesSync(session(h), old, old);
  assert.deepEqual(start(h), []);
});

test("pi's own SessionManager: a session holding nothing is not filed, one with a turn counts on restart", async (t) => {
  let SessionManager;
  try { ({ SessionManager } = await import("@earendil-works/pi-coding-agent")); }
  catch { return t.skip("pi SDK not installed (npm ci installs the root development dependency)"); }
  const h = home(t, OKF_SEED);
  const sm = SessionManager.create(h.dir, h.sessions);
  assert.deepEqual(start(h, { current: sm.getSessionFile() }), []);
  assert.deepEqual(start(h), []);
  sm.appendMessage({ role: "user", content: "THE TASK", timestamp: Date.now() });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "on it" }], api: "faux", provider: "faux", model: "faux", usage, stopReason: "stop", timestamp: Date.now() });
  assertNudge(start(h), h);
});

test("unreadable or foreign files in the sessions directory are not sessions", (t) => {
  const h = home(t, OKF_SEED);
  writeFileSync(join(h.sessions, "garbage.jsonl"), "not json\n");
  writeFileSync(join(h.sessions, "notes.txt"), `${JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: h.dir })}\n`);
  writeFileSync(join(h.sessions, "no-newline.jsonl"), "{}");
  assert.deepEqual(start(h), []);
  rmSync(h.sessions, { recursive: true });
  assert.deepEqual(start(h), []);
});

test("STATE.md's text decides nothing: written state on a fresh home gets no nudge, the old template on a worked home does", (t) => {
  const fresh = home(t, "# Working state\n\n# Next\nsomething a capability seeded\n");
  assert.deepEqual(start(fresh), []);
  const worked = home(t, OLD_TEMPLATE);
  session(worked);
  assertNudge(start(worked), worked);
});

test("a resumed or new session in the process gets the nudge, as before", (t) => {
  const h = home(t, OKF_SEED);
  assertNudge(start(h, { reason: "resume" }), h);
  assertNudge(start(h, { reason: "new" }), h);
});

test("a reload sends nothing", (t) => {
  const h = home(t, OKF_SEED);
  session(h);
  assert.deepEqual(start(h, { reason: "reload" }), []);
});
