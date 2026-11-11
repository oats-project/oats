/** Image-local supervision. PID-only tini signals this process; the broker
 * stays available through host-run's agent drain. HOME puts its default wake
 * registry on /state without an override hidden from provider status reads. */
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const signals = ["SIGTERM", "SIGINT"];
const onSignals = (handler) => {
  for (const signal of signals) process.on(signal, handler);
  return () => { for (const signal of signals) process.off(signal, handler); };
};

/** System boundaries are injectable for subprocess fixtures; the image has no
 * supervisor options or configuration surface. Returns its container exit code. */
export async function supervise({
  spawnChild = spawn, onSignal = onSignals,
  say = (line) => process.stderr.write(`agent-supervisor: ${line}\n`),
  pollMs = 200, startupMs = 30_000, childStopMs = 3_000,
} = {}) {
  let stopping = false, failed = false, wakeStop, broker, ssh, host;
  const requested = new Promise((resolve) => { wakeStop = resolve; });
  const stop = () => { stopping = true; wakeStop(); };
  const unlisten = onSignal(stop);
  const launch = (role, file, args, stdio = "inherit") => {
    const child = spawnChild(file, args, { stdio });
    const state = { child, ended: false };
    state.done = new Promise((resolve) => {
      child.once("error", () => {
        say(`${role} could not start`);
        if (role !== "sshd" && role !== "status") { failed = true; stop(); }
      });
      child.once("close", (code, signal) => {
        state.ended = true;
        state.code = code;
        if (role !== "status") say(`${role} exited (${signal || code})`);
        if ((role === "broker" && !state.stopRequested) || (!stopping && role === "host run")) { failed = true; stop(); }
        resolve();
      });
    });
    return state;
  };
  const finish = async (state) => {
    if (!state) return;
    state.stopRequested = true;
    if (state.ended) return;
    state.child.kill("SIGTERM");
    const escalation = setTimeout(() => { failed = true; state.child.kill("SIGKILL"); }, childStopMs);
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
    if (!stopping) {
      say("broker ready (daemon_running: true)");
      ssh = launch("sshd", "/usr/sbin/sshd", ["-D", "-e", "-f", "/etc/agent-sshd_config"]);
      host = launch("host run", "oats", ["host", "run"]);
    }
    await requested;
    if (host && !host.ended) {
      host.child.kill("SIGTERM");
      // The kernel owns the 10+5+20 s drain. Never stop delivery or claim a
      // clean stop while it is still stopping agents. The runtime's 45 s limit
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
    await Promise.all([finish(ssh), finish(broker)]);
    unlisten();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await supervise();
