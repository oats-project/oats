// Feature instance-pin: an instance pinned at the top of its machine's list, presentation only, in a home
// file of its own (`.oats-pinned.json`, lib/instance-pin.mjs). The pin is the home's, so it is shared: every
// client of the machine reads it from the rows. It is changed by `oats instance pin` and read on status rows,
// `inspect --home` and the remote roster.
//
// What is pinned here:
// - the record: `{ pinnedApi: 1, at }`, its mode, written only on a change; the reader takes a regular file
//   of at most 4 KiB that is a valid record, and anything else is false, never an error;
// - the file is kernel-owned: a capability cannot declare it, and it is no change to the home's stored digest;
// - the CLI: the answer, `changed`, on/off twice, the refusals, resolution as `instance background` answers
//   it; status rows and inspect --home carry it; a recorded `pinned` in instance.json is never trusted;
// - beside a retire: E_INSTANCE_RETIRING (a live one) or E_LIFECYCLE_BUSY (a claim that cannot be read), and
//   nothing is written; beside a live stop, start or upgrade the pin goes through, as background's does; a retire
//   removes the pin with the home.
// The pin surviving restart, stop/start and `instance upgrade` is pinned beside those paths
// (test/session-restart.test.mjs, test/instance-upgrade.test.mjs); the routed verb and the remote roster's
// relay in test/remote-parity.test.mjs; the answer's shape and the feature in test/cli-json-contract.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { PIN_FILE, RECORD_MAX, readInstancePin, writeInstancePin } from "../lib/instance-pin.mjs";
import { disposableHomeRootProblem } from "../lib/capability-contract.mjs";
import { KERNEL_HOME_RECEIPTS, claimHomeFor, lifecycleClaimRefusals, releaseHomeClaim, retireClaimPath, retirePendingMarkerPath, storedTreeDigest } from "../lib/core.mjs";

function okResult(r, what) {
  assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, true, `${what}: ${r.stdout}`);
  return j.result;
}
function refused(r, what) {
  assert.notEqual(r.status, 0, what);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, false, what);
  return j.error;
}
function home(t) {
  const base = fixtureBase("oats-instance-pin-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "home");
  mkdirSync(dir);
  return dir;
}
/** status --json answers its document bare, not in an envelope: the row of `name`. */
function statusRow(fx, name) {
  const r = fx.cli(["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).agents.flatMap((a) => a.instances).find((i) => i.instance === name);
}

test("writeInstancePin: the record and its mode; on again writes nothing; off removes it", (t) => {
  const h = home(t);
  const at = new Date("2026-11-19T15:00:00.000Z");
  assert.deepEqual(writeInstancePin(h, true, { now: () => at }), { pinned: true, changed: true });
  const file = join(h, PIN_FILE);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pinnedApi: 1, at: "2026-11-19T15:00:00.000Z" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const bytes = readFileSync(file);
  const before = statSync(file).mtimeMs;
  assert.deepEqual(writeInstancePin(h, true, { now: () => new Date("2027-01-01T00:00:00.000Z") }), { pinned: true, changed: false });
  assert.deepEqual(readFileSync(file), bytes, "nothing was written");
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(readInstancePin(h), true);
  assert.deepEqual(writeInstancePin(h, false), { pinned: false, changed: true });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.deepEqual(writeInstancePin(h, false), { pinned: false, changed: false }, "off with no file is no change");
  // A file that is not a record reads as not pinned: off removes it, and that is no change.
  writeFileSync(file, "not json");
  assert.deepEqual(writeInstancePin(h, false), { pinned: false, changed: false });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  // A link at the name reads false; off removes the link and not its target; on replaces it with a record,
  // never writing through it.
  const target = join(dirname(h), "linked.json");
  writeFileSync(target, JSON.stringify({ pinnedApi: 1 }));
  symlinkSync(target, file);
  assert.deepEqual(writeInstancePin(h, false), { pinned: false, changed: false }, "off removes a link");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.equal(readFileSync(target, "utf8"), JSON.stringify({ pinnedApi: 1 }), "and leaves what it pointed at");
  symlinkSync(target, file);
  assert.deepEqual(writeInstancePin(h, true), { pinned: true, changed: true }, "on over a link");
  assert.equal(lstatSync(file).isFile(), true, "the link is replaced by a record");
  assert.equal(readFileSync(target, "utf8"), JSON.stringify({ pinnedApi: 1 }), "never written through");
  // A directory at the name: off removes it, on replaces it with a record.
  rmSync(file);
  mkdirSync(join(file, "inner"), { recursive: true });
  assert.deepEqual(writeInstancePin(h, false), { pinned: false, changed: false }, "off removes a directory");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  mkdirSync(file);
  assert.deepEqual(writeInstancePin(h, true), { pinned: true, changed: true }, "on over a directory");
  assert.equal(readInstancePin(h), true);
});

test("readInstancePin: a valid record only; anything else is false, never an error", (t) => {
  const h = home(t);
  const file = join(h, PIN_FILE);
  assert.equal(readInstancePin(h), false, "no file");
  const put = (v) => { rmSync(file, { recursive: true, force: true }); writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v)); };
  put({ pinnedApi: 1, at: "x" });
  assert.equal(readInstancePin(h), true);
  put({ pinnedApi: 1 });
  assert.equal(readInstancePin(h), true, "present means pinned: `at` is informative");
  for (const bad of ["", "{", "null", "[]", "true", "\"on\"", { pinnedApi: 2, at: "x" }, { pinnedApi: "1" }, { pinned: true }, {}]) {
    put(bad);
    assert.equal(readInstancePin(h), false, JSON.stringify(bad));
  }
  // Past 4 KiB: not a record, however it parses.
  put(JSON.stringify({ pinnedApi: 1, pad: "x".repeat(RECORD_MAX) }));
  assert.equal(readInstancePin(h), false, "over RECORD_MAX");
  put(JSON.stringify({ pinnedApi: 1, pad: "x".repeat(RECORD_MAX - 60) }));
  assert.equal(readInstancePin(h), true, "within RECORD_MAX");
  // A link is never followed, a directory is not a file, an unreadable file is none.
  rmSync(file);
  const target = join(dirname(h), "elsewhere.json");
  writeFileSync(target, JSON.stringify({ pinnedApi: 1 }));
  symlinkSync(target, file);
  assert.equal(readInstancePin(h), false, "a symlink");
  rmSync(file);
  mkdirSync(file);
  assert.equal(readInstancePin(h), false, "a directory");
  rmSync(file, { recursive: true });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    put({ pinnedApi: 1 });
    chmodSync(file, 0o000);
    assert.equal(readInstancePin(h), false, "unreadable");
    chmodSync(file, 0o600);
  }
});

test("the pin file is kernel-owned: a capability cannot declare it, and it is no change to the home's stored digest", (t) => {
  assert.ok(KERNEL_HOME_RECEIPTS.has(PIN_FILE));
  for (const root of [PIN_FILE, ".oats-pinned", ".oats-pinned.json.tmp-1"]) assert.equal(disposableHomeRootProblem(root), "kernel-owned", root);
  const schema = JSON.parse(readFileSync(new URL("../docs/capability-manifest.schema.json", import.meta.url), "utf8"));
  // The schema's kernel-owned prefix pattern (one of `retirement.disposable.home`'s `not` patterns) matches it.
  const patterns = []; JSON.stringify(schema, (k, v) => { if (k === "pattern" && typeof v === "string") patterns.push(v); return v; });
  assert.ok(patterns.some((p) => p.startsWith("^\\.oats-(?:") && new RegExp(p).test(PIN_FILE)), "the manifest schema refuses it too");
  const h = home(t);
  writeFileSync(join(h, "AGENTS.md"), "# x\n");
  const digest = () => storedTreeDigest(h, 2, { instanceHome: true });
  const before = digest();
  writeInstancePin(h, true);
  assert.equal(digest(), before, "pinning does not change the home");
  writeInstancePin(h, false);
  assert.equal(digest(), before);
});

test("oats instance pin: on, on again, off, off again; status rows and inspect --home carry it; the feature", (t) => {
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "c", "--no-launch", "--json"]), "spawn");
  const name = spawned.instance;
  const file = join(spawned.home, PIN_FILE);
  const inspected = () => okResult(fx.cli(["inspect", "--home", spawned.home, "--json"]), "inspect").instance;
  assert.equal(Object.hasOwn(statusRow(fx, name), "pinned"), false, "not pinned yet");
  assert.equal(Object.hasOwn(inspected(), "pinned"), false);

  // a. on writes the record at 0600 and answers the change; on again changes nothing, byte for byte.
  assert.deepEqual(okResult(fx.cli(["instance", "pin", name, "on", "--json"]), "on"), { instancePinApi: 1, instance: name, home: spawned.home, pinned: true, changed: true });
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["at", "pinnedApi"]);
  assert.equal(record.pinnedApi, 1);
  assert.equal(typeof record.at, "string");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const bytes = readFileSync(file);
  assert.deepEqual(okResult(fx.cli(["instance", "pin", name, "on", "--json"]), "again"), { instancePinApi: 1, instance: name, home: spawned.home, pinned: true, changed: false });
  assert.deepEqual(readFileSync(file), bytes, "a second on leaves the bytes");
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(spawned.home, "instance.json"), "utf8")), "pinned"), false, "instance.json keeps its shape");
  // c. the row and inspect carry it.
  assert.equal(statusRow(fx, name).pinned, true);
  assert.equal(inspected().pinned, true);
  assert.equal(okResult(fx.cli(["instance", "pin", name, "on", "--home", spawned.home, "--json"]), "by --home").changed, false);
  // b. off removes the file; off again is no change.
  assert.deepEqual(okResult(fx.cli(["instance", "pin", name, "off", "--json"]), "off"), { instancePinApi: 1, instance: name, home: spawned.home, pinned: false, changed: true });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.deepEqual(okResult(fx.cli(["instance", "pin", name, "off", "--json"]), "off again"), { instancePinApi: 1, instance: name, home: spawned.home, pinned: false, changed: false });
  assert.equal(Object.hasOwn(statusRow(fx, name), "pinned"), false);
  assert.equal(Object.hasOwn(inspected(), "pinned"), false);

  // e. `pinned` recorded in instance.json is not the fact: only the home's own record is.
  const metaFile = join(spawned.home, "instance.json");
  writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, "utf8")), pinned: true }, null, 2));
  assert.equal(Object.hasOwn(statusRow(fx, name), "pinned"), false, "a hand-written pinned in instance.json");
  assert.equal(Object.hasOwn(inspected(), "pinned"), false);
  // d. a symlink, an oversize file, invalid JSON and pinnedApi 2 each read as not pinned.
  const target = join(dirname(spawned.home), "pin-target.json");
  writeFileSync(target, JSON.stringify({ pinnedApi: 1 }));
  symlinkSync(target, file);
  assert.equal(Object.hasOwn(statusRow(fx, name), "pinned"), false, "a symlink");
  assert.equal(Object.hasOwn(inspected(), "pinned"), false, "a symlink: inspect");
  assert.equal(okResult(fx.cli(["instance", "pin", name, "off", "--json"]), "off a symlink").changed, false);
  assert.throws(() => lstatSync(file), { code: "ENOENT" }, "the link is removed");
  assert.equal(readFileSync(target, "utf8"), JSON.stringify({ pinnedApi: 1 }), "and not its target");
  for (const [bytesAt, what] of [[JSON.stringify({ pinnedApi: 1, pad: "x".repeat(RECORD_MAX) }), "oversize"], ["{not json", "invalid JSON"], [JSON.stringify({ pinnedApi: 2, at: "x" }), "pinnedApi 2"]]) {
    writeFileSync(file, bytesAt);
    assert.equal(Object.hasOwn(statusRow(fx, name), "pinned"), false, what);
    assert.equal(Object.hasOwn(inspected(), "pinned"), false, `${what}: inspect`);
  }
  assert.equal(okResult(fx.cli(["instance", "pin", name, "off", "--json"]), "off an invalid record").changed, false);
  assert.throws(() => lstatSync(file), { code: "ENOENT" });

  // The text answer.
  let r = fx.cli(["instance", "pin", name, "on"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${name}: pinned`);
  r = fx.cli(["instance", "pin", name, "on"]);
  assert.equal(r.stdout.trim(), `${name}: pinned (unchanged)`);
  r = fx.cli(["instance", "pin", name, "off"]);
  assert.equal(r.stdout.trim(), `${name}: not pinned`);
  r = fx.cli(["instance", "pin", name, "off"]);
  assert.equal(r.stdout.trim(), `${name}: not pinned (unchanged)`);
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("instance-pin"));
});

test("oats instance pin refuses bad arguments, resolves as instance background does, and refuses a home being retired", (t) => {
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "r", "--no-launch", "--json"]), "spawn");
  const name = spawned.instance;
  for (const [argv, what] of [[[name], "neither"], [[name, "yes"], "not on|off"], [[name, "ON"], "case"]]) {
    const e = refused(fx.cli(["instance", "pin", ...argv, "--json"]), what);
    assert.equal(e.code, "E_BAD_ARGS", what);
    assert.match(e.message, /^give on or off; usage: oats instance pin <instance> on\|off/, what);
  }
  assert.equal(refused(fx.cli(["instance", "pin", "--json"]), "no instance").code, "E_BAD_ARGS");
  // Two words: the argument after the state, refused before the command runs (lib/command-flags.mjs).
  const two = refused(fx.cli(["instance", "pin", name, "on", "off", "--json"]), "two");
  assert.equal(two.code, "E_BAD_ARGS", "two");
  assert.match(two.message, /^oats instance pin: unexpected argument "off" after the state "on": instance pin takes one instance and one state\nusage: oats instance pin <instance> on\|off/, "two");
  // Resolution: what `oats instance background` answers.
  const backgroundCode = (argv) => refused(fx.cli(["instance", "background", ...argv, "on", "--json"]), `background ${argv}`).code;
  const pinCode = (argv) => refused(fx.cli(["instance", "pin", ...argv, "on", "--json"]), `pin ${argv}`).code;
  for (const argv of [["nobody"], [name, "--home", join(dirname(spawned.home), "elsewhere")], [name, "--home", "relative/home"]]) {
    assert.equal(pinCode(argv), backgroundCode(argv), JSON.stringify(argv));
  }
  assert.equal(pinCode(["nobody"]), "E_SESSION_UNKNOWN");
  // g. A retire in flight: its pending marker beside the home.
  const marker = retirePendingMarkerPath(spawned.home);
  writeFileSync(marker, JSON.stringify({ reason: "retire pending" }));
  const retiring = refused(fx.cli(["instance", "pin", name, "on", "--json"]), "retiring");
  assert.equal(retiring.code, "E_INSTANCE_RETIRING");
  assert.match(retiring.message, /is being retired; the pin was not changed$/);
  assert.equal(existsSync(join(spawned.home, PIN_FILE)), false, "no file is written");
  rmSync(marker);
  assert.equal(okResult(fx.cli(["instance", "pin", name, "on", "--json"]), "after").pinned, true);
});

test("beside a held lifecycle claim, oats instance pin says the pin was not changed, in its own words", (t) => {
  const holder = { action: "retire", pid: 4242, processStart: "proc:start", nonce: "a".repeat(32), at: "2026-11-19T10:00:00.000Z" };
  const refusals = lifecycleClaimRefusals("instance pin", "w1", "/h/w1", "/h/w1/.lock");
  for (const e of [refusals.busy(holder, null, "/h/w1/.lock"), refusals.unreadableClaim("/h/w1/.lock")]) {
    assert.match(e.message, /; the pin was not changed — /, e.message);
    assert.doesNotMatch(e.message, /nothing was done/);
  }
  // The command itself: a file at the home's claim path that reads as no claim refuses before any write.
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "r", "--no-launch", "--json"]), "spawn");
  const lock = retireClaimPath(spawned.home);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, "not a claim");
  const e = refused(fx.cli(["instance", "pin", spawned.instance, "on", "--json"]), "beside a claim");
  assert.equal(e.code, "E_LIFECYCLE_BUSY");
  assert.match(e.message, /is not a readable claim; the pin was not changed — /);
  assert.equal(existsSync(join(spawned.home, PIN_FILE)), false, "nothing was written");
  rmSync(lock);
  assert.equal(okResult(fx.cli(["instance", "pin", spawned.instance, "on", "--json"]), "after").pinned, true);
});

test("beside a live stop, start or upgrade the pin goes through, as background's does; beside a live retire it is refused and nothing is written", async (t) => {
  // The lead's decision on spec A: the pin mirrors `instance background` (refuseBesideRetire). The pin is its own
  // file, which no start, stop or upgrade writes, so only a retire, which removes the home, refuses it.
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "h", "--no-launch", "--json"]), "spawn");
  const name = spawned.instance;
  const file = join(spawned.home, PIN_FILE);
  for (const verb of ["stop", "start", "upgrade"]) {
    const held = await fx.inEnv(() => claimHomeFor(verb, name, spawned.home));
    try {
      assert.deepEqual(okResult(fx.cli(["instance", "pin", name, "on", "--json"]), `on beside ${verb}`), { instancePinApi: 1, instance: name, home: spawned.home, pinned: true, changed: true });
      assert.equal(readInstancePin(spawned.home), true, `${verb}: pinned`);
      assert.equal(okResult(fx.cli(["instance", "pin", name, "off", "--json"]), `off beside ${verb}`).changed, true);
      assert.equal(existsSync(file), false, `${verb}: unpinned`);
    } finally { await fx.inEnv(() => releaseHomeClaim(held)); }
  }
  okResult(fx.cli(["instance", "pin", name, "on", "--json"]), "pinned before the retire");
  const bytes = readFileSync(file);
  const held = await fx.inEnv(() => claimHomeFor("retire", name, spawned.home));
  try {
    for (const state of ["on", "off"]) {
      const e = refused(fx.cli(["instance", "pin", name, state, "--json"]), `${state} beside a live retire`);
      assert.equal(e.code, "E_INSTANCE_RETIRING", `${state}: ${e.message}`);
      assert.match(e.message, /the pin was not changed/, state);
      assert.deepEqual(readFileSync(file), bytes, `${state}: the pin's bytes are unchanged`);
    }
  } finally { await fx.inEnv(() => releaseHomeClaim(held)); }
});

test("retire removes the pin with the home, and the pin is no unexplained change at retire", (t) => {
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "x", "--no-launch", "--json"]), "spawn");
  okResult(fx.cli(["instance", "pin", spawned.instance, "on", "--json"]), "on");
  const r = fx.cli(["retire", spawned.instance, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(spawned.home), false, "the home, and its pin, are gone");
  assert.equal(statusRow(fx, spawned.instance), undefined);
});
