/** The environment a capability's code runs with in an instance home (docs/capabilities.md, Commands
 *  and hooks): one builder for every lifecycle hook and for a session provider's commands
 *  (lib/session-providers.mjs), with the soul, team and kernel facts it is built from. A leaf: the
 *  hot reads (lib/hot-reads.mjs: `session inspect`, `status`) call a session provider without
 *  loading core.mjs, which imports these and re-exports what it exported. */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { kernelNode } from "./stable-node.mjs";
import { teamsEnv } from "./teams.mjs";
import { PKG_ROOT } from "./version.mjs";

/** The canonical path of this kernel's CLI: what the home's shim points at, and OATS_CLI_BIN. */
export function kernelBin() { return realpathSync(join(PKG_ROOT, "bin", "oats.mjs")); }

/**
 * A soul's STABLE identity for capability hooks (OATS_SOUL_ID): what a provider
 * may key durable state on. Workspace soul: `<repo key>#<soul name>` — it does not
 * change when the member commits (the per-commit soul directory does) or when the
 * copy moves. Classic soul: the realpath of agents/<name>/soul, i.e. today's value,
 * so 0.24 deployments are unchanged. Order: an explicit `soulId` (a prepared spawn),
 * the home's recorded `instance.json.workspace.soul` (retire/launch of a workspace
 * home), else the path.
 */
export function stableSoulId({ soulId, home, soulDir, agentName } = {}) {
  if (typeof soulId === "string" && soulId) return soulId;
  if (home) {
    try {
      const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
      const s = meta?.workspace?.soul;
      if (typeof s?.id === "string" && s.id) return s.id;
      if (typeof s?.repoKey === "string" && s.repoKey) return `${s.repoKey}#${meta.agent ?? agentName ?? ""}`;
    } catch { /* not a workspace home */ }
  }
  if (soulDir) { try { return realpathSync(soulDir); } catch { return soulDir; } }
  return "";
}
/** The soul directory an instance incarnates, as spawn recorded it (instance.json
 *  `soulDir`): a workspace soul's per-commit copy (agents/<soul>/souls/<commit12>) or
 *  the read-only soul inside a capability package. It is what every classic
 *  lifecycle hook and dispatched command sees as OATS_SOUL (captured hooks set
 *  none); instance homes carry no soul link. */
export function instanceSoulDir(home, meta = undefined) {
  if (meta === undefined && home) { try { meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8")); } catch { meta = null; } }
  return typeof meta?.soulDir === "string" && isAbsolute(meta.soulDir) ? meta.soulDir : undefined;
}

/** The team and workspace facts a lifecycle hook, command or provider check receives (workspace
 * model only, lead decision c3-7): OATS_TEAM_SCOPE is the deployment directory; OATS_WORKSPACE_NAME /
 * _KEY the workspace's name and canonical key; OATS_TEAM_NAME (the 0.25 `team:` block's name) is always
 * empty, so an ambient value never reaches a hook.
 *
 * Team model v2 (docs/desktop-cli-api.md, The provider environment): `resolved.teams` are the soul's
 * TeamRows here and `resolved.defaultTeam` its DefaultTeam; teamsEnv sets OATS_DEFAULT_TEAM(_ID,_FROM),
 * OATS_TEAMS (mapped rows only) and OATS_TEAMS_SOURCE (`live`: the workspace + oats-local.yaml read now,
 * or a fresh resolution; `recorded`: the spawn-time record). A provider LEAVES a joined team only on a
 * `live` list. Teams not known (`resolved.teams` not an array): every team name unset. */
export function teamEnv(resolved) {
  const ws = resolved?.workspace && typeof resolved.workspace === "object" ? resolved.workspace : {};
  const known = Array.isArray(resolved?.teams);
  return {
    OATS_TEAM_NAME: "", OATS_TEAM_SCOPE: typeof ws.deployment === "string" ? ws.deployment : "",
    ...teamsEnv(known ? { teams: resolved.teams, defaultTeam: resolved.defaultTeam ?? null, source: resolved.teamsSource } : null),
    OATS_WORKSPACE_NAME: typeof ws.name === "string" ? ws.name : "", OATS_WORKSPACE_KEY: typeof ws.key === "string" ? ws.key : "",
  };
}
export function withoutAmbientHookFacts(env) {
  const { OATS_LAUNCH_PREVIEW: _ambient, OATS_HARNESS_EXECUTABLE: _inherited, OATS_SPAWNER_HOME: _spawner, ...rest } = env;
  return rest;
}
/** The environment one capability's lifecycle hook runs with: the invoker's own
 *  (inherited, as for every hook; the kernel adds no credentials), plus the
 *  standard OATS_* variables (docs/capabilities.md, Commands and hooks) and the
 *  caller's `extraEnv`. One builder for every event, so the `worktree` runner
 *  (lib/worktree-hooks.mjs) hands its hooks exactly what every other hook gets. */
export function lifecycleHookEnv(event, cap, { home, instance, agentName, soulDir, soulId, contextDir, workspaceDir, rootDir, resolved, priorMeta = {}, extraEnv = {} }) {
  return {
    // OATS_LAUNCH_PREVIEW is the kernel's to give (prepareLaunchHooks), never
    // inherited: a real start's hook must not read an ambient one as a preview.
    // Nor are OATS_HARNESS_EXECUTABLE and OATS_SPAWNER_HOME (spawn's
    // callerSpawner): a hook started from inside an instance must not read its caller's.
    ...withoutAmbientHookFacts(process.env),
    // OATS_INSTANCE_HOME is the runtime-neutral contract name for the
    // instance home (absolute). OATS_HOME predates it and stays as a
    // compatibility alias: shipped capability hooks read it
    // (the official oats.aweb and oats.okf packages) and are versioned
    // independently of this kernel. Neither is OATS_HOME_DIR, which is
    // the package STORE root — do not conflate them.
    OATS_EVENT: event, OATS_INSTANCE: instance, OATS_INSTANCE_HOME: home, OATS_HOME: home, OATS_AGENT: agentName,
    OATS_CAPABILITY: cap.id, OATS_LAYER: cap.layer || "", OATS_ROOT: rootDir || "",
    OATS_SOUL: soulDir || "", OATS_SOUL_ID: stableSoulId({ soulId, home, soulDir, agentName }), OATS_CONTEXT: contextDir, OATS_WORKSPACE: workspaceDir || "", OATS_LEVEL: cap.level || "",
    ...teamEnv(resolved),
    ...extraEnv,
    // Hooks also run through direct core callers (not only bin/oats).
    // Author this from the running kernel, never PATH, ambient env or
    // a caller's extraEnv: those may point at a different executable.
    OATS_CLI_BIN: kernelBin(),
    // The node a capability writes into anything that outlives its hook (lib/stable-node.mjs).
    OATS_NODE_BIN: kernelNode().node,
    OATS_SETTINGS: JSON.stringify(cap.settings || {}),
    // Where each leaf of OATS_SETTINGS came from (JSON pointer → { kind, at }; kind is
    // manifest-default | workspace | soul | host | spawn | anchor), so a provider can tell a
    // soul-set value from a host-set one. {} when the home recorded none (spawned before 0.29).
    OATS_SETTINGS_ORIGINS: JSON.stringify(cap.settingsOrigins || {}),
    OATS_META: JSON.stringify(priorMeta[cap.id] || {}),
  };
}
