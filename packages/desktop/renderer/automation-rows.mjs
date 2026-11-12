/** Schedules + Triggers (§2.3a, kernel 0.29.0 `automations`): the ONE adapter from
 * `oats schedule list --json` / `oats trigger list --json` to the rows the views
 * render. The kernel places every row (runsHere, reason, enabledHere); this module
 * only reads those facts and never re-derives placement. When the contract
 * grows (docs/desktop-cli-api.md "Workspace triggers and schedules"), only this
 * file changes. */

import { displayLine, DETAIL_WITHHELD, MAX_DISPLAY_LINE } from '../../client/display-text.mjs';

const text = v => typeof v === 'string' && v ? v : null;
const list = v => Array.isArray(v) ? v : [];
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
// 0.30 adds `untrusted` (automations.trust): placed on this host, but oats-local.yaml does not admit it.
const REASONS = new Set(['host-unnamed', 'assigned-elsewhere', 'owner-mismatch', 'untrusted']);
/** The whitelisted template fields (§2.3): the only ones the kernel substitutes. */
export const TASK_FIELDS = Object.freeze(['repo', 'number', 'url', 'event', 'headSha']);
/** With feature `trigger-sources`: a github.pull_request trigger's fields, and a capability source's (which
 * also takes `{fields.<name>}`, any field the source declares). */
export const PULL_REQUEST_TASK_FIELDS = Object.freeze([...TASK_FIELDS, 'trigger', 'subject', 'key']);
export const SOURCE_TASK_FIELDS = Object.freeze(['trigger', 'source', 'subject', 'event', 'key', 'url']);

export const PULL_REQUEST = 'github.pull_request';
/** Capability trigger sources (#669 2b): everything about them is gated on the CLI declaring this feature. */
export const TRIGGER_SOURCES_FEATURE = 'trigger-sources';
export const triggerSourcesSupported = cli => Array.isArray(cli?.features) && cli.features.includes(TRIGGER_SOURCES_FEATURE);
// The kernel's capability-name grammar: only such a name is ever looked up (Open capability).
const CAPABILITY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A capability source, from a trigger's `on`: `on.source` is `<capability>:<source>`, an open string (anything
 * that is not github.pull_request). → { id, capability, name, lookup } for display (`lookup`: the capability's
 * name when it is one, for the catalog; else null), or null for a pull-request trigger and for a definition
 * with no readable `on.source`. `status`: the status row's own `source: { capability, name }`, preferred. */
export function capabilitySource(on, status = null) {
  const id = record(on) ? text(on.source) : null;
  if (!id || id === PULL_REQUEST) return null;
  const at = id.indexOf(':'), split = at > 0 ? [id.slice(0, at), id.slice(at + 1)] : [id, ''];
  const capability = text(status?.capability) || split[0], name = text(status?.name) || split[1];
  return { id: displayLine(id), capability: displayLine(capability), name: displayLine(name), lookup: CAPABILITY_NAME.test(capability) ? capability : null };
}
/** "acme.graph · harvest-branches": how a capability source is named everywhere. */
export const sourceLabel = source => [source?.capability, source?.name].filter(Boolean).join(' · ') || null;

/** A poll failure's `cause`, in the Desktop's words; an unknown cause shows its code as is. */
const CAUSES = Object.freeze({ exit: "the source's command failed", result: "the source's answer was not valid", 'too-many-events': 'the source returned too many events',
  timeout: "the source's command timed out", refused: 'the source refused', resolution: 'the source could not be found' });
export const causeWords = cause => typeof cause === 'string' && Object.hasOwn(CAUSES, cause) ? CAUSES[cause] : displayLine(cause);
/** Why OATS refused an event (`invalidEvents[].rule`), in the Desktop's words; an unknown rule shows its code. */
const RULES = Object.freeze({ shape: 'not an event object', 'unknown-key': 'an unknown key', key: 'a bad key', subject: 'a bad subject', event: "an event this source doesn't declare",
  url: "a URL that isn't allowed", fields: "a field that isn't allowed", 'duplicate-key': 'a repeated key' });
export const ruleWords = rule => typeof rule === 'string' && Object.hasOwn(RULES, rule) ? RULES[rule] : displayLine(rule);

/** At most this many parameters, refused events and skipped items are listed; the rest are counted. */
export const PARAMS_SHOWN = 16, EVENTS_SHOWN = 10;
/** A capability-source trigger's `on.params`, as display-only lines for the quote treatment ("From the trigger
 * file:"): `name = value`, as written, through displayLine; nothing is substituted, linked or interpreted.
 * A value cut to fit a display line says so, as does an empty one and one that is not text.
 * → { count, lines: [{ text, note }], more } (count 0: no parameters). */
export function sourceParams(on) {
  const entries = record(on) && record(on.params) ? Object.entries(on.params) : [];
  const lines = entries.slice(0, PARAMS_SHOWN).map(([name, value]) => {
    if (typeof value !== 'string') return { text: displayLine(name), note: 'Its value is not text: not shown.' };
    const whole = `${name} = ${value}`;
    return { text: displayLine(whole), note: value === '' ? 'Its value is empty.' : whole.length > MAX_DISPLAY_LINE ? `Cut at ${MAX_DISPLAY_LINE} characters: the end is not shown.` : null };
  });
  return { count: entries.length, lines, more: Math.max(0, entries.length - PARAMS_SHOWN) };
}

/** Which group a row belongs to, from the kernel's placement:
 * here: this computer runs it, or would but it is off / invalid here;
 * attention: named for this computer but it cannot run (owner-mismatch, untrusted), a reason this Desktop
 *   does not know (the contract: it does not run here), or an invalid definition placed here;
 * elsewhere: another host, or this host has no name. */
export function automationGroup(row) {
  if (row.reason === 'assigned-elsewhere' || row.reason === 'host-unnamed') return 'elsewhere';
  if (row.reason === 'owner-mismatch' || row.reason === 'untrusted' || row.reason === 'other') return 'attention';
  if (row.invalid || row.unreadable) return 'attention';
  return 'here';
}

function origin(raw, qualifiedId) {
  const o = record(raw) ? raw : {};
  const member = typeof qualifiedId === 'string' && qualifiedId.includes('/') ? qualifiedId.slice(0, qualifiedId.indexOf('/')) : null;
  // url: the file's web URL at its commit (github.com members); localPath: the file in this machine's clone.
  if (o.kind === 'workspace') return { kind: 'workspace', member: member && member !== 'local' ? member : null, repoKey: text(o.repoKey), path: text(o.path), commit: text(o.commit), url: webUrl(o.url), localPath: text(o.localPath) };
  return { kind: 'local', member: null, repoKey: null, path: text(o.path), commit: null, url: null, localPath: text(o.localPath) };
}
const webUrl = v => typeof v === 'string' && /^https:\/\//.test(v) ? v : null;
function soul(raw) {
  if (!record(raw) || !text(raw.name)) return null;
  const o = record(raw.origin) ? raw.origin : null;
  return { name: raw.name, origin: o && text(o.kind) ? o : null };
}

/** One kernel row → the view's row. Unknown or missing facts stay null; nothing is guessed. */
export function automationRow(raw, kind) {
  if (!record(raw)) return null;
  const qualifiedId = text(raw.qualifiedId) || text(raw.id);
  if (!qualifiedId) return null;
  const spawnOf = kind === 'trigger' ? (record(raw.spawn) ? raw.spawn : {}) : raw;
  const row = {
    kind,
    // A schedule's kernel `kind` is its run (spawn, command, wake, operation).
    run: kind === 'schedule' ? text(raw.kind) : 'spawn',
    id: qualifiedId, key: qualifiedId, name: text(raw.name) || qualifiedId.split('/').pop(),
    origin: origin(raw.origin, qualifiedId),
    description: text(raw.description), owner: text(raw.owner), runsOn: text(raw.runsOn),
    runsHere: raw.runsHere === true,
    // An unknown reason (a newer kernel) is kept as `other`: it does not run here, as sent.
    reason: REASONS.has(raw.reason) ? raw.reason : text(raw.reason) ? 'other' : null, reasonDetail: text(raw.reasonDetail),
    ...(text(raw.reason) && !REASONS.has(raw.reason) ? { reasonCode: raw.reason.slice(0, 64) } : {}),
    enabledHere: raw.enabledHere !== false, enabled: raw.enabled !== false,
    soul: soul(raw.soul), task: text(raw.task),
    on: kind === 'trigger' && record(raw.on) ? raw.on : null,
    spawn: kind === 'trigger' && record(raw.spawn) ? raw.spawn : null,
    // What it sends, per run, read from the stored definition the kernel spreads into the row:
    // a wake's message and home, a command's argv and cwd, an operation and its home.
    message: text(raw.message), home: text(raw.home), operation: text(raw.operation), cwd: text(raw.cwd),
    argv: Array.isArray(raw.argv) && raw.argv.every(a => typeof a === 'string') ? raw.argv : null,
    // A spawn's own settings: a schedule's are top-level, a trigger's sit under `spawn`.
    purpose: text(spawnOf.purpose), backend: text(spawnOf.backend), yolo: typeof spawnOf.yolo === 'boolean' ? spawnOf.yolo : null,
    wake: kind === 'schedule' && record(raw.wake) && text(raw.wake.cron) ? { cron: raw.wake.cron, tz: text(raw.wake.tz), message: text(raw.wake.message) } : null,
    // Run state (schedules on this computer): the job lock, an attempt with no recorded result, a wake waiting.
    running: raw.running === true, attempt: record(raw.attempt) ? raw.attempt : null, pendingWake: record(raw.pendingWake) ? raw.pendingWake : null,
    scope: text(raw.scope), createdAt: text(raw.createdAt), updatedAt: text(raw.updatedAt),
    cron: kind === 'schedule' ? text(raw.cron) : null, tz: kind === 'schedule' ? text(raw.tz) : null,
    teams: list(raw.teams).filter(text), launchConfig: text(raw.launchConfig) || text(raw.spawn?.launchConfig), harness: text(raw.harness), model: text(raw.model),
    concurrency: record(raw.concurrency) ? raw.concurrency : null,
    template: record(raw.template) ? raw.template : null,
    lastRun: record(raw.lastRun) ? raw.lastRun : null, nextDue: text(raw.nextDue),
    recentRuns: list(raw.recentRuns).filter(record),
    invalid: record(raw.invalid) ? raw.invalid : null,
    unreadable: record(raw.unreadable) ? raw.unreadable : null,
    // The kernel's own row, for the local schedule editor's draft (never rendered).
    raw,
  };
  row.group = automationGroup(row);
  return row;
}

const PROMPT_LINE = 'No summary set — first line of the prompt';
/** The list row's summary line: the authored description, else the first non-empty line of what it
 * sends to an agent (a spawn's or trigger's task, a wake's message), marked derived; else null
 * (command and operation rows: "No summary"; never a label made from argv).
 * → { text, title, derived } | null */
export function summaryLine(row) {
  if (row?.description) return { text: row.description, title: row.description, derived: false };
  const prompt = row?.run === 'wake' ? row.message : row?.run === 'spawn' ? row.task : null;
  const first = typeof prompt === 'string' ? prompt.split(/\r\n|[\n\r\u2028\u2029]/).map(l => l.trim()).find(Boolean) : null;
  return first ? { text: first, title: PROMPT_LINE, derived: true } : null;
}

/** A schedule's run state on this computer, from the kernel's row: unknown, running, and a wake
 * waiting to be delivered. `running` is the job lock (a host slot), not proof of a launch: an attempt
 * whose effects are unconfirmed keeps its lock (lib/schedule.mjs), so unknown wins — an attempt with
 * an error, a last run of outcome `unknown`, or an attempt with no lock (a crash before its result);
 * running is a held lock with none of those (since its attempt, or the launch it holds the slot for).
 * → { running, unknown, pendingWake } | null when there is nothing to say. */
export function runState(row) {
  if (row?.kind !== 'schedule') return null;
  const attempt = row.attempt, last = row.lastRun;
  const unresolved = !!text(attempt?.error) || last?.outcome === 'unknown' || (!!attempt && !row.running);
  const running = row.running && !unresolved ? { since: text(attempt?.startedAt) || text(last?.startedAt) } : null;
  const from = attempt || last || {};
  const unknown = unresolved ? {
    since: text(from.startedAt) || text(from.scheduledFor), scheduledFor: text(from.scheduledFor), holdsSlot: row.running,
    exited: attempt?.exited === true ? true : null,
    exitStatus: Number.isInteger(attempt?.exitStatus) ? attempt.exitStatus : null, exitSignal: text(attempt?.exitSignal),
    error: text(attempt?.error) || text(last?.error),
  } : null;
  const pendingWake = row.pendingWake ? { scheduledFor: text(row.pendingWake.scheduledFor) } : null;
  return running || unknown || pendingWake ? { running, unknown, pendingWake } : null;
}
// The kernel's own shell-safe word test for a --dir it prints (lib/schedule.mjs remedy).
const shellWord = v => /^[\w./@%+=:,-]+$/.test(v) ? v : `'${v.replaceAll("'", `'\\''`)}'`;
/** `oats schedule reconcile <qualified id> [--clear] --dir <scope>`: a command that works when pasted. */
export function reconcileCommand(row, { clear = false } = {}) {
  return ['oats schedule reconcile', shellWord(row.id), clear ? '--clear' : null, row.scope ? `--dir ${shellWord(row.scope)}` : null].filter(Boolean).join(' ');
}

/** A package template's provenance in words: "oats.okf:proposal-review v0.4.0 @abc1234", or a
 * workspace trigger's `from:` ("oats.okf:proposal-review"). */
export function templateProvenance(template) {
  if (!record(template)) return null;
  const label = templateLabel(template) || text(template.from);
  if (!label) return null;
  return [label, text(template.version) ? `v${template.version.replace(/^v/, '')}` : null, text(template.commit) ? `@${template.commit.slice(0, 7)}` : null].filter(Boolean).join(' ');
}

/** A whole list answer → { kind, host, scheduler, snapshot, rows }, or null when it is not one. */
export function automationRows(json, kind) {
  if (!record(json) || !['schedule', 'trigger'].includes(kind)) return null;
  const raws = kind === 'trigger' ? json.triggers : json.schedules;
  if (!Array.isArray(raws)) return null;
  const rows = raws.map(raw => automationRow(raw, kind)).filter(Boolean);
  // ghUser: { <gh host>: login | null } — who this machine's gh is on each GitHub host the rows name.
  const host = record(json.host) ? { name: text(json.host.name), ghUser: record(json.host.ghUser) ? json.host.ghUser : {} } : { name: null, ghUser: {} };
  const snapshot = record(json.snapshot) ? { takenAt: text(json.snapshot.takenAt), problems: Number.isInteger(json.snapshot.problems) ? json.snapshot.problems : list(json.snapshot.problems).length } : null;
  return { kind, host, scheduler: record(json.scheduler) ? json.scheduler : null, snapshot, rows };
}

/** The groups in page order, each with its rows (empty groups omitted). */
export const GROUPS = Object.freeze([
  { id: 'here', title: 'Runs on this computer' },
  { id: 'attention', title: 'Needs attention here' },
  { id: 'elsewhere', title: 'Runs elsewhere' },
]);
export function groupRows(rows) {
  return GROUPS.map(g => ({ ...g, rows: rows.filter(r => r.group === g.id) })).filter(g => g.rows.length);
}

/** The origin filter (All / Workspace / Local) and the search (id, soul, task or wake message, description). */
export function filterRows(rows, { origin = 'all', query = '' } = {}) {
  const needle = String(query || '').trim().toLowerCase();
  return rows.filter(r => (origin === 'all' || r.origin.kind === origin)
    && (!needle || [r.id, r.soul?.name, r.task, r.message, r.description, r.runsOn, r.owner].some(v => typeof v === 'string' && v.toLowerCase().includes(needle))));
}

/** "github.com/acme-kb-bot" → { login: "acme-kb-bot", host: "github.com" }. */
export function ownerParts(owner) {
  const m = typeof owner === 'string' && /^([^/\s]+)\/([^/\s]+)$/.exec(owner);
  return m ? { host: m[1], login: m[2] } : null;
}

/** Who this machine's gh is logged in as on the owner's GitHub host: "github.com/alex",
 * "not logged in", or null when the kernel does not say. */
export function hostLogin(host, owner) {
  const parts = ownerParts(owner);
  if (!parts || !record(host?.ghUser) || !Object.hasOwn(host.ghUser, parts.host)) return null;
  const login = host.ghUser[parts.host];
  return text(login) ? `${parts.host}/${login}` : 'not logged in';
}

/** Where a row runs, in words: { label, tone: ok|warn|muted, detail }. */
export function placementText(row, host) {
  if (row.origin.kind === 'local') return { label: 'This computer', tone: row.enabledHere ? 'ok' : 'muted', detail: 'Local: runs on this computer as its own gh login' };
  if (row.reason === 'owner-mismatch') return { label: 'Wrong account here', tone: 'warn', detail: row.reasonDetail };
  if (row.reason === 'untrusted') return { label: 'Not trusted here', tone: 'warn', detail: row.reasonDetail };
  if (row.reason === 'other') return { label: "Doesn't run here", tone: 'warn', detail: row.reasonDetail || `reason: ${row.reasonCode}` };
  if (row.reason === 'host-unnamed') return { label: row.runsOn || 'Not named', tone: 'muted', detail: 'This computer has no host name' };
  if (row.reason === 'assigned-elsewhere') return { label: row.runsOn || 'Another host', tone: 'muted', detail: row.reasonDetail };
  return { label: 'This computer', tone: row.enabledHere ? 'ok' : 'muted', detail: host?.name ? `This computer is ${host.name}` : null };
}

/** The fields a trigger's templates take, by its source: today's five without feature trigger-sources; with it,
 * a pull-request trigger's (plus `trigger`, `subject`, `key`) or a capability source's (plus `fields.<name>`). */
export function taskFields(on, { sources = false } = {}) {
  if (!sources) return { fields: TASK_FIELDS, named: false };
  return capabilitySource(on) ? { fields: SOURCE_TASK_FIELDS, named: true } : { fields: PULL_REQUEST_TASK_FIELDS, named: false };
}
/** The task template split into text and whitelisted field tokens, for highlighting. `named`: also
 * `{fields.<name>}`, a field a capability source declares (the kernel's field-name grammar). */
export function taskParts(task, { fields = TASK_FIELDS, named = false } = {}) {
  const out = [];
  if (typeof task !== 'string') return out;
  const re = new RegExp(`\\{(${[...fields, ...(named ? ['fields\\.[A-Za-z][A-Za-z0-9_]{0,39}'] : [])].join('|')})\\}`, 'g');
  let at = 0;
  for (const m of task.matchAll(re)) {
    if (m.index > at) out.push({ text: task.slice(at, m.index) });
    out.push({ field: m[1] }); at = m.index + m[0].length;
  }
  if (at < task.length) out.push({ text: task.slice(at) });
  return out;
}

const pad = n => String(n).padStart(2, '0');
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
/** Common cron shapes in words; anything else → null (the view shows the cron itself). */
export function cronInWords(cron) {
  const f = typeof cron === 'string' ? cron.trim().split(/\s+/) : [];
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const every = /^\*\/(\d+)$/.exec(min);
  if (every && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${every[1]} minutes`;
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== '*' || mon !== '*') return null;
  const at = `${pad(hour)}:${pad(min)}`;
  if (dow === '*') return `Daily at ${at}`;
  if (dow === '1-5') return `Weekdays at ${at}`;
  if (/^[0-6]$/.test(dow)) return `${DAYS[Number(dow)]} at ${at}`;
  return null;
}

const SOURCES = { 'github.pull_request': 'Pull request' };
/** A trigger's event in words: "Pull request opened, reopened" + repo + labels + base. With `sources`
 * (feature trigger-sources) a capability source's is "<capability> · <name>: <events>", its event names as the
 * source declares them, with `source` and `events` for the On card. */
export function onSummary(on, { sources = false } = {}) {
  if (!record(on)) return null;
  const source = sources ? capabilitySource(on) : null;
  if (source) {
    const events = list(on.events).map(displayLine).filter(Boolean);
    return { title: [sourceLabel(source), events.join(', ')].filter(Boolean).join(': '), repo: null, labels: [], base: null, poll: displayLine(on.poll), source, events };
  }
  const events = list(on.events).filter(text).map(e => e.replace(/_/g, ' '));
  return {
    title: [SOURCES[on.source] || text(on.source) || 'Event', events.join(', ')].filter(Boolean).join(' '),
    repo: text(on.repo) ? on.repo.replace(/^github\.com\//, '') : null,
    labels: list(on.labels).filter(text), base: text(on.base), poll: text(on.poll),
  };
}

/** A timestamp relative to now ("in 5 min", "2 h ago"), with the absolute time for its title. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const d = t - now, a = Math.abs(d), future = d > 0;
  const unit = a < 60e3 ? null : a < 3600e3 ? `${Math.round(a / 60e3)} min` : a < 86400e3 ? `${Math.round(a / 3600e3)} h` : `${Math.round(a / 86400e3)} d`;
  return { label: unit === null ? (future ? 'in under a minute' : 'just now') : future ? `in ${unit}` : `${unit} ago`, title: new Date(t).toLocaleString() };
}

/** "oats.okf:proposal-review" for a row's package template ({ package, version, commit, template }). */
export function templateLabel(template) {
  if (!record(template)) return null;
  return [text(template.package), text(template.template) || text(template.id)].filter(Boolean).join(':') || null;
}

/** A soul origin in words, for a chip's second line and its title. */
export function soulOriginText(origin) {
  if (!record(origin)) return { short: 'not found here', long: 'This name does not resolve in this workspace (or there is no snapshot yet)' };
  if (origin.kind === 'package') return { short: `package ${text(origin.package) || ''}`.trim(), long: `A soul of the locked package ${[origin.package, origin.version].filter(text).join(' ')}` };
  if (origin.kind === 'member') return { short: text(origin.member) || 'member', long: `A soul in the member ${text(origin.member) || text(origin.repoKey) || ''}` };
  if (origin.kind === 'external') return { short: 'external', long: `An external soul${text(origin.source) ? ` from ${origin.source}` : ''}` };
  if (origin.kind === 'ambiguous') return { short: 'ambiguous name', long: `${Number.isInteger(origin.candidates) ? origin.candidates : 'Several'} souls answer to this name; a spawn needs the qualified name` };
  return { short: String(origin.kind), long: String(origin.kind) };
}

/** A trigger event's name for display (0.49 `subject`): its `subject` (a string), else its `number`, as
 * `#42` only for a `github.pull_request` source (`source`: the list row's `on.source`; status rows carry no
 * `on`); else its `key`; else null. Never "#null": a null number is absent. Display-only (displayLine). */
export function eventLabel(entry, source) {
  if (!record(entry)) return null;
  const name = displayLine(entry.subject) ?? (Number.isSafeInteger(entry.number) && entry.number > 0 ? String(entry.number) : null);
  if (name) return source === PULL_REQUEST && name !== DETAIL_WITHHELD ? `#${name}` : name;
  return displayLine(entry.key);
}
/** An event kind in words ("ready for review"), filtered for display. */
const eventWords = v => displayLine(v)?.replace(/_/g, ' ') ?? null;

/** What a trigger source itself said (`source: { code, message? }` of a failed poll): its untrusted words,
 * for the quote treatment. → { code, message } (either may be null) | null. */
function sourceSays(raw) {
  if (!record(raw)) return null;
  const says = { code: displayLine(raw.code), message: displayLine(raw.message) };
  return says.code || says.message ? says : null;
}
/** The events OATS refused (`invalidEvents: [{ text, rule }]`) and the items the source skipped (`skipped:
 * [{ subject, why }]`): `text` and `why` are the source's (quoted), `rule` the kernel's code, `subject` a
 * kernel-validated identifier. Absent means empty; a malformed entry is skipped. */
const refusedEvents = v => list(v).filter(record).map(e => ({ text: displayLine(e.text), rule: displayLine(e.rule) })).filter(e => e.text || e.rule);
const skippedItems = v => list(v).filter(record).map(e => ({ subject: displayLine(e.subject), why: displayLine(e.why) })).filter(e => e.subject || e.why);
/** A failed meaning check (`invalid: { code, message, field?, at }`): the kernel's text. `at` is null unless
 * it is a time: only an `invalid` with one is a check that failed at a poll (else the stored definition no
 * longer validates, as before). */
export function sourceCheck(raw) {
  if (!record(raw)) return null;
  const at = text(raw.at);
  return { code: displayLine(raw.code), message: displayLine(raw.message), field: displayLine(raw.field), at: at && Number.isFinite(Date.parse(at)) ? at : null };
}

/** `test.source` of a capability source's trigger → what its Test card says first:
 * { capability, name, ok: true, events (a count), filtered, refused: [{ text, rule }], skipped: [{ subject, why }] }
 * | { …, ok: false, invalid: { code, message, field, at } } (its meaning fails)
 * | { …, ok: false, cause, error, code, says } (the poll failed; `says`: the source's own refusal).
 * Here the kernel sends arrays (unlike `lastPoll`'s counts); `filtered` is a count. */
function testSource(raw) {
  if (!record(raw)) return null;
  const named = { capability: displayLine(raw.capability), name: displayLine(raw.name) };
  if (raw.ok === true) return { ...named, ok: true, events: list(raw.events).length, filtered: count(raw.filtered) ? raw.filtered : 0, refused: refusedEvents(raw.invalidEvents), skipped: skippedItems(raw.skipped) };
  if (record(raw.invalid)) return { ...named, ok: false, invalid: sourceCheck(raw.invalid) };
  const e = raw.error;
  return { ...named, ok: false, cause: text(raw.cause), error: displayLine(record(e) ? e.message : e), code: record(e) ? displayLine(e.code) : null, says: sourceSays(raw.source) };
}

/** `oats trigger test --json` or `oats schedule test --json` → one shape for the Test result card:
 * { ok, problems: [string], warnings: [string], wouldFire: [{ key, label, instance, nameCut, held }] | null, nextDue, soul, account }.
 * wouldFire (0.49): `instance` is the name the spawn would be asked to derive (null when unknown), `nameCut`
 * whether its purpose was cut to fit; an entry with nothing to name it by is skipped.
 * A capability source's answer (feature trigger-sources; it carries `source`) adds `source` (testSource), each
 * would-fire entry's `url` (the source's: text, never a link), and `problems` without the source failure
 * `source` already says (the kernel lists that message there too); every string is a display line. */
export function testResult(json, kind, { source = null } = {}) {
  const t = kind === 'schedule' && record(json?.test) ? json.test : json;
  if (!record(t)) return null;
  const ran = kind === 'trigger' ? testSource(t.source) : null;
  const strings = v => list(v).map(p => typeof p === 'string' ? p : text(p?.message) || text(p?.code)).filter(Boolean);
  const soulOk = record(t.soul) ? { resolves: t.soul.resolves !== false, error: text(t.soul.error?.message) || text(t.soul.error) } : null;
  const fire = f => { const label = eventLabel(f, source), instance = record(f) ? displayLine(f.instance) : null; return label ? { key: text(f.key), label, instance, nameCut: !!instance && f.nameCut === true, held: f.held === true, ...(ran ? { url: displayLine(f.url) } : {}) } : null; };
  // The source's failure is in `problems` as well, word for word: said once, by `source`.
  const failure = ran && !ran.ok ? text(t.source.invalid?.message) || text(t.source.error?.message) : null;
  const lines = v => ran ? strings(v).filter(p => p !== failure).map(displayLine).filter(Boolean) : strings(v);
  return {
    ok: t.ok === true, problems: lines(t.problems), warnings: lines(t.warnings),
    wouldFire: Array.isArray(t.wouldFire) ? t.wouldFire.map(fire).filter(Boolean) : null,
    nextDue: text(t.nextDue), soul: soulOk,
    account: text(t.gh?.account),
    ...(ran ? { source: ran } : {}),
  };
}

/** One fired trigger event (a `status` fired row, or a list row's `lastRun`) → { key, at, outcome, event, label, instance }. */
export function firedEntry(raw, source = null) {
  if (!record(raw)) return null;
  return { key: text(raw.key), at: text(raw.at), outcome: text(raw.outcome), event: eventWords(raw.event), label: eventLabel(raw, source), instance: displayLine(raw.instance) };
}
const count = v => Number.isSafeInteger(v) && v >= 0;
/** `lastPoll` → { at, ok: true, prs, matching } | { at, ok: false, error } | null (absent or malformed).
 * A capability source's (feature trigger-sources) is { at, ok: true, events, filtered, skipped, refused } (four
 * counts: `refused` is the kernel's `invalidEvents`; one it does not send counts 0) or, failed,
 * { at, ok: false, error, cause, says } (`cause`: the kernel's code; `says`: the source's own refusal). */
function lastPoll(raw) {
  if (!record(raw) || !Number.isFinite(Date.parse(text(raw.at) || ''))) return null;
  const n = v => count(v) ? v : 0;
  if (raw.ok === true) {
    if (count(raw.prs) && count(raw.matching)) return { at: raw.at, ok: true, prs: raw.prs, matching: raw.matching };
    return count(raw.events) ? { at: raw.at, ok: true, events: raw.events, filtered: n(raw.filtered), skipped: n(raw.skipped), refused: n(raw.invalidEvents) } : null;
  }
  if (raw.ok !== false) return null;
  const e = raw.error, cause = text(raw.cause), says = sourceSays(raw.source);
  return { at: raw.at, ok: false, error: displayLine(typeof e === 'string' ? e : record(e) ? e.message : null) ?? (record(e) ? displayLine(e.code) : null), ...(cause ? { cause } : {}), ...(says ? { says } : {}) };
}
/** The time an event was observed, for sorting: unparseable sorts last. */
const observed = e => { const t = Date.parse(e.observedAt || ''); return Number.isFinite(t) ? t : -Infinity; };

/** One trigger's `oats trigger status --json` row → the detail page's history facts, every kernel string
 * filtered for display and every malformed entry skipped (an older kernel's fields are simply absent):
 * fired: [firedEntry], live: [{ instance, label, event }], pending: [{ key, label, event, observedAt }]
 * newest observed first (kernel order among ties), lastPoll (see above), lastError: { at, code, message, key } | null.
 * `source` (the list row's `on.source`) decides the `#` of a label.
 * A capability source's row (feature trigger-sources: it carries `source: { capability, name }`) adds `source`
 * (as the kernel names it), `refused` (its `invalidEvents`) and `skipped` (the last GOOD poll's lists: read as
 * empty when absent), `invalid` (sourceCheck, or null) and, on `lastError`, `says` (the source's own refusal).
 * None of these keys exists for a pull-request row. */
export function triggerStatus(json, id, { source = null } = {}) {
  const row = list(json?.triggers).find(r => record(r) && (r.id === id || r.qualifiedId === id));
  if (!row) return null;
  const live = list(row.live).filter(record).map(e => ({ instance: displayLine(e.instance), label: eventLabel(e, source), event: eventWords(e.event) })).filter(e => e.instance || e.label);
  const pending = list(row.pending).filter(record).map(e => ({ key: text(e.key), label: eventLabel(e, source), event: eventWords(e.event), observedAt: text(e.observedAt) }))
    .filter(e => e.label).sort((a, b) => observed(b) - observed(a) || 0);
  const named = record(row.source) ? { capability: displayLine(row.source.capability), name: displayLine(row.source.name) } : null;
  const says = named && record(row.lastError) ? sourceSays(row.lastError.source) : null;
  const err = record(row.lastError) ? { at: text(row.lastError.at), code: displayLine(row.lastError.code), message: displayLine(row.lastError.message), key: text(row.lastError.key), ...(says ? { says } : {}) } : null;
  return {
    fired: list(row.fired).map(e => firedEntry(e, source)).filter(Boolean), firedTotal: Number.isInteger(row.firedTotal) ? row.firedTotal : null,
    live, liveCount: Number.isInteger(row.liveCount) ? row.liveCount : null,
    max: Number.isInteger(row.concurrency?.max) ? row.concurrency.max : null,
    pending, lastPoll: lastPoll(row.lastPoll),
    lastError: err && (err.code || err.message) ? err : null,
    ...(named ? { source: named, refused: refusedEvents(row.invalidEvents), skipped: skippedItems(row.skipped), invalid: sourceCheck(row.invalid) } : {}),
  };
}

/** The fields a list row adds to a stored schedule definition (the automations contract). */
const ROW_ONLY = ['qualifiedId', 'name', 'origin', 'owner', 'runsOn', 'runsHere', 'reason', 'reasonDetail', 'enabledHere', 'soul', 'teams', 'concurrency', 'nextDue', 'invalid'];
const ROW_NULLABLE = ['description', 'task', 'harness', 'model', 'launchConfig'];
/** A local schedule row → its stored definition (for scheduleDraft); null for any other row. */
export function localScheduleDefinition(row) {
  if (row?.kind !== 'schedule' || row.origin?.kind !== 'local' || !record(row.raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(row.raw)) if (!ROW_ONLY.includes(k) && !(ROW_NULLABLE.includes(k) && v === null)) out[k] = v;
  return out;
}
