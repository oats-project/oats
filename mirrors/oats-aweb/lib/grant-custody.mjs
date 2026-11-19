import { AW_MIN } from './aw-floor.mjs';
import { sameAwebTeamId } from "./aweb-team-id.mjs";

export function parseAwJson(text, what) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error(`${what} returned no JSON result`);
  try { return JSON.parse(trimmed); } catch { /* may have progress before JSON */ }
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep looking */ }
  }
  throw new Error(`${what} returned no JSON result`);
}

/** The op a custody reports when it can continue an encrypted reply to a
 *  sender outside the team roster (it re-reads the source message). */
const REPLY_CONTINUATION_OP = 'mail_reply_continuation.v1';
/** The op a custody reports when it can serve a grant that never expires. */
const NEVER_TTL_OP = 'grant_never_ttl.v1';
/** Ops a custody started on an older aw lacks until it is restarted on the floor. */
const FLOOR_OPS = [REPLY_CONTINUATION_OP, NEVER_TTL_OP];

export function custodyPreflight({ custody, resident, team, e2eeRequired = true, ttl, runAw, fatalOnError = true, fatal }) {
  const failNow = (message) => { if (fatalOnError && typeof fatal === 'function') fatal(message); throw new Error(message); };
  let status;
  try { status = parseAwJson(runAw(['aw', 'custody', 'status', '--json'], custody, { unsetEnv: ['AWEB_IDENTITY_HOME'] }), 'aw custody status'); }
  catch (e) { failNow(`custody preflight failed for ${resident}: custody status could not be read: ${e.message || e}; start aw custody serve for ${resident}`); }
  if (!status || typeof status !== 'object' || Array.isArray(status)) failNow(`custody preflight failed for ${resident}: custody status could not be read: aw custody status returned no status object; start aw custody serve for ${resident}`);
  const state = String(status.status || 'unknown');
  const firstError = Array.isArray(status.errors) && status.errors.length ? status.errors[0] : undefined;
  const firstErrorCode = typeof firstError === 'string' ? firstError : firstError?.code;
  const code = firstErrorCode ? ` error=${firstErrorCode}` : '';
  const fail = (why, remedy = `start aw custody serve for ${resident}`) => failNow(`custody preflight failed for ${resident}: status=${state}${code}; ${why}; ${remedy}`);
  if (state !== 'running') fail('custody service is not running');
  const teamRow = (Array.isArray(status.teams) ? status.teams : []).find((t) => t && sameAwebTeamId(t.team_id || t.id, team));
  if (!teamRow) fail(`team ${team} is not present in custody status`);
  if (teamRow.ready !== true) fail(`team ${team} is not ready in custody status`);
  if (teamRow.certificate_present === false) fail(`team ${team} certificate is not present in custody status`);
  if (teamRow.grant_status_endpoint_ready !== undefined && teamRow.grant_status_endpoint_ready !== true) fail(`the aweb server serving team ${team} does not provide grant status yet; hosted grants wait for that deployment`);
  if (status.keys?.signing_ready !== true) fail('keys.signing_ready is false');
  // A running status without an ops list says nothing about any op.
  if (!Array.isArray(status.ops)) fail('custody status could not be read: it lists no ops');
  const ops = new Set(status.ops.map(String));
  // The continuation op comes with the E2EE ops; the never op is listed by any
  // custody on aw 1.36.32 or later, and needed only by a grant that never expires.
  const requiredOps = ['sign_plain_message.v1', ...(e2eeRequired ? ['unwrap_e2ee_message.v1', 'create_e2ee_envelope.v1', REPLY_CONTINUATION_OP] : []), ...(ttl === 'never' ? [NEVER_TTL_OP] : [])];
  const missingOps = requiredOps.filter((op) => !ops.has(op));
  // A custody started before an aw upgrade keeps its old code, and its old ops,
  // until it restarts. Without its other E2EE ops it has no encryption keys.
  const restartOnFloor = missingOps.length > 0 && missingOps.every((op) => FLOOR_OPS.includes(op));
  if (missingOps.length) fail(`required custody operations are missing: ${missingOps.join(', ')}`, restartOnFloor ? `restart the custody on aw ${AW_MIN} or later (upgrade aw, restart the custody service and the wake daemon, then oats sync)` : undefined);
  if (e2eeRequired && status.keys?.encryption_ready !== true) fail('keys.encryption_ready is false');
  const warnings = [];
  if (!e2eeRequired && status.keys?.encryption_ready !== true) warnings.push('E2E encryption is disabled for this grant and custody encryption is not ready; encrypted mail/chat will not be available in this session.');
  return { status, warnings };
}
