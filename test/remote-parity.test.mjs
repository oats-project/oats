// Remote parity (0.31.0): every routed ssh call shares a per-user control
// master and detects a dead link; the version probe is asked once per process
// per server and target; remote roster rows carry the facts a local row has.
// The ssh contract is exercised with fake transports; the live proof over
// `ssh localhost` is the release's manual run (docs/servers.md).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkRemote, dropRemoteProbes, rosterGroups, routeCommand, runRemote, sshArgv, writeServers } from "../lib/servers.mjs";
import { remotePanel } from "../packages/client/remote-roster.mjs";
/** The time a remote panel is made at: remotePanel reads no clock, its caller gives the time. */
const AT = "2026-10-11T12:00:00.000Z";

// ssh binds the control socket at `<ControlPath>.<16 random>`: a short
// OATS_HOME_DIR keeps it inside the 104-byte socket path limit (macOS).
const base = mkdtempSync("/tmp/oats-rp-");
const prevHomeDir = process.env.OATS_HOME_DIR;
process.env.OATS_HOME_DIR = join(base, "oh");
test.after(() => {
  if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
  rmSync(base, { recursive: true, force: true });
});

const PROBE = { schemaVersion: 1, name: "@awebai/oats", version: "0.69.15", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["session"], features: ["harness"] };
const target = { sshHost: "h", workspace: "/w", oatsPath: "oats" };

/** A transport that answers the version probe and counts it. */
function countingExec(answer = () => JSON.stringify({ root: "/w/agents", agents: [] })) {
  const calls = { probes: 0, argv: [] };
  const exec = (bin, argv) => {
    calls.argv.push(argv);
    if (String(argv.at(-1)).endsWith("version --json")) { calls.probes++; return JSON.stringify(PROBE); }
    return answer(argv);
  };
  return { exec, calls };
}

test("sshArgv: every routed call is non-interactive, keeps the link alive and shares the per-user control master", () => {
  // Sharing is off unless the caller has checked the control directory (controlUsable).
  assert.deepEqual(sshArgv(target, ["version"]).filter((a) => a.startsWith("Control")), ["ControlPath=none"]);
  const argv = sshArgv(target, ["version", "--json"], { control: true });
  const end = argv.indexOf("--");
  assert.deepEqual(argv.slice(0, end), [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto", "-o", `ControlPath=${join(process.env.OATS_HOME_DIR, "ssh", "%C")}`, "-o", "ControlPersist=60",
  ]);
  assert.deepEqual(argv.slice(end), ["--", "h", "oats version --json"]);
});

test("runRemote: the control socket directory is created private before ssh binds in it; one others can write to is not used", () => {
  const dir = join(process.env.OATS_HOME_DIR, "ssh");
  rmSync(dir, { recursive: true, force: true });
  const warnings = [];
  const { exec, calls } = countingExec();
  const io = { execFileSync: exec, serverId: "perm", warn: (m) => warnings.push(m) };
  runRemote(target, ["status"], io);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.ok(calls.argv.at(-1).includes("ControlMaster=auto"));
  chmodSync(dir, 0o755);
  runRemote(target, ["status"], io);
  assert.ok(calls.argv.at(-1).includes("ControlMaster=auto"), "a directory only its owner can write is used");
  assert.deepEqual(warnings, []);
  chmodSync(dir, 0o775);
  runRemote(target, ["status"], io);
  assert.deepEqual(calls.argv.at(-1).filter((a) => a.startsWith("Control")), ["ControlPath=none"], "a group-writable directory is never handed to ssh");
  assert.equal(warnings.length, 1); assert.match(warnings[0], /writable/);
  chmodSync(dir, 0o700);
});

test("control master: the socket path fits the 104-byte limit at 86 bytes and not at 87; beyond it routing runs without the master, keepalives kept, warned once per server", () => {
  const prev = process.env.OATS_HOME_DIR;
  // ssh binds the master at `<ControlPath>.<16 random chars>`, a NUL-terminated
  // path in a 104-byte sun_path: the ControlPath expands to <dir>/ssh/<40 hex>,
  // so an OATS_HOME_DIR of 41 bytes gives 86 and one of 42 gives 87.
  const warnings = [];
  const { exec, calls } = countingExec();
  const io = (serverId) => ({ execFileSync: exec, serverId, warn: (m) => warnings.push(m) });
  const lastArgv = () => calls.argv.at(-1);
  try {
    process.env.OATS_HOME_DIR = join(base, "l".repeat(41 - base.length - 1));
    assert.equal(join(process.env.OATS_HOME_DIR, "ssh", "x".repeat(40)).length, 86);
    runRemote(target, ["status"], io("fit"));
    assert.ok(lastArgv().includes("ControlMaster=auto"), lastArgv().join(" "));
    assert.deepEqual(warnings, []);
    process.env.OATS_HOME_DIR = join(base, "l".repeat(42 - base.length - 1));
    assert.equal(join(process.env.OATS_HOME_DIR, "ssh", "x".repeat(40)).length, 87);
    runRemote(target, ["status"], io("long"));
    assert.deepEqual(lastArgv().filter((a) => a.startsWith("Control")), ["ControlPath=none"], lastArgv().join(" "));
    assert.ok(lastArgv().includes("ServerAliveInterval=15") && lastArgv().includes("ServerAliveCountMax=3"));
    runRemote(target, ["status"], io("long"));
    assert.equal(warnings.length, 1, "once per process per server id");
    assert.match(warnings[0], /87/); assert.match(warnings[0], /104/); assert.match(warnings[0], /OATS_HOME_DIR/);
    assert.ok(warnings[0].includes(join(process.env.OATS_HOME_DIR, "ssh")), warnings[0]);
    runRemote(target, ["status"], io("other"));
    assert.equal(warnings.length, 2, "another server id is warned on its own");
    process.env.OATS_HOME_DIR = "/" + "x".repeat(120);
    assert.deepEqual(sshArgv(target, ["version"], { control: true }).filter((a) => a.startsWith("Control")), ["ControlPath=none"], "the argv builder alone never names a path ssh cannot bind");
  } finally { process.env.OATS_HOME_DIR = prev; }
});

/** What the real ssh makes of an argv's options, without connecting (ssh -G). */
function sshEffective(argv, config) {
  const opts = argv.slice(1, argv.indexOf("--"));
  const out = execFileSync("ssh", ["-G", "-F", config, ...opts, "localhost"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => { const i = l.indexOf(" "); return [l.slice(0, i), l.slice(i + 1)]; }));
}

test("control master, read by the real ssh: the path is exactly the one checked; a directory ssh would read as syntax, and every fallback, disable sharing even over the user's own Control* config", () => {
  const prev = process.env.OATS_HOME_DIR;
  const userConfig = join(base, "ssh_config");
  writeFileSync(userConfig, `Host *\n  ControlMaster auto\n  ControlPersist 60\n  ControlPath ${join(base, "missing")}/%C\n`);
  const warnings = [];
  const { exec, calls } = countingExec();
  try {
    const eff = sshEffective(sshArgv(target, ["version"], { control: true }), "/dev/null");
    assert.equal(eff.controlmaster, "auto"); assert.equal(eff.controlpersist, "60");
    assert.match(eff.controlpath, new RegExp(`^${join(process.env.OATS_HOME_DIR, "ssh").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{40}$`));
    assert.equal(Buffer.byteLength(eff.controlpath), Buffer.byteLength(join(process.env.OATS_HOME_DIR, "ssh", "x".repeat(40))), "the length checked is the length ssh binds");
    assert.equal(sshEffective(sshArgv(target, ["version"], { control: true }), userConfig).controlpath, eff.controlpath, "explicit -o wins over the user's ControlPath");
    for (const dir of ["a b", "a%z", "a${HOME}b", "a\"b", "a'b", "a#b"]) {
      process.env.OATS_HOME_DIR = join(base, dir);
      runRemote(target, ["status"], { execFileSync: exec, serverId: `syntax-${dir}`, warn: (m) => warnings.push(m) });
      const argv = calls.argv.at(-1);
      assert.deepEqual(argv.filter((a) => a.startsWith("Control")), ["ControlPath=none"], `${dir}: ${argv.join(" ")}`);
      assert.match(warnings.at(-1), /characters ssh reads as syntax/, dir);
      const fallback = sshEffective(["ssh", ...argv], userConfig);
      assert.equal(fallback.controlpath, undefined, `${dir}: sharing is off even with a configured ControlPath (${fallback.controlpath})`);
    }
  } finally { process.env.OATS_HOME_DIR = prev; }
});

test("checkRemote: one version probe per process per server and target; a replaced registration is probed afresh", () => {
  const { exec, calls } = countingExec();
  const io = { execFileSync: exec, serverId: "b" };
  const first = checkRemote(target, io);
  assert.equal(checkRemote(target, io), first, "the cached answer");
  assert.equal(calls.probes, 1);
  checkRemote(target, { ...io, serverId: "c" });
  assert.equal(calls.probes, 2, "another server id is its own entry");
  const moved = { ...target, sshHost: "h2" };
  checkRemote(moved, io);
  assert.equal(calls.probes, 3, "another target is its own entry");
  checkRemote(moved, io);
  assert.equal(calls.probes, 3);
  dropRemoteProbes("b");
  checkRemote(target, io);
  checkRemote(moved, io);
  assert.equal(calls.probes, 5, "dropping a server id forgets every target it was probed at");
  checkRemote(target, { ...io, serverId: "c" });
  assert.equal(calls.probes, 5, "other server ids keep theirs");
  // A registration written with a changed target forgets the old probes of that id.
  writeServers({ b: { sshHost: "h", workspace: "/w" } });
  checkRemote(target, io);
  assert.equal(calls.probes, 5, "an unchanged registration keeps its probe");
  writeServers({ b: { sshHost: "h3", workspace: "/w" } });
  checkRemote(target, io);
  assert.equal(calls.probes, 6, "server add --replace to another target drops the id's probes");
  // A failed probe is never cached.
  let fail = true;
  const flaky = (bin, argv) => { if (fail) { const e = new Error("ssh"); e.status = 255; e.stderr = "Connection refused"; throw e; } return exec(bin, argv); };
  assert.throws(() => checkRemote(target, { execFileSync: flaky, serverId: "d" }), (e) => e.code === "E_SSH");
  fail = false;
  checkRemote(target, { execFileSync: flaky, serverId: "d" });
  assert.equal(calls.probes, 7);
});

test("server roster: instance rows carry the remote status facts, null where the remote does not supply them", async () => {
  writeServers({ build: { sshHost: "build-host", workspace: "/srv/ws" } });
  const snapDir = join(process.env.OATS_HOME_DIR, "remote", "build");
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(join(snapDir, "dev-gone.json"), JSON.stringify({ serverId: "build", instance: "dev-gone", agent: "dev", home: "/srv/ws/agents/dev/instances/dev-gone", agentsRoot: "/srv/ws/agents", target: { sshHost: "build-host", workspace: "/srv/ws", oatsPath: "oats" } }));
  const full = {
    instance: "dev-a", home: "/srv/ws/agents/dev/instances/dev-a", harness: "claude", running: true,
    identity: { alias: "dev-a", address: "acme/dev-a" }, identityAddress: "acme/dev-a", teams: [{ label: "default", team: "acme:t" }],
    startedAt: "2026-09-29T10:00:00.000Z", createdAt: "2026-09-29T09:00:00.000Z", model: "opus", runtimeState: "working",
    parentInstance: "boss", siblingInstance: "dev-b", relation: "child", relativeTo: "boss", spawnOrigin: "instance",
    // #675: the host's work record and its own drift observation, relayed as it answered them.
    work: "worktree", repo: "/srv/ws/repo", branch: "agents/dev-a", modelFrom: "soul", color: "sage", background: true, sameWork: true, attributedHuman: "Ada Lovelace",
    spawnedBy: { instance: "boss", home: "/srv/ws/agents/dev/instances/boss" },
    soul: { repoKey: "github.com/acme/agents", commit: "1111111111111111111111111111111111111111", current: "2222222222222222222222222222222222222222", status: "moved" },
    modules: [
      { name: "acme.x", from: { kind: "member", repoKey: "github.com/acme/agents", commit: "3333333333333333333333333333333333333333" }, commit: "3333333333333333333333333333333333333333", current: { commit: "4444444444444444444444444444444444444444", version: "1.1.0" }, status: "moved" },
      { name: "acme.y", from: { kind: "member", repoKey: "github.com/acme/gone" }, commit: "5555555555555555555555555555555555555555", current: null, status: "missing", reason: "capability-absent" },
    ],
  };
  const bare = { instance: "dev-b", home: "/srv/ws/agents/dev/instances/dev-b", running: false };
  // Feature instance-color: a colour outside the palette is relayed as none.
  // Feature instance-background: only `true` is relayed; anything else is absent, never false.
  // Feature instance-same-work: anything but `sameWork: true` is relayed as absent.
  const odd = { instance: "dev-c", home: "/srv/ws/agents/dev/instances/dev-c", running: false, color: "teal", background: "yes", sameWork: "true" };
  const status = { root: "/srv/ws/agents", agents: [{ name: "dev", harness: "claude", instances: [full, bare, odd] }] };
  const { exec } = countingExec(() => JSON.stringify(status));
  const out = await rosterGroups({ io: { execFileAsync: async (...call) => exec(...call) } });
  const rows = out.groups[0].instances;
  const FIELDS = ["identity", "identityAddress", "teams", "startedAt", "createdAt", "model", "runtimeState", "parentInstance", "siblingInstance", "relation", "relativeTo", "spawnOrigin",
    "work", "repo", "branch", "modelFrom", "soul", "modules", "color", "attributedHuman", "spawnedBy"];
  const a = rows.find((r) => r.instance === "dev-a");
  assert.equal(rows.find((r) => r.instance === "dev-c").color, null, "a colour outside the palette is relayed as null");
  assert.equal(rows.find((r) => r.instance === "dev-a").background, true, "background is relayed");
  for (const n of ["dev-b", "dev-c", "dev-gone"]) assert.equal(Object.hasOwn(rows.find((r) => r.instance === n), "background"), false, `${n}: no background key`);
  assert.equal(a.sameWork, true, "sameWork: true is relayed as the host reported it");
  for (const name of ["dev-b", "dev-c", "dev-gone"]) assert.equal(Object.hasOwn(rows.find((r) => r.instance === name), "sameWork"), false, `${name}: no sameWork, never false or null`);
  for (const k of FIELDS) assert.deepEqual(a[k], full[k], k);
  assert.equal(a.savedRoute, false);
  assert.equal(a.running, true); assert.equal(a.harness, "claude");
  const b = rows.find((r) => r.instance === "dev-b");
  for (const k of FIELDS) assert.equal(b[k], null, `${k} is null when the remote does not supply it`);
  // A saved route the remote no longer lists: same keys, nothing invented.
  const gone = rows.find((r) => r.instance === "dev-gone");
  for (const k of FIELDS) assert.equal(gone[k], null, k);
  assert.equal(gone.missingRemotely, true);
  assert.deepEqual(Object.keys(gone).sort(), Object.keys(b).sort(), "remote rows and saved-route rows share one shape");
  // The Desktop's remote panel spreads the row: the relayed work and drift facts reach it unchanged.
  const panel = Object.fromEntries(remotePanel(out.groups[0], AT).instances.map((r) => [r.instance, r]));
  for (const k of ["work", "repo", "branch", "modelFrom", "soul", "modules"]) {
    assert.deepEqual(panel["dev-a"][k], full[k], `panel ${k}`);
    assert.equal(panel["dev-b"][k], null, `panel ${k} (not supplied)`); assert.equal(panel["dev-gone"][k], null, `panel ${k} (gone)`);
  }
  rmSync(snapDir, { recursive: true, force: true });
});

// ---- the CLI over a counting fake ssh and a fake remote oats ----

const CLI = new URL("../bin/oats.mjs", import.meta.url).pathname;

/** A fake ssh that logs each call's argv (one line, NUL-free) and runs the
 *  remote command word through sh -c; a fake remote oats that answers the
 *  probe and whatever `answers` maps a subcommand line to. */
function fakeHost(dir, { probe = PROBE, answers = {} } = {}) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  const log = join(dir, "ssh.log");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s ' "$@" >> ${JSON.stringify(log)}\nprintf '\\n' >> ${JSON.stringify(log)}\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\nexec sh -c "$1"\n`);
  // An answer is printed as it is: single-quoted, so the host's shell expands nothing in it.
  const literal = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
  const cases = Object.entries(answers).map(([pattern, { stdout = "", exit = 0 }]) => `  *${JSON.stringify(pattern)}*) printf '%s' ${literal(stdout)}; exit ${exit};;`).join("\n");
  const oatsPath = join(dir, "remote-oats");
  writeFileSync(oatsPath, `#!/bin/sh\ncase "$*" in\n  "version --json") printf '%s' ${JSON.stringify(JSON.stringify(probe))};;\n${cases}\n  *) echo "unexpected: $*" >&2; exit 2;;\nesac\n`);
  chmodSync(join(bin, "ssh"), 0o755); chmodSync(oatsPath, 0o755);
  return { bin, log, oatsPath, calls: () => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } } };
}

function cli(env, args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: env.HOME });
  return { ...r, json: () => JSON.parse(r.stdout.trim()) };
}

function cliEnv(dir, host) {
  const env = { ...process.env, PATH: `${host.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, OATS_HOME_DIR: join(dir, "oh"), HOME: join(dir, "home") };
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
  mkdirSync(env.HOME, { recursive: true });
  return env;
}

test("session attach --server: one version probe at most, every call through the same control master; a lost link says so", () => {
  const dir = mkdtempSync(join(base, "att-"));
  const home = "/srv/ws/agents/dev/instances/dev-a";
  const host = fakeHost(dir, { answers: { "session attach --home": { stdout: "attached" } } });
  const env = cliEnv(dir, host);
  mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: "/srv/ws", oatsPath: host.oatsPath } } }));
  let r = cli(env, ["session", "attach", "--server", "build", "--home", home]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "attached");
  const calls = host.calls();
  assert.equal(calls.filter((c) => c.endsWith("version --json ")).length, 1, calls.join("\n"));
  const control = `-o ControlMaster=auto -o ControlPath=${join(env.OATS_HOME_DIR, "ssh", "%C")} -o ControlPersist=60 --`;
  assert.ok(calls.every((c) => c.includes(control)), calls.join("\n"));
  assert.ok(calls.at(-1).startsWith("-t "), "the viewer gets a PTY");
  assert.equal(r.stderr, "", "no fallback warning with a private, short control directory");

  // ssh's own failure (exit 255), a lost link or one never made: say what is known.
  const dead = fakeHost(mkdtempSync(join(base, "dead-")), { answers: { "session attach --home": { exit: 255 } } });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: "/srv/ws", oatsPath: dead.oatsPath } } }));
  r = cli({ ...env, PATH: `${dead.bin}:${dirname(process.execPath)}:/usr/bin:/bin` }, ["session", "attach", "--server", "build", "--home", home]);
  assert.equal(r.status, 255);
  assert.match(r.stderr, /ssh to build-host ended with an error \(exit 255\); if the link was lost, the instance keeps running on build\. Reattach with: oats session attach --server build --home \/srv\/ws\/agents\/dev\/instances\/dev-a/);
});

test("session attach --server: ssh failing before the viewer (the probe, the name's roster) exits 255 and names the host; any other refusal exits 1 (#349)", () => {
  const dir = mkdtempSync(join(base, "att-pre-"));
  const home = "/srv/ws/agents/dev/instances/dev-a";
  const register = (env, oatsPath) => { mkdirSync(env.OATS_HOME_DIR, { recursive: true }); writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath } } })); };
  // ssh itself fails on the probe (the link is down): 255, like ssh failing under the viewer.
  const down = join(dir, "down-bin"); mkdirSync(down, { recursive: true });
  writeFileSync(join(down, "ssh"), "#!/bin/sh\necho 'ssh: connect to host build-host port 22: Connection refused' >&2\nexit 255\n", { mode: 0o755 });
  const env = { ...cliEnv(dir, { bin: down }), PATH: `${down}:${dirname(process.execPath)}:/usr/bin:/bin` };
  register(env, "oats");
  let r = cli(env, ["session", "attach", "--server", "build", "--home", home]);
  assert.equal(r.status, 255, r.stderr);
  assert.match(r.stderr, /^oats: ssh to build-host failed: ssh: connect to host build-host port 22: Connection refused/m);
  // --json keeps its envelope, with the same exit.
  r = cli(env, ["session", "attach", "--server", "build", "--home", home, "--json"]);
  assert.equal(r.status, 255);
  assert.equal(r.json().error.code, "E_SSH");
  assert.match(r.json().error.message, /^ssh to build-host failed: /);
  // ssh fails while the name resolves through the host's roster: 255 too.
  const flaky = fakeHost(join(dir, "flaky"), { probe: FULL_PROBE, answers: { [`status --json --dir ${WS}`]: { exit: 255 } } });
  const flakyEnv = cliEnv(join(dir, "flaky"), flaky); register(flakyEnv, flaky.oatsPath);
  r = cli(flakyEnv, ["session", "attach", "--server", "build", "--instance", "dev-a"]);
  assert.equal(r.status, 255, r.stderr);
  assert.match(r.stderr, /^oats: ssh to build-host failed: /m);
  // No ssh on this machine at all: nothing ran, so there is no link to come back; exit 1.
  const noSsh = { ...env, PATH: `${dirname(process.execPath)}:/nonexistent` };
  r = cli(noSsh, ["session", "attach", "--server", "build", "--home", home]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^oats: ssh to build-host failed: .*ENOENT/m);
  // A host that answers, but without `oats session`: a refusal, exit 1.
  const old = fakeHost(join(dir, "old"), { probe: { ...PROBE, version: "0.22.1", remote: ["spawn", "retire", "status"] }, answers: { [`status --json --dir ${WS}`]: { stdout: JSON.stringify(ROSTER) } } });
  const oldEnv = cliEnv(join(dir, "old"), old); register(oldEnv, old.oatsPath);
  r = cli(oldEnv, ["session", "attach", "--server", "build", "--home", home]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /does not advertise the `oats session` commands/);
});

test("an E_SSH envelope says details.sshStarted: false when ssh never started; a failed link carries no such details", () => {
  const dir = mkdtempSync(join(base, "ssh-started-"));
  const home = "/srv/ws/agents/dev/instances/dev-a";
  const down = join(dir, "down-bin"); mkdirSync(down, { recursive: true });
  writeFileSync(join(down, "ssh"), "#!/bin/sh\necho 'ssh: connect to host build-host port 22: Connection refused' >&2\nexit 255\n", { mode: 0o755 });
  const env = cliEnv(dir, { bin: down });
  mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: "oats" } } }));
  const noSsh = { ...env, PATH: `${dirname(process.execPath)}:/nonexistent` };
  for (const args of [["session", "inspect", "--server", "build", "--home", home, "--json"], ["server", "check", "build", "--json"]]) {
    let r = cli(noSsh, args);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.json().error.code, "E_SSH", args.join(" "));
    assert.deepEqual(r.json().error.details, { sshStarted: false }, args.join(" "));
    r = cli(env, args);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.json().error.code, "E_SSH", args.join(" "));
    assert.equal(Object.hasOwn(r.json().error, "details"), false, `a link that failed is not marked: ${args.join(" ")}`);
  }
});

// ---- item 3: foreign instances are first-class ----

const FULL_PROBE = { ...PROBE, remote: ["spawn", "retire", "status", "session", "session-start", "session-restart", "session-upload"], features: ["harness", "retire-home", "session-start", "session-restart", "session-upload", "launch-config"] };
const WS = "/srv/ws";
const homeOf = (agent, name) => `${WS}/agents/${agent}/instances/${name}`;
const ROSTER = { root: `${WS}/agents`, agents: [
  { name: "dev", instances: [{ instance: "dev-a", home: homeOf("dev", "dev-a"), running: true }, { instance: "twin", home: homeOf("dev", "twin"), running: false }] },
  { name: "ops", instances: [{ instance: "twin", home: homeOf("ops", "twin"), running: false }] },
] };
const ok = (result) => ({ stdout: JSON.stringify({ schemaVersion: 1, ok: true, result }) });

function foreignSetup(name, answers = {}) {
  const dir = mkdtempSync(join(base, `${name}-`));
  const host = fakeHost(dir, { probe: FULL_PROBE, answers: { [`status --json --dir ${WS}`]: { stdout: JSON.stringify(ROSTER) }, ...answers } });
  const env = cliEnv(dir, host);
  mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: host.oatsPath } } }));
  return { dir, host, env, sent: (pattern) => host.calls().filter((c) => c.includes(pattern)) };
}

test("foreign instances: every routed session command and retire reach a home with no saved route, by --home or by a name unique on the host", () => {
  const home = homeOf("dev", "dev-a");
  const { env, host, sent, dir } = foreignSetup("foreign", {
    [`session inspect --home ${home} --json`]: ok({ home, present: true, state: "running", backend: "tmux" }),
    [`session start --home ${home} --json`]: ok({ instance: "dev-a", home, backend: "tmux", reused: "pane" }),
    [`session restart --home ${home} --json`]: ok({ instance: "dev-a", home, backend: "tmux", reused: "pane" }),
    [`session attach --home ${home}`]: { stdout: "attached" },
    [`retire dev-a --home ${home} --dir ${WS} --json`]: ok({ retired: "dev-a", agent: "dev", removedDir: true }),
  });
  for (const addr of [["--home", home], ["--instance", "dev-a"]]) {
    let r = cli(env, ["session", "inspect", "--server", "build", ...addr, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json().result.home, home); assert.equal(r.json().result.server, "build");
    r = cli(env, ["session", "start", "--server", "build", ...addr, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.json().result.instance, "dev-a");
    r = cli(env, ["session", "restart", "--server", "build", ...addr, "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = cli(env, ["session", "attach", "--server", "build", ...addr]);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.stdout, "attached");
  }
  // Upload: the bytes go to the host's receiver for that home.
  const file = join(dir, "note.txt"); writeFileSync(file, "hello");
  const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: fakeHost(mkdtempSync(join(dir, "upload-")), { probe: FULL_PROBE, answers: {
    [`status --json --dir ${WS}`]: { stdout: JSON.stringify(ROSTER) },
    [`session receive --home ${home} --name note.txt --json`]: ok({ path: `${home}/.oats-attachments/note.txt`, bytes: 5, sha256: sha }),
  } }).oatsPath } } }));
  let r = cli(env, ["session", "upload", "--server", "build", "--instance", "dev-a", "--file", file, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.json().result.home, home);
  // Retire by name: the name resolves through the host's roster to its exact home.
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: host.oatsPath } } }));
  r = cli(env, ["retire", "dev-a", "--server", "build", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.json().result.retired, "dev-a");
  assert.equal(sent(`retire dev-a --home ${home} --dir ${WS} --json`).length, 1, host.calls().join("\n"));
  r = cli(env, ["retire", "dev-a", "--server", "build", "--home", home, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // One status read resolves a name; the probe is asked once per command.
  const before = host.calls().length;
  cli(env, ["session", "inspect", "--server", "build", "--instance", "dev-a", "--json"]);
  const calls = host.calls().slice(before);
  assert.deepEqual(calls.map((c) => (c.includes("version --json") ? "probe" : c.includes("status --json") ? "status" : "inspect")), ["status", "probe", "inspect"]);
});

test("routed session inspect relays the execution host's running as it answered it, and never adds one an older host did not send", () => {
  const live = homeOf("dev", "dev-a"), fallback = homeOf("dev", "twin"), older = homeOf("ops", "twin");
  const { env } = foreignSetup("inspect-running", {
    [`session inspect --home ${live} --json`]: ok({ home: live, backend: "tmux", present: true, state: "unknown", paneId: "%3", size: { cols: 80, rows: 24 }, running: true, waitingOnYou: null }),
    [`session inspect --home ${fallback} --json`]: ok({ home: fallback, backend: "tmux", present: true, state: "shell", paneId: "%4", size: { cols: 80, rows: 24 }, running: false, waitingOnYou: null }),
    // A host from before session-inspect-running (FULL_PROBE does not advertise it): the field is absent.
    [`session inspect --home ${older} --json`]: ok({ home: older, backend: "tmux", present: true, state: "unknown", paneId: "%5", waitingOnYou: null }),
  });
  const inspected = (home) => { const r = cli(env, ["session", "inspect", "--server", "build", "--home", home, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr); return r.json().result; };
  assert.equal(inspected(live).running, true);
  const shell = inspected(fallback);
  assert.deepEqual([shell.state, shell.present, shell.running], ["shell", true, false]);
  const old = inspected(older);
  assert.equal(old.state, "unknown");
  assert.equal(Object.hasOwn(old, "running"), false, "no running synthesized from an older host's state");
});

test("foreign instances: an ambiguous name lists its homes, an unknown one says the host lists none, a mismatched home is refused, the host's own refusal is relayed", () => {
  const bad = "/srv/elsewhere/x";
  const { env, sent } = foreignSetup("foreign-err", {
    [`session start --home ${bad} --json`]: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_NOT_INSTANCE_HOME", message: `${bad} is not an instance home` } }), exit: 1 },
  });
  for (const cmd of [["session", "inspect"], ["session", "start"], ["session", "attach"]]) {
    let r = cli(env, [...cmd, "--server", "build", "--instance", "twin", "--json"]);
    assert.notEqual(r.status, 0);
    const err = r.stdout.trim() ? r.json().error : { code: null, message: r.stderr };
    if (err.code) assert.equal(err.code, "E_AMBIGUOUS");
    assert.ok(err.message.includes(homeOf("dev", "twin")) && err.message.includes(homeOf("ops", "twin")), err.message);
    r = cli(env, [...cmd, "--server", "build", "--instance", "ghost", "--json"]);
    assert.notEqual(r.status, 0);
    if (r.stdout.trim()) { assert.equal(r.json().error.code, "E_SNAPSHOT_UNKNOWN"); assert.match(r.json().error.message, /no instance "ghost" on server build: neither a saved route here nor its roster names one/); }
    else assert.match(r.stderr, /no instance "ghost" on server build/);
  }
  let r = cli(env, ["retire", "twin", "--server", "build", "--json"]);
  assert.equal(r.json().error.code, "E_AMBIGUOUS");
  assert.deepEqual(r.json().error.details?.candidates?.map((c) => c.home), [homeOf("dev", "twin"), homeOf("ops", "twin")]);
  assert.equal(sent("retire twin").length, 0, "nothing retired on an ambiguous name");
  r = cli(env, ["retire", "ghost", "--server", "build", "--json"]);
  assert.equal(r.json().error.code, "E_SNAPSHOT_UNKNOWN");
  r = cli(env, ["session", "inspect", "--server", "build", "--instance", "dev-a", "--home", homeOf("dev", "twin"), "--json"]);
  assert.equal(r.json().error.code, "E_HOME_MISMATCH");
  r = cli(env, ["session", "start", "--server", "build", "--home", bad, "--json"]);
  assert.equal(r.status, 1); assert.equal(r.json().error.code, "E_NOT_INSTANCE_HOME", "the host's refusal is relayed as is");
});

test("server roster: every row the host reports is addressable; savedRoute is information only", () => {
  const { env } = foreignSetup("addr");
  const r = cli(env, ["server", "roster", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.json().result.groups[0].instances;
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.equal(row.addressable, true); assert.equal(row.savedRoute, false); }
});

test("a remote without the session commands: the fallback hint names the instance's recorded tmux session, else the remote's default; a recorded socket is named, and the hint survives a paste", () => {
  const old = { ...FULL_PROBE, version: "0.22.1", remote: ["spawn", "retire", "status"], features: [] };
  const dir = mkdtempSync(join(base, "hint-"));
  const oddSocket = "/tmp/it's a dir/oats";
  const oddSession = "team x; echo $HOME `id` 'q'";
  const roster = { root: `${WS}/agents`, agents: [{ name: "dev", instances: [
    { instance: "dev-a", home: homeOf("dev", "dev-a"), tmux: { session: "team-x", window: "dev-a" } },
    { instance: "dev-b", home: homeOf("dev", "dev-b") },
    { instance: "dev-c", home: homeOf("dev", "dev-c"), tmux: { session: "oats-agents", window: "dev-c", socket: "/tmp/tmux-1000/oats" } },
    { instance: "dev-d", home: homeOf("dev", "dev-d"), tmux: { session: "oats-agents", window: "dev-d", socket: oddSocket } },
    { instance: "dev-e", home: homeOf("dev", "dev-e"), tmux: { session: oddSession, window: "dev-e" } },
  ] }] };
  const host = fakeHost(dir, { probe: old, answers: { [`status --json --dir ${WS}`]: { stdout: JSON.stringify(roster) } } });
  const env = cliEnv(dir, host);
  mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: host.oatsPath } } }));
  let r = cli(env, ["session", "inspect", "--server", "build", "--home", homeOf("dev", "dev-a"), "--json"]);
  assert.equal(r.json().error.code, "E_REMOTE_INCOMPATIBLE");
  assert.match(r.json().error.message, /attach with ssh -t build-host 'tmux attach -t team-x:dev-a'$/, "the remote command is one word, with or without a socket");
  r = cli(env, ["session", "inspect", "--server", "build", "--home", homeOf("dev", "dev-b"), "--json"]);
  assert.match(r.json().error.message, /attach with ssh -t build-host 'tmux attach -t pi-agents'$/, "a kernel before 0.22.2 opened its windows in pi-agents");
  // A row that records its server's socket: the hint names it, and the remote command is one word.
  r = cli(env, ["session", "inspect", "--server", "build", "--home", homeOf("dev", "dev-c"), "--json"]);
  assert.match(r.json().error.message, /attach with ssh -t build-host 'tmux -S \/tmp\/tmux-1000\/oats attach -t oats-agents:dev-c'$/);
  // A socket with a space and a quote, pasted: the local shell hands ssh one word (the remote command),
  // and the remote shell reads that word back as tmux's own arguments.
  const words = (line) => execFileSync("/bin/sh", ["-c", `for word in ${line}; do printf '%s\\n' "$word"; done`], { encoding: "utf8" }).split("\n").slice(0, -1);
  const throughTwoShells = (instance) => {
    const hint = cli(env, ["session", "inspect", "--server", "build", "--home", homeOf("dev", instance), "--json"]).json().error.message.match(/attach with (ssh -t build-host .*)$/)[1];
    const local = words(hint);
    assert.deepEqual(local.slice(0, 3), ["ssh", "-t", "build-host"]);
    assert.equal(local.length, 4, `the remote command is one word: ${hint}`);
    return words(local[3]);
  };
  assert.deepEqual(throughTwoShells("dev-d"), ["tmux", "-S", oddSocket, "attach", "-t", "oats-agents:dev-d"]);
  // The same without a recorded socket: a session name with a space and shell characters stays one argument.
  assert.deepEqual(throughTwoShells("dev-e"), ["tmux", "attach", "-t", `${oddSession}:dev-e`]);
});

// ---- item 4: the Desktop's reads and lifecycle plans, routed ----

const SURFACE_PROBE = { ...FULL_PROBE, remote: [...FULL_PROBE.remote, "readiness", "instance-events", "instance-git", "lifecycle-plans"],
  features: [...FULL_PROBE.features, "readiness", "instance-events-2", "instance-git", "lifecycle-plans", "retire-retention", "instance-color", "instance-background", "instance-same-work"],
  readinessApi: 2, eventsApi: 2, instanceGitApi: 1, lifecycleApi: 1 };
const HOME_A = homeOf("dev", "dev-a");
const ENVELOPES = {
  readiness: { schemaVersion: 1, ok: true, result: { subject: { kind: "instance", instance: "dev-a", home: HOME_A, soul: "dev" }, summary: { ready: true }, checks: {}, notes: [] } },
  readinessSoul: { schemaVersion: 1, ok: true, result: { subject: { kind: "soul", soul: "dev" }, summary: { ready: false }, checks: {}, notes: [] } },
  events: { schemaVersion: 1, ok: true, result: { eventsApi: 2, instance: "dev-a", home: HOME_A, count: 1, returned: 1, truncated: false, events: [{ at: "2026-09-29T10:00:00.000Z", kind: "spawned", producer: "kernel" }] } },
  git: { schemaVersion: 1, ok: true, result: { instance: "dev-a", home: HOME_A, observation: { branch: "main" }, files: [], summary: {}, notes: [] } },
  diff: { schemaVersion: 1, ok: true, result: { file: { id: "f1", path: "a.txt", kind: "modified" }, against: "index", patch: "@@\n", binary: false, truncated: false } },
  stopPlan: { schemaVersion: 1, ok: true, result: { planRevision: "r1", targets: [], notes: [] } },
  stopApply: { schemaVersion: 1, ok: true, result: { ok: true, results: [], replayed: false } },
  color: { schemaVersion: 1, ok: true, result: { instanceColorApi: 1, instance: "dev-a", home: HOME_A, color: "sage", changed: true } },
  background: { schemaVersion: 1, ok: true, result: { instanceBackgroundApi: 1, instance: "dev-a", home: HOME_A, background: true, changed: true } },
  sameWork: { schemaVersion: 1, ok: true, result: { instance: "dev-a", sameWork: true } },
  // `facts.ownWorktree` (awebai/oats#988): the host's plan crosses with its facts as the host answered them.
  retirePlan: { schemaVersion: 1, ok: true, result: { planRevision: "r2", home: HOME_A, facts: { workMode: "worktree", ownWorktree: true }, defaults: { retainWorktree: true }, notes: [] } },
};
const answer = (envelope) => ({ stdout: JSON.stringify(envelope) });

function surfaceSetup(name, probe = SURFACE_PROBE) {
  const dir = mkdtempSync(join(base, `${name}-`));
  const host = fakeHost(dir, { probe, answers: {
    [`status --json --dir ${WS}`]: { stdout: JSON.stringify(ROSTER) },
    [`readiness --home ${HOME_A} --soul dev --agents-root ${WS}/agents --policy --json`]: answer(ENVELOPES.readiness),
    [`readiness --soul dev --agents-root ${WS}/agents --policy --dir ${WS} --json`]: answer(ENVELOPES.readinessSoul),
    [`instance events dev-a --limit 50 --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.events),
    [`instance git dev-a --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.git),
    [`instance diff dev-a --file f1 --revision r --index-revision i --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.diff),
    [`instance stop dev-a --plan --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.stopPlan),
    [`instance stop dev-a --apply --plan-revision r1 --idempotency-key k1 --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.stopApply),
    [`retire dev-a --plan --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.retirePlan),
    [`instance color dev-a sage --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.color),
    [`instance background dev-a on --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.background),
    [`instance same-work dev-a on --home ${HOME_A} --dir ${WS} --json`]: answer(ENVELOPES.sameWork),
    [`instance events dev-a --home /srv/elsewhere/dev-a --dir ${WS} --json`]: { stdout: JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_HOME_MISMATCH", message: "not a home of dev-a under /srv/ws" } }), exit: 1 },
  } });
  const env = cliEnv(dir, host);
  mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: host.oatsPath } } }));
  return { env, host };
}

const SURFACE_CALLS = [
  ["readiness", ["readiness", "--server", "build", "--home", HOME_A, "--soul", "dev", "--agents-root", `${WS}/agents`, "--policy", "--json"], ENVELOPES.readiness],
  ["readiness", ["readiness", "--server", "build", "--soul", "dev", "--agents-root", `${WS}/agents`, "--policy", "--json"], ENVELOPES.readinessSoul],
  ["instance-events-2", ["instance", "events", "dev-a", "--server", "build", "--limit", "50", "--json"], ENVELOPES.events],
  ["instance-git", ["instance", "git", "dev-a", "--server", "build", "--json"], ENVELOPES.git],
  ["instance-git", ["instance", "diff", "dev-a", "--server", "build", "--file", "f1", "--revision", "r", "--index-revision", "i", "--json"], ENVELOPES.diff],
  ["lifecycle-plans", ["instance", "stop", "dev-a", "--server", "build", "--plan", "--json"], ENVELOPES.stopPlan],
  ["lifecycle-plans", ["instance", "stop", "dev-a", "--server", "build", "--apply", "--plan-revision", "r1", "--idempotency-key", "k1", "--json"], ENVELOPES.stopApply],
  ["lifecycle-plans", ["retire", "dev-a", "--server", "build", "--plan", "--json"], ENVELOPES.retirePlan],
  // Feature instance-color: the feature alone, no API number.
  ["instance-color", ["instance", "color", "dev-a", "sage", "--server", "build", "--json"], ENVELOPES.color],
  // Feature instance-background: the same.
  ["instance-background", ["instance", "background", "dev-a", "on", "--server", "build", "--json"], ENVELOPES.background],
  // Feature instance-same-work: the feature alone, as instance color.
  ["instance-same-work", ["instance", "same-work", "dev-a", "on", "--server", "build", "--json"], ENVELOPES.sameWork],
];

test("routed readiness, instance events, git, diff, stop and retire plans: run on the host, their envelope relayed unchanged", () => {
  const { env, host } = surfaceSetup("surf");
  for (const [, argv, envelope] of SURFACE_CALLS) {
    const r = cli(env, argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.json(), envelope, argv.join(" "));
  }
  // An explicit --dir on the host travels as is.
  const r = cli(env, ["instance", "git", "dev-a", "--server", "build", "--home", HOME_A, "--dir", "/srv/other", "--json"]);
  assert.ok(host.calls().some((c) => c.includes(`instance git dev-a --home ${HOME_A} --dir /srv/other --json`)), host.calls().join("\n"));
  void r;
});

test("routed Desktop reads and plans: a host without the feature is refused before anything is sent; a bad home is refused here or relayed from the host", () => {
  for (const [feature, argv] of SURFACE_CALLS) {
    const probe = { ...SURFACE_PROBE, version: "0.30.3", features: SURFACE_PROBE.features.filter((f) => f !== feature) };
    const { env, host } = surfaceSetup(`old-${feature}`, probe);
    const r = cli(env, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.equal(r.json().error.code, "E_REMOTE_INCOMPATIBLE");
    assert.match(r.json().error.message, new RegExp(`remote oats 0\\.30\\.3 at build-host does not advertise ${feature}`));
    const verb = argv[0] === "instance" ? `instance ${argv[1]}` : argv[0];
    assert.equal(host.calls().filter((c) => c.includes(` ${verb} `) && !c.includes("status --json")).length, 0, `nothing sent: ${host.calls().join("\n")}`);
  }
  // The API number must match too, not only the feature.
  const { env: envApi } = surfaceSetup("old-api", { ...SURFACE_PROBE, eventsApi: 1 });
  assert.equal(cli(envApi, ["instance", "events", "dev-a", "--server", "build", "--json"]).json().error.code, "E_REMOTE_INCOMPATIBLE");
  const { env } = surfaceSetup("bad-home");
  let r = cli(env, ["instance", "git", "dev-a", "--server", "build", "--home", "relative/dev-a", "--json"]);
  assert.equal(r.json().error.code, "E_BAD_ARGS");
  r = cli(env, ["instance", "git", "dev-a", "--server", "build", "--home", homeOf("dev", "twin"), "--json"]);
  assert.equal(r.json().error.code, "E_HOME_MISMATCH");
  r = cli(env, ["instance", "events", "twin", "--server", "build", "--json"]);
  assert.equal(r.json().error.code, "E_AMBIGUOUS");
  r = cli(env, ["instance", "events", "dev-a", "--server", "build", "--home", "/srv/elsewhere/dev-a", "--json"]);
  assert.equal(r.status, 1); assert.deepEqual(r.json().error, { code: "E_HOME_MISMATCH", message: "not a home of dev-a under /srv/ws" }, "the host's refusal, relayed");
  assert.equal(r.stderr, "", "a refusal with an envelope and a silent stderr adds nothing on stderr");
  r = cli(env, ["instance", "input", "dev-a", "--server", "build", "--json"]);
  assert.equal(r.json().error.code, "E_USAGE");
});

test("version --json advertises the new routed surfaces", () => {
  const r = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  const probe = JSON.parse(r.stdout);
  for (const name of ["readiness", "instance-events", "instance-git", "lifecycle-plans"]) assert.ok(probe.remote.includes(name), name);
});

// ---- review round 1 (items 3-5): the Desktop's exact argv, a removed registration, a replayed receipt ----

test("retire --plan and the guarded apply take the Desktop's exact arguments, --dir on the host included", () => {
  const { env, host } = surfaceSetup("desk-retire");
  let r = cli(env, ["retire", "dev-a", "--plan", "--home", HOME_A, "--dir", WS, "--json", "--server", "build"]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(r.json(), ENVELOPES.retirePlan);
  // The relay rebuilds nothing of the plan: the host's fact of what work/ is crosses as a boolean (#988).
  assert.equal(r.json().result.facts.ownWorktree, true);
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath: fakeHost(mkdtempSync(join(base, "desk-apply-")), { probe: SURFACE_PROBE, answers: {
    [`retire dev-a --plan-revision r2 --idempotency-key k2 --discard-worktree --home ${HOME_A} --dir /srv/member --json`]: { stdout: JSON.stringify({ retired: "dev-a", agent: "dev", removedDir: true, planRevision: "r2", idempotencyKey: "k2", replayed: false }) },
  } }).oatsPath } } }));
  r = cli(env, ["retire", "dev-a", "--plan-revision", "r2", "--idempotency-key", "k2", "--discard-worktree", "--home", HOME_A, "--dir", "/srv/member", "--json", "--server", "build"]);
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.json().result.retired, "dev-a");
  // An unguarded routed retire still takes its scope from the registration.
  r = cli(env, ["retire", "dev-a", "--dir", WS, "--json", "--server", "build"]);
  assert.equal(r.json().error.code, "E_BAD_ARGS");
  void host;
});

test("the routed reads and plans follow a saved route after the registration is removed, by name and by home", () => {
  const { env, host } = surfaceSetup("frozen");
  const reg = JSON.parse(readFileSync(join(env.OATS_HOME_DIR, "servers.json"), "utf8")).servers.build;
  mkdirSync(join(env.OATS_HOME_DIR, "remote", "build"), { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "remote", "build", "dev-a.json"), JSON.stringify({ serverId: "build", instance: "dev-a", agent: "dev", home: HOME_A, agentsRoot: `${WS}/agents`, target: { sshHost: "build-host", workspace: WS, oatsPath: reg.oatsPath } }));
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: {} }));
  for (const [, argv, envelope] of SURFACE_CALLS.filter(([, argv]) => !argv.includes("--soul") || argv.includes("--home"))) {
    const r = cli(env, argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.json(), envelope, argv.join(" "));
  }
  assert.equal(host.calls().filter((c) => c.includes("status --json")).length, 0, "a saved route needs no roster read");
});

test("a repeated guarded retire reaches the host's receipt replay after the instance is gone", () => {
  let retired = false;
  const sent = [];
  const receipt = { retired: "dev-a", agent: "dev", removedDir: true, planRevision: "r1", idempotencyKey: "k1", replayed: false };
  const exec = (bin, argv) => {
    const word = String(argv.at(-1));
    sent.push(word);
    if (word.endsWith("version --json")) return JSON.stringify(SURFACE_PROBE);
    if (word.includes(" status --json")) return JSON.stringify(retired ? { root: `${WS}/agents`, agents: [{ name: "dev", instances: [] }] } : ROSTER);
    if (word.includes(" retire dev-a")) { const out = retired ? { ...receipt, replayed: true } : receipt; retired = true; return JSON.stringify(out); }
    throw new Error(`unexpected: ${word}`);
  };
  const server = { id: "build", sshHost: "build-host", workspace: WS, oatsPath: "oats" };
  const args = ["dev-a", "--plan-revision", "r1", "--idempotency-key", "k1"];
  let out = routeCommand("build", "retire", args, { server, execFileSync: exec });
  assert.equal(out.envelope.ok, true); assert.equal(out.envelope.result.replayed, false);
  assert.ok(sent.some((w) => w.includes(`retire dev-a --plan-revision r1 --idempotency-key k1 --home ${HOME_A}`)), sent.join("\n"));
  out = routeCommand("build", "retire", args, { server, execFileSync: exec });
  assert.equal(out.envelope.ok, true, JSON.stringify(out.envelope)); assert.equal(out.envelope.result.replayed, true);
  assert.ok(sent.at(-1).includes("retire dev-a --plan-revision r1 --idempotency-key k1 --dir"), `the key goes to the host, which replays or refuses: ${sent.at(-1)}`);
  // Without a key there is nothing to replay: a name the host does not list is still refused here.
  assert.throws(() => routeCommand("build", "retire", ["dev-a"], { server, execFileSync: exec }), (e) => e.code === "E_SNAPSHOT_UNKNOWN");
});
