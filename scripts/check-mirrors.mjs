#!/usr/bin/env node
// All package mirrors are generated from catalog-pinned Git objects. Verification
// is offline: inventories pin provenance, file sets, modes, bytes and symlinks.
// OKF retains its stricter release/wrapper inventory and materialization API.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkOkfMirror, payloadEntries } from "./check-okf-mirror.mjs";
import { currentRepoKey } from "../lib/repo-moves.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const INVENTORY_PATH = "scripts/mirror-source-inventory.json";
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
function safePath(path) {
  assert.ok(typeof path === "string" && path && !isAbsolute(path) && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path)
    && posix.normalize(path) === path && path.split("/").every(p => p && ![".", "..", ".git", "node_modules", ".agents"].includes(p)), `unsafe package path: ${path}`);
}
function exactUtf8(bytes) { const text = bytes.toString("utf8"); assert.ok(Buffer.from(text).equals(bytes), "package text must be lossless UTF-8"); return text; }
function regular(path) { assert.ok(lstatSync(path).isFile(), `expected regular file: ${path}`); }
function directory(path) { assert.ok(lstatSync(path).isDirectory(), `expected real directory: ${path}`); }
function catalogOf(root) { regular(join(root, "package-catalog.json")); return json(join(root, "package-catalog.json")).packages; }
function identity(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match ? `https://${currentRepoKey(`github.com/${match[1]}`)}.git` : url;
}
function git(source, args, encoding = "utf8") {
  const env = Object.fromEntries(["PATH", "SystemRoot", "PATHEXT", "TMPDIR", "TEMP", "TMP"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" });
  return execFileSync("git", ["--no-optional-locks", "-C", source, ...args], { env, encoding, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function manifestOf(text, id, pin) {
  const manifest = JSON.parse(text);
  assert.equal(manifest.package, id, "package identity differs from catalog");
  assert.equal(pin.ref, `v${manifest.version}`, "manifest version differs from catalog pin");
  assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length, "package exports no capabilities");
  const names = new Set();
  for (const cap of manifest.capabilities) {
    if (cap === ".") { assert.equal(manifest.capabilities.length, 1, "a root capability cannot overlap another export"); continue; }
    safePath(cap);
    assert.match(cap, /^capabilities\/[a-z0-9][a-z0-9-]*$/, "only exported capability directories may be mirrored");
    assert.ok(!names.has(mirrorName(cap, manifest.package)), "duplicate capability mirror"); names.add(mirrorName(cap, manifest.package));
  }
  return manifest;
}
const mirrorName = (cap, id) => { const name = cap === "." ? id.replaceAll(".", "-") : basename(cap); assert.match(name, /^[a-z0-9][a-z0-9-]*$/); return name; };
function entriesOf(root, manifest) {
  return manifest.capabilities.flatMap(cap => [{ path: cap, type: "directory" }, ...payloadEntries(join(root, "mirrors", mirrorName(cap, manifest.package))).map(e => ({ ...e, path: `${cap}/${e.path}` }))]).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function loadInventory(root) {
  const file = join(root, INVENTORY_PATH);
  if (!existsSync(file)) return { schemaVersion: 1, packages: {} };
  regular(file);
  const inventory = json(file);
  assert.equal(inventory.schemaVersion, 1, "unsupported mirror inventory schema");
  assert.ok(inventory.packages && typeof inventory.packages === "object" && !Array.isArray(inventory.packages));
  return inventory;
}
export function checkMirrors({ repoRoot = REPO_ROOT } = {}) {
  const catalog = catalogOf(repoRoot), inventory = loadInventory(repoRoot), packages = { ...inventory.packages }, expected = [];
  assert.ok(Object.keys(packages).length, "missing package mirror inventories; regenerate from catalog pins");
  for (const [id, record] of Object.entries(packages)) {
    assert.deepEqual(record.pin, catalog[id], `${id}: mirror catalog pin drift; regenerate deliberately`);
    assert.match(record.commit, oid); assert.match(record.tagObject, oid);
    const manifest = manifestOf(record.manifestText, id, record.pin);
    assert.equal(record.manifestSha256, sha256(record.manifestText), `${id}: manifest bytes drift`);
    assert.deepEqual(entriesOf(repoRoot, manifest), record.entries, `${id}: mirror payload drift (file-set/type/mode/bytes/target)`);
    for (const cap of manifest.capabilities) {
      const name = mirrorName(cap, manifest.package); expected.push(name);
      const capability = json(join(repoRoot, "mirrors", name, "oats.json"));
      assert.equal(capability.version, manifest.version, `${cap}: version differs from catalog`);
    }
  }
  // Preserve the OKF gate's immutable-release, wrapper and soul/trigger checks.
  if (existsSync(join(repoRoot, "scripts/okf-source-inventory.json"))) {
    const okf = checkOkfMirror({ repoRoot });
    assert.equal(catalog["oats.okf"]?.ref, `v${okf.version}`, "OKF catalog pin drift");
    assert.equal(okf.release.status, "published", "OKF mirror must come from the published catalog tag");
    assert.equal(okf.source.repository, catalog["oats.okf"].url, "OKF source differs from catalog");
    assert.equal(okf.distributionPath, catalog["oats.okf"].path);
    expected.push(...okf.mirrorPaths.map(path => basename(path))); packages["oats.okf"] = okf;
  }
  assert.equal(new Set(expected).size, expected.length, "two packages claim the same mirror");
  directory(join(repoRoot, "mirrors"));
  assert.deepEqual(readdirSync(join(repoRoot, "mirrors")).sort(), expected.sort(), "mirror directory set drift (unrecorded or missing mirror)");
  return packages;
}

/** Read only catalog-pinned Git objects, never the source checkout's bytes. */
export function generateMirror(id, source, { repoRoot = REPO_ROOT } = {}) {
  assert.notEqual(id, "oats.okf", "use check-okf-mirror.mjs --finalize for OKF's release inventory");
  const pin = catalogOf(repoRoot)[id];
  assert.ok(pin, `unknown catalog package: ${id}`); safePath(pin.path);
  const origins = git(source, ["remote", "get-url", "--all", "origin"]).trim().split("\n");
  assert.deepEqual(origins.map(identity), [identity(pin.url)], "source origin differs from catalog repository");
  const ref = `refs/tags/${pin.ref}`; git(source, ["check-ref-format", ref]);
  const tagObject = git(source, ["rev-parse", "--verify", ref]).trim();
  const commit = git(source, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  assert.match(tagObject, oid); assert.match(commit, oid);
  const published = new Map(git(source, [`--git-dir=${devNull}`, "ls-remote", "--exit-code", identity(pin.url), ref, `${ref}^{}`]).trim().split("\n").map(row => { const [hash, name] = row.split("\t"); return [name, hash]; }));
  assert.equal(published.get(ref), tagObject, "published catalog tag differs from local tag");
  assert.equal(published.get(`${ref}^{}`) ?? published.get(ref), commit, "published catalog tag resolves to another commit");
  const tree = `${commit}:${pin.path}`;
  const manifestText = exactUtf8(git(source, ["show", `${tree}/oats-package.json`], null));
  const manifest = manifestOf(manifestText, id, pin);
  directory(repoRoot); directory(join(repoRoot, "mirrors")); directory(join(repoRoot, "scripts"));
  const inventory = loadInventory(repoRoot);
  const prior = inventory.packages[id];
  if (prior && JSON.stringify(prior.pin) === JSON.stringify(pin)) {
    assert.equal(commit, prior.commit, "published catalog tag moved since prior generation");
    assert.equal(tagObject, prior.tagObject, "published catalog tag object moved since prior generation");
  }
  const output = join(repoRoot, INVENTORY_PATH);
  try { regular(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const cap of manifest.capabilities) {
    const dest = join(repoRoot, "mirrors", mirrorName(cap, manifest.package));
    try { directory(dest); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [otherId, record] of Object.entries(inventory.packages)) {
      if (otherId !== id) assert.ok(!JSON.parse(record.manifestText).capabilities.some(p => mirrorName(p, otherId) === mirrorName(cap, manifest.package)), `mirror already owned by ${otherId}: ${cap}`);
    }
  }
  mkdirSync(join(repoRoot, ".agents"), { recursive: true }); directory(join(repoRoot, ".agents"));
  const stage = mkdtempSync(join(repoRoot, ".agents/mirror-generation-"));
  try {
    for (const cap of manifest.capabilities) {
      const dest = join(stage, "mirrors", mirrorName(cap, manifest.package)); mkdirSync(dest, { recursive: true });
      const rows = git(source, ["ls-tree", "-r", "-t", "-z", cap === "." ? tree : `${tree}/${cap}`]).split("\0").filter(Boolean);
      for (const row of rows) {
        const at = row.indexOf("\t"), [mode, type, hash] = row.slice(0, at).split(" "), path = row.slice(at + 1);
        safePath(path); assert.match(hash, oid);
        const target = join(dest, path); mkdirSync(dirname(target), { recursive: true });
        if (type === "tree" && mode === "040000") mkdirSync(target, { recursive: true });
        else {
          assert.ok(type === "blob" && ["100644", "100755", "120000"].includes(mode), `unsupported Git entry: ${path}`);
          const bytes = git(source, ["cat-file", "blob", hash], null);
          if (mode === "120000") symlinkSync(exactUtf8(bytes), target);
          else { writeFileSync(target, bytes, { flag: "wx" }); chmodSync(target, mode === "100755" ? 0o755 : 0o644); }
        }
      }
    }
    const record = { pin, commit, tagObject, manifestText, manifestSha256: sha256(manifestText), entries: entriesOf(stage, manifest) };
    // Validate all symlinks, bytes and capability versions before replacing
    // any mirror directories. Old exports belonging to this package alone go.
    for (const cap of manifest.capabilities) {
      assert.equal(json(join(stage, "mirrors", mirrorName(cap, id), "oats.json")).version, manifest.version, `${cap}: capability version differs from catalog`);
    }
    const obsolete = prior ? JSON.parse(prior.manifestText).capabilities.map(cap => mirrorName(cap, id)).filter(name => !manifest.capabilities.some(cap => mirrorName(cap, id) === name)) : [];
    for (const name of obsolete) directory(join(repoRoot, "mirrors", name));
    for (const cap of manifest.capabilities) {
      const dest = join(repoRoot, "mirrors", mirrorName(cap, manifest.package));
      rmSync(dest, { recursive: true, force: true }); renameSync(join(stage, "mirrors", mirrorName(cap, manifest.package)), dest);
    }
    for (const name of obsolete) rmSync(join(repoRoot, "mirrors", name), { recursive: true });
    inventory.packages[id] = record;
    inventory.packages = Object.fromEntries(Object.entries(inventory.packages).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
    return record;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/** Fetch only the selected release tag into disposable build scratch. No
 * deployment clone, worktree, lock or package state is read or changed. */
export function generateRemoteMirror(id, { repoRoot = REPO_ROOT } = {}) {
  const pin = catalogOf(repoRoot)[id]; assert.ok(pin, `unknown catalog package: ${id}`);
  mkdirSync(join(repoRoot, ".agents"), { recursive: true }); directory(join(repoRoot, ".agents"));
  const source = mkdtempSync(join(repoRoot, ".agents/mirror-source-"));
  try {
    git(source, ["init", "--bare", "--quiet"]);
    git(source, ["remote", "add", "origin", identity(pin.url)]);
    const ref = `refs/tags/${pin.ref}`; git(source, ["check-ref-format", ref]);
    git(source, ["-c", `core.hooksPath=${devNull}`, "fetch", "--quiet", "--depth=1", "--no-recurse-submodules", "origin", `${ref}:${ref}`]);
    return generateMirror(id, source, { repoRoot });
  } finally { rmSync(source, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && args[0] === "--verify")) {
      console.log(`Package mirrors verified: ${Object.keys(checkMirrors()).join(", ")}`);
    } else {
      assert.ok([2, 3].includes(args.length) && args[0] === "--generate", "usage: check-mirrors.mjs [--verify | --generate <package-id> [source-clone]]");
      const record = args[2] ? generateMirror(args[1], args[2]) : generateRemoteMirror(args[1]); console.log(`Generated ${args[1]} from ${record.pin.ref} @ ${record.commit}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
