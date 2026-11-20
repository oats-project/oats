/** The workspace's capabilities as one flat list, as both clients draw it (the Desktop UI rework, slice 3b: "show
 * core and other ones as really the same"). Core capabilities (a knowledge, messaging or tasks `layer`) come first
 * in that order, then every other one by name. Each entry carries what its row says: its core slot, whether it
 * is one of the workspace's defaults (`oats workspace status` `defaults`), and who made it (capability-origin.mjs).
 * Nothing is inferred: a default is matched to a row only by the name and the source the kernel reports, and
 * with no reported `defaults` no row is called a default. Pure and DOM-free. */
import { sameRepo } from './repo-moves.mjs';
import { memberNames, hostKeyOf, matchCapabilities } from './capability-rows.mjs';
import { capabilityOrigin } from './capability-origin.mjs';

/** The core slots, in the one order every surface shows them. */
export const CORE_LAYERS = Object.freeze(['knowledge', 'messaging', 'tasks']);

const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v ? v : null;
const list = v => Array.isArray(v) ? v : [];

/** Whether a declared default (`{ name, from }`: `from` is "package", "here" or a member key) names this row. */
export function defaultNames(entry, row, hostKey = null) {
  if (!record(entry) || entry.name !== row?.name) return false;
  if (entry.from === 'package') return row.kind === 'package';
  if (entry.from === 'here') return row.kind === 'member' && !!text(hostKey) && sameRepo(row.repoKey, hostKey);
  if (text(entry.from)) return row.kind === 'member' && sameRepo(row.repoKey, entry.from);
  return false;
}
/** The row's place in the workspace's defaults: 'on' (every soul starts with it), 'off' (the workspace turns it
 * off), or null (not a default, or no defaults reported). A turned-off entry reports no source: it is matched by
 * name. A slot default fills its core slot (`defaults.slots.<layer>`). */
export function defaultState(status, row) {
  const defaults = status?.defaults;
  if (!record(defaults) || !row) return null;
  const hostKey = hostKeyOf(status);
  for (const cap of list(defaults.capabilities)) {
    if (!record(cap) || cap.name !== row.name) continue;
    if (cap.off === true) return 'off';
    if (defaultNames(cap, row, hostKey)) return 'on';
  }
  const slot = text(row.layer) && record(defaults.slots) ? defaults.slots[row.layer] : null;
  return record(slot) && defaultNames(slot, row, hostKey) ? 'on' : null;
}
/** The rank of a row in the list: a core slot's index, else after every core one. */
const rank = row => { const at = CORE_LAYERS.indexOf(row?.layer); return at < 0 ? CORE_LAYERS.length : at; };

/** The list's entries, in drawn order: `{ row, core, default, origin }`. `core`: the row's core slot or null;
 * `default`: defaultState; `origin`: capabilityOrigin. `query` narrows by name (matchCapabilities). */
export function capabilityList(rows, status, { query = '' } = {}) {
  const names = memberNames(status);
  return matchCapabilities(list(rows), query)
    .map(row => ({ row, core: CORE_LAYERS.includes(row.layer) ? row.layer : null, default: defaultState(status, row), origin: capabilityOrigin(row, status, names) }))
    .sort((a, b) => rank(a.row) - rank(b.row) || String(a.row.name).localeCompare(String(b.row.name)) || a.origin.by.localeCompare(b.origin.by));
}

/** What the list's lead sentence needs, from the reported defaults: null when the kernel reports none (no claim).
 * `empty`: the workspace sets no default at all. `emptySlots`: the core slots no default fills (by a slot or a
 * named capability of that layer), in CORE_LAYERS order. `unlisted`: the declared defaults no catalog row
 * matches (`{ name, off }`), so the list cannot show them as rows; a turned-off one is unlisted when no row has
 * its name. */
export function defaultsSummary(status, rows) {
  const defaults = status?.defaults;
  if (!record(defaults)) return null;
  const hostKey = hostKeyOf(status), all = list(rows);
  const slots = CORE_LAYERS.map(layer => [layer, record(defaults.slots) && record(defaults.slots[layer]) && text(defaults.slots[layer].name) ? defaults.slots[layer] : null]);
  const caps = list(defaults.capabilities).filter(cap => record(cap) && text(cap.name));
  const listed = entry => entry.off === true ? all.some(row => row?.name === entry.name) : all.some(row => defaultNames(entry, row, hostKey));
  const filled = new Set(slots.filter(([, value]) => value).map(([layer]) => layer));
  for (const cap of caps) if (cap.off !== true) for (const row of all) if (defaultNames(cap, row, hostKey) && CORE_LAYERS.includes(row.layer)) filled.add(row.layer);
  const unlisted = [...slots.filter(([, value]) => value).map(([, value]) => value), ...caps].filter(entry => !listed(entry)).map(entry => ({ name: entry.name, off: entry.off === true }));
  return { empty: !filled.size && !caps.length, emptySlots: CORE_LAYERS.filter(layer => !filled.has(layer)), unlisted };
}

/** The Workspace defaults section (slice 2b, Amendment 1, D: Pepe, 2026-11-20, "el list de capabilities m'agradaven mes
 * com avans que et deia quins son els defaults del workspace"), above the flat list, never narrowed by a search: null
 * when the kernel reports no `defaults` (no claim). `core`: each core slot in CORE_LAYERS order, `{ layer, entries }`,
 * the listed rows that fill it by default (none: the slot has no default; two: the workspace's own conflict, both
 * shown). `additional`: every other listed default, on or turned off (`default` says which), in the list's order.
 * Entries are capabilityList's, so a row draws as it does in the list. A declared default no row matches is
 * defaultsSummary's `unlisted`, said in words, not as a row. */
export function workspaceDefaultsSections(rows, status) {
  if (!record(status?.defaults)) return null;
  const entries = capabilityList(rows, status).filter(entry => entry.default);
  const on = entries.filter(entry => entry.default === 'on');
  return {
    core: CORE_LAYERS.map(layer => ({ layer, entries: on.filter(entry => entry.core === layer) })),
    additional: entries.filter(entry => !(entry.default === 'on' && entry.core)),
  };
}
