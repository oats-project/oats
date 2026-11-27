// What a launch writes into the home's `.claude/settings.local.json`, and nothing else of
// Claude's does the provider write (contract item 6):
//
// - `env`: the launch environment. Claude Code applies it to its own process, its tools
//   and its hooks; bb runs Claude with the `local` setting source and cwd = the home, so
//   nothing of it reaches bb's database. No secret goes into the file.
// - `sandbox.network.allowedDomains` and `sandbox.filesystem.allowWrite`: in bb's
//   sandboxed modes (auto, accept-edits), exactly the hosts and paths the kernel hands
//   the launch, which are the ones OATS's own messaging, knowledge, tasks and events need.
//   Claude Code adds them to bb's own sandbox settings; they never replace a restriction.
//
// - `permissions.deny` and `permissions.blockWritesOutsideWorkingDirectories`: in the
//   sandboxed modes, the rules that keep the agent's tools off what runs outside its
//   sandbox (lib/deny.mjs), and the switch that keeps Claude's file tools in.
//
// In a bb home these four keys are the provider's, whole: every launch rewrites them from
// the launch input and never reads what they held, and no record of them is kept in the
// home, which its agent can write. Every other key of the file is left as it is.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { ProviderError, fail, isObject } from "./errors.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Where a launch env entry may come from and still be written to a file: the kernel, a
// capability's hook (which must not return a secret) or a launch configuration's literal.
// A launch configuration's reference (fromEnv, fromFile) is a secret source; so is any
// source word this provider does not know.
const PLAIN_SOURCES = new Set(["kernel", "capability", "launch-config"]);

// bb's Claude runs with the Claude configuration and the account of bb's own server,
// never the launch's. A launch entry that would choose either cannot be honoured, and is
// refused rather than ignored (contract item 1, the preflights a provider launch skips).
const CONFIGURATION_NAMES = new Set(["CLAUDE_CONFIG_DIR"]);
// Which variables choose the account or the endpoint is Claude Code's list, and it grows
// (keys and tokens per cloud, base URLs, headers, sockets): so by pattern, not by name.
// Every ANTHROPIC_* variable does, but the ones that only pick a model.
const MODEL_NAMES = /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL.*|DEFAULT_.*_MODEL.*|CUSTOM_MODEL_OPTION.*)$/;
const ACCOUNT_NAMES = /^(ANTHROPIC_.*|CLAUDE_CODE_USE_.*|CLAUDE_CODE_API_.*|CLAUDE_CODE_OAUTH_.*|CLAUDE_CODE_SKIP_.*_AUTH|AWS_BEARER_TOKEN_BEDROCK)$/;
const choosesAccount = (name) => ACCOUNT_NAMES.test(name) && !MODEL_NAMES.test(name);
// A name a JSON map cannot carry as a plain entry.
const UNCARRIABLE = new Set(["__proto__"]);

/** The launch input's env as a name → value map, or a refusal naming the entry
 *  (E_BACKEND_LAUNCH_ENV): one that would choose Claude's configuration or account, one
 *  from a secret source or marked secret (it would sit in a file and in Claude's process,
 *  for every tool to read), or one this file cannot carry. The value is never part of a
 *  message. */
export function readLaunchEnv(env) {
  if (env === undefined || env === null) return {};
  if (!Array.isArray(env)) throw fail("E_BACKEND_LAUNCH_ENV", "the launch env must be a list of {name, value, source}");
  const out = {};
  for (const entry of env) {
    if (!isObject(entry) || typeof entry.name !== "string") throw fail("E_BACKEND_LAUNCH_ENV", "a launch env entry has no name");
    const from = typeof entry.source === "string" && entry.source ? ` (source ${entry.source}${typeof entry.capability === "string" ? `, ${entry.capability}` : ""})` : "";
    if (!NAME.test(entry.name) || UNCARRIABLE.has(entry.name)) throw fail("E_BACKEND_LAUNCH_ENV", `the launch env entry ${JSON.stringify(entry.name)}${from} is not a variable name the bb backend can carry`);
    if (CONFIGURATION_NAMES.has(entry.name)) {
      throw fail("E_BACKEND_LAUNCH_ENV", `the launch sets ${entry.name}${from}, which the bb backend cannot honour: a bb thread's Claude loads the user settings and hooks of the Claude configuration bb's server runs with. Remove it from the launch`);
    }
    if (choosesAccount(entry.name)) {
      throw fail("E_BACKEND_LAUNCH_ENV", `the launch sets ${entry.name}${from}, which would choose Claude's account or endpoint: a bb thread runs on the account of bb's own server. Remove it from the launch, or give bb's server the credential in its own environment`);
    }
    const why = entry.secret === true || entry.source === "launch-config-reference" ? "comes from a secret source"
      : entry.secret !== undefined && entry.secret !== false ? "has a secret mark that is neither true nor false"
      : !PLAIN_SOURCES.has(entry.source) ? "has no source this backend knows to be free of secrets" : null;
    if (why !== null) {
      throw fail("E_BACKEND_LAUNCH_ENV", `the launch env entry ${entry.name}${from} ${why}: the bb backend carries launch env in the home's .claude/settings.local.json and puts no secret there. Remove it from the launch, or give bb's server the credential in its own environment`);
    }
    if (typeof entry.value !== "string" || /[\0\n\r]/.test(entry.value)) throw fail("E_BACKEND_LAUNCH_ENV", `the launch env entry ${entry.name}${from} is not a one-line string`);
    if (Object.hasOwn(out, entry.name)) throw fail("E_BACKEND_LAUNCH_ENV", `the launch env names ${entry.name} twice`);
    out[entry.name] = entry.value;
  }
  return out;
}

/** The names a launch leaves out on purpose (`unset`): they must not reach the process
 *  from an earlier launch, from a person's own entry, or from the environment bb's server
 *  was started with (which bb's Claude inherits). A settings file can set a variable but
 *  not remove one, so each is written with an empty value: the nearest thing to unset
 *  that can be carried, and never the inherited value. */
export function readUnset(unset, env) {
  if (unset === undefined || unset === null) return [];
  if (!Array.isArray(unset) || unset.some((name) => typeof name !== "string" || !NAME.test(name) || UNCARRIABLE.has(name))) throw fail("E_BACKEND_LAUNCH_ENV", "the launch's unset must be a list of variable names the bb backend can carry");
  // An empty value under one of these names would take from bb's Claude the configuration
  // or the credential bb's own server gives it.
  const chosen = unset.find((name) => CONFIGURATION_NAMES.has(name) || choosesAccount(name));
  if (chosen !== undefined) throw fail("E_BACKEND_LAUNCH_ENV", `the launch unsets ${chosen}, which the bb backend cannot honour: a bb thread's Claude takes its configuration and its account from bb's own server, and the launch can neither choose nor remove them`);
  const both = unset.find((name) => Object.hasOwn(env, name));
  if (both !== undefined) throw fail("E_BACKEND_LAUNCH_ENV", `the launch both sets and unsets ${both}`);
  return unset;
}

/** The directories a launch puts first on PATH (`pathPrepend`: the home's kernel shim
 *  directory, so the agent's plain `oats` is the kernel that launched it), carried as the
 *  env file's PATH: those directories, then the launch's own PATH entry when it has one,
 *  else the PATH this provider was called with (the kernel's, as a tmux pane would get
 *  it). → the env map with PATH set, or the map as it was when there is nothing to
 *  prepend. A directory that cannot go on a PATH is refused by name. */
export function withPathPrepend(env, pathPrepend, ambientPath) {
  if (pathPrepend === undefined || pathPrepend === null) return env;
  if (!Array.isArray(pathPrepend)) throw fail("E_BACKEND_LAUNCH_ENV", "the launch's pathPrepend must be a list of directories");
  for (const dir of pathPrepend) {
    if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes(delimiter) || /[\0\n\r]/.test(dir)) {
      throw fail("E_BACKEND_LAUNCH_ENV", `the launch's pathPrepend entry ${JSON.stringify(dir)} is not an absolute directory that can go on PATH`);
    }
  }
  if (pathPrepend.length === 0) return env;
  const base = Object.hasOwn(env, "PATH") ? env.PATH : typeof ambientPath === "string" ? ambientPath : "";
  return { ...env, PATH: [...pathPrepend, ...base.split(delimiter).filter((dir) => dir && !pathPrepend.includes(dir))].join(delimiter) };
}

const CAPABILITY_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
// A bare host: labels of letters, digits and dashes, an optional port. No wildcard, no
// scheme, no path, no user. An IPv4 address is such a host too.
const HOST = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

// What must never reach a message: control characters (C0, C1), line and paragraph
// separators, bidi overrides.
const UNPRINTABLE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const oneLine = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !UNPRINTABLE.test(value);
const SANDBOX_KEYS = ["domains", "write", "missing", "skipped", "unavailable"];
// The kernel relays at most 500 characters of a provider's message: what a message
// quotes is clipped so that the remedy and the counts always arrive.
const CAUSE_MAX = 240;
// Clipped text ends in "…", and never in half a surrogate pair.
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "")}…` : text);

/** The launch input's `sandbox`, as the kernel built it from recorded configuration:
 *
 *    {domains: [{host, capability, setting}], write: [{path, reason}],
 *     missing: [{capability, setting, team, optional, defaultTeam}]}
 *    or {unavailable: "<cause>"} when the kernel could not resolve the configuration.
 *  (`skipped: [{capability, reason}]` is read if it comes; the kernel does not send it.)
 *
 *  `missing`: what a slot provider's line named and the deployment has no value for (a
 *  team with no recorded service): a host the sandbox would need and cannot be given.
 *
 *  → {domains, write, missing, otherTeams, optional, skipped, unavailable, unnamed,
 *  unnamedOptional, unnamedSkipped}: `missing` the rows a sandboxed launch is refused for
 *  (the soul's default team, or a setting with no value at all), `otherTeams` the rows of
 *  its other teams, `optional` the optional ones, `unavailable` the cause or null, and the
 *  three counts of rows that cannot be named in a message (counted, so none is dropped).
 *
 *  The provider writes exactly `domains` and `write`, so in a sandboxed mode each entry must
 *  be what the lists may hold (an exact host, an exact absolute path):
 *  E_BACKEND_SANDBOX_HOST, E_BACKEND_SANDBOX_PATH. The rest is read by `sandboxed` too: a
 *  launch that will run in bb's sandbox must understand everything it is told (an unknown
 *  key, a `missing` that is no list refuse it). A full-mode launch writes nothing, so it is
 *  never refused for what this object holds: the two lists are not read at all, and the
 *  gaps are read only to be named by the check of that launch. A row that cannot be named is still a
 *  gap: counted, never dropped. */
export function readSandbox(sandbox, { sandboxed = true } = {}) {
  const empty = { domains: [], write: [], missing: [], otherTeams: [], optional: [], unnamed: 0, unnamedOptional: 0, unavailable: null, skipped: [], unnamedSkipped: 0 };
  if (sandbox === undefined || sandbox === null) return empty;
  if (!isObject(sandbox)) {
    if (!sandboxed) return empty;
    throw fail("E_SESSION_START_FAILED", "the launch input's sandbox is not an object");
  }
  // An unresolved configuration comes first: beside it nothing else is read (there are no
  // lists to write), whatever else the object holds. Its shape is not final: the cause is
  // a line, or an object with one under `message` or `cause`.
  // `false` and "" say "resolved": only a cause makes the configuration unavailable.
  if (sandbox.unavailable !== undefined && sandbox.unavailable !== null && sandbox.unavailable !== false && sandbox.unavailable !== "") {
    // Each part is clipped, never dropped for its length: only what cannot be shown is left out.
    const part = (value) => (typeof value === "string" && value.length > 0 && !UNPRINTABLE.test(value) ? clip(value, CAUSE_MAX) : null);
    const given = isObject(sandbox.unavailable) ? [part(sandbox.unavailable.code), part(sandbox.unavailable.message ?? sandbox.unavailable.cause)].filter(Boolean).join(": ") : part(sandbox.unavailable);
    return { ...empty, unavailable: given ? clip(given, CAUSE_MAX) : "no cause given" };
  }
  const unknown = Object.keys(sandbox).find((key) => !SANDBOX_KEYS.includes(key));
  if (unknown !== undefined && sandboxed) throw fail("E_SESSION_START_FAILED", `the launch input's sandbox has a key this provider does not know: ${oneLine(unknown, 60) ? unknown : "(unprintable)"}`);
  const list = (value, what, strict = true) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value;
    if (strict) throw fail("E_SESSION_START_FAILED", `the launch input's sandbox.${what} is not a list`);
    return [value]; // one thing that is no row: counted as a gap that cannot be named
  };
  const domains = !sandboxed ? [] : list(sandbox.domains, "domains").map((entry) => {
    const who = isObject(entry) && typeof entry.capability === "string" && entry.capability ? entry.capability : null;
    if (!isObject(entry) || !isExactHost(entry.host)) {
      throw fail("E_BACKEND_SANDBOX_HOST", `the launch asks the sandbox to allow ${JSON.stringify(isObject(entry) ? entry.host ?? null : entry)}${who ? ` (for ${who})` : ""}, which is not one exact host: no wildcard, scheme or path`);
    }
    if (who === null) throw fail("E_BACKEND_SANDBOX_HOST", `the launch asks the sandbox to allow ${entry.host} without saying which capability asked`);
    return { host: entry.host, capability: who, setting: typeof entry.setting === "string" ? entry.setting : null };
  });
  const write = !sandboxed ? [] : list(sandbox.write, "write").map((entry) => {
    const path = isObject(entry) ? entry.path : null;
    if (!isExactPath(path)) {
      throw fail("E_BACKEND_SANDBOX_PATH", `the launch asks the sandbox to allow writes to ${JSON.stringify(path)}, which is not one exact absolute path`);
    }
    return { path, reason: typeof entry.reason === "string" ? entry.reason : null };
  });
  // The launch input is the kernel's: a row is taken as given, checked only for what a
  // message can carry (the kernel's own rules decide what a team id is).
  const word = (value) => value === undefined || value === null || oneLine(value, 256);
  // Three kinds of row. Optional: the session works without that host. Another team's
  // (`defaultTeam: false`): the agent's own team is served, that team's mail is not. Every
  // other row, one without the mark included, is what a sandboxed launch cannot go without.
  const missing = [], otherTeams = [], optional = [], skipped = [];
  let unnamed = 0, unnamedOptional = 0, unnamedSkipped = 0;
  for (const entry of list(sandbox.missing, "missing", sandboxed)) {
    const isOptional = isObject(entry) && entry.optional === true;
    if (isObject(entry) && typeof entry.capability === "string" && CAPABILITY_ID.test(entry.capability) && word(entry.setting) && word(entry.team)) {
      const row = { capability: entry.capability, setting: entry.setting ?? null, team: entry.team ?? null };
      (isOptional ? optional : entry.defaultTeam === false && row.team !== null ? otherTeams : missing).push(row);
    } else if (isOptional) unnamedOptional += 1;
    else unnamed += 1;
  }
  // What the kernel took no host for, and why: for readiness to say; never a refusal.
  for (const entry of list(sandbox.skipped, "skipped", false)) {
    if (isObject(entry) && typeof entry.capability === "string" && CAPABILITY_ID.test(entry.capability)) skipped.push({ capability: entry.capability, reason: oneLine(entry.reason, 200) ? entry.reason : null });
    else unnamedSkipped += 1;
  }
  return { domains, write, missing, otherTeams, optional, unnamed, unnamedOptional, unavailable: null, skipped, unnamedSkipped };
}

/** "oats.aweb's setting services for team default:acme.aweb.ai". */
export const describeMissing = (entry) => `${entry.capability}'s ${entry.setting ? `setting ${entry.setting}` : "service"}${entry.team ? ` for team ${entry.team}` : ""}`;

// A list of rows is cut to this many characters, each row to ROW_MAX, with a count of the
// rest: with the longest sentence that stands before it, the whole stays under the 500
// characters the kernel relays.
const LIST_MAX = 150;
const ROW_MAX = 110;
/** "a; b; 3 more" for the rows that fit and a count of the rest, some of which (`unnamed`)
 *  have no name that can be shown. */
export function gapList(rows, unnamed, { describe = describeMissing, noun = ["entry", "entries"] } = {}) {
  const shown = [];
  let length = 0;
  for (const row of rows) {
    const text = clip(describe(row), ROW_MAX);
    // The first row is always named (clipped if long); the rest while they fit.
    if (shown.length > 0 && (shown.length >= 16 || length + text.length > LIST_MAX)) break;
    shown.push(text);
    length += text.length + 2;
  }
  const rest = rows.length - shown.length + unnamed;
  if (rest === 0) return shown.join("; ");
  if (shown.length === 0) return unnamed === rest ? `${rest} ${noun[rest > 1 ? 1 : 0]} that cannot be shown` : `${rest} ${noun[rest > 1 ? 1 : 0]}, too long to list here`;
  return `${shown.join("; ")}; ${rest} more${unnamed > 0 ? " (not all can be shown)" : ""}`;
}

/** How a missing host gets recorded. Only oats.aweb has a command for it today. */
export function missingRemedy(rows) {
  const aweb = rows.some((row) => row.capability === "oats.aweb"), other = rows.some((row) => row.capability !== "oats.aweb");
  if (aweb && !other) return "Run `oats aweb setup` to record it";
  if (aweb) return "Run `oats aweb setup` for oats.aweb's, and record the other settings in the deployment's configuration";
  return "Record that setting in the deployment's configuration";
}

function realDirectory(path, what) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isDirectory()) throw fail("E_SESSION_START_FAILED", `${what} ${path} is not a directory (a link is not followed)`);
  return true;
}

/** Write a file whole or not at all, owner-only. The temporary file lives beside the
 *  target, in the home's `.claude` (a real directory: the callers checked), under a name
 *  of the provider's own, so a write killed before its rename leaves one stray file there
 *  and nothing in the agent's work. The provider keeps no directory of its own in the home. */
function writeAtomic(path, text) {
  const tmp = join(dirname(path), `.settings.local.json.oats-bb-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
const writeJson = (path, doc) => writeAtomic(path, `${JSON.stringify(doc, null, 2)}\n`);

const READ_MAX = 1024 * 1024;

/** Open the directory that holds a file the provider reads in the home, without following
 *  a link, and hold it: the file is then opened THROUGH that handle, so a directory
 *  swapped for a link between the two steps cannot take the read out of the home (the
 *  home is writable by its agent, and a no-follow open covers the last name only).
 *  → { fd, through(name) } | null where there is no such directory. Throws where the name
 *  is something else than a directory. */
function pinDirectory(dir, refuse) {
  let fd;
  try { fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw refuse(`is in ${dir}, which is not a directory of the home (a link is not followed)`);
  }
  // Linux names an open directory by its handle, so the file is opened through the very
  // directory that was checked. Other systems give Node no such open: there the path is
  // used, and afterwards the handles say whether the directory is still the one that was
  // opened and whether the file that was read is the one now in it. That check cannot
  // see a directory swapped and put back in between, so it is weaker; what it protects is
  // also less than it looks, since the agent that could do the swap runs as the same
  // user as the provider and can read whatever the provider can.
  // (A Linux with no /proc mounted, a chroot or a hardened sandbox, has no such name
  // either: it is then read the way the other systems are, never taken for a missing file.)
  const byHandle = process.platform === "linux" && lstatSync(`/proc/self/fd/${fd}`, { throwIfNoEntry: false }) !== undefined;
  const through = (name) => (byHandle ? `/proc/self/fd/${fd}/${name}` : join(dir, name));
  const same = (name, opened) => {
    if (byHandle) return true;
    const now = lstatSync(dir, { throwIfNoEntry: false }), held = fstatSync(fd), file = lstatSync(join(dir, name), { throwIfNoEntry: false });
    return now?.isDirectory() === true && now.dev === held.dev && now.ino === held.ino && file?.isFile() === true && file.dev === opened.dev && file.ino === opened.ino;
  };
  return { fd, through, same };
}

/** The bytes of a file in the home, or null when there is none. The home is writable by
 *  its agent, so every read of it goes through here: the file's directory is opened
 *  without following a link and held, and the file is read through it; a regular file
 *  only (a link, a directory or a pipe is refused, never followed, waited on or taken for
 *  absent), at most 1 MiB. → { bytes, mode } | null. Throws E_SESSION_START_FAILED otherwise. */
function readHomeBytes(path, what) {
  const refuse = (why) => fail("E_SESSION_START_FAILED", `${what} ${path} ${why}: fix or remove it; the provider does not overwrite it`);
  const dir = pinDirectory(dirname(path), refuse);
  if (dir === null) return null;
  let fd = null;
  try {
    const pinned = dir.through(basename(path));
    const stat = lstatSync(pinned, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile()) throw refuse("is not a regular file (a link, a directory or a pipe is not read)");
    if (stat.size > READ_MAX) throw refuse(`is larger than ${READ_MAX} bytes`);
    fd = openSync(pinned, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > READ_MAX || !dir.same(basename(path), opened)) throw refuse("changed while it was read");
    const buffer = Buffer.alloc(opened.size);
    let got = 0;
    while (got < opened.size) {
      const n = readSync(fd, buffer, got, opened.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return { bytes: buffer.subarray(0, got), mode: opened.mode & 0o777 };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw refuse(`could not be read (${typeof error?.code === "string" ? error.code : "error"})`);
  } finally {
    if (fd !== null) closeSync(fd);
    closeSync(dir.fd);
  }
}

/** Read a JSON object from a file in the home, or null when there is none, by the
 *  confined read above; nothing of its content goes into a message. */
function readJsonObject(path, what) {
  const read = readHomeBytes(path, what);
  if (read === null) return null;
  const refuse = (why) => fail("E_SESSION_START_FAILED", `${what} ${path} ${why}: fix or remove it; the provider does not overwrite it`);
  let doc;
  try { doc = JSON.parse(read.bytes.toString("utf8")); }
  catch { throw refuse("is not JSON"); }
  if (!isObject(doc)) throw refuse("is not a JSON object");
  return doc;
}

export const isExactHost = (value) => typeof value === "string" && HOST.test(value);
export const isExactPath = (value) => typeof value === "string" && isAbsolute(value) && normalize(value) === value && value !== "/" && !/[*?\x00-\x1f\x7f]/.test(value);

// What an earlier version of the provider kept in the home: a state directory and a
// record. The provider keeps nothing of its own there now (the home is its agent's to
// write, so a file in it must never decide what the provider writes or deletes): a launch
// and the hooks delete them where they are found, unread. Best effort: they decide
// nothing, so one that cannot be deleted (the agent can plant a directory nobody may
// empty) never fails or holds a launch, a start or a retire; the next one tries again.
// → the names that are still there.
const LEFTOVERS = [".oats-bb", ".oats-bb-sandbox.json"];
export function removeLeftovers(home) {
  const left = [];
  for (const name of LEFTOVERS) {
    try {
      const stat = lstatSync(join(home, name), { throwIfNoEntry: false });
      if (stat) rmSync(join(home, name), { recursive: stat.isDirectory(), force: true });
    } catch { left.push(name); }
  }
  return left;
}

function directories(home, { create }) {
  if (!statSync(home, { throwIfNoEntry: false })?.isDirectory()) throw fail("E_SESSION_START_FAILED", `the home ${home} is not a directory`);
  const claudeDir = join(home, ".claude");
  const hasClaude = realDirectory(claudeDir, "the home's");
  if (create && !hasClaude) mkdirSync(claudeDir, { mode: 0o700 });
  return { settingsPath: join(claudeDir, "settings.local.json"), hasClaude };
}

/** What `settings.local.json` holds, to keep every key that is not the provider's. A
 *  file that is not a regular file, larger than the provider reads, or not a JSON object
 *  refuses: the provider does not overwrite what it cannot read. What the provider's own keys
 *  hold is never looked at: they are replaced whole, whatever stands there. */
const readOthers = (settingsPath) => readJsonObject(settingsPath, "Claude's local settings") ?? {};

// The two keys under `permissions` that are the provider's: the deny rules of a sandboxed
// launch (D16 rule 1) and the switch that keeps Claude's Write and Edit tools inside the
// working directories (A5a). `permissions.allow` and the rest of that block are Claude's
// and the person's, and stay.
const DENY = "deny", BLOCK = "blockWritesOutsideWorkingDirectories";
/** The MCP tool of bb's own bridge that moves a thread's directory: with it a sandboxed
 *  agent would work, and write, somewhere else. Denied in every sandboxed launch. */
export const DENIED_TOOLS = Object.freeze(["mcp__bb-bridge__update_environment_directory"]);

/** Put the provider's keys into `settings`, replacing whatever they held: `env`,
 *  `sandbox`, `permissions.deny` and `permissions.blockWritesOutsideWorkingDirectories`,
 *  each whole. `deny` null is a launch with no sandbox (bb's full mode, or a move away):
 *  both `permissions` keys go, and a `permissions` block left empty goes with them. A key
 *  with nothing to hold is removed. Every other key stays. */
function own(settings, { env, sandbox, deny }) {
  if (env && Object.keys(env).length > 0) settings.env = env; else delete settings.env;
  if (sandbox) settings.sandbox = sandbox; else delete settings.sandbox;
  if (deny) {
    // A `permissions` that is no map cannot hold the rules: it is replaced, as the two
    // keys under it would be (a sandboxed launch with no deny rules is never written).
    if (!isObject(settings.permissions)) settings.permissions = {};
    settings.permissions[DENY] = [...deny, ...DENIED_TOOLS];
    settings.permissions[BLOCK] = true;
  } else if (isObject(settings.permissions)) {
    delete settings.permissions[DENY];
    delete settings.permissions[BLOCK];
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }
  return settings;
}

/** Whether a settings document holds one of the provider's sandbox keys. */
const sandboxKeysIn = (settings) => settings.sandbox !== undefined || (isObject(settings.permissions) && (settings.permissions[DENY] !== undefined || settings.permissions[BLOCK] !== undefined));

/** The `sandbox` block of a sandboxed launch: exactly the hosts and paths the kernel
 *  handed it, or null when there is none of either. */
function sandboxBlock(sandbox) {
  if (sandbox === null) return null;
  const domains = [...new Set(sandbox.domains.map((entry) => entry.host))], write = [...new Set(sandbox.write.map((entry) => entry.path))];
  const block = {};
  if (domains.length > 0) block.network = { allowedDomains: domains };
  if (write.length > 0) block.filesystem = { allowWrite: write };
  return Object.keys(block).length > 0 ? block : null;
}

/** Claude's local settings as they stand now, read by the confined read (a name that is
 *  no regular file, or a file too large, refuses here, before anything is changed).
 *  → restore(): puts the file back as it was (its bytes and mode, or its absence), and
 *  removes a `.claude` the launch made. For a launch that ends in a refusal after it wrote
 *  the file: a refusal means nothing was changed. Taken before the launch changes
 *  anything in bb. */
export function snapshotLaunchSettings(home) {
  const claudeDir = join(home, ".claude");
  const hadDir = realDirectory(claudeDir, "the home's");
  const path = join(claudeDir, "settings.local.json");
  const was = hadDir ? readHomeBytes(path, "Claude's local settings") : null;
  return () => {
    if (was === null) rmSync(path, { force: true });
    else { writeFileSync(path, was.bytes, { mode: was.mode }); chmodSync(path, was.mode); }
    if (!hadDir) {
      try { rmdirSync(claudeDir); } catch { /* not empty, or not there: left as it is */ }
    }
  };
}

/** Write a launch's settings into `<home>/.claude/settings.local.json` (0600).
 *
 *  Four keys of that file are the provider's in a bb home, whole: `env` (the launch
 *  environment, minus `unset`), `sandbox` (the allowances of a sandboxed launch),
 *  `permissions.deny` and `permissions.blockWritesOutsideWorkingDirectories` (`deny`:
 *  the rules of a sandboxed launch, null for a launch with no sandbox). Every
 *  launch rewrites them from the launch input and never reads what they held: the home is
 *  its agent's to write, so what stands there proves nothing, and the provider keeps no
 *  record of its own in the home. A person's own entries under those keys are not
 *  kept. In bb's full mode there is no sandbox: `sandbox` and the two `permissions` keys
 *  are removed. Every other key is kept as it is. */
export function writeLaunchSettings(home, { env, unset = [], sandbox, deny = null, dryRun = false }) {
  const { settingsPath } = directories(home, { create: !dryRun });
  const settings = readOthers(settingsPath);
  env = { ...Object.fromEntries(unset.map((name) => [name, ""])), ...env };
  own(settings, { env, sandbox: sandboxBlock(sandbox), deny });
  // A dry run has done every check that can refuse (a home, a .claude or a file that is
  // not what it should be), and writes nothing: the launch runs it before its first effect.
  if (dryRun) return { path: settingsPath, names: Object.keys(env).sort() };
  writeJson(settingsPath, settings);
  removeLeftovers(home);
  return { path: settingsPath, names: Object.keys(env).sort() };
}

/** What Claude's local settings in the home hold of the provider's sandbox keys now.
 *  Read for one thing only, what readiness and a warning say: it decides nothing the
 *  provider writes or deletes (the home is its agent's to write).
 *  → { any, sandbox, deny, block }: `any` one of the keys is there; `sandbox` the block
 *  is there; `deny` every tool the provider denies is in the deny list; `block` the
 *  switch is true. All false where the file is absent or cannot be read. */
export function sandboxKeysOf(home) {
  const none = { any: false, sandbox: false, deny: false, block: false };
  try {
    if (!realDirectory(join(home, ".claude"), "the home's")) return none;
    const settings = readJsonObject(join(home, ".claude", "settings.local.json"), "Claude's local settings") ?? {};
    const permissions = isObject(settings.permissions) ? settings.permissions : {};
    return {
      any: sandboxKeysIn(settings),
      sandbox: settings.sandbox !== undefined,
      deny: Array.isArray(permissions[DENY]) && DENIED_TOOLS.every((tool) => permissions[DENY].includes(tool)),
      block: permissions[BLOCK] === true,
    };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return none;
  }
}

/** The home ran on bb before this launch and now starts on another backend (the kernel
 *  says so, from its own record outside the home): take the provider's four keys out of
 *  settings.local.json. Nothing in the home decides this: the caller removes only on the
 *  kernel's word. A file that holds neither key is left as it is, byte for byte.
 *  → whether a key was removed. */
export function removeLaunchSettings(home) {
  const { settingsPath, hasClaude } = directories(home, { create: false });
  if (!hasClaude) return false;
  const settings = readOthers(settingsPath);
  if (settings.env === undefined && !sandboxKeysIn(settings)) return false;
  writeJson(settingsPath, own(settings, { env: null, sandbox: null, deny: null }));
  return true;
}
