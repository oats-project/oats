import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { mount } from "../renderer/views/markdown.mjs";
import { createTabChrome, tabNameTailStart, TAB_TAIL_CHARS } from "../renderer/tab-a11y.mjs";

const shellCss = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
const sample = `// Read-only supporting code
function greet(name) {
  const message = "hello";
  return message + 42;
}`;

function fixture(t, css = "") {
  const dom = new JSDOM("<!doctype html><html><head></head><body><main></main></body></html>", {
    url: "http://127.0.0.1/",
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement("style");
  style.textContent = css;
  doc.head.append(style);
  return { doc, window: dom.window, host: doc.querySelector("main") };
}

function declaration(doc, selector, property) {
  const rules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const rule = rules.find(rule => rule.selectorText === selector);
  assert.ok(rule, `shipped stylesheet contains ${selector}`);
  return rule.style.getPropertyValue(property);
}

// Workspace v4 (human decision 2026-09-26; replaces the one-row header placement): the
// Souls toolbar is the view's own row; it may wrap at narrow widths and its search
// shrinks (min-width 0) rather than overflowing the stage.
test("Souls toolbar shrinks its filter instead of overflowing the narrow workspace stage", t => {
  const spawn = readFileSync(new URL("../renderer/views/spawn.mjs", import.meta.url), "utf8");
  const discovery = readFileSync(new URL("../renderer/workspace-discovery.mjs", import.meta.url), "utf8");
  const css = spawn.match(/const CSS = `([\s\S]*?)`;/)[1] + discovery.match(/\.ws-toolbar \{[^\n]*\n(?:\.ws-[^\n]*\n|\.oats-view \.ws-search[^\n]*\n)*/)[0];
  const { doc, host, window } = fixture(t, css);
  const bar = doc.createElement("div"); bar.className = "souls-bar ws-toolbar"; host.append(bar);
  assert.equal(window.getComputedStyle(bar).flexWrap, "wrap", "controls wrap rather than overflow");
  assert.equal(declaration(doc, ".ws-toolbar", "min-width"), "0px");
  assert.equal(declaration(doc, ".ws-search", "min-width"), "0px", "the search can shrink");
  assert.equal(declaration(doc, ".souls-bar", "height"), "", "no fixed height");
  assert.equal(declaration(doc, ".souls-bar", "min-height"), "", "no second 48px floor");
});

// jsdom exercises the shipped markup + CSS cascade, not browser layout or
// resolved custom-property colors. theme-contrast.test.mjs separately resolves
// both palettes and composites md-code-bg over the view's painted background.
for (const kind of ["picked JavaScript", "picked Markdown", "path Markdown"]) {
  test(`${kind}: real highlight markup receives semantic colors and stays read-only`, async t => {
    const { doc, host, window } = fixture(t);
    const copies = [], requests = [];
    Object.defineProperty(window.navigator, "clipboard", { value: {
      writeText: async text => { copies.push(text); },
    } });
    const markdown = kind !== "picked JavaScript";
    const content = markdown ? `# Supporting document\n\n\`\`\`js\n${sample}\n\`\`\`\n
<a href="https://example.com/help" target="_self" rel="opener" onclick="bad()">external</a>
<script>bad()</script><img src=x onerror="bad()"><button>Save</button>` : sample;
    const name = markdown ? "notes.md" : "support.js";
    const ctx = {
      api: async path => {
        requests.push(path);
        assert.equal(kind, "path Markdown", "browser picks never call the API");
        return { path: "/ws/notes.md", name, markdown, content, size: content.length };
      },
      openFile: () => assert.fail("coloring never navigates to another file"),
      openTerminal: () => assert.fail("read-only code must never be sent to a terminal"),
      ...(kind === "path Markdown" ? { path: "/ws/notes.md" } : { pickedFile: new File([content], name) }),
    };
    const dispose = await mount(host, ctx);
    t.after(dispose);
    const code = host.querySelector("pre.md-code > code.hljs");
    assert.equal(code.textContent, sample, "highlighting preserves the exact code text");
    for (const [selector, token] of [
      ["code.hljs", "fg"], [".hljs-comment", "muted"], [".hljs-keyword", "violet"],
      [".hljs-title", "accent"], [".hljs-string", "ok"], [".hljs-number", "warn"], [".hljs-params", "fg"],
    ]) {
      const node = host.querySelector(selector);
      assert.ok(node, `real highlighter emits ${selector}`);
      assert.equal(window.getComputedStyle(node).color, `var(--${token})`, `${selector} is not monochrome`);
    }
    assert.equal(declaration(doc, ".mdv-scroll", "background"), "var(--bg)");
    assert.equal(declaration(doc, ".mdv pre.md-code", "background"), "var(--md-code-bg)");
    assert.equal(host.querySelector(".mdv script, input, textarea, select, [contenteditable], [onclick], [onerror]"), null);
    if (markdown) {
      const external = host.querySelector('a[href="https://example.com/help"]');
      assert.equal(external.target, "_blank");
      assert.equal(external.rel, "noreferrer noopener", "raw external anchors remain sanitized");
    }
    const controls = [...host.querySelectorAll("button")];
    assert.equal(controls.length, 1, "only a copy control; no editor/save/terminal-send controls");
    assert.equal(controls[0].getAttribute("aria-label"), "Copy code block");
    controls[0].click();
    await Promise.resolve();
    assert.deepEqual(copies, [sample], "copy exports original text, not highlighter markup");
    assert.deepEqual(requests, kind === "path Markdown" ? ["/api/file?path=%2Fws%2Fnotes.md"] : []);
  });
}

test("standard hljs scopes are styled locally, including nested meta and substitution tokens", async t => {
  const { doc, host, window } = fixture(t);
  t.after(await mount(host, { pickedFile: new File([sample], "support.js") }));
  const code = host.querySelector("code.hljs");
  const scopes = {
    fg: ["subst", "params", "property", "punctuation", "operator", "tag", "template-tag", "code"],
    muted: ["comment", "quote"],
    violet: ["keyword", "selector-tag", "doctag", "meta"],
    accent: ["title", "section", "name", "attr", "attribute", "selector-id", "selector-class", "selector-attr", "selector-pseudo", "link"],
    ok: ["string", "regexp", "addition"],
    warn: ["number", "literal", "type", "built_in", "symbol", "bullet", "variable", "template-variable", "deletion"],
  };
  for (const [token, categories] of Object.entries(scopes)) {
    for (const category of categories) {
      const span = doc.createElement("span");
      span.className = `hljs-${category}`;
      span.textContent = category;
      code.append(span);
      assert.equal(window.getComputedStyle(span).color, `var(--${token})`, category);
    }
  }
  const meta = doc.createElement("span");
  meta.className = "hljs-meta";
  meta.innerHTML = '<span class="hljs-keyword">include</span><span class="hljs-string">header</span>';
  code.append(meta);
  assert.equal(window.getComputedStyle(meta.firstChild).color, "var(--violet)");
  assert.equal(window.getComputedStyle(meta.lastChild).color, "var(--ok)");
  const template = doc.createElement("span");
  template.className = "hljs-string";
  template.innerHTML = '<span class="hljs-subst">value</span>';
  code.append(template);
  assert.equal(window.getComputedStyle(template.firstChild).color, "var(--fg)");
  const outside = doc.createElement("span");
  outside.className = "hljs-keyword";
  host.append(outside);
  assert.notEqual(window.getComputedStyle(outside).color, "var(--violet)", "reader styles do not leak outside .mdv");
});

// Spec F (2026-10-01; supersedes "strips scroll instead of compressing"): tabs fit the strip
// like VS Code's "shrink" sizing. jsdom has no layout: this pins the shipped rules; the live
// check (narrow and wide windows, many tabs) proves the geometry.
test("flat and grouped strips share their width: tabs shrink evenly to a floor, then the strip scrolls", t => {
  const { doc, host, window } = fixture(t, shellCss);
  for (const grouped of [false, true]) {
    const bar = doc.createElement("div");
    if (grouped) bar.className = "group-tabbar";
    else bar.id = "tabbar";
    bar.style.width = "165.5px";
    const tabs = [["A-reviewer"], ["A-desktop-engineer-with-a-long-name", { dot: "on", detail: "feat/a-long-branch" }]].map(([title, decor], i) =>
      createTabChrome(doc, `${grouped}-${i}`, title, false, decor));
    for (const tab of tabs) bar.append(tab.tabEl);
    const actions = doc.createElement("div");
    actions.id = "tab-actions";
    const control = doc.createElement("button");
    control.textContent = "Split";
    actions.append(control);
    bar.append(actions);
    host.append(bar);
    assert.equal(window.getComputedStyle(bar).overflowX, "auto", "below the floor the strip scrolls");
    assert.equal(window.getComputedStyle(bar).minWidth, "0px");
    for (const { tabEl, triggerEl, closeEl } of tabs) {
      const style = window.getComputedStyle(tabEl);
      assert.deepEqual([style.flexGrow, style.flexShrink, style.flexBasis], ["1", "1", "0px"], "equal shares from one zero basis");
      assert.equal(style.maxWidth, "fit-content", "never wider than its natural width");
      assert.equal(style.minWidth, "var(--tab-min)", "the floor holds in group strips too");
      assert.equal(style.getPropertyValue("--tab-min"), "176px", "the number, the dot, \"oats-…\" and an 8-character tail stay visible");
      assert.equal(style.getPropertyValue("--tab-max"), "280px", "the Redesign v3 long-label cap");
      assert.equal(style.getPropertyValue("--tab-chrome"), "44px", "padding 12 + 4, gap 8 and the 20px close (slice 3d's pills: no border)");
      assert.equal(style.whiteSpace, "nowrap");
      assert.equal(window.getComputedStyle(triggerEl).maxWidth, "calc(var(--tab-max) - var(--tab-chrome))", "the cap rides on the trigger");
      assert.equal(window.getComputedStyle(triggerEl.querySelector(".tab-label")).textOverflow, "ellipsis", "long labels ellipsize");
      assert.equal(window.getComputedStyle(triggerEl).minWidth, "0px", "the trigger yields width to its label, not to Close");
      assert.equal(window.getComputedStyle(closeEl).flexShrink, "0", "Close remains a usable control on every tab");
      assert.equal(triggerEl.title, triggerEl.getAttribute("aria-label"), "the full name stays in title and the accessible name");
    }
    // The branch gives way first: it grows from zero into what the name leaves, and its gap is its own.
    const detail = window.getComputedStyle(tabs[1].triggerEl.querySelector(".tab-detail"));
    assert.deepEqual([detail.flexGrow, detail.flexBasis, detail.minWidth], ["1", "0px", "0px"]);
    assert.deepEqual([detail.marginLeft, detail.paddingLeft], ["-8px", "8px"], "a hidden branch takes no gap from the name");
    // The name grows from its minimum (tab-numbers.test.mjs) to its whole width and no further, weighted
    // 1000:1 over the branch, so the branch only takes what the whole name leaves.
    const label = window.getComputedStyle(tabs[1].triggerEl.querySelector(".tab-label"));
    assert.deepEqual([label.flexGrow, label.maxWidth], ["1000", "max-content"], "the name never grows at the branch's expense");
    assert.equal(window.getComputedStyle(actions).flexShrink, "0", "do not remove or compress group controls");
    assert.deepEqual([...bar.children], [...tabs.map(tab => tab.tabEl), actions], "no reordering or auto-collapse");
    bar.remove();
  }
});

// Spec F return: shrunk tabs stay distinguishable. Instance names share long
// prefixes (the soul), so the head ellipsizes and the end of the name stays.
test("tabNameTailStart keeps a name's last characters, or what follows the soul when shorter, without a leading separator", () => {
  const split = (name, soul) => { const at = tabNameTailStart(name, soul); return at == null ? null : [name.slice(0, at), name.slice(at)]; };
  assert.equal(TAB_TAIL_CHARS, 8);
  assert.deepEqual(split("oats-desktop-developer-tabs-palette", "oats-desktop-developer"), ["oats-desktop-developer-tabs-", "palette"]);
  assert.deepEqual(split("oats-desktop-developer-spawn-flow", "oats-desktop-developer"), ["oats-desktop-developer-sp", "awn-flow"]);
  assert.deepEqual(split("oats-desktop-developer-ui", "oats-desktop-developer"), ["oats-desktop-developer-", "ui"], "the part after the soul, when shorter");
  assert.deepEqual(split("oats-desktop-developer-tabs-palette", null), ["oats-desktop-developer-tabs-", "palette"], "no soul: the last characters");
  assert.deepEqual(split("oats-desktop-developer-tabs-palette", { not: "a string" }), ["oats-desktop-developer-tabs-", "palette"], "a malformed soul is ignored");
  assert.equal(tabNameTailStart("reviewer", "x"), null, "a name no longer than the tail is never split");
  assert.equal(tabNameTailStart("--------", ""), null, "nothing but separators: nothing to keep");
});

test("two shrunk tabs whose names share a prefix still read differently: the tail never shrinks", t => {
  const { doc, host, window } = fixture(t, shellCss);
  const bar = doc.createElement("div");
  bar.id = "tabbar";
  bar.style.width = "200px"; // narrower than two floors: both tabs sit at --tab-min
  const soul = "oats-desktop-developer";
  const names = ["oats-desktop-developer-tabs-palette", "oats-desktop-developer-spawn-flow"];
  const tabs = names.map((name, i) => createTabChrome(doc, `t${i}`, name, false, { dot: "on", tailAt: tabNameTailStart(name, soul) }));
  for (const tab of tabs) bar.append(tab.tabEl);
  host.append(bar);
  const parts = tabs.map(({ triggerEl }) => [...triggerEl.querySelector(".tab-label.split").children]);
  assert.deepEqual(parts.map(p => p.map(el => el.className)), [["tab-head", "tab-tail"], ["tab-head", "tab-tail"]]);
  assert.deepEqual(parts.map(([head]) => head.textContent), ["oats-desktop-developer-tabs-", "oats-desktop-developer-sp"]);
  assert.deepEqual(parts.map(([, tail]) => tail.textContent), ["palette", "awn-flow"], "what stays visible differs");
  for (const [head, tail] of parts) {
    const h = window.getComputedStyle(head), tl = window.getComputedStyle(tail);
    assert.deepEqual([h.minWidth, h.overflow, h.textOverflow, h.whiteSpace], ["0px", "hidden", "ellipsis", "nowrap"], "the shared head gives way first");
    assert.deepEqual([tl.flexShrink, tl.flexGrow, tl.whiteSpace], ["0", "0", "nowrap"], "the tail keeps its width at the floor");
    assert.equal(window.getComputedStyle(head.parentElement).display, "flex");
  }
  tabs.forEach(({ triggerEl }, i) => {
    assert.equal(triggerEl.querySelector(".tab-label").textContent, names[i], "a name that fits reads whole");
    assert.equal(triggerEl.title, names[i]);
    assert.equal(triggerEl.getAttribute("aria-label"), names[i], "the accessible name is the whole name, never the split");
  });
  // A short or unsplit name keeps the plain ellipsizing label.
  const plain = createTabChrome(doc, "p", "README.md", false, { kind: "file" });
  assert.equal(plain.triggerEl.querySelector(".tab-label").children.length, 0);
  assert.equal(plain.triggerEl.querySelector(".tab-label").textContent, "README.md");
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  // The dot also carries the instance's colour (#1421 §2, instance-dot.mjs dotColor); the split is unchanged.
  assert.match(shell, /decor: \{ dot: inst\.running \? "on" : "off", color: dotColor\(inst, inst\.running \? "running" : "stopped"\), tailAt: tabNameTailStart\(name, inst\.agent\), tailEnd: name\.length \}/,
    "terminal tabs split at the soul-aware tail, which ends with the name");
});

test("a remote tab's host follows the protected tail in its own span and gives way first", t => {
  const { doc, host, window } = fixture(t, shellCss);
  const name = "oats-desktop-developer-tabs-palette", title = `${name} · production-west`;
  const { triggerEl } = createTabChrome(doc, "r", title, false, { dot: "on", tailAt: tabNameTailStart(name, "oats-desktop-developer"), tailEnd: name.length });
  host.append(triggerEl);
  const parts = [...triggerEl.querySelector(".tab-label.split").children];
  assert.deepEqual(parts.map(el => [el.className, el.textContent]),
    [["tab-head", "oats-desktop-developer-tabs-"], ["tab-tail", "palette"], ["tab-rest", " · production-west"]], "the tail stays the name's own end");
  const rest = window.getComputedStyle(parts[2]);
  assert.deepEqual([rest.minWidth, rest.overflow, rest.textOverflow, rest.flexShrink], ["0px", "hidden", "ellipsis", "1000"],
    "the host is metadata: it shrinks before the head (flex-shrink is weighted 1000:1)");
  assert.equal(window.getComputedStyle(parts[0]).flexShrink, "1");
  assert.equal(triggerEl.getAttribute("aria-label"), title, "the accessible name keeps the host");
  assert.equal(triggerEl.title, title);
  // An out-of-range end never protects more than the title holds.
  const clamp = createTabChrome(doc, "c", name, false, { tailAt: 28, tailEnd: 99 });
  assert.deepEqual([...clamp.triggerEl.querySelector(".tab-label").children].map(el => el.textContent), ["oats-desktop-developer-tabs-", "palette"]);
});

// jsdom has no layout, so the geometry is proven live (renderer harness, Chromium,
// the shipped system UI face at 12.5px; the hand-back records it). This pins the
// floor's budget to those measurements, so a smaller floor or a wider chrome fails here.
test("the tab floor budgets the chrome, the dot, the name's start and the widest real tail, all in bold", t => {
  const { doc, host, window } = fixture(t, shellCss);
  const { tabEl } = createTabChrome(doc, "b", "x", false, { dot: "on" });
  host.append(tabEl);
  const px = name => Number.parseFloat(window.getComputedStyle(tabEl).getPropertyValue(name));
  const MEASURED_BOLD = { start: 43.7 /* "oats-…" */, tail: 56.5 /* "awn-flow", the widest real 8-character tail */ };
  const DOT_AND_GAP = 7 + 8, NUMBER_AND_GAP = 7 + 8; // slice 3d: the number leads every numbered tab
  const need = px("--tab-chrome") + NUMBER_AND_GAP + DOT_AND_GAP + MEASURED_BOLD.start + MEASURED_BOLD.tail;
  assert.ok(px("--tab-min") >= need, `--tab-min ${px("--tab-min")}px holds ${need.toFixed(1)}px`);
  assert.ok(px("--tab-min") - need < 4, "and no more than rounding: the strip keeps as many tabs as it can");
});
