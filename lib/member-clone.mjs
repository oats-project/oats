/** A deployment's discovery (its workspace, or a standalone repository) and the local clone of a
 *  member: found by convention or by `clones:`, verified against the member's remote. A leaf
 *  (awebai/oats#1630): `oats status` and `workspace status` read them without loading
 *  instance-resolution.mjs and the spawn machinery it brings; it imports what it still uses and
 *  re-exports what it exported. */
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import { oatsError } from "./errors.mjs";
import { discoverRepo, standaloneRepo, discoverWorkspace } from "./workspace.mjs";
import { memberNameOf } from "./teams.mjs";
import { parseRepoRef } from "./remote.mjs";
import { sameRepo } from "./repo-moves.mjs";
import { shellWord } from "./shell-word.mjs";
import { spawnSync } from "node:child_process";
import { readLockIfPresent } from "./packages.mjs";

function err(code, message, details) { const e = oatsError(code, message, details); e.details = details; return e; }

/** The convention path of a member's clone: `<deployment>/<member name>` — except a
 *  member called `agents`, which is cloned as `agents-repo/` because `<deployment>/agents/`
 *  is the instance root (design doc §4; matches onboard's cloneDirOf). */
export function conventionCloneDir(deployment, key) {
  const name = memberNameOf(key);
  return join(deployment, name === "agents" ? "agents-repo" : name);
}

/** Normalise a key an operator may have WRITTEN in `clones:` — the canonical key
 *  (`github.com/org/repo`), or any ref form parseRepoRef understands (`git:…`,
 *  `https://…`, `git@host:…`, `/abs/bare.git`) — to the canonical key. A key that
 *  parses no way is returned as written (it can then only match literally). */
export function canonicalCloneKey(written) {
  return parsedCloneKey(written) ?? String(written).trim();
}

/** canonicalCloneKey's answer when `written` is a repository reference, or null when it parses no
 *  way (a member's name, `org/name`): such a string can match no remote. */
export function parsedCloneKey(written) {
  const s = String(written).trim();
  if (s.startsWith("local/")) return s; // a local key is already canonical
  for (const candidate of [s, `git:${s}`]) {
    try { return parseRepoRef(candidate).key; } catch { /* next form */ }
  }
  return null;
}

/** The remotes a clone carries (any remote, not only origin), each with its url parsed
 *  to a repo key: [{ name, key }]. Not a git repo → null. */
function cloneRemotes(path) {
  const git = (argv) => spawnSync("git", ["-C", path, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const inside = git(["rev-parse", "--git-dir"]);
  if (inside.status !== 0) return null;
  // -z: each entry is `<key>\n<value>\0`, so a value holding a newline cannot read as another entry.
  const cfg = git(["config", "-z", "--get-regexp", "^remote\\..*\\.url$"]);
  const remotes = [];
  if (cfg.status === 0) {
    for (const entry of cfg.stdout.split("\0")) {
      const nl = entry.indexOf("\n");
      if (nl < 0) continue;
      const key = entry.slice(0, nl), url = entry.slice(nl + 1).trim();
      if (!url) continue;
      const name = key.slice("remote.".length, -".url".length);
      try { remotes.push({ name, key: parseRepoRef(url).key }); } catch { remotes.push({ name, key: `?/${url}` }); }
    }
  }
  return remotes;
}

/** cloneRemotes, once per read: `remotes`, when given, a Map (path → this answer) one read keeps for
 *  itself, so a clone it verifies twice runs git once. */
function cloneRemotesOnce(path, remotes) {
  if (remotes?.has(path)) return remotes.get(path);
  const rows = cloneRemotes(path);
  remotes?.set(path, rows);
  return rows;
}

/** Two repo keys name the same repository. Hosted keys compare literally, the two spellings of a
 *  moved repository being one (lib/repo-moves.mjs); `local/<abs>` keys compare by realpath when the
 *  path exists (macOS tmpdir → /private/var…). */
function sameRepoKey(a, b) {
  if (sameRepo(a, b)) return true;
  if (!a.startsWith("local/") || !b.startsWith("local/")) return false;
  const real = (k) => { try { return realpathSync(k.slice("local/".length)); } catch { return k.slice("local/".length); } };
  return real(a) === real(b);
}

/** The words of E_CLONE_MISMATCH that end it: the Git command that makes the repository at `path` a clone
 *  of `key` (`origin` repointed, or added when it has none), and the second way that passes too. */
function cloneRemoteFix(path, key, rows) {
  const url = key.startsWith("local/") ? key.slice("local/".length) : `https://${key}.git`;
  const git = `git -C ${shellWord(path)} remote`;
  if (!rows.some((r) => r.name === "origin")) return `; if this is a clone of it, run: ${git} add origin ${shellWord(url)}`;
  return `; if this is a clone of it, run: ${git} set-url origin ${shellWord(url)} (a second remote that names it passes too: ${git} add <name> ${shellWord(url)})`;
}

/** Verify `path` is the clone of `key`: it exists, is a directory, is a Git repo, and
 *  one of its remotes parses to `key`. Anything else → E_CLONE_MISMATCH { path, expected,
 *  found } — the operator pointed the kernel at the wrong place; it never works there. */
export function verifyMemberClone(path, key, { via, remotes } = {}) {
  const mismatch = (found, why, rows) => err("E_CLONE_MISMATCH", `${via ? `${via}: ` : ""}${path} is not a clone of ${key}${why ? ` (${why})` : ""}${found && found.length ? ` — its remotes point at ${found.join(", ")}` : ""}${rows ? cloneRemoteFix(path, key, rows) : ""}`, { path, expected: key, found, via: via ?? null });
  let st; try { st = statSync(path); } catch { throw mismatch(null, "the path does not exist"); }
  if (!st.isDirectory()) throw mismatch(null, "not a directory");
  const rows = cloneRemotesOnce(path, remotes);
  if (rows === null) throw mismatch(null, "not a Git repository");
  const found = rows.map((r) => r.key);
  if (!found.some((k) => sameRepoKey(k, key))) throw mismatch(found, found.length ? "no remote names it" : "it has no remotes", rows);
  return path;
}

/**
 * Where the work target of a PREPARED spawn lives — the member clone of the soul's
 * repo on this machine (design doc §4; decision 9: the work target is the only thing
 * that needs a clone). In order:
 *   1. `explicit` (`--repo`) — the operator's word; relative to the deployment; not
 *      verified against the member (an explicit --repo may deliberately point elsewhere);
 *   2. `oats-local.yaml` `clones: { <repo key>: <path> }` — the key as written is
 *      normalised through parseRepoRef so `git:…`, `https://…`, `git@…` spellings match;
 *   3. `<deployment>/<member name>` (`agents` → `agents-repo`);
 *   4. null — nothing on this machine.
 * A path found by (2) or (3) is VERIFIED: a directory, a Git repo, one remote parsing to
 * the member's key → else E_CLONE_MISMATCH. A `clones:` entry whose path is absent is a
 * mismatch too (the operator named it; "missing" would hide the typo).
 * Returns an absolute path or null.
 */
export function resolveMemberClone(prepared, { explicit, remotes } = {}) {
  const deployment = resolvePath(prepared?.deployment ?? process.cwd());
  if (typeof explicit === "string" && explicit.trim()) return isAbsolute(explicit) ? resolvePath(explicit) : resolvePath(deployment, explicit);
  const key = prepared?.soulEntry?.repoKey;
  if (typeof key !== "string" || !key) return null;
  return memberCloneOf(deployment, prepared?.local, key, { remotes }).path;
}

/** Steps 2–4 of resolveMemberClone for one member, naming the rule that found it (feature desktop-facts):
 *  → { path, rule: "clones" | "convention" } | { path: null, rule: null }; a named or conventional path that
 *  is not the member's clone is E_CLONE_MISMATCH, as for a spawn. `remotes`: verifyMemberClone's. */
export function memberCloneOf(deployment, local, key, { remotes } = {}) {
  const clones = local?.clones;
  if (clones && typeof clones === "object") {
    for (const [written, value] of Object.entries(clones)) {
      if (!sameRepoKey(canonicalCloneKey(written), key)) continue;
      if (typeof value !== "string" || !value.trim()) throw err("E_CLONE_MISMATCH", `oats-local.yaml clones: ${written} must be a path`, { path: value, expected: key, found: null, via: "oats-local.yaml clones:" });
      const path = isAbsolute(value) ? resolvePath(value) : resolvePath(deployment, value);
      return { path: verifyMemberClone(path, key, { via: `oats-local.yaml clones: ${written}`, remotes }), rule: "clones" };
    }
  }
  const convention = conventionCloneDir(deployment, key);
  if (!existsSync(convention)) return { path: null, rule: null };
  return { path: verifyMemberClone(convention, key, { via: "convention path", remotes }), rule: "convention" };
}

/** E_REMOTE_UNREADABLE reasons (lib/remote.mjs classifyRemoteFailure) that mean "the
 *  operator's access context cannot see this host" — the ONLY reasons that turn a
 *  workspace spawn into the standalone view. `network` / `timeout` are transient: the
 *  workspace exists and is ours; a spawn must not quietly degrade to a standalone one. */
const ACCESS_REASONS = new Set(["auth", "not-found"]);
const isAccessFailure = (e) => e?.code === "E_REMOTE_UNREADABLE" && ACCESS_REASONS.has(e?.details?.reason ?? e?.provenance?.reason);

/** The deployment's lock, or null when it has none (an unreadable lock is E_LOCK_SCHEMA). */
export function deploymentLock(deployment) {
  return readLockIfPresent(deployment);
}

/** Decision 10: a standalone view is a MEMBER whose workspace cannot be read — the
 *  repo must declare that workspace (oats-membership.yaml). A lone repo with no
 *  backlink is not a member of anything and never becomes a capability source. */
function requireMembership(repo, ref) {
  if (repo.membership) return;
  throw err("E_MEMBERSHIP_UNCONFIRMED", `a standalone view is a MEMBER whose workspace cannot be read; ${repo.key} declares no workspace (no oats-membership.yaml at ${String(repo.commit).slice(0, 12)})`, { key: repo.key, commit: repo.commit, ref, reason: "no-backlink" });
}

/**
 * Discover the workspace named by oats-local.yaml — or, when that ref is a REPO
 * whose workspace cannot be read (decision 10, the standalone case: a public
 * member of a privately hosted workspace), fall back to the repo's own souls and
 * capabilities. `standalone: <repo ref>` in oats-local.yaml asks for the standalone
 * view explicitly (no workspace lookup at all) — the repo must still be a member
 * (carry oats-membership.yaml), exactly as on the fallback path.
 *
 * A standalone result carries `standalone: true` and `standaloneReason`:
 *   "explicit"        — oats-local.yaml said `standalone:`;
 *   "unreadable-host" — `workspace:` named a member whose declared host is not
 *                        readable in this access context (auth / not-found).
 * A transient failure reading the host (network, timeout) is rethrown as-is.
 */
export async function discoverOrStandalone(local, { lock, deployment, remoteOptions, remote } = {}) {
  const ro = { remoteOptions, remote };
  // Package souls are listed from the deployment's lock (the `lock` given, else `<deployment>/oats-lock.json`).
  if (lock === undefined) lock = typeof deployment === "string" ? deploymentLock(deployment) : null;
  if (typeof local.standalone === "string" && local.standalone) {
    const repo = await discoverRepo(local.standalone, ro);
    requireMembership(repo, local.standalone);
    return { ...standaloneRepo(local.standalone, repo.commit, repo, { remote }), standaloneReason: "explicit" };
  }
  try { return await discoverWorkspace(local.workspace, { local, lock, ...ro }); }
  catch (e) {
    if (e?.code !== "E_WORKSPACE_SCHEMA" || e?.details?.notAHost !== true) throw e;
    // The ref is a repository without oats-workspace.yaml: is it a member whose
    // workspace we cannot read? Then the standalone view is what the operator gets.
    const repo = await discoverRepo(local.workspace, ro);
    if (!repo.membership) throw e;
    try { return await discoverWorkspace(repo.membership.workspace, { local, lock, ...ro }); }
    catch (inner) {
      // Only an ACCESS failure on the host means "standalone"; anything else
      // (network, timeout, a broken workspace file) is the caller's to see.
      if (!isAccessFailure(inner)) throw inner;
      return { ...standaloneRepo(local.workspace, repo.commit, repo, { remote }), standaloneReason: "unreadable-host", hostFailure: { code: inner.code, reason: inner.details?.reason ?? inner.provenance?.reason ?? null, url: inner.details?.url ?? inner.provenance?.url ?? null } };
    }
  }
}

export { cloneRemotes, err, sameRepoKey };
