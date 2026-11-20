import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createWorkspaceSwitcher, LISTED_STATE_TEXT, LISTED_STATE_WORD, LIST_UNSUPPORTED_TEXT, REMOVE_HINT, listFailedText, addableText, STALE_HEADING } from "../renderer/workspace-switcher.mjs";
import { workspaceChoiceLabels } from "../../client/workspace-choices.mjs";
import { createAddExecutor } from "../workspace-registry.mjs";

const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const setup = (overrides = {}) => {
  const dom = new JSDOM(html, { url: "file:///renderer/index.html" });
  const selected = [];
  const controller = createWorkspaceSwitcher({
    document: dom.window.document,
    selectWorkspace: (id) => selected.push(id),
    discoverSuggestions: async () => [],
    addWorkspace: async (path) => ({ ok: true, workspace: { id: path, path, name: "workspace" } }),
    pickWorkspace: async () => ({ ok: false, code: "cancelled", reason: "cancelled" }),
    ...overrides,
  });
  return { dom, document: dom.window.document, selected, controller };
};

const A = { id: "/org-a/oats", path: "/org-a/oats", name: "oats", team: { name: "alpha" } };
const B = { id: "/org-b/oats", path: "/org-b/oats", name: "oats", team: { name: "beta" } };

test("workspace choice labels disambiguate duplicate names with team and the folder's last segments, never a full path (#482)", () => {
  assert.deepEqual(workspaceChoiceLabels([A, B, { id: "/docs", name: "docs" }]), [
    "oats — alpha · org-a/oats", "oats — beta · org-b/oats", "docs",
  ]);
});

// The list says which workspace is current: the row's aria-current and, for the whole list, its description.
const current = (document) => document.querySelector('.ws-option[aria-current="true"]')?.dataset.workspaceId ?? null;
const said = (document) => document.getElementById("ws-list").getAttribute("aria-description");

test("workspace switcher: deferred A completing after B cannot overwrite B", async () => {
  const { dom, document, controller } = setup();
  const aGate = deferred(), bGate = deferred();
  const commitA = controller.begin();
  const a = aGate.promise.then((workspace) => commitA(workspace, [workspace]));
  const commitB = controller.begin();
  const b = bGate.promise.then((workspace) => commitB(workspace, [workspace]));
  bGate.resolve(B);
  assert.equal(await b, true);
  assert.equal(current(document), B.id);
  assert.equal(document.querySelector(".ws-option .ws-option-name").textContent, "oats");
  assert.equal(said(document), "Current workspace: oats");
  aGate.resolve(A);
  assert.equal(await a, false);
  assert.equal(current(document), B.id);
  assert.equal(said(document), "Current workspace: oats");
  controller.dispose(); dom.window.close();
});

test("the workspace list is disambiguated, keeps the focused row across a repaint, and switches explicitly", () => {
  const { dom, document, selected, controller } = setup();
  controller.begin()(B, [A, B]);
  const options = [...document.querySelectorAll(".ws-option")];
  // By their teams, never their folders (the shared labels above are the TUI's): a row names no place.
  assert.deepEqual(options.map((option) => option.querySelector(".ws-option-name").textContent), ["oats — alpha", "oats — beta"]);
  assert.equal(said(document), "Current workspace: oats — beta");
  assert.deepEqual(options.map((option) => option.getAttribute("aria-current")), [null, "true"]);
  options[0].focus();
  controller.begin()(B, [A, B]);
  assert.equal(document.activeElement.dataset.workspaceId, "/org-a/oats",
    "roster refresh preserves the focused workspace option identity");
  document.activeElement.click();
  assert.deepEqual(selected, ["/org-a/oats"]);
  assert.equal(document.activeElement.dataset.workspaceId, "/org-a/oats", "the list stays where it is: there is no menu to close");
  document.querySelector('.ws-option[aria-current="true"]').click();
  assert.deepEqual(selected, ["/org-a/oats", "/org-b/oats"], "the current row, picked while A's switch is on its way, supersedes it");
  controller.reset("/org-b/oats"); // that switch lands
  document.querySelector('.ws-option[aria-current="true"]').click();
  assert.deepEqual(selected, ["/org-a/oats", "/org-b/oats"], "with no pick on its way, the current workspace is not selected again");
  controller.dispose(); dom.window.close();
});

test("workspace choice notice says nothing is reported without creating a selectable option; a repainted-away row selects nothing", async () => {
  const { dom, document, controller, selected } = setup();
  controller.choose([]); await settle();
  const note = document.querySelector('.ws-menu-empty'), list = document.getElementById('ws-options');
  assert.equal(note.getAttribute('role'), 'status'); assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'No workspace choices reported.'); assert.equal(list.contains(note), false);
  assert.equal(document.querySelector('.ws-option'), null);
  controller.begin()(A, [A, B]); assert.equal(note.hidden, true); assert.equal(note.textContent, '');
  const old = document.querySelectorAll('.ws-option')[1];
  controller.begin()(A, [A, B]);
  assert.equal(old.isConnected, false, "the repaint drew new rows");
  old.dispatchEvent(new dom.window.Event('click')); assert.deepEqual(selected, [], 'a removed row cannot select');
  assert.equal(document.querySelectorAll('.ws-option').length, 2);
  controller.dispose(); dom.window.close();
});

/* ── Add local workspace… (#518): each found deployment is one button that adds it and opens it here ── */
const C = { id: "/org-c/tools", path: "/org-c/tools", name: "tools", team: { name: "gamma" }, reason: "Team-scope sibling" };
const suggestionButtons = (document) => [...document.querySelectorAll(".ws-suggestion")];
const suggestion = (document, id) => document.querySelector(`.ws-suggestion[data-workspace-id="${id}"]`);

test("a found deployment is one click: it is added, the dialog closes, it is picked and focus is on its row", async () => {
  const calls = [];
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ suggestions: [A, C] }),
    addWorkspace: async (path) => { calls.push(path); return { ok: true, workspace: C }; },
  });
  controller.begin()(B, [B]);
  const addOpen = document.getElementById("ws-add-open");
  assert.equal(addOpen.getAttribute("aria-label"), "Add local workspace…", "the list's header button");
  assert.equal(addOpen.title, "Add local workspace…");
  addOpen.click();
  await settle();
  const modal = document.getElementById("ws-modal");
  assert.equal(modal.hidden, false);
  assert.equal(document.activeElement, document.getElementById("ws-suggestion-search"));
  assert.deepEqual([...document.querySelectorAll(".ws-suggestion-title")].map((node) => node.textContent), ["oats", "tools"]);
  assert.equal(document.getElementById("ws-dialog-status").textContent, "2 workspaces to add");
  assert.equal(document.getElementById("ws-confirm").hidden, true, "no confirm step: the confirm is Onboard's alone");
  suggestion(document, C.id).click();
  await settle();
  assert.deepEqual(calls, [C.id]);
  assert.deepEqual(selected, [C.id], "opened here at once");
  assert.equal(modal.hidden, true);
  assert.equal(document.activeElement.dataset.workspaceId, C.id, "focus in the list, on the added workspace's row");
  assert.ok(document.getElementById("ws-options").contains(document.activeElement));
  assert.equal(document.activeElement.getAttribute("aria-current"), "true");
  controller.dispose(); dom.window.close();
});

// Source bug (reported, not worked around): reconcileAddedWorkspace focuses focusTarget(), which prefers the
// list's tab stop (the row last focused) over the workspace just added, so focus lands on an older row.
test("the added workspace's row gets focus even when another row was the list's tab stop", async () => {
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ suggestions: [C] }),
    addWorkspace: async () => ({ ok: true, workspace: C }),
  });
  controller.begin()(B, [A, B]);
  document.querySelector(`.ws-option[data-workspace-id="${A.id}"]`).focus();
  await controller.openModal();
  suggestion(document, C.id).click();
  await settle();
  assert.equal(document.activeElement.dataset.workspaceId, C.id);
  controller.dispose(); dom.window.close();
});

test("Enter on a focused found deployment adds and opens that one", async () => {
  const calls = [];
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ suggestions: [A, C] }),
    addWorkspace: async (path) => { calls.push(path); return { ok: true, workspace: C }; },
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  suggestion(document, A.id).focus();
  document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  assert.equal(document.activeElement, suggestion(document, C.id));
  // The module leaves Enter to the native button, whose activation is a click; jsdom does not synthesize that
  // click from a keydown, so the test sends the click a real Enter would.
  const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false, "Enter is not swallowed: the button's own activation runs");
  document.activeElement.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(calls, [C.id]); assert.deepEqual(selected, [C.id]);
  assert.equal(document.getElementById("ws-modal").hidden, true);
  controller.dispose(); dom.window.close();
});

test("found deployments are one group of plain buttons, never radios", async () => {
  const { dom, document, controller } = setup({ discoverSuggestions: async () => ({ suggestions: [A, C] }) });
  controller.begin()(B, [B]);
  await controller.openModal();
  const group = document.getElementById("ws-suggestions");
  assert.equal(group.getAttribute("role"), "group");
  assert.equal(group.getAttribute("aria-label"), "Suggested OATS workspaces");
  for (const button of suggestionButtons(document)) {
    assert.equal(button.tagName, "BUTTON"); assert.equal(button.type, "button");
    assert.equal(button.hasAttribute("role"), false, "no role=radio");
    assert.equal(button.hasAttribute("aria-checked"), false);
    assert.equal(button.querySelector(".ws-radio"), null);
    assert.equal(button.title, button.dataset.workspaceId, "the tooltip gives the path");
  }
  assert.equal(document.querySelector('#ws-modal [role="radio"], #ws-modal [role="radiogroup"], #ws-modal [aria-checked]'), null);
  assert.equal(suggestion(document, C.id).querySelector(".ws-suggestion-meta").textContent, "gamma · /org-c/tools");
  assert.equal(suggestion(document, C.id).querySelector(".ws-suggestion-reason").textContent, "Team-scope sibling");
  controller.dispose(); dom.window.close();
});

test("Up/Down, Home and End move focus among the found deployments, wrapping, one tab stop that follows focus", async () => {
  const D = { id: "/org-d/docs", path: "/org-d/docs", name: "docs" };
  const { dom, document, controller } = setup({ discoverSuggestions: async () => ({ suggestions: [A, C, D] }) });
  controller.begin()(B, [B]);
  await controller.openModal();
  const stops = () => suggestionButtons(document).map((button) => button.tabIndex);
  assert.deepEqual(stops(), [0, -1, -1], "one tab stop: the first");
  const key = (k) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const at = () => document.activeElement.dataset.workspaceId;
  suggestion(document, A.id).focus();
  assert.equal(key("ArrowDown"), true); assert.equal(at(), C.id);
  assert.deepEqual(stops(), [-1, 0, -1], "the tab stop follows focus");
  key("ArrowDown"); assert.equal(at(), D.id);
  key("ArrowDown"); assert.equal(at(), A.id, "Down from the last wraps to the first");
  key("ArrowUp"); assert.equal(at(), D.id, "Up from the first wraps to the last");
  key("ArrowUp"); assert.equal(at(), C.id);
  // Right Arrow is a stale row's way to its Remove; a found deployment has none, and Left/Right never move along.
  assert.equal(key("ArrowRight"), false); assert.equal(at(), C.id);
  assert.equal(key("ArrowLeft"), false); assert.equal(at(), C.id);
  key("Home"); assert.equal(at(), A.id);
  key("End"); assert.equal(at(), D.id);
  assert.deepEqual(stops(), [-1, -1, 0]);
  assert.equal(key("Enter"), false, "Enter is the button's own");
  controller.dispose(); dom.window.close();
});

test("the filter narrows the found deployments by name, path, team or reason; the tab stop stays on one shown", async () => {
  const mutations = [];
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A, C] }),
    addWorkspace: async (path) => { mutations.push(path); return { ok: true, workspace: C }; },
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  const search = document.getElementById("ws-suggestion-search");
  const filter = (value) => { search.value = value; search.dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const shown = () => suggestionButtons(document).map((button) => button.dataset.workspaceId);
  for (const query of ["tools", "ORG-C", "gamma", "sibling"]) { filter(query); assert.deepEqual(shown(), [C.id], query); }
  assert.equal(suggestion(document, C.id).tabIndex, 0, "the first shown is the tab stop when the last one is filtered out");
  filter("alpha"); assert.deepEqual(shown(), [A.id]);
  filter(""); assert.deepEqual(shown(), [A.id, C.id]);
  assert.deepEqual(mutations, [], "filtering adds nothing");
  filter("tools");
  suggestion(document, C.id).click();
  await settle();
  assert.deepEqual(mutations, [C.id]);
  controller.dispose(); dom.window.close();
});

test("a deployment a served view already holds is not offered (#482)", async () => {
  const held = { id: "ws:held", name: "held", deployments: [A.path] };
  const { dom, document, controller } = setup({ discoverSuggestions: async () => ({ suggestions: [A, B, C] }) });
  controller.begin()(B, [B, held]);
  await controller.openModal();
  assert.deepEqual(suggestionButtons(document).map((button) => button.dataset.workspaceId), [C.id],
    "B is a view's own id; A is a deployment a view names");
  assert.equal(document.getElementById("ws-dialog-status").textContent, "1 workspace to add");
  controller.dispose(); dom.window.close();
});

/* ── This computer's list's rows that can't be opened (#1390): listed after the found deployments, to remove ── */
const listed = (name, state, more = {}) => ({ id: `/h/${name}`, path: `/h/${name}`, name, state, removable: true, ...more });
const staleSetup = (found, overrides = {}) => {
  const calls = { discovered: 0, added: [], removed: [] };
  const s = setup({
    discoverSuggestions: async () => { calls.discovered++; return { suggestions: found }; },
    addWorkspace: async (path) => { calls.added.push(path); return { ok: true, workspace: { id: path, path, name: "x" } }; },
    removeListed: async (path) => { calls.removed.push(path); return { ok: true, removed: true }; },
    ...overrides,
  });
  s.controller.begin()(B, [B]);
  const removeOf = (name) => s.document.querySelector(`.ws-remove-listed[data-workspace-path="/h/${name}"]`);
  const key = (k) => {
    const event = new s.dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    s.document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { ...s, calls, removeOf, key, status: () => s.document.getElementById("ws-dialog-status") };
};

test("a stale row is not offered as an add: it is listed after the found deployments, says its state, and a click adds nothing", async () => {
  const s = staleSetup([listed("gone", "missing"), listed("acme", "ok"), listed("old", "not-a-deployment"),
    listed("locked", "unreadable"), { id: "/h/found", path: "/h/found", name: "found" }]);
  await s.controller.openModal();
  const { document } = s;
  assert.deepEqual(suggestionButtons(document).map((b) => [b.dataset.workspaceId, b.classList.contains("ws-suggestion-stale")]), [
    ["/h/acme", false], ["/h/found", false], ["/h/gone", true], ["/h/old", true], ["/h/locked", true]],
    "the ones that can be opened first (an ok row, a found deployment with no state), then the stale ones");
  assert.equal(s.status().textContent, "2 workspaces to add", "a stale row is not counted as a suggestion");
  assert.deepEqual(LISTED_STATE_WORD, { missing: "Missing", "not-a-deployment": "Not a deployment", unreadable: "Can't be checked" });
  assert.deepEqual(LISTED_STATE_TEXT, {
    missing: "Missing: the folder is gone, or its volume isn't mounted",
    "not-a-deployment": "Not a deployment any more: no oats-local.yaml",
    unreadable: "Can't be checked: OATS couldn't read this folder",
  });
  for (const [name, state] of [["gone", "missing"], ["old", "not-a-deployment"], ["locked", "unreadable"]]) {
    const button = suggestion(document, `/h/${name}`);
    assert.equal(button.parentElement.className, "ws-suggestion-row", name);
    assert.equal(button.getAttribute("aria-disabled"), "true", `${name}: it can't be opened`);
    assert.equal(button.disabled, false, `${name}: still focusable, to reach its Remove`);
    assert.equal(button.dataset.listedState, state);
    assert.equal(button.querySelector(".ws-suggestion-meta").textContent, `/h/${name}`, "its meta line is the path");
    const word = button.querySelector(".ws-listed-state");
    assert.equal(word.textContent, LISTED_STATE_WORD[state]); assert.equal(word.getAttribute("aria-hidden"), "true");
    assert.equal(button.querySelector(".sr-only").textContent, `, ${LISTED_STATE_TEXT[state]}`, "its state, said in full");
    assert.equal(button.title, `/h/${name}\n${LISTED_STATE_TEXT[state]}`);
  }
  suggestion(document, "/h/gone").click(); await settle();
  assert.deepEqual(s.calls.added, [], "a stale row opens nothing");
  assert.deepEqual(s.selected, []);
  assert.equal(document.getElementById("ws-modal").hidden, false);
  s.controller.dispose(); s.dom.window.close();
});

// The dialog is named as its button is (Add local workspace…), and its count is what can be added: the rows that
// can't be opened sit after them, under their own heading, as their own group.
test("the Add dialog: titled as its button, counting only what can be added; the rows that can't be opened under their own heading", async () => {
  const s = staleSetup([listed("gone", "missing"), listed("acme", "ok"), { id: "/h/found", path: "/h/found", name: "found" }]);
  const { document } = s;
  assert.equal(document.getElementById("ws-dialog-title").textContent, "Add local workspace");
  assert.equal(document.getElementById("ws-add-open").getAttribute("aria-label"), "Add local workspace…", "the button it is named after");
  assert.equal(document.getElementById("ws-dialog-close").getAttribute("aria-label"), "Close Add local workspace");
  await s.controller.openModal();
  assert.equal(s.status().textContent, "2 workspaces to add", "three rows, two to add");
  assert.deepEqual([addableText(1), addableText(0), STALE_HEADING], ["1 workspace to add", "No OATS workspaces to add.", "Can't be opened"]);
  const list = document.getElementById("ws-suggestions");
  const heading = list.querySelector(".ws-suggestions-heading");
  assert.equal(heading.tagName, "H3"); assert.equal(heading.textContent, STALE_HEADING);
  const group = heading.nextElementSibling;
  assert.equal(group.getAttribute("role"), "group"); assert.equal(group.getAttribute("aria-labelledby"), heading.id);
  assert.deepEqual([...group.querySelectorAll(".ws-suggestion")].map((b) => b.dataset.workspaceId), ["/h/gone"], "the stale row, in its group");
  assert.deepEqual([...list.children].map((el) => el.className), ["ws-suggestion", "ws-suggestion", "ws-suggestions-heading", "ws-stale-group"],
    "those to add first, then the heading and its rows");
  // The rows are one list to the keys: Down from the last to add goes to the stale row.
  suggestion(document, "/h/found").focus(); s.key("ArrowDown");
  assert.equal(document.activeElement, suggestion(document, "/h/gone"));
  // A filter that leaves no stale row leaves no heading.
  const search = document.getElementById("ws-suggestion-search"); search.value = "acme"; search.dispatchEvent(new s.dom.window.Event("input", { bubbles: true }));
  assert.equal(list.querySelector(".ws-suggestions-heading"), null);
  s.controller.dispose(); s.dom.window.close();
});

test("with only rows that can't be opened, the count says there is nothing to add, and they keep their heading", async () => {
  const s = staleSetup([listed("gone", "missing")]);
  await s.controller.openModal();
  assert.equal(s.status().textContent, "No OATS workspaces to add.");
  assert.equal(s.document.querySelector("#ws-suggestions .ws-suggestions-heading").textContent, STALE_HEADING);
  s.controller.dispose(); s.dom.window.close();
});

test("a row in any other state, or one a served view already holds, is neither offered nor listed", async () => {
  const s = staleSetup([listed("odd", "something-new"), listed("blank", ""), listed("held", "missing"), listed("acme", "ok")]);
  s.controller.begin()(B, [B, { id: "ws:held", name: "held", deployments: ["/h/held"] }]);
  await s.controller.openModal();
  assert.deepEqual(suggestionButtons(s.document).map((b) => b.dataset.workspaceId), ["/h/acme"]);
  s.controller.dispose(); s.dom.window.close();
});

test("a removable stale row has Remove beside it, outside the row, described by the shared hint; without removeListed there is none", async () => {
  const s = staleSetup([listed("gone", "missing"), listed("kept", "unreadable", { removable: false })]);
  await s.controller.openModal();
  const gone = suggestion(s.document, "/h/gone"), remove = s.removeOf("gone");
  assert.equal(remove.tagName, "BUTTON"); assert.equal(remove.type, "button");
  assert.equal(remove.textContent, "Remove");
  assert.equal(remove.getAttribute("aria-label"), "Remove gone from this computer's list");
  assert.equal(remove.tabIndex, -1, "reached with Right Arrow, not a second tab stop");
  assert.equal(gone.contains(remove), false); assert.equal(remove.parentElement, gone.parentElement);
  assert.equal(gone.getAttribute("aria-describedby"), "ws-remove-hint");
  assert.equal(s.document.getElementById("ws-remove-hint").textContent, REMOVE_HINT);
  assert.equal(s.removeOf("kept"), null, "not removable: no Remove");
  assert.equal(suggestion(s.document, "/h/kept").hasAttribute("aria-describedby"), false);
  s.controller.dispose(); s.dom.window.close();

  const bare = setup({ discoverSuggestions: async () => ({ suggestions: [listed("gone", "missing")] }) });
  bare.controller.begin()(B, [B]);
  await bare.controller.openModal();
  assert.ok(suggestion(bare.document, "/h/gone"), "still listed, in words");
  assert.equal(bare.document.querySelector(".ws-remove-listed"), null);
  assert.equal(bare.document.getElementById("ws-remove-hint"), null);
  assert.equal(suggestion(bare.document, "/h/gone").hasAttribute("aria-describedby"), false);
  bare.controller.dispose(); bare.dom.window.close();
});

test("keys over found and stale rows: Up/Down/Home/End walk them all; Right reaches a row's Remove, Left and Escape go back without closing", async () => {
  const s = staleSetup([A, listed("gone", "missing"), listed("old", "not-a-deployment")]);
  await s.controller.openModal();
  const { document, key } = s;
  const at = () => document.activeElement.dataset.workspaceId || document.activeElement.dataset.workspacePath;
  suggestion(document, A.id).focus();
  key("ArrowDown"); assert.equal(document.activeElement, suggestion(document, "/h/gone"), "from the found ones into the stale ones");
  key("End"); assert.equal(at(), "/h/old");
  key("ArrowDown"); assert.equal(at(), A.id, "wraps");
  key("ArrowUp"); assert.equal(at(), "/h/old");
  key("Home"); assert.equal(at(), A.id);
  key("ArrowDown");
  assert.equal(key("ArrowRight"), true); assert.equal(document.activeElement, s.removeOf("gone"));
  assert.equal(key("ArrowLeft"), true); assert.equal(document.activeElement, suggestion(document, "/h/gone"));
  key("ArrowRight");
  assert.equal(key("Escape"), true); assert.equal(document.activeElement, suggestion(document, "/h/gone"), "Escape on Remove goes back to its row");
  assert.equal(document.getElementById("ws-modal").hidden, false, "and does not close the dialog");
  key("ArrowRight");
  key("ArrowDown"); assert.equal(document.activeElement, suggestion(document, "/h/old"), "Down from a Remove moves from its row");
  assert.equal(key("Escape"), true);
  assert.equal(document.getElementById("ws-modal").hidden, true, "Escape on a row closes the dialog");
  s.controller.dispose(); s.dom.window.close();
});

test("the filter applies to stale rows too", async () => {
  const s = staleSetup([A, listed("gone", "missing"), listed("old", "not-a-deployment")]);
  await s.controller.openModal();
  const search = s.document.getElementById("ws-suggestion-search");
  const filter = (value) => { search.value = value; search.dispatchEvent(new s.dom.window.Event("input", { bubbles: true })); };
  const shown = () => suggestionButtons(s.document).map((b) => b.dataset.workspaceId);
  filter("gone"); assert.deepEqual(shown(), ["/h/gone"]);
  assert.ok(s.removeOf("gone")); assert.equal(s.removeOf("old"), null);
  filter("/h/"); assert.deepEqual(shown(), ["/h/gone", "/h/old"]);
  filter(""); assert.deepEqual(shown(), [A.id, "/h/gone", "/h/old"]);
  s.controller.dispose(); s.dom.window.close();
});

test("Remove asks nothing, is busy while it runs, says what it did and moves focus to the next row, else the previous, else the filter", async () => {
  // The first Remove is held, to see the busy state; the next answers at once.
  const gate = deferred();
  const held = staleSetup([A, listed("gone", "missing"), listed("old", "not-a-deployment")], {
    removeListed: (path) => { held.calls.removed.push(path); return held.calls.removed.length === 1 ? gate.promise : { ok: true, removed: true }; },
  });
  await held.controller.openModal();
  const doc = held.document;
  held.removeOf("gone").focus(); held.removeOf("gone").click();
  assert.deepEqual(held.calls.removed, ["/h/gone"]);
  assert.equal(held.status().textContent, "Removing gone…");
  assert.equal(doc.querySelector(".ws-dialog").getAttribute("aria-busy"), "true");
  const dialogButtons = [...doc.querySelectorAll(".ws-dialog button")].filter((b) => !b.hidden);
  assert.deepEqual(dialogButtons.filter((b) => !b.disabled).map((b) => b.id || b.className), [], "every dialog button is disabled");
  // Clicks sent past the disabled state: the handlers' own guard holds too.
  held.removeOf("old").disabled = false; held.removeOf("old").click();
  suggestion(doc, A.id).disabled = false; suggestion(doc, A.id).click();
  await settle();
  assert.deepEqual(held.calls.removed, ["/h/gone"], "one at a time");
  assert.deepEqual(held.calls.added, [], "no add while removing");
  gate.resolve({ ok: true, removed: true }); await settle();
  assert.equal(held.status().textContent, "Removed gone from this computer's list.");
  assert.equal(held.status().classList.contains("error"), false);
  assert.equal(suggestion(doc, "/h/gone"), null);
  assert.equal(doc.activeElement, suggestion(doc, "/h/old"), "focus on the next row");
  held.removeOf("old").click(); await settle();
  assert.equal(doc.activeElement, suggestion(doc, A.id), "the last row gone: focus on the previous");
  assert.equal(held.calls.discovered, 1, "the dialog's list is not asked for again");
  assert.equal(doc.getElementById("ws-modal").hidden, false);
  held.controller.dispose(); held.dom.window.close();

  const alone = staleSetup([listed("gone", "missing")]);
  await alone.controller.openModal();
  alone.removeOf("gone").click(); await settle();
  assert.equal(alone.document.activeElement, alone.document.getElementById("ws-suggestion-search"), "no row left: the filter");
  alone.controller.dispose(); alone.dom.window.close();
});

test("a failed Remove says why and keeps focus on its Remove; a thrown one too", async () => {
  let answer = async () => ({ ok: false, code: "E_DEPLOYMENTS_BUSY", reason: "this computer's deployments list is locked" });
  const s = staleSetup([listed("gone", "missing")], { removeListed: (path) => answer(path) });
  await s.controller.openModal();
  s.removeOf("gone").focus(); s.removeOf("gone").click(); await settle();
  assert.equal(s.status().textContent, "this computer's deployments list is locked");
  assert.ok(s.status().classList.contains("error"));
  assert.ok(suggestion(s.document, "/h/gone"), "still listed");
  assert.equal(s.document.activeElement, s.removeOf("gone"));
  assert.equal(s.removeOf("gone").disabled, false);
  answer = async () => { throw new Error("transport closed"); };
  s.removeOf("gone").click(); await settle();
  assert.equal(s.status().textContent, "transport closed");
  assert.equal(s.document.activeElement, s.removeOf("gone"));
  s.controller.dispose(); s.dom.window.close();
});

test("the discovery status says when this computer's list can't be read: unsupported, failed (with or without a reason); ok or absent says nothing more", async () => {
  const cases = [
    [{ state: "unsupported" }, `1 workspace to add. ${LIST_UNSUPPORTED_TEXT}`],
    [{ state: "failed", message: "the file is not JSON" }, `1 workspace to add. ${listFailedText("the file is not JSON")}`],
    [{ state: "failed" }, `1 workspace to add. ${listFailedText("the installed OATS CLI could not read it.")}`],
    [{ state: "ok" }, "1 workspace to add"],
    [undefined, "1 workspace to add"],
  ];
  assert.equal(LIST_UNSUPPORTED_TEXT, "This oats can't list this computer's deployments. Update oats.");
  assert.equal(listFailedText("x"), "Couldn't read this computer's deployments: x");
  for (const [list, said] of cases) {
    const { dom, document, controller } = setup({ discoverSuggestions: async () => ({ suggestions: [A], ...(list ? { list } : {}) }) });
    controller.begin()(B, [B]);
    await controller.openModal();
    const status = document.getElementById("ws-dialog-status");
    assert.equal(status.textContent, said, JSON.stringify(list));
    assert.equal(status.classList.contains("error"), false, "a note, not an error: the dialog still works");
    controller.dispose(); dom.window.close();
  }
  const { dom, document, controller } = setup({ discoverSuggestions: async () => ({ suggestions: [], list: { state: "unsupported" } }) });
  controller.begin()(B, [B]);
  await controller.openModal();
  assert.equal(document.getElementById("ws-dialog-status").textContent, `No OATS workspaces to add. ${LIST_UNSUPPORTED_TEXT}`,
    "a sentence that already ends in a period gets no second one");
  controller.dispose(); dom.window.close();
});

test("closing the dialog (Escape, Cancel, ×, the backdrop) returns focus to what opened it, else the header's Add", async () => {
  const { dom, document, controller } = setup({ discoverSuggestions: async () => ({ suggestions: [A] }) });
  controller.begin()(B, [B]);
  const modal = document.getElementById("ws-modal"), addOpen = document.getElementById("ws-add-open");
  const opener = document.createElement("button"); opener.type = "button"; opener.textContent = "Choose a workspace…";
  document.body.append(opener);
  const closers = {
    Escape: () => document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    Cancel: () => document.getElementById("ws-cancel").click(),
    "×": () => document.getElementById("ws-dialog-close").click(),
    backdrop: () => modal.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true })),
  };
  for (const [name, close] of Object.entries(closers)) {
    await controller.openModal(opener);
    assert.equal(modal.hidden, false, name);
    close();
    assert.equal(modal.hidden, true, name);
    assert.equal(document.activeElement, opener, `${name}: back to the opener`);
    await controller.openModal();
    close();
    assert.equal(document.activeElement, addOpen, `${name}: no opener given, the header's Add`);
  }
  addOpen.click(); await settle();
  closers.Escape();
  assert.equal(document.activeElement, addOpen, "the header's Add opens it as its own opener");
  controller.dispose(); dom.window.close();
});

test("this computer's deployments are asked for only when the Add dialog opens", async () => {
  let asked = 0;
  const { dom, document, controller } = setup({ discoverSuggestions: async () => { asked++; return { suggestions: [A] }; } });
  controller.choose([]);
  controller.begin()(B, [B]);
  controller.reset(B.id);
  controller.focusList();
  controller.step(1);
  document.getElementById("ws-options").dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
  await settle();
  assert.equal(asked, 0, "not as the list starts, paints, or takes focus");
  await controller.openModal();
  assert.equal(asked, 1);
  document.getElementById("ws-cancel").click();
  await controller.openModal();
  assert.equal(asked, 2, "each opening asks again");
  controller.dispose(); dom.window.close();
});

test("the dialog's confirm is Onboard's alone: hidden until onboarding, shown as Onboard inside it, hidden again after", async () => {
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ suggestions: [A] }),
    pickWorkspace: async () => ({ ok: false, code: "not-a-workspace", reason: "not a deployment", path: "/home/empty", choices: [],
      onboard: { token: "t1", path: "/home/empty" } }),
    onboardWorkspace: async () => ({ ok: false, code: "bad-ref", reason: "fixture" }),
  });
  controller.begin()(B, [B]);
  const confirm = document.getElementById("ws-confirm");
  assert.equal(confirm.hidden, true, "before the dialog opens");
  await controller.openModal();
  assert.equal(confirm.hidden, true, "beside the found deployments");
  document.getElementById("ws-browse").click(); await settle();
  assert.equal(confirm.hidden, true, "beside a refused pick");
  document.querySelector(".ws-pick-setup").click();
  assert.equal(confirm.hidden, false, "onboarding");
  assert.equal(confirm.textContent, "Onboard");
  assert.equal(confirm.disabled, true, "until a repository is named");
  const ref = document.getElementById("ws-onboard-ref");
  ref.value = "github.com/org/agents"; ref.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(confirm.disabled, false);
  document.getElementById("ws-cancel").click();
  await controller.openModal();
  assert.equal(confirm.hidden, true, "reopened: no onboarding, no confirm");
  controller.dispose(); dom.window.close();
});

test("picker success uses its completed add result and picker cancellation is silent", async () => {
  const C = { id: "/org-c/tools", path: "/org-c/tools", name: "tools", team: { name: "gamma" } };
  let pickResult = { ok: false, code: "cancelled", reason: "not rendered" };
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    pickWorkspace: async () => pickResult,
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  const before = document.getElementById("ws-dialog-status").textContent;
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-modal").hidden, false);
  assert.equal(document.getElementById("ws-dialog-status").textContent, before);
  assert.deepEqual(selected, []);

  pickResult = { ok: true, workspace: C };
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-modal").hidden, true);
  assert.deepEqual(selected, ["/org-c/tools"]);
  dom.window.close();
});

test("picker cancellation does not orphan an in-flight discovery loading state", async () => {
  const discovery = deferred();
  const { dom, document, controller } = setup({
    discoverSuggestions: () => discovery.promise,
    pickWorkspace: async () => ({ ok: false, code: "cancelled", reason: "not rendered" }),
  });
  controller.begin()(B, [B]);
  const opening = controller.openModal();
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.querySelector(".ws-dialog").getAttribute("aria-busy"), "false");
  assert.equal(document.getElementById("ws-dialog-status").textContent, "Finding OATS workspaces…",
    "loading remains truthful while the still-owned discovery is pending");
  discovery.resolve({ stale: false, suggestions: [A] });
  await opening;
  assert.equal(document.getElementById("ws-dialog-status").textContent, "1 workspace to add");
  assert.equal(document.querySelector(".ws-suggestion").dataset.workspaceId, "/org-a/oats");
  dom.window.close();
});

test("same-generation stale discovery settles to a neutral idle state", async () => {
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: true, suggestions: [] }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  assert.equal(document.getElementById("ws-dialog-status").textContent, "No current workspace suggestions.");
  assert.equal(document.getElementById("ws-dialog-status").classList.contains("error"), false);
  assert.equal(document.querySelector(".ws-dialog").getAttribute("aria-busy"), "false");
  dom.window.close();
});

test("resolved add domain failure says why, returns focus to that suggestion and never switches", async () => {
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A, C] }),
    addWorkspace: async () => ({ ok: false, code: "foreign-server", reason: "This server is managed outside the app." }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  suggestion(document, C.id).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-modal").hidden, false);
  assert.equal(document.querySelector(".ws-dialog").getAttribute("aria-busy"), "false");
  const status = document.getElementById("ws-dialog-status");
  assert.equal(status.textContent, "This server is managed outside the app."); assert.ok(status.classList.contains("error"));
  assert.equal(document.activeElement, suggestion(document, C.id), "focus back on the suggestion that failed, not the first");
  assert.deepEqual(suggestionButtons(document).map((button) => button.disabled), [false, false], "enabled again: another can be tried");
  assert.deepEqual(selected, []);
  dom.window.close();
});

test("production add executor server-error renders reason and never switches", async () => {
  let dirs = [B.path];
  const executor = createAddExecutor({
    getDirs: () => dirs,
    commitDirs: (next) => { dirs = next; },
    replaceServer: async () => {},
    probeVersion: async () => { throw new Error("probe exploded"); },
    isCompatible: () => true,
    advertises: async () => true,
    refreshAdvertised: async () => true,
    delay: async () => {},
    attempts: 1,
  });
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    addWorkspace: async () => executor(A, () => true),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.querySelector(".ws-suggestion").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-dialog-status").textContent,
    "readiness check failed: probe exploded");
  assert.equal(document.activeElement, document.querySelector(".ws-suggestion"));
  assert.deepEqual(selected, []);
  assert.deepEqual(dirs, [B.path]);
  dom.window.close();
});

test("picker domain and transport failures restore Browse focus", async () => {
  let rejectTransport = false;
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    pickWorkspace: async () => {
      if (rejectTransport) throw new Error("Picker transport failed.");
      return { ok: false, code: "foreign-server", reason: "This server is managed outside the app." };
    },
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-dialog-status").textContent, "This server is managed outside the app.");
  assert.equal(document.activeElement, document.getElementById("ws-browse"));

  document.getElementById("ws-cancel").click();
  rejectTransport = true;
  await controller.openModal();
  document.getElementById("ws-browse").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-dialog-status").textContent, "Picker transport failed.");
  assert.equal(document.activeElement, document.getElementById("ws-browse"));
  dom.window.close();
});

test("not-suggested failure explicitly points to the picker", async () => {
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    addWorkspace: async () => ({ ok: false, code: "not-suggested", reason: "This suggestion expired." }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.querySelector(".ws-suggestion").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.getElementById("ws-dialog-status").textContent,
    "This suggestion expired. Use Browse… to choose it explicitly.");
  assert.equal(document.getElementById("ws-modal").hidden, false);
  dom.window.close();
});

test("pending add is single-flight, cannot be dismissed, and always reconciles", async () => {
  const addGate = deferred();
  const mutationCalls = [];
  const { dom, document, selected, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A, C] }),
    addWorkspace: (path) => { mutationCalls.push(path); return addGate.promise; },
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.querySelector(".ws-suggestion").click();
  assert.equal(document.getElementById("ws-dialog-status").textContent, "Adding oats…");
  const modal = document.getElementById("ws-modal");
  const dialog = document.querySelector(".ws-dialog");
  assert.equal(dialog.getAttribute("aria-busy"), "true");
  assert.equal(document.getElementById("ws-cancel").disabled, true);
  assert.equal(document.getElementById("ws-dialog-close").disabled, true);
  assert.equal(document.getElementById("ws-suggestion-search").disabled, true);
  const busyStatus = document.getElementById("ws-dialog-status");
  assert.equal(document.activeElement, busyStatus, "add parks focus on the status inside the modal");
  busyStatus.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(document.activeElement, busyStatus, "Tab cannot escape while every action is disabled");
  const buttons = suggestionButtons(document);
  assert.deepEqual(buttons.map((button) => button.disabled), [true, true]);
  assert.equal(document.getElementById("ws-browse").disabled, true);
  // A second click while adding (the same suggestion or another, sent past the disabled state) does nothing.
  for (const button of buttons) { button.disabled = false; button.click(); button.disabled = true; }
  const arrow = new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  buttons[0].dispatchEvent(arrow);
  assert.equal(arrow.defaultPrevented, false, "no moves while adding");
  assert.equal(document.activeElement, busyStatus);
  assert.deepEqual(mutationCalls, ["/org-a/oats"], "busy UI and handler guard enforce one mutation");
  dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  modal.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  assert.equal(modal.hidden, false, "Escape and backdrop cannot abandon an in-flight mutation");
  addGate.resolve({ ok: true, workspace: A });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(modal.hidden, true);
  assert.deepEqual(selected, ["/org-a/oats"]);
  assert.equal(said(document), "Current workspace: oats — alpha");
  assert.equal(current(document), "/org-a/oats");
  dom.window.close();
});

test("pending native picker parks focus inside the modal and restores Browse on cancel", async () => {
  const picker = deferred();
  const { dom, document, controller } = setup({
    discoverSuggestions: async () => ({ stale: false, suggestions: [A] }),
    pickWorkspace: () => picker.promise,
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.getElementById("ws-browse").click();
  const busyStatus = document.getElementById("ws-dialog-status");
  assert.equal(document.activeElement, busyStatus);
  busyStatus.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  assert.equal(document.activeElement, busyStatus);
  picker.resolve({ ok: false, code: "cancelled", reason: "not rendered" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(document.activeElement, document.getElementById("ws-browse"));
  assert.equal(document.getElementById("ws-modal").hidden, false);
  dom.window.close();
});

test("stale suggestion discovery cannot repaint a reopened modal", async () => {
  // Every ask is held until the test answers it: one per opening of the dialog.
  const asks = [];
  const { dom, document, controller } = setup({
    discoverSuggestions: () => { const ask = deferred(); asks.push(ask); return ask.promise; },
  });
  controller.begin()(B, [B]);
  const one = controller.openModal(), first = asks.at(-1);
  document.querySelector(".ws-dialog").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const two = controller.openModal(), second = asks.at(-1);
  assert.notEqual(first, second, "each opening asks again");
  second.resolve({ suggestions: [{ id: "/new", name: "new" }] });
  await two;
  assert.equal(document.querySelector(".ws-suggestion-title").textContent, "new");
  first.resolve({ suggestions: [{ id: "/stale", name: "stale" }] });
  await one;
  assert.equal(document.querySelector(".ws-suggestion-title").textContent, "new");
  controller.dispose(); dom.window.close();
});

// The list's keys (a list of buttons, the roster's pattern): Up/Down/Home/End move between rows and stop at
// the ends; a modified arrow is not the list's (the chords and the leader keep theirs).
test("keyboard: Up/Down/Home/End move through the rows and stop at either end; modified arrows are left alone", () => {
  const { dom, document, controller } = setup();
  const C = { id: "/org-c/tools", path: "/org-c/tools", name: "tools" };
  controller.begin()(A, [A, B, C]);
  const key = (k, init = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const at = () => document.activeElement.dataset.workspaceId;
  assert.equal(controller.focusList(), true);
  assert.equal(at(), A.id, "the list's tab stop: the current row");
  assert.equal(key("ArrowUp"), true); assert.equal(at(), A.id, "Up from the first row stays: no wrap");
  key("ArrowDown"); assert.equal(at(), B.id);
  key("End"); assert.equal(at(), C.id);
  key("ArrowDown"); assert.equal(at(), C.id, "Down from the last row stays: no wrap");
  key("Home"); assert.equal(at(), A.id);
  for (const init of [{ altKey: true, shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(key("ArrowDown", init), false, JSON.stringify(init));
    assert.equal(at(), A.id);
  }
  controller.dispose(); dom.window.close();
});

/* ── #461: a picked folder that is not a deployment ── */
const REFUSAL = "This folder isn't an OATS deployment: it has no oats-local.yaml. Choose the deployment folder itself, the one that contains oats-local.yaml.";

test("a parent folder is refused with the explanation and its deployments as one-click adds; nothing is added until one is chosen", async () => {
  const added = [];
  const { dom, document, selected, controller } = setup({
    pickWorkspace: async () => ({ ok: false, code: "not-a-workspace", reason: REFUSAL, path: "/home/Agents",
      choices: [{ path: "/home/Agents/aweb", name: "aweb", kind: "inside" }, { path: "/home/Agents/zeta", name: "zeta", kind: "inside" }], more: 3, limited: true, scanLimit: 200 }),
    addWorkspace: async (path) => { added.push(path); return { ok: true, workspace: { id: path, path, name: path.split("/").pop() } }; },
    onboardWorkspace: async () => assert.fail("no onboarding for a folder with deployments in it"),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.getElementById("ws-browse").click();
  await settle();
  const status = document.getElementById("ws-dialog-status");
  assert.equal(status.textContent, REFUSAL); assert.ok(status.classList.contains("error"));
  assert.equal(status.getAttribute("aria-live"), "polite");
  assert.equal(document.querySelector(".ws-pick-path").textContent, "Chosen: /home/Agents");
  const choices = [...document.querySelectorAll(".ws-pick-choice")];
  assert.deepEqual(choices.map((b) => b.dataset.workspacePath), ["/home/Agents/aweb", "/home/Agents/zeta"]);
  assert.equal(choices[0].querySelector(".ws-pick-name").textContent, "Add aweb");
  assert.equal(document.querySelector(".ws-pick-more").textContent, "and 3 more. Only the first 200 entries of this folder were checked.");
  assert.equal(document.querySelector(".ws-pick-setup"), null, "onboarding is not offered beside deployments");
  assert.equal(document.getElementById("ws-dialog-title").textContent, "Add local workspace", "not the onboarding dialog");
  assert.equal(document.activeElement, choices[0], "focus lands on the first choice");
  assert.deepEqual(added, []); assert.deepEqual(selected, []);
  choices[1].click();
  await settle();
  assert.deepEqual(added, ["/home/Agents/zeta"], "the choice goes through the normal add");
  assert.deepEqual(selected, ["/home/Agents/zeta"]);
  assert.equal(document.getElementById("ws-modal").hidden, true);
  dom.window.close();
});

test("a folder inside a deployment offers that deployment by path", async () => {
  const { dom, document, controller } = setup({
    pickWorkspace: async () => ({ ok: false, code: "not-a-workspace", reason: REFUSAL, path: "/home/OATS/agents",
      choices: [{ path: "/home/OATS", name: "OATS", kind: "ancestor" }], more: 0, limited: false }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.getElementById("ws-browse").click();
  await settle();
  assert.equal(document.querySelector(".ws-pick-choice").textContent, "Add /home/OATS (the deployment this folder is inside)");
  assert.equal(document.querySelector(".ws-pick-more"), null);
  dom.window.close();
});

test("a folder with no deployment near it is refused, with onboarding only as the secondary action", async () => {
  const { dom, document, controller } = setup({
    pickWorkspace: async () => ({ ok: false, code: "not-a-workspace", reason: REFUSAL, path: "/home/empty", choices: [], more: 0, limited: false,
      onboard: { token: "t1", path: "/home/empty" } }),
    onboardWorkspace: async () => ({ ok: false, code: "bad-ref", reason: "fixture" }),
  });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.getElementById("ws-browse").click();
  await settle();
  assert.equal(document.getElementById("ws-dialog-status").textContent, REFUSAL);
  assert.equal(document.getElementById("ws-dialog-title").textContent, "Add local workspace", "the refusal stands; onboarding is not entered on its own");
  const setupButton = document.querySelector(".ws-pick-setup");
  assert.equal(setupButton.textContent, "Set up a new deployment here…");
  assert.equal(document.activeElement, setupButton);
  setupButton.click();
  assert.equal(document.getElementById("ws-dialog-title").textContent, "Onboard workspace");
  assert.equal(document.querySelector(".ws-onboard-path").textContent, "/home/empty");
  assert.equal(document.querySelector(".ws-pick").hidden, true);
  dom.window.close();
});

test("a new Browse or reopening the dialog clears the previous refusal's choices", async () => {
  let answer = { ok: false, code: "not-a-workspace", reason: REFUSAL, path: "/p", choices: [{ path: "/p/a", name: "a", kind: "inside" }] };
  const { dom, document, controller } = setup({ pickWorkspace: async () => answer });
  controller.begin()(B, [B]);
  await controller.openModal();
  document.getElementById("ws-browse").click(); await settle();
  assert.equal(document.querySelectorAll(".ws-pick-choice").length, 1);
  answer = { ok: false, code: "cancelled", reason: "cancelled" };
  document.getElementById("ws-browse").click(); await settle();
  assert.equal(document.querySelectorAll(".ws-pick-choice").length, 0); assert.equal(document.querySelector(".ws-pick").hidden, true);
  answer = { ok: false, code: "not-a-workspace", reason: REFUSAL, path: "/p", choices: [{ path: "/p/a", name: "a", kind: "inside" }] };
  document.getElementById("ws-browse").click(); await settle();
  document.getElementById("ws-cancel").click();
  await controller.openModal();
  assert.equal(document.querySelectorAll(".ws-pick-choice").length, 0);
  dom.window.close();
});

// The shell hands the switcher the bridge's Remove (#1390): without it the Add dialog's stale rows have none.
test("the shell gives the switcher the bridge's workspaceRemoveListed as removeListed", () => {
  const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const call = source.slice(source.indexOf("const workspaceLabel = createWorkspaceSwitcher({"));
  assert.match(call.slice(0, call.indexOf("\n});")), /\n\s*removeListed: desktopBridge\.workspaceRemoveListed \|\| null,/);
});

test("#1879: above the tested bound a stale row's Remove is held back with the notice, and comes back when the CLI is within the bound", async (t) => {
  const cs = await import("../renderer/views/cli-status.mjs");
  const cli = (extra = {}) => ({ ok: true, bin: "/oats", version: "0.70.1", source: "path", required: { desktopApi: 1, range: ">=0.26.0, tested through 0.69" }, tried: [], features: [], ...extra });
  let probe = cli({ aboveTested: true, testedThrough: "0.69" });
  const cliCtx = { api: async () => probe };
  await cs.refreshCli(cliCtx);
  t.after(() => cs.resetCliStateForTests());
  const s = staleSetup([listed("gone", "missing")]);
  await s.controller.openModal();
  const notice = cs.cliHeldBack("main deployments remove");
  assert.match(notice, /^This Desktop was tested with oats CLIs up to 0\.69; the installed CLI is 0\.70\.1\. /);
  assert.equal(s.removeOf("gone").disabled, true);
  assert.equal(s.removeOf("gone").title, notice);
  s.removeOf("gone").click(); await settle();
  assert.deepEqual(s.calls.removed, [], "nothing is asked of main");
  probe = cli({ version: "0.69.25" });
  await cs.refreshCli(cliCtx);
  assert.equal(s.removeOf("gone").disabled, false);
  assert.equal(s.removeOf("gone").title, "Remove gone from this computer's list. Nothing on disk changes.");
  probe = cli({ aboveTested: true, testedThrough: "0.69" });
  await cs.refreshCli(cliCtx);
  assert.equal(s.removeOf("gone").disabled, true, "and held back again");
  s.controller.dispose(); s.dom.window.close();
});
