/* OATS Desktop — Workspace discovery (legacy stage id: spawn).
   Souls are the deployment's spawn catalog (`oats souls`); Launch explicitly
   opens the Spawn dialog (renderer/spawn-dialog.mjs), whose defaults and
   decisions are the kernel's spawn preview. Resolution stays CLI-owned.
   Contract: mount(el, ctx) / unmount(). Plain ES module + DOM. */
import { createSoulInspector, inspectorCSS } from "../soul-inspector.mjs";
import { createWorkspaceDiscovery, discoveryCSS, workspaceTabs } from "../workspace-discovery.mjs";
import { capabilityRow } from "../workspace-catalog.mjs";
import { renderCapabilityPage, capabilityPageCSS, pageCardCSS, soulCapabilitiesCSS, catalogNotice, catalogNoticeKind, updateCatalogNotice } from "../capability-page.mjs";
import { sameRepo } from "../../../client/repo-moves.mjs";
import { spawnRefusal, cantSpawnLine, soulMatches, desktopFacts, soulFacts } from "../../../client/soul-facts.mjs";
import { soulKind, compareSouls, SOUL_KIND_WORDS } from "../../../client/soul-kind.mjs";
import { createCapabilityContents, capabilityContentsCSS } from "../capability-contents.mjs";
import { sourceQuoteCSS } from "../source-quote.mjs";
import { sourceText } from "../source-chip.mjs";
import { memberNames } from "../../../client/capability-rows.mjs";
import { soulInstructionsCSS } from "../soul-instructions.mjs";
import { capabilitySelector, sameSelector } from "../../../client/capability-show-contract.mjs";
import { MARKDOWN_CSS } from "./markdown.mjs";
import { deploymentUnavailableText } from "../../../client/deployment-facts.mjs";
import { DESKTOP_TERMS, DESKTOP_NOUNS } from "../desktop-terms.mjs";
import { createSpawnDialog, spawnDialogCSS } from "../spawn-dialog.mjs";
import { SPAWN_DIALOG_KEYS, SPAWN_JUMPS, registerSpawnDialogKeys, ariaKeyShortcuts } from "../spawn-dialog-keys.mjs";
import { pendingPlacement } from "../spawn-jobs.mjs";
import { spawnProblem, catalogProblem, soulCatalogFailure } from "../../../client/spawn-messages.mjs";
import { spawnText } from "../spawn-words.mjs";
import { identityCSS } from "../identity-marks.mjs";
import { shownLaunch, launchHarnessName } from "../../../client/launch-view.mjs";
import { harnessOf } from "../../../client/harness-names.mjs";
import { memberState } from "../workspace-catalog.mjs";
import { iconElement } from "../shell-icons.mjs";
import { groupHeading, groupHeadingCSS } from "../group-heading.mjs";
import {
  apiJson, postJson, ensureTheme,
  currentWorkspace, switchWorkspace, onWorkspaceChange, wsQuery, workspaceGeneration,
} from "./common.mjs";
import { registerAction, getBinding, formatChord, onKeymapChange, keymapTakes } from "../keybindings.mjs";
import { resolveViewKey } from "../view-keys.mjs";
import { cliAvailable, cliKnownUnavailable, cliStatus, refreshCli, onCliChange, cliCard, cliAboveTested, aboveTestedCard } from "./cli-status.mjs";
import { preselectSchedule } from "./schedules.mjs";
import { preselectAutomationsTab } from "./automations.mjs";
import { mount as mountMachines, unmount as unmountMachines } from "./hierarchy.mjs";
import { inspectSupported } from "../../../client/inspect-contract.mjs";
import { createDataState, skeleton, statusLine, captureFocusState } from "../loading.mjs";
import { canAddressRemote } from "../../../client/remote-address.mjs";
import { instanceActionTarget } from "../instance-action-target.mjs";
import { namingOf } from "../../../client/spawn-preview-contract.mjs";
import { numberedLine } from "../../../client/spawn-naming.mjs";

/** True while the CLI probe has never SETTLED (no response classified yet).
 * Pending is card-less by design, so disabled buttons must explain
 * themselves — and the poll must keep retrying until a response lands. */
const cliProbePending = () => !cliStatus() && !cliKnownUnavailable();

const CSS = `
/* One fixed-height column that can never scroll (spec G): the header and toolbars sit outside the
   content scrollers (.souls-grid, .workspace-discovery), and anything positioned that escapes one is
   contained here (position + overflow:clip), never in the document, so the headers cannot leave the view. */
.souls { position:relative; overflow:clip; display: flex; flex-direction: column; height: 100%; min-height: 0; min-width:0; background: var(--bg); }
/* Workspace v4.1 (board 3): the view's own toolbar row — search on the left, Group by
   on the right; every group header opens its own section below it. */
.souls-bar { flex:none; margin:0 0 8px; padding:10px 20px 0; }
.souls-bar .souls-group-title { padding:0 2px; }
.souls-bar .ws-segmented { margin-left:2px; }
.workspace-header .wssel { max-width:100%; min-width:0; flex:0 1 140px; }
.souls-sum { color:var(--muted); font-size:12px; }
/* The grid's stale line (desktop/loading-states) sits between the toolbar and the scroller; nothing when empty. */
.souls-notice { flex:none; padding:0 20px; }
.souls-lede { flex:none; margin:0 0 12px; padding:0 20px; max-width:80ch; color:var(--muted); font-size:12.5px; line-height:1.45; }
.souls-lede[hidden] { display:none; }
.souls-notice:empty, .souls-notice[hidden] { display:none; }
.souls-notice .loading-notice { margin:0 0 10px; }
.souls-bar .loading-refreshing { margin-left:auto; }
.workspace-recovery { flex:none; min-width:0; padding:18px 20px; }
.workspace-recovery[hidden] { display:none; }
/* Counts are already in the Souls tab. Keep the full filter/CLI status for
   assistive tech, without another permanent row above the canvas. */
/* Visually hidden, announced; anchored at its containing block's origin so it can never stretch a scroller or the document (spec G). */
.workspace-sr-only { position:absolute; top:0; left:0; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.souls-bar .souls-bar-lead { flex:1 1 auto; }
/* Souls (the Desktop UI rework, slice 3a): grouped by where a soul comes from (the workspace's repository,
   then each package), each group in kind order (packages/client/soul-kind.mjs), as cards or as a table
   (v, or the toolbar's Grid | Table). Souls of a member that has not joined are listed apart, with the reason. */
.souls-grid { position:relative; flex:1; min-height:0; min-width:0; overflow-y:auto; overscroll-behavior:contain; padding:0 20px 16px; display:flex; flex-direction:column; gap:14px; border-top:1px solid transparent; }
/* The bar above is outside this scroller, so it never moves; once cards scroll under it, a 1px edge (spec G, sticky-top.mjs). */
.souls-grid.is-scrolled { border-top-color:var(--border); }
.souls-group { display:flex; flex-direction:column; gap:12px; min-width:0; }
.souls-group + .souls-group { padding-top:12px; }
/* The group heading (icon, monospace name, muted qualifier) is group-heading.mjs's, shared with Capabilities. */
${groupHeadingCSS}
.souls-group-cards { display:grid; gap:12px; grid-template-columns:repeat(auto-fill, minmax(min(240px, 100%), 1fr)); align-content:start; }
/* A card: the name, what it does (two lines at most; the soul's page has the whole text), then its agents and kind. */
.soul-card { display:flex; flex-direction:column; gap:6px; min-width:0; padding:14px 16px; box-sizing:border-box; background:var(--surface); border:1px solid var(--border); border-radius:10px;
             cursor:pointer; text-align:left; font:inherit; color:var(--fg); }
.oats-view .souls button.soul-card { height:auto; min-height:0; font-weight:400; line-height:normal; }
.soul-card:hover { border-color:var(--sel-border); }
.soul-card.open { border-color:var(--sel-border); box-shadow:0 0 0 1px var(--sel-border); }
.soul-card.unavailable { cursor:default; }
.soul-card .stitle { font-size:13.5px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.soul-card.unavailable .stitle { color:var(--muted); }
.soul-card .sdesc { margin:0; color:var(--fg); font-size:12.5px; line-height:1.45; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow-wrap:anywhere; }
.soul-card .sdesc:empty { display:none; }
.soul-card .sfoot { display:flex; align-items:center; gap:0; min-width:0; margin-top:auto; padding-top:4px; color:var(--muted); font-size:12px; line-height:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.soul-card .sactivity { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.soul-card .sactivity.running { color:var(--fg); font-weight:600; }
.soul-card .sactivity.running::before { content:""; display:inline-block; width:7px; height:7px; margin-right:6px; border-radius:50%; background:var(--live); vertical-align:1px; }
.soul-card .skind { flex:none; margin-left:.35em; }
.soul-card .sproblem { min-width:0; color:var(--warn); font-weight:600; overflow:hidden; text-overflow:ellipsis; }
/* The table: the same souls as rows, the same groups as heading rows. The name is the row's one button. */
.souls-table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:12.5px; color:var(--fg); }
.souls-table th, .souls-table td { padding:7px 10px; text-align:left; vertical-align:top; border-bottom:1px solid var(--border); overflow:hidden; text-overflow:ellipsis; }
.souls-table thead th { position:sticky; top:0; z-index:1; background:var(--bg); color:var(--muted); font-size:11.5px; font-weight:600; }
.souls-table col.c-name { width:22%; } .souls-table col.c-kind { width:10%; } .souls-table col.c-agents { width:9%; }
.souls-table col.c-launch { width:17%; } .souls-table col.c-ready { width:14%; }
.souls-table tbody th.souls-table-group { padding-top:16px; border-bottom:0; color:var(--fg); font-weight:400; }
.souls-table tbody th.souls-table-group .souls-group-title { padding:0; }
.souls-table tbody tr.soul-row:hover td { background:var(--surface); }
.souls-table td.what { color:var(--fg); white-space:normal; overflow-wrap:anywhere; }
.souls-table td.muted, .souls-table td .muted { color:var(--muted); }
.souls-table td.problem { color:var(--warn); font-weight:600; white-space:normal; overflow-wrap:anywhere; }
/* Two lines at most: the full sentence is the cell's title and the soul's page. */
.souls-table td.problem .clamp { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.oats-view .souls .souls-table button.soul-row-open { display:block; max-width:100%; height:auto; min-height:0; margin:0; padding:0; border:0; background:none; color:var(--fg); font:inherit; font-weight:650; text-align:left;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.oats-view .souls .souls-table button.soul-row-open:hover { text-decoration:underline; }
.souls-table tr.open td { background:var(--sel); }
.souls-table tr.unavailable td { color:var(--muted); }
.oats-view .souls button.spawn-act:not(:disabled), .oats-view .souls button.fspawn:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); }
.souls-grid[hidden] { display:none; }
/* The Machines tab (the Deployments page of before, views/hierarchy.mjs): its view fills the panel, as it filled the page. */
.workspace-machines-panel { flex:1; min-height:0; min-width:0; display:flex; flex-direction:column; }
.workspace-machines-panel[hidden] { display:none; }
.spawn-modal { position: fixed; z-index: 100; inset: 0; display: grid; place-items: center; padding: 24px; background: var(--scrim); }
.spawn-dialog { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
.spawn-dialog-head { display: flex; }
.spawn-dialog-head h2 { margin: 0; line-height: 1.3; }
.spawn-dialog .close-act { width: 28px; height: 28px; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
.spawn-dialog .close-act:hover { background: var(--surface-2); color: var(--fg); }
`;

let state = null;

/** The Souls page's first line: what a soul is, and how the page is ordered (it replaces "About souls"). */
export const SOULS_LEDE = `A soul is what an ${DESKTOP_NOUNS.instance} is made of: its instructions, its skills and capabilities, and the knowledge it keeps. `
  + "Grouped by where each comes from; maintainers first, then experts, developers and operations.";

/* Quick Open selects a soul for inspection; launch remains explicit. */
let pendingPreselect = null;
let pendingHome = null;
let pendingCapability = null;
let pendingWorkspaceTab = null;
// Selection handoffs compete with each other, NOT with the roster request
// that supplies their data. Explicit tabs (including reselecting Souls) win
// over any older soul/home waiting for that roster.
let selectionIntent = 0;
function nextSelectionIntent() {
  // A newer choice in an already-mounted Workspace must also supersede a
  // shell handoff still waiting on its module to load: a Workspace tab opened
  // from outside the page (⌘1 on Machines, ⌘N on Souls, the palette; Quick Open;
  // a roster row's Inspect). Shell handoffs check their ticket before
  // entering here; never mint a fresh ticket on behalf of an arrival that
  // has already lost foreground ownership.
  if (state?.alive) state.ctx.onSelectionIntent?.();
  return { intent: ++selectionIntent, gen: workspaceGeneration() };
}
function ownsSelection(s, ref) {
  return s.alive && ref.gen === workspaceGeneration() && ref.intent === selectionIntent;
}
/** The shell's navigation to a Workspace tab (⌘1 on Machines, app.chooseSoul's chord on Souls, the leader's 3
 * on Capabilities, the palette's) is an inspection intent, never a launch. */
export function preselectWorkspaceTab(name) {
  if (!workspaceTabs.includes(name)) return false;
  pendingWorkspaceTab = { name, ...nextSelectionIntent() };
  if (state?.alive) applyWorkspaceTab(state);
  return true;
}
/** The Workspace page's tab while it is mounted (the shell's surface, surface-return.mjs), else null. */
export function currentWorkspaceTab() {
  return state?.alive ? state.discovery?.tab ?? null : null;
}
function applyWorkspaceTab(s) {
  if (!pendingWorkspaceTab) return;
  const intent = pendingWorkspaceTab; pendingWorkspaceTab = null;
  if (!ownsSelection(s, intent)) return;
  // The handoff's own tab change is not a newer choice: minting one here would supersede the soul or home
  // this same handoff carries (Go to soul from the Machines tab turned the page and opened nothing).
  s.handoffTab = true;
  try { s.discovery?.setTab(intent.name); } finally { s.handoffTab = false; }
}
export function preselectHome(instance) {
  const intent = nextSelectionIntent();
  pendingWorkspaceTab = { name: "souls", ...intent };
  pendingHome = { home: instance.home, server: instance.server, ...intent };
  if (state?.alive) { applyWorkspaceTab(state); applyHome(state); }
}
function applyHome(s) {
  if (!pendingHome) return;
  if (!ownsSelection(s, pendingHome)) { pendingHome = null; return; }
  if (s.rosterGen !== workspaceGeneration()) return;
  const candidates = s.panelInstances.filter(i => i.home === pendingHome.home && (i.server || "") === (pendingHome.server || ""));
  const instance = candidates.length === 1 ? candidates[0] : null;
  pendingHome = null;
  if (instance) s.inspector?.show({ instance, selector: { home: instance.home } });
}
function inspectSoul(s, agent, intent = nextSelectionIntent()) {
  if (!ownsSelection(s, intent)) return;
  s.discovery?.setTab("souls");
  s.inspectRef = { name: agent.name, agentsRoot: agent.agentsRoot, server: agent.server };
  renderGrid(s);
  // A soul opens as a full page in the Workspace view; instances keep the sidebar.
  showPage(s, "soul");
  s.page?.show({ agent, selector: { soul: agent.name, agentsRoot: agent.agentsRoot } });
  // The card that opened it is now covered: focus moves into the page (its back control).
  const back = s.q("workspace-soul-page")?.querySelector(".inspector-back");
  if (canFocusCard(s, back)) back.focus({ preventScroll: true });
}

/** `ref`: `{ name, agentsRoot?, server?, key?, repoKey?, onMiss? }`. A `key` (the kernel's soul key) and a `repoKey`
 * (the soul source's) narrow the match to that exact soul: the Deployments page's Go to soul hands both. A keyed
 * soul whose bare name another soul of its root shares is not opened: its page is inspected by name and root, which
 * inspect-boundary.mjs refuses for a shared name. `onMiss(count, { sharedName })` says so. */
export function preselectSoul(ref) {
  const intent = nextSelectionIntent();
  pendingWorkspaceTab = { name: "souls", ...intent };
  pendingPreselect = ref && ref.name
    ? { name: String(ref.name), agentsRoot: ref.agentsRoot, server: ref.server,
      ...(typeof ref.key === "string" ? { key: ref.key } : {}), ...(typeof ref.repoKey === "string" ? { repoKey: ref.repoKey } : {}),
      onMiss: typeof ref.onMiss === 'function' ? ref.onMiss : null, ...intent }
    : null;
  // Already mounted with a current roster: apply on the spot, including an
  // empty roster (a no-match is consumed once, never resurrected by polling).
  if (state?.alive) { applyWorkspaceTab(state); applyPreselect(state); }
}

/** Quick Open (spec F): open the spawn dialog scoped to this soul, exactly as its card's Spawn does.
 * A soul that can't be spawned here (attached only, refused, no verified CLI) opens its page
 * instead, which says why. The Workspace subtab is left alone when the dialog opens: it is a
 * modal over wherever Workspace was. `onDismiss` runs when the operator dismisses the dialog
 * (Cancel, Esc, ×, backdrop); it returns true when it took focus back to where they were, and
 * false to let the dialog restore focus itself. */
export function preselectSpawn(ref) {
  const intent = nextSelectionIntent();
  pendingPreselect = ref && ref.name
    ? { name: String(ref.name), agentsRoot: ref.agentsRoot, server: ref.server, spawn: true,
      onMiss: typeof ref.onMiss === 'function' ? ref.onMiss : null, onDismiss: typeof ref.onDismiss === 'function' ? ref.onDismiss : null,
      // Reopen spawn (Spec C): the draft a failed background spawn kept, restored into the dialog.
      draft: ref.draft && typeof ref.draft === 'object' ? ref.draft : null, ...intent }
    : null;
  if (state?.alive) applyPreselect(state);
}

function applyPreselect(s) {
  if (!pendingPreselect) return;
  // A workspace switch OR newer selection supersedes this handoff.
  if (!ownsSelection(s, pendingPreselect)) { pendingPreselect = null; return; }
  // stale roster: s.souls still holds a previous workspace's agents while
  // the current refresh is pending — do NOT consume; the refresh that
  // paints the current workspace's roster calls back here (review 6d5e183)
  if (s.rosterGen !== workspaceGeneration()) return;
  const ref = pendingPreselect;
  pendingPreselect = null; // consumed-once, match or not
  const matches = s.souls.agents.filter((x) => x.name === ref.name
    && (!ref.agentsRoot || x.agentsRoot === ref.agentsRoot) && (!ref.server || x.server === ref.server)
    && (ref.key === undefined || x.key === ref.key) && (ref.repoKey === undefined || sameRepo(x.soulSource?.repoKey, ref.repoKey)));
  // an incomplete identity must not pick a twin; the caller says why nothing opened
  if (matches.length !== 1) { ref.onMiss?.(matches.length); return; }
  const a = matches[0];
  if (ref.key !== undefined && s.souls.agents.filter((x) => x.name === a.name && x.agentsRoot === a.agentsRoot && (x.server || "") === (a.server || "")).length > 1) {
    ref.onMiss?.(matches.length, { sharedName: a.name }); return;
  }
  if (ref.spawn && canLaunchSoul(s, a)) {
    openSpawnModal(s, a, ref.draft || {});
    if (s.modalEl) s.spawnReturn = ref.onDismiss;
    return;
  }
  inspectSoul(s, a, ref);
  // Degraded / attached souls still open their page; its actions and
  // diagnostic status explain availability, and inspectSoul moved focus into it.
  // An active filter may exclude the soul's card: clear it, so that going back
  // returns to a visible card (review 6d5e183 — a consumed preselect must never
  // be a silent no-op for a soul that exists).
  const card = [...(s.q("souls-grid").querySelectorAll?.("[data-agent]") || [])].find((c) => cardMatches(c, a));
  if (!card && s.filterText) {
    s.filterText = "";
    const filterEl = s.q("filter");
    if (filterEl) filterEl.value = "";
    renderGrid(s);
  }
}

/** Open the page of the workspace's capability of this name, on the Capabilities subtab, as its table row
 * does: an inspection intent, never a launch. Held until the Workspace view is mounted and the capabilities
 * catalog of the current workspace has been read (at once when both already are), consumed once, and
 * superseded by a workspace switch or a newer selection. The name must be exactly ONE catalog row's: with
 * none or several nothing opens and `onMiss(count)` says so. */
export function preselectCapability(name, { onMiss } = {}) {
  const intent = nextSelectionIntent();
  pendingCapability = typeof name === "string" && name ? { name, onMiss: typeof onMiss === "function" ? onMiss : null, ...intent } : null;
  if (state?.alive) applyCapability(state);
}
function applyCapability(s) {
  const ref = pendingCapability; if (!ref || !s.discovery) return;
  // A workspace switch OR newer selection supersedes this handoff.
  if (!ownsSelection(s, ref)) { pendingCapability = null; return; }
  if (s.discovery.tab !== "capabilities") {
    // Its tab, before the catalog lands. The change is this handoff's own, yet the discovery mints an intent for
    // every tab change (and may call back here as the catalog read begins): the handoff adopts that intent, so it
    // is not superseded by itself.
    s.discovery.setTab("capabilities");
    pendingCapability = { ...ref, intent: selectionIntent };
  }
  const { catalog } = s.discovery.context();
  // Not read yet (the discovery forgets another workspace's table): the read that lands calls back here (onCatalog).
  if (!Array.isArray(catalog)) return;
  pendingCapability = null; // consumed-once, match or not
  // A bare name must not pick between a member's capability and a package's of the same name.
  const matches = catalog.filter(row => row?.name === ref.name);
  if (matches.length !== 1) { ref.onMiss?.(matches.length); return; }
  openCapability(s, matches[0], null);
}

/** What a soul page's capability row says besides its name: "by <source>" (the source chip's words: a package, a
 * member repository by its name) and the one line of the catalog's row of that name, when exactly one is listed. No
 * row is "official" yet (slice 3b's rule), so every row says where it comes from. */
function soulCapabilityFacts(s, cap) {
  const { catalog, status } = s.discovery?.context() ?? {};
  const row = capabilityRow(cap);
  const listed = Array.isArray(catalog) ? catalog.filter(r => r?.name === row.name) : [];
  const description = listed.length === 1 && typeof listed[0].description === "string" && listed[0].description ? listed[0].description : null;
  return { by: sourceText(row, memberNames(status)).name || null, description };
}

/** A page (a soul's, a capability's or a team's) replaces the list it was opened from
 * while it is open: mode null | "soul" | "capability" | "team". */
function showPage(s, mode) {
  const soulPage = s.q("workspace-soul-page"), capPage = s.q("workspace-cap-page"), teamPage = s.q("workspace-team-page");
  if (!soulPage || !capPage || !teamPage) return;
  soulPage.hidden = mode !== "soul"; capPage.hidden = mode !== "capability"; teamPage.hidden = mode !== "team";
  // Workspace v4: a page's own bar replaces the Workspace header while it is open.
  s.q("workspace-header").hidden = !!mode;
  const souls = (s.discovery?.tab ?? "souls") === "souls";
  s.q("souls-grid").hidden = !!mode || !souls;
  s.q("souls-bar").hidden = !!mode || !souls;
  s.q("souls-notice").hidden = !!mode || !souls; // the grid's stale line belongs to the grid
  s.q("souls-lede").hidden = !!mode || !souls;
  const machines = s.discovery?.tab === "machines";
  s.q("workspace-machines-panel").hidden = !!mode || !machines;
  s.q("workspace-discovery").hidden = !!mode || souls || machines;
}
/** The Machines tab's view (views/hierarchy.mjs, the Deployments page of before): mounted while the tab is shown and
 * unmounted when another tab is chosen or the view leaves, so it reads nothing in the background. */
function syncMachines(s) {
  const shown = s.alive && s.discovery?.tab === "machines";
  // Its "Workspace" (s, Go to soul's page) is this page: the Souls tab, not a stage switch to the page already shown.
  // Already on Souls (Go to soul's handoff turned the page and opened the soul), it does nothing: setTab would show
  // the grid again under the soul's page.
  const ctx = { ...s.ctx, openView: name => (name !== "spawn" ? s.ctx.openView?.(name)
    : s.discovery.tab === "souls" ? true : s.discovery.setTab("souls")) };
  if (shown && !s.machines) { s.machines = true; mountMachines(s.q("workspace-machines-panel"), ctx); }
  else if (!shown && s.machines) { s.machines = false; unmountMachines(); s.q("workspace-machines-panel").replaceChildren(); }
}
/** A team's page, from its card on the Teams board (packages/desktop/docs/desktop-teams.md "A team's page"). The
 * Teams page paints it (computer-teams.mjs showTeam) and keeps it current; Back and Esc return to the board, at its
 * scroll offset, on that team's card. A team that leaves the document (removed, or another workspace) closes it. */
function openTeam(s, label) {
  if (!s.alive) return;
  // An explicit choice: it supersedes any older selection still waiting (a shell handoff on its import, a preselect).
  nextSelectionIntent();
  // The board is hidden (display:none) while the page is open, which drops its scroll offset: keep it for Back.
  const list = s.q("workspace-discovery"), host = s.q("workspace-team-page");
  const scrollTop = list?.scrollTop ?? null;
  const opened = s.discovery.openTeam(host, label, {
    onBack: () => closeTeam(s, { restoreFocus: true }),
    onGone: () => { if (s.alive && s.teamOpen?.label === label) closeTeam(s, { gone: true }); },
  });
  if (!opened) return;
  s.teamOpen = { label, scrollTop };
  showPage(s, "team");
  host.querySelector(".page-back")?.focus({ preventScroll: true });
}
function closeTeam(s, { restoreFocus = false, gone = false } = {}) {
  const open = s.teamOpen; s.teamOpen = null;
  if (!open) return;
  s.discovery?.closeTeam();
  const host = s.q("workspace-team-page"), doc = s.el.ownerDocument;
  const focused = !!host && (host.contains(doc.activeElement) || doc.activeElement === doc.body);
  host?.replaceChildren();
  showPage(s, null);
  const list = s.q("workspace-discovery");
  if (list && Number.isFinite(open.scrollTop)) list.scrollTop = open.scrollTop;
  // Its team is gone: there is no card to return to, so the Teams tab takes the focus the page held.
  if (gone) { if (focused) s.el.querySelector("#workspace-tab-teams")?.focus(); return; }
  if (!restoreFocus) return;
  // The card is already in view at the restored offset: focus its name without scrolling again.
  [...(list?.querySelectorAll(".ct-card[data-team] .ct-open") || [])].find(b => b.closest(".ct-card").dataset.team === open.label)?.focus({ preventScroll: true });
}
/** A capability's page, from the Capabilities table (from = null) or a soul page (from = the soul; `why`:
 * the soul page's entry for it, which the page's "Why" row says). */
function openCapability(s, row, from = null, why = null) {
  if (!s.alive) return;
  // The list is hidden (display:none) while the page is open, which drops its scroll offset: keep it for Back.
  const list = s.q("workspace-discovery");
  s.capOpen?.contents.dispose();
  // Contents (spec C): one controller per open page, bound to this workspace (a switch closes the page).
  const query = wsQuery();
  const contents = createCapabilityContents(s.el.ownerDocument, {
    request: body => postJson(s.ctx, `/api/capabilities${query}`, body),
    openExternal: url => s.ctx.openExternal?.(url),
    // The kernel no longer knows it, or it moved since the catalog was read: re-read the catalog, the page follows.
    onCatalogStale: () => { if (s.alive && s.capOpen?.contents === contents) s.discovery.reload(); },
    // Its Trigger sources row appeared or left: the Provides card is rebuilt around it (the signature below holds it).
    onProvidesChange: () => { if (s.alive && s.capOpen?.contents === contents) paintCapabilityPage(s); },
  });
  // Back returns focus to the control that opened it: a keyed one (a Workspace defaults column or chip) by its key,
  // which outlives a repaint and is never filtered out; a catalog row by its capability's name (closeCapability).
  const active = s.el.ownerDocument.activeElement;
  const openerKey = !from && list?.contains(active) ? active.dataset?.focusKey || null : null;
  s.capOpen = { row, from, why: from ? why : null, gen: workspaceGeneration(), scrollTop: from ? null : list?.scrollTop ?? null, signature: null, contents, openerKey };
  paintCapabilityPage(s);
  showPage(s, "capability");
  s.q("workspace-cap-page").querySelector(".page-back")?.focus({ preventScroll: true });
}
/** The open capability page from the catalog as it is now (desktop/loading-states item 7). From a soul
 * page before the catalog is read, the catalog's facts are skeletons filled in place when it lands;
 * when the catalog refreshes while the page is open, the page follows, in place (focus kept by key). */
function paintCapabilityPage(s) {
  const open = s.capOpen; if (!open) return;
  const { row, from, why } = open;
  const { catalog, catalogState, catalogSettled, catalogBusy, catalogObservedAt, catalogFailure, ...context } = s.discovery.context();
  // From a soul page, the catalog's row for the same capability adds what the kernel reports
  // about it in the workspace (#217: description, what it provides, its file and fingerprint).
  const listed = from && Array.isArray(catalog) ? catalog.filter(r => r.name === row.name) : [];
  const facts = listed.length === 1 ? listed[0] : null;
  // Pending: the catalog was never read (a Retry over a failed read is the failed block's business, not skeletons).
  const catalogPending = !!from && !Array.isArray(catalog) && (catalogState === "pending" || catalogState === "idle") && catalogSettled === "idle";
  // The catalog's row as it is NOW (contentsRow): the page's facts and its Contents both come from it, so a refresh
  // that moves the commit moves the whole page together — never one commit's provenance beside another's contents.
  // Catalog form: that row (the opened one while no catalog is held, or after it left the catalog: Contents says so);
  // from a soul: the soul's resolved row over it.
  const current = contentsRow(row, from, catalog, facts);
  const shown = from ? (current && current !== row ? { ...current, ...row } : row) : current || row;
  // The page itself follows the catalog's content; its age line (below) follows the controller's state, on its own.
  // "Used by" reads the souls' composition (souls-capabilities) and marks, or the roster's module rows.
  // Whether the Contents controller's Trigger sources row has content decides the Provides card's shape (what the row says does not).
  const signature = JSON.stringify([current === row ? null : current, catalogPending, context.instances, context.root, context.rosterState, context.composition,
    context.composition ? context.souls.map(a => [a.name, a.key, a.color, a.agentsRoot, a.soulKind, a.package, a.capabilities]) : null,
    open.contents.triggerSources.childElementCount > 0]);
  const host = s.q("workspace-cap-page");
  if (signature !== open.signature) { // an unchanged catalog never rebuilds the page under focus
    open.signature = signature; open.noticeSignature = null;
    const restore = captureFocusState(host, { fallback: () => host.querySelector(".page-back") }), keep = open.contents.hold();
    renderCapabilityPage(host, { row: shown, ...context, catalogPending, contents: open.contents.element, triggerSources: open.contents.triggerSources,
      openExternal: url => s.ctx.openExternal?.(url),
      backLabel: from ? from.name : "Capabilities", from: from ? { label: from.name, why } : null,
      onBack: () => closeCapability(s, { restoreFocus: true }),
      openSoul: target => {
        // A soul row (Used by from the composition) carries its key: a package soul never opens a member soul of its bare name.
        const matches = s.souls.agents.filter(a => a.name === target.name && a.agentsRoot === target.agentsRoot && (target.key === undefined || a.key === target.key));
        if (matches.length !== 1) return;
        closeCapability(s); inspectSoul(s, matches[0]);
      } });
    restore(); keep();
  }
  // Its subject is the CURRENT catalog row (the selector and commit `capabilities show` reads at): a refresh that
  // moves the commit re-reads; unchanged → nothing.
  open.contents.update({ row: current, cli: cliStatus(), remote: context.remote === true, catalogPending, deployment: context.root ?? null });
  paintCapabilityNotice(s, { state: catalogState, settled: catalogSettled, busy: catalogBusy, observedAt: catalogObservedAt, cause: catalogFailure });
}
/** The catalog row the page's Contents reads (spec C), from the catalog as it is NOW: the opened row (a catalog row,
 * or a soul's resolved one, which names the same member or package) matched by its full selector, else, from a
 * soul page, the catalog's one row of that name. The opened row while no catalog is held (catalog form); null when
 * the catalog no longer lists it (Contents says so). An external capability has no selector: its own gate line. */
export function contentsRow(row, from, catalog, facts = null) {
  if (row?.kind === "external") return row;
  if (!Array.isArray(catalog)) return from ? null : row;
  const wanted = capabilitySelector(row);
  // A package default the catalog did not list when it was opened names no package (workspace-defaults.mjs defaultRow):
  // once listed, it is its one package row of that name. A row with a full selector keeps full-selector matching.
  const unresolved = !wanted && row?.kind === "package" && !row.package;
  const matches = wanted ? catalog.filter(r => sameSelector(capabilitySelector(r), wanted))
    : unresolved ? catalog.filter(r => r?.kind === "package" && r.name === row.name) : [];
  return matches.length === 1 ? matches[0] : from ? facts : null;
}
/** The page's age line mirrors the catalog controller (stale with Retry, or an old observation): the same
 * node is updated in place — its Retry keeps focus and wears the busy mark while the re-read runs — and
 * the age ticks with the roster poll (`touchCapabilityPage`). */
function paintCapabilityNotice(s, observation) {
  const open = s.capOpen, host = s.q("workspace-cap-page")?.querySelector(".page-notice"); if (!open || !host) return;
  const doc = host.ownerDocument, now = Date.now();
  const kind = catalogNoticeKind(observation, now);
  const full = { ...observation, onRetry: () => s.discovery.reload() };
  let notice = host.querySelector(".loading-notice, .loading-failed"); // the stale / observed line, or the failed block
  if (notice && notice.dataset.kind !== kind) {
    // The line leaves (or changes kind): a focused Retry hands focus to Back, never to nowhere.
    if (notice.contains(doc.activeElement)) s.q("workspace-cap-page").querySelector(".page-back")?.focus({ preventScroll: true });
    notice.remove(); notice = null;
  }
  if (!kind) return;
  if (!notice) { notice = catalogNotice(doc, full, now); if (notice) host.append(notice); }
  else updateCatalogNotice(notice, full, now);
}
/** The catalog changed (a read settled, a reset): the open page follows it; another generation's page closes. */
function syncCapabilityPage(s) {
  if (!s.alive || !s.capOpen) return;
  if (s.capOpen.gen !== workspaceGeneration()) { closeCapability(s); return; }
  paintCapabilityPage(s);
}
const focusable = el => el.isConnected && !el.disabled && (el.matches("button, a[href], input, select, textarea") || el.tabIndex >= 0);
function closeCapability(s, { restoreFocus = false } = {}) {
  const open = s.capOpen; s.capOpen = null;
  open?.contents.dispose();
  const host = s.q("workspace-cap-page"); if (host) host.replaceChildren();
  if (!open) return;
  // Back to where it was opened: the soul's page (still shown) or the Capabilities table.
  const backToSoul = !!open.from && !!s.inspectRef && s.inspectRef.name === open.from.name && s.inspectRef.agentsRoot === open.from.agentsRoot;
  showPage(s, backToSoul ? "soul" : null);
  // Back to the list where it was: its scroll offset (filters and search live in the discovery's state).
  const list = s.q("workspace-discovery");
  if (!backToSoul && list && Number.isFinite(open.scrollTop) && open.gen === workspaceGeneration()) list.scrollTop = open.scrollTop;
  if (!restoreFocus) return;
  const scope = backToSoul ? s.q("workspace-soul-page") : list;
  // The row is already in view at the restored offset: focus without scrolling it again.
  const preventScroll = !backToSoul && Number.isFinite(open.scrollTop);
  const keyed = !backToSoul && open.openerKey ? [...(scope?.querySelectorAll("[data-focus-key]") || [])].find(el => el.dataset.focusKey === open.openerKey && focusable(el)) : null;
  // Else the capability's row: a focusable one first (a listed name may also be a plain line).
  const named = [...(scope?.querySelectorAll("[data-capability]") || [])].filter(el => el.dataset.capability === open.row.name);
  const target = keyed || named.find(focusable) || named[0];
  target?.focus({ preventScroll });
  // The opener is gone (filtered out, or left the catalog): the list itself, never <body>.
  if (!backToSoul && scope && !scope.contains(s.el.ownerDocument.activeElement)) scope.focus({ preventScroll: true });
}

export function mount(el, ctx) {
  ensureTheme(el.ownerDocument);
  // ctx.spawnTiming (optional, harness only): { previewDelay, busyDelay, suggestDelay, wait } — never set by the shell.
  const s = state = { el, ctx, souls: { agents: [] }, panelInstances: [], filterText: "", view: rememberedSoulsView(currentWorkspace()), sel: null, timers: [], unsubWs: null, alive: true, spawnOp: 0, rosterReq: 0, rosterGen: null,
    waitOpts: ctx.spawnTiming?.wait };
  el.innerHTML = `
    <div class="oats-view" style="display:block">
      <style>${CSS}
${inspectorCSS}
${pageCardCSS}
${capabilityPageCSS}
${sourceQuoteCSS}
${capabilityContentsCSS}
${soulInstructionsCSS}
${MARKDOWN_CSS}
${soulCapabilitiesCSS}
${discoveryCSS}
${identityCSS}
${spawnDialogCSS}</style>
      <div class="souls">
        <div class="souls-body">
          <section class="workspace-main" aria-label="Workspace discovery">
            <header class="workspace-header"></header>
            <select class="field wssel" aria-label="Workspace" style="display:none"></select>
            <div class="workspace-recovery" hidden></div>
            <div class="souls-bar ws-toolbar">
              <label class="ws-search"><span class="workspace-sr-only">Search souls</span><input class="field filter" type="search" placeholder="Search souls" autocomplete="off"></label>
              <div class="ws-toolbar-lead souls-bar-lead"></div>
              <div class="ws-segmented souls-view" role="group" aria-label="Show souls as"><button type="button" data-view="grid" aria-pressed="true" aria-keyshortcuts="V" title="Grid (V)">Grid</button><button type="button" data-view="table" aria-pressed="false" aria-keyshortcuts="V" title="Table (V)">Table</button></div>
              <span class="souls-sum workspace-sr-only" role="status"></span>
            </div>
            <p class="souls-lede">${SOULS_LEDE}</p>
            <div class="souls-notice"></div>
            <div class="souls-grid"></div>
            <div class="workspace-machines-panel" hidden></div>
            <section class="workspace-discovery" hidden></section>
            <section id="workspace-soul-page" class="workspace-page workspace-soul-page" aria-label="Soul details" hidden></section>
            <section class="workspace-page workspace-cap-page" aria-label="Capability details" hidden></section>
            <section class="workspace-page workspace-team-page" aria-label="Team details" hidden></section>
          </section>
          <aside id="workspace-inspector" class="soul-inspector" aria-label="Instance details" hidden></aside>
        </div>
      </div>
    </div>`;
  s.q = (cls) => el.querySelector("." + cls);
  // The grid's loading state (desktop/loading-states item 5): pending paints card skeletons in the
  // grid after 150ms, a failed first read its cause with Retry, a failed poll the stale line above
  // the grid; the cards stay. The status line is a live region (the toolbar has no room for text).
  {
    const doc = el.ownerDocument, win = doc.defaultView;
    s.gridStatus = statusLine(doc, { visuallyHidden: true, className: "souls-status" });
    s.q("souls-bar").append(s.gridStatus);
    s.gridState = createDataState({ doc, noun: "souls", region: s.q("souls-grid"), skeleton: () => gridSkeleton(s), status: s.gridStatus,
      indicatorHost: s.q("souls-bar-lead"), noticeHost: s.q("souls-notice"), onRetry: () => { if (s.alive) void refresh(s, { user: true }); },
      focusFallback: () => s.q("filter"), // a focused Retry whose line or block leaves on success lands on the search field, never on <body>
      setTimeout: (fn, ms) => win.setTimeout(fn, ms), clearTimeout: (id) => win.clearTimeout(id) });
  }
  // Move the actual node, never a copied projection: Workspace still owns all
  // requests, callbacks and unsaved form state. The optional shell host owns
  // presentation only and supplies an .oats-view wrapper for shared styles.
  const inspectorElement = s.q("soul-inspector");
  s.presentation = ctx.rightPanel?.attach(inspectorElement);
  s.presentation?.setPresent(false); // no selected content at mount
  const inspectorOptions = {
    ctx, launch: agent => { if (cliAvailable()) openSpawnModal(s, agent); },
    openSoul: ref => {
      const matches = s.souls.agents.filter(x => x.name === ref.name && x.agentsRoot === ref.agentsRoot && (x.server || null) === (ref.server || null));
      if (matches.length !== 1) return false;
      inspectSoul(s, matches[0]); return true;
    },
    canLaunch: agent => canLaunchSoul(s, agent),
    spawnRefusal: agent => spawnRefusal(agent, cliStatus()),
    launchReason: agent => spawnRefusal(agent, cliStatus()) ? `Can't spawn here: ${spawnRefusal(agent, cliStatus())}` : cliProbePending() ? "Checking for a compatible oats CLI — spawning enables once it is verified" : "Requires a compatible installed OATS CLI and a current standalone soul.",
    available: () => cliAvailable() && inspectSupported(cliStatus()),
    files: agent => s.ctx.openBrain?.(agent.name),
    canFiles: agent => canOpenFiles(s, agent),
    instances: agent => soulInstances(s, agent), workspace: () => s.workspace,
    // The roster the instances come from: pending / failed / stale is not "No instances yet." — and a re-read over a stale
    // roster is still stale (the settled state, the catalogNoticeKind rule), not a good read.
    instancesState: () => rosterSettledState(s),

    schedule: agent => { if (canLaunchSoul(s, agent)) { preselectSchedule(agent); preselectAutomationsTab("schedule"); ctx.openView?.("automations"); } },
  };
  // Instances: the right-panel sidebar (it sits beside a running terminal).
  s.inspector = createSoulInspector(inspectorElement, { ...inspectorOptions, presentation: s.presentation,
    // A capability warning's Open capability (readiness): the capability's page, as the Capabilities table opens it
    // (Back returns to the list; the sidebar's subject is not a soul page to return to).
    openCapability: cap => openCapability(s, capabilityRow(cap)) });
  // Souls: a full page in the Workspace view, "← Souls" back to the grid.
  s.page = createSoulInspector(s.q("workspace-soul-page"), {
    ...inspectorOptions, layout: "page", backLabel: "Souls",
    openInstance: instance => s.inspector.show({ instance, selector: { home: instance.home } }),
    // A capability row's "by <source>" and one line (the catalog's description of the one row of that name).
    capabilityFacts: cap => soulCapabilityFacts(s, cap),
    // A row opens the capability's page; a capability of the soul's own repository keeps that mark there.
    openCapability: (cap, soul, entry) => openCapability(s, { ...capabilityRow(cap), ...(entry?.repoOwned ? { private: true } : {}) }, soul, entry),
    closed: ({ restoreFocus } = {}) => {
      const ref = s.inspectRef; s.inspectRef = null;
      if (!s.alive) return;
      showPage(s, null);
      renderGrid(s, { restoreFocus: false });
      // The grid is rebuilt by polling; return to composite identity only on
      // explicit standalone close, never during reset or a hidden-stage close.
      const card = restoreFocus && ref && gridCards(s).find(card => cardMatches(card, ref));
      if (canFocusCard(s, card)) { rove(card, true); card.focus(); }
    },
  });
  s.discovery = createWorkspaceDiscovery(s.q("workspace-header"), s.q("workspace-discovery"), {
    ctx, soulsPanel: s.q("souls-grid"), machinesPanel: s.q("workspace-machines-panel"), onIntent: () => { if (!s.handoffTab) nextSelectionIntent(); },
    // A catalog read settled (or began, or was reset): the open page follows, and a capability handoff waiting for it opens.
    onCatalog: () => { syncCapabilityPage(s); applyCapability(s); s.page?.syncCatalog(); },
    rosterState: () => rosterSettledState(s), // "Used by" claims are roster-derived: none while the roster is not settled-good
    onOpenCapability: row => openCapability(s, row, null),
    onTeamMember: (action, member) => void teamMemberAction(s, action, member),
    onOpenTeam: label => openTeam(s, label),
    onTab: tab => {
      s.spawnOp++; closeSpawnModal(s); s.inspector.close(); closeCapability(s); closeTeam(s); s.page.close();
      s.q("souls-bar").hidden = tab !== "souls"; s.q("souls-notice").hidden = tab !== "souls"; s.q("souls-lede").hidden = tab !== "souls";
      syncMachines(s);
    },
  });
  // Capture actual tab choices before discovery projects them. Its onTab
  // callback runs only for CHANGES; clicking Souls or pressing Home while
  // already there is still a newer explicit intent. Programmatic projection
  // from an owned preselect must not mint a competing intent of its own.
  const tabs = s.q("workspace-tabs");
  tabs.addEventListener("click", event => {
    if (s.alive && event.target.closest?.('[role="tab"]')) nextSelectionIntent();
  }, true);
  tabs.addEventListener("keydown", event => {
    if (s.alive && event.target.closest?.('[role="tab"]') && ["Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key)) nextSelectionIntent();
  }, true);
  s.q("workspace-header").append(s.q("wssel")); // standalone switcher stays reachable on every subtab
  applyWorkspaceTab(s);
  // The page opens on Souls unless a handoff chose another tab: then the Souls bar and its notice wait for Souls, and
  // on Machines its view mounts (onTab runs on changes only).
  if (s.discovery.tab !== "souls") { s.q("souls-bar").hidden = true; s.q("souls-notice").hidden = true; s.q("souls-lede").hidden = true; }
  syncMachines(s);
  applyCapability(s); // a handoff made before the mount: its tab now, its page when the catalog lands
  s.q("filter").addEventListener("input", (e) => { s.filterText = e.target.value; renderGrid(s); });
  s.q("filter").before(iconElement(el.ownerDocument, "search", { size: 14 }));
  // Grid | Table (v): the souls as cards or as rows, remembered per view (rememberSoulsView).
  for (const button of s.q("souls-view").querySelectorAll("button")) button.addEventListener("click", () => setSoulsView(s, button.dataset.view));
  syncViewSwitch(s);
  // Esc on a page goes back (never from a text field, a disclosure's summary, or the spawn modal).
  const pageEscape = (event, back) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.target.closest?.(".spawn-modal")) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) || event.target.isContentEditable) return;
    event.preventDefault(); back();
  };
  s.q("workspace-soul-page").addEventListener("keydown", e => pageEscape(e, () => s.page.close({ restoreFocus: true })));
  s.q("workspace-cap-page").addEventListener("keydown", e => pageEscape(e, () => closeCapability(s, { restoreFocus: true })));
  s.q("workspace-team-page").addEventListener("keydown", e => pageEscape(e, () => closeTeam(s, { restoreFocus: true })));
  // Keyboard operability (task: keybindings wiring): `/` focuses the filter,
  // arrows rove the card grid, Enter inspects the focused soul,
  // b opens its brain, Esc cancels an open form. spawn.filter/spawn.brain
  // are registered stage:spawn actions; their keys resolve through the
  // engine keymap (view-keys.mjs) so editor rebinds take effect, while
  // dispatch stays view-local and editable-guarded.
  s.q("souls-grid").addEventListener("keydown", (e) => onGridKey(s, e));
  s.viewActions = [
    { id: "spawn.filter", defaultChord: "/", run: () => s.q("filter").focus() },
    { id: "spawn.brain", defaultChord: "B", run: () => brainOfFocusedCard(s) },
    { id: "spawn.view", defaultChord: "V", run: () => setSoulsView(s, s.view === "table" ? "grid" : "table", { keepFocus: true }) },
  ];
  const viewRoot = el.querySelector(".souls");
  viewRoot.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    // Esc cancels the open spawn form from anywhere inside it (incl. the
    // task textarea — cancel is safe; submit stays click/button-only there).
    if (e.key === "Escape" && s.sel) { e.preventDefault(); s.sel = null; s.selAgent = null; renderGrid(s); return; }
    // view-local keys (never stolen from editable fields), engine-resolved.
    // The MODAL owns all its keys (selects/buttons are interactive controls
    // outside any .soul-card — review 96b037b): '/' from the relation
    // selector must not focus the filter behind the open dialog, and 'B'
    // must not open a card's Brain underneath it.
    const editable = e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable;
    // A page open over the grid (a soul's, a capability's) has its own keys: v never turns the hidden grid under it.
    if (s.discovery.tab !== "souls" || editable || e.target.closest?.(".soul-inspector") || e.target.closest?.(".workspace-page") || e.target.closest?.(".soul-item") || e.target.closest?.(".spawn-modal")) return; // card keys are onGridKey's
    const hit = resolveViewKey(e, s.viewActions);
    if (hit) { e.preventDefault(); s.viewActions.find((a) => a.id === hit)?.run(); }
  });
  // Context "view:spawn" is never activated by the shell (review afd2114):
  // editor-visible + conflict-checked, but window-dispatch-ineligible —
  // matchEvent skips these before preventDefault, so outside keypresses
  // are not swallowed and colliding globals still run; dispatch is local.
  s.disposers = [
    registerAction({ id: "spawn.filter", label: "Souls: focus the filter", context: "view:spawn", defaultChord: "/", run: () => s.q("filter").focus() }),
    registerAction({ id: "spawn.brain", label: "Souls: open files of focused card", context: "view:spawn", defaultChord: "B", run: () => brainOfFocusedCard(s) }),
    registerAction({ id: "spawn.view", label: "Souls: show as a grid or a table", context: "view:spawn", defaultChord: "V", run: () => setSoulsView(s, s.view === "table" ? "grid" : "table", { keepFocus: true }) }),
  ];
  // CLI degradation: refresh once on mount and re-render the grid whenever
  // availability flips — spawn buttons disable consistently with the card.
  refreshCli(ctx);
  s.unsubCli = onCliChange(() => {
    if (!s.alive) return;
    renderGrid(s);
    s.discovery.syncCli();
    s.inspector.syncAvailability(); s.page.syncAvailability();
    // an open modal tracks capability live — disabled state + version note
    // resync without touching typed fields (review 5526b70)
    s.syncModalRelations?.();
  });
  // Main binds the switch first; a workspace another window shows moves here (a take-over, as a pick from the list does).
  s.q("wssel").addEventListener("change", (e) => { void switchWorkspace(e.target.value, { takeOver: true }).then((r) => { if (!r.ok) e.target.value = currentWorkspace(); }); });
  s.unsubWs = onWorkspaceChange(() => {
    // Workspace switch owns the whole surface: invalidate any A spawn modal
    // immediately, remove its DOM before B loads, and clear A's agentsRoot.
    s.spawnOp++;
    s.rosterReq++; s.rosterGen = null; s.souls = { agents: [] }; s.panelInstances = []; s.spawnDeployments = []; s.spawnViews = [];
    s.discovery.reset();
    // The grid or table this view was left in (rememberSoulsView).
    s.view = rememberedSoulsView(currentWorkspace()); syncViewSwitch(s);
    s.inspector.close(); closeCapability(s); closeTeam(s, { gone: true }); s.page.close();
    closeSpawnModal(s, { repaint: false }); // the switch replaces the grid below
    // Another workspace's cards leave at once; the new one is pending (a skeleton after 150ms, never a text block nor an empty message).
    s.gridState.reset(); s.gridSignature = null; s.q("souls-grid").replaceChildren();
    // No force flag: if a newer B poll paints a B spawn modal before this
    // request resolves, the late switch refresh must respect that owner.
    refresh(s);
  });
  refresh(s);
  s.timers.push(setInterval(() => {
    refresh(s);
    // A boot-time transport failure leaves the CLI probe UNSETTLED (null
    // state, no card) — without a retry the Spawn buttons stay dead forever
    // with nothing on screen saying why. Keep re-fetching the cheap cached
    // state until a response settles it either way (ok / carded).
    if (cliProbePending()) refreshCli(ctx);
  }, 8000));
}

export function unmount() {
  if (!state) return;
  // A deferred preselect (Quick Open handoff waiting for the current
  // workspace's roster paint) dies with the view: leaving it pending would
  // let a remount minutes later pop a modal the user no longer expects
  // (review 04584f9 — the consumed-once/stale-intent contract).
  pendingPreselect = null;
  pendingHome = null;
  pendingCapability = null;
  pendingWorkspaceTab = null;
  selectionIntent++;
  state.alive = false;
  state.inspector.dispose(); state.page.dispose(); state.capOpen?.contents.dispose();
  state.presentation?.dispose();
  state.gridState?.dispose();
  if (state.machines) { state.machines = false; unmountMachines(); }
  state.discovery.dispose();
  state.timers.forEach(clearInterval);
  (state.disposers || []).forEach((off) => { try { off(); } catch {} });
  if (state.unsubWs) state.unsubWs();
  if (state.unsubCli) state.unsubCli();
  if (state.cliCardHandle) { state.cliCardHandle.dispose(); state.cliCardHandle = null; }
  if (state.noticeHandle) { state.noticeHandle.dispose(); state.noticeHandle = null; }
  closeSpawnModal(state);
  state.el.innerHTML = "";
  state = null;
}

/* Exported for the deferred cross-workspace regression. */
export async function refresh(s, { user = false } = {}) {
  const myGen = workspaceGeneration();       // capture at dispatch
  const myReq = s.rosterReq = (s.rosterReq || 0) + 1;
  const intent = { intent: selectionIntent, gen: myGen };
  const current = () => s.alive && myGen === workspaceGeneration() && myReq === s.rosterReq;
  s.gridState?.begin({ user });
  let souls, panel;
  try {
    [souls, panel] = await Promise.all([
      apiJson(s.ctx, `/api/agents${wsQuery()}`),
      apiJson(s.ctx, `/api/panel${wsQuery()}`),
    ]);
  } catch (error) {
    // A newer read or another workspace owns the controller now: nothing to say. A read discarded only because the
    // selection moved is still this controller's: end its visuals (else the grid stays "refreshing" until the next poll).
    if (!current()) return;
    if (!ownsSelection(s, intent)) { s.gridState?.cancel(); return; }
    // The last good list stays (stale, with the cause and Retry above it); with nothing yet, the
    // failed block replaces the skeleton. The 8s poll keeps trying either way.
    s.gridState?.fail(error);
    if (!s.gridState?.hasData) s.discovery?.rosterUnavailable?.(); // the Souls tab count: nothing, still (a pill would say "still loading")
    // Roster-derived claims follow the roster's state: an open soul's Instances card, the Capabilities "Used by" cells, an open capability page.
    s.inspector?.syncRoster?.(); s.page?.syncRoster?.(); s.discovery?.syncRoster?.(); syncCapabilityPage(s);
    return;
  }
  // discard deferred responses from a previous workspace — they'd paint A's
  // agent list over B's after a switch
  if (!current()) return;
  if (!Array.isArray(souls?.agents)) { s.gridState?.fail({ message: "The souls list could not be read.", code: "E_CLI_PROTOCOL" }); return; }
  s.souls = souls;
  s.rosterGen = myGen; // this roster belongs to the current workspace generation
  s.panelInstances = panel.instances || []; // reference-instance picker source
  s.workspace = panel.workspace || null; // reported context, never derived from a display label
  s.deployment = panel.deployment || null; // kernel observation state (status/header or unavailable reason)
  // #482: the view's deployments (the spawn dialog's Deployment field) and every view (Where to run's facts).
  s.spawnDeployments = Array.isArray(panel.deployments) ? panel.deployments : [];
  s.spawnViews = Array.isArray(panel.workspaces) ? panel.workspaces : [];
  s.syncModalFacts?.();
  const select = s.q("wssel");
  if (select && typeof select.replaceChildren === "function") {
    // The real shell owns workspace selection. Standalone harnesses keep
    // their selector, safely constructed even for quotes in workspace ids.
    const workspaces = Array.isArray(panel.workspaces) ? panel.workspaces : [];
    select.style.display = s.ctx.hasWorkspaceSwitcher || workspaces.length <= 1 ? "none" : "";
    select.replaceChildren();
    for (const workspace of workspaces) {
      const option = select.ownerDocument.createElement("option");
      option.value = workspace.id; option.textContent = workspace.name || workspace.id;
      select.append(option);
    }
    select.value = panel.workspace?.id || "";
  }
  s.discovery?.updateRoster(souls.agents, panel);
  s.inspector?.syncAvailability(); s.page?.syncAvailability();
  settleGridState(s, souls);
  renderGrid(s);
  // Roster-derived claims follow the settled roster (updateRoster above rendered while the read was still 'refreshing'):
  // an open soul's Instances card, the Capabilities "Used by" cells, an open capability page.
  s.inspector?.syncRoster?.(); s.page?.syncRoster?.(); s.discovery?.syncRoster?.(); syncCapabilityPage(s);
  applyPreselect(s); // Quick Open handoff — after the roster is painted
  applyHome(s);
}

/** The roster's state for surfaces that make claims from it (an instance list, a "Used by" cell): the settled
 * state while a re-read runs — a refresh over a stale roster is still stale, not a good read. */
function rosterSettledState(s) {
  const load = s.gridState; if (!load) return 'ready';
  return load.state === 'refreshing' ? load.settled : load.state;
}
/** What the reply says about the souls list (spec 02's fields are optional; they must not be needed):
 * `catalog.reason` (the kernel could not read the catalog) is a failed read: stale with cards, failed
 * without; an observed deployment still reading (`refreshing: true`, no souls, no reason) stays pending;
 * an unobserved deployment stays pending with the deployment's own copy in the grid; an empty list that
 * read no observed deployment (no `catalog`) beside a panel that says it is observed stays pending too;
 * else the read succeeded, empty when it listed nothing. */
function settleGridState(s, souls) {
  const load = s.gridState; if (!load) return;
  const agents = souls.agents, reason = souls.catalog?.reason || null;
  const observedAt = typeof souls.observedAt === "string" ? souls.observedAt : null;
  if (reason) {
    // Souls listed beside the reason are data (the kernel's partial list): taken, then marked stale. With
    // data already on screen only fail() runs — succeed() first would rebuild the line under a focused
    // Retry and announce the failure again on every poll (the hierarchy's rule).
    if (agents.length && !load.hasData) load.succeed({ observedAt });
    load.fail({ message: soulCatalogFailure(reason), code: typeof reason.code === "string" ? reason.code : null }, { observedAt }); return;
  }
  if (s.deployment && s.deployment.status !== "observed") { load.defer(); return; }
  if (!agents.length && souls.refreshing === true) { load.defer({ keepSkeleton: true }); return; }
  // The two reads run side by side: at launch (the Workspace page is the home surface) /api/agents can be
  // answered before the server's first observation of the deployment (agentsData: no `catalog`, nothing listed)
  // and /api/panel just after it. That empty list is no read of the souls: the grid keeps loading, never
  // "No souls are materialized", and the next poll reads the list. (A remote view's panel names no deployment.)
  if (!agents.length && !souls.catalog && s.deployment?.status === "observed") { load.defer({ keepSkeleton: true }); return; }
  load.succeed({ observedAt, empty: !agents.length });
}
/** Pending: one group's worth of card skeletons at the real card size — one row plus one; in the table, its rows. */
function gridSkeleton(s) {
  const grid = s.q("souls-grid"), doc = grid.ownerDocument;
  const width = grid.clientWidth || 0, columns = Math.max(1, Math.floor((width - 40 + 12) / (240 + 12)));
  const section = doc.createElement("section"); section.className = "souls-group skeleton-souls-group";
  const title = doc.createElement("div"); title.className = "souls-group-title";
  const bone = doc.createElement("span"); bone.className = "skeleton skeleton-line skeleton-group-title"; title.append(bone);
  const table = s.view === "table";
  const items = doc.createElement("div"); items.className = table ? "souls-table-skeleton" : "souls-group-cards";
  for (let i = 0; i < (table ? 6 : columns + 1); i++) items.append(table ? skeleton(doc, "table-row", { columns: SOULS_TABLE_COLUMNS.length }) : skeleton(doc, "soul-card"));
  section.append(title, items); section.setAttribute("aria-hidden", "true"); section.dataset.skeleton = table ? "soul-rows" : "soul-cards";
  return section;
}

function matches(s, a) {
  if (!s.filterText) return true;
  return soulMatches(a, s.filterText);
}

function renderGrid(s, { restoreFocus = true } = {}) {
  const grid = s.q("souls-grid");
  // The spawn form lives in a MODAL outside the grid (human change request on
  // the integrated feature branch), so periodic polls may rebuild the roster
  // freely without wiping typed-but-unsubmitted task/purpose text — the
  // modal DOM is untouched by grid repaints. The one transition that must
  // still reach INTO the modal is CLI degradation (review d7becaf): a modal
  // opened while the CLI state was unknown must not leave a live submit
  // behind a missing degradation card when the probe lands ok:false. Close
  // it; the rebuild shows the card and disabled buttons; doSpawn
  // independently re-checks at submit time.
  const noCli = !cliAvailable(); // frozen contract: unknown does NOT render capable
  // repaint:false — this very renderGrid call is already painting the grid;
  // a nested repaint from the close would render twice for nothing.
  if (noCli && s.sel) closeSpawnModal(s, { repaint: false });
  // capture the focused card's identity before the rebuild wipes the DOM
  const active = s.el?.ownerDocument?.activeElement;
  const focused = grid.contains?.(active) ? active?.closest?.(".soul-item") : null;
  const focusedRef = focused ? { name: focused.dataset.agent, agentsRoot: focused.dataset.root, server: focused.dataset.server } : null;
  // Recovery is shared by every Workspace section, not hidden inside the
  // Souls tab. Its action/focus owner survives routine roster repaints.
  const recovery = s.q("workspace-recovery");
  if (s.cliCardHandle && !cliKnownUnavailable()) {
    s.cliCardHandle.dispose(); s.cliCardHandle.el.remove(); s.cliCardHandle = null;
  }
  if (recovery) recovery.hidden = !cliKnownUnavailable() && !cliAboveTested();
  const list = s.souls.agents.filter((a) => matches(s, a));
  s.q("souls-sum").classList?.add("workspace-sr-only");
  s.q("souls-sum").textContent = `${list.length} of ${s.souls.agents.length} souls${cliProbePending() ? " · Checking CLI…" : ""}`;
  if (typeof grid.append !== "function") return; // non-DOM host (tests observe s.souls)
  // One consistent degradation card ABOVE the roster when the CLI is KNOWN
  // unavailable — reads (the soul cards, brain) stay fully usable below it.
  // Unknown state (pre-probe) disables buttons WITHOUT the card: mutations
  // require a verified compatible CLI (frozen contract), but flashing the
  // card during the milliseconds before the launch probe resolves would be
  // noise.
  if (state && s === state && cliKnownUnavailable() && recovery) {
    if (!s.cliCardHandle) s.cliCardHandle = cliCard(grid.ownerDocument, s.ctx);
    if (s.cliCardHandle.el.parentNode !== recovery) recovery.append(s.cliCardHandle.el);
  }
  // Above the tested bound (#1879) the CLI is accepted: the notice takes the card's place, one line, and the soul
  // cards stay usable (Spawn is allowed). It renders itself on every CLI change, and empty once the CLI is back
  // within the bound.
  if (s.noticeHandle && !cliAboveTested()) { s.noticeHandle.dispose(); s.noticeHandle.el.remove(); s.noticeHandle = null; }
  if (state && s === state && cliAboveTested() && recovery) {
    if (!s.noticeHandle) s.noticeHandle = aboveTestedCard(grid.ownerDocument, s.ctx);
    if (s.noticeHandle.el.parentNode !== recovery) recovery.append(s.noticeHandle.el);
  }
  // No data yet (desktop/loading-states): the grid is the loading controller's — its skeleton, its failed
  // block — and never an empty message. The one exception is a deployment that is not observed: that
  // is a truthful state of its own, said in the deployment's words (the controller shows no skeleton then).
  const unobserved = !!s.deployment && s.deployment.status !== "observed";
  const hasData = s.gridState ? s.gridState.hasData : true;
  if (!hasData && !unobserved) {
    // The grid is the loading controller's again: an unobserved deployment's copy painted before goes.
    grid.querySelector(":scope > .empty")?.remove();
    s.gridSignature = null; return;
  }
  // Skip unchanged repaints: an identical poll never rebuilds the cards under focus or a hover.
  const signature = JSON.stringify([hasData, unobserved && s.deployment, s.souls.agents, s.filterText, s.view, noCli, cliKnownUnavailable(), cliProbePending(), cliStatus()?.features ?? null,
    s.panelInstances.map((i) => [i.instance, i.agent, i.agentsRoot, i.running === true]), s.deployment?.workspaceStatus?.members ?? null,
    s.selAgent && [s.selAgent.name, s.selAgent.agentsRoot, s.selAgent.server], s.inspectRef && [s.inspectRef.name, s.inspectRef.agentsRoot, s.inspectRef.server]]);
  if (signature === s.gridSignature && grid.childElementCount) return;
  s.gridSignature = signature;
  grid.innerHTML = "";
  grid.dataset.view = s.view;
  if (!list.length) {
    const empty = grid.ownerDocument.createElement("div");
    empty.className = "empty"; empty.style.gridColumn = "1/-1";
    // An unobserved deployment is not an empty one: say why (a missing
    // advertised feature is named; a kernel refusal keeps its code/message).
    empty.textContent = s.souls.agents.length ? "Nothing matches the filter."
      : unobserved ? deploymentUnavailableText(s.deployment, DESKTOP_TERMS) : "No souls are materialized in this deployment yet.";
    grid.append(empty);
    return;
  }
  // Grouped by where the soul comes from (the workspace's own repository first, its other members, each package,
  // the external souls), and inside a group in kind order: maintainers, experts, developers, operations, then the
  // rest, each by name (packages/client/soul-kind.mjs). Souls of a member that is not confirmed are listed last,
  // apart, with the member's reason (workspace status).
  const groups = new Map();
  for (const a of [...list].sort(compareSouls)) {
    const g = repoGroup(s, a);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, souls: [] });
    groups.get(g.key).souls.push(a);
  }
  const count = (n) => `${n} ${n === 1 ? "soul" : "souls"}`;
  const shown = [...groups.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map((g) => ({ ...g, qualifier: [g.qualifier, count(g.souls.length)].filter(Boolean).join(" · ") }));
  const unavailable = unavailableMembers(s).map(({ member, state: why, souls }) => ({ member, why, names: souls.filter((name) => matches(s, { name })) }))
    .filter(({ names }) => !s.filterText || names.length);
  if (s.view === "table") renderTable(s, grid, shown, unavailable);
  else renderCards(s, grid, shown, unavailable);
  // Roving tabindex across the rebuilt grid: keep the previously focused
  // item's identity tabbable (and focused) when it survives the repaint,
  // else the first item enters the tab order.
  const rebuilt = gridCards(s);
  if (rebuilt.length) {
    const restored = focusedRef && rebuilt.find((c) => cardMatches(c, focusedRef));
    rove(restored || rebuilt[0], true);
    if (restoreFocus && canFocusCard(s, restored)) restored.focus({ preventScroll: true });
  }
}

/** The grid: a section per group, its heading, then its cards. */
function renderCards(s, grid, groups, unavailable) {
  const doc = grid.ownerDocument;
  const group = (g, cards, { warn = false } = {}) => {
    const section = doc.createElement("section"); section.className = "souls-group";
    // Group names read as words (D2: monospace only in terminals).
    const heading = groupHeading(doc, { icon: g.icon, name: g.name, note: g.qualifier, mono: false, warn });
    heading.id = `souls-group-${grid.querySelectorAll(".souls-group").length}`; section.setAttribute("aria-labelledby", heading.id);
    const body = doc.createElement("div"); body.className = "souls-group-cards";
    section.append(heading, body); body.append(...cards); grid.append(section);
  };
  for (const g of groups) group(g, g.souls.map((a) => soulCard(s, a)));
  for (const { member, why, names } of unavailable) {
    group({ icon: "warning", name: "Not available", qualifier: `${member.name || member.key} ${why.why}` }, names.map((name) => unavailableCard(s, name, member)), { warn: true });
  }
}

/** The table's columns, in order: [class of its <col>, header]. */
export const SOULS_TABLE_COLUMNS = Object.freeze([["c-name", "Name"], ["c-what", "What it does"], ["c-kind", "Kind"],
  ["c-agents", `${DESKTOP_NOUNS.instances[0].toUpperCase()}${DESKTOP_NOUNS.instances.slice(1)} running`], ["c-launch", "Harness · model"], ["c-ready", "Ready"]]);
/** The table: the same souls as rows, a heading row per group. The name cell holds the row's one control, a
 * button that opens the soul's page; the other cells are read as the table's cells. */
function renderTable(s, grid, groups, unavailable) {
  const doc = grid.ownerDocument;
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined && text !== null) el.textContent = text; if (cls) el.className = cls; return el; };
  const table = node("table", undefined, "souls-table"); table.setAttribute("aria-label", "Souls");
  const cols = node("colgroup"); for (const [cls] of SOULS_TABLE_COLUMNS) cols.append(node("col", undefined, cls));
  const head = node("thead"), headRow = node("tr");
  for (const [, label] of SOULS_TABLE_COLUMNS) { const th = node("th", label); th.scope = "col"; headRow.append(th); }
  head.append(headRow); table.append(cols, head);
  const groupRows = (g, rows, { warn = false } = {}) => {
    const body = node("tbody", undefined, "souls-table-body"), row = node("tr", undefined, "souls-table-group-row");
    const th = node("th", undefined, "souls-table-group"); th.colSpan = SOULS_TABLE_COLUMNS.length; th.scope = "colgroup";
    th.append(groupHeading(doc, { icon: g.icon, name: g.name, note: g.qualifier, mono: false, warn, level: 3 }));
    row.append(th); body.append(row, ...rows); table.append(body);
  };
  for (const g of groups) groupRows(g, g.souls.map((a) => soulRow(s, a)));
  for (const { member, why, names } of unavailable) {
    groupRows({ icon: "warning", name: "Not available", qualifier: `${member.name || member.key} ${why.why}` }, names.map((name) => {
      const row = node("tr", undefined, "soul-row unavailable"); row.dataset.unavailable = name;
      row.append(node("td", name), node("td", "Hidden until membership is confirmed", "what"), ...Array.from({ length: SOULS_TABLE_COLUMNS.length - 2 }, () => node("td", "—", "muted")));
      return row;
    }), { warn: true });
  }
  grid.append(table);
}

/* ── grid keyboard: roving focus over cards ──────────────────────── */
function cardMatches(card, ref) {
  return card.dataset.agent === ref.name && (card.dataset.root || "") === (ref.agentsRoot || "") && (card.dataset.server || "") === (ref.server || "");
}
/** The souls' controls, cards or table rows' name buttons: one roving tab stop over them. */
function gridCards(s) { return [...s.q("souls-grid").querySelectorAll(".soul-item")]; }
function rove(card, on) { card.tabIndex = on ? 0 : -1; }

function canFocusCard(s, card) {
  if (!s.alive || s.rosterGen !== workspaceGeneration() || s.discovery?.tab !== "souls"
    || !card?.isConnected || !s.el.contains(card)) return false;
  // Retained stages can be hidden while their requests/polls settle. Don't
  // restore focus through a hidden/inert stage or a just-hidden Souls subtab.
  for (let el = card; el; el = el.parentElement) {
    if (el.hidden || el.inert || el.style.display === "none" || el.style.visibility === "hidden") return false;
  }
  return true;
}

function focusedCard(s) {
  return s.el.ownerDocument.activeElement?.closest?.(".soul-item") || null;
}

function soulInstances(s, agent) {
  return (s.panelInstances || []).filter(i => i.agent === agent.name && i.agentsRoot === agent.agentsRoot && (i.server || "") === (agent.server || ""));
}
function canOpenFiles(s, agent) {
  // The existing read-only Brain route accepts a name, not an agentsRoot.
  // Do not pretend it can safely address a shadowed soul, or redirect an
  // inspector's captured A selector to a unique same-named replacement B.
  if (!s.alive || s.rosterGen !== workspaceGeneration() || agent.remote || typeof s.ctx.openBrain !== "function") return false;
  const candidates = s.souls.agents.filter(a => a.name === agent.name);
  return candidates.length === 1 && !candidates[0].remote
    && (candidates[0].agentsRoot || "") === (agent.agentsRoot || "")
    && (candidates[0].server || "") === (agent.server || "");
}
function brainOfFocusedCard(s) {
  const card = focusedCard(s);
  const a = card && s.souls.agents.find((x) => cardMatches(card, x));
  if (a && canOpenFiles(s, a)) s.ctx.openBrain?.(a.name);
}

function onGridKey(s, e) {
  // Keys inside the open form belong to the form (Esc handled above).
  if (e.target.closest?.(".spawn-modal")) return;
  const cards = gridCards(s);
  if (!cards.length) return;
  const cur = focusedCard(s);
  const at = cur ? cards.indexOf(cur) : -1;
  // An arrow chord the keymap binds (the shared Alt+Shift+↑/↓, ⌘⌥↑/↓; a rebind) is the keymap's from a card too.
  if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key) && keymapTakes(e)) return;
  if (["ArrowRight", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    focusCard(s, cards, Math.min(cards.length - 1, at + 1));
  } else if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
    e.preventDefault();
    focusCard(s, cards, Math.max(0, at - 1));
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    focusCard(s, cards, e.key === "Home" ? 0 : cards.length - 1);
  } else if (["Enter", " "].includes(e.key) && cur && e.target === cur) {
    e.preventDefault();
    cur.click();
  } else if (cur && e.target === cur) {
    // ALL view actions resolve from a focused card — the primary
    // non-editable surface (review 93ff03d: '/' must reach the filter
    // from the roving card, not just 'b').
    const hit = resolveViewKey(e, s.viewActions);
    if (hit) {
      e.preventDefault();
      s.viewActions.find((a) => a.id === hit)?.run();
    }
  }
}

/* Roving tabindex: exactly one card in the tab order — the focused one. */
function focusCard(s, cards, index) {
  const target = cards[index];
  if (!target) return;
  for (const c of cards) rove(c, c === target);
  target.focus();
}

/* ── grid ⇄ table ───────────────────────────────────────────────── */
/** Where the Souls view (grid or table) is kept: localStorage, one entry per workspace view (a window shows one
 * view, so this is the window's choice, and it survives a restart), only views left in the table, at most
 * SOULS_VIEW_MAX of them (the most recent kept). Ids only: no workspace content is written. */
export const SOULS_VIEW_KEY = "oats.desktop.soulsView";
export const SOULS_VIEW_MAX = 32;
const viewStorage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
function readViews(storage) {
  try {
    const value = JSON.parse(storage?.getItem(SOULS_VIEW_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
/** The view a workspace view was left in: "grid" (the default) or "table". */
export function rememberedSoulsView(viewId, storage = viewStorage()) {
  return readViews(storage)[String(viewId ?? "")] === "table" ? "table" : "grid";
}
/** Keep a workspace view's choice. A storage that refuses (full, disabled) keeps nothing: the choice still holds here. */
export function rememberSoulsView(viewId, view, storage = viewStorage()) {
  if (!storage) return;
  const id = String(viewId ?? ""), map = readViews(storage);
  delete map[id];
  if (view === "table") map[id] = "table";
  const kept = Object.fromEntries(Object.entries(map).slice(-SOULS_VIEW_MAX));
  try { if (Object.keys(kept).length) storage.setItem(SOULS_VIEW_KEY, JSON.stringify(kept)); else storage.removeItem(SOULS_VIEW_KEY); } catch { /* the choice holds in memory */ }
}
function syncViewSwitch(s) {
  for (const button of s.q("souls-view")?.querySelectorAll("button") || []) button.setAttribute("aria-pressed", String(button.dataset.view === s.view));
}
/** Show the souls as `view` ("grid" | "table"), remember it, and keep the focused soul focused in the other form
 * (`keepFocus`: v from a card or a row; a click on Grid | Table keeps focus on that button). */
function setSoulsView(s, view, { keepFocus = false } = {}) {
  if (!s.alive || (view !== "grid" && view !== "table") || view === s.view) return;
  const cur = keepFocus ? focusedCard(s) : null;
  const ref = cur ? { name: cur.dataset.agent, agentsRoot: cur.dataset.root, server: cur.dataset.server } : null;
  s.view = view; rememberSoulsView(currentWorkspace(), view); syncViewSwitch(s);
  renderGrid(s, { restoreFocus: false });
  if (!keepFocus) return;
  const items = gridCards(s), target = (ref && items.find((c) => cardMatches(c, ref))) || items.find((c) => c.tabIndex === 0);
  if (target && canFocusCard(s, target)) { for (const c of items) rove(c, c === target); target.focus({ preventScroll: false }); }
}

function canLaunchSoul(s, agent) {
  return !spawnRefusal(agent, cliStatus()) && s.alive && s.rosterGen === workspaceGeneration() && cliAvailable() && !!agent?.agentsRoot
    && s.souls.agents.filter(current => current.name === agent.name
      && current.agentsRoot === agent.agentsRoot && (current.server || "") === (agent.server || "")).length === 1
    && s.souls.agents.find(current => current.name === agent.name
      && current.agentsRoot === agent.agentsRoot && (current.server || "") === (agent.server || "")).work !== "attached";
}

const repoLabel = (a) => a.repoName || (a.repo ? String(a.repo).split("/").filter(Boolean).at(-1) : "") || "workspace";
/** The workspace's host member (the repository holding oats-workspace.yaml), from workspace status. */
const hostKey = (s) => s.deployment?.status === "observed" ? s.deployment.workspaceStatus?.workspace?.key ?? null : null;
/** The group a soul sits in: its member repository (the host first), its package with the pinned version, or the
 * external souls; icon, name and qualifier as reported. */
function repoGroup(s, a) {
  if (a.soulKind === "package" && a.package) {
    const name = [a.package, a.version].filter(Boolean).join(" ");
    return { key: `package:${name}`, rank: 2, icon: "package", name, qualifier: "package · pinned" };
  }
  if (a.soulKind === "external") return { key: "external", rank: 3, icon: "external", name: "external", qualifier: "not in a member repo" };
  const host = !!a.repo && sameRepo(a.repo, hostKey(s));
  if (a.soulKind === "member") return { key: `member:${a.repo || repoLabel(a)}`, rank: host ? 0 : 1, icon: "repo", name: repoLabel(a), qualifier: host ? "member repo · host" : "member repo" };
  return { key: `repo:${a.server || ""}:${repoLabel(a)}`, rank: 1, icon: "repo", name: repoLabel(a), qualifier: a.server ? `on ${a.server}` : "" };
}
/** How many of a soul's agents run, in words: "2 agents running", "No agents running · 1 stopped". */
export function agentsText(running, total) {
  const noun = (n) => n === 1 ? DESKTOP_NOUNS.instance : DESKTOP_NOUNS.instances;
  if (running) return `${running} ${noun(running)} running`;
  return total ? `No ${DESKTOP_NOUNS.instances} running · ${total} stopped` : `No ${DESKTOP_NOUNS.instances} running`;
}
/** What a spawn of this soul here runs: "<harness> · <model>" (0.30 launch preferences), the declared harness alone
 * (an older kernel), else null. */
function launchText(a) {
  const launch = shownLaunch(a.launch, cliStatus())?.effective ?? null;
  const harness = launch?.harness ?? harnessOf(a);
  if (typeof harness !== "string" || !harness) return null;
  return launch ? `${launchHarnessName(harness)} · ${launch.model ?? "default model"}` : launchHarnessName(harness);
}
/** What stops a spawn of this soul here, from its row, in the soul page's order: the kernel's refusal (kernel #217
 * desktop-facts), else the launch problem its launch report carries (0.30 launch preferences: the kernel's own
 * message); null when neither is reported. `line` is the card's, `text` the table's and the page's sentence. */
export function soulProblem(a, cli) {
  if (a?.work === "attached") return null;
  const refusal = spawnRefusal(a, cli);
  if (refusal !== null) return { text: refusal, line: cantSpawnLine(refusal) };
  const problem = soulFacts(a, null, cli, DESKTOP_TERMS).problem;
  const said = problem ? problem.lines[0] ?? problem.lead : null;
  return said ? { text: said, line: said } : null;
}
/** Whether the soul is ready here, from its row: "Ready", or what stops a spawn here (soulProblem); null when this CLI
 * does not report whether a spawn here would be refused (no claim is made). */
export function soulReadiness(a, cli) {
  if (!desktopFacts(cli)) return null;
  const problem = soulProblem(a, cli);
  return problem === null ? { ready: true, text: "Ready" } : { ready: false, text: problem.text };
}
const isOpen = (s, a) => (s.selAgent?.name === a.name && s.selAgent?.agentsRoot === a.agentsRoot && s.selAgent?.server === a.server)
  || (s.inspectRef?.name === a.name && s.inspectRef?.agentsRoot === a.agentsRoot && s.inspectRef?.server === a.server);
/** A soul's control (a card, or a table row's name): it opens the soul's page. */
function soulControl(s, a, cls) {
  const control = s.el.ownerDocument.createElement("button");
  control.type = "button"; control.className = `${cls} soul-item inspect-act`;
  control.dataset.agent = a.name; control.dataset.root = a.agentsRoot || ""; control.dataset.server = a.server || "";
  control.tabIndex = -1; // roving tabindex — renderGrid elects the tabbable one
  control.setAttribute("aria-controls", "workspace-soul-page"); // it opens the soul's page
  control.addEventListener("click", () => inspectSoul(s, a));
  return control;
}

/** One soul card: its name, what it does, how many of its agents run, and its kind. Spawning is the palette's and
 * New agent's (and the soul's page's); the card opens the page. */
function soulCard(s, a) {
  const doc = s.el.ownerDocument;
  const card = soulControl(s, a, "soul-card" + (a.work === "attached" ? " attached" : "") + (isOpen(s, a) ? " open" : ""));
  const span = (cls, text) => { const el = doc.createElement("span"); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  card.append(span("stitle", a.name));
  if (a.description) card.append(span("sdesc", a.description));
  const instances = soulInstances(s, a);
  const running = instances.filter(i => i.running === true).length;
  const foot = span("sfoot");
  const problem = soulProblem(a, cliStatus());
  // A soul a spawn here would refuse says why first: its readiness is the one thing a person needs before anything else.
  if (problem) { const note = span("sproblem", problem.line); note.title = problem.text; foot.append(note); }
  else foot.append(span("sactivity" + (running ? " running" : ""), agentsText(running, instances.length)));
  foot.append(span("skind", `· ${SOUL_KIND_WORDS[soulKind(a)]}`));
  card.append(foot);
  // Its name names it; what it does, its agents and its kind describe it.
  card.setAttribute("aria-label", a.name);
  card.setAttribute("aria-description", [a.description, problem ? problem.line : agentsText(running, instances.length), `${SOUL_KIND_WORDS[soulKind(a)]} soul`].filter(Boolean).join(". "));
  card.title = [a.name, a.description].filter(Boolean).join("\n");
  return card;
}

/** One soul as a table row: name (its button), what it does, kind, agents running, harness · model, ready. */
function soulRow(s, a) {
  const doc = s.el.ownerDocument;
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined && text !== null) el.textContent = text; if (cls) el.className = cls; return el; };
  const row = node("tr", undefined, "soul-row" + (isOpen(s, a) ? " open" : ""));
  const name = node("td", undefined, "name"), open = soulControl(s, a, "soul-row-open");
  open.textContent = a.name; open.title = a.name; name.append(open);
  const what = node("td", a.description || "—", a.description ? "what" : "what muted");
  const instances = soulInstances(s, a), running = instances.filter(i => i.running === true).length;
  const agents = node("td", String(running), running ? "agents" : "agents muted");
  agents.title = agentsText(running, instances.length);
  const launch = launchText(a);
  const ready = soulReadiness(a, cliStatus());
  const readyCell = node("td", ready?.ready === false ? undefined : ready ? ready.text : "—", ready ? (ready.ready ? "ready" : "problem") : "muted");
  if (ready?.ready === false) { readyCell.append(node("span", ready.text, "clamp")); readyCell.title = ready.text; }
  if (!ready) readyCell.title = "This OATS does not report whether a spawn here would be refused.";
  row.append(name, what, node("td", SOUL_KIND_WORDS[soulKind(a)], "kind"), agents, node("td", launch ?? "—", launch ? "launch" : "launch muted"), readyCell);
  return row;
}

/** Members whose handshake is not confirmed, with the souls workspace status
 * lists for them (they are not in the soul catalog, so they cannot open). */
function unavailableMembers(s) {
  const status = s.deployment?.status === "observed" ? s.deployment.workspaceStatus : null;
  return (Array.isArray(status?.members) ? status.members : [])
    .map(member => ({ member, state: memberState(member), souls: Array.isArray(member.souls) ? member.souls.filter(n => typeof n === "string" && n) : [] }))
    .filter(row => !row.state.ok);
}
function unavailableCard(s, name, member) {
  const doc = s.el.ownerDocument;
  const card = doc.createElement("div"); card.className = "soul-card unavailable"; card.dataset.unavailable = name;
  const span = (cls, text) => { const el = doc.createElement("span"); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  card.append(span("stitle", name), span("sdesc", member.name || member.key));
  // Why it cannot open: the foot, in the warning colour.
  const foot = span("sfoot"); foot.append(span("sproblem", "Hidden until membership is confirmed"));
  card.append(foot);
  return card;
}

/** Close (if open) the spawn modal and clear the selection. Safe to call
 * when no modal exists. Closing ends the form's operation ownership; an
 * in-flight completion cannot act after cancellation or a subtab change.
 * repaint (default true when a modal existed) re-renders the grid so the
 * card's .open highlight clears immediately — not on the next poll.
 * restoreFocus targets the current inspector Launch action for the same
 * composite soul, falling back to its current card if the inspector closed.
 * Grid polling replaces cards: never focus a captured detached opener or
 * a same-named twin (review 41059e0). */
function closeSpawnModal(s, { restoreFocus = false, repaint = true } = {}) {
  const hadModal = !!s.modalEl;
  const agentRef = s.selAgent, dismissed = s.spawnReturn; s.spawnReturn = null;
  if (hadModal) s.spawnOp++; // closing ends the form operation ownership
  s.sel = null; s.selAgent = null;
  s.modalCleanup?.(); s.modalCleanup = null;
  s.modalEl?.remove(); s.modalEl = null;
  s.syncModalRelations = null; s.syncModalFacts = null;
  if (!hadModal || !repaint || s.alive === false) return;
  renderGrid(s); // clear the .open card highlight NOW
  if (!restoreFocus || !agentRef) return;
  // Opened from Quick Open: back to where the operator was before it, unless they have moved on.
  if (dismissed) { let returned = false; try { returned = dismissed() === true; } catch { /* fall back */ } if (returned) return; }
  if (s.page?.focusLaunch(agentRef)) return;
  const card = gridCards(s).find(card => cardMatches(card, agentRef));
  if (!canFocusCard(s, card)) return;
  for (const c of gridCards(s)) rove(c, c === card);
  card.focus();
}

/** "Where to run" (one-deployment views): every remote roster group's facts (reached, registered), whichever
 * view holds it. /api/team-members answers one view's groups (#482), so each view with a remote deployment is
 * read (held observations, no command); a group is kept once. Before the panel lists views, the current one. */
export async function serverFacts(s) {
  const views = (s.spawnViews || []).filter(v => typeof v?.id === "string" && Array.isArray(v.deployments)
    && v.deployments.some(d => typeof d === "string" && d.startsWith("remote:"))).slice(0, 32);
  const read = path => apiJson(s.ctx, path).then(d => Array.isArray(d?.servers) ? d.servers : [], () => []);
  const answers = views.length ? await Promise.all(views.map(v => read(`/api/team-members?ws=${encodeURIComponent(v.id)}`))) : [await read(`/api/team-members${wsQuery()}`)];
  const seen = new Set();
  return answers.flat().filter(f => f && typeof f.group === "string" && !seen.has(f.group) && seen.add(f.group));
}
/** A remote group's rows, for the relation picker of a chosen server: `/api/panel?ws=remote:<group>` answers
 * the VIEW holding that group (#482), so only the group's own deployment's rows (relations never cross machines). */
export async function serverRows(s, group) {
  const id = `remote:${group}`;
  const d = await apiJson(s.ctx, `/api/panel?ws=${encodeURIComponent(id)}`);
  return (Array.isArray(d?.instances) ? d.instances : []).filter(i => !i?.deployment || i.deployment.id === id);
}

/** The spawn dialog (renderer/spawn-dialog.mjs) hosted as a modal: role=dialog +
 * aria-modal, Tab focus trap, Esc/backdrop/× close, focus restored to the
 * opener. Choosing another soul in the dialog reopens it for that soul and
 * keeps the typed name and instruction. */
function catalogNote(s) {
  return catalogProblem(s.souls?.catalog);
}
function openSpawnModal(s, a, draft = {}) {
  if (!canLaunchSoul(s, a)) return;
  nextSelectionIntent();
  closeSpawnModal(s); // one modal at a time; a new open supersedes the old
  s.sel = a.name; s.selAgent = a;
  renderGrid(s); // highlight the selected card under the backdrop
  const doc = s.el.ownerDocument, modalGen = workspaceGeneration();
  const modal = doc.createElement("div");
  modal.className = "spawn-modal";
  const ownsModal = () => s.alive && modalGen === workspaceGeneration() && s.modalEl === modal;
  const close = () => closeSpawnModal(s, { restoreFocus: true });
  const ui = createSpawnDialog(modal, {
    ctx: s.ctx, soul: a, agents: s.souls.agents, workspace: () => s.workspace, cli: cliStatus, instances: () => s.panelInstances,
    owns: () => ownsModal() && canLaunchSoul(s, a), canChoose: candidate => canLaunchSoul(s, candidate), draft, catalogNote: catalogNote(s), close,
    // Board 6: opened for a soul (its card, its page) the dialog is scoped to it; a soul chosen in
    // the picker (after Change soul) reopens in the picker, so the list stays where it was.
    layout: draft.layout === "picker" ? "picker" : "scoped",
    ...(Number.isInteger(s.ctx.spawnTiming?.previewDelay) ? { delay: s.ctx.spawnTiming.previewDelay } : {}),
    ...(Number.isInteger(s.ctx.spawnTiming?.busyDelay) ? { busyDelay: s.ctx.spawnTiming.busyDelay } : {}),
    ...(Number.isInteger(s.ctx.spawnTiming?.backfillDelay) ? { backfillDelay: s.ctx.spawnTiming.backfillDelay } : {}),
    ...(Number.isInteger(s.ctx.spawnTiming?.pollDelay) ? { pollDelay: s.ctx.spawnTiming.pollDelay } : {}),
    ...(Number.isInteger(s.ctx.spawnTiming?.suggestDelay) ? { suggestDelay: s.ctx.spawnTiming.suggestDelay } : {}),
    choose: (candidate, next) => {
      if (!ownsModal() || !canLaunchSoul(s, candidate)) return;
      const fresh = s.souls.agents.find(current => current.name === candidate.name && current.agentsRoot === candidate.agentsRoot && (current.server || "") === (candidate.server || ""));
      // The same dialog flow: a Quick Open return target survives choosing another soul.
      const dismissed = s.spawnReturn;
      openSpawnModal(s, fresh, next); // a pick goes on to Name (Spec E)
      if (s.modalEl && dismissed) s.spawnReturn = dismissed;
    },
    // #517: the window's own machines when the probe has the gates (the answer, with what Add a machine needs), else the registered list.
    servers: a.server ? [] : () => apiJson(s.ctx, `/api/servers${wsQuery()}`).then(d => d?.filtered === true && Array.isArray(d.servers) ? d : Array.isArray(d?.servers) ? d.servers : []),
    // "Where to run": each server's disabled state and, once chosen, its rows for the relation picker; a remote soul's
    // host features (held observations only).
    serverFacts: () => serverFacts(s),
    serverRows: group => serverRows(s, group),
    // #482: the view's deployments; with two or more the Deployment field replaces "Where to run".
    deployments: () => s.spawnDeployments || [],
    remoteSpawn: fields => doSpawn(s, fields),
    // Spec C: a confirmed local press is handed to the shell's spawn-jobs store and the dialog closes at
    // once; the store owns the transaction, the pending roster row, the outcome and the kept draft.
    // Without a store (the view harness) the dialog runs the transaction itself, as before.
    ...(s.ctx.spawnJobs && !a.server ? { handoff: spec => {
      if (!ownsModal() || spec.workspace !== s.workspace?.id) return false;
      const id = s.ctx.spawnJobs.submit({ ...spec, soul: { name: a.name, agentsRoot: a.agentsRoot },
        placement: pendingPlacement(spec.relation, s.panelInstances || []) });
      if (!id) return false;
      closeSpawnModal(s, { restoreFocus: true });
      // Spec E: after the dialog's own focus return, the shell reveals the pending row and follows the spawn
      // to its instance, unless the operator moves on first.
      s.ctx.followSpawn?.(id);
      return true;
    },
    // Spec D (#383): while a spawn of this soul is in flight here, the press stays disabled and says so;
    // "Show its row" closes the dialog and takes focus to the pending row.
    spawnInFlight: () => {
      const job = s.ctx.spawnJobs.inFlight(s.workspace?.id, { name: a.name, agentsRoot: a.agentsRoot });
      return job ? { instance: job.instance, show: () => { if (!ownsModal()) return; closeSpawnModal(s); s.ctx.showPendingSpawn?.(job.id); } } : null;
    } } : {}),
    onCreated: async (view, isCurrent) => {
      if (!isCurrent()) return;
      const receipt = view.receipt;
      if (view.status === "partial") {
        if (!ui.dialog.querySelector(".guarded-schedules")) {
          const manage = doc.createElement("button"); manage.className = "act guarded-schedules"; manage.type = "button"; manage.textContent = "View schedules";
          manage.addEventListener("click", () => { if (!ownsModal()) return; closeSpawnModal(s); preselectAutomationsTab("schedule"); s.ctx.openView?.("automations"); });
          // Its own footer item before the Cancel/Spawn group: it wraps with the status, never widening the group.
          ui.spawn.parentElement.before(manage);
        }
        return; // creation succeeded; never retry spawn to repair a wake
      }
      if (!receipt.launched) { ui.status.textContent = `Created ${receipt.instance} — not launched. Open its session from the roster.`; return; }
      const ref = { instance: receipt.instance, home: receipt.home, agentsRoot: receipt.agentsRoot };
      ui.status.textContent = `Created ${receipt.instance}. Opening its terminal…`;
      const connection = s.ctx.connectionGeneration?.() ?? 0, workspace = s.workspace?.id; let admitted;
      const visible = await waitForInstanceInPanel(s, { ...ref, agent: receipt.agent }, isCurrent,
        { ...s.waitOpts, strict: true, onAdmitted: row => { admitted = row; } });
      if (!isCurrent()) return;
      if (!visible) { ui.status.textContent = `Created ${receipt.instance} — not yet visible as a running session. Open it from the roster when it appears.`; return; }
      if (admitted) s.ctx.notifySpawn?.(admitted, workspace, connection);
      closeSpawnModal(s); s.ctx.openTerminal(ref, { quiet: true });
    },
  });
  let composing = false;
  modal.addEventListener("mousedown", (e) => { if (e.target === modal && !ui.busy()) close(); }); // backdrop
  ui.dialog.addEventListener("compositionstart", () => { composing = true; });
  ui.dialog.addEventListener("compositionend", () => { composing = false; });
  const isMac = /mac/i.test(doc.defaultView?.navigator?.platform || "");
  // The dialog's own chords (spawn-dialog-keys.mjs): Mod+Enter and the section keys. A plain chord never
  // takes a key from a text field, and plain Enter stays the focused control's.
  const dialogKey = (e) => {
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey; // Shift alone is still text input
    const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable;
    return (plain && (editable || e.key === "Enter")) ? null : resolveViewKey(e, SPAWN_DIALOG_KEYS, { isMac });
  };
  ui.dialog.addEventListener("keydown", (e) => {
    if (!ownsModal()) return;
    if (e.defaultPrevented || composing || e.isComposing || e.keyCode === 229 || e.repeat) {
      // A button's native Enter click must not bypass the launch-key guard.
      if (e.key === "Enter" && e.target.closest?.(".fspawn")) e.preventDefault();
      if (composing || e.isComposing || e.keyCode === 229) e.stopPropagation();
      // A held section key is still the dialog's: it never reaches the shell behind the modal.
      else if (e.repeat && !e.defaultPrevented && SPAWN_JUMPS.some(j => j.id === dialogKey(e))) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const hit = dialogKey(e);
    if (hit === "spawn.submit") { e.preventDefault(); e.stopPropagation(); ui.submit(); return; }
    const jump = hit && SPAWN_JUMPS.find(j => j.id === hit);
    // Spec E: Mod+1–7 move to a section, in the form's order, and never switch anything behind the modal.
    if (jump) { e.preventDefault(); e.stopPropagation(); ui.jump(jump.target); return; }
    if (e.key === "Enter" && e.target.closest?.(".fspawn")) { e.preventDefault(); ui.submit(); return; }
    if (e.key !== "Tab") return; // focus trap includes disclosure controls
    const focusable = [...ui.dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary")]
      .filter((el) => !el.hidden && !el.closest("[hidden]") && el.tabIndex >= 0
        && ![...ui.dialog.querySelectorAll("details:not([open])")].some(details => details.contains(el) && el !== details.querySelector("summary")));
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  s.modalEl = modal;
  s.el.querySelector(".souls").append(modal);
  registerSpawnDialogKeys(); // once, for the app's lifetime (the shell registers them at start)
  const updateHint = () => {
    const label = formatChord(getBinding("spawn.submit", isMac), isMac) || "";
    ui.spawn.dataset.chord = isMac ? label.replace(/Enter$/, "↵") : label;
    ui.setShortcuts(Object.fromEntries(SPAWN_JUMPS.map(({ id, target }) => {
      const chord = getBinding(id, isMac);
      return [target, chord ? { label: formatChord(chord, isMac), aria: ariaKeyShortcuts(chord, isMac) } : null];
    })));
  };
  const releaseHint = onKeymapChange(updateHint); updateHint();
  const releaseJobs = s.ctx.spawnJobs && !a.server ? s.ctx.spawnJobs.subscribe(() => { if (ownsModal()) ui.syncInFlight(); }) : () => {};
  s.modalCleanup = () => { ui.dispose(); releaseHint(); releaseJobs(); };
  s.syncModalFacts = () => { if (ownsModal()) ui.sync(); };
  s.syncModalRelations = s.syncModalFacts;
  ui.start();
  // Spec E: opened for a soul, or after a pick, the dialog lands on its first field, the Opening instruction.
  // Quick Open's pick from a tab opens the dialog before its stage is on screen (the stage shows right after),
  // and focus on a control not rendered yet does not land: try again on the next frames, while this dialog
  // is still the open one and focus has gone nowhere new since (the operator's own focus is never taken).
  const from = doc.activeElement;
  const nextFrame = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView) || (f => setTimeout(f, 16));
  const focusInitial = tries => {
    if (!ownsModal()) return;
    // Before each attempt: focus already in the dialog, or moved anywhere new, is the operator's: stop.
    const now = doc.activeElement;
    if (modal.contains(now) || (now && now !== from && now !== doc.body)) return;
    ui.focusFirst();
    if (!modal.contains(doc.activeElement) && tries > 0) nextFrame(() => focusInitial(tries - 1));
  };
  focusInitial(10);
  return modal;
}

/* Exported for the in-flight-spawn regressions.

   Two invalidation tokens gate ALL post-await mutation:
   - workspace generation: a spawn begun in workspace A that completes after a
     switch to B must NOT auto-open the terminal (openTerminal resolves names
     in the CURRENT workspace — a same-named B instance would receive input
     meant for the new A one);
   - a per-spawn operation token (s.spawnOp): the form is per-card but shared
     against re-renders — after a switch the user may already be spawning
     another agent, and a late completion must not touch a form it no longer
     owns. Only the currently active operation may mutate UI — success,
     error, and finally paths alike. */
/* After a spawn, the roster SNAPSHOT lags: /api/panel is refreshed by a
   background collector only every ~3s, so the new instance is usually not
   in it yet — and the shell's openTerminal resolves instances from that
   same endpoint, so opening immediately yields "unknown instance". Poll the
   selected workspace's panel until the instance appears AND is terminal-
   ready (ownership- and generation-gated), then hand off. Presence alone is
   NOT enough: the snapshot lists a freshly spawned instance from its
   instance.json before its tmux window registers, so an open dispatched at
   first sight hits the shell's "no live tmux session" refusal — the tmux
   session typically follows a couple of seconds later. Exported for the
   stale-snapshot regression. delayMs is injectable so tests run without
   real waits. */
export async function waitForInstanceInPanel(s, ref, isCurrent, { tries = 20, delayMs = 700, sleep, strict = false, present = false, onAdmitted } = {}) {
  const wait = sleep || ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  // ref: { instance, home?, agentsRoot? }. Match the COMPOSITE identity when
  // the spawn result provides it — with a same-named twin already in the
  // roster, a bare-name wait would succeed early and the follow-up open then
  // refuse the ambiguous name (merged-state review @7dd1e7b) — and require
  // the readiness the shell's open path checks (running + tmux session), so
  // the auto-open can never race the tmux registration. A remote row opens by
  // server and home: it is ready once running and addressable (tmux is the host's).
  // `present`: any row of that identity will do (a place to show, not a terminal to open).
  // `ref.deployment` (#482): only that deployment's row (a view's panel holds every deployment's rows).
  // `ref.deployment` is a deployment id, or a roster row's deployment object (Start…/Restart pass the row, #525).
  const refDeployment = typeof ref.deployment === "string" ? ref.deployment : ref.deployment?.id;
  const matches = (x) => x.instance === ref.instance
    && (x.server || "") === (ref.server || "")
    && (!refDeployment || !x.deployment || x.deployment.id === refDeployment)
    && (strict ? !!ref.home && x.home === ref.home : !ref.home || !x.home || x.home === ref.home)
    && (strict ? !!ref.agentsRoot && x.agentsRoot === ref.agentsRoot : !ref.agentsRoot || !x.agentsRoot || x.agentsRoot === ref.agentsRoot)
    && (!strict || !ref.agent || x.agent === ref.agent)
    && (present || !!x.running && (x.server ? canAddressRemote(x) : !!x.tmux?.session));
  for (let i = 0; i < tries; i++) {
    if (!isCurrent()) return false;          // ws switched / superseded: stop
    try {
      const panel = await apiJson(s.ctx, `/api/panel${wsQuery()}`);
      if (!isCurrent()) return false;
      const matched = (panel.instances || []).filter(matches);
      if (strict ? matched.length === 1 : matched.length > 0) {
        if (matched.length === 1) onAdmitted?.({ ...matched[0] });
        return true;
      }
    } catch { /* transient — keep polling */ }
    await wait(delayMs);
  }
  return false;                              // snapshot never caught up: no auto-open
}

/** Go to a row, maybe in another workspace: switch to `workspace` when it is not the current one,
 * wait until its roster serves the row `ref` (by server and home; `present` accepts a stopped row),
 * then `then(row)`, with null when it never became ready. Gives up quietly (false, `then` unheard)
 * when the workspace or the connection changes before that. */
export async function handOff(s, { workspace, ref, present = false, then }) {
  const connection = s.ctx.connectionGeneration?.() ?? 0;
  // A workspace another window shows moves to this one (a take-over, as a pick from the list does). The row's
  // action (`then`) owns the focus: the workspace's remembered focus place is not applied.
  if (currentWorkspace() !== workspace && !(await switchWorkspace(workspace, { takeOver: true, focusPlace: false })).ok) return false;
  const gen = workspaceGeneration();
  const stillThere = () => gen === workspaceGeneration() && currentWorkspace() === workspace && connection === (s.ctx.connectionGeneration?.() ?? 0);
  let admitted = null;
  const visible = await waitForInstanceInPanel(s, ref, stillThere, { ...s.waitOpts, present, onAdmitted: row => { admitted = row; } });
  if (!stillThere()) return false;
  await then(visible ? admitted ?? ref : null);
  return visible;
}

/** A Teams-board member (spec 02): its row in the view on screen, then open its terminal ('open') or
 * select the row and move keyboard focus to it ('show'). Every action lives on the roster row.
 * #482: the board lists the members of the view on screen, and `member.workspace` is the member's
 * DEPLOYMENT id: the action stays in this view (never a switch to a deployment id) and waits for the
 * row of that deployment; the row's own deployment addresses it, the view owns it. */
export function teamMemberAction(s, action, member) {
  const ref = { instance: member.instance, home: member.home, agentsRoot: member.agentsRoot, ...(member.server ? { server: member.server } : {}),
    ...(typeof member.workspace === "string" && member.workspace ? { deployment: member.workspace } : {}) };
  const view = currentWorkspace();
  return handOff(s, { workspace: view, ref, present: action === "show", then: row => {
    if (!row) { s.ctx.notify?.(action === "show" ? `${member.instance} is not in the roster yet.` : `${member.instance} has no terminal to open yet.`); return; }
    if (action === "show") return s.ctx.showInRoster?.(row);
    const expected = instanceActionTarget(view, row);
    return s.ctx.openTerminal(row, { quiet: true, ...(expected ? { expected } : {}) });
  } });
}

/** Execution-server spawn (Developer settings › Run on, or a remote soul). The
 * execution host decides every default and names the instance; nothing here
 * previews or binds a decision for it. Local spawns never come here.
 * Resolves { created: true } once the host created the instance (even if its
 * wake schedule was not saved) — the dialog then never offers a second spawn. */
export async function doSpawn(s, fields) {
  const a = s.selAgent;
  if (!a || !fields?.server) return;
  // Mutations require a VERIFIED compatible CLI, checked at submit time too.
  if (!cliAvailable()) { closeSpawnModal(s); return; }
  const myGen = workspaceGeneration();
  const connection = s.ctx.connectionGeneration?.() ?? 0;
  const myOp = ++s.spawnOp;
  const owns = () => myOp === s.spawnOp && s.alive !== false && myGen === workspaceGeneration() && connection === (s.ctx.connectionGeneration?.() ?? 0);
  const relation = fields.relation || "unrelated";
  if (relation !== "unrelated" && !fields.relativeTo) { fields.status(`The "${relation}" relation needs a reference instance.`, true); return; }
  fields.status(`Spawning on ${fields.server}…`);
  try {
    const d = await postJson(s.ctx, "/api/spawn", {
      // A chosen remote deployment (#482) spawns its own catalog's soul row (the root is that deployment's).
      agent: a.name, agentsRoot: typeof fields.agentsRoot === "string" && fields.agentsRoot ? fields.agentsRoot : a.agentsRoot, serverId: fields.server, task: fields.task || "",
      purpose: fields.purpose || undefined, name: fields.name || undefined, // the dialog sends one: an exact name where the host takes one
      ...(fields.suggestName ? { suggestName: true } : {}), // or neither, and the host names it from its task (spawn-apply-suggest-name)
      relation: relation !== "unrelated" ? relation : undefined,
      relativeTo: relation !== "unrelated" ? fields.relativeTo : undefined,
      relativeRoot: relation !== "unrelated" ? (fields.relativeRoot || undefined) : undefined,
      yolo: fields.yolo, background: fields.background, backend: fields.backend || undefined, harness: fields.harness || undefined,
      model: fields.model || undefined, launchConfig: fields.launchConfig || undefined, wake: fields.wake,
    });
    if (!owns()) return;
    // Numbered where it would have been named from its task: by the host (its `naming`, re-validated), or here before the
    // press (fields.numbered, when nothing asked the host to name it). Said as the local spawn says it.
    const hostNaming = fields.suggestName ? namingOf(d.naming) : null;
    const numbered = hostNaming?.source === 'numbered' ? { reason: hostNaming.reason, harness: null } : !fields.suggestName && fields.numbered ? fields.numbered : null;
    if (numbered && typeof d.instance === "string") s.ctx.notify?.(numberedLine(d.instance, numbered.reason, numbered.harness));
    if (d.wakeScheduleError) {
      const problem = { code: d.wakeScheduleError.code || "E_SCHEDULE", detail: `${d.wakeScheduleError.code || "E_SCHEDULE"} · ${d.wakeScheduleError.message || ""}` };
      fields.status(`Created ${d.instance}, but its wake schedule was not saved. Add it from Schedules.`, true, problem);
      return { created: true };
    }
    if (d.wakeSchedule) s.ctx.notify?.(`Wake schedule saved for ${d.instance}. Check Schedules to verify its host scheduler is enabled.`);
    if (d.routeConflict) {
      fields.status(`Spawned ${d.instance} on ${d.server}, but its name already has a saved route. Manage the new home ${d.home} from the execution host. ${(d.warnings || []).join(" ")}`);
      return { created: true };
    }
    // `workspaceId` is the VIEW holding the new instance's deployment (#482): switch only to another view;
    // a spawn into a deployment of the view on screen (the Deployment field) waits for its row here.
    if (d.workspaceId && d.workspaceId !== (currentWorkspace() || s.workspace?.id)) {
      const ref = { instance: d.instance, home: d.home, server: d.server };
      closeSpawnModal(s);
      await handOff(s, { workspace: d.workspaceId, ref, then: admitted => {
        if (!admitted) { s.ctx.notify?.(`Spawned ${d.instance} on ${d.server}; it is not visible yet. Check the server roster to open it.`); return; }
        if (typeof d.home === "string" && admitted.home === d.home && admitted.agent === a.name) s.ctx.notifySpawn?.(admitted, d.workspaceId, connection);
        s.ctx.openTerminal(ref, { quiet: true });
      } });
      return { created: true };
    }
    if (!d.workspaceId) { fields.status(`Spawned ${d.instance} on ${d.server}. Attach with: oats session attach --server ${d.server} --instance ${d.instance}`); return { created: true }; }
    const ref = { instance: d.instance, home: d.home, server: d.server };
    let admitted;
    const visible = await waitForInstanceInPanel(s, ref, owns, { ...s.waitOpts, onAdmitted: row => { admitted = row; } });
    if (!owns()) return;
    if (!visible) { fields.status(`Spawned ${d.instance} on ${d.server} — the roster is catching up; open it from the sidebar.`); return { created: true }; }
    if (typeof d.home === "string" && admitted?.home === d.home && admitted.agent === a.name) s.ctx.notifySpawn?.(admitted, currentWorkspace(), connection);
    closeSpawnModal(s);
    s.ctx.openTerminal(ref, { quiet: true });
    return { created: true };
  } catch (e) {
    if (!owns()) return;
    const message = String(e?.message || e || "").trim();
    const problem = spawnProblem({ code: e?.code, message }, "spawn");
    // The host decides a remote spawn (its souls, its workspace), so its refusal is said in OATS's own words;
    // this computer's own transport failures (E_CLI_*, cli-*) keep their plain sentence.
    const text = message && typeof e?.code === "string" && !/^(E_CLI_|cli-)/.test(e.code) ? `Couldn’t spawn on ${fields.server}: ${message}` : spawnText(problem, "spawn");
    fields.status(text, true, problem);
  }
}
