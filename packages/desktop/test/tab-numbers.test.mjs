import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { tabNumber, numberTabStrips } from "../renderer/tab-numbers.mjs";
import { createTabChrome, tabNameTailStart, setTabTitle } from "../renderer/tab-a11y.mjs";
import { setBinding, resetAllBindings, setChordFamily } from "../renderer/keybindings.mjs";
import { DEFAULT_CHORD_FAMILY } from "../../client/keymap.mjs";
import { pinPlatform } from "./helpers/platform.mjs";

const shellCss = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");

function fixture(t) {
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=\"tabbar\"></div><div id=\"tabhost\"></div></body></html>");
  t.after(() => dom.window.close());
  const doc = dom.window.document, style = doc.createElement("style");
  style.textContent = shellCss; doc.head.append(style);
  return { doc, window: dom.window };
}
const strip = (doc, titles, { group = false, prefix = "t" } = {}) => {
  const bar = doc.createElement("div");
  if (group) bar.className = "group-tabbar"; else bar.id = "tabbar-test";
  const tabs = titles.map((title, i) => createTabChrome(doc, `${prefix}${i}`, title, false, { dot: "on" }));
  for (const { tabEl } of tabs) bar.append(tabEl);
  doc.body.append(bar);
  return { bar, tabs };
};
const shown = tabs => tabs.map(({ triggerEl }) => { const num = triggerEl.querySelector(":scope > .tab-num"); return num.hidden ? null : num.textContent; });

// The lead's rule: "go to tab N" reaches tab N of the strip, and 9 the last (shell.mjs gotoTab).
test("tabNumber: 1–8 by position, 9 for the last of nine or more, nothing for the rest", () => {
  assert.deepEqual([...Array(8).keys()].map(i => tabNumber(i, 8)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...Array(9).keys()].map(i => tabNumber(i, 9)), [1, 2, 3, 4, 5, 6, 7, 8, 9], "the 9th of 9 is 9");
  assert.deepEqual([...Array(12).keys()].map(i => tabNumber(i, 12)), [1, 2, 3, 4, 5, 6, 7, 8, null, null, null, 9],
    "of 12, positions 9–11 show nothing and the 12th shows 9");
  assert.equal(tabNumber(0, 1), 1, "a lone tab is 1");
  for (const [index, count] of [[-1, 3], [3, 3], [0, 0], [1.5, 3], [null, 3], [0, "3"]]) assert.equal(tabNumber(index, count), null, `${index} of ${count}`);
});

test("numberTabStrips numbers each strip's shown tabs in DOM order; the number is decorative", t => {
  pinPlatform(t); // the tooltips name the Linux and Windows keys (Alt+N)
  const { doc } = fixture(t);
  const titles = Array.from({ length: 10 }, (_, i) => `oats-desktop-developer-tab-${i}`);
  const { bar, tabs } = strip(doc, titles);
  // createTabChrome ends every trigger with an empty, hidden number.
  for (const { triggerEl } of tabs) {
    const num = triggerEl.lastElementChild;
    assert.equal(num.className, "tab-num");
    assert.deepEqual([num.textContent, num.hidden, num.getAttribute("aria-hidden")], ["", true, "true"]);
  }
  numberTabStrips([bar]);
  assert.deepEqual(shown(tabs), ["1", "2", "3", "4", "5", "6", "7", "8", null, "9"]);
  tabs.forEach(({ triggerEl }, i) => {
    assert.equal(triggerEl.getAttribute("aria-label"), titles[i], "the accessible name stays the bare title");
    assert.equal(triggerEl.title, i === 8 ? titles[i] : `${titles[i]} (Alt+${i === 9 ? 9 : i + 1})`, "the tooltip names the tab's key, if it has one");
    assert.equal(triggerEl.getAttribute("role"), "tab");
    assert.equal(triggerEl.querySelector(".tab-num").getAttribute("aria-hidden"), "true");
  });
  // A hidden tab (another context or workspace) does not count, and loses its number.
  tabs[2].tabEl.hidden = true;
  numberTabStrips([bar]);
  assert.deepEqual(shown(tabs), ["1", "2", null, "3", "4", "5", "6", "7", "8", "9"], "nine shown: the last is 9");
  // Removal renumbers; a strip of eight shows 1–8.
  tabs[9].tabEl.remove(); numberTabStrips([bar]);
  assert.deepEqual(shown(tabs.slice(0, 9)), ["1", "2", null, "3", "4", "5", "6", "7", "8"]);
  tabs[2].tabEl.hidden = false; numberTabStrips([bar]);
  assert.deepEqual(shown(tabs.slice(0, 9)), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  // Only the strip's own tabs: anything else in it (the split controls) is left alone.
  const actions = doc.createElement("div"); actions.id = "tab-actions"; bar.append(actions);
  numberTabStrips([bar]);
  assert.equal(actions.textContent, "");
});

test("two group strips number their tabs independently, and a moved tab takes its new strip's number", t => {
  const { doc } = fixture(t);
  const left = strip(doc, ["a", "b", "c"], { group: true, prefix: "l" });
  const right = strip(doc, ["d", "e"], { group: true, prefix: "r" });
  numberTabStrips([null, left.bar, right.bar]);
  assert.deepEqual(shown(left.tabs), ["1", "2", "3"]);
  assert.deepEqual(shown(right.tabs), ["1", "2"]);
  right.bar.prepend(left.tabs[1].tabEl); // a tab moved to the other group, at its start
  numberTabStrips([left.bar, right.bar]);
  assert.deepEqual(shown([left.tabs[0], left.tabs[2]]), ["1", "2"]);
  assert.deepEqual(shown([left.tabs[1], ...right.tabs]), ["1", "2", "3"]);
});

// F3 (#1491): the number is aria-hidden, so the tooltip names the key it stands for, the keymap's live
// binding of tabs.goto1..9 as the platform shows it: Alt+N in the default family, the active family's
// otherwise, ⌥⌘N on macOS, and a rebind once it is made. A tab with no number names no key.
test("the tooltip names the tab's key: the active family's, macOS's, a rebind's; a tab with no number, none", t => {
  t.after(() => { resetAllBindings(); setChordFamily(DEFAULT_CHORD_FAMILY); });
  const { doc } = fixture(t);
  const { bar, tabs } = strip(doc, Array.from({ length: 10 }, (_, i) => `tab-${i}`));
  const titles = () => tabs.map(({ triggerEl }) => triggerEl.title);
  const keyed = keys => keys.map((key, i) => (key ? `tab-${i} (${key})` : `tab-${i}`));
  const digits = prefix => [..."12345678"].map(n => `${prefix}${n}`).concat(null, `${prefix}9`);
  numberTabStrips([bar], false);
  assert.deepEqual(titles(), keyed(digits("Alt+")), "Alt+N; the ninth of ten has no number and names no key, the last is 9");
  setChordFamily("ctrl+alt"); numberTabStrips([bar], false);
  assert.deepEqual(titles(), keyed(digits("Ctrl+Alt+")), "the Ctrl+Alt family's");
  setChordFamily("ctrl+shift"); numberTabStrips([bar], false);
  assert.deepEqual(titles(), keyed(digits("Ctrl+Alt+")), "the Ctrl+Shift family keeps Ctrl+Alt+1–9");
  setChordFamily(DEFAULT_CHORD_FAMILY);
  numberTabStrips([bar], true);
  assert.deepEqual(titles(), keyed(digits("⌥⌘")), "⌥⌘N on macOS");
  setBinding("tabs.goto2", "Mod+Shift+2"); setBinding("tabs.goto3", null);
  numberTabStrips([bar], false);
  assert.deepEqual(titles().slice(0, 4), ["tab-0 (Alt+1)", "tab-1 (Ctrl+Shift+2)", "tab-2", "tab-3 (Alt+4)"], "a rebind shows, an unbound key is not named");
  for (const { triggerEl } of tabs) {
    assert.equal(triggerEl.getAttribute("aria-label"), triggerEl.querySelector(".tab-label").textContent, "the accessible name stays the bare title");
    assert.equal(triggerEl.querySelector(".tab-num").getAttribute("aria-hidden"), "true", "the number stays decorative");
  }
  // Without isMac, the keymap's own platform (navigator.platform), as the shell calls it.
  pinPlatform(t, "MacIntel");
  numberTabStrips([bar]);
  assert.equal(tabs[0].triggerEl.title, "tab-0 (⌥⌘1)");
  // A hidden tab loses its key with its number; the rest take their new ones.
  tabs[0].tabEl.hidden = true; numberTabStrips([bar]);
  assert.deepEqual(titles().slice(0, 2), ["tab-0", "tab-1 (⌥⌘1)"]);
});

// The tooltip's parts (setTabTitle): the key (numberTabStrips) and the needs-input note (shell.mjs
// syncTabNeedsInput) are written apart, in either order, and neither puts back the other's old part.
test("the key and a note compose in the tooltip, whichever is written last", t => {
  pinPlatform(t);
  const { doc } = fixture(t);
  const { bar, tabs } = strip(doc, ["a", "b"]);
  const trigger = tabs[1].triggerEl;
  setTabTitle(trigger, { note: "Needs input: Pick one?" });
  assert.equal(trigger.title, "b\nNeeds input: Pick one?");
  numberTabStrips([bar]);
  assert.equal(trigger.title, "b (Alt+2)\nNeeds input: Pick one?");
  tabs[0].tabEl.remove(); numberTabStrips([bar]);
  assert.equal(trigger.title, "b (Alt+1)\nNeeds input: Pick one?", "a renumber keeps the note");
  setTabTitle(trigger, { note: null });
  assert.equal(trigger.title, "b (Alt+1)", "clearing the note keeps the key");
  // A trigger the chrome did not draw starts from its own title as the name.
  const bare = doc.createElement("button"); bare.title = "plain";
  setTabTitle(bare, { key: "Alt+5" });
  assert.equal(bare.title, "plain (Alt+5)");
});

test("numberTabStrips writes only what changed, so a strip observer sees nothing on a no-op pass", async t => {
  const { doc, window } = fixture(t);
  const { bar } = strip(doc, ["a", "b", "c"]);
  numberTabStrips([bar]);
  const seen = [];
  const observer = new window.MutationObserver(records => seen.push(...records));
  observer.observe(bar, { childList: true, subtree: true, characterData: true, attributes: true });
  numberTabStrips([bar]);
  await new Promise(resolve => setTimeout(resolve, 0));
  observer.disconnect();
  assert.deepEqual(seen, []);
});

// Slice 3d (the prototype's "1 name ●"): the number leads, the status dot follows the name, the branch comes last, and
// the floor budgets all three, so at the floor the name gives way and the number and the dot stay. The DOM keeps its
// order (dot, name, branch, number; the trigger's name is its aria-label); CSS `order` lays the line out. jsdom has no
// layout, so the geometry is proven live: the renderer's shell.css and theme.css in the Desktop's own Chromium (dark
// palette, the shipped system UI face, 12.5px, the active tab, 2026-11-22). The number is 6.1px wide at 11px in the
// chrome's sans, before the trigger's 8px gap. The status slot is 12px since 2026-11-23 (the 7px dot centred in it, or
// the 12px Needs input glyph), which added 5px to the floor and to a tab's natural width (Chromium, shell.css).
//   - At the floor (181px tab, 137px trigger), "oats-desktop-developer-spawn-flow" keeps its name at 102.9px, the
//     number and the dot on the first line (8px and 11px into the 28px trigger); with a branch, the branch wraps away.
//   - At the floor, "A-reviewer" (59.8px) shows whole beside its number and its dot.
//   - With room, "oats-desktop-developer-ui" (144.5px) shows whole: the tab is 222.7px = 44 chrome + 6.1 + 8 + 144.5 +
//     8 + 12, the number and the status slot adding to its natural width. Tabs and triggers are 28px pills, centred in the bar.
// This pins the rules that make that happen.
test("the number leads, the dot follows the name, and the floor keeps both: the name gives way (slice 3d)", t => {
  const { doc, window } = fixture(t);
  const name = "oats-desktop-developer-spawn-flow";
  const { tabEl, triggerEl } = createTabChrome(doc, "n", name, false, { dot: "on", detail: "feat/x", tailAt: tabNameTailStart(name, "oats-desktop-developer"), tailEnd: name.length });
  doc.getElementById("tabbar").append(tabEl);
  const style = el => window.getComputedStyle(el);
  assert.deepEqual([...triggerEl.children].map(el => el.className), ["tab-dot on", "tab-label split", "tab-detail", "tab-num"], "the DOM's order is unchanged");
  const order = el => style(triggerEl.querySelector(el)).order;
  assert.deepEqual([order(".tab-num"), order(".tab-label"), order(".tab-dot"), order(".tab-detail")], ["-1", "0", "1", "2"], "the line reads 1 · name · dot · branch");
  const trigger = style(triggerEl);
  assert.deepEqual([trigger.display, trigger.flexWrap, trigger.alignContent, trigger.alignItems, trigger.overflow, trigger.alignSelf],
    ["flex", "wrap", "flex-start", "center", "hidden", "stretch"], "what wraps lands on a second line the trigger clips");
  assert.equal(trigger.gap, "8px");
  const rules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]);
  const spacer = rules.find(rule => rule.selectorText === ".tab-trigger::before");
  assert.ok(spacer, "a spacer holds the first line at the trigger's full height");
  assert.deepEqual(["content", "width", "height", "margin-right", "flex-shrink"].map(p => spacer.style.getPropertyValue(p)),
    ['""', "0px", "100%", "-8px", "0"], "zero wide, full height, its gap cancelled");
  const label = style(triggerEl.querySelector(".tab-label"));
  assert.equal(label.flexBasis, "min(var(--tab-name-min), 100% - 37px)", "line breaking sees the name at its minimum at most");
  assert.deepEqual([label.flexGrow, label.flexShrink, label.maxWidth, label.minWidth], ["1000", "1", "max-content", "0px"],
    "it grows from there to its whole width, no further, ahead of the branch");
  const px = prop => Number.parseFloat(style(tabEl).getPropertyValue(prop));
  const DOT_AND_GAP = 12 + 8, NUMBER_AND_GAP = 7 + 8, WIDEST_LEAD = NUMBER_AND_GAP + 14 + 8; // the status slot (the dot or the Needs input glyph) and its gap; the number and its; an artifact's icon and its gap after the number
  assert.equal(px("--tab-name-min"), px("--tab-min") - px("--tab-chrome") - NUMBER_AND_GAP - DOT_AND_GAP,
    "the name's minimum is what the floor budgets it (visual-rendering-regressions.test.mjs), so at the floor the number and the dot stay");
  assert.equal(Number(/100% - (\d+)px/.exec(label.flexBasis)[1]), WIDEST_LEAD,
    "the basis never exceeds the line after the widest lead, so the name itself never wraps");
  const detail = style(triggerEl.querySelector(".tab-detail"));
  assert.deepEqual([detail.flexGrow, detail.flexBasis], ["1", "0px"], "the branch still gives way first");
  const num = triggerEl.querySelector(".tab-num"), n = style(num);
  assert.deepEqual([n.flexGrow, n.flexShrink, n.whiteSpace], ["0", "0", "nowrap"], "the number is whole or gone, never squeezed");
  assert.equal(n.color, "var(--faint)");
  assert.equal(n.fontSize, "11px", "quiet, like the branch");
  assert.equal(n.display, "none", "an unnumbered tab's number takes no room");
  num.hidden = false; num.textContent = "1";
  assert.notEqual(style(num).display, "none");
  // The tab's cap and floor are unchanged (visual-rendering-regressions.test.mjs pins them).
  assert.equal(style(tabEl).maxWidth, "fit-content");
});
