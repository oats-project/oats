// The Desktop UI rework, slice 4 (the palette, the status line, sheets, help, Appearance): its pinned acceptance
// tests, by their names in the spec. Inert jsdom; no Electron, network or workspace.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { paletteRows, PALETTE_ORDER } from "../renderer/palette.mjs";
import { createStatusLine } from "../renderer/status-line.mjs";
import { createPalette } from "../renderer/palette.mjs";
import { needsYouRows } from "../../client/waiting-on-you.mjs";
import { createLifecycleDialog } from "../renderer/lifecycle-dialog.mjs";
import { createRetireGhosts, GHOST_MS } from "../renderer/retire-ghosts.mjs";
import { createLeaderHint, leaderHelpEnabled, setLeaderHelpEnabled } from "../renderer/leader-hint.mjs";
import { createAppearanceSheet } from "../renderer/theme-picker.mjs";
import { createKeybindingsEditor } from "../renderer/keybindings-editor.mjs";
import { THEMES, fontStacks, fontChoices } from "../renderer/theme.mjs";
import { SHEET, SHEET_BACKDROP } from "../renderer/sheet.mjs";
import { DEFAULT_KEYMAP, DEFAULT_KEYMAPS, TERMINAL_ALLOWLIST, DESKTOP_LEADER, LEADER_CHOICES, SIDEBAR_DELETE, getBinding, setBinding, resetAllBindings } from "../renderer/keybindings.mjs";
import { LEADER, leaderDoes, plainKeys, CHORDS } from "../../client/keymap.mjs";
import { instance, target, options, retirePlan, tick } from "./helpers/lifecycle-fixture.mjs";

const reference = "d".repeat(64);
const dom = (html = "") => new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true });
const key = (win, value, extra = {}) => {
  const event = new win.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra });
  (win.document.activeElement ?? win.document.body).dispatchEvent(event); return event;
};

test("slice4 palette group order", () => {
  const at = (name, extra = {}) => ({ instance: name, agent: "dev", home: `/w/${name}`, agentsRoot: "/w", running: true, ...extra });
  const claim = since => ({ waitingOnYou: { since, producer: "pi-claudio", reason: "question" }, runtimeState: "running" });
  const roster = { instances: [at("older", claim("2026-11-19T10:00:00.000Z")), at("quiet"), at("newer", claim("2026-11-19T11:00:00.000Z"))],
    deployments: [], souls: [{ name: "oats-desktop-developer", agentsRoot: "/w" }] };
  const run = () => {};
  const rows = paletteRows(roster, [{ label: "Keyboard shortcuts…", run }], "", { openTerminal: run,
    sections: [{ label: "Automations", run }], onSoul: run });
  // Each kind once, in the order: needs you, recent, sections, commands, souls.
  const kinds = rows.map(row => row.kind).filter((kind, i, all) => all[i - 1] !== kind);
  assert.deepEqual(kinds, PALETTE_ORDER);
  assert.deepEqual(PALETTE_ORDER, ["needs-you", "recent", "section", "command", "soul"]);
  // Needs you: the claimed rows, newest claim first; an agent row is its dot, its name and its soul.
  const needs = rows.filter(row => row.kind === "needs-you");
  assert.deepEqual(needs.map(row => row.label), ["newer", "older"]);
  assert.ok(needs.every(row => row.state === "running" && row.detail === "dev"));
  assert.equal(rows.find(row => row.kind === "soul").label, "New agent: oats-desktop-developer");
  // The prefixes: ">" the commands only, "+" the souls only.
  assert.deepEqual(paletteRows(roster, [{ label: "Keyboard shortcuts…", run }], ">", { openTerminal: run, sections: [{ label: "Automations", run }], onSoul: run })
    .map(row => row.kind), ["command"]);
  assert.deepEqual(paletteRows(roster, [{ label: "Keyboard shortcuts…", run }], "+", { openTerminal: run, sections: [{ label: "Automations", run }], onSoul: run })
    .map(row => row.kind), ["soul"]);
});

/** A stop plan for dev-1 with three children. */
// The y/n line for Stop, Start and Restart was taken out of this slice (the lead, after five review rounds,
// 2026-11-19): the pinned "slice4 status line confirm stop carries the plan" went with it. Stop keeps its dialog.
test("slice4 Stop keeps its dialog: the status line asks nothing", () => {
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /function openLifecycleDialog\(operation, instance, workspace\) \{[^]*?lifecycleDialog\.open\(\{ operation, instance, workspace: rowDeployment\(instance\) \}\);\n\}/);
  assert.match(shell, /const openInstanceStart = createInstanceStarter\(document, ctx\);/);
  const line = readFileSync(new URL("../renderer/status-line.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(line, /confirm\(|onYes|onNo/, "the status line has no questions");
});

test("slice4 the status line shows three keys for where the focus is, and a message until the next key", async t => {
  const d = dom('<button id="b">b</button>');
  const doc = d.window.document;
  let region = "roster";
  const line = createStatusLine({ doc, host: doc.body, win: d.window,
    keysFor: () => region === "roster" ? [{ keys: "Enter", label: "open" }, { keys: "Shift+X", label: "stop" }, { keys: "Alt+K", label: "palette" }, { keys: "x", label: "a fourth" }] : [{ keys: "Alt+K", label: "palette" }] });
  t.after(() => { line.dispose(); d.window.close(); });
  const shown = () => [...doc.querySelectorAll(".status-key")].map(k => k.textContent);
  assert.deepEqual(shown(), ["Enter open", "Shift+X stop", "Alt+K palette"], "three at most");
  region = "terminal"; doc.getElementById("b").focus();
  assert.deepEqual(shown(), ["Alt+K palette"], "they follow the focus");
  line.say("Workspace onboarded. The lock is written.");
  assert.equal(doc.querySelector('#status-line [role="status"]').textContent, "Workspace onboarded. The lock is written.", "announced");
  assert.equal(doc.querySelector(".status-keys").hidden, true, "in the keys' place");
  await new Promise(r => setTimeout(r, 0));
  const k = new d.window.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
  doc.body.dispatchEvent(k);
  assert.equal(k.defaultPrevented, false, "the key is not the line's");
  assert.equal(line.text(), null, "gone at the next key");
  for (const end of ["a click on the line", "a click elsewhere", "the window losing focus"]) {
    line.say("A message", { ms: 0 });
    await new Promise(r => setTimeout(r, 0));
    if (end === "a click on the line") line.element.dispatchEvent(new d.window.MouseEvent("pointerdown", { bubbles: true }));
    else if (end === "a click elsewhere") doc.body.dispatchEvent(new d.window.MouseEvent("pointerdown", { bubbles: true }));
    else d.window.dispatchEvent(new d.window.Event("blur"));
    assert.equal(line.text(), null, `gone at ${end}`);
  }
});

test("slice4 retire sheet shows plan facts and ghost row", async t => {
  const d = dom('<button id="opener">dev-1</button>');
  const doc = d.window.document;
  const dialog = createLifecycleDialog({ doc, request: async () => ({ lifecycleApi: 1, status: "plan", target, planRef: reference, plan: retirePlan(), options: options("retire"), receipt: null, reason: null }) });
  t.after(() => { dialog.dispose(); d.window.close(); });
  doc.getElementById("opener").focus();
  dialog.open({ operation: "retire", instance, workspace: "team" });
  await tick();
  const overlay = doc.querySelector(`.${SHEET_BACKDROP}`), sheet = overlay?.querySelector(`.${SHEET}[role="dialog"][aria-modal="true"]`);
  assert.ok(sheet, "Retire is a centred sheet over the scrim");
  const said = sheet.textContent;
  assert.match(said, /deletes its home folder/i, "what goes: the home");
  assert.match(said, /Keeps its worktree, moved aside, on branch feat\/work/, "the work tree");
  assert.match(said, /Uncommitted work.*2 changed, 1 untracked/s, "its state");
  assert.match(said, /Branches and pull requests are not changed/, "the PR");
  // The ghost: a retire that answered complete leaves a dim ✕ row in its place for 10 s once the roster no longer lists it.
  let now = 0, expired = 0;
  const ghosts = createRetireGhosts({ now: () => now, onExpire: () => expired++, schedule: () => null });
  const row = { instance: "dev-1", agent: "dev", agentsRoot: "/w", home: "/w/dev-1", parentInstance: "lead", running: true, waitingOnYou: { since: "x" } };
  ghosts.add(row, "team");
  assert.deepEqual(ghosts.rows([row], "team"), [], "while the roster lists it, the Retiring… row is the roster's");
  const [ghost] = ghosts.rows([], "team");
  assert.equal(ghost.retiredGhost, true); assert.equal(ghost.parentInstance, "lead", "in its place in the tree");
  assert.equal(ghost.waitingOnYou, undefined, "no claim, no state of its own"); assert.equal(ghost.running, false);
  assert.deepEqual(ghosts.rows([], "other"), [], "only in its workspace");
  now = GHOST_MS - 1; assert.equal(ghosts.rows([], "team").length, 1);
  now = GHOST_MS; assert.equal(ghosts.rows([], "team").length, 0, "gone after 10 s");
  assert.equal(GHOST_MS, 10_000);
  // The roster draws it as a ghost: "✕ name · retired", not a control.
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /if \(i\.retiredGhost\) \{ listEl\.append\(retiredGhostRow\(i\)\); continue; \}/);
  assert.match(shell, /line\.append\(mark, name, " · retired"\)/);
  void expired;
});

function leaderHintFixture(t, storage = new Map()) {
  const d = dom('<main id="main"></main>');
  const doc = d.window.document;
  const hint = createLeaderHint({ doc, host: doc.getElementById("main") });
  t.after(() => d.window.close());
  const store = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  return { doc, hint, store };
}
const ROWS = [{ keys: "K or Space", label: "Open the command palette" }, { keys: "Z", label: "Focus mode" }];

test("slice4 help sheet on leader", t => {
  const f = leaderHintFixture(t);
  // The shell shows it on the leader's wait, when the setting is on (it is, unless turned off).
  assert.equal(leaderHelpEnabled(f.store), true, "on by default");
  f.hint.announce();
  f.hint.showHelp({ title: "After Ctrl+X", rows: ROWS });
  const help = f.doc.getElementById("leader-help");
  assert.equal(help.hidden, false);
  assert.equal(help.dataset.mode, "wait");
  assert.deepEqual([...help.querySelectorAll("dt")].map(dt => dt.textContent), ["K or Space", "Z"]);
  assert.equal(help.getAttribute("aria-hidden"), "true", "drawn for sight; the wait is announced");
  assert.equal(f.doc.activeElement, f.doc.body, "it never takes focus");
  f.hint.hideHelp();
  assert.equal(help.hidden, true, "the next key does its job and the sheet goes");
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /onOpen: \(\) => \{ leaderHint\.announce\(\); if \(leaderHelpEnabled\(\) && leaderHint\.helpMode\(\) !== "pinned"\) leaderHint\.showHelp\(leaderHelp\(\)\); \}/);
  assert.match(shell, /if \(leaderHint\.helpMode\(\) === "wait"\) leaderHint\.hideHelp\(\);/);
});

test("slice4 help pinned with leader ?", t => {
  const f = leaderHintFixture(t);
  f.hint.showHelp({ title: "After Ctrl+X", rows: ROWS, pinned: true });
  const help = f.doc.getElementById("leader-help");
  assert.equal(f.hint.helpMode(), "pinned");
  assert.equal(help.getAttribute("aria-hidden"), null, "pinned, a screen reader can read it");
  assert.equal(help.getAttribute("aria-label"), "After Ctrl+X");
  assert.match(help.textContent, /Esc closes this/);
  // The leader's ? pins it; Esc, anywhere, closes it.
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /help: \(\) => leaderHint\.showHelp\(\{ \.\.\.leaderHelp\(\), pinned: true \}\),/);
  assert.match(shell, /leaderHint\.closeOnEscape\(window, \(\) => modalOpen\(\) \|\| leader\.isWaiting\(\)\)/);
  // Esc, pressed anywhere, closes it, and goes nowhere else; not while blocked (a modal, the leader waiting).
  const win = f.doc.defaultView;
  let blocked = true;
  const off = f.hint.closeOnEscape(win, () => blocked);
  const esc = () => { const e = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); f.doc.body.dispatchEvent(e); return e; };
  assert.equal(esc().defaultPrevented, false); assert.equal(f.hint.helpMode(), "pinned", "blocked: the Esc is someone else's");
  blocked = false;
  assert.equal(esc().defaultPrevented, true);
  assert.equal(f.hint.helpMode(), null, "Esc closes it");
  assert.equal(esc().defaultPrevented, false, "closed, Esc is no longer taken");
  off();
});

test("slice4 help off setting", t => {
  const storage = new Map(), f = leaderHintFixture(t, storage);
  let told = null;
  setLeaderHelpEnabled(false, f.store);
  assert.equal(leaderHelpEnabled(f.store), false);
  assert.equal(storage.get("oats.desktop.leaderHelp"), "off", "stored per computer");
  setLeaderHelpEnabled(true, f.store);
  assert.equal(leaderHelpEnabled(f.store), true);
  void told;
  // The Keyboard shortcuts sheet holds the setting.
  const d = dom('<button id="opener">open</button>');
  t.after(() => d.window.close());
  const previous = { document: globalThis.document, localStorage: globalThis.localStorage };
  const memory = new Map();
  globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  t.after(() => { globalThis.localStorage = previous.localStorage; });
  const editor = createKeybindingsEditor({ doc: d.window.document, isMac: false });
  d.window.document.getElementById("opener").focus();
  editor.open();
  const box = d.window.document.querySelector(".kb-help-toggle");
  assert.ok(box, "the Keyboard shortcuts sheet has the setting");
  assert.equal(box.checked, true);
  box.checked = false; box.dispatchEvent(new d.window.Event("change"));
  assert.equal(memory.get("oats.desktop.leaderHelp"), "off");
  editor.close();
});

function appearanceFixture(t) {
  const d = dom('<button id="opener">Appearance</button>');
  const doc = d.window.document;
  let theme = "dark", font = "system";
  const chosen = [];
  const sheet = createAppearanceSheet({ doc, themes: THEMES, fonts: () => fontChoices(false), currentTheme: () => theme, currentFont: () => font,
    chooseTheme: id => { chosen.push(["theme", id]); theme = id; }, chooseFont: id => { chosen.push(["font", id]); font = id; },
    terminalSize: () => { const el = doc.createElement("div"); el.innerHTML = '<input id="size" type="number" value="13">'; return { element: el, dispose() {} }; },
    chooseFamily: () => chosen.push(["family"]) });
  t.after(() => { sheet.dispose(); d.window.close(); });
  doc.getElementById("opener").focus();
  return { d, doc, sheet, chosen };
}

test("slice4 appearance sheet merges theme font size", t => {
  const f = appearanceFixture(t);
  f.sheet.open();
  const panel = f.doc.querySelector(`.${SHEET_BACKDROP} > .${SHEET}[role="dialog"][aria-modal="true"]`);
  assert.ok(panel, "one sheet");
  assert.equal(f.doc.getElementById(panel.getAttribute("aria-labelledby")).textContent, "Appearance");
  assert.deepEqual([...panel.querySelectorAll(".appearance-section h3")].map(h => h.textContent), ["Theme", "Font", "Terminal font size"]);
  const labels = section => [...panel.querySelectorAll(`[aria-labelledby="appearance-${section}"] li:not([hidden]) .theme-picker-label`)].map(el => el.textContent);
  assert.deepEqual(labels("theme"), ["System", "Dark", "Light", "More themes…"]);
  assert.deepEqual(labels("font"), ["System", "This computer's monospace", "Choose…"]);
  assert.ok(panel.querySelector("#size"), "the terminal size");
  assert.equal(f.doc.activeElement.dataset.choiceId, "dark", "focus on the current theme");
  // A choice applies at once and the sheet stays.
  panel.querySelector('[data-choice-id="light"]').click();
  assert.deepEqual(f.chosen, [["theme", "light"]]);
  assert.equal(panel.querySelector('[data-choice-id="light"]').getAttribute("aria-current"), "true");
  assert.ok(f.sheet.isOpen());
  // More themes… shows Solarized.
  [...panel.querySelectorAll(".appearance-more")][0].click();
  assert.ok(labels("theme").includes("Solarized"));
  panel.querySelector('[data-choice-id="omarchy"]').click();
  assert.deepEqual(f.chosen.at(-1), ["font", "omarchy"]);
  // System keeps today's behaviour under its new label: the host theme.
  assert.equal(THEMES.find(theme => theme.id === "host").label, "System");
});

test("slice4 chrome font is system sans", () => {
  // D2: no font choice sets the chrome's face or its code face; the monospace choice is the terminals' alone.
  for (const isMac of [false, true]) for (const font of ["omarchy", "system"]) {
    const stacks = fontStacks(font, isMac);
    assert.equal(stacks["--ui-font"], undefined, `${font} ${isMac}: no --ui-font`);
    assert.equal(stacks["--mono"], undefined, `${font} ${isMac}: no --mono`);
    assert.equal(stacks["--name-size"], undefined);
  }
  assert.deepEqual(fontStacks("omarchy", false), { "--term-font-family": "ui-monospace, monospace" }, "terminals as before: the same face");
  // The chrome's stack is the system sans.
  const css = readFileSync(new URL("../renderer/shell.css", import.meta.url), "utf8");
  assert.match(css, /font-family: var\(--ui-font, -apple-system, "Segoe UI", system-ui, sans-serif\)/);
  // macOS offers no monospace choice (it changed only the chrome there).
  assert.deepEqual(fontChoices(true).map(choice => choice.id), ["system"]);
});

test("slice4 every sheet traps and returns focus", async t => {
  const trapped = (doc, win, panel) => {
    const stops = [...panel.querySelectorAll("button, input, select, a[href], summary")].filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest("[hidden]"));
    stops.at(-1).focus();
    const forward = new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    stops.at(-1).dispatchEvent(forward);
    assert.equal(forward.defaultPrevented, true, "Tab on the last stop stays inside");
    assert.ok(panel.contains(doc.activeElement), "focus wrapped inside");
    stops[0].focus();
    const back = new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    stops[0].dispatchEvent(back);
    assert.equal(back.defaultPrevented, true, "Shift+Tab on the first stop stays inside");
    assert.ok(panel.contains(doc.activeElement));
  };
  // Appearance
  {
    const f = appearanceFixture(t);
    f.sheet.open();
    const panel = f.doc.querySelector(`.${SHEET}`);
    trapped(f.doc, f.d.window, panel);
    key(f.d.window, "Escape");
    assert.equal(f.sheet.isOpen(), false);
    assert.equal(f.doc.activeElement.id, "opener", "focus back where it came from");
  }
  // Keyboard shortcuts
  {
    const d = dom('<button id="opener">keys</button>');
    t.after(() => d.window.close());
    const editor = createKeybindingsEditor({ doc: d.window.document, isMac: false });
    d.window.document.getElementById("opener").focus();
    editor.open();
    const panel = d.window.document.querySelector(`.${SHEET_BACKDROP} > .${SHEET}`);
    assert.ok(panel, "the Keyboard shortcuts editor is a sheet");
    trapped(d.window.document, d.window, panel);
    editor.close();
    assert.equal(d.window.document.activeElement.id, "opener");
  }
  // Retire
  {
    const d = dom('<button id="opener">dev-1</button>');
    const doc = d.window.document;
    const dialog = createLifecycleDialog({ doc, request: async () => ({ lifecycleApi: 1, status: "plan", target, planRef: reference, plan: retirePlan(), options: options("retire"), receipt: null, reason: null }) });
    t.after(() => { dialog.dispose(); d.window.close(); });
    doc.getElementById("opener").focus();
    dialog.open({ operation: "retire", instance, workspace: "team" });
    await tick();
    const panel = doc.querySelector(`.${SHEET_BACKDROP} > .${SHEET}`);
    assert.ok(panel);
    trapped(doc, d.window, panel);
    key(d.window, "Escape");
    assert.equal(doc.activeElement.id, "opener");
  }
});


test("slice4 the palette is a centred sheet", async t => {
  const d = dom('<button id="opener">o</button>');
  t.after(() => d.window.close());
  const palette = createPalette({ loadInstances: async () => [], openTerminal() {}, doc: d.window.document });
  d.window.document.getElementById("opener").focus();
  await palette.open();
  const panel = d.window.document.querySelector(`.${SHEET_BACKDROP} > .${SHEET}[role="dialog"][aria-modal="true"]`);
  assert.ok(panel?.classList.contains("palette"), "the palette takes the sheet's placement and ease");
  key(d.window, "Escape");
  assert.equal(d.window.document.activeElement.id, "opener", "and returns focus");
});

test("slice4 needs-you order is the shared client's: newest claim first, through the one gate", () => {
  const row = (name, since, extra = {}) => ({ instance: name, running: true, runtimeState: "running", ...(since ? { waitingOnYou: { since, producer: "p", reason: "question" } } : {}), ...extra });
  const rows = [row("a", "2026-11-19T10:00:00.000Z"), row("b"), row("c", "2026-11-19T12:00:00.000Z"), row("d", "2026-11-19T11:00:00.000Z", { running: false })];
  assert.deepEqual(needsYouRows(rows).map(r => r.row.instance), ["c", "a"], "d is not running: no claim");
  assert.deepEqual(needsYouRows(rows, { stale: r => r.instance === "c" }).map(r => r.row.instance), ["a"]);
});

// ── Part C: the key table as Joan decided it (2026-11-19), one test per decided chord ──

test("slice4 key table bound: Ctrl+Space is the Desktop's default leader, Ctrl+X the other choice, the TUI's unchanged", () => {
  assert.equal(DESKTOP_LEADER, "Ctrl+Space");
  assert.equal(DEFAULT_KEYMAP["app.leader"], "Ctrl+Space", "the same on macOS (⌃Space) and elsewhere");
  for (const family of Object.keys(DEFAULT_KEYMAPS)) assert.equal(DEFAULT_KEYMAPS[family]["app.leader"], "Ctrl+Space", family);
  assert.deepEqual(LEADER_CHOICES, ["Ctrl+Space", "Ctrl+X"]);
  assert.deepEqual(LEADER, { mac: "ctrl+x", other: "ctrl+x" }, "the shared LEADER stays Ctrl+X until the TUI reads NUL");
  assert.ok(TERMINAL_ALLOWLIST.includes("app.leader"));
});

test("slice4 key table bound: the leader then h is split right, then v split down (both clients), beside | and -", () => {
  assert.equal(leaderDoes("h"), "split-right"); assert.equal(leaderDoes("|"), "split-right");
  assert.equal(leaderDoes("v"), "split-down"); assert.equal(leaderDoes("-"), "split-down");
});

test("slice4 key table bound: Alt+N is New agent (Ctrl+Alt+N in the other families, ⌥⌘N on macOS), from a terminal too", () => {
  assert.deepEqual(DEFAULT_KEYMAPS.alt["app.newAgent"], { mac: "Mod+Alt+N", other: "Alt+N" });
  assert.deepEqual(DEFAULT_KEYMAPS["ctrl+alt"]["app.newAgent"], { mac: "Mod+Alt+N", other: "Ctrl+Alt+N" });
  assert.deepEqual(DEFAULT_KEYMAPS["ctrl+shift"]["app.newAgent"], { mac: "Mod+Alt+N", other: "Ctrl+Alt+N" });
  assert.ok(TERMINAL_ALLOWLIST.includes("app.newAgent"));
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /registerAction\(\{ id: "app\.newAgent", label: `New \$\{DESKTOP_NOUNS\.instance\}`, context: "global", run: \(\) => openPaletteOnSouls\(\) \}\);/);
});

test("slice4 key table bound: Delete retires in the sidebar (the sheet), beside D", () => {
  assert.equal(DEFAULT_KEYMAP[SIDEBAR_DELETE.id], "Delete");
  assert.equal(SIDEBAR_DELETE.does, "retire");
  assert.equal(DEFAULT_KEYMAP["sidebar.key.retire"], "Shift+D", "D is kept");
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /for \(const \{ id, does \} of \[\.\.\.SIDEBAR_KEYS, SIDEBAR_DELETE\]\) \{/, "registered as a sidebar key, through the leader's dispatch");
});

test("slice4 key table bound: the working keys are kept, and Alt+., Alt+Enter and Alt+Esc are not taken", () => {
  assert.deepEqual(["stop", "start", "restart", "refresh"].map(does => plainKeys(does)), [["X"], ["S"], ["R"], ["r"]], "X/S/R stay upper case; r stays refresh");
  assert.deepEqual(["1", "2", "3"].map(leaderDoes), ["instances", "souls", "capabilities"], "the leader's 1..3 stay the views");
  assert.equal(DEFAULT_KEYMAP["tabs.goto1"], DEFAULT_KEYMAPS.alt["tabs.goto1"]);
  assert.deepEqual(DEFAULT_KEYMAP["split.vertical"], { mac: "Mod+\\", other: "Alt+E" });
  assert.deepEqual(DEFAULT_KEYMAP["split.horizontal"], { mac: "Mod+Shift+\\", other: "Alt+Shift+E" });
  const taken = new Set(Object.values(DEFAULT_KEYMAP).flatMap(v => (v && typeof v === "object" ? [v.mac, v.other] : [v])).filter(Boolean));
  for (const chord of ["Alt+.", "Alt+Enter", "Alt+Escape", "Alt+Shift+Enter"]) assert.equal(taken.has(chord), false, `${chord} is not taken`);
  assert.equal(CHORDS.some(row => [row.mac, row.alt, row.other, row.shift].includes("alt+enter")), false);
});

test("slice4 key table bound: the Keyboard sheet switches the leader in one click, and says why to", t => {
  const d = dom('<button id="opener">o</button>');
  const memory = new Map(), previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
  t.after(() => { resetAllBindings(); globalThis.localStorage = previous; d.window.close(); });
  resetAllBindings();
  const editor = createKeybindingsEditor({ doc: d.window.document, isMac: false });
  editor.open();
  const doc = d.window.document;
  const radios = [...doc.querySelectorAll('.kb-leader input[type="radio"]')];
  assert.deepEqual(radios.map(r => r.parentElement.textContent.trim()), ["Ctrl+Space (default)", "Ctrl+X"]);
  assert.equal(radios[0].checked, true);
  assert.match(doc.querySelector(".kb-leader-note").textContent, /If Ctrl\+Space doesn't open the help sheet, your input method takes it .*: choose Ctrl\+X here\./);
  radios[1].checked = true; radios[1].dispatchEvent(new d.window.Event("change", { bubbles: true }));
  assert.equal(getBinding("app.leader", false), "Ctrl+X");
  radios[0].checked = true; radios[0].dispatchEvent(new d.window.Event("change", { bubbles: true }));
  assert.equal(getBinding("app.leader", false), "Ctrl+Space");
  // A leader of the user's own is kept and said.
  setBinding("app.leader", "Ctrl+Y");
  editor.close(); editor.open();
  assert.equal([...doc.querySelectorAll('.kb-leader input[type="radio"]')].some(r => r.checked), false);
  assert.equal(doc.querySelector(".kb-leader-own").textContent, "Your own leader: Ctrl+Y.");
  editor.close();
  // The help sheet says it too (shell.mjs leaderHelp).
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /const note = chord === DESKTOP_LEADER \? `If an input method takes \$\{formatChord\(chord, isMac\)\}, choose \$\{formatChord\(LEADER_CHOICES\[1\], isMac\)\} on Keyboard shortcuts/);
});

test("slice4 key table bound: the leader then b hides or shows the sidebar (both clients: the TUI's list)", async () => {
  assert.equal(leaderDoes("b"), "sidebar");
  const { createLeaderDispatch } = await import("../renderer/leader-dispatch.mjs");
  const ran = [];
  const dispatch = createLeaderDispatch({ sidebar: () => ran.push("sidebar.toggle"), say: () => {} });
  assert.equal(dispatch.run("sidebar"), true); assert.deepEqual(ran, ["sidebar.toggle"]);
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /  sidebar: \(\) => runAction\("sidebar\.toggle"\),/);
});
