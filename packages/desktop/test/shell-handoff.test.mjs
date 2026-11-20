// Execute the shipped New agent handoff (Quick Open, folded into the palette in slice 4 of the Desktop UI rework: the
// palette's souls group calls openNewAgent) with the real picker DOM. The picker here is the family's test picker over
// the souls (helpers/soul-picker.mjs), standing for the palette's souls group, whose rows call the same onSoul. Only
// the HTTP/module-loading boundaries and the destination view are synthetic.
// No Electron, IPC, CLI, filesystem reads via endpoints or operator state.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createSoulPicker } from "./helpers/soul-picker.mjs";
import { createSelectionOwnership } from "../renderer/selection-ownership.mjs";
import { canActivateTab } from "../renderer/workspace-tabs.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const souls = [{ name: "alpha", agentsRoot: "/a/agents" }, { name: "beta", agentsRoot: "/b/agents" }];
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture(t, { shellSource = source, ownership = createSelectionOwnership } = {}) {
  const dom = new JSDOM("<button id='opener'>Quick Open</button>");
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const requests = [], loads = [], handoffs = [], events = [], notices = [], listeners = [], captures = [], returns = [], dismissals = [];
  let paletteCloses = 0;
  const c = {
    workspace: "A", generation: 0, activeTab: null,
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    createSelectionOwnership: ownership, canActivateTab,
    tabs: new Map([[1, { workspace: "A" }], [2, { workspace: "B" }]]),
    activateTab: id => { c.activeTab = id; return true; },
    api(path) { const gate = { ...deferred(), path }; requests.push(gate); return gate.promise; },
    loadSpawn() { const gate = deferred(); loads.push(gate); return gate.promise; },
    ctx: { notify: text => notices.push(text) },
    showStage(name) { s.tabOpenIntents.invalidate(); events.push(["stage", name]); },
    // The palette: its souls group (the test picker over /api/agents, as the shipped loadSouls reads it), whose pick
    // is the shipped onSoul, openNewAgent; and its command list, which the composition adds to.
    palette: null, chordDetail: () => () => "", runAction() {}, DESKTOP_NOUNS: { instance: "agent", instances: "agents" },
    // The picker's opener, and where the operator was: captured at the pick, before any await.
    document, takePickerFocusReturn: () => ({ opener: true }),
    surfaceReturn: { capture: opener => { captures.push(opener); return { origin: true }; }, restore: origin => { returns.push(origin); return true; } },
    onWorkspaceChange: listener => listeners.push(listener),
  };
  const picker = createSoulPicker({ doc: document, loadSouls: () => c.api(`/api/agents?ws=${encodeURIComponent(c.workspace)}`),
    onPick: soul => { const done = s.openNewAgent(soul); handoffs.push(done); return done; } });
  c.palette = { commands: [], open: () => picker.open(), close() { paletteCloses++; picker.close(); } };
  const setup = shellSource.match(/const tabOpenIntents = [^\n]+/)[0];
  const selection = shellSource.match(/function selectTab\([^]*?\n\}/)[0];
  const start = shellSource.indexOf("// ── Quick Open, folded into the palette");
  const end = shellSource.indexOf("// ── shortcuts editor", start);
  assert.ok(start >= 0 && end > start, "exercise shipped picker composition and workspace subscription");
  const composition = shellSource.slice(start, end).replace('import("./views/spawn.mjs")', "loadSpawn()");
  assert.ok(composition.includes("await loadSpawn()"), "only the module-loader boundary is replaced");
  const s = runInNewContext(`${setup}\n${selection}\n${composition}\n({ openNewAgent, tabOpenIntents, selectTab, quickOpen: palette });`, c);
  assert.equal(c.palette.commands.at(-1)?.label, "New agent: choose a soul…", "the palette lists New agent as a command too");
  document.getElementById("opener").focus();
  return {
    ...s, c, document, requests, loads, events, notices, handoffs, captures, returns, dismissals,
    get paletteCloses() { return paletteCloses; },
    switchTo(workspace) { c.workspace = workspace; c.generation++; listeners.forEach(listener => listener()); },
    async showPicker(items = souls) {
      const loading = s.quickOpen.open();
      requests.at(-1).resolve({ agents: items }); await loading;
    },
    choose(name = "alpha") {
      const row = [...document.querySelectorAll("[role=option]")].find(row => row.querySelector(".plabel").textContent === name);
      assert.ok(row, "the real picker exposes this soul"); row.click();
      assert.equal(document.querySelector(".palette-overlay"), null, "selection dismisses the picker before handing off");
      return { gate: loads.at(-1), done: handoffs.at(-1) };
    },
    settle(pick, outcome) {
      if (outcome === "resolve") pick.gate.resolve({ preselectSpawn: ({ onDismiss, ...soul }) => { events.push(["preselect", soul]); dismissals.push(onDismiss); } });
      else pick.gate.reject(new Error("spawn module unavailable"));
      return pick.done;
    },
  };
}

test("Quick Open captures ownership and the return point before awaiting the module, then opens the soul's spawn dialog in Workspace", async t => {
  const s = fixture(t); await s.showPicker();
  const old = s.tabOpenIntents.begin();
  const pick = s.choose();
  assert.equal(old(), false, "the click, not module arrival, begins selection ownership");
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.captures, [{ opener: true }], "where the operator was is captured at the pick, from the picker's opener");
  assert.equal(s.requests[0].path, "/api/agents?ws=A");
  await s.settle(pick, "resolve");
  assert.deepEqual(s.events, [["preselect", souls[0]], ["stage", "spawn"]]);
  assert.deepEqual(s.notices, []);
  // Dismissing the dialog hands the captured origin back to the shell's return.
  assert.deepEqual(s.returns, []);
  assert.equal(s.dismissals.at(-1)(), true);
  assert.deepEqual(s.returns, [{ origin: true }]);
});

test("a current Quick Open module rejection is contained and reported without preselection/navigation", async t => {
  const s = fixture(t); await s.showPicker();
  await s.settle(s.choose(), "reject");
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.notices, ["Could not open soul: spawn module unavailable"]);
});

async function staleHandoff(t, outcome, superseder, options) {
  const s = fixture(t, options); await s.showPicker();
  const old = s.choose();
  if (superseder === "newer-tab") {
    assert.equal(s.selectTab(1), true); assert.equal(s.c.activeTab, 1);
  } else if (superseder === "newer-pick") {
    await s.showPicker(); const newer = s.choose("beta");
    await s.settle(newer, "resolve");
  } else {
    s.switchTo("B");
    if (superseder === "A→B→A") s.switchTo("A");
  }
  const before = [...s.events], focused = s.document.activeElement;
  await s.settle(old, outcome);
  assert.deepEqual(s.events, before, "stale handoff must not preselect or navigate");
  assert.deepEqual(s.notices, [], "stale rejection must not notify over newer UI");
  assert.equal(s.document.activeElement, focused);
}
for (const outcome of ["resolve", "reject"]) {
  for (const superseder of ["newer-tab", "newer-pick", "A→B", "A→B→A"]) {
    test(`Quick Open ${outcome} after ${superseder} cannot reclaim the foreground`, t => staleHandoff(t, outcome, superseder));
  }
}

for (const outcome of ["resolve", "reject"]) test(`workspace change closes pending picker content; old ${outcome} cannot paint across A→B→A`, async t => {
  const s = fixture(t);
  const oldLoad = s.quickOpen.open(), oldRequest = s.requests.at(-1);
  const oldInput = s.document.querySelector(".palette-input");
  s.switchTo("B");
  assert.equal(s.document.querySelector(".palette-overlay"), null, "workspace close is synchronous");
  s.switchTo("A");
  await s.showPicker([souls[1]]);
  assert.equal(s.paletteCloses, 2, "instance palette also contains workspace-owned references");
  if (outcome === "resolve") oldRequest.resolve({ agents: [souls[0]] });
  else oldRequest.reject(new Error("old workspace list unavailable"));
  await oldLoad;
  assert.deepEqual([...s.document.querySelectorAll(".plabel")].map(row => row.textContent), ["beta"]);
  oldInput.dispatchEvent(new s.document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(s.loads.length, 0, "detached input cannot select from a dead workspace visit");
  await s.settle(s.choose("beta"), "resolve");
  assert.deepEqual(s.events, [["preselect", souls[1]], ["stage", "spawn"]]);
});

test("a loaded picker row from the old workspace cannot run after A→B→A", async t => {
  const s = fixture(t); await s.showPicker();
  const oldRow = s.document.querySelector("[role=option]");
  s.switchTo("B"); s.switchTo("A");
  oldRow.click();
  assert.equal(s.loads.length, 0, "old row has no dispatch authority");
  await s.showPicker([souls[1]]);
  oldRow.click();
  assert.equal(s.loads.length, 0, "reopening in A does not revive A's prior lifetime");
  await s.settle(s.choose("beta"), "resolve");
  assert.deepEqual(s.events, [["preselect", souls[1]], ["stage", "spawn"]]);
});

// All mutants run in memory, leaving this shared worktree untouched.
for (const outcome of ["resolve", "reject"]) {
  test(`mutation: Quick Open ${outcome} must check its dispatch ticket`, async t => {
    const oldBlock = source.slice(source.indexOf("// ── Quick Open, folded into the palette"), source.indexOf("// ── shortcuts editor"));
    const guard = outcome === "resolve" ? "    if (!owns()) return;\n    mod.preselectSpawn" : "      if (!owns()) return;\n      ctx.notify";
    assert.ok(oldBlock.includes(guard));
    const mutant = source.replace(oldBlock, oldBlock.replace(guard, guard.replace("if (!owns()) return;", "/* weakened guard */")));
    await assert.rejects(staleHandoff(t, outcome, "newer-tab", { shellSource: mutant }), /stale handoff|stale rejection/);
  });
  test(`mutation: workspace generation is essential to Quick Open A→B→A ${outcome}`, async t => {
    const ownership = runInNewContext(`(${createSelectionOwnership.toString().replace("&& generation === workspaceGeneration()", "")})`);
    await assert.rejects(staleHandoff(t, outcome, "A→B→A", { ownership }), /stale handoff|stale rejection/);
  });
}
