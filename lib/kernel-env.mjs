/** lib/kernel-env.mjs — the names the kernel generates into a launch or a hook environment, and the
 *  environment without them. A leaf: lib/core.mjs (the launch and login environments) and
 *  lib/sandboxes.mjs (the sandbox hook's environment) share it without loading each other. Dependency-free
 *  beyond the reserved launch names. */
import { RESERVED_LAUNCH_ENV } from "./reserved-launch-env.mjs";

/** A launch reference's prefix (OATS_LAUNCH_REF_<NAME>): a launch configuration may not name it. */
export const LAUNCH_REF_PREFIX = "OATS_LAUNCH_REF_";
/** Every name the kernel itself generates into a launch or a hook environment, and the three that
 *  tie a process to its own terminal. None of them is part of an environment OATS starts a tmux
 *  server, a session or a window with. Not the whole OATS_ prefix: operators export configuration
 *  under it (OATS_HOME_DIR, OATS_TMUX_SESSION). The inventory: RESERVED_LAUNCH_ENV; what
 *  runLifecycleHooks adds for a hook (capability, layer, level, meta, the spawn and launch facts in
 *  its extraEnv, the team and workspace names of teamEnv); what operator dispatch, retire and a
 *  trigger add. Launch references (OATS_LAUNCH_REF_<NAME>, and the NAME each stands for) are
 *  removed by prefix in withoutKernelEnvironment. No harness's name is here. */
export const KERNEL_ENV_NAMES = new Set([...RESERVED_LAUNCH_ENV, "COLORFGBG", "TMUX", "TMUX_PANE",
  "OATS_CAPABILITY", "OATS_LAYER", "OATS_LEVEL", "OATS_META", "OATS_DEPLOYMENT", "OATS_RESOLUTION", "OATS_OPERATION",
  "OATS_REPO", "OATS_BRANCH", "OATS_WORK", "OATS_KIND", "OATS_TASK", "OATS_HARNESS", "OATS_PREVIOUS_HARNESS", "OATS_RUNTIME", "OATS_PREVIOUS_RUNTIME",
  "OATS_LAUNCH_PREVIEW", "OATS_RETIRE_INTENT", "OATS_TRIGGER_EVENT_FILE",
  "OATS_TEAM_NAME", "OATS_TEAM_SCOPE", "OATS_TEAM_ID", "OATS_TEAM_LABEL", "OATS_TEAM_LABELS", "OATS_TEAMS", "OATS_TEAMS_SOURCE",
  "OATS_DEFAULT_TEAM", "OATS_DEFAULT_TEAM_ID", "OATS_DEFAULT_TEAM_FROM", "OATS_WORKSPACE_NAME", "OATS_WORKSPACE_KEY",
  // A worktree hook's tree (#796): never inherited by what such a hook starts.
  "OATS_TREE", "OATS_TREE_CLONE", "OATS_TREE_REMOTE", "OATS_TREE_MEMBER", "OATS_TREE_BASE", "OATS_TREE_BASE_OID", "OATS_PURPOSE", "OATS_TREE_ORIGIN"]);
export function withoutKernelEnvironment(source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (name.startsWith(LAUNCH_REF_PREFIX)) { delete env[name]; delete env[name.slice(LAUNCH_REF_PREFIX.length)]; }
  }
  for (const name of KERNEL_ENV_NAMES) delete env[name];
  return env;
}
