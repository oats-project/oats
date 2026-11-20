import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createOverlayPicker } from "../renderer/overlay-picker.mjs";
import { createPalette } from "../renderer/palette.mjs";
import { createSoulPicker as createQuickOpen } from "./helpers/soul-picker.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function setup(t, spec = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button><button id="destination">Destination</button>', { url: "http://localhost" });
  const doc = dom.window.document;
  t.after(() => dom.window.close());
  const opener = doc.getElementById("opener");
  const destination = doc.getElementById("destination");
  const ran = [];
  const rows = ["First", "Second"].map((label) => ({
    label, detail: `${label} detail`, run: () => ran.push(label),
  }));
  const picker = createOverlayPicker({
    placeholder: "Find", ariaLabel: "Test picker", doc,
    loadItems: async () => rows,
    computeRows: (data, query) => (data || []).filter((row) => row.label.includes(query)),
    ...spec,
  });
  t.after(() => picker.close());
  opener.focus();
  const key = (target, key, extra = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    target.dispatchEvent(event);
    return event;
  };
  const mouse = (target, type) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const filter = (input, value) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  return { doc, dom, picker, opener, destination, rows, ran, key, mouse, filter };
}

function selected(doc, input) {
  const id = input.getAttribute("aria-activedescendant");
  assert.ok(id, "the combobox announces its virtually focused option");
  const option = doc.getElementById(id);
  assert.ok(option, "active descendant resolves to a connected node");
  assert.equal(option.getAttribute("role"), "option");
  assert.equal(option.getAttribute("aria-selected"), "true");
  const list = option.closest('[role="listbox"]');
  assert.equal(list?.id, input.getAttribute("aria-controls"));
  // An option sits in the listbox itself or in one of its named groups (the palette's relation groups).
  assert.ok(option.parentNode === list || (option.parentNode.getAttribute("role") === "group"
    && option.parentNode.parentNode === list && option.parentNode.getAttribute("aria-label")));
  assert.deepEqual([...list.querySelectorAll('[aria-selected="true"]')], [option]);
  return option;
}

test("picker exposes a named modal dialog and editable combobox controlling a named listbox", async (t) => {
  const { doc, picker, key, mouse } = setup(t);
  await picker.open();
  const dialog = doc.querySelector('[role="dialog"]');
  const input = doc.querySelector("input");
  const list = doc.querySelector('[role="listbox"]');
  assert.equal(dialog.getAttribute("aria-label"), "Test picker");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(input.getAttribute("role"), "combobox");
  assert.equal(input.getAttribute("aria-label"), "Test picker");
  assert.equal(input.getAttribute("aria-autocomplete"), "list");
  assert.equal(input.getAttribute("aria-haspopup"), "listbox");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(input.readOnly, false);
  assert.equal(input.getAttribute("aria-controls"), list.id);
  assert.equal(list.getAttribute("aria-label"), "Test picker results");
  assert.ok(dialog.contains(input) && dialog.contains(list));
  assert.equal(doc.activeElement, input);
  const options = [...list.children];
  const ids = options.map((row) => row.id);
  assert.equal(selected(doc, input), options[0]);
  assert.match(options[0].textContent, /First.*First detail/);
  assert.ok(options.every((row) => row.tabIndex === -1), "virtual options are not Tab stops");
  key(input, "ArrowDown");
  assert.equal(selected(doc, input), options[1]);
  key(input, "ArrowDown");
  assert.equal(selected(doc, input), options[1], "navigation clamps at the last row");
  key(input, "ArrowUp");
  key(input, "ArrowUp");
  assert.equal(selected(doc, input), options[0], "navigation clamps at the first row");
  mouse(options[1], "mousemove");
  assert.equal(selected(doc, input), options[1]);
  assert.deepEqual([...list.children], options, "selection never detaches pointer targets");
  assert.deepEqual([...list.children].map((row) => row.id), ids);
  assert.equal(doc.activeElement, input, "DOM focus stays on the editable combobox");
});

test("filter and empty states keep active-descendant and selection in sync", async (t) => {
  const { doc, picker, key, filter, ran } = setup(t);
  await picker.open();
  const input = doc.querySelector("input");
  key(input, "ArrowDown");
  filter(input, "First");
  assert.match(selected(doc, input).textContent, /First/);
  filter(input, "absent");
  assert.equal(input.hasAttribute("aria-activedescendant"), false);
  assert.equal(doc.querySelector('[role="option"]'), null);
  assert.match(doc.querySelector(".palette-list").textContent, /No matches/);
  key(input, "ArrowDown");
  key(input, "ArrowUp");
  key(input, "Enter");
  assert.equal(input.hasAttribute("aria-activedescendant"), false);
  assert.deepEqual(ran, []);
  assert.ok(doc.querySelector(".palette-overlay"));
  filter(input, "");
  assert.match(selected(doc, input).textContent, /First/);
  assert.equal(doc.activeElement, input);
});

for (const dismiss of ["Escape", "mousedown", "click", "close", "toggle"]) {
  test(`picker returns focus to its opener on ${dismiss} dismissal`, async (t) => {
    const { doc, picker, opener, key, mouse, ran } = setup(t);
    await picker.open();
    const input = doc.querySelector("input");
    const root = doc.querySelector(".palette-overlay");
    mouse(doc.querySelector(".palette"), "mousedown");
    assert.ok(root.isConnected, "clicking dialog whitespace is not outside dismissal");
    if (dismiss === "Escape") assert.ok(key(input, dismiss).defaultPrevented);
    else if (["mousedown", "click"].includes(dismiss)) assert.ok(mouse(root, dismiss).defaultPrevented);
    else picker[dismiss]();
    assert.equal(root.isConnected, false);
    assert.equal(doc.activeElement, opener);
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
    assert.deepEqual(ran, []);
  });
}

test("Tab and Shift-Tab stay in the modal before/after load, filtering and empty results", async (t) => {
  const load = deferred();
  const { doc, picker, key, filter, rows, destination } = setup(t, { loadItems: () => load.promise });
  const opening = picker.open();
  const input = doc.querySelector("input");
  const trap = () => {
    for (const shiftKey of [false, true]) {
      assert.ok(key(doc.activeElement, "Tab", { shiftKey }).defaultPrevented);
      assert.equal(doc.activeElement, input);
    }
  };
  assert.match(doc.querySelector(".palette-list").textContent, /Loading/);
  assert.equal(input.hasAttribute("aria-activedescendant"), false);
  trap();
  // Synthetic DOM tests cannot simulate the browser's native Tab default, so
  // assert both cancellation and the resulting focus target explicitly.
  input.blur();
  assert.equal(doc.activeElement, doc.body);
  trap();
  destination.focus();
  assert.equal(doc.activeElement, input, "programmatic background focus is contained too");
  load.resolve(rows);
  await opening;
  trap();
  filter(input, "First");
  trap();
  filter(input, "absent");
  trap();
  picker.close();
  destination.focus();
  assert.equal(doc.activeElement, destination, "close removes the focus listener");
  assert.equal(key(destination, "Tab").defaultPrevented, false, "close removes the keyboard trap");
});

test("Escape still dismisses if focus has fallen to body", async (t) => {
  const { doc, picker, opener, key } = setup(t);
  await picker.open();
  doc.querySelector("input").blur();
  key(doc.body, "Escape");
  assert.equal(doc.querySelector(".palette-overlay"), null);
  assert.equal(doc.activeElement, opener);
});

for (const activation of ["Enter", "pointer click", "assistive click"]) {
  test(`${activation} activates once without returning focus before or after the callback`, async (t) => {
    const { doc, picker, opener, destination, rows, key, mouse } = setup(t);
    const completion = deferred();
    let runs = 0, openerFocuses = 0;
    opener.addEventListener("focus", () => { openerFocuses++; });
    rows[1].run = () => {
      runs++;
      assert.equal(doc.querySelector(".palette-overlay"), null, "hide precedes the callback");
      assert.equal(openerFocuses, 0, "no intermediate opener focus during activation");
      destination.focus();
      return completion.promise;
    };
    await picker.open();
    const input = doc.querySelector("input");
    const row = doc.querySelectorAll('[role="option"]')[1];
    if (activation === "Enter") {
      key(input, "ArrowDown");
      key(input, "Enter");
    } else {
      if (activation === "pointer click") {
        assert.ok(mouse(row, "mousedown").defaultPrevented);
        assert.equal(runs, 0, "mousedown preserves input focus, but never activates");
        mouse(row, "mousemove");
        assert.equal(row.isConnected, true, "hover between down/up keeps the click target");
        assert.equal(doc.activeElement, input);
        mouse(row, "mouseup");
      }
      row.click(); // also covers a screen reader's synthesized click without down/up
    }
    assert.equal(runs, 1);
    assert.equal(doc.activeElement, destination);
    completion.resolve();
    await completion.promise;
    assert.equal(openerFocuses, 0);
    assert.equal(doc.activeElement, destination);
    row.click();
    key(input, "Enter");
    picker.close();
    assert.equal(runs, 1, "detached activation events and repeated close are inert");
    assert.equal(doc.activeElement, destination);
  });
}

test("reopen captures the new opener; duplicate open and stale DOM events are inert", async (t) => {
  const { doc, picker, opener, destination, key, mouse, filter, ran } = setup(t);
  await picker.open();
  const oldInput = doc.querySelector("input");
  const oldRoot = doc.querySelector(".palette-overlay");
  const oldRow = doc.querySelector('[role="option"]');
  const ids = [...oldRoot.querySelectorAll("[id]")].map((el) => el.id);
  await picker.open();
  assert.equal(doc.querySelector("input"), oldInput, "open is idempotent while shown");
  picker.close();
  assert.equal(doc.activeElement, opener);
  destination.focus();
  await picker.toggle();
  const newInput = doc.querySelector("input");
  assert.deepEqual([...doc.querySelectorAll(".palette-overlay [id]")].map((el) => el.id), ids, "picker-owned IDs survive reopen");
  oldRow.click();
  mouse(oldRow, "mousemove");
  mouse(oldRoot, "mousedown");
  mouse(oldRoot, "click");
  key(oldInput, "Escape");
  key(oldInput, "Enter");
  filter(oldInput, "absent");
  assert.equal(doc.querySelector("input"), newInput);
  assert.equal(doc.activeElement, newInput);
  assert.deepEqual(ran, []);
  assert.match(selected(doc, newInput).textContent, /First/);
  key(newInput, "Escape");
  assert.equal(doc.activeElement, destination, "reopened picker restores its own opener");
});

test("detached filtered options cannot activate their obsolete rows", async (t) => {
  const { doc, picker, filter, ran } = setup(t);
  await picker.open();
  const oldRow = doc.querySelector('[role="option"]');
  filter(doc.querySelector("input"), "Second");
  oldRow.click();
  assert.deepEqual(ran, []);
  assert.match(selected(doc, doc.querySelector("input")).textContent, /Second/);
});

for (const outcome of ["resolve", "reject"]) {
  test(`closed overlay disposal ignores load ${outcome} and removes listeners`, async (t) => {
    const load = deferred();
    let computes = 0;
    const { doc, picker, rows, destination, key } = setup(t, {
      loadItems: () => load.promise,
      computeRows: (data) => { computes++; return data || []; },
    });
    const opening = picker.open();
    const oldRoot = doc.querySelector(".palette-overlay");
    picker.close(); // the existing API's teardown/disposal operation; reopen remains supported
    const oldHTML = oldRoot.innerHTML;
    destination.focus();
    load[outcome](outcome === "resolve" ? rows : new Error("obsolete failure"));
    await opening;
    assert.equal(computes, 0, "closed loads never call the consumer's row computation");
    assert.equal(oldRoot.innerHTML, oldHTML, "no detached render after disposal");
    assert.equal(doc.querySelector(".palette-overlay"), null);
    assert.equal(doc.activeElement, destination);
    assert.equal(key(destination, "Escape").defaultPrevented, false);
  });

  test(`overlapping reopen ignores older load ${outcome} after the newer load rendered`, async (t) => {
    const older = deferred(), newer = deferred();
    let loads = 0;
    const computed = [];
    const { doc, picker, rows, key } = setup(t, {
      loadItems: () => (++loads === 1 ? older.promise : newer.promise),
      computeRows: (data) => { computed.push(data); return data || []; },
    });
    const oldOpening = picker.open();
    const oldRoot = doc.querySelector(".palette-overlay");
    picker.close();
    const newOpening = picker.open();
    const oldHTML = oldRoot.innerHTML;
    newer.resolve(rows);
    await newOpening;
    const input = doc.querySelector("input");
    key(input, "ArrowDown");
    const currentHTML = doc.querySelector(".palette-overlay").innerHTML;
    older[outcome](outcome === "resolve" ? [{ label: "Obsolete", run() {} }] : new Error("obsolete failure"));
    await oldOpening;
    assert.deepEqual(computed, [rows], "only the owning load invokes computeRows, on success AND rejection");
    assert.equal(oldRoot.innerHTML, oldHTML, "stale load cannot even paint detached DOM");
    assert.equal(doc.querySelector(".palette-overlay").innerHTML, currentHTML);
    assert.match(selected(doc, input).textContent, /Second/);
    assert.equal(doc.activeElement, input);
  });
}

test("owned load rejection still renders an empty state and keeps focus in the modal", async (t) => {
  const { doc, picker, opener, key } = setup(t, { loadItems: async () => { throw new Error("current failure"); } });
  await picker.open();
  const input = doc.querySelector("input");
  assert.match(doc.querySelector(".palette-list").textContent, /No matches/);
  assert.equal(input.hasAttribute("aria-activedescendant"), false);
  assert.equal(doc.activeElement, input);
  assert.ok(key(input, "Tab", { shiftKey: true }).defaultPrevented);
  key(input, "Escape");
  assert.equal(doc.activeElement, opener);
});

test("closing with a detached opener is safe and does not focus an unrelated control", async (t) => {
  const { doc, picker, opener, destination } = setup(t);
  await picker.open();
  let focuses = 0;
  destination.addEventListener("focus", () => { focuses++; });
  opener.remove();
  assert.doesNotThrow(() => picker.close());
  assert.equal(focuses, 0);
  assert.equal(doc.activeElement, doc.body);
});

test("multiple picker instances replace the modal, retain unique IDs and share the original opener", async (t) => {
  const { doc, picker, opener, key } = setup(t);
  const other = createOverlayPicker({
    doc, ariaLabel: "Other picker", placeholder: "Other", loadItems: async () => null,
    computeRows: () => [{ label: "Same label", run() {} }, { label: "Same label", run() {} }],
  });
  t.after(() => other.close());
  await picker.open();
  const firstInput = doc.querySelector("input");
  const firstIds = [...doc.querySelectorAll(".palette-overlay [id]")].map((el) => el.id);
  selected(doc, firstInput);
  await other.open();
  const secondInput = doc.querySelector("input");
  assert.equal(firstInput.isConnected, false, "replacement removes the underlying modal entirely");
  assert.equal(doc.querySelectorAll(".palette-overlay").length, 1);
  const ids = [...firstIds, ...[...doc.querySelectorAll("[id]")].map((el) => el.id)];
  assert.equal(new Set(ids).size, ids.length, "pickers and even equal option labels have unique IDs");
  selected(doc, secondInput);
  assert.equal(doc.activeElement, secondInput);
  firstInput.focus();
  picker.close();
  assert.equal(doc.activeElement, secondInput, "closing the replaced picker never steals focus");
  assert.ok(key(secondInput, "Tab").defaultPrevented);
  key(secondInput, "Escape");
  assert.equal(doc.querySelectorAll(".palette-overlay").length, 0);
  assert.equal(doc.activeElement, opener);
  assert.equal(key(doc.body, "Tab").defaultPrevented, false);
});

test("current callers preserve instance identity, command handoffs and Quick Open selection", async (t) => {
  const { doc, picker, opener, destination, key, filter } = setup(t);
  picker.close();
  const previousDoc = globalThis.document;
  globalThis.document = doc; // createPalette's existing API uses the renderer document
  t.after(() => { globalThis.document = previousDoc; });
  const instance = { instance: "same:name", home: "/exact/home", agentsRoot: "/exact/root", server: "remote", running: true };
  const references = [], souls = [];
  const quickOpen = createQuickOpen({
    doc,
    loadSouls: async () => ({ agents: [{ name: "soul:name", agentsRoot: "/soul/root", work: "attached" }] }),
    onPick: (soul) => { souls.push(soul); destination.focus(); },
  });
  const palette = createPalette({
    loadInstances: async () => [instance],
    openTerminal: (ref) => { references.push(ref); destination.focus(); },
    commands: [{ label: "Souls: quick open…", run: () => quickOpen.open() }],
  });
  t.after(() => { palette.close(); quickOpen.close(); });
  let openerFocuses = 0;
  opener.addEventListener("focus", () => { openerFocuses++; });
  await palette.open();
  let input = doc.querySelector("input");
  assert.equal(input.getAttribute("aria-label"), "Command palette");
  assert.match(selected(doc, input).textContent, /same:name/);
  key(input, "Enter");
  assert.deepEqual(references, [{ instance: "same:name", home: "/exact/home", agentsRoot: "/exact/root", server: "remote" }]);
  assert.equal(doc.activeElement, destination);
  assert.equal(openerFocuses, 0);
  await palette.open();
  input = doc.querySelector("input");
  filter(input, ">souls");
  assert.match(selected(doc, input).textContent, /Souls: quick open/);
  key(input, "Enter");
  await Promise.resolve(); await Promise.resolve(); // settle the Quick Open load invoked by the command
  input = doc.querySelector("input");
  assert.equal(input.getAttribute("aria-label"), "Quick open souls");
  assert.equal(doc.querySelectorAll(".palette-overlay").length, 1);
  assert.equal(doc.activeElement, input, "outgoing picker does not steal the new picker's focus");
  selected(doc, input).click();
  assert.deepEqual(souls, [{ name: "soul:name", agentsRoot: "/soul/root" }]);
  assert.equal(doc.activeElement, destination);
  assert.equal(openerFocuses, 0);
});

test("a row's sibling is read after its under, once; neither is shown (#1383: the lines show them)", async (t) => {
  const rows = [
    { label: "tree", under: "under lead", sibling: "sibling of a and b", run() {} },
    { label: "plain", under: "under lead", run() {} },
  ];
  const { doc, picker } = setup(t, { loadItems: async () => rows, computeRows: (data) => data });
  await picker.open();
  const option = (label) => [...doc.querySelectorAll('[role="option"]')].find((o) => o.querySelector(".plabel").textContent === label);
  const read = (label) => [...option(label).querySelectorAll(".pdetail .sr-only")].map((s) => s.textContent);
  assert.deepEqual(read("tree"), [", under lead", ", sibling of a and b"]);
  assert.deepEqual(read("plain"), [", under lead"]);
  assert.equal(doc.querySelector(".punder"), null, "no quiet relation text");
  for (const label of ["tree", "plain"]) assert.equal(option(label).textContent.split("under lead").length - 1, 1, `${label}: the phrase once`);
});

test("a row with connectors draws the sidebar's guides and tree geometry; a row with state, the sidebar's dot; neither: as before", async (t) => {
  const rows = [
    { label: "lead", state: "running", connectors: [{ kind: "down", level: 0 }], run() {} },
    { label: "kid", state: "unknown", depth: 1, connectors: [{ kind: "elbow", level: 0 }, { kind: "link-through", level: 0 }], run() {} },
    { label: "idle", state: "stopped", run() {} },
    { label: "small", dot: true, run() {} },
    { label: "command", dot: null, run() {} },
  ];
  const { doc, picker } = setup(t, { loadItems: async () => rows, computeRows: (data) => data });
  await picker.open();
  const option = (label) => [...doc.querySelectorAll('[role="option"]')].find((o) => o.querySelector(".plabel").textContent === label);
  const kid = option("kid");
  assert.ok(kid.classList.contains("tree"));
  assert.equal(kid.firstElementChild.className, "ctx-guides");
  assert.equal(kid.firstElementChild.getAttribute("aria-hidden"), "true");
  assert.deepEqual([...kid.querySelectorAll(".ctx-guide")].map((g) => [g.className, g.style.getPropertyValue("--guide-level")]),
    [["ctx-guide elbow", "0"], ["ctx-guide link-through", "0"]]);
  assert.equal(kid.querySelector(".ctx-dot").className, "ctx-dot unknown", "unknown liveness: the unknown dot, not the chevron");
  assert.equal(kid.querySelector(".picon"), null);
  assert.equal(option("lead").querySelector(".ctx-dot").className, "ctx-dot on");
  assert.equal(option("idle").querySelector(".ctx-dot").className, "ctx-dot off");
  assert.ok(!option("idle").classList.contains("tree"), "state alone: no guides, no tree geometry");
  assert.equal(option("idle").querySelector(".ctx-guides"), null);
  assert.equal(option("small").querySelector(".pdot.on")?.getAttribute("aria-hidden"), "true", "a row with neither keeps today's dot");
  assert.ok(option("command").querySelector(".picon"), "and today's chevron");
  assert.equal(option("command").querySelector(".ctx-dot, .ctx-guides"), null);
});
