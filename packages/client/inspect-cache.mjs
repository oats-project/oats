/** A bounded, coalescing cache of `oats inspect` envelopes, keyed by the exact
    subject (deployment, server, soul+catalog or home+instance identity). Only
    successful envelopes are kept; a provider run invalidates its deployment
    because it can change what `inspect --home` reports. A read may ask to
    coalesce without holding (`store: false`): a remote workspace has no state
    key and no invalidation signal on this machine, so its inspections are
    never served from an earlier visit, only shared between concurrent ones.
    The kernel's observation stamp is decoded by observationData, bounded; an
    entry is served for at most `ttlMs` after it was stored, then re-read: it
    bounds what no key can see (teams changed on the messaging side, the
    launch choice this machine would make now). */
import { observationData } from './deployment-data.mjs';
import { HELD_TTL_MS } from './keyed-catalog.mjs';

export const INSPECT_CACHE_LIMIT = 256;
/** How long a held inspection may be served: the same bound as the catalogs (keyed-catalog HELD_TTL_MS). */
export const INSPECT_CACHE_TTL_MS = HELD_TTL_MS;

/** Every field travels, absent ones as null: two subjects that differ in any
    coordinate never share an entry (same soul name under two agents roots, the
    same home before and after a restart, a catalog that changed under a soul). */
export function inspectKey({ deployment, server = null, kind, soul, agentsRoot, catalogKey, home, instance, identity, instructions = false, skills = false, composedSkills = false }) {
  if (kind !== 'soul' && kind !== 'home') throw Object.assign(new Error('Inspect cache keys name a soul or a home'), { code: 'E_BAD_ARGS' });
  const part = value => value === undefined ? null : value;
  return JSON.stringify([part(deployment), part(server), kind, part(soul), part(agentsRoot), part(catalogKey), part(home), part(instance),
    Array.isArray(identity) ? identity.map(part) : part(identity), instructions === true, skills === true, composedSkills === true]);
}

export function createInspectCache({ limit = INSPECT_CACHE_LIMIT, ttlMs = INSPECT_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  // Map iteration order is insertion order; a hit re-inserts, so the first key is the LRU.
  const entries = new Map();
  const flights = new Map();
  // Per-deployment epochs: a flight stores its result only if nobody invalidated
  // its deployment while it was in the air (the run may have changed the subject).
  const epochs = new Map();
  const epoch = deployment => epochs.get(deployment) || 0;
  const stamp = ms => new Date(ms).toISOString();

  function store(key, entry) {
    entries.delete(key); entries.set(key, entry);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }
  function start(key, deployment, produce, { live, keep }) {
    const startedAt = epoch(deployment);
    epochs.set(deployment, startedAt); // registered, so clear() can bump a deployment that is only in flight
    const flight = (async () => {
      const envelope = await produce();
      if (!envelope?.ok) return { envelope, observedAt: stamp(now()) };
      const observedAt = observationData(envelope).observedAt ?? stamp(now()); // a malformed stamp is no stamp
      if (keep && epoch(deployment) === startedAt) store(key, { envelope, observedAt, deployment, at: now() });
      return { envelope, observedAt };
    })();
    flight.live = live; // a refresh joins only a live flight: a background one may carry heads up to maxAge old
    flights.set(key, flight);
    flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => {});
    return flight;
  }

  return {
    /** `live`: the flight this read would start observes the remotes afresh (a refresh, or any read on a
     * kernel without observe-max-age); a refresh joins only a live flight. */
    async read(key, { deployment, refresh = false, produce, store: keep = true, live = refresh }) {
      const settled = entries.get(key);
      // An entry past its TTL is a miss (dropped, re-read now), not a stale hit.
      if (settled && now() - settled.at >= ttlMs) entries.delete(key);
      else if (settled && !refresh) {
        store(key, settled);
        return { envelope: structuredClone(settled.envelope), observedAt: settled.observedAt, hit: true, refreshing: flights.has(key) };
      }
      // Identical concurrent requests share one kernel process; a refresh shares only a live one.
      const inFlight = flights.get(key);
      const flight = inFlight && (!refresh || inFlight.live) ? inFlight : start(key, deployment, produce, { live: live || refresh, keep });
      const { envelope, observedAt } = await flight;
      return { envelope: structuredClone(envelope), observedAt, hit: false, refreshing: false };
    },
    invalidate(deployment) {
      epochs.set(deployment, epoch(deployment) + 1);
      for (const [key, entry] of entries) if (entry.deployment === deployment) entries.delete(key);
    },
    clear() {
      for (const deployment of epochs.keys()) epochs.set(deployment, epoch(deployment) + 1);
      entries.clear();
    },
    size: () => entries.size,
  };
}
