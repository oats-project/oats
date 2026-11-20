/** Native kernel JSON → bounded public observations. This module has no I/O.
 * It does not resolve a deployment, read metadata, infer drift, or reproduce
 * any kernel lifecycle/trust logic. Producer shapes remain command-specific. */
import { dirname, basename, join, isAbsolute, resolve } from 'node:path';
import { deploymentRecord as record } from './deployment-contract.mjs';
import { harnessOf } from './harness-names.mjs';
import { teamRow, teamRowsOf, defaultTeamOf, TEAM_ID } from './team-rows.mjs';
import { launchOf, REPORT_FROM } from './launch-contract.mjs';
import { readIdentity } from './workspace-views.mjs';
import { waitingOnYouData } from './waiting-on-you.mjs';
import { attributedHumanData } from './attributed-human.mjs';
import { retireData } from './retire-state.mjs';
import { instanceColor, openLink, sessionThreadId } from './instance-presentation.mjs';
const text = value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0');
const absolute = value => text(value) && isAbsolute(value) && resolve(value) === value;
const own = (value, key) => Object.hasOwn(value, key);
/** How an instance's last session ended (`oats status --json` `sessionEnd`), by name: the only values a row keeps.
 * The one list; clients read a row's `sessionEnd` against it (session-resume-trigger.mjs lostLocalHomes). */
export const SESSION_ENDS = Object.freeze({ lost: 'lost', stopped: 'stopped', exited: 'exited' });
const SESSION_END_VALUES = Object.values(SESSION_ENDS);
const bad = (code = 'E_CLI_PROTOCOL') => { throw Object.assign(new Error(code), { code }); };
const check = (condition, code) => { if (!condition) bad(code); };
const array = (value, limit = 2000) => { check(Array.isArray(value) && value.length <= limit); return value; };
const strings = value => array(value).map(v => { check(text(v)); return v; });
function fields(value, names) {
  check(record(value));
  const out = {};
  for (const key of names) if (own(value, key)) { check(value[key] === null || text(value[key])); out[key] = value[key]; }
  return out;
}
/** The row's harness (`harness`, or a released kernel's `runtime`), validated like fields(). */
function withHarness(value, out) {
  const harness = harnessOf(value);
  if (harness !== undefined) { check(harness === null || text(harness)); out.harness = harness; }
  return out;
}
function flags(value, names, into) {
  for (const key of names) if (own(value, key)) { check(typeof value[key] === 'boolean'); into[key] = value[key]; }
  return into;
}
/* Desktop facts (feature desktop-facts, kernel #217): additive fields, projected when reported. */
const fileRef = value => value === null ? null : fields(value, ['path', 'url']);
const problemRef = value => value === null ? null : fields(value, ['code', 'message']);
function nameRows(value) {
  return array(value, 500).map(row => { const out = fields(row, ['name', 'from']); check(text(out.name)); flags(row, ['off'], out); return out; });
}
function defaultsFacts(value) {
  // defaults.byTeam is 0.29's; team model v2 (0.30) drops it, so it is optional (absent stays absent).
  const hasByTeam = own(value, 'byTeam');
  check(record(value) && record(value.slots) && (!hasByTeam || record(value.byTeam)) && Object.keys(value.slots).length <= 64 && (!hasByTeam || Object.keys(value.byTeam).length <= 256));
  const slots = Object.fromEntries(Object.entries(value.slots).map(([slot, v]) => {
    check(text(slot) && slot.length > 0);
    return [slot, v === null || v === 'none' ? v : fields(v, ['name', 'from'])];
  }));
  if (!hasByTeam) return { slots, capabilities: nameRows(value.capabilities) };
  const byTeam = Object.fromEntries(Object.entries(value.byTeam).map(([label, v]) => { check(text(label) && label.length > 0 && record(v)); return [label, { capabilities: nameRows(v.capabilities) }]; }));
  return { slots, capabilities: nameRows(value.capabilities), byTeam };
}
function cloneRow(row) {
  const out = fields(row, ['key', 'name']); check(text(out.key));
  check(row.path === null || absolute(row.path)); out.path = row.path;
  check(row.rule === null || row.rule === 'clones' || row.rule === 'convention'); out.rule = row.rule;
  if (own(row, 'problem')) out.problem = problemRef(row.problem);
  return out;
}
function lockFact(value) {
  check(record(value) && absolute(value.path) && Number.isSafeInteger(value.lockfileVersion));
  return { path: value.path, lockfileVersion: value.lockfileVersion };
}
function source(value) {
  return fields(value, ['kind', 'package', 'version', 'commit', 'integrity', 'repoKey']);
}
function soulSource(value) {
  return value === null ? null : fields(value, ['repoKey', 'commit', 'current', 'status', 'path']);
}
function modules(value) {
  if (Array.isArray(value)) return array(value).map(row => {
    const out = fields(row, ['name', 'commit', 'status', 'reason']);
    check(text(row.name) && row.name.length > 0);
    if (own(row, 'from')) out.from = source(row.from);
    if (own(row, 'current')) out.current = row.current === null ? null : fields(row.current, ['commit', 'version']);
    return out;
  });
  // Native v2's offline result is the recorded map, NOT live drift rows.
  // Preserve that distinction; never fabricate "current" or convert it into
  // a claimed online observation just because a commit was recorded.
  check(record(value)); check(Object.keys(value).length <= 2000);
  return Object.fromEntries(Object.entries(value).map(([name, row]) => {
    check(text(name) && name.length > 0);
    const out = fields(row, ['commit', 'digest', 'materializedAt']);
    if (own(row, 'from')) out.from = source(row.from);
    return [name, out];
  }));
}
function servedIdentity(value) {
  if (value === null) return null;
  const out = fields(value, ['mode', 'alias', 'team', 'address', 'resident', 'provider']);
  if (own(value, 'grant')) {
    out.grant = fields(value.grant, ['id', 'expiresAt']);
    if (own(value.grant, 'scopes')) out.grant.scopes = strings(value.grant.scopes);
  }
  return out;
}
function recordedWorkspace(value) {
  const out = fields(value, ['key', 'commit', 'resolution']);
  flags(value, ['standalone'], out);
  if (own(value, 'soul')) out.soul = fields(value.soul, ['id', 'repoKey', 'commit', 'team']);
  return out;
}

/** workspace status is the sole header authority (lock current / out of
 * date). Declaring a package in `packages:` is the trust decision, so there
 * is no approval state to read. No inspect.scope dependency. */
export function workspaceStatusData(document, deployment) {
  check(absolute(deployment), 'E_BAD_ARGS');
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && data.workspaceStatusApi === 1);
  check(record(data.workspace) && absolute(data.workspace.local));
  check(data.workspace.local === join(deployment, 'oats-local.yaml'), 'E_DEPLOYMENT_SCOPE');
  const workspace = fields(data.workspace, ['name', 'key', 'url', 'commit', 'observedAt', 'local']);
  check(text(workspace.name) && text(workspace.key));
  if (own(data.workspace, 'teams')) {
    // 0.29: the declared labels (strings). Team model v2 (0.30): the committed SHARED teams as rows
    // {label, team: <id>|null, description|null}; `teams` stays the labels (what Setup lists) and
    // the rows travel as `sharedTeams`. A mixed or malformed list fails the read.
    const rows = array(data.workspace.teams, 256);
    if (rows.every(r => typeof r === 'string')) workspace.teams = strings(rows);
    else {
      workspace.sharedTeams = rows.map(r => { const out = fields(r, ['label', 'team', 'description']); check(TEAM_LABEL.test(out.label ?? '')); return out; });
      check(new Set(workspace.sharedTeams.map(r => r.label)).size === rows.length);
      workspace.teams = workspace.sharedTeams.map(r => r.label);
    }
  }
  if (own(data.workspace, 'file')) workspace.file = fileRef(data.workspace.file);
  const members = array(data.members).map(memberRow);
  const packages = array(data.packages).map(packageRow);
  const facts = {};
  if (own(data, 'defaults')) facts.defaults = defaultsFacts(data.defaults);
  if (own(data, 'clones')) facts.clones = array(data.clones).map(cloneRow);
  if (own(data, 'disabledSouls')) facts.disabledSouls = strings(data.disabledSouls);
  if (own(data, 'lock')) facts.lock = lockFact(data.lock);
  return flags(data, ['standalone'], { workspaceStatusApi: 1, workspace, members, packages, ...facts,
    declaredPackages: strings(data.declaredPackages), unsynced: strings(data.unsynced), stale: strings(data.stale),
    external: array(data.external).map(row => fields(row, ['source', 'soul', 'team'])),
    problems: problemRows(data.problems), // warnings[] since kernel #185 (for example an unmapped team label); absent before.
    // 0.30 automation trust adds automation-untrusted {kind, id, remedy} and automation-trust-stale {entry}.
    warnings: own(data, 'warnings') ? array(data.warnings).map(warningRow) : [] });
}
/** One workspace warning. 0.49.0's hook-event-unsupported adds `capability` and `path`: kept when text, else
 * dropped, never refusing the status (the earlier keys stay strict). */
function warningRow(row) {
  const out = fields(row, ['code', 'message', 'label', 'soul', 'repoKey', 'kind', 'id', 'remedy', 'entry']);
  for (const key of ['capability', 'path']) if (text(row[key])) out[key] = row[key];
  return out;
}

/** The kernel's observation provenance (feature observe-max-age): `observation` sits at the
 * top of the raw `status` object and under `result` in a schemaVersion:1 envelope; its shape
 * is {observedAt: ISO-8601, reused: boolean}, reported whenever --max-age was passed (0 included).
 * Absent, or present but malformed, projects as nulls: the stamp is provenance beside the
 * result, never the result, so a bad stamp must not cost the roster or the document — the
 * caller falls back to the time its read completed (maintainer's contract decision). */
export function observationData(document) {
  const holder = record(document) ? (document.schemaVersion === 1 ? document.result : document) : null;
  const value = record(holder) ? holder.observation : undefined;
  const sound = record(value) && typeof value.observedAt === 'string' && value.observedAt.length <= 64 && !Number.isNaN(Date.parse(value.observedAt))
    && typeof value.reused === 'boolean';
  return sound ? { observedAt: value.observedAt, reused: value.reused } : { observedAt: null, reused: null };
}

/** status stays a native {root,agents,workspace} observation. No task/state
 * parsing, file counts, runtime defaults, metadata hydration or v1 card DTO.
 * Liveness here is the kernel's report; terminal-target observation is a
 * separate v2-agnostic Desktop concern. */
const inside = (path, parent) => path.startsWith(parent.endsWith('/') ? parent : parent + '/');
/** A Herdr-recorded row's sessionTarget, reduced to what recognises it as unsupported.
 * Nothing connects with it, so no socket, pane or terminal id is forwarded. */
function sessionTarget(value) {
  return fields(value, ['backend']);
}
export function deploymentStatusData(document, deployment) {
  check(absolute(deployment), 'E_BAD_ARGS'); check(record(document));
  check(document.root === join(deployment, 'agents'), 'E_DEPLOYMENT_SCOPE');
  const root = document.root;
  const seenHomes = new Set(), seenSouls = new Set(), withheld = [];
  const agents = array(document.agents).map(agent => {
    check(record(agent) && text(agent.name) && agent.name.length > 0 && absolute(agent.dir));
    // Every soul directory the kernel reports must belong to the selected
    // deployment. The Desktop does not name or search any layout itself.
    check(inside(agent.dir, deployment), 'E_DEPLOYMENT_SCOPE');
    check(!seenSouls.has(agent.dir)); seenSouls.add(agent.dir);
    const out = withHarness(agent, fields(agent, ['name', 'description', 'work', 'model', 'backend', 'team', 'dir', 'kind', 'repo', 'capability', 'color', 'launch-config']));
    if (own(agent, 'yolo')) { check(agent.yolo === null || typeof agent.yolo === 'boolean'); out.yolo = agent.yolo; }
    // The kernel's soul key, or null when no instance records a workspace soul (an instance-less
    // soul dir, e.g. after a preview or its last retire): the roster contract allows both.
    if (own(agent, 'key')) { check(agent.key === null || soulKey(agent.key)); out.key = agent.key; }
    if (own(agent, 'soulSource')) out.soulSource = soulSource(agent.soulSource);
    if (own(agent, 'retireFailures')) out.retireFailures = array(agent.retireFailures).map(row => fields(row, ['instance', 'completedAt', 'error', 'resultPath']));
    out.instances = array(agent.instances, 10000).flatMap(instance => {
      check(record(instance) && text(instance.instance) && instance.instance.length > 0 && absolute(instance.home));
      // A row whose reported home is not <soul dir>/instances/<instance>, or
      // that repeats another row's home, is WITHHELD — never acted on, never
      // silently dropped: the count and reason reach the header.
      if (dirname(instance.home) !== join(agent.dir, 'instances') || basename(instance.home) !== instance.instance) {
        withheld.push({ agent: agent.name, instance: instance.instance, reason: 'home-outside-soul' }); return [];
      }
      if (seenHomes.has(instance.home)) { withheld.push({ agent: agent.name, instance: instance.instance, reason: 'duplicate-home' }); return []; }
      check(seenHomes.size < 10000); seenHomes.add(instance.home);
      const row = withHarness(instance, fields(instance, ['instance', 'agent', 'home', 'repo', 'work', 'branch', 'model', 'createdAt',
        'parentInstance', 'siblingInstance', 'relation', 'relativeTo', 'runtimeState', 'runtimeError', 'spawnOrigin', 'capability',
        'startedAt', 'modelFrom', 'identityAddress']));
      for (const key of ['running', 'launched', 'captured']) if (own(instance, key)) {
        check(instance[key] === null || typeof instance[key] === 'boolean'); row[key] = instance[key];
      }
      if (own(instance, 'tmux')) row.tmux = instance.tmux === null ? null : fields(instance.tmux, ['session', 'window', 'socket']);
      if (own(instance, 'sessionTarget')) row.sessionTarget = sessionTarget(instance.sessionTarget);
      // Session providers (feature session-providers): where the instance runs, when it is not tmux's. Validated,
      // never check()ed: `backend` is kept when it is text that is not empty (instance-presentation.mjs `sessionProvider` reads it:
      // "tmux", or anything else, which is a provider's and never asked of tmux), else dropped, and the row reads
      // as one with none (a tmux row). "herdr" is not kept: a Herdr-recorded row of this machine is known by its
      // `sessionTarget` or its `runtimeState`, as before session providers, and a row that only names the backend
      // reads as it always did. Of `session` the
      // row keeps the provider's capability and, on this machine's rows, the thread id (`session.threadId`), both
      // for display only; of `open` the link a client may show in place of a terminal (`openLink`: an http(s) url).
      if (own(instance, 'backend') && text(instance.backend) && instance.backend.length > 0 && instance.backend !== 'herdr') row.backend = instance.backend;
      if (own(instance, 'session') && record(instance.session)) {
        const provider = instance.session.provider, threadId = sessionThreadId(instance);
        const session = { ...(text(provider) && provider.length > 0 && provider.length <= 200 ? { provider } : {}), ...(threadId !== null ? { threadId } : {}) };
        if (Object.keys(session).length) row.session = session;
      }
      if (own(instance, 'open')) { const link = openLink(instance); if (link !== null) row.open = link; }
      if (own(instance, 'retirePending')) row.retirePending = true;
      // #1247 (feature status-retire-state): the retire that runs, or failed, or was interrupted. Validated, never
      // check()ed: a value out of the contract is dropped and the row reads as if it had none.
      if (own(instance, 'retire')) { const retire = retireData(instance.retire); if (retire) row.retire = retire; }
      if (own(instance, 'rollbackIncomplete')) row.rollbackIncomplete = true;
      // Feature instance-color: the instance's colour, a palette name exactly (instance-presentation.mjs
      // instanceColor, the one rule of which colour a row shows). Validated, never check()ed: anything
      // else is dropped and the row reads as one with no colour.
      if (own(instance, 'color') && instanceColor(instance) !== null) row.color = instanceColor(instance);
      // Feature instance-background (#1579): the row is placed in the Background section. Exactly true only; any
      // other value is dropped, never checked: the row stays in the main tree.
      if (own(instance, 'background') && instance.background === true) row.background = true;
      // Feature instance-pin: the row is listed first in its machine's list (instance-tree.mjs rowPinned). Exactly
      // true only; any other value is dropped, never checked: the row keeps the roster's order.
      if (own(instance, 'pinned') && instance.pinned === true) row.pinned = true;
      // #802 (feature worktree-event): a spawn running its worktree hooks, verifiably alive. Boolean true only;
      // any other value is dropped, never checked: the row stays an ordinary one.
      if (own(instance, 'spawnInProgress') && instance.spawnInProgress === true) row.spawnInProgress = true;
      // Session resume: how the instance's last session ended, one of SESSION_ENDS exactly. Any other value is
      // dropped, never checked: the row reads as one that did not say.
      if (own(instance, 'sessionEnd') && SESSION_END_VALUES.includes(instance.sessionEnd)) row.sessionEnd = instance.sessionEnd;
      // Related work (features instance-related-work, and instance-same-work before it): the row's work is
      // related to its parent's, or a top-level row's to its sibling's, so the line between them is drawn
      // (related-work.mjs). Boolean true only; any other value is dropped, never checked: the row reads unflagged.
      if (own(instance, 'relatedWork') && instance.relatedWork === true) row.relatedWork = true;
      if (own(instance, 'sameWork') && instance.sameWork === true) row.sameWork = true;
      if (own(instance, 'modules')) row.modules = modules(instance.modules);
      if (own(instance, 'soul')) row.soul = soulSource(instance.soul);
      if (own(instance, 'workspace')) row.workspace = recordedWorkspace(instance.workspace);
      // Missing identity is the producer's absent fact, not a fabricated null
      // principal or a name/address guessed from the instance/soul.
      if (own(instance, 'identity')) row.identity = servedIdentity(instance.identity);
      // Needs input (PR K): validated, never check()ed — an invalid claim is null (unknown), never an E_* that
      // fails the roster. Absent stays absent.
      if (own(instance, 'waitingOnYou')) row.waitingOnYou = waitingOnYouData(instance.waitingOnYou);
      // Feature spawn-attribution: the owning human's label, or null. Validated, never check()ed: a malformed
      // value is null (no human), never an E_* that fails the roster. Absent stays absent.
      if (own(instance, 'attributedHuman')) row.attributedHuman = attributedHumanData(instance.attributedHuman);
      return [row];
    });
    return out;
  });
  const out = { root, agents, withheld };
  if (own(document, 'workspace')) {
    out.workspace = fields(document.workspace, ['code', 'reason', 'message']);
    flags(document.workspace, ['reachable'], out.workspace);
    // Workspace identity (feature workspace-identity, #482): kept as reported for matching this deployment
    // to its workspace across machines (workspace-views.mjs). A shape the contract does not allow
    // never fails the roster: it is marked, and the deployment is shown unmatched.
    if (own(document.workspace, 'key')) {
      const read = readIdentity(document.workspace);
      if (read.status === 'identity') Object.assign(out.workspace, read.identity);
      else out.workspace.identityInvalid = true;
    }
  }
  return out;
}

/* ── Workspace model v2 catalog, sync and onboarding (F2) ───────────────
   Command-specific shapes, projected once where they are read. The kernel's
   rows are kept verbatim within bounds; nothing is joined, inferred or
   re-derived (members' publishes and package capabilities stay distinct —
   the non-collapse rule). */
function memberRow(row) {
  const out = fields(row, ['key', 'name', 'commit', 'status', 'detail', 'team']);
  check(text(out.key)); flags(row, ['confirmed'], out);
  for (const key of ['souls', 'capabilities']) if (own(row, key)) out[key] = strings(row[key]);
  if (own(row, 'publishes')) out.publishes = row.publishes === null ? null : fields(row.publishes, ['package', 'version']);
  if (own(row, 'url')) { check(row.url === null || text(row.url)); out.url = row.url; }
  if (own(row, 'membershipFile')) out.membershipFile = fileRef(row.membershipFile);
  return out;
}
function packageRow(row) {
  const out = fields(row, ['id', 'version', 'source', 'commit', 'integrity']); check(text(out.id));
  if (own(row, 'capabilities')) out.capabilities = strings(row.capabilities);
  if (own(row, 'latest')) out.latest = row.latest === null ? null : fields(row.latest, ['version', 'ref']);
  return out;
}
const problemRows = value => array(value).map(row => fields(row, ['code', 'message', 'repoKey', 'path']));

/** `oats sync --json` (syncApi 1): the lock it wrote and what changed. */
export function syncData(document, deployment) {
  check(absolute(deployment), 'E_BAD_ARGS');
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && data.syncApi === 1 && record(data.workspace));
  check(data.workspace.local === join(deployment, 'oats-local.yaml'), 'E_DEPLOYMENT_SCOPE');
  const workspace = fields(data.workspace, ['name', 'key', 'url', 'commit', 'observedAt', 'local', 'lock']);
  check(text(workspace.name) && text(workspace.key));
  return flags(data, ['standalone'], { syncApi: 1, workspace,
    members: array(data.members).map(memberRow), packages: array(data.packages).map(packageRow),
    changes: array(data.changes).map(row => { const out = fields(row, ['id', 'from', 'to', 'commit']); check(text(out.id)); return out; }),
    problems: problemRows(data.problems) });
}

/** `oats capabilities --json` (capabilitiesApi 1): every non-private item of
 * every confirmed member, external souls' and locked packages' capabilities. */
export function capabilitiesData(document) {
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && data.capabilitiesApi === 1);
  const workspace = fields(data.workspace, ['name', 'key', 'commit']);
  const capabilities = array(data.capabilities).map(row => {
    const out = fields(row, ['name', 'origin', 'kind', 'repoKey', 'commit', 'team', 'path', 'layer', 'version', 'package', 'description', 'tree']);
    check(text(out.name) && out.name.length > 0 && ['member', 'package', 'external'].includes(out.kind));
    // What it provides (desktop-facts); skills is null when a spawn could not list them.
    if (own(row, 'skills')) out.skills = row.skills === null ? null : strings(row.skills);
    for (const key of ['commands', 'hooks']) if (own(row, key)) out[key] = strings(row[key]);
    if (own(row, 'file')) out.file = fileRef(row.file);
    return flags(row, ['private'], out);
  });
  return { capabilitiesApi: 1, workspace, capabilities, problems: problemRows(data.problems) };
}

/** `oats souls --json` (soulsApi 1): the deployment's spawn catalog — every
 * non-private soul of a confirmed member, and external souls, with the work
 * mode each declares. Names are unique per catalog (the kernel refuses an
 * ambiguous bare name with E_SOUL_AMBIGUOUS; such a soul is not offered). */
const SOUL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const TEAM_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/; // the kernel's package-id grammar, bounded
// The kernel's soul key (K1's pattern): '*' never names one soul, so it is not a row key.
const SOUL_KEY = /^(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
const soulKey = v => typeof v === 'string' && v.length <= 256 && SOUL_KEY.test(v);
/** A soul row's `capabilities` (feature souls-capabilities, OATS 0.45.0): the soul's composed capabilities
 * (turned-off ones are not listed), each in `oats capabilities`' own row keys — `{name, kind: 'member', repoKey}`
 * or `{name, kind: 'package', package}`; the kernel reports no external entry — plus `from` ('soul' | 'workspace';
 * 'soul' when it is both). `null`: the soul did not resolve (exactly when it is not spawnable); `[]` composes
 * nothing. The one place the entry shape is read: anything else is undefined, and the caller refuses the document. */
const COMPOSED_FROM = ['soul', 'workspace'];
const capabilityName = v => typeof v === 'string' && v.length > 0 && v.length <= 256;
const repoKeyOf = v => typeof v === 'string' && v.length > 0 && v.length <= 1024;
export function soulCapabilitiesOf(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1024) return undefined;
  const out = [];
  for (const entry of value) {
    if (!record(entry) || !capabilityName(entry.name) || !COMPOSED_FROM.includes(entry.from)) return undefined;
    if (entry.kind === 'package') {
      if (!(typeof entry.package === 'string' && PACKAGE_ID.test(entry.package)) || own(entry, 'repoKey')) return undefined;
      out.push({ name: entry.name, kind: 'package', package: entry.package, from: entry.from });
    } else if (entry.kind === 'member') {
      if (!repoKeyOf(entry.repoKey) || own(entry, 'package')) return undefined;
      out.push({ name: entry.name, kind: 'member', repoKey: entry.repoKey, from: entry.from });
    } else return undefined;
  }
  return out;
}
export function soulsData(document) {
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && data.soulsApi === 1);
  const workspace = fields(data.workspace, ['name', 'key', 'commit']);
  const seen = new Map();
  for (const row of array(data.souls)) {
    const out = fields(row, ['name', 'origin', 'kind', 'repoKey', 'commit', 'team', 'path', 'work', 'description']);
    check(SOUL_NAME.test(out.name ?? '') && ['member', 'external', 'package'].includes(out.kind)
      && ['worktree', 'checkout', 'directory', 'workspace', 'attached'].includes(out.work));
    // Package souls (feature package-souls, 0.28): a soul a locked package ships, addressed by its
    // qualified name `<package>/<soul>`.
    if (out.kind === 'package') {
      check(typeof row.package === 'string' && PACKAGE_ID.test(row.package) && typeof row.version === 'string' && row.version.length > 0 && row.version.length <= 64
        && row.qualifiedName === `${row.package}/${out.name}`);
      Object.assign(out, { package: row.package, version: row.version, qualifiedName: row.qualifiedName });
    } else check(!own(row, 'qualifiedName') && !own(row, 'package'));
    // The soul key (`oats soul teams <key>`, the souls.teams/souls.default keys) is the kernel's
    // soul-key rule, exactly: a package soul's qualified name, every other soul's bare name
    // (external included). When the row reports `key`, it must BE that key: a mismatch refuses the
    // document (a kernel/contract defect, never papered over).
    out.key = out.kind === 'package' ? out.qualifiedName : out.name;
    if (own(row, 'key')) check(soulKey(row.key) && row.key === out.key);
    flags(row, ['private', 'spawnable'], out);
    // Feature instance-background (#1579): the soul declares `background: true`, the default of the spawn dialog's
    // Run in background switch. Exactly true only; any other value is dropped, never checked (as an instance row's).
    if (own(row, 'background') && row.background === true) out.background = true;
    // desktop-facts: whether a spawn here would refuse, and the file. The row's flat harness/model/harnessFrom
    // are not kept: with launch-preference (0.30) the soul and this machine choose them, and the row's `launch`
    // (below) carries the kernel's report of that choice; before 0.30 they were always the kernel's default.
    if (own(row, 'problem')) out.problem = problemRef(row.problem);
    if (own(row, 'file')) out.file = fileRef(row.file);
    // Team model v2 (0.30): the soul's teams here (TeamRow, the default first) and its default.
    if (own(row, 'teams')) { const teams = teamRowsOf(row.teams); check(teams !== undefined); out.teams = teams; }
    if (own(row, 'defaultTeam')) { const d = defaultTeamOf(row.defaultTeam); check(d !== undefined); out.defaultTeam = d; }
    // Launch preferences (0.30, feature launch-preference): what a spawn with no flags would decide here.
    if (own(row, 'launch')) { const l = launchOf(row.launch, REPORT_FROM); check(l !== undefined); out.launch = l; }
    // Its composed capabilities (feature souls-capabilities): Capabilities' "Used by" reads them.
    // null exactly when the kernel reports the soul not spawnable here (the contract): a disagreement refuses the document.
    if (own(row, 'capabilities')) {
      const c = soulCapabilitiesOf(row.capabilities); check(c !== undefined);
      if (typeof row.spawnable === 'boolean') check((c === null) === (row.spawnable === false));
      out.capabilities = c;
    }
    // 0.29: every team label the soul carries (primary first; teams contract), when reported.
    if (own(row, 'labels')) {
      check(Array.isArray(row.labels) && row.labels.length <= 64 && row.labels.every(l => typeof l === 'string' && TEAM_LABEL.test(l)) && new Set(row.labels).size === row.labels.length);
      out.labels = [...row.labels];
    }
    // One soul per key: a package soul never collides with a member of the same bare name, while a
    // member and an external soul of one name stay ambiguous (never guess which one spawns).
    const id = out.key;
    seen.set(id, seen.has(id) ? null : out);
  }
  const souls = [...seen.values()].filter(Boolean);
  const ambiguous = [...seen].filter(([, row]) => row === null).map(([key]) => key);
  return { soulsApi: 1, workspace, souls, ambiguous, problems: problemRows(data.problems) };
}

/** `oats onboard --json` (onboardApi 2) for the directory the operator chose. */
export function onboardData(document, dir) {
  check(absolute(dir), 'E_BAD_ARGS');
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && data.onboardApi === 2 && data.dir === dir, 'E_DEPLOYMENT_SCOPE');
  check(data.local === join(dir, 'oats-local.yaml'), 'E_DEPLOYMENT_SCOPE');
  const out = fields(data, ['local', 'dir', 'agents', 'lock']);
  out.sync = syncData({ schemaVersion: 1, ok: true, result: data.sync }, dir);
  if (own(data, 'hosting')) { out.hosting = fields(data.hosting, ['host', 'rule']); flags(data.hosting, ['hostIsMember'], out.hosting); }
  check(record(data.next));
  out.next = { clone: array(data.next.clone).map(row => flags(row, ['present', 'host'], fields(row, ['key', 'name', 'url', 'dir']))),
    spawn: data.next.spawn === null || data.next.spawn === undefined ? null : (check(text(data.next.spawn)), data.next.spawn),
    souls: own(data.next, 'souls') ? strings(data.next.souls) : [] };
  return out;
}

/* ── Team model v2 (feature team-model-2, OATS 0.30): the deployment's and a soul's teams.
   docs/desktop-cli-api.md "Team model v2". Config-only kernel verbs; the kernel's rows are kept
   within bounds, never re-derived. */
const labels = value => { const out = array(value, 256); check(out.every(l => typeof l === 'string' && TEAM_LABEL.test(l)) && new Set(out).size === out.length); return [...out]; };
const labelOrNull = value => { check(value === null || (typeof value === 'string' && TEAM_LABEL.test(value))); return value; };
const changed = (data, out) => { if (own(data, 'changed')) { check(typeof data.changed === 'boolean'); out.changed = data.changed; } return out; };
/* A team readiness item: its code, severity, the kernel's message and fix, and the problem's own keys
   (a label, a souls: key, the local-teams-closed condition with its path and keys). */
function teamProblems(value) {
  return array(value, 256).map(row => {
    const out = fields(row, ['code', 'label', 'key', 'severity', 'message', 'fix', 'at', 'condition', 'path']);
    check(text(out.code) && (out.severity === undefined || ['failure', 'warning'].includes(out.severity)));
    if (own(row, 'keys')) out.keys = [...strings(row.keys)];
    return flags(row, ['default'], out);
  });
}
/** `oats teams [add|remove|default …] --json`: this deployment's teams. teamsApi 1 (team-model-2, OATS
 * 0.30–0.37) or teamsApi 2 (team-model-3, OATS 0.38), each read in its own shape. */
export function teamsData(document, deployment) {
  check(absolute(deployment), 'E_BAD_ARGS');
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && (data.teamsApi === 1 || data.teamsApi === 2));
  check(data.deployment === deployment, 'E_DEPLOYMENT_SCOPE');
  const teams = array(data.teams, 256).map(row => {
    const out = fields(row, ['label', 'team', 'description', 'from', 'at']);
    check(TEAM_LABEL.test(out.label ?? '') && ['shared', 'local'].includes(out.from) && typeof row.default === 'boolean' && (out.team === null || TEAM_ID.test(out.team)));
    out.default = row.default; return out;
  });
  check(new Set(teams.map(t => t.label)).size === teams.length && teams.filter(t => t.default).length <= 1);
  if (data.teamsApi === 2) {
    // Team model 3: whether local teams are allowed (null: the standalone view), the DefaultTeam a soul
    // without a souls: default gets here, and the workspace's souls: patterns as committed.
    check(data.localTeams === null || typeof data.localTeams === 'boolean');
    const defaultTeam = defaultTeamOf(data.defaultTeam); check(defaultTeam !== undefined);
    check(record(data.souls) && Object.keys(data.souls).length <= 1024);
    const souls = Object.fromEntries(Object.entries(data.souls).map(([pattern, rule]) => {
      check(text(pattern) && pattern.length <= 256 && record(rule));
      const out = {};
      if (own(rule, 'default')) { check(typeof rule.default === 'string' && TEAM_LABEL.test(rule.default)); out.default = rule.default; }
      if (own(rule, 'teams')) out.teams = rule.teams === 'any' ? 'any' : labels(rule.teams);
      return [pattern, out];
    }));
    return changed(data, { teamsApi: 2, deployment, localTeams: data.localTeams, defaultTeam, teams, souls, problems: teamProblems(data.problems) });
  }
  check(record(data.souls) && record(data.souls.teams) && record(data.souls.default));
  const map = (value, one) => Object.fromEntries(Object.entries(value).map(([key, v]) => { check(text(key) && key.length <= 256); return [key, one ? labelOrNull(v) : labels(v)]; }));
  return changed(data, { teamsApi: 1, deployment, defaultTeam: labelOrNull(data.defaultTeam), teams,
    souls: { teams: map(data.souls.teams, false), default: map(data.souls.default, true) }, problems: teamProblems(data.problems) });
}
/* Why a soul may join a team, in the kernel's order: soulTeamsApi 1 (the deployment's souls.teams) and
   soulTeamsApi 2 (team model 3: its default, its workspace souls: pattern, a local team). */
const VIA = { 1: ['default', '*', 'soul'], 2: ['default', 'workspace', 'local'] };
/** `oats soul teams <soul>|'*' … --json`. soulTeamsApi 1 (team-model-2: the reply to a show or an edit)
 * or soulTeamsApi 2 (team-model-3: read only, with the souls: keys its teams and default came from). */
export function soulTeamsData(document) {
  check(record(document) && document.schemaVersion === 1 && document.ok === true);
  const data = document.result;
  check(record(data) && (data.soulTeamsApi === 1 || data.soulTeamsApi === 2) && text(data.soul) && text(data.key));
  const defaultTeam = defaultTeamOf(data.defaultTeam); check(defaultTeam !== undefined);
  const via = VIA[data.soulTeamsApi];
  const teams = array(data.teams, 128).map(row => {
    const out = teamRow(row);
    check(out && Object.hasOwn(out, 'default') && Array.isArray(row.via) && row.via.length > 0 && row.via.every(v => via.includes(v))
      && new Set(row.via).size === row.via.length && row.via.every((v, i) => i === 0 || via.indexOf(row.via[i - 1]) < via.indexOf(v)));
    return { ...out, via: [...row.via] };
  });
  check(new Set(teams.map(t => t.label)).size === teams.length);
  if (data.soulTeamsApi === 2) {
    const key = v => { check(v === null || (text(v) && v.length <= 256)); return v; };
    return changed(data, { soulTeamsApi: 2, soul: data.soul, key: data.key, match: key(data.match), defaultMatch: key(data.defaultMatch), defaultTeam, teams });
  }
  check(record(data.local));
  return changed(data, { soulTeamsApi: 1, soul: data.soul, key: data.key, defaultTeam, teams,
    local: { teams: labels(data.local.teams), default: labelOrNull(data.local.default) }, all: labels(data.all) });
}
