// Editor-group split UI — DOM projection (split-dom.mjs), tab-strip split
// controls (split-controls.mjs), context-gated button dispatch (runAction),
// and shell/index.html wiring pins for the clickable affordances.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import {
  requestSplit, focusTab, openTabInFocusedGroup, removeSplitTab, MAX_SPLIT_GROUPS,
} from "../renderer/split-layout.mjs";
import { projectSplitDom } from "../renderer/split-dom.mjs";
import { splitControlsState } from "../renderer/split-controls.mjs";
import { registerAction, setActiveContexts, runAction } from "../renderer/keybindings.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

function dom() {
  return new JSDOM(`
    <div id="tabstrip">
      <div id="tabbar-row">
        <div id="tabbar" role="tablist"></div>
        <div id="tab-actions"><button id="b"></button></div>
      </div>
    </div>
    <div id="tabhost"></div>`);
}

function shellEls(doc) {
  return {
    tabhost: doc.getElementById("tabhost"),
    tabstrip: doc.getElementById("tabstrip"),
    tabbar: doc.getElementById("tabbar"),
    actionsEl: doc.getElementById("tab-actions"),
    actionsHome: doc.getElementById("tabbar-row"),
  };
}

function makeTabs(doc, ids) {
  const tabs = new Map();
  const tabbar = doc.getElementById("tabbar");
  const tabhost = doc.getElementById("tabhost");
  for (const id of ids) {
    const tabEl = doc.createElement("div");
    tabEl.className = "tab";
    tabEl.id = `tab-wrap-${id}`;
    const triggerEl = doc.createElement("button");
    triggerEl.id = `tab-${id}`;
    triggerEl.setAttribute("role", "tab");
    tabEl.append(triggerEl);
    tabbar.append(tabEl);
    const paneEl = doc.createElement("div");
    paneEl.id = `tabpanel-${id}`;
    tabhost.append(paneEl);
    tabs.set(id, { tabEl, triggerEl, paneEl });
  }
  return tabs;
}

// ── requirement: each group renders its own tab strip above its pane ─────

test("splitting projects one group-cell per group: group strip with the REAL tab elements + the group's panes; empty group shows the placeholder", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  // user is on tab 2 and splits right — the shell's splitPane path
  let split = requestSplit(null, "row", [1, 2, 3], 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  assert.ok(els.tabhost.classList.contains("split-row"));
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(cells.length, 2);
  const bar1 = cells[0].querySelector(":scope > .group-tabbar");
  assert.equal(bar1.getAttribute("role"), "tablist", "each group strip is its own tablist");
  // ALL existing tabs stay together in group 1's strip (human requirement)
  assert.deepEqual([...bar1.querySelectorAll(".tab")].map((t) => t.id),
    ["tab-wrap-1", "tab-wrap-2", "tab-wrap-3"]);
  // and their panes park inside group 1's cell
  for (const id of [1, 2, 3]) assert.equal(tabs.get(id).paneEl.parentNode, cells[0]);
  assert.equal(doc.getElementById("tabbar").querySelector(".tab"), null, "flat strip emptied");
  // the new (focused) empty group shows the placeholder, no tabs
  assert.ok(cells[1].querySelector(":scope > .split-empty"));
  assert.equal(cells[1].querySelector(".split-empty").tabIndex, 0);
  // the split controls ride the FOCUSED group's strip
  assert.equal(els.actionsEl.parentNode, cells[1].querySelector(".group-tabbar"));
});

test("new tab opens into the FOCUSED group's strip; the old flat strip stays hidden (no phantom chrome row)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  projectSplitDom(els, split, true, [...tabs]);
  // the top strip row is HIDDEN while split — the PR #44 phantom empty bar
  assert.ok(els.tabstrip.classList.contains("split-hidden"),
    "the shell-level #tabstrip must not render as an empty bar during a split");
  split = openTabInFocusedGroup(split, 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(cells[1].querySelector(".tab"), tabs.get(2).tabEl, "tab 2 opened into the focused group");
  assert.equal(tabs.get(2).paneEl.parentNode, cells[1]);
  assert.equal(els.tabhost.querySelector(".split-empty"), null, "placeholder leaves once the group fills");
});

test("projection is idempotent — an in-place node is never re-inserted (pointerdown-tear guard)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  split = openTabInFocusedGroup(split, 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  const snapshot = els.tabhost.innerHTML;
  const moves = [];
  for (const [id, t] of tabs) {
    for (const el of [t.tabEl, t.paneEl]) {
      const { after } = el;
      el.after = (...a) => { moves.push(id); return after.apply(el, a); };
    }
  }
  projectSplitDom(els, split, true, [...tabs]);
  assert.deepEqual(moves, [], "no node moved on a re-render");
  assert.equal(els.tabhost.innerHTML, snapshot);
});

test("switching the active tab within a group re-projects without dismantling the split", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1, 2], 1).split;
  split = openTabInFocusedGroup(split, 3).split;
  split = focusTab(split, 2).split; // switch within group 1
  projectSplitDom(els, split, true, [...tabs]);
  assert.equal(els.tabhost.querySelectorAll(":scope > .group-cell").length, 2,
    "the split persists across tab switches (tab-layer ownership)");
  // controls follow group focus back to group 1
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.equal(els.actionsEl.parentNode, cells[0].querySelector(".group-tabbar"));
});

test("explicit Close split restores the flat layout byte-identical to the pre-split DOM (regression guard)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  const stripBefore = els.tabstrip.outerHTML;
  const hostBefore = els.tabhost.outerHTML;
  let split = requestSplit(null, "row", [1, 2, 3], 2).split;
  split = openTabInFocusedGroup(split, 3 /* member: focuses, no dup */).split;
  projectSplitDom(els, split, true, [...tabs]);
  // the split closes (split.close action → model null)
  projectSplitDom(els, null, false, [...tabs]);
  assert.equal(els.tabstrip.outerHTML, stripBefore, "strip DOM byte-identical to non-split state");
  assert.equal(els.tabhost.outerHTML, hostBefore, "host DOM byte-identical to non-split state");
  assert.ok(!els.tabstrip.classList.contains("split-hidden"));
});

test("covering the split (non-member tab active) hides it without destroying group state; re-activating restores it", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  split = openTabInFocusedGroup(split, 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  projectSplitDom(els, split, false, [...tabs]); // covered — e.g. souls-context tab
  assert.equal(els.tabhost.querySelector(".group-cell"), null);
  assert.ok(!els.tabstrip.classList.contains("split-hidden"));
  assert.deepEqual([...els.tabbar.querySelectorAll(".tab")].map((t) => t.id),
    ["tab-wrap-1", "tab-wrap-2"], "flat strip in creation order while covered");
  projectSplitDom(els, split, true, [...tabs]); // back on the tab layer
  assert.equal(els.tabhost.querySelectorAll(":scope > .group-cell").length, 2, "split re-materializes");
});

test("closing a group's last tab retains its empty cell and every other cell (stable data-group identity)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2, 3]);
  const els = shellEls(doc);
  let split = requestSplit(null, "row", [1], 1).split;
  split = openTabInFocusedGroup(split, 2).split;
  split = requestSplit(split, "row", null, null).split;
  split = openTabInFocusedGroup(split, 3).split; // [1] [2] [3]
  projectSplitDom(els, split, true, [...tabs]);
  const before = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  ({ split } = removeSplitTab(split, 2));
  // tab 2's nodes leave the DOM the way closeTab removes them
  tabs.get(2).tabEl.remove(); tabs.get(2).paneEl.remove(); tabs.delete(2);
  projectSplitDom(els, split, true, [...tabs]);
  const cells = [...els.tabhost.querySelectorAll(":scope > .group-cell")];
  assert.deepEqual(cells, before, "every group keeps its cell node");
  assert.ok(cells[1].querySelector(".split-empty"), "closed last tab leaves its own placeholder");
});

test("projection preserves keyboard focus on the focused tab trigger across regrouping (a11y)", () => {
  const { window } = dom();
  const doc = window.document;
  const tabs = makeTabs(doc, [1, 2]);
  const els = shellEls(doc);
  tabs.get(2).triggerEl.focus();
  let split = requestSplit(null, "row", [1, 2], 2).split;
  projectSplitDom(els, split, true, [...tabs]);
  assert.equal(doc.activeElement, tabs.get(2).triggerEl, "moving the tab into its group keeps focus");
  projectSplitDom(els, null, false, [...tabs]);
  assert.equal(doc.activeElement, tabs.get(2).triggerEl, "restoring the flat strip keeps focus");
});

// ── clickable controls share the actions' gating ─────────────────────────

test("splitControlsState mirrors the split actions' gating (terminal-only, cap, empty group)", () => {
  assert.equal(splitControlsState(null, 1, "terminal", false).visible, false);
  assert.equal(splitControlsState(null, 1, "file", true).visible, false);
  assert.equal(splitControlsState(null, null, null, true).visible, false);
  // flat: both splits enabled
  assert.deepEqual(splitControlsState(null, 1, "terminal", true),
    { visible: true, splitRow: true, splitCol: true });
  // an empty group waiting: same-orientation split disabled, re-orient enabled
  const withEmpty = requestSplit(null, "row", [1], 1).split;
  assert.deepEqual(splitControlsState(withEmpty, 1, "terminal", true),
    { visible: true, splitRow: false, splitCol: true });
  // at the cap: only re-orientation stays enabled
  let full = requestSplit(null, "row", [1], 1).split;
  for (let id = 2; full.groups.length < MAX_SPLIT_GROUPS || full.groups.some((g) => !g.tabs.length); id++) {
    if (full.groups.some((g) => !g.tabs.length)) full = openTabInFocusedGroup(full, id).split;
    else full = requestSplit(full, "row", null, null).split;
  }
  assert.equal(full.groups.length, MAX_SPLIT_GROUPS);
  assert.deepEqual(splitControlsState(full, 1, "terminal", true),
    { visible: true, splitRow: false, splitCol: true });
});

test("runAction dispatches a registered action only in an active context (buttons = chords)", (t) => {
  t.after(() => setActiveContexts(new Set()));
  const calls = [];
  const offs = [
    registerAction({ id: "test.tabsOnly", label: "t", context: "tabs", run: () => calls.push("tabs") }),
    registerAction({ id: "test.global", label: "g", context: "global", run: () => calls.push("global") }),
  ];
  t.after(() => offs.forEach((off) => off()));
  setActiveContexts(new Set()); // stage visible, tab layer hidden
  assert.equal(runAction("test.tabsOnly"), false, "context-gated exactly like chord dispatch");
  assert.equal(runAction("test.global"), true);
  setActiveContexts(new Set(["tabs"]));
  assert.equal(runAction("test.tabsOnly"), true);
  assert.equal(runAction("test.missing"), false);
  assert.deepEqual(calls, ["global", "tabs"]);
});

// ── shell/index.html wiring pins (house style: source-level assertions) ──

test("index.html ships the split buttons and shell wires the group projection through runAction", (t) => {
  const html = read("renderer/index.html");
  for (const id of ["tab-actions", "split-right", "split-down", "show-sidebar", "show-panel", "tabstrip", "tabbar-row"]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`);
  }
  // Spec F: only the two split buttons follow the tabs; closing the split and the panel live on their chords.
  for (const id of ["split-close", "panel-toggle"]) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `#${id} is gone`);
  assert.doesNotMatch(html, /tab-actions-sep/);
  assert.ok(!/id="pane-tabs"/.test(html), "the PR #44 pane-tabs row is gone (phantom chrome fix)");
  assert.doesNotMatch(html, /id="sidebar-restore"/, "a hidden sidebar leaves no edge (Spec B)");
  for (const a of ["split.vertical", "split.horizontal", "sidebar.toggle", "panel.toggle", "app.shortcuts", "app.quickOpenSouls"]) {
    assert.match(html, new RegExp(`data-action="${a.replace(".", "\\.")}"`), `${a} button is chord-titled`);
  }
  const src = read("renderer/shell.mjs");
  assert.match(src, /runAction\("sidebar\.toggle"\)/, "sidebar buttons run the registered action");
  assert.match(src, /\["split-right", "split\.vertical"\]/, "split buttons map to the registered actions");
  assert.match(src, /splitControlsState\(split, activeTab/, "button gating derives from the shared model");
  assert.match(src, /projectSplitDom\(/, "group projection via split-dom");
  const footerDom = new JSDOM(html);
  t.after(() => footerDom.window.close());
  const document = footerDom.window.document;
  // The foot (slice 1 of the Desktop UI rework): only its bar, N need you and ?; no OATS mark, no sidebar toggle
  // (Ctrl+Shift+B, the palette and Show sidebar), no cog. New agent ends the roster (slice 3d).
  assert.equal(document.getElementById("sidebar-toggle"), null, "no sidebar toggle in the foot");
  const spawn = document.querySelector("#instance-roster > button#sidebar-spawn");
  const help = document.querySelector("#nav-foot > #sidebar-bar > button#sidebar-help");
  assert.ok(spawn && help, "New agent at the roster's end, ? in the bar");
  assert.equal(spawn.previousElementSibling.className, "ctx-list", "New agent after the list");
  assert.equal(help.previousElementSibling.id, "sidebar-need-you", "? after the count");
  assert.equal(spawn.dataset.action, "app.quickOpenSouls", "it runs Quick Open");
  assert.equal(spawn.querySelector("kbd"), null, "no chord hint element: the chord is in its tooltip");
  assert.equal(help.getAttribute("aria-label"), "Keyboard shortcuts", "an icon-like button has an accessible name");
  assert.equal(help.dataset.action, "app.shortcuts");
  // The foot's controls and New agent are wired here (every [data-action] in #nav-foot, ?, and #sidebar-spawn at the
  // roster's end), the nav's buttons, under the list of workspaces, by their own listener (shell.mjs nav rail), so no
  // click runs twice.
  const wiring = src.match(/for \(const button of document\.querySelectorAll\("#nav-foot \[data-action\], #sidebar-spawn"\)\) \{[^]*?\n\}/)?.[0];
  assert.ok(wiring, "exercise shipped foot dispatch");
  // A nav button, as the nav rail adds them before this wiring runs (it carries its stage action too).
  assert.equal(document.querySelector("#nav-foot #nav"), null, "the nav is not in the foot");
  const navButton = document.createElement("button"); navButton.dataset.action = "app.shortcuts";
  document.getElementById("nav").append(navButton);
  let shortcuts = 0, quickOpens = 0;
  t.after(registerAction({ id: "app.quickOpenSouls", label: "Quick Open", run: () => quickOpens++ }));
  t.after(registerAction({ id: "app.shortcuts", label: "Keyboard shortcuts", run: () => shortcuts++ }));
  runInNewContext(wiring, { document, runAction });
  help.click();
  assert.equal(shortcuts, 1, "? runs app.shortcuts through the actual action registry");
  spawn.click();
  assert.deepEqual([shortcuts, quickOpens], [1, 1], "and New agent runs Quick Open through it");
  navButton.click();
  assert.equal(shortcuts, 1, "that wiring never adds a second dispatch to the nav's buttons");
  const css = read("renderer/shell.css");
  assert.doesNotMatch(css, /#sidebar-restore/);
  assert.match(css, /\.main-edge-control\[hidden\] \{ display: none; \}/);
  assert.match(css, /#tabstrip\.split-hidden \{ display: none; \}/,
    "the top strip disappears while the split renders per-group strips");
  assert.match(css, /\.group-cell \{[^}]*flex: 1 1 0/, "group cells share the host track");
});

// Spec B: the Show controls overlay the main area's top corners. Their room is reserved OUTSIDE every
// horizontal tab scrollport (a scroller clips its content at its padding box, so padding inside it
// would let scrolled tabs pass under a control): padding on the non-scrolling #tabbar-row, a margin
// on a group strip. (jsdom has no layout, so this pins the rules that give that geometry.)
test("Spec B: the Show controls' room sits outside every tab scrollport, so scrolled tabs never pass under them", () => {
  const css = read("renderer/shell.css");
  const rule = selector => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `shell.css has ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };
  const scrollers = { "#tabbar": rule("#tabbar"), ".group-tabbar": rule(".group-tabbar") };
  for (const [selector, body] of Object.entries(scrollers)) {
    assert.match(body, /overflow-x: auto/, `${selector} is a horizontal scrollport`);
    assert.doesNotMatch(body, /padding[^;]*main-(?:lead|trail)-inset/, `${selector} keeps the inset out of its scrolling content (no padding or scroll-padding)`);
  }
  assert.match(scrollers[".group-tabbar"], /margin-left: var\(--main-lead-inset\); margin-right: var\(--main-trail-inset\);/,
    "a group strip's scrollport is narrowed by a margin");
  const row = rule("#tabbar-row");
  assert.doesNotMatch(row, /overflow/, "the top strip's row does not scroll");
  assert.match(row, /padding-left: var\(--main-lead-inset\); padding-right: var\(--main-trail-inset\);/);
  // The cell paints the bar behind the margin: background and bottom rule still run edge to edge.
  assert.match(rule(".group-cell:has(> .group-tabbar)"), /linear-gradient\(var\(--border\), var\(--border\)\) 0 calc\(var\(--bar-h\) - 1px\) \/ 100% 1px no-repeat,\s*linear-gradient\(var\(--bg\), var\(--bg\)\) 0 0 \/ 100% var\(--bar-h\) no-repeat/);
  // Only the strips at the main area's top corners reserve it.
  assert.match(css, /#tabhost > \.group-cell ~ \.group-cell \{ --main-lead-inset: 0px; \}/, "lead: the first group only");
  assert.match(css, /#tabhost\.split-row > \.group-cell:has\(~ \.group-cell\), #tabhost\.split-col > \.group-cell ~ \.group-cell \{ --main-trail-inset: 0px; \}/,
    "trail: the last group side by side, the first stacked");
  assert.match(css, /#main:has\(> #show-sidebar:not\(\[hidden\]\)\) \{ --main-lead-inset: 40px; \}/);
  assert.match(css, /#main:has\(> #show-panel:not\(\[hidden\]\)\) \{ --main-trail-inset: 40px; \}/);
});
