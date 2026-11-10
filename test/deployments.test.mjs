// This computer's deployments (awebai/oats#1390; docs/workspaces.md "This computer's deployments"):
// `~/.oats/config/deployments.json` and `oats deployments [list]|add|remove|import`, the first-use
// `~/Agents` import, the five E_DEPLOYMENTS_* codes, and the auto-add a kernel command does in an
// unlisted deployment (with tombstones that keep a removed path off the list).
//
// Every CLI run here gets an environment built from nothing: a HOME and an OATS_HOME_DIR of the
// test's own, never the person's. The in-process cases set both on process.env and restore them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selfIdentity } from "../lib/worktree-hooks.mjs";
import { outsideTemporaryBase, outsideTemporaryUnavailable } from "./helpers/outside-temporary.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const LIB = new URL("../lib/deployments.mjs", import.meta.url).href;
const ROOT = typeof process.getuid === "function" && process.getuid() === 0;
/** Why the auto-add tests cannot run here (no usable /var/tmp), or null: their deployments must be
 *  outside every temporary directory, which the auto-add skips (test/helpers/outside-temporary.mjs). */
const OUTSIDE = outsideTemporaryUnavailable();
const LOCAL_YAML = "schemaVersion: 2\nworkspace: github.com/example/acme-workspace\n";

/** A fresh base: a HOME (with no ~/Agents unless a case makes one), an OATS_HOME_DIR, and room for
 *  deployments. realpath'd once, so the paths the list stores are the ones built here. `outside`: in
 *  /var/tmp, outside every temporary directory, for a case where a command's auto-add must list
 *  (or must be seen not to list for a reason of its own); the test then skips with OUTSIDE. */
function fixture(t, { outside = false } = {}) {
  const base = outside ? outsideTemporaryBase(t) : realpathSync(mkdtempSync(join(tmpdir(), "oats-deployments-")));
  if (!outside) t.after(() => { chmodTree(base); rmSync(base, { recursive: true, force: true }); }); // an outside base removes itself
  const home = join(base, "home");
  mkdirSync(home);
  const oatsHome = join(base, "oats-home");
  const file = join(oatsHome, "config", "deployments.json");
  const lock = join(oatsHome, "config", "deployments.lock");
  const env = { PATH: process.env.PATH, HOME: home, OATS_HOME_DIR: oatsHome, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  const oats = (args, { cwd = base, extra = {} } = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  const json = (args, opts) => {
    const r = oats([...args, "--json"], opts);
    const doc = JSON.parse(r.stdout);
    assert.equal(r.stdout.trim(), JSON.stringify(doc), "stdout is exactly one JSON envelope");
    return { r, doc };
  };
  const ok = (args, opts) => { const { r, doc } = json(args, opts); assert.equal(r.status, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`); assert.equal(doc.ok, true); return doc.result; };
  const failure = (args, code, opts) => { const { r, doc } = json(args, opts); assert.equal(doc.ok, false, r.stdout); assert.notEqual(r.status, 0); assert.equal(doc.error.code, code, doc.error.message); return doc.error; };
  /** A deployment: a directory with a regular oats-local.yaml. */
  const deployment = (...parts) => { const dir = join(base, ...parts); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "oats-local.yaml"), LOCAL_YAML); return dir; };
  const stored = () => JSON.parse(readFileSync(file, "utf8"));
  const seed = (doc) => { mkdirSync(join(oatsHome, "config"), { recursive: true, mode: 0o700 }); writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 }); };
  /** A lock some other live process holds (this test's own pid: alive, and not the CLI child). */
  const holdLock = () => { mkdirSync(join(oatsHome, "config"), { recursive: true }); writeFileSync(lock, JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "a test" }) + "\n"); return () => rmSync(lock, { force: true }); };
  return { base, home, oatsHome, file, lock, env, oats, json, ok, failure, deployment, stored, seed, holdLock };
}
/** Make every directory under `p` writable again, so a case that took permissions away can clean up. */
function chmodTree(p) {
  try { const st = statSync(p); if (!st.isDirectory()) return; chmodSync(p, 0o700); for (const e of execFileSync("ls", ["-A", p], { encoding: "utf8" }).split("\n").filter(Boolean)) chmodTree(join(p, e)); } catch { /* gone */ }
}
const MARKED = (at = "2026-10-19T10:00:00.000Z") => ({ schemaVersion: 1, deployments: [], imports: { "agents-dir": at } });
const ROW_KEYS = ["addedAt", "name", "path", "state", "via"];

// ---------------------------------------------------------------- the file and the first use

test("first use: a missing file is an empty list; the ~/Agents import runs once and sets its marker even with no ~/Agents; the file is 0600 in a 0700 config/", (t) => {
  const f = fixture(t);
  const res = f.ok(["deployments"]);
  assert.deepEqual(Object.keys(res).sort(), ["deployments", "deploymentsApi", "file", "imports"]);
  assert.equal(res.deploymentsApi, 1);
  assert.equal(res.file, f.file);
  assert.deepEqual(res.deployments, []);
  assert.match(res.imports["agents-dir"], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(f.stored(), { schemaVersion: 1, deployments: [], imports: res.imports });
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.oatsHome, "config")).mode & 0o777, 0o700);
  assert.equal(existsSync(f.lock), false, "the lock is released");
  // Text form, empty.
  const r = f.oats(["deployments"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `no deployments listed (${f.file}): create one with \`oats onboard <dir> --workspace <ref>\`, or add one with \`oats deployments add <dir>\`\n`);
  // The marker is never moved: the import does not run again.
  assert.deepEqual(f.ok(["deployments", "list"]).imports, res.imports);
});

test("the ~/Agents import: deployments directly inside it, a link never followed, a linked or missing oats-local.yaml not a deployment; once only", (t) => {
  const f = fixture(t);
  const agents = join(f.home, "Agents");
  const a = f.deployment("home", "Agents", "acme");
  const b = f.deployment("home", "Agents", "beta");
  mkdirSync(join(agents, "notes"));                                         // no oats-local.yaml
  writeFileSync(join(agents, "loose-file"), "x\n");                         // not a directory
  const outside = f.deployment("elsewhere", "gamma");
  symlinkSync(outside, join(agents, "gamma-link"));                         // a link: not followed
  mkdirSync(join(agents, "linked-local"));
  symlinkSync(join(outside, "oats-local.yaml"), join(agents, "linked-local", "oats-local.yaml")); // not regular
  const res = f.ok(["deployments"]);
  assert.deepEqual(res.deployments.map((d) => d.path), [a, b]);
  for (const d of res.deployments) {
    assert.deepEqual(Object.keys(d).sort(), ROW_KEYS);
    assert.equal(d.via, "import:agents-dir");
    assert.equal(d.state, "ok");
    assert.equal(d.addedAt, res.imports["agents-dir"]);
  }
  assert.deepEqual(res.deployments.map((d) => d.name), ["acme", "beta"]);
  // A deployment that appears in ~/Agents later is not imported: the marker says the import ran.
  f.deployment("home", "Agents", "delta");
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [a, b]);
});

test("the ~/Agents import: a linked ~/Agents is not followed (nothing imported, marker set)", (t) => {
  const f = fixture(t);
  const real = join(f.base, "real-agents");
  f.deployment("real-agents", "acme");
  symlinkSync(real, join(f.home, "Agents"));
  const res = f.ok(["deployments"]);
  assert.deepEqual(res.deployments, []);
  assert.equal(typeof res.imports["agents-dir"], "string");
});

test("E_DEPLOYMENTS_IMPORT: an unreadable ~/Agents fails the command and is not marked imported; an unreadable entry in it is skipped", { skip: ROOT && "root reads anywhere" }, (t) => {
  const f = fixture(t);
  const acme = f.deployment("home", "Agents", "acme");
  const agents = join(f.home, "Agents");
  chmodSync(agents, 0o000);
  for (const args of [["deployments"], ["deployments", "add", f.deployment("beta")], ["deployments", "remove", "/x"], ["deployments", "import", "--from", "desktop"]]) {
    const e = f.failure(args, "E_DEPLOYMENTS_IMPORT");
    assert.match(e.message, new RegExp(`^cannot read ${agents} to import its deployments \\(.*EACCES.*\\); make it readable, or move it aside, and retry; nothing was changed$`));
    assert.equal(e.details.dir, agents);
  }
  assert.equal(existsSync(f.file), false, "nothing was written: no rows and no marker");
  // The auto-add swallows it.
  const r = f.oats(["doctor", "--json"], { cwd: f.deployment("gamma") });
  assert.doesNotMatch(r.stderr, /deployments|Agents/);
  assert.equal(existsSync(f.file), false);
  // Readable again: the import runs, once. An entry that cannot be checked is skipped.
  chmodSync(agents, 0o700);
  const locked = join(agents, "locked"); mkdirSync(join(locked, "inner"), { recursive: true }); chmodSync(locked, 0o000);
  const res = f.ok(["deployments"]);
  assert.deepEqual(res.deployments.map((d) => d.path), [acme]);
  assert.equal(typeof res.imports["agents-dir"], "string");
});

test("the ~/Agents import reads at most 200 entries", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 205; i++) f.deployment("home", "Agents", `d${String(i).padStart(3, "0")}`);
  assert.equal(f.ok(["deployments"]).deployments.length, 200);
});

test("the ~/Agents import is HOME's, never OATS_HOME_DIR's", (t) => {
  const f = fixture(t);
  f.deployment("oats-home", "Agents", "not-this-one");
  const mine = f.deployment("home", "Agents", "this-one");
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [mine]);
});

// ---------------------------------------------------------------- list

test("list: rows sorted by path with name, state (ok, missing, not-a-deployment, unreadable), addedAt and via; the text form is a table", (t) => {
  const f = fixture(t);
  const ok = f.deployment("acme");
  const notDep = join(f.base, "plain"); mkdirSync(notDep);
  const fileNotDir = join(f.base, "a-file"); writeFileSync(fileNotDir, "x\n");
  const locked = join(f.base, "locked"); mkdirSync(locked); const inner = join(locked, "inner");
  mkdirSync(inner); writeFileSync(join(inner, "oats-local.yaml"), LOCAL_YAML);
  const row = (path, via = "cli") => ({ path, addedAt: "2026-10-19T10:00:00.000Z", via });
  f.seed({ ...MARKED(), deployments: [row(ok, "onboard"), row(join(f.base, "zz-gone"), "import:desktop"), row(notDep, "tui"), row(fileNotDir, "desktop"), row(inner, "import:agents-dir")] });
  if (!ROOT) chmodSync(locked, 0o000);
  const res = f.ok(["deployments"]);
  assert.deepEqual(res.deployments.map((d) => d.path), [fileNotDir, ok, inner, notDep, join(f.base, "zz-gone")], "sorted by path");
  const state = Object.fromEntries(res.deployments.map((d) => [d.path, d.state]));
  assert.equal(state[ok], "ok");
  assert.equal(state[join(f.base, "zz-gone")], "missing");
  assert.equal(state[notDep], "not-a-deployment");
  assert.equal(state[fileNotDir], "not-a-deployment");
  if (!ROOT) assert.equal(state[inner], "unreadable");
  for (const d of res.deployments) assert.deepEqual(Object.keys(d).sort(), ROW_KEYS, "a row is a closed shape");
  const r = f.oats(["deployments"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.match(lines[0], /^PATH\s+STATE\s+VIA$/);
  assert.equal(lines.length, 6);
  assert.match(lines.find((l) => l.startsWith(ok + " ")), new RegExp(`^${ok}\\s+ok\\s+onboard$`));
  assert.match(lines.find((l) => l.includes("zz-gone")), /\s+missing\s+import:desktop$/);
});

// ---------------------------------------------------------------- add

test("add: walks up to the deployment, answers added true then false (nothing written), E_LOCAL_MISSING outside; --via tui|desktop only", (t) => {
  const f = fixture(t);
  const acme = f.deployment("acme");
  mkdirSync(join(acme, "agents", "deep"), { recursive: true });
  assert.deepEqual(f.ok(["deployments", "add"], { cwd: join(acme, "agents", "deep") }), { path: acme, added: true });
  const ino = statSync(f.file).ino;
  assert.deepEqual(f.ok(["deployments", "add", join(acme, "agents")]), { path: acme, added: false });
  assert.equal(statSync(f.file).ino, ino, "adding a listed deployment again writes nothing");
  assert.equal(f.ok(["deployments"]).deployments.find((d) => d.path === acme).via, "cli");
  // Outside every deployment.
  const nowhere = join(f.base, "nowhere"); mkdirSync(nowhere);
  const e = f.failure(["deployments", "add", nowhere], "E_LOCAL_MISSING");
  assert.match(e.message, /no oats-local\.yaml at or above .*nowhere/);
  // Only a regular oats-local.yaml makes a deployment (awebai/oats#1397): a directory or a link of
  // that name is passed over, to the deployment above it, or to E_LOCAL_MISSING.
  const odd = join(f.base, "odd"); mkdirSync(join(odd, "oats-local.yaml"), { recursive: true });
  assert.equal(f.failure(["deployments", "add", odd], "E_LOCAL_MISSING").message, e.message.replace(nowhere, odd));
  const linked = join(f.base, "linked"); mkdirSync(linked);
  symlinkSync(join(acme, "oats-local.yaml"), join(linked, "oats-local.yaml"));
  f.failure(["deployments", "add", linked], "E_LOCAL_MISSING");
  const inner = join(acme, "inner"); mkdirSync(join(inner, "oats-local.yaml"), { recursive: true });
  assert.deepEqual(f.ok(["deployments", "add", inner]), { path: acme, added: false }, "past a directory of that name, to the deployment above");
  assert.equal(existsSync(f.file) && f.stored().deployments.some((d) => d.path === odd || d.path === linked || d.path === inner), false);
  // The clients' --via.
  const beta = f.deployment("beta");
  assert.equal(f.ok(["deployments", "add", beta, "--via", "tui"]).added, true);
  assert.equal(f.ok(["deployments"]).deployments.find((d) => d.path === beta).via, "tui");
  const gamma = f.deployment("gamma");
  assert.equal(f.ok(["deployments", "add", gamma, "--via=desktop"]).added, true);
  assert.equal(f.ok(["deployments"]).deployments.find((d) => d.path === gamma).via, "desktop");
  f.failure(["deployments", "add", gamma, "--via", "cli"], "E_BAD_ARGS");
  f.failure(["deployments", "add", gamma, "--via", "onboard"], "E_BAD_ARGS");
  f.failure(["deployments", "remove", gamma, "--via", "tui"], "E_BAD_ARGS");
  // Text form.
  const r = f.oats(["deployments", "add", gamma]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gamma is already listed; nothing was changed/);
});

test("add: a path is stored canonical: a linked spelling is the same row", (t) => {
  const f = fixture(t);
  const acme = f.deployment("acme");
  symlinkSync(acme, join(f.base, "acme-link"));
  assert.deepEqual(f.ok(["deployments", "add", join(f.base, "acme-link")]), { path: acme, added: true });
  assert.deepEqual(f.ok(["deployments", "add", acme]), { path: acme, added: false });
  assert.equal(f.ok(["deployments"]).deployments.length, 1);
});

test("add: on a case-insensitive filesystem another letter case is the same row (skipped where the filesystem is case-sensitive)", (t) => {
  const f = fixture(t);
  const acme = f.deployment("Acme");
  if (!existsSync(join(f.base, "acme"))) { t.skip("this filesystem is case-sensitive"); return; }
  assert.deepEqual(f.ok(["deployments", "add", join(f.base, "acme")]), { path: acme, added: true });
  assert.deepEqual(f.ok(["deployments", "add", join(f.base, "ACME")]), { path: acme, added: false });
});

test("add: a deployment inside a linked Git worktree is listed at the primary checkout (canonicalDeploymentPath)", (t) => {
  const f = fixture(t);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const main = join(f.base, "repo"); mkdirSync(join(main, "deploy"), { recursive: true });
  writeFileSync(join(main, "deploy", "README"), "x\n");
  git(main, "init", "-q"); git(main, "add", "."); git(main, "commit", "-q", "-m", "init");
  git(main, "worktree", "add", "-q", join(f.base, "linked"), "-b", "side");
  writeFileSync(join(f.base, "linked", "deploy", "oats-local.yaml"), LOCAL_YAML);
  assert.deepEqual(f.ok(["deployments", "add", join(f.base, "linked", "deploy")]), { path: join(main, "deploy"), added: true });
  // The directory's own identity: an `agents` link inside it that points elsewhere changes nothing.
  mkdirSync(join(f.base, "linked", "other", "agents"), { recursive: true });
  symlinkSync("../other/agents", join(f.base, "linked", "deploy", "agents"));
  assert.deepEqual(f.ok(["deployments", "add", join(f.base, "linked", "deploy")]), { path: join(main, "deploy"), added: false });
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [join(main, "deploy")]);
});

test("a deployment at the root of a linked Git worktree is the primary checkout's: one row, and its tombstone holds against the auto-add and the Desktop import", { skip: OUTSIDE ?? false }, (t) => {
  const f = fixture(t, { outside: true });
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const main = join(f.base, "acme"); mkdirSync(main);
  writeFileSync(join(main, "README"), "x\n");
  git(main, "init", "-q"); git(main, "add", "."); git(main, "commit", "-q", "-m", "init");
  const linked = join(f.base, "acme-linked");
  git(main, "worktree", "add", "-q", linked, "-b", "side");
  for (const d of [main, linked]) { writeFileSync(join(d, "oats-local.yaml"), LOCAL_YAML); mkdirSync(join(d, "agents")); }
  assert.deepEqual(f.ok(["deployments", "add", main]), { path: main, added: true });
  assert.deepEqual(f.ok(["deployments", "add", linked]), { path: main, added: false });
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [main]);
  assert.deepEqual(f.ok(["deployments", "remove", linked]), { path: main, removed: true }, "remove finds the row by the canonical spelling too");
  f.oats(["doctor", "--json"], { cwd: linked });
  f.oats(["status", "--json"], { cwd: linked }); // ensureRoot's canonical root: the primary checkout
  assert.deepEqual(f.ok(["deployments", "import", "--from", "desktop", linked]).added, []);
  assert.deepEqual(f.ok(["deployments"]).deployments, [], "neither the auto-add nor the import revives the tombstone");
});

// ---------------------------------------------------------------- remove (tombstones)

test("remove: a tombstone, hidden from list in both forms; nothing on disk touched; an unlisted path answers removed false and exits 0; an explicit add brings it back", (t) => {
  const f = fixture(t);
  const acme = f.deployment("acme");
  f.ok(["deployments", "add", acme]);
  assert.deepEqual(f.ok(["deployments", "remove", acme]), { path: acme, removed: true });
  assert.ok(existsSync(join(acme, "oats-local.yaml")), "nothing on disk is touched");
  const row = f.stored().deployments.find((d) => d.path === acme);
  assert.equal(row.removed, true);
  assert.match(row.removedAt, /Z$/);
  assert.deepEqual(f.ok(["deployments"]).deployments, [], "a tombstone is never listed");
  assert.doesNotMatch(f.oats(["deployments"]).stdout, /acme/);
  // Removing again, or a path never listed.
  assert.deepEqual(f.ok(["deployments", "remove", acme]), { path: acme, removed: false });
  assert.deepEqual(f.ok(["deployments", "remove", join(f.base, "never")]), { path: join(f.base, "never"), removed: false });
  // remove does not walk up: a subdirectory of a listed deployment is not its row.
  const beta = f.deployment("beta");
  f.ok(["deployments", "add", beta]);
  assert.equal(f.ok(["deployments", "remove", join(beta, "agents")]).removed, false);
  // A stale row (the directory is gone) can be removed.
  rmSync(beta, { recursive: true });
  assert.deepEqual(f.ok(["deployments", "remove", beta]), { path: beta, removed: true });
  // An explicit add clears the tombstone, with this add's time and via.
  const added = f.ok(["deployments", "add", acme, "--via", "desktop"]);
  assert.deepEqual(added, { path: acme, added: true });
  const back = f.stored().deployments.find((d) => d.path === acme);
  assert.equal(back.removed, undefined); assert.equal(back.removedAt, undefined); assert.equal(back.via, "desktop");
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [acme]);
  f.failure(["deployments", "remove"], "E_BAD_ARGS");
});

// ---------------------------------------------------------------- the Desktop's import

test("import --from desktop: the first run lists every absolute path whatever its state and sets the marker in one write; later runs change nothing", (t) => {
  const f = fixture(t);
  const acme = f.deployment("acme");
  const gone = join(f.base, "unmounted", "volume", "dep");
  const res = f.ok(["deployments", "import", "--from", "desktop", acme, gone, acme]);
  assert.deepEqual(Object.keys(res).sort(), ["added", "at", "imported"]);
  assert.equal(res.imported, true);
  assert.deepEqual(res.added, [acme, gone]);
  const doc = f.stored();
  assert.equal(doc.imports.desktop, res.at);
  assert.deepEqual(doc.deployments.map((d) => [d.path, d.via, d.addedAt]), [[acme, "import:desktop", res.at], [gone, "import:desktop", res.at]]);
  assert.equal(f.ok(["deployments"]).deployments.find((d) => d.path === gone).state, "missing", "a saved entry on an unmounted volume is kept, shown missing");
  const ino = statSync(f.file).ino;
  assert.deepEqual(f.ok(["deployments", "import", "--from", "desktop", f.deployment("later")]), { imported: false, at: res.at });
  assert.equal(statSync(f.file).ino, ino, "a later import writes nothing");
});

test("import --from desktop: a relative path is refused before anything is written; zero paths set the marker; a tombstoned path is not listed again", (t) => {
  const f = fixture(t);
  const e = f.failure(["deployments", "import", "--from", "desktop", "/abs/ok", "relative/dir"], "E_BAD_ARGS");
  assert.match(e.message, /absolute paths only/);
  assert.equal(existsSync(f.file), false, "nothing was written, not even the ~/Agents import");
  f.failure(["deployments", "import", "/abs/ok"], "E_BAD_ARGS");
  f.failure(["deployments", "import", "--from", "tui", "/abs/ok"], "E_BAD_ARGS");
  // A tombstone survives the import.
  const acme = f.deployment("acme");
  f.ok(["deployments", "add", acme]); f.ok(["deployments", "remove", acme]);
  const res = f.ok(["deployments", "import", "--from", "desktop", acme]);
  assert.deepEqual(res.added, []);
  assert.deepEqual(f.ok(["deployments"]).deployments, []);
  // Zero paths, on a fresh list.
  const g = fixture(t);
  const zero = g.ok(["deployments", "import", "--from", "desktop"]);
  assert.deepEqual(zero, { imported: true, at: zero.at, added: [] });
  assert.equal(g.stored().imports.desktop, zero.at);
});

test("the ~/Agents import does not list a tombstoned path again", (t) => {
  const f = fixture(t);
  const acme = f.deployment("home", "Agents", "acme");
  f.seed({ schemaVersion: 1, deployments: [{ path: acme, addedAt: "2026-10-19T10:00:00.000Z", via: "cli", removed: true, removedAt: "2026-10-19T11:00:00.000Z" }], imports: {} });
  assert.deepEqual(f.ok(["deployments"]).deployments, []);
  assert.equal(f.stored().deployments.length, 1);
});

// ---------------------------------------------------------------- errors

test("E_DEPLOYMENTS_INVALID: not JSON, not an object, a link, over 1 MiB, or a row that breaks the schema; the file is never changed", (t) => {
  const cases = [
    ["not json\n", /not JSON/],
    ["[]\n", /not a JSON object/],
    [JSON.stringify({ deployments: [] }), /schemaVersion must be 1/],
    [JSON.stringify({ schemaVersion: 1, imports: { "agents-dir": "2026-10-19T10:00:00.000Z" } }), /deployments must be an array/],
    [JSON.stringify({ schemaVersion: 1, deployments: {} }), /deployments must be an array/],
    [JSON.stringify({ schemaVersion: 1, deployments: [{ path: "relative", addedAt: "x", via: "cli" }] }), /path must be an absolute path/],
    [JSON.stringify({ schemaVersion: 1, deployments: [{ path: "/a", addedAt: "x", via: "cli" }, { path: "/a", addedAt: "x", via: "cli" }] }), /listed twice/],
    [JSON.stringify({ schemaVersion: 1, deployments: [{ path: "/a", addedAt: "x", via: "somewhere" }] }), /via must be one of/],
    [JSON.stringify({ schemaVersion: 1, deployments: [], imports: [] }), /imports must be an object/],
    [JSON.stringify({ ...MARKED(), padding: "x".repeat(1024 * 1024) }), /over 1 MiB/],
  ];
  for (const [text, reason] of cases) {
    const f = fixture(t);
    f.seed(text);
    for (const args of [["deployments"], ["deployments", "add", f.deployment("acme")], ["deployments", "remove", "/a"], ["deployments", "import", "--from", "desktop"]]) {
      const e = f.failure(args, "E_DEPLOYMENTS_INVALID");
      assert.match(e.message, reason);
      assert.ok(e.message.startsWith(`${f.file} cannot be read as this computer's deployments list (`), e.message);
      assert.ok(e.message.endsWith("). Fix it, or move it aside and run `oats deployments add <dir>` for each deployment; nothing was changed"), e.message);
      assert.equal(readFileSync(f.file, "utf8"), text);
    }
  }
  // A link, even to a valid list.
  const f = fixture(t);
  const real = join(f.base, "real.json"); writeFileSync(real, JSON.stringify(MARKED()));
  mkdirSync(join(f.oatsHome, "config"), { recursive: true });
  symlinkSync(real, f.file);
  assert.match(f.failure(["deployments"], "E_DEPLOYMENTS_INVALID").message, /it is a link/);
});

test("E_DEPLOYMENTS_VERSION: a newer schema is refused and never rewritten", (t) => {
  const f = fixture(t);
  const newer = JSON.stringify({ schemaVersion: 2, deployments: [], somethingNew: true });
  f.seed(newer);
  const e = f.failure(["deployments", "add", f.deployment("acme")], "E_DEPLOYMENTS_VERSION");
  assert.equal(e.message, `${f.file} was written by a newer oats (schema 2); upgrade oats`);
  f.failure(["deployments"], "E_DEPLOYMENTS_VERSION");
  assert.equal(readFileSync(f.file, "utf8"), newer);
});

test("E_DEPLOYMENTS_BUSY: a lock still held after 3 s; the first-use import never answers a list that skipped it", (t) => {
  const f = fixture(t);
  const release = f.holdLock();
  t.after(release);
  const started = Date.now();
  const e = f.failure(["deployments"], "E_DEPLOYMENTS_BUSY");
  assert.ok(Date.now() - started >= 2900, "it waited for the lock");
  assert.equal(e.message, `this computer's deployments list is locked (pid ${process.pid} holds it); if no oats process is changing it, remove ${f.lock} and retry; nothing was changed`);
  assert.equal(existsSync(f.file), false);
  // Once the import ran, a plain list takes no lock.
  release();
  f.ok(["deployments"]);
  f.holdLock();
  f.ok(["deployments"]);
  f.failure(["deployments", "add", f.deployment("acme")], "E_DEPLOYMENTS_BUSY");
});

test("E_DEPLOYMENTS_WRITE: a write that would make the file larger than its readers read is refused, and the list stays as it was", (t) => {
  const f = fixture(t);
  // Valid, and within the budget as stored (compact); kept fields are written back, pretty-printed.
  const doc = { ...MARKED(), padding: "" };
  doc.padding = "x".repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(doc)) - 64);
  const text = JSON.stringify(doc);
  f.seed(text);
  assert.ok(Buffer.byteLength(text) <= 1024 * 1024);
  assert.deepEqual(f.ok(["deployments"]).deployments, [], "the stored list reads");
  const e = f.failure(["deployments", "add", f.deployment("acme")], "E_DEPLOYMENTS_WRITE");
  assert.match(e.message, /^cannot write .*deployments\.json \(it would be \d+ bytes, over 1 MiB\); nothing was changed$/);
  assert.equal(readFileSync(f.file, "utf8"), text);
  f.ok(["deployments", "remove", "/never/listed"]);
});

test("E_DEPLOYMENTS_WRITE: the write failed; it names the file and the system error", { skip: ROOT && "root writes anywhere" }, (t) => {
  const f = fixture(t);
  f.seed(MARKED());
  const before = readFileSync(f.file, "utf8");
  chmodSync(join(f.oatsHome, "config"), 0o500);
  const e = f.failure(["deployments", "add", f.deployment("acme")], "E_DEPLOYMENTS_WRITE");
  assert.match(e.message, /^cannot write .*deployments\.json \(.*EACCES.*\); nothing was changed$/);
  chmodSync(join(f.oatsHome, "config"), 0o700);
  assert.equal(readFileSync(f.file, "utf8"), before);
});

test("unknown fields of the file are kept when it is rewritten, and never reach the answer", (t) => {
  const f = fixture(t);
  const acme = f.deployment("acme");
  f.seed({ ...MARKED(), futureKey: { a: 1 }, deployments: [{ path: acme, addedAt: "2026-10-19T10:00:00.000Z", via: "cli", note: "kept" }] });
  f.ok(["deployments", "add", f.deployment("beta")]);
  const doc = f.stored();
  assert.deepEqual(doc.futureKey, { a: 1 });
  assert.equal(doc.deployments.find((d) => d.path === acme).note, "kept");
  for (const d of f.ok(["deployments"]).deployments) assert.deepEqual(Object.keys(d).sort(), ROW_KEYS);
});

// ---------------------------------------------------------------- the command itself

test("oats deployments: usage hides --via, --server is refused, an unknown subcommand or flag is E_BAD_ARGS, and the feature is advertised", (t) => {
  const f = fixture(t);
  const r = f.oats(["deployments", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /oats deployments \[list\] \[--json\]/);
  assert.match(r.stdout, /oats deployments add \[<dir>\]/);
  assert.match(r.stdout, /oats deployments remove <path>/);
  assert.match(r.stdout, /oats deployments import --from desktop <path>\.\.\./);
  assert.doesNotMatch(r.stdout, /--via/);
  f.failure(["deployments", "--server", "box"], "E_BAD_ARGS");
  f.failure(["deployments", "frobnicate"], "E_BAD_ARGS");
  f.failure(["deployments", "list", "--bogus"], "E_BAD_ARGS");
  assert.equal(existsSync(f.file), false, "a refused command touches nothing");
  assert.ok(JSON.parse(f.oats(["version", "--json"]).stdout).features.includes("deployments-list"));
});

// ---------------------------------------------------------------- the auto-add (#1390 amendment)

test("auto-add: a kernel command that resolves an unlisted deployment lists it via cli, once, silently; its answer and exit status are unchanged", { skip: OUTSIDE ?? false }, (t) => {
  const f = fixture(t, { outside: true });
  const acme = f.deployment("acme");
  mkdirSync(join(acme, "agents"));
  const first = f.oats(["doctor", "--json"], { cwd: join(acme, "agents") });
  const rows = f.stored().deployments.filter((d) => d.path === acme);
  assert.deepEqual(rows.map((d) => d.via), ["cli"]);
  const ino = statSync(f.file).ino;
  const second = f.oats(["doctor", "--json"], { cwd: join(acme, "agents") });
  assert.equal(statSync(f.file).ino, ino, "a listed deployment costs no write");
  assert.equal(first.status, second.status);
  assert.equal(first.stdout, second.stdout, "the answer is the same whether or not the command listed its deployment");
  assert.equal(first.stderr, second.stderr, "nothing is said");
  assert.doesNotMatch(first.stderr, /deployments/);
  // From outside, by doctor's [dir], by --dir, by --home.
  const beta = f.deployment("beta");
  f.oats(["doctor", beta, "--json"]);
  const gamma = f.deployment("gamma");
  f.oats(["launch-config", "list", "--dir", gamma, "--json"]);
  const delta = f.deployment("delta");
  mkdirSync(join(delta, "agents"));
  f.oats(["status", "--json"], { cwd: join(delta, "agents") }); // ensureRoot's canonical root
  const epsilon = f.deployment("epsilon");
  f.oats(["harness", "trust", "--plan", "--harness", "codex", "--dir", epsilon, "--json"]);
  const listed = f.ok(["deployments"]).deployments;
  for (const d of [acme, beta, gamma, delta, epsilon]) assert.equal(listed.find((row) => row.path === d)?.via, "cli", d);
  // A command that fails before it resolves a deployment lists nothing.
  const zeta = f.deployment("zeta");
  f.oats(["session", "inspect", "--home", join(zeta, "agents", "x", "instances", "y"), "--json"]);
  assert.equal(f.ok(["deployments"]).deployments.some((row) => row.path === zeta), false);
});

test("auto-add: never on --server, never for a command outside the table, never for --help; a broken list never changes the command", { skip: OUTSIDE ?? false }, (t) => {
  const f = fixture(t, { outside: true });
  const acme = f.deployment("acme");
  f.oats(["status", "--server", "nope", "--json"], { cwd: acme });
  f.oats(["version", "--json"], { cwd: acme });
  f.oats(["status", "--help"], { cwd: acme });
  f.oats(["deployments", "--help"], { cwd: acme });
  assert.equal(existsSync(f.file), false, "nothing listed acme, and nothing touched the list");
  // A broken list: the command answers as it would, and the list is left alone.
  const g = fixture(t, { outside: true });
  const beta = g.deployment("beta");
  const clean = g.oats(["doctor", "--json"], { cwd: beta });
  rmSync(g.oatsHome, { recursive: true, force: true });
  g.seed("not json\n");
  const broken = g.oats(["doctor", "--json"], { cwd: beta });
  assert.equal(broken.status, clean.status);
  assert.equal(broken.stdout, clean.stdout);
  assert.equal(broken.stderr, clean.stderr);
  assert.equal(readFileSync(g.file, "utf8"), "not json\n");
});

test("auto-add: never for `oats instance suggest-name`, which records nothing (#1490 §2), though it reads the deployment's launch configurations; a command that reads the same file lists it", { skip: OUTSIDE ?? false }, (t) => {
  const f = fixture(t, { outside: true });
  const acme = f.deployment("acme");
  const r = f.ok(["instance", "suggest-name", "--soul", "dev", "--task", ""], { cwd: acme });
  assert.equal(r.naming.reason, "no-task");
  f.ok(["instance", "suggest-name", "--soul", "dev", "--task", "", "--dir", acme]);
  assert.equal(existsSync(f.file), false, "nothing listed acme, and nothing touched the list");
  f.ok(["launch-config", "list"], { cwd: acme });
  assert.deepEqual(f.stored().deployments.map((d) => d.path), [acme], "premise: a command that reads its oats-local.yaml lists it");
});

test("auto-add: a tombstoned deployment is not listed again by a plain command; an explicit add clears it", { skip: OUTSIDE ?? false }, (t) => {
  const f = fixture(t, { outside: true });
  const acme = f.deployment("acme");
  f.ok(["deployments", "add", acme]);
  f.ok(["deployments", "remove", acme]);
  const ino = statSync(f.file).ino;
  f.oats(["doctor", "--json"], { cwd: acme });
  assert.equal(statSync(f.file).ino, ino, "the tombstone is found lock-free, and nothing is written");
  assert.deepEqual(f.ok(["deployments"]).deployments, []);
  f.ok(["deployments", "add", acme]);
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [acme]);
});

test("auto-add budget: a listed deployment costs one read: no lock, no write, the file's mtime unchanged; a held lock does not delay an unlisted one", { skip: OUTSIDE ?? (ROOT && "root writes anywhere") }, (t) => {
  const f = fixture(t, { outside: true });
  const acme = f.deployment("acme"); mkdirSync(join(acme, "agents"));
  f.oats(["status", "--json"], { cwd: acme });
  const before = statSync(f.file);
  // The config directory refuses a new entry: a lock directory or a private file could not be made.
  chmodSync(join(f.oatsHome, "config"), 0o500);
  const listed = f.oats(["status", "--json"], { cwd: acme });
  assert.equal(listed.status, 0, listed.stderr);
  chmodSync(join(f.oatsHome, "config"), 0o700);
  const after = statSync(f.file);
  assert.equal(after.mtimeMs, before.mtimeMs, "the file's mtime is unchanged");
  assert.equal(after.ino, before.ino, "the file was not replaced");
  assert.equal(existsSync(f.lock), false, "no lock");
  // A held lock: an unlisted deployment's command does not wait for it, and lists nothing.
  const beta = f.deployment("beta"); mkdirSync(join(beta, "agents"));
  const free = Date.now(); f.oats(["doctor", "--json"], { cwd: f.deployment("gamma") }); const baseline = Date.now() - free;
  const release = f.holdLock(); t.after(release);
  const started = Date.now();
  const busy = f.oats(["status", "--json"], { cwd: beta });
  assert.equal(busy.status, 0, busy.stderr);
  assert.ok(Date.now() - started < baseline + 1500, `a held lock does not delay the command (${Date.now() - started} ms; a run with the lock free: ${baseline} ms)`);
  release();
  assert.equal(f.ok(["deployments"]).deployments.some((row) => row.path === beta), false, "busy: skipped, the next command tries again");
  f.oats(["status", "--json"], { cwd: beta });
  assert.equal(f.ok(["deployments"]).deployments.some((row) => row.path === beta), true);
});

/** Run `fn` with this process's HOME and OATS_HOME_DIR set to the fixture's (and no PI_AGENTS_ROOT),
 *  then put them back. */
async function inProcess(f, fn) {
  const saved = { HOME: process.env.HOME, OATS_HOME_DIR: process.env.OATS_HOME_DIR, PI_AGENTS_ROOT: process.env.PI_AGENTS_ROOT };
  Object.assign(process.env, { HOME: f.home, OATS_HOME_DIR: f.oatsHome });
  delete process.env.PI_AGENTS_ROOT;
  try { return await fn(await import(LIB)); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("auto-add: a listed deployment is answered from the read alone (no process, no lock, no write); only an unlisted one takes the lock, without waiting", { skip: OUTSIDE ?? false }, async (t) => {
  const f = fixture(t, { outside: true });
  const acme = f.deployment("acme");
  const beta = f.deployment("beta");
  f.ok(["deployments", "add", acme]);
  const release = f.holdLock();
  t.after(release);
  // Every call that would be a process, a lock, a write or a realpath is counted while the listed
  // deployment is answered (realpathSync.native too: the canonical spelling uses it).
  const calls = [];
  const originals = [];
  const count = (mod, name, wrap = (f) => f) => {
    const original = mod[name];
    originals.push([mod, name, original]);
    mod[name] = wrap(function (...args) { calls.push(name); return original.apply(this, args); });
  };
  const restore = () => { for (const [mod, name, original] of originals.splice(0).reverse()) mod[name] = original; syncBuiltinESMExports(); };
  t.after(restore);
  await inProcess(f, ({ listResolved }) => {
    for (const name of ["execFileSync", "execSync", "spawnSync", "spawn", "execFile"]) count(childProcess, name);
    for (const name of ["mkdirSync", "writeFileSync", "renameSync", "openSync", "rmSync"]) count(fs, name);
    const native = fs.realpathSync.native;
    count(fs, "realpathSync", (f) => Object.assign(f, { native(...args) { calls.push("realpathSync.native"); return native.apply(this, args); } }));
    syncBuiltinESMExports();
    try {
      assert.equal(listResolved(acme), "listed", "a listed deployment is answered while another process holds the lock");
      assert.deepEqual(calls.filter((c) => c !== "openSync"), [], "no process, no lock, no write, no realpath");
      assert.deepEqual(calls, ["openSync"], "one open: the list's bounded read");
    } finally { restore(); }
    const started = Date.now();
    assert.equal(listResolved(beta), "skipped", "an unlisted one needs the lock, and gives up at once while it is held");
    assert.ok(Date.now() - started < 2000);
  });
  release();
  await inProcess(f, ({ listResolved }) => {
    assert.equal(listResolved(beta), "added");
    assert.equal(listResolved(beta), "listed");
    assert.equal(listResolved(join(f.base, "outside")), "skipped", "no oats-local.yaml: not a deployment");
  });
});

test("auto-add budget through the resolvers: a listed deployment in a linked worktree is checked against the canonical root the command resolved, with no process or realpath of its own", async (t) => {
  const f = fixture(t);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const main = join(f.base, "acme"); mkdirSync(main);
  writeFileSync(join(main, "README"), "x\n");
  git(main, "init", "-q"); git(main, "add", "."); git(main, "commit", "-q", "-m", "init");
  const linked = join(f.base, "acme-linked");
  git(main, "worktree", "add", "-q", linked, "-b", "side");
  for (const d of [main, linked]) { writeFileSync(join(d, "oats-local.yaml"), LOCAL_YAML); mkdirSync(join(d, "agents")); }
  f.ok(["deployments", "add", main]);
  const before = statSync(f.file);
  const { loadLocal } = await import(new URL("../lib/workspace.mjs", import.meta.url).href);
  const { ensureRoot } = await import(new URL("../lib/core.mjs", import.meta.url).href);
  const { observeResolvedDeployment, settleResolvedDeployment } = await import(new URL("../lib/resolved-deployment.mjs", import.meta.url).href);
  const calls = [], originals = [];
  const restore = () => { for (const [mod, name, original] of originals.splice(0).reverse()) mod[name] = original; syncBuiltinESMExports(); };
  t.after(restore);
  await inProcess(f, async ({ listResolved }) => {
    const seen = [];
    observeResolvedDeployment((root) => { seen.push(root); return listResolved(root); });
    // spawn's order: the local file first (as spelled), then the canonical agents root.
    loadLocal(linked);
    assert.equal(ensureRoot(linked), join(main, "agents"));
    const count = (mod, name, wrap = (fn) => fn) => {
      const original = mod[name];
      originals.push([mod, name, original]);
      mod[name] = wrap(function (...args) { calls.push(name); return original.apply(this, args); });
    };
    for (const name of ["execFileSync", "execSync", "spawnSync", "spawn", "execFile"]) count(childProcess, name);
    for (const name of ["mkdirSync", "writeFileSync", "renameSync", "openSync", "rmSync"]) count(fs, name);
    const native = fs.realpathSync.native;
    count(fs, "realpathSync", (fn) => Object.assign(fn, { native(...args) { calls.push("realpathSync.native"); return native.apply(this, args); } }));
    syncBuiltinESMExports();
    try { settleResolvedDeployment(); } finally { restore(); }
    assert.deepEqual(seen, [main], "the observer is given the canonical root, once");
    assert.deepEqual(calls, ["openSync"], "one open, the list's bounded read: no process, no realpath, no lock, no write");
  });
  assert.equal(statSync(f.file).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [main]);
});

/** Count, from `start()` until `restore()`, every call that would be a process, a lock, a write or a
 *  realpath (realpathSync.native too: the canonical spelling uses it); openSync is the list's read. */
function counted(t) {
  const calls = [], originals = [];
  const count = (mod, name, wrap = (fn) => fn) => {
    const original = mod[name];
    originals.push([mod, name, original]);
    mod[name] = wrap(function (...args) { calls.push(name); return original.apply(this, args); });
  };
  const restore = () => { for (const [mod, name, original] of originals.splice(0).reverse()) mod[name] = original; syncBuiltinESMExports(); };
  t.after(restore);
  const start = () => {
    for (const name of ["execFileSync", "execSync", "spawnSync", "spawn", "execFile"]) count(childProcess, name);
    for (const name of ["mkdirSync", "writeFileSync", "renameSync", "openSync", "rmSync"]) count(fs, name);
    const native = fs.realpathSync.native;
    count(fs, "realpathSync", (fn) => Object.assign(fn, { native(...args) { calls.push("realpathSync.native"); return native.apply(this, args); } }));
    syncBuiltinESMExports();
  };
  return { calls, start, restore };
}

/** What a command that only reads the local file (loadLocal: sync, doctor and the other configuration
 *  commands) makes of `dir`: the observer's answer, and the calls it made, counted. */
async function settledFromLoadLocal(t, f, dir) {
  const { loadLocal } = await import(new URL("../lib/workspace.mjs", import.meta.url).href);
  const { observeResolvedDeployment, settleResolvedDeployment } = await import(new URL("../lib/resolved-deployment.mjs", import.meta.url).href);
  const { calls, start, restore } = counted(t);
  return inProcess(f, ({ listResolved }) => {
    const seen = [];
    observeResolvedDeployment((root, opts) => { seen.push({ root, ...opts, answer: listResolved(root, opts) }); });
    loadLocal(dir);
    start();
    try { settleResolvedDeployment(); } finally { restore(); }
    return { seen, calls };
  });
}

test("auto-add boundary: a deployment in a linked Git worktree is listed by the commands that resolve its instance root, not by a command that only reads its local file (no process, no write)", { skip: OUTSIDE ?? false }, async (t) => {
  const f = fixture(t, { outside: true });
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const main = join(f.base, "acme"); mkdirSync(join(main, "nested"), { recursive: true });
  writeFileSync(join(main, "nested", "README"), "x\n");
  git(main, "init", "-q"); git(main, "add", "."); git(main, "commit", "-q", "-m", "init");
  const linked = join(f.base, "acme-linked");
  git(main, "worktree", "add", "-q", linked, "-b", "side");
  for (const d of [main, linked]) { writeFileSync(join(d, "oats-local.yaml"), LOCAL_YAML); mkdirSync(join(d, "agents")); }
  writeFileSync(join(linked, "nested", "oats-local.yaml"), LOCAL_YAML);
  f.seed(MARKED());
  const before = statSync(f.file);
  // Unlisted: at the worktree's root and below it, the check stops at the `.git` file.
  for (const dir of [linked, join(linked, "nested")]) {
    const { seen, calls } = await settledFromLoadLocal(t, f, dir);
    assert.deepEqual(seen, [{ root: dir, canonical: false, answer: "skipped" }], dir);
    assert.deepEqual(calls, ["openSync"], `${dir}: the list's read alone: no process, no realpath, no lock, no write`);
  }
  // Through the CLI: doctor lists nothing; status (ensureRoot's canonical root) lists the primary checkout.
  f.oats(["doctor", "--json"], { cwd: linked });
  assert.equal(statSync(f.file).mtimeMs, before.mtimeMs, "a loadLocal-only command in a linked worktree writes nothing");
  f.oats(["status", "--json"], { cwd: linked });
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => [d.path, d.via]), [[main, "cli"]]);
  // Listed (at the primary checkout): the same, with no process and no write.
  const listed = statSync(f.file);
  const { seen, calls } = await settledFromLoadLocal(t, f, linked);
  assert.deepEqual(seen, [{ root: linked, canonical: false, answer: "skipped" }]);
  assert.deepEqual(calls, ["openSync"]);
  assert.equal(statSync(f.file).mtimeMs, listed.mtimeMs);
});

test("auto-add budget: another spelling of a listed deployment (a link) costs one realpath at most, never a process, in a Git repository or out of one", async (t) => {
  const f = fixture(t);
  const git = (cwd, ...args) => execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: f.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const plain = f.deployment("plain");
  const repo = f.deployment("repo");
  git(repo, "init", "-q");
  for (const d of [plain, repo]) {
    f.ok(["deployments", "add", d]);
    symlinkSync(d, `${d}-link`);
  }
  const before = statSync(f.file);
  for (const d of [plain, repo]) {
    const { seen, calls } = await settledFromLoadLocal(t, f, `${d}-link`);
    assert.deepEqual(seen, [{ root: `${d}-link`, canonical: false, answer: "listed" }], d);
    assert.deepEqual(calls, ["openSync", "realpathSync.native"], `${d}: the list's read and one realpath: no process, no lock, no write`);
  }
  assert.equal(statSync(f.file).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [plain, repo]);
});

// ---------------------------------------------------------------- the temporary directories (#1397)

test("auto-add: a deployment under a temporary directory is never listed by a plain command, which writes nothing; an explicit add, a client's add --via and the Desktop import still list one", (t) => {
  const f = fixture(t); // under the temporary directory, as a test's fixtures are
  const acme = f.deployment("acme");
  mkdirSync(join(acme, "agents"));
  f.oats(["doctor", "--json"], { cwd: acme }); // loadLocal's spelled root
  f.oats(["status", "--json"], { cwd: join(acme, "agents") }); // ensureRoot's canonical root
  f.oats(["launch-config", "list", "--dir", acme, "--json"]);
  assert.equal(existsSync(f.file), false, "no command listed it, nor took the lock, nor ran the first-use import");
  assert.equal(existsSync(f.lock), false);
  // onboard lists one too (test/onboard.test.mjs: its deployments are under the temporary directory).
  assert.deepEqual(f.ok(["deployments", "add", acme]), { path: acme, added: true });
  const beta = f.deployment("beta");
  assert.equal(f.ok(["deployments", "add", beta, "--via", "tui"]).added, true);
  const gamma = f.deployment("gamma");
  assert.deepEqual(f.ok(["deployments", "import", "--from", "desktop", gamma]).added, [gamma]);
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => [d.path, d.via]), [[acme, "cli"], [beta, "tui"], [gamma, "import:desktop"]]);
});

test("auto-add: the temporary directories are compared after realpath: a link from outside to a deployment under one is not listed; a link under one to a deployment outside is, at its real path", { skip: OUTSIDE ?? false }, (t) => {
  const inside = fixture(t);
  const f = fixture(t, { outside: true });
  const tmpDeployment = inside.deployment("acme");
  symlinkSync(tmpDeployment, join(f.base, "to-tmp"));
  f.oats(["doctor", join(f.base, "to-tmp"), "--json"]);
  assert.equal(existsSync(f.file), false, "its realpath is under the temporary directory");
  const real = f.deployment("beta");
  symlinkSync(real, join(inside.base, "to-outside"));
  f.oats(["doctor", join(inside.base, "to-outside"), "--json"]);
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => [d.path, d.via]), [[real, "cli"]]);
});

test("auto-add budget: a listed deployment under a temporary directory is answered by the read before any temporary-directory check (no realpath); an unlisted one is skipped with no process, lock or write", async (t) => {
  const f = fixture(t);
  const acme = f.deployment("acme");
  const beta = f.deployment("beta");
  f.ok(["deployments", "add", acme]);
  const before = statSync(f.file);
  const { calls, start, restore } = counted(t);
  await inProcess(f, ({ listResolved }) => {
    start();
    try { assert.equal(listResolved(acme), "listed"); } finally { restore(); }
    assert.deepEqual(calls.splice(0), ["openSync"], "the list's read alone");
    start();
    try { assert.equal(listResolved(beta), "skipped"); assert.equal(listResolved(beta, { canonical: true }), "skipped"); } finally { restore(); }
    assert.deepEqual(calls.filter((c) => c !== "openSync" && c !== "realpathSync.native"), [], "no process, no lock, no write");
  });
  assert.equal(statSync(f.file).mtimeMs, before.mtimeMs);
  assert.deepEqual(f.ok(["deployments"]).deployments.map((d) => d.path), [acme]);
});
