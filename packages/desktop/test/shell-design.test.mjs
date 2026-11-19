// Supplied shell structure exercised with the shipped composition and inert
// DOM/API/module-loader fixtures. No Electron, browser, server or live mutations.
import test from "node:test";
import { viewContext } from "./helpers/view-context.mjs";
import { PIN_LABELS } from "../renderer/instance-pin-menu.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from './helpers/shell-window-globals.mjs';
import { JSDOM } from "jsdom";
import { createContextPanel, contextPanelCSS } from "../renderer/context-panel.mjs";
import { createInstanceGitPanel } from "../renderer/instance-git.mjs";
import { createInstanceTeamsSection } from '../renderer/instance-teams.mjs';
import { createInstanceSoulSection } from '../renderer/instance-soul.mjs';
import { THEMES } from "../renderer/theme.mjs";
import { NAV, NAV_TABS, PINNED, pinnedRowFor, navTab } from "../renderer/shell-nav.mjs";
import { shellIcon, mountShellIcons } from "../renderer/shell-icons.mjs";
import { createSidebarFoot } from "../renderer/sidebar-foot.mjs";
import { DESKTOP_NOUNS } from "../renderer/desktop-terms.mjs";
import { createSelectionOwnership } from "../renderer/selection-ownership.mjs";
import { createWorkspaceSwitcher } from "../renderer/workspace-switcher.mjs";
import { revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { createFocusRegions } from "../renderer/focus-regions.mjs";
import { rosterResponseOwns, rosterSignature } from "../renderer/instance-tree-view.mjs";
import { staleWorkspaceSelection } from "../renderer/views/common.mjs";
import { createPendingWatch, NOT_SERVED_CODE, NO_ANSWER_CODE } from "../renderer/deployment-header.mjs";
import { DEFAULT_KEYMAP, TERMINAL_ALLOWLIST, registerAction, runAction, listActions, getBinding, formatChord, setActiveContexts, matchEvent, handleKeydown, setBinding, resetBinding, onKeymapChange, paletteGroupDirection, paletteGroupHint } from "../renderer/keybindings.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
const fn = (name, src = source) => {
  const found = src.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `exercise shipped ${name}`);
  const firstLine = found[0].split("\n")[0];
  return firstLine.endsWith("}") ? firstLine : found[0];
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function domFixture(t) {
  // JSDOM defaults: scripts and resource loading disabled.
  const dom = new JSDOM(html, { url: "https://fixture.invalid" });
  t.after(() => dom.window.close());
  mountShellIcons(dom.window.document);
  const style = dom.window.document.createElement("style");
  style.textContent = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8") + contextPanelCSS;
  dom.window.document.head.append(style);
  return dom;
}
function shell(t, shellSource = source, { storage = {}, gitPanel } = {}) {
  const dom = domFixture(t), document = dom.window.document;
  // A machine's earlier preferences (the shell reads them while it builds).
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value);
  const loads = [], events = [], notices = [], offs = [];
  const c = {
    document, window: dom.window, localStorage: dom.window.localStorage,
    NAV, NAV_TABS, PINNED, pinnedRowFor, navTab, shellIcon, createSidebarFoot, DESKTOP_NOUNS, createContextPanel, createInstanceGitPanel: gitPanel ?? createInstanceGitPanel, createInstanceTeamsSection, createInstanceSoulSection, workspace: "A", generation: 0, events, notices,
    connectionGeneration: 0, subscribeConnections: () => () => {},
    connections: { close() {}, open: () => events.push(['connections']) }, lifecycleDialog: { close() {} },
    currentWorkspace: () => c.workspace, workspaceGeneration: () => c.generation,
    loadSpawn() { const gate = deferred(); loads.push(gate); return gate.promise; },
    ctx: { notify: text => notices.push(text) },
    showStage(name) { c.tabOpenIntents.invalidate(); events.push(["stage", name]); },
    showStageFocused: name => c.showStage(name), // the stage switch; its focus keeping is shell glue over focusRegion("main")
    registerAction(action) { const off = registerAction(action); offs.push(off); return off; }, runAction,
    // The palette action notes the leader's target as it opens (the instance entries act on it).
    palette: { toggle: () => events.push(["palette"]), isOpen: () => false }, leaderTargetId: () => null,
    // Instance: Pin to top / Unpin (instance-pin-menu.mjs): their real labels, offered for no target here.
    PIN_LABELS, pinTargetOffer: () => null, runPinCommand: async () => {},
    quickOpen: { toggle: () => events.push(["quickOpen"]) },
    shortcutsEditor: { close() {}, open: () => events.push(["shortcuts"]) },
    THEMES, setTheme: id => events.push(["theme", id]),
    toggleTheme: () => events.push(["theme"]), themePicker: { toggle: () => events.push(["themePicker"]) },
    fontPicker: { toggle: () => events.push(["fontPicker"]) },
    splitPane: orientation => events.push(["split", orientation]), closeSplit: () => events.push(["split", "close"]),
    sidebarWidth: { reset: () => events.push(["sidebarWidth", "reset"]) },
    fileOpener: { choose() {}, dispose() {} },
    getBinding, formatChord, paletteGroupDirection, paletteGroupHint, isMac: false, contextRosterEl: document.getElementById("instance-roster"),
    activeTrigger: null, activeTabTrigger: () => c.activeTrigger, revealInScrollport,
  };
  c.tabOpenIntents = createSelectionOwnership(c);
  const start = shellSource.indexOf('const navEl = document.getElementById("nav");');
  const end = shellSource.indexOf("// ── command palette", start);
  const navigation = shellSource.slice(start, end).replace('import("./views/spawn.mjs")', "loadSpawn()");
  const actionsStart = shellSource.indexOf('// ── action registry');
  const actionsEnd = shellSource.indexOf('// THE one window keydown listener', actionsStart);
  const registry = shellSource.slice(actionsStart, actionsEnd);
  const titleCode = shellSource.slice(shellSource.indexOf("const baseTitles ="), shellSource.indexOf("onKeymapChange(() => applyChordTitles"));
  const functions = ["setNavActive", "sidebarHidden", "setSidebarHidden", "updateSidebarControls", "toggleSidebar", "rosterEntry", "setRovingRow", "focusRoster", "focusFirstNeedingYou", "openShortcutsEditor", "openConnections", "stableFocusTarget"].map(name => fn(name, shellSource));
  // The foot (slice 1), as the shell builds it at its start: its words, and its count's activation.
  const foot = shellSource.match(/^const sidebarFoot = createSidebarFoot\([^\n]*\n/m)?.[0];
  assert.ok(foot, "exercise the shipped foot");
  const panelSetup = shellSource.slice(shellSource.indexOf("const contextPanel = createContextPanel"), shellSource.indexOf("/** Projection only:"));
  const s = runInNewContext(`${panelSetup}\n${navigation}\nconst SIDEBAR_HIDDEN_KEY = "oats-desktop-sidebar-hidden";\n${functions.join("\n")}\n${foot}${registry}\n${titleCode}\napplyChordTitles();\n({ openWorkspaceSouls, setNavActive, setSidebarHidden, applyChordTitles, contextPanel, sidebarFoot, paintAutomationsFailed });`, withShellWindowGlobals(c));
  offs.push(onKeymapChange(s.applyChordTitles));
  t.after(() => s.contextPanel.dispose());
  // Execute the production Show sidebar / Show instance panel bindings too.
  const reopen = shellSource.match(/^document\.getElementById\("show-(?:sidebar|panel)"\)\.addEventListener[^\n]+/gm);
  assert.equal(reopen?.length, 2, "both reopen controls are wired");
  for (const line of reopen) runInNewContext(line, c);
  t.after(() => { offs.forEach(off => off()); setActiveContexts(new Set()); });
  return { ...s, c, document, loads, events, notices,
    /** Paint roster rows as renderContextRoster does (one roving stop, on `stop`); returns the row buttons. */
    paintRows(stop = 1) {
      const list = document.querySelector("#instance-roster .ctx-list");
      list.innerHTML = ["a", "b", "c"].map((id, i) => `<div class="ctx-tree-row"><button type="button" class="ctx-inst" data-tree-instance="/h/${id}" tabindex="${i === stop ? 0 : -1}">${id}</button></div>`).join("");
      return [...list.querySelectorAll(".ctx-inst")];
    },
    switchTo(workspace) { c.workspace = workspace; c.generation++; },
    async settle(gate, outcome) {
      if (outcome === "resolve") gate.resolve({
        preselectWorkspaceTab: tab => events.push(["tab", tab]),
        preselectSoul() { assert.fail("chooser must not inspect or automatically pick a soul"); },
      });
      else gate.reject(new Error("fixture import failed"));
      await tick();
    },
  };
}

// The sidebar (the product owner, 2026-10-26; slice 1 of the Desktop UI rework), the list of workspaces on top: the head
// (the Workspace heading and Add local workspace…), the list, the pinned views, a line, the instances, then the foot.
test("the head is the Workspace heading and Add local workspace…; the list's semantics and ids survive", t => {
  const { document } = shell(t);
  const sidebar = document.getElementById("sidebar");
  const head = document.querySelector("#sidebar > .side-head");
  assert.equal(document.getElementById("ws-heading").parentElement, head);
  // The head is the list's heading and Add local workspace…; no Show only the current workspace (slice 1), no mark, no
  // trigger, no popup menu, no cog.
  assert.deepEqual([...head.children].map(el => el.id), ["ws-heading", "ws-add-open"]);
  assert.equal(document.getElementById("ws-current-only"), null, "no Show only the current workspace");
  assert.match(html, /<div class="side-head">\s*<span id="ws-heading" class="ws-heading">Workspace<\/span>\s*<button id="ws-add-open" class="ws-add-open side-icon-button icon-button"/, "the markup says the same");
  assert.equal(document.querySelector(".ws-head, .ctx-head.ws-head, .ws-brand-mark, .ws-brand-image, .ws-brand-icon, [data-shell-icon=\"oats\"]"), null, "no plain heading of 2026-10-23, no mark in the head");
  assert.equal(head.querySelector("img"), null, "the heading shows no artwork");
  assert.deepEqual([...sidebar.querySelectorAll("img")], [], "no artwork in the sidebar (slice 1: the mark left the foot)");
  assert.equal(document.getElementById("ws-trigger"), null, "the dropdown's trigger is gone");
  assert.equal(document.getElementById("ws-menu"), null, "the dropdown's menu is gone");
  assert.equal(document.getElementById("ws-menu-search"), null, "the menu's search is gone");
  assert.equal(document.getElementById("ws-heading").textContent, "Workspace");
  const addOpen = document.getElementById("ws-add-open");
  assert.equal(addOpen.tagName, "BUTTON"); assert.equal(addOpen.type, "button");
  assert.equal(addOpen.getAttribute("aria-label"), "Add local workspace…");
  assert.ok(addOpen.classList.contains("side-icon-button") && addOpen.classList.contains("icon-button"), "the head's icon button");
  // Top to bottom: the head, the list right under it, the views, the instances, then the foot (#482 UI spec: no
  // deployments block there); no current workspace's section around the views and the instances.
  assert.equal(document.getElementById("ws-deployments"), null);
  assert.equal(document.getElementById("ws-current"), null);
  assert.deepEqual([...sidebar.children].map(el => el.id || el.className), ["side-head", "ws-list", "nav", "instance-roster", "nav-foot"]);
  assert.match(html, /<\/section>\s*<nav id="nav" aria-label="Main views"><\/nav>\s*<section id="instance-roster" aria-label="Agents">/, "the markup says the same");
  const list = document.getElementById("ws-list");
  assert.equal(list.tagName, "SECTION");
  assert.equal(list.getAttribute("aria-labelledby"), "ws-heading");
  assert.equal(list.getAttribute("role"), null, "not a listbox: the sidebar's plain keys stay live on it");
  assert.ok(list.querySelector(":scope > #ws-options"));
  // The rules (the product owner, 2026-10-26): none under the head (the heading sits over its list), one under the
  // list, the line before the instances (the roster's top), none under the Instances heading, none of the views' own. JSDOM does not expand a border shorthand that uses var(), so read the
  // declarations of every shipped rule matching each element.
  const drawn = (el, side) => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
    .filter(rule => rule.selectorText && (() => { try { return el.matches(rule.selectorText); } catch { return false; } })())
    .flatMap(rule => rule.style.cssText.split(";").map(decl => decl.trim()).filter(Boolean).map(decl => `${rule.selectorText} { ${decl} }`))
    .filter(text => new RegExp(`border(-${side})?(-width|-style)?:`).test(text) && !/:\s*(0(px)?|none)\s*\}$/.test(text));
  assert.deepEqual(drawn(head, "top"), []);
  assert.deepEqual(drawn(head, "bottom"), [], "no line between the heading and its list");
  assert.deepEqual(drawn(list, "bottom"), [".ws-list { border-bottom: 1.5px solid var(--border) }"], "one rule under the list, a little bolder");
  assert.deepEqual(drawn(document.getElementById("instance-roster"), "top"), ["#instance-roster { border-top: 1px solid var(--border) }"], "the line before the instances");
  for (const side of ["top", "bottom"]) assert.deepEqual(drawn(document.getElementById("nav"), side), [], `no rule of the views' own (${side})`);
  const rosterHead = document.querySelector("#instance-roster > .ctx-head");
  assert.deepEqual(drawn(rosterHead, "bottom"), [], "no line under the Instances heading");
  assert.deepEqual([...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => /^#instance-roster > \.ctx-head::(?:after|before)$/.test(rule.selectorText || "")), [],
    "nor a drawn one (no ::after or ::before line)");
  assert.ok(drawn(document.getElementById("nav-foot"), "top").length, "the probe sees a rule where there is one (the footer's)");
  assert.match(source, /hasWorkspaceSwitcher: true/);
  const switcher = createWorkspaceSwitcher({ document, selectWorkspace() {}, discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}) });
  t.after(() => switcher.dispose());
  switcher.begin()({ id: "/fixture/A", name: "A" }, [{ id: "/fixture/A", name: "A" }, { id: "/fixture/B", name: "B" }]);
  // Always shown: the rows are drawn with no menu to open, the current one marked by aria-current and style alone.
  const rows = [...document.querySelectorAll("#ws-options .ws-option")];
  assert.deepEqual(rows.map(row => row.dataset.workspaceId), ["/fixture/A", "/fixture/B"]);
  assert.deepEqual(rows.map(row => row.getAttribute("aria-current")), ["true", null]);
  assert.deepEqual(rows.map(row => row.textContent), ["A", "B"], "no check or other mark beside the name");
  assert.ok(rows.every(row => row.tagName === "BUTTON" && row.getAttribute("role") === null), "a list of buttons");
  assert.deepEqual(rows.map(row => row.tabIndex), [0, -1], "one tab stop: the current row");
  assert.equal(list.getAttribute("aria-description"), "Current workspace: A", "its row's name, never its path");
  // Focusing the list lands on the current row; Down moves the focus, and the tab stop follows it.
  assert.equal(switcher.focusList(), true);
  assert.equal(document.activeElement, rows[0]);
  rows[0].dispatchEvent(new document.defaultView.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  assert.equal(document.activeElement, rows[1]);
  assert.deepEqual(rows.map(row => row.tabIndex), [-1, 0]);
});

test("only current destinations render, dispatch unchanged stage ids, and project aria-current", t => {
  const s = shell(t), buttons = [...s.document.querySelectorAll("#nav button")];
  // Home and Automations (the Desktop UI rework, slice 2): the Workspace page has no row of its own (Home opens it),
  // and Machines, the Deployments page of before, is the Workspace page's tab (NAV_TABS), not a nav item.
  assert.deepEqual(buttons.map(b => b.textContent), ["Home", "Automations"]);
  assert.deepEqual(buttons.map(b => b.dataset.action), ["stage.home", "stage.automations"]);
  assert.equal(s.document.querySelector('#nav [data-view="hierarchy"]'), null);
  assert.deepEqual(NAV_TABS.map(({ name, page, tab }) => ({ name, page, tab })), [{ name: "hierarchy", page: "spawn", tab: "machines" }]);
  for (const button of buttons) {
    assert.equal(button.type, "button"); assert.ok(button.title); assert.ok(button.querySelector("svg"));
    button.click(); assert.deepEqual(s.events.at(-1), ["stage", button.dataset.view]);
    s.setNavActive(button.dataset.view);
    assert.deepEqual(buttons.filter(b => b.hasAttribute("aria-current")), [button]);
    assert.deepEqual(buttons.filter(b => b.classList.contains("active")), [button]);
    assert.equal(button.getAttribute("aria-current"), "page");
  }
  s.setNavActive(null);
  assert.equal(s.document.querySelector("#nav [aria-current]"), null);
  assert.equal(s.document.querySelector("#nav .active"), null);
  assert.equal(getBinding("stage.spawn"), "Mod+2", "Workspace overview is a label change, not a chord change");
  assert.equal(getBinding("stage.automations"), "Mod+3");
  // stage.hierarchy keeps its chord and its registry entry, though it has no nav item of its own.
  assert.equal(getBinding("stage.hierarchy"), "Mod+1");
  assert.equal(listActions().find(action => action.id === "stage.hierarchy")?.label, "View: Workspace › Machines");
  runAction("stage.hierarchy"); assert.deepEqual(s.events.at(-1), ["stage", "hierarchy"]);
});

test("the nav sits under the list of workspaces, with no title: a column of items named by their labels", t => {
  const s = shell(t), q = id => s.document.getElementById(id), win = s.document.defaultView;
  const nav = q("nav");
  assert.equal(nav.parentElement, q("sidebar"));
  assert.equal(nav.previousElementSibling, q("ws-list")); assert.equal(nav.nextElementSibling, q("instance-roster"));
  assert.equal(nav.tagName, "NAV"); assert.equal(nav.getAttribute("aria-label"), "Main views");
  assert.equal(q("nav-title"), null, "no title over the views");
  assert.equal(s.document.querySelector(".nav-title"), null);
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.nav-title|#nav-title/, "no rule left for it");
  assert.doesNotMatch(html, /Workspace details/);
  assert.equal(win.getComputedStyle(nav).display, "flex");
  assert.equal(win.getComputedStyle(nav).flexDirection, "column", "one view under the other");
  for (const button of nav.querySelectorAll(".nav-item")) {
    // The label is in the DOM, the button's only text, so it is the accessible name.
    const label = button.querySelector(":scope > .label");
    assert.ok(label); assert.equal(label.textContent, button.textContent);
    assert.equal(label.getAttribute("aria-hidden"), null); assert.equal(button.getAttribute("aria-label"), null);
    assert.equal(button.querySelector(":scope > .icon svg").getAttribute("aria-hidden"), "true");
    assert.notEqual(win.getComputedStyle(label).position, "absolute", `${button.textContent}: the label is shown`);
  }
  // No container query hides the labels any more: the column has room for each.
  const navRule = css.match(/^#nav \{([^}]*)\}/m)?.[1] ?? "";
  assert.doesNotMatch(navRule, /container/);
  assert.doesNotMatch(css, /@container/);
});

test("static SVG inventory stays 16px, hidden to AT and rejects arbitrary markup or inherited keys", t => {
  const dom = domFixture(t), document = dom.window.document;
  for (const icon of document.querySelectorAll("svg")) {
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    assert.equal(icon.getAttribute("focusable"), "false");
    assert.equal(icon.getAttribute("height"), "16");
    if (icon.classList.contains("shell-icon")) assert.equal(icon.getAttribute("width"), "16");
    assert.equal(icon.querySelector("script, image, use, foreignObject, a"), null);
  }
  for (const name of ["<script>alert(1)</script>", "__proto__", "constructor", "https://example.test/icon.svg"]) {
    assert.throws(() => shellIcon(name), /Unknown shell icon/);
  }
});

test("the foot is one bar: N need you, New agent (Quick Open) and ? (Keyboard shortcuts); no mark, no toggle, no cog; all dispatch the real registry", async t => {
  const s = shell(t), q = id => s.document.getElementById(id);
  // The tools row is gone again (the product owner, 2026-10-26): no theme, shortcuts, leader or palette button
  // anywhere. Slice 1 of the Desktop UI rework: the brand mark, Hide sidebar and the settings cog leave the foot too
  // (Ctrl+Shift+B and the palette hide the sidebar; Theme…, Font… and Keyboard shortcuts… are the palette's).
  for (const id of ["sidebar-tools", "sidebar-theme", "sidebar-shortcuts", "sidebar-palette", "sidebar-toggle", "sidebar-settings", "sidebar-settings-menu"]) assert.equal(q(id), null, `${id} is gone`);
  assert.equal(s.document.querySelector("#sidebar .sidebar-brand, #sidebar img"), null, "no brand mark");
  assert.equal(s.document.querySelector('#sidebar [data-action="app.connections"], #sidebar [data-action="app.palette"], #sidebar [data-action="sidebar.toggle"]'), null);
  const foot = q("nav-foot");
  assert.deepEqual([...foot.children].map(el => el.id), ["sidebar-bar"], "the bar alone");
  assert.equal(foot, q("sidebar").lastElementChild, "the sidebar's bottom row");
  const bar = q("sidebar-bar");
  assert.equal(bar.getAttribute("role"), "group"); assert.equal(bar.getAttribute("aria-label"), "Sidebar tools");
  assert.deepEqual([...bar.children].map(el => el.id), ["sidebar-need-you", "sidebar-spawn", "sidebar-help"]);
  // N need you: hidden while nothing needs you (the shell paints it with the roster; sidebar-slice1.test.mjs).
  const need = q("sidebar-need-you");
  assert.equal(need.type, "button"); assert.equal(need.hidden, true); assert.equal(need.textContent, "");
  s.sidebarFoot.paint(2);
  assert.equal(need.hidden, false); assert.equal(need.textContent, "2 need you"); assert.equal(need.getAttribute("aria-label"), "2 agents need you. Go to the first");
  assert.equal(need.querySelector("svg.attn-mark")?.getAttribute("aria-hidden"), "true", "the needs-input mark, decoration beside the words");
  s.sidebarFoot.paint(0); assert.equal(need.hidden, true);
  // ?: Keyboard shortcuts (app.shortcuts), the sheet that exists today, its chord in its title.
  const help = q("sidebar-help");
  assert.equal(help.type, "button"); assert.equal(help.dataset.action, "app.shortcuts");
  assert.ok(help.classList.contains("side-icon-button") && help.classList.contains("icon-button"), "the sidebar's small icon button");
  assert.equal(help.getAttribute("aria-label"), "Keyboard shortcuts"); assert.equal(help.textContent.trim(), "?");
  assert.equal(help.title, "Keyboard shortcuts (Ctrl+,)", "the title is the label, then the bound chord");
  help.click(); assert.deepEqual(s.events, [["shortcuts"]], "it runs its action, once");
  // New agent: the spawn flow (app.quickOpenSouls, Quick Open), its noun DESKTOP_NOUNS's, the chord appended to its title.
  const spawn = q("sidebar-spawn");
  assert.equal(spawn.type, "button"); assert.equal(spawn.hidden, false); assert.equal(spawn.disabled, false); assert.ok(spawn.tabIndex >= 0);
  assert.equal(spawn.classList.contains("primary"), false, "its words, no primary fill");
  assert.equal(spawn.dataset.action, "app.quickOpenSouls");
  assert.equal(spawn.getAttribute("aria-label"), "New agent");
  assert.equal(spawn.title, "New agent (Alt+P)", "the title is the label, then the bound chord");
  assert.equal(spawn.textContent, "New agent");
  assert.equal(spawn.querySelector("svg")?.getAttribute("aria-hidden"), "true", "its + is decoration");
  assert.equal(spawn.querySelector(".shortcut-hint, [data-shortcut], kbd"), null, "no hint element: the chord is in the tooltip");
  assert.match(html, /<button id="sidebar-spawn" type="button" data-action="app\.quickOpenSouls"><\/button>/, "its words are the shell's, from desktop-terms.mjs");
  // The roster's heading (Agents: DESKTOP_NOUNS, slice 2): its title and the count only (no + : New agent is the foot's).
  const head = s.document.querySelector("#instance-roster > .ctx-head");
  assert.deepEqual([...head.children].map(el => el.id || el.className || el.textContent), ["Agents", "ctx-count"]);
  assert.match(source, /const rosterTitle = DESKTOP_NOUNS\.instances\[0\]\.toUpperCase\(\) \+ DESKTOP_NOUNS\.instances\.slice\(1\);\n  contextRosterEl\.setAttribute\("aria-label", rosterTitle\);/, "the shell names it from DESKTOP_NOUNS");
  assert.equal(head.querySelector("button"), null);
  assert.equal(getBinding('app.connections'), null, 'Connections does not invent a new global chord');
  assert.match(source, /label: "Settings: Connections…"/, "Connections stays in the palette");
  assert.ok(getBinding("app.palette"), "the palette keeps its chord");
  assert.deepEqual([getBinding("sidebar.toggle", true), getBinding("sidebar.toggle", false)], ["Mod+B", "Ctrl+Shift+B"], "Hide sidebar keeps its chord");
  assert.deepEqual([getBinding("app.quickOpenSouls", true), getBinding("app.quickOpenSouls", false)], ["Mod+P", "Alt+P"]);
  assert.equal(getBinding("app.chooseSoul", true), "Mod+N", "redesign shortcut chooses a soul, never launches one");
  assert.equal(getBinding("app.chooseSoul", false), "Ctrl+Shift+N", "Linux/Windows: Ctrl+Shift+N (spec F), Ctrl+N stays the program's");
  // A click opens Quick Open, once, and supersedes a pending open; it opens no chooser.
  const pending = s.c.tabOpenIntents.begin(); spawn.click();
  assert.equal(pending(), false, "a click supersedes a pending open");
  assert.deepEqual(s.events.slice(1), [["quickOpen"]], "one click, one Quick Open (after ?'s one)");
  assert.equal(s.loads.length, 0, "no chooser");
  // The chooser stays the registry's: app.chooseSoul, the palette's "Souls: choose a soul to spawn (Workspace › Souls)".
  const before = s.c.tabOpenIntents.begin(); runAction("app.chooseSoul");
  assert.equal(before(), false); assert.equal(s.loads.length, 1, "one run, one chooser");
  await s.settle(s.loads[0], "resolve");
  assert.deepEqual(s.events.slice(2), [["tab", "souls"], ["stage", "spawn"]]);
  assert.match(source, /label: "Souls: choose a soul to spawn \(Workspace › Souls\)", detail: chordDetail\("app.chooseSoul"\), run: \(\) => runAction\("app.chooseSoul"\)/);
});

test("a stored rebind's clash marks the foot's ? (Keyboard shortcuts), and clears", t => {
  const s = shell(t), help = s.document.getElementById("sidebar-help");
  let clashes = [];
  const mark = runInNewContext(`${fn("markShortcutClashes")}\nmarkShortcutClashes`, { ...s.c, keymapConflicts: () => clashes });
  mark();
  assert.equal(help.classList.contains("has-clash"), false); assert.equal(help.getAttribute("aria-description"), null);
  clashes = [{}];
  mark();
  assert.equal(help.classList.contains("has-clash"), true, "the clash dot");
  assert.equal(help.getAttribute("aria-description"), "1 shortcut you set clashes with another: open Keyboard shortcuts… to review");
  assert.deepEqual([...s.document.querySelectorAll(".has-clash")], [help], "nothing else is marked");
  clashes = [{}, {}];
  mark();
  assert.equal(help.getAttribute("aria-description"), "2 shortcuts you set clash with another: open Keyboard shortcuts… to review");
  clashes = [];
  mark();
  assert.equal(help.classList.contains("has-clash"), false); assert.equal(help.getAttribute("aria-description"), null, "cleared");
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  assert.match(css, /#sidebar-help\.has-clash::after \{[^}]*background: var\(--danger\);/, "a --danger dot, never yellow");
});

test("hide/show returns focus to visible controls and aria-expanded follows sidebar state", t => {
  const s = shell(t), q = id => s.document.getElementById(id), display = id => s.document.defaultView.getComputedStyle(q(id)).display;
  assert.equal(q("show-sidebar").hidden, true, "Show sidebar appears only while the sidebar is away");
  q("sidebar-help").focus(); runAction("sidebar.toggle");
  assert.equal(q("app").classList.contains("sidebar-hidden"), true);
  assert.equal(display("sidebar"), "none");
  assert.equal(s.document.activeElement, q("show-sidebar"), "hiding with focus inside moves focus to Show sidebar");
  assert.equal(q("show-sidebar").hidden, false);
  assert.equal(q("show-sidebar").getAttribute("aria-expanded"), "false");
  assert.equal(q("show-sidebar").getAttribute("aria-controls"), "sidebar");
  q("show-sidebar").click();
  assert.equal(q("app").classList.contains("sidebar-hidden"), false);
  assert.equal(display("sidebar"), "flex");
  assert.equal(q("show-sidebar").hidden, true);
  assert.equal(s.document.activeElement, q("sidebar-spawn"), "never <body>: the roster's way in (an empty roster: New agent)");
  const rows = s.paintRows(1);
  runAction("sidebar.toggle"); assert.equal(s.document.activeElement, q("show-sidebar"));
  q("show-sidebar").click(); assert.equal(s.document.activeElement, rows[1], "with rows: the roster's current row");
});

test("SVG split controls retain their names and context-gated registry wiring", t => {
  const s = shell(t);
  const start = source.indexOf('const tabActionsEl = document.getElementById("tab-actions");');
  const end = source.indexOf("function updateSplitControls()", start);
  runInNewContext(source.slice(start, end), s.c);
  const buttons = ["split-right", "split-down"].map(id => s.document.getElementById(id));
  setActiveContexts(new Set(["stage:spawn"]));
  buttons.forEach(b => b.click()); assert.deepEqual(s.events, [], "icons cannot bypass context gating");
  setActiveContexts(new Set(["tabs"]));
  buttons.forEach(b => {
    assert.ok(b.getAttribute("aria-label")); assert.ok(b.title); assert.ok(b.querySelector("svg.shell-icon")); b.click();
  });
  assert.deepEqual(s.events, [["split", "row"], ["split", "col"]]);
});

test("sidebar shortcuts keep Ctrl+B/F/N/P with the pty and dispatch Cmd+F/N on macOS", t => {
  shell(t);
  for (const key of ["b", "f", "n", "p"]) for (const isMac of [false, true]) {
    assert.equal(matchEvent({ key, ctrlKey: true }, { isMac, insideTerminal: true, editableTarget: false }), null);
  }
  for (const [key, action] of [["f", "sidebar.focusFilter"], ["n", "app.chooseSoul"]]) {
    assert.equal(matchEvent({ key, metaKey: true }, { isMac: true, insideTerminal: true }), action);
  }
  // Linux/Windows: "Focus the instance roster" is Alt+F (the default family) and "Spawn instance" Ctrl+Shift+N,
  // both inside the terminal and out, while plain Ctrl+F and Ctrl+N stay the program's.
  for (const key of ["f", "n"]) assert.equal(matchEvent({ key, ctrlKey: true }, { isMac: false, insideTerminal: false }), null);
  for (const insideTerminal of [false, true]) {
    assert.equal(matchEvent({ key: "f", altKey: true }, { isMac: false, insideTerminal }), "sidebar.focusFilter");
    assert.equal(matchEvent({ key: "N", ctrlKey: true, shiftKey: true }, { isMac: false, insideTerminal }), "app.chooseSoul");
  }
});

test("visible shortcut hints and tooltips follow rebind, unbind and platform without changing labels", t => {
  const s = shell(t); s.c.isMac = true; s.applyChordTitles();
  t.after(() => { resetBinding("sidebar.focusFilter"); resetBinding("app.chooseSoul"); });
  t.after(() => resetBinding("app.quickOpenSouls"));
  // No visible hint ships (the product owner, 2026-10-26): New agent's tooltip carries Quick Open's chord.
  assert.equal(s.document.querySelector("[data-shortcut], .shortcut-hint"), null, "no visible shortcut hint ships");
  const spawn = s.document.getElementById("sidebar-spawn");
  assert.equal(spawn.title, "New agent (⌘P)");
  setBinding("app.quickOpenSouls", "Mod+Shift+J"); assert.equal(spawn.title, "New agent (⇧⌘J)");
  setBinding("app.quickOpenSouls", null); assert.equal(spawn.title, "New agent");
  assert.equal(spawn.getAttribute("aria-label"), "New agent", "the name never carries the chord");
  resetBinding("app.quickOpenSouls"); assert.equal(spawn.title, "New agent (⌘P)");
  s.c.isMac = false; s.applyChordTitles(); assert.equal(spawn.title, "New agent (Alt+P)", "the platform's chord");
  // The roster filter's ⌘F hint went with the filter (still gone): the command keeps its chord with no control to
  // title (the palette and the shortcuts editor show it).
  assert.equal(s.document.querySelector(".ctx-filter, [data-shortcut=\"sidebar.focusFilter\"]"), null);
  assert.equal(s.document.querySelector('[data-action="sidebar.focusFilter"]'), null);
  assert.equal(getBinding("sidebar.focusFilter", true), "Mod+F");
});

for (const outcome of ["resolve", "reject"]) test(`Focus the instance roster reveals hidden sidebar and supersedes pending chooser ${outcome}`, async t => {
  const s = shell(t), rows = s.paintRows(1); runAction("app.chooseSoul");
  s.setSidebarHidden(true);
  assert.equal(s.document.getElementById("app").classList.contains("sidebar-hidden"), true);
  const intent = s.c.tabOpenIntents.begin();
  runAction("sidebar.focusFilter");
  assert.equal(intent(), false);
  assert.equal(s.document.getElementById("app").classList.contains("sidebar-hidden"), false);
  assert.equal(s.document.activeElement, rows[1], "the roster's current row");
  assert.equal(s.document.defaultView.getComputedStyle(s.document.getElementById("sidebar")).display, "flex", "the sidebar is shown");
  assert.equal(s.document.getElementById("show-sidebar").hidden, true, "Show sidebar is away while the sidebar is shown");
  await s.settle(s.loads[0], outcome);
  assert.deepEqual(s.events, []); assert.deepEqual(s.notices, []);
  assert.equal(s.document.activeElement, rows[1], "the stale chooser does not take focus back");
});

async function staleChooser(t, outcome, superseder, shellSource = source) {
  const s = shell(t, shellSource);
  runAction("app.chooseSoul"); const older = s.loads[0];
  if (superseder === "visit") { s.switchTo("B"); s.switchTo("A"); }
  if (superseder === "selection") s.c.tabOpenIntents.begin();
  if (superseder === "stage") s.document.querySelector('#nav [data-view="automations"]').click();
  if (superseder === "palette") { runAction("app.palette"); runAction("app.palette"); }
  if (superseder === "shortcuts") runAction("app.shortcuts");
  if (superseder === "modal") s.document.getElementById("ws-modal").hidden = false;
  if (superseder === "pagehide") s.document.defaultView.dispatchEvent(new s.document.defaultView.Event("pagehide"));
  if (superseder === "newer") {
    runAction("app.chooseSoul"); await s.settle(s.loads[1], "resolve");
  }
  const before = [...s.events]; await s.settle(older, outcome);
  assert.deepEqual(s.events, before, "stale chooser cannot preselect or navigate");
  assert.deepEqual(s.notices, [], "stale chooser cannot notify");
}
for (const outcome of ["resolve", "reject"]) {
  for (const superseder of ["visit", "selection", "stage", "palette", "shortcuts", "modal", "pagehide", "newer"]) {
    test(`chooser ${outcome} cannot reclaim ${superseder} ownership`, t => staleChooser(t, outcome, superseder));
  }
  test(`mutation: chooser must guard ${outcome}`, async t => {
    const block = fn("openWorkspaceSouls"), guard = outcome === "resolve"
      ? '  if (!owns()) return;\n  mod.preselectWorkspaceTab' : '    if (!owns()) return;\n    ctx.notify';
    assert.ok(block.includes(guard));
    const mutant = source.replace(block, block.replace(guard, guard.replace("if (!owns()) return;", "/* guard removed */")));
    await assert.rejects(staleChooser(t, outcome, "selection", mutant), /stale chooser/);
  });
}
test("current chooser import failure is reported, never navigates or launches", async t => {
  const s = shell(t); runAction("app.chooseSoul");
  await s.settle(s.loads[0], "reject");
  assert.deepEqual(s.notices, ["Could not open Workspace Souls: fixture import failed"]);
  assert.deepEqual(s.events, []);
});

for (const outcome of ["resolve", "reject"]) test(`reported workspace/root/host label survives stale ${outcome} across A→B→A`, async t => {
  const dom = domFixture(t), document = dom.window.document, requests = [];
  const c = {
    document, workspace: "A", contextRosterGen: 0,
    rosterState: null, rosterStale: false, contextDeploymentNote: null, ...viewContext(), rosterSignaturePainted: null, rosterSignature, rosterPendingWatch: createPendingWatch(), NOT_SERVED_CODE, NO_ANSWER_CODE, failRosterUnserved: assert.fail, contextInstances: [], tabs: new Map(), activeTab: null, connectionGeneration: 0,
    currentWorkspace: () => c.workspace, rosterResponseOwns, staleWorkspaceSelection,
    contextRosterEl: document.getElementById("instance-roster"),
    api(path) { const gate = { ...deferred(), path }; requests.push(gate); return gate.promise; },
    renderContextRoster() {}, refreshPanelInstance() {}, spawnJobs: { rows: () => [], announce: () => false, observe() {}, settling: () => false, check() {} }, // label-only polling fixture
    workspaceLabel: createWorkspaceSwitcher({ document, selectWorkspace() {}, discoverSuggestions: async () => [], addWorkspace: async () => ({}), pickWorkspace: async () => ({}) }),
  };
  const s = runInNewContext(`${fn("refreshContextRoster")}\n({ refreshContextRoster });`, withShellWindowGlobals(c));
  const old = s.refreshContextRoster();
  assert.equal(requests[0].path, "/api/panel?ws=A");
  c.workspace = "B"; c.contextRosterGen++; c.workspaceLabel.reset();
  c.workspace = "A"; c.contextRosterGen++;
  const fresh = s.refreshContextRoster();
  const workspace = { id: "A", name: 'same <b>name</b>', remote: true, server: 'host<&"' };
  const deployment = { id: 'remote:host:t', machine: 'host<&"', path: "/srv/agents", label: "~/agents", local: false, reachable: true, identityFrom: "reported", primary: true };
  requests[1].resolve({ workspace, workspaces: [workspace], deployments: [deployment], instances: [] }); await fresh;
  // The current row of the list carries the reported name (the dropdown's #ws-name is gone).
  const current = () => document.querySelector('#ws-options .ws-option[aria-current="true"]');
  const name = current().querySelector(".ws-option-name");
  const machines = () => c.contextDeployments.map(d => d.machine);
  assert.equal(name.textContent, 'same <b>name</b>', "the reported name as text, never markup"); assert.equal(name.children.length, 0);
  assert.deepEqual(machines(), ['host<&"'], "the reported deployments group the roster");
  if (outcome === "resolve") requests[0].resolve({ workspace: { ...workspace, name: "old name" }, workspaces: [{ ...workspace, name: "old name" }], deployments: [{ ...deployment, machine: "old-host" }], instances: [] });
  else requests[0].reject(new Error("stale failure"));
  await old;
  assert.equal(current().querySelector(".ws-option-name").textContent, 'same <b>name</b>'); assert.deepEqual(machines(), ['host<&"']);
  assert.equal(document.querySelectorAll("#ws-options .ws-option").length, 1, "the stale answer adds no row");
  assert.equal(document.querySelector(".ctx-list").textContent, "");
  assert.equal(document.getElementById("ws-list").getAttribute("aria-description"), "Current workspace: same <b>name</b>", "a remote id is never the description");
  assert.equal(current().title, 'same <b>name</b>', "the tooltip is the whole name: never a remote id or machine");
});

test('White, Solarized, Dark and This computer have explicit registry/palette choices without new default chords; the cycle keeps its label', t => {
  const s = shell(t);
  t.after(() => resetBinding('app.themePicker'));
  const cycleLabel = 'Cycle White / Solarized / Dark / This computer theme';
  assert.equal(listActions().find(action => action.id === 'app.themeToggle')?.label, cycleLabel, 'the cycle action stays as it is');
  // The palette's Theme: choose… opens the picker (app.themePicker; slice 1: the settings cog is gone); it shows the
  // effective chord, never a hard-coded one.
  assert.doesNotMatch(html, /data-action="app\.themePicker"/, 'no theme button in the markup');
  assert.equal(listActions().find(action => action.id === 'app.themePicker')?.label, 'Choose a theme…');
  const start = source.indexOf('// ── command palette');
  const end = source.indexOf('// ── Quick Open', start);
  const commands = runInNewContext(`${source.slice(start, end)}\npalette.commands`, {
    ...s.c, navigator: { platform: 'Linux' }, createPalette: options => options,
  });
  assert.equal(commands.find(item => item.label === 'Theme: choose…').detail(), 'Ctrl+Shift+Space', 'the bound chord');
  setBinding('app.themePicker', 'Ctrl+Alt+T');
  assert.deepEqual(THEMES.map(({ id, label }) => [id, label]), [['light', 'White'], ['solarized', 'Solarized'], ['dark', 'Dark'], ['host', 'This computer']]);
  for (const { id, label } of THEMES) {
    assert.equal(getBinding(`app.theme.${id}`), null, `${label} has no new default keyboard chord`);
    assert.equal(listActions().find(action => action.id === `app.theme.${id}`)?.label, `Theme: ${label}`);
    const command = commands.find(item => item.label === `Theme: ${label}`); assert.ok(command);
    assert.equal(command.detail(), ''); command.run(); assert.deepEqual(s.events.at(-1), ['theme', id]);
  }
  assert.equal(commands.filter(item => /^Theme: /.test(item.label)).at(-1).label, 'Theme: This computer', 'listed last');
  const cycle = commands.find(item => item.label === 'Theme: cycle White / Solarized / Dark / This computer'); assert.ok(cycle);
  cycle.run(); assert.deepEqual(s.events.at(-1), ['theme']);
  const choose = commands.filter(item => item.label === 'Theme: choose…');
  assert.equal(choose.length, 1, 'one palette entry opens the picker');
  assert.equal(choose[0].detail(), 'Ctrl+Alt+T', 'its hint is the effective chord');
  resetBinding('app.themePicker');
  assert.equal(choose[0].detail(), 'Ctrl+Shift+Space');
  choose[0].run(); assert.deepEqual(s.events.at(-1), ['themePicker']);
  assert.ok(commands.indexOf(choose[0]) < commands.indexOf(cycle), 'listed before the cycle');
  // The chord toggles the picker once; a held chord (key repeat) does nothing.
  const before = s.events.length;
  const chord = (repeat) => ({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  assert.equal(handleKeydown(chord(false), { isMac: false, insideTerminal: false }), true);
  assert.equal(handleKeydown(chord(true), { isMac: false, insideTerminal: false }), true, 'a repeat is still claimed');
  assert.deepEqual(s.events.slice(before), [['themePicker']]);
  assert.equal(commands.some(item => /light\/dark/i.test(item.label)), false);
});

test('Font: choose… opens the font picker from the palette, the shortcuts editor\'s Global group and a chord given there (app.fontPicker, no default)', t => {
  const s = shell(t);
  t.after(() => resetBinding('app.fontPicker'));
  const action = listActions().find(each => each.id === 'app.fontPicker');
  assert.equal(action?.label, 'Font: choose…');
  assert.equal(action.context, 'global', "in the theme rows' group of the shortcuts editor");
  assert.equal(listActions().find(each => each.id === 'app.themePicker')?.context, action.context);
  const start = source.indexOf('// ── command palette');
  const end = source.indexOf('// ── Quick Open', start);
  const commands = runInNewContext(`${source.slice(start, end)}\npalette.commands`, {
    ...s.c, navigator: { platform: 'Linux' }, createPalette: options => options,
  });
  const choose = commands.filter(item => item.label === 'Font: choose…');
  assert.equal(choose.length, 1, 'one palette entry opens the picker');
  assert.equal(choose[0].detail(), '', 'no default chord, so no hint');
  assert.equal(commands.indexOf(choose[0]), commands.findLastIndex(item => /^Theme: /.test(item.label)) + 1, 'right after the theme commands');
  setBinding('app.fontPicker', 'Ctrl+Alt+F12');
  assert.equal(choose[0].detail(), 'Ctrl+Alt+F12', 'a rebind follows');
  choose[0].run(); assert.deepEqual(s.events.at(-1), ['fontPicker']);
  // A chord given in the shortcuts editor toggles the picker once; a held chord (key repeat) does nothing.
  const before = s.events.length;
  const chord = (repeat) => ({ key: 'F12', code: 'F12', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  assert.equal(handleKeydown(chord(false), { isMac: false, insideTerminal: false }), true);
  assert.equal(handleKeydown(chord(true), { isMac: false, insideTerminal: false }), true, 'a repeat is still claimed');
  assert.deepEqual(s.events.slice(before), [['fontPicker']]);
  resetBinding('app.fontPicker');
  const space = { key: ' ', code: 'Space', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  assert.equal(handleKeydown(space, { isMac: false, insideTerminal: false }), false, 'the chord it once had is nobody\'s');
  assert.deepEqual(s.events.slice(before), [['fontPicker']]);
});

test('shell icons are the pinned Lucide set: 24-unit geometry, stroke 2, decorative, brand excluded', t => {
  const dom = domFixture(t), document = dom.window.document;
  for (const name of ['splitRight', 'splitDown', 'overview', 'workspace', 'schedules', 'close', 'branch']) {
    const span = document.createElement('span'); span.innerHTML = shellIcon(name); const svg = span.firstElementChild;
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24', name);
    assert.equal(svg.getAttribute('stroke-width'), '2', name);
    assert.equal(svg.getAttribute('aria-hidden'), 'true'); assert.equal(svg.getAttribute('focusable'), 'false');
    assert.ok(svg.children.length > 0, `${name} carries Lucide geometry`);
    assert.equal(svg.querySelector('script,foreignObject,[onload]'), null);
  }
  assert.throws(() => shellIcon('oats'), TypeError, 'the brand is artwork, not a shell icon');
});

test('the bottom summary bar is gone; the tab bar keeps only the two split buttons and panel.toggle stays on the registry', t => {
  const s = shell(t), q = id => s.document.getElementById(id), panel = s.contextPanel;
  assert.equal(q('context-panel').parentElement.id, 'workbench');
  // v4.1: no status bar under the editor groups (no Details, no Focus mode, no facts strip).
  for (const id of ['context-tools', 'context-status', 'focus-mode-toggle']) assert.equal(q(id), null, id);
  assert.equal(s.document.querySelector('#main > footer'), null);
  // Spec B: Show sidebar first and Show instance panel last, the Main region's tab order.
  assert.deepEqual([...q('main').children].map(el => el.id), ['show-sidebar', 'tabstrip', 'stagehost', 'tabhost', 'show-panel']);
  // Spec F: after the tabs, only split right and split down. Closing the split lives on its chord and the
  // palette; the instance panel on its chord, the palette, Show instance panel and its own close button.
  assert.deepEqual([...q('tab-actions').children].map(el => el.id || el.className), ['split-right', 'split-down']);
  for (const id of ['panel-toggle', 'split-close']) assert.equal(q(id), null, id);
  assert.equal(s.document.querySelector('.tab-actions-sep'), null);
  assert.doesNotMatch(source, /panel-toggle|split-close/, 'no wiring is left for the removed buttons');
  panel.setContext({ workspace: 'A', instance: { instance: 'selected', home: '/A/selected' }, key: 'exact:A:selected' });
  assert.equal(q('context-panel').hidden, true, 'selecting an instance never opens the panel');
  const before = s.c.tabOpenIntents.begin(); runAction('panel.toggle');
  assert.equal(before(), false, 'panel.toggle supersedes pending opens');
  assert.equal(q('context-panel').hidden, false);
  runAction('panel.toggle');
  assert.equal(q('context-panel').hidden, true);
  runAction('panel.toggle');
  // Focus mode: registry action (and palette, below) only. Focus leaving the hidden sidebar lands on the active tab.
  const trigger = s.document.createElement('button'); q('tabbar').append(trigger); s.c.activeTrigger = trigger;
  q('sidebar-help').focus();
  const pending = s.c.tabOpenIntents.begin(); runAction('app.focusMode');
  assert.equal(pending(), false); assert.equal(panel.isFocusMode(), true);
  assert.equal(q('context-panel').hidden, true);
  assert.equal(s.document.activeElement, trigger, 'hidden sidebar focus lands on the active tab');
  assert.equal(s.document.defaultView.getComputedStyle(q('sidebar')).display, 'none');
  assert.equal(q('show-sidebar').hidden, false, 'Show sidebar is the way back');
  runAction('app.focusMode');
  assert.equal(panel.isFocusMode(), false); assert.equal(q('context-panel').hidden, false);
});

test('Show sidebar is focus mode\'s visible exit; panel.toggle leaves it and shows the panel', t => {
  const s = shell(t), q = id => s.document.getElementById(id), panel = s.contextPanel;
  const shown = el => { for (let node = el; node; node = node.parentElement) {
    if (node.hidden || node.inert || s.document.defaultView.getComputedStyle(node).display === 'none') return false; } return true; };
  panel.setContext({ workspace: 'A', instance: { instance: 'selected', home: '/A/selected' }, key: 'exact:A:selected' });
  panel.setCollapsed(true);
  // A shown tab group whose active trigger is gone: the tab bar's actions are up, no trigger to land on.
  q('tabbar').append(s.document.createElement('span')); q('tab-actions').hidden = false;
  q('sidebar-help').focus(); runAction('app.focusMode'); assert.equal(panel.isFocusMode(), true);
  // No active trigger: focus leaving the hidden sidebar lands on a stable visible control, never <body>.
  assert.equal(s.document.activeElement, q('show-sidebar'), 'no active trigger: Show sidebar takes focus');
  assert.ok(shown(q('show-sidebar')), 'Show sidebar and its ancestors stay visible by shipped CSS');
  assert.equal(q('show-sidebar').getAttribute('aria-expanded'), 'false');
  assert.ok(shown(q('show-panel')), 'with something to show, Show instance panel is there in focus mode too');
  // panel.toggle (its chord, the palette, Show instance panel) leaves focus mode AND shows the panel, whatever its preference was.
  const pending = s.c.tabOpenIntents.begin(); runAction('panel.toggle');
  assert.equal(pending(), false); assert.equal(panel.isFocusMode(), false);
  assert.equal(q('context-panel').hidden, false); assert.equal(shown(q('show-panel')), false);
  assert.equal(q('app').classList.contains('focus-mode'), false);
  assert.ok(shown(q('sidebar')), 'the sidebar is back too'); assert.equal(q('show-sidebar').hidden, true);
  // On a stage (no terminal tab, no panel content) Show sidebar is the exit; Show instance panel is not shown.
  panel.setContext({ workspace: 'A' }); q('tab-actions').hidden = true;
  q('sidebar-help').focus(); runAction('app.focusMode'); assert.equal(panel.isFocusMode(), true);
  assert.equal(s.document.activeElement, q('show-sidebar'), 'on a stage focus lands on Show sidebar');
  assert.ok(shown(q('show-sidebar'))); assert.equal(shown(q('sidebar')), false); assert.equal(shown(q('show-panel')), false);
  q('show-sidebar').click();
  assert.equal(panel.isFocusMode(), false); assert.ok(shown(q('sidebar'))); assert.equal(shown(q('show-sidebar')), false);
  assert.equal(s.document.activeElement, q('sidebar-spawn'), "the roster's way in (an empty roster: New agent)");
});

test('focus fallback prefers a shown active tab, then the foot\'s ?, Show sidebar or Show instance panel; never <body>', t => {
  const s = shell(t), q = id => s.document.getElementById(id);
  const target = runInNewContext(`${fn('stableFocusTarget')}\nstableFocusTarget`, s.c);
  const trigger = s.document.createElement('button'); q('tabbar').append(trigger);
  s.c.activeTrigger = trigger; assert.equal(target(), trigger);
  trigger.hidden = true; assert.equal(target(), q('sidebar-help'), "hidden tab: the foot's ?");
  s.contextPanel.setContext({ workspace: 'A', instance: { instance: 'selected', home: '/A/selected' }, key: 'exact:A:selected' });
  q('tab-actions').hidden = false; assert.equal(target(), q('sidebar-help'), 'the split buttons are never a fallback');
  s.c.activeTrigger = null; s.contextPanel.setContext({ workspace: 'A' }); s.setSidebarHidden(true);
  assert.equal(target(), q('show-sidebar'), 'sidebar hidden: Show sidebar');
});

test('a focus-mode change made after focus was lost (the palette removed its input) lands on a visible control, never <body>', t => {
  const s = shell(t), q = id => s.document.getElementById(id);
  const trigger = s.document.createElement('button'); q('tabbar').append(trigger); s.c.activeTrigger = trigger;
  const input = s.document.createElement('input'); s.document.body.append(input); input.focus(); input.remove();
  assert.equal(s.document.activeElement, s.document.body, 'the picker is gone: focus is on <body>');
  runAction('app.focusMode'); assert.equal(s.contextPanel.isFocusMode(), true);
  assert.equal(s.document.activeElement, trigger, 'entering: the active tab');
  s.document.activeElement.blur(); assert.equal(s.document.activeElement, s.document.body);
  s.c.activeTrigger = null; runAction('app.focusMode'); assert.equal(s.contextPanel.isFocusMode(), false);
  assert.equal(s.document.activeElement, q('sidebar-help'), "leaving with no active tab: the foot's ?");
  s.document.activeElement.blur(); s.contextPanel.setContext({ workspace: 'A', key: 'terminal' });
  assert.equal(s.document.activeElement, s.document.body, 'a background projection never moves focus');
});

test('the palette keeps focus mode reachable without the bar and names the instance panel toggle with its chord', t => {
  const s = shell(t);
  const start = source.indexOf('// ── command palette');
  const end = source.indexOf('// ── Quick Open', start);
  const commands = runInNewContext(`${source.slice(start, end)}\npalette.commands`, {
    ...s.c, navigator: { platform: 'Linux' }, createPalette: options => options,
  });
  assert.equal(commands.some(item => /context panel/i.test(item.label)), false, 'the panel is the instance panel now');
  const panelCommand = commands.find(item => item.label === 'Instance panel: show / hide'); assert.ok(panelCommand);
  assert.equal(panelCommand.detail(), 'Ctrl+Shift+I');
  s.contextPanel.setContext({ workspace: 'A', instance: { instance: 'selected', home: '/A/selected' }, key: 'exact:A:selected' });
  assert.equal(s.document.getElementById('context-panel').hidden, true, 'closed until the user opens it');
  panelCommand.run(); assert.equal(s.document.getElementById('context-panel').hidden, false);
  const focusCommand = commands.find(item => item.label === 'Focus mode: toggle'); assert.ok(focusCommand);
  assert.equal(focusCommand.detail(), '', 'no default chord');
  focusCommand.run(); assert.equal(s.contextPanel.isFocusMode(), true);
  focusCommand.run(); assert.equal(s.contextPanel.isFocusMode(), false);
  // The resizable sidebar: its width goes back to its default from the palette too, through its action (no default chord).
  const resetWidth = commands.find(item => item.label === 'Sidebar: reset width'); assert.ok(resetWidth);
  assert.equal(getBinding('sidebar.resetWidth'), null, 'no default chord');
  assert.equal(resetWidth.detail(), '');
  assert.equal(listActions().find(action => action.id === 'sidebar.resetWidth')?.label, "Reset the sidebar's width");
  resetWidth.run(); assert.deepEqual(s.events.at(-1), ['sidebarWidth', 'reset']);
  assert.equal(commands.indexOf(resetWidth), commands.findIndex(item => item.label === 'Sidebar: toggle (hide/show)') + 1, 'listed after the toggle');
});

for (const hidden of [false, true]) test(`focus mode overrides but restores raw sidebar preference hidden=${hidden}`, t => {
  const s = shell(t), q = id => s.document.getElementById(id), key = 'oats-desktop-sidebar-hidden';
  s.setSidebarHidden(hidden); s.contextPanel.setContext({ workspace: 'A', key: 'terminal' });
  s.contextPanel.setCollapsed(true);
  const stored = s.c.localStorage.getItem(key);
  runAction('app.focusMode');
  assert.equal(q('app').classList.contains('sidebar-hidden'), hidden, 'temporary override never rewrites raw CSS preference');
  assert.equal(s.c.localStorage.getItem(key), stored);
  assert.equal(q('show-sidebar').getAttribute('aria-expanded'), 'false');
  assert.equal(q('show-sidebar').hidden, false, 'Show sidebar is focus mode\'s visible exit');
  runAction('app.focusMode');
  assert.equal(q('app').classList.contains('sidebar-hidden'), hidden);
  assert.equal(s.c.localStorage.getItem(key), hidden ? '1' : null);
  assert.equal(s.document.defaultView.getComputedStyle(q('sidebar')).display, hidden ? 'none' : 'flex');
  assert.equal(q('show-sidebar').hidden, !hidden);
  assert.equal(q('context-panel').hidden, true, 'focus override also preserves the closed panel');
  assert.equal(s.c.localStorage.getItem('oats-desktop-instance-panel-open'), null);
});

// ── Spec B: closed sidebars, one per-machine instance-panel preference, two Show controls.
const PANEL_OPEN_KEY = 'oats-desktop-instance-panel-open';
const terminalOf = (home, extra = {}) => ({ workspace: 'A', instance: { instance: home.split('/').pop(), agent: 'dev', agentsRoot: '/A/agents', home, ...extra }, key: home });

test('Spec B: selecting instances never opens the panel; open/closed is one per-machine preference that survives a new window', t => {
  const s = shell(t), q = id => s.document.getElementById(id), store = () => s.c.localStorage.getItem(PANEL_OPEN_KEY);
  s.contextPanel.setContext(terminalOf('/A/one'));
  assert.equal(q('context-panel').hidden, true, 'preference unset: an instance terminal opens closed');
  s.contextPanel.setContext(terminalOf('/A/two')); assert.equal(q('context-panel').hidden, true, 'another instance: still closed');
  assert.equal(store(), null);
  runAction('panel.toggle'); assert.equal(q('context-panel').hidden, false); assert.equal(store(), '1');
  s.contextPanel.setContext(terminalOf('/A/one')); assert.equal(q('context-panel').hidden, false, 'open follows every instance');
  q('context-panel').querySelector('.context-panel-collapse').click();
  assert.equal(q('context-panel').hidden, true, "the panel's close button"); assert.equal(store(), null, 'closed is the absent default');
  q('show-panel').click(); assert.equal(q('context-panel').hidden, false, 'Show instance panel'); assert.equal(store(), '1');
  // A new window on this machine reads the preference; an unset machine opens closed.
  const again = shell(t, source, { storage: { [PANEL_OPEN_KEY]: '1' } });
  again.contextPanel.setContext(terminalOf('/A/one'));
  assert.equal(again.document.getElementById('context-panel').hidden, false, 'open survives a re-created panel');
  const fresh = shell(t);
  fresh.contextPanel.setContext(terminalOf('/A/one'));
  assert.equal(fresh.document.getElementById('context-panel').hidden, true);
});

test('Spec B: a closed panel and a hidden sidebar take no width and leave no rail or edge, side by side and stacked', t => {
  const s = shell(t), q = id => s.document.getElementById(id), css = readFileSync(new URL('../renderer/shell.css', import.meta.url), 'utf8');
  const style = el => s.document.defaultView.getComputedStyle(el);
  s.contextPanel.setContext(terminalOf('/A/one')); s.setSidebarHidden(true);
  assert.equal(style(q('sidebar')).display, 'none'); assert.equal(style(q('context-panel')).display, 'none');
  assert.equal(s.document.querySelector('#sidebar-restore, .context-panel-rail, [data-context-rail], .context-panel-expand'), null, 'no strip, rail or edge');
  for (const id of ['show-sidebar', 'show-panel']) {
    assert.equal(q(id).parentElement.id, 'main', `${id} sits in the main area`); assert.equal(style(q(id)).position, 'absolute', `${id} overlays the top bar`);
  }
  // Stacked (the narrow layout): nothing there gives the panel back a rail or overrides its hidden rule.
  const narrow = css.slice(css.indexOf('@media (max-width: 1000px)'), css.indexOf('}\n}', css.indexOf('@media (max-width: 1000px)')));
  assert.doesNotMatch(narrow, /rail|is-collapsed|sidebar-restore/);
  assert.match(contextPanelCSS, /#context-panel\.context-panel\[hidden\][^{]*\{ display:none !important; \}/, 'hidden wins in every layout');
});

test('Spec B: Show instance panel appears only while the panel is closed with something to show, and opens it into its selected tab', t => {
  const s = shell(t), q = id => s.document.getElementById(id), show = q('show-panel');
  assert.equal(show.hidden, true, 'nothing to show: no control');
  assert.equal(show.dataset.action, 'panel.toggle'); assert.equal(show.getAttribute('aria-controls'), 'context-panel');
  assert.equal(show.getAttribute('aria-expanded'), 'false');
  s.contextPanel.setContext(terminalOf('/A/one'));
  assert.equal(show.hidden, false, 'closed with an instance terminal: shown');
  assert.equal(show.getAttribute('aria-label'), 'Show instance panel'); assert.match(show.title, /^Show instance panel/);
  show.focus(); show.click();
  assert.equal(q('context-panel').hidden, false); assert.equal(show.hidden, true, 'open: the control goes away');
  const selected = q('context-panel').querySelector('[data-context-tab][aria-selected="true"]');
  assert.ok(selected); assert.equal(s.document.activeElement, selected, "opening by its control focuses the panel's selected tab");
  // Closing with focus inside: focus goes to Show instance panel, back in its place.
  q('context-panel').querySelector('.context-panel-collapse').focus(); runAction('panel.toggle');
  assert.equal(q('context-panel').hidden, true); assert.equal(show.hidden, false);
  assert.equal(s.document.activeElement, show, 'closing with focus inside lands on Show instance panel');
  // Its chord pressed while it has focus: the control hides, focus follows into the panel, never <body>.
  runAction('panel.toggle');
  assert.equal(show.hidden, true); assert.equal(s.document.activeElement, q('context-panel').querySelector('[data-context-tab][aria-selected="true"]'));
  // Back on a stage with no panel content: no control.
  runAction('panel.toggle'); s.contextPanel.setContext({ workspace: 'A' }); assert.equal(show.hidden, true);
});

test('Spec B: a chord pressed elsewhere opens or closes the panel without taking focus', t => {
  const s = shell(t), q = id => s.document.getElementById(id);
  const terminal = s.document.createElement('textarea'); q('tabhost').append(terminal);
  s.contextPanel.setContext(terminalOf('/A/one')); terminal.focus();
  runAction('panel.toggle'); assert.equal(q('context-panel').hidden, false); assert.equal(s.document.activeElement, terminal);
  runAction('panel.toggle'); assert.equal(q('context-panel').hidden, true); assert.equal(s.document.activeElement, terminal);
  runAction('sidebar.toggle'); assert.equal(q('app').classList.contains('sidebar-hidden'), true); assert.equal(s.document.activeElement, terminal);
  runAction('sidebar.toggle'); assert.equal(s.document.activeElement, terminal);
});

test('Spec B: Show instance panel carries the Developer change dot and says so in its name', t => {
  let hooks = null;
  const s = shell(t, source, { gitPanel: (_parent, focus) => { hooks = focus; return { update() {}, dispose() {} }; } });
  const show = s.document.getElementById('show-panel'), dot = show.querySelector('.main-edge-dot');
  const selected = terminalOf('/A/one'); s.contextPanel.setContext(selected);
  const identity = JSON.stringify(['A', selected.key, selected.instance.home, 'dev', '/A/agents', null, null]);
  assert.equal(dot.hidden, true); assert.equal(dot.getAttribute('aria-hidden'), 'true');
  hooks.onObservation({ identity, connection: 0, changed: true });
  assert.equal(dot.hidden, false); assert.equal(s.contextPanel.state().changes, true);
  assert.equal(show.getAttribute('aria-label'), 'Show instance panel, Developer has changes');
  assert.match(show.title, /^Show instance panel, Developer has changes/, 'the tooltip says it too, with the live chord');
  hooks.onObservation({ identity, connection: 0, changed: false });
  assert.equal(dot.hidden, true); assert.equal(show.getAttribute('aria-label'), 'Show instance panel');
  hooks.onObservation({ identity: JSON.stringify(['A', '/A/two']), connection: 0, changed: true });
  assert.equal(dot.hidden, true, "another instance's read marks nothing");
});

// Lead's ruling: a deliberate exception to point 5 ("hiding the sidebar with focus in it moves focus
// to Show sidebar"). Entering focus mode says "work in the content", so focus goes to the active tab.
test('Spec B exception to point 5: entering focus mode from the sidebar focuses the active tab, not Show sidebar; sidebar.toggle still does', t => {
  const s = shell(t), q = id => s.document.getElementById(id);
  const trigger = s.document.createElement('button'); q('tabbar').append(trigger); s.c.activeTrigger = trigger;
  q('sidebar-help').focus(); runAction('app.focusMode');
  assert.equal(s.contextPanel.isFocusMode(), true); assert.equal(q('show-sidebar').hidden, false);
  assert.equal(s.document.activeElement, trigger, 'focus mode: the active tab, the content it is for');
  runAction('app.focusMode'); q('sidebar-help').focus(); runAction('sidebar.toggle');
  assert.equal(s.document.activeElement, q('show-sidebar'), 'plain sidebar.toggle: Show sidebar');
});

test('Spec B: the soul inspector keeps opening on soul selection, whatever the instance preference', t => {
  const s = shell(t), q = id => s.document.getElementById(id), owner = {};
  const inspector = s.document.createElement('section'); inspector.append(s.document.createElement('header'));
  s.contextPanel.setContext({ workspace: 'A' }); // the Workspace stage of workspace A, before a soul is selected
  const lease = s.contextPanel.attach(owner, inspector);
  s.contextPanel.setContext({ workspace: 'A', owner }); lease.setPresent(true);
  assert.equal(q('context-panel').hidden, false, 'a selected soul shows its inspector'); assert.equal(lease.isVisible(), true);
  assert.equal(q('show-panel').hidden, true);
  assert.equal(s.c.localStorage.getItem(PANEL_OPEN_KEY), null, 'the instance preference is untouched');
  s.contextPanel.setContext(terminalOf('/A/one')); assert.equal(q('context-panel').hidden, true, 'an instance terminal still opens closed');
});

test('focusRoster exits focus mode, reveals the sidebar and focuses the roster\'s current row through the registered command', t => {
  const s = shell(t), q = id => s.document.getElementById(id), rows = s.paintRows(2);
  s.setSidebarHidden(true); runAction('app.focusMode');
  assert.equal(s.contextPanel.isFocusMode(), true);
  const pending = s.c.tabOpenIntents.begin(); runAction('sidebar.focusFilter');
  assert.equal(pending(), false); assert.equal(s.contextPanel.isFocusMode(), false);
  assert.equal(q('app').classList.contains('sidebar-hidden'), false);
  assert.equal(s.c.localStorage.getItem('oats-desktop-sidebar-hidden'), null);
  assert.equal(s.document.defaultView.getComputedStyle(q('sidebar')).display, 'flex', 'the sidebar is shown');
  assert.equal(q('show-sidebar').hidden, true);
  assert.equal(s.document.activeElement, rows[2], 'the roving stop');
  assert.equal(rows.filter(r => r.tabIndex === 0).length, 1, 'still one stop');
  assert.equal(listActions().find(a => a.id === 'sidebar.focusFilter')?.label, 'Focus the instance roster', 'same id, relabelled');
});

test('focusRoster without a roving stop lands on the first row, else Retry, else the foot\'s New agent, else (no roster) the workspace list: never nothing', t => {
  const s = shell(t), q = id => s.document.getElementById(id), list = s.document.querySelector('#instance-roster .ctx-list');
  const rows = s.paintRows(-1);
  q('sidebar-spawn').focus(); runAction('sidebar.focusFilter');
  assert.equal(s.document.activeElement, rows[0], 'the first row');
  assert.equal(rows[0].tabIndex, 0, 'and it becomes the stop');
  list.innerHTML = '<div class="loading-failed"><button type="button" class="act">Retry</button></div>';
  q('sidebar-spawn').focus(); runAction('sidebar.focusFilter');
  assert.equal(s.document.activeElement.textContent, 'Retry', 'a failed first read: its Retry, never the foot\'s New agent before it');
  // A stale notice's Retry sits between the heading and the list (instance-tree-view.mjs createRosterLoading).
  list.innerHTML = '<div class="ctx-empty">No instances.</div>';
  const notice = s.document.createElement('div'); notice.className = 'ctx-status'; notice.innerHTML = '<button type="button" class="act">Retry</button>';
  list.before(notice);
  q('sidebar-spawn').focus(); runAction('sidebar.focusFilter');
  assert.equal(s.document.activeElement, notice.firstElementChild, "a stale notice's Retry");
  notice.remove();
  // No instances: the roster's one action, the foot's New agent (as F6's: see the next test), never the workspaces.
  list.innerHTML = '<div class="ctx-empty">No instances.</div>';
  q('ws-options').innerHTML = '<ul class="ws-group"><li class="ws-option-row"><button type="button" class="ws-option" aria-current="true" tabindex="0">A</button></li></ul>';
  q('ws-add-open').focus(); runAction('sidebar.focusFilter');
  assert.equal(s.document.activeElement, q('sidebar-spawn'), 'an empty roster: the foot\'s New agent');
  // A window with no workspace hides the roster: the list of workspaces' stop.
  q('instance-roster').hidden = true;
  q('sidebar-spawn').blur(); runAction('sidebar.focusFilter');
  assert.equal(s.document.activeElement, q('ws-options').querySelector('.ws-option'), 'no roster: the list of workspaces\' stop');
  q('ws-options').innerHTML = '';
  s.document.body.focus(); runAction('sidebar.focusFilter');
  assert.equal(s.document.activeElement, q('ws-add-open'), 'and with no workspace row: Add local workspace…');
});

// One rule for an empty roster (the product owner): its keyboard way in is its one action, the foot's New agent, by
// F6 (the region cycle needs a stop inside the roster) and by ⌘F / Alt+F alike; a failed read's Retry comes first.
test('an empty roster: F6 and ⌘F / Alt+F (sidebar.focusFilter) both land on the foot\'s New agent, a Retry before it', t => {
  const s = shell(t), q = id => s.document.getElementById(id), list = s.document.querySelector('#instance-roster .ctx-list');
  const regions = createFocusRegions({ doc: s.document });
  s.document.getElementById('nav').innerHTML = '<button type="button" class="nav-item" aria-current="page">Workspace overview</button>';
  q('ws-options').innerHTML = '<ul class="ws-group"><li class="ws-option-row"><button type="button" class="ws-option" aria-current="true" tabindex="0">A</button></li></ul>';
  list.innerHTML = '<div class="ctx-empty">No instances.</div>';
  const ways = {
    F6: () => { s.document.querySelector('#nav button').focus(); regions.cycle(1); },
    'sidebar.focusFilter': () => { q('ws-add-open').focus(); runAction('sidebar.focusFilter'); },
  };
  for (const [name, go] of Object.entries(ways)) { go(); assert.equal(s.document.activeElement, q('sidebar-spawn'), `${name}: New agent`); }
  list.innerHTML = '<div class="loading-failed"><button type="button" class="act">Retry</button></div>';
  for (const [name, go] of Object.entries(ways)) { go(); assert.equal(s.document.activeElement, list.querySelector('.act'), `${name}: a failed read's Retry first`); }
});

test('panel.toggle defaults to ⌘I / Ctrl+Shift+I (no conflict) and fires in a terminal; focus mode has no default and does not', t => {
  shell(t);
  assert.deepEqual(DEFAULT_KEYMAP['panel.toggle'], { mac: 'Mod+I', other: 'Ctrl+Shift+I' });
  assert.equal(getBinding('panel.toggle', true), 'Mod+I'); assert.equal(getBinding('panel.toggle', false), 'Ctrl+Shift+I');
  for (const isMac of [true, false]) {
    const chord = getBinding('panel.toggle', isMac);
    assert.deepEqual(listActions().filter(a => a.id !== 'panel.toggle' && getBinding(a.id, isMac) === chord).map(a => a.id), [], `mac=${isMac}: ${chord} is the panel's alone`);
  }
  assert.equal(TERMINAL_ALLOWLIST.includes('panel.toggle'), true);
  // Linux/Windows: Ctrl+Shift+I (e.key "I") inside the terminal and out; plain Ctrl+I (Tab) is the program's everywhere.
  for (const insideTerminal of [false, true]) {
    assert.equal(matchEvent({ key: 'I', ctrlKey: true, shiftKey: true }, { isMac: false, insideTerminal }), 'panel.toggle');
    assert.equal(matchEvent({ key: 'i', ctrlKey: true }, { isMac: false, insideTerminal }), null, 'Ctrl+I (Tab) stays with the program');
  }
  assert.equal(matchEvent({ key: 'i', metaKey: true }, { isMac: true, insideTerminal: true }), 'panel.toggle');
  assert.equal(matchEvent({ key: 'i', metaKey: true, altKey: true }, { isMac: true, insideTerminal: false }), null, '⌥⌘I (the dev tools) is not this action');
  assert.equal(DEFAULT_KEYMAP['app.focusMode'], undefined); assert.equal(getBinding('app.focusMode'), null);
  // A rebind keeps each action's terminal policy (by id): the panel's fires in a Linux terminal, focus mode's does not.
  for (const [id, key, inLinuxTerminal] of [['panel.toggle', 'j', 'panel.toggle'], ['app.focusMode', 'u', null]]) {
    assert.equal(TERMINAL_ALLOWLIST.includes(id), inLinuxTerminal !== null);
    t.after(() => resetBinding(id)); setBinding(id, `Mod+${key.toUpperCase()}`);
    assert.equal(matchEvent({ key, ctrlKey: true }, { isMac: false, insideTerminal: true }), inLinuxTerminal);
    assert.equal(matchEvent({ key, ctrlKey: true }, { isMac: false, insideTerminal: false }), id);
    assert.equal(matchEvent({ key, metaKey: true }, { isMac: true, insideTerminal: true }), id);
  }
});

test('the shell sends no workspace-scoped request while its window chooses (Quick Open, a view refreshing on its way out)', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const { scopedRequest } = await import('../renderer/workspace-routes.mjs');
  const { httpError } = await import('../renderer/views/common.mjs');
  const shellSource = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
  const fnSource = shellSource.match(/async function api\(pathname, opts\)[^]*?\n\}/)[0];
  for (const state of ['choosing', 'bound']) {
    const sent = [];
    const api = runInNewContext(`(${fnSource})`, { windowState: () => state, scopedRequest, httpError, Object, Error,
      desk: { api: async (path) => { sent.push(path); return { ok: true, status: 200, body: {} }; } } });
    for (const path of ['/api/agents', '/api/panel?ws=x', '/api/instance-git']) {
      if (state === 'choosing') await assert.rejects(api(path), (e) => e.code === 'E_NO_WORKSPACE', path);
      else await api(path);
    }
    await api('/api/cli');
    assert.deepEqual(sent, state === 'choosing' ? ['/api/cli'] : ['/api/agents', '/api/panel?ws=x', '/api/instance-git', '/api/cli'], state);
  }
});
