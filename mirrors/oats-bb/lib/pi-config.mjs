// Nothing in bb's pi may hold the agent's mail stream (contract r23, A12(3)).
//
// A bb pi home's mail is delivered by the host wake broker, which presents it as an input
// to the home's thread. bb starts more pi processes than the thread's: a hidden one per
// bridge worker that lists models (its "catalog" pi), with the home as its working
// directory and every user extension loaded. With the aweb extension for pi (@awebai/pi)
// in the pi configuration bb's server runs with, each of them connects to aweb as the
// agent: the hidden one takes the mail as a turn nobody sees (seen at bb-app 0.50.1, pi
// 1.5.2), beside the broker. And without @awebai/oats-pi there, pi loads none of the
// home's skills, and nothing says so.
//
// So a pi launch is refused unless the pi configuration bb's server runs with lists
// @awebai/oats-pi, and does not list @awebai/pi. That configuration is the operator's, or
// the team image's, to set: the provider only reads it, and never changes it. One other
// state is accepted beside an @awebai/pi that is listed: AWEB_DELIVERY among the
// variables bb sets for every process it runs (its machine env), which silences the
// extension in bb's pi processes and reaches no pi outside bb. bb shows no value of its
// env, so the name is what can be read; the remedy names the value.
//
// Which directory that configuration is, bb does not say, and the provider cannot read the
// bb server's own environment: `settings.oats.bb.piAgentDir` names it (pi's
// PI_CODING_AGENT_DIR as bb's server has it; default: .pi/agent in the home of the user
// that runs bb). What is read there is settings.json's `packages`, by the packages' npm
// names. A package installed from a local path or a git URL, or an extension loaded by an
// `extensions` entry or dropped into the directory, is not recognised by name.
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isObject } from "./errors.mjs";

export const PI_BRIDGE = "@awebai/oats-pi";
export const PI_AWEB_EXTENSION = "@awebai/pi";
export const DELIVERY_VARIABLE = "AWEB_DELIVERY";
const READ_MAX = 1024 * 1024;

/** Whether a `packages` entry of pi's settings names the npm package: a plain string or an
 *  object's `source`, `npm:<name>` with or without a version. */
function names(entry, name) {
  const source = typeof entry === "string" ? entry : isObject(entry) && typeof entry.source === "string" ? entry.source : null;
  if (source === null || !source.startsWith("npm:")) return false;
  const spec = source.slice("npm:".length);
  return spec === name || spec.startsWith(`${name}@`);
}

/** `<agentDir>/settings.json` as pi's settings. → { doc, changedMs } (`doc` null for a
 *  directory with no settings.json; `changedMs`: when the file last changed, its content
 *  or its place, in milliseconds), or { unreadable: <why> } for a file that is there and
 *  cannot be read as pi's settings. */
function readPiSettings(agentDir) {
  const file = join(agentDir, "settings.json");
  let fd;
  try {
    // Never blocks on a FIFO at the path; the descriptor is then checked to be a file.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { unreadable: "it is not a regular file" };
    if (stat.size > READ_MAX) return { unreadable: `it is larger than ${READ_MAX} bytes` };
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) { const n = readSync(fd, bytes, read, stat.size - read, read); if (n === 0) break; read += n; }
    let doc;
    try { doc = JSON.parse(bytes.subarray(0, read).toString("utf8")); } catch { return { unreadable: "it is not JSON" }; }
    if (!isObject(doc)) return { unreadable: "it is not a JSON object" };
    return { doc, changedMs: Math.max(stat.mtimeMs, stat.ctimeMs) };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { doc: null, changedMs: null };
    return { unreadable: `it cannot be read (${error?.code ?? "an error"})` };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** What `<agentDir>/settings.json` says of the two packages. → { bridge, listener } (each
 *  true when listed), or { unreadable: <why> } for a file that is there and cannot be
 *  read as pi's settings. A directory with no settings.json lists nothing. */
export function readPiPackages(agentDir) {
  const { doc, unreadable } = readPiSettings(agentDir);
  if (unreadable !== undefined) return { unreadable };
  if (doc === null) return { bridge: false, listener: false };
  if (doc.packages !== undefined && !Array.isArray(doc.packages)) return { unreadable: "its packages is not a list" };
  const packages = doc.packages ?? [];
  return { bridge: packages.some((entry) => names(entry, PI_BRIDGE)), listener: packages.some((entry) => names(entry, PI_AWEB_EXTENSION)) };
}

export const absolutePath = (value) => typeof value === "string" && isAbsolute(value) && !value.includes("\0");
/** Why bb's list of pi's models may not be all the models a thread in `home` can start on,
 *  or null where nothing says it is not (lib/pi-model.mjs). bb lists only the models pi's
 *  `enabledModels` names (pi 1.5.2, docs/settings.md), and a thread still starts on any
 *  model pi has. bb's pi reads that setting when bb starts it and keeps it while it lives
 *  (seen at bb-app 0.50.1: a list stays narrowed after the setting is removed, at least
 *  while bb's pi is in use), so the file as it is now proves nothing by itself: the list is whole only
 *  where the file sets no `enabledModels` AND has not changed since this bb started
 *  (`startedAt` of bb-app's own bb-app-runtime.json in its data directory). Whatever
 *  cannot be read counts against the list, never for it. And a home with a pi
 *  configuration of its own (`<home>/.pi`) may give its thread models that bb, which
 *  lists with no project, does not show. → null | <short why>. */
export function piListMayBePartial(agentDir, { dataDir, server, home = null } = {}) {
  const { doc, changedMs, unreadable } = readPiSettings(agentDir);
  if (unreadable !== undefined) return "pi's settings could not be read, and they may narrow the list";
  if (doc !== null && doc.enabledModels !== undefined && doc.enabledModels !== null && !(Array.isArray(doc.enabledModels) && doc.enabledModels.length === 0)) {
    return "pi's enabledModels setting narrows the list to the models it names";
  }
  // With no settings.json nothing says when one was removed: never the case of a pi launch
  // that got this far (it lists the bridge), and not taken for a whole list.
  const started = bbStartedMs(dataDir, server);
  if (doc === null || started === null || !(started > changedMs)) return "pi's settings changed after bb started, or when bb started cannot be read, and bb lists by the settings its pi started with";
  if (typeof home === "string" && isAbsolute(home) && existsSync(join(home, ".pi"))) return "the home has a pi configuration of its own (.pi), which bb's list does not read";
  return null;
}

// How long bb's server serves a list of pi's models it has fetched, as it is (bb-app
// 0.50.1: 60 s), and a margin.
const LIST_AGE_MS = 90_000;
// What gives pi its models, in the pi configuration bb's server runs with (pi 1.5.2): its
// settings, its own providers and models, its logins. (Not the directory's own time: every
// pi that starts moves it, bb's own included. pi writes auth.json itself: when it first
// runs, and when it renews a login.)
const PI_MODEL_FILES = ["settings.json", "models.json", "auth.json"];

/** Why bb's list of pi's models may be older than pi's configuration, or null. bb's
 *  server keeps the list it fetched and serves it as it is for a minute (bb-app 0.50.1),
 *  so a model added to pi a moment ago, or a provider removed, is not in it yet, while a
 *  thread starts by what pi has now. Where any of the files that give pi its models
 *  changed (content or place: mtime and ctime) less than a minute and a half before
 *  `now`, or one of them cannot be looked at, the list proves nothing for or against a
 *  model. → null | <short why>.
 *  (Not covered, and nothing shows it: where bb's refresh of its list fails, bb serves
 *  the list it kept, of any age. And a file that was REMOVED a moment ago: it has no time
 *  left to read, and the directory's own cannot stand in for it, since every pi that
 *  starts moves that.) */
export function piListMayBeOld(agentDir, now = Date.now()) {
  for (const name of PI_MODEL_FILES) {
    let stat;
    try { stat = statSync(join(agentDir, name)); }
    catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      return "when pi's configuration last changed cannot be read, and bb's list may be older than it";
    }
    if (now - Math.max(stat.mtimeMs, stat.ctimeMs) < LIST_AGE_MS) return "pi's configuration changed a moment ago, and bb's list may be older than it";
  }
  return null;
}

/** When the bb that serves `server` started, by bb-app's own record in its data directory
 *  (`<dataDir>/bb-app-runtime.json`: {serverUrl, startedAt, …}, bb-app 0.50.1), in
 *  milliseconds; null where the record is not there, cannot be read, or is another
 *  server's. */
function bbStartedMs(dataDir, server) {
  if (!absolutePath(dataDir) || typeof server !== "string") return null;
  try {
    const record = JSON.parse(readFileSync(join(dataDir, "bb-app-runtime.json"), "utf8"));
    if (!isObject(record) || typeof record.serverUrl !== "string" || typeof record.startedAt !== "string") return null;
    const [theirs, mine] = [new URL(record.serverUrl), new URL(server)];
    if (theirs.protocol !== mine.protocol || theirs.port !== mine.port) return null;
    const at = Date.parse(record.startedAt);
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}
/** What a `piAgentDir` that is no absolute path is answered with: by every launch and every
 *  readiness read, as a setting of the wrong shape (the value is not shown). */
export const PI_AGENT_DIR_SHAPE = Object.freeze({ code: "E_BACKEND_SETTINGS", status: "needs-configuration", message: "settings.oats.bb.piAgentDir must be an absolute path: the pi configuration directory bb's server runs pi with (its PI_CODING_AGENT_DIR). Set it in oats-local.yaml, or remove it for the default (.pi/agent in the home of the user that runs bb)" });

/** Why bb's pi must not run an OATS home now, by its configuration. `agentDir` is an
 *  absolute path: its shape is the caller's to refuse (PI_AGENT_DIR_SHAPE). `globalEnvNames()` →
 *  the names of bb's machine env, asked only when @awebai/pi is listed; it may throw a
 *  ProviderError, which the caller turns into its own problem. → problems
 *  [{code, status, message}] in the order a person would fix them. */
export async function piConfigurationProblems(agentDir, globalEnvNames) {
  // In each message: what is wrong, the remedy, and last the file that was read, which may be
  // long: the kernel relays 500 characters, and a cut must take the path, never the remedy.
  const found = readPiPackages(agentDir);
  if (found.unreadable !== undefined) {
    return [{ code: "E_BACKEND_NOT_READY", status: "needs-configuration", message: `bb's pi configuration cannot be checked: its settings.json is there and ${found.unreadable}. A pi launch needs ${PI_BRIDGE} listed there and ${PI_AWEB_EXTENSION} not: fix the file, or point settings.oats.bb.piAgentDir at the directory bb's server uses. Read: ${join(agentDir, "settings.json")}` }];
  }
  const problems = [];
  if (!found.bridge) {
    problems.push({ code: "E_BACKEND_NOT_READY", status: "needs-configuration", message: `bb's pi would load none of the home's skills, and nothing would say so: ${PI_BRIDGE} is not in bb's pi configuration. Install it there (PI_CODING_AGENT_DIR=<that directory> pi install npm:${PI_BRIDGE}), or point settings.oats.bb.piAgentDir at the directory bb's server uses (in the team image for bb: /state/home/.bb-pi). Read: ${join(agentDir, "settings.json")}` });
  }
  if (found.listener && !(await globalEnvNames()).includes(DELIVERY_VARIABLE)) {
    // The remedy before the path, which may be long: the kernel relays 500 characters.
    problems.push({ code: "E_BACKEND_PI_LISTENER", status: "needs-configuration", message: `bb's pi would take this agent's mail: ${PI_AWEB_EXTENSION} is in bb's pi configuration, and every pi bb starts (a hidden one too) connects to aweb as the agent. Give bb's server a pi configuration without it (PI_CODING_AGENT_DIR, and settings.oats.bb.piAgentDir), or silence it in bb's processes only: printf session | bb machine env set ${DELIVERY_VARIABLE}. Read: ${join(agentDir, "settings.json")}` });
  }
  return problems;
}
