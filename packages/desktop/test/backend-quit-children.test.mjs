// The quit path sends the backend's CLI children no signal (server/oats-web.mjs, the owner-lifeline
// block): a command in flight when the app ends finishes whole. The real server/oats-web.mjs is
// started through serverSpawnSpec, as main starts it, with a fixture CLI named by
// OATS_DESKTOP_OATS_BIN that writes its pid, records any SIGTERM, SIGINT or SIGHUP it receives,
// and stays (the backend's own probe runs it, `version --json`, at startup). Two legs, one per way
// the backend ends: its stdin closes (the owner lifeline), and the SIGTERM server-host.mjs sends on
// shutdown. In both the fixture is alive by exact pid after the backend has gone, with no signal
// recorded, and is then reaped by exact pid.
//
// What this holds is what the backend sends. What reaches a child from elsewhere (a Ctrl-C or a
// hang-up to the client's process group) is held by test/client-own-session.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReaper } from "../scripts/proc-reaper.mjs";
import { launchServerChild, serverSpawnSpec } from "../server-host.mjs";

const BIN = fileURLToPath(new URL("../server/oats-web.mjs", import.meta.url));

/** A pid that is running: signal 0 reaches it and (on Linux) it is not a zombie awaiting its reaper. */
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
}

async function until(probe, ms) {
  for (const end = Date.now() + ms; ;) {
    if (probe()) return true;
    if (Date.now() > end) return false;
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

/** The backend, started through the spec with the fixture as its CLI; answers once the fixture runs. */
async function backendWithFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-quit-children-"));
  const files = { pid: join(dir, "pid"), signals: join(dir, "signals") };
  const reaper = createReaper({ spawn });
  let fixturePid = null;
  t.after(() => {
    // The fixture runs in the backend's process group; it is reaped by its exact pid first.
    if (fixturePid && alive(fixturePid)) { try { process.kill(fixturePid, "SIGKILL"); } catch { /* gone */ } }
    reaper.reapAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const cli = join(dir, "oats");
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => fs.appendFileSync(${JSON.stringify(files.signals)}, signal + "\\n"));
fs.writeFileSync(${JSON.stringify(files.pid)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  chmodSync(cli, 0o755);
  // As main starts it: a private socket directory under the test's own and a fresh credential on fd 3.
  const backend = launchServerChild({ spawn: (command, args, options) => reaper.spawnTracked(command, args, options), socketBase: dir,
    spec: (socketPath) => serverSpawnSpec({ execPath: process.execPath, bin: BIN, dirs: [], socketPath, cliChoiceFile: null, pathSource: "inherited", pathError: null,
      remoteIdentityFile: join(dir, "remote-identity.json"), home: dir, env: { ...process.env, OATS_DESKTOP_OATS_BIN: cli, PATH: "/nonexistent", SHELL: "/bin/false", HOME: dir } }) }).child;
  let tail = "";
  backend.stdout.on("data", (d) => { tail = (tail + d).slice(-2000); });
  backend.stderr.on("data", (d) => { tail = (tail + d).slice(-2000); });
  backend.stdin.on("error", () => { /* the backend is gone; its exit is asserted */ });
  const exited = new Promise((ok) => backend.on("exit", (code, signal) => ok({ code, signal })));
  // The probe's own deadline (8 s, SIGKILL) belongs to the backend; it is ended well before then.
  assert.ok(await until(() => existsSync(files.pid) && readFileSync(files.pid, "utf8") !== "", 6000), `the backend ran its CLI; output:\n${tail}`);
  fixturePid = Number(readFileSync(files.pid, "utf8"));
  assert.ok(Number.isSafeInteger(fixturePid) && alive(fixturePid), "premise: the fixture CLI runs");
  return { backend, exited, fixturePid, files, output: () => tail };
}

async function assertChildUntouched({ fixturePid, files }) {
  // A signal sent as the backend ends would be recorded within moments; wait a little for one.
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(alive(fixturePid), true, `the CLI child (pid ${fixturePid}) outlives the backend`);
  assert.equal(existsSync(files.signals), false, `no signal reached the CLI child: ${existsSync(files.signals) ? readFileSync(files.signals, "utf8") : ""}`);
  process.kill(fixturePid, "SIGKILL");
  assert.ok(await until(() => !alive(fixturePid), 5000), "the fixture is reaped by exact pid");
}

test("the owner lifeline: the backend's stdin closes, it exits 0, and its CLI child gets no signal", async (t) => {
  const run = await backendWithFixture(t);
  run.backend.stdin.end();
  const end = await run.exited;
  assert.deepEqual(end, { code: 0, signal: null }, run.output());
  await assertChildUntouched(run);
});

test("shutdown: the backend receives SIGTERM, as server-host.mjs sends it, and its CLI child gets no signal", async (t) => {
  const run = await backendWithFixture(t);
  run.backend.kill("SIGTERM");
  const end = await run.exited;
  assert.equal(end.signal, "SIGTERM", run.output());
  await assertChildUntouched(run);
});
