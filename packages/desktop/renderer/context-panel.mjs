import { servedIdentityText } from '../../client/deployment-facts.mjs';
import { iconElement } from './shell-icons.mjs';
import { ageText } from './age-text.mjs';
import { createSoulMark, createRuntimeBadge, harnessName } from './identity-marks.mjs';
import { reasonLine, unsupportedLine } from './speaker-line.mjs';
import { desktopActs } from './desktop-acts.mjs';
import { needsInputReportingGap } from '../../client/needs-input-reporting-gap.mjs';
import { rowReason, serverLabel, shownLabel, unaddressableSentence } from '../../client/remote-address.mjs';
let workNotes = 0;
/** Shell-owned contextual surface. Optional Git reads are delegated to an
 * injected controller; this host performs no IO, lookup or lifecycle actions. */
export const contextPanelCSS = `
#context-panel.context-panel { display:flex; flex:0 0 340px; width:340px; min-width:0; min-height:0; flex-direction:column; box-sizing:border-box; overflow:hidden; border-left:1px solid var(--border); background:var(--surface); color:var(--fg); font-weight:normal; font-size:13px; line-height:1.45; font-family:var(--ui-font,-apple-system,"Segoe UI",system-ui,sans-serif); }
#context-panel.context-panel[hidden], #context-panel [hidden] { display:none !important; }
#context-panel .context-panel-header { display:flex; align-items:center; flex:none; height:48px; box-sizing:border-box; border-bottom:1px solid var(--border); padding:0 6px; gap:4px; }
#context-panel .context-panel-tabs { display:flex; flex:1; min-width:0; height:100%; align-items:center; gap:2px; }
#context-panel .context-panel-control { font:inherit; color:var(--muted); background:var(--surface); border:0; border-radius:4px; cursor:pointer; padding:6px; }
#context-panel .context-panel-tab { font-size:12px; white-space:nowrap; min-height:32px; }
#context-panel .context-panel-tab[aria-selected="true"] { color:var(--accent); background:var(--sel); }
#context-panel .context-panel-control:hover { background:var(--surface-2); color:var(--fg); }
#context-panel .context-panel-generic, #context-panel .context-panel-stages { display:flex; flex:1; min-height:0; min-width:0; flex-direction:column; overflow:hidden; }
#context-panel .context-panel-page { flex:1; min-height:0; overflow:auto; padding:16px; box-sizing:border-box; overflow-wrap:anywhere; }
#context-panel .context-panel-page h2 { font-size:14px; margin:0 0 12px; }
#context-panel .context-panel-note { color:var(--muted); }
/* A remote row whose work and build aren't relayed: one muted line in the Work section's place. */
#context-panel .context-panel-work-note { margin:0; font-size:12.5px; line-height:1.5; }
/* v4.1 instance page (board 1): identity header, then labelled sections. */
#context-panel .context-panel-page[data-context-page="instance"], #context-panel .context-panel-page[data-context-page="soul"] { display:flex; flex-direction:column; gap:20px; }
#context-panel .context-panel-page[hidden] { display:none; }
#context-panel .context-panel-identity { display:flex; align-items:center; gap:11px; min-width:0; }
#context-panel .context-panel-identity .identity-mark { width:36px; height:36px; border-radius:9px; font-size:15px; font-weight:700; }
#context-panel .context-panel-identity-copy { display:flex; flex-direction:column; min-width:0; flex:1; }
#context-panel .context-panel-identity-name { font-size:13.5px; font-weight:650; line-height:1.45; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#context-panel .context-panel-identity-sub { display:flex; flex-wrap:wrap; align-items:center; gap:2px 6px; min-width:0; font-size:11.5px; line-height:1.45; color:var(--muted); }
/* "instance of" keeps its place; the soul name (a button, so it ellipsizes its own text) gives way. */
#context-panel .context-panel-soul-line { display:flex; align-items:baseline; gap:.3em; flex:0 1 auto; min-width:0; white-space:nowrap; }
#context-panel .context-panel-soul-line > span { flex:none; }
/* The Instance tab's header is a two-row grid: tile | name (ellipsis) | state, then "instance of <soul>" + the
   drift chip spanning the name and state columns, so the state never squeezes the soul line. */
#context-panel .context-panel-identity.is-instance { display:grid; grid-template-columns:36px minmax(0,1fr) auto; column-gap:11px; align-items:center; }
#context-panel .context-panel-identity.is-instance > .context-panel-mark { grid-column:1; grid-row:1 / span 2; align-self:center; }
#context-panel .context-panel-identity.is-instance > .context-panel-identity-copy { display:contents; }
#context-panel .context-panel-identity.is-instance .context-panel-identity-name { grid-column:2; grid-row:1; }
#context-panel .context-panel-identity.is-instance > .context-panel-state { grid-column:3; grid-row:1; }
#context-panel .context-panel-identity.is-instance .context-panel-identity-sub { grid-column:2 / 4; grid-row:2; flex-wrap:nowrap; }
#context-panel .context-panel-identity-sub:empty { display:none; }
/* "instance of <soul>": the soul name opens the Soul tab. */
#context-panel button.context-panel-soul-link { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; padding:0; border:0; border-radius:3px; background:none; font:inherit; color:var(--accent); cursor:pointer; text-align:left; white-space:nowrap; }
#context-panel button.context-panel-soul-link:hover { text-decoration:underline; }
/* "older build": one neutral chip when the kernel reports drift; its title says what changed. */
#context-panel .context-panel-drift { flex:none; padding:0 6px; border-radius:4px; background:var(--tag-bg); color:var(--fg); font-size:10.5px; font-weight:600; line-height:18px; white-space:nowrap; cursor:default; }
#context-panel .context-panel-state { flex:none; display:flex; align-items:center; gap:5px; font-size:11.5px; font-weight:600; color:var(--muted); white-space:nowrap; }
#context-panel .context-panel-state[data-state="running"] { color:var(--accent); }
#context-panel .context-panel-state::before { content:''; width:7px; height:7px; border-radius:50%; box-sizing:border-box; border:1.5px solid currentColor; }
#context-panel .context-panel-state[data-state="running"]::before { background:currentColor; }
#context-panel .context-panel-section { display:flex; flex-direction:column; gap:8px; min-width:0; }
#context-panel .context-panel-label { display:flex; align-items:center; gap:8px; font-size:10.5px; font-weight:650; line-height:1.45; letter-spacing:.065em; text-transform:uppercase; color:var(--muted); }
/* A section header with tools at its right (Messaging's icon Refresh). */
#context-panel .context-panel-section-head { display:flex; align-items:center; gap:8px; min-width:0; min-height:24px; }
#context-panel .context-panel-tools { display:flex; align-items:center; gap:2px; margin-left:auto; }
#context-panel .context-panel-tools:empty { display:none; }
/* Messaging & Teams: each part under a sentence-case sub-label (not the uppercase section style). */
#context-panel .context-panel-part { display:flex; flex-direction:column; gap:4px; min-width:0; }
#context-panel .context-panel-sublabel { font-size:11.5px; font-weight:600; line-height:1.45; color:var(--muted); }
/* Teams' sub-label sits over the injected section's lead line at the parts' 4px, not the section's 8px gap. */
#context-panel .context-panel-section > .context-panel-sublabel { margin-bottom:-4px; }
/* The messaging ID: one mono line, ellipsis (the full value in its title), plus an icon Copy. */
#context-panel .context-panel-idline { display:flex; align-items:center; gap:6px; min-width:0; }
#context-panel .context-panel-id { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:normal; font-size:12px; line-height:1.45; font-family:var(--ui-font, ui-monospace, Menlo, monospace); color:var(--fg); }
/* Work: one card — the work mode's tile and one sentence (it wraps, never truncates), then the closed Paths. */
#context-panel .context-panel-work { min-width:0; border:1px solid var(--border); border-radius:9px; overflow:hidden; background:var(--surface); }
#context-panel .context-panel-work-main { display:flex; align-items:flex-start; gap:10px; min-width:0; padding:10px 12px; }
#context-panel .context-panel-mode-tile { flex:none; display:grid; place-items:center; width:26px; height:26px; border-radius:7px; background:var(--soul-sage-bg); color:var(--soul-sage-fg); }
#context-panel .context-panel-mode-tile[data-work="directory"], #context-panel .context-panel-mode-tile[data-work="workspace"] { background:var(--soul-slate-bg); color:var(--soul-slate-fg); }
#context-panel .context-panel-work-sentence { flex:1; min-width:0; margin:0; align-self:center; font-size:12.5px; line-height:1.5; color:var(--fg); overflow-wrap:anywhere; }
/* A fact inside the sentence (repo, branch, parent): the mono face, breaking inside only when it cannot fit a line. */
#context-panel .context-panel-fact-code { font-weight:normal; font-size:12px; line-height:1.5; font-family:var(--ui-font, ui-monospace, Menlo, monospace); color:var(--fg); }
#context-panel .context-panel-paths { min-width:0; border-top:1px solid var(--border); padding:8px 12px; }
#context-panel .context-panel-paths > summary { cursor:pointer; font-size:11.5px; font-weight:600; color:var(--muted); }
#context-panel .context-panel-paths[open] > summary { margin-bottom:8px; }
/* Facts: a label column (64px, muted) and a value column; Paths and Lineage share it. */
#context-panel .context-panel-facts { display:grid; grid-template-columns:64px minmax(0,1fr); gap:7px 10px; align-items:center; margin:0; min-width:0; font-size:12px; line-height:1.45; }
#context-panel .context-panel-fact { display:contents; }
#context-panel .context-panel-facts dt { color:var(--muted); }
#context-panel .context-panel-facts dd { margin:0; min-width:0; color:var(--fg); overflow-wrap:anywhere; }
#context-panel .context-panel-facts [data-unreported] { color:var(--muted); }
/* A path: one line, clipped at the start so its meaningful end shows (full value in the title), plus an icon Copy. */
#context-panel .context-panel-pathline { display:flex; align-items:center; gap:6px; min-width:0; }
#context-panel .context-panel-path { flex:1; min-width:0; font-weight:normal; font-size:12px; line-height:1.45; font-family:var(--ui-font, ui-monospace, Menlo, monospace); color:var(--fg); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-align:left; }
/* "shared": the work folder is a link to a tree other instances share (its title says so). */
#context-panel .context-panel-shared-tag { flex:none; padding:0 6px; border-radius:4px; background:var(--tag-bg); color:var(--muted); font-size:10.5px; font-weight:600; line-height:18px; white-space:nowrap; cursor:default; }
#context-panel button.context-panel-copy { flex:none; display:grid; place-items:center; width:22px; height:22px; padding:0; border:0; border-radius:5px; background:transparent; color:var(--muted); cursor:pointer; }
#context-panel button.context-panel-copy:hover { background:var(--surface-2); color:var(--fg); }
#context-panel .context-panel-details { border-top:1px solid var(--border); padding-top:12px; min-width:0; }
#context-panel .context-panel-details > summary { cursor:pointer; font-size:12px; font-weight:650; color:var(--fg); }
#context-panel .context-panel-details[open] > summary { margin-bottom:12px; }
#context-panel .context-panel-detail { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; min-width:0; }
#context-panel .context-panel-detail .context-panel-path { color:var(--muted); }
#context-panel .context-panel-actions { display:flex; gap:8px; flex-wrap:wrap; }
#context-panel .context-panel-actions[hidden] { display:none; }
#context-panel .context-panel-action { font:600 12.5px/1 inherit; height:32px; padding:0 14px; border-radius:7px; background:var(--primary-bg); color:var(--primary-fg); border:1px solid var(--primary-bg); cursor:pointer; }
#context-panel .context-panel-action:disabled { background:var(--surface-2); color:var(--muted); border-color:var(--border); cursor:default; }
/* Session: the harness mark and name, the model and where it came from, the terminal target and its age. */
#context-panel .context-panel-session { display:flex; flex-direction:column; gap:10px; min-width:0; padding:10px 12px; border:1px solid var(--border); border-radius:9px; background:var(--surface); }
#context-panel .context-panel-session-lines { display:flex; align-items:center; gap:10px; min-width:0; }
#context-panel .context-panel-session-note { margin:0; font-size:12px; line-height:1.5; }
#context-panel .context-panel-session-badge { flex:none; }
#context-panel .context-panel-session-badge:empty { display:none; }
#context-panel .context-panel-session-badge .runtime-badge { width:26px; height:26px; border-radius:7px; font-size:11px; }
#context-panel .context-panel-session-copy { display:flex; flex-direction:column; min-width:0; flex:1; }
#context-panel .context-panel-session-harness { font-size:13px; font-weight:600; color:var(--fg); }
#context-panel .context-panel-session-model { font-size:11.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#context-panel .context-panel-session-from::before { content:' · '; }
#context-panel .context-panel-session-side { display:flex; flex-direction:column; align-items:flex-end; flex:none; max-width:45%; font-size:11.5px; color:var(--muted); text-align:right; }
#context-panel .context-panel-session-tmux { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:normal; font-size:11.5px; line-height:normal; font-family:var(--ui-font, ui-monospace, Menlo, monospace); color:var(--fg); }
#context-panel .context-panel-footer { display:flex; gap:8px; flex:none; padding:12px 16px; border-top:1px solid var(--border); background:var(--surface); }
#context-panel .context-panel-footer-act { flex:1 1 0; min-width:0; height:32px; box-sizing:border-box; padding:0 10px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font:600 12.5px/1 inherit; cursor:pointer; }
#context-panel .context-panel-footer-act:hover:not(:disabled) { background:var(--surface-2); }
#context-panel .context-panel-footer-act.danger { color:var(--danger); }
#context-panel .context-panel-footer-act:disabled { color:var(--muted); cursor:default; }
/* A row that offers no lifecycle action (blocked, instance-acts.mjs): one muted line saying why, in the controls' place. */
#context-panel .context-panel-footer-note { flex:1; min-width:0; margin:0; font-size:12.5px; line-height:1.5; overflow-wrap:anywhere; }
/* Soul tab: "Open soul page" is an outline control at the page foot. */
#context-panel .context-panel-page[data-context-page="soul"] .context-panel-actions { margin-top:auto; }
#context-panel .context-panel-open-soul:not(:disabled) { flex:1; background:var(--surface); color:var(--fg); border-color:var(--border); }
#context-panel .context-panel-open-soul:hover:not(:disabled) { background:var(--surface-2); }
/* Tabs read like the Workspace header's: underlined, no fill. */
#context-panel .context-panel-header { padding:0 6px 0 16px; gap:18px; }
#context-panel .context-panel-tabs { gap:18px; align-items:stretch; }
#context-panel .context-panel-tab { height:100%; min-height:0; padding:0; border-radius:0; font-size:12.5px; color:var(--nav-fg); background:none; }
#context-panel .context-panel-tab:hover { background:none; color:var(--fg); }
#context-panel .context-panel-tab[aria-selected="true"] { color:var(--fg); background:none; font-weight:650; box-shadow:inset 0 -2px 0 var(--live); }
/* W6: the Developer tab's (Git and GitHub) count of unresolved review threads (design: "Developer 2"). */
#context-panel .context-panel-tab-count { margin-left:5px; color:var(--muted); font-weight:400; font-size:10.5px; line-height:normal; font-family:var(--ui-font, ui-monospace, Menlo, monospace); }
#context-panel .context-panel-tab-count:empty { display:none; }
#context-panel .context-panel-stage.oats-view { display:flex; flex:1; flex-direction:column; width:100%; min-width:0; min-height:0; overflow:auto; background:var(--surface); }
#context-panel .context-panel-stage > * { max-width:100%; box-sizing:border-box; }
`;

const noop = () => {};
const inertLease = () => ({ setPresent: noop, isVisible: () => false, collapse: noop, dispose: noop });
const inertPanel = () => ({
  setContext: noop, attach: inertLease, release: noop, toggle: noop, setCollapsed: noop,
  setFocusMode: noop, toggleFocusMode: noop, isFocusMode: () => false, focus: () => false,
  state: () => ({ present: false, open: false, changes: false }), dispose: noop,
});
/** Where the model came from (modelFrom, desktop-facts); null (a pre-0.29 home) says nothing.
 * 0.30 launch preferences add this computer's override for the soul (`local`) and for every soul
 * (`local-default`), in the soul page's words (launch-view.mjs). An unknown value says nothing. */
const MODEL_FROM = Object.freeze({ __proto__: null, soul: "the soul's choice", spawn: 'chosen at spawn', start: 'chosen at start', 'launch-config': 'from the launch configuration', 'harness-default': "the harness's default",
  local: 'set for this soul on this computer', 'local-default': "this computer's default for every soul" });
/** Work modes in one plain sentence (Spec A): the tile's icon and what the mode means for this
 * instance. `sentence(facts)` returns its parts: strings, and `{ code }` for a roster row's own
 * fact (repo, branch, parent), shown in the mono face. An unreported fact says the generic words,
 * never an invented name. */
const WORK_MODES = Object.freeze({ __proto__: null,
  worktree: { icon: 'branch', sentence: ({ repo, branch }) => ['Works in its own worktree of ', ...(repo ? [{ code: repo }] : ["its soul's repository"]),
    ...(branch ? [', on branch ', { code: branch }] : []), '.'] },
  checkout: { icon: 'branch', sentence: ({ repo }) => ['Works in the shared checkout of ', ...(repo ? [{ code: repo }] : ["its soul's repository"]),
    ', alongside the other instances that use it.'] },
  attached: { icon: 'link', sentence: ({ parent }) => ['Works in ', ...(parent ? [{ code: parent }, "'s tree"] : ["its parent's tree"]), ', sharing its branch and changes.'] },
  directory: { icon: 'folder', sentence: () => ['Has its own folder, not tied to one repository: free to work across repos as its task needs.'] },
  workspace: { icon: 'layers', sentence: () => ['Sees the whole workspace: reads across every member repository.'] } });
/** Modes whose <home>/work is a link to a tree other instances share (the kernel symlinks it). */
const LINKED = new Set(['checkout', 'attached', 'workspace']);
/** The repository the Work sentence names: a local row's repoName; a remote row's own `repo` (a host
 * path, its last segment, for display only: a remote row's repoName is its server's label). */
function workRepo(instance) {
  if (!instance?.server) return instance?.repoName;
  return typeof instance.repo === 'string' ? instance.repo.replace(/\/+$/, '').split('/').pop() : null;
}
/** Why a remote row shows no work and build, or null for a local row or a remote row that reports it. A row
 * the kernel built from its saved route alone (the host no longer lists it, or wasn't reached) has every fact
 * null, which says nothing about the host's OATS: it says why first. Then this computer's OATS predates the
 * relay (no `work` key), or the host doesn't report it (`work: null`). */
export function remoteWorkNote(instance) {
  if (!instance?.server || typeof instance.work === 'string') return null;
  const label = serverLabel(instance);
  if (instance.missingRemotely === true) return unaddressableSentence(instance);
  if (instance.serverUnreached) return `${shownLabel(label, true)} wasn't reached, so this instance's work and build aren't known.`;
  if (!Object.hasOwn(instance, 'work')) return `This computer's OATS doesn't show the work and build of instances on ${shownLabel(label)}. Update OATS here.`;
  return instance.work === null ? `${shownLabel(label, true)} doesn't report this instance's work and build. Update OATS on ${shownLabel(label)}.` : null;
}
/** The folder an instance works in: <home>/work in every mode (a real folder for worktree and
 * directory, a link to the shared tree otherwise). Joined with the home's own separator, so a
 * Windows home stays a Windows path; null without a home. */
function workFolder(home) {
  if (typeof home !== 'string' || !home) return null;
  const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/';
  return `${home.replace(/[\\/]+$/, '')}${sep}work`;
}
/** How long ago, compactly ("42m", "3h", "2d"); null when not a timestamp. */
function shortAge(iso, now = Date.now()) {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const m = Math.max(0, Math.floor((now - at) / 60000));
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
/** The "older build" chip's tooltip, in plain words, from the kernel's drift (a soul status or module
 * rows other than current). null when current, unreported, or a recorded map (drift not observed). */
export function driftText(instance) {
  const drifted = status => typeof status === 'string' && status !== 'current';
  const said = [], soul = instance?.soul;
  if (soul && typeof soul === 'object' && drifted(soul.status)) said.push(soul.status === 'moved'
    ? "Its soul's repository has moved on since it was spawned." : soul.status === 'missing'
      ? 'The soul commit it was spawned from is no longer found.' : `Its soul is ${soul.status}.`);
  if (Array.isArray(instance?.modules)) for (const row of instance.modules) {
    if (!row || typeof row !== 'object' || !drifted(row.status)) continue;
    const name = typeof row.name === 'string' && row.name ? row.name : 'A capability';
    const now = typeof row.current?.version === 'string' ? row.current.version : null, was = typeof row.from?.version === 'string' ? row.from.version : null;
    said.push(row.status === 'moved' ? `${name} has changed since${now ? ` (${was ? `${was} → ` : 'now '}${now})` : ''}.`
      : row.status === 'missing' ? `${name} is no longer available${typeof row.reason === 'string' && row.reason ? ` (${row.reason})` : ''}.` : `${name} is ${row.status}.`);
  }
  if (!said.length) return null;
  return ['Built from an older state of the workspace:', ...said.map(line => `• ${line}`), 'Re-spawning picks up the new state; this instance keeps what it was built with.'].join('\n');
}
const reported = value => typeof value === 'string' && value.length ? value
  : typeof value === 'number' && Number.isFinite(value) ? String(value)
    : typeof value === 'boolean' ? String(value) : 'Not reported';

/**
 * setContext is the ONLY foreground selector; attach never selects an owner.
 * workspace and key are exact, opaque identities supplied by the shell.
 * An attached slot starts present. setPresent only changes that slot's presence,
 * never the current context or whether the user left the panel open.
 *
 * Open or closed (Spec B): a closed panel is hidden, taking no width, with no rail. Instance details
 * follow ONE per-machine preference (`instanceOpen`: read and write it; absent means closed), changed
 * only by panel.toggle, the shell's Show instance panel and the panel's own close button; selecting an
 * instance never opens it. A stage's content (the Workspace soul inspector) keeps its own per-workspace
 * state, open by default: selecting a soul inspects it, and its X closes it. `onChange(state)` hears
 * every projection (and the Developer page's change mark), from construction on: whether there is
 * content (`present`), whether it is shown (`open`), and whether the Developer page would show its
 * change dot (`changes`).
 *
 * Leases are bound to the workspace generation in which attach was called.
 * Workspace changes clear presence synchronously, retaining the real DOM. To
 * reuse a retained stage on a later visit, attach(owner, sameElement) renews its
 * lease without rebuilding it. Old callbacks (including A → B → A completions)
 * cannot revive presence or dispose the renewed lease. Callers must guard their
 * own asynchronous content writes; this module owns visibility, not their forms.
 */
/** The deployment the panel's instance belongs to (#482): its roster row's `deployment.id`, else the
 * workspace (a row served before views belonged to the selected workspace, then a deployment). */
export function instanceDeployment(context) {
  const id = context?.instance?.deployment?.id;
  return typeof id === 'string' && id ? id : context?.workspace ?? null;
}

export function createContextPanel({
  document: suppliedDocument, root: suppliedRoot, onIntent = noop,
  applyFocus = callback => callback(), onFocusModeChange = noop, fallbackFocus = () => null, closedFocus = () => null, createGitPanel, createTeamsSection, createSoulSection, openSoul, lifecycle = null,
  connectionGeneration = () => 0, subscribeConnections = () => noop, instanceOpen = { read: () => true, write: noop }, onChange = noop,
} = {}) {
  const document = suppliedDocument ?? suppliedRoot?.ownerDocument ?? globalThis.document;
  const root = suppliedRoot ?? document?.getElementById('context-panel');
  if (!document || !root) return inertPanel();

  let disposed = false, focusMode = false, applyingFocus = false, epoch = 0;
  let detailsOpen = false;
  try { detailsOpen = instanceOpen.read() === true; } catch { /* storage-less: closed */ }
  let context = { workspace: null, owner: null, instance: null, key: null };
  let gitSummary = null, prSummary = null, gitChanged = false, notified = false;
  const contextIdentity = () => JSON.stringify([context.workspace, context.key, context.instance?.home, context.instance?.agent,
    context.instance?.agentsRoot, context.instance?.server || null, context.instance?.createdAt ?? null]);
  const preferences = new Map(); // Only chrome preferences, never selection: the selected page, a stage's open state.
  const slots = new Map();
  const app = document.getElementById('app');
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  // Controls carry a decorative app icon; the aria-label/title name them.
  const control = (className, iconName, label, click) => {
    const el = node('button', `context-panel-control ${className}`);
    if (iconName) el.append(iconElement(document, iconName, { size: 15 }));
    el.type = 'button'; el.setAttribute('aria-label', label); el.title = label;
    el.addEventListener('click', click);
    return el;
  };
  const pref = () => {
    if (!preferences.has(context.workspace)) preferences.set(context.workspace, { collapsed: false, tab: 'instance' });
    return preferences.get(context.workspace);
  };
  const visible = el => {
    if (!el?.isConnected || el.disabled) return false;
    for (let current = el; current; current = current.parentElement) {
      if (current.hidden || current.inert) return false;
      // A closed <details> renders only its summary (the Paths disclosure's Copy controls).
      if (current !== el && current.localName === 'details' && !current.open && !current.querySelector(':scope > summary')?.contains(el)) return false;
      const style = document.defaultView?.getComputedStyle(current);
      if (style?.display === 'none' || style?.visibility === 'hidden') return false;
    }
    return true;
  };
  const projectFocus = callback => {
    const previous = applyingFocus; applyingFocus = true;
    try { return applyFocus(callback); }
    finally { applyingFocus = previous; }
  };
  const focus = el => {
    if (visible(el)) projectFocus(() => el.focus({ preventScroll: true }));
  };
  const generic = node('div', 'context-panel-generic');
  const header = node('div', 'context-panel-header');
  const tablist = node('div', 'context-panel-tabs');
  tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', 'Instance context');
  const collapse = control('context-panel-collapse', 'close', 'Close the instance panel', event => {
    if (!disposed && visible(event.currentTarget)) { onIntent(event); setCollapsed(true); }
  });
  collapse.setAttribute('aria-expanded', 'true'); collapse.setAttribute('aria-controls', 'context-panel');
  header.append(tablist, collapse); generic.append(header);
  const tabs = new Map(), pages = new Map();
  for (const [id, label] of [['instance', 'Instance'], ['soul', 'Soul'], ['git', 'Developer']]) {
    const tab = control('context-panel-tab', null, label, event => selectTab(id, event)); tab.textContent = label;
    tab.id = `context-panel-tab-${id}`; tab.dataset.contextTab = id;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `context-panel-page-${id}`);
    tab.addEventListener('keydown', event => {
      const ids = [...tabs.keys()], index = ids.indexOf(id);
      const next = event.key === 'ArrowRight' ? (index + 1) % ids.length
        : event.key === 'ArrowLeft' ? (index + ids.length - 1) % ids.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : null;
      if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); selectTab(ids[next], event); focus(tabs.get(ids[next]));
    });
    if (id === 'git') { const count = node('span', 'context-panel-tab-count'); count.setAttribute('aria-hidden', 'true'); tab.append(count); }
    tabs.set(id, tab); tablist.append(tab);
    const page = node('section', 'context-panel-page');
    page.id = `context-panel-page-${id}`; page.dataset.contextPage = id;
    page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', tab.id); page.tabIndex = 0;
    pages.set(id, page); generic.append(page);
  }
  const fields = new Map();
  // Instance page (v4.1 board 1): identity header — soul mark, name, "instance
  // of <soul>" (+ "older build" on drift), state — then Work, Session,
  // Messaging & Teams and Lineage. Every value is the roster row's own reported fact;
  // an unreported fact keeps "Not reported" in its field and hides its row.
  const identityHeader = (pageId) => {
    const wrap = node('div', 'context-panel-identity'), mark = node('span', 'context-panel-mark');
    const copy = node('div', 'context-panel-identity-copy');
    wrap.append(mark, copy); pages.get(pageId).append(wrap);
    return { wrap, mark, copy };
  };
  const section = (pageId, label) => {
    const el = node('section', 'context-panel-section'); el.append(node('div', 'context-panel-label', label));
    pages.get(pageId).append(el); return el;
  };
  const field = (tag, className, id) => { const el = node(tag, className, 'Not reported'); el.dataset.contextField = id; fields.set(id, el); return el; };
  pages.get('instance').dataset.contextPage = 'instance'; pages.get('soul').dataset.contextPage = 'soul';
  const instanceHead = identityHeader('instance'); instanceHead.wrap.classList.add('is-instance');
  // "instance of <soul>": the soul name opens the Soul tab; the drift chip follows it.
  const instanceSub = node('div', 'context-panel-identity-sub'), soulLine = node('span', 'context-panel-soul-line');
  const soulLink = node('button', 'context-panel-soul-link'); soulLink.type = 'button'; soulLink.dataset.contextSoulLink = '';
  soulLink.title = 'Show the Soul tab';
  soulLink.addEventListener('click', event => { selectTab('soul', event); focus(tabs.get('soul')); });
  soulLine.append(node('span', null, 'instance of'), soulLink);
  const drift = node('span', 'context-panel-drift', 'older build'); drift.dataset.contextDrift = ''; drift.setAttribute('role', 'note');
  instanceSub.append(soulLine, drift);
  instanceHead.copy.append(field('div', 'context-panel-identity-name', 'instance'), instanceSub);
  // State at the right: "Running · 42m" (the age of the last start) or "Stopped".
  const state = node('span', 'context-panel-state'), stateAge = node('span', 'context-panel-state-age');
  state.append(field('span', null, 'running'), stateAge);
  instanceHead.copy.after(state);
  // A path shows its meaningful end (clipped at the start, full in the title)
  // with an icon Copy control; the field keeps the full reported value.
  const copyControl = (id, label) => {
    const b = node('button', 'context-panel-copy'); b.type = 'button'; b.dataset.copy = id;
    const say = (text, icon) => { b.setAttribute('aria-label', text); b.title = text; b.replaceChildren(iconElement(document, icon, { size: 13 })); };
    say(label, 'copy');
    b.addEventListener('click', async () => {
      const text = fields.get(id)?.textContent;
      if (!text || text === 'Not reported') return;
      try { await document.defaultView?.navigator?.clipboard?.writeText(text); say('Copied', 'check'); } catch { say('Copy failed', 'copy'); }
      setTimeout(() => { if (b.isConnected) say(label, 'copy'); }, 1500);
    });
    return b;
  };
  // own: the line is its own row (hidden when unreported); otherwise its fact row is.
  const pathLine = (id, label, { own = true } = {}) => {
    const line = node('div', 'context-panel-pathline'), clip = node('div', 'context-panel-path');
    clip.dir = 'rtl'; clip.append(field('bdi', null, id)); line.append(clip, copyControl(id, label));
    if (own) { line.dataset.row = id; rows.set(id, line); }
    return line;
  };
  const rows = new Map();
  // Facts: a label column and a value column. Only what the instance reported:
  // an unreported fact hides its row, and a section with no reported row hides.
  const factRow = (dl, id, label, value) => {
    const row = node('div', 'context-panel-fact'); row.dataset.row = id; rows.set(id, row);
    row.append(node('dt', null, label), value); dl.append(row); return row;
  };
  function facts(host, entries) {
    const dl = node('dl', 'context-panel-facts');
    for (const [id, label] of entries) factRow(dl, id, label, field('dd', null, id));
    host.append(dl); return dl;
  }
  // Work (Spec A): one card — the work mode's tile and one sentence saying what the mode means
  // for this instance, then Folder and Home behind a closed Paths disclosure (an operator's lookup).
  const workSection = section('instance', 'Work');
  const workCard = node('div', 'context-panel-work'), workMain = node('div', 'context-panel-work-main');
  const modeTile = node('span', 'context-panel-mode-tile'), workSentence = node('p', 'context-panel-work-sentence');
  modeTile.setAttribute('aria-hidden', 'true'); workSentence.dataset.contextWork = '';
  workMain.append(modeTile, workSentence);
  // Paths: built once and never rebuilt on repaint (the browser owns its open state and a focused
  // Copy inside it); it closes when the selected instance changes.
  const paths = node('details', 'context-panel-paths'); paths.append(node('summary', null, 'Paths'));
  const pathFacts = node('dl', 'context-panel-facts');
  // Folder: <home>/work, where it works; "shared" when that is a link to a shared tree.
  const folderValue = node('dd'), folderLine = pathLine('workFolder', 'Copy folder path', { own: false });
  const sharedTag = node('span', 'context-panel-shared-tag', 'shared'); sharedTag.dataset.contextShared = '';
  sharedTag.title = 'A link to the shared tree; changes here are visible to every instance that shares it.';
  sharedTag.setAttribute('role', 'note'); sharedTag.setAttribute('aria-label', `shared: ${sharedTag.title}`);
  folderLine.lastChild.before(sharedTag); folderValue.append(folderLine);
  factRow(pathFacts, 'workFolder', 'Folder', folderValue);
  // Home: the instance home, where its own files live.
  const homeValue = node('dd'); homeValue.append(pathLine('home', 'Copy home path', { own: false }));
  factRow(pathFacts, 'home', 'Home', homeValue);
  paths.append(pathFacts); workCard.append(workMain, paths); workSection.append(workCard);
  // A remote row without its work facts: one muted line where the Work section stands (no card, no guess).
  const workNote = node('p', 'context-panel-note context-panel-work-note'); workNote.dataset.contextWorkNote = ''; workNote.hidden = true;
  workSection.after(workNote);
  // #1131: beside the remedy of a row its host no longer lists, the act it names: Forget…, the same
  // confirmation as the roster menu's (forget-dialog.mjs; nothing runs here).
  const forgetActions = node('div', 'context-panel-actions'); forgetActions.dataset.contextForget = ''; forgetActions.hidden = true;
  const forgetControl = node('button', 'context-panel-action', 'Forget…'); forgetControl.type = 'button'; forgetControl.dataset.lifecycle = 'forget';
  forgetControl.addEventListener('click', event => {
    const instance = context.instance;
    if (disposed || !hasGeneric() || !instance || typeof lifecycle?.forget !== 'function' || forgetActions.hidden || forgetControl.disabled) return;
    onIntent(event); lifecycle.forget(instance, context.workspace);
  });
  // Described by the remedy above it, which names the instance and the server.
  workNote.id = `context-panel-work-note-${++workNotes}`; forgetControl.setAttribute('aria-describedby', workNote.id);
  forgetActions.append(forgetControl); workNote.after(forgetActions);
  let workKey = null;
  // Session: the harness (and model) it runs, its terminal session and age.
  const session = section('instance', 'Session');
  const sessionCard = node('div', 'context-panel-session');
  const sessionLines = node('div', 'context-panel-session-lines');
  const sessionNote = node('p', 'context-panel-session-note context-panel-note'); sessionNote.hidden = true;
  const sessionBadge = node('span', 'context-panel-session-badge'); sessionBadge.setAttribute('aria-hidden', 'true');
  const sessionCopy = node('div', 'context-panel-session-copy');
  // "<model> · <where the choice came from>" on one line under the harness.
  const modelLine = node('span', 'context-panel-session-model');
  modelLine.append(field('span', null, 'model'), field('span', 'context-panel-session-from', 'modelFrom'));
  sessionCopy.append(field('span', 'context-panel-session-harness', 'harness'), modelLine);
  const sessionSide = node('div', 'context-panel-session-side');
  const tmuxLine = node('span', 'context-panel-session-tmux'); const createdLine = node('span', 'context-panel-session-age');
  createdLine.append('created ', field('span', null, 'createdAt'));
  // desktop-facts: the last session start; the spawn time moves to its title.
  const startedLine = node('span', 'context-panel-session-age'); startedLine.dataset.age = 'started';
  startedLine.append('started ', field('span', null, 'startedAt'));
  sessionSide.append(tmuxLine, startedLine, createdLine);
  sessionLines.append(sessionBadge, sessionCopy, sessionSide);
  sessionCard.append(sessionLines, sessionNote); session.append(sessionCard);
  // Messaging & Teams (teams contract): injected like Git — this host performs no IO.
  // Header: the label and a tools slot (the section's icon Refresh); then two
  // labelled parts: the Messaging ID (with an icon Copy), then Teams, whose lead
  // line and card the injected section mounts after its sub-label.
  const teamsHost = node('section', 'context-panel-section'); teamsHost.dataset.contextSection = 'teams'; teamsHost.hidden = true;
  const teamsHead = node('div', 'context-panel-section-head'), teamsTools = node('div', 'context-panel-tools');
  teamsHead.append(node('div', 'context-panel-label', 'Messaging & Teams'), teamsTools);
  const idPart = node('div', 'context-panel-part'), idLine = node('div', 'context-panel-idline');
  idLine.append(field('span', 'context-panel-id', 'identity'), copyControl('identity', 'Copy messaging ID'));
  idPart.append(node('div', 'context-panel-sublabel', 'Messaging ID'), idLine); idPart.dataset.row = 'identity'; rows.set('identity', idPart);
  const teamsLabel = node('div', 'context-panel-sublabel', 'Teams'); teamsLabel.dataset.contextTeamsLabel = '';
  teamsHost.append(teamsHead, idPart, teamsLabel); pages.get('instance').append(teamsHost);
  const teamsSection = typeof createTeamsSection === 'function' ? createTeamsSection(teamsHost, { tools: teamsTools,
    onPresence(present) { if (!disposed) teamsHost.hidden = !present; } }) : null;
  const lineage = section('instance', 'Lineage');
  facts(lineage, [['parentInstance', 'Parent'], ['siblingInstance', 'Sibling']]);
  const soulHead = identityHeader('soul');
  const soulSub = field('div', 'context-panel-identity-sub', 'description');
  soulHead.copy.append(field('div', 'context-panel-identity-name', 'agent'), soulSub);
  const soulActions = node('div', 'context-panel-actions');
  const openSoulControl = node('button', 'context-panel-action context-panel-open-soul', 'Open soul page'); openSoulControl.type = 'button';
  openSoulControl.title = "Open this instance's soul in the Workspace view"; openSoulControl.dataset.action = 'soul.open';
  openSoulControl.addEventListener('click', event => {
    if (disposed || !hasGeneric() || typeof openSoul !== 'function' || !context.instance?.agent) return;
    onIntent(event); openSoul({ workspace: context.workspace, name: context.instance.agent, agentsRoot: context.instance.agentsRoot, server: context.instance.server || undefined });
  });
  soulActions.append(openSoulControl);
  const soulDetails = node('details', 'context-panel-details'); soulDetails.append(node('summary', null, 'Details'));
  const rootRow = node('div', 'context-panel-detail'); rootRow.append(node('div', 'context-panel-label', 'Agents root'), pathLine('agentsRoot', 'Copy agents root path'));
  // Workspace v4 (W6): the soul as this instance was spawned from it — injected like Teams (this host performs no IO).
  // The roster-derived header above stays put; the section owns the body under it (its skeleton, its
  // content, its failure), so nothing is swapped or prepended when the read lands (desktop/loading-states).
  const soulBody = node('div', 'context-panel-soul-body');
  soulDetails.append(rootRow); pages.get('soul').append(soulBody, soulDetails, soulActions);
  const soulSection = typeof createSoulSection === 'function' ? createSoulSection(soulBody, { onPresence() {} }) : null;
  const gitPanel = typeof createGitPanel === 'function' ? createGitPanel(pages.get('git'), { applyFocus: projectFocus,
    onObservation(summary) {
      if (disposed) return;
      gitSummary = summary && summary.identity === contextIdentity() && summary.connection === connectionGeneration() ? { ...summary } : null;
      paintGitDot();
    },
    onPullRequest(summary) {
      if (disposed) return;
      prSummary = summary && summary.identity === contextIdentity() && summary.connection === connectionGeneration() ? { ...summary } : null;
      paintGitDot();
    },
  }) : null;
  function paintGitDot() {
    const changed = hasGeneric() && gitSummary?.identity === contextIdentity() && gitSummary.connection === connectionGeneration() && gitSummary.changed === true;
    gitChanged = changed;
    // The PR's unresolved review threads, as reported; unknown (null) or none shows nothing.
    const threads = hasGeneric() && prSummary?.identity === contextIdentity() && prSummary.connection === connectionGeneration()
      && Number.isSafeInteger(prSummary.unresolvedThreads) && prSummary.unresolvedThreads > 0 ? prSummary.unresolvedThreads : 0;
    const said = threads ? `${threads} unresolved review thread${threads === 1 ? '' : 's'}` : '';
    const count = tabs.get('git').querySelector('.context-panel-tab-count'); count.textContent = threads ? String(threads) : '';
    if (said) tabs.get('git').setAttribute('aria-label', `Developer, ${said}`); else tabs.get('git').removeAttribute('aria-label');
    if (changed !== notified) { notified = changed; notify(); }
  }
  if (!gitPanel) pages.get('git').append(node('h2', null, 'Developer'), node('p', 'context-panel-note',
    'Integration unavailable. This host has no K1 Git reader. No changes, diffs, pull requests, or checks are reported here.'));
  // Workspace v4 (W6): the instance's lifecycle at the foot of its page — the
  // same plan-backed dialogs as the roster's action menu (nothing runs here).
  const footer = node('div', 'context-panel-footer');
  const lifecycleButton = (op, label, cls = '') => {
    const b = node('button', `context-panel-footer-act${cls ? ` ${cls}` : ''}`, label); b.type = 'button'; b.dataset.lifecycle = op;
    b.addEventListener('click', event => {
      const instance = context.instance;
      if (disposed || !hasGeneric() || !instance || typeof lifecycle?.[op] !== 'function' || b.disabled) return;
      onIntent(event); lifecycle[op](instance, context.workspace);
    });
    footer.append(b); return b;
  };
  const restartControl = lifecycleButton('restart', 'Restart…'), startControl = lifecycleButton('start', 'Start…');
  const stopControl = lifecycleButton('stop', 'Stop…'), retireControl = lifecycleButton('retire', 'Retire…', 'danger');
  const actionsNote = node('p', 'context-panel-note context-panel-footer-note'); actionsNote.dataset.contextActionsNote = ''; actionsNote.hidden = true;
  footer.append(actionsNote);
  generic.append(footer);
  const stages = node('div', 'context-panel-stages');
  root.classList.add('context-panel');
  if (!root.hasAttribute('aria-label')) root.setAttribute('aria-label', 'Context panel');
  root.append(generic, stages);

  const currentSlot = () => context.owner == null ? null : slots.get(context.owner);
  const slotPresent = slot => !!slot && slot.epoch === epoch && slot.present;
  function hasGeneric() { return context.owner == null && (context.instance != null || context.key != null); }
  const hasContent = () => context.owner != null ? slotPresent(currentSlot()) : hasGeneric();
  /** Closed by the user: instance details by the per-machine preference, a stage's content by its workspace's. */
  const closed = () => hasGeneric() ? !detailsOpen : pref().collapsed;
  const panelState = () => ({ present: !disposed && hasContent(), open: !disposed && !root.hidden, changes: !disposed && gitChanged });
  const notify = () => { if (!disposed) onChange(panelState()); };
  function render() {
    const present = !disposed && hasContent();
    const expanded = present && !focusMode && !closed();
    root.hidden = !expanded;
    paintGitDot();
    generic.hidden = !expanded || !hasGeneric();
    stages.hidden = !expanded || context.owner == null;
    for (const slot of slots.values()) slot.wrapper.hidden = !expanded || slot !== currentSlot() || !slotPresent(slot);
    for (const [id, tab] of tabs) {
      const selected = pref().tab === id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      pages.get(id).hidden = !selected;
    }
    footer.hidden = !expanded || !hasGeneric() || pref().tab !== 'instance' || !context.instance || !lifecycle;
    notify();
    // The sections read and act on ONE instance: they are addressed to its own deployment (#482), never
    // the workspace view (context.workspace stays the panel's owner and preference key).
    const deployment = instanceDeployment(context);
    gitPanel?.update({ active: expanded && hasGeneric() && pref().tab === 'git',
      workspace: deployment, instance: context.instance, key: context.key });
    soulSection?.update({ active: expanded && hasGeneric() && pref().tab === 'soul',
      workspace: deployment, instance: context.instance, key: context.key });
    teamsSection?.update({ active: expanded && hasGeneric() && pref().tab === 'instance',
      workspace: deployment, instance: context.instance, key: context.key });
  }
  // Restore only when this projection hides/removes the focused container.
  // Never focus a newly selected instance or form during background polling.
  function project(change, changed = noop) {
    if (disposed) return;
    const active = document.activeElement;
    const inside = root.contains(active);
    const inSidebar = document.getElementById('sidebar')?.contains(active);
    // Focus already lost (the palette removes its input before running a command) counts too, but only on
    // an explicit focus-mode change, so a command never leaves focus on <body>.
    const lost = !active || active === document.body || !active.isConnected;
    const wasFocusMode = focusMode;
    change(); render(); changed();
    // Closed by the user with focus inside: the shell's Show instance panel takes it. Hidden by focus
    // mode or because there is nothing to show: the shell's stable target (the active tab, …).
    if (inside && !visible(active) && root.hidden && !focusMode && hasContent()) focus(closedFocus() || fallbackFocus());
    else if ((inside && !visible(active)) || (inSidebar && !wasFocusMode && focusMode) || (lost && wasFocusMode !== focusMode)) {
      focus(fallbackFocus());
    }
  }
  function projectMetadata() {
    const instance = context.instance ?? {};
    // Header: the soul mark, "instance of <soul>" and the drift chip omit what the row did not report.
    const soul = typeof instance.agent === 'string' && instance.agent ? { name: instance.agent, agentsRoot: instance.agentsRoot } : null;
    const markKey = JSON.stringify([soul?.name ?? null, soul?.agentsRoot ?? null]);
    for (const head of [instanceHead, soulHead]) if (head.mark.dataset.markKey !== markKey) {
      head.mark.dataset.markKey = markKey; head.mark.replaceChildren(...(soul ? [createSoulMark(document, soul)] : []));
    }
    const agent = typeof instance.agent === 'string' && instance.agent ? instance.agent : '';
    if (soulLink.textContent !== agent) { soulLink.textContent = agent; soulLink.title = agent ? `${agent}: show the Soul tab` : 'Show the Soul tab'; }
    soulLine.hidden = !agent;
    const drifted = driftText(instance);
    drift.hidden = !drifted; drift.title = drifted || '';
    if (drifted) drift.setAttribute('aria-label', `older build: ${drifted}`); else drift.removeAttribute('aria-label');
    // Work: the mode's tile and its sentence, rebuilt only when its words change (a fact arriving
    // later rewrites the sentence in place); an unknown or unreported mode hides the section.
    const work = WORK_MODES[instance.work] ? instance.work : null;
    workSection.hidden = !work;
    const note = remoteWorkNote(instance) ?? '';
    if (workNote.textContent !== note) workNote.textContent = note;
    workNote.hidden = !note;
    // Strictly a row whose reason is `missing` (remote-address.mjs): an unknown, unreached or other row offers no Forget.
    const forgets = !!note && typeof lifecycle?.forget === 'function' && rowReason(instance)?.key === 'missing';
    forgetActions.hidden = !forgets;
    if (work && modeTile.dataset.work !== work) {
      modeTile.dataset.work = work; modeTile.replaceChildren(iconElement(document, WORK_MODES[work].icon, { size: 14 }));
    }
    const fact = value => typeof value === 'string' && value ? value : null;
    const parts = work ? WORK_MODES[work].sentence({ repo: fact(workRepo(instance)), branch: fact(instance.branch), parent: fact(instance.parentInstance) }) : [];
    const key = JSON.stringify(parts);
    if (workKey !== key) {
      workKey = key;
      workSentence.replaceChildren(...parts.map(part => {
        if (typeof part === 'string') return part;
        const code = node('span', 'context-panel-fact-code', part.code); code.title = part.code; return code;
      }));
    }
    // Session card: the harness mark and name, the model, the terminal session.
    const reportingGap = needsInputReportingGap(instance);
    sessionNote.textContent = reportingGap ? `This agent's Claude questions and permission requests don't show as needs input: its oats.core (oats.framework ${reportingGap}) is older than 2.4.0. Upgrade or respawn it to report them.` : '';
    sessionNote.hidden = !reportingGap;
    const harness = typeof instance.harness === 'string' && instance.harness ? instance.harness : null;
    if (sessionBadge.dataset.harness !== (harness ?? '')) { sessionBadge.dataset.harness = harness ?? ''; sessionBadge.replaceChildren(...(harness ? [createRuntimeBadge(document, harness)] : [])); }
    const tmux = typeof instance.tmux?.session === 'string' && instance.tmux.session ? `tmux · ${instance.tmux.session}` : '';
    if (tmuxLine.textContent !== tmux) tmuxLine.textContent = tmux;
    tmuxLine.hidden = !tmux;
    state.dataset.state = instance.running === true ? 'running' : instance.running === false ? 'stopped' : 'unknown';
    // "Running · 42m": how long since its last start, when both are reported.
    const since = instance.running === true ? shortAge(instance.startedAt) : null;
    stateAge.textContent = since ? `· ${since}` : ''; stateAge.hidden = !since; state.title = since ? `started ${instance.startedAt}` : '';
    state.hidden = typeof instance.running !== 'boolean'; // an unknown state is not shown
    for (const [id, el] of fields) {
      const value = id === 'running' ? instance.running === true ? 'Running'
        : instance.running === false ? 'Stopped' : 'Not reported'
        // The messaging address (desktop-facts), else the served identity; absent is the provider's absent fact.
        : id === 'identity' ? (typeof instance.identityAddress === 'string' && instance.identityAddress) || servedIdentityText(instance.identity) || 'Not reported'
        : id === 'harness' && typeof instance.harness === 'string' && instance.harness ? harnessName(instance.harness)
        // Where the model came from says nothing without the model beside it.
        : id === 'modelFrom' ? (reported(instance.model) !== 'Not reported' && MODEL_FROM[instance.modelFrom]) || 'Not reported'
        : id === 'workFolder' ? workFolder(instance.home) ?? 'Not reported'
        : id === 'home' ? (typeof instance.home === 'string' && instance.home) || 'Not reported'
        : reported(instance[id]);
      const age = ['createdAt', 'startedAt'].includes(id);
      const shown = age && value !== 'Not reported' ? ageText(value) : value;
      if (el.textContent !== shown) el.textContent = shown;
      if (id === 'createdAt') el.title = value === 'Not reported' ? '' : value;
      else if (id === 'startedAt') el.title = value === 'Not reported' ? '' : [value, reported(instance.createdAt) !== 'Not reported' ? `created ${instance.createdAt}` : null].filter(Boolean).join(' · ');
      else if (el.closest('.context-panel-path')) el.closest('.context-panel-path').title = value === 'Not reported' ? '' : value;
      el.toggleAttribute('data-unreported', value === 'Not reported');
      const row = rows.get(id); if (row) row.hidden = value === 'Not reported';
      else if (['model', 'modelFrom'].includes(id)) el.hidden = value === 'Not reported';
      if (id === 'identity' || id === 'instance') el.title = value === 'Not reported' ? '' : value;
      if (id === 'model' || id === 'modelFrom') modelLine.title = [fields.get('model')?.textContent, fields.get('modelFrom')?.textContent].filter(t => t && t !== 'Not reported').join(' · ');
    }
    sharedTag.hidden = !LINKED.has(instance.work);
    // A reported start replaces the spawn age (startedAt is null for a home never launched).
    startedLine.hidden = fields.get('startedAt').textContent === 'Not reported';
    createdLine.hidden = !startedLine.hidden || fields.get('createdAt').textContent === 'Not reported';
    session.hidden = !harness && !tmux && createdLine.hidden && startedLine.hidden;
    // The lifecycle row offers what the roster menu offers (#855): packages/client/instance-acts.mjs `instanceActs`
    // decides, and a control is shown exactly when its act is listed, enabled exactly when the act is (`inspect` has
    // no control here). So Stop is offered on a stopped row or one whose state is unknown (it also stops the row's
    // children); a blocked row (a remote one the kernel does not report addressable, a home still spawning) shows no
    // control; a limited one (#802: a spawn or a retire left it half cleaned) Retire alone. A listed act that is not
    // enabled (Start on a Herdr-recorded row) stays visible, disabled, its reason as its title, said as the row says it.
    // A secondary act (#1247: Retire on a home being retired) gets no control here: the roster menu keeps it.
    const { blocked, limited, acts } = desktopActs(instance), offered = new Map(acts.filter(act => !act.secondary).map(act => [act.verb, act]));
    for (const [verb, b] of [['restart', restartControl], ['start', startControl], ['stop', stopControl], ['retire', retireControl]]) {
      const act = offered.get(verb);
      b.hidden = !act; b.disabled = !act?.enabled;
      b.title = act && !act.enabled ? (act.reason?.code === 'unsupported-session' ? unsupportedLine(instance) : reasonLine(act.reason)) ?? '' : '';
    }
    // A blocked row says why in the controls' place, once: a row gone from its server (its reason's key `missing`)
    // already says it in the Work note (remoteWorkNote, the same unaddressableSentence), so nothing more is said here.
    // A limited row says why where its control would be when it has none (retiring) or when the reason carries the
    // kernel's own words (a failed retire's message, after them): said as the row says it.
    const why = blocked ? (!(blocked.key === 'missing' && remoteWorkNote(instance) !== null) ? reasonLine(blocked) ?? '' : '')
      : limited && (acts.some(act => act.secondary) || limited.origin !== undefined) ? reasonLine(limited) ?? '' : '';
    if (actionsNote.textContent !== why) actionsNote.textContent = why;
    actionsNote.hidden = !why;
    // A section with nothing reported is not shown; the header sub-line omits an unreported description.
    soulSub.hidden = fields.get('description').textContent === 'Not reported';
    lineage.hidden = [...lineage.querySelectorAll('[data-row]')].every(r => r.hidden);
    paths.hidden = [...paths.querySelectorAll('[data-row]')].every(r => r.hidden);
    soulDetails.hidden = [...soulDetails.querySelectorAll('[data-row]')].every(r => r.hidden);
    openSoulControl.disabled = typeof openSoul !== 'function' || typeof instance.agent !== 'string' || !instance.agent;
  }
  function selectTab(id, event) {
    if (!tabs.has(id) || !hasGeneric() || !visible(tabs.get(id))) return;
    onIntent(event);
    project(() => { pref().tab = id; });
  }
  function setClosed(value) {
    if (!hasGeneric()) { pref().collapsed = !!value; return; }
    detailsOpen = !value;
    try { instanceOpen.write(detailsOpen); } catch { /* storage-less: this window keeps it */ }
  }
  function setCollapsed(value) { project(() => setClosed(value)); }
  function setFocusMode(value) {
    const next = !!value;
    if (disposed || next === focusMode) return;
    project(() => { focusMode = next; app?.classList.toggle('focus-mode', next); }, () => onFocusModeChange(next));
  }
  const entry = event => {
    if (!disposed && !applyingFocus && !root.hidden && visible(event.target)) onIntent(event);
  };
  root.addEventListener('pointerdown', entry); root.addEventListener('focusin', entry);
  const offConnection = subscribeConnections(() => { gitSummary = null; prSummary = null; paintGitDot(); });
  render();
  return {
    setContext({ workspace = null, owner = null, instance = null, key = null } = {}) {
      project(() => {
        if (workspace !== context.workspace) {
          epoch++;
          for (const slot of slots.values()) slot.present = false;
        }
        const previous = contextIdentity();
        context = { workspace, owner, instance, key };
        if (previous !== contextIdentity() || owner != null) { gitSummary = null; prSummary = null; }
        // Paths opens per selection: another instance starts with it closed.
        if (previous !== contextIdentity()) paths.open = false;
        projectMetadata();
      });
    },
    attach(owner, element) {
      if (disposed || owner == null || !element || element.nodeType !== 1 || element === root || element.contains(root)) return inertLease();
      let slot;
      project(() => {
        // The same DOM cannot have two live owners. Moving it invalidates the
        // former lease just as replacing the element for one owner does.
        for (const [other, existing] of slots) {
          if (other !== owner && existing.element === element) { existing.wrapper.remove(); slots.delete(other); }
        }
        const previous = slots.get(owner);
        const wrapper = previous?.wrapper ?? node('div', 'context-panel-stage oats-view');
        if (previous?.element !== element) wrapper.replaceChildren(element);
        if (!wrapper.parentNode) stages.append(wrapper);
        slot = { element, wrapper, epoch, present: true };
        slots.set(owner, slot);
      });
      const owns = () => !disposed && slots.get(owner) === slot;
      const current = () => owns() && slot.epoch === epoch;
      return {
        setPresent(value) { if (current()) project(() => { slot.present = !!value; }); },
        isVisible: () => current() && currentSlot() === slot && slot.present && !root.hidden && !closed(),
        collapse() { if (current() && currentSlot() === slot && slot.present) setCollapsed(true); },
        dispose() {
          if (owns()) project(() => { slots.delete(owner); slot.wrapper.remove(); });
        },
      };
    },
    release(owner) {
      const slot = slots.get(owner);
      if (slot) project(() => { slots.delete(owner); slot.wrapper.remove(); });
    },
    // panel.toggle (⌘I / Ctrl+Shift+I, the palette, the shell's Show instance panel) leaves focus mode and shows the panel.
    toggle() {
      if (disposed || !hasContent()) return;
      if (focusMode) project(() => { focusMode = false; app?.classList.remove('focus-mode'); setClosed(false); }, () => onFocusModeChange(false));
      else setCollapsed(!closed());
    },
    setCollapsed,
    setFocusMode,
    toggleFocusMode() { setFocusMode(!focusMode); },
    isFocusMode: () => focusMode,
    /** Focus the shown panel's selected tab (instance details), else the first control of the stage's content. */
    focus() {
      if (disposed || root.hidden) return false;
      const slot = currentSlot();
      const target = hasGeneric() ? tabs.get(pref().tab)
        : slot ? [...slot.wrapper.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]')].find(el => el.tabIndex >= 0 && visible(el)) : null;
      focus(target);
      return !!target && document.activeElement === target;
    },
    /** What the shell's Show instance panel reflects. */
    state: panelState,
    dispose() {
      if (disposed) return;
      project(() => {
        const changed = focusMode;
        focusMode = false; app?.classList.remove('focus-mode');
        for (const slot of slots.values()) slot.wrapper.remove();
        slots.clear(); context = { workspace: null, owner: null, instance: null, key: null };
        gitPanel?.dispose(); teamsSection?.dispose?.();
        generic.remove(); stages.remove();
        if (changed) onFocusModeChange(false);
      });
      disposed = true; preferences.clear(); offConnection?.(); gitSummary = null; prSummary = null;
      root.removeEventListener('pointerdown', entry); root.removeEventListener('focusin', entry);
    },
  };
}
