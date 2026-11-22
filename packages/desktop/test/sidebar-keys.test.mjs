// The sidebar's plain keys (docs/desktop-keyboard.md, "Sidebar keys"): the TUI's keys of the list
// (packages/client/keymap.mjs PLAIN_KEYS), one rebindable action each in the `sidebar` context. The
// context is the shell's (shell.mjs updateActiveContexts, run here as shipped, on the shipped index.html):
// live while focus is in the sidebar, off inside a popup there; the engine's own guard keeps them
// out of an editable field. Each default is pressed as the real keydown, shifted ones included.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import {
  SIDEBAR_KEYS, registerAction, resetAllBindings, setActiveContexts, matchEvent, parseChord, getBinding, setBinding,
} from "../renderer/keybindings.mjs";

let contexts = new Set();

const map = new Map();
globalThis.localStorage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };

const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");

// The keydown a keyboard sends for a default: Shift+X arrives as "X", Shift+\ as "|", Shift+/ as "?".
const SHIFTED = { "|": "\\", "?": "/" };
function keydownFor(win, chord) {
  const c = parseChord(chord);
  const shifted = c.shift || Object.hasOwn(SHIFTED, c.key);
  const key = /^[a-z]$/.test(c.key) && c.shift ? c.key.toUpperCase() : c.key;
  return new win.KeyboardEvent("keydown", { key, shiftKey: shifted, bubbles: true, cancelable: true });
}

function rig(t) {
  resetAllBindings();
  const dom = new JSDOM(html);
  const win = dom.window, doc = win.document;
  const source = shell.match(/function updateActiveContexts\([^]*?\n\}/)?.[0];
  assert.ok(source, "exercise the shipped updateActiveContexts");
  const c = { document: doc, tabLayerVisible: false, stage: null, activeInstanceMenu: null,
    setActiveContexts: set => { contexts = new Set(set); setActiveContexts(set); } };
  const updateActiveContexts = runInNewContext(`${source}; updateActiveContexts;`, c);
  const sidebarKeysLive = () => { updateActiveContexts(); return contexts.has("sidebar"); };
  // What the shell draws there: a row of the workspace list (a list of buttons, workspace-switcher.mjs), a roster row,
  // a nav button (under the list), an instance row's open context menu (instance-actions.mjs); and in the main area a
  // terminal's input. The foot's count is shown, as while a row needs you (sidebar-foot.mjs).
  doc.getElementById("sidebar-need-you").hidden = false;
  const wsRow = doc.createElement("button"); wsRow.type = "button"; wsRow.className = "ws-option"; wsRow.tabIndex = 0;
  wsRow.setAttribute("aria-current", "true"); wsRow.dataset.workspaceId = "/w/a";
  const wsItem = doc.createElement("li"); wsItem.className = "ws-option-row"; wsItem.append(wsRow);
  const wsGroup = doc.createElement("ul"); wsGroup.className = "ws-group"; wsGroup.append(wsItem);
  doc.getElementById("ws-options").append(wsGroup);
  const row = doc.createElement("button"); row.className = "ctx-inst"; row.dataset.treeInstance = "a"; row.tabIndex = 0;
  doc.querySelector(".ctx-list").append(row);
  const nav = doc.createElement("button"); nav.className = "nav-item"; doc.getElementById("nav").append(nav);
  const menu = doc.createElement("div"); menu.setAttribute("role", "menu");
  const item = doc.createElement("button"); item.setAttribute("role", "menuitem"); menu.append(item);
  doc.querySelector(".ctx-list").append(menu);
  const xterm = doc.createElement("div"); xterm.className = "xterm";
  const textarea = doc.createElement("textarea"); textarea.className = "xterm-helper-textarea"; xterm.append(textarea);
  doc.getElementById("main").append(xterm);
  // The shipped sidebar has no text field since the roster filter went; the guard still holds one added
  // later (shell.mjs updateActiveContexts): a plain text input in the sidebar stands in for it.
  const field = doc.createElement("input"); field.type = "text"; doc.getElementById("sidebar").append(field);
  const ran = [];
  const offs = SIDEBAR_KEYS.map(({ id }) => registerAction({ id, label: id, context: "sidebar", run: () => ran.push(id) }));
  t.after(() => { offs.forEach(off => off()); setActiveContexts(new Set()); resetAllBindings(); win.close(); });
  /** Focus `el`, set the contexts as the shell does on focus, press `chord` there: the action matched. */
  const pressAt = (el, chord) => {
    el.focus();
    updateActiveContexts(); // as the shell does on every focusin
    const e = keydownFor(win, chord);
    Object.defineProperty(e, "target", { value: el });
    return matchEvent(e, { isMac: false });
  };
  return { win, doc, row, nav, item, textarea, pressAt, ran, sidebarKeysLive, wsRow,
    field, controls: [...doc.querySelectorAll("#sidebar > .side-head > button, #sidebar .ctx-head button, #instance-roster > #sidebar-spawn, #sidebar-bar > button")], main: doc.getElementById("show-panel") };
}

test("each sidebar key fires on a workspace list row, a roster row, a nav button, the head's control and the foot's buttons, by its real (shifted) keydown", t => {
  const r = rig(t);
  // The sidebar top to bottom (the product owner, 2026-10-26; slice 1): the head (Add local workspace…), the list,
  // the pinned rows under it, the instances (their heading holds no control) and New agent after them (slice 3d), then
  // the foot (its bar: N need you and ?).
  const sidebar = r.doc.getElementById("sidebar");
  assert.equal(r.doc.getElementById("ws-current"), null, "no current-workspace section any more");
  assert.equal(r.doc.getElementById("nav").parentElement, sidebar, "the nav is the sidebar's own");
  assert.equal(r.doc.getElementById("nav").previousElementSibling, r.doc.getElementById("ws-list"), "the nav sits under the list");
  assert.equal(r.doc.getElementById("nav").nextElementSibling, r.doc.getElementById("instance-roster"), "the instances under the nav");
  assert.ok(r.doc.getElementById("nav").contains(r.nav));
  assert.deepEqual(r.controls.map(b => b.id), ["ws-add-open", "sidebar-need-you", "sidebar-spawn", "sidebar-help"]);
  // The list is buttons, not a listbox, and the guard names no popup of it: the plain keys stay live there.
  assert.equal(r.doc.querySelector('#ws-list[role], #ws-options[role], .ws-group[role="listbox"]'), null);
  assert.doesNotMatch(shell.match(/function updateActiveContexts\([^]*?\n\}/)[0], /ws-menu/);
  for (const { id } of SIDEBAR_KEYS) {
    const chord = getBinding(id, false);
    assert.ok(chord, `${id} has a default`);
    for (const [where, el] of [["workspace row", r.wsRow], ["row", r.row], ["nav", r.nav], ...r.controls.map(b => [b.id, b])]) {
      assert.equal(r.pressAt(el, chord), id, `${id} (${chord}) on the ${where}`);
    }
  }
});

test("the shipped sidebar has no text field (no roster filter); never in a field, an open menu (an instance row's context menu), main or a terminal", t => {
  const r = rig(t);
  assert.deepEqual([...r.doc.querySelectorAll("#sidebar :is(input, textarea, select), .ctx-filter")].filter(el => el !== r.field), [],
    "the shipped sidebar holds no editable field");
  r.main.hidden = false;
  for (const { id } of SIDEBAR_KEYS) {
    const chord = getBinding(id, false);
    assert.equal(r.pressAt(r.field, chord), null, `${id}: a text field types it`);
    assert.equal(r.pressAt(r.item, chord), null, `${id}: an instance row's context menu is its own`);
    assert.equal(r.pressAt(r.textarea, chord), null, `${id}: the terminal's`);
    assert.equal(r.pressAt(r.main, chord), null, `${id}: the main area's`);
  }
  r.row.focus();
  assert.equal(r.sidebarKeysLive(), true);
  r.textarea.focus();
  assert.equal(r.sidebarKeysLive(), false);
});

test("letters keep their case: n spawns, Shift+N spawns another; X is Shift+x, x is nothing", t => {
  const r = rig(t);
  assert.equal(r.pressAt(r.row, "N"), "sidebar.key.spawn");
  assert.equal(r.pressAt(r.row, "Shift+N"), "sidebar.key.spawnAnother");
  assert.equal(r.pressAt(r.row, "Shift+X"), "sidebar.key.stop");
  assert.equal(r.pressAt(r.row, "X"), null, "a lower-case x is one slip away: not Stop");
  assert.equal(r.pressAt(r.row, "\\"), null, "a plain \\ is not |");
});

test("rebindable and unbindable in the editor's terms", t => {
  const r = rig(t);
  setBinding("sidebar.key.refresh", "Shift+F");
  assert.equal(r.pressAt(r.row, "Shift+F"), "sidebar.key.refresh");
  assert.equal(r.pressAt(r.row, "R"), null);
  setBinding("sidebar.key.workspaces", null);
  assert.equal(r.pressAt(r.row, "W"), null, "unbound");
});

test("shell wiring: the sidebar context follows focus; the keys run the leader's `does`", () => {
  assert.match(shell, /document\.addEventListener\("focusin", \(\) => updateActiveContexts\(\)\);/);
  assert.match(shell, /for \(const \{ id, does \} of \[\.\.\.SIDEBAR_KEYS, SIDEBAR_DELETE\]\) \{\n  registerAction\(\{ id, label: leaderLabel\(does, actionLabel\), context: "sidebar",/);
  assert.match(shell, /leaderDispatch\.run\(does, leaderOrigin\(/);
});

// Amendment 8: the context is off in an editable field. A rebind to a modified chord (which the
// engine's plain-key guard does not hold back) must still leave the field its own key.
test("off in an editable field, a modified rebind included: a sidebar text field keeps Ctrl+X", t => {
  const r = rig(t);
  setBinding("sidebar.key.stop", "Ctrl+X");
  const ctrlX = el => { el.focus(); r.sidebarKeysLive(); const e = new r.win.KeyboardEvent("keydown", { key: "x", ctrlKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: el }); return matchEvent(e, { isMac: false }); };
  assert.equal(ctrlX(r.row), "sidebar.key.stop", "on a row it is the sidebar key");
  assert.equal(ctrlX(r.field), null, "in a text field it is Cut");
  assert.equal(r.sidebarKeysLive(), false);
  const editable = r.doc.createElement("div"); editable.contentEditable = "true"; editable.tabIndex = 0;
  Object.defineProperty(editable, "isContentEditable", { value: true }); // jsdom does not compute it
  r.doc.getElementById("nav").append(editable);
  assert.equal(ctrlX(editable), null, "nor in an editable region");
});

// The target of X D S R N (and of the leader's) when focus is on a row's tool (a pending spawn's Check result: an
// instance row has none since slice 1) or an item of its context menu, which sit beside the row in its .ctx-tree-row:
// that row, not the active terminal's instance. The shipped leaderTargetId, on the shipped markup's relation.
test("a key on a row's tool targets that row, not the active terminal's instance", () => {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const source = shell.match(/function leaderTargetId\([^]*?\n\}/)?.[0];
  assert.ok(source, "exercise the shipped leaderTargetId");
  const tabs = new Map([[1, { kind: "terminal", instanceRef: { id: "/h/a" }, paneEl: doc.createElement("div") }]]);
  const context = { tabs, activeTab: 1, instanceId: i => i.id };
  const leaderTargetId = runInNewContext(`${source}; leaderTargetId;`, context);
  const wrap = doc.createElement("div"); wrap.className = "ctx-tree-row";
  const row = doc.createElement("button"); row.className = "ctx-inst"; row.dataset.treeInstance = "/h/b";
  const tools = doc.createElement("div"); tools.className = "ctx-row-tools";
  const start = doc.createElement("button"); start.className = "act ctx-start ctx-spawn-check";
  tools.append(start);
  // The row's context menu (instance-actions.mjs), beside the row in its wrap as the shell places it.
  const menu = doc.createElement("div"); menu.className = "ctx-instance-menu"; menu.setAttribute("role", "menu");
  const menuItem = doc.createElement("button"); menuItem.setAttribute("role", "menuitem"); menuItem.dataset.action = "stop"; menu.append(menuItem);
  wrap.append(row, tools, menu);
  doc.querySelector(".ctx-list").append(wrap);
  assert.equal(leaderTargetId(row), "/h/b");
  assert.equal(leaderTargetId(menuItem), "/h/b", "an item of its context menu");
  assert.equal(leaderTargetId(start), "/h/b", "Check result");
  const foot = ["sidebar-need-you", "sidebar-spawn", "sidebar-help"];
  for (const id of foot) assert.equal(leaderTargetId(doc.getElementById(id)), "/h/a", `${id} (a foot control): the active terminal's`);
  context.activeTab = null;
  assert.equal(leaderTargetId(menuItem), "/h/b", "with no terminal open too");
  for (const id of foot) assert.equal(leaderTargetId(doc.getElementById(id)), null, id);
  // Both paths hand it the focused element when their key is pressed: a sidebar key, and the key after the leader.
  assert.match(shell, /leaderDispatch\.run\(does, leaderOrigin\(e\?\.target \?\? document\.activeElement\)\)/);
  assert.match(shell, /else leaderDispatch\.run\(does, leaderOrigin\(document\.activeElement\)\)/);
  assert.match(shell, /function leaderOrigin\(el\) \{\n  const targetId = leaderTargetId\(el\);/);
  dom.window.close();
});
