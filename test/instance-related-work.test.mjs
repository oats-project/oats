// Feature instance-related-work (the same-work flag of awebai/oats#1577, renamed): an instance's declared "related
// work" with its parent, else its sibling, in a home file of its own (`.oats-related-work.json`,
// lib/instance-related-work.mjs) bound to the relation it was set against. Set at spawn (`--related-work`) or by
// `oats instance related-work <instance> on|off`; read on status rows, where `relatedWork: true` stands only while
// that relation is still the row's: a parent binding while it names the current `parentInstance`, a sibling
// binding while the row has no parent and it names the current `siblingInstance`.
//
// What is pinned here:
// - the record: its two shapes and mode, written only on a change, rebound to another relation; the reader takes a
//   regular file of at most 4 KiB that is a valid record with exactly one of parent and sibling, and anything else
//   is no binding, never an error; the one choice of a binding and the one rule;
// - both names are kernel-owned (`.oats-related-work` and the old `.oats-same-work`): a capability cannot declare
//   them, they are retire receipts, the manifest schema refuses them, and the flag is no change to the home's
//   stored digest;
// - spawn: `--related-work` binds whichever relation records a parent, else the sibling it records (a sibling of a
//   root binds the root, a sibling of a sibling binds the sibling it was spawned beside), and is refused with
//   nothing created (a preview's included) when neither is recorded; `--relation parent` leaves its anchor's flag
//   bound to the old relation;
// - the compatibility layer (item 4 of the related-work contract): `--same-work`, `oats instance same-work` and
//   spawnInstance's `sameWork` are aliases, bound by the same rule, each use saying so once on stderr and never in
//   a --json answer; rows carry `sameWork: true` beside `relatedWork: true` for a parent binding only, and the
//   verb's answer `sameWork` the same; the old `.oats-same-work.json` reads as a parent binding while the new file
//   is absent, the new file wins when both exist, the write that creates it removes the old one, and off both;
// - the verb: its exact answer, on twice writes nothing, off always succeeds, on with neither relation is refused,
//   resolution as `instance color` answers it, E_INSTANCE_RETIRING beside a retire or in a quarantined home;
//   a corrupt, oversized, linked or directory record reads off and off removes it; the feature, and the old one
//   still advertised beside it;
// - retire: the file is never work; a parent's retirement, which relinks its child, and a sibling's retirement,
//   which moves its sibling's link, leave the flag off until `on` rebinds it.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { RECORD_MAX, RELATED_WORK_FILE, SAME_WORK_FILE, readRelatedWork, relatedWorkBinding, relatedWorkOf, writeRelatedWork } from "../lib/instance-related-work.mjs";
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
  const base = fixtureBase("oats-instance-related-work-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "home");
  mkdirSync(dir);
  return dir;
}
/** The status rows of `fx`, by instance name. status --json answers its document bare, not in an envelope. On every
 *  row, the flag's old name `sameWork: true` stands exactly beside `relatedWork: true` of a parent binding (a row
 *  with a parent holds only a parent binding), and never as `false`. */
function rows(fx) {
  const r = fx.cli(["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const byName = Object.fromEntries(JSON.parse(r.stdout).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
  for (const [name, row] of Object.entries(byName)) {
    const parentBound = row.relatedWork === true && typeof row.parentInstance === "string" && row.parentInstance !== "";
    assert.equal(Object.hasOwn(row, "sameWork"), parentBound, `${name}: sameWork beside a parent binding only`);
    if (parentBound) assert.equal(row.sameWork, true, name);
  }
  return byName;
}
const spawnCli = (fx, args, what) => okResult(fx.cli(["spawn", "dev", ...args, "--no-launch", "--json"]), what);
const instanceNames = (fx) => { const dir = join(fx.root, "dev", "instances"); return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")).sort() : []; };
const meta = (h) => JSON.parse(readFileSync(join(h, "instance.json"), "utf8"));

test("writeRelatedWork: both record shapes and their mode; the same binding again writes nothing; another binding rebinds; null removes it", (t) => {
  const h = home(t);
  const at = new Date("2026-11-20T12:00:00.000Z");
  assert.deepEqual(writeRelatedWork(h, { parent: "boss" }, { now: () => at }), { changed: true });
  const file = join(h, RELATED_WORK_FILE);
  assert.equal(RELATED_WORK_FILE, ".oats-related-work.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { relatedWorkApi: 1, parent: "boss", at: "2026-11-20T12:00:00.000Z" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = statSync(file).mtimeMs;
  assert.deepEqual(writeRelatedWork(h, { parent: "boss" }, { now: () => new Date("2027-01-01T00:00:00.000Z") }), { changed: false });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).at, "2026-11-20T12:00:00.000Z", "nothing was written");
  assert.equal(statSync(file).mtimeMs, before);
  assert.deepEqual(writeRelatedWork(h, { parent: "lead" }), { changed: true }, "a record bound to an old parent is rewritten");
  assert.deepEqual(readRelatedWork(h), { parent: "lead" });
  // The same name as a sibling is another binding: rewritten, with exactly one of the two keys.
  assert.deepEqual(writeRelatedWork(h, { sibling: "lead" }, { now: () => at }), { changed: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { relatedWorkApi: 1, sibling: "lead", at: "2026-11-20T12:00:00.000Z" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(writeRelatedWork(h, { sibling: "lead" }), { changed: false });
  assert.deepEqual(writeRelatedWork(h, null), { changed: true });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.deepEqual(writeRelatedWork(h, null), { changed: false }, "removing no record is no change");
  for (const bad of ["", "boss", 1, undefined, ["boss"], {}, { parent: "" }, { sibling: 7 }, { parent: "a", sibling: "b" }, { other: "x" }, { parent: "a", at: "x" }]) {
    assert.throws(() => writeRelatedWork(h, bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => lstatSync(file), { code: "ENOENT" }, "a refused binding writes nothing");
});

test("readRelatedWork: a valid record only; anything else is null, never an error; relatedWorkBinding is the one choice and relatedWorkOf the one rule", (t) => {
  const h = home(t);
  const file = join(h, RELATED_WORK_FILE);
  assert.equal(readRelatedWork(h), null, "no file");
  const put = (v) => { rmSync(file, { recursive: true, force: true }); writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v)); };
  put({ relatedWorkApi: 1, parent: "boss", at: "x" });
  assert.deepEqual(readRelatedWork(h), { parent: "boss" });
  put({ relatedWorkApi: 1, sibling: "root", at: "x" });
  assert.deepEqual(readRelatedWork(h), { sibling: "root" });
  for (const bad of ["", "{", "null", "[]", "\"boss\"", { relatedWorkApi: 2, parent: "boss" }, { parent: "boss" }, { relatedWorkApi: 1, parent: "" }, { relatedWorkApi: 1, parent: 7 },
    { relatedWorkApi: 1, parent: null }, { relatedWorkApi: 1 }, { relatedWorkApi: 1, sibling: "" }, { relatedWorkApi: 1, parent: "boss", sibling: "root" }, { relatedWorkApi: 1, parent: "boss", sibling: null },
    { relatedWorkApi: "1", parent: "boss" }, { sameWorkApi: 1, parent: "boss" }]) {
    put(bad);
    assert.equal(readRelatedWork(h), null, JSON.stringify(bad));
  }
  // Past 4 KiB: not a record, however it parses.
  put(JSON.stringify({ relatedWorkApi: 1, parent: "boss", pad: "x".repeat(RECORD_MAX) }));
  assert.equal(readRelatedWork(h), null, "over RECORD_MAX");
  put(JSON.stringify({ relatedWorkApi: 1, parent: "boss", pad: "x".repeat(RECORD_MAX - 60) }));
  assert.deepEqual(readRelatedWork(h), { parent: "boss" }, "within RECORD_MAX");
  // A link is never followed, a directory is not a file, an unreadable file is none.
  rmSync(file);
  const target = join(dirname(h), "elsewhere.json");
  writeFileSync(target, JSON.stringify({ relatedWorkApi: 1, parent: "boss" }));
  symlinkSync(target, file);
  assert.equal(readRelatedWork(h), null, "a symlink");
  assert.deepEqual(writeRelatedWork(h, null), { changed: false }, "off removes the link");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.ok(existsSync(target), "and never what it points at");
  mkdirSync(file);
  writeFileSync(join(file, "inner"), "x");
  assert.equal(readRelatedWork(h), null, "a directory");
  assert.deepEqual(writeRelatedWork(h, { sibling: "root" }), { changed: true }, "on replaces a directory at the name");
  assert.deepEqual(readRelatedWork(h), { sibling: "root" });
  rmSync(file); mkdirSync(file);
  assert.deepEqual(writeRelatedWork(h, null), { changed: false }, "off removes a directory at the name");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    put({ relatedWorkApi: 1, parent: "boss" });
    chmodSync(file, 0o000);
    assert.equal(readRelatedWork(h), null, "unreadable");
    chmodSync(file, 0o600);
  }
  // The choice: the recorded parent, else the recorded sibling, else none.
  assert.deepEqual(relatedWorkBinding({ parentInstance: "boss", siblingInstance: "root" }), { parent: "boss" });
  assert.deepEqual(relatedWorkBinding({ siblingInstance: "root" }), { sibling: "root" });
  assert.deepEqual(relatedWorkBinding({ parentInstance: "", siblingInstance: "root" }), { sibling: "root" });
  for (const none of [{}, { parentInstance: null, siblingInstance: "" }, { parentInstance: 1 }, null, undefined]) assert.equal(relatedWorkBinding(none), null, JSON.stringify(none));
  // The rule for a parent binding: exactly the current parent, whatever the sibling.
  put({ relatedWorkApi: 1, parent: "boss" });
  assert.equal(relatedWorkOf(h, { parentInstance: "boss" }), true);
  assert.equal(relatedWorkOf(h, { parentInstance: "boss", siblingInstance: "root" }), true);
  for (const lineage of [{ parentInstance: "lead" }, { parentInstance: "Boss" }, { siblingInstance: "boss" }, {}, { parentInstance: "" }, null]) {
    assert.equal(relatedWorkOf(h, lineage), false, JSON.stringify(lineage));
  }
  // The rule for a sibling binding: no parent, and exactly the current sibling.
  put({ relatedWorkApi: 1, sibling: "root" });
  assert.equal(relatedWorkOf(h, { siblingInstance: "root" }), true);
  assert.equal(relatedWorkOf(h, { parentInstance: "", siblingInstance: "root" }), true, "an empty parent is none");
  for (const lineage of [{ parentInstance: "boss", siblingInstance: "root" }, { parentInstance: "root" }, { siblingInstance: "other" }, {}, null]) {
    assert.equal(relatedWorkOf(h, lineage), false, JSON.stringify(lineage));
  }
  rmSync(file);
  assert.equal(relatedWorkOf(h, { parentInstance: "boss" }), false, "no record");
});

test("both flag files are kernel-owned: a capability cannot declare them, they are retire receipts, the schema refuses them, and the flag is no change to the home's stored digest", (t) => {
  assert.equal(SAME_WORK_FILE, ".oats-same-work.json");
  for (const file of [RELATED_WORK_FILE, SAME_WORK_FILE]) assert.ok(KERNEL_HOME_RECEIPTS.has(file), file);
  for (const root of [RELATED_WORK_FILE, ".oats-related-work", ".oats-related-work.json.tmp-1", SAME_WORK_FILE, ".oats-same-work", ".oats-same-work.json.tmp-1"]) {
    assert.equal(disposableHomeRootProblem(root), "kernel-owned", root);
  }
  // The schema's kernel-owned prefix pattern (one of `retirement.disposable.home`'s `not` patterns) matches both.
  const schema = JSON.parse(readFileSync(new URL("../docs/capability-manifest.schema.json", import.meta.url), "utf8"));
  const patterns = []; JSON.stringify(schema, (k, v) => { if (k === "pattern" && typeof v === "string") patterns.push(v); return v; });
  for (const file of [RELATED_WORK_FILE, SAME_WORK_FILE]) assert.ok(patterns.some((p) => p.startsWith("^\\.oats-(?:") && new RegExp(p).test(file)), `the manifest schema refuses ${file} too`);
  const h = home(t);
  writeFileSync(join(h, "AGENTS.md"), "# x\n");
  const digest = () => storedTreeDigest(h, 2, { instanceHome: true });
  const before = digest();
  writeRelatedWork(h, { parent: "boss" });
  assert.equal(digest(), before, "setting the flag does not change the home");
  writeRelatedWork(h, { sibling: "root" });
  assert.equal(digest(), before);
  writeRelatedWork(h, null);
  writeFileSync(join(h, SAME_WORK_FILE), JSON.stringify({ sameWorkApi: 1, parent: "boss", at: "x" }));
  assert.equal(digest(), before, "an old same-work file is no change either");
});

test("spawn --related-work: bound to the parent the new home records, by each relation that records one; refused with nothing created when it records neither parent nor sibling", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss").instance;
  // A spawn that records neither: refused before anything is created, a preview's included.
  for (const [args, what] of [[[], "no relation"], [["--relation", "unrelated"], "unrelated"], [["--relation", "parent", "--relative-to", boss], "parent of a root"]]) {
    for (const preview of [false, true]) {
      const before = instanceNames(fx);
      const e = refused(fx.cli(["spawn", "dev", "--purpose", "nope", ...args, "--related-work", ...(preview ? ["--preview"] : []), "--no-launch", "--json"]), `${what}${preview ? " preview" : ""}`);
      assert.equal(e.code, "E_BAD_ARGS", `${what}: ${e.message}`);
      assert.match(e.message, /^--related-work needs a parent or a sibling: dev-nope would record no parent or sibling instance/);
      assert.match(e.message, /nothing was spawned$/);
      assert.deepEqual(instanceNames(fx), before, `${what}: nothing was created`);
    }
  }
  // A preview with a parent answers as before: the flag adds no field.
  const preview = okResult(fx.cli(["spawn", "dev", "--purpose", "kid", "--parent", boss, "--related-work", "--preview", "--json"]), "preview");
  assert.equal(preview.parentInstance, boss);
  assert.equal(Object.hasOwn(preview, "relatedWork"), false);
  assert.equal(Object.hasOwn(preview, "sameWork"), false);
  assert.equal(Object.hasOwn(preview, "relatedWorkApi"), false);
  assert.equal(existsSync(preview.home), false, "a preview creates nothing");

  // A child: flagged, bound to its parent, shown from its first status.
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss, "--related-work"], "child");
  assert.deepEqual(readRelatedWork(kid.home), { parent: boss });
  assert.equal(statSync(join(kid.home, RELATED_WORK_FILE)).mode & 0o777, 0o600);
  assert.equal(existsSync(join(kid.home, SAME_WORK_FILE)), false, "the old file is never written");
  // Another child, unflagged; a sibling of the (non-root) child shares its parent; --relation child, the long form.
  const plain = spawnCli(fx, ["--purpose", "plain", "--parent", boss], "unflagged child");
  const sib = spawnCli(fx, ["--purpose", "sib", "--relation", "sibling", "--relative-to", kid.instance, "--related-work"], "sibling of a child");
  assert.equal(sib.parent, boss, "the spawn answer names it parent");
  assert.deepEqual(readRelatedWork(sib.home), { parent: boss }, "a sibling of a child records a parent: a parent binding");
  const longForm = spawnCli(fx, ["--purpose", "long", "--relation", "child", "--relative-to", boss, "--related-work"], "relation child");
  // Attached: the parent is the work tree's owner.
  const owner = spawnCli(fx, ["--purpose", "owner", "--work", "worktree"], "tree owner");
  const attached = spawnCli(fx, ["--purpose", "att", "--work", "attached", "--work-dir", join(owner.home, "work"), "--related-work"], "attached");
  assert.equal(attached.parent, owner.instance);
  assert.deepEqual(readRelatedWork(attached.home), { parent: owner.instance });
  let r = rows(fx);
  for (const name of [attached.instance, kid.instance, sib.instance, longForm.instance]) assert.equal(r[name].relatedWork, true, name);
  for (const name of [boss, plain.instance, owner.instance]) assert.equal(Object.hasOwn(r[name], "relatedWork"), false, `${name}: absent, never false or null`);
  assert.equal(existsSync(join(plain.home, RELATED_WORK_FILE)), false, "an unflagged spawn writes no record");

  // --relation parent under a parented anchor: the new instance inherits the anchor's parent and is bound to it;
  // the anchor, re-pointed at the new instance, keeps its record bound to the old parent, so its flag reads off.
  const mid = spawnCli(fx, ["--purpose", "mid", "--relation", "parent", "--relative-to", kid.instance, "--related-work"], "relation parent");
  assert.equal(mid.parent, boss);
  assert.deepEqual(readRelatedWork(kid.home), { parent: boss }, "the anchor's file is not touched");
  r = rows(fx);
  assert.equal(r[mid.instance].relatedWork, true);
  assert.equal(r[kid.instance].parentInstance, mid.instance);
  assert.equal(Object.hasOwn(r[kid.instance], "relatedWork"), false, "bound to an old parent: absent");
  // `on` rebinds to the current parent.
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "rebind"), { instance: kid.instance, relatedWork: true, sameWork: true });
  assert.deepEqual(readRelatedWork(kid.home), { parent: mid.instance });
  assert.equal(rows(fx)[kid.instance].relatedWork, true);
});

test("spawn --related-work with a sibling and no parent: bound to the sibling the new home records, the root for a sibling of a root, the anchor for a sibling of a sibling", (t) => {
  const fx = v2Deployment({ t });
  const root = spawnCli(fx, ["--purpose", "root"], "root").instance;
  // A sibling of a top-level instance R: bound to R.
  const s = spawnCli(fx, ["--purpose", "s", "--relation", "sibling", "--relative-to", root, "--related-work"], "sibling of a root");
  assert.equal(s.sibling, root);
  assert.equal(meta(s.home).siblingInstance, root);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, RELATED_WORK_FILE), "utf8")), { relatedWorkApi: 1, sibling: root, at: JSON.parse(readFileSync(join(s.home, RELATED_WORK_FILE), "utf8")).at });
  assert.equal(statSync(join(s.home, RELATED_WORK_FILE)).mode & 0o777, 0o600);
  // A sibling of the sibling S: the home records S (lib/core.mjs records the anchor itself), so it is bound to S.
  const t2 = spawnCli(fx, ["--purpose", "t", "--relation", "sibling", "--relative-to", s.instance, "--related-work"], "sibling of a sibling");
  assert.equal(meta(t2.home).siblingInstance, s.instance);
  assert.deepEqual(readRelatedWork(t2.home), { sibling: s.instance }, "bound to the sibling it records");
  // A preview of a sibling binding: refused nowhere, and creates nothing.
  const shown = okResult(fx.cli(["spawn", "dev", "--purpose", "seen", "--relation", "sibling", "--relative-to", root, "--related-work", "--preview", "--json"]), "preview");
  assert.equal(existsSync(shown.home), false);
  // --relation parent over the sibling S: the new instance takes S's slot, its sibling link to R included.
  const over = spawnCli(fx, ["--purpose", "over", "--relation", "parent", "--relative-to", s.instance, "--related-work"], "parent over a root's sibling");
  assert.equal(meta(over.home).siblingInstance, root);
  assert.equal(meta(over.home).parentInstance, undefined);
  assert.deepEqual(readRelatedWork(over.home), { sibling: root });
  const plain = spawnCli(fx, ["--purpose", "plain", "--relation", "sibling", "--relative-to", root], "unflagged sibling");
  const r = rows(fx);
  for (const name of [t2.instance, over.instance]) assert.equal(r[name].relatedWork, true, name);
  // S is now the child of `over`: it records a parent, so its sibling binding to R reads off.
  assert.equal(r[s.instance].parentInstance, over.instance);
  assert.equal(Object.hasOwn(r[s.instance], "relatedWork"), false, "a sibling binding with a parent recorded: absent");
  for (const name of [root, plain.instance]) assert.equal(Object.hasOwn(r[name], "relatedWork"), false, name);
});

test("the deprecated aliases work as the new spellings, by the same rule: --same-work, oats instance same-work and spawnInstance's sameWork; each use says so once on stderr, never in a --json answer", async (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss");
  const FLAG = "oats: --same-work is renamed: use --related-work", VERB = "oats: oats instance same-work is renamed: use oats instance related-work";
  /** `oats <argv> --json`: its envelope, parsed from the whole of stdout (one JSON document, no deprecation in it),
   *  and its stderr's lines. */
  const json = (argv, what) => {
    const r = fx.cli([...argv, "--json"]);
    assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
    const envelope = JSON.parse(r.stdout);
    assert.doesNotMatch(r.stdout, /renamed|deprecat/i, `${what}: nothing of the deprecation in the --json answer`);
    assert.equal(envelope.ok, true, what);
    assert.equal(Object.hasOwn(envelope, "warnings"), false, `${what}: no envelope warning`);
    return { result: envelope.result, stderr: r.stderr.split("\n").filter(Boolean) };
  };
  // --same-work: a parent binding, as --related-work gives it.
  const kid = json(["spawn", "dev", "--purpose", "kid", "--parent", boss.instance, "--same-work", "--no-launch"], "spawn --same-work");
  assert.deepEqual(kid.stderr.filter((l) => l.includes("renamed")), [FLAG], "one deprecation line, on stderr");
  assert.deepEqual(readRelatedWork(kid.result.home), { parent: boss.instance });
  assert.equal(existsSync(join(kid.result.home, SAME_WORK_FILE)), false, "the alias writes the new file only");
  // ... and a sibling binding, by the same rule (parent, else sibling).
  const peer = json(["spawn", "dev", "--purpose", "peer", "--relation", "sibling", "--relative-to", boss.instance, "--same-work", "--no-launch"], "sibling --same-work");
  assert.deepEqual(readRelatedWork(peer.result.home), { sibling: boss.instance });
  // A preview with the alias says so too, and creates nothing.
  const shown = json(["spawn", "dev", "--purpose", "seen", "--parent", boss.instance, "--same-work", "--preview"], "preview --same-work");
  assert.deepEqual(shown.stderr.filter((l) => l.includes("renamed")), [FLAG]);
  assert.equal(existsSync(shown.result.home), false);
  // With neither relation, the alias is refused as the new spelling is, nothing created.
  const before = instanceNames(fx);
  const refusal = fx.cli(["spawn", "dev", "--purpose", "nope", "--same-work", "--no-launch", "--json"]);
  assert.equal(refused(refusal, "alias with neither").code, "E_BAD_ARGS");
  assert.deepEqual(instanceNames(fx), before);
  // A switch takes no value, as every switch.
  assert.equal(refused(fx.cli(["spawn", "dev", "--purpose", "old", "--same-work=true", "--json"]), "--same-work=").code, "E_BAD_ARGS");
  let r = rows(fx);
  assert.equal(r[kid.result.instance].relatedWork, true);
  assert.equal(r[kid.result.instance].sameWork, true, "a parent binding: sameWork beside relatedWork");
  assert.equal(r[peer.result.instance].relatedWork, true);
  assert.equal(Object.hasOwn(r[peer.result.instance], "sameWork"), false, "a sibling binding: no sameWork");

  // oats instance same-work: the verb, with the same answer and one line on stderr.
  const off = json(["instance", "same-work", kid.result.instance, "off"], "same-work off");
  assert.deepEqual(off.result, { instance: kid.result.instance, relatedWork: false, sameWork: false });
  assert.deepEqual(off.stderr.filter((l) => l.includes("renamed")), [VERB]);
  const on = json(["instance", "same-work", kid.result.instance, "on"], "same-work on");
  assert.deepEqual(on.result, { instance: kid.result.instance, relatedWork: true, sameWork: true });
  assert.deepEqual(json(["instance", "same-work", peer.result.instance, "on"], "same-work on a sibling").result, { instance: peer.result.instance, relatedWork: true, sameWork: false });
  // In text: the new verb's line on stdout, the deprecation on stderr.
  const text = fx.cli(["instance", "same-work", kid.result.instance, "on"]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.trim(), `${kid.result.instance}: related work on`);
  assert.deepEqual(text.stderr.split("\n").filter((l) => l.includes("renamed")), [VERB]);
  // The new spellings say nothing of the kind.
  assert.deepEqual(json(["instance", "related-work", kid.result.instance, "on"], "new verb").stderr.filter((l) => l.includes("renamed")), []);
  // spawnInstance's sameWork option is the same alias.
  const prog = await fx.spawn("dev", { instance: "dev-prog", parent: boss.instance, sameWork: true });
  assert.deepEqual(readRelatedWork(prog.home), { parent: boss.instance });
  await assert.rejects(fx.spawn("dev", { instance: "dev-prog2", parent: boss.instance, sameWork: "yes" }), (e) => e.code === "E_BAD_ARGS" && e.message === "sameWork must be true or false");
});

test("the old .oats-same-work.json reads as a parent binding while the new file is absent; the new file wins when both exist; the write that creates it removes the old one, and off removes both", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss");
  const mid = spawnCli(fx, ["--purpose", "mid", "--parent", boss.instance], "mid");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss.instance], "kid");
  const old = join(kid.home, SAME_WORK_FILE), file = join(kid.home, RELATED_WORK_FILE);
  const oldBytes = JSON.stringify({ sameWorkApi: 1, parent: boss.instance, at: "2026-10-27T12:00:00.000Z" }) + "\n";
  const putOld = (parent = boss.instance) => writeFileSync(old, JSON.stringify({ sameWorkApi: 1, parent, at: "2026-10-27T12:00:00.000Z" }) + "\n", { mode: 0o600 });
  // A flag set before the rename keeps working: the old record, bound to the current parent, is a parent binding.
  putOld();
  let r = rows(fx);
  assert.equal(r[kid.instance].relatedWork, true, "an existing flag reads on");
  assert.equal(r[kid.instance].sameWork, true);
  assert.deepEqual(readRelatedWork(kid.home), { parent: boss.instance });
  // on with that binding again is no change: nothing written, the old file left as it is.
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "on again"), { instance: kid.instance, relatedWork: true, sameWork: true });
  assert.equal(readFileSync(old, "utf8"), oldBytes);
  assert.equal(existsSync(file), false);
  // An old record bound to another parent reads off, as it always did; the old format is a parent binding only.
  putOld("someone");
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "relatedWork"), false);
  writeFileSync(old, JSON.stringify({ sameWorkApi: 1, sibling: boss.instance }));
  assert.equal(readRelatedWork(kid.home), null, "no sibling in the old format");
  for (const bad of ["{", JSON.stringify({ sameWorkApi: 2, parent: boss.instance }), JSON.stringify({ relatedWorkApi: 1, parent: boss.instance })]) {
    writeFileSync(old, bad);
    assert.equal(readRelatedWork(kid.home), null, bad);
  }
  // The write that creates the new file removes the old one.
  putOld("someone");
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "rebind"), { instance: kid.instance, relatedWork: true, sameWork: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).parent, boss.instance);
  assert.equal(existsSync(old), false, "the old file goes with the write that creates the new one");
  // Both present: the new one wins, whatever the old says, an invalid new one included.
  putOld(mid.instance);
  assert.deepEqual(readRelatedWork(kid.home), { parent: boss.instance });
  writeFileSync(file, "{not json");
  assert.equal(readRelatedWork(kid.home), null, "an invalid new record wins over a valid old one");
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "relatedWork"), false);
  // off removes both, whatever stands at either name.
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "off", "--json"]), "off"), { instance: kid.instance, relatedWork: false, sameWork: false });
  for (const path of [file, old]) assert.throws(() => lstatSync(path), { code: "ENOENT" }, path);
  putOld();
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "off", "--json"]), "off the old file alone"), { instance: kid.instance, relatedWork: false, sameWork: false });
  assert.throws(() => lstatSync(old), { code: "ENOENT" });
  // A sameWork or relatedWork in instance.json is no flag.
  const metaFile = join(kid.home, "instance.json");
  writeFileSync(metaFile, JSON.stringify({ ...meta(kid.home), sameWork: true, relatedWork: true }, null, 2));
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "relatedWork"), false);
});

test("oats instance related-work: on, on again, off, off again; the exact answer; on with neither parent nor sibling is refused; a sibling binding; the text; the feature", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss.instance], "kid");
  const file = join(kid.home, RELATED_WORK_FILE);
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "relatedWork"), false);

  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "on"), { instance: kid.instance, relatedWork: true, sameWork: true });
  assert.equal(rows(fx)[kid.instance].relatedWork, true);
  const written = readFileSync(file, "utf8"), mtime = statSync(file).mtimeMs;
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--home", kid.home, "--json"]), "on again"), { instance: kid.instance, relatedWork: true, sameWork: true });
  assert.equal(readFileSync(file, "utf8"), written, "on twice writes nothing");
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "off", "--json"]), "off"), { instance: kid.instance, relatedWork: false, sameWork: false });
  assert.equal(existsSync(file), false);
  assert.equal(Object.hasOwn(rows(fx)[kid.instance], "relatedWork"), false);
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "off", "--json"]), "off again"), { instance: kid.instance, relatedWork: false, sameWork: false });

  // A root's sibling: on binds the sibling it records.
  const peer = spawnCli(fx, ["--purpose", "peer", "--relation", "sibling", "--relative-to", boss.instance], "peer");
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", peer.instance, "on", "--json"]), "sibling on"), { instance: peer.instance, relatedWork: true, sameWork: false });
  assert.deepEqual(readRelatedWork(peer.home), { sibling: boss.instance });
  assert.equal(rows(fx)[peer.instance].relatedWork, true);
  const peerWritten = readFileSync(join(peer.home, RELATED_WORK_FILE), "utf8");
  okResult(fx.cli(["instance", "related-work", peer.instance, "on", "--json"]), "sibling on again");
  assert.equal(readFileSync(join(peer.home, RELATED_WORK_FILE), "utf8"), peerWritten, "the same sibling binding writes nothing");

  // Neither parent nor sibling recorded: on is refused, naming the instance and why; nothing is written; off still succeeds.
  const e = refused(fx.cli(["instance", "related-work", boss.instance, "on", "--json"]), "on with neither");
  assert.equal(e.code, "E_BAD_ARGS");
  assert.equal(e.message, `${boss.instance} would record no parent or sibling instance: related work is declared against a recorded parent or sibling; the flag was not changed`);
  assert.equal(existsSync(join(boss.home, RELATED_WORK_FILE)), false);
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", boss.instance, "off", "--json"]), "off with neither"), { instance: boss.instance, relatedWork: false, sameWork: false });
  // A record left in a home that has neither (hand-made, or its edge removed) reads off, and off removes it.
  writeRelatedWork(boss.home, { parent: "someone" });
  assert.equal(Object.hasOwn(rows(fx)[boss.instance], "relatedWork"), false);
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", boss.instance, "off", "--json"]), "off a stray record"), { instance: boss.instance, relatedWork: false, sameWork: false });
  assert.equal(existsSync(join(boss.home, RELATED_WORK_FILE)), false);

  // Arguments: exactly one of on or off.
  for (const [argv, what] of [[[kid.instance], "neither"], [[kid.instance, "yes"], "another word"], [[kid.instance, "on", "off"], "both"]]) {
    assert.equal(refused(fx.cli(["instance", "related-work", ...argv, "--json"]), what).code, "E_BAD_ARGS", what);
  }
  for (const [word, said] of [["on", "on"], ["off", "off"]]) {
    const r = fx.cli(["instance", "related-work", kid.instance, word]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `${kid.instance}: related work ${said}`);
  }
  const features = JSON.parse(fx.cli(["version", "--json"]).stdout).features;
  assert.ok(features.includes("instance-related-work"));
  assert.ok(features.includes("instance-same-work"), "the old feature is still advertised beside it (the compatibility layer)");
});

test("oats instance related-work resolves as instance color does, refuses a home being retired or quarantined, and reads a corrupt record as off", (t) => {
  const fx = v2Deployment({ t });
  const boss = spawnCli(fx, ["--purpose", "boss"], "boss");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", boss.instance], "kid");
  const relatedWorkCode = (argv) => refused(fx.cli(["instance", "related-work", ...argv, "on", "--json"]), `related-work ${argv}`).code;
  const colorCode = (argv) => refused(fx.cli(["instance", "color", ...argv, "sage", "--json"]), `color ${argv}`).code;
  for (const argv of [["nobody"], [kid.instance, "--home", join(dirname(kid.home), "elsewhere")], [kid.instance, "--home", "relative/home"]]) {
    assert.equal(relatedWorkCode(argv), colorCode(argv), JSON.stringify(argv));
  }
  assert.equal(relatedWorkCode(["nobody"]), "E_SESSION_UNKNOWN");
  // A retire in flight, then a quarantined home: E_INSTANCE_RETIRING, on or off, nothing written.
  const marker = retirePendingMarkerPath(kid.home);
  writeFileSync(marker, JSON.stringify({ reason: "retire pending" }));
  for (const word of ["on", "off"]) {
    const e = refused(fx.cli(["instance", "related-work", kid.instance, word, "--json"]), `retiring ${word}`);
    assert.equal(e.code, "E_INSTANCE_RETIRING");
    assert.match(e.message, /is being retired; the flag was not changed$/);
  }
  assert.equal(existsSync(join(kid.home, RELATED_WORK_FILE)), false, "nothing was written");
  rmSync(marker);
  const quarantine = join(kid.home, ".oats-rollback-incomplete.json");
  writeFileSync(quarantine, JSON.stringify({ reason: "rollback incomplete" }));
  const q = refused(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "quarantined");
  assert.equal(q.code, "E_INSTANCE_RETIRING");
  assert.match(q.message, /quarantined home .*; the flag was not changed$/);
  rmSync(quarantine);

  // Whatever stands at the name that is not a valid record reads off, and off removes it.
  const file = join(kid.home, RELATED_WORK_FILE);
  const elsewhere = join(fx.base, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify({ relatedWorkApi: 1, parent: boss.instance }));
  const states = {
    corrupt: () => writeFileSync(file, "{not json"),
    oversized: () => writeFileSync(file, JSON.stringify({ relatedWorkApi: 1, parent: boss.instance, pad: "x".repeat(RECORD_MAX) })),
    both: () => writeFileSync(file, JSON.stringify({ relatedWorkApi: 1, parent: boss.instance, sibling: boss.instance })),
    symlink: () => symlinkSync(elsewhere, file),
    directory: () => { mkdirSync(file); writeFileSync(join(file, "inner"), "x"); },
  };
  for (const [what, make] of Object.entries(states)) {
    make();
    assert.equal(Object.hasOwn(rows(fx)[kid.instance], "relatedWork"), false, `${what}: off`);
    assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "off", "--json"]), `${what}: off`), { instance: kid.instance, relatedWork: false, sameWork: false });
    assert.throws(() => lstatSync(file), { code: "ENOENT" }, `${what}: removed`);
  }
  assert.ok(existsSync(elsewhere), "a link's target is never touched");
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "after"), { instance: kid.instance, relatedWork: true, sameWork: true });
});

test("retire: the flag is never work; a parent's retirement relinks its flagged child, and a sibling's retirement moves its flagged sibling's link, whose flag then reads off until on rebinds it", async (t) => {
  const fx = v2Deployment({ t });
  const top = spawnCli(fx, ["--purpose", "top"], "top");
  const mid = spawnCli(fx, ["--purpose", "mid", "--parent", top.instance], "mid");
  const kid = spawnCli(fx, ["--purpose", "kid", "--parent", mid.instance, "--related-work"], "kid");
  const leaf = spawnCli(fx, ["--purpose", "leaf", "--parent", top.instance, "--related-work"], "leaf");
  assert.equal(rows(fx)[kid.instance].relatedWork, true);

  // A flagged home alone retires without a recovery copy: the file is kernel presentation, never work. So is an
  // old same-work file left in it.
  writeFileSync(join(leaf.home, SAME_WORK_FILE), JSON.stringify({ sameWorkApi: 1, parent: top.instance, at: "x" }));
  const gone = await fx.inEnv(() => retireInstance(fx.root, leaf.instance, { tmuxSession: "oats-test-nosuch" }));
  assert.equal(gone.workRecovery, undefined, JSON.stringify(gone.workRecovery));
  assert.equal(gone.removedDir, true);
  assert.equal(existsSync(leaf.home), false);

  // The parent's retirement re-points the child to the retiree's parent; the child's record stays bound to the
  // retiree, so the row carries no relatedWork, and nothing errors.
  const retired = await fx.inEnv(() => retireInstance(fx.root, mid.instance, { tmuxSession: "oats-test-nosuch" }));
  assert.equal(retired.removedDir, true);
  let r = rows(fx);
  assert.equal(r[kid.instance].parentInstance, top.instance);
  assert.equal(Object.hasOwn(r[kid.instance], "relatedWork"), false);
  assert.deepEqual(readRelatedWork(kid.home), { parent: mid.instance }, "the relink leaves the record alone");
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", kid.instance, "on", "--json"]), "rebind"), { instance: kid.instance, relatedWork: true, sameWork: true });
  assert.deepEqual(readRelatedWork(kid.home), { parent: top.instance });
  assert.equal(rows(fx)[kid.instance].relatedWork, true);

  // A sibling cluster Q ← R ← S (R a sibling of the root Q, S a sibling of R, flagged): R's retirement moves S's
  // sibling link to Q; S's record stays bound to R, so the flag reads off until on binds Q.
  const q = spawnCli(fx, ["--purpose", "q"], "q");
  const rr = spawnCli(fx, ["--purpose", "r", "--relation", "sibling", "--relative-to", q.instance], "r");
  const s = spawnCli(fx, ["--purpose", "s", "--relation", "sibling", "--relative-to", rr.instance, "--related-work"], "s");
  assert.deepEqual(readRelatedWork(s.home), { sibling: rr.instance });
  assert.equal(rows(fx)[s.instance].relatedWork, true);
  const siblingGone = await fx.inEnv(() => retireInstance(fx.root, rr.instance, { tmuxSession: "oats-test-nosuch" }));
  assert.equal(siblingGone.removedDir, true);
  r = rows(fx);
  assert.equal(r[s.instance].siblingInstance, q.instance, "the link moved to the retiree's own sibling");
  assert.equal(Object.hasOwn(r[s.instance], "relatedWork"), false, "bound to the retired sibling: absent");
  assert.deepEqual(readRelatedWork(s.home), { sibling: rr.instance });
  assert.deepEqual(okResult(fx.cli(["instance", "related-work", s.instance, "on", "--json"]), "rebind a sibling"), { instance: s.instance, relatedWork: true, sameWork: false });
  assert.deepEqual(readRelatedWork(s.home), { sibling: q.instance });
  assert.equal(rows(fx)[s.instance].relatedWork, true);
  // The cluster root Q retires: S's link to it is dropped (Q had none to hand on), S becomes top-level, and with
  // neither relation its flag reads off; on is then refused.
  await fx.inEnv(() => retireInstance(fx.root, q.instance, { tmuxSession: "oats-test-nosuch" }));
  r = rows(fx);
  assert.equal(r[s.instance].siblingInstance ?? null, null);
  assert.equal(Object.hasOwn(r[s.instance], "relatedWork"), false);
  assert.equal(refused(fx.cli(["instance", "related-work", s.instance, "on", "--json"]), "on, top-level now").code, "E_BAD_ARGS");
});
