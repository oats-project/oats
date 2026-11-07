/** Bounded fixed-argv native deployment reads. Private producer documents are
 * projected by the owning observer, never forwarded wholesale to a renderer. */
import { withoutControlToken } from "./control-environment.mjs";
import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { deploymentReadGate, deploymentFailure, deploymentRecord, deploymentErrorCode, validMaxAge, maxAgeArgv, remoteFailureCause } from './deployment-contract.mjs';
import { withoutInstanceVariables } from './kernel-environment.mjs';

export const DEPLOYMENT_READ_TIMEOUT = 30_000;
export const DEPLOYMENT_READ_MAX_BUFFER = 4 * 1024 * 1024;
const absolute = path => typeof path === 'string' && !path.includes('\0') && isAbsolute(path) && resolve(path) === path;

/** `status` is a raw object; `workspace status` is a schemaVersion:1 envelope.
 * Those are distinct native command contracts, not interchangeable generations.
 * `io.exec` is a client's own `execFile` (the rule is at cli-adapter.mjs `runJson`); `io.env` its environment. */
export function cliDeploymentRead(cli, options, io = {}) {
  const refused = deploymentReadRefusal(cli, options);
  if (refused) return Promise.resolve(refused);
  const context = options.context, bin = cli.bin, action = options.action;
  const argv = deploymentReadArgv(cli, options);
  const env = withoutInstanceVariables(withoutControlToken(io.env));
  return new Promise(done => {
    const fail = code => done(deploymentFailure(code));
    try {
      (io.exec ?? execFile)(bin, argv, { cwd: context, env, shell: false, encoding: 'utf8', timeout: DEPLOYMENT_READ_TIMEOUT, maxBuffer: DEPLOYMENT_READ_MAX_BUFFER }, (error, stdout) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail('E_CLI_OUTPUT_LIMIT');
        if (error?.killed) return fail('E_CLI_TIMEOUT');
        if (typeof stdout !== 'string') return fail(error ? 'E_CLI_FAILED' : 'E_CLI_PROTOCOL');
        if (Buffer.byteLength(stdout, 'utf8') > DEPLOYMENT_READ_MAX_BUFFER) return fail('E_CLI_OUTPUT_LIMIT');
        let document;
        try { document = JSON.parse(stdout); } catch { return fail(error ? 'E_CLI_FAILED' : 'E_CLI_PROTOCOL'); }
        done(deploymentReadAnswer(action, { failed: !!error, document }));
      });
    } catch { fail('E_CLI_FAILED'); }
  });
}

/* The three pieces below are the read's own, shared by its two routes: the CLI run above and the warm
 * reader (warm-reader.mjs), which answers the same argv with the same JSON. Neither route has a check of
 * its own, so a reader answer is held to exactly what the same CLI run would be. Not on the stable surface. */

/** The refusal of a read before anything runs (the probe's gate, then the input), or null. */
export function deploymentReadRefusal(cli, options) {
  const gate = deploymentReadGate(cli, options?.action);
  if (gate) return gate;
  if (!absolute(cli.bin) || !deploymentRecord(options) || Object.keys(options).some(k => !['action', 'context', 'maxAge'].includes(k))
    || !absolute(options.context) || !validMaxAge(options.maxAge)) return deploymentFailure('E_BAD_ARGS');
  return null;
}

/** The argv of an admitted read (deploymentReadRefusal answered null).
 * --max-age only when the probe declares observe-max-age; otherwise the argv is the flagless one. */
export function deploymentReadArgv(cli, options) {
  return [...(options.action === 'status' ? ['status'] : ['workspace', 'status']), '--dir', options.context, ...maxAgeArgv(cli.features, options.maxAge), '--json'];
}

/** What the kernel's answer to a read is for its client: `document`, the JSON value it printed, parsed
 * once; `failed`, whether it exited nonzero. → { ok: true, document } | { ok: false, reason }. */
export function deploymentReadAnswer(action, { failed, document }) {
  if (!deploymentRecord(document)) return deploymentFailure('E_CLI_PROTOCOL');
  if (document.schemaVersion === 1 && document.ok === false) {
    const reason = document.error;
    if (!deploymentRecord(reason) || !deploymentErrorCode(reason.code)
      || typeof reason.message !== 'string' || reason.message.length > 8192) return deploymentFailure('E_CLI_PROTOCOL');
    // Only the bounded kernel error envelope, never stderr, argv, stacks or an exec error's message;
    // of `details`, only an unreadable remote's bounded cause (Spec D). A refusal cannot become success.
    // `origin: 'kernel'`: this reason is the one the installed CLI printed in its envelope, so the
    // kernel answered, in its own words. The reader's own failures (`deploymentFailure`: the gate, a
    // timeout, the output limit, a protocol failure, a failed run) carry no origin, and unmarked
    // reads as not the kernel's: who shows a reason decides by where it came from, never by its shape.
    const cause = reason.code === 'E_REMOTE_UNREADABLE' ? remoteFailureCause(reason.details) : null;
    return { ok: false, reason: { code: reason.code, message: reason.message, origin: 'kernel', ...(cause ? { cause } : {}) } };
  }
  if (failed) return deploymentFailure('E_CLI_FAILED');
  if (action === 'status') {
    if (Object.hasOwn(document, 'schemaVersion') || !absolute(document.root) || !Array.isArray(document.agents)) return deploymentFailure('E_CLI_PROTOCOL');
  } else if (document.schemaVersion !== 1 || document.ok !== true || document.result?.workspaceStatusApi !== 1) return deploymentFailure('E_CLI_PROTOCOL');
  return { ok: true, document };
}
