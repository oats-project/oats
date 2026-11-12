// Feature instance-background (awebai/oats#1579): an instance listed under the clients' Background
// section, presentation only, in a home file of its own (`.oats-background.json`, lib/instance-background.mjs).
// It is set at spawn from the soul's `background:` or a spawn flag, changed by `oats instance background`,
// and read on status rows, `inspect --home`, the souls answer and the remote roster.
//
// What is pinned here:
// - the record: `{ backgroundApi: 1, at }` (#1579 item 3), its mode, written only on a change; the reader
//   takes a regular file of at most 4 KiB that is a valid record, and anything else is false, never an error;
// - the file is kernel-owned: a capability cannot declare it, and it is no change to the home's stored digest;
// - spawn: the flag, else the soul, else false; `backgroundFrom`; both flags refused; the decision binds it
//   only when true; the apply writes the file only when true; a non-boolean soul key is the schema's refusal;
// - the CLI: the answer, `changed`, on/off twice, the refusals, resolution as `instance color` answers it;
//   status rows (JSON and text), inspect --home and the souls answer carry it;
// - a routed spawn sends either flag only to a host that advertises the feature.
// The record surviving restart, stop/start and `instance upgrade` is pinned beside those paths
// (test/session-restart.test.mjs, test/instance-upgrade.test.mjs); the remote roster's relay in
// test/remote-parity.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { BACKGROUND_FILE, RECORD_MAX, readInstanceBackground, writeInstanceBackground } from "../lib/instance-background.mjs";
import { disposableHomeRootProblem } from "../lib/capability-contract.mjs";
import { KERNEL_HOME_RECEIPTS, lifecycleClaimRefusals, retireClaimPath, retirePendingMarkerPath, storedTreeDigest } from "../lib/core.mjs";
import { REMOTE_SNAPSHOT_DIR, routeCommand } from "../lib/servers.mjs";

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
  const base = fixtureBase("oats-instance-background-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "home");
  mkdirSync(dir);
  return dir;
}
// dev declares nothing, bg `background: true`, fg `background: false`.
const SOULS = { dev: {}, bg: { soul: { background: true } }, fg: { soul: { background: false } } };
/** status --json answers its document bare, not in an envelope: the row of `name`. */
function statusRow(fx, name) {
  const r = fx.cli(["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).agents.flatMap((a) => a.instances).find((i) => i.instance === name);
}

test("writeInstanceBackground: the record and its mode; on again writes nothing; off removes it", (t) => {
  const h = home(t);
  const at = new Date("2026-10-27T15:00:00.000Z");
  assert.deepEqual(writeInstanceBackground(h, true, { now: () => at }), { background: true, changed: true });
  const file = join(h, BACKGROUND_FILE);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { backgroundApi: 1, at: "2026-10-27T15:00:00.000Z" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = statSync(file).mtimeMs;
  assert.deepEqual(writeInstanceBackground(h, true, { now: () => new Date("2027-01-01T00:00:00.000Z") }), { background: true, changed: false });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).at, "2026-10-27T15:00:00.000Z", "nothing was written");
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(readInstanceBackground(h), true);
  assert.deepEqual(writeInstanceBackground(h, false), { background: false, changed: true });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.deepEqual(writeInstanceBackground(h, false), { background: false, changed: false }, "off with no file is no change");
  // A file that is not a record reads as not background: off removes it, and that is no change.
  writeFileSync(file, "not json");
  assert.deepEqual(writeInstanceBackground(h, false), { background: false, changed: false });
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  // A link at the name reads false; on replaces it with a record, never writing through it.
  const target = join(dirname(h), "linked.json");
  writeFileSync(target, "outside\n");
  symlinkSync(target, file);
  assert.deepEqual(writeInstanceBackground(h, false), { background: false, changed: false }, "off removes a link");
  assert.throws(() => lstatSync(file), { code: "ENOENT" });
  assert.equal(readFileSync(target, "utf8"), "outside\n", "and leaves what it pointed at");
});

test("readInstanceBackground: a valid record only; anything else is false, never an error", (t) => {
  const h = home(t);
  const file = join(h, BACKGROUND_FILE);
  assert.equal(readInstanceBackground(h), false, "no file");
  const put = (v) => { rmSync(file, { recursive: true, force: true }); writeFileSync(file, typeof v === "string" ? v : JSON.stringify(v)); };
  put({ backgroundApi: 1, at: "x" });
  assert.equal(readInstanceBackground(h), true);
  put({ backgroundApi: 1 });
  assert.equal(readInstanceBackground(h), true, "present means background: `at` is informative");
  for (const bad of ["", "{", "null", "[]", "true", "\"on\"", { backgroundApi: 2, at: "x" }, { backgroundApi: "1" }, { background: true }, {}]) {
    put(bad);
    assert.equal(readInstanceBackground(h), false, JSON.stringify(bad));
  }
  // Past 4 KiB: not a record, however it parses.
  put(JSON.stringify({ backgroundApi: 1, pad: "x".repeat(RECORD_MAX) }));
  assert.equal(readInstanceBackground(h), false, "over RECORD_MAX");
  put(JSON.stringify({ backgroundApi: 1, pad: "x".repeat(RECORD_MAX - 60) }));
  assert.equal(readInstanceBackground(h), true, "within RECORD_MAX");
  // A link is never followed, a directory is not a file, an unreadable file is none.
  rmSync(file);
  const target = join(dirname(h), "elsewhere.json");
  writeFileSync(target, JSON.stringify({ backgroundApi: 1 }));
  symlinkSync(target, file);
  assert.equal(readInstanceBackground(h), false, "a symlink");
  rmSync(file);
  mkdirSync(file);
  assert.equal(readInstanceBackground(h), false, "a directory");
  rmSync(file, { recursive: true });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    put({ backgroundApi: 1 });
    chmodSync(file, 0o000);
    assert.equal(readInstanceBackground(h), false, "unreadable");
    chmodSync(file, 0o600);
  }
});

test("the background file is kernel-owned: a capability cannot declare it, and it is no change to the home's stored digest", (t) => {
  assert.ok(KERNEL_HOME_RECEIPTS.has(BACKGROUND_FILE));
  for (const root of [BACKGROUND_FILE, ".oats-background", ".oats-background.json.tmp-1"]) assert.equal(disposableHomeRootProblem(root), "kernel-owned", root);
  const schema = JSON.parse(readFileSync(new URL("../docs/capability-manifest.schema.json", import.meta.url), "utf8"));
  // The schema's kernel-owned prefix pattern (one of `retirement.disposable.home`'s `not` patterns) matches it.
  const patterns = []; JSON.stringify(schema, (k, v) => { if (k === "pattern" && typeof v === "string") patterns.push(v); return v; });
  assert.ok(patterns.some((p) => p.startsWith("^\\.oats-(?:") && new RegExp(p).test(BACKGROUND_FILE)), "the manifest schema refuses it too");
  const h = home(t);
  writeFileSync(join(h, "AGENTS.md"), "# x\n");
  const digest = () => storedTreeDigest(h, 2, { instanceHome: true });
  const before = digest();
  writeInstanceBackground(h, true);
  assert.equal(digest(), before, "recording background does not change the home");
  writeInstanceBackground(h, false);
  assert.equal(digest(), before);
});

test("spawn: the flag, else the soul's background:, else false; the preview names the source; both flags are refused", (t) => {
  const fx = v2Deployment({ t, souls: SOULS });
  const preview = (argv) => okResult(fx.cli(["spawn", ...argv, "--preview", "--json"]), argv.join(" "));
  const cases = [
    [["dev"], false, undefined],
    [["dev", "--background"], true, "flag"],
    [["dev", "--no-background"], false, "flag"],
    [["bg"], true, "soul"],
    [["bg", "--no-background"], false, "flag"],
    [["fg"], false, "soul"],
    [["fg", "--background"], true, "flag"],
  ];
  for (const [argv, background, from] of cases) {
    const p = preview([...argv, "--purpose", "p"]);
    assert.equal(p.background, background, `${argv.join(" ")}: background`);
    assert.equal(p.backgroundFrom, from, `${argv.join(" ")}: backgroundFrom`);
    assert.equal(Object.hasOwn(p, "backgroundFrom"), from !== undefined, `${argv.join(" ")}: backgroundFrom present only when declared`);
    // The decision binds it only when true: a decision without it keeps the revision it had.
    assert.equal(p.decision.effective.background, background ? true : undefined, `${argv.join(" ")}: decision`);
  }
  assert.equal(preview(["dev", "--purpose", "p"]).decision.revision, preview(["dev", "--purpose", "p", "--no-background"]).decision.revision, "false binds nothing");
  assert.notEqual(preview(["dev", "--purpose", "p"]).decision.revision, preview(["dev", "--purpose", "p", "--background"]).decision.revision, "true is bound");
  // Text: the preview says where the instance is listed.
  const text = fx.cli(["spawn", "bg", "--purpose", "p", "--preview"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^list: background \(from the soul\)$/m);
  assert.doesNotMatch(fx.cli(["spawn", "dev", "--purpose", "p", "--preview"]).stdout, /^list:/m);
  const both = refused(fx.cli(["spawn", "dev", "--purpose", "p", "--background", "--no-background", "--json"]), "both");
  assert.deepEqual(both, { code: "E_BAD_ARGS", message: "choose --background or --no-background, not both" });
  // A flag takes no value.
  assert.equal(refused(fx.cli(["spawn", "dev", "--purpose", "p", "--background=yes", "--json"]), "valued").code, "E_BAD_ARGS");
});

test("spawn apply: writes the record only when background; the result, the row and the text say so; a changed value is a stale decision", (t) => {
  const fx = v2Deployment({ t, souls: SOULS });
  const bg = okResult(fx.cli(["spawn", "bg", "--purpose", "a", "--no-launch", "--json"]), "bg");
  assert.equal(bg.background, true); assert.equal(bg.backgroundFrom, "soul");
  const record = JSON.parse(readFileSync(join(bg.home, BACKGROUND_FILE), "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["at", "backgroundApi"]);
  assert.equal(record.backgroundApi, 1);
  assert.equal(statSync(join(bg.home, BACKGROUND_FILE)).mode & 0o777, 0o600);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(bg.home, "instance.json"), "utf8")), "background"), false, "instance.json keeps its shape");
  assert.equal(statusRow(fx, bg.instance).background, true);
  const flagged = okResult(fx.cli(["spawn", "dev", "--purpose", "f", "--background", "--no-launch", "--json"]), "flagged");
  assert.equal(flagged.background, true); assert.equal(flagged.backgroundFrom, "flag");
  assert.equal(readInstanceBackground(flagged.home), true);
  for (const [argv, what] of [[["dev", "--purpose", "d"], "dev"], [["bg", "--purpose", "n", "--no-background"], "bg --no-background"], [["fg", "--purpose", "g"], "fg"]]) {
    const r = okResult(fx.cli(["spawn", ...argv, "--no-launch", "--json"]), what);
    assert.equal(r.background, false, what);
    assert.throws(() => lstatSync(join(r.home, BACKGROUND_FILE)), { code: "ENOENT" }, `${what}: no record`);
    assert.equal(Object.hasOwn(statusRow(fx, r.instance), "background"), false, `${what}: the row has no key`);
  }
  // Text: the status row and the spawn are marked.
  const status = fx.cli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`• ${bg.instance} \\[background\\]  `));
  assert.doesNotMatch(status.stdout, /• dev-d \[background\]/);
  assert.match(fx.cli(["spawn", "bg", "--purpose", "t", "--no-launch"]).stdout, /^ {2}list: {3}background \(from the soul\)$/m);
  // A decision previewed as background is stale for an apply that is not, and nothing is created.
  const rev = okResult(fx.cli(["spawn", "bg", "--name", "bg-s", "--preview", "--json"]), "preview").decision.revision;
  const stale = refused(fx.cli(["spawn", "bg", "--name", "bg-s", "--no-background", "--expect-decision", rev, "--no-launch", "--json"]), "stale");
  assert.equal(stale.code, "E_DECISION_STALE");
  assert.equal(statusRow(fx, "bg-s"), undefined, "nothing was spawned");
  assert.equal(okResult(fx.cli(["spawn", "bg", "--name", "bg-s", "--expect-decision", rev, "--no-launch", "--json"]), "bound").background, true);
});

test("a soul whose background: is not a boolean is refused as any bad soul key is", (t) => {
  const fx = v2Deployment({ t, souls: { odd: { soul: { background: "yes" } }, dev: {} } });
  const souls = okResult(fx.cli(["souls", "--json"]), "souls");
  assert.equal(souls.souls.some((s) => s.name === "odd"), false, "not listed");
  const problem = souls.problems.find((p) => JSON.stringify(p).includes("odd"));
  assert.ok(problem, JSON.stringify(souls.problems));
  assert.match(JSON.stringify(problem), /background/);
  assert.notEqual(fx.cli(["spawn", "odd", "--purpose", "x", "--no-launch", "--json"]).status, 0);
});

test("oats souls: background: true on a soul that declares it, absent otherwise", (t) => {
  const fx = v2Deployment({ t, souls: SOULS });
  const rows = Object.fromEntries(okResult(fx.cli(["souls", "--json"]), "souls").souls.map((s) => [s.name, s]));
  assert.equal(rows.bg.background, true);
  for (const name of ["dev", "fg"]) assert.equal(Object.hasOwn(rows[name], "background"), false, name);
});

test("oats instance background: on, on again, off, off again; rows and inspect --home carry it; the feature", (t) => {
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "c", "--no-launch", "--json"]), "spawn");
  const name = spawned.instance;
  const inspected = () => okResult(fx.cli(["inspect", "--home", spawned.home, "--json"]), "inspect").instance;
  assert.equal(Object.hasOwn(statusRow(fx, name), "background"), false, "not background yet");
  assert.equal(Object.hasOwn(inspected(), "background"), false);

  assert.deepEqual(okResult(fx.cli(["instance", "background", name, "on", "--json"]), "on"), { instanceBackgroundApi: 1, instance: name, home: spawned.home, background: true, changed: true });
  assert.deepEqual(okResult(fx.cli(["instance", "background", name, "on", "--json"]), "again"), { instanceBackgroundApi: 1, instance: name, home: spawned.home, background: true, changed: false });
  assert.equal(statusRow(fx, name).background, true);
  assert.equal(inspected().background, true);
  assert.equal(okResult(fx.cli(["instance", "background", name, "on", "--home", spawned.home, "--json"]), "by --home").changed, false);
  assert.deepEqual(okResult(fx.cli(["instance", "background", name, "off", "--json"]), "off"), { instanceBackgroundApi: 1, instance: name, home: spawned.home, background: false, changed: true });
  assert.deepEqual(okResult(fx.cli(["instance", "background", name, "off", "--json"]), "off again"), { instanceBackgroundApi: 1, instance: name, home: spawned.home, background: false, changed: false });
  assert.equal(Object.hasOwn(statusRow(fx, name), "background"), false);
  assert.equal(Object.hasOwn(inspected(), "background"), false);

  // `background` recorded in instance.json is not the fact: only the home's own record is.
  const metaFile = join(spawned.home, "instance.json");
  writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(readFileSync(metaFile, "utf8")), background: true }, null, 2));
  assert.equal(Object.hasOwn(statusRow(fx, name), "background"), false);
  // An oversized record reads false, and off removes it.
  writeFileSync(join(spawned.home, BACKGROUND_FILE), JSON.stringify({ backgroundApi: 1, pad: "x".repeat(RECORD_MAX) }));
  assert.equal(Object.hasOwn(statusRow(fx, name), "background"), false);
  assert.equal(okResult(fx.cli(["instance", "background", name, "off", "--json"]), "off oversized").changed, false);
  assert.throws(() => lstatSync(join(spawned.home, BACKGROUND_FILE)), { code: "ENOENT" });

  let r = fx.cli(["instance", "background", name, "on"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${name}: background`);
  r = fx.cli(["instance", "background", name, "on"]);
  assert.equal(r.stdout.trim(), `${name}: background (unchanged)`);
  r = fx.cli(["instance", "background", name, "off"]);
  assert.equal(r.stdout.trim(), `${name}: not background`);
  assert.ok(JSON.parse(fx.cli(["version", "--json"]).stdout).features.includes("instance-background"));
});

test("oats instance background refuses a bad value, resolves as instance color does, and refuses a home being retired", (t) => {
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "r", "--no-launch", "--json"]), "spawn");
  const name = spawned.instance;
  for (const [argv, what] of [[[name], "neither"], [[name, "yes"], "not on|off"], [[name, "ON"], "case"]]) {
    const e = refused(fx.cli(["instance", "background", ...argv, "--json"]), what);
    assert.equal(e.code, "E_BAD_ARGS", what);
    assert.match(e.message, /^give on or off; usage: oats instance background <instance> on\|off/, what);
  }
  // Two words: the argument after the state, refused before the command runs (lib/command-flags.mjs).
  const two = refused(fx.cli(["instance", "background", name, "on", "off", "--json"]), "two");
  assert.equal(two.code, "E_BAD_ARGS", "two");
  assert.match(two.message, /^oats instance background: unexpected argument "off" after the state "on": instance background takes one instance and one state\nusage: oats instance background <instance> on\|off/, "two");
  // Resolution: what `oats instance color` answers.
  const colorCode = (argv) => refused(fx.cli(["instance", "color", ...argv, "sage", "--json"]), `color ${argv}`).code;
  const backgroundCode = (argv) => refused(fx.cli(["instance", "background", ...argv, "on", "--json"]), `background ${argv}`).code;
  for (const argv of [["nobody"], [name, "--home", join(dirname(spawned.home), "elsewhere")], [name, "--home", "relative/home"]]) {
    assert.equal(backgroundCode(argv), colorCode(argv), JSON.stringify(argv));
  }
  assert.equal(backgroundCode(["nobody"]), "E_SESSION_UNKNOWN");
  // A retire in flight: its pending marker beside the home.
  const marker = retirePendingMarkerPath(spawned.home);
  writeFileSync(marker, JSON.stringify({ reason: "retire pending" }));
  const retiring = refused(fx.cli(["instance", "background", name, "on", "--json"]), "retiring");
  assert.equal(retiring.code, "E_INSTANCE_RETIRING");
  assert.match(retiring.message, /is being retired; the background was not changed$/);
  assert.equal(readInstanceBackground(spawned.home), false, "nothing was written");
  rmSync(marker);
  assert.equal(okResult(fx.cli(["instance", "background", name, "on", "--json"]), "after").background, true);
});

test("beside a held lifecycle claim, oats instance background says the background was not changed, as instance color says its colour was not (the docs' words)", (t) => {
  // The builders, beside a live retire: each verb in its own words, and never another verb's.
  const holder = { action: "retire", pid: 4242, processStart: "proc:start", nonce: "a".repeat(32), at: "2026-10-27T10:00:00.000Z" };
  for (const [arriving, words] of [["instance background", "the background was not changed"], ["instance color", "the colour was not changed"]]) {
    const refusals = lifecycleClaimRefusals(arriving, "w1", "/h/w1", "/h/w1/.lock");
    for (const e of [refusals.busy(holder, null, "/h/w1/.lock"), refusals.unreadableClaim("/h/w1/.lock")]) {
      assert.match(e.message, new RegExp(`; ${words} — `), `${arriving}: ${e.message}`);
      assert.doesNotMatch(e.message, /nothing was done/, arriving);
    }
  }
  // The command itself: a file at the home's claim path that reads as no claim refuses before any write.
  const fx = v2Deployment({ t });
  const spawned = okResult(fx.cli(["spawn", "dev", "--purpose", "r", "--no-launch", "--json"]), "spawn");
  const lock = retireClaimPath(spawned.home);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, "not a claim");
  const e = refused(fx.cli(["instance", "background", spawned.instance, "on", "--json"]), "beside a claim");
  assert.equal(e.code, "E_LIFECYCLE_BUSY");
  assert.match(e.message, /is not a readable claim; the background was not changed — /);
  assert.equal(readInstanceBackground(spawned.home), false, "nothing was written");
  rmSync(lock);
  assert.equal(okResult(fx.cli(["instance", "background", spawned.instance, "on", "--json"]), "after").background, true);
});

test("routed spawn --background / --no-background need a host that advertises instance-background: refused before the spawn is sent, else the flag travels", () => {
  const base = fixtureBase("oats-rbg-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    // Test output is pristine (awebai/oats#910): under a long temporary path the route warns that ssh
    // runs without connection reuse; the warning is captured here and asserted below, never printed.
    const warnings = [];
    const warn = (m) => warnings.push(m);
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.69.15", desktopApi: 1, harnesses: ["pi", "claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features: ["spawn-task-stdin", "spawn-preview-2", "spawn-apply-2", "spawn-idempotency-2", ...features] });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "claude", instances: [] }] } };
    const remote = (features) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        sent.push(word);
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: `dev-${sent.length}`, agent: "dev", home: `/w/agents/dev/instances/dev-${sent.length}`, launched: false, background: true, backgroundFrom: "flag", warnings: [], ...(word.includes(" --preview ") ? { spawnPreviewApi: 2, preview: true, decision: { revision: "r1" } } : {}) } });
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { exec, spawned: () => sent.filter((w) => w.includes(" spawn ")) };
    };
    for (const flag of ["--background", "--no-background"]) {
      const old = remote(["spawn-preview-2", "spawn-name"]);
      assert.throws(() => routeCommand("build", "spawn", ["dev", "--purpose", "x", flag], { server, execFileSync: old.exec, warn }),
        (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message === "remote oats 0.69.15 at h does not advertise instance-background; upgrade it there; nothing was sent", flag);
      assert.deepEqual(old.spawned(), [], `${flag}: nothing sent`);
      const current = remote(["instance-background"]);
      const routed = routeCommand("build", "spawn", ["dev", "--purpose", "x", flag], { server, execFileSync: current.exec, warn });
      assert.match(current.spawned().at(-1), new RegExp(` spawn dev --purpose x ${flag} --expect-decision r1 --idempotency-key \S+ --dir /w --json$`));
      assert.equal(routed.envelope.result.background, true, "the host's answer is relayed");
      rmSync(REMOTE_SNAPSHOT_DIR(), { recursive: true, force: true });
    }
    // Neither flag: an older host is asked nothing new.
    const plain = remote([]);
    routeCommand("build", "spawn", ["dev", "--purpose", "y"], { server, execFileSync: plain.exec, warn });
    assert.equal(plain.spawned().length, 2);
    for (const m of warnings) assert.match(m, /^ssh to build runs without connection reuse: /, "the only warning a route may give here");
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});
