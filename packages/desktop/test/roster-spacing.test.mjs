// Non-layout CSS/DOM contracts: jsdom does not measure font boxes, paint tree
// guides or capture screenshots. Execute only the shipped roster render function;
// no shell startup, HTTP, Electron, IPC, CLI or real terminal/session operations.
import test from "node:test";
import { viewContext } from "./helpers/view-context.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import * as treeShared from "../../client/instance-tree.mjs";
import * as relatedWork from "../../client/related-work.mjs";
import * as treeView from "../renderer/instance-tree-view.mjs";
const tree = { ...treeShared, ...treeView, ...relatedWork }; // the renderer's client imports, shipped
import { instanceActions, captureInstanceActionMenu } from "../renderer/instance-actions.mjs";
import { instanceActionTarget, sameInstanceActionTarget } from '../renderer/instance-action-target.mjs';
import { instanceSplitPlan } from '../renderer/instance-split.mjs';
import { runtimeState, unsupportedSession } from "../../client/instance-presentation.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const css = read("shell.css"), html = read("index.html");
const renderSource = read("shell.mjs").match(/function renderContextRoster\(instances\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(renderSource, "exercise the shipped roster composition, not a hand-copied row");
const instance = (name, parentInstance) => ({ instance: name, parentInstance, agent: "dev",
  home: `/synthetic/${name}`, agentsRoot: "/synthetic/agents", repoName: "desktop-repo", running: true });
const roster = [instance("root"), instance("child-a", "root"), instance("grand-a", "child-a"),
  instance("child-b", "root"), instance("grand-b", "child-b"),
  { ...instance("unknown"), running: null }];

/** The same roster from a host that declares instance-related-work, every child reporting related work. */
const relatedRoster = roster.map(row => ({ ...row, relatedWorkKnown: relatedWork.RELATED_WORK_FEATURE, ...(row.parentInstance ? { relatedWork: true } : {}) }));

function fixture(t, stylesheet = css, rows = roster) {
  // Default jsdom disables scripts and external resource loading in shipped HTML.
  const dom = new JSDOM(html);
  t.after(() => dom.window.close());
  // jsdom has no top-layer API: model only the popover's open/close events (as instance-actions.test.mjs does), and
  // this window paints nothing: the menu's next-frame placement runs at once.
  dom.window.requestAnimationFrame ??= cb => { cb(); return 0; };
  for (const [method, newState] of [["showPopover", "open"], ["hidePopover", "closed"]]) {
    dom.window.HTMLElement.prototype[method] = function () {
      const event = new dom.window.Event("beforetoggle");
      Object.defineProperty(event, "newState", { value: newState });
      this.dispatchEvent(event);
    };
  }
  const doc = dom.window.document;
  const said = [];
  const style = doc.createElement("style"); style.textContent = stylesheet; doc.head.append(style);
  const rules = [...style.sheet.cssRules];
  const rule = selector => {
    const matches = rules.filter(r => r.selectorText === selector);
    assert.equal(matches.length, 1, `one shipped rule for ${selector}`);
    return matches[0].style;
  };
  const context = {
    ...tree, document: doc, instanceActions, captureInstanceActionMenu, runtimeState, unsupportedSession, canAddressRemote, rowReason,
    instanceActionTarget, instanceSplitPlan, connectionGeneration: 0, menuState() {}, runAction: assert.fail, sayInHint: line => said.push(line),
    applyChordTitles() {}, updateActiveContexts() {}, getBinding: () => null, formatChord: c => c, isMac: true,
    contextRosterEl: doc.querySelector("#instance-roster"), contextWorkspace: "A",
    rosterState: { hasData: true, state: "ready" }, rosterStale: false, contextDeploymentNote: null, ...viewContext(), // loading state: a read succeeded
    contextInstances: rows, currentWorkspace: () => "A", workspaceGeneration: () => 0, collapsedInstances: new Set(), spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} },
    tabs: new Map([[1, { kind: "terminal", key: tree.terminalKey("A", rows[1]) }]]), activeTab: 1,
    tabOpenIntents: { applyFocus: fn => fn() },
    // Display-only fixture: any attempted navigation/action is a test failure.
    openTerminalTab: assert.fail, openInstanceStart: assert.fail, openLifecycleDialog: assert.fail, onRosterRowKey: assert.fail,
    api: assert.fail, showStage: assert.fail, refreshContextRoster: assert.fail,
  };
  context.splitOpenState = () => ({ split: null, activeId: context.activeTab, tabs: context.tabs, workspace: 'A', visible: false });
  context.ownsInstanceTarget = target => context.contextInstances.filter(row => sameInstanceActionTarget(target, row, 'A')).length === 1;
  const render = runInNewContext(`${renderSource}\nrenderContextRoster`, context);
  render(rows);
  // The row's context menu (#1559): a right-click at the pointer, or Shift+F10 / the Menu key (clientX = clientY = 0).
  const contextMenu = (el, { x = 0, y = 0 } = {}) => el.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return { doc, rules, rule, render, said, contextMenu, rows: [...doc.querySelectorAll(".ctx-tree-row")],
    computed: node => dom.window.getComputedStyle(node) };
}

function assertRoom(u) {
  // Slice 1 of the Desktop UI rework: a 44px row box (two lines, the dot centred) whose background fills 40px inside
  // 2px transparent borders, so neighbouring backgrounds keep a 4px gap and never touch (human, 2026-09-29).
  assert.equal(u.rule(".ctx-tree-row").minHeight, "44px", "a 44px row box");
  assert.equal(u.rule(".ctx-tree-row").borderTop, "var(--row-gap) solid transparent");
  assert.equal(u.rule(".ctx-tree-row").borderBottom, "var(--row-gap) solid transparent");
  assert.equal(u.rule(".ctx-tree-row").getPropertyValue("--row-gap"), "2px");
  assert.equal(u.rule(".ctx-tree-row").backgroundClip, "padding-box", "the background stops short of the gap");
  assert.equal(u.rule(".ctx-inst").minHeight, "40px", "the whole painted row is one click target");
  assert.equal(u.rule(".ctx-inst").height, "auto", "never squeeze two labels into a fixed box");
  // Slice 3d (the prototype's two-line row): no gap; the lines' own heights (17px, then 15px) stack in the 40px fill.
  assert.equal(u.rule(".ctx-copy").gap, "0px", "name/meta stack on their line heights, the 17px/15px stack");
  assert.deepEqual([u.rule(".ctx-name").lineHeight, u.rule(".ctx-meta.ctx-row-detail").lineHeight], ["17px", "15px"], "the 17px/15px stack");
  assert.equal(u.rule(".ctx-head").height, "32px", "the head is the only chrome above the list");
  assert.match(u.rule(".ctx-head").flex, /^(none|0 0 auto)$/, "it never shrinks into the list");
  for (const row of u.rows) {
    const button = row.querySelector(".ctx-inst");
    for (const el of [row, button]) {
      const style = u.computed(el);
      assert.equal(style.maxHeight, "none", "no max-height clipping when labels grow");
      assert.equal(style.alignItems, "center");
      assert.match(style.marginTop, /^0(?:px)?$/, "no external row/control gap to break connector continuity");
      assert.match(style.marginBottom, /^0(?:px)?$/);
      assert.equal(style.overflowY, "visible", "do not clip the label stack or focus ring vertically");
    }
    assert.equal(u.rule(".ctx-inst").paddingLeft, "var(--dot-inset, 10px)", "the dot sits on the connector column");
    assert.equal(u.rule(".ctx-tree-row").getPropertyValue("--dot-inset"), "12px", "12px in, the prototype's");
  }
}

test("roster spacing (non-layout): 44px rows with a 4px gap, padded controls, the list right under the head", t => {
  const u = fixture(t);
  assertRoom(u);
  // No filter field since the product owner removed it (the command palette finds an instance by name).
  const roster = u.doc.getElementById("instance-roster");
  assert.equal(roster.querySelector(".ctx-filter, .ctx-filter-field, input"), null, "the roster has no filter");
  assert.deepEqual([...roster.children].map(el => el.className), ["ctx-head", "ctx-list"]);
  const head = roster.querySelector(".ctx-head");
  assert.equal(head.nextElementSibling.className, "ctx-list");
  assert.equal(u.computed(head.nextElementSibling).overflowY, "auto", "longer rosters still scroll");
});

test("roster spacing (non-layout): a selected or hovered row keeps its 4px gap (human, 2026-10-03)", t => {
  // The background shorthand resets background-clip to border-box, painting the transparent borders,
  // so a selected row and a hovered neighbour touched. State rules may set only the colour.
  const u = fixture(t);
  const active = u.rows.filter(row => row.classList.contains("active"));
  assert.equal(active.length, 1, "the fixture renders one selected row");
  assert.equal(u.computed(active[0]).backgroundClip, "padding-box", "the selected fill stops short of the gap");
  for (const selector of [".ctx-tree-row:hover", ".ctx-tree-row.active", ".ctx-tree-row.ctx-spawn-revealed"]) {
    assert.ok(u.rule(selector).backgroundColor, `${selector} paints a fill`);
    assert.equal(u.rule(selector).background, "", `${selector} sets no background shorthand`);
    assert.equal(u.rule(selector).backgroundClip, "", `${selector} leaves the row's padding-box clip alone`);
  }
});

// The product owner (2026-10-23): a parent and its child are as far apart as two independent instances. Every row
// is the one .ctx-tree-row box (min-height 44px, 2px transparent borders); depth only indents it. No other rule may
// space a row, its button or its children by depth, relation or state.
test("a parent and its child are spaced as two independent rows: no rule spaces rows by depth", t => {
  const u = fixture(t);
  const base = u.rule(".ctx-tree-row");
  assert.equal(base.minHeight, "44px");
  assert.equal(base.borderTop, "var(--row-gap) solid transparent"); assert.equal(base.borderBottom, "var(--row-gap) solid transparent");
  assert.equal(base.paddingLeft, "calc(var(--depth) * var(--tree-step))", "depth indents, nothing else");
  const SPACING = ["margin", "margin-top", "margin-bottom", "padding-top", "padding-bottom", "border-top", "border-bottom",
    "border-top-width", "border-bottom-width", "border-width", "min-height", "height", "--row-gap"];
  for (const rule of u.rules.filter(r => /\.ctx-(?:tree-row|inst)\b/.test(r.selectorText || ""))) {
    if (rule.selectorText === ".ctx-tree-row" || rule.selectorText === ".ctx-inst") continue;
    // A row's own descendants (its name, second line, tools) are inside the 44px box: only the row boxes themselves count.
    if (!/\.ctx-(?:tree-row|inst)(?:[.:\[][^ >+~]*)?$/.test(rule.selectorText.split(",").at(-1).trim())) continue;
    for (const prop of SPACING) assert.equal(rule.style.getPropertyValue(prop), "", `${rule.selectorText} sets ${prop}`);
  }
});

test("roster typography (non-layout): valid control family and supplied sidebar label scale", t => {
  const u = fixture(t);
  assert.deepEqual(u.rules.filter(r => /\.ctx-filter/.test(r.selectorText || "")).map(r => r.selectorText), [], "no roster filter rule ships");
  assert.equal(u.rule(".ctx-group").height, "12px", "a 12px gap after a group (slice 1: the air between groups)");
  assert.equal(u.rule(".ctx-bundle-gap").height, "12px", "and the same before a bundle inside a group");
  assert.equal(u.rule(".ctx-group:first-child").height, "6px", "the first row sits closer to the head (human, 2026-09-29)");
  assert.equal(u.rule(".ctx-inst").getPropertyValue("font"), "inherit");
  // Slice 3d: the prototype's row names, 13px in the body weight (the selection's fill tells the current row).
  assert.equal(u.rule(".ctx-name").fontSize, "13px");
  assert.equal(u.rule(".ctx-name").fontWeight, "400");
  // The second line (slice 1): `<soul> · <machine>` in the UI face, 11.5px (Inconsolata is narrow: the operator,
  // 2026-10-02, kept), muted; an unknown row keeps it (its reason is its description).
  assert.equal(u.rule(".ctx-meta.ctx-row-detail").fontSize, "11.5px");
  assert.equal(u.rule(".ctx-meta.ctx-row-detail").fontFamily, "", "in the UI face");
  for (const row of u.rows) {
    const name = row.querySelector(".ctx-name"), meta = row.querySelector(".ctx-meta");
    // A parent's name leads its name line, the disclosure right after it (the product owner, 2026-11-19 and 2026-11-20).
    const first = row.querySelector(".ctx-disclosure") ? name.parentElement : name;
    assert.equal(first.nextElementSibling, meta, "both lines remain in the same vertical stack");
    assert.equal(meta.className, "ctx-meta ctx-row-detail");
    assert.equal(meta.textContent, "dev", "its soul (a local row says no machine, slice 3d), whatever the row's state");
    for (const label of [name, meta]) {
      assert.equal(u.computed(label).textOverflow, "ellipsis");
      assert.equal(u.computed(label).whiteSpace, "nowrap");
      assert.equal(u.computed(label).visibility, "visible");
    }
  }
});

function assertConnectors(u) {
  assert.equal(u.rule(".ctx-tree-row").position, "relative");
  assert.equal(u.rule(".ctx-guides").getPropertyValue("inset"), "calc(-1 * var(--row-gap)) auto calc(-1 * var(--row-gap)) 0",
    "span the entire row, including the transparent gap borders, so lines stay continuous");
  assert.equal(u.rule(".ctx-guides").pointerEvents, "none");
  assert.equal(u.rule(".ctx-guide").position, "absolute");
  // #1312: two columns per level. The dotted sibling link on the dot's column, the solid lineage
  // --tree-branch-offset to its right, so the two never share a column. Human, 2026-10-20: a little more
  // room between them in the sidebar, the link 2px left of the dot's centre (7px apart).
  assert.equal(u.rule(".ctx-tree-row").getPropertyValue("--tree-branch-offset"), "5px", "the lineage column's offset");
  assert.equal(u.rule(".ctx-tree-row").getPropertyValue("--tree-link-shift"), "2px", "the sibling link 2px left of the dot's centre: 7px from the lineage");
  assert.equal(u.rule(".ctx-guide").left, "calc(var(--dot-inset, 10px) + 3.25px + var(--tree-branch-offset) + var(--guide-level) * var(--tree-step))",
    "the solid lineage sits on the offset column, right of the dot column");
  assert.equal(u.rule(".ctx-guide").borderLeft, "1.5px solid var(--tree-stroke)", "a visible stroke, in the token that holds 3:1 (contrast-inventory.mjs)");
  assert.equal(u.rule(".ctx-guide.elbow").borderBottom, "1.5px solid var(--tree-stroke)", "the elbow's run, the same stroke");
  assert.equal(u.rule(".ctx-guide.line").top, "0px", "a pass-through (and a branch row's vertical) spans the whole row: no notch at the elbow");
  assert.equal(u.rule(".ctx-guide.line").bottom, "0px", "a pass-through (and a branch row's vertical) spans the whole row: no notch at the elbow");
  assert.equal(u.rule(".ctx-guide.elbow").height, "calc(50% + 2px)", "the elbow lands on the child dot's centre");
  assert.equal(u.rule(".ctx-guide.elbow").width, "calc(var(--tree-step) - var(--tree-branch-offset) - 4.25px)",
    "the elbow runs from the offset column to 1px under the child dot's ring (ring edge: dot centre - 6px)");
  assert.equal(u.rule(".ctx-guide.elbow").borderBottomLeftRadius, "5px", "rounded elbows");
  assert.equal(u.rule(".ctx-guide.down").top, "50%", "a parent's line leaves from its own dot");
  const link = u.rule(".ctx-guide.link-in, .ctx-guide.link-out, .ctx-guide.link-through");
  assert.equal(link.left, "calc(var(--dot-inset, 10px) + 3.25px - var(--tree-link-shift, 0px) + var(--guide-level) * var(--tree-step))",
    "the sibling link sits on the dot centre column (the row's --dot-inset + 4px radius - half the stroke), shifted left by --tree-link-shift");
  assert.equal(link.borderLeft, "1.5px dotted var(--tree-link)", "sibling links are dotted");
  assert.equal(u.rule(".ctx-dot").boxShadow, "0 0 0 2px var(--row-solid, var(--surface))",
    "the dot's ring hides the line under it, in the row's own solid colour");
}

// The related-work lines (superseding in part slice 1's D26): the roster draws a line for related work only (no flag,
// no line); indentation (18px a level) and the gap before the next bundle show the rest of the tree, and each row
// says its relations in words. A parent wears its disclosure on its name line (#1970). The connectors' rules are the
// sidebar's and the command palette's (assertConnectors).
test("tree (non-layout): indentation, no lines without a flag, a parent's chevron on its name line; the connector rules", t => {
  const u = fixture(t);
  assertConnectors(u);
  assert.equal(u.rule(".ctx-tree-row").getPropertyValue("--tree-step"), "18px");
  assert.equal(u.rule(".ctx-tree-row").paddingLeft, "calc(var(--depth) * var(--tree-step))");
  // The product owner, 2026-11-19, replacing Redesign v3's "no disclosure arrows" (#137): a row with children wears
  // the disclosure on its name line (roster-disclosure.mjs), right after the name since 2026-11-20 ("so that all
  // instance names look aligned on the left"), and the guides stay as they were.
  assert.deepEqual(u.rows.map(row => row.querySelectorAll(".ctx-disclosure").length), [1, 1, 0, 1, 0, 0],
    "one on each row with children, none on a row without");
  for (const row of u.rows.filter(r => r.querySelector(".ctx-disclosure"))) {
    const line = row.querySelector(".ctx-name-line");
    assert.equal(line.firstElementChild.className, "ctx-name", "the name leads the name line");
    assert.equal(line.firstElementChild.nextElementSibling.className, "ctx-disclosure", "the disclosure right after the name");
  }
  assert.deepEqual(u.rows.map(row => row.style.getPropertyValue("--depth")), ["0", "1", "2", "1", "2", "0"]);
  assert.deepEqual(u.rows.map(row => row.querySelectorAll(".ctx-guide, .ctx-guides").length), [0, 0, 0, 0, 0, 0], "no flag: no lines on any row");
  assert.deepEqual(u.rows.map(row => row.querySelector(".ctx-relation")?.textContent ?? null),
    [null, ", under root", ", under child-a", ", under root", ", under child-b", null], "each child says its parent");
});

test("tree (non-layout): every child related: the pre-D26 lines, aria-hidden before the row, and \"related work\" in words", t => {
  const u = fixture(t, css, relatedRoster);
  const guides = row => [...row.querySelectorAll(":scope > .ctx-guides > .ctx-guide")].map(g => `${g.className.replace("ctx-guide ", "")}@${g.style.getPropertyValue("--guide-level")}`);
  assert.deepEqual(u.rows.map(row => row.querySelector(".ctx-name").dataset.name), ["root", "child-a", "grand-a", "child-b", "grand-b", "unknown"]);
  assert.deepEqual(u.rows.map(guides), [
    ["down@0"],
    ["elbow@0", "line@0", "down@1"],
    ["line@0", "elbow@1"],
    ["elbow@0", "down@1"],
    ["elbow@1"],
    [],
  ]);
  for (const row of u.rows.slice(0, 5)) {
    assert.equal(row.firstElementChild.className, "ctx-guides", "the guides lead the row, as before D26");
    assert.equal(row.firstElementChild.getAttribute("aria-hidden"), "true");
  }
  assert.equal(u.rows[5].querySelector(".ctx-guides"), null, "a row with no line carries no guides");
  assert.deepEqual(u.rows.map(row => row.querySelector(".ctx-relation")?.textContent ?? null),
    [null, ", under root, related work", ", under child-a, related work", ", under root, related work", ", under child-b, related work", null]);
  assert.deepEqual(u.rows.map(row => row.style.getPropertyValue("--depth")), ["0", "1", "2", "1", "2", "0"], "the indent is unchanged");
});

test("roster DOM contract: named group separators, identity, active state, hidden-but-reachable tools and closed context menus", t => {
  const u = fixture(t);
  assert.deepEqual([...u.doc.querySelectorAll(".ctx-group")].map(g => [g.getAttribute("role"), g.getAttribute("aria-label"), g.textContent]),
    [["separator", "root, 5 instances", ""], ["separator", "independent, 1 instance", ""]]);
  // The head shows only the running count (human, 2026-09-26); the full breakdown is its title.
  assert.equal(u.doc.querySelector(".ctx-count").textContent, "5 running");
  assert.equal(u.doc.querySelector(".ctx-count").title, "5 running · 0 stopped · 1 unknown");
  for (const row of u.rows) {
    const button = row.querySelector(".ctx-inst"), name = row.querySelector(".ctx-name").dataset.name;
    assert.equal(button.dataset.treeInstance, `/synthetic/${name}`);
    assert.equal(button.hasAttribute("aria-expanded"), button.dataset.rosterChildren === "1", "only parents announce expansion");
    // #1559: no ⋯ trigger; the row's context menu sits beside the row in its wrap, never in its tools (they hide by
    // visibility, which the menu would inherit). A running or unknown row without a known pull request has no tools.
    assert.equal(row.querySelector(".ctx-instance-actions"), null, `${name}: no ⋯ trigger`);
    assert.equal(row.querySelector(".ctx-row-tools"), null, `${name}: nothing overlays the row end`);
    const menu = row.querySelector(".ctx-instance-menu");
    assert.equal(menu.parentElement, row, "the menu is the row wrap's own");
    assert.equal(menu.getAttribute("popover"), "auto", "actions remain in the native closed popover");
    assert.equal(menu.getAttribute("role"), "menu");
    assert.equal(menu.dataset.instanceMenuOpen, undefined, "closed until asked");
    assert.deepEqual([...menu.querySelectorAll("[role=menuitem]")].map(item => item.dataset.action),
      button.getAttribute('aria-disabled') === 'true' ? ['open-split', 'open-pr', "inspect", "stop", "retire"] : ['open-split', 'open-pr', "inspect", "restart", "stop", "retire"]);
  }
  assertTools(u);
  const active = u.doc.querySelector(".ctx-inst.active");
  assert.equal(active.dataset.treeInstance, tree.instanceId(roster[1]));
  assert.equal(active.closest(".ctx-tree-row").classList.contains("active"), true, "the row paints the selection across the indent");
  active.focus(); u.render(roster);
  assert.equal(u.doc.activeElement.dataset.treeInstance, tree.instanceId(roster[1]), "poll retains logical focus");
  assert.equal(u.doc.activeElement.classList.contains("active"), true);
  assert.equal(u.rule(".ctx-inst").color, "var(--fg)");
  assert.equal(u.rule(".ctx-tree-row.active").backgroundColor, "var(--sel)");
  assert.equal(u.rule(".ctx-meta.ctx-row-detail").color, "var(--muted)");
  assert.equal(u.rule(".ctx-meta.ctx-row-detail").background, "", "reference metadata is a plain subline, not a pill");
  // Slice 1: a stopped row has no tools either (no Start… overlay); its context menu offers Start….
  u.render([...roster, { ...instance("stopped"), running: false }]);
  const stopped = [...u.doc.querySelectorAll(".ctx-tree-row")].find(row => row.querySelector(".ctx-name").dataset.name === "stopped");
  assert.equal(stopped.querySelector(".ctx-row-tools, .ctx-start"), null, "no tools overlay the row");
  assert.equal(stopped.querySelector(".ctx-instance-menu").parentElement, stopped);
  assert.ok([...stopped.querySelectorAll(".ctx-instance-menu [role=menuitem]")].some(item => item.dataset.action === "start"), "Start… is the menu's");
  assert.equal(stopped.querySelector(".ctx-instance-actions"), null, "a stopped row has no ⋯ trigger either");
});

function assertTools(u) {
  // A pending spawn's tool (its Check result) is the only row tool left (slice 1): shown, never semi-transparent text
  // (WCAG: no opacity compositing), and no hover or focus reveals tools on an instance row.
  assert.equal(u.rule(".ctx-row-tools").visibility, "hidden", "tools hide by visibility, never opacity");
  assert.equal(u.rule(".ctx-row-tools").opacity, "");
  assert.equal(u.rule(".ctx-tree-row > .ctx-spawn-tools").visibility, "visible", "a pending spawn's own tool is shown");
  assert.equal(u.rules.filter(r => /:hover|:focus-within/.test(r.selectorText || "") && /ctx-row-tools/.test(r.selectorText || "")).length, 0,
    "no hover tools overlay");
}

// The second line holds the soul and the machine, never the repository, the branch or the harness (slice 1: the
// instance panel's); what the row reports is text, never markup.
test("sidebar metadata uses the reported soul and the machine, no repository, branch or harness badge, without claiming membership or installation", t => {
  const u = fixture(t);
  u.render([{ ...roster[0], agent: "soul-<literal>", branch: "feature/<branch>", harness: "pi" }]);
  const row = u.doc.querySelector(".ctx-inst");
  assert.equal(row.querySelector(".ctx-meta").textContent, "soul-<literal>");
  assert.equal(row.querySelector(".ctx-meta").children.length, 0);
  assert.doesNotMatch(row.textContent, /feature|desktop-repo/, "neither the branch nor the repository is on the row");
  assert.equal(row.querySelector(".ctx-runtime, .runtime-badge"), null, "no harness badge on the row");
  assert.equal(row.querySelector("literal, branch"), null);
});

// Mutants exist only as in-memory stylesheets: no shared-file rollback, reload
// or browser is needed to prove the contracts reject the reported regressions.
for (const [label, before, after, check, message] of [
  ["fixed button height", "min-height: 40px; height: auto; display: flex", "min-height: 40px; height: 36px; display: flex", assertRoom, /fixed box/],
  ["cramped name line", "font-weight: 400; line-height: 17px;", "font-weight: 400; line-height: 12px;", assertRoom, /17px\/15px stack/],
  ["sibling links off the dot column", "left: calc(var(--dot-inset, 10px) + 3.25px - var(--tree-link-shift, 0px) + var(--guide-level)", "left: calc(8px + var(--guide-level)", assertConnectors, /dot centre column/],
  ["sibling links on the lineage column", "{ left: calc(var(--dot-inset, 10px) + 3.25px - var(--tree-link-shift, 0px) + var(--guide-level) * var(--tree-step));", "{", assertConnectors, /dot centre column/],
  ["sibling links back on the dot's centre", "--tree-link-shift: 2px;", "--tree-link-shift: 0px;", assertConnectors, /7px from the lineage/],
  ["lineage back on the dot column", "left: calc(var(--dot-inset, 10px) + 3.25px + var(--tree-branch-offset) + var(--guide-level)", "left: calc(var(--dot-inset, 10px) + 3.25px + var(--guide-level)", assertConnectors, /offset column/],
  ["notched branch verticals", ".ctx-guide.line { top: 0; bottom: 0; }", ".ctx-guide.line { top: 50%; bottom: 0; }", assertConnectors, /no notch/],
  ["elbows short of the child dot", "width: calc(var(--tree-step) - var(--tree-branch-offset) - 4.25px)", "width: 9px", assertConnectors, /child dot's ring/],
  ["square elbows", "border-bottom-left-radius: 5px", "border-bottom-left-radius: 0", assertConnectors, /rounded elbows/],
  ["opacity-hidden tools", "background: var(--row-solid); visibility: hidden; }", "background: var(--row-solid); opacity: 0; }", assertTools, /never opacity/],
]) test(`roster CSS contract rejects ${label} (in-memory, non-layout)`, t => {
  assert.ok(css.includes(before), "mutate the shipped declaration");
  const u = fixture(t, css.replace(before, after));
  assert.throws(() => check(u), { code: "ERR_ASSERTION", message });
});

// Human, 2026-09-29: a running dot stays solid on a selected or hovered row. Its knockout ring takes the
// row's own solid colour, so on the tint it never reads as a hollow dot inside a white halo.
test("running dot stays solid --accent on selected and hovered rows; its ring is the row's colour", t => {
  const u = fixture(t);
  const active = u.doc.querySelector(".ctx-tree-row.active");
  assert.ok(active, "the fixture has a selected row");
  const dot = active.querySelector(".ctx-dot");
  assert.equal(dot.className, "ctx-dot on", "the selected fixture row is running");
  const style = u.computed(dot);
  assert.equal(style.background, "var(--accent)", "solid fill");
  assert.equal(u.rule(".ctx-dot.on").borderColor, "var(--accent)", "jsdom keeps var() only in the shorthand, so the border is read from the rule");
  assert.equal(style.boxShadow, "0 0 0 2px var(--row-solid, var(--surface))", "the ring follows the row's solid colour");
  assert.equal(u.rule(".ctx-tree-row.active").getPropertyValue("--row-solid"), "var(--sel)", "the ring on a selected row is the tint");
  assert.equal(u.rule(".ctx-tree-row:hover").getPropertyValue("--row-solid"), "var(--surface-2)", "and on hover the hover surface");
  assert.equal(u.computed(active).getPropertyValue("--row-solid").trim(), "var(--sel)", "the selected row resolves its own solid colour");
  assert.equal(u.rule(".ctx-dot").background, "var(--surface)", "only a stopped dot is hollow");
  assert.equal(u.rule(".ctx-dot.on").background, "var(--accent)");
});

// Spec F audit: an instance whose state is unknown can't open, but its row takes focus
// (aria-disabled, never disabled) so its context menu (Shift+F10, the Menu key) stays keyboard-reachable,
// and the roster's one tab stop is the selected row (its terminal is the active tab).
test("keyboard: an unavailable row stays focusable with its context menu; the tab stop is the selected row", t => {
  const u = fixture(t);
  const row = u.rows.at(-1), button = row.querySelector(".ctx-inst");
  assert.equal(button.disabled, false, "never disabled: a disabled button can't take focus");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(button.getAttribute("aria-description"), "unknown: status unknown");
  button.focus(); assert.equal(u.doc.activeElement, button);
  button.click(); // the fixture fails on any open/start: an unavailable row's activation does nothing
  // Its context menu opens from the keyboard (a key's contextmenu: no pointer) and takes focus; Esc hands it back to the row.
  const menu = row.querySelector(".ctx-instance-menu");
  u.contextMenu(button);
  assert.equal(menu.dataset.instanceMenuOpen, "true", "the unavailable row's menu opens");
  assert.equal(u.doc.activeElement.closest(".ctx-instance-menu"), menu, "focus is in its menu");
  assert.equal(u.doc.activeElement.getAttribute("role"), "menuitem", "on its default item");
  assert.deepEqual(u.said, [], "not held: nothing said");
  u.doc.activeElement.dispatchEvent(new u.doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(menu.dataset.instanceMenuOpen, "false");
  assert.equal(u.doc.activeElement, button, "Esc: focus back on the row");
  assert.equal(button.getAttribute("aria-disabled"), "true", "the row's own marking is unchanged");
  assert.equal(button.getAttribute("aria-description"), "unknown: status unknown");
  const stops = [...u.doc.querySelectorAll(".ctx-inst")].filter(b => b.tabIndex === 0);
  assert.deepEqual(stops.map(b => b.dataset.treeInstance), [tree.instanceId(roster[1])], "one tab stop: the selected row");
});

test('a row that cannot open keeps soul · machine on its second line and says why in its title and aria-description', t => {
  const u = fixture(t);
  const remote = (name, extra) => ({ ...instance(name), home: `/srv/agents/dev/instances/${name}`, agentsRoot: '/srv/agents', server: 'build',
    repoName: 'Build box', addressable: true, missingRemotely: false, ...extra });
  const rows = [
    [{ ...instance('herdr'), running: null, runtimeState: 'unsupported', runtimeError: 'E_HERDR_REMOVED: Herdr is no longer supported.' },
      'Herdr no longer supported', 'E_HERDR_REMOVED: Herdr is no longer supported.'],
    [remote('gone', { addressable: false, missingRemotely: true, running: null }), 'gone from Build box',
      'gone is no longer on Build box. Remove it from this computer with: oats server forget build --instance gone'],
    [remote('hidden', { addressable: false }), 'not reachable on Build box', 'Build box did not report this instance as reachable.'],
    [remote('far', { running: null, serverUnreached: true, runtimeError: 'ssh failed: Connection refused' }), 'Build box not reached', 'ssh failed: Connection refused'],
    [{ ...instance('unsure'), running: null }, 'state unknown', 'unsure: status unknown'],
  ];
  u.render(rows.map(([row]) => row));
  // The short label (the second column, rowReason's) was the second line's before slice 1; the sentence still says it.
  for (const [row, , sentence] of rows) {
    const button = [...u.doc.querySelectorAll('.ctx-inst')].find(b => b.querySelector('.ctx-name').dataset.name === row.instance);
    assert.ok(button, row.instance);
    assert.equal(button.querySelector('.ctx-meta').textContent, row.server ? `dev · ${row.repoName}` : 'dev', `${row.instance}: soul, and another machine's name (slice 3d)`);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.title.split('\n')[0], sentence); assert.equal(button.getAttribute('aria-description'), sentence);
    assert.equal(button.closest('.ctx-tree-row').querySelector('.ctx-instance-actions'), null, `${row.instance}: no ⋯ trigger (#1559)`);
  }
  // An addressable foreign row (no saved route here) opens like any other: no reason, no disabled state.
  u.render([remote('foreign', { savedRoute: false })]);
  const foreign = u.doc.querySelector('.ctx-inst');
  assert.equal(foreign.getAttribute('aria-disabled'), null);
  assert.equal(foreign.querySelector('.ctx-meta').textContent, 'dev · Build box', 'the soul, then the machine');
});
