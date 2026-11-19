// `oats aweb setup --invite <token>` / `--invite-stdin` without `--join`
// (awebai/oats-aweb#56): the team, service and label come from the invite
// through `aw team invite inspect`, which reads the token on stdin and redeems
// nothing. The provider never parses token internals. Every refusal here comes
// before anything is redeemed.
import { setupFailure } from './setup-team-default.mjs';
import { versionAtLeast } from './aw-floor.mjs';
import { leadingJsonObject, withheldFailureCause } from './aw-failure-cause.mjs';
import { plainServiceUrl } from './plain-service.mjs';
import { sameAwebTeamId } from './aweb-team-id.mjs';

/** The first aw whose `team invite inspect` sends the whole hosted token to the
 *  invite preview and accepts the Cloud's `/api` service URL. (`id team
 *  accept-invite --token-stdin` is older: aw 1.36.33, the provider's floor, has it.) */
export const AW_INVITE_INSPECT = '1.36.53';

/** aw's inspect refusal codes (cmd/aw/team_invite_inspect*.go, aw 1.36.53):
 *  fixed words, so naming one leaks nothing; any other code is never named. */
const INSPECT_CODES = new Set(['malformed_token', 'unsupported_version', 'server_unreachable', 'unknown_or_invalid', 'expired_or_revoked', 'exhausted', 'expired', 'revoked', 'server_mismatch']);

const FALLBACK = 'or use the labelled form: oats aweb setup --join <label> --invite-stdin --name <alias> --service <url>';

/** How long the required inspect of the invite form waits, and the optional one of the
 *  released `--join L --invite` form: that one falls back to the released behaviour, so a
 *  service that does not answer delays it by no more than this. */
export const REQUIRED_INSPECT_TIMEOUT_MS = 45000;
export const OPTIONAL_INSPECT_TIMEOUT_MS = 10000;

/** Whether two service URLs name one service, as aw judges an invite's: equal up
 *  to a trailing `/api` mount (cmd/aw/team_invite_inspect.go sameInviteService). */
export function sameInviteService(a, b) {
  const strip = v => String(v).replace(/\/api$/, '');
  return strip(a) === strip(b);
}

/** Refuses an explicit --service that is not the invite's service. */
export function checkInviteService(given, invite) {
  if (!given || sameInviteService(given, invite)) return;
  throw setupFailure('E_SETUP_SERVICE_MISMATCH', `--service ${given} is not the invite's service ${invite}; nothing was redeemed; drop --service to use the invite's, or ask for an invite from ${given}`);
}

/** Refuses an aw that cannot inspect an invite without redeeming it. */
export function requireInviteInspect(version) {
  if (versionAtLeast(version, AW_INVITE_INSPECT)) return;
  throw setupFailure('E_SETUP_AW_VERSION', `aw ${version || '(unreadable)'} cannot read an invite without redeeming it: aw team invite inspect needs aw ${AW_INVITE_INSPECT} or later; upgrade aw (npm i -g @awebai/aw@${AW_INVITE_INSPECT}, or later), ${FALLBACK}; nothing was redeemed`);
}

/** The invite's envelope, read by `aw team invite inspect --json` with the
 *  token on stdin: `{ kind, team, service, scope, status }`. */
/** `resumeCommand(team, service)`: the exact tokenless resume for a join of `team`
 *  that an earlier setup accepted, named when aw's refusal carries the invite. */
export function inspectInvite(token, cwd, { run, validTeam, resumeCommand, timeout = REQUIRED_INSPECT_TIMEOUT_MS }) {
  let raw;
  try { raw = run(['aw', 'team', 'invite', 'inspect', '--json'], cwd, timeout, { input: `${token}\n`, secrets: [token], secretSafe: true }); }
  catch (e) {
    let doc;
    try { doc = leadingJsonObject(String(e.stdout ?? '').trim()); } catch { /* no envelope */ }
    const code = doc?.error?.code;
    const cause = INSPECT_CODES.has(code)
      ? `aw team invite inspect refused the invite (${code})`
      : `aw team invite inspect ${e.outcome || 'failed'} (${withheldFailureCause({ stderr: e.stderr, stdout: e.stdout })})`;
    // aw reports an expired, exhausted or revoked hosted invite with the invite itself.
    const team = doc?.invite?.canonical_team_id, service = plainServiceUrl(doc?.invite?.server_url);
    const resume = resumeCommand && validTeam(team) ? resumeCommand(team, service) : 'oats aweb setup --join <label>';
    throw setupFailure('E_SETUP_INVITE_INSPECT', `${cause}; nothing was redeemed; if an earlier setup accepted this invite, resume with ${resume}; otherwise ask for a new invite, ${FALLBACK}`);
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { doc = undefined; }
  const team = doc?.canonical_team_id, service = plainServiceUrl(doc?.server_url);
  if (!doc || !['hosted', 'controller'].includes(doc.kind) || !validTeam(team)) {
    throw setupFailure('E_SETUP_INVITE_INSPECT', `aw team invite inspect returned no usable envelope; nothing was redeemed; ${FALLBACK.replace(/^or /, '')}`);
  }
  if (doc.kind === 'controller') {
    throw setupFailure('E_SETUP_INVITE_CONTROLLER', `this is a local-controller invite for ${team}: aw reads it without the network, so its scope and status are unknown and setup does not redeem it from the envelope; nothing was redeemed; use oats aweb setup --join <label> --invite-stdin --name <alias> --service <url>`);
  }
  if (doc.status !== 'active' || !service) {
    throw setupFailure('E_SETUP_INVITE_INSPECT', `aw team invite inspect found the invite for ${team} not usable (status or service); nothing was redeemed; ask for a new invite, ${FALLBACK}`);
  }
  if (doc.identity_scope === 'global') {
    // identity_scope "unknown" proceeds: the accept is --local, and aw refuses a mismatch.
    throw setupFailure('E_SETUP_INVITE_SCOPE', `the invite for ${team} is for a GLOBAL identity; setup joins a LOCAL per-team root; nothing was redeemed; ask for a LOCAL member invite (oats aweb invite), or follow the existing-team GLOBAL resident journey`);
  }
  return { kind: doc.kind, team, service, scope: doc.identity_scope, status: doc.status };
}

/** A configured label's team must be the invite's: `--join L` names both on a
 *  mismatch; a label derived from the invite is a collision to resolve with
 *  `--join <label>`, never a suffix. */
export function checkInviteLabel({ label, mappedTeam, inviteTeam, explicit }) {
  if (!mappedTeam || sameAwebTeamId(mappedTeam, inviteTeam)) return;
  if (explicit) throw setupFailure('E_SETUP_JOIN_MISMATCH', `--join ${label} is team ${mappedTeam} here, but the invite is for ${inviteTeam}; nothing was redeemed; pass the --join label of ${inviteTeam}, or ask for an invite to ${mappedTeam}`);
  throw setupFailure('E_SETUP_LABEL_COLLISION', `label ${label}, derived from the invite's team ${inviteTeam}, is already team ${mappedTeam} here; nothing was redeemed; pass --join <label> with a label for ${inviteTeam}`);
}
