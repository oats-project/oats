// A grant seat's grants, as the resident's custody knows them. Every mint from
// oats.aweb 1.25.0 carries a label unique to its seat, oats:<instance>:<seat>,
// where <seat> is random at spawn and kept in the identity meta: names are
// reused after a retire and repeat across deployments under one resident, so
// neither the name nor the path identifies a seat. The custody's grant list
// (`aw id grant list --json`: every grant the resident ever issued in the team,
// with label, status and expiry) is the source of truth for what this seat
// still holds. A grant minted before a crash, or left by a failed revoke, is
// found there and revoked at the next start or at retire. Labels of any other
// form, including the bare oats:<instance> of earlier releases, are never
// touched.
import {randomBytes} from 'node:crypto';

export const newSeatId = () => randomBytes(8).toString('hex');
export const seatGrantLabel = (instance, seat) => `oats:${instance}:${seat}`;

/** The team's grants from `aw id grant list --team <team> --json`, run with
 *  `list(argv)` in the resident's custody root. Throws when the list cannot be
 *  read: a caller then says it could not check, never that there is nothing. */
export function teamGrants(list, team) {
  const doc = JSON.parse(String(list(['aw', 'id', 'grant', 'list', `--team=${team}`, '--json'])).trim());
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.grants)) throw new Error('aw id grant list returned no grants list');
  return doc.grants.filter(g => g && typeof g === 'object' && typeof g.grant_id === 'string');
}

/** This seat's active grants other than `keep`: what must still be revoked. */
export const strayGrants = (grants, label, keep) =>
  grants.filter(g => g.label === label && g.status === 'active' && g.grant_id !== keep).map(g => ({grant: g.grant_id, expiresAt: g.expires_at}));

const shellWord = value => /^[A-Za-z0-9_./:@=+-]+$/.test(String(value)) ? String(value) : "'" + String(value).replaceAll("'", "'\\''") + "'";

/** How long a grant that could not be revoked stays valid, and how to revoke
 *  it: a never-grant ends only when revoked. Quote opaque receipt values and
 *  end option parsing before the grant id in the operator's shell command. */
export function unrevokedGrant({grant, expiresAt, custody, team}) {
  const until = expiresAt === 'never' ? 'until revoked' : `until ${expiresAt || 'its TTL'} unless revoked`;
  return `grant ${grant} stays valid ${until}: run \`aw id grant revoke --team=${shellWord(team)} -- ${shellWord(grant)}\` in ${custody}`;
}

/** Revoke this seat's stray grants. Returns {checked, revoked, remaining,
 *  error}: checked is false when the list could not be read. */
export function sweepSeatGrants({list, revoke, custody, team, label, keep}) {
  let grants;
  try { grants = teamGrants(list, team); }
  catch (error) { return {checked: false, revoked: [], remaining: [], grants: [], error: String(error?.message || error).slice(0, 200)}; }
  const revoked = [], remaining = [];
  for (const stray of strayGrants(grants, label, keep)) {
    try { revoke(stray.grant); revoked.push(stray); }
    catch (error) { remaining.push({...stray, custody, team, error: String(error?.message || error).slice(0, 200)}); }
  }
  return {checked: true, revoked, remaining, grants};
}
