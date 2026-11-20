import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const relayFile = fileURLToPath(new URL("../container/agent-bb/relay.mjs", import.meta.url));

/** A fake `ssh` first on PATH: SSH is the boundary, and no network is used. A
 * master (-M) creates its control socket's path and waits; a channel echoes its
 * stdin, as bb would answer. Each logs its pid and arguments. */
function fakeSsh(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-bb-relay-")), log = join(dir, "ssh.jsonl");
  t.after(() => {
    for (const { pid } of calls()) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(log, "");
  writeFileSync(join(dir, "ssh"), `#!${process.execPath}
const fs = require("node:fs"), argv = process.argv.slice(2), master = argv.includes("-M");
if (master) fs.writeFileSync(argv[argv.indexOf("-S") + 1], "");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, master, argv }) + "\\n");
process.on("SIGTERM", () => process.exit(0));
if (master) setInterval(() => {}, 1000);
else if (process.env.FAKE_SSH_ANSWER_BYTES) {
  // bb answers and closes: the channel writes its answer and exits without reading.
  const chunk = Buffer.alloc(65536, 120);
  let left = Number(process.env.FAKE_SSH_ANSWER_BYTES);
  const write = () => {
    while (left > 0) { const size = Math.min(left, chunk.length); left -= size; if (!process.stdout.write(chunk.subarray(0, size))) return process.stdout.once("drain", write); }
    process.exit(0);
  };
  write();
} else { process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(0)); }
`);
  chmodSync(join(dir, "ssh"), 0o755);
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { env: { ...process.env, PATH: dir + delimiter + process.env.PATH }, calls };
}

async function until(check, what) {
  for (let tries = 0; tries < 500; tries += 1) { if (await check()) return; await delay(10); }
  assert.fail("the relay fixture did not reach: " + what);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** One client connection through the relay, proven by its echo. */
async function open(port, text) {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  const echoed = new Promise((resolve, reject) => { socket.once("data", chunk => resolve(chunk.toString())); socket.once("close", () => reject(new Error("closed before an answer"))); });
  socket.write(text);
  assert.equal(await echoed, text);
  return socket;
}

test("the relay listens on loopback only, caps multiplexed channels at 9 and restarts a dead master", async t => {
  const { MUX_CHANNELS, parseArgs, startRelay } = await import("../container/agent-bb/relay.mjs");
  assert.equal(MUX_CHANNELS, 9, "sshd's MaxSessions is 10");
  assert.deepEqual(parseArgs(["--ssh", "team-agent", "--listen", "48886"]), { ssh: "team-agent", listen: 48886, port: 38886 });
  assert.deepEqual(parseArgs(["--listen", "127.0.0.1:48886", "--port", "38887", "--ssh", "team-agent"]), { ssh: "team-agent", listen: 48886, port: 38887 });
  for (const listen of ["0.0.0.0:48886", "[::]:48886", ":48886", "localhost:48886", "[::1]:48886", "192.168.1.5:48886", "team.example.ts.net:48886", "*:48886"]) {
    assert.throws(() => parseArgs(["--ssh", "team-agent", "--listen", listen]), /127\.0\.0\.1 only/, listen);
  }
  for (const argv of [[], ["--ssh", "team-agent"], ["--listen", "48886"], ["--ssh", "team-agent", "--listen", "0"], ["--ssh", "team-agent", "--listen", "65536"], ["--ssh", "team-agent", "--listen", "48886", "--port", "x"],
    ["--ssh", "-oProxyCommand=sh", "--listen", "48886"], ["--ssh", "team-agent", "--listen", "48886", "--host", "0.0.0.0"], ["--ssh", "team-agent", "--listen"]]) {
    assert.throws(() => parseArgs(argv), /usage|port from 1 to 65535|host alias/, argv.join(" "));
  }

  const fake = fakeSsh(t), said = [];
  const relay = startRelay({ ssh: "team-agent", listen: 0, port: 38886, env: fake.env, say: line => said.push(line), masterRetryMs: 20 });
  t.after(() => relay.stop());
  await relay.listening;
  const { address, port } = relay.server.address();
  assert.equal(address, "127.0.0.1", "loopback only");
  const masters = () => fake.calls().filter(call => call.master), channels = () => fake.calls().filter(call => !call.master);
  await until(() => masters().length === 1, "the master connection");
  const control = masters()[0].argv[masters()[0].argv.indexOf("-S") + 1];
  assert.deepEqual(masters()[0].argv.filter(arg => arg.startsWith("-") && arg !== "-o"), ["-M", "-N", "-S"]);
  assert.equal(masters()[0].argv.at(-1), "team-agent");

  const sockets = [];
  for (let i = 0; i < 11; i += 1) sockets.push(await open(port, `connection ${i}`));
  assert.equal(channels().length, 11, "one SSH command channel per connection");
  const multiplexed = call => call.argv.includes("-S") && call.argv[call.argv.indexOf("-S") + 1] === control;
  assert.deepEqual(channels().map(multiplexed), [...Array(9).fill(true), false, false], "at most nine channels on the master; the rest connect on their own");
  for (const call of channels()) {
    assert.equal(call.argv.at(-2), "team-agent");
    assert.equal(call.argv.at(-1), `node -e 'const s=require("node:net").connect(38886,"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));'`);
    assert.ok(call.argv.join(" ").includes("ControlMaster=no"));
    assert.doesNotMatch(call.argv.join(" "), /(?:^| )-[LRDW]\b|Forward/, "command channels only: no forwarding");
    if (!multiplexed(call)) assert.ok(call.argv.join(" ").includes("ControlPath=none"));
  }
  // A closed connection ends its channel and frees its place on the master.
  sockets.shift().destroy();
  await until(() => !alive(channels()[0].pid), "the closed connection's channel to end");
  sockets.push(await open(port, "a freed place"));
  assert.equal(multiplexed(channels().at(-1)), true);

  process.kill(masters()[0].pid, "SIGKILL");
  await until(() => said.some(line => line.startsWith("the SSH master connection ended (SIGKILL)")), "the master's end to be reported");
  await until(() => masters().length === 2 && existsSync(control), "a new master");
  assert.ok(alive(masters()[1].pid));

  await relay.stop();
  assert.deepEqual(fake.calls().filter(call => alive(call.pid)), [], "stopping leaves no ssh child");
  assert.equal(relay.server.listening, false);
  assert.equal(existsSync(control), false, "the private control directory is removed");
});

test("a slow client receives all of an answer whose channel has already ended", async t => {
  const { startRelay } = await import("../container/agent-bb/relay.mjs");
  const fake = fakeSsh(t), bytes = 20 * 1024 * 1024;
  const relay = startRelay({ ssh: "team-agent", listen: 0, env: { ...fake.env, FAKE_SSH_ANSWER_BYTES: String(bytes) }, say: () => {}, lingerMs: 600 });
  t.after(() => relay.stop());
  await relay.listening;
  const received = await Promise.all([0, 1, 2].map(() => new Promise((resolve, reject) => {
    const socket = connect(relay.server.address().port, "127.0.0.1");
    let total = 0;
    // A reader slower than the channel: it pauses after every chunk.
    socket.on("data", chunk => { total += chunk.length; socket.pause(); setTimeout(() => socket.resume(), 2); });
    socket.once("error", reject);
    socket.once("end", () => { socket.end(); resolve(total); });
  })));
  assert.deepEqual(received, [bytes, bytes, bytes]);
  await until(() => fake.calls().filter(call => !call.master).every(call => !alive(call.pid)), "the channels to end");

  // A client that reads its answer and never closes its side is let go after the linger.
  const connections = () => new Promise((resolve, reject) => relay.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  await until(async () => await connections() === 0, "the three clients to close");
  const idle = connect({ port: relay.server.address().port, host: "127.0.0.1", allowHalfOpen: true });
  t.after(() => idle.destroy());
  idle.on("error", () => {});
  idle.resume();
  const ended = await new Promise(resolve => idle.once("end", () => resolve(Date.now())));
  assert.equal(await connections(), 1, "still held right after the answer");
  await until(async () => await connections() === 0, "the relay to let the idle client go");
  assert.ok(Date.now() - ended >= 500, "not before the linger");
});

test("the relay command refuses a wider listener and closes its children on TERM", async t => {
  const fake = fakeSsh(t);
  const run = args => {
    const child = spawn(process.execPath, [relayFile, ...args], { env: fake.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    return { child, stderr: () => stderr, exited: new Promise(resolve => child.once("exit", (code, signal) => resolve(signal || code))) };
  };
  const refused = run(["--ssh", "team-agent", "--listen", "0.0.0.0:48886"]);
  assert.equal(await refused.exited, 2);
  assert.match(refused.stderr(), /^bb-relay: --listen accepts a port on 127\.0\.0\.1 only/);
  assert.deepEqual(fake.calls(), [], "no ssh starts for a refused listener");

  const port = await new Promise((resolve, reject) => {
    const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => { const free = probe.address().port; probe.close(() => resolve(free)); });
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const before = fake.calls().length, relay = run(["--ssh", "team-agent", "--listen", String(port)]);
    t.after(() => relay.child.kill("SIGKILL"));
    await until(() => relay.stderr().includes(`listening on 127.0.0.1:${port} `) && fake.calls().length === before + 1, "the relay to listen: " + relay.stderr());
    const socket = await open(port, "through the command");
    relay.child.kill(signal);
    assert.equal(await relay.exited, 0, signal + " is a clean exit");
    await until(() => fake.calls().slice(before).every(call => !alive(call.pid)), "its ssh children to end");
    assert.equal(fake.calls().length, before + 2);
    socket.destroy();
  }
});
