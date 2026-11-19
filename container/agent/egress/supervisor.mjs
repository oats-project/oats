/** One owner for both proxy children. A partial proxy is an image failure. */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { compilePolicy, loadPolicy } from "./policy.mjs";
import { startExternalConnectors } from "./external.mjs";

const onSignals = handler => {
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, handler);
  return () => { for (const signal of ["SIGTERM", "SIGINT"]) process.off(signal, handler); };
};

export async function superviseProxy({ spawnChild = spawn, onSignal = onSignals,
  say = line => process.stderr.write(`egress: ${line}\n`), graceMs = 3000, policy } = {}) {
  const children = [];
  let external;
  let failed = false, requestStop;
  const stop = new Promise(resolve => { requestStop = resolve; });
  const unlisten = onSignal(requestStop);
  const launch = (name, file, args) => {
    const child = spawnChild(file, args, { stdio: "inherit" });
    const state = { child, ended: false, stopRequested: false };
    state.done = new Promise(resolve => {
      child.once("error", () => { failed = true; say(`${name} could not start`); requestStop(); });
      child.once("close", (code, signal) => {
        state.ended = true;
        say(`${name} exited (${signal || code})`);
        if (!state.stopRequested || (code !== 0 && signal !== "SIGTERM")) failed = true;
        requestStop();
        resolve();
      });
    });
    children.push(state);
  };
  try {
    if (policy) {
      external=await startExternalConnectors(policy);
      external.failed.then(()=>{failed=true;say("external connector failed");requestStop();});
    }
    launch("dns", "/usr/local/bin/coredns", ["-conf", "/tmp/egress/Corefile"]);
    launch("tls", "/usr/sbin/nginx", ["-p", "/tmp/egress/", "-c", "/tmp/egress/nginx.conf", "-g", "daemon off;"]);
    await stop;
  } catch { failed = true; say("supervision failed"); }
  finally {
    await Promise.all(children.map(async state => {
      state.stopRequested = true;
      if (state.ended) return;
      state.child.kill("SIGTERM");
      const timer = setTimeout(() => { failed = true; state.child.kill("SIGKILL"); }, graceMs);
      try { await state.done; } finally { clearTimeout(timer); }
    }));
    await external?.close();
    unlisten();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const policy = loadPolicy();
    const files = compilePolicy(policy);
    mkdirSync("/tmp/egress", { recursive: true, mode: 0o700 });
    for (const [key, name] of [["zone", "allow.zone"], ["nginx", "nginx.conf"], ["corefile", "Corefile"]]) {
      writeFileSync(`/tmp/egress/${name}`, files[key], { mode: 0o600 });
    }
    process.exitCode = await superviseProxy({policy});
  } catch {
    process.stderr.write("egress: startup failed (configuration or process)\n");
    process.exitCode = 1;
  }
}
