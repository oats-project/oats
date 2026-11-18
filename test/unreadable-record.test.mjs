// One home's record decides only for that home (awebai/oats#896, first half).
//
// A home whose `instance.json` is there and cannot be read as a JSON object (cut off, kept from its
// user, JSON that is no object, a directory, a link to nothing, empty) used to break commands that
// have nothing to do with it: the listing read and parsed every record with no catch, so `oats
// status` died with a stack and every other instance's stop and retire was refused. Now:
//
//   - `oats status` lists every instance; that home's row has the fields of a home without a
//     record, with `running: null`, `runtimeState: "unreachable"` and a `runtimeError` that names
//     the file and the reason;
//   - every command about ANOTHER instance answers as if that home were not there;
//   - every lifecycle command about THAT home (retire, retire --plan, retire --force, a guarded
//     retire, instance stop --plan and --apply, session start and restart) is refused with
//     E_UNIDENTIFIED_INSTANCE_HOME before any effect, and the home is byte-identical afterwards;
//   - a home with NO record (the stub of awebai/oats#866) answers as before.
//
// Every case runs the real CLI against a file shape that fails the same way each time.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeBin } from "./helpers/fake-ssh.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";
import { readHomeRecord, retireInstance, RETIRE_UNDER_CLAIM } from "../lib/core.mjs";

/** A mode no longer keeps root out: the shapes that rest on one are skipped for root. */
const ROOT = process.getuid?.() === 0;
const SKIP_FOR_ROOT = "root reads whatever the mode says: this shape cannot fail";
/** Without tmux no session starts, in an intact home either. */
const HAS_TMUX = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; } })();
/** Whether `stderr` holds a JavaScript stack trace. */
const hasStack = (stderr) => /^\s+at .*\(.*:\d+:\d+\)/m.test(stderr) || stderr.includes("node:internal");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** What JSON.parse says of `text` in this process: the parser's reason, whatever the Node version. */
const parserSays = (text) => { try { JSON.parse(text); } catch (e) { return e.message; } throw new Error(`fixture premise: ${JSON.stringify(text)} is not JSON`); };

/** Every entry under `dir`, one row each: its path, its mode, and a file's bytes (as a digest) or a
 *  link's target. An entry its owner may not read is listed with its mode, and neither read nor entered. */
function listing(dir, rel = "") {
  const rows = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const at = join(rel, name), abs = join(dir, at), st = lstatSync(abs);
    const mode = (st.mode & 0o7777).toString(8), readable = (st.mode & 0o400) !== 0;
    if (st.isSymbolicLink()) rows.push(`${at} -> ${readlinkSync(abs)}`);
    else if (st.isDirectory()) { rows.push(`${at}/ ${mode}`); if (readable) rows.push(...listing(dir, at)); }
    else if (st.isFile()) rows.push(`${at} ${mode} ${readable ? sha(readFileSync(abs)) : "(not read)"}`);
    else rows.push(`${at} ${mode} (not a file)`);
  }
  return rows;
}
/** Give every entry under `path` back to its owner, so that the fixture can be removed. */
function makeRemovable(path) {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if ((st.mode & 0o700) !== 0o700) chmodSync(path, (st.mode & 0o7777) | 0o700);
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  } else if (st.isFile() && (st.mode & 0o600) !== 0o600) chmodSync(path, (st.mode & 0o7777) | 0o600);
}

/** The shapes of a record that is there and gives no JSON object. `make(path)` breaks the record at
 *  `path`; `reason(original)` is what every answer says of it. The first five are the three shapes
 *  of the issue (cut off; mode 000; `null`, `[]`, `"x"`), the rest its edge cases. */
const SHAPES = [
  { id: "cut off", make: (p) => writeFileSync(p, readFileSync(p, "utf8").slice(0, 40)), reason: (original) => parserSays(original.slice(0, 40)) },
  { id: "kept from its user (mode 000)", root: true, make: (p) => chmodSync(p, 0), reason: () => "EACCES: permission denied" },
  { id: "the JSON null", make: (p) => writeFileSync(p, "null\n"), reason: () => "it holds null, not a JSON object" },
  { id: "a JSON array", make: (p) => writeFileSync(p, "[]\n"), reason: () => "it holds an array, not a JSON object" },
  { id: "a JSON string", make: (p) => writeFileSync(p, "\"x\"\n"), reason: () => "it holds a string, not a JSON object" },
  { id: "a directory", edge: true, make: (p) => { rmSync(p); mkdirSync(p); }, reason: () => "it is a directory" },
  { id: "a symbolic link to nothing", edge: true, make: (p) => { rmSync(p); symlinkSync(join(dirname(p), "no-such-file"), p); }, reason: () => "it is a symbolic link to nothing" },
  { id: "empty", edge: true, make: (p) => writeFileSync(p, ""), reason: () => parserSays("") },
];

/** A deployment with the instances `names` of the soul `dev` (no launch), whose capability has a
 *  retire hook that logs each run outside every home. Modes are given back before the base is removed. */
async function deployment(t, names, { otherSoul = false } = {}) {
  const soul = { soul: { work: "directory", capabilities: { "test.retire": { from: "here" } } } };
  const fx = v2Deployment({ t,
    souls: { dev: soul, ...(otherSoul ? { ops: soul } : {}) },
    capabilities: { "test.retire": { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": `import { appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(process.env.OATS_ROOT, "retire-hook.log"), process.env.OATS_INSTANCE + "\\n");
console.log(JSON.stringify({ meta: { retired: true } }));
` } } },
  });
  fx.beforeCleanup(() => makeRemovable(fx.base));
  // An in-process spawn finds its harness on this process's PATH: the fixture's inert ones.
  const hostPath = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  const homes = {};
  try { for (const name of names) homes[name] = (await fx.spawn("dev", { name })).home; } finally { process.env.PATH = hostPath; }
  const instances = join(fx.root, "dev", "instances");
  return { fx, homes, instances,
    /** The instances a retire hook ran for. */
    hookRuns: () => { try { return readFileSync(join(fx.root, "retire-hook.log"), "utf8").split("\n").filter(Boolean); } catch (e) { if (e.code === "ENOENT") return []; throw e; } },
    /** What is in the recovery directory: a retire's copies, and (named `.…`) one left half-made. */
    recoveries: () => { try { return readdirSync(join(instances, ".oats-retirement", "recovery")).sort(); } catch (e) { if (e.code === "ENOENT") return []; throw e; } },
    claim: (name) => join(instances, ".oats-retirement", "claims", `${name}.lock`),
    /** The rows of `oats status --json`, by instance name. */
    rows() {
      const r = fx.cli(["status", "--json"]);
      assert.equal(r.status, 0, `oats status --json exits 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(hasStack(r.stderr), false, `no stack: ${r.stderr}`);
      const status = JSON.parse(r.stdout);
      return Object.fromEntries(status.agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));
    },
  };
}
/** Break the record of `home` into `shape` → { record, reason, restore }. */
function breakRecord(home, shape) {
  const record = join(home, "instance.json");
  const original = readFileSync(record, "utf8");
  shape.make(record);
  return { record, reason: shape.reason(original), restore: () => { rmSync(record, { recursive: true, force: true }); writeFileSync(record, original, { mode: 0o600 }); } };
}
/** A CLI run that answered: exit 0, and no stack. */
function answered(r, what) {
  assert.equal(r.status, 0, `${what} exits 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(hasStack(r.stderr), false, `${what}: no stack: ${r.stderr}`);
  return r;
}
/** The one error of a CLI run that failed with `--json`: exit 1, exactly one envelope, no stack. */
function refusal(r, what) {
  assert.equal(r.status, 1, `${what}: exit status\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(hasStack(r.stderr), false, `${what}: no stack: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${what}: exactly one envelope on stdout: ${r.stdout}`);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, false);
  return envelope.error;
}
/** What every lifecycle verb answers for a home whose record at `record` cannot be read for `reason`. */
const refused = (record, reason, nothing = "nothing was done") => `${record} cannot be read (${reason}); ${nothing}. Restoring the file from a copy makes the home usable again; removing such a home through OATS is not possible yet.`;

// ---- 1. the listing ----

for (const shape of SHAPES) {
  test(`status with one record ${shape.id}: every instance is listed, and that home's row has the fields of a home without a record, unreachable, with the file and the reason`, async (t) => {
    if (shape.root && ROOT) { t.skip(SKIP_FOR_ROOT); return; }
    const d = await deployment(t, ["bad", "good"]);
    const stub = join(d.instances, "stub");
    mkdirSync(stub);
    const { record, reason } = breakRecord(d.homes.bad, shape);

    const rows = d.rows();
    assert.deepEqual(Object.keys(rows).sort(), ["bad", "good", "stub"], "every instance is listed");
    const runtimeError = `E_UNIDENTIFIED_INSTANCE_HOME: ${record} cannot be read (${reason})`;
    assert.deepEqual(rows.bad, { instance: "bad", home: d.homes.bad, startedAt: null, identityAddress: null, modelFrom: null, attributedHuman: null,
      running: null, runtimeState: "unreachable", runtimeError, waitingOnYou: null, color: null });
    // One row shape for a home without a usable record: the fields of the row a missing record gets, and the two that say why.
    assert.deepEqual(rows.stub, { instance: "stub", home: stub, startedAt: null, identityAddress: null, modelFrom: null, attributedHuman: null, running: false, waitingOnYou: null, color: null }, "the row of a home with no record is as before");
    assert.deepEqual(Object.keys(rows.bad).sort(), [...Object.keys(rows.stub), "runtimeState", "runtimeError"].sort());
    // The other instance's row is its record's, as ever.
    assert.equal(rows.good.agent, "dev");
    assert.equal(rows.good.running, false);
    assert.equal(rows.good.runtimeState, undefined);

    // Text mode shows the row with that error, as it shows a row whose tmux cannot be read.
    const text = answered(d.fx.cli(["status"]), "oats status");
    assert.ok(text.stdout.includes(`• bad  unknown  (branch ?, ?)  ${runtimeError}\n`), text.stdout);
    assert.match(text.stdout, /• good {2}idle /);
    assert.match(text.stdout, /• stub {2}idle /);
  });
}

// ---- 2. every command about ANOTHER instance ----

for (const shape of SHAPES.filter((s) => !s.edge)) {
  test(`beside a home whose record is ${shape.id}, another instance's stop, retire, session, events and a new spawn answer as if that home were not there`, async (t) => {
    if (shape.root && ROOT) { t.skip(SKIP_FOR_ROOT); return; }
    const d = await deployment(t, ["bad", "good"]);
    const { fx } = d;
    breakRecord(d.homes.bad, shape);
    const before = listing(d.homes.bad);

    const stopPlan = answered(fx.cli(["instance", "stop", "good", "--plan", "--json"]), "stop --plan of the other instance").json();
    assert.equal(stopPlan.ok, true);
    assert.deepEqual(stopPlan.result.targets.map((target) => target.instance), ["good"]);
    const stopped = answered(fx.cli(["instance", "stop", "good", "--apply", "--plan-revision", stopPlan.result.planRevision, "--idempotency-key", "k1", "--json"]), "stop --apply of the other instance").json();
    assert.equal(stopped.result.ok, true);
    assert.deepEqual(stopped.result.results.map((r) => [r.instance, r.ok]), [["good", true]]);

    const inspected = answered(fx.cli(["session", "inspect", "--home", d.homes.good, "--json"]), "session inspect of the other instance").json();
    assert.equal(inspected.result.state, "not-launched");
    const events = answered(fx.cli(["instance", "events", "good", "--json"]), "instance events of the other instance").json();
    assert.equal(events.result.instance, "good");
    assert.ok(events.result.events.some((e) => e.kind === "spawned"));

    if (HAS_TMUX) {
      const started = answered(fx.cli(["session", "start", "--home", d.homes.good, "--json"]), "session start of the other instance").json();
      assert.equal(started.ok, true);
      // The inert harness exits at once: plan once the session has settled into its fallback shell, so
      // that the apply finds what the plan read (a session still starting would make the plan stale).
      await waitUntil(() => existsSync(join(d.homes.good, ".oats-start-exited"))
        && answered(fx.cli(["session", "inspect", "--home", d.homes.good, "--json"]), "session inspect of the started instance").json().result.state === "shell",
      "the started session's harness to exit to its fallback shell");
      const observed = answered(fx.cli(["session", "inspect", "--home", d.homes.good, "--json"]), "the fallback shell beside the unreadable record").json().result;
      assert.equal(observed.present, true, "the started window remains after the inert harness exits");
      const row = d.rows().good;
      assert.deepEqual([row.running, row.runtimeState], [false, "shell"], "status agrees with inspection beside the unreadable record");
      const plan = answered(fx.cli(["instance", "stop", "good", "--plan", "--json"]), "stop --plan of the started instance").json();
      const again = answered(fx.cli(["instance", "stop", "good", "--apply", "--plan-revision", plan.result.planRevision, "--idempotency-key", "k2", "--json"]), "stop --apply of the started instance").json();
      assert.equal(again.result.ok, true);
    }

    const spawned = answered(fx.cli(["spawn", "dev", "--name", "new-one", "--no-launch", "--json"]), "spawn of a new instance").json();
    assert.equal(spawned.result.instance, "new-one");
    assert.ok(existsSync(join(d.instances, "new-one", "instance.json")));

    const retirePlan = answered(fx.cli(["retire", "good", "--plan", "--json"]), "retire --plan of the other instance").json();
    assert.equal(retirePlan.result.action, "retire");
    assert.deepEqual(retirePlan.result.facts.children, []);
    // A guarded retire (the Desktop's): the plan revision and an idempotency key.
    const retired = answered(fx.cli(["retire", "good", "--plan-revision", retirePlan.result.planRevision, "--idempotency-key", "r1", "--json"]), "retire of the other instance");
    assert.equal(JSON.parse(retired.stdout).retired, "good");
    assert.equal(existsSync(d.homes.good), false, "the other instance is retired");
    assert.deepEqual(d.hookRuns(), ["good"], "its retire hook ran, and no other");
    // A plain retire too.
    answered(fx.cli(["retire", "new-one", "--json"]), "a plain retire of the new instance");
    assert.equal(existsSync(join(d.instances, "new-one")), false);

    assert.deepEqual(listing(d.homes.bad), before, "the home whose record cannot be read is as it was");
    assert.deepEqual(Object.keys(d.rows()), ["bad"], "and it is still listed");
  });
}

test("a parent whose record cannot be read has no recorded children for a stop or a retire: they are listed and act on their own; a child whose record cannot be read is nobody's child", async (t) => {
  const d = await deployment(t, ["parent", "other"]);
  const { fx } = d;
  for (const [kid, of] of [["kid", "parent"], ["lost", "other"]]) answered(fx.cli(["spawn", "dev", "--name", kid, "--parent", of, "--no-launch", "--json"]), `spawn of ${kid}, a child of ${of}`);
  const kid = join(d.instances, "kid"), lost = join(d.instances, "lost");
  const plan = (name) => answered(fx.cli(["instance", "stop", name, "--plan", "--json"]), `stop --plan of ${name}`).json().result;
  assert.deepEqual(plan("parent").targets.map((target) => target.instance), ["kid", "parent"], "fixture premise: kid is a recorded child of parent");
  assert.deepEqual(plan("other").targets.map((target) => target.instance), ["lost", "other"], "fixture premise: lost is a recorded child of other");

  // The parent's record cannot be read: its child is listed, and stops and retires on its own.
  const parent = breakRecord(d.homes.parent, SHAPES[0]);
  // The child's record cannot be read: its parent's plans do not name it.
  breakRecord(lost, SHAPES[2]);
  const lostBefore = listing(lost);
  const withoutEvents = (rows) => rows.filter((row) => !row.startsWith(".oats-events"));
  const parentBefore = withoutEvents(listing(d.homes.parent));
  assert.deepEqual(Object.keys(d.rows()).sort(), ["kid", "lost", "other", "parent"]);

  assert.deepEqual(plan("kid").targets.map((target) => target.instance), ["kid"]);
  assert.equal(refusal(fx.cli(["instance", "stop", "parent", "--plan", "--json"]), "stop --plan of the parent").code, "E_UNIDENTIFIED_INSTANCE_HOME");
  answered(fx.cli(["retire", "kid", "--json"]), "retire of the child");
  assert.equal(existsSync(kid), false, "the child is retired");
  assert.deepEqual(withoutEvents(listing(d.homes.parent)), parentBefore, "the parent whose record cannot be read was neither stopped nor rewritten");

  assert.deepEqual(plan("other").targets.map((target) => target.instance), ["other"], "a child whose record cannot be read is not a target of its parent's stop");
  const retirePlan = answered(fx.cli(["retire", "other", "--plan", "--json"]), "retire --plan of the other parent").json().result;
  assert.deepEqual(retirePlan.facts.children, []);
  answered(fx.cli(["retire", "other", "--json"]), "retire of the other parent");
  assert.equal(existsSync(d.homes.other), false);
  assert.deepEqual(listing(lost), lostBefore, "the child whose record cannot be read was neither stopped, repaired nor removed");

  // Restored from a copy, the parent is usable again: the remedy the refusal names.
  parent.restore();
  assert.deepEqual(plan("parent").targets.map((target) => target.instance), ["parent"]);
});

for (const shape of SHAPES.filter((s) => !s.edge)) {
  test(`a home of the same name under another soul whose record is ${shape.id} is not a second parent: the healthy parent's stop and retire keep their recorded child`, async (t) => {
    if (shape.root && ROOT) { t.skip(SKIP_FOR_ROOT); return; }
    const d = await deployment(t, ["parent"], { otherSoul: true });
    const { fx } = d;
    answered(fx.cli(["spawn", "dev", "--name", "kid", "--parent", "parent", "--no-launch", "--json"]), "spawn of the child");
    // Two homes of one name: what a deployment from before 0.26.0 can hold, and `--home` tells apart.
    answered(fx.cli(["spawn", "ops", "--name", "twin", "--no-launch", "--json"]), "spawn of the other soul's instance");
    const twin = join(fx.root, "ops", "instances", "parent");
    renameSync(join(fx.root, "ops", "instances", "twin"), twin);
    const plan = (verb) => answered(fx.cli([...verb, "parent", "--home", d.homes.parent, "--plan", "--json"]), `${verb.join(" ")} --plan of the healthy parent`).json().result;
    // Both records readable: the child's parent name resolves to two homes, and the edge is not followed.
    const both = plan(["instance", "stop"]);
    assert.deepEqual(both.targets.map((target) => target.instance), ["parent"], "fixture premise: with two readable parents the child is not a target");
    assert.deepEqual(both.ambiguous.map((c) => c.instance), ["kid"], "fixture premise: and it is listed as ambiguous");

    breakRecord(twin, shape);
    const stop = plan(["instance", "stop"]);
    assert.deepEqual(stop.targets.map((target) => target.instance), ["kid", "parent"], "the home whose record cannot be read is nobody's parent");
    assert.deepEqual(stop.ambiguous, []);
    const retire = plan(["retire"]);
    assert.deepEqual(retire.facts.children.map((c) => c.instance), ["kid"]);
    assert.deepEqual(retire.facts.ambiguous, []);
  });

  test(`the roster through --server with one record ${shape.id} on the host: the group is answered, every instance is listed, and that home's row is unreachable with the file and the reason`, async (t) => {
    if (shape.root && ROOT) { t.skip(SKIP_FOR_ROOT); return; }
    const d = await deployment(t, ["bad", "good"]);
    const { fx } = d;
    // The SSH contract exercised locally (helpers/fake-ssh.mjs): a fake ssh runs the host's command
    // through `sh -c`, against the real kernel in this fixture's deployment.
    const client = join(fx.base, "client");
    const { bin, tools } = fakeBin(client);
    const env = { ...fx.env, PATH: bin, HOME: join(client, "home"), OATS_HOME_DIR: join(client, "oats-home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    const oats = (args) => {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: env.HOME, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      return { ...r, json: () => JSON.parse(r.stdout.trim().split("\n").pop()) };
    };
    answered(oats(["server", "add", "build", "--ssh", "build-host", "--workspace", fx.dep, "--oats", CLI, "--path", tools, "--json"]), "server add");
    const { record, reason } = breakRecord(d.homes.bad, shape);
    const runtimeError = `E_UNIDENTIFIED_INSTANCE_HOME: ${record} cannot be read (${reason})`;

    const roster = answered(oats(["server", "roster", "--json"]), "oats server roster").json();
    assert.equal(roster.ok, true);
    assert.equal(roster.result.groups.length, 1);
    const group = roster.result.groups[0];
    assert.equal(group.server, "build");
    assert.equal(group.probe.ok, true, `the host answered: ${JSON.stringify(group.probe)}`);
    const rows = Object.fromEntries(group.instances.map((i) => [i.instance, i]));
    assert.deepEqual(Object.keys(rows).sort(), ["bad", "good"], "every instance of the host is listed");
    assert.equal(rows.bad.home, d.homes.bad);
    assert.equal(rows.bad.running, null);
    assert.equal(rows.bad.runtimeState, "unreachable");
    assert.equal(rows.bad.runtimeError, runtimeError);
    assert.equal(rows.good.agent, "dev");
    assert.equal(rows.good.running, false);
    assert.equal(rows.good.runtimeError, undefined);

    // The host's own status through the route, and the roster's text.
    const status = answered(oats(["status", "--server", "build", "--json"]), "oats status --server");
    assert.ok(status.stdout.includes(JSON.stringify(runtimeError).slice(1, -1)), status.stdout);
    const text = answered(oats(["server", "roster"]), "oats server roster (text)");
    assert.ok(text.stdout.includes(runtimeError), text.stdout);
    assert.match(text.stdout, /\bgood\b/);
  });
}

// ---- 3. every lifecycle command about THAT home ----

/** The lifecycle commands about the instance `bad`, each with `--json`. */
const OWN_COMMANDS = [
  { id: "retire", argv: () => ["retire", "bad", "--json"] },
  { id: "retire --plan", argv: () => ["retire", "bad", "--plan", "--json"] },
  { id: "retire --force", argv: () => ["retire", "bad", "--force", "--json"] },
  { id: "retire --home --force", argv: (home) => ["retire", "bad", "--home", home, "--force", "--json"] },
  { id: "a guarded retire", argv: () => ["retire", "bad", "--plan-revision", "0123456789abcdef01234567", "--idempotency-key", "r1", "--json"] },
  { id: "instance stop --plan", argv: () => ["instance", "stop", "bad", "--plan", "--json"] },
  { id: "instance stop --apply", argv: () => ["instance", "stop", "bad", "--apply", "--plan-revision", "0123456789abcdef01234567", "--idempotency-key", "k1", "--json"] },
  { id: "session start", argv: (home) => ["session", "start", "--home", home, "--json"] },
  { id: "session restart", argv: (home) => ["session", "restart", "--home", home, "--json"] },
];
for (const shape of SHAPES) {
  test(`a home whose record is ${shape.id}: retire (plain, --plan, --force, guarded), instance stop (--plan, --apply) and session start|restart are refused with E_UNIDENTIFIED_INSTANCE_HOME before any effect, and the home is byte-identical`, async (t) => {
    if (shape.root && ROOT) { t.skip(SKIP_FOR_ROOT); return; }
    const d = await deployment(t, ["bad", "good"]);
    const { fx } = d;
    const { record, reason, restore } = breakRecord(d.homes.bad, shape);
    const before = listing(d.homes.bad);
    const untouched = (what) => {
      assert.deepEqual(listing(d.homes.bad), before, `${what}: the home is byte-identical`);
      assert.deepEqual(d.recoveries(), [], `${what}: no recovery copy was made, whole or half`);
      assert.equal(existsSync(d.claim("bad")), false, `${what}: no claim was taken`);
      assert.deepEqual(d.hookRuns(), [], `${what}: no retire hook ran`);
    };

    for (const command of OWN_COMMANDS) {
      const error = refusal(fx.cli(command.argv(d.homes.bad)), command.id);
      assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME", `${command.id}: ${JSON.stringify(error)}`);
      assert.equal(error.message, refused(record, reason), command.id);
      assert.equal(error.details, undefined, `${command.id}: nothing was reached, and the answer has no details`);
      untouched(command.id);
    }
    // Text mode: the same sentence on stderr, nothing on stdout.
    for (const argv of [["retire", "bad", "--force"], ["instance", "stop", "bad", "--plan"]]) {
      const text = fx.cli(argv);
      assert.equal(text.status, 1, text.stderr + text.stdout);
      assert.equal(text.stdout, "");
      assert.equal(text.stderr.trimEnd(), `oats: ${refused(record, reason)}`);
      untouched(argv.join(" "));
    }

    // The one remedy the sentence names exists: with the file restored from a copy, the home is usable again.
    restore();
    const plan = answered(fx.cli(["retire", "bad", "--plan", "--json"]), "retire --plan of the restored home").json();
    assert.equal(plan.result.instance, "bad");
    answered(fx.cli(["retire", "bad", "--json"]), "retire of the restored home");
    assert.equal(existsSync(d.homes.bad), false);
    assert.deepEqual(d.hookRuns(), ["bad"]);
  });
}

test("a record that becomes unreadable after the retire resolved its home, under its claim: the retire's own read refuses the same way, nothing was done, and `reached` is untouched", async (t) => {
  const d = await deployment(t, ["bad"]);
  const { fx } = d;
  let broken, before;
  const error = await fx.inEnv(() => {
    try {
      retireInstance(fx.root, "bad", { [RETIRE_UNDER_CLAIM]: () => { broken = breakRecord(d.homes.bad, SHAPES[0]); before = listing(d.homes.bad); return {}; } });
    } catch (e) { return e; }
    return null;
  });
  assert.ok(error, "the retire is refused");
  assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME");
  assert.equal(error.message, refused(broken.record, broken.reason));
  assert.deepEqual(error.details, { reached: { phase: "before-effects", sessionStopAttempted: false, hooksStarted: false, home: "kept", recovery: null } });
  assert.deepEqual(listing(d.homes.bad), before, "the home is as the retire found it");
  assert.equal(existsSync(d.claim("bad")), false, "the claim is released");
  assert.deepEqual(d.hookRuns(), []);
  assert.deepEqual(d.recoveries(), []);
});

/** The CLI with a preload that lets the listing read `record` once more as it is, and cuts the file
 *  off right after that read: the record becomes unreadable between the listing and the verb's own
 *  read of it. Every other call is the original. → the CLI run, as fx.cli runs it. */
function cliWithRecordCutAfterListing(fx, record, args) {
  const preload = join(fx.base, "record-cut-after-listing.mjs");
  writeFileSync(preload, `// Written by test/unreadable-record.test.mjs.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const readFileSync = fs.readFileSync;
let cut = false;
fs.readFileSync = function (path, ...rest) {
  const bytes = readFileSync.call(this, path, ...rest);
  if (!cut && String(path) === ${JSON.stringify(record)} && new Error().stack.includes("listInstances")) { cut = true; fs.writeFileSync(path, "{"); }
  return bytes;
};
syncBuiltinESMExports();
`);
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, CLI, ...args], { cwd: fx.dep, env: fx.env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
for (const { id, argv } of [
  { id: "instance stop --plan", argv: ["instance", "stop", "bad", "--plan", "--json"] },
  { id: "retire --plan", argv: ["retire", "bad", "--plan", "--json"] },
]) {
  test(`${id} of a home whose record becomes unreadable between the listing and the plan's own read of it: refused with E_UNIDENTIFIED_INSTANCE_HOME, never a plan with empty facts`, async (t) => {
    const d = await deployment(t, ["bad", "good"]);
    const record = join(d.homes.bad, "instance.json");
    const original = readFileSync(record, "utf8");
    const error = refusal(cliWithRecordCutAfterListing(d.fx, record, argv), id);
    assert.equal(readFileSync(record, "utf8"), "{", "fixture premise: the listing read the record, and it was cut off after that read");
    assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME", JSON.stringify(error));
    assert.equal(error.message, refused(record, parserSays("{")));
    assert.deepEqual(d.recoveries(), []);
    assert.deepEqual(d.hookRuns(), []);
    // The control: with the record as it was, the same command answers a plan.
    writeFileSync(record, original);
    const plan = answered(d.fx.cli(argv), `${id} of the intact home`).json();
    assert.equal(plan.result.instance, "bad");
    assert.equal(plan.ok, true);
  });
}

test("a spawn whose parent's record cannot be read is refused and spawns nothing: the parent's child-spawn policy is in that record", async (t) => {
  const d = await deployment(t, ["bad"]);
  const { record, reason } = breakRecord(d.homes.bad, SHAPES[2]);
  const before = listing(d.homes.bad);
  const error = refusal(d.fx.cli(["spawn", "dev", "--name", "kid", "--parent", "bad", "--no-launch", "--json"]), "spawn of a child");
  // The kernel's own code, as a stop or a retire of that home answers it (E_SPAWN_FAILED before #1047).
  assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME", JSON.stringify(error));
  assert.equal(error.message, refused(record, reason, "nothing was spawned"));
  assert.equal(existsSync(join(d.instances, "kid")), false);
  assert.deepEqual(listing(d.homes.bad), before);
});

// ---- 4. a home with NO record (the stub of awebai/oats#866): as before ----

test("a home with no record beside another instance: its row, the refusal of its retire and what --force does are as before, and the other instance acts on its own", async (t) => {
  const d = await deployment(t, ["good"]);
  const { fx } = d;
  const stub = join(d.instances, "stub");
  mkdirSync(stub);
  writeFileSync(join(stub, "note.md"), "left behind\n");

  assert.deepEqual(d.rows().stub, { instance: "stub", home: stub, startedAt: null, identityAddress: null, modelFrom: null, attributedHuman: null, running: false, waitingOnYou: null, color: null });
  assert.deepEqual(readHomeRecord(stub), { state: "absent", path: join(stub, "instance.json") });

  const plan = answered(fx.cli(["instance", "stop", "good", "--plan", "--json"]), "stop --plan of the other instance").json();
  assert.deepEqual(plan.result.targets.map((target) => target.instance), ["good"]);
  // The stub's own plans are answered, as before: nothing of it is established.
  const own = answered(fx.cli(["instance", "stop", "stub", "--plan", "--json"]), "stop --plan of the stub").json();
  assert.deepEqual(own.result.targets.map((target) => [target.instance, target.session.established, target.work]), [["stub", false, { observed: false, reason: "no-worktree" }]]);

  const error = refusal(fx.cli(["retire", "stub", "--json"]), "retire of the stub");
  assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME");
  assert.equal(error.message, `${stub} has no instance.json and no cleanup descriptor, so OATS cannot tell whether external state (identities, worktrees) still depends on it. Retiring it would delete whatever it holds without running any cleanup. Inspect it, then re-run with \`--force\` to remove it anyway.`);
  assert.ok(existsSync(join(stub, "note.md")));

  answered(fx.cli(["retire", "stub", "--force", "--json"]), "retire --force of the stub");
  assert.equal(existsSync(stub), false, "--force removes a home that has no record");
  answered(fx.cli(["retire", "good", "--json"]), "retire of the other instance");
  assert.equal(existsSync(d.homes.good), false);
});

// ---- 5. a home this process cannot look into ----

test("a home at mode 000: retire plan refuses like apply, stop still reports unknown work, and neither claims no worktree", async (t) => {
  if (ROOT) { t.skip(SKIP_FOR_ROOT); return; }
  const d = await deployment(t, ["closed", "good"]);
  const { fx } = d;
  chmodSync(d.homes.closed, 0);
  t.after(() => { try { chmodSync(d.homes.closed, 0o700); } catch { /* removed */ } });

  assert.deepEqual(readHomeRecord(d.homes.closed), { state: "absent", path: join(d.homes.closed, "instance.json") });
  const rows = d.rows();
  assert.deepEqual(rows.closed, { instance: "closed", home: d.homes.closed, startedAt: null, identityAddress: null, modelFrom: null, attributedHuman: null, running: false, waitingOnYou: null, color: null });
  assert.equal(rows.good.agent, "dev");

  const stop = answered(fx.cli(["instance", "stop", "closed", "--plan", "--json"]), "stop --plan of the closed home").json();
  assert.deepEqual(stop.result.targets[0].work, { observed: false, reason: "E_WORK_INSPECTION_FAILED" });
  assert.equal(stop.result.targets[0].midTask, "unknown");
  assert.equal(lstatSync(d.homes.closed).mode & 0o777, 0, "fixture premise: the home cannot be entered");
  for (const flags of [["--plan"], []]) {
    const r = fx.cli(["retire", "closed", "--json", ...flags]);
    const error = refusal(r, "retire refuses the closed home before any plan or effect");
    assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME");
    assert.match(error.message, /has no instance.json and no cleanup descriptor/);
    assert.match(error.message, /Inspect it, then re-run with `--force`/);
    assert.doesNotMatch(r.stdout, /no-worktree|has no worktree|no work tree/);
    assert.equal(Object.hasOwn(r.json(), "result"), false, "refusal returns no plan claiming work is absent");
    assert.equal(lstatSync(d.homes.closed).mode & 0o777, 0, "the home and its permissions are unchanged");
  }

  const other = answered(fx.cli(["instance", "stop", "good", "--plan", "--json"]), "stop --plan of the other instance").json();
  assert.deepEqual(other.result.targets.map((target) => target.instance), ["good"]);
});

// ---- 6. the reader ----

test("readHomeRecord is total: a record, an absent one, or an unreadable one with the reason, and it never waits on a pipe", async (t) => {
  const d = await deployment(t, ["one"]);
  const home = d.homes.one, path = join(home, "instance.json");
  const original = readFileSync(path, "utf8");
  assert.deepEqual(readHomeRecord(home), { state: "record", path, meta: JSON.parse(original) });
  for (const shape of SHAPES) {
    if (shape.root && ROOT) continue;
    const { reason, restore } = breakRecord(home, shape);
    assert.deepEqual(readHomeRecord(home), { state: "unreadable", path, reason }, shape.id);
    restore();
  }
  for (const [text, holds] of [["7", "a number"], ["true", "a boolean"]]) {
    writeFileSync(path, text);
    assert.deepEqual(readHomeRecord(home), { state: "unreadable", path, reason: `it holds ${holds}, not a JSON object` });
  }
  rmSync(path);
  assert.deepEqual(readHomeRecord(home), { state: "absent", path });
  assert.deepEqual(readHomeRecord(join(d.instances, "no-such-home")), { state: "absent", path: join(d.instances, "no-such-home", "instance.json") });
  // A pipe is never opened: a read of one would not return.
  let fifo = true;
  try { execFileSync("mkfifo", [path], { stdio: "ignore", timeout: 5000 }); } catch { fifo = false; }
  if (fifo) assert.deepEqual(readHomeRecord(home), { state: "unreadable", path, reason: "it is not a regular file" });
});
