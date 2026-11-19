/** Workspace v4 Setup (the W1 list; the W2 graph was dropped in the Desktop UI rework, slice 3b): what the workspace shares through Git
 * (members, packages, defaults) above what lives only on this computer, under an
 * overview of what the host repository defines (design-brief.md §3.1, §8).
 * Presentation only, from `oats workspace status` (and the roster, the CLI
 * probe, the souls list): nothing is inferred and unreported facts are not
 * shown. Kernel #217 (desktop-facts) adds the files, this computer's clones,
 * available package versions, disabled souls, the lock file and the workspace
 * and team defaults as declared; each is shown only when reported. */
import { iconElement } from './shell-icons.mjs';
import { memberState, MEMBER_PROBLEMS } from './workspace-catalog.mjs';
import { packageOrigin } from '../../client/capability-facts.mjs';
import { sameRepo } from '../../client/repo-moves.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';

const capitalized = word => word.charAt(0).toUpperCase() + word.slice(1);

export const setupCSS = `
/* Type scale (spec "Type hierarchy", shared with the Teams tab): screen title 24/700, section 18/650,
   box title 15/650, primary facts 14/600 (counts 650), body 13, secondary 12 --muted, tags 11.5/600.
   Names are sans 600; mono only for secondary strings, 1px above the sans step it stands in for. */
.setup { display:flex; flex-direction:column; gap:16px; min-width:0; }
/* The list view (W1): one column, what the workspace shares through Git above what lives only here. */
.setup[data-view=list] { gap:40px; }
.setup-lede { display:flex; flex-direction:column; gap:6px; min-width:0; }
.setup-lede h2 { margin:0; color:var(--fg); font-size:24px; font-weight:700; line-height:1.2; letter-spacing:-.02em; overflow-wrap:anywhere; }
.setup-summary { margin:0; color:var(--muted); font-size:14px; line-height:1.45; overflow-wrap:anywhere; }
.setup-summary b { color:var(--fg); font-weight:650; font-variant-numeric:tabular-nums; }
.setup-summary b.warn { color:var(--warn); }
.setup-lede-where { margin:0; color:var(--muted); font-size:13px; line-height:1.45; min-width:0; overflow-wrap:anywhere; }
.setup-lede-where .mono { font-family:var(--mono,monospace); font-size:14px; }
.setup-lede-where .strong, .setup-lede-where span.mono { color:var(--fg); }
.oats-view .setup .setup-lede-where button.setup-file { font-size:14px; }
/* Overview for everyone; the membership mechanics folded under "For developers". */
.setup-explain { display:flex; flex-direction:column; gap:6px; min-width:0; padding:16px 20px; box-sizing:border-box; border:1px solid var(--border); border-radius:12px; background:var(--surface); }
.setup-explain h3 { margin:0; color:var(--fg); font-size:15px; font-weight:650; }
.setup-explain-ov { margin:0; max-width:92ch; color:var(--fg); font-size:14px; line-height:1.55; overflow-wrap:anywhere; }
.setup-explain-ov b { font-weight:650; }
.setup-explain-dev { margin-top:8px; padding-top:10px; border-top:1px solid var(--border); min-width:0; }
.setup-explain-dev > summary { display:inline-flex; align-items:center; gap:6px; list-style:none; cursor:pointer; border-radius:4px; color:var(--muted); font-size:12.5px; font-weight:600; }
.setup-explain-dev > summary::-webkit-details-marker { display:none; }
.setup-explain-dev > summary:hover { color:var(--fg); }
.setup-explain-dev > summary .shell-icon { flex:none; transition:transform .15s; }
.setup-explain-dev[open] > summary .shell-icon { transform:rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .setup-explain-dev > summary .shell-icon { transition:none; } }
.setup-explain-body { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px 32px; align-items:center; padding-top:12px; min-width:0; }
.setup-explain-body > p { margin:0; max-width:62ch; color:var(--fg); font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
.setup-explain-body > p .mono { font-family:var(--mono,monospace); font-size:14px; }
.setup-hs { display:grid; grid-template-columns:auto auto auto; gap:10px; align-items:center; justify-self:start; margin:0; min-width:0; }
.setup-hs-repo { display:flex; flex-direction:column; gap:2px; min-width:0; max-width:220px; padding:9px 12px; box-sizing:border-box; border:1px solid var(--border); border-radius:9px; background:var(--surface-2); }
.setup-hs-role { color:var(--muted); font-size:12px; }
.setup-hs-name { color:var(--fg); font-size:14px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.setup-hs-line { color:var(--muted); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.setup-hs-line span { color:var(--fg); }
.setup-hs-links { display:flex; flex-direction:column; gap:8px; color:var(--muted); font-size:12px; font-weight:600; }
.setup-hs-arrow { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
.setup-hs-arrow.back { justify-content:flex-end; }
.setup-hs-arrow .shell-icon { flex:none; color:var(--accent); }
.setup-explain-states { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:6px 18px; margin:0; min-width:0; }
.setup-explain-states > div { display:flex; align-items:center; gap:7px; min-width:0; }
.setup-explain-states dt { display:flex; }
.setup-explain-states dd { margin:0; color:var(--muted); font-size:12.5px; }
@container (max-width: 859.98px) { .setup-explain-body { grid-template-columns:minmax(0,1fr); } }
/* A section: its heading at the section step and one muted line, then its boxes. */
.setup-sec { display:flex; flex-direction:column; gap:14px; min-width:0; }
.setup-sec-head { display:flex; flex-direction:column; gap:2px; min-width:0; }
.setup-sec-title { margin:0; color:var(--fg); font-size:18px; font-weight:650; line-height:1.25; letter-spacing:-.01em; }
.setup-sec-lead { margin:0; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
/* This computer: a zone, not a box (what is not shared); its boxes are solid cards on it. */
.setup-zone { display:flex; flex-direction:column; gap:18px; min-width:0; padding:18px 20px 20px; box-sizing:border-box; border:1px dashed var(--tree-line); border-radius:12px; background:var(--surface-2); }
.setup-here-clones > h4 { margin:0 0 8px; color:var(--fg); font-size:15px; font-weight:650; }
.setup-facts { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:14px 24px; margin:0; min-width:0; }
.setup-fact { display:flex; flex-direction:column; gap:2px; min-width:0; }
.setup-fact dt { color:var(--muted); font-size:12px; }
.setup-fact dd { margin:0; color:var(--fg); font-size:13px; overflow-wrap:anywhere; }
.setup-fact dd.mono { font-weight:normal; font-size:14px; line-height:normal; font-family:var(--mono,monospace); }
.setup-fact dd.prim { font-size:15px; font-weight:650; font-variant-numeric:tabular-nums; }
.setup-fact dd.warn { color:var(--warn); }
.setup-clones { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:4px 24px; margin:0; min-width:0; }
.setup-clone { display:flex; align-items:baseline; gap:10px; min-width:0; }
.setup-clone dt { flex:0 1 auto; min-width:90px; max-width:45%; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.setup-clone dd { flex:1 1 0; margin:0; min-width:0; color:var(--fg); font-weight:normal; font-size:14px; line-height:normal; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.setup-clone dd.warn { color:var(--warn); font-weight:normal; font-size:13px; font-family:var(--ui-font,system-ui); line-height:1.45; }
.setup-clone dd.muted { color:var(--muted); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--ui-font,system-ui); }
/* A box: its title and a muted lead, then rows. Its own width lays out its rows (setup-rows). */
.setup-box { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; min-width:0; container:setup-rows / inline-size; }
.setup-box-head { display:flex; align-items:baseline; flex-wrap:wrap; gap:2px 10px; padding:16px 20px 10px; box-sizing:border-box; min-width:0; }
.setup-box-head :is(h3, h4) { margin:0; flex:none; color:var(--fg); font-size:15px; font-weight:650; }
.setup-box-head .shell-icon { flex:none; align-self:center; color:var(--muted); }
.setup-box-lead { flex:1 1 320px; min-width:0; color:var(--muted); font-size:12.5px; overflow-wrap:anywhere; }
/* One grid per box, each row a subgrid of it, so the columns line up down the box. */
.setup-rows { display:grid; column-gap:16px; min-width:0; }
.setup-rows[data-rows=members] { grid-template-columns:minmax(0,1.2fr) 128px minmax(0,1fr) 44px; }
.setup-rows[data-rows=packages] { grid-template-columns:minmax(0,1.1fr) 120px minmax(0,1.2fr) 112px; }
.setup-row { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; align-items:center; min-height:40px; padding:0 20px; box-sizing:border-box; border-top:1px solid var(--border); }
.setup-row > * { min-width:0; }
.setup-sub { grid-column:1 / -1; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; padding:14px 20px 6px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
.setup-sub h5 { margin:0; color:var(--fg); font-size:13px; font-weight:650; }
.setup-name { display:flex; align-items:center; gap:8px; min-width:0; }
.setup-name .shell-icon { flex:none; color:var(--muted); }
.setup-name-text { min-width:0; color:var(--fg); font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.setup-version { flex:none; color:var(--muted); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); }
/* The host's tag (Host · its file, accent tint): the name gives way, never the tag. */
.setup-badge { display:inline-flex; align-items:center; gap:4px; flex:none; height:20px; padding:0 7px; box-sizing:border-box; border-radius:5px; font-weight:600; font-size:11.5px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
.setup-badge.host { background:var(--sel); color:var(--accent); }
.setup-badge .mono { font-family:var(--mono,monospace); font-size:12.5px; font-weight:500; }
/* A member's state: confirmed is a check and a muted word; anything else a warn chip. */
.setup-state { display:inline-flex; align-items:center; gap:5px; justify-self:start; color:var(--muted); font-size:12px; white-space:nowrap; }
.setup-state .shell-icon { flex:none; color:var(--ok); }
.setup-state.warn { height:20px; padding:0 7px; box-sizing:border-box; border-radius:5px; background:var(--attn-bg); color:var(--warn); font-size:11.5px; font-weight:650; }
.setup-cell { color:var(--fg); font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.setup-cell.muted { color:var(--muted); font-size:12px; }
.setup-end { justify-self:end; color:var(--muted); font-size:12px; white-space:nowrap; }
.setup-end.newer { color:var(--fg); font-size:13px; font-weight:650; }
.setup-end.warn { color:var(--warn); font-size:13px; font-weight:650; }
.oats-view .setup button.setup-link-act { justify-self:end; height:auto; min-height:0; padding:2px 0; border:0; background:transparent; color:var(--accent); font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .setup button.setup-link-act:hover { text-decoration:underline; }
.oats-view .setup button.setup-link-act:focus-visible { background:var(--sel); border-radius:4px; padding:2px 4px; margin:0 -4px; } /* layout-neutral inset */
/* Narrow (the box under 860px): two lines per row. Line one the name, with the state (Members) or the
   end cell (Packages) on the right; line two the contribution or what it provides, with Why? on the right. */
@container setup-rows (max-width: 859.98px) {
 .setup-rows[data-rows] { grid-template-columns:minmax(0,1fr) auto; }
 .setup-rows[data-rows] .setup-row { row-gap:2px; padding:8px 20px; }
 .setup-rows[data-rows] .setup-row > :nth-child(1) { grid-row:1; grid-column:1; }
 .setup-rows[data-rows] .setup-row > :nth-child(3) { grid-row:2; grid-column:1; }
 .setup-rows[data-rows=members] .setup-row > :nth-child(2) { grid-row:1; grid-column:2; justify-self:end; }
 .setup-rows[data-rows=members] .setup-row > :nth-child(4) { grid-row:2; grid-column:2; }
 .setup-rows[data-rows=packages] .setup-row > :nth-child(2) { display:none; }
 .setup-rows[data-rows=packages] .setup-row > :nth-child(3) { grid-column:1 / -1; }
 .setup-rows[data-rows=packages] .setup-row > :nth-child(4) { grid-row:1; grid-column:2; }
}
.setup-empty { margin:0; padding:14px 20px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
.setup-team { display:flex; flex-direction:column; gap:4px; padding:10px 20px; border-top:1px solid var(--border); }
.setup-team-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.setup-team-label { display:inline-flex; align-items:center; height:22px; padding:0 8px; border-radius:5px; background:var(--tag-bg); color:var(--fg); font-size:12px; font-weight:650; }
.setup-team-meta { color:var(--muted); font-size:11.5px; }
.setup-team-warn { color:var(--warn); font-size:11.5px; line-height:1.45; }
/* Defaults (desktop-facts): what the workspace file gives every soul, and each team adds. */
.setup-def-rows { display:flex; flex-direction:column; gap:6px; margin:0; padding:4px 20px 16px; }
.setup-def { display:grid; grid-template-columns:110px minmax(0,1fr); gap:12px; align-items:baseline; }
.setup-def dt { color:var(--muted); font-size:12px; }
.setup-def dd { margin:0; min-width:0; display:flex; flex-wrap:wrap; gap:4px 16px; color:var(--fg); font-size:13px; }
.setup-def dd.muted { color:var(--muted); }
.setup-def-cap { display:inline-flex; align-items:baseline; gap:5px; min-width:0; overflow-wrap:anywhere; }
.setup-def-name { font-weight:600; font-size:13.5px; line-height:normal; font-family:var(--ui-font,system-ui); color:var(--fg); }
.setup-def-from { color:var(--muted); font-size:12px; }
.setup-def-cap.off .setup-def-name { color:var(--muted); text-decoration:line-through; }
.setup-team-adds { display:flex; flex-wrap:wrap; gap:2px 12px; color:var(--muted); font-size:11.5px; line-height:1.45; }
.setup-team-adds > span { display:inline-flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; min-width:0; }
.setup-team-note { margin:0; padding:10px 20px; border-top:1px solid var(--border); color:var(--muted); font-size:11.5px; line-height:1.5; }
.oats-view .setup button.setup-file { height:auto; min-height:0; padding:0; border:0; background:transparent; color:var(--accent); font:inherit; font-family:var(--mono,monospace); text-decoration:underline; text-underline-offset:2px; cursor:pointer; overflow-wrap:anywhere; text-align:left; }
.oats-view .setup button.setup-file:focus-visible { background:var(--sel); border-radius:4px; padding:0 3px; margin:0 -3px; }
/* A member's panel (opened from its row in Members): the handshake, what it means, the kernel's detail. It spans
   the box under its row. */
.setup-row-panel { grid-column:1 / -1; padding:4px 20px 16px; }
.setup-panel { display:flex; flex-direction:column; min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
.setup-panel-head { display:flex; align-items:center; gap:8px; min-height:48px; padding:0 10px 0 16px; box-sizing:border-box; border-bottom:1px solid var(--border); }
.setup-panel-head h3 { margin:0; color:var(--fg); font-size:13px; font-weight:650; }
.oats-view .setup-panel-head button.icon-act { margin-left:auto; width:28px; height:28px; min-height:28px; padding:0; display:grid; place-items:center; }
.setup-panel-body { display:flex; flex-direction:column; gap:20px; padding:18px 16px; }
.setup-panel-id { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
.setup-panel-name { color:var(--fg); font-weight:700; font-size:15px; line-height:normal; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.setup-panel section { display:flex; flex-direction:column; gap:8px; }
.setup-panel h4 { margin:0; color:var(--muted); font-size:12px; font-weight:600; }
.setup-hand { border:1px solid var(--border); border-radius:8px; overflow:hidden; }
.setup-hand-row { display:flex; gap:10px; padding:10px 12px; }
.setup-hand-row + .setup-hand-row { border-top:1px solid var(--tag-bg); }
.setup-hand-mark { flex:none; width:13px; padding-top:2px; color:var(--fg); font-weight:700; line-height:1; }
.setup-hand-mark.warn { color:var(--warn); }
.setup-hand-mark.unknown { color:var(--muted); }
.setup-hand-copy { display:flex; flex-direction:column; gap:2px; min-width:0; }
.setup-hand-title { color:var(--fg); font-size:12.5px; font-weight:600; }
.setup-hand-sub { color:var(--muted); font-size:11.5px; overflow-wrap:anywhere; }
.setup-panel p { margin:0; color:var(--fg); font-size:12.5px; line-height:1.55; }
.setup-panel p.muted { color:var(--muted); font-size:11.5px; line-height:1.5; }
.setup-panel p.warn { color:var(--warn); }
.setup-panel p.mono { font-size:12px; overflow-wrap:anywhere; }
.setup-panel-acts { display:flex; flex-wrap:wrap; gap:8px; }
.setup-panel .mono { font-family:var(--mono,monospace); }
.setup-detail { padding:10px 12px; border-radius:8px; background:var(--surface-2); color:var(--fg); font-weight:normal; font-size:12px; line-height:1.6; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
`;

const list = v => Array.isArray(v) ? v : [];
const text = v => typeof v === 'string' && v ? v : null;
const short = v => typeof v === 'string' && /^[0-9a-f]{7,}$/i.test(v) ? v.slice(0, 7) : v;
const tail = v => String(v || '').split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || String(v || '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function el(doc, tag, value, cls) {
  const node = doc.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  if (cls) node.className = cls;
  return node;
}

/** A member's handshake state: a check and a muted "confirmed", or the state's label as a warn chip. */
function stateChip(doc, member) {
  const state = memberState(member);
  const chip = el(doc, 'span', null, `setup-state${state.ok ? '' : ' warn'}`);
  if (state.ok) chip.append(iconElement(doc, 'check', { size: 13 }));
  chip.append(el(doc, 'span', state.label));
  chip.dataset.state = state.status;
  return chip;
}
const memberName = member => text(member?.name) || tail(member?.key);
const webUrl = v => typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
const fileRef = v => text(v?.path) ? v : null;
/** A file the kernel names ({ path, url }): its path, a link when it has a web address. */
function fileName(doc, file, openExternal) {
  const url = webUrl(file.url);
  if (!url || !openExternal) { const name = el(doc, 'span', file.path, 'mono'); name.title = file.path; return name; }
  const link = el(doc, 'button', file.path, 'setup-file'); link.type = 'button'; link.title = url;
  link.setAttribute('aria-label', `Open ${file.path}`); link.addEventListener('click', () => openExternal(url));
  return link;
}
/** A path under the deployment folder, relative to it. */
const within = (path, folder) => folder && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;
/** A newer version of a catalog package than the lock holds (packages[].latest). */
const available = pkg => text(pkg?.latest?.version) ? pkg.latest : null;
/** What a member contributes, or why it contributes nothing yet. */
function contribution(member) {
  const state = memberState(member), souls = list(member.souls).length, caps = list(member.capabilities).length;
  if (!state.ok) return { text: souls ? `${plural(souls, 'soul')} hidden until it ${member.status === 'cannot-read' ? 'can be read' : 'joins'}` : `contributes nothing until it ${member.status === 'cannot-read' ? 'can be read' : 'joins'}`, muted: true };
  const parts = [souls ? plural(souls, 'soul') : null, caps ? plural(caps, 'capability', 'capabilities') : null].filter(Boolean);
  return { text: parts.join(' · ') || 'nothing yet', muted: !parts.length };
}
/** The lock in workspace status terms: current, or what is out of date. */
export function lockText(status) {
  const unsynced = list(status?.unsynced).length, stale = list(status?.stale).length;
  if (!unsynced && !stale) return { text: 'current', warn: false };
  return { text: ['out of date', unsynced ? `${unsynced} not locked` : null, stale ? `${stale} no longer declared` : null].filter(Boolean).join(' · '), warn: true };
}
/** A box: its title (an h3, or the level `heading` names) and a muted lead. The section or zone a box
 * sits in says what is shared, so the box doesn't repeat it. */
export function box(doc, title, lead, { heading = 'h3' } = {}) {
  const card = el(doc, 'section', null, 'setup-box'); card.dataset.box = title;
  const head = el(doc, 'div', null, 'setup-box-head');
  head.append(el(doc, heading === 'h4' ? 'h4' : 'h3', title));
  if (lead) head.append(el(doc, 'span', lead, 'setup-box-lead'));
  card.append(head);
  return card;
}

/** Whether "For developers" is open, per tab host: it lasts across the tab's re-renders (and other tabs
 * drawn in the same host), for this run only. The tab may clear its host before a render, and a native
 * toggle's event is queued: a press records the choice at once, and only the host's current details
 * element may record one, so a superseded element's late event never overwrites it. */
const developersOpen = new WeakMap(), developersDrawn = new WeakMap();

/** The whole Setup tab: the list (members and their handshake, packages pinned and locked, the defaults as declared,
 * this computer). `selected`: a member key whose panel is open under its row (`onSelect(key | null)` opens or closes one). */
export function renderSetup(host, { status, instances = [], cli = null, selected = null, onSelect = () => {}, openExternal = null }) {
  const doc = host.ownerDocument;
  const drawn = host.querySelector('.setup-explain-dev');
  if (drawn) developersOpen.set(host, drawn.open);
  host.replaceChildren();
  const root = el(doc, 'div', null, 'setup'); root.dataset.view = 'list';
  root.append(lede(doc, status, openExternal), explainer(doc, status, host),
    sharedSection(doc, { status, selected, onSelect, openExternal }), hereZone(doc, { status, instances, cli }));
  host.append(root);
  return root;
}

/** The workspace's host repository by name (the lede's), or null without a workspace key. */
function hostName(status) {
  const ws = status?.workspace || {};
  if (!text(ws.key)) return null;
  const host = list(status?.members).find(m => sameRepo(m.key, ws.key));
  return host ? memberName(host) : tail(ws.url || ws.key);
}

/** The workspace's name, then the summary (members, those that need attention, packages, the lock) and
 * "Declared in <host>'s <workspace file> at <commit>.", naming the file when the kernel reports it
 * (workspace.file); the Desktop never guesses a file name. */
function lede(doc, status, openExternal) {
  const ws = status?.workspace || {};
  const head = el(doc, 'div', null, 'setup-lede');
  head.append(el(doc, 'h2', text(ws.name) || 'Workspace'));
  const members = list(status?.members), attention = members.filter(m => !memberState(m).ok).length;
  // The Packages box's rows: the locked packages and the declared ids not locked yet.
  const packages = new Set([...list(status?.packages).map(p => p?.id), ...list(status?.unsynced)]).size;
  const lock = lockText(status);
  const summary = el(doc, 'p', null, 'setup-summary');
  summary.append(el(doc, 'b', plural(members.length, 'member')));
  if (attention) summary.append(', ', el(doc, 'b', `${attention} ${attention === 1 ? 'needs' : 'need'} attention`, 'warn'));
  summary.append('; ', el(doc, 'b', plural(packages, 'package')), '; lock ', el(doc, 'b', lock.text, lock.warn ? 'warn' : null), '.');
  head.append(summary);
  const name = hostName(status);
  if (name) {
    const where = el(doc, 'p', null, 'setup-lede-where'); where.title = ws.url || ws.key;
    where.append('Declared in ', el(doc, 'span', name, 'mono strong'));
    const file = fileRef(ws.file);
    if (file) where.append("'s ", fileName(doc, file, openExternal)); else where.append("'s workspace file");
    if (text(ws.commit)) { where.append(' at '); const c = el(doc, 'span', short(ws.commit), 'mono'); c.title = ws.commit; where.append(c); }
    where.append('.');
    head.append(where);
  }
  return head;
}

/** The overview (the host defines the workspace) and, folded, how a repository becomes a member: the two
 * links by the file names the kernel reports (workspace.file, a member's membershipFile), generic words
 * otherwise, a drawing of them, and what each state chip means. */
function explainer(doc, status, host) {
  const ws = status?.workspace || {}, name = hostName(status), members = list(status?.members);
  const card = el(doc, 'section', null, 'setup-explain');
  card.append(el(doc, 'h3', 'Overview'));
  const overview = el(doc, 'p', null, 'setup-explain-ov');
  if (name) overview.append('The host repository, ', el(doc, 'b', name), ', defines');
  else overview.append('The host repository defines');
  overview.append(' this OATS workspace: which repositories are its members and which packages it uses.');
  card.append(overview);
  const dev = el(doc, 'details', null, 'setup-explain-dev'); dev.open = developersOpen.get(host) === true;
  developersDrawn.set(host, dev);
  const current = () => developersDrawn.get(host) === dev;
  dev.addEventListener('toggle', () => { if (current()) developersOpen.set(host, dev.open); });
  const summary = el(doc, 'summary');
  // A press (Enter and Space press it too) toggles after this handler unless cancelled: record the outcome now.
  summary.addEventListener('click', event => { if (current() && !event.defaultPrevented) developersOpen.set(host, !dev.open); });
  summary.append(iconElement(doc, 'chevronRight', { size: 13 }), el(doc, 'span', 'For developers: how a repository becomes a member'));
  const body = el(doc, 'div', null, 'setup-explain-body');
  const wsFile = fileRef(ws.file), memberFile = members.map(m => fileRef(m?.membershipFile)).find(Boolean);
  const named = (file, words) => file ? el(doc, 'span', file.path, 'mono') : words;
  const how = el(doc, 'p');
  how.append("The host's ", named(wsFile, 'workspace file'), " lists each member, and each member's ", named(memberFile, 'membership file'),
    ' names the workspace back. A member counts only when both links are in place.');
  // The drawing repeats the paragraph with an example member: the first confirmed one that isn't the host.
  const others = members.filter(m => !text(ws.key) || !sameRepo(m?.key, ws.key));
  const example = others.find(m => memberState(m).ok) || others[0];
  const sample = example ? memberName(example) : 'a member repo', hostWord = name || 'the host repo';
  const repo = (role, title, key, value) => {
    const box = el(doc, 'div', null, 'setup-hs-repo'), line = el(doc, 'span', `${key}: `, 'setup-hs-line');
    line.append(el(doc, 'span', value)); box.append(el(doc, 'span', role, 'setup-hs-role'), el(doc, 'span', title, 'setup-hs-name'), line);
    return box;
  };
  const drawing = el(doc, 'figure', null, 'setup-hs'); drawing.setAttribute('aria-hidden', 'true');
  const links = el(doc, 'div', null, 'setup-hs-links');
  const lists = el(doc, 'span', 'lists', 'setup-hs-arrow'); lists.append(iconElement(doc, 'arrowRight', { size: 14 }));
  const back = el(doc, 'span', null, 'setup-hs-arrow back'); back.append(iconElement(doc, 'arrowLeft', { size: 14 }), 'names back');
  links.append(lists, back);
  drawing.append(repo('Host', hostWord, 'members', sample), links, repo('Member', sample, 'workspace', hostWord));
  // Each state, by the same chip its row shows, and what it means (workspace-catalog.mjs keeps both).
  const states = el(doc, 'dl', null, 'setup-explain-states');
  for (const problem of MEMBER_PROBLEMS) {
    const item = el(doc, 'div'), dt = el(doc, 'dt'); dt.append(stateChip(doc, { status: problem }));
    item.append(dt, el(doc, 'dd', memberState({ status: problem }).meaning)); states.append(item);
  }
  body.append(how, drawing, states);
  dev.append(summary, body); card.append(dev);
  return card;
}

/** The host's badge: Host, and the workspace file it holds (a link when it has a web address). */
function hostBadge(doc, status, openExternal) {
  const badge = el(doc, 'span', 'Host', 'setup-badge host'), file = fileRef(status?.workspace?.file);
  if (file) { const name = fileName(doc, file, openExternal); name.classList.add('mono'); badge.append(el(doc, 'span', '·'), name); }
  return badge;
}
/** A section: its heading and one muted line. */
function section(doc, cls, title, lead) {
  const sec = el(doc, 'section', null, cls), head = el(doc, 'div', null, 'setup-sec-head');
  head.append(el(doc, 'h3', title, 'setup-sec-title'), el(doc, 'p', lead, 'setup-sec-lead'));
  sec.append(head);
  return sec;
}
/** An external soul's source in the Members box: its repository's tail and the team it joins. One place, so
 * the switch to the kernel's sourceDisplay (#1111) is one edit. */
const externalSource = item => [tail(String(item?.source || '').replace(/@[^@/]*$/, '')), text(item?.team)].filter(Boolean).join(', ');

/** Shared through Git: what the workspace declares (members, packages, defaults). */
function sharedSection(doc, { status, selected, onSelect, openExternal }) {
  const ws = status?.workspace || {};
  const shared = section(doc, 'setup-sec', 'Shared through Git', 'What the workspace declares: the same on every computer that runs it.');
  shared.dataset.zone = 'shared';
  // Members: the repositories the workspace trusts for souls and capabilities, always at their latest.
  const members = box(doc, 'Members', 'Each repository and whether both of its links are in place.', { heading: 'h4' });
  const memberRows = el(doc, 'div', null, 'setup-rows'); memberRows.dataset.rows = 'members';
  // The host first (it is a member too); the others in the kernel's order.
  const isHost = m => !!text(ws.key) && sameRepo(m?.key, ws.key);
  for (const member of [...list(status?.members)].sort((a, b) => isHost(b) - isHost(a))) {
    const row = el(doc, 'div', null, 'setup-row'); row.dataset.member = member.key;
    const name = el(doc, 'span', null, 'setup-name'); name.append(iconElement(doc, 'repo', { size: 15 }));
    const label = el(doc, 'span', memberName(member), 'setup-name-text'); label.title = member.key; name.append(label);
    if (isHost(member)) name.append(hostBadge(doc, status, openExternal));
    const gives = contribution(member), state = memberState(member);
    const cell = el(doc, 'span', gives.text, `setup-cell${gives.muted ? ' muted' : ''}`); cell.title = gives.text;
    row.append(name, stateChip(doc, member), cell);
    // Every member opens its panel under its row: "Why?" when its handshake needs attention, else "Details".
    const open = member.key === selected;
    const act = el(doc, 'button', state.ok ? 'Details' : 'Why?', 'setup-link-act'); act.type = 'button';
    act.setAttribute('aria-label', state.ok ? `${memberName(member)}: its membership` : `${memberName(member)}: why it ${state.why}`);
    act.setAttribute('aria-expanded', String(open)); act.dataset.focusKey = `member:${member.key}`;
    act.addEventListener('click', () => onSelect(open ? null : member.key)); row.append(act);
    memberRows.append(row);
    if (open) {
      const holder = el(doc, 'div', null, 'setup-row-panel'); holder.dataset.memberPanel = member.key;
      holder.append(memberPanel(doc, member, { status, onClose: () => onSelect(null), openExternal }));
      memberRows.append(holder);
    }
  }
  // External souls: listed by the workspace from a repository it does not take as a member.
  const external = list(status?.external);
  if (external.length) {
    const sub = el(doc, 'div', null, 'setup-sub');
    sub.append(el(doc, 'h5', 'External souls'), el(doc, 'span', 'listed by the workspace from repositories that are not members'));
    memberRows.append(sub);
  }
  for (const item of external) {
    const row = el(doc, 'div', null, 'setup-row'); row.dataset.external = text(item.soul) || '';
    const name = el(doc, 'span', null, 'setup-name'); name.append(iconElement(doc, 'repo', { size: 15 }));
    const label = el(doc, 'span', text(item.soul) || 'soul', 'setup-name-text'); label.title = text(item.source) || ''; name.append(label);
    const source = externalSource(item), from = el(doc, 'span', source, 'setup-cell muted'); from.title = source;
    row.append(name, el(doc, 'span', 'external soul', 'setup-cell muted'), from, el(doc, 'span', '', 'setup-end'));
    memberRows.append(row);
  }
  if (!list(status?.members).length) members.append(el(doc, 'p', 'No member repositories reported.', 'setup-empty'));
  if (memberRows.children.length) members.append(memberRows);
  // Packages: versioned bundles, pinned here and fingerprinted in the lock.
  const packages = box(doc, 'Packages', 'Versioned bundles, pinned here and fingerprinted in the lock.', { heading: 'h4' });
  const packageRows = el(doc, 'div', null, 'setup-rows'); packageRows.dataset.rows = 'packages';
  const packageRow = (id, version, originText, originTitle, caps, end) => {
    const row = el(doc, 'div', null, 'setup-row'); row.dataset.package = id;
    const name = el(doc, 'span', null, 'setup-name'); name.append(iconElement(doc, 'package', { size: 15 }), el(doc, 'span', id, 'setup-name-text'));
    if (version) name.append(el(doc, 'span', version, 'setup-version'));
    const origin = el(doc, 'span', originText, 'setup-cell muted'); origin.title = originTitle;
    // Narrow rows hide the origin column: the provides cell's title still says it.
    const provides = el(doc, 'span', caps, 'setup-cell'); provides.title = [caps, originText ? `(${originText})` : null].filter(Boolean).join(' ');
    row.append(name, origin, provides, end); packageRows.append(row);
  };
  for (const pkg of list(status?.packages)) {
    const newer = available(pkg), end = el(doc, 'span', newer ? `${newer.version} available` : 'locked', `setup-end${newer ? ' newer' : ''}`);
    if (newer) end.title = `The official catalog has ${pkg.id} ${newer.version}${text(newer.ref) ? ` (${newer.ref})` : ''}; the lock holds ${pkg.version}.`;
    packageRow(pkg.id, text(pkg.version), packageOrigin(pkg.source) || '', text(pkg.source) || '', list(pkg.capabilities).join(', '), end);
  }
  for (const id of list(status?.unsynced)) packageRow(id, null, 'declared', '', '', el(doc, 'span', 'not locked · Sync', 'setup-end warn'));
  if (packageRows.children.length) packages.append(packageRows);
  else packages.append(el(doc, 'p', 'No packages declared.', 'setup-empty'));
  // Defaults: as the workspace file declares them (defaults), not resolved for a soul.
  shared.append(...[members, packages, defaultsBox(doc, status)].filter(Boolean));
  return shared;
}

/** This computer: what is not shared (this deployment's settings, lock, CLI and agents, the member clones). The
 * machines that run the workspace are the Workspace page's Machines tab (workspace-machines.mjs). */
function hereZone(doc, { status, instances, cli }) {
  const ws = status?.workspace || {};
  const zone = section(doc, 'setup-zone', 'This computer', "Not shared: this deployment's own settings and clones. The computers it runs on are under Machines.");
  zone.dataset.zone = 'here';
  const facts = el(doc, 'dl', null, 'setup-facts');
  const fact = (key, value, cls = '', title = value) => { if (!text(value)) return; const r = el(doc, 'div', null, 'setup-fact'); r.dataset.fact = key; const dd = el(doc, 'dd', value, cls); dd.title = title; r.append(el(doc, 'dt', key), dd); facts.append(r); };
  const settings = text(ws.local), folder = settings ? settings.replace(/\/[^/]+$/, '') : null;
  fact('Folder', folder, 'mono');
  fact('Settings', settings ? settings.split('/').pop() : null, 'mono', settings);
  const lock = lockText(status); fact('Lock', lock.text, `prim${lock.warn ? ' warn' : ''}`);
  if (text(status?.lock?.path)) fact('Lock file', within(status.lock.path, folder), 'mono', `${status.lock.path} · lockfile version ${status.lock.lockfileVersion}`);
  fact('CLI', text(cli?.version) ? `oats ${cli.version}` : null, 'prim');
  const all = list(instances), running = all.filter(i => i?.running === true).length;
  fact(capitalized(DESKTOP_NOUNS.instances), all.length ? `${all.length}, ${running} running` : 'none yet', 'prim');
  const disabled = list(status?.disabledSouls).filter(text);
  if (disabled.length) fact('Disabled souls', disabled.join(', '), 'mono');
  zone.append(facts);
  // Clones: where each member is checked out here (clones[]), or why it is not.
  const clones = list(status?.clones).filter(row => text(row?.key));
  if (clones.length) {
    const names = new Map(list(status?.members).map(m => [m.key, memberName(m)]));
    const part = el(doc, 'div', null, 'setup-here-clones'), rows = el(doc, 'dl', null, 'setup-clones'); rows.setAttribute('aria-label', 'Member clones');
    for (const clone of clones) {
      const r = el(doc, 'div', null, 'setup-clone'); r.dataset.clone = clone.key;
      const where = cloneText(clone, folder), dd = el(doc, 'dd', where.text, where.cls); dd.title = where.title;
      r.append(el(doc, 'dt', names.get(clone.key) || text(clone.name) || tail(clone.key)), dd); rows.append(r);
    }
    part.append(el(doc, 'h4', 'Member clones'), rows); zone.append(part);
  }
  return zone;
}

/** The Workspace's Teams tab before team model v2 (0.29): the labels the workspace declares,
 * how many souls take each, what each adds to the defaults, and the kernel's warnings about them. */
export function teamsBox(doc, { status, souls = [] }) {
  const ws = status?.workspace || {};
  const teams = box(doc, 'Teams', null);
  const unmapped = new Map(list(status?.warnings).filter(w => w?.code === 'unmapped-team-label' && text(w.label)).map(w => [w.label, w]));
  for (const label of list(ws.teams).filter(text)) {
    const row = el(doc, 'div', null, 'setup-team'); row.dataset.team = label;
    const head = el(doc, 'div', null, 'setup-team-head'); head.append(el(doc, 'span', label, 'setup-team-label'));
    const count = list(souls).filter(s => s?.team === label).length;
    head.append(el(doc, 'span', plural(count, 'soul'), 'setup-team-meta'));
    row.append(head);
    // What the team adds to (or turns off from) the workspace defaults (defaults.byTeam).
    const adds = teamDefaults(doc, status, label);
    if (adds) row.append(adds);
    // The kernel's own warning about this label, verbatim.
    if (text(unmapped.get(label)?.message)) row.append(el(doc, 'span', unmapped.get(label).message, 'setup-team-warn'));
    teams.append(row);
  }
  if (!list(ws.teams).length) teams.append(el(doc, 'p', 'The workspace declares no teams.', 'setup-empty'));
  teams.append(el(doc, 'p', 'Teams organise and add defaults. They never restrict what a soul can do.', 'setup-team-note'));
  return teams;
}

/** One clone row: its path (relative to the deployment), the kernel's refusal, or not cloned. */
function cloneText(clone, folder) {
  if (text(clone?.problem?.message)) return { text: clone.problem.message, cls: 'warn wrap', title: clone.problem.code || '' };
  if (text(clone?.path)) return { text: within(clone.path, folder), cls: '', title: `${clone.path}${clone.rule === 'clones' ? ' · set in this computer\'s settings' : clone.rule === 'convention' ? ' · beside the deployment' : ''}` };
  return { text: 'not cloned here', cls: 'muted', title: '' };
}

/** Where a declared default comes from: a package, this workspace, or a member by name. */
function declaredFrom(status, from) {
  if (from === 'package') return 'package';
  if (from === 'here') return 'this workspace';
  if (!text(from)) return null;
  const member = list(status?.members).find(m => m.key === from);
  return member ? memberName(member) : tail(from);
}
/** One default capability: its name, where it comes from, or that it is turned off. */
function defaultCap(doc, status, row, { sayOff = true } = {}) {
  const cap = el(doc, 'span', null, `setup-def-cap${row.off ? ' off' : ''}`); cap.dataset.capability = row.name;
  const where = row.off ? (sayOff ? 'off' : null) : declaredFrom(status, row.from);
  cap.append(el(doc, 'span', row.name, 'setup-def-name'));
  if (where) cap.append(el(doc, 'span', where, 'setup-def-from'));
  return cap;
}
const capRows = value => list(value).filter(row => text(row?.name));
const SLOT_LABEL = slot => slot.charAt(0).toUpperCase() + slot.slice(1);

/** The Defaults box: the workspace's slots and default capabilities, when the kernel reports them. */
function defaultsBox(doc, status) {
  const defaults = status?.defaults;
  if (!defaults || typeof defaults !== 'object') return null;
  const slots = Object.entries(defaults.slots && typeof defaults.slots === 'object' ? defaults.slots : {}).filter(([slot]) => text(slot));
  const caps = capRows(defaults.capabilities);
  // Standalone (slots null, no capabilities): the workspace declares no defaults.
  if (!slots.some(([, value]) => value !== null) && !caps.length) return null;
  const card = box(doc, 'Defaults', 'Every soul starts from these.', { heading: 'h4' });
  const rows = el(doc, 'dl', null, 'setup-def-rows');
  const row = (key, cls = '') => { const r = el(doc, 'div', null, 'setup-def'); const dd = el(doc, 'dd', null, cls); r.append(el(doc, 'dt', key), dd); rows.append(r); return { r, dd }; };
  for (const [slot, value] of slots) {
    const { r, dd } = row(SLOT_LABEL(slot), value === null || value === 'none' ? 'muted' : ''); r.dataset.slot = slot;
    if (value === null) dd.append('not set');
    else if (value === 'none') dd.append('none');
    else if (text(value?.name)) dd.append(defaultCap(doc, status, value));
  }
  if (caps.length) { const { r, dd } = row('Capabilities'); r.dataset.slot = 'capabilities'; dd.append(...caps.map(cap => defaultCap(doc, status, cap))); }
  card.append(rows);
  return card;
}
/** A team's additions to the defaults (defaults.byTeam.<label>), or null when it adds nothing. */
function teamDefaults(doc, status, label) {
  const caps = capRows(status?.defaults?.byTeam?.[label]?.capabilities);
  if (!caps.length) return null;
  const line = el(doc, 'div', null, 'setup-team-adds'); line.dataset.teamDefaults = label;
  const on = caps.filter(cap => !cap.off), off = caps.filter(cap => cap.off);
  if (on.length) { const part = el(doc, 'span', 'adds '); part.append(...on.map(cap => defaultCap(doc, status, cap))); line.append(part); }
  if (off.length) { const part = el(doc, 'span', 'turns off '); part.append(...off.map(cap => defaultCap(doc, status, cap, { sayOff: false }))); line.append(part); }
  return line;
}

/** The Member panel: the two sides of the handshake, what it means now, and the kernel's own detail. */
function memberPanel(doc, member, { status, onClose, openExternal }) {
  const ws = status?.workspace || {};
  const state = memberState(member), name = memberName(member);
  const panel = el(doc, 'aside', null, 'setup-panel'); panel.setAttribute('aria-label', `Member ${name}`); panel.dataset.member = member.key;
  const head = el(doc, 'div', null, 'setup-panel-head'); head.append(el(doc, 'h3', 'Member'));
  const close = el(doc, 'button', null, 'act icon-act'); close.type = 'button'; close.setAttribute('aria-label', 'Close member details');
  close.append(iconElement(doc, 'close', { size: 15 })); close.addEventListener('click', onClose); head.append(close);
  const body = el(doc, 'div', null, 'setup-panel-body');
  const id = el(doc, 'div', null, 'setup-panel-id'); id.append(el(doc, 'span', name, 'setup-panel-name'), stateChip(doc, member));
  body.append(id);
  // Handshake: the workspace lists it; the repo points back. Unknown sides stay unknown.
  const listed = member.status === 'not-listed' ? false : member.status === 'cannot-read' ? null : true;
  const back = member.status === 'confirmed' ? true : ['no-backlink', 'backlink-elsewhere'].includes(member.status) ? false : null;
  const hand = el(doc, 'section'); hand.append(el(doc, 'h4', 'Handshake'));
  const rows = el(doc, 'div', null, 'setup-hand');
  const side = (ok, title, sub) => {
    const row = el(doc, 'div', null, 'setup-hand-row');
    const mark = el(doc, 'span', ok === false ? '○' : ok === null ? '?' : null, `setup-hand-mark${ok === false ? ' warn' : ok === null ? ' unknown' : ''}`);
    mark.dataset.side = ok === true ? 'yes' : ok === false ? 'no' : 'unknown';
    if (ok === true) mark.append(iconElement(doc, 'check', { size: 13 }));
    row.append(mark);
    const copy = el(doc, 'span', null, 'setup-hand-copy'); copy.append(el(doc, 'span', title, 'setup-hand-title'));
    if (sub) { const said = el(doc, 'span', null, 'setup-hand-sub'); said.append(...[sub].flat()); copy.append(said); }
    row.append(copy); rows.append(row);
  };
  const hostName = tail(ws.url || ws.key);
  // The files, by the names the kernel reports (workspace.file, membershipFile); generic words otherwise.
  const wsFile = fileRef(ws.file), memberFile = fileRef(member.membershipFile);
  const named = (file, words) => file ? fileName(doc, file, openExternal) : words;
  side(listed, 'The workspace lists it', text(ws.key) ? [`in ${hostName}'s `, named(wsFile, 'workspace file')] : null);
  side(back, 'The repo points back', back === true ? ["The repo's ", named(memberFile, 'membership file'), ' names this workspace'] : member.status === 'backlink-elsewhere' ? 'It names a different workspace' : back === false ? ['No ', named(memberFile, 'membership file'), ' in the repo names this workspace'] : "Can't tell without read access");
  hand.append(rows); body.append(hand);
  // Where it is checked out on this computer (clones[]), when the kernel reports it.
  const clone = list(status?.clones).find(row => row?.key === member.key);
  if (clone) {
    const folder = text(ws.local) ? ws.local.replace(/\/[^/]+$/, '') : null, where = cloneText(clone, folder);
    const here = el(doc, 'section'); here.dataset.clone = member.key; here.append(el(doc, 'h4', 'On this computer'));
    const p = el(doc, 'p', where.text, clone.problem ? 'warn' : text(clone.path) ? 'mono' : 'muted'); p.title = where.title; here.append(p);
    body.append(here);
  }
  // What this means now.
  const means = el(doc, 'section'); means.append(el(doc, 'h4', 'What this means'));
  const souls = list(member.souls).filter(text);
  const p = el(doc, 'p');
  let which = null;
  if (state.ok) {
    const caps = list(member.capabilities).length;
    p.append(`It contributes ${[plural(souls.length, 'soul'), plural(caps, 'capability', 'capabilities')].join(' and ')} at its latest commit.`);
    // Which capabilities, by name (workspace status members[].capabilities): the Capabilities list says "by" it on each.
    const names = list(member.capabilities).filter(text);
    if (names.length) { which = el(doc, 'p', names.join(', '), 'mono'); which.dataset.memberCapabilities = member.key; }
  } else {
    p.append('Until both sides agree, this repo contributes nothing.');
    if (souls.length) {
      p.append(` Its soul${souls.length === 1 ? '' : 's'} `);
      souls.forEach((soul, i) => { if (i) p.append(i === souls.length - 1 ? ' and ' : ', '); p.append(el(doc, 'span', soul, 'mono')); });
      p.append(` ${souls.length === 1 ? 'is' : 'are'} hidden from Souls and can't be spawned.`);
    }
  }
  means.append(p); if (which) means.append(which); body.append(means);
  // The kernel's own words about it (for example which file is missing).
  if (text(member.detail)) {
    const fix = el(doc, 'section'); fix.append(el(doc, 'h4', state.ok ? 'Detail' : 'Fix'), el(doc, 'div', member.detail, 'setup-detail'));
    body.append(fix);
  }
  const acts = el(doc, 'div', null, 'setup-panel-acts');
  // The repository on the web (members[].url), when it has a web address.
  if (webUrl(member.url) && openExternal) {
    const web = el(doc, 'button', 'Open repository', 'act'); web.type = 'button'; web.title = member.url;
    web.dataset.verb = 'repo'; web.addEventListener('click', () => openExternal(member.url)); acts.append(web);
  }
  if (acts.children.length) body.append(acts);
  body.append(el(doc, 'p', 'Membership is the trust: whoever can push to a member decides its souls and capabilities.', 'muted'));
  panel.append(head, body);
  return panel;
}
