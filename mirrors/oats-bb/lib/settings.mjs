// The provider's settings (`settings.oats.bb`): where bb is, which bb, and who can reach it.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fail, isObject } from "./errors.mjs";

const DEFAULT_SERVER = "http://127.0.0.1:38886";
// bb's host daemon listens on 38887 unless bb-app was started with --host-daemon-port.
export const DEFAULT_DAEMON_PORT = 38887;
const DEFAULT_DAEMON = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
const DEFAULT_CLI = "bb";
export const TRUST_VALUES = Object.freeze(["single-user", "container"]);

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** True for the hosts that can only name this machine's loopback: 127.0.0.0/8, ::1 and
 *  `localhost`. Nothing is resolved: a name that needs DNS is not loopback here. */
export function isLoopbackHost(hostname) {
  const host = String(hostname).toLowerCase();
  return host === "localhost" || host === "[::1]" || host === "::1" || LOOPBACK_V4.test(host);
}

/** A bb address as its origin (`http://127.0.0.1:38886`), or a refusal: E_BACKEND_SETTINGS
 *  when it is not a plain http(s) origin, E_BACKEND_EXPOSED when it names a host off
 *  loopback (bb's API has no login: the provider only ever talks to it on loopback).
 *  A refusal never repeats the value: a URL may carry a user and a password. */
export function loopbackOrigin(value, name) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.${name} is not a URL (the value is not shown: it could hold a credential)`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.${name} must be an http or https URL (the value is not shown: it could hold a credential)`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    const extra = [url.username || url.password ? "a user or password" : null, url.pathname !== "/" && url.pathname !== "" ? "a path" : null, url.search ? "a query" : null, url.hash ? "a fragment" : null].filter(Boolean).join(", ");
    throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.${name} must be a bare origin (scheme, host and port), and it has ${extra} (the value is not shown: it could hold a credential)`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw fail("E_BACKEND_EXPOSED", `settings.oats.bb.${name} names ${url.hostname}, which is not loopback: bb's API has no login, so this provider reaches bb only on 127.0.0.1, ::1 or localhost (a Tailscale Serve route in front of a loopback bb is fine)`);
  }
  return url.origin;
}

/** `settings.oats.bb.hostDaemonPort`: the port of this bb's host daemon, where it is not
 *  bb's default (contract A23). An integer from 1 to 65535, or unset (null). Anything else
 *  is refused, never dropped: a port that was meant and is not passed would aim every bb
 *  command at another bb's daemon. */
function hostDaemonPortOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.hostDaemonPort must be a whole number from 1 to 65535 (the port bb-app was started with: its --host-daemon-port), written as a number, not as text; it is ${typeof value === "string" ? "text" : typeof value === "number" ? String(value) : `a ${Array.isArray(value) ? "list" : typeof value}`}`);
  }
  return value;
}

export function portOf(origin) {
  const url = new URL(origin);
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/** The settings with their defaults, shapes checked. `trust` and `version` stay as given
 *  (possibly absent): readiness names what is missing. The addresses are checked where
 *  they are used, so a refusal there carries its own code.
 *
 *  `hostDaemonPort` and `daemon` name one thing, this bb's host daemon: the port bb's CLI
 *  is told to find it at (BB_HOST_DAEMON_PORT), and the address its /status is read at.
 *  Where only the port is set, the address is that port on 127.0.0.1; where both are set
 *  and name different ports, that is refused. `daemonKey` is the setting that decided the
 *  address, for a message that must name what to change: "daemon", "hostDaemonPort", or
 *  null where neither is set and the address is bb's default. */
export function readSettings(raw) {
  if (raw !== undefined && raw !== null && !isObject(raw)) throw fail("E_BACKEND_SETTINGS", "settings.oats.bb must be a map");
  const given = raw ?? {};
  const text = (key, fallback) => {
    const value = given[key];
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value !== "string") throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.${key} must be a string`);
    return value;
  };
  const cli = text("cli", DEFAULT_CLI);
  if (/[\\/]/.test(cli) && !isAbsolute(cli)) throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.cli must be a command name on PATH or an absolute path, got ${JSON.stringify(cli)}`);
  // bb's data directory (bb-app's --data-dir): bb does not say where it is. Its default
  // is `.bb` in the home of the user that runs bb, who is the user this provider runs as.
  // Read only for a launch in a sandboxed mode, which checks its shape there: a value
  // that is wrong holds up no other verb.
  const dataDir = text("dataDir", join(homedir(), ".bb")).replace(/(?<=.)\/+$/, "");
  // The pi configuration directory bb's server runs pi with (pi's PI_CODING_AGENT_DIR, as bb's
  // server has it): bb does not say which it is. pi's default is `.pi/agent` in the home of the
  // user that runs it. Read only for a pi launch and its readiness, which check its shape.
  const piAgentDir = text("piAgentDir", join(homedir(), ".pi", "agent")).replace(/(?<=.)\/+$/, "");
  const hostDaemonPort = hostDaemonPortOf(given.hostDaemonPort);
  const daemonGiven = text("daemon", null);
  if (hostDaemonPort !== null && daemonGiven !== null) {
    // Only where the address reads as one: a `daemon` that is no URL is readiness's to refuse, with its own words.
    let port = null;
    try { port = portOf(new URL(daemonGiven).origin); } catch { /* refused where it is used */ }
    if (port !== null && port !== hostDaemonPort) {
      throw fail("E_BACKEND_SETTINGS", `settings.oats.bb.hostDaemonPort is ${hostDaemonPort} and settings.oats.bb.daemon names port ${port}: they are the same host daemon. Set hostDaemonPort alone (the daemon's address follows it), or make the two agree`);
    }
  }
  return {
    server: text("server", DEFAULT_SERVER),
    daemon: daemonGiven ?? (hostDaemonPort !== null ? `http://127.0.0.1:${hostDaemonPort}` : DEFAULT_DAEMON),
    daemonKey: daemonGiven !== null ? "daemon" : hostDaemonPort !== null ? "hostDaemonPort" : null,
    hostDaemonPort,
    version: text("version", null),
    trust: text("trust", null),
    cli,
    dataDir,
    piAgentDir,
  };
}
