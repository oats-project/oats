/** The warm reader's client (#1630, option C): the background deployment reads answered by one long-lived
 * `oats reader --stdio` child of the installed CLI, kept warm, instead of one CLI run per read.
 *
 * `createWarmReader({ spawn, onStale })` answers `read(cli, options, io)`, a reader with
 * `cliDeploymentRead`'s signature and answers: an observer takes it as its `read`
 * (deployment-observer.mjs), so coalescing, the admission bound and probe-generation revocation are the
 * observer's, unchanged. Whenever the rules below do not let the reader answer, the read is
 * `cliDeploymentRead(cli, options, io)` itself, today's CLI read, unchanged: the reader is an accelerator
 * of identical answers, never a second path with a shape of its own. Its answer goes through the same
 * validation as the CLI's stdout (deployment-read-cli.mjs `deploymentReadAnswer`), parsed once.
 *
 * The rules are the contract's (docs/desktop-cli-api.md, "The warm reader"; the client rules agreed on
 * #1630):
 * - Start: only when the probe lists feature `warm-reader` and `readerApi: 1`, from the same binary and
 *   environment as the CLI reads (`withoutInstanceVariables`), no shell, stdin and stdout piped, stderr
 *   ignored (never read, never forwarded). Reads before its hello go to the CLI: no read waits for it.
 *   Not when that environment's PATH has a relative or empty entry: the CLI runs in each read's
 *   deployment, so such an entry can pick its interpreter (`#!/usr/bin/env node`) there, and one reader
 *   started once cannot do the same for every deployment.
 * - Trust: a hello within the CLI read's timeout, `readerApi === 1`, the probe's `version`, and the read
 *   in `reads`. A wrong hello ends it, and the CLI answers until the record changes. The reader is bound
 *   to the probe record it started for (`probeSignature`); a read under another record ends it.
 * - Routing: only background reads (`--max-age` > 0) go to it; a live read (0) never queues behind it.
 * - Refusals: E_READER_UNSUPPORTED, E_READER_BAD_REQUEST or any other code: that read goes to the CLI, the
 *   reader is kept. E_READER_STALE (the install changed; the reader exits): the read goes to the CLI,
 *   `onStale()` runs (the Desktop probes again), and no reader starts before it settles. Without
 *   `onStale` (a client that never probes again) the record stays on the CLI. Not a failure.
 * - Failures: an exit without an answer, the hello's timeout, a request's timeout, E_READER_DEFECT, an
 *   answer line over its bound. The reads in flight go to the CLI; the next start waits 1 s, doubling, at
 *   most 5 min; after 5 in a row without an answer, the CLI until the record changes.
 * - Timeout: a request's deadline is the CLI read's own, counted from when it becomes the oldest
 *   unanswered one (queue wait does not count).
 * - End: `stop()` closes its stdin, which ends it. A client's death closes that stdin too: the reader's
 *   lifeline is its client's exclusive hold of the write end.
 *
 * `status()` is a diagnostic for the client's own logs and API ({ state, code }), never a fact a page
 * shows: refusal and fallback are silent. `spawn` is `node:child_process` `spawn` or a stand-in with its
 * signature; the module starts nothing itself, so a client keeps the custody of its children. */
import { withoutControlToken } from "./control-environment.mjs";
import { isAbsolute, resolve } from 'node:path';
import { cliDeploymentRead, deploymentReadRefusal, deploymentReadArgv, deploymentReadAnswer, DEPLOYMENT_READ_TIMEOUT, DEPLOYMENT_READ_MAX_BUFFER } from './deployment-read-cli.mjs';
import { maxAgeArgv } from './deployment-contract.mjs';
import { probeSignature } from './cli-probe-contract.mjs';
import { withoutInstanceVariables } from './kernel-environment.mjs';

export const WARM_READER_FEATURE = 'warm-reader';
export const READER_API = 1;
/** The reads the reader may answer, by the observer's action name, as its hello names them. */
const READS = Object.freeze({ status: 'status', 'workspace-status': 'workspace status' });
/** An answer line holds the CLI read's output (its own bound) in an envelope: the id, the exit and at
 * most 8 KiB of stderr text. Past this, the line is not parsed. */
const LINE_LIMIT = DEPLOYMENT_READ_MAX_BUFFER + 64 * 1024;
const FIRST_BACKOFF_MS = 1000, MAX_BACKOFF_MS = 5 * 60_000, GIVE_UP_AFTER = 5;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = path => typeof path === 'string' && !path.includes('\0') && isAbsolute(path) && resolve(path) === path;
const wanted = id => (typeof id === 'string' && id.length <= 64) || Number.isSafeInteger(id);
const later = timer => { if (typeof timer?.unref === 'function') timer.unref(); return timer; };
/** No program PATH finds depends on the process's cwd: every entry is an absolute directory, or there is no
 * PATH (the system's default search path). */
const cwdFreePath = path => path === undefined || (typeof path === 'string' && path.split(':').every(entry => isAbsolute(entry)));

/** The probe lists the reader at the API this client speaks. */
export const readerAdvertised = cli => cli?.ok === true && absolute(cli.bin) && cli.readerApi === READER_API
  && Array.isArray(cli.features) && cli.features.includes(WARM_READER_FEATURE);

export function createWarmReader({ spawn, onStale = null } = {}) {
  if (typeof spawn !== 'function') throw new TypeError('createWarmReader needs a spawn');
  // The record the reader belongs to, with what this client has learnt of readers under it. A new record
  // starts afresh: no failures, no give-up, no mismatch.
  let binding = null;
  let child = null;   // the running reader, or null
  let stopped = false, sequence = 0;

  function bind(cli) {
    const key = probeSignature(cli);
    if (binding?.key === key) return;
    if (child) end(child);
    binding = { key, advertised: readerAdvertised(cli), pathRefused: false, failures: 0, nextStartAt: 0, givenUp: false, mismatch: false, stale: false, code: null };
  }

  function read(cli, options, io = {}) {
    const fallback = () => cliDeploymentRead(cli, options, io);
    if (stopped || !record(cli)) return fallback();
    bind(cli);
    if (!binding.advertised || deploymentReadRefusal(cli, options)) return fallback();
    // Background only: a positive --max-age the argv carries (the probe declares observe-max-age).
    if (!(options.maxAge > 0) || !maxAgeArgv(cli.features, options.maxAge).length) return fallback();
    const env = withoutInstanceVariables(io.env ?? process.env);
    binding.pathRefused = !cwdFreePath(env.PATH);
    if (binding.pathRefused) { binding.code = 'E_READER_PATH'; return fallback(); }
    if (!child) { start(cli, env); return fallback(); }
    if (!child.trusted || !child.reads.has(READS[options.action])) return fallback();
    return ask(child, options.action, deploymentReadArgv(cli, options), fallback);
  }

  function start(cli, env) {
    const b = binding;
    if (b.givenUp || b.mismatch || b.stale || Date.now() < b.nextStartAt) return;
    const c = { binding: b, version: cli.version, proc: null, trusted: false, reads: new Set(), pending: new Map(),
      chunks: [], bytes: 0, helloTimer: null, headId: undefined, headTimer: null, done: false };
    try {
      c.proc = spawn(cli.bin, ['reader', '--stdio'], { env: withoutControlToken(env), stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    } catch { b.code = 'E_READER_EXIT'; return countFailure(b); }
    child = c;
    c.proc.stdin?.on?.('error', () => { /* a dead reader: its close says so */ });
    c.proc.stdout?.on?.('error', () => {});
    c.proc.stdout?.on?.('data', chunk => take(c, chunk));
    c.proc.on?.('error', () => fail(c, 'E_READER_EXIT'));
    c.proc.on?.('close', () => fail(c, 'E_READER_EXIT'));
    c.helloTimer = later(setTimeout(() => fail(c, 'E_READER_HELLO_TIMEOUT', true), DEPLOYMENT_READ_TIMEOUT));
  }

  /** One request: answered by the reader, or by the CLI when the reader refuses it, fails or ends. */
  function ask(c, action, argv, fallback) {
    const id = ++sequence;
    return new Promise(resolve => {
      c.pending.set(id, { action, resolve, fallback });
      armHead(c);
      try { c.proc.stdin.write(`${JSON.stringify({ id, argv })}\n`); } catch { fail(c, 'E_READER_EXIT'); }
    });
  }

  /** The oldest unanswered request's deadline starts when it becomes the oldest. */
  function armHead(c) {
    const head = c.pending.keys().next().value;
    if (head === c.headId) return;
    clearTimeout(c.headTimer);
    c.headId = head; c.headTimer = null;
    if (head !== undefined) c.headTimer = later(setTimeout(() => fail(c, 'E_READER_TIMEOUT', true), DEPLOYMENT_READ_TIMEOUT));
  }

  function settle(c, id, answer) {
    const entry = c.pending.get(id);
    c.pending.delete(id);
    armHead(c);
    entry.resolve(answer === undefined ? entry.fallback() : answer);
  }

  /** Lines out of the reader's stdout, each bounded before it is parsed. */
  function take(c, chunk) {
    if (c.done) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let from = 0;
    while (!c.done) {
      const newline = bytes.indexOf(10, from);
      const piece = bytes.subarray(from, newline < 0 ? bytes.length : newline);
      c.bytes += piece.length;
      if (c.bytes > LINE_LIMIT) return fail(c, 'E_READER_OUTPUT_LIMIT', true);
      if (piece.length) c.chunks.push(piece);
      if (newline < 0) return;
      const line = Buffer.concat(c.chunks).toString('utf8');
      c.chunks = []; c.bytes = 0; from = newline + 1;
      frame(c, line);
    }
  }

  function frame(c, line) {
    let value;
    try { value = JSON.parse(line); } catch { return; } // no frame: ignored (a request it misses times out)
    if (!record(value)) return;
    if (!c.trusted) return Object.hasOwn(value, 'readerApi') ? hello(c, value) : undefined;
    if (Object.hasOwn(value, 'refused')) return refusal(c, value);
    if (!wanted(value.id) || !c.pending.has(value.id) || !Number.isSafeInteger(value.exit) || !Object.hasOwn(value, 'answer')) return;
    c.binding.failures = 0; c.binding.nextStartAt = 0;
    // `answer` is the JSON value the CLI prints, parsed once with the line; `stderr` is never read.
    settle(c, value.id, deploymentReadAnswer(c.pending.get(value.id).action, { failed: value.exit !== 0, document: value.answer }));
  }

  function hello(c, value) {
    clearTimeout(c.helloTimer);
    const reads = Array.isArray(value.reads) && value.reads.every(r => typeof r === 'string') ? value.reads : null;
    if (value.readerApi !== READER_API || value.version !== c.version || !reads || !Object.values(READS).some(r => reads.includes(r))) {
      // Not the reader this probe vouches for: no retries under this record.
      c.binding.mismatch = true; c.binding.code = 'E_READER_MISMATCH';
      return end(c);
    }
    c.trusted = true; c.reads = new Set(reads);
  }

  function refusal(c, value) {
    const code = record(value.refused) && typeof value.refused.code === 'string' ? value.refused.code.slice(0, 64) : null;
    if (code === 'E_READER_STALE') return stale(c);
    if (code === 'E_READER_DEFECT') return fail(c, 'E_READER_DEFECT');
    if (code) c.binding.code = code;
    if (wanted(value.id) && c.pending.has(value.id)) settle(c, value.id); // that read to the CLI; the reader is kept
  }

  function stale(c) {
    if (c.done) return;
    const b = c.binding;
    b.stale = true; b.code = 'E_READER_STALE';
    end(c);
    if (typeof onStale !== 'function') return; // the record stays on the CLI
    Promise.resolve().then(onStale).catch(() => {}).finally(() => { b.stale = false; });
  }

  function countFailure(b) {
    b.failures++;
    b.nextStartAt = Date.now() + Math.min(FIRST_BACKOFF_MS * 2 ** (b.failures - 1), MAX_BACKOFF_MS);
    if (b.failures >= GIVE_UP_AFTER) b.givenUp = true;
  }

  /** A failure of this reader (once): counted against its record, then it ends. `signal`: it stopped
   * answering, so it may not be reading its stdin either. */
  function fail(c, code, signal = false) {
    if (c.done) return;
    c.binding.code = code;
    countFailure(c.binding);
    end(c, signal);
  }

  /** End a reader: close its stdin (and signal it when it stopped answering), and hand every read in
   * flight to the CLI. */
  function end(c, signal = false) {
    if (c.done) return;
    c.done = true;
    clearTimeout(c.helloTimer); clearTimeout(c.headTimer);
    if (child === c) child = null;
    try { c.proc.stdin?.end?.(); } catch { /* already closed */ }
    if (signal) try { c.proc.kill?.('SIGTERM'); } catch { /* already gone */ }
    const pending = [...c.pending.values()];
    c.pending.clear();
    for (const entry of pending) entry.resolve(entry.fallback());
  }

  function status() {
    if (stopped) return { state: 'stopped', code: binding?.code ?? null };
    if (!binding || !binding.advertised) return { state: 'off', code: null };
    if (binding.pathRefused && !child) return { state: 'off', code: binding.code };
    const state = binding.givenUp ? 'given-up' : binding.mismatch ? 'mismatch' : binding.stale ? 'stale'
      : child ? (child.trusted ? 'ready' : 'starting') : binding.failures ? 'backoff' : 'idle';
    return { state, code: binding.code };
  }

  /** The client quits: the reader ends (its stdin closes), and every later read is the CLI's. */
  function stop() {
    stopped = true;
    if (child) end(child);
  }

  return { read, status, stop };
}
