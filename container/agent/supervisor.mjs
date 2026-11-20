/** Image-local supervision. PID-only tini signals this process; the broker
 * stays available through host-run's agent drain. HOME puts its default wake
 * registry on /state without an override hidden from provider status reads.
 * AGENT_CHILD=<name>, set from outside the image, adds the one child a derived
 * image declares in /etc/agent-child.json, started between the broker and the
 * agents. The base image declares none. */
import { spawn } from "node:child_process";
import * as nodeFs from "node:fs";
import { get } from "node:http";
import { pathToFileURL } from "node:url";

const signals = ["SIGTERM", "SIGINT"];
const onSignals = (handler) => {
  for (const signal of signals) process.on(signal, handler);
  return () => { for (const signal of signals) process.off(signal, handler); };
};

/** Final-cleanup budgets after host run has ended. sshd, the broker and the
 * declared child stop side by side: the largest, with the kernel's drain, must
 * fit the runtime's stop grace. A declaration picks its child's budget inside
 * childStopRangeMs, so the sum holds for whatever an image asks. */
export const stopBudgetsMs = Object.freeze({ sshd: 3_000, broker: 6_000 });
export const childStopRangeMs = Object.freeze({ min: 1_000, max: 8_000 });

/** Only an image build can write the declaration: root's file on the read-only root. */
export const childDeclarationFile = "/etc/agent-child.json";
export const childDeclarationMaxBytes = 16 * 1024;

const loginDirectory = "/etc/agent-login/";
// Everything an agent can write: a command that resolves there is not the image's.
const writableMounts = ["/state", "/work", "/tmp", "/run", "/outbox", "/dev/shm"];
// What the entrypoint, the image and this switch set; a declaration takes none over.
const reservedVariables = ["PATH", "HOME", "LD_PRELOAD", "NSS_WRAPPER_PASSWD", "NSS_WRAPPER_GROUP", "NODE_OPTIONS", "AGENT_CHILD"];
const sshdPort = 2222;
// What the supervisor's own lines call the base's processes and itself: a
// child under one of these names would read as a base failure in the log.
const reservedNames = ["broker", "sshd", "host-run", "status", "supervisor"];

/** The declaration's closed grammar, shared with acceptance. Throws one fixed
 * line that names the key and never holds a value from the file. */
export function parseChildDeclaration(text) {
  const refuse = (key, reason) => { throw new Error(`${key} ${reason}`); };
  let declared;
  try { declared = JSON.parse(text); } catch { refuse("the declaration", "must be JSON"); }
  const object = (at, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(at ?? "the declaration", "must be an object");
  };
  const closed = (at, value, required, optional = []) => {
    object(at, value);
    for (const key of Object.keys(value)) {
      if (required.includes(key) || optional.includes(key)) continue;
      // A key's name is the file's text too: only a plain one is repeated.
      refuse(at ?? "the declaration", /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key) ? `has the unknown key ${key}` : "has an unknown key (name withheld)");
    }
    for (const key of required) if (!Object.hasOwn(value, key)) refuse(at ? `${at}.${key}` : key, "is missing");
  };
  const argv = (key, value) => {
    if (!Array.isArray(value) || !value.length || !value.every((arg) => typeof arg === "string" && !arg.includes("\0"))) refuse(key, "must be a non-empty array of strings");
    if (!value[0].startsWith("/")) refuse(`${key}[0]`, "must be an absolute path");
    return [...value];
  };
  const variables = (key, value, admit) => {
    object(key, value);
    for (const [name, entry] of Object.entries(value)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) refuse(key, "has a name that is not [A-Z_][A-Z0-9_]*");
      if (reservedVariables.includes(name)) refuse(key, `must not set ${name}`);
      admit(name, entry);
    }
    return { ...value };
  };
  closed(null, declared, ["name", "command", "env", "ready", "listen", "version", "stopMs"], ["envFromFile"]);
  const { name, stopMs, listen } = declared;
  if (typeof name !== "string" || !/^[a-z0-9-]{1,20}$/.test(name)) refuse("name", "must be 1 to 20 lowercase letters, digits or dashes");
  if (reservedNames.includes(name)) refuse("name", "must not be broker, sshd, host-run, status or supervisor");
  const command = argv("command", declared.command);
  const env = variables("env", declared.env, (variable, value) => {
    if (typeof value !== "string" || value.includes("\0")) refuse("env", `must give ${variable} a string`);
  });
  const envFromFile = declared.envFromFile === undefined ? {} : variables("envFromFile", declared.envFromFile, (variable, path) => {
    if (Object.hasOwn(env, variable)) refuse("envFromFile", `names ${variable}, which env sets too`);
    const file = typeof path === "string" && path.startsWith(loginDirectory) ? path.slice(loginDirectory.length) : "";
    if (!file || file === "." || file === ".." || /[/\0]/.test(file)) refuse("envFromFile", `must give ${variable} a file directly under ${loginDirectory}`);
  });
  if (!Array.isArray(listen) || !listen.length || !listen.every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535)) refuse("listen", "must be a non-empty array of ports from 1024 to 65535");
  if (listen.includes(sshdPort)) refuse("listen", `must not include ${sshdPort}, sshd's port`);
  if (new Set(listen).size !== listen.length) refuse("listen", "must not repeat a port");
  closed("ready", declared.ready, ["url", "field"]);
  const { url, field } = declared.ready;
  const port = typeof url === "string" ? url.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/[A-Za-z0-9._~\/?&=%-]*$/) : null;
  if (!port || !listen.includes(Number(port[1]))) refuse("ready.url", "must be http://127.0.0.1:<a listen port>/<path>");
  if (typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field)) refuse("ready.field", "must be the name of a top-level field: a letter or underscore, then letters, digits or underscores");
  closed("version", declared.version, ["command", "file"]);
  const version = { command: argv("version.command", declared.version.command), file: declared.version.file };
  if (typeof version.file !== "string" || !version.file.startsWith("/") || version.file.includes("\0")) refuse("version.file", "must be an absolute path");
  if (!Number.isInteger(stopMs) || stopMs < childStopRangeMs.min || stopMs > childStopRangeMs.max) refuse("stopMs", `must be a whole number from ${childStopRangeMs.min} to ${childStopRangeMs.max}`);
  return { name, command, env, envFromFile, ready: { url, field }, listen: [...listen], version, stopMs };
}

/** Everything read for the declared child, once and before any child starts:
 * the declaration, its command's real place and the envFromFile values. Says
 * one fixed line and answers nothing when the start must be refused. Answers
 * the declaration with `file`, the resolved command every launch runs, and
 * `environment`, the child's whole environment. */
function admitChild(selected, env, fs, say) {
  const at = childDeclarationFile, code = (error) => error?.code || "error";
  const notTheImagesFile = `${at} must be a regular file owned by root, not a symlink and not writable by its group or by others`;
  let text;
  try {
    // A symlink is refused, not followed; a pipe cannot hold the start.
    const fd = fs.openSync(at, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) { say(notTheImagesFile); return; }
      const bytes = stat.size > childDeclarationMaxBytes ? null : fs.readFileSync(fd);
      if (!bytes || bytes.length > childDeclarationMaxBytes) { say(`${at} must be at most 16 KiB`); return; }
      text = bytes.toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (code(error) === "ENOENT") say(`AGENT_CHILD needs an image that declares a child in ${at}`);
    else if (code(error) === "ELOOP") say(notTheImagesFile);
    else say(`${at} could not be read (${code(error)})`);
    return;
  }
  let declared;
  try { declared = parseChildDeclaration(text); } catch (error) { say(`${at}: ${error.message}`); return; }
  if (declared.name !== selected) { say(`${at}: name differs from AGENT_CHILD`); return; }
  let real;
  try { real = fs.realpathSync(declared.command[0]); }
  catch (error) {
    say(["ENOENT", "ENOTDIR"].includes(code(error)) ? `${at}: command[0] does not exist` : `${at}: command[0] could not be resolved (${code(error)})`);
    return;
  }
  if (writableMounts.some((mount) => real === mount || real.startsWith(mount + "/"))) { say(`${at}: command[0] resolves under a writable mount`); return; }
  // Read once: only the child's environment ever holds a value, never a line or an argument.
  const fromFiles = {};
  for (const [variable, path] of Object.entries(declared.envFromFile)) {
    let value;
    try { value = fs.readFileSync(path, "utf8").trim(); }
    catch (error) {
      if (code(error) === "ENOENT") continue;
      say(`the file for ${variable} could not be read (${code(error)})`);
      return;
    }
    if (!value) { say(`the file for ${variable} is empty: ${declared.name} starts without it`); continue; }
    // A NUL (a file saved as UTF-16, say) could not be passed on either: spawn would throw after the broker started.
    if (/[\s\0]/.test(value)) { say(`the file for ${variable} must hold its value on one line`); return; }
    fromFiles[variable] = value;
  }
  // An envFromFile name comes from its file or not at all: a variable of that
  // name the supervisor itself inherited never stands in for an absent or empty file.
  const environment = { ...env, ...declared.env };
  for (const variable of Object.keys(declared.envFromFile)) delete environment[variable];
  // `real` was checked, so `real` is what runs, now and at every restart: a
  // link on the way that an agent can re-point is never followed again.
  return { ...declared, file: real, environment: { ...environment, ...fromFiles } };
}

/** System boundaries are injectable for subprocess fixtures; the image has no
 * supervisor options and one switch, AGENT_CHILD. Returns its container exit code. */
export async function supervise({
  spawnChild = spawn, httpGet = get, onSignal = onSignals, killGroup = (pid) => process.kill(-pid, "SIGKILL"),
  say = (line) => process.stderr.write(`agent-supervisor: ${line}\n`),
  pollMs = 200, startupMs = 30_000, sshdStopMs = stopBudgetsMs.sshd, brokerStopMs = stopBudgetsMs.broker,
  env = process.env, fs = nodeFs, now = Date.now,
  restartBackoffMs = 1_000, restartBackoffMaxMs = 60_000, restartStableMs = 300_000,
} = {}) {
  if (env.AGENT_BB !== undefined) { say("AGENT_BB is gone: use an image that declares its child and AGENT_CHILD (the bb image now lives in oats-project/oats-bb)"); return 1; }
  // Unset or empty: nothing is read, and a declaration in the image is inert.
  let declared;
  if (env.AGENT_CHILD) {
    declared = admitChild(env.AGENT_CHILD, env, fs, say);
    if (!declared) return 1;
  }
  let stopping = false, failed = false, wakeStop, broker, ssh, host, child, childUp = false, restartTimer, restartDelay = restartBackoffMs;
  const requested = new Promise((resolve) => { wakeStop = resolve; });
  const stop = () => { stopping = true; wakeStop(); };
  const unlisten = onSignal(stop);
  // `role` decides what an exit means; `label` is what the lines call the child.
  const launch = (role, file, args, stdio = "inherit", label = role, own) => {
    // The declared child leads a process group of its own, so what it leaves can be removed.
    const spawned = spawnChild(file, args, own ? { stdio, ...own, detached: true } : { stdio });
    const state = { child: spawned, ended: false, started: Date.now() };
    state.done = new Promise((resolve) => {
      spawned.once("error", () => {
        say(`${label} could not start`);
        if (role === "child" ? !childUp : role !== "sshd" && role !== "status") { failed = true; stop(); }
      });
      spawned.once("close", (code, signal) => {
        state.ended = true;
        state.code = code;
        if (role !== "status") say(`${label} exited (${signal || code})`);
        if ((role === "broker" && !state.stopRequested) || (!stopping && role === "host run")) { failed = true; stop(); }
        if (role === "child") {
          // A killed launcher can leave its own children on the declared ports,
          // where no later child could start. The group's id stays reserved
          // while a member lives, so this reaches only what the child left.
          try { if (spawned.pid) killGroup(spawned.pid); }
          catch (e) { if (e.code !== "ESRCH") say(`${label}'s remaining processes could not be stopped (${e.code || "error"})`); }
          // Before readiness an exit fails the start. After it, agents keep
          // running and the child comes back; lost while host run drains, the stop failed.
          if (!childUp) { if (!stopping) { failed = true; stop(); } }
          else if (!stopping) restartChild(Date.now() - state.started);
          else if (!state.stopRequested) failed = true;
        }
        resolve();
      });
    });
    return state;
  };
  // The resolved file under its declared name: argv stays exactly `command`.
  const startChild = () => launch("child", declared.file, declared.command.slice(1), "inherit", declared.name, { env: declared.environment, argv0: declared.command[0] });
  // One second, doubling to a minute; a child that stayed up five minutes starts over.
  const restartChild = (upMs) => {
    if (upMs >= restartStableMs) restartDelay = restartBackoffMs;
    const wait = restartDelay;
    restartDelay = Math.min(restartDelay * 2, restartBackoffMaxMs);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (stopping) return;
      try { child = startChild(); }
      catch { say(`${declared.name} could not start`); restartChild(0); }
    }, wait);
  };
  // One request to the ready URL, for at most a second and never past `withinMs`:
  // "ready"; "refused", the connection was refused, so nobody listens there; or
  // "other": any other answer, a connection that gave none, or an attempt that
  // could not tell (an error before connecting, the time running out).
  const askChild = (withinMs = 1000) => new Promise((resolve) => {
    let text = "", settled = false, connected = false, refused = false, request;
    const answer = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request?.destroy();
      resolve(ready ? "ready" : refused ? "refused" : "other");
    };
    const timeout = setTimeout(() => answer(false), Math.max(0, Math.min(1000, withinMs)));
    requested.then(() => answer(false));
    try {
      request = httpGet(declared.ready.url, { agent: false }, (response) => {
        if (response.statusCode !== 200) { answer(false); return; }
        response.setEncoding("utf8");
        response.on("data", (chunk) => { if (text.length + chunk.length > 65536) answer(false); else text += chunk; });
        response.on("error", () => answer(false));
        response.on("end", () => {
          try {
            const status = JSON.parse(text);
            answer(status !== null && typeof status === "object" && Object.hasOwn(status, declared.ready.field) && status[declared.ready.field] === true);
          } catch { answer(false); }
        });
      });
      request.on("socket", (socket) => socket.once("connect", () => { connected = true; }));
      request.on("error", (error) => { refused = !connected && error?.code === "ECONNREFUSED"; answer(false); });
    } catch { answer(false); }
  });
  const finish = async (state, stopMs) => {
    if (!state) return;
    state.stopRequested = true;
    if (state.ended) return;
    state.child.kill("SIGTERM");
    const escalation = setTimeout(() => { failed = true; state.child.kill("SIGKILL"); }, stopMs);
    try { await state.done; } finally { clearTimeout(escalation); }
  };
  const status = async () => {
    let read;
    try { read = launch("status", "aw", ["wake", "status", "--json"], ["ignore", "pipe", "ignore"]); }
    catch { say("status could not start"); return false; }
    let text = "", overflow = false;
    read.child.stdout.on("data", (chunk) => {
      if (text.length + chunk.length > 65536) { overflow = true; read.child.kill("SIGKILL"); }
      else text += chunk;
    });
    const timeout = setTimeout(() => read.child.kill("SIGKILL"), 1000);
    try {
      await Promise.race([read.done, requested]);
      if (!read.ended) { read.child.kill("SIGKILL"); await read.done; }
      if (read.code !== 0 || overflow) return false;
      try {
        const state = JSON.parse(text);
        return state.daemon_running === true && Number.isSafeInteger(state.daemon_pid) && state.daemon_pid > 0 && state.daemon_pid === broker.child.pid;
      } catch { return false; }
    } finally { clearTimeout(timeout); }
  };
  const pause = (ms = pollMs) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    requested.then(() => { clearTimeout(timer); resolve(); });
  });
  try {
    broker = launch("broker", "aw", ["wake", "run"]);
    const deadline = Date.now() + startupMs;
    while (!stopping) {
      const ready = await status();
      // A second singleton invocation may exit 0 while status names a different
      // daemon. Only our still-live long-running child can establish readiness.
      if (ready && !broker.ended && broker.child.exitCode === null && broker.child.signalCode === null && !stopping) break;
      if (Date.now() >= deadline) { failed = true; say("broker readiness timed out"); stop(); break; }
      await pause();
    }
    if (!stopping) say("broker ready (daemon_running: true)");
    // The answer names no process. Nothing else runs yet, so whatever accepts a
    // connection there before the child starts is another process: ready now,
    // only later or silent so far, it could pass for our child's while that
    // child lives without holding the port. A refused connection is the only
    // pass: an attempt that could not tell refuses the start too.
    const before = !stopping && declared ? await askChild() : "refused";
    if (!stopping && before !== "refused") { failed = true; say(`${declared.name}'s ready URL already answers before ${declared.name} starts`); stop(); }
    if (!stopping && declared) {
      child = startChild();
      const childDeadline = now() + startupMs;
      while (!stopping) {
        // The budget bounds everything: no request starts once it is spent, and
        // none, like no pause, runs past it.
        const budget = childDeadline - now();
        if (budget <= 0) { failed = true; say(`${declared.name} readiness timed out`); stop(); break; }
        // Only while our own child lives does a ready answer count, and only inside the budget.
        const ready = await askChild(budget) === "ready", left = childDeadline - now();
        if (ready && left > 0 && !child.ended && child.child.exitCode === null && child.child.signalCode === null && !stopping) { childUp = true; break; }
        if (stopping) break;
        if (left > 0) await pause(Math.min(pollMs, left));
      }
      if (childUp) say(`${declared.name} ready (${declared.ready.field}: true)`);
    }
    if (!stopping) {
      ssh = launch("sshd", "/usr/sbin/sshd", ["-D", "-e", "-f", "/etc/agent-sshd_config"]);
      host = launch("host run", "oats", ["host", "run"]);
    }
    await requested;
    if (host && !host.ended) {
      host.child.kill("SIGTERM");
      // The kernel owns the 10+5+20 s drain. Never stop delivery or claim a
      // clean stop while it is still stopping agents. The runtime's 50 s limit
      // remains the final failure boundary for an unresponsive kernel.
      await host.done;
    }
    if (host && host.code !== 0) failed = true;
  } catch (e) {
    failed = true;
    say(`supervision failed (${e.code || "startup"})`);
    if (host && !host.ended) { host.child.kill("SIGTERM"); await host.done; }
  } finally {
    stopping = true;
    // aw gives channel children five seconds to drain; let that finish before
    // escalating the broker, while retaining sshd's shorter cleanup budget.
    clearTimeout(restartTimer);
    await Promise.all([finish(ssh, sshdStopMs), finish(broker, brokerStopMs), finish(child, declared?.stopMs)]);
    unlisten();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await supervise();
