import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harnessToken } from "../lib/harness-token.mjs";

const CLI = resolve("bin/oats.mjs");
// Independently checked with Python hashlib, as used by the fixed receiver.
const FINGERPRINTS = { claude: "sha256:86d07a18688a5f7a", codex: "sha256:4e9fc8552b4c2083", pi: "sha256:ba7f449af02fd715", opencode: "sha256:d1ee38bd37f21a05" };
const base = mkdtempSync(join(tmpdir(), "oats-token-client-"));
test.after(() => rmSync(base, { recursive: true, force: true }));
function fixture(name, { operator = true, label = "team" } = {}) {
  const dir = join(base, name), bin = join(dir, "bin"), config = join(dir, ".oats");
  mkdirSync(bin, { recursive: true }); mkdirSync(config);
  writeFileSync(join(config, "servers.json"), JSON.stringify({ servers: { box: { sshHost: "agent-host", workspace: "/srv/ws", label } } }));
  if (operator) writeFileSync(join(config, "server-operator-routes.json"), JSON.stringify({ box: { operatorSshHost: "operator-host" } }));
  const calls = join(dir, "calls.jsonl");
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
import {readFileSync,appendFileSync} from "node:fs";
import {createHash} from "node:crypto";
const args=process.argv.slice(2), at=args.indexOf("--"), host=args[at+1], words=args.slice(at+2);
appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({host,args})+"\\n");
const [action,harness,name]=words;
const input=readFileSync(0);
if(host==="agent-host"){console.log(JSON.stringify({schemaVersion:1,ok:true,result:JSON.parse(process.env.FIXTURE_ROSTER||'{"agents":[]}')}));process.exit(0);}
if(process.env.FIXTURE_REPLY){process.stdout.write(process.env.FIXTURE_REPLY);process.exit(Number(process.env.FIXTURE_EXIT||0));}
const result={ok:true,harness,name,fingerprint:action==="remove"?null:"sha256:0123456789abcdef",replacedAt:"2026-11-10T00:00:00Z"};
if(action==="install")result.fingerprint="sha256:"+createHash("sha256").update(input).digest("hex").slice(0,16);
console.log(JSON.stringify(result));
`); chmodSync(join(bin, "ssh"), 0o755);
  const env = { ...process.env, HOME: dir, OATS_HOME_DIR: config, PATH: `${bin}:${process.env.PATH}`, FIXTURE_CALLS: calls };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [CLI, "harness", "token", ...args], { encoding: "utf8", ...extra, env: { ...env, ...extra.env } });
  return { dir, config, calls, cli, env };
}

test("token status uses the separate operator route and returns a JSON envelope", () => {
  const fx = fixture("status");
  const r = fx.cli(["status", "codex", "--server", "box", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { schemaVersion: 1, ok: true, result: {
    server: "box", action: "status", harness: "codex", name: "team",
    fingerprint: "sha256:0123456789abcdef", replacedAt: "2026-11-10T00:00:00Z", warnings: [],
  } });
  const call = JSON.parse(readFileSync(fx.calls, "utf8").trim());
  assert.equal(call.host, "operator-host");
  assert.deepEqual(call.args.slice(-3), ["status", "codex", "team"]);
  assert.equal(call.args.includes("ControlPath=none"), true);
  assert.equal(call.args.some((s) => s.startsWith("ControlMaster=")), false);
  for (const option of ["BatchMode=yes", "ConnectTimeout=15", "ServerAliveInterval=15", "ServerAliveCountMax=3"]) assert.equal(call.args.includes(option), true);
});

test("stdin set delivers each harness credential only to the receiver and lists older matching sessions", () => {
  for (const harness of ["claude", "codex", "pi", "opencode"]) {
    const fx = fixture("set-" + harness);
    const value = harness === "claude" ? "sk-ant-oat01-private-fixture-credential" : harness + "-private-fixture-api-key";
    const old = { instance: "older", home: "/srv/ws/older", harness, startedAt: "2026-11-09T12:00:00Z", running: false };
    const roster = { agents: [{ name: "dev", harness, instances: [old,
      { ...old, instance: "newer", startedAt: "2026-11-10T00:00:01Z" },
      { ...old, instance: "equal", startedAt: "2026-11-10T00:00:00Z" },
      { ...old, instance: "same-second", startedAt: "2026-11-10T00:00:00.300Z" },
      { ...old, instance: "last-millisecond", startedAt: "2026-11-10T00:00:00.999Z" },
      { ...old, instance: "other-harness", harness: "other" }, { ...old, instance: "never", startedAt: null },
    ] }] };
    const r = fx.cli(["set", harness, "--server", "box", "--stdin", "--json"], { input: value + "\r\n", env: { FIXTURE_ROSTER: JSON.stringify(roster) } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).result, { server: "box", action: "set", harness, name: "team",
      fingerprint: FINGERPRINTS[harness],
      replacedAt: "2026-11-10T00:00:00Z", warnings: [],
      staleInstances: [
        { instance: "older", agent: "dev", home: "/srv/ws/older", startedAt: old.startedAt },
        { instance: "equal", agent: "dev", home: "/srv/ws/older", startedAt: "2026-11-10T00:00:00Z" },
        { instance: "same-second", agent: "dev", home: "/srv/ws/older", startedAt: "2026-11-10T00:00:00.300Z" },
        { instance: "last-millisecond", agent: "dev", home: "/srv/ws/older", startedAt: "2026-11-10T00:00:00.999Z" },
      ],
    });
    assert.equal((r.stdout + r.stderr).includes(value), false);
    const calls = readFileSync(fx.calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((c) => c.host), ["operator-host", "agent-host"]);
    assert.deepEqual(calls[0].args.slice(-3), ["install", harness, "team"]);
    assert.equal(JSON.stringify(calls).includes(value), false, "every spawned SSH argv excludes the value");
    if (harness === "claude") {
      const text = fx.cli(["set", harness, "--server", "box", "--stdin"], { input: value, env: { FIXTURE_ROSTER: JSON.stringify(roster) } });
      assert.equal(text.status, 0, text.stdout + text.stderr);
      assert.match(text.stdout, /older \(dev\).*next start/);
      assert.equal((text.stdout + text.stderr).includes(value), false);
    }
    const scan = (dir) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name); if (item.isDirectory()) scan(path);
      else assert.equal(readFileSync(path).includes(Buffer.from(value)), false, "the client wrote no credential file or log");
    } }; scan(fx.dir);
  }
});

test("malformed receiver metadata fails closed without forwarding its output", () => {
  const fx = fixture("bad-reply");
  const good = { ok: true, harness: "codex", name: "team", fingerprint: "sha256:0123456789abcdef", replacedAt: "2026-11-10T00:00:00Z" };
  for (const reply of [{ ...good, fingerprint: [good.fingerprint] }, { ...good, harness: "pi" }, { ...good, name: "other" }, { ...good, replacedAt: "2026-02-30T00:00:00Z" }, { ...good, ok: "true" }, { ...good, ok: false }]) {
    const r = fx.cli(["status", "codex", "--server", "box", "--json"], { env: { FIXTURE_REPLY: JSON.stringify(reply) } });
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stdout).error.message, /Unexpected reply/);
    assert.equal(JSON.parse(r.stdout).error.code, "E_HARNESS_TOKEN_DELIVERY");
  }
  const garbage = "unexpected-private-output-fixture";
  const r = fx.cli(["status", "codex", "--server", "box", "--json"], { env: { FIXTURE_REPLY: garbage } });
  assert.equal(r.status, 1);
  assert.equal((r.stdout + r.stderr).includes(garbage), false);
});

test("stale session terminal output escapes remote control characters", () => {
  const fx = fixture("terminal-text");
  const row = { instance: "older\u001b[2J", home: "/srv/ws/older", harness: "codex", startedAt: "Mon,\t09 Nov 2026 12:00:00 GMT" };
  const extra = { input: "private-fixture-key", env: { FIXTURE_ROSTER: JSON.stringify({ agents: [{ name: "dev\u202e", instances: [row] }] }) } };
  const args = ["set", "codex", "--server", "box", "--stdin"];
  const json = fx.cli([...args, "--json"], extra);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).result.staleInstances, [{ instance: row.instance, agent: "dev\u202e", home: row.home, startedAt: row.startedAt }], "JSON preserves the remote data");
  const text = fx.cli(args, extra);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.ok(text.stdout.includes("older\\u{1b}[2J (dev\\u{202e}): started Mon,\\u{9}09 Nov 2026 12:00:00 GMT; picks up the token at its next start."));
  for (const control of ["\u001b", "\u202e", "\t"]) assert.equal((text.stdout + text.stderr).includes(control), false);
});

test("token commands refuse a missing operator route without calling the agent alias", () => {
  const fx = fixture("no-route", { operator: false });
  const registration = { sshHost: "agent-host", workspace: "/srv/ws", label: "team", oatsPath: "/opt/team's oats", path: "/opt/team bin:/usr/bin" };
  writeFileSync(join(fx.config, "servers.json"), JSON.stringify({ servers: { box: registration } }));
  const r = fx.cli(["status", "claude", "--server", "box", "--json"]);
  assert.equal(r.status, 1);
  const error = JSON.parse(r.stdout).error;
  assert.equal(error.code, "E_HARNESS_TOKEN_ROUTE");
  const command = error.message.match(/Register one with (.+?)\. Credentials/)?.[1];
  assert.ok(command, "the remedy includes a complete registration command");
  const parsed = spawnSync("/bin/sh", ["-c", `set -- ${command.replace("<alias>", "operator-host")}; printf '%s\\0' "$@"`], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const words = parsed.stdout.slice(0, -1).split("\0");
  assert.deepEqual(words, ["oats", "server", "add", "box", "--ssh", "agent-host", "--workspace", "/srv/ws", "--label", "team", "--oats", "/opt/team's oats", "--path", "/opt/team bin:/usr/bin", "--operator-ssh", "operator-host", "--replace"]);
  assert.equal(existsSync(fx.calls), false);
  const applied = spawnSync(process.execPath, [CLI, ...words.slice(1), "--json"], { env: fx.env, encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(fx.config, "servers.json"))).servers.box, registration, "the remedy preserves the label and custom executable/PATH");
  assert.equal(fx.cli(["status", "claude", "--server", "box", "--json"]).status, 0, "the preserved label still supplies the default team name");
});

test("remove uses an explicit valid team name and returns only receiver metadata", () => {
  const fx = fixture("remove", { label: "Display label has spaces" });
  const absent = fx.cli(["remove", "pi", "--server", "box", "--json"]);
  assert.equal(absent.status, 1);
  assert.match(JSON.parse(absent.stdout).error.message, /--name/);
  assert.equal(existsSync(fx.calls), false);
  const r = fx.cli(["remove", "pi", "--server", "box", "--name", "other-team", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).result, { server: "box", action: "remove", harness: "pi", name: "other-team", fingerprint: null, replacedAt: "2026-11-10T00:00:00Z", warnings: [] });
});

test("stdin refuses invalid credentials before any SSH call", () => {
  const fx = fixture("bad-input");
  for (const input of [Buffer.alloc(0), Buffer.from(" \r\n\t"), Buffer.from([0xff]), Buffer.from("private\0fixture"), Buffer.from("first\nsecond"), Buffer.from("x".repeat(65536)), Buffer.from("x".repeat(65537))]) {
    const r = fx.cli(["set", "codex", "--server", "box", "--stdin", "--json"], { input });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, "E_HARNESS_TOKEN_INPUT");
    assert.equal(existsSync(fx.calls), false);
  }
  for (const input of ["wrong-private-claude-fixture", "sk-ant-oat" + "x".repeat(504)]) {
    const r = fx.cli(["set", "claude", "--server", "box", "--stdin", "--json"], { input });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).error.code, "E_HARNESS_TOKEN_INPUT");
    assert.equal((r.stdout + r.stderr).includes(input), false);
  }
  assert.equal(existsSync(fx.calls), false);
});

test("stdin accepts a credential whose installed newline fits the file cap", () => {
  const fx = fixture("max-input");
  const value = "x".repeat(65535);
  const r = fx.cli(["set", "opencode", "--server", "box", "--stdin", "--json"], { input: value + "\n" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).result.fingerprint, "sha256:09ab7495d3e61a76");
  assert.equal((r.stdout + r.stderr + readFileSync(fx.calls)).includes(value), false);
});

test("interactive setup is held for Claude and refreshing browser sign-ins are refused", () => {
  const fx = fixture("interactive");
  for (const harness of ["claude", "codex", "pi", "opencode"]) {
    const r = fx.cli(["set", harness, "--server", "box", "--json"]);
    assert.equal(r.status, 1);
    const error = JSON.parse(r.stdout).error;
    assert.equal(error.code, "E_HARNESS_TOKEN_UNSUPPORTED");
    assert.match(error.message, /--stdin/);
    if (harness === "codex" || harness === "pi") assert.match(error.message, /refreshing.*agent-writable.*read-only/);
  }
  assert.equal(existsSync(fx.calls), false, "no login or receiver command was run");
});

test("a successful install stays successful when the session roster cannot be read", () => {
  const fx = fixture("no-roster");
  const r = fx.cli(["set", "pi", "--server", "box", "--stdin", "--json"], { input: "private-pi-fixture-key", env: { FIXTURE_ROSTER: '{"agents":null}' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(r.stdout).result;
  assert.equal(result.staleInstances, null);
  assert.match(result.warnings.join("\n"), /installed.*could not be listed/);
});

test("delivery errors distinguish connection, refusal and malformed replies without leaking stdin in debug", () => {
  const fx = fixture("delivery-errors");
  const value = "private-api-key-must-never-be-shown";
  const bad = { ok: false, harness: "codex", name: "team", fingerprint: null, replacedAt: null, error: "fixture refusal " + value };
  for (const [reply, exit, message] of [
    [value, 255, /Couldn't reach the server/],
    [JSON.stringify(bad), 1, /server refused the credential/],
    [value, 0, /Unexpected reply/],
    [JSON.stringify({ ...bad, ok: true, fingerprint: "sha256:0000000000000000", replacedAt: "2026-11-10T00:00:00Z" }), 0, /Unexpected reply/],
  ]) {
    const r = fx.cli(["set", "codex", "--server", "box", "--stdin", "--json", "--debug"], { input: value, env: { FIXTURE_REPLY: reply, FIXTURE_EXIT: String(exit) } });
    assert.equal(r.status, 1);
    const error = JSON.parse(r.stdout).error;
    assert.equal(error.code, "E_HARNESS_TOKEN_DELIVERY");
    assert.match(error.message, message);
    assert.equal((r.stdout + r.stderr).includes(value), false);
    assert.match(r.stderr, /operator SSH/);
  }
  assert.equal(readFileSync(fx.calls, "utf8").trim().split("\n").length, 4, "a failed or mismatched install never asks the agent roster");
});

test("credential input is bounded and a terminal or missing route is refused before reading", async () => {
  const fx = fixture("stream-input"), prior = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = fx.config;
  const call = (input) => harnessToken({ action: "set", harness: "codex", server: "box", input }, { execFileSync: () => assert.fail("invalid input never reaches SSH") });
  let read = 0;
  try {
    const terminal = { isTTY: true, async *[Symbol.asyncIterator]() { read++; yield Buffer.from("private-fixture"); } };
    await assert.rejects(call(terminal), (e) => e.code === "E_HARNESS_TOKEN_INPUT" && /terminal input would show it/.test(e.message));
    assert.equal(read, 0);
    const oversized = { async *[Symbol.asyncIterator]() { read++; yield Buffer.alloc(65536, "a"); read++; yield Buffer.from("b"); read++; yield Buffer.from("never-read"); } };
    await assert.rejects(call(oversized), (e) => e.code === "E_HARNESS_TOKEN_INPUT");
    assert.equal(read, 2, "the read stops as soon as the cap is crossed");
    rmSync(join(fx.config, "server-operator-routes.json"));
    read = 0;
    await assert.rejects(call(terminal), (e) => e.code === "E_HARNESS_TOKEN_ROUTE");
    assert.equal(read, 0);
  } finally {
    if (prior === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prior;
  }
});

test("unreadable credential sources fail with plain input errors", async () => {
  const fx = fixture("unreadable-input"), prior = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = fx.config;
  const privateError = "private-source-fixture-value";
  try {
    for (const input of [null, {}, { async *[Symbol.asyncIterator]() { throw new Error(privateError); } }]) {
      await assert.rejects(harnessToken({ action: "set", harness: "pi", server: "box", input }, { execFileSync: () => assert.fail("unreadable input never reaches SSH") }), (e) => e.code === "E_HARNESS_TOKEN_INPUT" && !e.message.includes(privateError));
    }
  } finally {
    if (prior === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prior;
  }
});
