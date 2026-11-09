/** Instance resolution — the bridge from the workspace model (remote → workspace →
 *  resolve → materialize) into a spawn.
 *
 *  A spawn is: read this machine's `oats-local.yaml` → discover the workspace over
 *  its Git remotes in the operator's access context → find the soul among the
 *  confirmed members (or external souls) → resolve every capability by `from:`
 *  (member = latest state, package = the locked version) → materialize
 *  each capability WHOLE into the new home (`.oats/modules/`, skills flat in `.agents/skills/`) →
 *  compose AGENTS.md → launch the harness normally.
 *
 *  This module owns the async half (discover + resolve) and the materialize call;
 *  `core.mjs#spawnInstance` stays synchronous and consumes a PREPARED resolution
 *  (`o.prepared`) produced here. It also turns a Resolution into the capability
 *  row shape the rest of the kernel already understands (`toCapabilityRows`), so
 *  hooks, environment, requirements and retirement keep working unchanged.
 *
 *  Nothing here reads `oats-config.yaml`, an installed-capability directory or a
 *  per-soul `source:` — those do not exist in this model. */
import { existsSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join, resolve as resolvePath, dirname, relative, isAbsolute, sep } from "node:path";
import { loadLocal, observeWorkspace } from "./workspace.mjs";
import { resolveSoul, kernelCompatibility } from "./resolve.mjs";
import { BY_TEAM_REMOVED, isRemovedTeamKeys, isTeamRefusal, memberNameOf, recordedTeams, reportRows, soulKeyOf, soulTeams, teamKeyOf, teamModel } from "./teams.mjs";
import { launchLayers } from "./launch-preference.mjs";
import { APPROVED_HOOKS, declaredSettings, locatedContractWarnings } from "./capability-contract.mjs";
import { materialize, moduleSkills, MODULES_DIR, plannedModuleSkills, SKILLS_DIR } from "./materialize.mjs";
import { contentDigest, fetchRemoteTree } from "./remote.mjs";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { readLockIfPresent, SOUL_ALIAS_SYMLINK } from "./packages.mjs";
import { parseRepoRef } from "./remote.mjs";
import { cloneRemotes, conventionCloneDir, discoverOrStandalone, err, resolveMemberClone, sameRepoKey } from "./member-clone.mjs";
import { sameRepo } from "./repo-moves.mjs";
export { canonicalCloneKey, conventionCloneDir, deploymentLock, discoverOrStandalone, memberCloneOf, resolveMemberClone, verifyMemberClone } from "./member-clone.mjs";


/** Keys that would poison a payload's prototype (as own keys) or, as a CAPABILITY
 *  name, address an inherited member of a plain `{}` (`constructor`, `toString`, …).
 *  Same set as lib/resolve.mjs POISON_KEYS; refused with E_WORKSPACE_SCHEMA reason
 *  "poison-key" so a `--provider constructor x=1` never reaches Object.prototype. */
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** `byTeam` was removed in 0.30 (team model v2): a spawn payload may not carry it. */
const RESERVED_KEY = "byTeam";

/** Parse repeated `--provider <cap> k=v` occurrences into { <cap>: { k: v } }.
 *  Values are strings; `k=v=w` keeps everything after the first `=`. Poison keys
 *  (capability OR any path segment) are E_WORKSPACE_SCHEMA reason "poison-key";
 *  `byTeam` (any path segment) is E_WORKSPACE_SCHEMA reason "removed-key". Both are
 *  refused again in resolve (defense in depth). The accumulators are built with
 *  Object.create(null) and only OWN keys are ever reused, so a name that happens to
 *  exist on Object.prototype (`toString`, `hasOwnProperty`) never writes through to it. */
export function parseProviderFlags(pairs) {
  const out = Object.create(null);
  for (const [cap, kv] of pairs) {
    if (typeof cap !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/i.test(cap)) throw err("E_BAD_ARGS", `--provider needs <capability> <key>=<value> (got capability ${JSON.stringify(cap)})`);
    if (POISON_KEYS.has(cap)) throw err("E_WORKSPACE_SCHEMA", `--provider ${cap}: capability name ${JSON.stringify(cap)} is refused (it would poison the payload's prototype)`, { path: `/${cap}`, key: cap, reason: "poison-key" });
    if (typeof kv !== "string" || !kv.includes("=")) throw err("E_BAD_ARGS", `--provider ${cap}: expected <key>=<value>, got ${JSON.stringify(kv)}`);
    const i = kv.indexOf("=");
    const key = kv.slice(0, i), value = kv.slice(i + 1);
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(key)) throw err("E_BAD_ARGS", `--provider ${cap}: invalid key ${JSON.stringify(key)}`);
    // dotted keys nest: identity.source=retained:x → { identity: { source: "retained:x" } }
    const parts = key.split(".");
    for (const p of parts) {
      if (POISON_KEYS.has(p)) throw err("E_WORKSPACE_SCHEMA", `--provider ${cap}: key ${JSON.stringify(key)} is refused (segment ${JSON.stringify(p)} would poison the payload's prototype)`, { path: `/${cap}/${parts.join("/")}`, key: p, reason: "poison-key" });
      if (p === RESERVED_KEY) throw err("E_WORKSPACE_SCHEMA", `--provider ${cap}: key ${JSON.stringify(key)} is refused (${BY_TEAM_REMOVED})`, { path: `/${cap}/${parts.join("/")}`, key: p, reason: "removed-key" });
    }
    if (!Object.hasOwn(out, cap)) out[cap] = Object.create(null);
    let cur = out[cap];
    for (const p of parts.slice(0, -1)) {
      if (!Object.hasOwn(cur, p) || cur[p] === null || typeof cur[p] !== "object") cur[p] = Object.create(null);
      cur = cur[p];
    }
    cur[parts.at(-1)] = value;
  }
  // Hand back ordinary objects (JSON-clean, Object.prototype) now that every key is vetted.
  return JSON.parse(JSON.stringify(out));
}

/** The qualified name of a discovered soul: `<package>/<soul>` for a package soul,
 *  `<member name>/<soul>` for a member's, `<source repo name>/<soul>` for an external one. */
export function qualifiedSoulName(entry) {
  if (typeof entry?.package === "string") return `${entry.package}/${entry.name}`;
  return `${memberNameOf(entry?.repoKey ?? "")}/${entry?.name}`;
}

/** A soul name as an operator gives it: `[repoPart, soulPart]`, repoPart null for a bare name. */
function splitSoulName(name) {
  return name.includes("/") && !name.startsWith("/") ? [name.slice(0, name.lastIndexOf("/")), name.slice(name.lastIndexOf("/") + 1)] : [null, name];
}
/** Whether `name` names the member or package soul `{ name, repoKey }` / `{ name, package }`: a
 *  bare name, `<repo>/<soul>` with the member's key, a key suffix (of either spelling of a moved
 *  repository) or its member name, or
 *  `<package>/<soul>` for a package soul. findSoulEntry's rule for each candidate. */
export function soulNameMatches(name, soul) {
  const [repoPart, soulPart] = splitSoulName(name);
  if (soulPart !== soul.name) return false;
  if (!repoPart) return true;
  if (typeof soul.package === "string") return repoPart === soul.package;
  const key = soul.repoKey ?? "";
  return sameRepo(key, repoPart) || key.endsWith(repoPart) || sameRepo(key, `github.com/${repoPart}`) || memberNameOf(key) === repoPart;
}
/** Whether `name` names the soul an instance home was spawned from (its instance.json `meta`): any name
 *  a spawn accepts for it, or the home's agent directory name. */
export function homeSoulMatches(name, meta) {
  if (name === meta?.agent) return true;
  const soul = meta?.workspace?.soul ?? {};
  return soulNameMatches(name, soul.package && typeof soul.package === "object" ? { name: soul.name, package: soul.package.id } : { name: meta?.agent, repoKey: soul.repoKey });
}

/** Every soul a discovery offers, each with the rule a typed name matches it by: the confirmed
 *  members' souls (a standalone view's one row is the repo's own, unconfirmed by definition — the
 *  workspace could not be read; resolveSoul admits exactly that case), the external souls, and the
 *  package souls. → [{ entry, matches(name) }] */
export function soulCandidates(discovery) {
  const out = [];
  const standaloneOwn = discovery.standalone === true ? discovery.key : null;
  for (const m of discovery.members || []) {
    if (!m.confirmed && m.key !== standaloneOwn) continue;
    for (const s of m.souls || []) out.push({ entry: { ...s, repoKey: m.key, memberCommit: m.commit, external: false }, matches: (name) => soulNameMatches(name, { name: s.name, repoKey: m.key }) });
  }
  for (const x of discovery.external || []) {
    if (!x.soul?.name) continue;
    const repoKey = x.soul.repoKey ?? parseRepoRef(x.source.replace(/@[0-9a-f]{40}$/, "")).key;
    out.push({
      entry: { ...x.soul, repoKey, commit: x.commit, external: true },
      matches: (name) => { const [repoPart, soulPart] = splitSoulName(name); return x.soul.name === soulPart && (!repoPart || sameRepo(repoKey, repoPart) || (x.source && String(x.source).includes(repoPart))); },
    });
  }
  for (const s of discovery.packageSouls || []) out.push({ entry: { ...s, external: false }, matches: (name) => soulNameMatches(name, { name: s.name, package: s.package }) });
  return out;
}

/**
 * What a read of the workspace offered, for the keys of oats-local.yaml souls.launch: the description
 * lib/launch-preference.mjs launchKeysUnmatched decides from. Built here, once, from the discovery:
 *   `keys`: the soul key (soulKeyOf) of every offered soul (soulCandidates), sorted. souls.disabled is
 *           not consulted: a soul not run on this machine is still a soul the workspace offers.
 *   `unread`: what this read could not see (discovery.soulsUnread, the members' rows):
 *     `all`: "standalone" in the standalone view of a workspace whose host cannot be read: the souls
 *            there are one member's, and the workspace's are not known. An explicit `standalone:` is
 *            the configured view: what it offers is all it offers.
 *     `bare`: why a soul keyed by its bare name may be missing: "member-unconfirmed" (a member the
 *            workspace lists and could not confirm), else "soul-unread" (a member's or an external
 *            soul skipped with a problem); null when every such soul was read.
 *     `packages`: { <id>: "package-unlocked" | "package-soul-unread" } for a package the workspace
 *            declares and the lock does not hold, or a locked one with a soul skipped.
 * What a read did not record, it did not establish: a discovery with no `soulsUnread` record (whatever
 * built it; discoverWorkspace and standaloneRepo always write one) says nothing about what it skipped,
 * so `all` is "unrecorded" and every key is left unchecked.
 */
export function soulsOffered(discovery) {
  const keys = [...new Set(soulCandidates(discovery).map((c) => soulKeyOf(c.entry)))].sort();
  const record = discovery?.soulsUnread;
  const recorded = record !== null && typeof record === "object" && ["members", "external", "packages", "unlocked"].every((k) => Array.isArray(record[k]));
  const skipped = recorded ? record : {};
  const standalone = discovery?.standalone === true;
  const unconfirmed = !standalone && (discovery?.members || []).some((m) => !m.confirmed);
  const packages = {};
  for (const id of skipped.unlocked || []) packages[id] = "package-unlocked";
  for (const id of skipped.packages || []) packages[id] = "package-soul-unread";
  return {
    keys,
    unread: {
      all: standalone && discovery.standaloneReason !== "explicit" ? "standalone" : recorded ? null : "unrecorded",
      bare: unconfirmed ? "member-unconfirmed" : (skipped.members?.length || skipped.external?.length) ? "soul-unread" : null,
      packages,
    },
  };
}

/** What each reason a member is not confirmed asks for. Each works without the command that failed. */
const UNCONFIRMED_FIX = {
  "backlink-elsewhere": "correct the `workspace:` line of oats-local.yaml, or of that repository's oats-membership.yaml",
  "cannot-read": "give git on this machine access to it (credentials or an SSH key), or correct its entry in oats-workspace.yaml",
  "no-backlink": "commit an oats-membership.yaml that names this workspace to that repository",
  "not-listed": "correct its entry in oats-workspace.yaml",
};
/** E_SOUL_UNKNOWN's words for the members that could hold the soul: none, or how many, each key, its reason
 *  and detail, then what to do about each reason. */
function unconfirmedMembersText(unconfirmed) {
  if (!unconfirmed.length) return "";
  const rows = unconfirmed.map((m) => `${m.key} (${m.reason ?? "unconfirmed"}${m.detail ? `: ${m.detail}` : ""})`);
  const fixes = [...new Set(unconfirmed.map((m) => m.reason))].map((reason) => (UNCONFIRMED_FIX[reason] ? `for ${reason}: ${UNCONFIRMED_FIX[reason]}` : null)).filter(Boolean);
  const count = unconfirmed.length === 1 ? "1 member is not confirmed, so its souls are" : `${unconfirmed.length} members are not confirmed, so their souls are`;
  return `; ${count} not listed: ${rows.join("; ")}${fixes.length ? `. To fix it, ${fixes.join("; ")}` : ""}`;
}

/** Find the soul named `name` in a discovery: confirmed members, external souls and package
 *  souls. A bare name must be unique across all three (else E_SOUL_AMBIGUOUS naming each
 *  qualified form); `<repo>/<soul>` names a member (its key, a key suffix or its member name)
 *  or an external source, `<package>/<soul>` a package soul. */
export function findSoulEntry(discovery, name) {
  const hits = soulCandidates(discovery).filter((c) => c.matches(name)).map((c) => c.entry);
  if (hits.length === 0) {
    const standaloneOwn = discovery.standalone === true ? discovery.key : null;
    const unconfirmed = (discovery.members || []).filter((m) => !m.confirmed && m.key !== standaloneOwn).map((m) => ({ key: m.key, reason: m.reason ?? null, detail: m.detail ?? null }));
    throw err("E_SOUL_UNKNOWN", `no soul ${JSON.stringify(name)} among the confirmed members, external souls or package souls of this workspace${unconfirmedMembersText(unconfirmed)}`, { name, members: (discovery.members || []).filter((m) => m.confirmed).map((m) => m.key), packages: [...new Set((discovery.packageSouls || []).map((s) => s.package))].sort(), ...(unconfirmed.length ? { unconfirmed } : {}) });
  }
  if (hits.length > 1) {
    const qualified = hits.map(qualifiedSoulName);
    throw err("E_SOUL_AMBIGUOUS", `soul ${JSON.stringify(name)} is ${hits.length} souls (${qualified.join(", ")}); name one of them`, { name, repos: hits.map((h) => h.repoKey), qualified });
  }
  if (Array.isArray(hits[0].collides)) throw err("E_SOUL_AMBIGUOUS", `package souls ${hits[0].collides.join(" and ")} would share the agent directory agents/${hits[0].agentName}/ — keep one of the packages in the workspace's packages:`, { name, agentDir: hits[0].agentName, qualified: hits[0].collides });
  return hits[0];
}

/** The agents-root directory of a discovered soul: a package soul's is `<package>--<soul>`
 *  (packageSoulAgentName), every other soul's is its name. */
export function agentDirOf(entry) { return typeof entry?.agentName === "string" ? entry.agentName : entry?.name; }

/** `oats-local.yaml` `souls.disabled` (not run on this machine): an entry names a soul by its
 *  bare name (every soul of that name) or its qualified name. → the matching entry or null. */
export function disabledEntry(local, soulEntry) {
  const list = Array.isArray(local?.souls?.disabled) ? local.souls.disabled : [];
  const qualified = qualifiedSoulName(soulEntry);
  return list.find((d) => d === soulEntry.name || d === qualified) ?? null;
}

/**
 * A home's LIVE teams (team model v2): the committed shared teams (the workspace host read now) and the
 * deployment's oats-local.yaml as it is now, resolved for the home's soul key (its name, or
 * `<package>/<soul>`). The home's modules and skills are untouched. One repository read, the workspace
 * host; a standalone deployment has local teams only and reads none.
 * → { teams, defaultTeam, source: "live" } — or, when that cannot answer (the host is unreachable, the
 *   deployment or its teams are unreadable), the spawn-time record: { teams, defaultTeam, source: "recorded", reason }.
 *   An oats-local.yaml still carrying the removed team keys (isRemovedTeamKeys) is thrown, never answered
 *   from the record: the deployment must migrate before its homes act on teams again.
 * `source` travels as OATS_TEAMS_SOURCE: a provider leaves a joined team only on a `live` answer.
 */
export async function liveTeams(home, meta, { remoteOptions, remote } = {}) {
  const recorded = (reason, error) => ({ ...recordedTeams(meta), source: "recorded", reason, ...(error ? { error } : {}) });
  const soul = meta?.workspace?.soul;
  // A home without a workspace soul record has nothing to resolve.
  if (!soul || typeof meta.agent !== "string") return recorded("no-workspace-soul");
  const key = soul.package ? teamKeyOf({ ...soul, package: soul.package.id }) : teamKeyOf({ name: meta.agent, repoKey: soul.repoKey ?? "" });
  const deployment = dirname(dirname(dirname(dirname(resolvePath(home)))));
  try {
    const found = loadLocal(deployment);
    if (!found.path || resolvePath(dirname(found.path)) !== resolvePath(deployment)) return recorded("no-deployment");
    const standalone = typeof found.local.standalone === "string" && found.local.standalone;
    const wsObs = standalone ? null : await observeWorkspace(found.local.workspace, { remoteOptions, remote });
    const t = soulTeams(teamModel(wsObs?.workspace ?? null, found.local, { workspaceKey: wsObs?.key ?? null }), key);
    return { teams: reportRows(t.teams), defaultTeam: t.defaultTeam, source: "live" };
  } catch (e) {
    if (isRemovedTeamKeys(e)) throw e;
    return recorded(isTeamRefusal(e) ? "invalid-teams" : "unreadable", { code: e?.code || "E_REMOTE_UNREADABLE", message: e?.message ?? String(e) });
  }
}

/**
 * For `session start|restart --reselect-launch`: what the home's launch layers need of the workspace
 * (lib/core.mjs homeLaunchLayers `offered`) to say which keys of souls.launch name no soul. The workspace
 * is read only when `needed` (the home's soul has no entry of its own and souls.launch holds a key
 * besides "*"); otherwise → null and nothing is read. A read that fails throws its own error: a
 * selection that could not check those keys does not go on.
 */
export async function homeSoulsOffered(home, { needed, remoteOptions, remote } = {}) {
  if (!needed) return null;
  const deployment = dirname(dirname(dirname(dirname(resolvePath(home)))));
  const found = loadLocal(deployment);
  return soulsOffered(await discoverOrStandalone(found.local, { lock: readLockIfPresent(deployment), deployment, remoteOptions, remote }));
}

/** The per-commit soul cache under an agent directory: `<agentDir>/souls/<commit12>/`.
 *  Each entry is IMMUTABLE once written (fetched to staging, renamed in) and is never
 *  removed by the kernel — a running instance records its own commit's directory
 *  (realpath, instance.json `soulDir`, handed to hooks as OATS_SOUL), so nothing can
 *  change under it. */
export const SOULS_DIR = "souls";
export const SOUL_SOURCE_STAMP = ".oats-soul-source.json";
const commit12 = (c) => String(c || "").slice(0, 12) || "unknown";
/** The kernel-owned "current" pointer `<agentDir>/soul` is a symlink whose target
 *  sits inside `<agentDir>/souls/`. Returns that target's realpath, or null when the
 *  path is absent, a real directory (0.25.0 layout) or a symlink elsewhere. */
export function soulPointerTarget(soulDir) {
  let st; try { st = lstatSync(soulDir); } catch { return null; }
  if (!st.isSymbolicLink()) return null;
  let real; try { real = realpathSync(soulDir); } catch { return null; }
  let soulsReal; try { soulsReal = realpathSync(join(dirname(soulDir), SOULS_DIR)); } catch { return null; }
  const rel = relative(soulsReal, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) return null;
  return real;
}
/** Atomically point `<agentDir>/soul` at `target`: symlink to a temp name, rename over.
 *  The previous target directory is untouched (an instance may link it). */
function swapSoulPointer(soulDir, target) {
  const tmp = `${soulDir}.pointer-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    symlinkSync(target, tmp);
    renameSync(tmp, soulDir); // rename over an existing symlink replaces it; over a directory it fails (caller migrates first)
  } catch (x) { try { rmSync(tmp, { force: true }); } catch { /* nothing */ } throw x; }
}

/** Fetch a prepared soul's source tree (soul.yaml + AGENTS.md, CLAUDE.md → AGENTS.md) into `dest`. */
async function fetchSoulSource(prepared, dest) {
  const e = prepared.soulEntry;
  const ref = typeof e.ref === "string" ? e.ref : e.repoKey.startsWith("local/") ? e.repoKey.slice("local/".length) : `git:${e.repoKey}`;
  // A soul's CLAUDE.md → AGENTS.md alias is the one symlink a soul source may carry.
  const { digest } = await fetchRemoteTree(ref, e.commit, e.path, dest, { ...(prepared.remoteOptions || {}), allowSymlinks: SOUL_ALIAS_SYMLINK });
  // A package soul is what the lock recorded at sync: the same bytes at the locked commit.
  if (typeof e.package === "string" && digest !== e.digest) {
    throw err("E_PACKAGE_INTEGRITY", `package soul ${e.qualifiedName} v${e.version} @ ${String(e.commit).slice(0, 12)}: content digest ${digest} does not match the locked ${e.digest} — run \`oats sync\` (a lock that was edited: remove the entry and sync again)`, { package: e.package, soul: e.name, version: e.version, commit: e.commit, why: "soul-digest", locked: e.digest, observed: digest });
  }
  if (!existsSync(join(dest, "soul.yaml")) || !existsSync(join(dest, "AGENTS.md"))) throw err("E_SOUL_INCOMPLETE", `soul ${e.name} at ${e.repoKey}@${String(e.commit).slice(0, 12)} lacks soul.yaml or AGENTS.md`, { repoKey: e.repoKey, commit: e.commit, path: e.path });
  if (!existsSync(join(dest, "CLAUDE.md"))) symlinkSync("AGENTS.md", join(dest, "CLAUDE.md"));
}

/** The digests a soul copy may carry as its source was fetched (fetchSoulSource): the copy itself, and,
 *  when it holds the CLAUDE.md → AGENTS.md alias, the copy without it, since fetchSoulSource adds that
 *  alias to a source that has none. A package soul's copy is intact when one of them is its digest. */
export function soulCopyDigests(dir) {
  const options = { allowSymlinks: SOUL_ALIAS_SYMLINK };
  const alias = join(dir, "CLAUDE.md");
  let aliased = false;
  try { aliased = lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === "AGENTS.md"; } catch { aliased = false; }
  const digests = [contentDigest(dir, options)];
  if (aliased) digests.push(contentDigest(dir, { ...options, omit: (rel) => rel === "CLAUDE.md" }));
  return digests;
}

/** A preview's soul source. A preview writes NOTHING in the deployment (K6b), so it
 *  never populates the per-commit cache or moves the `soul` pointer: it reads the
 *  cache entry for the prepared commit when one is already complete, else fetches
 *  the source into a temporary directory outside the deployment. `cleanup` removes
 *  that temporary copy; `fetched` says whether the preview had to fetch. */
export async function previewWorkspaceSoul(prepared, agentsRoot) {
  const e = prepared.soulEntry;
  const commitDir = join(agentsRoot, agentDirOf(e), SOULS_DIR, commit12(e.commit));
  if (existsSync(join(commitDir, "soul.yaml")) && existsSync(join(commitDir, "AGENTS.md"))) return { soulDir: realpathSync(commitDir), fetched: false, cleanup: () => {} };
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "oats-preview-soul-")));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try { await fetchSoulSource(prepared, join(tmp, "soul")); }
  catch (x) { cleanup(); throw x; }
  return { soulDir: join(tmp, "soul"), fetched: true, cleanup };
}

/** Materialize a workspace soul's SOURCE (soul.yaml, AGENTS.md, skills/…) into the
 *  per-commit cache `<agentsRoot>/<name>/souls/<commit12>/` and point the classic
 *  `<agentsRoot>/<name>/soul` at it (a SYMLINK, swapped atomically), so the classic
 *  spawn skeleton, findAgent, doctor … keep reading "current" from the usual place
 *  while every spawned home links its OWN commit's directory (decision 7: an
 *  instance never changes under itself — a later spawn may fetch a new commit and
 *  move the pointer, but no directory an instance links is ever touched; a preview
 *  never calls this, see previewWorkspaceSoul).
 *
 *  Idempotent per (repo, commit): an existing complete entry is reused (never
 *  refetched, never rewritten); an entry that lost its soul.yaml is moved aside and
 *  refetched. `.oats-soul-source.json` stamps what the pointer currently shows.
 *  Migration: a 0.25.0 `soul/` that is a REAL directory is moved to
 *  `souls/<commit from the stamp | unknown>/` before the pointer replaces it.
 *  Returns the PER-COMMIT directory (what a home should link). */
export async function ensureWorkspaceSoul(prepared, agentsRoot) {
  const e = prepared.soulEntry;
  const agentDir = join(agentsRoot, agentDirOf(e)); const soulDir = join(agentDir, "soul");
  const soulsDir = join(agentDir, SOULS_DIR);
  const stamp = join(agentDir, SOUL_SOURCE_STAMP);
  const readStamp = () => { try { return JSON.parse(readFileSync(stamp, "utf8")); } catch { return null; } };
  const commitDir = join(soulsDir, commit12(e.commit));
  mkdirSync(soulsDir, { recursive: true });

  // --- migration: a 0.25.0 real `soul/` directory becomes souls/<commit|unknown>/ ---
  let st; try { st = lstatSync(soulDir); } catch { st = null; }
  if (st && !st.isSymbolicLink() && st.isDirectory()) {
    const cur = readStamp();
    const legacyCommit = cur && sameRepo(cur.repoKey, e.repoKey) && typeof cur.commit === "string" && cur.commit ? commit12(cur.commit) : "unknown";
    let dest = join(soulsDir, legacyCommit);
    if (existsSync(dest)) dest = join(soulsDir, `${legacyCommit}.migrated-${process.pid}-${randomBytes(4).toString("hex")}`);
    renameSync(soulDir, dest);
    swapSoulPointer(soulDir, dest);
  } else if (st && !st.isSymbolicLink()) {
    // a regular file where the pointer belongs: not ours to keep
    rmSync(soulDir, { force: true });
  }

  // --- the per-commit entry: reuse when complete, else fetch (staging → rename in) ---
  let complete = existsSync(join(commitDir, "soul.yaml")) && existsSync(join(commitDir, "AGENTS.md"));
  if (existsSync(commitDir) && !complete) {
    // A damaged entry (someone removed soul.yaml): move it aside — an instance may
    // still link it, so it is never deleted — and fetch a fresh copy under the canonical name.
    renameSync(commitDir, `${commitDir}.damaged-${process.pid}-${randomBytes(4).toString("hex")}`);
  }
  if (!complete) {
    const staging = join(soulsDir, `.soul-staging-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      await fetchSoulSource(prepared, staging);
      try { renameSync(staging, commitDir); }
      catch (x) {
        // Lost a race with a concurrent fetch of the same commit: theirs is the same bytes.
        if (!(existsSync(join(commitDir, "soul.yaml")) && existsSync(join(commitDir, "AGENTS.md")))) throw x;
        rmSync(staging, { recursive: true, force: true });
      }
    } catch (x) { try { rmSync(staging, { recursive: true, force: true }); } catch { /* nothing */ } throw x; }
  }

  // --- the "current" pointer + its stamp ---
  const target = realpathSync(commitDir);
  if (soulPointerTarget(soulDir) !== target) swapSoulPointer(soulDir, target);
  const cur = readStamp();
  if (!cur || !sameRepo(cur.repoKey, e.repoKey) || cur.commit !== e.commit || cur.path !== e.path) {
    const pkg = typeof e.package === "string" ? { package: e.package, version: e.version } : {};
    writeFileSync(stamp, JSON.stringify({ repoKey: e.repoKey, commit: e.commit, path: e.path, ...pkg, fetchedAt: new Date().toISOString() }, null, 2) + "\n");
  }
  return target;
}

// ---------------------------------------------------------------------------
// Member clones — where a workspace soul's `work: worktree|checkout` target lives
// ---------------------------------------------------------------------------

/** The taught member name of a repo key: the last path segment without `.git`
 *  (`github.com/northwind/platform` → `platform`). The same rule `oats onboard`
 *  and `oats sync` print (memberLabel). */
export { memberNameOf };





/** The name of the clone's remote whose url names `key`, or null (no such remote, or not a git repo). */
export function cloneRemoteFor(path, key) {
  return (cloneRemotes(path) || []).find((r) => sameRepoKey(r.key, key))?.name ?? null;
}





/** The clone url of the soul's member as the workspace names it (for remedies). */
function memberUrlOf(prepared, key) {
  for (const ref of prepared?.discovery?.workspace?.members || []) {
    try { const p = parseRepoRef(ref); if (sameRepoKey(p.key, key)) return p.url; } catch { /* validated already */ }
  }
  if (prepared?.discovery?.standalone === true && sameRepo(prepared.discovery.key, key)) return prepared.discovery.url ?? null;
  return key.startsWith("local/") ? key.slice("local/".length) : `https://${key}.git`;
}

/** resolveMemberClone, or E_CLONE_MISSING naming BOTH ways to provide the clone
 *  (the convention path and a `clones:` entry) plus `--repo` for a one-off. */
export function requireMemberClone(prepared, { explicit } = {}) {
  const found = resolveMemberClone(prepared, { explicit });
  if (found) return found;
  const key = prepared?.soulEntry?.repoKey ?? "<repo>";
  const deployment = resolvePath(prepared?.deployment ?? process.cwd());
  const convention = conventionCloneDir(deployment, key);
  const url = memberUrlOf(prepared, key);
  const soul = prepared?.soulEntry?.name ?? "<soul>";
  const work = prepared?.soulEntry?.definition?.work ?? "worktree";
  throw err("E_CLONE_MISSING", `soul ${soul} works in a ${work} of ${key}, and this machine has no clone of it — either \`git clone ${url} ${convention}\` (the convention: <deployment>/<member name>) or point oats-local.yaml at an existing clone: \`clones: { ${key}: <abs path> }\`; for a one-off pass --repo <path>`, { soul, repoKey: key, work, deployment, convention, url, remedies: { clone: `git clone ${url} ${convention}`, local: { clones: { [key]: "<abs path>" } }, flag: "--repo <path>" } });
}

/** Would a spawn of this discovered soul be refused before it touches this machine (feature desktop-facts)?
 *  The same checks prepareInstance makes — souls.disabled, then the soul's resolution (its teams here, slot
 *  conflicts, missing or private capabilities, compatibility …) — without spawning anything.
 *  `capabilities` (feature souls-capabilities) is what that one resolution composes, one entry per module in
 *  its order (by name, codepoint), keyed like an `oats capabilities` row — { name, kind: "member", repoKey,
 *  from } | { name, kind: "package", package, from } — with `from` its capabilitiesFrom ("soul" | "workspace").
 *  null whenever the soul is not spawnable: nothing resolved, so nothing is known to be composed.
 *  → { spawnable: true, problem: null, capabilities: [...] } | { spawnable: false, problem: { code, message }, capabilities: null } */
export async function soulSpawnability(local, discovery, lock, soulEntry, { remoteOptions, remote } = {}) {
  const disabled = disabledEntry(local, soulEntry);
  if (disabled !== null) return { spawnable: false, problem: { code: "E_SOUL_DISABLED", message: `disabled on this machine (oats-local.yaml souls.disabled: ${disabled})` }, capabilities: null };
  let resolution;
  try { resolution = await resolveSoul(discovery, soulEntry, { local, lock, spawn: {}, remoteOptions, remote }); }
  catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) return { spawnable: false, problem: { code: e.code, message: e.message }, capabilities: null }; throw e; }
  return { spawnable: true, problem: null, capabilities: composedCapabilities(resolution) };
}

/** A resolution's modules as `oats capabilities` row identities, each with why the soul has it (feature
 *  souls-capabilities). Only the identity keys: no commit, version, layer or integrity. */
function composedCapabilities(resolution) {
  return resolution.modules.map((m) => m.from.kind === "package"
    ? { name: m.name, kind: "package", package: m.from.package, from: resolution.capabilitiesFrom[m.name] }
    : { name: m.name, kind: "member", repoKey: m.from.repoKey, from: resolution.capabilitiesFrom[m.name] });
}

/** The async half of a spawn: everything that touches the network. Returns a
 *  PREPARED object that `spawnInstance` consumes synchronously. */
export async function prepareInstance(contextDir, soulName, { spawn = {}, remoteOptions, remote, local: localOverride, discovery: discoveryOverride, soulEntry: entryOverride } = {}) {
  const found = localOverride ? { path: null, local: localOverride } : loadLocal(contextDir);
  const local = found.local;
  const deployment = found.path ? dirname(found.path) : resolvePath(contextDir);
  const lock = readLockIfPresent(deployment);
  const discovery = discoveryOverride ?? await discoverOrStandalone(local, { lock, remoteOptions, remote });
  const soulEntry = entryOverride ?? findSoulEntry(discovery, soulName);
  const disabled = disabledEntry(local, soulEntry);
  if (disabled !== null) throw err("E_SOUL_DISABLED", `soul ${qualifiedSoulName(soulEntry)} is disabled on this machine (oats-local.yaml souls.disabled: ${disabled}) — remove it from that list to spawn it here`, { name: soulEntry.name, qualifiedName: qualifiedSoulName(soulEntry), entry: disabled });
  const resolution = await resolveSoul(discovery, soulEntry, { local, lock, spawn, remoteOptions, remote });
  // The launch layers a new selection reads (feature launch-preference): souls.launch, the soul's own launch,
  // and, from this read of the workspace, the keys of souls.launch that name no soul it offers.
  const launch = launchLayers({ definition: soulEntry.definition, entry: soulEntry, key: soulKeyOf(soulEntry), local, offered: soulsOffered(discovery) });
  return { local, deployment, lock, discovery, soulEntry, resolution, remoteOptions, spawn, launch };
}

/** The first soul of the deployment, by name (then qualified name), not disabled here, whose
 *  resolution `provides(resolution)`: each soul is prepared in turn over one discovery, and the search
 *  stops at the first that does. A soul whose resolution is refused cannot provide anything and is
 *  skipped, named with its code. → { prepared | null, skipped: [{ soul, code }] } */
export async function prepareFirstProviding(contextDir, provides, { remoteOptions, remote } = {}) {
  const found = loadLocal(contextDir);
  const deployment = dirname(found.path);
  const discovery = await discoverOrStandalone(found.local, { lock: readLockIfPresent(deployment), remoteOptions, remote });
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : qualifiedSoulName(a) < qualifiedSoulName(b) ? -1 : 1);
  const entries = soulCandidates(discovery).map((c) => c.entry).filter((e) => disabledEntry(found.local, e) === null).sort(byName);
  const skipped = [];
  for (const soulEntry of entries) {
    let prepared;
    try { prepared = await prepareInstance(contextDir, null, { remoteOptions, remote, discovery, soulEntry }); }
    catch (e) { if (typeof e?.code === "string" && e.code.startsWith("E_")) { skipped.push({ soul: qualifiedSoulName(soulEntry), code: e.code }); continue; } throw e; }
    if (provides(prepared.resolution)) return { prepared, skipped };
  }
  return { prepared: null, skipped };
}





/** Materialize a prepared resolution into `home`. Called by spawnInstance after
 *  the home directory exists and before the harness is launched. `prepared.blocks`
 *  (the kernel's blocks) close the AGENTS.md, after the capability injects. */
export async function materializePrepared(prepared, home) {
  return materialize(prepared.resolution, home, { lock: prepared.lock, remoteOptions: prepared.remoteOptions, soulAgentsMd: prepared.soulAgentsMd, soulDir: prepared.soulDir, blocks: prepared.blocks });
}
/** The capability skills materializePrepared would copy, named before anything is fetched (the spawn preview). */
export async function plannedPreparedSkills(prepared) {
  return plannedModuleSkills(prepared.resolution, { lock: prepared.lock, remoteOptions: prepared.remoteOptions });
}


/** Turn a Resolution into the capability rows used by hooks and requirements.
 * Published rows use the home's module copies. Upgrade may supply verified staged
 * directories so new manifest paths are enumerated against the matching bytes. */
export function toCapabilityRows(resolution, home, { moduleDirs = {} } = {}) {
  const rows = [];
  for (const m of resolution.modules) {
    const dir = (Object.hasOwn(moduleDirs, m.name) ? moduleDirs[m.name] : undefined) ?? join(home, MODULES_DIR, m.name);
    const manifest = m.manifest;
    // Skills are flat under <home>/.agents/skills/<skill>/; which of them this module
    // contributed is read from its own copy, enumerated exactly as materialize placed them.
    const skills = existsSync(dir)
      ? moduleSkills(resolution, m, dir).map((s) => join(home, SKILLS_DIR, s.name)).filter((p) => existsSync(p))
      : [];
    const inject = manifest.inject ? join(dir, manifest.inject) : undefined;
    rows.push({
      id: m.name, capability: m.name, manifest, layer: manifest.layer ?? undefined, command: manifest.command,
      level: home, origin: m.from.kind === "package" ? `package:${m.from.package}@${m.from.version}` : `member:${m.from.repoKey}@${m.from.commit}`,
      provenance: [m.from.kind === "package" ? `package ${m.from.package} v${m.from.version}` : `member ${m.from.repoKey} @ ${String(m.from.commit).slice(0, 12)}`],
      settings: { ...(resolution.payloads?.[m.name] && typeof resolution.payloads[m.name] === "object" ? resolution.payloads[m.name] : {}) },
      settingsOrigins: { ...(resolution.payloadOrigins?.[m.name] && typeof resolution.payloadOrigins[m.name] === "object" ? resolution.payloadOrigins[m.name] : {}) },
      skills, inject: inject && existsSync(inject) ? inject : undefined,
      skillsDeclared: manifest.skills || [], injectDeclared: manifest.inject,
      // Member capabilities are trusted by membership (decision 2); package
      // capabilities by their declaration in the workspace's packages: (human
      // decision 2026-09-24: declaring a package is the trust decision).
      hooks: hookCommandsOf(manifest, dir), requiredHooks: requiredHooksOf(manifest),
      environment: [...(manifest.environment || [])], environmentNamespaces: [...(manifest.environmentNamespaces || [])],
      missingRequires: [], compatibility: kernelCompatibility({ ...manifest, capability: m.name }), trust: { trusted: true, reason: m.from.kind === "package" ? "declared workspace package" : "workspace member" },
      executable: !!manifest.commands && Object.keys(manifest.commands).length > 0,
      retirement: manifest.retirement,
      dir, from: m.from, _scope: 0,
    });
  }
  return rows;
}

/** A resolution's contract warnings (an unknown, non-required hook event): its modules'
 *  [{ code, capability, path, message }] by module name (as a replayed spawn reads them from the home),
 *  each module's manifest where it was read (`<repoKey>:<dir>/oats.json`, a package's
 *  `package:<id>:<dir>/oats.json`). */
export function resolutionContractWarnings(resolution) {
  return [...(resolution?.modules || [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).flatMap((m) => locatedContractWarnings(m.manifest,
    m.from?.kind === "package" ? `package:${m.from.package}:${m.dir}/oats.json` : `${m.from?.repoKey}:${m.dir}/oats.json`));
}

/** The hooks a row carries: the events this kernel runs. An unknown event (a newer
 *  kernel's, accepted with a warning by the manifest contract) never reaches a row. */
function hookCommandsOf(manifest, dir) {
  const out = {};
  const hooks = manifest.hooks && typeof manifest.hooks === "object" ? manifest.hooks : {};
  for (const [event, spec] of Object.entries(hooks)) {
    if (!APPROVED_HOOKS.has(event)) continue;
    const cmd = typeof spec === "string" ? spec : spec?.command;
    if (typeof cmd === "string" && cmd) out[event] = { command: cmd, cwd: dir, required: spec?.required === true };
  }
  return out;
}
function requiredHooksOf(manifest) {
  const hooks = manifest.hooks && typeof manifest.hooks === "object" ? manifest.hooks : {};
  return Object.entries(hooks).filter(([e, s]) => APPROVED_HOOKS.has(e) && s && typeof s === "object" && s.required === true).map(([e]) => e);
}

/** What a preview shows about modules: from/commit/digest per module, whether
 *  it changed since the newest existing instance of the same soul in `agentsRoot`,
 *  and `composedFrom` (feature preview-composed-from): why the soul's composition
 *  has it — "soul" | "workspace", the resolution's capabilitiesFrom. Provenance
 *  only: it is outside every fingerprint. `null` only for a resolution without
 *  capabilitiesFrom (an older in-process caller); never for a resolved module. */
export function modulesPreview(resolution, agentsRoot, soulName) {
  let previous = null;
  const instancesDir = join(agentsRoot, soulName, "instances");
  if (existsSync(instancesDir)) {
    let newest = null;
    for (const e of readdirSync(instancesDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      try {
        const meta = JSON.parse(readFileSync(join(instancesDir, e.name, "instance.json"), "utf8"));
        if (meta?.modules && (!newest || String(meta.createdAt) > String(newest.createdAt))) newest = { name: e.name, ...meta };
      } catch { /* not an instance */ }
    }
    previous = newest;
  }
  return resolution.modules.map((m) => {
    const prev = previous?.modules?.[m.name];
    const changedSince = !previous ? null : !prev ? { instance: previous.name, was: null } : (prev.commit !== m.from.commit ? { instance: previous.name, was: prev.commit } : false);
    return { name: m.name, from: m.from, layer: m.manifest.layer ?? null, private: !!m.private, declares: declaredSettings(m.manifest), changedSince,
      composedFrom: resolution.capabilitiesFrom?.[m.name] ?? null };
  });
}

/** The relative pi/claude/codex skill directory inside a home — exported so the
 *  launch recipe and tests agree on it. */
export const INSTANCE_SKILLS_DIR = SKILLS_DIR;
export const INSTANCE_MODULES_DIR = MODULES_DIR;


