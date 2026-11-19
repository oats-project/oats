// Authority comes from the explicitly selected home's captured provider facts,
// not the soul/environment used to dispatch this namespaced command.
import {openSync, readSync, closeSync, realpathSync, lstatSync, fstatSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {canonicalArgument, parseProbeJson, PROBE_LIMITS, refuse} from './probe-runtime.mjs';
import { sameAwebTeamId, teamKeyIn } from "./aweb-team-id.mjs";
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const atom = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(v);
export function readProbeRecord(file) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) refuse('captured-record-unavailable');
    fd = openSync(file, 'r');
    if (!fstatSync(fd).isFile()) refuse('captured-record-unavailable');
    const bytes = Buffer.alloc(PROBE_LIMITS.bytes + 1);
    let size = 0, n;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
    return parseProbeJson(bytes.subarray(0, size));
  } catch { refuse('captured-record-unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function real(path) { try { return realpathSync(path); } catch { refuse('captured-path-unavailable'); } }
export function loadProbeTarget(home, deployment) {
  if (!canonicalArgument(home) || real(home) !== home) refuse('noncanonical-home');
  if (!canonicalArgument(deployment) || real(deployment) !== deployment) refuse('selected-deployment-unavailable');
  const doc = readProbeRecord(join(home, 'instance.json'));
  if (!object(doc) || !atom(doc.agent) || !atom(doc.instance) || basename(home) !== doc.instance || basename(dirname(home)) !== 'instances' || basename(dirname(dirname(home))) !== doc.agent) refuse('contradictory-home');
  if (real(join(deployment, 'agents', doc.agent, 'instances', doc.instance)) !== home || doc.workspace?.deployment !== deployment) refuse('cross-deployment-home');
  if (!object(doc.modules?.['oats.aweb']) || !object(doc.providers?.['oats.aweb'])) refuse('aweb-not-captured');
  const settings = doc.providers['oats.aweb'], meta = doc.capabilityMeta?.['oats.aweb'], id = meta?.identity;
  if (settings.identity?.mode === 'global' || id?.mode === 'global') refuse('global probe not yet implemented');
  if (!object(meta) || !object(id) || id.mode !== 'local' || (settings.identity?.mode !== undefined && settings.identity.mode !== 'local')) refuse('unsupported-identity');
  if (!atom(id.alias) || !atom(id.team) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id.alias)) refuse('invalid-captured-identity');
  if (id.grant || id.resident || id.address || meta.alias !== id.alias || meta.team !== id.team) refuse('contradictory-identity');
  const primary = doc.defaultTeam;
  if (!object(primary) || !atom(primary.label) || !sameAwebTeamId(primary.team, id.team) || !object(meta.defaultTeam) || meta.defaultTeam.label !== primary.label || !sameAwebTeamId(meta.defaultTeam.team, id.team)) refuse('contradictory-team');
  if (Object.hasOwn(settings, 'team')) refuse('contradictory-team');
  if (settings.roots !== undefined && !object(settings.roots)) refuse('ambiguous-root');
  const rootsKey = teamKeyIn(settings.roots, id.team);
  const root = rootsKey !== undefined ? settings.roots[rootsKey] : settings.root;
  if (!canonicalArgument(root) || real(root) !== root) refuse('explicit-captured-root-required');
  const identityHome = join(home, '.aw'), rootHome = join(root, '.aw');
  if (real(identityHome) !== identityHome || real(rootHome) !== rootHome || identityHome === rootHome) refuse('ambiguous-identity-home');
  if (!['claude', 'codex', 'pi'].includes(meta.runtime) || doc.harness !== meta.runtime || (doc.launch?.harness !== undefined && doc.launch.harness !== meta.runtime)) refuse('captured-runtime-unavailable');
  if (!['channel', 'session'].includes(meta.delivery) || (settings.delivery !== undefined && settings.delivery !== meta.delivery)) refuse('captured-delivery-unavailable');
  if (doc.launch?.hooks?.env?.AWEB_IDENTITY_HOME !== undefined && doc.launch.hooks.env.AWEB_IDENTITY_HOME !== identityHome) refuse('contradictory-identity-home');
  return {home, alias: id.alias, team: id.team, harness: meta.runtime,
    delivery: meta.delivery === 'session' || meta.runtime === 'codex' ? 'broker' : 'channel',
    rootHome, identityHome, primary, settings, captured: doc};
}
export function validateProbeInspect(envelope, target) {
  const d = envelope?.result;
  if (envelope?.schemaVersion !== 1 || envelope.ok !== true || d?.operationsApi !== 2 || d.subject?.kind !== 'instance' || d.subject.home !== target.home || d.instance?.home !== target.home || d.layers?.messaging?.id !== 'oats.aweb') refuse('target-inspection-unavailable');
  if (d.teamsSource !== 'live') refuse('live-team-unavailable');
  for (const team of [d.defaultTeam, d.recordedDefaultTeam]) {
    if (team?.label !== target.primary.label || !sameAwebTeamId(team?.team, target.team)) refuse('default-team-changed');
  }
  if (d.identity?.mode !== 'local' || d.identity.alias !== target.alias || d.identity.team !== target.team || d.identity.provider !== 'oats.aweb' || d.instance.harness !== target.harness) refuse('contradictory-inspection');
}
export function validateProbeIdentity(who, teams, alias, team) {
  // LOCAL member homes can omit identity.yaml and therefore whoami custody.
  // A present custody claim must still be self; absence is not a global fallback.
  if (who?.identity_scope !== 'local' || who?.stable_id || who?.grant_id || (Object.hasOwn(who, 'custody') && who.custody !== 'self') || !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(who?.did || '') || who.did.length > 128) refuse('unsupported-identity');
  if (alias !== null && who.alias !== alias) refuse('identity-changed');
  const memberships = teams?.memberships;
  if (!sameAwebTeamId(teams?.active_team, team) || !Array.isArray(memberships) || memberships.length !== 1 || !sameAwebTeamId(memberships[0]?.team_id, team) || memberships[0]?.alias !== who.alias || memberships[0]?.active !== true || memberships[0]?.identity_scope !== 'local') refuse('contradictory-membership');
  return who.did;
}
