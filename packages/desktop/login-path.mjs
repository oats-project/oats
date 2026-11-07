// The login shell's PATH for a Desktop opened from Finder or the Dock
// (awebai/oats#468). Such a launch inherits launchd's PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so a CLI whose shebang is
// `#!/usr/bin/env node` cannot find a Homebrew or nvm node. main.mjs resolves
// the login shell's PATH ONCE at startup, before anything is spawned, and
// puts the merge in its own environment, which the backend server and every
// child inherit. Only PATH is taken from the login shell, never the rest of
// its environment. A failure keeps the inherited PATH and is reported through
// /api/cli (pathSource, pathError). The shell is spawned with the `env` it is
// given, which main cleans first (cli-environment.mjs); the shell's entries are
// merged in front of that env's PATH.
import { withoutControlToken } from "../client/control-environment.mjs";
import { spawn as nodeSpawn } from "node:child_process";
import { posix } from "node:path";

export const PATH_BEGIN = "__OATS_PATH_BEGIN__";
export const PATH_END = "__OATS_PATH_END__";
// An interactive login shell with a heavy rc (nvm, oh-my-zsh, conda) was
// measured at about 1.8 s on a developer Mac; 3 s covers that while bounding
// how long a broken, prompting or hanging rc can delay the app's startup.
export const LOGIN_PATH_TIMEOUT_MS = 3000;
// printenv, not "$PATH": fish expands a quoted $PATH space-joined, while
// printenv prints the exported, colon-joined value in every shell.
const COMMAND = `echo ${PATH_BEGIN}; printenv PATH; echo ${PATH_END}`;

/** $SHELL when it is absolute, else the platform's default login shell. */
export function loginShell(env, platform) {
  const shell = env?.SHELL;
  if (typeof shell === "string" && posix.isAbsolute(shell)) return shell;
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** argv for the login shell: interactive and login, so both rc layers run. */
export function loginShellArgs() {
  return ["-ilc", COMMAND];
}

/**
 * The PATH entries between the markers, ignoring whatever the rc files print
 * around them. The LAST marker pair wins, so rc noise can never stand in for
 * the answer.
 * @returns {{ ok: true, entries: string[] } | { ok: false, reason: string }}
 */
export function parseLoginPath(stdout) {
  const text = String(stdout ?? "");
  const end = text.lastIndexOf(PATH_END);
  const begin = end < 0 ? -1 : text.lastIndexOf(PATH_BEGIN, end);
  if (begin < 0) return { ok: false, reason: "no PATH markers in the login shell's output" };
  const value = text.slice(begin + PATH_BEGIN.length, end).trim();
  if (!value || /[\r\n]/.test(value)) return { ok: false, reason: "the login shell printed no single PATH line" };
  const entries = value.split(":").filter((entry) => posix.isAbsolute(entry));
  if (!entries.length) return { ok: false, reason: "the login shell's PATH has no absolute entries" };
  return { ok: true, entries };
}

/** Login entries first, then the inherited ones not already present; order kept, duplicates and relative entries dropped. */
export function mergePath(loginEntries, inherited) {
  const out = [];
  for (const entry of [...loginEntries, ...String(inherited ?? "").split(":")]) {
    if (posix.isAbsolute(entry) && !out.includes(entry)) out.push(entry);
  }
  return out.join(":");
}

/**
 * Run the login shell once and merge its PATH in front of the inherited one.
 * stdin is closed and there is no tty; the shell runs in its own process
 * group so a timeout kills whatever its rc files started too.
 * Never rejects.
 * @returns {Promise<{ path: string, source: "login-shell" | "inherited", error: string | null }>}
 */
export function resolveLoginPath({ env = process.env, platform = process.platform, timeoutMs = LOGIN_PATH_TIMEOUT_MS, spawn = nodeSpawn } = {}) {
  const inherited = typeof env.PATH === "string" ? env.PATH : "";
  const keep = (error) => ({ path: inherited, source: "inherited", error });
  if (platform === "win32") return Promise.resolve(keep("no login shell on this platform"));
  const shell = loginShell(env, platform);
  return new Promise((resolve) => {
    let settled = false, stdout = "", exit = null, child;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child?.stdout?.destroy(); // a background process may still hold the pipe
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { if (child?.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      finish(keep(`the login shell (${shell}) timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    // Settles once the shell has exited and the answer is in. Something an
    // rc file started may hold stdout open after the shell exits, so "close"
    // is only the last word, not the only one.
    const settle = (final) => {
      if (!exit) return;
      if (exit.code !== 0) return finish(keep(`the login shell (${shell}) exited with ${exit.signal ? `signal ${exit.signal}` : `status ${exit.code}`}`));
      const parsed = parseLoginPath(stdout);
      if (parsed.ok) return finish({ path: mergePath(parsed.entries, inherited), source: "login-shell", error: null });
      if (final) finish(keep(parsed.reason));
    };
    try {
      child = spawn(shell, loginShellArgs(), { env: withoutControlToken(env), stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch (e) {
      finish(keep(`the login shell (${shell}) could not start: ${e.message}`));
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk; settle(false); });
    child.on("error", (e) => finish(keep(`the login shell (${shell}) could not start: ${e.message}`)));
    child.on("exit", (code, signal) => { exit = { code, signal }; settle(false); });
    child.on("close", (code, signal) => { exit ??= { code, signal }; settle(true); });
    child.unref?.();
  });
}
