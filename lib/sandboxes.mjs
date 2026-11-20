/**
 * lib/sandboxes.mjs — the kernel's side of sandboxes (docs/design/2026-11-19-sandboxes.md; the reference
 * pages are docs/workspaces.md "Sandboxes", docs/configuration.md "Sandboxes", docs/capabilities.md
 * "The sandbox event" and docs/desktop-cli-api.md "Sandboxes"): the caller of a capability's `sandbox`
 * hook (C4), the per-sandbox lock, the record of the sandboxes this deployment started (D-S1-1), the
 * routed spawn into a sandbox with its kept request (the record's seven steps), and the readers of all of
 * it (`oats sandbox status`, sync, readiness).
 *
 * The kernel gains no container fact here: every one comes from the provider's answers. The kernel names
 * no messaging provider either: a seat reaches the spawn as the `spawnProvider` options the provider's
 * seat plan answers, passed on unread.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { oatsError, lifecycleBusy } from "./errors.mjs";
import { acquireDirLock, withDirLock, stuckLockRemedy } from "./dir-lock.mjs";
import { writeFileAtomic } from "./write-file-atomic.mjs";
import { withoutKernelEnvironment } from "./kernel-env.mjs";
import { kernelNode } from "./stable-node.mjs";
import { resolveDeploymentModules } from "./resolve.mjs";
import { killGroup, signalGroup } from "./process-group.mjs";
import { HOST_AGENT_REMEDY, SANDBOX_REASONS, declaredSandboxes, hostAgentRefusal, placementOf } from "./sandbox-model.mjs";

export const SANDBOX_API = 1;
/** C4: the acts, and the two that only read (no lock, no state changed). */
export const SANDBOX_ACTS = Object.freeze(["plan", "start", "stop", "status", "reconcile", "seat", "bind", "release"]);
const READ_ONLY_ACTS = new Set(["plan", "status"]);
/** C4: an answer's states. */
export const SANDBOX_STATES = Object.freeze(["ready", "stopped", "absent", "failed", "unknown", "stale"]);
/** The plan targets C4 names. */
const PLAN_TARGETS = new Set(["start", "stop", "reconcile", "seat", "bind", "release"]);
/** C4: how long one act may run before it is read as `unknown` (`hook-failed`): the two that only read
 *  answer from the provider's state; the mutating ones may build images. OATS_TEST_SANDBOX_HOOK_TIMEOUT_MS
 *  is the test seam (lib/reserved-launch-env.mjs). */
export const SANDBOX_READ_TIMEOUT_MS = 60_000;
export const SANDBOX_ACT_TIMEOUT_MS = 30 * 60_000;
/** What one answer may hold, at most. */
const ANSWER_MAX_BYTES = 4 * 1024 * 1024;

export { SANDBOX_REASONS, HOST_AGENT_REMEDY, hostAgentRefusal } from "./sandbox-model.mjs";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);
function fail(code, message, details) {
  const e = oatsError(code, message, details);
  e.details = details;
  return e;
}

/* ───────────────────────────── the deployment ─────────────────────────── */

/**
 * What every sandbox act reads, once: `{ deploymentDir, local, discovery, lock, catalog, remoteOptions }`
 * as the CLI has them (discoverOrStandalone, readLock). → the context the functions below take.
 */
export function sandboxContext({ deploymentDir, local, discovery, lock = null, catalog = null, remoteOptions } = {}) {
  let deployment;
  try { deployment = realpathSync(deploymentDir); } catch { deployment = resolve(deploymentDir); }
  const workspace = discovery?.standalone === true ? null : (isObject(discovery?.workspace) ? discovery.workspace : null);
  const declared = new Map(declaredSandboxes(workspace).map(([name, entry]) => [name, entry]));
  return {
    deployment, root: join(deployment, "agents"), local: isObject(local) ? local : {}, discovery, workspace, lock, catalog, remoteOptions,
    host: str(local?.host?.name),
    listed: Array.isArray(local?.sandboxes) ? local.sandboxes.filter((n) => typeof n === "string") : [],
    self: str(local?.sandbox?.self),
    declared,
  };
}
/** The sandbox a soul's resolution places it in (the record, Placement), or null for the host. */
export function soulPlacement(ctx, resolution) {
  return placementOf(ctx.workspace, resolution?.defaultTeam ?? null);
}
/** The sandbox's team as a request carries it: `{ label, id }`, id null while it is not created. */
function teamOf(ctx, name) {
  const entry = ctx.declared.get(name);
  if (!entry) return null;
  return { label: entry.team, id: str(ctx.workspace?.teams?.[entry.team]?.team) };
}
const credentialPath = (ctx, n) => str(isObject(ctx.local.credentials?.[n]) ? ctx.local.credentials[n].fromFile : null);
/** C5: each declared credential's source here, `present` or `missing` (no entry, or no file). */
export function credentialSources(ctx, name) {
  const entry = ctx.declared.get(name);
  return (Array.isArray(entry?.credentials) ? entry.credentials : []).map((n) => {
    const path = credentialPath(ctx, n);
    return { name: n, source: path !== null && existsSync(path) ? "present" : "missing" };
  });
}
/** The sha256 of the deployment's oats-lock.json as written, or null without one. */
function lockDigest(ctx) {
  try { return createHash("sha256").update(readFileSync(join(ctx.deployment, "oats-lock.json"))).digest("hex"); } catch { return null; }
}

/**
 * C4: the request of one act. Every act for a name the workspace does not declare is refused here,
 * before the hook, except `stop` (D-S1-1): a sandbox removed from both files is stopped from the
 * provider's own last declaration, with `team: null`, `egress: []` and `credentials: []`.
 */
export function sandboxRequest(ctx, name, act, extra = {}) {
  const entry = ctx.declared.get(name);
  if (!entry && act !== "stop" && !(act === "plan" && extra.target === "stop")) {
    throw fail("E_WORKSPACE_SCHEMA", `sandbox ${name} is not declared in oats-workspace.yaml sandboxes:; nothing was sent to the provider`, { reason: SANDBOX_REASONS.sandboxUnknown, sandbox: name });
  }
  return {
    sandboxApi: SANDBOX_API, act, sandbox: name, host: ctx.host,
    team: entry ? teamOf(ctx, name) : null,
    egress: entry && Array.isArray(entry.egress) ? [...entry.egress] : [],
    credentials: entry && Array.isArray(entry.credentials) ? entry.credentials.map((n) => ({ name: n, path: credentialPath(ctx, n) })) : [],
    workspace: { url: ctx.discovery?.url ?? null, commit: ctx.discovery?.commit ?? null, lock: lockDigest(ctx) },
    ...extra,
  };
}

/* ───────────────────────────── the provider ───────────────────────────── */

/** The command a manifest gives its `sandbox` hook, or null. */
export function sandboxHookOf(manifest) {
  const h = manifest?.hooks?.sandbox;
  if (typeof h === "string" && h.trim()) return h.trim();
  if (isObject(h) && typeof h.command === "string" && h.command.trim()) return h.command.trim();
  return null;
}
/**
 * C4, which capability provides the hook: the capabilities the workspace's `defaults` compose (a spawn's
 * resolution without a soul's layer) whose manifest declares `sandbox`. Exactly one: none is
 * E_SANDBOX_PROVIDER `none`, more is `ambiguous`, naming them. Its settings are merged as a spawn's
 * (manifest → workspace → host). → the module (lib/resolve.mjs resolveDeploymentModules).
 */
export async function sandboxProvider(ctx) {
  const mods = await resolveDeploymentModules(ctx.discovery, { local: ctx.local, lock: ctx.lock, catalog: ctx.catalog, remoteOptions: ctx.remoteOptions, want: (m) => sandboxHookOf(m) !== null });
  if (!mods.length) throw fail("E_SANDBOX_PROVIDER", "no capability the workspace's defaults compose declares the sandbox hook: add the sandbox provider (oats.aweb-sandbox) to defaults.capabilities in oats-workspace.yaml, then `oats sync`; nothing was done", { reason: SANDBOX_REASONS.providerNone });
  if (mods.length > 1) {
    const names = mods.map((m) => m.name);
    throw fail("E_SANDBOX_PROVIDER", `more than one capability declares the sandbox hook (${names.join(", ")}): the workspace's defaults compose exactly one sandbox provider; turn the others off; nothing was done`, { reason: SANDBOX_REASONS.providerAmbiguous, capabilities: names });
  }
  return mods[0];
}
/** The provider's capability directory at its resolved commit, digest-verified into
 *  <deployment>/.oats/modules (lib/operator-dispatch.mjs ensureModuleTree, as a trigger source's). */
async function providerDir(ctx, provider) {
  const { ensureModuleTree } = await import("./operator-dispatch.mjs");
  return ensureModuleTree(ctx.deployment, provider, ctx.lock, { catalog: ctx.catalog, remoteOptions: ctx.remoteOptions });
}
/** A script inside `dir` (both real paths; a symlink out of it is an escape), a regular file, or null. */
function containedScript(dir, script) {
  let root, file;
  try { root = realpathSync(dir); file = realpathSync(resolve(dir, script)); } catch { return null; }
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}
/**
 * The hook's environment (C4, as both sides decided it with the lead, docs/capabilities.md "The sandbox
 * event"): the invoker's own, with every name the kernel generates removed (no soul, instance, team or
 * captured-context name reaches it), then the event, the act, the capability, the deployment
 * (OATS_WORKSPACE, its real path: C7's deployment key is derived from it), the agents root, the merged
 * settings and the kernel's own executables.
 */
export async function sandboxHookEnv(ctx, provider, act) {
  const { kernelBin } = await import("./core.mjs");
  const env = withoutKernelEnvironment(process.env);
  for (const name of ["OATS_SANDBOX_ACT", "OATS_SPAWN_IDEMPOTENCY_KEY"]) delete env[name];
  return Object.assign(env, {
    OATS_EVENT: "sandbox", OATS_SANDBOX_ACT: act,
    OATS_CAPABILITY: provider.name, OATS_LAYER: provider.layer || "", OATS_LEVEL: "deployment",
    OATS_WORKSPACE: ctx.deployment, OATS_ROOT: ctx.root,
    OATS_SETTINGS: JSON.stringify(provider.settings || {}), OATS_SETTINGS_ORIGINS: JSON.stringify(provider.settingsOrigins || {}),
    OATS_CLI_BIN: kernelBin(), OATS_NODE_BIN: kernelNode().node,
  });
}
const hookTimeout = (act) => {
  const seam = Number(process.env.OATS_TEST_SANDBOX_HOOK_TIMEOUT_MS);
  if (Number.isFinite(seam) && seam > 0) return seam;
  return READ_ONLY_ACTS.has(act) ? SANDBOX_READ_TIMEOUT_MS : SANDBOX_ACT_TIMEOUT_MS;
};
/** C4: a hook that exits nonzero, times out or prints anything but one valid answer is `unknown` with
 *  E_SANDBOX_PROVIDER `hook-failed`. */
function hookFailed(provider, act, why) {
  return {
    sandboxApi: SANDBOX_API, act, state: "unknown", receipts: [],
    problem: { code: "E_SANDBOX_PROVIDER", reason: SANDBOX_REASONS.hookFailed, message: `${provider.name}'s sandbox hook (${act}) ${why}: its outcome is unknown`, remedy: `read the provider's state with \`oats sandbox status\`, then run the act again; ${provider.name}'s own logs say what happened` },
  };
}
const validPlan = (p) => isObject(p) && typeof p.planRevision === "string" && p.planRevision && Array.isArray(p.actions) && p.actions.every((a) => isObject(a) && typeof a.step === "string");
/** The seat fields a settled answer of each act carries (C4's table, by act): each a non-empty string. */
const SEAT_FIELDS = Object.freeze({ plan: ["id", "path"], seat: ["id", "path", "alias", "certificateId", "team"], bind: ["id", "certificateId", "state"], release: ["id", "certificateId", "state"] });
const hasFields = (o, fields) => isObject(o) && fields.every((f) => typeof o[f] === "string" && o[f] !== "");
/** Whether `doc` is one valid answer to `request` (C4's envelope and the act's own fields). */
function answerProblem(doc, request) {
  if (!isObject(doc)) return "answered no JSON object";
  if (doc.sandboxApi !== SANDBOX_API) return `answered sandboxApi ${JSON.stringify(doc.sandboxApi)}, not ${SANDBOX_API}`;
  if (doc.act !== request.act) return `answered act ${JSON.stringify(doc.act)} to ${request.act}`;
  if (!SANDBOX_STATES.includes(doc.state)) return `answered state ${JSON.stringify(doc.state)}`;
  if (!Array.isArray(doc.receipts) || !doc.receipts.every((r) => isObject(r) && typeof r.step === "string" && typeof r.ok === "boolean")) return "answered no receipts list";
  if (doc.problem !== undefined && doc.problem !== null && !(isObject(doc.problem) && typeof doc.problem.code === "string")) return "answered a problem without a code";
  if (doc.state === "stale" && !validPlan(doc.plan)) return "answered stale without a fresh plan";
  const settled = !["failed", "unknown", "stale"].includes(doc.state);
  if (request.act === "plan" && settled && !validPlan(doc)) return "answered a plan without planRevision and actions";
  if (request.act === "plan" && settled && request.target === "seat" && !(hasFields(doc.seat, SEAT_FIELDS.plan) && isObject(doc.spawnProvider) && typeof doc.spawnProvider.capability === "string" && isObject(doc.spawnProvider.options))) return `answered a seat plan without seat: {${SEAT_FIELDS.plan.join(", ")}} and spawnProvider`;
  if (Object.hasOwn(SEAT_FIELDS, request.act) && request.act !== "plan" && settled && !hasFields(doc.seat, SEAT_FIELDS[request.act])) return `answered ${request.act} without seat: {${SEAT_FIELDS[request.act].join(", ")}}`;
  // C4: a settled status or reconcile answers its seats ledger, [] when it holds none; one left out is no ledger.
  if (["status", "reconcile"].includes(request.act) && settled && doc.seats === undefined) return `answered ${request.act} without its seats`;
  if (["status", "reconcile"].includes(request.act) && doc.seats !== undefined && !(Array.isArray(doc.seats) && doc.seats.every((s) => isObject(s) && typeof s.seatId === "string"))) return "answered seats that are not a list of seats";
  return null;
}
/** Run the hook once, synchronously, and read its answer by C4's rules. Never throws for the hook's
 *  own failures: they are its `unknown` answer. */
/** Run the hook in a process group of its own (lib/process-group.mjs), as instance-naming.mjs runs its
 *  child: its time limit, an answer over ANSWER_MAX_BYTES, and a signal or an exit of the kernel kill the
 *  whole group. It answers once the group's pipes have closed (stdin, stdout, and stderr, read and
 *  dropped), and whatever of the group is left then, holding none of them, is killed first: nothing the
 *  hook started (aw, ssh, a provider's tool) outlives its act and the lock around it. A descendant that
 *  leaves the group itself (setsid) is not seen, as with every owned group.
 *  → {status, signal, error, timedOut, overflow, stdout}. */
function runOwnedGroup(bin, argv, { cwd, env, input, timeout }) {
  return new Promise((settle) => {
    let child, timer, done = false, size = 0, timedOut = false, overflow = false;
    const chunks = [];
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onExit = () => killGroup(child);
    const onSignal = (sig) => { killGroup(child); cleanup(); process.kill(process.pid, sig); };
    const cleanup = () => { process.off("exit", onExit); for (const sig of signals) process.off(sig, onSignal); };
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); cleanup(); settle({ timedOut, overflow, ...value }); };
    try { child = spawn(bin, argv, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"], shell: false }); }
    catch (e) { finish({ error: e }); return; }
    process.once("exit", onExit);
    for (const sig of signals) process.once(sig, onSignal);
    timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeout);
    child.on("error", (e) => finish({ error: e }));
    child.stdout.on("data", (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > ANSWER_MAX_BYTES) { overflow = true; killGroup(child); return; }
      chunks.push(chunk);
    });
    child.stderr.resume(); // read and dropped: a process holding it keeps the act open, as one holding stdout does
    child.on("close", (status, signal) => {
      // The group's leader is reaped, so only the group is signalled, and only while it has a member: a
      // group with one still has its id, which no new process can take.
      try { process.kill(-child.pid, 0); signalGroup(child, "SIGKILL"); } catch { /* the group is empty */ }
      finish({ status, signal: timedOut || overflow ? null : signal, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.on("error", () => { /* a hook that exits before reading its request answers by its exit */ });
    child.stdin.end(input);
  });
}
export async function runSandboxHook(ctx, provider, request) {
  const command = sandboxHookOf(provider.manifest);
  const [script, ...args] = command.split(/\s+/);
  let dir;
  try { dir = await providerDir(ctx, provider); }
  catch (e) { return hookFailed(provider, request.act, `could not be materialized (${e?.code ?? "error"}: ${e?.message ?? e})`); }
  const file = containedScript(dir, script);
  if (!file) return hookFailed(provider, request.act, `names ${script}, which is not a file inside the capability`);
  const timeout = hookTimeout(request.act);
  const r = await runOwnedGroup(process.execPath, [file, ...args], { cwd: dir, env: await sandboxHookEnv(ctx, provider, request.act), input: JSON.stringify(request), timeout });
  if (r.timedOut) return hookFailed(provider, request.act, `did not answer within ${Math.round(timeout / 1000)} s and was killed`);
  if (r.overflow) return hookFailed(provider, request.act, `answered more than ${ANSWER_MAX_BYTES} bytes`);
  if (r.error || r.signal) return hookFailed(provider, request.act, `ended ${r.signal ? `on signal ${r.signal}` : `with ${r.error.code ?? r.error.message}`}`);
  if (r.status !== 0) return hookFailed(provider, request.act, `exited ${r.status}`);
  let doc;
  try { doc = JSON.parse((r.stdout || "").trim()); } catch { return hookFailed(provider, request.act, "did not answer exactly one JSON document"); }
  const wrong = answerProblem(doc, request);
  return wrong ? hookFailed(provider, request.act, wrong) : doc;
}

/* ───────────────────────────── the locks and the record ───────────────── */

/** The per-sandbox lock (C4), in the deployment's kernel state tree: one per deployment and sandbox, so
 *  two deployments of one OS user with a sandbox of the same name never block each other (C7's scope). */
export const sandboxLockPath = (ctx, name) => join(ctx.deployment, ".agents", "locks", `sandbox-${name}.lock`);
/** The deployment-level lock of started.json's read-modify-write (D-S1-1). */
const startedLockPath = (ctx) => join(ctx.deployment, ".agents", "locks", "sandboxes-started.lock");
/** D-S1-1: the sandboxes this deployment started, so sync can stop one removed from both files. */
export const startedPath = (ctx) => join(ctx.deployment, ".oats", "sandboxes", "started.json");
const holderOf = (found) => (found === "running" ? "running" : found === "unknown" || found === "own-start-unreadable" ? "unknown" : "none");
function busyRefusal(lock, said, what, details) {
  return (why, { found }) => lifecycleBusy(holderOf(found), `${said} (${lock}: ${why}); nothing was done`,
    found === "running" ? `wait for the other ${what} to end, then run this again` : stuckLockRemedy(lock, found, what), { ...details, lock });
}
/** D-S1-1: the recorded names → [name]. A file that is there and does not hold the record is refused,
 *  never read as empty: a name it held could then never be stopped. */
export function readStarted(ctx) {
  const path = startedPath(ctx);
  let text;
  try { text = readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return []; throw fail("E_CONFIG_BROKEN", `${path} cannot be read (${e?.code ?? e?.message}): it records the sandboxes this deployment started`, { path, reason: "sandboxes-started-unreadable" }); }
  let doc;
  try { doc = JSON.parse(text); } catch { doc = null; }
  if (!isObject(doc) || doc.sandboxesStartedApi !== 1 || !Array.isArray(doc.sandboxes) || !doc.sandboxes.every((n) => typeof n === "string")) {
    throw fail("E_CONFIG_BROKEN", `${path} is not a record of started sandboxes ({sandboxesStartedApi: 1, sandboxes: [<name>]}): restore it, or write the names of the sandboxes this deployment runs into it`, { path, reason: "sandboxes-started-unreadable" });
  }
  return [...new Set(doc.sandboxes)];
}
/** D-S1-1: change the record under the deployment-level lock, written atomically (temporary file and
 *  rename). `change(names)` → the new names. */
export function updateStarted(ctx, change) {
  const lock = startedLockPath(ctx);
  return withDirLock(lock, "the started-sandboxes record", () => {
    const before = readStarted(ctx);
    const after = [...new Set(change([...before]))].sort();
    if (after.length !== before.length || after.some((n, i) => n !== [...before].sort()[i])) {
      writeFileAtomic(startedPath(ctx), `${JSON.stringify({ sandboxesStartedApi: 1, sandboxes: after }, null, 2)}\n`);
    }
    return after;
  }, { retryMs: 10_000, busy: busyRefusal(lock, "the record of started sandboxes is being written by another oats command", "oats sandbox command", {}) });
}

/* ───────────────────────────── one act ────────────────────────────────── */

/**
 * One act on one sandbox (C4): the request, the lock around every act but `plan` and `status`, the hook,
 * its answer. `before()` and `after(answer)` run under the lock, around the hook (the start's record and
 * the stop's drop, D-S1-1). → the answer.
 */
export async function sandboxAct(ctx, provider, name, act, extra = {}, { before, after } = {}) {
  if (!SANDBOX_ACTS.includes(act)) throw new TypeError(`sandboxAct: unknown act ${act}`);
  if (act === "plan" && !PLAN_TARGETS.has(extra.target)) throw new TypeError(`sandboxAct: unknown plan target ${extra.target}`);
  const request = sandboxRequest(ctx, name, act, extra);
  if (READ_ONLY_ACTS.has(act)) return runSandboxHook(ctx, provider, request);
  return withSandboxLockAsync(ctx, name, async () => {
    before?.();
    const answer = await runSandboxHook(ctx, provider, request);
    after?.(answer);
    return answer;
  });
}
/** `fn` under the sandbox's lock (C4): a second mutating act on the sandbox is E_LIFECYCLE_BUSY at once,
 *  and an act on a sandbox of another deployment never waits for it. Held across the act's awaits; a
 *  holder a signal ends leaves its lock, which the next acquirer takes over (lib/dir-lock.mjs). */
export async function withSandboxLockAsync(ctx, name, fn) {
  const lock = sandboxLockPath(ctx, name);
  const release = acquireDirLock(lock, { what: `oats sandbox ${name}` }, { retryMs: 0, busy: busyRefusal(lock, `sandbox ${name} is busy: another oats command is acting on it`, "oats sandbox command", { sandbox: name }) });
  try { return await fn(); } finally { release(); }
}

/** E_PLAN_STALE from a `stale` answer, with the fresh plan in its detail (C4, on `oats instance stop`'s
 *  pattern). */
export function planStale(name, act, answer) {
  return fail("E_PLAN_STALE", `sandbox ${name}: the ${act} plan is stale (the provider's state or the inputs changed since it was made); nothing was done — review the fresh plan and apply it with its planRevision`, { sandbox: name, act, plan: answer.plan });
}
/** `args` without each `--provider <capability> <key>=<value>` whose key is one of `keys`. */
function withoutProviderKeys(args, capability, keys) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1] === capability && typeof args[i + 2] === "string" && keys.includes(args[i + 2].slice(0, args[i + 2].indexOf("=")))) { i += 2; continue; }
    out.push(args[i]);
  }
  return out;
}
/** A fresh idempotency key for an act the kernel makes itself (sync, a routed spawn's bind). */
export const freshKey = () => randomUUID();

/* ───────────────────────────── the host's own agents ──────────────────── */

/** The homes of this deployment (every one is host-placed: a sandboxed home lives inside its sandbox),
 *  each `{ instance, home, running, unreadable }`. `list` is the listing (lib/instance-listing.mjs
 *  listInstances), injected by the caller that already has it. */
export async function hostHomes(ctx, { list } = {}) {
  if (!existsSync(ctx.root)) return [];
  const rows = list ?? (await import("./instance-listing.mjs")).listInstances(ctx.root);
  return rows.flatMap((a) => a.instances || []).map((i) => ({
    instance: i.instance, home: i.home, running: i.running === true,
    unreadable: i.runtimeState === "unreachable" || (i.running !== true && i.running !== false),
  }));
}
/* ───────────────────────────── C5: the verbs ──────────────────────────── */

/** The provider's `status` problems that are readiness facts, not failures (C10; D-S1-3): on a sandbox it
 *  observed `ready` or `stopped`, classified by reason, never by code (E_SANDBOX_PROVIDER also carries
 *  none, ambiguous and hook-failed). Such a problem is no entry's problem and fails no sync; it is a
 *  readiness item and an envelope warning (SANDBOX_ADVISORY). */
const ADVISORY_REASONS = new Set([SANDBOX_REASONS.sshIncludeMissing, SANDBOX_REASONS.stateOrphaned]);
export const isAdvisory = (answer) => answer?.act === "status" && (answer.state === "ready" || answer.state === "stopped") && isObject(answer.problem) && ADVISORY_REASONS.has(answer.problem.reason);
/** The envelope warning an entry carries beside its JSON (a symbol key: never serialized into the entry):
 *  `{ code: "sandbox-<reason>", sandbox, message }`. */
export const SANDBOX_ADVISORY = Symbol("sandbox advisory");
const problemsOf = (answer) => (isObject(answer?.problem) && !isAdvisory(answer) ? [answer.problem] : []);
const serverOf = (answer) => (typeof answer?.server === "string" ? answer.server : null);
/** C5: one `oats sandbox status` entry, from the provider's `status` (or its absence). */
function statusEntry(ctx, name, answer, extraProblems = []) {
  const entry = ctx.declared.get(name);
  const out = {
    name, team: teamOf(ctx, name), listedHere: ctx.listed.includes(name),
    state: answer?.state ?? "unknown", server: serverOf(answer),
    egress: Array.isArray(entry?.egress) ? [...entry.egress] : [], credentials: credentialSources(ctx, name),
    problems: [...extraProblems, ...problemsOf(answer)],
    seats: Array.isArray(answer?.seats) ? answer.seats : [],
  };
  if (isAdvisory(answer)) out[SANDBOX_ADVISORY] = { code: `sandbox-${answer.problem.reason}`, sandbox: name, message: `sandbox ${name}: ${typeof answer.problem.message === "string" && answer.problem.message ? answer.problem.message : answer.problem.reason}${typeof answer.problem.remedy === "string" && answer.problem.remedy ? ` — ${answer.problem.remedy}` : ""}` };
  return out;
}
/** The envelope warnings of a status or sync answer's entries (SANDBOX_ADVISORY). */
export const advisoryWarnings = (entries) => (entries ?? []).map((e) => e?.[SANDBOX_ADVISORY]).filter(Boolean);
const providerProblem = (e) => ({ code: e.code, reason: e.details?.reason ?? null, message: e.message, ...(e.details?.capabilities ? { capabilities: e.details.capabilities } : {}) });
/** The names a status or sync reads: every declared sandbox, then every name this deployment started
 *  that the workspace no longer declares (D-S1-1). */
function namesOf(ctx, started) {
  return [...new Set([...ctx.declared.keys(), ...started.filter((n) => !ctx.declared.has(n))])];
}
/** `oats sandbox status --json` (C5). Read-only: the provider's `status` for each declared sandbox. */
export async function sandboxStatus(ctx) {
  let provider = null, missing = null;
  try { provider = await sandboxProvider(ctx); } catch (e) { if (e?.code !== "E_SANDBOX_PROVIDER") throw e; missing = providerProblem(e); }
  const sandboxes = [];
  for (const name of ctx.declared.keys()) {
    if (!provider) { sandboxes.push(statusEntry(ctx, name, null, [missing])); continue; }
    sandboxes.push(statusEntry(ctx, name, await sandboxAct(ctx, provider, name, "status")));
  }
  return { sandboxApi: SANDBOX_API, host: ctx.host, sandboxes };
}

/** The kernel's own refusals of a start (C10's table, the kernel's rows), before any act. */
async function assertStartable(ctx, name, { list } = {}) {
  if (!ctx.declared.has(name)) sandboxRequest(ctx, name, "start"); // E_WORKSPACE_SCHEMA sandbox-unknown
  if (!ctx.listed.includes(name)) throw fail("E_SANDBOX_NOT_HERE", `sandbox ${name} is not listed in this deployment's oats-local.yaml sandboxes:, so it does not run here; nothing was done — list it there to run it on this machine`, { reason: SANDBOX_REASONS.notListed, sandbox: name, localKey: "sandboxes" });
  const team = teamOf(ctx, name);
  if (team.id === null) throw fail("E_SANDBOX_TEAM", `sandbox ${name}'s team ${team.label} has no provider id yet: its owner runs \`oats aweb setup\`, then commits the id in oats-workspace.yaml teams:; nothing was done`, { reason: SANDBOX_REASONS.teamNotCreated, sandbox: name, team: team.label });
  for (const n of ctx.declared.get(name).credentials ?? []) {
    const path = credentialPath(ctx, n);
    if (path === null) throw fail("E_SANDBOX_CREDENTIAL", `sandbox ${name} declares credential ${n}, which this deployment's oats-local.yaml credentials: does not give: add \`${n}: { fromFile: /absolute/path }\` there; nothing was done`, { reason: SANDBOX_REASONS.noSource, sandbox: name, credential: n });
    if (!existsSync(path)) throw fail("E_SANDBOX_CREDENTIAL", `sandbox ${name}'s credential ${n} is to be read from ${path}, which does not exist: put the file there, or correct credentials.${n}.fromFile; nothing was done`, { reason: SANDBOX_REASONS.missing, sandbox: name, credential: n, path });
  }
  const homes = await hostHomes(ctx, { list });
  const running = homes.find((h) => h.running), unreadable = homes.find((h) => h.unreadable);
  if (running) throw hostAgentRefusal(SANDBOX_REASONS.hostHomeRunning, `sandbox ${name} was not started: ${running.instance} runs on the host (${running.home})`, { sandbox: name, instance: running.instance, home: running.home });
  if (unreadable) throw hostAgentRefusal(SANDBOX_REASONS.hostHomeUnreadable, `sandbox ${name} was not started: whether ${unreadable.instance} runs on the host cannot be read (${unreadable.home})`, { sandbox: name, instance: unreadable.instance, home: unreadable.home });
}
/** C5's answers. */
const planAnswer = (name, act, plan) => ({ sandboxApi: SANDBOX_API, sandbox: name, act, planRevision: plan.planRevision, actions: plan.actions });
const applyAnswer = (name, act, answer, problems = []) => ({ sandboxApi: SANDBOX_API, sandbox: name, act, state: answer.state, server: serverOf(answer), receipts: answer.receipts ?? [], problems: [...problems, ...problemsOf(answer)] });
/** A plan answered by the provider, or the refusal of its failure. */
function planOrFail(name, target, plan) {
  // A stale plan answer carries its fresh plan (C4, answerProblem checks it): E_PLAN_STALE, as an apply's.
  if (plan.state === "stale") throw planStale(name, target, plan);
  if (plan.state === "failed" || plan.state === "unknown") {
    const p = plan.problem ?? {};
    throw fail(p.code || "E_SANDBOX_PROVIDER", `sandbox ${name}: the provider could not plan ${target}: ${p.message ?? plan.state}${p.remedy ? ` — ${p.remedy}` : ""}`, { sandbox: name, target, state: plan.state, problem: plan.problem ?? null });
  }
  return plan;
}

/**
 * `oats sandbox start|stop <name> (--plan | --plan-revision <r> --idempotency-key <k>)` (C5). A start
 * records the name before its act runs (D-S1-1); a stop that answers `stopped` or `absent` drops it.
 * → the plan answer or the apply answer.
 */
export async function sandboxLifecycle(ctx, name, act, { plan = false, planRevision = null, idempotencyKey = null, list } = {}) {
  const provider = await sandboxProvider(ctx);
  if (act === "start") await assertStartable(ctx, name, { list });
  else sandboxRequest(ctx, name, "plan", { target: act }); // an undeclared name: only stop
  if (plan) return planAnswer(name, act, planOrFail(name, act, await sandboxAct(ctx, provider, name, "plan", { target: act })));
  const answer = await sandboxAct(ctx, provider, name, act, { planRevision, idempotencyKey }, {
    before: act === "start" ? () => updateStarted(ctx, (names) => [...names, name]) : undefined,
    after: act === "stop" ? (a) => { if (a.state === "stopped" || a.state === "absent") updateStarted(ctx, (names) => names.filter((n) => n !== name)); } : undefined,
  });
  if (answer.state === "stale") throw planStale(name, act, answer);
  return applyAnswer(name, act, answer);
}

/* ───────────────────────────── the kept request (step 3) ──────────────── */

/** The clock of the kept requests' ages; `OATS_TEST_NOW_MS` is a test's injected clock. */
const now = () => (process.env.OATS_TEST_NOW_MS && /^\d+$/.test(process.env.OATS_TEST_NOW_MS) ? Number(process.env.OATS_TEST_NOW_MS) : Date.now());

const SPAWN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Where the routed request of one spawn is kept until its seat settles: beside the server's route
 *  snapshots, `~/.oats/remote/<server>/pending/<spawnKey>.json`, 0600 in a 0700 directory. Its content
 *  (the task text among it) never reaches a receipt, a log, an event, the ledger or a readiness line; the
 *  provider never reads it: the kernel replays it. */
async function pendingDir(server) {
  const { REMOTE_SNAPSHOT_DIR } = await import("./servers.mjs");
  return join(REMOTE_SNAPSHOT_DIR(), server, "pending");
}
async function keptPath(server, spawnKey) {
  if (!SPAWN_KEY_RE.test(String(spawnKey))) throw new TypeError(`bad spawn key ${JSON.stringify(spawnKey)}`);
  return join(await pendingDir(server), `${spawnKey}.json`);
}
export async function writeKept(kept) {
  const { mkdirSync, chmodSync } = await import("node:fs");
  const dir = await pendingDir(kept.server);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileAtomic(await keptPath(kept.server, kept.spawnKey), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
}
/** A kept request's in-flight lock (lib/dir-lock.mjs), in `pending.locks/` beside the server's `pending/`
 *  (which holds the kept requests and nothing else): its spawn holds it from writeKept until
 *  bindKept has settled the request, and a reconcile handles the request only while it holds it. So a
 *  request whose spawn is still in flight (between seat and bind, where the sandbox's home that holds the
 *  seat is not yet visible to the key's recovery) is never replayed or bound by anyone else. A holder that
 *  is gone (killed, exited) leaves it, and the next taker takes it over: its request is replayable again. */
async function keptLockPath(server, spawnKey) {
  if (!SPAWN_KEY_RE.test(String(spawnKey))) throw new TypeError(`bad spawn key ${JSON.stringify(spawnKey)}`);
  return join(dirname(await pendingDir(server)), "pending.locks", `${spawnKey}.lock`);
}
const IN_FLIGHT = Symbol("kept request in flight");
/** Take kept request `kept`'s lock → its release, or IN_FLIGHT when another process holds it (or whether
 *  its holder runs cannot be established). */
async function takeKeptLock(kept, what) {
  const { mkdirSync, chmodSync } = await import("node:fs");
  const dir = dirname(await keptLockPath(kept.server, kept.spawnKey));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const busy = () => Object.assign(new Error("in flight"), { [IN_FLIGHT]: true });
  try { return acquireDirLock(await keptLockPath(kept.server, kept.spawnKey), { what }, { retryMs: 0, busy }); }
  catch (e) { if (e?.[IN_FLIGHT]) return IN_FLIGHT; throw e; }
}
export async function deleteKept(kept) {
  const { rmSync } = await import("node:fs");
  rmSync(await keptPath(kept.server, kept.spawnKey), { force: true });
}
/** Every kept request of this deployment (all servers), each read whole: [{ kept } | { unreadable, path }]. */
export async function listKept(ctx) {
  const { REMOTE_SNAPSHOT_DIR } = await import("./servers.mjs");
  const { readdirSync } = await import("node:fs");
  const root = REMOTE_SNAPSHOT_DIR(), out = [];
  let servers = [];
  try { servers = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const server of servers) {
    const dir = join(root, server, "pending");
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      let kept;
      try { kept = JSON.parse(readFileSync(path, "utf8")); } catch { out.push({ unreadable: true, path, server, spawnKey: f.slice(0, -5) }); continue; }
      if (isObject(kept) && kept.pendingApi === 1 && kept.deployment === ctx.deployment) out.push({ kept, path });
    }
  }
  return out;
}

/* ───────────────────────────── the routed spawn (steps 1–6) ───────────── */

/** The features a sandbox's kernel must advertise for a routed spawn (Done when 12, #1912's floor): the
 *  task on stdin, a preview-bound apply, a keyed apply, and sandboxes itself. */
export const ROUTED_SANDBOX_FEATURES = Object.freeze(["sandboxes", "spawn-task-stdin", "spawn-preview-2", "spawn-apply-2", "spawn-idempotency-2"]);
const isLinkFailure = (e) => (e?.code === "E_SSH" && e.details?.sshStarted !== false) || e?.code === "E_REMOTE_ENVELOPE";
/** Whether the routed apply's refusal is terminal by the record's release rows: a replay of it can never
 *  spawn (E_DECISION_STALE; a required hook's failure whose rollback confirmed the home gone). */
const terminalRefusal = (apply) => isObject(apply) && apply.ok === false && isObject(apply.error)
  && (apply.error.code === "E_DECISION_STALE" || ((apply.error.code === "E_REQUIRED_HOOK_FAILED" || apply.error.code === "E_HOOK_ENVIRONMENT_CONTRACT") && apply.error.details?.unconfirmed !== true));
/** Send the kept apply through the server route → the host's answer as received, or null when none came
 *  back (a killed link, a host that ended without one, a refusal before anything was sent). */
async function sendApply(kept, io, { replay = false } = {}) {
  const { routeCommand } = await import("./servers.mjs");
  let raw = null;
  // The sandbox's floor is checked on the probe that sends it, every time (a replay too: its kernel may have
  // been rebuilt since): the task never travels as an argument.
  try { routeCommand(kept.server, "spawn", [...kept.argv, ...(kept.task !== null && kept.task !== undefined ? ["--task", kept.task] : [])], { ...io, replay, requireFeatures: ROUTED_SANDBOX_FEATURES, onAnswer: (envelope) => { raw = envelope; } }); }
  catch (e) { if (!isLinkFailure(e) && raw === null) return { raw: null, error: e, unsent: e?.code === "E_REMOTE_INCOMPATIBLE" }; }
  return { raw };
}
/** An apply that was never sent (the sandbox's kernel is below the floor): the request stays kept, with
 *  why, for the next reconcile; nothing reaches bind, since nothing happened there. */
async function keepUnsent(kept, error) {
  await writeKept({ ...kept, lastApply: { code: typeof error?.code === "string" ? error.code : "refused", at: new Date(now()).toISOString(), sent: false } });
}
/** A bind (or its plan) the provider answered failed or unknown: the request stays kept, and this says so.
 *  → a problem row, or null for any other answer. */
function bindProblem(name, kept, bound) {
  if (!["failed", "unknown"].includes(bound?.state)) return null;
  const p = bound.problem ?? {};
  return { code: p.code ?? "E_SANDBOX_PROVIDER", ...(p.reason ? { reason: p.reason } : {}), sandbox: name, message: `sandbox ${name}: the bind of ${kept.instance}'s seat answered ${bound.state}${p.message ? `: ${p.message}` : ""}; the request is kept, and \`oats sandbox reconcile ${name}\` binds it` };
}
/** A bind the provider answered stale: the request stays kept (the next reconcile binds it), and the
 *  refusal says the apply already ran in the sandbox, so it is not an effect-free plan refusal. */
function bindStale(name, kept, answer, apply) {
  const applied = apply === null ? "came back with no answer" : apply.ok === true ? "was applied in the sandbox" : `answered ${apply.error?.code ?? "a refusal"}`;
  return fail("E_PLAN_STALE", `sandbox ${name}: the spawn of ${kept.instance} ${applied}, but the bind of its seat answered stale (the provider's state changed since its plan); the request is kept: \`oats sandbox reconcile ${name}\` binds it`, { sandbox: name, act: "bind", plan: answer.plan ?? null, instance: kept.instance, spawnKey: kept.spawnKey, applied: apply?.ok === true });
}
/** Step 6: hand the apply's answer, unchanged, to `bind` (C4), and settle the kept request: it goes when
 *  the seat is `active` or `released`, or when the refusal was terminal; it stays otherwise (a link
 *  failure, E_IDEMPOTENCY_CONFLICT, E_SPAWN_INCOMPLETE, an unconfirmed hook failure: the next reconcile
 *  replays it). → bind's answer. */
async function bindKept(ctx, provider, kept, apply) {
  const instance = { name: kept.instance, spawnKey: kept.spawnKey };
  const bindPlan = await sandboxAct(ctx, provider, kept.sandbox, "plan", { target: "bind", instance });
  if (!validPlan(bindPlan)) return bindPlan;
  const bound = await sandboxAct(ctx, provider, kept.sandbox, "bind", { planRevision: bindPlan.planRevision, idempotencyKey: freshKey(), instance, apply });
  const state = bound.seat?.state;
  if (bound.state !== "stale" && (state === "active" || state === "released" || terminalRefusal(apply))) await deleteKept(kept);
  // Kept: what its last apply answered, for readiness's last-replay rule (C10 sandbox-seat-unsettled).
  else await writeKept({ ...kept, lastApply: { code: apply === null ? null : apply.ok === true ? "ok" : (typeof apply.error?.code === "string" ? apply.error.code : "refused"), at: new Date(now()).toISOString() } });
  return bound;
}
/** The provider's problem as the kernel's refusal. */
function providerRefusal(name, what, answer) {
  const p = answer.problem ?? {};
  return fail(p.code || "E_SANDBOX_PROVIDER", `sandbox ${name}: ${what} answered ${answer.state}${p.message ? `: ${p.message}` : ""}${p.remedy ? ` — ${p.remedy}` : ""}`, { sandbox: name, state: answer.state, problem: answer.problem ?? null, ...(p.reason ? { reason: p.reason } : {}) });
}

/**
 * A spawn of a soul placed in sandbox `name`, on a host that lists it (the record, "The exact order of a
 * routed spawn"). `args` are the spawn's arguments as a server route forwards them (no --server, --dir or
 * --json; the task out of them, in `task`); `soul` the soul's name as the host spawns it. A `--preview`
 * runs steps 1 and 2 only and mints nothing. → { envelope, stderr, bound?, seat? }: the host's answer,
 * relayed as a routed spawn relays it.
 */
export async function routedSandboxSpawn(ctx, name, { soul, args, task = null, io = {} } = {}) {
  // D-S1-4: the kernel binds and keys a sandboxed spawn itself (steps 1–5): a caller's own decision or key
  // could never match the seat it mints for the spawn. Refused before any provider act, kept file or seat.
  const callerFlags = ["--expect-decision", "--idempotency-key"].filter((f) => args.includes(f));
  if (callerFlags.length && !args.includes("--preview")) {
    const remedy = `Spawn it with \`oats spawn ${soul}\` (OATS binds it to the sandbox itself) or from a schedule; the Desktop can't spawn into a sandbox yet.`;
    throw fail("E_SANDBOX_PLACEMENT", `${soul} runs in sandbox ${name}, and a spawn into a sandbox is bound and keyed by OATS, never by its caller (${callerFlags.join(", ")}); nothing was minted, kept or spawned — ${remedy}`, { reason: SANDBOX_REASONS.callerBound, sandbox: name, flags: callerFlags, remedy });
  }
  const provider = await sandboxProvider(ctx);
  const team = teamOf(ctx, name);
  if (team.id === null) throw fail("E_SANDBOX_TEAM", `${soul} runs in sandbox ${name}, whose team ${team.label} has no provider id yet: its owner runs \`oats aweb setup\`, then commits the id in oats-workspace.yaml teams:; nothing was spawned`, { reason: SANDBOX_REASONS.teamNotCreated, sandbox: name, team: team.label });
  const status = await sandboxAct(ctx, provider, name, "status");
  if (status.state !== "ready" || !serverOf(status)) {
    throw fail("E_SANDBOX_NOT_HERE", `${soul} runs in sandbox ${name}, which this host lists but whose provider answers ${status.state}${serverOf(status) ? "" : " with no server"}: start it (\`oats sandbox start ${name}\`, or \`oats sync\`), then spawn again; nothing was spawned, here or there`, { reason: SANDBOX_REASONS.notRunning, sandbox: name, state: status.state, problem: status.problem ?? null });
  }
  const server = serverOf(status);
  const { checkRemote, getServer, routeCommand, targetOf } = await import("./servers.mjs");
  const target = targetOf(getServer(server));
  const remote = checkRemote(target, io);
  const missing = ROUTED_SANDBOX_FEATURES.filter((f) => !remote.features.includes(f));
  if (missing.length) throw fail("E_REMOTE_INCOMPATIBLE", `sandbox ${name}'s oats (${remote.version} at ${server}) does not advertise ${missing.join(", ")}: a spawn into a sandbox needs its task on stdin and an apply bound to its preview and keyed; upgrade the sandbox's image; nothing was sent`, { sandbox: name, server, missing });
  // 1. The seat plan: read-only, the seat derived from the spawn key.
  const spawnKey = randomUUID();
  const seatPlan = planOrFail(name, "seat", await sandboxAct(ctx, provider, name, "plan", { target: "seat", instance: { soul, spawnKey } }));
  const { capability, options } = seatPlan.spawnProvider;
  const providerArgs = Object.entries(options).flatMap(([k, v]) => ["--provider", capability, `${k}=${v}`]);
  // The seat's options are the host's: a caller's --provider pair for the same capability and key is
  // dropped, so the sandbox's spawn, its argv and the kept request name only the seat the host took.
  const callerArgs = withoutProviderKeys(args, capability, Object.keys(options));
  const preview = args.includes("--preview");
  const withTask = (list) => [...list, ...(task !== null ? ["--task", task] : [])];
  // 2. The remote preview, with the seat's options: it names the instance and answers D.
  const base = [...callerArgs.filter((a) => a !== "--preview"), ...providerArgs];
  const previewed = routeCommand(server, "spawn", withTask([...base, "--preview"]), { ...io, requireFeatures: ROUTED_SANDBOX_FEATURES });
  if (preview) return previewed;
  const shown = previewed.envelope?.result;
  if (!(previewed.envelope?.ok && shown?.preview === true && typeof shown.decision?.revision === "string" && typeof shown.instance === "string")) return previewed;
  const decision = shown.decision.revision;
  // The apply names the instance the preview showed (D binds the name, its home and its branch, so D is
  // unchanged): a replay can only meet that instance's own keyed home, or a name- or placement-taken
  // refusal (E_INSTANCE_NAME_TAKEN, E_PLACEMENT_TAKEN), never the next number (a --purpose, --suggest-name or
  // unnamed spawn's).
  const argv = [...(base.includes("--name") ? base : [...withoutPurpose(base).filter((a) => a !== "--suggest-name"), "--name", shown.instance]), "--expect-decision", decision, "--idempotency-key", spawnKey];
  // 3. The whole routed request is kept before anything is minted.
  const kept = { pendingApi: 1, deployment: ctx.deployment, server, sandbox: name, soul, spawnKey, decision, instance: shown.instance, seat: { id: seatPlan.seat.id, path: seatPlan.seat.path ?? null }, argv, spawnProvider: seatPlan.spawnProvider, task, createdAt: new Date(now()).toISOString() };
  // In flight from here until bind has settled it: no reconcile replays or binds it meanwhile.
  const release = await takeKeptLock(kept, `oats spawn ${soul} into sandbox ${name}`);
  if (release === IN_FLIGHT) throw new Error(`the fresh spawn key ${spawnKey}'s lock is held`); // a fresh UUID: unreachable
  try { return await inFlight(); } finally { release(); }
  async function inFlight() {
  await writeKept(kept);
  // 4. The seat: minted on the host, delivered into the sandbox.
  const seat = await sandboxAct(ctx, provider, name, "seat", { planRevision: seatPlan.planRevision, idempotencyKey: spawnKey, instance: { name: shown.instance, soul, spawnKey, decision } });
  if (seat.state === "stale") { await deleteKept(kept); throw planStale(name, "seat", seat); }
  if (seat.state === "failed") { await deleteKept(kept); throw providerRefusal(name, "the seat", seat); }
  if (seat.state === "unknown") throw providerRefusal(name, "the seat (kept for `oats sandbox reconcile`, which settles it)", seat);
  // 5. The apply, bound to D and keyed by the spawn key, from the kept request.
  const sent = await sendApply(kept, io);
  if (sent.unsent) { await keepUnsent(kept, sent.error); throw Object.assign(sent.error, { details: { ...(sent.error.details ?? {}), sandbox: name } }); }
  // 6. Its answer, unchanged, to bind.
  const bound = await bindKept(ctx, provider, kept, sent.raw);
  if (bound.state === "stale") throw bindStale(name, kept, bound, sent.raw);
  if (sent.error) throw sent.error;
  if (sent.raw === null) throw fail("E_SSH", `sandbox ${name}: the spawn's apply came back with no answer; its seat stays delivered and the request is kept: \`oats sandbox reconcile ${name}\` (or the next \`oats sync\`) replays it`, { sandbox: name, server, spawnKey, instance: shown.instance });
  const unbound = bindProblem(name, kept, bound);
  const seatWarning = unbound ? unbound.message
    : bound.seat?.state && bound.seat.state !== "active" ? `sandbox ${name}: the seat answered ${bound.seat.state}, not active; \`oats sandbox status ${name}\` shows it` : null;
  const envelope = sent.raw.ok && isObject(sent.raw.result) ? { ...sent.raw, result: { ...sent.raw.result, server, target, ...(seatWarning ? { warnings: [...(sent.raw.result.warnings || []), seatWarning] } : {}) } } : sent.raw;
  return { envelope, stderr: previewed.stderr ?? "", seat: bound.seat ?? null };
  }
}
/** `args` without `--purpose <slug>`. */
function withoutPurpose(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === "--purpose") { i += 1; continue; } out.push(args[i]); }
  return out;
}

/* ───────────────────────────── reconcile (step 7) ─────────────────────── */

/**
 * `oats sandbox reconcile <name>` and sync's seat pass (C5, step 7): the provider's `reconcile` first, then
 * the replay of each kept request whose seat that answer shows `delivered` — never one whose entry is
 * `minting` or `mint-uncertain`; one whose seat was released (or is active) is deleted. A replay is the
 * kept request unchanged, with its spawn key, and its answer goes to bind. → the apply answer, with
 * `seats` and `replays`.
 */
export async function reconcileSandbox(ctx, name, { plan = false, planRevision = null, idempotencyKey = null, provider: given = null, io = {} } = {}) {
  const provider = given ?? await sandboxProvider(ctx);
  sandboxRequest(ctx, name, "reconcile");
  if (plan) return planAnswer(name, "reconcile", planOrFail(name, "reconcile", await sandboxAct(ctx, provider, name, "plan", { target: "reconcile" })));
  const answer = await sandboxAct(ctx, provider, name, "reconcile", { planRevision, idempotencyKey });
  if (answer.state === "stale") throw planStale(name, "reconcile", answer);
  const replays = [], problems = [];
  const seats = Array.isArray(answer.seats) ? answer.seats : null;
  if (seats && !["failed", "unknown"].includes(answer.state)) {
    for (const { kept } of (await listKept(ctx)).filter((k) => k.kept?.sandbox === name)) {
      // Its spawn still in flight (it holds the request's lock): nothing is done to it, nor in its name.
      const release = await takeKeptLock(kept, `oats sandbox reconcile ${name}`);
      if (release === IN_FLIGHT) { replays.push({ spawnKey: kept.spawnKey, instance: kept.instance, seat: kept.seat?.id ?? null, outcome: "held-in-flight" }); continue; }
      try { await reconcileKept(kept); } finally { release(); }
    }
  }
  async function reconcileKept(kept) {
    {
      const entry = seats.find((s) => s.seatId === kept.seat?.id);
      if (!entry) { replays.push({ spawnKey: kept.spawnKey, instance: kept.instance, seat: kept.seat?.id ?? null, outcome: "no-ledger-entry" }); return; }
      if (entry.state === "released" || entry.state === "active") { await deleteKept(kept); replays.push({ spawnKey: kept.spawnKey, instance: kept.instance, seat: entry.seatId, outcome: `deleted-${entry.state}` }); return; }
      if (entry.state !== "delivered") { replays.push({ spawnKey: kept.spawnKey, instance: kept.instance, seat: entry.seatId, outcome: `held-${entry.state}` }); return; }
      // A sandbox this host no longer lists runs nothing of this host's: its delivered seat is reported
      // (readiness, sandbox-seat-unsettled), never replayed blind (Edge cases).
      if (!ctx.listed.includes(name)) { replays.push({ spawnKey: kept.spawnKey, instance: kept.instance, seat: entry.seatId, outcome: "held-unlisted" }); return; }
      const sent = await sendApply(kept, io, { replay: true });
      if (sent.unsent) { await keepUnsent(kept, sent.error); replays.push({ spawnKey: kept.spawnKey, instance: kept.instance, seat: entry.seatId, outcome: "held-unsent", apply: sent.error.code }); problems.push({ code: sent.error.code, sandbox: name, message: `sandbox ${name}: the replay of ${kept.instance} was not sent: ${sent.error.message}` }); return; }
      const bound = await bindKept(ctx, provider, kept, sent.raw);
      const replay = { spawnKey: kept.spawnKey, instance: kept.instance, seat: entry.seatId, outcome: "replayed", apply: sent.raw === null ? null : (sent.raw.ok ? "ok" : sent.raw.error?.code ?? "refused"), bound: bound.seat?.state ?? bound.state };
      if (bound.state === "stale") { const e = bindStale(name, kept, bound, sent.raw); replay.plan = e.details.plan; problems.push({ code: e.code, sandbox: name, message: e.message }); }
      const unbound = bindProblem(name, kept, bound);
      if (unbound) problems.push(unbound);
      replays.push(replay);
    }
  }
  // What its replays met (a sandbox below the floor, a stale bind) joins the act's own problems.
  const out = applyAnswer(name, "reconcile", answer);
  return { ...out, problems: [...out.problems, ...problems], seats: seats ?? [], replays };
}

/* ───────────────────────────── retire (the host's release) ────────────── */

/** After a host retire of a sandboxed instance (the routed retire succeeded): the provider's `release`,
 *  reason `retired`, for its seat (the record, Lifecycle), the seat ID read from the provider's `status`
 *  (its seat whose instance is the one retired). → the release answer, or null when the status names no
 *  seat of that instance (the next reconcile settles it). */
export async function releaseRetiredSeat(ctx, name, { instance }) {
  const provider = await sandboxProvider(ctx);
  const status = await sandboxAct(ctx, provider, name, "status");
  const seat = (Array.isArray(status.seats) ? status.seats : []).find((s) => s.instance === instance && s.state !== "released");
  if (!seat) return null;
  const inst = { name: instance, seatId: seat.seatId };
  const plan = await sandboxAct(ctx, provider, name, "plan", { target: "release", instance: inst });
  if (!validPlan(plan)) return plan;
  return sandboxAct(ctx, provider, name, "release", { planRevision: plan.planRevision, idempotencyKey: freshKey(), instance: inst, reason: "retired" });
}

/* ───────────────────────────── sync ───────────────────────────────────── */

/** C5: sync's action for a listed sandbox, from its `status` and the plan of its start (Q2, decided): a
 *  build when it is absent or the plan renders; none when it runs and the plan has nothing to do; a start
 *  otherwise. */
export function syncAction(status, startPlan) {
  const actions = Array.isArray(startPlan?.actions) ? startPlan.actions : [];
  if (status?.state === "absent" || actions.some((a) => a?.step === "render")) return "build";
  if (status?.state === "ready" && actions.length === 0) return "none";
  return "start";
}
const failedState = (s) => ["failed", "unknown", "stale"].includes(s);
const problemOfError = (name, e) => ({ code: e?.code ?? "E_SANDBOX_PROVIDER", ...(e?.details?.reason ? { reason: e.details.reason } : {}), sandbox: name, message: e?.message ?? String(e) });

/**
 * `oats sync`'s sandbox pass ("What sync does"), after the lock, the package souls and the automation
 * snapshot: each listed sandbox built, started or left; each recorded one no longer listed stopped (never
 * destroyed); then each listed running sandbox's seats reconciled (step 7). `plan`: the actions, performed
 * nowhere. → null when this deployment neither lists nor recorded a sandbox (sync's answer is then as
 * before), else { sandboxes: [entry + action], problems, failed }.
 */
export async function syncSandboxes(ctx, { plan = false, list, io = {} } = {}) {
  const started = readStarted(ctx);
  const delisted = started.filter((n) => !ctx.listed.includes(n));
  if (!ctx.listed.length && !delisted.length) return null;
  const problems = [], sandboxes = [];
  let provider = null;
  try { provider = await sandboxProvider(ctx); }
  catch (e) {
    if (e?.code !== "E_SANDBOX_PROVIDER") throw e;
    for (const name of [...ctx.listed, ...delisted]) {
      sandboxes.push({ ...statusEntry(ctx, name, null, [providerProblem(e)]), action: ctx.listed.includes(name) ? "none" : "stop" });
      problems.push(problemOfError(name, e));
    }
    return { sandboxes, problems, failed: true, warnings: [] };
  }
  for (const name of ctx.listed) {
    const status = await sandboxAct(ctx, provider, name, "status");
    const startPlan = await sandboxAct(ctx, provider, name, "plan", { target: "start" });
    const action = failedState(startPlan.state) ? "start" : syncAction(status, startPlan);
    if (plan) { sandboxes.push({ ...statusEntry(ctx, name, status), action }); continue; }
    let state = status;
    // A listed sandbox that already runs is recorded too (D-S1-1): delisting it later stops it.
    if (action === "none" && status.state === "ready" && !started.includes(name)) updateStarted(ctx, (names) => [...names, name]);
    if (action !== "none") {
      try {
        if (failedState(startPlan.state)) throw providerRefusal(name, "the start plan", startPlan);
        const applied = await sandboxLifecycle(ctx, name, "start", { planRevision: startPlan.planRevision, idempotencyKey: freshKey(), list });
        state = { ...status, state: applied.state, server: applied.server ?? serverOf(status), problem: applied.problems[0] };
        if (failedState(applied.state)) problems.push({ code: applied.problems[0]?.code ?? "E_SANDBOX_PROVIDER", sandbox: name, message: `sandbox ${name}: its start answered ${applied.state}${applied.problems[0]?.message ? `: ${applied.problems[0].message}` : ""}` });
      } catch (e) { problems.push(problemOfError(name, e)); sandboxes.push({ ...statusEntry(ctx, name, status, [problemOfError(name, e)]), action }); continue; }
    }
    const entry = { ...statusEntry(ctx, name, state), action };
    // D-S1-3: the status's advisory is a warning still when the start's answer replaced its problem.
    if (state !== status && isAdvisory(status) && !entry[SANDBOX_ADVISORY]) entry[SANDBOX_ADVISORY] = statusEntry(ctx, name, status)[SANDBOX_ADVISORY];
    // The seat pass, whatever the action: a self-retire is completed by the next sync even when nothing
    // else changed.
    if (state.state === "ready") {
      try {
        const rplan = planOrFail(name, "reconcile", await sandboxAct(ctx, provider, name, "plan", { target: "reconcile" }));
        const reconciled = await reconcileSandbox(ctx, name, { planRevision: rplan.planRevision, idempotencyKey: freshKey(), provider, io });
        entry.seats = reconciled.seats;
        if (failedState(reconciled.state)) {
          const p = reconciled.problems[0] ?? {};
          problems.push({ code: p.code ?? "E_SANDBOX_PROVIDER", ...(p.reason ? { reason: p.reason } : {}), sandbox: name, message: `sandbox ${name}: its reconcile answered ${reconciled.state}${p.message ? `: ${p.message}` : ""}${p.remedy ? ` — ${p.remedy}` : ""}` });
        }
        for (const p of reconciled.problems.filter((x) => x.sandbox === name)) problems.push(p);
      } catch (e) { problems.push(problemOfError(name, e)); entry.problems.push(problemOfError(name, e)); }
    }
    sandboxes.push(entry);
  }
  for (const name of delisted) {
    const declared = ctx.declared.has(name);
    const entry = (st) => ({ ...(declared ? statusEntry(ctx, name, st) : { name, team: null, listedHere: false, state: st?.state ?? "unknown", server: serverOf(st), egress: [], credentials: [], problems: problemsOf(st), seats: [] }), action: "stop" });
    if (plan) { sandboxes.push(entry(declared ? await sandboxAct(ctx, provider, name, "status") : null)); continue; }
    try {
      const stopPlan = await sandboxAct(ctx, provider, name, "plan", { target: "stop" });
      if (failedState(stopPlan.state)) throw providerRefusal(name, "the stop plan", stopPlan);
      const stopped = await sandboxLifecycle(ctx, name, "stop", { planRevision: stopPlan.planRevision, idempotencyKey: freshKey() });
      sandboxes.push({ ...entry({ state: stopped.state, server: stopped.server, problem: stopped.problems[0] }) });
      if (!["stopped", "absent"].includes(stopped.state)) problems.push({ code: stopped.problems[0]?.code ?? "E_SANDBOX_PROVIDER", sandbox: name, message: `sandbox ${name} was delisted, and its stop answered ${stopped.state}: it stays recorded, and the next sync stops it again; nothing was destroyed` });
    } catch (e) { problems.push(problemOfError(name, e)); sandboxes.push({ ...entry(null), problems: [problemOfError(name, e)] }); }
  }
  // A failure of a sandbox is in its own entry too, whatever pass met it: a reader of the entries (the
  // client's exit-1 rule, packages/client/workspace-cli.mjs) sees every failed sandbox.
  for (const p of problems) {
    const e = sandboxes.find((x) => x.name === p.sandbox);
    if (e && !e.problems.some((x) => x.code === p.code)) { const { sandbox, ...row } = p; e.problems.push(row); }
  }
  return { sandboxes, problems, failed: problems.length > 0, warnings: advisoryWarnings(sandboxes) };
}

/* ───────────────────────────── C10: readiness ─────────────────────────── */

/** A kept request older than this is stale (C10 sandbox-pending-stale). */
export const PENDING_STALE_MS = 24 * 60 * 60 * 1000;
/** The last apply codes that leave a delivered seat unsettled (C10, the last-replay rule). */
const UNSETTLING_CODES = new Set(["E_IDEMPOTENCY_CONFLICT", "E_SPAWN_INCOMPLETE"]);

/**
 * The C10 readiness items of a deployment that lists a sandbox or keeps a routed request: each
 * `{ code, subject, reason, remedy, sandbox? }`, a problem found (an empty list when there is none).
 * Read-only: the provider's `status` (never a mutating act), the kernel's own state (the local file,
 * the host homes, the kept requests). A kept request is read for its spawn key, its age and its last
 * apply's code only; its content (the task) never reaches an item. Refuses nothing.
 */
export async function sandboxReadiness(ctx, { list } = {}) {
  const out = [];
  const add = (code, subject, reason, remedy, extra = {}) => out.push({ code, subject, reason, remedy, ...extra });
  const kept = await listKept(ctx);
  const at = now();
  for (const k of kept) {
    if (k.unreadable) { add("sandbox-pending-stale", `kept spawn ${k.spawnKey}`, `the kept routed request of spawn ${k.spawnKey} cannot be read`, `remove ${k.path} once its seat is settled (\`oats sandbox status\`)`, { spawnKey: k.spawnKey }); continue; }
    const created = Date.parse(k.kept.createdAt);
    if (Number.isFinite(created) && at - created > PENDING_STALE_MS) add("sandbox-pending-stale", `kept spawn ${k.kept.spawnKey}`, `the routed spawn ${k.kept.spawnKey} into sandbox ${k.kept.sandbox} has been kept for more than 24 hours without its seat settling`, `\`oats sandbox reconcile ${k.kept.sandbox}\` replays it if its seat is delivered; \`oats sandbox status ${k.kept.sandbox}\` shows the seat`, { sandbox: k.kept.sandbox, spawnKey: k.kept.spawnKey });
  }
  // A kept request for a sandbox this host no longer lists (or the workspace no longer declares) is never
  // replayed: it is reported until someone settles its seat (Edge cases).
  for (const { kept: k, path } of kept.filter((x) => x.kept && !ctx.listed.includes(x.kept.sandbox))) {
    add("sandbox-seat-unsettled", `kept spawn ${k.spawnKey}`, `the routed spawn ${k.spawnKey} into sandbox ${k.sandbox} is kept, and this host no longer lists that sandbox, so it is never replayed`, `list ${k.sandbox} again under sandboxes: in oats-local.yaml and run \`oats sandbox reconcile ${k.sandbox}\`, or check the team's members for ${k.instance ?? k.spawnKey} (\`oats aweb roster\`) and remove ${path} once its seat is settled`, { sandbox: k.sandbox, spawnKey: k.spawnKey });
  }
  if (!ctx.listed.length) return out;
  let provider = null;
  try { provider = await sandboxProvider(ctx); }
  catch (e) { if (e?.code !== "E_SANDBOX_PROVIDER") throw e; add("sandbox-provider-missing", "sandbox provider", e.message, e.details?.reason === SANDBOX_REASONS.providerAmbiguous ? "turn all but one sandbox provider off in oats-workspace.yaml defaults.capabilities" : "add the sandbox provider (oats.aweb-sandbox) to defaults.capabilities in oats-workspace.yaml, then `oats sync`"); }
  const homes = await hostHomes(ctx, { list });
  if (homes.length) add("sandbox-host-agents", "host instances", `this deployment lists a sandbox, and ${homes.length} instance${homes.length === 1 ? "" : "s"} live${homes.length === 1 ? "s" : ""} on the host: ${homes.map((h) => h.instance).join(", ")}`, `retire them (\`oats retire <instance>\`), or run them from another deployment — ${HOST_AGENT_REMEDY}`, { instances: homes.map((h) => h.instance) });
  for (const name of ctx.listed) {
    if (!ctx.declared.has(name)) continue; // the local file's own refusal (sandbox-unknown) says it
    for (const c of credentialSources(ctx, name)) if (c.source === "missing") add("sandbox-credential-missing", `sandbox ${name} credential ${c.name}`, `sandbox ${name} declares credential ${c.name}, which this deployment's oats-local.yaml credentials: does not give, or whose file does not exist`, `add \`${c.name}: { fromFile: /absolute/path }\` under credentials: in oats-local.yaml, and put the file there`, { sandbox: name, credential: c.name });
    if (!provider) continue;
    const status = await sandboxAct(ctx, provider, name, "status");
    if (status.state !== "ready") add("sandbox-listed-not-running", `sandbox ${name}`, `sandbox ${name} is listed here, and its provider answers ${status.state}${status.problem?.message ? `: ${status.problem.message}` : ""}`, `\`oats sandbox start ${name}\`, or \`oats sync\``, { sandbox: name, state: status.state });
    const reason = status.problem?.reason;
    if (reason === SANDBOX_REASONS.sshIncludeMissing || reason === SANDBOX_REASONS.stateOrphaned) add(`sandbox-${reason}`, `sandbox ${name}`, status.problem.message ?? reason, status.problem.remedy ?? null, { sandbox: name });
    const mine = kept.filter((k) => k.kept?.sandbox === name).map((k) => k.kept);
    const ledger = Array.isArray(status.seats) ? status.seats : null;
    // A kept request whose seat the provider's ledger does not hold (only read off a status that has one).
    if (ledger && !["failed", "unknown"].includes(status.state)) for (const { kept: k, path } of kept.filter((x) => x.kept?.sandbox === name && !ledger.some((s) => s.seatId === x.kept.seat?.id))) {
      add("sandbox-seat-unsettled", `sandbox ${name} kept spawn ${k.spawnKey}`, `the routed spawn ${k.spawnKey} into sandbox ${name} is kept, and the provider's ledger has no entry for its seat ${k.seat?.id ?? "(none)"}, so it is never replayed`, `\`oats sandbox status ${name}\` shows the ledger; check the team's members for ${k.instance ?? k.spawnKey} (\`oats aweb roster\`), then remove ${path} once its seat is settled`, { sandbox: name, spawnKey: k.spawnKey });
    }
    for (const seat of ledger ?? []) {
      const k = mine.find((x) => x.seat?.id === seat.seatId);
      const unsettled = seat.state === "mint-uncertain" ? "its mint is uncertain"
        : seat.state === "delivered" && !k ? "it is delivered, and no routed request is kept for it"
        : seat.state === "delivered" && UNSETTLING_CODES.has(k.lastApply?.code) ? `its last replay answered ${k.lastApply.code}` : null;
      if (unsettled) add("sandbox-seat-unsettled", `sandbox ${name} seat ${seat.seatId}`, `sandbox ${name}'s seat ${seat.seatId}${seat.alias ? ` (${seat.alias})` : ""} is unsettled: ${unsettled}`, `check the team's members for ${seat.alias ?? seat.seatId} (\`oats aweb roster\`), then \`oats sandbox reconcile ${name}\`; a seat is released only on proof that no home holds it`, { sandbox: name, seatId: seat.seatId, ...(k ? { spawnKey: k.spawnKey } : {}) });
    }
  }
  return out;
}
