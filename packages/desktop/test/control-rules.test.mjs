// Control rules (design v4.1, board 7; renderer/README.md "Control rules"): selection,
// focus and search fields in the shell chrome. In-memory CSSOM/cascade checks (jsdom
// matches :focus-visible on the focused element), plus effective-colour contrast in every
// theme. No Electron, network or workspace access.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { discoveryCSS } from "../renderer/workspace-discovery.mjs";
import { notificationCSS } from "../renderer/notifications.mjs";
import { lifecycleCSS } from "../renderer/lifecycle-dialog.mjs";
import { connectionsCSS } from "../renderer/connections.mjs";
import { readinessCSS } from "../renderer/readiness-view.mjs";
import { automationsCSS } from "../renderer/views/automations.mjs";
import { hierarchyCSS } from "../renderer/views/hierarchy.mjs";
import { setupCSS } from "../renderer/workspace-setup.mjs";
import { inspectorCSS } from "../renderer/soul-inspector.mjs";
import { soulTeamsHereCSS } from "../renderer/soul-teams-here.mjs";
import { instanceEventsCSS } from "../renderer/instance-events-view.mjs";
import { teamsCSS } from "../renderer/teams-panel.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const theme = read("theme.css"), shell = read("shell.css");
// Every style source spec A owns: the two shell sheets, the shared segmented control and
// the shell-owned dialogs/toasts whose focus rules moved to the global one.
// Plus the view files whose focus/outline lines spec A converted (CSS lines only; the brain
// view keeps its sheet private, so its source is read). Sheets another spec owns are cut out.
const owned = { "theme.css": theme, "shell.css": shell, "workspace-discovery.mjs (spec A lines)": discoveryLines(),
  "notifications.mjs": notificationCSS, "lifecycle-dialog.mjs": lifecycleCSS, "connections.mjs": connectionsCSS, "readiness-view.mjs": readinessCSS,
  "views/automations.mjs": automationsCSS, "views/hierarchy.mjs": hierarchyCSS, "views/brain.mjs": brainStyles(), "workspace-setup.mjs": setupCSS,
  "soul-inspector.mjs": inspectorCSS.replace(teamsCSS, "") /* teams-panel.mjs is spec B's */, "soul-teams-here.mjs": soulTeamsHereCSS, "instance-events-view.mjs": instanceEventsCSS };
function discoveryLines() {
  return discoveryCSS.split("\n").filter(line => /\.ws-segmented|\.workspace-tabs button|\.ws-search/.test(line)).join("\n");
}
function brainStyles() {
  const source = read("views/brain.mjs"), start = source.indexOf("const CSS = `");
  assert.ok(start >= 0, "brain view CSS");
  return source.slice(start, source.indexOf("`;", start));
}

const markup = `<div id="app"><aside id="sidebar">
  <div class="side-head"><span id="ws-heading" class="ws-heading">Workspace</span>
    <button id="ws-add-open" class="ws-add-open side-icon-button icon-button" type="button" aria-label="Add local workspace…"></button></div>
  <section id="ws-list" class="ws-list"><div id="ws-options" class="ws-options"><ul class="ws-group">
    <li class="ws-option-row"><button class="ws-option ws-current" aria-current="true">One</button></li>
    <li class="ws-option-row"><button class="ws-option ws-other">Two</button></li></ul></div></section>
  <nav id="nav"><button class="nav-item active" aria-current="page"><span class="icon"></span><span class="label">Workspace overview</span></button><button class="nav-item"><span class="icon"></span><span class="label">Automations</span><span class="nav-failed"><span class="nav-failed-dot" aria-hidden="true"></span><span class="sr-only">, a run failed</span></span></button></nav>
  <section id="instance-roster">
    <div class="ctx-head"><span>Instances</span><span class="ctx-count"></span></div>
    <div class="ctx-list"><div class="ctx-tree-row"><button class="ctx-inst">Row</button></div></div></section>
  <div id="nav-foot"><div id="sidebar-bar" role="group" aria-label="Sidebar tools"><button id="sidebar-need-you" type="button">2 need you</button>
      <button id="sidebar-spawn" type="button">New agent</button>
      <button id="sidebar-help" class="side-icon-button icon-button" type="button" aria-label="Keyboard shortcuts">?</button></div></div></aside>
  <main id="main"><div id="tabstrip"><div id="tabbar-row"><div id="tabbar">
    <div class="tab active"><button class="tab-trigger">Tab</button><button class="close">×</button></div>
  </div><div id="tab-actions"><button id="split-right">▥</button></div></div></div>
  <div id="tabhost" class="split-row"><div class="group-cell focused-group"><button class="split-empty">Empty</button></div></div></main></div>
  <div class="ws-modal"><section class="ws-dialog"><input id="ws-suggestion-search" type="search">
    <div class="ws-suggestions"><button class="ws-suggestion">Suggestion</button></div>
    <footer class="ws-dialog-foot"><button class="secondary">Cancel</button><button class="primary">Onboard</button></footer></section></div>
  <div class="palette-overlay"><div class="palette"><input class="palette-input"></div></div>
  <div class="kb-editor"><button class="kb-chord">⌘K</button><button class="kb-close">Close</button></div>
  <div class="oats-view"><div class="ws-segmented" role="group" aria-label="Setup view">
      <button type="button" aria-pressed="true">List</button><button type="button" aria-pressed="false">Graph</button></div>
    <button class="act">Secondary</button><button class="act primary">Primary</button><button class="act danger">Danger</button><input class="field"></div>
  <div class="app-notifications"><div class="app-toast"><button class="app-toast-dismiss">×</button></div></div>
  <div class="lifecycle-dialog" data-operation="retire"><button class="lifecycle-close">Close</button><button class="lifecycle-confirm">Retire instance</button><button class="lifecycle-done">Done</button><button class="lifecycle-review">Review again</button><button class="lifecycle-check">Check again</button></div>
  <div class="ctx-instance-menu"><button data-action="open">Open</button></div>`;

function fixture(t, palette = "light") {
  const dom = new JSDOM(`<!doctype html><html data-theme="${palette}"><head></head><body>${markup}</body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const css of [theme, shell, discoveryCSS, notificationCSS, lifecycleCSS]) {
    const style = doc.createElement("style"); style.textContent = css; doc.head.append(style);
  }
  const rules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const rule = selector => {
    const matches = rules.filter(rule => rule.selectorText?.replace(/\s+/g, " ") === selector);
    assert.equal(matches.length, 1, `one shipped rule: ${selector}`);
    return matches[0].style;
  };
  const get = selector => { const el = doc.querySelector(selector); assert.ok(el, selector); return el; };
  const style = selector => dom.window.getComputedStyle(get(selector));
  // Keyboard focus in jsdom: its :focus-visible heuristic (dom-selector) needs a modifier-free
  // keydown on the focused element, and its computed-style cache only refreshes on a mutation.
  const focused = selector => {
    const el = get(selector); el.focus();
    assert.equal(doc.activeElement, el, `${selector} takes focus`);
    el.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    el.setAttribute("data-focus-probe", ""); el.removeAttribute("data-focus-probe");
    assert.ok(el.matches(":focus-visible"), `${selector} matches :focus-visible`);
    return dom.window.getComputedStyle(el);
  };
  const root = dom.window.getComputedStyle(doc.documentElement);
  const token = name => root.getPropertyValue(`--${name}`).trim();
  return { doc, rules, rule, get, style, focused, token };
}

function channels(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `opaque hex: ${hex}`);
  return hex.slice(1).match(/../g).map(value => parseInt(value, 16));
}
function luminance(rgb) {
  const c = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const la = luminance(channels(a)), lb = luminance(channels(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── rule 1: selected state = brand tint ──
test("segmented control: selected segment is --sel/--accent at 650, unselected is transparent --muted", t => {
  const u = fixture(t);
  const on = u.style(".ws-segmented [aria-pressed=true]"), off = u.style(".ws-segmented [aria-pressed=false]");
  assert.equal(on.background, "var(--sel)"); assert.equal(on.color, "var(--accent)"); assert.equal(on.fontWeight, "650");
  assert.match(off.background, /^(transparent|rgba\(0, 0, 0, 0\))$/); assert.equal(off.color, "var(--muted)");
  for (const state of [on, off]) { assert.equal(state.borderWidth, "0px"); assert.equal(state.borderRadius, "6px"); }
  const group = u.rule(".ws-segmented");
  assert.equal(group.border, "1px solid var(--border)", "one outer frame");
  assert.equal(group.padding, "3px", "3px inner padding");
  assert.equal(group.height, "24px"); assert.equal(group.boxSizing, "content-box", "24px segments + 3px padding = a 30px frame inside its 1px border");
  assert.equal(group.borderRadius, "8px"); assert.match(group.flex, /^(none|0 0 auto)$/, "no bar squeezes it");
  const segment = u.rule(".oats-view .ws-segmented button");
  assert.equal(segment.height, "24px"); assert.equal(segment.alignItems, "center"); assert.equal(segment.fontSize, "12px"); assert.equal(segment.lineHeight, "1", "line-height 1, text centred");
  assert.equal(group.background, "var(--surface)");
  assert.equal(group.overflow, "", "segments are not clipped by the frame; they are inset");
  // No dividers: a sibling rule may only clear a border (e.g. border-left:0), never paint one.
  const dividers = u.rules.filter(r => /\.ws-segmented button \+ button/.test(r.selectorText || ""))
    .filter(r => [r.style.borderLeft, r.style.borderLeftWidth, r.style.borderLeftStyle].some(v => v && !/^(0(px)?|none)( |$)/.test(v)));
  assert.deepEqual(dividers.map(r => r.selectorText), [], "no dividers between segments");
  assert.equal(u.rule(".oats-view .ws-segmented button:focus-visible").background, "var(--sel)", "keyboard focus tints an unselected segment");
});

// The nav's current view is the selection fill (--sel): the list's current workspace has a mark of its own (its
// circle filled, workspace-switcher.mjs), so the sidebar shows one filled "you are here" row, not two.
test("workspace list: the current row, named by aria-current, has no fill and no edge, never the nav's --sel; the others rest transparent", t => {
  const u = fixture(t);
  assert.equal(u.rules.filter(r => r.selectorText?.replace(/\s+/g, " ") === '.ws-option[aria-current="true"]').length, 0, "no rule on the row itself (2026-10-23: no accent edge)");
  assert.equal(u.rule('.ws-option[aria-current="true"] .ws-option-name').fontWeight, "650", "its name in bold");
  assert.match(u.style(".ws-option.ws-current").background, /^(transparent|rgba\(0, 0, 0, 0\))$/);
  assert.equal(u.style(".ws-option.ws-current").boxShadow, "");
  assert.match(u.style(".ws-option.ws-other").background, /^(transparent|rgba\(0, 0, 0, 0\))$/);
  assert.equal(u.style(".ws-option.ws-other").boxShadow, "");
  assert.equal(u.rule(".nav-item.active").background, "var(--sel)", "the nav's current view keeps the selection fill");
  assert.equal(u.rules.filter(r => /\.ws-option\[aria-current/.test(r.selectorText || "") && /var\(--sel\)/.test(r.style.cssText)).length, 0, "no --sel on the current workspace");
  assert.equal(u.rules.filter(r => /\.ws-option\[aria-selected/.test(r.selectorText || "")).length, 0, "a list of buttons: no listbox selection rule");
  // The Add dialog's found deployments are buttons that add (#518): no radio selection to paint.
  assert.equal(u.rules.filter(r => /\.ws-suggestion\[aria-checked|\.ws-radio/.test(r.selectorText || "")).length, 0, "no radio rules");
});

// ── rule 2: no ring on pointer interaction; tint + 1px accent edge on keyboard focus ──
test("focus: one global 1px inset accent edge and tint replace every 2px ring and :focus visual", t => {
  const u = fixture(t);
  const global = u.rule(":focus-visible");
  assert.equal(global.outline, "1px solid var(--accent)"); assert.equal(global.outlineOffset, "-1px");
  assert.equal(u.rule(":is(button, a, summary):focus-visible").background, "var(--sel)");
  for (const [name, css] of Object.entries(owned)) {
    assert.doesNotMatch(css, /outline:\s*2px/, `${name}: no 2px focus ring`);
    // Selectors that style :focus (not :focus-visible / :focus-within) paint on mouse click.
    const selectors = [...css.matchAll(/^[^{}/]*\{/gm)].map(m => m[0]).filter(s => /:focus(?!-visible|-within)/.test(s));
    assert.deepEqual(selectors, [], `${name}: visuals hang off :focus-visible, never :focus`);
  }
});

test("focus: keyboard focus on plain shell controls paints the tint and the edge", t => {
  const u = fixture(t);
  // The pinned rows (the nav's items), the head's Add local workspace… and the foot's controls (N need you, New
  // instance, ?) are plain controls (the product owner, 2026-10-26; slice 1 of the Desktop UI rework).
  for (const selector of [".ws-option.ws-other", ".ws-option.ws-current", ".side-icon-button", "#nav .nav-item:not(.active)", "#nav .nav-item.active", "#ws-add-open",
    "#sidebar-need-you", "#sidebar-spawn", "#sidebar-help", ".ctx-inst", ".tab-trigger", ".tab .close",
    "#tab-actions button", ".ws-suggestion", ".ws-dialog-foot .secondary", ".kb-chord", ".kb-close", ".ws-segmented [aria-pressed=false]",
    ".ctx-instance-menu button", ".lifecycle-close", ".lifecycle-review", ".lifecycle-check", ".oats-view .act:not(.primary):not(.danger)"]) {
    const s = u.focused(selector);
    assert.equal(s.background, "var(--sel)", `${selector} tint`);
    assert.equal(s.outline, "1px solid var(--accent)", `${selector} edge`);
    assert.equal(s.outlineOffset, "-1px", `${selector} inset edge`);
  }
});

test("focus: controls with their own opaque pair keep it and show the edge only", t => {
  const u = fixture(t);
  for (const [selector, bg, fg, edge = "accent"] of [[".ws-dialog-foot .primary", "primary-bg", "primary-fg"],
    [".oats-view .act.primary", "primary-bg", "primary-fg"], [".lifecycle-confirm", "danger", "primary-fg"], [".lifecycle-done", "primary-bg", "primary-fg"],
    [".app-toast-dismiss", "primary-fg", "primary-bg", "primary-fg"] /* toast buttons invert inside the dark toast, edge in its ink */]) {
    const s = u.focused(selector);
    assert.equal(s.background, `var(--${bg})`, `${selector} background`);
    assert.equal(s.color, `var(--${fg})`, `${selector} colour`);
    assert.equal(s.outline, `1px solid var(--${edge})`, `${selector} edge`);
    // On its own opaque fill the edge would be invisible (accent on --primary-bg/--danger < 3:1), so
    // it sits 1px outside, on the surrounding surface (theme-contrast.test.mjs checks those pairs).
    assert.equal(s.outlineOffset, "1px", `${selector} edge sits outside its own fill`);
  }
  assert.equal(u.focused(".oats-view .act.danger").outlineOffset, "-1px", "danger ink on --surface keeps the inset edge");
  assert.equal(u.focused(".split-empty").background, "var(--term-bg)", "an empty pane never tints as a whole");
  assert.equal(u.focused(".oats-view .act.danger").background, "var(--surface)", "danger ink is not AA on the dark tint: edge only");
  assert.equal(u.focused(".oats-view .act.danger").color, "var(--danger)");
});

// ── rule 3: search and filter fields have one border ──
test("search fields: the field's own border is the only frame; the input never outlines", t => {
  const u = fixture(t);
  // The sidebar has no search field since the roster filter went (the command palette finds an instance by name):
  // no rule styles it, and the roster is its head, then its list.
  assert.deepEqual(u.rules.filter(r => /\.ctx-filter/.test(r.selectorText || "")).map(r => r.selectorText), [], "no roster filter rule ships");
  assert.deepEqual([...u.get("#instance-roster").children].map(el => el.className), ["ctx-head", "ctx-list"]);
  // The workspace list has no search field any more (the Add dialog's search is the one left).
  assert.equal(u.rules.filter(r => /#ws-menu-search/.test(r.selectorText || "")).length, 0, "no rule for the dropdown's search");
  // Two rules name the Add dialog's search alone now: its frame, and its place in the dialog (width, margin).
  const frames = u.rules.filter(r => r.selectorText === "#ws-suggestion-search" && r.style.border);
  assert.equal(frames.length, 1, "one rule frames the bare search input");
  assert.equal(frames[0].style.border, "1px solid var(--border)", "bare search inputs: own 1px frame");
  assert.equal(frames[0].style.outline, "none");
  // jsdom does not resolve var() in computed border colours: focus frames are read from the declared rules.
  assert.equal(u.rule("#ws-suggestion-search:focus-visible").borderColor, "var(--accent)");
  for (const selector of ["#ws-suggestion-search", ".oats-view input.field", ".palette-input"]) {
    assert.equal(u.focused(selector).outline, "none", `${selector} draws no outline when focused`);
  }
  const fieldRule = u.rule(".oats-view input.field:focus-visible, .oats-view textarea.field:focus-visible, select.field:focus-visible");
  assert.equal(fieldRule.outline, "none"); assert.equal(fieldRule.borderColor, "var(--accent)");
  const inputRule = u.rule(":is(input:not([type=\"checkbox\"]):not([type=\"radio\"]), textarea, select):focus-visible");
  assert.equal(inputRule.outline, "none"); assert.equal(inputRule.borderColor, "var(--accent)", "the palette input's bottom rule turns accent through this rule");
  assert.equal(u.rule(".palette-input").borderBottom, "1px solid var(--border)", "the palette input's only frame is its bottom rule");
});

// ── done-when 7: effective colours in every theme ──
for (const palette of ["light", "solarized", "dark"]) test(`${palette}: selected-segment text, focus tint and focused-field border meet WCAG on effective colours`, t => {
  const u = fixture(t, palette);
  const sel = u.token("sel"), accent = u.token("accent"), surface = u.token("surface"), bg = u.token("bg");
  assert.ok(contrast(accent, sel) >= 4.5, `${palette}: selected segment --accent on --sel ${contrast(accent, sel).toFixed(2)}:1`);
  for (const fg of ["fg", "muted", "nav-fg"]) assert.ok(contrast(u.token(fg), sel) >= 4.5, `${palette}: keyboard-focus tint keeps --${fg} readable`);
  // The 1px accent edge and the focused field border are non-text UI (WCAG 1.4.11, 3:1) against
  // the surfaces they sit on, including the tint it borders.
  for (const [name, on] of [["surface", surface], ["bg", bg], ["sel", sel]]) {
    assert.ok(contrast(accent, on) >= 3, `${palette}: --accent edge on --${name} ${contrast(accent, on).toFixed(2)}:1`);
  }
  assert.equal(u.style(".ws-segmented [aria-pressed=true]").color, "var(--accent)");
  assert.equal(u.rule("#ws-suggestion-search:focus-visible").borderColor, "var(--accent)");
  // The pinned rows, the head's icon button and the foot's controls (N need you, New agent, ?): their ink, idle
  // and keyboard-focused, on the --sel tint they focus to, through the effective tokens (the edge is checked above).
  for (const selector of ["#nav .nav-item:not(.active)", "#nav .nav-item.active", "#ws-add-open", "#sidebar-need-you", "#sidebar-spawn", "#sidebar-help"]) {
    const idle = u.style(selector).color, focus = u.focused(selector);
    for (const ink of [idle, focus.color]) {
      const name = ink.match(/^var\(--([\w-]+)\)$/)?.[1];
      assert.ok(name, `${selector}: a token ink, never a raw colour (${ink})`);
      assert.ok(contrast(u.token(name), sel) >= 4.5, `${palette}: ${selector} --${name} on --sel ${contrast(u.token(name), sel).toFixed(2)}:1`);
    }
    assert.equal(focus.background, "var(--sel)", `${selector} tint`);
    assert.equal(focus.opacity, "1", `${selector}: no opacity over text`);
  }
});

test("view search fields and tab strips follow rules 2 and 3 (Capabilities search, Automations search, workspace tabs)", () => {
  const find = (css, selector) => {
    const hit = css.split("\n").find(line => line.startsWith(`${selector} {`));
    assert.ok(hit, `rule: ${selector}`); return hit;
  };
  assert.match(find(discoveryCSS, ".oats-view .ws-search:focus-within input.field"), /border-color:var\(--accent\); outline:none;/);
  assert.match(find(discoveryCSS, ".oats-view .ws-search input.field"), /border:1px solid var\(--border\)/, "the input's own border is the one frame");
  assert.match(find(automationsCSS, ".auto-search:focus-within"), /\{ border-color:var\(--accent\); \}/, "the wrapper frame turns accent, no ring");
  assert.match(find(automationsCSS, ".oats-view .auto-search input"), /border:0;.*outline:none;/);
  assert.match(find(discoveryCSS, ".workspace-tabs button:focus-visible"), /background:var\(--sel\)/);
  assert.match(find(automationsCSS, ".oats-view .auto-tabs button:focus-visible"), /background:var\(--sel\)/);
  assert.match(find(hierarchyCSS, ".hier-canvas:focus-visible"), /outline: 1px solid var\(--accent\); outline-offset: -1px;/,
    "the canvas clears its outline in its base rule, so it restates the edge for keyboard focus");
});
