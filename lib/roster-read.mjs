/** lib/roster-read.mjs — `oats status`, the roster read (awebai/oats#1630): the deployment's agents and
 *  instances, each instance's workspace drift, and its workspace identity. One implementation behind the
 *  CLI (bin/oats.mjs status) and a process that answers it many times (lib/read-call.mjs, whose header
 *  describes the context and the answer). `statusAnswer(ctx)` is the `--json` answer, a bare document
 *  (never an envelope) or a failure envelope; `statusView(ctx)` the data bin's text renderer reads. A
 *  leaf a hot read loads (lib/hot-reads.mjs): never core.mjs. Kernel-private, not exported from `./core`. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureRoot } from "./agents-root.mjs";
import { legacyCapturedHomes, legacyLocalAgents, listInstances } from "./instance-listing.mjs";
import { KERNEL_FEATURES } from "./kernel-features.mjs";
import { readLockIfPresent } from "./packages.mjs";
import { answerWarnings, refuse, runRead } from "./read-call.mjs";
import { lastObservedCommit, parseRepoRef, peekAtCommit } from "./remote.mjs";
import { readSessionViewer } from "./session-viewer.mjs";
import { teamModel } from "./teams.mjs";
import { loadLocal, memberRowByKey } from "./workspace.mjs";

/** `oats status --json`: → `{ exit, answer, stderr }` (lib/read-call.mjs). `ctx.team`: `--team` was given. */
export function statusAnswer(ctx) {
  return runRead(ctx, async (call) => ({ answer: statusDocument(call, await statusFacts(call, ctx)) }));
}

/** `oats status` in text mode: → `{ exit, answer, view, stderr }`, `view` `{ root, agents, ws, problems }`
 *  (`ws`: statusDrift's answer) when it did not refuse, `answer` the failure envelope when it did. */
export function statusView(ctx) {
  return runRead(ctx, async (call) => ({ view: await statusFacts(call, ctx) }));
}

/** The problems doctor and status share for a v2 deployment: what OATS 0.25 left
 *  under local-agents/ (named, never read), and the captured homes under the agents root
 *  (`records`: legacyCapturedHomes'). */
export function legacyLayoutProblems(root, { records } = {}) {
  return [legacyLocalAgents(root), legacyCapturedHomes(root, { records })].filter(Boolean);
}

async function statusFacts(call, { dir, team = false }) {
  if (team) refuse("E_BAD_ARGS", "status --team was removed with the classic team scope: `oats status` in the deployment lists every instance, and `oats workspace status` shows the members");
  let root;
  try { root = ensureRoot(dir); }
  catch (e) { if (e?.code === "E_NO_DEPLOYMENT") refuse("E_NO_DEPLOYMENT", e.message, e.details ?? e.provenance); throw e; }
  // Each home's instance.json, as the listing read it: parsed once for the whole read.
  const records = new Map();
  const data = listInstances(root, undefined, undefined, { records });
  const ws = await statusDrift(data, call, dir);
  const problems = legacyLayoutProblems(root, { records });
  return { root, agents: data, ws, problems };
}

function statusDocument(call, { root, agents: data, ws, problems }) {
  // The soul key (feature launch-preference): what souls.launch and `oats soul teams <key>` use —
  // from the instances' records, so it needs no remote.
  for (const a of data) a.key = agentSoulKey(a);
  if (ws) for (const a of data) {
    const stamp = ws.souls.get(a.name);
    if (stamp) a.soulSource = { repoKey: stamp.repoKey, commit: stamp.commit, path: stamp.path, ...(stamp.current ? { current: stamp.current, status: stamp.current === stamp.commit ? "current" : "moved" } : {}) };
    for (const i of a.instances || []) {
      const key = i.home ?? `${a.name}/${i.instance}`;
      const rows = ws.drift.get(key);
      if (rows) i.modules = rows.map((r) => ({ name: r.module, from: r.from, commit: r.recorded?.commit ?? null, current: r.current, status: r.status, ...(r.reason ? { reason: r.reason } : {}) }));
      const s = ws.soul.get(key);
      if (s) i.soul = { repoKey: s.repoKey, commit: s.commit, current: s.current?.commit ?? null, status: s.status, ...(s.reason ? { reason: s.reason } : {}), ...(s.package ? { package: s.package, version: s.version, currentVersion: s.current?.version ?? null } : {}) };
    }
  }
  const observation = call.maxAge === null ? {} : { observation: call.observation() };
  // `features` (feature server-probe-features): this kernel's own list, as `version --json` answers
  // it, so a remote roster relays the host's without probing it. Never part of a reused observation.
  return { root, agents: data, ...observation, features: KERNEL_FEATURES, sessionViewer: readSessionViewer(), ...(ws ? { workspace: { ...(ws.unreachable ? { reachable: false, ...ws.unreachable } : { reachable: true }), ...workspaceIdentity(ws.local, ws.discovery, call.remoteOptions) } } : {}), ...(problems.length ? { problems } : {}), ...answerWarnings() };
}

/** Workspace drift for `oats status` (decision 17: shown, not prevented). ONE discovery over
 *  the remotes serves every instance; `driftOf` compares each instance's recorded modules to
 *  the members' current state (and package modules to the lock), `soulDriftOf` the instance's
 *  recorded SOUL SOURCE (instance.json.workspace.soul) to its member's current commit. Offline →
 *  { unreachable }. Returns null when the deployment is not a workspace deployment (no
 *  oats-local.yaml). `souls` maps each workspace soul NAME (agents/<name>/.oats-soul-source.json
 *  present) to its stamp — the roster's `repo:` column for a workspace soul. */
async function statusDrift(data, call, dir) {
  let ctx;
  try { ctx = loadLocal(dir); }
  catch (e) {
    if (e?.code === "E_LOCAL_MISSING") return null;
    // A 0.25 oats-config.yaml inside the deployment: the typed migration error, never a stack.
    if (e?.code === "E_CONFIG_BROKEN") refuse(e.code, e.message, e.details);
    throw e;
  }
  const hasModules = (i) => i.modules && typeof i.modules === "object" && Object.keys(i.modules).length > 0;
  const hasSoul = (i) => i.workspace && typeof i.workspace === "object" && i.workspace.soul && typeof i.workspace.soul === "object" && typeof i.workspace.soul.repoKey === "string";
  // Workspace souls of this roster: the stamp ensureWorkspaceSoul leaves beside the soul pointer.
  const souls = new Map();
  for (const a of data) {
    if (!a.dir) continue;
    try { const stamp = JSON.parse(readFileSync(join(a.dir, ".oats-soul-source.json"), "utf8")); if (stamp && typeof stamp.repoKey === "string") souls.set(a.name, { repoKey: stamp.repoKey, commit: typeof stamp.commit === "string" ? stamp.commit : null, path: stamp.path ?? null, ...(typeof stamp.package === "string" ? { package: stamp.package, version: stamp.version ?? null } : {}) }); }
    catch { /* not a workspace soul (classic, or an unreadable stamp) */ }
  }
  const anything = data.some((a) => (a.instances || []).some((i) => hasModules(i) || hasSoul(i)));
  if (!anything) return { drift: new Map(), soul: new Map(), souls, unreachable: null, local: ctx.local, discovery: null };
  const deploymentDir = dirname(ctx.path);
  let lock = null;
  try { lock = readLockIfPresent(deploymentDir); } catch { lock = null; }
  let discovery;
  // The standalone view (decisions 10/25) is a discovery too: drift of a standalone
  // instance is computed against its member's current state, not reported "unreachable".
  try { const { discoverOrStandalone } = await import("./member-clone.mjs"); discovery = await discoverOrStandalone(ctx.local, { lock, remoteOptions: call.remoteOptions() }); }
  catch (e) {
    const reason = e?.details?.reason ? `${e.code}: ${e.details.reason}` : (e?.code || e?.message || "unknown");
    return { drift: new Map(), soul: new Map(), souls, unreachable: { code: e?.code ?? null, reason, message: e?.message ?? String(e) }, local: ctx.local, discovery: null };
  }
  const { driftOf, soulDriftOf } = await import("./drift.mjs");
  const drift = new Map();
  const soul = new Map();
  for (const a of data) for (const i of a.instances || []) {
    const key = i.home ?? `${a.name}/${i.instance}`;
    if (hasModules(i)) { try { drift.set(key, driftOf(i, discovery, { lock })); } catch { /* an unreadable module record shows as no drift rows */ } }
    if (hasSoul(i)) { try { const row = soulDriftOf(i, discovery); if (row) soul.set(key, row); } catch { /* an unreadable soul record shows as no soul row */ } }
  }
  // The roster's soul row reflects the CURRENT member commit too (the pointer may lag a moved member).
  // First match per key, as `find` gave, from indexes built once (not a scan per agent).
  const packageSoulAt = new Map();
  for (const p of discovery.packageSouls || []) { const k = `${p.package}\0${p.path}`; if (!packageSoulAt.has(k)) packageSoulAt.set(k, p); }
  for (const [, stamp] of souls) {
    if (typeof stamp.package === "string") { const now = packageSoulAt.get(`${stamp.package}\0${stamp.path}`); if (now) stamp.current = now.commit; continue; }
    const member = memberRowByKey(discovery.members, stamp.repoKey);
    if (member && typeof member.commit === "string" && (member.confirmed || (discovery.standalone === true && member.key === discovery.key))) stamp.current = member.commit;
  }
  return { drift, soul, souls, unreachable: null, local: ctx.local, discovery };
}
/** The deployment's workspace identity in `oats status --json` (feature workspace-identity), read
 *  OFFLINE. `key` is the workspace HOST's canonical repo key (parseRepoRef(...).key) and `ref` the
 *  reference as oats-local.yaml writes it. The host is the one this run observed, else the one this
 *  machine's parsed cache knows: `ref` itself when the cache holds its workspace file, or the host its
 *  cached oats-membership.yaml names when `ref` is a member ("workspace"). A member whose host is not
 *  known keys as itself ("member"); a ref nothing is known of is taken as the host, as the schema
 *  defines `workspace:` ("workspace"). The team model resolves as teamModel resolves it (the default is
 *  the local one the workspace allows, else the workspace's; a committed team wins a collision) over the shared teams of, in order, the workspace
 *  file this run observed (`teamsFrom: "observed"`), the cached file ("cache": no git process), or none
 *  ("local"). `standalone` is the CONFIGURED standalone view only (oats-local.yaml `standalone:`): it
 *  reads no workspace file, so its local teams are the whole team model. A run that fell back to the
 *  standalone view (the host unreadable) is not: its team model is the workspace's, and its
 *  discovery is the member's, never the host's key. */
function workspaceIdentity(local, discovery, remoteOptions) {
  const ref = local.workspace;
  const standalone = typeof local.standalone === "string" && local.standalone !== "";
  const observed = discovery && discovery.standalone !== true && discovery.workspace ? discovery : null;
  const cached = observed ? null : cachedWorkspace(ref, remoteOptions);
  const keyOf = (r) => { try { return parseRepoRef(r).key; } catch { return null; } };
  let key, keyFrom;
  if (observed) [key, keyFrom] = [observed.key, "workspace"];
  else if (cached && cached.host === null) [key, keyFrom] = [keyOf(ref), "member"];
  else [key, keyFrom] = [keyOf(cached?.host ?? ref), "workspace"];
  if (key === null) keyFrom = null; // a reference parseRepoRef refuses: unusable, never matched
  let shared = null, teamsFrom = "local";
  if (!standalone) {
    if (observed) [shared, teamsFrom] = [observed.workspace, "observed"];
    else if (cached?.file) [shared, teamsFrom] = [cached.file, "cache"];
  }
  const model = teamModel(shared, local);
  // A soul with no souls: default of its own lives here (team model 3: the local default the workspace allows, else the workspace's).
  const deploymentDefault = model.localDefault ?? model.workspaceDefault;
  const labels = [...model.labels.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    key, ref, keyFrom, standalone,
    defaultTeam: deploymentDefault === null ? null : { label: deploymentDefault, team: model.labels.get(deploymentDefault)?.team ?? null },
    teams: Object.fromEntries(labels.map((l) => [l, model.labels.get(l).team])),
    teamsFrom,
  };
}
/** What this machine's parsed cache knows of the workspace `ref` names (the values observeWorkspace and
 *  confirmMembership stored, each at its repo's last observed commit): { host, file } — `host` the ref
 *  of the workspace host, `file` its workspace file or null — when `ref` is the host (its workspace file
 *  is cached) or a member whose cached oats-membership.yaml names it (discoverOrStandalone follows the
 *  same backlink). A member's backlink is cached whether its own workspace slot was observed (missing)
 *  or never was (the host's discovery confirmed it). { host: null, file: null } for a ref cached as
 *  having no workspace file and no backlink; null when nothing is known. */
export function cachedWorkspace(ref, remoteOptions) {
  const options = remoteOptions();
  const cached = (r, item) => {
    const commit = lastObservedCommit(r, options);
    const value = commit ? peekAtCommit(r, commit, item, options) : undefined;
    return value && typeof value === "object" ? value : null;
  };
  const fileOf = (read) => (read && !read.missing && !read.problems && read.value && typeof read.value === "object" ? read.value : null);
  const read = cached(ref, "workspace");
  if (read && !read.missing) return { host: ref, file: fileOf(read) };
  const membership = cached(ref, "membership");
  const host = membership?.kind === "ok" && typeof membership.value?.workspace === "string" ? membership.value.workspace : null;
  if (host !== null) return { host, file: fileOf(cached(host, "workspace")) };
  return read ? { host: null, file: null } : null;
}
/** A roster agent's soul key: the qualified name of a package soul, else the recorded agent (soul) name;
 *  null when no instance records a workspace soul. Exactly soulKeyOf for the soul it was spawned from. */
function agentSoulKey(a) {
  for (const i of a.instances || []) {
    const soul = i?.workspace?.soul;
    if (!soul || typeof soul !== "object") continue;
    return soul.package && typeof soul.qualifiedName === "string" ? soul.qualifiedName : (typeof i.agent === "string" ? i.agent : a.name);
  }
  return null;
}
