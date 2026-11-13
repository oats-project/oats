// Selected-deployment member invitation. Native/server issuance decides authority;
// membership and a plan never claim an owner/admin role or permission to mint.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { selectedDeployment } from './team-roots.mjs';
import { querySelectedKernel } from './session-readiness.mjs';
import { yamlScalar } from './binding-wire.mjs';
import { withheldFailureCause } from './aw-failure-cause.mjs';
import { childOutcome } from './child-outcome.mjs';
import { plainServiceUrl } from './plain-service.mjs';
import { sameAwebTeamId, teamKeyIn } from "./aweb-team-id.mjs";
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
// Match the provider's existing canonical team/hostname contract.
function validTeam(value) {
  const match = typeof value === 'string' && /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([^:]+)$/.exec(value);
  return !!match && match[2].length <= 253 && match[2].split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
const usage = 'usage: oats aweb invite [--label <label>] [--plan] [--json] (no recipient argument)';
function options(argv) {
  const out = { plan: false, json: false }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const [flag, ...parts] = argv[i].split('=');
    if (!['--label', '--plan', '--json', '--soul', '--dir'].includes(flag) || seen.has(flag)) fail('E_INVITE_ARGUMENT', usage);
    seen.add(flag);
    if (flag === '--plan' || flag === '--json') {
      if (parts.length) fail('E_INVITE_ARGUMENT', usage);
      out[flag.slice(2)] = true;
    } else {
      const value = parts.length ? parts.join('=') : argv[++i];
      if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) fail('E_INVITE_ARGUMENT', usage);
      out[flag.slice(2)] = value;
    }
  }
  return out;
}
// Deliberate allowlist: do not inherit routing, credential, controller, proxy,
// instance or principal selectors. All native identity/service facts come from cwd.
function nativeEnv(env, home) {
  return { PATH: env.PATH || '', ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home,'.config'), XDG_CACHE_HOME: join(home,'.cache'), AW_NO_UPDATE_CHECK: '1' };
}
function native(args, root, env, issuance) {
  try { return execFileSync('aw', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 45000, maxBuffer: 1024 * 1024 }); }
  catch (e) {
    // aw 1.36.23 prints a CLI-generated HTTP prefix followed by an arbitrary
    // server body, even under --json. Never classify by or expose body prose.
    const status = /^create hosted team invite: aweb: http (\d{3}):/.exec(String(e.stderr || ''))?.[1];
    if (issuance && ['401','403'].includes(status)) fail('E_INVITE_DENIED', `aw denied member invite (HTTP ${status}); native detail withheld because it may contain credentials`);
    if (issuance && status) fail('E_INVITE_NATIVE', `aw member invite failed (HTTP ${status}); native detail withheld because it may contain credentials`);
    if (!issuance) fail('E_INVITE_MEMBERSHIP', 'cannot read selected root membership; native output withheld');
    // No HTTP status: a cause from a fixed vocabulary, the root and its setting (awebai/oats-aweb#52).
    // How aw ended (its exit status, a timeout, ENOENT or a signal) is not its output.
    const cause = withheldFailureCause({ stderr: e.stderr, stdout: e.stdout });
    fail('E_INVITE_NATIVE', `aw member invite ${childOutcome(e, 45000)} (${cause}); native output withheld; inspect root ${root} (from ${issuance.source}) and its service before a deliberate retry`);
  }
}
// Read-only native calls also get disposable user state: cwd supplies the
// selected identity, HOME must never expose root-adjacent controller/config state.
/** `issuance` is false for a read, or `{ source }`, the setting that chose the issuing root. */
function isolatedNative(args, root, env, issuance = false) {
  const home = mkdtempSync(join(tmpdir(), 'oats-invite-'));
  try { return native(args, root, nativeEnv(env, home), issuance); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
const safeProblemCodes = new Set(['team-label-collision', 'team-unmapped', 'team-soul-unknown', 'E_TEAM_UNKNOWN', 'E_TEAM_UNCONFIGURED', 'E_WORKSPACE_SCHEMA']);
function validateProblems(problems) {
  for (const problem of problems) {
    if (!object(problem) || typeof problem.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(problem.code) || !['warning', 'failure'].includes(problem.severity)
      || (Object.hasOwn(problem, 'label') && (typeof problem.label !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(problem.label)))
      || ['key', 'at', 'condition'].some(field => Object.hasOwn(problem, field) && typeof problem[field] !== 'string')
      || (Object.hasOwn(problem, 'message') && typeof problem.message !== 'string')
      || (['team-label-collision', 'team-unmapped'].includes(problem.code) && typeof problem.label !== 'string')
      || (problem.code === 'team-soul-unknown' && (typeof problem.key !== 'string' || !problem.key || typeof problem.at !== 'string' || !problem.at))) {
      fail('E_INVITE_TEAM_QUERY', 'selected kernel returned malformed team problems');
    }
  }
}
function selectedProblems(problems, label) {
  for (const problem of problems) {
    // Public teamsApi2 identifies team problems by label. The unlabelled
    // team-soul-unknown warning concerns an unknown configuration key, not this
    // successfully dispatched soul/team. Never interpret arbitrary prose.
    if (problem.severity === 'failure' || problem.label === label) {
      const code = safeProblemCodes.has(problem.code) ? problem.code : 'unrecognized-problem';
      fail('E_INVITE_TEAM_QUERY', `selected kernel team problem ${code} prevents invitation; repair the selected configuration`);
    }
  }
}
/** The service the issuing root names (`aweb_url` in its workspace.yaml), as written, for the member to
 *  hand on beside the token. Only a plain service URL is handed on: http(s), a host, an optional port
 *  and no path but `/` or `/api`, the shape probe-support.mjs admits. Anything else could carry a
 *  credential (userinfo, a query, a path segment), so it answers null, as a root that names none does. */
export function rootAwebUrl(root) {
  let raw;
  try { raw = yamlScalar(readFileSync(join(root,'.aw','workspace.yaml'),'utf8'),'aweb_url'); } catch { return null; }
  return plainServiceUrl(raw) ?? null;
}
export function issueInvite(argv, env = process.env) {
  const opts = options(argv);
  let deployment;
  try { deployment = selectedDeployment(env, opts.dir); } catch { fail('E_INVITE_DEPLOYMENT', 'selected deployment is missing, unreadable or inconsistent'); }
  let settings;
  try { settings = JSON.parse(env.OATS_SETTINGS || ''); } catch { fail('E_INVITE_ROOT', 'selected provider settings are malformed'); }
  if (!object(settings) || Object.hasOwn(settings,'team') || (Object.hasOwn(settings,'roots') && !object(settings.roots))) fail('E_INVITE_ROOT', 'selected provider root settings are invalid');
  let doc;
  try { doc = querySelectedKernel(['teams','--dir',deployment,'--json'], { env, cwd: deployment }); } catch { fail('E_INVITE_TEAM_QUERY', 'selected kernel team query unavailable'); }
  try {
    if (doc?.schemaVersion !== 1 || doc.ok !== true || doc.result?.teamsApi !== 2 || realpathSync(doc.result.deployment) !== realpathSync(deployment) || !Array.isArray(doc.result.teams) || !Array.isArray(doc.result.problems)) throw new Error();
  } catch { fail('E_INVITE_TEAM_QUERY', 'selected kernel team query is invalid or inconsistent'); }
  validateProblems(doc.result.problems);
  const label = opts.label || env.OATS_DEFAULT_TEAM;
  if (!label) fail('E_INVITE_TEAM', 'no selected default team; choose a declared --label');
  const rows = doc.result.teams.filter(r => object(r) && r.label === label);
  if (rows.length !== 1) fail('E_INVITE_TEAM', 'selected label is unknown or ambiguous');
  selectedProblems(doc.result.problems, label);
  const team = rows[0].team;
  if (!validTeam(team)) fail('E_INVITE_TEAM', 'selected label has no valid canonical aweb team');
  if (!opts.label && env.OATS_DEFAULT_TEAM_ID !== team) fail('E_INVITE_TEAM', 'selected default team does not match current kernel declarations');
  // With no root declared, the team's root is the deployment's own, as setup creates it and spawn
  // reads it. A declared root, even an invalid one, is never replaced.
  const rootsKey = teamKeyIn(settings.roots, team);
  const declared = rootsKey !== undefined || Object.hasOwn(settings,'root');
  const source = rootsKey !== undefined ? 'roots[team]' : declared ? 'root' : 'the deployment directory';
  const raw = rootsKey !== undefined ? settings.roots[rootsKey] : declared ? settings.root : deployment;
  let root;
  try { if (typeof raw !== 'string' || !isAbsolute(raw)) throw new Error(); root = realpathSync(raw); if (!statSync(join(root,'.aw')).isDirectory()) throw new Error(); } catch { fail('E_INVITE_ROOT', declared ? 'selected team root is missing, invalid or unreadable; repair its explicit root setting' : 'no team root is set and the deployment has no .aw root; run setup, or set settings.oats.aweb.root'); }
  let membership;
  try { membership = JSON.parse(isolatedNative(['team','list','--json'], root, env)); } catch (e) { if (e.code?.startsWith('E_INVITE_')) throw e; fail('E_INVITE_MEMBERSHIP', 'selected root returned malformed membership'); }
  if (!Array.isArray(membership?.memberships)) fail('E_INVITE_MEMBERSHIP', 'selected root returned malformed membership');
  if (membership.memberships.filter(m => object(m) && sameAwebTeamId(m.team_id, team)).length !== 1) fail('E_INVITE_MEMBERSHIP', 'selected root cannot prove membership in the requested team');
  const result = { label, team, root, awebUrl: rootAwebUrl(root), authority: 'native/server decides at issuance' };
  if (opts.plan) return { ...result, plan: true, command: ['aw','team','invite','--team-id',team,'--member-local','--json'] };
  // Fresh native user state prevents an invoking-home BYOT controller key or
  // cached principal from silently replacing selected-root hosted authority.
  const rawResult = isolatedNative(['team','invite','--team-id',team,'--member-local','--json'], root, env, { source });
  let minted;
  try { minted = JSON.parse(rawResult); } catch { fail('E_INVITE_OUTPUT', 'aw returned malformed invite output; issuance may have occurred; do not automatically retry'); }
  if (!object(minted) || minted.status !== 'created' || typeof minted.invite_id !== 'string' || !minted.invite_id.trim() || typeof minted.token !== 'string' || !/^aw_inv_[^\s\x00-\x1f\x7f]+$/.test(minted.token)) fail('E_INVITE_OUTPUT', 'aw returned an unsupported or malformed hosted invite; issuance may have occurred; do not automatically retry');
  // The joiner's one-line command (#56): it reads the token on stdin, so the token is never in it.
  return { ...result, issuedAt: new Date().toISOString(), token: minted.token, joinCommand: `oats aweb setup --soul ${/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(opts.soul || '') ? opts.soul : '<soul>'} --invite-stdin --name <alias>` };
}
export function inviteMain(argv, env = process.env) {
  const json = argv.includes('--json') || !!env.OATS_OPERATION;
  try {
    const result = issueInvite(argv,env);
    if (json) process.stdout.write(JSON.stringify({schemaVersion:1,ok:true,result})+'\n');
    else if (result.plan) process.stdout.write(`Plan: ask ${result.root} to issue a LOCAL member invite for ${result.team}; native/server decides authority. No invite minted.\n`);
    else { process.stdout.write(result.token+'\n'); process.stderr.write(`Joiner: pipe this token to \`${result.joinCommand}\` in their deployment (it reads the token on stdin; <alias> is the joining root's name).\n`); }
    return 0;
  } catch (e) {
    const error = {code:e.code?.startsWith('E_INVITE_')?e.code:'E_INVITE_FAILED',message:e.code?.startsWith('E_INVITE_')?e.message:'invite failed; details withheld'};
    if(json)process.stdout.write(JSON.stringify({schemaVersion:1,ok:false,error})+'\n');else process.stderr.write(`${error.code}: ${error.message}\n`);
    return 1;
  }
}
