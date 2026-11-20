/** On-demand kernel inspection, read-only: a v2 soul is edited in its
 * repository (soul-repository.mjs), never in place. Roster polling never
 * rebuilds the selected inspector.
 *
 * Loading (desktop/loading-states): the header and actions paint at once for a
 * new subject; the body is owned by the shared data-state controller
 * (loading.mjs): detail-section skeletons after 150ms, "Loading soul…" /
 * "Loading instance…" on the status line, then the content. A Refresh of the
 * SAME subject never runs frame(): head, actions, readiness and content stay
 * (and stay interactive), "Refreshing…" joins the head after 400ms, and the
 * content is repainted in place with focus and scroll restored — or not at all
 * when the inspection is unchanged. A failed refresh with content goes stale
 * ("Couldn't refresh soul · observed <age>" + Retry under the head); a failure
 * with no content shows the failed block where the skeleton stood. On the soul
 * page "Teams here" is created in frame(), so its read runs in parallel with
 * `inspect` instead of after it. Focus across a repaint: actionable controls carry
 * `data-focus-key` and are re-found by key only (loading.mjs captureFocusState);
 * a control that vanished hands focus to Refresh. */
import { teamModelOf } from '../../client/team-rows.mjs';
import { harnessOf } from '../../client/harness-names.mjs';
import { postJson, wsQuery, workspaceGeneration, rowDeployment } from './views/common.mjs';
import { runtimeState } from '../../client/instance-presentation.mjs';
import { createSoulMark, createRuntimeBadge } from './identity-marks.mjs';
import { createReadinessView, readinessCSS } from './readiness-view.mjs';
import { cliStatus, cliHeldBack } from './views/cli-status.mjs';
import { iconElement } from './shell-icons.mjs';
import { inspectData, inspectFacts, originText } from '../../client/inspect-contract.mjs';
import { createTeamsPanel, teamsOperations, teamsCSS, soulTeams, teamLabels } from './teams-panel.mjs';
import { createSoulTeamsHere, soulTeamsHereCSS } from './soul-teams-here.mjs';
import { teamsAnswer } from './computer-teams.mjs';
import { relayedFailure, serverLabel } from '../../client/remote-address.mjs';
import { ageText } from './age-text.mjs';
import { pageBar, pageSection, isCoreCapability, compositionEntries, coreEntries, coreNote, whyElement, whyTag } from './capability-page.mjs';
import { layerLabel } from '../../client/capability-rows.mjs';
import { launchHarnessName, launchModelText, launchFromText, declaredText } from '../../client/launch-view.mjs';
import { soulFacts, desktopFacts, workText, cantSpawnLine } from '../../client/soul-facts.mjs';
import { createDataState, skeletonBlock, skeleton, captureFocusState } from './loading.mjs';
import { createDeploymentScopeLine } from './deployment-scope-line.mjs';
import { createSoulInstructions } from './soul-instructions.mjs';
import { composedSupported, routedComposedSupported, skillsSupported, routedSkillsSupported, composedSkillsSupported, routedComposedSkillsSupported } from '../../client/composed-gate.mjs';
import { warningsOf } from '../../client/capability-warnings-contract.mjs';
import { createWarningsList, WARNINGS_COPY } from './capability-warnings.mjs';
import { DESKTOP_TERMS, DESKTOP_NOUNS } from './desktop-terms.mjs';
import { capabilityLine, capabilityLines, capabilityLineCSS } from './capability-row.mjs';

const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** Why a stale inspector's mutations wait (the sidebar roster's rule, instance-tree-view.mjs ROSTER_STALE_TITLE). */
export const INSPECTION_STALE_TITLE = 'Unavailable: inspection is not current';
/** An instance's build against its soul, from the roster's drift rows: older
 * when the soul or a module moved since; current only when every row says so. */
export function buildState(instance) {
  const modules = Array.isArray(instance?.modules) ? instance.modules : null;
  if (instance?.soul?.status === 'moved' || modules?.some(m => m?.status === 'moved')) return 'older build';
  return instance?.soul?.status === 'current' && modules?.every(m => m?.status === 'current') ? 'current' : null;
}
export const inspectorCSS = `
${readinessCSS}
${teamsCSS}
${soulTeamsHereCSS}
.souls { container-type:inline-size; }
.souls-body { display:grid; grid-template-columns:minmax(0,1fr); flex:1; min-height:0; min-width:0; }
.souls-body.inspecting { grid-template-columns:minmax(0,1fr) 340px; }
.workspace-main { display:flex; flex-direction:column; min-height:0; min-width:0; }
.soul-inspector { width:340px; max-width:100%; min-width:0; min-height:0; box-sizing:border-box; overflow:auto; background:var(--surface); border-left:1px solid var(--border); }
.soul-inspector[hidden] { display:none; }
.soul-inspector .inspector-head { min-height:48px; box-sizing:border-box; padding:0 14px; margin:0; flex-wrap:nowrap; border-bottom:1px solid var(--border); }
.soul-inspector .inspector-head h2 { min-width:0; font-size:14px; line-height:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.soul-inspector .inspector-head button { flex:none; }
.soul-inspector .inspector-head .identity-mark { width:28px; height:28px; border-radius:7px; font-size:13px; }
.soul-inspector .inspector-content { padding:0 14px 16px; }
.soul-inspector .inspector-summary { padding:0 14px; }
.soul-inspector .inspector-summary .inspector-content { padding:0; }
.soul-inspector > .inspector-status { padding:0 14px; }
/* Loading placement (desktop/loading-states): "Refreshing…" sits before the Refresh control
   in the head; the stale line has its own host right under the head (page: above the content).
   The primitive's own classes are styled by loading.css. */
.inspector-refreshing { display:inline-flex; align-items:center; min-width:0; }
.inspector-refreshing:empty { display:none; }
.inspector-notice:empty { display:none; }
.soul-inspector > .inspector-notice { padding:10px 14px 0; }
.soul-page .inspector-notice { margin:0; }
.soul-inspector .inspector-content .skeleton-detail-sections { padding-top:4px; }
.soul-page .inspector-main .skeleton-detail-sections { gap:22px; }
.soul-page .inspector-main .skeleton-detail-section { margin:0; }
.soul-page .inspector-main .skeleton-detail-section .skeleton-block { --skeleton-block-h:150px; }
.oats-view .soul-inspector button.primary:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); }
/* The soul page: the page bar in place of the Workspace tabs, then one column (slice 3a): identity, the top block, the
   capabilities and the instruction tabs. */
.workspace-page { flex:1; min-height:0; min-width:0; overflow-y:auto; padding:0; box-sizing:border-box; container-type:inline-size; background:var(--bg); }
.workspace-page[hidden] { display:none; }
.oats-view .workspace-page button.primary:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); }
.oats-view .soul-page .page-bar-actions .inspector-actions { display:flex; gap:8px; margin:0; }
.oats-view .soul-page .page-bar-actions button.icon-act { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; min-height:30px; padding:0; }
.soul-page .inspector-content h3.page-section-title { margin:0; color:var(--fg); font-size:13.5px; font-weight:650; letter-spacing:0; text-transform:none; }
.soul-page .inspector-content h3.page-section-title .page-section-lead { color:var(--muted); font-size:12px; font-weight:400; }
.soul-page .inspector-summary { min-width:0; padding:0; }
.soul-page .inspector-head { display:flex; align-items:center; gap:14px; min-width:0; margin:0; flex-wrap:nowrap; }
.soul-page .inspector-head .identity-mark { width:48px; height:48px; border-radius:11px; font-size:20px; font-weight:700; flex:none; }
.soul-page .page-identity-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
.soul-page .inspector-head h2 { flex:none; margin:0; font-size:20px; font-weight:700; letter-spacing:-.01em; line-height:1.3; }
.soul-page .inspector-head .inspector-lede { margin:0; color:var(--muted); font-size:13px; line-height:1.45; }
.soul-page .page-facts-row:empty { display:none; }
.soul-page .inspector-main { display:flex; flex-direction:column; gap:22px; padding:0; }
.soul-page .inspector-main:empty { display:none; }
.soul-page .page-sr { display:inline-block; width:1px; height:1px; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
/* The soul page (the Desktop UI rework, slice 3a): one column at a readable width; the top block is a two-column
   list of facts; its Ready row is a word, or the problem's sentence, then its Details disclosure. */
.soul-page .soul-page-body { display:block; }
.soul-page .soul-page-body > .page-main { max-width:960px; }
.soul-top { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:8px 20px; margin:0; font-size:13px; line-height:1.45; }
.soul-top dt { color:var(--muted); }
.soul-top dd { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 6px; min-width:0; margin:0; color:var(--fg); overflow-wrap:anywhere; }
.soul-top dd .strong { font-weight:600; }
.soul-top dd .muted, .soul-top .soul-top-note { color:var(--muted); }
.soul-top .soul-top-note { flex-basis:100%; font-size:12px; }
.soul-top .runtime-badge { align-self:center; width:18px; height:18px; font-size:10px; }
.soul-ready { display:flex; flex-direction:column; gap:4px; min-width:0; }
.soul-ready-line.problem { color:var(--warn); font-weight:600; }
.soul-ready-details > summary, .soul-teams-details > summary { cursor:pointer; color:var(--muted); font-size:12px; }
.soul-ready-details[open] > summary, .soul-teams-details[open] > summary { margin-bottom:8px; }
.soul-ready-problems { display:flex; flex-direction:column; gap:8px; font-size:12px; }
.soul-ready-problems p { margin:0; }
.soul-ready-checks .readiness-view { margin:8px 0 0; }
.soul-teams-details { flex-basis:100%; }
.soul-capabilities .cap-lines { margin-top:4px; }
.soul-capabilities-note { margin:8px 0 0; color:var(--muted); font-size:12px; }
${capabilityLineCSS}
/* The readiness title reads as a section title, like every other card's. */
.soul-inspector .readiness-view h2 { font-size:10.5px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 var(--title-gap); }
.inspector-head { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
.inspector-head h2 { flex:1; margin:0; font-size:19px; overflow-wrap:anywhere; }
.inspector-content { min-width:0; overflow-wrap:anywhere; }
.inspector-content .field { min-width:0; max-width:100%; box-sizing:border-box; }
.inspector-content h3 { margin:var(--section-gap) 0 var(--title-gap); font-size:10.5px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; }
.inspector-content p { line-height:1.5; }
.inspector-content .muted { color:var(--muted); }
.inspector-content pre { white-space:pre-wrap; overflow-wrap:anywhere; font-weight:normal; font-size:12px; line-height:1.6; font-family:var(--mono,monospace); }
.inspector-facts { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.6fr); gap:8px 12px; font-size:12px; }
.inspector-facts dt { color:var(--muted); overflow-wrap:anywhere; }
.inspector-facts dd { margin:0; overflow-wrap:anywhere; }
.inspector-cap { padding:14px 0; border-top:1px solid var(--border); }
.inspector-instance { display:block; width:100%; min-height:56px; height:auto; margin:6px 0; text-align:left; overflow-wrap:anywhere; white-space:normal; }
.inspector-cap h4 { margin:0 0 7px; font-size:14px; }
.inspector-actions { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
/* The status line reserves its one line while the inspector shows a subject (no :empty
   collapse, on the page too): it reads "Loading soul…" while pending, empties when the data
   lands, and speaks again on a failure — collapsing on empty would move the content up by a
   line exactly when the data arrives, the shift desktop/loading-states forbids. The line is
   gone with the whole frame when nothing is selected, so an empty inspector reserves nothing. */
.inspector-status { min-height:1.5em; margin:0; font-size:13px; color:var(--muted); white-space:pre-wrap; }
.inspector-status.error { color:var(--danger); }
/* F7: cards and compact lists (the spawn modal / context panel language); tokens only. */
.inspector-content h3.inspector-section { color:var(--muted); }
.inspector-content > h3.inspector-section:first-child { margin-top:4px; }
.inspector-readiness { padding-bottom:0; }
.inspector-readiness .readiness-view { margin-bottom:0; }
.inspector-lede { margin:6px 0 0; font-size:12.5px; line-height:1.5; color:var(--fg); }
/* 0.30 launch preferences: where the choice is set, the soul's own preference, a problem (tokens only). */
.launch-notes { display:flex; flex-direction:column; gap:4px; margin-top:8px; min-width:0; }
.launch-notes > p, .inspector-launch > p { margin:0; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
.launch-declared { color:var(--fg); }
.launch-at { color:var(--muted); }
.inspector-launch > .launch-at, .inspector-launch > .launch-problem { margin-top:8px; }
.launch-problem { border-left:2px solid var(--warn); padding-left:8px; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
.launch-problem > p { margin:0; }
.launch-problem-own { color:var(--warn); font-weight:600; }
.launch-problem-said { color:var(--fg); }
.launch-problem details { color:var(--muted); font-size:11.5px; }
.inspector-refusal { margin:6px 0 0; color:var(--warn); font-size:12.5px; font-weight:600; line-height:1.45; overflow-wrap:anywhere; }
.inspector-card { border:1px solid var(--border); border-radius:8px; background:var(--surface); padding:10px 12px; }
.inspector-card .inspector-facts { font-size:12px; margin:0; }
.inspector-core dd { display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; min-width:0; }
.inspector-core-id { font-family:var(--mono,monospace); overflow-wrap:anywhere; min-width:0; }
.inspector-core-id.none { color:var(--muted); font-family:var(--ui-font,system-ui); }
.inspector-core-note { flex-basis:100%; color:var(--muted); font-size:11px; line-height:1.4; }
.inspector-list { border:1px solid var(--border); border-radius:8px; background:var(--surface); overflow:hidden; }
.inspector-item { display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:12px; row-gap:4px; align-items:center; padding:9px 12px; }
.inspector-item + .inspector-item { border-top:1px solid var(--border); }
.inspector-item-name { font-size:12.5px; font-weight:650; color:var(--fg); overflow-wrap:anywhere; }
.inspector-item-meta { font-size:11.5px; color:var(--muted); overflow-wrap:anywhere; }
.inspector-item > details { grid-column:1 / -1; font-size:12px; }
.inspector-item > details > summary, .inspector-disclosure > summary { cursor:pointer; color:var(--muted); font-size:12px; }
.inspector-chips { display:flex; flex-wrap:wrap; gap:6px; margin:var(--title-gap) 0; }
.inspector-chip { font-size:12px; font-weight:600; line-height:1; color:var(--fg); background:var(--surface); border:1px solid var(--border); border-radius:999px; padding:6px 10px; white-space:nowrap; }
.inspector-teams-lede { margin:0; }
.inspector-disclosure { margin-top:14px; }
.inspector-spawned { display:flex; align-items:center; gap:12px; justify-content:space-between; }
/* Narrow: only while the side inspector column is shown does it stack under the list, the two scrolling
   together. Otherwise the Workspace keeps its one fixed column (spec G): the tab row and top controls stay
   outside the one content scroller at every width. */
@container(max-width:700px) {
 .souls-body.inspecting { display:block; overflow:auto; }
 .souls-body.inspecting .workspace-main { height:auto; }
 .souls-body.inspecting .workspace-main > .souls-grid, .souls-body.inspecting .workspace-main > .workspace-discovery { flex:none; overflow:visible; }
 .soul-inspector { width:100%; max-width:none; overflow:visible; border-left:0; border-top:1px solid var(--border); }
}
`;

/** presentation is an optional host lease. Presence belongs to this controller;
 * effective visibility/collapse belongs to the host, not request completions. */
export function createSoulInspector(container, { ctx, presentation, openSoul = null, layout = 'sidebar', backLabel = 'Souls', openInstance = null, currentRow = null, capabilityFacts = null, openCapability = null, launch, schedule, files, canFiles = () => false, canLaunch = () => true, spawnRefusal = () => null, launchReason = () => 'Requires a compatible installed OATS CLI.', available = () => true, instances = () => [], instancesState = () => 'ready', workspace = () => null, closed, clock = {} }) {
  const doc = container.ownerDocument;
  // `serial` is the latest read (a Refresh bumps it: a superseded inspection paints nothing); `subject` is
  // the shown subject (bumped by a new selection or reset only): the frame's and the content's controls
  // stay valid across a refresh of the same subject, which no longer rebuilds them.
  let alive = true, serial = 0, subject = 0, operationSerial = 0, selectionGen = null, selection, data, teamsPanel = null, teamsHere = null;
  // The loading controller of the shown subject (loading.mjs), and the signature of what the content paints.
  // scopeLine: "On <primary deployment>" (#482), the side panel's only: the soul page names no deployment (2026-10-23).
  let loading = null, painted = null, scopeLine = null;
  // The soul page's Instructions section (soul-instructions.mjs): one controller per subject, re-appended by every repaint.
  // `instructionCapabilities`: the shown inspection's capabilities by id, each with its core or composition entry, so a
  // composed part's "Open capability" takes the tables' own path.
  let instructionsSection = null, instructionCapabilities = new Map();
  // The soul page's top block parts that outlive a repaint (one per subject): its Ready row's details disclosure (the
  // problem's detail and the soul's readiness checks, read when first opened) and its Teams row's disclosure ("Teams here").
  let readyBlock = null, teamsBlock = null, shownInspection = null, shownFor = null, capabilityWords = null;
  // `warningTargets`: the same lookup for a capability warning's Open capability (the soul's own list, an instance's
  // readiness), from the shown inspection; empty where the host opens no capability.
  let warningTargets = new Map();
  // The controller's clock (tests inject one); createDataState's defaults apply on undefined.
  const timers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const pendingOperations = new WeakMap();
  const node = (tag, text, cls) => {
    const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el;
  };
  const button = (text, run) => {
    const b = node('button', text, 'act'); b.type = 'button';
    // aria-disabled (the stale mark) blocks the activation without dropping focus.
    if (typeof run === 'function') b.addEventListener('click', event => { if (b.getAttribute('aria-disabled') !== 'true') run(event); });
    return b;
  };
  // A provider operation's Run (or View) is a capability run: held back above the tested bound (#1879), with the
  // notice as its title (packages/client/above-tested.mjs). The backend refuses it too.
  const runHeld = () => cliHeldBack('POST /api/capabilities run');
  const holdRun = control => { const held = runHeld(); if (held) { control.disabled = true; control.title = held; } return control; };
  const mutationButton = (text, run) => { const control = button(text, run); control.dataset.mutate = '1'; control.disabled = !available(); return holdRun(control); };
  // Stale (the last inspection failed, the content kept): mutations that act on the subject wait for a good read —
  // the roster's rule (ROSTER_STALE_TITLE), with an accessible reason; Launch, Schedule and Files come from the roster and stay.
  // `settled`, not `state`: a Retry or Refresh in flight is `refreshing` while the content is still the stale observation.
  const stale = () => loading?.settled === 'stale';
  const markStale = control => {
    if (stale()) { control.setAttribute('aria-disabled', 'true'); control.title = INSPECTION_STALE_TITLE; control.setAttribute('aria-description', INSPECTION_STALE_TITLE); }
    else if (control.getAttribute('aria-description') === INSPECTION_STALE_TITLE) { control.removeAttribute('aria-disabled'); control.removeAttribute('title'); control.removeAttribute('aria-description'); }
  };
  // An instance subject is inspected (and its operations run) in its own deployment (#482); a soul in the view's
  // primary deployment, which the server resolves from the view id.
  const scopeQuery = () => selection?.instance ? `?ws=${encodeURIComponent(rowDeployment(selection.instance))}` : wsQuery();
  const request = (body, query = scopeQuery()) => postJson(ctx, `/api/capabilities${query}`, body);
  const valid = (id, gen) => alive && id === serial && gen === workspaceGeneration();
  const ownsSubject = (id, gen) => id === subject && valid(serial, gen);
  let status, content, summary, readiness, headActions = null, facts$ = null, notice = null;
  // The Refresh control (focus fallback when a repaint drops the focused control) and the
  // roster-derived block's host and signature (repainted on every show(), kept when unchanged).
  let refreshControl = null, rosterColumn = null, rosterSignature = null;
  /** The subject's identity: a soul by name, agents root and server; an instance by its home. */
  const subjectKey = sel => sel?.instance || sel?.selector?.home ? `home:${sel.instance?.home ?? sel.selector?.home ?? ''}|${sel.instance?.server ?? ''}`
    : sel?.agent ? `soul:${sel.agent.name}|${sel.agent.agentsRoot ?? ''}|${sel.agent.server ?? ''}` : JSON.stringify(sel?.selector ?? null);
  const noun = () => selection?.agent ? 'soul' : 'instance';
  /** One skeleton of the final content's shape: the sidebar's three sections; the page's two. */
  const contentSkeleton = () => skeletonBlock(doc, 'detail-section', { count: layout === 'page' ? 2 : 3 });
  /** The subject's loading controller: the content's (status, indicator, notice, Retry). */
  function createLoading(indicatorHost) {
    return createDataState({ doc, noun: noun(), region: content, skeleton: contentSkeleton, status, indicatorHost, noticeHost: notice,
      onRetry: () => { void show(selection, { user: true }); }, ...timers });
  }
  function syncReadiness() {
    const w = workspace();
    const ref = selection?.instance;
    const selector = ref ? { kind: 'instance', instance: ref.instance, agent: ref.agent, agentsRoot: ref.agentsRoot, server: ref.server ?? null }
      : selection?.agent ? { kind: 'soul', soul: selection.agent.name, agentsRoot: selection.agent.agentsRoot } : null;
    // Readiness echoes the deployment it read (#482): an instance's own deployment, a soul's the view's primary one.
    const scoped = w && { ...w, id: ref ? rowDeployment(ref) : w.primary || w.id, ...(ref?.server ? { name: ref.repoName || ref.server } : {}) };
    readiness?.update({ active: !!selection && selectionGen === workspaceGeneration(), workspace: scoped, selector, cli: cliStatus(), identity: ref?.createdAt });
  }
  function message(text, error = false) {
    if (!status) return;
    // Through the controller when it exists, so its own announcements stay in sync (loading.mjs say()).
    if (loading) loading.say(text); else status.textContent = text;
    status.classList.toggle('error', error);
  }
  function frame(title) {
    container.hidden = false;
    if (presentation) presentation.setPresent(true);
    else if (layout !== 'page') container.parentElement?.classList.add('inspecting'); // the page replaces the list; no side column
    subject++; warningTargets = new Map(); readyBlock?.dispose(); readyBlock = null; teamsBlock = null; shownInspection = null; shownFor = null; capabilityWords = null; scopeLine?.dispose(); scopeLine = layout === 'page' ? null : createDeploymentScopeLine(doc); readiness?.dispose(); readiness = null; loading?.dispose(); loading = null; painted = null; teamsHere?.dispose(); teamsHere = null; instructionsSection?.dispose(); instructionsSection = null;
    container.replaceChildren();
    const head = node('div', undefined, 'inspector-head');
    container.classList.toggle('soul-page', layout === 'page');
    const heading = node('h2', title); heading.title = title;
    status = node('p', '', 'inspector-status'); status.setAttribute('role', 'status');
    content = node('div', undefined, 'inspector-content inspector-main');
    notice = node('div', undefined, 'inspector-notice');
    // "Refreshing…" lands here, beside the Refresh control (loading.mjs owns its 400ms).
    const refreshing = node('span', undefined, 'inspector-refreshing');
    const refresh = button(layout === 'page' ? '' : 'Refresh'); // bound below: aria-disabled while a read is in flight, never disabled
    refreshControl = refresh; rosterSignature = null;
    if (layout === 'page') {
      // Workspace v4 (W4): the page bar replaces the Workspace tabs; back returns to the list it came from.
      const bar = pageBar(doc, { backLabel, crumbs: ['Workspace', backLabel], current: title, onBack: () => { if (alive) close({ restoreFocus: true }); } });
      bar.back.classList.add('inspector-back');
      headActions = bar.actions;
      refresh.classList.add('icon-act');
      refresh.append(iconElement(doc, 'refresh', { size: 14 }), node('span', 'Refresh', 'page-sr')); refresh.title = 'Inspect again';
      headActions.append(refreshing, refresh);
      summary = node('div', undefined, 'inspector-summary');
      const copy = node('div', undefined, 'page-identity-copy');
      facts$ = node('div', undefined, 'page-facts-row');
      if (selection.agent) head.append(createSoulMark(doc, selection.agent));
      copy.append(heading, facts$); head.append(copy); summary.append(head);
      // One column (the Desktop UI rework, slice 3a): the identity, then the top block, the capabilities and the two
      // instruction tabs, all from the inspection (content); nothing beside it.
      const body = node('div', undefined, 'page-body soul-page-body'), main = node('div', undefined, 'page-main');
      main.append(summary, status, notice, content); body.append(main);
      container.append(bar.bar, body);
      loading = createLoading(refreshing); loading.bindRefresh(refresh, () => { void show(selection, { user: true }); });
      rosterColumn = main;
      if (selection.agent) { readyBlock = createReadyBlock(); teamsBlock = createTeamsBlock(); }
      if (selection.agent) { renderSoulActions(main); renderSoulRoster(); }
      // "Teams here" reads `oats soul teams` in parallel with `inspect`, not after it.
      if (selection.agent) ensureTeamsHere();
      if (selection.agent) {
        const id = subject, gen = selectionGen;
        instructionsSection = createSoulInstructions(doc, { openExternal: typeof ctx?.openExternal === 'function' ? url => { if (alive) ctx.openExternal(url); } : null,
          canOpenCapability: capability => typeof openCapability === 'function' && instructionCapabilities.has(capability),
          openCapability: capability => {
            const found = instructionCapabilities.get(capability);
            if (found && ownsSubject(id, gen)) openCapability(found.cap, selection.agent, found.entry);
          } });
      }
      return;
    }
    headActions = null; facts$ = null;
    // Hosted X hides the slot without deselecting or rebuilding an editor.
    const closeControl = button('', () => {
      if (!alive) return;
      if (presentation) presentation.collapse();
      else close({ restoreFocus: true });
    });
    closeControl.classList.add('icon-act'); closeControl.append(iconElement(doc, 'close', { size: 14 }));
    closeControl.setAttribute('aria-label', 'Close inspector');
    if (selection.agent) head.append(createSoulMark(doc, selection.agent));
    head.append(heading, refreshing, refresh, closeControl);
    summary = node('div', undefined, 'inspector-summary');
    // Readiness is a first question ("can it run?"): one line under the summary, its checks behind a disclosure.
    const readinessHost = node('div', undefined, 'inspector-content inspector-readiness');
    // Readiness belongs to an instance; a soul's page shows what a person needs (human, F7).
    const withReadiness = !selection.agent;
    container.append(head, notice, ...(selection.agent ? [scopeLine.element] : []), summary, status, ...(withReadiness ? [readinessHost] : []), content);
    loading = createLoading(refreshing); loading.bindRefresh(refresh, () => { void show(selection, { user: true }); });
    // A capability warning's Open capability resolves against this subject's inspection (warningTargets), checked at click time.
    const id = subject, gen = selectionGen;
    readiness = withReadiness ? createReadinessView(readinessHost, { ctx, compact: true,
      canOpenCapability: name => typeof openCapability === 'function' && warningTargets.has(name),
      openCapability: typeof openCapability === 'function' ? name => { const found = warningTargets.get(name); if (found && ownsSubject(id, gen)) openCapability(found.cap, selection.agent ?? null, found.entry); } : null }) : null;
    syncReadiness();
    rosterColumn = null;
    if (selection.agent) { renderSoulActions(null); renderSoulRoster(); }
  }
  // Resets are silent by default: workspace/subtab/disposal must not focus an
  // obsolete or hidden card. Only an explicit standalone X restores focus.
  function close({ restoreFocus = false } = {}) {
    if (alive) reset(restoreFocus);
  }
  function reset(restoreFocus = false) {
    serial++; subject++; warningTargets = new Map(); readyBlock?.dispose(); readyBlock = null; teamsBlock = null; shownInspection = null; shownFor = null; capabilityWords = null; scopeLine?.dispose(); scopeLine = null; selection = null; selectionGen = null; data = null; teamsPanel = null; teamsHere?.dispose(); teamsHere = null; instructionsSection?.dispose(); instructionsSection = null; container.hidden = true;
    readiness?.dispose(); readiness = null; loading?.dispose(); loading = null; painted = null;
    container.replaceChildren();
    if (presentation) presentation.setPresent(false);
    else if (layout !== 'page') container.parentElement?.classList.remove('inspecting');
    closed?.({ restoreFocus: !presentation && restoreFocus });
  }
  /** Show `next`. The same subject again (Refresh, Retry, a reselection) keeps the frame and refreshes
   * in place; `user` marks a read the person asked for (announced on completion, `refresh: true` sent). */
  async function show(next, { user = false } = {}) {
    if (!next || !alive) return;
    const gen = workspaceGeneration();
    const same = !!loading && !!selection && !container.hidden && selectionGen === gen && subjectKey(next) === subjectKey(selection);
    selection = next; const id = ++serial; selectionGen = gen;
    if (!same) { data = null; frame(next.agent?.name || next.instance?.instance || ''); }
    if (!available()) { message('Inspection needs an installed OATS CLI with operations API 2. Update OATS and refresh.', true); return; }
    status.classList.remove('error');
    loading.begin({ user });
    // The roster-derived header (lede, refusal, facts, Instances) follows the host's current roster row.
    if (same && selection.agent) renderSoulRoster();
    if (same && teamsHere) void teamsHere.refresh({ user });
    try {
      const result = await request({ action: 'inspect', selector: next.selector, ...(user ? { refresh: true } : {}), ...(composedWanted(next) ? { instructions: true } : {}),
        ...(skillsWanted(next) ? { skills: true } : {}), ...(composedSkillsWanted(next) ? { composedSkills: true } : {}) });
      if (!valid(id, gen)) return;
      data = result;
      const inspected = inspectData(data, selection);
      if (!inspected) {
        // Dispatch on the payload's own integer: a classic scope still answers operationsApi 1.
        loading.fail(new Error(data?.operationsApi === 1 ? 'This workspace still uses the classic layout, which answers an older inspection. The inspector shows it once it is on the workspace model.'
          : 'The installed OATS CLI returned an inspection this Desktop cannot read. Update OATS and refresh.'));
        return;
      }
      loading.succeed({ observedAt: typeof result?.observedAt === 'string' ? result.observedAt : null });
      // An unchanged inspection is not repainted: the DOM (and whatever holds focus in it) stays.
      // The read's own metadata (observedAt, refreshing) is not what the content paints.
      const signature = JSON.stringify({ ...result, observedAt: undefined, refreshing: undefined });
      if (signature !== painted) {
        // Focus and scroll are captured right before the repaint (the person may have moved into the
        // content while the read ran); a control that vanished hands focus to Refresh, never to a neighbour.
        const restore = same ? captureFocusState(content, { scroller: container, fallback: refreshControl }) : null;
        render(inspected); painted = signature; restore?.();
      }
      syncAvailability();
    } catch (error) {
      if (!valid(id, gen)) return;
      // With content: stale (the line under the head, Retry). Without: the failed block where the skeleton
      // stood — the kernel's sentence, the code behind Details, Retry.
      // Stale and failed are calm information (the amber line / the failed block carry them): never the error red.
      // A remote host's refusal shows as relayed, as the context panel's Soul tab words it (remote-address.mjs).
      loading.fail(relayedFailure(error, serverLabel(next.instance), next.instance?.server ? 'soul' : null));
      // E_TEAM_CONFLICT: the soul can't be spawned until the workspace agrees; name the two labels.
      const labels = !loading.hasData && error?.code === 'E_TEAM_CONFLICT' ? teamLabels(error.labels) : null;
      content.querySelector('.inspector-conflict-labels')?.remove();
      if (labels) content.append(node('p', `Team labels in conflict: ${labels.join(', ')}`, 'muted inspector-conflict-labels'));
      syncAvailability(); // stale: the mutations wait, with the reason
    }
  }
  /** The soul page asks for the composed AGENTS.md (feature soul-composed-instructions, composed-gate.mjs): a soul on
   * this computer when its CLI composes; a routed soul only when that CLI also relays the hosts' own features
   * (server-probe-features). Whether that host composes is the server's call, from the roster row it holds:
   * it drops the flag for a host whose list does not name the feature, and the page shows the own AGENTS.md. */
  function composedWanted(next) {
    if (layout !== 'page' || !next?.agent) return false;
    return next.agent.remote || next.agent.server ? routedComposedSupported(cliStatus()) : composedSupported(cliStatus());
  }
  /** The soul page asks for the soul's own skills (feature soul-skills, composed-gate.mjs): a soul on this computer
   * when its CLI reports them; a routed soul only when that CLI also relays the hosts' own features
   * (server-probe-features). Whether that host reports them is the server's call, from the roster row it holds:
   * it drops the flag for a host whose list does not name the feature, and the answer has no skills. */
  function skillsWanted(next) {
    if (layout !== 'page' || !next?.agent) return false;
    return next.agent.remote || next.agent.server ? routedSkillsSupported(cliStatus()) : skillsSupported(cliStatus());
  }
  /** The soul page asks for every skill a spawn gives the instance (feature soul-composed-skills, composed-gate.mjs), by
   * the same rule: locally when this CLI lists them; routed when it also relays the hosts' features, the server keeping
   * the flag only for a host whose roster row names the feature. Without it, Composed shows the soul's own skills. */
  function composedSkillsWanted(next) {
    if (layout !== 'page' || !next?.agent) return false;
    return next.agent.remote || next.agent.server ? routedComposedSkillsSupported(cliStatus()) : composedSkillsSupported(cliStatus());
  }
  function facts(entries, parent = content) {
    const dl = node('dl', undefined, 'inspector-facts');
    for (const [key, value] of entries) dl.append(node('dt', key), node('dd', value === undefined || value === null || value === '' ? '—' : String(value)));
    parent.append(dl);
  }
  // One plain sentence each (the kernel's own message); the code waits behind Details.
  function problem(p, parent = content) {
    const row = node('div', undefined, 'inspector-problem');
    row.append(node('p', typeof p?.message === 'string' && p.message ? p.message : 'The kernel reported a problem.'));
    if (typeof p?.code === 'string' && p.code) { const more = node('details'); more.append(node('summary', 'Details'), node('p', p.code, 'muted')); row.append(more); }
    parent.append(row);
  }
  function instructions(doc, truncatedNote) {
    const box = node('details'); box.append(node('summary', 'AGENTS.md / instructions'), node('pre', doc?.text || 'No instructions reported.'));
    if (Array.isArray(doc?.sources) && doc.sources.length) box.append(node('p', `Composed from: ${doc.sources.map(x => x?.source).filter(Boolean).join(', ')}`, 'muted'));
    content.append(box);
    if (doc?.truncated) content.append(node('p', truncatedNote, 'muted'));
  }
  function render(inspected) {
    operationSerial++; teamsPanel = null;
    // Every accepted paint replaces what a later paint may reuse: only a soul page that paints this inspection holds it
    // again (renderSoulPage), so an empty answer or an instance is never painted over by an older one.
    shownInspection = null; shownFor = null; capabilityWords = null;
    // Instructions is re-appended below: detaching it drops its focus and scroll, so hold them first.
    const keepInstructions = instructionsSection?.hold();
    content.replaceChildren();
    // What the last inspection added beside the identity (page): the harness fact and the launch notes.
    facts$?.querySelector('[data-fact="harness"]')?.remove(); facts$?.parentElement?.querySelector('[data-launch-notes]')?.remove();
    const soul = inspected.souls[0] ?? null;
    // A soul's page says its problems in its Ready row (the first as one sentence, every one behind Details).
    const pageSoul = layout === 'page' && inspected.subject.kind === 'soul' && !!soul;
    if (!pageSoul) for (const p of inspected.problems) problem(p);
    // Capability warnings (0.49.0): a soul's, below its problems (an instance's are its readiness view's, which reads this lookup).
    warningTargets = typeof openCapability === 'function' && soul && pageScoped() ? capabilityTargets(coreEntries(inspected, { layersFrom: layersFrom(), facts: desktopFacts(cliStatus()) }),
      compositionEntries(inspected, soul, { facts: desktopFacts(cliStatus()) })) : new Map();
    if (inspected.subject.kind === 'soul') renderSoulWarnings(inspected);
    if (inspected.subject.kind === 'instance') {
      summary.replaceChildren();
      content.append(node('p', 'As spawned: an instance never changes under itself. A newer soul or module needs a new instance.', 'muted'));
      // Teams first (join/leave), then the instance, the soul it came from, and the as-spawned detail.
      const teams = teamsOperations(inspected);
      if (teams) {
        section('Teams'); const id = subject, gen = selectionGen, instance = selection.instance, label = serverLabel(instance);
        // A remote host's refusal of a teams operation shows as relayed, as the context panel's card words it (instance-teams.mjs).
        const relayed = body => request(body).catch(error => { throw instance?.server ? relayedFailure(error, label, 'teams') : error; });
        teamsPanel = createTeamsPanel(content, { operations: teams, selector: selection.selector, request: relayed, heading: false,
          owns: () => ownsSubject(id, gen) && selectionGen === workspaceGeneration(), available,
          mutable: () => !stale(), mutableReason: INSPECTION_STALE_TITLE }); // join/leave wait while the inspection is stale
      }
      section('Instance'); card(instanceFacts(inspected.instance));
      if (soul) spawnedFrom(soul);
      instructions(inspected.instance.instructions, 'Instructions are truncated here.');
      renderCapabilities(inspected, { collapsed: true });
    } else if (soul && layout === 'page') renderSoulPage(inspected, soul);
    else if (soul) {
      renderSoulTeams(inspected);
      section('Harness');
      // The harness card's rows, notes and problem are the shared home's (packages/client/soul-facts.mjs).
      const said = soulFacts(selection?.agent, inspected, cliStatus(), DESKTOP_TERMS);
      if (said.launch) {
        // 0.30 launch preferences: what a spawn here runs, where that choice came from, and where to change it.
        const box = card(said.rows);
        box.classList.add('inspector-launch');
        for (const at of said.notes) box.append(node('p', at, 'launch-at'));
        if (said.problem) box.append(launchProblem(said.problem));
      }
      // The harness it declares by default (a kernel before 0.30), and the model within it (if any).
      else if (said.rows.length) card(said.rows);
      else for (const note of said.notes) content.append(node('p', note, 'muted'));
      renderCapabilities(inspected);
    } else content.append(node('p', 'The kernel did not report this soul. Refresh to retry.', 'muted'));
    // Operations run on a live home: a soul shows none (human, F7); an instance lists what it can run.
    if (inspected.subject.kind === 'instance') renderOperations(inspected);
    keepInstructions?.();
  }
  /** Whether the capability page can show this subject's capabilities: it reads the view's primary deployment (#482), so
   * a soul (always there) or an instance on this computer in that deployment. An instance in another deployment, or on a
   * server, gets no Open capability rather than the primary's capability of the same name. */
  function pageScoped() {
    const ref = selection?.instance, w = workspace();
    return !ref || (!ref.server && !!w && rowDeployment(ref) === (w.primary || w.id));
  }
  /** The shown inspection's capabilities by id, each with its core or composition entry: an "Open capability" (a composed
   * part's, a capability warning's) takes the tables' own path. */
  function capabilityTargets(coreRows, entries) {
    return new Map([...coreRows.filter(entry => entry.id && entry.cap).map(entry => [entry.id, { cap: entry.cap, entry }]),
      ...entries.filter(entry => entry.cap?.id).map(entry => [entry.cap.id, { cap: entry.cap, entry }])]);
  }
  /** A soul's capability warnings (capability-warnings.mjs) under "Warnings" in the layout's section style; none, no
   * section. Each names its capability; Open capability shows where the host opens capabilities and the name resolves
   * against this inspection, checked again at click time (the subject, the workspace). */
  function renderSoulWarnings(inspected) {
    const warnings = Array.isArray(inspected.warnings) && inspected.warnings.length ? warningsOf(inspected.warnings) : [];
    if (!warnings.length) return;
    const id = subject, gen = selectionGen, targets = warningTargets;
    const list = createWarningsList(doc, warnings, { showCapability: true, focusKey: 'soul-warning', canOpen: name => targets.has(name),
      open: typeof openCapability === 'function' ? name => { const found = targets.get(name); if (found && ownsSubject(id, gen) && list.isConnected) openCapability(found.cap, selection.agent, found.entry); } : null });
    if (!list) return;
    if (layout === 'page') { const box = pageSection(doc, WARNINGS_COPY.title); box.classList.add('inspector-warnings'); box.append(list); content.append(box); }
    else { section(WARNINGS_COPY.title); content.append(list); }
  }
  function section(title) { const h = node('h3', title, 'inspector-section'); content.append(h); return h; }
  function card(entries, parent = content) { const box = node('div', undefined, 'inspector-card'); facts(entries, box); parent.append(box); return box; }
  const item = (name, meta, side) => {
    const el = node('div', undefined, 'inspector-item'), main = node('div');
    main.append(node('div', name, 'inspector-item-name')); for (const m of meta) if (m) main.append(node('div', m, 'inspector-item-meta'));
    el.append(main); if (side) el.append(side); return el;
  };
  // Created as a relative age; the exact value and the resolution stay reachable.
  function instanceFacts(instance) {
    return inspectFacts.instance(instance).map(([key, value]) => key === 'Created' && instance.createdAt ? [key, `${ageText(instance.createdAt)}`] : [key, value]);
  }
  function spawnedFrom(soul) {
    const box = node('div', undefined, 'inspector-card inspector-spawned');
    const commit = typeof soul.commit === 'string' && soul.commit ? ` @ ${soul.commit.slice(0, 7)}` : '';
    box.append(node('span', `Spawned from ${soul.name}${commit}`));
    // The host resolves the soul in its roster (exact identity) and selects it; a miss is said, not silent.
    const ref = { name: soul.name, agentsRoot: selection.instance?.agentsRoot, server: selection.instance?.server ?? null };
    if (typeof openSoul === 'function' && ref.name && ref.agentsRoot) {
      const id = subject, gen = selectionGen;
      const open = button('Open soul', () => {
        if (!ownsSubject(id, gen) || !open.isConnected) return;
        if (openSoul(ref) !== true) message(`${ref.name} is not in this workspace's souls.`);
      });
      open.title = 'Inspect the soul this instance was spawned from'; open.dataset.focusKey = 'open-soul'; box.append(open);
    }
    content.append(box);
  }
  // The soul's teams (kernel `teams`): one row of chips, the default (v2) first and marked;
  // unmapped ones are not shown. Joining is per instance. There is no "primary" (team model v2).
  function renderSoulTeams(inspected) {
    const all = soulTeams(inspected.teams);
    if (!all) return;
    // Only the teams the soul has access to (mapped by this workspace); unmapped labels are not shown.
    const teams = all.filter(t => t.mapped);
    section('Teams');
    if (!teams.length) { content.append(node('p', 'Default team only: this soul has access to no other team.', 'muted')); return; }
    content.append(node('p', "The teams this soul has access to. Its instances start in the workspace's default team only and can join these:", 'muted inspector-teams-lede'));
    const row = node('div', undefined, 'inspector-chips');
    teams.forEach(t => {
      const chip = node('span', t.default === true ? `${t.label} · default` : t.label, 'inspector-chip');
      chip.title = `${t.label} (${t.team})`;
      row.append(chip);
    });
    content.append(row);
  }
  // Roster-owned actions do not depend on operationsApi, inspect success, or
  // an editable soul record. Built once per subject; each handler reads the
  // CURRENT selection row at click time, since a refresh swaps the row without
  // rebuilding these controls.
  function renderSoulActions(column = null) {
    const id = subject, gen = selectionGen;
    const actions = node('div', undefined, 'inspector-actions');
    const action = (label, cls, key, can, run) => {
      const control = button(label, () => {
        const agent = selection?.agent;
        if (agent && ownsSubject(id, gen) && control.isConnected && !control.disabled && can(agent)) run?.(agent);
      });
      control.classList.add(cls); control.dataset.focusKey = key; return control;
    };
    // The soul page's primary action is Spawn (human, 2026-09-26; it opens the spawn dialog).
    const launchButton = action(column ? `New ${DESKTOP_NOUNS.instance}` : 'Launch…', 'spawn-act', 'spawn', canLaunch, launch);
    if (column) launchButton.setAttribute('aria-label', `New ${DESKTOP_NOUNS.instance} of ${selection.agent.name}`); launchButton.classList.add('primary'); launchButton.dataset.launch = '1';
    const scheduleButton = action('Schedule…', 'schedule-act', 'schedule', canLaunch, schedule); scheduleButton.dataset.launch = '1';
    const filesButton = action('Files', 'brain-act', 'files', canFiles, files); filesButton.dataset.files = '1';
    actions.append(filesButton, scheduleButton, launchButton);
    // Kernel #217 (desktop-facts): the soul's file opens as its web page, when reported.
    const webFile = agent => desktopFacts(cliStatus()) && typeof agent?.file?.url === 'string' && /^https:\/\//.test(agent.file.url) ? agent.file.url : null;
    const fileUrl = column ? webFile(selection.agent) : null;
    if (fileUrl && typeof ctx?.openExternal === 'function') {
      const open = button('Open file', () => { const url = webFile(selection?.agent); if (url && ownsSubject(id, gen)) ctx.openExternal(url); });
      open.classList.add('file-act'); open.dataset.focusKey = 'open-file'; open.title = selection.agent.file.path || fileUrl; actions.prepend(open);
    }
    if (headActions) headActions.prepend(actions); else summary.append(actions);
    syncAvailability();
  }
  /** What the roster row says about the soul — its lede, a spawn refusal, the repo/work/file facts and
   * its Instances — repainted on every show() behind a signature, so a refresh follows the roster
   * (a new or retired instance) while an unchanged roster keeps its nodes and whatever holds focus. */
  function renderSoulRoster() {
    const agent = selection?.agent; if (!agent || !summary) return;
    const id = subject, gen = selectionGen, column = rosterColumn;
    const homes = instances(agent);
    // The host roster's own state (desktop/loading-states): an empty list is "No instances yet." only after a good
    // read; while the roster is pending it is a skeleton line, while failed or stale it makes no claim.
    const rosterState = homes.length ? 'ready' : instancesState();
    const refusal = column ? spawnRefusal(agent) : null, facts = desktopFacts(cliStatus());
    const signature = JSON.stringify([layout, agent.description, refusal, agent.repoName, agent.work, agent.file, facts, rosterState,
      homes.map(i => [i.instance, i.home, i.running, runtimeState(i), buildState(i)])]);
    if (signature === rosterSignature) return;
    rosterSignature = signature;
    // The block spans the identity copy (lede, refusal, facts) and the Instances card (page: the side column).
    const restore = captureFocusState(container, { scroller: container, fallback: refreshControl });
    for (const el of container.querySelectorAll('.inspector-lede, .inspector-refusal, .inspector-instances, .inspector-roster')) el.remove();
    if (facts$) for (const el of facts$.querySelectorAll('[data-fact="repo"], [data-fact="branch"], [data-fact="file"]')) el.remove();
    const openHome = (instance, control) => {
      if (!ownsSubject(id, gen) || !control.isConnected) return;
      // Instances keep the sidebar: from a soul page, the host opens it beside the page.
      if (typeof openInstance === 'function') openInstance(instance); else void show({ instance, selector: { home: instance.home } });
    };
    if (column) {
      // Identity: what it does, then where it comes from and works. Its agents are counted on the Souls grid and
      // table, not listed here (slice 3a); whether it is ready is the top block's Ready row, which follows the roster.
      if (agent.description) facts$.before(node('p', agent.description, 'inspector-lede'));
      if (typeof agent.repoName === 'string' && agent.repoName) facts$.append(pageFact('repo', agent.repoName));
      if (typeof agent.work === 'string' && agent.work) facts$.append(pageFact('branch', workText(agent.work), 'muted'));
      // Kernel #217: the soul's file. Without a web address (a non-GitHub repo) its path shows instead.
      if (facts && typeof agent.file?.path === 'string' && agent.file.path && !(typeof agent.file.url === 'string' && /^https:\/\//.test(agent.file.url))) facts$.append(pageFact('file', agent.file.path, 'mono'));
      if (shownCurrent()) readyBlock?.paint(shownInspection);
      restore(); return;
    }
    const roster = node('div', undefined, 'inspector-content inspector-roster');
    // What a person needs: what it does, and its instances.
    if (agent.description) roster.append(node('p', agent.description, 'inspector-lede'));
    roster.append(node('h3', rosterState === 'ready' || rosterState === 'empty' ? `Instances · ${homes.length}` : 'Instances'));
    if (!homes.length) roster.append(emptyInstances(rosterState, 'No instances reported for this soul.', 'muted'));
    for (const instance of homes) {
      const control = button(`${instance.instance} · ${runtimeState(instance)}`, () => openHome(instance, control));
      control.classList.add('inspector-instance'); control.dataset.focusKey = `instance:${instance.home || instance.instance}`; control.disabled = !instance.home;
      control.title = instance.home ? 'Inspect the immutable instance snapshot' : 'No instance home reported';
      roster.append(control);
    }
    summary.append(roster);
    restore();
  }
  /** What stands where the instances go when there are none: the empty copy after a good roster read; a skeleton
   * line while the roster is pending; while it is failed or stale, no claim (the roster's own line says why). */
  function emptyInstances(state, copy, cls) {
    if (state === 'pending' || state === 'idle') { const line = skeleton(doc, 'line', { width: '60%' }); line.classList.add('inspector-instances-pending'); return line; }
    if (state === 'failed' || state === 'stale') { const none = node('span', undefined, 'inspector-instances-unknown'); none.dataset.rosterState = state; none.setAttribute('aria-hidden', 'true'); return none; }
    return node('p', copy, cls);
  }
  /** A launch problem of the soul's report, from its parts (soul-facts.mjs launchProblemParts): the Desktop's own
   * line, then the kernel's message and fix, each a line of its own under the kernel's name, and the code behind
   * Details. */
  function launchProblem({ lead, lines, code }) {
    const box = node('div', undefined, 'launch-problem'); box.setAttribute('role', 'note');
    box.append(node('p', lead, 'launch-problem-own'), ...lines.map(line => node('p', line, 'launch-problem-said')));
    const more = node('details'); more.append(node('summary', 'Details'), node('p', code, 'muted')); box.append(more);
    return box;
  }
  function pageFact(icon, value, cls) {
    const fact = node('span', undefined, 'page-fact');
    fact.dataset.fact = icon; fact.append(iconElement(doc, icon, { size: 15 }), node('span', value, cls)); return fact;
  }
  // The soul's page (the Desktop UI rework, slice 3a): one column. A top block (harness · model, teams, knowledge,
  // ready), its warnings, its capabilities as one list of rows (core first, tagged), then its two prompts as two tabs
  // (soul-instructions.mjs). Only reported facts: what the kernel does not say is not claimed.
  function renderSoulPage(inspected, soul) {
    // The inspection this page shows, bound to its subject and workspace generation: a later paint that does not read it
    // again (a catalog update, a roster poll) uses it only for that same subject (shownCurrent).
    shownInspection = inspected; shownFor = { subject, gen: selectionGen };
    const said = soulFacts(selection?.agent, inspected, cliStatus(), DESKTOP_TERMS);
    const declared = record(soul.declarations) ? soul.declarations : {};
    const teams = soulTeams(inspected.teams), mapped = (teams || []).filter(t => t.mapped);
    const top = node('dl', undefined, 'soul-top');
    const row = (key, label, ...values) => {
      const dt = node('dt', label), dd = node('dd'); dd.dataset.fact = key; dd.append(...values); top.append(dt, dd); return dd;
    };
    // Harness · model: what a spawn here runs (0.30 launch preferences), with where that choice came from; else the
    // harness the soul declares and its model; else that there is no default. The notes (the soul's own preference
    // when it differs, where the choice is set) are small lines under it.
    const launch = said.launch, harness = harnessOf(soul);
    const harnessCell = [];
    // The harness, then (muted) its model, a launch configuration and what chose it: one phrase, " · " between its parts.
    if (launch) {
      const e = launch.effective;
      harnessCell.push(createRuntimeBadge(doc, e.harness), node('span', launchHarnessName(e.harness), 'strong'),
        node('span', [launchModelText(e), e.launchConfig ? `launch configuration ${e.launchConfig}` : null, launchFromText(launch.from)].filter(Boolean).join(' · '), 'muted'));
    } else if (typeof harness === 'string' && harness) {
      harnessCell.push(createRuntimeBadge(doc, harness), node('span', launchHarnessName(harness), 'strong'));
      if (typeof soul.model === 'string' && soul.model) harnessCell.push(node('span', `${soul.model} by default`, 'muted'));
    }
    const harnessValue = row('harness', 'Harness · model', ...harnessCell);
    // Under it, small: the soul's own preference when this computer runs something else, and where the choice is set
    // (a launch problem is the Ready row's). The notes carry the side panel's classes (launch-declared, launch-at).
    const notes = [...(launch ? [declaredText(launch)].filter(Boolean).map(text => [text, 'launch-declared']) : []), ...said.notes.map(text => [text, 'launch-at'])];
    for (const [text, cls] of notes) harnessValue.append(node('span', text, `soul-top-note ${cls}`));
    if (notes.length) harnessValue.dataset.launchNotes = '';
    // Teams: the ones it may join (mapped here), the default marked; "Teams here" (this computer's, editable) folded under it.
    const { teamModel, soulKey } = teamsHereConditions();
    const labels = mapped.length ? mapped.map(t => t.default === true ? `${t.label} (default)` : t.label).join(' · ')
      : teams ? 'Default team only' : rosterTeams(selection?.agent);
    const teamsValue = row('teams', 'Teams', node('span', labels || 'Not reported', labels ? '' : 'muted'));
    if (teamsHere && !teamModel) { teamsHere.element.remove(); teamsHere.dispose(); teamsHere = null; } // the CLI lost the feature since the frame
    if (teamModel && !soulKey) teamsValue.append(node('span', teamModel === 3 ? "This Desktop's server does not report the soul's key: oats soul teams shows its teams."
      : "Set this soul's teams with the CLI (oats soul teams): this Desktop's server does not report the soul's key.", 'soul-top-note'));
    else if (teamModel && ensureTeamsHere() && teamsBlock) teamsValue.append(teamsBlock.element);
    // Knowledge: the nodes it owns and reads, when it declares any.
    const knowledge = record(declared.knowledge) ? declared.knowledge : null;
    const owns = knowledge && typeof knowledge.owns === 'string' && knowledge.owns ? knowledge.owns : null;
    const reads = knowledge && Array.isArray(knowledge.reads) ? knowledge.reads.filter(r => typeof r === 'string' && r) : [];
    if (owns || reads.length) row('knowledge', 'Knowledge', node('span', [owns ? `owns ${owns}` : null, reads.length ? `reads ${reads.join(', ')}` : null].filter(Boolean).join(' · ')));
    // Ready: one word, or the one problem in one sentence with its detail behind Details.
    if (readyBlock) { readyBlock.paint(inspected); row('ready', 'Ready', readyBlock.element); }
    content.prepend(top);
    // Capabilities: one list, core first with its tag, then the rest in the kernel's composition order. A row opens the
    // capability's page. What the soul turns off, and a core slot left empty, are one muted line under the list.
    const coreRows = coreEntries(inspected, { layersFrom: layersFrom(), facts: desktopFacts(cliStatus()) });
    const entries = compositionEntries(inspected, soul, { facts: desktopFacts(cliStatus()) });
    instructionCapabilities = capabilityTargets(coreRows, entries);
    const shown = [...coreRows.filter(entry => entry.id).map(entry => ({ entry, cap: entry.cap, name: entry.id, core: true })),
      ...entries.filter(entry => entry.why !== 'off' && entry.cap).map(entry => ({ entry, cap: entry.cap, name: entry.cap.id, core: false }))];
    const section = pageSection(doc, 'Capabilities', shown.length ? `${shown.length} · core first` : '');
    section.classList.add('soul-capabilities');
    const id = subject, gen = selectionGen;
    const lines = shown.map(({ entry, cap, name, core }) => {
      const said = cap ? describeCapability(cap) : {};
      const why = entry.why ? whyTag(entry)[1] : null;
      return capabilityLine(doc, { name, by: said.by ?? null, description: said.description ?? null, core, focusKey: `capability:${name}`,
        title: [name, core ? `core: ${layerLabel(entry.slot)}` : null, why].filter(Boolean).join(' · '),
        onOpen: cap && typeof openCapability === 'function' ? () => { if (ownsSubject(id, gen)) openCapability(cap, selection.agent, entry); } : null });
    });
    capabilityWords = JSON.stringify(shown.map(({ cap }) => cap ? describeCapability(cap) : null));
    if (lines.length) section.append(capabilityLines(doc, lines, { label: `Capabilities of ${selection.agent?.name ?? soul.name}` }));
    else section.append(node('p', 'No capabilities resolved.', 'page-note'));
    const off = entries.filter(entry => entry.why === 'off').map(entry => entry.name);
    const empty = coreRows.filter(entry => !entry.id && entry.reported).map(entry => `no ${entry.slot} capability`);
    if (off.length || empty.length) section.append(node('p', [off.length ? `Turned off: ${off.join(', ')}` : null, ...empty].filter(Boolean).join(' · '), 'soul-capabilities-note'));
    content.append(section);
    // Its two prompts, as two tabs, and its skills (soul-instructions.mjs), from this inspection (no read of its own).
    if (instructionsSection) { instructionsSection.update(soul); content.append(instructionsSection.element); }
  }
  /** A capability's "by <source>" and one line of what it does: the host's (the workspace's catalog, its member
   * names), else where the inspection says it comes from and no line. */
  function describeCapability(cap) {
    if (typeof capabilityFacts === 'function') { const said = capabilityFacts(cap); if (said) return said; }
    const from = record(cap?.from) ? cap.from : {};
    const by = typeof from.package === 'string' && from.package ? from.package
      : typeof from.repoKey === 'string' && from.repoKey ? from.repoKey.split('/').filter(Boolean).at(-1) : null;
    return { by, description: null };
  }
  /** The teams a roster row names (team model v2 rows, the default first; 0.29's labels), in words; null when none. */
  function rosterTeams(agent) {
    const v2 = Array.isArray(agent?.teams) && agent.teams.every(t => typeof t?.label === 'string' && t.label) ? agent.teams : null;
    if (v2) return v2.length ? [...v2].sort((x, y) => (y.default === true) - (x.default === true)).map(t => t.default === true ? `${t.label} (default)` : t.label).join(' · ') : null;
    return Array.isArray(agent?.labels) && agent.labels.length ? agent.labels.join(' · ') : null;
  }
  /** The Ready row's value, kept across repaints (one per subject): the word or the sentence, then a closed native
   * disclosure with the problem's detail and the soul's readiness checks (readiness-view.mjs, a soul selector), read
   * when the disclosure is first opened, so a page that is only looked at costs no extra read. */
  function createReadyBlock() {
    const element = node('div', undefined, 'soul-ready');
    const line = node('span', '', 'soul-ready-line');
    const details = node('details', undefined, 'soul-ready-details');
    const summaryEl = node('summary', 'Details'); summaryEl.dataset.focusKey = 'ready-details';
    const problems = node('div', undefined, 'soul-ready-problems'), checks = node('div', undefined, 'soul-ready-checks');
    details.append(summaryEl, problems, checks); element.append(line, details);
    let view = null;
    const id = subject, gen = selectionGen;
    details.addEventListener('toggle', () => {
      if (!details.open || view || !alive || !ownsSubject(id, gen)) return;
      view = readiness = createReadinessView(checks, { ctx, clock: timers,
        canOpenCapability: name => typeof openCapability === 'function' && warningTargets.has(name),
        openCapability: typeof openCapability === 'function' ? name => { const found = warningTargets.get(name); if (found && ownsSubject(id, gen)) openCapability(found.cap, selection.agent, found.entry); } : null });
      syncReadiness();
    });
    return {
      element,
      /** The row from the inspection and the CURRENT roster row (a spawn refusal follows the roster poll). */
      paint(inspected) {
        const agent = selection?.agent, cli = cliStatus();
        const refusal = spawnRefusal(agent);
        const said = soulFacts(agent, inspected, cli, DESKTOP_TERMS);
        // Any problem the inspection reports is one: a problem without words says the generic sentence (problem()'s).
        // An entry counts whatever its shape (null too, as problem() shows it), so existence is the list's length.
        const firstProblem = inspected.problems.length ? inspected.problems[0] : undefined;
        const problemText = inspected.problems.length ? (typeof firstProblem?.message === 'string' && firstProblem.message ? firstProblem.message : 'The kernel reported a problem.') : null;
        const sentence = refusal ?? problemText ?? said.problem?.lines?.[0] ?? said.problem?.lead ?? null;
        line.textContent = sentence ?? 'Ready';
        line.classList.toggle('problem', !!sentence);
        element.dataset.ready = String(!sentence);
        // Behind Details: every problem in full, with its code; then (once opened) the readiness checks.
        problems.replaceChildren();
        if (refusal) {
          const box = node('div', undefined, 'inspector-problem'); box.append(node('p', cantSpawnLine(refusal)));
          if (typeof agent?.problem?.code === 'string' && agent.problem.code) box.append(node('p', agent.problem.code, 'muted'));
          problems.append(box);
        }
        for (const p of inspected.problems) problem(p, problems);
        if (said.problem) problems.append(launchProblem(said.problem));
      },
      dispose() { if (view) { if (readiness === view) readiness = null; view.dispose(); view = null; } },
    };
  }
  /** The Teams row's disclosure: "Teams here", this computer's membership of the soul (soul-teams-here.mjs). */
  function createTeamsBlock() {
    const element = node('details', undefined, 'soul-teams-details');
    const summaryEl = node('summary', 'Teams on this computer'); summaryEl.dataset.focusKey = 'teams-here';
    element.append(summaryEl);
    return { element, host: element };
  }
  // `oats soul teams` takes the kernel's soul key, on every roster row as `key` (#275, #276): the
  // bare name for a member or external soul, <package>/<soul> for a package soul. A row without one
  // (a Desktop server from before #275) gets no card: the CLI says it, and nothing is sent.
  function teamsHereConditions() {
    return { teamModel: teamModelOf(cliStatus()?.features),
      soulKey: typeof selection?.agent?.key === 'string' && selection.agent.key ? selection.agent.key : null };
  }
  /** The page's "Teams here" card, once per subject, first in the side column; its `oats soul teams`
   * read starts when it is created (with the frame), not after `inspect` answers. */
  function ensureTeamsHere() {
    if (teamsHere || !teamsBlock) return teamsHere;
    const { teamModel, soulKey } = teamsHereConditions();
    if (!teamModel || !soulKey) return null;
    const soulTeamsRoute = async body => teamsAnswer(await postJson(ctx, `/api/workspace-soul-teams${wsQuery()}`, body), 'soulTeams', 'The teams of this soul could not be read.');
    const teamsRoute = async () => teamsAnswer(await postJson(ctx, `/api/workspace-teams${wsQuery()}`, { action: 'list' }), 'teams', 'The teams on this computer could not be read.');
    teamsHere = createSoulTeamsHere(doc, { soul: soulKey, request: soulTeamsRoute, listTeams: teamsRoute, clock: timers });
    teamsBlock.host.append(teamsHere.element);
    return teamsHere;
  }
  // Core capabilities name their origin only when the CLI advertises layers-from.
  const layersFrom = () => Array.isArray(cliStatus()?.features) && cliStatus().features.includes('layers-from');
  function renderCapabilities(inspected, { collapsed = false } = {}) {
    let host = content;
    if (collapsed) { host = node('details', undefined, 'inspector-disclosure'); host.append(node('summary', `Modules as spawned · ${inspected.capabilities.length}`)); content.append(host); }
    host.append(node('h3', 'Core capabilities', 'inspector-section'));
    coreCard(coreEntries(inspected, { layersFrom: layersFrom(), facts: desktopFacts(cliStatus()) }), host, { spawned: inspected.subject.kind === 'instance' });
    // Every other capability: a core slot's provider is the card's above, never listed twice.
    const others = inspected.capabilities.filter(cap => !isCoreCapability(inspected, cap));
    host.append(node('h3', `Capabilities · ${others.length}`, 'inspector-section'));
    if (!others.length) { host.append(node('p', inspected.capabilities.length ? 'No other capabilities: only the core ones.' : 'No capabilities resolved.', 'muted')); return; }
    const list = node('div', undefined, 'inspector-list');
    for (const cap of others) {
      const missing = Array.isArray(cap.missingRequires) && cap.missingRequires.length ? `Missing: ${cap.missingRequires.join(', ')}` : '';
      const row = item(cap.id, [[cap.version, originText(cap.from)].filter(Boolean).join(' · '), missing]);
      row.classList.add('inspector-cap-row');
      const more = node('details'); more.append(node('summary', 'Details')); facts(inspectFacts.capability(cap), more);
      if (cap.settings && typeof cap.settings === 'object' && Object.keys(cap.settings).length) more.append(node('pre', JSON.stringify(cap.settings, null, 2)));
      row.append(more); list.append(row);
    }
    host.append(list);
  }
  /** The Core capabilities card (sidebar soul, instance): each slot's provider with the soul page's reason
   * words — the same tag and note (`spawned`: an instance's) — or None / Not reported. */
  function coreCard(entries, parent, { spawned = false } = {}) {
    const box = node('div', undefined, 'inspector-card'), dl = node('dl', undefined, 'inspector-facts inspector-core');
    for (const entry of entries) {
      const dd = node('dd'); dd.dataset.layer = entry.slot;
      dd.append(node('span', entry.id || (entry.reported ? 'None' : 'Not reported'), `inspector-core-id${entry.id ? '' : ' none'}`));
      const tag = whyElement(doc, entry); if (tag) dd.append(tag);
      const note = coreNote(entry, { spawned }); if (note) dd.append(node('span', note, 'inspector-core-note'));
      dl.append(node('dt', layerLabel(entry.slot)), dd);
    }
    box.append(dl); parent.append(box); return box;
  }
  function renderOperations(inspected) {
    const id = subject, gen = selectionGen;
    content.append(node('h3', 'Provider operations'));
    // A layer provider is the module that fills the layer (no activation record in v2).
    const providers = inspected.capabilities.filter(cap => cap.layer);
    // The Teams section owns messaging:teams|join|leave on an instance (one control per verb).
    const owned = inspected.subject.kind === 'instance' && teamsOperations(inspected)?.supported;
    let count = 0;
    for (const provider of providers) for (const operation of provider.operations || []) {
      if (owned && provider.layer === 'messaging' && ['teams', 'join', 'leave'].includes(operation.name)) continue;
      count++; const row = node('div', undefined, 'inspector-cap');
      row.append(node('h4', `${provider.layer}: ${operation.name}`), node('p', operation.description || provider.id, 'muted'));
      if (!operation.available || operation.args?.some(arg => arg.required)) row.append(node('p', operation.reason || 'This operation requires arguments; run it with the OATS CLI.', 'muted'));
      else {
        const address = `${provider.layer}:${operation.name}`;
        const control = mutationButton(operation.kind === 'view' ? 'View' : 'Run', async () => {
          if (!available() || !ownsSubject(id, gen) || !control.isConnected || !content.contains(control) || pendingOperations.has(control)) return;
          const op = ++operationSerial; pendingOperations.set(control, op); control.disabled = true;
          // Output/status follow latest intent; each pending control owns only its lock.
          const ownsControl = () => ownsSubject(id, gen) && control.isConnected && content.contains(control) && pendingOperations.get(control) === op;
          const owns = () => ownsControl() && op === operationSerial;
          message(`Running ${address}…`);
          try {
            const result = await request({ action: 'run', selector: selection.selector, operation: address });
            if (!owns()) return;
            // Dispatch on the payload's own integer; the result must be for this operation.
            if (result?.operationsApi !== 2 || result.operation !== address) {
              message(result?.operationsApi === 1 ? 'This workspace still uses the classic layout, which answers an older operation result.'
                : 'The installed OATS CLI returned an operation result this Desktop cannot read.', true);
              return;
            }
            const output = result.result;
            const area = node('div');
            if (operation.kind === 'view') {
              if (output?.summary) area.append(node('p', output.summary));
              for (const document of output?.documents || []) {
                area.append(node('h4', document.label));
                if (document.path) area.append(node('p', document.path, 'muted'));
                area.append(node('pre', document.text ?? 'No inline content provided.'));
              }
            } else area.append(node('pre', JSON.stringify(output, null, 2)));
            row.querySelector('.operation-output')?.remove(); area.className = 'operation-output'; row.append(area); message('Complete.');
          } catch (error) { if (owns()) message(error.message, true); }
          finally {
            if (ownsControl()) { pendingOperations.delete(control); syncAvailability(); }
          }
        });
        control.dataset.operation = address; control.dataset.focusKey = `op:${address}`; row.append(control);
      }
      content.append(row);
    }
    if (!count) content.append(node('p', 'The active providers do not declare operations.'));
  }
  function syncAvailability() {
    syncReadiness(); teamsPanel?.sync();
    if (!selection || !content) return;
    for (const control of content.querySelectorAll('[data-mutate]')) { control.disabled = pendingOperations.has(control) || !available() || selectionGen !== workspaceGeneration(); markStale(control); holdRun(control); }
    for (const control of container.querySelectorAll('[data-launch]')) {
      control.disabled = !alive || selectionGen !== workspaceGeneration() || !canLaunch(selection.agent) || selection.agent?.work === 'attached' || !selection.agent?.agentsRoot;
      control.title = selection.agent?.work === 'attached' ? 'Attached only — requires an owning instance.' : control.disabled ? launchReason(selection.agent) : '';
    }
    for (const control of container.querySelectorAll('[data-files]')) {
      control.disabled = !alive || selectionGen !== workspaceGeneration() || !canFiles(selection.agent);
      control.title = control.disabled ? 'Files need an unambiguous local soul in this workspace.' : 'Read-only soul files';
    }
  }
  /** The host's roster changed or its read settled (a poll): the roster-derived block — lede, refusal, facts, the
   * Instances card and its empty / pending / no-claim state — follows, behind its signature (focus kept). */
  /** Whether the held inspection is the shown subject's, in the current workspace generation. */
  function shownCurrent() {
    return !!shownInspection && shownFor?.subject === subject && shownFor.gen === selectionGen && selectionGen === workspaceGeneration();
  }
  /** The host's capability facts changed (its catalog was read): the page's rows follow, in place (focus kept), only
   * when what they say changed. */
  function syncCatalog() {
    // Also while a capability page covers this one (hidden): Back then shows the rows as they are now.
    if (!alive || layout !== 'page' || !shownCurrent() || !selection?.agent) return;
    const soul = shownInspection.souls[0]; if (!soul) return;
    const coreRows = coreEntries(shownInspection, { layersFrom: layersFrom(), facts: desktopFacts(cliStatus()) });
    const entries = compositionEntries(shownInspection, soul, { facts: desktopFacts(cliStatus()) });
    const caps = [...coreRows.filter(e => e.id).map(e => e.cap), ...entries.filter(e => e.why !== 'off' && e.cap).map(e => e.cap)];
    if (JSON.stringify(caps.map(cap => cap ? describeCapability(cap) : null)) === capabilityWords) return;
    // Hidden, nothing in it holds focus: repaint without moving any.
    if (container.hidden) { render(shownInspection); return; }
    const restore = captureFocusState(content, { scroller: container, fallback: refreshControl });
    render(shownInspection); restore();
  }
  /** The host's roster read settled: the subject's row is re-read from it (`currentRow`: the one current row of the
   * same soul, by its composite identity, else null), so what the row says (a spawn refusal, the lede, the facts) and
   * the actions that read it (New agent) follow a poll. A soul that left the roster, or became ambiguous, keeps its
   * last row; the host's own checks (canLaunch) refuse its actions. The page follows while a capability page covers it. */
  function syncRoster() {
    if (!alive || !selection?.agent || (container.hidden && (layout !== 'page' || selectionGen !== workspaceGeneration()))) return;
    const fresh = typeof currentRow === 'function' ? currentRow(selection.agent) : null;
    if (fresh && fresh !== selection.agent) { selection = { ...selection, agent: fresh }; syncAvailability(); }
    renderSoulRoster();
  }
  return { show, close, syncAvailability, syncRoster, syncCatalog,
    focusLaunch(agent) {
      const selected = selection?.agent;
      if (!alive || container.hidden || (presentation && !presentation.isVisible())
        || selectionGen !== workspaceGeneration() || !selected || selected.name !== agent.name
        || (selected.agentsRoot || '') !== (agent.agentsRoot || '') || (selected.server || '') !== (agent.server || '')) return false;
      const control = container.querySelector('.spawn-act:not([disabled])'); // the page keeps its actions in the head
      if (!control?.isConnected || control.closest('[hidden], [inert]')) return false;
      control.focus(); return true;
    },
    dispose() { if (!alive) return; alive = false; reset(); } };
}
