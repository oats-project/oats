/** The environment names the kernel sets for every launch: a launch configuration may not name them,
 *  and a scheduled job's environment drops them (automation-scope.mjs childEnv). A leaf
 *  (awebai/oats#1630): the automation scope reads it without loading core.mjs, which imports it and
 *  re-exports it. One instance, here. */

/** Environment the kernel sets for every launch (identity, home, roots) and
 *  its reference aliases: a configuration may not name them. */
export const RESERVED_LAUNCH_ENV = new Set(["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "OATS_AGENT", "OATS_SOUL", "OATS_SOUL_ID", "OATS_ROOT", "OATS_CONTEXT", "OATS_WORKSPACE", "OATS_EVENT", "OATS_SETTINGS", "OATS_SETTINGS_ORIGINS", "OATS_CLI_BIN", "OATS_NODE_BIN", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT",
  // What a spawn or launch hook is handed (#1667): the kernel's lookup, never a launch's to set.
  "OATS_HARNESS_EXECUTABLE",
  // The spawner a spawn hook is handed (feature spawn-attribution): the kernel's validation, never a launch's to set.
  "OATS_SPAWNER_HOME",
  // A keyed apply's key, handed to its spawn hooks, and the act a sandbox hook is handed (sandboxes, C4, C6).
  "OATS_SPAWN_IDEMPOTENCY_KEY", "OATS_SANDBOX_ACT",
  // The test seam of the sandbox hook's time limit (lib/sandboxes.mjs).
  "OATS_TEST_SANDBOX_HOOK_TIMEOUT_MS",
  // The test seam that replaces the login shell (lib/login-environment.mjs): never a launch's to set.
  "OATS_TEST_LOGIN_SHELL",
  // The test seams of #796, the same: a worktree hook's fixed timeout, the fetch timeout of
  // `oats worktree add` (lib/worktree-hooks.mjs, lib/worktree.mjs), and the `ps` path of a
  // process's start time on a host with procfs, and the `ps` it runs (lib/worktree-hooks.mjs processStart).
  "OATS_TEST_WORKTREE_HOOK_TIMEOUT_MS", "OATS_TEST_WORKTREE_FETCH_TIMEOUT_MS", "OATS_TEST_PROCESS_START_PS",
  // The test seams of #915 and #1559: the cgroup the kernel judges itself in, whether the host was
  // booted with systemd, and the directories its systemd-run comes from (lib/tmux-server-scope.mjs,
  // lib/system-tools.mjs).
  "OATS_TEST_CGROUP", "OATS_TEST_SYSTEMD_BOOTED", "OATS_TEST_SYSTEM_TOOL_DIRS",
  // The test seam of #1421 §3: the naming call's time limit (lib/instance-naming.mjs NAMING_TIMEOUT_MS).
  "OATS_TEST_NAMING_TIMEOUT_MS"]);
