// oats.okf 6.2 (#150): `oats okf setup --check`, the bring-up check. It says
// whether this deployment is provisioned for knowledge, and for everything
// missing it names the whole fix. Unattended and read-only towards GitHub: it
// creates no repository, rule, label or credential (those need an
// administrator's login, which belongs outside the agents' trust group).
// Locally it writes only what any consult read writes, the host's cache.
//
// What is a problem depends on the credential mode, so an existing deployment
// is told and not broken: with github-token-file the deployment has opted into
// the separated proposer credential and everything it needs is a problem;
// without it, the same findings are warnings that say what ambient mode means.
import { spawnSync } from 'node:child_process';
import { fs, exec, cleanEnv, displayRepo } from './io.mjs';
import { hostRoutes as helperHostRoutes } from '../skills/okf-authoring/scripts/okf-publication.mjs';
import { settings, loadBindings, declaration, tokenFile, gitTimeoutMs } from './config.mjs';
import { bases as basesReport, acceptedResolution, protection } from './consult.mjs';
import { ghChildEnv } from './stores.mjs';
import { credentialMode, hostFinding } from './credential.mjs';
import { checkPublish } from './propose.mjs';

const README = 'the README\'s "Bringing up a deployment\'s knowledge store"';
export const AMBIENT_MEANING = 'knowledge writes use this user\'s own git and gh login: inside one trust group every agent can do on the knowledge repository whatever that login can, merges included. For a real gate, provision a write-role-only proposer credential (settings.oats.okf.github-token-file in oats-local.yaml) and keep the merging identity outside the agents\' trust group';

/** What on this host answers GitHub before the token file does: the publication
 *  helper's own scan (it refuses on it before a push), over this user's home. */
export const hostRoutes = (env = cleanEnv()) => helperHostRoutes(env);

/** The seams a test replaces: which binaries exist and what gh answers. */
export const probes = {
  /** The one publish predicate (#148): throws E_GH_UNAVAILABLE with the fix. */
  publish: (alias, base) => checkPublish(alias, base),
  hostRoutes,
  has: bin => { const r = spawnSync(bin, ['--version'], { env: cleanEnv(), timeout: 20000 }); return !r.error && r.status === 0; },
  gh: args => exec('gh', args, { timeout: gitTimeoutMs(), env: ghChildEnv() }),
  protection,
  /** One base's row of `oats okf bases --fresh`: fetched, validated. */
  reach: (source, alias, base) => basesReport({ ...source, bindings: { ...source.bindings, bases: { [alias]: base } } }, { fresh: true }).result.bases[0],
  resolve: (bindings, decl) => acceptedResolution(bindings, decl),
};

/** → { ok, mode, checks: [{ id, status: ok|warning|problem, detail, fix? }] } */
export function setupCheck({ soul = process.env.OATS_SOUL, home = process.cwd() } = {}) {
  const checks = [];
  const add = (id, status, detail, fix) => { checks.push({ id, status, detail, ...(fix ? { fix } : {}) }); return status === 'ok'; };
  // A refusal that carries its own whole fix (`fix`) is fixed that way; every
  // other problem keeps the fix of the step that found it.
  const ownFix = e => typeof e?.fix === 'string' && e.fix ? e.fix : null;
  const guard = (id, fix, fn) => { try { return fn(); } catch (e) { add(id, 'problem', `${e.code ?? 'E_OKF'}: ${e.message}`, ownFix(e) ?? fix); return undefined; } };
  const done = mode => ({ ok: !checks.some(c => c.status === 'problem'), mode, checks });

  // 1. Settings, bindings, state directory.
  const s = guard('settings', 'correct settings.oats.okf in this deployment\'s oats-local.yaml as the message says', () => settings());
  if (!s) return done(null);
  const mode = credentialMode(), strict = mode === 'file', soft = strict ? 'problem' : 'warning';
  add('settings', 'ok', `settings.oats.okf is valid (credential mode: ${mode})`);
  const bindings = guard('bindings', `write the bindings file and point settings.oats.okf.bindings-file at it (${README})`, () => loadBindings());
  if (!bindings) return done(mode);
  add('bindings', 'ok', `${Object.keys(bindings.bases).length} base(s) bound: ${Object.keys(bindings.bases).join(', ')}`);
  if (s['state-dir'] === undefined) add('state-dir', 'warning', 'settings.oats.okf.state-dir is not set (the bindings file\'s stateDir is used); a portable binding requires it', 'set state-dir to an absolute directory on durable storage');
  try { fs.accessSync(bindings.stateDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK); add('state', 'ok', 'the state directory exists and is writable'); }
  catch { add('state', 'problem', 'the state directory (the bindings file\'s stateDir) is missing or not writable by this user', 'create it on durable storage, owned by the user the agents run as'); }

  // 2. Tools.
  const hasGit = probes.has('git'), hasGh = probes.has('gh');
  const git = add('git', hasGit ? 'ok' : 'problem', hasGit ? 'git is on PATH' : 'git is not on PATH', 'install git in the image or on the host');
  const gh = add('gh', hasGh ? 'ok' : 'problem', hasGh ? 'gh is on PATH' : 'gh is not on PATH: proposals cannot open a pull request', 'install the GitHub CLI (gh) in the image or on the host');
  // The token reaches Git through a credential helper, and the package does
  // not isolate Git from the host: what answers before a helper is a problem
  // where the deployment opted into the separated credential.
  if (strict && git) {
    const finding = hostFinding(probes.hostRoutes());
    if (finding) add('host-git', 'problem', finding.detail, finding.fix);
    else add('host-git', 'ok', 'no netrc entry, authorization header or URL rewrite answers for github.com in this user\'s home or the system and user Git configuration');
  }

  // 3. The soul's declaration, and each base.
  const decl = guard('declaration', 'give the soul an okf.json (oats okf init, or migrate), or deactivate oats.okf for it', () => {
    if (!soul) throw Object.assign(new Error('no soul: run it as oats okf setup --check --soul <soul> from the deployment'), { code: 'E_USAGE', fix: 'run it as oats okf setup --check --soul <soul> from the deployment' });
    return declaration(fs.realpathSync(soul));
  });
  const gitBases = Object.entries(bindings.bases).filter(([, b]) => b.kind === 'git');
  let reachable = git;
  if (git) for (const [alias, base] of Object.entries(bindings.bases)) {
    const row = guard(`base:${alias}`, `make ${base.kind === 'git' ? displayRepo(base.repository) : base.path} reachable for this deployment's credential (egress to github.com and api.github.com on port 443; the credential can read the repository), or correct the binding`,
      () => probes.reach({ home, decl: decl ?? { owns: [], reads: [] }, bindings }, alias, base));
    if (!row) { reachable = false; continue; }
    if (row.stale) { reachable = false; add(`base:${alias}`, 'problem', `the accepted branch could not be fetched (${row.reason ?? 'unknown reason'}); a cached commit is served`, 'make the repository reachable for this deployment\'s credential (egress, read access)'); }
    else if (!row.validated.ok) add(`base:${alias}`, 'problem', `the accepted commit is not a valid OKF base: ${row.validated.error.message}`, 'the knowledge maintainer repairs the base in a reviewed pull request');
    else add(`base:${alias}`, 'ok', `${base.kind === 'git' ? `${row.repository} ${row.acceptedBranch}` : 'directory base'} is reachable and valid${row.warnings?.length ? ` (with ${row.warnings.length} reader warning(s): run oats okf bases)` : ''}`);
  }
  if (decl && reachable) guard('declaration', 'correct the soul\'s okf.json, or the base\'s okf-base.json in a reviewed pull request, so they agree', () => { probes.resolve(bindings, decl); add('declaration', 'ok', 'the soul\'s declared nodes or subjects resolve in the accepted bases'); });

  // 4. The credential and what GitHub enforces, per Git base.
  if (!gitBases.length) add('credential', 'ok', 'no Git base is bound: nothing is proposed by pull request');
  if (gh) for (const [alias, base] of gitBases) {
    const repo = base.pr.repository;
    // The one publish predicate, the same one propose --apply runs before its
    // push: in file mode it judges the file's token, otherwise gh's login.
    let publishes = false;
    try { probes.publish(alias, base); publishes = true; }
    catch (e) {
      const said = String(e?.message ?? '');
      // The predicate refuses on the host before it judges the token: host-git above says what and how to fix it.
      if (e?.code === 'E_HOST_CREDENTIAL') add(`credential:${alias}`, 'problem', `the credential (${mode}) was not judged for ${repo}, nor were its role, the branch's protection and the label read: the host-git problem above stops the publish check`, 'fix the host-git problem, then run oats okf setup --check again');
      else if (e?.code === 'E_GH_UNAVAILABLE') add(`credential:${alias}`, 'problem', `the credential (${mode}) cannot publish to ${repo} (${e.result?.reason ?? 'unknown'}): proposals cannot push a branch or open a pull request`, ownFix(e) ?? said);
      else add(`credential:${alias}`, 'problem', `${e?.code ?? 'E_OKF'}: ${said}`, ownFix(e) ?? 'the check itself could not run: run oats okf setup --check again, and if it repeats report this code to whoever maintains the deployment');
    }
    if (!publishes) continue;
    // Its role, which the predicate does not read. GitHub states none for a
    // GitHub App installation token (its permissions read all false or absent).
    let permissions = null;
    try { permissions = JSON.parse(probes.gh(['api', '--hostname', 'github.com', `repos/${repo}`, '--jq', '.permissions'])); } catch { /* stated below as unread */ }
    if (permissions?.admin === true || permissions?.maintain === true) add(`credential:${alias}`, soft, `the credential's identity has the ${permissions.admin ? 'admin' : 'maintain'} role on ${repo}: it can bypass or change the accepted branch's rule, so any agent here could merge its own proposal`, `use a proposer credential whose identity has the write role only on ${repo} (no maintain, no admin)`);
    else if (permissions?.push === true) add(`credential:${alias}`, 'ok', `the credential (${mode}) can publish to ${repo}, and its identity has the write role and no more`);
    else add(`credential:${alias}`, 'warning', `the credential (${mode}) can publish to ${repo}, but GitHub states no role for it (as for a GitHub App installation token): whether it can bypass or change the accepted branch's rule was not read`, `check by eye that it is granted contents, pull-requests and issues write on ${repo} and nothing that administers the repository`);
    const state = probes.protection(base);
    if (state === 'enforced') add(`protection:${alias}`, 'ok', `${repo} ${base.acceptedBranch}: a rule requires a pull request or restricts who may push (bypass lists are not read: check that only the merging identity's role is on it)`);
    else add(`protection:${alias}`, soft, state === 'none' ? `${repo} ${base.acceptedBranch} has no rule that requires a pull request or restricts pushes: this credential can push the accepted branch directly` : `the protection of ${repo} ${base.acceptedBranch} could not be read (it reads enforced only from a ruleset, or from classic protection with an administrator's login)`,
      `an administrator, from outside the agents' trust group, adds the branch ruleset in ${README} (restrict updates, require a pull request, block force pushes and deletion; bypass for the merging identity's role, for pull requests only)`);
    try {
      const labels = JSON.parse(probes.gh(['label', 'list', '--repo', repo, '--search', 'okf-proposal', '--json', 'name']));
      if (Array.isArray(labels) && labels.some(l => l?.name === 'okf-proposal')) add(`label:${alias}`, 'ok', `the okf-proposal label exists on ${repo}`);
      else add(`label:${alias}`, 'warning', `the okf-proposal label does not exist on ${repo} yet: every proposal creates or updates it after its push, which the proposer credential must be allowed to do (not read here)`, `allow the proposer credential to write labels on ${repo} (for a GitHub App: issues write); creating it once with an administrator's login (gh label create okf-proposal --repo ${repo} --color 0E8A16 --description "OKF knowledge proposal PR (oats.okf)") does not replace that`);
    } catch { add(`label:${alias}`, 'warning', `the labels of ${repo} could not be read`, 'check that the credential can read the repository\'s issues and pull requests'); }
  }
  if (!strict && gitBases.length) add('credential-mode', 'warning', AMBIENT_MEANING, README);
  return done(mode);
}
export function renderSetupCheck(r) {
  const mark = { ok: 'ok     ', warning: 'warning', problem: 'PROBLEM' };
  return [...r.checks.flatMap(c => [`${mark[c.status]} ${c.id}: ${c.detail}`, ...(c.fix && c.status !== 'ok' ? [`        fix: ${c.fix}`] : [])]),
    r.ok ? `ready: nothing is missing${r.checks.some(c => c.status === 'warning') ? ' (read the warnings)' : ''}` : `not ready: ${r.checks.filter(c => c.status === 'problem').length} problem(s); each names its fix`].join('\n');
}
