// Package souls (kernel 0.28.0, docs/design/2026-09-26-okf-knowledge-operations.md §2.2): a package
// manifest may declare `souls: ["souls/<name>"]`, ordinary soul directories versioned and locked
// with the package. The lock records each soul's name and digest; discovery lists them with their
// package origin; they spawn by the qualified name `<package>/<soul>` (or the bare name when it is
// unique); `from: here` in a package soul is its own package at the locked commit.
//
// Real git: one bare member repo (the v2Deployment helper) plus one bare package repo with tags.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import YAML from "yaml";
import { v2Deployment, git, CLI } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";

const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const fails = (r, code, what) => { const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.equal(j.error.code, code, `${what}: ${r.stdout}`); return j.error; };

function fixture({ souls = { dev: {} }, pkgSouls = { keeper: {} }, teams = { global: { description: "Fixture team" } }, local = {}, pkg: pkgOpts = {} } = {}) {
  const pkg = packageRepo({ souls: pkgSouls, ...pkgOpts });
  const fx = v2Deployment({ name: "acme", souls, workspace: { packages: { "acme.pkg": `${pkg.ref}@v1.0.0` }, teams }, local });
  const cleanup = fx.cleanup;
  fx.cleanup = () => { cleanup(); pkg.cleanup(); };
  fx.pkg = pkg;
  return fx;
}
const lockOf = (fx) => JSON.parse(readFileSync(join(fx.dep, "oats-lock.json"), "utf8"));

test("sync locks each package soul (name + digest); souls/workspace status list it with its package origin", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const synced = ok(fx.cli(["sync", "--json"]), "sync");
  const entry = lockOf(fx).packages["acme.pkg"];
  assert.deepEqual(entry.capabilities, ["acme-tool"]);
  assert.equal(entry.commit, fx.pkg.commit1);
  assert.deepEqual(entry.souls.map((s) => s.name), ["keeper"]);
  assert.match(entry.souls[0].digest, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual(synced.packages.find((p) => p.id === "acme.pkg").souls, ["keeper"]);

  const souls = ok(fx.cli(["souls", "--json"]), "souls").souls;
  const row = souls.find((s) => s.name === "keeper");
  assert.deepEqual({ kind: row.kind, package: row.package, version: row.version, commit: row.commit, qualifiedName: row.qualifiedName, origin: row.origin, work: row.work },
    { kind: "package", package: "acme.pkg", version: "1.0.0", commit: fx.pkg.commit1, qualifiedName: "acme.pkg/keeper", origin: "package acme.pkg v1.0.0", work: "directory" });
  assert.equal(row.key, "acme.pkg/keeper", "a package soul's key is its qualified name");
  const text = fx.cli(["souls"]);
  assert.match(text.stdout, /keeper\s+package acme\.pkg v1\.0\.0/);

  const ws = ok(fx.cli(["workspace", "status", "--json"]), "workspace status");
  assert.deepEqual(ws.packages.find((p) => p.id === "acme.pkg").souls, ["keeper"]);
  assert.match(fx.cli(["sync"]).stdout, /souls {6}2 discovered \(1 members, 0 external, 1 package, 0 disabled here\)/);
});

test("spawn by the qualified and the bare name materializes the soul at the locked commit; from: here is its own package; instance.json records the package provenance", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  for (const [name, purpose] of [["acme.pkg/keeper", "q"], ["keeper", "b"]]) {
    const r = ok(fx.cli(["spawn", name, "--purpose", purpose, "--no-launch", "--json"]), `spawn ${name}`);
    assert.equal(r.home, join(fx.root, "acme-pkg--keeper", "instances", `acme-pkg-keeper-${purpose}`));
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const home = r.home;
    assert.equal(meta.agent, "acme-pkg--keeper");
    assert.equal(meta.workspace.soul.name, "keeper");
    assert.equal(meta.workspace.soul.qualifiedName, "acme.pkg/keeper");
    const { id, version, commit, path } = meta.workspace.soul.package;
    assert.deepEqual({ id, version, commit, path }, { id: "acme.pkg", version: "1.0.0", commit: fx.pkg.commit1, path: "oats-package/souls/keeper" });
    assert.equal(meta.workspace.soul.id, "package:acme.pkg#keeper");
    assert.equal(meta.workspace.soul.commit, fx.pkg.commit1);
    assert.equal(meta.modules["acme-tool"].from.kind, "package");
    assert.equal(meta.modules["acme-tool"].from.package, "acme.pkg");
    assert.ok(existsSync(join(home, ".agents", "skills", "tool-skill", "SKILL.md")));
    assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /# keeper \(package 1\.0\.0\)/);
  }
  const status = JSON.parse(fx.cli(["status", "--json"]).stdout);
  const keeper = status.agents.find((a) => a.name === "acme-pkg--keeper");
  assert.equal(keeper.instances.length, 2);
  assert.equal(keeper.key, "acme.pkg/keeper", "the roster agent row carries the soul key (its dir name is acme-pkg--keeper)");
  assert.equal(keeper.instances[0].soul.status, "current", JSON.stringify(keeper.instances[0].soul));
  assert.equal(keeper.instances[0].soul.package, "acme.pkg");
});

test("a bare name shared by a member soul and a package soul is E_SOUL_AMBIGUOUS naming the qualified forms; each qualified form spawns", (t) => {
  const fx = fixture({ souls: { dev: {}, keeper: {} } }); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  const e = fails(fx.cli(["spawn", "keeper", "--no-launch", "--json"]), "E_SOUL_AMBIGUOUS", "bare ambiguous");
  assert.deepEqual([...e.details.qualified].sort(), ["acme.pkg/keeper", "ws/keeper"]);
  assert.match(e.message, /acme\.pkg\/keeper/);
  const pkg = ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "p", "--no-launch", "--json"]), "qualified package");
  const mem = ok(fx.cli(["spawn", "ws/keeper", "--purpose", "m", "--no-launch", "--json"]), "qualified member");
  // Side by side, in distinct agent directories, each attributed to its own source.
  assert.equal(pkg.home, join(fx.root, "acme-pkg--keeper", "instances", "acme-pkg-keeper-p"));
  assert.equal(mem.home, join(fx.root, "keeper", "instances", "keeper-m"));
  const status = JSON.parse(fx.cli(["status", "--json"]).stdout);
  const rows = Object.fromEntries(status.agents.map((a) => [a.name, a]));
  assert.deepEqual(rows["acme-pkg--keeper"].instances.map((i) => i.instance), ["acme-pkg-keeper-p"]);
  assert.deepEqual(rows.keeper.instances.map((i) => i.instance), ["keeper-m"]);
  assert.equal(rows["acme-pkg--keeper"].soulSource.repoKey, `local/${fx.pkg.bare}`);
  assert.equal(rows["acme-pkg--keeper"].instances[0].soul.package, "acme.pkg");
  assert.equal(rows["acme-pkg--keeper"].instances[0].soul.status, "current");
  assert.equal(rows.keeper.soulSource.repoKey, fx.key);
  assert.equal(rows.keeper.instances[0].soul.package, undefined);
  assert.equal(rows.keeper.instances[0].soul.status, "current");
  assert.deepEqual([rows["acme-pkg--keeper"].key, rows.keeper.key], ["acme.pkg/keeper", "keeper"], "each agent row's soul key");
  const text = fx.cli(["status"]).stdout;
  assert.match(text, /acme-pkg--keeper {2}\[work: directory, repo: package acme\.pkg v1\.0\.0 @ [0-9a-f]{7}\]/);
  assert.match(text, /^ {2}keeper {2}\[work: directory, repo: ws @ [0-9a-f]{7}\]/m);
  // A package soul's instance names carry the package id: the purpose budget is smaller, and the
  // refusal says how small (64 - "acme-pkg-keeper-".length = 48).
  const long = "x".repeat(49);
  const e2 = fails(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", long, "--no-launch", "--json"]), "E_INSTANCE_NAME_INVALID", "purpose over budget");
  assert.match(e2.message, /instances are named acme-pkg-keeper-<purpose>, which leaves at most 48 for the purpose/, e2.message);
  assert.deepEqual([e2.details?.prefix, e2.details?.maxPurpose], ["acme-pkg-keeper-", 48]);
  assert.equal(ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "x".repeat(48), "--no-launch", "--json"]), "a purpose at the budget spawns").instance, `acme-pkg-keeper-${"x".repeat(48)}`);
  // The same purpose again is de-duplicated against the name the home got (not a collision).
  assert.equal(ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "p", "--no-launch", "--json"]), "same purpose again").instance, "acme-pkg-keeper-p-2");
});

test("two packages whose ids sanitise to one agent directory (a.b, a-b) and ship a same-named soul: listed, E_SOUL_AMBIGUOUS in discovery and at spawn", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const twin = packageRepo({ id: "acme-pkg" }); t.after(twin.cleanup);
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  ws.packages["acme-pkg"] = `${twin.ref}@v1.0.0`;
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "twin package");
  const synced = ok(fx.cli(["sync", "--json"]), "sync");
  assert.equal(synced.problems.filter((p) => p.code === "E_SOUL_AMBIGUOUS").length, 2, JSON.stringify(synced.problems));
  for (const name of ["acme.pkg/keeper", "acme-pkg/keeper"]) {
    const e = fails(fx.cli(["spawn", name, "--no-launch", "--json"]), "E_SOUL_AMBIGUOUS", name);
    assert.deepEqual(e.details.qualified, ["acme-pkg/keeper", "acme.pkg/keeper"]);
    assert.equal(e.details.agentDir, "acme-pkg--keeper");
  }
});

test("oats-local.yaml souls.disabled refuses a package soul by its qualified name (E_SOUL_DISABLED)", (t) => {
  const fx = fixture({ local: { souls: { disabled: ["acme.pkg/keeper"] } } }); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  for (const name of ["keeper", "acme.pkg/keeper"]) {
    const e = fails(fx.cli(["spawn", name, "--no-launch", "--json"]), "E_SOUL_DISABLED", `spawn ${name}`);
    assert.equal(e.details.qualifiedName, "acme.pkg/keeper");
  }
  assert.match(fx.cli(["sync"]).stdout, /1 disabled here/);
});

test("a package soul still carrying `team:` (removed in 0.30) is refused, naming the move; workspace defaults and off apply as for any soul", (t) => {
  const fx = fixture({ pkgSouls: { keeper: {}, stale: { soul: { team: "okf" } }, loner: { soul: { capabilities: { "acme-tool": { from: "here" }, house: "off" } } } } }); t.after(fx.cleanup);
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  ws.defaults.capabilities = { house: { from: fx.key } };
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws), "capabilities/house/oats.json": JSON.stringify({ capability: "house", version: "0.0.0", description: "house style", compatibility: { oats: ">=0.24.0" } }) }, "house default");
  ok(fx.cli(["sync", "--json"]), "sync");
  const souls = ok(fx.cli(["souls", "--json"]), "souls");
  const stale = souls.problems.find((p) => p.package === "acme.pkg" && p.path.includes("souls/stale/soul.yaml"));
  assert.deepEqual([stale?.code, stale?.message], ["E_WORKSPACE_SCHEMA", "a soul's teams are decided by souls: in oats-workspace.yaml (team model 3, OATS 0.38.0)"], JSON.stringify(souls.problems));
  assert.equal(souls.souls.some((s) => s.name === "stale"), false, "not listed");
  const modules = (name) => ok(fx.cli(["spawn", name, "--preview", "--json"]), `preview ${name}`).modules.map((m) => m.name).sort();
  assert.deepEqual(modules("acme.pkg/loner"), ["acme-tool"], "house: off drops the workspace default");
  assert.deepEqual(modules("acme.pkg/keeper"), ["acme-tool", "house"]);
});

test("integrity: a lock whose soul digest was edited, or a moved tag, is E_PACKAGE_INTEGRITY on sync; spawn verifies the fetched soul against the lock", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  const good = lockOf(fx);
  const edited = structuredClone(good);
  edited.packages["acme.pkg"].souls[0].digest = `sha256-${"0".repeat(64)}`;
  writeFileSync(join(fx.dep, "oats-lock.json"), JSON.stringify(edited, null, 2) + "\n");
  let e = fails(fx.cli(["spawn", "acme.pkg/keeper", "--no-launch", "--json"]), "E_PACKAGE_INTEGRITY", "spawn with an edited soul digest");
  assert.equal(e.details.why, "soul-digest");
  e = fails(fx.cli(["sync", "--json"]), "E_PACKAGE_INTEGRITY", "sync with an edited soul digest");
  assert.equal(e.details.why, "souls");

  // A lock written before 0.28.0 records no souls: the next sync fills them in.
  const older = structuredClone(good);
  delete older.packages["acme.pkg"].souls;
  writeFileSync(join(fx.dep, "oats-lock.json"), JSON.stringify(older, null, 2) + "\n");
  ok(fx.cli(["sync", "--json"]), "sync fills the souls of a pre-0.28 lock");
  assert.deepEqual(lockOf(fx), good);
  // The soul's content changes under the SAME tag: the tag moved.
  fx.pkg.release("1.0.0", { keeper: { agents: "# keeper, changed under the same tag\n" } }, { force: true });
  fails(fx.cli(["sync", "--json"]), "E_PACKAGE_INTEGRITY", "sync after the tag moved");
});

test("drift: the package pin moving shows the instance's soul as moved", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "d", "--no-launch", "--json"]), "spawn");
  const c2 = fx.pkg.release("1.1.0", { keeper: { agents: "# keeper 1.1.0\n" } });
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  ws.packages["acme.pkg"] = `${fx.pkg.ref}@v1.1.0`;
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "bump acme.pkg");
  ok(fx.cli(["sync", "--json"]), "sync 1.1.0");
  const status = JSON.parse(fx.cli(["status", "--json"]).stdout);
  const soul = status.agents.find((a) => a.name === "acme-pkg--keeper").instances[0].soul;
  assert.equal(soul.status, "moved", JSON.stringify(soul));
  assert.equal(soul.current, c2);
  assert.match(fx.cli(["status"]).stdout, /soul: keeper from package acme\.pkg v1\.0\.0 @ [0-9a-f]{7}\s+\[package moved since \(now v1\.1\.0 @ [0-9a-f]{7}\)\]/);
});

test("a package soul must carry soul.yaml and AGENTS.md, and its name is its directory (E_PACKAGE_MANIFEST on sync)", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  rmSync(join(fx.pkg.seed, "oats-package", "souls", "keeper", "AGENTS.md"));
  git(fx.pkg.seed, "add", "-A"); git(fx.pkg.seed, "commit", "-qm", "broken"); git(fx.pkg.seed, "tag", "v1.0.1"); git(fx.pkg.seed, "push", "-q", "origin", "HEAD:main", "v1.0.1");
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  ws.packages["acme.pkg"] = `${fx.pkg.ref}@v1.0.1`;
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "pin broken");
  const e = fails(fx.cli(["sync", "--json"]), "E_PACKAGE_MANIFEST", "sync a soul without AGENTS.md");
  assert.match(e.message, /souls\/keeper/);
  assert.equal(lstatSync(join(fx.dep, "oats-local.yaml")).isFile(), true);
});

// Re-review A #1: a capability command run from the deployment with `--soul <pkg>/<soul>` reads the
// soul's per-commit copy from the package soul's own agent directory (`agents/<pkg>--<soul>/`), never
// the bare name's — where a same-named member soul's copy at the same commit may sit.
test("operator dispatch: a package soul's command gets OATS_SOUL = the package soul's copy, never a same-named member soul's", (t) => {
  const show = "import { writeFileSync } from 'node:fs'; console.log(JSON.stringify({ soul: process.env.OATS_SOUL ?? null }));\n";
  const fx = fixture({
    pkgSouls: { keeper: { soul: { capabilities: { "acme-cmd": { from: "here" } } } } },
    pkg: {
      manifest: { capabilities: ["capabilities/acme-tool", "capabilities/acme-cmd"] },
      files: {
        "capabilities/acme-cmd/oats.json": { capability: "acme-cmd", version: "1.0.0", description: "cmd", compatibility: { oats: ">=0.24.0" }, command: "acmecmd", commands: { show: "bin/show.mjs" } },
        "capabilities/acme-cmd/bin/show.mjs": show,
      },
    },
  });
  t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  // A spawn fetches the package soul's copy at the locked commit.
  ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "c", "--no-launch", "--json"]), "spawn the package soul");
  const commit12 = lockOf(fx).packages["acme.pkg"].commit.slice(0, 12);
  const own = join(fx.root, "acme-pkg--keeper", "souls", commit12);
  assert.ok(existsSync(join(own, "soul.yaml")), "the package soul's per-commit copy");
  // A same-named member soul's copy at the SAME commit (a package published from a member repo).
  const decoy = join(fx.root, "keeper", "souls", commit12);
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "soul.yaml"), "schemaVersion: 2\nname: keeper\nwork: directory\n");
  const soulOf = (name) => {
    const r = spawnSync(process.execPath, [CLI, "acmecmd", "show", "--soul", name], { cwd: fx.dep, env: fx.env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop()).soul;
  };
  for (const name of ["acme.pkg/keeper", "keeper"]) assert.equal(soulOf(name), realpathSync(own), `${name}: the package soul's copy, not the member decoy`);
});

// Re-review A #2: a package's souls are visible only while the workspace declares the package. A lock
// that still records it (removed from `packages:`, not yet re-synced) must not surface its souls.
test("a package removed from packages: (its lock entry still there) hides its souls: spawn is E_SOUL_UNKNOWN, oats souls lists none", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  const listed = () => ok(fx.cli(["souls", "--json"]), "souls").souls.map((s) => s.qualifiedName ?? s.name);
  assert.ok(listed().includes("acme.pkg/keeper"), "declared: listed");
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  delete ws.packages["acme.pkg"];
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "undeclare acme.pkg");
  assert.ok(lockOf(fx).packages["acme.pkg"]?.souls?.length, "the lock still records the package's souls");
  assert.equal(listed().some((n) => /keeper/.test(n)), false, "undeclared: not listed");
  for (const name of ["acme.pkg/keeper", "keeper"]) fails(fx.cli(["spawn", name, "--no-launch", "--json"]), "E_SOUL_UNKNOWN", name);
});

// Re-review A #5: regression cover for the guards sync already applies to a package's souls.
test("sync refuses a package soul carrying a non-CLAUDE.md symlink, a CLAUDE.md escaping the soul, or souls: [\"../x\"]", (t) => {
  const cases = [
    ["a non-CLAUDE.md symlink", "E_REMOTE_TREE_UNSAFE", /souls\/keeper\/README\.md is a symlink/, (seed) => symlinkSync("AGENTS.md", join(seed, "oats-package/souls/keeper/README.md"))],
    ["CLAUDE.md -> ../x", "E_REMOTE_TREE_UNSAFE", /CLAUDE\.md is a symlink escaping the fetched tree/, (seed) => symlinkSync("../x", join(seed, "oats-package/souls/keeper/CLAUDE.md"))],
    ['souls: ["../x"]', "E_PACKAGE_MANIFEST", /souls\[\] must be a relative path inside the package/, (seed) => {
      const f = join(seed, "oats-package/oats-package.json"); const m = JSON.parse(readFileSync(f, "utf8")); m.souls = ["../x"]; writeFileSync(f, JSON.stringify(m));
    }],
  ];
  for (const [what, code, message, mutate] of cases) {
    const fx = fixture(); t.after(fx.cleanup);
    mutate(fx.pkg.seed);
    git(fx.pkg.seed, "add", "-A"); git(fx.pkg.seed, "commit", "-qm", what); git(fx.pkg.seed, "tag", "v1.0.1"); git(fx.pkg.seed, "push", "-q", "origin", "HEAD:main", "v1.0.1");
    const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
    ws.packages["acme.pkg"] = `${fx.pkg.ref}@v1.0.1`;
    fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, `pin ${what}`);
    const e = fails(fx.cli(["sync", "--json"]), code, what);
    assert.match(e.message, message, what);
    assert.equal(existsSync(join(fx.dep, "oats-lock.json")) && /v1\.0\.1/.test(readFileSync(join(fx.dep, "oats-lock.json"), "utf8")), false, `${what}: nothing locked`);
  }
});

test("a package soul's launch preference (feature launch-preference): its own launch, overridden by souls.launch.<package>/<soul>", (t) => {
  const OPUS = { harness: "claude", model: "claude-opus-5-5" };
  const fx = fixture({ pkgSouls: { keeper: { soul: { launch: { harness: "codex" } } } } }); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  const row = () => ok(fx.cli(["souls", "--json"]), "souls").souls.find((s) => s.name === "keeper");
  assert.deepEqual(row().launch, { declared: { harness: "codex", model: null }, effective: { harness: "codex", model: null, launchConfig: null }, from: "soul",
    at: "package:acme.pkg:oats-package/souls/keeper/soul.yaml#/launch", problem: null });
  const localPath = join(fx.dep, "oats-local.yaml");
  writeFileSync(localPath, `${readFileSync(localPath, "utf8")}souls:\n  launch:\n    acme.pkg/keeper: { harness: claude, model: claude-opus-5-5 }\n`);
  assert.deepEqual(row().launch, { declared: { harness: "codex", model: null }, effective: { ...OPUS, launchConfig: null }, from: "local",
    at: "oats-local.yaml#/souls/launch/acme.pkg~1keeper", problem: null });
  const preview = ok(fx.cli(["spawn", "acme.pkg/keeper", "--preview", "--json"]), "preview");
  assert.deepEqual([preview.harness, preview.model, preview.launch.from], ["claude", "claude-opus-5-5", "local"]);
});

// #533: a package soul is trusted through the workspace's `packages:` pin (lock commit + integrity),
// never through membership (docs/workspaces.md, the non-collapse rule). Its repository (here a
// bare package repo the workspace does not list in members:) is not a member, and must not need to be.
test("readiness: a package soul's member check is its package (locked, integrity, soul at the locked commit), never membership; a member soul keeps the membership check", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync");
  const digest = lockOf(fx).packages["acme.pkg"].souls[0].digest;
  const packageItem = (rd, what) => {
    assert.equal(rd.checks.member.items.length, 1, `${what}: ${JSON.stringify(rd.checks.member)}`);
    const [it] = rd.checks.member.items;
    assert.equal(it.subject, "package acme.pkg/keeper", what);
    assert.equal(it.producer, "workspace lock", what);
    assert.deepEqual(it.evidence.from, { kind: "package", package: "acme.pkg", version: "1.0.0", commit: fx.pkg.commit1, integrity: digest }, what);
    return it;
  };

  let rd = ok(fx.cli(["readiness", "--soul", "acme.pkg/keeper", "--json"]), "readiness --soul (package)");
  let it = packageItem(rd, "readiness --soul");
  assert.deepEqual([it.status, it.required, it.reason, it.remedy], ["pass", true, null, null], JSON.stringify(it));
  assert.equal(rd.checks.member.status, "pass");
  assert.doesNotMatch(JSON.stringify(rd), /not a member/);

  const { home } = ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "r", "--no-launch", "--json"]), "spawn");
  rd = ok(fx.cli(["readiness", "--home", home, "--json"]), "readiness --home (package)");
  it = packageItem(rd, "readiness --home");
  assert.deepEqual([it.status, it.reason], ["pass", null], JSON.stringify(it));

  // A member soul is unchanged: its member repository, confirmed in the workspace.
  rd = ok(fx.cli(["readiness", "--soul", "dev", "--json"]), "readiness --soul (member)");
  assert.deepEqual(rd.checks.member.items.map((i) => [i.subject, i.status, i.producer]), [[`member ${fx.key}`, "pass", "workspace discovery"]]);

  // The package no longer declared in packages: — the spawned home's soul has no package behind it.
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  const pinned = ws.packages;
  delete ws.packages;
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "undeclare acme.pkg");
  rd = ok(fx.cli(["readiness", "--home", home, "--json"]), "readiness --home (package undeclared)");
  it = rd.checks.member.items[0];
  assert.deepEqual([it.subject, it.status], ["package acme.pkg/keeper", "fail"], JSON.stringify(it));
  assert.match(it.reason, /acme\.pkg is not locked in this workspace's packages:/);
  // Readiness cannot tell a deliberate drop from an accidental unpin: the remedy names both, the respawn first.
  assert.equal(it.remedy, "if the workspace dropped acme.pkg on purpose, spawn a new instance from a soul this workspace offers (oats souls lists them), then retire this one; otherwise declare acme.pkg in the workspace's packages:, then oats sync");
  ws.packages = pinned;
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "declare acme.pkg again");

  // Integrity: every failure is E_PACKAGE_INTEGRITY on both selectors, whether the soul is fetched or
  // already copied (the per-commit copy a home links is reused, never refetched).
  const integrityFails = (rd, what) => {
    const [i] = rd.checks.member.items;
    assert.deepEqual([i.subject, i.status, i.code], ["package acme.pkg/keeper", "fail", "E_PACKAGE_INTEGRITY"], `${what}: ${JSON.stringify(i)}`);
    assert.match(i.remedy, /oats sync|spawn/, what);
    assert.equal(rd.summary.ready, false, what);
    return i;
  };
  const lockFile = join(fx.dep, "oats-lock.json"), goodLock = readFileSync(lockFile, "utf8");
  const edited = lockOf(fx);
  edited.packages["acme.pkg"].souls[0].digest = `sha256-${"0".repeat(64)}`;
  writeFileSync(lockFile, JSON.stringify(edited, null, 2) + "\n");
  // The lock's digest edited, the copy intact: the copy does not match the lock (--soul), and the lock no
  // longer matches what the home recorded at the same commit (--home).
  it = integrityFails(ok(fx.cli(["readiness", "--soul", "acme.pkg/keeper", "--json"]), "readiness --soul"), "edited lock, cached copy");
  assert.match(it.reason, new RegExp(`copy .* digests ${digest}, not the locked sha256-0{64}`));
  it = integrityFails(ok(fx.cli(["readiness", "--home", home, "--json"]), "readiness --home"), "edited lock, home");
  assert.match(it.reason, /the lock records .* for the same commit/);
  // The lock intact, the copy's bytes changed under it.
  writeFileSync(lockFile, goodLock);
  const copy = join(fx.root, "acme-pkg--keeper", "souls", fx.pkg.commit1.slice(0, 12));
  writeFileSync(join(copy, "AGENTS.md"), "changed bytes\n");
  it = integrityFails(ok(fx.cli(["readiness", "--soul", "acme.pkg/keeper", "--json"]), "readiness --soul"), "changed copy, --soul");
  assert.match(it.reason, /copy .* digests sha256-[0-9a-f]{64}, not the locked/);
  it = integrityFails(ok(fx.cli(["readiness", "--home", home, "--json"]), "readiness --home"), "changed copy, --home");
  assert.match(it.reason, /copy .* digests sha256-[0-9a-f]{64}, not the recorded/);
  // A spawn reuses a complete copy, so the remedy moves the changed one aside first.
  assert.ok(it.remedy.includes(`move ${realpathSync(copy)} aside, then spawn a new instance of acme.pkg/keeper`), it.remedy);
  // No copy yet: the fetch itself is verified against the lock.
  rmSync(join(fx.root, "acme-pkg--keeper", "souls"), { recursive: true, force: true });
  writeFileSync(lockFile, JSON.stringify(edited, null, 2) + "\n");
  it = integrityFails(ok(fx.cli(["readiness", "--soul", "acme.pkg/keeper", "--json"]), "readiness --soul"), "edited lock, fetched");
  assert.match(it.reason, /does not match the locked/);
});

test("readiness: a package soul whose source carries its own CLAUDE.md → AGENTS.md alias: the copy digests as the lock's", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  symlinkSync("AGENTS.md", join(fx.pkg.seed, "oats-package/souls/keeper/CLAUDE.md"));
  git(fx.pkg.seed, "add", "-A"); git(fx.pkg.seed, "commit", "-qm", "alias"); git(fx.pkg.seed, "tag", "v1.0.1"); git(fx.pkg.seed, "push", "-q", "origin", "HEAD:main", "v1.0.1");
  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  ws.packages["acme.pkg"] = `${fx.pkg.ref}@v1.0.1`;
  fx.commit({ "oats-workspace.yaml": YAML.stringify(ws) }, "pin the alias");
  ok(fx.cli(["sync", "--json"]), "sync");
  const { home } = ok(fx.cli(["spawn", "acme.pkg/keeper", "--purpose", "a", "--no-launch", "--json"]), "spawn");
  for (const args of [["--soul", "acme.pkg/keeper"], ["--home", home]]) {
    const [it] = ok(fx.cli(["readiness", ...args, "--json"]), `readiness ${args[0]}`).checks.member.items;
    assert.deepEqual([it.subject, it.status, it.reason], ["package acme.pkg/keeper", "pass", null], `${args[0]}: ${JSON.stringify(it)}`);
  }
});
