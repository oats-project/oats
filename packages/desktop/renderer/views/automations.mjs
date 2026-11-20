/** Automations (human 2026-09-28: ONE nav item, with Schedules | Triggers subtabs in the
 * Workspace's tab style; no title in the bar) over the Schedules and Triggers pages (§2.3a: one layout).
 * Rows are grouped by where they run — this computer, needs attention here, elsewhere —
 * because the first question is what THIS computer does. Workspace (Git) and local
 * items sit together, each marked with its origin. A row opens its detail page.
 *
 * IO is injected (`read`, `act`, `openFile`): the page renders `automationRows(json)`
 * and never re-derives placement. It is mounted only once the Desktop server serves
 * the kernel's `automations` lists (feature `automations`, automationsApi 1). */
import {
  automationRows, groupRows, filterRows, placementText, ownerParts, taskParts, cronInWords, onSummary, relativeTime,
  hostLogin, templateLabel, soulOriginText, testResult, triggerStatus, summaryLine, runState, reconcileCommand, templateProvenance, eventLabel, firedEntry,
  triggerSourcesSupported, capabilitySource, sourceLabel, sourceParams, sourceCheck, taskFields, causeWords, ruleWords, EVENTS_SHOWN,
} from '../automation-rows.mjs';
import { sourceQuote, sourceQuoteCSS, LEAD_INS } from '../source-quote.mjs';
import { displayLine } from '../../../client/display-text.mjs';
import { descriptionValid, DESCRIPTION_MAX } from '../schedule-read-data.mjs';
import { pageCardCSS, pageBar, pageCard, pageFacts, pageSection } from '../capability-page.mjs';
import { iconElement } from '../shell-icons.mjs';
import { harnessName } from '../identity-marks.mjs';
import { postJson, ensureTheme, wsQuery, currentWorkspace, onWorkspaceChange } from './common.mjs';
import { cliStatus, cliCard, cliKnownUnavailable, onCliChange, cliAboveTested, aboveTestedCard, cliHeldBack } from './cli-status.mjs';

export const automationsCSS = `
.automations { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; background:var(--bg); color:var(--fg); container-type:inline-size; }
.automations[hidden], .automations [hidden] { display:none !important; }
.auto-header { flex:none; display:flex; align-items:center; gap:12px; height:48px; padding:0 calc(16px + var(--main-trail-inset, 0px)) 0 calc(16px + var(--main-lead-inset, 0px)); box-sizing:border-box; border-bottom:1px solid var(--border); background:var(--surface); }
.auto-header h2 { display:flex; align-items:baseline; gap:8px; margin:0; font-size:14px; font-weight:700; }
.auto-count { color:var(--muted); font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); font-weight:400; }
/* The Automations bar, in the Workspace's tab style: Schedules | Triggers, then the page's tools. */
.auto-header.auto-framed { align-items:stretch; gap:22px; }
.auto-header.auto-framed > :not(.auto-heading) { align-self:center; }
.auto-header.auto-framed > .auto-spacer { margin-left:-10px; }
.auto-heading { display:flex; align-items:stretch; gap:22px; min-width:0; }
.auto-tabs { display:flex; flex-wrap:nowrap; overflow-x:auto; gap:22px; min-width:0; scrollbar-width:none; }
.oats-view .auto-tabs button { flex:none; display:inline-flex; align-items:center; gap:6px; height:auto; min-height:0; padding:0; border:0; border-radius:0; background:none; color:var(--nav-fg); font-weight:500; font-size:13px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
.oats-view .auto-tabs button:hover { color:var(--fg); }
.oats-view .auto-tabs button[aria-selected=true] { color:var(--fg); font-weight:650; box-shadow:inset 0 -2px 0 var(--live); }
.oats-view .auto-tabs button:focus-visible { background:var(--sel); border-radius:6px; padding:0 6px; margin:0 -6px; } /* layout-neutral inset */
.auto-tab-count { color:var(--muted); font-weight:normal; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); }
.auto-tab-count:empty { display:none; }
.auto-spacer { flex:1; }
.auto-scheduler { display:inline-flex; align-items:center; gap:7px; color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.auto-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--faint); }
.auto-dot.ok { background:var(--ok); }
/* A problem (Scheduler off, Wrong account / Not trusted / Doesn't run here): a --danger dot, since yellow means needs
   input only (the product owner, 2026-10-26); the words beside it say which. */
.auto-dot.warn { background:var(--danger); }
.oats-view .auto-header button.auto-icon { display:inline-grid; place-items:center; width:30px; height:30px; min-height:30px; padding:0; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); flex:none; }
.oats-view .auto-header button.act:not(.auto-icon) { height:30px; min-height:30px; padding:0 12px; border-radius:7px; font-size:12.5px; font-weight:600; }
.oats-view .auto-header button.act.primary:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); }
.oats-view .auto-banner button.act { margin-left:auto; height:28px; min-height:28px; padding:0 10px; border-radius:6px; font-size:12px; font-weight:600; flex:none; }
.auto-body { flex:1; min-height:0; overflow:auto; padding:16px 20px 24px; }
.auto-banner { display:flex; align-items:center; gap:10px; margin:0 0 14px; padding:10px 12px; border:1px solid var(--attn-border); border-radius:8px; background:var(--attn-bg); color:var(--fg); font-size:12.5px; }
.auto-banner .shell-icon { flex:none; color:var(--warn); }
.auto-toolbar { display:flex; align-items:center; flex-wrap:wrap; justify-content:space-between; gap:8px 10px; margin:0 0 14px; min-width:0; }
.auto-seg { display:inline-flex; height:28px; border:1px solid var(--border); border-radius:7px; overflow:hidden; background:var(--surface); }
.oats-view .auto-seg button { display:inline-flex; align-items:center; gap:6px; height:100%; min-height:0; padding:0 10px; border:0; border-radius:0; background:transparent; color:var(--muted); font-weight:normal; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); }
.oats-view .auto-seg button + button { border-left:1px solid var(--border); }
.oats-view .auto-seg button[aria-pressed=true] { background:var(--surface-2); color:var(--fg); font-weight:650; }
.auto-seg-count { font-weight:normal; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); }
.auto-search { display:flex; align-items:center; gap:7px; flex:0 1 240px; min-width:0; height:28px; padding:0 10px; box-sizing:border-box; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--muted); }
.auto-search .shell-icon { flex:none; }
.oats-view .auto-search input { flex:1; min-width:0; height:100%; min-height:0; padding:0; border:0; background:transparent; color:var(--fg); font-size:12px; outline:none; }
.auto-search:focus-within { border-color:var(--accent); }
.auto-group { display:flex; flex-direction:column; gap:8px; margin:0 0 20px; }
.auto-group-title { display:flex; align-items:baseline; gap:8px; margin:0; padding:0 2px; font-size:12.5px; font-weight:650; color:var(--fg); }
.auto-group-title.warn { color:var(--warn); }
.auto-group-note { color:var(--muted); font-weight:500; }
.auto-table { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.auto-row { display:grid; grid-template-columns:40px minmax(170px,1.4fr) minmax(120px,1fr) minmax(150px,1.2fr) minmax(130px,1fr) minmax(110px,.9fr) 34px; gap:12px; align-items:center; min-height:54px; padding:6px 12px; box-sizing:border-box; border-top:1px solid var(--tag-bg); font-size:12px; }
.auto-row.head { min-height:32px; border-top:0; border-bottom:1px solid var(--border); color:var(--muted); font-size:11px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; }
.auto-row.head + .auto-row { border-top:0; }
.auto-cell { display:flex; flex-direction:column; gap:2px; min-width:0; }
.auto-main-line { display:flex; align-items:center; gap:6px; min-width:0; color:var(--fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.auto-main-line > span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
/* A text-only line: the event or cron words wrap rather than clip; a one-line fact ellipsizes (title keeps it whole). */
.auto-main-line.auto-wrap { display:block; white-space:normal; overflow-wrap:anywhere; }
.auto-main-line.auto-text { display:block; }
.auto-sub { color:var(--muted); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.auto-sub.auto-remedy { white-space:normal; overflow:visible; overflow-wrap:anywhere; line-height:1.45; }
.auto-mono { font-family:var(--mono,monospace); }
.oats-view .auto-row button.auto-open { display:flex; flex-direction:column; align-items:flex-start; gap:3px; min-width:0; min-height:0; padding:2px 0; border:0; background:transparent; color:var(--fg); text-align:left; font:inherit; cursor:pointer; }
.auto-open .auto-id { max-width:100%; font-weight:650; font-size:12.5px; line-height:normal; font-family:var(--mono,monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.oats-view .auto-row button.auto-open:hover .auto-id { text-decoration:underline; }
.auto-tags { display:flex; flex-wrap:wrap; gap:4px; min-width:0; }
.auto-tag { display:inline-flex; align-items:center; gap:4px; height:18px; padding:0 6px; border-radius:4px; background:var(--tag-bg); color:var(--fg); font-size:10.5px; font-weight:600; white-space:nowrap; }
.auto-tag .shell-icon { color:var(--muted); }
.auto-tag.muted { background:transparent; border:1px solid var(--border); color:var(--muted); font-weight:500; }
.auto-tag.warn { background:var(--attn-bg); color:var(--fg); }
.auto-row.off .auto-id, .auto-row.off .auto-main-line { color:var(--muted); }
.auto-place { display:flex; align-items:center; gap:6px; min-width:0; }
.auto-place.warn { color:var(--warn); font-weight:600; }
.oats-view button.auto-switch { position:relative; width:30px; height:18px; min-height:18px; padding:0; border:1px solid var(--border); border-radius:999px; background:var(--surface-2); flex:none; }
.oats-view button.auto-switch::after { content:""; position:absolute; top:2px; left:2px; width:12px; height:12px; border-radius:50%; background:var(--muted); }
.oats-view button.auto-switch[aria-checked=true] { border-color:var(--primary-bg); background:var(--primary-bg); }
.oats-view button.auto-switch[aria-checked=true]::after { left:14px; background:var(--primary-fg); }
/* Keyboard focus (theme.css rule 2): the switch keeps its own pair under the global edge; the row link tints. */
.oats-view .auto-row button.auto-open:focus-visible { background:var(--sel); border-radius:6px; padding:2px 6px; margin:0 -6px; }
.auto-menu { position:relative; justify-self:end; }
.auto-menu summary { display:grid; place-items:center; width:28px; height:28px; border-radius:6px; color:var(--muted); cursor:pointer; list-style:none; }
.auto-menu summary::-webkit-details-marker { display:none; }
.auto-menu summary:hover { background:var(--surface-2); color:var(--fg); }
.auto-menu-list { position:absolute; right:0; top:32px; z-index:5; display:flex; flex-direction:column; min-width:170px; padding:4px; border:1px solid var(--border); border-radius:8px; background:var(--surface); box-shadow:var(--shadow-popover); }
.oats-view .auto-menu-list button { justify-content:flex-start; height:30px; min-height:30px; padding:0 10px; border:0; border-radius:5px; background:transparent; color:var(--fg); font-size:12.5px; text-align:left; }
.oats-view .auto-menu-list button:hover:not(:disabled) { background:var(--surface-2); }
.auto-none { color:var(--muted); }
.auto-foot { margin:6px 2px 0; color:var(--muted); font-size:12px; }
.auto-empty { margin:40px auto; max-width:460px; text-align:center; color:var(--muted); font-size:13px; line-height:1.5; }
.auto-empty strong { display:block; margin-bottom:6px; color:var(--fg); font-size:14px; }
.auto-status { margin:0 0 12px; color:var(--muted); font-size:12px; }
.auto-status.error { color:var(--danger); }
@container (max-width: 900px) {
  .auto-row { grid-template-columns:40px minmax(0,1fr) 34px; grid-auto-rows:auto; row-gap:4px; }
  .auto-row.head { display:none; }
  .auto-row > .auto-cell:not(.auto-name) { grid-column:2; }
  .auto-row > .auto-menu { grid-column:3; grid-row:1; }
}
.auto-page { flex:1; min-height:0; overflow:auto; }
.auto-page .page-title.mono { font-size:18px; }
.auto-cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
@container (max-width: 700px) { .auto-cards { grid-template-columns:minmax(0,1fr); } }
.auto-page .page-identity > .auto-switch { margin-left:auto; }
/* Detail facts wrap instead of cropping (the list rows keep one line, with a title). */
.auto-page .page-kv { align-items:start; padding:7px 0; min-height:0; }
.auto-page .page-kv dd { white-space:normal; overflow-wrap:anywhere; }
.auto-prompt { margin:0; padding:12px 14px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--fg); font-weight:normal; font-size:12.5px; line-height:1.6; font-family:var(--mono,monospace); white-space:pre-wrap; overflow-wrap:anywhere; }
.auto-token { padding:1px 4px; border-radius:4px; background:var(--chip-bg); color:var(--fg); font-weight:650; }
.auto-verdict { display:flex; align-items:center; gap:7px; margin-top:4px; font-size:12.5px; font-weight:600; }
.auto-verdict.warn { color:var(--warn); }
.auto-runs { display:flex; flex-direction:column; }
.auto-run { display:grid; grid-template-columns:120px minmax(0,1fr); gap:10px; align-items:baseline; padding:7px 0; border-top:1px solid var(--tag-bg); font-size:12px; }
.auto-run:first-child { border-top:0; }
.auto-run time { color:var(--muted); font-size:11.5px; }
.auto-test-line { margin:0; font-size:12px; overflow-wrap:anywhere; }
.auto-test-line.warn { color:var(--warn); }
/* A trigger's status lists (waiting, live, fired) and the Test card's would-fire entries: plain lists, no markers. */
.auto-list { margin:0; padding:0; list-style:none; }
.auto-list-head { margin:8px 0 0; color:var(--muted); font-size:11.5px; font-weight:650; }
.auto-live li, .auto-fire li { padding:4px 0; font-size:12px; overflow-wrap:anywhere; }
.auto-fire { margin:2px 0 0 12px; }
/* The summary line: authored, or derived from the prompt's first line (muted italic, its title says so). */
.auto-sub.auto-summary.derived { font-style:italic; }
.auto-qid { margin:0; color:var(--muted); font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.auto-page .page-lede { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; overflow-wrap:anywhere; }
.oats-view .auto-page button.auto-lede-edit { height:24px; min-height:24px; padding:0 8px; border-radius:6px; font-size:12px; font-weight:600; }
/* A command's argv, verbatim: one chip per argument, so the boundaries show. */
.auto-argv { display:flex; flex-wrap:wrap; gap:6px; margin:0; padding:12px 14px; list-style:none; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.auto-argv li { padding:1px 6px; border-radius:4px; background:var(--chip-bg); color:var(--fg); font-weight:normal; font-size:12.5px; line-height:1.6; font-family:var(--mono,monospace); white-space:pre-wrap; overflow-wrap:anywhere; }
.auto-command { padding:1px 4px; border-radius:4px; background:var(--chip-bg); color:var(--fg); font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.auto-card-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:4px; }
.oats-view .auto-card-actions button.act { height:28px; min-height:28px; padding:0 10px; border-radius:6px; font-size:12px; font-weight:600; }
/* Edit summary: a small modal sheet over the page. */
.auto-sheet { position:fixed; z-index:90; inset:0; display:grid; place-items:center; padding:24px; background:var(--scrim); }
.auto-sheet[hidden] { display:none; }
.auto-describe { display:grid; gap:10px; width:min(480px, 100%); box-sizing:border-box; padding:18px 20px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); font-size:12.5px; }
.auto-describe h3 { margin:0; font-size:15px; overflow-wrap:anywhere; }
.auto-describe label { display:grid; gap:5px; }
.auto-describe .field { width:100%; min-width:0; box-sizing:border-box; }
.auto-describe-error { margin:0; color:var(--danger); font-size:12.5px; }
.auto-describe-error:empty, .auto-describe-status:empty { display:none; }
.auto-describe-status { margin:0; color:var(--muted); font-size:12px; outline:none; }
.auto-describe-actions { display:flex; flex-wrap:wrap; gap:8px; }
/* A capability source (feature trigger-sources): its parameters and its own words sit in the quote treatment
   (source-quote.mjs); the Test confirm is a side card whose heading and status line take programmatic focus. */
.auto-on-source { display:flex; flex-direction:column; gap:8px; min-width:0; }
.auto-on-source .page-note { overflow-wrap:anywhere; }
.auto-tag.warn .shell-icon { color:var(--warn); }
.auto-source-lists { display:flex; flex-direction:column; gap:8px; min-width:0; margin-top:8px; }
.auto-source-lists .auto-list-head { margin:0; }
.auto-confirm { gap:8px; border-color:var(--attn-border); }
.auto-confirm .auto-test-line code, .auto-test-line code.auto-mono { font-weight:normal; font-size:12px; line-height:normal; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.auto-confirm-status:focus-visible, .page-card-title:focus-visible { outline:1px solid var(--accent); outline-offset:2px; border-radius:3px; }
.auto-confirm-status { margin:0; color:var(--muted); font-size:12px; }
.auto-confirm-status:empty { display:none; }
.auto-fire .auto-fire-url { display:block; color:var(--muted); font-weight:normal; font-size:11.5px; line-height:normal; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
`;

/** "14:05" today, else "6 Oct, 14:05": when a run state began (its title keeps the full date). */
function clockTime(iso, now) {
  const d = new Date(iso), today = new Date(now).toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
const HEADS = ['On', 'Automation', 'Soul', 'When', 'Runs on', 'Last · next', ''];
const TITLES = { schedule: 'Schedules', trigger: 'Triggers' };
const NAME_CUT = 'The purpose was cut and a hash added so the name fits 64 characters.';
const OUTCOMES = { launched: 'agent launched', active: 'agent active', running: 'agent active', ended: 'run ended', stopped: 'agent stopped', unknown: 'launch state unknown', 'launch-failed': 'launch failed', skipped: 'skipped', delivered: 'wake delivered' };

/** read(): the list JSON · act(verb, row, { runSource }?): enable|disable|test|run → kernel JSON (`runSource: true`
 * only from a capability source's confirmed Run test) · status(row): a trigger's
 * `oats trigger status` JSON (fire history, live instances) · openFile(row): open its defining file. */
/** verbs: the act verbs this server serves (default all) · headerActions(doc): extra header controls ·
 * rowActions(row): extra { label, run, enabled } for a row's menu and page · onEnableScheduler: the banner's action. */
/** heading: the Automations title + subtabs, in place of the page's own title (its count then goes to `onCount(n)`). */
/** describe(row, text): set (or, with "", clear) a local row's summary (feature automation-descriptions); null hides Edit summary. */
/** sources: the CLI declares `trigger-sources` (#669 2b). Only then is a trigger whose `on.source` is not
 * github.pull_request a capability-source row: its On card, last poll, refused and skipped events, source check and
 * the informed Test (a confirm first: its Test runs a capability's command on this computer). Without it nothing
 * changes. canOpenCapability(name) / openCapability(name): the source's capability page, when the catalog lists it. */
export function createAutomationsView(host, { kind, read, act = null, status = null, openFile = null, now = () => Date.now(),
  verbs = null, headerActions = null, rowActions = null, onEnableScheduler = null, onResult = null, heading = null, onCount = null, describe = null,
  sources = false, canOpenCapability = () => false, openCapability = null } = {}) {
  const doc = host.ownerDocument;
  const node = (tag, value, cls) => { const el = doc.createElement(tag); if (value !== undefined && value !== null) el.textContent = value; if (cls) el.className = cls; return el; };
  const title = TITLES[kind], noun = kind === 'trigger' ? 'trigger' : 'schedule';
  const root = node('section', undefined, 'oats-view automations'); root.dataset.kind = kind;
  const style = node('style'); style.textContent = pageCardCSS + automationsCSS + sourceQuoteCSS;
  const header = node('header', undefined, 'auto-header'), h2 = node('h2'), count = node('span', '', 'auto-count');
  h2.append(node('span', title), count);
  const scheduler = node('span', '', 'auto-scheduler'); scheduler.hidden = true;
  const refreshButton = node('button', undefined, 'act auto-icon'); refreshButton.type = 'button';
  refreshButton.append(iconElement(doc, 'refresh', { size: 14 })); refreshButton.setAttribute('aria-label', `Refresh ${title.toLowerCase()}`); refreshButton.title = 'Refresh';
  if (heading) header.classList.add('auto-framed');
  header.append(heading || h2, node('span', undefined, 'auto-spacer'), scheduler, ...(headerActions ? headerActions(doc) : []), refreshButton);
  const body = node('div', undefined, 'auto-body'), page = node('div', undefined, 'auto-page'); page.hidden = true;
  // #482: these are read from the view's primary deployment, which the page does not name (the product owner, 2026-10-23).
  root.append(style, header, body, page); host.append(root);

  let alive = true, serial = 0, data = null, failure = '', loading = false, origin = 'all', query = '', openId = null, busy = false, notice = '';
  const tests = new Map(), statuses = new Map();
  // Capability sources. `confirming`: the row whose Test confirm shows (with that row as it was: confirmSig);
  // `testing`: the row whose confirmed test runs.
  // `confirmToken`: the one confirm that is open, as an identity. Its Cancel and Run test are bound to it, so a
  // control kept from a confirm that was closed, replaced or disposed does nothing. `sourceGens`: a row's source
  // generation, moved on every change of its `on.source`: a test answers for the generation it was asked in.
  let confirming = null, confirmSig = null, confirmToken = null, testing = null;
  const sourceGens = new Map(), genOf = id => sourceGens.get(id) || 0;
  const revokeConfirm = () => { confirming = null; confirmSig = null; confirmToken = null; };
  // The row whose one-click Test the kernel answered with E_TRIGGER_SOURCE_RUN: a neutral notice, until the next action.
  let ranNothing = null;
  const NOTHING_RAN = "Nothing ran. Testing this trigger runs a capability's source command and needs your confirmation.";
  const lastSources = new Map(), statusTickets = new Map();
  const sourceOf = row => sources && row?.kind === 'trigger' ? capabilitySource(row.on, statuses.get(row.id)?.source) : null;
  const rowSignature = row => JSON.stringify(row.raw);
  const focusKey = key => page.querySelector(`[data-auto-focus="${key}"]`)?.focus({ preventScroll: true });
  // An item's defining file opens read-only from this machine (a local item, a cloned member),
  // else as its web page; the kernel reports both, the Desktop never builds a path.
  const canOpen = row => !!openFile && !!(row.origin.localPath || row.origin.url);
  const openTitle = row => row.origin.localPath || row.origin.url
    || 'This computer has no clone of this member, and the kernel reports no web address for the file';
  const supports = verb => !!act && (!verbs || verbs.includes(verb));
  // A summary is edited here only for a local item the kernel could read; a workspace one changes in Git.
  const canDescribe = row => !!describe && row.origin.kind === 'local' && !row.unreadable;
  const rowById = id => data?.rows.find(r => r.id === id) || null;

  // ── toolbar (persistent: the search keeps focus across renders) ──
  const toolbar = node('div', undefined, 'auto-toolbar');
  const seg = node('div', undefined, 'auto-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', `Show ${title.toLowerCase()} from`);
  const segButtons = new Map();
  for (const [id, label] of [['all', 'All'], ['workspace', 'Workspace'], ['local', 'Local']]) {
    const b = node('button'); b.type = 'button'; b.dataset.origin = id; b.append(node('span', label), node('span', '', 'auto-seg-count'));
    b.addEventListener('click', () => { origin = id; render(); }); segButtons.set(id, b); seg.append(b);
  }
  const search = node('label', undefined, 'auto-search'), input = node('input');
  input.type = 'search'; input.placeholder = `Search ${title.toLowerCase()}`; input.autocomplete = 'off'; input.setAttribute('aria-label', `Search ${title.toLowerCase()}`);
  input.addEventListener('input', () => { query = input.value; render(); });
  search.append(iconElement(doc, 'search', { size: 14 }), input); toolbar.append(seg, search);
  // The body's parts persist; each render replaces only the notices and the list,
  // so the search keeps its focus and caret while it narrows the rows.
  const notices = node('div'), listHost = node('div');
  body.append(notices, toolbar, listHost);

  async function refresh() {
    const id = ++serial; loading = true; failure = ''; render();
    let reread = null;
    try {
      const next = automationRows(await read(), kind);
      if (!alive || id !== serial) return;
      if (!next) throw new Error(`This OATS did not answer a ${noun} list.`);
      // A trigger whose source changed has another source's state: the kernel drops the old one's lists at once,
      // so its status is read again and a Test result kept for it is dropped.
      if (sources) for (const row of next.rows) {
        const source = typeof row.on?.source === 'string' ? row.on.source : null;
        if (lastSources.has(row.id) && lastSources.get(row.id) !== source) { statuses.delete(row.id); tests.delete(row.id); sourceGens.set(row.id, genOf(row.id) + 1); statusTickets.set(row.id, (statusTickets.get(row.id) || 0) + 1); if (openId === row.id) reread = row.id; }
        lastSources.set(row.id, source);
      }
      data = next;
    } catch (error) { if (alive && id === serial) failure = error?.message || String(error); }
    finally { if (alive && id === serial) { loading = false; render(); if (reread && openId === reread) void loadStatus(reread); } }
  }
  async function perform(verb, row) {
    if (!act || busy) return;
    // A capability source's Test is never one click: it goes through its confirm (runConfirmed), from every entry.
    if (verb === 'test' && sourceOf(row)) { openConfirm(row); return; }
    busy = true; ranNothing = null; render();
    // A test's answer is the answer about the source it was asked for: one that lands after the row's source
    // changed (success or failure) leaves no result.
    let unconfirmed = false; const gen = genOf(row.id), current = () => genOf(row.id) === gen;
    // This press carried no confirmation and the row turned out to be a capability source's (it became one since the
    // list was read), so no capability code ran. That is not a failure of the trigger: say so, without a result card
    // or a warning, re-read the row, and leave the operator at Test, which now opens the confirm. The kernel says it
    // two ways, and both end here: E_TRIGGER_SOURCE_RUN, or an answer about the source (a check that failed before
    // the gate), which the confirmed test will give again.
    const ranNoSource = () => { unconfirmed = true; tests.delete(row.id); ranNothing = row.id; };
    try {
      const result = await act(verb, row);
      if (!alive) return;
      if (verb === 'test') {
        const read = testResult(result, kind, { source: row.on?.source }) || { ok: false, error: `This OATS did not answer a ${noun} test.` };
        if (sources && read.source && !sourceOf(row)) ranNoSource();
        else if (current()) tests.set(row.id, read);
      } else { onResult?.(verb, row, result); await refresh(); }
    } catch (error) {
      if (!alive) return;
      if (verb === 'test' && error?.code === 'E_TRIGGER_SOURCE_RUN') ranNoSource();
      else if (verb === 'test') { if (current()) tests.set(row.id, { ok: false, error: error?.message || String(error) }); }
      else failure = error?.message || String(error);
    } finally {
      if (alive) {
        busy = false; render();
        if (unconfirmed) { await refresh(); if (alive && openId === row.id && (!doc.activeElement || doc.activeElement === doc.body)) focusKey('test'); }
      }
    }
  }

  // ── a capability source's Test: an informed second press (the confirm is consent to ONE manual run) ──
  const TIMED_OUT = 'The test did not answer in time. Nothing was recorded.';
  const timedOut = error => error?.code === 'E_CLI_TIMEOUT' || error?.name === 'TimeoutError' || /TimeoutError/.test(error?.message || '');
  /** Opens the confirm on this row's page. The confirm itself runs nothing, reads nothing and waits for nothing: it
   * is built from the row on screen. From a row's menu the page opens first, and reads its own status as every
   * page open does (recorded state; it executes nothing). */
  function openConfirm(row) {
    if (!alive || busy || testing || !act || !sourceOf(row)) return;
    const opens = openId !== row.id; if (opens) openId = row.id;
    confirming = row.id; confirmSig = rowSignature(row); confirmToken = {}; ranNothing = null; render(); focusKey('confirm-title');
    if (opens) void loadStatus(row.id);
  }
  /** Cancel and Escape. `token`: the confirm the pressed control belongs to (omitted: the open one). */
  function closeConfirm(token = confirmToken) {
    const id = confirming; if (!alive || !id || testing || !token || token !== confirmToken) return;
    revokeConfirm(); render(); focusKey('test');
  }
  /** Run test: exactly one `trigger test` of the confirmed row, and nothing else: no retry, no re-read, no re-test on
   * a refresh. `token`: the confirm the pressed control belongs to; only the confirm that is open, on a view that is
   * alive, may run. Guarded against a second entry here, not only by the disabled buttons. */
  async function runConfirmed(token) {
    if (!alive || !token || token !== confirmToken) return;
    const row = confirming && !busy && !testing ? rowById(confirming) : null;
    if (!row || !act || openId !== row.id || rowSignature(row) !== confirmSig || !sourceOf(row)) return;
    const source = row.on.source, gen = genOf(row.id); let failed = false, kept = false;
    // The answer is the one about this source as it was confirmed: a row whose source changed meanwhile (even
    // back again) keeps no result of the test asked before the change.
    const keep = result => { if (genOf(row.id) === gen) { tests.set(row.id, result); kept = true; } };
    testing = row.id; busy = true; render(); focusKey('confirm-status');
    try {
      const result = testResult(await act('test', row, { runSource: true }), kind, { source });
      if (!alive) return;
      failed = !result; keep(result || { ok: false, error: `This OATS did not answer a ${noun} test.` });
    } catch (error) {
      if (!alive) return;
      failed = true; keep(timedOut(error) ? { ok: false, error: TIMED_OUT } : { ok: false, error: error?.message || String(error), code: typeof error?.code === 'string' ? error.code : null });
    } finally {
      if (alive) {
        // Focus follows the answer only where the operator still is: on this page, in the confirm (or nowhere).
        const at = doc.activeElement, here = openId === row.id && (!at || at === doc.body || !!page.querySelector('.auto-confirm')?.contains(at));
        testing = null; busy = false; if (confirming === row.id) revokeConfirm(); render();
        if (here) focusKey(failed || !kept ? 'test' : 'result-title');
      }
    }
  }

  // ── pieces ──
  function switchFor(row) {
    if (row.group === 'elsewhere') return node('span');
    const b = node('button', undefined, 'auto-switch'); b.type = 'button'; b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(row.enabledHere)); b.setAttribute('aria-label', `${row.id} enabled on this computer`);
    b.title = row.reason === 'untrusted' ? `${row.enabledHere ? 'On' : 'Off'} here, but not trusted on this computer: it runs only once oats-local.yaml trusts it`
      : row.enabledHere ? 'On here: click to turn it off on this computer' : 'Off here: click to turn it on';
    b.disabled = busy || !supports(row.enabledHere ? 'disable' : 'enable');
    b.addEventListener('click', () => perform(row.enabledHere ? 'disable' : 'enable', row));
    return b;
  }
  function originTag(row) {
    const tag = node('span', undefined, 'auto-tag');
    tag.append(iconElement(doc, row.origin.kind === 'local' ? 'computer' : 'repo', { size: 11 }), node('span', row.origin.kind === 'local' ? 'local' : row.origin.member || 'workspace'));
    tag.title = row.origin.kind === 'local' ? 'Local to this computer' : [row.origin.repoKey, row.origin.path].filter(Boolean).join(' · ');
    return tag;
  }
  function stateTags(row, tags) {
    if (!row.enabledHere && row.group !== 'elsewhere') tags.append(node('span', 'Off here', 'auto-tag muted'));
    const bad = row.invalid || row.unreadable;
    // A capability source's meaning check that failed at a poll (`invalid` with `at`) is a state of its own, in text
    // and an icon: the definition is as written, its source no longer answers to it.
    const check = !row.unreadable && sourceOf(row) ? sourceCheck(row.invalid) : null;
    if (check?.at) { const t = node('span', undefined, 'auto-tag warn auto-source-check'); t.append(iconElement(doc, 'warning', { size: 11 }), node('span', 'Source check failed')); t.title = check.message || check.code || ''; tags.append(t); }
    else if (bad) { const t = node('span', row.unreadable ? 'Unreadable' : 'Invalid', 'auto-tag warn'); t.title = bad.message || bad.code || ''; tags.append(t); }
    const template = templateLabel(row.template);
    if (template) { const t = node('span', undefined, 'auto-tag muted'); t.append(iconElement(doc, 'package', { size: 11 }), node('span', template)); t.title = `From the package template ${template}${row.template.version ? ` ${row.template.version}` : ''}`; tags.append(t); }
  }
  function soulLine(row) {
    const line = node('span', undefined, 'auto-main-line');
    if (!row.soul) { line.append(node('span', row.run && row.run !== 'spawn' ? `${row.run}` : 'Not reported', 'auto-none')); return line; }
    const o = row.soul.origin, icon = o?.kind === 'package' ? 'package' : o?.kind === 'external' ? 'external' : o?.kind === 'ambiguous' || !o ? 'warning' : 'repo';
    line.append(iconElement(doc, icon, { size: 12 }), node('span', row.soul.name, 'auto-mono'));
    line.title = `${row.soul.name} · ${soulOriginText(o).long}`;
    return line;
  }
  /** The row's summary line, as text: authored, derived from the prompt (styled so), or "No summary". */
  function summaryEl(row) {
    const s = summaryLine(row);
    const el = node('span', s ? s.text : 'No summary', `auto-sub auto-summary${s?.derived ? ' derived' : ''}${s ? '' : ' auto-none'}`);
    if (s) el.title = s.title;
    return el;
  }
  const soulSub = row => row.soul ? soulOriginText(row.soul.origin).short : '';
  function whenCell(row) {
    const cell = node('div', undefined, 'auto-cell');
    if (row.kind === 'schedule') {
      const main = node('span', cronInWords(row.cron) || row.cron || 'Not reported', 'auto-main-line auto-wrap'); main.title = [row.cron, row.tz].filter(Boolean).join(' · ');
      cell.append(main);
      // The cron itself goes under its words; with no words, the main line is already the cron.
      cell.append(node('span', [cronInWords(row.cron) ? row.cron : null, row.tz].filter(Boolean).join(' · '), 'auto-sub auto-mono'));
    } else {
      const on = onSummary(row.on, { sources });
      const main = node('span', on?.title || 'Not reported', 'auto-main-line auto-wrap'); main.title = main.textContent;
      cell.append(main);
      if (on) cell.append(node('span', [on.repo, ...on.labels.map(l => `#${l}`)].filter(Boolean).join(' · '), 'auto-sub'));
    }
    return cell;
  }
  function runsOnCell(row) {
    const cell = node('div', undefined, 'auto-cell'), p = placementText(row, data.host);
    const place = node('span', undefined, `auto-place${p.tone === 'warn' ? ' warn' : ''}`);
    place.append(node('span', '', `auto-dot ${p.tone}`), node('span', p.label)); place.title = p.detail || '';
    const owner = ownerParts(row.owner);
    cell.append(place, node('span', row.origin.kind === 'local' ? 'local' : owner ? `as @${owner.login}` : row.owner || '', 'auto-sub'));
    return cell;
  }
  function lastNextCell(row) {
    const cell = node('div', undefined, 'auto-cell');
    if (!row.runsHere && row.group !== 'here') { cell.append(node('span', '—', 'auto-none')); return cell; }
    const next = relativeTime(row.nextDue, now()), last = relativeTime(row.lastRun?.at || row.lastRun?.startedAt || row.lastRun?.scheduledFor, now());
    // A trigger that runs here but has not polled yet polls at the next tick (nextDue null).
    const n = node('span', next ? `Next ${next.label}` : !row.enabledHere ? 'Off here' : row.runsHere && kind === 'trigger' ? 'Polls at the next tick' : 'Next not reported', 'auto-main-line auto-text'); n.title = next ? next.title : n.textContent;
    // A trigger's last fire is named by its event's subject (0.49), else its number; a schedule's by its outcome.
    const fired = kind === 'trigger' ? eventLabel(row.lastRun, row.on?.source) : row.lastRun?.number ? `#${row.lastRun.number}` : null;
    const l = node('span', last ? `Last ${last.label}${row.lastRun?.outcome ? ` · ${OUTCOMES[row.lastRun.outcome] || row.lastRun.outcome}` : fired ? ` · ${fired}` : ''}` : 'Not run yet', 'auto-sub'); if (last) l.title = last.title;
    cell.append(n, l); return cell;
  }
  function menuFor(row) {
    const menu = node('details', undefined, 'auto-menu'), summary = node('summary');
    summary.append(iconElement(doc, 'more', { size: 15 })); summary.setAttribute('aria-label', `Actions for ${row.id}`);
    const items = node('div', undefined, 'auto-menu-list');
    // Closing the menu from inside it hands focus back to its summary, never to <body> (spec F).
    const closeMenu = () => { const inside = menu.contains(doc.activeElement); menu.open = false; if (inside && summary.isConnected) summary.focus(); };
    const item = (label, verb, enabled = true) => { const b = node('button', label); b.type = 'button'; b.dataset.verb = verb; b.disabled = busy || !enabled; b.addEventListener('click', () => { closeMenu(); if (verb === 'open') openRow(row.id); else if (verb === 'file') openFile?.(row); else void perform(verb, row); }); items.append(b); };
    item('Open', 'open');
    if (supports('test')) item('Test', 'test');
    if (row.kind === 'schedule' && row.runsHere && supports('run')) item('Run now', 'run');
    if (row.group !== 'elsewhere' && supports(row.enabledHere ? 'disable' : 'enable')) item(row.enabledHere ? 'Turn off here' : 'Turn on here', row.enabledHere ? 'disable' : 'enable');
    if (canOpen(row)) item('Open file', 'file');
    if (canDescribe(row)) { const b = node('button', 'Edit summary'); b.type = 'button'; b.dataset.verb = 'describe'; b.disabled = busy; b.addEventListener('click', () => { closeMenu(); openDescribe(row); }); items.append(b); }
    for (const extra of rowActions ? rowActions(row) : []) {
      const b = node('button', extra.label); b.type = 'button'; b.dataset.verb = extra.verb || ''; b.disabled = busy || extra.enabled === false;
      b.addEventListener('click', () => { closeMenu(); extra.run(); }); items.append(b);
    }
    // Escape closes it (back on its summary); Tab out of it closes it too.
    menu.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.open && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); closeMenu(); } });
    menu.addEventListener('focusout', e => { if (menu.open && e.relatedTarget && !menu.contains(e.relatedTarget)) menu.open = false; });
    menu.append(summary, items); return menu;
  }
  function rowEl(row) {
    const el = node('div', undefined, `auto-row${!row.enabledHere && row.group !== 'elsewhere' ? ' off' : ''}`); el.setAttribute('role', 'row'); el.dataset.id = row.id; el.dataset.group = row.group;
    const nameCell = node('div', undefined, 'auto-cell auto-name'), open = node('button', undefined, 'auto-open'); open.type = 'button';
    // The bare name beside its origin tag (local, or the member): the tag already says where it is from.
    const id = node('span', row.name, 'auto-id'); id.title = row.id; const tags = node('span', undefined, 'auto-tags'); tags.append(originTag(row)); stateTags(row, tags);
    open.append(id, tags); open.setAttribute('aria-label', `Open ${row.id}`); open.addEventListener('click', () => openRow(row.id));
    nameCell.append(open, summaryEl(row));
    // Untrusted here (0.30): the kernel's words, which name the oats-local.yaml line to add, in the row itself.
    if (row.reason === 'untrusted' && row.reasonDetail) nameCell.append(node('span', row.reasonDetail, 'auto-sub auto-remedy'));
    const soul = node('div', undefined, 'auto-cell'); soul.append(soulLine(row), node('span', soulSub(row), 'auto-sub'));
    const cells = [switchFor(row), nameCell, soul, whenCell(row), runsOnCell(row), lastNextCell(row), menuFor(row)];
    for (const [i, cell] of cells.entries()) { if (i && i < 6) cell.setAttribute('role', 'cell'); el.append(cell); }
    return el;
  }

  // ── list ──
  function renderList() {
    // A re-render (after an action re-reads the list) keeps keyboard focus on the same row's
    // same control, never dropping it to <body> (spec F audit).
    const was = doc.activeElement, wasRow = listHost.contains(was) ? was.closest('.auto-row')?.dataset.id : null;
    const part = !wasRow ? null : was.closest('.auto-menu') ? '.auto-menu summary' : was.classList.contains('auto-switch') ? '.auto-switch' : '.auto-open';
    notices.replaceChildren(); listHost.replaceChildren();
    const rows = data?.rows || [];
    toolbar.hidden = !data;
    setText(count, data ? String(rows.length) : ''); onCount?.(data ? rows.length : null);
    renderScheduler();
    if (failure) notices.append(node('p', failure, 'auto-status error'));
    if (notice) { const n = node('p', notice, 'auto-status auto-notice'); n.setAttribute('role', 'status'); notices.append(n); }
    if (ranNothing) { const n = node('p', NOTHING_RAN, 'auto-status auto-ran-nothing'); n.setAttribute('role', 'status'); notices.append(n); }
    if (!data) { if (loading) notices.append(node('p', `Reading ${title.toLowerCase()}…`, 'auto-status')); return; }
    if (!data.host.name && rows.some(r => r.reason === 'host-unnamed')) banner(`This computer has no host name, so it runs none of the workspace's ${title.toLowerCase()}. Name it in this deployment's local settings to take on the ones assigned to it.`);
    if (data.scheduler && !schedulerOn(data.scheduler) && rows.some(r => r.runsHere)) banner('The scheduler is not running on this computer, so nothing here runs until it is enabled.', onEnableScheduler && ['Enable scheduler', onEnableScheduler]);
    for (const [id, b] of segButtons) { b.setAttribute('aria-pressed', String(id === origin)); setText(b.querySelector('.auto-seg-count'), String(id === 'all' ? rows.length : rows.filter(r => r.origin.kind === id).length)); }
    if (!rows.length) {
      const empty = node('div', undefined, 'auto-empty'); empty.append(node('strong', `No ${title.toLowerCase()} yet`));
      empty.append(node('span', `Commit one to a member repository's ${noun}s folder to share it with the workspace, or add a local one on this computer.`));
      listHost.append(empty);
    } else {
      const shown = filterRows(rows, { origin, query });
      if (!shown.length) listHost.append(node('p', `No ${title.toLowerCase()} match.`, 'auto-status'));
      for (const group of groupRows(shown)) {
        const section = node('section', undefined, 'auto-group'); section.dataset.group = group.id;
        const head = node('h3', undefined, `auto-group-title${group.id === 'attention' ? ' warn' : ''}`); head.id = `auto-${kind}-${group.id}`;
        head.append(node('span', group.title), node('span', String(group.rows.length), 'auto-group-note'));
        const table = node('div', undefined, 'auto-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-labelledby', head.id);
        const hr = node('div', undefined, 'auto-row head'); hr.setAttribute('role', 'row');
        for (const label of HEADS) { const c = node('span', label); if (label) c.setAttribute('role', 'columnheader'); hr.append(c); }
        table.append(hr, ...group.rows.map(rowEl)); section.append(head, table); listHost.append(section);
      }
    }
    if (wasRow && !listHost.contains(doc.activeElement)) [...listHost.querySelectorAll('.auto-row')].find(r => r.dataset.id === wasRow)?.querySelector(part)?.focus({ preventScroll: true });
    const foot = node('p', undefined, 'auto-foot');
    const snap = data.snapshot ? relativeTime(data.snapshot.takenAt, now()) : null;
    foot.textContent = [data.snapshot ? `Workspace ${title.toLowerCase()} as of the last sync${snap ? ` (${snap.label})` : ''}` : 'Workspace items appear after the next sync',
      data.snapshot?.problems ? `${data.snapshot.problems} discovery ${data.snapshot.problems === 1 ? 'problem' : 'problems'}` : null,
      'Only members you can read in Git contribute.'].filter(Boolean).join(' · ');
    listHost.append(foot);
  }
  function banner(message, action = null) {
    const b = node('div', undefined, 'auto-banner'); b.setAttribute('role', 'note'); b.append(iconElement(doc, 'warning', { size: 15 }), node('span', message));
    if (action) { const a = node('button', action[0], 'act'); a.type = 'button'; a.disabled = busy; a.addEventListener('click', async () => { busy = true; render(); try { await action[1](); } catch (e) { failure = e?.message || String(e); } finally { busy = false; await refresh(); } }); b.append(a); }
    notices.append(b);
  }
  const schedulerOn = s => s.installed === true && s.active === true && s.registered !== false;
  function renderScheduler() {
    const s = data?.scheduler; scheduler.hidden = !s; if (!s) return;
    const checked = relativeTime(s.lastTick, now());
    scheduler.replaceChildren(node('span', '', `auto-dot ${schedulerOn(s) ? 'ok' : 'warn'}`),
      node('span', schedulerOn(s) ? ['Scheduler on', checked ? `checked ${checked.label}` : null, Number.isInteger(s.maxConcurrent) ? `up to ${s.maxConcurrent} at once` : null].filter(Boolean).join(' · ') : 'Scheduler off'));
  }

  // ── detail page ──
  function openRow(id) { if (confirming && !testing) revokeConfirm(); ranNothing = null; openId = id; render(); page.querySelector('.page-back')?.focus(); void loadStatus(id); }
  /** A trigger's fire history, read once per open; a stale answer never lands on another page, nor on a row
   * whose source changed since it was asked (the ticket, checked on the answer). */
  async function loadStatus(id) {
    const row = rowById(id);
    if (kind !== 'trigger' || !status || !row) return;
    const ticket = (statusTickets.get(id) || 0) + 1; statusTickets.set(id, ticket);
    try {
      const st = triggerStatus(await status(row), row.id, { source: row.on?.source });
      if (!alive || !st || statusTickets.get(id) !== ticket) return;
      statuses.set(row.id, st);
      if (openId === id) { const back = doc.activeElement === page.querySelector('.page-back'); render(); if (back) page.querySelector('.page-back')?.focus(); }
    } catch { /* the row's last fire still shows */ }
  }
  function closeRow() {
    const id = openId; openId = null; if (!testing) revokeConfirm(); render();
    [...body.querySelectorAll('.auto-row')].find(r => r.dataset.id === id)?.querySelector('.auto-open')?.focus();
  }
  function renderPage(row) {
    page.replaceChildren();
    const { bar, actions } = pageBar(doc, { backLabel: title, crumbs: [title], current: row.id, onBack: closeRow });
    const button = (label, verb, primary = false, enabled = true) => { const b = node('button', label, `act${primary ? ' primary' : ''}`); b.type = 'button'; b.dataset.verb = verb; b.disabled = busy || !enabled; b.addEventListener('click', () => verb === 'file' ? openFile?.(row) : perform(verb, row)); actions.append(b); return b; };
    const extras = rowActions ? rowActions(row) : [];
    const run = runState(row);
    // An unknown run state is checked from its own card; the bar keeps the other page actions.
    const inCard = extra => extra.verb === 'reconcile' && !!run?.unknown;
    const extraButton = (extra, into) => { const b = node('button', extra.label, 'act'); b.type = 'button'; b.dataset.verb = extra.verb || ''; b.disabled = busy || extra.enabled === false; b.addEventListener('click', () => extra.run()); into.append(b); return b; };
    if (canOpen(row)) button('Open file', 'file');
    if (canDescribe(row)) { const b = node('button', 'Edit summary', 'act'); b.type = 'button'; b.dataset.verb = 'describe'; b.disabled = busy; b.addEventListener('click', () => openDescribe(row)); actions.append(b); }
    for (const extra of extras) if (!inCard(extra)) extraButton(extra, actions);
    if (row.kind === 'schedule' && row.runsHere && supports('run')) button('Run now', 'run');
    if (supports('test')) button('Test', 'test', true).dataset.autoFocus = 'test';
    const source = sourceOf(row);
    const pageBody = node('div', undefined, 'page-body'), main = node('div', undefined, 'page-main'), side = node('div', undefined, 'page-side');
    // Identity: the name, with the qualified id (the address) under it; then the summary.
    const identity = node('div', undefined, 'page-identity'), glyph = node('span', undefined, 'page-glyph');
    glyph.append(iconElement(doc, kind === 'trigger' ? 'triggers' : 'schedules', { size: 22 }));
    const copy = node('div', undefined, 'page-identity-copy'), h = node('h2', undefined, 'page-title mono'); h.append(node('span', row.name));
    const tags = node('div', undefined, 'auto-tags'); tags.append(originTag(row)); stateTags(row, tags);
    copy.append(h, node('p', row.id, 'auto-qid'), tags);
    if (row.description) copy.append(node('p', row.description, 'page-lede'));
    else {
      const lede = node('p', undefined, 'page-lede'); lede.append(node('span', 'No summary'));
      if (canDescribe(row)) { const b = node('button', 'Edit summary', 'act auto-lede-edit'); b.type = 'button'; b.dataset.verb = 'describe'; b.disabled = busy; b.addEventListener('click', () => openDescribe(row)); lede.append(b); }
      copy.append(lede);
    }
    identity.append(glyph, copy);
    if (row.group !== 'elsewhere') identity.append(switchFor(row));
    if (ranNothing === row.id) { const n = node('p', NOTHING_RAN, 'auto-status auto-ran-nothing'); n.setAttribute('role', 'status'); main.append(n); }
    main.append(identity);
    // What it sends: shown whole, never summarized.
    main.append(sendsSection(row));
    // When / On, and Spawns (a spawn schedule and every trigger).
    const cards = node('div', undefined, 'auto-cards');
    const when = pageCard(doc, kind === 'trigger' ? 'On' : 'When', { icon: kind === 'trigger' ? 'triggers' : 'schedules' });
    if (kind === 'trigger' && source) when.body.append(onSource(row, source));
    else if (kind === 'trigger') { const on = onSummary(row.on); when.body.append(pageFacts(doc, [['Event', on?.title], ['Repo', on?.repo], ['Labels', on?.labels.join(', ')], ['Base', on?.base], ['Polls', on?.poll ? `every ${on.poll}` : null]])); }
    else when.body.append(pageFacts(doc, [['Runs', cronInWords(row.cron)], ['Cron', row.cron], ['Time zone', row.tz], ['Next', row.runsHere ? relativeTime(row.nextDue, now())?.label : null]]));
    cards.append(when.card);
    if (row.run === 'spawn') {
      const spawns = pageCard(doc, 'Spawns', { icon: 'soul' });
      const conc = row.concurrency ? [Number.isInteger(row.concurrency.max) ? `${row.concurrency.max} at once` : null, Number.isInteger(row.concurrency.perKey) ? `${row.concurrency.perKey} per event` : null].filter(Boolean).join(' · ') : null;
      const wake = row.wake ? [cronInWords(row.wake.cron) || row.wake.cron, row.wake.tz].filter(Boolean).join(' · ') : null;
      spawns.body.append(pageFacts(doc, [['Soul', row.soul ? `${row.soul.name}${soulSub(row) ? ` · ${soulSub(row)}` : ''}` : null], ['Purpose', row.purpose], ['Teams', row.teams.join(', ')],
        ['Harness', [row.harness ? harnessName(row.harness) : null, row.model].filter(Boolean).join(' · ')], ['Launch config', row.launchConfig],
        ['Permissions', row.yolo === true ? 'YOLO — skips permission prompts' : row.yolo === false ? 'Native permission policy' : null], ['Backend', row.backend], ['Concurrency', conc],
        ['Wakes it', wake, row.wake ? row.wake.cron : null], ['Wake message', row.wake?.message, null, 'wrap']]));
      cards.append(spawns.card);
    }
    main.append(cards);
    // Recent runs (this computer only).
    // A trigger's history comes from `trigger status` (fired, live, pending); the row alone has only its last fire.
    const st = kind === 'trigger' ? statuses.get(row.id) : null;
    const lead = st ? [st.liveCount !== null ? `${st.liveCount}${st.max !== null ? ` of ${st.max}` : ''} live now` : null, st.firedTotal ? `${st.firedTotal} fired in all` : null, st.pending.length ? `${st.pending.length} waiting` : null].filter(Boolean).join(' · ') : '';
    const runs = pageSection(doc, kind === 'trigger' ? 'Recent fires' : 'Recent runs', ['on this computer', lead].filter(Boolean).join(' · '));
    const history = node('div', undefined, 'auto-runs');
    const timeEl = iso => { const at = relativeTime(iso, now()), el = node('time', at?.label || '—'); if (at) el.title = at.title; return el; };
    // Status (0.49 fields; each absent on an older kernel): the last poll, the last error (message, then its
    // code), the events waiting (newest first, at most 10), the instances live now, then what fired.
    const poll = st?.lastPoll;
    // A capability source's failure is said once. After a failed poll the kernel's `lastError` is that same
    // failure (its time and message), and after a failed source check it repeats `invalid`: the Last error line
    // is then left out, and its code goes beside the kernel's text of the failure.
    const check = source ? (st?.invalid?.at ? st.invalid : sourceCheck(row.invalid)) : null, err = st?.lastError;
    const pollFailure = !!source && !!poll && !poll.ok && !!poll.cause;
    const samePoll = pollFailure && !!err && err.at === poll.at && err.message === poll.error;
    const sameCheck = !!check?.at && !!err && err.at === check.at && err.message === check.message;
    const says = v => v ? sourceQuote(doc, { leadIn: LEAD_INS.source(source.capability, source.name), lines: [{ text: [v.code, v.message] }] }) : null;
    if (poll && source && (pollFailure || poll.events !== undefined)) {
      const p = node('p', undefined, `auto-test-line${poll.ok ? '' : ' warn'}`);
      p.append('Last poll ', timeEl(poll.at), poll.ok ? `: ${[events(poll.events), tally(poll)].filter(Boolean).join(', ')}` : ` failed: ${causeWords(poll.cause)}`);
      history.append(p);
      if (!poll.ok) {
        if (poll.error) { const e = node('p', poll.error, 'auto-test-line warn auto-poll-error'); if (samePoll && err.code) e.append(' ', node('code', err.code, 'auto-mono')); history.append(e); }
        const quote = says(poll.says || (samePoll ? err.says : null)); if (quote) history.append(quote);
      }
    } else if (poll) {
      const p = node('p', undefined, `auto-test-line${poll.ok ? '' : ' warn'}`), n = v => `${v} ${v === 1 ? 'pull request' : 'pull requests'}`;
      p.append('Last poll ', timeEl(poll.at), poll.ok ? `: ${n(poll.prs)}, ${poll.matching} matching` : ` failed${poll.error ? `: ${poll.error}` : ''}`);
      history.append(p);
    }
    if (err && !samePoll && !sameCheck) {
      const p = node('p', `Last error: ${err.message || ''}`, 'auto-test-line warn');
      if (err.code) p.append(err.message ? ' ' : '', node('code', err.code, 'auto-mono'));
      history.append(p);
      const quote = source ? says(err.says) : null; if (quote) history.append(quote);
    }
    // One order in every list of the section: the event's label, its kind, then the instance (Waiting has none).
    const eventText = e => [e.label, e.event].filter(Boolean).join(' · ');
    if (st?.pending.length) {
      const waiting = node('ul', undefined, 'auto-list auto-runs'); waiting.setAttribute('aria-label', 'Waiting');
      for (const e of st.pending.slice(0, 10)) { const li = node('li', undefined, 'auto-run'); li.append(timeEl(e.observedAt), node('span', eventText(e))); waiting.append(li); }
      history.append(node('p', 'Waiting', 'auto-list-head'), waiting);
      if (st.pending.length > 10) history.append(node('p', `and ${st.pending.length - 10} more`, 'page-note'));
    }
    if (st?.live.length) {
      const live = node('ul', undefined, 'auto-list auto-live'); live.setAttribute('aria-label', 'Live now');
      for (const e of st.live) { const li = node('li'), what = eventText(e); if (what) li.append(what); if (e.instance) li.append(what ? ' · ' : '', node('span', e.instance, 'auto-mono')); live.append(li); }
      history.append(node('p', 'Live now', 'auto-list-head'), live);
    }
    // A trigger's fires are read through firedEntry (labels by subject); a schedule's runs as recorded.
    const runOf = r => kind === 'trigger' ? firedEntry(r, row.on?.source) : { ...r, event: r.event ? String(r.event).replace(/_/g, ' ') : null, label: r.number ? `#${r.number}` : null };
    const items = st?.fired.length ? st.fired : (row.recentRuns.length ? row.recentRuns : row.lastRun ? [row.lastRun] : []).map(runOf).filter(Boolean);
    if (items.length && (st?.pending.length || st?.live.length)) history.append(node('p', 'Fired', 'auto-list-head'));
    for (const r of items.slice(0, 10)) {
      const line = node('div', undefined, 'auto-run');
      const outcome = r.outcome ? OUTCOMES[r.outcome] || r.outcome : null;
      // A trigger's fire in the section's order (label, event, instance); a schedule's run leads with its outcome.
      const parts = kind === 'trigger' ? [r.label, r.event, r.instance, outcome] : [outcome, r.event, r.label, r.instance];
      line.append(timeEl(r.at || r.startedAt || r.scheduledFor), node('span', parts.filter(Boolean).join(' · ') || 'Recorded'));
      history.append(line);
    }
    if (!items.length) history.append(node('p', row.runsHere ? 'Not run yet on this computer.' : 'Runs are recorded on the computer that runs it.', 'page-note'));
    // What the source's last GOOD poll refused or skipped. A failed poll leaves the lists as they were, so they
    // can be older than the failure above: the line over them says which poll they are from.
    if (source && st?.source) {
      const from = node('p', undefined, 'page-note auto-lists-from');
      if (poll?.ok) from.append('At the last poll, ', timeEl(poll.at)); else from.textContent = poll ? 'From the last successful poll, before the failure above' : 'From the last successful poll';
      const lists = sourceLists(st, source, from); if (lists) history.append(lists);
    }
    runs.append(history); main.append(runs);
    // Side: what is wrong with it, its run state, where it runs, where it comes from, the test result.
    const bad = row.unreadable || row.invalid;
    if (!row.unreadable && check?.at) {
      // The last source check failed at a poll: the kernel's message, code and field, and when. (An `invalid`
      // without a time is a definition that no longer validates, below, as before.)
      const card = pageCard(doc, 'Source check failed', { icon: 'warning' }), when = relativeTime(check.at, now());
      card.body.append(pageFacts(doc, [['Message', check.message, null, 'wrap'], ['Code', check.code], ['Field', check.field], ['Checked', when?.label, when?.title]]));
      side.append(card.card);
    } else if (bad) {
      const card = pageCard(doc, row.unreadable ? 'Unreadable' : 'Invalid', { icon: 'warning' });
      const fact = v => typeof v === 'string' ? v : null;
      card.body.append(pageFacts(doc, [['Code', fact(bad.code)], ['Field', fact(bad.field)], ['Message', fact(bad.message), null, 'wrap']]));
      side.append(card.card);
    }
    if (run) side.append(runStateCard(row, run, extras.filter(inCard), extraButton));
    const where = pageCard(doc, 'Where it runs', { icon: 'computer' }), p = placementText(row, data.host);
    where.body.append(pageFacts(doc, row.origin.kind === 'local' ? [['Runs on', 'This computer']] : [['Runs on', row.runsOn], ['This computer', data.host.name || 'no host name'], ['Acts as', row.owner], ['Logged in', hostLogin(data.host, row.owner)]]));
    const verdict = node('div', undefined, `auto-verdict${p.tone === 'warn' ? ' warn' : ''}`); verdict.append(node('span', '', `auto-dot ${p.tone}`), node('span', row.runsHere ? 'Runs on this computer' : p.label));
    where.body.append(verdict); if (row.reasonDetail) where.body.append(node('p', row.reasonDetail, 'page-note'));
    const from = pageCard(doc, 'Comes from', { icon: row.origin.kind === 'local' ? 'computer' : 'repo' });
    const template = ['Template', templateProvenance(row.template), row.template ? [templateLabel(row.template) || row.template.from, row.template.version, row.template.commit].filter(v => typeof v === 'string' && v).join(' ') : null];
    const stamp = (label, iso) => { const t = relativeTime(iso, now()); return [label, t?.label, t?.title]; };
    if (row.origin.kind === 'workspace') from.body.append(pageFacts(doc, [['Member', row.origin.member], ['Repo', row.origin.repoKey], ['Path', row.origin.path], ['Commit', row.origin.commit ? row.origin.commit.slice(0, 7) : null, row.origin.commit], template]));
    else from.body.append(node('p', 'Local to this computer; not shared through Git.', 'page-note'), pageFacts(doc, [template, stamp('Created', row.createdAt), stamp('Updated', row.updatedAt)]));
    if (openFile) {
      const f = node('button', 'Open file', 'act'); f.type = 'button'; f.disabled = !canOpen(row); f.title = openTitle(row);
      f.addEventListener('click', () => { if (canOpen(row)) openFile(row); }); from.body.append(f);
    }
    side.append(where.card, from.card);
    // A capability source: the confirm, then its result, lead the side column (where the operator is looking);
    // a pull-request trigger's and a schedule's result closes it, as before.
    const tested = tests.get(row.id);
    if (source) { if (tested) side.prepend(testCard(row, tested, source)); if (confirming === row.id) side.prepend(confirmCard(row, source)); }
    else if (tested) side.append(testCard(row, tested, null));
    pageBody.append(main, side); page.append(bar, pageBody);
  }
  /** The Test result card. A capability source's (sourceTestCard) speaks of the source first. */
  function testCard(row, tested, source) {
    const card = pageCard(doc, 'Test result', { icon: 'test' });
    // An answer that carries `source` is a capability source's, whatever the row on screen says of itself.
    if (source || tested.source) return sourceTestCard(card, tested, source || {});
    card.body.append(node('p', tested.error || (tested.ok ? 'Ready: it would run here.' : 'Not ready on this computer.'), `auto-test-line${tested.ok ? '' : ' warn'}`));
    for (const problem of tested.problems || []) card.body.append(node('p', problem, 'auto-test-line warn'));
    for (const warning of tested.warnings || []) card.body.append(node('p', warning, 'auto-test-line'));
    // The soul's own error, unless a problem already says it.
    if (tested.soul && !tested.soul.resolves && !(tested.problems || []).length) card.body.append(node('p', `The soul does not resolve${tested.soul.error ? `: ${tested.soul.error}` : ''}`, 'auto-test-line warn'));
    if (tested.account) card.body.append(node('p', `gh acts as ${tested.account}`, 'auto-test-line'));
    fireList(card, tested);
    const due = relativeTime(tested.nextDue, now());
    if (due) card.body.append(node('p', `Next due ${due.label}`, 'auto-test-line'));
    return card.card;
  }
  /** Each event that would fire, with the instance name its spawn would be asked to derive (0.49). A capability
   * source's event may carry a URL: the source's, shown as text, never a link. */
  function fireList(card, tested) {
    if (tested.wouldFire?.length) {
      const fires = node('ul', undefined, 'auto-list auto-fire'); fires.setAttribute('aria-label', 'Would fire now');
      for (const f of tested.wouldFire) {
        const li = node('li', f.label);
        if (f.instance) li.append(' → ', node('span', f.instance, 'auto-mono'));
        if (f.held) li.append(' (held)');
        if (f.nameCut) { li.append(' · name shortened to fit'); li.setAttribute('aria-description', NAME_CUT); li.title = NAME_CUT; }
        if (f.url) li.append(node('span', f.url, 'auto-fire-url'));
        fires.append(li);
      }
      card.body.append(node('p', 'Would fire now:', 'auto-test-line'), fires);
    } else if (tested.wouldFire) card.body.append(node('p', 'Nothing would fire now.', 'auto-test-line'));
  }

  // ── a capability source (feature trigger-sources) ──
  const events = n => `${n} ${n === 1 ? 'event' : 'events'}`;
  /** The non-zero counts of what a poll left out: "1 filtered, 2 skipped, 3 refused". */
  const tally = ({ filtered = 0, skipped = 0, refused = 0 }) => [[filtered, 'filtered'], [skipped, 'skipped'], [refused, 'refused']].filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(', ');
  /** The trigger file's parameters, as display-only text in the quote treatment, or null when it gives none. */
  function paramsQuote(row) {
    const params = sourceParams(row.on);
    const quote = params.count ? sourceQuote(doc, { leadIn: LEAD_INS.triggerFile, lines: params.lines }) : null;
    if (!quote) return null;
    const box = node('div', undefined, 'auto-params'); box.append(quote);
    if (params.more) box.append(node('p', `and ${params.more} more`, 'page-note'));
    return box;
  }
  /** The On card of a capability-source trigger: its source (and its capability's page, when the catalog lists
   * it), the events it selects, how often it polls, and what the trigger file passes to the source. */
  function onSource(row, source) {
    const box = node('div', undefined, 'auto-on-source'), on = onSummary(row.on, { sources });
    box.append(pageFacts(doc, [['Source', sourceLabel(source) || source.id], ['Events', on?.events.join(', ')], ['Polls', on?.poll ? `every ${on.poll}` : null]]));
    if (source.lookup && typeof openCapability === 'function' && canOpenCapability(source.lookup)) {
      const actions = node('div', undefined, 'auto-card-actions'), open = node('button', 'Open capability', 'act'); open.type = 'button'; open.dataset.verb = 'capability';
      open.setAttribute('aria-label', `Open capability ${source.lookup}`); open.addEventListener('click', () => openCapability(source.lookup));
      actions.append(open); box.append(actions);
    }
    const params = paramsQuote(row);
    if (params) box.append(node('p', 'Parameters', 'auto-list-head'), params);
    return box;
  }
  /** The events OATS refused and the items the source skipped, each list only when it has entries, at most
   * EVENTS_SHOWN then "and N more". The event's text and the reason for a skip are the source's words (quoted);
   * the rule is said in the Desktop's, the subject is the kernel's identifier. `from`: which poll they are from. */
  function sourceLists({ refused, skipped }, source, from = null) {
    if (!refused.length && !skipped.length) return null;
    const box = node('div', undefined, 'auto-source-lists'), leadIn = LEAD_INS.source(source.capability, source.name);
    if (from) box.append(from);
    const part = (title, name, all, lines) => {
      if (!all.length) return;
      const group = node('div', undefined, `auto-source-list ${name}`), quote = sourceQuote(doc, { leadIn, lines });
      group.append(node('p', title, 'auto-list-head')); if (quote) group.append(quote);
      if (all.length > EVENTS_SHOWN) group.append(node('p', `and ${all.length - EVENTS_SHOWN} more`, 'page-note'));
      box.append(group);
    };
    part('Refused by OATS', 'auto-refused', refused, refused.slice(0, EVENTS_SHOWN).map(e => ({ text: e.text, note: `Refused: ${ruleWords(e.rule) || 'no rule reported'}.` })));
    part('Skipped by the source', 'auto-skipped', skipped, skipped.slice(0, EVENTS_SHOWN).map(e => ({ label: e.subject, text: e.why })));
    return box;
  }
  /** The Test confirm: what pressing Run test does, said before it does it. Built from the row on screen; it
   * offers Run test and Cancel and nothing that trusts, enables, starts or schedules the trigger. */
  function confirmCard(row, source) {
    const { card, head } = pageCard(doc, 'Test this trigger', { icon: 'test' }), running = testing === row.id;
    card.classList.add('auto-confirm'); card.setAttribute('role', 'group');
    head.id = `auto-confirm-title-${kind}`; head.tabIndex = -1; head.dataset.autoFocus = 'confirm-title'; card.setAttribute('aria-labelledby', head.id);
    const line = (...parts) => { const p = node('p', undefined, 'auto-test-line'); p.append(...parts); card.append(p); };
    const code = v => node('code', v, 'auto-mono');
    line('This runs ', source.capability ? code(source.capability) : 'the capability', "'s source command on this computer, now, once. Nothing is recorded and nothing is spawned.");
    if (row.reason === 'untrusted') line("This trigger isn't trusted on this computer. Testing doesn't trust it or start it.");
    const elsewhere = row.reason === 'assigned-elsewhere' || (!!row.runsOn && row.runsOn !== data.host.name);
    if (elsewhere) line('The test runs here, not on ', row.runsOn ? code(row.runsOn) : 'the host that runs it', '.');
    const params = paramsQuote(row);
    if (params) { line('The command receives these parameters.'); card.append(params); } else line('It receives no parameters.');
    // While the test runs, focus parks here (a disabled button cannot hold it).
    const state = node('p', running ? 'Testing…' : '', 'auto-confirm-status'); state.tabIndex = -1; state.setAttribute('role', 'status'); state.dataset.autoFocus = 'confirm-status';
    const actions = node('div', undefined, 'auto-card-actions');
    const cancel = node('button', 'Cancel', 'act'), run = node('button', 'Run test', 'act primary');
    cancel.type = run.type = 'button'; cancel.dataset.autoFocus = 'confirm-cancel'; run.dataset.autoFocus = 'confirm-run'; run.dataset.verb = 'run-test';
    cancel.disabled = run.disabled = busy || !!testing;
    // Bound to THIS confirm: a control kept from one that closed, was replaced or was disposed does nothing.
    const token = confirmToken;
    cancel.addEventListener('click', () => closeConfirm(token)); run.addEventListener('click', () => void runConfirmed(token));
    actions.append(cancel, run); card.append(state, actions);
    return card;
  }
  /** A capability source's Test result: first what the source did (not whether this computer is ready), then
   * the placement as the kernel reports it, its warnings, and what would fire when the source answered. */
  function sourceTestCard(card, tested, source) {
    // Its heading takes focus when a confirmed test answers.
    card.head.tabIndex = -1; card.head.dataset.autoFocus = 'result-title';
    const line = (value, warn = false) => { const p = node('p', value, `auto-test-line${warn ? ' warn' : ''}`); card.body.append(p); return p; };
    const ran = tested.source;
    if (tested.error || !ran) {
      // The CLI refused or never answered: the kernel's message and its code. There is no result.
      // The kernel's refusal of the test itself (a definition that no longer validates): its text can repeat a
      // trigger file's own key, so it is one display line like every other string here.
      const code = displayLine(tested.code), p = line(displayLine(tested.error) || 'This OATS did not answer about the source.', true); if (code) p.append(' ', node('code', code, 'auto-mono'));
      return card.card;
    }
    const named = { capability: ran.capability || source.capability, name: ran.name || source.name };
    if (ran.ok) {
      line(`The source answered: ${[events(ran.events), tally({ filtered: ran.filtered, skipped: ran.skipped.length, refused: ran.refused.length })].filter(Boolean).join(', ')}`);
      const lists = sourceLists(ran, named); if (lists) card.body.append(lists);
    } else if (ran.invalid) {
      line('The source check failed', true);
      card.body.append(pageFacts(doc, [['Message', ran.invalid.message, null, 'wrap'], ['Code', ran.invalid.code], ['Field', ran.invalid.field]]));
    } else {
      line(`The poll failed: ${causeWords(ran.cause) || 'no cause reported'}`, true);
      if (ran.error) { const p = line(ran.error, true); if (ran.code) p.append(' ', node('code', ran.code, 'auto-mono')); }
      const quote = ran.says ? sourceQuote(doc, { leadIn: LEAD_INS.source(named.capability, named.name), lines: [{ text: [ran.says.code, ran.says.message] }] }) : null;
      if (quote) card.body.append(quote);
    }
    // Placement, as the kernel reports it: a manual test runs the source whatever this computer's trust and the
    // trigger's host say, so "would run here" is said only when the kernel found nothing against it.
    if (tested.ok && !tested.problems.length) line('Would run here on its own');
    else if (tested.problems.length) { line('Tested by hand'); for (const problem of tested.problems) line(problem, true); }
    for (const warning of tested.warnings) line(warning);
    if (tested.soul && !tested.soul.resolves && !tested.problems.length) line(`The soul does not resolve${tested.soul.error ? `: ${tested.soul.error}` : ''}`, true);
    if (tested.account) line(`gh acts as ${tested.account}`);
    // Only a source that answered says what would fire, or that nothing would.
    if (ran.ok) fireList(card, tested);
    return card.card;
  }
  /** What a run sends, whole: a spawn's or trigger's task, a wake's message and the home it wakes,
   * a command's argv (verbatim, one chip per argument) and cwd, an operation and its home. */
  function sendsSection(row) {
    if (row.run === 'wake') {
      const section = pageSection(doc, 'Wake message');
      section.append(row.message ? node('pre', row.message, 'auto-prompt') : node('p', 'No wake message reported.', 'page-note'), pageFacts(doc, [['Wakes', row.home, null, 'wrap']]));
      return section;
    }
    if (row.run === 'command') {
      const section = pageSection(doc, 'Command', 'run as written, without a shell');
      if (row.argv?.length) { const argv = node('ol', undefined, 'auto-argv'); argv.setAttribute('aria-label', 'Command arguments'); for (const arg of row.argv) argv.append(node('li', arg)); section.append(argv); }
      else section.append(node('p', 'No command reported.', 'page-note'));
      section.append(pageFacts(doc, [['Runs in', row.cwd, null, 'wrap']]));
      return section;
    }
    if (row.run === 'operation') {
      const section = pageSection(doc, 'Operation');
      section.append(row.operation || row.home ? pageFacts(doc, [['Operation', row.operation], ['Runs in', row.home, null, 'wrap']]) : node('p', 'No operation reported.', 'page-note'));
      return section;
    }
    const section = pageSection(doc, 'Prompt', kind === 'trigger' ? 'highlighted fields are filled from the event' : '');
    if (row.task) {
      const pre = node('pre', undefined, 'auto-prompt');
      for (const part of taskParts(row.task, kind === 'trigger' ? taskFields(row.on, { sources }) : undefined)) pre.append(part.field ? node('span', `{${part.field}}`, 'auto-token') : doc.createTextNode(part.text));
      section.append(pre);
      if (kind === 'trigger') section.append(node('p', sourceOf(row) ? "The highlighted fields are filled from the source's event after OATS checks them. They are still the source's data, and the instance is told so."
        : 'Pull request titles and bodies are never inserted: the instance reads them from its event file.', 'page-note'));
    } else section.append(node('p', row.run && row.run !== 'spawn' ? `Nothing to show for a ${row.run} run.` : 'No prompt reported.', 'page-note'));
    return section;
  }
  /** Run state on this computer: running since, an unknown state (with its Check action and the
   * reconcile command to paste), a wake waiting to be delivered. */
  function runStateCard(row, run, checks, extraButton) {
    const card = pageCard(doc, 'Run state', { icon: 'schedules' });
    const line = (tone, words, iso) => {
      const t = relativeTime(iso, now()), v = node('div', undefined, `auto-verdict${tone === 'warn' ? ' warn' : ''}`);
      const label = node('span', t ? `${words} since ${clockTime(iso, now())} · ${t.label}` : words); if (t) label.title = t.title;
      v.append(node('span', '', `auto-dot ${tone}`), label); card.body.append(v);
    };
    if (run.running) line('ok', 'Running', run.running.since);
    if (run.unknown) {
      const u = run.unknown;
      line('warn', 'Run state unknown', u.since);
      card.body.append(pageFacts(doc, [['Scheduled', relativeTime(u.scheduledFor, now())?.label, relativeTime(u.scheduledFor, now())?.title], ['Host slot', u.holdsSlot ? 'held (counts against the host limit)' : null], ['Exited', u.exited ? 'yes' : null],
        ['Exit status', u.exitStatus === null ? null : String(u.exitStatus)], ['Exit signal', u.exitSignal], ['Error', u.error, null, 'wrap']]));
      if (checks.length) { const bar = node('div', undefined, 'auto-card-actions'); for (const extra of checks) extraButton(extra, bar); card.body.append(bar); }
      const note = node('p', undefined, 'page-note');
      note.append('From a terminal: ', node('code', reconcileCommand(row), 'auto-command'), '. If its effects can’t be proven, check by hand, then ',
        node('code', reconcileCommand(row, { clear: true }), 'auto-command'), ' records it as launch failed and frees its slot.');
      card.body.append(note);
    }
    if (run.pendingWake) {
      const t = relativeTime(run.pendingWake.scheduledFor, now()), p = node('p', `A wake message is waiting to be delivered${t ? ` (due ${t.label})` : ''}.`, 'auto-test-line');
      if (t) p.title = t.title; card.body.append(p);
    }
    return card.card;
  }

  // ── Edit summary: a small modal sheet (feature automation-descriptions; local rows only) ──
  // One sheet per view. A save is a latest-intent operation: closing, reopening or disposing the view
  // invalidates it, and a late answer (success or refusal) for an abandoned sheet changes nothing.
  const sheet = node('div', undefined, 'auto-sheet'); sheet.hidden = true;
  const form = node('form', undefined, 'auto-describe'); form.noValidate = true;
  const sheetTitle = node('h3'); sheetTitle.id = `auto-describe-title-${kind}`;
  const hint = node('p', `One line of up to ${DESCRIPTION_MAX} characters. Leave it empty to remove the summary.`, 'page-note'); hint.id = `auto-describe-hint-${kind}`;
  form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', sheetTitle.id); form.setAttribute('aria-describedby', hint.id);
  const fieldLabel = node('label'), summaryInput = node('input', undefined, 'field');
  // No native maxlength: it counts UTF-16 units, so it would cut a valid summary of emoji short of the
  // rule's 200 characters (code points); descriptionValid checks the length on save, with its message.
  summaryInput.type = 'text'; summaryInput.name = 'description'; summaryInput.autocomplete = 'off'; summaryInput.spellcheck = true;
  summaryInput.setAttribute('aria-describedby', hint.id);
  fieldLabel.append(node('span', 'Summary'), summaryInput);
  const sheetError = node('p', '', 'auto-describe-error'); sheetError.setAttribute('role', 'alert');
  // While a save runs, focus parks here (the inputs are disabled; a disabled control cannot hold focus).
  const sheetStatus = node('p', '', 'auto-describe-status'); sheetStatus.tabIndex = -1; sheetStatus.setAttribute('role', 'status');
  const saveButton = node('button', 'Save summary', 'act primary'), cancelButton = node('button', 'Cancel', 'act');
  saveButton.type = 'submit'; cancelButton.type = 'button';
  const sheetActions = node('div', undefined, 'auto-describe-actions'); sheetActions.append(saveButton, cancelButton);
  form.append(sheetTitle, hint, fieldLabel, sheetError, sheetStatus, sheetActions); sheet.append(form); root.append(sheet);
  let describing = null, describeOpener = null, describeSerial = 0, describeBusy = false;
  function paintSheet() {
    summaryInput.disabled = describeBusy; saveButton.disabled = describeBusy; cancelButton.disabled = describeBusy;
    sheetStatus.textContent = describeBusy ? 'Saving the summary…' : '';
  }
  function openDescribe(row) {
    if (!canDescribe(row) || busy || describeBusy) return;
    ++describeSerial; describing = row.id; describeOpener = doc.activeElement;
    sheetTitle.textContent = `Summary of ${row.name}`; summaryInput.value = row.description || ''; sheetError.textContent = '';
    sheet.hidden = false; paintSheet(); summaryInput.focus(); summaryInput.select();
  }
  /** The control to return to: the one that opened the sheet if it is still there, else the same
   * control by identity after a re-render (the page's Edit summary, or the row's menu), else Back. */
  function describeReturn(id) {
    if (describeOpener?.isConnected && !describeOpener.disabled) return describeOpener;
    if (openId) return page.querySelector('[data-verb=describe]') || page.querySelector('.page-back');
    return [...listHost.querySelectorAll('.auto-row')].find(r => r.dataset.id === id)?.querySelector('.auto-menu summary') || null;
  }
  function closeDescribe() {
    const id = describing; ++describeSerial; describing = null; describeBusy = false; sheet.hidden = true; paintSheet();
    describeReturn(id)?.focus(); describeOpener = null;
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (describeBusy || !describing || !describe) return;
    const row = rowById(describing);
    if (!row) { closeDescribe(); return; }
    // Sent as typed: only "" clears; the kernel keeps boundary spaces, and refuses what breaks its rule.
    const value = summaryInput.value;
    if (value && !descriptionValid(value)) { sheetError.textContent = `A summary is one line of up to ${DESCRIPTION_MAX} characters, without control characters.`; summaryInput.focus(); return; }
    const my = ++describeSerial; describeBusy = true; sheetError.textContent = ''; paintSheet(); sheetStatus.focus();
    try {
      await describe(row, value);
      if (!alive || my !== describeSerial) return;
      describeBusy = false; sheet.hidden = true; paintSheet(); describing = null;
      describeReturn(row.id)?.focus();
      await refresh();
      // The re-read repaints the page: put focus back on the same control by identity, unless it moved on.
      if (alive && (!doc.activeElement || doc.activeElement === doc.body)) describeReturn(row.id)?.focus();
      describeOpener = null;
    } catch (error) {
      if (!alive || my !== describeSerial) return;
      describeBusy = false; paintSheet();
      sheetError.textContent = error?.message || String(error); summaryInput.focus();
    }
  });
  cancelButton.addEventListener('click', () => { if (!describeBusy) closeDescribe(); });
  sheet.addEventListener('keydown', e => {
    // Escape closes it (never the detail page under it); a running save cannot be dismissed.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!describeBusy) closeDescribe(); return; }
    if (e.key !== 'Tab') return;
    // Modal: Tab and Shift+Tab stay inside; while saving, on the status line.
    if (describeBusy) { e.preventDefault(); sheetStatus.focus(); return; }
    const stops = [summaryInput, saveButton, cancelButton];
    if (e.shiftKey ? doc.activeElement === stops[0] : doc.activeElement === stops.at(-1)) { e.preventDefault(); (e.shiftKey ? stops.at(-1) : stops[0]).focus(); }
  });
  sheet.addEventListener('mousedown', e => { if (e.target === sheet && !describeBusy) closeDescribe(); });

  function render() {
    if (!alive) return;
    refreshButton.disabled = loading;
    const row = openId ? rowById(openId) : null;
    if (openId && !row && data) openId = null;
    // A confirm belongs to the row it was opened on, as that row was: another page, a row that changed under it
    // (a refresh) or left the list closes it. It is never applied to another row. (A running test keeps its own.)
    if (confirming && !testing) {
      const confirmed = rowById(confirming);
      if (openId !== confirming || !confirmed || rowSignature(confirmed) !== confirmSig || !sourceOf(confirmed)) revokeConfirm();
    }
    // The page is rebuilt whole: focus on one of the confirm's or the result's targets is found again by its key
    // (a confirm that closed under it hands focus to Test), never dropped to <body>.
    const held = page.contains(doc.activeElement) ? doc.activeElement.closest('[data-auto-focus]')?.dataset.autoFocus : null;
    page.hidden = !row; body.hidden = !!row; header.hidden = !!row;
    if (row) renderPage(row); else renderList();
    if (row && held && !page.contains(doc.activeElement)) (page.querySelector(`[data-auto-focus="${held}"]`) || (held.startsWith('confirm') ? page.querySelector('[data-auto-focus="test"]') : null))?.focus({ preventScroll: true });
  }
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
  refreshButton.addEventListener('click', () => void refresh());
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !openId || e.defaultPrevented) return;
    e.preventDefault();
    // Escape closes the confirm first (focus back on Test), never the page under it; a running test is not dismissed.
    if (confirming === openId) { if (!testing) closeConfirm(); return; }
    closeRow();
  });
  // One menu open at a time; a click elsewhere closes it.
  const closeMenus = e => { for (const m of root.querySelectorAll('.auto-menu[open]')) if (!m.contains(e.target)) m.open = false; };
  doc.addEventListener('click', closeMenus);
  render(); void refresh();
  return { refresh, open: openRow, describe: id => { const row = rowById(id); if (row) openDescribe(row); }, repaint() { render(); }, setNotice(text) { notice = text || ''; render(); }, setBusy(v) { busy = !!v; render(); }, dispose() { alive = false; revokeConfirm(); serial++; describeSerial++; doc.removeEventListener('click', closeMenus); root.remove(); } };
}

/** The Desktop shows these pages only for an OATS that reports them (kernel 0.29.0). */
export const automationsSupported = cli => !!cli?.ok && Array.isArray(cli.features) && cli.features.includes('automations') && cli.automationsApi === 1;
/** Summaries are written (Edit summary, the schedule form's Summary) only through an OATS that reports
 * them (feature automation-descriptions, 0.43): an older kernel refuses a trigger's and has no
 * description-only update. Reading needs no gate: an older kernel sends null. */
export const automationDescriptionsSupported = cli => automationsSupported(cli) && cli.features.includes('automation-descriptions');
/** The row verbs the Desktop server serves per kind (POST /api/automations); a trigger's
 * `status` feeds its detail page and a schedule's `reconcile` its run-state check. */
export const AUTOMATION_VERBS = Object.freeze({ trigger: ['enable', 'disable', 'test'], schedule: ['enable', 'disable', 'test', 'run'] });

/** A Schedules or Triggers stage: the gate (CLI + workspace), the /api/automations IO, and
 * a fresh view per workspace. `extend(call)` adds page-specific options (the local form).
 * `call({ kind, action, key? })`: `key` is the row's qualified id. */
/** frame: { heading(doc), onCount(kind, n) } from the Automations stage (its title + subtabs). */
export function mountAutomationsPage(el, ctx, kind, extend = () => ({}), { cli: readCli = cliStatus, subscribeCli = onCliChange, frame = null } = {}) {
  const doc = el.ownerDocument; ensureTheme(doc);
  const title = TITLES[kind];
  const root = doc.createElement('div'); root.className = 'automations-stage'; root.style.height = '100%';
  el.append(root);
  let view = null, card = null, shown = null, alive = true, builds = 0;
  async function call(body) {
    const r = await postJson(ctx, `/api/automations${wsQuery()}`, body);
    if (r?.status !== 'ok') { const e = new Error(r?.reason?.message || `${title} are unavailable.`); e.code = r?.reason?.code; throw e; }
    return r.result;
  }
  function gate(message, detail) {
    const section = doc.createElement('section'); section.className = 'oats-view automations';
    const style = doc.createElement('style'); style.textContent = automationsCSS;
    const header = doc.createElement('header'); header.className = 'auto-header';
    if (frame) { header.classList.add('auto-framed'); header.append(frame.heading(doc)); frame.onCount(kind, null); }
    else { const h = doc.createElement('h2'); h.textContent = title; header.append(h); }
    const body = doc.createElement('div'); body.className = 'auto-body';
    const empty = doc.createElement('div'); empty.className = 'auto-empty auto-gate';
    const strong = doc.createElement('strong'); strong.textContent = message; empty.append(strong);
    if (detail) { const span = doc.createElement('span'); span.textContent = detail; empty.append(span); }
    body.append(empty); section.append(style, header, body); root.replaceChildren(section);
    return body;
  }
  function build() {
    if (!alive) return;
    const cli = readCli(), ok = automationsSupported(cli), ws = currentWorkspace(), describes = automationDescriptionsSupported(cli);
    // Capability trigger sources (feature trigger-sources): a trigger page's gate, and nothing of a schedule's.
    const sources = kind === 'trigger' && ok && triggerSourcesSupported(cli);
    // Above the tested bound (#1879) every switch, run, test and description is held back
    // (packages/client/above-tested.mjs): the page lists, its notice says why, and no act is offered.
    const heldBack = verb => cliHeldBack(`POST /api/automations ${kind}:${verb}`, cli) !== null;
    const notice = !!cliAboveTested(cli);
    const key = JSON.stringify([ok, describes, sources, ws, cliKnownUnavailable(), notice]);
    if (key === shown) return; // CLI polls re-emit; rebuild only when the gate changes
    shown = key; view?.dispose(); view = null; card?.dispose?.(); card = null;
    if (cliKnownUnavailable()) { const body = gate(`${title} need the OATS CLI`); card = cliCard(doc, ctx); body.append(card.el); return; }
    if (!cli) { gate('Checking the OATS CLI…'); return; }
    // The notice says what a newer CLI holds back on every page it reaches, a gated one too: above the tested bound
    // a CLI with no automations API of a known shape is still accepted, and its gate alone would say nothing of why.
    const mountNotice = () => { if (notice) { card = aboveTestedCard(doc, ctx); root.prepend(card.el); } };
    if (!ok) { gate(`${title} need OATS 0.29 or later`, `Update OATS to see the workspace's ${title.toLowerCase()} and this computer's own, and where each one runs.`); mountNotice(); return; }
    if (!ws) { gate('Choose a workspace', `${title} are read for one local workspace.`); mountNotice(); return; }
    root.replaceChildren();
    mountNotice();
    // A source's "Open capability" resolves against this workspace's catalog (the held `oats capabilities` table,
    // read once per build): exactly one row of that name, or the source stays text.
    const catalog = new Map(), built = ++builds;
    if (sources && typeof ctx.openCapability === 'function') void postJson(ctx, `/api/workspace-sync${wsQuery()}`, { action: 'read' }).then(r => {
      if (!alive || built !== builds || ws !== currentWorkspace()) return;
      for (const row of r?.capabilities?.capabilities || r?.lastGood?.capabilities?.capabilities || []) if (typeof row?.name === 'string') catalog.set(row.name, (catalog.get(row.name) || 0) + 1);
      view?.repaint(); // the open page gains its Open capability
    }).catch(() => { /* the source stays text */ });
    view = createAutomationsView(root, {
      kind, now: () => Date.now(), verbs: AUTOMATION_VERBS[kind].filter(verb => !heldBack(verb)), sources,
      canOpenCapability: name => catalog.get(name) === 1, openCapability: sources && typeof ctx.openCapability === 'function' ? name => ctx.openCapability(name) : null,
      heading: frame ? frame.heading(doc) : null, onCount: frame ? n => frame.onCount(kind, n) : null,
      read: () => call({ kind, action: 'list' }),
      // `runSource` travels only from the confirm's Run test (createAutomationsView.runConfirmed): the one press
      // that lets the kernel run a capability source's command. The server composes the flag.
      // A view acts only in the workspace it was built for: one that outlived it (a kept control, a late callback)
      // sends nothing to the workspace shown now.
      act: (verb, row, { runSource = false } = {}) => {
        if (!alive || built !== builds || ws !== currentWorkspace()) return Promise.reject(Object.assign(new Error(`${title} changed workspace.`), { code: 'E_WORKSPACE_CHANGED' }));
        return call({ kind, action: verb, key: row.key, ...(runSource === true ? { runSource: true } : {}) });
      },
      status: kind === 'trigger' ? row => call({ kind, action: 'status', key: row.key }) : null,
      describe: describes && !heldBack('describe') ? (row, description) => call({ kind, action: 'describe', key: row.key, description }) : null,
      // Read-only through the contained /api/file; a member without a clone opens its web page.
      openFile: row => { if (row.origin.localPath) ctx.openFile?.(row.origin.localPath); else if (row.origin.url) ctx.openExternal?.(row.origin.url); },
      ...extend(call),
    });
  }
  const offCli = subscribeCli(build), offWs = onWorkspaceChange(() => { shown = null; build(); });
  build();
  return {
    refresh: () => view?.refresh(),
    get view() { return view; },
    dispose() { alive = false; offCli(); offWs(); view?.dispose(); card?.dispose?.(); root.remove(); },
  };
}

// ── The Automations stage: one nav item, Schedules | Triggers as subtabs (human, 2026-09-28); a page of its
// own again since 2026-10-26 (it was the Workspace page's Automations tab from 2026-10-23) ──
export const AUTOMATION_KINDS = Object.freeze(['schedule', 'trigger']);
let chosenKind = 'schedule', stage = null;
const liveStages = new Set(); // every stage on screen, so a preselect reaches one already open
/** Open the stage on a subtab (a soul's "Schedule…" opens Schedules); the choice persists for the session,
 * and a stage already on screen shows it at once. */
export function preselectAutomationsTab(kind) {
  if (!AUTOMATION_KINDS.includes(kind)) return;
  chosenKind = kind;
  for (const live of [...liveStages]) void live.select(kind);
}
export function mount(el, ctx) { stage = createAutomationsStage(el, ctx); }
export function unmount() { stage?.dispose(); stage = null; }

/** The stage: a bar with the subtabs (the page's own tools at its right), and
 * the chosen page below. Each tab counts its rows: the shown page reports its own, and the other
 * kind is read once for its count (a list read, never a change). `pages` injects the two pages. */
export function createAutomationsStage(el, ctx, { cli: readCli = cliStatus, subscribeCli = onCliChange, pages = null } = {}) {
  const doc = el.ownerDocument; ensureTheme(doc);
  const host = doc.createElement('div'); host.className = 'automations-host'; host.style.height = '100%'; el.append(host);
  const counts = new Map(), tabNodes = new Set();
  let kind = chosenKind, page = null, alive = true, op = 0, focusTab = false, countSerial = 0;
  const open = pages || {
    schedule: async (target, frame) => (await import('./schedules.mjs')).createSchedulesView(target, ctx, { cli: readCli, subscribeCli, frame }),
    trigger: async (target, frame) => mountAutomationsPage(target, ctx, 'trigger', undefined, { cli: readCli, subscribeCli, frame }),
  };
  function paintCounts() {
    for (const [k, span] of tabNodes) if (span.isConnected) { const n = counts.get(k); span.textContent = n === null || n === undefined ? '' : String(n); }
  }
  const frame = {
    heading(d) {
      // No title in the bar (human, 2026-09-28): the sidebar already says Automations; the subtabs lead.
      const wrap = d.createElement('div'); wrap.className = 'auto-heading';
      const tabs = d.createElement('div'); tabs.className = 'auto-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Automations');
      for (const k of AUTOMATION_KINDS) {
        const b = d.createElement('button'); b.type = 'button'; b.id = `automations-tab-${k}`; b.dataset.kind = k; b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(k === kind)); b.tabIndex = k === kind ? 0 : -1;
        const label = d.createElement('span'); label.textContent = TITLES[k];
        const count = d.createElement('span'); count.className = 'auto-tab-count'; b.append(label, count); tabNodes.add([k, count]);
        b.addEventListener('click', () => select(k));
        b.addEventListener('keydown', e => {
          const at = AUTOMATION_KINDS.indexOf(k), n = AUTOMATION_KINDS.length;
          const i = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at + n - 1) % n : -1;
          if (i < 0) return;
          e.preventDefault(); focusTab = true; select(AUTOMATION_KINDS[i]);
        });
        tabs.append(b);
      }
      wrap.append(tabs);
      queueMicrotask(() => {
        paintCounts();
        if (focusTab && wrap.isConnected) { focusTab = false; wrap.querySelector('[aria-selected=true]')?.focus({ preventScroll: true }); }
      });
      return wrap;
    },
    onCount(k, n) { if (n !== null || !counts.has(k)) counts.set(k, n); paintCounts(); },
  };
  // The tab's panel: the page below the bar, labelled by the chosen tab.
  async function select(next, { force = false } = {}) {
    if (!alive || !AUTOMATION_KINDS.includes(next) || (next === kind && page && !force)) {
      if (focusTab) { focusTab = false; host.querySelector(`#automations-tab-${next}`)?.focus({ preventScroll: true }); }
      return;
    }
    kind = next; chosenKind = next; const my = ++op;
    page?.dispose(); page = null; tabNodes.clear();
    const target = doc.createElement('div'); target.style.height = '100%'; target.setAttribute('role', 'tabpanel');
    target.setAttribute('aria-labelledby', `automations-tab-${next}`); host.replaceChildren(target);
    const made = await open[next](target, frame);
    if (!alive || my !== op) { made?.dispose(); return; }
    page = made;
    void countOther();
  }
  // The other tab's count: one quiet list read for its kind (only for an OATS that serves automations).
  async function countOther() {
    const other = AUTOMATION_KINDS.find(k => k !== kind), my = ++countSerial, ws = currentWorkspace();
    if (pages || counts.get(other) !== undefined || !ws || !automationsSupported(readCli())) return;
    try {
      const r = await postJson(ctx, `/api/automations${wsQuery()}`, { kind: other, action: 'list' });
      if (!alive || my !== countSerial || ws !== currentWorkspace() || r?.status !== 'ok') return;
      const read = automationRows(r.result, other); if (!read) return;
      counts.set(other, read.rows.length); paintCounts();
    } catch { /* the count stays empty; the tab still opens its page */ }
  }
  const offWs = onWorkspaceChange(() => { counts.clear(); paintCounts(); void countOther(); });
  void select(kind, { force: true });
  const handle = {
    get kind() { return kind; }, select,
    dispose() { alive = false; op++; countSerial++; liveStages.delete(handle); offWs(); page?.dispose(); page = null; host.remove(); },
  };
  liveStages.add(handle);
  return handle;
}
