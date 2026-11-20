import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkCatalogReferences } from "../scripts/check-catalog-references.mjs";
import { checkMirrors, generateMirror, INVENTORY_PATH, REPO_ROOT } from "../scripts/check-mirrors.mjs";

const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
function fixture(t, { rootCapability = false, capability = "fixture" } = {}) {
  mkdirSync(join(REPO_ROOT, ".agents"), { recursive: true });
  const base = mkdtempSync(join(REPO_ROOT, ".agents/mirror-parity-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "kernel"), source = join(base, "source"), origin = join(base, "origin.git");
  const env = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: source, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(source, { recursive: true });
  git("init", "-q"); git("init", "--bare", origin); git("remote", "add", "origin", origin);
  write(join(source, "oats-package/oats-package.json"), JSON.stringify({ package: "oats.fixture", version: "1.0.0", capabilities: [rootCapability ? "." : `capabilities/${capability}`] }));
  const capRoot = rootCapability ? "oats-package" : `oats-package/capabilities/${capability}`;
  write(join(source, capRoot, "oats.json"), JSON.stringify({ capability: "fixture.cap", version: "1.0.0" }));
  write(join(source, capRoot, "tool.mjs"), "export const value = 1;\n");
  chmodSync(join(source, capRoot, "tool.mjs"), 0o755);
  symlinkSync("tool.mjs", join(source, capRoot, "alias.mjs"));
  git("add", "."); git("commit", "-qm", "fixture"); git("tag", "v1.0.0"); git("push", "-q", "origin", "refs/tags/v1.0.0");
  write(join(root, "package-catalog.json"), JSON.stringify({ packages: { "oats.fixture": { url: origin, ref: "v1.0.0", path: "oats-package" } } }));
  write(join(root, "oats-workspace.yaml"), "packages:\n  oats.fixture: v1.0.0\n");
  mkdirSync(join(root, "mirrors")); mkdirSync(join(root, "scripts"));
  const object = (type, input, literal = false) => execFileSync("git", ["hash-object", "-w", "-t", type, ...(literal ? ["--literally"] : []), "--stdin"], { cwd: source, env, input, encoding: "utf8" }).trim();
  return { root, source, git, origin, object };
}

test("every checked-in mirror matches its immutable inventory and catalog pin", () => {
  assert.ok(Object.keys(checkMirrors()).length >= 6);
});

test("generation reads the catalog tag's Git bytes, ignoring modified checkout bytes", t => {
  const f = fixture(t);
  write(join(f.source, "oats-package/capabilities/fixture/tool.mjs"), "uncommitted drift\n");
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  assert.equal(readFileSync(join(f.root, "mirrors/fixture/tool.mjs"), "utf8"), "export const value = 1;\n");
  assert.deepEqual(Object.keys(checkMirrors({ repoRoot: f.root })), ["oats.fixture"]);
  const before = snapshot(f.root);
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  assert.deepEqual(snapshot(f.root), before, "the owning package can regenerate its exact prior destination");
});

test("a package exporting its payload root is mirrored whole", t => {
  const f = fixture(t, { rootCapability: true });
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  assert.equal(readFileSync(join(f.root, "mirrors/oats-fixture/tool.mjs"), "utf8"), "export const value = 1;\n");
  assert.equal(JSON.parse(readFileSync(join(f.root, "mirrors/oats-fixture/oats-package.json"))).package, "oats.fixture");
  checkMirrors({ repoRoot: f.root });
});

for (const [label, mutate] of [
  ["bytes", f => write(join(f.root, "mirrors/fixture/tool.mjs"), "drift\n")],
  ["missing file", f => rmSync(join(f.root, "mirrors/fixture/tool.mjs"))],
  ["extra directory", f => mkdirSync(join(f.root, "mirrors/fixture/obsolete"))],
  ["extra file", f => write(join(f.root, "mirrors/fixture/extra"), "extra")],
  ["extra mirror", f => mkdirSync(join(f.root, "mirrors/untracked"))],
  ["mode", f => chmodSync(join(f.root, "mirrors/fixture/tool.mjs"), 0o644)],
  ["escaping symlink", f => { rmSync(join(f.root, "mirrors/fixture/alias.mjs")); symlinkSync("../../package-catalog.json", join(f.root, "mirrors/fixture/alias.mjs")); }],
  ["catalog ref", f => { const path = join(f.root, "package-catalog.json"); write(path, readFileSync(path, "utf8").replace("v1.0.0", "v2.0.0")); }],
]) test(`offline verification refuses ${label} drift`, t => {
  const f = fixture(t);
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  mutate(f);
  assert.throws(() => checkMirrors({ repoRoot: f.root }));
});

test("a moved published tag refuses generation without changing the prior inventory or payload", t => {
  const f = fixture(t);
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  const before = readFileSync(join(f.root, INVENTORY_PATH));
  write(join(f.source, "new"), "new"); f.git("add", "."); f.git("commit", "-qm", "move local tag"); f.git("tag", "-f", "v1.0.0");
  assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }), /published.*tag/);
  assert.deepEqual(readFileSync(join(f.root, INVENTORY_PATH)), before);
  checkMirrors({ repoRoot: f.root });
});

test("workspace and current docs/skills recommendations match the catalog", () => {
  assert.ok(checkCatalogReferences(REPO_ROOT).examples > 20);
});

test("catalog reference verification refuses stale workspace and documentation pins", t => {
  const f = fixture(t);
  write(join(f.root, "oats-workspace.yaml"), "packages:\n  oats.fixture: v1.0.0\n");
  write(join(f.root, "docs/official-catalog.md"), "| `oats.fixture` | `v1.0.0` |\n");
  checkCatalogReferences(f.root);
  write(join(f.root, "oats-workspace.yaml"), "packages:\n  oats.fixture: v2.0.0\n");
  assert.throws(() => checkCatalogReferences(f.root), /workspace.*pin differs/);
  write(join(f.root, "oats-workspace.yaml"), "packages:\n  oats.fixture: v1.0.0\n");
  write(join(f.root, "docs/official-catalog.md"), "| `oats.fixture` | `v2.0.0` |\n");
  assert.throws(() => checkCatalogReferences(f.root), /release row differs/);
});

test("generation refuses an escaping source symlink before replacing payload or inventory", t => {
  const f = fixture(t);
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  const before = readFileSync(join(f.root, INVENTORY_PATH));
  rmSync(join(f.source, "oats-package/capabilities/fixture/alias.mjs"));
  symlinkSync("../../../../outside", join(f.source, "oats-package/capabilities/fixture/alias.mjs"));
  const manifest = join(f.source, "oats-package/oats-package.json");
  write(manifest, readFileSync(manifest, "utf8").replace("1.0.0", "1.0.1"));
  f.git("add", "."); f.git("commit", "-qm", "unsafe export"); f.git("tag", "v1.0.1"); f.git("push", "-q", "origin", "refs/tags/v1.0.1");
  const catalog = join(f.root, "package-catalog.json");
  write(catalog, readFileSync(catalog, "utf8").replace("v1.0.0", "v1.0.1"));
  assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }), /symlink escapes payload/);
  assert.deepEqual(readFileSync(join(f.root, INVENTORY_PATH)), before);
  assert.equal(readFileSync(join(f.root, "mirrors/fixture/tool.mjs"), "utf8"), "export const value = 1;\n");
  assert.equal(existsSync(join(f.root, "outside")), false);
});

test("a malformed duplicate-name Git tree cannot write through a staged symlink", t => {
  const f = fixture(t);
  const victim = join(f.root, "victim"); mkdirSync(victim);
  const tree = entries => Buffer.concat(entries.map(([mode, name, hash]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(hash, "hex")])));
  const payload = f.object("blob", "PWNED");
  const child = f.object("tree", tree([["100644", "pwned.txt", payload]]));
  const link = f.object("blob", victim);
  const manifest = f.git("rev-parse", "HEAD:oats-package/oats-package.json");
  const capability = f.git("rev-parse", "HEAD:oats-package/capabilities/fixture/oats.json");
  const malformed = f.object("tree", tree([["100644", "oats.json", capability], ["120000", "x", link], ["40000", "x", child]]), true);
  const caps = f.object("tree", tree([["40000", "fixture", malformed]]));
  const distribution = f.object("tree", tree([["40000", "capabilities", caps], ["100644", "oats-package.json", manifest]]));
  const root = f.object("tree", tree([["40000", "oats-package", distribution]]));
  const commit = f.git("commit-tree", root, "-m", "malformed fixture");
  f.git("tag", "-f", "v1.0.0", commit); f.git("push", "--force", "-q", "origin", "refs/tags/v1.0.0");
  assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }));
  assert.equal(existsSync(join(victim, "pwned.txt")), false, "refuse malformed paths before a staging write can follow their symlink");
  assert.equal(existsSync(join(f.root, INVENTORY_PATH)), false);
});

test("a published tag moved at an unchanged pin is refused even after catalog key reordering", t => {
  const f = fixture(t);
  generateMirror("oats.fixture", f.source, { repoRoot: f.root });
  const before = readFileSync(join(f.root, INVENTORY_PATH));
  write(join(f.source, "new"), "new"); f.git("add", "."); f.git("commit", "-qm", "move published tag"); f.git("tag", "-f", "v1.0.0");
  f.git("push", "--force", "-q", "origin", "refs/tags/v1.0.0");
  const catalog = join(f.root, "package-catalog.json");
  const data = JSON.parse(readFileSync(catalog));
  const { url, ref, path } = data.packages["oats.fixture"];
  data.packages["oats.fixture"] = { path, ref, url }; write(catalog, JSON.stringify(data));
  assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }), /moved since prior generation/);
  assert.deepEqual(readFileSync(join(f.root, INVENTORY_PATH)), before);
  checkMirrors({ repoRoot: f.root });
});

for (const [label, linkName, directoryName] of [["case", "X", "x"], ["normalization", "E\u0301", "É"]]) {
  test(`generation refuses ${label}-folded symlink/tree names before any write`, t => {
    const f = fixture(t);
    const victim = join(f.root, "victim"); mkdirSync(victim);
    const tree = entries => Buffer.concat(entries.map(([mode, name, hash]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(hash, "hex")])));
    const payload = f.object("blob", "PWNED");
    const child = f.object("tree", tree([["100644", "pwned.txt", payload]]));
    const link = f.object("blob", victim);
    const manifest = f.git("rev-parse", "HEAD:oats-package/oats-package.json");
    const capability = f.git("rev-parse", "HEAD:oats-package/capabilities/fixture/oats.json");
    const entries = [["120000", linkName, link], ["100644", "oats.json", capability], ["40000", directoryName, child]];
    entries.sort((a, b) => Buffer.compare(Buffer.from(a[1] + (a[0] === "40000" ? "/" : "")), Buffer.from(b[1] + (b[0] === "40000" ? "/" : ""))));
    const capabilityTree = f.object("tree", tree(entries));
    const caps = f.object("tree", tree([["40000", "fixture", capabilityTree]]));
    const distribution = f.object("tree", tree([["40000", "capabilities", caps], ["100644", "oats-package.json", manifest]]));
    const root = f.object("tree", tree([["40000", "oats-package", distribution]]));
    const commit = f.git("commit-tree", root, "-m", "valid colliding names fixture");
    f.git("tag", "-f", "v1.0.0", commit);
    f.git("fsck", "--strict", "--no-dangling");
    f.git("push", "--force", "-q", "origin", "refs/tags/v1.0.0");
    assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }), /folded Git payload path/);
    assert.equal(existsSync(join(victim, "pwned.txt")), false, "the staging write must never follow a folded symlink");
    assert.equal(existsSync(join(f.root, INVENTORY_PATH)), false);
  });
}

test("a git workspace pin must name the catalog repository as well as its ref", t => {
  const f = fixture(t);
  const catalog = join(f.root, "package-catalog.json");
  const data = JSON.parse(readFileSync(catalog));
  data.packages["oats.fixture"].url = "https://github.com/awebai/oats-okf.git";
  write(catalog, JSON.stringify(data));
  const workspace = join(f.root, "oats-workspace.yaml");
  write(workspace, "packages:\n  oats.fixture: git:github.com/someone/fork@v1.0.0\n");
  assert.throws(() => checkCatalogReferences(f.root), /workspace.*pin differs/);
  for (const repo of ["awebai/oats-okf", "oats-project/oats-okf"]) {
    write(workspace, `packages:\n  oats.fixture: git:github.com/${repo}@v1.0.0\n`);
    checkCatalogReferences(f.root);
  }
});

function verificationSnapshot(t) {
  const root = mkdtempSync(join(REPO_ROOT, ".agents/mirror-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["package-catalog.json", "oats-workspace.yaml", "scripts/mirror-source-inventory.json", "scripts/okf-source-inventory.json", "mirrors"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true, verbatimSymlinks: true });
  }
  return root;
}

test("offline verification requires OKF provenance even when all OKF mirrors are removed", t => {
  const root = verificationSnapshot(t);
  checkMirrors({ repoRoot: root });
  const inventory = JSON.parse(readFileSync(join(root, "scripts/okf-source-inventory.json"), "utf8"));
  rmSync(join(root, "scripts/okf-source-inventory.json"));
  for (const path of inventory.mirrorPaths) rmSync(join(root, path), { recursive: true });
  assert.throws(() => checkMirrors({ repoRoot: root }), /okf-source-inventory/);
});

test("offline verification requires every workspace-pinned mirror inventory", t => {
  const root = verificationSnapshot(t), file = join(root, INVENTORY_PATH);
  const inventory = JSON.parse(readFileSync(file, "utf8"));
  delete inventory.packages["oats.jira"];
  writeFileSync(file, JSON.stringify(inventory));
  rmSync(join(root, "mirrors/oats-jira"), { recursive: true });
  assert.throws(() => checkMirrors({ repoRoot: root }), /workspace.*mirror inventory/);
});

test("full framework tag references in prose match the catalog", t => {
  const f = fixture(t), file = join(f.root, "package-catalog.json");
  const catalog = JSON.parse(readFileSync(file, "utf8"));
  catalog.packages["oats.framework"] = { url: "https://github.com/awebai/oats.git", ref: "oats-framework/v2.0.0", path: "oats-package" };
  writeFileSync(file, JSON.stringify(catalog));
  write(join(f.root, "oats-workspace.yaml"), "packages:\n  oats.fixture: v1.0.0\n");
  const doc = join(f.root, "docs/example.md");
  write(doc, "Use `oats-framework/v2.0.0`.\n");
  write(join(f.root, "docs/plans/completed-release.md"), "Historical release: `oats-framework/v1.0.0`.\n");
  checkCatalogReferences(f.root);
  write(doc, "Use `oats-framework/v1.0.0`.\n");
  assert.throws(() => checkCatalogReferences(f.root), /framework.*pin differs/);
});

function snapshot(root) {
  const entries = [];
  function walk(dir, relative = "") {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name), path = relative ? `${relative}/${name}` : name;
      const st = lstatSync(file), mode = st.mode & 0o777;
      if (st.isSymbolicLink()) entries.push({ path, mode, target: readlinkSync(file) });
      else if (st.isDirectory()) { entries.push({ path, mode, directory: true }); walk(file, path); }
      else entries.push({ path, mode, bytes: readFileSync(file).toString("base64") });
    }
  }
  walk(root);
  return entries;
}

test("generation refuses foreign OKF exports before writing any payload or inventory", t => {
  for (const present of [true, false]) {
    const f = fixture(t, { capability: "oats-okf" });
    cpSync(join(REPO_ROOT, "scripts/okf-source-inventory.json"), join(f.root, "scripts/okf-source-inventory.json"));
    if (present) cpSync(join(REPO_ROOT, "mirrors/oats-okf"), join(f.root, "mirrors/oats-okf"), { recursive: true, verbatimSymlinks: true });
    write(join(f.root, INVENTORY_PATH), JSON.stringify({ schemaVersion: 1, packages: {} }));
    const before = snapshot(f.root);
    assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }), /owned by oats.okf/);
    assert.deepEqual(snapshot(f.root), before, "the entire root, including payload, inventories and existing directories, is unchanged");
  }
});

test("generation refuses an unowned existing destination before any write", t => {
  const f = fixture(t);
  write(join(f.root, "mirrors/fixture/operator-file"), "keep this existing directory unchanged");
  write(join(f.root, INVENTORY_PATH), JSON.stringify({ schemaVersion: 1, packages: {} }));
  const before = snapshot(f.root);
  assert.throws(() => generateMirror("oats.fixture", f.source, { repoRoot: f.root }), /not owned by oats.fixture/);
  assert.deepEqual(snapshot(f.root), before);
});

for (const file of ["README.md", "capabilities/x/skills/y/SKILL.md", "souls/x/AGENTS.md", "injects/x.md"]) {
  test(`catalog reference guard includes ${file}`, t => {
    const f = fixture(t), doc = join(f.root, file);
    write(doc, "Pin `oats.fixture: v1.0.0`.\n");
    checkCatalogReferences(f.root);
    write(doc, "Pin `oats.fixture: v2.0.0`.\n");
    assert.throws(() => checkCatalogReferences(f.root), /recommended pin differs/);
  });
}
