import { TEST_CONTROL_TOKEN, controlFetch as fetch } from '../packages/desktop/test/helpers/control-auth.mjs';
// #1630 (option C): the warm reader dies with the bundled server that started it, however the server ends.
// The server holds the only write end of the reader's stdin (packages/client/warm-reader.mjs) and the reader
// exits on its EOF, so a SIGKILLed server (no cleanup code runs) ends it, and so does a SIGKILLed app: the
// server's own lifeline (#698, desktop-server-lifeline.test.mjs) ends the server, which ends the reader.
// Proven at the real boundary: the REAL oats-web.mjs, started through the production spec, observes a
// deployment through a stub `oats` that advertises the reader; the stub's `reader --stdio` writes its pid
// and, like the kernel's, answers until stdin ends and then exits. Hermetic: PATH names nothing, HOME is a
// temporary directory, the stub is the only CLI. Every process started here is reaped by exact pid, also on
// failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { serverSpawnSpec } from "../packages/desktop/server-host.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const BIN = join(DESKTOP, "server", "oats-web.mjs");
const FIXTURES = join(DESKTOP, "test", "fixtures", "workspace-v2");
const FIXTURE_DEPLOYMENT = "/fixture/base/northwind-workspace";

async function freePort() {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const p = s.address().port; await new Promise((ok) => s.close(ok));
  return p;
}
/** A pid that is running: signal 0 reaches it and (on Linux) it is not a zombie awaiting its reaper. */
function alive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
}
async function until(probe, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > end) return false;
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

/** The stub CLI: the fixture documents for `status` and `workspace status`, rewritten to this deployment;
 * a probe that lists the reader; `reader --stdio`, which records its pid, says hello and answers each
 * request with the same documents until its stdin ends. Anything else is a kernel refusal. */
function stubCli(dir, deployment) {
  const rewrite = (name) => readFileSync(join(FIXTURES, name), "utf8").replaceAll(FIXTURE_DEPLOYMENT, deployment);
  writeFileSync(join(dir, "status.json"), rewrite("status.json"));
  writeFileSync(join(dir, "workspace-status.json"), rewrite("workspace-status.json"));
  const probe = { schemaVersion: 1, name: "@awebai/oats", version: "0.69.5", desktopApi: 1, workspaceApi: 2, readerApi: 1,
    features: ["workspace-v2", "instance-modules", "served-identity", "packages-no-approval", "observe-max-age", "warm-reader", "status-liveness"] };
  const bin = join(dir, "oats");
  writeFileSync(bin, `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
const doc = (read) => JSON.parse(readFileSync(dir + (read[0] === "status" ? "/status.json" : "/workspace-status.json"), "utf8"));
if (argv[0] === "version") { process.stdout.write(${JSON.stringify(JSON.stringify(probe))}); process.exit(0); }
if (argv[0] === "status" || (argv[0] === "workspace" && argv[1] === "status")) { process.stdout.write(JSON.stringify(doc(argv))); process.exit(0); }
if (argv[0] === "reader" && argv[1] === "--stdio") {
  writeFileSync(dir + "/reader.pid", String(process.pid));
  process.stdout.write(JSON.stringify({ readerApi: 1, version: ${JSON.stringify(probe.version)}, reads: ["status", "workspace status"] }) + "\\n");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf("\\n")) >= 0; buffer = buffer.slice(at + 1)) {
      const request = JSON.parse(buffer.slice(0, at));
      writeFileSync(dir + "/reader.answered", "1");
      process.stdout.write(JSON.stringify({ id: request.id, exit: 0, answer: doc(request.argv) }) + "\\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_STUB", message: "not in the stub" } }));
  process.exit(1);
}
`);
  chmodSync(bin, 0o755);
  return bin;
}

function hermetic(dir) {
  return { OATS_DESKTOP_OATS_BIN: "", PATH: "/nonexistent", SHELL: "/bin/false", HOME: dir, OATS_HOME_DIR: join(dir, ".oats"), TMUX_TMPDIR: dir };
}

function spec(dir, deployment, oatsBin, port, env) {
  return serverSpawnSpec({ execPath: process.execPath, bin: BIN, dirs: [deployment], port, oatsBin,
    pathSource: "inherited", pathError: null, remoteIdentityFile: join(dir, "remote-identity.json"), home: dir, controlToken: TEST_CONTROL_TOKEN, env });
}

/** A deployment, its stub CLI, and the reaping of every pid this test learns. */
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-warm-reader-"));
  const deployment = join(dir, "northwind-workspace");
  mkdirSync(deployment);
  const oatsBin = stubCli(dir, deployment);
  const pids = new Set();
  t.after(() => {
    if (existsSync(join(dir, "reader.pid"))) pids.add(Number(readFileSync(join(dir, "reader.pid"), "utf8")));
    for (const pid of pids) if (Number.isInteger(pid) && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, deployment, oatsBin, pids };
}

/** The reader is up and has answered a background read: a cycle after admission went through it. The
 * window is focused so the cycle comes 5 s after the first. */
async function readerAnswered(dir, port) {
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/window-state`, { method: "POST", body: JSON.stringify({ focused: true }),
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }, 10000);
  assert.equal(await until(() => existsSync(join(dir, "reader.answered")), 20000), true, "the reader answered a background read");
  const pid = Number(readFileSync(join(dir, "reader.pid"), "utf8"));
  assert.equal(alive(pid), true, "the reader runs");
  return pid;
}

test("the warm reader exits when the REAL server holding its stdin is SIGKILLed", async (t) => {
  const { dir, deployment, oatsBin, pids } = setup(t);
  const port = await freePort();
  const s = spec(dir, deployment, oatsBin, port, { ...process.env, ...hermetic(dir) });
  const server = spawn(s.command, s.args, { ...s.options, stdio: ["pipe", "ignore", "ignore"] });
  pids.add(server.pid);
  const reader = await readerAnswered(dir, port);
  pids.add(reader);
  // /api/cli carries the reader's state as a diagnostic.
  const cli = await (await fetch(`http://127.0.0.1:${port}/api/cli`)).json();
  assert.deepEqual(cli.reader, { state: "ready", code: null });
  process.kill(server.pid, "SIGKILL");
  await once(server, "exit");
  assert.equal(await until(() => !alive(reader), 5000), true, "the reader is gone within 5 s of the server's SIGKILL");
});

// The stand-in for the app's main: starts the server through the production spec, holds its stdin, and keeps
// a plain long-lived child and a node-pty child (a terminal viewer's shape) started after the server's pipe.
const PARENT = `
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const [specUrl, bin, dir, deployment, oatsBin, port, desktop] = process.argv.slice(2);
const { serverSpawnSpec } = await import(specUrl);
const spec = serverSpawnSpec({ execPath: process.execPath, bin, dirs: [deployment], port: Number(port), oatsBin,
  pathSource: "inherited", pathError: null, remoteIdentityFile: dir + "/remote-identity.json", home: dir, controlToken: process.env.OATS_DESKTOP_TOKEN, env: process.env });
const server = spawn(spec.command, spec.args, spec.options);
server.stdin.on("error", () => {});
server.stdout.resume(); server.stderr.resume();
const pids = { parent: process.pid, server: server.pid };
pids.plain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;
try {
  pids.pty = createRequire(desktop + "/package.json")("node-pty").spawn(process.execPath,
    ["-e", "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], {}).pid;
} catch (e) { pids.ptyError = String(e?.message || e).slice(0, 160); }
process.stdout.write(JSON.stringify(pids) + "\\n");
setInterval(() => {}, 1000);
`;

test("…and when the app that started the server is SIGKILLed, with long-lived children of the app (plain and node-pty) alive", async (t) => {
  const { dir, deployment, oatsBin, pids } = setup(t);
  const port = await freePort();
  const script = join(dir, "parent.mjs");
  writeFileSync(script, PARENT);
  const parent = spawn(process.execPath, [script, pathToFileURL(join(DESKTOP, "server-host.mjs")).href, BIN, dir, deployment, oatsBin, String(port), DESKTOP],
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, OATS_DESKTOP_TOKEN: TEST_CONTROL_TOKEN, ...hermetic(dir) } });
  pids.add(parent.pid);
  let line = "";
  for await (const chunk of parent.stdout) { line += chunk; if (line.includes("\n")) break; }
  const started = JSON.parse(line);
  for (const pid of Object.values(started)) if (Number.isInteger(pid)) pids.add(pid);
  if (started.ptyError) t.diagnostic(`node-pty unavailable, plain child only: ${started.ptyError}`);
  const reader = await readerAnswered(dir, port);
  pids.add(reader);
  process.kill(parent.pid, "SIGKILL");
  await once(parent, "exit");
  assert.equal(await until(() => !alive(started.server), 5000), true, "the server is gone within 5 s");
  assert.equal(await until(() => !alive(reader), 5000), true, "the reader is gone within 5 s of the server");
  assert.equal(alive(started.plain), true, "the plain child still runs: it held no lifeline open");
  if (started.pty) assert.equal(alive(started.pty), true, "the pty child still runs: it held no lifeline open");
});
