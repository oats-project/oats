// The reading test of the shared home (packages/client): who may import what, read from the sources.
// It reads files and imports none of them, so it runs on a root-only checkout with nothing installed.
//
//   packages/client/   imports only its own files and node: builtins: nothing from packages/desktop,
//                      packages/tui or lib/, no third-party package. It names Electron neither as a
//                      module nor as a runtime. No module but liveness-main.mjs imports
//                      own-environment.mjs. The directory holds .mjs modules and nothing else.
//   packages/tui/      (when it exists) imports only node: builtins, its own files, and from
//                      packages/client only the modules and exports of the stable surface (SURFACE).
//   lib/ and bin/      import nothing from packages/client or packages/desktop.
//
// Each rule is proved to fail on the break it names, on fixtures built here (the last tests).
//
// What the reader sees, wherever it stands in the code: `import … from`, `export … from`, `import "x"`,
// `import("literal")`, `require("literal")` and `new URL("literal", import.meta.url)`. In packages/client
// and packages/tui anything else that loads a module is refused, not skipped: a load with anything but
// one string literal (a concatenation, a template with a `${…}`, a second argument), `createRequire`,
// an import the reader cannot read, and a `/ … /` it cannot tell for a regular expression or two divisions
// where one reading would hide code from the other. In lib/ and bin/, which load hooks and subcommands by computed
// paths, a quoted relative path that leads into packages/client or packages/desktop is refused wherever
// it stands in the text. What that leaves unseen there: a path put together from pieces that do not
// spell the directory. And everywhere: the test reads, it does not run, so a loader built out of strings
// (`eval`, `new Function`) is outside what it can see.
//
// A refusal says what to write instead, and that the rule is this test's: whoever meets one may be
// changing lib/ or bin/, and need not know the shared home to get past it.
//
// Two things this test does not prove, and what does:
//   * that a module of the home uses no DOM global (the modules use `window` and `document` as ordinary
//     local names, so a name check cannot tell): test/client-loading.test.mjs loads every one under
//     plain Node;
//   * where the Desktop's package carries the home: packages/desktop/test/inventory.test.mjs, which
//     keeps its own reading rule for the job that installs only the Desktop. Neither depends on the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { tokensOf, readingsOf } from "./helpers/source-tokens.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOME = "packages/client", TUI = "packages/tui", DESKTOP = "packages/desktop";

/**
 * The stable surface of packages/client for packages/tui: the modules the TUI may import, each with the
 * exports it may name. A change to one of them updates the TUI in the same PR; anything not listed is
 * the Desktop's own composition and may change without notice.
 * From specs/2026-10-10-stable-surface-v1.md of the Desktop expert (v1, revised for 1b): its firm table
 * and its provisional lists, both; and from 1c, the client's own terms, which several of the listed
 * functions take as an argument (client-terms.mjs). "All" of a module is written out, so a new export is unlisted until
 * this list says otherwise.
 */
const SURFACE = Object.freeze({
  // Firm: the frame and the Instances view.
  "display-text.mjs": ["displayLine", "cleanLine", "DETAIL_WITHHELD", "MAX_DISPLAY_LINE", "NOT_NOTE_TEXT", "UNSAFE"],
  "cli-locator.mjs": ["ACCEPT_RANGE", "acceptRangeText", "PROBE_NAME", "parseSemver", "parseProbeStdout", "acceptProbe", "cliRecord"],
  "cli-probe-contract.mjs": ["probeSignature", "probeChanged"],
  "deployment-contract.mjs": ["DEPLOYMENT_FEATURES", "deploymentRecord", "deploymentReadGate", "deploymentFailure", "OBSERVE_MAX_AGE_FEATURE", "validMaxAge", "maxAgeArgv"],
  "deployment-read-cli.mjs": ["cliDeploymentRead", "DEPLOYMENT_READ_TIMEOUT", "DEPLOYMENT_READ_MAX_BUFFER"],
  "deployment-data.mjs": ["deploymentStatusData", "workspaceStatusData", "observationData",
    "soulsData", "soulCapabilitiesOf", "capabilitiesData"],
  "deployment-observer.mjs": ["createDeploymentObserver", "mapBounded", "MAX_DEPLOYMENT_OBSERVATIONS"],
  // #1630 (option C): the background reads through one warm `oats reader --stdio` child, falling back to the CLI read.
  "warm-reader.mjs": ["createWarmReader"],
  "refresh-loop.mjs": ["createRefreshLoop", "REFRESH_FOCUSED_MS", "REFRESH_BLURRED_MS"],
  // 0.68.1: an instance name as words, the sidebar row's visible label in the Desktop and the TUI (display only).
  "instance-display-name.mjs": ["instanceDisplayName"],
  "instance-presentation.mjs": ["runtimeState", "runtimeCounts", "unsupportedSession", "originLead", "siblingText", "instanceColor"],
  "waiting-on-you.mjs": ["waitingClaim", "waitingLabel", "waitedText", "waitingClock", "waitingNames", "waitingBelowText", "waitingSentence"],
  "harness-names.mjs": ["HARNESSES", "HARNESS_NAMES", "harnessFeature", "harnessFlag", "harnessKey", "harnessOf", "harnessList"],
  "team-rows.mjs": ["teamRow", "teamRowsOf", "defaultTeamOf", "teamModelOf"],
  "launch-contract.mjs": ["effectiveOf", "launchOf", "REPORT_FROM", "PREVIEW_FROM", "RECORD_FROM"],
  "deployment-facts.mjs": ["memberLabel", "servedIdentityText", "deploymentUnavailableText"],
  "instance-admission.mjs": ["admitInstance", "instanceSelector"],
  "instance-tree.mjs": ["instanceId", "resolveLinkId", "clusterInstances", "recencyOrder", "rosterGroups", "waitingRollup", "instanceVisibleInTree",
    "collapseKey", "filterInstanceTree", "hasInstanceChildren", "heldHome", "instanceSiblings", "backgroundPlacement", "BACKGROUND_FEATURE"],
  // #1579: the roster's section key and the sidebar's sections (the main tree, then the Background section), both clients'.
  "roster-sections.mjs": ["rosterSections", "deploymentState", "rowStale", "primaryDeployment", "isMultiDeployment", "rosterSectionKey", "sidebarSections"],
  "kernel-environment.mjs": ["INSTANCE_VARIABLES", "withoutInstanceVariables"],
  // #1559: the kernel's machine sweep, when a client opens and when a read shows a lost session: the
  // shared trigger decides when, and the runner runs it through the client's change exec. The reader
  // (session-resume.mjs) is not on the surface: the trigger reads with it, and a client gets only its readings.
  "session-resume-cli.mjs": ["runResumeSweep"],
  "session-resume-trigger.mjs": ["createResumeTrigger", "localDeploymentIds"],
  "client-terms.mjs": ["clientTerms"],
  // Firm (1d): what one deployment's observation becomes for the panel. A client calls `panelInstances`, not the row's own projection.
  "deployment-panel.mjs": ["rosterRows", "kernelLiveness", "livenessInput", "livenessAnswers", "panelInstances", "pendingEntry", "failedEntry", "observedEntry", "publicDeployment"],
  // Firm (1d): the deployments a client holds and the views over them. The rest of the module is the Desktop's own composition.
  "panel-views.mjs": ["deployments", "deploymentInfo", "deploymentTag", "deploymentEntry", "deploymentPanel", "viewModel", "listedInfo", "listedViews", "viewFor", "panelData", "workspaceChoices", "cliReadsRemotes"],
  // #482 in a switcher: the identity of a listed deployment, read before it is served.
  "deployment-identity.mjs": ["cliDeploymentIdentity", "identityReadable", "identityTimedOut"],
  // Provisional: machines and the switcher. 3a: what a roster answer becomes (`remotePanel` takes the time of its call, required),
  // what a client remembers of the machines that answered, and the words a switcher shows for a view.
  "cli-adapter.mjs": ["parseEnvelope", "cliRemoteRoster", "cliCapability", "writeTaskFile"],
  "remote-roster.mjs": ["remoteWorkspace", "remotePanel", "remoteAgents", "unavailableGroups", "remoteRosterState", "remotePanelEntries"],
  "remote-identity-memory.mjs": ["observeIdentities", "identityMemory"],
  "workspace-choices.mjs": ["workspaceChoiceRows", "choiceMatches", "UNMATCHED_SECTION"],
  "workspace-views.mjs": ["readIdentity", "attachment", "viewId", "buildViews", "deploymentReason", "deploymentReasonParts"],
  "deployment-label.mjs": ["shortPath", "pathTail", "deploymentLabel", "deploymentLabelParts", "machineLabels", "machineLabelParts"],
  "remote-address.mjs": ["canAddressRemote", "serverLabel", "shownLabel", "unaddressableSentence", "rowReason", "remoteHeadline", "hostReason", "unroutableReason", "kernelCode"],
  "machine-contract.mjs": ["machinesGated"],
  "workspace-admission.mjs": ["validateWorkspace", "deploymentsInside"],
  // #1390: this computer's deployments, as the kernel lists them; each client words the states itself.
  "deployment-list.mjs": ["DEPLOYMENTS_LIST_FEATURE", "DEPLOYMENTS_API", "DEPLOYMENT_STATES", "DEPLOYMENT_VIAS", "listedPath", "deploymentsListSupported", "readDeploymentList", "readDeploymentAdd", "readDeploymentRemove", "readDeploymentImport"],
  // …and the four verbs a client runs on it, through the kernel.
  "deployment-list-cli.mjs": ["cliDeploymentList", "deploymentListArgv", "DEPLOYMENT_LIST_FAILURE_CODES", "DEPLOYMENT_IMPORT_MAX"],
  // Provisional: lifecycle (5a). A client stops and retires through its own boundary and confirmation; the CLI call
  // and the contract's readers are the boundary's, never a client's.
  "instance-lifecycle.mjs": ["createLifecycleBoundary", "supportsLifecycle"],
  "lifecycle-confirmation.mjs": ["planView", "outcomeView", "createLifecycleConfirmation", "applyRunningSentence"],
  "instance-acts.mjs": ["instanceActs", "openAct"],
  // #1247: a client keeps its own retires in flight (one tracker per run) and marks its rows with them; how the
  // kernel's `retire` is read (retire-state.mjs) stays the home's, behind the rows it already gives.
  "retire-in-flight.mjs": ["createRetiresInFlight", "retiringRows"],
  // 5a-2: a client starts and restarts an existing instance through the start rule; the CLI call and the launch
  // choices' argv are the rule's, never a client's.
  "session-start.mjs": ["startGate", "startInstance", "verifiedLocalHome"],
  // Provisional: souls, inspect, spawn.
  "inspect-contract.mjs": ["inspectSupported", "inspectData", "originText", "inspectFacts"],
  // 6a: the souls a deployment offers and one soul's inspection. A client makes its own catalog, cache and
  // boundary (each a factory that holds nothing at module level) and lists, inspects and describes a soul with
  // the rules the Desktop uses. The holding rules under the catalog (keyed-catalog.mjs) and the soul colours
  // (soul-colors.mjs; a row carries its colour already) are not on it.
  "soul-catalog.mjs": ["createSoulCatalog", "soulCatalogKey", "SOUL_CATALOG_RETRY_MS"],
  "soul-rows.mjs": ["soulRows"],
  // 7a: a deployment's capabilities. A client makes its own table (a factory over the holding rules, as the soul
  // catalog), and reads a row's source, group, sections, search and users, and its page's facts and words, with the
  // rules the Desktop draws. What makes DOM (the rows, the pills, the chips) stays in the Desktop.
  "capability-catalog.mjs": ["createCapabilityCatalog", "capabilityCatalogKey", "CAPABILITY_CATALOG_RETRY_MS"],
  "capability-rows.mjs": ["memberNames", "capabilitySource", "capabilityGroup", "groupCapabilities", "hostKeyOf", "capabilitySections", "matchCapabilities",
    "capabilityUse", "composes", "soulsUsing", "SOULS_CAPABILITIES_FEATURE", "soulsComposition", "rosterAgentName", "layerLabel", "capabilityUsers"],
  "capability-facts.mjs": ["capabilityFacts", "fingerprint", "packageOrigin", "CAPABILITY_COPY"],
  // #1276: the house fuzzy matcher, one copy for the Desktop's palette and Quick Open and the TUI's palette. The
  // soul filter (soul-facts.mjs soulMatches) and a failed soul catalog read's sentence (spawn-messages.mjs
  // soulCatalogFailure) are one copy the same way.
  "subsequence-score.mjs": ["subsequenceScore"],
  "inspect-boundary.mjs": ["createInspectBoundary"],
  "inspect-cache.mjs": ["createInspectCache"],
  "composed-gate.mjs": ["composedSupported", "routedComposedSupported", "skillsSupported", "routedSkillsSupported", "hostComposes", "hostReportsSkills"],
  "soul-facts.mjs": ["soulFacts", "spawnRefusal", "desktopFacts", "soulMatches"],
  "launch-view.mjs": ["shownLaunch", "launchHarnessName", "launchModelText", "launchFromText", "preferenceText", "declaredDiffers", "declaredText", "launchAtText"],
  // 6b-1: a client previews and spawns through boundaries it creates and owns; the raw CLI calls are theirs.
  "spawn-preview.mjs": ["createSpawnPreview"],
  "spawn-preview-contract.mjs": ["previewSupported", "previewSelector", "previewChoices", "choiceArgv", "previewTarget", "previewData", "previewFailure", "worktreeHooksOf", "INSTANCE_NAME_MAX", "defaultSpawnChoices"],
  "spawn-decision.mjs": ["spawnEffective", "spawnDecision", "sameSpawnDecision"],
  "spawn-apply.mjs": ["createSpawnApplyBoundary"],
  // 6b-2: the spawn's client half. A client makes its own transaction and runs it, says a problem's and an
  // outcome's shared facts with its own words for `next` (a closed set), and draws a preview's facts its own way.
  "spawn-transaction.mjs": ["createSpawnTransaction", "RECOVER_POLL_MS", "FOLLOW_MARGIN_MS"],
  "spawn-messages.mjs": ["spawnProblem", "outcomeWords", "catalogProblem", "SPAWN_NEXT", "soulCatalogFailure"],
  // #1301: one sentence for a failed catalog read, the souls' and the capabilities' (soulCatalogFailure is it, with
  // the noun "souls"); the noun is one of the two, so no client words a third catalog its own way.
  "catalog-messages.mjs": ["catalogFailure"],
  "spawn-preview-facts.mjs": ["previewFacts"],
  "spawn-apply-contract.mjs": ["spawnApplySupported", "spawnApplyDeadlineMs", "spawnReference", "spawnCreationReceipt", "ROLLED_BACK_CODES", "spawnApplyReason", "spawnApplyFailure"],
  "launch-prompt-outcome.mjs": ["LAUNCH_INSPECTION", "LAUNCH_DIAGNOSTIC_BYTES", "launchPromptOutcome", "retainedSpawnDetails", "retainedSpawnMessage", "retainedStartMessage", "launchFlagIgnored", "flagIgnoredNotice"],
  "capability-warnings-contract.mjs": ["warningsOf", "previewWarningsOf", "warningsShown"],
  // Provisional: capabilities.
  "workspace-cli.mjs": ["cliWorkspace", "workspaceGate", "workspaceFailure", "WORKSPACE_ACTIONS"],
  "capability-show-contract.mjs": ["capabilityShowSupported", "capabilitySelector", "sameSelector", "capabilityShowData", "capabilityFileData", "listedFiles", "skillFilePath", "skillRelativePath"],
  // Provisional: opening an agent.
  "session-attach.mjs": ["prepareRemoteTerm", "sessionAttachArgv", "detachKeySupported", "hostDetachKeySupported", "preflightFailure", "DETACH_KEY_FEATURE", "PREFIX_SCROLL_FEATURE", "localScrollKeys", "hostScrollKeys"],
  "attach-exit.mjs": ["attachExit"],
  "kernel-lines.mjs": ["kernelLines"],
  // The keys both clients share (#1395): the leader, its table, the plain keys of the list and the chords. The TUI reads its
  // defaults from it and holds no copy.
  "keymap.mjs": ["CHORDS", "CHORD_FAMILIES", "CHORD_FAMILY_LABELS", "DEFAULT_CHORD_FAMILY", "LEADER", "LEADER_TABLE", "PALETTE_KEYS", "PLAIN_KEYS",
    "chordKey", "chordKeyOf", "doesLabel", "leaderKey", "leaderDoes", "paletteKey", "plainKeys", "leaderRows"],
  // The leader's Up and Down between the rows of the list of workspaces: the one pure step both clients take.
  "workspace-step.mjs": ["workspaceStep"],
  // 3c: keys.json, the chord family both clients bind; each does its own IO.
  "keys-file.mjs": ["KEYS_LIMIT", "KEYS_WHY", "keysPath", "chordFamilyFrom", "chordFamilyNote", "keysWithFamily"],
});
/** Never importable, by anyone but the one the comment names. */
const ENVIRONMENT = "own-environment.mjs"; // changes the environment of whoever imports it; the collector's entry does, first
const COLLECTOR = "liveness-main.mjs";     // a program: started as a child, never imported

// ── The reader ────────────────────────────────────────────────────────────────
// A tree is a Map of repository-relative path (with `/`) to the file's text; a file that is not a
// module is there with the text "". The rules read a tree and nothing else, so the same rules run on
// the repository and on the fixtures.

const isModule = (path) => /\.(mjs|cjs|js|jsx|ts|mts|cts|tsx)$/.test(path);
const under = (path, dir) => path.startsWith(`${dir}/`);
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");
// Tokens, not lines. An import is found wherever it stands in the code (a second statement on a line, a
// minified file, the `${…}` of a template) and never in a comment or a string. What is not one of the
// forms a rule can judge is reported as a form of its own, so a rule refuses it instead of not seeing it.

/** The words that load a module, or carry one out. */
const LOADS = /\b(import|export|require|createRequire)\b/;

/** Helpers over a token list: is token k this, is the name at k a property (`x.import`), and the text of a string that is one literal. */
function reading(T) {
  const is = (k, t, v) => T[k]?.t === t && (v === undefined || T[k].v === v);
  const property = (k) => is(k - 1, "p", ".") && !is(k - 2, "p", ".");
  const literal = (k) => ((is(k, "str") || (is(k, "tpl") && T[k].plain)) && !T[k].v.includes("\\") ? T[k].v : null);
  /** A call whose `(` is at k: its one string-literal argument, or null when it is called with anything else. */
  const oneLiteral = (k) => {
    let depth = 0, end = -1;
    for (let j = k; j < T.length && end < 0; j++) {
      if (T[j].t === "p" && "([{".includes(T[j].v)) depth++;
      else if (T[j].t === "p" && ")]}".includes(T[j].v) && --depth === 0) end = j;
    }
    const count = end - k - 1;
    return literal(k + 1) !== null && (count === 1 || (count === 2 && is(k + 2, "p", ","))) ? literal(k + 1) : null;
  };
  return { is, property, literal, oneLiteral };
}

/**
 * What a source asks for, in the order it asks: `{ spec, form, names }`. `names` are the exported names it
 * takes from `spec` (the left of an `as`), for the two forms that list them.
 *   named       import { a, b as c } from "x"        reexport   export { a } from "x"
 *   default     import a from "x"                    star       export * from "x"
 *   namespace   import * as a from "x"               dynamic    import("x")
 *   bare        import "x"                           require    require("x")
 *                                                    url        new URL("./x", import.meta.url)
 * And two with no `spec`, for what cannot be judged by reading:
 *   computed    import(…) or require(…) with anything but one string literal (a concatenation, a template with a
 *               `${…}`, a second argument), and `createRequire`, which makes a loader this reader cannot follow
 *   unreadable  an `import` or `export … from` that is none of the forms above, a specifier written with an escape,
 *               and a regular expression that spells a load
 *   ambiguous   a `/ … /` (its `text`) that may be a regular expression or two divisions, where the two readings do
 *               not ask for the same: one of them hides code from the other. With `unchecked`, the file has more
 *               readings than are checked, and `text` is the first such place of the reader's own reading
 */
function requestsOf(source) {
  const readings = readingsOf(source), own = requestsIn(readings ? readings[0] : tokensOf(source));
  // Where the reader had to guess between a regular expression and two divisions, every reading must ask for the same.
  if (readings?.every((T) => JSON.stringify(requestsIn(T)) === JSON.stringify(own))) return own;
  return [...own, { spec: null, form: "ambiguous", names: [], text: (readings ? readings[0] : tokensOf(source)).guesses[0].text, ...(readings ? {} : { unchecked: true }) }];
}
function requestsIn(T) {
  const { is, property, literal, oneLiteral } = reading(T), found = [];
  // A specifier written with an escape is not the text it loads: not read, so not judged.
  const add = (form, spec = null, names = []) => found.push(spec?.includes("\\") ? { spec: null, form: "unreadable", names: [] } : { spec, form, names });
  const fromAt = (k) => is(k, "id", "from") && is(k + 1, "str");
  /** The exported names of a `{ a, b as c }` list whose tokens are these: the first of each entry (`type a` in a TypeScript file: the second). */
  const listed = (tokens) => {
    const names = [];
    for (let n = 0; n < tokens.length; n++) {
      if (tokens[n].t === "p") continue;
      if (tokens[n].v === "type" && tokens[n + 1] && tokens[n + 1].t !== "p" && tokens[n + 1].v !== "as") n++;
      names.push(tokens[n].v);
      while (tokens[n + 1] && tokens[n + 1].t !== "p") n++;
    }
    return names;
  };
  for (let k = 0; k < T.length; k++) {
    // A load spelled inside a regular expression: read as two divisions the same text would be a load, so even where
    // the tokens are sure it is a regular expression, nothing is decided.
    if (T[k].t === "re" && LOADS.test(T[k].v)) { add("unreadable"); continue; }
    if (T[k].t !== "id" || property(k)) continue;
    const word = T[k].v;
    if (word === "import") {
      if (is(k + 1, "p", ".") || is(k + 1, "p", ":")) continue; // import.meta, and a property named import
      if (is(k + 1, "p", "(")) { const spec = oneLiteral(k + 1); add(spec === null ? "computed" : "dynamic", spec); continue; }
      if (is(k + 1, "str")) { add("bare", T[k + 1].v); continue; }
      // A declaration: names, braces, commas and a star, up to `from "x"`.
      let j = k + 1;
      if (is(j, "id", "type") && !fromAt(j + 1) && !is(j + 1, "p", ",")) j++; // `import type …` in a TypeScript file
      const start = j;
      while (j < T.length && !fromAt(j) && (T[j].t === "id" || T[j].t === "str" || (T[j].t === "p" && "{},*".includes(T[j].v)))) j++;
      if (!fromAt(j) || j === start) { add("unreadable"); continue; }
      const clause = T.slice(start, j), spec = T[j + 1].v, open = clause.findIndex((t) => t.t === "p" && t.v === "{"), close = clause.findIndex((t) => t.t === "p" && t.v === "}");
      if (open >= 0) add("named", spec, listed(clause.slice(open + 1, close < 0 ? clause.length : close)));
      const rest = open < 0 ? clause : [...clause.slice(0, open), ...clause.slice(close < 0 ? clause.length : close + 1)];
      for (let n = 0; n < rest.length; n++) {
        if (rest[n].t === "p" && rest[n].v === ",") continue;
        add(rest[n].t === "p" && rest[n].v === "*" ? "namespace" : "default", spec);
        while (rest[n + 1] && rest[n + 1].t !== "p") n++;
      }
      k = j + 1;
    } else if (word === "export") {
      let j = k + 1;
      if (is(j, "id", "type") && is(j + 1, "p", "{")) j++;
      if (is(j, "p", "*")) {
        j += is(j + 1, "id", "as") ? 3 : 1;
        if (fromAt(j)) add("star", T[j + 1].v); else add("unreadable");
      } else if (is(j, "p", "{")) {
        let end = j + 1;
        while (end < T.length && !is(end, "p", "}")) end++;
        if (fromAt(end + 1)) add("reexport", T[end + 2].v, listed(T.slice(j + 1, end)));
      }
    } else if (word === "require" && is(k + 1, "p", "(")) {
      const spec = oneLiteral(k + 1); add(spec === null ? "computed" : "require", spec);
    } else if (word === "createRequire") add("computed");
    else if (word === "URL" && is(k - 1, "id", "new") && is(k + 1, "p", "(")) {
      const spec = literal(k + 2);
      if (spec !== null && isRelative(spec) && is(k + 3, "p", ",") && is(k + 4, "id", "import") && is(k + 5, "p", ".") && is(k + 6, "id", "meta") && is(k + 7, "p", ".") && is(k + 8, "id", "url") && is(k + 9, "p", ")")) add("url", spec);
    }
  }
  return found;
}

/** Electron as a module or as a runtime, in the code: the string "electron" (or a subpath of it), `process.versions.electron`,
 * `process.resourcesPath` and `process.type`, by `.name`, `?.name` or `["name"]`, wherever they stand. A comment may say any of
 * them, and the names Electron's variables carry in the environment (ELECTRON_RUN_AS_NODE) are data, not a dependency. */
function namesElectron(source) {
  return (readingsOf(source) ?? [tokensOf(source)]).some(namesElectronIn); // in any reading
}
function namesElectronIn(tokens) {
  const at = (token, v) => token?.t === "p" && token.v === v;
  // `?.name` reads what `.name` does, and `?.[` what `[` does.
  const T = tokens.filter((t, k, all) => !(at(t, "?") && at(all[k + 1], ".")) && !(at(t, ".") && at(all[k - 1], "?") && at(all[k + 1], "[")));
  const text = (k) => (T[k]?.t === "str" || (T[k]?.t === "tpl" && T[k].plain) ? T[k].v : null);
  /** The property read at k and where the next read would start, or null. */
  const read = (k) => (T[k]?.t !== "p" ? null : T[k].v === "." && T[k + 1]?.t === "id" ? [T[k + 1].v, k + 2]
    : T[k].v === "[" && text(k + 1) !== null && T[k + 2]?.t === "p" && T[k + 2].v === "]" ? [text(k + 1), k + 3] : null);
  return T.some((t, k) => {
    if (/^electron(\/|$)/.test(text(k) ?? "") || (t.t === "id" && t.v === "resourcesPath")) return true;
    if (t.t !== "id" || t.v !== "process") return false;
    const first = read(k + 1);
    return !!first && (first[0] === "type" || first[0] === "resourcesPath" || (first[0] === "versions" && read(first[1])?.[0] === "electron"));
  });
}

/** The names a module exports, read from its code: declarations (`const a = …, b = …` declares two) and `export { … }` lists. */
function exportsOf(source) {
  const [own, ...others] = (readingsOf(source) ?? [tokensOf(source)]).map(exportsIn);
  return new Set([...own].filter((name) => others.every((names) => names.has(name)))); // in every reading
}
function exportsIn(T) {
  const { is, property } = reading(T), out = new Set();
  /** Whether the statement runs on from `before` to `after` across a line break: an operator ends the one or starts the other. */
  const runsOn = (before, after) => (before.t === "p" && ",=?:&|+-*/<>.(![{%^~".includes(before.v)) || (after.t === "p" && ".?:&|+-*/,=<>)]}%^".includes(after.v));
  for (let k = 0; k < T.length; k++) {
    if (!is(k, "id", "export") || property(k)) continue;
    let j = k + 1;
    if (is(j, "p", "{")) {
      for (j++; j < T.length && !is(j, "p", "}"); j++) if (T[j].t !== "p" && (is(j + 1, "p", ",") || is(j + 1, "p", "}"))) out.add(T[j].v);
      continue;
    }
    if (is(j, "id", "async")) j++;
    if (is(j, "id", "function")) { j += is(j + 1, "p", "*") ? 2 : 1; if (is(j, "id")) out.add(T[j].v); continue; }
    if (is(j, "id", "class")) { if (is(j + 1, "id")) out.add(T[j + 1].v); continue; }
    if (!["const", "let", "var"].some((keyword) => is(j, "id", keyword))) continue;
    // A name follows the keyword and every comma outside every bracket, until the statement ends: a `;`, or a line
    // break nothing runs across. `const { a, b: c } = x` declares what its braces bind: a and c.
    const declare = (m) => {
      if (is(m, "id")) return out.add(T[m].v);
      if (!is(m, "p", "{")) return;
      for (let n = m + 1; n < T.length && !is(n, "p", "}"); n++) if (is(n, "id") && !is(n + 1, "p", ":") && (is(n - 1, "p", "{") || is(n - 1, "p", ",") || is(n - 1, "p", ":"))) out.add(T[n].v);
    };
    declare(j + 1);
    let depth = 0;
    for (let m = j + 1; m < T.length; m++) {
      const t = T[m];
      if (m > j + 1 && depth === 0 && t.nl && !runsOn(T[m - 1], t)) break;
      if (t.t !== "p") continue;
      if ("([{".includes(t.v)) depth++;
      else if (")]}".includes(t.v)) { if (--depth < 0) break; }
      else if (depth === 0 && t.v === ";") break;
      else if (depth === 0 && t.v === ",") declare(m + 1);
    }
  }
  return out;
}
const resolve = (from, spec) => posix.normalize(posix.join(posix.dirname(from), spec));
const filesIn = (tree, dir) => [...tree.keys()].filter((path) => under(path, dir)).sort();

/** Whose rule a refusal is, for someone who meets one in a file that is not the shared home's. */
const WHOSE = "The rule is packages/client's: test/client-boundary.test.mjs reads the files it judges, and its header says what it can read.";
/** What to write instead, per refusal. */
const INSTEAD = {
  computed: 'Write the path as one string literal: import("./x.mjs").',
  unreadable: 'Write it as import … from "x", export … from "x" or import("x"), with the path a plain string and no escape in it; and build a regular expression that spells import, export or require from a string: new RegExp("…").',
  ambiguous: "Put parentheses around what is divided, or around the regular expression, so that it reads one way.",
};
/** What reading cannot judge, said once per file, each with what to write instead: a load that is not one string literal, an
 * import that is no form the reader knows, a `/` that reads two ways, and more readings than are checked. */
function unjudged(path, asked) {
  const ambiguous = asked.find((request) => request.form === "ambiguous");
  return [...(asked.some((request) => request.form === "computed") ? [`${path}: loads a module by something other than one string literal. ${INSTEAD.computed} ${WHOSE}`] : []),
    ...(asked.some((request) => request.form === "unreadable") ? [`${path}: has an import or an export … from that this reader cannot read. ${INSTEAD.unreadable} ${WHOSE}`] : []),
    ...(!ambiguous ? []
      : ambiguous.unchecked ? [`${path}: has more possible readings than this reader checks: too many places where a / may start a regular expression or divide (the first is ${ambiguous.text}). ${INSTEAD.ambiguous} ${WHOSE}`]
      : [`${path}: ${ambiguous.text} may be a regular expression or two divisions, and one reading would hide code from this reader. ${INSTEAD.ambiguous} ${WHOSE}`])];
}

/** packages/client: its own files and node: builtins, no Electron, one importer of own-environment.mjs, modules only. */
function homeProblems(tree) {
  const problems = [];
  for (const path of filesIn(tree, HOME)) {
    const name = path.slice(HOME.length + 1);
    if (name.includes("/")) { problems.push(`${path}: the shared home is flat, and this is in a directory of it`); continue; }
    if (!name.endsWith(".mjs")) { problems.push(`${path}: not a .mjs module; the shared home holds modules and nothing else`); continue; }
    if (name.endsWith(".test.mjs")) problems.push(`${path}: a test does not go in the shared home`);
    const source = tree.get(path), asked = requestsOf(source);
    problems.push(...unjudged(path, asked));
    for (const { spec } of asked.filter((request) => request.spec !== null)) {
      if (spec.startsWith("node:")) continue;
      if (!isRelative(spec)) { problems.push(`${path}: imports "${spec}", which is not a Node builtin (node:…) or a file of the shared home`); continue; }
      const target = resolve(path, spec);
      if (!under(target, HOME)) problems.push(`${path}: "${spec}" leaves the shared home (${target})`);
      else if (!tree.has(target)) problems.push(`${path}: "${spec}" is ${target}, which does not exist`);
      else if (target === `${HOME}/${ENVIRONMENT}` && name !== COLLECTOR) problems.push(`${path}: imports ${ENVIRONMENT}, which changes the environment of whoever imports it; only ${COLLECTOR} does`);
      else if (target === `${HOME}/${COLLECTOR}`) problems.push(`${path}: imports ${COLLECTOR}, which is a program`);
    }
    if (namesElectron(source)) problems.push(`${path}: names Electron`);
  }
  return problems;
}

/** packages/tui: node: builtins, its own files, and the stable surface of packages/client by name. Nothing to say when it does not exist. */
function tuiProblems(tree, surface = SURFACE) {
  const problems = [];
  for (const path of filesIn(tree, TUI).filter(isModule)) {
    const asked = requestsOf(tree.get(path));
    problems.push(...unjudged(path, asked));
    for (const { spec, form, names: taken } of asked.filter((request) => request.spec !== null)) {
      if (spec.startsWith("node:")) continue;
      if (!isRelative(spec)) { problems.push(`${path}: imports "${spec}", which is not a Node builtin (node:…), a file of its own or the shared home`); continue; }
      const target = resolve(path, spec);
      if (under(target, TUI)) { if (!tree.has(target)) problems.push(`${path}: "${spec}" is ${target}, which does not exist`); continue; }
      if (!under(target, HOME)) { if (form !== "url") problems.push(`${path}: "${spec}" leaves packages/tui for ${target}, which is not the shared home`); continue; }
      // A path into the home that is not an import is how a program is started as a child: nothing is imported.
      if (form === "url") continue;
      const module = target.slice(HOME.length + 1);
      if (module === ENVIRONMENT || module === COLLECTOR) { problems.push(`${path}: imports ${module}, which is never imported from outside the shared home`); continue; }
      if (!Object.hasOwn(surface, module)) { problems.push(`${path}: imports ${module}, which is not on the stable surface`); continue; }
      if (form !== "named" && form !== "reexport") { problems.push(`${path}: takes ${module} by a ${form} import; the stable surface is imported by name (import { a } from …)`); continue; }
      for (const name of taken) if (!surface[module].includes(name)) problems.push(`${path}: imports ${name} from ${module}, which is not on the stable surface`);
    }
  }
  return problems;
}

/** lib/ and bin/: nothing from packages/client or packages/desktop. */
function kernelProblems(tree) {
  const problems = [];
  for (const path of [...filesIn(tree, "lib"), ...filesIn(tree, "bin")].filter(isModule)) {
    const source = tree.get(path), asked = requestsOf(source), found = new Set();
    // The kernel loads hooks and subcommands by computed paths, and may; what cannot be read at all is refused here too.
    problems.push(...unjudged(path, asked.filter((request) => request.form !== "computed")));
    for (const { spec } of asked.filter((request) => request.spec !== null && isRelative(request.spec))) {
      const target = resolve(path, spec);
      for (const dir of [HOME, DESKTOP]) if (target === dir || under(target, dir)) found.add(`${path}: "${spec}" is ${target}: the kernel imports nothing from ${dir}`);
    }
    // A load by a computed path (a template, a join) still spells the directory it leads into. Read from the
    // whole text, comments included: a quoted relative path into either directory has no business there.
    if (!found.size) for (const [, dir] of source.matchAll(/["'`](?:\.{1,2}\/)+(?:[^"'`\n]*\/)?(packages\/(?:client|desktop))(?=[/"'`])/g))
      found.add(`${path}: a relative path into ${dir}: the kernel imports nothing from ${dir}`);
    problems.push(...found);
  }
  return problems;
}

/** The surface names what the home has: every listed module exists and exports every listed name. */
function surfaceProblems(tree, surface = SURFACE) {
  const problems = [];
  for (const [module, listed] of Object.entries(surface)) {
    const path = `${HOME}/${module}`;
    if (module === ENVIRONMENT || module === COLLECTOR) problems.push(`${module}: on the stable surface, and it is never importable`);
    else if (!tree.has(path)) problems.push(`${module}: on the stable surface, and ${path} does not exist`);
    else { const has = exportsOf(tree.get(path)); for (const name of listed) if (!has.has(name)) problems.push(`${module}: ${name} is on the stable surface, and the module does not export it`); }
    if (new Set(listed).size !== listed.length) problems.push(`${module}: a name is listed twice`);
  }
  return problems;
}
const allProblems = (tree) => [...homeProblems(tree), ...tuiProblems(tree), ...kernelProblems(tree)];

/** The repository as a tree: the four places the rules read, every file of each. */
function repositoryTree() {
  const tree = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else tree.set(path, entry.isFile() && isModule(path) ? readFileSync(join(ROOT, path), "utf8") : "");
    }
  };
  for (const dir of [HOME, TUI, "lib", "bin"]) if (existsSync(join(ROOT, dir))) walk(dir);
  return tree;
}

// ── The repository ────────────────────────────────────────────────────────────

const repository = repositoryTree();

test("packages/client imports only its own files and node: builtins, names no Electron, and holds modules only", (t) => {
  assert.deepEqual(homeProblems(repository), []);
  // Not vacuous: the home was read, and the reader finds what its modules import.
  const modules = filesIn(repository, HOME);
  assert.ok(modules.length >= 48, `the shared home was read (${modules.length} files)`);
  const asked = modules.flatMap((path) => requestsOf(repository.get(path)));
  assert.ok(asked.filter((request) => isRelative(request.spec)).length > 60, "the reader sees the home's imports of its own files");
  assert.ok(asked.some((request) => request.spec.startsWith("node:")), "and its imports of node: builtins");
  assert.deepEqual(requestsOf(repository.get(`${HOME}/instance-acts.mjs`)).map((request) => request.spec), ["./instance-tree.mjs", "./instance-presentation.mjs", "./remote-address.mjs"]);
  // The one importer of the module that cleans an environment is the collector's entry, and it imports it first.
  assert.equal(requestsOf(repository.get(`${HOME}/${COLLECTOR}`))[0].spec, `./${ENVIRONMENT}`);
  t.diagnostic(`${modules.length} modules read`);
});

test("packages/tui imports only node: builtins, its own files and the stable surface of packages/client", (t) => {
  assert.deepEqual(tuiProblems(repository), []);
  // Until the TUI exists the rule holds for no files; the fixtures below prove it is a rule.
  t.diagnostic(`${filesIn(repository, TUI).filter(isModule).length} modules read${existsSync(join(ROOT, TUI)) ? "" : " (packages/tui does not exist yet)"}`);
});

test("lib/ and bin/ import nothing from packages/client or packages/desktop", (t) => {
  assert.deepEqual(kernelProblems(repository), []);
  const modules = [...filesIn(repository, "lib"), ...filesIn(repository, "bin")].filter(isModule);
  assert.ok(modules.includes("bin/oats.mjs") && modules.includes("lib/core.mjs"), "the kernel was read");
  assert.ok(requestsOf(repository.get("bin/oats.mjs")).some((request) => resolve("bin/oats.mjs", request.spec) === "lib/core.mjs"), "the reader sees the CLI's imports of the kernel");
  t.diagnostic(`${modules.length} modules read`);
});

test("the stable surface names what packages/client has: every listed module, every listed export", () => {
  assert.deepEqual(surfaceProblems(repository), []);
  assert.equal(Object.keys(SURFACE).length, 73);
  // #1559: the machine sweep's runner and the shared trigger, with the trigger's locality; not the reader.
  assert.deepEqual(["session-resume-cli.mjs", "session-resume.mjs", "session-resume-trigger.mjs"].map((module) => SURFACE[module]), [["runResumeSweep"], undefined, ["createResumeTrigger", "localDeploymentIds"]]);
  // #482 in a switcher: a listed deployment's identity, read before it is served.
  assert.ok(Object.hasOwn(SURFACE, "deployment-identity.mjs"), "deployment-identity.mjs");
  // #1395: the keys both clients share; the TUI reads its defaults from them.
  assert.ok(Object.hasOwn(SURFACE, "keymap.mjs"), "keymap.mjs");
  // The five modules 1b made are on it, with the names the TUI's first views take.
  for (const module of ["instance-tree.mjs", "roster-sections.mjs", "kernel-environment.mjs", "workspace-admission.mjs", "instance-acts.mjs"]) assert.ok(Object.hasOwn(SURFACE, module), module);
  // 1c: a second client says its own terms with clientTerms, and that is all it takes from that module.
  assert.deepEqual(SURFACE["client-terms.mjs"], ["clientTerms"]);
  // 1d: the panel's projection is on it; the projection of one row is not (a client calls `panelInstances`).
  assert.ok(Object.hasOwn(SURFACE, "deployment-panel.mjs") && !SURFACE["deployment-panel.mjs"].includes("panelInstance"));
  // Of the views, what a second client is meant to use; the Desktop's own composition and the module it calls are not on it.
  for (const name of ["viewForgeContext", "teamMembersFor", "machineScope", "surfaceDeployment", "deploymentFor", "deploymentRows", "isServed", "rememberedGroups", "workspaceEntry", "reasonFields"])
    assert.ok(!SURFACE["panel-views.mjs"].includes(name), name);
  assert.ok(!Object.hasOwn(SURFACE, "team-members.mjs"));
  // 3a: what a roster answer becomes, and the gate before its read; where the roster's groups land after a spawn stays the Desktop's.
  for (const name of ["remoteRosterState", "remotePanelEntries"]) assert.ok(SURFACE["remote-roster.mjs"].includes(name), name);
  assert.ok(SURFACE["panel-views.mjs"].includes("cliReadsRemotes") && !SURFACE["remote-roster.mjs"].includes("spawnedWorkspace"));
  // 3a: the memory of identities as two functions over Maps the client holds; the reader of a file's entry is the Desktop's.
  assert.deepEqual(SURFACE["remote-identity-memory.mjs"], ["observeIdentities", "identityMemory"]);
  // 3a: a second client's switcher reads the rows; the two functions a row is made of are the Desktop's own importers'.
  assert.deepEqual(SURFACE["workspace-choices.mjs"], ["workspaceChoiceRows", "choiceMatches", "UNMATCHED_SECTION"]);
  // #982: the words that name who made a text are on it; how the shared home decides a speaker is not.
  // #1421 §2: which colour a row shows is one rule (instanceColor); the palette itself stays off (below).
  assert.deepEqual(SURFACE["instance-presentation.mjs"], ["runtimeState", "runtimeCounts", "unsupportedSession", "originLead", "siblingText", "instanceColor"]);
  assert.ok(!Object.hasOwn(SURFACE, "kernel-made.mjs") && !Object.hasOwn(SURFACE, "liveness.mjs"));
  // 5a-2: a client starts through the start rule; the start's CLI call and its argv are the rule's.
  assert.deepEqual(SURFACE["session-start.mjs"], ["startGate", "startInstance", "verifiedLocalHome"]);
  for (const name of ["cliStart", "launchChoiceArgv"]) assert.ok(!SURFACE["cli-adapter.mjs"].includes(name), name);
  // 6a: souls and inspect. The catalog's holding rules and the colours stay off; of the inspect boundary, only its
  // factory (the admission, the call and the refusal are the boundary's, and the Desktop's run's).
  for (const module of ["keyed-catalog.mjs", "soul-colors.mjs"]) assert.ok(!Object.hasOwn(SURFACE, module), module);
  // 7a: the capability table is on it by its factory, key and retry window; the rows' and the page's rules by name.
  assert.deepEqual(SURFACE["capability-catalog.mjs"], ["createCapabilityCatalog", "capabilityCatalogKey", "CAPABILITY_CATALOG_RETRY_MS"]);
  assert.equal(SURFACE["capability-rows.mjs"].length, 15);
  assert.deepEqual(SURFACE["capability-facts.mjs"], ["capabilityFacts", "fingerprint", "packageOrigin", "CAPABILITY_COPY"]);
  assert.deepEqual(SURFACE["inspect-boundary.mjs"], ["createInspectBoundary"]);
  assert.deepEqual(SURFACE["soul-facts.mjs"], ["soulFacts", "spawnRefusal", "desktopFacts", "soulMatches"]);
  // 6b-1: the spawn boundaries are on it, each by its factory alone; their raw CLI calls are not.
  assert.deepEqual(SURFACE["spawn-preview.mjs"], ["createSpawnPreview"]); assert.deepEqual(SURFACE["spawn-apply.mjs"], ["createSpawnApplyBoundary"]);
  for (const module of ["spawn-preview-cli.mjs", "spawn-apply-cli.mjs"]) assert.ok(!Object.hasOwn(SURFACE, module), module);
  // 6b-2: the spawn's client half; its words are facts and `next` codes, and the Desktop's sentences stay in its renderer.
  assert.deepEqual(SURFACE["spawn-transaction.mjs"], ["createSpawnTransaction", "RECOVER_POLL_MS", "FOLLOW_MARGIN_MS"]);
  assert.deepEqual(SURFACE["spawn-messages.mjs"], ["spawnProblem", "outcomeWords", "catalogProblem", "SPAWN_NEXT", "soulCatalogFailure"]);
  // #1301: a failed catalog read's one sentence, by its one function.
  assert.deepEqual(SURFACE["catalog-messages.mjs"], ["catalogFailure"]);
  assert.deepEqual(SURFACE["spawn-preview-facts.mjs"], ["previewFacts"]); assert.ok(SURFACE["spawn-preview-contract.mjs"].includes("defaultSpawnChoices"));
  // Not on it: the two files nobody imports, and the terminal contract.
  for (const module of [ENVIRONMENT, COLLECTOR, "terminal-contract.mjs"]) assert.ok(!Object.hasOwn(SURFACE, module), module);
  // #1247: the retires in flight are on it by their factory and the row marker; the reading of the kernel's field is not.
  assert.deepEqual(SURFACE["retire-in-flight.mjs"], ["createRetiresInFlight", "retiringRows"]);
  assert.ok(!Object.hasOwn(SURFACE, "retire-state.mjs"));
});

// ── The rules fail on the breaks they name ────────────────────────────────────

/** A small repository that breaks no rule: a home, a TUI that uses it, the kernel. */
function fixture(changes = {}) {
  const tree = new Map(Object.entries({
    "packages/client/display-text.mjs": 'export function displayLine(v) { return v; }\nexport const cleanLine = (v) => v;\n',
    "packages/client/cli-locator.mjs": 'import { execFile } from "node:child_process";\nimport { displayLine } from "./display-text.mjs";\nexport const PROBE_NAME = "@awebai/oats";\nexport function discover() { return [execFile, displayLine]; }\n',
    "packages/client/terminal-contract.mjs": 'export const HERDR_REMOVED = "gone";\n',
    "packages/client/liveness.mjs": 'import { displayLine } from "./display-text.mjs";\nexport const collect = () => displayLine;\n// ELECTRON_RUN_AS_NODE is the name of a variable: data, not a dependency. process.title names no runtime.\n',
    "packages/client/own-environment.mjs": 'delete process.env.ELECTRON_RUN_AS_NODE;\nexport {};\n',
    "packages/client/liveness-main.mjs": 'import "./own-environment.mjs";\nimport { collect } from "./liveness.mjs";\ncollect();\n',
    "packages/tui/main.mjs": 'import { stdout } from "node:process";\nimport { frame } from "./frame.mjs";\nimport {\n  displayLine,\n  cleanLine as clean,\n} from "../client/display-text.mjs";\nexport { PROBE_NAME } from "../client/cli-locator.mjs";\nconst collector = new URL("../client/liveness-main.mjs", import.meta.url);\nstdout.write(frame(displayLine(clean(String(collector)))));\n',
    "packages/tui/frame.mjs": 'export const frame = (text) => `[${text}]`;\n',
    "packages/tui/README.md": "",
    "lib/core.mjs": 'import { readFileSync } from "node:fs";\nimport YAML from "yaml";\nimport { helper } from "./helper.mjs";\n// packages/desktop/server/tmux-status.mjs keeps the same default (a comment names a path; nothing is imported).\nexport const core = [readFileSync, YAML, helper];\n',
    "lib/helper.mjs": 'export const helper = 1;\n',
    "bin/oats.mjs": 'import { core } from "../lib/core.mjs";\nconst sub = process.argv[2];\nawait import(new URL(`../packages/record/bin/${sub}.mjs`, import.meta.url));\nconsole.log(core, "the OATS Desktop app (packages/desktop) is the control panel now.");\n',
  }));
  for (const [path, source] of Object.entries(changes)) if (source === null) tree.delete(path); else tree.set(path, source);
  return tree;
}
/** The fixture with one change breaks exactly one rule, in the words given. */
function breaks(rule, changes, pattern) {
  const tree = fixture(changes), problems = allProblems(tree);
  assert.equal(problems.length, 1, `one problem expected, got: ${JSON.stringify(problems)}`);
  assert.match(problems[0], pattern);
  assert.deepEqual(rule(tree), problems, "and the rule that names it is the one that finds it");
}

test("fixture: a repository that breaks no rule has no problem, with or without a TUI", () => {
  assert.deepEqual(allProblems(fixture()), []);
  const without = fixture({ "packages/tui/main.mjs": null, "packages/tui/frame.mjs": null, "packages/tui/README.md": null });
  assert.deepEqual(filesIn(without, TUI), []);
  assert.deepEqual(tuiProblems(without), [], "the TUI's rule holds when there is no TUI");
  assert.deepEqual(allProblems(without), []);
  // The reader reads the fixture's TUI the way the rules need: names on the left of an `as`, a re-export, a path that is not an import.
  assert.deepEqual(requestsOf(fixture().get("packages/tui/main.mjs")), [
    { spec: "node:process", form: "named", names: ["stdout"] },
    { spec: "./frame.mjs", form: "named", names: ["frame"] },
    { spec: "../client/display-text.mjs", form: "named", names: ["displayLine", "cleanLine"] },
    { spec: "../client/cli-locator.mjs", form: "reexport", names: ["PROBE_NAME"] },
    { spec: "../client/liveness-main.mjs", form: "url", names: [] },
  ]);
});

test("fixture, packages/client: a third-party import fails", () => {
  breaks(homeProblems, { "packages/client/liveness.mjs": 'import YAML from "yaml";\nexport const collect = YAML;\n' }, /^packages\/client\/liveness\.mjs: imports "yaml", which is not a Node builtin/);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'export const collect = () => require("left-pad");\n' }, /imports "left-pad"/);
  // A builtin is imported as node:…, so a bare name is never mistaken for one.
  breaks(homeProblems, { "packages/client/liveness.mjs": 'import { readFileSync } from "fs";\nexport const collect = readFileSync;\n' }, /imports "fs", which is not a Node builtin \(node:…\)/);
});

test("fixture, packages/client: an import that leaves the home fails (the Desktop, the TUI, the kernel)", () => {
  breaks(homeProblems, { "packages/client/liveness.mjs": 'import { skeleton } from "../desktop/renderer/loading.mjs";\nexport const collect = skeleton;\n' }, /"\.\.\/desktop\/renderer\/loading\.mjs" leaves the shared home \(packages\/desktop\/renderer\/loading\.mjs\)$/);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'export { frame as collect } from "../tui/frame.mjs";\n' }, /leaves the shared home \(packages\/tui\/frame\.mjs\)$/);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'export const collect = () => import("../../lib/core.mjs");\n' }, /leaves the shared home \(lib\/core\.mjs\)$/);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'export const collect = new URL("../desktop/main.mjs", import.meta.url);\n' }, /leaves the shared home \(packages\/desktop\/main\.mjs\)$/);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'export const collect = (name) => import(`../desktop/${name}.mjs`);\n' }, /loads a module by something other than one string literal\. Write the path as one string literal: /);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'import { gone } from "./gone.mjs";\nexport const collect = gone;\n' }, /is packages\/client\/gone\.mjs, which does not exist$/);
});

test("fixture, packages/client: an import is found wherever it stands, and a load the reader cannot judge is refused, not skipped", () => {
  const home = (source, pattern) => breaks(homeProblems, { "packages/client/liveness.mjs": source }, pattern);
  // Not at the start of a line: after another statement, in a file on one line, inside a template's ${…}.
  home('export const collect = 1; import YAML from "yaml";\n', /imports "yaml", which is not a Node builtin/);
  home('import{displayLine}from"./display-text.mjs";import{skeleton}from"../desktop/renderer/loading.mjs";export const collect=[displayLine,skeleton];', /leaves the shared home \(packages\/desktop\/renderer\/loading\.mjs\)$/);
  home('export const collect = async () => `${(await import("../desktop/main.mjs")).name}`;\n', /leaves the shared home \(packages\/desktop\/main\.mjs\)$/);
  home('export const collect = 1; export * from "../tui/frame.mjs";\n', /leaves the shared home \(packages\/tui\/frame\.mjs\)$/);
  // After a regular expression that holds a quote: where a statement starts after a condition's `)`, a `/` is not a division.
  home('if (ready) /"/.test(value); import YAML from "yaml"; export const collect = YAML;\n', /imports "yaml", which is not a Node builtin/);
  home("export const collect = (o) => { while (o) /'/.test(o); return import('../desktop/main.mjs'); };\n", /leaves the shared home \(packages\/desktop\/main\.mjs\)$/);
  home('export const collect = (o) => { for await (const k of o) /"/.test(k); return import("../desktop/main.mjs"); };\n', /leaves the shared home \(packages\/desktop\/main\.mjs\)$/);
  // Anything but one string literal: a string that only starts the path, a second argument, a template with a ${…}, a name.
  for (const load of ['import("../desktop/" + name + ".mjs")', 'import("../desktop/main.mjs", {})', 'import("./display-text.mjs", { with: { type: "json" } })', "import(`../desktop/${name}.mjs`)",
    "import(name)", 'import(/* a comment is not an argument */ name)', 'require("../desktop/" + name)', "require(name)", 'createRequire(import.meta.url)("yaml")'])
    home(`export const collect = (name) => ${load};\n`, /^packages\/client\/liveness\.mjs: loads a module by something other than one string literal\. Write the path as one string literal: /);
  // An import that is no form the reader knows, a specifier that is not the text it loads, and a regular expression that spells a load.
  const unreadable = /^packages\/client\/liveness\.mjs: has an import or an export … from that this reader cannot read\. Write it as /;
  home('import collect, = from "./display-text.mjs";\nexport { collect };\n', unreadable);
  home('import { displayLine as collect } from "\\x2e/display-text.mjs";\nexport { collect };\n', unreadable);
  home('export const collect = (name) => /import\\(name\\)/.test(name);\n', unreadable);
  assert.deepEqual(homeProblems(fixture({ "packages/client/liveness.mjs": 'export const collect = (name) => name++ / import("../desktop/main.mjs") / 2;\n' })),
    [`packages/client/liveness.mjs: / import("../ may be a regular expression or two divisions, and one reading would hide code from this reader. ${INSTEAD.ambiguous} ${WHOSE}`, 'packages/client/liveness.mjs: "../desktop/main.mjs" leaves the shared home (packages/desktop/main.mjs)']);
  // Where a `/` may be either (after a `}`, after `x++`, after `of`), both are read. One reading hiding a load the other shows is refused,
  // whichever of them is the code: here it is a regular expression and a string, and read as divisions it would be a load.
  home("export const collect = (o) => { for (const k of /'/.exec(o) ?? []) return 'import(\"../desktop/main.mjs\")'; };\n",
    /^packages\/client\/liveness\.mjs: \/'\/ may be a regular expression or two divisions, and one reading would hide code from this reader\. Put parentheses /);
  home("export const collect = (o) => { if (o) {} /'/.test(o); return 'require(\"yaml\")'; };\n", /: \/'\/ may be a regular expression or two divisions/);
  home("export const collect = (n) => n++ / 2 + '/' + 'import(\"yaml\")';\n", /: \/ 2 \+ '\/ may be a regular expression or two divisions/);
  // And what is not a load is not taken for one: spacing, a trailing comma, a template with nothing in it, a comment, a string, a property.
  for (const fine of ['import( "./display-text.mjs")', 'import (\n  "./display-text.mjs"\n)', 'import("./display-text.mjs",)', "import(`./display-text.mjs`)", 'import(/* which */ "./display-text.mjs")',
    '"import(name) and require(name) in a string"', "`import YAML from \"yaml\" in a template`", "import.meta.url", "({ import: 1, require: 2 }).import", "/[\"'`/]+|\\/\\*/.test(name) // import(name)", "name++ / 2 / name.length",
    "1 / 2 / (() => import('./display-text.mjs'))", "(name.end - name.start) / 1000 / 60", "{ if (name) /x/.test(name); for (const part of /,/g[Symbol.split](name)) return part; }",
    "{ const half = { n: 1 }.n / 2 / name.length; return function () {} / 2 / half; }", "{ if (name) {} /[\"']/.test(name); return \"nothing\"; }"])
    assert.deepEqual(allProblems(fixture({ "packages/client/liveness.mjs": `/* import x from "yaml" */\nexport const collect = (name) => ${fine};\n` })), [], fine);
  assert.deepEqual(requestsOf('const a = import( "./x.mjs" ), b = import("./y.mjs" + z), c = require("./w.cjs");'),
    [{ spec: "./x.mjs", form: "dynamic", names: [] }, { spec: null, form: "computed", names: [] }, { spec: "./w.cjs", form: "require", names: [] }]);
});

test("fixture: each refusal says what to write instead and whose rule it is, in the kernel too, and what it says to write passes", () => {
  const whose = "The rule is packages/client's: test/client-boundary.test.mjs reads the files it judges, and its header says what it can read.";
  const parentheses = "Put parentheses around what is divided, or around the regular expression, so that it reads one way.";
  const said = (path, source) => allProblems(fixture({ [path]: source }));
  // A load that is not one string literal: refused in the home and in the TUI. The kernel loads by computed paths, and may.
  for (const path of ["packages/client/liveness.mjs", "packages/tui/frame.mjs"]) {
    const name = path.endsWith("frame.mjs") ? "frame" : "collect";
    assert.deepEqual(said(path, `export const ${name} = (file) => import("./" + file);\n`),
      [`${path}: loads a module by something other than one string literal. Write the path as one string literal: import("./x.mjs"). ${whose}`]);
    assert.deepEqual(said(path, `export const ${name} = () => import("./${path.endsWith("frame.mjs") ? "main" : "display-text"}.mjs");\n`), []);
  }
  assert.deepEqual(said("lib/helper.mjs", 'export const helper = (file) => import("./" + file);\n'), []);
  // An import the reader cannot read, a path written with an escape, a regular expression that spells a load.
  const unreadable = `lib/helper.mjs: has an import or an export … from that this reader cannot read. Write it as import … from "x", export … from "x" or import("x"), with the path a plain string and no escape in it; and build a regular expression that spells import, export or require from a string: new RegExp("…"). ${whose}`;
  assert.deepEqual(said("lib/helper.mjs", "export const helper = (text) => /^import\\b/.test(text);\n"), [unreadable]);
  assert.deepEqual(said("lib/helper.mjs", 'import { join } from "node\\x3apath";\nexport const helper = join;\n'), [unreadable]);
  assert.deepEqual(said("lib/helper.mjs", 'export const helper = (text) => new RegExp("^import\\\\b").test(text);\n'), []);
  assert.deepEqual(said("lib/helper.mjs", 'import { join } from "node:path";\nexport const helper = join;\n'), []);
  // A `/` that reads two ways, where one of them hides a load: the text in question is quoted.
  assert.deepEqual(said("bin/oats.mjs", "for (const k of /'/.exec(process.argv[2]) ?? []) console.log(k, 'import(\"./x.mjs\")');\n"),
    [`bin/oats.mjs: /'/ may be a regular expression or two divisions, and one reading would hide code from this reader. ${parentheses} ${whose}`]);
  assert.deepEqual(said("bin/oats.mjs", "for (const k of (/'/).exec(process.argv[2]) ?? []) console.log(k, 'import(\"./x.mjs\")');\n"), []);
  assert.deepEqual(said("lib/helper.mjs", "export const helper = (n) => n++ / 2 + '/' + 'require(\"yaml\")';\n"),
    [`lib/helper.mjs: / 2 + '/ may be a regular expression or two divisions, and one reading would hide code from this reader. ${parentheses} ${whose}`]);
  assert.deepEqual(said("lib/helper.mjs", "export const helper = (n) => (n++) / 2 + '/' + 'require(\"yaml\")';\n"), []);
  // More readings than are checked (64: six such places in a row are read every way, seven are not): a sentence of its own, with
  // the first place. It gives no count: a place may only show in a reading that is not the reader's own.
  const halves = (count, one) => `export const helper = (n) => [${Array(count).fill(one).join(", ")}];\n`;
  assert.deepEqual(said("lib/helper.mjs", halves(6, "n++ / 2 / 1")), []);
  assert.deepEqual(said("lib/helper.mjs", halves(7, "n++ / 2 / 1")),
    [`lib/helper.mjs: has more possible readings than this reader checks: too many places where a / may start a regular expression or divide (the first is / 2 /). ${parentheses} ${whose}`]);
  assert.deepEqual(said("lib/helper.mjs", halves(7, "(n++) / 2 / 1")), []);
  assert.deepEqual(said("packages/client/liveness.mjs", halves(7, "n++ / 2 / 1").replace("helper", "collect")),
    [`packages/client/liveness.mjs: has more possible readings than this reader checks: too many places where a / may start a regular expression or divide (the first is / 2 /). ${parentheses} ${whose}`]);
  // One place in the reader's own reading, and seven more inside it when it is read the other way.
  const seven = `/[${Array(7).fill("n++ / 2 / 1").join(", ")}]/`, inside = `export function helper(n) { if (n) {} ${seven}.test(n); }\n`;
  assert.equal(tokensOf(inside).guesses.length, 1);
  assert.deepEqual(said("lib/helper.mjs", inside),
    [`lib/helper.mjs: has more possible readings than this reader checks: too many places where a / may start a regular expression or divide (the first is ${seven}). ${parentheses} ${whose}`]);
});

test("fixture, packages/client: each Electron name fails", () => {
  for (const line of ['import { app } from "electron";', "const { ipcRenderer } = require('electron/renderer');", "const inApp = !!process.versions.electron;",
    "const resources = process.resourcesPath;", 'const renderer = process.type === "renderer";'])
    assert.deepEqual(homeProblems(fixture({ "packages/client/liveness.mjs": `${line}\nexport const collect = 1;\n` })).filter((problem) => /names Electron$/.test(problem)),
      ["packages/client/liveness.mjs: names Electron"], line);
  breaks(homeProblems, { "packages/client/liveness.mjs": "export const collect = () => process.versions.electron;\n" }, /^packages\/client\/liveness\.mjs: names Electron$/);
  // After a word, which is not part of the name: return, typeof, and the rest of the words an expression follows.
  for (const code of ["return process.versions.electron;", "return process.type;", "return typeof process.versions.electron;", "return void process.resourcesPath;", "if (0) throw process.type; else return process.type;",
    "for (const k in process.versions.electron) return k;", "return new process.type();", "return process['type'];", 'return process["versions"]["electron"];', "return process?.[`versions`]?.electron;"])
    breaks(homeProblems, { "packages/client/liveness.mjs": `export function collect() { ${code} }\n` }, /^packages\/client\/liveness\.mjs: names Electron$/);
  breaks(homeProblems, { "packages/client/liveness.mjs": "export const collect = () => typeof process.versions.electron;\n" }, /^packages\/client\/liveness\.mjs: names Electron$/);
  // Where a `/` may be either, in either reading: here the reader's own takes the name into a regular expression.
  breaks(homeProblems, { "packages/client/liveness.mjs": "export const collect = (n) => n++ / process.type / 2;\n" }, /^packages\/client\/liveness\.mjs: names Electron$/);
  // However it is spaced or reached, and by the one name only Electron's `process` has.
  for (const code of ["process ?. versions ?. electron", "process\n  .type", "globalThis.process.type", "(({ resourcesPath }) => resourcesPath)(process)", 'require.resolve("electron")'])
    assert.ok(homeProblems(fixture({ "packages/client/liveness.mjs": `export const collect = () => ${code};\n` })).includes("packages/client/liveness.mjs: names Electron"), code);
  // A comment may say any of them, and other properties of `process` are not Electron's.
  assert.deepEqual(allProblems(fixture({ "packages/client/liveness.mjs": '// Never process.type, process.resourcesPath or "electron" here.\nexport const collect = () => [process.title, process.versions.node, process.env.ELECTRON_RUN_AS_NODE, { type: 1 }.type];\n' })), []);
});

test("fixture, packages/client: a library that imports own-environment.mjs fails, and so does importing the collector", () => {
  breaks(homeProblems, { "packages/client/liveness.mjs": 'import "./own-environment.mjs";\nexport const collect = 1;\n' }, /^packages\/client\/liveness\.mjs: imports own-environment\.mjs, which changes the environment of whoever imports it; only liveness-main\.mjs does$/);
  breaks(homeProblems, { "packages/client/liveness.mjs": 'import "./liveness-main.mjs";\nexport const collect = 1;\n' }, /imports liveness-main\.mjs, which is a program$/);
});

test("fixture, packages/client: a file that is not a module fails", () => {
  for (const name of ["notes.md", "package.json", "fixture.json", "probe.sh", "legacy.js", "types.d.ts"])
    breaks(homeProblems, { [`packages/client/${name}`]: "" }, new RegExp(`^packages/client/${name.replace(/\./g, "\\.")}: not a \\.mjs module; the shared home holds modules and nothing else$`));
  breaks(homeProblems, { "packages/client/test/x.mjs": "export const x = 1;\n" }, /the shared home is flat/);
  breaks(homeProblems, { "packages/client/display-text.test.mjs": 'import test from "node:test";\ntest("x", () => {});\n' }, /a test does not go in the shared home$/);
});

test("fixture, packages/tui: an import of a module that is not on the surface fails", () => {
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { HERDR_REMOVED } from "../client/terminal-contract.mjs";\nexport const frame = () => HERDR_REMOVED;\n' }, /^packages\/tui\/frame\.mjs: imports terminal-contract\.mjs, which is not on the stable surface$/);
  // The two files nobody imports, whatever is taken from them.
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import "../client/own-environment.mjs";\nexport const frame = (t) => t;\n' }, /imports own-environment\.mjs, which is never imported from outside the shared home$/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'export const frame = () => import("../client/liveness-main.mjs");\n' }, /imports liveness-main\.mjs, which is never imported/);
});

test("fixture, packages/tui: the lifecycle CLI call is not on the surface: a client stops and retires through its boundary (5a)", () => {
  breaks(tuiProblems, { "packages/client/lifecycle-cli.mjs": 'export function cliLifecycle() { return null; }\n',
    "packages/tui/frame.mjs": 'import { cliLifecycle } from "../client/lifecycle-cli.mjs";\nexport const frame = cliLifecycle;\n' },
  /^packages\/tui\/frame\.mjs: imports lifecycle-cli\.mjs, which is not on the stable surface$/);
});

test("fixture, packages/tui: the spawn preview's and apply's CLI calls are not on the surface: a client spawns through its boundaries (6b-1)", () => {
  for (const [module, name] of [["spawn-preview-cli.mjs", "cliSpawnPreview"], ["spawn-apply-cli.mjs", "cliSpawnApply"]])
    breaks(tuiProblems, { [`packages/client/${module}`]: `export function ${name}() { return null; }\n`,
      "packages/tui/frame.mjs": `import { ${name} } from "../client/${module}";\nexport const frame = ${name};\n` },
    new RegExp(`^packages/tui/frame\\.mjs: imports ${module.replace(".", "\\.")}, which is not on the stable surface$`));
});

test("fixture, packages/tui: the start's CLI call is not on the surface: a client starts through the start rule (5a-2)", () => {
  const home = { "packages/client/cli-adapter.mjs": 'export function parseEnvelope() { return null; }\nexport function cliStart() { return null; }\nexport function launchChoiceArgv() { return []; }\n',
    "packages/client/session-start.mjs": 'import { cliStart } from "./cli-adapter.mjs";\nexport function startInstance() { return cliStart; }\n' };
  assert.deepEqual(allProblems(fixture({ ...home, "packages/tui/frame.mjs": 'import { startInstance } from "../client/session-start.mjs";\nimport { parseEnvelope } from "../client/cli-adapter.mjs";\nexport const frame = () => [startInstance, parseEnvelope];\n' })), []);
  for (const name of ["cliStart", "launchChoiceArgv"])
    breaks(tuiProblems, { ...home, "packages/tui/frame.mjs": `import { ${name} } from "../client/cli-adapter.mjs";\nexport const frame = ${name};\n` },
      new RegExp(`^packages/tui/frame\\.mjs: imports ${name} from cli-adapter\\.mjs, which is not on the stable surface$`));
});

test("fixture, packages/tui: an import of an export that is not on the surface, from a module that is, fails", () => {
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { PROBE_NAME, discover } from "../client/cli-locator.mjs";\nexport const frame = () => [PROBE_NAME, discover];\n' }, /^packages\/tui\/frame\.mjs: imports discover from cli-locator\.mjs, which is not on the stable surface$/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { discover as acceptProbe } from "../client/cli-locator.mjs";\nexport const frame = acceptProbe;\n' }, /imports discover from cli-locator\.mjs/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'export { discover } from "../client/cli-locator.mjs";\nexport const frame = (t) => t;\n' }, /imports discover from cli-locator\.mjs/);
  // A form that names no export cannot be held to a list of exports: the surface is imported by name.
  for (const [form, source] of [["namespace", 'import * as locator from "../client/cli-locator.mjs";\nexport const frame = locator;\n'], ["default", 'import locator from "../client/cli-locator.mjs";\nexport const frame = locator;\n'],
    ["bare", 'import "../client/cli-locator.mjs";\nexport const frame = (t) => t;\n'], ["star", 'export * from "../client/cli-locator.mjs";\nexport const frame = (t) => t;\n'],
    ["dynamic", 'export const frame = () => import("../client/cli-locator.mjs");\n'], ["require", 'export const frame = () => require("../client/cli-locator.mjs");\n']])
    breaks(tuiProblems, { "packages/tui/frame.mjs": source }, new RegExp(`takes cli-locator\\.mjs by a ${form} import; the stable surface is imported by name`));
});

test("fixture, packages/tui: a second import on a line is read like the first", () => {
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { displayLine } from "../client/display-text.mjs"; import { discover } from "../client/cli-locator.mjs";\nexport const frame = () => [displayLine, discover];\n' },
    /^packages\/tui\/frame\.mjs: imports discover from cli-locator\.mjs, which is not on the stable surface$/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'export const frame = (t) => t; export { discover } from "../client/cli-locator.mjs"\n' }, /imports discover from cli-locator\.mjs/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'export const frame = (name) => import("../client/" + name);\n' }, /loads a module by something other than one string literal\. Write the path as one string literal: /);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'export const frame = () => import("../client/display-text.mjs", {});\n' }, /loads a module by something other than one string literal\. Write the path as one string literal: /);
  // Named, on one line, with what the surface lists: nothing to say.
  assert.deepEqual(allProblems(fixture({ "packages/tui/frame.mjs": 'import{displayLine}from"../client/display-text.mjs";import{PROBE_NAME as name}from"../client/cli-locator.mjs";export const frame=()=>[displayLine,name];' })), []);
});

test("fixture, packages/tui: anything else it imports fails (a package, the Desktop, the kernel, a computed path)", () => {
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import blessed from "blessed";\nexport const frame = blessed;\n' }, /^packages\/tui\/frame\.mjs: imports "blessed", which is not a Node builtin/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { skeleton } from "../desktop/renderer/loading.mjs";\nexport const frame = skeleton;\n' }, /leaves packages\/tui for packages\/desktop\/renderer\/loading\.mjs, which is not the shared home$/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { core } from "../../lib/core.mjs";\nexport const frame = core;\n' }, /leaves packages\/tui for lib\/core\.mjs/);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'export const frame = (name) => import(`../client/${name}.mjs`);\n' }, /loads a module by something other than one string literal\. Write the path as one string literal: /);
  breaks(tuiProblems, { "packages/tui/frame.mjs": 'import { gone } from "./gone.mjs";\nexport const frame = gone;\n' }, /is packages\/tui\/gone\.mjs, which does not exist$/);
});

test("fixture, lib/ and bin/: an import of the home or of the Desktop fails", () => {
  breaks(kernelProblems, { "lib/helper.mjs": 'import { displayLine } from "../packages/client/display-text.mjs";\nexport const helper = displayLine;\n' }, /^lib\/helper\.mjs: "\.\.\/packages\/client\/display-text\.mjs" is packages\/client\/display-text\.mjs: the kernel imports nothing from packages\/client$/);
  breaks(kernelProblems, { "lib/helper.mjs": 'export const helper = () => import("../packages/desktop/server-compat.mjs");\n' }, /the kernel imports nothing from packages\/desktop$/);
  breaks(kernelProblems, { "bin/oats.mjs": 'import { core } from "../lib/core.mjs";\nexport { displayLine } from "../packages/client/display-text.mjs";\nconsole.log(core);\n' }, /^bin\/oats\.mjs: .* the kernel imports nothing from packages\/client$/);
  breaks(kernelProblems, { "lib/sub/deep.mjs": 'const collector = new URL("../../packages/client/liveness-main.mjs", import.meta.url);\nexport default collector;\n' }, /^lib\/sub\/deep\.mjs: .* the kernel imports nothing from packages\/client$/);
  breaks(kernelProblems, { "lib/helper.mjs": 'export const helper = 1; import { displayLine } from "../packages/client/display-text.mjs";\n' }, /^lib\/helper\.mjs: "\.\.\/packages\/client\/display-text\.mjs" is packages\/client\/display-text\.mjs/);
  // A computed load still spells the directory it leads into.
  breaks(kernelProblems, { "bin/oats.mjs": 'const name = process.argv[2];\nawait import(new URL(`../packages/client/${name}.mjs`, import.meta.url));\n' }, /^bin\/oats\.mjs: a relative path into packages\/client/);
  breaks(kernelProblems, { "lib/helper.mjs": 'import { join } from "node:path";\nexport const helper = (root) => import(join(root, "../packages/desktop", "main.mjs"));\n' }, /^lib\/helper\.mjs: a relative path into packages\/desktop/);
});

test("fixture: a surface entry the home does not have fails", () => {
  const tree = fixture(), surface = { "display-text.mjs": ["displayLine", "cleanLine"], "cli-locator.mjs": ["PROBE_NAME"] };
  assert.deepEqual(surfaceProblems(tree, surface), []);
  assert.deepEqual(surfaceProblems(tree, { ...surface, "gone.mjs": ["x"] }), ["gone.mjs: on the stable surface, and packages/client/gone.mjs does not exist"]);
  assert.deepEqual(surfaceProblems(tree, { ...surface, "cli-locator.mjs": ["PROBE_NAME", "acceptProbe"] }), ["cli-locator.mjs: acceptProbe is on the stable surface, and the module does not export it"]);
  assert.deepEqual(surfaceProblems(tree, { ...surface, "own-environment.mjs": [] }), ["own-environment.mjs: on the stable surface, and it is never importable"]);
  assert.deepEqual(surfaceProblems(tree, { ...surface, "liveness-main.mjs": [] }), ["liveness-main.mjs: on the stable surface, and it is never importable"]);
  // The reader of exports sees every form the home uses: a function, a class, one `const` that declares two names, a list.
  assert.deepEqual([...exportsOf('export async function a() {}\nexport class B {}\nexport const c = (x, y = [1, 2]) => ({ x, y }), d = "e, f = 1";\nconst g = 1, h = 2;\nexport { g, h as i };\nexport const j = 1\nconst k = 2;\nexport const { l, m: n } = g, o = `${h}`; export function* p() {}\n')].sort(),
    ["B", "a", "c", "d", "g", "i", "j", "l", "n", "o", "p"]);
  // A TUI held to a surface is held to that surface: the export the fixture's home has is refused when the list does not name it.
  assert.deepEqual(tuiProblems(tree, { "display-text.mjs": ["displayLine"], "cli-locator.mjs": ["PROBE_NAME"] }), ["packages/tui/main.mjs: imports cleanLine from display-text.mjs, which is not on the stable surface"]);
});
