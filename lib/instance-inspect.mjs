/** inspect / readiness / operation targets on the workspace model (lead decision 4).
 *
 * A TARGET is what the answer is about, read from the workspace model's own
 * records and never from the classic config chain:
 *   - an instance (`--home`): its instance.json (modules, providers = the merged
 *     payloads, workspace, soulDir, policy) and its materialized module copies;
 *   - a soul (`--soul`): its resolution (prepareInstance → modules, payloads,
 *     slots), the discovery it came from, and its declarations.
 * The integers are the contract: inspect `operationsApi: 2` with `soulsApi: 2`
 * soul rows, readiness `readinessApi: 2`. Payloads carry no scope chain, team
 * block or config levels, and there is no `trusted` check: declaring a package
 * in `packages:` is the trust decision. */
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { capabilityManifests, skillEntriesIn, kernelBin, sessionDefaults, homeLaunchLayers, instanceSoulDir, launchConfigsAt, preparedSoulIdOf, stableSoulId, launchFolderTrust, previewLaunchEnvironment, removedLaunchEnv, homeDeclaredLaunchEnv, launchReportFor, manifestOperations, parseYamlNested, servedIdentityOf, teamEnv, upgradeHomeMeta, withConfigFile } from "./core.mjs";
import { agentDirOf, discoverOrStandalone, ensureWorkspaceSoul, findSoulEntry, liveTeams, prepareInstance, resolutionContractWarnings, soulCopyDigests, soulsOffered } from "./instance-resolution.mjs";
import { declaredSettings, locatedContractWarnings } from "./capability-contract.mjs";
import { kernelCompatibility, unsafeRelPath } from "./resolve.mjs";
import { compareCodepoints, decodeText, FILES_PER_SKILL, SKILL_DOC_BUDGET, skillDocDescription, TEXT_LIMIT } from "./capability-show.mjs";
import { readFileHead } from "./bounded-read.mjs";
import { discoveredTeamKeys, isRemovedTeamKeys, isTeamRefusal, recordedTeams, reportRows, soulKeyOf, teamKeyOf, soulTeams, teamModel, teamProblems } from "./teams.mjs";
import { launchLayers, launchReport } from "./launch-preference.mjs";
import { loadLocal } from "./workspace.mjs";
import { CLAUDE_SESSION_HINT } from "./launch-prompt-fixtures.mjs";
import { neverSettled } from "./launch-prompts.mjs";
import { ensureModuleTree } from "./operator-dispatch.mjs";
import { operatorCoverage, operatorProblems } from "./operator-coverage.mjs";
import { readLockIfPresent } from "./packages.mjs";
import { composeSoulInstructions } from "./soul-composition.mjs";
import { readInstanceColor } from "./instance-color.mjs";
import { readInstanceBackground } from "./instance-background.mjs";
/** Bounds of a provider check's answer (bytes, nesting, entries), as the released binding wire set them. */
const BINDING_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, maxDepth: 32, maxEntries: 16384 });
import { parseStrictJson } from "./canonical-json.mjs";
import { sameRepo } from "./repo-moves.mjs";
import { kernelNode } from "./stable-node.mjs";

export const INSPECT_OPERATIONS_API = 2;
export const SOULS_API = 2;
export const READINESS_API = 2;
const LAYERS = ["knowledge", "messaging", "tasks"];
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** A resolution refusal that is a readiness FACT (the soul cannot resolve as the
 *  lock stands), not a failure to answer: reported as a failing `installed` item —
 *  or, for a refusal of the soul's teams (isTeamRefusal), as a team item in `configured`. */
const RESOLUTION_FACTS = new Set(["E_PACKAGE_MISSING", "E_PACKAGE_INTEGRITY", "E_CAPABILITY_MISSING", "E_LOCK_SCHEMA"]);
const isResolutionFact = (e) => RESOLUTION_FACTS.has(e?.code) || isTeamRefusal(e);

/** Is `name` an executable on PATH? (manifest `requires`, no shell). */
function onPath(name) {
  if (typeof name !== "string" || !name || name.includes("/")) return false;
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    try { accessSync(join(dir, name), fsConstants.X_OK); if (statSync(join(dir, name)).isFile()) return true; } catch { /* next */ }
  }
  return false;
}
const manifestRequires = (manifest) => (Array.isArray(manifest?.requires) ? manifest.requires : [])
  .filter((r) => obj(r) && typeof r.command === "string" && r.command)
  .map((r) => ({ command: r.command, why: r.why || null, install: r.install || null }));
const missingRequires = (manifest) => manifestRequires(manifest).filter((r) => !onPath(r.command));

/** A soul's own declarations, parsed by the kernel (never by a consumer). */
function declarationsOf(definition) {
  const d = obj(definition) ? definition : {};
  const section = (key) => (d[key] === undefined ? null : d[key]);
  return { requires: section("requires"), defaults: section("defaults"), knowledge: section("knowledge"), resources: section("resources"), children: section("children"), capabilities: section("capabilities") };
}
function readSoulYaml(soulDir) {
  const file = soulDir && join(soulDir, "soul.yaml");
  if (!file || !existsSync(file)) return { definition: null, problems: [] };
  try { return { definition: withConfigFile(file, () => parseYamlNested(readFileSync(file, "utf8"))), problems: [] }; }
  catch (e) { return { definition: null, problems: [{ code: "soul-declarations-unreadable", message: e.message }] }; }
}
function readTextCapped(file, cap = 200_000) {
  try { const text = readFileSync(file, "utf8"); return { file, text: text.length > cap ? text.slice(0, cap) : text, truncated: text.length > cap }; }
  catch { return { file, text: null, truncated: false }; }
}

/** The instance target: `home` is absolute and holds instance.json with modules.
 *  `teams` / `defaultTeam` are the home's LIVE teams (team model v2), read from this target's
 *  discovery when it discovers, else by liveTeams; `teamsSource` says which ("live" |
 *  "recorded": the spawn-time record, when the workspace cannot answer now).
 *  `live: false` skips the live read — a caller that never hands the teams to the
 *  messaging provider (a non-messaging operation) gets the record at no remote cost. */
export async function homeTarget(home, meta, { remoteOptions, discover = true, live: readLive = true } = {}) {
  const realHome = real(home);
  meta = upgradeHomeMeta(meta, realHome);
  // Only the home's own module copies: without <home>/.oats/modules the kernel's
  // manifest lookup would fall through to a classic config chain — never here.
  let manifests = {}; const loadProblems = [];
  if (existsSync(join(realHome, ".oats", "modules"))) {
    try { manifests = capabilityManifests(realHome); } catch (e) { loadProblems.push({ code: "module-manifest-invalid", message: e.message }); }
  }
  const modules = obj(meta.modules) ? meta.modules : {};
  const agentsRoot = dirname(dirname(dirname(realHome)));
  const deployment = dirname(agentsRoot);
  // The deployment's removed team keys (team model 3) refuse every reader of its oats-local.yaml, before
  // anything below falls back past an unreadable local file (live teams, launch, session defaults).
  try { loadLocal(deployment); } catch (e) { if (isRemovedTeamKeys(e)) throw e; }
  const ws = obj(meta.workspace) ? meta.workspace : {};
  const soulDir = instanceSoulDir(realHome, meta) ?? null;
  const { definition, problems } = readSoulYaml(soulDir);
  let discovery = null, discoveryError = null, local = null;
  if (discover) {
    try {
      // The derived deployment exactly — never an oats-local.yaml found further up.
      const found = loadLocal(deployment);
      if (real(dirname(found.path)) !== real(deployment)) throw Object.assign(new Error(`${deployment} has no oats-local.yaml`), { code: "E_HOME_MISMATCH" });
      local = found.local;
      discovery = await discoverOrStandalone(found.local, { deployment, remoteOptions });
    }
    catch (e) { discoveryError = { code: e.code || "E_REMOTE_UNREADABLE", message: e.message }; }
  }
  // External or member soul: spawn records the soul's repoKey, not its kind, so the
  // kind is observed (readiness discovers); null when not observed (inspect --home).
  let external = null;
  if (discovery) {
    try { const e = findSoulEntry(discovery, meta.agent); if (sameRepo(e.repoKey, ws.soul?.repoKey)) external = e.external === true; } catch { /* no longer declared */ }
    if (external === null && (discovery.members || []).some((m) => sameRepo(m.key, ws.soul?.repoKey))) external = false;
  }
  const slots = Object.fromEntries(LAYERS.map((l) => [l, Object.keys(modules).find((n) => manifests[n]?.layer === l) ?? null]));
  // The home's soul key in the workspace's souls: (teamKeyOf): <package>/<soul>, or <member>/<soul>.
  const teamKey = ws.soul?.package ? teamKeyOf({ ...ws.soul, package: ws.soul.package.id }) : teamKeyOf({ name: meta.agent, repoKey: ws.soul?.repoKey ?? "" });
  let live, model = null;
  if (discovery) {
    model = teamModel(discovery.standalone === true ? null : discovery.workspace, local, { workspaceKey: discovery.key ?? null });
    try { const t = soulTeams(model, teamKey); live = { teams: reportRows(t.teams), defaultTeam: t.defaultTeam, source: "live" }; }
    catch (e) { if (!isTeamRefusal(e)) throw e; live = { ...recordedTeams(meta), source: "recorded" }; }
  } else if (readLive) live = await liveTeams(realHome, meta, { remoteOptions });
  else live = { ...recordedTeams(meta), source: "recorded" };
  // Feature launch-preference: the recorded launch (frozen), and what --reselect-launch would choose now —
  // from the home's recorded soul and this deployment's oats-local.yaml (null when it cannot be read).
  const launch = recordedLaunch(meta);
  let launchCurrent = null;
  try { launchCurrent = launchReportFor({ layers: homeLaunchLayers(realHome, meta), launchConfigs: launchConfigsAt(deployment), contextDir: deployment }); }
  catch { launchCurrent = null; }
  return {
    kind: "instance", home: realHome, meta, deployment, agentsRoot, teams: live.teams, defaultTeam: live.defaultTeam ?? null, teamsSource: live.source, launch, launchCurrent, session: newSessionDefaults(deployment),
    recordedDefaultTeam: recordedTeams(meta).defaultTeam, teamModel: model, teamKey,
    subject: { kind: "instance", instance: meta.instance, home, soul: meta.agent },
    // The soul as its hooks and dispatched commands get it (OATS_AGENT, OATS_SOUL_ID): not reported.
    soulIdentity: { agent: meta.agent, id: stableSoulId({ home: realHome, soulDir, agentName: meta.agent }) },
    soul: { name: meta.agent, repoKey: ws.soul?.repoKey ?? null, commit: ws.soul?.commit ?? null, external, path: null, soulDir, definition, problems: [...problems, ...loadProblems],
      ...(obj(ws.soul?.package) && typeof ws.soul.package.id === "string" ? { package: { id: ws.soul.package.id, soul: ws.soul.name ?? meta.agent, version: ws.soul.package.version ?? null, commit: ws.soul.package.commit ?? ws.soul.commit ?? null, integrity: ws.soul.package.digest ?? null } } : {}) },
    workspace: { key: ws.key ?? null, name: typeof ws.name === "string" ? ws.name : discovery?.workspace?.name ?? null, deployment, commit: ws.commit ?? null, standalone: ws.standalone === true },
    modules: Object.keys(modules).sort().map((name) => ({ name, from: modules[name]?.from ?? null, manifest: manifests[name] ?? null, dir: join(realHome, ".oats", "modules", name) })),
    payloads: obj(meta.providers) ? meta.providers : {},
    payloadOrigins: Object.fromEntries((Array.isArray(meta.capabilities) ? meta.capabilities : []).filter((c) => c && typeof c.id === "string").map((c) => [c.id, obj(c.settingsOrigins) ? c.settingsOrigins : {}])),
    slots, slotsFrom: Object.fromEntries(LAYERS.map((l) => [l, obj(ws.layers?.[l]) ? ws.layers[l].from ?? null : null])), discovery, discoveryError, resolutionError: null,
    lock: null, prepared: null,
  };
}

/** The soul target, resolved exactly as a spawn of `soul` would be. A resolution
 *  refusal that is a readiness fact is kept as `resolutionError` (callers that
 *  must answer — inspect, operation run — refuse with it). `materialize: false`
 *  resolves only: it writes nothing under the deployment's agents root, and names the
 *  soul's per-commit copy only when an earlier resolution left one
 *  (materializeSoulTarget makes it, later, for a caller that then goes on). */
export async function soulTarget(contextDir, soul, { remoteOptions, materialize = true } = {}) {
  let prepared = null, resolutionError = null;
  try { prepared = await prepareInstance(contextDir, soul, { remoteOptions }); }
  catch (e) {
    if (!isResolutionFact(e)) throw e;
    resolutionError = { code: e.code, message: e.message, details: e.details ?? null };
  }
  const found = loadLocal(contextDir);
  const deployment = real(prepared?.deployment ?? (found.path ? dirname(found.path) : resolve(contextDir)));
  let discovery = prepared?.discovery ?? null, soulEntry = prepared?.soulEntry ?? null;
  if (!prepared) {
    // Still name the soul (and its member) when its resolution is refused.
    discovery = await discoverOrStandalone(found.local, { deployment, remoteOptions });
    soulEntry = findSoulEntry(discovery, soul);
  }
  const res = prepared?.resolution;
  // A refused resolution still names the soul's teams when they resolve (a package refusal, …); a
  // refusal of the teams themselves (isTeamRefusal) names none.
  const model = teamModel(discovery?.standalone === true ? null : discovery?.workspace ?? null, prepared?.local ?? found.local, { workspaceKey: discovery?.key ?? null });
  const teamKey = teamKeyOf(soulEntry);
  let teams = res?.teams ?? null, defaultTeam = res ? res.defaultTeam ?? null : null;
  if (!res) { try { const t = soulTeams(model, teamKey); teams = reportRows(t.teams); defaultTeam = t.defaultTeam; } catch (e) { if (!isTeamRefusal(e)) throw e; } }
  // The soul being asked about is materialised as a spawn would (ensureWorkspaceSoul: idempotent per
  // commit, never touching a directory an instance links), so its checks always get OATS_SOUL; only a
  // spawn wrote the per-commit copy before, and a provider asked about a soul not yet spawned at this
  // commit answered a false negative. A failure is a readiness fact (soulCopyError), never a silent null.
  // A refused resolution has nothing to materialise: the cached copy, when there is one.
  let soulDir = null, soulCopyError = null;
  if (prepared && materialize) {
    try { soulDir = await ensureWorkspaceSoul(prepared, join(deployment, "agents")); }
    catch (e) { soulCopyError = { code: e?.code || "E_SOUL_COPY_FAILED", message: e?.message || String(e) }; }
  } else {
    const cached = soulEntry?.commit ? join(deployment, "agents", agentDirOf(soulEntry), "souls", String(soulEntry.commit).slice(0, 12)) : null;
    soulDir = cached && existsSync(join(cached, "soul.yaml")) ? cached : null;
  }
  // Feature launch-preference: what a spawn with no flags would launch here.
  let launchConfigs = {};
  try { launchConfigs = launchConfigsAt(deployment); } catch { launchConfigs = {}; }
  const launch = launchReportFor({ layers: prepared?.launch ?? launchLayers({ definition: soulEntry.definition, entry: soulEntry, key: soulKeyOf(soulEntry), local: found.local, offered: soulsOffered(discovery) }), launchConfigs, contextDir: deployment });
  return {
    kind: "soul", home: null, meta: null, deployment, agentsRoot: join(deployment, "agents"), teams, defaultTeam, teamsSource: "live", teamModel: model, teamKey, launch, session: newSessionDefaults(deployment),
    subject: { kind: "soul", soul: soulEntry.name, repoKey: soulEntry.repoKey ?? null, commit: soulEntry.commit ?? null },
    // The soul as a spawn of it records it and hands its hooks (OATS_AGENT, OATS_SOUL_ID): not reported.
    soulIdentity: { agent: agentDirOf(soulEntry), id: preparedSoulIdOf(soulEntry) },
    soul: { name: soulEntry.name, repoKey: soulEntry.repoKey ?? null, commit: soulEntry.commit ?? null, external: soulEntry.external === true, path: soulEntry.path ?? null,
      soulDir, definition: soulEntry.definition ?? null, problems: [], ...(soulCopyError ? { copyError: soulCopyError } : {}),
      ...(typeof soulEntry.package === "string" ? { package: { id: soulEntry.package, soul: soulEntry.name, version: soulEntry.version ?? null, commit: soulEntry.commit ?? null, integrity: soulEntry.digest ?? null } } : {}) },
    workspace: { key: discovery?.key ?? null, name: discovery?.workspace?.name ?? null, deployment, commit: discovery?.commit ?? null, standalone: discovery?.standalone === true },
    modules: (res?.modules || []).map((m) => ({ name: m.name, from: m.from ?? null, manifest: m.manifest ?? null, dir: null, module: m })).sort((a, b) => a.name.localeCompare(b.name)),
    payloads: obj(res?.payloads) ? res.payloads : {}, payloadOrigins: obj(res?.payloadOrigins) ? res.payloadOrigins : {}, slots: obj(res?.slots) ? res.slots : Object.fromEntries(LAYERS.map((l) => [l, null])), slotsFrom: obj(res?.slotsFrom) ? res.slotsFrom : {},
    capabilitiesFrom: obj(res?.capabilitiesFrom) ? res.capabilitiesFrom : {}, turnedOff: Array.isArray(res?.turnedOff) ? res.turnedOff : [],
    discovery, discoveryError: null, resolutionError, lock: prepared?.lock ?? null, prepared,
  };
}

/** Materialise the soul of a target resolved with `materialize: false`, as soulTarget itself does:
 *  the per-commit copy its checks and commands get as OATS_SOUL. A failure is the same readiness
 *  fact (`soul.copyError`). → the target, updated in place */
export async function materializeSoulTarget(t) {
  if (!t.prepared) return t;
  try { t.soul.soulDir = await ensureWorkspaceSoul(t.prepared, t.agentsRoot); delete t.soul.copyError; }
  catch (e) { t.soul.copyError = { code: e?.code || "E_SOUL_COPY_FAILED", message: e?.message || String(e) }; }
  return t;
}

/** The tmux session a NEW tmux spawn here would open in ({tmuxSession}, 0.31); null when the
 *  deployment's oats-local.yaml cannot be read. */
function newSessionDefaults(deployment) {
  try { return sessionDefaults(deployment); } catch { return null; }
}

/** Is `dir` a v2 context (an oats-local.yaml in reach)? Only a MISSING file means
 *  "not a workspace"; an unreadable or invalid one is the caller's error to report,
 *  never a silent fallback to the classic chain. */
export function isWorkspaceContext(dir) {
  try { loadLocal(dir); return true; }
  catch (e) { if (e?.code === "E_LOCAL_MISSING") return false; throw e; }
}

/** The module's own kernel range against the running kernel: `{ ok, range, kernel }`; an
 *  unparseable range is not ok. A soul's resolution already refuses an incompatible module, so
 *  `ok: false` shows only for a home whose spawned module no longer admits this kernel. */
function compatibilityRow(name, manifest) {
  try { return kernelCompatibility({ ...manifest, capability: name }); }
  catch (e) { if (e?.code === "E_CAPABILITY_INCOMPATIBLE") return { ok: false, range: e.details?.range ?? null, kernel: e.details?.kernel ?? null }; throw e; }
}
function capabilityRows(t) {
  return t.modules.map(({ name, from, manifest, dir }) => {
    const m = manifest || {};
    const missing = missingRequires(m);
    const operations = manifestOperations(m).map((op) => {
      let reason = null;
      if (missing.length) reason = `${name} requires ${missing.map((x) => `"${x.command}" on PATH${x.why ? ` (${x.why})` : ""}`).join(", ")}`;
      else if (op.context === "home" && !t.home) reason = "needs a running home (--home)";
      return { ...op, argv: [m.command ?? null, op.command], available: !reason, reason };
    });
    // composedFrom (feature desktop-facts): where the soul's composition took it from — "workspace" |
    // "soul" (layers-from vocabulary); null for a home (not recorded at spawn). `from` is the module's origin.
    return { id: name, version: m.version ?? null, layer: m.layer ?? null, command: m.command ?? null, from, composedFrom: t.capabilitiesFrom?.[name] ?? null, dir,
      settings: obj(t.payloads[name]) ? t.payloads[name] : {}, declares: declaredSettings(m), compatibility: compatibilityRow(name, m), missingRequires: missing, operations };
  });
}
function soulRow(t) {
  const s = t.soul, def = obj(s.definition) ? s.definition : {};
  return { soulsApi: SOULS_API, name: s.name, repoKey: s.repoKey, commit: s.commit, kind: s.external === true ? "external" : s.external === false ? "member" : null, path: s.path,
    description: def.description ?? null, work: def.work ?? null, harness: def.harness ?? null, model: def.model ?? null,
    declarations: declarationsOf(s.definition), declarationProblems: s.problems,
    instructions: s.soulDir ? readTextCapped(join(s.soulDir, "AGENTS.md")) : null,
    // Feature soul-composed-instructions: only on a soul target that asked (inspect --instructions).
    ...(t.kind === "soul" && t.composedInstructions !== undefined ? { composedInstructions: t.composedInstructions } : {}),
    // Feature soul-skills: only on a soul target that asked (inspect --skills).
    ...(t.kind === "soul" && t.skills !== undefined ? { skills: t.skills } : {}),
    // Feature soul-composed-skills: only on a soul target that asked (inspect --composed-skills).
    ...(t.kind === "soul" && t.composedSkills !== undefined ? { composedSkills: t.composedSkills } : {}) };
}

/** The soul target with `composedInstructions` (feature soul-composed-instructions): the AGENTS.md a
 *  spawn of it here with no flags would write (lib/soul-composition.mjs), or null when the soul
 *  resolves but cannot be composed here — with the kernel's refusal as a problem naming
 *  composedInstructions, unless the soul copy's own problem (copyError) already says why. */
export async function withComposedInstructions(t, { compose = composeSoulInstructions } = {}) {
  return withComposition(t, { instructions: true, compose });
}

/** The soul target with what `--instructions` (composedInstructions) and `--composed-skills` (composedSkills,
 *  feature soul-composed-skills) ask for, from ONE scratch materialization of the soul (composeSoulInstructions).
 *  A soul that cannot be composed makes each asked field null, each with the kernel's refusal as a problem
 *  naming that field, unless the soul copy's own problem (copyError) already says why. */
export async function withComposition(t, { instructions = false, skills = false, compose = composeSoulInstructions } = {}) {
  if (t.kind !== "soul" || (!instructions && !skills)) return t;
  const fields = (v) => ({ ...(instructions ? { composedInstructions: v } : {}), ...(skills ? { composedSkills: v } : {}) });
  if (t.soul.copyError || !t.soul.soulDir || !t.prepared) return { ...t, ...fields(null) };
  const soulDir = t.soul.soulDir;
  try {
    // The scratch read only when composedSkills is asked for: --instructions alone composes as it always did.
    const inScratch = ({ outcome, scratch }) => composedSkillsIn(soulDir, scratch, Array.isArray(outcome?.skills) ? outcome.skills : []);
    const { composedInstructions, scratchResult } = await compose({ deployment: t.deployment, prepared: t.prepared, soulDir, ...(skills ? { inScratch } : {}) });
    return {
      ...t,
      ...(instructions ? { composedInstructions } : {}),
      ...(skills ? { composedSkills: scratchResult.composedSkills, ...(scratchResult.problems.length ? { composedSkillsProblems: scratchResult.problems } : {}) } : {}),
    };
  } catch (e) {
    if (typeof e?.code !== "string" || !e.code.startsWith("E_")) throw e;
    const problem = (field) => ({ code: e.code, message: `${field}: ${e.message}` });
    return {
      ...t, ...fields(null),
      ...(instructions ? { composedInstructionsProblem: problem("composedInstructions") } : {}),
      ...(skills ? { composedSkillsProblems: [problem("composedSkills")] } : {}),
    };
  }
}

// ---------- the soul's own skills (feature soul-skills) ----------
/** The whole `skills` field carries at most this many UTF-8 bytes of `text`, summed in answer order. */
export const SOUL_SKILLS_TEXT_BUDGET = 1024 * 1024;
const SKILLS_UNREADABLE = "soul-skills-unreadable", SKILL_FILES_UNREADABLE = "soul-skill-files-unreadable";
/** What readFileHead refuses: not a regular file, or not the file lstat found. */
const HEAD_REFUSALS = new Set(["invalid-declaration", "integrity-drift"]);
/** An entry the listing refuses, or a file it lists and cannot read safely: that skill's files are not listed. */
class Unlisted extends Error {}
/** A name that is not a safe relative path component (unsafeRelPath), or holds a control character. */
const unsafeName = (name) => unsafeRelPath(name) || /[\x00-\x1f\x7f]/.test(name);
/** A filesystem error (it has a syscall), a readFileHead refusal or one of ours, as the short reason a problem
 *  gives; anything else is a defect and is thrown. */
function unlistedReason(e, path) {
  if (e instanceof Unlisted) return e.message;
  if (typeof e?.syscall === "string") return `could not read ${path} (${e.code ?? e.syscall})`;
  if (HEAD_REFUSALS.has(e?.code)) return `could not read ${path} (${e.message})`;
  throw e;
}

/* Containment, by the kernel's realpath idiom (manifestPath): every directory is listed, and every file read, only
 * once its realpath lies inside the realpath of its skill, and the skill's inside the soul's. No symlink is ever
 * followed: the walk takes entry types from readdir (lstat semantics), and a file is read through readFileHead
 * (lstat a regular file, open O_NOFOLLOW|O_NONBLOCK, fstat the same file).
 * The residual race, deliberately left: an ancestor directory swapped for a symlink in the instant between a check
 * and the open can redirect a read (O_NOFOLLOW guards the last component only; Node has no openat). Only someone
 * who can write the deployment's agents/ tree can do that, and that person already controls the soul copy and
 * every instance's AGENTS.md. */
function insideOf(real, root, shown, where) {
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Unlisted(`${shown} resolves outside ${where}`);
  return real;
}

/** Every regular file under the skill directory `dir` (`path` relative to the soul), recursively: paths relative
 *  to it, in codepoint order. A symlink (never followed), FIFO, socket or device is not listed; an entry with an
 *  unsafe name refuses the listing. */
function skillFilePaths(dir, realSkill, path) {
  const out = [];
  const walk = (abs, rel) => {
    insideOf(realpathSync(abs), realSkill, rel ? `${path}/${rel}` : path, "its skill");
    const dirs = [];
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const entry = rel ? `${rel}/${e.name}` : e.name;
      if (unsafeName(e.name)) throw new Unlisted(`${JSON.stringify(entry)} is not a safe file name`);
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) out.push(entry);
    }
    for (const d of dirs) walk(join(abs, d), rel ? `${rel}/${d}` : d);
  };
  walk(dir, "");
  return out.sort(compareCodepoints);
}

/** A listed file of the skill, proved inside it, read up to `max` bytes. → { bytes, size } */
function readSkillFile(dir, realSkill, path, rel, max) {
  const abs = join(dir, ...rel.split("/"));
  insideOf(realpathSync(abs), realSkill, `${path}/${rel}`, "its skill");
  return readFileHead(abs, max);
}

/** One skill's row. Its files are listed and read in order against `budget` ({used, spent, limit}); the budget
 *  is charged only when the skill's files are listed (a `files: null` skill is not in the answer's text).
 *  `root` is what `path` is relative to and must contain the skill (the soul directory; for composedSkills'
 *  capability skills, the scratch home); `field` opens each problem message; `source`, when given, is the row's. */
function soulSkillRow(root, realRoot, { name, src }, budget, { field = "skills", where = "the soul", source } = {}) {
  const path = relative(root, src).split(sep).join("/");
  const row = { name, ...(source !== undefined ? { source } : {}), path, description: null, files: null, filesTruncated: false };
  const problem = (reason) => ({ row, problem: { code: SKILL_FILES_UNREADABLE, message: `${field}: ${path}: could not list its files: ${reason}` } });
  if (unsafeName(name)) return problem(`${JSON.stringify(name)} is not a safe skill name`);
  let realSkill;
  try { realSkill = insideOf(realpathSync(src), realRoot, path, where); } catch (e) { return problem(unlistedReason(e, path)); }
  // The description by capabilities show's rule (skillDocDescription): SKILL.md read up to SKILL_DOC_BUDGET; null
  // when it cannot be read, is a symlink, is binary or is larger.
  let doc = null;
  try { doc = readSkillFile(src, realSkill, path, "SKILL.md", SKILL_DOC_BUDGET); } catch (e) { unlistedReason(e, `${path}/SKILL.md`); }
  if (doc) row.description = skillDocDescription(doc.bytes, doc.size);
  let paths;
  try { paths = skillFilePaths(src, realSkill, path); } catch (e) { return problem(unlistedReason(e, path)); }
  let { used, spent } = budget;
  const files = [];
  for (const rel of paths.slice(0, FILES_PER_SKILL)) {
    const filePath = `${path}/${rel}`;
    let read;
    // TEXT_LIMIT + 4 bytes: one past the bytes decodeText examines, so it answers on the head as on the whole file.
    try { read = rel === "SKILL.md" && doc ? doc : readSkillFile(src, realSkill, path, rel, spent ? 0 : TEXT_LIMIT + 4); }
    catch (e) { return problem(unlistedReason(e, filePath)); }
    const omitted = { path: filePath, bytes: read.size, text: null, binary: false, truncated: false, omitted: true };
    if (spent) { files.push(omitted); continue; }
    const decoded = decodeText(read.bytes);
    const cost = decoded.text === null ? 0 : Buffer.byteLength(decoded.text, "utf8");
    if (used + cost > (budget.limit ?? SOUL_SKILLS_TEXT_BUDGET)) { spent = true; files.push(omitted); continue; }
    used += cost;
    files.push({ path: filePath, bytes: read.size, ...decoded });
  }
  Object.assign(budget, { used, spent });
  return { row: { ...row, files, filesTruncated: paths.length > FILES_PER_SKILL }, problem: null };
}

/** The soul's own skills as `inspect --soul --skills` reports them: → { skills, problems }. Exactly the skills a
 *  spawn copies (spawn's skillEntriesIn, run strict, so a skill it cannot examine is a problem, not a missing
 *  skill), sorted by name in codepoint order; `[]` without a `skills/` directory; null, with a problem, when they
 *  cannot be listed (a symlinked `skills/` included, which is never followed). Read-only. */
export function soulSkills(soulDir) {
  const unreadable = (reason) => ({ skills: null, problems: [{ code: SKILLS_UNREADABLE, message: `skills: ${reason}` }] });
  try {
    const { entries, realSoul } = soulSkillEntries(soulDir);
    const budget = { used: 0, spent: false };
    const skills = [], problems = [];
    for (const entry of entries) {
      const { row, problem } = soulSkillRow(soulDir, realSoul, entry, budget);
      skills.push(row);
      if (problem) problems.push(problem);
    }
    return { skills, problems };
  } catch (e) { return unreadable(unlistedReason(e, "skills/")); }
}

/** The soul's own skill entries, in codepoint order, by spawn's enumerator run strict: → { entries, realSoul }.
 *  No `skills/` is no entries. Throws Unlisted (a symlinked or non-directory `skills/`, one resolving outside
 *  the soul), or what the filesystem throws: the caller says which field could not be listed. */
function soulSkillEntries(soulDir) {
  const tree = join(soulDir, "skills");
  let st;
  try { st = lstatSync(tree); } catch (e) { if (e?.code === "ENOENT") return { entries: [], realSoul: null }; throw e; }
  if (st.isSymbolicLink()) throw new Unlisted("the soul's skills/ is a symbolic link, which is not followed");
  if (!st.isDirectory()) throw new Unlisted("the soul's skills is not a directory");
  const realSoul = realpathSync(soulDir);
  insideOf(realpathSync(tree), realSoul, "skills/", "the soul");
  return { entries: skillEntriesIn(tree, { strict: true }).sort((a, b) => compareCodepoints(a.name, b.name)), realSoul };
}

// ---------- the composed skills (feature soul-composed-skills) ----------
/** The whole `composedSkills` field carries at most this many UTF-8 bytes of `text`, summed in answer order. */
export const COMPOSED_SKILLS_TEXT_BUDGET = 2 * 1024 * 1024;

/** The skill a spawn would refuse as a duplicate, by spawn's rule (spawnInstance's `offer`): names compare
 *  case-insensitively, a soul skill against the capability skills materialize placed and against the soul's
 *  others. → `{ name, message }` with spawn's sentence, or null. */
export function composedSkillCollision(soulEntries, moduleSkills) {
  const moduleOwner = new Map(moduleSkills.map((s) => [s.name.toLowerCase(), s.module]));
  const seen = new Set();
  for (const { name } of soulEntries) {
    const key = name.toLowerCase();
    if (seen.has(key) || moduleOwner.has(key)) {
      const other = seen.has(key) ? "soul" : `module ${moduleOwner.get(key)}'s skill`;
      return { name, message: `skill "${name}" from soul collides with ${other}` };
    }
    seen.add(key);
  }
  return null;
}

/** Every skill an instance of the soul gets, as `inspect --soul --composed-skills` reports them: → { composedSkills,
 *  problems }. The soul's own skills from the soul copy (soulSkillEntries, `path` relative to the soul) and the
 *  capability skills materialize placed in the scratch home `scratch` (`moduleSkills`, its outcome.skills, read
 *  from their module copies there, `path` home-relative as `from` has it), one list in codepoint order by name
 *  under one text budget. Null, with spawn's E_SKILL_DUPLICATE, when a spawn would refuse a collision; null with
 *  soul-skills-unreadable when the soul's skills cannot be listed. Read-only. */
export function composedSkillsIn(soulDir, scratch, moduleSkills) {
  const unreadable = (reason) => ({ composedSkills: null, problems: [{ code: SKILLS_UNREADABLE, message: `composedSkills: ${reason}` }] });
  let soul, realScratch;
  try { soul = soulSkillEntries(soulDir); realScratch = realpathSync(scratch); }
  catch (e) { return unreadable(unlistedReason(e, "skills/")); }
  const collision = composedSkillCollision(soul.entries, moduleSkills);
  if (collision) return { composedSkills: null, problems: [{ code: "E_SKILL_DUPLICATE", message: `composedSkills: ${collision.message}` }] };
  const rows = [
    ...soul.entries.map((entry) => ({ entry, root: soulDir, realRoot: soul.realSoul, where: "the soul", source: "soul" })),
    ...moduleSkills.map((s) => ({ entry: { name: s.name, src: join(scratch, ...s.from.split("/")) }, root: scratch, realRoot: realScratch, where: "the composed home", source: `module:${s.module}` })),
  ].sort((a, b) => compareCodepoints(a.entry.name, b.entry.name));
  const budget = { used: 0, spent: false, limit: COMPOSED_SKILLS_TEXT_BUDGET };
  const composedSkills = [], problems = [];
  for (const { entry, root, realRoot, where, source } of rows) {
    const { row, problem } = soulSkillRow(root, realRoot, entry, budget, { field: "composedSkills", where, source });
    composedSkills.push(row);
    if (problem) problems.push(problem);
  }
  return { composedSkills, problems };
}

/** The soul target with `skills` (feature soul-skills): the soul's own skills from the soul copy inspect
 *  materialised (soulSkills). Null when that copy failed (its copyError already says why) or the soul does not
 *  resolve; reading problems are `skillsProblems`. */
export async function withSkills(t) {
  if (t.kind !== "soul") return t;
  if (t.soul.copyError || !t.soul.soulDir || !t.prepared) return { ...t, skills: null };
  const { skills, problems } = soulSkills(t.soul.soulDir);
  return { ...t, skills, ...(problems.length ? { skillsProblems: problems } : {}) };
}

/** `oats inspect --json` on the workspace model. */
/** What the target's capabilities declare and this kernel ignores (an unknown hook event):
 *  [{ code, capability, path, message }]. A soul's from its resolution, where each manifest is read
 *  (`<repoKey>:<dir>/oats.json`, `package:<id>:<dir>/oats.json`); a home's from its module copies,
 *  at their path in the home (`.oats/modules/<name>/oats.json`: the source directory is not recorded). */
export function targetWarnings(t) {
  if (!t.home) return resolutionContractWarnings(t.prepared?.resolution);
  return t.modules.filter((x) => x.manifest).flatMap((x) => locatedContractWarnings(x.manifest, `.oats/modules/${x.name}/oats.json`));
}

export function inspectDocument(t, { kernel }) {
  const capabilities = capabilityRows(t);
  // `from` (feature layers-from): where the slot's capability came from; null for an empty slot, and for a
  // home spawned before the kernel recorded it.
  const layers = Object.fromEntries(LAYERS.map((l) => [l, { id: t.slots[l] ?? null, from: t.slots[l] ? t.slotsFrom?.[l] ?? null : null }]));
  const kcap = layers.knowledge.id ? capabilities.find((c) => c.id === layers.knowledge.id) : null;
  const m = t.meta;
  return {
    operationsApi: INSPECT_OPERATIONS_API, kernel, subject: t.subject, workspace: t.workspace,
    souls: [soulRow(t)], layers, capabilities,
    // The capabilities the soul turned off (feature desktop-facts): its `off` over a workspace/team entry
    // (reason "off"), or a `<slot>: none` that dropped a workspace default (reason "slot-none", slot).
    capabilitiesOff: (t.turnedOff || []).map(({ name, reason, slot, overrides }) => ({ id: name, off: true, from: "soul", reason, ...(slot ? { slot } : {}), overrides })),
    // Team model v2 (feature team-model-2): the soul's teams here and its default — live for a home
    // (`teamsSource: "recorded"` when its workspace could not be read now), which also answers the
    // default it was spawned with.
    teams: t.teams ?? null, defaultTeam: t.defaultTeam ?? null, teamsSource: t.teamsSource ?? null,
    ...(t.home ? { recordedDefaultTeam: t.recordedDefaultTeam ?? null } : {}),
    // Feature launch-preference: a soul's launch here; a home's recorded launch and launchCurrent.
    launch: t.launch ?? null,
    ...(t.home ? { launchCurrent: t.launchCurrent ?? null } : {}),
    // What a new tmux spawn here would open in: {tmuxSession} (0.31).
    session: t.session ?? null,
    knowledge: kcap ? { provider: kcap.id, version: kcap.version, operations: kcap.operations.map((o) => ({ name: o.name, kind: o.kind, available: o.available, reason: o.reason })) } : { provider: null, version: null, operations: [] },
    instance: m ? { home: t.home, instance: m.instance, agent: m.agent, harness: m.harness || null, model: m.model ?? null, yolo: m.yolo ?? null,
      launchConfig: m.launch?.launchConfig ?? null, launchConfigDefault: m.launch?.launchConfigDefault === true, launched: !!m.launched, createdAt: m.createdAt || null,
      // Feature instance-color: the home's colour record (lib/instance-color.mjs), a palette name or null.
      color: readInstanceColor(t.home),
      // Feature instance-background: `true` while the home holds a valid record, absent otherwise (as on a row).
      ...(readInstanceBackground(t.home) ? { background: true } : {}),
      resolution: m.workspace?.resolution ?? null, soulDir: t.soul.soulDir, instructions: { ...readTextCapped(join(t.home, "AGENTS.md")), sources: m.instructions || [] } } : null,
    ...(m ? { identity: servedIdentityOf(m) } : {}),
    problems: [...t.soul.problems, ...(t.soul.copyError ? [t.soul.copyError] : []), ...(t.composedInstructionsProblem ? [t.composedInstructionsProblem] : []), ...(t.skillsProblems || []), ...(t.composedSkillsProblems || []), ...(t.discoveryError ? [t.discoveryError] : []),
      ...t.modules.filter((x) => !x.manifest).map((x) => ({ code: "module-missing", message: `${x.name} is recorded but its module copy has no readable oats.json`, capability: x.name })),
      ...capabilities.filter((c) => !c.compatibility.ok).map((c) => ({ code: "capability-incompatible", message: `${c.id} requires oats ${c.compatibility.range}; this kernel is ${c.compatibility.kernel} (re-spawn from the deployment with a release whose range admits it)`, capability: c.id, range: c.compatibility.range, kernel: c.compatibility.kernel }))],
    warnings: targetWarnings(t),
  };
}

// ---------- readiness ----------
/** The soul's team problems as readiness items in `checks.configured` (team model v2; no fifth check:
 *  released Desktops recompute the summary from the four). A failure blocks `ready`; a warning is
 *  `required: false`. A home also compares its spawn-time default with the live one. */
function teamItems(t) {
  if (!t.teamModel) return [];
  const problems = teamProblems(t.teamModel, { key: t.teamKey, messaging: !!t.slots?.messaging, soulKeys: t.discovery ? discoveredTeamKeys(t.discovery) : null });
  const same = (a, b) => (a?.label ?? null) === (b?.label ?? null) && (a?.team ?? null) === (b?.team ?? null);
  if (t.home && t.teamsSource === "live" && t.meta?.defaultTeam !== undefined && !same(t.recordedDefaultTeam, t.defaultTeam)) {
    problems.push({ code: "default-team-changed", severity: "warning", recorded: t.recordedDefaultTeam, current: t.defaultTeam,
      message: `this instance was spawned in ${t.recordedDefaultTeam?.label ?? "no default team"}; the default is now ${t.defaultTeam?.label ?? "none"}`, fix: "respawn" });
  }
  return problems.map(({ code, severity, message, fix, ...rest }) => item(rest.label ? `team ${rest.label}` : "teams", "fail",
    { required: severity === "failure", producer: "team model", code, reason: message, remedy: fix, ...rest }));
}
/** The home's recorded launch as a `Launch` (from instance.json; `from: "recorded"` for a home from before 0.30). */
function recordedLaunch(meta) {
  const recipe = obj(meta?.launch) ? meta.launch : {};
  return launchReport({ declared: obj(meta?.launchDeclared) ? meta.launchDeclared : null, harness: meta?.harness || recipe.harness || null, model: meta?.model || null,
    launchConfig: recipe.launchConfig ?? null, from: typeof meta?.launchFrom === "string" ? meta.launchFrom : "recorded", at: meta?.launchAt ?? null });
}
/** `launch-changed` (feature launch-preference; `--home` only): a home whose launch a LAYER chose (not explicit
 *  flags, not a pre-0.30 record) now reads a different launch from the layers. A warning: the home keeps its
 *  recorded launch until `--reselect-launch` or a respawn. */
function launchItems(t) {
  if (!t.home || !t.launch || !t.launchCurrent || !["local", "local-default", "soul", "host"].includes(t.launch.from)) return [];
  const a = t.launch.effective, b = t.launchCurrent.effective;
  if (a.harness === b.harness && a.model === b.model && a.launchConfig === b.launchConfig) return [];
  const show = (e) => `${e.harness ?? "?"}${e.model ? ` ${e.model}` : ""}${e.launchConfig ? ` (launch configuration ${e.launchConfig})` : ""}`;
  return [item("launch", "fail", { required: false, producer: "launch preference", code: "launch-changed",
    reason: `this instance runs ${show(a)}; its launch preference now says ${show(b)} (${t.launchCurrent.at ?? t.launchCurrent.from})`,
    remedy: "`oats session restart --reselect-launch`, or respawn", recorded: a, current: b, from: t.launchCurrent.from, at: t.launchCurrent.at })];
}
/** `harness-trust` (#341, #886): whether the configuration file the claude or codex session this
 *  subject launches reads trusts the deployment: a passing item naming that file, or a warning that
 *  folder trust is not established there (a missing root entry does not prove a prompt). The file is
 *  the launch's own (#993): the one its launch configuration names (an instance's recorded launch
 *  env; a soul's selected launch configuration, for a home under the agents root), else the one the
 *  pane it would run in selects, as a command that only reads can know it (core.mjs
 *  previewLaunchEnvironment): never this process's own. Two answers are `unknown`, each with its
 *  sentence in `reason`. No pane's environment is established (no OATS tmux server runs): `file` is
 *  what this process would read, the reason says what it holds and names what was read instead.
 *  The pane's environment could not be read: `file` is null, and the reason says which name, read
 *  from where, and nothing about trust. Reads, never writes, the harness's configuration
 *  (lib/harness-trust.mjs). */
function folderTrustItems(t) {
  const harness = t.home ? t.meta?.harness : t.launch?.effective?.harness;
  if (harness !== "claude" && harness !== "codex") return [];
  const meta = t.home ? t.meta : { workspace: { deployment: t.deployment } };
  // A soul's yolo and env are its selected launch configuration's (a host fact, never the soul's).
  const name = t.home ? t.meta?.launch?.launchConfig : t.launch?.effective?.launchConfig;
  const config = t.home ? null : (() => { try { return launchConfigsAt(t.deployment)[name]; } catch { return undefined; } })();
  const yolo = t.home ? (t.meta?.yolo ?? t.meta?.launch?.yolo) : config?.yolo;
  const configEnv = t.home ? t.meta?.launch?.env : config?.env;
  const env = obj(configEnv) ? configEnv : {};
  // A home's launch removes what its providers declare and its recorded payload leaves out (core.mjs
  // removedLaunchEnv): a selector among them is not the pane's.
  const recipe = t.home && obj(t.meta?.launch) ? t.meta.launch : null;
  const removed = recipe ? removedLaunchEnv({ declared: homeDeclaredLaunchEnv(t.meta, recipe, Object.fromEntries((t.modules || []).filter((m) => m.manifest).map((m) => [m.name, m.manifest]))), hooksEnv: obj(recipe.hooks?.env) ? recipe.hooks.env : {}, configEnv: env }) : [];
  const trust = launchFolderTrust({ harness, home: t.home ?? t.agentsRoot, meta, yolo, configEnv: env, launchConfig: name,
    launch: previewLaunchEnvironment({ configEnv: env, configName: name, removed, ...(t.home ? { home: t.home, meta: t.meta } : { deployment: t.deployment }) }) });
  // Not the pane's: what this process would read says nothing certain about the launch.
  const unestablished = trust.note ? trust.warning ?? `${harness} folder trust is established in ${trust.file}; that file is this process's, not known to be the one a launch will read: ${trust.note}` : null;
  return [item("launch", trust.unreadable || unestablished ? "unknown" : trust.warning ? "fail" : "pass", { required: false, producer: "harness folder trust", code: "harness-trust", reason: unestablished ?? trust.warning,
    harness, file: trust.file, deployment: t.deployment })];
}
/** `launch-prompt` (a warning): this home's last start blocked at a prompt that equals no
 *  development-channel tolerance entry, so the instance waits for a person. It names what
 *  differed and both remedies, adds that Claude may have ignored the flag when the blocked
 *  screen was Claude's running session, and clears when a later start records anything but
 *  `blocked` (`flag-ignored` included). */
function launchPromptItems(t) {
  const prompts = t.home ? t.meta?.launchPrompts : null;
  if (prompts?.status !== "blocked") return [];
  const d = prompts.differed?.firstDifference;
  const differed = prompts.differed && d ? ` (nearest tolerance entry ${prompts.differed.nearest}, first difference at ${d.index}: expected ${JSON.stringify(d.expected)}, found ${JSON.stringify(d.found)})` : "";
  // A screen that never settled within the bound established no prompt to read and answer.
  const settled = !neverSettled(prompts.reason);
  const enterSent = prompts.answers?.some((a) => a.status === "submitted");
  return [item("launch", "fail", { required: false, producer: "launch prompt", code: "launch-prompt",
    reason: settled ? `the last start of this instance stopped at a prompt OATS does not confirm: ${prompts.reason}${differed}`
      : enterSent ? `the last start of this instance sent one Enter to the development-channel confirmation, then never showed 2 s of a clean session within the 30 s bound: ${prompts.reason}${differed}`
      : `the last start of this instance never settled into a screen OATS recognises within the 30 s bound: ${prompts.reason}${differed}`,
    remedy: `${settled ? "read the prompt in the instance's terminal and press Enter if it is the development-channel confirmation, or add its captured wording as a tolerance entry (lib/launch-prompt-fixtures/dev-channel-confirmation.json) in a reviewed PR"
      : enterSent ? "look at the instance's terminal: OATS sent its one Enter and sends no other key; if Claude's session is running, it started, and a later start clears this"
      : "look at the instance's terminal: OATS established no prompt there and sent no key; if Claude's session is running, restart the instance"}${prompts.claudeSessionShown ? `. ${CLAUDE_SESSION_HINT}` : ""}`,
    ...(prompts.differed ? { differed: prompts.differed } : {}) })];
}
/** Operator coverage (#671; warnings, never required): whether a soul this workspace offers composes
 *  oats.setup (lib/operator-coverage.mjs), for the workspace and for the subject's own teams, over the
 *  discovery this read already made. `operator-coverage-unknown` when that discovery is missing. */
async function operatorItems(t, { remoteOptions } = {}) {
  let local = t.prepared?.local ?? null, lock = t.lock ?? null;
  if (!local) { try { local = loadLocal(t.deployment).local; } catch { local = null; } }
  if (!t.lock) { try { lock = readLockIfPresent(t.deployment); } catch { lock = null; } }
  const coverage = t.discovery ? await operatorCoverage({ discovery: t.discovery, local, lock, teams: (t.teams || []).map((r) => r?.label), remoteOptions })
    : { known: false, reason: t.discoveryError ? `the workspace could not be read: ${t.discoveryError.message}` : "the workspace was not read" };
  const unknownRemedy = "make the workspace and its members readable from here (`oats workspace status` names the unreadable source), then read readiness again";
  return operatorProblems(coverage, { workspace: t.workspace?.name ?? null, unknownRemedy }).map(({ code, label, message, remedy, excluded }) =>
    item(label ? `team ${label}` : "operator", code === "operator-coverage-unknown" ? "unknown" : "fail",
      { required: false, producer: "operator coverage", code, reason: message, remedy, ...(label ? { label } : {}), ...(excluded?.length ? { evidence: { excluded } } : {}) }));
}
function roll(items) {
  const req = items.filter((i) => i.required !== false);
  if (!items.length) return "not-applicable";
  if (req.some((i) => i.status === "fail")) return "fail";
  if (req.some((i) => i.status === "unknown")) return "unknown";
  return req.length ? "pass" : "not-applicable";
}
/** A readiness item's free text is at most ITEM_TEXT characters (#725): the Desktop refuses a WHOLE answer
 *  whose item reason, remedy or problem message is over 1024 (packages/client/readiness-contract.mjs),
 *  and some producers carry remote text (a discovery error). Producers that bound their own text keep it. A
 *  provider's own answer (`result`) is relayed verbatim, never clipped here. */
export const ITEM_TEXT = 1000;
const bounded = (text) => (typeof text === "string" && text.length > ITEM_TEXT ? `${text.slice(0, ITEM_TEXT - 1)}…` : text);
const item = (subject, status, { required = true, reason = null, producer = "kernel", evidence = null, remedy = null, ...rest } = {}) =>
  ({ subject, status, required, reason: bounded(reason), producer, evidence, remedy: bounded(remedy), ...rest,
    ...(Array.isArray(rest.problems) ? { problems: rest.problems.map((p) => (obj(p) && typeof p.message === "string" ? { ...p, message: bounded(p.message) } : p)) } : {}) });

/** The team/workspace facts a provider receives, as hooks get them (teamEnv), and the soul's name and
 *  stable id as its hooks and dispatched commands get them. Every ambient OATS_* is removed first. */
function providerEnv(t, capability, settings) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OATS_|OAS_|PI_)/.test(k)));
  Object.assign(env, teamEnv({ workspace: { key: t.workspace.key, name: t.workspace.name, deployment: t.deployment }, teams: t.teams, defaultTeam: t.defaultTeam, teamsSource: t.teamsSource }));
  return Object.assign(env, { OATS_CAPABILITY: capability, OATS_SETTINGS: JSON.stringify(settings), OATS_SETTINGS_ORIGINS: JSON.stringify(t.payloadOrigins?.[capability] ?? {}), OATS_CLI_BIN: kernelBin(), OATS_NODE_BIN: kernelNode().node, OATS_WORKSPACE: t.deployment,
    ...(t.home ? { OATS_INSTANCE: t.meta.instance, OATS_INSTANCE_HOME: t.home } : {}), OATS_AGENT: t.soulIdentity?.agent || t.soul.name, ...(t.soulIdentity?.id ? { OATS_SOUL_ID: t.soulIdentity.id } : {}),
    ...(t.soul.soulDir ? { OATS_SOUL: t.soul.soulDir } : {}) });
}
/** An executable inside a module directory: both sides realpath'd (a symlink out of
 *  the module is an escape, as for the kernel's manifestPath), a regular file. */
function moduleExecutable(dir, script) {
  let root, file;
  try { root = realpathSync(dir); file = realpathSync(resolve(dir, script)); } catch { return null; }
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}
/** Run one of a capability's own commands the way a provider check runs (the binding wire's
 *  runner, shared with trigger sources, lib/triggers.mjs): `node <script> <args>` from the module
 *  directory, the script contained in it (moduleExecutable), one JSON `request` on stdin, the
 *  environment providerEnv's for the request's `settings`, SIGKILL at `timeoutMs`, at most
 *  BINDING_LIMITS of stdout, decoded as exactly one strict JSON document (whitespace around it
 *  allowed). → { doc } or { failure: "no-command" | "no-executable" (script) | "incomplete"
 *  (timedOut, signal, overflow) | "exit" (status) | "invalid" }. The caller judges the document. */
export function runModuleCommand(t, mod, dir, command, request, { timeoutMs = 30000 } = {}) {
  const spec = command ? mod.manifest?.commands?.[command] : null;
  if (typeof spec !== "string" || !spec.trim()) return { failure: "no-command" };
  const [script, ...args] = spec.trim().split(/\s+/);
  const file = dir ? moduleExecutable(dir, script) : null;
  if (!file) return { failure: "no-executable", script };
  // The environment is providerEnv's: ambient OATS_/OAS_/PI_ identity removed, the rest
  // inherited.
  const r = spawnSync(process.execPath, [file, ...args], { cwd: dir, env: providerEnv(t, mod.name, request.settings), input: JSON.stringify(request), encoding: "utf8", timeout: Math.max(1, timeoutMs), killSignal: "SIGKILL", maxBuffer: BINDING_LIMITS.maxBytes, stdio: ["pipe", "pipe", "pipe"] });
  if (r.error || r.signal) return { failure: "incomplete", timedOut: r.error?.code === "ETIMEDOUT", signal: r.signal ?? null, overflow: r.error?.code === "ENOBUFS" };
  if (r.status !== 0) return { failure: "exit", status: r.status };
  try { return { doc: parseStrictJson(r.stdout || "", BINDING_LIMITS) }; } catch { return { failure: "invalid" }; }
}
/** The four check statuses of the binding wire, and what each means for readiness. */
const PROVIDER_STATUS_ITEM = Object.freeze({ ready: "pass", "needs-configuration": "fail", "authorization-required": "fail", unavailable: "unknown" });
const ENVELOPE_KEYS = ["schemaVersion", "phase", "slot", "capability", "ok"];
function validProblems(p) { return Array.isArray(p) && p.every((x) => obj(x) && typeof x.code === "string" && typeof x.message === "string"); }
const codeMessages = (p) => p.map((x) => ({ code: x.code, message: x.message }));
/** Run one provider's binding check. → { outcome: "result", result: {status, problems,
 *  warnings} } verbatim, or `unknown` with the provider's own refusal (never a kernel
 *  invention). The answer is decoded by the released binding wire's response rules:
 *  exit 0, exactly one strict JSON
 *  document within BINDING_LIMITS, the exact envelope echoing schemaVersion/phase/
 *  slot/capability, one of the four statuses, and no problems on `ready`. Problem codes
 *  are the provider's own (not checked against binding.reasons, which are refusal
 *  sentences); problems and the optional warnings must be {code, message} strings. */
export function runProviderCheck(t, mod, dir, { timeoutMs = 30000 } = {}) {
  const m = mod.manifest, check = m?.binding?.check;
  const unavailable = (code, message) => ({ outcome: "unknown", problems: [{ code, message }] });
  const settings = obj(t.payloads[mod.name]) ? t.payloads[mod.name] : {};
  // The released binding wire, key for key: providers decode it strictly (oats.aweb 1.13.1
  // refuses any other key). The teams reach the check through its environment
  // (OATS_DEFAULT_TEAM* / OATS_TEAMS / OATS_TEAMS_SOURCE, providerEnv), never on stdin.
  const request = { schemaVersion: 1, phase: "check", slot: m.layer ?? null, capability: mod.name, settings,
    input: { context: { kind: "workspace", workspace: t.workspace.key, deployment: t.deployment, soul: t.soul.name, instance: t.meta?.instance ?? null, home: t.home }, action: { kind: "readiness" } } };
  const run = runModuleCommand(t, mod, dir, check, request, { timeoutMs });
  if (run.failure === "no-command") return unavailable("provider-not-qualified", `${mod.name} declares binding.check but no command ${JSON.stringify(check)}`);
  if (run.failure === "no-executable") return unavailable("resource-not-found", `${mod.name}: the check executable ${run.script} is unavailable`);
  if (run.failure === "incomplete") return unavailable("provider-unavailable", `${mod.name} check did not complete${run.timedOut || run.signal ? " in time" : ""}`);
  if (run.failure === "exit") return unavailable("provider-unavailable", `${mod.name} check exited ${run.status}`);
  const invalid = () => unavailable("provider-unavailable", `${mod.name} check answered invalid binding data`);
  if (run.failure === "invalid") return invalid();
  const doc = run.doc;
  try {
    if (!obj(doc)) return invalid();
    const allowed = [...ENVELOPE_KEYS, doc.ok === true ? "result" : "error"];
    if (Object.keys(doc).some((k) => !allowed.includes(k)) || allowed.some((k) => !Object.hasOwn(doc, k))) return invalid();
    for (const key of ["schemaVersion", "phase", "slot", "capability"]) if (doc[key] !== request[key]) return invalid();
  } catch { return invalid(); }
  if (doc.ok === false) {
    const e = doc.error;
    if (!obj(e) || typeof e.code !== "string" || (e.message !== undefined && typeof e.message !== "string")) return invalid();
    // The code becomes the kernel's problems[].code, which the Desktop takes up to 128 characters (#725):
    // a longer or unprintable one is the provider's failure to answer, not a code.
    const code = e.code.length <= 128 && !/[\x00-\x1f\x7f]/.test(e.code) ? e.code : "provider-unavailable";
    return unavailable(code, e.message ?? `${mod.name} refused the check`);
  }
  const res = doc.result;
  if (doc.ok !== true || !obj(res) || Object.keys(res).some((k) => !["status", "problems", "warnings"].includes(k))
    || !Object.hasOwn(PROVIDER_STATUS_ITEM, res.status) || !validProblems(res.problems)
    // `warnings` is optional (absent → []), validated as strictly as problems, and never
    // changes the status (e.g. a ready binding with end-to-end encryption disabled).
    || (res.warnings !== undefined && !validProblems(res.warnings))
    || (res.status === "ready" && res.problems.length)) return invalid();
  return { outcome: "result", result: { status: res.status, problems: codeMessages(res.problems), warnings: codeMessages(res.warnings ?? []) } };
}
/** The `member` item of a package soul. A package soul is trusted through the workspace's
 *  `packages:` pin (the lock's commit and integrity), never through membership: its
 *  repository is not a member and need not be (docs/workspaces.md, the non-collapse rule).
 *  It passes when the discovery lists the soul from the lock (the package declared and
 *  locked, the soul shipped at the locked commit) and the soul's copy is intact: for a
 *  soul, the copy a spawn would link matches the locked digest; for a home, its copy
 *  matches the digest it recorded, and a lock still at that commit records the same one.
 *  A copy is digested every read: a complete copy is reused, never refetched. */
function packageSoulItem(t, d) {
  const p = t.soul.package;
  const subject = `package ${p.id}/${p.soul}`;
  const from = { kind: "package", package: p.id, version: p.version, commit: p.commit, integrity: p.integrity };
  const evidence = { repoKey: t.soul.repoKey, workspace: d?.key ?? null, commit: p.commit, version: p.version, integrity: p.integrity, from };
  if (!d) return item(subject, "unknown", { producer: "workspace discovery", reason: t.discoveryError ? `the workspace could not be read: ${t.discoveryError.message}` : "no workspace observation", evidence });
  if (d.standalone === true) return item(subject, "not-applicable", { required: false, producer: "workspace discovery", reason: `standalone view (${d.standaloneReason ?? "explicit"}): the workspace's packages: is not read, so the package pin is recorded, not observed`, evidence });
  const shipped = (d.packageSouls || []).filter((s) => s.package === p.id);
  const live = shipped.find((s) => s.name === p.soul);
  if (!live) {
    // A home whose package is no longer locked is moved by a respawn, never by declaring the package again
    // (the workspace stopped declaring it on purpose); a soul (no home) can still be pinned.
    const absent = t.home ? "spawn a new instance from a soul this workspace offers (oats souls lists them), then retire this one"
      : `declare ${p.id} in the workspace's packages:, then oats sync`;
    return item(subject, "fail", { producer: "workspace lock", evidence,
      reason: shipped.length ? `the version of ${p.id} locked in this workspace does not ship the soul ${p.soul}` : `${p.id} is not locked in this workspace's packages:`,
      remedy: shipped.length ? `pin a release of ${p.id} that ships ${p.soul} in the workspace's packages:, then oats sync` : absent });
  }
  const integrity = (reason, remedy) => item(subject, "fail", { producer: "workspace lock", code: "E_PACKAGE_INTEGRITY", reason, evidence, remedy });
  const lockRemedy = "oats sync (a lock that was edited: remove the entry and sync again)";
  const copy = t.soul.copyError;
  if (copy?.code === "E_PACKAGE_INTEGRITY") return integrity(copy.message, lockRemedy);
  const dir = t.soul.soulDir;
  if (!dir) return item(subject, "unknown", { producer: "workspace lock", reason: "the soul's copy is not available, so its integrity cannot be checked", evidence });
  const expected = t.home ? "recorded" : "locked";
  let digests;
  try { digests = soulCopyDigests(dir); }
  catch (e) { return integrity(`the soul's copy at ${dir} cannot be digested: ${e.message}`, `move ${dir} aside, then spawn again (a fresh copy is fetched and verified)`); }
  if (!digests.includes(p.integrity)) {
    return integrity(`the soul's copy at ${dir} digests ${digests.at(-1)}, not the ${expected} ${p.integrity}${t.home ? "" : " (the lock's)"}`,
      t.home ? `the copy changed after its spawn, and a spawn reuses it: move ${dir} aside, then spawn a new instance of ${p.id}/${p.soul} (a fresh copy is fetched and verified against the lock)` : `move ${dir} aside, then spawn again (a fresh copy is fetched and verified against the lock); if the lock was edited: ${lockRemedy}`);
  }
  if (t.home && live.commit === p.commit && live.digest !== p.integrity) {
    return integrity(`the lock records ${live.digest} for the same commit ${String(p.commit).slice(0, 12)}; this home recorded ${p.integrity} at its spawn`, lockRemedy);
  }
  return item(subject, "pass", { producer: "workspace lock", evidence });
}

/** The total time the providers check may take in one readiness read. */
export const PROVIDER_CHECK_BUDGET_MS = 60_000;

/** `oats readiness --json` on the workspace model. */
export async function readinessDocument(t, { selector = null, remoteOptions, catalog = null, budgetMs = PROVIDER_CHECK_BUDGET_MS } = {}) {
  const installed = [], configured = [], member = [], providers = [];
  const cap = (id) => ({ capability: { id } });
  if (t.resolutionError && !isTeamRefusal(t.resolutionError)) {
    installed.push(item(t.soul.name, "fail", { producer: "workspace resolution", code: t.resolutionError.code, reason: t.resolutionError.message, evidence: t.resolutionError.details, remedy: "oats sync (the lock must provide every package capability the soul resolves)" }));
  }
  if (t.soul.copyError) {
    installed.push(item(`soul ${t.soul.name}`, "fail", { producer: "soul copy", code: t.soul.copyError.code, reason: `the soul could not be copied into ${join(t.agentsRoot, "…", "souls")}: ${t.soul.copyError.message}`,
      evidence: { repoKey: t.soul.repoKey, commit: t.soul.commit }, remedy: "check access to the soul's repository at the locked commit (oats sync), then retry" }));
  }
  for (const mod of t.modules) {
    const present = t.home ? existsSync(join(mod.dir, "oats.json")) && !!mod.manifest : !!mod.manifest;
    installed.push(item(mod.name, present ? "pass" : "fail", { producer: t.home ? "instance modules" : "workspace resolution", evidence: { from: mod.from },
      reason: present ? null : "the module copy is missing from the home", remedy: present ? null : "spawn a new instance of this soul", ...cap(mod.name) }));
    for (const req of manifestRequires(mod.manifest)) {
      const found = onPath(req.command);
      configured.push(item(`${mod.name} requires ${req.command}`, found ? "pass" : "fail", { producer: "capability manifest", reason: found ? null : req.why || "required command not on PATH",
        evidence: { command: req.command }, remedy: found ? null : req.install, ...cap(mod.name) }));
    }
  }
  configured.push(...teamItems(t), ...launchItems(t), ...folderTrustItems(t), ...launchPromptItems(t), ...await operatorItems(t, { remoteOptions }));
  // member — the soul's member repository is a confirmed member of the workspace
  // (oats-membership.yaml backlink observed over the remotes); a package soul's is its
  // package instead (packageSoulItem).
  const d = t.discovery;
  if (t.soul.package) member.push(packageSoulItem(t, d));
  else if (t.soul.external) member.push(item(`soul ${t.soul.name}`, "not-applicable", { required: false, producer: "workspace discovery", reason: "an external soul is declared by the workspace; it has no member repository", evidence: { repoKey: t.soul.repoKey } }));
  else if (!d) member.push(item(`member ${t.soul.repoKey ?? "?"}`, "unknown", { producer: "workspace discovery", reason: t.discoveryError ? `the workspace could not be read: ${t.discoveryError.message}` : "no workspace observation", evidence: { repoKey: t.soul.repoKey } }));
  // A standalone view is an allowed mode (decision 10): membership cannot be confirmed
  // there by definition, so it is not a readiness requirement (as for an external soul).
  else if (d.standalone === true) member.push(item(`member ${t.soul.repoKey}`, "not-applicable", { required: false, producer: "workspace discovery", reason: `standalone view (${d.standaloneReason ?? "explicit"}): the workspace this repository declares is not read, so its membership is declared, not confirmed`, evidence: { repoKey: t.soul.repoKey, workspace: d.key, standaloneReason: d.standaloneReason ?? null } }));
  else {
    const row = (d.members || []).find((x) => sameRepo(x.key, t.soul.repoKey));
    member.push(item(`member ${t.soul.repoKey}`, row?.confirmed ? "pass" : "fail", { producer: "workspace discovery",
      reason: row?.confirmed ? null : row ? `not confirmed: ${row.reason ?? "unconfirmed"}${row.detail ? ` (${row.detail})` : ""}` : "not a member of the workspace",
      evidence: { repoKey: t.soul.repoKey, workspace: d.key, commit: row?.commit ?? null },
      remedy: row?.confirmed ? null : "the member repository must carry oats-membership.yaml naming this workspace, and the workspace must list it in members:" }));
  }
  // providers — each bound provider's own binding check, verbatim, within one total budget.
  const deadline = Date.now() + budgetMs;
  for (const mod of t.modules) {
    if (!obj(mod.manifest?.binding)) continue;
    let dir = t.home ? mod.dir : null, pre = null;
    if (Date.now() >= deadline) pre = { code: "time-budget-exhausted", message: `time budget exhausted: the providers check stops after ${Math.round(budgetMs / 1000)} s per readiness read` };
    if (!pre && !dir && mod.module && t.lock) { try { dir = await ensureModuleTree(t.deployment, mod.module, t.lock, { catalog, remoteOptions }); } catch (e) { pre = { code: e.code || "provider-unavailable", message: e.message }; } }
    if (!dir && !pre && mod.module?.from?.kind === "member") pre = { code: "resource-not-found", message: `${mod.name}: a member module runs from a spawned home; inspect an instance (--home) for its check` };
    const out = pre ? { outcome: "unknown", problems: [pre] } : runProviderCheck(t, mod, dir, { timeoutMs: Math.min(30_000, deadline - Date.now()) });
    if (out.outcome === "result") {
      const status = PROVIDER_STATUS_ITEM[out.result.status];
      providers.push(item(mod.name, status, { producer: "provider binding check", result: out.result,
        reason: status === "pass" ? null : out.result.problems[0]?.message ?? `the provider reports ${out.result.status}`, ...cap(mod.name) }));
    }
    else providers.push(item(mod.name, "unknown", { producer: "provider binding check", result: null, problems: out.problems, reason: out.problems[0]?.message ?? null, ...cap(mod.name) }));
  }
  const checks = { installed: { status: roll(installed), items: installed }, configured: { status: roll(configured), items: configured }, member: { status: roll(member), items: member }, providers: { status: roll(providers), items: providers } };
  const requiredStatuses = Object.values(checks).flatMap((c) => c.items.filter((i) => i.required).map((i) => i.status));
  const byCapability = [...new Set(Object.values(checks).flatMap((c) => c.items.map((i) => i.capability?.id).filter(Boolean)))].sort().map((id) => {
    const of = (name) => checks[name].items.filter((i) => i.capability?.id === id);
    const statuses = Object.keys(checks).flatMap((name) => of(name).filter((i) => i.required).map((i) => i.status));
    return { capability: { id }, checks: Object.fromEntries(Object.keys(checks).map((name) => [name, of(name).length ? roll(of(name)) : "not-applicable"])),
      ownReady: statuses.length > 0 && statuses.every((s) => s === "pass" || s === "not-applicable") };
  });
  const subjectBlockers = Object.entries(checks).flatMap(([name, c]) => c.items.filter((i) => i.required && !i.capability && i.status !== "pass" && i.status !== "not-applicable").map((i) => ({ check: name, subject: i.subject, status: i.status })));
  for (const g of byCapability) g.ready = g.ownReady && subjectBlockers.length === 0;
  return { readinessApi: READINESS_API, subject: t.subject, selector, at: new Date().toISOString(), checks,
    summary: { ready: requiredStatuses.length > 0 && requiredStatuses.every((s) => s === "pass" || s === "not-applicable"), required: requiredStatuses.length,
      pass: requiredStatuses.filter((s) => s === "pass").length, fail: requiredStatuses.filter((s) => s === "fail").length, unknown: requiredStatuses.filter((s) => s === "unknown").length, byCapability, subjectBlockers },
    notes: ["ready means every REQUIRED check passes; it is never inferred from an empty set",
      "member is the soul's member repository confirmed in the workspace (oats-membership.yaml), never login or team registration",
      "providers relays each provider's own binding check verbatim; the spawn's fail-closed hooks are unchanged"],
    warnings: targetWarnings(t) };
}

/** Enforced policy for an instance (from its recorded metadata) or a soul
 *  (its declaration + default), with origins. Advisory/unknown stays unknown. */
export function policyOf({ instanceMeta = null, soul = null } = {}) {
  const child = instanceMeta?.policy?.childSpawns
    ? { allowed: instanceMeta.policy.childSpawns.allowed === true, enforced: true, origin: instanceMeta.policy.childSpawns.origin ?? { kind: "recorded" } }
    : instanceMeta ? { allowed: true, enforced: true, origin: { kind: "default", detail: "no recorded policy: children allowed (pre-0.24.8 instance)" } }
    : soul?.declarations?.children && typeof soul.declarations.children.spawn === "boolean"
      ? { allowed: soul.declarations.children.spawn, enforced: false, origin: { kind: "soul", detail: "children.spawn in soul.yaml; enforced once an instance records it" } }
      : { allowed: true, enforced: false, origin: { kind: "default", detail: "no declaration: children allowed" } };
  const worktree = instanceMeta ? { allowed: instanceMeta.work === "worktree" || instanceMeta.work === "checkout", mode: instanceMeta.work ?? null, enforced: true, origin: { kind: "work-mode", detail: `work: ${instanceMeta.work}` } }
    : soul ? { allowed: ["worktree", "checkout"].includes(soul.work), mode: soul.work ?? null, enforced: false, origin: { kind: "soul", detail: `work: ${soul.work}` } } : { allowed: null, mode: null, enforced: false, origin: { kind: "unknown" } };
  return { policy: { childSpawns: child, worktrees: worktree } };
}
/** The soul facts `policyOf` reads (children.spawn, work). */
export const policySoul = (t) => ({ declarations: declarationsOf(t.soul.definition), work: obj(t.soul.definition) ? t.soul.definition.work : undefined });
/** The provider module filling `layer` for a target, with its directory (fetched
 *  into the deployment's module store for a soul). */
export async function layerProvider(t, layer, { catalog = null, remoteOptions } = {}) {
  const name = t.slots[layer];
  const mod = name ? t.modules.find((x) => x.name === name) : null;
  if (!mod?.manifest) return null;
  let dir = mod.dir;
  if (!dir && mod.module && t.lock) dir = await ensureModuleTree(t.deployment, mod.module, t.lock, { catalog, remoteOptions });
  return { mod, dir, settings: obj(t.payloads[name]) ? t.payloads[name] : {}, env: (cap, settings) => providerEnv(t, cap, settings), executable: (script) => (dir ? moduleExecutable(dir, script) : null) };
}
export { missingRequires as manifestMissingRequires };
