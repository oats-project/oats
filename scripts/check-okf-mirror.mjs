#!/usr/bin/env node
// The combined scripts/check-mirrors.mjs gate extends this payload walker to
// every catalog-pinned mirror; OKF retains its stricter release provenance.
// The standalone distribution is authoritative; this is a byte mirror, not a
// second authoring surface. CI verifies the checked-in inventory without Git,
// network access or a sibling clone. Source operations read Git; --finalize and
// finalized --verify-source also query origin (read-only, never fetch/push).
//
// node scripts/check-okf-mirror.mjs [--verify] [--repo-root <framework>]
// node scripts/check-okf-mirror.mjs --generate --source <standalone-repo> [--repo-root <framework>]
// node scripts/check-okf-mirror.mjs --verify-source --source <standalone-repo> [--repo-root <framework>]
// node scripts/check-okf-mirror.mjs --finalize --source <standalone-repo> --final-tag v2.0.0 --final-commit <full-oid>
// --generate/--finalize replace ONLY the mirrors/oats-okf* directories (the
// capabilities the package exports) and the inventory. The package's souls/ and
// triggers/ files are recorded in the inventory as exact text (like the wrappers), never mirrored
// into this repository: the kernel reads a package's souls and triggers from Git
// at its locked commit, and a souls/ copy here would be discovered as this
// repository's own member souls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { currentRepoKey } from "../lib/repo-moves.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// okf 4.0.0 exports three capabilities: the knowledge slot (oats.okf) and the
// harvester and maintainer capabilities its package souls take.
export const CAPABILITY_PATHS = ["capabilities/oats-okf", "capabilities/oats-okf-harvest", "capabilities/oats-okf-maintenance"];
export const CAPABILITY_PATH = CAPABILITY_PATHS[0];
// Where this repository keeps the mirror: mirrors/<dir>, never capabilities/<dir>.
// Member discovery reads every capabilities/*/oats.json of a member at its latest
// state, so a mirror there would be offered a second time, as a member
// capability of this repository beside its package. Inventory entries keep the
// package-relative paths above (what the release tag attests); MIRROR_PATHS
// says where each exported capability sits here.
export const MIRROR_ROOT = "mirrors";
export const mirrorPath = (cap) => `${MIRROR_ROOT}/${posix.basename(cap)}`;
export const MIRROR_PATHS = CAPABILITY_PATHS.map(mirrorPath);
const CAPABILITY_IDS = { "capabilities/oats-okf": "oats.okf", "capabilities/oats-okf-harvest": "oats.okf-harvest", "capabilities/oats-okf-maintenance": "oats.okf-maintenance" };
export const DISTRIBUTION_PATH = "oats-package";
export const INVENTORY_PATH = "scripts/okf-source-inventory.json";
const SOURCE_REPOSITORY = "https://github.com/awebai/oats-okf.git";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function contained(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function plainDirectory(path) {
  assert.ok(lstatSync(path).isDirectory(), `expected real directory, not symlink: ${path}`);
}
function plainFile(path) {
  assert.ok(lstatSync(path).isFile(), `expected regular file, not symlink: ${path}`);
}
function safeRelative(path) {
  assert.ok(typeof path === "string" && path && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path)
    && !isAbsolute(path) && posix.normalize(path) === path
    && path.split("/").every((part) => part && ![".", "..", ".git", "node_modules", ".agents"].includes(part)), `unsafe payload path: ${path}`);
}
function exactUtf8(bytes, label) {
  const text = bytes.toString("utf8");
  assert.ok(Buffer.from(text, "utf8").equals(bytes), `${label} must be lossless UTF-8`);
  return text;
}
function wrapperText(root, name) {
  const path = join(root, name);
  plainFile(path);
  return exactUtf8(readFileSync(path), name);
}
function manifestFrom(text) {
  const manifest = JSON.parse(text);
  assert.equal(manifest.package, "oats.okf", "wrong standalone package identity");
  assert.deepEqual(Object.keys(manifest).sort(compare), ["capabilities", "compatibility", "description", "package", "souls", "triggers", "version"], "new distribution surfaces require explicit mirror review");
  // Deliberately exact enumeration: never walk the authoring repo, copy stale
  // root-level runtime copies, accept traversal or silently add another export.
  assert.deepEqual(manifest.capabilities, CAPABILITY_PATHS, `standalone must export exactly ${CAPABILITY_PATHS.join(", ")}`);
  assert.ok(Array.isArray(manifest.souls) && manifest.souls.length > 0, "standalone souls must be a non-empty list");
  for (const soul of manifest.souls) { safeRelative(soul); assert.match(soul, /^souls\/[a-z0-9][a-z0-9-]*$/, `package soul outside souls/: ${soul}`); }
  assert.ok(Array.isArray(manifest.triggers), "standalone triggers must be a list");
  for (const trigger of manifest.triggers) {
    assert.deepEqual(Object.keys(trigger ?? {}).sort(compare), ["file", "id"], "a trigger entry is { id, file }");
    safeRelative(trigger.file); assert.match(trigger.file, /^triggers\/[^/]+\.json$/, `package trigger outside triggers/: ${trigger.file}`);
  }
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  return manifest;
}

// Git tracks executable vs non-executable, not uid/gid or umask-dependent write
// bits. Use its portable regular-file modes; symlink permissions are irrelevant.
// Directories are recorded too, so even empty obsolete extras fail verification.
export function payloadEntries(capabilityRoot) {
  plainDirectory(capabilityRoot);
  const root = realpathSync(capabilityRoot);
  const entries = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort(compare)) {
      const path = join(dir, name);
      const rel = relative(root, path).split(sep).join("/");
      safeRelative(rel);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push({ path: rel, type: "directory" });
        walk(path);
      } else if (stat.isFile()) {
        const bytes = readFileSync(path);
        entries.push({ path: rel, type: "file", mode: stat.mode & 0o111 ? "100755" : "100644", size: bytes.length, sha256: sha256(bytes) });
      } else if (stat.isSymbolicLink()) {
        const bytes = readlinkSync(path, { encoding: "buffer" });
        const target = exactUtf8(bytes, `symlink ${rel}`);
        assert.ok(target && !isAbsolute(target) && !target.includes("\\") && !/[\x00-\x1f\x7f]/.test(target), `unsafe symlink target: ${rel}`);
        assert.ok(contained(root, resolve(dirname(path), target)), `symlink escapes payload: ${rel}`);
        const final = realpathSync(path); // Broken links/cycles fail; never crawl them.
        assert.ok(contained(root, final), `symlink escapes payload: ${rel}`);
        plainFile(final);
        entries.push({ path: rel, type: "symlink", mode: "120000", target, size: bytes.length, sha256: sha256(bytes) });
      } else assert.fail(`unsupported payload entry: ${rel}`);
    }
  }
  walk(root);
  return entries.sort((a, b) => compare(a.path, b.path));
}
/** The directory holding exported capability `cap` under `root`: a distribution
 * root (the standalone oats-package/, a materialized copy) holds it at `cap`;
 * this repository (`mirror`) holds it at mirrorPath(cap). */
function capabilityDir(root, cap, { mirror = false } = {}) {
  return join(root, mirror ? mirrorPath(cap) : cap);
}
/** The mirrored capability payload, with package-relative paths, read from a
 * distribution root or (`mirror`) from this repository's mirrors/. */
export function distributionEntries(root, { mirror = false } = {}) {
  return CAPABILITY_PATHS.flatMap((cap) => [{ path: cap, type: "directory" }, ...payloadEntries(capabilityDir(root, cap, { mirror })).map((entry) => ({ ...entry, path: `${cap}/${entry.path}` }))])
    .sort((a, b) => compare(a.path, b.path));
}
/** One exported capability's inventory entries, relative to that capability
 * (what a materialized module directory of it holds). */
export function capabilityEntries(inventory, cap = CAPABILITY_PATH) {
  assert.ok(CAPABILITY_PATHS.includes(cap), `not an exported capability: ${cap}`);
  return inventory.entries.filter((entry) => entry.path.startsWith(`${cap}/`)).map((entry) => ({ ...entry, path: entry.path.slice(cap.length + 1) }));
}
/** The package's souls and trigger files (regular UTF-8 files only), read from a
 * distribution directory. → [{ path, mode, size, sha256, text }] sorted. */
function distributionFilesOf(distribution, manifest) {
  const files = [];
  for (const soul of manifest.souls) {
    for (const entry of payloadEntries(join(distribution, soul))) {
      if (entry.type === "directory") continue;
      assert.equal(entry.type, "file", `package soul files must be regular files: ${soul}/${entry.path}`);
      files.push(`${soul}/${entry.path}`);
    }
  }
  for (const { file } of manifest.triggers) files.push(file);
  return [...new Set(files)].sort(compare).map((path) => {
    const full = join(distribution, path);
    plainFile(full);
    const bytes = readFileSync(full);
    return { path, mode: lstatSync(full).mode & 0o111 ? "100755" : "100644", size: bytes.length, sha256: sha256(bytes), text: exactUtf8(bytes, path) };
  });
}
function snapshotHash(inventory) {
  return sha256(JSON.stringify({
    distributionManifestText: inventory.distributionManifestText,
    distributionLicenseText: inventory.distributionLicenseText,
    // Optional only for legacy pending snapshots; finalized wrappers include
    // Git modes as well as bytes, without invalidating checked-in dev hashes.
    ...(inventory.distributionManifestMode === undefined ? {} : { distributionManifestMode: inventory.distributionManifestMode }),
    ...(inventory.distributionLicenseMode === undefined ? {} : { distributionLicenseMode: inventory.distributionLicenseMode }),
    entries: inventory.entries,
    distributionFiles: inventory.distributionFiles,
  }));
}
function validateInventory(inventory) {
  assert.equal(inventory.schemaVersion, 2, "unsupported OKF inventory schema");
  assert.equal(inventory.distributionPath, DISTRIBUTION_PATH);
  assert.deepEqual(inventory.capabilityPaths, CAPABILITY_PATHS);
  assert.deepEqual(inventory.mirrorPaths, MIRROR_PATHS, "the inventory must record where this repository mirrors each exported capability");
  assert.equal(typeof inventory.source.repository, "string");
  assert.ok(inventory.source.repository.length > 0, "missing source repository");
  assert.match(inventory.source.head, OBJECT_ID);
  assert.equal(typeof inventory.source.branch, "string");
  assert.equal(typeof inventory.source.dirty, "boolean");
  assert.ok(Array.isArray(inventory.source.workingTreeStatus));
  assert.equal(inventory.source.dirty, inventory.source.workingTreeStatus.length > 0);
  const manifest = manifestFrom(inventory.distributionManifestText);
  assert.equal(inventory.version, manifest.version);
  const release = inventory.release;
  const pending = { status: "pending", finalMergedCommit: null, plannedTag: `v${manifest.version}`, finalTag: null, published: false };
  if (release?.status === "pending") {
    assert.equal(inventory.source.repository, SOURCE_REPOSITORY);
    assert.deepEqual(release, pending, "pending inventory cannot claim publication");
  } else {
    assert.equal(release?.status, "published", "unsupported release provenance status");
    assert.match(release.tagObject, OBJECT_ID);
    assert.deepEqual(release, {
      ...pending, status: "published", finalMergedCommit: inventory.source.head,
      finalTag: pending.plannedTag, published: true, remote: "origin", tagObject: release.tagObject,
    }, "inconsistent immutable release provenance");
    assert.equal(inventory.source.dirty, false, "published inventory must have a clean source tree");
    for (const mode of [inventory.distributionManifestMode, inventory.distributionLicenseMode]) {
      assert.ok(["100644", "100755"].includes(mode), "published inventory must record wrapper file modes");
    }
  }
  assert.equal(inventory.distributionManifestSha256, sha256(inventory.distributionManifestText), "distribution manifest bytes drift");
  assert.equal(typeof inventory.distributionLicenseText, "string");
  assert.ok(inventory.distributionLicenseText.length > 0, "missing distribution license bytes");
  assert.equal(inventory.distributionLicenseSha256, sha256(inventory.distributionLicenseText), "distribution license bytes drift");
  assert.ok(Array.isArray(inventory.entries) && inventory.entries.length > 0);
  const paths = inventory.entries.map((entry) => entry.path);
  paths.forEach(safeRelative);
  assert.deepEqual(paths, [...new Set(paths)].sort(compare), "inventory paths must be unique and sorted");
  for (const path of paths) assert.ok(CAPABILITY_PATHS.some((cap) => path === cap || path.startsWith(`${cap}/`)), `inventory entry outside the exported capabilities: ${path}`);
  assert.ok(Array.isArray(inventory.distributionFiles) && inventory.distributionFiles.length > 0, "missing package soul/trigger files");
  const files = inventory.distributionFiles.map((file) => file.path);
  files.forEach(safeRelative);
  assert.deepEqual(files, [...new Set(files)].sort(compare), "distribution file paths must be unique and sorted");
  for (const file of inventory.distributionFiles) {
    assert.deepEqual(Object.keys(file).sort(compare), ["mode", "path", "sha256", "size", "text"], `distribution file shape: ${file.path}`);
    assert.ok(["100644", "100755"].includes(file.mode), `distribution file mode: ${file.path}`);
    assert.ok(manifest.souls.some((soul) => file.path.startsWith(`${soul}/`)) || manifest.triggers.some((trigger) => trigger.file === file.path), `distribution file outside the package souls/triggers: ${file.path}`);
    assert.equal(file.sha256, sha256(file.text), `distribution file bytes drift: ${file.path}`);
    assert.equal(file.size, Buffer.byteLength(file.text, "utf8"), `distribution file size drift: ${file.path}`);
  }
  for (const soul of manifest.souls) assert.ok(files.includes(`${soul}/soul.yaml`), `package soul without soul.yaml: ${soul}`);
  for (const { file } of manifest.triggers) assert.ok(files.includes(file), `package trigger file missing: ${file}`);
  assert.equal(inventory.snapshotSha256, snapshotHash(inventory), "inventory snapshot hash drift");
  return inventory;
}

/** root holds the exported capability directories: a distribution root, or
 * (`mirror`) this repository, whose copies live under mirrors/. */
export function checkOkfPayload(root, inventory, { mirror = false } = {}) {
  validateInventory(inventory);
  const actual = distributionEntries(root, { mirror });
  const expectedPaths = inventory.entries.map((entry) => entry.path);
  const actualPaths = actual.map((entry) => entry.path);
  assert.deepEqual(actualPaths, expectedPaths, "OKF payload file-set drift (missing/extra/obsolete entry)");
  for (let i = 0; i < actual.length; i++) {
    assert.deepEqual(actual[i], inventory.entries[i], `OKF payload drift: ${actual[i].path} (type/mode/bytes/target)`);
  }
  for (const cap of CAPABILITY_PATHS) {
    const capability = JSON.parse(readFileSync(join(capabilityDir(root, cap, { mirror }), "oats.json"), "utf8"));
    assert.equal(capability.capability, CAPABILITY_IDS[cap], `wrong capability identity in ${cap}`);
    assert.equal(capability.version, inventory.version, `capability version drift in ${cap}`);
  }
  return inventory;
}

export function checkOkfMirror({ repoRoot = REPO_ROOT } = {}) {
  plainDirectory(join(repoRoot, MIRROR_ROOT));
  const path = join(repoRoot, INVENTORY_PATH);
  plainFile(path);
  const inventory = JSON.parse(readFileSync(path, "utf8"));
  return checkOkfPayload(repoRoot, inventory, { mirror: true });
}

/** destination is the distribution root (e.g. <fixture-git-repo>/oats-package).
 * It must be absent or an empty real directory. No npm alias repair or wrapper
 * synthesis: preserve the verified Git symlink and the recorded wrapper bytes.
 */
export function materializeOkfGitPayload(destination, { repoRoot = REPO_ROOT } = {}) {
  const inventory = checkOkfMirror({ repoRoot });
  const mirrors = CAPABILITY_PATHS.map((cap) => realpathSync(capabilityDir(repoRoot, cap, { mirror: true })));
  // Resolve an absent destination through its nearest existing ancestor before
  // making directories, so an alias cannot accidentally write into the mirror.
  let ancestor = resolve(destination);
  while (true) {
    try { lstatSync(ancestor); break; } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  const resolvedDestination = resolve(realpathSync(ancestor), relative(ancestor, resolve(destination)));
  for (const mirror of mirrors) assert.ok(!contained(mirror, resolvedDestination) && !contained(resolvedDestination, mirror), "payload destination and source mirror must not overlap");
  mkdirSync(destination, { recursive: true });
  plainDirectory(destination);
  assert.deepEqual(readdirSync(destination), [], "OKF payload destination must be empty");
  for (const cap of CAPABILITY_PATHS) cpSync(capabilityDir(repoRoot, cap, { mirror: true }), join(destination, cap), { recursive: true, verbatimSymlinks: true });
  for (const file of inventory.distributionFiles) {
    mkdirSync(dirname(join(destination, file.path)), { recursive: true });
    writeFileSync(join(destination, file.path), file.text, { flag: "wx" });
    chmodSync(join(destination, file.path), file.mode === "100755" ? 0o755 : 0o644);
  }
  writeFileSync(join(destination, "oats-package.json"), inventory.distributionManifestText, { flag: "wx" });
  writeFileSync(join(destination, "LICENSE"), inventory.distributionLicenseText, { flag: "wx" });
  for (const [file, mode] of [["oats-package.json", inventory.distributionManifestMode], ["LICENSE", inventory.distributionLicenseMode]]) {
    if (mode) chmodSync(join(destination, file), mode === "100755" ? 0o755 : 0o644);
  }
  assert.deepEqual(distributionFilesOf(destination, manifestFrom(inventory.distributionManifestText)), inventory.distributionFiles, "materialized package soul/trigger drift");
  return checkOkfPayload(destination, inventory);
}

function sourceGit(root, args, encoding = "utf8") {
  // Read-only Git, no optional index refresh, prompts or host Git config.
  // Do not inherit GIT_DIR/WORK_TREE/INDEX_FILE or injected -c settings.
  const env = Object.fromEntries(["PATH", "SystemRoot", "PATHEXT", "TMPDIR", "TEMP", "TMP"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
  return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "credential.helper=", "-C", root, ...args], { env, encoding, maxBuffer: 64 * 1024 * 1024, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}
function sourceState(root) {
  assert.equal(sourceGit(root, ["rev-parse", "--show-prefix"]).trim(), "", "--source must name the standalone repository root");
  const workingTreeStatus = sourceGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])
    .split("\0").filter(Boolean).map((row) => ({ status: row.slice(0, 2), path: row.slice(3) }))
    .sort((a, b) => compare(a.path, b.path));
  for (const row of workingTreeStatus) {
    assert.ok(!isAbsolute(row.path) && !row.path.includes("\0"), "Git status must contain repository-relative paths only");
  }
  return {
    repository: SOURCE_REPOSITORY,
    branch: sourceGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    head: sourceGit(root, ["rev-parse", "HEAD"]).trim(),
    dirty: workingTreeStatus.length > 0,
    workingTreeStatus,
  };
}

/** Reads actual working bytes, including untracked exported files, not HEAD blobs.
 * No timestamp, local clone path or author-machine identity enters the inventory.
 * A working snapshot is NOT proof of a final merged commit or a published tag.
 */
export function generateOkfSourceInventory(standaloneRoot) {
  assert.ok(typeof standaloneRoot === "string" && standaloneRoot, "explicit --source standalone repository path is required");
  const source = realpathSync(standaloneRoot);
  const before = sourceState(source);
  const distribution = join(source, DISTRIBUTION_PATH);
  plainDirectory(distribution);
  plainDirectory(join(distribution, "capabilities"));
  const distributionManifestText = wrapperText(distribution, "oats-package.json");
  const manifest = manifestFrom(distributionManifestText);
  const distributionLicenseText = wrapperText(distribution, "LICENSE");
  const inventory = {
    schemaVersion: 2,
    generatedBy: "scripts/check-okf-mirror.mjs --generate --source <standalone-repository>",
    distributionPath: DISTRIBUTION_PATH,
    capabilityPaths: CAPABILITY_PATHS,
    mirrorPaths: MIRROR_PATHS,
    version: manifest.version,
    source: before,
    release: { status: "pending", finalMergedCommit: null, plannedTag: `v${manifest.version}`, finalTag: null, published: false },
    distributionManifestText,
    distributionManifestSha256: sha256(distributionManifestText),
    distributionLicenseText,
    distributionLicenseSha256: sha256(distributionLicenseText),
    entries: distributionEntries(distribution),
    distributionFiles: distributionFilesOf(distribution, manifest),
  };
  inventory.snapshotSha256 = snapshotHash(inventory);
  assert.deepEqual(sourceState(source), before, "standalone Git state changed during inventory generation; retry");
  return checkOkfPayload(distribution, inventory);
}

// Canonical GitHub transports identify the same repository. Do not silently
// accept an origin rewritten via insteadOf to some unrelated remote. The
// expected repository is injectable through the JS API for local bare fixtures;
// the release CLI always requires the official source repository. A clone may
// name it under either spelling of its move (lib/repo-moves.mjs): the identity,
// and so the inventory's provenance, stays SOURCE_REPOSITORY.
const SOURCE_URLS = ["github.com/awebai/oats-okf", currentRepoKey("github.com/awebai/oats-okf")]
  .map((key) => key.slice("github.com/".length))
  .flatMap((path) => [`https://github.com/${path}.git`, `https://github.com/${path}`, `git@github.com:${path}.git`, `git@github.com:${path}`, `ssh://git@github.com/${path}.git`, `ssh://git@github.com/${path}`]);
export function repositoryIdentity(url) {
  return SOURCE_URLS.includes(url) ? SOURCE_REPOSITORY : url;
}
function publishedRef(source, finalTag, finalCommit, repository) {
  const origins = sourceGit(source, ["remote", "get-url", "--all", "origin"]).trim().split("\n");
  assert.equal(origins.length, 1, "source must have exactly one origin fetch URL");
  assert.equal(repositoryIdentity(origins[0]), repositoryIdentity(repository), "source origin does not match expected repository");
  const ref = `refs/tags/${finalTag}`;
  sourceGit(source, ["check-ref-format", ref]);
  const tagObject = sourceGit(source, ["rev-parse", "--verify", ref]).trim();
  assert.match(tagObject, OBJECT_ID);
  assert.equal(sourceGit(source, ["rev-parse", "--verify", `${ref}^{commit}`]).trim(), finalCommit, "local final tag does not resolve to accepted final commit");
  // Query the origin URL, NOT a cached remote-tracking ref. Disable local Git
  // config for this query (e.g. custom upload-pack/SSH commands cannot fabricate
  // refs). Official SSH/HTTPS origins are queried over canonical public HTTPS.
  // Annotated tags must match object + peeled commit; lightweight tags advertise
  // the commit directly. No network is used by ordinary --verify.
  const rows = sourceGit(source, [`--git-dir=${devNull}`, "ls-remote", "--exit-code", repositoryIdentity(origins[0]), ref, `${ref}^{}`]).trim().split("\n");
  const remote = new Map();
  for (const row of rows) {
    const [oid, name] = row.split("\t");
    assert.match(oid, OBJECT_ID);
    assert.ok([ref, `${ref}^{}`].includes(name) && !remote.has(name), "unexpected published tag response");
    remote.set(name, oid);
  }
  assert.equal(remote.get(ref), tagObject, "published origin tag object differs from local final tag");
  assert.equal(remote.get(`${ref}^{}`) ?? remote.get(ref), finalCommit, "published origin tag does not resolve to accepted final commit");
  return tagObject;
}

function gitTree(source, tree, paths = []) {
  return exactUtf8(sourceGit(source, ["ls-tree", "-r", "-t", "-z", tree, "--", ...paths], null), "Git tree paths").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const path = row.slice(tab + 1);
    safeRelative(path);
    assert.match(oid, OBJECT_ID);
    return { mode, type, oid, path };
  });
}
function commitPayload(source, commit) {
  return CAPABILITY_PATHS.flatMap((cap) => [{ path: cap, type: "directory" }, ...commitTree(source, commit, cap).map((entry) => ({ ...entry, path: `${cap}/${entry.path}` }))])
    .sort((a, b) => compare(a.path, b.path));
}
/** The package souls/trigger files at the commit, as the inventory records them. */
function commitDistributionFiles(source, commit, inventory) {
  return inventory.distributionFiles.map(({ path }) => {
    const [entry] = gitTree(source, `${commit}:${DISTRIBUTION_PATH}`, [path]).filter((e) => e.path === path);
    assert.ok(entry?.type === "blob" && ["100644", "100755"].includes(entry.mode), `committed package file must be a regular file: ${path}`);
    const bytes = sourceGit(source, ["cat-file", "blob", entry.oid], null);
    return { path, mode: entry.mode, size: bytes.length, sha256: sha256(bytes), text: exactUtf8(bytes, `committed ${path}`) };
  });
}
function commitTree(source, commit, dir) {
  return gitTree(source, `${commit}:${DISTRIBUTION_PATH}/${dir}`).map(({ mode, type, oid, path }) => {
    if (mode === "040000" && type === "tree") return { path, type: "directory" };
    assert.ok(type === "blob" && ["100644", "100755", "120000"].includes(mode), `unsupported committed payload entry: ${path}`);
    // Raw objects bypass checkout filters, CRLF normalization, ignored files,
    // assume-unchanged/skip-worktree and core.filemode=false false-clean states.
    const bytes = sourceGit(source, ["cat-file", "blob", oid], null);
    return mode === "120000"
      ? { path, type: "symlink", mode, target: exactUtf8(bytes, `committed symlink ${path}`), size: bytes.length, sha256: sha256(bytes) }
      : { path, type: "file", mode, size: bytes.length, sha256: sha256(bytes) };
  }).sort((a, b) => compare(a.path, b.path));
}
function finalSourceInventory(standaloneRoot, { finalTag, finalCommit, repository = SOURCE_REPOSITORY } = {}) {
  assert.ok(typeof finalTag === "string" && finalTag, "explicit --final-tag is required for finalization");
  assert.ok(typeof finalCommit === "string" && OBJECT_ID.test(finalCommit), "explicit --final-commit must be a full immutable commit ID");
  const inventory = generateOkfSourceInventory(standaloneRoot);
  const source = realpathSync(standaloneRoot);
  const before = inventory.source;
  assert.equal(before.dirty, false, "finalization requires a clean accepted source tree");
  assert.equal(before.head, finalCommit, "source HEAD must be the accepted final commit");
  assert.equal(finalTag, inventory.release.plannedTag, "final tag must match distribution version");
  assert.deepEqual(commitPayload(source, finalCommit), inventory.entries, "working payload differs from immutable commit (file-set/type/mode/bytes/target)");
  assert.deepEqual(commitDistributionFiles(source, finalCommit, inventory), inventory.distributionFiles, "working package souls/triggers differ from immutable commit");
  const committedSouls = new Set(gitTree(source, `${finalCommit}:${DISTRIBUTION_PATH}`, manifestFrom(inventory.distributionManifestText).souls).filter((e) => e.type === "blob").map((e) => e.path));
  assert.deepEqual([...committedSouls].sort(compare), inventory.distributionFiles.map((f) => f.path).filter((p) => p.startsWith("souls/")), "committed package soul file-set differs from the working tree");
  const wrappers = gitTree(source, `${finalCommit}:${DISTRIBUTION_PATH}`, ["oats-package.json", "LICENSE"]);
  for (const [file, field] of [["oats-package.json", "distributionManifest"], ["LICENSE", "distributionLicense"]]) {
    const entry = wrappers.find((entry) => entry.path === file);
    assert.ok(entry?.type === "blob" && ["100644", "100755"].includes(entry.mode), `committed wrapper must be a regular file: ${file}`);
    assert.deepEqual(sourceGit(source, ["cat-file", "blob", entry.oid], null), Buffer.from(inventory[`${field}Text`]), `working wrapper bytes differ from immutable commit: ${file}`);
    const mode = lstatSync(join(source, DISTRIBUTION_PATH, file)).mode & 0o111 ? "100755" : "100644";
    assert.equal(mode, entry.mode, `working wrapper mode differs from immutable commit: ${file}`);
    inventory[`${field}Mode`] = mode;
  }
  assert.ok(sourceGit(source, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean).every((row) => !/[a-zS]/.test(row[0])), "finalization requires an unmasked source index (no assume-unchanged/skip-worktree)");
  const tagObject = publishedRef(source, finalTag, finalCommit, repository);
  assert.deepEqual(sourceState(source), before, "standalone Git state changed during finalization; retry");
  inventory.generatedBy = "scripts/check-okf-mirror.mjs --finalize --source <standalone-repository> --final-tag <tag> --final-commit <full-oid>";
  inventory.source = { ...before, repository: repositoryIdentity(repository) };
  inventory.release = {
    status: "published", finalMergedCommit: finalCommit, plannedTag: inventory.release.plannedTag,
    finalTag, published: true, remote: "origin", tagObject,
  };
  inventory.snapshotSha256 = snapshotHash(inventory);
  return checkOkfPayload(join(source, DISTRIBUTION_PATH), inventory);
}

export function verifyOkfSource(standaloneRoot, { repoRoot = REPO_ROOT, repository = SOURCE_REPOSITORY } = {}) {
  const inventory = checkOkfMirror({ repoRoot });
  if (inventory.release.status === "pending") {
    assert.deepEqual(generateOkfSourceInventory(standaloneRoot), inventory, "standalone working snapshot/provenance differs; regenerate deliberately");
  } else {
    const actual = finalSourceInventory(standaloneRoot, { finalTag: inventory.release.finalTag, finalCommit: inventory.release.finalMergedCommit, repository });
    // A branch rename or detached checkout is not a change to immutable source.
    assert.deepEqual({ ...actual, source: { ...actual.source, branch: inventory.source.branch } }, inventory, "immutable source/payload provenance differs");
  }
  return inventory;
}

export function syncOkfMirror(standaloneRoot, { repoRoot = REPO_ROOT } = {}) {
  return syncInventory(standaloneRoot, repoRoot, () => generateOkfSourceInventory(standaloneRoot));
}

/** Finalization is a verified re-sync, never a boolean metadata stamp. It needs
 * an explicit accepted commit + version tag, clean matching Git blobs, and the
 * actual origin ref. The caller supplies acceptance; Git cannot prove PR review.
 */
export function finalizeOkfMirror(standaloneRoot, { repoRoot = REPO_ROOT, ...options } = {}) {
  return syncInventory(standaloneRoot, repoRoot, () => finalSourceInventory(standaloneRoot, options));
}

function syncInventory(standaloneRoot, repoRoot, makeInventory) {
  const inventory = makeInventory();
  const repo = realpathSync(repoRoot);
  const source = realpathSync(standaloneRoot);
  const destinations = CAPABILITY_PATHS.map((cap) => capabilityDir(repo, cap, { mirror: true }));
  for (const destination of destinations) assert.ok(!contained(destination, source) && !contained(source, destination), "source and mirror must not overlap");
  plainDirectory(join(repo, MIRROR_ROOT));
  plainDirectory(join(repo, "scripts"));
  const output = join(repo, INVENTORY_PATH);
  // Reject links (including dangling links) before replacing anything.
  for (const [path, type] of [...destinations.map((destination) => [destination, "directory"]), [output, "file"]]) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) assert.ok(type === "directory" ? stat.isDirectory() : stat.isFile(), `unsafe mirror destination: ${path}`);
  }
  const staging = mkdtempSync(join(repo, `${MIRROR_ROOT}/.okf-mirror-`));
  try {
    const staged = join(staging, "payload");
    for (const cap of CAPABILITY_PATHS) cpSync(join(source, DISTRIBUTION_PATH, cap), join(staged, cap), { recursive: true, verbatimSymlinks: true });
    checkOkfPayload(staged, inventory);
    assert.deepEqual(makeInventory(), inventory, "standalone changed during copy; mirror left untouched");
    for (const [i, cap] of CAPABILITY_PATHS.entries()) {
      rmSync(destinations[i], { recursive: true, force: true });
      renameSync(join(staged, cap), destinations[i]);
    }
    writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return checkOkfMirror({ repoRoot: repo });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let mode = "--verify", source, finalTag, finalCommit, repoRoot = REPO_ROOT;
    const seen = new Set();
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      assert.ok(!seen.has(arg), `duplicate option: ${arg}`);
      seen.add(arg);
      if (["--verify", "--generate", "--verify-source", "--finalize"].includes(arg)) {
        assert.ok(!seen.has("mode"), "choose one verification/generation mode");
        seen.add("mode"); mode = arg;
      } else if (["--source", "--repo-root", "--final-tag", "--final-commit"].includes(arg)) {
        const value = args[++i];
        assert.ok(value && !value.startsWith("--"), `${arg} requires a value`);
        if (arg === "--source") source = value;
        else if (arg === "--repo-root") repoRoot = value;
        else if (arg === "--final-tag") finalTag = value;
        else finalCommit = value;
      } else assert.fail(`unknown option: ${arg}`);
    }
    assert.ok(mode === "--verify" ? !source : !!source, mode === "--verify" ? "--source requires --generate, --finalize or --verify-source" : "explicit --source standalone repository path is required");
    assert.ok(mode === "--finalize" || (!finalTag && !finalCommit), "--final-tag/--final-commit require --finalize");
    const inventory = mode === "--generate" ? syncOkfMirror(source, { repoRoot })
      : mode === "--finalize" ? finalizeOkfMirror(source, { repoRoot, finalTag, finalCommit })
        : mode === "--verify-source" ? verifyOkfSource(source, { repoRoot }) : checkOkfMirror({ repoRoot });
    console.log(JSON.stringify({ ok: true, version: inventory.version, entries: inventory.entries.length, distributionFiles: inventory.distributionFiles.length, snapshotSha256: inventory.snapshotSha256, sourceHead: inventory.source.head, sourceDirty: inventory.source.dirty, release: inventory.release }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
