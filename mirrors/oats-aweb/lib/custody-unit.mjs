import {registryOrigin, registryShellAssignment} from './registry-setting.mjs';
// The per-user service that keeps a GLOBAL resident's custody running: a
// launchd agent on macOS, a systemd --user unit on Linux. aw has no install
// verb (`aw custody serve` takes no flags and serves the identity home of its
// working directory), so OATS writes the unit. It runs `aw custody serve` in
// the resident's directory with PATH and HOME only: no key, no identity
// selector. Elsewhere there is no unit, and the operator starts custody by hand.
// The host wake broker's unit (wake-service.mjs) is built from the same parts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { custodyPreflight } from "./grant-custody.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Whether two paths name the same directory, through symlinks too. */
export function samePath(a, b) {
  if (resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** The node a unit runs: the kernel-selected path, without resolving its
 *  stable link. Older kernels supply no OATS_NODE_BIN and keep the previous
 *  execPath fallback. */
export function unitNode(env = process.env) {
  return typeof env.OATS_NODE_BIN === "string" && isAbsolute(env.OATS_NODE_BIN) ? env.OATS_NODE_BIN : process.execPath;
}

/** A unit's PATH: each executable's directory (and its target's, for a linked
 *  one), the directory of the node an npm-installed executable needs, the
 *  directories of `after` (executables found where only their own directory
 *  counts), then `fallback`, the system's. */
export function searchPath(executables, env = process.env, { after = [], fallback = ["/usr/local/bin", "/usr/bin", "/bin"] } = {}) {
  const dirs = executables.flatMap((file) => {
    let target = file;
    try { target = realpathSync(file); } catch { /* the file itself is the target */ }
    return [dirname(file), dirname(target)];
  });
  dirs.push(dirname(unitNode(env)), ...after.map((file) => dirname(file)), ...fallback);
  return dirs.filter((d, i) => dirs.indexOf(d) === i).join(":");
}

/** The custody unit's PATH: aw's directories, node's and the system's. */
export function unitSearchPath(aw, env = process.env) {
  return searchPath([aw], env);
}

/** ai.aweb.custody.<namespace of the address>.<name> */
export function custodyLabel(address, name) {
  const [namespace, alias, ...rest] = String(address || "").split("/");
  if (!namespace || alias === undefined || rest.length) fail("E_RESIDENT_VERIFY", `address ${address} has no namespace`);
  if (alias !== name) fail("E_RESIDENT_VERIFY", `address ${address} does not end in /${name}`);
  return `ai.aweb.custody.${namespace}.${name}`;
}

export function unitManager(platform) {
  return platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : null;
}
export const unitDir = ({ platform, home, xdgConfigHome }) => platform === "darwin"
  ? join(home, "Library", "LaunchAgents")
  : join(xdgConfigHome || join(home, ".config"), "systemd", "user");
export function unitPath(where, label) {
  return join(unitDir(where), `${label}${where.platform === "darwin" ? ".plist" : ".service"}`);
}

export const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export const unXml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
/** systemd expands % specifiers in every setting used here. It also expands
 *  $ variables in ExecStart= (written $$ for a literal $), but not in
 *  Environment= values, where $ has no special meaning (systemd.exec(5)). */
export const systemdValue = (s) => String(s).replace(/%/g, "%%");
export const systemdQuoted = (s) => `"${systemdValue(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The unit file's text. `path` and `home` are the only environment it sets. */
export function renderUnit({ platform, label, aw, root, path, home, address, registry }) {
  for (const [what, value] of Object.entries({ label, aw, root, path, home, address })) {
    if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) fail("E_RESIDENT_UNIT", `the custody unit's ${what} is empty or contains a control character`);
  }
  if(registry!==undefined) registry=registryOrigin({registry});
  const log = join(root, ".oats-resident", "custody.log");
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(aw)}</string>
    <string>custody</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>HOME</key>
    <string>${xml(home)}</string>${registry ? `
    <key>AWID_REGISTRY_URL</key>
    <string>${xml(registry)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
  if (platform === "linux") return `[Unit]
Description=aweb custody for resident ${systemdValue(address)}

[Service]
Type=simple
WorkingDirectory=${systemdValue(root)}
Environment=${systemdQuoted(`PATH=${path}`)} ${systemdQuoted(`HOME=${home}`)}${registry ? ` ${systemdQuoted(`AWID_REGISTRY_URL=${registry}`)}` : ""}
ExecStart=${systemdQuoted(aw).split("$").join("$$")} custody serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
  return fail("E_RESIDENT_UNIT_UNSUPPORTED", `no custody unit for platform ${platform}`);
}

/** The directory a unit file serves, or undefined when it names none. */
function servedRoot(platform, text) {
  if (platform === "darwin") {
    const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    return m ? unXml(m[1]) : undefined;
  }
  const m = /^WorkingDirectory=(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/%%/g, "%") : undefined;
}

/** Recognised custody units of resident `name`, whatever their namespace.
 *  Arbitrarily named services are outside this discovery boundary. */
export function residentUnits(where, name) {
  const dir = unitDir(where);
  const suffix = where.platform === "darwin" ? ".plist" : ".service";
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  return entries
    .filter((f) => f.startsWith("ai.aweb.custody.") && f.endsWith(`.${name}${suffix}`) && f.length > `ai.aweb.custody..${name}${suffix}`.length)
    .map((f) => {
      const path = join(dir, f);
      let root;
      try { root = servedRoot(where.platform, readFileSync(path, "utf8")); } catch { /* unreadable: serves no known directory */ }
      return { label: f.slice(0, -suffix.length), path, root };
    });
}

export function conflictMessage(unit, root) {
  return `custody unit ${unit.path} already serves ${unit.root ?? "an unreadable directory"}, not ${root}; remove that unit or choose another name`;
}

/** Retiring a discovered unit is the operator's act; never remove or adopt it. */
export function retireUnitStep(unit, { platform, uid }) {
  const quote = (s) => /^[A-Za-z0-9/_.-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
  return platform === "darwin"
    ? `run \`launchctl bootout ${quote(`gui/${uid}/${unit.label}`)}\`, then move ${unit.path} out of ~/Library/LaunchAgents`
    : `run \`systemctl --user disable --now ${quote(`${unit.label}.service`)}\`, then remove the unit file ${unit.path} and run \`systemctl --user daemon-reload\``;
}

export function foreignUnitMessage(unit, root, where) {
  return `custody unit ${unit.label} (${unit.path}) already serves ${root} under another label; ${retireUnitStep(unit, where)}, then rerun; this command never adopts or removes another unit`;
}

/** A unit manager command's environment: PATH and HOME, and the variables
 *  systemctl --user and loginctl find the user's manager by. Never anything
 *  else, and none of it goes into the unit. */
const MANAGER_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
export function manage(env, cmd, args) {
  const managerEnv = Object.fromEntries(MANAGER_ENV.filter((k) => typeof env[k] === "string").map((k) => [k, env[k]]));
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { env: managerEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }) };
  } catch (e) {
    return { ok: false, missing: e.code === "ENOENT", status: e.status, stderr: String(e.stderr || "").trim() };
  }
}
/** manage, failing with `codes` ({unsupported, failed}) when the command is
 *  missing or exits nonzero. */
const RESIDENT_CODES = { unsupported: "E_RESIDENT_UNIT_UNSUPPORTED", failed: "E_RESIDENT_UNIT" };
export function managed(env, cmd, args, codes = RESIDENT_CODES) {
  const r = manage(env, cmd, args);
  if (r.missing) fail(codes.unsupported, `${cmd} is not available on this host`);
  if (!r.ok) fail(codes.failed, `${cmd} ${args.join(" ")} failed${r.status != null ? ` (exit ${r.status})` : ""}${r.stderr ? `: ${r.stderr}` : ""}`);
  return r;
}

/** Why custody would not survive a logout on Linux, or undefined. Without
 *  systemd's lingering, a user's units stop when their last session ends. */
export function lingerProblem({ platform, user, env }) {
  if (lingerEnabled({ platform, user, env }) !== false) return undefined; // no systemd: the custody stage names the hand step
  return `systemd lingering is off for ${user}, so the custody unit would stop when ${user} logs out: an administrator runs \`loginctl enable-linger ${user}\`, then rerun`;
}

/** Whether systemd keeps `user`'s units running with no session: true, false
 *  (off, or loginctl could not say), or undefined off Linux or without loginctl. */
export function lingerEnabled({ platform, user, env }) {
  if (platform !== "linux") return undefined;
  const r = manage(env, "loginctl", ["show-user", user, "--property=Linger"]);
  if (r.missing) return undefined;
  return r.ok && /^Linger=yes$/m.test(r.stdout);
}

/** Writes the unit when it is missing or differs, and makes sure it is loaded
 *  and its process running; a running, unchanged unit is left as it is.
 *  A unit of this label that serves another directory is refused. `rerun`
 *  names the command to rerun in a failure's remedy; `unload` overrides
 *  reloadLaunchd's clock, sleep and bound. */
export async function ensureCustodyUnit({ platform, label, aw, root, home, address, registry, uid, env, xdgConfigHome, rerun = "the command", unload = {} }) {
  const manager = unitManager(platform);
  if (!manager) fail("E_RESIDENT_UNIT_UNSUPPORTED", `this host (${platform}) has no supported per-user service manager`);
  const path = unitPath({ platform, home, xdgConfigHome }, label);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  let served = root;
  if (existing !== undefined) {
    served = servedRoot(platform, existing);
    if (!served || !samePath(served, root)) fail("E_RESIDENT_UNIT_CONFLICT", conflictMessage({ path, root: served }, root));
  }
  // A unit serving the same directory under another spelling keeps its own.
  const desired = renderUnit({ platform, label, aw, root: served, path: unitSearchPath(aw, env), home, address, registry });
  const changed = existing !== desired;
  if (changed) {
    mkdirSync(unitDir({ platform, home, xdgConfigHome }), { recursive: true });
    writeFileSync(path, desired, { mode: 0o644 });
  }
  if (manager === "launchd") {
    const target = `gui/${uid}/${label}`;
    const loaded = manage(env, "launchctl", ["print", target]);
    if (loaded.missing) fail("E_RESIDENT_UNIT_UNSUPPORTED", "launchctl is not available on this host");
    // A loaded job is reloaded when its text changed, or when it is not
    // running: launchd refuses the respawns of a job whose binary was
    // replaced (an aw upgrade: exit 78, "needs LWCR update") until a
    // bootstrap re-reads its code requirement. A running, unchanged job is
    // left serving.
    if (loaded.ok && (changed || launchdPid(loaded.stdout) === undefined)) await reloadLaunchd({ env, uid, label, path, rerun, ...unload });
    else if (!loaded.ok) managed(env, "launchctl", ["bootstrap", `gui/${uid}`, path]);
  } else {
    // Enabled by its path, the user's manager links the file into its own
    // configuration wherever the file is; by name, it looks only there.
    const service = `${label}.service`;
    if (changed) {
      managed(env, "systemctl", ["--user", "daemon-reload"]);
      managed(env, "systemctl", ["--user", "enable", "--now", path]);
      if (existing !== undefined) managed(env, "systemctl", ["--user", "restart", service]);
    } else if (!manage(env, "systemctl", ["--user", "is-active", service]).ok) {
      managed(env, "systemctl", ["--user", "enable", "--now", path]);
    }
  }
  return { manager, label, path, changed };
}

// Past launchd's default ExitTimeOut (20 s; neither plist sets one), after
// which launchd kills a job that has not exited on SIGTERM.
const UNLOAD_MS = 30000, UNLOAD_POLL_MS = 250;
// launchctl print's exit status for a service its domain does not have
// ("Could not find service"): the only answer that confirms a job is gone.
const LAUNCHD_NOT_FOUND = 113;
const shellWord = (s) => /^[A-Za-z0-9/_.@:-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";

/** Restarts a loaded launchd job: bootout, then one bootstrap once launchd
 *  confirms the job is gone. bootout returns before the job has exited, and a
 *  bootstrap while it is still unloading fails (5: Input/output error) and
 *  leaves it unloaded. A bootout that exits nonzero (3 while the job is still
 *  unloading) is not fatal by itself: the wait decides. Only print's
 *  not-found status confirms the job is gone; any other failed print is no
 *  answer, and the wait goes on. Not confirmed gone after `timeoutMs`, it
 *  fails with `codes.failed` before any bootstrap, naming the manual step,
 *  `rerun` and the last failed print. */
export async function reloadLaunchd({ env, uid, label, path, codes = RESIDENT_CODES, rerun = "the command", now = Date.now, sleep = pause, timeoutMs = UNLOAD_MS, intervalMs = UNLOAD_POLL_MS }) {
  const target = `gui/${uid}/${label}`;
  if (manage(env, "launchctl", ["bootout", target]).missing) fail(codes.unsupported, "launchctl is not available on this host");
  const until = now() + timeoutMs;
  for (;;) {
    const r = manage(env, "launchctl", ["print", target]);
    if (!r.ok && r.status === LAUNCHD_NOT_FOUND) break;
    if (now() >= until) {
      const state = r.ok ? "is still unloading" : `could not be confirmed unloaded (launchctl print ${target} failed${r.status != null ? ` (exit ${r.status})` : ""}${r.stderr ? `: ${r.stderr}` : ""})`;
      fail(codes.failed, `launchd job ${label} ${state} ${timeoutMs / 1000} s after launchctl bootout ${target}, so it was not bootstrapped: once \`launchctl print ${target}\` no longer finds it, run \`launchctl bootstrap gui/${uid} ${shellWord(path)}\`, then rerun ${rerun}`);
    }
    await sleep(intervalMs);
  }
  managed(env, "launchctl", ["bootstrap", `gui/${uid}`, path], codes);
}

/** The pid of a unit's running process, or undefined when it is not running.
 *  Loaded is not running: a KeepAlive or Restart= unit that keeps exiting is
 *  loaded (launchd "spawn scheduled", systemd activating/auto-restart). */
export function runningPid(manager, env, uid, label) {
  if (manager === "launchd") {
    const r = manage(env, "launchctl", ["print", `gui/${uid}/${label}`]);
    return r.ok ? launchdPid(r.stdout) : undefined;
  }
  const r = manage(env, "systemctl", ["--user", "show", "-p", "ActiveState,SubState,MainPID", `${label}.service`]);
  if (!r.ok) return undefined;
  const value = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(r.stdout)?.[1];
  if (value("ActiveState") !== "active" || value("SubState") !== "running") return undefined;
  return Number(value("MainPID")) || undefined;
}

/** The running pid in a loaded job's `launchctl print` output, or undefined.
 *  The job's own state and pid are its top-level (one-tab) lines. */
function launchdPid(printed) {
  if (!/^\tstate = running$/m.test(printed)) return undefined;
  return Number(/^\tpid = (\d+)$/m.exec(printed)?.[1]) || undefined;
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Whether this command's own unit is what serves R: its file at the
 *  expected path for the label, serving R, and its process the server.
 *  {serves, via} or {serves: false, why}.
 *
 *  aw refuses a second custody server on a socket that answers, before it
 *  listens (aw 1.36.33, cmd/aw/custody.go:235-238), so while another custody
 *  answers, our unit's process cannot be listening. Where lsof exists, the
 *  process must own the custody socket (via "lsof"). Where it does not, the
 *  same pid must still be running `settleMs` later (via "steady-pid"): a
 *  crash-looping aw exits within milliseconds, while launchd and systemd wait
 *  seconds before restarting it. */
export async function ownUnitServes({ platform, label, root, home, xdgConfigHome, uid, env, socketPath, settleMs = 1000 }) {
  const manager = unitManager(platform);
  if (!manager) return { serves: false, why: "no unit of this command on this platform" };
  const path = unitPath({ platform, home, xdgConfigHome }, label);
  let served;
  try { served = servedRoot(platform, readFileSync(path, "utf8")); } catch { return { serves: false, why: "no unit of this command serves it" }; }
  if (!served || !samePath(served, root)) return { serves: false, why: "no unit of this command serves it" };
  const pid = runningPid(manager, env, uid, label);
  if (!pid) return { serves: false, why: "its process is not running" };
  const owners = manage(env, "lsof", ["-t", socketPath]);
  if (!owners.missing) {
    const pids = owners.ok ? owners.stdout.split(/\s+/).filter(Boolean).map(Number) : [];
    if (pids.includes(pid)) return { serves: true, via: "lsof" };
    return { serves: false, why: pids.length ? `another process (${pids.join(", ")}) owns the custody socket` : "no process was found owning the custody socket" };
  }
  await pause(settleMs);
  return runningPid(manager, env, uid, label) === pid ? { serves: true, via: "steady-pid" } : { serves: false, why: "its process did not stay running" };
}

/** What an operator runs where OATS writes no unit. */
export function handStep(root, name, registry) {
  return `start custody yourself: run \`aw custody serve\` in ${root} under a supervisor that keeps it running (working directory ${root}, environment PATH and HOME${registry ? ` plus ${registryShellAssignment(registryOrigin({registry}))} from settings.oats.aweb.registry` : " only"}), then rerun \`oats aweb resident create ${name}\` to verify`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Waits until the running custody is ready for grant seats: running, the team
 *  ready, signing and E2EE keys ready, and the floor ops listed; with `owner`,
 *  also served by the process it asks about (`owner(status)` answers a problem,
 *  or nothing when that process is the server). Throws the last answer when it
 *  is not ready in time: E_RESIDENT_CUSTODY_RUNNING when another process
 *  answers, E_RESIDENT_CUSTODY otherwise. */
export async function waitForCustody({ status, resident, team, owner, timeoutMs = 30000, intervalMs = 500 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let last;
    try {
      const ready = custodyPreflight({ custody: "", resident, team, e2eeRequired: true, ttl: "never", fatalOnError: false, runAw: () => status() }).status;
      const problem = owner ? await owner(ready) : undefined;
      if (!problem) return ready;
      last = { code: "E_RESIDENT_CUSTODY_RUNNING", message: problem };
    } catch (e) {
      last = { code: "E_RESIDENT_CUSTODY", message: String(e.message || e) };
    }
    if (Date.now() >= until) fail(last.code, last.message);
    await sleep(intervalMs);
  }
}
