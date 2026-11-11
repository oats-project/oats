import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

function required(env, name) {
  assert.ok(env[name], `set ${name} to the reviewed Compose value`);
  return env[name];
}

const ids = (env) => ({ uid: env.AGENT_UID || "20001", gid: env.AGENT_GID || "20001" });

// Compare only reviewed settings, never dump Config.Env or credential contents.
export function inspectAgent(info, env, image, defaultRuntime = "runc") {
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
  equal("supplementary groups added", h.GroupAdd || [], []);
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
  const actualEnv = info.Config.Env || [], expectedEnv = image.Config.Env;
  const allNames = new Set([...names(actualEnv), ...names(expectedEnv)]);
  const entriesFor = (entries, name) => entries.filter((entry) => entry.split("=", 1)[0] === name).sort();
  const changedNames = [...allNames].filter((name) => !isDeepStrictEqual(entriesFor(actualEnv, name), entriesFor(expectedEnv, name)));
  equal("environment names differing from reviewed image (values withheld)", changedNames.sort(), []);
  equal("devices", h.Devices || [], []);
  equal("device requests", h.DeviceRequests || [], []);
  equal("tmpfs", h.Tmpfs, { "/tmp": "rw,nosuid,nodev,mode=1777" });
  equal("restart policy", h.RestartPolicy.Name, "unless-stopped");
  equal("stop grace period (seconds)", info.Config.StopTimeout, 45);
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
    ...(env.TEAM_WORK_DIR ? [["TEAM_WORK_DIR", "/work", true]] : []),
  ].map(([name, target, rw]) => {
    const source = required(env, name);
    assert.ok(source.startsWith("/"), `${name} must be absolute`);
    assert.ok(!source.includes("docker.sock"), "no Docker socket source");
    return { source: resolve(source), target, rw, type: "bind" };
  });
  const sort = (v) => v.sort((a, b) => a.target.localeCompare(b.target));
  equal("exact approved mounts (no extra home, socket or service-account mount)", sort(info.Mounts.map((m) => ({ source: m.Source, target: m.Destination, rw: m.RW, type: m.Type }))), sort(mounts));
  equal("legacy auto-creating binds", h.Binds || [], []);
  equal("binds fail on missing host paths", sort((h.Mounts || []).map((m) => ({ source: m.Source, target: m.Target, rw: !m.ReadOnly, type: m.Type, create_host_path: !!m.BindOptions?.CreateMountpoint }))), sort(mounts.map((m) => ({ ...m, create_host_path: false }))));
  return evidence;
}

function runtimeCheck(uid, gid) {
  const fs = require("node:fs");
  const assert = require("node:assert/strict");
  const status = fs.readFileSync("/proc/self/status", "utf8");
  assert.equal(process.getuid(), Number(uid));
  assert.equal(process.getgid(), Number(gid));
  assert.match(status, new RegExp(`^Gid:\\s+${gid}\\s+${gid}\\s+${gid}\\s+${gid}$`, "m"));
  assert.match(status, new RegExp(`^Groups:[\\t ]*(?:${gid}[\\t ]*)?$`, "m"));
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  console.log(`process uid=${process.getuid()} gid=${process.getgid()}; ${status.match(/^Gid:.*$/m)[0]}; ${status.match(/^Groups:.*$/m)[0]}; CapEff=0; NoNewPrivs=1`);
  const pid = fs.readFileSync("/tmp/agent-sshd.pid", "utf8").trim();
  assert.match(pid, /^\d+$/);
  const daemon = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  assert.match(daemon, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, "m"));
  assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"), /sshd/);
  console.log(`sshd pid=${pid}; ${daemon.match(/^Uid:.*$/m)[0]}`);
  for (const path of ["/state/home", "/state/ssh", "/state/deploy"]) {
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

function main(args, env) {
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
    const r = spawnSync("docker", argv, { encoding: "utf8", input, timeout, maxBuffer: 8 * 1024 * 1024 });
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
  report(`PASS ${program(runtimeCheck, [uid, gid]).replaceAll("\n", `\n[${label}] PASS `)}`);
  const token = JSON.parse(program(tokenCheck, [gid, label !== "local"]));
  for (const line of token.evidence) report(line);
  report(`PASS ${program(credentialScan, [["/"], ["/proc", "/sys", "/dev", "/state", "/tmp", "/run", "/work"]], true)}`);
  const writableRoots = ["/state", "/tmp", "/run", "/work", "/dev/shm", "/dev/mqueue"];
  report(`PASS ${program(credentialScan, [writableRoots])}`);
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
    const r = spawnSync("docker", ["exec", container, "sh", "-eu", "-c", `
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
