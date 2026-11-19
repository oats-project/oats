// 0.68.1 (the product owner): a sidebar instance row shows its name as words (packages/client instanceDisplayName),
// nested and pending rows too, while the real name stays wherever it identifies the instance: the row's spoken
// name, its data-name, and the palette's match and label. Runs the shipped shell.mjs roster
// composition (renderContextRoster + pendingSpawnRow) against a JSDOM of index.html.
import test from "node:test";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import * as treeShared from "../../client/instance-tree.mjs";
import * as sameWork from "../../client/same-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
const tree = { ...treeShared, ...treeView, ...sameWork }; // the renderer's client imports, shipped
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from "../renderer/instance-action-target.mjs";
import { instanceSplitPlan } from "../renderer/instance-split.mjs";
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { paletteRows } from "../renderer/palette.mjs";
import { spokenText } from "./helpers/spoken-text.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const html = read("index.html"), shell = read("shell.mjs");
const fn = name => shell.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
const source = ["renderContextRoster", "pendingSpawnRow", "announceSpawn"].map(name => { const s = fn(name); assert.ok(s, name); return s; }).join("\n");
const instance = (name, parentInstance, extra = {}) => ({ instance: name, parentInstance, agent: "dev",
  home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents", repoName: "desktop-repo", running: true, ...extra });
const roster = [instance("oats-expert-maintainer-lanes"), instance("tui-leader-hint-developer-2", "oats-expert-maintainer-lanes"), instance("x")];
const WORDS = { "oats-expert-maintainer-lanes": "Oats expert maintainer lanes", "tui-leader-hint-developer-2": "Tui leader hint developer 2",
  x: "X", "dev-new": "Dev new" };

function fixture(t, pendingRows = []) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const context = {
    ...tree, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, sayInHint() {}, runAction: assert.fail,
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null, ...viewContext(),
    currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(),
    spawnJobs: { rows: ws => ws === "A" ? pendingRows : [], announce: () => false, check() {} },
    tabs: new Map(), activeTab: null, tabOpenIntents: { applyFocus: f => f() },
    openTerminalTab: assert.fail, openInstanceStart: assert.fail, openLifecycleDialog: assert.fail, onRosterRowKey() {},
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
  };
  context.splitOpenState = () => ({ split: null, activeId: null, tabs: context.tabs, workspace: "A", visible: false });
  context.ownsInstanceTarget = target => roster.filter(row => sameInstanceActionTarget(target, row, "A")).length === 1;
  runInNewContext(`${source}\nrenderContextRoster`, context)(roster);
  const list = doc.querySelector(".ctx-list");
  const row = name => [...list.querySelectorAll(".ctx-inst")].find(b => b.querySelector(".ctx-name")?.dataset.name === name);
  return { list, row };
}

/** Every attribute value under (and on) `el`. */
const attributes = el => [el, ...el.querySelectorAll("*")].flatMap(node => [...node.attributes].map(a => `${node.tagName}[${a.name}]=${a.value}`));

test("a row shows its name as words, nested rows too; its spoken name and data-name keep the real name", t => {
  const u = fixture(t);
  for (const { instance: real } of roster) {
    const button = u.row(real);
    assert.ok(button, `${real}: a row, found by its data-name`);
    const name = button.querySelector(".ctx-name");
    const [shown, spoken] = name.children;
    assert.equal(shown.textContent, WORDS[real], `${real}: the words are what shows`);
    assert.equal(shown.getAttribute("aria-hidden"), "true", `${real}: the words are not read`);
    assert.equal(spoken.className, "sr-only", `${real}: the real name is read, visually hidden`);
    assert.equal(spoken.textContent, real);
    assert.equal(name.children.length, 2);
    assert.ok(spokenText(button).startsWith(real), `${real}: the row's name for assistive tech is the real name`);
    assert.equal(button.hasAttribute("aria-label"), false, "the row's name is its content, so the meta line is read too");
    // No title, label or description says the words: they are the visible label alone.
    assert.deepEqual(attributes(button.closest(".ctx-tree-row")).filter(a => a.includes(WORDS[real])), [], `${real}: no attribute says the words`);
  }
  const child = u.row("tui-leader-hint-developer-2").closest(".ctx-tree-row");
  assert.equal(child.style.getPropertyValue("--depth"), "1", "the child row is nested under its parent");
});

test("a pending spawn's row shows its name as words, and keeps the real name the same way", t => {
  const u = fixture(t, [{ id: "spawn-1", instance: "dev-new", home: "/synthetic/dev-new", agent: "dev", agentsRoot: "/synthetic/agents",
    parentInstance: "x", pending: "spawning" }]);
  const button = u.row("dev-new");
  assert.ok(button, "the pending row, found by its data-name");
  const [shown, spoken] = button.querySelector(".ctx-name").children;
  assert.deepEqual([shown.textContent, shown.getAttribute("aria-hidden"), spoken.className, spoken.textContent], ["Dev new", "true", "sr-only", "dev-new"]);
  assert.ok(spokenText(button).startsWith("dev-new"));
});

test("the palette matches and labels an instance by its real name, not its words", () => {
  const rows = paletteRows(roster, [], "maintainer-lanes", { openTerminal() {} }).filter(r => r.run && !r.context);
  assert.deepEqual(rows.map(r => r.label), ["oats-expert-maintainer-lanes"]);
  assert.deepEqual(paletteRows(roster, [], "Tui leader", { openTerminal() {} }).filter(r => r.run && !r.context).map(r => r.label), [],
    "the words are not a name the palette knows");
});
