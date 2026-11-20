import {registryEnv} from './registry-setting.mjs';
import {mkdtempSync, chmodSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {ProbeBudget, ProbeError, parseProbeArgs, parseProbeJson, probeEnvironment, runProbeChild, probeSleep, canonicalArgument, refuse} from './probe-runtime.mjs';
import {loadProbeTarget, validateProbeInspect, validateProbeIdentity, readProbeRecord} from './probe-target.mjs';
import {proofMessage, exactProbeMessage, conversationMessages, sameProof, probeId, serverTime} from './probe-proof.mjs';
import {initialDiagnostics, projectReadiness, projectPane, projectMailRead} from './probe-diagnostics.mjs';
import {qualifyProbeSupport} from './probe-support.mjs';

const fingerprint = target => JSON.stringify({home: target.home, alias: target.alias, team: target.team, root: target.rootHome, harness: target.harness, delivery: target.delivery, settings: target.settings, identity: target.captured.capabilityMeta['oats.aweb'].identity, startId: target.captured.startId ?? null});
const version = (value, source, at) => ({status: 'known', version: value, source, observedAt: at});
export function emptyProbeResult(startedAt) {
  return {schemaVersion: 1, outcome: 'FAIL', reason: 'not-started',
    target: {home: null, alias: null, team: null, did: null, harness: null, delivery: null}, sender: {did: null},
    request: {messageId: null, conversationId: null, sentAt: null, sendStartedAt: null, sendCompletedAt: null}, reply: null,
    timing: {startedAt, finishedAt: null, elapsedMs: 0, sendMs: null, waitMs: null, replyMs: null},
    diagnostics: initialDiagnostics(), warnings: []};
}
/** Dependencies are injectable for offline tests, never selected by CLI flags or
 * environment. Production support admission is exclusively probe-support.mjs. */
export async function runProbe(argv, {env = process.env, signal, now, wall, child = runProbeChild, sleep = probeSleep, support = qualifyProbeSupport, readTarget = loadProbeTarget, nonce = () => randomBytes(24).toString('hex')} = {}) {
  let budget = new ProbeBudget(60, {now, wall, signal});
  const result = emptyProbeResult(budget.startedAt);
  let temporary, target, sendStart, sendEnd, observedEnd, waitStart, options;
  try {
    options = parseProbeArgs(argv);
    budget.deadline = budget.started + options.timeout * 1000;
    budget.check();
    result.target.home = options.home;
    target = readTarget(options.home, env.OATS_WORKSPACE);
    Object.assign(result.target, {home: target.home, alias: target.alias, team: target.team, harness: target.harness, delivery: target.delivery});
    result.diagnostics.versions.harness.name = target.harness;
    if (!canonicalArgument(env.OATS_CLI_BIN)) refuse('selected-kernel-unavailable');
    temporary = mkdtempSync(join(tmpdir(), 'oats-aweb-probe-'));
    chmodSync(temporary, 0o700);
    const cleanEnv = probeEnvironment(env);
    const execute = (cmd, args, capMs) => child(cmd, args, {budget, cwd: temporary, env: cmd===process.execPath ? cleanEnv : {...cleanEnv,...registryEnv(target.settings,args)}, capMs});
    const kernel = async (args, capMs = 5000) => parseProbeJson(await execute(process.execPath, [env.OATS_CLI_BIN, ...args], capMs));
    try {
      const manifest = readProbeRecord(fileURLToPath(new URL('../oats.json', import.meta.url)));
      if (/^\d+\.\d+\.\d+$/.test(manifest.version)) result.diagnostics.versions.oatsAweb = version(manifest.version, 'executing-provider-manifest', budget.wall());
    } catch { /* version evidence unavailable */ }
    try {
      const v = await kernel(['--version', '--json'], Math.min(1000, budget.remaining() / 10));
      if (v?.schemaVersion === 1 && v.name === '@awebai/oats' && /^\d+\.\d+\.\d+$/.test(v.version)) result.diagnostics.versions.oatsKernel = version(v.version, 'selected-kernel.version', budget.wall());
    } catch { budget.check(); }
    // Initial public diagnostics fit INSIDE the same deadline. Readiness can
    // invoke provider checks, so its owned process group is bounded as well.
    const diagnosticCap = Math.max(1, Math.min(2000, budget.remaining() / 10));
    try { const d = projectPane(await kernel(['session', 'inspect', '--home', target.home, '--json'], diagnosticCap), target.home, budget.wall()); if (d) result.diagnostics.pane = d; } catch { budget.check(); }
    try { const d = projectReadiness(await kernel(['readiness', '--home', target.home, '--json'], diagnosticCap), target.home); if (d) result.diagnostics.readiness = d; } catch { budget.check(); }
    // No send is reachable until BOTH released CLI and service contracts are
    // qualified. Admission observes the selected service, not a fleet-wide release claim.
    const qualified = await support({execute, target, budget, path: cleanEnv.PATH});
    budget.check();
    if (!qualified || qualified.cli !== true || qualified.server !== true || !canonicalArgument(qualified.awBinary)) refuse('probe-cli-and-server-support-unqualified');
    if (typeof qualified.newConversationFlag !== 'boolean') refuse('probe-cli-fresh-send-unqualified');
    const aw = async (identityHome, args, capMs = 10000) => {
      qualified.revalidate?.();
      // --team is command-scoped in aw, not a persistent root flag.
      const teamArgs = args[0] === 'mail' || args[0] === 'whoami' ? ['--team', target.team] : [];
      return parseProbeJson(await execute(qualified.awBinary, ['--identity-home', identityHome, ...teamArgs, ...args, '--json'], capMs));
    };
    if (typeof qualified.awVersion === 'string' && /^\d+\.\d+\.\d+$/.test(qualified.awVersion)) result.diagnostics.versions.aw = version(qualified.awVersion, 'qualified-probe-aw-binary', budget.wall());
    const inspected = await kernel(['inspect', '--home', target.home, '--json']);
    validateProbeInspect(inspected, target);
    const record = fingerprint(target);
    const identity = async (identityHome, alias) => validateProbeIdentity(await aw(identityHome, ['whoami']), await aw(identityHome, ['id', 'team', 'list']), alias, target.team);
    const sender = await identity(target.rootHome, null), receiver = await identity(target.identityHome, target.alias);
    if (sender === receiver) refuse('sender-equals-target');
    result.sender.did = sender; result.target.did = receiver;
    result.warnings.push('aw may update its existing trust cache while verifying messages');
    if (target.harness === 'claude' && target.delivery === 'channel') result.warnings.push('channel admission or development confirmation may block delivery; unproven by this probe');
    const challenge = nonce();
    if (!/^[a-f0-9]{32,128}$/.test(challenge)) refuse('invalid-nonce');
    const bodyFile = join(temporary, 'challenge.txt');
    writeFileSync(bodyFile, `Reply in this same mail thread with the exact nonce token ${challenge}.\n`, {mode: 0o600, flag: 'wx'});
    const subject = `OATS round-trip probe ${challenge}`;
    qualified.revalidate?.();
    budget.check(); sendStart = budget.now(); result.request.sendStartedAt = budget.wall();
    let sent;
    try {
      // The released primitive skips ALL auto-thread discovery. Never fall back
      // to legacy send, and never retry any uncertain send outcome.
      sent = await aw(target.rootHome, ['mail', 'send', ...(qualified.newConversationFlag ? ['--new-conversation'] : []), '--to', target.alias, '--subject', subject, '--body-file', bodyFile]);
      if (!probeId(sent?.message_id) || !probeId(sent?.conversation_id)) refuse('invalid-send-response');
    } catch { refuse('send-outcome-unknown'); }
    finally { sendEnd = budget.now(); result.request.sendCompletedAt = budget.wall(); result.timing.sendMs = Math.max(0, sendEnd - sendStart); }
    Object.assign(result.request, {messageId: sent.message_id, conversationId: sent.conversation_id});
    waitStart = sendEnd;
    const requestClaims = {from: sender, to: receiver, conversation: sent.conversation_id, nonce: challenge, messageId: sent.message_id};
    const replyClaims = {from: receiver, to: sender, conversation: sent.conversation_id, nonce: challenge, distinctFrom: sent.message_id};
    const readSent = async () => {
      const message = exactProbeMessage(await aw(target.rootHome, ['mail', 'show', '--message-id', sent.message_id]), sent.message_id);
      if (!proofMessage(message, requestClaims)) refuse('sent-message-proof-mismatch');
      result.request.sentAt = serverTime(message.created_at);
      result.diagnostics.mailRead = projectMailRead(message, budget.wall());
      return message;
    };
    await readSent();
    let incomplete = false, invalidReply = false, readFailed = false;
    // Reserve a final exact sent-ID read for read/unanswered classification.
    const waitDeadline = budget.deadline - Math.min(2000, options.timeout * 100);
    while (budget.now() < waitDeadline) {
      budget.check();
      let page;
      try {
        page = conversationMessages(await aw(target.rootHome, ['mail', 'show', '--conversation-id', sent.conversation_id, '--limit', '500'], Math.min(10000, waitDeadline - budget.now())));
      } catch (e) {
        budget.check();
        readFailed = true;
        if (['decryption-failed', 'selected-service-config-changed', 'selected-service-config-unavailable', 'probe-cli-changed'].includes(e.reason)) throw e;
        if (e.reason === 'invalid-json' || e.reason === 'invalid-conversation' || e.reason === 'output-too-large') throw e;
      }
      if (page) {
        incomplete ||= page.incomplete;
        for (const candidate of page.messages) {
          if (candidate?.message_id === sent.message_id) continue;
          if (!proofMessage(candidate, replyClaims)) { if (candidate?.from_did === receiver) invalidReply = true; continue; }
          const exact = exactProbeMessage(await aw(target.rootHome, ['mail', 'show', '--message-id', candidate.message_id]), candidate.message_id);
          if (!proofMessage(exact, {...replyClaims, messageId: candidate.message_id}) || !sameProof(candidate, exact)) refuse('reply-changed');
          observedEnd = budget.now();
          result.reply = {messageId: exact.message_id, sentAt: serverTime(exact.created_at), observedAt: budget.wall()};
          result.timing.replyMs = Math.max(0, observedEnd - sendEnd);
          const current = readTarget(target.home, env.OATS_WORKSPACE);
          if (fingerprint(current) !== record || await identity(target.identityHome, target.alias) !== receiver || await identity(target.rootHome, null) !== sender) refuse('identity-changed');
          validateProbeInspect(await kernel(['inspect', '--home', target.home, '--json']), target);
          budget.check();
          result.outcome = 'PASS'; result.reason = 'verified-round-trip';
          // A reply means read-unanswered is no longer an accurate label.
          result.diagnostics.mailRead = {status: 'unknown', readAt: result.diagnostics.mailRead.readAt, source: result.diagnostics.mailRead.source, observedAt: result.diagnostics.mailRead.observedAt};
          return result;
        }
      }
      if (budget.now() < waitDeadline) await sleep(Math.min(1000, waitDeadline - budget.now()), budget);
    }
    if (budget.remaining() > 0) {
      try { await readSent(); } catch (e) { if (e.reason === 'sent-message-proof-mismatch') throw e; result.diagnostics.mailRead = {status: 'unknown', readAt: null, source: null, observedAt: null}; }
    }
    refuse(incomplete ? 'observation-incomplete' : invalidReply ? 'reply-proof-mismatch' : readFailed ? 'mail-read-unavailable' : 'reply-not-observed');
  } catch (e) {
    result.reason = e instanceof ProbeError ? e.reason : 'probe-unavailable';
    return result;
  } finally {
    result.timing.finishedAt = budget.wall(); result.timing.elapsedMs = Math.max(0, budget.now() - budget.started);
    if (waitStart !== undefined) result.timing.waitMs = Math.max(0, (observedEnd ?? budget.now()) - waitStart);
    if (temporary) { try { rmSync(temporary, {recursive: true, force: true}); } catch { result.outcome = 'FAIL'; result.reason = 'temporary-cleanup-failed'; } }
  }
}
export function formatProbe(result, json) {
  if (json) return JSON.stringify(result);
  const sendNote = result.reason === 'send-outcome-unknown' ? ` send outcome unknown; no retry; ${result.request.messageId || result.request.conversationId ? 'obtained IDs shown below' : 'recovery ID unavailable'};` : '';
  return `${result.outcome} ${result.reason};${sendNote} elapsed=${Math.round(result.timing.elapsedMs)}ms send=${result.timing.sendMs === null ? 'unknown' : Math.round(result.timing.sendMs) + 'ms'} reply=${result.timing.replyMs === null ? 'unknown' : Math.round(result.timing.replyMs) + 'ms'} request=${result.request.messageId ?? 'unknown'} conversation=${result.request.conversationId ?? 'unknown'} replyId=${result.reply?.messageId ?? 'unknown'}`;
}
