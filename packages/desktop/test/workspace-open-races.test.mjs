// Exercise the shipped shell's async open paths, with controlled request gates
// instead of Electron imports/IPC. Both successful and rejected stale work lose.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from "jsdom";
import { prepareOwnedOpen } from "../renderer/open-intent.mjs";
import { createViewLifecycle } from "../renderer/view-lifecycle.mjs";
import { createSelectionOwnership } from "../renderer/selection-ownership.mjs";
import { fillEmptyGroup, groupOfTab, removeSplitTab } from "../renderer/split-layout.mjs";
import { otherIncarnation, terminalOrigin } from "../renderer/retired-tabs.mjs";
import { navTab } from "../renderer/shell-nav.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const extract = name => source.match(new RegExp(`async function ${name}\\([^]*?\\n\\}`))[0];
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function fixture(t, kind) {
  const dom = new JSDOM("<body></body>"); t.after(() => dom.window.close());
  const requests = [], opened = [], activated = [];
  const context = {
    document: dom.window.document, console,
    workspace: "A", generation: 0, connectionGeneration: 0,
    currentWorkspace: () => context.workspace, workspaceGeneration: () => context.generation,
    tabs: new Map([[1, { key: "first" }], [2, { key: "second" }]]), pendingTerms: new Set(), panelReads: 0, otherIncarnation, terminalOrigin, split: null,
    fillEmptyGroup,
    setSidebarMode() {}, setNavActive() {}, refreshContextRoster() {},
    api() { const request = deferred(); requests.push(request); return request.promise; },
    whenKeyFree(key) {
      if (kind === "terminal") return Promise.resolve();
      const request = { ...deferred(), key }; requests.push(request); return request.promise;
    },
    prepareOwnedOpen: options => prepareOwnedOpen({ ...options, load: async () => ({ mount() { return () => {}; } }) }),
    createViewLifecycle,
    ctx: { openFile() {}, openBrain() {}, openTerminal() {} },
    addTab(options) {
      opened.push(options);
      const id = opened.length + 10;
      context.tabs.set(id, options);
      return { id, paneEl: dom.window.document.createElement("div") };
    },
    resolveTerminalOpen: instances => ({ inst: {}, key: instances[0] }),
    selectTab: id => activated.push(id),
    openTerminalTabInner: () => assert.fail("an existing tab must not attach another terminal"),
  };
  context.tabOpenIntents = createSelectionOwnership(context);
  const run = runInNewContext(`(${extract(kind === "terminal" ? "openTerminalTabFlow" : "openViewTab")})`, context);
  return { context, requests, opened, activated, run: key => kind === "terminal" ? run(key, () => assert.fail("unexpected refusal"))
    : run("markdown", key, { path: "/same/path.md" }, "file:/same/path.md") };
}

for (const kind of ["terminal", "artifact"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`${kind}: latest open wins over an older ${outcome} in the same workspace`, async t => {
      const f = fixture(t, kind);
      const old = f.run("first"), latest = f.run("second");
      assert.equal(f.requests.length, 2);
      f.requests[1].resolve({ instances: ["second"] }); await latest;
      if (outcome === "resolve") f.requests[0].resolve({ instances: ["first"] });
      else f.requests[0].reject(new Error("stale failure"));
      await old;
      if (kind === "terminal") assert.deepEqual(f.activated, [2]);
      else assert.deepEqual(f.opened.map(o => o.title), ["second"]);
    });
    test(`${kind}: A → B → A rejects a stale ${outcome} even when workspace identity matches again`, async t => {
      const f = fixture(t, kind);
      const old = f.run("first");
      f.context.workspace = "B"; f.context.generation++;
      f.context.workspace = "A"; f.context.generation++;
      if (outcome === "resolve") f.requests[0].resolve({ instances: ["first"] });
      else f.requests[0].reject(new Error("previous visit"));
      await old;
      assert.deepEqual(f.opened, []); assert.deepEqual(f.activated, []);
    });
  }
}

test("navigating to a stage cancels an older terminal open", async t => {
  const f = fixture(t, "terminal");
  const pendingTerminal = f.run("first");
  // Slice 6a: a page opens as a tab (showStage → openViewTab), whose open begins the newer intent.
  const navigate = runInNewContext(`${extract("openViewTab")}\n(${extract("showStage")})`, withShellWindowGlobals({
    // Automations, a page of its own (the product owner, 2026-10-26; hierarchy is now the Workspace page's Machines tab).
    ...f.context, NAV: [{ name: "automations", title: "Automations" }], navTab /* the shipped NAV_TABS lookup: showStage reads it first */,
    split: null, groupOfTab, removeSplitTab, canActivateTab: (tab, ws) => !!tab && tab.workspace === ws, stageSidebarMode: () => "overview", showTabLayer() {},
  }));
  assert.equal(navTab("automations"), null, "a page, not a tab of one");
  await navigate("automations");
  f.requests[0].resolve({ instances: ["first"] }); await pendingTerminal;
  assert.deepEqual(f.activated, []);
});

test("a newer artifact open supersedes a pending terminal open too", async t => {
  const f = fixture(t, "terminal");
  const pendingTerminal = f.run("first");
  const openArtifact = runInNewContext(`(${extract("openViewTab")})`, f.context);
  await openArtifact("markdown", "newer file", { path: "/file.md" }, "file:/file.md");
  assert.equal(f.opened.length, 1);
  f.requests[0].resolve({ instances: ["first"] }); await pendingTerminal;
  assert.deepEqual(f.activated, [], "old terminal cannot steal the newer artifact selection");
});

test("artifact keys and metadata include the opening workspace, even for identical paths", async t => {
  const f = fixture(t, "artifact");
  let pending = f.run("file A"); f.requests[0].resolve(); await pending;
  f.context.workspace = "B"; f.context.generation++;
  pending = f.run("file B"); f.requests[1].resolve(); await pending;
  assert.notEqual(f.opened[0].key, f.opened[1].key);
  assert.deepEqual(f.opened.map(o => [o.workspace, o.kind]), [["A", "file"], ["B", "file"]]);
});
