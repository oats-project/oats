/** Fixed read-only API2 argv. Never dispatch API1 or fall back to spawn. */
import { withoutControlToken } from "./control-environment.mjs";
import { execFile } from 'node:child_process';
import { parseEnvelope, writeTaskFile } from './cli-adapter.mjs';
import { previewChoices, previewTarget, previewSupported, previewFailure, choiceArgv, suggestSupported, suggestTask, absolute,
  instanceSuggestSupported, instanceSuggestRequest, instanceSuggestion } from './spawn-preview-contract.mjs';
/** A refusal, in the kernel's own shape (`{ code, message, details: { fix } }`). `previewFailure` decides what of the
 *  kernel's travels: its message when that is printable and within the bound, and its `fix` only beside that message.
 *  No other key of `details` travels. */
function failure(code, message, kernelFix) {
  const { fix, ...error } = previewFailure(code, null, message, kernelFix).reason;
  return { schemaVersion: 1, ok: false, error: fix === undefined ? error : { ...error, details: { fix } } };
}
/** `io.exec` is a client's own `execFile` (the rule is at cli-adapter.mjs `runJson`).
 *  With `task`, the read is a suggest read (feature spawn-suggest-name, awebai/oats#1421 §3): `--suggest-name` with the
 *  task in a private temporary `--task-file` (as the apply passes it), removed on every path, and never with a name or a
 *  purpose. `signal` ends it: the CLI gets SIGTERM, which ends the kernel's naming call with it, and the read answers
 *  `E_SUPERSEDED`. */
export function cliSpawnPreview(cli, options = {}, io = {}) {
  // Defense at the actual exec owner as well as at HTTP admission.
  if (!previewSupported(cli)) return Promise.resolve(failure('E_PREVIEW_UNAVAILABLE'));
  const target = previewTarget(options.target), choices = previewChoices(options.choices);
  if (!target || !choices || Object.keys(options).some(k => !['target', 'choices', 'maxAge', 'task', 'signal'].includes(k))) return Promise.resolve(failure('E_BAD_ARGS'));
  const suggest = options.task !== undefined;
  if (suggest && !suggestSupported(cli)) return Promise.resolve(failure('E_PREVIEW_UNAVAILABLE'));
  if (suggest && (!suggestTask(options.task) || choices.name !== undefined || choices.purpose !== undefined)) return Promise.resolve(failure('E_BAD_ARGS'));
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.resolve(failure('E_BAD_ARGS'));
  if (signal?.aborted) return Promise.resolve(failure('E_SUPERSEDED'));
  // Feature spawn-preview-max-age: reuse member heads the kernel observed within maxAge seconds. Only
  // where the CLI advertises it (an older kernel refuses the flag); prepare never passes it. The apply's own
  // --max-age is spawn-apply-max-age's (spawn-apply-cli.mjs).
  const maxAge = options.maxAge;
  if (maxAge !== undefined && (!Number.isInteger(maxAge) || maxAge < 1 || maxAge > 3600)) return Promise.resolve(failure('E_BAD_ARGS'));
  const reuse = maxAge !== undefined && Array.isArray(cli.features) && cli.features.includes('spawn-preview-max-age') ? ['--max-age', String(maxAge)] : [];
  let taskFile = null;
  if (suggest) { try { taskFile = writeTaskFile(options.task, io); } catch { return Promise.resolve(failure('E_CLI_FAILED')); } }
  const naming = taskFile ? ['--suggest-name', '--task-file', taskFile.file] : [];
  const argv = ['spawn', target.selector.soul, '--dir', target.context, '--agents-root', target.selector.agentsRoot, '--preview', ...naming, ...choiceArgv(choices, cli), ...reuse, '--json'];
  const env = withoutControlToken(io.env);
  for (const k of ['PI_AGENTS_ROOT', 'OATS_DEPLOYMENT', 'OATS_RESOLUTION', 'OATS_PREVIEW_PREFLIGHT_BUDGET_MS']) delete env[k];
  return new Promise(done => {
    const resolve = v => { taskFile?.cleanup(); done(v); };
    try {
      (io.exec ?? execFile)(cli.bin, argv, { cwd: target.context, env, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) }, (err, stdout) => {
        if (err?.name === 'AbortError' || signal?.aborted) return resolve(failure('E_SUPERSEDED'));
        if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(failure('E_CLI_OUTPUT_LIMIT'));
        if (err?.killed) return resolve(failure('E_CLI_TIMEOUT'));
        const doc = parseEnvelope(stdout);
        if (doc?.ok === false) return resolve(failure(doc.error?.code, doc.error?.message, doc.error?.details?.fix));
        if (err) return resolve(failure('E_CLI_FAILED'));
        resolve(doc?.ok === true ? doc : failure('E_CLI_PROTOCOL'));
      });
    } catch { resolve(failure('E_CLI_FAILED')); }
  });
}

/** `oats instance suggest-name` (feature instance-suggest-name, awebai/oats#1490 §2): a name for a spawn on another
 *  machine, chosen here through this computer's harness and model. `request` is the dialog's (instanceSuggestRequest),
 *  `dir` the local deployment whose launch configurations the kernel reads. The task travels in a private temporary
 *  `--task-file`, removed on every path; never `--launch-config` (the dialog's configurations are the host's) and never
 *  `--server` (the kernel refuses it: the name is decided here). `signal` ends it as it ends a suggest read. Answers the
 *  kernel's envelope with its result re-validated (instanceSuggestion), or a failure in the kernel's shape. */
export function cliInstanceSuggestName(cli, { request, dir, signal } = {}, io = {}) {
  if (!instanceSuggestSupported(cli)) return Promise.resolve(failure('E_UNSUPPORTED_OPTION'));
  const asked = instanceSuggestRequest(request);
  if (!asked || !absolute(dir) || signal !== undefined && !(signal instanceof AbortSignal)) return Promise.resolve(failure('E_BAD_ARGS'));
  if (signal?.aborted) return Promise.resolve(failure('E_SUPERSEDED'));
  let taskFile;
  try { taskFile = writeTaskFile(asked.task, io); } catch { return Promise.resolve(failure('E_CLI_FAILED')); }
  const argv = ['instance', 'suggest-name', '--soul', asked.soul, '--task-file', taskFile.file,
    ...(asked.harness ? ['--harness', asked.harness] : []), ...(asked.model ? ['--model', asked.model] : []), '--dir', dir, '--json'];
  const env = withoutControlToken(io.env);
  for (const k of ['PI_AGENTS_ROOT', 'OATS_DEPLOYMENT', 'OATS_RESOLUTION', 'OATS_PREVIEW_PREFLIGHT_BUDGET_MS']) delete env[k];
  return new Promise(done => {
    const resolve = v => { taskFile.cleanup(); done(v); };
    try {
      // The kernel bounds its call at 20 s (NAMING_TIMEOUT_MS) and its output at 4 KiB; this deadline adds the process's own start.
      (io.exec ?? execFile)(cli.bin, argv, { cwd: dir, env, shell: false, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) }, (err, stdout) => {
        if (err?.name === 'AbortError' || signal?.aborted) return resolve(failure('E_SUPERSEDED'));
        if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve(failure('E_CLI_OUTPUT_LIMIT'));
        if (err?.killed) return resolve(failure('E_CLI_TIMEOUT'));
        const doc = parseEnvelope(stdout);
        if (doc?.ok === false) return resolve(failure(doc.error?.code, doc.error?.message, doc.error?.details?.fix));
        if (err) return resolve(failure('E_CLI_FAILED'));
        const result = doc?.ok === true ? instanceSuggestion(doc.result) : null;
        resolve(result ? { schemaVersion: 1, ok: true, result } : failure('E_CLI_PROTOCOL'));
      });
    } catch { resolve(failure('E_CLI_FAILED')); }
  });
}
