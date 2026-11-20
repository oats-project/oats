// The leader (docs/desktop-keyboard.md, "The leader"): the engine that settles the wait on the next
// key (renderer/leader.mjs) and the hint (leader-hint.mjs). What the keys mean in the Desktop and
// what each runs: test/leader-dispatch.test.mjs.
//
// The engine is driven with the REAL events a keyboard sends, through the real keybinding engine
// and, for a terminal, the installed xterm.js with the shell's own interception
// (terminal-tab.mjs terminalKeyDecision): what reaches the program is xterm's onData, pinned
// exactly. jsdom's navigator.platform is empty, so xterm evaluates keys as on Linux.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  registerAction, resetAllBindings, setBinding, matchEvent, handleKeydown,
} from "../renderer/keybindings.mjs";
import { createLeader, followUpKey, isLoneModifier } from "../renderer/leader.mjs";
import { createLeaderHint, LEADER_ANNOUNCEMENT } from "../renderer/leader-hint.mjs";
import { terminalKeyDecision, terminalOptions } from "../renderer/terminal-tab.mjs";
import { LEADER_TABLE } from "../../client/keymap.mjs";

const map = new Map();
globalThis.localStorage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };

const XTERM = readFileSync(createRequire(import.meta.url).resolve("@xterm/xterm"), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The keydown a keyboard reports for a key id of the table (key, code, keyCode, Shift).
const KEYS = {
  up: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40], left: ["ArrowLeft", "ArrowLeft", 37],
  right: ["ArrowRight", "ArrowRight", 39], tab: ["Tab", "Tab", 9], "shift+tab": ["Tab", "Tab", 9, true], escape: ["Escape", "Escape", 27], space: [" ", "Space", 32],
  "|": ["|", "Backslash", 220, true], "-": ["-", "Minus", 189], "/": ["/", "Slash", 191], "?": ["?", "Slash", 191, true],
};
function keyInit(keyId) {
  if (KEYS[keyId]) { const [key, code, keyCode, shiftKey = false] = KEYS[keyId]; return { key, code, keyCode, shiftKey }; }
  if (/^\d$/.test(keyId)) return { key: keyId, code: `Digit${keyId}`, keyCode: 48 + Number(keyId) };
  const upper = keyId.toUpperCase();
  return { key: keyId, code: `Key${upper}`, keyCode: upper.charCodeAt(0), shiftKey: keyId === upper };
}
// Ctrl+X, the TUI's leader and the Desktop's other choice (D18: the Desktop's default is Ctrl+Space; these tests run on
// the Ctrl+X choice unless they say so, and the Ctrl+Space ones are at the end); Alt+O and Ctrl+\, the leaders before 0.67.
const CTRL_X = { key: "x", code: "KeyX", keyCode: 88, ctrlKey: true };
const CTRL_SPACE = { key: " ", code: "Space", keyCode: 32, ctrlKey: true };
const ALT_O = { key: "o", code: "KeyO", keyCode: 79, altKey: true };
const CTRL_BACKSLASH = { key: "\\", code: "Backslash", keyCode: 220, ctrlKey: true };

/** A window with a terminal (the installed xterm, the shell's interception), a button and a field,
 * the engine's window listener, the leader registered as the shell registers it, and the engine. */
function rig(t, { isMac = false, leaderChord = "Ctrl+X" } = {}) {
  resetAllBindings();
  if (leaderChord) setBinding("app.leader", leaderChord); // the Ctrl+X choice (null: the default, Ctrl+Space)
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(`<div id="host"></div><button id="button">b</button><input id="field"><div id="modal-host"></div>`,
    { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.eval(XTERM);
  const term = new window.Terminal(terminalOptions({ fontSize: 15, fontFamily: "monospace", fontWeight: "normal", theme: {} }));
  term.open(window.document.getElementById("host"));
  const sent = [];
  term.onData(data => sent.push(data));
  const interceptKey = (ev) => {
    if (!matchEvent(ev, { insideTerminal: true, isMac })) return false;
    if (ev.type === "keydown") handleKeydown(ev, { insideTerminal: true, isMac });
    return true;
  };
  term.attachCustomKeyEventHandler(event => !terminalKeyDecision(event, interceptKey).handled);
  const textarea = window.document.querySelector(".xterm-helper-textarea");
  const modalOpen = () => !!window.document.querySelector('[aria-modal="true"]');
  const log = [];
  const leader = createLeader({ win: window, isMac, modalOpen,
    supports: does => does !== "tab-move",
    onOpen: origin => log.push(["open", origin.from]),
    onSettle: (does, origin) => log.push(["settle", does, origin.from]),
    onClose: why => log.push(["close", why]) });
  const onWindowKey = e => handleKeydown(e, { isMac });
  window.addEventListener("keydown", onWindowKey);
  const off = registerAction({ id: "app.leader", label: "Leader", context: "global", when: () => !modalOpen(),
    run: (e) => leader.start({ from: e?.target?.closest?.(".xterm") ? "terminal" : e?.target?.id }) });
  t.after(() => { off(); leader.dispose(); term.dispose(); window.close(); resetAllBindings(); });
  const doc = window.document;
  /** Every phase of one key, as a keyboard sends it: keydown, keypress (for a character), keyup. */
  const press = (target, init) => {
    const fire = (type) => { const e = new window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }); target.dispatchEvent(e); return e; };
    const down = fire("keydown");
    const printable = [...String(init.key)].length === 1 && !init.ctrlKey && !init.altKey && !init.metaKey;
    const pressEvent = printable ? fire("keypress") : null;
    const up = fire("keyup");
    return { down, press: pressEvent, up };
  };
  return { window, doc, term, textarea, leader, log, press, sent,
    data() { const all = sent.join(""); sent.length = 0; return all; },
    button: doc.getElementById("button"), field: doc.getElementById("field") };
}

// ---------------------------------------------------------------- engine

test("every key of the table settles the leader to its row's `does`, once", t => {
  const r = rig(t);
  for (const row of LEADER_TABLE) for (const key of row.keys) {
    r.log.length = 0;
    r.button.focus();
    r.press(r.button, CTRL_X);
    assert.ok(r.leader.isWaiting(), `Ctrl+X opens the wait before ${key}`);
    const { down } = r.press(r.button, keyInit(key));
    assert.equal(down.defaultPrevented, true, `${key} is consumed`);
    if (row.does === "tab-move") {
      assert.deepEqual(r.log, [["open", "button"], ["close", "key"]], "m: not supported here, cancels like any other key");
      continue;
    }
    assert.deepEqual(r.log, [["open", "button"], ["close", "settled"], ["settle", row.does, "button"]], `${key} → ${row.does}`);
    assert.equal(r.leader.isWaiting(), false);
  }
});

test("in a terminal: the leader and a table key reach the program in no phase", t => {
  const r = rig(t);
  r.textarea.focus();
  r.press(r.textarea, CTRL_X);
  assert.equal(r.data(), "", "the leader itself sends nothing");
  assert.ok(r.leader.isWaiting());
  const phases = r.press(r.textarea, keyInit("k"));
  assert.equal(r.data(), "", "no byte of k: not its keydown, keypress or keyup");
  for (const e of Object.values(phases)) if (e) assert.equal(e.defaultPrevented, true, `${e.type} is consumed`);
  assert.deepEqual(r.log.at(-1), ["settle", "palette", "terminal"]);
  // Shifted keys are read by the character they produce.
  r.press(r.textarea, CTRL_X);
  r.press(r.textarea, { key: "X", code: "KeyX", keyCode: 88, shiftKey: true });
  assert.deepEqual(r.log.at(-1), ["settle", "stop", "terminal"], "Shift+x is X");
  r.press(r.textarea, CTRL_X);
  r.press(r.textarea, { key: "|", code: "Backslash", keyCode: 220, shiftKey: true });
  assert.deepEqual(r.log.at(-1), ["settle", "split-right", "terminal"], "Shift+\\ is |");
  assert.equal(r.data(), "");
  // The harness sees the program's bytes: after the leader, the terminal is the program's again.
  r.press(r.textarea, keyInit("k"));
  assert.equal(r.data(), "k");
});

// The leader's ↑ / ↓ are the workspace moves (keymap.mjs LEADER_TABLE workspace-previous / workspace-next): ⌃X then
// an arrow, on macOS and elsewhere, from a terminal and from a control, settles them, and the arrow reaches no program.
for (const isMac of [false, true]) test(`${isMac ? "macOS" : "Linux/Windows"}: Ctrl+X then ↑ / ↓ settle the previous / next workspace, and no arrow reaches the terminal`, t => {
  const r = rig(t, { isMac });
  for (const [key, does] of [["up", "workspace-previous"], ["down", "workspace-next"]]) {
    r.textarea.focus();
    r.press(r.textarea, CTRL_X);
    const phases = r.press(r.textarea, keyInit(key));
    assert.equal(phases.down.defaultPrevented, true, `${key} is consumed`);
    assert.deepEqual(r.log.at(-1), ["settle", does, "terminal"]);
    assert.equal(r.data(), "", "no arrow sequence");
    r.button.focus();
    r.press(r.button, CTRL_X);
    r.press(r.button, keyInit(key));
    assert.deepEqual(r.log.at(-1), ["settle", does, "button"]);
  }
  assert.equal(r.log.some(([kind, does]) => kind === "settle" && (does === "previous" || does === "next")), false, "the leader steps no instance");
});

test("the leader twice in a terminal is not claimed: xterm sends the chord's own bytes", t => {
  const r = rig(t);
  r.textarea.focus();
  r.press(r.textarea, CTRL_X);
  assert.equal(r.data(), "", "the first press sends nothing");
  const { down } = r.press(r.textarea, CTRL_X);
  assert.equal(r.data(), "\x18", "Ctrl+X's 0x18 reaches the program, once");
  assert.equal(r.leader.isWaiting(), false);
  assert.deepEqual(r.log, [["open", "terminal"], ["close", "again"]], "nothing ran, and the leader did not start again");
  assert.equal(down.defaultPrevented, true, "xterm itself took it (its own cancel)");
  // Next press: the leader again.
  r.press(r.textarea, CTRL_X);
  assert.ok(r.leader.isWaiting());
  assert.equal(r.data(), "");
  r.leader.cancel();
  // Alt+O, the leader before 0.67, is no binding now: the program gets ESC o.
  r.press(r.textarea, ALT_O);
  assert.equal(r.data(), "\x1bo", "Alt+O reaches the program");
  assert.equal(r.leader.isWaiting(), false);
});

test("on macOS ⌃X is the leader in a terminal, and twice sends 0x18; ⌃\\ bound back too", t => {
  const r = rig(t, { isMac: true });
  r.textarea.focus();
  r.press(r.textarea, CTRL_X);
  assert.ok(r.leader.isWaiting(), "⌃X fires by name in a terminal (principle 3's exception)");
  assert.equal(r.data(), "");
  r.press(r.textarea, CTRL_X);
  assert.equal(r.data(), "\x18", "the second press is the program's");
  assert.equal(r.leader.isWaiting(), false);
  // ⌃\, the leader before 0.67, bound back: it fires there too, and twice sends 0x1c.
  setBinding("app.leader", "Ctrl+\\");
  r.press(r.textarea, CTRL_BACKSLASH);
  assert.ok(r.leader.isWaiting(), "⌃\\ fires by name in a terminal");
  assert.equal(r.data(), "");
  r.press(r.textarea, CTRL_BACKSLASH);
  assert.equal(r.data(), "\x1c", "the second press is the program's (SIGQUIT's byte)");
  // A rebind to another ⌃ chord stays the program's in a terminal.
  setBinding("app.leader", "Ctrl+Y");
  r.press(r.textarea, { key: "y", code: "KeyY", keyCode: 89, ctrlKey: true });
  assert.equal(r.leader.isWaiting(), false, "⌃Y is not the leader's shape");
  assert.equal(r.data(), "\x19");
});

test("outside a terminal the leader twice only closes the wait", t => {
  const r = rig(t);
  r.button.focus();
  r.press(r.button, CTRL_X);
  assert.ok(r.leader.isWaiting());
  const { down } = r.press(r.button, CTRL_X);
  assert.equal(down.defaultPrevented, true);
  assert.equal(r.leader.isWaiting(), false);
  assert.deepEqual(r.log, [["open", "button"], ["close", "again"]]);
});

test("in a text field on Linux/Windows Ctrl+X is Cut: it opens nothing, and while waiting closes the wait untaken", t => {
  const r = rig(t);
  r.field.focus();
  const first = r.press(r.field, CTRL_X);
  assert.equal(first.down.defaultPrevented, false, "not prevented: Chromium's Cut runs");
  assert.equal(r.leader.isWaiting(), false);
  assert.deepEqual(r.log, []);
  // The leader opened elsewhere, then Ctrl+X in the field: the wait closes, and the field keeps the key.
  r.button.focus();
  r.press(r.button, CTRL_X);
  assert.ok(r.leader.isWaiting());
  r.field.focus();
  const again = r.press(r.field, CTRL_X);
  assert.equal(again.down.defaultPrevented, false, "let through to the field");
  assert.equal(r.leader.isWaiting(), false);
  assert.deepEqual(r.log, [["open", "button"], ["close", "again"]]);
  // A rebind to anything else fires from the field, and its second press there is taken.
  setBinding("app.leader", "Alt+O");
  r.log.length = 0;
  r.press(r.field, ALT_O);
  assert.ok(r.leader.isWaiting(), "Alt+O, not a plain chord, opens it from the field");
  const second = r.press(r.field, ALT_O);
  assert.equal(second.down.defaultPrevented, true);
  assert.equal(r.leader.isWaiting(), false);
  assert.deepEqual(r.log, [["open", "field"], ["close", "again"]]);
});

test("on macOS ⌃X opens the leader from a text field too: Cut is ⌘X there", t => {
  const r = rig(t, { isMac: true });
  r.field.focus();
  const first = r.press(r.field, CTRL_X);
  assert.equal(first.down.defaultPrevented, true);
  assert.ok(r.leader.isWaiting());
  const second = r.press(r.field, CTRL_X);
  assert.equal(second.down.defaultPrevented, true, "the second press only closes the wait");
  assert.equal(r.leader.isWaiting(), false);
  assert.deepEqual(r.log, [["open", "field"], ["close", "again"]]);
});

test("a key outside the table cancels and is dropped: nothing typed, nothing run", t => {
  const r = rig(t);
  r.textarea.focus();
  for (const init of [keyInit("q"), { key: "F5", code: "F5", keyCode: 116 }, { key: "Enter", code: "Enter", keyCode: 13 }]) {
    r.log.length = 0;
    r.press(r.textarea, CTRL_X);
    r.press(r.textarea, init);
    assert.equal(r.data(), "", `${init.key} sends no byte`);
    assert.deepEqual(r.log, [["open", "terminal"], ["close", "key"]], `${init.key} cancels`);
  }
});

test("a follow-up held with Ctrl, Alt or ⌘ is not in the table; AltGr is", t => {
  const r = rig(t);
  r.textarea.focus();
  for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    r.log.length = 0;
    r.press(r.textarea, CTRL_X);
    r.press(r.textarea, { ...keyInit("k"), ...mods });
    assert.deepEqual(r.log, [["open", "terminal"], ["close", "key"]], JSON.stringify(mods));
    assert.equal(r.data(), "");
  }
  const altGr = { key: "|", ctrlKey: true, altKey: true, getModifierState: m => m === "AltGraph" };
  assert.equal(followUpKey(altGr), "|", "AltGr's character is read (Windows reports AltGr as Ctrl+Alt)");
  assert.equal(followUpKey({ key: "k", ctrlKey: true, getModifierState: () => false }), null);
  assert.equal(followUpKey({ key: "ArrowUp" }), "up");
  assert.equal(followUpKey({ key: " " }), "space");
  assert.equal(followUpKey({ key: "Escape" }), "escape");
  assert.equal(followUpKey({ key: "Tab" }), "tab");
  assert.equal(followUpKey({ key: "Process", isComposing: true }), null);
});

// The TUI's spelling (packages/tui/lib/term/keys.mjs keyId): a named key Shift moves carries `shift+`.
test("a follow-up held with Shift: Shift+Tab is the previous group; Shift+an arrow is no row; Space, Enter and Esc read as themselves", t => {
  assert.equal(followUpKey({ key: "Tab", shiftKey: true }), "shift+tab");
  for (const [key, id] of [["ArrowUp", "up"], ["ArrowDown", "down"], ["ArrowLeft", "left"], ["ArrowRight", "right"], ["Home", "home"], ["End", "end"], ["PageUp", "pageup"], ["PageDown", "pagedown"]]) {
    assert.equal(followUpKey({ key, shiftKey: true }), `shift+${id}`);
  }
  for (const [key, id] of [[" ", "space"], ["Enter", "enter"], ["Escape", "escape"]]) assert.equal(followUpKey({ key, shiftKey: true }), id);
  const r = rig(t);
  r.button.focus();
  r.press(r.button, CTRL_X);
  r.press(r.button, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
  assert.deepEqual(r.log, [["open", "button"], ["close", "settled"], ["settle", "group-previous", "button"]]);
  r.log.length = 0;
  r.press(r.button, CTRL_X);
  r.press(r.button, { key: "ArrowUp", code: "ArrowUp", keyCode: 38, shiftKey: true });
  assert.deepEqual(r.log, [["open", "button"], ["close", "key"]], "Shift+↑ is no row: it cancels, as in the TUI");
});

test("a lone modifier settles nothing; the key after it does", t => {
  const r = rig(t);
  r.button.focus();
  r.press(r.button, CTRL_X);
  r.press(r.button, { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true });
  assert.ok(r.leader.isWaiting());
  assert.ok(isLoneModifier({ key: "Shift" }) && isLoneModifier({ key: "AltGraph" }) && !isLoneModifier({ key: "a" }));
  r.press(r.button, { key: "N", code: "KeyN", keyCode: 78, shiftKey: true });
  assert.deepEqual(r.log.at(-1), ["settle", "spawn-another", "button"]);
});

test("a held follow-up's repeats are consumed until it is released", t => {
  const r = rig(t);
  r.textarea.focus();
  r.press(r.textarea, CTRL_X);
  const init = keyInit("down");
  const fire = (type, extra = {}) => { const e = new r.window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init, ...extra }); r.textarea.dispatchEvent(e); return e; };
  fire("keydown");
  assert.equal(fire("keydown", { repeat: true }).defaultPrevented, true);
  assert.equal(r.data(), "", "no arrow sequence from the repeats");
  fire("keyup");
  fire("keydown");
  assert.equal(r.data(), "\x1b[B", "released, the key is the program's again");
});

test("a click, a paste, the window losing focus, a modal or the focused element leaving cancels the wait", async t => {
  const r = rig(t);
  const cases = [
    ["pointer", () => r.doc.body.dispatchEvent(new r.window.MouseEvent("mousedown", { bubbles: true }))],
    ["paste", () => r.field.dispatchEvent(new r.window.Event("paste", { bubbles: true }))],
    ["blur", () => r.window.dispatchEvent(new r.window.Event("blur"))],
    ["modal", async () => {
      const modal = r.doc.createElement("div"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
      r.doc.getElementById("modal-host").append(modal); await tick();
      modal.remove();
    }],
    ["focus", async () => {
      const gone = r.doc.createElement("button"); r.doc.body.append(gone); gone.focus();
      r.leader.cancel(); r.press(gone, CTRL_X); r.log.length = 0;
      r.log.push(["open", undefined]);
      gone.remove(); await tick();
    }],
  ];
  for (const [why, act] of cases) {
    r.log.length = 0;
    r.button.focus();
    r.press(r.button, CTRL_X);
    if (why !== "focus") assert.ok(r.leader.isWaiting(), why);
    await act();
    assert.equal(r.leader.isWaiting(), false, `${why} cancels`);
    assert.deepEqual(r.log.at(-1), ["close", why]);
    assert.ok(!r.log.some(([kind]) => kind === "settle"), `${why}: nothing ran`);
  }
});

test("under a shown modal the leader is not there: the chord goes where it goes today", t => {
  const r = rig(t);
  const modal = r.doc.createElement("div"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  r.doc.body.append(modal);
  r.textarea.focus();
  const { down } = r.press(r.textarea, CTRL_X);
  assert.equal(r.leader.isWaiting(), false);
  assert.equal(r.data(), "\x18", "the program gets Ctrl+X as without the leader");
  assert.equal(r.leader.start({}), false, "nor does anything else start it");
  modal.remove();
  r.press(r.textarea, CTRL_X);
  assert.ok(r.leader.isWaiting());
  // A modal already up when the follow-up arrives: the wait ends and that key is not taken.
  r.doc.body.append(modal);
  const k = r.press(r.field, keyInit("k"));
  assert.equal(k.down.defaultPrevented, false);
  assert.equal(r.leader.isWaiting(), false);
  assert.ok(down);
});

// ---------------------------------------------------------------- the hint

test("the hint: role=status; the wait is announced once and draws nothing; never focusable; a line says why", t => {
  const dom = new JSDOM(`<main id="main"><button id="show-panel"></button></main>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const hint = createLeaderHint({ doc, host: doc.getElementById("main"), before: doc.getElementById("show-panel") });
  const el = hint.element;
  assert.equal(el.getAttribute("role"), "status");
  assert.equal(doc.getElementById("main").lastElementChild.id, "show-panel", "Show instance panel stays last");
  assert.equal(el.textContent, "", "idle: an empty live region");
  hint.announce();
  // For a screen reader only: one sr-only line, no keys, nothing drawn (the shortcuts editor lists the keys).
  assert.deepEqual([...el.children].map(child => [child.className, child.textContent]), [["sr-only", LEADER_ANNOUNCEMENT]]);
  assert.equal(el.querySelectorAll("ul, li, kbd, .leader-hint-line").length, 0, "no keys panel");
  assert.equal(hint.mode(), "wait");
  assert.equal(hint.isShown(), false, "the wait shows nothing");
  assert.notEqual(el.dataset.mode, "line", "the region stays out of sight (shell.css shows only a line)");
  assert.equal(el.querySelectorAll("button, a, input, [tabindex]").length, 0, "nothing in it takes focus");
  assert.equal(el.hasAttribute("tabindex"), false);
  hint.say("No instance is focused or selected.");
  assert.equal(el.textContent, "No instance is focused or selected.");
  assert.equal(hint.mode(), "line");
  assert.equal(hint.isShown(), true);
  assert.equal(el.dataset.mode, "line");
  hint.hide();
  assert.equal(el.textContent, "");
  assert.equal(hint.isShown(), false);
  assert.ok(el.isConnected, "the region stays in the document");
});


// ---------------------------------------------------------------- D18: Ctrl+Space, the Desktop's default leader

for (const isMac of [false, true]) test(`slice4 key table bound: Ctrl+Space is the default leader (${isMac ? "macOS" : "Linux/Windows"}), from a terminal and a text field, and twice sends NUL`, t => {
  const r = rig(t, { isMac, leaderChord: null });
  r.textarea.focus();
  r.press(r.textarea, CTRL_SPACE);
  assert.ok(r.leader.isWaiting(), "Ctrl+Space opens the wait in a terminal");
  assert.equal(r.data(), "", "the first press sends nothing");
  r.press(r.textarea, CTRL_SPACE);
  assert.equal(r.data(), "\x00", "the second press is the program's: NUL, once");
  assert.equal(r.leader.isWaiting(), false);
  // A text field: Ctrl+Space types nothing there, so the leader opens (Ctrl+X there would be Cut on Linux/Windows).
  r.field.focus();
  r.press(r.field, CTRL_SPACE);
  assert.ok(r.leader.isWaiting(), "from a text field too");
  r.press(r.field, keyInit("h"));
  assert.deepEqual(r.log.at(-1), ["settle", "split-right", "field"], "h is split right");
  r.press(r.field, CTRL_SPACE); r.press(r.field, keyInit("v"));
  assert.deepEqual(r.log.at(-1), ["settle", "split-down", "field"], "v is split down");
  // Ctrl+X is no binding now: in a terminal the program gets 0x18.
  r.textarea.focus();
  r.press(r.textarea, CTRL_X);
  assert.equal(r.leader.isWaiting(), false);
  assert.equal(r.data(), "\x18");
});
