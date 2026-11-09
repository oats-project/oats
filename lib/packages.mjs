/**
 * OATS packages — versions, lock v3 (workspace model v2).
 *
 * Contract: docs/design/2026-09-23-workspace-module-contracts.md §4.
 * Decision: https://github.com/awebai/oats-knowledge/blob/main/knowledge/nodes/oats-maintainer/decisions/workspace-model-v2.md.
 *
 * A package is a place to fetch from WITH a version attached. Nothing is
 * installed: `resolvePackages` turns each `workspace.packages` entry into an
 * exact (commit, integrity) pair recorded in `oats-lock.json`
 * (lockfileVersion 3). There is no approval step (human decision 2026-09-24):
 * declaring a package in the workspace's `packages:` IS the trust decision. The
 * lock is reproducibility — a moved tag (same version string, different commit)
 * or drifted content fails integrity (E_PACKAGE_INTEGRITY).
 *
 * This module is synchronous except `resolvePackages`, shells out to nothing,
 * and depends only on `node:*`. Remote access is INJECTED (`remote` option) so
 * callers pass `lib/remote.mjs` and tests pass an in-memory fake.
 *
 * Lock v3 shape (exactly as the contract):
 *
 *   {
 *     lockfileVersion: 3,
 *     packages: {
 *       <id>: {
 *         source:       "catalog:<id>" | "git:<key>@<ref>",
 *         url:          "<repo url the package was read from>",   // repo identity: resolve/materialize need no catalog
 *         path:         "<dir of oats-package.json inside the repo>",
 *         version:      "<version string, no leading v>",
 *         commit:       "<full 40-hex OID>",
 *         integrity:    "sha256-<hex>",          // contentDigest of the package tree at <path>
 *         capabilities: ["<cap name>", …],        // sorted
 *         souls: [{ name, path, digest }]         // package souls (0.28.0), sorted by name; omitted when none
 *       }
 *     }
 *   }
 *
 * A lock written before 0.26.0 may still carry an `approved` record per entry:
 * it is read with the field ignored, and the next write drops it.
 *
 * Deprecated shims: every name the 0.24 kernel still imports from this module
 * is exported below as a thin function throwing E_REMOVED so nothing breaks at
 * import time; callers are deleted in the next phase.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { recordLocalInput } from "./local-inputs.mjs";
import { oatsError as baseOatsError } from "./errors.mjs";
import * as defaultRemote from "./remote.mjs";
import { manifestContractProblems } from "./capability-contract.mjs";
import { writeFileAtomic } from "./write-file-atomic.mjs";
import { sameRepo } from "./repo-moves.mjs";
export { writeFileAtomic } from "./write-file-atomic.mjs";

export const LOCK_FILE = "oats-lock.json";
export const LOCK_VERSION = 3;
export const PACKAGE_MANIFEST = "oats-package.json";
export const CAPABILITY_MANIFEST = "oats.json";
/** Default location of `oats-package.json` inside a package repo when the
 * workspace value carries no path (the catalog supplies one for catalog ids). */
export const DEFAULT_PACKAGE_PATH = "oats-package";

const OID_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256-[0-9a-f]{64}$/;
/** A soul name (docs/soul.schema.json#/$defs/slug): a package soul's name is its directory's. */
const SOUL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The one symlink a soul source may carry: its CLAUDE.md → AGENTS.md alias (at the soul's root).
 *  Sync and spawn fetch a package soul with this same predicate, so their digests agree. */
export const SOUL_ALIAS_SYMLINK = (p) => p === "CLAUDE.md";
const CONTRACT_DOC = "docs/design/2026-09-23-workspace-module-contracts.md";

/** `oatsError` with details attached as BOTH `e.provenance` (today's field) and
 * `e.details` (the contract's name) so callers can read either. */
function oatsError(code, message, details) {
  const e = baseOatsError(code, message, details);
  if (details !== undefined) e.details = details;
  return e;
}

// ---------- generic file-safety helpers (kept: used by bin/oats.mjs outside package code) ----------

const isInside = (base, target) => target === base || target.startsWith(base + sep);

/** Refuse to write below `scopeDir` through any symlinked path component of
 * `leafDir`. Components that do not exist yet are fine — this run creates them.
 * Re-run immediately before each write rather than cached. */
export function assertNoSymlinkedParents(scopeDir, leafDir, what) {
  const base = resolve(scopeDir);
  const leaf = resolve(leafDir);
  if (!isInside(base, leaf)) throw oatsError("E_ADOPTED_PATH_UNSAFE", `${what} resolves outside the scope: ${leaf}`, { scope: base, path: leaf });
  const rel = relative(base, leaf);
  let cur = base;
  for (const part of rel ? rel.split(sep) : []) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch { return; }
    if (st.isSymbolicLink()) {
      throw oatsError("E_ADOPTED_PATH_UNSAFE", `${what} passes through a symlink at ${cur} — OATS never writes through a link it did not create; remove or replace that entry`, { path: cur });
    }
    if (!st.isDirectory()) throw oatsError("E_ADOPTED_PATH_UNSAFE", `${what} passes through ${cur}, which is not a directory`, { path: cur });
  }
}


/** Exact copy via `writeFileAtomic` (copyFileSync would follow a destination symlink). */
export function copyFileAtomic(from, to) {
  writeFileAtomic(to, readFileSync(from));
}

// ---------- lock v3 ----------

const emptyLock = () => ({ lockfileVersion: LOCK_VERSION, packages: {} });
const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

/** Structural validation of a lock v3 object. Throws E_LOCK_SCHEMA naming the
 * offending path; a v1/v2 lock names its version and points at the rebuild. */
export function validateLock(lock, { file } = {}) {
  const where = file ? ` (${file})` : "";
  if (!plainObject(lock)) throw oatsError("E_LOCK_SCHEMA", `oats-lock.json must be a JSON object${where}`, { file, path: "/" });
  const v = lock.lockfileVersion;
  if (v !== LOCK_VERSION) {
    const shown = v === undefined ? "missing" : JSON.stringify(v);
    throw oatsError("E_LOCK_SCHEMA",
      `oats-lock.json lockfileVersion ${shown} is not supported: this kernel reads lockfileVersion ${LOCK_VERSION} only (workspace model v2; no migration — delete the lock and run \`oats sync\`)${where}`,
      { file, path: "/lockfileVersion", found: v, expected: LOCK_VERSION });
  }
  if (!plainObject(lock.packages)) throw oatsError("E_LOCK_SCHEMA", `oats-lock.json "packages" must be an object${where}`, { file, path: "/packages" });
  for (const [id, entry] of Object.entries(lock.packages)) {
    const at = `/packages/${id}`;
    const bad = (field, why) => oatsError("E_LOCK_SCHEMA", `oats-lock.json ${at}/${field}: ${why}${where}`, { file, path: `${at}/${field}`, id });
    if (!plainObject(entry)) throw oatsError("E_LOCK_SCHEMA", `oats-lock.json ${at} must be an object${where}`, { file, path: at, id });
    if (typeof entry.source !== "string" || !/^(catalog:|git:)/.test(entry.source)) throw bad("source", 'must be "catalog:<id>" or "git:<key>@<ref>"');
    if (entry.url !== undefined && (typeof entry.url !== "string" || !entry.url)) throw bad("url", "must be a non-empty repo url when present");
    if (typeof entry.path !== "string" || !entry.path) throw bad("path", "must be a non-empty string");
    if (typeof entry.version !== "string" || !entry.version) throw bad("version", "must be a non-empty string");
    if (typeof entry.commit !== "string" || !OID_RE.test(entry.commit)) throw bad("commit", "must be a full 40-hex OID");
    if (typeof entry.integrity !== "string" || !DIGEST_RE.test(entry.integrity)) throw bad("integrity", "must be sha256-<hex>");
    if (!Array.isArray(entry.capabilities) || entry.capabilities.some((c) => typeof c !== "string" || !c)) throw bad("capabilities", "must be an array of capability names");
    if (entry.souls !== undefined) {
      if (!Array.isArray(entry.souls)) throw bad("souls", "must be an array of { name, path, digest }");
      for (const [i, soul] of entry.souls.entries()) {
        if (!plainObject(soul) || typeof soul.name !== "string" || !SOUL_NAME_RE.test(soul.name)) throw bad(`souls/${i}/name`, "must be a soul name");
        if (typeof soul.path !== "string" || !soul.path || soul.path.split("/").some((p) => p === ".." || p === "") || soul.path.startsWith("/")) throw bad(`souls/${i}/path`, "must be a relative path inside the package");
        if (typeof soul.digest !== "string" || !DIGEST_RE.test(soul.digest)) throw bad(`souls/${i}/digest`, "must be sha256-<hex>");
      }
    }
  }
  return lock;
}

/** Read `<dir>/oats-lock.json`. A missing file is an empty v3 lock; anything
 * else is validated (E_LOCK_SCHEMA). Returns a fresh object every call. */
export function readLock(dir) {
  const file = join(resolve(dir), LOCK_FILE);
  if (!existsSync(file)) { recordLocalInput(file, null); return emptyLock(); }
  let parsed;
  const text = readFileSync(file, "utf8");
  recordLocalInput(file, text);
  try { parsed = JSON.parse(text); } catch (e) {
    throw oatsError("E_LOCK_SCHEMA", `oats-lock.json is not valid JSON (${file}): ${e.message}`, { file, path: "/" });
  }
  return validateLock(parsed, { file });
}

/** `<dir>/oats-lock.json` read as readLock does, or null when there is none (recorded as absent). */
export function readLockIfPresent(dir) {
  const file = join(resolve(dir), LOCK_FILE);
  if (!existsSync(file)) { recordLocalInput(file, null); return null; }
  return readLock(dir);
}

/** Canonical lock text: sorted package ids, sorted capability names, 2-space indent, trailing newline. */
export function canonicalLock(lock) {
  validateLock(lock);
  const packages = {};
  for (const id of Object.keys(lock.packages).sort()) {
    const e = lock.packages[id];
    packages[id] = {
      source: e.source, ...(typeof e.url === "string" && e.url ? { url: e.url } : {}), path: e.path, version: e.version, commit: e.commit, integrity: e.integrity,
      capabilities: [...e.capabilities].sort(),
      ...(Array.isArray(e.souls) && e.souls.length ? { souls: [...e.souls].sort((a, b) => byCodepoint(a.name, b.name)).map((x) => ({ name: x.name, path: x.path, digest: x.digest })) } : {}),
    };
  }
  return { lockfileVersion: LOCK_VERSION, packages };
}

/** Write `<dir>/oats-lock.json` atomically in canonical form. Returns the file path. */
export function writeLock(dir, lock) {
  const file = join(resolve(dir), LOCK_FILE);
  writeFileAtomic(file, JSON.stringify(canonicalLock(lock), null, 2) + "\n");
  return file;
}

// ---------- workspace `packages:` values ----------

/** Strip a single leading "v" from a semver-ish tag ("v2.1.3" → "2.1.3"). */
const versionOf = (text) => text.replace(/^v(?=\d)/, "");

/** The two — and only two — `packages:` value forms (contract §2, non-collapse rule):
 *   catalog version:  v2.1.3 | 2.1.3 | v1.0.0-rc.1        (resolves through the official catalog)
 *   direct git ref:   git:<repo>@<ref>                    (<repo> = any ref lib/remote.mjs understands;
 *                                                          <ref> = tag/branch name or full OID)
 * Shared by lib/workspace.mjs (schema validation) and resolvePackages. */
export const CATALOG_VERSION_RE = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;
const REF_NAME_RE = /^(?![-/.])(?!.*\.\.)(?!.*[\s~^:?*[\\\x00-\x1f\x7f])(?!.*@\{)(?!.*\/\.)(?!.*\.lock(?:\/|$))(?!.*\/\/)[^/]+(?:\/[^/]+)*(?<!\/|\.)$/;

/**
 * Classify one `packages:` value WITHOUT touching the catalog or the network.
 * → { kind: "catalog", version } | { kind: "git", repo, at } | { problem: "<why>" }
 * `repo` is the remainder after `git:` when that remainder is itself a full ref
 * (`/abs/bare.git`, `file:///…`, `https://…`, `git@host:…`), else `git:<host>/<path>` as written.
 */
export function classifyPackageValue(value) {
  if (typeof value !== "string" || !value.trim()) return { problem: "must be a non-empty string" };
  const text = value.trim();
  if (text !== value) return { problem: "must not carry surrounding whitespace" };
  if (text.startsWith("git:")) {
    const atIdx = text.lastIndexOf("@");
    if (atIdx <= "git:".length) return { problem: "a git package must be written git:<repo>@<ref> (no @<ref> found)" };
    const rest = text.slice("git:".length, atIdx);
    const at = text.slice(atIdx + 1);
    if (!at) return { problem: "a git package must be written git:<repo>@<ref> (empty <ref>)" };
    if (rest.includes("@") && !/^git@[^@/:]+:/.test(rest)) return { problem: "a git package carries exactly one @<ref> (a repo ref has no @ except the git@host: ssh form)" };
    if (!OID_RE.test(at) && !REF_NAME_RE.test(at)) return { problem: `${JSON.stringify(at)} is not a tag/branch name or full OID` };
    if (!rest) return { problem: "a git package must be written git:<repo>@<ref> (empty <repo>)" };
    // `git:` + an already-complete ref form: hand the remainder to parseRepoRef unchanged.
    const repo = /^(?:\/|file:\/\/|https?:\/\/|git@)/.test(rest) ? rest : `git:${rest}`;
    return { kind: "git", repo, at };
  }
  if (/^(?:https?:\/\/|file:\/\/|git@|\/)/.test(text) || text.includes("@") || text.includes("/")) {
    return { problem: "a package outside the catalog must be written git:<repo>@<ref>" };
  }
  if (!CATALOG_VERSION_RE.test(text)) return { problem: `${JSON.stringify(text)} is neither a version (v2.1.3) nor git:<repo>@<ref>` };
  return { kind: "catalog", version: versionOf(text) };
}

/** Split a catalog ref into a prefix and its version tail:
 * "v2.1.3" → { prefix: "", vee: true } ; "oats-framework/v1.1.3" → { prefix: "oats-framework/", vee: true }. */
function refPattern(catalogRef) {
  const m = /^(.*?)(v?)(\d[^/]*)$/.exec(catalogRef);
  if (!m) return null;
  return { prefix: m[1], vee: m[2] === "v" };
}

/** Recompose a catalog ref for a requested version, keeping the catalog's tag convention. */
function catalogRefFor(entry, requested) {
  const pat = refPattern(entry.ref || "");
  const bare = versionOf(requested);
  if (!pat) return requested; // catalog ref carries no version tail — the request is the ref
  return `${pat.prefix}${pat.vee ? "v" : ""}${bare}`;
}

/** Accept either the file shape ({ policy, packages: {…} }) or a bare id → entry map. */
function catalogPackages(catalog) {
  if (!plainObject(catalog)) return {};
  if (plainObject(catalog.packages) && !("url" in catalog.packages)) return catalog.packages;
  return catalog;
}

/** Interpret one `workspace.packages` value for package `id`.
 *  - "<version>"            → catalog lookup; ref recomposed from the catalog's tag convention
 *  - "git:<repo>@<ref>"     → direct ref; `<repo>` is any repo ref `lib/remote.mjs` understands
 *                             (git:host/path, https://…, git@host:…, /abs/bare.git, file:///…)
 * Nothing else is accepted (E_WORKSPACE_SCHEMA for a malformed value, E_REPO_REF for a bad git form).
 * → { kind: "catalog"|"git", remoteRef, at, path } */
export function parsePackageRequest(id, value, catalog) {
  const c = classifyPackageValue(value);
  if (c.problem) {
    const code = typeof value === "string" && value.trim().startsWith("git:") ? "E_REPO_REF" : "E_WORKSPACE_SCHEMA";
    const safe = { id, value: defaultRemote.displayRepoRef(value), path: `/packages/${id}`,
      problems: [defaultRemote.displayDiagnosticText(c.problem, value)] };
    const message = defaultRemote.displayDiagnosticText(`packages.${safe.id}: ${safe.problems[0]}, got ${JSON.stringify(safe.value)}`,
      value, { refusal: true });
    throw oatsError(code, message, safe);
  }
  if (c.kind === "git") return { kind: "git", remoteRef: c.repo, at: c.at, path: DEFAULT_PACKAGE_PATH };
  const text = value.trim();
  const entry = catalogPackages(catalog)[id];
  if (!plainObject(entry) || typeof entry.url !== "string") {
    throw oatsError("E_PACKAGE_MISSING", `packages.${id}: ${JSON.stringify(text)} is a catalog version but the catalog has no package ${JSON.stringify(id)} — use git:<repo>@<ref> for a package outside the catalog`, { id, value: text });
  }
  return { kind: "catalog", remoteRef: entry.url, at: catalogRefFor(entry, text), path: typeof entry.path === "string" && entry.path ? entry.path : DEFAULT_PACKAGE_PATH };
}

// ---------- reading a package over the injected remote ----------

const pjoin = (...parts) => posix.normalize(posix.join(...parts));

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assertRelPath(what, rel, details) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || /^[\\/]/.test(rel) || /[\x00]/.test(rel) || rel.split(/[\\/]/).some((p) => p === ".." || /^[A-Za-z]:$/.test(p))) {
    throw oatsError("E_PACKAGE_MANIFEST", `${what} must be a relative path inside the package, got ${JSON.stringify(rel)}`, details);
  }
}

/** Read + parse a JSON file of the package. A missing file is E_PACKAGE_MANIFEST (the
 * package is malformed), never a leaked E_REMOTE_PATH_MISSING. */
async function readJson(remote, remoteRef, commit, path, what, details) {
  let bytes;
  try { ({ bytes } = await remote.readRemoteFile(remoteRef, commit, path)); } catch (e) {
    if (e?.code === "E_REMOTE_PATH_MISSING") throw oatsError("E_PACKAGE_MANIFEST", `${what} is missing: no ${path} in ${typeof remoteRef === "string" ? remoteRef : remoteRef?.key}@${String(commit).slice(0, 12)}`, { ...details, path, cause: e.code });
    throw e;
  }
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch (e) {
    throw oatsError("E_PACKAGE_MANIFEST", `${what} at ${path} is not valid JSON: ${e.message}`, { ...details, path });
  }
}

/** Read `oats-package.json` and every capability manifest it lists.
 * → { manifest, capabilities: [{ name, dir, manifest }] } (sorted by name, codepoint order).
 * Two capability dirs declaring the same name → E_PACKAGE_MANIFEST { duplicate }.
 * The answer is a pure function of the bytes at the commit: a remote with the parsed cache
 * (lib/remote.mjs memoAtCommit) keeps it; a refusal is thrown and never kept. */
export async function readPackageManifests(remote, remoteRef, commit, path, details = {}) {
  const read = () => readPackageManifestsAt(remote, remoteRef, commit, path, details);
  return typeof remote.memoAtCommit === "function" ? remote.memoAtCommit(remoteRef, commit, `package-manifests\0${path}`, read) : read();
}
async function readPackageManifestsAt(remote, remoteRef, commit, path, details) {
  const manifestPath = pjoin(path, PACKAGE_MANIFEST);
  const manifest = await readJson(remote, remoteRef, commit, manifestPath, "package manifest", details);
  if (!plainObject(manifest) || typeof manifest.package !== "string" || !Array.isArray(manifest.capabilities)) {
    throw oatsError("E_PACKAGE_MANIFEST", `package manifest at ${manifestPath} must declare "package" and "capabilities"`, { ...details, path: manifestPath });
  }
  const capabilities = [];
  const seen = new Map();
  for (const rel of manifest.capabilities) {
    assertRelPath(`${manifestPath} capabilities[]`, rel, { ...details, path: manifestPath });
    const dir = pjoin(path, rel);
    const capManifest = await readJson(remote, remoteRef, commit, pjoin(dir, CAPABILITY_MANIFEST), "capability manifest", details);
    if (!plainObject(capManifest) || typeof capManifest.capability !== "string" || !capManifest.capability) {
      throw oatsError("E_PACKAGE_MANIFEST", `capability manifest at ${pjoin(dir, CAPABILITY_MANIFEST)} must declare "capability"`, { ...details, path: dir });
    }
    if (seen.has(capManifest.capability)) {
      throw oatsError("E_PACKAGE_MANIFEST", `package ${manifest.package} declares capability ${JSON.stringify(capManifest.capability)} twice (${seen.get(capManifest.capability)} and ${dir})`, { ...details, path: dir, duplicate: capManifest.capability, other: seen.get(capManifest.capability) });
    }
    // What it declares and this kernel ignores (an unknown hook event) is its readers' warning, not a refusal.
    const [problem] = manifestContractProblems(capManifest);
    if (problem) throw oatsError("E_PACKAGE_MANIFEST", `${pjoin(dir, CAPABILITY_MANIFEST)}#${problem.pointer}: ${problem.message}`, { ...details, path: dir, capability: capManifest.capability, pointer: problem.pointer });
    seen.set(capManifest.capability, dir);
    capabilities.push({ name: capManifest.capability, dir, manifest: capManifest });
  }
  capabilities.sort((a, b) => byCodepoint(a.name, b.name));
  // Package souls (0.28.0): ordinary soul directories, versioned and locked with the package. A soul's
  // name is its directory's (as for a member's souls/<name>); soul.yaml is validated where it is
  // discovered, AGENTS.md is required where it is locked (packageSoulDigests).
  const souls = [];
  if (manifest.souls !== undefined) {
    if (!Array.isArray(manifest.souls)) throw oatsError("E_PACKAGE_MANIFEST", `package manifest at ${manifestPath}: "souls" must be a list of soul directories`, { ...details, path: manifestPath });
    const seenSouls = new Map();
    for (const rel of manifest.souls) {
      assertRelPath(`${manifestPath} souls[]`, rel, { ...details, path: manifestPath });
      const soulPath = posix.normalize(rel).replace(/\/+$/, "");
      const name = posix.basename(soulPath);
      if (!SOUL_NAME_RE.test(name)) throw oatsError("E_PACKAGE_MANIFEST", `${manifestPath} souls[]: ${JSON.stringify(rel)} — a soul's directory is its name, which must match ${SOUL_NAME_RE}`, { ...details, path: manifestPath, soul: rel });
      if (seenSouls.has(name)) throw oatsError("E_PACKAGE_MANIFEST", `package ${manifest.package} declares soul ${JSON.stringify(name)} twice (${seenSouls.get(name)} and ${soulPath})`, { ...details, path: manifestPath, duplicate: name, other: seenSouls.get(name) });
      seenSouls.set(name, soulPath);
      souls.push({ name, path: soulPath, dir: pjoin(path, soulPath) });
    }
    souls.sort((a, b) => byCodepoint(a.name, b.name));
  }
  return { manifest, capabilities, souls };
}

/** Fetch each package soul at `commit` and return its lock record `{ name, path, digest }` — the digest
 *  is what `fetchRemoteTree` reports with SOUL_ALIAS_SYMLINK, the same fetch a spawn makes and verifies.
 *  A soul without soul.yaml or AGENTS.md is E_PACKAGE_MANIFEST. */
export async function packageSoulDigests(remote, remoteRef, commit, souls, details = {}) {
  if (!souls.length) return [];
  if (typeof remote.fetchRemoteTree !== "function") throw oatsError("E_PACKAGE_INTEGRITY", "remote must provide fetchRemoteTree() to compute a package soul's digest", { path: "/remote" });
  const scratch = mkdtempSync(join(tmpdir(), "oats-pkg-soul-"));
  try {
    const out = [];
    for (const soul of souls) {
      const dest = join(scratch, soul.name);
      let digest;
      try { ({ digest } = await remote.fetchRemoteTree(remoteRef, commit, soul.dir, dest, { allowSymlinks: SOUL_ALIAS_SYMLINK })); }
      catch (e) {
        if (e?.code === "E_REMOTE_PATH_MISSING") throw oatsError("E_PACKAGE_MANIFEST", `package soul ${soul.path} is missing at ${String(commit).slice(0, 12)}`, { ...details, soul: soul.name, path: soul.dir });
        throw e;
      }
      for (const file of ["soul.yaml", "AGENTS.md"]) {
        if (!existsSync(join(dest, file))) throw oatsError("E_PACKAGE_MANIFEST", `package soul ${soul.path} lacks ${file} at ${String(commit).slice(0, 12)} — a soul directory carries soul.yaml and AGENTS.md`, { ...details, soul: soul.name, path: soul.dir, missing: file });
      }
      out.push({ name: soul.name, path: soul.path, digest: assertDigest(`package soul ${soul.path} digest`, digest, details) });
    }
    return out;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const gitSource = (source) => /^git:(.+)@([^@]+)$/.exec(String(source ?? ""));
/** Two lock sources are one: the same text, or `git:` sources at one ref of one repository under
 *  either spelling of a move (lib/repo-moves.mjs), so that a flipped declaration keeps its lock entry
 *  and the moved-tag check. */
export function sameSource(a, b) {
  if (a === b) return true;
  const x = gitSource(a), y = gitSource(b);
  return Boolean(x && y) && x[2] === y[2] && sameRepo(x[1], y[1]);
}

/** The repo ref a lock entry is read from without a catalog: its recorded url, else the key of a
 *  `git:<key>@<ref>` source. → string | null (a catalog entry written without a url). */
export function lockedPackageRef(entry) {
  if (typeof entry?.url === "string" && entry.url) return entry.url;
  const m = gitSource(entry?.source);
  if (!m) return null;
  return m[1].startsWith("local/") ? m[1].slice("local/".length) : `git:${m[1]}`;
}

/** Content digest of the package tree at `path`: the digest `fetchRemoteTree` reports for a
 * copy into a scratch directory (contract §1: `contentDigest(dir)` is the local-directory form;
 * the remote has no digest-without-copy primitive yet — see the deferred note in the review). */
async function packageIntegrity(remote, remoteRef, commit, path) {
  if (typeof remote.fetchRemoteTree !== "function") {
    throw oatsError("E_PACKAGE_INTEGRITY", "remote must provide fetchRemoteTree() to compute a package's integrity", { path: "/remote" });
  }
  const scratch = mkdtempSync(join(tmpdir(), "oats-pkg-"));
  const dest = join(scratch, "tree");
  try {
    const { digest } = await remote.fetchRemoteTree(remoteRef, commit, path, dest, { allowSymlinks: defaultRemote.OATS_ALIAS_SYMLINK });
    return digest;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// ---------- resolvePackages ----------

function assertDigest(what, value, details) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) throw oatsError("E_PACKAGE_INTEGRITY", `${what} is not a sha256-<hex> digest: ${JSON.stringify(value)}`, details);
  return value;
}

/** A remote whose reads at a commit are shared for one command (feature desktop-facts): the souls and
 *  capabilities listings resolve many souls over the same package manifests and skill listings, and a read at
 *  an immutable commit gives the same answer every time. A failed read is not kept (it is retried). */
export function memoizedRemote(remote) {
  const memo = { ...remote };
  for (const name of ["readRemoteFile", "listRemoteTree"]) {
    if (typeof remote[name] !== "function") continue;
    const cache = new Map();
    memo[name] = (...args) => {
      const key = JSON.stringify(args);
      if (!cache.has(key)) cache.set(key, Promise.resolve(remote[name](...args)).catch((e) => { cache.delete(key); throw e; }));
      return cache.get(key);
    };
  }
  return memo;
}

/** Bind `remoteOptions` (cacheDir, exec, the command's read `session`, …) into every call of a contract-§1
 *  remote. Object references are kept (a spread, never a copy of the values), so one session is shared by
 *  every call; `memoAtCommit` (the parsed cache, lib/remote.mjs) and the member prefetch's primitives
 *  (`lastObservedCommit`, `peekAtCommit`, `prefetchObservation`) are optional and bound when present. */
export function bindRemote(remote, remoteOptions) {
  if (!remoteOptions || Object.keys(remoteOptions).length === 0) return remote;
  const bound = { ...remote };
  const arities = { observeRemote: 1, readRemoteFile: 3, listRemoteTree: 3, listRemoteFiles: 3, fetchRemoteTree: 4, memoAtCommit: 4, lastObservedCommit: 1, peekAtCommit: 3, prefetchObservation: 1, abandonPrefetches: 0 };
  for (const name of Object.keys(arities)) {
    if (typeof remote[name] !== "function") continue;
    bound[name] = (...args) => {
      const arity = arities[name];
      const opts = { ...(args[arity] || {}), ...remoteOptions };
      return remote[name](...args.slice(0, arity), opts);
    };
  }
  return bound;
}

/**
 * Resolve every `workspace.packages` entry to an exact commit + integrity and
 * merge into the lock (immutably — the input lock is never mutated).
 *
 * options.catalog: package-catalog.json (file shape or its `packages` map)
 * options.lock:    current lock (v3) — defaults to an empty lock
 * options.remote:  { observeRemote, readRemoteFile, listRemoteTree, fetchRemoteTree } — defaults to
 *                  lib/remote.mjs; tests pass an in-memory fake. options.remoteOptions (cacheDir, exec, …)
 *                  is threaded into every remote call.
 *
 * → { lock, changes: [{ id, from, to, commit }] }
 *   - `from` is the previously locked version or null; `to` is the resolved version
 *     (null when the package was removed from the workspace and dropped from the lock).
 *   - A locked entry whose version string is unchanged but whose commit or
 *     integrity moved → E_PACKAGE_INTEGRITY { id, version, locked, observed }.
 *   - A value resolving to a BRANCH → E_PACKAGE_INTEGRITY { why: "branch" }: versions are immutable.
 */
export async function resolvePackages(workspace, { catalog = {}, lock = emptyLock(), remote = defaultRemote, remoteOptions } = {}) {
  if (!remote || typeof remote.observeRemote !== "function" || typeof remote.readRemoteFile !== "function") {
    throw new TypeError("resolvePackages: remote must provide observeRemote()/readRemoteFile() (module contract §1)");
  }
  remote = bindRemote(remote, remoteOptions);
  const previous = validateLock(lock);
  const requests = plainObject(workspace?.packages) ? workspace.packages : {};
  const ids = Object.keys(requests).sort();
  const nextPackages = {};
  const changes = [];

  for (const id of ids) {
    const req = parsePackageRequest(id, requests[id], catalog);
    const details = { id, value: requests[id] };
    const obs = await remote.observeRemote(req.remoteRef, { at: req.at });
    if (!obs || typeof obs.commit !== "string" || !OID_RE.test(obs.commit)) {
      throw oatsError("E_PACKAGE_INTEGRITY", `packages.${id}: remote did not yield a full commit OID for ${req.remoteRef}@${req.at}`, { ...details, observed: obs?.commit });
    }
    // A package version must be immutable: a branch is a moving target and is refused up front
    // (a tag that later moves is caught below as E_PACKAGE_INTEGRITY).
    if (typeof obs.ref === "string" && /^refs\/heads\//.test(obs.ref)) {
      throw oatsError("E_PACKAGE_INTEGRITY", `packages.${id}: ${req.at} is a branch (${obs.ref}), not a version — pin a tag or a full commit OID`, { ...details, why: "branch", ref: obs.ref, commit: obs.commit });
    }
    const source = req.kind === "catalog" ? `catalog:${id}` : `git:${obs.key}@${req.at}`;
    const version = req.kind === "catalog" ? versionOf(requests[id].trim()) : versionOf(req.at);
    const old = previous.packages[id] || null;

    // Same version + same source + same path as locked: the lock must still describe reality.
    if (old && old.version === version && sameSource(old.source, source) && old.path === req.path) {
      if (old.commit !== obs.commit) {
        throw oatsError("E_PACKAGE_INTEGRITY",
          `packages.${id} ${version} is locked at ${old.commit} but ${source} now resolves to ${obs.commit} — the tag moved; a version string must change when its content does`,
          { ...details, version, locked: { commit: old.commit, integrity: old.integrity }, observed: { commit: obs.commit } });
      }
      const integrity = assertDigest(`packages.${id} integrity`, await packageIntegrity(remote, req.remoteRef, obs.commit, old.path), details);
      if (integrity !== old.integrity) {
        throw oatsError("E_PACKAGE_INTEGRITY",
          `packages.${id} ${version} @ ${obs.commit}: content digest ${integrity} does not match the locked ${old.integrity}`,
          { ...details, version, locked: { commit: old.commit, integrity: old.integrity }, observed: { commit: obs.commit, integrity } });
      }
      // The lock's capability list must still be what the package declares at that commit —
      // spawn refuses a mismatch (E_PACKAGE_INTEGRITY why:capabilities), so sync must too, or
      // a bad list would pass every sync and fail every spawn.
      const { capabilities, souls: soulDirs } = await readPackageManifests(remote, req.remoteRef, obs.commit, old.path, details);
      const listed = capabilities.map((c) => c.name).sort(), locked = [...old.capabilities].sort();
      if (listed.length !== locked.length || listed.some((c, i) => c !== locked[i])) {
        throw oatsError("E_PACKAGE_INTEGRITY",
          `packages.${id} ${version} @ ${obs.commit}: the lock lists capabilities [${locked.join(", ")}] but the package declares [${listed.join(", ")}] — the lock was edited; remove this entry from oats-lock.json and run \`oats sync\` again`,
          { ...details, version, why: "capabilities", listed, locked });
      }
      // The lock's souls must be what the package ships at that commit: the same names, paths and
      // digests. A lock written before 0.28.0 carries no `souls` — it is filled in, not refused.
      const souls = await packageSoulDigests(remote, req.remoteRef, obs.commit, soulDirs, details);
      if (old.souls !== undefined) {
        const show = (list) => list.map((x) => `${x.name}@${x.path}:${x.digest.slice(7, 19)}`).sort().join(", ");
        if (show(old.souls) !== show(souls)) {
          throw oatsError("E_PACKAGE_INTEGRITY",
            `packages.${id} ${version} @ ${obs.commit}: the lock's souls [${show(old.souls)}] do not match what the package ships [${show(souls)}] — the lock was edited; remove this entry from oats-lock.json and run \`oats sync\` again`,
            { ...details, version, why: "souls", listed: souls, locked: old.souls });
        }
      }
      const { approved: _dropped, souls: _souls, ...kept } = clone(old); // a pre-0.26 approval record is dropped on write
      nextPackages[id] = { ...kept, ...(souls.length ? { souls } : {}) };
      continue;
    }

    const { capabilities, souls: soulDirs } = await readPackageManifests(remote, req.remoteRef, obs.commit, req.path, details);
    const integrity = assertDigest(`packages.${id} integrity`, await packageIntegrity(remote, req.remoteRef, obs.commit, req.path), details);
    const souls = await packageSoulDigests(remote, req.remoteRef, obs.commit, soulDirs, details);
    nextPackages[id] = {
      source, url: obs.url, path: req.path, version, commit: obs.commit, integrity,
      capabilities: capabilities.map((c) => c.name).sort(),
      ...(souls.length ? { souls } : {}),
    };
    changes.push({ id, from: old ? old.version : null, to: version, commit: obs.commit });
  }

  for (const id of Object.keys(previous.packages).sort()) {
    if (!(id in requests)) changes.push({ id, from: previous.packages[id].version, to: null, commit: null });
  }

  return { lock: { lockfileVersion: LOCK_VERSION, packages: sortedObject(nextPackages) }, changes };
}

/** Which locked package provides capability `capName`? → { id, entry } | null.
 * Two packages providing the same name is ambiguous and fails closed:
 * E_PACKAGE_MISSING { capability, ambiguous: [ids] } — never a silent first-by-id pick. */
export function packageProviding(lock, capName) {
  if (!plainObject(lock?.packages)) return null;
  const providers = Object.keys(lock.packages).sort().filter((id) => Array.isArray(lock.packages[id]?.capabilities) && lock.packages[id].capabilities.includes(capName));
  if (providers.length === 0) return null;
  if (providers.length > 1) {
    throw oatsError("E_PACKAGE_MISSING", `capability ${JSON.stringify(capName)} is provided by ${providers.length} locked packages (${providers.join(", ")}) — a soul cannot say which; keep one of them in packages:`, { capability: capName, ambiguous: providers });
  }
  return { id: providers[0], entry: lock.packages[providers[0]] };
}

// ---------- deprecated shims (phase A only; callers are deleted next phase) ----------

const removed = (name) => function removedByWorkspaceModel() {
  throw oatsError("E_REMOVED", `${name} was removed by the workspace model; see ${CONTRACT_DOC}`, { name, contract: CONTRACT_DOC });
};

export const aggregateMissingRequirements = removed("aggregateMissingRequirements");
export const applyConfigMerge = removed("applyConfigMerge");
export const applyFromOasScope = removed("applyFromOasScope");
export const beginRunJournal = removed("beginRunJournal");
export const capabilityRuntimeTargets = removed("capabilityRuntimeTargets");
export const commandOnPath = removed("commandOnPath");
export const discoverMigrationScopes = removed("discoverMigrationScopes");
export const discoverOasScopes = removed("discoverOasScopes");
export const discoverWorkspaceScopes = removed("discoverWorkspaceScopes");
export const lockedPackageCapabilities = removed("lockedPackageCapabilities");
export const normalizeRequirement = removed("normalizeRequirement");
export const oasRenameMap = removed("oasRenameMap");
export const packageSpecIdentity = removed("packageSpecIdentity");
export const planConfigMerge = removed("planConfigMerge");
export const planFromOasScope = removed("planFromOasScope");
export const readAdoptedTemplate = removed("readAdoptedTemplate");
export const requirementInstallPlan = removed("requirementInstallPlan");
export const runRequirementInstall = removed("runRequirementInstall");
export const runtimePackageInstalled = removed("runtimePackageInstalled");
export const runtimePackageStatus = removed("runtimePackageStatus");
export const selectConfigTemplate = removed("selectConfigTemplate");
export const splitConfigLines = removed("splitConfigLines");
export const transformOasConfigText = removed("transformOasConfigText");
export const validateConfigTemplate = removed("validateConfigTemplate");
export const writeAdoptedTemplate = removed("writeAdoptedTemplate");
export const adoptedTemplateDir = removed("adoptedTemplateDir");
/** Was a constant table; any property access throws E_REMOVED. */
export const REQUIREMENT_MANAGERS = new Proxy(Object.freeze({}), {
  get(_t, prop) { if (typeof prop === "symbol" || prop === "then") return undefined; removed("REQUIREMENT_MANAGERS")(); },
  has() { removed("REQUIREMENT_MANAGERS")(); },
});
