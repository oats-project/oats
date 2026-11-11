// The `./core` export (package.json "exports"; lib/core.mjs) is the kernel's in-process API: the pi
// adapter, the TUI, packages/record and the Desktop's server import it. Its names, and which of them are
// async functions, are pinned here: lib/core.mjs moves code into leaves and re-exports it
// (awebai/oats#1630), and a move must neither add nor drop a name, nor turn a sync export async.
import test from "node:test";
import assert from "node:assert/strict";

const NAMES = [
  "CODEX_TASK_PROMPT", "DEFAULT_PACKAGE_PATH", "DEFAULT_TMUX_SESSION", "DEV_CHANNEL_STATEMENT",
  "FAILED_SPAWN_BRANCH_LEFT", "FLAG_IGNORED_WARNING", "GIT_OPERATION_ENTRIES", "HARNESS_PACKAGE_MANAGERS",
  "IDENTITY_LAUNCH_ENV", "KERNEL_HOME_RECEIPTS", "LAUNCH_CONFIG_KEYS", "LAUNCH_HARNESSES",
  "LAUNCH_RECIPE_VERSION", "LAUNCH_REF_PREFIX", "LAYERS", "MAX_INSTANCE_NAME", "NATIVE_DEFAULT_MODEL",
  "OATS_VERSION", "PACKAGED_SKILLS_DIR", "PKG_ROOT", "QUARANTINE_CLEANUP_VERSION", "QUARANTINE_GIT_DEBT",
  "READ_CLAIM_WHEN_UNWRITABLE", "RECOVERABLE_GIT_ADMIN", "RELATIONS", "RESERVED", "RESERVED_LAUNCH_ENV",
  "RESUME_NOTICE", "RETAINED_LEAF_MAX", "RETIRE_DELETE_BRANCH_REFUSED", "RETIRE_RETRY_DELAYS_MS", "RETIRE_SELECTED_HOME",
  "RETIRE_UNDER_CLAIM", "SCHEDULING_WAIT_MS", "STOP_UNDER_CLAIM", "TRIGGER_EVENT_FILE", "WORK_MODES",
  "appendLogEntry", "applicableRequirements", "assertLaunchRecipe", "assertSafeConfigKey",
  "attachInstanceSession", "attachedWorkLink", "canonicalAgentsRoot", "canonicalDeploymentPath",
  "capabilityExecutablePath", "capabilityManifest", "capabilityManifests", "capabilityTrust",
  "capturedHomeCapabilities", "capturedHomeRefusal", "capturedProviders", "checkLaunchExecutable",
  "claimHomeFor", "cloneOfMember", "compareVersionTriples", "completeDeferredRetirement",
  "composeInstanceAgentsMd", "copyRegularFile", "copyTreeSafe", "declaredLaunchEnv", "defaultRepo",
  "deferredRetireResultPath", "describeLaunchCommand", "enclosingInstanceHome", "ensureOatsTmuxSession",
  "ensureRoot", "exactTreeDigest", "explicitInstanceName", "extraWorktreePlan", "findAgent", "findAgentAt",
  "findInstanceHome", "findInstanceHomes", "findRetirementBaseline", "findRoot", "fingerprintTree",
  "generatedWorkDigest", "gitOperationInProgress", "harnessDefaultConfig", "harnessPackageIdentity",
  "harnessPackageStatus", "harnessProcesses", "homeClaimHolder", "homeDeclaredLaunchEnv", "homeLaunchLayers",
  "identifiedHomeRecord", "inputInstanceSession", "inspectInstanceSession", "installedHarnessPackageVersion",
  "instanceModulesRoot", "instanceSoulDir", "instanceWork", "instancesDirs", "isCapturedHome",
  "isWorkspaceHome", "kernelBin", "kernelShimDir", "launchConfigHarness", "launchConfigsAt",
  "launchEffectiveEnv", "launchEnvRefs", "launchEnvironment", "launchFolderTrust",
  "launchPromptAnswersNotice", "launchReportFor", "launchShellCommand", "launchStartNotices",
  "legacyCapturedHomes", "legacyClaudeConfigRefusal", "legacyLocalAgents", "lifecycleClaimRefusals",
  "lifecycleHookEnv", "listAgents", "listInstances", "logicalCwd", "machineLaunchConfigs",
  "machineLaunchConfigsFile", "manifestOperations", "materializedHookCommands", "missingGitObjects",
  "missingLaunchEnvRefs", "modelFromOf", "oatsError", "observeSessionWithoutReceipt",
  "officialCapabilityAliases", "officialCatalogFile", "officialPackageCatalog", "orderInstructionBlocks",
  "owedRetireSaid", "packageSpecIdentity", "packagedInject", "parseLaunchCommand", "parsePackageCatalog",
  "parseTmuxShellEnvironment", "parseYamlFlat", "parseYamlNested", "planInstanceResources", "planLaunch",
  "preWorkspaceHome", "prepareLaunchHooks", "preparedSoulIdOf", "preservationDetails",
  "previewLaunchEnvironment", "previewPaneEnvironment", "processScanAvailability", "processScanInformation",
  "processesInHome", "readHomeRecord", "readableInstanceHomes", "rebaseUpgradeRetirementBaseline",
  "recordedKernelBin", "recoveryDisagreed", "redactLaunchCommand", "redactLaunchRecipe",
  "refuseBesideRetire", "releaseHomeClaim", "removedLaunchEnv", "renderLaunchCommand", "renderLaunchRecipe",
  "requireStopGrace", "requirementHarness", "resolveLaunchExecutable", "resolveLaunchSelection",
  "resolveModelPreference", "resolveRepo", "resolveYolo", "resolvedFromHome", "resolvedFromPrepared",
  "restartInstanceSession", "resumeAnswer", "resumeConversation", "retainedWorktreesRoot", "retireClaimPath",
  "retireClaimRefusals", "retireFailure", "retireInstance", "retirePendingMarkerPath",
  "retirementBaselinePath", "retirementHomeChanged", "retirementRecoveryFacts", "retirementRecoveryRoot",
  "runLifecycleHooks", "safeHarnessPackageSpec", "safeHarnessSourceRef", "selectNewLaunch",
  "servedIdentityLine", "servedIdentityOf", "sessionDefaults", "sessionServerGone", "shellWord", "shq",
  "skillEntriesIn", "slug", "soulHarnessField", "spawnInstance", "spawnInstanceAsync", "stableSoulId",
  "startInstanceSession", "statusDisagreement", "stillRunningOf", "stopHarness", "stopInstanceSession",
  "storedTreeDigest", "stripInternalAnnotations", "suggestSpawnName", "teamEnv", "tmuxWindows", "todayISO",
  "unestablishedNote", "upgradeHoldsClaim", "upgradeHomeMeta", "upgradeLaunchRecipe", "validateLaunchConfig",
  "validateLaunchConfigDefaults", "withConfigFile", "withLaunchModel", "withSafeTaskPrompt", "workspaceOf",
  "workspaceSoulId", "worktreeBytes", "worktreeDigests", "worktreeGitPaths", "writeHomeRecord", "writeKernelShim",
  "writeRetirementBaseline"
];
const ASYNC = ["attachInstanceSession", "spawnInstanceAsync", "suggestSpawnName"];

test("./core exports exactly its names, and only its async functions are async", async () => {
  const core = await import("@awebai/oats/core");
  assert.deepEqual(Object.keys(core).sort(), NAMES);
  assert.deepEqual(NAMES.filter((n) => core[n]?.constructor?.name === "AsyncFunction"), ASYNC);
});
