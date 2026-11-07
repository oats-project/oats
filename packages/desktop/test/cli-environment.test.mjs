// What a program the Desktop starts receives (cli-environment.mjs, #602): the user's environment,
// without what the Desktop or its packaging added. The function case by case; the order in which
// a Desktop process that runs as Node cleans itself, read from the sources; and the login shell's
// PATH as main composes it. Inert: no process is started (the login shell is an injected spawn).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { cliEnvironment } from "../../client/cli-environment.mjs";
import { forgeEnvironment } from "../forge-cli.mjs";
import { PATH_BEGIN, PATH_END, resolveLoginPath } from "../login-path.mjs";
import { desktopEnvironment, assertUserEnvironment, mountEntries, LAUNCHER_DATA_DIRS, USER_PATH } from "./helpers/desktop-environment.mjs";

const MOUNT = "/tmp/.mount_oats-dAbC123";
/** The result for a source that has only `APPDIR` and `values`, without the names removed whole. */
const mounted = (values, appdir = MOUNT) => cliEnvironment({ APPDIR: appdir, ...values });

// ── 1. The function ─────────────────────────────────────────────────────────

test("ELECTRON_RUN_AS_NODE and CHROME_DESKTOP are removed whole, with or without an AppImage", () => {
  assert.deepEqual(cliEnvironment({ ELECTRON_RUN_AS_NODE: "1", CHROME_DESKTOP: "oats-desktop.desktop", HOME: "/home/fixture" }), { HOME: "/home/fixture" });
  assert.deepEqual(mounted({ ELECTRON_RUN_AS_NODE: "1", CHROME_DESKTOP: "oats-desktop.desktop", HOME: "/home/fixture" }), { HOME: "/home/fixture" });
  assert.deepEqual(cliEnvironment({ ELECTRON_RUN_AS_NODE: undefined, CHROME_DESKTOP: 7 }), {}, "whatever their value");
});

test("MallocNanoZone is removed only when it is exactly the string \"0\"", () => {
  assert.deepEqual(cliEnvironment({ MallocNanoZone: "0" }), {});
  assert.deepEqual(cliEnvironment({ MallocNanoZone: "1" }), { MallocNanoZone: "1" });
  assert.deepEqual(cliEnvironment({ MallocNanoZone: 0 }), { MallocNanoZone: 0 }, "a number is not the string");
});

test("another ELECTRON_* name the user set is kept", () => {
  assert.deepEqual(mounted({ ELECTRON_ENABLE_LOGGING: "1", ELECTRON_RUN_AS_NODE: "1" }), { ELECTRON_ENABLE_LOGGING: "1" });
});

test("with a usable APPDIR the four AppImage names are removed whole", () => {
  assert.deepEqual(cliEnvironment({ APPDIR: MOUNT, APPIMAGE: "/home/fixture/oats-desktop.AppImage", ARGV0: "./oats-desktop.AppImage", OWD: "/home/fixture", HOME: "/home/fixture" }),
    { HOME: "/home/fixture" });
});

test("a name whose value is only entries under the mount is removed", () => {
  assert.deepEqual(mounted({ LD_LIBRARY_PATH: `${MOUNT}/usr/lib` }), {});
  assert.deepEqual(mounted({ GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas` }), {});
  assert.deepEqual(mounted({ ANY_NAME: `${MOUNT}:${MOUNT}/usr/sbin` }), {}, "the rule is on values, whatever the name");
});

test("the user's entries after the mount's remain, in order", () => {
  assert.deepEqual(mounted({ PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin` }), { PATH: "/usr/local/bin:/usr/bin" });
});

test("XDG_DATA_DIRS as the shipped launcher writes it, with and without a user value", () => {
  // "${APPDIR}/usr/share/${XDG_DATA_DIRS:+:${XDG_DATA_DIRS}}:/usr/share/gnome:/usr/local/share/:/usr/share/"
  assert.deepEqual(mounted({ XDG_DATA_DIRS: `${MOUNT}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/` }),
    { XDG_DATA_DIRS: "/usr/share/gnome:/usr/local/share/:/usr/share/" }, "no user value: the three appended entries stay (a stated limit)");
  assert.deepEqual(mounted({ XDG_DATA_DIRS: `${MOUNT}/usr/share/:/home/fixture/.local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/` }),
    { XDG_DATA_DIRS: "/home/fixture/.local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/" }, "the user's entries, then the three appended ones");
});

test("the mount's entries in the middle or at the end of a value are removed where they are", () => {
  assert.deepEqual(mounted({ PATH: `/a:${MOUNT}/usr/bin:/b:${MOUNT}` }), { PATH: "/a:/b" });
  assert.deepEqual(mounted({ PATH: `/a:/b:${MOUNT}/` }), { PATH: "/a:/b" }, "the mount with a trailing slash is under the mount");
});

test("without APPDIR the result differs from the source only by the names removed whole", () => {
  const source = { ELECTRON_RUN_AS_NODE: "1", CHROME_DESKTOP: "x", MallocNanoZone: "0", HOME: "/home/fixture",
    APPIMAGE: "/the/user/has/one", ARGV0: "argv0", OWD: "/somewhere", PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/bin`, LD_LIBRARY_PATH: `${MOUNT}/usr/lib` };
  const { ELECTRON_RUN_AS_NODE, CHROME_DESKTOP, MallocNanoZone, ...rest } = source;
  assert.deepEqual(cliEnvironment(source), rest, "no value is scanned and the AppImage names a user has are left alone");
});

test("an APPDIR that is relative, empty, the root or not a string is treated as absent", () => {
  for (const appdir of ["mount", "./mount", "", "/", "//", undefined, 7]) {
    const source = { APPDIR: appdir, APPIMAGE: "/image", ARGV0: "argv0", OWD: "/owd", PATH: "/:/usr/bin:mount/bin", LD_LIBRARY_PATH: "/usr/lib" };
    assert.deepEqual(cliEnvironment(source), source, JSON.stringify(appdir) ?? "undefined");
  }
});

test("an APPDIR with trailing slashes is the same mount", () => {
  for (const appdir of [`${MOUNT}/`, `${MOUNT}//`]) {
    assert.deepEqual(mounted({ PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/bin`, LD_LIBRARY_PATH: `${MOUNT}/usr/lib` }, appdir), { PATH: "/usr/bin" }, appdir);
  }
});

test("a value that contains the mount's path but has no entry that starts with it is unchanged", () => {
  const values = { OPTIONS: `--dir=${MOUNT}/x`, NOTE: `see ${MOUNT}/readme`, LESSOPEN: `| ${MOUNT}/bin/filter %s` };
  assert.deepEqual(mounted(values), values);
});

test("a sibling of the mount is unchanged", () => {
  const values = { LD_LIBRARY_PATH: `${MOUNT}2/lib`, PATH: `${MOUNT}-old/bin:/usr/bin` };
  assert.deepEqual(mounted(values), values);
});

test("a colon-separated value that is not a path list is unchanged, byte for byte", () => {
  const values = { LS_COLORS: "rs=0:di=01;34:ln=01;36::ex=01;32:", HTTPS_PROXY: "http://proxy.example:8080", EMPTY: "", MANPATH: ":/usr/share/man:" };
  assert.deepEqual(mounted(values), values, "a value that is not rewritten keeps its empty entries");
});

test("a rewritten value loses the user's own empty entries (a stated limit)", () => {
  assert.deepEqual(mounted({ PATH: `${MOUNT}::/usr/bin:` }), { PATH: "/usr/bin" });
  assert.deepEqual(mounted({ MANPATH: `:${MOUNT}/usr/share/man:` }), {}, "nothing but empty entries is left: the name is removed");
});

test("a non-string value is never scanned and passes through as it is, under its key", () => {
  const result = mounted({ OATS_INSTANCE: undefined, COUNT: 3, PATH: `${MOUNT}:/usr/bin` });
  assert.deepEqual(Object.keys(result).sort(), ["COUNT", "OATS_INSTANCE", "PATH"]);
  assert.deepEqual([result.OATS_INSTANCE, result.COUNT, result.PATH], [undefined, 3, "/usr/bin"]);
});

test("the source is never mutated and the result is a new object", () => {
  const source = Object.freeze(desktopEnvironment(MOUNT));
  const before = JSON.stringify(source);
  const result = cliEnvironment(source);
  assert.notEqual(result, source); assert.equal(JSON.stringify(source), before);
  const same = Object.freeze({ HOME: "/home/fixture" });
  assert.notEqual(cliEnvironment(same), same, "also when nothing is removed");
});

test("the whole Desktop environment becomes the user's, and the result passed through again is equal to itself", () => {
  const user = { HOME: "/home/fixture", LANG: "en_GB.UTF-8", LS_COLORS: "rs=0:di=01;34", SSH_AUTH_SOCK: "/run/user/1000/agent" };
  const result = cliEnvironment(desktopEnvironment(MOUNT, user));
  assertUserEnvironment(result, MOUNT, "the result");
  assert.deepEqual(result, { KEEP: "the user's own value", ...user, PATH: USER_PATH, XDG_DATA_DIRS: LAUNCHER_DATA_DIRS },
    "everything else passes through");
  assert.deepEqual(cliEnvironment(result), result, "idempotent");
});

test("the default source is this process's environment", () => {
  assert.deepEqual(cliEnvironment(), cliEnvironment(process.env));
});

// ── 4. The order, from the sources ──────────────────────────────────────────
// Five scans. Each says what it reads; what they do not pin (nothing imports an entry module, no
// preload, no top-level await) rests on reading and is in the README.

const PKG = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, PKG), "utf8");
/** A module's source from its first statement: without the shebang line and the comments and blank lines before it. */
function fromFirstStatement(source) {
  let rest = source.replace(/^#![^\n]*\n/, "");
  for (;;) {
    rest = rest.trimStart();
    const end = rest.startsWith("//") ? rest.indexOf("\n") : rest.startsWith("/*") ? rest.indexOf("*/") + 1 : null;
    if (end === null) return rest;
    if (end <= 0) return "";
    rest = rest.slice(end + 1);
  }
}
/** Every module a source asks for: its import statements, its re-exports, and whether it loads anything dynamically. */
function requests(source) {
  return {
    specifiers: [...source.matchAll(/^[ \t]*import\b[^;'"]*?["']([^"']+)["']/gm), ...source.matchAll(/^[ \t]*export\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)].map(match => match[1]),
    dynamic: /\bimport\s*\(|\brequire\s*\(/.test(source),
  };
}

// The collector's entry, own-environment.mjs and its leaf are in the shared home (packages/client,
// ../client/ from here); the backend's entry is here and imports own-environment.mjs from there.
test("scan 1: the backend takes its token before cleaning; the collector cleans first", () => {
  // Reads: server/oats-web.mjs and ../client/liveness-main.mjs, from their first statement.
  assert.ok(fromFirstStatement(read("server/oats-web.mjs")).startsWith('import { controlToken } from "../server-control-token.mjs";\nimport { launchEnvironment } from "../../client/own-environment.mjs";\n'), "server/oats-web.mjs");
  assert.ok(fromFirstStatement(read("../client/liveness-main.mjs")).startsWith('import "./own-environment.mjs";\n'), "../client/liveness-main.mjs");
});

test("scan 2: own-environment.mjs imports only ./cli-environment.mjs", () => {
  // Reads: every import statement, re-export and dynamic load of ../client/own-environment.mjs.
  assert.deepEqual(requests(read("../client/own-environment.mjs")), { specifiers: ["./cli-environment.mjs"], dynamic: false });
});

test("scan 3: cli-environment.mjs imports only the control scrub leaf, which imports nothing", () => {
  assert.deepEqual(requests(read("../client/cli-environment.mjs")), { specifiers: ["./control-environment.mjs"], dynamic: false });
  assert.deepEqual(requests(read("../client/control-environment.mjs")), { specifiers: [], dynamic: false });
});

test("scan 4: the launch environment goes to the collector and to nothing else", () => {
  // Reads: every .mjs, .cjs and .js file of the package outside test/, node_modules/, dist/ and
  // renderer/vendor/, and of the shared home, for the identifier; then its occurrences in
  // server/oats-web.mjs.
  const holders = [];
  const walk = dir => {
    for (const entry of readdirSync(new URL(dir, PKG), { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!["test", "node_modules", "dist", "vendor"].includes(entry.name)) walk(`${dir}${entry.name}/`); }
      else if (/\.(mjs|cjs|js)$/.test(entry.name) && /\blaunchEnvironment\b/.test(read(`${dir}${entry.name}`))) holders.push(`${dir}${entry.name}`);
    }
  };
  walk("");
  walk("../client/");
  assert.deepEqual(holders.sort(), ["../client/own-environment.mjs", "server/oats-web.mjs"]);
  const backend = read("server/oats-web.mjs");
  assert.equal(backend.match(/\blaunchEnvironment\b/g).length, 2, "in the backend: its import and one use");
  // assert.ok, not assert.match: a failure must not print the whole server source.
  assert.ok(/execFile\(process\.execPath, \[LIVENESS\], \{[^{}]*\benv: withoutControlToken\(launchEnvironment\)[^{}]*\}/.test(backend), "the one use is the collector's env");
  assert.ok(/^const LIVENESS = join\(HERE, "\.\.", "\.\.", "client", "liveness-main\.mjs"\);$/m.test(backend), "the collector is the entry module");
});

test("scan 5: liveness.mjs is a library: it has no program block", () => {
  // Reads: ../client/liveness.mjs, for what the block used (argv, stdin, stdout).
  assert.doesNotMatch(read("../client/liveness.mjs"), /process\.argv|process\.stdout|readFileSync|fileURLToPath/);
});

// ── 5. The login shell's PATH is not assumed clean ──────────────────────────

const marked = path => `${PATH_BEGIN}\n${path}\n${PATH_END}\n`;
/** An injected spawn: a login shell that prints `stdout` and exits with `code`. */
function loginShell(stdout, code = 0) {
  const calls = [];
  const spawn = (shell, args, options) => {
    calls.push({ shell, args, options });
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
    child.unref = () => {};
    setImmediate(() => { child.stdout.emit("data", stdout); child.emit("exit", code, null); child.emit("close", code, null); });
    return child;
  };
  return { spawn, calls };
}
const PROFILE_PATH = `${MOUNT}/usr/bin:/home/fixture/.local/bin`; // a profile that prints an entry under the mount

test("a profile that prints an entry under the mount: main's children and the saved gh environment do not get it", async () => {
  const live = desktopEnvironment(MOUNT);
  const shell = loginShell(marked(PROFILE_PATH));
  const resolved = await resolveLoginPath({ env: cliEnvironment(live), platform: "linux", spawn: shell.spawn });
  assertUserEnvironment(shell.calls[0].options.env, MOUNT, "the login shell");
  assert.deepEqual(resolved, { path: `${MOUNT}/usr/bin:/home/fixture/.local/bin:${USER_PATH}`, source: "login-shell", error: null },
    "cleaning the shell's input does not filter what a profile prints");
  const composed = { ...live, PATH: resolved.path }; // main: process.env.PATH = r.path, APPDIR still there
  assert.equal(cliEnvironment(composed).PATH, `/home/fixture/.local/bin:${USER_PATH}`);
  assert.equal(forgeEnvironment(composed).PATH, `/home/fixture/.local/bin:${USER_PATH}`);
});

test("the login shell cannot be read: the inherited PATH keeps the mount's entries, and no child gets them", async () => {
  const live = desktopEnvironment(MOUNT);
  const resolved = await resolveLoginPath({ env: cliEnvironment(live), platform: "linux", spawn: loginShell("", 3).spawn });
  assert.equal(resolved.source, "inherited");
  const composed = live; // main returns before assigning: its PATH is the one it was started with
  assert.deepEqual(mountEntries({ PATH: composed.PATH }, MOUNT), [`PATH=${MOUNT}`, `PATH=${MOUNT}/usr/sbin`]);
  assert.equal(cliEnvironment(composed).PATH, USER_PATH);
  assert.equal(forgeEnvironment(composed).PATH, USER_PATH);
});

/** main.mjs's own applyLoginPath, run from its source over a fake process and login shell. */
async function shippedApplyLoginPath(live, resolved) {
  const main = read("main.mjs");
  const start = main.indexOf("async function applyLoginPath() {"), end = main.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "main.mjs defines applyLoginPath");
  const given = [];
  const context = {
    process: { env: live }, console: { error() {} }, cliEnvironment,
    forgeEnvironment: (source = live, interactive) => forgeEnvironment(source, interactive),
    forgeEnv: forgeEnvironment(live),
    resolveLoginPath: async options => { given.push(options.env); return resolved; },
  };
  await runInNewContext(`let loginPath; ${main.slice(start, end + 2)}\napplyLoginPath()`, context);
  return { given, forgeEnv: context.forgeEnv };
}

test("main gives the login shell the cleaned environment, and takes gh's PATH from forgeEnvironment() after its own PATH is assigned, never from the shell's answer", async () => {
  const live = desktopEnvironment(MOUNT);
  const { given, forgeEnv } = await shippedApplyLoginPath(live, { path: `${PROFILE_PATH}:${USER_PATH}`, source: "login-shell", error: null });
  assert.equal(given.length, 1); assertUserEnvironment(given[0], MOUNT, "resolveLoginPath's env");
  assert.equal(live.PATH, `${PROFILE_PATH}:${USER_PATH}`, "main's own PATH is whatever the login merge returns, as before");
  assert.equal(forgeEnv.PATH, `/home/fixture/.local/bin:${USER_PATH}`);
  assert.equal(live.APPDIR, MOUNT, "main cleans nothing of its own");
});

test("main keeps gh's PATH as it was made at load when the login shell cannot be read", async () => {
  const live = desktopEnvironment(MOUNT);
  const { forgeEnv } = await shippedApplyLoginPath(live, { path: USER_PATH, source: "inherited", error: "the login shell (/bin/sh) exited with status 3" });
  assert.equal(live.PATH, `${MOUNT}:${MOUNT}/usr/sbin:${USER_PATH}`);
  assert.equal(forgeEnv.PATH, USER_PATH);
});

test("main deletes gh's PATH when nothing of the resolved one is left", async () => {
  const live = desktopEnvironment(MOUNT);
  const { forgeEnv } = await shippedApplyLoginPath(live, { path: `${MOUNT}/usr/bin`, source: "login-shell", error: null });
  assert.equal(Object.hasOwn(forgeEnv, "PATH"), false);
});
