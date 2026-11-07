import { TEST_CONTROL_TOKEN, controlFetch as fetch } from '../packages/desktop/test/helpers/control-auth.mjs';
// #698: the bundled server ends with the app that started it. Main starts the server through
// serverSpawnSpec (server-host.mjs) with its stdin as a pipe only main holds and
// --exit-on-stdin-close; when main ends by ANY path the kernel closes that pipe and the server
// exits. Proven at the real boundary: an intermediate Node parent stands in for main, starts the
// REAL oats-web.mjs through the production spec, and is SIGKILLed (no cleanup code runs). Hermetic
// like desktop-server-compat's "REAL bundled server" test: no CLI is discoverable (PATH=/nonexistent).
// Every process started here is reaped by exact pid, also on failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, Agent, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { serverSpawnSpec, LIFELINE_FLAG } from "../packages/desktop/server-host.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "packages", "desktop");
const BIN = join(DESKTOP, "server", "oats-web.mjs");
const HERMETIC = { OATS_DESKTOP_OATS_BIN: "", PATH: "/nonexistent", SHELL: "/bin/false" };

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
const answers = async (port) => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/panel`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
};
async function until(probe, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > end) return false;
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

/** The spec main uses, for a hermetic server on `port` serving nothing. */
function productionSpec(dir, port) {
  return serverSpawnSpec({ execPath: process.execPath, bin: BIN, dirs: [], port, oatsBin: null,
    pathSource: "inherited", pathError: null, remoteIdentityFile: join(dir, "remote-identity.json"), home: dir, controlToken: TEST_CONTROL_TOKEN,
    env: { ...process.env, OATS_DESKTOP_TOKEN: TEST_CONTROL_TOKEN, ...HERMETIC } });
}

// The stand-in for main: starts the server exactly as serverSpawnSpec says (and drains its output,
// as main does), optionally a long-lived plain child and a node-pty child started AFTER the server's
// pipe exists (the inheritance risk), then reports every pid and stays alive until killed.
const PARENT = `
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const [specUrl, bin, dir, port, extra, desktop] = process.argv.slice(2);
const { serverSpawnSpec } = await import(specUrl);
const spec = serverSpawnSpec({ execPath: process.execPath, bin, dirs: [], port: Number(port), oatsBin: null,
  pathSource: "inherited", pathError: null, remoteIdentityFile: dir + "/remote-identity.json", home: dir, controlToken: process.env.OATS_DESKTOP_TOKEN, env: process.env });
const server = spawn(spec.command, spec.args, spec.options);
server.stdin.on("error", () => {});
server.stdout.resume(); server.stderr.resume();
const pids = { parent: process.pid, server: server.pid };
if (extra === "1") {
  pids.plain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;
  try {
    // Ignores the hangup its pty master's close sends, as a daemon started through a pty (a tmux server) outlives it.
    pids.pty = createRequire(desktop + "/package.json")("node-pty").spawn(process.execPath,
      ["-e", "process.on('SIGHUP', () => {}); setInterval(() => {}, 1000)"], {}).pid;
  } catch (e) { pids.ptyError = String(e?.message || e).slice(0, 160); }
}
process.stdout.write(JSON.stringify(pids) + "\\n");
setInterval(() => {}, 1000);
`;

/** Start the stand-in parent; resolves with the pids it reports. Registers exact-pid reaping. */
async function startParent(t, { extra = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oats-lifeline-"));
  const script = join(dir, "parent.mjs");
  writeFileSync(script, PARENT);
  const port = await freePort();
  const parent = spawn(process.execPath, [script, pathToFileURL(join(DESKTOP, "server-host.mjs")).href, BIN, dir, String(port),
    extra ? "1" : "0", DESKTOP], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, OATS_DESKTOP_TOKEN: TEST_CONTROL_TOKEN, ...HERMETIC } });
  const pids = { parent: parent.pid };
  t.after(() => {
    for (const pid of new Set(Object.values(pids).filter(Number.isInteger))) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  let line = "";
  for await (const chunk of parent.stdout) { line += chunk; if (line.includes("\n")) break; }
  Object.assign(pids, JSON.parse(line));
  return { pids, port, parent };
}

test("serverSpawnSpec: main starts the server with the lifeline flag and its stdin as a pipe", () => {
  const { args, options } = productionSpec("/fixture", 4820);
  assert.ok(args.includes(LIFELINE_FLAG), "the server is told its stdin is the lifeline");
  assert.equal(LIFELINE_FLAG, "--exit-on-stdin-close");
  assert.equal(options.stdio[0], "pipe", "never 'ignore': /dev/null is EOF at once");
  assert.equal(options.detached, undefined, "not detached");
  assert.deepEqual(args.slice(0, 4), [BIN, "start", "--port", "4820"]);
});

test("REAL server started through the production spec exits within 5 s when its parent is SIGKILLed", async (t) => {
  const { pids, port, parent } = await startParent(t);
  assert.equal(await until(() => answers(port), 10000), true, "the server answers before the kill");
  assert.equal(alive(pids.server), true);
  process.kill(pids.parent, "SIGKILL");
  await once(parent, "exit");
  assert.equal(await until(() => !alive(pids.server), 5000), true, "server pid gone within 5 s");
  assert.equal(await answers(port), false, "port closed");
});

test("…and still exits while long-lived children of the parent (plain and node-pty) are alive", async (t) => {
  const { pids, port, parent } = await startParent(t, { extra: true });
  if (pids.ptyError) t.diagnostic(`node-pty unavailable, plain child only: ${pids.ptyError}`);
  assert.equal(await until(() => answers(port), 10000), true, "the server answers before the kill");
  process.kill(pids.parent, "SIGKILL");
  await once(parent, "exit");
  assert.equal(await until(() => !alive(pids.server), 5000), true, "server pid gone within 5 s");
  assert.equal(await answers(port), false, "port closed");
  assert.equal(alive(pids.plain), true, "the plain child still runs: it did not hold the lifeline open");
  if (pids.pty) assert.equal(alive(pids.pty), true, "the pty child still runs: it did not hold the lifeline open");
});

/** The server started directly by this test, so its stdin is in the test's hands. */
async function startDirect(t, { args, stdin }) {
  const dir = mkdtempSync(join(tmpdir(), "oats-lifeline-"));
  const port = await freePort();
  const spec = productionSpec(dir, port);
  const child = spawn(spec.command, args(spec.args), { ...spec.options, stdio: [stdin, "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await until(() => answers(port), 10000), true, "the server answers");
  return { child, port, output: () => out };
}

for (const stdin of ["ignore", "pipe"]) {
  test(`without the flag (a server started by hand), stdin at EOF changes nothing: stdin ${stdin}`, async (t) => {
    const { child, port } = await startDirect(t, { args: (a) => a.filter((x) => x !== LIFELINE_FLAG), stdin });
    if (stdin === "pipe") child.stdin.end();
    await new Promise((ok) => setTimeout(ok, 1500));
    assert.equal(child.exitCode, null, "still running");
    assert.equal(await answers(port), true, "still answering");
  });
}

test("with the flag, EOF on stdin exits with code 0 and one log line, even with a keep-alive socket open", async (t) => {
  const { child, port, output } = await startDirect(t, { args: (a) => a, stdin: "pipe" });
  const agent = new Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await new Promise((ok, bad) => request({ host: "127.0.0.1", port, path: "/api/version", agent }, (res) => { res.resume(); res.on("end", ok); }).on("error", bad).end());
  const exited = once(child, "exit");
  child.stdin.end();
  const [code, signal] = await Promise.race([exited, new Promise((_, bad) => setTimeout(() => bad(new Error("no exit within 5 s")), 5000))]);
  assert.deepEqual([code, signal], [0, null]);
  assert.equal(output().split("\n").filter((l) => l.includes("the app that started it has ended")).length, 1, output());
});

test("with the flag, SIGTERM and stdin EOF together (replace()) end it once, with no error", async (t) => {
  const { child, output } = await startDirect(t, { args: (a) => a, stdin: "pipe" });
  const exited = once(child, "exit");
  child.kill();
  child.stdin.end();
  await Promise.race([exited, new Promise((_, bad) => setTimeout(() => bad(new Error("no exit within 5 s")), 5000))]);
  assert.doesNotMatch(output(), /Error|EPIPE|ERR_/, "no error on a double end");
});
