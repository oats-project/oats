/** Workspace v4 pages (W4 soul page, W5b capability page): a page bar in place
 * of the Workspace tabs ("‹ Back", the breadcrumb, the page's actions), then a
 * main column and a 300px side column of cards. Presentation only: the row is
 * the catalog's (`oats capabilities`) or a soul's resolved capability in the
 * same shape (capabilityRow); usage is the roster's module rows; provenance is
 * workspace status. Nothing here is inferred — unreported facts are not shown. */
import { createSoulMark } from './identity-marks.mjs';
import { iconElement } from './shell-icons.mjs';
import { capabilityRow, sourceChip, sourceText, originElement } from './workspace-catalog.mjs';
import { DEFAULTS_COPY } from './workspace-defaults.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';
import { capabilityOrigin } from '../../client/capability-origin.mjs';
import { defaultState } from '../../client/capability-list.mjs';
import { memberNames, layerLabel, capabilityUsers } from '../../client/capability-rows.mjs';
import { capabilityFacts, CAPABILITY_COPY } from '../../client/capability-facts.mjs';
import { skeleton, noticeElement, updateNotice, failedElement, updateFailed, isOldObservation, ROSTER_STALE_TITLE, SOULS_STALE_TITLE } from './loading.mjs';
import { displayLine } from '../../client/display-text.mjs';
import { sourceQuote, LEAD_INS } from './source-quote.mjs';

/** The shared page chrome: bar, columns, section titles and side cards. */
export const pageCardCSS = `
.workspace-page { padding:0 !important; }
.page-bar { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:8px; height:var(--bar-h); min-height:48px; padding:0 calc(16px + var(--main-trail-inset, 0px)) 0 calc(16px + var(--main-lead-inset, 0px)); box-sizing:border-box; border-bottom:1px solid var(--border); background:var(--surface); font-size:12.5px; }
.oats-view .page-bar button.page-back { display:inline-flex; align-items:center; gap:6px; height:30px; min-height:30px; margin-right:6px; padding:0 10px 0 8px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; flex:none; }
.oats-view .page-bar button.page-back:hover { background:var(--surface-2); }
.page-crumbs { display:flex; align-items:center; gap:8px; min-width:0; color:var(--muted); white-space:nowrap; overflow:hidden; }
.page-crumbs .page-crumb-current { color:var(--fg); font-weight:650; overflow:hidden; text-overflow:ellipsis; }
/* A Workspace page's trail (slice 2b, Amendment 1, E): Home › Workspace › Souls › <name>, each part but the last a
   link; a quiet text button, its focus the shell's tint. */
.oats-view .page-crumbs button.page-crumb-link, .page-crumbs button.page-crumb-link { appearance:none; height:auto; min-height:0; margin:0; padding:2px 4px; border:0; border-radius:4px; background:transparent; color:var(--muted);
  font:inherit; font-weight:500; line-height:normal; cursor:pointer; flex:none; }
.oats-view .page-crumbs button.page-crumb-link:hover, .page-crumbs button.page-crumb-link:hover { color:var(--fg); text-decoration:underline; }
.page-crumbs .page-crumb-sep { flex:none; }
.page-bar-actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex:none; }
.oats-view .page-bar-actions button.act { height:30px; min-height:30px; padding:0 12px; border-radius:7px; font-size:12.5px; font-weight:600; }
.oats-view .page-bar-actions button.act.primary:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); font-weight:650; }
.page-body { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:24px; padding:22px 28px 28px; align-items:start; }
.page-main, .page-side { display:flex; flex-direction:column; min-width:0; }
.page-main { gap:22px; }
.page-side { gap:14px; }
@container (max-width: 860px) { .page-body { grid-template-columns:minmax(0,1fr); } }
.page-identity { display:flex; align-items:center; gap:14px; min-width:0; }
.page-identity .identity-mark, .page-glyph { width:40px; height:40px; border-radius:var(--radius-card); font-size:16px; font-weight:650; flex:none; }
.page-glyph { display:grid; place-items:center; background:var(--chip-bg); color:var(--fg); }
.page-identity-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
/* A page's title in the prototype's scale (slice 3c): 17 / 600, the page's one large line. */
.page-title { display:flex; align-items:center; gap:var(--space-2); min-width:0; margin:0; font-size:var(--text-title); font-weight:600; line-height:24px; letter-spacing:0; overflow-wrap:anywhere; }
.page-title.mono { font-weight:600; font-size:var(--text-title); line-height:24px; font-family:var(--mono,monospace); }
/* A page's pills (slice 3c): the list's pills, a hairline frame with muted words. */
.page-tag { display:inline-flex; align-items:center; height:18px; padding:0 6px; border:1px solid var(--border); border-radius:var(--radius-tag); box-sizing:border-box; background:transparent; color:var(--muted); font-weight:400; font-size:var(--text-label); line-height:normal; font-family:var(--ui-font,system-ui); letter-spacing:.02em; white-space:nowrap; }
.page-lede { margin:0; color:var(--muted); font-size:var(--text-body); line-height:1.5; }
/* desktop/loading-states item 7: the catalog's facts arrive after the page (opened from a soul): a
   lede-sized line and a facts-sized block stand where they go; the catalog's age line sits under the bar. */
.page-lede.skeleton { height:13px; width:55%; margin-top:2px; }
.page-facts-skeleton { display:flex; flex-direction:column; gap:10px; }
.page-facts-skeleton .skeleton-line { height:11px; width:70%; }
.page-facts-skeleton .skeleton-line:nth-child(2n) { width:50%; }
.page-notice { padding:12px 28px 0; }
.page-notice:empty { display:none; }
.page-notice .loading-notice { margin:0; }
.page-facts-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px 20px; margin-top:8px; font-size:12.5px; }
.page-fact { display:inline-flex; align-items:center; gap:7px; white-space:nowrap; min-width:0; }
.page-fact .shell-icon { color:var(--muted); }
.page-fact .mono { font-family:var(--mono,monospace); font-weight:600; }
.page-fact .muted { color:var(--muted); }
.page-fact .strong { font-weight:600; }
.page-fact .runtime-badge { width:22px; height:22px; border-radius:6px; font-size:11px; }
/* A section's title: the small uppercase label (slice 3c), its lead in ordinary case after it. */
.page-section { display:flex; flex-direction:column; gap:var(--space-2); min-width:0; }
.page-section-title { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px; margin:0; color:var(--muted); font-size:var(--text-label); font-weight:var(--label-weight); letter-spacing:var(--label-tracking); text-transform:uppercase; line-height:16px; }
.page-section-lead { color:var(--muted); font-size:var(--text-label); font-weight:400; letter-spacing:0; text-transform:none; }
.page-card { display:flex; flex-direction:column; gap:6px; min-width:0; padding:12px 14px; box-sizing:border-box; background:var(--surface); border:1px solid var(--border); border-radius:10px; font-size:12px; }
.page-card-title { display:flex; align-items:baseline; gap:8px; margin:0 0 4px; color:var(--muted); font-size:11px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; }
.page-card-title .shell-icon { align-self:center; }
.page-card-lead { color:var(--muted); font-size:11.5px; font-weight:400; letter-spacing:0; text-transform:none; }
.page-card-count { color:var(--muted); font-weight:normal; font-size:11px; line-height:normal; font-family:var(--mono,monospace); letter-spacing:0; text-transform:none; }
.page-note { margin:0; color:var(--muted); font-size:12px; line-height:1.5; }
.page-list-item { display:flex; align-items:center; gap:8px; min-height:26px; font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); min-width:0; }
.page-list-item > :first-child { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.page-kv { display:grid; grid-template-columns:84px minmax(0,1fr); gap:10px; align-items:center; min-height:32px; border-bottom:1px solid var(--tag-bg); }
.page-kv:last-child { border-bottom:0; }
.page-kv dt { color:var(--muted); font-size:12px; }
.page-kv dd { margin:0; font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.page-kv.wrap dd { white-space:normal; overflow:visible; padding:6px 0; }
.page-kv.wrap .path-part { white-space:nowrap; }
.page-kv-list { margin:0; }
.page-table { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.page-table-row { display:grid; gap:12px; align-items:center; min-height:42px; padding:0 16px; box-sizing:border-box; border-top:1px solid var(--tag-bg); }
.page-table-row.head { min-height:34px; border-top:0; border-bottom:1px solid var(--border); color:var(--muted); font-size:11px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; }
.page-table-row.head + .page-table-row { border-top:0; }
.oats-view .page-table button.page-table-row { width:100%; border-left:0; border-right:0; border-bottom:0; border-radius:0; background:var(--surface); color:var(--fg); text-align:left; font:inherit; cursor:pointer; }
.oats-view .page-table button.page-table-row:hover { background:var(--surface-2); }
.page-table .page-table-row.openable { cursor:pointer; }
.page-table .page-table-row.openable:hover { background:var(--surface-2); }
.why-tag { display:inline-flex; align-items:center; justify-self:start; flex:none; height:20px; padding:0 6px; border-radius:4px; background:var(--tag-bg); color:var(--fg); font-size:11px; font-weight:600; white-space:nowrap; }
.why-tag.soul { background:var(--primary-bg); color:var(--primary-fg); }
.why-note { color:var(--muted); font-size:12px; white-space:nowrap; }
`;

export const capabilityPageCSS = `
/* Slice 3b: one readable column, the page's name in the chrome's sans (D2). */
.capability-page .page-body { grid-template-columns:minmax(0,1fr); max-width:860px; }
.capability-page .page-body[hidden] { display:none; }
.capability-page .page-main { gap:16px; }
.cap-page-head { display:flex; flex-direction:column; gap:6px; min-width:0; }
.capability-page .page-title { font-family:var(--ui-font,system-ui); }
.cap-page-origin { display:flex; flex-wrap:wrap; align-items:center; gap:2px 0; margin:0; color:var(--muted); font-size:var(--text-meta); }
.cap-page-origin .cap-origin { margin:0; padding:0; font-size:var(--text-meta); }
.cap-origin-words { color:var(--fg); }
.cap-page-sep { white-space:pre; }
.cap-page-where { color:var(--muted); }
.capability-page .cap-page-what { color:var(--fg); font-size:var(--text-name); line-height:1.5; max-width:80ch; }
/* A fold: a native disclosure, its summary a row with a turning chevron. */
.cap-folds { display:flex; flex-direction:column; min-width:0; }
.cap-folds:empty { display:none; }
.cap-fold { min-width:0; border-top:1px solid var(--border); }
.cap-fold:last-child { border-bottom:1px solid var(--border); }
.cap-fold > summary { display:flex; align-items:center; gap:var(--space-2); min-height:36px; padding:0 10px; list-style:none; cursor:pointer; border-radius:var(--radius-control); color:var(--fg); font-size:var(--text-name); font-weight:var(--name-weight); }
.cap-fold > summary::-webkit-details-marker { display:none; }
.cap-fold > summary:hover { background:var(--surface-2); }
.cap-fold > summary:focus-visible { background:var(--sel); }
.cap-fold > summary .shell-icon { flex:none; color:var(--muted); transition:transform .15s; }
.cap-fold[open] > summary .shell-icon { transform:rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .cap-fold > summary .shell-icon { transition:none; } }
.cap-fold-count { color:var(--muted); font-weight:normal; font-size:var(--text-meta); }
.cap-fold > :not(summary) { margin:4px 4px 16px; }
.capability-page .cap-fold > .provides-items { display:flex; flex-wrap:wrap; gap:6px; }
.capability-page .cap-fold-pre { margin-top:8px; }
.cap-fold-facts { display:flex; flex-direction:column; gap:8px; align-items:flex-start; }
.cap-fold-facts .page-kv-list { align-self:stretch; }
/* Files: the Contents card under its fold, its own title left to the fold's summary. */
.cap-fold .cap-contents-section > .page-section-title > span:first-child { display:none; }
.capability-page .used-row { grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); }
.capability-page .used-soul { display:flex; align-items:center; gap:9px; min-width:0; }
.capability-page .used-soul .identity-mark { width:24px; height:24px; border-radius:7px; font-size:11px; font-weight:700; }
.capability-page .used-name { font-size:12.5px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.capability-page .used-meta { color:var(--muted); font-size:12px; white-space:nowrap; }
.capability-page .used-meta.warn { color:var(--warn); }
.capability-page .page-kv.why { align-items:start; }
.capability-page .page-kv.why dt { padding-top:7px; }
.capability-page .page-kv.why dd { display:flex; flex-direction:column; gap:2px; padding:7px 0; white-space:normal; overflow:visible; font-weight:normal; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); }
.capability-page .page-why-label { color:var(--fg); font-weight:600; }
.capability-page .page-why-note { color:var(--muted); line-height:1.45; }
.capability-page .provides-card { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:0 16px; margin:0; padding:4px 14px; }
.capability-page .provides-row { display:contents; }
.capability-page .provides-kind { display:flex; align-items:baseline; gap:6px; padding:9px 0; color:var(--muted); font-size:11px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; white-space:nowrap; }
.capability-page .provides-count { font-weight:normal; font-size:11px; line-height:normal; font-family:var(--mono,monospace); letter-spacing:0; }
.capability-page .provides-items { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0; margin:0; padding:6px 0; }
.capability-page .provides-row + .provides-row > * { border-top:1px solid var(--tag-bg); }
.capability-page .provides-chip { display:inline-block; max-width:100%; padding:2px 7px; border-radius:5px; background:var(--tag-bg); color:var(--fg); font-weight:normal; font-size:12px; line-height:1.5; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.capability-page .provides-items .page-note { padding:2px 0; }
/* Trigger sources: the manifest's own words, quoted (source-quote.mjs), or the plain lines that say they can't be read. */
.capability-page .provides-items.provides-sources { flex-direction:column; flex-wrap:nowrap; align-items:stretch; gap:3px; padding:8px 0; }
.capability-page .provides-unreadable { margin:0; color:var(--fg); font-weight:normal; font-size:12px; line-height:1.5; font-family:var(--ui-font,system-ui); }
.capability-page .provides-unreadable-why { margin:0; color:var(--muted); font-weight:normal; font-size:11.5px; line-height:1.45; font-family:var(--ui-font,system-ui); overflow-wrap:anywhere; }
.capability-page pre { margin:0; padding:10px; border:1px solid var(--border); border-radius:7px; background:var(--surface-2); color:var(--fg); overflow:auto; font-size:11.5px; }
`;

/** A soul's composition (W4): Capability | Source | Why it's here. */
export const soulCapabilitiesCSS = `
.soul-caps .soul-cap-row { grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr); min-height:44px; }
.soul-caps .soul-cap-row.head { min-height:34px; }
.soul-cap-name { display:flex; flex-direction:column; min-width:0; }
.soul-cap-id { color:var(--fg); font-weight:600; font-size:12.5px; line-height:normal; font-family:var(--mono,monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.soul-cap-note { color:var(--muted); font-size:11px; }
.soul-cap-row.off:not(.none) .soul-cap-id { color:var(--muted); text-decoration:line-through; }
.soul-cap-why { display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; min-width:0; padding:6px 0; font-size:12px; }
.soul-cap-why-note { flex-basis:100%; min-width:0; color:var(--muted); font-size:11px; line-height:1.4; }
/* Core capabilities: the same grid, each row led by its slot's icon and name. */
.soul-core .soul-cap-name { flex-direction:row; align-items:center; gap:10px; padding:6px 0; }
.soul-cap-slot-icon { display:grid; place-items:center; width:24px; height:24px; border-radius:6px; background:var(--bg); color:var(--fg); flex:none; }
.soul-cap-copy { display:flex; flex-direction:column; min-width:0; }
.soul-cap-slot { color:var(--muted); font-size:10.5px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; }
.oats-view .page-table button.soul-cap-row { height:auto; min-height:44px; font-size:12px; font-weight:400; }
.soul-core .soul-cap-row.none .soul-cap-id { color:var(--muted); font-family:var(--ui-font,system-ui); font-weight:500; }
.soul-caps .page-note { padding:12px 16px; }
`;

const text = v => typeof v === 'string' && v ? v : null;
const list = v => Array.isArray(v) ? v : [];

function el(doc, tag, value, cls) {
  const node = doc.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  if (cls) node.className = cls;
  return node;
}

/** Where a Workspace trail's named parts go (workspaceNavigate): the Workspace page, and its tabs by their words. */
export const WORKSPACE_TRAIL = Object.freeze({ Home: 'home', Workspace: 'workspace', Souls: 'souls', Capabilities: 'capabilities', Teams: 'teams', Machines: 'machines', Setup: 'sources' });
/** Ask the Workspace page (views/spawn.mjs, which listens on its root) to go to `to`: 'home', 'workspace' or a tab. */
export function workspaceNavigate(from, to) {
  const View = from.ownerDocument.defaultView;
  from.dispatchEvent(new View.CustomEvent('workspace-navigate', { bubbles: true, detail: { to } }));
}
/** The page bar: "‹ back", the breadcrumb and actions. A Workspace page's trail (its crumbs start with "Workspace")
 * is the whole way there (slice 2b, Amendment 1, E: Pepe, 2026-11-20, "no pots tornar al home"): Home › Workspace ›
 * <tab> › … › this page, each part but this page a link. By place, never by name (a soul may be called "Teams"): Home
 * and Workspace, and the tab right after Workspace, go through workspaceNavigate; a deeper part goes where its own
 * `{ label, go }` says (a soul's page, a capability's); a plain part just above this page goes to `onBack`. Any other
 * trail is plain words. `setTrail(crumbs, current, { onUp })` paints it again (a sub-page: the capability page's
 * skill), `onUp` then standing for `onBack`. */
export function pageBar(doc, { backLabel, crumbs = [], current, onBack }) {
  const bar = el(doc, 'div', null, 'page-bar');
  const back = el(doc, 'button', null, 'page-back'); back.type = 'button';
  back.append(iconElement(doc, 'chevronLeft', { size: 15 }), el(doc, 'span', backLabel));
  back.setAttribute('aria-label', `Back to ${backLabel}`); back.title = `Back to ${backLabel} (Esc)`;
  back.addEventListener('click', () => onBack());
  const trail = el(doc, 'nav', null, 'page-crumbs'); trail.setAttribute('aria-label', 'Breadcrumb');
  function setTrail(parts, here, { onUp = onBack } = {}) {
    const workspace = parts[0] === 'Workspace';
    const all = workspace ? ['Home', ...parts] : parts;
    trail.replaceChildren();
    all.forEach((crumb, i) => {
      const label = typeof crumb === 'string' ? crumb : crumb.label;
      // Where it goes: Home, Workspace and the tab by their place; a part's own `go`; the plain part above this page, up.
      const go = !workspace ? null
        : i <= 1 ? () => workspaceNavigate(part, WORKSPACE_TRAIL[label])
        : i === 2 && WORKSPACE_TRAIL[label] && typeof crumb === 'string' && i !== all.length - 1 ? () => workspaceNavigate(part, WORKSPACE_TRAIL[label])
        : typeof crumb?.go === 'function' ? crumb.go
        : i === all.length - 1 ? onUp : null;
      let part;
      if (go) {
        part = el(doc, 'button', label, 'page-crumb-link'); part.type = 'button';
        part.addEventListener('click', () => go());
      } else part = el(doc, 'span', label);
      trail.append(part, el(doc, 'span', workspace ? '›' : '/', 'page-crumb-sep'));
    });
    const now = el(doc, 'span', here, 'page-crumb-current'); now.setAttribute('aria-current', 'page'); trail.append(now);
  }
  setTrail(crumbs, current);
  const actions = el(doc, 'div', null, 'page-bar-actions');
  bar.append(back, trail, actions);
  return { bar, back, actions, setTrail };
}
/** Kept for callers of the F7 page chrome: a bare back control. */
export function pageBack(doc, label, onBack) {
  const { bar, back } = pageBar(doc, { backLabel: label, current: '', onBack });
  return { crumb: bar, back };
}
export function pageSection(doc, title, lead = '') {
  const section = el(doc, 'section', null, 'page-section');
  const head = el(doc, 'h3', null, 'page-section-title'); head.append(el(doc, 'span', title));
  if (lead) head.append(el(doc, 'span', lead, 'page-section-lead'));
  section.append(head); section.dataset.section = title;
  return section;
}
/** A side card with an uppercase title (and an optional lead or count). */
export function pageCard(doc, title, { lead = '', count = null, icon = null } = {}) {
  const card = el(doc, 'section', null, 'page-card'); card.dataset.card = title;
  const head = el(doc, 'h3', null, 'page-card-title');
  if (icon) head.append(iconElement(doc, icon, { size: 13 }));
  head.append(el(doc, 'span', title));
  if (count !== null) head.append(el(doc, 'span', String(count), 'page-card-count'));
  if (lead) head.append(el(doc, 'span', lead, 'page-card-lead'));
  card.append(head);
  return { card, head, body: card };
}
/** key → value rows (the "Comes from" card); only reported values. */
export function pageFacts(doc, entries) {
  const dl = el(doc, 'dl', null, 'page-kv-list');
  for (const [key, value, title, cls] of entries) if (text(value)) {
    const row = el(doc, 'div', null, `page-kv${cls ? ` ${cls}` : ''}`); const dd = el(doc, 'dd', value); dd.title = title || value;
    row.append(el(doc, 'dt', key), dd); dl.append(row);
  }
  return dl;
}

const LAYER_ICONS = { knowledge: 'knowledge', messaging: 'mail', tasks: 'tasks' };
/** A core capability's icon (book, mail, checklist), else package or repository. */
export const capabilityIcon = row => LAYER_ICONS[row?.layer] || (row?.kind === 'package' ? 'package' : 'repo');

/** Which age line a page mirroring the catalog's controller shows: 'stale' (the read failed: Retry, the
 * cause behind Details), 'observed' (an old observation) or null (current). `state`: the controller's
 * state (a refreshing read keeps the settled kind through `settled`); `observedAt`: ISO or null. */
export function catalogNoticeKind({ state, settled = state, observedAt = null } = {}, now = Date.now()) {
  const at = state === 'refreshing' || state === 'pending' ? settled : state;
  if (at === 'stale') return 'stale';
  if (at === 'failed') return 'failed'; // the catalog could not be read and nothing is held: the failed treatment, not silence
  return isOldObservation(observedAt, now) ? 'observed' : null;
}
/** The page's copy of the controller's notice (loading.mjs `noticeElement`, so the two never drift):
 * built once per kind and updated in place by `updateCatalogNotice` — its Retry keeps focus, wears
 * `aria-disabled` while the re-read runs, and the age ticks with the host's polls. */
export function catalogNotice(doc, observation = {}, now = Date.now()) {
  const kind = catalogNoticeKind(observation, now);
  if (!kind) return null;
  if (kind === 'failed') {
    const el = failedElement(doc, { ...failedFacts(observation), onRetry: observation.onRetry ?? null }); el.dataset.kind = 'failed'; return el;
  }
  return noticeElement(doc, kind, { noun: 'capabilities', observedAt: observation.observedAt ?? null, cause: kind === 'stale' ? observation.cause ?? null : null,
    busy: observation.busy === true, onRetry: observation.onRetry ?? null, now });
}
export function updateCatalogNotice(el, observation = {}, now = Date.now()) {
  if (el.dataset.kind === 'failed') { updateFailed(el, failedFacts(observation)); return; }
  updateNotice(el, { noun: 'capabilities', observedAt: observation.observedAt ?? null, cause: el.dataset.kind === 'stale' ? observation.cause ?? null : null, busy: observation.busy === true, now });
}
/** The failed block's facts from the discovery's failure text ("CODE: message", reasonText's shape) or a plain message. */
function failedFacts({ cause = null, busy = false } = {}) {
  const m = /^([A-Z][A-Z0-9_]+): (.+)$/s.exec(cause || '');
  return { noun: 'capabilities', message: m ? m[2] : cause || null, code: m ? m[1] : null, busy: busy === true };
}

/** @param row a catalog row (or capabilityRow(resolved)); from: { label, why? } when opened from a soul page
 * (`why`: the soul page's core or composition entry for it, for the "Why" row).
 *
 * The page (the Desktop UI rework, slice 3b; guide tour steps 35 and 36) reads top to bottom, one column: its name
 * and tags, the origin line (who made it, ✓ or "by <source>", then where it comes from), what it does as one
 * paragraph, then **Skills** (`skills`, the Contents controller's rows: Enter opens the whole skill in `skillView`,
 * which the page places beside its body; the body is hidden while it is open), then the rest folded under native
 * disclosures, each shown only when there is something to say: Commands, Settings, Triggers, Hooks, Used by,
 * Source (the "Comes from" facts and the manifest file), "As <soul> resolves it" (from a soul) and Files (today's
 * Contents card: the injected instructions and every skill file). Enter or Space unfolds one. Every fact the
 * earlier page showed stays reachable. Folds the user opened stay open across a rebuild of the same capability.
 *
 * `catalogPending`: opened from a soul before the catalog is read — its facts (the paragraph, Source) are
 * skeletons the host fills in place when it arrives. The catalog's age line lives in `.page-notice`
 * under the bar: the host paints it (`catalogNotice` / `updateCatalogNotice`), optionally seeded here
 * with `observation` ({ state, settled, busy, observedAt, cause, onRetry }). `contents`: the Contents section's
 * element (createCapabilityContents); `triggerSources`: the same controller's "Trigger sources" row (its Triggers
 * fold while it has content); `skills` / `skillView`: its Skills rows and whole-skill view. */
export function renderCapabilityPage(host, { row, status, instances, souls = [], composition = false, root, rosterState = 'ready', backLabel = 'Capabilities', onBack, openSoul = null, from = null, openExternal = null, catalogPending = false, observation = null, contents = null, triggerSources = null, skills = null, skillView = null }) {
  const doc = host.ownerDocument;
  const node = (tag, value, cls) => el(doc, tag, value, cls);
  // The folds the user opened on this capability stay open across the rebuild.
  const previous = host.querySelector(':scope > .capability-page');
  const unfolded = previous?.dataset.capability === row.name ? new Set([...previous.querySelectorAll('details.cap-fold[open]')].map(d => d.dataset.fold)) : new Set();
  host.replaceChildren();
  const resolved = row.resolved, names = memberNames(status);
  const page = node('div', undefined, 'capability-page'); page.dataset.capability = row.name;
  if (catalogPending) page.dataset.catalogPending = 'true';
  // From a soul's page, its name is the part above: Back (and its link) returns to that soul.
  const crumbs = from ? ['Workspace', 'Souls', { label: from.label, go: () => onBack() }] : ['Workspace', 'Capabilities'];
  const { bar, setTrail } = pageBar(doc, { backLabel, crumbs, current: row.name, onBack });
  const noticeHost = node('div', undefined, 'page-notice');
  const notice = observation ? catalogNotice(doc, observation) : null; if (notice) noticeHost.append(notice);
  const body = node('div', undefined, 'page-body'), main = node('div', undefined, 'page-main');
  // Its name, its tags, then the origin line ("Comes from" in one line; the Source fold keeps the details).
  const head = node('div', undefined, 'cap-page-head');
  const title = node('h2', undefined, 'page-title'); title.append(node('span', row.name));
  if (text(row.layer)) title.append(node('span', `Core · ${layerLabel(row.layer)}`, 'page-tag'));
  const state = defaultState(status, row);
  if (state) { const tag = node('span', state === 'on' ? DEFAULTS_COPY.tag : DEFAULTS_COPY.offTag, 'page-tag'); tag.title = state === 'on' ? DEFAULTS_COPY.tagTitle : DEFAULTS_COPY.offTitle; title.append(tag); }
  head.append(title, originLine(doc, row, status, names));
  // #482: the page reads the view's primary deployment, without naming it (the product owner, 2026-10-23).
  // Kernel #217: the manifest's description, as the page's one paragraph (a line-sized skeleton while the catalog is read).
  if (text(row.description)) head.append(node('p', row.description, 'page-lede cap-page-what'));
  else if (catalogPending) { const lede = skeleton(doc, 'line', { width: '55%' }); lede.classList.add('page-lede'); head.append(lede); }
  main.append(head);
  // Skills (the Contents controller's rows, re-appended on every rebuild so a focused row survives a repaint).
  if (skills) main.append(skills);
  // The folds: one group of native disclosures, a rule between them.
  const folds = node('div', undefined, 'cap-folds'); main.append(folds);
  const fold = (id, label, count = null) => {
    const d = node('details', undefined, 'cap-fold'); d.dataset.fold = id; d.open = unfolded.has(id);
    const summary = node('summary'); summary.append(iconElement(doc, 'chevronRight', { size: 13 }), node('span', label, 'cap-fold-title'));
    if (count !== null) summary.append(node('span', String(count), 'cap-fold-count'));
    d.append(summary); folds.append(d); return d;
  };
  const names_ = (label, items) => {
    const d = fold(label.toLowerCase(), label, Array.isArray(items) ? items.length : null);
    const value = node('div', undefined, 'provides-items');
    if (items === null) value.append(node('span', CAPABILITY_COPY.unlistable, 'page-note'));
    else if (!items.length) value.append(node('span', CAPABILITY_COPY.none, 'page-note'));
    else for (const item of items) value.append(node('code', item, 'provides-chip'));
    d.append(value); return d;
  };
  // What the catalog reports about it (capability-facts.mjs): Comes from, and what it provides.
  const reported = capabilityFacts(row, { status });
  const provided = new Map(reported.provides);
  // Commands and Settings: from a soul, what the resolved capability declares (inspect operations and declares);
  // else the catalog's commands.
  if (from && resolved) {
    const commands = list(resolved.operations).map(op => list(op.argv).filter(part => typeof part === 'string' && part).join(' ') || op.name).filter(Boolean);
    const declared = list(resolved.declares);
    if (commands.length) names_('Commands', commands);
    const hasSettings = resolved.settings && typeof resolved.settings === 'object' && Object.keys(resolved.settings).length;
    if (declared.length || hasSettings) {
      const d = names_('Settings', declared);
      if (hasSettings) d.append(node('pre', JSON.stringify(resolved.settings, null, 2), 'cap-fold-pre'));
    }
  } else if (provided.has('Commands')) names_('Commands', provided.get('Commands'));
  // Triggers (feature `trigger-sources`): the host's long-lived row, only while it has content.
  if (triggerSources?.childElementCount) {
    const d = fold('triggers', 'Triggers'), card = node('dl', undefined, 'page-card provides-card'); card.append(triggerSources); d.append(card);
  }
  if (!(from && resolved) && provided.has('Hooks')) names_('Hooks', provided.get('Hooks'));
  // Used by: with `composition` (souls-capabilities) the souls whose composition includes it, each with its live
  // instances carrying it; before, the souls whose instances carry it (roster module rows). capabilityUsers is the rule.
  const users = capabilityUsers(row, { souls, instances, composition });
  const staleTitle = composition ? SOULS_STALE_TITLE : ROSTER_STALE_TITLE;
  // "Used by" derives from the souls list and the roster (one read): with none, the claim needs a settled good read.
  const rosterGood = rosterState === 'ready' || rosterState === 'empty';
  const used = fold('used-by', CAPABILITY_COPY.usedBy, users.length || rosterGood ? CAPABILITY_COPY.souls(users.length) : null);
  const table = node('div', undefined, 'page-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', `Souls using ${row.name}`);
  const thead = node('div', undefined, 'page-table-row head used-row'); thead.setAttribute('role', 'row');
  for (const label of ['Soul', capitalized(DESKTOP_NOUNS.instances)]) { const cell = node('span', label); cell.setAttribute('role', 'columnheader'); thead.append(cell); }
  table.append(thead);
  if (!users.length) {
    if (rosterGood) table.append(node('p', composition ? CAPABILITY_COPY.noSoul : CAPABILITY_COPY.noInstance, 'page-note page-table-row'));
    else { const none = node('p', '—', 'page-note page-table-row used-unknown'); none.title = staleTitle; none.setAttribute('aria-description', staleTitle); none.dataset.rosterState = rosterState; table.append(none); }
  }
  for (const { soul, carrying, behind } of users) {
    const line = typeof openSoul === 'function' ? node('button', undefined, 'page-table-row used-row') : node('div', undefined, 'page-table-row used-row');
    line.setAttribute('role', 'row');
    // The tooltip and focus key name the soul by its key (two package souls may share a bare name).
    if (line.tagName === 'BUTTON') { line.type = 'button'; line.addEventListener('click', () => openSoul(soul)); line.title = `Open ${soul.key || soul.name}`; line.dataset.focusKey = `used:${soul.key || soul.name}:${soul.agentsRoot || ''}`; }
    const who = node('span', undefined, 'used-soul'); who.setAttribute('role', 'cell'); who.append(createSoulMark(doc, soul), node('span', soul.name, 'used-name'));
    const meta = node('span', `${carrying.length}${behind ? ` · ${CAPABILITY_COPY.behind(behind)}` : ''}`, `used-meta${behind ? ' warn' : ''}`); meta.setAttribute('role', 'cell');
    line.append(who, meta); table.append(line);
  }
  used.append(table);
  // Source: what workspace status and the catalog report about where it comes from.
  const origin = fold('source', CAPABILITY_COPY.comesFrom);
  const facts = node('div', undefined, 'cap-fold-facts'); origin.append(facts);
  if (catalogPending && row.kind !== 'package') {
    // The catalog's facts (Latest, Path, Fingerprint, File) are not read yet: a facts-sized block, filled in place when they land.
    const block = node('div', undefined, 'page-facts-skeleton'); block.setAttribute('aria-hidden', 'true'); block.dataset.skeleton = 'facts';
    for (let i = 0; i < 4; i++) block.append(skeleton(doc, 'line'));
    facts.append(block);
  } else facts.append(pageFacts(doc, reported.origin));
  // Kernel #217: its manifest file, as a web page when the repository has one, else its path.
  if (row.file && text(row.file.path) && !(catalogPending && row.kind !== 'package')) {
    const web = typeof row.file.url === 'string' && /^https:\/\//.test(row.file.url) ? row.file.url : null;
    const file = pageFacts(doc, [['File', row.file.path, row.file.path, 'wrap']]), dd = file.querySelector('dd');
    // A path breaks after its slashes, never inside a name.
    if (dd) { dd.replaceChildren(); row.file.path.split('/').forEach((part, i, all) => { dd.append(node('span', i < all.length - 1 ? `${part}/` : part, 'path-part')); if (i < all.length - 1) dd.append(doc.createElement('wbr')); }); }
    facts.append(file);
    if (web && typeof openExternal === 'function') {
      const open = node('button', 'Open file', 'act'); open.type = 'button'; open.title = web; open.dataset.verb = 'file'; open.dataset.focusKey = 'file';
      open.addEventListener('click', () => openExternal(web)); facts.append(open);
    }
  }
  // As the soul it was opened from resolves it (inspect): version, requirements, why it has it.
  if (from && resolved) {
    const missing = list(resolved.missingRequires);
    const as = fold('as-soul', `As ${from.label} resolves it`);
    const asFacts = pageFacts(doc, [['Version', text(resolved.version)], ['Missing', missing.length ? missing.join(', ') : 'None']]);
    // Why the soul has it, in the soul page's words (`from.why`: its core or composition entry); no reported reason, no row.
    const reason = from.why ? whyFact(from.why, from.label) : null;
    if (reason) {
      const why = node('div', undefined, 'page-kv why'), dd = node('dd'); why.dataset.fact = 'why';
      dd.append(node('span', reason[0], 'page-why-label'), node('span', reason[1], 'page-why-note'));
      why.append(node('dt', 'Why'), dd); asFacts.prepend(why);
    }
    as.append(asFacts);
  }
  // Files (spec C): the host's long-lived Contents section (capability-contents.mjs), re-appended on every rebuild so
  // what is open in its reader survives a catalog repaint. In both forms: the catalog's and a soul's.
  if (contents) fold('files', 'Files').append(contents);
  body.append(main); page.append(bar, noticeHost, body);
  // The whole skill, in place of the body while it is open (the controller shows and hides both).
  if (skillView) {
    if (!skillView.hidden) body.hidden = true; page.append(skillView);
    // A skill open is one level down (slice 2b, E): the trail ends on it, the capability above it a link that closes it.
    const sync = () => {
      const skill = skillView.hidden ? null : skillView.querySelector('.skill-view-title')?.textContent || null;
      if (skill) setTrail([...crumbs, { label: row.name, go: () => skillView.querySelector('.skill-back')?.click() }], skill);
      else setTrail(crumbs, row.name);
    };
    sync();
    const View = doc.defaultView;
    if (View?.MutationObserver) {
      const watch = new View.MutationObserver(() => { if (!page.isConnected) { watch.disconnect(); return; } sync(); });
      watch.observe(skillView, { attributes: true, attributeFilter: ['hidden'] });
    }
  }
  host.append(page);
  return page;
}
/** The origin line: who made it (the official mark with its words, or "by <source>"), then where it comes from. */
function originLine(doc, row, status, names) {
  const line = el(doc, 'p', null, 'cap-page-origin');
  line.append(originElement(doc, capabilityOrigin(row, status, names), { words: true }));
  const words = sourceText(row, names);
  const where = row.kind === 'package' ? `package ${[words.name, words.version].filter(Boolean).join(' ')}`
    : row.kind === 'member' ? `${words.name} repository, at its latest` : `${words.name}, outside the member repositories`;
  line.append(el(doc, 'span', ' · ', 'cap-page-sep'), el(doc, 'span', where, 'cap-page-where'));
  if (row.private === true) line.append(el(doc, 'span', ' · ', 'cap-page-sep'), el(doc, 'span', "only its repository's souls", 'cap-page-where'));
  return line;
}
const capitalized = word => word.charAt(0).toUpperCase() + word.slice(1);
/** The Desktop's own words in the Trigger sources row. */
export const TRIGGER_SOURCES_COPY = Object.freeze({
  title: 'Trigger sources',
  none: 'None',
  unusable: 'declared, but not usable',
  unreadable: 'Trigger sources are declared, but not readable here',
});
/** One source as one quote line. Its name, events and description are the manifest's: quoted text only. A source
 * that is not usable shows just its name; why is the kernel's message, a note outside the quote. */
function triggerSourceLine({ name, events, description, problems }) {
  if (Array.isArray(events) && !problems.length) return { text: [events.length ? `${name}: ${events.join(', ')}` : name, ...(description ? [description] : [])] };
  const why = problems.map(displayLine).filter(Boolean);
  return { text: name, note: why.length ? why.map(message => `${TRIGGER_SOURCES_COPY.unusable}: ${message}`) : TRIGGER_SOURCES_COPY.unusable };
}
/** Fill the Provides card's "Trigger sources" row (an element its owner keeps, capability-contents.mjs) from
 * `triggerSourcesView()`: the label and the number of sources, then one quote group under "From the capability's
 * manifest:" (source-quote.mjs: text only, no markup, link, button or tooltip is made from a manifest's string).
 * A declaration that can't be read is the Desktop's plain line, then each of the kernel's messages as its own.
 * Nothing declared (`view` null) empties the row: the page then builds no row. Nothing in it takes focus. */
export function fillTriggerSourcesRow(row, view) {
  const doc = row.ownerDocument;
  row.className = 'provides-row'; row.dataset.provides = 'trigger-sources';
  if (!view) { row.replaceChildren(); return; }
  const term = el(doc, 'dt', null, 'provides-kind'); term.append(el(doc, 'span', TRIGGER_SOURCES_COPY.title));
  const value = el(doc, 'dd', null, 'provides-items provides-sources');
  if (view.unreadable) {
    value.append(el(doc, 'p', TRIGGER_SOURCES_COPY.unreadable, 'provides-unreadable'));
    for (const message of view.unreadable.map(displayLine).filter(Boolean)) value.append(el(doc, 'p', message, 'provides-unreadable-why'));
  } else {
    term.append(el(doc, 'span', String(view.sources.length), 'provides-count'));
    const quote = sourceQuote(doc, { leadIn: LEAD_INS.manifest, lines: view.sources.map(triggerSourceLine) });
    value.append(quote || el(doc, 'span', TRIGGER_SOURCES_COPY.none, 'page-note'));
  }
  row.replaceChildren(term, value);
}
/** The three core capabilities (a soul's `layers`), in the order every surface shows them. */
export const CORE_SLOTS = Object.freeze(['knowledge', 'messaging', 'tasks']);
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** A `capabilitiesOff` entry Core places: a soul emptying a core slot it names (`<slot>: none`). Anything
 * else (a plain off, or a slot-none without a core slot) stays a Capabilities row, so nothing is dropped. */
const emptiesSlot = off => CORE_SLOTS.includes(off?.slot);
/** Whether a resolved capability is Core's: a slot's provider, or a module with a core `layer` whose slot
 * inspect reports (an unreported slot has no Core row to show it, so it stays under Capabilities). */
export function isCoreCapability(inspected, cap) {
  if (CORE_SLOTS.some(slot => text(inspected?.layers?.[slot]?.id) && inspected.layers[slot].id === cap?.id)) return true;
  return CORE_SLOTS.includes(cap?.layer) && record(inspected?.layers?.[cap.layer]);
}
/** `layers.<slot>.from` (feature layers-from) as a reason; null when not reported or a kind this Desktop does not know. */
function layerWhy(from) {
  if (from === 'workspace' || from === 'soul') return { why: from };
  const team = typeof from === 'string' && /^team:(.+)$/.exec(from);
  return team ? { why: 'team', team: team[1] } : { why: null };
}
/** A soul's (or an instance's) core capabilities: one entry per slot, in CORE_SLOTS order,
 * { slot, id, cap, reported, why, team?, names?, name?, reason?, overrides? }. `id` fills the slot (`cap` its
 * capabilities[] row, null when missing); `reported` is false when inspect has no `layers.<slot>`.
 * `why`, only from what the kernel reports: workspace / team / soul from `layers.<slot>.from`
 * (`layersFrom`: the CLI reports layers-from); 'off' for an empty slot the soul emptied
 * (`capabilitiesOff[]` slot-none, `names` every capability it turned off, `name` them joined; `facts`:
 * desktop-facts); 'none' for an empty slot nothing filled, which needs both features, a soul subject (a
 * home's `capabilitiesOff` is always []) and no slot-none entry Core cannot place; else null: no reason is shown. A filled slot never takes an
 * off entry (a contradiction: the provider wins). */
export function coreEntries(inspected, { layersFrom = false, facts = false } = {}) {
  const caps = list(inspected?.capabilities);
  const all = facts && Array.isArray(inspected?.capabilitiesOff) ? inspected.capabilitiesOff.filter(off => record(off) && text(off.id)) : null;
  const offs = all?.filter(emptiesSlot) ?? null;
  // A slot-none this Desktop cannot place might be any slot's: then no empty slot is claimed to have no default.
  const unplaced = !!all?.some(off => off.reason === 'slot-none' && !emptiesSlot(off));
  const soul = inspected?.subject?.kind !== 'instance';
  return CORE_SLOTS.map(slot => {
    const layer = inspected?.layers?.[slot];
    if (!record(layer)) return { slot, id: null, cap: null, reported: false, why: null };
    const id = text(layer.id);
    if (id) return { slot, id, cap: caps.find(cap => cap?.id === id) || null, reported: true, ...(layersFrom ? layerWhy(layer.from) : { why: null }) };
    const off = offs?.filter(entry => entry.slot === slot) ?? [];
    if (off.length) { const names = off.map(entry => entry.id); return { slot, id: null, cap: null, reported: true, why: 'off', reason: 'slot-none', names, name: names.join(', '), overrides: text(off[0].overrides) }; }
    return { slot, id: null, cap: null, reported: true, why: layersFrom && offs && soul && !unplaced && layer.from == null ? 'none' : null };
  });
}
/** The plain-text note a core row carries after its tag (part of the row's text); `spawned`: an instance's words. */
export function coreNote(entry, { spawned = false } = {}) {
  if (entry?.why === 'workspace') return spawned ? 'Resolved the workspace default at spawn' : `Resolves the workspace default: this soul doesn't choose a ${entry.slot} capability`;
  if (entry?.why === 'team') return spawned ? `Resolved the ${entry.team} team's default at spawn` : `Resolves the ${entry.team} team's default`;
  if (entry?.why === 'soul' && spawned) return 'Chosen by the soul at spawn'; // on the soul page the soul tag says it
  // An empty slot explains itself in visible text too (a home reports neither: its capabilitiesOff is always []).
  if (entry?.why === 'off' && !spawned) return `This soul empties the ${entry.slot} slot; ${overridden(entry.overrides)} is ${entry.name}`;
  if (entry?.why === 'none' && !spawned) return `Neither this soul nor the workspace fills the ${entry.slot} slot.`;
  return null;
}
/** The capability page's "Why" row (opened from a soul): [reason, sentence], or null with no reported reason.
 * `entry`: a core entry (it has a `slot`) or a composition entry; `soul`: the soul's name. */
export function whyFact(entry, soul) {
  const slot = CORE_SLOTS.includes(entry?.slot) ? entry.slot : null, who = text(soul) || 'This soul';
  const doesnt = slot ? `${who} doesn't choose a ${slot} capability` : `${who} doesn't declare it`, at = slot ? ` · ${slot}` : '';
  if (entry?.why === 'workspace') return [`Workspace default${at}`, `${doesnt}; it resolves the workspace's default.`];
  if (entry?.why === 'team' && text(entry.team)) return [`${entry.team} team default${at}`, `${doesnt}; it resolves the ${entry.team} team's default.`];
  if (entry?.why === 'soul') return slot ? [`Chosen by the soul${at}`, `${who} chooses its ${slot} capability.`] : ['Declared by the soul', `${who} declares it.`];
  return null;
}
/** A soul's (or an instance's as-spawned) non-core capabilities with why each is there.
 * With `facts` (the CLI reports `desktop-facts`, kernel #217) the kernel says why:
 * `capabilities[].composedFrom` (workspace / team:<label> / soul) and `capabilitiesOff[]`.
 * Otherwise (an older kernel, or `inspect --home`, where composedFrom is null) it is read from
 * the soul's declarations: declared by the soul, else a default, then what the soul turned off.
 * Order: workspace defaults → team defaults → soul → turned off. */
export function compositionEntries(inspected, soul, { facts = false } = {}) {
  const declared = record(soul?.declarations) ? soul.declarations : {};
  const choices = record(declared.capabilities) ? declared.capabilities : {};
  const caps = list(inspected?.capabilities);
  const reported = facts && caps.some(cap => typeof cap.composedFrom === 'string');
  // Core capabilities are the Core section's (isCoreCapability), and so is a soul emptying a core slot.
  const entries = caps.filter(cap => !isCoreCapability(inspected, cap)).map(cap => {
    const own = record(choices[cap.id]), repoOwned = own && choices[cap.id].from === 'here';
    if (!reported) return { cap, why: own ? 'soul' : 'default', repoOwned };
    const team = typeof cap.composedFrom === 'string' && /^team:(.+)$/.exec(cap.composedFrom);
    return { cap, why: team ? 'team' : ['workspace', 'soul'].includes(cap.composedFrom) ? cap.composedFrom : 'default', ...(team ? { team: team[1] } : {}), repoOwned };
  });
  if (facts && Array.isArray(inspected?.capabilitiesOff)) {
    for (const off of inspected.capabilitiesOff) if (record(off) && typeof off.id === 'string' && off.id && !emptiesSlot(off))
      entries.push({ name: off.id, why: 'off', reason: off.reason === 'slot-none' ? 'slot-none' : 'off', slot: null, overrides: typeof off.overrides === 'string' ? off.overrides : null });
  } else for (const [name, choice] of Object.entries(choices)) if (choice === 'off' && !caps.some(cap => cap.id === name)) entries.push({ name, why: 'off' });
  const order = { workspace: 0, default: 0, team: 1, soul: 2, off: 3 };
  return entries.map((entry, i) => [entry, i]).sort(([a, i], [b, j]) => order[a.why] - order[b.why] || i - j).map(([entry]) => entry);
}
/** The why tag's label and title per composition reason (legacy `default`: not declared by the soul). */
export const WHY = { default: ['default', 'Not declared by this soul: a workspace or team default (the kernel does not say which)'],
  workspace: ['workspace', 'A workspace default'], soul: ['soul', 'Declared by this soul'] };
const overridden = layer => { const team = typeof layer === 'string' && /^team:(.+)$/.exec(layer); return team ? `the ${team[1]} team's default` : layer === 'workspace' ? 'the workspace default' : 'a default'; };
/** An entry's (composition or core) tag: [label, title, note?]; a note (turned off, no default) is plain text, not a tag. */
export function whyTag(entry) {
  if (entry.why === 'none') return ['No default', `Neither this soul nor the workspace fills the ${entry.slot} slot`, true];
  if (entry.why === 'team') return [`team · ${entry.team}`, `A default of the ${entry.team} team`, false];
  if (entry.why === 'off') return entry.reason === 'slot-none'
    ? ['turned off by soul', `This soul empties ${entry.slot ? `the ${entry.slot}` : 'a core'} slot, which ${overridden(entry.overrides)} filled with ${entry.name}`, true]
    : ['turned off by soul', `This soul turns off ${overridden(entry.overrides)}`, true];
  const [label, title] = WHY[entry.why] || WHY.default;
  return [label, title, false];
}
/** An entry's why, as every surface shows it: the tag, or the plain note (turned off, no default); null with no reason. */
export function whyElement(doc, entry) {
  const [label, title, plain] = entry?.why ? whyTag(entry) : [];
  if (!label) return null;
  const tag = el(doc, 'span', label, plain ? 'why-note' : `why-tag${entry.why === 'soul' ? ' soul' : ''}`); tag.title = title;
  return tag;
}
/** A soul's composition table (Capability | Source | Why it's here) or its Core capabilities table, one grid. */
function soulTable(doc, label, headers, { core = false } = {}) {
  const table = el(doc, 'div', undefined, `page-table soul-caps${core ? ' soul-core' : ''}`); table.setAttribute('role', 'table'); table.setAttribute('aria-label', label);
  const head = el(doc, 'div', undefined, 'page-table-row head soul-cap-row'); head.setAttribute('role', 'row');
  for (const text of headers) { const cell = el(doc, 'span', text); cell.setAttribute('role', 'columnheader'); head.append(cell); }
  table.append(head);
  return table;
}
/** The row grammar both tables share: a name cell, the source chip (a resolved row only) and the why cell
 * (the tag, or a plain note for turned off / no default, then the row's own explanatory note). */
function soulRow(doc, line, { name, source = null, names, entry, note = null }) {
  line.classList.add('page-table-row', 'soul-cap-row'); line.setAttribute('role', 'row');
  name.classList.add('soul-cap-name'); name.setAttribute('role', 'cell');
  const cell = el(doc, 'span', undefined, 'soul-cap-source'); cell.setAttribute('role', 'cell'); cell.style.minWidth = '0';
  if (source) cell.append(sourceChip(doc, source, names, { boxed: true }));
  const why = el(doc, 'span', undefined, 'soul-cap-why'); why.setAttribute('role', 'cell');
  const tag = whyElement(doc, entry); if (tag) why.append(tag);
  if (note) why.append(el(doc, 'span', note, 'soul-cap-why-note'));
  line.append(name, cell, why);
  return line;
}
/** A soul's composition: entries { cap, why: workspace|team|soul|default, team?, repoOwned } or { name, why: 'off', … }.
 * A row opens its capability's page: onOpen(row, entry). */
export function renderSoulCapabilities(host, { entries, status, onOpen = null }) {
  const doc = host.ownerDocument, names = memberNames(status);
  const node = (tag, value, cls) => el(doc, tag, value, cls);
  host.replaceChildren();
  const table = soulTable(doc, 'Capabilities', ['Capability', 'Source', "Why it's here"]);
  if (!list(entries).length) table.append(node('p', 'No other capabilities: only the core ones.', 'page-note'));
  for (const entry of list(entries)) {
    const off = entry.why === 'off', row = off ? null : { ...capabilityRow(entry.cap), ...(entry.repoOwned ? { private: true } : {}) };
    const name = off ? entry.name : row.name;
    const line = node('div', undefined, off ? 'off' : ''); line.dataset.capability = name;
    const cap = node('span');
    const id = node('span', name, 'soul-cap-id'); id.title = name; cap.append(id);
    if (entry.repoOwned) cap.append(node('span', "repo-owned · this soul's repo", 'soul-cap-note'));
    soulRow(doc, line, { name: cap, source: row, names, entry });
    if (!off && typeof onOpen === 'function') {
      line.classList.add('openable'); line.tabIndex = 0; line.setAttribute('aria-label', `${name}: open its page`);
      line.addEventListener('click', () => onOpen(row, entry));
      line.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(row, entry); } });
    }
    table.append(line);
  }
  host.append(table);
}
/** A soul's Core capabilities (W4): always the three slots, in the Capabilities table's grid and row grammar,
 * led by the slot's icon and name. `entries`: coreEntries(), each optionally with `detail` (what the provider
 * does for this soul). A filled row whose provider was resolved is a button: onOpen(entry) opens its page. */
export function renderSoulCore(host, { entries, status, onOpen = null }) {
  const doc = host.ownerDocument, names = memberNames(status);
  const node = (tag, value, cls) => el(doc, tag, value, cls);
  host.replaceChildren();
  const table = soulTable(doc, 'Core capabilities', ['Core capability', 'Source', "Why it's here"], { core: true });
  for (const entry of list(entries)) {
    const opens = !!entry.cap && typeof onOpen === 'function';
    const line = node(opens ? 'button' : 'div', undefined, entry.id ? '' : entry.why === 'off' ? 'none off' : 'none'); line.dataset.layer = entry.slot;
    const cap = node('span'), icon = node('span', undefined, 'soul-cap-slot-icon'), copy = node('span', undefined, 'soul-cap-copy');
    icon.setAttribute('aria-hidden', 'true'); icon.append(iconElement(doc, capabilityIcon({ layer: entry.slot }), { size: 14 }));
    copy.append(node('span', layerLabel(entry.slot), 'soul-cap-slot'));
    const id = node('span', entry.id || (entry.reported ? 'None' : 'Not reported'), 'soul-cap-id'); if (entry.id) id.title = entry.id; copy.append(id);
    if (entry.id && text(entry.detail)) copy.append(node('span', entry.detail, 'soul-cap-note'));
    cap.append(icon, copy);
    const note = coreNote(entry);
    soulRow(doc, line, { name: cap, source: entry.cap ? capabilityRow(entry.cap) : null, names, entry, note });
    if (entry.id) line.dataset.capability = entry.id;
    if (opens) {
      const [, title] = entry.why ? whyTag(entry) : [];
      line.type = 'button'; line.dataset.focusKey = `core:${entry.slot}`;
      line.setAttribute('aria-label', [`${layerLabel(entry.slot)}: ${entry.id}`, text(entry.detail), note || title].filter(Boolean).join(', ') + ' — open its page');
      line.addEventListener('click', () => onOpen(entry));
    }
    table.append(line);
  }
  host.append(table);
}
