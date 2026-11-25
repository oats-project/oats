// The roster list shows no scrollbar (Linux Chromium draws a heavy classic one): the wheel and the
// touchpad scroll it, and keyboard focus reveals the focused row inside the list's own scrollport
// (revealInScrollport), never by scrolling an ancestor. The shipped roster keys (shell.mjs
// onRosterRowKey + setRovingRow) and F6 (focus-regions.mjs) over a modelled layout: jsdom has none.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { revealInScrollport } from "../renderer/reveal-in-scrollport.mjs";
import { rosterKeyAction, moveTarget } from "../renderer/roster-keys.mjs";
import { createFocusRegions } from "../renderer/focus-regions.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const shell = read("shell.mjs");
const fn = name => {
  const found = shell.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
  assert.ok(found, `${name} is exercised from the shipped shell`);
  return found[0];
};

const ROW = 44, TOP = 60, HEIGHT = 120; // the list's top edge and its 120px scrollport: under three rows
/** Six roster rows in an overflowing list, the last one selected. Every row box is ROW px (slice 1's 44px); a row's
 * button sits inside it, 2px from each edge (the row's transparent borders). */
function fixture(t) {
  const rows = Array.from({ length: 6 }, (_, i) => `<div class="ctx-tree-row"><button class="ctx-inst" type="button" tabindex="${i ? -1 : 0}" data-tree-instance="i${i}" data-tree-control="terminal">i${i}</button></div>`).join("");
  const dom = new JSDOM(`<!doctype html><body><div id="app"><aside id="sidebar"><nav id="nav"><button>Workspace overview</button></nav><section id="instance-roster"><div class="ctx-head"><span>Instances</span><span class="ctx-count"></span></div><div class="ctx-list">${rows}</div></section></aside><main id="main"><div id="stagehost"><button>Stage</button></div></main><aside id="context-panel" hidden></aside></div></body>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document, list = doc.querySelector(".ctx-list"), sidebar = doc.getElementById("sidebar");
  // Only the list's scrollTop may move: never the sidebar, the page or the window.
  dom.window.HTMLElement.prototype.scrollIntoView = () => assert.fail("must not scroll ancestors");
  dom.window.scrollTo = () => assert.fail("must not scroll the window");
  sidebar.scrollTop = 5;
  Object.defineProperties(list, { clientHeight: { value: HEIGHT, configurable: true }, clientTop: { value: 0, configurable: true } });
  list.getBoundingClientRect = () => ({ top: TOP, bottom: TOP + HEIGHT, height: HEIGHT });
  const boxes = [...list.querySelectorAll(".ctx-tree-row")];
  boxes.forEach((box, i) => {
    const rect = inset => () => { const top = TOP + i * ROW - list.scrollTop + inset; return { top, bottom: top + ROW - 2 * inset, height: ROW - 2 * inset }; };
    box.getBoundingClientRect = rect(0);
    box.querySelector(".ctx-inst").getBoundingClientRect = rect(2);
  });
  const fully = el => { const r = el.getBoundingClientRect(); return r.top >= TOP && r.bottom <= TOP + HEIGHT; };
  const row = i => boxes[i].querySelector(".ctx-inst");
  const context = {
    document: doc, contextRosterEl: doc.getElementById("instance-roster"), contextInstances: [], contextWorkspace: "A",
    currentWorkspace: () => "A", collapsedInstances: new Set(), collapseKey: () => "", rosterParentId: () => null,
    renderContextRoster() {}, tabOpenIntents: { invalidate() {} }, rosterKeyAction, moveTarget, revealInScrollport,
    contextPanel: { setFocusMode() {} }, setSidebarHidden() {},
  };
  const s = runInNewContext(`${fn("onRosterRowKey")}\n${fn("setRovingRow")}\n${fn("rosterEntry")}\n${fn("focusRoster")}\n({ onRosterRowKey, setRovingRow, focusRoster });`, context);
  for (const box of boxes) box.querySelector(".ctx-inst").addEventListener("keydown", s.onRosterRowKey);
  const key = (el, k) => el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return { dom, doc, list, sidebar, boxes, row, fully, key, s, stage: doc.querySelector("#stagehost button") };
}

test("the roster list scrolls with no scrollbar on every platform, like the tab strips", () => {
  const css = read("shell.css");
  assert.match(css, /\.ctx-list \{ flex: 0 1 auto; min-height: 0; overflow-y: auto;/, "the list still scrolls (slice 3d: as tall as its rows, then New agent)");
  assert.match(css, /\.ctx-list \{ scrollbar-width: none; \}\n\.ctx-list::-webkit-scrollbar \{ display: none; \}/,
    "its scrollbar is hidden (Firefox/standard and Chromium)");
});

test("End and Down reveal the focused last row of an overflowing list inside the list only, by the smallest scroll", t => {
  const u = fixture(t);
  u.row(0).focus();
  u.key(u.row(0), "End");
  assert.equal(u.doc.activeElement, u.row(5), "End focuses the last row");
  assert.equal(u.list.scrollTop, 6 * ROW - HEIGHT, "just enough to show its whole row box");
  assert.ok(u.fully(u.boxes[5]), "the last row is fully inside the list's scrollport");
  assert.equal(u.row(5).tabIndex, 0, "the roving stop follows");
  u.key(u.row(5), "ArrowUp");
  assert.equal(u.doc.activeElement, u.row(4));
  assert.equal(u.list.scrollTop, 6 * ROW - HEIGHT, "row 4 was already fully visible: no scroll");
  u.key(u.row(4), "ArrowUp");
  assert.equal(u.list.scrollTop, 3 * ROW, "row 3, half hidden above, scrolled to the list's top edge");
  u.key(u.row(3), "Home");
  assert.equal(u.doc.activeElement, u.row(0)); assert.equal(u.list.scrollTop, 0);
  for (let i = 0; i < 5; i++) u.key(u.doc.activeElement, "ArrowDown");
  assert.equal(u.doc.activeElement, u.row(5)); assert.ok(u.fully(u.boxes[5]), "Down walks to the last row and reveals it");
  assert.equal(u.sidebar.scrollTop, 5, "no ancestor scrolled");
});

test("every explicit roster focus (Focus the instance roster, Show in roster, a spawn's row) goes through the same reveal", t => {
  const u = fixture(t);
  u.s.setRovingRow(u.list, u.row(4));
  assert.equal(u.doc.activeElement, u.row(4)); assert.ok(u.fully(u.boxes[4]));
  // sidebar.focusFilter (the roster has no filter now): the shipped focusRoster lands on the roving stop, revealed.
  u.row(5).tabIndex = 0; u.row(4).tabIndex = -1; u.list.scrollTop = 0; u.stage.focus();
  u.s.focusRoster();
  assert.equal(u.doc.activeElement, u.row(5), "the roster's current row");
  assert.ok(u.fully(u.boxes[5]), "revealed inside the list"); assert.equal(u.sidebar.scrollTop, 5, "no ancestor scrolled");
  for (const caller of ["focusRoster", "showInRoster", "showPendingSpawn"]) {
    assert.match(fn(caller), /setRovingRow\(/, `${caller} focuses a row through setRovingRow`);
  }
});

test("F6 lands on the roster's selected row and reveals it inside the list, without the focus scroll", t => {
  const u = fixture(t);
  for (const r of u.list.querySelectorAll(".ctx-inst")) r.tabIndex = -1;
  u.row(5).tabIndex = 0;
  const calls = [];
  const focus = u.dom.window.HTMLElement.prototype.focus;
  u.dom.window.HTMLElement.prototype.focus = function (options) { calls.push([this.dataset.treeInstance, options?.preventScroll]); return focus.call(this, options); };
  const regions = createFocusRegions({ doc: u.doc });
  assert.equal(regions.focusRegion("roster"), true);
  assert.equal(u.doc.activeElement, u.row(5));
  assert.deepEqual(calls, [["i5", true]], "the row is focused with preventScroll");
  assert.ok(u.fully(u.boxes[5]), "and revealed in the list's scrollport");
  assert.equal(u.sidebar.scrollTop, 5);
});
