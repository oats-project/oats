// OATS desktop — CLI JSON v1 adapter (the ONLY mutation path).
// Read-only K1 Git reads also use this adapter, with strict read exits.
//
// Runs the two Desktop v1 mutations through a discovered absolute `oats`
// binary via execFile/argv — never a shell, never kernel imports:
//
//   1. oats spawn <agent> --dir <workspace> --task-file <0600-temp>
//      [allowlisted purpose/repo/work/harness/model args] --json
//   2. oats operation run <layer>:<operation> --home <resolved home> --json
//
// JSON mode emits exactly one stdout object (progress goes to stderr):
//   success:  {"schemaVersion":1,"ok":true,"result":{...}}
//   failure:  {"schemaVersion":1,"ok":false,"error":{"code","message"}}
//
// SECURITY:
//   * The task text is user input destined for a file the spawned agent
//     reads. It is written to a mkdtemp-owned file created 0600 (mode set at
//     open, not chmod-after) so no other local user can read a task that may
//     contain secrets; the temp dir is removed after the CLI returns.
//   * Spawn argv is an ALLOWLIST — purpose/repo/work/harness/model only,
//     values passed as separate argv entries (no interpolation). Anything
//     else the renderer sends is dropped, never forwarded.
//   * A provider operation names its instance by --home: the home of
//     exactly one row the server reports (packages/desktop/server/capabilities.mjs), never
//     a caller path.
import { withoutControlToken } from "./control-environment.mjs";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gitFileId, gitRevision, gitIndexRevision, gitObservation } from './instance-git-contract.mjs';
import { validMaxAge, maxAgeArgv } from './deployment-contract.mjs';
import { MACHINE_ID, machineFieldProblem } from './machine-contract.mjs';
import { kernelMade } from './kernel-made.mjs';
import { SOUL_COLORS } from './soul-colors.mjs';
import { NAMING_TIMEOUT_MS } from './spawn-preview-contract.mjs';

const ENVELOPE_TIMEOUT_MS = 60_000;

/** Parse the single-JSON-object stdout contract; null when contaminated.
 * The error of an `ok: false` envelope is marked the kernel's here (kernel-made.mjs), where the CLI's
 * answer is parsed and nowhere else: an envelope a reader writes itself (a timeout, a protocol failure,
 * `parseRetireEnvelope`'s incomplete cleanup) is never parsed, so its error carries no mark. */
export function parseEnvelope(stdout) {
  try {
    const doc = JSON.parse(String(stdout));
    if (!doc || typeof doc !== "object" || doc.schemaVersion !== 1) return null;
    if (doc.ok === true && doc.result && typeof doc.result === "object") return doc;
    if (doc.ok === false && doc.error && typeof doc.error === "object") { kernelMade(doc.error); return doc; }
    return null;
  } catch { return null; }
}

/** Allowlisted optional spawn args → argv pairs. Unknown keys are DROPPED.
 * SECURITY (review 53a20c7): values are also SHAPE-VALIDATED — the CLI
 * parser scans raw argv with includes()/indexOf(), so an option-shaped
 * value like purpose="--no-launch" would inject a real non-allowlisted
 * token. Reject any value with a leading '-'; constrain each field to its
 * domain. Rejection THROWS (E_BAD_ARGS shape) so a hostile value can never
 * silently degrade into different spawn behavior. */
const SPAWN_ARG_RULES = {
  purpose: { flag: "--purpose", re: /^[a-z0-9][a-z0-9-]*$/i },              // instance-name slug
  // The exact instance name (feature spawn-name): the kernel's instance-name grammar, lowercase,
  // used as given; the kernel refuses the rest of its rule itself (E_INSTANCE_NAME_INVALID). Never with a purpose.
  name:    { flag: "--name",    re: /^[a-z0-9][a-z0-9-]*$/ },
  repo:    { flag: "--repo",    re: /^[^-][^\0]*$/ },                       // path — anything not option-shaped
  work:    { flag: "--work",    re: /^(worktree|checkout|attached|workspace|directory)$/ },
  backend: { flag: "--backend", re: /^tmux$/ },
  // The flag is the kernel's (harness-names.mjs harnessFlag): the caller names it, never guessed.
  harness: { flag: null, re: /^(pi|claude|codex)$/ },
  // A configuration's name, or the word that selects none (launch-contract.mjs LAUNCH_CONFIG_NONE), which this rule admits.
  launchConfig: { flag: "--launch-config", re: /^[a-z0-9][a-z0-9._-]*$/i },
  server:  { flag: "--server",  re: /^[a-z0-9][a-z0-9-]{0,63}$/ },          // registered server id (remote route)
  model:   { flag: "--model",   re: /^[^-][^\0]*$/ },                       // model pattern — not option-shaped
  // Spawn-time agent relations (feature/agent-relations): the kernel links
  // the new instance to an existing one. "unrelated" is the default and is
  // NEVER forwarded — the CLI treats absence as unrelated.
  relation:   { flag: "--relation",    re: /^(child|sibling|parent)$/ },
  relativeTo: { flag: "--relative-to", re: /^[a-z0-9][a-z0-9._-]*$/i },     // instance-name slug
  // Anchor disambiguation (kernel contract addition): the agents root the
  // anchor homes in. Names shadow across roots, so the desktop ALWAYS sends
  // the pair when it spawns related — path-shaped, never option-shaped.
  relativeRoot: { flag: "--relative-root", re: /^[^-][^\0]*$/ },
};
export function spawnArgv(agent, workspaceDir, taskFile, opts = {}) {
  const agentName = String(agent);
  if (agentName.startsWith("-")) { const e = new Error(`invalid agent name "${agentName}"`); e.code = "E_BAD_ARGS"; throw e; }
  // Relation flags travel as a PAIR: a relation needs a reference instance
  // and a reference instance is meaningless without a relation. "unrelated"
  // normalizes to absence before the pairing check.
  if (opts.relation === "unrelated" || opts.relation === "") opts = { ...opts, relation: undefined };
  const hasRelation = opts.relation !== undefined && opts.relation !== null;
  const hasRef = opts.relativeTo !== undefined && opts.relativeTo !== null && opts.relativeTo !== "";
  if (hasRelation !== hasRef) {
    const e = new Error(hasRelation
      ? "a relation requires --relative-to <instance>"
      : "--relative-to requires a relation (child|sibling|parent)");
    e.code = "E_BAD_ARGS"; throw e;
  }
  // A name is the instance's whole name; a purpose is the part after `<soul>-`: one or the other.
  const given = v => v !== undefined && v !== null && v !== "";
  if (given(opts.name) && given(opts.purpose)) { const e = new Error("a spawn takes --name or --purpose, not both"); e.code = "E_BAD_ARGS"; throw e; }
  // --suggest-name on an apply (feature spawn-apply-suggest-name): the machine that spawns names it from its task, so
  // never beside a name or a purpose.
  if (opts.suggestName !== undefined && typeof opts.suggestName !== "boolean") throw Object.assign(new Error("suggestName must be a boolean"), { code: "E_BAD_ARGS" });
  if (opts.suggestName && (given(opts.name) || given(opts.purpose))) throw Object.assign(new Error("--suggest-name chooses the name: it takes no --name or --purpose"), { code: "E_BAD_ARGS" });
  // relativeRoot rides along with the pair only — alone it is meaningless
  if (!hasRef && opts.relativeRoot !== undefined && opts.relativeRoot !== null && opts.relativeRoot !== "") {
    const e = new Error("--relative-root requires --relation and --relative-to");
    e.code = "E_BAD_ARGS"; throw e;
  }
  // A remote route takes its workspace from the server registration; the
  // kernel refuses --dir with --server, so it is omitted here.
  const argv = opts.server
    ? ["spawn", agentName, "--task-file", String(taskFile)]
    : ["spawn", agentName, "--dir", String(workspaceDir), "--task-file", String(taskFile)];
  for (const [key, rule] of Object.entries(SPAWN_ARG_RULES)) {
    const v = opts[key];
    if (v === undefined || v === null || v === "") continue;
    const s = String(v);
    if (!rule.re.test(s)) { const e = new Error(`invalid ${key} value`); e.code = "E_BAD_ARGS"; throw e; }
    argv.push(key === "harness" ? flagFor(opts.harnessFlag) : rule.flag, s);
  }
  if (opts.yolo !== undefined) {
    if (typeof opts.yolo !== "boolean") throw Object.assign(new Error("yolo must be a boolean"), { code: "E_BAD_ARGS" });
    argv.push(opts.yolo ? "--yolo" : "--no-yolo");
  }
  // Run in background (feature instance-background, #1579): the instance's own flag, as the soul's default or not.
  if (opts.background !== undefined) {
    if (typeof opts.background !== "boolean") throw Object.assign(new Error("background must be a boolean"), { code: "E_BAD_ARGS" });
    argv.push(opts.background ? "--background" : "--no-background");
  }
  if (opts.suggestName) argv.push("--suggest-name");
  argv.push("--json");
  return argv;
}

/** Write task text to a fresh 0600 file inside a private mkdtemp dir.
 * Returns { file, cleanup } — callers MUST call cleanup() when done. */
export function writeTaskFile(taskText, io = {}) {
  const mkdtemp = io.mkdtempSync || mkdtempSync;
  const open = io.openSync || openSync;
  const write = io.writeSync || writeSync;
  const close = io.closeSync || closeSync;
  const rm = io.rmSync || rmSync;
  const dir = mkdtemp(join(io.tmpdir ? io.tmpdir() : tmpdir(), "oats-desktop-task-"));
  const file = join(dir, "TASK.md");
  const cleanup = () => { try { rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ } };
  try {
    const fd = open(file, "wx", 0o600); // create-exclusive, owner-only from birth
    try {
      const text = String(taskText ?? "");
      if (write(fd, text) !== Buffer.byteLength(text)) throw Object.assign(new Error('Could not write the complete private instruction file'), { code: 'E_INPUT_PREPARATION' });
    } finally { close(fd); }
  } catch (error) { cleanup(); throw error; } // construction failure must not orphan private input
  return { file, cleanup };
}

/** A client's own `exec`: `io.exec` on every kernel caller of this home (`exec` in the third argument
 * of lifecycle-cli.mjs `cliLifecycle`), in place of `execFile`. It has `execFile`'s signature,
 * `(bin, argv, options, callback)`, and its return, the child (spawn-apply-cli.mjs ends a spawn it
 * owns through it). It passes the options through as given (cwd, env, timeout, maxBuffer, no shell)
 * and calls back with `execFile`'s own error: every caller tells a timeout by `error.killed` and an
 * overflow by `error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, so an `exec` that wraps or
 * replaces that error turns both into a plain failure.
 * `detached: true` is given for a stop or retire apply and for a start: the child must run in a session of
 * its own, so a signal to the client's process group (a Ctrl-C, a hang-up) never reaches it (a killed stop
 * strands its home on a kernel before 0.52.0; a killed start can leave its lock, #889). An `exec` must start
 * such a child that way and never drop the option: `execFile` itself does not honour it (it passes spawn a
 * fixed list of options), so this home's own default for it is `execFileInSession`. Such a child is given no
 * deadline (`timeout: 0`, the default of an apply): execFileInSession arms its kill only for a positive one,
 * and the caller's own wait ends instead (cliStart's START_WAIT_MS; instance-lifecycle.mjs APPLY_WAIT_MS). */
/** What a kernel answer may print, bytes of stdout: every read but a soul inspection that carries its skills' text. */
export const ENVELOPE_MAX_BUFFER = 4 * 1024 * 1024;
/** A soul inspection with `--skills` and/or `--composed-skills`: their texts' budgets (1 MiB and 2 MiB of UTF-8,
 * docs/desktop-cli-api.md) as JSON may print them, six bytes a byte (the kernel reads a control character as text,
 * and JSON escapes it as `\u0001`): 18 MiB, beside the two AGENTS.md (200,000 characters each, sixfold too) and the
 * rest of the answer, with room to spare. */
export const SKILLS_INSPECT_MAX_BUFFER = 32 * 1024 * 1024;

function runJson(bin, argv, { cwd, exec, timeout = ENVELOPE_TIMEOUT_MS, parse = parseEnvelope, strictExit = false, detached = false, maxBuffer = ENVELOPE_MAX_BUFFER } = {}) {
  const run = exec ?? (detached ? execFileInSession : execFile);
  return new Promise((resolveP, rejectP) => {
    try {
      run(bin, argv, { cwd, env: withoutControlToken(), encoding: "utf8", timeout, maxBuffer, shell: false, ...(detached ? { detached: true } : {}) },
        (err, stdout) => {
          // New reads require a clean exit for success. Keep the historical
          // envelope-wins policy for existing mutations unless opted in.
          if (strictExit && err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolveP(readError("E_CLI_OUTPUT_LIMIT"));
          if (strictExit && err?.killed) return resolveP(readError("E_CLI_TIMEOUT"));
          const doc = parse(stdout);
          if (strictExit && err && doc?.ok !== false) return resolveP(readError("E_CLI_FAILED"));
          if (doc) return resolveP(doc); // a nonzero exit may still carry ok:false
          if (err && err.killed) {
            return resolveP({ schemaVersion: 1, ok: false, error: { code: "E_CLI_TIMEOUT", message: `oats did not answer within ${timeout / 1000}s` } });
          }
          return resolveP({
            schemaVersion: 1, ok: false,
            error: { code: "E_CLI_PROTOCOL", message: "oats did not print a valid JSON envelope on stdout" },
          });
        });
    } catch (e) {
      if (strictExit) resolveP(readError("E_CLI_FAILED"));
      else rejectP(e);
    }
  });
}

// Only these diagnostics cross the new read boundary. Neither stderr, thrown
// exception text nor free-form CLI error messages are suitable UI diagnostics.
const READ_ERRORS = {
  E_BAD_ARGS: "Invalid CLI read arguments",
  E_CLI_FAILED: "The installed OATS CLI could not complete this read",
  E_CLI_PROTOCOL: "The installed OATS CLI returned an invalid read response",
  E_CLI_TIMEOUT: "The installed OATS CLI read timed out",
  E_CLI_OUTPUT_LIMIT: "The installed OATS CLI read exceeded the output limit",
  E_USAGE: "The installed OATS CLI does not support this read command",
};
function readError(code) {
  if (!Object.hasOwn(READ_ERRORS, code)) code = "E_CLI_FAILED";
  return { schemaVersion: 1, ok: false, error: { code, message: READ_ERRORS[code] } };
}
const readObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const absoluteReadPath = value => typeof value === "string" && isAbsolute(value) && !value.includes("\0");

const GIT_READ_ERRORS = {
  E_BAD_ARGS: 'Invalid instance Git read arguments',
  E_GIT_FAILED: 'The installed OATS CLI could not read this Git worktree',
  E_NO_WORKTREE: 'This instance has no available Git worktree',
  E_SESSION_UNKNOWN: 'The instance is no longer available; refresh the roster',
  E_AMBIGUOUS_INSTANCE: 'The instance is ambiguous; select a uniquely reported instance',
  E_HOME_MISMATCH: 'The selected instance address no longer matches',
  E_STALE_OBSERVATION: 'The worktree observation changed; re-observe before selecting a diff',
  'unsupported-action': 'This CLI does not support Git inspection for this captured target',
};
export function gitReadFailure(code, details) {
  const error = Object.hasOwn(GIT_READ_ERRORS, code) ? { code, message: GIT_READ_ERRORS[code] } : readError(code).error;
  const observation = code === 'E_STALE_OBSERVATION' && gitObservation(details?.observation);
  return { schemaVersion: 1, ok: false, error: { ...error, ...(observation ? { details: { observation } } : {}) } };
}

/** K1 read adapter. Not a roster resolver: only the server boundary may supply
 * the instance/home/context triple. The boundary requires the hardened K1
 * contract. No direct Git command or renderer path arguments. */
/** A remote read's CLI deadline: ssh's ConnectTimeout (15 s) plus the command. */
export const REMOTE_GIT_TIMEOUT = 45_000;
export async function cliInstanceGit(bin, options = {}, io = {}) {
  try {
    // `server`: a remote row, sent as `--server S --home H` (no --dir); `context` is then this machine's cwd.
    const base = ['action', 'instance', 'context', 'home', 'server'];
    const diff = options?.action === 'diff';
    const allowed = diff ? [...base, 'fileId', 'revision', 'indexRevision'] : base;
    if (!absoluteReadPath(bin) || !readObject(options) || !['git', 'diff'].includes(options.action)
      || Object.keys(options).some(k => !allowed.includes(k))
      || typeof options.instance !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.instance)
      || !absoluteReadPath(options.context) || !absoluteReadPath(options.home)
      || (Object.hasOwn(options, 'server') && (typeof options.server !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.server)))
      || (diff && (!gitFileId(options.fileId) || !gitRevision(options.revision) || !gitIndexRevision(options.indexRevision)))) return gitReadFailure('E_BAD_ARGS');
    const remote = Object.hasOwn(options, 'server');
    const argv = ['instance', options.action, options.instance, ...(remote ? ['--server', options.server] : ['--dir', options.context]), '--home', options.home];
    if (diff) argv.push('--file', options.fileId, '--revision', options.revision, '--index-revision', options.indexRevision);
    argv.push('--json');
    const limit = remote ? REMOTE_GIT_TIMEOUT : 15_000;
    const timeout = Number.isFinite(io.timeout) && io.timeout > 0 ? Math.min(io.timeout, limit) : limit;
    const result = await runJson(bin, argv, { cwd: options.context, exec: io.exec, timeout, strictExit: true });
    if (result.ok) return result;
    // A host's refusal keeps its own code and message (the boundary bounds and shows them); this machine's own failures do not.
    if (remote && !Object.hasOwn(READ_ERRORS, result.error?.code) && result.error?.code !== 'E_STALE_OBSERVATION') return { schemaVersion: 1, ok: false, error: { code: result.error?.code, message: result.error?.message } };
    return gitReadFailure(result.error?.code, result.error?.details);
  } catch { return gitReadFailure('E_CLI_FAILED'); }
}

/**
 * Desktop v1 spawn. `bin` is the discovered absolute CLI; `workspaceDir` the
 * validated workspace context (--dir); `opts` allowlisted extras.
 * Domain results RESOLVE (never reject) with the envelope — stable codes.
 */
export async function cliSpawn(bin, { agent, workspaceDir, task, ...opts }, io = {}) {
  let argv;
  let wake;
  try {
    argv = spawnArgv(agent, workspaceDir, "__TASKFILE__", opts);
    if (opts.wake !== undefined) {
      const value = opts.wake;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || !["cron", "tz", "message"].every(k => typeof value[k] === "string" && value[k].trim() && !value[k].includes("\0"))
        || (value.enabled !== undefined && typeof value.enabled !== "boolean")) {
        throw Object.assign(new Error("Specify the wake cron, time zone, and message"), { code: "E_BAD_ARGS" });
      }
      wake = { cron: value.cron, tz: value.tz, message: value.message, enabled: value.enabled ?? true };
    }
  }
  catch (e) {
    // Validation failures resolve as domain errors (stable codes), never throw
    // — the endpoint maps them like CLI envelope failures.
    return { schemaVersion: 1, ok: false, error: { code: e.code || "E_BAD_ARGS", message: e.message } };
  }
  // An empty opening instruction on a server spawn travels as no task at all: the routed spawn
  // refuses an empty task file, and no task is what a local empty spawn amounts to.
  let cleanup = () => {};
  if (opts.server && !String(task ?? "").trim()) argv.splice(argv.indexOf("--task-file"), 2);
  else {
    const written = writeTaskFile(task ?? "", io); cleanup = written.cleanup;
    // Replace the placeholder POSITIONALLY — the slot after --task-file —
    // never by value search: an agent literally named "__TASKFILE__" would
    // occupy an earlier argv slot and indexOf would clobber the agent name
    // instead (review 0b83988).
    argv[argv.indexOf("--task-file") + 1] = written.file;
  }
  let wakeFile;
  try {
    if (wake) { wakeFile = writeTaskFile(JSON.stringify(wake), io); argv.push("--wake-file", wakeFile.file); }
    // An apply that names its instance makes the kernel's naming call first: its deadline allows for it.
    const timeout = io.timeout ?? (opts.suggestName ? ENVELOPE_TIMEOUT_MS + NAMING_TIMEOUT_MS : undefined);
    return await runJson(bin, argv, { cwd: workspaceDir, exec: io.exec, timeout });
  } finally { wakeFile?.cleanup(); cleanup(); }
}

/** Registered servers, from the CLI's registry (`oats server list --json`). */
export function cliServers(bin, io = {}) {
  return runJson(bin, ["server", "list", "--json"], { cwd: io.cwd || process.cwd(), exec: io.exec, timeout: io.timeout });
}

/* A workspace's own machines (#517): check, remove, connect and the messaging step, argv only.
 * Every value is held to the kernel's own rules first; nothing option-shaped reaches the CLI. */
const MACHINE_CHECK_TIMEOUT_MS = 60_000;
const SERVER_CONNECT_TIMEOUT_MS = 15 * 60_000; // may install OATS and clone on the host
const AWEB_CONNECT_TIMEOUT_MS = 5 * 60_000;
const badMachineArgs = () => ({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid machine arguments" } });

/** `oats server check <id> --json`: reachability, the host's version and (servers-per-workspace) its key. */
export function cliServerCheck(bin, id, io = {}) {
  if (typeof id !== "string" || !MACHINE_ID.test(id)) return Promise.resolve(badMachineArgs());
  return runJson(bin, ["server", "check", id, "--json"], { cwd: io.cwd || process.cwd(), exec: io.exec, timeout: io.timeout || MACHINE_CHECK_TIMEOUT_MS });
}
/** `oats server remove <id> --json`. */
export function cliServerRemove(bin, id, io = {}) {
  if (typeof id !== "string" || !MACHINE_ID.test(id)) return Promise.resolve(badMachineArgs());
  return runJson(bin, ["server", "remove", id, "--json"], { cwd: io.cwd || process.cwd(), exec: io.exec, timeout: io.timeout });
}
/** `oats session inspect --home <home> --json` on this computer (#1569): the kernel's observation of an
 * instance's terminal, whose `paneId` is the agent's pane by the kernel's own rule, in a window of one pane
 * or several. A clean exit is required for success (`strictExit`). */
export function cliSessionInspect(bin, { home } = {}, io = {}) {
  if (typeof bin !== "string" || !isAbsolute(bin) || typeof home !== "string" || !isAbsolute(home) || home.includes("\0")) {
    return Promise.resolve({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid inspect home" } });
  }
  return runJson(bin, ["session", "inspect", "--home", home, "--json"], { cwd: io.cwd || process.cwd(), exec: io.exec, timeout: io.timeout || 15_000, strictExit: true });
}
/** `oats server forget <server> --instance <instance> --json` (#1131): drop this computer's saved route to a
 * remote instance its host no longer lists. Both values are one roster row's identity, each one argv entry,
 * never option-shaped. A clean exit is required for success (`strictExit`): an answer the CLI did not finish
 * printing is the adapter's own error, never the kernel's. */
export function cliServerForget(bin, { server, instance } = {}, io = {}) {
  if (!argText(server, 256) || !argText(instance, 256)) return Promise.resolve({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid forget arguments" } });
  return runJson(bin, ["server", "forget", server, "--instance", instance, "--json"], { cwd: io.cwd || process.cwd(), exec: io.exec, timeout: io.timeout || 15_000, strictExit: true });
}
/** `oats server connect <id> --ssh <host> --dir <folder on the host> [--install-oats] --json`, in the deployment's scope. */
export function cliServerConnect(bin, { id, host, folder, installOats, workspaceDir }, io = {}) {
  if (machineFieldProblem({ id, host, folder }) || !absoluteReadPath(workspaceDir)) return Promise.resolve(badMachineArgs());
  const argv = ["server", "connect", id, "--ssh", host, "--dir", folder, ...(installOats === true ? ["--install-oats"] : []), "--json"];
  return runJson(bin, argv, { cwd: workspaceDir, exec: io.exec, timeout: io.timeout || SERVER_CONNECT_TIMEOUT_MS });
}
/** `oats aweb connect <id> --install-aw --json` (oats.aweb), in the deployment's scope. */
export function cliAwebConnect(bin, { id, workspaceDir }, io = {}) {
  if (typeof id !== "string" || !MACHINE_ID.test(id) || !absoluteReadPath(workspaceDir)) return Promise.resolve(badMachineArgs());
  return runJson(bin, ["aweb", "connect", id, "--install-aw", "--json"], { cwd: workspaceDir, exec: io.exec, timeout: io.timeout || AWEB_CONNECT_TIMEOUT_MS });
}

/** Schedule definitions travel as private JSON files, never shell text. */
export async function cliSchedule(bin, { operation, id, spec, workspaceDir, server }, io = {}) {
  // Reading, enable/disable and run are cliAutomation's (the kernel's automations verbs).
  const actions = new Set(["add", "update", "remove", "reconcile", "host-install", "host-uninstall", "host-status"]);
  const writes = operation === "add" || operation === "update";
  const needsId = actions.has(operation) && !operation.startsWith("host-");
  if (!actions.has(operation) || (needsId && (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)))
    || (server !== undefined && (typeof server !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(server)))
    || typeof workspaceDir !== "string" || !workspaceDir.startsWith("/") || workspaceDir.includes("\0")
    || (writes && (!spec || typeof spec !== "object" || Array.isArray(spec)))) {
    return { schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid schedule operation or definition" } };
  }
  const argv = ["schedule", ...operation.split("-")];
  if (needsId) argv.push(id);
  const temporary = writes ? writeTaskFile(JSON.stringify({ ...spec, id }), io) : null;
  if (temporary) argv.push("--file", temporary.file);
  argv.push(...(server ? ["--server", server] : ["--dir", workspaceDir]), "--json");
  try { return await runJson(bin, argv, { cwd: workspaceDir, exec: io.exec, timeout: io.timeout }); }
  finally { temporary?.cleanup(); }
}

/** Workspace + local triggers and schedules (feature automations, automationsApi 1): the
 * kernel's own lists and verbs, argv only. `id` is a qualified id (`local/<id>`,
 * `<member>/<id>`) or a bare local id; nothing option-shaped reaches the CLI. `describe`
 * (feature automation-descriptions) is `<kind> update <local id> --description=<text>`: a
 * local item only, the summary as ONE `=` token so a `-`-led value never becomes a flag. */
// `list` takes no id; `status` takes an optional one (a trigger's fire history); the rest need one.
export const AUTOMATION_VERBS = Object.freeze({ trigger: ["list", "status", "enable", "disable", "test", "describe"], schedule: ["list", "enable", "disable", "test", "run", "reconcile", "describe"] });
const ID_OPTIONAL = new Set(["status"]);
export const AUTOMATION_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The member component and trigger admission retain their existing bounds.
const SCHEDULE_AUTOMATION_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const automationIdValid = (kind, id) => typeof id === "string" && (kind === "schedule" ? SCHEDULE_AUTOMATION_ID : AUTOMATION_ID).test(id);
// A local item's key: bare or `local/`; a member's (workspace) item is edited in Git, never here.
export const automationKeyLocal = id => typeof id === "string" && (!id.includes("/") || id.startsWith("local/"));
// The kernel's summary rule (and packages/desktop/renderer/schedule-read-data.mjs's): "" clears, else one line of 1-200 code points.
export const automationDescriptionValid = v => typeof v === "string" && [...v].length <= 200 && !/[\p{Cc}\u2028\u2029]/u.test(v);
/** `oats trigger test <id> --run-source` (feature trigger-sources): the kernel runs a capability source's
 * command for a test only with this flag; without it, it executes nothing and answers E_TRIGGER_SOURCE_RUN.
 * The one place the flag is spelled: it is composed here, from `runSource: true`, never passed in by a caller. */
export const TRIGGER_RUN_SOURCE_FLAG = "--run-source";
export const TRIGGER_SOURCES_FEATURE = "trigger-sources";
/** `runSource` is an operator's confirmed press and nothing else: the strict boolean `true`, a trigger's test, on a
 * CLI whose probe declares the feature (`features`: the negotiated probe's list, passed by the caller; never probed
 * here). */
export const automationRunSourceValid = (kind, action, runSource, features) => runSource === undefined
  || (runSource === true && kind === "trigger" && action === "test" && Array.isArray(features) && features.includes(TRIGGER_SOURCES_FEATURE));
export function cliAutomation(bin, { kind, action, id, description, workspaceDir, runSource, features }, io = {}) {
  if (!Object.hasOwn(AUTOMATION_VERBS, kind) || !AUTOMATION_VERBS[kind].includes(action)
    || (action === "list" ? id !== undefined : id === undefined ? !ID_OPTIONAL.has(action) : !automationIdValid(kind, id))
    || (action === "describe" ? !automationKeyLocal(id) || !automationDescriptionValid(description) : description !== undefined)
    || !automationRunSourceValid(kind, action, runSource, features)
    || typeof workspaceDir !== "string" || !isAbsolute(workspaceDir) || workspaceDir.includes("\0")) {
    return Promise.resolve({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid automation request" } });
  }
  const verb = action === "describe" ? ["update", id, `--description=${description}`] : [action, ...(id === undefined ? [] : [id]), ...(runSource === true ? [TRIGGER_RUN_SOURCE_FLAG] : [])];
  const argv = [kind, ...verb, "--dir", workspaceDir, "--json"];
  return runJson(bin, argv, { cwd: workspaceDir, exec: io.exec, timeout: io.timeout || (action === "test" ? 60_000 : 30_000) });
}

/** Team model v2 (feature team-model-2): `oats teams …` and `oats soul teams …`, config-only
 * kernel verbs, argv only (no shell). Positionals are grammar-bound (a label, a soul key) and so
 * never option-shaped; every option value travels as ONE `--flag=value` token (the kernel reads
 * the inline form since 0.28), so a value can never become a flag of its own. A team id is the
 * aweb `<name>:<namespace>` shape; a description is bounded printable text, never `-`-led. */
// The kernel's own grammars (feat/030-team-model lib/teams-verbs.mjs LABEL_RE; K1's soul-key
// pattern), bounded here: a label ≤64, a soul key ≤256.
const TEAM_LABEL_ARG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const argText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !v.startsWith("-") && !/[\x00-\x1f\x7f]/.test(v);
const TEAM_ID_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SOUL_KEY_RE = /^(?:\*|(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const SOUL_KEY = { test: v => typeof v === "string" && v.length <= 256 && SOUL_KEY_RE.test(v) };
const badTeams = () => Promise.resolve({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid teams request" } });
export function cliTeams(bin, { action = "list", label, team, description, workspaceDir }, io = {}) {
  if (typeof workspaceDir !== "string" || !isAbsolute(workspaceDir) || workspaceDir.includes("\0")) return badTeams();
  let verb;
  if (action === "list") { if (label !== undefined || team !== undefined || description !== undefined) return badTeams(); verb = []; }
  else if (action === "add") {
    if (!TEAM_LABEL_ARG.test(label ?? "") || !TEAM_ID_ARG.test(team ?? "") || (description !== undefined && !argText(description, 512))) return badTeams();
    verb = ["add", label, `--team=${team}`, ...(description === undefined ? [] : [`--description=${description}`])];
  } else if (action === "remove" || action === "default") {
    if (!TEAM_LABEL_ARG.test(label ?? "") || team !== undefined || description !== undefined) return badTeams();
    verb = [action, label];
  } else return badTeams();
  return runJson(bin, ["teams", ...verb, "--dir", workspaceDir, "--json"], { cwd: workspaceDir, exec: io.exec, timeout: io.timeout || 15_000 /* inside the renderer proxy's 20s deadline */ });
}
export function cliSoulTeams(bin, { soul, add, remove, defaultLabel, clearDefault = false, workspaceDir }, io = {}) {
  const list = v => v === undefined || (Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(l => TEAM_LABEL_ARG.test(l)) && new Set(v).size === v.length);
  if (typeof workspaceDir !== "string" || !isAbsolute(workspaceDir) || workspaceDir.includes("\0") || !SOUL_KEY.test(soul ?? "")
    || !list(add) || !list(remove) || (defaultLabel !== undefined && !TEAM_LABEL_ARG.test(defaultLabel)) || typeof clearDefault !== "boolean"
    || (clearDefault && defaultLabel !== undefined) || (soul === "*" && (defaultLabel !== undefined || clearDefault))) return badTeams();
  const argv = ["soul", "teams", soul, ...(add ? [`--add=${add.join(",")}`] : []), ...(remove ? [`--remove=${remove.join(",")}`] : []),
    ...(defaultLabel !== undefined ? [`--default=${defaultLabel}`] : []), ...(clearDefault ? ["--clear-default"] : []), "--dir", workspaceDir, "--json"];
  return runJson(bin, argv, { cwd: workspaceDir, exec: io.exec, timeout: io.timeout || 15_000 });
}

/** The roster's envelope as the CLI printed it. A group the kernel could not reach carries the kernel's
 * own error in `probe.error`: each is marked the kernel's here (kernel-made.mjs), as `parseEnvelope` marks
 * the envelope's own. remote-roster.mjs `remotePanel` reads the mark to say who made a row's text. */
function parseRosterEnvelope(stdout) {
  const doc = parseEnvelope(stdout);
  if (doc?.ok === true && Array.isArray(doc.result.groups)) for (const group of doc.result.groups) kernelMade(group?.probe?.error);
  return doc;
}

/** A value the kernel takes for `server roster --workspace-key` (feature roster-workspace-key): a
 * registration's key grammar (not empty, no whitespace or control character), and not an option
 * (the kernel refuses a value that starts with `--`). */
export const ROSTER_WORKSPACE_KEY = /^(?!--)[^\s\x00-\x1f\x7f]{1,2048}$/;
/** At most this many keys in one read: one per open window. */
export const ROSTER_WORKSPACE_KEYS_MAX = 64;

/** One bounded aggregate read; the CLI owns registry and saved-route resolution. `io.workspaceKeys`, only
 * for a CLI that lists `roster-workspace-key`: the read probes those workspaces' registrations (and those
 * of unknown workspace, and saved routes) and no other; each is one `--workspace-key=<key>` argv element.
 * None, or an empty list, is the unfiltered read. A key the kernel would refuse is refused here. */
export function cliRemoteRoster(bin, io = {}) {
  const keys = io.workspaceKeys ?? [];
  if (!Array.isArray(keys) || keys.length > ROSTER_WORKSPACE_KEYS_MAX || !keys.every((k) => typeof k === "string" && ROSTER_WORKSPACE_KEY.test(k))) {
    throw Object.assign(new Error("Invalid workspace keys for the roster read"), { code: "E_BAD_ARGS" });
  }
  const argv = ["server", "roster", ...[...new Set(keys)].map((k) => `--workspace-key=${k}`), "--json"];
  return runJson(bin, argv, { cwd: io.cwd || process.cwd(), exec: io.exec, timeout: io.timeout || 60_000, parse: parseRosterEnvelope });
}

/** Local retire predates the envelope; preserve its incomplete-cleanup result. */
export function parseRetireEnvelope(stdout) {
  const envelope = parseEnvelope(stdout);
  if (envelope && (!envelope.ok || !envelope.result?.rollbackIncomplete?.length)) return envelope;
  try {
    const result = envelope?.result || JSON.parse(String(stdout));
    if (typeof result?.retired !== "string") return null;
    const incomplete = !!result.rollbackIncomplete?.length;
    return { schemaVersion: 1, ok: !incomplete, result,
      ...(incomplete ? { error: { code: "E_RETIRE_INCOMPLETE", message: "Retirement cleanup is incomplete; the instance is retained for retry" } } : {}) };
  } catch { return null; }
}

export function cliRetire(bin, { instance, home, workspaceDir, server }, io = {}) {
  return runJson(bin, ["retire", instance, "--home", home, ...(server ? ["--server", server] : ["--dir", workspaceDir]), "--json"], {
    cwd: workspaceDir, exec: io.exec, timeout: io.timeout || 600_000, parse: parseRetireEnvelope,
  });
}

/** The kernel's harness flag, named by the caller: --harness (feature harness)
 * or a released kernel's --runtime. Anything else is refused, never guessed. */
function flagFor(harnessFlag) {
  if (harnessFlag === "--harness" || harnessFlag === "--runtime") return harnessFlag;
  throw Object.assign(new Error("The kernel's harness flag was not named"), { code: "E_BAD_ARGS" });
}

/** Shared explicit launch choices; every value remains one argv entry. `launchConfig` is a configuration's
 * name or the word that selects none (launch-contract.mjs LAUNCH_CONFIG_NONE): `--launch-config none`
 * asks for the bare harness, alone or beside a harness. */
export function launchChoiceArgv({ launchConfig, harness, model, yolo, harnessFlag } = {}) {
  const argv = [];
  for (const [key, v] of Object.entries({ launchConfig, harness, model })) {
    if (v === undefined || v === "") continue;
    const rule = SPAWN_ARG_RULES[key];
    if (typeof v !== "string" || !rule.re.test(v)) throw Object.assign(new Error(`Invalid ${key}`), { code: "E_BAD_ARGS" });
    argv.push(key === "harness" ? flagFor(harnessFlag) : rule.flag, v);
  }
  if (yolo !== undefined) {
    if (typeof yolo !== "boolean") throw Object.assign(new Error("Invalid permission setting"), { code: "E_BAD_ARGS" });
    argv.push(yolo ? "--yolo" : "--no-yolo");
  }
  return argv;
}

/** `execFile`'s shape, return and errors, for a child in a session of its own (`detached`: a new session and
 * process group). `execFile` drops `detached`, so this is the `exec` a kernel caller of this home uses for a
 * stop or retire apply, a start and a spawn apply. Like `execFile` it collects stdout and stderr (`encoding`,
 * default utf8), ends the child with `killSignal` (SIGTERM) when `timeout` (0: none) passes or an output passes
 * `maxBuffer`, and calls back once the child's streams close: `(null, stdout, stderr)` on a clean exit; else an
 * Error with `code` (the exit status, or a system code), `killed` and `signal`, or the overflow's own error,
 * whose `code` is ERR_CHILD_PROCESS_STDIO_MAXBUFFER. A child its `timeout` killed is never a clean exit, even
 * when it then exits 0: the Error has `killed: true`, and stdout and stderr are still passed (execFile's kill
 * destroys them first). stdin is a pipe, as `execFile`'s, that nobody writes. */
export function execFileInSession(bin, argv, options = {}, callback = () => {}) {
  const { cwd, env, encoding = "utf8", timeout = 0, maxBuffer = 1024 * 1024, killSignal = "SIGTERM" } = options;
  const child = spawn(bin, argv, { cwd, env: withoutControlToken(env), shell: false, detached: true, windowsHide: true });
  const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  let ex = null, killed = false, timer = null, exited = false;
  const text = name => { const all = Buffer.concat(chunks[name]); return encoding && encoding !== "buffer" ? all.toString(encoding) : all; };
  function kill() { killed = true; try { child.kill(killSignal); } catch (error) { ex ??= error; exit(); } }
  function exit(code = null, signal = null) {
    if (exited) return; exited = true; clearTimeout(timer);
    const stdout = text("stdout"), stderr = text("stderr");
    if (!ex && !killed && code === 0 && signal === null) { callback(null, stdout, stderr); return; }
    const cmd = [bin, ...argv].join(" ");
    if (!ex) ex = Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { code, killed: child.killed || killed, signal });
    ex.cmd = cmd; callback(ex, stdout, stderr);
  }
  for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
    if (ex) return;
    const room = maxBuffer - sizes[name];
    if (chunk.length > room) {
      chunks[name].push(chunk.subarray(0, Math.max(room, 0))); sizes[name] = maxBuffer;
      ex = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }); kill(); return;
    }
    chunks[name].push(chunk); sizes[name] += chunk.length;
  });
  child.on("close", exit);
  child.on("error", error => { ex = error; child.stdout?.destroy(); child.stderr?.destroy(); exit(); });
  if (timeout > 0) { timer = setTimeout(kill, timeout); }
  return child;
}

/** How long a client waits for a start's answer. The wait ends; the start does not. */
export const START_WAIT_MS = ENVELOPE_TIMEOUT_MS;

/** Start/restart is owned by the kernel, never a GUI stop-then-spawn pair. A start runs in a session of its own
 * (`detached`, execFileInSession) with no deadline of its own (`timeout: 0`, no kill timer), so neither a signal
 * to the client's group nor a deadline ends it (#889: a start killed mid-way can leave its lock). The client
 * waits for its answer `io.wait` (START_WAIT_MS, 60 s); `io.after(ms, fn)` runs fn once after ms and answers a
 * cancel. When the wait ends first, the start answers the code `E_START_UNCONFIRMED`, with no message: nothing is
 * known of the start, and each client words that in its own words, under no speaker (it is not the kernel's).
 * The child goes on: what it prints
 * is still read, so it neither blocks on a full pipe nor writes to a closed one, and its answer, when it comes
 * after the wait, is not kept. A start has no entry to keep it on, and its answer says nothing the roster
 * does not: after a failed start the row is read again. */
export function cliStart(bin, { home, workspaceDir, server, restart = false, ...choices }, io = {}) {
  if (typeof home !== "string" || !home.startsWith("/") || home.includes("\0")
    || (server !== undefined && (typeof server !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(server)))
    || typeof restart !== "boolean") {
    return Promise.resolve({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "Invalid start home, server or action" } });
  }
  let options;
  try { options = launchChoiceArgv(choices); }
  catch (e) { return Promise.resolve({ schemaVersion: 1, ok: false, error: { code: e.code, message: e.message } }); }
  const { wait = START_WAIT_MS, after = waitTimer } = io;
  let cancel = () => {};
  const answered = runJson(bin, ["session", restart ? "restart" : "start", "--home", home,
    ...(server ? ["--server", server] : []), ...options, "--json"], {
    cwd: workspaceDir, exec: io.exec, timeout: 0, detached: true,
  }).finally(() => cancel());
  const waited = new Promise((resolve) => {
    cancel = after(wait, () => resolve({ schemaVersion: 1, ok: false, error: { code: "E_START_UNCONFIRMED" } }));
  });
  return Promise.race([answered, waited]);
}
/** A wait's timer that keeps no process alive: `after(ms, fn)` -> cancel. */
const waitTimer = (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); };

/** Named configuration data travels in private JSON files, not shell text. */
export async function cliLaunchConfig(bin, { action, name, definition, keepEnv, context, server, home, soul, agentsRoot, choices, localCwd }, io = {}) {
  let temporary;
  const bad = message => { throw Object.assign(new Error(message), { code: "E_BAD_ARGS" }); };
  const value = (v, label) => {
    if (typeof v !== "string" || !v || v.startsWith("-") || v.includes("\0")) bad(`Invalid ${label}`);
    return v;
  };
  try {
    if (!["list", "set", "remove", "preview"].includes(action)) bad("Unknown launch configuration action");
    const argv = ["launch-config", action];
    if (["set", "remove"].includes(action)) {
      if (typeof name !== "string" || !SPAWN_ARG_RULES.launchConfig.re.test(name)) bad("Invalid configuration name");
      argv.push(name);
    }
    if (action === "set") {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) bad("Specify a launch configuration object");
      temporary = writeTaskFile(JSON.stringify(definition), io); argv.push("--file", temporary.file);
      if (keepEnv !== undefined && typeof keepEnv !== "boolean") bad("Invalid environment preservation setting");
      if (keepEnv) argv.push("--keep-env");
    }
    if (context) argv.push("--dir", value(context, "scope"));
    if (server) argv.push("--server", value(server, "server"));
    if (home) argv.push("--home", value(home, "home"));
    if (soul) argv.push("--soul", value(soul, "soul"));
    if (agentsRoot) argv.push("--agents-root", value(agentsRoot, "agents root"));
    if (action === "preview") argv.push(...launchChoiceArgv(choices));
    return await runJson(bin, [...argv, "--json"], { cwd: localCwd, exec: io.exec, timeout: io.timeout });
  } catch (e) { return { schemaVersion: 1, ok: false, error: { code: e.code || "E_BAD_ARGS", message: e.message } }; }
  finally { temporary?.cleanup(); }
}

/** Inspection and provider operations share one CLI boundary. Read-only:
 * workspace model v2 removed `oats use`, and a soul is edited in its repository. */
/** Operation arguments the provider declares (`--arg name=value`): a bounded
 * record of names to single-line values. The kernel refuses undeclared ones. */
export function operationArgs(args) {
  if (args === undefined) return [];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.getPrototypeOf(args) !== Object.prototype) return null;
  const entries = Object.entries(args);
  if (entries.length > 8 || entries.some(([k, v]) => !/^[a-z][a-z0-9-]{0,63}$/.test(k) || typeof v !== 'string' || !v || v.length > 1024 || /[\x00-\x1f\x7f]/.test(v))) return null;
  return entries.flatMap(([k, v]) => ['--arg', `${k}=${v}`]);
}
/** A verb that writes one field of an instance's own record: `oats instance <verb> <instance> <values…> --home <home>
 * (--dir <context> | --server <server>) --json`, addressed as `oats instance stop` is (lifecycle-cli.mjs: a routed
 * command never carries --dir). Shared by `instance color` and `instance background` (server/instance-record.mjs);
 * each checks its own value first. Anything out of shape is refused here and nothing runs. A read's deadline:
 * 30 s, 45 s routed. The envelope comes back as the kernel printed it; the caller decodes it. */
function runInstanceRecord(bin, { instance, home, context, server }, verb, values, io) {
  const fail = code => ({ schemaVersion: 1, ok: false, error: { code } });
  if (typeof bin !== "string" || !isAbsolute(bin) || typeof instance !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instance)
    || typeof home !== "string" || !isAbsolute(home) || home.includes("\0")
    || (server !== undefined ? !/^[a-z0-9][a-z0-9-]{0,63}$/.test(server ?? "") : typeof context !== "string" || !isAbsolute(context))) return fail("E_BAD_ARGS");
  const argv = ["instance", verb, instance, ...values, "--home", home,
    ...(server !== undefined ? ["--server", server] : ["--dir", context]), "--json"];
  const limit = server !== undefined ? 45_000 : 30_000;
  return runJson(bin, argv, { cwd: server !== undefined ? io.cwd : context, exec: io.exec, strictExit: true,
    timeout: Number.isFinite(io.timeout) && io.timeout > 0 ? Math.min(io.timeout, limit) : limit });
}
const instanceRecordRefused = () => ({ schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS" } });
/** An instance's colour (feature instance-color, awebai/oats#1421 §2): `oats instance color <instance>
 * (<color> | --clear) …` (runInstanceRecord). `color` is a palette name (soul-colors.mjs SOUL_COLORS) or null to
 * clear; anything else is refused here and nothing runs. */
export async function cliInstanceColor(bin, args, io = {}) {
  const { color } = args;
  if (!(color === null || SOUL_COLORS.includes(color))) return instanceRecordRefused();
  return runInstanceRecord(bin, args, "color", color === null ? ["--clear"] : [color], io);
}
/** Whether an instance runs in the background (feature instance-background, awebai/oats#1579): `oats instance
 * background <instance> (on | off) …` (runInstanceRecord). `background` is a boolean; anything else is refused
 * here and nothing runs. Over `--server`, a host without the feature refuses it (E_REMOTE_INCOMPATIBLE). */
export async function cliInstanceBackground(bin, args, io = {}) {
  const { background } = args;
  if (typeof background !== "boolean") return instanceRecordRefused();
  return runInstanceRecord(bin, args, "background", [background ? "on" : "off"], io);
}

/** `maxAge` (feature observe-max-age) is inspect's alone; `features` is the probe's list and
 * gates the flags (also `instructions`, `skills` and `composedSkills`), so an undeclared kernel gets the flagless argv even when a value is given. */
export async function cliCapability(bin, { action, context, server, soul, agentsRoot, home, operation, args, localCwd, maxAge, instructions = false, skills = false, composedSkills = false, features }, io = {}) {
  const bad = message => { throw Object.assign(new Error(message), { code: 'E_BAD_ARGS' }); };
  const value = (v, label) => {
    if (typeof v !== 'string' || !v || v.startsWith('-') || v.includes('\0')) bad(`Invalid ${label}`);
    return v;
  };
  const target = [];
  if (context) target.push('--dir', value(context, 'scope'));
  if (server) target.push('--server', value(server, 'server'));
  if (home) target.push('--home', value(home, 'home'));
  if (soul) target.push('--soul', value(soul, 'soul'));
  if (agentsRoot) target.push('--agents-root', value(agentsRoot, 'agents root'));
  let argv;
  if (action === 'inspect') argv = ['inspect'];
  else if (action === 'run') {
    if (typeof operation !== 'string' || !/^(knowledge|messaging|tasks):[a-zA-Z0-9._-]+$/.test(operation)) bad('Select a declared provider operation');
    const pairs = operationArgs(args);
    if (!pairs) bad('Invalid operation arguments');
    argv = ['operation', 'run', operation, ...pairs];
  } else bad('Unknown capability action');
  if (action !== 'run' && args !== undefined) bad('Arguments belong to an operation run');
  if (action !== 'inspect' && maxAge !== undefined) bad('Observation age belongs to an inspection');
  // Reuse is local only: the kernel refuses --max-age with --server (E_BAD_ARGS), so a routed inspect never carries it.
  if (server && maxAge !== undefined) bad('Observation age does not route to a server');
  if (!validMaxAge(maxAge)) bad('Invalid observation age');
  // --instructions (feature soul-composed-instructions) composes a soul's AGENTS.md: inspect --soul only; a CLI that
  // does not advertise it gets the flagless argv. Routed with --server, the caller asks only for a host whose roster
  // row names the feature (inspect-boundary.mjs, composed-gate.mjs): a host without it refuses the flag.
  if (instructions && (action !== 'inspect' || !soul || home)) bad('Composed instructions belong to a soul inspection');
  const composed = instructions && Array.isArray(features) && features.includes('soul-composed-instructions') ? ['--instructions'] : [];
  // --skills (feature soul-skills) adds the soul's own skills (souls[0].skills): inspect --soul only, gated the same
  // way; routed, the caller asks only for a host whose roster row names soul-skills (composed-gate.mjs hostReportsSkills).
  if (skills && (action !== 'inspect' || !soul || home)) bad('Skills belong to a soul inspection');
  const skillsArgv = skills && Array.isArray(features) && features.includes('soul-skills') ? ['--skills'] : [];
  // --composed-skills (feature soul-composed-skills) adds every skill a spawn gives the instance (souls[0].composedSkills):
  // inspect --soul only, gated the same way; routed, only for a host whose roster row names it (hostComposesSkills).
  if (composedSkills && (action !== 'inspect' || !soul || home)) bad('Composed skills belong to a soul inspection');
  const composedSkillsArgv = composedSkills && Array.isArray(features) && features.includes('soul-composed-skills') ? ['--composed-skills'] : [];
  return await runJson(bin, [...argv, ...target, ...composed, ...skillsArgv, ...composedSkillsArgv, ...maxAgeArgv(features, maxAge), '--json'], {
    cwd: localCwd, exec: io.exec, timeout: io.timeout ?? (action === 'run' ? 300_000 : ENVELOPE_TIMEOUT_MS),
    // The skills' text makes the answer larger than any other read: an allowance of its own, still bounded.
    maxBuffer: skillsArgv.length || composedSkillsArgv.length ? SKILLS_INSPECT_MAX_BUFFER : ENVELOPE_MAX_BUFFER,
  });
}
