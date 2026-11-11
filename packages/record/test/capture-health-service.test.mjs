// Offline package diagnosis fixtures. No real service manager or source roots.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureHealth } from "../lib/capture-state.mjs";
import { captureHealthForDoctor, SET_ASIDE_REMEDY } from "../lib/capture-health.mjs";
import { captureInstallation } from "../lib/capture-health-installation.mjs";
import { captureDefaultRootPlan } from "../lib/capture-default-roots.mjs";
import { captureServiceDefinition } from "../lib/capture-service-definition.mjs";
import { emptyCaptureCounts, emptyCaptureStatus, persistCaptureStatus, validCaptureHealthEnvelope } from "../lib/capture-status.mjs";
import { CAPTURE_POLICY } from "../lib/capture-budget.mjs";
import { DerivedState } from "../lib/derived-state.mjs";
import { isCaptureHook } from "../lib/capture-hook-ownership.mjs";
import { writeCurrentHook } from "./fixtures/capture-hook-settings.mjs";

const now = Date.parse("2026-10-01T12:00:00.000Z"), at = seconds => new Date(now - seconds * 1000).toISOString();
const backlog = () => ({ pending: false, setAsideCount: 0, setAside: [], truncated: false, failedCount: 0, failed: [], failedTruncated: false });
const summary = (seconds = 60) => ({ id: "run-one", trigger: "service", pid: 321, startedAt: at(seconds + 10),
  finishedAt: at(seconds), counts: emptyCaptureCounts(), peakRssBytes: null });
const status = (seconds = 60) => ({ ...emptyCaptureStatus(backlog()), policy: { ...CAPTURE_POLICY },
  lastRun: { ...summary(seconds), outcome: "complete", reason: null, reclaimedLock: null },
  lastSuccess: summary(seconds), lastProgressAt: at(seconds) });
const write = (path, bytes) => { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, bytes); };
const codes = value => value.rows.map(row => row.code);
function fixture(t, platform = "linux") {
  const home = fs.mkdtempSync(join(tmpdir(), "health-service-")), root = join(home, "record 'literal'");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const options = { home, platform, now, host: "fixture-host", liveness: () => { throw new Error("unexpected PID probe"); } };
  const request = { root, owner: "fixture", plan: captureDefaultRootPlan({ home, cwd: home, env: {} }) };
  const definition = captureServiceDefinition({ platform, node: "/fixture/node", request });
  const save = value => { fs.mkdirSync(root, { recursive: true }); persistCaptureStatus(root, value, { now }); };
  // Installation evidence for a test whose intent needs an installed host.
  return { home, root, options, definition, save, hook: () => writeCurrentHook(home), health: extra => captureHealth(root, { ...options, ...extra }) };
}
function bytesBelow(root) {
  const files = {};
  function visit(path) {
    const st = fs.lstatSync(path);
    files[path] = st.isSymbolicLink() ? { link: fs.readlinkSync(path) } : st.isDirectory() ? { directory: true } :
      { bytes: fs.readFileSync(path).toString("base64"), mtime: st.mtimeMs };
    if (st.isDirectory()) for (const name of fs.readdirSync(path)) visit(join(path, name));
  }
  visit(root); return files;
}
function legacy(platform) {
  return platform === "linux" ? `[Unit]\nDescription=turn-record capture watcher\n[Service]\nExecStart=/old/node /old/package/bin/capture.mjs --watch --owner fixture\nRestart=always\nRestartSec=60\n[Install]\nWantedBy=default.target\n`
    : `<plist version="1.0"><dict><key>Label</key><string>ai.aweb.turn-record-capture</string><key>ProgramArguments</key><array><string>/old/node</string><string>/old/package/bin/capture.mjs</string><string>--watch</string><string>--owner</string><string>fixture</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>StandardOutPath</key><string>/old/log</string><key>StandardErrorPath</key><string>/old/log</string></dict></plist>`;
}

for (const platform of ["linux", "darwin"]) test(`${platform}: absent/foreign files are not installation; supported bytes do not prove scheduling`, t => {
  const f = fixture(t, platform);
  assert.equal(f.health().status, "ok"); assert.equal(fs.existsSync(f.root), false);
  // A record root alone, as one recall or manual capture leaves it, is not an installation.
  fs.mkdirSync(join(f.root, "index"), { recursive: true });
  const rootOnly = f.health(); assert.equal(rootOnly.status, "ok"); assert.deepEqual(rootOnly.rows, []);
  fs.rmSync(f.root, { recursive: true });
  // Setup's pending marker is setup evidence, not a recall's root: setup that
  // failed after writing it (say with --no-hooks) is diagnosed, never ok.
  write(join(f.root, "capture-service-pending.json"), '{"platform":"fixture"}\n');
  const markerOnly = f.health(), pendingRow = markerOnly.rows.find(row => row.code === "capture-service-pending");
  assert.equal(markerOnly.status, "warning");
  assert.match(pendingRow?.message ?? "", /^The pending-activation marker .* is stale: no setup-marked capture service definition remains\. Run turn-record setup /);
  fs.rmSync(f.root, { recursive: true });
  write(f.definition.files[0].path, "foreign mention of capture.mjs --watch\n");
  assert.equal(f.health().status, "ok");
  for (const file of f.definition.files) write(file.path, file.contents);
  const before = bytesBelow(f.home), health = f.health();
  assert.deepEqual(codes(health), ["capture-status-missing", "capture-success-stale"]);
  assert.equal(health.lastRun, null); assert.equal(health.lastSuccess, null); assert.equal(health.lastFailure, null);
  assert.match(health.rows[0].message, /turn-record setup --root '.*'\\''literal/);
  assert.deepEqual(bytesBelow(f.home), before); assert.equal(fs.existsSync(f.root), false);
  f.save(status()); assert.equal(f.health().status, "ok");
  write(f.definition.files[0].path, legacy(platform));
  assert.deepEqual(codes(f.health()), ["capture-setup-required"]);
  assert.match(f.health().rows[0].message, /do not prove manager registration/);
});

test("hook evidence shares setup's exact tokenized recognition and event scope", t => {
  const f = fixture(t), path = join(f.home, ".claude-profile/settings.json");
  const command = "'/missing node' '/old quoted/package/capture.mjs' --owner fixture --quiet --hook";
  // The hook entry this release's setup writes; any other owned form needs setup.
  const current = "'/missing node' '/new quoted/package/bin/capture-hook.mjs' --owner fixture --quiet --root '/r'";
  for (const [text, owned, setupRequired] of [[current, true, false], [command, true, true], [command + " && echo nope", false],
    ["echo " + command, false], [command.replace("--owner", "--ownership"), false], ["echo capture.mjs --quiet --owner", false]]) {
    const hook = { type: "command", command: text }; assert.equal(isCaptureHook(hook), owned);
    write(path, JSON.stringify({ hooks: { Stop: [{ hooks: [hook] }], SessionEnd: [] }, kept: true }));
    assert.deepEqual(codes(f.health()), owned ? ["capture-status-missing", "capture-success-stale", ...(setupRequired ? ["capture-setup-required"] : [])] : []);
  }
  write(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }));
  assert.equal(f.health().status, "ok");
  write(path, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command }] }] } }));
  assert.equal(f.health().status, "warning"); assert.equal(fs.existsSync(f.root), false);
});

test("an earlier release's hook on a hooks-only install needs setup", t => {
  const f = fixture(t), path = join(f.home, ".claude/settings.json");
  // What setup wrote before this release: no --hook, a 120 s asynchronous hook.
  const old = { type: "command", command: "/usr/local/bin/node /old/package/bin/capture.mjs --owner fixture --quiet", async: true, timeout: 120 };
  write(path, JSON.stringify({ hooks: { Stop: [{ hooks: [old] }], SessionEnd: [{ hooks: [{ ...old }] }] } }));
  const health = f.health(), row = health.rows.find(row => row.code === "capture-setup-required");
  assert.ok(row, JSON.stringify(codes(health)));
  assert.ok(row.message.includes(path), row.message);
  assert.match(row.message, /Run turn-record setup/);
});

test("unknown/unreadable/oversized/dangling candidate evidence fails closed, never returning no installation", t => {
  const f = fixture(t), path = f.definition.files[0].path;
  for (const bytes of ["x".repeat(1024 * 1024 + 1)]) {
    write(path, bytes); assert.throws(f.health, /evidence is unknown.*1 MiB/); fs.unlinkSync(path);
  }
  fs.mkdirSync(path); assert.throws(f.health, /evidence is unknown.*regular file/); fs.rmdirSync(path);
  fs.symlinkSync(join(f.home, "missing"), path); assert.throws(f.health, /evidence is unknown/); fs.unlinkSync(path);
  const hook = join(f.home, ".claude/settings.json");
  for (const bytes of ["{bad", "[]", '{"hooks":{"Stop":{}}}']) {
    write(hook, bytes); assert.throws(f.health, /evidence is unknown.*hook/);
  }
  fs.rmSync(join(f.home, ".claude"), { recursive: true });
  fs.symlinkSync(join(f.home, "missing"), join(f.home, ".claude-link"));
  assert.throws(f.health, /evidence is unknown/); fs.unlinkSync(join(f.home, ".claude-link"));
  write(path, "foreign"); const open = fs.openSync;
  fs.openSync = (name, ...args) => { if (name === path) throw Object.assign(new Error("injected unreadable evidence"), { code: "EACCES" }); return open(name, ...args); };
  syncBuiltinESMExports();
  try { assert.throws(f.health, /evidence is unknown.*unreadable/); }
  finally { fs.openSync = open; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.root), false);
});

test("installation enumeration/read limits and observed changes refuse without partial absence claims", t => {
  const f = fixture(t), path = f.definition.files[0].path;
  write(path, "foreign"); const read = fs.readSync;
  fs.readSync = (...args) => { const n = read(...args); fs.appendFileSync(path, "changed"); return n; }; syncBuiltinESMExports();
  try { assert.throws(f.health, /evidence changed/); }
  finally { fs.readSync = read; syncBuiltinESMExports(); }
  const open = fs.opendirSync; let visits = 0, closed = false;
  fs.opendirSync = () => ({ readSync: () => { visits++; return { name: "unrelated", isDirectory: () => false, isSymbolicLink: () => false }; }, closeSync: () => { closed = true; } });
  syncBuiltinESMExports();
  try { assert.throws(f.health, /entry limit/); assert.equal(visits, 4097); assert.equal(closed, true); }
  finally { fs.opendirSync = open; syncBuiltinESMExports(); }
  assert.throws(() => captureInstallation(f.root, { ...f.options, check: () => { throw new Error("deadline fixture"); } }), /deadline fixture/);
});

for (const age of [3599, 3600, 3601]) test(`success age ${age}s preserves the strict freshness threshold`, t => {
  const f = fixture(t), saved = status(age); saved.lastProgressAt = at(1); f.save(saved); f.hook();
  const before = bytesBelow(f.home), health = f.health();
  assert.deepEqual(codes(health), age > 3600 ? ["capture-success-stale"] : []);
  assert.deepEqual(health.lastSuccess, saved.lastSuccess); assert.deepEqual(health.lastRun, saved.lastRun);
  if (age > 3600) {
    assert.match(health.rows[0].message, /sleeping machine or off-host/);
    assert.ok(health.rows[0].message.includes(saved.lastProgressAt));
    assert.ok(health.rows[0].message.includes(saved.lastSuccess.finishedAt));
  }
  assert.deepEqual(bytesBelow(f.home), before);
});

test("missing, old null and invalid/future status stay distinct without invented run history", t => {
  const f = fixture(t); fs.mkdirSync(f.root);
  f.hook();
  assert.deepEqual(codes(f.health()), ["capture-status-missing", "capture-success-stale"]);
  f.save(emptyCaptureStatus(backlog()));
  assert.deepEqual(codes(f.health()), ["capture-success-stale"]); assert.equal(f.health().lastRun, null);
  for (const value of ["{bad", JSON.stringify({ ...status(), schemaVersion: 99 }), JSON.stringify({ ...status(), lastProgressAt: at(-1) })]) {
    write(join(f.root, "capture-status.json"), value);
    const h = f.health(); assert.equal(h.rows[0].code, "capture-status-invalid"); assert.equal(h.lastSuccess, null);
    assert.equal(fs.readFileSync(join(f.root, "capture-status.json"), "utf8"), value);
  }
});

test("current issues and newer failure remain warnings beside recent older success; stale command issues are historical only", t => {
  const f = fixture(t), saved = status(60);
  f.hook();
  saved.lastFailure = { ...summary(30), id: "new-failure", reason: "io", message: "safe failure" }; f.save(saved);
  const state = new DerivedState(f.root);
  state.set("set-aside", "one", { source: "cc", path: "/fixture/session", offset: 10, reason: "captured-prefix-changed" }); state.close();
  const before = bytesBelow(f.home), health = f.health();
  assert.deepEqual(codes(health), ["capture-input-set-aside", "capture-pass-failed"]);
  assert.deepEqual(health.lastSuccess, saved.lastSuccess); assert.deepEqual(health.lastFailure, saved.lastFailure);
  assert.match(health.rows[0].message, /turn-record capture --retry-set-aside/);
  assert.match(health.rows[1].message, /durably confirmed/); assert.deepEqual(bytesBelow(f.home), before);
  saved.lastFailure.finishedAt = at(90); saved.lastFailure.startedAt = at(100);
  saved.backlog = { ...backlog(), setAsideCount: 1, setAside: health.backlog.setAside, pending: true }; f.save(saved);
  const clear = new DerivedState(f.root); clear.delete("set-aside", "one"); clear.close();
  const recovered = f.health(); assert.equal(recovered.status, "ok"); assert.equal(recovered.backlog.setAsideCount, 0);
  assert.deepEqual(recovered.lastFailure, saved.lastFailure); // history is retained, not an active issue
});

test("capture-service-pending reports setup's unverified activation from file evidence, stale when no marked definition remains", t => {
  for (const platform of ["linux", "darwin"]) {
    const f = fixture(t, platform), marker = join(f.root, "capture-service-pending.json");
    f.hook();
    for (const file of f.definition.files) write(file.path, file.contents);
    f.save(status(60)); assert.ok(!codes(f.health()).includes("capture-service-pending"), "no marker, no row");
    write(marker, '{"platform":"fixture"}\n');
    const before = bytesBelow(f.home), live = f.health(), row = live.rows.find(r => r.code === "capture-service-pending");
    assert.equal(live.status, "warning");
    assert.equal(row.message, `Setup started activating the periodic capture service and did not verify it (marker ${marker}): capture hooks may be installed, but the periodic schedule is not verified. Run turn-record setup --root '${f.root.replace(/'/g, `'\\''`)}' with your existing --owner to retry the activation.`);
    assert.doesNotMatch(row.message, /not running/); assert.deepEqual(bytesBelow(f.home), before, "health never removes the marker");
    assert.match(captureHealthForDoctor(f.root, f.options).rows.find(r => r.code === "capture-service-pending").message, /Run oats setup --root /);
    fs.rmSync(f.definition.files[0].path);
    assert.match(f.health().rows.find(r => r.code === "capture-service-pending").message, /^The pending-activation marker .* is stale: no setup-marked capture service definition remains\. Run turn-record setup /);
    write(f.definition.files[0].path, legacy(platform));
    assert.match(f.health().rows.find(r => r.code === "capture-service-pending").message, /is stale/);
    // It never hides another row: beside a missing status, both show.
    fs.rmSync(join(f.root, "capture-status.json"));
    assert.ok(["capture-status-missing", "capture-service-pending"].every(code => codes(f.health()).includes(code)));
  }
});

test("record-too-large set-asides get the edit-or-ignore-whole-input remedy, never prefix restoration", t => {
  const f = fixture(t); f.save(status(60));
  f.hook();
  const state = new DerivedState(f.root);
  state.set("set-aside", "big", { source: "cc", path: "/fixture/big", offset: 0, reason: "record-too-large" }); state.close();
  const message = () => f.health().rows.find(row => row.code === "capture-input-set-aside").message;
  const only = message();
  assert.match(only, /^1 capture inputs set aside\. 1 listed as record-too-large: Edit the source so no record exceeds 8 MiB, leaving its captured prefix unchanged, then run turn-record capture --retry-set-aside; or add the whole input to .*\/ignore, which discards the whole input/);
  assert.doesNotMatch(only, /Restore the captured prefix/);
  const more = new DerivedState(f.root);
  more.set("set-aside", "conflict", { source: "cc", path: "/fixture/conflict", offset: 10, reason: "captured-prefix-changed" }); more.close();
  assert.match(message(), /^2 capture inputs set aside\. 1 listed as record-too-large: Edit the source .* The other 1: Restore the captured prefix and run turn-record capture --retry-set-aside/);
  // Beyond the bounded sample, reasons are unknown: the remainder is not told one.
  const many = new DerivedState(f.root);
  for (let n = 0; n < 99; n++) many.set("set-aside", `more-${n}`, { source: "cc", path: `/fixture/more-${String(n).padStart(3, "0")}`, offset: 1, reason: "captured-prefix-changed" });
  many.close();
  assert.match(message(), /^101 capture inputs set aside\. 1 listed as record-too-large: Edit the source .* The other 100, including unlisted entries: see each entry's reason; record-too-large entries need the edit-or-ignore remedy above\. Otherwise: Restore the captured prefix/);
});

function unfinished(f, seconds = 20) {
  const saved = status(seconds + 100); saved.lastRun = { ...summary(seconds), id: "active-run", finishedAt: null, outcome: "running", reason: null, reclaimedLock: null };
  f.save(saved); return saved;
}
function lock(f, saved) {
  const owner = { pid: 123, nonce: "owner-nonce", host: "fixture-host", startedAt: at(40),
    worker: { pid: saved.lastRun.pid, nonce: "worker-nonce", host: "fixture-host", startedAt: at(35) } };
  write(join(f.root, ".capture.lock/owner.json"), JSON.stringify(owner)); return owner;
}

test("unfinished overdeadline is a warning, not a guessed kill/timeout cause or stale success erasure", t => {
  const f = fixture(t), saved = unfinished(f, 301); f.hook();
  const before = bytesBelow(f.home), h = f.health();
  assert.deepEqual(codes(h), ["capture-pass-failed"]); assert.match(h.rows[0].message, /does not identify why/);
  assert.deepEqual(h.lastRun, saved.lastRun); assert.equal(h.lastRun.reason, null); assert.equal(h.lastRun.finishedAt, null);
  assert.deepEqual(h.lastSuccess, saved.lastSuccess); assert.deepEqual(bytesBelow(f.home), before);
});

test("early death requires unchanged matching local registration and both processes dead", t => {
  const f = fixture(t), saved = unfinished(f), owner = lock(f, saved), path = join(f.root, ".capture.lock/owner.json");
  f.hook();
  const observed = [], liveness = ({ pid }) => { observed.push(pid); return "dead"; };
  assert.deepEqual(codes(f.health({ liveness })), ["capture-pass-failed"]); assert.deepEqual(observed, [123, 321]);
  for (const mutate of [o => o.host = "off-host", o => delete o.host, o => o.worker.host = "off-host",
    o => o.worker.pid++, o => o.startedAt = at(1), o => o.worker.nonce = "", o => o.worker.startedAt = at(-1)]) {
    const changed = structuredClone(owner); mutate(changed); write(path, JSON.stringify(changed));
    assert.deepEqual(codes(f.health()), []); // default liveness throws if any uncertain PID is probed
  }
  write(path, JSON.stringify(owner));
  for (const live of ["alive", "unknown"]) assert.deepEqual(codes(f.health({ liveness: () => live })), []);
  assert.deepEqual(codes(f.health({ liveness: ({ pid }) => pid === owner.pid ? "dead" : "alive" })), []);
  assert.deepEqual(codes(f.health({ liveness: pid => { write(path, JSON.stringify({ ...owner, nonce: "replacement" })); return "dead"; } })), []);
  fs.rmSync(join(f.root, ".capture.lock"), { recursive: true }); assert.deepEqual(codes(f.health()), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(f.root, "capture-status.json"))), saved);
});

test("offline healthy diagnosis invokes no manager, capture, writer or network and warning CLI exits zero", t => {
  const f = fixture(t); f.save(status());
  f.hook();
  const before = bytesBelow(f.home), spawn = cp.spawnSync, mutations = {};
  cp.spawnSync = () => { throw new Error("unexpected child/manager"); };
  for (const key of ["mkdirSync", "writeFileSync", "renameSync", "unlinkSync", "rmSync"]) {
    mutations[key] = fs[key]; fs[key] = () => { throw new Error(`unexpected ${key}`); };
  }
  syncBuiltinESMExports();
  try { assert.equal(f.health().status, "ok"); }
  finally { cp.spawnSync = spawn; Object.assign(fs, mutations); syncBuiltinESMExports(); }
  assert.deepEqual(bytesBelow(f.home), before);
  f.save(emptyCaptureStatus(backlog()));
  const result = spawn(process.execPath, [join(import.meta.dirname, "../bin/capture.mjs"), "--root", f.root, "--health", "--json"],
    { env: { HOME: f.home, TMPDIR: f.home }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(codes(JSON.parse(result.stdout)), ["capture-success-stale"]);
  write(join(f.home, ".claude/settings.json"), "{bad");
  const failed = spawn(process.execPath, [join(import.meta.dirname, "../bin/capture.mjs"), "--root", f.root, "--health", "--json"],
    { env: { HOME: f.home, TMPDIR: f.home }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(failed.status, 1); assert.match(JSON.parse(failed.stdout).error, /installation evidence is unknown/);
});

test("doctor remedies change authored commands only, retaining literal paths/history and standalone wording", t => {
  const f = fixture(t), root = join(f.home, "Run turn-record setup --root USER-DATA 'literal $&'");
  f.hook();
  const state = new DerivedState(root);
  state.set("set-aside", "one", { source: "cc", path: "/private/turn-record capture --retry-set-aside", offset: 0,
    reason: "captured-prefix-changed", line: 1 }); state.close();
  const saved = { ...status(), lastSuccess: null, lastRun: { ...status().lastRun,
    id: "Inspect turn-record capture --health --json USER-DATA", outcome: "failed", reason: "io" } };
  persistCaptureStatus(root, saved, { now });
  const before = bytesBelow(f.home), standalone = captureHealth(root, f.options), doctor = captureHealthForDoctor(root, f.options);
  assert.equal(validCaptureHealthEnvelope(standalone, { now }), true);
  assert.equal(validCaptureHealthEnvelope(doctor, { now }), true);
  assert.deepEqual(doctor.backlog, standalone.backlog); assert.deepEqual(doctor.lastRun, saved.lastRun);
  assert.deepEqual(codes(doctor), codes(standalone));
  assert.match(standalone.rows.find(row => row.code === "capture-input-set-aside").message, /run turn-record capture --retry-set-aside/);
  assert.match(doctor.rows.find(row => row.code === "capture-input-set-aside").message, /run oats capture --retry-set-aside/);
  assert.ok(doctor.rows.find(row => row.code === "capture-input-set-aside").message.includes(`${root}/ignore`));
  assert.ok(doctor.rows.find(row => row.code === "capture-pass-failed").message.includes(saved.lastRun.id));
  assert.match(doctor.rows.find(row => row.code === "capture-pass-failed").message, /Inspect oats capture --health --json and/);
  assert.match(doctor.rows.find(row => row.code === "capture-success-stale").message, /Run oats setup --root/);
  assert.match(standalone.rows.find(row => row.code === "capture-success-stale").message, /Run turn-record setup --root/);
  assert.equal(SET_ASIDE_REMEDY, "Restore the captured prefix and run turn-record capture --retry-set-aside; or add the source to <root>/ignore (later turns from that session will not be captured). Retry revalidates; it never authorizes a changed prefix.");
  assert.deepEqual(bytesBelow(f.home), before);
  const future = structuredClone(doctor); future.lastRun.startedAt = new Date(now + 1000).toISOString();
  assert.equal(validCaptureHealthEnvelope(future, { now }), false);
  const malformed = structuredClone(doctor); malformed.backlog.setAside[0].private = "must not pass";
  assert.equal(validCaptureHealthEnvelope(malformed, { now }), false);
});
