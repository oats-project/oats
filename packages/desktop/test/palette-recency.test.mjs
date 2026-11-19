// #1383: the command palette is the sidebar's tree, ordered by last focus (it supersedes Spec C's flat Recent
// group; the record is still Spec C's). At every level a node sits where the most recently focused instance of
// its subtree puts it, never-focused nodes keep the sidebar's order after the rest, and a child stays under its
// parent. The palette opens on its first row (#1391). The record is per-machine localStorage, scoped by workspace
// and exact identity; the sidebar keeps its stable order.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { paletteRows, createPalette } from "../renderer/palette.mjs";
import { createInstanceRecency, recencyIdFromTerminalKey, RECENCY_STORAGE_KEY, RECENCY_CAP } from "../renderer/instance-recency.mjs";
import { terminalKey } from "../renderer/instance-tree-view.mjs";
import { instanceId, rosterGroups } from "../../client/instance-tree.mjs";
import { pickerCycleDirection } from "../renderer/keybindings.mjs";

const at = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, ...extra });
// The palette-tree roster: two relation clusters and two unrelated instances, out of order.
const ROSTER = [
  at("solo-y", { running: false }),
  at("grandchild", { parentInstance: "child-a" }),
  at("lead"),
  at("child-b", { parentInstance: "lead", running: false }),
  at("alpha", { running: false }),
  at("solo-x"),
  at("child-a", { parentInstance: "lead" }),
  at("alpha-kid", { parentInstance: "alpha" }),
];
const TREE_ORDER = ["alpha", "alpha-kid", "lead", "child-a", "grandchild", "child-b", "solo-x", "solo-y"];
const byName = name => ROSTER.find(i => i.instance === name);
const WS = "ws-one";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k), map };
}
/** A store fed through the shell's own key path: the terminal tab key of each focused instance, oldest first. */
function focused(names, { workspace = WS, storage = memoryStorage() } = {}) {
  let clock = 1000;
  const store = createInstanceRecency({ storage, now: () => clock++ });
  for (const name of names) store.record(workspace, recencyIdFromTerminalKey(workspace, terminalKey(workspace, byName(name))));
  return { store, storage };
}
const instanceRows = rows => rows.filter(row => row.group);
const rowsOf = (data, raw = "") => instanceRows(paletteRows(data, [], raw, { openTerminal() {} }));

test("focus orders the tree: a cluster by its newest member, a parent's children the same way, never-focused rows after", () => {
  // Focused oldest first: alpha, then grandchild, then solo-y.
  const { store } = focused(["alpha", "grandchild", "solo-y"]);
  const rows = rowsOf({ instances: ROSTER, deployments: [], recent: store.snapshot(WS) });
  assert.deepEqual(rows.map(r => [r.group.label, r.label, r.depth]), [
    ["independent", "solo-y", 0],
    // grandchild lifts lead's cluster, and child-a above child-b; each child stays under its parent.
    ["lead", "lead", 0], ["lead", "child-a", 1], ["lead", "grandchild", 2], ["lead", "child-b", 1],
    ["alpha", "alpha", 0], ["alpha", "alpha-kid", 1],
    // solo-x was never focused: after every focused node, in its own run.
    ["independent", "solo-x", 0],
  ]);
  const runs = rows.filter(r => r.group.label === "independent").map(r => r.group.key);
  assert.equal(new Set(runs).size, 2, "the stale run is formed again apart from the fresh one");
  assert.deepEqual(rows.map(r => r.label).sort(), [...TREE_ORDER].sort(), "each instance once");
  assert.ok(rows.every(r => typeof r.run === "function"), "no query: every row opens");
  assert.deepEqual(rows.filter(r => r.under).map(r => [r.label, r.under]), [["child-a", "under lead"], ["grandchild", "under child-a"], ["child-b", "under lead"], ["alpha-kid", "under alpha"]]);
});

test("no record: exactly the sidebar's order, groups and depth", () => {
  const rows = rowsOf({ instances: ROSTER, deployments: [], recent: new Map() });
  const sidebar = rosterGroups(ROSTER, ROSTER).flatMap(g => g.clusters.flatMap(c => c.instances.map(i => [g.key, i.instance, i.depth])));
  assert.deepEqual(rows.map(r => [r.group.key, r.label, r.depth]), sidebar);
  assert.deepEqual(rowsOf(ROSTER).map(r => [r.group.key, r.label]), rows.map(r => [r.group.key, r.label]), "a bare roster: the same");
});

test("there is no Recent group: no flat rows, no recent fields, nothing named Recent", () => {
  const { store } = focused(["solo-x", "child-a", "alpha"]);
  const rows = rowsOf({ instances: ROSTER, deployments: [], recent: store.snapshot(WS) });
  assert.ok(rows.every(r => r.group.label !== "Recent" && !r.group.key.includes("recent")));
  assert.ok(rows.every(r => !Object.hasOwn(r, "recent") && !Object.hasOwn(r, "showUnder")));
  assert.equal(rows.find(r => r.label === "child-a").depth, 1, "a focused child keeps its depth");
  const source = readFileSync(new URL("../renderer/palette.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /RECENT_GROUP|recentRows|showUnder/);
});

test("the palette opens on its first row: no row is marked to open on, whatever was focused or is in front (#1391)", () => {
  const { store } = focused(["solo-x", "lead"]);
  const recent = store.snapshot(WS);
  // The terminal in front is not part of the palette's data any more; a stale caller's activeId changes nothing.
  for (const data of [{ instances: ROSTER, recent }, { instances: ROSTER, recent, activeId: instanceId(byName("lead")) }, { instances: ROSTER, recent: new Map() }, ROSTER]) {
    for (const raw of ["", "child", "solo"]) assert.ok(rowsOf(data, raw).every(r => !Object.hasOwn(r, "initial")), raw);
  }
  const source = readFileSync(new URL("../renderer/palette.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.initial\b|initial:|activeId/, "paletteRows marks no opening row and reads no terminal in front");
  const picker = readFileSync(new URL("../renderer/overlay-picker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(picker, /it\.initial/, "the picker starts on its first selectable row");
});

test("with a query: the order is the unfiltered one, ancestors are context", () => {
  const { store } = focused(["child-a", "alpha-kid", "child-b"]);
  const roster = { instances: ROSTER, deployments: [], recent: store.snapshot(WS) };
  const rows = paletteRows(roster, [{ label: "Child command", run() {} }], "child", { openTerminal() {} });
  assert.deepEqual(rows.map(r => [r.group?.label ?? null, r.label, !!r.context]), [
    // lead's cluster leads (child-b, newest), child-b above child-a; lead itself is context.
    ["lead", "lead", true], ["lead", "child-b", false], ["lead", "child-a", false], ["lead", "grandchild", false],
    [null, "Child command", false],
  ], "the first match (child-b) is the first selectable row; commands follow");
  // A query never reorders: the listed rows keep the unfiltered list's order.
  const full = rowsOf(roster).map(r => r.label);
  for (const query of ["child", "kid", "a", "solo", "grand"]) {
    const listed = rowsOf(roster, query).map(r => r.label);
    assert.ok(listed.length, query);
    assert.deepEqual(listed, full.filter(n => listed.includes(n)), `"${query}" keeps the unfiltered order`);
  }
  // A focused ancestor of a match is context, at its place: it opens nothing.
  const kid = rowsOf({ instances: ROSTER, recent: focused(["alpha-kid", "alpha"]).store.snapshot(WS) }, "kid");
  assert.deepEqual(kid.map(r => [r.label, !!r.context, typeof r.run]), [["alpha", true, "undefined"], ["alpha-kid", false, "function"]]);
});

test("several deployments: sections by their newest focus, then the panel's order; groups stay in their deployment", () => {
  const D1 = { id: "/a", machine: "This Mac", path: "/a", label: "~/a", local: true, reachable: true, primary: true };
  const D2 = { id: "remote:devbox:b", machine: "devbox", path: "/b", label: "~/b", local: false, reachable: true, primary: false };
  const lead = { ...at("lead"), deployment: { id: D1.id } }, zeta = { ...at("zeta"), deployment: { id: D1.id } };
  const kid = { ...at("kid", { home: "/b/kid", agentsRoot: "/b", parentInstance: "boss" }), deployment: { id: D2.id } };
  const boss = { ...at("boss", { home: "/b/boss", agentsRoot: "/b" }), deployment: { id: D2.id } };
  const instances = [lead, zeta, kid, boss];
  const shape = recent => rowsOf({ instances, deployments: [D1, D2], recent }).map(r => [r.group.key.split("|")[0], r.label]);
  assert.deepEqual(shape(new Map()), [[D1.id, "lead"], [D1.id, "zeta"], [D2.id, "boss"], [D2.id, "kid"]], "the panel's order");
  assert.deepEqual(shape(new Map([[instanceId(kid), 2], [instanceId(zeta), 1]])), [[D2.id, "boss"], [D2.id, "kid"], [D1.id, "zeta"], [D1.id, "lead"]]);
});

function palette(t, data) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button></body>', { url: "http://localhost" });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const opened = [];
  const picker = createPalette({ loadInstances: async () => data, openTerminal: ref => opened.push(ref.instance), commands: [],
    cycleKey: e => pickerCycleDirection(e, "app.palette", true), doc });
  t.after(() => picker.close());
  doc.getElementById("opener").focus();
  const key = (key, mods = {}) => doc.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }));
  const input = () => doc.querySelector(".palette-input");
  const active = () => doc.getElementById(input().getAttribute("aria-activedescendant"))?.querySelector(".plabel").textContent;
  const filter = value => { input().value = value; input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return { doc, picker, opened, key, active, filter };
}

test("rendered: opens on the first row (#1391); the chord still cycles and skips context rows", async t => {
  // The newest focus is a child (child-a): before #1391 the palette opened on it, in the middle; now on its root.
  const { store } = focused(["solo-x", "lead", "child-a"]);
  const p = palette(t, { instances: ROSTER, deployments: [], recent: store.snapshot(WS) });
  await p.picker.open();
  const groups = [...p.doc.querySelectorAll('[role="listbox"] > [role="group"]')];
  assert.deepEqual(groups.map(g => g.getAttribute("aria-label")), ["lead", "independent", "alpha", "independent"], "no Recent group: the tree by focus");
  assert.deepEqual([...groups[0].children].map(o => o.querySelector(".plabel").textContent), ["lead", "child-a", "grandchild", "child-b"]);
  assert.equal(p.active(), "lead", "opens on the top row, not on the newest focus (child-a) in the middle");
  p.key("k", { metaKey: true }); assert.equal(p.active(), "child-a", "the cycle chord moves down from the top");
  p.key("k", { metaKey: true }); assert.equal(p.active(), "grandchild");
  p.key("k", { metaKey: true, shiftKey: true }); p.key("Enter");
  assert.deepEqual(p.opened, ["child-a"]);
  // A query: the chord and the arrows skip the context ancestor.
  p.doc.getElementById("opener").focus();
  await p.picker.open();
  p.filter("grand");
  assert.deepEqual([...p.doc.querySelectorAll('[role="option"]')].map(o => o.getAttribute("aria-disabled")), ["true", "true", null]);
  assert.equal(p.active(), "grandchild");
  p.key("k", { metaKey: true }); assert.equal(p.active(), "grandchild");
  p.key("ArrowUp"); assert.equal(p.active(), "grandchild");
  // A query opens on the first match, not the newest one: alpha-kid is newer, alpha comes first.
  const q = palette(t, { instances: ROSTER, deployments: [], recent: focused(["alpha", "alpha-kid"]).store.snapshot(WS) });
  await q.picker.open();
  q.filter("alpha");
  assert.deepEqual([...q.doc.querySelectorAll('[role="option"]')].map(o => o.querySelector(".plabel").textContent), ["alpha", "alpha-kid"]);
  assert.equal(q.active(), "alpha", "the first match");
});

test("an entry for an instance no longer in the roster is not listed", () => {
  const { store } = focused(["solo-x", "lead"]);
  const gone = ROSTER.filter(i => i.instance !== "lead");
  const rows = instanceRows(paletteRows({ instances: gone, recent: store.snapshot(WS) }, [], "", {}));
  assert.equal(rows[0].label, "solo-x", "the remaining focus still leads");
  assert.equal(rows.filter(r => r.label === "lead").length, 0);
});

test("workspace scoping: entries live under their workspace and the exact identity", () => {
  const storage = memoryStorage();
  let clock = 1;
  const store = createInstanceRecency({ storage, now: () => clock++ });
  const here = at("twin"), other = at("twin", { home: "/v/twin", agentsRoot: "/v" });
  store.record("ws-a", recencyIdFromTerminalKey("ws-a", terminalKey("ws-a", here)));
  store.record("ws-b", recencyIdFromTerminalKey("ws-b", terminalKey("ws-b", other)));
  assert.deepEqual([...store.snapshot("ws-a").keys()], [instanceId(here)]);
  assert.deepEqual([...store.snapshot("ws-b").keys()], [instanceId(other)]);
  assert.deepEqual([...store.snapshot("ws-c").keys()], []);
  // Which twin each row opens, in order: the order is what proves exact-identity scoping.
  const homes = recent => {
    const opened = [];
    const rows = instanceRows(paletteRows({ instances: [here, other], recent }, [], "", { openTerminal: ref => opened.push(ref.home) }));
    for (const r of rows) r.run();
    return opened;
  };
  assert.deepEqual(homes(new Map()), ["/v/twin", "/w/twin"], "the sidebar's order: name, then identity");
  assert.deepEqual(homes(store.snapshot("ws-a")), ["/w/twin", "/v/twin"], "a same-named instance of another agents root is a different entry");
  assert.deepEqual(homes(store.snapshot("ws-b")), ["/v/twin", "/w/twin"]);
  assert.equal(recencyIdFromTerminalKey("ws-a", terminalKey("ws-b", here)), null, "another workspace's tab key records nothing here");
  assert.equal(recencyIdFromTerminalKey("", terminalKey("", here)), instanceId(here), "the unbound workspace keys as \"\"");
});

test("persistence: a round trip through storage survives a new store (an app restart); one key, capped per workspace", () => {
  const { storage } = focused(["solo-x", "child-a", "alpha"]);
  assert.deepEqual([...storage.map.keys()], [RECENCY_STORAGE_KEY]);
  const restarted = createInstanceRecency({ storage });
  assert.deepEqual([...restarted.snapshot(WS).keys()], ["alpha", "child-a", "solo-x"].map(n => instanceId(byName(n))));
  let clock = 1;
  const store = createInstanceRecency({ storage, now: () => clock++ });
  for (let i = 0; i < RECENCY_CAP + 5; i++) store.record("big", `/w/i-${i}`);
  const kept = [...createInstanceRecency({ storage }).snapshot("big").keys()];
  assert.equal(kept.length, RECENCY_CAP);
  assert.equal(kept[0], `/w/i-${RECENCY_CAP + 4}`, "the most recent kept");
  assert.equal(kept.includes("/w/i-0"), false, "the oldest dropped");
  assert.equal(restarted.snapshot(WS).size, 3, "other workspaces untouched");
  // Same millisecond: still strictly ordered.
  const tied = createInstanceRecency({ storage: memoryStorage(), now: () => 5 });
  tied.record(WS, "a"); tied.record(WS, "b");
  assert.deepEqual([...tied.snapshot(WS).keys()], ["b", "a"]);
});

test("a corrupt or foreign stored value reads as empty, and recording repairs it", () => {
  for (const raw of ["{not json", "[1,2]", "null", "42", JSON.stringify({ [WS]: "x" }), JSON.stringify({ [WS]: { "/w/a": "soon", "/w/b": -1, "": 5 } })]) {
    const storage = memoryStorage({ [RECENCY_STORAGE_KEY]: raw });
    const store = createInstanceRecency({ storage, now: () => 10 });
    assert.equal(store.snapshot(WS).size, 0, raw);
    store.record(WS, "/w/c");
    assert.deepEqual([...store.snapshot(WS).keys()], ["/w/c"], raw);
  }
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const store = createInstanceRecency({ storage: throwing });
  assert.doesNotThrow(() => store.record(WS, "/w/a"));
  assert.equal(store.snapshot(WS).size, 0);
  const none = createInstanceRecency({ storage: null });
  none.record(WS, "/w/a");
  assert.equal(none.snapshot(WS).size, 0);
});

test("a re-homed workspace's entries follow it, the newer time winning", () => {
  const storage = memoryStorage();
  let clock = 1;
  const store = createInstanceRecency({ storage, now: () => clock++ });
  store.record("old", "/w/a"); store.record("new", "/w/a"); store.record("old", "/w/b");
  store.rehome(new Map([["old", "new"]]));
  assert.deepEqual([...store.snapshot("new")], [["/w/b", 3], ["/w/a", 2]]);
  assert.equal(store.snapshot("old").size, 0);
});

test("the sidebar roster keeps its stable order: recency reaches only the palette", () => {
  const before = rosterGroups(ROSTER, ROSTER).flatMap(g => g.clusters.flatMap(c => c.instances.map(i => i.instance)));
  const copy = ROSTER.slice();
  paletteRows({ instances: ROSTER, recent: focused(["solo-y", "lead"]).store.snapshot(WS) }, [], "", {});
  assert.deepEqual(ROSTER, copy, "the roster snapshot is not reordered");
  assert.deepEqual(rosterGroups(ROSTER, ROSTER).flatMap(g => g.clusters.flatMap(c => c.instances.map(i => i.instance))), before);
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.equal(shell.match(/instanceRecency\.snapshot\(/g)?.length, 1, "read once: by the palette's loader");
  assert.match(shell, /const recent = instanceRecency\.snapshot\(ws\);[\s\S]{0,400}return \{ instances: p\.instances \|\| \[\], deployments: panelDeployments\(p\), recent \}/);
  assert.match(shell, /function activateTab\([\s\S]*?instanceRecency\.record\(current\.workspace, recencyIdFromTerminalKey\(current\.workspace, current\.key\)\)[\s\S]*?\n\}/,
    "recorded at the one activation seam");
  assert.doesNotMatch(shell, /lastFocus/, "the sidebar never passes a last-focus record");
});
