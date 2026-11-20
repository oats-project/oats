/**
 * lib/sandbox-model.mjs — the sandbox declarations and the kernel's refusal words, pure (docs/design/2026-11-19-sandboxes.md C1, C2, C3,
 * C3b; docs/workspaces.md "Sandboxes"). No I/O and no provider: lib/workspace.mjs validates the files with
 * it, lib/teams.mjs keeps `"any"` off a sandboxed team, and lib/sandboxes.mjs places souls with it.
 *
 * A sandbox is the boundary of one team (v1: at most one sandbox per team). Every comparison between teams
 * is by the team's provider id, or by its label while the shared team has no id yet (declared, not
 * created), so two labels of one id are one team (C2.4).
 *
 * Problems are `{ path, reason, message }`, as the schema validator's, so a file's refusal is one
 * E_WORKSPACE_SCHEMA naming each with its reason.
 */

import { oatsError } from "./errors.mjs";

/**
 * Every reason string the kernel's sandbox refusals carry, one table (D-S1-2, decided by both sides): a
 * change is one line here. The provider's own reasons (C10's `not-a-file`, `hardlinked`, `overlap`, …)
 * are the provider's and never made by the kernel.
 */
export const SANDBOX_REASONS = Object.freeze({
  notListed: "not-listed", // E_SANDBOX_NOT_HERE: this host does not list the soul's sandbox
  notRunning: "not-running", // E_SANDBOX_NOT_HERE: listed, but its provider does not answer it ready
  spawnFromHost: "spawn-from-host", // E_SANDBOX_PLACEMENT: a spawn inside a sandbox without a host-delivered seat
  notPlacedHere: "not-placed-here", // E_SANDBOX_PLACEMENT: a soul placed elsewhere, inside a sandbox
  noSource: "no-source", // E_SANDBOX_CREDENTIAL: a declared credential with no entry in credentials:
  missing: "missing", // E_SANDBOX_CREDENTIAL: its fromFile names no file
  hostSpawn: "host-spawn", // E_SANDBOX_HOST_AGENT: a host-placed spawn
  hostSession: "host-session", // E_SANDBOX_HOST_AGENT: a start, restart or resume of a host home
  hostHomeRunning: "host-home-running", // E_SANDBOX_HOST_AGENT: a sandbox start while a host home runs
  hostHomeUnreadable: "host-home-unreadable", // E_SANDBOX_HOST_AGENT: … or cannot be read
  providerNone: "none", // E_SANDBOX_PROVIDER: no composed capability declares the sandbox hook
  providerAmbiguous: "ambiguous", // E_SANDBOX_PROVIDER: more than one does
  hookFailed: "hook-failed", // E_SANDBOX_PROVIDER: an answer that is not one valid answer
  teamNotCreated: "team-not-created", // E_SANDBOX_TEAM: the sandbox's team has no provider id yet
  sandboxUnknown: "sandbox-unknown", // E_WORKSPACE_SCHEMA: an act for a sandbox the workspace does not declare
  // The provider's `status` problem reasons that readiness reports as items of their own (C10; D-S1-3,
  // decided): readiness item `sandbox-<reason>`, never a failure.
  sshIncludeMissing: "ssh-include-missing",
  stateOrphaned: "state-orphaned",
  // E_SANDBOX_PLACEMENT on the host: a caller-bound apply (its own --expect-decision or --idempotency-key)
  // of a spawn placed in a sandbox (D-S1-4; held: the lead decides the string).
  callerBound: "caller-bound",
});
/** The host-agent remedy (C10, "Why E_SANDBOX_HOST_AGENT"). */
export const HOST_AGENT_REMEDY = "a deployment that lists a sandbox runs every agent inside one: run agents that belong on the host from another deployment, under another OS user, or remove sandboxes: from this deployment's oats-local.yaml";

/** E_SANDBOX_HOST_AGENT (C10): `reason` one of SANDBOX_REASONS' host-* words; `said` what was refused. */
export function hostAgentRefusal(reason, said, details = {}) {
  const e = oatsError("E_SANDBOX_HOST_AGENT", `${said}: this deployment lists a sandbox (oats-local.yaml sandboxes:), so it runs no agent on the host; nothing was done — ${HOST_AGENT_REMEDY}`, { reason, remedy: HOST_AGENT_REMEDY, ...details });
  e.details = { reason, remedy: HOST_AGENT_REMEDY, ...details };
  return e;
}
/** Whether a deployment's oats-local.yaml lists a sandbox (C3): it then runs no agent on the host (C10).
 *  A deployment inside a sandbox (`sandbox: {self}`) lists none. */
export function listsSandbox(local) {
  return Array.isArray(local?.sandboxes) && local.sandboxes.length > 0 && !(local.sandbox !== null && typeof local.sandbox === "object");
}
/** C1: a sandbox's name. Kept equal to `$defs.sandboxName` in docs/oats-workspace.schema.json and
 *  docs/oats-local.schema.json. */
export const SANDBOX_NAME_RE = /^[a-z0-9]$|^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
/** C1: the external egress roles a sandbox may add to the base routes, a closed set. `forge` is
 *  behind its own feature (SANDBOX_EGRESS_FORGE_FEATURE). */
export const SANDBOX_EGRESS_ROLES = Object.freeze(["model", "source", "forge"]);
/** `oats version --json` features: `sandboxes:` (C1, C3, C3b, C4, C5) and C1's `forge` role. */
export const SANDBOXES_FEATURE = "sandboxes";
export const SANDBOX_EGRESS_FORGE_FEATURE = "sandbox-egress-forge";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);
const show = (v) => JSON.stringify(v);
const pointerKey = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

/** The workspace's sandboxes as written: [[name, entry]] for each well-formed entry. */
export function declaredSandboxes(workspace) {
  return isObject(workspace?.sandboxes) ? Object.entries(workspace.sandboxes).filter(([, e]) => isObject(e)) : [];
}
/** A shared team's identity for every comparison: its provider id, or its label while it has none. */
export function sharedTeamKey(workspace, label) {
  const id = str(isObject(workspace?.teams) ? workspace.teams[label]?.team : null);
  return id !== null ? `id:${id}` : `label:${label}`;
}

/**
 * The sandboxed teams of a workspace → Map(team key → { sandbox, label, id }) (the first sandbox to name a
 * team keeps it; a second is sandbox-team-taken). Only entries naming a string team are read.
 */
export function sandboxedTeams(workspace) {
  const out = new Map();
  for (const [name, entry] of declaredSandboxes(workspace)) {
    if (typeof entry.team !== "string") continue;
    const key = sharedTeamKey(workspace, entry.team);
    if (!out.has(key)) out.set(key, { sandbox: name, label: entry.team, id: str(workspace?.teams?.[entry.team]?.team) });
  }
  return out;
}
/** Whether the shared label `label` is a sandboxed team (by id, or by label while it has none). */
export function isSandboxedLabel(workspace, label, sandboxed = sandboxedTeams(workspace)) {
  return typeof label === "string" && sandboxed.has(sharedTeamKey(workspace, label));
}

const duplicates = (list, path, problems, what) => {
  const seen = new Map();
  list.forEach((item, i) => {
    if (typeof item !== "string") return;
    if (seen.has(item)) problems.push({ path: `${path}/${i}`, reason: "duplicate-entry", message: `${show(item)} is listed twice in ${what} (first at ${seen.get(item)}): each entry once` });
    else seen.set(item, i);
  });
};

/** The workspace file's sandbox rules beyond its schema (C1, C2). */
export function workspaceSandboxProblems(workspace) {
  const problems = [];
  if (!isObject(workspace)) return problems;
  const shared = new Set(isObject(workspace.teams) ? Object.keys(workspace.teams) : []);
  const taken = new Map();
  for (const [name, entry] of declaredSandboxes(workspace)) {
    const at = `/sandboxes/${pointerKey(name)}`;
    if (typeof entry.team === "string") {
      if (!shared.has(entry.team)) problems.push({ path: `${at}/team`, message: `${show(entry.team)} is not a shared team: declare it in teams: of this file` });
      else {
        const key = sharedTeamKey(workspace, entry.team);
        if (taken.has(key)) {
          const [other, otherLabel] = taken.get(key);
          problems.push({ path: `${at}/team`, reason: "sandbox-team-taken", message: `sandbox ${name} names team ${entry.team}, which sandbox ${other} already names${otherLabel !== entry.team ? ` as ${otherLabel} (one provider id)` : ""}: a team has at most one sandbox` });
        } else taken.set(key, [name, entry.team]);
      }
    }
    if (Array.isArray(entry.egress)) duplicates(entry.egress, `${at}/egress`, problems, `sandbox ${name}'s egress`);
    if (Array.isArray(entry.credentials)) duplicates(entry.credentials, `${at}/credentials`, problems, `sandbox ${name}'s credentials`);
  }
  const sandboxed = sandboxedTeams(workspace);
  if (!sandboxed.size) return problems;
  const owner = (label) => sandboxed.get(sharedTeamKey(workspace, label))?.sandbox;
  // C2.4: a sandboxed team's provider id is named by exactly one shared label.
  for (const { label, id, sandbox } of sandboxed.values()) {
    if (id === null) continue;
    for (const other of shared) {
      if (other === label || str(workspace.teams[other]?.team) !== id) continue;
      problems.push({ path: `/teams/${pointerKey(other)}`, reason: "sandboxed-team-alias", message: `shared team ${other} names provider id ${id}, the team of sandbox ${sandbox} (label ${label}): a sandboxed team's id is named by one shared label only` });
    }
  }
  // C2.2: never through the default or a wildcard.
  if (isSandboxedLabel(workspace, workspace.defaultTeam, sandboxed)) {
    problems.push({ path: "/defaultTeam", reason: "sandboxed-team-by-wildcard", message: `defaultTeam ${workspace.defaultTeam} is the team of sandbox ${owner(workspace.defaultTeam)}: a sandboxed team is reached only through a named soul in souls: (<member>/<soul>)` });
  }
  if (isObject(workspace.souls)) for (const [key, entry] of Object.entries(workspace.souls)) {
    if (!isObject(entry)) continue;
    const at = `/souls/${pointerKey(key)}`;
    if ((key === "*" || key.endsWith("/*")) && isSandboxedLabel(workspace, entry.default, sandboxed)) {
      problems.push({ path: `${at}/default`, reason: "sandboxed-team-by-wildcard", message: `souls: ${key} gives default ${entry.default}, the team of sandbox ${owner(entry.default)}: a sandboxed team is reached only through a named soul (<member>/<soul>), never a pattern` });
    }
    // C2.1: a sandboxed team is a soul's default, never one of its other teams.
    if (Array.isArray(entry.teams)) entry.teams.forEach((label, i) => {
      if (isSandboxedLabel(workspace, label, sandboxed)) problems.push({ path: `${at}/teams/${i}`, reason: "sandboxed-team-not-default", message: `souls: ${key} lists ${label}, the team of sandbox ${owner(label)}, as another team: a sandboxed team is only ever a soul's default` });
    });
  }
  return problems;
}

/** The local file's sandbox rules that need no workspace (C3, C3b). */
export function localSandboxProblems(local) {
  const problems = [];
  if (!isObject(local)) return problems;
  if (Array.isArray(local.sandboxes)) {
    duplicates(local.sandboxes, "/sandboxes", problems, "sandboxes");
    if (local.sandboxes.length && !(isObject(local.host) && typeof local.host.name === "string")) {
      problems.push({ path: "/sandboxes", reason: "sandbox-host-name-required", message: "this file lists sandboxes but names no host: set host: { name: <machine> } (a schedule's runsOn names it)" });
    }
  }
  if (isObject(local.sandbox)) {
    for (const key of ["sandboxes", "credentials", "teams", "defaultTeam"]) {
      if (Object.hasOwn(local, key)) problems.push({ path: `/${key}`, reason: "sandbox-self-conflict", message: `sandbox: { self } marks this as a deployment inside sandbox ${local.sandbox.self}, which takes no ${key}: ${SELF_CONFLICT[key]}` });
    }
  }
  return problems;
}
const SELF_CONFLICT = {
  sandboxes: "a sandbox runs no sandboxes",
  credentials: "credentials reach a sandbox as mounts only",
  teams: "its teams are the workspace's",
  defaultTeam: "its souls' default team is the workspace's",
};

/**
 * The rules between the two files (C2.3, C3, C3b): every sandbox the local file names is declared in the
 * workspace, and a local team never reuses a sandboxed team's label or provider id. `workspace` null (the
 * standalone view) declares no sandbox.
 */
export function crossSandboxProblems(workspace, local) {
  const problems = [];
  if (!isObject(local)) return problems;
  const declared = new Set(declaredSandboxes(workspace).map(([name]) => name));
  const unknown = (name, path) => problems.push({ path, reason: "sandbox-unknown", message: `sandbox ${show(name)} is not declared in oats-workspace.yaml sandboxes:${workspace ? "" : " (this deployment has no workspace file)"}: declare it there, or remove it from this file (a sandbox removed from the workspace is stopped by the next \`oats sync\` once it is delisted here)` });
  if (Array.isArray(local.sandboxes)) local.sandboxes.forEach((name, i) => { if (typeof name === "string" && !declared.has(name)) unknown(name, `/sandboxes/${i}`); });
  if (isObject(local.sandbox) && typeof local.sandbox.self === "string" && !declared.has(local.sandbox.self)) unknown(local.sandbox.self, "/sandbox/self");
  const sandboxed = sandboxedTeams(workspace);
  if (!sandboxed.size) return problems;
  const labels = new Map([...sandboxed.values()].map((s) => [s.label, s]));
  const ids = new Map([...sandboxed.values()].filter((s) => s.id !== null).map((s) => [s.id, s]));
  if (isObject(local.teams)) for (const [label, def] of Object.entries(local.teams)) {
    const hit = labels.get(label) ?? (typeof def?.team === "string" ? ids.get(def.team) : undefined);
    if (hit) problems.push({ path: `/teams/${pointerKey(label)}`, reason: "sandboxed-team-local", message: `local team ${label}${labels.has(label) ? "" : ` (provider id ${def.team})`} reuses the team of sandbox ${hit.sandbox} (${hit.label}): a sandboxed team is declared once, in oats-workspace.yaml` });
  }
  // A local default naming a sandboxed team, by its shared label or by its provider id under a local label,
  // would place every soul without a souls: default in that sandbox: the default route C2.2 closes in the
  // workspace file, closed here too.
  const d = local.defaultTeam;
  if (typeof d === "string") {
    const localId = isObject(local.teams) && typeof local.teams[d]?.team === "string" ? local.teams[d].team : null;
    const hit = isSandboxedLabel(workspace, d, sandboxed) ? sandboxed.get(sharedTeamKey(workspace, d)) : localId !== null ? ids.get(localId) : undefined;
    if (hit) problems.push({ path: "/defaultTeam", reason: "sandboxed-team-local", message: `defaultTeam ${d}${hit.label === d ? "" : ` (provider id ${hit.id})`} is the team of sandbox ${hit.sandbox}: a sandboxed team is reached only through a named soul in oats-workspace.yaml souls:` });
  }
  return problems;
}

/**
 * Where a soul runs (the record, Placement): the sandbox whose team is the soul's resolved default team,
 * by provider id, or by label while the shared team has none. `defaultTeam` is a resolution's
 * `{ label, team }` (lib/teams.mjs DefaultTeam) or null. → the sandbox's name, or null (the host).
 */
export function placementOf(workspace, defaultTeam) {
  if (!isObject(defaultTeam) || typeof defaultTeam.label !== "string") return null;
  for (const { sandbox, label, id } of sandboxedTeams(workspace).values()) {
    if (id !== null ? defaultTeam.team === id : defaultTeam.label === label && str(defaultTeam.team) === null) return sandbox;
  }
  return null;
}
