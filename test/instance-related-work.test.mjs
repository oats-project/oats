// Feature instance-same-work (awebai/oats#1577): a child instance's declared "same work as my parent", in a home
// file of its own (`.oats-same-work.json`, lib/instance-related-work.mjs) bound to the parent it was set against.
// Set at spawn (`--same-work`) or by `oats instance same-work <instance> on|off`; read on status rows, where
// `sameWork: true` stands only while the bound parent is the row's current `parentInstance`.
//
// What is pinned here:
// - the record: its shape and mode, written only on a change, rebound to a new parent; the reader takes a regular
//   file of at most 4 KiB that is a valid record, and anything else is no binding, never an error; the one rule;
// - the file is kernel-owned: a capability cannot declare it, and it is no change to the home's stored digest;
// - spawn: `--same-work` binds whichever relation records a parent, and is refused with nothing created (a
//   preview's included) when none does; `--relation parent` leaves its anchor's flag bound to the old parent;
// - the verb: its exact answer, on twice writes nothing, off always succeeds, on without a parent is refused,
//   resolution as `instance color` answers it, E_INSTANCE_RETIRING beside a retire or in a quarantined home;
//   a corrupt, oversized, linked or directory record reads off and off removes it; the feature;
// - status rows: the key is absent on every unflagged row, never false or null;
// - retire: the file is never work, and a parent's retirement, which relinks its child, leaves the child's flag off
//   until `on` rebinds it.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { RECORD_MAX, SAME_WORK_FILE, readSameWork, sameWorkOf, writeSameWork } from "../lib/instance-related-work.mjs";
import { disposableHomeRootProblem } from "../lib/capability-contract.mjs";
import { KERNEL_HOME_RECEIPTS, retireInstance, retirePendingMarkerPath, storedTreeDigest } from "../lib/core.mjs";

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
  const base = fixtureBase("oats-instance-same-work-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "home");
  mkdirSync(dir);
  return dir;
}
/** The status rows of `fx`, by instance name. status --json answers its document bare, not in an envelope. */
function rows(fx) {
  const r = fx.cli(["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return Object.fromEntries(JSON.parse(r.stdout).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
}
const spawnCli = (fx, args, what) => okResult(fx.cli(["spawn", "dev", ...args, "--no-launch", "--json"]), what);
const instanceNames = (fx) => { const dir = join(fx.root, "dev", "instances"); return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : []; };

test("writeSameWork: the record and its mode; the same parent again writes nothing; another parent rebinds; null removes it", (t) => {
  const h = home(t);
  const at = new Date("2026-10-27T12:00:00.000Z");
  assert.deepEqual(writeSameWork(h, "boss", { now: () => at }), { changed: true });
  const file = join(h, SAME_WORK_FILE);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sameWorkApi: 1, parent: "boss", at: "2026-10-27T12:00:00.000Z" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = statSync(file).mtimeMs;
  assert.deepEqual(writeSameWork(h, "boss", { now: () => new Date("2027-01-01T00:00:00.000Z") }), { changed: false });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).at, "2026-10-27T12:00:00.000Z", "nothing was written");
  assert.equal(statSync(file).mtimeMs, before);
  assert.deepEqual(writeSameWork(h, "lead"), { changed: true }, "a record bound to an old parent is rewritten");
  assert.equal(readSameWork(h), "lead");
  assert.deepEqual(writeSameWork(h, null), { changed: true });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.deepEqual(writeSameWork(h, null), { changed: false }, "removing no record is no change");
  for (const bad of ["", 1, undefined, ["boss"]]) assert.throws(() => writeSameWork(h, bad), TypeError, JSON.stringify(bad));
});

test("readSameWork: a valid record only; anything else is null, never an error; sameWorkOf is the one rule", (t) => {
  const h = home(t);
  const file = join(h, SAME_WORK_FILE);
  assert.equal(readSameWork(h), null, "no file");
  const put = (v) => { rmSync(file, { recursive: true, force: true }); writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v)); };
  put({ sameWorkApi: 1, parent: "boss", at: "x" });
  assert.equal(readSameWork(h), "boss");
  for (const bad of ["", "{", "null", "[]", "\"boss\"", { sameWorkApi: 2, parent: "boss" }, { parent: "boss" }, { sameWorkApi: 1, parent: "" }, { sameWorkApi: 1, parent: 7 }, { sameWorkApi: 1, parent: null }, { sameWorkApi: 1 }]) {
    put(bad);
    assert.equal(readSameWork(h), null, JSON.stringify(bad));
  }
  // Past 4 KiB: not a record, however it parses.
  put(JSON.stringify({ sameWorkApi: 1, parent: "boss", pad: "x".repeat(RECORD_MAX) }));
  assert.equal(readSameWork(h), null, "over RECORD_MAX");
  put(JSON.stringify({ sameWorkApi: 1, parent: "boss", pad: "x".repeat(RECORD_MAX - 60) }));
  assert.equal(readSameWork(h), "boss", "within RECORD_MAX");
  // A link is never followed, a directory is not a file, an unreadable file is none.
  rmSync(file);
  const target = join(dirname(h), "elsewhere.json");
  writeFileSync(target, JSON.stringify({ sameWorkApi: 1, parent: "boss" }));
  symlinkSync(target, file);
  assert.equal(readSameWork(h), null, "a symlink");
  assert.deepEqual(writeSameWork(h, null), { changed: false }, "off removes the link");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.ok(existsSync(target), "and never what it points at");
  mkdirSync(file);
  writeFileSync(join(file, "inner"), "x");
  assert.equal(readSameWork(h), null, "a directory");
  assert.deepEqual(writeSameWork(h, "boss"), { changed: true }, "on replaces a directory at the name");
  assert.equal(readSameWork(h), "boss");
  rmSync(file); mkdirSync(file);
  assert.deepEqual(writeSameWork(h, null), { changed: false }, "off removes a directory at the name");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    put({ sameWorkApi: 1, parent: "boss" });
    chmodSync(file, 0o000);
    assert.equal(readSameWork(h), null, "unreadable");
    chmodSync(file, 0o600);
  }
  // The rule: the record bound to exactly the current parent, and a parent at all.
  put({ sameWorkApi: 1, parent: "boss" });
  assert.equal(sameWorkOf(h, "boss"), true);
  for (const p of ["lead", "Boss", "", null, undefined, 1]) assert.equal(sameWorkOf(h, p), false, JSON.stringify(p));
  rmSync(file);
  assert.equal(sameWorkOf(h, "boss"), false, "no record");
});

test("the same-work file is kernel-owned: a capability cannot declare it, and it is no change to the home's stored digest", (t) => {
  assert.ok(KERNEL_HOME_RECEIPTS.has(SAME_WORK_FILE));
  for (const root of [SAME_WORK_FILE, ".oats-same-work", ".oats-same-work.json.tmp-1"]) assert.equal(disposableHomeRootProblem(root), "kernel-owned", root);
  // The schema's kernel-owned prefix pattern (one of `retirement.disposable.home`'s `not` patterns) matches it.
  const schema = JSON.parse(readFileSync(new URL("../docs/capability-manifest.schema.json", import.meta.url), "utf8"));
  const patterns = []; JSON.stringify(schema, (k, v) => { if (k === "pattern" && typeof v === "string") patterns.push(v); return v; });
  assert.ok(patterns.some((p) => p.startsWith("^\\.oats-(?:") && new RegExp(p).test(SAME_WORK_FILE)), "the manifest schema refuses it too");
  const h = home(t);
  writeFileSync(join(h, "AGENTS.md"), "# x\n");
  const digest = () => storedTreeDigest(h, 2, { instanceHome: true });
  const before = digest();
  writeSameWork(h, "boss");
  assert.equal(digest(), before, "setting the flag does not change the home");
  writeSameWork(h, null);
  assert.equal(digest(), before);
});

test("spawn --same-work: bound to the parent the new home records, by each relation that records one; refused with nothing created when none does", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss").instance;
  // A relation that records no parent: refused before anything is created, a preview's included.
  for (const [args, what] of [[[], "no relation"], [["--relation", "unrelated"], "unrelated"], [["--relation", "sibling", "--relative-to", boss], "sibling of a root"], [["--relation", "parent", "--relative-to", boss], "parent of a root"]]) {
    for (const preview of [false, true]) {
      const before = instanceNames(fx);
      const e = refused(fx.cli(["spawn", "dev", "--purpose", "nope", ...args, "--same-work", ...(preview ? ["--preview"] : []), "--no-launch", "--json"]), `${what}${preview ? " preview" : ""}`);
      assert.equal(e.code, "E_BAD_ARGS", `${what}: ${e.message}`);
      assert.match(e.message, /^--same-work needs a parent: dev-nope would record no parent instance/);
      assert.deepEqual(instanceNames(fx), before, `${what}: nothing was created`);
    }
  }
  // A preview with a parent answers as before: the flag adds no field.
  const preview = okResult(fx.cli(["spawn", "dev", "--purpose", "kid", "--parent", boss, "--same-work", "--preview", "--json"]), "preview");
  assert.equal(preview.parentInstance, boss);
  assert.equal(Object.hasOwn(preview, "sameWork"), false);
  assert.equal(existsSync(preview.home), false, "a preview creates nothing");

  // A child: flagged, bound to its parent, shown from its first status.
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss, "--same-work"], "child");
  assert.equal(readSameWork(kid.home), boss);
  assert.equal(statSync(join(kid.home, SAME_WORK_FILE)).mode & 0o777, 0o600);
  // Another child, unflagged; a sibling of the (non-root) child shares its parent; --relation child, the long form.
  const plain = spawnCli(fx, ["--purpose", "plain", "--parent", boss], "unflagged child");
  const sib = spawnCli(fx, ["--purpose", "sib", "--relation", "sibling", "--relative-to", kid.instance, "--same-work"], "sibling of a child");
  assert.equal(sib.parent, boss, "the spawn answer names it parent");
  const longForm = spawnCli(fx, ["--purpose", "long", "--relation", "child", "--relative-to", boss, "--same-work"], "relation child");
  // Attached: the parent is the work tree's owner.
  const owner = spawnCli(fx, ["--purpose", "owner", "--work", "worktree"], "tree owner");
  const attached = spawnCli(fx, ["--purpose", "att", "--work", "attached", "--work-dir", join(owner.home, "work"), "--same-work"], "attached");
  assert.equal(attached.parent, owner.instance);
  assert.equal(readSameWork(attached.home), owner.instance);
  let r = rows(fx);
  assert.equal(r[attached.instance].sameWork, true);
  assert.equal(r[kid.instance].sameWork, true);
  assert.equal(r[sib.instance].sameWork, true);
  assert.equal(r[longForm.instance].sameWork, true);
  for (const name of [boss, plain.instance, owner.instance]) assert.equal(Object.hasOwn(r[name], "sameWork"), false, `${name}: absent, never false or null`);
  assert.equal(existsSync(join(plain.home, SAME_WORK_FILE)), false, "an unflagged spawn writes no record");

  // --relation parent under a parented anchor: the new instance inherits the anchor's parent and is bound to it;
  // the anchor, re-pointed at the new instance, keeps its record bound to the old parent, so its flag reads off.
  const mid = spawnCli(fx, ["--purpose", "mid", "--relation", "parent", "--relative-to", kid.instance, "--same-work"], "relation parent");
  assert.equal(mid.parent, boss);
  assert.equal(readSameWork(kid.home), boss, "the anchor's file is not touched");
  r = rows(fx);
  assert.equal(r[mid.instance].sameWork, true);
  assert.equal(r[kid.instance].parentInstance, mid.instance);
  assert.equal(Object.hasOwn(r[kid.instance], "sameWork"), false, "bound to an old parent: absent");
  // `on` rebinds to the current parent.
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "on", "--json"]), "rebind"), { instance: kid.instance, sameWork: true });
  assert.equal(readSameWork(kid.home), mid.instance);
  assert.equal(rows(fx)[kid.instance].sameWork, true);
});

test("oats instance same-work: on, on again, off, off again; the exact answer; on without a parent is refused; the text; the feature", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss.instance], "kid");
  const file = join(kid.home, SAME_WORK_FILE);
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "sameWork"), false);

  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "on", "--json"]), "on"), { instance: kid.instance, sameWork: true });
  assert.equal(rows(fx)[kid.instance].sameWork, true);
  const written = readFileSync(file, "utf8"), mtime = statSync(file).mtimeMs;
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "on", "--home", kid.home, "--json"]), "on again"), { instance: kid.instance, sameWork: true });
  assert.equal(readFileSync(file, "utf8"), written, "on twice writes nothing");
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "off", "--json"]), "off"), { instance: kid.instance, sameWork: false });
  assert.equal(existsSync(file), false);
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "sameWork"), false);
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "off", "--json"]), "off again"), { instance: kid.instance, sameWork: false });

  // No recorded parent: on is refused, naming the instance; off still succeeds.
  const e = refused(fx.cli(["instance", "same-work", boss.instance, "on", "--json"]), "on without a parent");
  assert.equal(e.code, "E_BAD_ARGS");
  assert.equal(e.message, `${boss.instance} has no parent instance: same work is declared against a recorded parent; the flag was not changed`);
  assert.equal(existsSync(join(boss.home, SAME_WORK_FILE)), false);
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", boss.instance, "off", "--json"]), "off without a parent"), { instance: boss.instance, sameWork: false });
  // A record left in a home that has no parent (hand-made, or its parent edge removed) reads off, and off removes it.
  writeSameWork(boss.home, "someone");
  assert.equal(Object.hasOwn(rows(fx)[boss.instance], "sameWork"), false);
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", boss.instance, "off", "--json"]), "off a stray record"), { instance: boss.instance, sameWork: false });
  assert.equal(existsSync(join(boss.home, SAME_WORK_FILE)), false);

  // A sameWork in instance.json is not the flag: only the home's own record is.
  const metaFile = join(kid.home, "instance.json");
  writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, "utf8")), sameWork: true }, null, 2));
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "sameWork"), false);

  // Arguments: exactly one of on or off.
  for (const [argv, what] of [[[kid.instance], "neither"], [[kid.instance, "yes"], "another word"], [[kid.instance, "on", "off"], "both"]]) {
    assert.equal(refused(fx.cli(["instance", "same-work", ...argv, "--json"]), what).code, "E_BAD_ARGS", what);
  }
  for (const [word, said] of [["on", "on"], ["off", "off"]]) {
    const r = fx.cli(["instance", "same-work", kid.instance, word]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${kid.instance}: same work ${said}`);
  }
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("instance-same-work"));
});

test("oats instance same-work resolves as instance color does, refuses a home being retired or quarantined, and reads a corrupt record as off", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss.instance], "kid");
  const sameWorkCode = (argv) => refused(fx.cli(["instance", "same-work", ...argv, "on", "--json"]), `same-work ${argv}`).code;
  const colorCode = (argv) => refused(fx.cli(["instance", "color", ...argv, "sage", "--json"]), `color ${argv}`).code;
  for (const argv of [["nobody"], [kid.instance, "--home", join(dirname(kid.home), "elsewhere")], [kid.instance, "--home", "relative/home"]]) {
    assert.equal(sameWorkCode(argv), colorCode(argv), JSON.stringify(argv));
  }
  assert.equal(sameWorkCode(["nobody"]), "E_SESSION_UNKNOWN");
  // A retire in flight, then a quarantined home: E_INSTANCE_RETIRING, on or off, nothing written.
  const marker = retirePendingMarkerPath(kid.home);
  writeFileSync(marker, JSON.stringify({ reason: "retire pending" }));
  for (const word of ["on", "off"]) {
    const e = refused(fx.cli(["instance", "same-work", kid.instance, word, "--json"]), `retiring ${word}`);
    assert.equal(e.code, "E_INSTANCE_RETIRING");
    assert.match(e.message, /is being retired; the flag was not changed$/);
  }
  assert.equal(existsSync(join(kid.home, SAME_WORK_FILE)), false, "nothing was written");
  rmSync(marker);
  const quarantine = join(kid.home, ".oats-rollback-incomplete.json");
  writeFileSync(quarantine, JSON.stringify({ reason: "rollback incomplete" }));
  const q = refused(fx.cli(["instance", "same-work", kid.instance, "on", "--json"]), "quarantined");
  assert.equal(q.code, "E_INSTANCE_RETIRING");
  assert.match(q.message, /quarantined home .*; the flag was not changed$/);
  rmSync(quarantine);

  // Whatever stands at the name that is not a valid record reads off, and off removes it.
  const file = join(kid.home, SAME_WORK_FILE);
  const elsewhere = join(fx.base, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify({ sameWorkApi: 1, parent: boss.instance }));
  const states = {
    corrupt: () => writeFileSync(file, "{not json"),
    oversized: () => writeFileSync(file, JSON.stringify({ sameWorkApi: 1, parent: boss.instance, pad: "x".repeat(RECORD_MAX) })),
    symlink: () => symlinkSync(elsewhere, file),
    directory: () => { mkdirSync(file); writeFileSync(join(file, "inner"), "x"); },
  };
  for (const [what, make] of Object.entries(states)) {
    make();
    assert.equal(Object.hasOwn(rows(fx)[kid.instance], "sameWork"), false, `${what}: off`);
    assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "off", "--json"]), `${what}: off`), { instance: kid.instance, sameWork: false });
    assert.throws(() => lstatSync(file), { code: "ENOENT" }, `${what}: removed`);
  }
  assert.ok(existsSync(elsewhere), "a link's target is never touched");
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "on", "--json"]), "after"), { instance: kid.instance, sameWork: true });
});

test("retire: the flag is never work; a parent's retirement relinks its flagged child, whose flag then reads off until on rebinds it", async (t) => {
  const fx = v2Deployment({ t });
  const top = spawnCli(fx, ["--purpose", "top"], "top");
  const mid = spawnCli(fx, ["--purpose", "mid", "--parent", top.instance], "mid");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", mid.instance, "--same-work"], "kid");
  const leaf = spawnCli(fx, ["--purpose", "leaf", "--parent", top.instance, "--same-work"], "leaf");
  assert.equal(rows(fx)[kid.instance].sameWork, true);

  // A flagged home alone retires without a recovery copy: the file is kernel presentation, never work.
  const gone = await fx.inEnv(() => retireInstance(fx.root, leaf.instance, { tmuxSession: "oats-test-nosuch" }));
  assert.equal(gone.workRecovery, undefined, JSON.stringify(gone.workRecovery));
  assert.equal(gone.removedDir, true);
  assert.equal(existsSync(leaf.home), false);

  // The parent's retirement re-points the child to the retiree's parent; the child's record stays bound to the
  // retiree, so the row carries no sameWork, and nothing errors.
  const retired = await fx.inEnv(() => retireInstance(fx.root, mid.instance, { tmuxSession: "oats-test-nosuch" }));
  assert.equal(retired.removedDir, true);
  const r = rows(fx);
  assert.equal(r[kid.instance].parentInstance, top.instance);
  assert.equal(Object.hasOwn(r[kid.instance], "sameWork"), false);
  assert.equal(readSameWork(kid.home), mid.instance, "the relink leaves the record alone");
  assert.deepEqual(okResult(fx.cli(["instance", "same-work", kid.instance, "on", "--json"]), "rebind"), { instance: kid.instance, sameWork: true });
  assert.equal(readSameWork(kid.home), top.instance);
  assert.equal(rows(fx)[kid.instance].sameWork, true);
});
