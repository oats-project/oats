// Live receive for joined teams through the host wake broker (oats.aweb 1.15).
//
// aw >= 1.36.7 accepts one registration per instance home carrying several
// broker-owned receive identities (`aw wake register --registration-json -`):
// - external-session homes (delivery: session): the broker owns every identity;
//   the primary keeps the runtime controls, joined homes add mail/chat streams;
// - native homes (delivery: channel on Claude or pi): the Claude channel
//   (native-channel) or the Pi extension (native-pi) keeps the primary
//   identity, and the broker attaches only the joined homes, disjoint from the
//   primary (aw's mixed mode).
// Under delivery: channel a runtime with no native surface (Codex, unknown) is
// an external-session home like any session home (brokerDelivers).
import {lstatSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {approvedChannelPolicyWarning} from './claude-managed-policy.mjs';
import { parseVersion, versionAtLeast } from './aw-floor.mjs';

const JOINED_EVENT_CLASSES = ['mail', 'chat'];
// Observation age is advisory; readiness does not certify recent observation.
const RECEIVE_OBSERVATION_WARN_AGE_MS = 30000;

const NATIVE_CHANNEL_RUNTIMES = ['claude', 'pi'];

/** Whether the host wake broker delivers the home's primary identity:
 *  delivery: session sends every runtime through it; delivery: channel only a
 *  runtime with no native channel (Claude has its channel plugin, pi its
 *  extension). The broker typing into a session that also has a live channel
 *  doubles every wake, so this is the one path, never both. */
export function brokerDelivers({delivery, runtime}) {
  return delivery === 'session' || !NATIVE_CHANNEL_RUNTIMES.includes(runtime);
}

/** What the kernel recorded for a home's last start: this provider's meta
 *  (capabilityMeta) and the harness it launched. Empty when unreadable. */
export function recordedStart(home) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(home, 'instance.json'), 'utf8')); } catch { return {}; }
  const meta = doc?.capabilityMeta?.['oats.aweb'];
  const harness = typeof doc?.launch?.harness === 'string' ? doc.launch.harness : typeof doc?.harness === 'string' ? doc.harness : undefined;
  return {identityHome: doc?.launch?.hooks?.env?.AWEB_IDENTITY_HOME, meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : undefined, harness};
}

/** The runtime a home's last start ran under: what this provider recorded
 *  (an empty string is a start with no runtime, so no channel), else the
 *  harness the kernel launched, for a meta that recorded none. */
export function recordedRuntime(meta, harness) {
  return typeof meta?.runtime === 'string' ? meta.runtime : harness;
}

/** The kernel's decision for a development home: it confirms Claude's
 * development-channel prompt at launch. Selection is not a prompt-outcome
 * receipt; only the kernel's recorded launchPrompts.status is. */
export const CHANNEL_DEV_CONFIRMATION = {
  code: 'channel-dev-confirmation',
  message: "Claude's development-channel prompt: OATS confirms this prompt at launch; `settings.oats.aweb.claudeChannelMode: approved` stops it.",
};

/** The kernel's launchPrompts.status when Claude ignored the development-channel
 *  flag at the last start, so the kernel sent no key: Claude Code disables
 *  channels when its launch environment opts out of telemetry, or when the
 *  account or organization has none. Readiness runs in the operator's shell,
 *  not Claude's launch environment, so the provider names the variables and
 *  never reads or changes them. Approved needs channels too: no remedy here. */
export const CHANNELS_UNAVAILABLE_STATUS = 'flag-ignored';
export const CLAUDE_CHANNELS_UNAVAILABLE = {
  code: 'claude-channels-unavailable',
  message: 'Claude ignored the development-channel flag at the last start, so this home has no channel delivery. Claude Code disables channels when its launch environment opts out of telemetry (`DISABLE_TELEMETRY`, `DO_NOT_TRACK` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) or when the account or organization has no channels. Remove the variable from the launch environment yourself, or use an account with channels.',
};

export const CLAUDE_CHANNEL_ARGUMENTS = Object.freeze({
  approved: '--channels plugin:aweb-channel@awebai-marketplace',
  development: '--dangerously-load-development-channels plugin:aweb-channel@awebai-marketplace',
});
/** Host selection is a requested mode, never an admission or connection receipt. */
export function selectClaudeChannel(mode = 'development') {
  if (mode !== 'approved' && mode !== 'development') throw new Error('settings.oats.aweb.claudeChannelMode must be approved or development; set it only in oats-local.yaml');
  return {mode, argument: CLAUDE_CHANNEL_ARGUMENTS[mode]};
}

export const CLAUDE_CHANNEL_MODE_DEFAULT = {
  code: 'claude-channel-mode-default',
  message: 'this Claude home runs in development channel mode because settings.oats.aweb.claudeChannelMode is unset in oats-local.yaml; choose approved (the managed-settings route) or set development explicitly, then respawn',
};
/** Whether claudeChannelMode was unset when a home was composed: the captured
 *  settings lack it, or the kernel's captured origin for it is the manifest
 *  default it filled in. A present key with no recorded origin is not unset. */
export function claudeChannelModeUnset(settings, origins) {
  if (!Object.hasOwn(settings ?? {}, 'claudeChannelMode')) return true;
  return origins?.['/claudeChannelMode']?.kind === 'manifest-default';
}

/** What a Claude start discloses for its mode: development always states the
 *  kernel's confirmation (a new start has no outcome yet); approved warns
 *  readiness's machine-policy verdict, and nothing
 *  when the file admits the plugin (readiness still reports that evidence).
 *  `policy` ({root, platform}) is for tests only; production passes none. */
export function launchChannelWarning(mode, policy) {
  if (mode !== 'approved') return {...CHANNEL_DEV_CONFIRMATION};
  const verdict = approvedChannelPolicyWarning(policy);
  return verdict.code === 'claude-channel-policy-admitted' ? undefined : verdict;
}

/** Recognize only the provider's literal bare selector pairs in an aggregate.
 * Quoted/escaped text is opaque: another capability's message is not a selector.
 * This detects contradictions, never assigns provider provenance or rewrites argv. */
function aggregateClaudeModes(combined) {
  if (combined === undefined) return [];
  const bare = combined.replace(/'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]/g, text => 'x'.repeat(text.length));
  if (/['"\\]/.test(bare)) throw new Error('captured Claude channel aggregate quoting is ambiguous');
  const options = bare.split(/(?:^|\s)--(?=\s|$)/, 1)[0];
  const modes = Object.entries(CLAUDE_CHANNEL_ARGUMENTS).filter(([, argument]) => {
    const [flag, plugin] = argument.split(' ');
    return new RegExp(`(?:^|\\s)${flag}\\s+${plugin.replaceAll('.', '\\.')}(?=\\s|$)`).test(options);
  }).map(([mode]) => mode);
  // The fixed bare-word contract does not interpret shell expressions.
  if (modes.length && /[$`;|&<>(){}*?~#]/.test(options)) throw new Error('captured Claude channel aggregate selector context is ambiguous');
  return modes;
}

/** Only exact provider contributions identify historical mode. The combined
 * hook argument is a fallback for old records without per-provider receipts.
 * An approved home's warning reads the machine managed-settings evidence; a
 * development home's is quiet only when the kernel recorded its last start's
 * launch prompt `completed`, says the home has no channel delivery when Claude
 * ignored the flag, and otherwise (any other status, or none) states the
 * decision; the kernel's own launch-prompt readiness item explains a block. */
function capturedClaudeChannel(meta, hooks, policy, launchPromptStatus) {
  const recorded = meta.claudeChannelMode;
  if (recorded !== undefined) selectClaudeChannel(recorded);
  const combined = hooks?.launch?.claude;
  if ((hooks?.launch !== undefined && !object(hooks.launch)) || (combined !== undefined && typeof combined !== 'string')) throw new Error('captured channel launch is malformed');
  const exactCombined = Object.values(CLAUDE_CHANNEL_ARGUMENTS).includes(combined) ? combined : undefined;
  let contribution;
  if (hooks?.contributions !== undefined) {
    if (!Array.isArray(hooks.contributions) || hooks.contributions.some(c => !object(c) || typeof c.capability !== 'string')) throw new Error('captured channel contributions are malformed');
    const own = hooks.contributions.filter(c => c?.capability === 'oats.aweb');
    if (own.length > 1 || (own[0]?.launch !== undefined && !object(own[0].launch))) throw new Error('captured aweb channel contribution is malformed or duplicated');
    contribution = own[0]?.launch?.claude;
    if (contribution !== undefined && !Object.values(CLAUDE_CHANNEL_ARGUMENTS).includes(contribution)) throw new Error('captured aweb channel contribution is malformed');
  } else {
    contribution = exactCombined;
  }
  const contributed = Object.keys(CLAUDE_CHANNEL_ARGUMENTS).find(mode => CLAUDE_CHANNEL_ARGUMENTS[mode] === contribution);
  if (recorded !== undefined && contributed !== undefined && recorded !== contributed) throw new Error('captured Claude channel mode contradicts its contribution');
  const mode = recorded ?? contributed;
  const aggregateModes = aggregateClaudeModes(combined);
  if (aggregateModes.length > 1 || (mode !== undefined && aggregateModes.some(value => value !== mode))) throw new Error('captured Claude channel mode contradicts its aggregate contribution');
  if (mode === undefined) return {code:'claude-channel-mode-unproven',message:'captured Claude channel mode is unproven; no approved admission or development selection is inferred from current settings'};
  if (mode === 'approved') return approvedChannelPolicyWarning(policy);
  if (launchPromptStatus === 'completed') return undefined;
  return launchPromptStatus === CHANNELS_UNAVAILABLE_STATUS ? {...CLAUDE_CHANNELS_UNAVAILABLE} : {...CHANNEL_DEV_CONFIRMATION};
}

/** external-session | native-channel | native-pi. */
export function runtimeDeliveryFor({delivery, runtime}) {
  if (brokerDelivers({delivery, runtime})) return 'external-session';
  return runtime === 'claude' ? 'native-channel' : 'native-pi';
}

/** Whether this home reads its joined teams at task boundaries instead of
 *  through the host wake broker: a Claude channel home does. */
export function joinedTeamsPolled({delivery, runtime}) {
  return runtimeDeliveryFor({delivery, runtime}) === 'native-channel';
}

/** The multi-identity registration document for this home, or null when it
 *  has no joined team: a native home then needs none, and an external-session
 *  home keeps the one-identity register. */
export function wakeRegistration({home, primaryIdentityHome, delivery, runtime, joined = [], backend}) {
  const rt = runtimeDeliveryFor({delivery, runtime});
  if (!joined.length) return null;
  const receive = joined.map((j) => ({identity_home: j.identityHome, label: j.label, event_classes: JOINED_EVENT_CLASSES}));
  const doc = rt === 'external-session'
    ? {home, delivery: 'session', runtime_delivery: rt, identity_home: primaryIdentityHome, receive_identities: [{identity_home: primaryIdentityHome, label: 'default', controls: true}, ...receive]}
    : {home, delivery: rt, runtime_delivery: rt, primary_identity_home: primaryIdentityHome, receive_identities: receive};
  if (backend) doc.backend = backend;
  return doc;
}

const canon = (p) => { try { return realpathSync(p); } catch { return resolve(String(p || '')); } };

/** Whether `aw wake status --json` lists this home; a status without an
 *  instances list proves nothing, so it counts as listed. */
export function statusListsHome(status, home) {
  if (!Array.isArray(status?.instances)) return true;
  const want = canon(home);
  return status.instances.some((i) => i && canon(i.home) === want);
}

/** Each joined team's actual receive mode from `aw wake status --json`:
 *  native only when the home is registered with that identity home AND the
 *  host daemon runs; otherwise poll with the reason. */
export function joinedReceiveModes(status, {home, joined = []}) {
  const running = status?.daemon_running === true || status?.daemon_version_state === 'reported';
  const want = canon(home);
  const row = (Array.isArray(status?.instances) ? status.instances : []).find((i) => i && canon(i.home) === want);
  const identities = Array.isArray(row?.receive_identities) ? row.receive_identities : [];
  return joined.map((j) => {
    const hit = identities.find((r) => r && canon(r.identity_home) === canon(j.identityHome));
    if (!hit) return {label: j.label, receive: 'poll', reason: row ? 'not-registered-with-broker' : 'home-not-registered'};
    if (!running) return {label: j.label, receive: 'poll', reason: 'wake-daemon-not-running'};
    if (hit.stream_error || hit.stream_admitted === false) return {label: j.label, receive: 'poll', reason: 'stream-not-admitted', detail: String(hit.stream_error || hit.stream_phase || 'not admitted').slice(0, 160)};
    return {label: j.label, receive: 'native', phase: hit.stream_phase || row.phase || 'unknown'};
  });
}


const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathValue = value => typeof value === 'string' && value.trim() === value && isAbsolute(value) && !value.includes('\0');
const samePath = (a, b) => pathValue(a) && pathValue(b) && canon(a) === canon(b);
const directory = value => { try { return pathValue(value) && statSync(value).isDirectory(); } catch { return false; } };
const problem = (code, message) => ({code, message});
const joinedShape = j => object(j) && typeof j.label === 'string' && j.label.trim() && j.label !== 'default' && typeof j.team === 'string' && j.team.trim() && pathValue(j.identityHome);
// A dangling leaf or parent symlink is unreadable, not legacy absence. When
// components are missing, the nearest existing ancestor must resolve to a dir.
const absentFile = (file, error) => {
  if (error.code !== 'ENOENT') return false;
  let candidate = file;
  while (true) {
    try { lstatSync(candidate); }
    catch (statError) {
      if (statError.code !== 'ENOENT' || dirname(candidate) === candidate) return false;
      candidate = dirname(candidate);
      continue;
    }
    if (candidate === file) return false;
    try { return statSync(candidate).isDirectory(); } catch { return false; }
  }
};

/** Readiness alone needs to distinguish legacy absence from corrupt records.
 * Keep recordedStart's historical lifecycle behavior unchanged for its callers. */
function receiveRecord(home) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(home, 'instance.json'), 'utf8')); }
  catch (error) { return absentFile(join(home, 'instance.json'), error) ? {meta: {}} : {error: 'captured instance record is unreadable or malformed'}; }
  if (!object(doc) || (doc.capabilityMeta !== undefined && !object(doc.capabilityMeta)) ||
      (doc.launch !== undefined && !object(doc.launch))) return {error: 'captured instance record is malformed'};
  const meta = doc.capabilityMeta?.['oats.aweb'] ?? {};
  if (!object(meta) || doc.capabilityMeta?.['oats.aweb'] === null ||
      (meta.runtime !== undefined && typeof meta.runtime !== 'string') ||
      // Kernel harness fields are nonempty identifiers. Only legacy provider
      // runtime metadata retains the empty-string external-broker meaning.
      [doc.launch?.harness, doc.harness].some(v => v !== undefined && (typeof v !== 'string' || !v.trim() || v !== v.trim())) ||
      (meta.delivery !== undefined && !['session', 'channel'].includes(meta.delivery)) ||
      (doc.launch?.hooks !== undefined && !object(doc.launch.hooks)) ||
      (doc.launch?.hooks?.env !== undefined && !object(doc.launch.hooks.env))) return {error: 'captured delivery/runtime or credential metadata is malformed'};
  if (doc.launch?.harness !== undefined && doc.harness !== undefined && doc.launch.harness !== doc.harness) return {error: 'captured kernel launch.harness and harness are inconsistent'};
  try { if (meta.claudeChannelMode !== undefined) selectClaudeChannel(meta.claudeChannelMode); }
  catch { return {error: 'captured Claude channel mode is malformed'}; }
  // The kernel's record of the last start's launch prompt; anything unreadable is no outcome.
  const launchPromptStatus = object(doc.launchPrompts) && typeof doc.launchPrompts.status === 'string' ? doc.launchPrompts.status : undefined;
  // The last start, as the kernel's desktop facts read it: the last restart's
  // startedAt, else a launched spawn's createdAt. Both precede the harness.
  const lastRestart = Array.isArray(doc.restarts) && doc.restarts.length ? doc.restarts[doc.restarts.length - 1]?.startedAt : undefined;
  const startedAt = Date.parse(lastRestart ?? (doc.launched === true ? doc.createdAt : undefined));
  // Kernel launch receipts govern readiness. Provider meta may precede a
  // failed launch; configuration names and caller env do not identify a start.
  // Lifecycle callers retain recordedRuntime's historical cleanup semantics.
  return {meta, runtime: doc.launch?.harness ?? doc.harness ?? meta.runtime, identityHome: doc.launch?.hooks?.env?.AWEB_IDENTITY_HOME, hooks: doc.launch?.hooks, launchPromptStatus, startedAt};
}

/** Preserve valid retained facts even when a legacy record lacks ownership.
 * Old producers lacked delivery/runtime and kept joins only in metadata.
 * `policy` ({root}) relocates the managed-settings read for tests only. */
export function expectedReceive(home, {delivery = 'channel', policy} = {}) {
  const captured = receiveRecord(home);
  const fail = message => ({problems: [problem('receive-record-unavailable', message)], warnings: []});
  if (captured.error) return fail(captured.error);
  if (!directory(home)) return fail('instance home is missing or unreadable; it is not a legacy record');
  const {meta, runtime, identityHome: launchIdentity} = captured;
  // Valid stale metadata may lag a join/leave, including removed directories;
  // malformed retained entries must not be reclassified as legacy absence.
  if (meta.joinedTeams !== undefined && (!Array.isArray(meta.joinedTeams) || meta.joinedTeams.some(j => !joinedShape(j)) ||
      new Set(meta.joinedTeams.map(j => j.label)).size !== meta.joinedTeams.length ||
      new Set(meta.joinedTeams.map(j => canon(j.identityHome))).size !== meta.joinedTeams.length)) return fail('captured joined-team metadata is malformed');
  const incomplete = meta.delivery === undefined || runtime === undefined;
  const warnings = incomplete ? [problem('receive-ownership-unproven', 'legacy captured delivery/runtime is absent; settings supply prerequisites only, receive ownership and complete-set assurance remain unproven')] : [];
  const runtimeDelivery = !incomplete ? runtimeDeliveryFor({delivery: meta.delivery, runtime}) : undefined;
  if (meta.identity !== undefined && (!object(meta.identity) || !['local', 'global'].includes(meta.identity.mode))) return fail('captured identity metadata is malformed');
  const grant = meta.identity?.grant;
  if (grant !== undefined && (!object(grant) || meta.identity?.mode !== 'global' || typeof grant.id !== 'string' || !grant.id.trim())) return fail('captured grant provenance is malformed');
  const primaryLocator = grant ? grant.home : join(home, '.aw');
  // Missing local material in a genuinely old/absent record is unproven. An
  // explicit grant/env locator or a complete modern plan must remain valid.
  if ((!directory(primaryLocator) && (!incomplete || grant || launchIdentity !== undefined)) ||
      (launchIdentity !== undefined && !samePath(primaryLocator, launchIdentity))) return fail('captured primary identity locator is missing, unreadable or inconsistent');
  const primary = directory(primaryLocator) ? primaryLocator : undefined;
  let state;
  try { state = JSON.parse(readFileSync(join(home, '.oats-aweb', 'teams.json'), 'utf8')); }
  catch (error) {
    if (!absentFile(join(home, '.oats-aweb', 'teams.json'), error)) return fail('retained joined-team state is unreadable or malformed');
    if (meta.identity?.mode === 'global' && (grant || meta.retained === true) &&
        (meta.joinedTeams === undefined || (Array.isArray(meta.joinedTeams) && meta.joinedTeams.length === 0))) state = {joinedTeams: []};
    else if (incomplete) {
      state = {joinedTeams: meta.joinedTeams === undefined ? [] : meta.joinedTeams};
      if (meta.joinedTeams === undefined) warnings.push(problem('receive-ownership-unproven', 'legacy retained membership sources are absent; there are no known joined entries, not a proven empty receive set'));
    } else return fail('retained joined-team state is missing; the complete receive set is unproven');
  }
  if (!object(state) || !Array.isArray(state.joinedTeams)) return fail('retained joined-team state is malformed');
  const joined = state.joinedTeams;
  if (joined.some(j => !joinedShape(j) || !directory(j.identityHome))) return fail('retained joined-team entry or identity locator is malformed or unreadable');
  if (new Set(joined.map(j => j.label)).size !== joined.length || new Set([...(primary ? [canon(primary)] : []), ...joined.map(j => canon(j.identityHome))]).size !== joined.length + (primary ? 1 : 0)) return fail('retained receive identity locators or labels overlap');
  // Local commands update disk without rewriting launch metadata. Global modes
  // forbid joins, so contradictory recorded global joins cannot be discarded.
  if (meta.identity?.mode === 'global' && (joined.length || (meta.joinedTeams !== undefined && (!Array.isArray(meta.joinedTeams) || meta.joinedTeams.length)))) return fail('global identity records contain contradictory joined-team state');
  const primaryBroker = runtime === 'codex' || (meta.delivery === undefined ? delivery === 'session' :
    meta.delivery === 'session' || (runtime !== undefined && brokerDelivers({delivery: meta.delivery, runtime})));
  const native = meta.delivery === 'channel' && runtime !== undefined && !primaryBroker;
  // Validate mode against its own provider receipt; a valid Claude mode can
  // lag the kernel's Codex receipt just like meta.runtime. It cannot select
  // native delivery or suppress required broker checks.
  if (meta.claudeChannelMode !== undefined && (meta.delivery !== 'channel' || (meta.runtime ?? runtime) !== 'claude')) return fail('captured Claude channel mode contradicts delivery/runtime');
  if (native && runtime === 'claude') {
    let channelWarning;
    try { channelWarning = capturedClaudeChannel(meta, captured.hooks, policy, captured.launchPromptStatus); }
    catch (error) { return fail(error.message); }
    if (channelWarning) warnings.push(channelWarning);
  }
  // A home whose last sync polled these teams by design owes the broker nothing for them.
  const polled = native && runtime === 'claude' ? joined.filter(j => j.expectedPoll === true) : [];
  const brokered = joined.filter(j => !polled.includes(j));
  const bindings = brokered.map(j => ({identity_home: j.identityHome, label: j.label, team: j.team, controls: false, event_classes: ['mail', 'chat']}));
  // Incomplete projections retain known joins but do not manufacture an exact
  // primary plan from settings or the broker's supplied binding list.
  if (!incomplete && primaryBroker) bindings.unshift({identity_home: primary, team: meta.identity?.team || meta.team || meta.defaultTeam?.team, label: brokered.length ? 'default' : undefined, controls: true, event_classes: []});
  return {problems: [], warnings, runtimeDelivery, runtime, primary, ...(grant ? {grantHome: primary} : {}), primaryTeam: meta.identity?.team || meta.team || meta.defaultTeam?.team, primaryBroker, capturedDelivery: meta.delivery, joined: brokered, polled, bindings, native, incomplete, brokerRequired: primaryBroker || brokered.length > 0, startedAt: captured.startedAt};
}

/** Milliseconds since the epoch of an RFC 3339 timestamp as aw writes them,
 *  or NaN for anything else, including impossible calendar dates. */
export function parseTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse normalizes impossible calendar dates such as February 30.
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return NaN;
  return Date.parse(value);
}

/** Whether `aw wake status --json` confirms a running host wake daemon. A
 *  status that could not be read confirms nothing. */
export function wakeDaemonRunning(status) {
  return object(status) && status.daemon_running === true;
}

/** How long a start waits before it reads the wake status a second time: the
 *  wake unit is restarted by every `oats aweb wake install`. */
export const WAKE_BROKER_RECHECK_MS = 3000;

/** Why a start that the host wake broker delivers to must not proceed, or
 *  undefined when a broker runs. `aw wake register` stores a registration and
 *  exits 0 with no broker running, and the home is then never woken.
 *  `readStatus` answers the parsed `aw wake status --json`, or undefined; it
 *  is read again once after `wait(WAKE_BROKER_RECHECK_MS)`. `serviceManager`
 *  says whether this host can run the broker as a unit. The text starts with
 *  the code readiness reports and fits the hook's 300 characters. */
export function wakeBrokerRefusal({readStatus, wait, serviceManager}) {
  if (wakeDaemonRunning(readStatus())) return undefined;
  wait(WAKE_BROKER_RECHECK_MS);
  if (wakeDaemonRunning(readStatus())) return undefined;
  const start = serviceManager
    ? 'start it with `oats aweb wake install`, which also restarts an installed unit'
    : 'this host has no service manager, so run `aw wake run` as a supervised process';
  return `wake-daemon-not-running: the host wake broker delivers to this home and is not running, so nothing would wake it; ${start}, then retry`;
}

/** The host wake daemon alone, from `aw wake status --json`: running, with a
 *  reported version. Home scope reads it after the status's instances list;
 *  soul scope, which has no target row, reads only this. */
export function wakeDaemonAssessment(status, {minimumVersion}) {
  const warnings = [];
  const fail = (code, message) => ({problems: [problem(code, message)], warnings});
  if (!object(status)) return fail('wake-status-unavailable', 'aw wake status is unavailable or malformed');
  if (!wakeDaemonRunning(status)) return fail('wake-daemon-not-running', 'host wake daemon is not confirmed running');
  if (status.daemon_version_state !== 'reported' || typeof status.daemon_version !== 'string' || !parseVersion(status.daemon_version)) return fail('wake-daemon-version-unknown', 'host wake daemon compatibility is unproven');
  // A daemon below the floor still receives; the floor exists for replies to
  // senders outside the roster, so it is reported as a warning, and every
  // later check (and its fail) still carries that warning.
  if (!versionAtLeast(status.daemon_version, minimumVersion)) warnings.push(problem('wake-daemon-outdated', `host wake daemon is running ${status.daemon_version}; required ${minimumVersion}: upgrade aw, then restart the host wake daemon`));
  return {problems: [], warnings};
}

// aw v1.36.37 wake/stream.go's complete StreamPhase vocabulary, and `refused`,
// which replaces `quarantined` from aw 1.36.58 (cli/go/wake/stream.go:40 at
// aw-v1.36.58); the floor still reports `quarantined`. Unknown phases must
// not be treated as reconnects. Phase determines grant-stream readiness:
// stream.go:269-279,326 gives retrying its recoverable error text.
const STREAM_PHASES = ['starting', 'streaming', 'retrying', 'quarantined', 'refused', 'stopped'];
const TRANSIENT_STREAM_PHASES = ['starting', 'retrying'];
const GRANT_BROKER_REMEDY = 'restart the seat to re-register the broker with the current grant home';

/** Errors are arbitrary server text. Extract only HTTP status, recognized
 * denial/service details and network failure phrases; never echo headers,
 * URLs, tokens or arbitrary response/request data. */
function grantStreamSummary(hit) {
  const phase = STREAM_PHASES.includes(hit.stream_phase) ? hit.stream_phase : `unknown (${typeof hit.stream_phase === 'string' ? JSON.stringify(hit.stream_phase).slice(0, 160) : hit.stream_phase === undefined ? 'absent' : typeof hit.stream_phase})`;
  const match = /^aweb: http ([1-5]\d{2})(?: \([^)]*\))?:\s*(.*)$/s.exec(hit.stream_error || '');
  let detail;
  try { detail = match && JSON.parse(match[2]).detail; } catch { /* not a structured HTTP error */ }
  const safeDetail = typeof detail === 'string' && /^(?:grant (?:revoked|expired|subject inactive|issuer revoked|freshness unavailable)|service unavailable|internal server error|bad gateway|gateway timeout|upstream temporarily unavailable|too many requests)$/.test(detail) ? `: ${detail}` : '';
  const network = /\b(?:dial tcp: )?(?:network is unreachable|connection refused|connection reset by peer|context deadline exceeded|i\/o timeout|no such host|TLS handshake timeout|unexpected EOF|EOF)\b/.exec(hit.stream_error || '')?.[0];
  const remedy = TRANSIENT_STREAM_PHASES.includes(hit.stream_phase) && hit.stream_admitted === true ? 'the broker reconnects automatically' : GRANT_BROKER_REMEDY;
  return `broker receive stream is ${phase}${match ? ` (HTTP ${match[1]}${safeDetail})` : network ? ` (${network})` : hit.stream_error ? ' (stream error reported)' : ''}${hit.stream_admitted !== true ? '; stream admission is not confirmed' : ''}; ${remedy}`;
}

/** Why a target that aw 1.36.58 or later reports as not admitted is so, when
 *  a stream of it was refused by the server: the phase, the cause aw names (an
 *  HTTP status, a terminal event's name or "silence"), the next attempt and
 *  the remedy. Only values in aw's own shape are named; the error text never
 *  is. Undefined when no stream of the row is refused. */
function refusedStreamMessage(row) {
  const refused = Array.isArray(row.receive_identities) ? row.receive_identities.filter(r => object(r) && r.stream_phase === 'refused') : [];
  if (!refused.length) return undefined;
  const [stream] = refused;
  const who = typeof stream.team_id === 'string' && /^[A-Za-z0-9._-]{1,64}:[A-Za-z0-9.-]{1,253}$/.test(stream.team_id) ? `team ${stream.team_id}` : pathValue(stream.identity_home) ? basename(stream.identity_home) : 'an identity';
  const cause = typeof stream.stream_cause === 'string' && /^(?:[1-5]\d\d|[a-z][a-z0-9_]{0,63})$/.test(stream.stream_cause) ? ` (cause ${stream.stream_cause})` : '';
  const next = Number.isFinite(parseTimestamp(stream.stream_next_attempt_at)) ? `, next at ${stream.stream_next_attempt_at}` : '';
  const more = refused.length > 1 ? ` (and ${refused.length - 1} more refused stream${refused.length > 2 ? 's' : ''})` : '';
  return `broker receive stream for ${who} is refused by the server${cause}${more}; the broker retries it on its own${next}; fix what the server refused, then restart the home to register it again, which retries at once`;
}

function receiveStreamAssessment(hit, grantHome, fallback) {
  if (grantHome && samePath(hit.identity_home, grantHome)) {
    if (hit.stream_admitted === true && hit.stream_phase === 'streaming') return null;
    const diagnostic = problem('wake-stream-unavailable', grantStreamSummary(hit));
    return hit.stream_admitted === true && TRANSIENT_STREAM_PHASES.includes(hit.stream_phase)
      ? {warning: diagnostic} : {problem: diagnostic};
  }
  if (hit.stream_admitted === true && !hit.stream_error && hit.stream_phase === 'streaming') return null;
  return {problem: problem('wake-stream-unavailable', fallback)};
}

/** Released aw status is a transport observation. Worker telemetry is absent at
 * the CLI floor; that is unknown, not permission to invent a healthy worker.
 * No generation/start witness is required or inferred from historical inputs. */
export function targetReceiveAssessment(status, {home, runtimeDelivery, runtime, capturedDelivery, primary, grantHome, primaryTeam, bindings, incomplete = false}, {minimumVersion, now = Date.now(), clientVersion} = {}) {
  const warnings = [];
  const fail = (code, message) => ({problems: [problem(code, message)], warnings});
  if (!object(status) || !Array.isArray(status.instances)) return fail('wake-status-unavailable', 'aw wake status is unavailable or malformed');
  const daemon = wakeDaemonAssessment(status, {minimumVersion});
  warnings.push(...daemon.warnings);
  if (daemon.problems.length) return {problems: daemon.problems, warnings};
  const rows = status.instances.filter(row => samePath(row?.home, home));
  const codexPrimary = runtime === 'codex' && !!primary;
  if (!rows.length && codexPrimary) return fail('wake-stream-missing', 'Codex primary has no broker target or receive stream');
  if (rows.length !== 1) return fail('wake-target-missing', 'canonical home must have exactly one broker target row');
  const row = rows[0];
  if (row.paused !== false) return fail('wake-target-paused', 'broker target is paused or its pause state is unknown');
  if (row.phase !== 'active') return fail('wake-target-inactive', 'broker target is not confirmed active');
  if (row.stream_admitted !== undefined && row.stream_admitted !== true) return fail('wake-stream-unavailable', refusedStreamMessage(row) ?? 'broker target reports streams not admitted or malformed admission evidence');
  if (row.primary_identity_home !== undefined && (!pathValue(row.primary_identity_home) || (primary && !samePath(row.primary_identity_home, primary)))) return fail('wake-target-binding', 'supplied primary locator is malformed or contradicts the retained locator');
  const actualRuntime = row.runtime_delivery;
  if (!['external-session', 'native-channel', 'native-pi'].includes(actualRuntime) ||
      row.delivery !== (actualRuntime === 'external-session' ? 'session' : actualRuntime) || !pathValue(row.identity_home)) return fail('wake-target-binding', 'broker target delivery or primary identity is malformed');
  // A retained native/mixed row can still carry joined streams without the
  // primary Codex now requires. Diagnose that absence before route mismatch;
  // malformed/duplicate identities and same-size substitutions remain binding
  // failures. Unknown legacy ownership must not acquire a primary requirement.
  const actual = row.receive_identities;
  const grantSession = pathValue(grantHome) && capturedDelivery === 'session';
  if (grantSession) {
    // Compare the registration locator and the primary receive locator with
    // the recorded grant, even when other policy fields are contradictory.
    const foreign = [row.identity_home, ...(Array.isArray(actual) ? actual.filter(r => r?.controls === true).map(r => r.identity_home) : [])]
      .find(locator => pathValue(locator) && !samePath(locator, grantHome));
    if (foreign) return fail('wake-target-binding', `broker is bound to a grant home other than the seat's current one (broker: ${basename(foreign)}; current: ${basename(grantHome)}); ${GRANT_BROKER_REMEDY}`);
  }
  if (codexPrimary && (actual === undefined || (Array.isArray(actual) && !actual.length))) return fail('wake-stream-missing', 'Codex primary has no broker receive streams');
  if (codexPrimary && Array.isArray(actual) &&
      actual.every(r => object(r) && pathValue(r.identity_home)) &&
      new Set(actual.map(r => canon(r.identity_home))).size === actual.length &&
      !actual.some(r => samePath(r.identity_home, primary)) &&
      ((!incomplete && actual.length < bindings.length) ||
       (['native-channel', 'native-pi'].includes(row.runtime_delivery) && samePath(row.primary_identity_home, primary)))) {
    return fail('wake-stream-missing', 'Codex primary is absent from the broker receive streams');
  }
  if (!incomplete) {
    if (actualRuntime !== runtimeDelivery || !samePath(row.identity_home, bindings[0]?.identity_home) ||
        (runtimeDelivery !== 'external-session' && !samePath(row.primary_identity_home, primary)) ||
        (runtimeDelivery === 'external-session' && row.primary_identity_home && !samePath(row.primary_identity_home, primary))) return fail('wake-target-binding', 'broker target delivery or primary identity does not match the captured home');
  } else {
    // Validate supplied claims against retained facts, without deriving the
    // missing ownership plan from the row or treating unknown extras as primary.
    if ((capturedDelivery === 'session' && actualRuntime !== 'external-session') ||
        (runtime !== undefined && actualRuntime !== 'external-session' && actualRuntime !== runtimeDeliveryFor({delivery:'channel', runtime})) ||
        (primary && actualRuntime === 'external-session' && !samePath(row.identity_home, primary)) ||
        (actualRuntime !== 'external-session' && (!pathValue(row.primary_identity_home) || (primary && !samePath(row.primary_identity_home, primary))))) return fail('wake-target-binding', 'broker target contradicts retained delivery, runtime or primary locator facts');
  }
  if (!Array.isArray(actual) || !actual.length || (!incomplete && actual.length !== bindings.length)) return fail('wake-target-binding', 'broker receive identity set is missing, extra or incomplete');
  if (actual.some(r => !object(r) || !pathValue(r.identity_home)) || new Set(actual.map(r => canon(r.identity_home))).size !== actual.length) return fail('wake-target-binding', 'broker receive identities are malformed or duplicated');
  if (actual.some(r => r.stream_error !== undefined && typeof r.stream_error !== 'string')) return fail('wake-status-unavailable', 'supplied receive stream error is malformed');
  if (incomplete) {
    if (!actual.some(r => samePath(r.identity_home, row.identity_home)) || actual.filter(r => r.controls === true).length > 1 ||
        (row.primary_identity_home !== undefined && !pathValue(row.primary_identity_home))) return fail('wake-target-binding', 'partial broker binding facts contradict each other');
    for (const hit of actual) {
      const classes = hit.event_classes === undefined ? [] : hit.event_classes;
      if (hit.delivery_owner !== 'session-hints' || (hit.controls !== undefined && typeof hit.controls !== 'boolean') ||
          (hit.label !== undefined && typeof hit.label !== 'string') || (hit.team_id !== undefined && typeof hit.team_id !== 'string') ||
          !Array.isArray(classes) || classes.some(c => !['mail','chat'].includes(c)) || new Set(classes).size !== classes.length ||
          (actualRuntime !== 'external-session' && (hit.controls === true || samePath(hit.identity_home, row.primary_identity_home))) ||
          (hit.controls === true && primary && !samePath(hit.identity_home, primary))) return fail('wake-target-binding', 'partial broker receive policy contradicts retained or supplied facts');
      if (primary && samePath(hit.identity_home, primary)) {
        if (hit.team_id !== undefined && primaryTeam !== undefined && hit.team_id !== primaryTeam) return fail('wake-target-binding', 'broker primary team contradicts the retained identity');
        if (capturedDelivery === 'session' && (hit.controls !== true || classes.length)) return fail('wake-target-binding', 'broker primary policy contradicts the retained session route');
      }
      const stream = receiveStreamAssessment(hit, grantSession ? grantHome : undefined, 'supplied receive stream is missing, refused or not connected');
      if (stream?.problem) return {problems: [stream.problem], warnings};
      if (stream?.warning) warnings.push(stream.warning);
    }
  }
  for (const expected of bindings) {
    const hits = actual.filter(r => samePath(r?.identity_home, expected.identity_home));
    if (hits.length !== 1) return fail('wake-target-binding', 'broker receive identity set differs from the captured home');
    const hit = hits[0];
    // controls/event_classes/label are omitempty in the released Go wire.
    const classes = hit.event_classes === undefined ? [] : hit.event_classes;
    if ((hit.label !== undefined && typeof hit.label !== 'string') || (hit.label || undefined) !== expected.label || (hit.team_id !== undefined && hit.team_id !== expected.team) || hit.delivery_owner !== 'session-hints' ||
        (hit.controls !== undefined && typeof hit.controls !== 'boolean') || (hit.controls === true) !== expected.controls ||
        !Array.isArray(classes) || classes.length !== expected.event_classes.length || classes.some(c => typeof c !== 'string') || JSON.stringify([...classes].sort()) !== JSON.stringify([...expected.event_classes].sort())) return fail('wake-target-binding', 'broker receive ownership, label or event policy differs from the captured home');
    const stream = receiveStreamAssessment(hit, grantSession ? grantHome : undefined, 'required receive stream is missing, refused or not connected');
    if (stream?.problem) return {problems: [stream.problem], warnings};
    if (stream?.warning && !incomplete) warnings.push(stream.warning);
  }
  const core = row.channel_core;
  if (!object(core) || core.running !== true) return fail('wake-worker-unavailable', 'broker worker is stopped or current worker evidence is unavailable');
  if ([row.last_error, row.conflict_home, core.last_error, core.readiness_error].some(v => v !== undefined && typeof v !== 'string') ||
      [core.paused, core.readiness_paused].some(v => v !== undefined && typeof v !== 'boolean') ||
      (core.binding_errors !== undefined && !object(core.binding_errors))) return fail('wake-status-unavailable', 'broker target or worker status is malformed');
  if (row.last_error || row.conflict_home || core.readiness_error || core.paused || core.readiness_paused || (core.binding_errors && (!object(core.binding_errors) || Object.keys(core.binding_errors).length))) return fail('wake-worker-unavailable', 'broker target or worker reports an unresolved error, pause or binding conflict');
  // inspect_start retains earlier state/errors. A failure stays a failure,
  // regardless of observation age or whether a new inspection is in flight.
  const states = [row.last_state, core.readiness_state];
  const vocabulary = ['unknown', 'idle', 'working', 'blocked', 'shell', 'stopped', 'not-launched'];
  if (states.some(state => state !== undefined && (typeof state !== 'string' || (state !== '' && !vocabulary.includes(state)))) ||
      (core.readiness_waiting !== undefined && !['', 'inspect_start', 'inspect_done', 'inspect_error'].includes(core.readiness_waiting))) return fail('wake-status-unavailable', 'broker observation status is malformed');
  if (core.readiness_waiting === 'inspect_error' || states.some(state => ['shell', 'stopped', 'not-launched'].includes(state))) return fail('receive-inspection-unproven', 'broker reports a failed inspection or an unusable endpoint');
  if (states.every(Boolean) && states[0] !== states[1]) return fail('wake-status-unavailable', 'broker observation states contradict each other');
  const updated = status.updated_at === undefined ? undefined : parseTimestamp(status.updated_at);
  const inspected = row.last_inspect_at === undefined ? undefined : parseTimestamp(row.last_inspect_at);
  // A malformed observation cannot establish age. Keep the wire's unavailable
  // status (kernel: unknown), and distinguish it from a parsed future snapshot.
  if (updated !== undefined && !Number.isFinite(updated)) {
    const client = typeof clientVersion === 'string' && parseVersion(clientVersion) ? clientVersion : 'unknown';
    return fail('wake-status-timestamp-unknown', `status.updated_at is not an RFC 3339 timestamp in the form aw emits (aw client ${client}; daemon ${status.daemon_version}); broker observation time is unknown`);
  }
  if (updated !== undefined && updated > now) return fail('wake-status-stale', 'status.updated_at is in the future');
  if (inspected !== undefined && (!Number.isFinite(inspected) || inspected > now || (updated !== undefined && inspected > updated))) return fail('receive-inspection-unproven', 'supplied broker inspection timestamp is invalid, future or later than the snapshot');
  // Released aw retains nonempty LastError across child status updates, while
  // ReadinessError can clear (channel_core_runner.go:508-539, v1.36.23). There
  // is no error timestamp/order token; LastSuccessAt is last input, not proof
  // that inspection followed or resolved this error. Other failures win above.
  if (core.last_error) {
    if (core.readiness_waiting !== 'inspect_done' || !core.readiness_state) return fail('wake-worker-unavailable', 'broker worker reports an error without completed nonfailure inspection evidence');
    const detail = core.last_error.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 160);
    warnings.push(problem('wake-worker-error-retained', `broker worker retained error of unproven currency alongside completed nonfailure observation (no error/inspection ordering evidence): ${detail}`));
  }
  for (const [name, at] of [['snapshot', updated], ['inspection', inspected]]) {
    if (at !== undefined && now - at > RECEIVE_OBSERVATION_WARN_AGE_MS) warnings.push(problem('receive-observation-aged', `broker ${name} observation is ${Math.floor((now - at) / 1000)} seconds old (30-second advisory threshold); readiness does not certify recent observation`));
  }
  if (updated === undefined || inspected === undefined || states.some(state => !state) || !core.readiness_waiting) warnings.push(problem('receive-observation-unproven', 'optional broker observation evidence is absent; no completed inspection or successful history is established'));
  if (core.readiness_waiting === 'inspect_start') warnings.push(problem('receive-inspection-pending', 'broker inspection is in progress; retained state is not evidence of completion or current endpoint presence'));
  return {problems: [], warnings};
}
