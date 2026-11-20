// Shell-composition regressions for the terminal tab (review termlc2): the
// lifecycle-only tests pass even if the composition performs setup after
// `await start()` — these drive createTerminalTab, the exact code shell.mjs
// runs, with doubles for the preload bridge and xterm.
//   * close-during-pending: NO setup happens (no handlers, no observer, no
//     focus) and the late pty is detached;
//   * live path: every resource set up in onReady is disposed by close, and
//     setup strictly precedes teardown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createTerminalTab, holdTerminalResizes } from "../renderer/terminal-tab.mjs";
import { handle, opened, ready, confirmed } from './helpers/terminal-wire.mjs';
import { terminalFailure } from '../../client/terminal-contract.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

function makeDoubles(openPromise) {
  const log = [];
  const doc = new JSDOM("<!doctype html><body></body>").window.document;
  const wrap = doc.createElement("div");
  doc.body.append(wrap);
  const desk = {
    termOpen: () => { log.push("open"); return openPromise.then(value => typeof value === 'number' ? opened(value) : value); },
    termReady: h => { log.push('ready'); return ready(h); },
    termClose: h => { log.push(`closePty:${h.id}`); return confirmed(h); },
    termWrite: () => log.push("write"),
    termResize: () => log.push("resize"),
    onTermData: () => { log.push("onData+"); return () => log.push("onData-"); },
    onTermExit: () => { log.push("onExit+"); return () => log.push("onExit-"); },
  };
  const term = {
    cols: 80, rows: 24,
    onData: () => log.push("term.onData"),
    onResize: () => log.push("term.onResize"),
    focus: () => log.push("focus"),
    dispose: () => log.push("term.dispose"),
    write: () => {},
  };
  return { log, wrap, desk, term };
}

const mk = (d, extra = {}) => createTerminalTab({
  desk: d.desk, term: d.term, tmux: { session: "s", window: 1 }, wrap: d.wrap,
  isActive: () => true, ownsFocus: () => true, fit: () => {},
  observe: () => { d.log.push("observe+"); return () => d.log.push("observe-"); },
  onError: () => {},
  ...extra,
});

test("terminal tab forwards the instance's saved socket to the privileged bridge", async () => {
  const d = makeDoubles(Promise.resolve(7));
  let spec;
  d.desk.termOpen = async (value) => { spec = value; return opened(7); };
  const tab = mk(d, { tmux: { session: "team", window: "minerva", socket: "/saved/socket" } });
  await tab.start();
  assert.equal(spec.socket, "/saved/socket");
  assert.equal(spec.session, "team");
  assert.equal(spec.window, "minerva");
  await tab.close();
});

test("terminal tab opens tmux or remote only: a recorded Herdr sessionTarget never reaches the bridge", async () => {
  const d = makeDoubles(Promise.resolve(7));
  let spec;
  d.desk.termOpen = async (value) => { spec = value; return opened(7); };
  const tab = mk(d, { sessionTarget: { backend: "herdr", socket: "/memory/herdr.sock", terminalId: "term_ABC" } });
  await tab.start();
  assert.deepEqual(Object.keys(spec).sort(), ["cols", "rows", "session", "socket", "window"]);
  await tab.close();
});

test("close during pending open: no setup at all, late pty detached, UI disposed once", async () => {
  const gate = deferred();
  const d = makeDoubles(gate.promise);
  const tab = mk(d);
  const starting = tab.start();
  const closing = tab.close();          // close while termOpen is pending
  gate.resolve(42);                     // pty materializes late
  await starting;
  await closing;
  assert.deepEqual(d.log, ["open", "closePty:42", "term.dispose"],
    "no handlers/observer/focus on a closed tab; late pty detached; single teardown");
  assert.equal(d.wrap.querySelector(".term-banner"), null, "no banner on a closed tab");
});

test("live path: setup in onReady, close disposes every resource, setup precedes teardown", async () => {
  const d = makeDoubles(Promise.resolve(7));
  const tab = mk(d);
  await tab.start();
  const setupEnd = d.log.length;
  assert.deepEqual(d.log.slice(0, setupEnd),
    ["open", "onData+", "onExit+", "term.onData", "term.onResize", "observe+", "ready", "resize", "focus"],
    "all setup inside onReady, in order");
  await tab.close();
  assert.deepEqual(d.log.slice(setupEnd),
    ["onData-", "onExit-", "observe-", "term.dispose", "closePty:7"].sort((a, b) =>
      d.log.slice(setupEnd).indexOf(a) - d.log.slice(setupEnd).indexOf(b)),
    "teardown disposes exactly the resources setup created");
  // every '+' has its '-' and teardown comes strictly after setup
  for (const r of ["onData", "onExit", "observe"]) {
    assert.ok(d.log.indexOf(`${r}+`) < d.log.indexOf(`${r}-`), `${r}: setup before teardown`);
  }
});

// #672: a drag is xterm's own selection, and agent output keeps arriving under it (Claude Code redraws its
// spinner and status line many times a second). The tab's output path only writes to xterm: nothing in it
// clears or replaces the selection, a background tab included. (xterm keeps a selection across writes;
// the live run checks that with a real one.)
test("agent output under a selection is only written to xterm: the tab never clears the selection", async () => {
  const d = makeDoubles(Promise.resolve(7));
  let output = null; const written = [];
  d.desk.onTermData = (h, fn) => { output = fn; return () => {}; };
  Object.assign(d.term, { write: data => written.push(data), clearSelection: () => d.log.push("clearSelection"),
    select: () => d.log.push("select"), selectAll: () => d.log.push("selectAll"), reset: () => d.log.push("reset") });
  let active = true;
  const tab = mk(d, { isActive: () => active, ownsFocus: () => active });
  await tab.start();
  for (const frame of ["\x1b[s\x1b[24;1H\u280b Working\x1b[u", "\x1b[2J\x1b[Hredrawn", "\x1b[?25l\x1b[1;1Hline\x1b[?25h"]) output(frame);
  active = false; // a tab in the background repaints too
  output("\x1b[3;1Hbackground repaint");
  assert.equal(written.length, 4, "every frame reached xterm");
  assert.deepEqual(d.log.filter(entry => /select|reset/i.test(entry)), [], "no selection call, no reset");
  await tab.close();
});

test("open rejection on a live tab shows the banner and close stays safe", async () => {
  const gate = deferred();
  const d = makeDoubles(gate.promise);
  const tab = mk(d);
  const starting = tab.start();
  gate.reject(new Error("attach failed"));
  await starting;
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /Could not attach/.test(banner.textContent), "safe error banner rendered");
  assert.ok(!banner.textContent.includes('attach failed'), 'raw error withheld');
  await tab.close();                    // no pty to detach; UI still disposed
  assert.ok(d.log.includes("term.dispose"));
  assert.ok(!d.log.some((l) => l.startsWith("closePty")), "no pty was created");
});

test("session-ended (pty exit) then close: banner shown, no double-kill", async () => {
  const d = makeDoubles(Promise.resolve(9));
  let exitCb;
  d.desk.onTermExit = (_id, cb) => { exitCb = cb; d.log.push("onExit+"); return () => d.log.push("onExit-"); };
  const tab = mk(d);
  await tab.start();
  exitCb({ terminalApi: 2, status: 'ended', handle: handle(9), cleanupPending: false }); // confirmed cleanup
  assert.ok(/session ended/.test(d.wrap.querySelector(".term-banner")?.textContent || ""));
  await tab.close();
  assert.ok(!d.log.some((l) => l.startsWith("closePty")), "forget() prevented a double-kill");
});

// Private wire2 only. Numeric values in makeDoubles are synthetic producer IDs,
// translated by the fixture into leased results, never a production fallback.
test("term:open wire2 resolves to a copied lease (attach proceeds)", async () => {
  const d = makeDoubles(Promise.resolve(opened(7)));
  const tab = mk(d);
  await tab.start();
  assert.ok(d.log.includes("focus"), "onReady ran → attach proceeded with the unwrapped id");
  assert.ok(!d.wrap.querySelector(".term-banner"), "no error banner on success");
  await tab.close();
  assert.ok(d.log.includes("closePty:7"), "the unwrapped id is what gets closed");
});

test("term:open reuse is not a second lease acquisition; its close never detaches the existing view", async () => {
  const d = makeDoubles(Promise.resolve({ ...opened(3), status: 'reused' }));
  const tab = mk(d);
  await tab.start();
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /already open/i.test(banner.textContent), `reused banner (got: ${banner?.textContent})`);
  assert.ok(!d.log.includes("focus"), "no attach for a reused target");
  await tab.close();
});

test("term:open typed cap → actionable safe failure", async () => {
  const d = makeDoubles(Promise.resolve(terminalFailure('E_TERM_CAP')));
  const tab = mk(d);
  await tab.start();
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /Terminal limit reached/.test(banner.textContent), `cap banner (got: ${banner?.textContent})`);
  assert.ok(/Close a terminal first/.test(banner.textContent), "actionable guidance present");
  assert.ok(!d.log.includes("focus"), "no attach when capped");
  await tab.close();
});

test("term:open typed failure → safe literal message, no attach", async () => {
  const d = makeDoubles(Promise.resolve(terminalFailure('E_TERM_OPEN_FAILED')));
  const tab = mk(d);
  await tab.start();
  const banner = d.wrap.querySelector(".term-banner");
  assert.ok(banner && /Could not attach/.test(banner.textContent), `error banner (got: ${banner?.textContent})`);
  assert.ok(!d.log.includes("focus"), "no attach on error");
  await tab.close();
});

test('wire2 has no numeric or old-object fallback', async () => {
  for (const value of [7, { id: 7 }, { reused: true, id: 7 }]) {
    const d = makeDoubles(Promise.resolve(7)); d.desk.termOpen = async () => value;
    const tab = mk(d); await tab.start();
    assert.ok(!d.log.includes('onData+')); assert.ok(!d.log.includes('focus')); await tab.close();
    assert.ok(!d.log.some(value => value.startsWith('closePty')));
  }
});

test('pending close remains literal and undisposed; input is disabled and an explicit retry can confirm', async () => {
  const d = makeDoubles(Promise.resolve(12)); let attempts = 0, input;
  d.term.onData = cb => { input = cb; };
  d.desk.termClose = h => ++attempts === 1 ? terminalFailure('E_TERM_CLOSE_PENDING') : confirmed(h);
  const tab = mk(d); await tab.start();
  assert.equal((await tab.close()).ok, false);
  assert.equal(d.wrap.querySelector('.term-banner').textContent, 'closing… not yet confirmed');
  assert.ok(!d.log.includes('term.dispose')); input('must not write'); assert.ok(!d.log.includes('write'));
  assert.equal((await tab.close()).ok, true); assert.equal(d.log.filter(v => v === 'term.dispose').length, 1);
});

test('ready timeout is a retained literal failed view, not healthy; listeners precede acknowledgment', async () => {
  const d = makeDoubles(Promise.resolve(13));
  d.desk.termReady = () => {
    assert.ok(d.log.includes('onData+')); assert.ok(d.log.includes('onExit+'));
    return terminalFailure('E_TERM_READY_TIMEOUT');
  };
  const tab = mk(d); await tab.start();
  assert.equal(d.wrap.querySelector('.term-banner').textContent, 'terminal did not become ready; closed');
  assert.ok(!d.log.includes('focus')); assert.ok(!d.log.includes('term.dispose'));
  await tab.close(); assert.ok(d.log.includes('term.dispose'));
});

test('exit while ready acknowledgment is pending never restores healthy input or focus', async () => {
  const d = makeDoubles(Promise.resolve(14)), gate = deferred(); let exit;
  d.desk.onTermExit = (_h, cb) => { exit = cb; return () => {}; };
  d.desk.termReady = () => gate.promise;
  const tab = mk(d), starting = tab.start();
  await new Promise(setImmediate);
  exit({ terminalApi: 2, handle: handle(14), status: 'ended', cleanupPending: false });
  gate.resolve(ready(handle(14))); await starting;
  assert.ok(!d.log.includes('focus')); assert.match(d.wrap.querySelector('.term-banner').textContent, /session ended/);
  await tab.close(); assert.ok(!d.log.includes('closePty:14'));
});

// ── Shift+Enter → newline (chat-input fix) ────────────────────────────────
// xterm emits a plain \r for Enter with or without Shift, so the modifier
// never reaches tmux/pi. The composition installs a custom key handler that
// translates Shift+Enter into a raw \n (pi's Ctrl+J newline alias) and
// suppresses the default \r. xterm invokes the handler for keydown,
// keypress AND keyup of the same press — suppressing only keydown leaks a
// \r through the keypress path, which SENT the message right after the
// newline (the v0.18.4 field failure). These drive the pure classifier AND
// the wired handler behavior — a regression that keeps the classifier but
// forgets to suppress the default (returning true) would send anyway.
import { shiftEnterAction } from "../renderer/terminal-tab.mjs";

test("shiftEnterAction: Shift+Enter suppresses every event; \\n only on keydown", () => {
  const ev = (o) => ({ type: "keydown", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true })), { suppress: true, byte: "\n" });
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, type: "keypress" })), { suppress: true, byte: null }, "keypress suppressed, no second write");
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, type: "keyup" })), { suppress: true, byte: null }, "keyup suppressed, no write");
  assert.deepEqual(shiftEnterAction(ev({})), { suppress: false, byte: null }, "plain Enter untouched (still sends)");
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, ctrlKey: true })), { suppress: false, byte: null }, "extra modifiers pass through");
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, metaKey: true })), { suppress: false, byte: null });
  assert.deepEqual(shiftEnterAction(ev({ shiftKey: true, altKey: true })), { suppress: false, byte: null });
  assert.deepEqual(shiftEnterAction(ev({ key: "a", shiftKey: true })), { suppress: false, byte: null }, "shifted letters untouched");
});

test("custom key handler: Shift+Enter writes \\n once and suppresses keydown, keypress and keyup", async () => {
  const d = makeDoubles(Promise.resolve(5));
  let handler = null;
  const writes = [];
  d.term.attachCustomKeyEventHandler = (h) => { handler = h; };
  d.desk.termWrite = (id, data) => writes.push([id, data]);
  const tab = mk(d);
  await tab.start();
  assert.equal(typeof handler, "function", "handler installed during onReady");
  const ev = (o) => ({ type: "keydown", key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.equal(handler(ev({ shiftKey: true })), false, "keydown suppressed (default \\r blocked)");
  assert.deepEqual(writes, [[handle(5), "\n"]], "newline byte written with the original lease");
  assert.equal(handler(ev({ shiftKey: true, type: "keypress" })), false, "keypress suppressed — the \\r leak that SENT the message");
  assert.equal(handler(ev({ shiftKey: true, type: "keyup" })), false, "keyup suppressed");
  assert.deepEqual(writes, [[handle(5), "\n"]], "exactly one write for the whole chord");
  assert.equal(handler(ev({})), true, "plain Enter left to xterm (message sends)");
  assert.equal(writes.length, 1, "no extra writes for pass-through keys");
  await tab.close();
  writes.length = 0;
  assert.equal(handler(ev({ shiftKey: true })), false);
  assert.deepEqual(writes, [], "no write after the pty is gone");
});

// ── Option+drag local selection (copy fix) ────────────────────────────────
// The viewer tmux session runs `mouse on`, so tmux consumes plain drags and
// xterm never builds a local selection — copy from a terminal looked broken.
// terminalOptions() must force macOptionClickForcesSelection on, and
// shell.mjs must actually construct its Terminal through terminalOptions
// (an inline options object would silently drop the invariant).
import { terminalOptions } from "../renderer/terminal-tab.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

test("terminalOptions: forces Option+drag local selection and carries typography/theme", () => {
  const o = terminalOptions({ fontSize: 13, fontFamily: "mono", fontWeight: 475, theme: { background: "#000" } });
  assert.equal(o.macOptionClickForcesSelection, true, "Option+drag forces a LOCAL xterm selection if the far side's tracking ever reaches xterm (terminal-mouse.mjs fallback)");
  assert.equal(o.scrollback, 5000);
  assert.equal(o.fontSize, 13);
  assert.equal(o.fontFamily, "mono");
  assert.equal(o.fontWeight, 475, "the theme's text weight (terminalFontWeight)");
  assert.equal("fontWeightBold" in o, false, "bold stays xterm's own (700)");
  assert.deepEqual(o.theme, { background: "#000" });
});

// Native terminal geometry (060de502; reverts the Redesign v3 1.7 rhythm): no
// lineHeight reaches xterm, so its default 1.0 keeps cells and the block
// cursor one natural cell tall; tmux owns row spacing. A caller passing a
// lineHeight (e.g. a stale typography object) must not leak it through.
test("terminalOptions: native geometry — no lineHeight, no customGlyphs, OAS option shape", () => {
  const o = terminalOptions({ fontSize: 13, fontFamily: "mono", theme: {}, lineHeight: 1.7 });
  assert.equal("lineHeight" in o, false, "xterm must run at its default line height");
  assert.equal("customGlyphs" in o, false, "xterm's default glyph handling; customGlyphs only justified the tall cells");
  assert.deepEqual(Object.keys(o).sort(), ["altClickMovesCursor", "fontFamily", "fontSize", "fontWeight", "macOptionClickForcesSelection", "minimumContrastRatio", "scrollback", "theme"]);
});

// #694: xterm's selection always owns the buttons (terminal-mouse.mjs), so xterm's Alt+click "move the
// cursor here" would turn a quick Alt/Option+click into cursor keys, Up/Down among them, which recall a
// prompt's history. It is off, whatever the caller passes.
test("terminalOptions: Alt/Option+click never moves the cursor (no cursor keys reach the pane)", () => {
  const o = terminalOptions({ fontSize: 13, fontFamily: "mono", fontWeight: 475, theme: {} });
  assert.equal(o.altClickMovesCursor, false, "xterm's default is true");
  assert.equal(terminalOptions({ fontSize: 13, fontFamily: "mono", theme: {}, altClickMovesCursor: true }).altClickMovesCursor, false);
});

// The readability floor (#602): xterm moves any text colour that is under 4.5:1
// against its cell's background. One number for every theme and every terminal,
// not a parameter: a caller's value must not get through.
test("terminalOptions: a minimum contrast ratio of 4.5, whatever the caller passes", () => {
  const o = terminalOptions({ fontSize: 13, fontFamily: "mono", fontWeight: 475, theme: {} });
  assert.equal(o.minimumContrastRatio, 4.5, "WCAG AA for text, in every theme");
  const passed = terminalOptions({ fontSize: 13, fontFamily: "mono", fontWeight: 475, theme: {}, minimumContrastRatio: 1 });
  assert.equal(passed.minimumContrastRatio, 4.5, "1 would switch xterm's floor off; it is not the caller's to set");
});

test("shell.mjs constructs its Terminal through terminalOptions", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "renderer", "shell.mjs"), "utf8");
  assert.match(src, /new Terminal\(terminalOptions\(/, "shell must build xterm options via terminalOptions()");
  assert.doesNotMatch(src, /lineHeight/, "no caller (terminal tab, preview terminal, typography listener) sets lineHeight");
});

// ── shortcut interception before the pty (review d64daeb important) ──────
// xterm's capture-phase textarea handler consumes allowlisted chords (e.g.
// Ctrl+K) — preventDefault + stopPropagation — so the shell's bubble-phase
// window listener NEVER sees them and a control byte goes to the attached
// program instead. The composition's interceptKey hook runs inside xterm's
// custom key handler (before any pty write): a claimed chord is suppressed
// for every phase and its byte never reaches the pty.
import { terminalKeyDecision } from "../renderer/terminal-tab.mjs";

test("terminalKeyDecision: Shift+Enter wins, then interception, else pass-through", () => {
  const ev = (o) => ({ type: "keydown", key: "k", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  // Shift+Enter translation takes precedence and carries its byte
  assert.deepEqual(terminalKeyDecision(ev({ key: "Enter", shiftKey: true }), () => true), { handled: true, byte: "\n" });
  // intercepted chord: handled, no byte
  assert.deepEqual(terminalKeyDecision(ev({ ctrlKey: true }), () => true), { handled: true, byte: null });
  // not intercepted: xterm processes normally
  assert.deepEqual(terminalKeyDecision(ev({ ctrlKey: true }), () => false), { handled: false, byte: null });
  assert.deepEqual(terminalKeyDecision(ev({}), undefined), { handled: false, byte: null }, "no hook, no claim");
});

// Shift+PgUp / Shift+PgDn (#1502): xterm.js scrolls its own viewport for them and sends the program
// nothing, and that viewport is empty while tmux draws on the alternate screen. The shell sends tmux
// the keys instead, which the viewer's key table binds to scroll back.
import { shiftPageAction } from "../renderer/terminal-tab.mjs";

test("shiftPageAction: Shift+PgUp and Shift+PgDn are tmux's S-PPage and S-NPage, written once, on keydown", () => {
  const ev = (o) => ({ type: "keydown", key: "PageUp", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.deepEqual(shiftPageAction(ev({})), { suppress: true, byte: "\x1b[5;2~" });
  assert.deepEqual(shiftPageAction(ev({ key: "PageDown" })), { suppress: true, byte: "\x1b[6;2~" });
  for (const type of ["keypress", "keyup"]) {
    assert.deepEqual(shiftPageAction(ev({ type })), { suppress: true, byte: null }, `${type}: claimed, no second write`);
  }
  assert.deepEqual(shiftPageAction(ev({ shiftKey: false })), { suppress: false, byte: null }, "plain PgUp is xterm's (CSI 5 ~)");
  for (const mod of ["ctrlKey", "altKey", "metaKey"]) {
    assert.deepEqual(shiftPageAction(ev({ [mod]: true })), { suppress: false, byte: null }, `Shift+${mod} PgUp is xterm's`);
  }
  assert.deepEqual(shiftPageAction(ev({ key: "ArrowUp" })), { suppress: false, byte: null }, "other shifted keys are xterm's");
});

test("terminalKeyDecision: a chord bound to Shift+PgUp is the keymap's; otherwise the shell sends it on", () => {
  const ev = (o) => ({ type: "keydown", key: "PageUp", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.deepEqual(terminalKeyDecision(ev({}), () => false), { handled: true, byte: "\x1b[5;2~" });
  assert.deepEqual(terminalKeyDecision(ev({ key: "PageDown" }), undefined), { handled: true, byte: "\x1b[6;2~" });
  assert.deepEqual(terminalKeyDecision(ev({}), () => true), { handled: true, byte: null }, "a binding the person set wins, and sends nothing");
});

test("wired handler: an intercepted chord is suppressed in every phase and writes nothing to the pty", async () => {
  const d = makeDoubles(Promise.resolve(9));
  let handler = null;
  const writes = [];
  const intercepted = [];
  d.term.attachCustomKeyEventHandler = (h) => { handler = h; };
  d.desk.termWrite = (id, data) => writes.push([id, data]);
  // stand-in for the engine's terminal-allowlist match: claims Ctrl+K
  const interceptKey = (ev) => {
    const hit = ev.key === "k" && ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey;
    if (hit && ev.type === "keydown") intercepted.push(ev.type);
    return hit;
  };
  const tab = mk(d, { interceptKey });
  await tab.start();
  const ev = (o) => ({ type: "keydown", key: "k", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.equal(handler(ev({ ctrlKey: true })), false, "keydown claimed — xterm must not write the control byte");
  assert.equal(handler(ev({ ctrlKey: true, type: "keypress" })), false, "keypress claimed too (no byte leak)");
  assert.equal(handler(ev({ ctrlKey: true, type: "keyup" })), false, "keyup claimed");
  assert.deepEqual(writes, [], "nothing written to the pty for an intercepted chord");
  assert.deepEqual(intercepted, ["keydown"], "action dispatch observed once, on keydown");
  assert.equal(handler(ev({})), true, "plain k left to xterm (types into the terminal)");
  assert.equal(handler(ev({ key: "Enter", shiftKey: true })), false, "Shift+Enter still composes");
  assert.deepEqual(writes, [[handle(9), "\n"]], "Shift+Enter newline still written");
  await tab.close();
});

// The theme picker's chord in a terminal, through the shell's interceptKey (the engine's terminal policy):
// Ctrl+Shift+Space (Linux/Windows) and ⇧⌘Space (macOS) are claimed in every phase, run the action once, and
// write nothing to the pty (xterm.js 5.5.0 maps neither to a byte either: its Ctrl+Space → NUL needs Shift up,
// and on macOS ⌘ suppresses its printable path). Plain Ctrl+Space is left to xterm, which sends the program NUL.
import { registerAction, matchEvent, handleKeydown } from "../renderer/keybindings.mjs";
test("the theme picker chord opens once in a terminal and writes no byte; plain Ctrl+Space reaches the program", async () => {
  let runs = 0;
  const off = registerAction({ id: "app.themePicker", label: "Choose a theme…", context: "global", run: e => { if (!e?.repeat) runs++; } });
  try {
    for (const isMac of [false, true]) {
      const d = makeDoubles(Promise.resolve(9)), writes = [];
      let handler = null;
      d.term.attachCustomKeyEventHandler = (h) => { handler = h; };
      d.desk.termWrite = (id, data) => writes.push([id, data]);
      const interceptKey = (ev) => {
        if (!matchEvent(ev, { insideTerminal: true, isMac })) return false;
        if (ev.type === "keydown") handleKeydown(ev, { insideTerminal: true, isMac });
        return true;
      };
      const tab = mk(d, { interceptKey });
      await tab.start();
      const ev = (type, o = {}) => ({ type, key: " ", code: "Space", keyCode: 32, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...o });
      const chord = isMac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true };
      runs = 0;
      const down = ev("keydown", chord);
      assert.equal(handler(down), false, `mac=${isMac}: keydown claimed before xterm`);
      assert.equal(down.defaultPrevented, true);
      assert.equal(handler(ev("keypress", chord)), false, "keypress claimed");
      assert.equal(handler(ev("keyup", chord)), false, "keyup claimed");
      assert.equal(runs, 1, `mac=${isMac}: the picker toggles once, on keydown`);
      // A held chord: claimed (still no byte) but the action does nothing on a repeat.
      assert.equal(handler(ev("keydown", { ...chord, repeat: true })), false);
      assert.equal(runs, 1, "key repeat does not toggle again");
      assert.deepEqual(writes, [], `mac=${isMac}: nothing written to the pty`);
      const nul = ev("keydown", { ctrlKey: true });
      assert.equal(handler(nul), true, `mac=${isMac}: plain Ctrl+Space is left to xterm`);
      assert.equal(nul.defaultPrevented, false); assert.equal(runs, 1);
      await tab.close();
    }
  } finally { off(); }
});

test("shell wires interceptKey through the engine's terminal policy", () => {
  const here2 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here2, "..", "renderer", "shell.mjs"), "utf8");
  assert.match(src, /interceptKey: \(ev\) => \{/, "shell provides the interception hook");
  assert.match(src, /matchEvent\(ev, \{ insideTerminal: true \}\)/, "hook consults the engine allowlist");
  assert.match(src, /if \(ev\.type === "keydown"\) handleKeydown\(ev, \{ insideTerminal: true \}\)/, "action runs once, on keydown");
});

test("readiness focus fails closed without an explicit owner, while attachment setup is retained", async () => {
  const d = makeDoubles(Promise.resolve(8));
  const tab = mk(d, { ownsFocus: undefined });
  await tab.start(); tab.focus();
  assert.ok(d.log.includes("onData+")); assert.ok(d.log.includes("observe+"));
  assert.ok(!d.log.includes("focus"));
  await tab.close();
  tab.focus();
  assert.ok(!d.log.includes("focus"), "closed input cannot be focused");
  assert.equal(d.log.filter(x => x === "closePty:8").length, 1);
});

test("losing intent does not dispose a pending attachment; subsequent explicit intent may focus it", async () => {
  const gate = deferred(), d = makeDoubles(gate.promise);
  let owns = true;
  const tab = mk(d, { ownsFocus: () => owns });
  const pending = tab.start();
  tab.focus(); assert.ok(!d.log.includes("focus"), "pending focus waits for readiness");
  owns = false;
  gate.resolve(9); await pending;
  assert.ok(!d.log.includes("focus"));
  assert.ok(!d.log.includes("term.dispose"));
  owns = true; tab.focus();
  assert.equal(d.log.filter(x => x === "focus").length, 1);
  await tab.close(); tab.focus();
  assert.equal(d.log.filter(x => x === "focus").length, 1, "closed input stays unfocused even with an owner");
});

// ── Synchronized output (#1193) ───────────────────────────────────────────
// tmux wraps each redraw in ESC[?2026h … ESC[?2026l; the tab's per-lease gate
// (terminal-sync.mjs) writes a block to xterm in one call however the IPC split
// it, and a lease that ends lands its held bytes before the tab shows it ended.
import { SYNC_BEGIN, SYNC_END } from "../renderer/terminal-sync.mjs";

const REDRAW = `${SYNC_BEGIN}\x1b[?25l\x1b[23;3H> typed\x1b[K\x1b[?25h\x1b[23;10H${SYNC_END}`;
const HALF = REDRAW.slice(0, 20);

/** Timers fire only when advanced. */
function syncClock() {
  let now = 1_000_000, next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); await new Promise(setImmediate);
      }
      now = end; await new Promise(setImmediate);
    },
  };
}

/** A tab whose output and exits are driven by lease id; every xterm write records the tab's state then. */
function syncRig(extra = {}, d = makeDoubles(Promise.resolve(7))) {
  const clock = syncClock(), data = new Map(), exits = new Map(), writes = [];
  d.desk.onTermData = (h, fn) => { data.set(h.id, fn); return () => { if (data.get(h.id) === fn) data.delete(h.id); }; };
  d.desk.onTermExit = (h, fn) => { exits.set(h.id, fn); return () => {}; };
  d.term.options = {};
  d.term.write = text => {
    assert.ok(!d.log.includes("term.dispose"), "no write after the terminal is disposed");
    writes.push({ text, banner: d.wrap.querySelector(".term-banner")?.textContent ?? null,
      strip: Boolean(d.wrap.querySelector(".term-reconnect")) });
    d.log.push("term.write");
  };
  const tab = mk(d, { clock, ...extra });
  return { d, clock, tab, writes, output: (id, text) => data.get(id)?.(text),
    exit: (id, more = {}) => exits.get(id)({ terminalApi: 2, status: "ended", handle: handle(id), cleanupPending: false, ...more }) };
}

test("sync: a block delivered in two messages is one term.write; plain output is written at once", async () => {
  const r = syncRig();
  await r.tab.start();
  r.output(7, "plain");
  assert.deepEqual(r.writes.map(w => w.text), ["plain"]);
  r.output(7, HALF);
  assert.deepEqual(r.writes.map(w => w.text), ["plain"], "held until its end");
  r.output(7, REDRAW.slice(HALF.length));
  assert.deepEqual(r.writes.map(w => w.text), ["plain", REDRAW]);
  assert.equal(r.clock.pending(), 0);
  await r.tab.close();
});

test("sync: an unfinished block reaches xterm at the bound", async () => {
  const r = syncRig();
  await r.tab.start();
  r.output(7, HALF);
  await r.clock.advance(999); assert.deepEqual(r.writes, []);
  await r.clock.advance(1); assert.deepEqual(r.writes.map(w => w.text), [HALF]);
  await r.tab.close();
});

test("sync: a lease that exits mid-block writes the held bytes before the ended banner, and leaves no timer", async () => {
  const r = syncRig();
  await r.tab.start();
  r.output(7, HALF);
  r.exit(7);
  assert.deepEqual(r.writes, [{ text: HALF, banner: null, strip: false }], "flushed before the banner");
  assert.match(r.d.wrap.querySelector(".term-banner").textContent, /session ended/);
  assert.equal(r.clock.pending(), 0);
  await r.tab.close();
  assert.equal(r.writes.length, 1);
});

test("sync: close mid-block writes the held bytes before the terminal is disposed; nothing after; no timer", async () => {
  const r = syncRig();
  await r.tab.start();
  r.output(7, HALF);
  const closing = r.tab.close();
  r.output(7, REDRAW.slice(HALF.length));
  await closing;
  assert.deepEqual(r.writes.map(w => w.text), [HALF], "the held half once, then nothing for a closed tab");
  assert.ok(r.d.log.indexOf("term.write") < r.d.log.indexOf("term.dispose"));
  assert.equal(r.clock.pending(), 0);
});

test("sync: a close that stays pending keeps showing the held bytes and arms no timer", async () => {
  const r = syncRig();
  r.d.desk.termClose = () => terminalFailure("E_TERM_CLOSE_PENDING");
  await r.tab.start();
  r.output(7, HALF);
  assert.equal((await r.tab.close()).ok, false);
  r.output(7, `${SYNC_BEGIN}late`);
  assert.deepEqual(r.writes.map(w => w.text), [HALF]);
  assert.equal(r.clock.pending(), 0, "no timer outlives the closing tab");
});

test("sync: a ready failure mid-block writes the held bytes before its banner", async () => {
  const d = makeDoubles(Promise.resolve(7)), acknowledged = deferred();
  d.desk.termReady = () => acknowledged.promise;
  const r = syncRig({}, d), starting = r.tab.start();
  await new Promise(setImmediate);
  r.output(7, HALF);
  acknowledged.resolve(terminalFailure("E_TERM_READY_TIMEOUT")); await starting;
  assert.deepEqual(r.writes, [{ text: HALF, banner: null, strip: false }]);
  assert.equal(r.d.wrap.querySelector(".term-banner").textContent, "terminal did not become ready; closed");
  assert.equal(r.clock.pending(), 0);
  await r.tab.close();
});

test("sync: a reconnect mid-block writes the old lease's held bytes first; the new lease has a fresh gate", async () => {
  const d = makeDoubles(Promise.resolve(7));
  let lease = 0;
  d.desk.termOpen = async () => opened(++lease);
  const r = syncRig({ remote: { serverId: "build", instance: "dev", home: "/srv/dev" }, serverLabel: "Build box", tmux: undefined }, d);
  await r.tab.start();
  r.output(1, HALF);
  r.exit(1, { exitCode: 255, reason: null });
  assert.deepEqual(r.writes, [{ text: HALF, banner: null, strip: false }], "before the disconnected strip");
  assert.ok(r.d.wrap.querySelector(".term-reconnect"), "the strip shows after");
  await r.clock.advance(1000);
  assert.equal(lease, 2, "reconnected");
  r.output(1, REDRAW.slice(HALF.length));
  r.output(2, "\x1b[?20"); r.output(2, `26h${REDRAW.slice(SYNC_BEGIN.length)}`);
  assert.deepEqual(r.writes.map(w => w.text), [HALF, REDRAW], "the old lease's rest is not written; the new lease's block is whole");
  assert.equal(r.clock.pending(), 0);
  await r.tab.close();
});

// The resizable sidebar: a resize drag (the sidebar's handle) holds the PTY resizes. xterm still resizes every frame; the program
// hears the size once, when the last hold lets go, after a refit to the final layout.
test("held resizes: none reaches the program until the last hold lets go, then one per terminal, refitted", async () => {
  const d = makeDoubles(Promise.resolve(7));
  let resized, fits = 0, active = true;
  d.term.onResize = fn => { resized = fn; return { dispose() {} }; };
  const sent = [];
  d.desk.termResize = (h, cols, rows) => sent.push(`${h.id}:${cols}x${rows}`);
  const grow = (cols) => { d.term.cols = cols; resized({ cols, rows: d.term.rows }); };
  const tab = mk(d, { isActive: () => active, fit: () => { fits++; if (d.term.cols < 100) grow(100); } });
  await tab.start(); sent.length = 0;
  grow(81);
  assert.deepEqual(sent, ["7:81x24"], "unheld, each resize is sent at once");
  sent.length = 0;
  const releaseA = holdTerminalResizes(), releaseB = holdTerminalResizes();
  grow(82); grow(85); grow(90);
  assert.deepEqual(sent, [], "held: xterm resizes, the program hears nothing");
  releaseA(); releaseA();
  assert.deepEqual(sent, [], "still held by the other");
  releaseB();
  assert.equal(fits, 1, "one refit to the final layout");
  assert.deepEqual(sent, ["7:100x24"], "one resize, the final size");
  sent.length = 0; fits = 0;
  let release = holdTerminalResizes();
  d.term.cols = 120; resized({ cols: 120, rows: 24 });
  release();
  assert.deepEqual([fits, sent], [1, ["7:120x24"]], "a refit that changes nothing still sends the held size once");
  sent.length = 0; fits = 0; active = false;
  release = holdTerminalResizes();
  d.term.cols = 130; resized({ cols: 130, rows: 24 });
  release();
  assert.deepEqual([fits, sent], [0, ["7:130x24"]], "a hidden terminal sends its size without a refit");
  sent.length = 0;
  release = holdTerminalResizes();
  d.term.cols = 140; resized({ cols: 140, rows: 24 });
  await tab.close();
  release();
  assert.deepEqual(sent, [], "a terminal closed meanwhile sends nothing");
  grow(150);
  assert.deepEqual(sent, [], "nor after");
});

// The agent view's answer (the Opus whole read; the maintainer's conditions): type() goes through termWrite's answer
// option and hands the zone main's refusal, the scrollback or an unread mode, without a banner of its own.
test("terminal tab type: the answer option, and main's scrollback refusals reach the caller as theirs", async () => {
  const d = makeDoubles(Promise.resolve(5));
  const calls = [];
  let reply = { terminalApi: 2, ok: true, status: 'sent' };
  d.desk.termWrite = async (h, data, options) => { calls.push([h, data, options]); return reply; };
  const tab = mk(d);
  await tab.start();
  assert.equal(await tab.type('q1: Yes'), true);
  assert.deepEqual(calls, [[handle(5), 'q1: Yes', { answer: true }]]);
  reply = terminalFailure('E_TERM_IN_MODE');
  assert.equal(await tab.type('q1: Yes'), 'in-mode');
  reply = terminalFailure('E_TERM_MODE_UNKNOWN');
  assert.equal(await tab.type('q1: Yes'), 'mode-unknown');
  assert.equal(d.wrap.querySelector('.term-banner'), null, 'the zone says it, not the terminal');
  reply = terminalFailure('E_TERM_NOT_READY');
  assert.equal(await tab.type('q1: Yes'), false);
  assert.equal(d.wrap.querySelector('.term-banner').textContent, terminalFailure('E_TERM_NOT_READY').message);
  calls.length = 0;
  for (const bad of ['', 'q1: Yes\r', 'q1: \x1b[A']) assert.equal(await tab.type(bad), false);
  assert.deepEqual(calls, [], 'refused before the bridge');
  await tab.close();
});
