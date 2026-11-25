import assert from "node:assert/strict";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { parseLaunchCommand } from "../lib/instance-listing.mjs";
import { parse } from "yaml";

function sshSettings(source) {
  const settings = new Map();
  for (const line of source.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))) {
    const parsed = line.match(/^([A-Za-z][A-Za-z0-9]*)[ \t]+(.+)$/);
    assert.ok(parsed && !parsed[2].trimStart().startsWith("="), "sshd guard requires Keyword value lines: " + line);
    const [, keyword, value] = parsed;
    const key = keyword.toLowerCase();
    assert.ok(key !== "match" && key !== "include", "sshd config must be flat: " + keyword);
    assert.ok(!settings.has(key), "duplicate sshd keyword: " + keyword);
    settings.set(key, value);
  }
  return Object.fromEntries(settings);
}

const read = (name) => readFileSync(new URL(`../container/agent/${name}`, import.meta.url), "utf8");
const readFixtureChild = (name) => readFileSync(new URL(`./fixtures/agent-child/${name}`, import.meta.url), "utf8");

function acceptanceFixture() {
  const env = { AGENT_IMAGE: "oats-agent:reviewed", AGENT_UID: "20001", AGENT_GID: "20001", TEAM_STATE_DIR: "/srv/team/state", TEAM_LOGIN_DIR: "/srv/team/login", AUTHORIZED_KEYS_FILE: "/srv/team/authorized_keys", RESOLV_CONF_FILE: "/srv/team/resolv.conf", AGENT_PIDS: "512", AGENT_TMP_SIZE: "134217728", AGENT_MEMORY: "3g", AGENT_CPUS: "2", AGENTS_NETWORK: "team-agents", AGENT_IP: "172.30.0.2" };
  const image = { Id: "sha256:" + "1".repeat(64), Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/state/home"], Entrypoint: ["/usr/bin/tini", "--", "/usr/local/bin/agent-entrypoint"], Cmd: null } };
  const inspected = {
    Image: image.Id,
    State: { Running: true },
    Config: { Image: env.AGENT_IMAGE, Hostname:"oats-agent", User: "20001:20001", Env: [...image.Config.Env], Entrypoint: [...image.Config.Entrypoint], Cmd: null, StopTimeout: 50,
      Healthcheck: { Test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/2222"], Interval: 30000000000, Timeout: 5000000000, StartPeriod: 10000000000, Retries: 3 } },
    HostConfig: { CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, Privileged: false, PidMode: "", IpcMode: "private", GroupAdd: null, UsernsMode: "", UTSMode: "", CgroupnsMode: "private", Sysctls: null, PortBindings: {}, ExtraHosts: [], Dns: null, NetworkMode: "team-agents", PidsLimit: 512, Memory: 3221225472, NanoCpus: 2000000000, Tmpfs: { "/tmp": "rw,nosuid,nodev,size=134217728,mode=1777" }, Binds: [], Mounts: [], Devices: [], DeviceRequests: null, RestartPolicy: { Name: "unless-stopped" } },
    NetworkSettings: { Networks: { "team-agents": { IPAddress: "172.30.0.2" } } },
    Mounts: [
      { Source: "/srv/team/state", Destination: "/state", Type: "bind", RW: true },
      { Source: "/srv/team/login", Destination: "/etc/agent-login", Type: "bind", RW: false },
      { Source: "/srv/team/authorized_keys", Destination: "/etc/agent-ssh/authorized_keys", Type: "bind", RW: false },
      { Source: "/srv/team/resolv.conf", Destination: "/etc/resolv.conf", Type: "bind", RW: false },
    ],
  };
  inspected.HostConfig.Mounts = inspected.Mounts.map((m) => ({ Type: "bind", Source: m.Source, Target: m.Destination, ReadOnly: !m.RW, BindOptions: {} }));
  Object.assign(inspected.HostConfig, { Runtime: "runc", MemorySwap: 6442450944, OomKillDisable: false, DeviceCgroupRules: null, ShmSize: 67108864 });
  return { env, image, inspected };
}

function loginFixture() {
  const dir = { uid: 0, gid: 20001, mode: 0o750, isDirectory: () => true };
  const token = { uid: 0, gid: 20001, mode: 0o440, isFile: () => true };
  const fs = {
    constants: { R_OK: 4, W_OK: 2 },
    statSync(path) { assert.equal(path, "/etc/agent-login"); return dir; },
    lstatSync(path) { assert.equal(path, "/etc/agent-login/claude-token"); return token; },
    accessSync(path, mode) {
      assert.equal(path, "/etc/agent-login/claude-token");
      if (mode === 2) throw Object.assign(new Error("read-only fixture"), { code: "EACCES" });
      assert.equal(mode, 4);
    },
    readFileSync() { assert.fail("acceptance must not read the token contents"); },
  };
  return { dir, token, fs };
}

test("empty optional acceptance inputs behave exactly as absent inputs", async () => {
  const { inspectAgent } = await import("../container/agent/accept.mjs");
  const { env, image, inspected } = acceptanceFixture();
  delete env.AGENT_UID;
  delete env.AGENT_GID;
  const optional = ["AGENT_UID", "AGENT_GID", "AGENT_CHILD", "TEAM_WORK_DIR", "TEAM_INPUT_DIR", "AGENT_CA_FILE", "AGENT_MIRRORS_DIR", "TEAM_OUTBOX_DIR", "TEAM_OUTBOX_GID"];
  const baseline = inspectAgent(inspected, env, image);
  for (const name of optional) assert.deepEqual(inspectAgent(inspected, { ...env, [name]: "" }, image), baseline, name);
  assert.deepEqual(inspectAgent(inspected, { ...env, ...Object.fromEntries(optional.map(name => [name, ""])) }, image), baseline);
  const compose = parse(read("compose.agent.yaml")).services.agent;
  assert.equal(compose.user, "${AGENT_UID:-20001}:${AGENT_GID:-20001}", "Compose also defaults empty IDs");
});

async function checkToken(fs, strict = true) {
  const { tokenCheck } = await import("../container/agent/accept.mjs");
  assert.equal(typeof tokenCheck, "function", "a separate optional-token probe is required");
  // Probes run as standalone Node programs inside Docker; mock only filesystem access.
  const result = runInNewContext(`(${tokenCheck.toString()})("20001", ${strict})`, {
    require(name) {
      if (name === "node:fs") return fs;
      assert.equal(name, "node:assert/strict");
      return assert;
    },
  });
  return JSON.parse(JSON.stringify(result));
}

test("acceptance reports an absent setup-token without reading or creating it", async () => {
  const { fs } = loginFixture();
  fs.lstatSync = () => { throw Object.assign(new Error("absent fixture"), { code: "ENOENT" }); };
  const result = await checkToken(fs);
  assert.equal(result.present, false);
  assert.deepEqual(result.evidence, ["PASS login directory: uid=0 gid=20001 mode=750", "NOT RUN: setup-token file absent"]);
});

test("an absent token does not bypass the login directory assertions", async () => {
  for (const [key, value] of [["uid", 20001], ["gid", 0], ["mode", 0o770], ["isDirectory", () => false]]) {
    const { fs, dir } = loginFixture();
    fs.lstatSync = () => { throw Object.assign(new Error("absent fixture"), { code: "ENOENT" }); };
    dir[key] = value;
    await assert.rejects(checkToken(fs));
  }
});

test("a present setup-token retains metadata and access checks without reading contents", async () => {
  const fixture = loginFixture();
  const result = await checkToken(fixture.fs);
  assert.equal(result.present, true);
  assert.match(result.evidence[1], /^PASS setup-token file: readable, not writable; uid=0 gid=20001 mode=440; contents not read$/);
  for (const [key, value] of [["uid", 20001], ["gid", 0], ["mode", 0o640], ["isFile", () => false]]) {
    const { fs, token } = loginFixture();
    token[key] = value;
    await assert.rejects(checkToken(fs));
  }
  for (const accessSync of [() => {}, () => { throw new Error("unreadable fixture"); }]) {
    await assert.rejects(checkToken({ ...fixture.fs, accessSync }));
  }
});

test("local token checks accept projected fixture ownership and modes", async () => {
  const { fs, dir, token } = loginFixture();
  Object.assign(dir, { uid: 20001, mode: 0o770 });
  Object.assign(token, { uid: 20001, mode: 0o640 });
  // The read-only bind still denies writes regardless of projected ownership.
  const result = await checkToken(fs, false);
  assert.equal(result.present, true);
  assert.deepEqual(result.evidence, [
    "PASS login directory: uid=20001 gid=20001 mode=770",
    "PASS setup-token file: readable, not writable; uid=20001 gid=20001 mode=640; contents not read",
  ]);
});

test("local token checks still require a login directory", async () => {
  const { fs, dir } = loginFixture();
  dir.isDirectory = () => false;
  await assert.rejects(checkToken(fs, false), /login mount must be a directory/);
});

test("only ENOENT makes a setup-token optional", async () => {
  const { fs } = loginFixture();
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
    const error = Object.assign(new Error("filesystem fixture"), { code });
    await assert.rejects(checkToken({ ...fs, lstatSync() { throw error; } }), (actual) => actual === error);
  }
});

test("agent image pins its base and CLI dependency closure", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  const aptArgs = [...dockerfile.replace(/\\\n/g, " ").matchAll(/\bapt-get\s+install\s+([^&;\n]+)/g)].flatMap((match) => match[1].trim().split(/\s+/));
  assert.deepEqual(aptArgs.filter((arg) => !arg.startsWith("-")).sort(), ["tmux", "git", "openssh-server", "ca-certificates", "tini", "libnss-wrapper"].sort(), "only reviewed apt packages may be installed");
  assert.deepEqual(aptArgs.filter((arg) => arg.startsWith("-")).sort(), ["-y", "--no-install-recommends"].sort());
  assert.match(dockerfile, /npm ci --ignore-scripts/);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\* \/var\/cache\/apt/);
  assert.match(dockerfile, /RUN --network=none npm rebuild @awebai\/aw --ignore-scripts=false/);
  assert.match(dockerfile, /^USER agent$/m);
  assert.equal([...dockerfile.matchAll(/^WORKDIR (.+)$/gm)].at(-1)[1], "/state", "Docker must not create a root-owned child in the state mount before entrypoint");
  assert.match(dockerfile, /^ENV HOME=\/state\/home/m);
  assert.doesNotMatch(dockerfile, /^ENV[\s\S]*LD_PRELOAD/m, "derived-image build steps must retain the system user database");
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/agent-entrypoint"\]$/m);
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@anthropic-ai/claude-code", "@awebai/aw", "@awebai/oats"]);
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.match(pkg.integrity, /^sha512-/);
    assert.match(pkg.resolved, /^https:\/\/registry\.npmjs\.org\//);
  }
});

test("agent Compose service retains the isolation contract", () => {
  const compose = parse(read("compose.agent.yaml"));
  assert.deepEqual(Object.keys(compose.services), ["agent"]);
  const agent = compose.services.agent;
  assert.deepEqual(Object.keys(agent).sort(), ["image", "container_name", "hostname", "user", "environment", "cap_drop", "security_opt", "privileged", "read_only", "tmpfs", "pids_limit", "mem_limit", "cpus", "restart", "stop_grace_period", "healthcheck", "volumes", "networks"].sort(), "only reviewed service keys may be present");
  assert.equal(agent.container_name, "oats-agent-${TEAM:?Set TEAM}");
  assert.equal(agent.user, "${AGENT_UID:-20001}:${AGENT_GID:-20001}");
  assert.deepEqual(agent.cap_drop, ["ALL"]);
  assert.deepEqual(agent.security_opt, ["no-new-privileges:true"]);
  assert.equal(agent.read_only, true);
  assert.equal(agent.privileged, false);
  assert.deepEqual(agent.tmpfs, ["/tmp:rw,nosuid,nodev,size=${AGENT_TMP_SIZE:?Set AGENT_TMP_SIZE},mode=1777"]);
  assert.equal(agent.pids_limit, "${AGENT_PIDS:?Set AGENT_PIDS}");
  assert.equal(agent.mem_limit, "${AGENT_MEMORY:?Set AGENT_MEMORY}");
  assert.equal(agent.cpus, "${AGENT_CPUS:?Set AGENT_CPUS}");
  assert.equal(agent.restart, "unless-stopped");
  assert.equal(agent.stop_grace_period, "50s", "host and broker drains fit within the stop grace");
  assert.deepEqual(agent.healthcheck, { test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/2222"], interval: "30s", timeout: "5s", retries: 3, start_period: "10s" }, "sshd on 2222 is what the healthcheck reads");
  assert.equal(agent.dns, undefined);
  assert.equal(agent.ports, undefined);
  assert.equal(agent.extra_hosts, undefined);
  assert.deepEqual(agent.networks, { agents: { ipv4_address: "${AGENT_IP:?Set AGENT_IP}" } });
  assert.deepEqual(compose.networks, { agents: { external: true, name: "${AGENTS_NETWORK:?Set AGENTS_NETWORK}" } });
  assert.deepEqual(agent.volumes.map(({ source, target, read_only, type, bind }) => ({ source, target, read_only: !!read_only, type, bind })), [
    ["${TEAM_STATE_DIR:?Set TEAM_STATE_DIR}", "/state", false],
    ["${TEAM_LOGIN_DIR:?Set TEAM_LOGIN_DIR}", "/etc/agent-login", true],
    ["${AUTHORIZED_KEYS_FILE:?Set AUTHORIZED_KEYS_FILE}", "/etc/agent-ssh/authorized_keys", true],
    ["${RESOLV_CONF_FILE:?Set RESOLV_CONF_FILE}", "/etc/resolv.conf", true],
  ].map(([source, target, read_only]) => ({ source, target, read_only, type: "bind", bind: { create_host_path: false } })));
  const work = parse(read("compose.agent.work.yaml"));
  assert.deepEqual(Object.keys(work.services), ["agent"]);
  assert.deepEqual(Object.keys(work.services.agent), ["volumes"]);
  assert.deepEqual(work.services.agent.volumes, [{ type: "bind", source: "${TEAM_WORK_DIR:?Set TEAM_WORK_DIR}", target: "/work", bind: { create_host_path: false } }]);
});

test("the entrypoint command structure hands PID-only tini the supervisor after NSS and key setup", () => {
  const checkEntrypoint = source => {
    const commands = source.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => line.split(/\s+/));
    assert.deepEqual(commands.at(-1), ["exec", "node", "/usr/local/lib/agent-supervisor.mjs"]);
    assert.equal(commands.filter(argv => argv[0] === "exec").length, 1);
    assert.ok(commands.every(argv => !argv.some(word => basename(word.replace(/^['"]|['"]$/g, "")) === "sshd")), "the supervisor alone launches sshd");
    assert.ok(commands.some(argv => isDeepStrictEqual(argv, ["export", "NSS_WRAPPER_PASSWD=/state/ssh/passwd"])));
    assert.ok(commands.some(argv => isDeepStrictEqual(argv, ["ssh-keygen", "-q", "-t", "ed25519", "-N", "''", "-f", "/state/ssh/ssh_host_ed25519_key"])));
  };
  const source = read("entrypoint.sh");
  checkEntrypoint(source);
  for (const direct of ["/usr/sbin/sshd -D &", "nohup sshd -D &", "env PATH=/usr/sbin /usr/sbin/sshd -D &"]) {
    assert.throws(() => checkEntrypoint(source.replace("exec node", direct + "\nexec node")), /supervisor alone/, direct);
  }
  const copies = read("Dockerfile").split("\n").map(line => line.trim().split(/\s+/)).filter(words => words[0] === "COPY");
  assert.deepEqual(copies.find(words => words.includes("supervisor.mjs")), ["COPY", "--chmod=644", "supervisor.mjs", "/usr/local/lib/agent-supervisor.mjs"]);
});

test("SSH accepts only agent public keys with forwarding disabled", () => {
  const config = sshSettings(read("sshd_config"));
  for (const [key, value] of Object.entries({ Port: "2222", AllowUsers: "agent", AuthenticationMethods: "publickey", PasswordAuthentication: "no", KbdInteractiveAuthentication: "no", PermitRootLogin: "no", UsePAM: "no", DisableForwarding: "yes", StrictModes: "yes", AuthorizedKeysFile: "/etc/agent-ssh/authorized_keys", HostKey: "/state/ssh/ssh_host_ed25519_key", PidFile: "/tmp/agent-sshd.pid" })) assert.equal(config[key.toLowerCase()], value, key);
});

test("SSH guard refuses repeated keywords or conditional configuration", () => {
  for (const prefix of ["PasswordAuthentication yes", "disableforwarding no", "  Match User agent", "  Include /tmp/unreviewed.conf", "disableforwarding=no", "PasswordAuthentication=yes", "DisableForwarding = no", "Include=/tmp/unreviewed.conf", '"PasswordAuthentication" yes']) assert.throws(() => sshSettings(prefix + "\n" + read("sshd_config")), prefix);
});

test("Claude auth orchestration uses a scratch cwd and only user settings", async t => {
  const report = t.mock.method(console, "log", () => {});
  // Pins orchestration argv at the Docker subprocess boundary. Docker's
  // acceptance of those arguments belongs to team-image CI.
  const { main } = await import("../container/agent/accept.mjs");
  assert.equal(typeof main, "function");
  const { env, image, inspected } = acceptanceFixture();
  const container = "fixture-agent", home = "/state/deploy/fixture/instance";
  const program = ["exec", "-i", container, "node"];
  const expected = [
    [["inspect", container], JSON.stringify([inspected])],
    [["image", "inspect", "--", env.AGENT_IMAGE], JSON.stringify([image])],
    [["info", "--format", "{{.DefaultRuntime}}"], "runc"],
    [["exec", container, "node", "-p", "process.arch"], "x64"],
    [program, "runtime fixture"],
    [program, JSON.stringify("resolver readable and non-empty by runtime UID")],
    [program, JSON.stringify({ present: true, evidence: [] })],
    [program, JSON.stringify("inputs: absent without the optional fragment")],
    [program, JSON.stringify("outbox: absent without the optional fragment")],
    [["exec", "-i", "--user", "0:0", container, "node"], "root scan fixture"],
    [program, "writable scan fixture"],
    [["exec", container, "sh", "-eu", "-c", null], "EACCES /usr/local"],
    [["exec", container, "oats", "version", "--json"], JSON.stringify({ version: "fixture" })],
    [["exec", container, "aw", "version"], "aw fixture"],
    [["exec", container, "claude", "--version"], "claude fixture"],
    [["exec", container, "sh", "-eu", "-c", null, "oats-claude-probe", home], "OATS_CONTAINER_AUTH_OK"],
    [program, "final scan fixture"],
  ];
  const calls = [], unexpected = [];
  const run = (executable, argv) => {
    const row = expected[calls.length];
    calls.push(argv);
    const matches = row && argv.length === row[0].length && row[0].every((value, at) => value === null ? typeof argv[at] === "string" : isDeepStrictEqual(argv[at], value));
    if (executable !== "docker" || !matches) {
      unexpected.push({ executable, argv });
      return { status: 2, stdout: "", stderr: `unexpected ${executable} ${JSON.stringify(argv)}` };
    }
    return { status: 0, stdout: row[1], stderr: "" };
  };
  try { main([container, "--evidence", "local", "--claude", home], env, { spawnSync: run }); }
  finally { assert.deepEqual(unexpected, [], "unexpected Docker argv, including the auth path"); }
  assert.equal(calls.length, expected.length);
  const auth = calls.find(argv => argv.includes("oats-claude-probe"));
  assert.ok(auth, "the orchestration emits one auth probe");
  assert.deepEqual(auth.slice(0, 5), ["exec", container, "sh", "-eu", "-c"]);
  assert.deepEqual(auth.slice(6), ["oats-claude-probe", home]);
  assert.ok(calls.every(argv => !argv.includes("--workdir")), "the instance home is never a Docker workdir");
  const commands = auth[5].trim().split("\n").map(line => line.trim());
  assert.ok(commands.includes('probe=$(mktemp -d /tmp/oats-claude-probe.XXXXXX)'));
  assert.ok(commands.includes('cd "$probe"'));
  const command = commands.find(line => line.startsWith("claude "));
  assert.ok(command, "the auth probe invokes Claude");
  const mktempAt = commands.indexOf('probe=$(mktemp -d /tmp/oats-claude-probe.XXXXXX)');
  const cdAt = commands.indexOf('cd "$probe"');
  assert.ok(mktempAt < cdAt && cdAt < commands.indexOf(command), "create and enter the scratch cwd before invoking Claude");
  const { tokens } = parseLaunchCommand("'claude' " + command.slice("claude ".length));
  assert.deepEqual(tokens.map(token => token.value), ["claude", "-p", "--setting-sources", "user", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "Reply with exactly OATS_CONTAINER_AUTH_OK"]);
  const authReceipt = `[local] PASS claude -p for ${home}: OATS_CONTAINER_AUTH_OK (scratch cwd; user settings only; token read only inside the process)`;
  assert.equal(report.mock.calls.filter(call => call.arguments[0] === authReceipt).length, 1, "capture and assert the simulated report instead of emitting a PASS receipt");
});


test("acceptance refuses drift in the admitted container settings", async t => {
  const { inspectAgent: inspectOnHost } = await import("../container/agent/accept.mjs");
  // This metadata fixture has no host files. Real filesystem aliases are checked below.
  const inspectAgent = (info, env, image, runtime) => inspectOnHost(info, env, image, runtime, source => source);
  const { env, image, inspected } = acceptanceFixture();
  assert.ok(inspectAgent(inspected, env, image).length >= 8);
  for (const tmp of [undefined, "0", "-1", "1g", "1,exec", "9007199254740992"]) {
    assert.throws(() => inspectAgent(inspected, {...env, AGENT_TMP_SIZE:tmp}, image), /AGENT_TMP_SIZE/);
  }
  const wrongTmpSize = structuredClone(inspected);
  wrongTmpSize.HostConfig.Tmpfs["/tmp"] = "rw,nosuid,nodev,size=268435456,mode=1777";
  assert.throws(() => inspectAgent(wrongTmpSize,env,image), /tmpfs/);
  const trusted = structuredClone(inspected);
  const trustEnv = {...env,AGENT_CA_FILE:"/operator/public-ca.pem"};
  trusted.Config.Env.push("SSL_CERT_FILE=/etc/agent-trust/ca.pem","NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem");
  trusted.Mounts.push({Source:trustEnv.AGENT_CA_FILE,Destination:"/etc/agent-trust/ca.pem",RW:false,Type:"bind"});
  trusted.HostConfig.Mounts.push({Type:"bind",Source:trustEnv.AGENT_CA_FILE,Target:"/etc/agent-trust/ca.pem",ReadOnly:true,BindOptions:{}});
  assert.doesNotThrow(()=>inspectAgent(trusted,trustEnv,image),"the approved optional CA is the only trust/environment exception");
  for(const mutate of [
    v=>{v.Config.Env[2]="SSL_CERT_FILE=/state/unreviewed.pem"},
    v=>{v.Config.Env.pop()},
    v=>{v.Config.Env.push("NODE_TLS_REJECT_UNAUTHORIZED=0")},
    v=>{v.Mounts.at(-1).RW=true},
  ]) {const changed=structuredClone(trusted);mutate(changed);assert.throws(()=>inspectAgent(changed,trustEnv,image));}
  assert.throws(()=>inspectAgent(trusted,env,image),"unconfigured trust must not become an environment exception");
  const writableCA=structuredClone(trusted),writableCAPath=env.TEAM_STATE_DIR+"/ca.pem";
  writableCA.Mounts.at(-1).Source=writableCAPath;writableCA.HostConfig.Mounts.at(-1).Source=writableCAPath;
  assert.throws(()=>inspectAgent(writableCA,{...trustEnv,AGENT_CA_FILE:writableCAPath},image),/outside agent-writable sources/);

  const mirrored = structuredClone(inspected), mirrorEnv={...env,AGENT_MIRRORS_DIR:"/operator/mirrors"};
  mirrored.Mounts.push({Source:mirrorEnv.AGENT_MIRRORS_DIR,Destination:"/mirrors",RW:false,Type:"bind"});
  mirrored.HostConfig.Mounts.push({Type:"bind",Source:mirrorEnv.AGENT_MIRRORS_DIR,Target:"/mirrors",ReadOnly:true,BindOptions:{}});
  assert.doesNotThrow(()=>inspectAgent(mirrored,mirrorEnv,image));
  const writableMirrors=structuredClone(mirrored);writableMirrors.Mounts.at(-1).RW=true;
  assert.throws(()=>inspectAgent(writableMirrors,mirrorEnv,image));
  const nestedMirrors=structuredClone(mirrored),nestedSource=env.TEAM_STATE_DIR+"/mirrors";
  nestedMirrors.Mounts.at(-1).Source=nestedSource;nestedMirrors.HostConfig.Mounts.at(-1).Source=nestedSource;
  assert.throws(()=>inspectAgent(nestedMirrors,{...mirrorEnv,AGENT_MIRRORS_DIR:nestedSource},image),/outside agent-writable sources/);
  const inputs = structuredClone(inspected), inputEnv = {...env, TEAM_INPUT_DIR: "/operator/inputs"};
  inputs.Mounts.push({Source: inputEnv.TEAM_INPUT_DIR, Destination: "/inputs", RW: false, Type: "bind"});
  inputs.HostConfig.Mounts.push({Type: "bind", Source: inputEnv.TEAM_INPUT_DIR, Target: "/inputs", ReadOnly: true, BindOptions: {}});
  assert.doesNotThrow(() => inspectAgent(inputs, inputEnv, image));
  assert.throws(() => inspectAgent(inputs, env, image), "base must reject an undeclared input mount");
  assert.throws(() => inspectAgent(inspected, inputEnv, image), "declared inputs must be mounted");
  for (const mutate of [
    v => { v.Mounts.at(-1).RW = true; },
    v => { v.HostConfig.Mounts.at(-1).ReadOnly = false; },
    v => { v.HostConfig.Mounts.at(-1).BindOptions.CreateMountpoint = true; },
    v => { v.Mounts.push({Source: "/operator/output", Destination: "/output", RW: true, Type: "bind"}); },
    v => { v.Config.Env.push("PUBLISHER_TOKEN=VALUE_MUST_BE_WITHHELD"); },
  ]) {
    const changed = structuredClone(inputs); mutate(changed);
    assert.throws(() => inspectAgent(changed, inputEnv, image), error => !error.message.includes("VALUE_MUST_BE_WITHHELD"));
  }
  for (const source of ["relative/inputs", env.TEAM_STATE_DIR + "/inputs", "/srv/team"]) {
    const changed = structuredClone(inputs);
    changed.Mounts.at(-1).Source = source; changed.HostConfig.Mounts.at(-1).Source = source;
    assert.throws(() => inspectAgent(changed, {...inputEnv, TEAM_INPUT_DIR: source}, image));
  }
  const outbox = structuredClone(inputs), outboxEnv = {...inputEnv, TEAM_OUTBOX_DIR: "/operator/outbox", TEAM_OUTBOX_GID: "20002"};
  outbox.Mounts.push({Source: outboxEnv.TEAM_OUTBOX_DIR, Destination: "/outbox", RW: true, Type: "bind"});
  outbox.HostConfig.Mounts.push({Type: "bind", Source: outboxEnv.TEAM_OUTBOX_DIR, Target: "/outbox", ReadOnly: false, BindOptions: {}});
  outbox.HostConfig.GroupAdd = [outboxEnv.TEAM_OUTBOX_GID];
  assert.doesNotThrow(() => inspectAgent(outbox, outboxEnv, image));
  assert.throws(() => inspectAgent(outbox, inputEnv, image));
  for (const group of [undefined, "0", "root", "-1", "20001", "1.5", "4294967295"]) {
    assert.throws(() => inspectAgent(outbox, {...outboxEnv, TEAM_OUTBOX_GID: group}, image));
  }
  for (const group of [[], ["20003"], ["20002", "20003"]]) {
    const changed = structuredClone(outbox); changed.HostConfig.GroupAdd = group;
    assert.throws(() => inspectAgent(changed, outboxEnv, image));
  }
  for (const source of ["relative/outbox", env.TEAM_STATE_DIR, env.TEAM_STATE_DIR + "/outbox", "/srv/team", inputEnv.TEAM_INPUT_DIR, env.TEAM_LOGIN_DIR, env.AUTHORIZED_KEYS_FILE]) {
    const changed = structuredClone(outbox);
    changed.Mounts.at(-1).Source = source; changed.HostConfig.Mounts.at(-1).Source = source;
    assert.throws(() => inspectAgent(changed, {...outboxEnv, TEAM_OUTBOX_DIR: source}, image));
  }
  const outboxAlone = structuredClone(outbox), outboxOnlyEnv = {...outboxEnv};
  delete outboxOnlyEnv.TEAM_INPUT_DIR;
  outboxAlone.Mounts = outboxAlone.Mounts.filter(m => m.Destination !== "/inputs");
  outboxAlone.HostConfig.Mounts = outboxAlone.HostConfig.Mounts.filter(m => m.Target !== "/inputs");
  assert.doesNotThrow(() => inspectAgent(outboxAlone, outboxOnlyEnv, image));
  for (const mutate of [
    v => {v.Mounts.at(-1).RW = false;},
    v => {v.HostConfig.Mounts.at(-1).ReadOnly = true;},
    v => {v.HostConfig.Mounts.at(-1).BindOptions.CreateMountpoint = true;},
  ]) {const changed = structuredClone(outbox); mutate(changed); assert.throws(() => inspectAgent(changed, outboxEnv, image));}
  const withoutCmd = structuredClone(image);
  delete withoutCmd.Config.Cmd;
  assert.ok(inspectAgent(inspected, env, withoutCmd).length >= 8, "Docker image metadata omits Cmd while container metadata uses null");
  const defaultSwap = structuredClone(inspected);
  delete defaultSwap.HostConfig.MemorySwap;
  assert.ok(inspectAgent(defaultSwap, env, image).length >= 8, "absent swap setting uses Docker's memory-derived default");
  const otherDaemon = structuredClone(inspected);
  otherDaemon.HostConfig.Runtime = "runsc";
  assert.ok(inspectAgent(otherDaemon, env, image, "runsc").length >= 8, "runtime must match the independently read daemon default");
  for (const mutate of [
    (v) => { v.Config.Hostname = "ephemeral-container-id"; },
    (v) => { v.Config.User = "0"; },
    (v) => { v.Config.User = "20001"; },
    (v) => { v.HostConfig.CapAdd = ["SYS_ADMIN"]; },
    (v) => { v.HostConfig.SecurityOpt = ["seccomp=unconfined", "no-new-privileges:true"]; },
    (v) => { v.HostConfig.ReadonlyRootfs = false; },
    (v) => { v.HostConfig.Privileged = true; },
    (v) => { v.HostConfig.PidMode = "host"; },
    (v) => { v.HostConfig.Memory = 0; },
    (v) => { v.Mounts[1].RW = true; },
    (v) => { v.Mounts[0].Source = "/home/operator"; },
    (v) => { v.Mounts.push({ Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true, Type: "bind" }); },
    (v) => { v.HostConfig.Tmpfs["/tmp"] = "rw"; },
    (v) => { v.HostConfig.Mounts[0].BindOptions.CreateMountpoint = true; },
    (v) => { v.HostConfig.GroupAdd = ["10001"]; },
    (v) => { v.HostConfig.UsernsMode = "host"; },
    (v) => { v.HostConfig.UTSMode = "host"; },
    (v) => { v.HostConfig.CgroupnsMode = "host"; },
    (v) => { v.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" }; },
    (v) => { v.HostConfig.PortBindings = { "2222/tcp": [{ HostPort: "2222" }] }; },
    (v) => { v.HostConfig.ExtraHosts = ["outside:1.1.1.1"]; },
    (v) => { v.HostConfig.Dns = ["1.1.1.1"]; },
    (v) => { v.HostConfig.NetworkMode = "host"; },
    (v) => { v.NetworkSettings.Networks.extra = { IPAddress: "172.18.0.2" }; },
    (v) => { v.NetworkSettings.Networks["team-agents"].IPAddress = "172.30.0.3"; },
    (v) => { v.Config.Env.push("CLAUDE_CODE_OAUTH_TOKEN=FIXTURE_VALUE_NEVER_REPORT"); },
    (v) => { v.Image = "sha256:" + "2".repeat(64); },
    (v) => { v.Config.Image = "someone/else:latest"; },
    (v) => { v.Config.Env[0] = "PATH=/state/bin:/usr/local/bin:/usr/bin:/bin"; },
    (v) => { v.Config.Env[1] = "HOME=/tmp"; },
    (v) => { v.Config.Env.pop(); },
    (v) => { v.Config.Env.push("HOME=/tmp"); },
    (v) => { v.Config.Entrypoint = ["/bin/sh", "-c", "sleep infinity"]; },
    (v) => { v.Config.Cmd = ["sh"]; },
    (v) => { v.HostConfig.Runtime = "other"; },
    (v) => { v.HostConfig.MemorySwap = -1; },
    (v) => { v.HostConfig.OomKillDisable = true; },
    (v) => { v.HostConfig.DeviceCgroupRules = ["c *:* rmw"]; },
    (v) => { v.HostConfig.ShmSize = 8589934592; },
    (v) => { delete v.Config.StopTimeout; },
    (v) => { v.Config.StopTimeout = 10; },
    (v) => { v.Config.StopTimeout = 45; },
    (v) => { delete v.Config.Healthcheck; },
    (v) => { v.Config.Healthcheck.Test = ["NONE"]; },
    (v) => { v.Config.Healthcheck.Test = ["CMD", "true"]; },
    (v) => { v.Config.Healthcheck.Retries = 30; },
  ]) {
    const changed = structuredClone(inspected);
    mutate(changed);
    assert.throws(() => inspectAgent(changed, env, image));
  }
  for (const field of ["Env", "Entrypoint", "Cmd"]) {
    const changed = structuredClone(inspected);
    changed.Config[field] = field === "Env" ? ["PATH=VALUE_MUST_BE_WITHHELD"] : ["VALUE_MUST_BE_WITHHELD"];
    assert.throws(() => inspectAgent(changed, env, image), (error) => !error.message.includes("VALUE_MUST_BE_WITHHELD"), field + " differences must withhold values");
  }
  await t.test("public input symlinks into state or work are refused on the Docker host", t => {
    const root = mkdtempSync(join(tmpdir(), "oats-agent-public-sources-"));
    t.after(() => rmSync(root, {recursive:true, force:true}));
    for (const name of ["state", "work", "operator"]) mkdirSync(join(root,name));
    const realEnv = {...env, TEAM_STATE_DIR:join(root,"state"), TEAM_WORK_DIR:join(root,"work")};
    for (const [name, target] of [["AGENT_CA_FILE","/etc/agent-trust/ca.pem"], ["AGENT_MIRRORS_DIR","/mirrors"], ["TEAM_INPUT_DIR","/inputs"]]) {
      for (const location of ["state", "work", "operator"]) {
        const source = join(root,location,name);
        if (name === "AGENT_CA_FILE") writeFileSync(source, "public CA fixture");
        else mkdirSync(source);
        const alias = join(root, `${location}-${name}`);
        symlinkSync(source, alias);
        const settings = {...realEnv,[name]:alias};
        const info = structuredClone(name === "AGENT_CA_FILE" ? trusted : name === "TEAM_INPUT_DIR" ? inputs : mirrored);
        info.Mounts = info.Mounts.filter(mount => mount.Destination !== target);
        info.Mounts.find(mount => mount.Destination === "/state").Source = settings.TEAM_STATE_DIR;
        info.Mounts.push({Source:settings.TEAM_WORK_DIR, Destination:"/work", RW:true, Type:"bind"},
          {Source:alias, Destination:target, RW:false, Type:"bind"});
        info.HostConfig.Mounts = info.Mounts.map(mount => ({Source:mount.Source, Target:mount.Destination, ReadOnly:!mount.RW, Type:"bind", BindOptions:{}}));
        if (location === "operator") {
          assert.doesNotThrow(() => inspectOnHost(info,settings,image), "external operator sources may be symlinks");
          assert.throws(() => inspectOnHost(info,settings,image,undefined,() => { throw new Error("VALUE_MUST_BE_WITHHELD"); }),
            error => /resolvable Docker-host sources/.test(error.message) && !error.message.includes("VALUE_MUST_BE_WITHHELD"));
          // Resolve writable roots too, even when Docker preserves their aliases.
          const writableAlias = join(root, `writable-${name}`);
          symlinkSync(join(root,"operator"), writableAlias);
          settings.TEAM_WORK_DIR = writableAlias;
          info.Mounts.find(mount => mount.Destination === "/work").Source = writableAlias;
          info.HostConfig.Mounts.find(mount => mount.Target === "/work").Source = writableAlias;
        }
        assert.throws(() => inspectOnHost(info,settings,image), /outside agent-writable sources/);
      }
    }
  });
  await t.test("outbox source aliases cannot expose state, work or read-only mounts", t => {
    const root = mkdtempSync(join(tmpdir(), "oats-outbox-alias-"));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const settings = {...outboxOnlyEnv}, info = structuredClone(outboxAlone);
    for (const mount of info.Mounts) {
      mount.Source = join(root, mount.Destination.replaceAll("/", "-")); mkdirSync(mount.Source);
      const name = {"/state": "TEAM_STATE_DIR", "/outbox": "TEAM_OUTBOX_DIR", "/etc/agent-login": "TEAM_LOGIN_DIR",
        "/etc/agent-ssh/authorized_keys": "AUTHORIZED_KEYS_FILE", "/etc/resolv.conf": "RESOLV_CONF_FILE"}[mount.Destination];
      settings[name] = mount.Source;
    }
    const alias = join(root, "queue-alias");
    symlinkSync(join(root, "-state"), alias);
    settings.TEAM_OUTBOX_DIR = alias;
    info.Mounts.find(m => m.Destination === "/outbox").Source = alias;
    info.HostConfig.Mounts = info.Mounts.map(m => ({Type: "bind", Source: m.Source, Target: m.Destination, ReadOnly: !m.RW, BindOptions: {}}));
    assert.throws(() => inspectOnHost(info, settings, image), /outside agent-writable sources/);
  });
  await t.test("main executes input and outbox probes through the Docker boundary", async t => {
    const {main} = await import("../container/agent/accept.mjs");
    const root = mkdtempSync(join(tmpdir(), "oats-mount-main-"));
    t.after(() => rmSync(root, {recursive: true, force: true}));
    const lines = [];
    t.mock.method(console, "log", line => lines.push(line));
    for (const enabled of [false, true]) {
      const settings = {...env};
      const info = structuredClone(enabled ? outbox : inspected);
      if (enabled) Object.assign(settings, outboxEnv);
      for (const mount of info.Mounts) {
        const name = {"/state": "TEAM_STATE_DIR", "/inputs": "TEAM_INPUT_DIR", "/outbox": "TEAM_OUTBOX_DIR",
          "/etc/agent-login": "TEAM_LOGIN_DIR", "/etc/agent-ssh/authorized_keys": "AUTHORIZED_KEYS_FILE", "/etc/resolv.conf": "RESOLV_CONF_FILE"}[mount.Destination];
        settings[name] = join(root, name);
        mkdirSync(settings[name], {recursive: true});
        mount.Source = settings[name];
      }
      info.HostConfig.Mounts = info.Mounts.map(m => ({Type: "bind", Source: m.Source, Target: m.Destination, ReadOnly: !m.RW, BindOptions: {}}));
      let inputsRan = false, outboxRan = false, removed = false, rootScanRan = false, agentScanRan = false;
      const fs = {
        lstatSync: () => { throw Object.assign(new Error("absent"), {code: "ENOENT"}); },
        statSync(path) {
          if (path === "/state") return {mode: 0o40700, isDirectory: () => true};
          return {uid: 20001, gid: 20002, mode: 0o42750, isDirectory: () => true};
        },
        readdirSync: () => [],
        writeFileSync(path) { if (path.startsWith("/inputs/")) throw Object.assign(new Error("read-only"), {code: "EROFS"}); },
        unlinkSync() { removed = true; },
      };
      const run = (tool, argv, options) => {
        assert.equal(tool, "docker");
        const ok = stdout => ({status: 0, stdout, stderr: ""});
        if (argv[0] === "inspect") return ok(JSON.stringify([info]));
        if (argv[0] === "image") return ok(JSON.stringify([image]));
        if (argv[0] === "info") return ok("runc");
        if (argv.includes("process.arch")) return ok("x64");
        const source = options.input || "";
        if (source.includes("function runtimeCheck")) {
          // Execute the real serialized runtime check with filesystem and TCP boundaries.
          let output = "";
          const groups = enabled ? "20001 20002" : "20001";
          const runtimeFS = {...fs, statSync: () => ({mode: 0o40700, uid: 20001}), readFileSync(path) {
            if (path === "/tmp/agent-sshd.pid") return "42";
            if (path.endsWith("cmdline")) return "sshd";
            return `Uid: 20001 20001 20001 20001\nGid: 20001 20001 20001 20001\nGroups: ${groups}\nCapEff: 0000\nNoNewPrivs: 1\n`;
          }};
          const socket = {setTimeout() {}, destroy() {}, once(event, callback) { if (event === "data") callback("SSH-2.0-OpenSSH_fixture"); }};
          const execute = statusFS => runInNewContext(source, {process: {getuid: () => 20001, getgid: () => 20001}, console: {log: line => { output += line + "\n"; }},
            require: name => name === "node:fs" ? statusFS : name === "node:assert/strict" ? assert : {connect: () => socket}});
          execute(runtimeFS);
          assert.throws(() => execute({...runtimeFS, readFileSync: path => path === "/proc/self/status" ? runtimeFS.readFileSync(path).replace(`Groups: ${groups}`, "Groups: 20001 20003") : runtimeFS.readFileSync(path)}));
          if (enabled) {
            assert.throws(() => execute({...runtimeFS, readFileSync: path => path === "/proc/self/status" ? runtimeFS.readFileSync(path).replace(`Groups: ${groups}`, "Groups: 20001") : runtimeFS.readFileSync(path)}));
            for (const daemonGroups of ["20001", "20001 20002 20003"]) {
              assert.throws(() => execute({...runtimeFS, readFileSync: path => path === "/proc/42/status" ? runtimeFS.readFileSync(path).replace(`Groups: ${groups}`, `Groups: ${daemonGroups}`) : runtimeFS.readFileSync(path)}));
            }
          }
          return ok(output);
        }
        if (source.includes("function resolverCheck")) {
          assert.ok(!argv.includes("--user"), "resolver reads as runtime UID");
          return ok(JSON.stringify("resolver readable and non-empty by runtime UID"));
        }
        if (source.includes("function tokenCheck")) return ok(JSON.stringify({present: false, evidence: []}));
        if (source.includes("function inputsCheck") || source.includes("function outboxCheck")) {
          if (source.includes("function inputsCheck")) inputsRan = true;
          else outboxRan = true;
          let result;
          runInNewContext(source, {process: {pid: 100}, require: () => fs, console: {log: line => { result = line; }}});
          return ok(result);
        }
        if (source.includes("function credentialScan")) {
          const privileged = argv.includes("--user");
          const visited = [];
          const entry = name => ({name, isDirectory: () => true});
          const scanFS = {existsSync: () => true, readdirSync(path) {
            visited.push(path);
            if (path === "/") return [entry("inputs"), entry("outbox"), entry("system")];
            if (privileged && ["/inputs", "/outbox"].some(root => path === root || path.startsWith(root + "/"))) {
              throw Object.assign(new Error("private subtree must not be scanned as root"), {code: "EACCES"});
            }
            if (path === "/inputs" || path === "/outbox") return [entry("agent-private")];
            return [];
          }};
          let output = "";
          runInNewContext(source, {require: name => name === "node:fs" ? scanFS : name === "node:path" ? {join} : assert,
            console: {log: line => { output += line; }}});
          if (privileged) {
            rootScanRan = true;
            assert.ok(visited.includes("/system"));
            assert.ok(!visited.includes("/inputs") && !visited.includes("/outbox"));
          } else {
            agentScanRan = true;
            assert.equal(visited.includes("/inputs/agent-private"), enabled);
            assert.equal(visited.includes("/outbox/agent-private"), enabled);
          }
          return ok(output);
        }
        assert.ok(inputsRan && outboxRan, "both probes must execute before the remaining acceptance checks");
        throw new Error("remaining checks boundary");
      };
      assert.throws(() => main(["fixture-agent", "--evidence", "target-amd64"], settings, {spawnSync: run}), /remaining checks boundary/);
      assert.equal(inputsRan, true); assert.equal(outboxRan, true);
      assert.equal(removed, enabled);
      assert.equal(rootScanRan, true); assert.equal(agentScanRan, true);
    }
    assert.ok(lines.some(line => line.includes("inputs: absent")));
    assert.ok(lines.some(line => line.includes("outbox: absent")));
    assert.ok(lines.some(line => line.includes("inputs: readable read-only")));
    assert.ok(lines.some(line => line.includes("outbox: setgid queue writable")));
  });

});


async function supervisorFixture(t, { ready = true, statusTrueAfterBrokerExit = false, statusSpawnFailsOnce = false, statusSpawnThrowsOnce = false, statusIgnoresTerm = false, stubbornFinish = false, brokerStatusPid = "owned", pauseAfterStarted = "", brokerDrainMs = 0, productionStopBudgets = false,
  // The declared child. `child`: the value of AGENT_CHILD (absent: unset). `agentBb`: the value of
  // the removed switch. `declaration`: false for an image without one, a string for the file's
  // raw text, or a function that changes the good declaration in place. A real fixture child serves the ready URL.
  child, agentBb, declaration, declarationMode = 0o644, declarationOwner = "root", declarationIs = "file",
  commandIs = "file", rootFiles = [], loginFiles = {}, loginReadErrors = {}, inherited = {}, childMode = "ready", externalStatus = false,
  // The first request to the ready URL, at the network boundary: "emfile" fails it before it
  // connects; "pending" neither connects nor fails, as an attempt that gets no answer at all.
  preflight,
  restartBackoffMs = 20, restartBackoffMaxMs = 80, restartStableMs, hostDrainMs = 80 } = {}) {
  const supervisor = new URL("../container/agent/supervisor.mjs", import.meta.url);
  assert.ok(existsSync(supervisor), "the image must own broker readiness and ordered child shutdown");
  const { supervise } = await import(supervisor);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oats-image-supervisor-")));
  const events = join(dir, "events"), childFile = join(dir, "child.cjs"), brokerPid = join(dir, "broker-pid"), childSeen = join(dir, "child-seen.json");
  writeFileSync(events, "");
  // A free loopback port stands for the declared one; nothing listens there until the child does.
  const childPort = await new Promise((resolve, reject) => {
    const probe = createTcpServer().once("error", reject).listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  // A private directory stands for the image's root: the supervisor's file
  // boundary reads real files, links and modes below it. This process's own
  // uid stands for root, the owner an image build gives its files.
  const root = join(dir, "root"), inRoot = path => join(root, path);
  for (const path of ["etc/agent-login", "opt/agent-child", "state", "work", "tmp", "run", "outbox", "dev/shm", "usr/bin"]) mkdirSync(inRoot(path), { recursive: true });
  const good = {
    name: "extra", command: ["/opt/agent-child/serve", "--flag", "two words", ""], env: { CHILD_SETTING: "declared", CHILD_EMPTY: "" },
    envFromFile: { CHILD_TOKEN: "/etc/agent-login/child-token", CHILD_OTHER: "/etc/agent-login/other-token" },
    ready: { url: `http://127.0.0.1:${childPort}/status`, field: "up" }, listen: [childPort, childPort === 65535 ? 65534 : childPort + 1],
    version: { command: ["/opt/agent-child/serve", "--version"], file: "/opt/agent-child/version" }, stopMs: 1000,
  };
  const declared = structuredClone(good);
  if (typeof declaration === "function") declaration(declared);
  const declarationPath = "/etc/agent-child.json";
  if (declaration !== false) {
    const text = typeof declaration === "string" ? declaration : JSON.stringify(declared);
    if (declarationIs === "symlink") {
      writeFileSync(inRoot("etc/agent-child.real.json"), text, { mode: declarationMode });
      symlinkSync("agent-child.real.json", inRoot(declarationPath));
    } else if (declarationIs === "directory") mkdirSync(inRoot(declarationPath));
    else { writeFileSync(inRoot(declarationPath), text); chmodSync(inRoot(declarationPath), declarationMode); }
  }
  if (commandIs === "file") writeFileSync(inRoot("opt/agent-child/serve"), "");
  else if (commandIs === "chain") {
    // The declared path reaches an image file by way of a link an agent can re-point.
    writeFileSync(inRoot("usr/bin/real-serve"), "");
    symlinkSync(inRoot("usr/bin/real-serve"), inRoot("state/hop"));
    symlinkSync(inRoot("state/hop"), inRoot("opt/agent-child/serve"));
  } else if (commandIs !== "absent") {
    // The declared path is a link to somewhere an agent can write.
    writeFileSync(inRoot(`${commandIs}/planted`), "");
    symlinkSync(inRoot(`${commandIs}/planted`), inRoot("opt/agent-child/serve"));
  }
  for (const path of rootFiles) { mkdirSync(join(inRoot(path), ".."), { recursive: true }); writeFileSync(inRoot(path), ""); }
  for (const [name, content] of Object.entries(loginFiles)) {
    if (content === null) mkdirSync(inRoot(`etc/agent-login/${name}`));
    else writeFileSync(inRoot(`etc/agent-login/${name}`), content);
  }
  const fileCalls = [];
  const fs = {
    constants,
    openSync(path, flags) { fileCalls.push(["open", path]); return openSync(inRoot(path), flags); },
    fstatSync(fd) {
      const stat = fstatSync(fd);
      if (declarationOwner === "root" && stat.uid === process.getuid()) stat.uid = 0;
      else if (declarationOwner !== "root" && stat.uid === 0) stat.uid = 20001;
      return stat;
    },
    readFileSync(target, encoding) {
      if (typeof target !== "string") return readFileSync(target, encoding);
      fileCalls.push(["read", target]);
      if (loginReadErrors[target]) throw Object.assign(new Error("fixture read failure"), { code: loginReadErrors[target] });
      return readFileSync(inRoot(target), encoding);
    },
    closeSync,
    realpathSync(path) {
      fileCalls.push(["realpath", path]);
      const real = realpathSync(inRoot(path));
      assert.ok(real.startsWith(root + "/"), "the fixture's links stay inside its root");
      return real.slice(root.length);
    },
  };
  // Another process answering on the declared port: it also counts every probe made.
  let statusHits = 0, external;
  if (externalStatus) {
    // true: ready at once. "later": not ready when first asked, ready from then on. "error": 503 first. "text": not JSON first.
    // "mute": accepts the first request and never answers it, ready from then on.
    external = createHttpServer((_request, response) => {
      statusHits += 1;
      if (externalStatus === "mute" && statusHits === 1) return;
      if (externalStatus === "error" && statusHits === 1) response.statusCode = 503;
      response.end(externalStatus === "text" && statusHits === 1 ? "starting" : JSON.stringify({ up: externalStatus === true || statusHits > 1 }));
    });
    await new Promise((resolve, reject) => external.once("error", reject).listen(childPort, "127.0.0.1", resolve));
  }
  writeFileSync(childFile, `
    const fs = require("node:fs");
    const [role, events, mode, pidFile, pidMode, pausedRole, brokerDrainMs, childPort, childSeen, hostDrainMs] = process.argv.slice(2);
    if (role === "child") {
      // What the real child process received, read by the tests.
      fs.writeFileSync(childSeen, JSON.stringify({ env: process.env }));
      if (mode === "leaves-server") {
        // A launcher whose own child holds the port and outlives a killed launcher.
        if (process.argv[12] !== "server") {
          const server = require("node:child_process").spawn(process.execPath, [...process.argv.slice(1), "server"], { stdio: "ignore" });
          fs.appendFileSync(events, "child server pid " + server.pid + "\\n");
          fs.appendFileSync(events, "child started\\n");
          setInterval(() => {}, 1000);
          return;
        }
      }
      if (mode === "exits") { fs.appendFileSync(events, "child started\\nchild exited\\n"); process.exit(0); }
      // Alive, and never on the declared port.
      if (mode === "idle") { fs.appendFileSync(events, "child started\\n"); setInterval(() => {}, 1000); return; }
      const answers = {
        ready: { hostId: "host_fixture", up: true }, never: { up: false }, truthy: { up: "true" }, nested: { status: { up: true } },
        "not-json": "up: true", array: [true], missing: { ready: true },
      };
      const began = Date.now();
      require("node:http").createServer((request, response) => {
        if (mode === "straddle") {
          // Not ready for 0.7 s. A request after that is answered "ready" 0.6 s later: asked
          // for inside the fixture's 1 s budget, answered past it.
          if (Date.now() - began < 700) response.end(JSON.stringify({ up: false }));
          else setTimeout(() => response.end(JSON.stringify({ up: true })), 600);
          return;
        }
        if (mode === "not-200") response.statusCode = 503;
        const answer = request.url === "/status" ? answers[mode] ?? answers.ready : { up: false };
        response.end(typeof answer === "string" ? answer : JSON.stringify(answer));
      }).listen(Number(childPort), "127.0.0.1", () => fs.appendFileSync(events, "child serving\\n"));
    }
    const log = text => fs.appendFileSync(events, text + "\\n");
    // Keep TERM pending until SIGCONT, so it uses the disposition at "started".
    // Tests await the real supervisor signal before resuming this child.
    const started = () => {
      log(role + " started");
      if (role === pausedRole) process.kill(process.pid, "SIGSTOP");
    };
    if (role === "broker") fs.writeFileSync(pidFile, String(process.pid));
    if (role === "status" && mode === "probe-stubborn") {
      process.on("SIGTERM", () => log("status TERM"));
      started();
      log("status listening");
      setInterval(() => {}, 1000);
    } else if (role === "status") {
      started();
      const running = ((mode === "ready" || mode === "stubborn") && fs.readFileSync(events, "utf8").includes("broker started")) || (mode === "after-exit" && fs.readFileSync(events, "utf8").includes("broker exited"));
      if (running) log("broker ready");
      const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile,"utf8")) : 0;
      const identity = pidMode === "missing" ? {} : {daemon_pid: pidMode === "other" ? process.ppid : pid};
      process.stdout.write(JSON.stringify({daemon_running: running, ...identity}));
      process.exit(0);
    }
    if (role !== "status") {
      process.on("SIGTERM", () => {
        log(role + " TERM");
        if (mode === "stubborn" && (role === "ssh" || role === "broker")) return;
        if (role === "child" && mode === "stubborn-child") return;
        setTimeout(() => { log(role + " ended"); process.exit(0); }, role === "host" ? Number(hostDrainMs) : role === "broker" ? Number(brokerDrainMs) : 0);
      });
      // Publish the long-lived child's stop handshake only after TERM can drain it.
      started();
      if (role === "broker" && mode === "after-exit") { log("broker exited"); process.exit(0); }
      log(role + " listening");
      setInterval(() => {}, 1000);
    }
  `);
  const children = new Map(), said = [], saidAt = [], spawned = [];
  let signal, statusFailed = false;
  const env = { ...process.env, ...inherited };
  delete env.AGENT_BB;
  delete env.AGENT_CHILD;
  if (agentBb !== undefined) env.AGENT_BB = agentBb;
  if (child !== undefined) env.AGENT_CHILD = child;
  // The clock the readiness budget is read from: its first reading sets the deadline. Each request
  // is recorded with the reading the supervisor last took before it made the request.
  const clock = [], requests = [];
  let pendingDestroyed = 0;
  const running = supervise({
    now() { clock.push(Date.now()); return clock.at(-1); },
    httpGet(url, options, answered) {
      requests.push({ lastClock: clock.at(-1) });
      if (requests.length > 1 || !preflight) return httpGet(url, options, answered);
      if (preflight === "pending") return Object.assign(new EventEmitter(), { destroy() { pendingDestroyed += 1; } });
      const request = httpGet(url, options, answered);
      request.destroy(Object.assign(new Error("fixture: no descriptor left"), { code: "EMFILE" }));
      return request;
    },
    env, fs, restartBackoffMs, restartBackoffMaxMs, ...(restartStableMs === undefined ? {} : {restartStableMs}),
    spawnChild(file, args, options) {
      const role = options.argv0 === declared.command[0] ? "child" : file === "aw" ? (args[1] === "run" ? "broker" : "status") : file === "oats" ? "host" : "ssh";
      spawned.push({role, file, args, options, at: Date.now()});
      const mode = role === "child" ? childMode : role === "status" && statusIgnoresTerm ? "probe-stubborn" : statusTrueAfterBrokerExit ? "after-exit" : stubbornFinish ? "stubborn" : ready ? "ready" : "not-ready";
      appendFileSync(events, role + " spawned\n");
      if (role === "status" && statusSpawnThrowsOnce && !statusFailed) {
        statusFailed = true;
        throw Object.assign(new Error("fixture status spawn failed"), {code: "ENOMEM"});
      }
      const failProbe = role === "status" && statusSpawnFailsOnce && !statusFailed;
      if (failProbe) statusFailed = true;
      const process_ = spawn(failProbe ? join(dir, "missing-probe") : process.execPath, failProbe ? [] : [childFile, role, events, mode, brokerPid, brokerStatusPid, pauseAfterStarted, String(brokerDrainMs), String(childPort), childSeen, String(hostDrainMs)], { ...options, stdio: role === "status" ? ["ignore", "pipe", "ignore"] : "ignore" });
      if (pauseAfterStarted) {
        const kill = process_.kill.bind(process_);
        process_.kill = signal => {
          const sent = kill(signal);
          if (sent) appendFileSync(events, role + " signal " + signal + "\n");
          return sent;
        };
      }
      children.set(role, process_);
      return process_;
    },
    onSignal(handler) { signal = handler; return () => { signal = null; }; },
    say(line) { said.push(line); saidAt.push(Date.now()); appendFileSync(events, "supervisor " + line + "\n"); }, pollMs: 10, startupMs: 1000,
    ...(productionStopBudgets ? {} : {sshdStopMs: 500, brokerStopMs: 500}),
  });
  t.after(async () => {
    for (const process_ of children.values()) process_.kill("SIGKILL");
    await running.catch(() => {});
    if (external) { external.closeAllConnections(); await new Promise(resolve => external.close(resolve)); }
    rmSync(dir, { recursive: true, force: true });
  });
  const text = () => readFileSync(events, "utf8");
  async function until(check) {
    for (let tries = 0; tries < 200; tries += 1) { if (check()) return; await delay(10); }
    assert.fail("supervisor fixture did not reach its checkpoint: " + text() + said.join(";"));
  }
  const childReceived = () => JSON.parse(readFileSync(childSeen, "utf8"));
  // Requests made once the budget was spent, by the supervisor's own clock (the first is the pre-start one, before any reading).
  const requestsAfterBudget = () => requests.filter(({ lastClock }) => lastClock !== undefined && lastClock >= clock[0] + 1000).length;
  return { running, children, said, timeOf: line => saidAt[said.indexOf(line)], requestsAfterBudget, requestCount: () => requests.length, pendingDestroyed: () => pendingDestroyed, text, until, term: () => signal("SIGTERM"), spawned, fileCalls, childReceived, statusHits: () => statusHits, declared, childPort };
}

test("broker TERM at its started checkpoint drains the real fixture child", async t => {
  const fx = await supervisorFixture(t, { ready: false, pauseAfterStarted: "broker" });
  await fx.until(() => fx.text().includes("broker started") && fx.text().includes("status started"));
  fx.term();
  await fx.until(() => fx.text().includes("broker signal SIGTERM"));
  fx.children.get("broker").kill("SIGCONT");
  assert.equal(await fx.running, 0);
  assert.match(fx.text(), /broker TERM[\s\S]*broker ended/);
  assert.doesNotMatch(fx.text(), /(?:ssh|host) started/);
});

test("host TERM after a retried probe drains the real fixture child", async t => {
  const fx = await supervisorFixture(t, { statusSpawnFailsOnce: true, pauseAfterStarted: "host" });
  await fx.until(() => fx.text().includes("host started"));
  assert.ok(fx.said.includes("status could not start"));
  fx.term();
  await fx.until(() => fx.text().includes("host signal SIGTERM"));
  fx.children.get("host").kill("SIGCONT");
  assert.equal(await fx.running, 0, fx.text());
  assert.match(fx.text(), /host TERM[\s\S]*host ended/);
});

test("image supervisor admits SSH and host run only after its broker is ready", async (t) => {
  const fx = await supervisorFixture(t);
  await fx.until(() => fx.text().includes("host started"));
  const events = fx.text().split("\n");
  assert.ok(events.indexOf("broker started") < events.indexOf("broker ready"));
  assert.ok(events.indexOf("broker ready") < events.indexOf("ssh spawned"));
  assert.ok(events.indexOf("ssh spawned") < events.indexOf("host spawned"));
  fx.term();
  assert.equal(await fx.running, 0);
  const stopped = fx.text().split("\n");
  assert.ok(stopped.indexOf("host ended") < stopped.indexOf("broker TERM"), fx.text());
});

test("the production broker grace permits a five-second delivery drain after host run ends", async (t) => {
  const fx = await supervisorFixture(t, {brokerDrainMs: 5000, productionStopBudgets: true});
  await fx.until(() => ["broker", "ssh", "host"].every(role => fx.text().includes(role + " listening")));
  fx.term();
  assert.equal(await fx.running, 0, "a completed broker drain is a clean stop");
  assert.equal(fx.children.get("broker").signalCode, null, "the supervisor must not kill a draining broker");
  assert.equal(fx.children.get("broker").exitCode, 0);
  const events = fx.text().split("\n");
  assert.ok(events.indexOf("host ended") < events.indexOf("broker TERM"), fx.text());
  assert.ok(events.includes("broker ended"), "the five-second drain must finish");
});

test("production cleanup escalates stubborn children within their separate budgets", {timeout: 10000}, async t => {
  const fx = await supervisorFixture(t, {stubbornFinish: true, productionStopBudgets: true});
  await fx.until(() => ["broker", "ssh", "host"].every(role => fx.text().includes(role + " listening")));
  // Observe real child exits, with slack for host drain and scheduler overhead.
  // Deadlines also bound a mutant production default that would otherwise hang.
  const exited = (role, limit) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(role + " exceeded its production cleanup budget")), limit);
    fx.children.get(role).once("exit", (_code, signal) => {
      clearTimeout(timer);
      try { assert.equal(signal, "SIGKILL", role + " must escalate"); resolve(); }
      catch (error) { reject(error); }
    });
  });
  const ssh = exited("ssh", 4500), broker = exited("broker", 7500);
  fx.term();
  await Promise.all([ssh, broker]);
  assert.equal(await fx.running, 1, "escalating stubborn children fails the stop");
});

test("TERM during broker readiness starts neither SSH nor host run", async (t) => {
  const fx = await supervisorFixture(t, { ready: false });
  // A status child can start before the independently scheduled broker.
  await fx.until(() => fx.text().includes("status started") && fx.text().includes("broker started"));
  fx.term();
  assert.equal(await fx.running, 0);
  assert.doesNotMatch(fx.text(), /(?:ssh|host) started/);
  assert.match(fx.text(), /broker ended/);
});

test("a dead broker cannot be made ready by a stale daemon status", async (t) => {
  const fx = await supervisorFixture(t, { statusTrueAfterBrokerExit: true });
  assert.equal(await fx.running, 1);
  assert.doesNotMatch(fx.text(), /(?:ssh|host) started/);
  assert.match(fx.said.join("\n"), /broker.*exited/);
});

test("unexpected broker death drains host run and fails the container", async (t) => {
  const fx = await supervisorFixture(t);
  await fx.until(() => fx.text().includes("host started"));
  fx.children.get("broker").kill("SIGKILL");
  assert.equal(await fx.running, 1);
  assert.match(fx.text(), /host TERM[\s\S]*host ended/);
  assert.match(fx.said.join("\n"), /broker.*exited/);
});


test("sshd death is reported while healthy agents keep running", async (t) => {
  const fx = await supervisorFixture(t);
  await fx.until(() => fx.text().includes("host started"));
  fx.children.get("ssh").kill("SIGKILL");
  await fx.until(() => fx.said.some(line => line.startsWith("sshd exited")));
  assert.doesNotMatch(fx.text(), /host TERM|broker TERM/);
  fx.term();
  assert.equal(await fx.running, 0);
});

test("unexpected host run exit stops the broker and fails the container", async (t) => {
  const fx = await supervisorFixture(t);
  await fx.until(() => fx.text().includes("host started"));
  fx.children.get("host").kill("SIGKILL");
  assert.equal(await fx.running, 1);
  assert.match(fx.text(), /broker TERM[\s\S]*broker ended/);
});


test("a status-probe spawn error is retried before broker readiness expires", async (t) => {
  const fx = await supervisorFixture(t, {statusSpawnFailsOnce:true});
  await fx.until(() => fx.text().includes("host started"));
  assert.ok(fx.said.includes("status could not start"), "the real failed spawn was observed");
  assert.ok(fx.said.includes("broker ready (daemon_running: true)"));
  assert.equal(fx.text().split("status spawned").length-1 >= 2,true,"readiness was retried");
  fx.term();
  assert.equal(await fx.running,0,"transient status failure does not fail the container");
});


test("broker death while host run drains is a failed container stop", async (t) => {
  const fx = await supervisorFixture(t);
  await fx.until(() => fx.text().includes("host started"));
  fx.term();
  await fx.until(() => fx.text().includes("host TERM"));
  assert.doesNotMatch(fx.text(), /host ended/, "the host must still be draining when delivery dies");
  fx.children.get("broker").kill("SIGKILL");
  assert.equal(await fx.running, 1, "delivery lost before host drain completes cannot be a clean stop");
  assert.match(fx.text(), /host ended/);
});


test("SSH and broker final cleanup share one grace span after host run ends", async (t) => {
  const fx = await supervisorFixture(t, {stubbornFinish:true});
  await fx.until(() => fx.text().includes("ssh listening") && fx.text().includes("host listening"));
  fx.term();
  assert.equal(await fx.running,1,"forced cleanup is reported as a failed stop");
  const events=fx.text().split("\n");
  assert.ok(events.indexOf("host ended") < events.indexOf("broker TERM"),fx.text());
  assert.ok(events.indexOf("broker TERM") < events.indexOf("supervisor sshd exited (SIGKILL)"),"broker must be asked to stop before SSH consumes its entire grace: "+fx.text());
  assert.ok(events.includes("supervisor broker exited (SIGKILL)"));
});


test("a status without our live broker PID cannot admit agents", async (t) => {
  for (const brokerStatusPid of ["other", "missing"]) {
    const fx = await supervisorFixture(t, {brokerStatusPid});
    await fx.until(() => fx.text().split("status spawned").length-1 >= 3);
    assert.doesNotMatch(fx.text(), /(?:ssh|host) spawned/, brokerStatusPid);
    fx.term();
    assert.equal(await fx.running,0);
  }
});


test("a synchronous ENOMEM status-probe spawn is retried before readiness expires", async (t) => {
  const fx = await supervisorFixture(t, {statusSpawnThrowsOnce:true});
  await fx.until(() => fx.text().includes("host started"));
  assert.ok(fx.said.includes("status could not start"), "the synchronous spawn failure was observed");
  assert.ok(fx.text().split("status spawned").length-1 >= 2, "readiness was retried");
  fx.term();
  assert.equal(await fx.running,0,"a transient synchronous status failure does not fail the container");
});


test("TERM kills a read-only status probe without failing the shortened stop grace", async (t) => {
  for (const statusSpawnThrowsOnce of [false, true]) {
    const fx = await supervisorFixture(t, {statusIgnoresTerm:true, statusSpawnThrowsOnce});
    await fx.until(() => fx.text().includes("status listening") && fx.text().includes("broker listening"));
    const probe = fx.children.get("status");
    fx.term();
    assert.equal(await fx.running,0,"forced read-only probe cleanup is a clean startup stop");
    assert.equal(probe.signalCode,"SIGKILL","the probe is killed and awaited");
    assert.doesNotMatch(fx.text(), /(?:ssh|host) spawned/);
    assert.match(fx.text(), /broker TERM[\s\S]*broker ended/);
  }
});


test("every Dockerfile COPY source is admitted by the closed build context", () => {
  const rules = read(".dockerignore").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  assert.equal(rules.shift(), "**", "image context starts closed");
  const admitted = new Set(rules.map(rule => {
    assert.match(rule, /^![A-Za-z0-9][A-Za-z0-9._-]*$/, "build context permits only named root files");
    return rule.slice(1);
  }));
  const required = new Set(["Dockerfile"]);
  for (const [, instruction] of read("Dockerfile").matchAll(/^COPY\s+(.+)$/gm)) {
    const tokens = instruction.trim().split(/\s+/);
    if (tokens.some(token => token.startsWith("--from="))) continue;
    const files = tokens.filter(token => !token.startsWith("--")).slice(0,-1);
    assert.ok(files.length, "COPY must name source inputs");
    for (const file of files) {
      assert.match(file, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, "COPY context sources are explicit root files");
      required.add(file);
      assert.ok(admitted.has(file), `COPY source ${file} is excluded from the image context`);
    }
  }
  assert.deepEqual([...admitted].sort(), [...required].sort(), "do not admit unrelated files into the image");
});

test("container image and Compose declare broker session delivery", () => {
  const agent=parse(read("compose.agent.yaml")).services.agent;
  assert.deepEqual(agent.environment,{AWEB_DELIVERY:"session"});
  assert.match(read("Dockerfile"),/^ENV AWEB_DELIVERY=session$/m);
});

test("the runtime account keeps a bash login shell at any UID", () => {
  assert.match(read("Dockerfile"),/--shell \/bin\/bash agent/);
  assert.ok(read("entrypoint.sh").includes("/state/home:/bin/bash\\n"));
});

test("Compose keeps the cache-lock hostname stable across recreation", () => {
  assert.equal(parse(read("compose.agent.yaml")).services.agent.hostname,"oats-agent");
});

test("supervisor liveness stays healthy when SSH is gone", async t => {
  const url=new URL("../container/agent/liveness.mjs",import.meta.url);
  assert.ok(existsSync(url),"Kubernetes liveness must observe the supervisor independently of SSH");
  const {supervisorAlive}=await import(url);
  const {mkdirSync,symlinkSync}=await import("node:fs");
  const procRoot=mkdtempSync(join(tmpdir(),"oats-agent-proc-"));
  t.after(()=>rmSync(procRoot,{recursive:true,force:true}));
  for(const pid of ["8","38"])mkdirSync(join(procRoot,pid));
  writeFileSync(join(procRoot,"8","cmdline"),"node\0/usr/local/lib/agent-supervisor.mjs\0");
  symlinkSync(process.execPath,join(procRoot,"8","exe"));
  writeFileSync(join(procRoot,"38","cmdline"),"/usr/sbin/sshd\0-D\0");
  assert.equal(supervisorAlive({procRoot}),true);
  rmSync(join(procRoot,"38"),{recursive:true});
  assert.equal(supervisorAlive({procRoot}),true,"losing SSH affects readiness, not team liveness");
  writeFileSync(join(procRoot,"8","cmdline"),"node\0-e\0contains /usr/local/lib/agent-supervisor.mjs\0");
  assert.equal(supervisorAlive({procRoot}),false,"a probe's own argument text is not the supervisor");
  writeFileSync(join(procRoot,"8","cmdline"),"");
  assert.equal(supervisorAlive({procRoot}),false,"an exited/zombie supervisor is not live");
});


test("optional public CA fragment has one fixed mount and two named trust settings", () => {
  const path=new URL("../container/agent/compose.agent.trust.yaml",import.meta.url);
  assert.ok(existsSync(path),"the supported optional trust fragment is required");
  assert.deepEqual(parse(readFileSync(path,"utf8")),{services:{agent:{
    environment:{SSL_CERT_FILE:"/etc/agent-trust/ca.pem",NODE_EXTRA_CA_CERTS:"/etc/agent-trust/ca.pem"},
    volumes:[{type:"bind",source:"${AGENT_CA_FILE:?Set AGENT_CA_FILE}",target:"/etc/agent-trust/ca.pem",read_only:true,bind:{create_host_path:false}}],
  }}});
});

test("login and SSH trust use one immutable conditional profile", () => {
  const profile = read("agent-trust.sh");
  assert.match(profile, /^if \[ -r \/etc\/agent-trust\/ca\.pem \]; then\n/m);
  assert.deepEqual([...profile.matchAll(/^\s*export (.+)$/gm)].map(match => match[1]).sort(), [
    "NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem", "SSL_CERT_FILE=/etc/agent-trust/ca.pem",
  ]);
  assert.match(read("Dockerfile"), /^COPY --chmod=644 agent-trust\.sh \/etc\/profile\.d\/agent-trust\.sh$/m);
  assert.match(read("Dockerfile"), /^RUN sed -i '1i \. \/etc\/profile\.d\/agent-trust\.sh' \/etc\/bash\.bashrc$/m);
  assert.doesNotMatch(read("Dockerfile"), /^ENV .*\b(?:SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|BASH_ENV)\b/m);
  const config = sshSettings(read("sshd_config"));
  assert.equal(config.setenv, "HOME=/state/home PATH=/usr/local/bin:/usr/bin:/bin LD_PRELOAD=/usr/local/lib/libnss_wrapper.so NSS_WRAPPER_PASSWD=/state/ssh/passwd NSS_WRAPPER_GROUP=/state/ssh/group BASH_ENV=/etc/profile.d/agent-trust.sh");
  assert.equal(config.permituserenvironment, "no");
  assert.equal(config.permituserrc, "no");
  assert.equal(config.acceptenv, undefined);
});

test("public CA acceptance rejects private keys, malformed files and writable trust", async () => {
  const {publicCACheck}=await import("../container/agent/accept.mjs");
  assert.equal(typeof publicCACheck,"function","a real mounted-CA check is required");
  const crypto=await import("node:crypto"),tls=await import("node:tls");
  const pem=tls.rootCertificates[0];
  const fs={constants:{W_OK:2},statSync:()=>({isFile:()=>true,size:pem.length}),readFileSync:()=>pem,
    accessSync:()=>{throw Object.assign(new Error("read-only fixture"),{code:"EROFS"})}};
  const run=system=>runInNewContext(`(${publicCACheck.toString()})()`,{require:name=>name==="node:fs"?system:name==="node:crypto"?crypto:assert});
  assert.equal(run(fs),"public CA: valid read-only CA certificates; contents withheld");
  for(const contents of ["",pem+"\n-----BEGIN PRIVATE KEY-----\nPRIVATE_VALUE_MUST_BE_WITHHELD\n-----END PRIVATE KEY-----\n","-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----"]){
    assert.throws(()=>run({...fs,readFileSync:()=>contents}),error=>/public CA/.test(error.message)&&!error.message.includes("PRIVATE_VALUE_MUST_BE_WITHHELD"));
  }
  assert.throws(()=>run({...fs,accessSync:()=>{}}),/public CA/);
  assert.throws(()=>run({...fs,statSync:()=>({isFile:()=>true,size:65537})}),/public CA/);
});

test("public CA acceptance rejects a real hardlink despite a read-only mount", async t => {
  const {publicCACheck} = await import("../container/agent/accept.mjs");
  const crypto = await import("node:crypto");
  const {rootCertificates} = await import("node:tls");
  const root = mkdtempSync(join(tmpdir(), "oats-agent-ca-links-"));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const source = join(root,"public-ca.pem");
  writeFileSync(source,rootCertificates[0]);
  const system = {
    constants:{W_OK:2}, statSync:() => statSync(source), readFileSync:() => readFileSync(source,"utf8"),
    accessSync:() => { throw Object.assign(new Error("read-only bind fixture"),{code:"EROFS"}); },
  };
  assert.equal(publicCACheck(system,crypto), "public CA: valid read-only CA certificates; contents withheld");
  linkSync(source,join(root,"writable-alias.pem"));
  assert.throws(() => publicCACheck(system,crypto), /public CA.*contents withheld/);
});


test("optional mirrors fragment has only the operator-controlled read-only mount", () => {
  const path=new URL("../container/agent/compose.agent.mirrors.yaml",import.meta.url);
  assert.ok(existsSync(path),"the supported optional mirrors fragment is required");
  assert.deepEqual(parse(readFileSync(path,"utf8")),{services:{agent:{volumes:[{
    type:"bind",source:"${AGENT_MIRRORS_DIR:?Set AGENT_MIRRORS_DIR}",target:"/mirrors",read_only:true,bind:{create_host_path:false},
  }]}}});
});

test("mirror acceptance requires readable directories and refuses writable mirrors", async () => {
  const {mirrorsCheck}=await import("../container/agent/accept.mjs");
  assert.equal(typeof mirrorsCheck,"function","a read-only mirror check is required");
  const fs={statSync:()=>({isDirectory:()=>true}),readdirSync:()=>["github.com"],
    writeFileSync:()=>{throw Object.assign(new Error("read-only fixture"),{code:"EROFS"})},unlinkSync:()=>assert.fail("no file was written")};
  const run=system=>runInNewContext(`(${mirrorsCheck.toString()})()`,{process:{pid:100},require:()=>system});
  assert.equal(run(fs),"mirrors: readable read-only directory; source freshness is operator-qualified");
  let removed=false;
  assert.throws(()=>run({...fs,writeFileSync:()=>{},unlinkSync:()=>{removed=true}}),/mirrors/);
  assert.equal(removed,true,"an unexpected write is removed before reporting failure");
  assert.throws(()=>run({...fs,statSync:()=>({isDirectory:()=>false})}),/mirrors/);
  assert.throws(()=>run({...fs,readdirSync:()=>{throw new Error("unreadable")}}),/mirrors/);
});


test("optional inputs fragment adds only one pre-provisioned read-only directory", () => {
  const path = new URL("../container/agent/compose.agent.inputs.yaml", import.meta.url);
  assert.ok(existsSync(path), "the supported optional inputs fragment is required");
  assert.deepEqual(parse(readFileSync(path, "utf8")), {services: {agent: {volumes: [{
    type: "bind", source: "${TEAM_INPUT_DIR:?Set TEAM_INPUT_DIR}", target: "/inputs", read_only: true, bind: {create_host_path: false},
  }]}}});
});

test("input acceptance checks readable directories, failed writes and absence without the fragment", async () => {
  const {inputsCheck} = await import("../container/agent/accept.mjs");
  assert.equal(typeof inputsCheck, "function", "a serialized input directory probe is required");
  const fault = code => Object.assign(new Error("PRIVATE_INPUT_CONTENTS"), {code});
  const fs = {
    statSync(path) { assert.equal(path, "/inputs"); return {isDirectory: () => true}; },
    readdirSync(path) { assert.equal(path, "/inputs"); return ["PRIVATE_INPUT_CONTENTS"]; },
    writeFileSync(path, data, options) {
      assert.match(path, /^\/inputs\/\.oats-read-only-probe-/);
      assert.equal(options.flag, "wx");
      throw fault("EROFS");
    },
    unlinkSync: () => assert.fail("no probe was written"),
    lstatSync: () => { throw fault("ENOENT"); },
  };
  const run = (system, enabled = true) => runInNewContext(`(${inputsCheck.toString()})(${enabled})`, {
    process: {pid: 100}, require: () => system,
  });
  assert.equal(run(fs), "inputs: readable read-only directory; contents withheld");
  assert.equal(run(fs, false), "inputs: absent without the optional fragment");
  for (const system of [
    {...fs, statSync: () => { throw fault("ENOENT"); }},
    {...fs, statSync: () => ({isDirectory: () => false})},
    {...fs, readdirSync: () => { throw fault("EACCES"); }},
    {...fs, writeFileSync: () => { throw fault("EIO"); }},
  ]) assert.throws(() => run(system), error => /inputs/.test(error.message) && !error.message.includes("PRIVATE_INPUT_CONTENTS"));
  assert.equal(run({...fs, writeFileSync: () => { throw fault("EACCES"); }}), "inputs: readable read-only directory; contents withheld");
  let removed = false;
  assert.throws(() => run({...fs, writeFileSync: () => {}, unlinkSync: () => { removed = true; }}), /inputs/);
  assert.equal(removed, true, "unexpected probe writes are removed before failure");
  for (const lstatSync of [() => ({}), () => { throw fault("EACCES"); }]) {
    assert.throws(() => run({...fs, lstatSync}, false), /inputs/);
  }
});


test("optional outbox fragment adds only the queue and its dedicated numeric group", () => {
  const path = new URL("../container/agent/compose.agent.outbox.yaml", import.meta.url);
  assert.ok(existsSync(path), "the optional outbox fragment is required");
  assert.deepEqual(parse(readFileSync(path, "utf8")), {services: {agent: {
    group_add: ["${TEAM_OUTBOX_GID:?Set TEAM_OUTBOX_GID}"],
    volumes: [{type: "bind", source: "${TEAM_OUTBOX_DIR:?Set TEAM_OUTBOX_DIR}", target: "/outbox", bind: {create_host_path: false}}],
  }}});
  assert.match(read("entrypoint.sh"), /^umask 077$/m);
});

test("outbox acceptance checks setgid ownership, write inheritance, private state and absence", async () => {
  const {outboxCheck} = await import("../container/agent/accept.mjs");
  assert.equal(typeof outboxCheck, "function");
  const denied = code => Object.assign(new Error("PRIVATE_OUTBOX_CONTENTS"), {code});
  let written = false, removed = false;
  const system = {
    statSync(path) {
      if (path === "/state") return {mode: 0o40700, isDirectory: () => true};
      if (path === "/outbox") return {uid: 20001, gid: 20002, mode: 0o42750, isDirectory: () => true};
      assert.ok(written); return {gid: 20002};
    },
    lstatSync: () => { throw denied("ENOENT"); },
    writeFileSync(path, data, options) { assert.match(path, /^\/outbox\/\.oats-write-probe-/); assert.equal(options.flag, "wx"); assert.equal(options.mode, 0o600); written = true; },
    unlinkSync() { removed = true; },
  };
  const run = (fs = system, enabled = true) => runInNewContext(`(${outboxCheck.toString()})(${enabled}, "20001", "20002")`, {
    process: {pid: 100}, require(name) { return name === "node:fs" ? fs : assert; },
  });
  assert.equal(run(), "outbox: setgid queue writable with group 20002; state remains private");
  assert.equal(removed, true);
  assert.equal(run(system, false), "outbox: absent without the optional fragment");
  for (const mutate of [
    stat => ({...stat, gid: 20003}), stat => ({...stat, uid: 0}), stat => ({...stat, mode: 0o40750}), stat => ({...stat, isDirectory: () => false}),
  ]) assert.throws(() => run({...system, statSync: path => path === "/outbox" ? mutate(system.statSync(path)) : system.statSync(path)}), /outbox/);
  removed = false;
  assert.throws(() => run({...system, statSync: path => path.startsWith("/outbox/.") ? {gid: 20003} : system.statSync(path)}), /outbox/);
  assert.equal(removed, true, "failed inheritance checks clean up their own probe");
  assert.throws(() => run({...system, statSync: path => path === "/state" ? {mode: 0o40750, isDirectory: () => true} : system.statSync(path)}), /outbox/);
  assert.throws(() => run({...system, writeFileSync: () => { throw denied("EACCES"); }}), error => /outbox/.test(error.message) && !error.message.includes("PRIVATE_OUTBOX_CONTENTS"));
  for (const lstatSync of [() => ({}), () => { throw denied("EACCES"); }]) assert.throws(() => run({...system, lstatSync}, false), /outbox/);
});


const roles = fx => fx.spawned.map(entry => entry.role).filter(role => role !== "status");
const declarationFile = "/etc/agent-child.json";
const refusedBeforeAnyChild = async (fx, line, why) => {
  assert.equal(await fx.running, 1, why);
  assert.deepEqual(fx.spawned, [], "no child starts: " + why);
  assert.deepEqual(fx.said, [line], why);
};

test("without AGENT_CHILD the supervisor starts exactly the broker, sshd and host run, and reads no declaration", async t => {
  // Whatever the image holds: a good declaration, a broken one, files under the login mount, a live port.
  for (const child of [undefined, ""]) for (const declaration of [undefined, "{ not JSON", false]) {
    const fx = await supervisorFixture(t, {child, declaration, loginFiles: {"child-token": "FIXTURE_TOKEN_NEVER_READ"}, externalStatus: true});
    await fx.until(() => fx.text().includes("host started"));
    fx.term();
    assert.equal(await fx.running, 0);
    assert.deepEqual(roles(fx), ["broker", "ssh", "host"], "the children before the optional child existed, in their order");
    assert.deepEqual(fx.spawned.filter(entry => entry.role !== "status").map(({file, args}) => [file, args]), [
      ["aw", ["wake", "run"]], ["/usr/sbin/sshd", ["-D", "-e", "-f", "/etc/agent-sshd_config"]], ["oats", ["host", "run"]],
    ]);
    for (const {options} of fx.spawned) assert.deepEqual(Object.keys(options), ["stdio"], "no child gets an environment or a process group of its own");
    assert.equal(fx.statusHits(), 0, "no HTTP probe is made");
    assert.deepEqual(fx.fileCalls, [], "no file is opened, read or resolved");
    assert.deepEqual(fx.said.filter(line => !/^(?:broker|sshd|host run) /.test(line)), [], "no line about a child");
  }
});

test("AGENT_CHILD on an image with no declaration refuses before any child starts", async t => {
  const fx = await supervisorFixture(t, {child: "extra", declaration: false, loginFiles: {"child-token": "FIXTURE_TOKEN_NEVER_READ"}});
  await refusedBeforeAnyChild(fx, "AGENT_CHILD needs an image that declares a child in /etc/agent-child.json", "the base image");
  assert.deepEqual(fx.fileCalls, [["open", declarationFile]], "nothing else is read");
});

test("a declaration that is a symlink, not root-owned, group- or other-writable, oversized or not JSON refuses before any child starts", async t => {
  const shape = "/etc/agent-child.json must be a regular file owned by root, not a symlink and not writable by its group or by others";
  for (const [why, options, line] of [
    ["a symlink to a good file", {declarationIs: "symlink"}, shape],
    ["a directory", {declarationIs: "directory"}, shape],
    ["not root-owned", {declarationOwner: "agent"}, shape],
    ["group-writable", {declarationMode: 0o664}, shape],
    ["other-writable", {declarationMode: 0o646}, shape],
    ["oversized", {declaration: d => { d.env.PADDING = "x".repeat(16 * 1024); }}, "/etc/agent-child.json must be at most 16 KiB"],
    ["not JSON", {declaration: "{ FIXTURE_VALUE_NEVER_SHOWN"}, "/etc/agent-child.json: the declaration must be JSON"],
    ["empty", {declaration: ""}, "/etc/agent-child.json: the declaration must be JSON"],
    ["JSON, not an object", {declaration: '["FIXTURE_VALUE_NEVER_SHOWN"]'}, "/etc/agent-child.json: the declaration must be an object"],
    ["JSON null", {declaration: "null"}, "/etc/agent-child.json: the declaration must be an object"],
  ]) {
    const fx = await supervisorFixture(t, {child: "extra", loginFiles: {"child-token": "FIXTURE_TOKEN_NEVER_READ"}, ...options});
    await refusedBeforeAnyChild(fx, line, why);
    assert.ok(fx.fileCalls.every(([, path]) => path === declarationFile), why + ": nothing under the login mount is read");
  }
  // An unreadable file is refused by its code: the supervisor runs as the agent, not as the file's owner.
  if (process.getuid() !== 0) {
    const unreadable = await supervisorFixture(t, {child: "extra", declarationMode: 0o000});
    await refusedBeforeAnyChild(unreadable, "/etc/agent-child.json could not be read (EACCES)", "unreadable");
  }
  // The largest file that is still read, and a read-only file.
  for (const options of [{declarationMode: 0o444}, {declaration: d => { d.env.PADDING = "x".repeat(15 * 1024); }}]) {
    const fx = await supervisorFixture(t, {child: "extra", ...options});
    await fx.until(() => fx.text().includes("host started"));
    fx.term();
    assert.equal(await fx.running, 0);
  }
  const { childDeclarationFile, childDeclarationMaxBytes } = await import("../container/agent/supervisor.mjs");
  assert.deepEqual([childDeclarationFile, childDeclarationMaxBytes], [declarationFile, 16384]);
});

test("every unknown key, missing key and out-of-grammar value of the declaration refuses, naming the key", async t => {
  const secret = "FIXTURE_VALUE_NEVER_SHOWN";
  const cases = [
    // Unknown keys, at each level. A key's own name is repeated only when it is a plain word.
    [d => { d.restart = "always"; }, "the declaration has the unknown key restart"],
    [d => { d[`x ${secret}`] = 1; }, "the declaration has an unknown key (name withheld)"],
    [d => { d.ready.timeoutMs = 5; }, "ready has the unknown key timeoutMs"],
    [d => { d.version.pin = secret; }, "version has the unknown key pin"],
    // Every required key, one at a time. envFromFile alone is optional (below).
    ...["name", "command", "env", "ready", "listen", "version", "stopMs"].map(key => [d => { delete d[key]; }, `${key} is missing`]),
    [d => { delete d.ready.url; }, "ready.url is missing"],
    [d => { delete d.ready.field; }, "ready.field is missing"],
    [d => { delete d.version.command; }, "version.command is missing"],
    [d => { delete d.version.file; }, "version.file is missing"],
    // name
    ...["", "Extra", "two words", "a".repeat(21), "extra_child", 7, null, [secret]].map(name => [d => { d.name = name; }, "name must be 1 to 20 lowercase letters, digits or dashes"]),
    // The base's own role names are reserved: the child's lines must not read as the base's.
    ...["broker", "sshd", "host-run", "status", "supervisor"].map(name => [d => { d.name = name; }, "name must not be broker, sshd, host-run, status or supervisor"]),
    // command
    ...[[], secret, {0: "/bin/true"}, ["/opt/agent-child/serve", 7], ["/opt/agent-child/serve", "a\0b"], null].map(command => [d => { d.command = command; }, "command must be a non-empty array of strings"]),
    ...[["serve"], ["./serve"], [""], [`${secret}/serve`]].map(command => [d => { d.command = command; }, "command[0] must be an absolute path"]),
    // env
    ...[null, [], secret, 7].map(env => [d => { d.env = env; }, "env must be an object"]),
    ...["lower", "1ST", "WITH-DASH", "", `X ${secret}`].map(name => [d => { d.env = {[name]: "v"}; }, "env has a name that is not [A-Z_][A-Z0-9_]*"]),
    ...[7, null, ["v"], "a\0b"].map(value => [d => { d.env = {CHILD_SETTING: value}; }, "env must give CHILD_SETTING a string"]),
    ...["PATH", "HOME", "LD_PRELOAD", "NSS_WRAPPER_PASSWD", "NSS_WRAPPER_GROUP", "NODE_OPTIONS", "AGENT_CHILD"].flatMap(name => [
      [d => { d.env = {[name]: secret}; }, `env must not set ${name}`],
      [d => { d.envFromFile = {[name]: "/etc/agent-login/child-token"}; }, `envFromFile must not set ${name}`],
    ]),
    // envFromFile
    ...[null, [], secret].map(value => [d => { d.envFromFile = value; }, "envFromFile must be an object"]),
    [d => { d.envFromFile = {lower: "/etc/agent-login/child-token"}; }, "envFromFile has a name that is not [A-Z_][A-Z0-9_]*"],
    [d => { d.envFromFile = {CHILD_SETTING: "/etc/agent-login/child-token"}; }, "envFromFile names CHILD_SETTING, which env sets too"],
    ...["/etc/agent-login/", "/etc/agent-login", "/etc/agent-login/sub/token", "/etc/agent-login/..", "/etc/agent-login/.", "/etc/agent-login/../shadow", "/state/home/token", "etc/agent-login/token", `/etc/agent-loginx/${secret}`, "/etc/agent-login/a\0b", 7, null]
      .map(path => [d => { d.envFromFile = {CHILD_TOKEN: path}; }, "envFromFile must give CHILD_TOKEN a file directly under /etc/agent-login/"]),
    // listen
    ...[[], null, 39000, ["39000"], [1023], [65536], [0], [-1], [39000.5], [39000, null]].map(listen => [d => { d.listen = listen; }, "listen must be a non-empty array of ports from 1024 to 65535"]),
    [d => { d.listen.push(2222); }, "listen must not include 2222, sshd's port"],
    [d => { d.listen.push(d.listen[0]); }, "listen must not repeat a port"],
    // ready
    ...[null, [], secret].map(ready => [d => { d.ready = ready; }, "ready must be an object"]),
    ...[() => "http://127.0.0.1:1024/status", d => `https://127.0.0.1:${d.listen[0]}/status`, d => `http://localhost:${d.listen[0]}/status`,
      d => `http://0.0.0.0:${d.listen[0]}/status`, d => `http://127.0.0.2:${d.listen[0]}/status`, d => `http://[::1]:${d.listen[0]}/status`, d => `http://127.0.0.1:${d.listen[0]}`,
      d => `http://127.0.0.1.example.com:${d.listen[0]}/status`, d => `http://user@127.0.0.1:${d.listen[0]}/status`, d => `http://127.0.0.1:${d.listen[0]}/a b`,
      d => `http://127.0.0.1:${d.listen[0]}/#${secret}`, d => `http://127.0.0.1:0${d.listen[0]}/status`, () => "http://127.0.0.1/status", () => 7, () => null,
    ].map(url => [d => { d.ready.url = url(d); }, "ready.url must be http://127.0.0.1:<a listen port>/<path>"]),
    ...["", "two words", "a.b", "1st", "x".repeat(65), 7, null, `x-${secret}`].map(field => [d => { d.ready.field = field; }, "ready.field must be the name of a top-level field: a letter or underscore, then letters, digits or underscores"]),
    // version
    ...[null, [], secret].map(version => [d => { d.version = version; }, "version must be an object"]),
    ...[[], secret, ["/opt/agent-child/serve", 1]].map(command => [d => { d.version.command = command; }, "version.command must be a non-empty array of strings"]),
    [d => { d.version.command = ["serve", "--version"]; }, "version.command[0] must be an absolute path"],
    ...["version", "", 7, null, "/opt/a\0b"].map(file => [d => { d.version.file = file; }, "version.file must be an absolute path"]),
    // stopMs
    ...[999, 8001, 0, -1000, 1500.5, "2000", null, [2000]].map(stopMs => [d => { d.stopMs = stopMs; }, "stopMs must be a whole number from 1000 to 8000"]),
  ];
  for (const [declaration, refusal] of cases) {
    const fx = await supervisorFixture(t, {child: "extra", declaration, loginFiles: {"child-token": secret}});
    await refusedBeforeAnyChild(fx, `${declarationFile}: ${refusal}`, refusal);
    assert.ok(!fx.said.join("\n").includes(secret), "no value from the file is shown: " + refusal);
    assert.ok(fx.fileCalls.every(([, path]) => path === declarationFile), refusal + ": nothing else is read");
  }
  // What the grammar admits at its edges, read by the same parser acceptance uses.
  const { parseChildDeclaration } = await import("../container/agent/supervisor.mjs");
  const good = (await supervisorFixture(t, {declaration: false})).declared;
  for (const change of [
    d => { delete d.envFromFile; }, d => { d.envFromFile = {}; }, d => { d.env = {}; }, d => { d.env = {_: "", A1_: " spaced value "}; },
    d => { d.name = "a"; }, d => { d.name = "0-child-with-20-char"; }, d => { d.name = "brokers"; }, d => { d.name = "host"; }, d => { d.name = "sshd-2"; }, d => { d.stopMs = 1000; }, d => { d.stopMs = 8000; }, d => { d.ready.field = "_"; },
    d => { d.listen = [d.listen[0]]; }, d => { d.listen.push(1024, 65535); }, d => { d.command = [d.command[0]]; }, d => { d.ready.url += "?a=1&b=%20"; },
    d => { d.ready.url = `http://127.0.0.1:${d.listen[0]}/`; },
  ]) {
    const declared = structuredClone(good);
    change(declared);
    assert.deepEqual(parseChildDeclaration(JSON.stringify(declared)), {envFromFile: {}, ...declared});
  }
  // And two of them through a real start: no envFromFile at all, and the shortest name.
  for (const [declaration, child] of [[d => { delete d.envFromFile; }, "extra"], [d => { d.name = "a"; }, "a"]]) {
    const fx = await supervisorFixture(t, {declaration, child});
    await fx.until(() => fx.text().includes("host started"));
    assert.ok(fx.said.includes(`${child} ready (up: true)`));
    fx.term();
    assert.equal(await fx.running, 0);
  }
});

test("a declared name that differs from AGENT_CHILD refuses", async t => {
  for (const child of ["other", "extra2", "extr", "EXTRA", "1", " extra", "FIXTURE_VALUE_NEVER_SHOWN"]) {
    const fx = await supervisorFixture(t, {child, loginFiles: {"child-token": "FIXTURE_TOKEN_NEVER_READ"}});
    await refusedBeforeAnyChild(fx, "/etc/agent-child.json: name differs from AGENT_CHILD", JSON.stringify(child));
    assert.deepEqual(fx.fileCalls, [["open", declarationFile]], "neither the command nor a login file is looked at");
  }
});

test("a command that resolves under a writable mount refuses", async t => {
  // The declared path is the image's own; it is a link into each place an agent can write.
  for (const commandIs of ["state", "work", "tmp", "run", "outbox", "dev/shm"]) {
    const fx = await supervisorFixture(t, {child: "extra", commandIs, loginFiles: {"child-token": "FIXTURE_TOKEN_NEVER_READ"}});
    await refusedBeforeAnyChild(fx, "/etc/agent-child.json: command[0] resolves under a writable mount", commandIs);
    assert.deepEqual(fx.fileCalls, [["open", declarationFile], ["realpath", "/opt/agent-child/serve"]], "no login file is read");
  }
  // A link in a writable mount on the way to an image file: admitted, since the file is the image's,
  // and what runs is that resolved file, at the start and at every restart, never the path through the link.
  const chain = await supervisorFixture(t, {child: "extra", commandIs: "chain"});
  await chain.until(() => chain.text().includes("host started"));
  chain.children.get("child").kill("SIGKILL");
  await chain.until(() => chain.text().split("child serving").length - 1 >= 2);
  const launches = chain.spawned.filter(entry => entry.role === "child");
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.file, "/usr/bin/real-serve", "the resolved file is spawned");
    assert.equal(launch.options.argv0, "/opt/agent-child/serve", "under its declared name");
    assert.deepEqual(launch.args, chain.declared.command.slice(1));
  }
  assert.equal(chain.fileCalls.filter(([call]) => call === "realpath").length, 1, "resolved once, at admission: not again for the restart");
  chain.term();
  assert.equal(await chain.running, 0);
  // Declared there outright, with no link.
  const direct = await supervisorFixture(t, {child: "extra", commandIs: "absent", rootFiles: ["state/home/serve"], declaration: d => { d.command[0] = "/state/home/serve"; }});
  await refusedBeforeAnyChild(direct, "/etc/agent-child.json: command[0] resolves under a writable mount", "declared under /state");
  // A neighbour of a mount by name only is the image's own.
  const neighbour = await supervisorFixture(t, {child: "extra", commandIs: "absent", rootFiles: ["statement/serve"], declaration: d => { d.command[0] = "/statement/serve"; }});
  await neighbour.until(() => neighbour.text().includes("host started"));
  neighbour.term();
  assert.equal(await neighbour.running, 0);
  const absent = await supervisorFixture(t, {child: "extra", commandIs: "absent"});
  await refusedBeforeAnyChild(absent, "/etc/agent-child.json: command[0] does not exist", "absent");
  const under = await supervisorFixture(t, {child: "extra", commandIs: "absent", declaration: d => { d.command[0] = "/opt/agent-child/serve/inner"; }});
  await refusedBeforeAnyChild(under, "/etc/agent-child.json: command[0] does not exist", "a path through a missing directory");
});

test("the child starts after the broker is ready and before SSH and host run, with exactly its declared argv and environment", async t => {
  const fx = await supervisorFixture(t, {child: "extra"});
  await fx.until(() => fx.text().includes("host started"));
  const events = fx.text().split("\n");
  const order = ["broker spawned", "broker ready", "supervisor broker ready (daemon_running: true)", "child spawned", "child serving", "supervisor extra ready (up: true)", "ssh spawned", "host spawned"].map(event => events.indexOf(event));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || order[i - 1] < at)), fx.text());
  assert.deepEqual(roles(fx), ["broker", "child", "ssh", "host"]);
  assert.deepEqual(fx.fileCalls, [["open", declarationFile], ["realpath", "/opt/agent-child/serve"], ["read", "/etc/agent-login/child-token"], ["read", "/etc/agent-login/other-token"]], "everything is read once");
  const child = fx.spawned.find(entry => entry.role === "child");
  assert.equal(fx.spawned.indexOf(child) > 0 && fx.fileCalls.length, 4, "and before any child");
  assert.deepEqual([child.options.argv0, ...child.args], ["/opt/agent-child/serve", "--flag", "two words", ""], "argv is exactly `command`: no shell, nothing added");
  assert.equal(child.file, "/opt/agent-child/serve", "the file that was resolved and checked");
  assert.deepEqual(Object.keys(child.options).sort(), ["argv0", "detached", "env", "stdio"]);
  assert.equal(child.options.detached, true, "its own process group");
  assert.equal(child.options.stdio, "inherit");
  const { AGENT_BB: _gone, ...own } = process.env;
  assert.deepEqual(child.options.env, {...own, AGENT_CHILD: "extra", CHILD_SETTING: "declared", CHILD_EMPTY: ""}, "the supervisor's own environment, then `env`");
  const received = fx.childReceived().env;
  assert.equal(received.CHILD_SETTING, "declared");
  assert.equal(received.CHILD_EMPTY, "");
  assert.equal(received.HOME, process.env.HOME, "the child gets the supervisor's own environment");
  assert.equal(received.AGENT_CHILD, "extra");
  for (const entry of fx.spawned) if (entry !== child) assert.deepEqual(Object.keys(entry.options), ["stdio"], entry.role + " is started as without a child");
  fx.term();
  assert.equal(await fx.running, 0);
});

// Bounded: on a supervisor without a refusal the child, sshd and host run start and `running` never settles.
test("an envFromFile value reaches only the child; an absent file starts it without the variable; an unreadable one, or one with whitespace inside, fails the start and never shows the value", {timeout: 60_000}, async t => {
  const token = "FIXTURE_TOKEN_" + "x".repeat(24);
  // Two entries: one file present, the other absent.
  const fx = await supervisorFixture(t, {child: "extra", loginFiles: {"child-token": `\n  ${token}\n\n`}});
  await fx.until(() => fx.text().includes("host started"));
  assert.equal(fx.childReceived().env.CHILD_TOKEN, token, "trimmed file content");
  assert.equal("CHILD_OTHER" in fx.childReceived().env, false, "the absent file's variable is not set, and the child still starts");
  fx.children.get("child").kill("SIGKILL");
  await fx.until(() => fx.text().split("child serving").length - 1 >= 2);
  assert.equal(fx.childReceived().env.CHILD_TOKEN, token, "a restarted child gets it too");
  assert.equal(fx.fileCalls.filter(([call]) => call === "read").length, 2, "each file was read once, not again for the restart");
  fx.term();
  assert.equal(await fx.running, 0);
  assert.ok(fx.spawned.some(entry => entry.role === "status" && entry !== fx.spawned[0]), "status probes ran");
  for (const {role, file, args, options} of fx.spawned) {
    assert.ok(![file, ...args].join("\n").includes(token), role + " arguments");
    if (role !== "child") assert.equal(options.env, undefined, role + " inherits the supervisor's environment, which never holds the value");
  }
  assert.ok(!Object.values(process.env).includes(token));
  assert.ok(!fx.said.join("\n").includes(token) && !fx.text().includes(token), "no line the supervisor writes holds the value");

  for (const content of ["", " \n", "\t\n \n"]) {
    const empty = await supervisorFixture(t, {child: "extra", loginFiles: {"child-token": content, "other-token": token}});
    await empty.until(() => empty.text().includes("host started"));
    assert.equal("CHILD_TOKEN" in empty.childReceived().env, false, "empty: no variable, never an empty one");
    assert.equal(empty.childReceived().env.CHILD_OTHER, token, "each entry follows the rule on its own");
    assert.equal(empty.said[0], "the file for CHILD_TOKEN is empty: extra starts without it", "one line, naming the variable");
    assert.equal(empty.said.filter(line => line.includes("CHILD_TOKEN")).length, 1);
    empty.term();
    assert.equal(await empty.running, 0);
  }
  // A variable of that name in the supervisor's own environment never stands in for the file:
  // absent or empty, the child has none; present, the file's value is the one it gets.
  for (const [loginFiles, expected] of [[{}, undefined], [{"child-token": " \n"}, undefined], [{"child-token": token}, token]]) {
    const inherits = await supervisorFixture(t, {child: "extra", loginFiles, inherited: {CHILD_TOKEN: "INHERITED_VALUE", UNRELATED_INHERITED: "kept"}});
    await inherits.until(() => inherits.text().includes("host started"));
    const received = inherits.childReceived().env;
    assert.equal(received.CHILD_TOKEN, expected, JSON.stringify(Object.keys(loginFiles)));
    assert.equal("CHILD_TOKEN" in received, expected !== undefined);
    assert.equal(received.UNRELATED_INHERITED, "kept", "the rest of the supervisor's environment reaches the child");
    for (const {role, options} of inherits.spawned) if (role !== "child") assert.deepEqual(Object.keys(options), ["stdio"], role + " keeps the supervisor's environment as it is");
    inherits.term();
    assert.equal(await inherits.running, 0);
  }
  for (const code of ["EACCES", "EIO"]) {
    const unreadable = await supervisorFixture(t, {child: "extra", loginFiles: {"child-token": token, "other-token": token}, loginReadErrors: {"/etc/agent-login/other-token": code}});
    await refusedBeforeAnyChild(unreadable, `the file for CHILD_OTHER could not be read (${code})`, code);
  }
  // A real directory where the file should be.
  const directory = await supervisorFixture(t, {child: "extra", loginFiles: {"child-token": null}});
  await refusedBeforeAnyChild(directory, "the file for CHILD_TOKEN could not be read (EISDIR)", "a directory");
  // A value on two lines, or with a space or a tab inside, is never passed on in part.
  // So is one with a NUL inside (a file saved as UTF-16): no child could be given it.
  for (const content of [`${token}\n${token}`, `first ${token}`, `${token}\tsecond`, `${token}\r\n${token}\n`, `export CHILD_TOKEN=${token}\n# note`, `${token}\0${token}`, `\0${token}`]) {
    const split = await supervisorFixture(t, {child: "extra", loginFiles: {"child-token": content}});
    await refusedBeforeAnyChild(split, "the file for CHILD_TOKEN must hold its value on one line", JSON.stringify(content.replaceAll(token, "<value>")));
    assert.ok(!split.said.join("\n").includes(token));
  }
});

// Bounded: on a supervisor that admitted a late answer, sshd and host run start and `running` never settles.
test("a child that never reports ready fails the start and admits neither SSH nor host run", {timeout: 60_000}, async t => {
  // A false field, a truthy value that is not `true`, the field one level down, no such
  // field, an answer that is not JSON or not an object, a status other than 200, and a
  // ready answer that was asked for inside the budget and arrived after it.
  for (const childMode of ["never", "truthy", "nested", "missing", "not-json", "array", "not-200", "straddle"]) {
    const fx = await supervisorFixture(t, {child: "extra", childMode});
    assert.equal(await fx.running, 1, childMode);
    assert.ok(fx.said.includes("extra readiness timed out"), childMode);
    // The budget (1 s in this fixture) bounds the wait itself: no request and no pause runs past it.
    const startedAt = fx.spawned.find(entry => entry.role === "child").at, timedOutAt = fx.timeOf("extra readiness timed out");
    assert.ok(timedOutAt - startedAt >= 1000 && timedOutAt - startedAt < 1000 + 250, `${childMode}: timed out ${timedOutAt - startedAt} ms after the child started`);
    assert.ok(fx.requestCount() > 2, childMode + ": the child was asked");
    assert.equal(fx.requestsAfterBudget(), 0, childMode + ": no request is started once the budget is spent");
    assert.deepEqual(roles(fx), ["broker", "child"], childMode);
    assert.match(fx.text(), /child TERM[\s\S]*child ended/, "the unready child is stopped");
    assert.match(fx.text(), /broker TERM[\s\S]*broker ended/);
  }
});

// Bounded: on a supervisor that admitted another process's answer, sshd and host run start and `running` never settles.
test("a ready answer without our live child, or before the child starts, cannot admit agents", {timeout: 30_000}, async t => {
  // The answer names no process: one that is ready before the child starts is refused,
  // since it could otherwise pass for our child's while that child still lives.
  const stale = await supervisorFixture(t, {child: "extra", externalStatus: true});
  assert.equal(await stale.running, 1);
  assert.ok(stale.said.includes("extra's ready URL already answers before extra starts"));
  assert.deepEqual(roles(stale), ["broker"], "another process's ready answer admits nothing");
  assert.ok(stale.statusHits() >= 1);
  // Whatever accepts a connection there before the child starts refuses, not only a ready answer:
  // a process that holds the port and says "not ready", 503, no JSON or nothing at all now would
  // say "ready" later, beside a child of ours that lives and never held the port.
  for (const externalStatus of ["later", "error", "text", "mute"]) {
    const early = await supervisorFixture(t, {child: "extra", externalStatus, childMode: "idle"});
    assert.equal(await early.running, 1, externalStatus);
    assert.ok(early.said.includes("extra's ready URL already answers before extra starts"), externalStatus);
    assert.deepEqual(roles(early), ["broker"], externalStatus + ": the child is not started, and neither sshd nor host run");
    assert.equal(early.statusHits(), 1, externalStatus + ": asked once");
  }
  // A refused connection is the only pass. An attempt that could not tell whether anybody listens
  // (it failed before connecting, or its second ran out with no connection and no error) refuses the start as well.
  for (const preflight of ["emfile", "pending"]) {
    const unclear = await supervisorFixture(t, {child: "extra", preflight, childMode: "idle"});
    assert.equal(await unclear.running, 1, preflight);
    assert.ok(unclear.said.includes("extra's ready URL already answers before extra starts"), preflight + ": " + unclear.said.join("; "));
    assert.deepEqual(roles(unclear), ["broker"], preflight + ": the child is not started");
    assert.equal(unclear.requestCount(), 1, preflight + ": asked once");
    if (preflight !== "pending") continue;
    const waited = unclear.timeOf("extra's ready URL already answers before extra starts") - unclear.timeOf("broker ready (daemon_running: true)");
    assert.ok(waited >= 990 && waited < 1000 + 500, `the attempt was given its second, not more: ${waited} ms`);
    assert.equal(unclear.pendingDestroyed(), 1, "and was then abandoned");
  }
  const dead = await supervisorFixture(t, {child: "extra", childMode: "exits"});
  assert.equal(await dead.running, 1);
  assert.ok(dead.said.includes("extra exited (0)"));
  assert.deepEqual(roles(dead), ["broker", "child"], "a child that ended before it was ready is not restarted");
});

test("the child's death after a good start is reported and restarted while agents keep running, after its process group's leftovers are removed", async t => {
  const fx = await supervisorFixture(t, {child: "extra"});
  await fx.until(() => fx.text().includes("host started"));
  const first = fx.children.get("child");
  first.kill("SIGKILL");
  await fx.until(() => fx.text().split("child serving").length - 1 >= 2);
  assert.ok(fx.said.includes("extra exited (SIGKILL)"));
  assert.notEqual(fx.children.get("child"), first, "a second child");
  assert.deepEqual(roles(fx), ["broker", "child", "ssh", "host", "child"]);
  const [, again] = fx.spawned.filter(entry => entry.role === "child");
  assert.deepEqual([again.file, again.args, again.options], [fx.declared.command[0], fx.declared.command.slice(1), fx.spawned.find(entry => entry.role === "child").options], "the same argv, environment and group");
  assert.doesNotMatch(fx.text(), /(?:host|broker|ssh) (?:TERM|ended|signal)/, "agents, delivery and SSH were left alone");
  for (const role of ["host", "broker", "ssh"]) assert.equal(fx.children.get(role).exitCode ?? fx.children.get(role).signalCode, null, role);
  // An exit of its own accord is reported with its code, and restarted the same way.
  fx.children.get("child").kill("SIGTERM");
  await fx.until(() => fx.text().split("child serving").length - 1 >= 3);
  assert.ok(fx.said.includes("extra exited (0)"));
  fx.term();
  assert.equal(await fx.running, 0, "a later clean stop");
  assert.match(fx.text(), /child TERM[\s\S]*child ended/);

  // What a killed launcher leaves on the declared port is removed before the restart.
  const left = await supervisorFixture(t, {child: "extra", childMode: "leaves-server"});
  await left.until(() => left.text().includes("host started"));
  const servers = () => [...left.text().matchAll(/^child server pid (\d+)$/gm)].map(match => Number(match[1]));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const started = servers();
  t.after(() => { for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL"); });
  assert.equal(alive(started[0]), true);
  left.children.get("child").kill("SIGKILL");
  // The second server can listen only once the first one is gone.
  await left.until(() => left.text().split("child serving").length - 1 >= 2);
  started.push(...servers().slice(1));
  assert.equal(started.length, 2);
  assert.equal(alive(servers()[0]), false, "the first launcher's server was killed");
  left.term();
  assert.equal(await left.running, 0);
  await left.until(() => !alive(servers()[1]));
});

test("the child restarts after 1 s doubling to 60 s, and from 1 s again after five minutes up; TERM while it waits starts no further child", async t => {
  // The same schedule at a tenth of a second, capped at 0.3 s, reset after 1 s up.
  const fx = await supervisorFixture(t, {child: "extra", restartBackoffMs: 100, restartBackoffMaxMs: 300, restartStableMs: 1000});
  await fx.until(() => fx.text().includes("host started"));
  const starts = () => fx.spawned.filter(entry => entry.role === "child");
  // Kills the newest child and answers how long the supervisor waited to start the next.
  const restartAfterKill = async () => {
    const count = starts().length, exits = fx.said.filter(line => line === "extra exited (SIGKILL)").length;
    fx.children.get("child").kill("SIGKILL");
    await fx.until(() => fx.said.filter(line => line === "extra exited (SIGKILL)").length > exits);
    const exited = Date.now();
    await fx.until(() => starts().length > count);
    return { atLeast: starts().at(-1).at - exited + 15, atMost: starts().at(-1).at - exited };
  };
  // `atLeast` allows for the checkpoint's 10 ms poll after the exit was reported.
  const waits = [];
  for (let i = 0; i < 4; i += 1) waits.push(await restartAfterKill());
  for (const [i, expected] of [100, 200, 300, 300].entries()) assert.ok(waits[i].atLeast >= expected, `restart ${i + 1} waited ${waits[i].atMost} ms, expected ${expected}`);
  assert.ok(waits[1].atMost < 300 && waits[3].atMost < 600, "doubling, capped: " + JSON.stringify(waits));
  await delay(1100);
  const afterStable = await restartAfterKill();
  assert.ok(afterStable.atLeast >= 100 && afterStable.atMost < 250, "a child that stayed up starts the schedule over: " + JSON.stringify(afterStable));
  const afterShort = await restartAfterKill();
  assert.ok(afterShort.atLeast >= 200, "and it doubles again: " + JSON.stringify(afterShort));
  fx.term();
  assert.equal(await fx.running, 0);
  // The schedule the image runs with.
  const source = read("supervisor.mjs");
  assert.match(source, /restartBackoffMs = 1_000, restartBackoffMaxMs = 60_000, restartStableMs = 300_000,/);

  const timers = () => process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;
  // The restart falls due while host run still drains: it must not start a child then.
  const draining = await supervisorFixture(t, {child: "extra", restartBackoffMs: 300, restartBackoffMaxMs: 300, hostDrainMs: 900});
  await draining.until(() => draining.text().includes("host started"));
  draining.children.get("child").kill("SIGKILL");
  await draining.until(() => draining.said.includes("extra exited (SIGKILL)"));
  draining.term();
  assert.equal(await draining.running, 0, "a child that ended before TERM does not fail the stop");
  const drained = draining.text().split("\n"), hostAt = draining.spawned.find(entry => entry.role === "host").at;
  assert.ok(drained.indexOf("host ended") > drained.indexOf("host TERM") && Date.now() - hostAt >= 900, "the drain outlasted the 300 ms backoff");
  assert.deepEqual(roles(draining), ["broker", "child", "ssh", "host"], "no child starts once stopping");
  // The restart is still pending when the supervisor returns: nothing of it may
  // remain, or the container would stay up until the timer ran out.
  const before = timers();
  const pending = await supervisorFixture(t, {child: "extra", restartBackoffMs: 5_000, restartBackoffMaxMs: 5_000});
  await pending.until(() => pending.text().includes("host started"));
  pending.children.get("child").kill("SIGKILL");
  await pending.until(() => pending.said.includes("extra exited (SIGKILL)"));
  assert.equal(timers(), before + 1, "the restart is pending");
  pending.term();
  assert.equal(await pending.running, 0);
  assert.equal(timers(), before, "the pending restart was cancelled");
  assert.deepEqual(roles(pending), ["broker", "child", "ssh", "host"]);
});

test("TERM stops host run first and the child only after host run has ended; a child lost while host run drains is a failed stop", async t => {
  const fx = await supervisorFixture(t, {child: "extra"});
  await fx.until(() => ["broker", "child", "ssh", "host"].every(role => fx.text().includes(role + " listening")));
  fx.term();
  assert.equal(await fx.running, 0);
  const events = fx.text().split("\n");
  assert.ok(events.indexOf("host TERM") >= 0 && events.indexOf("host TERM") < events.indexOf("host ended"));
  for (const role of ["child", "ssh", "broker"]) assert.ok(events.indexOf("host ended") < events.indexOf(role + " TERM"), role + ": " + fx.text());
  assert.ok(events.indexOf("child TERM") < events.indexOf("child ended"));

  const lost = await supervisorFixture(t, {child: "extra"});
  await lost.until(() => lost.text().includes("host started"));
  lost.term();
  await lost.until(() => lost.text().includes("host TERM"));
  assert.doesNotMatch(lost.text(), /host ended/, "host run must still be draining when the child is lost");
  lost.children.get("child").kill("SIGKILL");
  assert.equal(await lost.running, 1, "the child lost while host run drains is a failed stop, as for the broker");
  assert.deepEqual(roles(lost), ["broker", "child", "ssh", "host"], "no child starts once stopping");
});

test("TERM during the child's readiness starts neither SSH nor host run", async t => {
  const fx = await supervisorFixture(t, {child: "extra", childMode: "never"});
  await fx.until(() => fx.text().includes("child serving"));
  fx.term();
  assert.equal(await fx.running, 0);
  assert.deepEqual(roles(fx), ["broker", "child"]);
  assert.match(fx.text(), /child TERM[\s\S]*child ended/);
});

test("a child that ignores TERM is killed after its declared stopMs, beside sshd and the broker, and fails the stop", async t => {
  const fx = await supervisorFixture(t, {child: "extra", childMode: "stubborn-child", declaration: d => { d.stopMs = 1500; }});
  await fx.until(() => fx.text().includes("host started"));
  const killed = new Promise(resolve => fx.children.get("child").once("exit", (_code, signal) => resolve({signal, at: Date.now()})));
  fx.term();
  await fx.until(() => fx.text().includes("child TERM"));
  const asked = Date.now();
  assert.equal(await fx.running, 1);
  assert.ok(fx.said.includes("extra exited (SIGKILL)"));
  const { signal, at } = await killed;
  assert.equal(signal, "SIGKILL");
  // `asked` is read up to one 10 ms poll after TERM was sent.
  assert.ok(at - asked >= 1500 - 30 && at - asked < 1500 + 1000, `killed ${at - asked} ms after TERM, declared 1500`);
  assert.match(fx.text(), /ssh ended[\s\S]*supervisor extra exited \(SIGKILL\)/, "sshd and the broker did not wait for it");
  assert.match(fx.text(), /broker ended[\s\S]*supervisor extra exited \(SIGKILL\)/);
});

test("the stop budget stays inside the container's grace for the largest stopMs a declaration may ask", async () => {
  const { stopBudgetsMs, childStopRangeMs, parseChildDeclaration } = await import("../container/agent/supervisor.mjs");
  // The kernel's drain, not exported: lib/host-run-work.mjs (hostRunWork's
  // naturalMs and cancelMs defaults) and lib/host-run.mjs (STOP_GRACE_MS).
  const drainMs = 10_000 + 5_000 + 20_000;
  const kernel = name => readFileSync(new URL(`../lib/${name}`, import.meta.url), "utf8");
  assert.match(kernel("host-run-work.mjs"), /naturalMs = 10_000, cancelMs = 5_000/, "the pinned drain follows the kernel");
  assert.match(kernel("host-run.mjs"), /^const STOP_GRACE_MS = 20_000;$/m, "the pinned drain follows the kernel");
  assert.deepEqual({...stopBudgetsMs}, {sshd: 3_000, broker: 6_000});
  assert.deepEqual({...childStopRangeMs}, {min: 1_000, max: 8_000});
  assert.ok(Object.isFrozen(stopBudgetsMs) && Object.isFrozen(childStopRangeMs));
  const grace = parse(read("compose.agent.yaml")).services.agent.stop_grace_period.match(/^(\d+)s$/);
  assert.ok(grace, "stop_grace_period is whole seconds");
  // sshd, the broker and the child are stopped side by side: the largest one counts,
  // and for the child that is the cap, whatever one image declares.
  const stopMs = drainMs + Math.max(stopBudgetsMs.sshd, stopBudgetsMs.broker, childStopRangeMs.max);
  assert.ok(stopMs <= Number(grace[1]) * 1000 - 5_000, `${stopMs} ms of ordered stop must leave 5 s of the ${grace[1]} s grace`);
  // The exported cap is the one the grammar holds a declaration to.
  const declaration = stopMs => JSON.stringify({...JSON.parse(readFixtureChild("agent-child.json")), stopMs});
  assert.equal(parseChildDeclaration(declaration(childStopRangeMs.max)).stopMs, childStopRangeMs.max);
  assert.equal(parseChildDeclaration(declaration(childStopRangeMs.min)).stopMs, childStopRangeMs.min);
  assert.throws(() => parseChildDeclaration(declaration(childStopRangeMs.max + 1)), /^Error: stopMs must be a whole number from 1000 to 8000$/);
  assert.throws(() => parseChildDeclaration(declaration(childStopRangeMs.min - 1)), /^Error: stopMs must be a whole number from 1000 to 8000$/);
});

test("AGENT_BB refuses at start and names AGENT_CHILD", async t => {
  const line = "AGENT_BB is gone: use an image that declares its child and AGENT_CHILD (the bb image now lives in oats-project/oats-bb)";
  for (const agentBb of ["1", "0", "true", "", " "]) {
    // Alone, and beside a good AGENT_CHILD on an image with a good declaration.
    for (const child of [undefined, "extra"]) {
      const fx = await supervisorFixture(t, {agentBb, child});
      await refusedBeforeAnyChild(fx, line, JSON.stringify(agentBb));
      assert.deepEqual(fx.fileCalls, [], "nothing is read");
    }
  }
});

test("acceptance with AGENT_CHILD checks the declaration file, the declared listeners, loopback-only and the declared version; without it, it refuses a container that has AGENT_CHILD or AGENT_BB", async t => {
  const { inspectAgent: inspectOnHost, listenerCheck, declarationCheck, versionFileCheck, agentEnvironment, childSelected, main } = await import("../container/agent/accept.mjs");
  const inspectAgent = (info, env, image) => inspectOnHost(info, env, image, undefined, source => source);
  const { env, image, inspected } = acceptanceFixture();

  // The one admitted environment entry, selected by the acceptance host's own AGENT_CHILD.
  const childEnv = {...env, AGENT_CHILD: "extra"}, withChild = structuredClone(inspected);
  withChild.Config.Env.push("AGENT_CHILD=extra");
  assert.doesNotThrow(() => inspectAgent(withChild, childEnv, image), "the switch's entry is the one admitted difference");
  assert.deepEqual(agentEnvironment(image.Config.Env, false, "extra"), [...image.Config.Env, "AGENT_CHILD=extra"]);
  assert.equal(agentEnvironment(image.Config.Env, false, null), image.Config.Env);
  assert.deepEqual([childSelected({}), childSelected({AGENT_CHILD: ""}), childSelected({AGENT_CHILD: "extra"})], [null, null, "extra"]);
  const published = structuredClone(withChild);
  published.HostConfig.PortBindings = {"39111/tcp": [{HostIp: "127.0.0.1", HostPort: "39111"}]};
  assert.throws(() => inspectAgent(published, childEnv, image), /published ports/);
  for (const mutate of [
    v => { v.Config.Env.pop(); },
    v => { v.Config.Env[v.Config.Env.length - 1] = "AGENT_CHILD=other"; },
    v => { v.Config.Env.push("CHILD_DATA_DIR=/state/elsewhere"); },
    v => { v.Config.Env.push("CHILD_TOKEN=FIXTURE_VALUE_NEVER_REPORT"); },
    v => { v.Config.Env.push("AGENT_CHILD=extra"); },
    v => { v.Config.Env.push("AGENT_BB=1"); },
  ]) {
    const changed = structuredClone(withChild);
    mutate(changed);
    assert.throws(() => inspectAgent(changed, childEnv, image), error => !error.message.includes("FIXTURE_VALUE_NEVER_REPORT"));
  }
  assert.throws(() => inspectAgent(withChild, env, image), /AGENT_CHILD is set in the container/, "without the acceptance host's AGENT_CHILD");
  assert.throws(() => inspectAgent(withChild, {...env, AGENT_CHILD: ""}, image), /AGENT_CHILD is set in the container/);
  assert.throws(() => inspectAgent(withChild, {...env, AGENT_CHILD: "other"}, image), /environment names differing/, "another child's name");
  const baked = structuredClone(image);
  baked.Config.Env.push("AGENT_CHILD=extra");
  for (const settings of [env, childEnv]) assert.throws(() => inspectAgent(withChild, settings, baked), /the image sets AGENT_CHILD itself/, "an image cannot switch its child on by itself");
  for (const value of ["Extra", "two words", "x".repeat(21), "a\nb", "1=2"]) assert.throws(() => inspectAgent(withChild, {...env, AGENT_CHILD: value}, image), /AGENT_CHILD must be the declared child's name/);
  // The removed switch is refused with or without a child, whoever set it.
  const gone = structuredClone(inspected), goneImage = structuredClone(image);
  gone.Config.Env.push("AGENT_BB=1");
  goneImage.Config.Env.push("AGENT_BB=1");
  for (const settings of [env, childEnv, {...env, AGENT_BB: "1"}]) {
    assert.throws(() => inspectAgent(gone, settings, image), /AGENT_BB is set in the container: it is gone/);
    assert.throws(() => inspectAgent(gone, settings, goneImage), /AGENT_BB is set in the container: it is gone/, "an image that still sets it");
  }

  // The declaration file, checked in the running container as the supervisor checks it.
  const text = readFixtureChild("agent-child.json");
  const fileSystem = ({uid = 0, mode = 0o100644, size = text.length, file = true, link = false, writable = false, lstat} = {}) => ({
    constants: {W_OK: 2},
    lstatSync(path) { assert.equal(path, declarationFile); if (lstat) throw Object.assign(new Error("PRIVATE_DIAGNOSTIC"), {code: lstat}); return {uid, mode, size, isFile: () => file, isSymbolicLink: () => link}; },
    accessSync(path, access) { assert.deepEqual([path, access], [declarationFile, 2]); if (!writable) throw Object.assign(new Error("read-only"), {code: "EROFS"}); },
    readFileSync(path, encoding) { assert.deepEqual([path, encoding], [declarationFile, "utf8"]); return text; },
  });
  assert.equal(declarationCheck(declarationFile, 16384, fileSystem()), text);
  assert.equal(declarationCheck(declarationFile, 16384, fileSystem({mode: 0o100444, size: 16384})), text);
  for (const [why, broken] of [["a symlink", {link: true, file: false}], ["not a regular file", {file: false}], ["not root's", {uid: 20001}], ["group-writable", {mode: 0o100664}],
    ["other-writable", {mode: 0o100646}], ["oversized", {size: 16385}], ["writable by the agent", {writable: true}], ["absent", {lstat: "ENOENT"}], ["unreadable", {lstat: "EACCES"}]]) {
    assert.throws(() => declarationCheck(declarationFile, 16384, fileSystem(broken)),
      error => /^\/etc\/agent-child\.json must be a regular file owned by root, not a symlink, .*\(contents withheld\)$/.test(error.message) && !error.message.includes("PRIVATE_DIAGNOSTIC"), why);
  }
  const versionFs = (size, file = true) => ({statSync: () => ({size, isFile: () => file}), readFileSync: () => "1.2.3\n"});
  assert.equal(versionFileCheck("/opt/agent-child/version", versionFs(6)), "1.2.3\n");
  assert.throws(() => versionFileCheck("/opt/agent-child/version", versionFs(257)), /declared version file/);
  assert.throws(() => versionFileCheck("/opt/agent-child/version", versionFs(6, false)), /declared version file/);
  assert.throws(() => versionFileCheck("/opt/agent-child/version", {statSync() { throw new Error("PRIVATE_DIAGNOSTIC"); }}), error => !error.message.includes("PRIVATE_DIAGNOSTIC"));

  // /proc/net/tcp as a little-endian kernel prints it: 08AE is 2222, 97E6 and 97E7 are 38886 and 38887.
  const row = (local, state = "0A") => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 20001        0 1234 1 0000000000000000 100 0 0 10 0`;
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const proc = (v4, v6) => ({readFileSync(path) {
    if (path === "/proc/net/tcp") return [header, ...v4.map(entry => row(...[].concat(entry)))].join("\n") + "\n";
    assert.equal(path, "/proc/net/tcp6");
    if (!v6) throw Object.assign(new Error("IPv6 is off"), {code: "ENOENT"});
    return [header, ...v6.map(entry => row(entry))].join("\n") + "\n";
  }});
  const ports = [38886, 38887], team = ["00000000:08AE", "0100007F:97E6", "0100007F:97E7"];
  assert.equal(listenerCheck(ports, proc(team), "LE"), "listening TCP sockets: 0.0.0.0:2222, 127.0.0.1:38886, 127.0.0.1:38887; all on loopback except sshd's port 2222");
  assert.doesNotThrow(() => listenerCheck(ports, proc([...team, "0500007F:1F90", ["020011AC:1F90", "01"]], ["00000000000000000000000000000000:08AE", "00000000000000000000000001000000:1F90", "0000000000000000FFFF00000100007F:1F91"]), "LE"),
    "any loopback listener, sshd on every address and a non-listening socket are admitted");
  for (const [v4, v6] of [
    [[...team, "00000000:97E6"]], [[...team, "020011AC:97E6"]], [[...team, "00000000:1F90"]], [["0100007F:08AE", "00000000:97E6", "0100007F:97E7"]],
    [team, ["00000000000000000000000000000000:1F90"]], [team, ["000080FE00000000000000000100000A:97E6"]], [team, ["0000000000000000FFFF0000020011AC:1F90"]],
  ]) assert.throws(() => listenerCheck(ports, proc(v4, v6), "LE"), /listening beyond loopback: .*only sshd's port 2222 may/);
  assert.throws(() => listenerCheck(ports, proc(["00000000:08AE", "0100007F:97E6"]), "LE"), /the declared child is not listening on loopback port 38887/);
  assert.throws(() => listenerCheck([38886, 38887, 8080], proc(team), "LE"), /not listening on loopback port 8080/, "the ports are the declaration's, not a fixed pair");
  assert.equal(listenerCheck([38887], proc(["00000000:08AE", "0100007F:97E7"]), "LE"), "listening TCP sockets: 0.0.0.0:2222, 127.0.0.1:38887; all on loopback except sshd's port 2222");
  assert.equal(listenerCheck(ports, proc(["00000000:08AE", "7F000001:97E6", "7F000001:97E7"]), "BE"), "listening TCP sockets: 0.0.0.0:2222, 127.0.0.1:38886, 127.0.0.1:38887; all on loopback except sshd's port 2222");
  assert.throws(() => listenerCheck(ports, {readFileSync() { throw Object.assign(new Error("unreadable"), {code: "EACCES"}); }}, "LE"));

  // The whole run, pinned at the Docker subprocess boundary: the declaration and the
  // version file come from the running container, and the declared command runs there.
  const report = t.mock.method(console, "log", () => {});
  const container = "fixture-agent", program = ["exec", "-i", container, "node"];
  const declared = {...JSON.parse(text), name: "extra", listen: [39111, 39112]};
  const accept = ({settings = childEnv, info = withChild, declaration = JSON.stringify(declared), recorded = "1.2.3\n", printed = "1.2.3", versionExit = {status: 0, stderr: ""}} = {}) => {
    const selected = !!settings.AGENT_CHILD;
    const expected = [
      [["inspect", container], JSON.stringify([info])],
      [["image", "inspect", "--", env.AGENT_IMAGE], JSON.stringify([image])],
      [["info", "--format", "{{.DefaultRuntime}}"], "runc"],
      [["exec", container, "node", "-p", "process.arch"], "x64"],
      [program, "runtime fixture"],
      [program, JSON.stringify("resolver readable and non-empty by runtime UID")],
      [program, JSON.stringify({ present: false, evidence: [] })],
      ...(selected ? [
        [program, JSON.stringify(declaration), `(${declarationCheck.toString()})("/etc/agent-child.json",16384)`],
        [program, JSON.stringify("listening TCP sockets: fixture"), `(${listenerCheck.toString()})([39111,39112])`],
        [program, JSON.stringify(recorded), `(${versionFileCheck.toString()})("/opt/agent-child/version")`],
        [["exec", container, "/usr/local/bin/node", "/opt/agent-child/child.mjs", "--version"], printed, undefined, versionExit],
      ] : []),
      [program, JSON.stringify("inputs: absent without the optional fragment")],
      [program, JSON.stringify("outbox: absent without the optional fragment")],
      [["exec", "-i", "--user", "0:0", container, "node"], "root scan fixture"],
      [program, "writable scan fixture"],
      [["exec", container, "sh", "-eu", "-c", null], "EACCES /usr/local"],
      [["exec", container, "oats", "version", "--json"], JSON.stringify({ version: "fixture" })],
      [["exec", container, "aw", "version"], "aw fixture"],
      [["exec", container, "claude", "--version"], "claude fixture"],
    ];
    const calls = [], unexpected = [];
    const run = (executable, argv, options) => {
      const row = expected[calls.length];
      calls.push(argv);
      const matches = row && argv.length === row[0].length && row[0].every((value, at) => value === null ? typeof argv[at] === "string" : isDeepStrictEqual(argv[at], value))
        && (row[2] === undefined || options.input.includes(row[2]));
      if (executable !== "docker" || !matches) {
        unexpected.push({ executable, argv });
        return { status: 2, stdout: "", stderr: `unexpected ${executable} ${JSON.stringify(argv)}` };
      }
      return { status: 0, stdout: row[1], stderr: "", ...row[3] };
    };
    report.mock.resetCalls();
    try { main([container, "--evidence", "target-amd64"], settings, { spawnSync: run }); }
    finally { assert.deepEqual(unexpected, [], "unexpected Docker argv"); }
    assert.equal(calls.length, expected.length, "every expected check ran");
    return report.mock.calls.map(call => call.arguments[0]);
  };
  const lines = accept();
  for (const line of [
    "[target-amd64] PASS /etc/agent-child.json: root-owned regular file, not a symlink, not writable by group, others or the agent; declares extra",
    "[target-amd64] PASS listening TCP sockets: fixture",
    "[target-amd64] PASS extra: version 1.2.3 (the declared command prints the image's version file)",
  ]) assert.equal(lines.filter(reported => reported === line).length, 1, line);
  assert.doesNotThrow(() => accept({recorded: "  v1.2.3 (build 7)\n\n", printed: "v1.2.3 (build 7)"}), "both sides are trimmed");
  // Without the switch nothing of the child is looked at.
  const plain = accept({settings: env, info: inspected});
  assert.ok(!plain.some(line => /agent-child|listening TCP/.test(line)));
  assert.throws(() => accept({settings: env}), /AGENT_CHILD is set in the container/);
  const secret = "FIXTURE_VALUE_NEVER_REPORT";
  const withheld = (options, pattern) => assert.throws(() => accept(options), error => pattern.test(error.message) && !error.message.includes(secret), String(pattern));
  withheld({printed: `1.2.4-${secret}`}, /the declared version command must exit 0 and print exactly the content of the declared version file \(output withheld\)/);
  withheld({printed: ""}, /the declared version command must exit 0 and print exactly/);
  // A command that fails shows neither what it printed nor what it wrote to standard error, even when the output matches.
  withheld({printed: secret, versionExit: {status: 1, stderr: `failed: ${secret}`}}, /the declared version command must exit 0 and print exactly/);
  withheld({versionExit: {status: 1, stderr: secret}}, /the declared version command must exit 0 and print exactly/);
  withheld({versionExit: {status: null, stdout: null, stderr: null, error: new Error(secret)}}, /the declared version command must exit 0 and print exactly/);
  for (const recorded of ["", "\n", `1.2.3\n${secret}`, `1.2.3\u001b[31m${secret}`, "x".repeat(65)]) withheld({recorded, printed: recorded.trim()}, /the declared version file must hold one printable line of at most 64 characters \(contents withheld\)/);
  withheld({declaration: JSON.stringify({...declared, name: "other"})}, /\/etc\/agent-child\.json: name differs from AGENT_CHILD/);
  withheld({declaration: JSON.stringify({...declared, stopMs: 9000, env: {X: secret}})}, /\/etc\/agent-child\.json: stopMs must be a whole number from 1000 to 8000/);
  withheld({declaration: `{ ${secret}`}, /\/etc\/agent-child\.json: the declaration must be JSON/);
});

test("no file under container/agent names bb", () => {
  const directory = new URL("../container/agent/", import.meta.url);
  const files = readdirSync(directory).filter(name => name === "supervisor.mjs" || name === "accept.mjs" || /^compose\..*\.ya?ml$/.test(name));
  assert.deepEqual(files.filter(name => name.endsWith(".mjs")).sort(), ["accept.mjs", "supervisor.mjs"]);
  assert.deepEqual(files.filter(name => !name.endsWith(".mjs")).sort(), ["compose.agent.inputs.yaml", "compose.agent.mirrors.yaml", "compose.agent.outbox.yaml", "compose.agent.trust.yaml", "compose.agent.work.yaml", "compose.agent.yaml"], "no fragment of a product's own");
  assert.equal(existsSync(new URL("../container/agent-bb", import.meta.url)), false, "the derived image and its relay live in oats-project/oats-bb");
  // The one line each file keeps: the refusal of the removed switch.
  const kept = {
    "supervisor.mjs": '  if (env.AGENT_BB !== undefined) { say("AGENT_BB is gone: use an image that declares its child and AGENT_CHILD (the bb image now lives in oats-project/oats-bb)"); return 1; }\n',
    "accept.mjs": '  assert.ok(!names(actualEnv).includes("AGENT_BB"), "AGENT_BB is set in the container: it is gone; recreate the container with an image that declares its child and AGENT_CHILD");\n',
  };
  for (const name of files) {
    let source = read(name);
    if (kept[name]) {
      assert.equal(source.split(kept[name]).length, 2, name + " holds its refusal line once");
      source = source.replace(kept[name], "");
    }
    assert.doesNotMatch(source, /bb/i, name);
    assert.doesNotMatch(source, /3888[67]/, name);
  }
  assert.doesNotMatch(read("supervisor.mjs"), /CLAUDE_CODE_OAUTH_TOKEN|claude/i, "the supervisor knows no product's variable");
});

test("the fixture child image declares one tiny child and stays out of the base image's build context", () => {
  const dockerfile = readFixtureChild("Dockerfile");
  const instructions = dockerfile.replace(/\\\n/g, " ").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  assert.deepEqual(instructions, [
    "ARG AGENT_IMAGE", "FROM ${AGENT_IMAGE}", "USER root", "WORKDIR /opt/agent-child",
    "COPY --chown=0:0 --chmod=644 child.mjs version ./",
    "COPY --chown=0:0 --chmod=644 agent-child.json /etc/agent-child.json",
    "WORKDIR /state", "USER agent",
  ], "the team image is a build argument without a default; no RUN, ENV, ENTRYPOINT or CMD: the team image's stay");
  const rules = readFixtureChild(".dockerignore").split("\n").map(line => line.trim()).filter(Boolean);
  assert.deepEqual(rules, ["**", "!Dockerfile", "!child.mjs", "!version", "!agent-child.json"], "a closed context of its own");
  assert.deepEqual(parse(readFixtureChild("compose.agent.child.yaml")), {services: {agent: {environment: {AGENT_CHILD: "fixture"}}}}, "the switch sets one fixed entry and nothing else");
  assert.doesNotMatch(readFixtureChild("compose.agent.child.yaml"), /\$/, "nothing is interpolated");
  const declared = JSON.parse(readFixtureChild("agent-child.json"));
  assert.equal(declared.name, "fixture");
  assert.deepEqual(declared.listen, [39111], "one loopback port");
  assert.deepEqual(declared.command, ["/usr/local/bin/node", "/opt/agent-child/child.mjs"]);
  assert.deepEqual(declared.version, {command: [...declared.command, "--version"], file: "/opt/agent-child/version"});
  const child = new URL("./fixtures/agent-child/child.mjs", import.meta.url);
  const printed = spawnSync(process.execPath, [child.pathname, "--version"], {encoding: "utf8"});
  assert.equal(printed.status, 0);
  assert.equal(printed.stdout.trim(), readFixtureChild("version").trim(), "the version file holds what the declared command prints");
  assert.doesNotMatch(readFixtureChild("child.mjs"), /\bfrom "(?!node:)|require\(/, "dependency-free");
  // The base image is built from container/agent alone, whose closed context names none of this.
  assert.doesNotMatch(read(".dockerignore") + read("Dockerfile"), /agent-child|fixtures|child\.mjs/);
  assert.equal(existsSync(new URL("../container/agent/agent-child.json", import.meta.url)), false, "the base image declares no child");
});

test("acceptance admits AGENT_CHILD together with the inputs, outbox and trust fragments", async () => {
  const { inspectAgent: inspectOnHost } = await import("../container/agent/accept.mjs");
  const inspectAgent = (info, env, image) => inspectOnHost(info, env, image, undefined, source => source);
  const { env, image, inspected } = acceptanceFixture();
  const all = structuredClone(inspected);
  const allEnv = {...env, AGENT_CHILD: "extra", AGENT_CA_FILE: "/operator/public-ca.pem", TEAM_INPUT_DIR: "/operator/inputs", TEAM_OUTBOX_DIR: "/operator/outbox", TEAM_OUTBOX_GID: "20002"};
  all.Config.Env.push("SSL_CERT_FILE=/etc/agent-trust/ca.pem", "NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem", "AGENT_CHILD=extra");
  for (const [source, target, rw] of [[allEnv.AGENT_CA_FILE, "/etc/agent-trust/ca.pem", false], [allEnv.TEAM_INPUT_DIR, "/inputs", false], [allEnv.TEAM_OUTBOX_DIR, "/outbox", true]]) {
    all.Mounts.push({Source: source, Destination: target, RW: rw, Type: "bind"});
    all.HostConfig.Mounts.push({Type: "bind", Source: source, Target: target, ReadOnly: !rw, BindOptions: {}});
  }
  all.HostConfig.GroupAdd = [allEnv.TEAM_OUTBOX_GID];
  assert.doesNotThrow(() => inspectAgent(all, allEnv, image));
  // Each fragment is still required on its own terms beside the others.
  const withoutChild = {...allEnv};
  delete withoutChild.AGENT_CHILD;
  assert.throws(() => inspectAgent(all, withoutChild, image), /AGENT_CHILD is set in the container/);
  for (const name of ["AGENT_CA_FILE", "TEAM_INPUT_DIR", "TEAM_OUTBOX_DIR"]) {
    const missing = {...allEnv};
    delete missing[name];
    assert.throws(() => inspectAgent(all, missing, image), name);
  }
  const noEntry = structuredClone(all);
  noEntry.Config.Env.pop();
  assert.throws(() => inspectAgent(noEntry, allEnv, image), /environment names differing/);
});
