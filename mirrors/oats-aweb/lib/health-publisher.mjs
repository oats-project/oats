// One tick of the agent status publisher (aweb-acah.3). It runs from the
// deployment once a minute, outside every instance session, so hooks stay
// untouched and a deployment that does not publish runs none of it
// (docs/design/2026-10-14-agent-health-publisher.md, D7). Per home: the agent
// id is aw's own answer for the identity home (never guessed); the agent
// designates its status host once per (agent id, host); its team's minting
// root publishes a checked document. A resident is designated and published
// from its custody root, its seats combined. Every refusal is logged with the
// exact status and message aw reported.
import {join} from 'node:path';
import {healthSettings} from './health-settings.mjs';
import {teamKeyIn} from './aweb-team-id.mjs';
export {healthSettings} from './health-settings.mjs';
import {assessHealth, combineSeats, retiredHealth} from './health-vocabulary.mjs';
import {checkDocument} from './status-document.mjs';

export const VALIDITY_MS = 300 * 1000;
const DEFAULT_BUDGET_MS = 45 * 1000;
const DEFAULT_CONCURRENCY = 4;
/** A channel refreshes its receipt at most every 30 s while it reads. */
const RECEIPT_FRESH_MS = 90 * 1000;
/** A heartbeat further ahead of this host's clock than this proves nothing. */
const RECEIPT_SKEW_MS = 5 * 1000;
/** One agent is one identity in one team; `target` says where aw acts as it:
 *  {identityHome} for an instance identity, {cwd} for a root or custody. */
const agentKey = (target, team) => JSON.stringify([target, team]);

/** Where a resident's designation cache lives: beside its custody state. */
const residentCacheFile = (custody) => join(custody, '.oats-resident', 'health.json');

const isoSeconds = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** The agents one home holds: its primary identity and each joined team's. */
function identitiesOf(row, settings) {
  const meta = row.capabilityMeta?.['oats.aweb'];
  if (!meta) return {identities: []};
  if (meta.retained) return {skip: 'a seat that holds its resident identity itself, without a grant, is not published in v1'};
  const id = meta.identity ?? {};
  // A Claude or pi home on channel delivery receives through its own channel,
  // which leaves a receipt in the identity directory it runs as; everything
  // else receives through the host wake broker and leaves none.
  const native = (meta.delivery ?? 'channel') === 'channel' && ['claude', 'pi'].includes(meta.runtime);
  if (id.mode === 'global') {
    const custody = settings.residents?.[id.resident];
    if (!custody) return {skip: `resident ${id.resident} is not in settings.oats.aweb.residents`};
    return {identities: [{kind: 'resident', resident: id.resident, team: id.team, alias: id.alias, id: {cwd: custody}, host: {cwd: custody}, cacheFile: residentCacheFile(custody), identity: {kind: 'primary'}, receive: {native: native && !!id.grant?.home, dir: id.grant?.home}}]};
  }
  const team = id.team ?? meta.team, alias = id.alias ?? meta.alias;
  const rootFor = (t) => { const key = teamKeyIn(settings.roots, t); return (key !== undefined ? settings.roots[key] : undefined) ?? settings.root; };
  if (!rootFor(team)) return {skip: `no minting root for team ${team}`};
  const cacheFile = join(row.home, '.oats-aweb', 'health.json');
  const identities = [{kind: 'local', team, alias, id: {identityHome: join(row.home, '.aw')}, host: {cwd: rootFor(team)}, cacheFile, identity: {kind: 'primary'}, receive: {native, dir: join(row.home, '.aw')}}];
  const skips = [];
  for (const j of meta.joinedTeams ?? []) {
    if (!j.identityHome) { skips.push(`joined team ${j.team} has no identity home recorded`); continue; }
    if (rootFor(j.team)) identities.push({kind: 'local', team: j.team, alias: j.alias ?? alias, id: {identityHome: j.identityHome}, host: {cwd: rootFor(j.team)}, cacheFile, identity: {kind: 'joined', receive: j.receive, expectedPoll: j.expectedPoll}, receive: {native: false}});
  }
  return {identities, skips};
}

/** Whether a native channel's receipt proves this agent receives now: proven
 *  when it names this agent (its did:key, or a resident's did:aw), its process
 *  is alive and its heartbeat is recent; stale when it names this agent but
 *  either has failed; absent otherwise. */
async function receiptState(receive, agent, host, now) {
  if (!receive.native) return 'absent';
  const receipt = await host.receipt(receive.dir).catch(() => null);
  const named = agent.kind === 'resident' ? receipt?.stable_id : receipt?.did;
  if (!receipt || receipt.v !== 1 || named !== agent.agentId) return 'absent';
  const age = now - Date.parse(receipt.heartbeat_at);
  return Number.isSafeInteger(receipt.pid) && receipt.pid > 0 && host.pidAlive(receipt.pid) && age >= -RECEIPT_SKEW_MS && age <= RECEIPT_FRESH_MS ? 'proven' : 'stale';
}

/** Settles `promise`, or answers null once `ms` have passed. The timer holds
 *  the process until then, since a hung answer may hold nothing, and is
 *  cleared as soon as the race settles. */
function within(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms), null); });
  return Promise.race([promise, deadline]).catch(() => null).finally(() => clearTimeout(timer));
}

async function pool(items, size, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i]); }
  }));
  return out;
}

/** One home's kernel state and provider readiness. Readiness is read only for
 *  a running home, within what is left of the tick's budget. */
async function observeHome(row, host, deadline) {
  const liveness = row.launched === false ? {state: 'not-launched', lastEvent: null} : await host.liveness(row).catch(() => ({state: 'unobservable', lastEvent: null}));
  const readiness = liveness.state === 'alive' ? await within(host.readiness(row.home), deadline - Date.now()) : null;
  return {liveness, launchPrompts: row.launchPrompts ?? null, readiness};
}

/** Publishes one agent's status: designates when the cache says it must,
 *  honours Retry-After, sends, and records the outcome. */
async function publishAgent(agent, health, {host, now, result}) {
  const {team, alias, cacheFile} = agent;
  const cache = (await host.readCache(cacheFile)) ?? {};
  let entry = cache[team];
  if (entry && (entry.agent !== agent.agentId || entry.host !== agent.hostDid)) entry = undefined;
  entry = entry ?? {agent: agent.agentId, host: agent.hostDid, alias, designated: false};
  const save = async () => { cache[team] = entry; await host.writeCache(cacheFile, cache); };
  const refused = async (answer) => {
    const row = {alias, team, status: answer.status ?? null, code: answer.code ?? null, message: answer.message ?? ''};
    result.refused.push(row);
    // A log that cannot be written is reported, and never costs the agent
    // its designation or Retry-After bookkeeping.
    await host.log({at: isoSeconds(now), ...row, retry_after: answer.retry_after ?? null})
      .catch((error) => result.failed.push({alias, team, message: `refusal not logged: ${String(error?.message ?? error)}`}));
  };
  if (entry.retryUntil && now < entry.retryUntil) {
    result.skipped.push({alias, team, reason: `rate limited until ${isoSeconds(entry.retryUntil)}`});
    return;
  }
  if (!entry.designated) {
    const set = await host.statusHostSet(agent.id, agent.hostDid);
    if (!set.ok) { await refused(set); if (set.status === 429 && Number.isFinite(set.retry_after)) entry.retryUntil = now + set.retry_after * 1000; await save(); return; }
    entry.designated = true;
  }
  const seq = now;
  const document = {v: 1, type: 'agent_status', team_id: team, agent: agent.agentId, publisher_did: agent.hostDid, seq, ...health, observed_at: isoSeconds(now), valid_until: isoSeconds(now + VALIDITY_MS)};
  const checked = checkDocument(document, {now});
  if (!checked.ok) { await refused({status: null, code: checked.error, message: checked.message}); return; }
  const answer = await host.statusPublish(agent.host, alias, document);
  delete entry.retryUntil;
  if (answer.ok) {
    result.published.push({alias, team, reachable: health.reachable, code: health.reason?.code ?? null});
  } else {
    await refused(answer);
    if (answer.code === 'not_status_host') entry.designated = false;
    if (answer.status === 429 && Number.isFinite(answer.retry_after)) entry.retryUntil = now + answer.retry_after * 1000;
  }
  await save();
}

/** One tick: assess every home, then designate and publish every agent. */
export async function publishTick({settings, now, host, budgetMs = DEFAULT_BUDGET_MS, concurrency = DEFAULT_CONCURRENCY}) {
  const options = healthSettings(settings);
  if (!options.publish) return {disabled: true};
  const supported = await host.awSupportsStatus();
  if (!supported.ok) throw new Error(supported.message);
  const deadline = Date.now() + budgetMs;
  const result = {published: [], refused: [], skipped: [], failed: []};
  const rows = (await host.status()).agents.flatMap((a) => a.instances ?? []).filter((r) => !r.retirePending);

  const homes = [];
  for (const row of rows) {
    const {identities, skip, skips = []} = identitiesOf(row, settings);
    for (const reason of skip ? [skip] : skips) result.skipped.push({home: row.home, reason});
    if (!skip && identities.length) homes.push({row, identities});
  }
  const observed = await pool(homes, concurrency, ({row}) => observeHome(row, host, deadline));
  const time = now();
  const words = {language: options.language, operator: options.operator, now: time};

  // One agent per (identity dir, team): a resident's seats share one.
  const agents = new Map();
  homes.forEach(({identities}, i) => {
    for (const identity of identities) {
      const key = agentKey(identity.id, identity.team);
      const seat = {...observed[i], grant: homes[i].row.capabilityMeta['oats.aweb'].identity?.grant ?? null, identity: identity.identity, receive: identity.receive};
      const agent = agents.get(key) ?? {...identity, seats: []};
      agent.seats.push(seat);
      agents.set(key, agent);
    }
  });
  // A resident published before whose seats are all gone was retired.
  for (const [resident, custody] of Object.entries(settings.residents ?? {})) {
    const cache = (await host.readCache(residentCacheFile(custody))) ?? {};
    for (const team of Object.keys(cache)) {
      const key = agentKey({cwd: custody}, team);
      if (agents.has(key) || !cache[team].designated) continue;
      agents.set(key, {kind: 'resident', resident, team, alias: cache[team].alias, id: {cwd: custody}, host: {cwd: custody}, cacheFile: residentCacheFile(custody), seats: [], retired: true});
    }
  }

  const assessAndPublish = async (agent) => {
    const own = await ask(agent.id), hostId = await ask(agent.host);
    agent.agentId = agent.kind === 'resident' ? own?.stable_id : own?.did;
    agent.hostDid = hostId?.did;
    if (!agent.agentId || !agent.hostDid) { result.skipped.push({alias: agent.alias, team: agent.team, reason: agent.agentId ? 'aw gave no publisher did' : 'aw gave no agent id'}); return; }
    const assessed = agent.retired ? [retiredHealth(words)] : await Promise.all(agent.seats.map(async (seat) => assessHealth({...seat, ...words, receive: {native: seat.receive.native, receipt: await receiptState(seat.receive, agent, host, time)}})));
    const {reachable, reason, fixing} = combineSeats(assessed);
    await publishAgent(agent, {reachable, ...(reason ? {reason} : {}), ...(fixing ? {fixing} : {})}, {host, now: time, result});
  };
  const ids = new Map();
  const ask = (target) => { const k = JSON.stringify(target); if (!ids.has(k)) ids.set(k, host.identityOf(target).catch(() => null)); return ids.get(k); };
  // Agents sharing a cache file (a home's primary and joined identities)
  // publish one after another; different files in parallel.
  const byCache = new Map();
  for (const agent of agents.values()) byCache.set(agent.cacheFile, [...(byCache.get(agent.cacheFile) ?? []), agent]);
  await pool([...byCache.values()], concurrency, async (group) => {
    for (const agent of group) {
      // One agent's failure (an unwritable cache, an answer of the wrong
      // shape) is listed and never stops the others. It may come after its
      // document was sent, so it is listed apart from what was skipped.
      try { await assessAndPublish(agent); } catch (error) { result.failed.push({alias: agent.alias, team: agent.team, message: String(error?.message ?? error)}); }
    }
  });
  return result;
}

/** Clears, as each agent, every status host designation the publisher has
 *  cached, so aweb falls back to its own facts instead of a host that has
 *  stopped reporting. A designation aw cannot clear stays cached and is
 *  listed under `failed` with why; with an aw that has no `status-host clear`
 *  that is every one of them. */
export async function clearDesignations({settings, host}) {
  const result = {cleared: [], failed: []};
  const clears = await host.awClearsDesignations();
  const agents = new Map();
  for (const row of (await host.status()).agents.flatMap((a) => a.instances ?? [])) {
    for (const identity of identitiesOf(row, settings).identities ?? []) agents.set(agentKey(identity.id, identity.team), identity);
  }
  for (const custody of Object.values(settings.residents ?? {})) {
    const cache = (await host.readCache(residentCacheFile(custody))) ?? {};
    for (const team of Object.keys(cache)) agents.set(agentKey({cwd: custody}, team), {team, alias: cache[team].alias, id: {cwd: custody}, cacheFile: residentCacheFile(custody)});
  }
  for (const {team, alias, id, cacheFile} of agents.values()) {
    const cache = (await host.readCache(cacheFile)) ?? {};
    if (!cache[team]?.designated) continue;
    const answer = clears.ok ? await host.statusHostClear(id) : {ok: false, status: null, code: 'aw', message: clears.message};
    if (!answer.ok) { result.failed.push({alias, team, status: answer.status ?? null, code: answer.code ?? null, message: answer.message ?? ''}); continue; }
    delete cache[team];
    await host.writeCache(cacheFile, cache);
    result.cleared.push({alias, team});
  }
  return result;
}
