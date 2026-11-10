// Every kernel command that rewrites the deployment's oats-local.yaml goes through editLocal
// (lib/local-edit.mjs; awebai/oats#998): `oats launch-config set|remove` and `oats schedule|trigger
// enable|disable` as `oats teams` and `oats soul launch` already did. One lock, the file read inside
// it, the edit redone when the file changed: no two of them drop each other's change.
//
// Three layers: editLocal's edit that returns the text to write, in process; the opt-out writer
// (lib/automations.mjs setDisabledHere), in process over a file; the real CLI over the one-repo
// deployment. "Each has started before the other writes" is made with test/helpers/fs-gate-preload.mjs:
// a CLI child is held at one named call of its own, the other command runs, and the first goes on.
// No sleep synchronises anything.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { startGated } from "./helpers/fs-gate-preload.mjs";
import { parseConfigData } from "../lib/config-data.mjs";
import { editLocal, localLock } from "../lib/local-edit.mjs";
import { selfIdentity } from "../lib/worktree-hooks.mjs";
import { setDisabledHere } from "../lib/automations.mjs";
import { teamsAdd } from "../lib/teams-verbs.mjs";

const LOCAL = "oats-local.yaml";
const HEAD = "schemaVersion: 2\nworkspace: git:github.com/acme/agents\n";
/** A deployment that is one file: what the in-process writers need. */
function fileOf(t, text, head = HEAD) {
  const dir = mkdtempSync(join(tmpdir(), "oats-local-writers-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localPath = join(dir, LOCAL);
  writeFileSync(localPath, head + text);
  return { dir, localPath, ctx: { deployment: dir, localPath }, text: () => readFileSync(localPath, "utf8"),
    // The kernel reader's value (as plain objects: it builds them without a prototype).
    value: () => JSON.parse(JSON.stringify(parseConfigData(readFileSync(localPath, "utf8"), { origin: { kind: "local", path: localPath } }).value)) };
}
/** A lock another process holds: the record of a holder that runs (this process), as lib/dir-lock.mjs
 *  writes it. → the lock's path, and the bytes at it. */
function holdLock(deployment) {
  const lock = localLock(deployment);
  mkdirSync(dirname(lock), { recursive: true });
  const record = `${JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "a test" })}\n`;
  writeFileSync(lock, record);
  return { lock, record };
}

/* ───────────────────────────── editLocal: an edit that returns its text ── */

test("an edit that returns { text } has that text written as it is: no rendering, the same loop around it", (t) => {
  const fx = fileOf(t, "clones: {github.com/acme/x:   /srv/x}   # as its author spaced it\n");
  // The document's rendering would re-space the flow mapping and its comment; the caller's text is written byte for byte.
  const next = `${fx.text()}defaultTeam: mine\nteams:\n  mine: {team: "mine:me.example"}\n`;
  const seen = [];
  const r = editLocal(fx.ctx, { verb: "a test" }, ({ text, doc, local }) => { seen.push([text, typeof doc.getIn, local.defaultTeam]); return { text: next }; });
  assert.deepEqual(seen, [[`${HEAD}clones: {github.com/acme/x:   /srv/x}   # as its author spaced it\n`, "function", undefined]], "the edit gets the text, the document and the value, as read under the lock");
  assert.equal(fx.text(), next);
  assert.deepEqual([r.changed, r.local.defaultTeam, r.local.teams.mine.team], [true, "mine", "mine:me.example"], "the answer's value is the kernel reader's of the new text");
  assert.equal(existsSync(localLock(fx.dir)), false, "the lock is released");

  // The same text: nothing is written (the file is not even replaced), and that is not a change.
  const ino = statSync(fx.localPath).ino;
  assert.deepEqual(editLocal(fx.ctx, { verb: "a test" }, ({ text }) => ({ text })).changed, false);
  assert.equal(statSync(fx.localPath).ino, ino);
  // Its check still judges the value first, and a plan writes nothing either way.
  assert.throws(() => editLocal(fx.ctx, { verb: "a test" }, ({ text }) => ({ text, check: () => { throw Object.assign(new Error("refused by the check"), { code: "E_TEST" }); } })), { code: "E_TEST" });
  const planned = editLocal(fx.ctx, { verb: "a test", plan: true }, ({ text }) => ({ text: `${text}host: { name: planned }\n` }));
  assert.deepEqual([planned.changed, planned.local.host.name, fx.text()], [true, "planned", next]);
});

test("a returned text is held to what a rendered one is: the kernel's reader, the local schema, the caller's check, compare-and-swap", (t) => {
  const fx = fileOf(t, "");
  const before = fx.text();
  const refused = (edit, test) => { assert.throws(() => editLocal(fx.ctx, { verb: "a test" }, edit), test); assert.equal(fx.text(), before, "nothing was written"); };
  // Text the kernel reader does not decode, and a value the local schema refuses: never written.
  refused(({ text }) => ({ text: `${text}souls: [unclosed\n` }), (e) => e.code === "E_WORKSPACE_SCHEMA" && /would not decode|would be invalid/.test(e.message) && /nothing was written/.test(e.message));
  refused(({ text }) => ({ text: `${text}bogus: 1\n` }), (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details.problems.some((p) => p.path === "/bogus"));
  // The caller's check gets the reader's value of the text it returned.
  refused(({ text }) => ({ text: `${text}defaultTeam: mine\n`, check: (next) => { throw Object.assign(new Error(`refused ${next.defaultTeam}`), { code: "E_TEST" }); } }), /refused mine/);
  // Another writer (one that takes no lock) lands between the read and the rename: the edit is made again, on its text.
  let calls = 0;
  const once = editLocal(fx.ctx, { verb: "a test" }, ({ text }) => {
    if (++calls === 1) writeFileSync(fx.localPath, `${text}defaultTeam: theirs\n`);
    return { text: `${text}host: { name: mine }\n` };
  });
  assert.deepEqual([calls, once.changed, fx.text()], [2, true, `${HEAD}defaultTeam: theirs\nhost: { name: mine }\n`], "their change is kept, and this edit was made on it");
  // One that lands on every attempt: refused, and the file is theirs, never a mix.
  let n = 0;
  assert.throws(() => editLocal(fx.ctx, { verb: "a test" }, () => { writeFileSync(fx.localPath, `${HEAD}defaultTeam: theirs-${++n}\n`); return { text: `${HEAD}defaultTeam: mine\n` }; }),
    (e) => e.code === "E_LOCAL_CHANGED" && e.details.path === fx.localPath && /nothing was written/.test(e.message));
  assert.deepEqual([n, fx.text()], [5, `${HEAD}defaultTeam: theirs-5\n`]);
  assert.equal(existsSync(localLock(fx.dir)), false, "the lock is released");
});

test("the file that replaces oats-local.yaml has its permission bits, from before its first byte: a private file stays private", { skip: process.platform === "win32" }, (t) => {
  const WORKSPACE = { schemaVersion: 2, name: "acme", teams: {}, localTeams: true };
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const mode = (path) => statSync(path).mode & 0o7777;
  // Whatever the umask would give a new file: kept private, kept group-writable, kept as it was.
  for (const bits of [0o600, 0o664, 0o640, 0o644]) {
    const fx = fileOf(t, "host:\n  name: kb-host\n");
    chmodSync(fx.localPath, bits);
    // Each kind of writer: an edit of the document, an edit that returns its text, and the two verbs' own.
    editLocal(fx.ctx, { verb: "a test" }, ({ doc }) => { doc.set("defaultTeam", "mine"); doc.set("teams", doc.createNode({ mine: { team: "mine:me.example" } })); return {}; });
    assert.equal(mode(fx.localPath), bits, `a rendered edit keeps ${bits.toString(8)}`);
    editLocal(fx.ctx, { verb: "a test" }, ({ text }) => ({ text: `${text}clones: {}\n` }));
    assert.equal(mode(fx.localPath), bits, `a returned text keeps ${bits.toString(8)}`);
    setDisabledHere(fx.ctx, "schedule", "ws/nightly", true);
    assert.equal(mode(fx.localPath), bits, `setDisabledHere keeps ${bits.toString(8)}`);
    teamsAdd({ ...fx.ctx, local: fx.value(), workspace: WORKSPACE, workspaceKey: "github.com/acme/agents" }, "other", { team: "other:me.example" });
    assert.equal(mode(fx.localPath), bits, `oats teams keeps ${bits.toString(8)}`);
    assert.deepEqual([fx.value().schedules.disabled, Object.keys(fx.value().teams)], [["ws/nightly"], ["mine", "other"]]);
  }
  // The temporary file gets its text only once it has those bits: at the write into it, it is empty and
  // already as private (or as open) as the file it replaces, whatever the umask made of it at its creation.
  const atWrite = (bits, mask) => {
    const fx = fileOf(t, "host:\n  name: kb-host\n");
    chmodSync(fx.localPath, bits);
    const original = fs.writeFileSync, seen = [], before = process.umask(mask);
    fs.writeFileSync = function (target, ...rest) {
      if (typeof target === "number") { const s = fs.fstatSync(target); seen.push([s.mode & 0o7777, s.size]); }
      return original.call(this, target, ...rest);
    };
    syncBuiltinESMExports();
    try { setDisabledHere(fx.ctx, "schedule", "ws/nightly", true); }
    finally { fs.writeFileSync = original; syncBuiltinESMExports(); process.umask(before); }
    return [seen, mode(fx.localPath)];
  };
  assert.deepEqual(atWrite(0o600, 0o022), [[[0o600, 0]], 0o600]);
  assert.deepEqual(atWrite(0o664, 0o077), [[[0o664, 0]], 0o664], "set exactly, not only narrowed by the umask");
  // A file left under the temporary name by a killed process (here: wide open, and a link) is not written into.
  const fx = fileOf(t, "host:\n  name: kb-host\n");
  chmodSync(fx.localPath, 0o600);
  const tmp = join(fx.dir, `.${LOCAL}.oats-tmp-${process.pid}`), elsewhere = join(fx.dir, "elsewhere");
  writeFileSync(elsewhere, "not ours\n"); chmodSync(elsewhere, 0o666);
  symlinkSync(elsewhere, tmp);
  setDisabledHere(fx.ctx, "trigger", "ws/kb-review", true);
  assert.deepEqual([mode(fx.localPath), fx.value().triggers, readFileSync(elsewhere, "utf8"), existsSync(tmp)], [0o600, { disabled: ["ws/kb-review"] }, "not ours\n", false]);
});

test("an oats-local.yaml that is a link is replaced by a file with the target's permission bits; the target is left as it was", { skip: process.platform === "win32" }, (t) => {
  const WORKSPACE = { schemaVersion: 2, name: "acme", teams: {}, localTeams: true };
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  // Each writer on a link of its own: the opt-out, an edit that returns its text, and `oats teams`.
  const writers = {
    "setDisabledHere": (fx) => setDisabledHere(fx.ctx, "schedule", "ws/nightly", true),
    "a returned text": (fx) => editLocal(fx.ctx, { verb: "a test" }, ({ text }) => ({ text: `${text}schedules:\n  disabled:\n    - ws/nightly\n` })),
    "oats teams": (fx) => teamsAdd({ ...fx.ctx, local: fx.value(), workspace: WORKSPACE, workspaceKey: "github.com/acme/agents" }, "mine", { team: "mine:me.example" }),
  };
  for (const [what, write] of Object.entries(writers)) {
    const fx = fileOf(t, "host:\n  name: kb-host\n");
    // The file lives in another directory, private; the deployment holds a link to it.
    const elsewhere = mkdtempSync(join(tmpdir(), "oats-local-writers-target-")); t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    const target = join(elsewhere, "local.yaml"), original = fx.text();
    writeFileSync(target, original); chmodSync(target, 0o600);
    rmSync(fx.localPath); symlinkSync(target, fx.localPath);
    write(fx);
    assert.equal(lstatSync(fx.localPath).isSymbolicLink(), false, `${what}: the link is replaced by a file`);
    assert.equal(lstatSync(fx.localPath).mode & 0o7777, 0o600, `${what}: with the target's permission bits, not the umask's`);
    assert.notEqual(fx.text(), original, `${what}: which holds the edit`);
    assert.deepEqual([readFileSync(target, "utf8"), statSync(target).mode & 0o7777], [original, 0o600], `${what}: the target is as it was`);
    assert.deepEqual(readdirSync(elsewhere), ["local.yaml"], `${what}: nothing is written beside the target`);
  }
});

/* ───────────────────────────── the opt-out writer, over a file ────────── */

test("setDisabledHere edits the list and nothing else, by a rename: a long line is not folded, comments stay, an emptied list goes", (t) => {
  const long = `    PROMPT: ${"a value well past eighty columns ".repeat(4)}that a folding writer would wrap onto a second line`;
  const fx = fileOf(t, `# the host\nhost:\n  name: kb-host # as the workspace names it\nsettings:\n  acme.tool:\n${long}\n`);
  const original = fx.text();
  assert.ok(long.length > 160);
  // A second name for the file as it is before the write: a write in place would change what it reads.
  const kept = join(fx.dir, "before");
  linkSync(fx.localPath, kept);
  assert.deepEqual(setDisabledHere(fx.ctx, "schedule", "ws/nightly", true), { changed: true, disabled: ["ws/nightly"] });
  assert.equal(fx.text(), `${original}schedules:\n  disabled:\n    - ws/nightly\n`, "every line that was there is there byte for byte, the long one unfolded");
  assert.equal(readFileSync(kept, "utf8"), original, "the old file was replaced, never written into: no reader sees half a file");
  assert.notEqual(statSync(fx.localPath).ino, statSync(kept).ino);
  assert.deepEqual(readdirSync(fx.dir).sort(), [".agents", "before", LOCAL], "no temporary file is left");
  assert.equal(existsSync(localLock(fx.dir)), false, "the lock is released");
  // Each kind has its own list; a list is kept sorted and without a repeat.
  assert.deepEqual(setDisabledHere(fx.ctx, "trigger", "ws/kb-review", true), { changed: true, disabled: ["ws/kb-review"] });
  assert.deepEqual(setDisabledHere(fx.ctx, "schedule", "ws/a-first", true).disabled, ["ws/a-first", "ws/nightly"]);
  const ino = statSync(fx.localPath).ino;
  assert.deepEqual(setDisabledHere(fx.ctx, "schedule", "ws/nightly", true), { changed: false, disabled: ["ws/a-first", "ws/nightly"] });
  assert.deepEqual(setDisabledHere(fx.ctx, "trigger", "ws/never-disabled", false), { changed: false, disabled: ["ws/kb-review"] });
  assert.equal(statSync(fx.localPath).ino, ino, "nothing to change writes nothing");
  // Enabling takes the entry out; the emptied list and its emptied section go with it.
  setDisabledHere(fx.ctx, "schedule", "ws/a-first", false);
  assert.deepEqual(setDisabledHere(fx.ctx, "schedule", "ws/nightly", false), { changed: true, disabled: [] });
  setDisabledHere(fx.ctx, "trigger", "ws/kb-review", false);
  assert.equal(fx.text(), original, "the file is its first bytes again");
});

test("setDisabledHere keeps a file written as JSON in JSON, and refuses what the local schema refuses before a byte changes", (t) => {
  const json = fileOf(t, "", `{\n  "schemaVersion": 2,\n  "workspace": "git:github.com/acme/agents",\n  "host": { "name": "kb-host" }\n}\n`);
  setDisabledHere(json.ctx, "schedule", "ws/nightly", true);
  assert.equal(json.text(), `{\n  "schemaVersion": 2,\n  "workspace": "git:github.com/acme/agents",\n  "host": {\n    "name": "kb-host"\n  },\n  "schedules": {\n    "disabled": [\n      "ws/nightly"\n    ]\n  }\n}\n`);
  assert.deepEqual(JSON.parse(json.text()).schedules, { disabled: ["ws/nightly"] }, "it is JSON, as the kernel's reader takes a file that opens with {");
  assert.deepEqual(json.value().schedules, { disabled: ["ws/nightly"] });
  setDisabledHere(json.ctx, "schedule", "ws/nightly", false);
  assert.deepEqual(JSON.parse(json.text()), { schemaVersion: 2, workspace: "git:github.com/acme/agents", host: { name: "kb-host" } });

  const fx = fileOf(t, "host:\n  name: kb-host\n");
  const before = fx.text();
  for (const [kind, invalid] of [["schedule", `ws/${"s".repeat(101)}`], ["trigger", `ws/${"t".repeat(41)}`]]) {
    assert.throws(() => setDisabledHere(fx.ctx, kind, invalid, true), (e) => e.code === "E_WORKSPACE_SCHEMA" && /would be invalid .*nothing was written/.test(e.message) && e.details.problems.length > 0);
    assert.equal(fx.text(), before);
    assert.equal(existsSync(localLock(fx.dir)), false, "a refusal releases the lock");
  }
  // A file that is not YAML is refused as it is read.
  writeFileSync(fx.localPath, "schedules: [unclosed\n");
  assert.throws(() => setDisabledHere(fx.ctx, "schedule", "ws/nightly", true), { code: "E_WORKSPACE_SCHEMA" });
  assert.equal(fx.text(), "schedules: [unclosed\n");
});

test("setDisabledHere and `oats teams` work from the file as it is now: neither drops the other's change", (t) => {
  const WORKSPACE = { schemaVersion: 2, name: "acme", teams: {}, localTeams: true };
  const fx = fileOf(t, "host:\n  name: kb-host\n");
  const teamsCtx = () => ({ ...fx.ctx, local: fx.value(), workspace: WORKSPACE, workspaceKey: "github.com/acme/agents" });
  // A `teams` verb that read the file before the opt-out was written keeps the opt-out.
  const stale = teamsCtx();
  setDisabledHere(fx.ctx, "schedule", "ws/nightly", true);
  teamsAdd(stale, "mine", { team: "mine:me.example" });
  assert.deepEqual([fx.value().schedules, fx.value().teams, fx.value().defaultTeam], [{ disabled: ["ws/nightly"] }, { mine: { team: "mine:me.example" } }, "mine"]);
  // And an opt-out written after it keeps the team.
  setDisabledHere(fx.ctx, "trigger", "ws/kb-review", true);
  assert.deepEqual([fx.value().triggers, Object.keys(fx.value().teams)], [{ disabled: ["ws/kb-review"] }, ["mine"]]);
});

/* ───────────────────────────── the CLI ────────────────────────────────── */

const trigger = { kind: "oats-trigger", schemaVersion: 1, description: "Review harvest PRs", runsOn: "kb-host", owner: "github.com/kb-bot",
  on: { source: "github.pull_request", repo: "github.com/acme/knowledge", events: ["opened"], labels: ["okf-harvest"], poll: "2m" },
  spawn: { soul: "dev", purpose: "review-pr-{number}", task: "Review {repo}#{number} ({url})." } };
const schedule = { kind: "oats-schedule", schemaVersion: 1, runsOn: "kb-host", owner: "github.com/kb-bot", run: "spawn", cron: "0 7 * * *", tz: "UTC", agent: "dev", task: "Write the nightly digest." };
const PI = { harness: "pi" };

/** The one-repo deployment with what each of the writers needs: a soul, launch configurations, local
 *  teams allowed, and a workspace schedule and trigger placed on this host (a fake `gh` answers who
 *  its owner is). `fx.def(name, definition)` writes a `--file` for `launch-config set`. */
function deployment(t) {
  const fx = v2Deployment({ t, name: "acme", workspace: { localTeams: true }, souls: { dev: {} },
    local: { host: { name: "kb-host" }, automations: { trust: "*" }, "launch-configs": { fast: { harness: "pi", env: { TOKEN: "first" } }, private: { harness: "claude" } } },
    files: { "oats-triggers/kb-review.yaml": { yaml: trigger }, "oats-schedules/nightly.yaml": { yaml: schedule } } });
  const gh = join(fx.base, "gh"); mkdirSync(gh);
  writeFileSync(join(gh, "gh"), "#!/bin/sh\ncase \"$*\" in \"api user\"*) echo kb-bot; exit 0 ;; esac\necho \"unexpected gh $*\" >&2; exit 2\n");
  chmodSync(join(gh, "gh"), 0o755);
  fx.env.PATH = `${gh}:${fx.env.PATH}`;
  fx.local = join(fx.dep, LOCAL);
  fx.lock = localLock(fx.dep);
  fx.text = () => readFileSync(fx.local, "utf8");
  fx.value = () => YAML.parse(fx.text());
  let defs = 0, gated = 0;
  fx.def = (definition) => { const file = join(fx.base, `definition-${++defs}.json`); writeFileSync(file, typeof definition === "string" ? definition : JSON.stringify(definition)); return file; };
  fx.gateDir = () => join(fx.base, "gates", String(++gated));
  /** The CLI as a child that is not waited for → a promise of what fx.cli answers. `input`: its stdin. */
  fx.start = (args, { input, preload } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), CLI, ...args], { cwd: fx.dep, env: fx.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c) => { stdout += c; });
    child.stderr.setEncoding("utf8").on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr, json: () => JSON.parse(stdout.trim().split("\n").pop()) }));
    if (input !== undefined) child.stdin.end(input);
  });
  assert.equal(fx.cli(["sync", "--json"]).json().ok, true, "the fixture's sync");
  return fx;
}
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const refused = (r, code, what) => { const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.notEqual(r.status, 0, what); assert.equal(j.error.code, code, `${what}: ${r.stdout}`); return j.error; };
/** What a gated child answered, as fx.cli gives it. */
const answered = (done) => ({ status: done.code, stdout: done.stdout, stderr: done.stderr, json: () => JSON.parse(done.stdout.trim().split("\n").pop()) });

/** `first` starts and is held where it is about to take the lock: it has read whatever it reads
 *  before. `between()` runs (the other writers, each to its end), then `first` goes on.
 *  → what `first` answered. */
async function startedBefore(fx, first, between) {
  const run = startGated([CLI, ...first, "--json"], { cwd: fx.dep, env: fx.env, gateDir: fx.gateDir(), gates: [{ name: "lock", fn: "linkSync", arg: 1, path: fx.lock }] });
  try {
    await run.waitGate("lock");
    assert.equal(existsSync(fx.lock), false, "held before the lock is taken");
    await between();
    run.release("lock");
    const done = await run.done;
    assert.deepEqual(done.timedOut, []);
    return answered(done);
  } finally { await run.finish(); }
}
/** `first` is held at the rename of the file it rewrote: it holds the lock, it has read the file and
 *  made its edit. `second` is then started, and held at the return of its first try at the lock, which
 *  `first` holds (the lock's record names it). Both go on. → [first's answer, second's]. */
async function overlapped(fx, first, second) {
  const a = startGated([CLI, ...first, "--json"], { cwd: fx.dep, env: fx.env, gateDir: fx.gateDir(), gates: [{ name: "rename", fn: "renameSync", arg: 1, path: fx.local }] });
  let b = null;
  try {
    await a.waitGate("rename");
    const before = fx.text();
    b = startGated([CLI, ...second, "--json"], { cwd: fx.dep, env: fx.env, gateDir: fx.gateDir(), gates: [{ name: "lock", fn: "linkSync", arg: 1, path: fx.lock, when: "after" }] });
    await b.waitGate("lock");
    assert.equal(JSON.parse(readFileSync(fx.lock, "utf8")).pid, a.child.pid, `${second.join(" ")} found the lock held by ${first.join(" ")}`);
    assert.equal(fx.text(), before, "and has written nothing");
    b.release("lock");
    a.release("rename");
    const [first_, second_] = [await a.done, await b.done];
    assert.deepEqual([first_.timedOut, second_.timedOut], [[], []]);
    assert.equal(existsSync(fx.lock), false, "the lock is released");
    return [answered(first_), answered(second_)];
  } finally { await a.finish(); await b?.finish(); }
}

test("launch-config set and soul launch set, each started before the other writes: both changes are in the file", async (t) => {
  const fx = deployment(t);
  const launchSet = (name, definition) => ["launch-config", "set", name, "--file", fx.def(definition)];
  const soulSet = (config) => ["soul", "launch", "set", "dev", "--launch-config", config];
  const state = () => [Object.keys(fx.value()["launch-configs"]).sort(), fx.value().souls?.launch];
  // The interleaving of the issue: `launch-config set` has started, `soul launch set` writes, `launch-config set` writes.
  let r = await startedBefore(fx, launchSet("slow", PI), () => { ok(fx.cli([...soulSet("fast"), "--json"]), "soul launch set"); });
  assert.equal(ok(r, "launch-config set").after.harness, "pi");
  assert.deepEqual(state(), [["fast", "private", "slow"], { dev: "fast" }]);
  // The other way round.
  r = await startedBefore(fx, soulSet("private"), () => { ok(fx.cli([...launchSet("spare", PI), "--json"]), "launch-config set"); });
  assert.deepEqual([ok(r, "soul launch set").before, r.json().result.after], ["fast", "private"]);
  assert.deepEqual(state(), [["fast", "private", "slow", "spare"], { dev: "private" }]);
  // Each between its read and its rename while the other arrives: the other waits at the lock.
  let [a, b] = await overlapped(fx, launchSet("third", PI), soulSet("slow"));
  assert.deepEqual([ok(a, "launch-config set").name, ok(b, "soul launch set").after], ["third", "slow"]);
  assert.deepEqual(state(), [["fast", "private", "slow", "spare", "third"], { dev: "slow" }]);
  [a, b] = await overlapped(fx, soulSet("third"), launchSet("fourth", PI));
  assert.deepEqual([ok(a, "soul launch set").after, ok(b, "launch-config set").name], ["third", "fourth"]);
  assert.deepEqual(state(), [["fast", "fourth", "private", "slow", "spare", "third"], { dev: "third" }]);
  // A configuration removed while a `soul launch set` that names it waits is judged on the file as it then is.
  [a, b] = await overlapped(fx, ["launch-config", "remove", "spare"], soulSet("spare"));
  ok(a, "launch-config remove");
  assert.equal(refused(b, "E_LAUNCH_CONFIG_UNKNOWN", "soul launch set of a configuration removed meanwhile").details.name, "spare");
  assert.deepEqual(state(), [["fast", "fourth", "private", "slow", "third"], { dev: "third" }]);
});

test("launch-config set and launch-config remove, each started before the other writes; what set derives from the file is the file's under the lock", async (t) => {
  const fx = deployment(t);
  const set = (name, definition, ...flags) => ["launch-config", "set", name, "--file", fx.def(definition), ...flags];
  const configs = () => fx.value()["launch-configs"];
  let r = await startedBefore(fx, set("slow", PI), () => { ok(fx.cli(["launch-config", "remove", "private", "--json"]), "remove"); });
  ok(r, "set");
  assert.deepEqual(Object.keys(configs()).sort(), ["fast", "slow"], "the removal is kept, and the new entry is there");
  r = await startedBefore(fx, ["launch-config", "remove", "slow"], () => { ok(fx.cli([...set("other", PI), "--json"]), "set"); });
  ok(r, "remove");
  assert.deepEqual(Object.keys(configs()).sort(), ["fast", "other"]);
  const [a, b] = await overlapped(fx, set("third", PI), ["launch-config", "remove", "other"]);
  assert.deepEqual([ok(a, "set").action, ok(b, "remove").before.harness], ["set", "pi"]);
  assert.deepEqual(Object.keys(configs()).sort(), ["fast", "third"]);

  // `before` and the environment --keep-env keeps: of the definition as another `set` left it meanwhile.
  r = await startedBefore(fx, set("fast", { harness: "pi", model: "kept" }, "--keep-env"), () => { ok(fx.cli([...set("fast", { harness: "pi", args: ["--later"], env: { TOKEN: "second", MORE: { fromEnv: "SRC" } } }), "--json"]), "the other set"); });
  assert.deepEqual(ok(r, "set --keep-env").before.args, ["--later"]);
  assert.deepEqual(configs().fast, { harness: "pi", env: { MORE: { fromEnv: "SRC" }, TOKEN: "second" }, model: "kept" });
  // Whether the name is declared: a `remove` of one removed meanwhile, a --keep-env of one declared meanwhile.
  r = await startedBefore(fx, ["launch-config", "remove", "third"], () => { ok(fx.cli(["launch-config", "remove", "third", "--json"]), "the other remove"); });
  assert.match(refused(r, "E_LAUNCH_CONFIG_UNKNOWN", "remove of one removed meanwhile").message, /^third is not declared in /);
  r = await startedBefore(fx, set("late", PI, "--keep-env"), () => { ok(fx.cli([...set("late", { harness: "pi", env: { A: "1" } }), "--json"]), "the other set"); });
  ok(r, "set --keep-env of a name declared meanwhile");
  assert.deepEqual(configs().late, { harness: "pi", env: { A: "1" } });
  // One default per harness: a second one declared meanwhile is seen, named first, and nothing is written.
  r = await startedBefore(fx, set("mine", { harness: "pi", default: true }), () => { ok(fx.cli([...set("theirs", { harness: "pi", default: true }), "--json"]), "the other default"); });
  const before = fx.text();
  assert.deepEqual(refused(r, "E_LAUNCH_CONFIG_INVALID", "a second default").details, { harness: "pi", configurations: ["theirs", "mine"] });
  assert.equal(fx.text(), before);
  assert.equal(existsSync(fx.lock), false);
});

test("schedule|trigger enable|disable and teams add, each started before the other writes: both changes are in the file", async (t) => {
  const fx = deployment(t);
  const teamsAddCmd = (label) => ["teams", "add", label, "--team", `${label}:me.example`];
  const state = () => [fx.value().schedules?.disabled, fx.value().triggers?.disabled, Object.keys(fx.value().teams ?? {})];
  let r = await startedBefore(fx, ["schedule", "disable", "ws/nightly"], () => { ok(fx.cli([...teamsAddCmd("mine"), "--json"]), "teams add"); });
  assert.deepEqual([ok(r, "schedule disable").schedule.enabledHere, r.json().result.schedule.runsHere], [false, false]);
  assert.deepEqual(state(), [["ws/nightly"], undefined, ["mine"]]);
  r = await startedBefore(fx, teamsAddCmd("other"), () => { ok(fx.cli(["trigger", "disable", "ws/kb-review", "--json"]), "trigger disable"); });
  ok(r, "teams add");
  assert.deepEqual(state(), [["ws/nightly"], ["ws/kb-review"], ["mine", "other"]]);
  let [a, b] = await overlapped(fx, ["schedule", "enable", "ws/nightly"], teamsAddCmd("third"));
  assert.deepEqual([ok(a, "schedule enable").schedule.enabledHere, ok(b, "teams add").changed], [true, true]);
  assert.deepEqual(state(), [undefined, ["ws/kb-review"], ["mine", "other", "third"]]);
  [a, b] = await overlapped(fx, teamsAddCmd("fourth"), ["trigger", "enable", "ws/kb-review"]);
  assert.deepEqual([ok(a, "teams add").changed, ok(b, "trigger enable").trigger.enabledHere], [true, true]);
  assert.deepEqual(state(), [undefined, undefined, ["mine", "other", "third", "fourth"]]);
  // The two opt-out lists against each other, and against a launch configuration.
  [a, b] = await overlapped(fx, ["trigger", "disable", "ws/kb-review"], ["schedule", "disable", "ws/nightly"]);
  ok(a, "trigger disable"); ok(b, "schedule disable");
  [a, b] = await overlapped(fx, ["launch-config", "set", "slow", "--file", fx.def(PI)], ["schedule", "enable", "ws/nightly"]);
  ok(a, "launch-config set"); ok(b, "schedule enable");
  assert.deepEqual([...state(), Object.keys(fx.value()["launch-configs"]).sort()], [undefined, ["ws/kb-review"], ["mine", "other", "third", "fourth"], ["fast", "private", "slow"]]);
});

test("a lock held elsewhere: each writer answers E_LOCAL_BUSY as `oats teams` does and writes nothing; what needs only the arguments is refused without waiting", async (t) => {
  const fx = deployment(t);
  const { lock, record } = holdLock(fx.dep), before = fx.text();
  const waiting = {
    "teams add": fx.start(["teams", "add", "mine", "--team", "mine:me.example", "--json"]),
    "launch-config set": fx.start(["launch-config", "set", "slow", "--file", fx.def(PI), "--json"]),
    "launch-config set, from stdin": fx.start(["launch-config", "set", "slow", "--file", "-", "--json"], { input: JSON.stringify(PI) }),
    "launch-config remove": fx.start(["launch-config", "remove", "fast", "--json"]),
    "schedule disable": fx.start(["schedule", "disable", "ws/nightly", "--json"]),
    "trigger disable": fx.start(["trigger", "disable", "ws/kb-review", "--json"]),
  };
  // Refused on the arguments alone, while the lock is held: none of these waits for it (it would answer E_LOCAL_BUSY).
  refused(fx.cli(["launch-config", "set", "bad", "--file", fx.def({ harness: "bash" }), "--json"]), "E_LAUNCH_CONFIG_INVALID", "an invalid definition");
  refused(fx.cli(["launch-config", "set", "bad", "--file", fx.def("{not json"), "--json"]), "E_BAD_ARGS", "a definition that is not JSON");
  const stdin = spawnSync(process.execPath, [CLI, "launch-config", "set", "bad", "--file", "-", "--json"], { cwd: fx.dep, env: fx.env, encoding: "utf8", input: JSON.stringify({ harness: "bash" }) });
  assert.equal(JSON.parse(stdin.stdout).error.code, "E_LAUNCH_CONFIG_INVALID", `an invalid definition on stdin: ${stdin.stdout}`);
  refused(fx.cli(["launch-config", "set", "fast", "--file", fx.def({ harness: "pi", env: { A: "1" } }), "--keep-env", "--json"]), "E_BAD_ARGS", "--keep-env with env");
  refused(fx.cli(["schedule", "disable", "ws/nope", "--json"]), "E_SCHEDULE_UNKNOWN", "an unknown schedule");
  refused(fx.cli(["trigger", "disable", "ws/nope", "--json"]), "E_TRIGGER_UNKNOWN", "an unknown trigger");

  const errors = {};
  for (const [what, run] of Object.entries(waiting)) errors[what] = refused(await run, "E_LOCAL_BUSY", what);
  for (const [what, error] of Object.entries(errors)) assert.deepEqual(error, errors["teams add"], `${what} answers what oats teams answers`);
  assert.deepEqual(errors["teams add"].details, { path: fx.local, lock });
  assert.match(errors["teams add"].message, /if no oats command that edits this file is running, remove .*local\.lock and retry; nothing was written$/);
  assert.doesNotMatch(errors["teams add"].message, /oats teams|oats soul launch/, "the message names no command: a list of them is wrong the day one is added");
  assert.equal(fx.text(), before, "nothing was written");
  assert.equal(readFileSync(lock, "utf8"), record, "the holder's lock is not touched");
  assert.deepEqual(readdirSync(dirname(lock)), ["local.lock"], "and nothing is left beside it");
});

test("a file that keeps changing: each writer answers E_LOCAL_CHANGED and writes nothing of its own", (t) => {
  const fx = deployment(t);
  // Another writer that takes no lock, on demand: in the child, every read of oats-local.yaml is followed
  // by a line appended to it. Each attempt's compare then finds a file that is not the one it read.
  const preload = join(fx.base, "local-keeps-changing.mjs");
  writeFileSync(preload, `// Written by test/local-writers.test.mjs.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const readFileSync = fs.readFileSync, appendFileSync = fs.appendFileSync;
let n = 0;
fs.readFileSync = function (path, ...rest) {
  const read = readFileSync.call(this, path, ...rest);
  if (String(path) === ${JSON.stringify(fx.local)}) appendFileSync(path, "# another writer " + (++n) + "\\n");
  return read;
};
syncBuiltinESMExports();
`);
  const original = fx.text();
  const ownLines = () => fx.text().split("\n").filter((line) => !line.startsWith("# another writer ")).join("\n");
  const run = (args) => { const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, CLI, ...args, "--json"], { cwd: fx.dep, env: fx.env, encoding: "utf8" }); return { ...r, json: () => JSON.parse(r.stdout.trim().split("\n").pop()) }; };
  for (const args of [["launch-config", "set", "slow", "--file", fx.def(PI)], ["launch-config", "remove", "fast"], ["schedule", "disable", "ws/nightly"], ["trigger", "disable", "ws/kb-review"], ["teams", "add", "mine", "--team", "mine:me.example"]]) {
    const error = refused(run(args), "E_LOCAL_CHANGED", args.join(" "));
    assert.deepEqual(error.details, { path: fx.local }, args.join(" "));
    assert.match(error.message, /kept changing while this edit ran; nothing was written/);
    assert.equal(ownLines(), original, `${args.join(" ")}: the file holds the other writer's lines and nothing of this command`);
    assert.equal(existsSync(fx.lock), false, "the lock is released");
  }
  assert.ok(fx.text().length > original.length, "the other writer did write");
});

test("a launch-config refusal made on the file under the lock keeps its code, writes nothing and leaves no lock: the next write succeeds; a JSON file; no locks directory", (t) => {
  const fx = deployment(t);
  ok(fx.cli(["launch-config", "set", "first", "--file", fx.def({ harness: "pi", default: true }), "--json"]), "the first default");
  const before = fx.text();
  const cases = [
    [["launch-config", "set", "second", "--file", fx.def({ harness: "pi", default: true })], "E_LAUNCH_CONFIG_INVALID", (e) => assert.deepEqual(e.details, { harness: "pi", configurations: ["first", "second"] })],
    [["launch-config", "set", "nowhere", "--file", fx.def(PI), "--keep-env"], "E_LAUNCH_CONFIG_UNKNOWN", (e) => assert.match(e.message, /^--keep-env: no launch configuration nowhere is declared in /)],
    [["launch-config", "remove", "nowhere"], "E_LAUNCH_CONFIG_UNKNOWN", (e) => assert.match(e.message, /^nowhere is not declared in /)],
    [["launch-config", "set", "bad", "--file", fx.def({ harness: "bash" })], "E_LAUNCH_CONFIG_INVALID", () => {}],
  ];
  for (const [args, code, check] of cases) {
    const r = fx.cli([...args, "--json"]);
    check(refused(r, code, args.join(" ")));
    assert.equal(fx.text(), before, `${args.join(" ")}: nothing was written`);
    assert.equal(existsSync(fx.lock), false, `${args.join(" ")}: no lock is left`);
  }
  assert.deepEqual(ok(fx.cli(["launch-config", "set", "second", "--file", fx.def(PI), "--json"]), "the next write").after.harness, "pi");
  // The same definition again: the receipt is the same, and the file is not replaced.
  const ino = statSync(fx.local).ino, text = fx.text();
  const again = ok(fx.cli(["launch-config", "set", "second", "--file", fx.def(PI), "--json"]), "the same definition again");
  assert.deepEqual([again.before, again.after, again.effective.name], [again.after, { harness: "pi", executable: null, args: [], env: {}, model: null, yolo: null, default: false }, "second"]);
  assert.deepEqual([fx.text(), statSync(fx.local).ino], [text, ino]);
  // A deployment whose oats-local.yaml is written as JSON: the opt-out is written, and the file stays JSON.
  const yaml = fx.text();
  writeFileSync(fx.local, `${JSON.stringify(YAML.parse(yaml), null, 2)}\n`);
  assert.equal(ok(fx.cli(["trigger", "disable", "ws/kb-review", "--json"]), "disable, in a JSON file").trigger.enabledHere, false);
  assert.deepEqual(JSON.parse(fx.text()).triggers, { disabled: ["ws/kb-review"] });
  assert.equal(ok(fx.cli(["trigger", "enable", "ws/kb-review", "--json"]), "enable, in a JSON file").trigger.enabledHere, true);
  assert.deepEqual(JSON.parse(fx.text()), YAML.parse(yaml));
  writeFileSync(fx.local, yaml);
  // A file its operator made private stays private through each writer.
  chmodSync(fx.local, 0o600);
  ok(fx.cli(["launch-config", "set", "private-too", "--file", fx.def(PI), "--json"]), "set, on a 0600 file");
  ok(fx.cli(["trigger", "disable", "ws/kb-review", "--json"]), "disable, on a 0600 file");
  ok(fx.cli(["teams", "add", "mine", "--team", "mine:me.example", "--json"]), "teams add, on a 0600 file");
  assert.equal(statSync(fx.local).mode & 0o7777, 0o600);
  // A deployment that has no .agents/locks yet: the lock's parents are made.
  rmSync(join(fx.dep, ".agents", "locks"), { recursive: true, force: true });
  ok(fx.cli(["launch-config", "remove", "second", "--json"]), "remove with no locks directory");
  ok(fx.cli(["schedule", "disable", "ws/nightly", "--json"]), "disable");
  assert.deepEqual(readdirSync(join(fx.dep, ".agents", "locks")).filter((n) => n === "local.lock"), []);
});
