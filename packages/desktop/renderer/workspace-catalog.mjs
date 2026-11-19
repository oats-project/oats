/** Workspace › Capabilities (the Desktop UI rework, slice 3b; guide tour step 34): every capability of the
 * workspace as one flat list of calm rows, core ones first ("show core and other ones as really the same").
 * A row says its name, who made it (a ✓, "Verified: published by OATS", or "by <source>":
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
import { capabilityList } from '../../client/capability-list.mjs';
import { ORIGIN_COPY } from '../../client/capability-origin.mjs';

export const catalogCSS = `
/* The list (slice 3b): one bordered column of rows, a 1px rule between them. Names in the chrome's sans (D2). */
.cap-list { display:flex; flex-direction:column; margin:0; padding:0; list-style:none; background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.cap-list > li { display:flex; min-width:0; }
.cap-list > li + li { border-top:1px solid var(--tag-bg); }
/* A row is one button (no nested controls); the UA button is reset. Two lines: name, tags and origin; then what it does. */
.oats-view button.cap-row, button.cap-row, .cap-row { appearance:none; -webkit-appearance:none; display:flex; flex-direction:column; justify-content:center; gap:3px; flex:1; width:100%; min-width:0; height:auto; min-height:54px; margin:0; padding:9px 16px; border:0; border-radius:0; background:var(--surface); color:var(--fg); font:inherit; font-family:var(--ui-font,system-ui); text-align:left; box-sizing:border-box; }
.oats-view button.cap-row { cursor:pointer; }
.oats-view button.cap-row:hover { background:var(--surface-2); }
/* Keyboard focus: the shell's tint (rule 2) under the global accent edge. */
.oats-view button.cap-row:focus-visible { background:var(--sel); }
.cap-row-line { display:flex; align-items:center; gap:8px; min-width:0; }
.cap-row-name { min-width:0; color:var(--fg); font-weight:600; font-size:13.5px; line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* Dim tags: muted words in a hairline frame, never a tint. */
.cap-tag { flex:none; display:inline-flex; align-items:center; height:18px; padding:0 6px; border:1px solid var(--border); border-radius:4px; color:var(--muted); font-weight:500; font-size:11px; line-height:normal; white-space:nowrap; box-sizing:border-box; }
.cap-origin { flex:none; display:inline-flex; align-items:center; gap:5px; margin-left:auto; padding-left:12px; color:var(--muted); font-size:12px; white-space:nowrap; }
/* The verified mark: a check in a circle, its meaning in the title and the accessible name. */
.cap-verified { display:inline-grid; place-items:center; width:16px; height:16px; border:1px solid var(--muted); border-radius:50%; color:var(--fg); box-sizing:border-box; }
.cap-row-desc { min-width:0; color:var(--muted); font-size:12.5px; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.source-chip { display:inline-flex; align-items:center; gap:7px; min-width:0; color:var(--muted); font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); }
.source-chip .shell-icon { flex:none; }
.source-chip-name { color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.source-chip-version { white-space:nowrap; }
.source-chip.boxed { height:24px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); font-size:11.5px; box-sizing:border-box; }
.source-note { color:var(--warn); font-weight:600; font-size:11px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
.catalog-empty { margin:0; padding:24px 16px; color:var(--muted); line-height:1.5; }
.catalog-notes { display:grid; gap:4px; margin:0 0 14px; }
.catalog-notes:empty { display:none; }
.catalog-note { margin:0; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.catalog-note.warn { color:var(--warn); }
`;

/** A row's origin: the verified mark (official) or "by <source>". Its words are the element's accessible text; `words`
 * shows them beside the mark too (the capability page's origin line). */
export function originElement(doc, origin, { words: visible = false } = {}) {
  const el = doc.createElement('span'); el.className = 'cap-origin';
  if (origin.official) {
    el.dataset.official = 'true'; el.title = ORIGIN_COPY.title;
    const mark = doc.createElement('span'); mark.className = 'cap-verified'; mark.setAttribute('aria-hidden', 'true');
    mark.append(iconElement(doc, 'check', { size: 11 }));
    const words = doc.createElement('span'); words.className = visible ? 'cap-origin-words' : 'workspace-sr-only'; words.textContent = ORIGIN_COPY.title;
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
function roveRows(listEl) {
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

/** The Capabilities tab: the defaults sentence (when the kernel reports defaults), then the one list.
 * `rows`: the catalog (`oats capabilities`); `query` narrows by name; `onOpen(row)` opens a row's page (a row with no
 * opener is a plain line). A declared default the catalog does not list is said in the sentence, not as a row.
 * Each row's focus key (`cap:<kind>:<source>:<name>`) puts focus back on it after a repaint. */
export function renderCapabilityList(host, { rows, status, query = '', onOpen = null, label = 'Capabilities' }) {
  const doc = host.ownerDocument;
  host.replaceChildren();
  const lead = defaultsLead(doc, { status, rows });
  if (lead) host.append(lead);
  const entries = capabilityList(rows, status, { query });
  if (!entries.length) {
    host.append(node(doc, 'p', Array.isArray(rows) && rows.length ? 'No capability matches this search.' : 'The workspace reports no capabilities yet: members publish capabilities and packages lock theirs on sync.', 'catalog-empty'));
    return;
  }
  const listEl = node(doc, 'ul', null, 'cap-list'); listEl.setAttribute('aria-label', label);
  let first = true;
  for (const entry of entries) {
    const { row, origin } = entry, opens = typeof onOpen === 'function';
    const el = node(doc, opens ? 'button' : 'div', null, 'cap-row');
    el.dataset.capability = row.name; el.dataset.kind = row.kind;
    const line = node(doc, 'span', null, 'cap-row-line');
    const name = node(doc, 'span', row.name, 'cap-row-name'); name.title = row.name;
    line.append(name, ...entryTags(doc, entry), originElement(doc, origin));
    el.append(line);
    // Kernel #217: the manifest's description, one line; the page carries the whole text.
    if (text(row.description)) { const desc = node(doc, 'span', row.description, 'cap-row-desc'); desc.title = row.description; el.append(desc); }
    if (opens) {
      el.type = 'button'; el.tabIndex = first ? 0 : -1; first = false;
      el.dataset.focusKey = `cap:${row.kind}:${row.kind === 'package' ? row.package ?? '' : row.repoKey ?? ''}:${row.name}`;
      el.addEventListener('click', () => onOpen(row)); // the native button turns Enter and Space into this click
    }
    const item = node(doc, 'li'); item.append(el); listEl.append(item);
  }
  if (typeof onOpen === 'function') roveRows(listEl);
  host.append(listEl);
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
