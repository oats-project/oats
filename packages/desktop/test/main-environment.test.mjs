// Every program the main process starts gets the user's environment, computed when that child
// starts (#602): the terminal viewers and the remote terminal (terminal-io.mjs and what it
// composes), the login shell, gh, `oats workspace …`, and main's own tmux calls. Main's own
// environment is not cleaned, and the backend is the one child that gets it whole. Inert: every
// child is a recorder; an environment as a Desktop on an AppImage has it is injected.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createTerminalIo } from "../terminal-io.mjs";
import { resolveLoginPath } from "../login-path.mjs";
import { forgeEnvironment } from "../forge-cli.mjs";
import { cliWorkspace } from "../../client/workspace-cli.mjs";
import { NO_STATUS_LINE_FEATURE } from "../../client/session-attach.mjs";
import { serverSpawnSpec } from "../server-host.mjs";
import { desktopEnvironment, assertUserEnvironment, USER_PATH } from "./helpers/desktop-environment.mjs";
import { DESKTOP_TERMS } from "../renderer/desktop-terms.mjs";

const MOUNT = "/tmp/.mount_oats-dXyZ789";
const NESTING = { TMUX: "/tmp/tmux-1000/default,1,0", HERDR_SESSION: "local", HERDR_SOCKET_PATH: "/tmp/herdr.sock" };
const main = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");

// ── The terminals ───────────────────────────────────────────────────────────

const cli = { ok: true, bin: "/memory/oats", version: "0.24.13", remote: ["session", "session-upload"], features: [] };
const local = { session: "agents", window: "dev-1", socket: "/memory/tmux.sock" };
const remote = { remote: { serverId: "peer", instance: "dev-1", home: "/memory/home" } };
const control = { current: () => true };

/** createTerminalIo over recorders for everything it can start: execFileSync, spawnPty and run. */
function recordedIo(env, served = cli) {
  const sync = [], ptys = [], runs = [];
  const io = createTerminalIo({
    base: () => "http://127.0.0.1:1111", context: () => "epoch", attachmentDirectory: () => "/memory/files", env,
    fetch: async () => new Response(JSON.stringify(served)),
    fs: { stat: async () => ({ isFile: () => true, size: 1 }), mkdir: async () => {}, writeFile: async () => {} },
    execFileSync: (bin, args, options) => { sync.push({ bin, args, options }); return args.includes("new-session") ? "@99\n" : ""; },
    spawnPty: (bin, args, options) => { ptys.push({ bin, args, options }); return {}; },
    run: async (bin, args, options) => {
      runs.push({ bin, args, options });
      // The viewer is already gone: cleanup falls back to the inventory, so both tmux calls run.
      if (args.includes("kill-session")) throw new Error("can't find session");
      if (args[1] === "upload") return { stdout: '{"schemaVersion":1,"ok":true,"result":{"path":"/memory/remote/file"}}' };
      return { stdout: args[1] === "inspect" ? '{"schemaVersion":1,"ok":true,"result":{"backend":"tmux","present":true}}' : "" };
    },
  });
  return { io, sync, ptys, runs };
}

test("a local viewer: every tmux call and the PTY get the user's environment; the PTY still loses TMUX only", async () => {
  const { io, sync, ptys, runs } = recordedIo(desktopEnvironment(MOUNT, { HOME: "/home/fixture", ...NESTING }));
  const opened = io.create(io.admit(structuredClone(local)).spec, undefined, control);
  assert.ok(sync.length > 5, "preflight, the viewer session, the link and its locked keys");
  for (const call of sync) {
    assert.equal(call.bin, "tmux");
    assertUserEnvironment(call.options.env, MOUNT, `tmux ${call.args.slice(3).join(" ")}`);
    assert.equal(call.options.env.TMUX, NESTING.TMUX, "a tmux command keeps TMUX, as before");
  }
  assert.equal(ptys.length, 1); assert.ok(ptys[0].args.includes("attach-session"));
  assertUserEnvironment(ptys[0].options.env, MOUNT, "the viewer PTY");
  assert.equal(Object.hasOwn(ptys[0].options.env, "TMUX"), false);
  assert.equal(ptys[0].options.env.HERDR_SESSION, "local");
  assert.equal(ptys[0].options.cwd, "/home/fixture");
  await opened.killViewer();
  // The session (already gone, so the inventory is read), then (#1502) both of the viewer's own tables, emptied.
  const viewer = runs[0].args.at(-1).slice(1);
  assert.match(viewer, /^oatsdesk-/);
  assert.deepEqual(runs.map(call => call.args.slice(3)), [["kill-session", "-t", `=${viewer}`], ["list-sessions", "-F", "#{session_name}"],
    ["unbind-key", "-a", "-q", "-T", viewer], ["unbind-key", "-a", "-q", "-T", `${viewer}-prefix`]]);
  for (const call of runs) {
    assertUserEnvironment(call.options.env, MOUNT, `cleanup tmux ${call.args[3]}`);
    assert.equal(call.options.timeout, 4000, "the call's own options are kept");
  }
});

test("a remote terminal: `oats session inspect`, the PTY and `oats session upload` get the user's environment; the PTY still loses TMUX and the Herdr names", async () => {
  const { io, sync, ptys, runs } = recordedIo(desktopEnvironment(MOUNT, { HOME: "/home/fixture", SSH_AUTH_SOCK: "/run/agent", ...NESTING }));
  const spec = io.admit(structuredClone(remote)).spec;
  const prepared = await io.prepare(spec, control);
  io.create(spec, prepared, control);
  assert.deepEqual(await io.attachments([{ path: "/memory/file" }], spec, control), ["/memory/remote/file"]);
  assert.deepEqual(sync, [], "nothing local");
  assert.deepEqual(runs.map(call => [call.bin, call.args.slice(0, 2).join(" "), call.options.timeout]),
    [[cli.bin, "session inspect", 20000], [cli.bin, "session upload", 60000]]);
  for (const call of runs) {
    assertUserEnvironment(call.options.env, MOUNT, `oats ${call.args.slice(0, 2).join(" ")}`);
    assert.equal(call.options.env.SSH_AUTH_SOCK, "/run/agent");
  }
  assert.equal(ptys.length, 1); assert.deepEqual(ptys[0].args.slice(0, 2), ["session", "attach"]);
  assertUserEnvironment(ptys[0].options.env, MOUNT, "the remote PTY");
  assert.equal(ptys[0].options.env.SSH_AUTH_SOCK, "/run/agent", "the operator's SSH agent is kept");
  for (const name of Object.keys(NESTING)) assert.equal(Object.hasOwn(ptys[0].options.env, name), false, name);
});

test("a remote viewer opens without the kernel's status line where the CLI can leave it out (#1502): the Desktop teaches the keys itself", async () => {
  for (const [features, quiet] of [[[NO_STATUS_LINE_FEATURE], true], [[], false]]) {
    const { io, ptys } = recordedIo(desktopEnvironment(MOUNT, { HOME: "/home/fixture" }), { ...cli, features });
    const spec = io.admit(structuredClone(remote)).spec;
    io.create(spec, await io.prepare(spec, control), control);
    assert.equal(ptys[0].args.includes("--no-status-line"), quiet, JSON.stringify(features));
    assert.deepEqual(ptys[0].args.slice(0, 6), ["session", "attach", "--server", "peer", "--home", "/memory/home"]);
  }
});

test("the environment is computed when the child starts, not when the terminals were composed", () => {
  const env = desktopEnvironment(MOUNT, { HOME: "/home/fixture" });
  const { io, sync, ptys } = recordedIo(env);
  env.PATH = `${MOUNT}/usr/bin:/home/fixture/.local/bin:${USER_PATH}`; // the login shell's PATH, applied later; a profile printed an entry under the mount
  io.create(io.admit(structuredClone(local)).spec, undefined, control);
  for (const call of [...sync, ...ptys]) assert.equal(call.options.env.PATH, `/home/fixture/.local/bin:${USER_PATH}`);
  assert.equal(env.APPDIR, MOUNT, "the injected environment itself is not changed");
});

// ── The login shell ─────────────────────────────────────────────────────────

test("the login shell is spawned with the environment resolveLoginPath is given, and main gives it the cleaned one", async () => {
  const env = { PATH: USER_PATH, SHELL: "/bin/sh", KEEP: "1" }, calls = [];
  const spawn = (shell, args, options) => {
    calls.push(options);
    const child = new EventEmitter(); child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
    setImmediate(() => { child.emit("exit", 1, null); child.emit("close", 1, null); });
    return child;
  };
  await resolveLoginPath({ env, platform: "linux", spawn });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].env, env);
  assert.ok(main.includes("await resolveLoginPath({ env: cliEnvironment(process.env) })"), "main.mjs: applyLoginPath");
});

// ── gh ──────────────────────────────────────────────────────────────────────

test("gh's allow-list is picked from the cleaned environment: its PATH has no entry under the mount; its other names are unchanged", () => {
  const native = { HOME: "/home/fixture", USER: "fixture", XDG_CONFIG_HOME: "/home/fixture/.config", XDG_RUNTIME_DIR: "/run/user/1000",
    GH_CONFIG_DIR: "/home/fixture/.config/gh", DISPLAY: ":0", SSL_CERT_DIR: "/etc/ssl/certs:/usr/local/share/certs", HTTPS_PROXY: "http://proxy.example:8080" };
  for (const interactive of [false, true]) {
    const env = forgeEnvironment(desktopEnvironment(MOUNT, native), interactive);
    assert.equal(env.PATH, USER_PATH);
    for (const [name, value] of Object.entries(native)) assert.equal(env[name], value, name);
    for (const name of ["KEEP", "XDG_DATA_DIRS", "APPDIR", "ELECTRON_RUN_AS_NODE"]) assert.equal(Object.hasOwn(env, name), false, `${name} was never on the allow-list`);
  }
});

// ── oats workspace … ────────────────────────────────────────────────────────

test("`oats workspace` verbs start from the cleaned environment and still lose the kernel names", async () => {
  const cliState = { ok: true, bin: "/fixture/bin/oats", workspaceApi: 2, features: ["workspace-v2", "packages-no-approval"] };
  const env = desktopEnvironment(MOUNT, { OATS_INSTANCE_HOME: "/foreign", PI_AGENTS_ROOT: "/foreign", OATS_DEPLOYMENT: "/foreign", OATS_RESOLUTION: "foreign" });
  const before = JSON.stringify(env), seen = [];
  const result = await cliWorkspace(cliState, { action: "sync", context: "/fixture/workspace" }, DESKTOP_TERMS, { env,
    exec: (bin, argv, options, done) => { seen.push(options.env); done(null, '{"schemaVersion":1,"ok":true}'); } });
  assert.equal(result.ok, true); assert.equal(seen.length, 1);
  assertUserEnvironment(seen[0], MOUNT, "oats sync");
  for (const name of ["OATS_INSTANCE_HOME", "PI_AGENTS_ROOT", "OATS_DEPLOYMENT", "OATS_RESOLUTION"]) assert.equal(Object.hasOwn(seen[0], name), false, name);
  assert.equal(JSON.stringify(env), before, "the caller's environment is untouched");
});

// ── main.mjs itself, from its source ────────────────────────────────────────

test("main starts the backend with its whole environment and the Node-mode flag: the one child that is not cleaned", () => {
  const start = main.indexOf("spawnChild: (dirs, onPort) => {"), end = main.indexOf("return child;", start);
  assert.ok(start >= 0 && end > start, "main.mjs defines spawnChild");
  const block = main.slice(start, end);
  assert.ok(block.includes("serverSpawnSpec({ execPath: process.execPath, bin, "), "the backend is started by the executable's absolute path");
  assert.ok(block.includes("env: process.env, controlToken });"), "with main's whole environment");
  assert.ok(block.includes("spawn(spec.command, spec.args, spec.options)"), "exactly as the spec says");
  const env = desktopEnvironment();
  const spec = serverSpawnSpec({ controlToken: "main-environment-test-token-123456789012345", execPath: "/opt/OATS/oats-desktop", bin: "/opt/OATS/server/oats-web.mjs", dirs: [], port: 4820,
    pathSource: "login-shell", remoteIdentityFile: "/fixture/remote.json", home: "/home/fixture", env });
  assert.equal(spec.command, "/opt/OATS/oats-desktop");
  assert.deepEqual(spec.options.env, { ...env, ELECTRON_RUN_AS_NODE: "1", OATS_DESKTOP_TOKEN: "main-environment-test-token-123456789012345" }, "whole, plus Node mode and the server-only token");
});

test("main's own tmux calls (the orphan-viewer sweep) pass the cleaned environment, computed at the call", () => {
  const calls = main.split("\n").filter(line => line.includes('execFileSync("tmux"'));
  assert.equal(calls.length, 2, "tmuxRun and the sweep's inventory");
  for (const line of calls) assert.ok(line.includes("env: cliEnvironment(process.env) }"), line.trim());
});
