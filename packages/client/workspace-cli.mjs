/** Workspace model v2 verbs the Desktop drives: fixed argv, bounded output,
 * scrubbed instance environment. Only the kernel's JSON crosses back; a
 * refusal is its bounded error envelope (code + message, plus onboarding's
 * rolledBack flag and sync's `why` slug), never stderr, argv, stacks or details objects.
 *   capabilities → `oats capabilities --dir D [--max-age S] --json`  (capabilitiesApi 1)
 *   souls        → `oats souls --dir D [--max-age S] --json`         (soulsApi 1, the spawn catalog)
 *   capability-show → `oats capabilities show NAME (--member KEY | --package ID) [--file PATH]
 *                      --dir D [--max-age S] --json` (capabilityShowApi 1, feature capability-show:
 *                      what one capability ships, read at the commit the catalog reports)
 *   sync         → `oats sync --dir D --json`                (syncApi 1)
 *   onboard      → `oats onboard DIR --workspace REF --json` (onboardApi 2)
 * There is no package approval (packages-no-approval): declaring a package
 * is the trust decision, so every success exits 0. `--max-age` (feature
 * observe-max-age) belongs to the three reads only and reaches argv only when
 * the probe declares the feature; cliWorkspace drops it otherwise. */
import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { OBSERVE_MAX_AGE_FEATURE, validMaxAge } from './deployment-contract.mjs';
import { capabilityShowSupported, validCapabilityName, validPackageId, validRelativePath, validRepoKey } from './capability-show-contract.mjs';
import { cliEnvironment } from './cli-environment.mjs';
import { withoutInstanceVariables } from './kernel-environment.mjs';
import { requireTerms } from './client-terms.mjs';

export const WORKSPACE_READ_TIMEOUT = 60_000;
export const WORKSPACE_WRITE_TIMEOUT = 300_000; // discovery reads every member remote
export const WORKSPACE_MAX_BUFFER = 4 * 1024 * 1024;
export const WORKSPACE_ACTIONS = Object.freeze(['capabilities', 'souls', 'sync', 'onboard', 'capability-show']);
/** The read-only verbs: the ones `--max-age` may reach. */
const READS = ['capabilities', 'souls', 'capability-show'];
/** A refusal's `details.why`, as a client may carry it: a short lower-case slug. */
const WHY_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The kernel line this Desktop drives: workspace model v2 without package approval. */
export const WORKSPACE_FEATURES = Object.freeze(['workspace-v2', 'packages-no-approval']);
const absolute = path => typeof path === 'string' && !path.includes('\0') && isAbsolute(path) && resolve(path) === path;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A repository reference is the kernel's to parse (E_REPO_REF); the Desktop
 * only refuses what could not be one argv value: empty, huge, control
 * characters or an option-looking token. */
export const validWorkspaceRef = ref => typeof ref === 'string' && ref.length > 0 && ref.length <= 2048
  && ref.trim() === ref && !/[\u0000-\u001f\u007f]/.test(ref) && !ref.startsWith('-');

/** The sentence for each failure this adapter raises itself; one names the client, in its terms (client-terms.mjs). */
const messages = Object.freeze({
  E_CLI_UNAVAILABLE: 'Choose a compatible installed OATS CLI first.',
  E_WORKSPACE_FEATURE: terms => `The installed OATS CLI is older than ${terms.self} (it does not advertise workspace-v2 and packages-no-approval). Update OATS and retry.`,
  E_BAD_ARGS: 'The workspace request was not valid.',
  E_CLI_FAILED: 'The installed OATS CLI could not complete this workspace command.',
  E_CLI_PROTOCOL: 'The installed OATS CLI returned an invalid workspace result.',
  E_CLI_TIMEOUT: 'The workspace command exceeded its time limit.',
  E_CLI_OUTPUT_LIMIT: 'The workspace command exceeded its size limit.',
  E_CAPABILITY_SHOW_FEATURE: "The installed OATS CLI can't show what a capability ships. Update OATS and retry.",
});
/** Every code workspaceFailure has a sentence for. */
export const WORKSPACE_FAILURE_CODES = Object.freeze(Object.keys(messages));

export function workspaceFailure(code, terms, message) {
  requireTerms(terms, 'workspaceFailure');
  const known = Object.hasOwn(messages, code) ? code : 'E_CLI_FAILED', fixed = messages[known];
  return { ok: false, reason: { code: known, message: message || (typeof fixed === 'function' ? fixed(terms) : fixed) } };
}

/** Probe facts only (version --json): the API integer and the feature. */
export function workspaceGate(cli, terms) {
  requireTerms(terms, 'workspaceGate');
  if (cli?.ok !== true || !absolute(cli.bin)) return workspaceFailure('E_CLI_UNAVAILABLE', terms);
  if (cli.workspaceApi !== 2 || !Array.isArray(cli.features) || !WORKSPACE_FEATURES.every(name => cli.features.includes(name))) return workspaceFailure('E_WORKSPACE_FEATURE', terms);
  return null;
}

export function workspaceArgv(options) {
  if (!record(options) || !WORKSPACE_ACTIONS.includes(options.action)) return null;
  const { action } = options;
  const allowed = { capabilities: ['action', 'context', 'maxAge'], souls: ['action', 'context', 'maxAge'], sync: ['action', 'context'], onboard: ['action', 'dir', 'workspace'],
    'capability-show': ['action', 'context', 'name', 'member', 'package', 'path', 'maxAge'] }[action];
  if (Object.keys(options).some(key => !allowed.includes(key))) return null;
  if (action === 'onboard') {
    if (!absolute(options.dir) || !validWorkspaceRef(options.workspace)) return null;
    return { argv: ['onboard', options.dir, '--workspace', options.workspace, '--json'], cwd: options.dir, timeout: WORKSPACE_WRITE_TIMEOUT };
  }
  if (!absolute(options.context)) return null;
  if (action === 'capability-show') {
    // Exactly one selector, each value one argv token the kernel parses (never option-looking);
    // the file path is plain, relative and inside the capability (no `..`, no leading `/` or `-`).
    const member = Object.hasOwn(options, 'member'), pkg = Object.hasOwn(options, 'package');
    if (!validCapabilityName(options.name) || member === pkg || !validMaxAge(options.maxAge)) return null;
    if (member ? !validRepoKey(options.member) : !validPackageId(options.package)) return null;
    if (Object.hasOwn(options, 'path') && !validRelativePath(options.path)) return null;
    return { argv: ['capabilities', 'show', options.name, ...(member ? ['--member', options.member] : ['--package', options.package]),
      ...(Object.hasOwn(options, 'path') ? ['--file', options.path] : []), '--dir', options.context,
      ...(options.maxAge === undefined ? [] : ['--max-age', String(options.maxAge)]), '--json'], cwd: options.context, timeout: WORKSPACE_READ_TIMEOUT };
  }
  if (action === 'capabilities' || action === 'souls') {
    if (!validMaxAge(options.maxAge)) return null;
    const maxAge = options.maxAge === undefined ? [] : ['--max-age', String(options.maxAge)];
    return { argv: [action, '--dir', options.context, ...maxAge, '--json'], cwd: options.context, timeout: WORKSPACE_READ_TIMEOUT };
  }
  return { argv: ['sync', '--dir', options.context, '--json'], cwd: options.context, timeout: WORKSPACE_WRITE_TIMEOUT };
}

/** `io.exec` is a client's own `execFile` (the rule is at cli-adapter.mjs `runJson`). */
export function cliWorkspace(cli, options, terms, io = {}) {
  requireTerms(terms, 'cliWorkspace');
  const gate = workspaceGate(cli, terms);
  if (gate) return Promise.resolve(gate);
  // `capabilities show` is its own feature on top of the workspace line (the feature AND the API integer).
  if (record(options) && options.action === 'capability-show' && !capabilityShowSupported(cli)) return Promise.resolve(workspaceFailure('E_CAPABILITY_SHOW_FEATURE', terms));
  // An invalid value is a bad request whatever the kernel. A valid one on a kernel without
  // observe-max-age names a flag that does not exist there: drop it (on a copy; the caller's
  // request is not ours to edit) so the read runs flagless. Only the reads take it, so the
  // drop never lets a mutating verb past workspaceArgv's allowlist.
  if (record(options) && Object.hasOwn(options, 'maxAge')) {
    if (!validMaxAge(options.maxAge)) return Promise.resolve(workspaceFailure('E_BAD_ARGS', terms));
    if (!cli.features.includes(OBSERVE_MAX_AGE_FEATURE) && READS.includes(options.action)) { const { maxAge, ...rest } = options; options = rest; }
  }
  const plan = workspaceArgv(options);
  if (!plan) return Promise.resolve(workspaceFailure('E_BAD_ARGS', terms));
  const env = withoutInstanceVariables(cliEnvironment(io.env ?? process.env)); // main's own environment is not cleaned; in the backend this changes nothing
  return new Promise(done => {
    const fail = code => done(workspaceFailure(code, terms));
    try {
      (io.exec ?? execFile)(cli.bin, plan.argv, { cwd: plan.cwd, env, shell: false, encoding: 'utf8', timeout: plan.timeout, maxBuffer: WORKSPACE_MAX_BUFFER }, (error, stdout) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail('E_CLI_OUTPUT_LIMIT');
        if (error?.killed) return fail('E_CLI_TIMEOUT');
        if (typeof stdout !== 'string') return fail(error ? 'E_CLI_FAILED' : 'E_CLI_PROTOCOL');
        if (Buffer.byteLength(stdout, 'utf8') > WORKSPACE_MAX_BUFFER) return fail('E_CLI_OUTPUT_LIMIT');
        let document;
        try { document = JSON.parse(stdout); } catch { return fail(error ? 'E_CLI_FAILED' : 'E_CLI_PROTOCOL'); }
        if (!record(document) || document.schemaVersion !== 1 || typeof document.ok !== 'boolean') return fail('E_CLI_PROTOCOL');
        if (document.ok === false) {
          const reason = document.error;
          if (!record(reason) || typeof reason.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(reason.code)
            || typeof reason.message !== 'string' || reason.message.length > 8192) return fail('E_CLI_PROTOCOL');
          // A refusal cannot become success, and a success exit cannot carry one.
          if (!error) return fail('E_CLI_PROTOCOL');
          const out = { code: reason.code, message: reason.message };
          if (options.action === 'onboard' && reason.details?.rolledBack === true) out.rolledBack = true;
          // Which case of a shared code (E_PACKAGE_INTEGRITY's branch, package-id, …): data a client words, never prose.
          if (options.action === 'sync' && typeof reason.details?.why === 'string' && WHY_RE.test(reason.details.why)) out.why = reason.details.why;
          return done({ ok: false, reason: out });
        }
        if (error) return fail('E_CLI_FAILED'); // success is exit 0 only
        done({ ok: true, document });
      });
    } catch { fail('E_CLI_FAILED'); }
  });
}
