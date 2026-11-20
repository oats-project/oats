/** Sandbox allowances (docs/capabilities.md "Sandbox allowances"): what a session provider may
 *  widen its harness's sandbox by, for one launch. The kernel builds the list; the provider writes
 *  it and nothing else. Two kinds of entry, and where each may come from:
 *
 *   - `domains`: exact hosts. Only the capability that fills the instance's messaging, knowledge or
 *     tasks slot may contribute one, only by a manifest line `sandboxDomains: [{ "setting": "<key>" }]`
 *     that names one of its own settings. The setting's value is a URL (the kernel takes its host),
 *     a bare host, or a map from team id to one of those, of which only the entries of the
 *     instance's own teams are taken. A line on any other capability refuses the launch, never
 *     drops the line. Nothing at run time
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
    if (!isObject(line) || typeof line.setting !== "string" || !SETTING_KEY_RE.test(line.setting) || keys.some((k) => k !== "setting" && k !== "optional") || (line.optional !== undefined && typeof line.optional !== "boolean")) problems.push(`sandboxDomains[${i}] must be { "setting": "<one of the capability's setting keys>", "optional"?: true }`);
    else if (lines.some((l) => l.setting === line.setting)) problems.push(`sandboxDomains[${i}] names the setting ${line.setting} a second time`);
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
export function sandboxHostOf(value) {
  if (typeof value !== "string" || !value.trim()) return { problem: "is not a URL or a host" };
  const text = value.trim();
  const m = URL_RE.exec(text);
  if (!m && /[/?#\s]/.test(text)) return { problem: "is neither a URL with a scheme and a host nor a bare host" };
  const authority = m ? m[2] : text;
  if (authority.includes("@")) return { problem: "is a URL that carries credentials" };
  const at = authority.lastIndexOf(":");
  const [name, port] = at >= 0 && !authority.endsWith("]") ? [authority.slice(0, at), authority.slice(at + 1)] : [authority, null];
  const host = name.toLowerCase();
  if (!host) return { problem: "is a URL without a host" };
  if (host.includes("*")) return { problem: `names a wildcard host (${host}): an allowance is one exact host` };
  if (host.length > 253 || !HOST_RE.test(host)) return { problem: "names a host that is no plain DNS name or IPv4 address" };
  if (port !== null && (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return { problem: "names a port that is no port number" };
  return { host: port === null ? host : `${host}:${Number(port)}` };
}

/** The allowances of one launch → `{ domains: [{ host, capability, setting }], write: [{ path, reason }],
 *  missing: [{ capability, setting, team, optional? }] }`. `missing`: what a line names and the
 *  deployment's configuration does not hold: a team of the instance with no entry in a map (`team`:
 *  its id), or a setting with no value at all (`team: null`); `optional: true` on a row of a line
 *  declared so. The kernel adds no host for those and refuses nothing: a provider that would
 *  sandbox the session refuses on a row that is not optional, since only it knows its mode.
 *
 *  `modules`: the instance's capabilities, `[{ name, manifest }]`. `slots`: `{ messaging, knowledge,
 *  tasks }`, each the name of the capability that fills it, or null. `payloads`: `{ <capability>:
 *  { <setting>: value } }`, the deployment's effective settings. `teams`: the instance's team ids
 *  (the `team` of each row of the resolution's `teams`). `eventsDir`: the deployment's events
 *  directory, absolute.
 *
 *  Refused (E_BACKEND_SANDBOX_HOST), naming the capability and what it asked for: a malformed
 *  declaration; a capability that declares the line and fills none of the three slots; a setting
 *  whose value is set and gives no plain host. A setting with no value contributes no host and is
 *  listed in `missing`. Of a map (team id → URL or host) only the entries of the instance's teams
 *  are read: another team's entry is neither taken nor judged, and a team without an entry
 *  contributes no host and is listed in `missing`.
 *  Hosts are deduplicated: the first capability, in `modules` order, to ask for one is named. */
export function sandboxAllowances({ modules = [], slots = {}, payloads = {}, teams = [], eventsDir }) {
  const domains = [], missing = [];
  for (const { name, manifest } of modules) {
    if (manifest?.sandboxDomains === undefined) continue;
    const { lines, problems } = sandboxDomainsOf(manifest);
    const slot = SANDBOX_SLOTS.find((s) => slots?.[s] === name);
    // One entry per value a line names: the setting's own, or each of the instance's teams' in a map.
    const asked = lines.flatMap(({ setting, optional }) => {
      const value = isObject(payloads?.[name]) ? payloads[name][setting] : undefined;
      if (!isObject(value)) return [{ setting, optional, team: null, value }];
      return teams.filter((team, i) => typeof team === "string" && teams.indexOf(team) === i).map((team) => ({ setting, optional, team, value: Object.hasOwn(value, team) ? value[team] : undefined }));
    });
    if (!slot) {
      // Named with the host it asked for, where its setting gives one.
      const first = asked.map((l) => ({ setting: l.setting, host: sandboxHostOf(l.value).host ?? null })).find((l) => l.host) ?? { setting: asked[0]?.setting ?? null, host: null };
      throw refuse(`capability ${name} declares sandboxDomains${first.host ? ` (the host ${first.host}, from its setting ${first.setting})` : ""}, and it is not this instance's ${SANDBOX_SLOTS.join(", ")} provider: only the capability that fills one of those slots may add a host to a session's sandbox; nothing was launched`, { capability: name, setting: first.setting, host: first.host });
    }
    if (problems.length) throw refuse(`capability ${name} declares a sandboxDomains this kernel cannot use: ${problems.join("; ")}; nothing was launched`, { capability: name, setting: null, host: null });
    for (const { setting, optional, team, value } of asked) {
      if (value === undefined || value === null || value === "") { missing.push({ capability: name, setting, team, ...(optional ? { optional: true } : {}) }); continue; }
      const { host, problem } = sandboxHostOf(value);
      if (!host) throw refuse(`capability ${name} asks to allow the host of its setting ${setting}${team === null ? "" : ` for team ${team}`}, whose value ${problem}; nothing was launched`, { capability: name, setting, host: null, ...(team === null ? {} : { team }) });
      if (!domains.some((d) => d.host === host)) domains.push({ host, capability: name, setting });
    }
  }
  return { domains, write: [{ path: eventsDir, reason: "oats events" }], missing };
}
