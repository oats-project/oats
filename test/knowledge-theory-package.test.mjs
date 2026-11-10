import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { dirname, join } from "node:path";
import {
  CAPABILITY_PATH, EXPERT_PATH, REPO_ROOT, SKILL_PATH,
  checkKnowledgeTheoryPackage, checkReferenceClosure, syncKnowledgeTheoryReferences,
} from "../scripts/check-knowledge-theory-package.mjs";

const PACKAGE_ROOT = join(REPO_ROOT, "oats-package");
const PACKAGE_META = JSON.parse(readFileSync(join(PACKAGE_ROOT, "oats-package.json"), "utf8"));
const CAP_ROOT = join(PACKAGE_ROOT, CAPABILITY_PATH);
function write(file, body) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); }
function temp(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-theory-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function copyPackage(base) {
  const dest = join(base, "source");
  cpSync(PACKAGE_ROOT, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

test("framework distribution validates theory plus core/setup resource-only manifests and skill inventory", () => {
  assert.deepEqual(checkKnowledgeTheoryPackage(), { ok: true, package: PACKAGE_META.package, version: PACKAGE_META.version, references: 8 });
  const frontmatter = readFileSync(join(CAP_ROOT, SKILL_PATH, "SKILL.md"), "utf8");
  assert.match(frontmatter, /^---\nname: knowledge-capability-authoring\ndescription: >-\n/);
  assert.ok(frontmatter.split("\n").length < 500);
  assert.equal(readlinkSync(join(PACKAGE_ROOT, EXPERT_PATH, "CLAUDE.md")), "AGENTS.md");
});

test("canonical references regenerate byte-for-byte; drift and extra copies fail", (t) => {
  const base = temp(t);
  cpSync(PACKAGE_ROOT, join(base, "oats-package"), { recursive: true, verbatimSymlinks: true });
  cpSync(join(REPO_ROOT, "docs/knowledge-reference"), join(base, "docs/knowledge-reference"), { recursive: true });
  write(join(base, "docs/knowledge-capability-authoring.md"), readFileSync(join(REPO_ROOT, "docs/knowledge-capability-authoring.md")));
  const refs = join(base, "oats-package", CAPABILITY_PATH, SKILL_PATH, "references");
  writeFileSync(join(refs, "knowledge-reference/model.md"), "# Stale copy\n");
  assert.throws(() => checkKnowledgeTheoryPackage({ repoRoot: base }), /reference drift/);
  syncKnowledgeTheoryReferences(base);
  assert.equal(checkKnowledgeTheoryPackage({ repoRoot: base }).ok, true);
  write(join(refs, "orphan.md"), "# Orphan\n");
  assert.throws(() => checkKnowledgeTheoryPackage({ repoRoot: base }), /unreachable curriculum/);
});

test("closure traversal rejects missing, escaping, remote and stale-anchor references", (t) => {
  const base = temp(t);
  const copied = copyPackage(base);
  const skill = join(copied, CAPABILITY_PATH, SKILL_PATH);
  const skillFile = join(skill, "SKILL.md");
  const original = readFileSync(skillFile, "utf8");
  assert.equal(checkReferenceClosure(skill).length, 9);
  for (const [target, error] of [["missing.md", /missing curriculum/], ["https://example.invalid/mutable.md", /nonlocal/], ["references/knowledge-reference/model.md#absent", /missing heading/]]) {
    writeFileSync(skillFile, `${original}\n[bad](${target})\n`);
    assert.throws(() => checkReferenceClosure(skill), error);
  }
  const outside = join(copied, CAPABILITY_PATH, "outside.md");
  write(outside, "# Outside skill closure\n");
  writeFileSync(skillFile, `${original}\n[escape](../../outside.md)\n`);
  assert.throws(() => checkReferenceClosure(skill), /reference escapes/);
  writeFileSync(skillFile, original);
  symlinkSync("../../outside.md", join(skill, "escaped.md"));
  assert.throws(() => checkReferenceClosure(skill), /reference escapes/);
});

test("policy additions and escaping soul compatibility symlinks fail the package gate", (t) => {
  const base = temp(t);
  const copied = copyPackage(base);
  const manifestPath = join(copied, CAPABILITY_PATH, "oats.json");
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const patch of [{ layer: "knowledge" }, { inject: "mandatory.md" }, { hooks: { spawn: "hook.mjs" } }, { agents: ["agents/knowledge-theory-expert"] }]) {
    writeFileSync(manifestPath, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => checkKnowledgeTheoryPackage({ packageRoot: copied, parity: false }), assert.AssertionError);
  }
  writeFileSync(manifestPath, JSON.stringify(original));
  const alias = join(copied, EXPERT_PATH, "CLAUDE.md");
  rmSync(alias);
  symlinkSync(join(PACKAGE_ROOT, EXPERT_PATH, "AGENTS.md"), alias);
  assert.throws(() => checkKnowledgeTheoryPackage({ packageRoot: copied, parity: false }), /absolute symlink/);
});

test("a missing npm-style source alias or a regular compatibility copy fails the source gate", (t) => {
  const copied = copyPackage(temp(t));
  const alias = join(copied, EXPERT_PATH, "CLAUDE.md");
  rmSync(alias);
  assert.throws(() => checkKnowledgeTheoryPackage({ packageRoot: copied, parity: false }), /source CLAUDE.md must be/);
  write(alias, readFileSync(join(copied, EXPERT_PATH, "AGENTS.md")));
  assert.throws(() => checkKnowledgeTheoryPackage({ packageRoot: copied, parity: false }), /source CLAUDE.md must be/);
  rmSync(alias);
  symlinkSync("AGENTS.md", alias);
  assert.equal(checkKnowledgeTheoryPackage({ packageRoot: copied, parity: false }).ok, true);
});

test("knowledge-theory-expert and oats-setup-expert are oats.framework PACKAGE SOULS: locked with the package, spawned by their qualified names, with their package's capabilities and no knowledge slot", { timeout: 120_000 }, (t) => {
  // The shipped oats-package tree as a tagged Git package (the release channel).
  const base = temp(t);
  const bare = join(base, "framework.git"), seed = join(base, "seed");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git(base, "init", "-q", "--bare", bare);
  git(base, "clone", "-q", bare, seed);
  cpSync(PACKAGE_ROOT, join(seed, "oats-package"), { recursive: true, verbatimSymlinks: true });
  git(seed, "add", "-A"); git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "framework");
  git(seed, "tag", `v${PACKAGE_META.version}`); git(seed, "push", "-q", "origin", "HEAD:main", "--tags");
  const fx = v2Deployment({ name: "acme", workspace: { packages: { "oats.framework": `git:${pathToFileURL(bare).href}@v${PACKAGE_META.version}` } } });
  t.after(fx.cleanup);
  const ok = (r) => { const j = r.json(); assert.equal(j.ok, true, r.stdout + r.stderr); return j.result; };
  ok(fx.cli(["sync", "--json"]));
  const lock = JSON.parse(readFileSync(join(fx.dep, "oats-lock.json"), "utf8"));
  assert.deepEqual(lock.packages["oats.framework"].souls.map((s) => s.name), ["knowledge-theory-expert", "oats-setup-expert"]);
  const spawned = ok(fx.cli(["spawn", "oats.framework/knowledge-theory-expert", "--purpose", "author", "--work", "directory", "--no-launch", "--json"]));
  assert.equal(spawned.home, join(fx.root, "oats-framework--knowledge-theory-expert", "instances", "oats-framework-knowledge-theory-expert-author"));
  const meta = JSON.parse(readFileSync(join(spawned.home, "instance.json"), "utf8"));
  assert.deepEqual(Object.keys(meta.modules), ["oats.knowledge-theory"], "its package's theory capability, no knowledge slot");
  assert.ok(readFileSync(join(spawned.home, ".agents", "skills", "knowledge-capability-authoring", "SKILL.md"), "utf8").includes("name: knowledge-capability-authoring"));
  assert.match(readFileSync(join(spawned.home, "AGENTS.md"), "utf8"), /# Knowledge theory expert/);
  // The setup expert: its package's oats.setup, oats.onboarding and oats.coordination-setup, no knowledge slot, in its own folder.
  const setup = ok(fx.cli(["spawn", "oats.framework/oats-setup-expert", "--name", "acme-oats-setup-expert", "--no-launch", "--json"]));
  assert.equal(setup.home, join(fx.root, "oats-framework--oats-setup-expert", "instances", "acme-oats-setup-expert"));
  const setupMeta = JSON.parse(readFileSync(join(setup.home, "instance.json"), "utf8"));
  assert.deepEqual(Object.keys(setupMeta.modules).sort(), ["oats.coordination-setup", "oats.onboarding", "oats.setup"], "its package's setup, onboarding and coordination-setup capabilities, no knowledge slot");
  assert.ok(readFileSync(join(setup.home, ".agents", "skills", "adapt-to-the-organisation", "SKILL.md"), "utf8").includes("name: adapt-to-the-organisation"));
  assert.ok(readFileSync(join(setup.home, ".agents", "skills", "oats-tailor-workspace", "SKILL.md"), "utf8").includes("name: oats-tailor-workspace"));
  assert.match(readFileSync(join(setup.home, "AGENTS.md"), "utf8"), /# OATS setup expert/);
});
