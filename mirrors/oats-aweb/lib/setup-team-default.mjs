// Public-kernel team configuration for hosted username setup. No private kernel
// imports or file edits: each mutation is followed by an authoritative read.
import { execFileSync } from 'node:child_process';
import { isAbsolute, resolve, join } from 'node:path';
import { realpathSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { selectedDeployment } from './team-roots.mjs';
import { kernelQueryEnvironment } from './session-readiness.mjs';
import { sameAwebTeamId, teamKeyIn } from "./aweb-team-id.mjs";

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function setupFailure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

export function selectedTeamKernel(deployment, env = process.env) {
  const cli = env.OATS_CLI_BIN;
  if (typeof cli !== 'string' || !isAbsolute(cli) || cli.includes('\0')) {
    throw setupFailure('E_SETUP_KERNEL', 'selected OATS_CLI_BIN is unavailable');
  }
  const invoke = args => {
    let bytes, failed = false;
    try {
      bytes = execFileSync(process.execPath, [cli, ...args, '--dir', deployment, '--json'], {
        cwd: deployment, env: kernelQueryEnvironment(env), encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 1024 * 1024,
      });
    } catch (error) { bytes = error.stdout; failed = true; }
    let envelope;
    try { envelope = JSON.parse(bytes); } catch {
      throw setupFailure('E_SETUP_KERNEL', 'selected kernel failed or returned unreadable JSON; output withheld');
    }
    if (envelope?.schemaVersion !== 1 || envelope.ok !== true || failed) {
      if (envelope?.schemaVersion === 1 && envelope.ok === false && envelope.error?.code === 'E_WORKSPACE_SCHEMA' && envelope.error?.details?.reason === 'local-teams-closed') {
        throw setupFailure('E_SETUP_POLICY', 'local-teams-closed: selected workspace forbids local team writes');
      }
      const safeCode = ['E_TEAM_EXISTS', 'E_TEAM_UNKNOWN', 'E_WORKSPACE_SCHEMA', 'E_LOCAL_CHANGED', 'E_BAD_ARGS', 'E_TEAM_DEFAULT_MISMATCH'].includes(envelope?.error?.code) ? ` (${envelope.error.code})` : '';
      throw setupFailure('E_SETUP_KERNEL', `selected kernel command failed${safeCode}; output withheld`);
    }
    if (!object(envelope.result)) throw setupFailure('E_SETUP_KERNEL', 'selected kernel returned an invalid result');
    return envelope.result;
  };
  const read = () => {
    const doc = invoke(['teams']);
    let sameDeployment = false;
    try { sameDeployment = realpathSync(doc.deployment) === realpathSync(deployment); } catch { /* invalid locator */ }
    if (doc.teamsApi !== 2 || !sameDeployment || ![true, false, null].includes(doc.localTeams) || !Array.isArray(doc.teams) || !Array.isArray(doc.problems) || !(doc.defaultTeam === null || object(doc.defaultTeam))) {
      throw setupFailure('E_SETUP_QUERY', 'selected kernel teams schema or deployment is invalid');
    }
    for (const problem of doc.problems) {
      if (!object(problem) || typeof problem.code !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(problem.code) || !['warning', 'failure'].includes(problem.severity)
        || (Object.hasOwn(problem, 'label') && (typeof problem.label !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(problem.label)))) {
        throw setupFailure('E_SETUP_QUERY', 'selected kernel returned malformed team problems');
      }
    }
    const labels = new Set();
    for (const row of doc.teams) {
      if (!object(row) || typeof row.label !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(row.label) || labels.has(row.label) || !(row.team === null || (typeof row.team === 'string' && row.team.length > 0))) {
        throw setupFailure('E_SETUP_QUERY', 'selected kernel returned malformed or ambiguous team declarations');
      }
      labels.add(row.label);
    }
    if (doc.defaultTeam !== null && !doc.teams.some(row => row.label === doc.defaultTeam.label && row.team === doc.defaultTeam.team)) {
      throw setupFailure('E_SETUP_QUERY', 'selected kernel default does not match its team declarations');
    }
    return doc;
  };
  return {
    read,
    add: (label, team) => invoke(['teams', 'add', label, `--team=${team}`]),
    setDefault: label => invoke(['teams', 'default', label]),
    // Feature teams-conditional-default (OATS 0.48.0): a kernel without it ignores these flags.
    addMapping: (label, team) => invoke(['teams', 'add', label, `--team=${team}`, '--no-default']),
    setDefaultIfAbsent: label => invoke(['teams', 'default', label, '--if-absent']),
    // `oats soul teams <soul> --json` (team-model-3, read only): the soul's default and eligible teams.
    soulTeams: soul => {
      const doc = invoke(['soul', 'teams', soul]);
      if (doc.soulTeamsApi !== 2 || !Array.isArray(doc.teams) || !(doc.defaultTeam === null || object(doc.defaultTeam))) {
        throw setupFailure('E_SETUP_QUERY', 'selected kernel soul teams schema is invalid');
      }
      return doc;
    },
  };
}

export function teamConfigurationPlan(doc, label, team, deployment, { preserveDefault = false } = {}) {
  const commands = [
    ['oats', 'teams', 'add', label, '--team', team, '--dir', deployment],
    ['oats', 'teams', 'default', label, '--dir', deployment],
  ];
  // A workspace that forbids local team writes refuses only a plan that needs one (below):
  // a team the workspace itself commits, already mapped and already the default, needs none.
  const closed = doc.localTeams === false || doc.problems.some(p => p?.condition === 'local-teams-closed');
  const existing = doc.teams.find(row => row.label === label);
  if (existing && !sameAwebTeamId(existing.team, team)) {
    throw setupFailure('E_SETUP_TEAM_CONFLICT', 'selected label is already declared for a different or unmapped team; choose another label or have its owner reconcile the declaration; no overwrite', { commands });
  }
  // An unconfigured/unmapped default is what this act repairs. Unrelated
  // warnings are advisory; other failures are not reclassified as closed policy.
  if (doc.problems.some(p => p?.condition !== 'local-teams-closed' && (p.label === label || (p.severity === 'failure' && !['E_TEAM_UNCONFIGURED', 'team-unmapped'].includes(p.code))))) {
    throw setupFailure('E_SETUP_CONFIGURATION', 'selected kernel reports unresolved team configuration problems; no configuration write attempted at this step', { commands });
  }
  const mapped = !!existing;
  const isDefault = doc.defaultTeam?.label === label && sameAwebTeamId(doc.defaultTeam?.team, team);
  // A join that preserves an existing default never sets it (applyTeamConfiguration).
  const keepsDefault = preserveDefault && !!doc.defaultTeam;
  const needed = [...(mapped ? [] : [commands[0]]), ...(isDefault || keepsDefault ? [] : [commands[1]])];
  if (closed && needed.length) {
    throw setupFailure('E_SETUP_POLICY', 'local-teams-closed: selected workspace forbids local team writes; operator must reconcile policy before using the manual commands', { commands });
  }
  if (preserveDefault && !mapped && doc.defaultTeam && doc.defaultTeam.from !== 'deployment') {
    throw setupFailure('E_SETUP_DEFAULT_PRESERVE', 'mapping was not written because the deployment already has an effective default from the workspace; the supplied teams add command deliberately sets a local default over it', {
      commands: [['oats', 'teams', 'add', label, '--team', team, '--dir', deployment]],
      note: 'do not run this add as a harmless mapping-only step: it can override the effective workspace default',
    });
  }
  return { label, team, mapping: mapped ? 'reuse' : 'add', default: isDefault ? 'reuse' : 'set',
    commands: needed,
    note: 'teams add may also set the local default; readback determines whether the default command is still required' };
}

/** Apply a verified membership's configuration through the selected public CLI.
 * The caller's observe callback owns partial-state reporting, including failed
 * reads. No mutation is considered successful without its readback.
 */
export function applyTeamConfiguration({ kernel, label, team, deployment, observe, steps, preserveDefault = false }) {
  let current = observe();
  const currentPlan = teamConfigurationPlan(current, label, team, deployment, { preserveDefault });
  if (currentPlan.mapping === 'add') {
    let failure;
    try { kernel.add(label, team); steps.push({ step: 'mapping', status: 'command-completed' }); }
    catch (error) { failure = error; steps.push({ step: 'mapping', status: 'unconfirmed' }); }
    try { current = observe(); } catch (error) { throw setupFailure('E_SETUP_READBACK', 'mapping readback failed; root retained, applied configuration is unverified', { cause: failure?.code || error.code }); }
    if (failure) throw failure;
    if (!sameAwebTeamId(current.teams.find(row => row.label === label)?.team, team)) throw setupFailure('E_SETUP_READBACK', 'mapping command did not produce the requested canonical mapping; root retained');
  } else steps.push({ step: 'mapping', status: 'reused' });
  // Query immediately before deciding whether another write is appropriate.
  // Public verbs do not provide a cross-command compare-and-set transaction.
  if (preserveDefault) current = observe();
  if (preserveDefault && current.defaultTeam) {
    steps.push({ step: 'default', status: 'preserved' });
    if (!sameAwebTeamId(current.teams.find(row => row.label === label)?.team, team)) throw setupFailure('E_SETUP_READBACK', 'joined mapping changed; root retained');
    return current;
  }
  if (current.defaultTeam?.label !== label || !sameAwebTeamId(current.defaultTeam?.team, team)) {
    // Revalidate after add, including policy changes and shared-label races.
    teamConfigurationPlan(current, label, team, deployment, { preserveDefault });
    let failure;
    try { kernel.setDefault(label); steps.push({ step: 'default', status: 'command-completed' }); }
    catch (error) { failure = error; steps.push({ step: 'default', status: 'unconfirmed' }); }
    try { current = observe(); } catch (error) { throw setupFailure('E_SETUP_READBACK', 'default readback failed; root retained, applied configuration is unverified', { cause: failure?.code || error.code }); }
    if (failure) throw failure;
  } else steps.push({ step: 'default', status: 'observed', via: currentPlan.mapping === 'add' ? 'mapping-readback' : 'existing' });
  if (!sameAwebTeamId(current.teams.find(row => row.label === label)?.team, team) || current.defaultTeam?.label !== label || !sameAwebTeamId(current.defaultTeam?.team, team)) {
    throw setupFailure('E_SETUP_READBACK', 'configuration readback does not match requested mapping and default; root retained');
  }
  return current;
}

export async function setupUsernameDefault(options, { normalize, validTeam, ensureAw, run, env = process.env }) {
  const { username, name, label: explicitLabel, plan = false, dir, installAw, awVersion } = options;
  const steps = [];
  let root, label, predictedTeam, deployment, kernel, observed;
  const observe = () => {
    observed = undefined;
    const doc = kernel.read();
    observed = { mappedTeam: doc.teams.find(row => row.label === label)?.team ?? null, defaultTeam: doc.defaultTeam === null ? null : { label: doc.defaultTeam.label, team: doc.defaultTeam.team } };
    return doc;
  };
  try {
    if (!username || username !== username.trim() || username.startsWith('-') || /[\x00-\x20\x7f]/.test(username)) {
      throw setupFailure('E_SETUP_ARGUMENT', 'username must be a nonempty account name without whitespace or option syntax');
    }
    try { label = explicitLabel ?? normalize(username); } catch {
      throw setupFailure('E_SETUP_ARGUMENT', 'username does not produce a valid default team label; use a valid account name and optional --label');
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(label)) throw setupFailure('E_SETUP_ARGUMENT', '--label must be a lowercase kernel team label');
    // Only the label is normalized. The requested account identity is unchanged;
    // native onboarding remains responsible for username availability/format.
    predictedTeam = `default:${username}.aweb.ai`;
    try { deployment = selectedDeployment(env, dir); } catch {
      throw setupFailure('E_SETUP_DEPLOYMENT', 'selected deployment is missing, unreadable or inconsistent');
    }
    let settings;
    try { settings = JSON.parse(env.OATS_SETTINGS || '{}'); } catch {
      throw setupFailure('E_SETUP_ROOT', 'selected provider settings are malformed');
    }
    if (!object(settings) || (Object.hasOwn(settings, 'identity') && !object(settings.identity)) || (Object.hasOwn(settings, 'roots') && !object(settings.roots))) throw setupFailure('E_SETUP_ROOT', 'selected provider root settings are invalid');
    if (settings.identity?.mode && settings.identity.mode !== 'local') throw setupFailure('E_SETUP_ARGUMENT', 'username account setup requires LOCAL identity mode');
    const rootsKey = teamKeyIn(settings.roots, predictedTeam);
    const raw = rootsKey !== undefined ? settings.roots[rootsKey] : Object.hasOwn(settings, 'root') ? settings.root : deployment;
    if (typeof raw !== 'string' || !isAbsolute(raw)) throw setupFailure('E_SETUP_ROOT', 'selected account root must be absolute; invalid explicit root cannot fall back');
    root = resolve(raw);
    if (existsSync(root) && !statSync(root).isDirectory()) throw setupFailure('E_SETUP_ROOT', 'selected account root is not a directory');
    kernel = selectedTeamKernel(deployment, env);
    const initial = observe();
    const configuration = teamConfigurationPlan(initial, label, predictedTeam, deployment);
    const aw = await ensureAw({ install: plan ? false : installAw, version: awVersion });
    const usableAw = aw.status === 'ok' || aw.status === 'done';
    const hasIdentity = existsSync(join(root, '.aw'));
    const readMembership = () => {
      try { if (!statSync(join(root, '.aw')).isDirectory()) throw new Error(); } catch {
        throw setupFailure('E_SETUP_MEMBERSHIP', 'selected root has no readable identity directory; root retained, no repeated signup');
      }
      let doc;
      try { doc = JSON.parse(run(['aw', 'team', 'list', '--json'], root, 45000, { secretSafe: true, unsetEnv: ['AWEB_API_KEY', 'AWEB_TEAM_ID', 'AWEB_WORKSPACE_ID'] })); } catch {
        throw setupFailure('E_SETUP_MEMBERSHIP', 'selected root membership is unavailable or malformed; root retained, no repeated signup');
      }
      if (!Array.isArray(doc?.memberships) || doc.memberships.length !== 1) throw setupFailure('E_SETUP_MEMBERSHIP', 'expected exactly one LOCAL root membership; root retained, no repeated signup');
      const member = doc.memberships[0];
      if (!object(member) || !sameAwebTeamId(member.team_id, predictedTeam) || !validTeam(member.team_id) || member.alias !== name || member.identity_scope !== 'local') {
        throw setupFailure('E_SETUP_MEMBERSHIP', 'root account, alias or LOCAL scope does not match requested inputs; root retained, no repeated signup');
      }
      return member.team_id;
    };
    if (plan) {
      if (hasIdentity && !usableAw) throw setupFailure('E_SETUP_AW', 'aw is required to verify a retained root; plan never installs');
      const team = hasIdentity ? readMembership() : null;
      return { plan: true, label, predictedTeam, team, root, aw, bootstrap: hasIdentity ? 'reuse' : 'required', configuration };
    }
    if (!usableAw) throw setupFailure('E_SETUP_AW', 'aw is missing, below the required floor, or installation failed; check the explicit --install-aw prerequisite');
    if (!hasIdentity) {
      mkdirSync(root, { recursive: true });
      try {
        run(['aw', 'init', '--new-account', '--username', username, '--name', name, '--do-not-touch-agents-md'], root, 120000, {
          secretSafe: true, secrets: [username], unsetEnv: ['AWEB_API_KEY', 'AWEB_TEAM_ID', 'AWEB_WORKSPACE_ID'],
        });
      } catch (error) {
        steps.push({ step: 'bootstrap', status: 'unconfirmed' });
        throw setupFailure('E_SETUP_NATIVE', `aw init failed${Number.isInteger(error.status) ? ` (exit ${error.status})` : ''}; output withheld because it handles credentials; root retained`);
      }
      steps.push({ step: 'bootstrap', status: 'command-completed' });
    }
    const team = readMembership();
    if (hasIdentity) steps.push({ step: 'bootstrap', status: 'reused' });
    // Policy/mapping can change during native onboarding. Recheck before writes.
    applyTeamConfiguration({ kernel, label, team, deployment, observe, steps });
    return { plan: false, label, team, root, steps, observed, membershipVerified: true };
  } catch (error) {
    if (!error.code?.startsWith('E_SETUP_')) error = setupFailure('E_SETUP_FAILED', 'username setup failed; details withheld');
    if (error.code === 'E_SETUP_POLICY' && !error.details.commands && label && predictedTeam && deployment) {
      error.details.commands = [['oats', 'teams', 'add', label, '--team', predictedTeam, '--dir', deployment], ['oats', 'teams', 'default', label, '--dir', deployment]];
    }
    error.details = { ...error.details, ...(root ? { root } : {}), ...(label ? { label } : {}), steps, ...(observed ? { observed } : {}) };
    throw error;
  }
}
