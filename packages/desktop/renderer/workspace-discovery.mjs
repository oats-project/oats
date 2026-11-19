/** Workspace view header and its Capabilities / Teams / Setup (id: sources) tabs, natively on
 * workspace model v2. Facts come from the installed kernel only:
 *   - `oats workspace status` + `oats status` (the roster observation) for
 *     sources, lock state and which instances carry a module;
 *   - `oats capabilities` (POST /api/workspace-sync {action:"read"}) for the
 *     capability table.
 * Sync is the kernel's `oats sync` (workspace-sync-view.mjs); there is no
 * package approval. Souls stay the host view's own grid. */
import { teamModelOf } from '../../client/team-rows.mjs';
import { apiJson, postJson, wsQuery, workspaceGeneration } from './views/common.mjs';
import { cliStatus, cliKnownUnavailable, cliHeldBack } from './views/cli-status.mjs';
import { deploymentUnavailableText } from '../../client/deployment-facts.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { setupCSS, renderSetup, teamsBox } from './workspace-setup.mjs';
import { createWorkspaceMachines, machinesCSS } from './workspace-machines.mjs';
import { machinesGated } from '../../client/machine-contract.mjs';
import { computerTeamsCSS, createComputerTeams, teamsAnswer } from './computer-teams.mjs';
import { catalogCSS, renderCapabilitySections, renderRepoPills, rovePill, repoChoices, filterCapabilities, deploymentNotes, syncCapabilityNav } from './workspace-catalog.mjs';
import { capabilitySections, matchCapabilities, hostKeyOf, memberNames, soulsComposition } from '../../client/capability-rows.mjs';
import { createWorkspaceSync, syncCSS, reasonText } from './workspace-sync-view.mjs';
import { iconElement } from './shell-icons.mjs';
import { defaultsCSS } from './workspace-defaults.mjs';
import { aboutCSS, ABOUT_COPY, createAboutDialog } from './about-dialog.mjs';
import { createDataState, skeleton, statusLine, captureFocusState } from './loading.mjs';
import { warningOf } from '../../client/capability-warnings-contract.mjs';
import { createWarningsList, capabilityWarningsCSS } from './capability-warnings.mjs';
import { displayLine } from '../../client/display-text.mjs';
import { trackStickyTop, trackScrolledEdge } from './sticky-top.mjs';

export const workspaceTabs = ['souls', 'capabilities', 'teams', 'machines', 'sources'];
// What a person reads (the ids stay stable): Souls, Capabilities, Teams, Machines, Setup (product owner, 2026-10-26).
// Machines is the Deployments page of before (views/hierarchy.mjs): the instances on each machine. Teams is who can
// work together; Setup is what the workspace is built from (repos, packages, external souls). The page opens on Souls.
/** The tabs whose panel the Workspace view owns: this module shows and hides it, and paints nothing in it. */
const OWN_PANELS = ['machines', 'souls'];
const TAB_LABELS = { machines: 'Machines', teams: 'Teams', souls: 'Souls', capabilities: 'Capabilities', sources: 'Setup' };
/** The Workspace page's tab bar rules for a selector: plain-text tabs, the selected one at 650 over a 2px
 * --live underline. Shared with the Deployments page's tabs (deployments-page.mjs), so the two never drift. */
export const tabBarCSS = (sel) => `${sel} { display:flex; flex-wrap:nowrap; overflow-x:auto; gap:22px; min-width:0; scrollbar-width:none; }
/* Unselected tabs read like the sidebar's items (human, 2026-09-28): its ink and size, not muted grey. */
${sel} button { flex:none; display:inline-flex; align-items:center; gap:6px; padding:0; border:0; border-radius:0; background:none; color:var(--nav-fg); font-weight:500; font-size:13px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
${sel} button:hover { color:var(--fg); }
${sel} button[aria-selected=true] { color:var(--fg); font-weight:650; box-shadow:inset 0 -2px 0 var(--live); }
/* Keyboard focus: the tint gets a layout-neutral 6px inset so it does not hug the label. */
${sel} button:focus-visible { background:var(--sel); border-radius:6px; padding:0 6px; margin:0 -6px; }`;
export const discoveryCSS = `
${catalogCSS}
${defaultsCSS}
${aboutCSS}
${setupCSS}
${machinesCSS}
${computerTeamsCSS}
${syncCSS}
${capabilityWarningsCSS}
.workspace-header { height:var(--bar-h); min-height:48px; flex:none; display:flex; align-items:stretch; flex-wrap:nowrap; gap:22px; padding:0 calc(16px + var(--main-trail-inset, 0px)) 0 calc(16px + var(--main-lead-inset, 0px)); border-bottom:1px solid var(--border); background:var(--surface); box-sizing:border-box; }
.workspace-header[hidden] { display:none; }
.oats-view .workspace-header .field { min-height:28px; height:28px; padding:4px 8px; font-size:12px; }
${tabBarCSS('.workspace-tabs')}
.workspace-count { color:var(--muted); font-weight:normal; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); }
.workspace-count:empty { display:none; }
/* Visually hidden, announced; anchored at its containing block's origin so it can never stretch a scroller or the document (spec G). */
.workspace-sr-only { position:absolute; top:0; left:0; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
/* Setup or Teams needs attention (a problem to fix, not an instance's claim): a --danger dot, since yellow means needs
   input only (the product owner, 2026-10-26); its words are the tab's sr-only text. */
.workspace-attn { width:6px; height:6px; border-radius:50%; background:var(--danger); }
.workspace-attn[hidden] { display:none; }
.workspace-tools { display:flex; align-items:center; gap:10px; margin-left:auto; min-width:0; flex:none; }
.workspace-tools[hidden] { display:none; }
/* Segmented control (control rule 1, board 7): one 1px frame with 3px inner padding, 6px
   segments, no dividers. Selected = brand tint (--sel fill, --accent text, 650); unselected =
   transparent, --muted. Keyboard focus adds the tint under the global 1px accent edge.
   Geometry (human, 2026-09-29, "looks cropped"): 24px segments inside 3px padding make a 30px frame
   (32px with its 1px border), text centred at line-height 1, and flex:none so no bar squeezes it. */
.ws-segmented { display:inline-flex; align-items:center; box-sizing:content-box; height:24px; padding:3px; gap:2px; border:1px solid var(--border); border-radius:8px; background:var(--surface); flex:none; }
.oats-view .ws-segmented button { display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; min-height:0; height:24px; padding:0 10px; border:0; border-radius:6px; background:transparent; color:var(--muted); font-weight:500; font-size:12px; line-height:1; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .ws-segmented button:hover { color:var(--fg); }
.oats-view .ws-segmented button[aria-pressed=true] { background:var(--sel); color:var(--accent); font-weight:650; }
.oats-view .ws-segmented button:focus-visible { background:var(--sel); }
/* A view's own toolbar (human, 2026-09-26): its search and controls sit in the view, not in the header. */
/* A view's toolbar row (human, 2026-09-26): the view's own top row on the left
   (section pills, first group heading), the search and view controls on the right. */
.ws-toolbar { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:8px 10px; min-width:0; min-height:28px; margin:0 0 16px; }
.ws-toolbar[hidden] { display:none; }
.ws-toolbar-lead { flex:1 1 auto; min-width:0; display:flex; align-items:center; }
.ws-toolbar-lead .capability-nav { margin:0; }
.ws-toolbar-lead .capability-nav + .ws-info-button { margin-left:8px; }
.ws-toolbar-label { color:var(--muted); font-size:12px; }
.ws-search { position:relative; display:flex; align-items:center; min-width:0; flex:0 1 220px; }
.ws-search .shell-icon { position:absolute; left:10px; color:var(--muted); pointer-events:none; }
/* Search field (control rule 3): the input's own 1px border is the one frame, accent while focused, no ring. */
.oats-view .ws-search input.field { width:100%; min-width:0; height:28px; min-height:28px; padding:0 10px 0 30px; border:1px solid var(--border); border-radius:7px; background:var(--surface); font-size:12px; box-sizing:border-box; }
.oats-view .ws-search:focus-within input.field { border-color:var(--accent); outline:none; }
/* The tab's one content scroller (spec G): positioned, so its absolute descendants (the sr-only
   words, loading-sr) are clipped by it instead of stretching the document, which then scrolled the
   whole Workspace, header included, at the end of the content; its overscroll never chains out. */
.workspace-discovery { --ws-pad-top:18px; position:relative; padding:var(--ws-pad-top) 20px 18px; overflow:auto; overscroll-behavior:contain; min-width:0; min-height:0; flex:1; container-type:inline-size; }
/* Capabilities (W5) reads as one centred column. */
.workspace-discovery[data-tab=capabilities] { --ws-pad-top:16px; padding:var(--ws-pad-top) 28px 20px; }
.workspace-discovery[data-tab=capabilities] > * { max-width:1000px; margin-inline:auto; }
.workspace-discovery[data-tab=sources] { --ws-pad-top:20px; padding:var(--ws-pad-top) 24px 20px; }
/* Setup's list view reads as one centred column; the graph keeps the tab's width. */
.workspace-discovery[data-tab=sources]:has(.setup[data-view=list]) > * { max-width:1080px; margin-inline:auto; }
/* Teams reads as one centred column: the teams card is a list, not a dashboard. */
.workspace-discovery[data-tab=teams] { --ws-pad-top:20px; padding:var(--ws-pad-top) 24px 20px; }
.workspace-discovery[data-tab=teams] > * { max-width:760px; margin-inline:auto; }
.workspace-discovery[hidden], .souls-bar[hidden] { display:none; }
/* Sticky tops (spec G; sticky-top.mjs): a tab's top-level controls stay pinned while its content
   scrolls. Chromium insets a sticky box by the scroller's padding, so the block pins at -padding,
   flush with the scrollport, on the page's opaque --bg (cards never show through or above it); its
   8px inner top keeps the controls off the tab row. The bottom edge is always 1px, transparent until
   content has scrolled under the block (.is-stuck), so sticking never changes its height. */
.workspace-discovery .ws-sticky { position:sticky; top:calc(-1 * var(--ws-pad-top)); z-index:3; margin-top:-8px; padding-top:8px; background:var(--bg); border-bottom:1px solid transparent; }
.workspace-discovery .ws-sticky.is-stuck { border-bottom-color:var(--border); }
/* The Capabilities toolbar keeps its 16px below: 8px inside the edge, 7px + the 1px edge outside. */
.workspace-discovery > .ws-toolbar.ws-sticky { padding-bottom:8px; margin-bottom:7px; }
/* Jumping to a section or focusing a row never leaves it under the pinned block. */
.workspace-discovery :is(.capability-section-title, .catalog-group, [data-capability], .catalog-row, .ws-default-cell, .computer-teams .ct-body :is(button, a[href], input, select, textarea, [tabindex])) { scroll-margin-top:var(--ws-sticky-h, 60px); }
.discovery-status { margin:0 0 14px; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.discovery-status:empty { display:none; }
.discovery-status[hidden] { display:none; }
/* The catalog's loading states (desktop/loading-states item 6): the status line, the stale line, the
   skeleton / failed block host (only on the Capabilities tab), "Refreshing…" in the toolbar. */
.discovery-notice[hidden], .catalog-state[hidden] { display:none; }
.discovery-notice .loading-notice { margin:0 0 14px; }
.ws-toolbar .loading-refreshing { margin-right:auto; }
.catalog-state .capability-section-title.skeleton { height:15px; width:30%; margin:0 0 2px; }
.catalog-state .catalog-head .skeleton { height:9px; width:60%; }
.skeleton-catalog-row { pointer-events:none; }
.skeleton-catalog-row .catalog-tile.skeleton { background:color-mix(in srgb, var(--fg) 10%, transparent); }
.skeleton-catalog-row .catalog-cap { gap:6px; }
.skeleton-catalog-row .skeleton-name { height:13px; width:45%; }
.skeleton-catalog-row .skeleton-desc { height:11px; width:80%; }
.skeleton-catalog-row .skeleton-cell { height:11px; width:70%; }
.skeleton-catalog-row .skeleton-chevron { width:14px; height:14px; }
`;

const list = value => Array.isArray(value) ? value : [];
/** What on Setup needs attention, from workspace status only: members whose
 * handshake is not confirmed, a lock out of date, problems and warnings. */
export function setupAttention(status) {
  if (!status) return 0;
  return list(status.members).filter(member => member?.status !== 'confirmed').length
    + list(status.unsynced).length + list(status.stale).length + list(status.problems).length + list(status.warnings).filter(w => !teamWarning(w)).length;
}
/** A kernel workspace warning about a team label: said on the Teams tab, not Setup. */
const teamWarning = w => w?.code === 'unmapped-team-label';
/** The catalog row a warning's capability names (exact name), for Open capability; a name both a member and a
 * package carry is told apart by the warning's path (`<repoKey>:…` or `package:<id>:…`), else none. */
function warnedRow(rows, name, path) {
  const named = list(rows).filter(row => row?.name === name);
  if (named.length < 2) return named[0] || null;
  return named.find(row => typeof path === 'string' && path.startsWith(row.kind === 'package' ? `package:${row.package}:` : `${row.repoKey}:`)) || null;
}

/** Why the catalog cannot be read right now (probe facts only). */
function gate(workspace, deployment) {
  const cli = cliStatus();
  if (!cli) return cliKnownUnavailable() ? 'The installed OATS CLI is unavailable. Check it and retry.' : 'Checking for a compatible OATS CLI…';
  if (!cli.ok) return 'The installed OATS CLI is unavailable. Check it and retry.';
  if (cli.workspaceApi !== 2 || !list(cli.features).includes('workspace-v2')) return 'The installed OATS CLI does not advertise workspace-v2. Update OATS and retry.';
  if (!workspace) return 'Waiting for the current workspace…';
  if (workspace.remote || workspace.server) return 'Remote workspaces are observed through their server; open the deployment on that machine to sync it.';
  if (deployment?.status !== 'observed') return deploymentUnavailableText(deployment, DESKTOP_TERMS);
  return '';
}

/** A gate that will lift by itself (a probe or observation still running): the counts stay a pill. */
function gateTransient(workspace, deployment) {
  const cli = cliStatus();
  if (!cli) return !cliKnownUnavailable();
  if (!cli.ok || cli.workspaceApi !== 2 || !list(cli.features).includes('workspace-v2')) return false;
  if (!workspace) return true;
  if (workspace.remote || workspace.server) return false;
  return !deployment || deployment.status === 'pending';
}

/** Pending catalog: one section's worth of the real card rows (a disabled, aria-hidden button wears
 * the table's own classes, so workspace-catalog.mjs's CSS gives the height, frame and columns): the
 * card's four cells — tile | capability | used by | chevron — placed as the settled cards are, wide and narrow. */
function catalogSkeleton(doc, rows = 6) {
  const section = doc.createElement('div'); section.className = 'capability-section skeleton-item'; section.setAttribute('aria-hidden', 'true'); section.dataset.skeleton = 'catalog-rows';
  const bone = cls => { const el = doc.createElement('span'); el.className = `skeleton ${cls}`; el.setAttribute('aria-hidden', 'true'); return el; };
  section.append(bone('capability-section-title'));
  const table = doc.createElement('div'); table.className = 'catalog-table';
  const head = doc.createElement('div'); head.className = 'catalog-head'; head.append(doc.createElement('span'), bone('skeleton-cell'), bone('skeleton-cell'), doc.createElement('span')); table.append(head);
  for (let i = 0; i < rows; i++) {
    const row = doc.createElement('button'); row.type = 'button'; row.className = 'catalog-row skeleton-catalog-row'; row.disabled = true; row.tabIndex = -1; row.setAttribute('aria-hidden', 'true');
    const cap = doc.createElement('span'); cap.className = 'catalog-cap'; cap.append(bone('skeleton-name'), bone('skeleton-desc'));
    row.append(bone('catalog-tile'), cap, bone('skeleton-cell catalog-used'), bone('skeleton-chevron catalog-chevron'));
    table.append(row);
  }
  section.append(table);
  return section;
}

/** `onCatalog`: the catalog changed (a read settled, the subject was reset): a page rendered from it refreshes in place. */
export function createWorkspaceDiscovery(header, panel, { ctx, soulsPanel, machinesPanel = null, onTab, onIntent, onOpenCapability = null, onCatalog = null, onTeamMember = () => {}, onOpenTeam = null, rosterState = () => 'ready' }) {
  const doc = header.ownerDocument;
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  let alive = true, serial = 0, rosterGen = null, workspace = null, deployment = null, instances = [], tab = 'souls';
  // `repo`: the Workspace owned repository pill (a group key; null = All), remembered while the subject stays.
  let catalog = null, loading = false, failure = '', repo = null, rendered = null;
  let warningsDrawn = { signature: null, element: null }; // Sources' warnings list, kept while it is unchanged
  let setupView = 'list', query = '', setupMember = null, souls = [];
  // The Souls tab's count: a number, 'pending' (a pill reserving its width) or null (a failed roster read: nothing, still).
  let soulsCount = 'pending';
  // Team model v2 (kernel feature team-model-2): the Teams tab's "Teams on this computer", one card
  // per workspace generation, kept across renders so a half-typed form survives the status polls.
  let computerTeams = null, computerTeamsGen = null, teamProblems = 0;
  // The pinned toolbar / Teams head and its edge (sticky-top.mjs); the Souls bar sits outside its scroller.
  const stickyTop = trackStickyTop(panel), soulsEdge = trackScrolledEdge(soulsPanel);
  function teamsCard() {
    if (!teamModelOf(cliStatus()?.features) || !workspace?.id || workspace.remote || workspace.server) {
      // Another workspace generation without a Teams page: the old one goes (and a team page open on it closes).
      if (computerTeams && computerTeamsGen !== workspaceGeneration()) { computerTeams.dispose(); computerTeams = null; computerTeamsGen = null; }
      return null;
    }
    const gen = workspaceGeneration();
    if (computerTeams && computerTeamsGen === gen) return computerTeams.element;
    computerTeams?.dispose(); computerTeamsGen = gen; teamProblems = 0;
    computerTeams = createComputerTeams(doc, { readMembers: () => apiJson(ctx, `/api/team-members${wsQuery()}`), onMember: (action, member) => onTeamMember(action, member),
      // A card opens its team's page (views/spawn.mjs mode "team"), which this page then paints (showTeam).
      onOpenTeam: typeof onOpenTeam === 'function' ? label => onOpenTeam(label) : null,
      onDocument: teams => { teamProblems = list(teams?.problems).length; updateCounts(); }, request: async body => {
      return teamsAnswer(await postJson(ctx, `/api/workspace-teams${wsQuery()}`, body), 'teams', 'The teams on this computer could not be read.');
    } });
    return computerTeams.element;
  }
  // #517: the Setup tab's Machines box, one per workspace (and generation), kept across renders.
  let machines = null, machinesFor = null;
  function machinesCard() {
    if (!machinesGated(cliStatus()) || !workspace?.id) return null;
    const key = JSON.stringify([workspaceGeneration(), workspace.id]);
    if (machines && machinesFor === key) return machines.element;
    machines?.dispose(); machinesFor = key;
    const gen = workspaceGeneration();
    machines = createWorkspaceMachines(doc, { ctx, ws: workspace.id, owns: () => alive && workspaceGeneration() === gen });
    return machines.element;
  }
  header.className = 'workspace-header';
  // No title in the bar (human, 2026-09-28): the sidebar already says Workspace; the tabs lead.
  const tabs = node('div', undefined, 'workspace-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Workspace sections'); header.append(tabs);
  // #482: every Workspace tab reads the view's primary deployment, without naming it (the product owner, 2026-10-23).
  const controls = new Map(), counts = new Map();
  const attns = new Map();
  for (const name of workspaceTabs) {
    const control = node('button', TAB_LABELS[name]); control.type = 'button';
    control.id = `workspace-tab-${name}`; control.setAttribute('role', 'tab');
    const count = node('span', '', 'workspace-count'); control.append(count); counts.set(name, count);
    if (name === 'sources' || name === 'teams') {
      // Setup or Teams needs attention: a dot, and the same words for assistive tech.
      const dot = node('span', undefined, 'workspace-attn'); dot.hidden = true; dot.setAttribute('aria-hidden', 'true');
      const words = node('span', '', 'workspace-sr-only'); control.append(dot, words);
      attns.set(name, [dot, words]);
    }
    control.addEventListener('click', () => setTab(name));
    control.addEventListener('focus', () => revealTab(control));
    control.addEventListener('keydown', event => {
      const at = workspaceTabs.indexOf(name), n = workspaceTabs.length;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : event.key === 'ArrowRight' ? (at + 1) % n : event.key === 'ArrowLeft' ? (at + n - 1) % n : -1;
      if (index < 0) return;
      event.preventDefault(); setTab(workspaceTabs[index]); controls.get(workspaceTabs[index]).focus({ preventScroll: true });
    });
    controls.set(name, control); tabs.append(control);
  }
  // Attach first: the sync sheet mounts inside the view (.oats-view) so it
  // inherits the view's control styles and is removed with it.
  // Each tab's own controls sit at the right of the bar (Souls brings its own).
  const setupTools = node('div', undefined, 'workspace-tools'); setupTools.dataset.tools = 'sources';
  const views = node('div', undefined, 'ws-segmented'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Setup view');
  const viewButtons = new Map();
  for (const [id, label] of [['list', 'List'], ['graph', 'Graph']]) {
    const button = node('button', label); button.type = 'button'; button.dataset.setupView = id;
    button.addEventListener('click', () => { if (setupView === id) return; setupView = id; syncTools(); render(); });
    viewButtons.set(id, button); views.append(button);
  }
  const syncHost = node('div'); setupTools.append(views, syncHost);
  // The Capabilities search lives in the view itself (human, 2026-09-26): a toolbar row above the sections.
  const capTools = node('div', undefined, 'ws-toolbar ws-sticky'); capTools.dataset.tools = 'capabilities';
  const capLead = node('div', undefined, 'ws-toolbar-lead'); capTools.append(capLead);
  // "About capabilities": built once, in the toolbar's lead (the section jump is All capabilities' own now, under
  // its title: workspace-catalog.mjs), so a catalog repaint never rebuilds it under focus.
  const about = createAboutDialog(doc, { copy: ABOUT_COPY.capabilities, id: 'workspace-capabilities-about', onIntent: () => onIntent?.() });
  capLead.append(about.button);
  const search = node('label', undefined, 'ws-search');
  const searchInput = node('input', undefined, 'field'); searchInput.type = 'search'; searchInput.placeholder = 'Search capabilities'; searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Search capabilities');
  searchInput.addEventListener('input', () => { query = searchInput.value; render(); });
  search.append(iconElement(doc, 'search', { size: 14 }), searchInput); capTools.append(search);
  header.append(setupTools);
  // After a sync the table is re-read live; the held table stays on screen until the new one lands (never null while the deployment is the same).
  const sync = createWorkspaceSync(syncHost, { ctx, onSynced: () => { failure = ''; void load({ refresh: true }); } });
  function syncTools() {
    setupTools.hidden = tab !== 'sources'; capTools.hidden = tab !== 'capabilities';
    for (const [id, button] of viewButtons) button.setAttribute('aria-pressed', String(id === setupView));
  }
  soulsPanel.id = 'workspace-souls'; soulsPanel.setAttribute('role', 'tabpanel'); soulsPanel.setAttribute('aria-labelledby', 'workspace-tab-souls');
  if (machinesPanel) {
    machinesPanel.id = 'workspace-machines'; machinesPanel.setAttribute('role', 'tabpanel');
    machinesPanel.setAttribute('aria-labelledby', 'workspace-tab-machines');
  }
  const ownPanel = name => (name === 'souls' ? soulsPanel : name === 'machines' ? machinesPanel : null);
  panel.className = 'workspace-discovery'; panel.setAttribute('role', 'tabpanel'); panel.tabIndex = 0;
  // `status` says the gate (a CLI or deployment state, its own truthful copy); the catalog's loading
  // controller has its own line, stale-line host and skeleton / failed host, shown on Capabilities only.
  const status = node('p', '', 'discovery-status'); status.setAttribute('role', 'status');
  // The status line speaks only (like the sidebar's and the hierarchy's): the skeleton, the stale line and the
  // failed block are the visible states, and a visually hidden line leaves no empty box between the toolbar and them.
  const loadStatus = statusLine(doc, { visuallyHidden: true, className: 'discovery-load-status' });
  const notice = node('div', undefined, 'discovery-notice');
  const capState = node('div', undefined, 'catalog-state');
  const refreshHost = node('span', undefined, 'discovery-refreshing'); capTools.prepend(refreshHost);
  const notes = node('div', undefined, 'catalog-notes');
  const filterHost = node('div'), body = node('div');
  panel.append(capTools, status, loadStatus, notice, notes, filterHost, capState, body);
  const win = doc.defaultView;
  const loadState = createDataState({ doc, noun: 'capabilities', region: capState, skeleton: () => catalogSkeleton(doc), status: loadStatus,
    indicatorHost: refreshHost, noticeHost: notice, onRetry: () => { void load({ user: true, refresh: true }); },
    focusFallback: searchInput, // a focused Retry whose line or block leaves on success lands on the search field, never on <body>
    setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: id => win.clearTimeout(id) });

  const valid = (id, gen) => alive && serial === id && workspaceGeneration() === gen;
  function revealTab(control) {
    if (!alive || !control || !tabs.clientWidth) return;
    const left = tabs.getBoundingClientRect().left + tabs.clientLeft;
    const right = left + tabs.clientWidth, box = control.getBoundingClientRect();
    if (box.left < left || box.width > tabs.clientWidth) tabs.scrollLeft += box.left - left;
    else if (box.right > right) tabs.scrollLeft += box.right - right;
  }
  const observed = () => deployment?.status === 'observed' ? deployment.workspaceStatus || null : null;
  // A tab's count: the number, a pill reserving its width while the count is expected, nothing when it is not.
  function paintCount(name, value) {
    const el = counts.get(name);
    if (value === 'pending') { if (!el.querySelector('.skeleton-pill')) el.replaceChildren(skeleton(doc, 'pill', { width: '1.6em' })); return; }
    el.textContent = value === null ? '' : String(value);
  }
  function updateCounts(souls) {
    if (souls !== undefined) soulsCount = souls;
    paintCount('souls', soulsCount);
    // Capabilities: the table's count; a pill while it is being read (or a transient gate holds it); nothing after a failed read or a terminal gate.
    paintCount('capabilities', catalog ? catalog.capabilities.length : failure ? null : !gate(workspace, deployment) || gateTransient(workspace, deployment) ? 'pending' : null);
    const s = observed();
    // Setup and Teams carry no count: a dot says when something there needs attention.
    const teamsV2 = !!teamsCard();
    const needs = { sources: s ? setupAttention(s) : 0, teams: teamsV2 ? teamProblems : list(s?.warnings).filter(teamWarning).length };
    for (const [name, [dot, words]] of attns) { const n = needs[name]; dot.hidden = !n; words.textContent = n ? ` — ${n} ${n === 1 ? 'item needs' : 'items need'} attention` : ''; }
  }
  function syncHeader() {
    const s = observed();
    // Above the tested bound (#1879) a sync, which writes the lock, is held back (packages/client/above-tested.mjs).
    sync.update({ status: s, canSync: !gate(workspace, deployment) && !!s && cliHeldBack('POST /api/workspace-sync sync') === null });
  }
  function setTab(name) {
    if (!workspaceTabs.includes(name) || !alive) return false;
    const changed = name !== tab; tab = name;
    if (tab !== 'capabilities') about.close({ focus: 'none' }); // leaving the tab closes its dialog, moving no focus
    panel.id = `workspace-${OWN_PANELS.includes(name) ? 'capabilities' : name}`; panel.dataset.tab = name;
    panel.setAttribute('aria-labelledby', `workspace-tab-${name}`);
    for (const [key, control] of controls) {
      control.setAttribute('aria-selected', String(key === tab)); control.tabIndex = key === tab ? 0 : -1;
      control.setAttribute('aria-controls', ownPanel(key)?.id ?? panel.id);
    }
    soulsPanel.hidden = tab !== 'souls'; if (machinesPanel) machinesPanel.hidden = tab !== 'machines';
    panel.hidden = OWN_PANELS.includes(tab); syncTools();
    if (changed) { onIntent?.(); onTab?.(tab); }
    render(); if (tab === 'capabilities' && !catalog && !loading && !failure) void load();
    revealTab(controls.get(tab));
    return true;
  }
  /** Read the catalog. `user`: a Retry (its completion is announced); `refresh`: bypass the server's
   * held observation (Retry, and after a sync). The held table stays through the read: a failure
   * marks it stale (the line above, with the cause and Retry) and a success replaces it in place. */
  async function load({ user = false, refresh = false } = {}) {
    if (!alive || loading) return;
    const id = ++serial, gen = workspaceGeneration();
    if (rosterGen !== gen || gate(workspace, deployment)) { render(); return; }
    // `failure` (the last cause) stays until the read settles: a page's stale line keeps its Details while its Retry runs.
    loading = true; loadState.begin({ user }); updateCounts(); render(); onCatalog?.(); // a page's Retry wears the busy mark
    let result;
    try { result = await postJson(ctx, `/api/workspace-sync${wsQuery()}`, { action: 'read', ...(refresh ? { refresh: true } : {}) }); }
    catch (error) { result = { status: 'unavailable', reason: { code: 'E_CLI_FAILED', message: error?.message || 'Reading the workspace capabilities failed.' } }; }
    if (!valid(id, gen)) return;
    loading = false;
    // spec 02 (additive, optional): `observedAt`; a failed re-read may still hand back the last good table
    // (`status: 'ok'` with `reason`, or non-ok with `lastGood: { capabilities, observedAt }`): shown, marked stale.
    const ok = result?.status === 'ok' && !!result.capabilities;
    const held = ok ? result.capabilities : result?.lastGood?.capabilities || null;
    const at = ok ? result.observedAt : result?.lastGood?.observedAt;
    const observedAt = typeof at === 'string' ? at : null;
    const reason = result?.reason || null;
    if (held) catalog = held;
    if (ok && !reason) { failure = ''; loadState.succeed({ observedAt, empty: !catalog.capabilities.length }); }
    else {
      failure = reasonText(reason) || 'The workspace capabilities could not be read.';
      // A held table arriving with the failure is data: taken once (succeed) when nothing was shown yet; with a
      // table on screen only fail() runs, updating the stale line in place (its Retry keeps focus, one announcement).
      if (held && !loadState.hasData) loadState.succeed({ observedAt });
      loadState.fail({ message: typeof reason?.message === 'string' && reason.message ? reason.message : 'The workspace capabilities could not be read.', code: typeof reason?.code === 'string' ? reason.code : null }, { observedAt });
    }
    updateCounts(); render(); onCatalog?.();
  }
  function render() { paint(); stickyTop.sync(); soulsEdge.sync(); }
  function paint() {
    syncHeader();
    const unavailable = gate(workspace, deployment);
    const s = observed();
    // The gate's copy is its own truthful state (CLI, deployment); it is never a skeleton. The catalog's
    // loading line, stale line and skeleton / failed host show on the Capabilities tab only.
    status.textContent = unavailable;
    const catalogTab = tab === 'capabilities' && !unavailable;
    loadStatus.hidden = notice.hidden = capState.hidden = !catalogTab;
    refreshHost.hidden = !catalogTab;
    // Identical polls never rebuild a settled projection under focus/selection.
    // (Not `loading` or `failure`: the controller paints those beside the projection, which must not rebuild for them.)
    // The status's observation stamp moves on every poll and nothing here paints it: it is left out.
    const stableStatus = s && { ...s, workspace: s.workspace && { ...s.workspace, observedAt: undefined } };
    // The souls' composition (souls-capabilities) and marks feed "Used by".
    const key = JSON.stringify([tab, setupView, setupMember, souls.map(a => [a?.team ?? null, a?.name, a?.key, a?.color, a?.agentsRoot, a?.capabilities]), soulsComposition(cliStatus()), query, unavailable, repo, catalog, stableStatus, rosterState(), deployment?.withheld, deployment?.reachable, privateListed(), instances.map(i => [i.agent, i.agentsRoot, i.modules, i.running])]);
    if (key === rendered) return;
    rendered = key;
    // A focused pill is rebuilt below: focus returns to the same repository's pill (by its key).
    const focusedPill = filterHost.contains(doc.activeElement) ? doc.activeElement.closest('.catalog-pills button')?.dataset.repo ?? null : null;
    const restoreNotes = captureFocusState(notes, { scroller: null }); // a warning's Details or Open capability (by its focus key)
    // A Workspace defaults column or chip (its data-focus-key) is found again after the sections are rebuilt.
    const restoreBody = tab === 'capabilities' ? captureFocusState(body, { scroller: null }) : null;
    notes.replaceChildren(); filterHost.replaceChildren(); body.replaceChildren(); filterHost.className = '';
    for (const child of [...capLead.children]) if (child !== about.button) child.remove(); // the "i" stays, focus and all
    if (unavailable || OWN_PANELS.includes(tab)) return; // the view paints its own panels
    for (const note of deploymentNotes(deployment)) notes.append(node('p', note.text, `catalog-note${note.warn ? ' warn' : ''}`));
    if (tab === 'teams') {
      // Team model v2: this computer's teams (the kernel's `oats teams`), editable here. A workspace
      // on another computer keeps its teams there. Before v2: the labels the workspace declares.
      const card = teamsCard();
      if (card) body.append(card);
      else if (teamModelOf(cliStatus()?.features)) body.append(node('p', "Teams are set on the computer that runs this workspace.", 'catalog-note'));
      else {
        for (const warning of list(s?.warnings)) if (teamWarning(warning) && typeof warning.message === 'string' && warning.message && !list(s?.workspace?.teams).includes(warning.label)) notes.append(node('p', warning.message, 'catalog-note warn'));
        body.append(teamsBox(doc, { status: s, souls }));
      }
      return;
    }
    if (tab === 'sources') {
      // The kernel's workspace warnings, through the one warnings list (capability-warnings.mjs); a team's
      // warning is said on the Teams tab. A remedy (0.30 automation-untrusted: the oats-local.yaml line to add)
      // is a muted line under its message. Open capability once the catalog lists the warning's capability.
      // Each warning keeps its own catalog row: two warnings may name two capabilities of one name (another member, a
      // package), each told apart by its path.
      const remedies = new Map(), opens = new Map();
      const shown = list(s?.warnings).flatMap(raw => {
        const w = teamWarning(raw) ? null : warningOf(raw); if (!w) return [];
        remedies.set(w, displayLine(raw.remedy));
        const row = w.capability && catalog ? warnedRow(catalog.capabilities, w.capability, w.path) : null;
        if (row) opens.set(w, row);
        return [w];
      });
      // An unchanged list is the same element (a roster poll repaints the tab): its open Details stay open.
      const signature = JSON.stringify(shown.map(w => [w, remedies.get(w), opens.has(w) ? [opens.get(w).kind, opens.get(w).repoKey ?? opens.get(w).package ?? null] : null]));
      if (signature !== warningsDrawn.signature) warningsDrawn = { signature, element: createWarningsList(doc, shown, { showCapability: true, focusKey: 'ws-warning', after: w => remedies.get(w) ?? null,
        // Open capability takes the catalog row as it is when pressed: an unchanged list outlives the render that drew it.
        canOpen: (name, w) => opens.has(w), open: typeof onOpenCapability === 'function' ? (name, w) => { const row = catalog ? warnedRow(catalog.capabilities, name, w.path) : null; if (row) onOpenCapability(row); } : null }) };
      const warned = warningsDrawn.element;
      if (warned) { notes.append(warned); restoreNotes(); }
      renderSetup(body, { status: s, instances, souls, cli: cliStatus(), view: setupView, selected: setupMember,
        onSelect: key => selectMember(key), onOpenRepo: openRepo, onOpenPackages: openPackages, openExternal: url => ctx.openExternal?.(url), machines: machinesCard() }); return;
    }
    if (!catalog) return; // pending, or failed with nothing held: the controller's skeleton or failed block stands in capState
    for (const problem of list(catalog.problems)) notes.append(node('p', reasonText(problem), 'catalog-note warn'));
    const names = memberNames(s), hostKey = hostKeyOf(s);
    const sections = capabilitySections(catalog.capabilities);
    const repos = repoChoices(sections.workspace, names, hostKey);
    // A remembered repository the catalog no longer offers falls back to All.
    if (repo && !repos.some(choice => choice.key === repo)) repo = null;
    const shown = filterCapabilities(sections.workspace, { repo }, names, hostKey);
    renderRepoPills(filterHost, { repos, value: repo, total: sections.workspace.length, shown: matchCapabilities(shown, query).length,
      narrowed: !!repo || !!String(query || '').trim(), onChange: next => { repo = next; render(); refocusPill(repo ?? ''); } });
    renderCapabilitySections(body, { sections, shown, filterHost, privateListed: privateListed(), query,
      status: s, instances, souls, composition: soulsComposition(cliStatus()), root: workspace?.id, rosterState: rosterState(), onOpen: onOpenCapability });
    restoreBody?.();
    if (focusedPill !== null) refocusPill(focusedPill);
    reveal();
  }
  // Repo owned is shown only when the kernel lists private capabilities.
  const privateListed = () => list(cliStatus()?.features).includes('capabilities-private');
  // Setup: a member's membership opens in the graph's Member panel; focus follows it.
  function selectMember(key) {
    setupMember = key || null;
    if (setupMember && setupView !== 'graph') { setupView = 'graph'; syncTools(); }
    render();
    const target = setupMember ? body.querySelector('.setup-panel .icon-act') : body.querySelector('.setup-node[aria-pressed]');
    target?.focus({ preventScroll: false });
  }
  // Setup → Capabilities: a repository's capabilities (filtered), or the Packages section.
  let pendingReveal = null;
  function openRepo(key) {
    pendingReveal = { repo: `member:${key}` }; repo = `member:${key}`;
    if (!setTab('capabilities')) pendingReveal = null;
  }
  function openPackages() {
    pendingReveal = { section: 'packages' };
    if (!setTab('capabilities')) pendingReveal = null;
  }
  function reveal() {
    if (!pendingReveal) return;
    const want = pendingReveal; pendingReveal = null;
    let target = null;
    if (want.section) target = body.querySelector(`#capability-section-${want.section}`);
    else if (repo === want.repo) target = body.querySelector('#capability-section-workspace');
    else target = [...body.querySelectorAll('.catalog-group')].find(el => el.dataset.repo === want.repo) || body.querySelector('#capability-section-workspace');
    if (!target) return;
    target.tabIndex = -1; target.scrollIntoView?.({ block: 'start' }); target.focus({ preventScroll: true });
  }
  // The pill row is rebuilt on a change or a repaint; focus stays on the same repository's pill
  // ('' = All), which becomes the group's tab stop. A pill no longer offered leaves focus to the pressed one.
  function refocusPill(key) {
    const pills = filterHost.querySelector('.catalog-pills'); if (!pills) return;
    const buttons = [...pills.querySelectorAll('button')];
    const target = buttons.find(button => button.dataset.repo === key) || buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    if (!target) return;
    rovePill(pills, target); target.focus({ preventScroll: true });
  }
  panel.addEventListener('scroll', () => { if (tab === 'capabilities') syncCapabilityNav(body, panel, capLead); }, { passive: true });
  function updateRoster(agents, panelAnswer) {
    const gen = workspaceGeneration();
    // Another workspace generation is another subject: the table is forgotten. Within one, it is never set to null.
    if (rosterGen !== gen) { catalog = null; failure = ''; repo = null; setupMember = null; serial++; loading = false; loadState.reset(); about.close({ focus: 'none' }); }
    rosterGen = gen; workspace = panelAnswer.workspace || null; deployment = panelAnswer.deployment || null; souls = list(agents);
    instances = list(panelAnswer.instances);
    updateCounts(agents.length); render();
    computerTeams?.syncRoster(); // the Teams page's members follow the roster poll
    // Read once per roster generation on any tab: the tab bar counts it.
    if (!catalog && !loading && !failure) void load();
    // The catalog's age line (when the observation is old) follows the roster poll.
    loadState.touch();
  }
  /** The CLI probe settled or flipped: re-read. A held table stays (refreshing), it is not thrown away. */
  function syncCli() {
    failure = ''; serial++; if (loading) { loading = false; loadState.cancel(); } updateCounts(); render();
    void load();
  }
  updateCounts(); setTab('souls');
  return {
    setTab, updateRoster, syncCli, get tab() { return tab; },
    /** A team's page, painted by the Teams page into `host` (computer-teams.mjs showTeam): false when there is no such team. */
    openTeam: (host, label, options) => !!teamsCard() && computerTeams.showTeam(host, label, options),
    closeTeam() { computerTeams?.hideTeam(); },
    /** What the capability table renders with (observed facts only), for pages that reuse it. */
    context: () => ({ status: observed(), instances, souls, composition: soulsComposition(cliStatus()), root: workspace?.id, remote: !!(workspace?.remote || workspace?.server), rosterState: rosterState(), catalog: catalog?.capabilities ?? null,
      // The catalog's loading state for pages rendered from it (item 7): its state, observation and the last failure's text.
      catalogState: loadState.state, catalogSettled: loadState.settled, catalogBusy: loadState.busy, catalogObservedAt: loadState.observedAt, catalogFailure: failure || null }),
    /** A page's Retry: re-read the catalog live (announced on completion). */
    reload() { void load({ user: true, refresh: true }); },
    /** The host roster's state changed without new rows (a failed poll): roster-derived cells follow (behind the render key). */
    syncRoster() { render(); },
    /** The host's roster read failed with nothing to show: the Souls count is nothing, still (not a pill). */
    rosterUnavailable() { if (soulsCount === 'pending') updateCounts(null); },
    reset() {
      machines?.dispose(); machines = null; machinesFor = null; // another workspace: its dialog and reads go with it
      about.close({ focus: 'none' });
      serial++; rosterGen = null; workspace = null; deployment = null; instances = []; catalog = null; loading = false; failure = '';
      repo = null; sync.reset(); loadState.reset(); updateCounts('pending'); render(); onCatalog?.();
    },
    dispose() { alive = false; serial++; about.dispose(); sync.dispose(); computerTeams?.dispose(); machines?.dispose(); loadState.dispose(); stickyTop.dispose(); soulsEdge.dispose(); },
  };
}
