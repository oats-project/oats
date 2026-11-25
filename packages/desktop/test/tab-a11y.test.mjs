import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createTabChrome, tabKeyAction, focusAfterLastTab } from "../renderer/tab-a11y.mjs";
import { groupOfTab } from "../renderer/split-layout.mjs";

test("tab chrome uses related semantic tab, panel, and focusable close controls", () => {
  const dom = new JSDOM("<!doctype html><body>");
  const { tabEl, triggerEl, closeEl, paneEl } = createTabChrome(dom.window.document, 7, "Agent terminal", true);
  assert.equal(tabEl.getAttribute("role"), "presentation");
  assert.equal(triggerEl.tagName, "BUTTON");
  assert.equal(triggerEl.getAttribute("role"), "tab");
  assert.equal(triggerEl.getAttribute("aria-selected"), "false");
  assert.equal(triggerEl.tabIndex, -1);
  assert.equal(triggerEl.title, "Agent terminal");
  assert.equal(triggerEl.getAttribute("aria-label"), "Agent terminal");
  assert.equal(triggerEl.getAttribute("aria-controls"), paneEl.id);
  assert.equal(paneEl.getAttribute("role"), "tabpanel");
  assert.equal(paneEl.getAttribute("aria-labelledby"), triggerEl.id);
  assert.equal(paneEl.hidden, true);
  assert.equal(closeEl.tagName, "BUTTON");
  assert.equal(closeEl.getAttribute("aria-label"), "Close Agent terminal");
  assert.equal(closeEl.title, "Close Agent terminal (Delete or ⌘W)");
  // Linux/Windows name the keymap's close chord, never the plain Ctrl+W a terminal program reads.
  assert.equal(createTabChrome(dom.window.document, 2, "Agent terminal", false).closeEl.title, "Close Agent terminal (Delete or Alt+W)");
  dom.window.close();
});

test("tab keyboard policy wraps arrows, supports Home/End, and closes", () => {
  const action = (key, index = 1, mods = {}) => tabKeyAction({ key, ...mods }, index, 3);
  assert.deepEqual(action("ArrowRight", 2), { type: "move", index: 0 });
  assert.deepEqual(action("ArrowLeft", 0), { type: "move", index: 2 });
  assert.deepEqual(action("Home"), { type: "move", index: 0 });
  assert.deepEqual(action("End"), { type: "move", index: 2 });
  assert.deepEqual(action("Delete"), { type: "close" });
  // The close chord belongs to the keymap (tabs.close: ⌘W / Alt+W, rebindable), not the strip.
  assert.equal(action("w", 1, { metaKey: true }), null);
  assert.equal(action("w", 1, { ctrlKey: true }), null);
  assert.equal(action("Enter"), null, "native button activation handles Enter/Space");
});

test("closing the last terminal/artifact moves focus to a stable logical entry", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="removed">tab being closed</button>
    <div class="ctx-list"><div class="ctx-tree-row"><button id="instances" class="ctx-inst" tabindex="0">dev-1</button></div></div>
    <button id="stage">Soul roster</button>
    <div id="nav-foot"><div id="sidebar-bar" role="group" aria-label="Sidebar tools"><span class="sidebar-brand" aria-hidden="true"></span><button id="sidebar-spawn" type="button" data-action="app.quickOpenSouls">Spawn instance</button></div></div>
  </body>`);
  const doc = dom.window.document;
  const removed = doc.getElementById("removed");
  removed.focus();
  removed.remove();
  assert.equal(doc.activeElement, doc.body, "browser loses focus when selected tab is removed");
  // The shell's entry for a terminal: the roster's current row (rosterEntry).
  assert.equal(focusAfterLastTab("terminal", { instancesEntry: doc.getElementById("instances") }), true);
  assert.equal(doc.activeElement.id, "instances");
  assert.equal(focusAfterLastTab("terminal", { instancesEntry: null }), false, "no entry: nothing moves");
  // An empty roster's entry is its one action, New agent at the roster's end (rosterEntry, the product owner, 2026-10-26).
  doc.activeElement.blur();
  assert.equal(focusAfterLastTab("terminal", { instancesEntry: doc.getElementById("sidebar-spawn") }), true);
  assert.equal(doc.activeElement.id, "sidebar-spawn");
  doc.getElementById("instances").focus();

  doc.activeElement.remove();
  assert.equal(focusAfterLastTab("artifact", { stageEntry: doc.getElementById("stage") }), true);
  assert.equal(doc.activeElement.id, "stage");
  dom.window.close();
});

test("local tab navigation reserves only unmodified arrows/Home/End", () => {
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    for (let mask = 1; mask < 16; mask++) {
      const event = { key, ctrlKey: !!(mask & 1), altKey: !!(mask & 2), metaKey: !!(mask & 4), shiftKey: !!(mask & 8) };
      assert.equal(tabKeyAction(event, 1, 3), null, `${key} with modifier mask ${mask}`);
    }
    assert.equal(tabKeyAction({ key, defaultPrevented: true }, 1, 3), null, "do not double-handle consumed keys");
  }
});

test("capped tab labels retain their complete title and ARIA identity as literal data", t => {
  const dom = new JSDOM("<!doctype html><body>");
  t.after(() => dom.window.close());
  const title = '⌗ A-reviewer-with-a-very-long-name "><img src=x onerror=bad()> & peer';
  const { tabEl, triggerEl, closeEl } = createTabChrome(dom.window.document, 9, title);
  assert.equal(triggerEl.textContent, title);
  assert.equal(triggerEl.title, title);
  assert.equal(triggerEl.getAttribute("aria-label"), title);
  assert.equal(closeEl.getAttribute("aria-label"), `Close ${title}`);
  assert.equal(tabEl.querySelector("img, [onerror]"), null, "identity is assigned, never interpolated into markup");
});

for (const grouped of [false, true]) test(`${grouped ? "grouped" : "flat"} tab keyboard navigation reveals focused controls without stealing pane focus`, t => {
  const dom = new JSDOM('<!doctype html><body><input id="stable"><div id="first"></div><div id="second"></div></body>');
  t.after(() => dom.window.close());
  const doc = dom.window.document, reveals = [];
  const first = doc.getElementById("first"), second = doc.getElementById("second");
  first.className = second.className = grouped ? "group-tabbar" : "";
  first.setAttribute("role", "tablist");
  second.setAttribute("role", "tablist");
  const tabs = new Map();
  for (let id = 1; id <= 5; id++) {
    const tab = createTabChrome(doc, id, `⌗ A-reviewer-${id}`);
    tab.kind = "terminal";
    tab.tabEl.hidden = id === 5; // a foreign workspace, excluded from flat navigation
    tabs.set(id, tab);
    (grouped && id === 4 ? second : first).append(tab.tabEl);
    doc.body.append(tab.paneEl);
  }
  // Geometry stand-in (jsdom has no layout): 200px strips of 120px tabs, the trigger over a
  // tab's first 90px and Close over 95–115. Only a strip's scrollLeft may move (spec F).
  dom.window.HTMLElement.prototype.scrollIntoView = () => assert.fail("must not scroll ancestors");
  for (const strip of [first, second]) {
    Object.defineProperties(strip, { clientWidth: { value: 200, configurable: true }, clientLeft: { value: 0 } });
    strip.getBoundingClientRect = () => ({ left: 0, right: 200, width: 200 });
  }
  const box = (control, from, to) => {
    const tab = control.closest(".tab"), strip = tab.parentElement;
    const start = [...strip.children].filter(el => !el.hidden).indexOf(tab) * 120 - strip.scrollLeft;
    return { left: start + from, right: start + to, width: to - from };
  };
  for (const tab of tabs.values()) {
    tab.triggerEl.getBoundingClientRect = () => box(tab.triggerEl, 0, 90);
    tab.closeEl.getBoundingClientRect = () => box(tab.closeEl, 95, 115);
  }
  const shown = control => { const r = control.getBoundingClientRect(); return r.left >= 0 && r.right <= 200; };
  const record = () => { for (const tab of tabs.values()) for (const control of [tab.triggerEl, tab.closeEl]) {
    control.addEventListener("focus", () => reveals.push({ control, shown: shown(control) }));
  } };
  record();
  const context = {
    activeTab: 1, tabLayerVisible: true, tabs, tabKeyAction, groupOfTab,
    split: grouped ? { orientation: "row", focusedGroup: 1, groups: [
      { id: 1, tabs: [1, 2, 3], activeTab: 1 }, { id: 2, tabs: [4], activeTab: 4 },
    ] } : null,
    selectTab: id => { context.activeTab = id; return true; },
    closeTab: () => assert.fail("navigation must not close tabs"),
  };
  // Exercise the shipped shell handler, not a test-only reimplementation of
  // its group filtering / selection / focus order. No Electron entry import.
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  // onTabKeydown walks the strip walkedTabs gives (the focused group's, else the flat strip's).
  const shipped = ["onTabKeydown", "walkedTabs", "visibleTabEntries"].map(name => shell.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
  assert.ok(shipped.every(Boolean), "shipped keyboard composition exists");
  const onTabKeydown = runInNewContext(`${shipped.join("\n")}\nonTabKeydown`, context);
  for (const [id, { triggerEl }] of tabs) triggerEl.addEventListener("keydown", event => onTabKeydown(event, id));

  doc.getElementById("stable").focus();
  context.selectTab(1);
  assert.equal(reveals.length, 0, "passive activation alone neither focuses nor scrolls");
  tabs.get(1).triggerEl.focus();
  reveals.length = 0;
  const last = grouped ? 3 : 4;
  for (const [key, expected] of [["ArrowRight", 2], ["End", last], ["ArrowLeft", last - 1], ["Home", 1], ["ArrowLeft", last], ["ArrowRight", 1]]) {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    doc.activeElement.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(context.activeTab, expected);
    assert.equal(doc.activeElement, tabs.get(expected).triggerEl, "focus stays on the strip, not the terminal");
    assert.deepEqual(reveals.splice(0), [{ control: tabs.get(expected).triggerEl, shown: true }], "revealed within its strip");
  }
  tabs.get(1).closeEl.focus();
  assert.equal(doc.activeElement, tabs.get(1).closeEl);
  assert.deepEqual(reveals.splice(0), [{ control: tabs.get(1).closeEl, shown: true }],
    "Close is revealed independently even if its whole tab is wider than the strip");
  assert.ok([...tabs.values()].every(tab => tab.paneEl.hidden), "chrome navigation does not itself expose/focus content");
  if (grouped) {
    assert.deepEqual([...first.querySelectorAll('[role="tab"]')].map(el => el.id), ["tab-1", "tab-2", "tab-3", "tab-5"]);
    assert.deepEqual([...second.querySelectorAll('[role="tab"]')].map(el => el.id), ["tab-4"], "group ownership/order remains unchanged");
  }
});
