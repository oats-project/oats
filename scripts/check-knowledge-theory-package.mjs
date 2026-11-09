#!/usr/bin/env node
// Canonical docs -> optional Git package curriculum. No deployment/config effects.
// This is a complete source-payload gate, not an npm regular-file subset gate.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CAPABILITY_PATH = "capabilities/oats-knowledge-theory";
export const DISTRIBUTION_PACKAGE_ID = "oats.framework";
export const DISTRIBUTION_CAPABILITIES = [CAPABILITY_PATH, "capabilities/oats-core", "capabilities/oats-setup", "capabilities/oats-support", "capabilities/oats-onboarding", "capabilities/oats-coordination-setup"];
// Dev-only validators load lazily so syntax-only checks (release lane, --syntax-only)
// work in a checkout without node_modules; a missing dependency then fails only
// the manifest/frontmatter checks that actually need it.
const require = createRequire(import.meta.url);
let capabilityValidator, yamlParser;
function validateCapability(value) {
  capabilityValidator ??= new (require("ajv/dist/2020.js"))({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync(join(REPO_ROOT, "docs/capability-manifest.schema.json"), "utf8")),
  );
  const ok = capabilityValidator(value); validateCapability.errors = capabilityValidator.errors; return ok;
}
function parseYaml(text) { yamlParser ??= require("yaml").parse; return yamlParser(text); }
export const SKILL_PATH = "skills/knowledge-capability-authoring";
// The expert is an oats.framework PACKAGE SOUL (0.29.0: capability-defined agents were removed).
export const EXPERT_PATH = "souls/knowledge-theory-expert";
export const SETUP_EXPERT_PATH = "souls/oats-setup-expert";
// Each package soul's definition, pinned: a new capability, slot, launch preference or work
// mode is a boundary change. Neither declares a messaging slot or a launch preference.
const PACKAGE_SOULS = [
  { path: EXPERT_PATH, name: "knowledge-theory-expert", work: "checkout", capabilities: { "oats.knowledge-theory": { from: "here" } }, why: "the expert reads the authoring skill from its own package" },
  // work: directory, because a package soul in worktree mode would work in a tree of the
  // package's own repository; it clones the workspace's host into its work/ to change a shared file.
  // No messaging slot: it takes the workspace's messaging default, so it stays the operator.
  { path: SETUP_EXPERT_PATH, name: "oats-setup-expert", work: "directory", capabilities: { "oats.setup": { from: "here" }, "oats.onboarding": { from: "here" }, "oats.coordination-setup": { from: "here" } }, why: "the setup expert reads oats.setup, oats.onboarding and oats.coordination-setup from its own package" },
];

function inside(root, path) {
  const rel = relative(realpathSync(root), realpathSync(path));
  assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), `reference escapes ${root}: ${path}`);
}

// Do not descend through symlinks. Every link must itself be relative, readable,
// and contained; the only shipped link is the canonical CLAUDE.md compatibility view.
export function treeFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isSymbolicLink()) {
        assert.ok(!isAbsolute(readlinkSync(path)), `absolute symlink: ${path}`);
        inside(root, path);
        assert.ok(lstatSync(realpathSync(path)).isFile(), `directory symlink is not a curriculum resource: ${path}`);
        files.push(relative(root, path));
      } else if (e.isDirectory()) walk(path);
      else {
        assert.ok(e.isFile(), `non-file resource: ${path}`);
        files.push(relative(root, path));
      }
    }
  };
  walk(root);
  return files.sort();
}

function markdownTargets(text) {
  // References use simple inline Markdown. Also account for reference-style and
  // HTML links so a later author cannot bypass the closure check with those forms.
  const body = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  const targets = [];
  for (const m of body.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) targets.push(m[1].trim().replace(/^<([^>]+)>$/, "$1"));
  const definitions = new Map();
  for (const m of body.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
    definitions.set(m[1].toLowerCase(), m[2]);
    targets.push(m[2]);
  }
  for (const m of body.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const id = (m[2] || m[1]).toLowerCase();
    assert.ok(definitions.has(id), `undefined Markdown reference: ${id}`);
  }
  for (const m of body.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)) targets.push(m[1]);
  return targets;
}

/** Traverse all required links after source removal, without repo/network access. */
export function checkReferenceClosure(skillRoot) {
  const root = realpathSync(skillRoot);
  const files = treeFiles(root);
  const seen = new Set();
  const visit = (file) => {
    inside(root, file);
    const rel = relative(root, file);
    if (seen.has(rel)) return;
    assert.ok(lstatSync(file).isFile(), `curriculum link must name a file: ${rel}`);
    seen.add(rel);
    if (!file.endsWith(".md")) return;
    for (const raw of markdownTargets(readFileSync(file, "utf8"))) {
      assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/)|[\\\s?]/i.test(raw), `nonlocal/unsupported curriculum reference in ${rel}: ${raw}`);
      const decoded = decodeURIComponent(raw);
      assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/)|[\\\s?]/i.test(decoded), `nonlocal curriculum reference in ${rel}: ${raw}`);
      const [path, anchor] = decoded.split("#");
      const target = path ? resolve(dirname(file), path) : file;
      assert.ok(existsSync(target), `missing curriculum reference in ${rel}: ${raw}`);
      inside(root, target);
      if (anchor) {
        const headings = [...readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)]
          .map((m) => m[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-"));
        assert.ok(headings.includes(anchor), `missing heading in ${rel}: ${raw}`);
      }
      visit(target);
    }
  };
  visit(join(root, "SKILL.md"));
  for (const file of files.filter((f) => f.endsWith(".md"))) {
    assert.ok(seen.has(file), `unreachable curriculum document: ${file}`);
  }
  return [...seen].sort();
}

function referenceSources(repoRoot) {
  const refRoot = join(repoRoot, "docs/knowledge-reference");
  return ["knowledge-capability-authoring.md", ...treeFiles(refRoot).map((f) => join("knowledge-reference", f))];
}

export function syncKnowledgeTheoryReferences(repoRoot = REPO_ROOT) {
  const dest = join(repoRoot, "oats-package", CAPABILITY_PATH, SKILL_PATH, "references");
  for (const file of referenceSources(repoRoot)) {
    const out = join(dest, file);
    mkdirSync(dirname(out), { recursive: true });
    // Reject source or destination symlinks rather than writing through them.
    assert.ok(lstatSync(join(repoRoot, "docs", file)).isFile(), `not a regular canonical reference: ${file}`);
    inside(join(repoRoot, "oats-package", CAPABILITY_PATH), dirname(out));
    if (existsSync(out)) assert.ok(lstatSync(out).isFile(), `not a regular generated reference: ${out}`);
    writeFileSync(out, readFileSync(join(repoRoot, "docs", file)));
  }
}

// Keep the operational capabilities narrow. oats.setup, oats.support and oats.onboarding are resource-only; oats.core
// adds exactly two executable surfaces. Its Claude Code waiting emitter: the spawn
// and launch hooks of bin/oats-core.mjs (preview-aware), the bin/claude-waiting.sh
// they wire into a Claude instance's settings, and the bin/claude-waiting-message.mjs
// that script runs for a claim's text (#1502). And the upgrade hook of the same
// script, which adopts a home across `oats instance upgrade` (#1549). Any other executable surface, key or
// file is a boundary change, not unnoticed manifest growth. Use the kernel's actual
// schema, not a copied validator; files must survive acquiring each own root.
const OPERATIONAL_CAPABILITIES = [
  {
    slug: "oats-core", names: ["oats-operate", "oats-souls", "oats-token-saving"], injection: "injects/oats.md",
    // 0.40.0: `oats instance waiting`, which the emitter calls, and `oats instance attention`, which the skills teach.
    // 0.49.0: a kernel before it drops a capability that declares a hook event it does not know, and
    // oats.core declares `upgrade` (#1549), which only 0.68.0's `oats instance upgrade` runs.
    compatibility: ">=0.49.0",
    executable: { hooks: { spawn: "bin/oats-core.mjs spawn", launch: "bin/oats-core.mjs launch", upgrade: "bin/oats-core.mjs upgrade" }, launchPreview: true, files: ["bin/claude-waiting-message.mjs", "bin/claude-waiting.sh", "bin/oats-core.mjs"] },
  },
  { slug: "oats-setup", names: ["oats-setup-model", "oats-onboarding", "oats-setup-expert", "oats-host-delivery", "oats-agent-permissions", "oats-git-setup", "oats-workspace-config", "oats-teams", "oats-package-pins", "oats-automations", "oats-upgrade"], injection: "injects/setup.md", compatibility: ">=0.30.0" },
  // 0.40.0: `oats instance attention`, which the skills use to ask the desk's human.
  { slug: "oats-support", names: ["support-intake", "support-safety", "support-ticket", "support-handoff", "support-relay"], injection: "injects/support.md", compatibility: ">=0.40.0" },
  // No inject: the setup expert loads its one skill when oats.setup routes a new workspace to it.
  { slug: "oats-onboarding", names: ["oats-tailor-workspace"], compatibility: ">=0.30.0" },
];
export function checkOperationalCapabilities(packageRoot) {
  for (const { slug, names, injection, compatibility, executable } of OPERATIONAL_CAPABILITIES) {
    const root = join(packageRoot, "capabilities", slug);
    const cap = JSON.parse(readFileSync(join(root, "oats.json"), "utf8"));
    assert.ok(validateCapability(cap), `${slug}: ${JSON.stringify(validateCapability.errors)}`);
    // helperInjection may be present and is ignored since 0.26 (it served the removed
    // captured path's helper composition); nothing else is optional.
    assert.deepEqual(Object.keys(cap).filter((key) => key !== "helperInjection").sort(), ["capability", "version", "description", "compatibility", "requires", "skills", ...(injection ? ["inject"] : []), ...(executable ? ["hooks", "launchPreview"] : [])].sort());
    assert.equal(cap.capability, slug.replace("oats-", "oats."));
    assert.match(cap.version, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(cap.compatibility, { oats: compatibility }); // the kernel surface these skills (and oats.core's emitter) use
    assert.deepEqual(cap.requires, []);
    assert.deepEqual(cap.skills, names.map(name => `skills/${name}`));
    if (executable) {
      assert.deepEqual(cap.hooks, executable.hooks, `${slug}: exactly the emitter's spawn and launch hooks and the upgrade hook, advisory (string form)`);
      assert.equal(cap.launchPreview, executable.launchPreview, `${slug}: the launch hook is preview-aware`);
      for (const file of executable.files) assert.ok(lstatSync(join(root, file)).isFile(), `${slug}: ${file} must be a contained regular file`);
    }
    assert.deepEqual(treeFiles(root), ["oats.json", ...names.map(name => `skills/${name}/SKILL.md`), ...(injection ? [injection] : []), ...(executable ? executable.files : [])].sort());
    for (const name of names) {
      const file = join(root, "skills", name, "SKILL.md"), text = readFileSync(file, "utf8");
      assert.ok(lstatSync(file).isFile(), `skill must be a contained regular file: ${name}`);
      const match = text.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(match, `missing frontmatter: ${name}`);
      const fields = parseYaml(match[1]);
      assert.equal(fields.name, name);
      assert.ok(typeof fields.description === "string" && fields.description.trim() && fields.description.length <= 1024, `invalid description: ${name}`);
      assert.ok(text.split("\n").length <= 500, `oversized skill: ${name}`);
    }
    if (injection) {
      assert.equal(cap.inject, injection);
      const text = readFileSync(join(root, injection), "utf8");
      for (const name of names) assert.ok(text.includes(name), `${slug}: the inject must point at ${name}`);
    }
  }
}

export function checkKnowledgeTheoryPackage({ repoRoot = REPO_ROOT, packageRoot = join(repoRoot, "oats-package"), parity = true } = {}) {
  const capRoot = join(packageRoot, CAPABILITY_PATH);
  const pkg = JSON.parse(readFileSync(join(packageRoot, "oats-package.json"), "utf8"));
  const cap = JSON.parse(readFileSync(join(capRoot, "oats.json"), "utf8"));
  // Deliberately narrow: adding any runtime policy, dependency, template or
  // executable surface is a boundary change, not unnoticed manifest growth.
  assert.deepEqual(Object.keys(pkg).sort(), ["package", "version", "description", "compatibility", "capabilities", "souls"].sort());
  assert.deepEqual(Object.keys(cap).sort(), ["capability", "version", "description", "compatibility", "requires", "skills"].sort());
  assert.equal(pkg.package, DISTRIBUTION_PACKAGE_ID);
  assert.equal(cap.capability, "oats.knowledge-theory");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(cap.version, "1.1.1");
  assert.deepEqual(cap.compatibility, { oats: ">=0.22.19" });
  assert.deepEqual(pkg.compatibility, { oats: ">=0.24.0" });
  assert.deepEqual(pkg.capabilities, DISTRIBUTION_CAPABILITIES);
  assert.ok(validateCapability(cap), JSON.stringify(validateCapability.errors));
  checkOperationalCapabilities(packageRoot);
  assert.deepEqual(cap.requires, []);
  assert.deepEqual(cap.skills, [SKILL_PATH]);
  assert.deepEqual(pkg.souls, PACKAGE_SOULS.map((s) => s.path));
  treeFiles(packageRoot);
  treeFiles(capRoot);
  for (const expected of PACKAGE_SOULS) {
    const soul = join(packageRoot, expected.path);
    const soulYaml = parseYaml(readFileSync(join(soul, "soul.yaml"), "utf8"));
    assert.equal(soulYaml.name, expected.name);
    assert.equal(soulYaml.work, expected.work, `${expected.name}: work mode`);
    assert.equal(soulYaml.knowledge, "none", `${expected.name}: spawns before knowledge is set up`);
    assert.ok(!("messaging" in soulYaml) && !("launch" in soulYaml), `${expected.name}: takes the workspace's messaging default and the machine's harness`);
    assert.deepEqual(soulYaml.capabilities, expected.capabilities, expected.why);
    const alias = join(soul, "CLAUDE.md");
    assert.ok(existsSync(alias) && lstatSync(alias).isSymbolicLink(), "source CLAUDE.md must be a tracked relative symlink, never omitted or synthesized during acquisition");
    assert.equal(readlinkSync(alias), "AGENTS.md");
    assert.ok(lstatSync(join(soul, "AGENTS.md")).isFile(), "AGENTS.md is canonical");
    assert.ok(!existsSync(join(soul, "knowledge")), `${expected.name} does not carry a soul knowledge bundle`);
    assert.deepEqual(treeFiles(soul), ["AGENTS.md", "CLAUDE.md", "soul.yaml"], `${expected.name}: the soul is its definition and instructions only`);
  }
  const skill = join(capRoot, SKILL_PATH);
  const closure = checkReferenceClosure(skill);
  if (parity) {
    const expected = referenceSources(repoRoot).sort();
    const refs = join(skill, "references");
    assert.deepEqual(treeFiles(refs), expected, "generated reference file set differs from canonical docs");
    for (const file of expected) {
      assert.ok(readFileSync(join(repoRoot, "docs", file)).equals(readFileSync(join(refs, file))), `reference drift: ${file}; run node scripts/check-knowledge-theory-package.mjs --write`);
    }
  }
  return { ok: true, package: pkg.package, version: pkg.version, references: closure.length - 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.slice(2).every((arg) => arg === "--write"), "usage: node scripts/check-knowledge-theory-package.mjs [--write]");
    if (process.argv.includes("--write")) syncKnowledgeTheoryReferences();
    console.log(JSON.stringify(checkKnowledgeTheoryPackage()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
