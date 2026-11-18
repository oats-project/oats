import assert from "node:assert/strict";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
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
const readBb = (name) => readFileSync(new URL(`../container/agent-bb/${name}`, import.meta.url), "utf8");

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
  // bb: the value of AGENT_BB (absent: unset); a real fixture child serves bb's daemon status.
  bb, bbInstalled = true, bbToken, bbTokenError = "", bbMode = "connected", externalStatus = false,
  bbBackoffMs = 20, bbBackoffMaxMs = 80, bbStableMs, hostDrainMs = 80 } = {}) {
  const supervisor = new URL("../container/agent/supervisor.mjs", import.meta.url);
  assert.ok(existsSync(supervisor), "the image must own broker readiness and ordered child shutdown");
  const { supervise } = await import(supervisor);
  const dir = mkdtempSync(join(tmpdir(), "oats-image-supervisor-"));
  const events = join(dir, "events"), childFile = join(dir, "child.cjs"), brokerPid = join(dir, "broker-pid");
  const bbFile = join(dir, "bb-app"), bbTokenFile = join(dir, "agent-login", "claude-token"), bbSeen = join(dir, "bb-seen.json");
  writeFileSync(events, "");
  if (bbInstalled) writeFileSync(bbFile, "");
  mkdirSync(join(dir, "agent-login"));
  if (bbToken !== undefined) writeFileSync(bbTokenFile, bbToken);
  // A free loopback port stands for 38887; nothing listens there until bb does.
  const bbPort = await new Promise((resolve, reject) => {
    const probe = createTcpServer().once("error", reject).listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  // Another process answering on bb's port: it also counts every probe made.
  let statusHits = 0, external;
  if (externalStatus) {
    external = createHttpServer((_request, response) => { statusHits += 1; response.end(JSON.stringify({ connected: true })); });
    await new Promise((resolve, reject) => external.once("error", reject).listen(bbPort, "127.0.0.1", resolve));
  }
  const reads = [], existChecks = [];
  writeFileSync(childFile, `
    const fs = require("node:fs");
    const [role, events, mode, pidFile, pidMode, pausedRole, brokerDrainMs, bbPort, bbSeen, hostDrainMs] = process.argv.slice(2);
    if (role === "bb") {
      // What the real child process received, read by the tests.
      fs.writeFileSync(bbSeen, JSON.stringify({ env: process.env }));
      if (mode === "leaves-server") {
        // As bb-app does: the launcher's server child holds the port and outlives a killed launcher.
        if (process.argv[12] !== "server") {
          const server = require("node:child_process").spawn(process.execPath, [...process.argv.slice(1), "server"], { stdio: "ignore" });
          fs.appendFileSync(events, "bb server pid " + server.pid + "\\n");
          fs.appendFileSync(events, "bb started\\n");
          setInterval(() => {}, 1000);
          return;
        }
      }
      if (mode === "exits") { fs.appendFileSync(events, "bb started\\nbb exited\\n"); process.exit(0); }
      require("node:http").createServer((request, response) => {
        response.end(JSON.stringify({ hostId: "host_fixture", connected: mode !== "never" && request.url === "/status" }));
      }).listen(Number(bbPort), "127.0.0.1", () => fs.appendFileSync(events, "bb serving\\n"));
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
        if (role === "bb" && mode === "stubborn-bb") return;
        setTimeout(() => { log(role + " ended"); process.exit(0); }, role === "host" ? Number(hostDrainMs) : role === "broker" ? Number(brokerDrainMs) : 0);
      });
      // Publish the long-lived child's stop handshake only after TERM can drain it.
      started();
      if (role === "broker" && mode === "after-exit") { log("broker exited"); process.exit(0); }
      log(role + " listening");
      setInterval(() => {}, 1000);
    }
  `);
  const children = new Map(), said = [], spawned = [];
  let signal, statusFailed = false;
  const env = { ...process.env };
  delete env.AGENT_BB;
  if (bb !== undefined) env.AGENT_BB = bb;
  const running = supervise({
    env, bbFile, bbTokenFile, bbStatusUrl: `http://127.0.0.1:${bbPort}/status`, bbBackoffMs, bbBackoffMaxMs, ...(bbStableMs === undefined ? {} : {bbStableMs}),
    ...(productionStopBudgets ? {} : {bbStopMs: 500}),
    fileExists(path) { existChecks.push(path); return existsSync(path); },
    readFile(path, encoding) {
      reads.push(path);
      if (bbTokenError) throw Object.assign(new Error("fixture read failure"), {code: bbTokenError});
      return readFileSync(path, encoding);
    },
    spawnChild(file, args, options) {
      const role = file === bbFile ? "bb" : file === "aw" ? (args[1] === "run" ? "broker" : "status") : file === "oats" ? "host" : "ssh";
      spawned.push({role, file, args, options, at: Date.now()});
      const mode = role === "bb" ? bbMode : role === "status" && statusIgnoresTerm ? "probe-stubborn" : statusTrueAfterBrokerExit ? "after-exit" : stubbornFinish ? "stubborn" : ready ? "ready" : "not-ready";
      appendFileSync(events, role + " spawned\n");
      if (role === "status" && statusSpawnThrowsOnce && !statusFailed) {
        statusFailed = true;
        throw Object.assign(new Error("fixture status spawn failed"), {code: "ENOMEM"});
      }
      const failProbe = role === "status" && statusSpawnFailsOnce && !statusFailed;
      if (failProbe) statusFailed = true;
      const child = spawn(failProbe ? join(dir, "missing-probe") : process.execPath, failProbe ? [] : [childFile, role, events, mode, brokerPid, brokerStatusPid, pauseAfterStarted, String(brokerDrainMs), String(bbPort), bbSeen, String(hostDrainMs)], { ...options, stdio: role === "status" ? ["ignore", "pipe", "ignore"] : "ignore" });
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
    say(line) { said.push(line); appendFileSync(events, "supervisor " + line + "\n"); }, pollMs: 10, startupMs: 1000,
    ...(productionStopBudgets ? {} : {childStopMs: 500, brokerStopMs: 500}),
  });
  t.after(async () => {
    for (const child of children.values()) child.kill("SIGKILL");
    await running.catch(() => {});
    if (external) { external.closeAllConnections(); await new Promise(resolve => external.close(resolve)); }
    rmSync(dir, { recursive: true, force: true });
  });
  const text = () => readFileSync(events, "utf8");
  async function until(check) {
    for (let tries = 0; tries < 200; tries += 1) { if (check()) return; await delay(10); }
    assert.fail("supervisor fixture did not reach its checkpoint: " + text() + said.join(";"));
  }
  const bbReceived = () => JSON.parse(readFileSync(bbSeen, "utf8"));
  return { running, children, said, text, until, term: () => signal("SIGTERM"), spawned, reads, existChecks, bbReceived, statusHits: () => statusHits };
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

test("without AGENT_BB the supervisor starts exactly the broker, sshd and host run", async t => {
  for (const bb of [undefined, ""]) {
    const fx = await supervisorFixture(t, {bb, bbToken: "FIXTURE_TOKEN_NEVER_READ", externalStatus: true});
    await fx.until(() => fx.text().includes("host started"));
    fx.term();
    assert.equal(await fx.running, 0);
    assert.deepEqual(roles(fx), ["broker", "ssh", "host"], "today's children, in today's order");
    assert.deepEqual(fx.spawned.filter(entry => entry.role !== "status").map(({file, args}) => [file, args]), [
      ["aw", ["wake", "run"]], ["/usr/sbin/sshd", ["-D", "-e", "-f", "/etc/agent-sshd_config"]], ["oats", ["host", "run"]],
    ]);
    for (const {options} of fx.spawned) assert.deepEqual(Object.keys(options), ["stdio"], "no child gets an environment of its own");
    assert.equal(fx.statusHits(), 0, "no HTTP probe is made");
    assert.deepEqual(fx.reads, [], "no file under /etc/agent-login is read");
    assert.deepEqual(fx.existChecks, [], "bb-app is not looked for");
  }
});

test("AGENT_BB without bb-app refuses before any child starts", async t => {
  const fx = await supervisorFixture(t, {bb: "1", bbInstalled: false, bbToken: "FIXTURE_TOKEN_NEVER_READ"});
  assert.equal(await fx.running, 1);
  assert.deepEqual(fx.spawned, []);
  assert.deepEqual(fx.said, ["AGENT_BB needs the bb image: build container/agent-bb and select it as AGENT_IMAGE"]);
  assert.deepEqual(fx.reads, []);
});

test("AGENT_BB with any value but 1 refuses before any child starts", async t => {
  for (const bb of ["0", "true", "yes", " 1", "1 ", "01", "2"]) {
    const fx = await supervisorFixture(t, {bb});
    assert.equal(await fx.running, 1, JSON.stringify(bb));
    assert.deepEqual(fx.spawned, []);
    assert.deepEqual(fx.said, ["AGENT_BB must be 1 or unset"]);
  }
});

test("bb starts after the broker is ready and before SSH and host run", async t => {
  const fx = await supervisorFixture(t, {bb: "1"});
  await fx.until(() => fx.text().includes("host started"));
  const events = fx.text().split("\n");
  const order = ["broker spawned", "broker ready", "supervisor broker ready (daemon_running: true)", "bb spawned", "bb serving", "supervisor bb ready (connected: true)", "ssh spawned", "host spawned"].map(event => events.indexOf(event));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || order[i - 1] < at)), fx.text());
  assert.deepEqual(roles(fx), ["broker", "bb", "ssh", "host"]);
  const bb = fx.spawned.find(entry => entry.role === "bb");
  assert.deepEqual(bb.args, ["--no-in-app-updates", "--server-bind-host", "127.0.0.1"]);
  const received = fx.bbReceived().env;
  assert.equal(received.BB_TELEMETRY, "false");
  assert.equal(received.BB_DATA_DIR, undefined, "bb keeps its default data directory under HOME");
  assert.equal(received.HOME, process.env.HOME, "bb gets the supervisor's own environment");
  fx.term();
  assert.equal(await fx.running, 0);
});

test("only the bb child receives the Claude token", async t => {
  const token = "FIXTURE_TOKEN_" + "x".repeat(24);
  const fx = await supervisorFixture(t, {bb: "1", bbToken: `\n  ${token}\n\n`});
  await fx.until(() => fx.text().includes("host started"));
  assert.equal(fx.bbReceived().env.CLAUDE_CODE_OAUTH_TOKEN, token, "trimmed file content");
  fx.children.get("bb").kill("SIGKILL");
  await fx.until(() => fx.text().split("bb serving").length - 1 >= 2);
  assert.equal(fx.bbReceived().env.CLAUDE_CODE_OAUTH_TOKEN, token, "a restarted bb gets it too");
  fx.term();
  assert.equal(await fx.running, 0);
  assert.ok(fx.spawned.some(entry => entry.role === "status" && entry !== fx.spawned[0]), "status probes ran");
  for (const {role, args, options} of fx.spawned) {
    assert.ok(!args.join("\n").includes(token), role + " arguments");
    if (role !== "bb") assert.equal(options.env, undefined, role + " inherits the supervisor's environment, which never holds the token");
  }
  assert.ok(!Object.values(process.env).includes(token));
  assert.ok(!fx.said.join("\n").includes(token) && !fx.text().includes(token), "no line the supervisor writes holds the value");
});

test("an absent token file starts bb without the variable; an unreadable one fails the start", async t => {
  for (const bbToken of [undefined, "", " \n"]) {
    const absent = await supervisorFixture(t, {bb: "1", bbToken});
    await absent.until(() => absent.text().includes("host started"));
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in absent.bbReceived().env, false, "absent or empty: no variable, never an empty one");
    absent.term();
    assert.equal(await absent.running, 0);
  }
  for (const code of ["EACCES", "EIO", "EISDIR"]) {
    const unreadable = await supervisorFixture(t, {bb: "1", bbToken: "FIXTURE_TOKEN_NEVER_USED", bbTokenError: code});
    assert.equal(await unreadable.running, 1);
    assert.deepEqual(unreadable.spawned, [], "no child starts");
    assert.deepEqual(unreadable.said, [`the Claude token file could not be read (${code})`]);
  }
});

test("bb that never reports connected fails the start and admits neither SSH nor host run", async t => {
  const fx = await supervisorFixture(t, {bb: "1", bbMode: "never"});
  assert.equal(await fx.running, 1);
  assert.ok(fx.said.includes("bb readiness timed out"));
  assert.deepEqual(roles(fx), ["broker", "bb"]);
  assert.match(fx.text(), /bb TERM[\s\S]*bb ended/, "the unready bb is stopped");
  assert.match(fx.text(), /broker TERM[\s\S]*broker ended/);
});

test("a bb status without our live bb child cannot admit agents", async t => {
  // The status names no process: one that answers before bb starts is refused,
  // since it could otherwise pass for our child's while that child still lives.
  const stale = await supervisorFixture(t, {bb: "1", externalStatus: true});
  assert.equal(await stale.running, 1);
  assert.ok(stale.said.includes("bb's status port already answers before bb starts"));
  assert.deepEqual(roles(stale), ["broker"], "another process's connected: true admits nothing");
  assert.ok(stale.statusHits() >= 1);
  const dead = await supervisorFixture(t, {bb: "1", bbMode: "exits"});
  assert.equal(await dead.running, 1);
  assert.ok(dead.said.includes("bb exited (0)"));
  assert.deepEqual(roles(dead), ["broker", "bb"], "a bb that ended before it was ready is not restarted");
});

test("bb death after a good start is reported and restarted while agents keep running", async t => {
  const fx = await supervisorFixture(t, {bb: "1"});
  await fx.until(() => fx.text().includes("host started"));
  const first = fx.children.get("bb");
  first.kill("SIGKILL");
  await fx.until(() => fx.text().split("bb serving").length - 1 >= 2);
  assert.ok(fx.said.includes("bb exited (SIGKILL)"));
  assert.notEqual(fx.children.get("bb"), first, "a second bb child");
  assert.deepEqual(roles(fx), ["broker", "bb", "ssh", "host", "bb"]);
  assert.doesNotMatch(fx.text(), /(?:host|broker|ssh) (?:TERM|ended|signal)/, "agents, delivery and SSH were left alone");
  for (const role of ["host", "broker", "ssh"]) assert.equal(fx.children.get(role).exitCode ?? fx.children.get(role).signalCode, null, role);
  fx.term();
  assert.equal(await fx.running, 0, "a later clean stop");
  assert.match(fx.text(), /bb TERM[\s\S]*bb ended/);
});

test("what a killed bb launcher leaves on bb's ports is removed before the restart", async t => {
  const fx = await supervisorFixture(t, {bb: "1", bbMode: "leaves-server"});
  await fx.until(() => fx.text().includes("host started"));
  const servers = () => [...fx.text().matchAll(/^bb server pid (\d+)$/gm)].map(match => Number(match[1]));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const started = servers();
  t.after(() => { for (const pid of started) if (alive(pid)) process.kill(pid, "SIGKILL"); });
  assert.equal(alive(started[0]), true);
  fx.children.get("bb").kill("SIGKILL");
  // The second server can listen only once the first one is gone.
  await fx.until(() => fx.text().split("bb serving").length - 1 >= 2);
  started.push(...servers().slice(1));
  assert.equal(started.length, 2);
  assert.equal(alive(servers()[0]), false, "the first launcher's server was killed");
  fx.term();
  assert.equal(await fx.running, 0);
  await fx.until(() => !alive(servers()[1]));
});

test("TERM stops host run first and bb only after host run has ended", async t => {
  const fx = await supervisorFixture(t, {bb: "1"});
  await fx.until(() => ["broker", "bb", "ssh", "host"].every(role => fx.text().includes(role + " listening")));
  fx.term();
  assert.equal(await fx.running, 0);
  const events = fx.text().split("\n");
  assert.ok(events.indexOf("host TERM") >= 0 && events.indexOf("host TERM") < events.indexOf("host ended"));
  assert.ok(events.indexOf("host ended") < events.indexOf("bb TERM"), fx.text());
  assert.ok(events.indexOf("bb TERM") < events.indexOf("bb ended"));
});

test("bb lost while host run drains is a failed stop and is not restarted", async t => {
  const fx = await supervisorFixture(t, {bb: "1"});
  await fx.until(() => fx.text().includes("host started"));
  fx.term();
  await fx.until(() => fx.text().includes("host TERM"));
  fx.children.get("bb").kill("SIGKILL");
  assert.equal(await fx.running, 1, "bb lost while host run drains is a failed stop, as for the broker");
  assert.deepEqual(roles(fx), ["broker", "bb", "ssh", "host"], "no bb starts once stopping");
});

test("TERM while bb waits to restart starts no further bb", async t => {
  const timers = () => process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length;
  // The restart falls due while host run still drains: it must not start a bb then.
  const draining = await supervisorFixture(t, {bb: "1", bbBackoffMs: 300, bbBackoffMaxMs: 300, hostDrainMs: 900});
  await draining.until(() => draining.text().includes("host started"));
  draining.children.get("bb").kill("SIGKILL");
  await draining.until(() => draining.said.includes("bb exited (SIGKILL)"));
  draining.term();
  assert.equal(await draining.running, 0, "a bb that ended before TERM does not fail the stop");
  const drained = draining.text().split("\n"), hostAt = draining.spawned.find(entry => entry.role === "host").at;
  assert.ok(drained.indexOf("host ended") > drained.indexOf("host TERM") && Date.now() - hostAt >= 900, "the drain outlasted the 300 ms backoff");
  assert.deepEqual(roles(draining), ["broker", "bb", "ssh", "host"], "no bb starts once stopping");
  // The restart is still pending when the supervisor returns: nothing of it may
  // remain, or the container would stay up until the timer ran out.
  const before = timers();
  const pending = await supervisorFixture(t, {bb: "1", bbBackoffMs: 5_000, bbBackoffMaxMs: 5_000});
  await pending.until(() => pending.text().includes("host started"));
  pending.children.get("bb").kill("SIGKILL");
  await pending.until(() => pending.said.includes("bb exited (SIGKILL)"));
  assert.equal(timers(), before + 1, "the restart is pending");
  pending.term();
  assert.equal(await pending.running, 0);
  assert.equal(timers(), before, "the pending restart was cancelled");
  assert.deepEqual(roles(pending), ["broker", "bb", "ssh", "host"]);
});

test("bb restarts after 1 s doubling to 60 s, and from 1 s again after five minutes up", async t => {
  // The same schedule at a tenth of a second, capped at 0.3 s, reset after 1 s up.
  const fx = await supervisorFixture(t, {bb: "1", bbBackoffMs: 100, bbBackoffMaxMs: 300, bbStableMs: 1000});
  await fx.until(() => fx.text().includes("host started"));
  const bbs = () => fx.spawned.filter(entry => entry.role === "bb");
  // Kills the newest bb and answers how long the supervisor waited to start the next.
  const restartAfterKill = async () => {
    const count = bbs().length, exits = fx.said.filter(line => line === "bb exited (SIGKILL)").length;
    fx.children.get("bb").kill("SIGKILL");
    await fx.until(() => fx.said.filter(line => line === "bb exited (SIGKILL)").length > exits);
    const exited = Date.now();
    await fx.until(() => bbs().length > count);
    return { atLeast: bbs().at(-1).at - exited + 15, atMost: bbs().at(-1).at - exited };
  };
  // `atLeast` allows for the checkpoint's 10 ms poll after the exit was reported.
  const waits = [];
  for (let i = 0; i < 4; i += 1) waits.push(await restartAfterKill());
  for (const [i, expected] of [100, 200, 300, 300].entries()) assert.ok(waits[i].atLeast >= expected, `restart ${i + 1} waited ${waits[i].atMost} ms, expected ${expected}`);
  assert.ok(waits[1].atMost < 300 && waits[3].atMost < 600, "doubling, capped: " + JSON.stringify(waits));
  await delay(1100);
  const afterStable = await restartAfterKill();
  assert.ok(afterStable.atLeast >= 100 && afterStable.atMost < 250, "a bb that stayed up starts the schedule over: " + JSON.stringify(afterStable));
  const afterShort = await restartAfterKill();
  assert.ok(afterShort.atLeast >= 200, "and it doubles again: " + JSON.stringify(afterShort));
  fx.term();
  assert.equal(await fx.running, 0);
});

test("TERM during bb readiness starts neither SSH nor host run", async t => {
  const fx = await supervisorFixture(t, {bb: "1", bbMode: "never"});
  await fx.until(() => fx.text().includes("bb serving"));
  fx.term();
  assert.equal(await fx.running, 0);
  assert.deepEqual(roles(fx), ["broker", "bb"]);
  assert.match(fx.text(), /bb TERM[\s\S]*bb ended/);
});

test("a bb that ignores TERM is killed within its budget and fails the stop", async t => {
  const fx = await supervisorFixture(t, {bb: "1", bbMode: "stubborn-bb"});
  await fx.until(() => fx.text().includes("host started"));
  fx.term();
  assert.equal(await fx.running, 1);
  assert.ok(fx.said.includes("bb exited (SIGKILL)"));
});

test("the stop budget stays inside the container's grace", async () => {
  const { stopBudgetsMs } = await import("../container/agent/supervisor.mjs");
  // The kernel's drain, not exported: lib/host-run-work.mjs (hostRunWork's
  // naturalMs and cancelMs defaults) and lib/host-run.mjs (STOP_GRACE_MS).
  const drainMs = 10_000 + 5_000 + 20_000;
  const kernel = name => readFileSync(new URL(`../lib/${name}`, import.meta.url), "utf8");
  assert.match(kernel("host-run-work.mjs"), /naturalMs = 10_000, cancelMs = 5_000/, "the pinned drain follows the kernel");
  assert.match(kernel("host-run.mjs"), /^const STOP_GRACE_MS = 20_000;$/m, "the pinned drain follows the kernel");
  assert.deepEqual(Object.keys(stopBudgetsMs).sort(), ["bb", "broker", "sshd"]);
  const grace = parse(read("compose.agent.yaml")).services.agent.stop_grace_period.match(/^(\d+)s$/);
  assert.ok(grace, "stop_grace_period is whole seconds");
  // sshd, the broker and bb are stopped side by side: the largest one counts.
  const stopMs = drainMs + Math.max(...Object.values(stopBudgetsMs));
  assert.ok(stopMs <= Number(grace[1]) * 1000 - 5_000, `${stopMs} ms of ordered stop must leave 5 s of the ${grace[1]} s grace`);
  assert.deepEqual({...stopBudgetsMs}, {sshd: 3_000, broker: 6_000, bb: 8_000});
});

test("the bb fragment sets one fixed environment entry and nothing else", () => {
  assert.deepEqual(parse(read("compose.agent.bb.yaml")), {services: {agent: {environment: {AGENT_BB: "1"}}}});
  assert.doesNotMatch(read("compose.agent.bb.yaml"), /\$/, "nothing is interpolated");
});

test("the derived image adds only pinned bb-app", () => {
  const dockerfile = readBb("Dockerfile");
  const instructions = dockerfile.replace(/\\\n/g, " ").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  assert.deepEqual(instructions.slice(0, 2), ["ARG AGENT_IMAGE", "FROM ${AGENT_IMAGE}"], "the team image is a build argument without a default");
  assert.equal(instructions.filter(line => /^(?:ARG|FROM)\b/.test(line)).length, 2);
  assert.equal(instructions.at(-1), "USER agent");
  assert.deepEqual([...new Set(instructions.map(line => line.split(/\s+/, 1)[0]))].sort(), ["ARG", "COPY", "FROM", "RUN", "USER", "WORKDIR"], "no ENV, ENTRYPOINT, CMD, EXPOSE or VOLUME: the team image's stay");
  assert.equal(instructions.filter(line => line.startsWith("WORKDIR")).at(-1), "WORKDIR /state");
  const runs = instructions.filter(line => line.startsWith("RUN"));
  assert.equal(runs.length, 1);
  assert.match(runs[0], /^RUN npm ci --ignore-scripts --no-audit --no-fund /);
  assert.doesNotMatch(dockerfile, /apt-get|\bapt\b|\bcurl\b|\bwget\b|npm rebuild|npm install|ignore-scripts=false/);
  assert.match(runs[0], /ln -s \/opt\/agent-bb\/node_modules\/\.bin\/bb \/usr\/local\/bin\/bb /);
  assert.match(runs[0], /ln -s \/opt\/agent-bb\/node_modules\/\.bin\/bb-app \/usr\/local\/bin\/bb-app /);
  assert.match(runs[0], /bb --version/);

  const manifest = JSON.parse(readBb("package.json")), lock = JSON.parse(readBb("package-lock.json"));
  assert.deepEqual(Object.keys(manifest.dependencies), ["bb-app"]);
  assert.match(manifest.dependencies["bb-app"], /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(manifest).sort(), ["dependencies", "name", "private", "version"]);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.equal(lock.packages["node_modules/bb-app"].version, manifest.dependencies["bb-app"]);
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.doesNotMatch(name, /claude-code|@anthropic-ai/, "bb uses the team image's Claude Code; a second one never enters the image");
    // Packages inside a tarball (bb-app's own npm) are covered by that tarball's hash.
    if (pkg.inBundle) { assert.match(name, /^node_modules\/npm\/node_modules\//); continue; }
    assert.match(pkg.integrity, /^sha512-/, name);
    assert.match(pkg.resolved, /^https:\/\/registry\.npmjs\.org\//, name);
    // Without `libc`, npm also installs the musl build of a platform package.
    if (/-(?:glibc|musl)$/.test(name)) assert.deepEqual(pkg.libc, [name.match(/-(glibc|musl)$/)[1]], name);
  }

  const rules = readBb(".dockerignore").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  assert.equal(rules.shift(), "**", "image context starts closed");
  const admitted = rules.map(rule => { assert.match(rule, /^![A-Za-z0-9][A-Za-z0-9._-]*$/); return rule.slice(1); });
  const copied = instructions.filter(line => line.startsWith("COPY")).flatMap(line => {
    const tokens = line.split(/\s+/).slice(1);
    assert.ok(tokens.every(token => !token.startsWith("--")), "plain COPY from the context only");
    return tokens.slice(0, -1);
  });
  assert.deepEqual(copied.sort(), ["package-lock.json", "package.json"]);
  assert.deepEqual(admitted.sort(), ["Dockerfile", ...copied].sort(), "relay.mjs and everything else stay out of the image");
});

test("acceptance with the bb fragment refuses a non-loopback listener and a published port; and without the fragment refuses AGENT_BB", async () => {
  const { inspectAgent: inspectOnHost, listenerCheck, agentEnvironment } = await import("../container/agent/accept.mjs");
  const inspectAgent = (info, env, image) => inspectOnHost(info, env, image, undefined, source => source);
  const { env, image, inspected } = acceptanceFixture();
  const bbEnv = {...env, AGENT_BB: "1"}, withBb = structuredClone(inspected);
  withBb.Config.Env.push("AGENT_BB=1");
  assert.doesNotThrow(() => inspectAgent(withBb, bbEnv, image), "the fragment's entry is the one admitted difference");
  assert.deepEqual(agentEnvironment(image.Config.Env, false, true), [...image.Config.Env, "AGENT_BB=1"]);
  const published = structuredClone(withBb);
  published.HostConfig.PortBindings = {"38886/tcp": [{HostIp: "127.0.0.1", HostPort: "38886"}]};
  assert.throws(() => inspectAgent(published, bbEnv, image), /published ports/);
  for (const mutate of [
    v => { v.Config.Env.pop(); },
    v => { v.Config.Env[v.Config.Env.length - 1] = "AGENT_BB=true"; },
    v => { v.Config.Env.push("BB_DATA_DIR=/state/elsewhere"); },
    v => { v.Config.Env.push("CLAUDE_CODE_OAUTH_TOKEN=FIXTURE_VALUE_NEVER_REPORT"); },
    v => { v.Config.Env.push("AGENT_BB=1"); },
  ]) {
    const changed = structuredClone(withBb);
    mutate(changed);
    assert.throws(() => inspectAgent(changed, bbEnv, image), error => !error.message.includes("FIXTURE_VALUE_NEVER_REPORT"));
  }
  assert.throws(() => inspectAgent(withBb, env, image), /AGENT_BB is set in the container/, "without the fragment");
  assert.throws(() => inspectAgent(withBb, {...env, AGENT_BB: ""}, image), /AGENT_BB is set in the container/);
  const baked = structuredClone(image);
  baked.Config.Env.push("AGENT_BB=1");
  assert.throws(() => inspectAgent(withBb, env, baked), /AGENT_BB is set in the container/, "an image cannot switch bb on by itself");
  for (const value of ["0", "true", "yes"]) assert.throws(() => inspectAgent(withBb, {...env, AGENT_BB: value}, image), /AGENT_BB must be 1/);

  // /proc/net/tcp as a little-endian kernel prints it: 08AE is 2222, 97E6 and 97E7 are bb's 38886 and 38887.
  const row = (local, state = "0A") => `   0: ${local} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 20001        0 1234 1 0000000000000000 100 0 0 10 0`;
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const proc = (v4, v6) => ({readFileSync(path) {
    if (path === "/proc/net/tcp") return [header, ...v4.map(entry => row(...[].concat(entry)))].join("\n") + "\n";
    assert.equal(path, "/proc/net/tcp6");
    if (!v6) throw Object.assign(new Error("IPv6 is off"), {code: "ENOENT"});
    return [header, ...v6.map(entry => row(entry))].join("\n") + "\n";
  }});
  const team = ["00000000:08AE", "0100007F:97E6", "0100007F:97E7"];
  assert.equal(listenerCheck(proc(team), "LE"), "listening TCP sockets: 0.0.0.0:2222, 127.0.0.1:38886, 127.0.0.1:38887; all on loopback except sshd's port 2222");
  assert.doesNotThrow(() => listenerCheck(proc([...team, "0500007F:1F90", ["020011AC:1F90", "01"]], ["00000000000000000000000000000000:08AE", "00000000000000000000000001000000:1F90", "0000000000000000FFFF00000100007F:1F91"]), "LE"),
    "any loopback listener, sshd on every address and a non-listening socket are admitted");
  for (const [v4, v6] of [
    [[...team, "00000000:97E6"]], [[...team, "020011AC:97E6"]], [[...team, "00000000:1F90"]], [["0100007F:08AE", "00000000:97E6", "0100007F:97E7"]],
    [team, ["00000000000000000000000000000000:1F90"]], [team, ["000080FE00000000000000000100000A:97E6"]], [team, ["0000000000000000FFFF0000020011AC:1F90"]],
  ]) assert.throws(() => listenerCheck(proc(v4, v6), "LE"), /listening beyond loopback: .*only sshd's port 2222 may/);
  assert.throws(() => listenerCheck(proc(["00000000:08AE", "0100007F:97E6"]), "LE"), /bb is not listening on 127\.0\.0\.1:38887/);
  assert.equal(listenerCheck(proc(["00000000:08AE", "7F000001:97E6", "7F000001:97E7"]), "BE"), "listening TCP sockets: 0.0.0.0:2222, 127.0.0.1:38886, 127.0.0.1:38887; all on loopback except sshd's port 2222");
  assert.throws(() => listenerCheck({readFileSync() { throw Object.assign(new Error("unreadable"), {code: "EACCES"}); }}, "LE"));
});

test("acceptance admits the bb fragment together with the inputs, outbox and trust fragments", async () => {
  const { inspectAgent: inspectOnHost } = await import("../container/agent/accept.mjs");
  const inspectAgent = (info, env, image) => inspectOnHost(info, env, image, undefined, source => source);
  const { env, image, inspected } = acceptanceFixture();
  const all = structuredClone(inspected);
  const allEnv = {...env, AGENT_BB: "1", AGENT_CA_FILE: "/operator/public-ca.pem", TEAM_INPUT_DIR: "/operator/inputs", TEAM_OUTBOX_DIR: "/operator/outbox", TEAM_OUTBOX_GID: "20002"};
  all.Config.Env.push("SSL_CERT_FILE=/etc/agent-trust/ca.pem", "NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem", "AGENT_BB=1");
  for (const [source, target, rw] of [[allEnv.AGENT_CA_FILE, "/etc/agent-trust/ca.pem", false], [allEnv.TEAM_INPUT_DIR, "/inputs", false], [allEnv.TEAM_OUTBOX_DIR, "/outbox", true]]) {
    all.Mounts.push({Source: source, Destination: target, RW: rw, Type: "bind"});
    all.HostConfig.Mounts.push({Type: "bind", Source: source, Target: target, ReadOnly: !rw, BindOptions: {}});
  }
  all.HostConfig.GroupAdd = [allEnv.TEAM_OUTBOX_GID];
  assert.doesNotThrow(() => inspectAgent(all, allEnv, image));
  // Each fragment is still required on its own terms beside the others.
  const withoutBb = {...allEnv};
  delete withoutBb.AGENT_BB;
  assert.throws(() => inspectAgent(all, withoutBb, image), /AGENT_BB is set in the container/);
  for (const name of ["AGENT_CA_FILE", "TEAM_INPUT_DIR", "TEAM_OUTBOX_DIR"]) {
    const missing = {...allEnv};
    delete missing[name];
    assert.throws(() => inspectAgent(all, missing, image), name);
  }
  const noEntry = structuredClone(all);
  noEntry.Config.Env.pop();
  assert.throws(() => inspectAgent(noEntry, allEnv, image), /environment names differing/);
});
