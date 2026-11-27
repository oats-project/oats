// bb's public CLI, and nothing else of bb's: every call is one `bb … --json` process against
// one server (BB_SERVER_URL), bounded in time, its stdout read as bb documents it
// (`bb guide json`: one JSON value on success; {"ok": false, "error": {code, message}} and
// a nonzero exit on failure).
import { spawn } from "node:child_process";
import { fail, isObject } from "./errors.mjs";

const CALL_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 32 * 1024 * 1024;
const SAID_MAX = 4_000;
// How bb's CLI finds the host daemon of the machine it runs on: by this port alone (its
// default is 38887), never from BB_SERVER_URL. A command that needs the local host (`bb
// project create`, for one) goes to whatever daemon listens there: with a second bb on
// this host that is another bb's, and the command is refused (`host_not_found`), or
// nobody's ("Cannot reach local host daemon"). Seen at bb-app 0.50.1 (contract A23).
const HOST_DAEMON_PORT_ENV = "BB_HOST_DAEMON_PORT";
// What a bb call never inherits from the provider's caller. bb's own context variables:
// inside a bb thread they would aim a command at that thread. And the host daemon's port:
// which bb a call is for is the deployment's settings' to say, the server and the port
// together; a caller that carries one bb's port must never be paired with another bb's
// configured server.
const CONTEXT_ENV = ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_SERVER_URL", HOST_DAEMON_PORT_ENV];

/** One CLI call. Resolves, never rejects:
 *  { ok: true, value, said? } | { ok: false, code, message, timedOut?, missing?, refused? }
 *  (`said`: what bb wrote beside a JSON answer, on its stderr, where it wrote anything, cut to a few lines' length;
 *  `refused`: bb printed its own failure envelope).
 *  `code` is bb's own error code where it gave one (thread_not_found, invalid_request…),
 *  else `error`; `timeout` and `cli_missing` are this module's.
 *  `hostDaemonPort` (settings.oats.bb.hostDaemonPort, a number or null): set, the call is
 *  told this bb's host daemon port; unset, it is told none (bb's CLI then uses its own
 *  default). Either way a BB_HOST_DAEMON_PORT the caller's environment carries does not
 *  reach bb: the port comes from the setting alone. */
export function runBb(cli, args, { server, hostDaemonPort = null, input, timeoutMs = CALL_TIMEOUT_MS, env = process.env, json = true } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...env };
    for (const name of CONTEXT_ENV) delete childEnv[name];
    if (server) childEnv.BB_SERVER_URL = server;
    if (hostDaemonPort !== null && hostDaemonPort !== undefined) childEnv[HOST_DAEMON_PORT_ENV] = String(hostDaemonPort);
    let child;
    // In the provider's own process group, never one of its own: the kernel gives each
    // provider command a group and kills that group when it must end the command, so a
    // helper that left the group would outlive it. (`bb` is a launcher that starts the
    // real CLI as a child with the same pipes: when a call is cut off, the provider ends
    // the launcher and lets go of the pipes; what the launcher started stays in the
    // kernel's group, for the kernel to end.)
    try { child = spawn(cli, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { resolve({ ok: false, code: "cli_missing", missing: true, message: `cannot run ${cli}: ${error.message}` }); return; }
    let stdout = "", stderr = "", size = 0, settled = false, timedOut = false;
    const finish = (answer) => { if (!settled) { settled = true; clearTimeout(timer); resolve(answer); } };
    const endCall = () => {
      child.kill("SIGKILL");
      // The pipes too: a process the launcher started may hold them open, and must not
      // hold this call, or the provider's exit, with them.
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    };
    // The timed-out answer comes from the timer, not from `close`: a grandchild that
    // survived would keep the pipes open, and the call would never end.
    const timer = setTimeout(() => {
      timedOut = true;
      endCall();
      finish({ ok: false, code: "timeout", timedOut: true, message: `bb ${args.slice(0, 2).join(" ")} did not answer within ${Math.round(timeoutMs / 100) / 10} s` });
    }, Math.max(1, timeoutMs));
    const take = (chunk, into) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) { endCall(); finish({ ok: false, code: "error", message: `bb ${args.slice(0, 2).join(" ")} wrote more than ${MAX_OUTPUT} bytes` }); return into; }
      return into + chunk;
    };
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = take(chunk, stdout); });
    child.stderr.on("data", (chunk) => { stderr = take(chunk, stderr); });
    child.stdin.on("error", () => {}); // a bb that exits before reading: its exit code speaks
    child.on("error", (error) => finish(error.code === "ENOENT" || error.code === "EACCES"
      ? { ok: false, code: "cli_missing", missing: true, message: `cannot run ${cli}: ${error.message}` }
      : { ok: false, code: "error", message: `${cli} ${args[0] ?? ""}: ${error.message}` }));
    child.on("close", (status, signal) => {
      if (timedOut) return; // answered by the timer
      if (size > MAX_OUTPUT) return finish({ ok: false, code: "error", message: `bb ${args.slice(0, 2).join(" ")} wrote more than ${MAX_OUTPUT} bytes` });
      if (!json) {
        return finish(status === 0 ? { ok: true, value: stdout }
          : { ok: false, code: "error", message: firstLine(stderr) || `bb ${args.join(" ")} exited ${status ?? signal}` });
      }
      let doc, parsed = false;
      try { doc = JSON.parse(stdout); parsed = true; } catch { /* reported below, with the exit */ }
      // (What bb wrote beside a JSON answer, where it wrote anything: the start of it.)
      if (status === 0 && parsed) return finish({ ok: true, value: doc, ...(stderr.trim() ? { said: stderr.trim().slice(0, SAID_MAX) } : {}) });
      if (parsed && isObject(doc) && doc.ok === false && isObject(doc.error) && typeof doc.error.code === "string") {
        return finish({ ok: false, refused: true, code: doc.error.code, message: typeof doc.error.message === "string" ? doc.error.message : doc.error.code });
      }
      finish({ ok: false, code: "error", message: status === 0
        ? `bb ${args.slice(0, 2).join(" ")} answered something that is not JSON`
        : firstLine(stderr) || `bb ${args.slice(0, 2).join(" ")} exited ${status ?? signal}` });
    });
    child.stdin.end(input ?? "");
  });
}

const firstLine = (text) => String(text).split("\n").map((line) => line.trim()).find(Boolean) ?? "";

/** A failed call after which nothing can have happened in bb: the CLI could not be run,
 *  the request never reached a server (the connection was refused), or bb's server
 *  answered no in its own words (bb's error envelope with its code or a 4xx status, an
 *  invocation bb's CLI rejected). Everything else is in doubt for a call that changes something: no answer
 *  in time, a CLI that died or wrote something unreadable, a connection that dropped
 *  after the request went out, a server error. */
export function nothingHappened(answer) {
  if (answer.ok) return false;
  if (answer.missing) return true;
  if (!answer.refused) return false;
  // bb's CLI wraps some failures in a plain error whose message carries the server's
  // status ("Failed to create thread: HTTP 404: Project not found"): a 4xx there is the
  // server's no; a 5xx, anywhere, is not.
  if (/\bHTTP 5\d\d\b/.test(answer.message) || /^http_5\d\d$/.test(answer.code)) return false;
  if (answer.code === "error") return /ECONNREFUSED|ENOTFOUND|bad port/.test(answer.message) || /\bHTTP 4\d\d:/.test(answer.message);
  return true;
}

/** bb says the server did not answer (the CLI's fetch failed), as opposed to answering no. */
function isUnreachable(answer) {
  return !answer.ok && (answer.timedOut === true || (answer.code === "error" && /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|socket hang up|network/i.test(answer.message)));
}

// The words bb-app uses at the pinned version (its own enums): a thread's status and an
// interaction's. A row whose word is not one of them cannot be read: "not pending" or
// "not running" must never be taken from a word this provider does not know.
const THREAD_STATUSES = new Set(["pending", "idle", "starting", "active", "stopping", "error"]);
const INTERACTION_STATUSES = new Set(["pending", "resolving", "resolved", "interrupted"]);

/** The bb commands this provider uses, each against one server, under one deadline.
 *  A failure throws a ProviderError carrying `fallbackCode` (the caller's phase code),
 *  or E_BACKEND_UNREACHABLE when bb's server did not answer; `bb` on the error is the
 *  raw answer for callers that read bb's own code. `hostDaemonPort`: the home's setting,
 *  carried by every call (runBb). */
export function bbClient({ cli, server, hostDaemonPort = null, deadline = Infinity, env = process.env, fallbackCode = "E_SESSION_UNAVAILABLE" }) {
  const remaining = () => Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
  const raw = async (args, options = {}) => {
    const timeoutMs = remaining();
    if (timeoutMs <= 0) return { ok: false, code: "timeout", timedOut: true, message: `no time left for bb ${args.slice(0, 2).join(" ")}` };
    return runBb(cli, args, { server, hostDaemonPort, env, ...options, timeoutMs: Math.min(timeoutMs, options.timeoutMs ?? timeoutMs) });
  };
  const must = async (args, options) => {
    const answer = await raw(args, options);
    if (answer.ok) return answer.value;
    throw refusal(answer, args);
  };
  const refusal = (answer, args) => {
    const what = `bb ${args.slice(0, 2).join(" ")}`;
    const error = answer.missing ? fail("E_BACKEND_NOT_READY", `${answer.message}: install bb-app or set settings.oats.bb.cli`)
      : isUnreachable(answer) ? fail("E_BACKEND_UNREACHABLE", `bb at ${server} does not answer (${what}: ${answer.message})`)
      : fail(fallbackCode, `${what} failed: ${answer.message}`);
    error.bb = answer;
    return error;
  };
  // A read establishes a fact only if every row of it can be read: one malformed row, and
  // "no such thread", "no live thread" or "no pending interaction" would rest on nothing.
  const list = (value, what, valid) => {
    if (!Array.isArray(value)) throw fail(fallbackCode, `${what} answered something that is not a list`);
    const bad = value.findIndex((row) => !valid(row));
    if (bad !== -1) throw fail(fallbackCode, `${what} answered a row this provider cannot read (row ${bad + 1} of ${value.length})`);
    return value;
  };
  // A time as bb writes one: a number of milliseconds, or nothing. A word there would
  // read as "archived" or "deleted" and make a live thread look gone.
  const stamp = (value) => value === null || value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
  const threadRow = (row) => isObject(row) && typeof row.id === "string" && row.id !== "" && THREAD_STATUSES.has(row.status)
    && (row.projectId === null || row.projectId === undefined || typeof row.projectId === "string") && stamp(row.archivedAt) && stamp(row.deletedAt)
    && (row.queuedWork === null || row.queuedWork === undefined || typeof row.queuedWork === "string")
    && (row.environmentPath === null || row.environmentPath === undefined || typeof row.environmentPath === "string")
    && (row.environmentId === null || row.environmentId === undefined || typeof row.environmentId === "string");
  // An environment as bb shows one (`bb environment show`, bb-app 0.50.1): what it is (the
  // environment provider that made it, and whether bb manages its directory), where it
  // is (`path`: null once it is destroyed), and its status. One that does not say all of
  // it cannot show that it is a home's own local directory.
  const environmentRow = (row) => isObject(row) && typeof row.id === "string" && row.id !== "" && typeof row.status === "string" && row.status !== ""
    && typeof row.environmentProviderId === "string" && typeof row.managed === "boolean"
    && (row.path === null || row.path === undefined || typeof row.path === "string");
  // A source row as bb writes one: its kind, and for a directory on a machine its path. A
  // source that does not say what it is cannot show that a project is NOT rooted at a
  // home: such a list is unreadable, never "no project here".
  const sourceRow = (source) => isObject(source) && typeof source.type === "string" && source.type !== ""
    && (source.type === "local_path" ? typeof source.path === "string" && source.path !== "" : source.path === null || source.path === undefined || typeof source.path === "string");
  const projectRow = (row) => isObject(row) && typeof row.id === "string" && row.id !== "" && Array.isArray(row.sources) && row.sources.every(sourceRow);
  const interactionRow = (row) => isObject(row) && typeof row.id === "string" && row.id !== "" && INTERACTION_STATUSES.has(row.status);
  const queuedRow = (row) => isObject(row) && typeof row.id === "string" && row.id !== "";
  const hostRow = (row) => isObject(row) && typeof row.id === "string" && row.id !== "" && typeof row.status === "string";
  // A variable of bb's env, by its name: a name is an argument to bb, and must never read
  // as an option. bb shows no value (`value: null, secret: true`), and none is read.
  const envRow = (row) => isObject(row) && typeof row.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name);
  /** The names of an env of bb's: the machine's, or with `--project <id>` one project's. */
  const envNames = async (scope) => {
    const doc = await must(["machine", "env", "list", ...scope, "--json"]);
    if (!isObject(doc)) throw fail(fallbackCode, "bb machine env list answered something that is not an object");
    return list(doc.variables, "bb machine env list", envRow).map((row) => row.name);
  };
  return {
    server, raw, refusal,
    async version() {
      const answer = await raw(["--version"], { json: false });
      if (!answer.ok) throw refusal(answer, ["--version"]);
      return answer.value.trim();
    },
    async projects() { return list(await must(["project", "list", "--json"]), "bb project list", projectRow); },
    async createProject(name, root) {
      const project = await must(["project", "create", "--name", name, "--root", root, "--json"]);
      if (!projectRow(project)) throw fail(fallbackCode, "bb project create answered no project this provider can read");
      return project;
    },
    /** Every unarchived thread of the server, hidden ones included: one read. (Archived
     *  threads are nobody's session; each start archives one, so they only grow.) */
    async threads() { return list(await must(["thread", "list", "--include-hidden", "--json"]), "bb thread list", threadRow); },
    /** The archived threads of one project. bb keeps an archived thread's Claude process
     *  loaded, and no row says whether it does: these are what a sweep stops. */
    async archivedThreads(projectId) { return list(await must(["thread", "list", "--project", projectId, "--archived", "--include-hidden", "--json"]), "bb thread list --archived", threadRow); },
    /** The messages bb holds in line for the thread (a turn its concurrency limit has not
     *  started, a message behind a pending interaction), or [] when bb has no such thread. */
    async queue(id) {
      const answer = await raw(["thread", "queue", "list", id, "--json"]);
      if (answer.ok) return list(answer.value, "bb thread queue list", queuedRow);
      if (answer.code === "thread_not_found") return [];
      throw refusal(answer, ["thread", "queue"]);
    },
    /** The thread, or null when bb has none by that id. */
    async thread(id) {
      const answer = await raw(["thread", "show", id, "--json"]);
      if (answer.ok) {
        if (!isObject(answer.value) || !threadRow(answer.value.thread)) throw fail(fallbackCode, "bb thread show answered no thread this provider can read");
        return answer.value.thread;
      }
      if (answer.code === "thread_not_found") return null;
      throw refusal(answer, ["thread", "show"]);
    },
    async interactions(id) { return list(await must(["thread", "interactions", "list", id, "--json"]), "bb thread interactions list", interactionRow); },
    /** The names of the variables bb holds for one project (its own, not those it inherits
     *  from the machine's). */
    projectEnvNames(projectId) { return envNames(["--project", projectId]); },
    /** The names of the variables bb sets for every process it runs on this machine (its
     *  machine env, with no project). */
    machineEnvNames() { return envNames([]); },
    /** Set one variable of a project's env. The value goes on stdin, never in an argument. */
    envSet(projectId, name, value) { return raw(["machine", "env", "set", name, "--project", projectId, "--json"], { input: value }); },
    envUnset(projectId, name) { return raw(["machine", "env", "unset", name, "--project", projectId, "--json"]); },
    spawn(args, options) { return raw(["thread", "spawn", ...args, "--json"], options); },
    tell(id, text) { return raw(["thread", "tell", id, "--message-file", "-", "--mode", "auto", "--json"], { input: text }); },
    queueDelete(threadId, messageId) { return raw(["thread", "queue", "delete", threadId, messageId, "--json"]); },
    /** The hosts bb's server has, each with its id and whether it is connected: what tells
     *  whether a host daemon (its own /status says its host id) is one of this server's. */
    async hosts() { return list(await must(["host", "list", "--json"]), "bb host list", hostRow); },
    stop(id, options) { return raw(["thread", "stop", id, "--json"], options); },
    archive(id) { return raw(["thread", "archive", id, "--json"]); },
    /** The models bb lists for its pi provider, with `model` as the one a launch names
     *  (bb then also lists it where it holds it back otherwise: lib/pi-model.mjs). The
     *  raw answer: what it proves is the reader's to say. */
    piModels(model) { return raw(["provider", "models", "pi", "--selected-model", model, "--json"]); },
    /** The environment, or null when bb has none by that id. */
    async environment(id) {
      const answer = await raw(["environment", "show", id, "--json"]);
      if (answer.ok) {
        if (!environmentRow(answer.value) || answer.value.id !== id) throw fail(fallbackCode, "bb environment show answered no environment this provider can read");
        return answer.value;
      }
      if (answer.code === "environment_not_found") return null;
      throw refusal(answer, ["environment", "show"]);
    },
    /** Every thread on one environment, archived and hidden ones included: one read, and
     *  it is whole or it throws (a row that cannot be read, or one that is of another
     *  environment, and the list proves nothing). bb leaves deleted threads out. */
    async threadsOn(environmentId) {
      const rows = list(await must(["thread", "list", "--environment", environmentId, "--include-archived", "--include-hidden", "--json"]), "bb thread list --environment", threadRow);
      const other = rows.findIndex((row) => row.environmentId !== environmentId);
      if (other !== -1) throw fail(fallbackCode, `bb thread list --environment answered a thread that is not on that environment (row ${other + 1} of ${rows.length})`);
      return rows;
    },
    /** Ask bb to delete an environment: bb marks it destroyed, answers at once, and tears
     *  it down afterwards. For an environment that is a local directory bb does not
     *  manage, the directory is not touched. bb refuses while a thread on it is unarchived. */
    environmentDelete(id) { return raw(["environment", "delete", id, "--json"]); },
  };
}
