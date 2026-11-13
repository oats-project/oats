// Deployment selection, aweb team names, and current minting authority for
// explicit wider-team joins.
// Lifecycle hooks deliberately continue to use their captured provider settings.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { querySelectedKernel } from './session-readiness.mjs';
import { teamKeyIn } from './aweb-team-id.mjs';

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonical = path => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('an absolute directory is required');
  return realpathSync(path);
};
/** A team label or name as an aweb team name: lowercase, '_' and '.' as '-',
 *  no leading or trailing '-'. It names a per-team root's directory and the
 *  label `oats aweb resident create` derives from its team's name. */
export function normalizeAwebTeamName(label) {
  const normalized = String(label || "").toLowerCase().replace(/[_.]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalized) || normalized.length > 128) throw new Error(`team label ${JSON.stringify(label)} does not normalize to a valid aweb team name`);
  return normalized;
}

export function selectedDeployment(env = process.env, explicitDir) {
  const selected = env.OATS_TEAM_SCOPE || env.OATS_WORKSPACE;
  try {
    const deployment = canonical(selected);
    if (!statSync(deployment).isDirectory()) throw new Error();
    for (const path of [env.OATS_TEAM_SCOPE, env.OATS_WORKSPACE, explicitDir]) {
      if (path !== undefined && canonical(path) !== deployment) throw new Error();
    }
    // Exact deployment file: never search ancestors of a minting root.
    readFileSync(join(deployment, 'oats-local.yaml'), 'utf8');
    return resolve(selected);
  } catch {
    throw new Error('selected deployment is missing, unreadable or inconsistent; run oats aweb setup --dir <deployment> --soul <soul> from the deployment with its existing oats-local.yaml; no root was created');
  }
}

/** The current root for `team` and the setting that chose it: `roots[team]`, or
 *  the shared `root`, read from the deployment's LIVE settings (a root recorded
 *  after this home's spawn counts). Refuses before any invite is minted unless
 *  that root proves membership in the team, naming the cause and its fix: an
 *  unreadable live read is repaired at `oats inspect`, a missing or non-member
 *  root at setup (awebai/oats-aweb#52). */
export function currentJoinRootChoice(team, home, { env = process.env, query = querySelectedKernel, membership, label } = {}) {
  let deployment, soul;
  const refuse = (cause, remedy) => { throw new Error(`cannot join team ${team}: ${cause}; nothing was minted; ${remedy}`); };
  // The live settings could not be read: the kernel's read is what to repair.
  const unreadable = cause => refuse(`the deployment's live settings could not be read (${cause})`, `run oats inspect ${soul ? `--soul ${soul}` : `--home ${home}`} --dir ${deployment || '<deployment>'} --json in the deployment, fix what it reports, then retry`);
  // The live settings name no usable member root for this team: setup makes one.
  const noRoot = cause => refuse(cause, `check settings.oats.aweb.roots[${JSON.stringify(team)}] in the selected deployment and run oats aweb setup --join ${label || '<label>'} --invite-stdin --dir ${deployment || '<deployment>'} --soul ${soul || '<soul>'} there with an appropriate owner invite`);
  let selectedHome;
  try { deployment = selectedDeployment(env); selectedHome = canonical(home); }
  catch { unreadable('the selected deployment or instance home is unavailable or inconsistent'); }
  const inspect = args => {
    let doc;
    try { doc = query(['inspect', ...args, '--dir', deployment, '--json'], { env, cwd: deployment }); }
    catch { unreadable('oats inspect did not answer'); }
    if (!object(doc) || doc.schemaVersion !== 1 || doc.ok !== true || !object(doc.result)) unreadable('oats inspect returned no usable answer');
    try { if (canonical(doc.result.workspace?.deployment) !== canonical(deployment)) throw new Error(); }
    catch { unreadable('oats inspect selected a different deployment'); }
    return doc.result;
  };
  // Old dispatchers inherit OATS_AGENT. The public home subject supplies the
  // recorded soul name; neither ambient OATS_AGENT nor OATS_SOUL_ID is authority.
  const recorded = inspect(['--home', selectedHome]);
  try {
    if (recorded.subject?.kind !== 'instance' || canonical(recorded.subject.home) !== selectedHome || typeof recorded.subject?.soul !== 'string' || !recorded.subject.soul.trim()) throw new Error();
  } catch { unreadable('oats inspect names no recorded soul for this home'); }
  soul = recorded.subject.soul;
  const current = inspect(['--soul', soul]);
  if (current.subject?.kind !== 'soul' || current.subject.soul !== soul) unreadable('oats inspect answered for a different soul');
  if (current.teamsSource !== 'live') unreadable('oats inspect answered from recorded, not live, settings');
  if (!Array.isArray(current.problems) || current.problems.some(p => !object(p) || !p.capability || p.capability === 'oats.aweb')) unreadable('the soul has unresolved configuration problems');
  const rows = Array.isArray(current.capabilities) ? current.capabilities.filter(c => c?.id === 'oats.aweb') : [];
  if (rows.length !== 1 || rows[0].layer !== 'messaging' || current.layers?.messaging?.id !== 'oats.aweb' || rows[0].compatibility?.ok !== true || !object(rows[0].settings)) unreadable('oats.aweb settings or compatibility unavailable for this soul');
  const settings = rows[0].settings;
  if (Object.hasOwn(settings, 'roots') && !object(settings.roots)) noRoot('the live settings.oats.aweb.roots is not a map');
  const rootsKey = teamKeyIn(settings.roots, team);
  const source = rootsKey !== undefined ? 'roots[team]' : 'root';
  const root = rootsKey !== undefined ? settings.roots[rootsKey] : settings.root;
  if (root === undefined) noRoot("no root for this team in the deployment's live settings (neither roots[team] nor root is set)");
  let selectedRoot;
  try {
    selectedRoot = canonical(root);
    if (!statSync(join(selectedRoot, '.aw')).isDirectory()) throw new Error();
  } catch { noRoot(`the live ${source} root is missing, not absolute or has no readable .aw`); }
  let member = false;
  try { member = membership(selectedRoot, team) === true; } catch { /* no native output in the error */ }
  if (!member) noRoot(`current root ${selectedRoot} cannot prove membership in this exact team`);
  return { root: selectedRoot, source };
}
