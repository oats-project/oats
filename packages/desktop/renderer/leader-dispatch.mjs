/* oats desktop — what each leader key, and each sidebar plain key, does (docs/desktop-keyboard.md,
   "The leader" and "Sidebar keys").

   One map from a shared `does` (packages/client/keymap.mjs) to the Desktop's operation, used by
   the leader (after app.leader) and by the sidebar's plain keys (sidebar.key.*), so a key means
   one thing in both. The operations are the shell's (registered actions and the roster's own
   paths), passed in; what is decided here is the part with rules of its own:

   - the target instance: the shell resolves it when the key is pressed (the focused roster row's,
     else the shown terminal tab's, else none);
   - previous / next: from the instance an open still in flight is opening, else from the target
     (the shell's `stepFrom`), so presses faster than an open make as many moves; the roster as
     drawn, rows whose Enter would not open a terminal passed over, no wrap; with none, next opens
     the first openable row and previous the last. They are the chords' (Alt+Shift+↑/↓, ⌥⌘↑/↓) and
     the sidebar's; the leader's ↑ / ↓ are the workspace moves;
   - workspace-previous / workspace-next (the leader's ↑ / ↓): the previous / next workspace of the
     sidebar's list that can be opened, shown in this window as a click on its row shows it (the
     shell's `workspaceStep`, workspace-switcher.mjs `step`); past the last row, the first, and before
     the first, the last; with no other row to show, one line says so;
   - stop / restart / start / retire: the same availability as the row's context menu
     (packages/client/instance-acts.mjs, and the menu's own block while the roster is stale or an
     act is pending); when the menu would not offer it, nothing runs and one line says why;
   - spawn-another: the target's soul, as Quick Open opens it.

   Nothing fails silently: every "nothing runs" says why in one line (`say`). */

import { desktopActs } from "./desktop-acts.mjs";
import { reasonLine } from "./speaker-line.mjs";

export const NO_TARGET = "No instance is focused or selected.";
export const NO_OTHER_WORKSPACE = "No other workspace to show.";

/** The openable row after (`delta` 1) or before (-1) the target, in the order drawn, or null; no
 * wrap. `rows`: [{ id, openable }]. A target that is not drawn counts as none: then 1 is the
 * first openable row and -1 the last. */
export function rosterStep(rows, targetId, delta) {
  const at = targetId == null ? -1 : rows.findIndex((row) => row.id === targetId);
  if (at < 0) return (delta > 0 ? rows : [...rows].reverse()).find((row) => row.openable) ?? null;
  for (let i = at + delta; i >= 0 && i < rows.length; i += delta) if (rows[i].openable) return rows[i];
  return null;
}

const ACT_WORDS = Object.freeze({ stop: "stopped", restart: "restarted", start: "started", retire: "retired" });

/** Would the row's context menu offer `verb` for `instance` now? `{ ok: true }`, or `{ reason }` in
 * one line. `menuReason`: the menu is held (a stale roster, an act pending), and why. */
export function actAvailability(instance, verb, menuReason = null) {
  const name = instance?.instance || "This instance";
  const offer = desktopActs(instance);
  if (offer.blocked) return { reason: reasonLine(offer.blocked) || `${name} can't be ${ACT_WORDS[verb]} from here.` };
  if (menuReason) return { reason: menuReason };
  const act = offer.acts.find((each) => each.verb === verb);
  if (!act) {
    if (offer.limited) return { reason: reasonLine(offer.limited) || `${name} can't be ${ACT_WORDS[verb]} now.` };
    if (verb === "restart") return { reason: instance.running === false ? `${name} is stopped: Start it instead.` : `${name}'s state is not known, so it can't be restarted.` };
    if (verb === "start") return { reason: instance.running === true ? `${name} is already running.` : `${name}'s state is not known, so it can't be started.` };
    return { reason: `${name} can't be ${ACT_WORDS[verb]} now.` };
  }
  if (!act.enabled) return { reason: reasonLine(act.reason) || `${name} can't be ${ACT_WORDS[verb]} now.` };
  return { ok: true };
}

/**
 * @param {object} d   the shell's operations and reads:
 *   say(line)                        one line, shown and announced until the next key, click or focus change
 *   targetId(origin) / target(origin)   the target instance's id / its current roster row, or null
 *   stepFrom(origin)                 the instance id previous / next go on from (default: targetId)
 *   rosterRows()                     [{ id, openable, open() }] as drawn
 *   workspaceStep(delta)             show the workspace before (-1) / after (1) the current one in the list,
 *                                    wrapping; false when there is no other one to show
 *   menuReason(instance)             the row's context menu's own block, or null
 *   openAct(verb, instance)          the menu's dialog for the act (Stop…/Retire… plans, Start…/Restart…)
 *   spawnSoul(instance)              the spawn dialog for the instance's soul, as Quick Open opens it
 *   palette, instances, souls, capabilities, zoom, closeTab, tabPrevious, tabNext, splitRight,
 *   splitDown, nextGroup, previousGroup, closeSplit, quickOpen, filter, workspaces, help, list, refresh
 */
export function createLeaderDispatch(d) {
  const lifecycle = (verb) => (origin) => {
    const instance = d.target(origin);
    if (!instance) { d.say(NO_TARGET); return; }
    const { reason } = actAvailability(instance, verb, d.menuReason(instance));
    if (reason) { d.say(reason); return; }
    d.openAct(verb, instance);
  };
  const step = (delta) => (origin) => {
    const row = rosterStep(d.rosterRows(), (d.stepFrom ?? d.targetId)(origin), delta);
    if (row) row.open();
    else d.say(delta > 0 ? "No instance below this one has a terminal to open." : "No instance above this one has a terminal to open.");
  };
  const moveWorkspace = (delta) => () => {
    if (!d.workspaceStep(delta)) d.say(NO_OTHER_WORKSPACE);
  };
  const RUN = Object.freeze({
    __proto__: null,
    palette: () => d.palette(),
    instances: () => d.instances(),
    souls: () => d.souls(),
    capabilities: () => d.capabilities(),
    previous: step(-1),
    next: step(1),
    "workspace-previous": moveWorkspace(-1),
    "workspace-next": moveWorkspace(1),
    zoom: () => d.zoom(),
    "close-terminal": () => d.closeTab(),
    "tab-previous": () => d.tabPrevious(),
    "tab-next": () => d.tabNext(),
    "split-right": () => d.splitRight(),
    "split-down": () => d.splitDown(),
    "group-next": () => d.nextGroup(),
    "group-previous": () => d.previousGroup(),
    "group-close": () => d.closeSplit(),
    stop: lifecycle("stop"),
    restart: lifecycle("restart"),
    start: lifecycle("start"),
    retire: lifecycle("retire"),
    spawn: () => d.quickOpen(),
    "spawn-another": (origin) => {
      const instance = d.target(origin);
      if (!instance) { d.say(NO_TARGET); return; }
      if (typeof instance.agent !== "string" || !instance.agent) { d.say(`${instance.instance}'s soul is not reported.`); return; }
      d.spawnSoul(instance);
    },
    filter: () => d.filter(),
    workspaces: () => d.workspaces(),
    help: () => d.help(),
    list: () => d.list(),
    refresh: () => d.refresh(),
  });
  return {
    /** Run `does` for the leader's or a sidebar key's origin. False when the Desktop has no such operation. */
    run(does, origin = {}) {
      const fn = RUN[does];
      if (!fn) return false;
      fn(origin);
      return true;
    },
    supports: (does) => typeof RUN[does] === "function",
  };
}
