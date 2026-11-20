/** Workspace › Capabilities (the Desktop UI rework, slice 3b; guide tour step 34): every capability of the
 * workspace as one flat list of calm rows, core ones first ("show core and other ones as really the same").
 * A row says its name, who made it (a ✓, "Official: in the OATS catalog" / "Official: from the OATS repository", or "by <source>":
 * packages/client/capability-origin.mjs), one line of what it does, and its tags: "core" for a knowledge,
 * messaging or tasks capability, "default" for one the workspace gives every soul (workspace-defaults.mjs says
 * what defaults are, in one sentence above the list), "repo only" for a capability only its repository's souls may
 * use. No sections, no repository pills, no colour tiles and no two-letter marks; a package's name and version are
 * Setup's (its Packages list) and the capability's page's. The order and the tags are the shared
 * packages/client/capability-list.mjs. Pure DOM from kernel JSON (`oats capabilities`, `oats workspace status`):
 * nothing is resolved, joined across the non-collapse boundary, or inferred. */
import { iconElement } from './shell-icons.mjs';
import { sourceChip, sourceText } from './source-chip.mjs';
import { defaultsLead, DEFAULTS_COPY } from './workspace-defaults.mjs';
import { layerLabel } from '../../client/capability-rows.mjs';
import { capabilityList, workspaceDefaultsSections } from '../../client/capability-list.mjs';
import { ORIGIN_COPY } from '../../client/capability-origin.mjs';

export const catalogCSS = `
/* The list (slice 3b; slice 3c drew it as the prototype's): a column of rows on the page, no box around them, a hairline
   under each. Names in the chrome's sans (D2). */
.cap-list { display:flex; flex-direction:column; margin:0; padding:0; list-style:none; }
.cap-list > li { display:flex; min-width:0; border-bottom:1px solid var(--border); }
/* A row is one button (no nested controls); the UA button is reset. Two lines: the name, its mark and its pills; then
   what it does. Quiet states: hover raises it to --surface-2, keyboard focus is the shell's tint under the accent edge. */
.oats-view button.cap-row, button.cap-row, .cap-row { appearance:none; -webkit-appearance:none; display:flex; flex-direction:column; justify-content:center; gap:2px; flex:1; width:100%; min-width:0; height:auto; min-height:var(--row-h); margin:2px 0; padding:5px var(--space-3); border:0; border-radius:var(--radius-control); background:transparent; color:var(--fg); font:inherit; font-family:var(--ui-font,system-ui); text-align:left; box-sizing:border-box; }
.oats-view button.cap-row { cursor:pointer; }
.oats-view button.cap-row:hover { background:var(--surface-2); }
/* Keyboard focus: the shell's tint (rule 2) under the global accent edge. */
.oats-view button.cap-row:focus-visible { background:var(--sel); }
/* The line reads as the prototype's: the name, the official mark or "by <source>" right after it, then the pills (the
   markup keeps name, pills, origin, the reading order slice 3b pinned). */
.cap-row-line { display:flex; align-items:center; gap:var(--space-2); min-width:0; }
.cap-row-name { order:0; min-width:0; color:var(--fg); font-weight:var(--name-weight); font-size:var(--text-name); line-height:18px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cap-row-line > .cap-origin { order:1; }
.cap-row-line > .cap-tag { order:2; }
/* Pills: "core" in a hairline frame, "default" on a quiet fill; muted words, never a tint. */
.cap-tag { flex:none; display:inline-flex; align-items:center; height:17px; padding:0 6px; border:1px solid var(--border); border-radius:var(--radius-tag); color:var(--muted); font-weight:400; font-size:var(--text-label); line-height:normal; letter-spacing:.02em; white-space:nowrap; box-sizing:border-box; }
.cap-tag[data-tag=default], .cap-tag[data-tag=default-off] { border-color:var(--tag-bg); background:var(--tag-bg); }
.cap-origin { flex:none; display:inline-flex; align-items:center; gap:5px; color:var(--muted); font-size:var(--text-meta); white-space:nowrap; }
/* The official mark: a check in a small circle, its meaning in the title and the accessible name. */
.cap-official { display:inline-grid; place-items:center; width:15px; height:15px; border:1px solid var(--muted); border-radius:50%; color:var(--accent); box-sizing:border-box; }
.cap-row-desc { min-width:0; color:var(--muted); font-size:var(--text-meta); line-height:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.source-chip { display:inline-flex; align-items:center; gap:7px; min-width:0; color:var(--muted); font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); }
.source-chip .shell-icon { flex:none; }
.source-chip-name { color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.source-chip-version { white-space:nowrap; }
.source-chip.boxed { height:24px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); font-size:11.5px; box-sizing:border-box; }
.source-note { color:var(--warn); font-weight:600; font-size:11px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
.catalog-empty { margin:0; padding:24px 16px; color:var(--muted); line-height:1.5; }
/* The page's first line (slice 3c): what a capability is, what the mark, "core" and "default" say, with the counts. */
.cap-intro { margin:0 0 var(--space-5); max-width:96ch; color:var(--muted); font-size:var(--text-body); line-height:1.55; }
.cap-intro .cap-official { display:inline-grid; vertical-align:-3px; margin:0 1px; }
.cap-intro b { color:var(--fg); font-weight:600; }
/* The tab's two parts (slice 2b, Amendment 1, D): Workspace defaults, then All capabilities, each titled in the small
   uppercase label (slice 3c), its groups and slots one step quieter. */
.cap-part { margin:0 0 var(--space-6); }
.cap-part-title { margin:0 0 var(--space-2); color:var(--muted); font-size:var(--text-label); font-weight:var(--label-weight); letter-spacing:var(--label-tracking); text-transform:uppercase; line-height:16px; }
.cap-group-title { margin:var(--space-4) 0 0; color:var(--fg); font-size:var(--text-meta); font-weight:var(--label-weight); line-height:16px; }
.cap-slot { display:flex; flex-direction:column; min-width:0; }
.cap-slot-label { padding:var(--space-2) var(--space-3) 0; color:var(--muted); font-size:var(--text-label); font-weight:400; letter-spacing:var(--label-tracking); text-transform:uppercase; line-height:16px; }
.cap-slot-none { padding:2px var(--space-3) 10px; color:var(--muted); font-size:var(--text-meta); line-height:1.4; }
.catalog-notes { display:grid; gap:4px; margin:0 0 14px; }
.catalog-notes:empty { display:none; }
.catalog-note { margin:0; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.catalog-note.warn { color:var(--warn); }
`;

/** A row's origin: the official mark (its words: which fact made it official, ORIGIN_COPY.officialTitle) or "by <source>". Its words are the element's accessible text; `words`
 * shows them beside the mark too (the capability page's origin line). */
export function originElement(doc, origin, { words: visible = false } = {}) {
  const el = doc.createElement('span'); el.className = 'cap-origin';
  if (origin.official) {
    const said = ORIGIN_COPY.officialTitle[origin.reason];
    el.dataset.official = 'true'; el.title = said;
    const mark = doc.createElement('span'); mark.className = 'cap-official'; mark.setAttribute('aria-hidden', 'true');
    mark.append(iconElement(doc, 'check', { size: 11 }));
    const words = doc.createElement('span'); words.className = visible ? 'cap-origin-words' : 'workspace-sr-only'; words.textContent = said;
    el.append(mark, words);
  } else el.textContent = ORIGIN_COPY.by(origin.by);
  return el;
}
const tag = (doc, words, title, kind) => { const el = doc.createElement('span'); el.className = 'cap-tag'; el.dataset.tag = kind; el.textContent = words; if (title) el.title = title; return el; };

/** The tags a list entry carries, in order: core, default (or default · off), repo only. */
export function entryTags(doc, entry) {
  const tags = [];
  if (entry.core) tags.push(tag(doc, 'core', `Core: ${layerLabel(entry.core)}. A soul has at most one ${entry.core} capability.`, 'core'));
  if (entry.default === 'on') tags.push(tag(doc, DEFAULTS_COPY.tag, DEFAULTS_COPY.tagTitle, 'default'));
  if (entry.default === 'off') tags.push(tag(doc, DEFAULTS_COPY.offTag, DEFAULTS_COPY.offTitle, 'default-off'));
  if (entry.row.private === true) tags.push(tag(doc, 'repo only', "Only souls of its own repository can use it", 'private'));
  return tags;
}

/** Arrow keys move along the rows (the list keeps one tab stop: the row last focused). */
export function roveRows(listEl) {
  const rows = () => [...listEl.querySelectorAll('button.cap-row')];
  listEl.addEventListener('focusin', event => { const at = event.target.closest?.('button.cap-row'); if (at) for (const row of rows()) row.tabIndex = row === at ? 0 : -1; });
  listEl.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const all = rows(), at = all.indexOf(event.target);
    if (at < 0) return;
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    all[Math.max(0, Math.min(all.length - 1, next))].focus();
  });
}

/** One capability row, the list's and any page's that lists capabilities the same way (the soul page, slice 3a):
 * `entry` is a capabilityList entry ({ row, core, default, origin }; packages/client/capability-list.mjs), or a soul page's (origin null: no source to say). A button that
 * opens `onOpen(row)` (Enter and Space are its own), or a plain div with no opener. `tabStop`: whether it takes the
 * list's one tab stop (the list moves it with the arrows: roveRows). Its CSS is catalogCSS. */
export function capabilityRowElement(doc, entry, { onOpen = null, tabStop = true } = {}) {
  const { row, origin } = entry, opens = typeof onOpen === 'function';
  const el = node(doc, opens ? 'button' : 'div', null, 'cap-row');
  el.dataset.capability = row.name; el.dataset.kind = row.kind;
  const line = node(doc, 'span', null, 'cap-row-line');
  const name = node(doc, 'span', row.name, 'cap-row-name'); name.title = row.name;
  line.append(name, ...entryTags(doc, entry), ...(origin ? [originElement(doc, origin)] : [])); // origin null: a soul's slot the inspection names without its capability
  el.append(line);
  // Kernel #217: the manifest's description, one line; the page carries the whole text.
  if (text(row.description)) { const desc = node(doc, 'span', row.description, 'cap-row-desc'); desc.title = row.description; el.append(desc); }
  if (opens) {
    el.type = 'button'; el.tabIndex = tabStop ? 0 : -1;
    el.dataset.focusKey = `cap:${row.kind}:${row.kind === 'package' ? row.package ?? '' : row.repoKey ?? ''}:${row.name}`;
    el.addEventListener('click', () => onOpen(row)); // the native button turns Enter and Space into this click
  }
  return el;
}

/** The Workspace defaults part (slice 2b, Amendment 1, D: Pepe, 2026-11-20; it brings back what slice 3b had folded
 * into a tag): what the workspace gives every soul, above the list and never narrowed by its search. Core: one slot
 * each for Knowledge, Messaging and Tasks, its default's row or "No default"; then Additional, every other default
 * (a turned-off one tagged so). Each is the list's own row (capabilityRowElement), opening its page; its focus key
 * is prefixed `defaults:` so a repaint puts focus back on this copy, not the list's. Null with no reported defaults. */
function workspaceDefaultsPart(doc, { status, rows, onOpen }) {
  const sections = workspaceDefaultsSections(rows, status);
  if (!sections) return null;
  const part = node(doc, 'section', null, 'cap-part cap-defaults'); part.dataset.part = 'defaults';
  const title = node(doc, 'h3', DEFAULTS_COPY.title, 'cap-part-title'); title.id = 'cap-defaults-title';
  part.append(title);
  const lead = defaultsLead(doc, { status, rows });
  if (lead) part.append(lead);
  const row = (entry, first) => {
    const el = capabilityRowElement(doc, entry, { onOpen, tabStop: first });
    if (el.dataset.focusKey) el.dataset.focusKey = `defaults:${el.dataset.focusKey}`;
    return el;
  };
  let first = true;
  const coreTitle = node(doc, 'h4', DEFAULTS_COPY.core, 'cap-group-title'); coreTitle.id = 'cap-defaults-core';
  const core = node(doc, 'ul', null, 'cap-list'); core.setAttribute('aria-labelledby', coreTitle.id);
  for (const { layer, entries, unlisted } of sections.core) {
    const item = node(doc, 'li'); const slot = node(doc, 'div', null, 'cap-slot'); slot.dataset.slot = layer;
    slot.append(node(doc, 'span', layerLabel(layer), 'cap-slot-label'));
    // A declared default the catalog doesn't list is named (the lead sentence says so too); "No default" is for none.
    if (unlisted) slot.append(node(doc, 'span', DEFAULTS_COPY.unlistedSlot(unlisted), 'cap-slot-none'));
    else if (!entries.length) slot.append(node(doc, 'span', DEFAULTS_COPY.noDefault, 'cap-slot-none'));
    for (const entry of entries) { slot.append(row(entry, first)); first = false; }
    item.append(slot); core.append(item);
  }
  part.append(coreTitle, core);
  const extraTitle = node(doc, 'h4', DEFAULTS_COPY.additional, 'cap-group-title'); extraTitle.id = 'cap-defaults-additional';
  part.append(extraTitle);
  if (!sections.additional.length) part.append(node(doc, 'p', DEFAULTS_COPY.noAdditional, 'cap-slot-none'));
  else {
    const extra = node(doc, 'ul', null, 'cap-list'); extra.setAttribute('aria-labelledby', extraTitle.id);
    for (const entry of sections.additional) { const item = node(doc, 'li'); item.append(row(entry, first)); first = false; extra.append(item); }
    part.append(extra);
  }
  // One tab stop for the whole part: the arrows move across both groups.
  if (typeof onOpen === 'function') roveRows(part);
  return part;
}

/** The page's first line (the Desktop UI rework, slice 3c: the prototype's sentence, on the official rule of
 * packages/client/capability-origin.mjs): what a capability is, how many the workspace has and how many are official,
 * then what the mark, "core" and "default" say. "default" is said only where the kernel reports defaults. */
export const INTRO_COPY = Object.freeze({
  what: 'A capability is a bundle a soul is composed with: instructions, skills, hooks and commands.',
  have: (n, official) => ` You have ${n} ${n === 1 ? 'capability' : 'capabilities'}, ${official} official: the mark `,
  mark: 'means official (in the OATS catalog, or from the OATS repository); the others say who made them.',
  core: ' “core” fills one of the three places every soul has: knowledge, messaging, tasks;',
  noDefaults: ' “core” fills one of the three places every soul has: knowledge, messaging, tasks.',
  defaults: ' “default” is what this workspace gives a soul unless it says otherwise.',
});
function capabilityIntro(doc, { rows, status }) {
  const all = capabilityList(rows, status);
  if (!all.length) return null;
  const p = node(doc, 'p', null, 'cap-intro');
  const mark = node(doc, 'span', null, 'cap-official'); mark.setAttribute('aria-hidden', 'true'); mark.append(iconElement(doc, 'check', { size: 10 }));
  const said = node(doc, 'span', '✓', 'workspace-sr-only');
  const hasDefaults = !!(status && typeof status === 'object' && status.defaults && typeof status.defaults === 'object');
  p.append(INTRO_COPY.what, INTRO_COPY.have(all.length, all.filter(entry => entry.origin?.official).length), mark, said, ' ', INTRO_COPY.mark,
    hasDefaults ? INTRO_COPY.core : INTRO_COPY.noDefaults, ...(hasDefaults ? [INTRO_COPY.defaults] : []));
  return p;
}

/** The Capabilities tab: the Workspace defaults part (when the kernel reports defaults), then All capabilities.
 * `rows`: the catalog (`oats capabilities`); `query` narrows by name; `onOpen(row)` opens a row's page (a row with no
 * opener is a plain line). A declared default the catalog does not list is said in the sentence, not as a row.
 * Each row's focus key (`cap:<kind>:<source>:<name>`) puts focus back on it after a repaint. */
export function renderCapabilityList(host, { rows, status, query = '', onOpen = null, label = 'Capabilities' }) {
  const doc = host.ownerDocument;
  host.replaceChildren();
  // The page's first line, over the whole catalog: never narrowed by the search.
  const intro = capabilityIntro(doc, { rows, status });
  if (intro) host.append(intro);
  const defaults = workspaceDefaultsPart(doc, { status, rows, onOpen });
  let target = host;
  if (defaults) {
    // Two parts: the defaults, then the list under its own title.
    const all = node(doc, 'section', null, 'cap-part'); all.dataset.part = 'all';
    all.append(node(doc, 'h3', DEFAULTS_COPY.allTitle, 'cap-part-title'));
    host.append(defaults, all); target = all;
  }
  const entries = capabilityList(rows, status, { query });
  if (!entries.length) {
    target.append(node(doc, 'p', Array.isArray(rows) && rows.length ? 'No capability matches this search.' : 'The workspace reports no capabilities yet: members publish capabilities and packages lock theirs on sync.', 'catalog-empty'));
    return;
  }
  const listEl = node(doc, 'ul', null, 'cap-list'); listEl.setAttribute('aria-label', label);
  let first = true;
  for (const entry of entries) {
    const el = capabilityRowElement(doc, entry, { onOpen, tabStop: first }); first = false;
    const item = node(doc, 'li'); item.append(el); listEl.append(item);
  }
  if (typeof onOpen === 'function') roveRows(listEl);
  target.append(listEl);
}

/** The source chip (source-chip.mjs), re-exported for the pages that draw one. */
export { sourceChip, sourceText };
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value ? value : null;
/** A member's handshake state in plain words (docs/workspaces.md): the chip
 * label, why its souls are not available while it is not confirmed, and what
 * the state means (Setup's "For developers" explainer, beside the same chip).
 * An unknown kernel status is shown verbatim, never guessed. */
const MEMBER_STATES = {
  confirmed: { label: 'confirmed', ok: true },
  'not-listed': { label: 'not listed', why: "isn't listed by the workspace", meaning: "the host's link is missing" },
  'no-backlink': { label: 'no backlink', why: "hasn't joined the workspace", meaning: "the repo's link is missing" },
  'backlink-elsewhere': { label: 'points elsewhere', why: 'says it belongs to a different workspace', meaning: 'names another workspace' },
  'cannot-read': { label: "can't read", why: "can't be read with your access", meaning: "your Git access can't check" },
};
/** The kernel's member states that need attention, in the order the explainer says them. */
export const MEMBER_PROBLEMS = Object.freeze(Object.keys(MEMBER_STATES).filter(status => !MEMBER_STATES[status].ok));
export function memberState(member) {
  const status = text(member?.status) || 'unconfirmed';
  return { status, ok: false, why: 'is not confirmed', label: status, ...MEMBER_STATES[status] };
}
function node(doc, tag, value, cls) {
  const el = doc.createElement(tag);
  if (value !== undefined && value !== null) el.textContent = value;
  if (cls) el.className = cls;
  return el;
}

/** A capability as a soul/instance resolves it (`oats inspect` capabilities[])
 * in the catalog's row shape, so the one table renders both. Only reported
 * facts: no team (inspect does not report one), the origin from `from`. */
export function capabilityRow(cap) {
  const from = cap?.from && typeof cap.from === 'object' ? cap.from : {};
  const kind = ['package', 'member', 'external'].includes(from.kind) ? from.kind : 'external';
  return { name: cap.id, kind, ...(text(from.package) ? { package: from.package } : {}), ...(text(cap.version) ? { version: cap.version } : {}),
    ...(text(from.commit) ? { commit: from.commit } : {}), ...(text(from.repoKey) ? { repoKey: from.repoKey } : {}),
    origin: kind === 'package' ? `package ${from.package} v${from.version || cap.version || ''}`.trim() : `${kind} ${from.repoKey || ''}`.trim(),
    ...(cap.layer ? { layer: cap.layer } : {}), resolved: cap };
}
/** Observation notes in the kernel's own terms: an unreachable workspace
 * (module drift not current), withheld roster rows (F1 guard), lock state and
 * workspace problems. */
export function deploymentNotes(deployment) {
  const lines = [];
  const reach = deployment?.reachable;
  if (reach && reach.reachable === false) lines.push({ text: `Workspace unreachable — module drift is not current. ${[reach.code, reach.message].filter(text).join(': ')}`, warn: true });
  const withheld = list(deployment?.withheld);
  if (withheld.length) lines.push({ text: `${withheld.length} instance ${withheld.length === 1 ? 'row was' : 'rows were'} withheld: the kernel reported a home outside the soul's instances directory or a duplicate home (${withheld.map(w => w.instance).join(', ')}).`, warn: true });
  return [...lines, ...lockNotes(deployment?.workspaceStatus)];
}
/** Lock lines in the kernel's own terms (workspace status). */
export function lockNotes(status) {
  const lines = [];
  if (list(status?.unsynced).length) lines.push({ text: `Declared but not locked: ${status.unsynced.join(', ')}. Sync to lock them.`, warn: true });
  if (list(status?.stale).length) lines.push({ text: `Locked but no longer declared: ${status.stale.join(', ')}. Sync to drop them.`, warn: true });
  for (const problem of list(status?.problems)) lines.push({ text: [problem.code, problem.message].filter(text).join(': '), warn: true });
  return lines;
}
