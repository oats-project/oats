// Capability commands route with `--server <id>` (awebai/oats#517, feature
// capability-route): `oats <namespace> <command> … --server <id>` runs the same
// argv, minus `--server <id>`, as `oats <namespace> <command> …` in the
// registered deployment on the host (cwd: the kernel's capability dispatch finds
// its deployment from there). Stdin is forwarded untouched and never logged; the
// host's output and exit status are relayed, its --json envelope verbatim.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeBin } from "./helpers/fake-ssh.mjs";
import { redactArgv, routeCapability, serverFlagOf } from "../lib/servers.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);

/** A host whose "oats" records what reached it (argv, cwd, stdin bytes) and answers like a provider. */
function setup() {
  const base = mkdtempSync("/tmp/oats-cr-"); // short: the control socket path must fit in 104 bytes
  const { bin, log } = fakeBin(base);
  const ws = join(base, "host-deployment"); mkdirSync(ws);
  const rec = join(base, "rec");
  const hostOats = join(base, "host-oats");
  writeFileSync(hostOats, `#!/bin/sh
${JSON.stringify(process.execPath)} -e '
const fs = require("fs");
const input = fs.readFileSync(0);
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), stdin: input.toString("base64") }));
if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_PROVIDER", message: "from the host" } }) + "\\n");
else { process.stdout.write("host says hi\\n"); process.stderr.write("host warns\\n"); }
process.exit(7);
' -- "$@"
`);
  chmodSync(hostOats, 0o755);
  const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|OATS_HOME$|PI_AGENT)/.test(k)) delete env[k];
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { box: { sshHost: "box-host", workspace: ws, oatsPath: hostOats } } }));
  const oats = (args, input) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: env.HOME, input: input ?? Buffer.alloc(0) });
  const seen = () => { const r = JSON.parse(readFileSync(rec, "utf8")); return { ...r, stdin: Buffer.from(r.stdin, "base64") }; };
  return { base, bin, log, ws, env, oats, seen, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("serverFlagOf / redactArgv: the routing flag is taken out once, before any --; invite values never print", () => {
  assert.deepEqual(serverFlagOf(["aweb", "setup", "--server", "box", "--json"]), { id: "box", argv: ["aweb", "setup", "--json"] });
  assert.deepEqual(serverFlagOf(["aweb", "setup", "--server=box"]), { id: "box", argv: ["aweb", "setup"] });
  assert.deepEqual(serverFlagOf(["aweb", "run", "--", "--server", "x"]), null, "after -- it is the provider's");
  assert.deepEqual(serverFlagOf(["aweb", "setup"]), null);
  assert.deepEqual(serverFlagOf(["aweb", "setup", "--server"]), { id: true, argv: ["aweb", "setup"] }, "no value: refused by the caller");
  assert.deepEqual(redactArgv(["aweb", "setup", "--invite", "tok-1", "--invite=tok-2", "--join", "aweb"]), ["aweb", "setup", "--invite", "<redacted>", "--invite=<redacted>", "--join", "aweb"]);
});

test("argv minus --server, run in the registered deployment, stdin byte for byte, output and exit status relayed", () => {
  const s = setup();
  try {
    const bytes = Buffer.from([0x74, 0x6f, 0x6b, 0x00, 0xff, 0x0a, 0x24, 0x28, 0x69, 0x64, 0x29, 0x27, 0x0a]); // tok\0\xff\n$(id)'\n
    const r = s.oats(["aweb", "setup", "--join", "aweb", "--invite-stdin", "--soul", "dev", "--server", "box"], bytes);
    assert.equal(r.status, 7, r.stderr.toString());
    assert.equal(r.stdout.toString(), "host says hi\n");
    assert.match(r.stderr.toString(), /host warns/);
    const seen = s.seen();
    assert.deepEqual(seen.argv, ["aweb", "setup", "--join", "aweb", "--invite-stdin", "--soul", "dev"], "--soul and every other flag travel untouched");
    assert.equal(seen.cwd, realpathSync(s.ws), "runs in the registration's workspace");
    assert.deepEqual(seen.stdin, bytes, "stdin byte for byte");
    assert.equal(readFileSync(s.log, "utf8").includes("tok"), false, "stdin never reaches a log");

    // --server=<id> forwards ordinary provider options.
    const r2 = s.oats(["aweb", "setup", "--server=box", "--check-only"]);
    assert.equal(r2.status, 7);
    assert.deepEqual(s.seen().argv, ["aweb", "setup", "--check-only"]);
    assert.deepEqual(s.seen().stdin, Buffer.alloc(0));
  } finally { s.cleanup(); }
});

test("--json: the host's envelope is relayed verbatim; ssh failure is one envelope", () => {
  const s = setup();
  try {
    let r = s.oats(["aweb", "setup", "--check-only", "--json", "--soul", "dev", "--server", "box"]);
    assert.equal(r.status, 7);
    assert.equal(r.stdout.toString(), JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_PROVIDER", message: "from the host" } }) + "\n");
    assert.deepEqual(s.seen().argv, ["aweb", "setup", "--check-only", "--json", "--soul", "dev"]);

    writeFileSync(join(s.bin, "ssh"), "#!/bin/sh\necho 'ssh: connect to host box-host port 22: Connection refused' >&2\nexit 255\n");
    r = s.oats(["aweb", "setup", "--join", "aweb", "--invite-stdin", "--json", "--server", "box"]);
    assert.equal(r.status, 1);
    const env = JSON.parse(r.stdout.toString());
    assert.equal(env.ok, false);
    assert.equal(env.error.code, "E_SSH");
    assert.match(env.error.message, /oats aweb setup --join aweb --invite-stdin --json/);

    // Text mode: ssh diagnostics go to stderr and its exit status is relayed.
    r = s.oats(["aweb", "setup", "--invite-stdin", "--server", "box"]);
    assert.equal(r.status, 255);
    assert.match(r.stderr.toString(), /--invite-stdin/);
  } finally { s.cleanup(); }
});

test("an unknown server id or a bare --server is refused before anything runs", () => {
  const s = setup();
  try {
    let r = s.oats(["aweb", "setup", "--server", "nope", "--json"]);
    assert.equal(JSON.parse(r.stdout.toString()).error.code, "E_SERVER_UNKNOWN");
    r = s.oats(["aweb", "setup", "--json", "--server"]);
    assert.equal(JSON.parse(r.stdout.toString()).error.code, "E_BAD_ARGS");
  } finally { s.cleanup(); }
});

test("a terminal on stdin forwards nothing: the host's stdin is closed", () => {
  // In process, over an injected transport: what ssh is handed.
  const calls = [];
  const spawn = (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }; };
  const server = { sshHost: "box-host", workspace: "/srv/ws", oatsPath: "oats" };
  // The control directory is prepared under OATS_HOME_DIR: never the operator's own ~/.oats.
  const prev = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = mkdtempSync("/tmp/oats-crt-");
  test.after(() => { rmSync(process.env.OATS_HOME_DIR, { recursive: true, force: true }); if (prev === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prev; });
  routeCapability("box", ["aweb", "setup"], { server, spawnSync: spawn, stdinIsTTY: true, json: false });
  routeCapability("box", ["aweb", "setup"], { server, spawnSync: spawn, stdinIsTTY: false, json: false });
  routeCapability("box", ["aweb", "setup", "--json"], { server, spawnSync: spawn, stdinIsTTY: false, json: true });
  assert.equal(calls[0].opts.stdio[0], "ignore", "a TTY: nothing forwarded, the remote stdin closed");
  assert.equal(calls[1].opts.stdio[0], "inherit", "a pipe or file: forwarded as is");
  assert.deepEqual(calls[1].opts.stdio.slice(1), ["inherit", "inherit"]);
  assert.equal(calls[2].opts.stdio[1], "pipe", "--json: stdout held to relay the envelope verbatim");
  assert.equal(calls[0].argv.at(-1), "cd /srv/ws && oats aweb setup");
});

test("end to end: the host's own kernel dispatches the capability command from the registered deployment", async () => {
  const { v2Deployment } = await import("./helpers/v2-deployment.mjs");
  const fx = v2Deployment({
    capabilities: { "acme.tool": { manifest: { command: "acme", commands: { show: "bin/show.mjs" } }, files: {
      "bin/show.mjs": "import { readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), soul: !!process.env.OATS_SOUL, settings: process.env.OATS_SETTINGS, input }));\n",
    } } },
    souls: { dev: { soul: { capabilities: { "acme.tool": { from: "here" } } } } },
  });
  const s = setup();
  try {
    writeFileSync(join(s.env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { box: { sshHost: "box-host", workspace: fx.dep, oatsPath: CLI } } }));
    s.env.OATS_REMOTE_CACHE = join(s.base, "cache");
    const r = s.oats(["acme", "show", "--soul", "dev", "--flag", "x y", "--server", "box"], Buffer.from("piped through\n"));
    assert.equal(r.status, 0, r.stderr.toString() + r.stdout.toString());
    const out = JSON.parse(r.stdout.toString().trim().split("\n").pop());
    assert.deepEqual(out.argv, ["--soul", "dev", "--flag", "x y"], "the provider gets its argv as typed, minus --server");
    assert.equal(out.soul, true, "dispatched as the deployment's soul dev");
    assert.equal(out.input, "piped through\n");
  } finally { s.cleanup(); fx.cleanup(); }
});


test("routed invite argv refuses both forms before ssh and directs the caller to stdin", () => {
  const s = setup();
  try {
    for (const secret of [["--invite", "SECRET-ARGV"], ["--invite=SECRET-ARGV"]]) {
      const r = s.oats(["aweb", "setup", ...secret, "--server", "box", "--json"]);
      assert.equal(r.status, 1);
      const answer = JSON.parse(r.stdout.toString());
      assert.equal(answer.error.code, "E_BAD_ARGS");
      assert.match(answer.error.message, /--invite-stdin/);
      assert.equal((r.stdout.toString() + r.stderr.toString()).includes("SECRET-ARGV"), false);
      assert.equal(existsSync(s.log), false, "ssh never ran");
    }
  } finally { s.cleanup(); }
});
