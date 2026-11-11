/** Host-run's owned child groups and private admission fence. The parent stays
 * responsive while a synchronous tick runs. It keeps ownership until the
 * children AND their groups have ended; a timeout is never proof of cleanup. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { signalGroup } from "./process-group.mjs";
import { processLiveness } from "../packages/record/lib/process-identity.mjs";

const CHILD = fileURLToPath(new URL("./host-run-child.mjs", import.meta.url));
const instanceKeys = ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME"];

/** Private process boundary. The optional durations shorten real subprocess
 * tests; host run always uses 10 s natural grace and 5 s owned cancellation. */
export function hostRunWork({ kernel, env, naturalMs = 10_000, cancelMs = 5_000, say = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), "oats-host-work-")), fence = join(dir, "admit");
  writeFileSync(fence, "open", { mode: 0o600 });
  const groups = join(dir, "groups");
  mkdirSync(groups, { mode: 0o700 });
  const childEnv = { ...env };
  for (const key of instanceKeys) delete childEnv[key];
  const owned = new Set();
  let fenced = false, drained = null;
  const alive = (state) => {
    if (state.empty) return false;
    if (!state.child.pid) return !state.done;
    if (process.platform === "win32") return !state.done;
    try { process.kill(-state.child.pid, 0); return true; }
    catch (e) { if (e.code === "ESRCH") { state.empty = true; return false; } return true; }
  };
  const signal = (state, sig) => {
    if (!alive(state)) return;
    if (process.platform === "win32") state.child.kill(sig);
    else signalGroup(state.child, sig);
  };
  let ownershipError = null;
  const registrations = new Map();
  const discover = () => {
    if (ownershipError) return;
    for (const name of readdirSync(groups)) {
      if (!/^[1-9][0-9]*$/.test(name) || registrations.has(name)) continue;
      const path = join(groups, name);
      let record;
      try { record = JSON.parse(readFileSync(path, "utf8")); }
      catch (e) { throw new Error(`host-run child ownership is unreadable (${e.code || "record"})`); }
      if (String(record.pid) !== name || typeof record.processStart !== "string") throw new Error("host-run child ownership is invalid");
      // No ACK until the still-live leader is verified. Before ACK the child
      // imports no kernel work, so an already gone registrant has no effects.
      const { state: live } = processLiveness(record);
      if (live !== "alive") {
        if (live === "gone") rmSync(path, { force: true });
        continue;
      }
      const state = [...owned].find(s => s.child.pid === record.pid) ?? { child: { pid: record.pid }, done: true, empty: false };
      owned.add(state);
      registrations.set(name, state);
      writeFileSync(`${path}.owned`, "owned", { mode: 0o600 });
    }
  };
  let watch = null;
  const pending = () => {
    try { discover(); }
    catch (e) { ownershipError = e; say(`child ownership failed: ${e.message}`); }
    const active = [];
    for (const state of owned) {
      if (!state.done || alive(state)) active.push(state);
      else owned.delete(state);
    }
    for (const [pid, state] of registrations) if (!owned.has(state)) {
      registrations.delete(pid);
      rmSync(join(groups, pid), { force: true });
      rmSync(join(groups, `${pid}.owned`), { force: true });
    }
    if (!active.length && watch !== null) { clearInterval(watch); watch = null; }
    return active;
  };
  const wait = async (until) => {
    while (pending().length && Date.now() < until) await delay(10);
    return pending().length === 0;
  };
  const run = (argv, { timeoutMs } = {}) => {
    if (fenced && !argv.includes("--plan")) return Promise.resolve({ ok: false, error: { code: "E_HOST_RUN_FAILED", message: "host run is stopping; no further child was admitted" } });
    return new Promise((resolve) => {
      const state = { child: null, done: false, empty: false };
      let timeout, escalation, interrupted = false;
      const fail = (message) => ({ ok: false, error: { code: "E_HOST_RUN_FAILED", message } });
      const chunks = [];
      let size = 0, error = null;
      state.child = spawn(kernel.execPath, [CHILD, kernel.bin, fence, "group", ...argv], {
        env: childEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
      state.child.stdout.on("data", (chunk) => {
        if (size + chunk.length <= 16 * 1024 * 1024) { size += chunk.length; chunks.push(chunk); }
        else { interrupted = true; signal(state, "SIGKILL"); }
      });
      // Child diagnostics are not its JSON answer. Drain to prevent pipe backpressure.
      state.child.stderr.resume();
      state.child.once("error", (e) => { error = e; });
      state.child.once("close", (_code, sig) => {
        state.done = true;
        clearTimeout(timeout); clearTimeout(escalation);
        let answer;
        try { answer = JSON.parse(Buffer.concat(chunks).toString("utf8").trim().split("\n").pop()); } catch { answer = undefined; }
        resolve(!interrupted && answer && typeof answer === "object" ? answer : fail(`oats ${argv.join(" ")} ${interrupted ? "was cancelled" : `exited${sig ? ` on ${sig}` : error?.code ? ` (${error.code})` : ""} without an answer`}`));
      });
      owned.add(state);
      watch ??= setInterval(pending, 25);
      if (timeoutMs !== undefined) timeout = setTimeout(() => {
        interrupted = true;
        signal(state, "SIGTERM");
        escalation = setTimeout(() => signal(state, "SIGKILL"), Math.min(1000, cancelMs));
      }, timeoutMs);
    });
  };
  const drain = () => drained ??= (async () => {
    if (await wait(Date.now() + naturalMs)) return;
    // Write before TERM: a synchronous tick resumes after an interrupted
    // command before its deferred signal handler runs. It must not admit next.
    writeFileSync(fence, "stop");
    fenced = true;
    say("launch grace expired: admissions fenced; cancelling owned work");
    for (const state of pending()) signal(state, "SIGTERM");
    const start = Date.now();
    if (await wait(start + Math.min(3000, cancelMs))) return;
    for (const state of pending()) signal(state, "SIGKILL");
    if (await wait(start + cancelMs)) return;
    say("owned work has not ended; retaining the host-run claim");
    // An unkillable OS wait is the runtime's final failure boundary. Never
    // release a claim or begin agent stops beside launch-capable survivors.
    while (pending().length) await delay(25);
  })();
  const close = async () => {
    await drain();
    // Final read-only listings can have run after the admission drain.
    if (pending().length) {
      for (const state of pending()) signal(state, "SIGKILL");
      while (pending().length) await delay(10);
    }
    clearInterval(watch);
    rmSync(dir, { recursive: true, force: true });
    if (ownershipError) throw ownershipError;
  };
  return { run, drain, close };
}
