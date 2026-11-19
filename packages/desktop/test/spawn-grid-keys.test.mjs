import { launchSoul } from './helpers/workspace-actions.mjs';
// Spawn view grid keyboard — DOM-level regressions (review 93ff03d: the
// default "/" must focus the filter FROM A FOCUSED CARD, the primary
// non-editable surface, not only from grid whitespace).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { pinPlatform } from "./helpers/platform.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

const cliStatusMod = await import("../renderer/views/cli-status.mjs");
const CLI_OK = { ok: true, bin: "/seed/oats", version: "0.18.0", source: "path", required: { desktopApi: 1, range: ">=0.18.0 <0.21.0" }, probedAt: 1, tried: [] };
async function seedCliAvailable() {
  await cliStatusMod.refreshCli({
    api: async () => ({ ok: true, status: 200, json: async () => CLI_OK }),
  });
}

async function mountSpawn(dom) {
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const spawn = await import("../renderer/views/spawn.mjs");
  await seedCliAvailable();
  const agent = (name) => ({
    name, agentsRoot: "/w/agents", description: `${name} soul`, runtime: "pi",
    work: "worktree", repo: true, repoName: "repo",
  });
  const opened = [];
  const ctx = {
    api(pathname) {
      if (pathname === "/api/cli" || pathname === "/api/cli/reprobe") return Promise.resolve(CLI_OK);
      if (pathname.startsWith("/api/agents")) return Promise.resolve({ agents: [agent("alpha"), agent("beta")] });
      if (pathname.startsWith("/api/panel")) return Promise.resolve({ instances: [], workspace: { id: "w" }, workspaces: [] });
      throw new Error(`unexpected ${pathname}`);
    },
    openTerminal: () => {},
    openBrain: (name) => opened.push(name),
  };
  spawn.mount(dom.window.document.getElementById("host"), ctx);
  await tick(); await tick();
  return { spawn, opened };
}

const key = (doc, target, key, opts = {}) => {
  const e = new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
};

test("spawn grid: '/' focuses the filter and 'b' opens brain from a FOCUSED CARD", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  let mounted = null;
  try {
    mounted = await mountSpawn(dom);
    const { opened } = mounted;
    const doc = dom.window.document;
    const cards = [...doc.querySelectorAll(".soul-card")];
    assert.ok(cards.length >= 2, `cards rendered (got ${cards.length})`);
    cards[0].focus();
    assert.equal(doc.activeElement, cards[0], "card is the roving focus target");

    // review 93ff03d: '/' from the focused card must reach spawn.filter
    const slash = key(doc, cards[0], "/");
    assert.equal(slash.defaultPrevented, true, "'/' consumed as a shortcut");
    assert.equal(doc.activeElement, doc.querySelector(".filter"), "filter focused from a focused card");

    cards[1].focus();
    key(doc, cards[1], "b");
    assert.deepEqual(opened, ["beta"], "'b' opens the focused card's brain");
  } finally {
    // The window closes even when the unmount throws: an open one keeps node --test from exiting.
    try { mounted?.spawn.unmount(); } finally {
      globalThis.document = oldDoc; globalThis.window = oldWin;
      dom.window.close();
    }
  }
});

test("spawn grid: typing '/' or 'b' inside the filter input stays text entry", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  let mounted = null;
  try {
    mounted = await mountSpawn(dom);
    const { opened } = mounted;
    const doc = dom.window.document;
    const filter = doc.querySelector(".filter");
    filter.focus();
    const slash = key(doc, filter, "/");
    assert.equal(slash.defaultPrevented, false, "'/' types into the filter");
    const b = key(doc, filter, "b");
    assert.equal(b.defaultPrevented, false, "'b' types into the filter");
    assert.deepEqual(opened, [], "no brain opened from an editable field");
  } finally {
    // The window closes even when the unmount throws: an open one keeps node --test from exiting.
    try { mounted?.spawn.unmount(); } finally {
      globalThis.document = oldDoc; globalThis.window = oldWin;
      dom.window.close();
    }
  }
});

test("window dispatch ineligibility: view actions never match at window level; globals win (review afd2114)", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div><button id=rail>rail button</button></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  let mounted = null;
  try {
    mounted = await mountSpawn(dom);
    const { opened } = mounted;
    const doc = dom.window.document;
    const kb = await import("../renderer/keybindings.mjs");
    kb.setActiveContexts(new Set(["stage:spawn"])); // the shell's spawn-stage context set
    const ev = (target) => {
      const e = { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target, prevented: 0, preventDefault() { this.prevented++; } };
      return e;
    };
    // OUTSIDE the view (rail button): view actions are dispatch-ineligible
    // (context view:spawn never active) — no match, no preventDefault, so
    // native activation (e.g. Space/keys on the button) is untouched.
    const rail = doc.getElementById("rail");
    const outside = ev(rail);
    assert.equal(kb.matchEvent(outside, { isMac: false }), null, "no window-level match for a view action");
    assert.equal(kb.handleKeydown(outside, { isMac: false }), false, "handleKeydown returns false");
    assert.equal(outside.prevented, 0, "outside event is NOT swallowed (no preventDefault)");
    assert.deepEqual(opened, [], "no brain opened from a rail target");
    // a colliding GLOBAL action wins at window level (view action cannot shadow it)
    const offGlobal = kb.registerAction({ id: "test.global", label: "g", context: "global", run: () => opened.push("global"), defaultChord: "B" });
    const outside2 = ev(rail);
    assert.equal(kb.handleKeydown(outside2, { isMac: false }), true, "global fallback dispatches");
    assert.deepEqual(opened, ["global"], "the global action ran, not the view action");
    offGlobal();
    // INSIDE the view, dispatch is the LOCAL handler's job (grid keydown →
    // resolveViewKey), which still answers the engine's effective binding:
    const cards = [...doc.querySelectorAll(".soul-card")];
    cards[1].focus();
    const local = new doc.defaultView.KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true });
    cards[1].dispatchEvent(local);
    assert.deepEqual(opened, ["global", "beta"], "local dispatch runs the view action inside its surface");
    kb.setActiveContexts(new Set());
  } finally {
    // The window closes even when the unmount throws: an open one keeps node --test from exiting.
    try { mounted?.spawn.unmount(); } finally {
      globalThis.document = oldDoc; globalThis.window = oldWin;
      dom.window.close();
    }
  }
});

test("spawn MODAL controls are excluded from view-key dispatch: '/' and 'B' from a modal select/button stay with the dialog (review 96b037b)", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: "http://localhost" });
  const savedDoc = globalThis.document, savedWin = globalThis.window;
  let mounted = null;
  try {
    mounted = await mountSpawn(dom);
    const { opened } = mounted;
    const doc = dom.window.document;
    // open the modal from the first card
    launchSoul(doc);
    const modal = doc.querySelector(".spawn-modal");
    assert.ok(modal, "modal open");
    const filter = doc.querySelector(".filter");
    // '/' from the permissions SELECT (interactive control outside any
    // .soul-card): must NOT be consumed nor focus the filter behind the
    // still-open dialog
    const select = modal.querySelector(".fyolo");
    select.focus();
    const eSlash = key(doc, select, "/");
    assert.equal(eSlash.defaultPrevented, false, "'/' not swallowed from a modal select");
    assert.notEqual(doc.activeElement, filter, "filter behind the modal never steals focus");
    assert.ok(doc.querySelector(".spawn-modal"), "modal still open");
    // 'B' from a modal BUTTON: must not open a card's Brain underneath
    const cancel = modal.querySelector(".fcancel");
    cancel.focus();
    const eB = key(doc, cancel, "B");
    assert.equal(eB.defaultPrevented, false, "'B' not swallowed from a modal button");
    assert.deepEqual(opened, [], "no Brain opened from under the open modal");
  } finally {
    // The window closes even when the unmount throws: an open one keeps node --test from exiting.
    try { mounted?.spawn.unmount(); } finally {
      globalThis.document = savedDoc; globalThis.window = savedWin;
      dom.window.close();
    }
  }
});

// A card's arrows give way to the keymap only for a chord it binds (keybindings.mjs keymapTakes): the
// shared Alt+Shift+↑/↓ open the previous / next instance's terminal from a card too, and a rebind
// follows, as do the workspace steps (Alt+↑/↓); an arrow chord bound to nothing (Ctrl+↓) still moves between the cards. The overview canvas
// (views/hierarchy.mjs) and the roster rows (roster-keys.mjs) give way the same way.
test("spawn grid: the keymap's arrow chords pass the cards; an unbound arrow chord still moves", async (t) => {
  pinPlatform(t); // the Linux and Windows keymap, Alt family: Alt+Shift+↑/↓ the instances, Alt+↑/↓ the workspaces
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: "http://localhost" });
  const oldDoc = globalThis.document, oldWin = globalThis.window;
  const kb = await import("../renderer/keybindings.mjs");
  kb.resetAllBindings();
  // The shell's global arrow chords (shell.mjs); the tab and group moves are the tab layer's, not live on this page.
  const offs = ["roster.openPrevious", "roster.openNext", "workspace.previous", "workspace.next"]
    .map(id => kb.registerAction({ id, label: id, context: "global", run: () => {} }));
  let mounted = null;
  try {
    mounted = await mountSpawn(dom);
    const doc = dom.window.document;
    const cards = [...doc.querySelectorAll(".soul-card")];
    cards[0].focus();
    const chord = key(doc, cards[0], "ArrowDown", { altKey: true, shiftKey: true });
    assert.equal(chord.defaultPrevented, false, "Alt+Shift+↓ is the keymap's");
    assert.equal(doc.activeElement, cards[0], "the card keeps focus");
    const alt = key(doc, cards[0], "ArrowDown", { altKey: true });
    assert.equal(alt.defaultPrevented, false, "Alt+↓ (the next workspace) is the keymap's");
    assert.equal(doc.activeElement, cards[0]);
    const ctrl = key(doc, cards[0], "ArrowDown", { ctrlKey: true });
    assert.equal(ctrl.defaultPrevented, true, "Ctrl+↓ is bound to nothing: the grid's");
    assert.equal(doc.activeElement, cards[1]);
    kb.setBinding("roster.openPrevious", "Ctrl+Shift+↑");
    const rebound = key(doc, cards[1], "ArrowUp", { ctrlKey: true, shiftKey: true });
    assert.equal(rebound.defaultPrevented, false, "the rebind is the keymap's");
    assert.equal(doc.activeElement, cards[1]);
  } finally {
    // The window closes even when the unmount throws: an open one keeps node --test from exiting.
    try { mounted?.spawn.unmount(); } finally {
      offs.forEach(off => off()); kb.resetAllBindings();
      globalThis.document = oldDoc; globalThis.window = oldWin;
      dom.window.close();
    }
  }
});
