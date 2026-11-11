/** The start and restart rule of an existing instance (#855, 5a-2): whether a row can be started now
 * (`startGate`), the home a local start launches in (`verifiedLocalHome`), and the start itself
 * (`startInstance`). A client decides through these and words nothing of its own for them, except the codes
 * the rule leaves to it (below). Every function that words a sentence takes the client's `terms`
 * (client-terms.mjs) and refuses a call without them. No state.
 *
 * A failed start is one of two outcomes, and the words are "nothing was started", never "nothing happened"
 * (a restart that lost the race has already run its own stop, and a start may have written its pending receipt):
 *   refused    this request started nothing: every refusal of the gate and of the home check, the kernel's
 *              STARTED_NOTHING_CODES, and its CLAIM_STARTED_NOTHING_CODES from a kernel that holds the claim
 *              for a start;
 *   uncertain  anything else: no envelope, any other code, and E_START_UNCONFIRMED, the end of the wait
 *              for a start that goes on (cli-adapter.mjs cliStart: no deadline, START_WAIT_MS). That code
 *              carries no sentence: each client words it (the Desktop: renderer/start-unconfirmed.mjs).
 * After any failed start, refused or uncertain, the client reads the row again before it offers anything. */
import { basename, dirname, sep } from 'node:path';
import { cliStart } from './cli-adapter.mjs';
import { harnessFlag } from './harness-names.mjs';
import { startGate } from './start-gate.mjs';
import { retainedSpawnDetails } from './launch-prompt-outcome.mjs';
import { answeringFeatures, busyHolder } from './lifecycle-contract.mjs';
import { displayLine } from './display-text.mjs';
import { requireTerms } from './client-terms.mjs';

/** The gate is page-safe and lives apart (start-gate.mjs); a client takes it from here, with the rest of the rule. */
export { startGate };

/** The kernel's codes for a start that started nothing: another start holds the home, an upgrade has not
 * finished, or an earlier start's pane is still a shell without its completion marker (E_SESSION_START_BUSY);
 * an earlier kernel's start lock, or anything else that is no upgrade's file, is at the home's
 * `.oats-start.lock` (E_SESSION_START_LOCK_STUCK); the instance was seen running, or its window appeared
 * during the start (E_SESSION_RUNNING). Some places that raise E_SESSION_RUNNING come
 * after the kernel has written the start's pending receipt, or after a restart's stop: nothing was started,
 * not nothing happened. A code joins only when every place the kernel raises it in a start launches nothing. */
export const STARTED_NOTHING_CODES = Object.freeze(['E_SESSION_START_BUSY', 'E_SESSION_START_LOCK_STUCK', 'E_SESSION_RUNNING']);

/** The kernel feature from which a start or a restart holds the home's lifecycle claim (#1602). */
const CLAIM_START_FEATURE = 'lifecycle-claim-start';
/** The kernel's codes for a start refused because of something else on the home: a stop or an upgrade holds the
 * claim (E_LIFECYCLE_BUSY), or a retirement holds it, or a retirement or a failed spawn left cleanup to finish
 * (E_INSTANCE_RETIRING). A kernel raises both at the claim, or before the launch hooks and a restart's stop, so
 * a restart refused this way stopped nothing too; a claim's takeover that ended something answers E_LIFECYCLE_FAILED instead. They read as
 * STARTED_NOTHING_CODES only from a kernel that names CLAIM_START_FEATURE: the answering kernel's own list
 * (lifecycle-contract.mjs answeringFeatures), never this computer's for a server's row. */
export const CLAIM_STARTED_NOTHING_CODES = Object.freeze(['E_LIFECYCLE_BUSY', 'E_INSTANCE_RETIRING']);

/** The kernel codes' own sentences, for a client that words by code. The kernel's message is the answer's
 * `detail`, through the display filter. E_SESSION_START_BUSY says no more than busy. E_SESSION_START_LOCK_STUCK
 * is what only a person ends: the kernel's message names the path to remove. */
const STARTED_NOTHING = Object.freeze({
  E_SESSION_START_BUSY: 'OATS refused this start as busy. Nothing was started.',
  E_SESSION_START_LOCK_STUCK: 'Something in this instance\'s home blocks starting, usually a start lock an earlier OATS left; OATS\'s message names it. Nothing was started. Remove it once no earlier OATS is running: waiting will not clear it.',
  E_SESSION_RUNNING: 'This instance is already running. Nothing was started.',
});
/** A CLAIM_STARTED_NOTHING_CODES refusal's sentence. E_LIFECYCLE_BUSY reads by who holds the claim (`holder`,
 * lifecycle-contract.mjs busyHolder): only `running` promises that waiting ends it. E_INSTANCE_RETIRING is also
 * the answer for a retirement that failed or was interrupted and for what a failed spawn left, where no
 * retirement began, so it names both and the kernel's line under it says which. */
function claimRefusalSentence(code, holder, restart) {
  const nothing = restart ? 'Nothing was stopped or started.' : 'Nothing was started.';
  if (code === 'E_INSTANCE_RETIRING') return `This instance is being retired, or has cleanup to finish. ${nothing}`;
  if (holder === 'running') return `Another OATS command is running on this instance. ${nothing} Wait for it to finish, then try again.`;
  if (holder === 'unknown') return `${nothing} OATS can't tell whether another command is still running on this instance.`;
  if (holder === 'none') return `${nothing} There is no other command to wait for.`;
  return `OATS refused this ${restart ? 'restart' : 'start'} as busy. ${nothing}`;
}
const CLI_FAILED = 'The start could not be confirmed: the call to the OATS CLI failed. Refresh its status before starting it again.';

/** The home a local start launches in, or null. It is DERIVED and VERIFIED, never trusted from roster data
 * alone: the exact home the kernel's status reported for this row in one of `deployments` (`[{ id, remote,
 * instances }]`: a deployment's directory and the rows it reported), canonicalizing to …/instances/<name>
 * inside that deployment's canonical directory. `realpath` is the caller's; this reads no file system of its
 * own. A server's row has no local home. */
export function verifiedLocalHome(row, deployments, realpath) {
  if (!row?.home || typeof row.home !== 'string' || row.server) return null;
  let real;
  try { real = realpath(row.home); } catch { return null; }
  if (basename(real) !== String(row.instance) || basename(dirname(real)) !== 'instances') return null;
  for (const w of deployments || []) {
    if (w.remote) continue;
    if (!(w.instances || []).some(i => !i.server && i.instance === row.instance && i.home === row.home)) continue;
    let scope;
    try { scope = realpath(w.id); } catch { continue; }
    if (real.startsWith(scope.endsWith(sep) ? scope : scope + sep)) return real;
  }
  return null;
}

/** Whether `v` is the receipt of a completed start or restart of `row`, as the kernel answers one
 * (docs/desktop-cli-api.md, `oats session start`: `{instance, agent, home, harness, backend, model, launchConfig,
 * yolo, target, startedAt, restartCount, reused, warnings}`): the row's instance, in the row's home (the kernel
 * answers with its real path: `canonical`, the verified local home), with the fields a start always carries. Read
 * where the CLI is newer than this client was tested with, so a format it does not know is not taken for one. */
function startReceipt(v, row, canonical) {
  const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  const text = (x) => typeof x === 'string' && x.length > 0;
  return record(v) && v.instance === row.instance && text(v.home) && (v.home === row.home || (canonical !== null && v.home === canonical))
    && text(v.agent) && text(v.harness) && text(v.backend) && text(v.startedAt) && record(v.target)
    && Number.isSafeInteger(v.restartCount) && v.restartCount >= 0 && typeof v.reused === 'boolean'
    && Array.isArray(v.warnings) && v.warnings.every((w) => typeof w === 'string');
}

/** Start or restart one row.
 *   choices   { model, launchConfig, harness, yolo }: the launch choices, each one argv value
 *   restart   a restart (the kernel's one call, never a stop then a start)
 *   localCwd  where a server's start runs from (this machine's own directory)
 *   verifyHome(row) -> canonical home | null   the caller's local home check; default verifiedLocalHome over
 *             `deployments` and `realpath`
 *   start     the CLI call (cli-adapter.mjs cliStart, with its own session and its wait); `exec`, `after` and
 *             `wait` pass to it
 *   group     the roster group of a server's row's deployment: its `probe` says which features the host answers
 *             with (lifecycle-contract.mjs answeringFeatures)
 * -> { ok: true, result } | { ok: false, outcome, code, sentence, detail, ran, atClaim?, incomplete? }
 * `ran`: whether the CLI was called (E_CLI_FAILED: the call was made and failed; whether the CLI began is not
 * known). `sentence` is null for a code the client words (E_START_UNCONFIRMED) and
 * for one it does not know: it then shows `detail`, the kernel's message through the display filter.
 * `atClaim`: refused because of something else on the home (CLAIM_STARTED_NOTHING_CODES): `sentence` is this
 * refusal's own, and a client shows it over `detail`.
 * `incomplete`: a start that stopped at a launch prompt (E_SPAWN_INCOMPLETE) and names this row, decoded. */
export async function startInstance(cli, row, choices = {}, { restart = false, deployments = [], realpath, localCwd, verifyHome, start = cliStart, exec, after, wait, group, terms } = {}) {
  requireTerms(terms, 'startInstance');
  const refused = (code, sentence, more = {}) => ({ ok: false, outcome: 'refused', code, sentence, detail: null, ran: false, ...more });
  const gate = startGate(cli, row, { restart, choices }, terms);
  if (gate) return refused(gate.code, gate.sentence, gate.detail ? { detail: gate.detail } : {});
  const local = !row.server;
  const canonical = local ? (verifyHome ? verifyHome(row) : verifiedLocalHome(row, deployments, realpath)) : null;
  if (local && !canonical) return refused('E_HOME_UNVERIFIED', 'Instance home is outside the workspace instances layout');
  let envelope;
  // A call that could not be made, or failed on its way (an exec that throws, a rejected call), is uncertain like
  // any answer this cannot read: the CLI may have begun the start. Its words are the rule's; the exception's text
  // is no kernel's message, and is not passed on as `detail`.
  try { envelope = await start(cli.bin, { home: row.home, model: choices.model, launchConfig: choices.launchConfig, harness: choices.harness,
    harnessFlag: harnessFlag(cli), yolo: choices.yolo, restart, workspaceDir: local ? dirname(row.agentsRoot) : localCwd, server: row.server },
  { ...(exec ? { exec } : {}), ...(after ? { after } : {}), ...(wait !== undefined ? { wait } : {}) }); }
  catch { return { ok: false, outcome: 'uncertain', code: 'E_CLI_FAILED', sentence: CLI_FAILED, detail: null, ran: true }; }
  if (envelope?.ok === true) {
    // Above the client's tested bound (#1879, cli-locator.mjs aboveTested) a start is reported started only on the
    // receipt it knows (startReceipt): any other answer is an outcome not known, never a start, and nothing more
    // is run. Within the bound the answer is taken as before.
    if (cli?.aboveTested === true && !startReceipt(envelope.result, row, canonical))
      return { ok: false, outcome: 'uncertain', code: 'E_CLI_PROTOCOL', sentence: null, detail: null, ran: true };
    return { ok: true, result: envelope.result };
  }
  const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'E_CLI_PROTOCOL';
  const detail = displayLine(envelope?.error?.message);
  if (CLAIM_STARTED_NOTHING_CODES.includes(code)) {
    const features = answeringFeatures({ cli, routed: !local, group });
    if (features?.includes(CLAIM_START_FEATURE))
      return { ok: false, outcome: 'refused', code, sentence: claimRefusalSentence(code, busyHolder(code, envelope.error.details, features), restart), detail, ran: true, atClaim: true };
  }
  const kept = code === 'E_SPAWN_INCOMPLETE' ? retainedSpawnDetails(envelope.error.details) : null;
  return { ok: false, outcome: STARTED_NOTHING_CODES.includes(code) ? 'refused' : 'uncertain', code,
    sentence: Object.hasOwn(STARTED_NOTHING, code) ? STARTED_NOTHING[code] : null, detail, ran: true,
    ...(kept?.launchPrompts && kept.instance === row.instance ? { incomplete: kept } : {}) };
}
