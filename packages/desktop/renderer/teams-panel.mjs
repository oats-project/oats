/** Team controls on a live instance (teams contract 2026-09-25): the messaging
 * provider's own home operations `messaging:teams|join|leave` through `oats
 * operation run`. Gated on what the provider DECLARES (the operation rows in the
 * home's inspection), never on a provider name or version. The provider's teams
 * document is decoded strictly and bounded; its refusals are shown verbatim. */
import { teamRow } from '../../client/team-rows.mjs';
import { iconElement } from './shell-icons.mjs';
import { codeLineNodes } from '../../client/remote-address.mjs';
import { cliHeldBack } from './views/cli-status.mjs';

/** One card, the same in the Workspace inspector and the context panel:
 * tokens only (computed-AA inventory in theme-contrast), no opacity.
 * `.teams-panel.is-compact` is the context panel's Messaging & Teams variant (v4.1
 * board): a state glyph per row, text actions, the refresh as an icon button
 * that may live outside the section (`button.teams-refresh.is-compact`). */
export const teamsCSS = `
.teams-panel { display:flex; flex-direction:column; gap:8px; min-width:0; }
.teams-panel .teams-status { margin:0; font-size:12px; line-height:1.45; color:var(--muted); }
.teams-panel .teams-status:empty { display:none; }
.teams-panel .teams-status.error { color:var(--danger); }
.teams-panel .teams-card { border:1px solid var(--border); border-radius:8px; background:var(--surface); overflow:hidden; }
.teams-panel .teams-card:empty { display:none; }
.teams-panel .team-row { display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:12px; row-gap:6px; align-items:center; padding:9px 12px; min-height:44px; box-sizing:border-box; }
.teams-panel .team-row + .team-row, .teams-panel .teams-card > .teams-note { border-top:1px solid var(--border); }
.teams-panel .team-main { display:flex; flex-direction:column; gap:2px; min-width:0; }
.teams-panel .team-name { font-size:12.5px; font-weight:650; line-height:1.4; color:var(--fg); overflow-wrap:anywhere; }
.teams-panel .team-meta { font-size:11.5px; line-height:1.4; color:var(--muted); overflow-wrap:anywhere; }
.teams-panel .team-badge { font-size:11px; font-weight:650; line-height:1; color:var(--muted); border:1px solid var(--border); border-radius:999px; padding:4px 8px; white-space:nowrap; }
.teams-panel .team-action { font:600 11.5px/1 inherit; height:26px; padding:0 10px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--fg); cursor:pointer; white-space:nowrap; }
.teams-panel .team-action:hover:not(:disabled) { background:var(--surface-2); }
.teams-panel .team-action:disabled, .teams-panel .team-action[aria-disabled="true"] { color:var(--muted); cursor:default; }
.teams-panel .team-row > details, .teams-panel .team-row > .teams-problem { grid-column:1 / -1; }
.teams-panel details { font-size:11.5px; color:var(--muted); }
.teams-panel details > summary { cursor:pointer; }
.teams-panel details pre { margin:4px 0 0; font-weight:normal; font-size:11px; line-height:1.55; font-family:var(--ui-font, ui-monospace, Menlo, monospace); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--fg); }
.teams-panel .teams-problem { border-left:2px solid var(--danger); padding-left:8px; font-size:12px; color:var(--fg); }
.teams-panel .teams-problem > p { margin:0; }
.teams-panel .team-main > .teams-problem { margin-top:4px; }
.teams-panel .teams-problem > p.teams-fix { margin-top:2px; color:var(--muted); font-size:11.5px; }
.teams-panel .teams-refusal, .teams-panel .teams-warnings { padding:9px 12px; }
.teams-panel .teams-warnings + .team-row { border-top:1px solid var(--border); }
.teams-panel .teams-problem.teams-warning { border-left-color:var(--warn); }
.teams-panel .teams-problem > p.teams-warning-head { color:var(--warn); font-weight:650; }
.teams-panel .teams-note { margin:0; padding:9px 12px; font-size:12px; color:var(--muted); }
.teams-panel .teams-refresh { align-self:flex-start; font:600 11.5px/1 inherit; height:26px; padding:0 10px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--fg); cursor:pointer; }
.teams-panel .teams-refresh:disabled { color:var(--muted); cursor:default; }
.teams-panel .teams-subhead { margin:0; padding:9px 12px 0; border-top:1px solid var(--border); font-size:11px; font-weight:650; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
.teams-panel .teams-subhead + .team-row { border-top:0; }
.teams-panel.is-compact .teams-card { border-radius:9px; }
.teams-panel.is-compact > .teams-intro { padding:0; }
.teams-panel.is-compact .teams-card > * + * { border-top:1px solid var(--border); }
.teams-panel.is-compact .teams-card > .teams-subhead + .team-row { border-top:0; }
.teams-panel.is-compact .team-row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; padding:9px 12px; min-height:40px; }
.teams-panel.is-compact .team-glyph { flex:none; display:grid; place-items:center; width:14px; height:14px; color:var(--muted); }
.teams-panel.is-compact .team-glyph.is-on { color:var(--ok); }
.teams-panel.is-compact .team-glyph > svg { display:block; }
.teams-panel.is-compact .team-main { flex:1 1 0; gap:1px; }
.teams-panel.is-compact .team-name { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:12.5px; font-weight:600; }
.teams-panel.is-compact .team-tag { font-size:10.5px; font-weight:600; line-height:1.3; padding:1px 6px; border-radius:4px; background:var(--tag-bg); color:var(--muted); }
.teams-panel.is-compact .team-meta { font-size:11px; }
.teams-panel.is-compact .team-badge { border:0; border-radius:0; padding:0; font-size:11.5px; font-weight:500; line-height:1.4; color:var(--muted); }
.teams-panel.is-compact .team-action { height:auto; margin:-2px -4px; padding:2px 4px; border:0; border-radius:4px; background:transparent; font-size:12px; line-height:1.3; color:var(--muted); }
.teams-panel.is-compact .team-action[data-team-action="join"] { color:var(--accent); }
.teams-panel.is-compact .team-action:hover:not(:disabled) { background:transparent; text-decoration:underline; }
.teams-panel.is-compact .team-action:disabled, .teams-panel.is-compact .team-action[aria-disabled="true"] { color:var(--muted); text-decoration:none; }
.teams-panel.is-compact .team-row > details, .teams-panel.is-compact .team-row > .teams-problem { flex-basis:100%; }
button.teams-refresh.is-compact { flex:none; align-self:auto; display:grid; place-items:center; width:24px; height:24px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--muted); cursor:pointer; }
button.teams-refresh.is-compact:hover:not(:disabled) { background:var(--surface-2); color:var(--fg); }
button.teams-refresh.is-compact:disabled { color:var(--muted); cursor:default; }
`;

const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const label = v => typeof v === 'string' && LABEL.test(v);
const ARG = /^[a-z][a-z0-9-]{0,63}$/;

/** The provider's declared team operations, or null when no messaging provider
 * fills the layer. `supported: false` means the provider declares no
 * `messaging:teams` (the panel then says so; it is never an error). */
export function teamsOperations(inspected) {
  const provider = (inspected?.capabilities || []).find(cap => cap?.layer === 'messaging');
  if (!provider) return null;
  const row = name => (Array.isArray(provider.operations) ? provider.operations : []).find(op => op?.name === name) ?? null;
  const teams = row('teams');
  if (!teams) return { provider: provider.id, supported: false };
  // join/leave take the label list as their one required argument; its name is the provider's.
  const action = name => {
    const op = row(name);
    if (!op) return null;
    const required = (Array.isArray(op.args) ? op.args : []).filter(a => a?.required === true);
    return { address: `messaging:${name}`, available: op.available !== false, reason: op.reason ?? null,
      arg: required.length === 1 && ARG.test(required[0].name ?? '') ? required[0].name : null };
  };
  return { provider: provider.id, supported: true, teams: { address: 'messaging:teams', available: teams.available !== false, reason: teams.reason ?? null },
    join: action('join'), leave: action('leave') };
}

/** Where the provider found the workspace's default team (1.16 `defaultTeam.source`):
 * `setting` = settings.oats.aweb.team named it; `root` = the messaging root's active team. */
const DEFAULT_SOURCE = Object.freeze({ __proto__: null, setting: 'set by the workspace or host setting', root: "the messaging root's active team" });
/** The kernel's DefaultTeam `from`: the soul's own default (team model v2: oats-local.yaml souls.default;
 * team model 3: its souls: entry in the workspace), this computer's default (oats-local.yaml defaultTeam),
 * or the workspace's defaultTeam (team model 3). */
const DEFAULT_FROM = Object.freeze({ __proto__: null, deployment: "this workspace's default on this computer", soul: "this soul's own default",
  workspace: "the workspace's default" });
/** The document's default team: 0.29 `{team, source: setting|root}`, or the kernel's DefaultTeam
 * `{label, team: <id>|null (unmapped), from: deployment|soul|workspace}`, or `null` (none configured). */
const defaultTeamOk = h => h === null
  || (exact(h, ['team', 'source']) && text(h.team) && Object.hasOwn(DEFAULT_SOURCE, h.source))
  || (exact(h, ['label', 'team', 'from']) && label(h.label) && (h.team === null || text(h.team)) && Object.hasOwn(DEFAULT_FROM, h.from));
/** The default team's words for a row: its id (or label when unmapped) and where it was set. */
export function defaultTeamText(h) {
  if (!h) return null;
  if (Object.hasOwn(h, 'from')) return `${h.team ?? `${h.label} (no provider id yet)`} · ${DEFAULT_FROM[h.from]}`;
  return `${h.team} · ${DEFAULT_SOURCE[h.source]}`;
}

/** The provider's teams document from an operation run result, or null. The run
 * must be `operationsApi: 2` for exactly `address`; the document carries exactly
 * the contract's fields (1.16 names, its AMENDMENT c129125a): `{defaultTeam{team, source: setting|root},
 * primary, eligible[{label, team, joined}],
 * joined[{label, team, since, identityHome, receive}], unmapped[label], at}`.
 * A join/leave answer (`{ actions: true }`) may also carry what it did, as the
 * real provider sends it (oats.aweb 1.15+; teams contract 089cff5c): `actions[{action:
 * join|leave, label, released?, receipt?}]`, each label an eligible or joined row;
 * the receipt is opaque provider evidence, never shown. The panel repaints from the document. */
export function teamsDocument(run, address, { actions = false } = {}) {
  if (!record(run) || run.operationsApi !== 2 || run.operation !== address) return null;
  const d = run.result, did = actions && record(d) && Object.hasOwn(d, 'actions');
  // Required: defaultTeam, eligible, joined, at. 0.29-only (optional, absent on team model v2):
  // primary, unmapped. Additive (v2, oats.aweb 1.17): left, the last ≤20 live-read leaves; warnings,
  // the provider's non-fatal problems (strings, as worded); eligible rows' from (shared|local).
  const allowed = ['defaultTeam', 'eligible', 'joined', 'at', 'primary', 'unmapped', 'left', 'warnings', ...(did ? ['actions'] : [])];
  if (!record(d) || !['defaultTeam', 'eligible', 'joined', 'at'].every(k => Object.hasOwn(d, k)) || Object.keys(d).some(k => !allowed.includes(k))) return null;
  if (did && !(Array.isArray(d.actions) && d.actions.length <= 64 && d.actions.every(actionRow))) return null;
  // The default team: 0.29 {team, source} or team model v2's DefaultTeam (or null), each a closed set.
  if (!defaultTeamOk(d.defaultTeam)) return null;
  if ((Object.hasOwn(d, 'primary') && !(d.primary === null || label(d.primary))) || !text(d.at, 64)) return null;
  const list = v => Array.isArray(v) && v.length <= 64;
  const unmapped = Object.hasOwn(d, 'unmapped') ? d.unmapped : [];
  if (!list(d.eligible) || !list(d.joined) || !list(unmapped)) return null;
  if (Object.hasOwn(d, 'left') && !(Array.isArray(d.left) && d.left.length <= 20 && d.left.every(l => exact(l, ['label', 'team', 'at', 'reason'])
    && label(l.label) && text(l.team) && text(l.at, 64) && text(l.reason, 64)))) return null;
  if (!d.eligible.every(e => exact(e, ['label', 'team', 'joined', ...(Object.hasOwn(e, 'from') ? ['from'] : [])]) && label(e.label) && text(e.team)
    && typeof e.joined === 'boolean' && (!Object.hasOwn(e, 'from') || ['shared', 'local'].includes(e.from)))) return null;
  if (Object.hasOwn(d, 'warnings') && !(Array.isArray(d.warnings) && d.warnings.length <= 64 && d.warnings.every(w => text(w, 512)))) return null;
  if (!d.joined.every(j => exact(j, ['label', 'team', 'since', 'identityHome', 'receive']) && label(j.label) && text(j.team) && text(j.since, 64)
    && text(j.identityHome, 4096) && j.identityHome.startsWith('/') && text(j.receive, 32))) return null;
  if (!unmapped.every(label)) return null;
  const unique = xs => new Set(xs).size === xs.length;
  if (!unique(d.eligible.map(e => e.label)) || !unique(d.joined.map(j => j.label)) || !unique(unmapped)) return null;
  // Each action names a row this answer reports (eligible or joined), as the contract says.
  if (did && !d.actions.every(x => d.eligible.some(e => e.label === x.label) || d.joined.some(j => j.label === x.label))) return null;
  return structuredClone({ defaultTeam: d.defaultTeam, primary: Object.hasOwn(d, 'primary') ? d.primary : null, eligible: d.eligible, joined: d.joined, unmapped, at: d.at,
    ...(Object.hasOwn(d, 'left') ? { left: d.left } : {}), ...(Object.hasOwn(d, 'warnings') ? { warnings: d.warnings } : {}), ...(did ? { actions: d.actions } : {}) });
}
/** One `actions` row of a join/leave answer: the verb and label, an optional
 * `released` word, an optional provider receipt (a bounded record, kept opaque), and an optional
 * non-fatal `warning` (bounded text, as the provider words it; e.g. a join accepted without a
 * workspace connection, with its recovery). */
function actionRow(a) {
  if (!record(a) || !['join', 'leave'].includes(a.action) || !label(a.label)) return false;
  if (!Object.keys(a).every(k => ['action', 'label', 'released', 'receipt', 'warning'].includes(k))) return false;
  if (Object.hasOwn(a, 'warning') && !text(a.warning, 1024)) return false;
  if (Object.hasOwn(a, 'released') && !text(a.released, 32)) return false;
  if (Object.hasOwn(a, 'receipt') && !(record(a.receipt) && JSON.stringify(a.receipt).length <= 4096)) return false;
  return true;
}

/** A provider timestamp, shown deterministically (UTC minutes); anything else as sent. */
export function whenText(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}
/** Team labels a refusal names (E_TEAM_CONFLICT details.labels): 2..16 distinct labels, or null. */
export function teamLabels(v) {
  return Array.isArray(v) && v.length >= 2 && v.length <= 16 && v.every(label) && new Set(v).size === v.length ? [...v] : null;
}
/** The soul's eligible teams as `oats inspect` reports them (kernel `teams`,
 * primary first): `[{label, team, mapped}]`, or null when not reported or not
 * readable. `mapped` and `team` must agree (a mapped label names its team). */
export function soulTeams(v) {
  if (!Array.isArray(v) || v.length > 64) return null;
  const out = [];
  for (const t of v) {
    const row = teamRow(t);
    if (!row) return null;
    out.push(row);
  }
  return new Set(out.map(t => t.label)).size === out.length ? out : null;
}
/** Why an instance left a team (left[].reason); an unknown reason is shown as sent. */
export function leftReason(reason) {
  return reason === 'no-longer-eligible' ? 'The soul no longer belongs to it.' : `reason: ${reason}`;
}

/** How a joined team's mail reaches the instance — never implying live delivery for a poll team. */
export function receiveText(receive) {
  if (receive === 'poll') return "checks this team's mail between tasks";
  if (receive === 'native' || receive === 'live') return "receives this team's mail as it arrives";
  return `receive: ${receive}`;
}

/** One Teams section for an instance home. `request(body)` posts to the
 * capabilities route; `owns()` is the inspector's selection lifetime (checked
 * on success AND rejection); `available()` the CLI gate. `compact` is the
 * context panel's Messaging & Teams presentation (glyph rows, a lead line, text actions, an icon
 * Refresh that goes to `refreshHost` when given); the default renders the
 * Workspace inspector's card. `dispose()` removes the section and the refresh
 * button wherever it was appended (safe to call twice). `mutable()` false (the
 * host's inspection is stale) holds join/leave with `mutableReason` as their
 * accessible reason — aria-disabled, so a focused control keeps focus; Refresh
 * stays. Controls carry `data-focus-key` (`teams-refresh`, `join:<label>`,
 * `leave:<label>`) for a host's focus restore across repaints. */
export function createTeamsPanel(parent, { operations, selector, request, owns, available = () => true, heading = true, compact = false, refreshHost = null, mutable = () => true, mutableReason = '' }) {
  const doc = parent.ownerDocument;
  const node = (tag, value, cls) => { const el = doc.createElement(tag); if (value !== undefined) el.textContent = value; if (cls) el.className = cls; return el; };
  const section = node('section', undefined, compact ? 'teams-panel is-compact' : 'teams-panel');
  if (heading) section.append(node('h3', 'Teams'));
  parent.append(section);
  let refresh = null;
  const dispose = () => { refresh?.remove(); section.remove(); };
  if (!operations.supported) { section.append(node('p', 'Not supported by this messaging provider.', 'teams-status')); return { sync() {}, refresh() {}, dispose }; }
  if (!operations.teams.available) { section.append(node('p', operations.teams.reason || 'The provider cannot list teams here.', 'teams-status')); return { sync() {}, refresh() {}, dispose }; }
  const status = node('p', '', 'teams-status'); status.setAttribute('role', 'status');
  // What the list is: the workspace's default team, then the teams the soul has access to (unmapped labels are not shown).
  // Compact: the lead line under the context panel's "Teams" sub-label. Both show once a teams document has been read.
  const intro = node('p', compact ? 'The messaging teams this soul is allowed to join. It is always in the default team.'
    : "Always in the workspace's default team. It can join the teams its soul has access to.", 'teams-note teams-intro'); intro.hidden = true;
  const body = node('div', undefined, 'teams-card');
  refresh = node('button', compact ? undefined : 'Refresh teams', compact ? 'teams-refresh is-compact' : 'teams-refresh'); refresh.type = 'button'; refresh.dataset.focusKey = 'teams-refresh';
  if (compact) { refresh.append(iconElement(doc, 'refresh', { size: 13 })); refresh.setAttribute('aria-label', 'Refresh teams'); refresh.title = 'Refresh teams'; }
  section.append(intro, status, body);
  (refreshHost || section).append(refresh);
  // A row's state glyph (compact only): a check for a membership (the default team, a joined
  // team), a circle for a team it could join or is not in.
  const glyph = on => { const g = node('span', undefined, on ? 'team-glyph is-on' : 'team-glyph'); g.setAttribute('aria-hidden', 'true'); g.append(iconElement(doc, on ? 'check' : 'circle', { size: 14 })); return g; };
  // One row: name + meta lines on the left, the action or a badge on the right. Compact: a state
  // glyph first, `tag` inline after the name (the default team's "default").
  const teamRow = (key, name, metas, side, { on = false, tag = null } = {}) => {
    const el = node('div', undefined, 'team-row'); el.dataset.teamRow = key;
    if (compact) el.append(glyph(on));
    const main = node('div', undefined, 'team-main'), title = node('div', name, 'team-name');
    if (tag) title.append(node('span', tag, 'team-tag'));
    main.append(title);
    for (const meta of metas) main.append(typeof meta === 'string' ? node('div', meta, 'team-meta') : meta);
    el.append(main); if (side) el.append(side); return el;
  };
  const badge = (text, title) => { const b = node('span', text, 'team-badge'); if (title) b.title = title; return b; };
  let serial = 0, pending = null, current = null, rowError = null;
  const live = () => owns() && section.isConnected;
  const say = (value, error = false) => { status.textContent = value; status.classList.toggle('error', error); };
  function problem(error, fallback) {
    const code = typeof error?.code === 'string' ? error.code : '';
    const box = node('div', undefined, 'teams-problem');
    box.append(node('p', typeof error?.message === 'string' && error.message ? error.message : fallback));
    // Details: the code, and a relayed remote refusal's own message (`detail`) after it in a <bdi> (codeLineNodes).
    if (code) { const line = node('pre'); line.append(...codeLineNodes(doc, { code, detail: error?.detail })); const more = node('details'); more.append(node('summary', 'Details'), line); box.append(more); }
    return box;
  }
  // A join/leave the provider did with a non-fatal warning: said under the team's row, verbatim.
  function warning(a) {
    const box = node('div', undefined, 'teams-problem teams-warning'); box.setAttribute('role', 'status'); box.dataset.teamWarningFor = a.label;
    const done = a.action === 'join' ? 'Joined' : 'Left';
    box.append(node('p', `${done}, with a warning from the messaging provider:`, 'teams-warning-head'), node('p', a.warning, 'teams-warning-text'));
    return box;
  }
  function unreadable(result) {
    return result?.operationsApi === 1 ? 'This workspace still uses the classic layout, which answers an older operation result.'
      : 'The messaging provider answered teams this Desktop cannot read.';
  }
  // `explicit`: Refresh/Retry clear a refusal; the re-read after a refusal keeps it.
  async function read({ explicit = false } = {}) {
    const ticket = ++serial; pending = 'read'; if (explicit) rowError = null; say('Reading teams…'); sync();
    try {
      const result = await request({ action: 'run', selector, operation: operations.teams.address });
      if (!live() || ticket !== serial) return;
      const next = teamsDocument(result, operations.teams.address);
      if (!next) { current = null; body.replaceChildren(); say(unreadable(result), true); return; }
      current = next; say(''); render();
    } catch (error) {
      if (!live() || ticket !== serial) return;
      say('');
      const retry = node('button', 'Retry', 'team-action'); retry.type = 'button'; retry.addEventListener('click', () => { if (live() && !pending) void read({ explicit: true }); });
      const failed = node('div', undefined, 'team-row'); failed.append(problem(error, 'The messaging provider could not list teams.'), retry);
      body.replaceChildren(failed);
    } finally { if (ticket === serial) { pending = null; if (live()) sync(); } }
  }
  async function change(verb, target) {
    const op = operations[verb];
    if (!op || !op.arg || pending || !live() || !available()) return;
    const ticket = ++serial; pending = { verb, label: target }; rowError = null; render(); sync();
    try {
      const result = await request({ action: 'run', selector, operation: op.address, args: { [op.arg]: target } });
      if (!live() || ticket !== serial) return;
      const next = teamsDocument(result, op.address, { actions: true });
      pending = null;
      if (!next) { say(unreadable(result), true); render(); return; }
      current = next; say(''); render();
    } catch (error) {
      if (!live() || ticket !== serial) return;
      // The refusal stays under its row, verbatim; the panel keeps its last good
      // state, then re-reads what the provider now reports.
      pending = null; rowError = { label: target, error }; render();
      void read();
    } finally { if (ticket === serial && pending && typeof pending === 'object') { pending = null; if (live()) { render(); sync(); } } }
  }
  function control(verb, target) {
    const op = operations[verb], b = node('button', verb === 'join' ? 'Join' : 'Leave', 'team-action'); b.type = 'button';
    b.dataset.team = target; b.dataset.teamAction = verb; b.dataset.focusKey = `${verb}:${target}`;
    if (pending?.label === target && pending.verb === verb) b.textContent = verb === 'join' ? 'Joining…' : 'Leaving…';
    if (!op) b.title = `This messaging provider does not declare messaging:${verb}.`;
    else if (!op.arg) b.title = `This provider's messaging:${verb} needs arguments the Desktop cannot supply; use the OATS CLI.`;
    else if (!op.available) b.title = op.reason || '';
    b.addEventListener('click', () => { if (!b.disabled && b.getAttribute('aria-disabled') !== 'true') void change(verb, target); });
    return b;
  }
  function render() {
    body.replaceChildren(); intro.hidden = !current;
    if (!current) return;
    // The provider's non-fatal problems (oats.aweb 1.17 `warnings[]`), verbatim, above the rows.
    if (current.warnings?.length) {
      const said = node('div', undefined, 'teams-warnings'), box = node('div', undefined, 'teams-problem teams-warning'); box.setAttribute('role', 'status');
      box.append(node('p', current.warnings.length === 1 ? 'A warning from the messaging provider:' : 'Warnings from the messaging provider:', 'teams-warning-head'),
        ...current.warnings.map(w => node('p', w, 'teams-warning-text')));
      said.append(box); body.append(said);
    }
    body.append(defaultRow(current.defaultTeam));
    const joined = new Map(current.joined.map(j => [j.label, j]));
    // What the provider did, with its non-fatal warnings (join/leave answers only; the next read
    // clears them). Every action names an eligible or joined row (teamsDocument), so each has its row.
    const warned = (current.actions || []).filter(a => a.warning);
    const rows = [...current.eligible.map(e => ({ label: e.label, team: e.team, eligible: true, from: e.from ?? null })),
      ...current.joined.filter(j => !current.eligible.some(e => e.label === j.label)).map(j => ({ label: j.label, team: j.team, eligible: false }))];
    // A refusal whose row the re-read no longer offers is said at panel level, never dropped.
    if (rowError && !rows.some(row => row.label === rowError.label)) {
      const gone = node('div', undefined, 'teams-refusal'); gone.dataset.teamRefusal = rowError.label;
      gone.append(problem(rowError.error, 'The messaging provider refused.'), node('p', `${rowError.label} is no longer offered to this instance.`, 'teams-note'));
      body.prepend(gone);
    }
    for (const row of rows) {
      const j = joined.get(row.label), name = row.label;
      // Where the team is declared (1.17 eligible[].from), in Workspace › Teams' words; absent says nothing.
      const team = row.from ? `${row.team} · ${row.from}` : row.team;
      let el;
      if (j) {
        // Compact: one line, when it joined (and, when so, that the soul lost it); no receive mode, no identity home.
        const since = node('div', compact ? `Joined ${whenText(j.since)}${row.eligible ? '' : ' · No longer eligible in this workspace.'}` : `${team} · Joined ${whenText(j.since)}`, 'team-meta'); since.title = j.since;
        const metas = compact ? [since] : [since, receiveText(j.receive).replace(/^./, c => c.toUpperCase())];
        if (!compact && !row.eligible) metas.push('No longer eligible in this workspace.');
        el = teamRow(row.label, name, metas, control('leave', row.label), { on: true });
        if (!compact) { const where = node('details'); where.append(node('summary', 'Identity home'), node('pre', j.identityHome)); el.append(where); }
      } else el = teamRow(row.label, name, [compact ? 'eligible' : `${team} · Not joined`], control('join', row.label));
      if (rowError?.label === row.label) el.append(problem(rowError.error, 'The messaging provider refused.'));
      for (const a of warned.filter(a => a.label === row.label)) el.append(warning(a));
      body.append(el);
    }
    if (!rows.length) body.append(node('p', compact ? 'This soul may join no other team.' : 'Its soul has access to no other team.', 'teams-note'));
    // Team model v2: the teams this instance left on a live read (the soul lost them), newest first.
    const left = [...(current.left || [])].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    if (left.length) {
      body.append(node('p', 'Recently left', 'teams-subhead'));
      for (const l of left) {
        const when = node('div', `${l.team} · Left ${whenText(l.at)}`, 'team-meta'); when.title = l.at;
        const el = teamRow(l.label, l.label, [when, leftReason(l.reason)]); el.classList.add('team-left'); el.dataset.teamLeft = l.label;
        body.append(el);
      }
    }
    sync();
  }
  /** The default team's row. 0.29: {team, source}. Team model v2: {label, team|null, from}, or null (none configured).
   * Compact: the name is the label (v2) or the id (0.29) with a "default" tag; one meta line: the id (v2) or the 0.29 words. */
  function defaultRow(home) {
    const always = badge('Always on', "The default team can't be left.");
    if (home === null) return teamRow('default', 'Default team', ['None configured on this computer: run oats aweb setup.']);
    if (!Object.hasOwn(home, 'from')) return compact ? teamRow('default', home.team, [defaultTeamText(home)], always, { on: true, tag: 'default' })
      : teamRow('default', 'Default team', [defaultTeamText(home)], always);
    if (home.team) return compact ? teamRow('default', home.label, [home.team], always, { on: true, tag: 'default' })
      : teamRow('default', `Default team · ${home.label}`, [`${home.team} · ${DEFAULT_FROM[home.from]}`], always);
    // Unmapped: a blocking problem, not a membership (no "Always on"): nothing can be spawned into it.
    const block = node('div', undefined, 'teams-problem teams-blocking'); block.setAttribute('role', 'alert');
    block.append(node('p', `The default team ${home.label} has no provider id yet.`),
      node('p', 'Its owner runs oats aweb setup, then commits the id; or choose another default in Workspace › Teams (oats teams default).', 'teams-fix'));
    return compact ? teamRow('default', home.label, [DEFAULT_FROM[home.from], block], null, { tag: 'default' })
      : teamRow('default', `Default team · ${home.label}`, [DEFAULT_FROM[home.from], block]);
  }
  function sync() {
    refresh.disabled = !!pending || !available() || !live();
    const held = !mutable();
    for (const b of body.querySelectorAll('[data-team-action]')) {
      const op = operations[b.dataset.teamAction];
      // Join and leave are capability runs: held back above the tested bound (#1879), the notice as their title.
      const heldBack = cliHeldBack('POST /api/capabilities run');
      b.disabled = !!pending || !available() || !live() || !op || !op.arg || !op.available || !!heldBack;
      if (heldBack) b.title = heldBack;
      // The host's inspection is stale: held with the reason, aria-disabled (focus survives); the next good read lifts it.
      if (held) { b.setAttribute('aria-disabled', 'true'); b.setAttribute('aria-description', mutableReason); if (!b.disabled) b.title = mutableReason; }
      else if (b.getAttribute('aria-description') === mutableReason) { b.removeAttribute('aria-disabled'); b.removeAttribute('aria-description'); if (b.title === mutableReason) b.removeAttribute('title'); }
    }
  }
  refresh.addEventListener('click', () => { if (live() && !pending) void read({ explicit: true }); });
  void read();
  return { sync, refresh: () => { if (live() && !pending) void read({ explicit: true }); }, dispose };
}
