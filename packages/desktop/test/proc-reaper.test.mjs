// Process-group reaper (scripts/proc-reaper.mjs) — the leak-proofing
// contract from review 4e2667b:
//   * group ids are RETAINED after leader exit (descendants can outlive the
//     leader; -pgid still reaps them);
//   * runTracked group-kills on timeout without blocking the event loop;
//   * reapAll covers retained groups from already-exited leaders.
// io-injected fakes make retention/kill semantics observable without real
// processes; the "leader exits, descendant remains" case is ALSO proven
// against real processes below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createReaper } from "../scripts/proc-reaper.mjs";

let nextPid = 51000;
function fakeChild() {
  const c = new EventEmitter();
  c.pid = nextPid++;
  c.killed = false;
  c.kill = () => { c.killed = true; };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

test("group ids are retained after leader exit — reapAll still group-kills them", () => {
  const killed = [];
  const r = createReaper({ spawn: () => fakeChild(), killGroup: (pgid) => killed.push(pgid) });
  const c = r.spawnTracked("app", []);
  const pgid = c.pid;
  c.emit("exit", 0);                       // leader exits — descendants may remain
  assert.ok(r.pendingGroups().has(pgid), "group RETAINED after leader exit (the review's exact finding)");
  r.reapAll();
  assert.deepEqual(killed, [pgid], "reapAll group-kills the retained group");
  assert.equal(r.pendingGroups().size, 0, "reaped groups are cleared");
});

test("reapGroup kills the group and clears retention exactly once", () => {
  const killed = [];
  const r = createReaper({ spawn: () => fakeChild(), killGroup: (pgid) => killed.push(pgid) });
  const c = r.spawnTracked("app", []);
  r.reapGroup(c);
  assert.deepEqual(killed, [c.pid]);
  assert.equal(r.pendingGroups().size, 0);
  r.reapAll();
  assert.deepEqual(killed, [c.pid], "no double group-kill after explicit reap");
});

test("runTracked: timeout group-kills and resolves timedOut without leader cooperation", async () => {
  const killed = [];
  let child;
  const r = createReaper({ spawn: () => (child = fakeChild()), killGroup: (pgid) => killed.push(pgid) });
  const p = r.runTracked("app", [], { timeout: 30 });
  // the child NEVER exits on its own — only the timeout's group kill ends it
  const result = await Promise.race([p, new Promise((res) => setTimeout(() => res("hung"), 500))]);
  // after the group kill the fake leader emits exit+close (as a real one would)
  if (result === "hung") { child.emit("exit", null); child.emit("close", null); }
  const final = result === "hung" ? await p : result;
  assert.equal(final.timedOut, true, "timeout reported");
  assert.deepEqual(killed, [child.pid], "group killed on timeout");
});

test("runTracked: normal exit still group-reaps (descendants may remain in the group)", async () => {
  const killed = [];
  let child;
  const r = createReaper({ spawn: () => (child = fakeChild()), killGroup: (pgid) => killed.push(pgid) });
  const p = r.runTracked("app", [], { timeout: 5000 });
  child.stdout.emit("data", "OUT");
  child.emit("exit", 0);
  child.emit("close", 0);
  const result = await p;
  assert.equal(result.stdout, "OUT");
  assert.equal(result.timedOut, false);
  assert.deepEqual(killed, [child.pid], "group reaped even on clean leader exit");
  assert.equal(r.pendingGroups().size, 0);
});

test("runTracked settles on CLOSE, not exit — data between exit and close is captured (review ac366f9)", async () => {
  // Node guarantees stdio completion at close; PTY_OK can arrive after exit.
  let child;
  const r = createReaper({ spawn: () => (child = fakeChild()), killGroup: () => {} });
  const p = r.runTracked("app", [], { timeout: 5000 });
  child.stdout.emit("data", "partial ");
  child.emit("exit", 0);                                  // leader exits FIRST
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(settled, false, "result must NOT settle at exit");
  child.stdout.emit("data", "PTY_OK");                    // late flush — the reviewed race
  child.stderr.emit("data", "progress noise");            // stderr consumed, no back-pressure
  child.emit("close", 0);
  const result = await p;
  assert.equal(result.stdout, "partial PTY_OK", "post-exit data captured");
  assert.equal(result.stderr, "progress noise", "stderr drained");
  assert.equal(result.code, 0);
});

test("runTracked: input is the child's whole stdin, cwd is its directory, and the result names its pid", async () => {
  const r = createReaper({ spawn });
  const dir = realpathSync(tmpdir());
  const res = await r.runTracked(process.execPath, ["-e", "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => process.stdout.write(process.cwd() + ' ' + s.toUpperCase()));"],
    { timeout: 10000, cwd: dir, input: "rows" });
  assert.equal(res.stdout, `${dir} ROWS`);
  assert.equal(res.code, 0);
  assert.ok(Number.isInteger(res.pid) && res.pid > 0, "the leader's pid");
  assert.equal(r.pendingGroups().size, 0);
  // Without input, stdin is /dev/null: EOF at once.
  const none = await r.runTracked(process.execPath, ["-e", "process.stdin.on('data', () => {}).on('end', () => process.stdout.write('eof'))"], { timeout: 10000 });
  assert.equal(none.stdout, "eof");
});

// ---- real-process regression: leader exits while a descendant remains ------
test("real processes: a descendant surviving its exited leader is reaped by group kill", async () => {
  const r = createReaper({ spawn });
  // Leader: a shell that starts a long-running descendant IN ITS GROUP and
  // exits immediately — exactly the reviewed leak (leader exit dropped the
  // group while the descendant lived on).
  const c = r.spawnTracked("/bin/sh", ["-c", "sleep 300 & echo started"]);
  await new Promise((ok) => c.on("exit", ok));           // leader is gone
  assert.ok(r.pendingGroups().has(c.pid), "group retained after real leader exit");
  // the descendant (sleep) is alive in the leader's group
  const alive = () => {
    try { return execFileSync("pgrep", ["-g", String(c.pid)], { encoding: "utf8" }).trim().length > 0; }
    catch { return false; }                              // pgrep exits 1 when none
  };
  assert.ok(alive(), "descendant still running after leader exit");
  r.reapAll();
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(!alive(), "group kill reaped the orphaned descendant");
});

// ---- interruption during a tracked run (the ABI-probe interruption case) ---
test("real processes: killing the smoke mid-runTracked leaves no group survivors", async () => {
  // Child smoke-like script: uses the reaper's runTracked (the ACTUAL probe
  // primitive — review ac366f9: the previous version used spawnTracked and
  // did not exercise the changed call site), then is interrupted mid-run.
  // Its signal handler must reap the tree.
  const script = `
    import { spawn } from "node:child_process";
    import { createReaper } from "${new URL("../scripts/proc-reaper.mjs", import.meta.url).pathname}";
    const r = createReaper({ spawn });
    process.on("SIGTERM", () => { r.reapAll(); process.exit(1); });
    // runTracked with a LONG timeout — the run is still in flight when the
    // interruption arrives; print the group id from the tracked set.
    const p = r.runTracked("/bin/sh", ["-c", "sleep 300"], { timeout: 200000 });
    setTimeout(() => { console.log("TREE_UP " + [...r.pendingGroups()][0]); }, 200);
    await p;
  `;
  const runner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  const pgidLine = await new Promise((ok) => {
    let buf = "";
    let timer = setTimeout(() => ok(buf), 8000);
    runner.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("TREE_UP")) { clearTimeout(timer); ok(buf); } // clear — no dangling 8s ref (review nit)
    });
  });
  const m = String(pgidLine).match(/TREE_UP (\d+)/);
  assert.ok(m, "runner started its tracked run");
  const treePgid = Number(m[1]);
  const treeAlive = () => {
    try { return execFileSync("pgrep", ["-g", String(treePgid)], { encoding: "utf8" }).trim().length > 0; }
    catch { return false; }
  };
  assert.ok(treeAlive(), "tree running before interruption");
  runner.kill("SIGTERM");                                 // interrupt mid-runTracked (ABI-probe case)
  await new Promise((ok) => runner.on("exit", ok));
  await new Promise((ok) => setTimeout(ok, 300));
  assert.ok(!treeAlive(), "interrupted smoke reaped its whole tree via the signal handler");
});

// ---- probe-runner contract: the smoke's ABI probe MUST go through runTracked ---
test("smoke probe contract: runAbiProbe refuses to run without a reaper runTracked and uses it exclusively", async () => {
  const { runAbiProbe, abiProbeSource } = await import("../scripts/smoke-probes.mjs");
  // no reaper / a reaper without runTracked → refused (a revert to
  // synchronous execution cannot satisfy this contract)
  for (const bad of [undefined, {}, { runTracked: "not-a-fn" }]) {
    const r = await runAbiProbe(bad, "/app", "/asar/main.mjs");
    assert.equal(r.ok, false);
    assert.match(r.detail, /runTracked/);
  }
  // with a reaper: the probe is executed VIA runTracked with the ABI env
  const callsSeen = [];
  const reaper = {
    runTracked: async (exe, args, opts) => {
      callsSeen.push({ exe, args, opts });
      return { stdout: "PTY_OK\n", code: 0, timedOut: false };
    },
  };
  const okR = await runAbiProbe(reaper, "/pkg/App", "/pkg/app.asar/main.mjs", { timeout: 1234, env: {} });
  assert.equal(okR.ok, true);
  assert.equal(callsSeen.length, 1, "exactly one tracked run");
  assert.equal(callsSeen[0].exe, "/pkg/App");
  assert.equal(callsSeen[0].opts.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(callsSeen[0].opts.timeout, 1234);
  assert.ok(callsSeen[0].args[1].includes("pty-alive"), "probe source travels through the tracked run");
  assert.ok(abiProbeSource("/x").includes("createRequire"), "probe source resolves node-pty via app.asar");
  // x64 cross-build on an arm64 mac MUST explicitly execute through Rosetta.
  // This is what proves the packaged x64 node-pty native is genuinely x64;
  // inventory alone would let a wrong-arch binary sail through.
  callsSeen.length = 0;
  const x64R = await runAbiProbe(reaper, "/pkg/x64/App", "/pkg/x64/app.asar/main.mjs", {
    timeout: 90000, env: {}, targetArch: "x64", platform: "darwin", hostArch: "arm64",
  });
  assert.equal(x64R.ok, true);
  assert.equal(callsSeen[0].exe, "/usr/bin/arch", "Rosetta launcher used explicitly");
  assert.deepEqual(callsSeen[0].args.slice(0, 3), ["-x86_64", "/pkg/x64/App", "-e"]);
  assert.ok(callsSeen[0].args[3].includes("pty-alive"), "ABI probe source passed after the x64 app");
  assert.match(x64R.detail, /Rosetta x86_64/, "evidence reports the Rosetta path honestly");
  // Native arm64 package must not route through Rosetta.
  callsSeen.length = 0;
  await runAbiProbe(reaper, "/pkg/arm/App", "/pkg/arm/app.asar/main.mjs", {
    targetArch: "arm64", platform: "darwin", hostArch: "arm64",
  });
  assert.equal(callsSeen[0].exe, "/pkg/arm/App");
  // timeout and failure map to structured results
  const tR = await runAbiProbe({ runTracked: async () => ({ stdout: "", code: null, timedOut: true }) }, "/a", "/m");
  assert.equal(tR.ok, false); assert.match(tR.detail, /timed out/);
});

test("Rosetta warm-up: tracked first start reports elapsed seconds and reaps the group", async (t) => {
  const { runRosettaWarmup } = await import("../scripts/smoke-probes.mjs");
  const calls = [], killed = [], ticks = [1000, 64_000];
  const reaper = createReaper({
    spawn: (exe, args, opts) => {
      const child = fakeChild();
      calls.push({ exe, args, opts, pid: child.pid });
      queueMicrotask(() => { child.emit("exit", 0); child.emit("close", 0); });
      return child;
    },
    killGroup: (pid) => killed.push(pid),
  });
  t.after(() => reaper.reapAll());
  const result = await runRosettaWarmup(reaper, "/pkg/x64/App", {
    platform: "darwin", hostArch: "arm64", targetArch: "x64", env: { KEEP: "yes", ELECTRON_RUN_AS_NODE: "0" },
    now: () => ticks.shift(),
  });
  assert.deepEqual(result, { ok: true, detail: "Rosetta x86_64 first start of the packaged app: 63 s" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, "/usr/bin/arch");
  assert.deepEqual(calls[0].args, ["-x86_64", "/pkg/x64/App", "-e", "process.exit(0)"]);
  assert.deepEqual(calls[0].opts.env, { KEEP: "yes", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(calls[0].opts.detached, true);
  assert.deepEqual(killed, [calls[0].pid]);
  assert.equal(reaper.pendingGroups().size, 0);
});

test("Rosetta warm-up: native legs skip without calling runTracked", async () => {
  const { runRosettaWarmup } = await import("../scripts/smoke-probes.mjs");
  let calls = 0;
  const reaper = { runTracked: () => { calls++; throw new Error("native warm-up must not run"); } };
  for (const how of [
    { platform: "darwin", hostArch: "arm64", targetArch: "arm64" },
    { platform: "darwin", hostArch: "x64", targetArch: "x64" },
    { platform: "linux", hostArch: "x64", targetArch: "x64" },
    { platform: "linux", hostArch: "arm64", targetArch: "x64" },
    { platform: "darwin", hostArch: "arm64" },
  ]) {
    const result = await runRosettaWarmup(reaper, "/pkg/App", how);
    assert.equal(result.ok, true);
    assert.match(result.detail, /Rosetta warm-up skipped/);
  }
  assert.equal(calls, 0);
});

test("Rosetta warm-up: requires runTracked and reports its own timeout and non-zero exit", async (t) => {
  const { runRosettaWarmup } = await import("../scripts/smoke-probes.mjs");
  const how = { platform: "darwin", hostArch: "arm64", targetArch: "x64" };
  for (const bad of [undefined, {}, { runTracked: "not-a-fn" }]) {
    const result = await runRosettaWarmup(bad, "/pkg/App", how);
    assert.equal(result.ok, false);
    assert.match(result.detail, /warm-up.*requires.*runTracked/);
  }
  for (const timeout of [true, false]) {
    let child;
    const reaper = createReaper({
      spawn: () => {
        child = fakeChild();
        if (!timeout) queueMicrotask(() => {
          child.stderr.emit("data", "translation failed");
          child.emit("exit", 7); child.emit("close", 7);
        });
        return child;
      },
      killGroup: () => { if (timeout) queueMicrotask(() => { child.emit("exit", null); child.emit("close", null); }); },
    });
    t.after(() => reaper.reapAll());
    const result = await runRosettaWarmup(reaper, "/pkg/App", { ...how, timeout: 20 });
    assert.equal(result.ok, false);
    assert.match(result.detail, timeout ? /Rosetta warm-up.*timed out \(group killed\)/ : /Rosetta warm-up.*failed \(exit 7\): translation failed/);
    assert.doesNotMatch(result.detail, /node-pty/);
    assert.equal(reaper.pendingGroups().size, 0);
  }
});

test("Rosetta warm-up: real reaper executes the trivial Node source and leaves no group", async (t) => {
  const { runRosettaWarmup } = await import("../scripts/smoke-probes.mjs");
  // Only the cross-architecture launcher is substituted at the process boundary.
  const reaper = createReaper({ spawn: (_exe, args, opts) => spawn(process.execPath, args.slice(2), opts) });
  t.after(() => reaper.reapAll());
  const result = await runRosettaWarmup(reaper, process.execPath, {
    platform: "darwin", hostArch: "arm64", targetArch: "x64", timeout: 10_000,
  });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /first start of the packaged app: \d+(\.\d+)? s$/);
  assert.equal(reaper.pendingGroups().size, 0);
});

test("smoke warm-up precedes the ABI probe and uses its own phase budget", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/dist-smoke.mjs", import.meta.url), "utf8");
  const warmup = src.indexOf("await runRosettaWarmup(reaper"), abi = src.indexOf("await runAbiProbe(reaper");
  assert.ok(warmup >= 0 && warmup < abi);
  assert.match(src.slice(warmup, abi), /timeout: PHASE_BUDGET_MS\.rosettaWarmup/);
  assert.match(src.slice(warmup, abi), /if \(!r\.ok\) fail\(r\.detail\)/);
  assert.match(src.slice(warmup, abi), /ok\(r\.detail\)/);
});

// ---- the smoke itself must not regress to synchronous probing --------------
test("smoke source contract: dist-smoke has no synchronous child execution and probes via runAbiProbe", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/dist-smoke.mjs", import.meta.url), "utf8");
  assert.ok(!/execFileSync|execSync|spawnSync/.test(src), "no synchronous child execution in the smoke (blocks signal handlers/watchdog)");
  assert.match(src, /runAbiProbe\(reaper/, "ABI probe goes through the contract runner with the reaper");
  assert.match(src, /runBackendProbe\(reaper/, "the headless backend phase goes through the contract runner with the reaper");
  const probes = readFileSync(new URL("../scripts/smoke-probes.mjs", import.meta.url), "utf8");
  assert.ok(!/execFileSync|execSync|spawnSync/.test(probes), "no synchronous execution in the probe runner either");
});
