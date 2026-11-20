// oats desktop — shared overlay picker machinery (command palette family).
// One input over a fuzzy-filtered listbox: type-to-filter, ArrowUp/Down,
// Enter runs the active row, Esc/backdrop closes. Extracted from palette.mjs
// so Quick Open (⌘P / Alt+P) and the palette (⌘K / Alt+K) share ONE overlay + fuzzy
// implementation instead of duplicating chrome, a11y roles, and the
// stale-load generation guard. The fuzzy matcher both filter with is the
// shared home's subsequenceScore (packages/client/subsequence-score.mjs).
import { captureFocusReturn } from "./focus-return.mjs";
import { revealInScrollport } from "./reveal-in-scrollport.mjs";
import { icon } from "./shell-icons.mjs";
import { treeGuides } from "./instance-tree-view.mjs";
import { SOUL_COLORS } from "../../client/soul-colors.mjs";
import { SHEET, SHEET_BACKDROP } from "./sheet.mjs";

let nextPickerId = 0;
// A document has one picker lifetime, not a stack of modal focus traps.
// During activation only opener provenance survives (never DOM/listeners that
// trap focus), so a callback can hand off to another picker even after an await.
const pickerDocuments = new WeakMap();

// Native browser choosers participate in the same focus handoff without
// keeping an underlying palette modal mounted. Consuming never focuses.
export function takePickerFocusReturn(doc) {
  const coordinator = pickerDocuments.get(doc);
  const opener = coordinator?.current?.opener ?? coordinator?.handoff?.opener ?? captureFocusReturn(doc);
  coordinator?.current?.dismiss(false);
  coordinator?.handoff?.release();
  return opener;
}

/** A dialog outside the picker family joins the same handoff while it may be replaced: a picker or dialog
 * that opens over it (through takePickerFocusReturn) takes its opener and dismisses it without returning
 * focus. The returned release leaves the handoff, unless a later holder has taken it. */
export function joinPickerFocusReturn(doc, { opener, dismiss }) {
  if (!pickerDocuments.has(doc)) pickerDocuments.set(doc, { current: null, handoff: null });
  const coordinator = pickerDocuments.get(doc), lifetime = { opener, dismiss };
  coordinator.current = lifetime;
  return () => { if (coordinator.current === lifetime) coordinator.current = null; };
}

/**
 * @param {object} spec
 * @param {string} spec.placeholder     input placeholder text
 * @param {string} spec.ariaLabel       dialog + input accessible name
 * @param {() => Promise<any>} spec.loadItems  async data source; resolves to
 *        the picker's backing data (shape is the caller's — computeRows gets
 *        it verbatim). A load that resolves after the picker was closed or
 *        reopened must not paint (generation-guarded here).
 * @param {(data: any, query: string) => Array<{label: string, detail?: string,
 *          dot?: boolean|null, state?: "running"|"stopped"|"unknown", run?: Function,
 *          depth?: number, connectors?: Array<{kind: string, level: number}>, under?: string,
 *          sibling?: string, group?: {key: string, label: string},
 *          context?: boolean}>} spec.computeRows
 *        query → result rows, already scored/sorted/sliced by the caller.
 *        A row with `state` draws the sidebar's state dot (`ctx-dot on|off|unknown`), in `color` when it has one
 *        (a palette name: instance-dot.mjs);
 *        else `dot` draws the small running dot, and a row with neither (a
 *        command) the chevron.
 *        Optional tree shape (the palette's instances): consecutive rows sharing
 *        a group.key sit in one role=group named by group.label; depth indents
 *        (visual only); `connectors` (treeConnectors' answer) draws the sidebar's
 *        lines through the row with the sidebar's own builder (treeGuides) and
 *        rules, the row taking the sidebar's indent and dot column (`.tree`);
 *        `under`, then `sibling`, are visually hidden text read once with the
 *        option (the lines show them); a render starts on the first
 *        selectable row (the palette opens at the top of its list, #1391);
 *        a `context` row is shown dimmed with aria-disabled="true" and is never
 *        active, so the arrows, the cycle chord and pointer hover skip it.
 *        Async run callbacks must return their promise to carry the original
 *        cancellation opener across awaits; rejections are logged, not focused.
 *        Callbacks still own their destination's async selection/intent guards.
 * @param {(e: KeyboardEvent) => (1|-1|0)} [spec.cycleKey] the picker's own
 *        opening chord while it is open: 1 moves the active row down, -1 up,
 *        both wrapping and skipping context rows; it never commits (Enter does).
 *        With it, toggle() on an open picker cycles down instead of closing.
 * @param {(e: KeyboardEvent) => (1|-1|0)} [spec.groupKey] the picker's group keys while
 *        it is open (the palette's: Quick Open has none): 1 moves the active row to the first
 *        selectable row of the next run of rows (consecutive rows sharing a group.key, or
 *        consecutive rows with no group: one run), -1 to that of the run before; both skip a
 *        run with no selectable row and wrap, a single run's first selectable row is where both
 *        go, and with no selectable row nothing moves. It never commits. Taken before
 *        everything else, cycleKey included, so it wins over every binding while open.
 * @param {string} [spec.footer] a line of plain text under the list (`.palette-footer`):
 *        the palette names its group keys there. It is the input's description
 *        (aria-describedby), read once as the picker opens: the focus never leaves
 *        the combobox, so it is never reached otherwise. None, no footer.
 * @param {Document} [spec.doc]
 * @returns {{ open: Function, close: Function, toggle: Function }} Opening
 *        replaces any other picker in this Document without returning focus.
 */
export function createOverlayPicker({ placeholder, ariaLabel, loadItems, computeRows, cycleKey = null, groupKey = null, footer = "", doc = globalThis.document }) {
  // IDs belong to the picker, not a render or a data-derived label. Result
  // slots keep their IDs across selection updates and cannot collide with a
  // second picker (including a palette → Quick Open handoff).
  const id = `overlay-picker-${++nextPickerId}`;
  if (!pickerDocuments.has(doc)) pickerDocuments.set(doc, { current: null, handoff: null });
  const coordinator = pickerDocuments.get(doc);
  let overlay = null;
  let gen = 0; // load generation — a stale item list must not paint over a newer open
  let hide = null;
  let cycle = null; // the open lifetime's cycle(direction), for toggle()

  function close() { hide?.(true); }

  /** `query`: the input's text to open with (the palette's "+" for its souls group: Alt+P, slice 4). */
  async function open({ query = "" } = {}) {
    if (overlay) return;
    const myGen = ++gen;
    const opener = coordinator.current?.opener ?? coordinator.handoff?.opener ?? captureFocusReturn(doc);
    // Transfer the original non-picker opener before removing the old input.
    // Shortcut replacement must dismiss without any intermediate focus return.
    coordinator.current?.dismiss(false);
    coordinator.handoff?.release();
    const root = doc.createElement("div");
    overlay = root;
    const owns = () => myGen === gen && overlay === root && coordinator.current === lifetime;
    // A centred sheet over the scrim, with the sheet's ease (the Desktop UI rework, slice 4, D10: the palette is a sheet).
    root.className = `palette-overlay ${SHEET_BACKDROP}`;
    root.innerHTML = `
      <div class="palette ${SHEET}" role="dialog" aria-modal="true">
        <input class="palette-input" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" autocomplete="off" spellcheck="false">
        <div class="palette-list" role="listbox"></div>
      </div>`;
    const dialog = root.querySelector(".palette");
    dialog.id = `${id}-dialog`;
    dialog.setAttribute("aria-label", ariaLabel);
    const input = root.querySelector(".palette-input");
    input.id = `${id}-input`;
    input.placeholder = placeholder;
    input.value = String(query);
    input.setAttribute("aria-label", ariaLabel);
    input.setAttribute("aria-expanded", "true");
    const list = root.querySelector(".palette-list");
    list.id = `${id}-list`;
    list.setAttribute("aria-label", `${ariaLabel} results`);
    input.setAttribute("aria-controls", list.id);
    if (footer) {
      const line = doc.createElement("div");
      line.id = `${id}-footer`;
      line.className = "palette-footer";
      line.textContent = footer;
      dialog.append(line);
      input.setAttribute("aria-describedby", line.id);
    }

    const dismiss = (restoreFocus) => {
      if (!owns()) return;
      ++gen;
      overlay = null;
      hide = null;
      cycle = null;
      coordinator.current = null;
      doc.removeEventListener("keydown", modalKeydown, true);
      doc.removeEventListener("focusin", containFocus);
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      root.remove();
      if (restoreFocus) opener.restore();
    };
    const lifetime = { opener, dismiss };
    coordinator.current = lifetime;
    hide = dismiss;

    function modalKeydown(e) {
      if (!owns()) return;
      // Before the keymap engine sees it: the picker's group keys jump between
      // runs of rows, first, and its own chord cycles rows, instead of reopening,
      // closing, running another action or reaching a terminal.
      const toGroup = groupKey?.(e) || 0;
      const direction = toGroup ? 0 : cycleKey?.(e) || 0;
      if (toGroup) {
        e.preventDefault(); e.stopPropagation(); jump(toGroup);
      } else if (direction) {
        e.preventDefault(); e.stopPropagation(); move(direction, true);
      } else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); dismiss(true);
      } else if (e.key === "Tab") {
        // This editable combobox is the modal's only tab stop; options use
        // virtual focus, never individual tab stops. Cover Shift-Tab too.
        e.preventDefault(); e.stopPropagation(); input.focus();
      }
    }
    function containFocus(e) {
      if (owns() && !root.contains(e.target)) input.focus();
    }
    const outsideDismiss = (e) => {
      if (owns() && e.target === root) {
        // Do not let the pointer's default focus action undo focus return.
        e.preventDefault(); dismiss(true);
      }
    };
    root.addEventListener("mousedown", outsideDismiss);
    root.addEventListener("click", outsideDismiss);
    doc.body.append(root);
    doc.addEventListener("keydown", modalKeydown, true);
    doc.addEventListener("focusin", containFocus);
    input.focus();

    let data = null;
    let items = [];   // current result rows: { label, detail, dot, run, ... }
    let options = []; // the option element of each row, in row order
    let active = 0;
    const selectable = (i) => !!items[i] && !items[i].context;
    /** The next selectable row from `active` in `direction`: wrapping for the
     * cycle chord, clamped for the arrows; context rows are never landed on. */
    const step = (direction, wrap) => {
      for (let n = 1; n <= items.length; n++) {
        let i = active + direction * n;
        if (wrap) i = (i + items.length) % items.length;
        else if (i < 0 || i >= items.length) break;
        if (selectable(i)) return i;
      }
      return active;
    };
    function move(direction, wrap = false) {
      if (!items.length || !selectable(active)) return;
      active = step(direction, wrap); select();
    }
    cycle = (direction) => { if (owns()) move(direction, true); };
    /** The first selectable row of the next run of rows in `direction` that has one, wrapping:
     * a run is consecutive rows sharing a group key (rows with no group are one run too). The
     * current run is reached last, so with a single run both directions go to its first row. */
    function jump(direction) {
      if (!items.length || !selectable(active)) return;
      const runs = []; // [first, end) of each run, in row order
      items.forEach((it, i) => {
        if (i > 0 && it.group?.key === items[i - 1].group?.key) runs.at(-1)[1] = i + 1;
        else runs.push([i, i + 1]);
      });
      const current = runs.findIndex(([first, end]) => active >= first && active < end);
      for (let n = 1; n <= runs.length; n++) {
        const [first, end] = runs[(((current + direction * n) % runs.length) + runs.length) % runs.length];
        for (let i = first; i < end; i++) if (selectable(i)) { active = i; select(); return; }
      }
    }

    const activate = (it) => {
      if (!owns()) return;
      // The callback owns destination focus, synchronously or later. Preserve
      // only its cancellation return target until a picker consumes it, focus
      // moves elsewhere, or the callback settles. Never focus the opener here.
      dismiss(false);
      const release = () => {
        if (coordinator.handoff === handoff) coordinator.handoff = null;
        doc.removeEventListener("focusin", release);
      };
      const handoff = { opener, release };
      coordinator.handoff = handoff;
      doc.addEventListener("focusin", release);
      try {
        const result = it.run();
        if (result && typeof result.then === "function") {
          Promise.resolve(result).then(release, (error) => {
            release(); // stale success AND rejection cannot clear a newer handoff
            console.error("Picker activation failed", error);
          });
        } else release();
      } catch (error) {
        release();
        throw error;
      }
    };
    const select = () => {
      input.removeAttribute("aria-activedescendant");
      options.forEach((row, i) => {
        const on = i === active && selectable(i);
        row.classList.toggle("active", on);
        row.setAttribute("aria-selected", String(on));
        if (on) input.setAttribute("aria-activedescendant", row.id);
      });
      // Only the list scrolls (never the overlay or the shell behind it).
      if (selectable(active)) revealInScrollport(list, options[active]);
    };
    const render = () => {
      if (!owns()) return;
      input.removeAttribute("aria-activedescendant");
      list.innerHTML = "";
      options = [];
      if (!items.length) {
        const d = doc.createElement("div");
        d.className = "palette-empty";
        d.textContent = "No matches.";
        list.append(d);
        return;
      }
      let group = null; // the role=group of the current run of rows sharing a group key
      items.forEach((it, i) => {
        const row = doc.createElement("div");
        row.id = `${id}-option-${i}`;
        row.className = "palette-item";
        row.setAttribute("role", "option");
        // The sidebar's state dot for an instance (unknown liveness included); else the small dot or a command's chevron.
        // Its colour, a palette name only (instance-dot.mjs dotColor), never markup.
        const colored = it.state && typeof it.color === "string" && SOUL_COLORS.includes(it.color) ? ` data-instance-color="${it.color}"` : "";
        const dot = it.state ? `<span class="ctx-dot ${it.state === "running" ? "on" : it.state === "stopped" ? "off" : "unknown"}"${colored} aria-hidden="true"></span>`
          : it.dot != null ? `<span class="pdot${it.dot ? " on" : ""}" aria-hidden="true"></span>` : `<span class="picon" aria-hidden="true">${icon("chevronRight", { size: 13 })}</span>`;
        row.innerHTML = `${dot}<span class="plabel"></span><span class="pdetail"></span>`;
        row.querySelector(".plabel").textContent = it.label;
        row.querySelector(".pdetail").textContent = it.detail || "";
        if (Number.isInteger(it.depth) && it.depth > 0) row.style.setProperty("--depth", String(it.depth));
        // A tree row: the sidebar's lines (its builder, its shell.css rules), on the sidebar's dot column.
        if (Array.isArray(it.connectors)) { row.classList.add("tree"); row.prepend(treeGuides(doc, it.connectors)); }
        for (const phrase of [it.under, it.sibling].filter(Boolean)) {
          const read = doc.createElement("span");
          read.className = "sr-only"; read.textContent = `, ${phrase}`;
          row.querySelector(".pdetail").append(read); // read as one phrase with the detail
        }
        // A match's ancestor, shown for its place in the tree: never active or run.
        if (it.context) { row.classList.add("context"); row.setAttribute("aria-disabled", "true"); }
        const inList = () => row.parentNode === list || row.parentNode?.parentNode === list;
        // Keep DOM focus in the combobox, but activate via click so keyboard/
        // assistive-technology synthesized clicks work without mousedown.
        row.addEventListener("mousedown", (e) => { e.preventDefault(); });
        row.addEventListener("click", () => { if (inList() && selectable(i)) activate(it); });
        row.addEventListener("mousemove", () => {
          if (owns() && inList() && active !== i && selectable(i)) {
            active = i; select(); // do not replace the row between pointer down/up
          }
        });
        if (!it.group) group = null;
        else if (group?.dataset.group !== it.group.key) {
          group = doc.createElement("div");
          group.className = "palette-group";
          group.setAttribute("role", "group");
          group.setAttribute("aria-label", it.group.label);
          group.dataset.group = it.group.key;
          list.append(group);
        }
        (group || list).append(row);
        options.push(row);
      });
      select();
    };

    const update = () => {
      if (!owns()) return;
      items = computeRows(data, input.value);
      active = Math.max(0, items.findIndex((it) => !it.context));
      render();
    };

    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => {
      if (!owns()) return;
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (selectable(active)) activate(items[active]);
      }
    });

    list.innerHTML = '<div class="palette-empty">Loading…</div>';
    let loaded;
    try { loaded = await loadItems(); } catch { loaded = null; }
    // Success AND rejection use the same ownership check. close() tears down
    // this mounted overlay; a later open() starts a fresh lifetime.
    if (!owns()) return;
    data = loaded;
    update();
  }

  // A cycling picker's chord moves its rows while open (modalKeydown consumes it
  // first); toggle() — the same action from anywhere else — agrees.
  return { open, close, isOpen: () => !!overlay, toggle: (options) => (!overlay ? open(options) : cycleKey ? cycle?.(1) : close()) };
}
