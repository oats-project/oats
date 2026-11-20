/** Sandbox allowances (docs/capabilities.md "Sandbox allowances"): what a session provider may
 *  widen its harness's sandbox by, for one launch. The kernel builds the list; the provider writes
 *  it and nothing else. Two kinds of entry, and where each may come from:
 *
 *   - `domains`: exact hosts. Only the capability that fills the instance's messaging, knowledge or
 *     tasks slot may contribute one, only by a manifest line `sandboxDomains: [{ "setting": "<key>" }]`
 *     that names one of its own settings. The setting's value is a URL (the kernel takes its host),
 *     a bare host, or a map from team id to one of those, of which only the entries of the
 *     instance's own teams are taken. A line on any other capability refuses the launch, never
 *     drops the line. A line may instead be `{ "settingFile": "<key>", "urls": "<JSON pointer>" }`:
 *     the setting's value is the path of a JSON file of the deployment, and the hosts are those
 *     of every string at the pointer (readSettingFileHosts, with its bounds). Nothing at run time
 *     (hook output, an environment variable, a task, a launch argument) can add a host.
 *   - `write`: exact absolute paths, the kernel's own, never a capability's: the deployment's events
 *     directory (lib/instance-events.mjs eventsDirOf), which the kernel creates before the launch:
 *     an allowance on a path that does not exist does not let a sandboxed agent create it.
 *
 *  The values are the DEPLOYMENT'S: a resolution's `slots` and `payloads` (what a spawn preview
 *  shows), never a file inside an instance home, which a sandboxed agent can write.
 *
 *  A leaf: no import of the kernel's heavy modules. Every refusal is E_BACKEND_SANDBOX_HOST, with
 *  `details: { capability, setting?, host? }`. */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseStrictJson } from "./canonical-json.mjs";
import { oatsError } from "./errors.mjs";

/** The slots whose provider may declare `sandboxDomains`. */
export const SANDBOX_SLOTS = ["messaging", "knowledge", "tasks"];
/** At most this many lines in one manifest, and this many hosts from one capability. */
export const MAX_SANDBOX_LINES = 16;
const SETTING_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** A host as an allowlist takes it: DNS labels (letters, digits, hyphens; no wildcard, no
 *  underscore), at most 253 characters, or a dotted IPv4 address, which the same pattern covers. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
/** `scheme://[userinfo@]host[:port][/path][?query][#fragment]`, the authority kept as written: WHATWG
 *  URL drops a port that is the scheme's default, and the entry carries a port only when the URL names one. */
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#].*)?$/i;

/** A `settingFile` line's file: at most this many bytes, and this many hosts. */
export const SETTING_FILE_MAX_BYTES = 64 * 1024, SETTING_FILE_MAX_HOSTS = 16;
/** A JSON pointer (RFC 6901) of at most 16 segments, of which at most one is `*`: every key of the
 *  object, or every element of the array, at that place. */
const pointerSegments = (pointer) => {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer.length > 400) return null;
  const segments = pointer.slice(1).split("/");
  if (segments.length > 16 || segments.some((s) => s === "" || /~(?![01])/.test(s)) || segments.filter((s) => s === "*").length > 1) return null;
  return segments.map((s) => (s === "*" ? { any: true } : { key: s.replace(/~1/g, "/").replace(/~0/g, "~") }));
};
/** A git remote in scp form, `[user@]host:path`: its host. Only a `settingFile`'s strings are read
 *  so; `host:<port number>` is a bare host with its port, never this. */
const SCP_REMOTE_RE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(?![0-9]{1,5}$)[^\s]+$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const refuse = (message, details) => Object.assign(oatsError("E_BACKEND_SANDBOX_HOST", message), { details });

/** `manifest.sandboxDomains` as the kernel reads it → `{ lines: [{ setting, optional }], problems:
 *  [string] }`. A line is `{ "setting": "<key>" }`, with `"optional": true` when the session works
 *  without that host (its absence is then no reason for a provider to refuse a launch).
 *  Total: it never throws. A manifest without the key has no lines and no problems. A problem is a
 *  refusal wherever the lines are used (sandboxAllowances): a line is never dropped. */
export function sandboxDomainsOf(manifest) {
  const declared = manifest?.sandboxDomains;
  if (declared === undefined) return { lines: [], problems: [] };
  if (!Array.isArray(declared) || declared.length < 1 || declared.length > MAX_SANDBOX_LINES) return { lines: [], problems: [`sandboxDomains must list 1 to ${MAX_SANDBOX_LINES} entries`] };
  const lines = [], problems = [];
  declared.forEach((line, i) => {
    const keys = isObject(line) ? Object.keys(line) : [];
    if (isObject(line) && Object.hasOwn(line, "settingFile")) {
      if (typeof line.settingFile !== "string" || !SETTING_KEY_RE.test(line.settingFile) || keys.some((k) => k !== "settingFile" && k !== "urls") || !pointerSegments(line.urls)) problems.push(`sandboxDomains[${i}] must be { "settingFile": "<one of the capability's setting keys>", "urls": "<a JSON pointer, at most one * segment>" }`);
      else if (lines.some((l) => (l.settingFile ?? l.setting) === line.settingFile)) problems.push(`sandboxDomains[${i}] names the setting ${line.settingFile} a second time`);
      else lines.push({ settingFile: line.settingFile, urls: line.urls });
      return;
    }
    if (!isObject(line) || typeof line.setting !== "string" || !SETTING_KEY_RE.test(line.setting) || keys.some((k) => k !== "setting" && k !== "optional") || (line.optional !== undefined && typeof line.optional !== "boolean")) problems.push(`sandboxDomains[${i}] must be { "setting": "<one of the capability's setting keys>", "optional"?: true }`);
    else if (lines.some((l) => (l.settingFile ?? l.setting) === line.setting)) problems.push(`sandboxDomains[${i}] names the setting ${line.setting} a second time`);
    else lines.push({ setting: line.setting, optional: line.optional === true });
  });
  if (!SANDBOX_SLOTS.includes(manifest?.layer)) problems.push(`sandboxDomains is for a capability whose layer is ${SANDBOX_SLOTS.join(", ")}: this one declares ${manifest?.layer === undefined ? "none" : JSON.stringify(manifest.layer)}`);
  return { lines, problems };
}

/** The host of a setting's value, as an allowlist entry → `{ host }`, or `{ problem }` saying why
 *  the value gives none. The value is a URL (anything with `://`: its host is taken) or a bare host
 *  (`host` or `host:port`). The entry is a bare host: lower case, no wildcard, scheme or path; its
 *  port only when the value names one. A value that carries credentials is refused whole: nothing
 *  of it is quoted. */
export function sandboxHostOf(value, { userName = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return { problem: "is not a URL or a host" };
  const text = value.trim();
  const m = URL_RE.exec(text);
  if (!m && /[/?#\s]/.test(text)) return { problem: "is neither a URL with a scheme and a host nor a bare host" };
  const authority = m ? m[2] : text;
  // A user name alone is no credential (a git remote carries one), where the caller reads such values.
  const user = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : null;
  if (user !== null && !(userName && m && /^[A-Za-z0-9._-]+$/.test(user))) return { problem: "is a URL that carries credentials" };
  const hostPort = user === null ? authority : authority.slice(user.length + 1);
  const at = hostPort.lastIndexOf(":");
  const [name, port] = at >= 0 && !hostPort.endsWith("]") ? [hostPort.slice(0, at), hostPort.slice(at + 1)] : [hostPort, null];
  const host = name.toLowerCase();
  if (!host) return { problem: "is a URL without a host" };
  if (host.includes("*")) return { problem: `names a wildcard host (${host}): an allowance is one exact host` };
  if (host.length > 253 || !HOST_RE.test(host)) return { problem: "names a host that is no plain DNS name or IPv4 address" };
  if (port !== null && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return { problem: "names a port that is no port number" };
  return { host: port === null ? host : `${host}:${Number(port)}` };
}

/** The hosts a `settingFile` line gives → `{ hosts: [host] }`, `{ unread: "<why>" }` when the file
 *  gives none this kernel will use (missing, not a regular file, too large, no strict JSON, more
 *  than SETTING_FILE_MAX_HOSTS hosts: the launch goes on without them, and readiness names it), or
 *  `{ refused: "<why>" }` when the path itself is one no allowance may be read from.
 *
 *  `path`: the setting's value. `within`: the deployment's directory. `outside`: directories inside
 *  it that are never a source (its instance homes, the paths the allowances make writable). The
 *  path must be inside `within` and outside each of those, as its REAL path, with no symbolic link
 *  anywhere along it below the deployment: a link planted in a parent directory cannot move the
 *  read to a file a sandboxed agent can write. The file is opened without following a link, as a
 *  regular file, and read once, at most SETTING_FILE_MAX_BYTES.
 *
 *  A string at the pointer gives a host when it is a URL with a plain host (a user name is allowed,
 *  as git remotes carry one; a password is not) or a git remote in scp form (`git@host:path`);
 *  another string is skipped and counted in `skippedValues`. */
export function readSettingFileHosts({ path, pointer, within, outside = [] }) {
  if (typeof path !== "string" || !path.trim()) return { unread: "the setting names no file" };
  let root;
  try { root = realpathSync(within); } catch (e) { return { refused: `the deployment's directory cannot be resolved (${e.code ?? e.message})` }; }
  // The path as written, under the deployment's real directory: an absolute path that spells the
  // deployment through a link is re-rooted to it, and from there no link is allowed.
  const written = isAbsolute(path) ? path : resolve(within, path);
  const below = [resolve(within), root].map((base) => relative(base, resolve(written))).find((rel) => rel && !rel.startsWith("..") && !isAbsolute(rel));
  if (!below) return { refused: `${path} is not inside the deployment (${root}): a host is read only from the deployment's own files` };
  const target = resolve(root, below);
  const inside = (dir) => { const rel = relative(dir, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  const forbidden = outside.map((dir) => { try { return realpathSync(dir); } catch { return resolve(dir); } }).find(inside);
  if (forbidden) return { refused: `${path} is inside ${forbidden}, which a session's agent can write: a host is never read from there` };
  let real;
  try { real = realpathSync(target); } catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR" ? { unread: `${target} does not exist` } : { unread: `${target} cannot be read (${e.code ?? e.message})` }; }
  if (real !== target) return { refused: `${path} reaches its file through a symbolic link (${target} is ${real}): a host is read only from a path with no link along it` };
  let fd;
  try { fd = openSync(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)); } catch (e) { return { unread: `${target} cannot be opened (${e.code ?? e.message})` }; }
  let doc;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { unread: `${target} is not a regular file` };
    if (st.size > SETTING_FILE_MAX_BYTES) return { unread: `${target} is larger than ${SETTING_FILE_MAX_BYTES / 1024} KiB` };
    const buffer = Buffer.alloc(SETTING_FILE_MAX_BYTES + 1);
    let length = 0;
    for (let n; length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += n;
    if (length > SETTING_FILE_MAX_BYTES) return { unread: `${target} is larger than ${SETTING_FILE_MAX_BYTES / 1024} KiB` };
    try { doc = parseStrictJson(buffer.subarray(0, length), { maxBytes: SETTING_FILE_MAX_BYTES }); } catch { return { unread: `${target} is not strict JSON` }; }
  } catch (e) { return { unread: `${target} cannot be read (${e.code ?? e.message})` }; }
  finally { closeSync(fd); }
  // Every value at the pointer.
  let values = [doc];
  for (const segment of pointerSegments(pointer) ?? []) {
    values = values.flatMap((v) => {
      if (segment.any) return Array.isArray(v) ? v : v !== null && typeof v === "object" ? Object.values(v) : [];
      if (Array.isArray(v)) return /^(0|[1-9][0-9]*)$/.test(segment.key) && Number(segment.key) < v.length ? [v[Number(segment.key)]] : [];
      return v !== null && typeof v === "object" && Object.hasOwn(v, segment.key) ? [v[segment.key]] : [];
    });
  }
  const hosts = [];
  let skippedValues = 0;
  for (const value of values) {
    const scp = typeof value === "string" ? SCP_REMOTE_RE.exec(value.trim()) : null;
    const { host } = scp ? sandboxHostOf(scp[1]) : sandboxHostOf(value, { userName: true });
    if (!host) skippedValues += 1;
    else if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length > SETTING_FILE_MAX_HOSTS) return { unread: `${target} names ${hosts.length} hosts, more than the ${SETTING_FILE_MAX_HOSTS} one file may give` };
  return { hosts, skippedValues };
}

/** What a provider's launch is handed of the allowances: the three lists, never the kernel's own
 *  notes (`skipped`, `unread`), which are for the answer and for readiness. */
export const sandboxLaunchInput = ({ domains, write, missing }) => ({ domains, write, missing });

/** The allowances of one launch → `{ domains: [{ host, capability, setting }], write: [{ path, reason }],
 *  missing: [{ capability, setting, team, optional? }] }` (`sandboxLaunchInput` is what a provider is
 *  handed of it). `missing`: what a line names and the
 *  deployment's configuration does not hold: a team of the instance with no entry in a map (`team`:
 *  its id), or a setting with no value at all (`team: null`); `optional: true` on a row of a line
 *  declared so. The kernel adds no host for those and refuses nothing: a provider that would
 *  sandbox the session refuses on a row that is not optional, since only it knows its mode.
 *
 *  `modules`: the instance's capabilities, `[{ name, manifest }]`. `slots`: `{ messaging, knowledge,
 *  tasks }`, each the name of the capability that fills it, or null. `payloads`: `{ <capability>:
 *  { <setting>: value } }`, the deployment's effective settings. `teams`: the instance's team ids
 *  (the `team` of each row of the resolution's `teams`). `eventsDir`: the deployment's events
 *  directory, absolute. `deployment` and `outside`: where a `settingFile` line's file may be (inside
 *  the first, outside each of the second: readSettingFileHosts); `unread: [{ capability, setting,
 *  reason }]`, in the answer only when there is one, names each such file that gave no host, or
 *  values in it that were skipped. `only`, when given (a start of an existing home): the names of the home's
 *  own modules; a slot's provider of the deployment that is not one of them contributes no host
 *  and is named in `skipped: [{ capability, reason }]`, which is in the answer only then.
 *
 *  Refused (E_BACKEND_SANDBOX_HOST), naming the capability and what it asked for: a malformed
 *  declaration; a capability that declares the line and fills none of the three slots; a setting
 *  whose value is set and gives no plain host. A setting with no value contributes no host and is
 *  listed in `missing`. Of a map (team id → URL or host) only the entries of the instance's teams
 *  are read: another team's entry is neither taken nor judged, and a team without an entry
 *  contributes no host and is listed in `missing`.
 *  Hosts are deduplicated: the first capability, in `modules` order, to ask for one is named. */
export function sandboxAllowances({ modules = [], slots = {}, payloads = {}, teams = [], eventsDir, only, deployment, outside = [] }) {
  const domains = [], skipped = [], missing = [], unread = [];
  for (const { name, manifest } of modules) {
    if (manifest?.sandboxDomains === undefined) continue;
    const { lines, problems } = sandboxDomainsOf(manifest);
    const slot = SANDBOX_SLOTS.find((s) => slots?.[s] === name);
    // One entry per value a line names: the setting's own, or each of the instance's teams' in a map.
    const asked = lines.filter((l) => l.setting !== undefined).flatMap(({ setting, optional }) => {
      const value = isObject(payloads?.[name]) ? payloads[name][setting] : undefined;
      if (!isObject(value)) return [{ setting, optional, team: null, value }];
      return teams.filter((team, i) => typeof team === "string" && teams.indexOf(team) === i).map((team) => ({ setting, optional, team, value: Object.hasOwn(value, team) ? value[team] : undefined }));
    });
    if (!slot) {
      // Named with the host it asked for, where its setting gives one.
      const first = asked.map((l) => ({ setting: l.setting, host: sandboxHostOf(l.value).host ?? null })).find((l) => l.host) ?? { setting: asked[0]?.setting ?? null, host: null };
      throw refuse(`capability ${name} declares sandboxDomains${first.host ? ` (the host ${first.host}, from its setting ${first.setting})` : ""}, and it is not this instance's ${SANDBOX_SLOTS.join(", ")} provider: only the capability that fills one of those slots may add a host to a session's sandbox; nothing was launched`, { capability: name, setting: first.setting, host: first.host });
    }
    if (only && !only.includes(name)) { skipped.push({ capability: name, reason: `the deployment's ${slot} provider is ${name}, which is not one of this home's modules: its hosts are not allowed here (respawn the instance to take the deployment's composition)` }); continue; }
    if (problems.length) throw refuse(`capability ${name} declares a sandboxDomains this kernel cannot use: ${problems.join("; ")}; nothing was launched`, { capability: name, setting: null, host: null });
    for (const { setting, optional, team, value } of asked) {
      if (value === undefined || value === null || value === "") { missing.push({ capability: name, setting, team, ...(optional ? { optional: true } : {}) }); continue; }
      const { host, problem } = sandboxHostOf(value);
      if (!host) throw refuse(`capability ${name} asks to allow the host of its setting ${setting}${team === null ? "" : ` for team ${team}`}, whose value ${problem}; nothing was launched`, { capability: name, setting, host: null, ...(team === null ? {} : { team }) });
      if (!domains.some((d) => d.host === host)) domains.push({ host, capability: name, setting });
    }
    // A `settingFile` line: the hosts of a file of the deployment. A path that may not be read
    // from refuses; a file that gives nothing is named, and the launch goes on without its hosts.
    for (const { settingFile: setting, urls } of lines.filter((l) => l.settingFile !== undefined)) {
      const path = isObject(payloads?.[name]) ? payloads[name][setting] : undefined;
      const read = readSettingFileHosts({ path, pointer: urls, within: deployment, outside });
      if (read.refused) throw refuse(`capability ${name} asks to allow the hosts in the file its setting ${setting} names, and ${read.refused}; nothing was launched`, { capability: name, setting, host: null });
      if (read.unread) { unread.push({ capability: name, setting, reason: read.unread }); continue; }
      for (const host of read.hosts) if (!domains.some((d) => d.host === host)) domains.push({ host, capability: name, setting });
      if (read.skippedValues) unread.push({ capability: name, setting, reason: `${read.skippedValues} ${read.skippedValues === 1 ? "value" : "values"} at ${urls} ${read.skippedValues === 1 ? "is" : "are"} no URL with a plain host, and ${read.skippedValues === 1 ? "was" : "were"} skipped` });
    }
  }
  return { domains, write: [{ path: eventsDir, reason: "oats events" }], missing, ...(skipped.length ? { skipped } : {}), ...(unread.length ? { unread } : {}) };
}
