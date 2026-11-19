// The shape of the terminal client (packages/tui, `oats tui`; awebai/oats#855 section 3.2): where
// the kernel loads it, which of its modules does what, and what of it is packed.
// What may cross into it (which modules and exports of packages/client it may import, and that it
// imports nothing else from outside itself) is test/client-boundary.test.mjs's, not this file's.
// Every test here READS files and never imports them: on a checkout with every dependency
// installed an import would simply succeed, and an import cannot see what a file names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
function filesUnder(dir, keep = (name) => name.endsWith(".mjs")) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, keep));
    else if (entry.isFile() && keep(entry.name)) out.push(path);
  }
  return out.sort();
}
/** A source without its comments: what the file does, not what it says about itself. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");
/** Every module a source imports or re-exports statically, as written. */
function staticImports(source) {
  const found = [];
  for (const match of code(source).matchAll(/(?:^|[\n;])\s*(?:import|export)\b\s*(?:[^"'`;]*?\bfrom\s*)?["']([^"'\n]+)["']/g)) found.push(match[1]);
  return found;
}
const TUI_SOURCES = [...filesUnder("packages/tui/bin"), ...filesUnder("packages/tui/lib")];
const TUI_FILES = [...TUI_SOURCES, ...filesUnder("packages/tui/test")];
const CLIENT = "packages/tui/lib/client.mjs";

test("the reading itself works: it finds the imports of a file it is shown, and not the ones in its comments", () => {
  const sample = `// import x from "commented"\n/* import y from "blocked" */\nimport a from "./a.mjs";\nimport { b,\n  c } from "../b.mjs";\nexport { d } from "node:fs";\nexport * from "./e.mjs";\nimport "./side.mjs";\nconst url = "https://example.com/not-an-import";\nexport const f = 1;\n`;
  assert.deepEqual(staticImports(sample), ["./a.mjs", "../b.mjs", "node:fs", "./e.mjs", "./side.mjs"]);
  assert.equal(TUI_SOURCES.includes("packages/tui/bin/tui.mjs") && TUI_SOURCES.includes(CLIENT) && TUI_SOURCES.length >= 10, true);
});

test("bin/oats.mjs holds exactly one import of packages/tui, and it is dynamic, at dispatch", () => {
  assert.deepEqual(filesUnder("bin", () => true), ["bin/oats.mjs"], "the CLI is one file: a second one would need this test too");
  const source = code(read("bin/oats.mjs"));
  const naming = source.split("\n").filter((line) => line.includes("packages/tui"));
  assert.equal(naming.length, 1, `one line of code names packages/tui, found: ${naming.join(" | ")}`);
  assert.match(naming[0], /^\s*await import\(new URL\("\.\.\/packages\/tui\/bin\/tui\.mjs", import\.meta\.url\)\);\s*$/);
  assert.deepEqual(staticImports(read("bin/oats.mjs")).filter((name) => /tui/.test(name)), [], "and no static import does");
});

test("no file under lib/ names packages/tui: the kernel does not know its client", () => {
  const naming = filesUnder("lib").filter((path) => /packages\/tui|packages\\tui/.test(read(path)));
  assert.deepEqual(naming, []);
});

test("only packages/tui/lib/client.mjs imports from the shared client home", () => {
  for (const path of TUI_FILES) {
    const shared = staticImports(read(path)).filter((name) => /(^|\/)client\//.test(name) || /packages\/client/.test(name));
    assert.equal(shared.length > 0, path === CLIENT, `${path} imports ${shared.join(", ") || "nothing"} from the shared home`);
  }
  for (const path of TUI_FILES.filter((p) => p !== CLIENT)) assert.doesNotMatch(code(read(path)), /packages\/client|\.\.\/client\//, `${path} names no reader path`);
});

/** What packages/tui/lib/client.mjs takes from the shared home, module by module, in the order the
 *  file names them. A name added here is a name the TUI now rests on: test/client-boundary.test.mjs
 *  holds each to the home's stable surface, and this list says which of that surface is in use. */
const TAKEN = Object.freeze({
  "client-terms.mjs": ["clientTerms"],
  "display-text.mjs": ["displayLine", "DETAIL_WITHHELD"],
  "cli-locator.mjs": ["parseProbeStdout", "acceptProbe", "cliRecord"],
  // What a void cycle's read is answered with (lib/read.mjs cycleRead): the shared CLI read, whose exec refuses.
  "deployment-read-cli.mjs": ["cliDeploymentRead"],
  // awebai/oats#1390: this computer's deployments list, through the kernel (the switcher's rows, the add on opening, Remove).
  "deployment-list-cli.mjs": ["cliDeploymentList"],
  "deployment-list.mjs": ["deploymentsListSupported"],
  "cli-adapter.mjs": ["cliRemoteRoster"],
  // Pinned instances (feature instance-pin): the pin key runs the kernel's verb through the shared home, which reads its answer.
  "instance-pin.mjs": ["pinInstance"],
  "deployment-observer.mjs": ["createDeploymentObserver", "mapBounded", "MAX_DEPLOYMENT_OBSERVATIONS"],
  // #1630: the background reads through one warm `oats reader --stdio`, whose fallback is the shared cliDeploymentRead.
  "warm-reader.mjs": ["createWarmReader"],
  "refresh-loop.mjs": ["createRefreshLoop"],
  "deployment-panel.mjs": ["rosterRows", "kernelLiveness", "livenessInput", "livenessAnswers", "panelInstances", "pendingEntry", "failedEntry", "observedEntry"],
  "panel-views.mjs": ["panelData", "cliReadsRemotes", "workspaceChoices", "viewModel", "listedViews", "deployments"],
  // #482 in the switcher: a listed deployment's identity, read before it is opened, matched in by listedViews.
  "deployment-identity.mjs": ["cliDeploymentIdentity", "identityReadable", "identityTimedOut"],
  // The leader's Up/Down between the list of workspaces' rows (PR 3): the shared pure step.
  "workspace-step.mjs": ["workspaceStep"],
  "remote-roster.mjs": ["remoteRosterState"],
  "remote-identity-memory.mjs": ["observeIdentities", "identityMemory"],
  "workspace-choices.mjs": ["workspaceChoiceRows", "choiceMatches", "UNMATCHED_SECTION"],
  "deployment-label.mjs": ["shortPath", "deploymentLabel", "machineLabels"],
  // #1579: the Background section, placed and drawn by the shared home (lib/model.mjs build).
  "instance-tree.mjs": ["instanceId", "instanceVisibleInTree", "waitingRollup", "collapseKey", "filterInstanceTree", "hasInstanceChildren", "heldHome", "instanceSiblings", "backgroundPlacement", "BACKGROUND_FEATURE", "PIN_FEATURE"],
  "roster-sections.mjs": ["rosterSections", "deploymentState", "rowStale", "primaryDeployment", "isMultiDeployment", "rosterSectionKey", "sidebarSections"],
  "instance-presentation.mjs": ["runtimeState", "runtimeCounts", "originLead", "siblingText", "instanceColor"],
  // 0.68.1: an instance row's name as words (lib/model.mjs listRow), the Desktop's sidebar label; the real name everywhere else.
  "instance-display-name.mjs": ["instanceDisplayName"],
  "waiting-on-you.mjs": ["waitingClaim", "waitingLabel", "waitedText", "waitingClock", "waitingBelowText"],
  "instance-acts.mjs": ["instanceActs", "openAct"],
  "remote-address.mjs": ["rowReason"],
  "session-attach.mjs": ["sessionAttachArgv", "prepareRemoteTerm", "detachKeySupported", "hostDetachKeySupported", "preflightFailure", "DETACH_KEY_FEATURE", "PREFIX_SCROLL_FEATURE", "localScrollKeys", "hostScrollKeys"],
  "attach-exit.mjs": ["attachExit"],
  "kernel-lines.mjs": ["kernelLines"],
  "instance-lifecycle.mjs": ["createLifecycleBoundary"],
  "lifecycle-confirmation.mjs": ["createLifecycleConfirmation"],
  "retire-in-flight.mjs": ["createRetiresInFlight", "retiringRows"],
  "session-start.mjs": ["startGate", "startInstance"],
  "launch-prompt-outcome.mjs": ["retainedStartMessage", "launchFlagIgnored", "flagIgnoredNotice"],
  "kernel-environment.mjs": ["INSTANCE_VARIABLES"],
  // #1559: lost sessions resumed when the TUI opens, and when a read shows one lost (lib/main.mjs); the TUI
  // says nothing of a sweep: the shared reader (session-resume.mjs) is the trigger's, and the TUI takes only its readings.
  "session-resume-cli.mjs": ["runResumeSweep"],
  "session-resume-trigger.mjs": ["createResumeTrigger", "localDeploymentIds"],
  "workspace-admission.mjs": ["validateWorkspace"],
  "soul-catalog.mjs": ["createSoulCatalog", "soulCatalogKey"],
  "soul-rows.mjs": ["soulRows"],
  "soul-facts.mjs": ["soulFacts", "spawnRefusal", "soulMatches"],
  // The spawn (Spec 6-spawn): the shared preview, apply boundary and transaction, and their words.
  "spawn-preview.mjs": ["createSpawnPreview"],
  "spawn-preview-contract.mjs": ["defaultSpawnChoices"],
  "spawn-apply.mjs": ["createSpawnApplyBoundary"],
  "spawn-transaction.mjs": ["createSpawnTransaction"],
  "spawn-messages.mjs": ["spawnProblem", "outcomeWords", "SPAWN_NEXT", "soulCatalogFailure"],
  // #1301: a failed catalog read's one sentence; the Capabilities view says it with the noun "capabilities"
  // (the Souls view keeps soulCatalogFailure, the same sentence with "souls").
  "catalog-messages.mjs": ["catalogFailure"],
  "spawn-preview-facts.mjs": ["previewFacts"],
  // #1276: the house fuzzy matcher, the Desktop's palette's own (the TUI's palette and switcher filter with it).
  // #1276 also put the soul filter (soulMatches) and a failed catalog read's sentence (soulCatalogFailure) on the soul-facts.mjs and spawn-messages.mjs lines above.
  "subsequence-score.mjs": ["subsequenceScore"],
  // Spec 7: the Capabilities view. The shared table (one per run, as the soul catalog), its sections, groups,
  // sources, search, layer labels and "Used by", and a capability's facts in the Desktop's words. rosterAgentName
  // is a package soul's name in the roster (`<package>--<soul>`), one of the names lib/model.mjs soulNames matches.
  "capability-catalog.mjs": ["createCapabilityCatalog", "capabilityCatalogKey"],
  "capability-rows.mjs": ["memberNames", "capabilitySource", "groupCapabilities", "hostKeyOf", "capabilitySections", "matchCapabilities", "soulsComposition", "rosterAgentName", "layerLabel", "capabilityUsers"],
  "capability-facts.mjs": ["capabilityFacts", "CAPABILITY_COPY"],
  // The keys the TUI shares with the Desktop (#1395): lib/actions.mjs builds its leader's table and its plain keys'
  // defaults from them, lib/config.mjs its default leader, and packages/tui/test/keymap.test.mjs pins all three to them.
  // PALETTE_KEYS: the palette's own keys, next and previous group (lib/actions.mjs paletteKeys).
  "keymap.mjs": ["CHORDS", "CHORD_FAMILY_LABELS", "DEFAULT_CHORD_FAMILY", "LEADER_TABLE", "PALETTE_KEYS", "PLAIN_KEYS", "chordKeyOf", "doesLabel", "leaderKey", "plainKeys"],
  "keys-file.mjs": ["KEYS_LIMIT", "chordFamilyFrom", "chordFamilyNote", "keysPath"],
});
/** Every clause of a source that takes names from a module of the shared home: [[module, names], …].
 *  A name taken under another name is read as the name the home gives it. */
function takenFromHome(source) {
  const found = [];
  for (const match of code(source).matchAll(/(?:^|[\n;])\s*(?:import|export)\s*\{([^}]*)\}\s*from\s*["']\.\.\/\.\.\/client\/([^"'\n]+)["']/g)) {
    found.push([match[2], match[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)]);
  }
  return found;
}

test("what packages/tui/lib/client.mjs takes from the shared home is this list, name by name, and the liveness collector is the one program of the home it names without importing it", () => {
  const sample = `// export { no } from "../../client/commented.mjs";\nimport { a } from "../../client/one.mjs";\nexport { b,\n  c as d } from "../../client/two.mjs";\nexport { e } from "./own.mjs";\n`;
  assert.deepEqual(takenFromHome(sample), [["one.mjs", ["a"]], ["two.mjs", ["b", "c"]]], "the reading itself works");
  const source = read(CLIENT);
  assert.deepEqual(takenFromHome(source), Object.entries(TAKEN));
  // Nothing of the home comes in by another form (a default, a namespace, a bare or a star clause).
  assert.deepEqual(staticImports(source).filter((name) => /client\//.test(name)), Object.keys(TAKEN).map((module) => `../../client/${module}`));
  // The one path of the home that is no import: the collector, started as a child.
  assert.deepEqual([...code(source).matchAll(/new URL\("([^"]+)", import\.meta\.url\)/g)].map((match) => match[1]), ["../../client/liveness-main.mjs"]);
  // The names PR 3 added for other machines and the switcher (awebai/oats#855; the spec's "Contracts").
  const added = {
    "cli-adapter.mjs": ["cliRemoteRoster"], "panel-views.mjs": ["cliReadsRemotes", "workspaceChoices", "viewModel"], "remote-roster.mjs": ["remoteRosterState"],
    "remote-identity-memory.mjs": ["observeIdentities", "identityMemory"], "workspace-choices.mjs": ["workspaceChoiceRows", "choiceMatches", "UNMATCHED_SECTION"],
    "deployment-label.mjs": ["shortPath"], "deployment-observer.mjs": ["mapBounded", "MAX_DEPLOYMENT_OBSERVATIONS"], "roster-sections.mjs": ["isMultiDeployment"],
  };
  for (const [module, names] of Object.entries(added)) for (const name of names) assert.ok(TAKEN[module]?.includes(name), `${name} of ${module}`);
  // Beside what it hands on, the seam makes two values of its own: the client's terms and the collector's path.
  const exported = [...code(source).matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  assert.deepEqual(exported, ["TERMS", "COLLECTOR"]);
});

test("the shared functions that make a machine's panel are never named in packages/tui/lib: the panels come from panelData, and remotePanelEntries is imported nowhere in the package", () => {
  // remotePanel needs a time the TUI does not choose; remoteWorkspace, remoteAgents and
  // unavailableGroups are steps of rules the shared home applies itself (remote-roster.mjs,
  // panel-views.mjs): a call of one here would be a second rule. Read with the comments, so the
  // names stand nowhere in a shipped module.
  const never = ["remotePanel", "remoteWorkspace", "remoteAgents", "unavailableGroups", "remotePanelEntries"];
  for (const path of TUI_SOURCES) for (const name of never) assert.doesNotMatch(read(path), new RegExp(`\\b${name}\\b`), `${path} names ${name}`);
  for (const name of never) assert.equal(Object.values(TAKEN).flat().includes(name), false, name);
  // The tests may say the name (to say that it is not used); none imports it.
  for (const path of TUI_FILES) {
    for (const clause of code(read(path)).matchAll(/\bimport\s*\{([^}]*)\}/g)) assert.doesNotMatch(clause[1], /\bremotePanelEntries\b/, `${path} imports remotePanelEntries`);
  }
});

test("who made a row's text is said by the shared home: no module of packages/tui/lib holds a speaker's name or the words that go before a text as a string of its own, and the row's mark is read once, as what originLead is handed", () => {
  // The marks a row's text can carry and the words a client puts before the text
  // (packages/client/instance-presentation.mjs `originLead`; the two that name the client are
  // given here without its name). A module that held one could name a speaker by itself, and
  // the two clients would then say who spoke in two ways.
  const speakers = ["kernel", "terminal-probe", "roster-read"];
  const leads = ["OATS says:", "terminal check says:", "read of other machines says:"];
  const lib = filesUnder("packages/tui/lib");
  for (const path of lib) {
    const source = code(read(path));
    for (const name of speakers) assert.doesNotMatch(source, new RegExp(`["'\`]${name}["'\`]`), `${path} holds the speaker "${name}" as a string`);
    for (const words of leads) assert.equal(source.includes(words), false, `${path} holds the words "${words}"`);
  }
  // The mark is a value passed on, never one the TUI looks into: it stands in one place, handed to
  // the model's `spoken`, which hands it to originLead and does nothing else with it (the detail
  // and the line after an open say a text from outside the same way). A reason's `origin` is asked
  // only whether it is there, or handed on to `spoken` beside that answer.
  const marks = lib.flatMap((path) => [...code(read(path)).matchAll(/[^\n]*\bruntimeErrorOrigin\b[^\n]*/g)].map((match) => [path, match[0].trim()]));
  assert.deepEqual(marks.map(([path]) => path), ["packages/tui/lib/model.mjs"], "the mark is read in the model, once");
  assert.match(marks[0][1], /\bspoken\(row\.runtimeError, row\.runtimeErrorOrigin, vouched\)/);
  assert.equal(marks[0][1].match(/\bruntimeErrorOrigin\b/g).length, 1);
  const saying = /\nfunction spoken\(value, origin, vouched\) \{\n([\s\S]*?)\n\}/.exec(code(read("packages/tui/lib/model.mjs")));
  assert.ok(saying, "lib/model.mjs has spoken(value, origin, vouched)");
  assert.deepEqual(saying[1].match(/\borigin\b[^\n]{0,8}/g), ["origin, TERMS)"], "spoken hands its mark to originLead and to nothing else");
  assert.match(saying[1], /\boriginLead\(origin, TERMS\)/);
  const handedOn = "spoken(reason.sentence, reason.origin, reason.origin === undefined)";
  for (const path of lib) {
    const source = code(read(path));
    for (const use of source.replaceAll(handedOn, "").matchAll(/\.origin\b(.{0,16})/g)) assert.match(use[1], /^ === undefined\b/, `${path} looks into a reason's origin: .origin${use[1]}`);
  }
});

test("lib/read.mjs gives the shared observer no reader of its own: the one observer of the package reads through the one shared warm reader, whose fallback, like a void cycle's read, is the shared cliDeploymentRead over this client's exec and environment, so a failed read has the same reasons as in the Desktop", () => {
  const READ = "packages/tui/lib/read.mjs", source = code(read(READ));
  // The readers are the shared home's own functions, through the seam, under their own names.
  assert.ok(TAKEN["warm-reader.mjs"].includes("createWarmReader") && TAKEN["deployment-observer.mjs"].includes("createDeploymentObserver"));
  const fromSeam = source.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/client\.mjs"/);
  assert.ok(fromSeam, "read.mjs names what it takes from the seam");
  const names = fromSeam[1].split(",").map((part) => part.trim());
  for (const name of ["createWarmReader", "createDeploymentObserver"]) assert.ok(names.includes(name), `${name}, under its own name`);
  // One observer and one warm reader in the whole client, both made in read.mjs.
  for (const maker of ["createDeploymentObserver", "createWarmReader"]) {
    const makers = TUI_SOURCES.filter((path) => path !== CLIENT && new RegExp(`\\b${maker}\\b`).test(code(read(path))));
    assert.deepEqual(makers, [READ], maker);
    assert.equal(source.match(new RegExp(`\\b${maker}\\s*\\(`, "g"))?.length, 1, maker);
  }
  // The warm reader starts its child as every kernel child of the TUI: `node <bin> …`, detached, the module's options kept.
  assert.match(source, /\bcreateWarmReader\(\{\s*spawn:\s*\(file,\s*args,\s*options\)\s*=>\s*spawn\(process\.execPath,\s*\[file,\s*\.\.\.args\],\s*\{\s*\.\.\.options,\s*detached:\s*true\s*\}\)\s*\}\)/);
  // The observer's `read` is cycleRead, and cycleRead hands each read to the warm reader with this client's exec (bound to
  // the read's cycle) and environment, or, for a cycle made void, to the shared CLI read with the same: nothing else is decided about it.
  const made = source.slice(source.search(/\bcreateDeploymentObserver\s*\(/));
  const options = made.slice(0, made.indexOf("});") + 3);
  assert.match(options, /\bread:\s*cycleRead,?\s*\}\);$/);
  const cycleRead = source.slice(source.indexOf("function cycleRead("), source.indexOf("\n  }\n", source.indexOf("function cycleRead(")));
  assert.match(cycleRead, /\bwarm\.read\(kernel,\s*options,\s*\{\s*exec:\s*own,\s*env\s*\}\)/);
  assert.match(cycleRead, /\bconst own = \(bin, argv, opts, callback\) => \{[^}]*\breturn exec\(bin, argv, opts, callback\);\s*\};/, "own is this client's exec, refused once the read's cycle is void");
  assert.match(cycleRead, /\bcliDeploymentRead\(kernel,\s*options,\s*\{\s*exec:\s*own,\s*env\s*\}\)/);
  // The shared CLI reader is named nowhere else in the package, nor wrapped, nor given another name.
  for (const path of TUI_SOURCES.filter((p) => p !== CLIENT && p !== READ)) assert.doesNotMatch(code(read(path)), /\bcliDeploymentRead\b/, path);
  assert.equal(source.match(/\bcliDeploymentRead\b/g).length, 2, "named twice in read.mjs: where it is imported and in cycleRead");
});

test("no file in packages/tui uses a dynamic import", () => {
  for (const path of TUI_FILES) assert.doesNotMatch(code(read(path)), /\bimport\s*\(/, path);
});

test("every module under packages/tui/lib is reached by static imports from bin/tui.mjs, so loading the entry proves the package holds them all", () => {
  const reached = new Set();
  const visit = (path) => {
    if (reached.has(path)) return;
    reached.add(path);
    for (const name of staticImports(read(path)).filter((spec) => !spec.startsWith("node:"))) {
      const target = relative(ROOT, resolve(dirname(join(ROOT, path)), name));
      if (target.startsWith("packages/tui/")) visit(target);
    }
  };
  visit("packages/tui/bin/tui.mjs");
  assert.deepEqual(filesUnder("packages/tui/lib").filter((path) => !reached.has(path)), []);
  assert.deepEqual(filesUnder("packages/tui/lib", () => true), filesUnder("packages/tui/lib"), "and lib/ holds nothing but .mjs modules");
});

test("the entry loads its whole graph before it looks at the terminal: its only statement after the imports is the call of main", () => {
  const source = code(read("packages/tui/bin/tui.mjs")).trim().split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(source, [
    'import { main } from "../lib/main.mjs";',
    "process.exitCode = await main({ argv: process.argv.slice(2), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env });",
  ]);
});

test("only term/screen.mjs and term/tty.mjs can produce an ESC byte: no other shipped module writes one in a string", () => {
  const writers = ["packages/tui/lib/term/screen.mjs", "packages/tui/lib/term/tty.mjs"];
  const escape = /\\x1b|\\u001b|\\u\{0*1b\}|\\033|\\e\[|\x1b|fromCharCode\(\s*(?:27|0x1b)\s*\)/i;
  for (const path of TUI_SOURCES) assert.equal(escape.test(read(path)), writers.includes(path), path);
});

test("the views are pure: they import only the TUI's own text, style and action modules, and name no IO, clock or process", () => {
  const views = filesUnder("packages/tui/lib/views");
  assert.equal(views.length >= 2, true);
  // The views and the window they share; the switcher of workspaces, the confirmation of an act and the palette are held to the rule like the rest.
  assert.deepEqual(views.map((path) => path.slice("packages/tui/lib/views/".length)), ["act.mjs", "capabilities.mjs", "detail.mjs", "frame.mjs", "help.mjs", "instances.mjs", "palette.mjs", "scroll.mjs", "souls.mjs", "spawn.mjs", "split.mjs", "switcher.mjs", "workspaces.mjs"]);
  for (const path of views) {
    for (const name of staticImports(read(path))) assert.match(name, /^(\.\.\/actions\.mjs|\.\.\/term\/(text|style|width)\.mjs|\.\/[a-z-]+\.mjs)$/, `${path} imports ${name}`);
    assert.doesNotMatch(code(read(path)), /\b(process|Date|setTimeout|setInterval|performance|console|fetch|require)\b/, path);
  }
});

test("lib/read.mjs starts the reads and the changes and lib/panel.mjs the private tmux server, and no other module starts a process; lib/read.mjs, lib/panel.mjs and lib/config.mjs alone read the file system, and only lib/read.mjs and lib/panel.mjs write a file in the run (a change's output, the panel's owner mark, its viewer's two files and the write end of its FIFO, all in the run's private directory, which each removes) and lib/config.mjs at its start, to move tui.json from where it was before", () => {
  const builtins = (path) => staticImports(read(path)).filter((name) => name.startsWith("node:"));
  const users = (name) => TUI_SOURCES.filter((path) => builtins(path).includes(name));
  assert.deepEqual(users("node:child_process"), ["packages/tui/lib/panel.mjs", "packages/tui/lib/read.mjs"]);
  assert.deepEqual(users("node:fs"), ["packages/tui/lib/config.mjs", "packages/tui/lib/panel.mjs", "packages/tui/lib/read.mjs"]);
  assert.deepEqual(users("node:fs/promises"), []);
  // What the two take from node:fs is named, and each name only reads. No folder is listed: this
  // computer's deployments are the kernel's list (awebai/oats#1390), read through the kernel.
  const READS = ["closeSync", "fstatSync", "lstatSync", "openSync", "readSync", "realpathSync", "statSync"];
  // A change (a stop or retire apply, a start) writes its output to two files of the run's own
  // private directory, never to a pipe (Spec 5): lib/read.mjs makes that directory, and removes
  // each file and the directory. Nothing else of node:fs can change a file.
  const CHANGE_FILES = ["mkdtempSync", "rmdirSync", "unlinkSync"];
  // The panel (lib/panel.mjs) writes owner.json and makes its viewer's two files in the run's
  // directory (which lib/read.mjs makes), holds the write end of the FIFO its keeper watches there
  // (made by `mkfifo`; `constants` for the open's flags), lists that directory and the OS temp dir
  // for its sweep, and removes its own files and a dead run's directory. It makes no directory.
  const PANEL_FILES = ["constants", "readdirSync", "rmdirSync", "unlinkSync", "writeSync"];
  // lib/config.mjs moves tui.json from where earlier versions read it (awebai/oats#1390 §3): the
  // old file's bytes written to a file of its own, made new (0600) in the new file's directory
  // (made 0700) and synced, then linked into place, never over a file; the old file renamed beside
  // itself; its own file, and a copy the rename failed after, removed.
  const CONFIG_FILES = ["fsyncSync", "linkSync", "mkdirSync", "renameSync", "unlinkSync", "writeSync"];
  for (const path of users("node:fs")) {
    const taken = code(read(path)).match(/import\s*\{([^}]*)\}\s*from\s*"node:fs"/);
    assert.ok(taken, `${path} names what it takes from node:fs`);
    for (const name of taken[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      assert.ok(READS.includes(name) || (path === "packages/tui/lib/read.mjs" && CHANGE_FILES.includes(name)) || (path === "packages/tui/lib/panel.mjs" && PANEL_FILES.includes(name)) || (path === "packages/tui/lib/config.mjs" && CONFIG_FILES.includes(name)), `${path} takes ${name} from node:fs`);
    }
  }
  // A file is opened for reading only, but for the one a change writes to: made new for the child
  // alone ("wx", 0600), in lib/read.mjs, once; and the panel's two, made new the same way: its
  // owner mark, and each of its viewer's files. And the panel's FIFO, in PANEL_FS.hold alone:
  // opened to read without waiting, checked to be a FIFO, and opened to write; it is never written.
  // And the capture's file, in PANEL_FS.whole alone: read only, no link followed, without waiting
  // (a FIFO put there must not hold the TUI), and read only once fstat says it is a regular file
  // within its bound.
  const writing = [];
  const panelCode = code(read("packages/tui/lib/panel.mjs"));
  const captureOpen = "path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK";
  assert.equal(panelCode.split(`openSync(${captureOpen})`).length - 1, 1, "the capture file's one open");
  assert.match(panelCode, /whole: \(path, max\) => \{\s*const fd = openSync\(path, FS\.O_RDONLY \| FS\.O_NOFOLLOW \| FS\.O_NONBLOCK\);\s*try \{\s*const stat = fstatSync\(fd\);\s*if \(!stat\.isFile\(\) \|\| stat\.size > max\) return null;/, "a regular file within its bound, checked on the open descriptor before it is read");
  const fifoOpens = [...code(read("packages/tui/lib/panel.mjs")).matchAll(/\bopenSync\((path, FS\.O_RDONLY \| FS\.O_NONBLOCK|path, FS\.O_WRONLY)\)/g)].map((call) => call[1]);
  assert.deepEqual(fifoOpens, ["path, FS.O_RDONLY | FS.O_NONBLOCK", "path, FS.O_WRONLY"], "the FIFO's two opens");
  assert.match(code(read("packages/tui/lib/panel.mjs")), /if \(!fstatSync\(reader\)\.isFIFO\(\)\) throw/, "the write end of a FIFO only");
  for (const path of TUI_SOURCES) for (const call of code(read(path)).matchAll(/\bopenSync\(([^)]*)\)/g)) {
    if (/^[^,]+,\s*"r"$/.test(call[1])) continue;
    if (path === "packages/tui/lib/panel.mjs" && (fifoOpens.includes(call[1]) || call[1] === captureOpen)) continue;
    assert.match(call[1], /^path, "wx", 0o600$/, `${path} opens ${call[1]}`);
    writing.push(path);
  }
  assert.deepEqual(writing, ["packages/tui/lib/config.mjs", "packages/tui/lib/panel.mjs", "packages/tui/lib/panel.mjs", "packages/tui/lib/read.mjs"], "the moved tui.json, a change's output, and the panel's owner mark and viewer files, each made new");
  const configCode = code(read("packages/tui/lib/config.mjs"));
  assert.deepEqual(configCode.split("mkdirSync(").length - 1, 1, "one mkdirSync");
  assert.ok(configCode.includes("mkdirSync(dirname(to), { recursive: true, mode: 0o700 })"), "the moved file's directories, made 0700");
  assert.deepEqual([...configCode.matchAll(/\blinkSync\(([^)]*)\)/g)].map((call) => call[1]), ["own, to"], "linked into place from its own file: never over one");
  assert.doesNotMatch(code(read("packages/tui/lib/panel.mjs")), /mkdtempSync|mkdirSync|tmux-\d|"oats-tmux/, "the panel makes no directory and names no socket but its own");
  assert.match(code(read("packages/tui/lib/read.mjs")), /mkdtempSync\(join\(tmpdir\(\), "oats-tui-"\)\)/, "in a private directory of its own under the OS temp dir");
  // No folder is opened to be listed anywhere in the client.
  for (const path of TUI_SOURCES) assert.doesNotMatch(code(read(path)), /\bopendirSync\b/, `${path} opens a folder to list it`);
  // Every builtin the client loads, by module: a new one is a decision, and shows here.
  assert.deepEqual([...new Set(TUI_SOURCES.flatMap(builtins))].sort(), ["node:child_process", "node:fs", "node:os", "node:path", "node:url"]);
});

test("packages/tui is private, has no dependency of any kind, no bin and no script, and the root manifest ships its bin, lib, README and manifest but not its tests", () => {
  const manifest = JSON.parse(read("packages/tui/package.json"));
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bin", "scripts", "workspaces"]) assert.equal(key in manifest, false, key);
  const files = JSON.parse(read("package.json")).files;
  for (const entry of ["packages/tui/bin/", "packages/tui/lib/", "packages/tui/README.md", "packages/tui/package.json", "packages/client/"]) assert.equal(files.includes(entry), true, entry);
  assert.deepEqual(files.filter((entry) => /packages\/(tui|client)/.test(entry)).sort(), ["packages/client/", "packages/tui/README.md", "packages/tui/bin/", "packages/tui/lib/", "packages/tui/package.json"], "nothing wider: packages/tui/ whole would ship its tests");
});

test("opening an agent: no module of the TUI holds an attach argument, the feature's name, an exit status number or a kernel code; the shared home builds the viewer's arguments and reads its status", () => {
  /** Every string literal of a source without its comments. */
  const literals = (source) => [...code(source).matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  const lib = TUI_SOURCES.filter((path) => path.startsWith("packages/tui/lib/"));
  // `attach` stands in one command the TUI writes for a person, with placeholders: what this
  // version does not do (views/help.mjs). The panel's control client attaches by the `new-session`
  // that starts its private server, and names no attach.
  // A module path (lib/client.mjs's re-exports of session-attach.mjs and attach-exit.mjs) is no command.
  const attaching = lib.flatMap((path) => literals(read(path)).filter((text) => /\battach\b/.test(text) && !/^\.\.?\/.*\.mjs$/.test(text)).map((text) => [path, text]));
  assert.deepEqual(attaching.map(([path]) => path).sort(), ["packages/tui/lib/views/help.mjs"]);
  for (const [path, text] of attaching) {
    assert.match(text, /`?oats session attach (--server <id> )?--home <home>`?/, `${path}: a command of placeholders only`);
    assert.doesNotMatch(text, /--detach-key/, path);
  }
  assert.match(code(read("packages/tui/lib/panel.mjs")), /\[\.\.\.base\(\), "-C", \.\.\.list\]/, "the control client starts the panel's own server");
  for (const path of lib) {
    const source = code(read(path));
    assert.doesNotMatch(source, /session-attach-detach-key/, `${path} names the feature`);
    assert.doesNotMatch(source, /(?:[=!]==?|[<>]=?)\s*(?:20|255)\b|\b(?:20|255)\s*(?:[=!]==?|[<>]=?)/, `${path} compares a number with a status`);
    assert.deepEqual(literals(read(path)).filter((text) => /^--/.test(text) && !["--dir", "--dir=", "--ascii", "--help", "--json"].includes(text)), [], `${path} holds a flag of the kernel`);
    // The codes a module of the TUI names: the shared terminal table's own for an open the person gave up (preflightFailure).
    // And the start rule's one code a client words itself, the end of the wait for a start that goes on (session-start.mjs).
    // And the panel's own refusals, each its own E_PANEL_ code, which the loop reads (lib/main.mjs, E_PANEL_TMUX).
    // And the shared preview's one code whose words say it is read again ("Reading it again…"), which the store does (E_TARGET_CHANGED).
    // And the shared transaction's reason for an outcome not known, which the loop gives a spawn call that threw
    // instead of answering, as the transaction does itself (lib/main.mjs; spawn-transaction.mjs `failed`).
    // And the shared list adapter's code for a call to this computer's deployments list that threw
    // instead of answering, as the adapter answers an exec that throws (lib/main.mjs NOT_ASKED; deployment-list-cli.mjs).
    const codes = literals(read(path)).filter((text) => /^E_[A-Z_]+$/.test(text));
    if (path === "packages/tui/lib/panel.mjs") assert.deepEqual([...new Set(codes)].filter((c) => !c.startsWith("E_PANEL_")), [], path);
    else assert.deepEqual(codes, path === "packages/tui/lib/model.mjs" ? ["E_TERM_CONTEXT_CHANGED", "E_START_UNCONFIRMED"] : path === "packages/tui/lib/main.mjs" ? ["E_CLI_FAILED", "E_OUTCOME_UNKNOWN", "E_PANEL_TMUX"] : path === "packages/tui/lib/store.mjs" ? ["E_TARGET_CHANGED"] : [], path);
  }
  // The viewer is started where it is built from the shared answer: lib/main.mjs hands lib/panel.mjs
  // what sessionAttachArgv or prepareRemoteTerm answered, with no key, and nothing else.
  // The viewer without its status line, which the shared home asks only of a kernel that has the flag.
  assert.match(code(read("packages/tui/lib/main.mjs")), /sessionAttachArgv\(probe\.cli, decision\.target, \{ statusLine: false \}\)/);
  assert.match(code(read("packages/tui/lib/main.mjs")), /effects\.prepareRemoteTerm\(probe\.cli, decision\.target, \{ exec: reader\.exec, signal: mine\.controller\.signal, statusLine: false \}\)/);
  assert.doesNotMatch(code(read("packages/tui/lib/main.mjs")), /--no-status-line|session-attach-no-status-line/, "the flag and its feature are the shared home's to spell");
  assert.match(code(read("packages/tui/lib/main.mjs")), /panel\.open\(\{ argv: \[process\.execPath, bin, \.\.\.args\]/);
  assert.doesNotMatch(code(read("packages/tui/lib/main.mjs")), /detachKey: state\.detachKey|"--detach-key"/, "the viewer is given no key");
  // The panel builds no argument of the viewer's: the pane's command is its constant script, then
  // the argv it was handed, each argument as it is (a trailing ";" escaped for tmux alone).
  const panel = code(read("packages/tui/lib/panel.mjs"));
  assert.match(panel, /"\/bin\/sh", "-c", VIEW_SCRIPT, \.\.\.argv\.map\(tmuxArgument\)\]/);
  assert.deepEqual(literals(read("packages/tui/lib/panel.mjs")).filter((text) => /^(session|--home|--server)$/.test(text)), [], "the panel names no argument of the kernel's");
});
