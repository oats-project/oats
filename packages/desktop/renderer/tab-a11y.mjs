// Semantic tab chrome and keyboard policy, isolated so ARIA relationships and
// roving-navigation behavior are covered without booting the whole shell.
import { iconElement } from "./shell-icons.mjs";
import { getBinding, formatChord } from "./keybindings.mjs";
import { revealInStrip } from "./reveal-in-scrollport.mjs";
/** Decorative icon by tab kind (the accessible name is the bare title). */
const KIND_ICONS = Object.freeze({ file: "file", brain: "brain" });
/** How many characters a shrunk tab keeps from the end of its name. */
export const TAB_TAIL_CHARS = 8;
/** Where a terminal tab's name splits into a head that ellipsizes and a tail
 * that always shows (spec F return: shrunk tabs stay distinguishable). Names
 * share long prefixes (the soul), so end truncation would leave every shrunk
 * tab reading "oats-…": the tail keeps the last TAB_TAIL_CHARS characters, or
 * the part after the soul's own prefix when that is shorter, without a leading
 * separator. null when there is nothing worth splitting. */
export function tabNameTailStart(name, soul = "") {
  name = String(name ?? ""); soul = typeof soul === "string" ? soul : "";
  let start = Math.max(0, name.length - TAB_TAIL_CHARS);
  if (soul && name.startsWith(`${soul}-`)) start = Math.max(start, soul.length + 1);
  while (start < name.length && /[-_.\s]/.test(name[start])) start++;
  return start > 0 && start < name.length ? start : null;
}

// A trigger's tooltip has three parts, each kept by its own writer: the tab's name (createTabChrome),
// the key that goes to the tab (numberTabStrips, tab-numbers.mjs: "Alt+3", "⌥⌘3") and a note on its
// own line (shell.mjs syncTabNeedsInput: "Needs input: …"). Each writer sets only its part, and the
// title is rebuilt from all three, so no writer puts back a part another has since changed.
const titleParts = new WeakMap();
/** Set some of a tab trigger's tooltip parts ({ name, key, note }; null clears key or note) and write
 * the title they make: "name (key)\nnote". A trigger not drawn by createTabChrome starts from its
 * own title as the name. */
/** Retitle a tab (slice 6a: a Details tab follows its agent, a page tab its page): its label, its accessible name
 * and its tooltip's name. */
export function retitleTab(trigger, title) {
  const label = trigger.querySelector(".tab-label");
  if (label) { label.classList.remove("split"); label.textContent = title; }
  trigger.setAttribute("aria-label", title);
  setTabTitle(trigger, { name: title });
}
export function setTabTitle(trigger, parts) {
  const own = titleParts.get(trigger) ?? { name: trigger.title, key: null, note: null };
  Object.assign(own, parts);
  titleParts.set(trigger, own);
  const title = `${own.name}${own.key ? ` (${own.key})` : ""}${own.note ? `\n${own.note}` : ""}`;
  if (trigger.title !== title) trigger.title = title;
}

/** decor (all decorative; the accessible name stays the bare title):
 *  { kind } or { icon } an app icon for artifact tabs; { dot, detail } a
 *  live-state dot and the instance branch for terminal tabs (Redesign v3);
 *  { color } the instance's colour on that dot, a palette name (instance-dot.mjs);
 *  { tailAt, tailEnd } splits the title: a head that ellipsizes, the tail
 *  [tailAt, tailEnd) that never shrinks (tabNameTailStart), then any rest of
 *  the title (a remote tab's " · host"), which gives way before the head.
 *  Every trigger ends with an empty, hidden .tab-num: the tab's go-to-tab
 *  number, which numberTabStrips (tab-numbers.mjs) fills in once the tab is in
 *  its strip; decorative too, and the tooltip names the key that number stands
 *  for (setTabTitle). */
export function createTabChrome(document, id, title, isMac = false, decor = {}) {
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.setAttribute("role", "presentation");

  const triggerEl = document.createElement("button");
  triggerEl.type = "button";
  triggerEl.className = "tab-trigger";
  triggerEl.id = `tab-${id}`;
  triggerEl.setAttribute("role", "tab");
  triggerEl.setAttribute("aria-selected", "false");
  triggerEl.setAttribute("aria-controls", `tabpanel-${id}`);
  triggerEl.tabIndex = -1;
  const { dot = null, detail = null } = decor || {};
  const icon = decor?.icon ?? KIND_ICONS[decor?.kind] ?? null;
  if (dot) {
    const mark = document.createElement("span"); mark.className = `tab-dot ${dot === "on" ? "on" : "off"}`; mark.setAttribute("aria-hidden", "true");
    // The instance's colour (instance-dot.mjs): a palette name, set on the dot the shell's roster sync keeps current.
    if (typeof decor.color === "string" && decor.color) mark.dataset.instanceColor = decor.color;
    triggerEl.append(mark);
  }
  else if (icon) { const mark = document.createElement("span"); mark.className = "tab-icon"; mark.setAttribute("aria-hidden", "true"); mark.append(iconElement(document, icon, { size: 14 })); triggerEl.append(mark); }
  const label = document.createElement("span"); label.className = "tab-label"; triggerEl.append(label);
  const tailAt = decor?.tailAt;
  const tailEnd = Number.isInteger(decor?.tailEnd) ? Math.min(decor.tailEnd, title.length) : title.length;
  if (Number.isInteger(tailAt) && tailAt > 0 && tailAt < tailEnd) {
    // The head ellipsizes, the tail keeps its width: "oats-…palette". Only the
    // name's own tail is protected; whatever follows it (" · host") is metadata
    // that shrinks first. The trigger's aria-label is the whole title, so the
    // split is never read.
    const span = (className, text) => { const el = document.createElement("span"); el.className = className; el.textContent = text; return el; };
    label.classList.add("split");
    label.append(span("tab-head", title.slice(0, tailAt)), span("tab-tail", title.slice(tailAt, tailEnd)));
    if (tailEnd < title.length) label.append(span("tab-rest", title.slice(tailEnd)));
  } else label.textContent = title;
  if (typeof detail === "string" && detail) {
    const extra = document.createElement("span"); extra.className = "tab-detail"; extra.setAttribute("aria-hidden", "true");
    extra.textContent = detail; triggerEl.append(extra);
  }
  // The go-to-tab number, last and empty: tab-numbers.mjs numbers each strip's tabs.
  const num = document.createElement("span"); num.className = "tab-num"; num.setAttribute("aria-hidden", "true"); num.hidden = true;
  triggerEl.append(num);
  setTabTitle(triggerEl, { name: title });
  triggerEl.setAttribute("aria-label", title);

  const closeEl = document.createElement("button");
  closeEl.type = "button";
  closeEl.className = "close";
  closeEl.append(iconElement(document, "close", { size: 13 }));
  closeEl.setAttribute("aria-label", `Close ${title}`);
  // The chord half is the keymap's tabs.close on this platform (⌘W / Alt+W), or none when unbound.
  const chord = getBinding("tabs.close", isMac);
  closeEl.title = `Close ${title} (${chord ? `Delete or ${formatChord(chord, isMac)}` : "Delete"})`;
  tabEl.append(triggerEl, closeEl);
  // Arrow/Home/End navigation focuses the trigger; Tab can focus Close. Reveal
  // the focused control in its strip (flat or group: the tab's parent at focus
  // time) without focusing content; only the strip scrolls, never an ancestor.
  // Reveal the control, not the wrapper, which may be wider than a narrow group.
  for (const control of [triggerEl, closeEl]) {
    control.addEventListener("focus", () => revealInStrip(tabEl.parentElement, control));
  }

  const paneEl = document.createElement("div");
  paneEl.className = "tab-pane";
  paneEl.id = `tabpanel-${id}`;
  paneEl.setAttribute("role", "tabpanel");
  paneEl.setAttribute("aria-labelledby", triggerEl.id);
  paneEl.hidden = true;
  return { tabEl, triggerEl, closeEl, paneEl };
}

export function tabKeyAction(event, index, count) {
  const key = event.key;
  // Delete closes the focused tab. The close chord (⌘W / Alt+W) is the keymap's
  // tabs.close, never hard-coded here: a rebind or unbind must hold on the strip too (spec F).
  if (key === "Delete" && !event.metaKey && !event.ctrlKey && !event.altKey) return { type: "close" };
  if (!count || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return null;
  if (key === "ArrowRight") return { type: "move", index: (index + 1) % count };
  if (key === "ArrowLeft") return { type: "move", index: (index - 1 + count) % count };
  if (key === "Home") return { type: "move", index: 0 };
  if (key === "End") return { type: "move", index: count - 1 };
  return null;
}

/** Restore focus after the focused final tab is removed. The shell chooses the
 * logical destination (the roster's current row for terminals, active nav for an
 * artifact's restored stage); this function performs the testable DOM move. */
export function focusAfterLastTab(kind, { instancesEntry, stageEntry }) {
  const target = kind === "terminal" ? instancesEntry : stageEntry;
  if (!target || typeof target.focus !== "function") return false;
  target.focus();
  return target.ownerDocument?.activeElement === target;
}
