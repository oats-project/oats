/** Keyboard-accessible lifecycle actions, independent of terminal liveness. Which acts a row offers, and
 * why it offers none or fewer, is decided by packages/client/instance-acts.mjs; this module draws that answer
 * as the roster row's context menu (#1559: a right-click, Shift+F10 or the Menu key on the row, as the
 * workspace row's is; no button is drawn for it): its labels and icons, the caller's own items in front, and
 * why it opens nothing while it is held (an act in flight, a stale roster, a blocked row). */
import { instanceId } from "../../client/instance-tree.mjs";
import { desktopActs } from "./desktop-acts.mjs";
import { iconElement } from "./shell-icons.mjs";
import { reasonLine } from "./speaker-line.mjs";
import { keymapTakes } from "./keybindings.mjs";
import { whenRightButtonReleased } from "./context-menu-release.mjs";
/** The menu's words for each act instanceActs can list. */
const LABELS = Object.freeze({ inspect: 'Knowledge & capabilities…', start: 'Start…', restart: 'Restart with…', stop: 'Stop…', retire: 'Retire instance…', forget: 'Forget…' });
/** Decorative menu icons (the Redesign's context menu), keyed by action. */
// Move to background / out of it (#1579; instance-background-menu.mjs): the section's layers.
const MENU_ICONS = Object.freeze({ 'open-split': 'splitRight', 'open-pr': 'pullRequest', 'background-on': 'layers', 'background-off': 'layers',
  inspect: 'knowledge', start: 'start', restart: 'refresh', stop: 'stop', retire: 'remove', forget: 'close' });

const pending = new Map(); // instance key -> { reason } while an act of its menu runs
/** A menu label without its trailing ellipsis, for prose ("Knowledge & capabilities…" → "Knowledge & capabilities"). */
const plainLabel = label => String(label).replace(/…$/, '');

/** Why `instance`'s menu, drawn for `scope`, waits now (an act of it in flight), or null. Keyed as the menu
 * keys it (scope, identity, incarnation), so a shortcut for the same act is held while the row is filtered
 * or collapsed away too. */
export function pendingActionReason(scope, instance) {
  if (!instance) return null;
  return pending.get(JSON.stringify([scope, instanceId(instance), instance.createdAt ?? null]))?.reason ?? null;
}

/** Preserve an open menu through the roster's periodic DOM rebuild: reopened where it was, on the item it was on. */
export function captureInstanceActionMenu(root) {
  const open = root.querySelector('[data-instance-menu-open="true"]');
  const key = open?.dataset.instanceMenu;
  const action = root.ownerDocument.activeElement?.dataset.action;
  const place = open ? { left: open.style.left, top: open.style.top } : null;
  return () => {
    if (!key) return;
    const menu = [...root.querySelectorAll("[data-instance-menu]")].find((m) => m.dataset.instanceMenu === key);
    menu?.openActionMenu(action, place);
  };
}

/** The context menu of `row` (the roster row's button, its invoker): the menu element, for the caller to place
 * beside the row. It opens on the row's `contextmenu` (a right-click, Shift+F10, the Menu key), at its point when
 * the event falls on the row (a right-click's pointer; Chromium gives a key's the focused row's centre), else under the row,
 * on its first act; a right-click's once released (context-menu-release.mjs). Esc or Tab close it back on the row.
 * `report(headline, { detail?, action, instance })` says an action didn't finish: a plain headline, the error text as `detail`.
 * `say(line)` says why the menu opens nothing (it is held: an act of it in flight, `stale`, a blocked row): one line,
 * announced, and the focus stays on the row. `stale`: the roster's stale reason while it is stale, else null.
 * `openForget(instance)` (#1131): given, a row its host no longer lists (instanceActs answers it `blocked`, key `missing`) offers "Forget…"
 * alone, which opens that confirmation; without it such a row offers nothing, as every unaddressable row. */
export function instanceActions(doc, instance, { row, invoke, openLifecycle, openForget, done = () => {}, report = () => {}, say = () => {}, stale = null,
  scope = '', owner = () => true, extra = [], dispatch, onMenuState = () => {}, onFocusChange = () => {}, shortcut = () => '' }) {
  const key = JSON.stringify([scope, instanceId(instance), instance.createdAt ?? null]);
  const owns = () => { try { return owner(); } catch { return false; } };
  const visible = element => {
    if (!element?.isConnected) return false;
    for (let el = element; el; el = el.parentElement) {
      const style = doc.defaultView?.getComputedStyle(el);
      if (el.hidden || el.inert || el.hasAttribute('inert') || style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  };
  const menu = doc.createElement("div"); menu.className = "ctx-instance-menu"; menu.tabIndex = -1;
  menu.setAttribute("popover", "auto"); menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `Actions for ${instance.instance}`);
  menu.dataset.instanceMenu = key;
  const items = [];
  const reasonFor = action => { const row = descriptors.find(item => item.action === action); return typeof row?.reason === 'function' ? row.reason() : row?.reason || ''; };
  const syncOptions = () => {
    for (const item of items) {
      const reason = reasonFor(item.dataset.action), note = item.querySelector('small');
      // An act the shared home lists as not enabled stays so whatever its reason's text shows.
      item.disabled = !!reason || descriptors.find(row => row.action === item.dataset.action)?.unavailable === true;
      if (note) { note.textContent = reason; note.hidden = !reason; }
      item.title = reason;
      item.autofocus = false;
    }
    const first = defaultItem(); if (first) first.autofocus = true;
  };
  // The act the menu opens on: the first enabled one that is not secondary (#1247: a retiring row's Retire stays
  // listed and reachable, never the default). With none, focus lands on the menu itself and the arrows reach it.
  const defaultItem = () => items.find(item => !item.disabled && item.dataset.secondary !== 'true');
  const offer = desktopActs(instance);
  // A remote row the kernel does not report addressable has no actions here; the row says why when asked. The one
  // exception is the Desktop's own: a row its host no longer lists offers Forget… (forget-dialog.mjs).
  const forgets = offer.blocked?.code === 'unaddressable' && offer.blocked.key === 'missing' && typeof openForget === 'function';
  /** Why the menu opens nothing now, or null: a blocked row (a missing one that offers Forget… is not), an act of it in
   * flight, a stale roster. A reason's sentence that is the row's own text is said with who made it (speaker-line.mjs). */
  const heldReason = () => offer.blocked && !forgets ? reasonLine(offer.blocked) || `${instance.instance} can't be used from here.`
    : pending.get(key)?.reason ?? stale ?? null;
  const blocked = () => heldReason() !== null;
  const close = (restoreFocus = false) => {
    menu.hidePopover();
    if (restoreFocus && owns() && visible(row)) row.focus();
  };
  // Where it opens (the workspace row's context menu's rule): at the pointer when a right-click on the row opened it,
  // or wherever else the event says it is on the row (Chromium: a key's, at the focused row's centre); else (no point,
  // or one off the row; a rebuild's reopening with none) under the row's start. Kept inside the window.
  // `at`: { x, y } the pointer, { left, top } where a rebuild found it open, or null (under the row).
  let at = null;
  const position = () => {
    const win = doc.defaultView, size = menu.getBoundingClientRect();
    if (at?.left) { menu.style.left = at.left; menu.style.top = at.top; return; }
    const box = row.getBoundingClientRect(), x = at ? at.x : box.left + 8, y = at ? at.y : box.bottom;
    menu.style.left = `${Math.max(8, Math.min(x, win.innerWidth - size.width - 8))}px`;
    menu.style.top = `${Math.max(8, y + size.height + 8 <= win.innerHeight ? y : y - size.height - (at ? 0 : box.height))}px`;
  };
  const open = (action, place = null) => {
    if (blocked() || !visible(row) || !owns()) return;
    at = place;
    if (menu.dataset.instanceMenuOpen !== "true") menu.showPopover();
    position();
    (items.find((item) => item.dataset.action === action && !item.disabled) || defaultItem() || menu).focus();
  };
  menu.openActionMenu = open;
  // The row's context menu: the page's own, never the native one (main's Copy/Paste); a right-click opens it once
  // released and never activates the row (a secondary button sends no click). A held menu opens nothing and says why.
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const box = row.getBoundingClientRect();
    const atPointer = !!(event.clientX || event.clientY) && event.clientX >= box.left && event.clientX <= box.right
      && event.clientY >= box.top && event.clientY <= box.bottom;
    const place = atPointer ? { x: event.clientX, y: event.clientY } : null;
    whenRightButtonReleased(event, () => {
      if (!owns() || !visible(row)) return;
      const why = heldReason();
      if (why !== null) { say(why); return; }
      open(undefined, place);
    });
  });
  // Native popovers provide top-layer placement and outside-click dismissal.
  // Both native dismissal and explicit close update the menu's state.
  menu.addEventListener("beforetoggle", (event) => {
    const expanded = event.newState === "open";
    if (expanded && (!owns() || blocked() || !visible(row))) { event.preventDefault(); return; }
    if (expanded) syncOptions();
    menu.dataset.instanceMenuOpen = String(expanded);
    for (const item of items) {
      const descriptor = extra.find(row => row.action === item.dataset.action);
      if (descriptor?.actionId) { const hint = item.querySelector('kbd'); hint.textContent = shortcut(descriptor.actionId) || ''; hint.hidden = !hint.textContent; }
    }
    onMenuState(expanded ? { element: menu, owns, run: execute } : null, menu);
    // A native pointer activation can run a microtask checkpoint before the
    // popover's default action makes it measurable. Position before the next
    // paint, when the open menu has its actual width (not a hidden width of 0).
    if (expanded) doc.defaultView.requestAnimationFrame(() => {
      if (owns() && menu.isConnected && menu.dataset.instanceMenuOpen === "true") position();
    });
  });
  menu.addEventListener('focusin', () => { if (menu.isConnected) onFocusChange(); });
  menu.addEventListener('focusout', () => doc.defaultView.queueMicrotask(() => { if (menu.isConnected) onFocusChange(); }));
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Tab") { close(true); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    // An arrow chord the keymap binds (Alt+Shift+↑/↓, ⌘⌥↑/↓: the previous / next instance's terminal; a rebind)
    // is the keymap's, from an item too.
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || keymapTakes(event)) return;
    event.preventDefault(); event.stopPropagation();
    const available = items.filter(item => !item.disabled);
    const current = available.indexOf(doc.activeElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? available.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
    available[index]?.focus();
  });
  async function execute(action) {
    const item = items.find(row => row.dataset.action === action);
    if (!item || !owns() || !visible(row) || !item.isConnected || blocked() || item.disabled || reasonFor(action) || pending.has(key)) return;
    close(true);
    if (action === 'forget') { openForget(instance); return; } // the confirmation sends, never this menu
    if (action === 'stop' || action === 'retire') {
      if (typeof openLifecycle === 'function') openLifecycle(action, instance);
      else report('A plan-backed confirmation is required for Stop or Retire.', { action, instance });
      return; // never fall back to an unguarded invoke('retire')
    }
    const label = plainLabel(descriptors.find(row => row.action === action).label);
    // While it runs, this row's menu (and a menu a rebuild draws for it) opens nothing and says why.
    const entry = { reason: `Waiting for ${label} to finish` };
    pending.set(key, entry);
    try { const result = await invoke(action, instance); if (owns()) done(result, action); }
    catch (error) { if (owns()) report(`${label} didn't finish for ${instance.instance}.`, { detail: String(error?.message || error), action, instance }); }
    finally { if (pending.get(key) === entry) pending.delete(key); }
  }
  // The caller's own items go in front only on a row that offers everything a home normally does: a blocked
  // row has no menu, and a limited one (#802: a home a spawn or a retire left half cleaned; #1247: one being
  // retired, its Retire secondary) offers Retire alone.
  // An act listed with a reason (Start on a row whose session backend is gone) stays visible, disabled, with it.
  const descriptors = forgets ? [{ action: 'forget', label: LABELS.forget }] : [...(offer.blocked || offer.limited ? [] : extra),
    ...offer.acts.map(({ verb, reason, secondary }) => ({ action: verb, label: LABELS[verb], ...(reason ? { reason: reasonLine(reason) ?? '', unavailable: true } : {}),
      ...(secondary ? { secondary: true } : {}) }))];
  for (const descriptor of descriptors) {
    const { action, label, reason, actionId, secondary } = descriptor;
    const item = doc.createElement("button"); item.type = "button"; item.tabIndex = -1;
    item.setAttribute("role", "menuitem"); item.dataset.action = action;
    if (secondary) item.dataset.secondary = 'true';
    const glyph = doc.createElement('span'); glyph.className = 'ctx-menu-icon'; glyph.setAttribute('aria-hidden', 'true');
    if (Object.hasOwn(MENU_ICONS, action)) glyph.append(iconElement(doc, MENU_ICONS[action], { size: 15 }));
    if (action === 'stop') item.classList.add('ctx-menu-lifecycle'); // separator before the lifecycle group
    const copy = doc.createElement('span'); copy.textContent = label; item.append(glyph, copy);
    if (actionId) { const hint = doc.createElement('kbd'); hint.dataset.shortcut = actionId; hint.textContent = shortcut(actionId) || ''; hint.hidden = !hint.textContent; item.append(hint); }
    if (reason !== undefined) { const note = doc.createElement('small'); item.append(note); }
    item.addEventListener('click', () => {
      if (!owns() || !item.isConnected || item.disabled || blocked()) return;
      if (actionId && typeof dispatch === 'function') dispatch(actionId); else void execute(action);
    });
    items.push(item); menu.append(item);
  }
  syncOptions();
  return menu;
}
