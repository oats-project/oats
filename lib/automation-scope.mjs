/** scopeAutomations: the triggers and schedules a deployment declares, read with the clone each one
 *  needs, and childEnv, the environment a scheduled job runs with. A leaf (awebai/oats#1630):
 *  `oats workspace status` reads the automation scope without loading schedule.mjs and core.mjs;
 *  schedule.mjs imports both and re-exports them. */
import { loadLocal } from "./workspace.mjs";
import { resolveMemberClone } from "./member-clone.mjs";
import { automationContext } from "./automations.mjs";
import { RESERVED_LAUNCH_ENV } from "./reserved-launch-env.mjs";

/** The environment a scheduler-launched oats child runs with: the caller's
 *  frozen instance identity and capability snapshot removed (a tick or run-now
 *  may be invoked from inside an unrelated instance; dispatch belongs to the
 *  job's cwd and explicit selectors, never to that caller), host configuration
 *  such as OATS_HOME_DIR and credentials kept. Shared by command and spawn jobs. */
export function childEnv() {
  const env = { ...process.env };
  for (const key of [...RESERVED_LAUNCH_ENV,
    "OATS_DEPLOYMENT", "OATS_RESOLUTION", "OATS_CAPABILITY", "OATS_LAYER", "OATS_LEVEL", "OATS_META", "OATS_OPERATION",
    "OATS_REPO", "OATS_BRANCH", "OATS_WORK", "OATS_KIND", "OATS_TASK",
    "OATS_HARNESS", "OATS_PREVIOUS_HARNESS", "OATS_RUNTIME", "OATS_PREVIOUS_RUNTIME", "OATS_BACKEND", "OATS_PREVIOUS_BACKEND", "OATS_LAUNCH_PREVIEW", "OATS_RETIRE_INTENT",
    "OATS_TEAM_NAME", "OATS_TEAM_SCOPE", "OATS_TEAM_ID", "OATS_TEAM_LABEL", "OATS_TEAM_LABELS", "OATS_DEFAULT_TEAM", "OATS_DEFAULT_TEAM_ID", "OATS_DEFAULT_TEAM_FROM", "OATS_TEAMS", "OATS_TEAMS_SOURCE", "OATS_TRIGGER_EVENT_FILE",
    "OATS_TREE", "OATS_TREE_CLONE", "OATS_TREE_REMOTE", "OATS_TREE_MEMBER", "OATS_TREE_BASE", "OATS_TREE_BASE_OID", "OATS_PURPOSE", "OATS_TREE_ORIGIN",
  ]) delete env[key];
  return env;
}

/** One scope's automations context (lib/automations.mjs automationContext) with its oats-local.yaml;
 *  an unreadable oats-local.yaml means no workspace automations (the local jobs still run). `remotes`:
 *  lib/member-clone.mjs verifyMemberClone's, for a read that verifies the same clones again. `lookup`: the
 *  status display's gh login lookup (lib/automations.mjs ghLogin), never an act's. */
export function scopeAutomations(ws, { io, now = new Date(), refresh = false, cache = new Map(), remotes, lookup } = {}) {
  let local = null;
  try { local = loadLocal(ws).local; } catch { local = null; }
  const clonePathOf = (repoKey) => resolveMemberClone({ deployment: ws, soulEntry: { repoKey }, local }, { remotes });
  const ctx = automationContext(ws, { local, io: { ...(io || {}), childEnv }, now, refresh, cache, clonePathOf, lookup });
  return Object.assign(ctx, { ws, local });
}
