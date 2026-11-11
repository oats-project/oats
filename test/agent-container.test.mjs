import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
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
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "-g", "--", "\/usr\/local\/bin\/agent-entrypoint"\]$/m);
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
  assert.deepEqual(Object.keys(agent).sort(), ["image", "container_name", "user", "cap_drop", "security_opt", "privileged", "read_only", "tmpfs", "pids_limit", "mem_limit", "cpus", "restart", "stop_grace_period", "healthcheck", "volumes", "networks"].sort(), "only reviewed service keys may be present");
  assert.equal(agent.container_name, "oats-agent-${TEAM:?Set TEAM}");
  assert.equal(agent.user, "${AGENT_UID:-20001}:${AGENT_GID:-20001}");
  assert.deepEqual(agent.cap_drop, ["ALL"]);
  assert.deepEqual(agent.security_opt, ["no-new-privileges:true"]);
  assert.equal(agent.read_only, true);
  assert.equal(agent.privileged, false);
  assert.deepEqual(agent.tmpfs, ["/tmp:rw,nosuid,nodev,mode=1777"]);
  assert.equal(agent.pids_limit, "${AGENT_PIDS:?Set AGENT_PIDS}");
  assert.equal(agent.mem_limit, "${AGENT_MEMORY:?Set AGENT_MEMORY}");
  assert.equal(agent.cpus, "${AGENT_CPUS:?Set AGENT_CPUS}");
  assert.equal(agent.restart, "unless-stopped");
  assert.equal(agent.stop_grace_period, "45s", "oats host run stops the agents within the stop grace");
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

test("the entrypoint starts sshd in the background and ends as oats host run, tini's direct child", () => {
  const lines = read("entrypoint.sh").trimEnd().split("\n");
  assert.deepEqual(lines.slice(-2), ["/usr/sbin/sshd -D -e -f /etc/agent-sshd_config &", "exec oats host run"]);
  assert.equal(lines.filter((line) => /^\s*exec\b/.test(line)).length, 1, "one exec, the last line: whatever it runs is what tini signals and waits for");
});

test("SSH accepts only agent public keys with forwarding disabled", () => {
  const config = sshSettings(read("sshd_config"));
  for (const [key, value] of Object.entries({ Port: "2222", AllowUsers: "agent", AuthenticationMethods: "publickey", PasswordAuthentication: "no", KbdInteractiveAuthentication: "no", PermitRootLogin: "no", UsePAM: "no", DisableForwarding: "yes", StrictModes: "yes", AuthorizedKeysFile: "/etc/agent-ssh/authorized_keys", HostKey: "/state/ssh/ssh_host_ed25519_key", PidFile: "/tmp/agent-sshd.pid" })) assert.equal(config[key.toLowerCase()], value, key);
});

test("SSH guard refuses repeated keywords or conditional configuration", () => {
  for (const prefix of ["PasswordAuthentication yes", "disableforwarding no", "  Match User agent", "  Include /tmp/unreviewed.conf", "disableforwarding=no", "PasswordAuthentication=yes", "DisableForwarding = no", "Include=/tmp/unreviewed.conf", '"PasswordAuthentication" yes']) assert.throws(() => sshSettings(prefix + "\n" + read("sshd_config")), prefix);
});

test("Claude auth acceptance excludes the instance project settings", () => {
  const source = read("accept.mjs");
  assert.match(source, /--setting-sources user/);
  assert.match(source, /mktemp -d \/tmp\/oats-claude-probe\.XXXXXX/);
  assert.doesNotMatch(source, /"exec", "--workdir", home/);
});

test("acceptance refuses drift in the admitted container settings", async () => {
  const { inspectAgent } = await import("../container/agent/accept.mjs");
  const env = { AGENT_IMAGE: "oats-agent:reviewed", AGENT_UID: "20001", AGENT_GID: "20001", TEAM_STATE_DIR: "/srv/team/state", TEAM_LOGIN_DIR: "/srv/team/login", AUTHORIZED_KEYS_FILE: "/srv/team/authorized_keys", RESOLV_CONF_FILE: "/srv/team/resolv.conf", AGENT_PIDS: "512", AGENT_MEMORY: "3g", AGENT_CPUS: "2", AGENTS_NETWORK: "team-agents", AGENT_IP: "172.30.0.2" };
  const image = { Id: "sha256:" + "1".repeat(64), Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/state/home"], Entrypoint: ["/usr/bin/tini", "-g", "--", "/usr/local/bin/agent-entrypoint"], Cmd: null } };
  const inspected = {
    Image: image.Id,
    State: { Running: true },
    Config: { Image: env.AGENT_IMAGE, User: "20001:20001", Env: [...image.Config.Env], Entrypoint: [...image.Config.Entrypoint], Cmd: null, StopTimeout: 45,
      Healthcheck: { Test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/2222"], Interval: 30000000000, Timeout: 5000000000, StartPeriod: 10000000000, Retries: 3 } },
    HostConfig: { CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges:true"], ReadonlyRootfs: true, Privileged: false, PidMode: "", IpcMode: "private", GroupAdd: null, UsernsMode: "", UTSMode: "", CgroupnsMode: "private", Sysctls: null, PortBindings: {}, ExtraHosts: [], Dns: null, NetworkMode: "team-agents", PidsLimit: 512, Memory: 3221225472, NanoCpus: 2000000000, Tmpfs: { "/tmp": "rw,nosuid,nodev,mode=1777" }, Binds: [], Mounts: [], Devices: [], DeviceRequests: null, RestartPolicy: { Name: "unless-stopped" } },
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
  assert.ok(inspectAgent(inspected, env, image).length >= 8);
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
});
