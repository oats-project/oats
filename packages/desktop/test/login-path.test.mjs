// The login shell's PATH for a Desktop opened from Finder (awebai/oats#468):
// the pure parse/merge helpers, resolveLoginPath against real fake shells,
// and the original failure end to end: a `#!/usr/bin/env node` CLI whose node
// is only on the login shell's PATH, probed and then called by a real server.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBackend } from "./helpers/backend-server.mjs";
import { PATH_BEGIN, PATH_END, LOGIN_PATH_TIMEOUT_MS, loginShell, loginShellArgs, mergePath, parseLoginPath, resolveLoginPath } from "../login-path.mjs";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"; // launchd's PATH for a Finder launch
const FIXTURES = fileURLToPath(new URL("./fixtures/workspace-v2/desktop-facts/", import.meta.url));
const marked = (path) => `${PATH_BEGIN}\n${path}\n${PATH_END}\n`;

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oats-login-path-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A fake login shell: an sh script that ignores its argv (-ilc …), like an rc that prints. */
function fakeShell(dir, body, name = "fake-shell") {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

test("the shell command prints PATH between markers in every shell: printenv, never a quoted $PATH", () => {
  const [flags, command] = loginShellArgs();
  assert.equal(flags, "-ilc");
  assert.match(command, /printenv PATH/);
  assert.ok(command.includes(PATH_BEGIN) && command.includes(PATH_END));
  assert.ok(LOGIN_PATH_TIMEOUT_MS >= 2000 && LOGIN_PATH_TIMEOUT_MS <= 5000);
});

test("$SHELL is used when absolute, else the platform default", () => {
  assert.equal(loginShell({ SHELL: "/opt/homebrew/bin/fish" }, "darwin"), "/opt/homebrew/bin/fish");
  for (const SHELL of [undefined, "", "zsh", "bin/zsh"]) {
    assert.equal(loginShell({ SHELL }, "darwin"), "/bin/zsh");
    assert.equal(loginShell({ SHELL }, "linux"), "/bin/sh");
  }
});

test("noise before, after and around the markers is ignored", () => {
  const noise = "Last login: Thu\nnvm: using node v22\n\u001b[32mwelcome\u001b[0m\n";
  assert.deepEqual(parseLoginPath(`${noise}${marked("/opt/homebrew/bin:/usr/bin")}bye from .zlogout\n`),
    { ok: true, entries: ["/opt/homebrew/bin", "/usr/bin"] });
  // An rc that echoes a marker of its own never stands in for the answer: the last pair wins.
  assert.deepEqual(parseLoginPath(`${PATH_BEGIN} rc noise ${PATH_END}\n${marked("/real/bin")}`), { ok: true, entries: ["/real/bin"] });
  assert.deepEqual(parseLoginPath(`${PATH_BEGIN}/inline/bin${PATH_END}`), { ok: true, entries: ["/inline/bin"] });
});

test("missing markers, an empty or multi-line value, or no absolute entries are failures", () => {
  for (const out of ["", "/opt/homebrew/bin:/usr/bin\n", `${PATH_BEGIN}\n/usr/bin\n`, `/usr/bin\n${PATH_END}\n`, `${PATH_END}${PATH_BEGIN}`]) {
    assert.equal(parseLoginPath(out).ok, false, JSON.stringify(out));
    assert.match(parseLoginPath(out).reason, /markers/);
  }
  assert.match(parseLoginPath(marked("")).reason, /no single PATH line/);
  assert.match(parseLoginPath(`${PATH_BEGIN}\n/a\n/b\n${PATH_END}`).reason, /no single PATH line/);
  assert.match(parseLoginPath(marked("bin:./node_modules/.bin::")).reason, /no absolute entries/);
});

test("relative and empty entries are dropped", () => {
  assert.deepEqual(parseLoginPath(marked(".:/opt/homebrew/bin::bin:/usr/bin:")).entries, ["/opt/homebrew/bin", "/usr/bin"]);
});

test("merge: login entries first, then inherited ones not already present, order kept, de-duplicated", () => {
  assert.equal(mergePath(["/opt/homebrew/bin", "/usr/bin", "/opt/homebrew/bin"], SYSTEM_PATH),
    "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(mergePath(["/a"], "/b::relative:/a:/b"), "/a:/b");
  assert.equal(mergePath(["/a"], undefined), "/a");
});

test("a login shell that reports its PATH amid rc noise is merged in front of the inherited PATH", async (t) => {
  const dir = tempDir(t);
  const shell = fakeShell(dir, `echo "rc noise"; printf '${marked("/login/bin:/usr/bin")}'; echo "more noise"`);
  const r = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: shell }, platform: "darwin" });
  assert.deepEqual(r, { path: "/login/bin:/usr/bin:/bin:/usr/sbin:/sbin", source: "login-shell", error: null });
});

test("a login shell that times out leaves the inherited PATH, and the error names the timeout", async (t) => {
  const dir = tempDir(t);
  const shell = fakeShell(dir, "sleep 30");
  const started = Date.now();
  const r = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: shell }, platform: "darwin", timeoutMs: 300 });
  assert.equal(r.source, "inherited");
  assert.equal(r.path, SYSTEM_PATH);
  assert.match(r.error, /timed out after 300 ms/);
  assert.ok(Date.now() - started < 10_000, "bounded by the timeout, not by the shell");
});

test("a non-zero exit, missing markers or a missing shell leave the inherited PATH with the reason", async (t) => {
  const dir = tempDir(t);
  const failing = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: fakeShell(dir, `printf '${marked("/x")}'; exit 3`, "exit3") }, platform: "linux" });
  assert.deepEqual([failing.source, failing.path], ["inherited", SYSTEM_PATH]);
  assert.match(failing.error, /exited with status 3/);
  const silent = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: fakeShell(dir, "echo hello", "silent") }, platform: "linux" });
  assert.equal(silent.source, "inherited");
  assert.match(silent.error, /no PATH markers/);
  const missing = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: join(dir, "no-such-shell") }, platform: "linux" });
  assert.equal(missing.source, "inherited");
  assert.match(missing.error, /could not start/);
  assert.match((await resolveLoginPath({ env: { PATH: "C:\\bin" }, platform: "win32" })).error, /no login shell/);
});

test("an rc that leaves a background process holding stdout does not stall the answer", async (t) => {
  const dir = tempDir(t);
  const pidFile = join(dir, "background.pid");
  const shell = fakeShell(dir, `sleep 30 &\necho $! > '${pidFile}'\nprintf '${marked("/login/bin")}'`);
  t.after(() => { try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* gone */ } });
  const started = Date.now();
  const r = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: shell }, platform: "darwin", timeoutMs: 5000 });
  assert.equal(r.source, "login-shell");
  assert.ok(Date.now() - started < 4000, `settled on exit, not on the 5 s timeout (${Date.now() - started} ms)`);
});

/** A real backend server for one temp deployment, run with exactly the PATH main would give it. */
async function startServer(t, { dir, path, pathSource, pathError, oatsBin }) {
  const deployment = join(dir, `workspace-${pathSource}`);
  mkdirSync(join(deployment, "agents"), { recursive: true });
  writeFileSync(join(deployment, "oats-local.yaml"), "workspace: fixture\n");
  // The server asks tmux for the panes it shows, and asks the default server when a home records no
  // socket: here, in a directory of the test, removed once the server has exited, never at tmux's
  // default place, where the host has its own server.
  const tmuxTmpdir = realpathSync(mkdtempSync(join(tmpdir(), "oats-tmux-")));
  // The real backend on a private socket with a fresh credential (helpers/backend-server.mjs), in a
  // process group of its own; the CLI is the operator's --oats-bin, as for a server started by hand.
  const s = await startBackend({ dirs: [deployment], detached: true,
    args: ["--oats-bin", oatsBin, "--path-source", pathSource, ...(pathError ? ["--path-error", pathError] : [])],
    env: { ...process.env, PATH: path, SHELL: "/bin/false", FAKE_DEPLOYMENT: deployment, TMUX_TMPDIR: tmuxTmpdir,
      OATS_DESKTOP_OATS_BIN: undefined, OATS_INSTANCE_HOME: undefined, OATS_INSTANCE: undefined, OATS_DEPLOYMENT: undefined } });
  t.after(async () => {
    await s.stop();
    rmSync(tmuxTmpdir, { recursive: true, force: true });
  });
  const until = async (probe, what) => {
    for (let n = 0; n < 600; n++) {
      try { const value = await probe(); if (value) return value; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}: ${s.stderr()}`);
  };
  return { until, cli: () => until(async () => { const c = await (await s.request("/api/cli")).json(); return c.probedAt ? c : null; }, "the first probe") };
}

test("opened from Finder: a #!/usr/bin/env node CLI whose node is only on the login PATH is probed and then called", async (t) => {
  const dir = tempDir(t);
  // node lives outside launchd's PATH, as Homebrew's does; the fake records each run.
  const nodeDir = join(dir, "homebrew-bin"); mkdirSync(nodeDir);
  const nodeLog = join(dir, "node-runs.log"); writeFileSync(nodeLog, "");
  writeFileSync(join(nodeDir, "node"), `#!/bin/sh\necho "$2" >> '${nodeLog}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  // The CLI, as npm installs it: a script run through `env node`.
  writeFileSync(join(dir, "fixture-version.json"), readFileSync(join(FIXTURES, "version.json")));
  for (const name of ["status", "workspace-status"]) writeFileSync(join(dir, `fixture-${name}.json`), readFileSync(join(FIXTURES, `${name}.json`)));
  const cli = join(dir, "oats");
  writeFileSync(cli, `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const a = process.argv.slice(2);
const read = (name) => readFileSync(${JSON.stringify(dir)} + "/fixture-" + name + ".json", "utf8").replaceAll("/fixture/base/northwind-workspace", process.env.FAKE_DEPLOYMENT);
const verb = a[0] === "workspace" && a[1] === "status" ? "workspace-status" : a[0];
if (verb === "version" || verb === "status" || verb === "workspace-status") { process.stdout.write(read(verb)); process.exit(0); }
process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_UNKNOWN_COMMAND", message: a.join(" ") } }));
process.exit(1);
`, { mode: 0o755 });

  // What main.mjs does at startup: the login shell reports node's directory.
  const shell = fakeShell(dir, `echo "Last login: today"; printf '${marked(`${nodeDir}:/usr/bin:/bin`)}'`);
  const login = await resolveLoginPath({ env: { PATH: SYSTEM_PATH, SHELL: shell, HOME: dir }, platform: "darwin" });
  assert.equal(login.source, "login-shell");
  assert.equal(login.path, `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`);

  const s = await startServer(t, { dir, path: login.path, pathSource: login.source, oatsBin: cli });
  const status = await s.cli();
  assert.equal(status.ok, true, JSON.stringify(status.tried));
  assert.equal(status.bin, cli);
  assert.equal(status.pathSource, "login-shell");
  assert.equal(status.pathError, null);
  assert.equal(status.probePath, login.path);
  // A later call through the server (the roster read after admission) runs through the same node.
  await s.until(() => readFileSync(nodeLog, "utf8").split("\n").includes("status"), "a status call through env node");
  assert.ok(readFileSync(nodeLog, "utf8").split("\n").includes("version"), "the probe ran through env node");

  // Control: the inherited launchd PATH alone reproduces the report (only meaningful where no system node exists).
  if (!SYSTEM_PATH.split(":").some((d) => existsSync(join(d, "node")))) {
    const before = await startServer(t, { dir, path: SYSTEM_PATH, pathSource: "inherited", pathError: "the login shell (/bin/zsh) timed out after 3000 ms", oatsBin: cli });
    const degraded = await before.cli();
    assert.equal(degraded.ok, false);
    assert.match(degraded.tried.find((x) => x.path === cli)?.reason || "", /probe failed/);
    assert.equal(degraded.pathSource, "inherited");
    assert.equal(degraded.pathError, "the login shell (/bin/zsh) timed out after 3000 ms");
    assert.equal(degraded.probePath, SYSTEM_PATH);
  }
});
