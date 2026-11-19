// The floors that keep a home's aweb task claims present. aweb takes over a
// claim whose presence heartbeat has gone stale, and what heartbeats depends on
// how the home receives:
// - a home the host wake daemon serves (listed in `aw wake status`): the
//   daemon, from aw 1.36.54, for the identities it streams;
// - a Claude channel home: the aweb-channel plugin, from 1.8.2;
// - a pi channel home: the aweb pi extension, @awebai/pi, from 0.4.1.
// A component below its floor still receives, so each is a warning, never a
// refusal. Joined teams that only poll have no heartbeat yet and get nothing.
//
// Everything here is read-only and bounded. A version that cannot be read gives
// no item: the floors apply where the version is readable. Nothing here reads
// oats.aweb's metadata or files: only aw's status, the kernel's launch record
// (instance.json `launch.harness`, `harness`, `launch.env`) and the installs.
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parseVersion, versionAtLeast } from './version.mjs';

/** The aw whose wake daemon heartbeats claims: the final release, so its
 *  release candidates are below it. */
export const TASKS_WAKE_FLOOR = '1.36.54';
/** The aweb-channel plugin and the aweb pi extension that heartbeat presence. */
export const AWEB_CHANNEL_FLOOR = '1.8.2';
export const PI_EXTENSION_FLOOR = '0.4.1';

/** oats.aweb's AW_MIN (lib/aw-floor.mjs), copied because this module cannot
 *  import it. Below it, oats.aweb's own readiness warns `wake-daemon-outdated`
 *  for a home the daemon lists, so this check adds no second item there
 *  (wakeDaemonWarning). */
export const AW_MIN = '1.36.33';

export const AWEB_CHANNEL_PLUGIN = 'aweb-channel@awebai-marketplace';
export const PI_EXTENSION_PACKAGE = '@awebai/pi';

const MAX_FILE = 1 << 20;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pathValue = (v) => typeof v === 'string' && v !== '' && v.trim() === v && isAbsolute(v) && !v.includes('\0');
const canon = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// Opening never blocks (a FIFO at the path) and never follows a link swapped in
// after the path was resolved; the descriptor is then checked to be a file.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** JSON from `file`, read only when it resolves to a regular file inside
 *  `base` (no link out of it) of at most 1 MiB; undefined otherwise.
 *  oats.aweb's lib/pi-extension.mjs carries a copy, held equal by
 *  test/pi-extension-skills.test.mjs. */
export function readJsonInside(base, file) {
  let fd;
  try {
    const root = realpathSync(base), real = realpathSync(file);
    if (real !== root && !real.startsWith(root + sep)) return undefined;
    fd = openSync(real, OPEN_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) { const n = readSync(fd, buf, read, st.size - read, read); if (!n) break; read += n; }
    return JSON.parse(buf.subarray(0, read).toString('utf8'));
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** The kernel's record of the home's last start: the harness it launched
 *  (`launch.harness`, else `harness`) and the launch environment. undefined
 *  when the home has no readable launch record. */
export function recordedLaunch(home) {
  const doc = readJsonInside(home, join(home, 'instance.json'));
  if (!object(doc?.launch)) return undefined;
  const id = (v) => typeof v === 'string' && v ? v : undefined;
  return { runtime: id(doc.launch.harness) ?? id(doc.harness), env: object(doc.launch.env) ? doc.launch.env : {} };
}

/** The row of `aw wake status --json` that lists `home`, or undefined. */
export function statusRow(status, home) {
  if (!pathValue(home) || !Array.isArray(status?.instances)) return undefined;
  const want = canon(home);
  return status.instances.find((row) => object(row) && pathValue(row.home) && canon(row.home) === want);
}

/** Which floors apply to a check's context: a list of 'wake-daemon',
 *  'aweb-channel' and 'pi-extension'.
 *  - A soul has no home and none apply. The check receives only
 *    oats.aweb-tasks's settings, so it cannot tell whether the soul's delivery
 *    is the broker; the home's own readiness warns after spawn.
 *  - A home the status lists: the daemon. A native row also names its channel:
 *    the daemon streams only that home's joined teams, and the plugin or
 *    extension keeps the primary identity present.
 *  - A home it does not list (or an unreadable status): the kernel's harness
 *    alone picks, claude the plugin and pi the extension; anything else gets
 *    nothing. The record holds no delivery this check may read, so a Claude or
 *    pi home on `delivery: session` that is missing from the broker gets the
 *    plugin or extension warning too: harmless, since its missing registration
 *    is oats.aweb's own readiness problem, as a Codex home's is. */
export function claimFloors(context, { status, launch } = {}) {
  if (!context?.home) return [];
  const row = statusRow(status, context.home);
  if (row) {
    const native = row.runtime_delivery === 'native-channel' ? ['aweb-channel'] : row.runtime_delivery === 'native-pi' ? ['pi-extension'] : [];
    return ['wake-daemon', ...native];
  }
  return launch?.runtime === 'claude' ? ['aweb-channel'] : launch?.runtime === 'pi' ? ['pi-extension'] : [];
}

/** The wake daemon's warning for a home the status lists, or undefined. Only a
 *  running daemon that reports a semver version at or above AW_MIN and below
 *  TASKS_WAKE_FLOOR warns. oats.aweb registers a home with the broker exactly
 *  when it needs it, and its readiness then reads the daemon, so below AW_MIN
 *  oats.aweb warns `wake-daemon-outdated` for this home itself. The edge left:
 *  a stale registration oats.aweb no longer expects, where neither warns below
 *  AW_MIN. A daemon that is not running or reports no readable version adds
 *  nothing: oats.aweb reports not-running and unknown where it needs the
 *  broker. */
export function wakeDaemonWarning(status) {
  if (!object(status) || status.daemon_running !== true || status.daemon_version_state !== 'reported') return undefined;
  const version = status.daemon_version;
  if (!parseVersion(version) || !versionAtLeast(version, AW_MIN) || versionAtLeast(version, TASKS_WAKE_FLOOR)) return undefined;
  return { code: 'wake-daemon-outdated',
    message: `oats.aweb-tasks: host wake daemon is running ${version}; aweb task claims need aw ${TASKS_WAKE_FLOOR} or later, whose wake daemon heartbeats claims: upgrade aw, then restart the host wake daemon (\`oats aweb wake install\`)` };
}

/** The Claude config dir the home launches with: its literal absolute
 *  CLAUDE_CONFIG_DIR, else HOME's .claude when the launch sets none; undefined
 *  for any other value (a {fromEnv} reference). */
export function claudeConfigDir(launch, env = process.env) {
  if (!launch) return undefined;
  if (!Object.hasOwn(launch.env, 'CLAUDE_CONFIG_DIR')) return pathValue(env.HOME) ? join(env.HOME, '.claude') : undefined;
  return pathValue(launch.env.CLAUDE_CONFIG_DIR) ? launch.env.CLAUDE_CONFIG_DIR : undefined;
}

/** The pi folder the home launches with: its literal PI_CODING_AGENT_DIR
 *  (absolute, or under ~, which pi expands against HOME), else HOME's
 *  .pi/agent; undefined for any other value. */
export function piAgentDir(launch, env = process.env) {
  if (!launch) return undefined;
  const userHome = pathValue(env.HOME) ? env.HOME : undefined;
  if (!Object.hasOwn(launch.env, 'PI_CODING_AGENT_DIR')) return userHome && join(userHome, '.pi', 'agent');
  const dir = launch.env.PI_CODING_AGENT_DIR;
  if (typeof dir === 'string' && /^~(?=$|\/)/.test(dir)) return userHome && join(userHome, dir.slice(1));
  return pathValue(dir) ? dir : undefined;
}

/** The aweb-channel version Claude installed in `configDir`: the user-scope
 *  entry for aweb-channel@awebai-marketplace in plugins/installed_plugins.json.
 *  A project- or local-scope install is not read. undefined when unreadable. */
export function awebChannelVersion(configDir) {
  if (!configDir) return undefined;
  const doc = readJsonInside(configDir, join(configDir, 'plugins', 'installed_plugins.json'));
  const entries = object(doc?.plugins) && Array.isArray(doc.plugins[AWEB_CHANNEL_PLUGIN]) ? doc.plugins[AWEB_CHANNEL_PLUGIN] : [];
  const user = entries.filter((e) => object(e) && e.scope === 'user');
  return user.length === 1 && parseVersion(user[0].version) ? user[0].version : undefined;
}

/** The @awebai/pi version pi installed for `agentDir`: pi puts a user-scope npm
 *  package in <agentDir>/npm/node_modules/<name> (pi 1.3.0
 *  getManagedNpmInstallPath), and its package.json holds the version. pi's
 *  older global-npm location and a project-scope install are not read.
 *  undefined when unreadable. oats.aweb's lib/pi-extension.mjs carries a copy
 *  (it gates pi-extension-skills-loaded), held equal by
 *  test/pi-extension-skills.test.mjs. */
export function piExtensionVersion(agentDir) {
  if (!agentDir) return undefined;
  const base = join(agentDir, 'npm', 'node_modules');
  const doc = readJsonInside(base, join(base, ...PI_EXTENSION_PACKAGE.split('/'), 'package.json'));
  return doc?.name === PI_EXTENSION_PACKAGE && parseVersion(doc.version) ? doc.version : undefined;
}

const restart = (home) => `then restart the home (\`oats session restart --home ${home}\`)`;

/** The aweb-channel plugin's warning for the version installed, or undefined. */
export function awebChannelWarning(version, home) {
  if (!parseVersion(version) || versionAtLeast(version, AWEB_CHANNEL_FLOOR)) return undefined;
  return { code: 'aweb-channel-outdated',
    message: `oats.aweb-tasks: aweb task claims on this Claude home are kept present by the aweb-channel plugin, which needs ${AWEB_CHANNEL_FLOOR} or later (installed: ${version}): update the plugin, ${restart(home)}` };
}

/** The aweb pi extension's warning for the version installed, or undefined. */
export function piExtensionWarning(version, home) {
  if (!parseVersion(version) || versionAtLeast(version, PI_EXTENSION_FLOOR)) return undefined;
  return { code: 'pi-extension-outdated',
    message: `oats.aweb-tasks: aweb task claims on this pi home are kept present by the aweb pi extension (${PI_EXTENSION_PACKAGE}), which needs ${PI_EXTENSION_FLOOR} or later (installed: ${version}): update the extension, ${restart(home)}` };
}

/** The environment of the aw call: this check's own OATS_* removed (as for its
 *  kernel calls), and no inherited AWEB_IDENTITY_HOME, the caller's identity.
 *  aw resolves the host daemon the same way from any identity. */
function awEnv(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('OATS_') && k !== 'AWEB_IDENTITY_HOME'));
  return { ...out, AW_NO_UPDATE_CHECK: '1' };
}

/** `aw wake status --json` run in `cwd`, bounded by `timeout` ms: the parsed
 *  document, or undefined when it cannot be read in time. */
export function readWakeStatus({ cwd, timeout, env = process.env, run = spawnSync } = {}) {
  const r = run('aw', ['wake', 'status', '--json'], { cwd, env: awEnv(env), encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.signal || r.status !== 0) return undefined;
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return undefined; }
}

/** The claim-floor warnings for a home: reads the home's launch record, the
 *  status (`readStatus()`, undefined when it cannot be read in time) and each
 *  applying component's version. A soul reads nothing. */
export function claimFloorWarnings(context, { readStatus, env = process.env } = {}) {
  if (!context?.home) return [];
  const status = readStatus();
  const launch = recordedLaunch(context.home);
  const warnings = [];
  for (const floor of claimFloors(context, { status, launch })) {
    const w = floor === 'wake-daemon' ? wakeDaemonWarning(status)
      : floor === 'aweb-channel' ? awebChannelWarning(awebChannelVersion(claudeConfigDir(launch, env)), context.home)
      : piExtensionWarning(piExtensionVersion(piAgentDir(launch, env)), context.home);
    if (w) warnings.push(w);
  }
  return warnings;
}
