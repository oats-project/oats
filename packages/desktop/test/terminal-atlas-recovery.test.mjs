// Terminals draw again after a GPU process restart (#1190): one debounced pass
// clears the glyph atlas of every live terminal in the window, after the last
// webglcontextrestored. The real GPU restart needs Electron; these pin the
// debounce, the pass and the shell's wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createTerminalAtlasRecovery, ATLAS_RECOVERY_SETTLE_MS } from "../renderer/terminal-atlas-recovery.mjs";

const shellSource = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");

/** A document double that records its listeners, with how they were added. */
function fakeDocument() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }); },
    removeEventListener(type, fn, options) {
      const at = listeners.findIndex(l => l.type === type && l.fn === fn && Boolean(l.options) === Boolean(options));
      if (at >= 0) listeners.splice(at, 1);
    },
    restore() { for (const l of [...listeners]) if (l.type === "webglcontextrestored") l.fn({ type: l.type }); },
  };
}
/** An xterm Terminal double that logs its clears in one shared order. */
function terminal(name, log, { hidden = false, fails = false } = {}) {
  return { name, hidden, clearTextureAtlas() { log.push(name); if (fails) throw new Error(`${name} is disposed`); } };
}

test("a burst of restores gives one pass, the delay after the last one", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(ATLAS_RECOVERY_SETTLE_MS, 250);
  const doc = fakeDocument(), log = [];
  const terms = [terminal("a", log), terminal("b", log)];
  const recovery = createTerminalAtlasRecovery({ doc, terminals: () => terms });
  t.after(() => recovery.dispose());
  doc.restore(); // one context restored, the others follow within the settle
  t.mock.timers.tick(200); doc.restore();
  t.mock.timers.tick(200); doc.restore();
  t.mock.timers.tick(ATLAS_RECOVERY_SETTLE_MS - 1);
  assert.deepEqual(log, [], "each restore restarts the wait: a clear under terminals still re-uploading garbles them");
  t.mock.timers.tick(1);
  assert.deepEqual(log, ["a", "b"], "one pass, the delay after the last restore");
  t.mock.timers.tick(10 * ATLAS_RECOVERY_SETTLE_MS);
  assert.deepEqual(log, ["a", "b"], "and only one");
});

test("the pass reaches every live terminal, hidden tabs included, synchronously in one tick", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = fakeDocument(), log = [];
  let terms = [terminal("shown", log)];
  const recovery = createTerminalAtlasRecovery({ doc, terminals: () => terms });
  t.after(() => recovery.dispose());
  doc.restore();
  // The list is read when the pass runs: a tab opened meanwhile is cleared too.
  terms = [terminal("shown", log), terminal("hidden tab", log, { hidden: true }), terminal("other workspace", log, { hidden: true })];
  t.mock.timers.tick(ATLAS_RECOVERY_SETTLE_MS);
  assert.deepEqual(log, ["shown", "hidden tab", "other workspace"], "all of them, in the timer's own callback: no await between two clears");
});

test("a terminal that throws, or is disposed, does not stop the others", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = fakeDocument(), log = [];
  const terms = [terminal("a", log), terminal("disposed", log, { fails: true }), { name: "no method" }, null, terminal("b", log)];
  const recovery = createTerminalAtlasRecovery({ doc, terminals: () => terms });
  t.after(() => recovery.dispose());
  doc.restore();
  assert.doesNotThrow(() => t.mock.timers.tick(ATLAS_RECOVERY_SETTLE_MS));
  assert.deepEqual(log, ["a", "disposed", "b"]);
  let calls = 0;
  const broken = createTerminalAtlasRecovery({ doc: fakeDocument(), terminals: () => { calls++; throw new Error("tabs unreadable"); } });
  t.after(() => broken.dispose());
  broken.schedule();
  assert.doesNotThrow(() => t.mock.timers.tick(ATLAS_RECOVERY_SETTLE_MS));
  assert.equal(calls, 1, "an unreadable list ends the pass quietly");
});

test("the restore is heard in the capture phase, from a canvas anywhere in the document (the event does not bubble)", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = fakeDocument();
  const recovery = createTerminalAtlasRecovery({ doc, terminals: () => [] });
  t.after(() => recovery.dispose());
  assert.deepEqual(doc.listeners.map(l => [l.type, l.options]), [["webglcontextrestored", true]]);
  // The same with a real DOM: a non-bubbling event on a terminal's canvas.
  const dom = new JSDOM(`<div class="term-wrap"><div class="xterm"><canvas></canvas></div></div>`);
  t.after(() => dom.window.close());
  const log = [];
  const real = createTerminalAtlasRecovery({ doc: dom.window.document, terminals: () => [terminal("t", log)] });
  t.after(() => real.dispose());
  dom.window.document.querySelector("canvas").dispatchEvent(new dom.window.Event("webglcontextrestored", { bubbles: false }));
  t.mock.timers.tick(ATLAS_RECOVERY_SETTLE_MS);
  assert.deepEqual(log, ["t"]);
});

test("schedule() enters the same debounce as a restore", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = fakeDocument(), log = [];
  const recovery = createTerminalAtlasRecovery({ doc, terminals: () => [terminal("a", log)] });
  t.after(() => recovery.dispose());
  doc.restore();
  t.mock.timers.tick(100); recovery.schedule(); // a loss path reloaded WebGL meanwhile
  t.mock.timers.tick(ATLAS_RECOVERY_SETTLE_MS - 1);
  assert.deepEqual(log, []);
  t.mock.timers.tick(1);
  assert.deepEqual(log, ["a"], "one pass for both");
});

test("dispose() removes the listener and the pending pass", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const doc = fakeDocument(), log = [];
  const recovery = createTerminalAtlasRecovery({ doc, terminals: () => [terminal("a", log)] });
  doc.restore();
  recovery.dispose();
  assert.equal(doc.listeners.length, 0, "the capture listener is gone");
  t.mock.timers.tick(10 * ATLAS_RECOVERY_SETTLE_MS);
  assert.deepEqual(log, [], "the pending pass never runs");
  recovery.schedule();
  t.mock.timers.tick(10 * ATLAS_RECOVERY_SETTLE_MS);
  assert.deepEqual(log, [], "and schedule() after dispose does nothing");
});

test("the shell makes one recovery for the window, over every terminal in the tabs map, and a loss path's reload asks it", () => {
  const line = shellSource.match(/^const atlasRecovery = createTerminalAtlasRecovery\([^\n]+/m);
  assert.ok(line, "created once, at the top level of the shell");
  assert.equal(shellSource.match(/createTerminalAtlasRecovery\(/g).length, 1);
  let made = null;
  const hidden = { clearTextureAtlas() {} }, shown = { clearTextureAtlas() {} };
  const tabs = new Map([
    [1, { kind: "terminal", workspace: "A", paneEl: { hidden: false }, term: shown }],
    [2, { kind: "terminal", workspace: "B", paneEl: { hidden: true }, term: hidden }], // another workspace's hidden tab
    [3, { kind: "file", workspace: "A", paneEl: { hidden: true } }],
  ]);
  const document = {};
  runInNewContext(line[0], { createTerminalAtlasRecovery: options => (made = options), tabs, document });
  assert.equal(made.doc, document, "listens on the window's document");
  assert.deepEqual([...made.terminals()], [shown, hidden], "every terminal tab, whatever its workspace or visibility; other tabs have none");
  tabs.set(4, { kind: "terminal", term: { clearTextureAtlas() {} } });
  assert.equal(made.terminals().length, 3, "read live, so the module holds no terminal of its own");
  assert.match(shellSource, /onRecovered: \(\) => atlasRecovery\.schedule\(\) \}\);/, "the glyph renderer's reload after a loss enters the same debounce");
  assert.match(shellSource, /function addTab\(\{[^\n]*term = null \}\) \{/);
  assert.match(shellSource, /tabs\.set\(id, \{[^\n]*focusContent, term \}\);/, "addTab keeps the tab's terminal");
  assert.match(shellSource, /focusOnActivate: focusContent,[^\n]*\n    term, /, "a terminal tab hands its xterm to addTab");
});
