#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkKnowledgeTheoryPackage, treeFiles } from "./check-knowledge-theory-package.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// One recursive inventory for local check, PR/release CI and the runnerless
// lane. Do not rely on git ls-files: a new candidate file needs checking BEFORE
// it is committed too. Capability libs and nested record/package scripts must
// not silently fall between hand-maintained one-level globs.
export const JS_ROOTS = [
  "bin", "lib", "capabilities", "mirrors", "oats-package", "packages/record/bin",
  "packages/record/lib", "packages/pi/extension", "packages/client", "packages/tui/bin",
  "packages/tui/lib", "scripts",
];
export function shippedJavaScript(root = ROOT) {
  const files = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // Never follow links into a checkout, installed dependencies or state.
      if (entry.isDirectory() && !["node_modules", ".git", ".agents"].includes(entry.name)) walk(path);
      else if (entry.isFile() && [".mjs", ".js", ".cjs"].includes(extname(path))) files.push(relative(root, path));
    }
  }
  for (const dir of JS_ROOTS) walk(join(root, dir));
  return [...new Set(files)].sort();
}
export function checkJavaScript(root = ROOT) {
  const files = shippedJavaScript(root);
  assert.ok(files.length, "no shipped/support JavaScript found");
  for (const file of files) {
    try { execFileSync(process.execPath, ["--check", join(root, file)], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { throw new Error(`syntax error in ${file}: ${error.stderr || error.message}`); }
  }
  return files.length;
}

function dryRun(cwd) {
  return JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
}
export function requireFiles(pack, required) {
  const files = new Set(pack.files.map((file) => file.path));
  for (const path of required) if (!files.has(path)) throw new Error(`${pack.name} dry run missing ${path}`);
  return files;
}
export function checkKernelPackFiles(pack, root = ROOT) {
  // The optional package is a separate Git payload, NOT an npm payload.
  // Keep its strict source alias/closure gate; never bless npm's partial copy
  // by checking only regular files or by manufacturing a missing source alias.
  checkKnowledgeTheoryPackage({ repoRoot: root });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(!manifest.files.some((path) => /^\/?oats-package(?:\/|$)/.test(path)), "npm files must not include the Git-only oats-package payload");
  // So are this repository's own capabilities (capabilities/) and the package
  // mirrors (mirrors/): nothing at runtime reads a bundled capability; a
  // capability resolves from its Git remote at the commit the lock records.
  assert.ok(!manifest.files.some((path) => /^\/?(?:capabilities|mirrors)(?:\/|$)/.test(path)), "npm files must not include capabilities/ or mirrors/: capabilities resolve from Git, never from the kernel package");
  const canonicalFiles = ["docs/knowledge-capability-authoring.md", ...treeFiles(join(root, "docs/knowledge-reference")).map((f) => `docs/knowledge-reference/${f}`)];
  const files = requireFiles(pack, [
    "bin/oats.mjs", "lib/core.mjs", "share/oats-login-receive", "docs/capabilities.md", "docs/capability-manifest.schema.json",
    "package-catalog.json", "package.json", "packages/record/bin/capture.mjs", "packages/record/bin/capture-hook.mjs", "packages/record/bin/recall.mjs",
    // The terminal client (`oats tui`) and the one shared reader it imports: both inside this package.
    "packages/tui/bin/tui.mjs", "packages/tui/lib/client.mjs", "packages/client/display-text.mjs",
    ...canonicalFiles,
  ]);
  for (const path of files) {
    if (path === "oats-package" || path.startsWith("oats-package/")) {
      throw new Error(`kernel tarball contains Git-only optional package file ${path}`);
    }
    if (path.startsWith("agents/") || path === "oats-config.yaml" || path === "oats-lock.json"
      || path.startsWith("test/") || path.startsWith("tests/") || path.split("/").some((part) => [".agents", ".git", "instances"].includes(part))) {
      throw new Error(`kernel tarball leaks non-runtime file ${path}`);
    }
    if (/^(?:capabilities|mirrors)(?:\/|$)/.test(path)) {
      throw new Error(`kernel tarball contains Git-only capability file ${path}`);
    }
    // The clients' tests run from a checkout; an entry of `files` wide enough to pack them is a defect.
    if (/^packages\/(?:tui|client)\/test(?:\/|$)/.test(path)) {
      throw new Error(`kernel tarball contains a test file ${path}`);
    }
  }
  return files;
}

export function checkReleaseVersions(root = ROOT) {
  const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
  const version = json("package.json").version;
  for (const path of ["packages/pi/package.json", "packages/desktop/package.json", "package-lock.json", "packages/desktop/package-lock.json"]) {
    const value = json(path);
    assert.equal(value.version, version, `${path} release version differs`);
    if (path.endsWith("package-lock.json")) assert.equal(value.packages[""].version, version, `${path} root entry version differs`);
  }
  return version;
}
/** The Node floor the kernel declares (`engines.node`, as `>=x.y.z`): the lock's root entry carries
 *  the same `engines`, and a package under packages/ that declares a floor declares none below it. */
export function checkNodeFloor(root = ROOT) {
  const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
  const floor = (file) => {
    const node = json(file).engines?.node;
    if (node === undefined) return null;
    const parts = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(node);
    assert.ok(parts, `${file} engines.node must be ">=x.y.z", not ${JSON.stringify(node)}`);
    return parts.slice(1).map(Number);
  };
  const kernel = floor("package.json");
  assert.ok(kernel, "package.json declares no engines.node");
  assert.deepEqual(json("package-lock.json").packages[""].engines, json("package.json").engines, "package-lock.json root entry engines differ");
  for (const name of readdirSync(join(root, "packages")).sort()) {
    const file = `packages/${name}/package.json`;
    const declared = existsSync(join(root, file)) ? floor(file) : null;
    if (!declared) continue;
    const at = declared.findIndex((part, i) => part !== kernel[i]);
    assert.ok(at < 0 || declared[at] > kernel[at], `${file} engines.node >=${declared.join(".")} is below the kernel's >=${kernel.join(".")}`);
  }
  return kernel.join(".");
}
export function checkPackages(root = ROOT) {
  const version = checkReleaseVersions(root);
  const kernel = dryRun(root);
  checkKernelPackFiles(kernel, root);
  const adapter = dryRun(resolve(root, "packages", "pi"));
  requireFiles(adapter, ["extension/index.ts", "extension/core-loader.mjs", "README.md", "package.json"]);
  assert.equal(kernel.version, version);
  assert.equal(adapter.version, version);
  return { version, kernelFiles: kernel.entryCount, adapterFiles: adapter.entryCount };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.slice(2).every((arg) => arg === "--syntax-only"), "usage: node scripts/check-package-dry-runs.mjs [--syntax-only]");
    if (process.argv.includes("--syntax-only")) console.log(`JavaScript syntax passed: ${checkJavaScript()} shipped/support files.`);
    else console.log(`Package dry runs passed: ${JSON.stringify(checkPackages())}; public curriculum present; Git-only optional package, capabilities, package mirrors and workspace state excluded.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
