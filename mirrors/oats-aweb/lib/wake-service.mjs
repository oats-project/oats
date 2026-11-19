import {registryOrigin, registryMigration} from './registry-setting.mjs';
import { awChildEnv } from './aw-child-env.mjs';

import { parseProviderSettings } from './provider-settings.mjs';
// `oats aweb wake install | status | uninstall`: the per-user service that
// keeps the host wake broker (`aw wake run`) running, a launchd agent on macOS
// and a systemd --user unit on Linux, labelled ai.aweb.wake. aw has no install
// verb, so OATS writes the unit from the operator's own shell (never an
// agent's: the unit records the invoking PATH, as `oats schedule host install`
// does, awebai/oats#967). The unit is built from custody-unit.mjs's parts.
//
// Ownership: the unit this command writes carries WAKE_MARKER. Any other unit
// that runs `aw wake run`, or a file at our path without the marker, is foreign:
// install and uninstall refuse and name its retire steps, and never touch it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { AW_MIN, awFloorMessage, onPath, readAwVersion } from "./binding-wire.mjs";
import { lingerEnabled, manage, managed, reloadLaunchd, runningPid, samePath, searchPath, systemdQuoted, unitDir, unitManager, unitNode, unXml, xml } from "./custody-unit.mjs";
import { kernelQueryEnvironment } from "./session-readiness.mjs";
import { selectedDeployment } from "./team-roots.mjs";
import { expectedReceive, statusListsHome } from "./wake-receive.mjs";
import { parseVersion, versionAtLeast } from "./aw-floor.mjs";

export const WAKE_LABEL = "ai.aweb.wake";
export const WAKE_USAGE = "usage: oats aweb wake install [--plan] [--linger-required] [--json] | oats aweb wake status [--json] | oats aweb wake uninstall [--plan] [--json]";
export const WAKE_MARKER = "Written by oats aweb wake install";
const MARKER_LINE = `${WAKE_MARKER}; rerun it to update this unit, and oats aweb wake uninstall to remove it.`;
const CODES = { unsupported: "E_WAKE_UNSUPPORTED", failed: "E_WAKE_UNIT" };
/** The kernel host timer's fallback (awebai/oats lib/schedule-host.mjs
 *  FALLBACK_PATH): Homebrew's prefixes come first, so an Apple Silicon Mac's
 *  tmux is found. */
export const WAKE_FALLBACK_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const VERIFY_MS = 10000;
const STATUS_TIMEOUT_MS = 10000;
// One bounded kernel read for status's home walk (oats status --json).
const KERNEL_TIMEOUT_MS = 15000;
const KERNEL_MAX_BYTES = 16 * 1024 * 1024;

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseWakeArgs(argv) {
  const usage = () => Object.assign(new Error(WAKE_USAGE), { code: "E_WAKE_ARGUMENT" });
  const [verb, ...rest] = argv;
  if (!["install", "status", "uninstall"].includes(verb)) throw usage();
  const opts = { verb, plan: false, lingerRequired: false, json: false };
  const flags = { install: ["--plan", "--linger-required", "--json"], status: ["--json"], uninstall: ["--plan", "--json"] }[verb];
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const [flag, ...inline] = rest[i].split("=");
    if (seen.has(flag)) throw usage();
    seen.add(flag);
    if (flags.includes(flag)) {
      if (inline.length) throw usage();
      opts[{ "--plan": "plan", "--linger-required": "lingerRequired", "--json": "json" }[flag]] = true;
      continue;
    }
    // --soul is the kernel's operator dispatch, forwarded to every command;
    // --dir selects the deployment whose homes status reports.
    if (!["--dir", "--soul"].includes(flag)) throw usage();
    const value = inline.length ? inline.join("=") : rest[++i];
    if (!value || value.startsWith("--")) throw usage();
    if (flag === "--dir") opts.dir = value;
  }
  return opts;
}

export const wakeUnitPath = (where) => join(unitDir(where), `${WAKE_LABEL}${where.platform === "darwin" ? ".plist" : ".service"}`);
export const wakeLogPath = (home) => join(home, "Library", "Logs", `${WAKE_LABEL}.log`);
/** Where to read why the unit's daemon is not running. */
export const wakeLogStep = (platform, home) => platform === "darwin"
  ? `read its log in ${wakeLogPath(home)}`
  : `read its log with \`journalctl --user -u ${WAKE_LABEL}.service -n 50\``;

/** The unit's PATH. The broker runs `oats session inspect` and
 *  `oats session input`, which exec tmux and ps from it (awebai/oats
 *  lib/session-input.mjs), so tmux's directory is on it too. */
export function wakeSearchPath({ aw, oats, tmux }, env = process.env) {
  return searchPath([aw, oats], env, { after: tmux ? [tmux] : [], fallback: WAKE_FALLBACK_PATH });
}

/** The unit's text: `aw wake run` with PATH and AW_WAKE_OATS_BIN only, and
 *  aw's default state directory (no --state-dir). */
export function renderWakeUnit({ platform, aw, oats, path, home, registry }) {
  for (const [what, value] of Object.entries({ aw, oats, path, home })) {
    if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) fail("E_WAKE_UNIT", `the wake unit's ${what} is empty or contains a control character`);
  }
  if(registry!==undefined) registry=registryOrigin({registry});
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MARKER_LINE} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WAKE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(aw)}</string>
    <string>wake</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>AW_WAKE_OATS_BIN</key>
    <string>${xml(oats)}</string>${registry ? `
    <key>AWID_REGISTRY_URL</key>
    <string>${xml(registry)}</string>` : ""}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(wakeLogPath(home))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(wakeLogPath(home))}</string>
</dict>
</plist>
`;
  if (platform === "linux") return `# ${MARKER_LINE}
[Unit]
Description=aweb host wake broker

[Service]
Type=simple
Environment=${systemdQuoted(`PATH=${path}`)} ${systemdQuoted(`AW_WAKE_OATS_BIN=${oats}`)}${registry ? ` ${systemdQuoted(`AWID_REGISTRY_URL=${registry}`)}` : ""}
ExecStart=${systemdQuoted(aw).split("$").join("$$")} wake run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
  return fail("E_WAKE_UNSUPPORTED", `no wake unit for platform ${platform}`);
}

/** A unit file's logical lines, as systemd.syntax(7) assembles them: a line
 *  ending in a backslash continues on the next line that is not a comment
 *  (`#` or `;`), the backslash read as a space. */
export function logicalLines(text) {
  const lines = [];
  let open = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^[ \t]*[#;]/.test(raw)) { if (open === null) lines.push(raw); continue; }
    const continues = raw.endsWith("\\");
    open = (open ?? "") + (continues ? `${raw.slice(0, -1)} ` : raw);
    if (!continues) { lines.push(open); open = null; }
  }
  if (open !== null) lines.push(open);
  return lines;
}

/** The argv of a systemd unit's (last) ExecStart=: quoted or bare words, its
 *  exec prefixes dropped, %% and $$ unescaped. */
export function execStartArgv(text) {
  let line;
  for (const logical of logicalLines(text)) { const m = /^[ \t]*ExecStart[ \t]*=[ \t]*(.*)$/.exec(logical); if (m) line = m[1]; }
  if (!line) return undefined;
  const prefix = /^[-@:+!]*/.exec(line)[0];
  line = line.slice(prefix.length);
  const argv = [];
  let word = "", quote = null, open = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && i + 1 < line.length) word += line[++i];
      else if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") { quote = c; open = true; }
    else if (/\s/.test(c)) { if (open || word) argv.push(word); word = ""; open = false; }
    else if (c === "\\" && i + 1 < line.length) { word += line[++i]; open = true; }
    else word += c;
  }
  if (open || word) argv.push(word);
  const unescaped = argv.map((a) => a.replace(/%%/g, "%").replace(/\$\$/g, "$"));
  // `@` gives argv[0] separately: the program is the first word, its name the second.
  return prefix.includes("@") ? [unescaped[0], ...unescaped.slice(2)] : unescaped;
}

/** A binary property list (bplist00, as launchd also reads) decoded to plain
 *  values, or undefined when its structure is malformed. Integers decode as
 *  numbers (an 8-byte one is signed); reals, dates, data and anything else
 *  decode to null, never failing the whole list: a launchd job's program,
 *  arguments and label are strings. */
export function decodeBinaryPlist(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 40 || buf.toString("latin1", 0, 8) !== "bplist00") return undefined;
    const trailer = buf.length - 32;
    const offsetSize = buf[trailer + 6], refSize = buf[trailer + 7];
    const uint = (at, size) => { if (size < 1 || size > 8 || at < 0 || at + size > buf.length) throw new Error("bounds"); let n = 0; for (let i = 0; i < size; i++) n = n * 256 + buf[at + i]; if (!Number.isSafeInteger(n)) throw new Error("size"); return n; };
    const count = uint(trailer + 8, 8), top = uint(trailer + 16, 8), table = uint(trailer + 24, 8);
    if (count > 100000 || top >= count) return undefined;
    const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offsetSize, offsetSize));
    const decode = (ref, depth) => {
      if (depth > 32 || ref >= count) throw new Error("ref");
      let at = offsets[ref];
      const marker = uint(at++, 1), type = marker >> 4, info = marker & 0xf;
      const length = () => { if (info !== 0xf) return info; const m = uint(at++, 1); if (m >> 4 !== 1) throw new Error("length"); const size = 1 << (m & 0xf); const n = uint(at, size); at += size; return n; };
      if (type === 0x0) return info === 0x9 ? true : info === 0x8 ? false : null;
      if (type === 0x1) {
        if (info <= 2) return uint(at, 1 << info);
        if (info === 3 && at + 8 <= buf.length) return Number(buf.readBigInt64BE(at));
        return null; // a 16-byte integer
      }
      if (type === 0x5) { const n = length(); if (at + n > buf.length) throw new Error("bounds"); return buf.toString("latin1", at, at + n); }
      if (type === 0x6) { const n = length(); if (at + 2 * n > buf.length) throw new Error("bounds"); return Buffer.from(buf.subarray(at, at + 2 * n)).swap16().toString("utf16le"); }
      if (type === 0xa) { const n = length(); return Array.from({ length: n }, (_, i) => decode(uint(at + i * refSize, refSize), depth + 1)); }
      if (type === 0xd) {
        const n = length(), out = {};
        for (let i = 0; i < n; i++) {
          const key = decode(uint(at + i * refSize, refSize), depth + 1);
          if (typeof key !== "string") throw new Error("key");
          out[key] = decode(uint(at + (n + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      return null; // real, date, data, uid, set: nothing a job's program is made of
    };
    return decode(top, 0);
  } catch { return undefined; }
}

const stringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string") ? v : [];
/** The argv of a launchd job (Program, else ProgramArguments[0], runs) from
 *  its plist, XML text or binary. */
export function plistArgv(content) {
  if (Buffer.isBuffer(content) && content.toString("latin1", 0, 8) === "bplist00") {
    const doc = decodeBinaryPlist(content);
    if (!object(doc)) return undefined;
    const args = stringArray(doc.ProgramArguments);
    if (typeof doc.Program === "string") return [doc.Program, ...args.slice(1)];
    return args.length ? args : undefined;
  }
  const text = String(content);
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const args = array ? [...array[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unXml(m[1])) : [];
  const program = /<key>Program<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  if (program) return [unXml(program[1]), ...args.slice(1)];
  return args.length ? args : undefined;
}
const plistLabel = (content) => {
  if (Buffer.isBuffer(content) && content.toString("latin1", 0, 8) === "bplist00") { const doc = decodeBinaryPlist(content); return object(doc) && typeof doc.Label === "string" ? doc.Label : undefined; }
  const m = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(String(content));
  return m ? unXml(m[1]) : undefined;
};

/** Whether argv runs the wake broker: an `aw` binary (by name or by its link's
 *  target) with `wake run`, whatever flags follow. */
export function runsWakeBroker(argv) {
  if (!Array.isArray(argv) || argv.length < 3 || argv[1] !== "wake" || argv[2] !== "run") return false;
  if (basename(argv[0]) === "aw") return true;
  try { return basename(realpathSync(argv[0])) === "aw"; } catch { return false; }
}

/** The units of the user unit directory that matter here: ours (at our path,
 *  with the marker) and the foreign ones (any other unit running the broker,
 *  and a file at our path without the marker). Each {label, path, aw}. */
export function wakeUnits(where) {
  const dir = unitDir(where), ourPath = wakeUnitPath(where);
  const suffix = where.platform === "darwin" ? ".plist" : ".service";
  let entries;
  try { entries = readdirSync(dir).filter((f) => f.endsWith(suffix)).sort(); } catch { entries = []; }
  let ours;
  const foreign = [];
  for (const f of entries) {
    const path = join(dir, f);
    let bytes, text;
    try { if (!statSync(path).isFile()) continue; bytes = readFileSync(path); text = bytes.toString("utf8"); } catch { bytes = undefined; }
    const argv = bytes === undefined ? undefined : where.platform === "darwin" ? plistArgv(bytes) : execStartArgv(text);
    const label = (where.platform === "darwin" && bytes !== undefined && plistLabel(bytes)) || f.slice(0, -suffix.length);
    const unit = { label, path, aw: Array.isArray(argv) ? argv[0] : undefined };
    if (path === ourPath && bytes !== undefined && text.includes(WAKE_MARKER)) ours = { ...unit, text };
    else if (path === ourPath || runsWakeBroker(argv)) foreign.push(unit);
  }
  return { ours, foreign };
}

/** How the operator retires a foreign wake unit: the migration steps
 *  oats.setup's host-delivery procedure cites (awebai/oats#1232). */
export function retireWakeStep(unit, { platform, uid }) {
  const quote = (s) => /^[A-Za-z0-9/_.@:-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
  return platform === "darwin"
    ? `run \`launchctl bootout ${quote(`gui/${uid}/${unit.label}`)}\`, remove ${unit.path}`
    : `run \`systemctl --user disable --now ${quote(`${unit.label}.service`)}\`, remove ${unit.path}`;
}

export function foreignWakeMessage(units, where, verb) {
  return units.map((u) => `${u.path === wakeUnitPath(where) ? "a wake unit not written by oats aweb wake install" : "another wake broker unit"} is at ${u.path}; to retire it, ${retireWakeStep(u, where)}`).join("; ")
    + `; then rerun oats aweb wake ${verb}; ${verb} never takes over, changes or removes another unit`;
}

/** `aw wake status --json` with aw's default state directory (the one the unit
 *  uses), or undefined when it cannot be read. */
export function readWakeStatus(aw, env, home) {
  const childEnv = awChildEnv(env);
  delete childEnv.AW_WAKE_STATE_DIR;
  try {
    const doc = JSON.parse(execFileSync(aw, ["wake", "status", "--json"], { cwd: home, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }));
    return object(doc) ? doc : undefined;
  } catch { return undefined; }
}
const daemonOf = (s) => ({ running: s?.daemon_running === true, version: typeof s?.daemon_version === "string" ? s.daemon_version : null, versionState: typeof s?.daemon_version_state === "string" ? s.daemon_version_state : null, pid: Number.isInteger(s?.daemon_pid) ? s.daemon_pid : null });

/** Whether the running daemon is our unit's: its pid is the unit's main pid,
 *  or that process's child (an aw installed behind a wrapper). */
function supervisedBy(unitPid, daemonPid, env) {
  if (!unitPid) return false;
  if (daemonPid === null || daemonPid === unitPid) return true;
  const r = manage(env, "ps", ["-o", "ppid=", "-p", String(daemonPid)]);
  return r.ok && Number(r.stdout.trim()) === unitPid;
}

function refuseInsideHome(env, verb) {
  const name = ["OATS_INSTANCE_HOME", "OATS_HOME"].find((k) => typeof env[k] === "string" && env[k]);
  if (name) fail("E_WAKE_INSIDE_HOME", `oats aweb wake ${verb} runs in the operator's own shell, never inside an instance (${name} is set): an agent's shell carries a session's PATH, which the unit would record; run it from the deployment directory in your own terminal`);
}
function requireManager(platform) {
  const manager = unitManager(platform);
  if (!manager) fail("E_WAKE_UNSUPPORTED", `this host (${platform}) has no supported per-user service manager; run \`aw wake run\` under a supervisor yourself`);
  return manager;
}
const describe = (cmd, args) => [cmd, ...args].join(" ");

/** Everything install decides before it changes anything: every refusal, the
 *  unit text and the actions. Runs read-only commands only. */
async function prepareInstall(opts, ctx) {
  const { env, platform, uid, user, home } = ctx;
  const where = { platform, home, xdgConfigHome: ctx.xdgConfigHome, uid };
  refuseInsideHome(env, "install");
  const manager = requireManager(platform);
  if (typeof env.AW_WAKE_STATE_DIR === "string" && env.AW_WAKE_STATE_DIR) fail("E_WAKE_STATE_DIR", "AW_WAKE_STATE_DIR is set in this shell, and the unit would not carry it: the service runs aw's default state directory, so unset AW_WAKE_STATE_DIR, then rerun");
  const aw = onPath("aw", env), oats = onPath("oats", env), node = unitNode(env);
  const missing = [["aw", aw], ["oats", oats], ["node", existsSync(node) ? node : undefined]].filter(([, p]) => !p).map(([name]) => name);
  if (missing.length) fail("E_WAKE_PATH", `${missing.join(", ")} not found${missing.includes("node") ? ` (node: ${node})` : ""} on this shell's PATH; the unit records absolute paths from it: install ${missing.length > 1 ? "them" : "it"} or fix PATH, then rerun`);
  const floor = await awFloorMessage({ env });
  if (floor) fail("E_AW_FLOOR", floor);
  const version = await readAwVersion({ env });
  if (!version) fail("E_AW_FLOOR", `aw version could not be read; install aw >= ${AW_MIN}`);
  const path = wakeUnitPath(where);
  const { ours, foreign } = wakeUnits(where);
  if (foreign.length) fail("E_WAKE_UNIT_CONFLICT", foreignWakeMessage(foreign, where, "install"));
  const registry=registryOrigin(ctx.settings);
  const migration=registryMigration(ctx.settings,env);
  if(migration) fail("E_WAKE_REGISTRY",migration);
  if(ours) {
    const raw = platform === "darwin" ? /<key>AWID_REGISTRY_URL<\/key>\s*<string>([^<]*)<\/string>/.exec(ours.text)?.[1] : /"AWID_REGISTRY_URL=([^"\s]+)"/.exec(ours.text)?.[1];
    let previous;
    try {previous=raw===undefined?undefined:registryOrigin({registry:unXml(raw)});} catch {fail("E_WAKE_REGISTRY_CONFLICT","the existing wake unit has an unreadable registry pin; keep one registry for this host user's daemon, or move the other deployment to another host user; to replace the pin, first aw wake deregister --home <other-home> for the other registrations, then oats aweb wake uninstall and oats aweb wake install in the operator shell");}
    if(previous!==registry) fail("E_WAKE_REGISTRY_CONFLICT",`${previous === undefined ? "the wake daemon is currently unpinned; adding a pin changes it for every registration on this host user" : "the wake unit has a conflicting registry pin"}; keep one registry for this host user's daemon, or move the other deployment to another host user; to replace the pin, first aw wake deregister --home <other-home> for the other registrations, then oats aweb wake uninstall and oats aweb wake install in the operator shell`);
  }
  const warnings = [];
  const tmux = onPath("tmux", env);
  // Not a refusal: a deployment may use another session backend.
  if (!tmux) warnings.push({ code: "wake-tmux-missing", message: "tmux is not on this shell's PATH, so it is not on the unit's: the broker cannot reach OATS sessions until tmux is on the unit's PATH; install tmux or fix PATH, then rerun oats aweb wake install" });
  if (lingerEnabled({ platform, user, env }) === false) {
    if (opts.lingerRequired) fail("E_WAKE_LINGER", `systemd lingering is off for ${user}, so the wake broker would stop when ${user}'s last session ends: an administrator runs \`loginctl enable-linger ${user}\`, then rerun`);
    warnings.push({ code: "wake-linger-off", message: `systemd lingering is off for ${user}: the wake broker stops when ${user}'s last session ends; remedy: \`loginctl enable-linger ${user}\` (may need an administrator)` });
  }
  const before = daemonOf(readWakeStatus(aw, env, home));
  if (before.running && !supervisedBy(ours ? runningPid(manager, env, uid, WAKE_LABEL) : undefined, before.pid, env)) {
    fail("E_WAKE_RUNNING_UNSUPERVISED", `a wake broker is already running (daemon_pid ${before.pid ?? "unknown"}) outside ${ours ? "this command's unit" : "any recognised unit"}, started by hand or by another supervisor; stop it (\`kill ${before.pid ?? "<daemon_pid>"}\`, or stop whatever supervises it), then rerun`);
  }
  const text = renderWakeUnit({ platform, aw, oats, path: wakeSearchPath({ aw, oats, tmux }, env), home, registry });
  const changed = ours?.text !== text;
  const actions = [];
  const run = (cmd, args) => actions.push({ display: describe(cmd, args), run: () => managed(env, cmd, args, CODES) });
  if (changed) actions.push({ display: `write ${path}`, run: () => {
    mkdirSync(unitDir(where), { recursive: true });
    if (platform === "darwin") mkdirSync(join(home, "Library", "Logs"), { recursive: true });
    writeFileSync(path, text, { mode: 0o644 });
  } });
  if (manager === "launchd") {
    const target = `gui/${uid}/${WAKE_LABEL}`;
    const loaded = manage(env, "launchctl", ["print", target]);
    if (loaded.missing) fail("E_WAKE_UNSUPPORTED", "launchctl is not available on this host");
    // A bootstrap starts the job (RunAtLoad) and re-reads the binary's code
    // requirement; a kickstart doesn't, so after an aw upgrade a kickstarted
    // job exits 78 ("needs LWCR update"). A loaded job, changed or not, is
    // booted out and bootstrapped again once it has unloaded.
    if (loaded.ok) actions.push({
      display: [describe("launchctl", ["bootout", target]), describe("launchctl", ["bootstrap", `gui/${uid}`, path])],
      run: () => reloadLaunchd({ env, uid, label: WAKE_LABEL, path, codes: CODES, rerun: "oats aweb wake install", now: ctx.now, sleep: ctx.sleep, timeoutMs: ctx.unloadMs, intervalMs: ctx.unloadIntervalMs }),
    });
    else run("launchctl", ["bootstrap", `gui/${uid}`, path]);
  } else {
    // Enabled by its path, as the custody unit is; always restarted, so a
    // rerun after an aw upgrade restarts the broker on the new aw.
    if (changed) run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", path]);
    run("systemctl", ["--user", "restart", `${WAKE_LABEL}.service`]);
  }
  return { manager, path, aw, version, text, changed, actions, warnings };
}

export async function installWake(opts, ctx) {
  const p = await prepareInstall(opts, ctx);
  const unit = { manager: p.manager, label: WAKE_LABEL, path: p.path };
  if (opts.plan) return { ok: true, plan: true, unit: { ...unit, written: false, changed: p.changed }, text: p.text, actions: p.actions.flatMap((a) => a.display), warnings: p.warnings };
  for (const action of p.actions) await action.run();
  const { now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), verifyMs = VERIFY_MS, intervalMs = 500 } = ctx;
  const until = now() + verifyMs;
  let daemon;
  for (;;) {
    daemon = daemonOf(readWakeStatus(p.aw, ctx.env, ctx.home));
    if (daemon.running && daemon.versionState === "reported" && daemon.version === p.version) break;
    if (now() >= until) fail("E_WAKE_NOT_RUNNING", `the wake broker unit is in place at ${p.path}, but aw wake status does not show its daemon running aw ${p.version} (running: ${daemon.running}, version: ${daemon.version ?? "none"}, version state: ${daemon.versionState ?? "none"}); the unit is kept: ${wakeLogStep(ctx.platform, ctx.home)}, fix the cause, then rerun`);
    await sleep(intervalMs);
  }
  return { ok: true, unit: { ...unit, written: p.changed }, daemon, warnings: p.warnings };
}

export function uninstallWake(opts, ctx) {
  const { env, platform, uid, home } = ctx;
  const where = { platform, home, xdgConfigHome: ctx.xdgConfigHome, uid };
  refuseInsideHome(env, "uninstall");
  const manager = requireManager(platform);
  const path = wakeUnitPath(where);
  const unit = { manager, label: WAKE_LABEL, path };
  if (!existsSync(path)) return { ok: true, ...(opts.plan ? { plan: true, actions: [] } : {}), unit: { ...unit, removed: false } };
  const { ours } = wakeUnits(where);
  if (!ours) fail("E_WAKE_UNIT_CONFLICT", foreignWakeMessage([{ label: WAKE_LABEL, path }], where, "uninstall"));
  const actions = [];
  const run = (cmd, args) => actions.push({ display: describe(cmd, args), run: () => managed(env, cmd, args, CODES) });
  const remove = { display: `remove ${path}`, run: () => rmSync(path, { force: true }) };
  if (manager === "launchd") {
    const target = `gui/${uid}/${WAKE_LABEL}`;
    const loaded = manage(env, "launchctl", ["print", target]);
    if (loaded.missing) fail("E_WAKE_UNSUPPORTED", "launchctl is not available on this host");
    if (loaded.ok) run("launchctl", ["bootout", target]);
    actions.push(remove);
  } else {
    run("systemctl", ["--user", "disable", "--now", `${WAKE_LABEL}.service`]);
    actions.push(remove);
    run("systemctl", ["--user", "daemon-reload"]);
  }
  if (opts.plan) return { ok: true, plan: true, actions: actions.map((a) => a.display), unit: { ...unit, removed: false } };
  for (const action of actions) action.run();
  return { ok: true, unit: { ...unit, removed: true } };
}


/** The deployment's instance homes, from one read-only `oats status --json`
 *  through the kernel that dispatched this command (OATS_CLI_BIN). */
function deploymentHomes(env, dir) {
  let deployment;
  try { deployment = selectedDeployment(env, dir); } catch { return { known: false, reason: "the deployment is not selected: run oats aweb wake status from the deployment directory, or pass --dir <deployment>" }; }
  const cli = env.OATS_CLI_BIN;
  if (typeof cli !== "string" || !isAbsolute(cli)) return { known: false, reason: "OATS_CLI_BIN is not set: run it as oats aweb wake status" };
  let doc;
  try { doc = JSON.parse(execFileSync(unitNode(env), [cli, "status", "--dir", deployment, "--max-age", "3600", "--json"], { cwd: deployment, env: kernelQueryEnvironment(env), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: KERNEL_TIMEOUT_MS, maxBuffer: KERNEL_MAX_BYTES })); }
  catch { return { known: false, reason: `oats status --json did not answer within ${KERNEL_TIMEOUT_MS / 1000} s and ${KERNEL_MAX_BYTES / 1024 / 1024} MB` }; }
  if (!object(doc) || !Array.isArray(doc.agents)) return { known: false, reason: "oats status --json answered no agents list" };
  const rows = doc.agents.flatMap((a) => (Array.isArray(a?.instances) ? a.instances : []).filter((i) => object(i) && typeof i.home === "string" && isAbsolute(i.home)));
  return { known: true, rows };
}

export async function wakeStatus(opts, ctx) {
  const { env, platform, uid, home } = ctx;
  const where = { platform, home, xdgConfigHome: ctx.xdgConfigHome, uid };
  const manager = unitManager(platform);
  const awOnPath = onPath("aw", env) ?? null;
  let unit = { manager, label: WAKE_LABEL, present: false, path: null, aw: null, awOnPath, awCurrent: null, others: [] };
  if (manager) {
    const { ours, foreign } = wakeUnits(where);
    unit = { ...unit, present: !!ours, path: wakeUnitPath(where), aw: ours?.aw ?? null, others: foreign.map(({ label, path }) => ({ label, path })) };
    if (ours?.aw) unit.awCurrent = awOnPath ? samePath(ours.aw, awOnPath) : false;
  }
  const reader = awOnPath ?? unit.aw;
  const status = reader ? readWakeStatus(reader, env, home) : undefined;
  const daemon = { ...daemonOf(status), readable: !!status, floor: { min: AW_MIN, ok: null } };
  if (parseVersion(daemon.version)) daemon.floor.ok = versionAtLeast(daemon.version, AW_MIN);
  const found = deploymentHomes(env, opts.dir);
  let homes = { known: false, reason: found.reason };
  if (found.known) {
    const delivery = object(ctx.settings) && ctx.settings.delivery === "session" ? "session" : "channel";
    const items = [], unknown = [];
    for (const row of found.rows) {
      const expected = expectedReceive(row.home, { delivery });
      const instance = typeof row.instance === "string" ? row.instance : basename(row.home);
      if (expected.problems?.length) unknown.push({ instance, home: row.home, reason: expected.problems[0].message });
      else if (expected.brokerRequired) items.push({ instance, home: row.home, registered: status ? statusListsHome(status, row.home) : null });
    }
    homes = { known: true, items, unknown };
  }
  return { ok: true, unit, daemon, homes };
}

const lines = (warnings) => warnings.map((w) => `WARN ${w.code}: ${w.message}\n`).join("");
function renderText(result, verb) {
  if (verb === "install" && result.plan) return `PLAN wake broker (${result.unit.manager} unit ${result.unit.path}, ${result.unit.changed ? "written" : "unchanged"})\n--- unit\n${result.text}--- actions\n${result.actions.map((a) => `  ${a}\n`).join("")}${lines(result.warnings)}`;
  if (verb === "install") return `PASS wake broker ${result.daemon.version} (${result.unit.manager} unit ${result.unit.path})\n${lines(result.warnings)}`;
  if (verb === "uninstall" && result.plan) return `PLAN remove wake broker unit ${result.unit.path}\n${result.actions.length ? result.actions.map((a) => `  ${a}\n`).join("") : "  nothing to remove\n"}`;
  if (verb === "uninstall") return result.unit.removed ? `PASS wake broker unit removed (${result.unit.path})\n` : `PASS no wake broker unit at ${result.unit.path}\n`;
  const { unit, daemon, homes } = result;
  const out = [];
  out.push(!unit.manager ? "unit: none on this platform"
    : unit.present ? `unit: ${unit.path} runs ${unit.aw ?? "an unreadable aw"}${unit.awCurrent === true ? " (the aw on PATH)" : unit.awCurrent === false ? ` (not the aw on PATH: ${unit.awOnPath ?? "none"}; rerun oats aweb wake install)` : ""}`
    : `unit: absent (${unit.path})`);
  for (const o of unit.others) out.push(`other wake unit: ${o.path}`);
  out.push(!daemon.readable ? "daemon: aw wake status could not be read"
    : daemon.running ? `daemon: running ${daemon.version ?? "an unreported version"} (pid ${daemon.pid ?? "unknown"})${daemon.floor.ok === false ? `, below the aw floor ${AW_MIN}` : ""}` : "daemon: not running");
  if (!homes.known) out.push(`homes: unknown (${homes.reason})`);
  else {
    out.push(`homes needing the broker: ${homes.items.length}`);
    for (const h of homes.items) out.push(`  ${h.instance}: ${h.registered === true ? "registered" : h.registered === false ? "NOT registered" : "registration unknown"}`);
    for (const h of homes.unknown) out.push(`  ${h.instance}: unknown (${h.reason})`);
  }
  return out.join("\n") + "\n";
}

export async function wakeMain(argv, { env = process.env, platform = process.platform, print = (fd, text) => (fd === 1 ? process.stdout : process.stderr).write(text), ...rest } = {}) {
  const json = argv.includes("--json");
  let opts;
  try {
    opts = parseWakeArgs(argv);
    const settings = parseProviderSettings(env);
    const ctx = { env, platform, uid: process.getuid?.(), user: (() => { try { return userInfo().username; } catch { return env.USER || "<user>"; } })(), home: env.HOME || homedir(), xdgConfigHome: env.XDG_CONFIG_HOME || undefined, settings, ...rest };
    const result = opts.verb === "install" ? await installWake(opts, ctx) : opts.verb === "uninstall" ? uninstallWake(opts, ctx) : await wakeStatus(opts, ctx);
    print(1, json ? JSON.stringify(result) + "\n" : renderText(result, opts.verb));
    return 0;
  } catch (e) {
    const known = typeof e.code === "string" && (e.code.startsWith("E_WAKE_") || e.code === "E_AW_FLOOR");
    const code = known ? e.code : "E_WAKE_FAILED", message = known ? e.message : `oats aweb wake failed: ${e.message || e}`;
    if (json) print(1, JSON.stringify({ ok: false, ...(opts?.plan ? { plan: true } : {}), error: { code, message } }) + "\n");
    else print(2, code === "E_WAKE_ARGUMENT" ? `${message}\n` : `FAIL ${code}: ${message}\n`);
    return code === "E_WAKE_ARGUMENT" ? 2 : 1;
  }
}
