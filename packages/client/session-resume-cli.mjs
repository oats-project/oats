/** The kernel's machine sweep, `oats session resume --json`, run by a client at its launch: it resumes every
 * lost session on every local deployment. The answer is read by session-resume.mjs; this home runs it and
 * passes on only the kernel's JSON: its envelope, a refusal's code and message, or a code of its own.
 *   argv  ['session', 'resume', '--json']: no `--deployment` and no `--plan` from a client.
 *   cwd   '/': the kernel resolves no deployment from the client's working directory.
 *   env   the client's, cleaned (cli-environment.mjs) and without the instance variables (kernel-environment.mjs):
 *         a client started inside an instance must not scope the sweep to it. OATS_HOME_DIR passes through.
 * It needs a compatible CLI (`cli.ok`, an absolute `cli.bin`) and the probe's `session-resume` feature: without
 * either it runs nothing, and nothing falls back. There is no client-side deadline: the sweep starts sessions,
 * and a client waits as long as it runs; when the client is gone first, the answer is just not shown. */
import { cliEnvironment } from './cli-environment.mjs';
import { withoutInstanceVariables } from './kernel-environment.mjs';
import { parseEnvelope } from './cli-adapter.mjs';
import { kernelMade } from './kernel-made.mjs';
import { execFileToFiles } from './file-output-exec.mjs';

export const SESSION_RESUME_FEATURE = 'session-resume';
/** A row per instance of every local deployment, with the start answer's warnings: far below this. */
export const SESSION_RESUME_MAX_BUFFER = 4 * 1024 * 1024;
const ARGV = Object.freeze(['session', 'resume', '--json']);
const CODE = /^E_[A-Z0-9_]{1,64}$/;

const compatible = (cli) => cli?.ok === true && typeof cli.bin === 'string' && cli.bin.startsWith('/');
/** Whether a probe (`oats version --json`, accepted, with an absolute bin) declares the sweep. */
export const resumeSupported = (cli) => compatible(cli) && Array.isArray(cli.features) && cli.features.includes(SESSION_RESUME_FEATURE);

/** A failure this home writes itself: a code and nothing else (no message, no stderr, no thrown text). */
const failure = (code) => ({ schemaVersion: 1, ok: false, error: { code } });
/** The kernel's refusal, passed on as its code and, when a string, its message (kernel prose, marked the kernel's). */
function refusal(error) {
  if (typeof error?.code !== 'string' || !CODE.test(error.code)) return failure('E_CLI_PROTOCOL');
  return { schemaVersion: 1, ok: false, error: kernelMade({ code: error.code, ...(typeof error.message === 'string' ? { message: error.message } : {}) }) };
}

/**
 * Run the sweep once. `cli` is the client's accepted probe (`{ ok, bin, features }`).
 * `io.exec` is the caller's exec, with execFile's signature; it defaults to execFileToFiles. A caller's exec MUST
 * start the child detached (a session of its own), give it files and never pipes for its output, and never
 * signal it: the sweep outlives the client that started it (the TUI passes its `changeExec`). No `timeout` is
 * given. `io.env` replaces process.env as the environment cleaned.
 * Never rejects. Resolves the parsed `{ schemaVersion: 1, ok: true, result }` (exit 0 only); the kernel's refusal
 * `{ schemaVersion: 1, ok: false, error: { code, message } }` whatever the exit (E_RESUME_BUSY and
 * E_RESUME_LOCK_STUCK exit 1); or
 * `{ schemaVersion: 1, ok: false, error: { code } }`: E_CLI_UNAVAILABLE, E_RESUME_FEATURE (nothing ran),
 * E_CLI_OUTPUT_LIMIT (over SESSION_RESUME_MAX_BUFFER), E_CLI_PROTOCOL (no envelope, or a refusal without a valid
 * code), E_CLI_FAILED (a nonzero exit with no refusal, or an exec that threw).
 */
export function runResumeSweep(cli, io = {}) {
  if (!compatible(cli)) return Promise.resolve(failure('E_CLI_UNAVAILABLE'));
  if (!resumeSupported(cli)) return Promise.resolve(failure('E_RESUME_FEATURE'));
  const env = withoutInstanceVariables(cliEnvironment(io.env ?? process.env));
  return new Promise((done) => {
    const fail = (code) => done(failure(code));
    try {
      (io.exec ?? execFileToFiles)(cli.bin, [...ARGV], { cwd: '/', env, shell: false, encoding: 'utf8', maxBuffer: SESSION_RESUME_MAX_BUFFER }, (error, stdout) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail('E_CLI_OUTPUT_LIMIT');
        const envelope = parseEnvelope(stdout);
        if (!envelope) return fail(error ? 'E_CLI_FAILED' : 'E_CLI_PROTOCOL');
        if (envelope.ok === false) return done(refusal(envelope.error));
        if (error) return fail('E_CLI_FAILED'); // success is exit 0 only
        done(envelope);
      });
    } catch { fail('E_CLI_FAILED'); }
  });
}
