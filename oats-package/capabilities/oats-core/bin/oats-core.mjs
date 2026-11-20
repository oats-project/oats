#!/usr/bin/env node
/**
 * oats-core: the oats.core capability's lifecycle hook (spawn, launch and upgrade).
 *
 * For a Claude Code instance it manages oats.core's own entries in the
 * instance's project settings, <home>/.claude/settings.json: Claude Code hooks
 * that report, through `oats instance waiting set|clear --producer oats.core`,
 * when the session waits on a permission prompt or a question for the human.
 * Every entry runs claude-waiting.sh (beside this file), which never affects
 * the Claude session: it exits 0, writes nothing to stdout and bounds the CLI.
 * It also adds `tui: "default"` when absent, keeping agent panes on the classic
 * renderer without Claude's fullscreen-renderer offer; any existing value stays.
 *
 * Why the project settings file and not `--settings`: Claude Code honours only
 * the LAST `--settings` flag on a command line (the last file replaces earlier
 * ones wholesale), while the project `.claude/settings.json` composes with the
 * user's settings and with a `--settings`. So oats.core owns its entries in
 * that file, marked by the absolute path of its claude-waiting.sh, and leaves
 * every other key and entry alone, besides the absent `tui` key above
 * (docs/capabilities.md, oats.core).
 *
 * Hook contract (docs/capabilities.md, Commands and hooks): run with cwd = the
 * home and OATS_EVENT, OATS_INSTANCE_HOME, OATS_HARNESS, OATS_CLI_BIN, OATS_NODE_BIN
 * (absent under a kernel older than the variable) and, for a launch preview,
 * OATS_LAUNCH_PREVIEW=1. The manifest declares `launchPreview:
 * true`: a preview writes nothing, and every pass answers the same contribution
 * (`{}`, never launch args or env), apart from a warning and, on a real pass,
 * `dialogClaims`, which is no contribution (runHook). The hooks are
 * advisory (string form): this script never throws and ends with a JSON last
 * line, exiting 0 for spawn and launch; upgrade() says when upgrade exits 1.
 *
 * The spawn hook writes the file for `oats spawn` (which runs no launch hook);
 * the launch hook rewrites it at every `oats session start|restart`, so the
 * baked node and CLI paths follow the kernel the home now runs with. The hook
 * that runs is this module copy in the home, whatever oats.core is current.
 *
 * For a pi instance, spawn and launch only warn when pi says it has no provider (piHasNoProvider).
 *
 * The upgrade hook (`oats instance upgrade`, a stopped home) adopts a home whose
 * oats.core moves: spawn and launch answer no meta, so the only state oats.core
 * keeps is those settings entries and the `tui` key. The entries name the module
 * copy's fixed path and the next launch rewrites them; an existing `tui` stays.
 * It reads nothing and calls no host; see upgrade().
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WAITING_SCRIPT = "claude-waiting.sh";
/** Claude Code's per-hook timeout, in seconds. The script bounds each CLI call at 2 s. */
export const HOOK_TIMEOUT_SECONDS = 5;
/** Claude Code's matcher for every tool. */
const ALL_TOOLS = "*";

export const PI_NO_PROVIDER_WARNING = "oats.core: pi found no provider in the environment of this command, so this session may do nothing. If the launch sets its own PI_CODING_AGENT_DIR or key, ignore this. Otherwise log in with /login in pi, or set a provider's API key, then restart it; or run this soul on another harness: oats soul launch set <soul> --harness <h>";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** POSIX single-quoting: every path in a command goes through this. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** One hook command: the script through /bin/sh (its executable bit is never relied on),
 *  stdout and stderr detached, and `exit 0` whatever happens. Stdin (Claude's JSON input)
 *  reaches the script, which reads it only for a tool clear, bounded. `marker` is the
 *  debounce marker's path ('' for none). `home` is the instance home the settings are
 *  written for, as its real path: the script acts only when $OATS_INSTANCE_HOME names
 *  that home, so a Claude process that loads these settings under another instance's
 *  environment never speaks for either home (with no `home` the script does nothing). */
export function waitingCommand({ script, node, cli, marker = "", home = "" }, args) {
  return `/bin/sh ${shq(script)} ${args.join(" ")} ${shq(node)} ${shq(cli)} ${shq(marker || "")} ${shq(home || "")} >/dev/null 2>&1; exit 0`;
}

/** Where the emitter's per-user debounce directory goes: `$XDG_RUNTIME_DIR/oats-waiting`
 *  when that is set and absolute, else `$TMPDIR/oats-waiting-<uid>` when TMPDIR is
 *  absolute, else `/tmp/oats-waiting-<uid>`. A relative value never resolves against the
 *  hook's cwd. */
export function markerDirPath(env, uid) {
  const xdg = env.XDG_RUNTIME_DIR, tmp = env.TMPDIR;
  if (typeof xdg === "string" && isAbsolute(xdg)) return join(xdg, "oats-waiting");
  return join(typeof tmp === "string" && isAbsolute(tmp) ? tmp : "/tmp", `oats-waiting-${uid}`);
}

/** The emitter's debounce directory (markerDirPath), vetted here, at spawn and
 *  launch, so the hot path (claude-waiting.sh, on every tool call) needs no `ls` or hash:
 *  created 0700 when missing, and used only when it is a real directory (not a symlink)
 *  owned by this user, mode exactly 0700, with no ACL. Returns the directory, or null for
 *  "no debounce". An existing directory is never changed. */
export function markerDir(env = process.env) {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  const dir = markerDirPath(env, uid);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") return null; }
  let st;
  try { st = lstatSync(dir); } catch { return null; }
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o700) return null;
  return hasAcl(dir) ? null : dir;
}

/** Whether `ls` shows an ACL on a directory (true when it cannot tell). "+" marks an ACL
 *  and "." an SELinux context; macOS shows "@" (xattrs) INSTEAD of "+" when both are
 *  present, so an "@" directory counts as ACL-free only when `ls -lde` lists no entry. */
function hasAcl(dir) {
  try {
    const mode = execFileSync("ls", ["-ld", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(" ")[0];
    if (mode === "drwx------" || mode === "drwx------.") return false;
    if (mode === "drwx------@") return execFileSync("ls", ["-lde", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").length !== 1;
    return true;
  } catch { return true; }
}

/** A home's marker in a vetted directory: the first 16 hex of sha256(home), the home's
 *  real path, so every spelling of a home has one marker. */
export const markerPath = (home, dir) => join(dir, `${createHash("sha256").update(home).digest("hex").slice(0, 16)}.claude`);

/** A new session starts with no claim (the kernel's session boundary voids them), so the
 *  marker state an earlier session left (intent, applied, a set's text, a lock) is forgotten. */
export function resetMarker(marker) {
  const texts = (() => { try { return readdirSync(dirname(marker)).filter((name) => name.startsWith(`${basename(marker)}.text-`)).map((name) => join(dirname(marker), name)); } catch { return []; } })();
  for (const f of [marker, `${marker}.applied`, `${marker}.force`, ...texts, join(`${marker}.lock`, "pid"), join(`${marker}.lock.reap`, "pid")]) { try { unlinkSync(f); } catch { /* absent */ } }
  for (const d of [`${marker}.lock`, `${marker}.lock.reap`]) { try { rmdirSync(d); } catch { /* absent */ } }
}

/** Whether the Claude Code this launch runs takes a StopFailure hook, by its own `--version`. The
 *  event came in 2.1.78. An older one skips a whole settings file that names it and stops an
 *  interactive start at a Settings Error dialog, measured on 2.1.61 and 2.1.77 (#1669), so only a
 *  yes writes the key. OATS_HARNESS_EXECUTABLE is the kernel's pane-side answer; absent (an older
 *  kernel, a spawn with no launch), a failure, a timeout or anything unreadable is no: a failed turn
 *  goes unreported, and the launch goes on. `--version` alone: no launch configuration's arguments. */
export function takesStopFailure(env) {
  const executable = env.OATS_HARNESS_EXECUTABLE;
  if (typeof executable !== "string" || !isAbsolute(executable)) return false;
  try {
    const said = execFileSync(executable, ["--version"], { env, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(said.trim());
    if (!version) return false;
    const [major, minor, patch] = version.slice(1).map(Number);
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 78)));
  } catch { return false; }
}

/** oats.core's Claude Code settings: only `hooks`, keyed by Claude Code event. */
export function claudeWaitingSettings({ script, node, cli, marker = "", home = "", stopFailure = false }) {
  const entry = (...args) => ({ type: "command", command: waitingCommand({ script, node, cli, marker, home }, args), timeout: HOOK_TIMEOUT_SECONDS });
  const group = (matcher, ...args) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [entry(...args)] });
  return {
    hooks: {
      // Where PermissionRequest is written the Notification is its second chance, seconds later.
      Notification: [group("permission_prompt", stopFailure ? "set-late" : "set", "permission"), group("elicitation_dialog", "set", "question")],
      // Fires as a permission dialog opens. Under the check StopFailure takes, so `reported` means
      // the same hooks on every home. No matcher: an AskUserQuestion fires it too, and the
      // script's guard keeps a `permission` from relabelling an open question.
      ...(stopFailure ? { PermissionRequest: [group(ALL_TOOLS, "set", "permission")] } : {}),
      // Tool clears are `clear-tool`: skipped when a subagent made the call.
      PreToolUse: [group("AskUserQuestion", "set", "question"), group("^(?!AskUserQuestion$).*", "clear-tool")],
      PostToolUse: [group(ALL_TOOLS, "clear-tool")],
      // A granted tool that failed: no PostToolUse follows it. (A tool the human refused at the
      // prompt, by Esc or "No", fires no hook at all in Claude Code 2.1.308; the next prompt clears.)
      PostToolUseFailure: [group(ALL_TOOLS, "clear-tool")],
      UserPromptSubmit: [group(undefined, "clear")],
      Stop: [group(undefined, "clear")],
      // An API error ended the turn, past Claude's own retries: fires instead of Stop, and
      // nothing runs after it, so only this hook can say the session is stuck (#1667). No matcher:
      // Claude 2.1.78 runs every entry for an empty class, so the script reads the class (#1670).
      ...(stopFailure ? { StopFailure: [group(undefined, "set", "failed-turn")] } : {}),
      SessionEnd: [group(undefined, "clear")],
    },
  };
}

/** Whether a hook entry is oats.core's: its command names our script by absolute path. */
function isOurs(hook, scriptPath) {
  return isObject(hook) && typeof hook.command === "string" && (hook.command.includes(scriptPath) || hook.command.includes(shq(scriptPath)));
}

/** Merge oats.core's settings into a parsed settings document, by marker: remove only
 *  the hook entries whose command names `scriptPath`, drop the matcher groups and
 *  event arrays that this removal empties, then append ours. Every other key, group
 *  and entry stays, in order. Add `tui: "default"` only when absent; any present
 *  value suppresses Claude's renderer offer and cannot be identified as ours.
 *  Returns { ok: true, settings } or { ok: false, problem }
 *  when the document is not one this merge may touch. */
export function mergeSettings(existing, ours, scriptPath) {
  if (!isObject(existing)) return { ok: false, problem: "is not a JSON object" };
  if (existing.hooks !== undefined && !isObject(existing.hooks)) return { ok: false, problem: "has a `hooks` value that is not an object" };
  const hooks = {};
  for (const [event, groups] of Object.entries(existing.hooks || {})) {
    if (!Array.isArray(groups)) return { ok: false, problem: `has a \`hooks.${event}\` value that is not an array` };
    const kept = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const entries = group.hooks.filter((hook) => !isOurs(hook, scriptPath));
      if (entries.length === group.hooks.length) kept.push(group);
      else if (entries.length) kept.push({ ...group, hooks: entries });
    }
    if (kept.length || !groups.length) hooks[event] = kept;
  }
  for (const [event, groups] of Object.entries(ours.hooks)) hooks[event] = [...(hooks[event] || []), ...groups];
  const settings = { ...existing, hooks };
  if (!Object.hasOwn(existing, "tui")) settings.tui = "default";
  return { ok: true, settings };
}

export const serialize = (settings) => `${JSON.stringify(settings, null, 2)}\n`;

/** The temp file of an atomic write: `.settings.json.oats-core-<pid>-<ms>.tmp`. */
const TMP_RE = /^\.settings\.json\.oats-core-(\d+)-\d+\.tmp$/;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Remove what an interrupted write left in `.claude`: our temp files whose writer is gone
 *  (a live writer's is left alone). Only names of our own pattern; unlink never follows a
 *  symlink. Best effort: a failure is not a warning. */
function removeStaleTemps(claudeDir) {
  let names;
  try { names = readdirSync(claudeDir); } catch { return; }
  for (const name of names) {
    const m = TMP_RE.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    try { unlinkSync(join(claudeDir, name)); } catch { /* gone, or not ours to remove */ }
  }
}

/** The real pass: bring <home>/.claude/settings.json to the merged state, its commands
 *  baked for `home` (the real path). Returns a warning or null. */
export function writeClaudeSettings({ home, script, node, cli, marker = "", stopFailure = false }) {
  const lose = "this Claude session will not report when it waits for input";
  const claudeDir = join(home, ".claude");
  const file = join(claudeDir, "settings.json");
  let dirStat;
  try { dirStat = lstatSync(claudeDir); } catch (e) { if (e.code !== "ENOENT") return `oats.core: cannot read ${claudeDir} (${e.code || e.message}); ${lose}`; }
  if (!dirStat) {
    try { mkdirSync(claudeDir, { mode: 0o755 }); } catch (e) { return `oats.core: cannot create ${claudeDir} (${e.code || e.message}); ${lose}`; }
  } else if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    return `oats.core: ${claudeDir} is not a directory (a symlink or a file); left it alone, so ${lose}`;
  }
  removeStaleTemps(claudeDir);
  let existing = {};
  let before = null;
  let fileStat;
  try { fileStat = lstatSync(file); } catch (e) { if (e.code !== "ENOENT") return `oats.core: cannot read ${file} (${e.code || e.message}); ${lose}`; }
  if (fileStat) {
    if (!fileStat.isFile()) return `oats.core: ${file} is not a regular file (a symlink or another kind); left it alone, so ${lose}`;
    let text;
    try { text = readFileSync(file, "utf8"); } catch (e) { return `oats.core: cannot read ${file} (${e.code || e.message}); ${lose}`; }
    try { existing = JSON.parse(text); } catch { return `oats.core: ${file} is not valid JSON; left it alone, so ${lose}`; }
    before = existing;
  }
  const merged = mergeSettings(existing, claudeWaitingSettings({ script, node, cli, marker, home, stopFailure }), script);
  if (!merged.ok) return `oats.core: ${file} ${merged.problem}; left it alone, so ${lose}`;
  const content = serialize(merged.settings);
  if (before !== null && content === serialize(before)) return null;
  const tmp = join(claudeDir, `.settings.json.oats-core-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* not created */ }
    return `oats.core: cannot write ${file} (${e.code || e.message}); ${lose}`;
  }
  return null;
}

/** Whether this pi says it has no model at all. A pi with no provider starts, takes its prompt and
 *  shows no error, so its home reads as running while nothing happens. Bounded, and only pi's own
 *  words count: no executable handed, a failed or slow probe, or any other answer is `false`. */
export function piHasNoProvider(env) {
  const executable = env.OATS_HARNESS_EXECUTABLE;
  if (typeof executable !== "string" || !isAbsolute(executable)) return false;
  try {
    const said = execFileSync(executable, ["--list-models"], { env, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
    return said.trimStart().startsWith("No models available");
  } catch { return false; }
}

/** The hook's answer for one event, given its environment. Never throws. */
export function runHook(event, env = process.env) {
  if (event !== "spawn" && event !== "launch") return {};
  if (env.OATS_LAUNCH_PREVIEW === "1") return {};
  if (env.OATS_HARNESS === "pi") return piHasNoProvider(env) ? { warning: PI_NO_PROVIDER_WARNING } : {};
  if (env.OATS_HARNESS !== "claude") return {};
  const home = env.OATS_INSTANCE_HOME;
  if (typeof home !== "string" || !isAbsolute(home)) return { warning: "oats.core: OATS_INSTANCE_HOME is not an absolute path; the Claude Code waiting hooks were not written" };
  const cli = env.OATS_CLI_BIN;
  if (typeof cli !== "string" || !isAbsolute(cli)) return { warning: "oats.core: OATS_CLI_BIN is not an absolute path; the Claude Code waiting hooks were not written" };
  let script;
  try { script = realpathSync(join(dirname(realpathSync(fileURLToPath(import.meta.url))), WAITING_SCRIPT)); } catch (e) {
    return { warning: `oats.core: ${WAITING_SCRIPT} is missing from the module copy (${e.code || e.message}); the Claude Code waiting hooks were not written` };
  }
  // One spelling from here on, the real path: it is what the commands carry, what the
  // script compares $OATS_INSTANCE_HOME against, and what keys the marker.
  let real;
  try { real = realpathSync(home); } catch (e) {
    return { warning: `oats.core: OATS_INSTANCE_HOME (${home}) cannot be resolved (${e.code || e.message}); the Claude Code waiting hooks were not written` };
  }
  const dir = markerDir(env);
  const marker = dir ? markerPath(real, dir) : "";
  if (marker) resetMarker(marker);
  // The node the commands name: the one the kernel hands hooks for anything that outlives them
  // (OATS_NODE_BIN, a path that survives a Node upgrade), else this process's own, as written
  // before the kernel set it. Never a warning: an older kernel is not a defect.
  const node = typeof env.OATS_NODE_BIN === "string" && isAbsolute(env.OATS_NODE_BIN) ? env.OATS_NODE_BIN : process.execPath;
  // One probe answers for the settings and for `dialogClaims`. `reported` only when these hooks were
  // written (every warning of writeClaudeSettings means they were not) and this Claude fires them: the
  // same version rule, so an older Claude, an unknown executable or a failed --version answers nothing
  // and the home reads `unknown`, never covered. Replacement includes absence: the kernel drops an
  // earlier `reported` when this hook answers nothing.
  const stopFailure = takesStopFailure(env);
  const warning = writeClaudeSettings({ home: real, script, node, cli, marker, stopFailure });
  if (warning) return { warning };
  return stopFailure ? { dialogClaims: "reported" } : {};
}

/** The upgrade hook's answer for its phase (OATS_UPGRADE_PHASE) and the exit status it
 *  ends with. oats.core records no meta, so a home whose recorded meta (OATS_META) is the
 *  empty object is adopted and carried unchanged (the kernel passes a recorded falsy value,
 *  or none, as `{}`, so those are adopted too); any other recorded meta is state this
 *  hook cannot vouch for, so plan refuses it with the respawn remedy and apply fails. An
 *  unknown phase fails. Unlike spawn and launch, a failure exits 1: the kernel reads a
 *  failed apply as refused, and its JSON warning as the diagnosis. */
export function upgrade(env = process.env) {
  let meta, problem = null;
  try { meta = JSON.parse(env.OATS_META ?? ""); } catch { problem = "OATS_META is not valid JSON"; }
  if (!problem && !isObject(meta)) problem = `OATS_META is ${JSON.stringify(meta).slice(0, 100)}, not the empty object oats.core records`;
  else if (!problem && Object.keys(meta).length) problem = `OATS_META holds keys oats.core never records (${Object.keys(meta).join(", ").slice(0, 200)})`;
  const phase = env.OATS_UPGRADE_PHASE;
  if (phase === "plan") {
    return { status: 0, answer: problem ? { adopt: false, reason: `oats.core: ${problem}`, remedy: `respawn the instance: oats retire ${env.OATS_INSTANCE}, then oats spawn` } : { adopt: true } };
  }
  if (phase !== "apply") return { status: 1, answer: { warning: "oats.core: OATS_UPGRADE_PHASE must be plan or apply" } };
  if (problem) return { status: 1, answer: { warning: `oats.core: ${problem}` } };
  return { status: 0, answer: { meta } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === "upgrade") {
    const { status, answer } = upgrade();
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    process.exitCode = status;
  } else {
    let answer;
    try { answer = runHook(process.argv[2]); } catch (e) { answer = { warning: `oats.core: ${process.argv[2]} hook failed: ${String(e?.message || e).slice(0, 200)}` }; }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    process.exitCode = 0;
  }
}
