import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("bin/oats.mjs");
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
if(process.env.FIXTURE_REPLY){process.stdout.write(process.env.FIXTURE_REPLY);process.exit(Number(process.env.FIXTURE_EXIT||0));}
const result={ok:true,harness,name,fingerprint:action==="remove"?null:"sha256:0123456789abcdef",replacedAt:"2026-11-10T00:00:00Z"};
if(action==="install")result.fingerprint="sha256:"+createHash("sha256").update(input).digest("hex").slice(0,16);
console.log(JSON.stringify(result));
`); chmodSync(join(bin, "ssh"), 0o755);
  const env = { ...process.env, HOME: dir, OATS_HOME_DIR: config, PATH: `${bin}:${process.env.PATH}`, FIXTURE_CALLS: calls };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [CLI, "harness", "token", ...args], { encoding: "utf8", ...extra, env: { ...env, ...extra.env } });
  return { dir, config, calls, cli };
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

test("token commands refuse a missing operator route without calling the agent alias", () => {
  const fx = fixture("no-route", { operator: false });
  const r = fx.cli(["status", "claude", "--server", "box", "--json"]);
  assert.equal(r.status, 1);
  const error = JSON.parse(r.stdout).error;
  assert.equal(error.code, "E_HARNESS_TOKEN_ROUTE");
  assert.match(error.message, /oats server add box --operator-ssh <alias> --replace/);
  assert.equal(existsSync(fx.calls), false);
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
