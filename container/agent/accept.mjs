import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { childDeclarationFile, childDeclarationMaxBytes, parseChildDeclaration } from "./supervisor.mjs";

function required(env, name) {
  assert.ok(env[name], `set ${name} to the reviewed Compose value`);
  return env[name];
}

const ids = (env) => ({ uid: env.AGENT_UID || "20001", gid: env.AGENT_GID || "20001" });

// The acceptance host says which declared child the deployment switched on:
// AGENT_CHILD=<name>, the one entry a derived image's fragment sets. Nothing
// else selects it. Answers the name, or null.
export function childSelected(env) {
  if (env.AGENT_CHILD === undefined || env.AGENT_CHILD === "") return null;
  assert.match(env.AGENT_CHILD, /^[a-z0-9-]{1,20}$/, "AGENT_CHILD must be the declared child's name (1 to 20 lowercase letters, digits or dashes) or unset");
  return env.AGENT_CHILD;
}

// The optional public-CA mount and the child switch's one entry are the only
// deployment environment exceptions.
// Both trust settings reach the broker before it starts, including its Node child.
export function agentEnvironment(imageEnv, publicCA = false, child = null) {
  const fixed = [...(publicCA ? ["SSL_CERT_FILE=/etc/agent-trust/ca.pem", "NODE_EXTRA_CA_CERTS=/etc/agent-trust/ca.pem"] : []), ...(child ? [`AGENT_CHILD=${child}`] : [])];
  if (!fixed.length) return imageEnv;
  const names = fixed.map(entry => entry.split("=", 1)[0]);
  return [...imageEnv.filter(entry => !names.includes(entry.split("=", 1)[0])), ...fixed];
}

// Compare only reviewed settings, never dump Config.Env or credential contents.
// Run on the Docker engine host: containment needs that host's real paths.
export function inspectAgent(info, env, image, defaultRuntime = "runc", hostPath = realpathSync) {
  const evidence = [];
  const equal = (name, actual, expected) => {
    assert.deepEqual(actual, expected, name);
    evidence.push(`${name}: ${JSON.stringify(actual)}`);
  };
  const { uid, gid } = ids(env);
  assert.match(uid, /^[1-9]\d*$/, "non-root AGENT_UID");
  assert.match(gid, /^[1-9]\d*$/, "non-root AGENT_GID");
  equal("running", info.State.Running, true);
  equal("reviewed image reference", info.Config.Image, required(env, "AGENT_IMAGE"));
  assert.ok(image?.Id, "reviewed image ID is required");
  equal("reviewed image ID", info.Image, image.Id);
  for (const key of ["Entrypoint", "Cmd"]) {
    assert.ok(isDeepStrictEqual(info.Config[key] ?? null, image.Config[key] ?? null), key + " differs from reviewed image (arguments withheld)");
    evidence.push(key + " matches reviewed image (arguments withheld)");
  }
  equal("uid:gid", info.Config.User, `${uid}:${gid}`);
  equal("stable cache-lock hostname", info.Config.Hostname, "oats-agent");
  const h = info.HostConfig;
  equal("capabilities dropped", h.CapDrop, ["ALL"]);
  equal("capabilities added", h.CapAdd || [], []);
  equal("security options (default seccomp/AppArmor retained)", h.SecurityOpt, ["no-new-privileges:true"]);
  equal("read-only root", h.ReadonlyRootfs, true);
  equal("privileged", h.Privileged, false);
  equal("host PID namespace", h.PidMode || "", "");
  equal("IPC namespace", h.IpcMode, "private");
  assert.ok(typeof defaultRuntime === "string" && defaultRuntime.length > 0, "Docker default OCI runtime is required");
  equal("OCI runtime", h.Runtime, defaultRuntime);
  equal("OOM killer disabled", !!h.OomKillDisable, false);
  equal("device cgroup rules", h.DeviceCgroupRules || [], []);
  equal("shared memory size", h.ShmSize, 67108864);
  const outboxGid = env.TEAM_OUTBOX_DIR ? required(env, "TEAM_OUTBOX_GID") : null;
  if (outboxGid !== null) {
    assert.match(outboxGid, /^[1-9]\d*$/, "TEAM_OUTBOX_GID must be a non-root numeric GID");
    assert.ok(Number(outboxGid) < 4294967295 && outboxGid !== gid, "TEAM_OUTBOX_GID must be a dedicated GID distinct from AGENT_GID");
  } else assert.ok(!env.TEAM_OUTBOX_GID, "TEAM_OUTBOX_GID requires TEAM_OUTBOX_DIR and the outbox fragment");
  equal("supplementary groups added", h.GroupAdd || [], outboxGid === null ? [] : [outboxGid]);
  equal("user namespace override", h.UsernsMode || "", "");
  equal("UTS namespace override", h.UTSMode || "", "");
  equal("cgroup namespace", h.CgroupnsMode, "private");
  equal("sysctls", h.Sysctls || {}, {});
  equal("published ports", h.PortBindings || {}, {});
  equal("publish all ports", !!h.PublishAllPorts, false);
  equal("extra hosts", h.ExtraHosts || [], []);
  equal("DNS override", h.Dns || [], []);
  const network = required(env, "AGENTS_NETWORK");
  equal("network mode", h.NetworkMode, network);
  equal("attached networks", Object.keys(info.NetworkSettings.Networks), [network]);
  equal("agent IP", info.NetworkSettings.Networks[network].IPAddress, required(env, "AGENT_IP"));
  const names = (entries) => entries.map((entry) => entry.split("=", 1)[0]);
  assert.ok(Array.isArray(image?.Config?.Env), "image environment baseline is required");
  const child = childSelected(env);
  const actualEnv = info.Config.Env || [], expectedEnv = agentEnvironment(image.Config.Env, !!env.AGENT_CA_FILE, child);
  // The removed switch is refused whoever set it, and so is an image that sets
  // the switch itself: the declaration is the image's, the switch the deployment's.
  assert.ok(!names(actualEnv).includes("AGENT_BB"), "AGENT_BB is set in the container: it is gone; recreate the container with an image that declares its child and AGENT_CHILD");
  assert.ok(!names(image.Config.Env).includes("AGENT_CHILD"), "the image sets AGENT_CHILD itself: only the deployment's Compose fragment may");
  if (!child) assert.ok(!names(actualEnv).includes("AGENT_CHILD"), "AGENT_CHILD is set in the container: export the same AGENT_CHILD for acceptance, or recreate the container without it");
  const allNames = new Set([...names(actualEnv), ...names(expectedEnv)]);
  const entriesFor = (entries, name) => entries.filter((entry) => entry.split("=", 1)[0] === name).sort();
  const changedNames = [...allNames].filter((name) => !isDeepStrictEqual(entriesFor(actualEnv, name), entriesFor(expectedEnv, name)));
  equal("environment names differing from reviewed image (values withheld)", changedNames.sort(), []);
  equal("devices", h.Devices || [], []);
  equal("device requests", h.DeviceRequests || [], []);
  const tmpSize = required(env, "AGENT_TMP_SIZE");
  assert.match(tmpSize, /^[1-9]\d*$/, "AGENT_TMP_SIZE must be positive bytes");
  assert.ok(Number.isSafeInteger(Number(tmpSize)), "AGENT_TMP_SIZE must be safe integer bytes");
  equal("tmpfs", h.Tmpfs, { "/tmp": `rw,nosuid,nodev,size=${tmpSize},mode=1777` });
  equal("restart policy", h.RestartPolicy.Name, "unless-stopped");
  equal("stop grace period (seconds)", info.Config.StopTimeout, 50);
  equal("healthcheck (sshd on 2222)", info.Config.Healthcheck, { Test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/2222"], Interval: 30e9, Timeout: 5e9, StartPeriod: 10e9, Retries: 3 });
  const pids = Number(required(env, "AGENT_PIDS"));
  assert.ok(Number.isSafeInteger(pids) && pids > 0, "positive AGENT_PIDS");
  equal("pids limit", h.PidsLimit, pids);
  const memory = required(env, "AGENT_MEMORY").match(/^(\d+(?:\.\d+)?)([bkmg]?)(?:b)?$/i);
  assert.ok(memory, "AGENT_MEMORY must use bytes, k, m or g");
  const bytes = Number(memory[1]) * (1024 ** ({ "": 0, b: 0, k: 1, m: 2, g: 3 }[memory[2].toLowerCase()]));
  assert.ok(bytes > 0, "positive AGENT_MEMORY");
  equal("memory limit", h.Memory, bytes);
  equal("memory + swap (Docker default if absent)", h.MemorySwap ?? 2 * bytes, 2 * bytes);
  const nanos = Math.round(Number(required(env, "AGENT_CPUS")) * 1e9);
  assert.ok(nanos > 0, "positive AGENT_CPUS");
  equal("CPU limit", h.NanoCpus, nanos);
  const mounts = [
    ["TEAM_STATE_DIR", "/state", true],
    ["TEAM_LOGIN_DIR", "/etc/agent-login", false],
    ["AUTHORIZED_KEYS_FILE", "/etc/agent-ssh/authorized_keys", false],
    ["RESOLV_CONF_FILE", "/etc/resolv.conf", false],
    ...(env.AGENT_CA_FILE ? [["AGENT_CA_FILE", "/etc/agent-trust/ca.pem", false]] : []),
    ...(env.AGENT_MIRRORS_DIR ? [["AGENT_MIRRORS_DIR", "/mirrors", false]] : []),
    ...(env.TEAM_INPUT_DIR ? [["TEAM_INPUT_DIR", "/inputs", false]] : []),
    ...(env.TEAM_OUTBOX_DIR ? [["TEAM_OUTBOX_DIR", "/outbox", true]] : []),
    ...(env.TEAM_WORK_DIR ? [["TEAM_WORK_DIR", "/work", true]] : []),
    ...(env.TEAM_CREDENTIALS_DIR ? [["TEAM_CREDENTIALS_DIR", "/etc/agent-credentials", false]] : []),
  ].map(([name, target, rw]) => {
    const source = required(env, name);
    assert.ok(source.startsWith("/"), `${name} must be absolute`);
    assert.ok(!source.includes("docker.sock"), "no Docker socket source");
    return { source: resolve(source), target, rw, type: "bind" };
  });
  // A credential group's directory is one person's credential: it shares no source with anything an agent writes,
  // nor with the inputs every agent of the group reads.
  for (const input of mounts.filter(m => m.target === "/etc/agent-trust/ca.pem" || m.target === "/mirrors" || m.target === "/inputs" || m.target === "/outbox" || m.target === "/etc/agent-credentials")) {
    const credentials = input.target === "/etc/agent-credentials";
    for (const writable of mounts.filter(m => m.target !== input.target && (m.rw || input.target === "/outbox" || (credentials && m.target === "/inputs")))) {
      let source, protectedSource;
      try { source = hostPath(input.source); protectedSource = hostPath(writable.source); }
      catch { assert.fail(credentials ? "credentials require resolvable Docker-host sources (paths withheld)" : "optional inputs and outbox require resolvable Docker-host sources (paths withheld)"); }
      const overlaps = source === protectedSource || source.startsWith(protectedSource.endsWith("/") ? protectedSource : protectedSource + "/")
        || protectedSource.startsWith(source.endsWith("/") ? source : source + "/");
      assert.ok(!overlaps, credentials ? "credentials must stay outside agent-writable sources, /inputs and /outbox" : "optional inputs and outbox must stay outside agent-writable sources");
    }
  }
  equal("writable bind destinations", info.Mounts.filter(m => m.Type === "bind" && m.RW).map(m => m.Destination).sort(),
    ["/state", ...(env.TEAM_WORK_DIR ? ["/work"] : []), ...(env.TEAM_OUTBOX_DIR ? ["/outbox"] : [])].sort());
  const sort = (v) => v.sort((a, b) => a.target.localeCompare(b.target));
  equal("exact approved mounts (no extra home, socket or service-account mount)", sort(info.Mounts.map((m) => ({ source: m.Source, target: m.Destination, rw: m.RW, type: m.Type }))), sort(mounts));
  equal("legacy auto-creating binds", h.Binds || [], []);
  equal("binds fail on missing host paths", sort((h.Mounts || []).map((m) => ({ source: m.Source, target: m.Target, rw: !m.ReadOnly, type: m.Type, create_host_path: !!m.BindOptions?.CreateMountpoint }))), sort(mounts.map((m) => ({ ...m, create_host_path: false }))));
  return evidence;
}

// Serialized and executed by docker exec as the configured runtime UID.
export function resolverCheck(fs = require("node:fs"), path = "/etc/resolv.conf") {
  try {
    if (fs.readFileSync(path).length === 0) throw new Error("empty resolver");
  } catch {
    throw Object.assign(new Error("E_AGENT_RESOLVER: /etc/resolv.conf must be readable and non-empty by the runtime UID"), { code: "E_AGENT_RESOLVER" });
  }
  return "resolver readable and non-empty by runtime UID";
}

function runtimeCheck(uid, gid, outboxGid) {
  const fs = require("node:fs");
  const assert = require("node:assert/strict");
  const status = fs.readFileSync("/proc/self/status", "utf8");
  assert.equal(process.getuid(), Number(uid));
  assert.equal(process.getgid(), Number(gid));
  assert.match(status, new RegExp(`^Gid:\\s+${gid}\\s+${gid}\\s+${gid}\\s+${gid}$`, "m"));
  const groups = status.match(/^Groups:[\t ]*(.*)$/m);
  assert.ok(groups, "process supplementary groups are required");
  const actualGroups = groups[1].trim().split(/\s+/).filter(Boolean);
  assert.ok(actualGroups.every(group => group === gid || group === outboxGid), "only primary and approved outbox groups are allowed");
  if (outboxGid) assert.ok(actualGroups.includes(outboxGid), "outbox supplementary group is required");
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  console.log(`process uid=${process.getuid()} gid=${process.getgid()}; ${status.match(/^Gid:.*$/m)[0]}; ${status.match(/^Groups:.*$/m)[0]}; CapEff=0; NoNewPrivs=1`);
  const pid = fs.readFileSync("/tmp/agent-sshd.pid", "utf8").trim();
  assert.match(pid, /^\d+$/);
  const daemon = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  assert.match(daemon, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
  if (outboxGid) {
    const daemonGroups = daemon.match(/^Groups:[\t ]*(.*)$/m);
    assert.ok(daemonGroups, "sshd supplementary groups are required");
    const actualDaemonGroups = daemonGroups[1].trim().split(/\s+/).filter(Boolean);
    assert.ok(actualDaemonGroups.includes(outboxGid) && actualDaemonGroups.every(group => group === gid || group === outboxGid),
      "sshd requires the approved outbox group and no extra groups");
  }
  assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"), /sshd/);
  console.log(`sshd pid=${pid}; ${daemon.match(/^Uid:.*$/m)[0]}`);
  for (const path of ["/state", "/state/home", "/state/ssh", "/state/deploy"]) {
    const st = fs.statSync(path);
    assert.equal(st.mode & 0o777, 0o700, path);
    assert.equal(st.uid, Number(uid), path);
    console.log(`${path}: uid=${st.uid} mode=0700`);
  }
  const net = require("node:net");
  const socket = net.connect(2222, "127.0.0.1");
  socket.setTimeout(5000, () => { console.error("SSH banner timed out"); process.exit(1); });
  socket.once("data", (chunk) => { assert.match(chunk.toString(), /^SSH-2\.0-OpenSSH_/); console.log(`SSH banner: ${chunk.toString().trim()}`); socket.destroy(); });
  socket.once("error", (err) => { console.error(err.message); process.exit(1); });
}

// Serialized inside the agent, with AGENT_CHILD only: the supervisor's own
// checks of the declaration file, on the running container. Answers its text.
export function declarationCheck(path, maxBytes, fs = require("node:fs")) {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > maxBytes) throw new Error("invalid file");
    let writable = true;
    try { fs.accessSync(path, fs.constants.W_OK); }
    catch (error) { if (error.code === "EROFS" || error.code === "EACCES") writable = false; else throw error; }
    if (writable) throw new Error("writable declaration");
    return fs.readFileSync(path, "utf8");
  } catch { throw new Error(path + " must be a regular file owned by root, not a symlink, not writable by its group, by others or by the agent, and at most " + maxBytes + " bytes (contents withheld)"); }
}

// Serialized inside the agent, with AGENT_CHILD only: what the image recorded
// as its child's version at build time. One short printable line, or refused.
export function versionFileCheck(path, fs = require("node:fs")) {
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size > 256) throw new Error("invalid file");
    return fs.readFileSync(path, "utf8");
  } catch { throw new Error("the declared version file must be a readable regular file of at most 256 bytes (contents withheld)"); }
}

// Serialized inside the agent, with AGENT_CHILD only. /proc/net lists every
// listening socket of the container's network namespace, whoever owns it.
// A declared child's ports carry no login of their own, so every declared port
// must listen on loopback and nothing but sshd may listen beyond it.
export function listenerCheck(ports, fs = require("node:fs"), endianness = require("node:os").endianness()) {
  // The kernel prints each 32-bit word of an address in host byte order.
  const bytes = (hex) => (hex.match(/.{8}/g) || []).flatMap((word) => {
    const pairs = word.match(/../g).map((pair) => parseInt(pair, 16));
    return endianness === "LE" ? pairs.reverse() : pairs;
  });
  const listeners = [];
  for (const [file, length] of [["/proc/net/tcp", 8], ["/proc/net/tcp6", 32]]) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); }
    catch (error) { if (length === 32 && error.code === "ENOENT") continue; throw error; } // IPv6 is off
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) continue;
      if (fields[3] !== "0A") continue; // TCP_LISTEN
      const local = fields[1].match(/^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/);
      if (!local || local[1].length !== length) throw new Error("unreadable listening socket entry");
      const address = bytes(local[1]), port = parseInt(local[2], 16);
      const mapped = length === 32 && address.slice(0, 10).every((byte) => byte === 0) && address[10] === 255 && address[11] === 255;
      const v4 = length === 8 ? address : mapped ? address.slice(12) : null;
      const loopback = v4 ? v4[0] === 127 : address.slice(0, 15).every((byte) => byte === 0) && address[15] === 1;
      const name = v4 ? v4.join(".") : "[" + address.map((byte) => byte.toString(16).padStart(2, "0")).join("").replace(/(.{4})(?=.)/g, "$1:") + "]";
      listeners.push({ name: name + ":" + port, port, loopback });
    }
  }
  const exposed = listeners.filter((listener) => !listener.loopback && listener.port !== 2222).map((listener) => listener.name);
  if (exposed.length) throw new Error("listening beyond loopback: " + exposed.join(", ") + " (only sshd's port 2222 may)");
  for (const port of ports) {
    if (!listeners.some((listener) => listener.port === port && listener.loopback)) throw new Error("the declared child is not listening on loopback port " + port);
  }
  return "listening TCP sockets: " + listeners.map((listener) => listener.name).sort().join(", ") + "; all on loopback except sshd's port 2222";
}

// Serialized inside the agent: CA bytes are public, but private-key mistakes
// and parser diagnostics must never be copied into acceptance output.
export function publicCACheck(fs = require("node:fs"), { X509Certificate } = require("node:crypto")) {
  const path = "/etc/agent-trust/ca.pem";
  try {
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size > 65536 || stat.nlink > 1) throw new Error("invalid file");
    const pem = fs.readFileSync(path,"utf8");
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (!certificates.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,"").trim()
      || certificates.some(certificate => !new X509Certificate(certificate).ca)) throw new Error("invalid certificates");
    let writable = true;
    try { fs.accessSync(path,fs.constants.W_OK); }
    catch (error) { if (error.code === "EROFS" || error.code === "EACCES") writable = false; else throw error; }
    if (writable) throw new Error("writable trust");
    return "public CA: valid read-only CA certificates; contents withheld";
  } catch { throw new Error("public CA must contain only valid read-only CA certificates (contents withheld)"); }
}

export function mirrorsCheck(fs = require("node:fs")) {
  const root = "/mirrors";
  const probe = `${root}/.oats-read-only-probe-${process.pid}`;
  try {
    if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
    fs.readdirSync(root);
    let wrote = false;
    try { fs.writeFileSync(probe,"probe",{flag:"wx",mode:0o600}); wrote = true; }
    catch (error) { if (error.code !== "EROFS" && error.code !== "EACCES") throw error; }
    if (wrote) { fs.unlinkSync(probe); throw new Error("writable mirrors"); }
    return "mirrors: readable read-only directory; source freshness is operator-qualified";
  } catch { throw new Error("mirrors must be a readable read-only directory (contents withheld)"); }
}

// Serialized inside the container: input names and filesystem diagnostics stay private.
export function inputsCheck(enabled, fs = require("node:fs")) {
  const root = "/inputs";
  try {
    if (!enabled) {
      try { fs.lstatSync(root); }
      catch (error) {
        if (error.code === "ENOENT") return "inputs: absent without the optional fragment";
        throw error;
      }
      throw new Error("unexpected inputs");
    }
    if (!fs.statSync(root).isDirectory()) throw new Error("not a directory");
    fs.readdirSync(root);
    const probe = `${root}/.oats-read-only-probe-${process.pid}`;
    let wrote = false;
    try { fs.writeFileSync(probe, "probe", {flag: "wx", mode: 0o600}); wrote = true; }
    catch (error) { if (error.code !== "EROFS" && error.code !== "EACCES") throw error; }
    if (wrote) { fs.unlinkSync(probe); throw new Error("writable inputs"); }
    return "inputs: readable read-only directory; contents withheld";
  } catch { throw new Error("inputs must match the optional readable read-only directory (contents withheld)"); }
}

export function outboxCheck(enabled, uid, gid, fs = require("node:fs")) {
  try {
    if (!enabled) {
      try { fs.lstatSync("/outbox"); }
      catch (error) {
        if (error.code === "ENOENT") return "outbox: absent without the optional fragment";
        throw error;
      }
      throw new Error("unexpected outbox");
    }
    const root = fs.statSync("/outbox"), state = fs.statSync("/state");
    if (!root.isDirectory() || root.uid !== Number(uid) || root.gid !== Number(gid)
      || (root.mode & 0o7777) !== 0o2750 || !state.isDirectory() || (state.mode & 0o7777) !== 0o700) {
      throw new Error("queue or state metadata");
    }
    const probe = `/outbox/.oats-write-probe-${process.pid}`;
    fs.writeFileSync(probe, "probe", {flag: "wx", mode: 0o600});
    try {
      if (fs.statSync(probe).gid !== Number(gid)) throw new Error("probe group");
    } finally { fs.unlinkSync(probe); }
    return `outbox: setgid queue writable with group ${gid}; state remains private`;
  } catch { throw new Error("outbox must match the optional setgid writable queue with private state (contents withheld)"); }
}

// Serialized inside the container as the runtime user: a credential group's directory, written only by
// oats-login-receive --credential. Names and contents stay private; no file is opened.
export function credentialsCheck(enabled, gid, fs = require("node:fs")) {
  const root = "/etc/agent-credentials";
  const refuse = (reason) => { throw new Error(`credentials must be a read-only root:${gid} 0750 directory of root:${gid} 0440 files: ${reason} (names and contents withheld)`); };
  let directory;
  try { directory = fs.lstatSync(root); }
  catch (error) {
    if (error.code === "ENOENT" && !enabled) return "credentials: absent without the optional fragment";
    refuse(error.code === "ENOENT" ? "absent" : "unreadable");
  }
  if (!enabled) refuse("present without the optional fragment");
  if (!directory.isDirectory()) refuse("not a directory");
  if (directory.uid !== 0 || directory.gid !== Number(gid)) refuse("directory owner");
  if ((directory.mode & 0o7777) !== 0o750) refuse("directory mode");
  let names;
  try { names = fs.readdirSync(root); }
  catch { refuse("directory unreadable"); }
  for (const name of names) {
    const path = `${root}/${name}`;
    let file;
    try { file = fs.lstatSync(path); }
    catch { refuse("file unreadable"); }
    if (!file.isFile()) refuse("not a regular file");
    if (file.uid !== 0 || file.gid !== Number(gid)) refuse("file owner");
    if ((file.mode & 0o7777) !== 0o440) refuse("file mode");
    let writable = true;
    try { fs.accessSync(path, fs.constants.W_OK); }
    catch (error) {
      if (error.code !== "EROFS" && error.code !== "EACCES") refuse("file unreadable");
      writable = false;
    }
    if (writable) refuse("writable file");
  }
  const probe = `${root}/.oats-read-only-probe-${process.pid}`;
  let wrote = false;
  try { fs.writeFileSync(probe, "probe", {flag: "wx", mode: 0o600}); wrote = true; }
  catch (error) { if (error.code !== "EROFS" && error.code !== "EACCES") refuse("write probe failed"); }
  if (wrote) { fs.unlinkSync(probe); refuse("writable directory"); }
  return `credentials: read-only root:${gid} 0750 directory; ${names.length} root:${gid} 0440 file(s); names and contents withheld`;
}

// Validate the mount even before a token is provisioned; never create a placeholder.
export function tokenCheck(gid, strict) {
  const fs = require("node:fs"), assert = require("node:assert/strict");
  const dir = fs.statSync("/etc/agent-login");
  assert.ok(dir.isDirectory(), "login mount must be a directory");
  if (strict) {
    assert.equal(dir.uid, 0); assert.equal(dir.gid, Number(gid)); assert.equal(dir.mode & 0o777, 0o750);
  }
  const evidence = [`PASS login directory: uid=${dir.uid} gid=${dir.gid} mode=${(dir.mode & 0o777).toString(8)}`];
  const token = "/etc/agent-login/claude-token";
  let st;
  try { st = fs.lstatSync(token); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { present: false, evidence: [...evidence, "NOT RUN: setup-token file absent"] };
  }
  assert.ok(st.isFile(), "token must be a regular file");
  fs.accessSync(token, fs.constants.R_OK);
  assert.throws(() => fs.accessSync(token, fs.constants.W_OK), "token must not be writable");
  if (strict) {
    assert.equal(st.uid, 0); assert.equal(st.gid, Number(gid)); assert.equal(st.mode & 0o777, 0o440);
  }
  evidence.push(`PASS setup-token file: readable, not writable; uid=${st.uid} gid=${st.gid} mode=${(st.mode & 0o777).toString(8)}; contents not read`);
  return { present: true, evidence };
}

function credentialScan(roots, excluded = []) {
  const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
  let files = 0;
  const found = [];
  function walk(dir) {
    if (excluded.includes(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.name === ".credentials.json") found.push(file);
      if (entry.isDirectory()) walk(file);
      files++;
    }
  }
  for (const dir of roots) { if (fs.existsSync(dir)) walk(dir); }
  assert.deepEqual(found, [], "forbidden /login credential files (paths only)");
  console.log(`no .credentials.json: searched ${roots.join(", ")}${excluded.length ? ` excluding ${excluded.join(", ")}` : ""}; ${files} entries; no contents read`);
}

export function main(args, env, { spawnSync: run = spawnSync } = {}) {
  const container = args.shift();
  let label, home;
  while (args.length) {
    const option = args.shift();
    if (option === "--evidence") label = args.shift();
    else if (option === "--claude") home = args.shift();
    else throw new Error(`unknown option ${option}`);
  }
  assert.ok(container && !container.startsWith("-"), "usage: accept.sh CONTAINER --evidence local|target-amd64|live-lab [--claude /state/deploy/.../instance-home]");
  assert.ok(["local", "target-amd64", "live-lab"].includes(label), "an explicit --evidence label is required");
  const report = (s) => console.log(`[${label}] ${s}`);
  const docker = (argv, input, timeout = 60000) => {
    const r = run("docker", argv, { encoding: "utf8", input, timeout, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, 0, `docker ${argv[0]} failed: ${r.error?.message || r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  const info = JSON.parse(docker(["inspect", container]))[0];
  const image = JSON.parse(docker(["image", "inspect", "--", required(env, "AGENT_IMAGE")]))[0];
  const defaultRuntime = docker(["info", "--format", "{{.DefaultRuntime}}"]);
  for (const line of inspectAgent(info, env, image, defaultRuntime)) report(`PASS ${line}`);
  const { uid, gid } = ids(env);
  const program = (fn, params, root = false) => docker(["exec", "-i", ...(root ? ["--user", "0:0"] : []), container, "node"], `const result = (${fn.toString()})(${params.map((p) => JSON.stringify(p)).join(",")}); if (result !== undefined) console.log(JSON.stringify(result));`);
  const arch = docker(["exec", container, "node", "-p", "process.arch"]);
  if (label !== "local") assert.equal(arch, "x64", "target evidence requires amd64");
  report(`PASS architecture=${arch}; image=${info.Image}`);
  report(`PASS ${program(runtimeCheck, [uid, gid, env.TEAM_OUTBOX_DIR ? env.TEAM_OUTBOX_GID : null]).replaceAll("\n", `\n[${label}] PASS `)}`);
  report(`PASS ${JSON.parse(program(resolverCheck, []))}`);
  const token = JSON.parse(program(tokenCheck, [gid, label !== "local"]));
  for (const line of token.evidence) report(line);
  if (env.AGENT_CA_FILE) report(`PASS ${JSON.parse(program(publicCACheck, []))}`);
  if (env.AGENT_MIRRORS_DIR) report(`PASS ${JSON.parse(program(mirrorsCheck, []))}`);
  const child = childSelected(env);
  if (child) {
    // The declaration is read from the running container, never from a checkout.
    let declared;
    try { declared = parseChildDeclaration(JSON.parse(program(declarationCheck, [childDeclarationFile, childDeclarationMaxBytes]))); }
    catch (error) { assert.fail(`${childDeclarationFile}: ${error.message}`); }
    assert.equal(declared.name, child, `${childDeclarationFile}: name differs from AGENT_CHILD`);
    report(`PASS ${childDeclarationFile}: root-owned regular file, not a symlink, not writable by group, others or the agent; declares ${child}`);
    report(`PASS ${JSON.parse(program(listenerCheck, [declared.listen]))}`);
    const recorded = JSON.parse(program(versionFileCheck, [declared.version.file])).trim();
    assert.match(recorded, /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/, "the declared version file must hold one printable line of at most 64 characters (contents withheld)");
    // Run directly: the shared helper would print a failed command's raw output.
    const printed = run("docker", ["exec", container, ...declared.version.command], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
    assert.ok(printed.status === 0 && typeof printed.stdout === "string" && printed.stdout.trim() === recorded, "the declared version command must exit 0 and print exactly the content of the declared version file (output withheld)");
    report(`PASS ${child}: version ${recorded} (the declared command prints the image's version file)`);
  }
  report(`PASS ${JSON.parse(program(inputsCheck, [!!env.TEAM_INPUT_DIR]))}`);
  report(`PASS ${JSON.parse(program(outboxCheck, [!!env.TEAM_OUTBOX_DIR, uid, env.TEAM_OUTBOX_GID || null]))}`);
  report(`PASS ${JSON.parse(program(credentialsCheck, [!!env.TEAM_CREDENTIALS_DIR, gid]))}`);
  report(`PASS ${program(credentialScan, [["/"], ["/proc", "/sys", "/dev", "/state", "/tmp", "/run", "/work", "/inputs", "/outbox"]], true)}`);
  const writableRoots = [...(env.TEAM_OUTBOX_DIR ? ["/outbox"] : []), "/state", "/tmp", "/run", "/work", "/dev/shm", "/dev/mqueue"];
  report(`PASS ${program(credentialScan, [[...writableRoots, ...(env.TEAM_INPUT_DIR ? ["/inputs"] : [])]])}`);
  const denied = docker(["exec", container, "sh", "-eu", "-c", `
    test "$(npm prefix -g)" = /usr/local
    probe=$(mktemp -d /tmp/oats-npm-probe.XXXXXX)
    trap 'rm -rf "$probe"' EXIT
    printf '{"name":"oats-container-write-probe","version":"1.0.0"}\\n' > "$probe/package.json"
    if npm install -g --offline --ignore-scripts --no-audit --no-fund "$probe" > "$probe/result" 2>&1; then
      echo 'global npm install unexpectedly succeeded' >&2; exit 1
    fi
    cat "$probe/result"
    grep -Eq 'EACCES|EROFS' "$probe/result"
    grep -q /usr/local "$probe/result"
  `]);
  report(`PASS global npm install refused (offline local package):\n${denied.split("\n").map((s) => `[${label}] ${s}`).join("\n")}`);
  for (const [cli, argv] of [["oats", ["version", "--json"]], ["aw", ["version"]], ["claude", ["--version"]]]) {
    const output = docker(["exec", container, cli, ...argv]);
    report(`PASS ${cli}: ${cli === "oats" ? JSON.parse(output).version : output.replaceAll("\n", `\n[${label}] `)}`);
  }
  if (home) assert.ok(home.startsWith("/state/deploy/") && !home.includes("\n"), "--claude requires an instance home under /state/deploy");
  if (home && token.present) {
    // Keep project hooks/instructions away from the named live instance.
    // Never record Claude's raw output: authentication failures may echo data.
    const r = run("docker", ["exec", container, "sh", "-eu", "-c", `
      test -f "$1/instance.json"
      probe=$(mktemp -d /tmp/oats-claude-probe.XXXXXX)
      trap 'rm -rf "$probe"' EXIT
      cd "$probe"
      export CLAUDE_CODE_OAUTH_TOKEN="$(cat /etc/agent-login/claude-token)"
      claude -p --setting-sources user --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence 'Reply with exactly OATS_CONTAINER_AUTH_OK'
    `, "oats-claude-probe", home], { encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 });
    assert.ok(r.status === 0 && r.stdout.trim() === "OATS_CONTAINER_AUTH_OK", "claude -p did not return the expected response; raw output withheld");
    report(`PASS claude -p for ${home}: OATS_CONTAINER_AUTH_OK (scratch cwd; user settings only; token read only inside the process)`);
    report(`PASS ${program(credentialScan, [writableRoots])}`);
  } else report(`NOT RUN claude -p: ${token.present ? "requires --claude INSTANCE_HOME" : "setup-token file absent"}`);
  report("NOT RUN platform network/bypass, admitted-seat spawn, viewer, package sync, mail/chat and governance checks: collect their own live evidence; this is not a full section 12 receipt");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2), process.env); }
  catch (error) {
    const label = process.argv[process.argv.indexOf("--evidence") + 1];
    console.error(`[${["local", "target-amd64", "live-lab"].includes(label) ? label : "unlabelled"}] FAIL acceptance: ${error.message}`);
    process.exitCode = 1;
  }
}
