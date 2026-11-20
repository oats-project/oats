import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { attachmentName, receiveAttachment, uploadAttachment, sha256Hex } from "../lib/attachments.mjs";
import { deploymentsImported } from "./helpers/host-fixture.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
// short, and its OATS_HOME_DIR is <base>/h: that holds ssh's control socket (ssh/<40 hex>), which ssh needs
// within 86 bytes, under the root run's directory of the file (docs/implementation.md, fixtures)
const base = realpathSync(mkdtempSync(join(tmpdir(), "o-up-")));
deploymentsImported(join(base, "h"));
test.after(() => rmSync(base, { recursive: true, force: true }));
function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }
let n = 0;
function home(name = `dev-${++n}`) { const h = join(base, "ws", "agents", "dev", "instances", name); write(join(h, "instance.json"), JSON.stringify({ instance: name, agent: "dev", home: h })); return h; }
// Every byte value, twice, so text-mode or quoting damage would show.
const payload = Buffer.concat([Buffer.from([...Array(256).keys()]), Buffer.from([...Array(256).keys()].reverse())]);
const sha = createHash("sha256").update(payload).digest("hex");
const cleanEnv = () => { const env = { ...process.env, OATS_HOME_DIR: join(base, "h") }; for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT"]) delete env[k]; return env; };

test("receive stores private bytes inside the instance home, refuses hostile names and the bound, and never overwrites", () => {
  const h = home();
  const r = receiveAttachment(h, "shot.png", payload);
  assert.equal(r.path, join(h, ".oats-attachments", "shot.png")); assert.equal(r.bytes, 512); assert.equal(r.sha256, sha);
  assert.deepEqual(readFileSync(r.path), payload);
  assert.equal(statSync(r.path).mode & 0o777, 0o600); assert.equal(statSync(dirname(r.path)).mode & 0o777, 0o700);
  assert.equal(receiveAttachment(h, "shot.png", payload).path, join(h, ".oats-attachments", "shot-2.png"), "a taken name gets a suffix, the original stays");
  assert.equal(receiveAttachment(h, "shot.png", payload).path, join(h, ".oats-attachments", "shot-3.png"));
  for (const bad of ["", " ", "a/b", "..\\x", "..", ".", "-rf", "--name", "x\0y", "tab\tname", "x".repeat(201)]) assert.throws(() => attachmentName(bad), (e) => e.code === "E_BAD_ARGS", JSON.stringify(bad));
  assert.throws(() => receiveAttachment(join(base, "nowhere"), "a.txt", payload), (e) => e.code === "E_SESSION_UNKNOWN", "not an instance home");
  assert.throws(() => receiveAttachment(h, "big.bin", payload, { maxBytes: 100 }), (e) => e.code === "E_UPLOAD_TOO_LARGE");
  assert.equal(existsSync(join(h, ".oats-attachments", "big.bin")), false, "nothing written above the bound");
});

test("the CLI: upload copies a local file by home; receive reads stdin; both answer the envelope", () => {
  const h = home();
  const src = join(base, "local", "drop it.jpg"); write(src, payload);
  let r = spawnSync(process.execPath, [CLI, "session", "upload", "--file", src, "--home", h, "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const up = JSON.parse(r.stdout.trim());
  assert.equal(up.ok, true); assert.equal(up.result.path, join(h, ".oats-attachments", "drop it.jpg")); assert.equal(up.result.sha256, sha); assert.equal(up.result.bytes, 512);
  assert.deepEqual(readFileSync(up.result.path), payload);
  r = spawnSync(process.execPath, [CLI, "session", "receive", "--home", h, "--name", "paste.png", "--json"], { env: cleanEnv(), input: payload, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rc = JSON.parse(r.stdout.trim());
  assert.equal(rc.result.path, join(h, ".oats-attachments", "paste.png")); assert.equal(rc.result.sha256, sha);
  r = spawnSync(process.execPath, [CLI, "session", "receive", "--home", h, "--name", "../escape", "--json"], { env: cleanEnv(), input: payload, encoding: "utf8" });
  assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout.trim()).error.code, "E_BAD_ARGS");
  assert.equal(existsSync(join(h, ".oats-attachments", "..", "escape")), false);
  r = spawnSync(process.execPath, [CLI, "session", "upload", "--file", join(base, "missing.bin"), "--home", h, "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(JSON.parse(r.stdout.trim()).error.code, "E_BAD_ARGS");
});

test("a routed upload streams the bytes on ssh stdin to the real receiver over the saved route, verifies the checksum, and is refused by a remote without the feature", () => {
  const env = cleanEnv();
  // A fake ssh that runs the remote command through sh -c with THIS stdin.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const log = join(base, "ssh.log");
  write(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\nexec sh -c "$1"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  env.PATH = `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const workspace = join(base, "ws");
  const servers = { servers: {
    build: { sshHost: "build-host", workspace, oatsPath: CLI },
    old: { sshHost: "old-host", workspace, oatsPath: join(base, "old-oats.sh") },
    liar: { sshHost: "liar-host", workspace, oatsPath: join(base, "liar-oats.sh") },
  } };
  write(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify(servers));
  // An old remote advertises no session-upload; a lying remote stores different bytes.
  write(join(base, "old-oats.sh"), `#!/bin/sh\necho '{"schemaVersion":1,"name":"@awebai/oats","version":"0.69.15","desktopApi":1,"harnesses":["pi"],"sessionBackends":["tmux"],"launchOptions":[],"remote":["session","session-start"],"features":["retire-home","session-start"]}'\n`);
  write(join(base, "liar-oats.sh"), `#!/bin/sh\ncase "$1" in version) echo '{"schemaVersion":1,"name":"@awebai/oats","version":"0.69.15","desktopApi":1,"harnesses":["pi"],"sessionBackends":["tmux"],"launchOptions":[],"remote":["session","session-upload"],"features":["session-upload"]}';; *) cat >/dev/null; echo '{"schemaVersion":1,"ok":true,"result":{"path":"/srv/x/.oats-attachments/drop.bin","bytes":3,"sha256":"deadbeef"}}';; esac\n`);
  for (const f of ["old-oats.sh", "liar-oats.sh"]) chmodSync(join(base, f), 0o755);
  const h = home("dev-remote");
  for (const [server, name] of [["build", "dev-remote"], ["old", "dev-old"], ["liar", "dev-liar"]]) write(join(env.OATS_HOME_DIR, "remote", server, `${name}.json`), JSON.stringify({ serverId: server, instance: name, home: h, target: { sshHost: servers.servers[server].sshHost, workspace, oatsPath: servers.servers[server].oatsPath } }));
  const src = join(base, "local", "drop.bin"); write(src, payload);
  let r = spawnSync(process.execPath, [CLI, "session", "upload", "--server", "build", "--instance", "dev-remote", "--file", src, "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const up = JSON.parse(r.stdout.trim());
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.result.path, join(h, ".oats-attachments", "drop.bin")); assert.equal(up.result.sha256, sha); assert.equal(up.result.server, "build"); assert.equal(up.result.instance, "dev-remote");
  assert.deepEqual(readFileSync(up.result.path), payload, "bytes arrived through ssh stdin unchanged");
  const sshLog = readFileSync(log, "utf8");
  assert.match(sshLog, /session receive --home .* --name drop\.bin --json/, "receive ran on the host with a quoted name");
  assert.equal(sshLog.includes(src), false, "the local path never travels");
  // Library-level: the same route through the module, with io.execFileSync observing the input.
  let seenInput;
  const saved = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = env.OATS_HOME_DIR;
  let lib;
  try { lib = uploadAttachment({ file: src, server: "build", instance: "dev-remote" }, { execFileSync: (b, argv, opts) => { if (argv.at(-1).includes("version --json")) return execFileSync(b, argv, { encoding: "utf8", env }); seenInput = opts.input; return execFileSync(b, argv, { ...opts, encoding: "utf8", env }); } }); }
  finally { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; }
  assert.ok(Buffer.isBuffer(seenInput) && seenInput.equals(payload)); assert.equal(lib.sha256, sha);
  // Feature gate: refused before any bytes are sent.
  const before = readFileSync(log, "utf8");
  r = spawnSync(process.execPath, [CLI, "session", "upload", "--server", "old", "--instance", "dev-old", "--file", src, "--json"], { encoding: "utf8", env });
  assert.equal(JSON.parse(r.stdout.trim()).error.code, "E_REMOTE_INCOMPATIBLE");
  assert.equal(readFileSync(log, "utf8").split("session receive").length, before.split("session receive").length, "no receive was sent to the old remote");
  // Checksum mismatch: the remote's answer is not trusted.
  r = spawnSync(process.execPath, [CLI, "session", "upload", "--server", "liar", "--instance", "dev-liar", "--file", src, "--json"], { encoding: "utf8", env });
  const bad = JSON.parse(r.stdout.trim());
  assert.equal(bad.error.code, "E_UPLOAD_FAILED"); assert.match(bad.error.message, /deadbeef/); assert.match(bad.error.message, /left for inspection/);
  assert.equal(sha256Hex(payload), sha);
});

test("corrections: simultaneous same-name receives never clobber, a planted symlink or symlinked directory is refused, a stalled stdin costs no CPU, both probe lists must carry the token", async () => {
  const { readStreamBounded } = await import("../lib/attachments.mjs");
  const { PassThrough } = await import("node:stream");
  const { symlinkSync } = await import("node:fs");
  const h = home();
  // Two receives of one name in parallel processes: two distinct files, both intact.
  const a = Buffer.alloc(200000, 1), b = Buffer.alloc(200000, 2);
  const { spawn } = await import("node:child_process");
  const run = (input) => new Promise((res) => { const p = spawn(process.execPath, [CLI, "session", "receive", "--home", h, "--name", "Screenshot.png", "--json"], { env: cleanEnv() }); let out = ""; p.stdout.on("data", (d) => { out += d; }); p.on("close", (code) => res({ code, out })); p.stdin.end(input); });
  const [ra, rb] = await Promise.all([run(a), run(b)]);
  assert.equal(ra.code, 0, ra.out); assert.equal(rb.code, 0, rb.out);
  const pa = JSON.parse(ra.out).result.path, pb = JSON.parse(rb.out).result.path;
  assert.notEqual(pa, pb, "two files");
  assert.ok([pa, pb].every((p) => /Screenshot(-2)?\.png$/.test(p)));
  assert.deepEqual(readFileSync(pa), a); assert.deepEqual(readFileSync(pb), b);
  // First uploads into a home with NO attachments directory yet, in parallel: both succeed, one directory.
  const fresh = home();
  assert.equal(existsSync(join(fresh, ".oats-attachments")), false);
  const first = (input) => new Promise((res) => { const p = spawn(process.execPath, [CLI, "session", "receive", "--home", fresh, "--name", "first.png", "--json"], { env: cleanEnv() }); let out = ""; p.stdout.on("data", (d) => { out += d; }); p.on("close", (code) => res({ code, out })); p.stdin.end(input); });
  const firsts = await Promise.all([first(a), first(b), first(payload)]);
  for (const f of firsts) assert.equal(f.code, 0, f.out);
  const firstPaths = firsts.map((f) => JSON.parse(f.out).result.path);
  assert.equal(new Set(firstPaths).size, 3, "three distinct files from three simultaneous first uploads");
  assert.equal(statSync(join(fresh, ".oats-attachments")).mode & 0o777, 0o700);
  // A symlink planted under the next candidate name is skipped, never followed; the outside target is untouched.
  const outside = join(base, "outside.txt"); writeFileSync(outside, "keep");
  symlinkSync(outside, join(h, ".oats-attachments", "Screenshot-3.png"));
  const r3 = receiveAttachment(h, "Screenshot.png", payload);
  assert.equal(r3.path, join(h, ".oats-attachments", "Screenshot-4.png")); assert.equal(readFileSync(outside, "utf8"), "keep");
  // A symlinked attachments directory is refused with nothing written outside.
  const h2 = home(); const elsewhere = join(base, "elsewhere"); mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(h2, ".oats-attachments"));
  assert.throws(() => receiveAttachment(h2, "x.png", payload), (e) => e.code === "E_UPLOAD_FAILED");
  assert.equal(existsSync(join(elsewhere, "x.png")), false);
  // A stalled sender: half the bytes, a pause, the rest. The wait is event-driven (no busy retry).
  const stream = new PassThrough();
  const pending = readStreamBounded(stream, 1024 * 1024);
  stream.write(payload.subarray(0, 256));
  const cpu0 = process.cpuUsage();
  await new Promise((r) => setTimeout(r, 400));
  const cpu = process.cpuUsage(cpu0);
  assert.ok((cpu.user + cpu.system) / 1000 < 100, `idle wait used ${(cpu.user + cpu.system) / 1000} ms CPU`);
  stream.end(payload.subarray(256));
  assert.deepEqual(await pending, payload);
  const big = new PassThrough(); const tooBig = readStreamBounded(big, 100); big.write(Buffer.alloc(101));
  await assert.rejects(tooBig, (e) => e.code === "E_UPLOAD_TOO_LARGE");
  // Token gate: the token must be in BOTH probe lists; missing arrays are incompatibility.
  const probes = [
    { remote: ["session", "session-upload"], features: ["retire-home"] },
    { remote: ["session"], features: ["session-upload"] },
    { remote: undefined, features: undefined },
  ];
  for (const probe of probes) {
    const exec = (bin, argv) => JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: "0.69.15", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], ...probe });
    const saved = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "h");
    try {
      const src = join(base, "local", "gate.bin"); write(src, payload);
      assert.throws(() => uploadAttachment({ file: src, server: "build", instance: "dev-remote" }, { execFileSync: exec }), (e) => e.code === "E_REMOTE_INCOMPATIBLE", JSON.stringify(probe));
    } finally { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; }
  }
});
