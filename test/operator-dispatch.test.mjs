// lib/operator-dispatch.mjs + bin/oats.mjs capabilityCommand — operator-level
// capability commands from a DEPLOYMENT directory (post-0.25.0 fix B3).
//
// Contract (docs/design/2026-09-23-workspace-module-contracts.md, "Post-0.25.0
// clarifications"): outside an instance home, `oats <ns> <cmd> --soul <x>` resolves
// exactly as `oats spawn <x>` would (prepareInstance → Resolution), fetches the
// namespace's capability into <deployment>/.oats/modules/<cap>@<commit12>/ and
// dispatches to that copy with the soul's merged payload as OATS_SETTINGS.
//
// Regression pinned: 0.25.0 answered E_UNKNOWN_COMMAND / E_CAPABILITY_INACTIVE
// there (the non-home branch read the v1 config chain), so `oats okf init` could
// not provision the accepted base a soul's required spawn hook demands.
//
// The CLI test uses the REAL oats.okf package (the git payload the release mirrors)
// pinned in a local workspace, the pattern of scripts/clean-room-smoke.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deploymentOf, ensureModuleTree, moduleRef, moduleStoreDir, resolveOperatorDispatch } from "../lib/operator-dispatch.mjs";
import { MODULES_DIR } from "../lib/materialize.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { materializeOkfGitPayload } from "../scripts/check-okf-mirror.mjs";
import { privateTmuxTmpdir, removeTmuxTmpdir } from "./helpers/host-fixture.mjs";
import { inertHarnessPath } from "./helpers/runtime-stub.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OATS = join(REPO_ROOT, "bin/oats.mjs");
const OID = (seed) => seed.repeat(40).slice(0, 40);

/* ───────────────────────────── unit: the pure helpers ──────────────────── */

test("deploymentOf: null when no oats-local.yaml is in reach; the loadLocal result when it is", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opd-")));
  try {
    assert.equal(deploymentOf(base), null);
    writeFileSync(join(base, "oats-local.yaml"), "schemaVersion: 2\nworkspace: git:example.com/org/ws\n");
    mkdirSync(join(base, "deep", "er"), { recursive: true });
    const found = deploymentOf(join(base, "deep", "er"));
    assert.equal(found.path, join(base, "oats-local.yaml"));
    assert.equal(found.local.workspace, "git:example.com/org/ws");
    // A malformed file is a loud schema error, not "no deployment" (a fallback to
    // the v1 chain would hide a typo in the operator's own file).
    writeFileSync(join(base, "oats-local.yaml"), "schemaVersion: 1\n");
    assert.throws(() => deploymentOf(base), (e) => e.code === "E_WORKSPACE_SCHEMA");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("moduleRef: member → repoKey as a remote ref (local/<abs> → abs path; else git:<key>); package → packageRef over the lock", () => {
  assert.equal(moduleRef({ name: "x", from: { kind: "member", repoKey: "local//tmp/r.git", commit: OID("a") } }, null), "/tmp/r.git");
  assert.equal(moduleRef({ name: "x", from: { kind: "member", repoKey: "github.com/org/repo", commit: OID("a") } }, null), "git:github.com/org/repo");
  const lock = { lockfileVersion: 3, packages: { "oats.okf": { source: "catalog:oats.okf", url: "https://github.com/org/okf.git", path: "oats-package", version: "v2.1.3", commit: OID("b") } } };
  assert.equal(moduleRef({ name: "oats.okf", from: { kind: "package", package: "oats.okf", commit: OID("b") } }, lock), "https://github.com/org/okf.git");
  assert.equal(moduleRef({ name: "nw-lint", from: { kind: "package", package: "nw.tools", commit: OID("c") } }, { packages: { "nw.tools": { source: "git:github.com/nw/tools@v0.4.0", path: "oats-package", commit: OID("c") } } }), "git:github.com/nw/tools");
  assert.throws(() => moduleRef({ name: "gone", from: { kind: "package", package: "nope", commit: OID("d") } }, lock), (e) => e.code === "E_PACKAGE_MISSING");
  assert.throws(() => moduleRef({ name: "odd", from: { kind: "installed" } }, lock), (e) => e.code === "E_CAPABILITY_BROKEN");
});

test("moduleStoreDir mirrors resolvePackageCapabilityAgent's layout: <deployment>/.oats/modules/<cap>@<commit12>", () => {
  assert.equal(moduleStoreDir("/dep", { name: "oats.okf", from: { commit: OID("f") } }), join("/dep", MODULES_DIR, `oats.okf@${"f".repeat(12)}`));
});

test("ensureModuleTree: fetches once through a staging dir, reuses an existing tree, never leaves a half tree", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opd-")));
  try {
    const module = { name: "cap", dir: "capabilities/cap", from: { kind: "member", repoKey: "local//tmp/r.git", commit: OID("1") } };
    const calls = [];
    const fetch = async (ref, commit, dir, dest, options) => {
      calls.push({ ref, commit, dir, dest, allowSymlinks: typeof options.allowSymlinks === "function" });
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "oats.json"), JSON.stringify({ capability: "cap", command: "cap", commands: { go: "bin/go.mjs" } }));
    };
    const dir = await ensureModuleTree(base, module, null, { fetch });
    assert.equal(dir, moduleStoreDir(base, module));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ref, "/tmp/r.git"); assert.equal(calls[0].dir, "capabilities/cap"); assert.ok(calls[0].allowSymlinks, "the CLAUDE.md alias predicate is passed");
    assert.notEqual(calls[0].dest, dir, "fetch lands in staging, not the final dir");
    assert.ok(existsSync(join(dir, "oats.json")));
    assert.equal(await ensureModuleTree(base, module, null, { fetch }), dir);
    assert.equal(calls.length, 1, "an existing tree at the same commit is reused, not refetched");
    assert.deepEqual(readdirSync(join(base, MODULES_DIR)).filter((n) => n.startsWith(".staging")), [], "no staging leftovers");
    // A fetch that yields no manifest is E_CAPABILITY_BROKEN and leaves nothing behind.
    const broken = { ...module, name: "empty" };
    await assert.rejects(ensureModuleTree(base, broken, null, { fetch: async (_r, _c, _d, dest) => { mkdirSync(dest, { recursive: true }); } }), (e) => e.code === "E_CAPABILITY_BROKEN");
    assert.ok(!existsSync(moduleStoreDir(base, broken)));
    assert.deepEqual(readdirSync(join(base, MODULES_DIR)).filter((n) => n.startsWith(".staging")), []);
    // A failing fetch propagates untouched.
    await assert.rejects(ensureModuleTree(base, { ...module, name: "fail" }, null, { fetch: async () => { const e = new Error("unreadable"); e.code = "E_REMOTE_UNREADABLE"; throw e; } }), (e) => e.code === "E_REMOTE_UNREADABLE");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("ensureModuleTree verifies the resolution's content digest: a drifted store tree is re-materialized, a mismatching fetch refused", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opd-")));
  try {
    const good = (dest) => { mkdirSync(join(dest, "bin"), { recursive: true }); writeFileSync(join(dest, "oats.json"), JSON.stringify({ capability: "cap", command: "cap", commands: { go: "bin/go.mjs" } })); writeFileSync(join(dest, "bin", "go.mjs"), "console.log('locked');\n"); };
    const ref = join(base, "reference"); good(ref);
    const module = { name: "cap", dir: "capabilities/cap", digest: contentDigest(ref), from: { kind: "member", repoKey: "local//tmp/r.git", commit: OID("2") } };
    let calls = 0;
    const fetch = async (_r, _c, _d, dest) => { calls++; good(dest); };
    const dir = await ensureModuleTree(base, module, null, { fetch });
    assert.equal(await ensureModuleTree(base, module, null, { fetch }), dir); assert.equal(calls, 1, "a matching tree is reused");
    writeFileSync(join(dir, "bin", "go.mjs"), "console.log('tampered');\n");
    assert.equal(await ensureModuleTree(base, module, null, { fetch }), dir);
    assert.equal(calls, 2, "a drifted tree is fetched again, never handed out");
    assert.equal(readFileSync(join(dir, "bin", "go.mjs"), "utf8"), "console.log('locked');\n");
    // Without a pinned digest, the reference is the digest the fetch read at the commit, recorded
    // beside the tree; a tree with no record (or a drifted one) is fetched again.
    const unpinned = { ...module, name: "unpinned", digest: undefined };
    const udir = await ensureModuleTree(base, unpinned, null, { fetch }); assert.equal(calls, 3);
    assert.equal(readFileSync(join(base, MODULES_DIR, `.${basename(udir)}.digest`), "utf8").trim(), module.digest, "the verified fetch digest is recorded");
    await ensureModuleTree(base, unpinned, null, { fetch }); assert.equal(calls, 3, "a tree matching its record is reused");
    writeFileSync(join(udir, "bin", "go.mjs"), "console.log('tampered');\n");
    await ensureModuleTree(base, unpinned, null, { fetch }); assert.equal(calls, 4, "a drifted tree is fetched again");
    rmSync(join(base, MODULES_DIR, `.${basename(udir)}.digest`));
    await ensureModuleTree(base, unpinned, null, { fetch }); assert.equal(calls, 5, "an unrecorded tree is never trusted");
    // A fetch whose written content differs from what it reports reading is refused.
    await assert.rejects(ensureModuleTree(base, { ...unpinned, name: "liar" }, null, { fetch: async (_r, _c, _d, dest) => { good(dest); return { digest: "sha256-" + "0".repeat(64) }; } }),
      (e) => e.code === "E_PACKAGE_INTEGRITY");
    // A fetch whose content does not match the resolution is refused and leaves nothing behind.
    const other = { ...module, name: "other" };
    await assert.rejects(ensureModuleTree(base, other, null, { fetch: async (_r, _c, _d, dest) => { good(dest); writeFileSync(join(dest, "extra.txt"), "x"); } }),
      (e) => e.code === "E_PACKAGE_INTEGRITY" && e.details?.expected === module.digest);
    assert.ok(!existsSync(moduleStoreDir(base, other)));
    assert.deepEqual(readdirSync(join(base, MODULES_DIR)).filter((n) => n.startsWith(".staging")), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("resolveOperatorDispatch: a --soul without a name refused; namespace matched against the soul's Resolution; duplicates refused; payload is the settings", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "opd-")));
  try {
    writeFileSync(join(base, "oats-local.yaml"), "schemaVersion: 2\nworkspace: git:example.com/org/ws\n");
    // An absent --soul is the default-soul path (test/operator-default-soul.test.mjs); a --soul given
    // without a name is refused before any soul is prepared.
    for (const soul of [true, "", "  "]) {
      await assert.rejects(resolveOperatorDispatch(base, "okf", soul, { prepare: async () => { throw new Error("must not be called"); } }), (e) => e.code === "E_BAD_ARGS" && /--soul/.test(e.message) && e.details.flag === "--soul");
    }
    const modules = [
      { name: "oats.okf", dir: "capabilities/oats-okf", from: { kind: "package", package: "oats.okf", commit: OID("a") }, manifest: { capability: "oats.okf", command: "okf", commands: { init: "bin/x.mjs init" } } },
      { name: "quiet", dir: "capabilities/quiet", from: { kind: "member", repoKey: "example.com/org/ws", commit: OID("b") }, manifest: { capability: "quiet", command: "quiet" } }, // no commands → not a namespace
    ];
    const seen = [];
    const prepare = async (dir, soul, opts) => { seen.push({ dir, soul, opts }); return { deployment: base, lock: null, remoteOptions: opts.remoteOptions, resolution: { soul: { name: soul, team: "eng" }, modules, payloads: { "oats.okf": { "bindings-file": "/abs/b.json" } } } }; };
    const hit = await resolveOperatorDispatch(base, "okf", "probe", { prepare, remoteOptions: { cacheDir: "/c" } });
    assert.equal(seen[0].dir, base); assert.equal(seen[0].soul, "probe"); assert.deepEqual(seen[0].opts.remoteOptions, { cacheDir: "/c" });
    assert.equal(hit.module.name, "oats.okf");
    assert.deepEqual(hit.commands, { init: "bin/x.mjs init" });
    assert.deepEqual(hit.settings, { "bindings-file": "/abs/b.json" });
    assert.equal(hit.soul.team, "eng");
    assert.equal(hit.deployment, base);
    assert.equal(await resolveOperatorDispatch(base, "quiet", "probe", { prepare }), null, "a module without commands claims no namespace");
    assert.equal(await resolveOperatorDispatch(base, "nope", "probe", { prepare }), null);
    const dup = async () => ({ deployment: base, lock: null, resolution: { soul: {}, modules: [modules[0], { ...modules[0], name: "other" }], payloads: {} } });
    await assert.rejects(resolveOperatorDispatch(base, "okf", "probe", { prepare: dup }), (e) => e.code === "E_DUPLICATE_NAMESPACE" && e.details.modules.length === 2);
    // Whatever prepareInstance throws propagates untouched (the CLI maps E_* to the envelope).
    await assert.rejects(resolveOperatorDispatch(base, "okf", "ghost", { prepare: async () => { const e = new Error("no soul"); e.code = "E_SOUL_UNKNOWN"; throw e; } }), (e) => e.code === "E_SOUL_UNKNOWN");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

/* ───────────────────── CLI: the real oats.okf package, end to end ─────────── */

test("oats okf init --soul probe from the deployment (no home) provisions the base through the store copy; spawn then succeeds", { timeout: 120_000 }, async (t) => {
  const room = realpathSync(mkdtempSync(join(tmpdir(), "opd-cli-")));
  // The CLI asks tmux for its sessions (status, spawn): in a directory of this test, never at tmux's
  // default place, where a host's live deployment has its server.
  const tmuxTmpdir = privateTmuxTmpdir();
  t.after(() => removeTmuxTmpdir(tmuxTmpdir));
  try {
    const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: "utf8", ...opts }).trim();
    const git = (dir, ...a) => sh("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
    // The official OKF package repo (the exact payload the release mirrors), tagged.
    const official = join(room, "official"), inventory = materializeOkfGitPayload(join(official, "oats-package"), { repoRoot: REPO_ROOT });
    const tag = `v${inventory.version}`;
    sh("git", ["init", "-q", official]); git(official, "add", "-A"); git(official, "commit", "-qm", "okf"); git(official, "tag", tag);
    // A host workspace that is also its one member, carrying the probe soul.
    const host = join(room, "host"); mkdirSync(join(host, "souls", "probe"), { recursive: true });
    sh("git", ["init", "-q", host]);
    const hostRef = pathToFileURL(host).href;
    writeFileSync(join(host, "oats-workspace.yaml"), `schemaVersion: 2\nname: opd\nmembers:\n  - ${hostRef}\npackages:\n  oats.okf: ${tag}\nteams:\n  global: { description: all }\ndefaults:\n  knowledge:\n    oats.okf: { from: package }\n`);
    writeFileSync(join(host, "oats-membership.yaml"), `schemaVersion: 2\nworkspace: ${hostRef}\n`);
    writeFileSync(join(host, "souls/probe/soul.yaml"), "schemaVersion: 2\nname: probe\ndescription: probe\nwork: directory\n");
    writeFileSync(join(host, "souls/probe/AGENTS.md"), "# Probe\n\nCanonical instructions.\n");
    writeFileSync(join(host, "souls/probe/okf.json"), JSON.stringify({ version: 1, owner: "opd-owner", owns: ["project/expert"], reads: [] }));
    git(host, "add", "-A"); git(host, "commit", "-qm", "host");
    // The deployment: oats-local.yaml with the soul's oats.okf settings (bindings-file).
    const dep = join(room, "dep"); mkdirSync(join(dep, "agents"), { recursive: true });
    const accepted = join(room, "accepted"); const bindings = join(room, "okf-bindings.json");
    writeFileSync(bindings, JSON.stringify({ version: 1, stateDir: join(room, "okf-state"), bases: { project: { id: "opd-base", kind: "directory", path: accepted } } }));
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${hostRef}\nsettings:\n  oats.okf:\n    bindings-file: ${bindings}\n`); // no legacy host harvest setting in 5.0
    const catalog = join(room, "catalog.json"); writeFileSync(catalog, JSON.stringify({ packages: { "oats.okf": { url: pathToFileURL(official).href, ref: tag, path: "oats-package" } } }));
    const home = join(room, "home"); mkdirSync(home);
    const env = { ...process.env, PATH: inertHarnessPath(room), OATS_PACKAGE_CATALOG: catalog, OATS_REMOTE_CACHE: join(room, "cache"), OATS_TMUX_SESSION: `none-${process.pid}`, HOME: home, TMUX_TMPDIR: tmuxTmpdir };
    delete env.PI_AGENT_HOME; delete env.OATS_HOME; delete env.OATS_INSTANCE_HOME; delete env.OATS_INSTANCE;
    const run = (a, cwd = dep) => { const r = spawnSync(process.execPath, [OATS, ...a], { env, cwd, encoding: "utf8" }); const last = r.stdout.trim().split("\n").pop() ?? ""; let json = null; try { json = JSON.parse(last); } catch { /* text */ } return { code: r.status, json, out: r.stdout, err: r.stderr }; };

    // sync locks the package (commit + integrity); declaring it in packages: is the trust decision.
    let r = run(["sync", "--dir", dep, "--json"]);
    assert.equal(r.code, 0, r.out + r.err); assert.ok(r.json?.ok, r.out + r.err);
    const lockPath = join(dep, "oats-lock.json"); const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const nodes = join(room, "nodes.json"); writeFileSync(nodes, JSON.stringify({ expert: { path: "expert", owner: "opd-owner" } }));

    // --help answers from the manifest without fetching or running anything.
    r = run(["okf", "--help", "--soul", "probe", "--json"]);
    assert.equal(r.code, 0, r.out + r.err); assert.equal(r.json.result.capability, "oats.okf"); assert.equal(r.json.result.namespace, "okf");
    assert.ok(r.json.result.commands.includes("init") && r.json.result.commands.includes("migrate") && r.json.result.commands.includes("run-source"));
    assert.ok(!existsSync(join(dep, MODULES_DIR)), "help does not fetch the module tree");

    // Without --soul: the deployment's first okf-providing soul (its only one, probe) runs it, said on
    // stderr in both modes; the provider then answers for itself (no base was named).
    r = run(["okf", "init", "--json"]);
    assert.match(r.err, /oats okf: using the settings and teams of soul [\w.-]+\/probe,/, r.err);
    assert.notEqual(r.json?.error?.details?.flag, "--soul", "not the kernel's --soul refusal");
    r = run(["okf", "init"]);
    assert.match(r.err, /using the settings and teams of soul [\w.-]+\/probe,/);

    // A namespace no module of the soul's resolution provides → E_UNKNOWN_COMMAND.
    r = run(["zzz", "init", "--soul", "probe", "--json"]);
    assert.equal(r.code, 1); assert.equal(r.json?.error?.code, "E_UNKNOWN_COMMAND", r.out);
    // An unknown soul → E_SOUL_UNKNOWN through the same envelope.
    r = run(["okf", "init", "--soul", "ghost", "--json"]);
    assert.equal(r.code, 1); assert.equal(r.json?.error?.code, "E_SOUL_UNKNOWN", r.out);

    // The real thing: init before any instance exists — accepted.
    r = run(["okf", "init", "--base", "project", "--nodes", nodes, "--confirm", "--soul", "probe", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.json?.ok, true); assert.equal(r.json.result.status, "accepted");
    assert.ok(existsSync(join(accepted, "okf-base.json")), "the accepted base exists");
    assert.ok(existsSync(join(accepted, "expert", "index.md")), "the declared node was created");
    // The store copy: <deployment>/.oats/modules/oats.okf@<commit12>/ — the same layout capability-defined agents use.
    const store = readdirSync(join(dep, MODULES_DIR)).filter((n) => !n.startsWith("."));
    assert.equal(store.length, 1);
    assert.match(store[0], /^oats\.okf@[0-9a-f]{12}$/);
    assert.equal(store[0].slice("oats.okf@".length), lock.packages["oats.okf"].commit.slice(0, 12));
    const storeDir = join(dep, MODULES_DIR, store[0]);
    assert.ok(existsSync(join(storeDir, "oats.json")) && existsSync(join(storeDir, "bin", "oats-okf.mjs")));
    // oats.okf 4.0.0 ships no capability agents (its harvester is a package soul); the alias fetch rule is pinned in remote.test.mjs.
    assert.ok(!existsSync(join(storeDir, "agents")), "okf 4.0.0 has no agents/");
    assert.deepEqual(readdirSync(join(dep, MODULES_DIR)).filter((n) => n.startsWith(".staging")), []);
    assert.ok(!existsSync(join(dep, "agents", "probe", "instances")), "init ran before any instance existed");

    // Now the spawn: the required spawn hook finds the base.
    r = run(["spawn", "probe", "--dir", dep, "--agents-root", join(dep, "agents"), "--purpose", "opd", "--no-launch", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(r.json?.ok, r.out);
    const meta = JSON.parse(readFileSync(join(r.json.result.home, "instance.json"), "utf8"));
    assert.ok(meta.modules?.["oats.okf"], "the instance materialized oats.okf");
    assert.equal(meta.modules["oats.okf"].commit, lock.packages["oats.okf"].commit);
    // Inside the home the dispatcher still answers from the home's own modules (0.25.0 path).
    const homeEnv = { OATS_INSTANCE: r.json.result.instance, OATS_INSTANCE_HOME: r.json.result.home, PI_AGENT_INSTANCE: r.json.result.instance, PI_AGENT_HOME: r.json.result.home };
    const inside = spawnSync(process.execPath, [OATS, "okf", "inspect", "--json"], { env: { ...env, ...homeEnv }, cwd: r.json.result.home, encoding: "utf8" });
    assert.equal(inside.status, 0, inside.stdout + inside.stderr);
    assert.equal(JSON.parse(inside.stdout.trim().split("\n").pop()).ok, true);
    // A harness that strips the session env (Codex's shared app-server daemon, #342): with no
    // home variable set, the home is recognised from the cwd, the home itself or below it.
    const stripped = spawnSync(process.execPath, [OATS, "okf", "inspect", "--json"], { env, cwd: r.json.result.home, encoding: "utf8" });
    assert.equal(stripped.status, 0, stripped.stdout + stripped.stderr);
    assert.equal(JSON.parse(stripped.stdout.trim().split("\n").pop()).ok, true);
    // Below the home (its work directory) the namespace still comes from the home's modules,
    // without --soul (okf's own commands read the cwd, so the manifest's help answers here).
    const below = spawnSync(process.execPath, [OATS, "okf", "--help", "--json"], { env, cwd: join(r.json.result.home, "work"), encoding: "utf8" });
    assert.equal(below.status, 0, below.stdout + below.stderr);
    assert.equal(JSON.parse(below.stdout.trim().split("\n").pop()).result.capability, "oats.okf");
    // An instance.json outside <agents-root>/<agent>/instances/<name> (or naming another
    // instance) is not a home: the deployment's operator dispatch still answers, as its default soul.
    const notHome = join(dep, "not-a-home"); mkdirSync(notHome);
    writeFileSync(join(notHome, "instance.json"), readFileSync(join(r.json.result.home, "instance.json")));
    const misplaced = run(["okf", "inspect", "--json"], notHome);
    assert.match(misplaced.err, /using the settings and teams of soul [\w.-]+\/probe,/, misplaced.out + misplaced.err);
    const renamed = join(dep, "agents", "probe", "instances", "renamed"); mkdirSync(renamed);
    writeFileSync(join(renamed, "instance.json"), readFileSync(join(r.json.result.home, "instance.json")));
    const misnamed = run(["okf", "inspect", "--json"], renamed);
    assert.match(misnamed.err, /using the settings and teams of soul [\w.-]+\/probe,/, misnamed.out + misnamed.err);

    // A package soul (oats.okf 6.0's knowledge maintainer) homes under
    // <agents-root>/<package>--<soul>/instances/<name>.
    r = run(["spawn", "oats.okf/knowledge-maintainer", "--dir", dep, "--task", "Review knowledge-base PR https://github.com/fixture/knowledge/pull/1 at 0123456789abcdef0123456789abcdef01234567.", "--relation", "unrelated", "--name", "okf-maintainer-opd", "--no-launch", "--json"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(realpathSync(r.json.result.home), join(dep, "agents", "oats-okf--knowledge-maintainer", "instances", "okf-maintainer-opd"));
    // The removed harvester's stub soul refuses through its required spawn hook and keeps no home.
    const proposal = join(dep, "proposal.md");
    writeFileSync(proposal, `# Proposal\n\nSource: instance ${r.json.result.instance}, soul probe\n\nA fixture observation merits review.\n`);
    const refused = run(["spawn", "oats.okf/knowledge-harvester", "--dir", dep, "--task-file", proposal, "--relation", "unrelated", "--name", "okf-harvester-opd", "--no-launch", "--json"]);
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.equal(refused.json?.error?.code, "E_REQUIRED_HOOK_FAILED", refused.out);
    assert.match(refused.json.error.message, /oats-okf-harvest E_REMOVED:/);
    assert.ok(!existsSync(join(dep, "agents", "oats-okf--knowledge-harvester", "instances", "okf-harvester-opd")), "the refused spawn keeps no home");
    assert.ok(!existsSync(join(dep, "local-agents")), "nothing is written under the 0.25 local-agents/ base");

    // A leftover 0.25 local-agents/ dir is ONE status/doctor problem and changes nothing else.
    const statusOf = () => { const s = run(["status", "--dir", dep, "--json"]); assert.equal(s.code, 0, s.out + s.err); return JSON.parse(s.out); };
    const before = statusOf();
    assert.equal(before.problems, undefined);
    mkdirSync(join(dep, "local-agents", "memory-harvest", "instances", "memory-harvest-old"), { recursive: true });
    const after = statusOf();
    assert.deepEqual(after.problems.map((p) => p.code), ["legacy-local-agents"]);
    assert.deepEqual(after.problems[0].instances, ["memory-harvest-old"]);
    assert.match(after.problems[0].message, /^1 instance home under local-agents\/ is from OATS 0\.25 and is not managed by this kernel; retire it with the 0\.25 kernel or delete the directory once it is stopped \(memory-harvest-old\)$/);
    const { problems: _p, ...rest } = after;
    assert.deepEqual(rest, before, "the legacy homes are never read into the roster");
    const doctor = run(["doctor", "--dir", dep, "--json"]);
    assert.equal(doctor.code, 0, doctor.out + doctor.err);
    // Operator coverage (#671) warnings are their own; this pins the legacy-layout problem.
    assert.deepEqual(JSON.parse(doctor.out).problems.map((p) => p.code).filter((c) => !c.startsWith("operator-")), ["legacy-local-agents"]);
  } finally { rmSync(room, { recursive: true, force: true }); }
});
