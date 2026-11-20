import {awChildEnv} from './aw-child-env.mjs';
// Probe I/O is bounded by one monotonic deadline. This module never sends mail.
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {isAbsolute, resolve} from 'node:path';
import {parseBindingJson} from './binding-wire.mjs';

export const PROBE_LIMITS = Object.freeze({bytes: 1024 * 1024, depth: 24, entries: 20000});
export class ProbeError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
export const refuse = reason => { throw new ProbeError(reason); };
export function parseProbeJson(bytes) {
  try { return parseBindingJson(bytes, PROBE_LIMITS); }
  catch { refuse('invalid-json'); }
}
export function canonicalArgument(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value) && resolve(value) === value;
}
export function parseProbeArgs(argv) {
  const values = {timeout: 60, json: false}, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i], at = raw.indexOf('='), key = at < 0 ? raw : raw.slice(0, at);
    if (!['--home', '--timeout', '--json'].includes(key) || seen.has(key)) refuse('invalid-arguments');
    seen.add(key);
    if (key === '--json') {
      if (at >= 0) refuse('invalid-arguments');
      values.json = true;
    } else {
      const value = at < 0 ? argv[++i] : raw.slice(at + 1);
      if (typeof value !== 'string' || !value || value.startsWith('--')) refuse('invalid-arguments');
      if (key === '--home') values.home = value;
      else {
        if (!/^(?:\d+)(?:\.\d+)?$/.test(value)) refuse('invalid-timeout');
        values.timeout = Number(value);
        if (!Number.isFinite(values.timeout) || values.timeout <= 0 || values.timeout > 300) refuse('invalid-timeout');
      }
    }
  }
  if (!canonicalArgument(values.home)) refuse('invalid-home');
  return values;
}
export function probeEnvironment(inherited) {
  const env = {...inherited};
  // Neutral cwd additionally prevents aw's .env.aweb overload from restoring
  // removed selectors. Host HOME/auth context remains the operator's own.
  for (const key of Object.keys(env)) {
    if (/^(AW_|AWEB_|OATS_|OAS_|PI_AGENT_)/.test(key) || key === 'PI_AGENTS_ROOT' || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  return awChildEnv(env);
}
export class ProbeBudget {
  constructor(seconds, {now = () => performance.now(), wall = () => new Date().toISOString(), signal} = {}) {
    this.now = now; this.wall = wall; this.signal = signal;
    this.started = now(); this.startedAt = wall(); this.deadline = this.started + seconds * 1000;
  }
  remaining() { return Math.max(0, this.deadline - this.now()); }
  check() {
    if (this.signal?.aborted) refuse('cancelled');
    if (this.remaining() <= 0) refuse('timeout');
  }
  cap(ms = 10000) { this.check(); return Math.max(1, Math.ceil(Math.min(ms, this.remaining()))); }
}
export function runProbeChild(command, args, {budget, cwd, env, capMs = 10000}) {
  const timeout = budget.cap(capMs);
  return new Promise((resolveResult, reject) => {
    let child, settled = false, timer, size = 0, chunks = [], failure, errorTail = '', decryptionFailure = false;
    const done = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); budget.signal?.removeEventListener('abort', abort);
      if (failure) reject(new ProbeError(failure));
      else { try { budget.check(); resolveResult(Buffer.concat(chunks)); } catch (e) { reject(e); } }
    };
    const kill = reason => {
      if (settled) return;
      failure ||= reason;
      // Kill the whole owned group, including a kernel readiness child. No
      // detached poller survives a deadline or cancellation on supported Unix.
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const abort = () => kill('cancelled');
    try { child = spawn(command, args, {cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']}); }
    catch { failure = 'child-failed'; done(); return; }
    timer = setTimeout(() => kill('child-timeout'), timeout);
    budget.signal?.addEventListener('abort', abort, {once: true});
    if (budget.signal?.aborted) abort();
    child.stdout.on('data', data => { size += data.length; if (size > PROBE_LIMITS.bytes) kill('output-too-large'); else chunks.push(data); });
    // stderr is never projected or retained: it can contain bodies/credentials.
    child.stderr.on('data', data => {
      size += data.length; if (size > PROBE_LIMITS.bytes) kill('output-too-large');
      errorTail = (errorTail + data.toString('utf8')).slice(-4096);
      decryptionFailure ||= /encrypted message requires local encryption private key|missing local encryption private key|decrypt content:|decode inner payload:|inner header.*mismatch|ciphertext.*mismatch|no matching.*key wrap/i.test(errorTail);
    });
    child.on('error', () => { failure ||= 'child-failed'; });
    child.on('close', code => { if (code !== 0) failure ||= decryptionFailure ? 'decryption-failed' : 'child-failed'; done(); });
  });
}
export async function probeSleep(ms, budget) {
  const delay = budget.cap(ms);
  await new Promise((resolveWait, reject) => {
    const cancel = () => { clearTimeout(timer); budget.signal?.removeEventListener('abort', cancel); reject(new ProbeError('cancelled')); };
    const timer = setTimeout(() => { budget.signal?.removeEventListener('abort', cancel); resolveWait(); }, delay);
    budget.signal?.addEventListener('abort', cancel, {once: true});
    if (budget.signal?.aborted) cancel();
  });
  budget.check();
}
