/** Fixed-argv installed-CLI K3 adapter. No kernel import, fallback or raw errors. */
import { withoutControlToken } from "./control-environment.mjs";
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { parseEnvelope, parseRetireEnvelope, execFileInSession } from './cli-adapter.mjs';
import { object, lifecycleOptions, planRevision } from './lifecycle-contract.mjs';
const absolute = v => typeof v === 'string' && isAbsolute(v) && !v.includes('\0');
const key = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const failure = code => ({ schemaVersion: 1, ok: false, error: { code } });
const serverId = v => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
/** Remote reads and plans: ssh's ConnectTimeout (15 s) plus the command. */
export const REMOTE_READ_TIMEOUT = 45_000;
/** A routed command (`server`) is addressed by `--server S --home H` and never carries `--dir`:
 * the kernel sends the registered workspace. `context` is then only this machine's cwd. */
export function lifecycleArgv(options) {
  if (!object(options) || Object.keys(options).some(k => !['operation', 'phase', 'instance', 'home', 'context', 'server', 'choices', 'revision', 'key'].includes(k))) return null;
  const o = options, choices = lifecycleOptions(o.operation, o.choices);
  if (!choices || !['plan', 'apply'].includes(o.phase) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.instance || '')
    || !absolute(o.home) || !absolute(o.context) || (Object.hasOwn(o, 'server') && !serverId(o.server))) return null;
  if (o.phase === 'plan' ? Object.hasOwn(o, 'revision') || Object.hasOwn(o, 'key') : !planRevision(o.revision) || !key(o.key)) return null;
  const args = o.operation === 'stop' ? ['instance', 'stop', o.instance] : ['retire', o.instance];
  if (o.phase === 'plan') args.push('--plan');
  else {
    if (o.operation === 'stop') args.push('--apply');
    args.push('--plan-revision', o.revision, '--idempotency-key', o.key);
    if (o.operation === 'retire' && choices.discardWorktree) args.push('--discard-worktree');
  }
  args.push('--home', o.home, ...(o.server ? ['--server', o.server] : ['--dir', o.context]));
  if (o.operation === 'stop' && !choices.recursive) args.push('--no-recursive');
  args.push('--json'); return args;
}
/** `exec` is a client's own `execFile` (the rule is at cli-adapter.mjs `runJson`).
 * A plan is a read: it runs in the caller's process group, and its deadline (30 s, 45 s routed; `timeout` may
 * shorten it) ends it, as every read ends. An apply is a change: it gets no deadline and runs in a session of
 * its own (`detached: true`; this home's default for it is `execFileInSession`), so neither a deadline nor a
 * signal to the client's group ends it while it works. Its client's boundary decides how long it waits for
 * the answer (instance-lifecycle.mjs), and the child goes on, whatever the client does, until it answers. */
export function cliLifecycle(bin, options, { exec, timeout } = {}) {
  const argv = lifecycleArgv(options);
  if (!absolute(bin) || !argv) return Promise.resolve(failure('E_BAD_ARGS'));
  const apply = options.phase === 'apply', limit = options.server ? REMOTE_READ_TIMEOUT : 30_000;
  const run = exec ?? (apply ? execFileInSession : execFile);
  return new Promise(resolve => {
    try {
      run(bin, argv, { cwd: options.context, env: withoutControlToken(), encoding: 'utf8', shell: false,
        ...(apply ? { detached: true } : { timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, limit) : limit }),
        maxBuffer: (apply ? 4 : 1) * 1024 * 1024 }, (error, stdout) => {
        if (error?.killed) return resolve(failure('E_CLI_TIMEOUT'));
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(failure('E_CLI_OUTPUT_LIMIT'));
        const printed = parseEnvelope(stdout), value = apply && options.operation === 'retire' ? parseRetireEnvelope(stdout) : printed;
        if (!value) return resolve(failure('E_CLI_PROTOCOL'));
        if (error && value.ok !== false) return resolve(failure('E_CLI_FAILED'));
        // Only internal consumers see result/details. They validate/project all
        // data against their admitted target. An error envelope's message is kept, for a
        // local command and a routed one: the boundary shows it only through the display
        // filter, as the refusal's detail. Stderr and the process error never leave here.
        // `origin: 'kernel'`: the error is the one the installed CLI printed in its envelope, so the
        // kernel answered. The adapter's own failures (`failure`) and the error it writes for a raw
        // retire receipt that reports incomplete cleanup (parseRetireEnvelope) carry no origin, and
        // unmarked reads as not the kernel's: a reader decides by where an answer came from, never
        // by its shape.
        if (value.ok) resolve({ schemaVersion: 1, ok: true, result: value.result });
        else resolve({ schemaVersion: 1, ok: false, ...(printed?.ok === false ? { origin: 'kernel' } : {}), ...(value.result ? { result: value.result } : {}),
          error: { code: value.error?.code, message: value.error?.message, details: value.error?.details } });
      });
    } catch { resolve(failure('E_CLI_FAILED')); }
  });
}
