// Spec F, #1383: the command palette lists instances as the sidebar draws its
// tree (same relation groups and depth, from the sidebar's own builders; the
// same connectors and state dots, from the sidebar's own code and rules), keeps
// the list's order under a query with non-matching ancestors as disabled context
// rows, and cycles its rows with its own chord (⌘K / Ctrl+Shift+K) while open.
// While open, its group keys (⌘N / ⌥⌘N, Alt+Shift+↓ / ↑) jump between groups,
// over every binding, and its footer names them; Quick Open takes neither.
// Its recency order is palette-recency.test.mjs's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { paletteRows, createPalette, PALETTE_COMMAND_CAP } from "../renderer/palette.mjs";
import { createOverlayPicker } from "../renderer/overlay-picker.mjs";
import { createQuickOpen } from "../renderer/quick-open.mjs";
import { treeConnectors } from "../renderer/instance-tree-view.mjs";
import { rosterGroups, instanceId } from "../../client/instance-tree.mjs";
import { rosterSections } from "../../client/roster-sections.mjs";
import { pickerCycleDirection, paletteGroupDirection, paletteGroupHint, setBinding, resetBinding, setChordFamily, DEFAULT_KEYMAP } from "../renderer/keybindings.mjs";
import { DEFAULT_CHORD_FAMILY } from "../../client/keymap.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";

const at = (instance, extra = {}) => ({ instance, agent: "dev", home: `/w/${instance}`, agentsRoot: "/w", running: true, ...extra });
// Two relation clusters and two unrelated instances, deliberately out of order.
const ROSTER = [
  at("solo-y", { running: false }),
  at("grandchild", { parentInstance: "child-a" }),
  at("lead"),
  at("child-b", { parentInstance: "lead", running: false }),
  at("alpha", { running: false }),
  at("solo-x"),
  at("child-a", { parentInstance: "lead" }),
  at("alpha-kid", { parentInstance: "alpha" }),
];
const COMMANDS = [{ label: "Theme: toggle", detail: "", run: () => {} }, { label: "Split: terminal right", detail: () => "⌘\\", run: () => {} }];
const instanceRows = rows => rows.filter(row => row.group);

test("an empty query lists every instance in the sidebar's groups, order and depth, then the commands", () => {
  const rows = paletteRows(ROSTER, COMMANDS, "", { openTerminal() {} });
  assert.deepEqual(instanceRows(rows).map(r => [r.group.label, r.label, r.depth, r.under || null]), [
    ["alpha", "alpha", 0, null], ["alpha", "alpha-kid", 1, "under alpha"],
    ["lead", "lead", 0, null], ["lead", "child-a", 1, "under lead"], ["lead", "grandchild", 2, "under child-a"], ["lead", "child-b", 1, "under lead"],
    ["independent", "solo-x", 0, null], ["independent", "solo-y", 0, null],
  ]);
  // Parity: the sidebar's own builder over the same roster gives the same sequence.
  const sidebar = rosterGroups(ROSTER, ROSTER).flatMap(g => g.clusters.flatMap(c => c.instances.map(i => [g.key, i.instance, i.depth])));
  assert.deepEqual(instanceRows(rows).map(r => [r.group.key, r.label, r.depth]), sidebar);
  assert.deepEqual(rows.slice(ROSTER.length).map(r => r.label), ["Theme: toggle", "Split: terminal right"], "commands follow");
  assert.equal(rows.at(-1).detail, "⌘\\", "live chord details still evaluate");
  assert.ok(rows.every(r => !r.context && typeof r.run === "function"), "no query: every row opens");
  assert.equal(rows.length, ROSTER.length + COMMANDS.length, "no instance is capped or hidden");
});

test("collapsed sidebar state is ignored and every instance is listed, however many", () => {
  const many = Array.from({ length: 40 }, (_, i) => at(`inst-${String(i).padStart(2, "0")}`));
  const rows = paletteRows(many, [], "", { openTerminal() {} });
  assert.equal(rows.length, 40, "the old 12-row cap no longer cuts instances");
});

test("a query keeps tree order: matches at their depth, their non-matching ancestors as context rows", () => {
  const opened = [];
  const rows = paletteRows(ROSTER, COMMANDS, "grand", { openTerminal: ref => opened.push(ref) });
  assert.deepEqual(rows.map(r => [r.label, r.depth, !!r.context]), [["lead", 0, true], ["child-a", 1, true], ["grandchild", 2, false]]);
  assert.ok(rows.filter(r => r.context).every(r => r.run === undefined), "a context row cannot open anything");
  rows[2].run();
  assert.deepEqual(opened, [{ instance: "grandchild", home: "/w/grandchild", agentsRoot: "/w" }]);
  // Two matches in one cluster: tree order, not score order; the shared ancestor appears once.
  const both = paletteRows(ROSTER, [], "child", { openTerminal() {} });
  assert.deepEqual(both.map(r => [r.label, !!r.context]), [["lead", true], ["child-a", false], ["grandchild", false], ["child-b", false]]);
});

test("'>' restricts to commands, and commands keep their own cap after the instances", () => {
  const commands = Array.from({ length: 20 }, (_, i) => ({ label: `Command ${i}`, run() {} }));
  const all = paletteRows(ROSTER, commands, "", { openTerminal() {} });
  assert.equal(all.length, ROSTER.length + PALETTE_COMMAND_CAP);
  const onlyCommands = paletteRows(ROSTER, commands, ">", { openTerminal() {} });
  assert.equal(onlyCommands.length, PALETTE_COMMAND_CAP);
  assert.ok(onlyCommands.every(r => !r.group));
  assert.deepEqual(paletteRows(ROSTER, COMMANDS, ">theme").map(r => r.label), ["Theme: toggle"]);
});

test("the palette's chord cycles: Mod+K down, Shift down to up; a chord holding Shift has no Shift form; rebinds follow", t => {
  t.after(() => resetBinding("app.palette"));
  const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.deepEqual(DEFAULT_KEYMAP["app.palette"], { mac: "Mod+K", other: "Alt+K" });
  assert.equal(pickerCycleDirection(ev("k", { metaKey: true }), "app.palette", true), 1);
  assert.equal(pickerCycleDirection(ev("K", { metaKey: true, shiftKey: true }), "app.palette", true), -1);
  assert.equal(pickerCycleDirection(ev("j", { metaKey: true }), "app.palette", true), 0);
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true }), "app.palette", true), 0, "⌃K is not ⌘K on macOS");
  // Linux/Windows, the default Alt family: Alt+K down, Alt+Shift+K up.
  assert.equal(pickerCycleDirection(ev("k", { altKey: true }), "app.palette", false), 1);
  assert.equal(pickerCycleDirection(ev("K", { altKey: true, shiftKey: true }), "app.palette", false), -1);
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true }), "app.palette", false), 0, "plain Ctrl+K is the program's");
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true, altKey: true }), "app.palette", false), 0, "Ctrl+Alt+K is no binding in the Alt family");
  assert.equal(pickerCycleDirection(ev("p", { altKey: true }), "app.palette", false), 0, "Alt+P is Quick Open's");
  // The Ctrl+Alt family: Ctrl+Alt+K down, Ctrl+Alt+Shift+K up, and Alt+K is nothing.
  setChordFamily("ctrl+alt");
  t.after(() => setChordFamily(DEFAULT_CHORD_FAMILY));
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true, altKey: true }), "app.palette", false), 1);
  assert.equal(pickerCycleDirection(ev("K", { ctrlKey: true, altKey: true, shiftKey: true }), "app.palette", false), -1);
  assert.equal(pickerCycleDirection(ev("k", { altKey: true }), "app.palette", false), 0);
  setChordFamily(DEFAULT_CHORD_FAMILY);
  // A rebind that already holds Shift has no reverse chord: ArrowUp moves up there.
  setBinding("app.palette", "Ctrl+Shift+K");
  assert.equal(pickerCycleDirection(ev("K", { ctrlKey: true, shiftKey: true }), "app.palette", false), 1);
  assert.equal(pickerCycleDirection(ev("k", { ctrlKey: true }), "app.palette", false), 0, "no reverse chord: ArrowUp moves up");
  setBinding("app.palette", "Mod+J");
  assert.equal(pickerCycleDirection(ev("k", { metaKey: true }), "app.palette", true), 0);
  assert.equal(pickerCycleDirection(ev("j", { metaKey: true }), "app.palette", true), 1);
  assert.equal(pickerCycleDirection(ev("j", { metaKey: true, shiftKey: true }), "app.palette", true), -1);
  setBinding("app.palette", null);
  assert.equal(pickerCycleDirection(ev("k", { metaKey: true }), "app.palette", true), 0, "unbound: nothing cycles");
  setBinding("app.palette", "K");
  assert.equal(pickerCycleDirection(ev("k"), "app.palette", true), 0, "a plain chord never steals typing");
});

// The palette as the shell builds it (shell.mjs createPalette): its cycle chord, its group keys and footer, on macOS or elsewhere.
function palette(t, roster = ROSTER, { isMac = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button></body>', { url: "http://localhost" });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const opened = [], reachedShell = [];
  // The keymap engine listens on window: a consumed cycle chord must never reach it.
  dom.window.addEventListener("keydown", e => reachedShell.push(e.key));
  const picker = createPalette({
    loadInstances: async () => roster, openTerminal: ref => opened.push(ref.instance),
    commands: COMMANDS.map(c => ({ ...c, run: () => opened.push(c.label) })),
    cycleKey: e => pickerCycleDirection(e, "app.palette", isMac),
    groupKey: e => paletteGroupDirection(e, isMac), footer: paletteGroupHint(isMac), doc,
  });
  t.after(() => picker.close());
  doc.getElementById("opener").focus();
  const key = (key, mods = {}, type = "keydown") => {
    const event = new dom.window.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...mods });
    doc.activeElement.dispatchEvent(event);
    return event;
  };
  const input = () => doc.querySelector(".palette-input");
  const active = () => doc.getElementById(input().getAttribute("aria-activedescendant"))?.querySelector(".plabel").textContent;
  const filter = value => { input().value = value; input().dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return { dom, doc, picker, opened, reachedShell, key, input, active, filter };
}

test("⌘K while open moves down and wraps, ⇧⌘K moves up; releasing commits nothing; Enter opens; Esc closes", async t => {
  const p = palette(t);
  await p.picker.open();
  assert.equal(p.active(), "alpha");
  for (const expected of ["alpha-kid", "lead", "child-a"]) {
    const event = p.key("k", { metaKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(p.active(), expected);
  }
  p.key("Meta", {}, "keyup"); p.key("k", {}, "keyup");
  assert.deepEqual(p.opened, [], "releasing the chord does not commit");
  p.key("k", { metaKey: true, shiftKey: true });
  assert.equal(p.active(), "lead");
  assert.deepEqual(p.reachedShell, [], "the chord never reaches the shell's keymap (no close, no reopen)");
  for (let i = 0; i < 2; i++) p.key("k", { metaKey: true, shiftKey: true });
  assert.equal(p.active(), "alpha");
  p.key("k", { metaKey: true, shiftKey: true });
  assert.equal(p.active(), "Split: terminal right", "up from the first row wraps to the last");
  p.key("k", { metaKey: true });
  assert.equal(p.active(), "alpha", "down from the last row wraps to the first");
  p.picker.toggle(); // the same action from anywhere else agrees: it cycles, it does not close
  assert.ok(p.doc.querySelector(".palette-overlay")); assert.equal(p.active(), "alpha-kid");
  p.key("Enter");
  assert.deepEqual(p.opened, ["alpha-kid"]);
  assert.equal(p.doc.querySelector(".palette-overlay"), null);
  p.doc.getElementById("opener").focus();
  await p.picker.open();
  assert.ok(p.key("Escape").defaultPrevented);
  assert.equal(p.doc.querySelector(".palette-overlay"), null, "Esc closes");
  assert.equal(p.doc.activeElement.id, "opener", "and returns focus");
  assert.deepEqual(p.opened, ["alpha-kid"]);
});

test("context rows are disabled options the arrows, the chord and the pointer skip", async t => {
  const p = palette(t);
  await p.picker.open();
  p.filter("grand");
  const options = [...p.doc.querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map(o => o.getAttribute("aria-disabled")), ["true", "true", null]);
  assert.equal(p.active(), "grandchild", "the first selectable row is active, not its ancestor");
  p.key("ArrowUp"); assert.equal(p.active(), "grandchild");
  p.key("k", { metaKey: true }); assert.equal(p.active(), "grandchild", "cycling with one selectable row stays on it");
  p.key("k", { metaKey: true, shiftKey: true }); assert.equal(p.active(), "grandchild");
  options[0].dispatchEvent(new p.dom.window.MouseEvent("mousemove", { bubbles: true }));
  assert.equal(p.active(), "grandchild");
  options[0].dispatchEvent(new p.dom.window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(p.opened, [], "a context row never runs");
  assert.ok(options.slice(0, 2).every(o => o.getAttribute("aria-selected") === "false" && o.classList.contains("context")));
  p.filter("child");
  assert.equal(p.active(), "child-a");
  p.key("ArrowDown"); assert.equal(p.active(), "grandchild");
  p.key("ArrowDown"); assert.equal(p.active(), "child-b");
  p.key("ArrowDown"); assert.equal(p.active(), "child-b", "the arrows still clamp");
  p.key("k", { metaKey: true }); assert.equal(p.active(), "child-a", "the chord wraps past the context row");
});

test("each relation group is one named role=group in the listbox; depth is indentation plus words", async t => {
  const p = palette(t);
  await p.picker.open();
  const list = p.doc.querySelector('[role="listbox"]');
  const groups = [...list.querySelectorAll(':scope > [role="group"]')];
  assert.deepEqual(groups.map(g => g.getAttribute("aria-label")), ["alpha", "lead", "independent"], "named once, on entry");
  assert.deepEqual(groups.map(g => [...g.children].map(o => o.querySelector(".plabel").textContent)),
    [["alpha", "alpha-kid"], ["lead", "child-a", "grandchild", "child-b"], ["solo-x", "solo-y"]]);
  assert.ok(groups.every(g => [...g.children].every(o => o.getAttribute("role") === "option" && !o.hasAttribute("aria-label"))),
    "options keep their content name; the group's name is not repeated per row");
  const commands = [...list.querySelectorAll(':scope > [role="option"]')];
  assert.deepEqual(commands.map(o => o.querySelector(".plabel").textContent), ["Theme: toggle", "Split: terminal right"], "commands follow, ungrouped");
  const grandchild = [...list.querySelectorAll('[role="option"]')].find(o => o.querySelector(".plabel").textContent === "grandchild");
  assert.equal(grandchild.style.getPropertyValue("--depth"), "2");
  assert.equal(grandchild.querySelector(".sr-only").textContent, ", under child-a", "read with the option, visually hidden");
  assert.equal(grandchild.hasAttribute("aria-level"), false, "aria-level is not an option's attribute");
  assert.equal(list.querySelector('[aria-level]'), null);
  const ids = [...list.querySelectorAll('[role="option"]')].map(o => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(p.input().getAttribute("aria-activedescendant"), ids[0]);
});

test("the shell wires the cycle to the live app.palette chord; Quick Open (⌘P) keeps its plain toggle", async () => {
  const { readFileSync } = await import("node:fs");
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /cycleKey: \(e\) => pickerCycleDirection\(e, "app\.palette", isMac\)/);
  assert.match(shell, /groupKey: \(e\) => paletteGroupDirection\(e, isMac\),\n\s*footer: paletteGroupHint\(isMac\),/, "the group keys and their footer, per platform");
  assert.equal(shell.match(/groupKey:|footer: paletteGroupHint/g).length, 2, "only the palette gets them");
  assert.match(shell, /registerAction\(\{ id: "app\.palette", [^\n]*palette\.toggle\(\)/, "the action still opens it; open, it cycles");
  const quickOpen = readFileSync(new URL("../renderer/quick-open.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(quickOpen, /cycleKey/, "a second ⌘P still closes Quick Open");
  assert.doesNotMatch(quickOpen, /groupKey|footer/, "Quick Open has no group keys and no footer");
});

// The palette's group keys (packages/client/keymap.mjs PALETTE_KEYS; paletteGroupDirection's pure
// test is keymap-linux.test.mjs's). ROSTER's runs: alpha (2 rows), lead (4), independent (2), then
// the two commands, one run of their own.
test("⌘N moves to the next group's first row and ⌥⌘N to the previous one's, both wrapping; the commands are a group", async t => {
  const p = palette(t);
  await p.picker.open();
  assert.equal(p.active(), "alpha");
  for (const expected of ["lead", "solo-x", "Theme: toggle", "alpha"]) {
    const event = p.key("n", { metaKey: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(p.active(), expected);
  }
  p.key("Dead", { metaKey: true, altKey: true, code: "KeyN" });
  assert.equal(p.active(), "Theme: toggle", "previous from the first group wraps to the commands");
  p.key("Dead", { metaKey: true, altKey: true, code: "KeyN" });
  assert.equal(p.active(), "solo-x");
  // From inside a group: next is the next group's first row, previous the first row of the one before (not this one's).
  p.key("ArrowDown"); assert.equal(p.active(), "solo-y");
  p.key("Dead", { metaKey: true, altKey: true, code: "KeyN" });
  assert.equal(p.active(), "lead");
  p.key("ArrowDown"); p.key("ArrowDown"); assert.equal(p.active(), "grandchild");
  p.key("n", { metaKey: true });
  assert.equal(p.active(), "solo-x");
  p.key("ArrowDown"); p.key("ArrowDown"); p.key("ArrowDown"); assert.equal(p.active(), "Split: terminal right");
  p.key("n", { metaKey: true });
  assert.equal(p.active(), "alpha", "next from the commands' last row wraps to the first group");
  // The plain arrows bubble on as before (the engine leaves a consumed event alone); the group keys never do.
  assert.deepEqual(p.reachedShell.filter(key => key !== "ArrowDown"), [], "never reaches the keymap engine: ⌘N is not app.chooseSoul while open");
  assert.deepEqual(p.opened, [], "a group key commits nothing");
  p.key("Enter");
  assert.deepEqual(p.opened, ["alpha"]);
});

test("Linux/Windows: Alt+Shift+↓ / ↑ move between groups, over roster.openNext / openPrevious and the input's arrows", async t => {
  const p = palette(t, ROSTER, { isMac: false });
  await p.picker.open();
  assert.equal(p.active(), "alpha");
  assert.equal(p.key("ArrowDown", { altKey: true, shiftKey: true }).defaultPrevented, true);
  assert.equal(p.active(), "lead", "the next group's first row, not the next row (alpha-kid)");
  p.key("ArrowDown", { altKey: true, shiftKey: true }); assert.equal(p.active(), "solo-x");
  p.key("ArrowUp", { altKey: true, shiftKey: true }); assert.equal(p.active(), "lead");
  p.key("ArrowUp", { altKey: true, shiftKey: true }); assert.equal(p.active(), "alpha");
  p.key("ArrowUp", { altKey: true, shiftKey: true }); assert.equal(p.active(), "Theme: toggle", "wraps to the commands");
  p.key("ArrowDown", { altKey: true, shiftKey: true }); assert.equal(p.active(), "alpha", "and back");
  assert.deepEqual(p.reachedShell, [], "roster.openNext / openPrevious never see them while open");
  // The plain arrows and the cycle chord are unchanged.
  p.key("ArrowDown"); assert.equal(p.active(), "alpha-kid");
  p.key("k", { altKey: true }); assert.equal(p.active(), "lead");
  assert.equal(p.doc.querySelector(".palette-footer").textContent, "Alt+Shift+↓ next group · Alt+Shift+↑ previous");
});

test("group keys skip context rows: a group's first selectable row; one group: both go to its first row", async t => {
  const p = palette(t);
  await p.picker.open();
  p.filter("id"); // alpha-kid under alpha, and lead's three children under lead: two groups led by context rows
  assert.deepEqual([...p.doc.querySelectorAll('[role="option"]')].map(o => [o.querySelector(".plabel").textContent, o.getAttribute("aria-disabled")]),
    [["alpha", "true"], ["alpha-kid", null], ["lead", "true"], ["child-a", null], ["grandchild", null], ["child-b", null]]);
  assert.equal(p.active(), "alpha-kid");
  p.key("n", { metaKey: true }); assert.equal(p.active(), "child-a", "past lead, a context row");
  p.key("n", { metaKey: true }); assert.equal(p.active(), "alpha-kid", "wraps past alpha, a context row");
  p.key("Dead", { metaKey: true, altKey: true, code: "KeyN" }); assert.equal(p.active(), "child-a");
  p.filter("child"); // one group: lead (context), child-a, grandchild, child-b
  p.key("ArrowDown"); p.key("ArrowDown"); assert.equal(p.active(), "child-b");
  p.key("n", { metaKey: true }); assert.equal(p.active(), "child-a", "a single group: next is its first selectable row");
  p.key("ArrowDown"); assert.equal(p.active(), "grandchild");
  p.key("Dead", { metaKey: true, altKey: true, code: "KeyN" }); assert.equal(p.active(), "child-a", "and so is previous");
  p.filter(">"); // only the commands: one run
  p.key("ArrowDown"); assert.equal(p.active(), "Split: terminal right");
  p.key("n", { metaKey: true }); assert.equal(p.active(), "Theme: toggle", "the commands alone are one group");
  // No rows: nothing to move to, and the key is still the palette's.
  p.filter("zzzz");
  assert.match(p.doc.querySelector(".palette-list").textContent, /No matches/);
  assert.equal(p.key("n", { metaKey: true }).defaultPrevented, true);
  assert.equal(p.doc.querySelector(".palette-input").hasAttribute("aria-activedescendant"), false);
  assert.deepEqual(p.reachedShell.filter(key => key !== "ArrowDown"), [], "only the plain arrows bubble on");
});

test("the picker's group move skips a run with no selectable row, and no selectable row moves nothing", async t => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost" });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const row = (label, key, context = false) => ({ label, ...(key ? { group: { key, label: key } } : {}), ...(context ? { context } : { run() {} }) });
  let rows = [row("a1", "a"), row("b1", "b", true), row("b2", "b", true), row("c1", "c", true), row("c2", "c"), row("x"), row("y")];
  const picker = createOverlayPicker({ placeholder: "", ariaLabel: "Groups", loadItems: async () => null, computeRows: () => rows,
    groupKey: e => (e.key === "n" ? 1 : e.key === "p" ? -1 : 0), doc });
  t.after(() => picker.close());
  await picker.open();
  const input = doc.querySelector(".palette-input");
  const press = key => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const active = () => doc.getElementById(input.getAttribute("aria-activedescendant"))?.querySelector(".plabel").textContent;
  assert.equal(active(), "a1");
  press("n"); assert.equal(active(), "c2", "b has no selectable row; c's first selectable row is c2");
  press("n"); assert.equal(active(), "x", "the ungrouped rows are one run");
  press("n"); assert.equal(active(), "a1");
  press("p"); assert.equal(active(), "x");
  press("p"); assert.equal(active(), "c2");
  press("p"); assert.equal(active(), "a1", "past b");
  assert.equal(doc.querySelector(".palette-footer"), null, "no footer unless given");
  assert.equal(input.hasAttribute("aria-describedby"), false, "and no description");
  rows = [row("b1", "b", true), row("c1", "c", true)];
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  press("n"); press("p");
  assert.equal(input.hasAttribute("aria-activedescendant"), false, "no selectable row: nothing is active, nothing moves");
  assert.equal(doc.querySelectorAll(".palette-item.active").length, 0);
});

test("the group keys act only while the palette is open: closed, ⌘N reaches the keymap engine", async t => {
  const p = palette(t);
  await p.picker.open();
  p.key("n", { metaKey: true });
  assert.deepEqual(p.reachedShell, []);
  p.key("Escape");
  assert.equal(p.doc.querySelector(".palette-overlay"), null);
  const closed = p.key("n", { metaKey: true });
  assert.equal(closed.defaultPrevented, false, "the palette no longer takes it");
  assert.deepEqual(p.reachedShell, ["n"], "the window listener (app.chooseSoul) sees it");
  await p.picker.open();
  p.key("n", { metaKey: true });
  assert.deepEqual(p.reachedShell, ["n"], "open again: the palette's again");
  p.picker.close();
  p.key("ArrowDown", { altKey: true, shiftKey: true });
  assert.deepEqual(p.reachedShell, ["n", "ArrowDown"]);
});

test("the footer names the group keys per platform: plain text in the dialog, after the list, and the input's description", async t => {
  const p = palette(t);
  await p.picker.open();
  const footer = p.doc.querySelector(".palette-footer");
  assert.equal(footer.textContent, "⌘N next group · ⌥⌘N previous");
  assert.equal(footer.parentElement, p.doc.querySelector('.palette[role="dialog"]'));
  assert.equal(footer.previousElementSibling, p.doc.querySelector('[role="listbox"]'), "under the list, never one of its options");
  assert.equal(footer.children.length, 0, "plain text");
  assert.equal(footer.hasAttribute("role"), false);
  assert.equal(p.doc.querySelector('[role="combobox"]').getAttribute("aria-describedby"), footer.id, "read once as it opens: the focus stays in the input");
  p.picker.close();
  assert.equal(p.doc.querySelector(".palette-footer"), null, "it goes with the palette");
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  const rule = css.match(/\.palette-footer \{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /color: var\(--muted\)/, "quiet, in a token the contrast inventory holds on the palette's surface");
  assert.match(rule, /font-size: 11\.5px/, "small, as the rows' details");
});

test("Quick Open takes no group keys and has no footer: ⌘N passes through, Alt+Shift+↓ is its arrow", async t => {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button></body>', { url: "http://localhost" });
  t.after(() => dom.window.close());
  const doc = dom.window.document, reached = [];
  dom.window.addEventListener("keydown", e => reached.push(e.key));
  const quickOpen = createQuickOpen({ loadSouls: async () => ({ agents: [{ name: "a-soul", work: "worktree" }, { name: "b-soul", work: "worktree" }] }), onPick() {}, doc });
  t.after(() => quickOpen.close());
  doc.getElementById("opener").focus();
  await quickOpen.open();
  const input = doc.querySelector(".palette-input");
  const key = (key, mods) => { const e = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }); input.dispatchEvent(e); return e; };
  const active = () => doc.getElementById(input.getAttribute("aria-activedescendant"))?.querySelector(".plabel").textContent;
  assert.equal(doc.querySelector(".palette-footer"), null);
  assert.equal(key("n", { metaKey: true }).defaultPrevented, false);
  assert.deepEqual(reached, ["n"], "⌘N reaches the keymap engine");
  key("ArrowDown", { altKey: true, shiftKey: true });
  assert.equal(active(), "b-soul", "the input's ArrowDown, one row, as before");
  assert.deepEqual(reached, ["n", "ArrowDown"]);
});

test("filterInstanceTree takes the palette's matcher and keeps the sidebar's default; rosterGroups is the sidebar's grouping", async () => {
  const { filterInstanceTree, instanceMatchesFilter } = await import("../../client/instance-tree.mjs");
  const names = list => list.map(i => i.instance);
  // Default (sidebar): substring over name/soul/repo, with ancestor paths, in source order.
  assert.deepEqual(names(filterInstanceTree(ROSTER, "grandchild")), ["grandchild", "lead", "child-a"]);
  assert.deepEqual(names(filterInstanceTree(ROSTER, "grandchild")), names(ROSTER.filter(i => ["grandchild", "lead", "child-a"].includes(i.instance))));
  assert.equal(filterInstanceTree(ROSTER, "  "), ROSTER, "no query: the roster itself");
  assert.ok(ROSTER.filter(i => instanceMatchesFilter(i, "kid")).every(i => i.instance === "alpha-kid"));
  // A predicate decides the matches; the identity-aware ancestor walk is the same.
  assert.deepEqual(names(filterInstanceTree(ROSTER, "x", i => i.instance === "alpha-kid")), ["alpha", "alpha-kid"]);
  // Groups: one sequence by root name (#1262), each multi-member cluster under its name, each run of single instances
  // an "independent" group keyed by its first member; decided on the full roster and projected to what is visible.
  const visible = ROSTER.filter(i => ["solo-x", "alpha-kid"].includes(i.instance));
  assert.deepEqual(rosterGroups(ROSTER, visible).map(g => [g.key, g.label, g.clusters.flatMap(c => names(c.instances))]),
    [["cluster:0:alpha", "alpha", ["alpha-kid"]], [`independent:${instanceId(ROSTER.find(i => i.instance === "solo-x"))}`, "independent", ["solo-x"]]], "a cluster with one visible member keeps its group and its name, as in the sidebar (#971)");
  assert.deepEqual(rosterGroups([], []), []);
});

test("one match out of a cluster is listed in the cluster's group, not under independent (#971)", async t => {
  // "lead" matches the root of a cluster of four and nothing else.
  const rows = instanceRows(paletteRows(ROSTER, [], "lead", { openTerminal() {} }));
  assert.deepEqual(rows.map(r => [r.group.key, r.group.label, r.label, !!r.context]), [["cluster:1:lead", "lead", "lead", false]]);
  assert.equal(rows[0].group.key, instanceRows(paletteRows(ROSTER, [], "", {})).find(r => r.label === "lead").group.key, "the group it is in with no query");
  // A match in one cluster and an unrelated one: each in its own group, in the roster's order.
  const mixed = instanceRows(paletteRows(ROSTER, [], "solo-x", { openTerminal() {} }));
  assert.deepEqual(mixed.map(r => [r.group.label, r.label]), [["independent", "solo-x"]], "an unrelated instance is still independent");
  const p = palette(t);
  await p.picker.open();
  p.filter("lead");
  const rendered = [...p.doc.querySelectorAll('[role="listbox"] > [role="group"]')];
  assert.deepEqual(rendered.map(g => [g.getAttribute("aria-label"), [...g.children].map(o => o.querySelector(".plabel").textContent)]), [["lead", ["lead"]]],
    "drawn as the cluster's named group");
});

test("two relation groups whose roots share a name (two agents roots) stay two named groups", async t => {
  const run = (instance, root, extra = {}) => ({ instance, agent: "dev", home: `${root}/${instance}`, agentsRoot: root, running: true, ...extra });
  const roster = [
    run("lead", "/a"), run("child-a", "/a", { parentInstance: "lead" }),
    run("lead", "/b"), run("child-b", "/b", { parentInstance: "lead" }),
  ];
  const groups = rosterGroups(roster, roster);
  assert.deepEqual(groups.map(g => g.label), ["lead", "lead"], "the sidebar's two clusters, each under its root's name");
  assert.equal(new Set(groups.map(g => g.key)).size, 2, "distinct keys: the picker's group boundary");
  const p = palette(t, roster);
  await p.picker.open();
  const rendered = [...p.doc.querySelectorAll('[role="listbox"] > [role="group"]')];
  assert.deepEqual(rendered.map(g => [g.getAttribute("aria-label"), [...g.children].map(o => o.querySelector(".plabel").textContent)]),
    groups.map(g => ["lead", g.clusters[0].instances.map(i => i.instance)]), "one role=group per cluster, in the sidebar's order");
});

// #482 (the Deployments page, merged with spec F): with several deployments the sidebar
// sections the roster by deployment, each clustered on its own. The palette lists the
// same sections in the same order, and a relation or a query's context never crosses one.
const D1 = { id: "/a", machine: "This Mac", path: "/a", label: "~/a", local: true, reachable: true, primary: true };
const D2 = { id: "remote:devbox:b", machine: "devbox", path: "/b", label: "~/b", local: false, reachable: true, primary: false };
const inD = (d, instance, extra = {}) => ({ instance, agent: "dev", home: `${d.path}/agents/dev/instances/${instance}`, agentsRoot: `${d.path}/agents`,
  running: true, deployment: { id: d.id }, ...extra });

test("several deployments: the palette lists the sidebar's sections in its order, each group named by its deployment (review, merge of #489)", () => {
  const roster = { instances: [inD(D2, "alpha"), inD(D1, "zeta"), inD(D1, "lead"), inD(D1, "kid", { parentInstance: "lead" })], deployments: [D1, D2] };
  const rows = instanceRows(paletteRows(roster, [], "", { openTerminal() {} }));
  assert.deepEqual(rows.map(r => r.label), ["lead", "kid", "zeta", "alpha"], "D1's groups first, as the panel lists the deployments: not alphabetical across them");
  const sidebar = rosterSections(roster.instances, roster.instances, roster.deployments, DESKTOP_TERMS)
    .flatMap(sec => sec.groups.flatMap(g => g.clusters.flatMap(c => c.instances.map(i => [`${sec.deployment.id}|${g.key}`, `${sec.label} · ${g.label}`, i.instance, i.depth]))));
  assert.deepEqual(rows.map(r => [r.group.key, r.group.label, r.label, r.depth]), sidebar, "the sidebar's own sections, groups and depth");
  const independents = [...new Set(rows.filter(r => r.group.label.endsWith("independent")).map(r => r.group.key))];
  assert.equal(independents.length, 2, "each deployment's independent group stays its own group");
  assert.deepEqual(paletteRows({ instances: ROSTER, deployments: [D1] }, [], "", {}).map(r => [r.group.key, r.label]),
    paletteRows(ROSTER, [], "", {}).map(r => [r.group.key, r.label]), "one deployment: exactly the single-roster rows");
});

test("several deployments: a parent name in another deployment is not a parent, and a query brings no context across", () => {
  const roster = { instances: [inD(D1, "lead"), inD(D2, "child", { parentInstance: "lead" })], deployments: [D1, D2] };
  const all = instanceRows(paletteRows(roster, [], "", { openTerminal() {} }));
  assert.deepEqual(all.map(r => [r.label, r.depth, r.under || null]), [["lead", 0, null], ["child", 0, null]], "D2's child is a root, as in the sidebar");
  const queried = instanceRows(paletteRows(roster, [], "child", { openTerminal() {} }));
  assert.deepEqual(queried.map(r => [r.label, !!r.context]), [["child", false]], "D1's lead is not shown as context");
});

// #1312: a sibling of a root says "sibling of <name>" on both ends' rows, seen and read; matching is unchanged.
const SIBLINGS = [
  at("bea", { siblingInstance: "ada" }),
  at("zed", { parentInstance: "ada" }),
  at("ada"),
  at("kid-1", { parentInstance: "lead" }),
  at("kid-2", { parentInstance: "lead" }),
  at("lead"),
];
const siblingOf = rows => instanceRows(rows).map(r => [r.label, r.sibling ?? null, !!r.context]);

test("root siblings: with no query both rows carry their sibling; co-children of one parent carry none", () => {
  const rows = instanceRows(paletteRows(SIBLINGS, [], "", { openTerminal() {} }));
  assert.deepEqual(siblingOf(rows), [
    ["ada", "sibling of bea", false], ["zed", null, false], ["bea", "sibling of ada", false],
    ["lead", null, false], ["kid-1", null, false], ["kid-2", null, false],
  ]);
  assert.ok(rows.filter(r => r.sibling == null).every(r => !Object.hasOwn(r, "sibling")), "a row without a sibling has no sibling field");
  assert.deepEqual(rows.filter(r => r.label.startsWith("kid")).map(r => r.under), ["under lead", "under lead"], "co-children read as under their parent");
  assert.deepEqual(rows.map(r => [r.group.label, r.label, r.depth]),
    rosterGroups(SIBLINGS, SIBLINGS).flatMap(g => g.clusters.flatMap(c => c.instances.map(i => [g.label, i.instance, i.depth]))), "order, groups and depth unchanged");
});

test("a match shown alone names its sibling; a context row too; a sibling's name does not match the other row", () => {
  assert.deepEqual(siblingOf(paletteRows(SIBLINGS, [], "bea", {})), [["bea", "sibling of ada", false]], "the match alone, over the full roster");
  assert.deepEqual(siblingOf(paletteRows(SIBLINGS, [], "ada", {})), [["ada", "sibling of bea", false]], "typing ada does not list bea");
  assert.deepEqual(siblingOf(paletteRows(SIBLINGS, [], "zed", {})), [["ada", "sibling of bea", true], ["zed", null, false]], "a context row says it too");
});

test("several deployments: a sibling link resolves only inside its deployment", () => {
  // D2's bea links to "ada": D1's ada (the only one) is never named, nor does it name bea.
  const across = { instances: [inD(D1, "ada"), inD(D2, "bea", { siblingInstance: "ada" })], deployments: [D1, D2] };
  assert.deepEqual(siblingOf(paletteRows(across, [], "", {})), [["ada", null, false], ["bea", null, false]]);
  // With an ada in each deployment, bea names its own deployment's ada; D1's ada names nobody.
  const both = { instances: [inD(D1, "ada"), inD(D2, "ada"), inD(D2, "bea", { siblingInstance: "ada" })], deployments: [D1, D2] };
  assert.deepEqual(instanceRows(paletteRows(both, [], "", {})).map(r => [r.group.key.split("|")[0], r.label, r.sibling ?? null]),
    [[D1.id, "ada", null], [D2.id, "ada", "sibling of bea"], [D2.id, "bea", "sibling of ada"]]);
});

test("rendered: relations are words read once, never shown: no quiet under or sibling text (#1383)", async t => {
  const p = palette(t, SIBLINGS);
  await p.picker.open();
  const option = name => [...p.doc.querySelectorAll('[role="option"]')].find(o => o.querySelector(".plabel").textContent === name);
  assert.equal(p.doc.querySelector(".punder, .punder-split"), null, "the dotted line carries siblinghood visibly");
  assert.equal(option("bea").querySelector(".pdetail .sr-only").textContent, ", sibling of ada", "read with the detail");
  assert.deepEqual([...option("zed").querySelectorAll(".pdetail .sr-only")].map(s => s.textContent), [", under ada"]);
  const read = node => [...node.childNodes].map(n => n.nodeType === 3 ? n.textContent : n.getAttribute("aria-hidden") === "true" ? "" : read(n)).join("");
  assert.equal(read(option("bea")).split("sibling of ada").length - 1, 1, "read exactly once");
  assert.equal(read(option("bea")).split("ada").length - 1, 1, "and shown nowhere else");
  assert.equal(option("kid-1").querySelector(".pdetail .sr-only").textContent, ", under lead");
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /punder/, "its rules are gone");
});

// #1383: each instance row carries what the sidebar's row draws from, and draws it with the sidebar's code.
test("instance rows carry the sidebar row's connectors and state; commands carry neither", () => {
  const rows = paletteRows(SIBLINGS, COMMANDS, "", { openTerminal() {} });
  const tree = instanceRows(rows);
  // The sidebar's connectors: treeConnectors over the sidebar's own cluster, with the full roster.
  const sidebar = new Map(rosterGroups(SIBLINGS, SIBLINGS).flatMap(g => g.clusters.flatMap(c => c.instances.map(i => [i.instance, treeConnectors(c.instances, i, SIBLINGS)]))));
  assert.deepEqual(tree.map(r => [r.label, r.connectors]), tree.map(r => [r.label, sidebar.get(r.label)]));
  const kinds = name => tree.find(r => r.label === name).connectors.map(c => `${c.kind}@${c.level}`);
  assert.deepEqual(kinds("ada"), ["down@0", "link-out@0"], "a root's stem, and the dotted line on to its sibling root");
  assert.deepEqual(kinds("zed"), ["elbow@0", "link-through@0"], "a child's elbow, the dotted line passing beside it");
  assert.deepEqual(kinds("bea"), ["link-in@0"]);
  assert.deepEqual(kinds("kid-1"), ["elbow@0", "line@0"], "a non-last child: elbow and its parent's line on");
  assert.deepEqual(kinds("kid-2"), ["elbow@0"]);
  assert.ok(tree.every(r => r.state === "running"));
  assert.deepEqual(instanceRows(paletteRows(ROSTER, [], "", {})).map(r => [r.label, r.state]),
    [["alpha", "stopped"], ["alpha-kid", "running"], ["lead", "running"], ["child-a", "running"], ["grandchild", "running"], ["child-b", "stopped"], ["solo-x", "running"], ["solo-y", "stopped"]]);
  assert.deepEqual(paletteRows([at("maybe", { running: null })], [], "", {}).map(r => r.state), ["unknown"]);
  for (const row of rows.filter(r => !r.group)) assert.ok(!Object.hasOwn(row, "connectors") && !Object.hasOwn(row, "state"), row.label);
});

test("under a query a row's connectors are the sidebar's over the listed cluster: context rows keep theirs", () => {
  const rows = instanceRows(paletteRows(ROSTER, [], "grand", { openTerminal() {} }));
  assert.deepEqual(rows.map(r => [r.label, !!r.context, r.connectors.map(c => `${c.kind}@${c.level}`)]), [
    ["lead", true, ["down@0"]], ["child-a", true, ["elbow@0", "down@1"]], ["grandchild", false, ["elbow@1"]],
  ], "the filtered sidebar draws the same lines");
});

test("rendered: the sidebar's guides (one builder) and state dot on each instance row; commands keep the chevron", async t => {
  const roster = [...SIBLINGS, at("maybe", { running: null }), at("idle", { running: false })];
  const p = palette(t, roster);
  await p.picker.open();
  const option = name => [...p.doc.querySelectorAll('[role="option"]')].find(o => o.querySelector(".plabel").textContent === name);
  const guides = name => [...option(name).querySelectorAll(":scope > .ctx-guides > .ctx-guide")].map(g => `${g.className.replace("ctx-guide ", "")}@${g.style.getPropertyValue("--guide-level")}`);
  assert.deepEqual(guides("ada"), ["down@0", "link-out@0"]);
  assert.deepEqual(guides("zed"), ["elbow@0", "link-through@0"]);
  const ada = option("ada");
  assert.equal(ada.firstElementChild.className, "ctx-guides", "the guides lead the row");
  assert.equal(ada.firstElementChild.getAttribute("aria-hidden"), "true");
  assert.ok(ada.classList.contains("tree"), "a tree row takes the sidebar's dot column");
  assert.equal(option("zed").style.getPropertyValue("--depth"), "1");
  const dot = name => option(name).querySelector(".ctx-dot");
  assert.equal(dot("ada").className, "ctx-dot on");
  assert.equal(dot("idle").className, "ctx-dot off");
  assert.equal(dot("maybe").className, "ctx-dot unknown", "unknown liveness is the sidebar's unknown dot");
  assert.equal(option("maybe").querySelector(".picon, .pdot"), null, "never the commands' chevron");
  assert.ok([...p.doc.querySelectorAll('[role="option"]')].filter(o => o.querySelector(".ctx-dot")).every(o => o.querySelector(".ctx-dot").getAttribute("aria-hidden") === "true"));
  const command = option("Theme: toggle");
  assert.ok(command.querySelector(".picon"), "a command keeps its chevron");
  assert.equal(command.querySelector(".ctx-guides, .ctx-dot"), null);
  assert.ok(!command.classList.contains("tree"));
  // The one builder: the shell draws both its row kinds with it, and the picker too; nobody repeats the loop.
  for (const file of ["../renderer/shell.mjs", "../renderer/overlay-picker.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /className = `ctx-guide \$\{kind\}`/, file);
  }
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.equal(shell.match(/treeGuides\(document, treeConnectors\(items, i, instances\)\)/g)?.length, 2, "the roster row and the pending spawn's");
});

test("the palette's tree rows reuse the sidebar's guide rules with the sidebar's geometry (no copied .ctx-guide rule)", () => {
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, sel, body]) => [sel.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body]);
  const rule = sel => rules.find(([s]) => s === sel)?.[1] ?? "";
  const prop = (sel, name) => rule(sel).match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  assert.ok(rules.filter(([sel]) => /ctx-guide/.test(sel)).every(([sel]) => !/palette/.test(sel)), "one set of .ctx-guide rules");
  // The sidebar's values: the shared rules land on the palette's dots as on the sidebar's.
  for (const [name, value] of [["--tree-step", "18px"], ["--tree-branch-offset", "5px"]]) {
    assert.equal(prop(".ctx-tree-row", name), value, `the sidebar's ${name}`);
    assert.equal(prop(".palette-item.tree", name), value, name);
  }
  assert.equal(prop(".palette-item.tree", "padding-left"), "calc(10px + var(--depth, 0) * var(--tree-step))",
    "the sidebar's 10px inset (.ctx-inst) plus its indent, so the dot column is the sidebar's 13.25px rule");
  assert.match(rule(".ctx-inst"), /padding: 0 8px 0 10px/, "the sidebar's inset the palette matches");
  assert.equal(prop(".palette-item.tree", "--row-gap"), "0px", "rows touch: lines run on from row to row");
  assert.equal(prop(".palette-item.tree", "--row-solid"), "var(--surface)", "the dot's ring is the palette's surface");
  assert.equal(prop(".palette", "background"), "var(--surface)");
  assert.equal(prop(".palette-item.tree.active", "--row-solid"), "var(--sel)", "and the selection's tint on the active row");
  assert.equal(prop(".palette-item.active", "background"), "var(--sel)");
  assert.match(rule(".palette-item"), /position: relative/, "the guides' containing block");
  assert.doesNotMatch(rule(".palette-item.context"), /opacity/, "context rows dim by colour only; their lines are not dimmed");
});
