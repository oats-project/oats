import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createPalette } from "../renderer/palette.mjs";
import { createSoulPicker as createQuickOpen } from "./helpers/soul-picker.mjs";
import { createKeybindingsEditor } from "../renderer/keybindings-editor.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

// Exercise the shipped factories, including createPalette's renderer-document
// default and the same toggle/open entry points used by the shell's actions.
function setup(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button><button id="destination">Destination</button>');
  const doc = dom.window.document;
  const opener = doc.getElementById("opener"), destination = doc.getElementById("destination");
  opener.focus();
  let openerFocuses = 0;
  opener.addEventListener("focus", () => { openerFocuses++; });
  const picks = [];
  const quickOpen = createQuickOpen({
    doc,
    loadSouls: options.loadSouls || (async () => ({ agents: [{ name: "reviewer", agentsRoot: "/souls" }] })),
    onPick: (soul) => { picks.push(soul); return options.onPick ? options.onPick(soul) : destination.focus(); },
  });
  const previousDoc = globalThis.document;
  let palette;
  try {
    globalThis.document = doc;
    palette = createPalette({
      loadInstances: options.loadInstances || (async () => [{ instance: "worker", home: "/worker", running: true }]),
      openTerminal: options.openTerminal || (() => destination.focus()),
      commands: [{ label: "Souls: quick open…", run: () => options.handoff ? options.handoff(quickOpen) : quickOpen.open() }],
    });
  } finally { globalThis.document = previousDoc; }
  doc.addEventListener("keydown", (e) => {
    if (!e.metaKey) return;
    if (e.key === "k") { e.preventDefault(); palette.toggle(); }
    if (e.key === "p") { e.preventDefault(); quickOpen.toggle(); }
  });
  t.after(() => { palette.close(); quickOpen.close(); dom.window.close(); });
  const key = (value, extra = {}, target = doc.activeElement) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  const handoff = (route) => {
    if (route === "shortcut") key("p", { metaKey: true });
    else {
      const input = doc.querySelector("input");
      input.value = ">souls";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      if (route === "Enter") key("Enter");
      else doc.querySelector('[role="option"]').click();
    }
  };
  return { dom, doc, opener, destination, palette, quickOpen, picks, key, handoff, openerFocuses: () => openerFocuses };
}

test("shortcuts editor takes over an open picker and returns its logical opener", async t => {
  const f = setup(t);
  const editor = createKeybindingsEditor({ doc: f.doc, isMac: true });
  t.after(() => editor.close());
  await f.palette.open();
  f.doc.addEventListener("keydown", event => {
    if (event.metaKey && event.key === ",") { event.preventDefault(); editor.open(); }
  });
  f.key(",", { metaKey: true });
  const dialog = f.doc.querySelector(".kb-editor");
  assert.ok(dialog);
  assert.equal(f.doc.querySelectorAll(".palette-overlay").length, 1);
  assert.equal(f.doc.querySelector(".palette-input"), null, "old picker and its trap are gone");
  assert.ok(dialog.contains(f.doc.activeElement));
  // The editor's last stop (a button, or the help-sheet setting's checkbox where no row is registered: slice 4).
  const stops = [...dialog.querySelectorAll("input, button:not([disabled])")].filter(el => !el.closest("[hidden]") && el.tabIndex >= 0);
  stops.at(-1).focus();
  f.key("Tab");
  assert.equal(f.doc.activeElement, dialog.querySelector(".kb-search"), "Tab wraps in the editor (to its search, the first stop), not the removed picker");
  f.key("Escape");
  assert.equal(f.doc.querySelector(".kb-editor"), null);
  assert.equal(f.doc.activeElement, f.opener);
  assert.equal(f.openerFocuses(), 1, "no transient opener focus during activation");
});

function modal(doc, name, { loading = false } = {}) {
  assert.equal(doc.querySelectorAll(".palette-overlay").length, 1, "only one picker can trap focus in a document");
  const dialog = doc.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute("aria-label"), name);
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const input = dialog.querySelector("input");
  assert.equal(doc.activeElement, input);
  const list = doc.getElementById(input.getAttribute("aria-controls"));
  assert.ok(dialog.contains(list));
  assert.equal(list.getAttribute("role"), "listbox");
  if (loading) assert.equal(input.hasAttribute("aria-activedescendant"), false);
  else {
    const option = doc.getElementById(input.getAttribute("aria-activedescendant"));
    assert.ok(list.contains(option));
    assert.equal(option.getAttribute("aria-selected"), "true");
  }
  return input;
}

for (const route of ["shortcut", "Enter", "click"]) {
  for (const outcome of ["cancel", "sync pick", "async pick"]) {
    test(`real Palette → Quick Open via ${route}: ${outcome} keeps the original opener without a latent trap`, async (t) => {
      const completion = deferred();
      let f;
      f = setup(t, { onPick: async () => {
        assert.equal(f.doc.querySelector(".palette-overlay"), null, "all traps are removed before destination activation");
        assert.equal(f.openerFocuses(), 0, "successful activation never transiently focuses the opener");
        if (outcome === "async pick") await completion.promise;
        f.destination.focus();
      } });
      const { doc, key, handoff, palette, opener, destination } = f;
      key("k", { metaKey: true });
      await tick();
      const oldInput = modal(doc, "Command palette");
      const oldRoot = doc.querySelector(".palette-overlay");
      const oldIds = [...oldRoot.querySelectorAll("[id]")].map((el) => el.id);
      handoff(route);
      assert.equal(oldRoot.isConnected, false, "outgoing modal is gone before any load completes");
      assert.equal(f.openerFocuses(), 0);
      await tick();
      const input = modal(doc, "Quick open souls");
      const ids = [...oldIds, ...[...doc.querySelectorAll(".palette-overlay [id]")].map((el) => el.id)];
      assert.equal(new Set(ids).size, ids.length, "ARIA ids remain distinct across the handoff");
      palette.close();
      key("Enter", {}, oldInput);
      assert.equal(doc.activeElement, input, "stale picker close and events cannot dismiss the destination");
      for (const shiftKey of [false, true]) assert.ok(key("Tab", { shiftKey }).defaultPrevented);
      destination.focus();
      assert.equal(doc.activeElement, input, "the destination picker still contains external focus");
      if (outcome === "cancel") {
        key("Escape");
        assert.equal(doc.activeElement, opener, "cancel returns to the original non-picker opener, never BODY");
        assert.equal(f.openerFocuses(), 1);
        assert.deepEqual(f.picks, []);
      } else {
        if (route === "click") doc.querySelector('[role="option"]').click();
        else key("Enter");
        if (outcome === "async pick") {
          assert.equal(doc.querySelector(".palette-overlay"), null);
          assert.equal(f.openerFocuses(), 0);
          completion.resolve();
        }
        await tick();
        assert.deepEqual(f.picks, [{ name: "reviewer", agentsRoot: "/souls" }]);
        assert.equal(doc.activeElement, destination, "no underlying picker can steal delayed destination focus");
        assert.equal(f.openerFocuses(), 0);
      }
      assert.equal(doc.querySelector(".palette-overlay"), null);
      assert.equal(key("Tab").defaultPrevented, false, "no latent keyboard trap after the destination closes");
      assert.equal(key("Escape").defaultPrevented, false);
    });
  }
}

for (const route of ["Enter", "click"]) test(`async palette-row ${route} handoff carries opener across an await and cancellation while loading`, async (t) => {
  const callback = deferred(), load = deferred();
  const f = setup(t, {
    handoff: async (quickOpen) => { await callback.promise; return quickOpen.open(); },
    loadSouls: () => load.promise,
  });
  await f.palette.open();
  f.handoff(route);
  assert.equal(f.doc.querySelector(".palette-overlay"), null);
  assert.equal(f.openerFocuses(), 0);
  assert.equal(f.key("Tab").defaultPrevented, false, "a pending callback is not a modal focus trap");
  callback.resolve(); await tick();
  modal(f.doc, "Quick open souls", { loading: true });
  f.key("Escape");
  assert.equal(f.doc.activeElement, f.opener);
  assert.equal(f.openerFocuses(), 1);
  load.resolve({ agents: [{ name: "obsolete" }] }); await tick();
  assert.equal(f.doc.querySelector(".palette-overlay"), null);
  assert.equal(f.doc.activeElement, f.opener);
});

for (const outcome of ["resolve", "reject"]) test(`shortcut replacement and A→B→A reopening ignore superseded load ${outcome}`, async (t) => {
  const first = deferred(), second = deferred(), souls = deferred();
  let loads = 0;
  const f = setup(t, {
    loadInstances: () => (++loads === 1 ? first.promise : second.promise),
    loadSouls: () => souls.promise,
  });
  const firstOpening = f.palette.open();
  const oldRoot = f.doc.querySelector(".palette-overlay");
  f.key("p", { metaKey: true });
  modal(f.doc, "Quick open souls", { loading: true });
  f.key("k", { metaKey: true });
  modal(f.doc, "Command palette", { loading: true });
  const oldHTML = oldRoot.innerHTML;
  second.resolve([{ instance: "current", home: "/current", running: true }]); await tick();
  const input = modal(f.doc, "Command palette");
  const html = f.doc.querySelector(".palette-overlay").innerHTML;
  first[outcome](outcome === "resolve" ? [{ instance: "obsolete" }] : new Error("obsolete palette load"));
  souls[outcome](outcome === "resolve" ? { agents: [{ name: "obsolete soul" }] } : new Error("obsolete souls load"));
  await firstOpening; await tick();
  assert.equal(oldRoot.innerHTML, oldHTML, "replaced loads cannot even paint detached DOM");
  assert.equal(f.doc.querySelector(".palette-overlay").innerHTML, html);
  assert.equal(f.doc.activeElement, input);
  assert.equal(f.openerFocuses(), 0);
  f.key("Escape");
  assert.equal(f.doc.activeElement, f.opener);
});

test("pending activation does not donate a stale opener after focus moved to a non-picker destination", async (t) => {
  const callback = deferred();
  const f = setup(t, { openTerminal: () => callback.promise });
  await f.palette.open(); f.key("Enter");
  f.destination.focus();
  await f.quickOpen.open();
  f.key("Escape");
  assert.equal(f.doc.activeElement, f.destination);
  assert.equal(f.openerFocuses(), 0);
  callback.resolve(); await tick();
  assert.equal(f.doc.activeElement, f.destination);
});

test("a settled callback without a picker cannot leave stale opener provenance for a later unrelated open", async (t) => {
  const callback = deferred();
  const f = setup(t, { openTerminal: () => callback.promise });
  await f.palette.open(); f.key("Enter");
  callback.resolve(); await tick();
  assert.equal(f.doc.activeElement, f.doc.body);
  await f.quickOpen.open(); f.key("Escape");
  assert.equal(f.doc.activeElement, f.doc.body);
  assert.equal(f.openerFocuses(), 0);
});

test("picker coordination is per Document, not a global modal singleton", async (t) => {
  const a = setup(t), b = setup(t);
  await a.palette.open();
  await b.palette.open();
  modal(a.doc, "Command palette"); modal(b.doc, "Command palette");
  await a.quickOpen.open();
  modal(a.doc, "Quick open souls"); modal(b.doc, "Command palette");
  a.key("Escape");
  assert.equal(a.doc.activeElement, a.opener);
  modal(b.doc, "Command palette");
  b.key("Escape");
  assert.equal(b.doc.activeElement, b.opener);
});

for (const outcome of ["resolve", "reject"]) test(`older callback ${outcome} cannot clear a newer pending handoff's opener`, async (t) => {
  const older = deferred(), newer = deferred();
  const error = new Error("obsolete callback");
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const f = setup(t, {
    openTerminal: () => older.promise,
    handoff: async (quickOpen) => { await newer.promise; return quickOpen.open(); },
  });
  await f.palette.open(); f.key("Enter");
  f.destination.focus();
  await f.palette.open(); f.handoff("Enter");
  assert.equal(f.doc.activeElement, f.doc.body);
  older[outcome](outcome === "resolve" ? undefined : error); await tick();
  assert.equal(f.openerFocuses(), 0);
  newer.resolve(); await tick();
  modal(f.doc, "Quick open souls");
  f.key("Escape");
  assert.equal(f.doc.activeElement, f.destination, "the newer handoff retains its own non-picker opener");
  assert.equal(f.openerFocuses(), 0);
  assert.deepEqual(errors, outcome === "resolve" ? [] : [["Picker activation failed", error]]);
});

test("rejected activation releases its provenance without restoring focus or leaving a trap", async (t) => {
  const callback = deferred(), error = new Error("callback failure");
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const f = setup(t, { openTerminal: () => callback.promise });
  await f.palette.open(); f.key("Enter");
  callback.reject(error); await tick();
  assert.equal(f.doc.activeElement, f.doc.body);
  assert.equal(f.key("Tab").defaultPrevented, false);
  await f.quickOpen.open(); f.key("Escape");
  assert.equal(f.doc.activeElement, f.doc.body, "a settled failure is not a future picker's opener");
  assert.equal(f.openerFocuses(), 0);
  assert.deepEqual(errors, [["Picker activation failed", error]]);
});

test("synchronously thrown activation releases handoff state before reporting the error", async (t) => {
  const error = new Error("synchronous callback failure");
  const f = setup(t, { openTerminal: () => { throw error; } });
  const errors = [];
  f.dom.window.addEventListener("error", (event) => { errors.push(event.error); event.preventDefault(); });
  await f.palette.open(); f.key("Enter");
  assert.deepEqual(errors, [error]);
  await f.quickOpen.open(); f.key("Escape");
  assert.equal(f.doc.activeElement, f.doc.body);
  assert.equal(f.openerFocuses(), 0);
});
