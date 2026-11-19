// The ONE module of packages/tui/ that imports the shared client home (packages/client/): the rest
// of the TUI names no reader path, so what the TUI takes from the shared readers is this list
// (test/tui-boundary.test.mjs pins it). Every function here is the Desktop's own, never a copy:
// the roster, its order, its words and what a failed read becomes are decided there, once, for
// both clients. test/client-boundary.test.mjs holds each name to the home's stable surface.
import { fileURLToPath } from "node:url";
import { clientTerms } from "../../client/client-terms.mjs";

export { displayLine, DETAIL_WITHHELD } from "../../client/display-text.mjs";
export { parseProbeStdout, acceptProbe, cliRecord } from "../../client/cli-locator.mjs";
export { cliDeploymentRead } from "../../client/deployment-read-cli.mjs";
export { cliDeploymentList } from "../../client/deployment-list-cli.mjs";
export { deploymentsListSupported } from "../../client/deployment-list.mjs";
export { cliRemoteRoster } from "../../client/cli-adapter.mjs";
// Pinned instances (feature instance-pin): the pin key runs the kernel's verb, read by the shared home.
export { pinInstance } from "../../client/instance-pin.mjs";
export { createDeploymentObserver, mapBounded, MAX_DEPLOYMENT_OBSERVATIONS } from "../../client/deployment-observer.mjs";
export { createWarmReader } from "../../client/warm-reader.mjs";
export { createRefreshLoop } from "../../client/refresh-loop.mjs";
export { rosterRows, kernelLiveness, livenessInput, livenessAnswers, panelInstances, pendingEntry, failedEntry, observedEntry } from "../../client/deployment-panel.mjs";
export { panelData, cliReadsRemotes, workspaceChoices, viewModel, listedViews, deployments } from "../../client/panel-views.mjs";
export { cliDeploymentIdentity, identityReadable, identityTimedOut } from "../../client/deployment-identity.mjs";
export { workspaceStep } from "../../client/workspace-step.mjs";
export { remoteRosterState } from "../../client/remote-roster.mjs";
export { observeIdentities, identityMemory } from "../../client/remote-identity-memory.mjs";
export { workspaceChoiceRows, choiceMatches, UNMATCHED_SECTION } from "../../client/workspace-choices.mjs";
export { shortPath, deploymentLabel, machineLabels } from "../../client/deployment-label.mjs";
export { instanceId, instanceVisibleInTree, waitingRollup, collapseKey, filterInstanceTree, hasInstanceChildren, heldHome, instanceSiblings, backgroundPlacement, BACKGROUND_FEATURE, PIN_FEATURE } from "../../client/instance-tree.mjs";
export { rosterSections, deploymentState, rowStale, primaryDeployment, isMultiDeployment, rosterSectionKey, sidebarSections } from "../../client/roster-sections.mjs";
export { runtimeState, runtimeCounts, originLead, siblingText, instanceColor } from "../../client/instance-presentation.mjs";
export { instanceDisplayName } from "../../client/instance-display-name.mjs";
export { waitingClaim, waitingLabel, waitedText, waitingClock, waitingBelowText } from "../../client/waiting-on-you.mjs";
export { instanceActs, openAct } from "../../client/instance-acts.mjs";
export { rowReason } from "../../client/remote-address.mjs";
export { sessionAttachArgv, prepareRemoteTerm, detachKeySupported, hostDetachKeySupported, preflightFailure, DETACH_KEY_FEATURE, PREFIX_SCROLL_FEATURE, localScrollKeys, hostScrollKeys } from "../../client/session-attach.mjs";
export { attachExit } from "../../client/attach-exit.mjs";
export { kernelLines } from "../../client/kernel-lines.mjs";
export { createLifecycleBoundary } from "../../client/instance-lifecycle.mjs";
export { createLifecycleConfirmation } from "../../client/lifecycle-confirmation.mjs";
export { createRetiresInFlight, retiringRows } from "../../client/retire-in-flight.mjs";
export { startGate, startInstance } from "../../client/session-start.mjs";
export { retainedStartMessage, launchFlagIgnored, flagIgnoredNotice } from "../../client/launch-prompt-outcome.mjs";
export { INSTANCE_VARIABLES } from "../../client/kernel-environment.mjs";
// #1559: the kernel's machine sweep, run when the TUI opens and when a read shows a lost session
// (lib/main.mjs): the shared trigger decides when, the runner runs it, and the reader words what it did.
export { runResumeSweep } from "../../client/session-resume-cli.mjs";
export { createResumeTrigger, localDeploymentIds } from "../../client/session-resume-trigger.mjs";
export { validateWorkspace } from "../../client/workspace-admission.mjs";
export { createSoulCatalog, soulCatalogKey } from "../../client/soul-catalog.mjs";
export { soulRows } from "../../client/soul-rows.mjs";
export { soulFacts, spawnRefusal, soulMatches } from "../../client/soul-facts.mjs";
export { createSpawnPreview } from "../../client/spawn-preview.mjs";
export { defaultSpawnChoices } from "../../client/spawn-preview-contract.mjs";
export { createSpawnApplyBoundary } from "../../client/spawn-apply.mjs";
export { createSpawnTransaction } from "../../client/spawn-transaction.mjs";
export { spawnProblem, outcomeWords, SPAWN_NEXT, soulCatalogFailure } from "../../client/spawn-messages.mjs";
export { catalogFailure } from "../../client/catalog-messages.mjs";
export { previewFacts } from "../../client/spawn-preview-facts.mjs";
export { subsequenceScore } from "../../client/subsequence-score.mjs";
export { createCapabilityCatalog, capabilityCatalogKey } from "../../client/capability-catalog.mjs";
export { memberNames, capabilitySource, groupCapabilities, hostKeyOf, capabilitySections, matchCapabilities, soulsComposition, rosterAgentName, layerLabel, capabilityUsers } from "../../client/capability-rows.mjs";
export { capabilityFacts, CAPABILITY_COPY } from "../../client/capability-facts.mjs";
export { CHORDS, CHORD_FAMILY_LABELS, DEFAULT_CHORD_FAMILY, LEADER_TABLE, PALETTE_KEYS, PLAIN_KEYS, chordKeyOf, doesLabel, leaderKey, plainKeys } from "../../client/keymap.mjs";
// keys.json, the chord family both clients bind (docs/tui.md, "Switch family"): the TUI reads the file
// itself, at its start (lib/config.mjs loadKeys), and the shared reader says what its text means.
export { KEYS_LIMIT, chordFamilyFrom, chordFamilyNote, keysPath } from "../../client/keys-file.mjs";

/** The words a shared sentence uses where it names the client that shows it (client-terms.mjs).
 *  Made once, here: every shared function that takes `terms` is passed this constant, and refuses
 *  anything else. */
export const TERMS = clientTerms({ name: "oats tui", self: "oats tui", selfInitial: "oats tui", update: "OATS", thisMachine: "This machine" });

/** The liveness collector, a program of the shared home: started as a child, never imported. */
export const COLLECTOR = fileURLToPath(new URL("../../client/liveness-main.mjs", import.meta.url));
