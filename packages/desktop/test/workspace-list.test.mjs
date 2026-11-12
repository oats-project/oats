// The workspace list (renderer/workspace-switcher.mjs): always shown at the sidebar's top, one row per workspace
// this window can show, whatever machine it is on. Its rows and their order (the matched views, then the unattached
// ones, in one flat list with no heading), a row as one line with the name alone, the current row (marked by style
// alone), the needs-input mark and its words, Show only the current workspace, picking a row another window shows, an unattached row's deployment
// tab, the leader's moves (`step`), the arrow keys and the roving tab stop, the empty message, the bounded height,
// a switch on its way and the pick tokens. Nothing is asked of main for the list itself.
// The Add dialog is workspace-switcher.test.mjs; Open in new window (⌘Enter / Ctrl+Enter, the row's context
// menu) is workspace-open-in-window.test.mjs; the pure move rule is workspace-step.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createWorkspaceSwitcher, moreBelowText, WAITING_NAME, WAITING_TITLE, CURRENT_ONLY_LABEL, CURRENT_ONLY_KEY } from "../renderer/workspace-switcher.mjs";
import { UNMATCHED_SECTION } from "../../client/workspace-choices.mjs";
import { onDeploymentTabRequest } from "../renderer/deployment-tabs.mjs";

const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Views as the server sends them, with everything a row no longer draws (machines, places, not live, labels).
const view = (name, fields = {}) => ({ id: `ws:${name.padEnd(20, "0")}`, name, team: null, deployments: [`/h/${name}`], machines: ["This Mac"],
  deploymentLabels: [`This Mac · ~/${name}`], notLive: 0, ...fields });
const A = view("alpha"), B = view("beta"), C = view("gamma");
// A stale `shown` (main no longer sends it) changes nothing.
const HELD = view("held", { shown: true });
const LOOSE = view("loose", { id: "remote:laptop:loose", deployments: ["remote:laptop:loose"], machines: ["laptop"], deploymentLabels: ["laptop · loose"],
  unattached: true, short: "Not reached" });

function setup(t, overrides = {}) {
  const dom = new JSDOM(html, { url: "file:///renderer/index.html" });
  const document = dom.window.document;
  const calls = { selected: [], asked: 0, tabs: [] };
  t.after(onDeploymentTabRequest((request) => calls.tabs.push(request)));
  const controller = createWorkspaceSwitcher({
    document,
    selectWorkspace: (id) => calls.selected.push(id),
    discoverSuggestions: async () => { calls.asked++; return { stale: false, suggestions: [] }; },
    addWorkspace: async (path) => ({ ok: true, workspace: { id: path, path, name: path.split("/").pop() } }),
    pickWorkspace: async () => ({ ok: false, code: "cancelled" }),
    openInNewWindow: () => {},
    ...overrides,
  });
  t.after(() => { controller.dispose(); dom.window.close(); });
  const rows = () => [...document.querySelectorAll("#ws-options .ws-option")];
  const keyOf = (button) => button.dataset.workspaceId;
  const row = (key) => rows().find((button) => keyOf(button) === key) ?? null;
  const current = () => document.querySelector('.ws-option[aria-current="true"]');
  const key = (k) => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  return { dom, document, controller, calls, rows, row, keyOf, current, key };
}

/* ── the rows ── */
test("rows: the matched views, then the unattached ones, in one flat list with no heading; buttons, not a listbox", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [LOOSE, A, HELD]); await tick();
  assert.deepEqual(s.rows().map(s.keyOf), [A.id, HELD.id, LOOSE.id], "matched first, in their order, then the unattached");
  const list = s.document.getElementById("ws-list");
  assert.equal(s.document.getElementById(list.getAttribute("aria-labelledby")).textContent, "Workspace", "the head's heading (the product owner, 2026-10-26)");
  const groups = [...s.document.querySelectorAll("#ws-options > *")];
  assert.equal(groups.length, 1, "one list");
  assert.equal(groups[0].tagName, "UL"); assert.ok(groups[0].classList.contains("ws-group"));
  assert.equal(groups[0].getAttribute("aria-label"), "Workspaces");
  assert.equal(groups[0].getAttribute("aria-labelledby"), null);
  assert.ok(!list.textContent.includes(UNMATCHED_SECTION), "no section heading for the unattached");
  assert.ok(!list.textContent.includes("On this computer"), "no rows of this computer's deployments not opened");
  for (const button of s.rows()) {
    assert.equal(button.tagName, "BUTTON"); assert.equal(button.type, "button");
    assert.equal(button.parentElement.tagName, "LI"); assert.ok(button.parentElement.classList.contains("ws-option-row"));
    assert.equal(button.parentElement.parentElement, groups[0]);
    assert.equal(button.getAttribute("role"), null);
    assert.equal(button.getAttribute("aria-disabled"), null, "every row can be opened");
  }
  assert.equal(list.querySelector('[role="listbox"], [role="option"]'), null, "the sidebar's plain keys stay live on it");
});

test("one workspace only: the list still shows it, one current row", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A]); await tick();
  assert.equal(s.document.getElementById("ws-list").hidden, false);
  assert.deepEqual(s.rows().map(s.keyOf), [A.id]);
  assert.equal(s.current(), s.rows()[0]);
  assert.equal(s.document.querySelector(".ws-menu-empty").hidden, true, "a row, not the empty note");
  assert.equal(s.controller.step(1), false); assert.equal(s.controller.step(-1), false);
  assert.deepEqual(s.calls.selected, []);
});

test("a row is one line, the roster's circle and the name: no other mark, icon, machine, state or button; the tooltip is the name, never a path or machine", async (t) => {
  const s = setup(t);
  const busy = view("busy", { notLive: 2 });
  s.controller.begin()(A, [A, HELD, busy, LOOSE]); await tick();
  for (const button of s.rows()) {
    const item = button.closest(".ws-option-row");
    const name = button.querySelector(".ws-option-name"), mark = button.querySelector(".ctx-dot");
    assert.deepEqual([...button.children], [mark, name], `${button.dataset.workspaceId}: the circle, the name and nothing else`);
    // The instance roster's own circle (shell.css .ctx-dot), filled on the current row, a ring on the others; decorative.
    assert.equal(mark.className, button.getAttribute("aria-current") === "true" ? "ctx-dot on" : "ctx-dot off");
    assert.equal(mark.getAttribute("aria-hidden"), "true"); assert.equal(mark.textContent, "");
    assert.deepEqual([...item.children], [button], "no button beside the row");
    for (const selector of [".workspace-avatar", ".ws-option-meta", ".ws-check", "svg", ".ws-open-window", ".deployment-mark"]) {
      assert.equal(item.querySelector(selector), null, `${button.dataset.workspaceId}: no ${selector}`);
    }
    assert.equal(button.textContent, name.textContent);
    assert.equal(button.title, name.textContent, "the tooltip is the name");
    assert.ok(!/This Mac|laptop|\/h\/|~\//.test(button.title), "no machine, no path");
  }
  assert.deepEqual(s.rows().map((b) => b.textContent), ["alpha", "held", "busy", "loose"]);
  assert.equal(s.row(HELD.id).dataset.otherWindow, undefined, "not marked as another window's");
  assert.ok(!s.document.getElementById("ws-options").textContent.includes("In another window"));
  assert.ok(!s.document.getElementById("ws-options").textContent.includes("not live"));
  assert.ok(!s.document.getElementById("ws-options").textContent.includes("Not reached"), "an unattached row's state is its tab's to say");
});

test("two of one name are told apart by their workspace keys, still on one line", async (t) => {
  const s = setup(t);
  const one = view("oats", { id: "ws:oats1".padEnd(23, "0"), key: "github.com/a/oats" });
  const two = view("oats", { id: "ws:oats2".padEnd(23, "0"), key: "github.com/b/oats" });
  s.controller.begin()(one, [one, two]); await tick();
  assert.deepEqual(s.rows().map((b) => b.textContent), ["oats — github.com/a/oats", "oats — github.com/b/oats"]);
  assert.deepEqual(s.rows().map((b) => b.title), ["oats — github.com/a/oats", "oats — github.com/b/oats"]);
});

test("two of one name without keys are never told apart by where they are: no folder, no machine, in the row or its tooltip", async (t) => {
  const s = setup(t);
  // Local folders (an older server, an unmatched deployment) and remote ones, named alike, with no workspace key.
  const a = { id: "/org-a/oats", name: "oats" }, b = { id: "/org-b/oats", name: "oats" };
  const c = { id: "remote:laptop:t1", name: "web", machines: ["laptop"] }, d = { id: "remote:build:t2", name: "web", machines: ["build"], team: { name: "Acme" } };
  s.controller.begin()(a, [a, b, c, d]); await tick();
  assert.deepEqual(s.rows().map((r) => r.textContent), ["oats", "oats", "web", "web — Acme"], "a team names a workspace; a folder or a machine does not");
  assert.deepEqual(s.rows().map((r) => r.title), ["oats", "oats", "web", "web — Acme"]);
  for (const r of s.rows()) assert.doesNotMatch(`${r.textContent} ${r.title}`, /org-a|org-b|\/|laptop|build/);
  // The list's description names the current workspace the same way: a screen reader hears no folder either.
  assert.equal(s.document.getElementById("ws-list").getAttribute("aria-description"), "Current workspace: oats");
});

test("a long name: the line cuts it with an ellipsis (CSS) and the tooltip gives the whole name", async (t) => {
  const s = setup(t);
  const long = view("a-very-long-workspace-name-that-will-never-fit-in-the-sidebar-at-any-width-anyone-uses");
  s.controller.begin()(long, [long]); await tick();
  assert.equal(s.rows()[0].title, long.name);
  assert.equal(s.rows()[0].querySelector(".ws-option-name").textContent, long.name, "the whole name is drawn: CSS cuts it");
  const rule = css.match(/^\.ws-option-name\s*\{([^}]*)\}/m)[1];
  assert.match(rule, /text-overflow:\s*ellipsis/); assert.match(rule, /white-space:\s*nowrap/); assert.match(rule, /overflow:\s*hidden/);
  // The name inherits the row's 13px and weight (the product owner, 2026-10-26: no larger, bolder name of its own).
  assert.doesNotMatch(rule, /font-size|font-weight/, "the name keeps the row's type");
  // One compact row (the product owner, 2026-10-26): 4px above and below, at least 24px tall.
  const row = css.match(/^\.ws-option\s*\{([^}]*)\}/m)[1];
  assert.match(row, /padding:\s*4px 8px 4px 10px;/); assert.match(row, /min-height:\s*24px;/);
});

test("the current row: aria-current on that row only, marked by style alone (no check icon); the list's description names it", async (t) => {
  const s = setup(t);
  const list = s.document.getElementById("ws-list");
  assert.equal(list.getAttribute("aria-description"), "Current workspace: resolving", "before the first answer");
  s.controller.begin()(B, [A, B, HELD]); await tick();
  assert.deepEqual(s.rows().map((b) => b.getAttribute("aria-current")), [null, "true", null]);
  assert.equal(s.current().querySelector(".ws-check, svg"), null, "no icon");
  assert.equal(list.getAttribute("aria-description"), "Current workspace: beta");
  // Its circle filled like a running instance's, the others a ring (2026-10-23: no accent edge); its name bold.
  const marks = () => s.rows().map((b) => b.querySelector(".ctx-dot").className);
  assert.deepEqual(marks(), ["ctx-dot off", "ctx-dot on", "ctx-dot off"]);
  assert.doesNotMatch(css, /\.ws-option\[aria-current="true"\]\s*\{/, "no rule of its own on the row: no edge, no fill");
  assert.match(css, /\.ws-option\[aria-current="true"\] \.ws-option-name\s*\{[^}]*font-weight:\s*650/, "and bold");
  s.controller.begin()(A, [A, B, HELD]);
  assert.equal(s.current(), s.row(A.id), "it follows what this window shows");
  assert.deepEqual(marks(), ["ctx-dot on", "ctx-dot off", "ctx-dot off"], "and so does the filled circle");
  assert.equal(list.getAttribute("aria-description"), "Current workspace: alpha");
  const local = { id: "/h/Agents/here", path: "/h/Agents/here", name: "here" };
  s.controller.begin()(local, [A, local]);
  assert.equal(list.getAttribute("aria-description"), "Current workspace: here", "a local folder by its row's name, never its path");
  s.controller.choose([A, B]);
  assert.equal(s.current(), null);
  assert.equal(list.getAttribute("aria-description"), "Current workspace: none chosen yet");
});

/* ── the dot ── */
const dotOf = (button) => button.querySelector(".ws-waiting");

test("the needs-input mark: an instance needs input (waiting true) draws it at the row's far right, says it in the row's name and its tooltip", async (t) => {
  const tipped = view("tipped", { waiting: true });
  const loose = { ...LOOSE, waiting: true };
  const s = setup(t);
  s.controller.begin()(tipped, [tipped, loose]); await tick();
  for (const button of [s.row(tipped.id), s.row(loose.id)]) {
    const name = button.querySelector(".ws-option-name"), words = name.nextElementSibling, dot = dotOf(button);
    assert.ok(dot, "the dot, the current row and an unattached one included");
    assert.equal(dot.getAttribute("aria-hidden"), "true", "a graphic: its words are the name's");
    assert.deepEqual([...button.children], [button.querySelector(".ctx-dot"), name, words, dot], "on the same line, after the name");
    // Pushed to the row's far right; the name, which may shrink, is cut off before it.
    assert.match(css, /^\.ws-waiting \{[^}]*\bflex: none; margin-left: auto;/m);
    assert.match(css, /^\.ws-option-name \{[^}]*\bflex: 0 1 auto; min-width: 0;/m);
    assert.ok(words.classList.contains("sr-only"));
    assert.equal(words.textContent, WAITING_NAME);
    assert.equal(button.textContent, `${name.textContent}${WAITING_NAME}`, "the accessible name reads it after the name");
    assert.equal(button.title, `${name.textContent}\n${WAITING_TITLE}`, "after the name in the tooltip");
  }
  assert.equal(WAITING_NAME, ", needs input"); assert.equal(WAITING_TITLE, "An instance here needs input");
});

test("the needs-input mark: false, unknown (null, absent) or anything but true draws none and says nothing", async (t) => {
  const s = setup(t);
  const choices = [false, null, undefined, "true", 1, {}].map((waiting, i) => view(`w${i}`, { waiting }));
  s.controller.begin()(choices[0], choices); await tick();
  for (const [i, button] of s.rows().entries()) {
    assert.equal(dotOf(button), null, String(choices[i].waiting));
    assert.equal(button.querySelector(".sr-only"), null);
    assert.equal(button.title, `w${i}`);
  }
});

test("the needs-input mark never reorders the list", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A, B, C]);
  const before = s.rows().map(s.keyOf);
  s.controller.begin()(A, [A, B, { ...C, waiting: true }]);
  assert.deepEqual(s.rows().map(s.keyOf), before);
  assert.ok(dotOf(s.row(C.id)));
});

/* ── picking a row ── */
test("picking a row another window shows takes it over into this window; no words say where it is", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A, HELD]); await tick();
  assert.ok(!s.document.getElementById("ws-list").textContent.includes("In another window"));
  s.row(HELD.id).click();
  assert.deepEqual(s.calls.selected, [HELD.id], "selected here: the shell asks main to take it over");
  assert.deepEqual(s.calls.tabs, [], "a matched view opens no deployment tab");
  s.row(A.id).click();
  assert.deepEqual(s.calls.selected, [HELD.id, A.id], "the current row picked after the pick on its way is what this window ends on");
});

test("an unattached row's pick also opens its deployment's tab on the Deployments page", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A, LOOSE]); await tick();
  s.row(LOOSE.id).click();
  assert.deepEqual(s.calls.selected, [LOOSE.id]);
  assert.deepEqual(s.calls.tabs, [{ view: LOOSE.id, tab: LOOSE.deployments[0] }]);
  s.controller.begin()(LOOSE, [A, LOOSE]);
  s.row(LOOSE.id).click();
  assert.deepEqual(s.calls.selected, [LOOSE.id], "already shown: not picked again");
  assert.equal(s.calls.tabs.length, 2, "but its tab is asked for again: where its reason and fix are");
});

/* ── the leader's moves ── */
test("step: the next row as drawn, onto a row another window shows, then into the unattached ones", async (t) => {
  const s = setup(t);
  const list = [A, LOOSE, HELD];
  // Each switch lands as the shell lands it: reset(the workspace now selected), then its roster's answer.
  const land = (workspace) => { s.controller.reset(workspace.id); s.controller.begin()(workspace, list); };
  s.controller.begin()(A, list); await tick();
  assert.equal(s.controller.step(1), true);
  assert.deepEqual(s.calls.selected, [HELD.id], "as drawn (matched first), and a held row is not passed over");
  land(HELD);
  assert.equal(s.controller.step(1), true);
  assert.deepEqual(s.calls.selected, [HELD.id, LOOSE.id], "down into the unattached rows");
  assert.deepEqual(s.calls.tabs, [{ view: LOOSE.id, tab: LOOSE.deployments[0] }], "as a click does: its deployment's tab");
  land(LOOSE);
  assert.equal(s.controller.step(-1), true);
  assert.equal(s.calls.selected.at(-1), HELD.id, "up");
});

test("step wraps: up from the first row the last, down from the last the first; with no other row, false and nothing selected", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A, LOOSE]); await tick();
  assert.equal(s.controller.step(-1), true, "the first row: up to the last");
  assert.deepEqual(s.calls.selected, [LOOSE.id]);
  s.controller.reset(LOOSE.id); s.controller.begin()(LOOSE, [A, LOOSE]);
  assert.equal(s.controller.step(1), true, "the last row: down to the first");
  assert.deepEqual(s.calls.selected, [LOOSE.id, A.id]);
  const alone = setup(t);
  alone.controller.begin()(A, [A]); await tick();
  assert.equal(alone.controller.step(1), false, "one row, the current one: no other to show");
  assert.equal(alone.controller.step(-1), false);
  assert.deepEqual(alone.calls.selected, []); assert.deepEqual(alone.calls.tabs, []);
});

test("step hands the shell's options to its switch (a step from the list places no focus); a click hands none", async (t) => {
  const asked = [];
  // Each switch is refused, so A stays current and the next one starts from it again.
  const s = setup(t, { selectWorkspace: (...args) => { asked.push(args); return { ok: false }; } });
  s.controller.begin()(A, [A, B]); await tick();
  const how = { focusPlace: false };
  assert.equal(s.controller.step(1), true); await tick();
  assert.equal(s.controller.step(1, how), true); await tick();
  s.rows().find((row) => row.dataset.workspaceId === B.id).click();
  assert.deepEqual(asked, [[B.id, undefined], [B.id, how], [B.id, undefined]]);
  assert.equal(asked[1][1], how, "as it is");
});

test("step with nothing current: the first row going down, the last going up (an unattached one included)", async (t) => {
  const down = setup(t);
  down.controller.choose([A, LOOSE, B]); await tick();
  assert.equal(down.controller.step(1), true); assert.deepEqual(down.calls.selected, [A.id]);
  const up = setup(t);
  up.controller.choose([A, LOOSE, B]); await tick();
  assert.equal(up.controller.step(-1), true); assert.deepEqual(up.calls.selected, [LOOSE.id], "the last row as drawn");
  const none = setup(t);
  none.controller.choose([]); await tick();
  assert.equal(none.controller.step(1), false); assert.equal(none.controller.step(-1), false);
});

/* ── the keys and the roving tab stop ── */
test("Arrow keys, Home and End move focus through the rows as one list, matched and unattached, without wrapping or picking", async (t) => {
  const s = setup(t);
  s.controller.choose([A, LOOSE, B]); await tick();
  s.controller.focusList(); assert.equal(s.document.activeElement, s.row(A.id), "nothing current: the first row");
  s.key("ArrowUp"); assert.equal(s.document.activeElement, s.row(A.id), "no wrap at the top");
  s.key("ArrowDown"); assert.equal(s.document.activeElement, s.row(B.id));
  s.key("ArrowDown"); assert.equal(s.document.activeElement, s.row(LOOSE.id), "into the unattached row");
  s.key("ArrowDown"); assert.equal(s.document.activeElement, s.row(LOOSE.id), "no wrap at the bottom");
  s.key("Home"); assert.equal(s.document.activeElement, s.row(A.id));
  s.key("End"); assert.equal(s.document.activeElement, s.row(LOOSE.id));
  assert.deepEqual(s.calls.selected, [], "moving focus picks nothing");
});

test("roving stop: one row in the Tab order, the current one, then the last focused; focusList goes to the current row", async (t) => {
  const s = setup(t);
  const stops = () => s.rows().filter((b) => b.tabIndex === 0).map(s.keyOf);
  s.controller.begin()(B, [A, B, C]); await tick();
  assert.deepEqual(stops(), [B.id], "the current row");
  s.row(C.id).focus();
  assert.deepEqual(stops(), [C.id], "the row last focused");
  s.controller.begin()(B, [A, B, C]);
  assert.deepEqual(stops(), [C.id], "kept across a repaint");
  assert.equal(s.document.activeElement, s.row(C.id));
  s.document.getElementById("ws-add-open").focus();
  assert.equal(s.controller.focusList(), true);
  assert.equal(s.document.activeElement, s.row(B.id), "w, o and Ctrl+Alt+O land on the current row");
  assert.deepEqual(stops(), [B.id]);
  s.row(C.id).focus();
  s.controller.begin()(B, [A, B]);
  assert.equal(s.document.activeElement, s.row(B.id), "the focused row is gone: focus goes to the current row");
  assert.deepEqual(stops(), [B.id]);
});

test("roving stop with nothing current is the first row; an empty list's focus is Add local workspace…", async (t) => {
  const s = setup(t);
  s.controller.choose([A, B]); await tick();
  assert.deepEqual(s.rows().filter((b) => b.tabIndex === 0).map(s.keyOf), [A.id]);
  assert.equal(s.controller.focusList(), true); assert.equal(s.document.activeElement, s.row(A.id));
  const empty = setup(t);
  empty.controller.choose([]); await tick();
  assert.equal(empty.controller.focusList(), true);
  assert.equal(empty.document.activeElement, empty.document.getElementById("ws-add-open"));
});

test("new served choices repaint the list in place without moving focus or asking main again (#521); a focused row gone falls back to the tab stop", async (t) => {
  const s = setup(t);
  s.controller.choose([A, B]); await tick();
  s.row(B.id).focus();
  s.controller.choose([C, A, B]);
  assert.deepEqual(s.rows().map(s.keyOf), [C.id, A.id, B.id]);
  assert.equal(s.document.activeElement, s.row(B.id), "focus kept by identity");
  assert.equal(s.calls.asked, 0, "choices arriving ask nothing");
  s.controller.choose([C, A]);
  assert.equal(s.document.activeElement, s.row(C.id), "its row is gone: the list's tab stop (the first row, nothing being current)");
  assert.equal(s.document.activeElement.tabIndex, 0);
});

/* ── the empty message ── */
test("the empty message says nothing is reported only once an answer came; a superseded answer is none", async (t) => {
  const s = setup(t);
  const empty = s.document.querySelector(".ws-menu-empty");
  assert.equal(empty.hidden, true, "before any answer: nothing said");
  assert.equal(empty.textContent, "");
  const older = s.controller.begin(), newer = s.controller.begin();
  assert.equal(older(null, []), false, "an older answer does not paint");
  assert.equal(empty.hidden, true, "and is no answer");
  assert.equal(newer(null, []), true);
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "No workspace choices reported.");
  s.controller.begin()(A, [A]);
  assert.equal(empty.hidden, true, "a row: no message");
  const chosen = setup(t);
  chosen.controller.choose([]);
  const chosenEmpty = chosen.document.querySelector(".ws-menu-empty");
  assert.equal(chosenEmpty.hidden, false, "choose() is an answer too");
  assert.equal(chosenEmpty.textContent, "No workspace choices reported.");
});

/* ── nothing asked of main ── */
test("nothing is asked of discoverSuggestions at start or on window focus, only as the Add dialog opens; dispose is safe", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A]); await tick();
  assert.equal(s.calls.asked, 0, "not at start");
  s.dom.window.dispatchEvent(new s.dom.window.Event("blur"));
  s.dom.window.dispatchEvent(new s.dom.window.Event("focus")); await tick();
  assert.equal(s.calls.asked, 0, "not on window focus");
  await s.controller.openModal();
  assert.equal(s.calls.asked, 1, "the Add dialog's own ask");
  s.document.getElementById("ws-cancel").click(); await tick();
  assert.equal(s.calls.asked, 1, "closing it asks nothing");
  s.controller.dispose();
  s.controller.dispose();
  s.dom.window.dispatchEvent(new s.dom.window.Event("focus")); await tick();
  assert.equal(s.calls.asked, 1);
  assert.deepEqual(s.rows().map(s.keyOf), [A.id], "the rows stay drawn");
});

/* ── the bounded height ── */
test("rows cut off below the list's bounded height are said under it, at any scroll; none when all fit", async (t) => {
  const s = setup(t);
  const options = s.document.getElementById("ws-options"), more = s.document.querySelector(".ws-more");
  assert.equal(more.getAttribute("aria-hidden"), "true", "a cue for the eye: every row is in the list");
  // Layout, as a browser gives it: 40px rows in a 100px list, scrolled by scrollTop.
  let scrollTop = 0;
  options.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  const rowRect = (button) => { const i = s.rows().indexOf(button); return { top: i * 40 - scrollTop, bottom: (i + 1) * 40 - scrollTop }; };
  t.after(() => { delete s.dom.window.HTMLButtonElement.prototype.getBoundingClientRect; });
  s.dom.window.HTMLButtonElement.prototype.getBoundingClientRect = function () { return rowRect(this); };
  s.controller.begin()(A, [A, B, C, HELD]); await tick();
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, moreBelowText(2), "the third row is cut: it and the fourth are below");
  assert.equal(moreBelowText(2), "2 more below");
  scrollTop = 60; options.dispatchEvent(new s.dom.window.Event("scroll"));
  assert.equal(more.hidden, true, "scrolled to the end: nothing below");
  scrollTop = 0; s.controller.begin()(A, [A, B]); await tick();
  assert.equal(more.hidden, true, "all fit"); assert.equal(more.textContent, "");
});

test("the line under the list carries the rows' mark when a row cut off below waits on you, as the TUI's +N ●", async (t) => {
  const s = setup(t);
  const options = s.document.getElementById("ws-options"), more = s.document.querySelector(".ws-more");
  let scrollTop = 0;
  options.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  t.after(() => { delete s.dom.window.HTMLButtonElement.prototype.getBoundingClientRect; });
  s.dom.window.HTMLButtonElement.prototype.getBoundingClientRect = function () { const i = s.rows().indexOf(this); return { top: i * 40 - scrollTop, bottom: (i + 1) * 40 - scrollTop }; };
  const dots = () => [...more.querySelectorAll(".ws-waiting")];
  // A waiting row in view: its own dot says it, the line has none.
  s.controller.begin()(A, [{ ...A, waiting: true }, B, C, HELD]); await tick();
  assert.equal(more.textContent, moreBelowText(2)); assert.deepEqual(dots(), []);
  // The fourth row, cut off below, waits: the line says the count and carries the dot, a graphic after the words.
  s.controller.begin()(A, [A, B, C, { ...HELD, waiting: true }]); await tick();
  assert.equal(more.textContent, moreBelowText(2), "the words stay the count: every row keeps its own words");
  assert.equal(dots().length, 1); assert.equal(dots()[0].getAttribute("aria-hidden"), "true");
  assert.equal(more.lastElementChild, dots()[0], "after the count");
  assert.match(css, /^\.ws-more \{ display: flex; align-items: center;/m, "a row, so the dot keeps its size, at the far right");
  // Scrolled so the waiting row shows: the line goes, its dot with it.
  scrollTop = 60; options.dispatchEvent(new s.dom.window.Event("scroll"));
  assert.equal(more.hidden, true); assert.deepEqual(dots(), []);
});

/* ── a switch on its way ── */
test("a switch landing here keeps every row (the list never empties while the new roster is read, or when it fails); the next move goes on", async (t) => {
  const s = setup(t);
  s.controller.begin()(A, [A, B, C]); await tick();
  assert.equal(s.controller.step(1), true);
  assert.deepEqual(s.calls.selected, [B.id]);
  s.controller.reset(B.id); // the shell's restoreWorkspaceTabs, as the switch lands: B's roster not read yet
  assert.deepEqual(s.rows().map(s.keyOf), [A.id, B.id, C.id], "the rows stay");
  assert.equal(s.current().dataset.workspaceId, B.id, "B is current at once");
  assert.equal(s.controller.step(1), true, "B's read has not answered (or failed): the next move still reaches C");
  assert.deepEqual(s.calls.selected, [B.id, C.id]);
  s.controller.reset("ws:unknown00000000000000");
  assert.equal(s.rows().length, 3, "a workspace not among the rows yet: the rows stay too");
  assert.equal(s.current(), null);
});

test("moves faster than a switch go on from the pick on its way, not from what is shown", async (t) => {
  const s = setup(t, { selectWorkspace: (id) => { s.calls.selected.push(id); return new Promise(() => {}); } });
  s.controller.begin()(A, [A, B, C]); await tick();
  assert.equal(s.controller.step(1), true); assert.equal(s.controller.step(1), true);
  assert.deepEqual(s.calls.selected, [B.id, C.id], "two presses, two moves");
  assert.equal(s.controller.step(1), true, "from C, the pick on its way, past the last row: the first (from A, what is shown, it would be B)");
  assert.deepEqual(s.calls.selected, [B.id, C.id, A.id]);
  assert.equal(s.controller.step(-1), true, "from A, the pick on its way, before the first row: the last");
  assert.deepEqual(s.calls.selected, [B.id, C.id, A.id, C.id]);
});

test("the latest pick wins: the current row picked while another pick is on its way supersedes it; a refused pick leaves none", async (t) => {
  let answer = () => new Promise(() => {});
  const s = setup(t, { selectWorkspace: (id) => { s.calls.selected.push(id); return answer(id); } });
  s.controller.begin()(A, [A, HELD]); await tick();
  s.row(HELD.id).click();
  s.row(HELD.id).click();
  assert.deepEqual(s.calls.selected, [HELD.id], "a second click on the pick on its way picks nothing again");
  s.row(A.id).click();
  assert.deepEqual(s.calls.selected, [HELD.id, A.id], "the current row, picked after: it is what this window ends on");
  s.row(A.id).click();
  assert.deepEqual(s.calls.selected, [HELD.id, A.id], "and once is enough");
  answer = async () => ({ ok: false, code: "failed" });
  s.row(HELD.id).click(); await tick(); await tick();
  s.row(A.id).click();
  assert.deepEqual(s.calls.selected, [HELD.id, A.id, HELD.id], "the refused pick is no pick: the current row is just current");
});

test("an older pick's answer never clears a newer pick of the same workspace: D on its way, then B, C, B; the first B superseded", async (t) => {
  const D = view("delta"), answers = [];
  const s = setup(t, { selectWorkspace: (id) => { s.calls.selected.push(id); const gate = {}; gate.promise = new Promise((r) => { gate.resolve = r; }); answers.push(gate); return gate.promise; } });
  s.controller.begin()(A, [A, B, C, D]); await tick();
  s.row(D.id).click();
  for (const row of [B, C, B]) s.row(row.id).click();
  assert.deepEqual(s.calls.selected, [D.id, B.id, C.id, B.id]);
  answers[0].resolve({ ok: true }); s.controller.reset(D.id); // D lands
  answers[1].resolve({ ok: false, code: "superseded" }); answers[2].resolve({ ok: false, code: "superseded" });
  await tick(); await tick();
  assert.equal(s.current().dataset.workspaceId, D.id, "D is shown");
  assert.equal(s.controller.step(1), true, "the newest pick, B, is still on its way: the move goes on from it");
  assert.equal(s.calls.selected.at(-1), C.id);
});

/* ── Show only the current workspace (2026-10-23) ── */
const memory = (initial = {}) => { const m = new Map(Object.entries(initial)); return {
  getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, map: m }; };

test("Show only the current workspace: a toggle before Add at the heading, named, off by default", async (t) => {
  const s = setup(t, { storage: memory() });
  s.controller.begin()(A, [A, B, C]); await tick();
  const toggle = s.document.getElementById("ws-current-only");
  assert.equal(toggle.nextElementSibling, s.document.getElementById("ws-add-open"), "before Add, at the heading's end");
  const head = s.document.querySelector(".side-head");
  assert.ok(head, "the sidebar's head");
  assert.equal(toggle.closest(".side-head"), head, "in the head, after the Workspace heading");
  assert.equal(toggle.previousElementSibling, s.document.getElementById("ws-heading"));
  // The head holds only the heading and its two controls (the product owner, 2026-10-26: the OATS mark is the foot's),
  // with no line between it and the list; the list's own line closes it, before the main views.
  assert.deepEqual([...head.children].map((el) => el.id), ["ws-heading", "ws-current-only", "ws-add-open"]);
  assert.equal(head.nextElementSibling, s.document.getElementById("ws-list"));
  const headRule = css.match(/^\.side-head\s*\{([^}]*)\}/m)[1];
  assert.doesNotMatch(headRule, /border(?!-box)/, "no line under the head");
  // 40px tall, its 8px top padding keeping the heading's centre 24px down, the first row close under it.
  assert.match(headRule, /height:\s*40px;/); assert.match(headRule, /box-sizing:\s*border-box;/);
  assert.match(headRule, /padding:\s*8px 10px 0 13px;/);
  assert.match(css.match(/^\.ws-list\s*\{([^}]*)\}/m)[1], /border-bottom:\s*1\.5px solid var\(--border\)/, "the line before the nav, a little bolder than the roster\'s");
  assert.equal(toggle.getAttribute("aria-label"), CURRENT_ONLY_LABEL); assert.equal(toggle.title, CURRENT_ONLY_LABEL);
  assert.equal(toggle.getAttribute("aria-pressed"), "false"); assert.equal(toggle.dataset.action, "workspaces.currentOnly");
  assert.ok(toggle.querySelector("svg"), "its icon"); assert.equal(s.controller.currentOnly, false);
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [A.id, B.id, C.id]);
});

test("on, only the current row shows: the others leave the list and its keys, no line stands for them, and it is remembered", async (t) => {
  const storage = memory();
  const s = setup(t, { storage });
  s.controller.begin()(B, [A, B, C]); await tick();
  s.document.getElementById("ws-current-only").click();
  assert.equal(s.document.getElementById("ws-current-only").getAttribute("aria-pressed"), "true");
  assert.equal(storage.getItem(CURRENT_ONLY_KEY), "1");
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [B.id], "the current row alone");
  for (const b of s.rows().filter((b) => b.hidden)) assert.equal(b.closest("li").hidden, true);
  const more = s.document.querySelector(".ws-more");
  assert.equal(more.hidden, true, "the other workspaces are not shown at all"); assert.equal(more.textContent, "");
  // Its keys go over the shown row only: Arrow and End stay on it.
  s.controller.focusList(); assert.equal(s.document.activeElement, s.row(B.id));
  s.key("ArrowDown"); assert.equal(s.document.activeElement, s.row(B.id)); s.key("End"); assert.equal(s.document.activeElement, s.row(B.id));
  // Off again: every row, and forgotten.
  s.controller.toggleCurrentOnly();
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [A.id, B.id, C.id]);
  assert.equal(storage.getItem(CURRENT_ONLY_KEY), null); assert.equal(more.getAttribute("aria-hidden"), "true");
});

test("on, a hidden workspace that waits shows nothing either; a remembered choice applies at start", async (t) => {
  const s = setup(t, { storage: memory({ [CURRENT_ONLY_KEY]: "1" }) });
  s.controller.begin()(A, [A, { ...B, waiting: true }, C]); await tick();
  assert.equal(s.controller.currentOnly, true);
  assert.equal(s.document.getElementById("ws-current-only").getAttribute("aria-pressed"), "true");
  const more = s.document.querySelector(".ws-more");
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [A.id]);
  assert.equal(more.hidden, true); assert.equal(more.textContent, ""); assert.equal(more.querySelector(".ws-waiting"), null);
});

test("on, a focused row that goes hands focus to the current row; with no current row every row shows", async (t) => {
  const s = setup(t, { storage: memory() });
  s.controller.begin()(A, [A, B, C]); await tick();
  s.row(C.id).focus();
  s.controller.toggleCurrentOnly();
  assert.equal(s.document.activeElement, s.row(A.id), "never <body>");
  s.controller.choose([A, B, C]); await tick();
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [A.id, B.id, C.id], "nothing current (choosing): nothing hidden");
});

test("a storage that throws: the toggle still works, remembered nowhere", async (t) => {
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const s = setup(t, { storage: broken });
  s.controller.begin()(A, [A, B]); await tick();
  s.controller.toggleCurrentOnly();
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [A.id]);
});

// Remembered per computer: the shell hands the switcher the window's localStorage, and a new window (a reload) built
// over the same storage starts as the last one left it, pressed or not.
test("Show only the current workspace survives a reload: the same storage, a new list; the shell passes localStorage", async (t) => {
  const storage = memory();
  const first = setup(t, { storage });
  first.controller.begin()(A, [A, B, C]); await tick();
  first.controller.toggleCurrentOnly();
  assert.deepEqual([...storage.map], [[CURRENT_ONLY_KEY, "1"]], "only its own key, under its own name");
  assert.equal(CURRENT_ONLY_KEY, "oats-desktop-workspaces-current-only");
  const second = setup(t, { storage });
  second.controller.begin()(A, [A, B, C]); await tick();
  assert.equal(second.controller.currentOnly, true);
  assert.equal(second.document.getElementById("ws-current-only").getAttribute("aria-pressed"), "true");
  assert.deepEqual(second.rows().filter((b) => !b.hidden).map(second.keyOf), [A.id]);
  second.controller.toggleCurrentOnly();
  const third = setup(t, { storage });
  third.controller.begin()(A, [A, B, C]); await tick();
  assert.equal(third.controller.currentOnly, false, "turned off is remembered too");
  assert.deepEqual(third.rows().filter((b) => !b.hidden).map(third.keyOf), [A.id, B.id, C.id]);
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /const workspaceLabel = createWorkspaceSwitcher\(\{[^]*?\n  storage: \(\(\) => \{ try \{ return window\.localStorage; \} catch \{ return null; \} \}\)\(\),/, "the shell's storage is the window's localStorage");
});

// The rows it hides are still the workspaces of the list: the leader's ↑ / ↓ (step) move to the previous / next one,
// which then shows alone.
test("on, step still moves to the next or previous workspace, hidden as it was, which then shows alone", async (t) => {
  const s = setup(t, { storage: memory({ [CURRENT_ONLY_KEY]: "1" }) });
  const land = (workspace) => { s.controller.reset(workspace.id); s.controller.begin()(workspace, [A, B, C]); };
  s.controller.begin()(A, [A, B, C]); await tick();
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [A.id]);
  assert.equal(s.controller.step(1), true);
  assert.deepEqual(s.calls.selected, [B.id], "the next workspace of the list, though hidden");
  land(B); await tick();
  assert.deepEqual(s.rows().filter((b) => !b.hidden).map(s.keyOf), [B.id], "now it alone shows");
  assert.equal(s.controller.step(-1), true); assert.equal(s.calls.selected.at(-1), A.id);
  // The moves wrap over the full list as drawn, the hidden rows included.
  land(A); await tick();
  assert.equal(s.controller.step(-1), true); assert.equal(s.calls.selected.at(-1), C.id, "up from the first: the last, hidden");
});
