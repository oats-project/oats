process.env.TZ = "UTC"; // a clock time on the screen is local: every time here is computed in one zone
// The model: from the store's state to what is drawn. What it shows is asked of the shared home,
// so each expected order, word and sentence here is what the shared function answers when it is
// called directly (through lib/client.mjs), never a copy of it. Every entry is made by the shared
// functions (helpers.mjs); no test needs a terminal, a timer or a process.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TERMS, panelData, rosterRows, livenessInput, livenessAnswers, panelInstances, observedEntry, instanceId, instanceVisibleInTree, waitingRollup, collapseKey,
  filterInstanceTree, heldHome, rosterSections, deploymentState, rowStale, primaryDeployment, runtimeState as sharedState, runtimeCounts,
  waitingClaim, waitingLabel, waitedText, waitingClock, waitingBelowText, instanceActs, rowReason,
  identityMemory, remoteRosterState, observeIdentities, viewModel, listedViews, workspaceChoices, workspaceChoiceRows, choiceMatches, UNMATCHED_SECTION, shortPath, isMultiDeployment,
  cliRemoteRoster, originLead, displayLine, DETAIL_WITHHELD, instanceSiblings, siblingText,
} from "../lib/client.mjs";
import { LIST_WORDS, OFFERED_SECTION, ROSTER_FAILED, SENTENCE_INDENT, WORD_MAX, clockTime, disclosure, heldOf as modelHeld, model, panelOf, roster, switcher, switcherLead, workspaceList, listChoice } from "../lib/model.mjs";
import { initialState, reduce } from "../lib/store.mjs";
import { shown, shownLines, textOf } from "../lib/term/text.mjs";
import { windowOf } from "../lib/views/scroll.mjs";
import { SWITCHER_TEXT } from "../lib/views/switcher.mjs";
import { CLI, DEPLOYMENT, NOW, draw, drawnName, failed, instanceRow, leaderEscape, observed, press, rosterOf, stateOf, took } from "./helpers.mjs";

const AT = new Date(NOW).toISOString();
const OBSERVED_AT = "2026-10-11T10:00:00.000Z";
const STOPPED = { running: false, runtimeState: "stopped" };
const TIMEOUT = { code: "E_CLI_TIMEOUT", message: "the read did not answer in time" };
const UNREADABLE = { code: "E_REMOTE_UNREADABLE", message: "the remote cache could not be read" };
const SINCE = "2026-10-11T09:56:00.000Z";
/** A waiting claim as it arrives in a panel row: the shared reader has already read it. */
const claimOf = (reason, message = null) => ({ since: SINCE, producer: "claude", reason, message });

/** What the views are given for a state, in a list pane `page` rows tall. */
const view = (state, page = 19, now = NOW) => model(state, { page, now, at: AT });
/** The cheat sheet of the frame drawn for a state (views/frame.mjs): the sidebar's rows after its
 *  last rule, each a key and what it does, as `key word` (the column between them closed up). */
function cheatSheet(state, size) {
  const d = draw(state, size), rows = d.lines.map((line) => line.slice(0, d.cols));
  return rows.slice(rows.findLastIndex((line) => /^[─-]+$/.test(line)) + 1).map((line) => line.trim().replace(/ {2,}/, " ")).filter(Boolean);
}
/** The list of instances' cheat sheet while Enter opens nothing: it never names an act. */
const SHEET_NO_ENTER = Object.freeze(["Ctrl+\\ commands", "Ctrl+K palette", "n spawn", "w workspaces", "? help", "q quit"]);
/** The same state with another instance selected, by name (and soul, for a name two souls have). */
function on(state, name, soul) {
  const item = roster(state).rows.find(({ row }) => row.instance === name && (soul === undefined || row.agent === soul));
  return Object.freeze({ ...state, selected: item.id });
}
/** The same state with these instances collapsed. A collapse key's first part is what is open. */
const folded = (state, ...names) => Object.freeze({ ...state, collapsed: new Set(names.map((name) => collapseKey(state.open, panelRow(state, name).id))) });
/** A drawn item by name: `{ row, id, depth }`, the row being the panel's. */
const panelRow = (state, name) => roster(state).rows.find(({ row }) => row.instance === name);
const listRow = (state, name, soul) => view(on(state, name, soul)).list.find((row) => row?.selected);
const detailOf = (state, name, now = NOW) => view(on(state, name), 19, now).detail;
const fact = (detail, label) => detail.facts.find((f) => f.label === label) ?? null;
const labels = (detail) => detail.facts.map((f) => f.label);
/** The fact on the line after a labelled one. */
const after = (detail, label) => detail.facts[detail.facts.findIndex((f) => f.label === label) + 1] ?? null;
/** The items of a state's list that are instances or the empty item between their groups: what
 *  else the list may hold (a heading, a sentence, the line that says why no instance is listed)
 *  is read by the tests that are about it. */
const treeItems = (state) => roster(state).items.filter((item) => item === null || item.id !== undefined);
const names = (state) => treeItems(state).map((item) => item && item.row.instance);
const solos = (...list) => list.map((name) => instanceRow("dev", name));

/** `held`, field by field as the spec's "The store" gives it, with what was settled after it:
 *  `snapshot.byWs` holds this machine's entries only, and `at` is the time of the last roster
 *  outcome the store took, or the paint's before any. What the shared composition reads of a client. */
const heldOf = (state, at) => ({
  ctxs: state.ctxs, snapshot: { byWs: state.entries }, remoteGroups: state.remote.remoteGroups,
  remembered: identityMemory({ memory: state.memory, notes: state.notes }), rosterAnswered: state.remote.rosterAnswered, rosterFailure: state.remote.rosterFailure, cli: state.cli,
  observing: new Set(), remoteCollecting: state.collecting, home: state.home, at: state.rosterAt ?? at, learned: state.identities,
});
/** The panel of the view a state has open, asked of the shared home directly. */
const sharedPanel = (state, at = AT) => panelData(heldOf(state, at), state.open, TERMS);

/** The groups the shared functions give for a state, asked as the spec's steps 1 to 3 say. */
function sharedGroups(state) {
  const panel = sharedPanel(state), query = state.filter.query, filtering = query.trim() !== "";
  const visible = filterInstanceTree(panel.instances, query).filter((row) => instanceVisibleInTree(row, panel.instances, state.collapsed, DEPLOYMENT, filtering));
  const sections = rosterSections(panel.instances, visible, panel.deployments, TERMS);
  assert.equal(sections.length, 1, "one deployment is one section");
  return sections[0].groups;
}
/** The instances in the order the shared functions give: every group in the order given, every
 *  cluster's members in order with their depth. It holds whatever a collapse or a filter hides. */
const sharedRows = (state) => sharedGroups(state).flatMap((group) => group.clusters.flatMap((cluster) => cluster.instances.map((row) => [instanceId(row), row.depth])));
/** The same with one empty item before the group of single instances when clusters came before
 *  it. Only for a state that hides nothing: there a group of single instances is a group whose
 *  clusters hold one instance each. While a collapse or a filter hides part of a cluster that
 *  reading fails: the cluster's group is decided on the full roster (awebai/oats#971, fixed on
 *  main), which the test of a row that keeps its group, below, pins by the groups' own labels. */
function sharedOrder(state) {
  assert.equal(state.collapsed.size === 0 && state.filter.query.trim() === "", true, "sharedOrder is for a state that hides nothing");
  const out = [];
  let previous = null; // whether the group before was a run of single instances
  for (const group of sharedGroups(state)) {
    // The empty item at every boundary between a run of single instances and a cluster, both ways (#1262).
    const singles = group.clusters.every((cluster) => cluster.instances.length === 1);
    if (previous !== null && singles !== previous) out.push(null);
    previous = singles;
    for (const cluster of group.clusters) for (const row of cluster.instances) out.push([instanceId(row), row.depth]);
  }
  return out;
}
const drawnOrder = (state) => treeItems(state).map((item) => item && [item.id, item.depth]);
const drawnRows = (state) => roster(state).rows.map((item) => [item.id, item.depth]);
/** The names drawn, without the empty item. */
const listed = (state) => names(state).filter(Boolean);

/** The collector as a probe that agrees with the kernel, and as its documented answer for a row
 *  the kernel answered `running: null` (liveness.mjs `observeLiveness`, which a test here cannot
 *  load): such a row is not probed, keeps the kernel's `running`, `runtimeState` and
 *  `runtimeError`, and its answer carries no `tmux`. A probed row comes back with a window id. */
const collector = (row) => (row.running === null
  ? { running: null, runtimeState: row.runtimeState ?? "unreachable", ...(row.runtimeError ? { runtimeError: row.runtimeError } : {}) }
  : { tmux: { ...row.tmux, windowId: "@7" }, running: row.running, runtimeState: row.runtimeState });
/** One read cycle as lib/read.mjs runs it, every step a shared function: the kernel's rows, the
 *  collector's input as the JSON it is given, what it printed (`null`: it failed as a whole), the
 *  answers, the panel's rows and the entry. */
function cycle(kernelRows, { collect = collector, team } = {}) {
  const document = rosterOf(kernelRows, { team }), rows = rosterRows(document, CLI);
  const input = JSON.parse(JSON.stringify(livenessInput(rows)));
  const answers = livenessAnswers(rows, collect ? JSON.stringify(input.map(collect)) : null);
  const entry = observedEntry({ roster: document, workspaceStatus: { workspace: { name: "acme-platform" } }, observedAt: OBSERVED_AT }, panelInstances(rows, answers), AT);
  return { rows, input, answers, entry };
}
/** What the shared home answers for a row whose session backend OATS no longer has, or null for
 *  any other row: the kernel's own reason, or the home's stand-in for an older kernel's row. It is
 *  read from the reason of the row's start act (instance-acts.mjs), so no byte of the stand-in
 *  is written in this file. */
const unsupportedText = (row) => {
  const reason = instanceActs(row).acts.find((act) => act.verb === "start")?.reason ?? null;
  return reason?.code === "unsupported-session" ? reason.sentence : null;
};
/** A sentence of the terminal check's own, as it answers for a probe that failed (tmux-status.mjs): a
 *  window with two panes marked as the agent's, so it can't tell which is (#1569). */
const CHECK_FAILED = "the window has 2 panes marked as odd's agent pane (%3, %7); close all but the agent's with tmux kill-pane -t <id>, or close the window and start the instance";
/** The collector's documented answer for the rows `collector` leaves out (`observeLiveness`
 *  again). Before anything else, a row whose session backend OATS no longer has is never probed:
 *  it reads unsupported, with that text and no tmux. And a probed row whose check fails reads
 *  unknown, with the check's text. `failing`: an instance's name to the text its check gives. */
const collecting = (failing = {}) => (row) => {
  const unsupported = unsupportedText(row);
  if (unsupported !== null) return { running: null, runtimeState: "unsupported", runtimeError: unsupported, tmux: null };
  if (row.running !== null && Object.hasOwn(failing, row.instance)) return { tmux: row.tmux, running: null, runtimeState: "unreachable", runtimeError: failing[row.instance] };
  return collector(row);
};

// --- The roster is the Desktop's --------------------------------------------------------

// The rows of packages/desktop/test/palette-tree.test.mjs, "an empty query lists every instance in
// the sidebar's groups, order and depth, then the commands": two relation clusters and two
// unrelated instances, deliberately out of order. Copied as [name, what the row says]; the
// Desktop's fixture gives each a home of its own, as instanceRow does.
const PALETTE = [
  ["solo-y", { running: false }], ["grandchild", { parentInstance: "child-a" }], ["lead", {}], ["child-b", { parentInstance: "lead", running: false }],
  ["alpha", { running: false }], ["solo-x", {}], ["child-a", { parentInstance: "lead" }], ["alpha-kid", { parentInstance: "alpha" }],
];
const TREE = PALETTE.map(([name, extra]) => instanceRow("dev", name, extra.running === false ? { ...extra, runtimeState: "stopped" } : extra));

test("the roster is the Desktop's: the rows of its palette test come out in the order and at the depths that test asserts", () => {
  const state = stateOf(observed(TREE));
  // That test's expected rows, [group, name, depth], without the group's label: one empty item
  // stands where its "independent" group begins.
  assert.deepEqual(roster(state).items.map((item) => item && [item.row.instance, item.depth]), [
    ["alpha", 0], ["alpha-kid", 1],
    ["lead", 0], ["child-a", 1], ["grandchild", 2], ["child-b", 1],
    null, ["solo-x", 0], ["solo-y", 0],
  ]);
  assert.deepEqual(roster(state).rows.map((item) => item.row.instance), ["alpha", "alpha-kid", "lead", "child-a", "grandchild", "child-b", "solo-x", "solo-y"]);
  // Its second assertion, a query: matches at their depth under their ancestors, in tree order.
  // (One cluster is drawn and no other group: the order inside a cluster is all this reads.)
  assert.deepEqual(roster(press(state, ["/", "g", "r", "a", "n", "d", "enter"]).state).rows.map((item) => [item.row.instance, item.depth]), [["lead", 0], ["child-a", 1], ["grandchild", 2]]);
  assert.deepEqual(roster(press(state, ["/", "c", "h", "i", "l", "d", "enter"]).state).rows.map((item) => item.row.instance), ["lead", "child-a", "grandchild", "child-b"]);
});

test("the roster is the Desktop's: the rows of its instance-tree test keep parent-first order, siblings by name, and sibling-linked peers at depth 0", () => {
  // packages/desktop/test/instance-tree.test.mjs, "clusterInstances: connected components over
  // parent + sibling links; unrelated are single-node clusters".
  const rows = [
    ["coord-1", { running: true }], ["dev-a", { parentInstance: "coord-1", running: true }], ["dev-b", { parentInstance: "coord-1", running: false }],
    ["reviewer-1", { parentInstance: "dev-a", running: true }],
    ["peer-1", { siblingInstance: "peer-2", relation: "sibling", relativeTo: "peer-2", running: false }], ["peer-2", { running: false }],
    ["loner", { running: true }],
  ].map(([name, extra]) => instanceRow("dev", name, extra.running ? extra : { ...extra, runtimeState: "stopped" }));
  const state = stateOf(observed(rows));
  const items = roster(state).items.map((item) => item && [item.row.instance, item.depth]);
  assert.deepEqual(items.slice(0, 4), [["coord-1", 0], ["dev-a", 1], ["reviewer-1", 2], ["dev-b", 1]], "parent first, and siblings by name");
  assert.deepEqual(items.slice(4, 7), [null, ["loner", 0], null], "the unrelated instance stands alone, in its place by name, an empty row on each side");
  assert.deepEqual(new Set(items.slice(7).map((item) => item[0])), new Set(["peer-1", "peer-2"]), "a sibling link alone joins a cluster");
  assert.deepEqual(items.slice(7).map((item) => item[1]), [0, 0]);
  assert.equal(items.length, 9);
  assert.deepEqual(drawnOrder(state), sharedOrder(state));
});

test("under one parent the flagged children come first, by name within each part, when the CLI declares instance-same-work (#1577)", () => {
  const rows = [
    ["lead", {}], ["a-dev", { parentInstance: "lead" }], ["b-dev", { parentInstance: "lead", sameWork: true }],
    ["c-dev", { parentInstance: "lead", sameWork: "true" }], ["d-dev", { parentInstance: "lead", sameWork: true }],
    ["d-rev", { parentInstance: "d-dev", sameWork: true }], ["solo", { sameWork: true }],
  ].map(([name, extra]) => instanceRow("dev", name, extra));
  const cli = { ...CLI, features: Object.freeze([...CLI.features, "instance-same-work"]) };
  const order = (state) => roster(state).items.map((item) => item && [item.row.instance, item.depth]);
  const declared = stateOf(observed(rows, { cli }), { cli });
  assert.deepEqual(order(declared), [
    ["lead", 0], ["b-dev", 1], ["d-dev", 1], ["d-rev", 2], ["a-dev", 1], ["c-dev", 1], null, ["solo", 0],
  ], "flagged first (b, d), then the rest (a, and c whose \"true\" is no flag); a flagged root keeps its place");
  assert.deepEqual(drawnOrder(declared), sharedOrder(declared), "the order is the shared rosterGroups'");
  // Without the feature every child draws its line, as today: the order is today's, by name.
  assert.deepEqual(order(stateOf(observed(rows))), [
    ["lead", 0], ["a-dev", 1], ["b-dev", 1], ["c-dev", 1], ["d-dev", 1], ["d-rev", 2], null, ["solo", 0],
  ]);
});

test("a cluster whose root is named `independent` is a cluster: the gaps stand around it, expanded and collapsed (#1262)", () => {
  const state = stateOf(observed([instanceRow("dev", "alpha"), instanceRow("dev", "independent"), instanceRow("dev", "kid", { parentInstance: "independent" }), instanceRow("dev", "zulu")]));
  const named = (s) => roster(s).items.map((item) => item && item.row.instance);
  assert.deepEqual(named(state), ["alpha", null, "independent", "kid", null, "zulu"]);
  assert.deepEqual(drawnOrder(state), sharedOrder(state));
  assert.deepEqual(named(folded(state, "independent")), ["alpha", null, "independent", null, "zulu"]);
});

test("the drawn order is what the shared grouping gives when it is called directly: plain, collapsed, filtered, and after a row stops", () => {
  const state = stateOf(observed(TREE));
  const cases = {
    plain: state,
    "a child collapsed": folded(state, "child-a"),
    "a root collapsed": folded(state, "alpha"),
    "both roots collapsed": folded(state, "alpha", "lead"),
    "a filter on a cluster": press(state, ["/", "c", "h", "i", "l", "d", "enter"]).state,
    "a filter on single instances": press(state, ["/", "s", "o", "l", "o", "enter"]).state,
    "a filter on the soul": press(state, ["/", "d", "e", "v", "enter"]).state,
    "a filter under a collapsed row": press(folded(state, "lead"), ["/", "g", "r", "a", "n", "d", "enter"]).state,
    "the running lead stopped": stateOf(observed(TREE.map((row) => (row.instance === "lead" ? { ...row, ...STOPPED } : row)))),
    "every row stopped": stateOf(observed(TREE.map((row) => ({ ...row, ...STOPPED })))),
  };
  for (const [what, s] of Object.entries(cases)) {
    assert.deepEqual(drawnRows(s), sharedRows(s), what);
    if (s.collapsed.size === 0 && s.filter.query === "") assert.deepEqual(drawnOrder(s), sharedOrder(s), `${what}: with the empty item`);
    assert.equal(roster(s).items.filter((item) => item === null).length <= 1, true, `${what}: never two empty items`);
    assert.deepEqual(roster(s).rows, roster(s).items.filter(Boolean), what);
    assert.deepEqual([...roster(s).index], roster(s).items.flatMap((item, i) => (item ? [[item.id, i]] : [])), `${what}: the index is each row's place`);
  }
  assert.equal(roster(cases.plain).rows.length, TREE.length);
});

test("one empty item stands before the group of single instances exactly when clusters came before it", () => {
  const empties = (state) => names(state).flatMap((name, i) => (name === null ? [i] : []));
  const both = stateOf(observed(TREE));
  assert.deepEqual(empties(both), [6], "after the six rows of the two clusters, and nowhere between the clusters");
  assert.deepEqual(empties(stateOf(observed(solos("a", "b", "c")))), [], "only single instances: none");
  const clusters = stateOf(observed(TREE.filter((row) => !row.instance.startsWith("solo"))));
  assert.deepEqual(empties(clusters), [], "only clusters: none");
  assert.deepEqual(names(clusters), ["alpha", "alpha-kid", "lead", "child-a", "grandchild", "child-b"]);
  assert.deepEqual(names(press(both, ["/", "s", "o", "l", "o", "enter"]).state), ["solo-x", "solo-y"], "a filter that leaves only single instances: none");
  assert.deepEqual(names(press(both, ["/", "k", "i", "d", "enter"]).state), ["alpha", "alpha-kid"], "a filter that leaves only a cluster: none");
  assert.deepEqual(empties(stateOf(observed([]))), []);
  // The window carries the empty item at its place: the view draws an empty row there.
  assert.deepEqual(view(both).list.map((row) => row && row.name), ["Alpha", "Alpha kid", "Lead", "Child a", "Grandchild", "Child b", null, "Solo x", "Solo y"]);
});

// --- The panel --------------------------------------------------------------------------

test("panelOf is the shared panelData over what the store holds, for a pending, an unavailable, an observed and a stale entry", () => {
  const entry = observed(TREE, { withheld: [{ agent: "dev", instance: "twice", reason: "duplicate-home" }] });
  const cases = {
    pending: stateOf(null, { home: "/srv" }),
    unavailable: stateOf(failed(entry, TIMEOUT), { home: "/srv" }),
    observed: stateOf(entry, { home: "/srv" }),
    stale: stateOf(failed(entry, UNREADABLE), { home: "/srv" }),
  };
  for (const [what, state] of Object.entries(cases)) {
    for (const at of [AT, "2026-10-11T11:11:11.000Z"]) assert.deepEqual(panelOf(state, at), panelData(heldOf(state, at), DEPLOYMENT, TERMS), what);
  }
  const status = (state) => panelOf(state, AT).deployment.status;
  assert.deepEqual(Object.values(cases).map(status), ["pending", "unavailable", "observed", "observed"]);
  // Each thing the store holds reaches the panel: the entry's rows, tagged with their deployment,
  // its stamps, its failure, and the home the short label is cut by.
  const live = panelOf(cases.observed, AT), stale = panelOf(cases.stale, AT);
  assert.equal(live.instances.length, TREE.length);
  assert.equal(live.instances.every((row) => row.deployment.id === DEPLOYMENT), true);
  assert.deepEqual([live.generatedAt, live.observedAt], [entry.generatedAt, entry.observedAt]);
  assert.equal(live.deployment.withheld.length, 1);
  assert.equal(live.error, undefined);
  assert.equal(stale.error, UNREADABLE.message);
  assert.equal(live.deployments.length, 1, "this version shows one deployment");
  assert.notEqual(live.deployments[0].label, panelOf(stateOf(entry, { home: "/elsewhere" }), AT).deployments[0].label, "the label is cut by the home the store holds");
});

// --- A row the kernel answered as unknown ----------------------------------------------

test("a row the kernel answered running null and unreachable keeps the kernel's three fields and its tmux, draws the unknown mark with the shared label in the list and the kernel's word in the detail, and offers exactly the shared acts", () => {
  const kernel = { running: null, runtimeState: "unreachable", runtimeError: "tmux: the socket /run/user/1000/oats/agents.sock could not be read", tmux: { session: "oats-agents", window: "lost" } };
  const { input, entry } = cycle([instanceRow("dev", "fine"), instanceRow("dev", "lost", kernel)]);
  assert.equal(input.find((row) => row.instance === "lost").running, null, "the collector is told the kernel answered null");
  assert.equal(input.find((row) => row.instance === "fine").running, true);
  const state = stateOf(entry), { row } = panelRow(state, "lost");
  assert.deepEqual({ running: row.running, runtimeState: row.runtimeState, runtimeError: row.runtimeError, tmux: row.tmux }, kernel);
  assert.equal(panelRow(state, "fine").row.tmux.windowId, "@7", "a probed row has the collector's tmux; the unknown one the kernel's, with no window id");
  const drawn = listRow(state, "lost");
  assert.equal(rowReason(row).key, "unknown");
  assert.deepEqual({ mark: drawn.mark, word: drawn.word, waiting: drawn.waiting }, { mark: "unknown", word: rowReason(row).label, waiting: false });
  assert.deepEqual(listRow(state, "fine").mark, "running");
  // Its acts are the shared answer, and that answer has neither start nor restart.
  const acts = instanceActs(row);
  assert.deepEqual(acts.acts.map((act) => act.verb), ["inspect", "stop", "retire"]);
  assert.deepEqual([acts.blocked, acts.limited], [null, null]);
  const detail = detailOf(state, "lost");
  assert.equal(fact(detail, "state").value, "unreachable");
  assert.deepEqual(after(detail, "state"), { label: "", value: `OATS says: ${kernel.runtimeError}`, form: "wrap" }, "the kernel's text on the next line, after the words that say the kernel gave it");
  assert.equal(fact(detail, "held"), null, "nothing of the TUI's own is said about it");
  assert.deepEqual(view(state).counts.map((count) => [count.n, count.word]), Object.entries(runtimeCounts(sharedPanel(state).instances)).filter(([, n]) => n > 0).map(([word, n]) => [n, word]));
  assert.equal(runtimeCounts(sharedPanel(state).instances).unknown, 1);
});

test("when the collector fails as a whole every row reads unknown, with the shared sentence in its detail after the words that say the terminal check gave it", () => {
  const rows = [instanceRow("dev", "fine"), instanceRow("dev", "idle", STOPPED), instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: "the kernel's own reason" })];
  const { answers, entry } = cycle(rows, { collect: null });
  const sentence = answers[0].runtimeError;
  assert.equal(typeof sentence === "string" && sentence.length > 0, true);
  assert.equal(answers.every((answer) => answer.running === null && answer.runtimeError === sentence), true);
  const state = stateOf(entry);
  for (const name of ["fine", "idle", "lost"]) {
    const drawn = listRow(state, name), detail = detailOf(state, name);
    assert.equal(drawn.mark, "unknown", name);
    assert.equal(drawn.word, rowReason(panelRow(state, name).row).label, name);
    assert.equal(fact(detail, "state").value, panelRow(state, name).row.runtimeState, name);
    // Also for the row the kernel had answered with a reason of its own: the collector's failure is what is known of it now.
    assert.deepEqual(after(detail, "state"), { label: "", value: `oats tui's terminal check says: ${sentence}`, form: "wrap" }, name);
    assert.deepEqual(instanceActs(panelRow(state, name).row).acts.map((act) => act.verb), ["inspect", "stop", "retire"], name);
  }
  assert.deepEqual(view(state).counts, [{ n: 3, word: "unknown", shared: true }]);
});

// --- What a failed read is shown as -----------------------------------------------------

/** A cluster with two waiting rows below its root, and a single instance that waits. */
const WAITERS = [
  instanceRow("dev", "lead"),
  instanceRow("dev", "child-a", { parentInstance: "lead", waitingOnYou: claimOf("question", "Which base should it use?") }),
  instanceRow("dev", "grandchild", { parentInstance: "child-a", waitingOnYou: claimOf("permission") }),
  instanceRow("dev", "child-b", { parentInstance: "lead" }),
  instanceRow("dev", "solo", { waitingOnYou: claimOf("attention", "Done, have a look.") }),
];

test("a stale entry reads stale through the shared panel: every row is held stale, a waiting claim on such a row is not shown, and the notice says so with the time and the reason", () => {
  const entry = observed(WAITERS), live = stateOf(entry), state = stateOf(failed(entry, UNREADABLE));
  const panel = sharedPanel(state), said = deploymentState(primaryDeployment(panel.deployments));
  assert.equal(said.key, "stale");
  assert.equal(panel.instances.length, WAITERS.length, "the rows are the last observation's");
  for (const row of panel.instances) {
    assert.equal(rowStale(row, panel.deployments), true, row.instance);
    assert.equal(waitingClaim(row, { stale: rowStale(row, panel.deployments) }), null, row.instance);
  }
  // The claims are still on the rows: only the stale reading hides them.
  assert.deepEqual(panel.instances.filter((row) => waitingClaim(row)).map((row) => row.instance).sort(), ["child-a", "grandchild", "solo"]);
  assert.deepEqual(view(live).list.filter(Boolean).filter((row) => row.waiting).map((row) => row.name).sort(), ["Child a", "Grandchild", "Solo"]);
  assert.deepEqual(view(state).list.filter(Boolean).map((row) => row.waiting), [false, false, false, false, false]);
  assert.deepEqual(view(live).counts.filter((count) => !count.shared), [{ n: 3, word: "need input", shared: false }]);
  assert.deepEqual(view(state).counts.filter((count) => !count.shared), [], "the model counts no one as needing input");
  assert.equal(view(state).counts.some((count) => count.word.includes("input")), false);
  assert.equal(fact(detailOf(live, "child-a"), "needs") !== null, true);
  for (const name of ["child-a", "grandchild", "solo"]) assert.equal(fact(detailOf(state, name), "needs"), null, name);
  assert.equal(detailOf(state, "child-a").facts.some((f) => f.value.includes("Which base")), false, "nor is its message quoted");
  // Collapsed over them, the stale root rolls nothing up either.
  assert.equal(view(on(folded(live, "lead"), "lead")).list.find((row) => row?.selected).below, 2);
  assert.equal(view(on(folded(state, "lead"), "lead")).list.find((row) => row?.selected).below, 0);
  assert.equal(fact(view(on(folded(state, "lead"), "lead")).detail, "below"), null);
  // Since the last good read: the cycle's own time, which a failed read leaves on the entry it
  // keeps, and not the kernel's older look at the remotes.
  assert.deepEqual([entry.generatedAt, entry.observedAt], ["2026-10-11T10:00:00.000Z", "2026-10-11T09:59:00.000Z"]);
  assert.deepEqual(view(state).notice, { text: said.text, since: clockTime(entry.generatedAt), reason: said.detail });
  assert.equal(view(state).notice.since, "10:00:00");
  assert.equal(sharedPanel(stateOf(failed(entry, UNREADABLE, "2026-10-11T10:07:00.000Z"))).generatedAt, entry.generatedAt, "a later failure does not move it");
  assert.equal(said.detail.includes(UNREADABLE.message), true, "the reason holds the kernel's message");
  assert.deepEqual([view(state).empty, view(state).observed], [null, true]);
  assert.equal(view(live).notice, null, "a live deployment has no notice");
});

test("an unavailable entry has no rows: the notice holds the shared state's words and its detail as the reason, and no empty line of the TUI's stands in", () => {
  const entry = observed(TREE), state = stateOf(failed(entry, TIMEOUT));
  const said = deploymentState(primaryDeployment(sharedPanel(state).deployments));
  assert.notEqual(said.key, "live");
  assert.equal(said.detail.includes(TIMEOUT.message), true);
  const m = view(state);
  assert.deepEqual(roster(state).rows, []);
  assert.deepEqual(m.list, []);
  assert.deepEqual([m.above, m.below], [0, 0]);
  assert.equal(m.notice.text, said.text);
  assert.equal(m.notice.reason, said.detail);
  assert.equal(m.empty, null);
  assert.equal(m.observed, false);
  assert.equal(m.detail, null);
  assert.deepEqual(m.counts, []);
  // The selection the user had is not drawn, and is not lost either (the store keeps it).
  assert.equal(view(press(stateOf(entry), ["j"]).state).detail.title, "alpha-kid");
});

test("the empty states: reading before the first answer, none for a deployment without instances, nomatch for a filter that matches nothing", () => {
  const pending = view(stateOf());
  assert.deepEqual([pending.empty, pending.notice, pending.observed, pending.readAt], ["reading", null, false, null]);
  assert.deepEqual(pending.list, [{ empty: "reading" }], "no instance: the list holds the one item that says why");
  const none = view(stateOf(observed([])));
  assert.deepEqual([none.empty, none.notice, none.observed, none.detail], ["none", null, true, null]);
  assert.deepEqual(none.list, [{ empty: "none" }]);
  const nomatch = view(press(stateOf(observed(TREE)), ["/", "z", "z", "z", "enter"]).state);
  assert.deepEqual([nomatch.empty, nomatch.notice, nomatch.observed], ["nomatch", null, true]);
  assert.deepEqual(nomatch.list, [{ empty: "nomatch" }]);
  assert.equal(nomatch.detail, null);
  assert.equal(view(stateOf(observed(TREE))).empty, null, "with rows to draw there is no empty line");
  // No instances and a filter: there is still nothing to match in.
  assert.equal(view(press(stateOf(observed([])), ["/", "z", "enter"]).state).empty, "none");
});

test("the facts of a live deployment for the sidebar's title and the help's top row: its workspace's name, the time of the read as a local clock time, on the help's top row only, and what the store holds of the view", () => {
  // The read's own time, not the kernel's observation of the remotes, which a read in the
  // background reuses: here it is a minute older, and the help does not show it.
  const state = press(stateOf(observed(TREE, { workspace: "acme-platform", observedAt: "2026-10-11T14:02:27.000Z", at: "2026-10-11T14:03:27.000Z" })), ["j", "tab"]).state;
  const m = view(state);
  assert.equal(m.workspace, "acme-platform");
  assert.equal(m.readAt, clockTime("2026-10-11T14:03:27.000Z"));
  assert.equal(m.readAt, "14:03:27");
  assert.deepEqual({ view: m.view, focus: m.focus, filter: m.filter, ascii: m.ascii, detailTop: m.detailTop, helpTop: m.helpTop }, { view: "instances", focus: "detail", filter: { editing: false, query: "" }, ascii: false, detailTop: 0, helpTop: 0 });
  assert.equal(m.actions, state.actions);
  assert.deepEqual(m.list.filter((row) => row?.selected).map((row) => row.name), ["Alpha kid"], "one row is the selected one");
  assert.equal(m.detail.title, "alpha-kid");
  assert.equal(view(stateOf(observed(TREE), { ascii: true })).ascii, true);
  // The time stands on the help's top row, at the start of the main area (no header holds it),
  // and nowhere on the view's own frame; the title is the list of workspaces' one row: the open
  // workspace's name.
  const help = draw(press(state, ["?"]).state);
  assert.equal(help.lines[0].slice(help.cols + 1).trim(), "read 14:03:27");
  assert.equal(draw(state).lines.some((line) => line.includes("14:03:27")), false, "the view's frame shows no time of the read");
  assert.equal(draw(state).lines[0].slice(0, help.cols).trim(), "acme-platform");
});

// --- Marks and words --------------------------------------------------------------------

test("a row's mark is the shared word for its state; it has a word only where the mark can't say it, the shared label of its row reason; the detail says its state, with the kernel's word for it", () => {
  const rows = [
    instanceRow("dev", "runs", { harness: "codex" }),
    instanceRow("dev", "idle", STOPPED),
    instanceRow("dev", "shelly", { running: false, runtimeState: "shell" }),
    instanceRow("dev", "herdr", { running: null, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: this backend is gone", tmux: null }),
    instanceRow("dev", "lost", { running: null, runtimeState: "unreachable" }),
    instanceRow("dev", "old-idle", { running: false, runtimeState: undefined }),
    instanceRow("dev", "old-lost", { running: null, runtimeState: undefined }),
  ];
  const state = stateOf(observed(rows));
  const drawn = (name) => { const row = listRow(state, name); return [row.mark, row.word]; };
  const label = (name) => rowReason(panelRow(state, name).row).label;
  // Running, stopped and a shell left: the mark says it, and the harness is the detail's.
  assert.deepEqual(drawn("runs"), ["running", null], "no harness on the row");
  assert.deepEqual(drawn("idle"), ["stopped", null]);
  assert.deepEqual(drawn("shelly"), ["shell", null], "stopped, with a shell left in its terminal");
  assert.deepEqual(drawn("old-idle"), ["stopped", null]);
  // A row the shared home gives a reason: its label, in the shared words.
  assert.deepEqual([drawn("herdr"), rowReason(panelRow(state, "herdr").row).key], [["unknown", label("herdr")], "herdr"]);
  assert.deepEqual([drawn("lost"), rowReason(panelRow(state, "lost").row).key], [["unknown", label("lost")], "unknown"]);
  assert.deepEqual(drawn("old-lost"), ["unknown", label("old-lost")]);
  // Every mark but the two refinements is the shared word itself.
  for (const name of ["runs", "idle", "herdr", "lost", "old-idle", "old-lost"]) assert.equal(drawn(name)[0], sharedState(panelRow(state, name).row), name);
  // The detail's state line says the state, for a running row "running"; for a row the shared home
  // can say why it can't be reached or opened, its label; for one whose state alone is not known,
  // the kernel's word for it, else the shared word.
  for (const [name, word] of [["runs", "running"], ["idle", "stopped"], ["shelly", "shell"], ["herdr", label("herdr")], ["lost", "unreachable"], ["old-idle", "stopped"], ["old-lost", "unknown"]]) {
    assert.equal(fact(detailOf(state, name), "state").value, word, name);
  }
  // The reason under the state, read from the row as a read makes it (the collector's answer taken
  // by the shared functions, which say whose text it is): `observed` above writes its answers
  // itself, and a text of such an answer has no speaker.
  const read = stateOf(cycle([rows[3]], { collect: collecting() }).entry);
  assert.equal(panelRow(read, "herdr").row.runtimeError, rows[3].runtimeError);
  assert.deepEqual(after(detailOf(read, "herdr"), "state"), { label: "", value: `OATS says: ${rows[3].runtimeError}`, form: "wrap" });
  assert.equal(after(detailOf(state, "idle"), "state").label, "harness", "no reason, no line under the state");
});

/** A kernel's `retire` (feature status-retire-state, #1247) as the row carries it. */
const RETIRE_SINCE = "2026-10-15T00:00:00Z";
const retireOf = (state, more = {}) => ({ state, since: RETIRE_SINCE, self: true, ...more });
const HELD = [
  instanceRow("dev", "spawning", { ...STOPPED, spawnInProgress: true }),
  instanceRow("dev", "half-spawned", { ...STOPPED, rollbackIncomplete: true }),
  instanceRow("dev", "half-retired", { ...STOPPED, retirePending: true, retire: retireOf("interrupted") }),
  // A kernel before status-retire-state: a retire pending and no `retire` reads as one in progress.
  instanceRow("dev", "held-running", { retirePending: true }),
];

test("a held home of each of the four kinds carries the held mark, the shared home's word for its state, and in the detail the sentence the shared acts give", () => {
  const state = stateOf(observed(HELD));
  const kinds = [];
  for (const name of HELD.map((row) => row.instance)) {
    const { row } = panelRow(state, name), held = heldHome(row), acts = instanceActs(row), drawn = listRow(state, name);
    kinds.push(held.kind);
    assert.deepEqual([drawn.mark, drawn.word], ["held", held.state], name);
    const sentence = acts.blocked?.sentence ?? acts.limited.sentence;
    assert.deepEqual(fact(detailOf(state, name), "held"), { label: "held", value: sentence, form: "wrap" }, name);
    assert.equal(sentence.includes(name), true, "the shared sentence names the instance");
  }
  assert.deepEqual(kinds, ["spawning", "spawn-incomplete", "retire-incomplete", "retiring"], "four kinds of held home: an interrupted retire didn't finish, an older kernel's pending one is in progress");
  assert.equal(listRow(state, "held-running").word, heldHome(panelRow(state, "held-running").row).state, "held wins over the harness of a running row");
  // A home that is not held has no such line.
  assert.equal(fact(detailOf(stateOf(observed(TREE)), "lead"), "held"), null);
});

test("a held home's detail says the held state on its state line, the same word as its list row", () => {
  const state = stateOf(observed(HELD));
  for (const name of HELD.map((row) => row.instance)) {
    assert.equal(fact(detailOf(state, name), "state").value, heldHome(panelRow(state, name).row).state, name);
    assert.equal(fact(detailOf(state, name), "state").value, listRow(state, name).word, name);
  }
});

// --- A retire in progress (#1247) --------------------------------------------------------

/** A row for each retire the kernel reports, and an older kernel's pending one (no `retire`). */
const KERNEL_MESSAGE = "the worktree could not be removed";
const RETIRES = [
  instanceRow("dev", "r-running", { retire: retireOf("running", { self: false }) }),
  instanceRow("dev", "r-unknown", { ...STOPPED, retire: retireOf("unknown") }),
  instanceRow("dev", "r-pending", { ...STOPPED, retirePending: true }),
  instanceRow("dev", "r-failed", { ...STOPPED, retirePending: true, retire: retireOf("failed", { code: "E_RETIRE_COMPLETION", message: KERNEL_MESSAGE }) }),
  instanceRow("dev", "r-failed-code", { ...STOPPED, retire: retireOf("failed", { code: "E_RETIRE_COMPLETION" }) }),
  instanceRow("dev", "r-interrupted", { ...STOPPED, retirePending: true, retire: retireOf("interrupted") }),
];
const RETIRE_KINDS = Object.freeze({ "r-running": "retiring", "r-unknown": "retiring", "r-pending": "retiring", "r-failed": "retire-failed", "r-failed-code": "retire-failed", "r-interrupted": "retire-incomplete" });

test("each retire the kernel reports reads as the shared home words it: one word while it runs, can't be told or is an older kernel's pending one, never a failure's; a failed one and an unfinished one each their own", () => {
  const state = stateOf(observed(RETIRES));
  for (const [name, kind] of Object.entries(RETIRE_KINDS)) {
    const { row } = panelRow(state, name), held = heldHome(row), drawn = listRow(state, name);
    assert.equal(held.kind, kind, name);
    assert.deepEqual([drawn.mark, drawn.word], ["held", held.state], `${name}: the held mark and the held word, not the harness`);
    assert.equal(fact(detailOf(state, name), "state").value, held.state, `${name}: the detail's state line says the same`);
  }
  const word = (name) => listRow(state, name).word;
  assert.deepEqual(new Set(["r-running", "r-unknown", "r-pending"].map(word)).size, 1, "one word for a retire in progress");
  assert.equal(heldHome(panelRow(state, "r-running").row).hint, undefined, "and no hint: nothing is asked of anyone");
  assert.equal(new Set(["r-running", "r-failed", "r-interrupted"].map(word)).size, 3, "in progress, failed and unfinished read apart");
  assert.equal(word("r-failed"), word("r-failed-code"));
});

test("the detail's held line: the shared home's sentence for a retire in progress or unfinished; for a failed one the kernel's own words after its lead, through the display filter, its code alone when it recorded no message", () => {
  const state = stateOf(observed(RETIRES));
  for (const name of ["r-running", "r-unknown", "r-pending", "r-interrupted"]) {
    const reason = instanceActs(panelRow(state, name).row).limited;
    assert.equal(reason.origin, undefined, `${name}: a sentence of the shared home's`);
    assert.deepEqual(fact(detailOf(state, name), "held"), { label: "held", value: reason.sentence, form: "wrap" }, name);
    assert.equal(reason.sentence.includes(name), true, `${name}: it names the instance`);
  }
  const coded = instanceActs(panelRow(state, "r-failed-code").row).limited;
  assert.deepEqual([coded.origin, coded.sentence], ["kernel", "E_RETIRE_COMPLETION"], "premise: a code with no message is the kernel's word");
  assert.deepEqual(fact(detailOf(state, "r-failed-code"), "held"), { label: "held", value: `${originLead("kernel", TERMS)} E_RETIRE_COMPLETION`, form: "wrap" });
  const reason = instanceActs(panelRow(state, "r-failed").row).limited;
  assert.deepEqual([reason.code, reason.origin, reason.sentence], ["held", "kernel", `${KERNEL_MESSAGE} (E_RETIRE_COMPLETION)`], "premise: the kernel's message and code");
  const said = `${originLead("kernel", TERMS)} ${reason.sentence}`;
  assert.deepEqual(fact(detailOf(state, "r-failed"), "held"), { label: "held", value: said, form: "wrap" });
  // The same reason, said the same way, on the line of a key that opens nothing.
  for (const key of ["S", "X", "enter"]) assert.deepEqual(press(on(state, "r-failed"), [key]).state.outcome, { said: [], under: [said] }, key);
});

test("a failed retire's message from the kernel reaches the screen only through the display filter: a control character withholds it whole, a C1 or bidi control is replaced, a long one is cut; its lead is never why", () => {
  const sentence = (message) => `${message} (E_RETIRE_COMPLETION)`;
  for (const message of ["wipe \x1b[2J now", "bell\x07", "safe\u202Eevil", "a\u009B31mb", "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "x".repeat(5000)]) {
    const label = JSON.stringify(message.slice(0, 20));
    const state = stateOf(observed([instanceRow("dev", "r-failed", { ...STOPPED, retire: retireOf("failed", { code: "E_RETIRE_COMPLETION", message }) })]));
    assert.equal(panelRow(state, "r-failed").row.retire.message, message, `${label}: premise, the row carries it as the kernel sent it`);
    const held = fact(detailOf(state, "r-failed"), "held"), line = displayLine(sentence(message));
    if (line === DETAIL_WITHHELD) {
      assert.equal(textOf(shown(held.value)), DETAIL_WITHHELD, `${label}: withheld whole, the lead with it`);
      assert.equal(held.value.includes(originLead("kernel", TERMS)), false, label);
    } else {
      assert.equal(held.value, `${originLead("kernel", TERMS)} ${line}`, label);
      const drawn = textOf(shown(held.value));
      assert.equal(message.length < 1000 ? drawn === held.value : held.value.startsWith(drawn), true, `${label}: the view shows it as it is, past the filter's bound cut at the end`);
      assert.doesNotMatch(held.value, /[\x00-\x1f\x7f-\x9f\u202a-\u202e]/, label);
      assert.equal(held.value.length < message.length + 40, true, label);
    }
    const d = draw(on(state, "r-failed"), { cols: 120, rows: 40 });
    d.cells.forEach((row) => row.forEach((cell) => assert.doesNotMatch(cell.text, /[\x00-\x1f\x7f-\x9f]/, label)));
  }
  assert.equal(displayLine(sentence("x".repeat(5000))).length < 5000, true, "premise: the long one is cut by the filter");
});

test("which retire a row is: the kernel's facts in the shared order, and a `retire` out of the contract is absent", () => {
  const rows = [
    // A live spawn wins over a retire (the kernel refuses to retire it), and a spawn left half way over both.
    instanceRow("dev", "p-spawning", { ...STOPPED, spawnInProgress: true, retire: retireOf("running") }),
    instanceRow("dev", "p-half-spawned", { ...STOPPED, rollbackIncomplete: true, spawnInProgress: true, retire: retireOf("failed", { message: "m" }) }),
    // The kernel's `retire` wins over its `retirePending`.
    instanceRow("dev", "p-interrupted", { ...STOPPED, retirePending: true, retire: retireOf("interrupted") }),
    // Out of the contract: dropped whole, and the row reads as if it had none.
    instanceRow("dev", "m-state", { ...STOPPED, retire: retireOf("done") }),
    instanceRow("dev", "m-since", { ...STOPPED, retire: { state: "failed", since: 7, self: true } }),
    instanceRow("dev", "m-code", { ...STOPPED, retirePending: true, retire: retireOf("failed", { code: "not-a-code", message: "m" }) }),
    instanceRow("dev", "m-list", { ...STOPPED, retire: [retireOf("running")] }),
  ];
  const state = stateOf(observed(rows));
  const kind = (name) => heldHome(panelRow(state, name).row)?.kind ?? null;
  assert.deepEqual(rows.map((row) => [row.instance, kind(row.instance)]), [
    ["p-spawning", "spawning"], ["p-half-spawned", "spawn-incomplete"], ["p-interrupted", "retire-incomplete"],
    ["m-state", null], ["m-since", null], ["m-code", "retiring"], ["m-list", null],
  ]);
  for (const name of ["m-state", "m-since", "m-code", "m-list"]) assert.equal(Object.hasOwn(panelRow(state, name).row, "retire"), false, `${name}: no retire on the row`);
  for (const name of ["m-state", "m-since", "m-list"]) assert.deepEqual([listRow(state, name).mark, listRow(state, name).word, fact(detailOf(state, name), "state")?.value, fact(detailOf(state, name), "held")], ["stopped", null, "stopped", null], `${name}: an ordinary row: its mark says it, with no word, and the detail reads stopped`);
});

test("a retiring row offers Retire alone: its key opens the confirmation, the cheat sheet names no act, and Enter, stop, start and restart open nothing and say why", () => {
  const state = stateOf(observed(RETIRES));
  for (const name of ["r-running", "r-unknown", "r-pending"]) {
    const selected = on(state, name), acts = instanceActs(panelRow(state, name).row);
    assert.deepEqual(acts.acts.map((act) => [act.verb, act.enabled, act.secondary]), [["retire", true, true]], `${name}: premise, Retire secondary`);
    assert.equal(view(selected).openable, false, `${name}: Enter opens nothing`);
    const opened = press(selected, ["D"]);
    assert.deepEqual([opened.state.view, opened.state.act.verb, opened.effects.map((effect) => effect.act?.verb)], ["act", "retire", ["retire"]], `${name}: D opens the confirmation`);
    for (const key of ["X", "S", "R", "enter"]) {
      const { state: after, effects } = press(selected, [key]);
      assert.deepEqual([after.view, after.act, after.terminal, effects], ["instances", null, null, []], `${name} ${key}: nothing opens`);
      assert.deepEqual(after.outcome, { said: [], under: [acts.limited.sentence] }, `${name} ${key}: the held sentence says why`);
    }
    assert.deepEqual(cheatSheet(selected, { cols: 140, rows: 40 }), SHEET_NO_ENTER, `${name}: neither Retire nor Enter is named`);
  }
  // A failed or unfinished retire: Retire is the way on, and its key opens it; the sheet names no act either.
  for (const name of ["r-failed", "r-failed-code", "r-interrupted"]) {
    assert.equal(press(on(state, name), ["D"]).state.act?.verb, "retire", name);
    assert.deepEqual(cheatSheet(on(state, name), { cols: 140, rows: 40 }), SHEET_NO_ENTER, name);
  }
});

test("a retire this run sent reads as retiring from the store's `retiring`, over whatever the row says; let go, the row reads as it is read, and nothing moves", () => {
  const rows = [instanceRow("dev", "lead"), instanceRow("dev", "half", { ...STOPPED, rollbackIncomplete: true }), instanceRow("dev", "r-failed", { ...STOPPED, retire: retireOf("failed", { message: KERNEL_MESSAGE }) })];
  const state = on(stateOf(observed(rows)), "half"), ids = rows.map((row) => panelRow(state, row.instance).id);
  const before = Object.fromEntries(rows.map((row) => [row.instance, listRow(state, row.instance).word]));
  const step = reduce(state, { retiring: new Set(ids) }), held = step.state;
  assert.equal(step.effect, null);
  for (const row of rows) {
    const { row: drawn } = panelRow(held, row.instance);
    assert.deepEqual([heldHome(drawn).kind, listRow(held, row.instance).word, listRow(held, row.instance).mark], ["retiring", heldHome(drawn).state, "held"], row.instance);
    assert.deepEqual(instanceActs(drawn).acts.map((act) => [act.verb, act.secondary]), [["retire", true]], `${row.instance}: Retire, secondary`);
  }
  assert.equal(fact(detailOf(held, "r-failed"), "held").value, instanceActs(panelRow(held, "r-failed").row).limited.sentence, "the home's own sentence, not the old failure");
  assert.deepEqual([held.selected, roster(held).rows.map((item) => item.id)], [state.selected, roster(state).rows.map((item) => item.id)], "the same rows in the same order, the selection where it was");
  assert.equal(panelOf(held, AT).instances.some((row) => Object.hasOwn(row, "retireInFlight")), false, "the shared panel is as read: only the list's rows are marked");
  // Only the rows named, and let go as the store is told.
  const one = reduce(state, { retiring: new Set([ids[0]]) }).state;
  assert.deepEqual(rows.map((row) => listRow(one, row.instance).word), [listRow(held, "lead").word, before.half, before["r-failed"]]);
  const back = reduce(held, { retiring: new Set() }).state;
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.instance, listRow(back, row.instance).word])), before);
});

// --- Waiting ----------------------------------------------------------------------------

test("a running row with a claim waits: its detail says why in the shared words and for how long at the time of the paint, then quotes its message as the agent's", () => {
  const state = stateOf(observed(WAITERS));
  const { row } = panelRow(state, "child-a"), claim = waitingClaim(row);
  assert.equal(claim.message, "Which base should it use?");
  assert.equal(listRow(state, "child-a").waiting, true);
  assert.equal(listRow(state, "lead").waiting, false);
  const detail = detailOf(state, "child-a");
  assert.deepEqual(fact(detail, "needs"), { label: "needs", value: `${waitingLabel(claim)}, ${waitedText(claim.since, NOW)}`, form: "line" });
  assert.deepEqual(after(detail, "needs"), { label: "", value: `the agent: "${claim.message}"`, form: "wrap" });
  // The waited time is the paint's: an hour later the same state says so.
  const later = NOW + 60 * 60 * 1000;
  assert.notEqual(waitedText(claim.since, later), waitedText(claim.since, NOW));
  assert.equal(fact(detailOf(state, "child-a", later), "needs").value, `${waitingLabel(claim)}, ${waitedText(claim.since, later)}`);
  // Each reason in the shared words, and a reason no table holds in the shared fallback.
  const reasons = stateOf(observed(["permission", "question", "attention", "something-new"].map((reason) => instanceRow("dev", reason, { waitingOnYou: claimOf(reason, "m") }))));
  for (const reason of ["permission", "question", "attention", "something-new"]) {
    assert.equal(fact(detailOf(reasons, reason), "needs").value, `${waitingLabel(claimOf(reason))}, ${waitedText(SINCE, NOW)}`, reason);
  }
  assert.deepEqual(view(state).counts.find((count) => !count.shared), { n: 3, word: "need input", shared: false });
  assert.equal(view(stateOf(observed(WAITERS.slice(0, 2)))).counts.find((count) => !count.shared).n, 1);
});

test("a claim on a row that does not run is not shown: stopped, a shell, unknown", () => {
  const waiting = { waitingOnYou: claimOf("question", "Still there?") };
  const rows = [
    instanceRow("dev", "idle", { ...STOPPED, ...waiting }), instanceRow("dev", "shelly", { running: false, runtimeState: "shell", ...waiting }),
    instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", ...waiting }), instanceRow("dev", "runs", waiting),
  ];
  const state = stateOf(observed(rows));
  for (const name of ["idle", "shelly", "lost"]) {
    assert.equal(panelRow(state, name).row.waitingOnYou.message, "Still there?", "the claim is on the row");
    assert.equal(listRow(state, name).waiting, false, name);
    assert.equal(fact(detailOf(state, name), "needs"), null, name);
    assert.equal(detailOf(state, name).facts.some((f) => f.value.includes("Still there?")), false, name);
  }
  assert.equal(listRow(state, "runs").waiting, true);
  assert.deepEqual(view(state).counts.filter((count) => !count.shared), [{ n: 1, word: "needs input", shared: false }]);
  // A kernel that does not advertise the feature: its claims are dropped at the read.
  const old = stateOf(observed(rows, { cli: { ...CLI, features: CLI.features.filter((feature) => feature !== "waiting-on-you") } }));
  assert.equal(listRow(old, "runs").waiting, false);
});

test("a hostile waiting message never reaches the detail: the row still waits, by its label alone, with no quote line", () => {
  // The shared reader nulls such a message when it reads the kernel's row (waiting-on-you.mjs
  // `waitingOnYouData`, called by the deployment reader): what arrives in a panel row is
  // `message: null`. The first row is that. The other two leave the hostile text in the row, as
  // if a reader had not: the shared `waitingClaim` reads the claim again and nulls it too.
  const rows = [
    instanceRow("dev", "as-it-arrives", { waitingOnYou: claimOf("permission", null) }),
    instanceRow("dev", "control", { waitingOnYou: claimOf("permission", "run \x1b[31mthis\x07") }),
    instanceRow("dev", "override", { waitingOnYou: claimOf("permission", "safe \u202Eevil") }),
  ];
  const state = stateOf(observed(rows));
  for (const name of rows.map((row) => row.instance)) {
    const claim = waitingClaim(panelRow(state, name).row);
    assert.equal(claim.message, null, name);
    assert.equal(listRow(state, name).waiting, true, name);
    const detail = detailOf(state, name);
    assert.equal(fact(detail, "needs").value, `${waitingLabel(claim)}, ${waitedText(SINCE, NOW)}`, name);
    assert.equal(after(detail, "needs").label, "harness", `${name}: the next fact is the next label, not a quote`);
    assert.equal(detail.facts.some((f) => f.label === "" || f.value.includes("the agent") || f.value.includes("evil") || f.value.includes("\x1b")), false, name);
  }
});

// --- The roll-up ------------------------------------------------------------------------

test("a collapsed row counts the instances it folds away and the rows that wait below it, and names those in the shared words; expanded, it counts none and each child carries its own mark", () => {
  const open = stateOf(observed(WAITERS));
  assert.deepEqual(view(open).list.filter(Boolean).map((row) => [row.name, row.waiting, row.folded, row.below]), [["Lead", false, 0, 0], ["Child a", true, 0, 0], ["Grandchild", true, 0, 0], ["Child b", false, 0, 0], ["Solo", true, 0, 0]]);
  assert.equal(fact(detailOf(open, "lead"), "below"), null);
  const closed = press(open, ["h"]).state; // the first row, the selected one, is the cluster's root
  assert.equal(closed.collapsed.has(collapseKey(DEPLOYMENT, panelRow(open, "lead").id)), true);
  const under = waitingRollup(sharedPanel(closed).instances, closed.collapsed, DEPLOYMENT, { filtering: false, stale: () => false }).get(panelRow(closed, "lead").id);
  assert.deepEqual(under.map((row) => row.instance).sort(), ["child-a", "grandchild"]);
  const lead = listRow(closed, "lead");
  assert.deepEqual({ below: lead.below, waiting: lead.waiting, folded: lead.folded }, { below: 2, waiting: false, folded: 3 });
  assert.equal(disclosure(closed, roster(closed), panelRow(closed, "lead")), "closed");
  assert.deepEqual(fact(detailOf(closed, "lead"), "below"), { label: "below", value: waitingBelowText(under), form: "wrap" });
  assert.equal(after(detailOf(closed, "lead"), "state").label, "below", "after the state, before the harness");
  // A row that waits itself and has one waiting below it: both are said.
  const mid = folded(open, "child-a"), child = listRow(mid, "child-a");
  assert.deepEqual({ below: child.below, waiting: child.waiting, folded: child.folded }, { below: 1, waiting: true, folded: 1 });
  assert.equal(listRow(mid, "lead").below, 0, "the root is open: nothing is hidden right below it that it must answer for");
  assert.equal(listRow(mid, "lead").folded, 0, "and it folds nothing away itself");
  // A fold inside a fold: the outer row counts every instance under it, the inner fold's too.
  const both = Object.freeze({ ...open, collapsed: new Set(["lead", "child-a"].map((name) => collapseKey(open.open, panelRow(open, name).id))) });
  assert.deepEqual(listed(both).sort(), ["lead", "solo"]);
  assert.deepEqual([listRow(both, "lead").folded, listRow(both, "lead").below], [3, 2]);
  assert.deepEqual(labels(detailOf(mid, "child-a")).slice(0, 5), ["soul", "state", "needs", "", "below"]);
  // Collapsed over rows that do not wait: no count and no line.
  const quiet = folded(stateOf(observed(TREE)), "lead");
  assert.equal(listRow(quiet, "lead").below, 0);
  assert.equal(listRow(quiet, "lead").folded, roster(stateOf(observed(TREE))).rows.length - roster(quiet).rows.length, "the count is the rows the fold hides");
  assert.equal(fact(detailOf(quiet, "lead"), "below"), null);
  // The model counts every waiting row, drawn or not.
  assert.equal(view(closed).counts.find((count) => !count.shared).n, 3);
});

// --- The filter -------------------------------------------------------------------------

test("a filter that matches a row under a collapsed parent shows it with its ancestors, leaves the collapse set as it is, and reads every disclosure as open", () => {
  const closed = folded(stateOf(observed(WAITERS)), "lead");
  assert.deepEqual(listed(closed).sort(), ["lead", "solo"], "the rows below the collapsed root are gone from the list");
  const lead = panelRow(closed, "lead");
  assert.equal(disclosure(closed, roster(closed), lead), "closed");
  const filtering = press(closed, ["/", "g", "r", "a", "n", "d", "enter"]).state;
  assert.deepEqual(listed(filtering), ["lead", "child-a", "grandchild"]);
  assert.equal(filtering.collapsed, closed.collapsed, "the same set");
  assert.deepEqual([...filtering.collapsed], [collapseKey(DEPLOYMENT, lead.id)]);
  const r = roster(filtering);
  assert.deepEqual(r.rows.map((item) => disclosure(filtering, r, item)), ["open", "open", null]);
  assert.deepEqual(view(filtering).list.filter(Boolean).map((row) => [row.name, row.folded, row.below]), [["Lead", 0, 0], ["Child a", 0, 0], ["Grandchild", 0, 0]], "nothing is folded away or rolled up while every match is shown");
  // While the field is still open it is the same.
  const typing = press(closed, ["/", "g", "r"]).state;
  assert.deepEqual(listed(typing), ["lead", "child-a", "grandchild"]);
  assert.equal(disclosure(typing, roster(typing), panelRow(typing, "lead")), "open");
  // The filter cleared: the row is collapsed as before.
  const cleared = press(filtering, ["escape"]).state;
  assert.deepEqual(listed(cleared).sort(), ["lead", "solo"]);
  assert.equal(disclosure(cleared, roster(cleared), panelRow(cleared, "lead")), "closed");
  // A query of spaces alone filters nothing and hides nothing.
  const spaces = Object.freeze({ ...closed, filter: Object.freeze({ editing: true, query: "  " }) });
  assert.deepEqual(listed(spaces).sort(), ["lead", "solo"]);
  assert.equal(disclosure(spaces, roster(spaces), panelRow(spaces, "lead")), "closed");
});

test("the filter matches by name, by soul and by repository, whatever the case, through the shared matcher", () => {
  const rows = [instanceRow("acme-expert", "tui-reader"), instanceRow("dev", "plain", { repo: `${DEPLOYMENT}/Desktop-App` }), instanceRow("dev", "other")];
  const state = stateOf(observed(rows));
  const query = (text) => names(Object.freeze({ ...state, filter: Object.freeze({ editing: false, query: text }) })).sort();
  assert.deepEqual(query("READER"), ["tui-reader"]);
  assert.deepEqual(query("expert"), ["tui-reader"]);
  assert.deepEqual(query("desktop-app"), ["plain"]);
  assert.deepEqual(query(" other "), ["other"], "the ends are trimmed");
  for (const text of ["reader", "dev", "desktop", "nothing"]) {
    const s = Object.freeze({ ...state, filter: Object.freeze({ editing: false, query: text }) });
    assert.deepEqual(drawnRows(s), sharedRows(s), text);
  }
});

// --- Withheld rows and the counts -------------------------------------------------------

test("withheld rows are counted, the help's top row says how many, and they are never drawn as rows", () => {
  const withheld = [{ agent: "dev", instance: "twice", reason: "duplicate-home" }, { agent: "dev", instance: "astray", reason: "home-outside-soul" }];
  const state = stateOf(observed(solos("a", "b"), { withheld }));
  assert.equal(sharedPanel(state).deployment.withheld.length, 2);
  assert.deepEqual(view(state).counts.find((count) => count.word === "withheld"), { n: 2, word: "withheld", shared: false });
  assert.deepEqual(names(state), ["a", "b"]);
  assert.deepEqual(view(state).list.map((row) => row.name), ["A", "B"]);
  assert.equal(view(stateOf(observed(solos("a", "b"), { withheld: [] }))).counts.some((count) => count.word === "withheld"), false, "none withheld: no count");
  // The help's top row, after the time of the read; none withheld, the time alone.
  const top = (s) => { const d = draw(press(s, ["?"]).state); return d.lines[0].slice(d.cols + 1).trim(); };
  assert.equal(top(state), `read ${clockTime("2026-10-11T10:00:00.000Z")}  2 withheld`);
  assert.equal(top(stateOf(observed(solos("a", "b"), { withheld: [] }))), `read ${clockTime("2026-10-11T10:00:00.000Z")}`);
  // A stale entry still holds the observation's withheld rows; an unavailable one has none to count.
  assert.equal(view(stateOf(failed(observed(solos("a"), { withheld }), UNREADABLE))).counts.find((count) => count.word === "withheld").n, 2);
  assert.equal(view(stateOf(failed(observed(solos("a"), { withheld }), TIMEOUT))).counts.length, 0);
});

test("the three state counts the model holds are the shared counts of the panel's rows, and a count of zero is left out; no count stands on the screen any more, but the withheld on the help's top row", () => {
  const mixes = {
    "running and stopped": [...solos("a", "b"), instanceRow("dev", "c", STOPPED)],
    "all three": [...solos("a"), instanceRow("dev", "c", STOPPED), instanceRow("dev", "d", STOPPED), instanceRow("dev", "e", { running: null, runtimeState: "unreachable" })],
    "only stopped": [instanceRow("dev", "c", STOPPED)],
    "only unknown": [instanceRow("dev", "e", { running: null, runtimeState: "unsupported" })],
    "the tree": TREE,
    none: [],
  };
  for (const [what, rows] of Object.entries(mixes)) {
    const state = stateOf(observed(rows)), shared = runtimeCounts(sharedPanel(state).instances), counts = view(state).counts;
    assert.deepEqual(Object.keys(shared).sort(), ["running", "stopped", "unknown"]);
    for (const [word, n] of Object.entries(shared)) {
      assert.deepEqual(counts.filter((count) => count.word === word), n > 0 ? [{ n, word, shared: true }] : [], `${what}: ${word}`);
    }
    assert.equal(counts.every((count) => count.n > 0), true, what);
    assert.equal(counts.reduce((sum, count) => sum + (count.shared ? count.n : 0), 0), rows.length, what);
  }
  assert.deepEqual(view(stateOf(observed(mixes["all three"]))).counts.map((count) => count.word), ["running", "stopped", "unknown"], "in the order the shared count gives");
  // With the TUI's two counts: the waiting ones right after the running ones, the withheld last.
  const full = stateOf(observed([...WAITERS, instanceRow("dev", "idle", STOPPED), instanceRow("dev", "lost", { running: null, runtimeState: "unreachable" })], { withheld: [{ agent: "dev", instance: "twice", reason: "duplicate-home" }] }));
  assert.deepEqual(view(full).counts.map((count) => [count.n, count.word]), [[5, "running"], [3, "need input"], [1, "stopped"], [1, "unknown"], [1, "withheld"]]);
  // The header that drew them is gone: the view's frame names none, the help's top row the withheld alone.
  const counted = /\b\d+ (running|need input|needs input|stopped|unknown|withheld)\b/;
  assert.equal(draw(full, { cols: 120, rows: 40 }).lines.some((line) => counted.test(line)), false);
  const help = draw(press(full, ["?"]).state);
  assert.deepEqual(help.lines.filter((line) => counted.test(line)).map((line) => line.slice(help.cols + 1).trim()), [`read ${clockTime("2026-10-11T10:00:00.000Z")}  1 withheld`]);
});

// --- The detail -------------------------------------------------------------------------

test("the detail's facts stand in the order of the spec's table: soul, state, its reason, held, needs, the message, below, harness, work, team, parent, started, home", () => {
  // One row made to hold every fact at once, so that each conditional line shows its place: it
  // runs, waits with a message, carries a reason, is a held home, and is collapsed over a row
  // that waits.
  const rows = [
    instanceRow("dev", "lead"),
    instanceRow("dev", "mid", { parentInstance: "lead", runtimeError: "the last probe was slow", rollbackIncomplete: true, waitingOnYou: claimOf("question", "Go on?") }),
    instanceRow("dev", "kid", { parentInstance: "mid", waitingOnYou: claimOf("permission") }),
  ];
  // Read as a cycle reads it: the row is probed, the check has nothing to say of it, and the
  // reason the kernel's row carried stays the kernel's.
  const read = stateOf(cycle(rows).entry), state = on(folded(read, "mid"), "mid");
  const { row } = panelRow(state, "mid"), detail = view(state).detail;
  assert.equal(detail.title, "mid");
  assert.deepEqual(labels(detail), ["soul", "state", "", "held", "needs", "", "below", "harness", "work", "team", "parent", "started", "home"]);
  assert.deepEqual(fact(detail, "soul"), { label: "soul", value: "dev", form: "line" });
  assert.equal(row.runtimeError, "the last probe was slow");
  assert.deepEqual(after(detail, "state"), { label: "", value: `OATS says: ${row.runtimeError}`, form: "wrap" });
  assert.equal(fact(detail, "held").value, instanceActs(row).limited.sentence);
  assert.equal(after(detail, "needs").value, `the agent: "${waitingClaim(row).message}"`);
  assert.equal(fact(detail, "below").value, waitingBelowText([panelRow(read, "kid").row]));
  assert.deepEqual(fact(detail, "harness"), { label: "harness", value: `${row.harness}, ${row.model} (${row.modelFrom})`, form: "line" });
  assert.deepEqual(fact(detail, "work"), { label: "work", value: `${row.work}, ${row.branch}`, form: "line" });
  assert.deepEqual(fact(detail, "team"), { label: "team", value: "eng", form: "line" });
  assert.deepEqual(fact(detail, "parent"), { label: "parent", value: "lead", form: "line" });
  assert.deepEqual(fact(detail, "started"), { label: "started", value: waitingClock(row.startedAt, NOW), form: "line" });
  assert.deepEqual(fact(detail, "home"), { label: "home", value: row.home, form: "end" });
  assert.equal(row.home, instanceRow("dev", "mid").home);
});

test("a plain instance's detail has the eight lines the table always gives, less the ones whose value is absent", () => {
  const plain = detailOf(stateOf(observed(TREE)), "child-a");
  assert.deepEqual(labels(plain), ["soul", "state", "harness", "work", "team", "parent", "started", "home"]);
  assert.deepEqual(labels(detailOf(stateOf(observed(TREE)), "lead")), ["soul", "state", "harness", "work", "team", "started", "home"], "a root has no parent line");
  const without = (extra, options) => labels(detailOf(stateOf(cycle([instanceRow("dev", "bare", extra)], options).entry), "bare"));
  assert.deepEqual(without({}), ["soul", "state", "harness", "work", "team", "started", "home"]);
  assert.deepEqual(without({ startedAt: undefined }), ["soul", "state", "harness", "work", "team", "home"], "never started");
  assert.deepEqual(without({ harness: null, model: null }), ["soul", "state", "work", "team", "started", "home"], "no harness reported");
  assert.deepEqual(without({}, { team: null }), ["soul", "state", "harness", "work", "started", "home"], "a soul in no team");
  assert.deepEqual(without({ work: null, branch: null }), ["soul", "state", "harness", "team", "started", "home"], "no work mode and no branch");
  assert.deepEqual(without({ startedAt: undefined, harness: null, model: null, work: null, branch: null }, { team: null }), ["soul", "state", "home"]);
});

test("the detail's harness, work, parent and started lines: the model's origin in brackets only with a model, the branch only when there is one, a sibling named as one, and the start as the shared clock reads it at the paint", () => {
  const value = (extra, label, now = NOW) => fact(detailOf(stateOf(observed([instanceRow("dev", "one", extra), instanceRow("dev", "peer-2")])), "one", now), label)?.value ?? null;
  assert.equal(value({}, "harness"), "claude, claude-opus-5-5 (soul)");
  assert.equal(value({ modelFrom: "launch" }, "harness"), "claude, claude-opus-5-5 (launch)", "the field's own value");
  assert.equal(value({ modelFrom: undefined }, "harness"), "claude, claude-opus-5-5", "no origin said: no brackets");
  assert.equal(value({ model: null, modelFrom: "soul" }, "harness"), "claude", "an origin without a model is not shown");
  assert.equal(value({ harness: "codex", model: "gpt-5" }, "harness"), "codex, gpt-5 (soul)");
  assert.equal(value({ branch: null }, "work"), "worktree");
  assert.equal(value({ work: "attached", branch: "main" }, "work"), "attached, main");
  assert.equal(value({ siblingInstance: "peer-2", relation: "sibling", relativeTo: "peer-2" }, "parent"), "sibling of peer-2");
  assert.equal(value({ parentInstance: "peer-2" }, "parent"), "peer-2");
  assert.equal(value({}, "parent"), null);
  // The start: on the day of the paint a time, on another day with its date, in another year with the year.
  const started = "2026-10-11T09:00:00.000Z";
  for (const now of [NOW, NOW + 3 * 24 * 60 * 60 * 1000, NOW + 400 * 24 * 60 * 60 * 1000]) assert.equal(value({ startedAt: started }, "started", now), waitingClock(started, now));
  assert.equal(new Set([NOW, NOW + 3 * 24 * 60 * 60 * 1000, NOW + 400 * 24 * 60 * 60 * 1000].map((now) => value({ startedAt: started }, "started", now))).size, 3, "three forms, by the paint's day");
  assert.equal(value({ startedAt: started }, "started"), "09:00");
});

test("the detail's parent line names the siblings the shared home resolves (#1315): both ends of a link, in its words; nothing for a name that resolves to no instance or to two; direct links only; whatever is filtered", () => {
  const parentOf = (state, name, soul) => fact(view(on(state, name, soul)).detail, "parent")?.value ?? null;
  const pair = stateOf(observed([instanceRow("dev", "anchor"), instanceRow("dev", "twin", { siblingInstance: "anchor" })]));
  assert.equal(parentOf(pair, "twin"), "sibling of anchor");
  assert.equal(parentOf(pair, "anchor"), "sibling of twin", "the other end of the link says so too");
  // Three, in the roster's order and the shared words.
  const three = stateOf(observed([instanceRow("dev", "anchor"), ...["peer-c", "peer-a", "peer-b"].map((name) => instanceRow("dev", name, { siblingInstance: "anchor" }))]));
  assert.equal(parentOf(three, "anchor"), "sibling of peer-a, peer-b and peer-c");
  assert.equal(parentOf(three, "anchor"), siblingText(instanceSiblings(sharedPanel(three).instances).get(panelRow(three, "anchor").id)));
  assert.equal(parentOf(three, "peer-b"), "sibling of anchor", "peers linked to one anchor are not each other's siblings");
  // The parent stays first.
  const kid = stateOf(observed([instanceRow("dev", "lead"), instanceRow("dev", "kid", { parentInstance: "lead" }), instanceRow("dev", "twin", { siblingInstance: "kid" })]));
  assert.equal(parentOf(kid, "kid"), "lead, sibling of twin");
  assert.equal(parentOf(kid, "lead"), null);
  // A name that resolves to no instance, or to two of one deployment: nothing, at either end.
  const ghost = stateOf(observed([instanceRow("dev", "peer", { siblingInstance: "ghost" }), instanceRow("dev", "other")]));
  assert.deepEqual([parentOf(ghost, "peer"), parentOf(ghost, "other")], [null, null]);
  const two = stateOf(observed([instanceRow("soul-a", "coord"), instanceRow("soul-b", "coord"), instanceRow("dev", "peer", { siblingInstance: "coord" })]));
  assert.deepEqual([parentOf(two, "peer"), parentOf(two, "coord", "soul-a"), parentOf(two, "coord", "soul-b")], [null, null, null]);
  // A filter that hides one of the two names makes it no less ambiguous: the roster is the whole one.
  const filtered = Object.freeze({ ...two, filter: Object.freeze({ editing: false, query: "peer" }) });
  assert.deepEqual(roster(filtered).rows.map((item) => item.row.instance), ["peer"]);
  assert.equal(parentOf(filtered, "peer"), null);
  assert.equal(parentOf(Object.freeze({ ...pair, filter: Object.freeze({ editing: false, query: "twin" }) }), "twin"), "sibling of anchor", "a sibling filtered out is still named");
  // A chain C→B→A: B has both, and A and C are not each other's.
  const chain = stateOf(observed([instanceRow("dev", "a"), instanceRow("dev", "b", { siblingInstance: "a" }), instanceRow("dev", "c", { siblingInstance: "b" })]));
  assert.deepEqual(["a", "b", "c"].map((name) => parentOf(chain, name)), ["sibling of b", "sibling of a and c", "sibling of b"]);
});

test("the detail is the selected instance's, and there is none when nothing is selected or the selection is not drawn", () => {
  const state = stateOf(observed(TREE));
  assert.equal(view(state).detail.title, "alpha", "the first row is selected by the first answer");
  assert.equal(view(on(state, "solo-y")).detail.title, "solo-y");
  assert.equal(view(Object.freeze({ ...state, selected: null })).detail, null);
  assert.equal(view(Object.freeze({ ...state, selected: "/not/a/home" })).detail, null);
  assert.equal(view(Object.freeze({ ...state, selected: "/not/a/home" })).list.some((row) => row?.selected), false);
  // Two instances with one name in two souls: each has its own detail.
  const twins = stateOf(observed([instanceRow("soul-a", "twin"), instanceRow("soul-b", "twin", STOPPED)]));
  assert.deepEqual(["soul-a", "soul-b"].map((soul) => fact(view(on(twins, "twin", soul)).detail, "soul").value), ["soul-a", "soul-b"]);
  assert.deepEqual(["soul-a", "soul-b"].map((soul) => listRow(twins, "twin", soul).mark), ["running", "stopped"]);
});

// --- Only the pane is laid out ----------------------------------------------------------

/** 300 instances; the shared grouping walks the roster for each row, so not the 10 000 of the bound. */
const CROWD = [
  ...Array.from({ length: 299 }, (_, i) => instanceRow("dev", `inst-${String(i).padStart(3, "0")}`)),
  instanceRow("dev", "zzz-last", { running: null, runtimeState: "unreachable" }),
];

test("only the rows in the pane are laid out, however many instances there are", () => {
  const state = stateOf(observed(CROWD));
  assert.equal(roster(state).rows.length, 300);
  for (const page of [10, 19, 1, 0]) {
    const m = view(state, page);
    assert.equal(m.list.length <= page, true, `a pane of ${page} rows lays out ${m.list.length}`);
    assert.equal(m.above + m.list.length + m.below, 300, `page ${page}`);
  }
  const m = view(on(state, "inst-150"), 10);
  assert.equal(m.list.length, 9, "a pane of 10 rows, its last row saying what is cut off");
  assert.equal(m.list.some((row) => row.selected && row.name === "Inst 150"), true, "the selected row is among them");
  assert.deepEqual(m.list.map((row) => row.id), roster(state).items.slice(m.above, m.above + 9).map((item) => item.id), "the rows of the window, in order");
});

test("the word column is as wide as the widest word among all the rows of the list, drawn or not, and never wider than its cap; a list where every mark says it all has none", () => {
  const state = stateOf(observed(CROWD));
  const top = view(state, 10);
  assert.equal(top.list.some((row) => row.name === "Zzz last"), false, "the row with the widest word is far below the pane");
  assert.equal(top.list.every((row) => row.word === null), true, "a row that runs has no word");
  assert.equal(top.wordWidth, rowReason(panelRow(state, "zzz-last").row).label.length);
  assert.equal(view(on(state, "zzz-last"), 10).wordWidth, top.wordWidth, "the column does not move while the list scrolls");
  // After the filter: a row the filter hides lends no width.
  assert.equal(view(press(state, ["/", "i", "n", "s", "t", "enter"]).state, 10).wordWidth, 0);
  assert.equal(WORD_MAX, 20);
  const wide = stateOf(observed([...solos("a", "b"), instanceRow("dev", "wordy", { running: null, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: this backend is gone", tmux: null })]));
  const label = rowReason(panelRow(wide, "wordy").row).label;
  assert.equal(label.length > WORD_MAX, true, "the shared label is wider than the column");
  assert.equal(view(wide).wordWidth, WORD_MAX);
  assert.equal(view(wide).list.find((row) => row.name === "Wordy").word, label, "the word is given whole: the view cuts it");
  assert.equal(view(stateOf(observed([]))).wordWidth, 0);
});

// --- The window -------------------------------------------------------------------------

test("the window of a pane: all the rows when they fit, else one row less than the pane, with what is cut off above and below", () => {
  const cases = [
    ["fits", { top: 0, count: 5, height: 10 }, { top: 0, size: 5, above: 0, below: 0 }],
    ["fits exactly", { top: 0, count: 10, height: 10 }, { top: 0, size: 10, above: 0, below: 0 }],
    ["fits, whatever top was", { top: 7, count: 5, height: 10 }, { top: 0, size: 5, above: 0, below: 0 }],
    ["one row too many", { top: 0, count: 11, height: 10 }, { top: 0, size: 9, above: 0, below: 2 }],
    ["cut below", { top: 0, count: 40, height: 19 }, { top: 0, size: 18, above: 0, below: 22 }],
    ["cut above and below", { top: 10, count: 40, height: 19 }, { top: 10, size: 18, above: 10, below: 12 }],
    ["cut above", { top: 22, count: 40, height: 19 }, { top: 22, size: 18, above: 22, below: 0 }],
    ["a top past the end is the last window", { top: 500, count: 40, height: 19 }, { top: 22, size: 18, above: 22, below: 0 }],
    ["a top before the start is the first", { top: -3, count: 40, height: 19 }, { top: 0, size: 18, above: 0, below: 22 }],
    ["no top is the first window", { count: 40, height: 19 }, { top: 0, size: 18, above: 0, below: 22 }],
    ["the kept row is the window's last: nothing moves", { top: 0, count: 40, height: 19, keep: 17 }, { top: 0, size: 18, above: 0, below: 22 }],
    ["the kept row is one below the window: one row down", { top: 0, count: 40, height: 19, keep: 18 }, { top: 1, size: 18, above: 1, below: 21 }],
    ["the kept row is the window's first: nothing moves", { top: 10, count: 40, height: 19, keep: 10 }, { top: 10, size: 18, above: 10, below: 12 }],
    ["the kept row is one above the window: one row up", { top: 10, count: 40, height: 19, keep: 9 }, { top: 9, size: 18, above: 9, below: 13 }],
    ["the kept row is the last of all", { top: 0, count: 40, height: 19, keep: 39 }, { top: 22, size: 18, above: 22, below: 0 }],
    ["the kept row is the first of all", { top: 22, count: 40, height: 19, keep: 0 }, { top: 0, size: 18, above: 0, below: 22 }],
    ["no kept row", { top: 10, count: 40, height: 19, keep: -1 }, { top: 10, size: 18, above: 10, below: 12 }],
    ["a kept row that does not exist is no kept row", { top: 10, count: 40, height: 19, keep: 40 }, { top: 10, size: 18, above: 10, below: 12 }],
    ["a pane of no rows shows none", { top: 3, count: 40, height: 0 }, { top: 0, size: 0, above: 0, below: 40 }],
    ["a pane of no rows, with a kept row", { top: 3, count: 40, height: 0, keep: 5 }, { top: 0, size: 0, above: 0, below: 40 }],
    ["no rows", { top: 3, count: 0, height: 19 }, { top: 0, size: 0, above: 0, below: 0 }],
    ["a pane of one row and one row", { top: 0, count: 1, height: 1 }, { top: 0, size: 1, above: 0, below: 0 }],
    ["a pane of one row shows the kept row", { top: 0, count: 40, height: 1, keep: 5 }, { top: 5, size: 1, above: 5, below: 34 }],
    ["a pane of two rows shows one and says the rest", { top: 0, count: 40, height: 2, keep: 5 }, { top: 5, size: 1, above: 5, below: 34 }],
  ];
  for (const [what, input, expected] of cases) assert.deepEqual(windowOf(input), expected, what);
});

test("the window, for every small pane, count, top and kept row: it never passes the pane, loses no row, holds the kept row, and moves the least", () => {
  for (let count = 0; count <= 14; count++) for (let height = 0; height <= 9; height++) for (let top = -1; top <= count + 1; top++) {
    const free = windowOf({ top, count, height });
    for (let keep = -1; keep <= count; keep++) {
      const win = windowOf({ top, count, height, keep }), where = `count ${count}, height ${height}, top ${top}, keep ${keep}`;
      assert.equal(win.size <= height && win.size >= 0, true, where);
      assert.equal(win.above + win.size + win.below, count, where);
      assert.equal(win.above, win.top, where);
      if (count > height && height >= 2) assert.equal(win.size, height - 1, `${where}: the last row is given up to say what is cut off`);
      if (count <= height) assert.deepEqual(win, { top: 0, size: count, above: 0, below: 0 }, where);
      const kept = keep >= 0 && keep < count && win.size > 0;
      if (kept) assert.equal(keep >= win.top && keep < win.top + win.size, true, `${where}: the kept row is inside`);
      // The least: a window that already held the row is not moved, and one that did not ends with the row at its edge.
      const held = keep >= free.top && keep < free.top + free.size;
      if (!kept || held) assert.equal(win.top, free.top, `${where}: nothing to move for`);
      else assert.equal(win.top === keep || win.top + win.size - 1 === keep, true, `${where}: the row at the nearer edge`);
    }
  }
});

test("the model's window is the store's top corrected for the pane, and its cut counts are the window's", () => {
  const rows = Array.from({ length: 40 }, (_, i) => instanceRow("dev", `inst-${String(i).padStart(2, "0")}`));
  const state = stateOf(observed(rows));
  const at = (name, top, page) => view(Object.freeze({ ...on(state, name), top }), page);
  const cut = (m) => [m.above, m.list.length, m.below, m.list[0]?.name ?? null];
  assert.deepEqual(cut(at("inst-00", 0, 19)), [0, 18, 22, "Inst 00"]);
  assert.deepEqual(cut(at("inst-17", 0, 19)), [0, 18, 22, "Inst 00"], "the last row of the window");
  assert.deepEqual(cut(at("inst-18", 0, 19)), [1, 18, 21, "Inst 01"], "one past it");
  assert.deepEqual(cut(at("inst-20", 10, 19)), [10, 18, 12, "Inst 10"]);
  assert.deepEqual(cut(at("inst-39", 0, 19)), [22, 18, 0, "Inst 22"]);
  assert.deepEqual(cut(at("inst-39", 22, 40)), [0, 40, 0, "Inst 00"], "a pane that holds them all");
  assert.deepEqual(cut(at("inst-30", 13, 10)), [22, 9, 9, "Inst 22"], "a shorter pane than the top was kept for");
  assert.deepEqual(cut(at("inst-05", 0, 0)), [0, 0, 40, null], "a pane of no rows");
  for (const [name, top, page] of [["inst-00", 0, 19], ["inst-18", 0, 19], ["inst-39", 5, 7], ["inst-12", 30, 4], ["inst-25", 25, 2]]) {
    const m = at(name, top, page), win = windowOf({ top, count: 40, height: page, keep: Number(name.slice(5)) });
    assert.deepEqual([m.above, m.below, m.list.length], [win.above, win.below, win.size], `${name}, top ${top}, page ${page}`);
    assert.equal(m.list.some((row) => row.selected), true, "the selected row is drawn");
  }
});

// --- Relations the shared home has to make sense of -------------------------------------

test("a parent that is gone, a parent cycle and an ambiguous parent name: nothing throws and every instance is drawn exactly once", () => {
  const cases = {
    "a parent that is gone": [instanceRow("dev", "orphan", { parentInstance: "ghost" }), instanceRow("dev", "other")],
    "a cycle of two": [instanceRow("dev", "a", { parentInstance: "b" }), instanceRow("dev", "b", { parentInstance: "a" }), instanceRow("dev", "other")],
    "a cycle of three under a root": [instanceRow("dev", "a", { parentInstance: "c" }), instanceRow("dev", "b", { parentInstance: "a" }), instanceRow("dev", "c", { parentInstance: "b" }), instanceRow("dev", "kid", { parentInstance: "a" })],
    "its own parent": [instanceRow("dev", "self", { parentInstance: "self" }), instanceRow("dev", "other")],
    "an ambiguous parent name": [instanceRow("soul-a", "coord"), instanceRow("soul-b", "coord"), instanceRow("dev", "kid", { parentInstance: "coord" }), instanceRow("dev", "grandkid", { parentInstance: "kid" })],
    "a sibling that is gone": [instanceRow("dev", "peer", { siblingInstance: "ghost" }), instanceRow("dev", "other")],
  };
  for (const [what, rows] of Object.entries(cases)) {
    const state = stateOf(observed(rows)), ids = roster(state).rows.map((item) => item.id);
    assert.equal(ids.length, rows.length, `${what}: every instance is drawn`);
    assert.equal(new Set(ids).size, rows.length, `${what}: once`);
    assert.deepEqual(drawnOrder(state), sharedOrder(state), `${what}: as the shared grouping answers`);
    // Each row drawn, selected, collapsed and filtered for: no throw, and still every instance once.
    for (const item of roster(state).rows) {
      const selected = Object.freeze({ ...state, selected: item.id });
      assert.equal(view(selected).detail.title, item.row.instance, what);
      const closed = Object.freeze({ ...selected, collapsed: new Set([collapseKey(DEPLOYMENT, item.id)]) });
      const drawn = roster(closed).rows.map((row) => row.id);
      assert.equal(new Set(drawn).size, drawn.length, `${what}: no row twice with ${item.row.instance} collapsed`);
      assert.equal(drawn.includes(item.id), true, `${what}: a collapsed row is itself drawn`);
      assert.doesNotThrow(() => view(closed), what);
      const filtered = Object.freeze({ ...closed, filter: Object.freeze({ editing: false, query: item.row.instance }) });
      assert.equal(roster(filtered).rows.some((row) => row.id === item.id), true, `${what}: a filter for a row's name shows it`);
      assert.doesNotThrow(() => view(filtered), what);
      assert.doesNotThrow(() => press(selected, ["h", "h", "l", "l", "j", "k"]), what);
    }
  }
  // The ambiguous name joins nothing: the child is under neither of the two it could mean.
  const ambiguous = stateOf(observed(cases["an ambiguous parent name"]));
  assert.equal(panelRow(ambiguous, "kid").depth, 0);
  assert.deepEqual(roster(ambiguous).rows.filter((item) => item.row.instance === "coord").map((item) => disclosure(ambiguous, roster(ambiguous), item)), [null, null]);
  assert.equal(disclosure(ambiguous, roster(ambiguous), panelRow(ambiguous, "kid")), "open", "its own child is still its child");
});

// --- Clock times ------------------------------------------------------------------------

test("clockTime reads an ISO time as a local clock time, and anything else as none", () => {
  assert.equal(clockTime("2026-10-11T14:03:27.000Z"), "14:03:27");
  assert.equal(clockTime("2026-01-02T03:04:05.000Z"), "03:04:05", "two digits each");
  assert.equal(clockTime("2026-10-11T00:00:00.000Z"), "00:00:00");
  assert.equal(clockTime("2026-10-11T16:03:27.000+02:00"), "14:03:27", "local, whatever zone the string names");
  const at = new Date("2026-10-11T23:59:59.000Z");
  assert.equal(clockTime(at.toISOString()), [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":"));
  for (const invalid of ["", "yesterday", "14:03:27", "2026-13-45T99:99:99.000Z", "not a time"]) assert.equal(clockTime(invalid), null, JSON.stringify(invalid));
  for (const other of [null, undefined, 0, 1760176800000, NaN, true, {}, [], new Date(NOW)]) assert.equal(clockTime(other), null, String(other));
});

// --- Other machines: fixtures in the kernel's forms -------------------------------------

/** A workspace identity as a deployment reports it (the kernel's `workspace` object), and the
 *  same for another workspace. */
const IDENTITY = Object.freeze({ key: "github.com/acme/platform", ref: "main", keyFrom: "workspace", standalone: false, defaultTeam: Object.freeze({ label: "eng", team: "team-1" }), teams: Object.freeze({ eng: "team-1" }), teamsFrom: "observed" });
const LEDGER = Object.freeze({ ...IDENTITY, key: "github.com/acme/ledger" });
/** A standalone deployment's identity: its teams are local, which the shared home says in a note. */
const STANDALONE = Object.freeze({ key: "github.com/acme/platform", ref: "main", keyFrom: "workspace", standalone: true, defaultTeam: null, teams: Object.freeze({}), teamsFrom: "local" });
/** A kernel record that reads other machines (the shared `cliReadsRemotes`). */
const READS = Object.freeze({ ...CLI, remote: Object.freeze(["roster"]) });
/** A second deployment of this machine. */
const SECOND = "/srv/deploy-b";
/** A row of helpers.mjs `instanceRow`, homed in another deployment of this machine. */
const homedIn = (dir, row) => ({ ...row, home: `${dir}/agents/${row.agent}/instances/${row.instance}`, repo: `${dir}/oats` });
/** An observed entry of the deployment at `dir` that reports `identity`, through the real
 *  `rosterRows`, `panelInstances` and `observedEntry`: helpers.mjs `observed`, with the identity
 *  the kernel puts in the roster's `workspace` and the deployment's own agents root. */
function reporting(rows, { identity = IDENTITY, dir = DEPLOYMENT, at = OBSERVED_AT, name = "acme-platform" } = {}) {
  const document = { ...rosterOf(rows), root: `${dir}/agents`, workspace: { reachable: true, ...identity } };
  const listed = rosterRows(document, READS);
  const answers = listed.map((row) => ({ running: row.running, runtimeState: row.runtimeState, tmux: row.tmux }));
  return observedEntry({ roster: document, workspaceStatus: { workspace: { name } }, observedAt: "2026-10-11T09:59:00.000Z" }, panelInstances(listed, answers), at);
}
/** A row of a roster group as the kernel reports it: `addressable` is always said, true or false. */
const remoteRow = (root, name, extra = {}) => ({ instance: name, agent: "dev", home: `${root}/agents/dev/instances/${name}`, agentsRoot: `${root}/agents`, work: "worktree", harness: "claude", running: true, runtimeState: "running", addressable: true, ...extra });
/** A roster group in the kernel's form: its id is `<server>:<targetKey>`, the server's name in
 *  lower case and no path in it (a group in another form is never remembered). Reached, reporting
 *  IDENTITY, with a running row that can be addressed and a stopped one that cannot. */
function machine(server, extra = {}) {
  const root = `/home/dev/Agents/${server}`;
  return {
    id: `${server}:acme-1`, server, label: server, registrationPresent: true, target: { workspace: root, sshHost: `${server}.example` }, probe: { ok: true },
    workspace: IDENTITY, agentsRoot: `${root}/agents`, souls: [],
    instances: [remoteRow(root, `${server}-a`), remoteRow(root, `${server}-b`, { addressable: false, ...STOPPED })], ...extra,
  };
}
/** The id of a machine's deployment, as the shared home names it. */
const GARNET = "remote:garnet:acme-1";
/** A probe that did not reach its machine. */
const unreached = (code, message) => ({ ok: false, error: { code, message } });
/** The roster read's outcome for an answer that lists these groups. */
const answer = (...groups) => ({ envelope: { ok: true, result: { groups } } });
/** The time of the n-th roster outcome of a test: none is the time of a paint (AT) or of a local read. */
const tick = (n) => new Date(Date.parse("2026-10-11T10:01:01.000Z") + n * 15000).toISOString();

/** One outcome of the roster read into a state, as lib/read.mjs takes it: the shared rule, then
 *  the memory of identities for what the answer reported, then the store's one event. */
function heard(state, outcome, at) {
  const made = remoteRosterState(state.remote, outcome, at);
  const identities = made.reported === null ? { memory: state.memory, notes: state.notes } : observeIdentities({ memory: state.memory, notes: state.notes }, made.reported, at);
  return reduce(state, { roster: { remote: { remoteGroups: made.remoteGroups, rosterAnswered: made.rosterAnswered, rosterFailure: made.rosterFailure }, memory: identities.memory, notes: identities.notes, at } }).state;
}
/** A run that serves two deployments of this machine, both reporting `identity`: the second joins
 *  as a picked folder does (the store's `admitted`), and is then read. */
function twoHere(first, second, { identity = IDENTITY } = {}) {
  const joined = reduce(stateOf(reporting(first, { identity }), { cli: READS }), { admitted: SECOND, at: AT }).state;
  return took(joined, reporting(second.map((row) => homedIn(SECOND, row)), { identity, dir: SECOND }), 1, SECOND);
}

/** What the views are given for a state in a list pane `cols` wide, tall enough for every row here. */
const seen = (state, cols = 80, page = 60) => model(state, { page, now: NOW, at: AT, cols });
/** A list as a test reads it, item by item: an instance's name as its row draws it (as words, the
 *  model's list and the roster's items alike), null for the empty item, a
 *  heading's label in brackets, a row of a sentence after a bar, the TUI's own words after a
 *  colon, and why no instance is listed in parentheses. */
const shape = (items) => items.map((item) => (item === null ? null
  : item.heading !== undefined ? `[${item.heading.label}]`
    : item.line !== undefined ? `| ${textOf(item.line)}`
      : item.own !== undefined ? `: ${item.own}`
        : item.empty !== undefined ? `(${item.empty})`
          : item.row ? drawnName(item.row.instance) : item.name));
/** The headings of a state's list, each as the five facts the view draws. */
const headings = (state, cols = 80) => roster(state, AT, cols).items.filter((item) => item?.heading !== undefined).map(({ heading }) => ({ label: heading.label, path: heading.path, state: heading.state, short: heading.short, readAt: heading.readAt }));
/** The sentences of a state's list: its rows of text, in order. */
const lines = (r) => r.items.filter((item) => item?.line !== undefined).map((item) => textOf(item.line));
/** The sections of the view a state has open, asked of the shared home as the Desktop asks: a
 *  row's section is read from the split of ALL rows, and a collapse is asked with it. */
function sharedSplit(state) {
  const panel = sharedPanel(state), query = state.filter.query, filtering = query.trim() !== "";
  const sectionOf = new Map();
  for (const part of rosterSections(panel.instances, panel.instances, panel.deployments, TERMS)) for (const group of part.groups) for (const cluster of group.clusters) for (const row of cluster.instances) sectionOf.set(instanceId(row), part.deployment?.id ?? null);
  const section = (row) => sectionOf.get(instanceId(row)) ?? null;
  const visible = filterInstanceTree(panel.instances, query).filter((row) => instanceVisibleInTree(row, panel.instances, state.collapsed, state.open, filtering, { section }));
  return { panel, section, sections: rosterSections(panel.instances, visible, panel.deployments, TERMS) };
}

/** This machine's rows in every test of a machine: a cluster of two and a stopped single instance. */
const NEAR = [instanceRow("dev", "lead"), instanceRow("dev", "kid", { parentInstance: "lead" }), instanceRow("dev", "solo", STOPPED)];
const NEAR_DRAWN = ["Lead", "Kid", null, "Solo"];
const TIMED_OUT = { code: "E_CLI_TIMEOUT", message: "the roster read did not answer in time" };

/** The roster's outcomes of one run, each state made from the one before it: the first read
 *  throws, an answer, an envelope that is not `ok`, an answer again, a read that throws, a gated
 *  outcome, and an answer in which the machine reports another workspace. */
function walk() {
  const near = stateOf(reporting(NEAR), { cli: READS });
  const failedFirst = heard(near, { thrown: "spawn oats ENOENT" }, tick(0));
  const answered = heard(failedFirst, answer(machine("garnet")), tick(1));
  const timedOut = heard(answered, { envelope: { ok: false, error: TIMED_OUT } }, tick(2));
  const again = heard(timedOut, answer(machine("garnet")), tick(3));
  const thrown = heard(again, { thrown: "the pipe closed" }, tick(4));
  const gated = heard(thrown, { gated: true }, tick(5));
  const moved = heard(gated, answer(machine("garnet", { workspace: LEDGER })), tick(6));
  return { near, failedFirst, answered, timedOut, again, thrown, gated, moved };
}
/** The view of the second workspace the switcher lists, opened with the keys a user has. */
const second = (state) => press(state, ["w", "w", "j", "enter"]).state;

// --- The roster's outcomes, step by step ------------------------------------------------

test("a roster read that throws before any answer shows no machine: after the list, set apart by one empty row, stand the TUI's own line and the failure's own text, and they leave when an answer arrives", () => {
  const { near, failedFirst, answered } = walk();
  const failure = remoteRosterState(near.remote, { thrown: "spawn oats ENOENT" }, tick(0)).rosterFailure;
  assert.equal(failedFirst.remote.rosterFailure, failure);
  assert.equal(failure.endsWith("spawn oats ENOENT"), true, "the shared sentence holds what was thrown");
  assert.equal(ROSTER_FAILED, "Other machines were not read.");
  assert.deepEqual(shape(seen(near).list), NEAR_DRAWN);
  const m = seen(failedFirst);
  assert.deepEqual(shape(m.list), [...NEAR_DRAWN, null, `: ${ROSTER_FAILED}`, `| ${failure}`]);
  assert.deepEqual([m.machines, m.workspace, m.notice, m.note, m.empty], [0, "acme-platform", null, null, null]);
  assert.equal(sharedPanel(failedFirst).deployments.length, 1, "nothing is remembered: the view is this machine's deployment alone");
  assert.deepEqual(headings(failedFirst), []);
  assert.deepEqual(drawnRows(failedFirst), drawnRows(near), "this machine's rows are as they were");
  // With nothing above them there is nothing to set them apart from: no empty row.
  const bare = heard(stateOf(failed(reporting(NEAR), TIMEOUT), { cli: READS }), { thrown: "spawn oats ENOENT" }, tick(0));
  assert.deepEqual(roster(bare).rows, [], "an unavailable deployment has no rows");
  assert.deepEqual(shape(seen(bare).list), [`: ${ROSTER_FAILED}`, `| ${failure}`]);
  // An answer has arrived: the machines say it themselves.
  assert.equal(answered.remote.rosterFailure, null);
  assert.equal(shape(seen(answered).list).some((item) => typeof item === "string" && /^[:|]/.test(item)), false);
  assert.equal(shape(seen(answered).list).filter((item) => item === null).length, 1, "and the empty row that set them apart leaves with them");
});

test("an answered roster puts the machine in this workspace's view: two sections under the labels the shared split gives, the machine's heading with the time of the roster read and this machine's with none, and one machine in the sidebar's title", () => {
  const { answered, again } = walk();
  for (const [state, at] of [[answered, tick(1)], [again, tick(3)]]) {
    const panel = sharedPanel(state), sections = rosterSections(panel.instances, panel.instances, panel.deployments, TERMS);
    assert.equal(panel.deployments.length, 2, "one view holds both deployments");
    assert.deepEqual(sections.map((part) => part.label), [TERMS.thisMachine, "garnet"]);
    assert.equal(state.rosterAt, at);
    const m = seen(state);
    assert.deepEqual(shape(m.list), [`[${sections[0].label}]`, ...NEAR_DRAWN, `[${sections[1].label}]`, "Garnet a", "Garnet b"]);
    assert.deepEqual(headings(state), [
      { label: sections[0].label, path: null, state: null, short: null, readAt: null },
      { label: sections[1].label, path: null, state: null, short: null, readAt: clockTime(at) },
    ]);
    assert.equal(m.machines, 1);
    assert.equal(m.workspace, "acme-platform");
    assert.equal(m.readAt, clockTime(OBSERVED_AT), "the time of the read, on the help's top row, is this machine's: the view's primary is its deployment");
    assert.deepEqual([m.notice, m.note, m.empty, m.observed], [null, null, null, true]);
    // The machine's rows are drawn by the rules of this machine's rows: one that can't be
    // addressed has the shared label of its reason.
    const unaddressable = rowReason(panelRow(state, "garnet-b").row);
    assert.equal(unaddressable.key, "unaddressable");
    assert.deepEqual(["garnet-a", "garnet-b"].map((name) => { const row = listRow(state, name); return [row.mark, row.word]; }), [["running", null], ["stopped", unaddressable.label]]);
    assert.deepEqual(m.counts.map((count) => [count.n, count.word]), [[3, "running"], [2, "stopped"]], "the counts are over all the rows of the view");
  }
  assert.deepEqual([clockTime(tick(1)), clockTime(tick(3))], ["10:01:16", "10:01:46"]);
});

test("a machine's heading is its name alone when its rows were read at the time the help's top row shows: its time stands only when it differs from that one, and a read that failed says so in the shared words instead", () => {
  const near = stateOf(reporting(NEAR, { at: tick(0) }), { cli: READS });
  const same = heard(near, answer(machine("garnet")), tick(0));
  assert.equal(seen(same).readAt, clockTime(tick(0)), "this machine was read at the time the machine's rows were");
  assert.deepEqual(headings(same), [
    { label: TERMS.thisMachine, path: null, state: null, short: null, readAt: null },
    { label: "garnet", path: null, state: null, short: null, readAt: null },
  ]);
  // The next roster read is at another time than this machine's: the machine's heading says it.
  const later = heard(same, answer(machine("garnet")), tick(1));
  assert.deepEqual([seen(later).readAt, headings(later)[1].readAt], [clockTime(tick(0)), clockTime(tick(1))]);
  // Not reached: no time, the shared state and short reason in its place.
  const lost = heard(later, { envelope: { ok: false, error: TIMED_OUT } }, tick(2));
  const far = sharedPanel(lost).deployments.find((d) => !d.local), said = deploymentState(far);
  assert.deepEqual(headings(lost)[1], { label: "garnet", path: null, state: said.text, short: far.short, readAt: null });
  // In a view whose primary is the machine, the time of the read is the roster read's: no heading repeats it.
  const root = "/home/dev/Agents/garnet-two";
  const two = heard(initialState({ deployment: null, cli: READS, home: "/home/u" }), answer(machine("garnet"), machine("garnet", { id: "garnet:acme-2", target: { workspace: root, sshHost: "garnet.example" }, agentsRoot: `${root}/agents`, instances: [remoteRow(root, "garnet-c")] })), tick(3));
  const opened = press(two, ["enter"]).state, m = seen(opened);
  assert.equal(sharedPanel(opened).deployments.length, 2);
  assert.equal(m.readAt, clockTime(tick(3)));
  assert.deepEqual(headings(opened).map((heading) => heading.readAt), [null, null]);
});

test("a machine that answered earlier in the run and does not now keeps its place: its heading says the shared state and short reason and no time, and its rows are kept as unknown, after an envelope that is not ok and after a later read that throws", () => {
  const { answered, timedOut, thrown } = walk();
  for (const [state, short, error] of [[timedOut, "Timed out", TIMED_OUT.message], [thrown, "Not reached", remoteRosterState(answered.remote, { thrown: "the pipe closed" }, tick(4)).remoteGroups[0].probe.error.message]]) {
    const panel = sharedPanel(state), far = panel.deployments.find((d) => !d.local), said = deploymentState(far);
    assert.deepEqual([said.key, said.text, far.short], ["remembered", "remembered", short]);
    assert.deepEqual(headings(state), [
      { label: TERMS.thisMachine, path: null, state: null, short: null, readAt: null },
      { label: "garnet", path: null, state: said.text, short: far.short, readAt: null },
    ]);
    const m = seen(state);
    assert.deepEqual(shape(m.list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN, "[garnet]", "Garnet a", "Garnet b"], "the machine stays in its workspace, and no line of the roster's failure is added");
    for (const name of ["garnet-a", "garnet-b"]) {
      const { row } = panelRow(state, name);
      assert.deepEqual([row.running, row.serverUnreached, row.runtimeError], [null, true, error], name);
    }
    assert.equal(state.remote.rosterFailure, null, "an answer had arrived: the failure is the machine's to say");
    assert.deepEqual([m.machines, m.readAt, m.notice], [1, clockTime(OBSERVED_AT), null], "this machine's deployment is the primary, and it is live");
    assert.deepEqual(NEAR.map((row) => listRow(state, row.instance).mark), ["running", "running", "stopped"], "this machine's rows are as they were");
  }
  assert.equal(thrown.remote.remoteGroups[0].probe.error.message.endsWith("the pipe closed"), true);
});

test("gated after an answer, the remembered machine is listed without rows: after the sections stands a heading with its machine, its path, its state and its short reason, and its reason on a row of its own", () => {
  const { gated } = walk();
  assert.deepEqual(gated.remote.remoteGroups, [], "the shared rule holds no group after a gated outcome");
  const panel = sharedPanel(gated), far = panel.deployments.find((d) => !d.local), said = deploymentState(far);
  assert.equal(panel.deployments.length, 2, "the memory of the run keeps the machine in its workspace");
  assert.equal(panel.instances.some((row) => row.deployment.id === far.id), false);
  assert.equal(said.key, "remembered");
  assert.deepEqual(rosterSections(panel.instances, panel.instances, panel.deployments, TERMS).map((part) => part.label), [TERMS.thisMachine], "a section with no row is absent from the shared answer");
  assert.deepEqual(shape(seen(gated).list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN, `[${far.machine}]`, `| ${said.detail}`]);
  assert.deepEqual(headings(gated)[1], { label: far.machine, path: far.label, state: said.text, short: far.short, readAt: null });
  assert.deepEqual([far.machine, far.label], ["garnet", "~/Agents/garnet"]);
  assert.equal(seen(gated).machines, 1);
});

test("a machine that reports another workspace leaves this view for one of its own: that view has no heading, carries the shared note above its list, and reads unknown when the machine is then not reached", () => {
  const { moved } = walk();
  const here = seen(moved);
  assert.equal(sharedPanel(moved).deployments.length, 1);
  assert.deepEqual(shape(here.list), NEAR_DRAWN, "no heading: one deployment is left in this view");
  assert.deepEqual([here.machines, here.note], [0, null]);
  assert.deepEqual(viewModel(heldOf(moved, AT), TERMS).views.map((v) => v.primary), [DEPLOYMENT, GARNET], "a second view, its primary the machine's deployment");
  const there = second(moved);
  assert.equal(there.open, GARNET);
  const panel = sharedPanel(there), note = panel.deployments[0].note, m = seen(there);
  assert.equal(panel.deployments.length, 1);
  assert.equal(note, moved.notes.get("garnet:acme-1"), "the sentence the memory of identities left for the move");
  assert.equal(typeof note === "string" && note.startsWith("garnet"), true);
  assert.equal(m.note, note);
  assert.deepEqual(shape(m.list), ["Garnet a", "Garnet b"], "neither a heading nor the note stands in the list");
  assert.deepEqual([m.workspace, m.machines, m.notice, m.empty, m.observed], [panel.workspace.name, 1, null, null, true]);
  assert.equal(m.readAt, clockTime(tick(6)), "in a view of one machine the time of the read is the roster read's");
  // Moved, then not reached: the view's primary is not live, so the notice says it; the note is kept.
  const lost = heard(there, { thrown: "the pipe closed" }, tick(7));
  const far = sharedPanel(lost).deployments[0], said = deploymentState(far), n = seen(lost);
  assert.equal(said.key, "remembered");
  assert.deepEqual(n.notice, { text: said.text, since: null, reason: said.detail });
  assert.deepEqual([n.note, n.readAt, n.observed, n.empty], [note, null, true, null]);
  assert.deepEqual(shape(n.list), ["Garnet a", "Garnet b"]);
  assert.deepEqual(["garnet-a", "garnet-b"].map((name) => listRow(lost, name).mark), ["unknown", "unknown"]);
});

// --- The title and the notice with other machines ---------------------------------------

test("the sidebar's title counts the other machines of the view once each, however many deployments each holds, and never this machine", () => {
  const near = stateOf(reporting(NEAR), { cli: READS });
  const root = "/home/dev/Agents/garnet-two";
  const twice = machine("garnet", { id: "garnet:acme-2", target: { workspace: root, sshHost: "garnet.example" }, agentsRoot: `${root}/agents`, instances: [remoteRow(root, "garnet-c")] });
  const state = heard(near, answer(machine("garnet"), twice, machine("quartz")), tick(0));
  const panel = sharedPanel(state);
  assert.deepEqual(panel.deployments.map((d) => [d.local, d.machine]), [[true, TERMS.thisMachine], [false, "garnet"], [false, "garnet"], [false, "quartz"]]);
  assert.equal(seen(state).machines, 2);
  assert.deepEqual(headings(state).map((heading) => heading.label), rosterSections(panel.instances, panel.instances, panel.deployments, TERMS).map((part) => part.label), "one machine with two deployments: the shared labels tell them apart");
  assert.equal(new Set(headings(state).map((heading) => heading.label)).size, 4);
  assert.equal(seen(heard(near, answer(), tick(0))).machines, 0, "an answer without groups: nothing about machines");
  assert.deepEqual(shape(seen(heard(near, answer(), tick(0))).list), NEAR_DRAWN);
});

test("with headings the notice above the list is still the primary deployment's: its state and whole reason there, its state and short reason on its heading, and the other deployments' rows as they were", () => {
  const { answered } = walk();
  const stale = took(answered, failed(answered.entries.get(DEPLOYMENT), UNREADABLE), 2);
  const panel = sharedPanel(stale), primary = primaryDeployment(panel.deployments), said = deploymentState(primary);
  assert.deepEqual([primary.id, said.key], [DEPLOYMENT, "stale"]);
  const m = seen(stale);
  assert.deepEqual(m.notice, { text: said.text, since: clockTime(OBSERVED_AT), reason: said.detail });
  assert.equal(said.detail.includes(UNREADABLE.message), true);
  assert.deepEqual(headings(stale), [
    { label: TERMS.thisMachine, path: null, state: said.text, short: primary.short, readAt: null },
    { label: "garnet", path: null, state: null, short: null, readAt: clockTime(tick(1)) },
  ]);
  assert.equal(m.readAt, null, "no time is shown of a read that is not live");
  assert.deepEqual(shape(m.list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN, "[garnet]", "Garnet a", "Garnet b"]);
  assert.deepEqual(["garnet-a", "garnet-b"].map((name) => listRow(stale, name).mark), ["running", "stopped"], "the machine was reached: its rows are what it reported");
  // The stale deployment's own rows say why under their machine; the machine's rows have nothing to add.
  assert.deepEqual(after(detailOf(stale, "lead"), "machine"), { label: "", value: said.detail, form: "wrap" });
  assert.equal(after(detailOf(stale, "garnet-a"), "machine").label, "state");
});

test("a view whose one deployment is a machine that is not reached and holds no row says so in its notice, and does not say that the deployment has no instances", () => {
  const nothing = initialState({ deployment: null, cli: READS, home: "/home/u" });
  // Reached and empty: the machine reported no instance, and the list says so.
  const reached = press(heard(nothing, answer(machine("garnet", { instances: [] })), tick(0)), ["enter"]).state;
  assert.equal(reached.open, GARNET);
  assert.deepEqual([seen(reached).empty, seen(reached).notice, seen(reached).readAt], ["none", null, clockTime(tick(0))]);
  // Not reached: nothing is known of its instances. This machine's deployment in that state (an
  // unavailable entry) draws its notice and no empty line; a machine's is given the same here.
  const never = press(heard(nothing, answer(machine("garnet", { probe: unreached("E_SSH", "no route to the host"), workspace: null, instances: [] })), tick(0)), ["enter"]).state;
  const lost = heard(reached, { thrown: "the pipe closed" }, tick(1));
  for (const [what, state] of [["never reached in this run", never], ["reached earlier, not now", lost]]) {
    const said = deploymentState(sharedPanel(state).deployments[0]), m = seen(state);
    assert.equal(state.open, GARNET, what);
    assert.notEqual(said.key, "live", what);
    assert.deepEqual(m.notice, { text: said.text, since: null, reason: said.detail }, what);
    assert.deepEqual([m.empty, m.list], [null, []], `${what}: "no instances" is not known of a machine that did not answer`);
  }
});

// --- The time of the roster read --------------------------------------------------------

test("held is built as the spec's store section says and its time is the time of the last roster outcome taken: in a view whose primary is a machine the help's top row shows that time, not the paint's", () => {
  const { near, moved } = walk(), paint = "2026-10-11T12:34:56.000Z";
  assert.equal(near.rosterAt, null);
  assert.equal(modelHeld(near, paint).at, paint, "before any outcome the paint's time stands in");
  const there = second(moved);
  assert.equal(there.rosterAt, tick(6));
  const mine = modelHeld(there, paint), spec = heldOf(there, paint);
  assert.equal(mine.at, tick(6));
  for (const field of ["ctxs", "remoteGroups", "rosterAnswered", "rosterFailure", "cli", "observing", "remoteCollecting", "home", "at", "learned"]) assert.deepEqual(mine[field], spec[field], field);
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(spec).sort());
  assert.equal(mine.snapshot.byWs, there.entries);
  assert.deepEqual([...mine.snapshot.byWs.keys()], [DEPLOYMENT], "this machine's entries only: a machine's panel is the shared home's to make");
  assert.deepEqual(mine.remembered.all(), spec.remembered.all());
  assert.deepEqual([mine.remembered.get("garnet:acme-1"), mine.remembered.note("garnet:acme-1")], [spec.remembered.get("garnet:acme-1"), spec.remembered.note("garnet:acme-1")]);
  assert.equal(modelHeld(reduce(there, { collecting: true }).state, paint).remoteCollecting, true);
  assert.deepEqual(panelOf(there, paint), panelData(spec, GARNET, TERMS));
  assert.equal(panelOf(there, paint).generatedAt, tick(6));
  const m = model(there, { page: 19, now: Date.parse(paint), at: paint, cols: 80 });
  assert.equal(m.readAt, clockTime(tick(6)));
  assert.notEqual(m.readAt, clockTime(paint));
  // Each later outcome moves it, an answer or not.
  assert.equal(heard(there, answer(machine("garnet", { workspace: LEDGER })), tick(9)).rosterAt, tick(9));
  assert.equal(heard(there, { thrown: "the pipe closed" }, tick(8)).rosterAt, tick(8));
  assert.equal(panelOf(Object.freeze({ ...near, open: null }), paint), null, "with nothing open there is no panel");
});

// --- A row of a machine that was not reached --------------------------------------------

test("a kept row of a machine that was not reached reads `<machine> not reached`: its list word and its detail's state are the shared label of its reason and its mark the unknown mark, never the word of its last report", () => {
  const { answered, timedOut, thrown } = walk();
  for (const state of [timedOut, thrown]) for (const [name, last] of [["garnet-a", "running"], ["garnet-b", "stopped"]]) {
    const { row } = panelRow(state, name), drawn = listRow(state, name), reason = rowReason(row);
    assert.equal(row.running, null, name);
    assert.equal(row.runtimeState, last, "the row still carries the word of its last report");
    assert.equal(sharedState(row), "unknown");
    assert.deepEqual([reason.key, reason.label.includes("garnet")], ["unreached", true], name);
    assert.deepEqual([drawn.mark, drawn.word], ["unknown", reason.label], name);
    assert.equal(fact(detailOf(state, name), "state").value, reason.label, name);
    for (const word of ["stopped", "running", "claude", "unknown"]) assert.notEqual(drawn.word, word, name);
  }
  // Reached, the same rows say what the machine reported: the mark says a running row's state,
  // and the row that can't be addressed has its reason's label.
  const label = rowReason(panelRow(answered, "garnet-b").row).label;
  assert.deepEqual(["garnet-a", "garnet-b"].map((name) => [listRow(answered, name).word, fact(detailOf(answered, name), "state").value]), [[null, "running"], [label, label]]);
  assert.deepEqual(seen(timedOut).counts.map((count) => [count.n, count.word]), Object.entries(runtimeCounts(sharedPanel(timedOut).instances)).filter(([, n]) => n > 0).map(([word, n]) => [n, word]));
  assert.equal(runtimeCounts(sharedPanel(timedOut).instances).unknown, 2);
});

// --- The detail in a view of more than one deployment -----------------------------------

test("the detail names the machine in a view of two or more deployments, and under it says in the shared sentence why that deployment is not live; in a view of one deployment only when it is another machine's", () => {
  const { near, answered, timedOut, moved } = walk();
  assert.equal(isMultiDeployment(sharedPanel(answered).deployments), true);
  assert.deepEqual(labels(detailOf(answered, "lead")).slice(0, 3), ["soul", "machine", "state"]);
  assert.deepEqual(fact(detailOf(answered, "lead"), "machine"), { label: "machine", value: TERMS.thisMachine, form: "line" });
  assert.deepEqual(fact(detailOf(answered, "garnet-a"), "machine"), { label: "machine", value: panelRow(answered, "garnet-a").row.deployment.machine, form: "line" });
  assert.equal(fact(detailOf(answered, "garnet-a"), "machine").value, "garnet");
  assert.equal(after(detailOf(answered, "garnet-a"), "machine").label, "state", "a live deployment adds no sentence");
  // Not live: the state's detail on the row under it, for the rows of that deployment only.
  const far = sharedPanel(timedOut).deployments.find((d) => !d.local), said = deploymentState(far);
  assert.notEqual(said.key, "live");
  for (const name of ["garnet-a", "garnet-b"]) {
    assert.deepEqual(after(detailOf(timedOut, name), "machine"), { label: "", value: said.detail, form: "wrap" }, name);
    assert.deepEqual(labels(detailOf(timedOut, name)).slice(0, 4), ["soul", "machine", "", "state"], name);
  }
  assert.equal(after(detailOf(timedOut, "lead"), "machine").label, "state");
  // A view of one deployment: no such line on this machine; on another, the line, which nothing
  // else names it by (no heading, and the list of workspaces' row is the workspace's name alone).
  assert.equal(fact(detailOf(near, "lead"), "machine"), null);
  assert.equal(fact(detailOf(moved, "lead"), "machine"), null);
  const there = second(moved);
  assert.equal(isMultiDeployment(sharedPanel(there).deployments), false);
  assert.deepEqual(fact(detailOf(there, "garnet-a"), "machine"), { label: "machine", value: "garnet", form: "line" });
  assert.equal(after(detailOf(there, "garnet-a"), "machine").label, "state", "no sentence under it: the state under the list says it");
  assert.deepEqual(labels(detailOf(there, "garnet-a")).slice(0, 3), ["soul", "machine", "state"]);
});

test("a remote row that cannot be addressed: when its server was not reached its reason stands once, under its state after the words that say the read of other machines gave it, with no held line; on a reached machine the held line carries the shared sentence", () => {
  const { answered, timedOut, thrown } = walk();
  // Neither failure was printed by a kernel: a read that threw, and an envelope made in walk() as
  // the read makes its own for a timeout (it is not parsed from a CLI's answer, so its error
  // carries no kernel's mark). Both are the read's to say.
  for (const state of [timedOut, thrown]) {
    const { row } = panelRow(state, "garnet-b"), acts = instanceActs(row), detail = detailOf(state, "garnet-b");
    assert.equal(row.addressable, false);
    assert.equal(acts.blocked.sentence, row.runtimeError, "the shared reason is the very text the row carries");
    assert.deepEqual(after(detail, "state"), { label: "", value: `oats tui's read of other machines says: ${row.runtimeError}`, form: "wrap" });
    assert.equal(fact(detail, "held"), null);
    assert.equal(detail.facts.filter((f) => f.value.includes(row.runtimeError)).length, 1, "once");
    // The row beside it can be addressed: the shared acts hold nothing against it, and its text stands once too.
    const other = panelRow(state, "garnet-a").row, beside = detailOf(state, "garnet-a");
    assert.deepEqual([other.addressable, instanceActs(other).blocked, instanceActs(other).limited], [true, null, null]);
    assert.equal(fact(beside, "held"), null);
    assert.equal(beside.facts.filter((f) => f.value.includes(other.runtimeError)).length, 1);
  }
  const { row } = panelRow(answered, "garnet-b"), acts = instanceActs(row), detail = detailOf(answered, "garnet-b");
  assert.equal(row.serverUnreached, false);
  assert.equal(acts.blocked.code, "unaddressable");
  assert.deepEqual(fact(detail, "held"), { label: "held", value: acts.blocked.sentence, form: "wrap" });
  assert.equal(after(detail, "state").label, "held", "nothing was reported about its state: no text under it");
  assert.equal(acts.blocked.sentence.includes("does not report whether"), false, "the kernel said it cannot be addressed: the sentence is not the one for a kernel that says nothing");
  assert.equal(fact(detailOf(answered, "garnet-a"), "held"), null);
});

test("a row gone from its machine (missingRemotely, a saved route) is drawn with the shared home's state: the unknown mark and `gone from <machine>`, in the list and on the detail's state line; under it the shared sentence with the command that removes it; and it can't be opened", () => {
  const { answered } = walk();
  // The kernel's row for an instance its machine no longer has: no state, its route saved, not addressable.
  const gone = remoteRow("/home/dev/Agents/garnet", "garnet-gone", { running: null, runtimeState: undefined, harness: null, savedRoute: true, addressable: false, missingRemotely: true });
  const state = heard(answered, answer(machine("garnet", { instances: [...machine("garnet").instances, gone] })), tick(2));
  const { row } = panelRow(state, "garnet-gone"), reason = rowReason(row), acts = instanceActs(row);
  assert.deepEqual([reason.key, reason.label, reason.origin], ["missing", "gone from garnet", undefined]);
  const drawn = listRow(state, "garnet-gone");
  assert.deepEqual([drawn.mark, drawn.word], ["unknown", reason.label]);
  const detail = detailOf(state, "garnet-gone");
  assert.equal(fact(detail, "state").value, reason.label, "not `unknown`");
  assert.deepEqual(fact(detail, "held"), { label: "held", value: reason.sentence, form: "wrap" }, "the shared sentence, once");
  assert.equal(reason.sentence, acts.blocked.sentence);
  assert.equal(reason.sentence.includes("oats server forget garnet --instance garnet-gone"), true);
  assert.equal(detail.facts.filter((f) => f.value.includes(reason.sentence)).length, 1);
  // It can't be opened: nothing offers it, and the cheat sheet names neither Enter nor an act.
  assert.equal(view(on(state, "garnet-gone")).openable, false);
  assert.deepEqual(cheatSheet(on(state, "garnet-gone"), { cols: 140, rows: 40 }), SHEET_NO_ENTER);
});

test("every key of the shared row reason is drawn with its own label, and nothing else of the row stands in its place: herdr, unreached, missing, unaddressable, unknown", () => {
  const { answered, timedOut } = walk();
  const gone = remoteRow("/home/dev/Agents/garnet", "garnet-gone", { running: null, runtimeState: undefined, savedRoute: true, addressable: false, missingRemotely: true });
  const local = stateOf(observed([instanceRow("dev", "herdr", { running: null, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: this backend is gone", tmux: null }), instanceRow("dev", "lost", { running: null, runtimeState: "unreachable" })]));
  const cases = [
    [local, "herdr", "herdr"],
    [local, "lost", "unknown"],
    [timedOut, "garnet-a", "unreached"],
    [heard(answered, answer(machine("garnet", { instances: [...machine("garnet").instances, gone] })), tick(2)), "garnet-gone", "missing"],
    [answered, "garnet-b", "unaddressable"],
  ];
  for (const [state, name, key] of cases) {
    const reason = rowReason(panelRow(state, name).row);
    assert.equal(reason.key, key, name);
    assert.equal(listRow(state, name).word, reason.label, `${key}: the list's word`);
  }
  assert.deepEqual(new Set(cases.map(([, , key]) => key)).size, 5);
});

// --- Sections ---------------------------------------------------------------------------

test("a collapse hides and rolls up only rows of its own section: a child in another deployment of the view, whose parent's name resolves across the two agents roots, stays shown under the collapsed parent and rolls up nowhere", () => {
  const open = twoHere(
    [instanceRow("dev", "lead"), instanceRow("dev", "kid-a", { parentInstance: "lead", waitingOnYou: claimOf("question") })],
    [instanceRow("dev", "far-kid", { parentInstance: "lead", waitingOnYou: claimOf("permission") }), instanceRow("dev", "other-b")],
  );
  const { panel, section } = sharedSplit(open);
  assert.deepEqual(panel.deployments.map((d) => d.id), [DEPLOYMENT, SECOND], "two served paths that report one identity are one view");
  const lead = panelRow(open, "lead"), farKid = panelRow(open, "far-kid");
  assert.deepEqual([section(lead.row), section(farKid.row)], [DEPLOYMENT, SECOND]);
  assert.notEqual(lead.row.agentsRoot, farKid.row.agentsRoot);
  assert.deepEqual(names(open), ["lead", "kid-a", "far-kid", "other-b"]);
  assert.equal(farKid.depth, 0, "in its own section it is under no one");
  const closed = folded(open, "lead");
  assert.deepEqual([...closed.collapsed], [collapseKey(open.open, lead.id)]);
  // The shared walk, asked without a section, hides the child: the name `lead` is unique in the view, so it resolves.
  assert.equal(instanceVisibleInTree(farKid.row, panel.instances, closed.collapsed, closed.open, false), false);
  assert.equal(instanceVisibleInTree(farKid.row, panel.instances, closed.collapsed, closed.open, false, { section }), true);
  assert.deepEqual(names(closed), ["lead", "far-kid", "other-b"], "only the child of its own section is hidden");
  assert.deepEqual(drawnRows(closed), sharedSplit(closed).sections.flatMap((part) => part.groups.flatMap((group) => group.clusters.flatMap((cluster) => cluster.instances.map((row) => [instanceId(row), row.depth])))));
  const below = waitingRollup(panel.instances, closed.collapsed, closed.open, { filtering: false, stale: () => false, section });
  const rolled = (map) => [...map].map(([id, rows]) => [id, rows.map((row) => row.instance)]);
  assert.deepEqual(rolled(below), [[lead.id, ["kid-a"]]]);
  assert.deepEqual(rolled(roster(closed).below), rolled(below));
  assert.equal(waitingRollup(panel.instances, closed.collapsed, closed.open, { filtering: false, stale: () => false }).get(lead.id).length, 2, "without a section the shared roll-up would count it under the parent");
  const drawn = listRow(closed, "lead");
  assert.deepEqual({ below: drawn.below, folded: drawn.folded }, { below: 1, folded: 1 }, "the child of the other section is not folded away, and not counted");
  assert.deepEqual(fact(detailOf(closed, "lead"), "below"), { label: "below", value: waitingBelowText(below.get(lead.id)), form: "wrap" });
  const child = listRow(closed, "far-kid");
  assert.deepEqual({ waiting: child.waiting, below: child.below }, { waiting: true, below: 0 }, "it is drawn, and carries its own mark");
  assert.equal(seen(closed).counts.find((count) => !count.shared).n, 2);
});

test("two deployments of this machine in one workspace are two sections, each under the label the shared split gives it, and neither with a time", () => {
  const state = twoHere(solos("a"), solos("b"));
  const panel = sharedPanel(state), sections = rosterSections(panel.instances, panel.instances, panel.deployments, TERMS);
  assert.equal(viewModel(heldOf(state, AT), TERMS).views.length, 1);
  assert.equal(sections.length, 2);
  assert.equal(new Set(sections.map((part) => part.label)).size, 2, "one machine holds both: the shared label tells them apart");
  assert.equal(sections.every((part) => part.machine === TERMS.thisMachine && part.tail !== ""), true);
  assert.deepEqual(headings(state), sections.map((part) => ({ label: part.label, path: null, state: null, short: null, readAt: null })));
  const m = seen(state);
  assert.deepEqual(shape(m.list), [`[${sections[0].label}]`, "A", `[${sections[1].label}]`, "B"]);
  assert.deepEqual([m.machines, m.workspace, m.note], [0, panel.workspace.name, null], "no other machine is in the view");
  assert.deepEqual(["a", "b"].map((name) => fact(detailOf(state, name), "machine").value), [TERMS.thisMachine, TERMS.thisMachine]);
});

test("siblings are read inside one deployment: a name that is an instance of the other deployment of the view is no sibling, and each deployment's own links stand (#1315)", () => {
  const state = twoHere([instanceRow("dev", "a", { siblingInstance: "b" })], [instanceRow("dev", "b"), instanceRow("dev", "c", { siblingInstance: "b" })]);
  const parentOf = (name) => fact(detailOf(state, name), "parent")?.value ?? null;
  assert.equal(isMultiDeployment(sharedPanel(state).deployments), true);
  // Over both rosters at once the name would resolve: the case reads the split, not a missing row.
  assert.deepEqual(siblingText(instanceSiblings(sharedPanel(state).instances).get(panelRow(state, "a").id)), "sibling of b");
  assert.deepEqual(["a", "b", "c"].map(parentOf), [null, "sibling of c", "sibling of b"]);
});

// --- A deployment's note ----------------------------------------------------------------

test("a deployment's note stands under its heading, as rows of the list, in a view with headings; in a view of one deployment it is the model's note and no row of the list", () => {
  // Two standalone deployments of this machine: the shared home leaves each the note for local teams.
  const both = twoHere(solos("a"), solos("b"), { identity: STANDALONE });
  const panel = sharedPanel(both), notes = panel.deployments.map((d) => d.note);
  const sections = rosterSections(panel.instances, panel.instances, panel.deployments, TERMS);
  assert.equal(notes.length === 2 && notes.every((note) => typeof note === "string" && note !== ""), true);
  assert.deepEqual(shape(seen(both).list), [`[${sections[0].label}]`, `| ${notes[0]}`, "A", `[${sections[1].label}]`, `| ${notes[1]}`, "B"]);
  assert.equal(seen(both).note, null, "with headings nothing stands above the list");
  // A machine that reported another workspace and now reports this one: the note under its heading alone.
  const elsewhere = heard(stateOf(reporting(NEAR), { cli: READS }), answer(machine("garnet", { workspace: LEDGER })), tick(0));
  const joined = heard(elsewhere, answer(machine("garnet")), tick(1));
  const moved = sharedPanel(joined).deployments.find((d) => !d.local).note;
  assert.equal(moved, joined.notes.get("garnet:acme-1"));
  assert.deepEqual(shape(seen(joined).list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN, "[garnet]", `| ${moved}`, "Garnet a", "Garnet b"]);
  assert.equal(seen(joined).note, null);
  // One deployment: above the list, for this machine's deployment as for a machine's.
  const alone = stateOf(reporting(solos("a"), { identity: STANDALONE }), { cli: READS });
  const note = sharedPanel(alone).deployments[0].note;
  assert.equal(note, notes[0]);
  assert.equal(seen(alone).note, note);
  assert.deepEqual(shape(seen(alone).list), ["A"]);
  const there = second(elsewhere);
  assert.equal(there.open, GARNET);
  assert.equal(seen(there).note, null, "its first report is no move");
  assert.equal(seen(stateOf(reporting(solos("a")), { cli: READS })).note, null, "a deployment without a note has none");
});

// --- A deployment that is not live and has no rows --------------------------------------

test("a deployment of the view that is not live and has no rows is listed after the sections: a heading with its machine, its path and its state, then its reason and its note on rows of their own; a live one without rows is not listed", () => {
  const near = stateOf(reporting(NEAR), { cli: READS });
  const live = heard(near, answer(machine("garnet", { instances: [] })), tick(0));
  assert.equal(sharedPanel(live).deployments.length, 2);
  assert.deepEqual(shape(seen(live).list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN], "reached and empty: there is nothing to say of it");
  assert.equal(seen(live).machines, 1);
  const lost = heard(live, { envelope: { ok: false, error: TIMED_OUT } }, tick(1));
  const far = sharedPanel(lost).deployments.find((d) => !d.local), said = deploymentState(far);
  assert.deepEqual([said.key, far.short], ["remembered", "Timed out"]);
  // (A pane wide enough for the reason on one row: how a sentence breaks is another test's.)
  assert.deepEqual(shape(seen(lost, 120).list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN, `[${far.machine}]`, `| ${said.detail}`]);
  assert.deepEqual(headings(lost)[1], { label: far.machine, path: far.label, state: said.text, short: far.short, readAt: null });
  // With a note: a machine that moved into this workspace, then was not reached. The reason, then the note.
  const elsewhere = heard(near, answer(machine("garnet", { workspace: LEDGER, instances: [] })), tick(0));
  const gone = heard(heard(elsewhere, answer(machine("garnet", { instances: [] })), tick(1)), { thrown: "the pipe closed" }, tick(2));
  const kept = sharedPanel(gone).deployments.find((d) => !d.local);
  assert.equal(typeof kept.note === "string" && kept.note !== "", true);
  assert.deepEqual(shape(seen(gone, 120).list), [`[${TERMS.thisMachine}]`, ...NEAR_DRAWN, `[${kept.machine}]`, `| ${deploymentState(kept).detail}`, `| ${kept.note}`]);
  // A deployment of this machine whose last read failed and that holds no instance: named by this machine's label and its path.
  const empty = twoHere(solos("a"), []);
  const stale = took(empty, failed(empty.entries.get(SECOND), UNREADABLE), 2, SECOND);
  const mine = sharedPanel(stale).deployments.find((d) => d.id === SECOND), state = deploymentState(mine);
  assert.equal(state.key, "stale");
  assert.equal(state.detail.includes(UNREADABLE.message), true);
  const r = roster(stale, AT, 80);
  assert.deepEqual(headings(stale).at(-1), { label: mine.machine, path: mine.label, state: state.text, short: mine.short, readAt: null });
  assert.deepEqual([mine.machine, mine.label], [TERMS.thisMachine, SECOND]);
  assert.equal(lines(r).join(" "), state.detail, "the whole reason, on the rows it needs");
  assert.deepEqual(shape(r.items).slice(0, 3), [shape(r.items)[0], "A", `[${mine.machine}]`]);
});

// --- The list at two widths -------------------------------------------------------------

test("a sentence in the list takes the rows its width needs, more in a narrow pane, and the instances are the same at every width", () => {
  const { gated, failedFirst } = walk();
  for (const state of [gated, failedFirst]) {
    const wide = roster(state, AT, 80), narrow = roster(state, AT, 30);
    assert.equal(lines(narrow).length > lines(wide).length, true, `${lines(narrow).length} rows at 30 columns, ${lines(wide).length} at 80`);
    assert.equal(lines(narrow).join(" "), lines(wide).join(" "), "the same sentence, broken at its spaces");
    assert.equal(lines(narrow).every((line) => line.length <= 30 - SENTENCE_INDENT - 1), true);
    assert.equal(narrow.rows.length, NEAR.length);
    assert.equal(narrow.rows.every((item, i) => item === wide.rows[i]), true, "the very same instances");
    assert.deepEqual([...narrow.index.keys()], [...wide.index.keys()]);
    for (const r of [wide, narrow]) for (const [id, i] of r.index) assert.equal(r.items[i].id, id);
    assert.equal(narrow.items.length - wide.items.length, lines(narrow).length - lines(wide).length, "only the sentences take more rows");
    assert.deepEqual(shape(seen(state, 30).list), shape(narrow.items), "the model lays out the width it is given");
    assert.deepEqual(shape(seen(state, 80).list), shape(wide.items));
  }
});

// --- The switcher -----------------------------------------------------------------------

/** A row of this computer's deployments list, as the shared reader gives it (packages/client
 *  deployment-list.mjs): its canonical path, its name and the kernel's state of it. */
const listedRow = (path, name, state = "ok") => Object.freeze({ path, name, state });
const LISTED = Object.freeze([listedRow("/home/u/work/sandbox", "sandbox"), listedRow("/home/u/work/garnet-notes", "garnet-notes")]);
/** A run that can show three things: this workspace on this machine and on garnet, another
 *  workspace on quartz, and basalt, never reached in this run; with two rows of the list that
 *  are not served. The roster lists the machine that was not reached first. */
function crowded(rows = LISTED) {
  const basalt = machine("basalt", { probe: unreached("E_SSH", "Permission denied (publickey)."), workspace: null, instances: [] });
  const state = heard(stateOf(reporting(NEAR), { cli: READS }), answer(basalt, machine("quartz", { workspace: LEDGER }), machine("garnet")), tick(0));
  return reduce(state, { listed: { rows } }).state;
}
/** The rows the shared home gives a switcher for a state. */
const choiceRows = (state) => workspaceChoiceRows(workspaceChoices(heldOf(state, AT), TERMS));
/** A row of the list that is offered, as the row the shared filter reads: its name and its short path. */
const folderRow = (state, { path, name }) => ({ label: name, place: shortPath(path, { home: state.home }) });
/** A switcher's items as a test reads them: a heading in brackets, a workspace's indicator line
 *  after `· `, a choice as its label, its place and what it says of deployments that are not live. */
const said = (items) => items.map((item) => (item.heading !== undefined ? `[${item.heading}]` : item.indicator !== undefined ? `· ${item.indicator}`
  : [item.label, item.place ?? null, item.notLiveText ?? null]));
/** The indicator lines of crowded()'s two workspaces: one per deployment, each by its machine. */
const CROWDED_LINES = Object.freeze({ "acme-platform": ["This machine", "garnet"], ledger: ["quartz"] });
/** A workspace of crowded() as said() reads it: its name, then its indicator lines. */
const workspaceSaid = (label, lines = CROWDED_LINES[label]) => [[label, null, null], ...lines.map((line) => `· ${line}`)];
/** The same state with the switcher's selection on a key. */
const choosing = (state, key) => Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, selected: key }) });
/** The same state with this text in the switcher's filter. */
const asked = (state, query) => Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, query }) });

test("the switcher lists the views in the order the shared rows give, the ones matched to no workspace after the others under the shared heading, then the rows of this computer's list not served under the TUI's own with their short path", () => {
  const state = crowded(), rows = choiceRows(state), s = switcher(state, AT);
  assert.deepEqual(rows.map((row) => [row.label, row.unattached]), [["acme-platform", false], ["ledger", false], ["basalt", true]]);
  const row = (r) => [r.label, r.place, r.notLiveText];
  assert.deepEqual(said(s.items), [
    ...rows.filter((r) => !r.unattached).flatMap((r) => workspaceSaid(r.label)),
    `[${UNMATCHED_SECTION}]`,
    ...rows.filter((r) => r.unattached).map(row),
    `[${OFFERED_SECTION}]`,
    ...LISTED.map((listed_) => [listed_.name, shortPath(listed_.path, { home: "/home/u" }), null]),
  ]);
  assert.deepEqual(s.items.filter((item) => item.heading !== undefined), [{ heading: UNMATCHED_SECTION, shared: true }, { heading: OFFERED_SECTION, shared: false }]);
  assert.equal(OFFERED_SECTION, "On this machine, not opened");
  assert.deepEqual(LISTED.map((listed_) => shortPath(listed_.path, { home: "/home/u" })), ["~/work/sandbox", "~/work/garnet-notes"]);
  // A machine never reached in this run is matched to no workspace, and is listed under its own name.
  const loose = rows.find((r) => r.unattached);
  assert.deepEqual([loose.label, loose.id], ["basalt", "remote:basalt:acme-1"]);
  assert.equal(state.memory.has("basalt:acme-1"), false, "nothing was remembered of it");
  // The mark of what is open: the one row whose view holds the open deployment.
  const views = viewModel(heldOf(state, AT), TERMS).views, holds = views.find((v) => v.deployments.includes(state.open));
  assert.deepEqual(s.items.filter((item) => item.open).map((item) => item.label), [rows.find((r) => r.id === holds.id).label]);
  assert.deepEqual(s.items.filter((item) => item.open !== undefined).map((item) => item.open), [true, false, false]);
  const there = second(state);
  assert.equal(there.open, "remote:quartz:acme-1");
  assert.deepEqual(switcher(there, AT).items.filter((item) => item.open !== undefined).map((item) => item.open), [false, true, false]);
  // What Enter opens: each view's primary deployment, the shared home's.
  assert.deepEqual(s.items.filter((item) => item.primary !== undefined).map((item) => item.primary), rows.map((r) => views.find((v) => v.id === r.id).primary));
  assert.deepEqual(s.items.filter((item) => item.path !== undefined).map((item) => [item.path, item.state, item.refused]), LISTED.map((listed_) => [listed_.path, "ok", false]));
  assert.equal(s.keys.length, 5);
  assert.equal(new Set(s.keys).size, 5);
  assert.deepEqual(s.keys, s.items.filter((item) => item.key !== undefined).map((item) => item.key));
  assert.deepEqual([s.selected, s.empty], [s.keys[0], null], "with no selection of its own the first choice is selected");
  // A deployment that is not live says its state in the shared words on its own line; the workspace's row says no count.
  const lost = heard(state, { thrown: "the pipe closed" }, tick(1));
  assert.deepEqual(said(switcher(lost, AT).items).slice(0, 5), [...workspaceSaid("acme-platform", ["This machine", "garnet · remembered"]), ...workspaceSaid("ledger", ["quartz · remembered"])]);
  assert.equal(switcher(lost, AT).items[0].notLiveText, undefined);
});

test("the switcher's filter keeps a view and a row of the list by the same shared rule, over what each shows, and a heading stands only over rows that are left", () => {
  const state = crowded(), rows = choiceRows(state), folders = LISTED.map((listed_) => ({ ...listed_, ...folderRow(state, listed_) }));
  for (const query of ["", "GARNET", " quartz ", "ssh", "sandbox", "~/work", "acme", "notes", "this machine", "zzz"]) {
    const s = switcher(asked(state, query), AT);
    // A workspace is kept by its name and its indicator lines; a view matched to no workspace by its name and its place.
    const views = rows.filter((r) => (r.unattached ? choiceMatches(r, query) : choiceMatches({ label: r.label, place: CROWDED_LINES[r.label].join(" ") }, query)));
    const offered = folders.filter((folder) => choiceMatches(folder, query));
    const matched = views.filter((r) => !r.unattached), loose = views.filter((r) => r.unattached);
    assert.deepEqual(said(s.items), [
      ...matched.flatMap((r) => workspaceSaid(r.label)),
      ...(loose.length ? [`[${UNMATCHED_SECTION}]`, ...loose.map((r) => [r.label, r.place, r.notLiveText])] : []),
      ...(offered.length ? [`[${OFFERED_SECTION}]`, ...offered.map((folder) => [folder.label, folder.place, null])] : []),
    ], JSON.stringify(query));
    assert.equal(s.empty, views.length + offered.length ? null : "nomatch", JSON.stringify(query));
    assert.equal(s.selected, s.keys[0] ?? null);
  }
  const labelled = (query) => switcher(asked(state, query), AT).items.filter((item) => item.key !== undefined).map((item) => item.label);
  assert.deepEqual(labelled("GARNET"), ["acme-platform", "garnet-notes"], "a workspace by a machine of it and a row of the list by its name, whatever the case");
  assert.deepEqual(labelled("~/WORK"), ["sandbox", "garnet-notes"], "a row of the list by its short path");
  assert.deepEqual(labelled("ssh"), ["basalt"], "a view matched to no workspace by its short reason");
  assert.deepEqual(labelled("zzz"), []);
  assert.deepEqual(switcher(asked(state, "zzz"), AT).items, []);
  // A selection the filter hides falls to the first choice left; one it keeps stays.
  const last = switcher(state, AT).keys.at(-1);
  const on = (query) => switcher(Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, query, selected: last }) }), AT);
  assert.equal(on("notes").selected, last);
  assert.equal(on("ledger").selected, on("ledger").keys[0]);
});

test("the switcher is empty in two ways, none when there is nothing to list and nomatch when the filter keeps nothing, whether a view or a row of the list was there to match", () => {
  const nothing = initialState({ deployment: null, cli: READS, home: "/home/u" });
  assert.deepEqual([nothing.view, nothing.open], ["switcher", null]);
  const none = switcher(nothing, AT);
  assert.deepEqual({ items: none.items, keys: none.keys, selected: none.selected, empty: none.empty }, { items: [], keys: [], selected: null, empty: "none" });
  assert.equal(switcher(asked(nothing, "zzz"), AT).empty, "none", "with nothing to match in, it is still none");
  assert.deepEqual(choiceRows(nothing), [], "the shared home has no choice either");
  const m = seen(nothing);
  assert.deepEqual([m.under, m.open, m.switcher.empty, m.switcher.rows.length], ["switcher", false, "none", 0]);
  assert.equal(seen(asked(crowded(), "zzz")).switcher, null, "the Instances view has no switcher in its model");
  assert.equal(seen(press(asked(crowded(), "zzz"), ["w", "w"]).state).switcher.empty, "nomatch");
  // Started outside every deployment, with rows of the list only: they are the choices, and a
  // filter that keeps none of them is nomatch. A read that answered no row, or one that failed
  // before any answered, leaves nothing to list: none.
  const only = reduce(nothing, { listed: { rows: LISTED } }).state;
  assert.deepEqual([switcher(only, AT).empty, switcher(only, AT).keys], [null, LISTED.map((listed_) => `path\u0000${listed_.path}`)]);
  assert.equal(switcher(asked(only, "zzz"), AT).empty, "nomatch", "rows of the list to match in, none matched");
  assert.equal(switcher(asked(only, "sandbox"), AT).empty, null);
  assert.equal(switcher(reduce(only, { listed: { rows: [] } }).state, AT).empty, "none", "a read that answered no row");
  assert.equal(switcher(reduce(nothing, { listed: { failure: { code: "E_DEPLOYMENTS_LOCKED", message: "the list is busy" } } }).state, AT).empty, "none", "a read that failed, with no row read before");
  assert.equal(switcher(asked(reduce(only, { listed: { rows: [] } }).state, "zzz"), AT).empty, "none");
  // No line of the TUI's own stands among the items: every one is a heading, an indicator line or a choice.
  assert.equal(switcher(crowded(), AT).items.every((item) => item.heading !== undefined || item.indicator !== undefined || item.key !== undefined), true);
  // Started outside a deployment with one machine reached: its view is the machine's own, and its one line names the machine.
  const far = heard(nothing, answer(machine("garnet")), tick(0));
  assert.deepEqual(switcher(far, AT).items.map((item) => item.indicator ?? [item.label, item.primary, item.open]), [[choiceRows(far)[0].label, GARNET, false], "garnet"]);
});

test("the model of the switcher: the rows of its window with the selected one marked, nothing of a workspace in the sidebar's title, the switcher's own filter, and the same under the help", () => {
  const state = press(crowded(), ["w", "w"]).state, s = switcher(state, AT), m = seen(state);
  assert.deepEqual([m.view, m.under, m.open], ["switcher", "switcher", true]);
  assert.deepEqual(m.switcher.rows, s.items.map((item) => (item.key === undefined ? item : { ...item, selected: item.key === s.selected })));
  assert.deepEqual(m.switcher.rows.filter((row) => row.selected).map((row) => row.label), ["acme-platform"]);
  assert.deepEqual([m.switcher.above, m.switcher.below, m.switcher.empty, m.switcher.said, m.switcher.failure, m.switcher.removing, m.switcher.removable], [0, 0, null, null, null, false, false]);
  assert.deepEqual([m.list, m.detail, m.workspace, m.machines, m.counts, m.readAt, m.notice, m.note, m.empty, m.observed], [[], null, "", 0, [], null, null, null, null, true]);
  assert.deepEqual(m.filter, { editing: false, query: "" });
  // The filter the model carries is the switcher's, not the Instances view's.
  const both = Object.freeze({ ...asked(state, "led"), filter: Object.freeze({ editing: false, query: "solo" }) });
  assert.deepEqual(seen(both).filter, { editing: false, query: "led" });
  assert.deepEqual(seen(both).switcher.rows.map((row) => row.label ?? `· ${row.indicator}`), ["ledger", "· quartz"]);
  assert.deepEqual(seen(Object.freeze({ ...both, view: "instances", back: "instances" })).filter, { editing: false, query: "solo" });
  // Only the rows in the pane are laid out, and the selected one is among them.
  const last = Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, selected: s.keys.at(-1) }) });
  for (const page of [4, 3, 2, 1]) {
    const small = seen(last, 80, page).switcher;
    assert.equal(small.rows.length <= page, true, `a pane of ${page} rows`);
    assert.equal(small.above + small.rows.length + small.below, s.items.length);
    assert.deepEqual(small.rows.filter((row) => row.selected).map((row) => row.label), ["garnet-notes"], `a pane of ${page} rows shows the selected choice`);
  }
  // Under the help the title is still the switcher's.
  const help = seen(press(state, ["?"]).state);
  assert.deepEqual([help.view, help.under, help.workspace, help.switcher.rows.length], ["help", "switcher", "", s.items.length]);
  // In the Instances view there is no switcher in the model.
  assert.deepEqual([seen(crowded()).switcher, seen(crowded()).under, seen(crowded()).open], [null, "instances", true]);
});

test("two hundred roster groups: the switcher lists every one in the order the shared rows give, each a choice of its own, and lays out only the rows in the pane", () => {
  const groups = Array.from({ length: 200 }, (_, i) => (i % 2 === 0
    ? machine(`node-${i}`, { workspace: { ...IDENTITY, key: `github.com/acme/ws-${i}` } })
    : machine(`node-${i}`, { probe: unreached("E_SSH", "no route to the host"), workspace: null, instances: [] })));
  const read = heard(stateOf(reporting(NEAR), { cli: READS }), answer(...groups), tick(0));
  assert.equal(read.remote.remoteGroups.length, 200);
  const rows = choiceRows(read), s = switcher(read, AT);
  assert.equal(rows.length, 201);
  assert.deepEqual(s.items.filter((item) => item.key !== undefined).map((item) => item.label), [...rows.filter((r) => !r.unattached), ...rows.filter((r) => r.unattached)].map((r) => r.label));
  assert.deepEqual([rows.filter((r) => !r.unattached).length, rows.filter((r) => r.unattached).length], [101, 100]);
  assert.equal(s.items.length, 303, "every choice, the one indicator line of each of the 101 workspaces, and the one heading");
  assert.equal(new Set(s.keys).size, 201);
  const state = press(read, ["w", "w"]).state;
  for (const page of [19, 5, 1]) {
    const m = seen(state, 80, page).switcher;
    assert.equal(m.rows.length <= page, true, `a pane of ${page} rows lays out ${m.rows.length}`);
    assert.equal(m.above + m.rows.length + m.below, 303, `page ${page}`);
  }
  const last = seen(Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, selected: s.keys.at(-1) }) }), 80, 19).switcher;
  assert.deepEqual([last.above, last.rows.length, last.below], [285, 18, 0]);
  assert.equal(last.rows.at(-1).selected, true);
  // While the switcher says a line of its own (the open workspace is no longer listed), that line
  // takes one row of the pane: the window is one row shorter, and no choice is hidden for it.
  const saying = Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, line: "gone" }) });
  for (const page of [19, 5]) {
    const plain = seen(state, 80, page).switcher, m = seen(saying, 80, page).switcher;
    assert.equal(m.said, "gone");
    assert.deepEqual([m.above, m.rows.length, m.below], [0, windowOf({ top: 0, count: 303, height: page - 1 }).size, 303 - windowOf({ top: 0, count: 303, height: page - 1 }).size], `page ${page}`);
    assert.equal(plain.rows.length - m.rows.length, 1, `page ${page}: one row less than without the line`);
    assert.equal(m.rows.some((row) => row.selected), true, `page ${page}: the selected choice is drawn`);
  }
  assert.deepEqual([seen(state, 80, 19).switcher.rows.length, seen(saying, 80, 19).switcher.rows.length], [18, 17]);
  // So does the filter field while it is typed or kept (switcherHeight), on a row of its own: with the line, two rows.
  const typing = (s) => Object.freeze({ ...s, switcher: Object.freeze({ ...s.switcher, editing: true }) });
  assert.deepEqual([seen(typing(state), 80, 19).switcher.rows.length, seen(typing(saying), 80, 19).switcher.rows.length], [17, 16]);
  assert.equal(seen(Object.freeze({ ...state, switcher: Object.freeze({ ...state.switcher, query: "node" }) }), 80, 19).switcher.rows.length, 17, "a kept filter: its field stays");
  // The switcher is an overlay: its window is as tall as `body`, the main area's rows, whatever the list's `page`.
  assert.equal(model(state, { page: 5, body: 19, now: NOW, at: AT, cols: 80 }).switcher.rows.length, 18);
  // With room to spare the line hides nothing.
  const few = press(crowded(), ["w", "w"]).state, told = Object.freeze({ ...few, switcher: Object.freeze({ ...few.switcher, line: "gone" }) });
  assert.deepEqual([seen(told, 80, 11).switcher.rows.length, seen(told, 80, 11).switcher.below], [10, 0], "ten rows and the line fill a pane of eleven");
  assert.deepEqual([seen(few, 80, 10).switcher.rows.length, seen(told, 80, 10).switcher.rows.length, seen(told, 80, 10).switcher.below], [10, 8, 2], "one row short: the cut note takes another");
  // This workspace's own view holds none of them.
  assert.deepEqual([seen(read).machines, shape(seen(read).list)], [0, NEAR_DRAWN]);
});

// --- One workspace across machines in the switcher (#482) --------------------------------

/** The product owner's shape: this deployment (acme-platform) on this machine and on builder, and a second
 *  workspace (lab) on builder under the label `builder (lab)` and on this machine at ~/Work/lab,
 *  which is on this computer's list and not opened. */
const LAB_PATH = "/home/u/Work/lab";
const LAB = Object.freeze({ ...IDENTITY, key: "github.com/example-org/lab-oats-workspace", defaultTeam: Object.freeze({ label: "eng", team: "team-lab" }), teams: Object.freeze({ eng: "team-lab" }) });
const BUILDER_LAB = "remote:builder:lab-1";
function productOwnerShape() {
  const builder = machine("builder"), lab = machine("builder", { id: "builder:lab-1", label: "builder (lab)", workspace: LAB, target: { workspace: "/home/dev/Work/lab", sshHost: "builder.example" } });
  const state = heard(stateOf(reporting(NEAR), { cli: READS }), answer(builder, lab), tick(0));
  return reduce(state, { listed: { rows: [listedRow(DEPLOYMENT, "deploy"), listedRow(LAB_PATH, "lab")] } }).state;
}
/** What an identity read answers of a deployment that reports `identity` (packages/client deployment-identity.mjs). */
const learnedOf = (identity) => ({ ok: true, workspace: { reachable: true, ...identity } });
const identityOf = (state, path, read) => reduce(state, { identity: { path, read } }).state;

test("The product owner's shape: before the identity of ~/Work/lab is read it is a row of its own under the TUI's heading; once read, the switcher has one row per workspace, each with a line per deployment, and nothing is left under the heading", () => {
  const before = productOwnerShape();
  assert.deepEqual(said(switcher(before, AT).items), [
    ["acme-platform", null, null], "· This machine", "· builder",
    ["lab-oats-workspace", null, null], "· builder (lab)",
    `[${OFFERED_SECTION}]`, ["lab", "~/Work/lab", null],
  ]);
  const after = identityOf(before, LAB_PATH, learnedOf(LAB));
  const s = switcher(after, AT);
  assert.deepEqual(said(s.items), [
    ["acme-platform", null, null], "· This machine", "· builder",
    // Named by the listed deployment, a local name to the shared rule: the row keeps it once opened.
    ["lab", null, null], "· This machine · not opened", "· builder (lab)",
  ]);
  assert.equal(s.items.some((item) => item.heading === OFFERED_SECTION), false, "nothing is left under On this machine, not opened");
  assert.deepEqual(s.keys.length, 2);
  // Nothing is told by colour: the open workspace carries the open mark, the other none.
  assert.deepEqual(s.items.filter((item) => item.key !== undefined).map((item) => [item.label, item.open]), [["acme-platform", true], ["lab", false]]);
  // What Enter asks: the listed deployment first, then the workspace on this machine, then builder's.
  const lab = s.items.find((item) => item.label === "lab");
  assert.deepEqual([lab.join, lab.opens, lab.primary], [[LAB_PATH], [LAB_PATH, BUILDER_LAB], LAB_PATH]);
  // The match is the shared rule's: the shared view model of the same deployments has the same workspaces.
  const shared = listedViews(modelHeld(after, AT), [listedRow(LAB_PATH, "lab")], TERMS);
  assert.deepEqual(shared.views.map((v) => [v.name, v.deployments]), [["acme-platform", [DEPLOYMENT, "remote:builder:acme-1"]], ["lab", [BUILDER_LAB, LAB_PATH]]]);
  // The filter reads a workspace's lines: a machine finds it.
  assert.deepEqual(switcher(asked(after, "not opened"), AT).keys, [s.keys[1]]);
  assert.deepEqual(switcher(asked(after, "BUILDER (LAB)"), AT).keys, [s.keys[1]]);
});

test("The product owner's shape, drawn: the workspace rows with their dim lines under them, in the switcher's columns", () => {
  const state = press(identityOf(productOwnerShape(), LAB_PATH, learnedOf(LAB)), ["w", "w"]).state;
  const { lines, area } = draw(state, { cols: 100, rows: 24 });
  const main = lines.map((line) => line.slice(100 - area - 1).trimEnd()).filter(Boolean);
  assert.deepEqual(main.slice(0, 5), ["> * acme-platform", "      This machine", "      builder", "    lab", "      This machine · not opened"]);
});

test("The product owner's shape in the list of workspaces: one row per workspace, by its name, whatever its machines; ~/Work/lab not opened is no row of its own, and once its identity is read lab is one row, \"lab\", whether builder answered the last read or not", () => {
  const labels = (state) => workspaceList(state, AT).lines.map((line) => line.label);
  assert.deepEqual(labels(productOwnerShape()), ["acme-platform", "lab-oats-workspace"], "builder's lab; this machine's ~/Work/lab stays in the switcher");
  const state = identityOf(productOwnerShape(), LAB_PATH, learnedOf(LAB));
  assert.deepEqual(labels(state), ["acme-platform", "lab"]);
  assert.deepEqual(workspaceList(state, AT).lines.map((line) => Object.keys(line).sort()), [["current", "key", "label", "waiting"], ["current", "key", "label", "waiting"]], "a row is its name: no state, no place");
  assert.deepEqual(labels(heard(state, { thrown: "the pipe closed" }, tick(1))), ["acme-platform", "lab"], "builder not reached: the same rows");
  // A workspace only ~/Work/lab is of is not a row: it is this computer's deployment not opened.
  const own = identityOf(productOwnerShape(), LAB_PATH, learnedOf({ ...LAB, key: "github.com/example-org/elsewhere" }));
  assert.deepEqual(labels(own), ["acme-platform", "lab-oats-workspace"]);
  assert.equal(switcher(own, AT).keys.length, 3, "the switcher offers it");
});

test("the list of workspaces' cursor follows its row's deployments when an identity read changes the rows: on builder's lab, it stays on lab's row once ~/Work/lab joins it, and Enter opens what was under the cursor", () => {
  const focused = press(productOwnerShape(), ["w", "down"]).state;
  const builder = focused.workspaceCursor;
  assert.equal(listChoice(focused, builder).label, "lab-oats-workspace");
  assert.deepEqual(press(focused, ["enter"]).effects.at(-1) !== undefined, true);
  const placed = identityOf(focused, LAB_PATH, learnedOf(LAB));
  const lab = workspaceList(placed, AT).rows.find((row) => listChoice(placed, row.key)?.label === "lab");
  assert.equal(placed.workspaceCursor, lab.key, "on lab's row, which holds builder's lab and ~/Work/lab now");
  assert.match(draw(placed, { cols: 100, rows: 24 }).lines.find((line) => line.startsWith(">")), /^> lab\b/);
  assert.deepEqual(press(placed, ["enter"]).effects.at(-1), { join: { paths: [LAB_PATH], opens: [LAB_PATH, BUILDER_LAB] } });
  const away = identityOf(placed, LAB_PATH, { ok: true, workspace: null });
  assert.equal(listChoice(away, away.workspaceCursor).label, "lab-oats-workspace", "taken away again: back on builder's");
});

test("a listed deployment whose identity read failed or timed out stays a row of its own, saying why; one whose identity attaches to no workspace says the shared reason; a stale row of the list is never matched", () => {
  const base = productOwnerShape();
  const at = (state) => switcher(state, AT).items.filter((item) => item.path !== undefined).map((item) => [item.label, item.place]);
  assert.deepEqual(at(identityOf(base, LAB_PATH, { ok: false, reason: { code: "E_CLI_TIMEOUT", message: "The deployment observation exceeded its time limit." } })), [["lab", "Timed out · ~/Work/lab"]]);
  assert.deepEqual(at(identityOf(base, LAB_PATH, { ok: false, reason: { code: "E_NO_DEPLOYMENT", message: "no deployment here", origin: "kernel" } })), [["lab", "Not read · ~/Work/lab"]]);
  assert.deepEqual(at(identityOf(base, LAB_PATH, learnedOf({ ...LAB, keyFrom: "member" }))), [["lab", "Workspace not known yet · ~/Work/lab"]]);
  assert.deepEqual(at(identityOf(base, LAB_PATH, { ok: true, workspace: null })), [["lab", "Reports no workspace · ~/Work/lab"]]);
  // Still a row of the list: Enter admits it as it did, and Remove acts on it.
  const failed_ = identityOf(base, LAB_PATH, { ok: false, reason: { code: "E_CLI_TIMEOUT", message: "late" } });
  assert.equal(switcher(failed_, AT).items.find((item) => item.path === LAB_PATH).state, "ok");
  // A row the kernel says is stale is not matched, whatever an earlier read learned of it.
  const stale = reduce(identityOf(base, LAB_PATH, learnedOf(LAB)), { listed: { rows: [listedRow(LAB_PATH, "lab", "missing")] } }).state;
  assert.deepEqual(at(stale), [["lab", "~/Work/lab"]]);
  assert.equal(switcher(stale, AT).items.some((item) => item.indicator?.includes("not opened")), false);
});

test("Enter on the lab workspace opens ~/Work/lab in this run and shows builder (lab) in the same view, before its first read: the identity read placed it; a folder that is no longer a deployment opens nothing", () => {
  const state = identityOf(productOwnerShape(), LAB_PATH, learnedOf(LAB));
  const { state: asking, effects } = press(state, ["w", "w", "j", "enter"]);
  assert.deepEqual(effects.at(-1), { join: { paths: [LAB_PATH], opens: [LAB_PATH, BUILDER_LAB] } });
  assert.equal(asking.ctxs.includes(LAB_PATH), false, "nothing is served before it is admitted");
  // lib/main.mjs admits it (a deployment now) and answers.
  const step = reduce(asking, { joined: { admitted: [LAB_PATH], opens: [LAB_PATH, BUILDER_LAB] }, at: AT });
  const opened = step.state;
  assert.deepEqual(step.effect, { refresh: { live: true } }, "read at once");
  assert.deepEqual([opened.view, opened.open, opened.ctxs], ["instances", LAB_PATH, [DEPLOYMENT, LAB_PATH]]);
  const panel = panelOf(opened, AT);
  assert.deepEqual(panel.deployments.map((d) => [d.id, d.machine]), [[LAB_PATH, "This machine"], [BUILDER_LAB, "builder (lab)"]], "one view: this machine's deployment and builder's");
  assert.equal(panel.workspace.name, "lab");
  assert.deepEqual(seen(opened).workspace, "lab");
  // In the switcher now: the same row, its name kept, this machine's deployment opened (not observed yet), and the open mark on it.
  const again = switcher(press(opened, ["w", "w"]).state, AT);
  assert.deepEqual(said(again.items).slice(3), [["lab", null, null], "· This machine · not observed", "· builder (lab)"]);
  assert.deepEqual(again.items.filter((item) => item.key !== undefined).map((item) => [item.label, item.open, item.join]), [["acme-platform", false, []], ["lab", true, []]]);
  // Its first read keeps it there, live. Served and read, it is named by the name its workspace gives
  // (the kernel's `workspace status`), as every served deployment is: the same here.
  const read_ = took(opened, reporting([], { identity: LAB, dir: LAB_PATH, name: "lab" }), 1, LAB_PATH);
  assert.deepEqual(said(switcher(read_, AT).items).slice(3), [["lab", null, null], "· This machine", "· builder (lab)"]);
  // Refused (the folder is not a deployment any more): nothing of this machine's opens, so the workspace opens on builder's.
  const refused = reduce(asking, { joined: { admitted: [], opens: [LAB_PATH, BUILDER_LAB] }, at: AT }).state;
  assert.deepEqual([refused.open, refused.ctxs], [BUILDER_LAB, [DEPLOYMENT]]);
  // With nothing at all to open, the switcher stays and the list is read again.
  const none = reduce(asking, { joined: { admitted: [], opens: [LAB_PATH] }, at: AT });
  assert.deepEqual([none.state.view, none.state.open, none.effect], ["switcher", DEPLOYMENT, { list: true }]);
});

test("a failed identity read's reason is drawn at 80 columns: the reason comes before the path, so the path is what a narrow row cuts", () => {
  const failedRead = identityOf(press(productOwnerShape(), ["w", "w"]).state, LAB_PATH, { ok: false, reason: { code: "E_CLI_TIMEOUT", message: "The deployment observation exceeded its time limit." } });
  const row = draw(failedRead, { cols: 80, rows: 24 }).lines.find((line) => / lab /.test(line) && !line.includes("· builder"));
  assert.match(row, /lab +Timed out/);
});

test("the switcher's selection follows the deployment it stood on: a listed row whose identity is learned is selected in its workspace's row, so Enter opens that workspace; when a later answer takes the workspace away the selection is back on the row", () => {
  const before = press(productOwnerShape(), ["w", "w", "j", "j"]).state;
  const chosen = (state) => { const s = switcher(state, AT); return s.items.find((item) => item.key === s.selected); };
  assert.equal(chosen(before).path, LAB_PATH);
  const learned = identityOf(before, LAB_PATH, learnedOf(LAB));
  assert.deepEqual([chosen(learned).label, chosen(learned).join], ["lab", [LAB_PATH]]);
  assert.deepEqual(press(learned, ["enter"]).effects.at(-1), { join: { paths: [LAB_PATH], opens: [LAB_PATH, BUILDER_LAB] } });
  // A workspace of its own (no other machine has it): the row comes with the answer, and goes with the next.
  const ALONE = Object.freeze({ ...LAB, key: "github.com/u/alone" });
  const alone = identityOf(before, LAB_PATH, learnedOf(ALONE));
  assert.deepEqual([chosen(alone).label, chosen(alone).join], ["lab", [LAB_PATH]]);
  const back = identityOf(alone, LAB_PATH, { ok: false, reason: { code: "E_CLI_TIMEOUT", message: "late" } });
  assert.equal(chosen(back).path, LAB_PATH);
});

test("Enter on the workspace already open from another machine, once its deployment of this machine is learned, opens that one in the same workspace and keeps its tabs; opening another workspace still closes them", () => {
  // The lab workspace open on builder, an agent's terminal open there as a tab.
  let state = press(productOwnerShape(), ["w", "w", "j", "enter"]).state;
  assert.equal(state.open, BUILDER_LAB);
  state = { ...state, cli: { ...state.cli, remote: ["roster", "session"] } };
  state = press(state, ["enter"]).state;
  assert.ok(state.opening, "the agent's terminal is being opened");
  state = reduce(state, { prepared: { id: state.opening.id } }).state;
  state = reduce(state, { shown: { id: state.terminal.id } }).state;
  state = leaderEscape(state).state;
  assert.equal(state.tabs.length, 1);
  const workspace = panelOf(state, AT).workspace.id;
  state = identityOf(state, LAB_PATH, learnedOf(LAB));
  const asking = press(state, ["w", "w", "enter"]);
  assert.deepEqual(asking.effects.at(-1), { join: { paths: [LAB_PATH], opens: [LAB_PATH, BUILDER_LAB] } });
  const step = reduce(asking.state, { joined: { admitted: [LAB_PATH], opens: [LAB_PATH, BUILDER_LAB] }, at: AT });
  assert.deepEqual([step.state.open, panelOf(step.state, AT).workspace.id, step.state.tabs.length], [LAB_PATH, workspace, 1]);
  assert.equal(step.effect.close, undefined, "no tab is closed");
  // The other workspace: its tabs go.
  const other = press(step.state, ["w", "w", "k", "enter"]);
  assert.deepEqual([other.state.open, other.state.tabs.length], [DEPLOYMENT, 0]);
  assert.equal(other.effects.some((effect) => effect?.close?.length === 1), true);
});

test("a later identity answer replaces the one before it, and a deployment this run serves is never offered or read for: the switcher is drawn from what has come in so far", () => {
  const base = productOwnerShape();
  const timedOut = identityOf(base, LAB_PATH, { ok: false, reason: { code: "E_CLI_TIMEOUT", message: "late" } });
  const read = identityOf(timedOut, LAB_PATH, learnedOf(LAB));
  assert.equal(read.identities.get(LAB_PATH).ok, true);
  assert.equal(switcher(read, AT).items.some((item) => item.path === LAB_PATH), false);
  // The deployment this run serves (on the list too) is a workspace's deployment, never a row of the list.
  assert.equal(switcher(read, AT).items.some((item) => item.path === DEPLOYMENT), false);
});

// --- This computer's deployments list in the switcher (awebai/oats#1390) -----------------

/** Rows of the list in the kernel's order (not the alphabet's): one that opens, the three stale
 *  states, and the deployment this run serves. */
const STALE = Object.freeze([
  listedRow("/home/u/work/sandbox", "sandbox"),
  listedRow("/home/u/acme-gone", "acme-gone", "missing"),
  listedRow("/home/u/acme-old", "acme-old", "not-a-deployment"),
  listedRow("/home/u/acme-locked", "acme-locked", "unreadable"),
  listedRow(DEPLOYMENT, "acme-platform"),
]);
/** A message of the kernel's that wraps: in the sentence of a Remove that failed, four rows at 60
 *  columns (whole), two at 120. */
const LONG_MESSAGE = "the list of deployments is held by another oats process right now; run `oats deployments remove <path>` again once it has finished";
/** One longer than four rows hold at any width here, 200 columns too. */
const HUGE_MESSAGE = Array.from({ length: 160 }, (_, i) => `step-${i}`).join(" ");

test("a row of this computer's list is a choice of its own: its name, its short path, the kernel's state of it and whether it was refused, in the kernel's order; a row this run serves is left out, and one admitted now is too", () => {
  const state = crowded(STALE), s = switcher(state, AT);
  const listed_ = s.items.filter((item) => item.path !== undefined);
  assert.deepEqual(listed_, [
    { key: "path\u0000/home/u/work/sandbox", label: "sandbox", place: "~/work/sandbox", path: "/home/u/work/sandbox", state: "ok", refused: false },
    { key: "path\u0000/home/u/acme-gone", label: "acme-gone", place: "~/acme-gone", path: "/home/u/acme-gone", state: "missing", refused: false },
    { key: "path\u0000/home/u/acme-old", label: "acme-old", place: "~/acme-old", path: "/home/u/acme-old", state: "not-a-deployment", refused: false },
    { key: "path\u0000/home/u/acme-locked", label: "acme-locked", place: "~/acme-locked", path: "/home/u/acme-locked", state: "unreadable", refused: false },
  ]);
  assert.equal(state.ctxs.includes(DEPLOYMENT), true, "the deployment the run serves");
  assert.equal(s.items.some((item) => item.path === DEPLOYMENT), false, "is a view, not a row of the list as well");
  assert.deepEqual(s.items.slice(-5).map((item) => item.heading ?? item.label), [OFFERED_SECTION, "sandbox", "acme-gone", "acme-old", "acme-locked"], "under the TUI's heading, last");
  // A stale row is matched by the same rule as any other: its name and its short path.
  assert.deepEqual(switcher(asked(state, "gone"), AT).items.filter((item) => item.key !== undefined).map((item) => item.label), ["acme-gone"]);
  assert.deepEqual(switcher(asked(state, "~/acme"), AT).items.filter((item) => item.key !== undefined).map((item) => item.label), ["acme-gone", "acme-old", "acme-locked"]);
  // A pick that turned out not to be a deployment is marked on its row alone.
  const refused = reduce(state, { refused: "/home/u/work/sandbox" }).state;
  assert.deepEqual(switcher(refused, AT).items.filter((item) => item.path !== undefined).map((item) => [item.label, item.refused]), [["sandbox", true], ["acme-gone", false], ["acme-old", false], ["acme-locked", false]]);
  // Admitted, a row is served from now on: it is a view, and the list does not offer it again.
  const admitted = reduce(state, { admitted: "/home/u/work/sandbox", at: AT }).state;
  assert.deepEqual(switcher(admitted, AT).items.filter((item) => item.path !== undefined).map((item) => item.label), ["acme-gone", "acme-old", "acme-locked"]);
  // A later read replaces the rows; one that failed keeps them.
  const reread = reduce(state, { listed: { rows: [listedRow("/home/u/acme-docs", "acme-docs")] } }).state;
  assert.deepEqual(switcher(reread, AT).items.filter((item) => item.path !== undefined).map((item) => item.label), ["acme-docs"]);
  const failed_ = reduce(state, { listed: { failure: { code: "E_DEPLOYMENTS_LOCKED", message: "the list is busy" } } }).state;
  assert.deepEqual(switcher(failed_, AT).items, s.items);
});

test("the model of the switcher says what stands above its rows: why the last read of the list failed, whether a Remove is asked and whether the selected row is one the remove key acts on", () => {
  const state = press(crowded(), ["w", "w"]).state, keys = switcher(state, AT).keys;
  const sandbox = `path\u0000${LISTED[0].path}`;
  assert.deepEqual(keys.slice(-2), LISTED.map((listed_) => `path\u0000${listed_.path}`));
  // Removable: a row of the list is, a view is not, and nothing selected is not.
  assert.equal(seen(choosing(state, sandbox)).switcher.removable, true);
  assert.equal(seen(choosing(state, keys[0])).switcher.removable, false, "a workspace");
  assert.equal(seen(initialState({ deployment: null, cli: READS, home: "/home/u" })).switcher.removable, false, "no choice");
  // The failure is the kernel's message as it came, and the rows of the last read stand under it.
  const failure = { code: "E_DEPLOYMENTS_LOCKED", message: "the list is busy" };
  const failed_ = reduce(state, { listed: { failure } }).state;
  assert.equal(seen(failed_).switcher.failure, failure.message);
  assert.deepEqual(seen(failed_).switcher.rows, seen(state).switcher.rows);
  assert.equal(seen(reduce(failed_, { listed: { rows: LISTED } }).state).switcher.failure, null, "a read that answered clears it");
  // Delete on a row of the list asks; Esc keeps the row, and nothing is asked any more.
  const asking = press(choosing(state, sandbox), ["delete"]).state;
  assert.deepEqual([seen(asking).switcher.removing, seen(asking).switcher.removable, seen(asking).switcher.said], [true, true, null]);
  assert.equal(seen(press(asking, ["escape"]).state).switcher.removing, false);
  assert.equal(seen(press(choosing(state, keys[0]), ["delete"]).state).switcher.removing, false, "Delete on a workspace asks nothing");
  // What a Remove answered.
  assert.deepEqual(seen(reduce(state, { removed: { path: LISTED[0].path, name: "sandbox", ok: true } }).state).switcher.said, { removed: "sandbox" });
  assert.deepEqual(seen(reduce(state, { removed: { path: LISTED[0].path, name: "sandbox", ok: false, reason: failure } }).state).switcher.said, { notRemoved: "sandbox", message: failure.message });
  // The two lines of the question take two rows of the pane: the window is that much shorter, and the selected row stays in it.
  const last = choosing(state, keys.at(-1)), asked_ = press(last, ["delete"]).state;
  for (const page of [8, 6, 4]) {
    const items = switcher(last, AT).items, keep = items.findIndex((item) => item.key === keys.at(-1));
    const plain = windowOf({ top: 0, count: items.length, height: page, keep }), shorter = windowOf({ top: 0, count: items.length, height: page - 2, keep });
    const m = seen(asked_, 80, page).switcher;
    assert.deepEqual([m.above, m.rows.length, m.below], [shorter.above, shorter.size, shorter.below], `page ${page}`);
    assert.equal(seen(last, 80, page).switcher.rows.length, plain.size, `page ${page}: without the question`);
    assert.equal(m.rows.some((row) => row.selected), true, `page ${page}: the selected row is drawn`);
  }
});

test("switcherLead counts the rows above the switcher's choices at the width it is given: one for a line of the TUI's own, two for the question, and a sentence with the kernel's words wrapped, four rows at most", () => {
  const state = press(crowded(), ["w", "w"]).state;
  const lead = (changes, failure = null) => Object.freeze({ ...state, listed: Object.freeze({ ...state.listed, failure }), switcher: Object.freeze({ ...state.switcher, line: null, removing: null, ...changes }) });
  const at = (s) => [60, 80, 120, 200].map((cols) => switcherLead(s, cols));
  assert.deepEqual(at(lead({})), [0, 0, 0, 0], "nothing above the rows");
  assert.deepEqual(at(lead({ line: "gone" })), [1, 1, 1, 1]);
  assert.deepEqual(at(lead({ removing: { path: LISTED[0].path, read: null } })), [2, 2, 2, 2], "the question's two lines");
  assert.deepEqual(at(lead({ line: { removed: "sandbox" } })), [1, 1, 1, 1]);
  assert.deepEqual(at(lead({}, { code: "E_X", message: "the list is busy" })), [2, 1, 1, 1], "the failure's sentence is longer than 57 cells: two rows at 60 columns");
  // A long sentence is wrapped at the width: more rows at 60 columns than at 120.
  assert.deepEqual(at(lead({ line: { notRemoved: "sandbox", message: LONG_MESSAGE } })), [4, 3, 2, 1]);
  assert.deepEqual(at(lead({}, { code: "E_X", message: LONG_MESSAGE })), [4, 3, 2, 1]);
  // Four rows at most for each sentence, at every width: what is left over is cut.
  assert.deepEqual(at(lead({ line: { notRemoved: "sandbox", message: HUGE_MESSAGE } })), [4, 4, 4, 4]);
  assert.deepEqual(at(lead({ line: { notRemoved: "sandbox", message: HUGE_MESSAGE }, removing: { path: LISTED[0].path, read: null } }, { code: "E_X", message: HUGE_MESSAGE })), [10, 10, 10, 10], "what a Remove answered, the failure and the question, together");
  assert.equal(SWITCHER_TEXT.notRemoved("sandbox", HUGE_MESSAGE).length > 4 * 200, true, "more than four rows hold at 200 columns");
  // A width that is not one is read as 80.
  for (const cols of [undefined, 0, -3, 1.5, "60"]) assert.equal(switcherLead(lead({ line: { notRemoved: "sandbox", message: LONG_MESSAGE } }), cols), 3, String(cols));
  // The model makes its window that much shorter at the width it is given (the switcher's is the whole width).
  const wrapped = lead({ line: { notRemoved: "sandbox", message: LONG_MESSAGE } });
  assert.deepEqual([seen(wrapped, 60, 8).switcher.rows.length, seen(wrapped, 120, 8).switcher.rows.length], [windowOf({ top: 0, count: 7, height: 4, keep: 0 }).size, windowOf({ top: 0, count: 7, height: 6, keep: 0 }).size]);
});

test("the words of this computer's list that are a line of their own: an add that failed leads with the TUI's words and shows the kernel's message as it came, once above the panes, and a change still running as the TUI leaves names the command", () => {
  assert.deepEqual(LIST_WORDS.notAdded("the list is busy"), [{ own: "This deployment was not added to this computer's list: " }, { shown: "the list is busy" }]);
  assert.equal(Object.isFrozen(LIST_WORDS.notAdded("x")), true);
  assert.equal(LIST_WORDS.leaving, "oats: a change to this computer's list of deployments is still running; `oats deployments` shows the list.");
  const told = reduce(stateOf(reporting(NEAR), { cli: READS }), { notListed: { code: "E_DEPLOYMENTS_LOCKED", message: "the list is busy" } }).state;
  assert.deepEqual(told.outcome, { said: LIST_WORDS.notAdded("the list is busy"), under: [] });
});

// --- A list scrolled away from its selection --------------------------------------------

test("while the store says a list is loose the model's window is where the list was scrolled, with the selected row in it or not, and the detail is still the selected instance's; else the window holds the selection", () => {
  const state = on(stateOf(observed(CROWD)), "inst-000");
  const at = (top, loose) => view(Object.freeze({ ...state, top, loose }), 10);
  const cut = (m) => [m.above, m.list.length, m.below, m.list[0].name, m.list.some((row) => row.selected)];
  assert.deepEqual(cut(at(50, false)), [0, 9, 291, "Inst 000", true], "held: the window moves to the selected row");
  assert.deepEqual(cut(at(50, true)), [50, 9, 241, "Inst 050", false], "loose: the window is the store's, and the selected row is not in it");
  assert.equal(at(50, true).detail.title, "inst-000");
  assert.deepEqual(cut(at(0, true)), [0, 9, 291, "Inst 000", true], "loose, with the selected row in the window: it is drawn selected");
  assert.deepEqual(cut(at(5000, true)), [291, 9, 0, "Inst 291", false], "a top past the end is the last window");
  assert.equal(stateOf(observed(CROWD)).loose, false, "a list is not loose until a key made it so");
  // The switcher's rows, by the switcher's own flag.
  const shown = press(crowded(), ["w", "w"]).state;
  const sw = (top, loose) => seen(Object.freeze({ ...shown, loose: !loose, switcher: Object.freeze({ ...shown.switcher, top, loose }) }), 80, 3).switcher;
  const rows = (s) => [s.above, s.rows.length, s.below, s.rows.some((row) => row.selected)];
  assert.equal(switcher(shown, AT).items.length, 10);
  assert.deepEqual(rows(sw(4, false)), [0, 2, 8, true], "held: the first choice, the selected one, is in the window");
  assert.deepEqual(rows(sw(4, true)), [4, 2, 4, false], "loose: the window is the store's");
  assert.deepEqual(rows(sw(0, true)), [0, 2, 8, true]);
  assert.equal(shown.switcher.loose, false);
});

// --- A row keeps its group (awebai/oats#971, fixed on main) ------------------------------

test("a row keeps its group while a filter or a collapse hides the rest of its cluster: the one row left of a cluster is not drawn among the single instances", () => {
  const state = stateOf(observed([instanceRow("dev", "lead"), instanceRow("dev", "child-a", { parentInstance: "lead" }), instanceRow("dev", "lead-alone")]));
  assert.deepEqual(names(state), ["lead", "child-a", null, "lead-alone"]);
  const grouped = (s) => sharedGroups(s).map((group) => [group.label, group.clusters.flatMap((cluster) => cluster.instances.map((row) => row.instance))]);
  const kept = [["lead", ["lead"]], ["independent", ["lead-alone"]]];
  // A filter that matches the root and not its child.
  const filtered = press(state, ["/", "l", "e", "a", "d", "enter"]).state;
  assert.deepEqual(grouped(filtered), kept, "the shared grouping decides a cluster's group on the full roster");
  assert.deepEqual(names(filtered), ["lead", null, "lead-alone"], "the empty item still parts the cluster's row from the single instances");
  // A collapse over the child.
  const closed = folded(state, "lead");
  assert.deepEqual(grouped(closed), kept);
  assert.deepEqual(names(closed), ["lead", null, "lead-alone"]);
  // With nothing before it, the group of single instances needs no empty item.
  assert.deepEqual(names(press(state, ["/", "a", "l", "o", "n", "e", "enter"]).state), ["lead-alone"]);
});

// --- A row's own text, and who said it (awebai/oats#855, after #982) ---------------------
//
// A row's `runtimeError` is text the TUI did not write. The shared home says who made it: by the
// row's mark (`runtimeErrorOrigin`), or by a reason of the row that names no origin and is that
// very text. The detail draws the text under the state in one of three forms. Every row here is
// made by the functions the reader calls: a cycle for a row of this machine; for a row of another
// machine the roster read over a fake exec, then the shared rule and the store's event. A row
// changed by hand after that is in a test whose title says so. A speaker's words are written out
// in each expected value: the TUI holds none of them, and this file is where they are pinned.

/** The facts under a detail's `state`: the ones with no label that follow it. */
function underState(detail) {
  const rest = detail.facts.slice(detail.facts.findIndex((f) => f.label === "state") + 1), end = rest.findIndex((f) => f.label !== "");
  return rest.slice(0, end < 0 ? rest.length : end);
}
/** What stands under the state of an instance of a state, by name. */
const saidUnder = (state, name) => underState(detailOf(state, name));
/** A row's text as the one fact it is. */
const textFact = (value) => [{ label: "", value, form: "wrap" }];
/** A wrapped fact as the detail's view draws it (views/detail.mjs asks shownLines for its value),
 *  in a pane wide enough for one row: the strings that reach the screen. */
const drawnFact = (f) => shownLines(f.value, 200, 6).map(textOf);
/** How many facts of a detail hold a text. */
const times = (detail, text) => detail.facts.filter((f) => f.value.includes(text)).length;
/** A state whose rows were changed by hand after the shared functions made them. For the edge
 *  cases only: no reader makes such a row, and each test that uses this says so in its title. */
const handMade = (entry, change) => stateOf({ ...entry, instances: entry.instances.map(change) });
/** A row without the mark of who made its text. */
const unmarked = ({ runtimeErrorOrigin: _mark, ...row }) => row;

const KERNEL_TEXT = "tmux: the socket /run/user/1000/oats/agents.sock could not be read";
/** A Herdr row as a kernel of 0.31 or later answers it: unsupported, with a reason of its own. */
const HERDR_NOW = Object.freeze({ running: null, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: this backend is gone", tmux: null });
/** A Herdr row of an older kernel: a session target, and a text of its Herdr probe. */
const HERDR_OLD = Object.freeze({ running: null, runtimeState: "unreachable", runtimeError: "herdr: the session server did not answer", sessionTarget: { backend: "herdr" }, tmux: null });
/** Two errors of a kernel's own: for one machine it did not reach, and for a roster read it refused whole. */
const SSH_FAILED = Object.freeze({ code: "E_SSH", message: "ssh: connect to host garnet.example port 22: No route to host" });
const BUSY = Object.freeze({ code: "E_SERVERS_BUSY", message: "the server registry is locked (another oats command holds it); nothing was changed" });

const GARNET_ROOT = "/home/dev/Agents/garnet";
/** A route saved on this machine, as the kernel lists it for a machine it did not reach, or that
 *  no longer lists the instance (lib/servers.mjs `rosterGroups`): a row with no state of its own. */
const savedRoute = (name, extra = {}) => remoteRow(GARNET_ROOT, name, { running: null, runtimeState: null, savedRoute: true, missingRemotely: false, ...extra });
/** garnet as the kernel lists it when it did not reach it: its error on the probe (none when
 *  `error` is undefined), no identity, and the routes saved here as its rows. */
const notReached = (error) => machine("garnet", { probe: { ok: false, ...(error === undefined ? {} : { error }) }, workspace: null, instances: [savedRoute("garnet-a"), savedRoute("garnet-b")] });
/** What the installed CLI prints for a roster read: an answer that lists these groups, or its error. */
const printedRoster = (...groups) => ({ schemaVersion: 1, ok: true, result: { groups } });
const printedError = (error) => ({ schemaVersion: 1, ok: false, error });
/** An exec (execFile's signature) of a CLI that prints this and exits 0. */
const printing = (document) => (bin, argv, options, callback) => { callback(null, typeof document === "string" ? document : JSON.stringify(document), ""); };
/** One roster read as lib/read.mjs `readRoster` makes it: the shared cliRemoteRoster over an exec,
 *  and its answer, or the message of what it threw, as the outcome `takeRoster` is given. `heard`
 *  above is the rest of that path: the shared rule, the memory of identities, the store's event. */
const rosterRead = (exec) => cliRemoteRoster(READS.bin, { exec }).then((envelope) => ({ envelope }), (error) => ({ thrown: String(error?.message ?? error) }));
/** This machine's deployment, and garnet after an answer that lists these rows. */
const withGarnet = async (...instances) => heard(stateOf(reporting(NEAR), { cli: READS }), await rosterRead(printing(printedRoster(machine("garnet", instances.length ? { instances } : {})))), tick(0));

// --- What a row carries -----------------------------------------------------------------

test("what a row of this machine carries is drawn under its state after the words of who made it: the kernel's text after \"OATS says:\" whatever key the kernel or the collector sent beside it, the terminal check's after the check's words, a Herdr row's reason of the kernel's own as the kernel's, the stand-in for an older kernel's Herdr row as the sentence it is, and a row with no text has no such line", () => {
  const kernelRows = [
    // The kernel answered unknown with its reason, and SENT a speaker's key that is not its own.
    instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: KERNEL_TEXT, runtimeErrorOrigin: "terminal-probe" }),
    // Probed, and the check fails.
    instanceRow("dev", "probed"),
    instanceRow("dev", "herdr-now", HERDR_NOW),
    instanceRow("dev", "herdr-old", HERDR_OLD),
    // Probed, and the check has nothing to say: the text the kernel's row carried stays the kernel's.
    instanceRow("dev", "told", { ...STOPPED, runtimeError: "the session was last seen an hour ago" }),
    instanceRow("dev", "fine"),
    // A key with no text beside it.
    instanceRow("dev", "keyed", { ...STOPPED, runtimeErrorOrigin: "kernel" }),
  ];
  const standIn = unsupportedText(kernelRows[3]);
  assert.equal(typeof standIn === "string" && standIn !== "" && standIn !== HERDR_OLD.runtimeError, true, "the stand-in is the shared home's sentence, not the text the older kernel sent");
  // Each row: the mark the shared home set, and the fact under the state (null: none).
  const expected = {
    lost: ["kernel", `OATS says: ${KERNEL_TEXT}`],
    probed: ["terminal-probe", `oats tui's terminal check says: ${CHECK_FAILED}`],
    "herdr-now": ["kernel", `OATS says: ${HERDR_NOW.runtimeError}`],
    "herdr-old": [undefined, standIn],
    told: ["kernel", "OATS says: the session was last seen an hour ago"],
    fine: [undefined, null],
    keyed: [undefined, null],
  };
  const honest = collecting({ probed: CHECK_FAILED });
  // The collector's answer is what a child printed: one that names a speaker on every answer is
  // believed no more than the kernel is.
  for (const [what, collect] of [["the collector as it is", honest], ["a collector that names the kernel on every answer", (row) => ({ ...honest(row), runtimeErrorOrigin: "kernel" })]]) {
    const { rows, input, entry } = cycle(kernelRows, { collect });
    assert.equal(rows.find((row) => row.instance === "lost").runtimeErrorOrigin, "terminal-probe", "the key the kernel sent is on the row the shared functions are given");
    assert.equal(input.some((row) => Object.hasOwn(row, "runtimeErrorOrigin")), false, "and it is not sent on to the collector");
    const state = stateOf(entry);
    for (const [name, [mark, value]] of Object.entries(expected)) {
      const { row } = panelRow(state, name), detail = detailOf(state, name);
      assert.equal(row.runtimeErrorOrigin, mark, `${what}, ${name}: the mark is the shared home's`);
      assert.deepEqual(underState(detail), value === null ? [] : textFact(value), `${what}, ${name}`);
      assert.equal(fact(detail, "held"), null, `${what}, ${name}`);
    }
    for (const name of ["fine", "keyed"]) assert.equal(after(detailOf(state, name), "state").label, "harness", `${what}, ${name}: the next fact is the next label`);
  }
});

test("what a row of another machine carries is drawn the same way: the text of a reached machine's row after \"OATS says:\" whatever key its host sent, the error the installed CLI printed for a machine it did not reach after \"OATS says:\", and the failure of a roster read that itself failed after the words of the read of other machines", async () => {
  const hostText = "tmux: the server on the host did not answer";
  const answered = await withGarnet(
    remoteRow(GARNET_ROOT, "garnet-a"),
    remoteRow(GARNET_ROOT, "garnet-told", { running: null, runtimeState: "unreachable", runtimeError: hostText, runtimeErrorOrigin: "roster-read" }),
    remoteRow(GARNET_ROOT, "garnet-herdr", { running: null, runtimeState: "unsupported", runtimeError: HERDR_NOW.runtimeError }),
  );
  const carried = (state, name) => { const { row } = panelRow(state, name); return [row.serverUnreached, row.runtimeErrorOrigin]; };
  // Reached: the host's kernel wrote the row's text, and this machine's kernel relayed it.
  assert.deepEqual(carried(answered, "garnet-told"), [false, "kernel"]);
  assert.deepEqual(saidUnder(answered, "garnet-told"), textFact(`OATS says: ${hostText}`));
  assert.deepEqual(saidUnder(answered, "garnet-herdr"), textFact(`OATS says: ${HERDR_NOW.runtimeError}`));
  assert.deepEqual([carried(answered, "garnet-a"), saidUnder(answered, "garnet-a")], [[false, undefined], []], "a row with no text has no line");
  // Not reached, and the kernel said why in its answer: the error on the machine's probe is the kernel's.
  const down = heard(answered, await rosterRead(printing(printedRoster(notReached(SSH_FAILED)))), tick(1));
  for (const name of ["garnet-a", "garnet-b"]) {
    assert.deepEqual(carried(down, name), [true, "kernel"], name);
    assert.deepEqual(saidUnder(down, name), textFact(`OATS says: ${SSH_FAILED.message}`), name);
  }
  // Not reached, because the read itself failed: no kernel answered, and the sentence is the read's own.
  const lost = heard(answered, await rosterRead(() => { throw new Error("spawn oats ENOENT"); }), tick(1));
  for (const name of ["garnet-a", "garnet-told"]) {
    const { row } = panelRow(lost, name);
    assert.equal(row.runtimeError.endsWith("spawn oats ENOENT"), true, "the shared sentence holds what was thrown");
    assert.deepEqual(carried(lost, name), [true, "roster-read"], name);
    assert.deepEqual(saidUnder(lost, name), textFact(`oats tui's read of other machines says: ${row.runtimeError}`), name);
  }
  assert.equal(saidUnder(lost, "garnet-told")[0].value.includes(hostText), false, "the text of its last report is not what is known of it now");
});

test("a machine that was not reached and whose error has no message reads, after the words of the read of other machines, the shared sentence for it: also when the installed CLI printed that error, on the machine's probe or for the whole read", async () => {
  const answered = await withGarnet();
  const cases = {
    "the kernel's error for the machine, with a code and no message": printedRoster(notReached({ code: "E_SSH" })),
    "no error at all on the machine's probe": printedRoster(notReached(undefined)),
    "the kernel's error for the whole read, with a code and no message": printedError({ code: BUSY.code }),
  };
  for (const [what, printed] of Object.entries(cases)) {
    const state = heard(answered, await rosterRead(printing(printed)), tick(1));
    for (const name of ["garnet-a", "garnet-b"]) {
      // The sentence is the shared home's for a machine with no message, taken from the row.
      const { row } = panelRow(state, name);
      assert.equal(typeof row.runtimeError === "string" && row.runtimeError !== "", true, `${what}, ${name}`);
      assert.deepEqual([row.serverUnreached, row.runtimeErrorOrigin], [true, "roster-read"], `${what}, ${name}`);
      assert.deepEqual(saidUnder(state, name), textFact(`oats tui's read of other machines says: ${row.runtimeError}`), `${what}, ${name}`);
    }
  }
});

test("the alarm for a copied error object: the row of a machine that was not reached, whose error the installed CLI printed, reads \"OATS says:\" from the roster read through the store to the detail, and at every later paint; the same read when it failed by itself reads as the read of other machines, and so does a copy of the kernel's error made by hand here", async () => {
  const answered = await withGarnet();
  const rows = (state, value, what) => { for (const name of ["garnet-a", "garnet-b"]) assert.deepEqual(saidUnder(state, name), textFact(value), `${what}, ${name}`); };
  // The kernel refused the whole read, in an envelope it printed.
  const calls = [];
  const outcome = await rosterRead((bin, argv, options, callback) => { calls.push([bin, argv]); callback(null, JSON.stringify(printedError(BUSY)), ""); });
  assert.deepEqual(calls, [[READS.bin, ["server", "roster", "--json"]]], "the read is the shared one, over the exec it is given");
  assert.deepEqual(outcome, { envelope: printedError(BUSY) }, "its answer is what was printed, field for field");
  const refused = heard(answered, outcome, tick(1));
  // THE KERNEL'S MARK IS ON THE `probe.error` OBJECT (kernel-made.mjs): a property no answer can
  // carry and no copy keeps, set where the CLI's answer is parsed and read again each time a
  // panel is made. So this test fails if a later change copies that object anywhere between
  // cliRemoteRoster and the model: a spread of the error, a JSON round trip, a structured clone
  // of the groups or of the state that holds them. A lost mark reads as the client's own read,
  // which is the safe side, and wrong. (A shallow copy of a group that still points at the same
  // error is harmless.)
  for (const group of refused.remote.remoteGroups) assert.equal(group.probe.error, outcome.envelope.error, "the store holds the very object the read answered");
  rows(refused, `OATS says: ${BUSY.message}`, "after the read");
  rows(press(refused, ["j", "k", "tab"]).state, `OATS says: ${BUSY.message}`, "after keys");
  rows(took(refused, reporting(NEAR), 2), `OATS says: ${BUSY.message}`, "after a later read of this machine's deployment");
  rows(reduce(refused, { collecting: true }).state, `OATS says: ${BUSY.message}`, "while the next roster read runs");
  // The same for the error of one machine inside an answer the kernel printed.
  const down = heard(answered, await rosterRead(printing(printedRoster(notReached(SSH_FAILED)))), tick(1));
  rows(down, `OATS says: ${SSH_FAILED.message}`, "the machine's own probe");
  rows(press(down, ["j", "k", "tab"]).state, `OATS says: ${SSH_FAILED.message}`, "the machine's own probe, after keys");
  // The contrast: the read failed by itself, and wrote its own envelope or threw. No kernel said these words.
  // The sentence of each is the shared read's own, taken from the row and not written here.
  const itself = {
    "the CLI did not answer in time": (bin, argv, options, callback) => { callback(Object.assign(new Error("killed"), { killed: true }), "", ""); },
    "the CLI printed no envelope": printing("not an envelope"),
    "the read threw": () => { throw new Error("spawn oats ENOENT"); },
  };
  for (const [what, exec] of Object.entries(itself)) {
    const state = heard(answered, await rosterRead(exec), tick(1)), sentence = panelRow(state, "garnet-a").row.runtimeError;
    assert.equal(typeof sentence === "string" && sentence !== "" && sentence !== BUSY.message, true, what);
    rows(state, `oats tui's read of other machines says: ${sentence}`, what);
  }
  // What the alarm rings for, made by hand once so that it is known to ring: the refused read's
  // state with its groups cloned. The kernel's words are then under the client's name.
  const copied = reduce(refused, { roster: { remote: structuredClone(refused.remote), memory: refused.memory, notes: refused.notes, at: tick(1) } }).state;
  assert.deepEqual(copied.remote.remoteGroups, refused.remote.remoteGroups, "field for field the same groups");
  rows(copied, `oats tui's read of other machines says: ${BUSY.message}`, "a copy");
});

// --- The three forms --------------------------------------------------------------------

test("the three forms of a row's text: after the words of a speaker; as the sentence it is, once, when a reason of the row that names no origin is that very text (the stand-in for an older kernel's Herdr row, on this machine and on another, also where that sentence blocks the row); and in quotation marks, after no words, when nobody vouches for it (a row made by hand: by the contract no read gives one)", async () => {
  const kernelRows = [
    instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: KERNEL_TEXT }),
    instanceRow("dev", "herdr-old", HERDR_OLD),
    instanceRow("dev", "odd"),
  ];
  const { entry } = cycle(kernelRows, { collect: collecting({ odd: CHECK_FAILED }) }), state = stateOf(entry);

  // A speaker: the row's mark names one, and the shared home's words for it go first.
  assert.equal(panelRow(state, "lost").row.runtimeErrorOrigin, "kernel");
  assert.deepEqual(saidUnder(state, "lost"), textFact(`OATS says: ${KERNEL_TEXT}`));
  assert.deepEqual(drawnFact(saidUnder(state, "lost")[0]), [`OATS says: ${KERNEL_TEXT}`], "and the view draws it whole");

  // The shared home's own sentence: no mark, and a reason with no origin that is this very text.
  const old = panelRow(state, "herdr-old").row, standIn = old.runtimeError, start = instanceActs(old).acts.find((act) => act.verb === "start");
  assert.equal(standIn, unsupportedText(kernelRows[1]), "the row's text is what the shared home answers for an older kernel's Herdr row");
  assert.notEqual(standIn, HERDR_OLD.runtimeError);
  assert.equal(Object.hasOwn(old, "runtimeErrorOrigin"), false);
  assert.deepEqual(start.reason, { code: "unsupported-session", sentence: standIn }, "the reason of its start act vouches for it: the same text, and no origin");
  assert.deepEqual(saidUnder(state, "herdr-old"), textFact(standIn), "as it is: no words before it and no quotation marks");
  assert.deepEqual([times(detailOf(state, "herdr-old"), standIn), fact(detailOf(state, "herdr-old"), "held")], [1, null], "once");
  // The same sentence on another machine's rows, one of them blocked by it.
  const far = await withGarnet(
    remoteRow(GARNET_ROOT, "garnet-old", { backend: "herdr", running: null, runtimeError: "herdr: the session server did not answer" }),
    remoteRow(GARNET_ROOT, "garnet-old-held", { backend: "herdr", addressable: false, running: null, runtimeError: "herdr: the session server did not answer" }),
  );
  for (const name of ["garnet-old", "garnet-old-held"]) {
    const { row } = panelRow(far, name), detail = detailOf(far, name);
    assert.deepEqual([row.runtimeError === standIn, Object.hasOwn(row, "runtimeErrorOrigin")], [true, false], name);
    assert.deepEqual(underState(detail), textFact(standIn), name);
    assert.deepEqual([times(detail, standIn), fact(detail, "held")], [1, null], `${name}: once, and no held line repeats it`);
  }
  assert.deepEqual(instanceActs(panelRow(far, "garnet-old-held").row).blocked, { code: "unaddressable", key: "herdr", sentence: standIn }, "the row is blocked by that very sentence, which names no origin");
  assert.equal(instanceActs(panelRow(far, "garnet-old").row).blocked, null);

  // Nobody vouches: no mark, and no reason at all. Made by hand: the read gives this row the
  // terminal check's mark, which is taken off here. By the contract the stand-in is the only
  // text of a row with no mark, so no read is asked for another: what is pinned is that a text
  // whose mark did not arrive claims nobody.
  assert.deepEqual(saidUnder(state, "odd"), textFact(`oats tui's terminal check says: ${CHECK_FAILED}`), "as the read made it");
  const bare = handMade(entry, (row) => (row.instance === "odd" ? unmarked(row) : row)), odd = panelRow(bare, "odd").row;
  assert.deepEqual([odd.runtimeError, Object.hasOwn(odd, "runtimeErrorOrigin")], [CHECK_FAILED, false]);
  assert.deepEqual([instanceActs(odd).blocked, instanceActs(odd).limited, instanceActs(odd).acts.map((act) => act.reason)], [null, null, [null, null, null]]);
  assert.deepEqual(saidUnder(bare, "odd"), textFact(`"${CHECK_FAILED}"`));
  assert.deepEqual(drawnFact(saidUnder(bare, "odd")[0]), [`"${CHECK_FAILED}"`]);
  assert.equal(fact(detailOf(bare, "odd"), "held"), null);
});

test("a text the filter withholds goes to the view as it came, with no words before it and no quotation marks around it, and the view draws the withheld word alone: for each of the three speakers and for a text nobody vouches for, also where the text blocks its row", async () => {
  const SECRET = "tmux: token: ghp_abcdefghijklmnopqrstuvwxyz0123456789 was refused";
  const CONTROL = "tmux: \x1b[2J\x1b[Hno server";
  const URL_WITH_PASSWORD = "fetch https://user:hunter2@example.com/roster failed";
  const local = stateOf(cycle([
    instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: SECRET }),
    instanceRow("dev", "probed"),
    instanceRow("dev", "odd", { backend: "herdr" }),
  ], { collect: collecting({ probed: CONTROL, odd: URL_WITH_PASSWORD }) }).entry);
  const answered = await withGarnet();
  const refused = heard(answered, await rosterRead(printing(printedError({ code: BUSY.code, message: CONTROL }))), tick(1));
  const threw = heard(answered, await rosterRead(() => { throw new Error(URL_WITH_PASSWORD); }), tick(1));
  // Each: the state, the instance, its mark, the text, and whether the text blocks the row.
  const cases = [
    [local, "lost", "kernel", SECRET, false], [local, "probed", "terminal-probe", CONTROL, false], [local, "odd", undefined, URL_WITH_PASSWORD, false],
    [refused, "garnet-a", "kernel", CONTROL, false], [refused, "garnet-b", "kernel", CONTROL, true],
    [threw, "garnet-b", "roster-read", panelRow(threw, "garnet-b").row.runtimeError, true],
  ];
  assert.equal(panelRow(threw, "garnet-b").row.runtimeError.endsWith(URL_WITH_PASSWORD), true);
  for (const [state, name, mark, text, blocks] of cases) {
    const { row } = panelRow(state, name), detail = detailOf(state, name), [f] = underState(detail), where = `${name}, ${mark}`;
    assert.deepEqual([row.runtimeError, row.runtimeErrorOrigin], [text, mark], where);
    assert.equal(displayLine(text), DETAIL_WITHHELD, `${where}: the shared filter withholds it`);
    assert.deepEqual(underState(detail), textFact(text), `${where}: the model's fact is the text as it came`);
    assert.deepEqual(drawnFact(f), ["[withheld]"], `${where}: the view draws the TUI's withheld word, alone`);
    assert.equal(textOf(shown(f.value)), "[withheld]", where);
    assert.equal(detail.facts.some((other) => other.value.includes("says:") || other.value.startsWith("\"")), false, `${where}: no lead introduces a withheld text or stands alone, and nothing is quoted`);
    assert.equal(instanceActs(row).blocked?.sentence === text, blocks, where);
    assert.deepEqual([fact(detail, "held"), times(detail, text)], [null, 1], `${where}: once, and no held line holds it again`);
  }
});

test("a text with nothing to show draws no line under the state, beside a speaker's mark or beside none: not a string, empty, or only spaces and line ends, on this machine and on another; and a row blocked by such a text has no held line either", async () => {
  const BLANK = " \n \n  ";
  const kernelRows = [
    instanceRow("dev", "blank", { running: null, runtimeState: "unreachable", runtimeError: BLANK }),
    instanceRow("dev", "empty", { running: null, runtimeState: "unreachable", runtimeError: "" }),
    // Probed rows whose check has nothing to say: what the kernel sent stays on the row as it came.
    instanceRow("dev", "number", { ...STOPPED, runtimeError: 7 }),
    instanceRow("dev", "record", { ...STOPPED, runtimeError: { message: "not a text" } }),
    instanceRow("dev", "list", { ...STOPPED, runtimeError: ["not a text"] }),
    instanceRow("dev", "none", STOPPED),
  ];
  const local = stateOf(cycle(kernelRows).entry);
  const none = (state, name, text, mark) => {
    const { row } = panelRow(state, name), detail = detailOf(state, name);
    assert.deepEqual([row.runtimeError, row.runtimeErrorOrigin], [text, mark], name);
    assert.equal(displayLine(text), null, `${name}: the shared filter has nothing to show`);
    assert.deepEqual(underState(detail), [], name);
    assert.equal(detail.facts.some((f) => f.value.includes("says:") || f.value.startsWith("\"")), false, `${name}: no lead stands alone, and nothing is quoted`);
    return detail;
  };
  // Only a text is given a mark: spaces and line ends are a text, and still nothing to show.
  for (const [name, mark] of [["blank", "kernel"], ["empty", undefined], ["number", undefined], ["record", undefined], ["list", undefined], ["none", undefined]]) {
    const detail = none(local, name, kernelRows.find((row) => row.instance === name).runtimeError, mark);
    assert.equal(after(detail, "state").label, "harness", name);
  }
  // Another machine: a reached machine's rows, then every kept row when the kernel's error for the read is such a text.
  const answered = await withGarnet(
    remoteRow(GARNET_ROOT, "garnet-a"), remoteRow(GARNET_ROOT, "garnet-b", { addressable: false, ...STOPPED }),
    remoteRow(GARNET_ROOT, "garnet-blank", { running: null, runtimeState: "unreachable", runtimeError: BLANK }),
    remoteRow(GARNET_ROOT, "garnet-number", { running: null, runtimeState: "unreachable", runtimeError: 7 }),
  );
  none(answered, "garnet-blank", BLANK, "kernel");
  none(answered, "garnet-number", 7, undefined);
  const refused = heard(answered, await rosterRead(printing(printedError({ code: BUSY.code, message: BLANK }))), tick(1));
  for (const name of ["garnet-a", "garnet-b"]) assert.equal(fact(none(refused, name, BLANK, "kernel"), "held"), null, name);
  // The row that cannot be addressed is blocked by that text, with its speaker: the reason is the
  // row's text, so no held line is drawn for it, and the text has nothing to show.
  assert.deepEqual(instanceActs(panelRow(refused, "garnet-b").row).blocked, { code: "unaddressable", key: "unreached", sentence: BLANK, origin: "kernel" });
  assert.equal(after(detailOf(refused, "garnet-b"), "state").label, "harness", "the state word says what is known");
});

// --- Nobody vouches ---------------------------------------------------------------------

test("hand-made rows: a text whose mark is absent, or is anything but one of the three speakers (\"unattributed\", another word, a speaker's name not as it is written, a number, an object, a list that reads as a speaker, a string with an escape byte, a lead's own words), stands in quotation marks through the filter, after no words, and the mark is in no fact", () => {
  const text = "tmux:\tno server\non \u202Ethat socket", line = displayLine(text);
  assert.equal(line, "tmux: no server on \uFFFDthat socket", "one line, and the override replaced: what the shared filter shows of the text");
  const { entry } = cycle([instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: text })]);
  // As the reader makes it the row has a speaker. Every row below is this one with its mark changed by hand.
  assert.deepEqual(saidUnder(stateOf(entry), "lost"), textFact(`OATS says: ${line}`));
  const marks = {
    absent: undefined,
    "the word of a reason nobody attributed": "unattributed",
    "another word": "desktop",
    "a speaker's name in another case": "Kernel",
    "a speaker's name with a space after it": "kernel ",
    "a name every object answers to": "toString",
    "the name of an object's prototype": "__proto__",
    "the empty string": "",
    "a number": 4711,
    null: null,
    "an object": { kernel: true },
    "a list that reads as a speaker's name": ["kernel"],
    "a string with an escape byte": "\x1b[2Jkernel",
    "a lead's own words": "OATS says:",
    "the client's own lead": "oats tui's terminal check says:",
  };
  for (const [what, mark] of Object.entries(marks)) {
    const state = handMade(entry, (row) => (what === "absent" ? unmarked(row) : { ...row, runtimeErrorOrigin: mark }));
    const { row } = panelRow(state, "lost"), detail = detailOf(state, "lost");
    assert.deepEqual([Object.hasOwn(row, "runtimeErrorOrigin"), row.runtimeErrorOrigin], [what !== "absent", mark], `${what}: the mark reaches the model as it was made`);
    assert.equal(originLead(mark, TERMS), null, `${what}: the shared home has no words for it`);
    assert.deepEqual(instanceActs(row).acts.map((act) => act.reason), [null, null, null], `${what}: and no reason of the row vouches for the text`);
    assert.deepEqual(underState(detail), textFact(`"${line}"`), what);
    assert.deepEqual(drawnFact(underState(detail)[0]), [`"${line}"`], `${what}: the view draws the same`);
    assert.equal(detail.facts.some((f) => f.value.includes("says:")), false, `${what}: no lead`);
    if (what !== "absent" && String(mark) !== "") assert.equal(detail.facts.some((f) => f.value.includes(String(mark))), false, `${what}: the mark is in no fact`);
    assert.equal(fact(detail, "held"), null, what);
  }
});

test("hand-made, the corner of awebai/oats#1026 item 7: a probed row of this machine that names the Herdr backend, with no session target and a state other than unsupported, carries the terminal check's text beside no mark, and its one reason, which names no origin, holds the stand-in and not that text: the text stands in quotation marks and names nobody, and no held line is drawn", () => {
  const { entry } = cycle([instanceRow("dev", "odd")], { collect: collecting({ odd: CHECK_FAILED }) });
  // By hand, all of it, so that the test says what the TUI does with such a row whatever the
  // shared home comes to make of the corner: a probed row whose check failed, as a read makes
  // it, then given the backend's name and stripped of its mark.
  const state = handMade(entry, (row) => ({ ...unmarked(row), backend: "herdr" }));
  const { row } = panelRow(state, "odd"), acts = instanceActs(row), start = acts.acts.find((act) => act.verb === "start"), detail = detailOf(state, "odd");
  assert.deepEqual([row.backend, row.sessionTarget, row.runtimeState, row.runtimeError, Object.hasOwn(row, "runtimeErrorOrigin")], ["herdr", undefined, "unreachable", CHECK_FAILED, false]);
  assert.deepEqual(start.reason, { code: "unsupported-session", sentence: unsupportedText(instanceRow("dev", "any", HERDR_OLD)) }, "its reason is the stand-in, and names no origin");
  assert.notEqual(start.reason.sentence, row.runtimeError, "which is not the row's text: nothing vouches for that");
  assert.deepEqual(underState(detail), textFact(`"${CHECK_FAILED}"`));
  assert.equal(detail.facts.some((f) => f.value.includes("says:")), false);
  // "Done when" 2: the held line is for the reason that blocks or limits the row, and an act's
  // reason is neither. So the stand-in is drawn nowhere here: no act is drawn yet.
  assert.deepEqual([acts.blocked, acts.limited], [null, null]);
  assert.deepEqual([fact(detail, "held"), times(detail, start.reason.sentence)], [null, 0]);
});

test("hand-made: a text beside no mark that ends in a secret's name and its sign goes to the view in quotation marks, and there the closing mark makes the filter withhold it; the filter shows that text alone, and the view shows it whole after a speaker's words", () => {
  const text = "tmux: password:";
  assert.equal(displayLine(text), text, "the shared filter shows the text itself: the sign has nothing after it");
  const { entry } = cycle([instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: text })]);
  // As the reader makes it: after the kernel's lead, and whole on the screen.
  const [led] = saidUnder(stateOf(entry), "lost");
  assert.deepEqual(led, textFact(`OATS says: ${text}`)[0]);
  assert.deepEqual(drawnFact(led), [`OATS says: ${text}`]);
  // By hand, with no mark: quoted, and the closing mark is what stands after the sign. Withheld,
  // which is the safe side (main's behaviour since the quote was introduced), and the one place
  // where what is put around a text decides whether it is shown.
  const [quoted] = saidUnder(handMade(entry, unmarked), "lost");
  assert.deepEqual(quoted, textFact(`"${text}"`)[0]);
  assert.equal(displayLine(quoted.value), DETAIL_WITHHELD);
  assert.deepEqual(drawnFact(quoted), ["[withheld]"], "the view draws the withheld word alone");
});

// --- The held line ----------------------------------------------------------------------

test("the held line is drawn only for a reason the shared home wrote that is not the row's text: a reason with a speaker is the row's text and stands once under the state, a sentence of the shared home's beside a row's text stands with it, and a reason with no origin that is the row's text stands once", async () => {
  const goneText = "the route was saved before the host was moved";
  const answered = await withGarnet(
    remoteRow(GARNET_ROOT, "garnet-a"), remoteRow(GARNET_ROOT, "garnet-b", { addressable: false, ...STOPPED }),
    // A route saved here that the host no longer lists, as the kernel reports one (gone there,
    // and not addressable), with a text of its own beside it.
    savedRoute("garnet-gone", { addressable: false, missingRemotely: true, runtimeError: goneText }),
    remoteRow(GARNET_ROOT, "garnet-old", { backend: "herdr", addressable: false, running: null, runtimeError: "herdr: the session server did not answer" }),
  );
  const side = (state, name) => { const { row } = panelRow(state, name), acts = instanceActs(row); return { row, held: acts.blocked ?? acts.limited, detail: detailOf(state, name) }; };

  // A reason with an origin: it is the row's text. No held line; the text once, after its speaker.
  const refused = heard(answered, await rosterRead(printing(printedError(BUSY))), tick(1));
  const threw = heard(answered, await rosterRead(() => { throw new Error("the pipe closed"); }), tick(1));
  for (const [state, origin, lead] of [[refused, "kernel", "OATS says:"], [threw, "roster-read", "oats tui's read of other machines says:"]]) {
    const { row, held, detail } = side(state, "garnet-b");
    assert.deepEqual(held, { code: "unaddressable", key: "unreached", sentence: row.runtimeError, origin }, origin);
    assert.deepEqual(underState(detail), textFact(`${lead} ${row.runtimeError}`), origin);
    assert.deepEqual([fact(detail, "held"), times(detail, row.runtimeError)], [null, 1], `${origin}: once`);
  }
  assert.equal(panelRow(refused, "garnet-b").row.runtimeError, BUSY.message);

  // A reason with no origin whose sentence is not the row's text: both stand, each once.
  const gone = side(answered, "garnet-gone");
  assert.deepEqual([gone.held.code, gone.held.key, Object.hasOwn(gone.held, "origin"), gone.held.sentence === gone.row.runtimeError], ["unaddressable", "missing", false, false]);
  assert.deepEqual(underState(gone.detail), textFact(`OATS says: ${goneText}`), "the row's text, with its speaker");
  assert.deepEqual(fact(gone.detail, "held"), { label: "held", value: gone.held.sentence, form: "wrap" }, "and the shared sentence on the held line");
  assert.deepEqual(labels(gone.detail).slice(0, 5), ["soul", "machine", "state", "", "held"]);
  assert.deepEqual([times(gone.detail, goneText), times(gone.detail, gone.held.sentence)], [1, 1]);
  // The same on this machine: a home the kernel holds, whose row carries a text of the kernel's.
  const local = stateOf(cycle([instanceRow("dev", "half", { ...STOPPED, rollbackIncomplete: true, runtimeError: "the worktree could not be removed" })]).entry);
  const half = side(local, "half");
  assert.deepEqual([half.held.code, Object.hasOwn(half.held, "origin")], ["held", false]);
  assert.deepEqual(underState(half.detail), textFact("OATS says: the worktree could not be removed"));
  assert.deepEqual(fact(half.detail, "held"), { label: "held", value: half.held.sentence, form: "wrap" });
  // And with no text on the row, the shared sentence alone.
  const plain = side(answered, "garnet-b");
  assert.deepEqual([underState(plain.detail), fact(plain.detail, "held")], [[], { label: "held", value: plain.held.sentence, form: "wrap" }]);
  assert.equal(Object.hasOwn(plain.held, "origin"), false);

  // A reason with no origin whose sentence IS the row's text: once, under the state, as it is.
  const old = side(answered, "garnet-old");
  assert.deepEqual([Object.hasOwn(old.held, "origin"), old.held.sentence === old.row.runtimeError, Object.hasOwn(old.row, "runtimeErrorOrigin")], [false, true, false]);
  assert.deepEqual(underState(old.detail), textFact(old.row.runtimeError));
  assert.deepEqual([fact(old.detail, "held"), times(old.detail, old.row.runtimeError)], [null, 1]);
});

test("hand-made: a row blocked by its own text beside no speaker, which the shared reason marks \"unattributed\", has no held line, and the text stands once under the state, in quotation marks", () => {
  const { entry } = cycle([instanceRow("dev", "lost", { running: null, runtimeState: "unreachable", runtimeError: KERNEL_TEXT })]);
  // By hand: no reader gives a row of another machine a text with no mark (but the stand-in).
  // This is the reader's row with its mark taken off and the three facts of a row of a machine
  // that was not reached and cannot be addressed.
  const state = handMade(entry, (row) => ({ ...unmarked(row), server: "garnet", serverUnreached: true, addressable: false }));
  const { row } = panelRow(state, "lost"), acts = instanceActs(row), detail = detailOf(state, "lost");
  assert.deepEqual(acts.blocked, { code: "unaddressable", key: "unreached", sentence: KERNEL_TEXT, origin: "unattributed" });
  assert.equal(originLead(acts.blocked.origin, TERMS), null, "the shared home has no words for it");
  assert.deepEqual(underState(detail), textFact(`"${KERNEL_TEXT}"`));
  assert.deepEqual([fact(detail, "held"), times(detail, KERNEL_TEXT)], [null, 1], "an origin of any value says the reason is the row's text");
  assert.equal(detail.facts.some((f) => f.value.includes("says:") || f.value.includes("unattributed")), false);
});

// --- The leads --------------------------------------------------------------------------

test("each of the three leads is ASCII whole, and joined to a line by one space it is shown as it is whenever the line is: a lead is never why the filter withholds a text, and past the filter's bound only the end is cut", () => {
  const leads = ["kernel", "terminal-probe", "roster-read"].map((speaker) => originLead(speaker, TERMS));
  assert.deepEqual(leads, ["OATS says:", "oats tui's terminal check says:", "oats tui's read of other machines says:"]);
  for (const lead of leads) assert.equal(/^[\x20-\x7e]+$/.test(lead) && displayLine(lead) === lead, true, `${lead}: ASCII (its apostrophe is U+0027), and a display line itself`);
  // The same words reach a row made by the shared functions (the tests above read them there).
  const texts = [
    // The texts of this file's rows.
    KERNEL_TEXT, CHECK_FAILED, HERDR_NOW.runtimeError, HERDR_OLD.runtimeError, unsupportedText(instanceRow("dev", "any", HERDR_OLD)), SSH_FAILED.message, BUSY.message, TIMED_OUT.message,
    "Terminal status is unavailable", "Server is unreachable", "Remote roster unavailable: spawn oats ENOENT", "the last probe was slow", "tmux: password:",
    // The beginning of what the filter withholds, with nothing before it: a lead's colon and its
    // space must not be what completes a credentialed address or a secret's name and sign.
    "//user:hunter2@example.com/repo.git", "://user:hunter2@example.com", "/user:hunter2@example.com", "@example.com", ": hunter2", "= hunter2", "=hunter2", "hunter2",
    "password", "token", "secret", "api key", "authorization", "ghp_short", "says: nothing", "OATS says: OATS says:",
    // Folded or replaced by the filter, and still a line.
    "tmux:\tno server\non \u202Ethat socket", "safe \u202Eevil", "one\u2028two\u2029three", "ad\u200Bmin", "caf\u00E9 \u4E2D\u6587", "ab\uD83Dcd",
    // Longer than the filter's bound.
    "n".repeat(3000), "word ".repeat(600),
    // Withheld whole, or nothing to show: the model puts no lead before these (it hands a
    // withheld text on as it came, and draws nothing for the others).
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "https://user:hunter2@example.com/repo.git", "run \x1b[31mthis\x07", "safe\rEVIL", "tmux: password: hunter2", "", " \n \n ",
  ];
  // The bound of the shared filter (display-text.mjs MAX_DISPLAY_LINE; not a name the TUI takes).
  const BOUND = 2048;
  const met = { whole: 0, cut: 0, withheld: 0, nothing: 0 };
  for (const text of texts) {
    const line = displayLine(text);
    if (line === null) { met.nothing++; continue; }
    if (line === DETAIL_WITHHELD) { met.withheld++; continue; }
    for (const lead of leads) {
      const joined = `${lead} ${line}`, again = displayLine(joined), where = `${lead} ${JSON.stringify(line.slice(0, 40))}`;
      const drawn = shownLines(joined, BOUND, 1).map(textOf);
      assert.notEqual(again, DETAIL_WITHHELD, `${where}: not withheld`);
      if (joined.length <= BOUND) {
        assert.equal(again, joined, where);
        // (Not `[joined]`: the screen replaces a character it must not write, with a lead or without.)
        assert.deepEqual(drawn, [`${lead} ${shownLines(line, BOUND, 1).map(textOf).join("")}`], `${where}: the view draws the lead, and then what it draws of the line alone`);
        met.whole++;
      } else {
        // The value the model hands on is longer than one display line may be: the view's filter
        // cuts its end, as it cuts any long text. Nothing is withheld and the lead stays.
        assert.equal(again.length <= BOUND && joined.startsWith(again) && again.startsWith(`${lead} `) && again.length > BOUND - 8, true, where);
        assert.deepEqual(drawn, [again], `${where}: the view draws what is left`);
        met.cut++;
      }
    }
  }
  assert.deepEqual(met, { whole: 3 * (texts.length - 2 - 5 - 2), cut: 3 * 2, withheld: 5, nothing: 2 }, "every kind of text was among them");
});

test("a text that is the stand-in sentence with a space after it, on a row with no mark whose reason is the stand-in, stands in quotation marks: the two are compared as given (a row made by hand, #1085's review)", () => {
  // Made by hand (helpers.mjs `observed` hands the collector's answers over as they are): the row
  // carries no speaker's mark, and its session target is a backend OATS no longer has, so its
  // reason is the shared home's stand-in, which carries no origin. The stand-in is read from that
  // reason, never written out here.
  const herdr = (runtimeError) => stateOf(observed([instanceRow("dev", "dev-herdr", { ...STOPPED, sessionTarget: "herdr:1", runtimeError })]));
  const reasonOf = (state) => instanceActs(roster(state).instances[0]).acts.find((act) => act.verb === "start").reason;
  const stem = reasonOf(herdr(undefined)).sentence;
  const factsOf = (state) => view(press(state, ["j"]).state).detail.facts.filter((fact) => fact.label === "").map((fact) => fact.value);
  const spaced = herdr(`${stem} `), row = roster(spaced).instances[0];
  assert.equal(row.runtimeErrorOrigin, undefined, "no mark");
  assert.deepEqual([reasonOf(spaced).sentence, reasonOf(spaced).origin], [stem, undefined], "the reason is the stand-in, the shared home's own");
  assert.equal(displayLine(row.runtimeError), displayLine(stem), "filtered, the two are one line");
  assert.deepEqual(factsOf(spaced), [`"${stem}"`], "compared as given they differ: the text is vouched for by nobody");
  assert.deepEqual(factsOf(herdr(stem)), [stem], "the stand-in itself, as given, is the shared home's and stands as written");
});

// ── The open terminal (T1): its focus, zoom and close, as the store keeps them and the model hands them on ──

const TWO = () => stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-b")]));
/** A key, as the loop hands it to the store (the geometry is not read by these keys). */
const key = (state, id) => reduce(state, { key: id, ...(id.length === 1 ? { text: id } : {}), page: 19, extent: 0, room: 19, cols: 38 });

test("the open terminal in the store: Enter opens it with the focus; the leader then Esc gives the focus to the list and the terminal stays; Enter on its row focuses it unzoomed, z zoomed, and c closes it, the agent left running", () => {
  const state = on(TWO(), "dev-a"), id = instanceId(panelRow(state, "dev-a").row);
  const opened = key(state, "enter");
  assert.deepEqual(opened.state.terminal, { id, name: "dev-a", machine: null, routed: false, group: 0, focus: "terminal", zoom: false, status: "starting" });
  assert.equal(opened.effect.open.id, id);
  // The panel has the window: open. One of another id changes nothing.
  assert.equal(reduce(opened.state, { shown: { id: "elsewhere" } }).state, opened.state);
  const shown = reduce(opened.state, { shown: { id } }).state;
  assert.equal(shown.terminal.status, "open");
  const once = reduce(shown, { back: true, read: 1, rest: false });
  assert.deepEqual([once.state.terminal.focus, once.state.leader, once.effect], ["terminal", { read: 1, waiting: true }, null], "the leader once: it waits for the next key, the terminal keeps the focus");
  const back = leaderEscape(shown);
  assert.deepEqual([back.state.terminal.focus, back.state.terminal.zoom, back.state.terminal.status, back.state.leader.waiting, back.effect], ["list", false, "open", false, null]);
  assert.equal(reduce(back.state, { back: true }).state, back.state, "a back event with the list focused is no key");
  // Enter on the open row goes to it: nothing is opened again.
  const again = key(back.state, "enter");
  assert.deepEqual([again.state.terminal.focus, again.state.terminal.zoom, again.effect], ["terminal", false, null]);
  // z: the terminal, zoomed; the leader then Esc brings the list back with the panel, unzoomed.
  const zoomed = key(back.state, "z");
  assert.deepEqual([zoomed.state.terminal.focus, zoomed.state.terminal.zoom, zoomed.effect], ["terminal", true, null]);
  assert.deepEqual([leaderEscape(zoomed.state).state.terminal.focus, leaderEscape(zoomed.state).state.terminal.zoom], ["list", false]);
  // c: closed, as the person asked, so the end the panel reports later says nothing.
  const closed = key(back.state, "c");
  assert.deepEqual([closed.state.terminal, closed.effect], [null, { close: [id] }]);
  assert.equal(reduce(closed.state, { returned: { id, status: null, stderr: "", asked: true } }).state, closed.state);
  // z and c with no terminal open do nothing.
  for (const k of ["z", "c"]) assert.deepEqual([key(state, k).state, key(state, k).effect], [state, null], k);
});

test("Enter on another openable row while a terminal is open opens that one as a tab of its own after it, shown with the focus; the first stays open, hidden (T2: nothing is closed)", () => {
  const state = on(TWO(), "dev-a"), a = instanceId(panelRow(state, "dev-a").row), b = instanceId(panelRow(state, "dev-b").row);
  const open = leaderEscape(reduce(key(state, "enter").state, { shown: { id: a } }).state).state;
  const other = key(on(open, "dev-b"), "enter");
  assert.deepEqual(Object.keys(other.effect), ["open"]);
  assert.equal(other.effect.open.id, b);
  assert.deepEqual([other.state.terminal.id, other.state.terminal.focus, other.state.terminal.status], [b, "terminal", "starting"]);
  assert.deepEqual(other.state.tabs.map((tab) => [tab.id, tab.status]), [[a, "open"], [b, "starting"]]);
  // An end the person asked for, of a tab that is no longer one, changes nothing.
  const closed = reduce(other.state, { shown: { id: b } }).state;
  const gone = { ...closed, tabs: Object.freeze(closed.tabs.filter((tab) => tab.id !== a)) };
  assert.equal(reduce(gone, { returned: { id: a, status: 1, stderr: "x", asked: true } }).state, gone);
});

test("the model hands the views the terminal and whether the selected row is its own; the terminal is the store's beside the roster, never part of what the roster is made from (MADE_FROM)", () => {
  const state = on(TWO(), "dev-a");
  const open = leaderEscape(key(state, "enter").state).state;
  assert.deepEqual([view(state).terminal, view(state).onTerminal], [null, false]);
  assert.equal(view(open).terminal, open.terminal);
  assert.equal(view(open).onTerminal, true);
  assert.equal(view(on(open, "dev-b")).onTerminal, false);
  assert.equal(roster(open).instances, roster(state).instances, "the roster is the one already made");
});

test("whatever shows another view than the instances gives the focus back to the list: the terminal stays open, unzoomed", () => {
  const state = on(TWO(), "dev-a");
  const zoomed = key(leaderEscape(key(state, "enter").state).state, "z").state;
  assert.equal(zoomed.terminal.focus, "terminal");
  const switched = key(key(zoomed, "w").state, "w").state;
  assert.equal(switched.view, "switcher");
  assert.deepEqual([switched.terminal.focus, switched.terminal.zoom, switched.terminal.id], ["list", false, zoomed.terminal.id]);
});

test("2 shows the Souls view (souls.test.mjs has its own) and 3 the Capabilities view (capabilities.test.mjs has its own), each reading before its catalog is held and asking the loop to settle it, the Capabilities view the souls catalog too; Esc and 1 go back to the instances, the selection and the terminal as they were", () => {
  const state = on(TWO(), "dev-a");
  const two = key(state, "2");
  assert.deepEqual([two.state.view, two.effect, view(two.state).capabilities, view(two.state).souls.state], ["souls", { souls: "settle" }, null, "reading"]);
  for (const out of ["escape", "1"]) assert.deepEqual([key(two.state, out).state.view, key(two.state, out).state.selected], ["instances", state.selected], `2 then ${out}`);
  const three = key(state, "3");
  assert.deepEqual([three.state.view, three.effect, three.state.capabilities.wanted, three.state.souls.wanted], ["capabilities", { souls: "settle", capabilities: "settle" }, true, true]);
  assert.deepEqual([three.state.outcome, three.state.selected], [null, state.selected]);
  const shown = view(three.state);
  assert.deepEqual([shown.souls, shown.capabilities.local, shown.capabilities.state, shown.capabilities.list, shown.capabilities.detail], [null, true, "reading", [], null], "3: reading, nothing listed yet");
  // Under the help each is still modelled: the sidebar beside the help lists it.
  const helped = (s) => view(key(s, "?").state);
  assert.deepEqual([helped(two.state).view, helped(two.state).souls?.state, helped(two.state).capabilities], ["help", "reading", null], "2, then the help");
  assert.deepEqual([helped(three.state).view, helped(three.state).capabilities?.state, helped(three.state).souls], ["help", "reading", null], "3, then the help");
  assert.equal("body" in shown, false, "the placeholder's body is gone");
  for (const out of ["escape", "1"]) assert.deepEqual([key(three.state, out).state.view, key(three.state, out).state.selected], ["instances", state.selected], `3 then ${out}`);
  // An open terminal stays as it was, behind either view.
  const open = leaderEscape(key(state, "enter").state).state;
  for (const k of ["2", "3"]) {
    const back = key(key(open, k).state, "1").state;
    assert.deepEqual([back.view, back.selected, back.terminal], ["instances", open.selected, open.terminal], `${k}, then back: the terminal as it was`);
  }
  // With no workspace open they show from the switcher too, and go back there: the Capabilities
  // view has no workspace of this machine to list.
  const none = initialState({ deployment: null, cli: CLI, home: "/home/u" });
  assert.equal(none.view, "switcher");
  const souls = key(none, "2").state;
  assert.deepEqual([souls.view, key(souls, "escape").state.view], ["souls", "switcher"]);
  const capabilities = key(none, "3").state;
  assert.deepEqual([capabilities.view, view(capabilities).capabilities.local, view(capabilities).capabilities.state, key(capabilities, "escape").state.view], ["capabilities", false, "none", "switcher"]);
});

test("the leader then Esc always returns to the list with the panel, unzoomed: also when the terminal was opened or zoomed from the detail's focus (round 1 of the review)", () => {
  const state = on(TWO(), "dev-a");
  const fromDetail = leaderEscape(key(key(state, "tab").state, "enter").state).state;
  assert.deepEqual([fromDetail.focus, fromDetail.terminal.focus, fromDetail.terminal.zoom], ["list", "list", false]);
  // The detail shown over an open terminal, then z or Enter, then back.
  const open = leaderEscape(key(state, "enter").state).state;
  for (const k of ["z", "enter"]) {
    const back = leaderEscape(key(key(open, "tab").state, k).state).state;
    assert.deepEqual([back.focus, back.terminal.focus, back.terminal.zoom], ["list", "list", false], k);
  }
  // While the terminal has the focus the list lies under it.
  assert.equal(key(key(state, "tab").state, "enter").state.focus, "list");
});
