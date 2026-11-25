// The terminal as a native terminal shows it (the operator's review, 2026-10-02):
// fitTerminal centres the grid in its pane, across and down, with no width kept
// for a scrollbar tmux never uses; createGlyphRenderer puts xterm on its WebGL
// renderer, so box drawing is drawn, not taken from the font, and falls back to
// the DOM renderer when WebGL is missing or lost. jsdom has no layout: the pane's
// size is its declared style, and the xterm is a double with xterm's own shape.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fitTerminal, createGlyphRenderer, webgl2Supported } from "../renderer/terminal-tab.mjs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** A pane of `width`×`height` with the shipped 12px side gutters, holding an
 * xterm double whose renderer measured a `char` of that CSS size. Its render
 * dimensions follow xterm 5.5's own formulas for the current grid: the DOM
 * renderer's device cell is char × dpr, the WebGL renderer's is floored to
 * whole device pixels, and both round the screen to CSS pixels and report the
 * CSS cell as that extent divided by the count (DomRenderer._updateDimensions,
 * WebglRenderer._updateDimensions). */
function pane(t, { width, height, char = { width: 8, height: 17 }, ratio = 1, renderer = "dom", cols = 80, rows = 24 }) {
  const dom = new JSDOM(`<!doctype html><div class="term-wrap" style="width:${width}px;height:${height}px">
    <div class="xterm" style="padding:0 12px"><div class="xterm-screen"></div></div></div>`);
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "devicePixelRatio", { value: ratio });
  const element = dom.window.document.querySelector(".xterm");
  const calls = [];
  const device = { width: renderer === "webgl" ? Math.floor(char.width * ratio) : char.width * ratio, height: Math.ceil(char.height * ratio) };
  const term = {
    cols, rows, element,
    _core: { _renderService: {
      get dimensions() {
        const canvas = { width: Math.round(device.width * term.cols / ratio), height: Math.round(device.height * term.rows / ratio) };
        return { device: { cell: { ...device } }, css: { canvas, cell: { width: canvas.width / term.cols, height: canvas.height / term.rows } } };
      },
      clear: () => calls.push("clear"),
    } },
    resize(c, r) { calls.push(`resize ${c}x${r}`); this.cols = c; this.rows = r; },
  };
  const fit = { fit: () => calls.push("fit") };
  const wrap = element.parentElement;
  return { term, fit, calls, screen: element.querySelector(".xterm-screen"), resizePane: w => { wrap.style.width = `${w}px`; } };
}
/** The screen's CSS width and height as xterm sizes it for the current grid. */
const extent = term => term._core._renderService.dimensions.css.canvas;

test("fitTerminal fills the padded pane with whole cells and splits the rest evenly, across and down", t => {
  const p = pane(t, { width: 796, height: 600 });
  fitTerminal(p.term, p.fit);
  // 772 across: 96 cells of 8 (768), 4 left over; 600 down: 35 rows of 17 (595), 5 left over.
  assert.deepEqual(p.calls, ["clear", "resize 96x35"], "the renderer is cleared, then the grid resized; FitAddon is not used");
  assert.equal(p.screen.style.marginLeft, "2px", "half the rest on each side");
  assert.equal(p.screen.style.marginTop, "2px", "2.5px floors to the whole device pixel at 1×");
  p.calls.length = 0;
  fitTerminal(p.term, p.fit);
  assert.deepEqual(p.calls, [], "an unchanged grid is not resized again");
});

test("fitTerminal keeps no width for xterm's scrollbar: the gutters match", t => {
  // FitAddon would keep 15px for the scrollbar: 742 / 8 = 92 columns, the right gutter 21px wider.
  const p = pane(t, { width: 781, height: 340 });
  fitTerminal(p.term, p.fit);
  assert.equal(p.term.cols, 94, "757px of grid width: 94 cells");
  assert.equal(p.screen.style.marginLeft, "2px", "the 5px rest, halved, in whole device pixels");
  assert.equal(p.term.rows, 20);
  assert.equal(p.screen.style.marginTop, "0px");
  assert.match(read("renderer/shell.css"), /\.term-wrap \.xterm-viewport \{ scrollbar-width: none; \}\n\.term-wrap \.xterm-viewport::-webkit-scrollbar \{ display: none; \}/,
    "the scrollbar is hidden on terminal tabs, so the grid can take its width");
});

test("no classic scrollbar on Linux: a terminal's pane never scrolls, and the tab strips scroll without one", () => {
  const css = read("renderer/shell.css");
  assert.match(css, /\.term-wrap \{ overflow: hidden; \}\n\.tab-pane:has\(> \.term-wrap\) \{ overflow: hidden; \}/,
    "a pane holding a terminal clips; xterm and tmux scroll");
  assert.match(css, /#tabbar, \.group-tabbar \{[^}]* scrollbar-width: none; \}\n#tabbar::-webkit-scrollbar, \.group-tabbar::-webkit-scrollbar \{ display: none; \}/,
    "the flat strip and every split group's strip hide their scrollbar");
  assert.match(css, /#tabbar \{[^}]*overflow-x: auto;/, "the flat strip still scrolls");
  assert.match(css, /\.group-tabbar \{[^}]*overflow-x: auto;/, "a group strip still scrolls");
});

test("fitTerminal rounds the centring margin to device pixels, so glyphs stay sharp", t => {
  const p = pane(t, { width: 397.5, height: 600, ratio: 2 }); // a split half: 373.5px across
  fitTerminal(p.term, p.fit);
  assert.equal(p.term.cols, 46); // 368px of grid, 5.5px left over
  assert.equal(p.screen.style.marginLeft, "2.5px", "2.75px floors to the 0.5px device grid at 2×");
  assert.equal(p.screen.style.marginTop, "2.5px");
});

test("fitTerminal is stable at a fractional pane width: repeated fits never flip the grid or overflow (review round 8)", t => {
  // Inconsolata 15px at 2×: a 7.5px cell. 391.5 − 24 = 367.5px across: 49 cells would round to 368px.
  const p = pane(t, { width: 391.5, height: 600, char: { width: 7.5, height: 16 }, ratio: 2 });
  for (let i = 0; i < 4; i++) fitTerminal(p.term, p.fit);
  assert.deepEqual(p.calls, ["clear", "resize 48x37"], "one resize, then nothing: the count does not depend on itself");
  assert.equal(extent(p.term).width, 360);
  assert.equal(p.screen.style.marginLeft, "3.5px", "never negative: the rounded screen fits the box");
  // Every quarter pixel across a split-sized range, both renderers, 1× and 2×.
  for (const renderer of ["dom", "webgl"]) for (const ratio of [1, 2]) for (const char of [{ width: 7.5, height: 16 }, { width: 8.43, height: 16 }]) {
    const q = pane(t, { width: 360, height: 333.5, char, ratio, renderer });
    for (let width = 360; width <= 420; width += 0.25) { // several cell boundaries, every quarter pixel
      q.resizePane(width);
      fitTerminal(q.term, q.fit);
      const grid = `${q.term.cols}x${q.term.rows}`, size = extent(q.term), cell = size.width / q.term.cols;
      fitTerminal(q.term, q.fit); fitTerminal(q.term, q.fit);
      const label = `${renderer} ${ratio}× ${char.width}px at ${width}px`;
      assert.equal(`${q.term.cols}x${q.term.rows}`, grid, `${label}: refits keep the grid`);
      assert.ok(size.width <= width - 24 && size.height <= 333.5, `${label}: the screen fits the padded box`);
      assert.ok(width - 24 - size.width < 2 * cell, `${label}: the grid gives up less than two cells to rounding`);
      assert.ok(Number.parseFloat(q.screen.style.marginLeft) >= 0 && Number.parseFloat(q.screen.style.marginTop) >= 0, `${label}: margins`);
    }
  }
});

test("fitTerminal leaves an unmeasured or hidden pane to FitAddon", t => {
  const unmeasured = pane(t, { width: 796, height: 600, char: { width: 0, height: 0 } });
  fitTerminal(unmeasured.term, unmeasured.fit);
  assert.deepEqual(unmeasured.calls, ["fit"]);
  const hidden = pane(t, { width: 0, height: 0 });
  fitTerminal(hidden.term, hidden.fit);
  assert.deepEqual(hidden.calls, ["fit"], "a hidden pane has no size: FitAddon's own no-op");
  const calls = [];
  fitTerminal({}, { fit: () => calls.push("fit") });
  assert.deepEqual(calls, ["fit"], "a terminal not opened yet");
});

/** A WebglAddon double: records its life, and can fail where WebGL would. */
function webgl({ failConstruct = false } = {}) {
  const made = [];
  class Addon {
    constructor() { if (failConstruct) throw new Error("WebGL2 unavailable"); this.disposed = 0; made.push(this); }
    onContextLoss(fn) { this.lose = fn; return { dispose() {} }; }
    dispose() { this.disposed++; }
  }
  return { Addon, made };
}
function xterm({ opened = true, failLoad = false } = {}) {
  const loaded = [];
  return { loaded, element: opened ? {} : undefined, loadAddon(addon) { if (failLoad) throw new Error("context creation failed"); loaded.push(addon); } };
}

test("createGlyphRenderer loads the WebGL renderer once the terminal is open, and only once", () => {
  const { Addon, made } = webgl(), term = xterm({ opened: false });
  let changes = 0;
  const glyphs = createGlyphRenderer({ term, Addon, onChange: () => changes++, supported: () => true });
  assert.equal(glyphs.ensure(), false, "xterm refuses addons that need a renderer before open()");
  assert.equal(made.length, 0);
  term.element = {};
  assert.equal(glyphs.ensure(), true);
  assert.equal(glyphs.ensure(), true);
  assert.deepEqual([made.length, term.loaded.length, changes, glyphs.active], [1, 1, 1, true], "one addon; the cell size may change, so one refit");
});

test("a lost WebGL context falls back to the DOM renderer, and showing the tab tries again", () => {
  const { Addon, made } = webgl(), term = xterm();
  let changes = 0, recovered = 0;
  const glyphs = createGlyphRenderer({ term, Addon, onChange: () => changes++, onRecovered: () => recovered++, supported: () => true });
  glyphs.ensure();
  assert.equal(recovered, 0, "a first activation joins a sound atlas: no window-wide clear");
  made[0].lose(); // Chromium dropped the context and did not restore it within addon-webgl's 3 s
  assert.deepEqual([glyphs.active, made[0].disposed, changes], [false, 1, 2], "disposed: xterm goes back to its DOM renderer, and refits");
  made[0].lose();
  assert.equal(made[0].disposed, 1, "a second loss of the dropped addon is ignored");
  assert.equal(recovered, 0, "nothing to recover until WebGL is back");
  assert.equal(glyphs.ensure(), true, "the next show loads a fresh one");
  assert.equal(made.length, 2);
  assert.equal(recovered, 1, "the fresh addon re-joins the shared atlas the loss left stale: the window-wide clear is asked for (#1190)");
  glyphs.ensure();
  assert.equal(recovered, 1, "once per loss, not on every show");
  glyphs.dispose(); // the tab closed: not a loss
  glyphs.ensure();
  assert.deepEqual([made.length, recovered], [3, 1], "a reload after a plain dispose asks for nothing");
});

test("a recovery request that throws does not undo the fresh addon (#1190)", () => {
  const { Addon, made } = webgl(), term = xterm();
  const glyphs = createGlyphRenderer({ term, Addon, onRecovered: () => { throw new Error("recovery failed"); }, supported: () => true });
  glyphs.ensure(); made[0].lose();
  assert.equal(glyphs.ensure(), true);
  assert.deepEqual([glyphs.active, made[1].disposed], [true, 0], "WebGL stays on: the request is a side effect, not part of the activation");
});

test("without WebGL2 the addon is never activated, however often the tab is shown (review round 8)", () => {
  // addon-webgl 0.18 adds a link-layer canvas and listeners before it asks for
  // the context, and a throw there escapes its dispose: no WebGL2, no attempt.
  const { Addon, made } = webgl(), term = xterm();
  let asked = 0;
  const glyphs = createGlyphRenderer({ term, Addon, supported: () => { asked++; return false; } });
  for (let i = 0; i < 5; i++) assert.equal(glyphs.ensure(), false);
  assert.deepEqual([made.length, term.loaded.length, asked], [0, 0, 5], "nothing constructed or loaded");
  assert.equal(createGlyphRenderer({ term, Addon: undefined, supported: () => true }).ensure(), false, "the addon script did not load");
});

test("the shipped WebGL2 probe asks again after a no, so a later show recovers; a yes is kept (review round 9)", () => {
  // The only test that uses the module's own probe: every other one injects `supported`.
  let probes = 0, answer = null, released = 0;
  const doc = { createElement: () => ({ getContext: kind => { probes++; return kind === "webgl2" ? answer : null; } }) };
  const { Addon, made } = webgl(), term = { ...xterm(), element: { ownerDocument: doc } };
  const glyphs = createGlyphRenderer({ term, Addon });
  assert.equal(glyphs.ensure(), false); assert.equal(glyphs.ensure(), false);
  assert.deepEqual([probes, made.length], [2, 0], "unavailable: asked on every show, never activated");
  answer = { getExtension: name => (name === "WEBGL_lose_context" ? { loseContext: () => released++ } : null) };
  assert.equal(glyphs.ensure(), true, "available again: the next show loads WebGL");
  assert.deepEqual([probes, released, made.length], [3, 1, 1], "the probe's own context is released at once");
  assert.equal(webgl2Supported(doc), true);
  assert.equal(probes, 3, "a yes is not asked again");
});

test("an activation that throws although WebGL2 was there is not retried for that terminal (it stays on DOM until reopened); a lost context still is", () => {
  for (const failing of [{ addon: { failConstruct: true }, term: {} }, { addon: {}, term: { failLoad: true } }]) {
    const { Addon, made } = webgl(failing.addon);
    let changes = 0, attempts = 0;
    const Counted = class extends Addon { constructor() { attempts++; super(); } };
    const glyphs = createGlyphRenderer({ term: xterm(failing.term), Addon: Counted, onChange: () => changes++, supported: () => true });
    for (let i = 0; i < 4; i++) assert.equal(glyphs.ensure(), false);
    assert.equal(attempts, 1, "one attempt: whatever it left behind is not multiplied by every show");
    assert.deepEqual([changes, glyphs.active], [0, false], "the DOM renderer stays, nothing to refit");
    if (made[0]) assert.equal(made[0].disposed, 1, "a half-made addon is disposed");
  }
});

test("terminal tabs are wired to both: WebGL after open and on show, centred fits everywhere", () => {
  const shell = read("renderer/shell.mjs"), html = read("renderer/index.html");
  const pkg = JSON.parse(read("package.json"));
  assert.match(shell, /createGlyphRenderer\(\{ term, Addon: globalThis\.WebglAddon\?\.WebglAddon,/);
  assert.match(shell, /term\.open\(wrap\);\n  glyphs\.ensure\(\);\n  fitTerminal\(term, fit\);/, "WebGL needs an opened terminal, and may change the cell");
  assert.match(shell, /onShow: \(\) => \{ requestAnimationFrame\(\(\) => \{ try \{ glyphs\.ensure\(\); fitTerminal\(term, fit\); \} catch \{\} \}\); \},/);
  assert.match(shell, /fit: \(\) => fitTerminal\(term, fit\),/, "the pane's ResizeObserver refits through the same centring");
  const xtermAt = html.indexOf("@xterm/xterm/lib/xterm.js"), webglAt = html.indexOf('<script src="../node_modules/@xterm/addon-webgl/lib/addon-webgl.js"></script>');
  assert.ok(xtermAt > 0 && webglAt > xtermAt, "the addon loads after xterm, from the app's own node_modules");
  assert.equal(pkg.dependencies["@xterm/addon-webgl"], "^0.18.0", "the addon line built for xterm 5");
  assert.match(pkg.dependencies["@xterm/xterm"], /^\^5\./);
});
