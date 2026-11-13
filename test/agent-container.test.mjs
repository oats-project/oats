import assert from "node:assert/strict";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

test("the entrypoint gives PID-only tini the image supervisor after NSS and key setup", () => {
  const source = read("entrypoint.sh"), lines = source.trimEnd().split("\n");
  assert.equal(lines.at(-1), "exec node /usr/local/lib/agent-supervisor.mjs");
  assert.equal(lines.filter((line) => /^\s*exec\b/.test(line)).length, 1);
  assert.doesNotMatch(source, /sshd -D|exec oats/);
  assert.match(source, /export NSS_WRAPPER_PASSWD=/);
  assert.match(source, /ssh-keygen/);
  assert.match(read("Dockerfile"), /COPY --chmod=644 supervisor\.mjs \/usr\/local\/lib\/agent-supervisor\.mjs/);
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

test("acceptance refuses drift in the admitted container settings", async t => {
  const { inspectAgent: inspectOnHost } = await import("../container/agent/accept.mjs");
  // This metadata fixture has no host files. Real filesystem aliases are checked below.
  const inspectAgent = (info, env, image, runtime) => inspectOnHost(info, env, image, runtime, source => source);
  const env = { AGENT_IMAGE: "oats-agent:reviewed", AGENT_UID: "20001", AGENT_GID: "20001", TEAM_STATE_DIR: "/srv/team/state", TEAM_LOGIN_DIR: "/srv/team/login", AUTHORIZED_KEYS_FILE: "/srv/team/authorized_keys", RESOLV_CONF_FILE: "/srv/team/resolv.conf", AGENT_PIDS: "512", AGENT_TMP_SIZE: "134217728", AGENT_MEMORY: "3g", AGENT_CPUS: "2", AGENTS_NETWORK: "team-agents", AGENT_IP: "172.30.0.2" };
  const image = { Id: "sha256:" + "1".repeat(64), Config: { Env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/state/home"], Entrypoint: ["/usr/bin/tini", "--", "/usr/local/bin/agent-entrypoint"], Cmd: null } };
  const inspected = {
    Image: image.Id,
    State: { Running: true },
    Config: { Image: env.AGENT_IMAGE, Hostname:"oats-agent", User: "20001:20001", Env: [...image.Config.Env], Entrypoint: [...image.Config.Entrypoint], Cmd: null, StopTimeout: 45,
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
    for (const [name, target] of [["AGENT_CA_FILE","/etc/agent-trust/ca.pem"], ["AGENT_MIRRORS_DIR","/mirrors"]]) {
      for (const location of ["state", "work", "operator"]) {
        const source = join(root,location,name);
        if (name === "AGENT_CA_FILE") writeFileSync(source, "public CA fixture");
        else mkdirSync(source);
        const alias = join(root, `${location}-${name}`);
        symlinkSync(source, alias);
        const settings = {...realEnv,[name]:alias};
        const info = structuredClone(name === "AGENT_CA_FILE" ? trusted : mirrored);
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
});


async function supervisorFixture(t, { ready = true, statusTrueAfterBrokerExit = false, statusSpawnFailsOnce = false, statusSpawnThrowsOnce = false, statusIgnoresTerm = false, stubbornFinish = false, brokerStatusPid = "owned", pauseAfterStarted = "" } = {}) {
  const supervisor = new URL("../container/agent/supervisor.mjs", import.meta.url);
  assert.ok(existsSync(supervisor), "the image must own broker readiness and ordered child shutdown");
  const { supervise } = await import(supervisor);
  const dir = mkdtempSync(join(tmpdir(), "oats-image-supervisor-"));
  const events = join(dir, "events"), childFile = join(dir, "child.cjs"), brokerPid = join(dir, "broker-pid");
  writeFileSync(events, "");
  writeFileSync(childFile, `
    const fs = require("node:fs");
    const [role, events, mode, pidFile, pidMode, pausedRole] = process.argv.slice(2);
    const log = text => fs.appendFileSync(events, text + "\\n");
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
        setTimeout(() => { log(role + " ended"); process.exit(0); }, role === "host" ? 80 : 0);
      });
      // Publish the long-lived child's stop handshake only after TERM can drain it.
      started();
      if (role === "broker" && mode === "after-exit") { log("broker exited"); process.exit(0); }
      log(role + " listening");
      setInterval(() => {}, 1000);
    }
  `);
  const children = new Map(), said = [];
  let signal, statusFailed = false;
  const running = supervise({
    spawnChild(file, args, options) {
      const role = file === "aw" ? (args[1] === "run" ? "broker" : "status") : file === "oats" ? "host" : "ssh";
      const mode = role === "status" && statusIgnoresTerm ? "probe-stubborn" : statusTrueAfterBrokerExit ? "after-exit" : stubbornFinish ? "stubborn" : ready ? "ready" : "not-ready";
      appendFileSync(events, role + " spawned\n");
      if (role === "status" && statusSpawnThrowsOnce && !statusFailed) {
        statusFailed = true;
        throw Object.assign(new Error("fixture status spawn failed"), {code: "ENOMEM"});
      }
      const failProbe = role === "status" && statusSpawnFailsOnce && !statusFailed;
      if (failProbe) statusFailed = true;
      const child = spawn(failProbe ? join(dir, "missing-probe") : process.execPath, failProbe ? [] : [childFile, role, events, mode, brokerPid, brokerStatusPid, pauseAfterStarted], { ...options, stdio: role === "status" ? ["ignore", "pipe", "ignore"] : "ignore" });
      if (pauseAfterStarted) {
        const kill = child.kill.bind(child);
        child.kill = signal => {
          const sent = kill(signal);
          if (sent) appendFileSync(events, role + " signal " + signal + "\n");
          return sent;
        };
      }
      children.set(role, child);
      return child;
    },
    onSignal(handler) { signal = handler; return () => { signal = null; }; },
    say(line) { said.push(line); appendFileSync(events, "supervisor " + line + "\n"); }, pollMs: 10, startupMs: 1000, childStopMs: 500,
  });
  t.after(async () => {
    for (const child of children.values()) child.kill("SIGKILL");
    await running.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const text = () => readFileSync(events, "utf8");
  async function until(check) {
    for (let tries = 0; tries < 200; tries += 1) { if (check()) return; await delay(10); }
    assert.fail("supervisor fixture did not reach its checkpoint: " + text() + said.join(";"));
  }
  return { running, children, said, text, until, term: () => signal("SIGTERM") };
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
