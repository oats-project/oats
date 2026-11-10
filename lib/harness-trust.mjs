/** Folder trust for the claude and codex harnesses (#341): whether a new instance home is
 *  covered by the operator's one-time trust of the deployment root, so the launched session
 *  does not stop at the harness's folder-trust prompt.
 *
 *  This module only reads native configuration. The explicit operator command
 *  in harness-trust-write.mjs is the separate deployment-root write boundary. A configuration that is missing, unreadable or in a form this
 *  reader does not know counts as not trusted, so a launch is warned about rather than
 *  silently stalled.
 *
 *  - Claude walks up from its working directory, stopping at a git root, and honours
 *    `projects["<dir>"].hasTrustDialogAccepted` in ~/.claude.json
 *    ($CLAUDE_CONFIG_DIR/.claude.json when that is set). A deployment-root entry covers
 *    descendants only when no intervening Git boundary prevents inheritance.
 *  - Codex honours only an exact `[projects."<dir>"] trust_level = "trusted"` entry in
 *    ~/.codex/config.toml ($CODEX_HOME/config.toml), never a parent's. A per-invocation
 *    override does trust a home, so the kernel's codex launch adds one for the home when the
 *    operator trusts the deployment root or an ancestor of it (renderLaunchRecipe). */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
const userHome = (env) => env.HOME || homedir();

/** The variable that moves each harness's configuration folder: the three selectors. */
export const HARNESS_FOLDER_VAR = Object.freeze({ claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", pi: "PI_CODING_AGENT_DIR" });
/** Of those, the harnesses that have folder trust. */
export const CONFIG_DIR_VAR = { claude: HARNESS_FOLDER_VAR.claude, codex: HARNESS_FOLDER_VAR.codex };
/** The configuration file `harness` reads under `env`: $CLAUDE_CONFIG_DIR/.claude.json or
 *  ~/.claude.json; $CODEX_HOME/config.toml or ~/.codex/config.toml. */
export function harnessConfigFile(harness, env = process.env) {
  if (harness === "claude") return join(env.CLAUDE_CONFIG_DIR || userHome(env), ".claude.json");
  return join(env.CODEX_HOME || join(userHome(env), ".codex"), "config.toml");
}
/** The harness folder a launch configuration's `env` names with `variable` (one of
 *  HARNESS_FOLDER_VAR): `{dir}` from a literal or a {fromEnv} resolved from the host `base`;
 *  `{problem}` when the reference is not set on this host (with its `fromEnv`) or the path is not
 *  absolute; null when the configuration leaves it to the host. The one reader of a launch
 *  configuration's folder, for every harness: the trust code (claude, codex) and the pi bridge. It
 *  lives here because this module owns the table of which variable moves which harness's folder and
 *  reads nothing but files, so core.mjs, harness-trust-write.mjs and pi-bridge.mjs each import it and
 *  none imports another for it. pi expands a leading `~` itself, against HOME, so its folder is read
 *  that way; Claude Code and Codex take the value as it is. */
export function launchConfigFolder(variable, configEnv = {}, base = process.env) {
  if (!variable || !Object.hasOwn(configEnv || {}, variable)) return null;
  const v = configEnv[variable];
  const named = typeof v === "string" ? v : base[v?.fromEnv];
  if (named === undefined) return { problem: `${variable} references ${v?.fromEnv}, not set on this host`, fromEnv: v?.fromEnv };
  const dir = variable === HARNESS_FOLDER_VAR.pi ? named.replace(/^~(?=$|\/)/, () => userHome(base)) : named;
  return isAbsolute(dir) ? { dir } : { problem: `${variable} ${JSON.stringify(named)} is not an absolute path` };
}

/** `dir` and its ancestors, nearest first. */
function* upwards(dir) {
  for (let d = real(dir); ; d = dirname(d)) { yield d; if (dirname(d) === d) return; }
}

/** Whether Claude Code trusts `home` without asking: an accepted trust entry for the home or
 *  an ancestor, up to and including the nearest git root. */
export function claudeTrusts(home, { env = process.env } = {}) {
  let projects;
  try { projects = JSON.parse(readFileSync(harnessConfigFile("claude", env), "utf8"))?.projects; } catch { return false; }
  if (!projects || typeof projects !== "object") return false;
  for (const d of upwards(home)) {
    if (Object.hasOwn(projects, d) && projects[d]?.hasTrustDialogAccepted === true) return true;
    if (existsSync(join(d, ".git"))) return false;
  }
  return false;
}

/** A TOML key: bare, "basic" (JSON-compatible escapes) or 'literal'. null when not a key. */
function tomlKey(text) {
  const t = text.trim();
  if (/^[A-Za-z0-9_-]+$/.test(t)) return t;
  if (/^'[^']*'$/.test(t)) return t.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) { try { return JSON.parse(t); } catch { return null; } }
  return null;
}
/** A dotted TOML key path, split on the dots outside quotes. null when any part is not a key. */
function tomlPath(text) {
  const parts = [];
  let cur = "", quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { cur += c; if (c === "\\" && quote === '"') cur += text[++i] ?? ""; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'") { quote = c; cur += c; }
    else if (c === ".") { parts.push(cur); cur = ""; }
    else cur += c;
  }
  if (quote) return null;
  parts.push(cur);
  const keys = parts.map(tomlKey);
  return keys.includes(null) ? null : keys;
}
const tomlString = (text) => { const t = text.trim(); return /^'[^']*'$/.test(t) || /^"(?:[^"\\]|\\.)*"$/.test(t) ? tomlKey(t) : null; };
/** The text of a line before a `#` comment that is outside quotes. */
function uncommented(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}
/** `key = value` split at the first `=` outside quotes. */
function assignment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "=") return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

/** The directories config.toml marks `trust_level = "trusted"`, in the forms Codex writes and
 *  their plain TOML equivalents: `[projects."<dir>"]` tables, `"<dir>" = { trust_level = … }`
 *  under `[projects]`, and dotted `projects."<dir>".trust_level` keys. */
export function codexTrustedDirs(text) {
  const trusted = new Set();
  let table = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = uncommented(raw).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const m = /^\[\s*([^[\]]+?)\s*\]$/.exec(line);
      table = m && !line.startsWith("[[") ? tomlPath(m[1]) ?? [null] : [null];
      continue;
    }
    const kv = assignment(line);
    if (!kv) continue;
    const key = tomlPath(kv[0].trim());
    if (!key) continue;
    const path = [...table, ...key], value = kv[1].trim();
    if (path.length === 3 && path[0] === "projects" && path[2] === "trust_level" && tomlString(value) === "trusted") trusted.add(path[1]);
    const inline = /^\{\s*trust_level\s*=\s*("[^"]*"|'[^']*')\s*\}$/.exec(value);
    if (path.length === 2 && path[0] === "projects" && inline && tomlString(inline[1]) === "trusted") trusted.add(path[1]);
  }
  return trusted;
}

/** Whether Codex's config trusts the deployment `root` or one of its ancestors: the operator's
 *  one-time consent for the kernel to trust each new home under it at launch. */
export function codexTrustsRoot(root, { env = process.env } = {}) {
  let trusted;
  try { trusted = codexTrustedDirs(readFileSync(harnessConfigFile("codex", env), "utf8")); } catch { return false; }
  for (const d of upwards(root)) if (trusted.has(d)) return true;
  return false;
}

/** The deployment path as one shell word: as is when it needs no quoting, else single-quoted. */
const shellWord = value => /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** The spawn and readiness warning for a launch whose harness configuration does not trust the
 *  deployment (`file`, the file the launch reads, and `from`, where the launch gets the variable
 *  that selects it; `problem` when the launch configuration does not resolve it); null when
 *  `covered`, or for a harness without folder trust. A missing root entry does not prove the
 *  harness will prompt (a native gate may skip it), so this says only what the file lacks, and the
 *  one operator command that writes it (never run by readiness or a launch). `unreadable` (why,
 *  and what would make it readable): the environment of the launch's pane could not be read, so
 *  which file the launch will read is not known; the warning then says that, and nothing about
 *  trust. */
export function harnessTrustWarning({ harness, root, file, from, problem, unreadable, covered }) {
  if (covered || !Object.hasOwn(CONFIG_DIR_VAR, harness)) return null;
  if (unreadable) return `${harness} folder trust: the configuration file this launch will read could not be established (${unreadable}); nothing is said about its trust`;
  if (problem) return `${harness} folder trust is not established: ${problem}`;
  return `${harness} folder trust is not established in ${file}${from ? ` (${from})` : ""}: oats harness trust --dir ${shellWord(root)}`;
}
