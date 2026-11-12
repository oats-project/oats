/** Workspace model v2 catalog views: the Capabilities sections (design board
 * v4.1/Capabilities: one row card per capability) and the Setup tab (graph + lists). Pure DOM from kernel JSON — `oats capabilities`,
 * `oats workspace status` and the roster's module rows. Nothing is resolved,
 * joined across the non-collapse boundary, or inferred: a member's
 * `publishes` stays informational, package capabilities stay package rows. */
import { createCapabilityMark, createSoulMark } from './identity-marks.mjs';
import { iconElement } from './shell-icons.mjs';
import { ROSTER_STALE_TITLE, SOULS_STALE_TITLE } from './loading.mjs';
import { groupHeading, groupHeadingCSS } from './group-heading.mjs';
import { sourceChip, sourceText } from './source-chip.mjs';
import { renderWorkspaceDefaults, workspaceDefaults, DEFAULTS_COPY } from './workspace-defaults.mjs';
import { memberNames, capabilityUse, soulsUsing, capabilityGroup, groupCapabilities, hostKeyOf, matchCapabilities, layerLabel } from '../../client/capability-rows.mjs';

export const catalogCSS = `
/* Workspace v4.1: a segmented section jump, section titles with a lead, repository pills
   inside Workspace owned, and a Capability | Used by list of row cards, grouped by repository (Packages by package):
   the group heading names the source, the card's accessible name repeats it. */
/* The jump is one segmented group (shared control rule 1): one frame, 2px inner padding,
   6px segments, no dividers; the current section is the brand tint, never ink-on-white.
   Scoped to .capability-nav.ws-segmented so it holds whichever order the sheets load in. */
.capability-nav.ws-segmented { display:inline-flex; align-items:center; flex:none; height:30px; padding:2px; gap:2px; margin:0 0 22px; border:1px solid var(--border); border-radius:8px; background:var(--surface); overflow:visible; }
.oats-view .capability-nav.ws-segmented button { display:inline-flex; align-items:center; gap:6px; height:100%; min-height:0; padding:0 12px; border:0; border-radius:6px; background:transparent; color:var(--muted); font-weight:500; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .capability-nav.ws-segmented button:hover { color:var(--fg); }
.oats-view .capability-nav.ws-segmented button[aria-current] { background:var(--sel); color:var(--accent); font-weight:650; }
.capability-nav-count { font-weight:normal; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); }
/* Workspace owned's repository pills (human, 2026-10-07): where capabilities are defined, as one
   single-choice group of wrapping chips (a workspace can have many repos), at the section head's
   right. Each chip has the segmented look (rule 1): a 1px frame, muted at rest, the brand tint
   when pressed; never ink-on-white. */
.catalog-filters { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:6px 10px; min-width:0; max-width:100%; margin:0; padding:0 2px; }
.catalog-pills { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:6px; min-width:0; max-width:100%; }
.oats-view .catalog-pills button { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; height:28px; min-height:0; margin:0; padding:0 10px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--muted); font-weight:500; font-size:12px; line-height:1; font-family:var(--ui-font,system-ui); cursor:pointer; box-sizing:border-box; }
.oats-view .catalog-pills button:hover { color:var(--fg); }
.oats-view .catalog-pills button[aria-pressed=true] { border-color:var(--sel-border); background:var(--sel); color:var(--accent); font-weight:650; }
/* Keyboard focus: the shell's tint (rule 2) under the global accent edge; the rule above would out-rank the global one. */
.oats-view .catalog-pills button:focus-visible { background:var(--sel); }
.catalog-pill-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--mono,monospace); }
.catalog-pill-name.plain { font-family:inherit; }
.catalog-shown { color:var(--muted); font-size:12px; white-space:nowrap; }
/* The list: a column header, then one card per capability (58px, 6px apart). The
   header and the cards share one grid so the columns line up. */
.catalog-table { display:flex; flex-direction:column; gap:6px; font-size:12px; }
.catalog-head, .catalog-row { display:grid; grid-template-columns:44px minmax(0,1fr) 120px 24px; column-gap:14px; align-items:center; padding:0 16px; box-sizing:border-box; }
.catalog-head { margin:0 0 4px; color:var(--muted); font-size:10.5px; font-weight:650; letter-spacing:.065em; text-transform:uppercase; }
/* The whole card is one button (rule: no nested interactive elements); reset the UA button. */
.oats-view button.catalog-row, button.catalog-row { appearance:none; -webkit-appearance:none; width:100%; height:58px; min-height:0; margin:0; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--fg); font:inherit; text-align:left; cursor:pointer; }
.oats-view button.catalog-row:hover, button.catalog-row:hover { background:var(--surface-2); border-color:var(--tree-line); }
/* Focus is the shell's rule 2 (keyboard only: the tint with a 1px accent edge). */
/* Listed without a page to open (no onOpen): a plain card, not a dimmed control. */
.oats-view button.catalog-row:disabled, button.catalog-row:disabled { color:var(--fg); background:var(--surface); border-color:var(--border); cursor:default; }
/* Icon tile and kind chip: one tint per kind (7b), a layer always wins so both agree.
   Neutral = a package without a layer. */
.catalog-tile { display:grid; place-items:center; flex:none; width:32px; height:32px; border-radius:8px; background:var(--chip-bg); color:var(--chip-fg); }
.catalog-core { display:inline-flex; align-items:center; flex:none; height:18px; padding:0 6px; border-radius:4px; background:var(--chip-bg); color:var(--chip-fg); font-weight:650; font-size:10.5px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
.catalog-tile[data-tint=slate], .catalog-core[data-tint=slate] { background:var(--soul-slate-bg); color:var(--soul-slate-fg); }
.catalog-tile[data-tint=sage], .catalog-core[data-tint=sage] { background:var(--soul-sage-bg); color:var(--soul-sage-fg); }
.catalog-tile[data-tint=mauve], .catalog-core[data-tint=mauve] { background:var(--soul-mauve-bg); color:var(--soul-mauve-fg); }
.catalog-tile[data-tint=clay], .catalog-core[data-tint=clay] { background:var(--soul-clay-bg); color:var(--soul-clay-fg); }
.catalog-cap { display:flex; flex-direction:column; justify-content:center; min-width:0; }
.catalog-cap-line { display:flex; align-items:center; gap:7px; min-width:0; }
.catalog-name { color:var(--fg); font-weight:650; font-size:13px; line-height:normal; font-family:var(--mono,monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
/* One line, always: the card keeps its height and the page holds the full text. */
.catalog-desc { display:block; min-width:0; color:var(--muted); font-size:12px; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.catalog-chevron { color:var(--muted); }
/* A repository group's heading: the Souls tab's (group-heading.mjs), between the cards. */
.catalog-group { min-height:28px; margin:10px 0 0; }
.catalog-head + .catalog-group { margin-top:0; }
${groupHeadingCSS}.source-chip { display:inline-flex; align-items:center; gap:7px; min-width:0; color:var(--muted); font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); }
.source-chip .shell-icon { flex:none; }
.source-chip-name { color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.source-chip-version { white-space:nowrap; }
.source-chip.boxed { height:24px; padding:0 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); font-size:11.5px; box-sizing:border-box; }
.source-note { color:var(--warn); font-weight:600; font-size:11px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
.catalog-used { display:flex; align-items:center; gap:6px; min-width:0; }
/* Two-letter marks fill their tile: the stack overlaps by 1px only (the --surface border still separates tiles), so no letter hides under the next. */
.catalog-used-marks { display:flex; flex:none; padding-left:1px; }
.catalog-used-marks:empty { display:none; }
.catalog-used-marks .identity-mark { width:20px; height:20px; margin-left:-1px; border-radius:6px; border:1.5px solid var(--surface); font-size:9px; font-weight:700; box-sizing:border-box; }
.catalog-used-count { color:var(--fg); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.catalog-used-count.none { color:var(--muted); }
.catalog-empty { margin:0; padding:24px 16px; color:var(--muted); line-height:1.5; }
.catalog-notes { display:grid; gap:4px; margin:0 0 14px; }
.catalog-notes:empty { display:none; }
.catalog-note { margin:0; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.catalog-note.warn { color:var(--warn); }
.capability-section { display:flex; flex-direction:column; gap:10px; }
.capability-section + .capability-section { margin-top:22px; }
/* The page's two parts: Workspace defaults, then All capabilities over its sections, both titled larger. */
.capability-part > .capability-nav { align-self:flex-start; }
.capability-part { display:flex; flex-direction:column; gap:14px; margin-top:32px; }
.capability-part:first-child { margin-top:0; } /* no defaults reported: All capabilities opens the tab */
.capability-part-title, .capability-section-title.capability-part-title { margin:0; padding:0 2px; color:var(--fg); font-size:18px; font-weight:700; }
.capability-section-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px 16px; min-width:0; }
.capability-section-head .catalog-filters { flex:0 1 auto; margin-left:auto; }
.capability-section-title { display:flex; align-items:baseline; gap:10px; margin:0; padding:0 2px; color:var(--fg); font-size:15px; font-weight:650; }
.capability-section-lead { color:var(--muted); font-size:12px; font-weight:400; }
.capability-none { margin:0; }
/* Narrow: the card grows; used-by drops under the name, the tile and chevron stay on the first line. */
@container(max-width:700px) {
 .catalog-head { display:none; }
 .oats-view button.catalog-row, button.catalog-row { grid-template-columns:44px minmax(0,1fr) 24px; height:auto; min-height:58px; padding:10px 16px; row-gap:6px; }
 /* Every cell placed: auto-placement would put the name after the chevron on the first line. */
 .catalog-row .catalog-tile { grid-row:1; grid-column:1; }
 .catalog-row .catalog-cap { grid-row:1; grid-column:2; }
 .catalog-row .catalog-chevron { grid-row:1; grid-column:3; }
 .catalog-row .catalog-used { grid-column:2; }
}
`;

export { sourceChip, sourceText };
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value ? value : null;
const short = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value.slice(0, 7) : value;
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
/** Rows from one repository group (`repo`: a group key; null = all). */
export function filterCapabilities(rows, { repo = null } = {}, names = new Map(), hostKey = null) {
  return list(rows).filter(row => !repo || capabilityGroup(row, names, hostKey).key === repo);
}
const capabilityCount = n => `${n} ${n === 1 ? 'capability' : 'capabilities'}`;

function node(doc, tag, value, cls) {
  const el = doc.createElement(tag);
  if (value !== undefined && value !== null) el.textContent = value;
  if (cls) el.className = cls;
  return el;
}

/** Workspace owned's repository pills: `All N`, then one pill per repository group (choices from
 * repoChoices, in group order), single choice. One group (role=group) with one tab stop: the
 * pressed pill (roving tabindex); Arrow keys move along it, Home/End to its ends, Enter/Space press
 * (native buttons). `value`: the chosen group key, null for All. "N of M shown" follows the pills
 * whenever a repository or a search narrows the list (`narrowed`). Nothing when there are no choices. */
export function renderRepoPills(host, { repos, value = null, total, shown = total, narrowed = false, onChange }) {
  const doc = host.ownerDocument;
  host.replaceChildren(); host.className = 'catalog-filters';
  if (!repos.length) return;
  const group = node(doc, 'div', null, 'catalog-pills'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Show capabilities from');
  const pill = (choice, count) => {
    const button = node(doc, 'button', null); button.type = 'button'; button.dataset.repo = choice.key ?? '';
    const pressed = (choice.key ?? null) === value;
    button.setAttribute('aria-pressed', String(pressed)); button.tabIndex = pressed ? 0 : -1;
    if (choice.title) button.title = choice.title;
    // The space keeps the name and count apart in the accessible name ("lab-agents 3"); the flex gap draws it.
    button.append(node(doc, 'span', choice.label, `catalog-pill-name${choice.mono ? '' : ' plain'}`), ' ', node(doc, 'span', String(count), 'capability-nav-count'));
    button.addEventListener('click', () => { if (!pressed) onChange(choice.key ?? null); });
    return button;
  };
  group.append(pill({ key: null, label: 'All', mono: false }, total), ...repos.map(choice => pill(choice, choice.count)));
  const buttons = () => [...group.querySelectorAll('button')];
  group.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const all = buttons(), at = all.indexOf(event.target);
    if (at < 0) return;
    event.preventDefault();
    const next = all[event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (at + step + all.length) % all.length];
    rovePill(group, next); next.focus();
  });
  host.append(group);
  if (narrowed) host.append(node(doc, 'span', `${shown} of ${total} shown`, 'catalog-shown'));
}
/** Make `button` the pills' one tab stop. */
export function rovePill(group, button) {
  for (const other of group.querySelectorAll('button')) other.tabIndex = other === button ? 0 : -1;
}

/** The repository choices for Workspace owned, from its rows themselves (so a pill never names
 * something the list cannot show): each group's key, name and row count, in group order. */
export function repoChoices(rows, names = new Map(), hostKey = null) {
  return groupCapabilities(list(rows).filter(row => row.kind !== 'package'), names, hostKey)
    .map(group => ({ key: group.key, label: group.name, count: group.rows.length, mono: group.mono,
      title: `${group.key === 'external' ? 'Sources outside the member repos' : `Repository ${group.name}`}: ${capabilityCount(group.rows.length)}` }));
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
/** The tile/chip tint of a row (7b): a layer always wins, so the tile and the kind chip
 * agree; any other member/external capability is clay; a plain package stays neutral. */
const TINTS = { knowledge: 'slate', messaging: 'sage', tasks: 'mauve' };
const tint = row => TINTS[row.layer] || (row.kind === 'package' ? 'neutral' : 'clay');
const TILE_ICONS = { knowledge: 'knowledge', messaging: 'mail', tasks: 'tasks' };
const tileIcon = row => TILE_ICONS[row.layer] || (row.kind === 'package' ? 'package' : 'soul');

/** A workspace default ("Every soul"): the row is one of status.defaults.capabilities
 * not turned off, or fills its layer's default slot. Without reported defaults
 * nothing is claimed. */
function isWorkspaceDefault(status, row) {
  const defaults = status?.defaults;
  if (!defaults || typeof defaults !== 'object') return false;
  if (list(defaults.capabilities).some(cap => cap?.name === row.name && cap.off !== true)) return true;
  const slot = text(row.layer) ? defaults.slots?.[row.layer] : null;
  return !!(slot && typeof slot === 'object' && slot.name === row.name);
}

// Row ids for aria-describedby: unique in the document across every table rendered.
let rowIds = 0;
/** A section jump is navigation: the current one carries aria-current, the others none. */
const markCurrent = (button, current) => { if (current) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); };

/** The capability list: a column header, then one row card per capability —
 * icon tile | name + kind chip over a one-line description | used by | chevron. Used by: with
 * `composition` (the CLI reports each soul's composition, soulsComposition), the `souls` whose
 * composition includes it (soulsUsing); without, the souls whose instances carry it (the roster's module
 * rows, capabilityUse); "Every soul" for a workspace default either way. The source is the group heading
 * and the card's accessible name, not a column.
 * groups: groupCapabilities' [{ key, icon, name, note, rows }] adds a repository (or package) heading before each group.
 * onOpen(row): the card is one button opening the capability's page (click; Enter and Space are the
 * native button's). Its name is short ("<cap>, <kind>, from <source>"); its description and used-by
 * are its accessible description (aria-describedby), since the column header is for the eye only. */
/** `rosterState` (desktop/loading-states): the read the "Used by" cells derive from (the souls list and the roster,
 * one read) — 'ready' / 'empty' for a settled good read; while pending, failed or stale the cell makes no claim
 * (a muted "—" with the reason). */
export function renderCapabilities(host, { rows, groups = null, status, instances, souls = [], composition = false, root, total = list(rows).length, onOpen = null, label = 'Workspace capabilities', empty = null, rosterState = 'ready' }) {
  const doc = host.ownerDocument, names = memberNames(status);
  host.replaceChildren();
  const table = node(doc, 'div', null, 'catalog-table'); table.setAttribute('role', 'group'); table.setAttribute('aria-label', label);
  const any = list(rows).length || (groups && groups.some(group => group.rows.length));
  if (any) {
    // Each card names and describes its own columns to assistive tech; the header is for the eye.
    const head = node(doc, 'div', null, 'catalog-head'); head.setAttribute('aria-hidden', 'true');
    for (const label of ['', 'Capability', 'Used by', '']) head.append(node(doc, 'span', label));
    table.append(head);
  }
  const line = row => {
    const el = node(doc, 'button', null, 'catalog-row'); el.type = 'button';
    el.dataset.capability = row.name;
    const words = sourceText(row, names);
    el.setAttribute('aria-label', `${row.name}, ${text(row.layer) ? layerLabel(row.layer) : 'capability'}, from ${words.label}`);
    const id = `catalog-row-${++rowIds}`, described = [];
    if (typeof onOpen === 'function') {
      el.classList.add('openable');
      el.addEventListener('click', () => onOpen(row)); // the native button turns Enter and Space into this click
    } else el.disabled = true;
    const shade = tint(row);
    const tile = node(doc, 'span', null, 'catalog-tile'); tile.dataset.tint = shade; tile.setAttribute('aria-hidden', 'true');
    tile.append(iconElement(doc, tileIcon(row), { size: 16 }));
    const cap = node(doc, 'span', null, 'catalog-cap');
    const first = node(doc, 'span', null, 'catalog-cap-line');
    const name = node(doc, 'span', row.name, 'catalog-name'); name.title = row.name;
    first.append(name);
    if (text(row.layer)) { const core = node(doc, 'span', layerLabel(row.layer), 'catalog-core'); core.dataset.tint = shade; first.append(core); }
    cap.append(first);
    // Kernel #217: the manifest's description, one line; the page carries the whole text.
    if (text(row.description)) {
      const desc = node(doc, 'span', row.description, 'catalog-desc'); desc.title = row.description; desc.id = `${id}-desc`;
      described.push(desc.id); cap.append(desc);
    }
    const use = composition ? { souls: soulsUsing(souls, row) } : capabilityUse(instances, row.name);
    const staleTitle = composition ? SOULS_STALE_TITLE : ROSTER_STALE_TITLE;
    const used = node(doc, 'span', null, 'catalog-used');
    const marks = node(doc, 'span', null, 'catalog-used-marks'); marks.setAttribute('aria-hidden', 'true');
    const count = node(doc, 'span', null, 'catalog-used-count');
    const who = use.souls.map(soul => soul.key || soul.name).join(', ');
    if (isWorkspaceDefault(status, row)) {
      count.textContent = 'Every soul'; count.classList.add('every');
      count.title = `A workspace default: every soul starts with it${who ? ` (recorded by ${who})` : ''}`;
    } else if (use.souls.length) {
      for (const soul of use.souls.slice(0, 3)) marks.append(createSoulMark(doc, soul));
      count.textContent = `${use.souls.length} ${use.souls.length === 1 ? 'soul' : 'souls'}`; count.title = `Used by ${who}`;
    } else if (rosterState !== 'ready' && rosterState !== 'empty') {
      // The read is not settled-good: "Not used" would be a claim it cannot back.
      count.textContent = '—'; count.classList.add('none', 'unknown'); count.title = staleTitle; count.setAttribute('aria-description', staleTitle); count.dataset.rosterState = rosterState;
    } else { count.textContent = 'Not used'; count.classList.add('none'); count.title = composition ? 'No soul here includes it' : 'No instance carries it yet'; }
    // The marks are aria-hidden; assistive tech has no column header, so a count is read as "Used by …"
    // ("Not used" says it already).
    if (!count.classList.contains('none')) {
      const label = node(doc, 'span', 'Used by', 'workspace-sr-only'); label.id = `${id}-used-by`;
      described.push(label.id); used.append(label);
    }
    count.id = `${id}-used`; described.push(count.id);
    used.append(marks, count);
    el.setAttribute('aria-describedby', described.join(' '));
    el.append(tile, cap, used, iconElement(doc, 'chevronRight', { size: 16, className: 'shell-icon catalog-chevron' }));
    return el;
  };
  // A repository or package group (groupCapabilities) opens with the Souls tab's heading: icon, name, "member repo · N capabilities".
  if (groups) for (const group of groups) {
    if (!group.rows.length) continue; // a search that empties a group hides it
    const title = groupHeading(doc, { icon: group.icon, name: group.name, note: [group.note, capabilityCount(group.rows.length)].filter(Boolean).join(' · '), mono: group.mono !== false, level: 3 });
    title.classList.add('catalog-group'); title.dataset.repo = group.key;
    table.append(title, ...group.rows.map(line));
  } else for (const row of list(rows)) table.append(line(row));
  if (!any) table.append(node(doc, 'p', total ? 'No capabilities match these filters.' : empty || 'The workspace reports no capabilities yet: members publish capabilities and packages lock theirs on sync.', 'catalog-empty'));
  host.append(table);
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

/** The Capabilities tab, in two parts (2026-10-23): Workspace defaults when the kernel reports them
 * (workspace-defaults.mjs: `status.defaults`, never filtered; a section of its own, h2), then All capabilities
 * (`.capability-part`, h2): the section jump under its title, then its subsections (h3) Workspace owned (grouped
 * by repository, with its repository pills), Repo owned grouped the same way when the kernel lists it (feature
 * capabilities-private), then Packages grouped by package. `shown`: the Workspace owned rows the pills leave;
 * `filterHost` is the discovery's persistent pill row; `query` narrows every catalog section by name.
 * `souls` and `composition`: renderCapabilities' "Used by" inputs. */
export function renderCapabilitySections(host, { sections, shown, filterHost, privateListed, status, instances, souls = [], composition = false, root, onOpen = null, query = '', rosterState = 'ready' }) {
  const doc = host.ownerDocument, names = memberNames(status), hostKey = hostKeyOf(status);
  host.replaceChildren();
  const match = rows => matchCapabilities(rows, query);
  const table = (parent, rows, opts) => { const box = node(doc, 'div'); parent.append(box); renderCapabilities(box, { rows, status, instances, souls, composition, root, onOpen, rosterState, ...opts }); };
  // The workspace's defaults (null when the kernel reports none): matched against every catalog row, whatever the filters leave.
  const defaults = workspaceDefaults(status), allRows = [...sections.workspace, ...sections.repo, ...sections.packages];
  // The page's two parts (2026-10-23): Workspace defaults, then All capabilities, whose sections (Workspace owned,
  // Repo owned, Packages) are its subsections (h3).
  const section = (def, parent = host, level = 'h2') => {
    const el = node(doc, 'section', null, 'capability-section'); el.dataset.section = def.id;
    const head = node(doc, level, null, `capability-section-title${level === 'h2' ? ' capability-part-title' : ''}`); head.id = `capability-section-${def.id}`; head.tabIndex = -1;
    head.append(node(doc, 'span', def.title));
    if (def.lead) head.append(node(doc, 'span', def.lead, 'capability-section-lead'));
    // The title row (board 4): the title and its lead, then (Workspace owned) the repository pills at its right.
    const row = node(doc, 'div', null, 'capability-section-head'); row.append(head);
    el.setAttribute('aria-labelledby', head.id); el.append(row); parent.append(el); return el;
  };
  const defaultsDef = { id: 'defaults', title: DEFAULTS_COPY.title };
  const renderDefaults = el => renderWorkspaceDefaults(el, { status, rows: allRows, onOpen });
  // Nothing at all: one factual line, not three empty sections (the defaults, when reported, still say what every soul gets).
  if (!sections.workspace.length && !sections.packages.length && !sections.repo.length) {
    if (defaults) renderDefaults(section(defaultsDef));
    table(host, [], {}); return;
  }
  // Workspace owned → Repo owned (when listed) → Packages: the nav segments and the sections, in one order. The
  // defaults are a part of their own, never one of the sections' segments (the product owner, 2026-10-23).
  const defs = [
    { id: 'workspace', title: 'Workspace owned', lead: 'latest from member repos', count: sections.workspace.length },
    ...(privateListed ? [{ id: 'repo', title: 'Repo owned', lead: 'only for souls of the same repo', count: sections.repo.length }] : []),
    { id: 'packages', title: 'Packages', lead: 'pinned versions, same everywhere', count: sections.packages.length },
  ];
  // One segmented group (rule 1 look): the base class is the shell's; the segments are navigation, so
  // aria-current (not aria-pressed) marks the section in view.
  const nav = node(doc, 'nav', null, 'capability-nav ws-segmented'); nav.setAttribute('aria-label', 'Capability sections');
  for (const def of defs) {
    const jump = node(doc, 'button', null); jump.type = 'button'; jump.dataset.jump = def.id;
    jump.append(node(doc, 'span', def.title), node(doc, 'span', String(def.count), 'capability-nav-count'));
    markCurrent(jump, def.id === defs[0].id);
    jump.addEventListener('click', () => {
      const head = host.querySelector(`#capability-section-${def.id}`);
      for (const other of nav.querySelectorAll('button')) markCurrent(other, other === jump);
      head?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); head?.focus({ preventScroll: true });
    });
    nav.append(jump);
  }
  // The segments are All capabilities' own: under its title.
  const render = {
    defaults: renderDefaults,
    workspace: owned => {
      if (filterHost) owned.querySelector('.capability-section-head').append(filterHost);
      const groups = groupCapabilities(match(shown), names, hostKey);
      table(owned, groups.flatMap(g => g.rows), { groups, total: sections.workspace.length, label: 'Workspace owned capabilities', empty: 'No workspace repository offers a capability yet.' });
    },
    repo: repo => {
      if (!sections.repo.length) { repo.append(node(doc, 'p', 'No repository keeps a private capability.', 'catalog-empty capability-none')); return; }
      const groups = groupCapabilities(match(sections.repo), names, hostKey);
      table(repo, groups.flatMap(g => g.rows), { groups, label: 'Repo owned capabilities', total: sections.repo.length });
    },
    // Grouped by package, as the other sections are by repository: no section loses where its rows come from.
    packages: packages => {
      const groups = groupCapabilities(match(sections.packages), names, hostKey);
      table(packages, groups.flatMap(g => g.rows), { groups, total: sections.packages.length, label: 'Package capabilities', empty: 'No package capability is locked yet. Sync to lock the declared packages.' });
    },
  };
  if (defaults) render.defaults(section(defaultsDef));
  const all = node(doc, 'section', null, 'capability-part');
  const allHead = node(doc, 'h2', 'All capabilities', 'capability-part-title'); allHead.id = 'capability-part-all';
  // Its segments under its title, on a row of their own.
  all.setAttribute('aria-labelledby', allHead.id); all.append(allHead, nav); host.append(all);
  for (const def of defs) render[def.id](section(def, all, 'h3'));
}

/** The jump segment for the section at the top of the scroller (called on scroll): All capabilities' sections
 * only, so the defaults above them never make one current. The jump sits in `host`, under All capabilities'
 * title. The top is the pinned toolbar's bottom edge when `toolbar` sits in one (spec G), so a section under it
 * is not "in view"; else the scroller's own top. */
export function syncCapabilityNav(host, scroller, toolbar = null) {
  const nav = host.querySelector('.capability-nav'); if (!nav || !scroller?.getBoundingClientRect) return;
  const pinned = toolbar?.closest?.('.ws-sticky');
  const top = (pinned ? pinned.getBoundingClientRect().bottom : scroller.getBoundingClientRect().top) + 24;
  let current = null;
  for (const el of host.querySelectorAll('.capability-part .capability-section')) if (el.getBoundingClientRect().top <= top) current = el.dataset.section;
  current ||= host.querySelector('.capability-part .capability-section')?.dataset.section;
  for (const jump of nav.querySelectorAll('button')) markCurrent(jump, jump.dataset.jump === current);
}


