// In-memory CSSOM/cascade checks, not browser layout or live-app verification.
// No scripts, network resources, Electron, CLI or real workspace mutations.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { shellIcon } from "../renderer/shell-icons.mjs";
import { createResizeHandle } from "../renderer/split-resize.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const theme = read("theme.css"), shell = read("shell.css");
const icon = shellIcon("workspace");
const markup = `<div id="app"><aside id="sidebar">
  <div class="side-head"><span id="ws-heading" class="ws-heading">Workspace</span>
    <button id="ws-current-only" class="side-icon-button ws-current-only icon-button" type="button" aria-pressed="false" aria-label="Show only the current workspace">${icon}</button>
    <button id="ws-add-open" class="ws-add-open side-icon-button icon-button" type="button" aria-label="Add local workspace…">${icon}</button></div>
  <section id="ws-list" class="ws-list" aria-labelledby="ws-heading"><div id="ws-options" class="ws-options"><ul class="ws-group">
    <li class="ws-option-row"><button class="ws-option" aria-current="true"><span class="ctx-dot on" aria-hidden="true"></span><span class="ws-option-name">fixture</span><span class="sr-only">, needs input</span><span class="ws-waiting attn-mark" aria-hidden="true"></span></button></li>
    <li class="ws-option-row"><button class="ws-option"><span class="ws-option-name">other</span></button></li>
  </ul></div></section>
  <nav id="nav"><button class="nav-item active"><span class="icon">${icon}</span><span class="label">Workspace overview</span></button><button class="nav-item"><span class="icon">${icon}</span><span class="label">Automations</span></button></nav>
  <section id="instance-roster"><div class="ctx-head roster-head"><span>Instances</span><span class="ctx-count">● 1 running</span></div>
    <div class="ctx-list"><div class="ctx-deployment" role="heading" aria-level="3"><span class="ctx-deployment-label">devbox</span><span class="deployment-mark" role="img" aria-label="remembered">${icon}</span></div><div class="ctx-tree-row"><button class="ctx-inst active"><span class="ctx-dot on"></span>
      <span class="ctx-copy"><span class="ctx-name">Fixture instance</span><span class="ctx-repo-label">fixture</span></span>
      <span class="runtime-badge ctx-runtime" data-runtime="claude">C</span>
    </button></div></div></section>
  <div id="nav-foot"><div id="sidebar-bar" role="group" aria-label="Sidebar tools"><span class="sidebar-brand" aria-hidden="true"><img class="sidebar-brand-image" width="20" height="20" alt=""></span>
      <button id="sidebar-toggle" class="side-icon-button icon-button" type="button" aria-label="Hide the sidebar">${icon}</button><button id="sidebar-spawn" type="button">Spawn instance</button>
      <button id="sidebar-settings" class="side-icon-button sidebar-settings icon-button" type="button" aria-label="Settings">${icon}</button></div>
  </div></aside>
  <main id="main"><button id="show-sidebar" class="main-edge-control" hidden>${icon}</button><div id="tabstrip"><div id="tabbar-row"><div id="tabbar">
    <div class="tab active"><button class="tab-trigger">Fixture tab</button><button class="close">×</button></div>
  </div><div id="tab-actions" hidden>${["splitRight", "splitDown"].map(name => `<button>${shellIcon(name)}</button>`).join("")}</div></div></div>
  <div id="tabhost" class="split-row"><div class="group-cell focused-group">
    <div class="group-tabbar"></div><button class="split-empty">Open an instance in this panel</button>
  </div></div></main></div>
  <div class="ws-modal" hidden><section class="ws-dialog"><footer class="ws-dialog-foot">
    <button class="primary">Onboard</button></footer></section></div>
  <div class="oats-view"><button class="act primary">Primary</button><button class="act danger">Danger</button>
    <button class="act">Secondary</button><input class="field"><textarea class="field"></textarea><select class="field"><option>Fixture</option></select></div>
  <div class="ctx-instance-menu"><button data-action="retire">Retire instance</button></div>`;

function fixture(t, palette = "light") {
  const dom = new JSDOM(`<!doctype html><html data-theme="${palette}"><head></head><body>${markup}</body></html>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  for (const css of [theme, shell]) {
    const style = doc.createElement("style"); style.textContent = css; doc.head.append(style);
  }
  const rules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const rule = selector => {
    const matches = rules.filter(rule => rule.selectorText?.replace(/\s+/g, " ") === selector);
    assert.equal(matches.length, 1, `one shipped rule: ${selector}`);
    return matches[0].style;
  };
  // JSDOM's computed style lets a later shorthand (a padding) override an earlier longhand of a higher
  // specificity (a more specific rule's padding-left), which Chromium never does: `cascaded` reads one longhand the way
  // the cascade does, from the top-level rules matching the element, by specificity, then source order.
  const specificity = part => {
    const plain = part.replace(/::?(?:before|after)\b/g, "").replace(/:where\([^)]*\)/g, "");
    return [(plain.match(/#[\w-]+/g) || []).length,
      (plain.match(/\.[\w-]+|\[[^\]]+\]|:(?!is\(|not\(|where\()[\w-]+/g) || []).length,
      (plain.replace(/\[[^\]]+\]|\([^)]*\)/g, "").match(/(?:^|[\s>+~(])[a-z][\w-]*/gi) || []).length];
  };
  const cascaded = (selector, property) => {
    const el = doc.querySelector(selector); assert.ok(el, selector);
    let best = null;
    rules.forEach((r, order) => {
      const value = r.selectorText && r.style?.getPropertyValue(property);
      if (!value) return;
      const parts = r.selectorText.split(/,(?![^(]*\))/).map(part => part.trim()).filter(part => { try { return el.matches(part); } catch { return false; } });
      if (!parts.length) return;
      const spec = parts.map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
      const wins = !best || spec[0] - best.spec[0] || spec[1] - best.spec[1] || spec[2] - best.spec[2] || 1;
      if (wins > 0) best = { spec, value, order };
    });
    return best?.value ?? "";
  };
  return { doc, rule, cascaded, get: selector => doc.querySelector(selector),
    style: selector => dom.window.getComputedStyle(doc.querySelector(selector)) };
}

test("visual shell geometry: a 288px sidebar by default, aligned 48px bars, the Workspace head and 16px icons", t => {
  const u = fixture(t);
  // The width lives in one custom property on #app: 288px until its handle (sidebar-width.mjs) moves it.
  assert.equal(u.rule("#app").getPropertyValue("--sidebar-w"), "288px");
  assert.equal(u.style("#sidebar").width, "var(--sidebar-w)");
  assert.equal(u.style("#sidebar").minWidth, "var(--sidebar-w)");
  assert.equal(u.style("#sidebar").flexShrink, "0");
  assert.equal(u.rule(':root, [data-theme="dark"]').getPropertyValue("--bar-h"), "48px");
  // Every bar is 48px including its 1px rule; the flat strip's inner row
  // yields that rule to #tabstrip so the active tab keeps its bottom border.
  for (const selector of ["#tabstrip", ".group-tabbar"]) assert.equal(u.style(selector).height, "var(--bar-h)", selector);
  for (const selector of ["#tabstrip", ".group-tabbar"]) assert.equal(u.style(selector).boxSizing, "border-box", selector);
  assert.equal(u.style("#tabbar").height, "calc(var(--bar-h) - 1px)");
  // The sidebar's head (the product owner, 2026-10-26): no line under it, the Workspace heading over its list, the
  // first row close under it. 40px, border-box, its 8px top padding: the heading's centre 24px down, where it sat in
  // the 48px bar (8 + 32 / 2), and the head ends 8px under it.
  assert.deepEqual([u.style(".side-head").height, u.style(".side-head").boxSizing], ["40px", "border-box"]);
  assert.equal(u.style(".side-head").padding, "8px 10px 0px 13px", "the heading's text 13px in, as Instances' (17px before 2026-10-26's closer inset)");
  const headTop = parseFloat(u.style(".side-head").paddingTop), headHeight = parseFloat(u.style(".side-head").height);
  assert.equal(headTop + (headHeight - headTop) / 2, parseFloat(u.rule(':root, [data-theme="dark"]').getPropertyValue("--bar-h")) / 2, "the heading's centre, 24px down");
  assert.equal(u.style(".side-head").paddingLeft, u.cascaded(".roster-head", "padding-left"), "the two headings start on one line");
  assert.deepEqual([u.style(".side-head").display, u.style(".side-head").alignItems, u.style(".side-head").flexShrink, u.style(".side-head").whiteSpace], ["flex", "center", "0", "nowrap"]);
  for (const prop of ["border", "borderBottom", "borderBottomWidth", "borderBottomStyle"]) assert.equal(u.rule(".side-head")[prop], "", `.side-head ${prop}: no line under the head`);
  // The head: the list's heading (no mark before it), then Show only the current workspace and Add local
  // workspace…, the head's two 28px icon buttons (.side-icon-button).
  assert.deepEqual([...u.get(".side-head").children].map(el => el.id), ["ws-heading", "ws-current-only", "ws-add-open"]);
  assert.equal(u.rule(".ws-heading").marginLeft, "", "no margin of its own: no mark before it");
  assert.equal(u.style(".ws-heading").flexGrow, "1");
  assert.equal(u.style(".ws-heading").minWidth, "0px");
  assert.equal(u.style(".ws-heading").fontSize, "13.5px");
  assert.deepEqual([u.style(".ws-heading").color, u.style(".ws-heading").fontWeight], ["var(--fg)", "700"]);
  assert.equal(u.style(".ws-heading").textOverflow, "ellipsis");
  assert.equal(shell.match(/\.ws-brand-(?:mark|image)\b/), null, "no rule left for the head's old mark");
  for (const id of ["#ws-current-only", "#ws-add-open"]) {
    assert.deepEqual([u.style(id).width, u.style(id).height, u.style(id).flexShrink], ["28px", "28px", "0"], id);
    assert.equal(u.style(id).display, "grid", id);
    assert.equal(u.style(id).color, "var(--muted)", id);
  }
  for (const [selector, size] of [[".shell-icon", "16px"]]) {
    assert.equal(u.style(selector).width, size); assert.equal(u.style(selector).height, size);
    assert.equal(u.style(selector).flexShrink, "0");
  }
  for (const selector of [".ws-option-name", ".ctx-deployment-label"]) {
    assert.equal(u.style(selector).whiteSpace, "nowrap", selector);
    assert.equal(u.style(selector).textOverflow, "ellipsis", selector);
  }
  // The list: always shown under the head, about six rows at most, then it scrolls inside itself.
  assert.equal(u.style(".ws-list").flexShrink, "0");
  assert.equal(u.rule(".ws-list").borderBottom, "1.5px solid var(--border)", "one rule between the list and the navigation, a little bolder than the roster's");
  assert.equal(u.rule("#instance-roster").borderTop, "1px solid var(--border)", "the line before the instances");
  assert.equal(u.rule(".ws-list").paddingTop, "0px", "the list starts right under its heading");
  // The line before the instances (the product owner, 2026-10-26): the roster's own top border, the sidebar's full
  // width; the current workspace's section and its ::before line are gone.
  assert.equal(u.rule("#instance-roster").getPropertyValue("border-top"), "1px solid var(--border)");
  // No line between the Instances heading and the list (the product owner, 2026-10-26): no rule draws one.
  assert.equal(shell.match(/#instance-roster > \.ctx-head(?:::after|::before)?\s*\{/), null, "no rule of the heading's own, nor a line under it");
  assert.equal(shell.match(/\.ws-current\b(?![-\w])|#ws-current\b(?![-\w])|\.ws-head\b|\.ctx-head-add\b|@container/), null,
    "no rule left for the current workspace's section, the plain heading, the headings' + or the nav's container query");
  assert.equal(u.get("#ws-current"), null);
  assert.equal(u.style(".ws-options").maxHeight, "276px");
  assert.equal(u.style(".ws-options").overflowY, "auto");
  assert.equal(u.style(".ws-option").alignItems, "center");
  assert.equal(u.style(".ws-option").padding, "4px 8px 4px 10px", "its circle in the column of the roster's top-level dots");
  assert.equal(u.style(".ws-option").minHeight, "24px", "a compact row (the product owner, 2026-10-26)");
  // The needs-input mark (2026-10-23, kept): the drawn "!" badge (its size from the switcher, its colours and 3:1 in
  // theme-contrast), a block graphic that never shrinks, with no stroke of its own.
  const dot = u.style(".ws-waiting");
  assert.deepEqual([dot.display, dot.flexShrink, u.rule(".attn-mark").getPropertyValue("stroke")], ["block", "0", "none"]);
  // A row is one line (pr3-simplify): the roster's circle, the name, which gives way and ends in an ellipsis, then the
  // dot at the far right; the current row is told by style alone, its circle filled and its name in bold
  // (theme-contrast). The circle sits from the name as an instance's dot does (.ctx-inst's 9px).
  assert.deepEqual([u.style(".ws-option").display, u.style(".ws-option").gap], ["flex", "9px"]);
  assert.equal(u.style(".ws-option").gap, u.style(".ctx-inst").gap);
  assert.equal(u.style(".ws-waiting").marginLeft, "auto", "the dot at the row's far right");
  const name = u.style(".ws-option-name");
  assert.deepEqual([name.flexGrow, name.flexShrink, name.minWidth, name.overflow], ["0", "1", "0px", "hidden"]);
  // The names inherit the sidebar's 13px at the row's weight again (no size or weight of their own), the current one at 650.
  assert.deepEqual([u.rule(".ws-option-name").fontSize, u.rule(".ws-option-name").fontWeight], ["", ""], "no size or weight of its own");
  assert.match(shell, /^body \{[^}]*font-size: 13px; line-height: 1\.45; /m, "the 13px they inherit");
  assert.equal(u.style('.ws-option[aria-current="true"] .ws-option-name').fontWeight, "650");
  assert.notEqual(u.style('.ws-option:not([aria-current]) .ws-option-name').fontWeight, "650", "another row's name is not bold");
  assert.equal(shell.match(/\.ws-option-(?:meta|line|copy|section)\b|\.ws-check\b|\.ws-open-window\b|\.ws-option \.workspace-avatar/), null, "no mark, machine line, check or button rules");
  // The deployment mark (the roster's headings): the warning shape in --warn at the 12px icon size the filter uses, never the 16px default.
  assert.equal(u.style(".deployment-mark").color, "var(--warn)"); assert.equal(u.style(".deployment-mark").flexShrink, "0");
  assert.equal(u.style(".deployment-mark > .shell-icon").width, "12px");
  // Deployment headings in the roster's group-label type (the clusters' label on the Machines tab): muted 11px 650 capitals.
  const heading = u.style(".ctx-deployment");
  assert.deepEqual([heading.color, heading.fontSize, heading.fontWeight, heading.textTransform, heading.letterSpacing],
    ["var(--muted)", "11px", "650", "uppercase", "0.06em"]);
  // The Instances heading reads like the nav items above it: 13px at 500 in --nav-fg; the groups 14px apart.
  const roster = u.style(".roster-head");
  assert.deepEqual([roster.height, roster.color, roster.fontSize, roster.fontWeight], ["36px", "var(--nav-fg)", "13px", "500"]);
  assert.equal(u.cascaded(".roster-head", "padding-left"), "13px");
  assert.equal(u.rule(".ctx-group").height, "14px"); assert.equal(u.rule(".ctx-group:first-child").height, "7px");
  assert.equal(u.get("#ws-deployments"), null);
});

test("nav/footer rhythm stays separate from the 48px roster rows", t => {
  const u = fixture(t);
  // The views sit under the list of workspaces, a column of 30px items, then the instances (the product owner, 2026-10-26).
  assert.deepEqual([u.style("#nav").display, u.style("#nav").flexDirection, u.style("#nav").flexShrink], ["flex", "column", "0"]);
  assert.equal(u.get("#nav").parentElement, u.get("#sidebar"));
  assert.equal(u.get("#nav").previousElementSibling, u.get("#ws-list")); assert.equal(u.get("#nav").nextElementSibling, u.get("#instance-roster"));
  assert.equal(u.style("#nav").padding, "8px", "the same 8px above Workspace overview and below Automations, between the two lines (the product owner, 2026-10-26)");
  assert.equal(u.style("#nav").gap, "1px");
  assert.equal(u.style("#nav .nav-item").minHeight, "30px");
  assert.equal(u.style("#nav .nav-item").gap, "9px");
  assert.equal(u.style("#nav .nav-item").padding, "5px 9px");
  assert.equal(u.style("#nav .nav-item .icon").width, "16px", "16px icons, as the shell's");
  assert.equal(shell.match(/#nav \.nav-item\b|#nav \.shell-icon|#nav-foot \.shell-icon|#nav-foot > \.side-icon-button/), null, "no compact nav rules are left, nor the foot's of 2026-10-23");
  assert.equal(shell.match(/\.nav-title|#nav-title/), null, "no title over the views: no rule left for it");
  // The foot (the product owner, 2026-10-26): one bar (the OATS mark, the sidebar toggle after it, Spawn instance at the
  // right before the settings cog), under the --border line.
  const foot = u.style("#nav-foot");
  assert.deepEqual([foot.display, foot.flexDirection, foot.flexShrink, foot.marginTop], ["flex", "column", "0", "auto"]);
  assert.equal(foot.padding, "4px 10px 4px 6px", "6px on the left (10px before 2026-10-26), so the mark keeps the rows' column");
  assert.equal(u.rule("#nav-foot").gap, "", "one child: no gap");
  assert.equal(u.rule("#nav-foot").borderTop, "1px solid var(--border)", "the foot keeps its one rule above it");
  assert.deepEqual([...u.get("#nav-foot").children].map(el => el.id), ["sidebar-bar"]);
  // Spawn instance (the product owner, 2026-10-26): its words alone, 24px tall, 12px at 500, no border and no fill at
  // rest (hover gives it one), its auto left margin pushing it and the cog to the bar's right end, 4px (and the gap)
  // before the cog.
  const spawn = u.style("#sidebar-spawn");
  assert.deepEqual([spawn.height, spawn.minHeight, spawn.fontSize, spawn.fontWeight, spawn.whiteSpace, spawn.flexShrink], ["24px", "24px", "12px", "500", "nowrap", "0"]);
  assert.deepEqual([spawn.marginTop, spawn.marginRight, spawn.marginBottom, spawn.marginLeft], ["0px", "4px", "0px", "auto"]);
  assert.deepEqual([spawn.display, spawn.alignItems, spawn.padding, spawn.background, spawn.color], ["flex", "center", "0px 8px", "rgba(0, 0, 0, 0)", "var(--muted)"]);
  assert.equal(u.rule("#sidebar-spawn").border, "0px", "no border");
  assert.equal(u.get("#sidebar-spawn").querySelector(".shell-icon, [data-shell-icon]"), null, "no icon");
  const bar = u.style("#sidebar-bar");
  assert.deepEqual([bar.display, bar.alignItems, bar.gap, bar.padding], ["flex", "center", "2px", "0px 3px 0px 2px"]);
  assert.deepEqual([...u.get("#sidebar-bar").children].map(el => el.id || el.className), ["sidebar-brand", "sidebar-toggle", "sidebar-spawn", "sidebar-settings"]);
  for (const id of ["#sidebar-toggle", "#sidebar-settings"]) {
    const button = u.style(id);
    assert.deepEqual([button.width, button.height, button.display, button.position], ["24px", "24px", "grid", "relative"], id);
  }
  assert.equal(shell.match(/#sidebar-(?:tools|theme|shortcuts)\b|#sidebar-palette\b/), null, "no rule left for the tools row or its buttons");
  assert.equal(u.style(".ctx-tree-row").minHeight, "48px");
  assert.equal(u.style(".ctx-inst").minHeight, "44px");
  assert.equal(u.style(".ctx-inst").height, "auto");
  assert.equal(u.style(".ctx-copy").gap, "3px");
  assert.equal(u.style(".ctx-list").overflowY, "auto");
});

// The right-hand column (2026-10-23, kept for the rows and the bar): the workspace rows' needs-input mark, the
// instance rows' harness mark and the bar's settings cog centre 25px in from the sidebar's right edge. Each centre is
// computed from the shipped rules (JSDOM has no layout): the box's offset from the right edge plus half its width. The
// head's two buttons sit on its own 10px.
test("the right-hand column: the workspace rows' needs-input mark and the instance rows' harness mark centre 25px from the sidebar's right edge", t => {
  const u = fixture(t), px = value => { assert.match(value, /^-?\d+(\.\d+)?px$/, value); return parseFloat(value); };
  // The rules each centre is made of.
  assert.equal(u.style(".ctx-head").paddingRight, "12px", "the Instances heading's right padding, as before 2026-10-23");
  assert.equal(u.style(".ws-waiting").marginRight, "2px");
  assert.equal(u.style(".ws-option").paddingRight, "8px");
  // The product owner, 2026-10-26: the rows closer to the window's left edge, 4px in (8px before); the right as before.
  for (const selector of [".ws-list", ".ctx-list"]) assert.deepEqual([u.style(selector).paddingLeft, u.style(selector).paddingRight], ["4px", "8px"], selector);
  assert.equal(u.style(".ctx-inst").paddingRight, "8px");
  assert.deepEqual([u.style(".ctx-runtime").width, u.style(".ctx-runtime").height], ["18px", "18px"]);
  // The needs-input mark's size is the switcher's (an svg's width attribute, not a rule): 14px, on a row and on "N more below".
  const switcher = read("workspace-switcher.mjs");
  const sizes = [...switcher.matchAll(/iconElement\(document, "attention", \{ size: (\d+), className: "ws-waiting attn-mark" \}\)/g)].map(m => Number(m[1]));
  assert.deepEqual(sizes, [14, 14], "the mark is 14px wherever the switcher draws it");
  // Each is the last thing on its line: the mark after the name, the badge after the copy; the Instances heading
  // ends in its count (no + in it: Spawn instance is the foot's).
  assert.equal(u.get(".roster-head").lastElementChild, u.get(".ctx-count"));
  assert.equal(u.get(".side-head").lastElementChild, u.get("#ws-add-open"));
  // Show only the current workspace, then Add local workspace…, at the head's end: the heading (flex: 1) pushes the
  // pair there, no margin of their own.
  assert.deepEqual([...u.get(".side-head").children].map(el => el.id), ["ws-heading", "ws-current-only", "ws-add-open"]);
  assert.deepEqual([u.cascaded("#ws-current-only", "margin-left"), u.cascaded("#ws-add-open", "margin-left")], ["", ""]);
  const addCentre = px(u.style(".side-head").paddingRight) + px(u.style("#ws-add-open").width) / 2;
  const toggleCentre = px(u.style(".side-head").paddingRight) + px(u.style("#ws-add-open").width) + px(u.style("#ws-current-only").width) / 2;
  assert.deepEqual({ addCentre, toggleCentre }, { addCentre: 24, toggleCentre: 52 }, "10 + 14, and the toggle 28px further in");
  assert.equal(u.get(".ws-option .ws-waiting").nextElementSibling, null);
  assert.equal(u.get(".ctx-inst .ctx-runtime").nextElementSibling, null);
  assert.equal(u.style(".ws-waiting").marginLeft, "auto"); assert.equal(u.style(".ctx-copy").flexGrow, "1");
  // The arithmetic: the mark 8 + 8 + 2 + 7, the harness 8 + 8 + 9, the cog 10 + 3 + 12.
  const mark = px(u.style(".ws-list").paddingRight) + px(u.style(".ws-option").paddingRight) + px(u.style(".ws-waiting").marginRight) + sizes[0] / 2;
  const harness = px(u.style(".ctx-list").paddingRight) + px(u.style(".ctx-inst").paddingRight) + px(u.style(".ctx-runtime").width) / 2;
  const cog = px(u.style("#nav-foot").paddingRight) + px(u.style("#sidebar-bar").paddingRight) + px(u.style("#sidebar-settings").width) / 2;
  assert.deepEqual({ mark, harness, cog }, { mark: 25, harness: 25, cog: 25 }, "one column, 25px in");
  // The lists hide their scrollbars (the roster's, and the workspace list's), so a long list never
  // takes width from its rows and moves their marks off the column.
  assert.match(shell, /^\.ws-options \{[^}]*scrollbar-width: none;/m, "the workspace list: no scrollbar");
  assert.match(shell, /^\.ws-options::-webkit-scrollbar \{ display: none; \}/m, "nor Chromium's");
  assert.match(shell, /^\.ctx-list \{ scrollbar-width: none; \}/m, "as the roster's");
});

// "Refreshing…" in the Instances heading (loading.mjs appends it after the count) shows its words again (as before
// 2026-10-23): the heading holds no + it could push past the sidebar's edge, so the indicator needs no fixed box.
test("the refreshing Instances heading shows the indicator's words after the count, 6px from it", t => {
  const u = fixture(t);
  const rule = shell.match(/^\.ctx-head > \.loading-refreshing \{([^}]*)\}/m);
  assert.ok(rule, "the heading's own rule for the indicator");
  assert.equal(rule[1].trim(), "flex: none; margin-left: 6px;");
  assert.doesNotMatch(rule[1], /width|overflow|display:\s*none|visibility|clip-path|font-size:\s*0/, "neither clipped nor hidden");
  assert.deepEqual([...u.get(".roster-head").children].map(el => el.className || el.textContent), ["Instances", "ctx-count"], "the heading's own children: its words and the count");
  assert.equal(u.get(".roster-head button"), null, "no button in the heading");
});

// The bar (the product owner, 2026-10-26): [mark][toggle] … [Spawn instance][cog], the foot's one row. The OATS mark's centre on the
// workspace rows' circles (18px in from the left), the settings cog's in the right-hand column (25px in from the
// right), the sidebar toggle 8px after the mark and Spawn instance 6px before the cog, all computed from the rules.
test("the bar: the OATS mark on the rows' circles (18px in), the cog in the right-hand column (25px from the right), the toggle 8px after the mark, Spawn instance 6px before the cog", t => {
  const u = fixture(t), px = value => { assert.match(value, /^-?\d+(\.\d+)?px$/, value); return parseFloat(value); };
  const foot = u.style("#nav-foot"), bar = u.style("#sidebar-bar"), brand = u.style(".sidebar-brand"), image = u.style(".sidebar-brand-image");
  const toggle = u.style("#sidebar-toggle"), cog = u.style("#sidebar-settings");
  assert.deepEqual([...u.get("#sidebar-bar").children].map(el => el.id || el.className), ["sidebar-brand", "sidebar-toggle", "sidebar-spawn", "sidebar-settings"]);
  // The mark: 20px, its image too (the 48px artwork at 2x and more), with no margin of its own: Spawn instance's auto
  // left margin keeps it and the cog at the right end.
  assert.deepEqual([brand.width, brand.height, brand.flexShrink], ["20px", "20px", "0"]);
  assert.equal(u.rule(".sidebar-brand").marginRight, "", "no auto margin on the mark");
  assert.equal(u.style("#sidebar-spawn").marginLeft, "auto");
  assert.deepEqual([image.width, image.height, image.display], ["20px", "20px", "block"]);
  for (const button of [toggle, cog]) assert.deepEqual([button.width, button.height], ["24px", "24px"]);
  for (const id of ["#sidebar-toggle", "#sidebar-settings"]) assert.equal(u.doc.defaultView.getComputedStyle(u.get(`${id} .shell-icon`)).width, "14px", `${id}: a 14px icon`);
  // From the left: the foot's 6px, the bar's 2px and half the mark's 20px. From the right: the foot's 10px, the
  // bar's 3px and half the cog's 24px. The toggle starts the gap and its own 6px after the mark; Spawn instance ends
  // the gap and its own 4px before the cog.
  const markCentre = px(foot.paddingLeft) + px(bar.paddingLeft) + px(brand.width) / 2;
  const cogCentre = px(foot.paddingRight) + px(bar.paddingRight) + px(cog.width) / 2;
  const toggleLeft = px(foot.paddingLeft) + px(bar.paddingLeft) + px(brand.width) + px(bar.gap) + px(toggle.marginLeft);
  const spawnRight = px(foot.paddingRight) + px(bar.paddingRight) + px(cog.width) + px(bar.gap) + px(u.style("#sidebar-spawn").marginRight);
  // A workspace row's circle: the list's 4px, the row's 10px, half the 8px circle.
  const row = u.style(".ws-option"), circle = u.style(".ws-option .ctx-dot");
  const rowCircle = px(u.style(".ws-list").paddingLeft) + px(row.paddingLeft) + px(circle.width) / 2;
  // The right-hand column: an instance row's harness mark (the list's 8px, the row's 8px, half its 18px).
  const harness = px(u.style(".ctx-list").paddingRight) + px(u.style(".ctx-inst").paddingRight) + px(u.style(".ctx-runtime").width) / 2;
  assert.deepEqual({ markCentre, rowCircle }, { markCentre: 18, rowCircle: 18 }, "6 + 2 + 10, on 4 + 10 + 4");
  assert.deepEqual({ cogCentre, harness }, { cogCentre: 25, harness: 25 }, "10 + 3 + 12, on 8 + 8 + 9");
  assert.equal(toggleLeft - (px(foot.paddingLeft) + px(bar.paddingLeft) + px(brand.width)), 8, "the toggle 8px after the mark");
  assert.equal(spawnRight, 43, "10 + 3 + 24 + 2 + 4: Spawn instance 6px before the cog");
  assert.equal(px(bar.gap), 2);
});

for (const palette of ["light", "solarized", "dark"]) test(`${palette}: primary, danger, disabled and focus states keep their own semantic pairs`, t => {
  const u = fixture(t, palette);
  // Spawn instance is no primary button: its words alone (the product owner, 2026-10-26).
  assert.equal(u.style("#sidebar-spawn").background, "rgba(0, 0, 0, 0)", "no fill");
  for (const selector of [".ws-dialog-foot .primary", ".oats-view .primary"]) {
    assert.equal(u.style(selector).color, "var(--primary-fg)", selector);
    assert.equal(u.style(selector).background, "var(--primary-bg)", selector);
    u.get(selector).disabled = true;
    assert.equal(u.style(selector).color, "var(--faint)", `${selector} disabled`);
    assert.equal(u.style(selector).background, "var(--surface-2)", `${selector} disabled`);
  }
  // The sidebar's icon buttons (the head's two, the bar's sidebar toggle and settings cog) are muted; none is a primary.
  for (const selector of ["#ws-current-only", "#ws-add-open", "#sidebar-toggle", "#sidebar-settings"]) {
    assert.equal(u.style(selector).display, "grid", selector);
    assert.equal(u.style(selector).color, "var(--muted)", selector);
    assert.notEqual(u.style(selector).background, "var(--primary-bg)", selector);
  }
  assert.equal(u.style(".act.danger").color, "var(--danger)");
  assert.equal(u.style(".act:not(.primary):not(.danger)").color, "var(--fg)");
  assert.equal(u.style('[data-action="retire"]').color, "var(--danger)");
  assert.equal(u.rule('.ctx-instance-menu button[data-action="retire"]:is(:hover, :focus-visible), .ctx-instance-menu button.danger:is(:hover, :focus-visible)').background, "var(--surface-2)",
    "danger hover uses the AA-validated raised surface, not dark selection");
  assert.equal(u.rule(".oats-view button.act.primary:hover:not(:disabled)").color, "var(--primary-fg)");
  // Control rule 2 (control-rules.test.mjs has the full contract): one global 1px inset
  // accent edge plus the brand tint on keyboard focus; no per-component 2px rings remain.
  assert.equal(u.rule(":focus-visible").outline, "1px solid var(--accent)");
  assert.equal(u.rule(":focus-visible").outlineOffset, "-1px");
  assert.equal(u.rule(":is(button, a, summary):focus-visible").background, "var(--sel)");
  for (const selector of [".ws-option:focus-visible", ".ctx-instance-menu button:hover, .ctx-instance-menu button:focus-visible", "#tab-actions button:focus-visible"]) {
    assert.equal(u.rule(selector).background, "var(--sel)", selector);
    assert.equal(u.rule(selector).outline, "", selector);
  }
});

test("running indicators use accent, while success stays distinct", t => {
  const u = fixture(t);
  assert.equal(u.rule(".ctx-dot.on").background, "var(--accent)");
  assert.equal(u.rule(".palette-item .pdot.on").background, "var(--accent)");
  assert.equal(u.rule(".palette-item .pdot.on").borderColor, "var(--accent)");
  assert.equal(u.rule(".tab.active").boxShadow, "inset 0 2px 0 var(--accent)");
  assert.equal(u.rule(".ctx-tree-row.active").backgroundColor, "var(--sel)");
});

test("component geometry: rounded popovers, 36px fields and persistent scrollable groups", t => {
  const u = fixture(t);
  assert.equal(shell.match(/\.ws-menu\s*[,{]/), null, "no dropdown popover rule: the workspace list is always shown");
  for (const selector of [".ctx-instance-menu"]) {
    assert.equal(u.style(selector).borderRadius, "9px");
    assert.equal(u.style(selector).padding, "6px");
    assert.equal(u.style(selector).boxShadow, "var(--shadow-popover)");
  }
  for (const selector of ["input.field", "select.field"]) assert.equal(u.style(selector).minHeight, "36px");
  assert.equal(u.style("textarea.field").minHeight, "64px");
  assert.equal(u.style("input.field").borderRadius, "7px");
  assert.equal(u.style("input.field").background, "var(--surface)");
  assert.equal(u.style("#tabbar").overflowX, "auto");
  assert.equal(u.style(".group-tabbar").overflowX, "auto");
  assert.equal(u.style(".tab").flexShrink, "1", "tabs shrink evenly (spec F)");
  assert.equal(u.style(".tab").minWidth, "var(--tab-min)", "down to a floor, then the strip scrolls");
  assert.equal(u.style(".tab .close").width, "20px");
  assert.equal(u.style(".tab .close").height, "20px");
  assert.equal(u.style("#tab-actions button").width, "28px");
  assert.equal(u.style("#tab-actions button").height, "28px");
  assert.equal(u.style(".group-cell.focused-group").outline, "1px solid var(--accent)");
  assert.equal(u.style(".split-empty").display, "flex", "empty panels remain visible");
  assert.notEqual(u.style(".ws-list").display, "none", "the workspace list has no hidden state");
  for (const selector of [".ws-modal", "#tab-actions"]) {
    assert.equal(u.style(selector).display, "none", `${selector} honors hidden`);
    u.get(selector).hidden = false;
    assert.notEqual(u.style(selector).display, "none", `${selector} can be revealed`);
  }
  assert.equal(u.style("#show-sidebar").display, "none", "Show sidebar honors hidden");
  u.get("#app").classList.add("sidebar-hidden"); u.get("#show-sidebar").hidden = false;
  assert.equal(u.style("#sidebar").display, "none");
  assert.equal(u.style("#show-sidebar").display, "grid", "the sidebar leaves no edge: Show sidebar sits in the top bar");
  assert.equal(u.style("#show-sidebar").position, "absolute");
});

test("shell component paints use tokens, not raw colors or text transparency", () => {
  const rules = shell.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bopacity\s*:/i);
  assert.doesNotMatch(rules, /font:\s*[^;{}]+\s+inherit\s*;/, "control font shorthands must be valid CSS");
});


test("coordinated shell inset applies equally to selected and unselected rows; icons share one Lucide stroke", t => {
  const u = fixture(t);
  const row = u.get(".ctx-inst");
  assert.equal(u.style(".ctx-inst").paddingLeft, "10px");
  row.classList.remove("active");
  assert.equal(u.style(".ctx-inst").paddingLeft, "10px", "selection never shifts the content");
  assert.equal(u.style(".ctx-inst").paddingRight, "8px");
  for (const svg of u.doc.querySelectorAll("#tab-actions .shell-icon")) assert.equal(svg.getAttribute("stroke-width"), "2");
  assert.equal(u.style("#tab-actions .shell-icon").width, "16px");
  assert.equal(u.get("#nav .shell-icon").getAttribute("stroke-width"), "2", "navigation uses the same Lucide stroke");
});

for (const palette of ["light", "solarized", "dark"]) test(`${palette}: nav ink reaches labels/icons without recoloring active or disabled states`, t => {
  const u = fixture(t, palette);
  const nav = u.get("#nav .nav-item");
  assert.equal(u.style("#nav .icon").color, "var(--accent)");
  nav.classList.remove("active");
  assert.equal(u.style("#nav .nav-item").color, "var(--nav-fg)");
  assert.equal(u.style("#nav .icon").color, "var(--nav-fg)");
  nav.disabled = true;
  assert.equal(u.style("#nav .nav-item").color, "var(--faint)");
});

test("theme component rules remain token-only, including all new identity markers", () => {
  const components = theme.slice(theme.indexOf("/* Keyboard-first" )).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(components, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bopacity\s*:/i);
  assert.doesNotMatch(components, /\battr\(/i, "data attributes select named rules, never arbitrary CSS values");
});

// The sidebar's width handle is the split panes' resizer (one rule, no second resizer): a 6px col-resize strip
// across the sidebar's right edge, its hover and keyboard focus the --accent fill (held to 3:1 on --surface, --bg
// and --term-bg by theme-contrast's focus edges).
test("the sidebar's width handle takes the split resizer's rule on the sidebar's right edge", t => {
  const u = fixture(t);
  const handle = createResizeHandle(u.doc, { label: "Sidebar width", orientation: "row" });
  u.get("#sidebar").append(handle);
  assert.equal(u.style("#sidebar").position, "relative", "the handle's containing block");
  const style = u.style("#sidebar > .split-resizer");
  assert.deepEqual([style.position, style.top, style.bottom, style.right, style.width, style.cursor, style.touchAction],
    ["absolute", "0px", "0px", "-3px", "6px", "col-resize", "none"]);
  const focus = u.rule(".split-resizer:hover, .split-resizer:focus-visible");
  assert.equal(focus.background, "var(--accent)");
  assert.equal(focus.outline, "none", "the fill is the focus indicator");
  assert.equal(shell.match(/#sidebar-resizer|\.sidebar-resizer/), null, "no rule of its own");
});
