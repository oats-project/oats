// Labelled LOCAL admission: query first, use only verified membership, then
// public kernel configuration. Setup is operator-serialized, not a transaction.
import { selectedTeamKernel, teamConfigurationPlan, applyTeamConfiguration, setupFailure } from './setup-team-default.mjs';
import { sameAwebTeamId } from "./aweb-team-id.mjs";

export function readJoinedLocalMembership(identityHome, expectedTeam, alias, { run, validTeam }) {
  let doc;
  try {
    doc = JSON.parse(run(['aw', '--identity-home', identityHome, 'id', 'team', 'list', '--json'],
      identityHome, 45000, { secretSafe: true, unsetEnv: ['AWEB_API_KEY', 'AWEB_TEAM_ID', 'AWEB_WORKSPACE_ID'] }));
  } catch {
    throw setupFailure('E_SETUP_MEMBERSHIP', 'accepted root membership is unavailable; root retained, no repeated invite redemption');
  }
  const row = doc?.memberships?.[0];
  if (!Array.isArray(doc?.memberships) || doc.memberships.length !== 1 || !row ||
      !validTeam(row.team_id) || row.identity_scope !== 'local' || typeof row.alias !== 'string' ||
      !row.alias || (alias && row.alias !== alias) || (expectedTeam && !sameAwebTeamId(row.team_id, expectedTeam))) {
    throw setupFailure('E_SETUP_MEMBERSHIP', 'accepted root must have exactly one matching LOCAL membership and alias; root retained, no repeated invite redemption');
  }
  return row.team_id;
}

/** `knownTeam` (an invite read before redemption, #56) is the team admission will
 *  verify: the plan, and any default-preserve refusal, use it before anything is
 *  redeemed. With `preferMappedLabel`, a label already mapped to that team replaces
 *  the requested (derived) one, so no second label is made for it. */
export function prepareJoinConfiguration(requestedLabel, deployment, { env = process.env, validTeam, knownTeam, preferMappedLabel = false }) {
  let label = requestedLabel, labelFrom = 'requested';
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(label)) {
    throw setupFailure('E_SETUP_ARGUMENT', '--join must name a lowercase kernel team label');
  }
  const kernel = selectedTeamKernel(deployment, env), steps = [];
  let observed;
  const observe = () => {
    observed = undefined;
    const doc = kernel.read();
    if (doc.defaultTeam && !['deployment', 'workspace'].includes(doc.defaultTeam.from)) {
      throw setupFailure('E_SETUP_QUERY', 'public deployment default provenance is missing or invalid; soul default is not a local default');
    }
    const selected = doc.teams.find(row => row.label === label);
    if (selected?.team && !validTeam(selected.team)) {
      throw setupFailure('E_SETUP_QUERY', 'selected label has an invalid canonical team');
    }
    observed = { mappedTeam: doc.teams.find(row => row.label === label)?.team ?? null,
      defaultTeam: doc.defaultTeam === null ? null : { ...doc.defaultTeam } };
    return doc;
  };
  let initial = observe();
  if (knownTeam && preferMappedLabel) {
    const mapped = initial.teams.find(row => sameAwebTeamId(row.team, knownTeam));
    labelFrom = mapped && mapped.label !== label ? 'mapping' : 'derived';
    if (mapped && mapped.label !== label) { label = mapped.label; initial = observe(); }
  }
  const existing = initial.teams.find(row => row.label === label);
  // An unknown admitted ID cannot yet prove equality to any mapping.
  // An explicitly unmapped label is still a declaration, never ours to overwrite.
  if (existing && !existing.team) throw setupFailure('E_SETUP_TEAM_CONFLICT', 'selected label is declared but unmapped; its owner must reconcile it before acceptance; no overwrite');
  const expectedTeam = existing?.team;
  const plannedTeam = expectedTeam || knownTeam;
  // The placeholder is explanatory only, never passed to a mutation or native call.
  // Admission may proceed under an inherited default; only the later mapping
  // write is refused, with the actual verified canonical ID in its remedy.
  // A join preserves an existing default. Before admission that is applied only
  // to a mapped label, or to an invite's team read before redemption (knownTeam): for
  // an unmapped label with neither, the default-preserve refusal needs the verified
  // team in its command, which only admission gives.
  try { teamConfigurationPlan(initial, label, plannedTeam || '<verified-team>', deployment, { preserveDefault: !!plannedTeam }); }
  catch (error) {
    if (!plannedTeam) error.details = { ...error.details, commandsRequireVerifiedTeam: true,
      note: 'canonical team is unknown before admission; command templates require owner-provided verified membership, not a token or label guess; reconcile policy first' };
    throw error;
  }
  return {
    deployment, expectedTeam, label, labelFrom,
    finish(team) {
      applyTeamConfiguration({ kernel, label, team, deployment, observe, steps, preserveDefault: true });
      return { label, team, steps, observed, membershipVerified: true,
        ...(observed.defaultTeam?.label !== label ? {
          remaining: [['oats', 'teams', 'default', label, '--dir', deployment]],
          note: 'existing default preserved; selecting the joined label later is an explicit operator choice',
        } : {}) };
    },
    details() { return { label, steps, ...(observed ? { observed } : {}) }; },
    soulTeams: soul => kernel.soulTeams(soul),
  };
}
