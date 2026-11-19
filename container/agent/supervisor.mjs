/** Image-local supervision. PID-only tini signals this process; the broker
 * stays available through host-run's agent drain. HOME puts its default wake
 * registry on /state without an override hidden from provider status reads.
 * AGENT_BB=1 (compose.agent.bb.yaml, on the container/agent-bb image) adds one
 * bb server on loopback, started between the broker and the agents. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { pathToFileURL } from "node:url";

const signals = ["SIGTERM", "SIGINT"];
const onSignals = (handler) => {
  for (const signal of signals) process.on(signal, handler);
  return () => { for (const signal of signals) process.off(signal, handler); };
};

/** Final-cleanup budgets after host run has ended; the three run side by side.
 * The largest, with the kernel's drain, must fit the runtime's stop grace. bb's
 * launcher kills its own children after five seconds. */
export const stopBudgetsMs = Object.freeze({ sshd: 3_000, broker: 6_000, bb: 8_000 });

/** System boundaries are injectable for subprocess fixtures; the image has no
 * supervisor options and one fixed switch, AGENT_BB. Returns its container exit code. */
export async function supervise({
  spawnChild = spawn, onSignal = onSignals, killGroup = (pid) => process.kill(-pid, "SIGKILL"),
  say = (line) => process.stderr.write(`agent-supervisor: ${line}\n`),
  pollMs = 200, startupMs = 30_000, childStopMs = stopBudgetsMs.sshd, brokerStopMs = stopBudgetsMs.broker,
  env = process.env, fileExists = existsSync, readFile = readFileSync,
  bbFile = "/usr/local/bin/bb-app", bbTokenFile = "/etc/agent-login/claude-token",
  // The host daemon's status: the server's /health on 38886 answers before agents can run.
  bbStatusUrl = "http://127.0.0.1:38887/status",
  bbStopMs = stopBudgetsMs.bb, bbBackoffMs = 1_000, bbBackoffMaxMs = 60_000, bbStableMs = 300_000,
} = {}) {
  const withBb = env.AGENT_BB === "1";
  let bbToken;
  if (withBb) {
    if (!fileExists(bbFile)) { say("AGENT_BB needs the bb image: build container/agent-bb and select it as AGENT_IMAGE"); return 1; }
    // Read once: only bb's environment ever holds the value, never a line or an argument.
    try {
      bbToken = readFile(bbTokenFile, "utf8").trim();
      if (!bbToken) say("the Claude token file is empty: bb starts without it");
    } catch (e) {
      if (e.code !== "ENOENT") { say(`the Claude token file could not be read (${e.code || "error"})`); return 1; }
    }
  } else if (env.AGENT_BB !== undefined && env.AGENT_BB !== "") { say("AGENT_BB must be 1 or unset"); return 1; }
  let stopping = false, failed = false, wakeStop, broker, ssh, host, bb, bbUp = false, bbTimer, bbDelay = bbBackoffMs;
  const requested = new Promise((resolve) => { wakeStop = resolve; });
  const stop = () => { stopping = true; wakeStop(); };
  const unlisten = onSignal(stop);
  const launch = (role, file, args, stdio = "inherit", childEnv) => {
    // bb leads a process group of its own, so what its launcher leaves can be removed.
    const child = spawnChild(file, args, childEnv ? { stdio, env: childEnv, detached: true } : { stdio });
    const state = { child, ended: false, started: Date.now() };
    state.done = new Promise((resolve) => {
      child.once("error", () => {
        say(`${role} could not start`);
        if (role === "bb" ? !bbUp : role !== "sshd" && role !== "status") { failed = true; stop(); }
      });
      child.once("close", (code, signal) => {
        state.ended = true;
        state.code = code;
        if (role !== "status") say(`${role} exited (${signal || code})`);
        if ((role === "broker" && !state.stopRequested) || (!stopping && role === "host run")) { failed = true; stop(); }
        if (role === "bb") {
          // A launcher that was killed leaves its server and host daemon running
          // on bb's ports, where no later bb could start. The group's id stays
          // reserved while a member lives, so this reaches only what bb left.
          try { if (child.pid) killGroup(child.pid); }
          catch (e) { if (e.code !== "ESRCH") say(`bb's remaining processes could not be stopped (${e.code || "error"})`); }
          // Before readiness a bb exit fails the start. After it, agents keep
          // running and bb comes back; lost while host run drains, the stop failed.
          if (!bbUp) { if (!stopping) { failed = true; stop(); } }
          else if (!stopping) restartBb(Date.now() - state.started);
          else if (!state.stopRequested) failed = true;
        }
        resolve();
      });
    });
    return state;
  };
  const startBb = () => launch("bb", bbFile, ["--no-in-app-updates", "--server-bind-host", "127.0.0.1"], "inherit",
    { ...env, BB_TELEMETRY: "false", ...(bbToken ? { CLAUDE_CODE_OAUTH_TOKEN: bbToken } : {}) });
  // One second, doubling to a minute; a bb that stayed up five minutes starts over.
  const restartBb = (upMs) => {
    if (upMs >= bbStableMs) bbDelay = bbBackoffMs;
    const wait = bbDelay;
    bbDelay = Math.min(bbDelay * 2, bbBackoffMaxMs);
    bbTimer = setTimeout(() => {
      bbTimer = undefined;
      if (stopping) return;
      try { bb = startBb(); }
      catch { say("bb could not start"); restartBb(0); }
    }, wait);
  };
  const bbConnected = () => new Promise((resolve) => {
    let text = "", settled = false, request;
    const answer = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request?.destroy();
      resolve(connected);
    };
    const timeout = setTimeout(() => answer(false), 1000);
    requested.then(() => answer(false));
    try {
      request = get(bbStatusUrl, { agent: false }, (response) => {
        if (response.statusCode !== 200) { answer(false); return; }
        response.setEncoding("utf8");
        response.on("data", (chunk) => { if (text.length + chunk.length > 65536) answer(false); else text += chunk; });
        response.on("error", () => answer(false));
        response.on("end", () => {
          try { answer(JSON.parse(text)?.connected === true); } catch { answer(false); }
        });
      });
      request.on("error", () => answer(false));
    } catch { answer(false); }
  });
  const finish = async (state, stopMs = childStopMs) => {
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
  try {
    broker = launch("broker", "aw", ["wake", "run"]);
    const deadline = Date.now() + startupMs;
    while (!stopping) {
      const ready = await status();
      // A second singleton invocation may exit 0 while status names a different
      // daemon. Only our still-live long-running child can establish readiness.
      if (ready && !broker.ended && broker.child.exitCode === null && broker.child.signalCode === null && !stopping) break;
      if (Date.now() >= deadline) { failed = true; say("broker readiness timed out"); stop(); break; }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        requested.then(() => { clearTimeout(timer); resolve(); });
      });
    }
    if (!stopping) say("broker ready (daemon_running: true)");
    // The status names no process. Nothing else runs yet, so an answer before
    // bb starts is another process's, and could later pass for our child's.
    if (!stopping && withBb && await bbConnected()) { failed = true; say("bb's status port already answers before bb starts"); stop(); }
    if (!stopping && withBb) {
      bb = startBb();
      const bbDeadline = Date.now() + startupMs;
      while (!stopping) {
        // Only while our own child lives does a connected status count.
        const connected = await bbConnected();
        if (connected && !bb.ended && bb.child.exitCode === null && bb.child.signalCode === null && !stopping) { bbUp = true; break; }
        if (stopping) break;
        if (Date.now() >= bbDeadline) { failed = true; say("bb readiness timed out"); stop(); break; }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          requested.then(() => { clearTimeout(timer); resolve(); });
        });
      }
      if (bbUp) say("bb ready (connected: true)");
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
    clearTimeout(bbTimer);
    await Promise.all([finish(ssh), finish(broker, brokerStopMs), finish(bb, bbStopMs)]);
    unlisten();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await supervise();
