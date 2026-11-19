// When the kernel creates the OATS tmux server, the server gets the user's login environment, read
// by the login shell as one framed answer on its stdout and accepted only whole; when it cannot be
// read, the creator's fallback (awebai/oats#616). lib/login-environment.mjs and docs/execution-targets.md.
//
// The login shell is always a fake (OATS_TEST_LOGIN_SHELL, a script named bash), never the
// operator's: the fixture's HOME is not the user's home directory, so without the seam nothing is run.
// One test runs the real bash, -l -i, through a wrapper that gives it --noprofile --norc and the
// fixture's HOME and directory, so no start-up file of the operator's is read.
// The user session is a fake systemctl/launchctl first on the creator's PATH (where the platform's
// tools are looked up under the seam). Real tmux on the fixture's private TMUX_TMPDIR only.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LOGIN_SESSION_ENV, captureLoginEnvironment, parseSystemdEnvironment } from "../lib/login-environment.mjs";
import { validateLaunchConfig } from "../lib/core.mjs";
import { isolateSessionEnvironment, oatsSocket, systemExecutable, waitUntil } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const CORE = pathToFileURL(resolve(new URL("../lib/core.mjs", import.meta.url).pathname)).href;
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-login-env-")));
const restoreEnvironment = isolateSessionEnvironment(base);
const OATS = oatsSocket();
const SYSTEM = join(base, "system-bin");
const TMUX = join(SYSTEM, "tmux");
const HOME = process.env.HOME; // the fixture's
const CAT = systemExecutable("cat"), SLEEP = systemExecutable("sleep");
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const lines = (text) => text.split("\n").filter(Boolean);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const script = (dir, name, body) => { mkdirSync(join(base, dir), { recursive: true }); const p = join(base, dir, name); writeFileSync(p, `#!/bin/sh\n${body}`); chmodSync(p, 0o755); return p; };
/** A fake login shell named bash: `rc` runs first (what a user's start-up files would do), then the
 *  real `-c` command (the kernel's emitter) unless `rc` ends the script itself. */
let shells = 0;
const fakeShell = (rc) => script(`shell-${++shells}`, "bash", `${rc}\nexec /bin/sh -c "$4"\n`);
// The kernel's command ends with the nonce of this reading (hex, unquoted): a fake that forges an
// answer frames it with that nonce, or with `nonce` when the test means another one.
const START = "OATS-LOGIN-ENVIRONMENT-BEGIN-", END = "OATS-LOGIN-ENVIRONMENT-END-";
const frame = (json, nonce = '"${4##* }"') => `printf '\\n%s%s\\n%s\\n%s%s\\n' ${START} ${nonce} ${shq(json)} ${END} ${nonce}`;
// What a user's rc sets: the fixture's HOME and a plain shell (so a server's hq pane never starts a
// real one), a marker, and a PATH of its own.
const LOGIN_PATH = `/fixture/login/bin:${SYSTEM}`;
const RC = `export HOME=${shq(HOME)} SHELL=/bin/sh LOGIN_MARKER='from the login shell' PATH=${shq(LOGIN_PATH)}`;
// The user session, as systemd prints it: a plain value, two C-escaped ones (one that decodes, one
// that does not), and names a creator also has.
const SYSTEMD_OUTPUT = join(base, "systemd-output.txt");
writeFileSync(SYSTEMD_OUTPUT, ["WAYLAND_DISPLAY=wayland-fixture", "XDG_RUNTIME_DIR=$'/run/fixture/\\303\\251t\\x41'", "DBUS_SESSION_BUS_ADDRESS=$'bad\\q'", "SSH_AUTH_SOCK=/platform/agent.sock", "DISPLAY=:9", "UNRELATED=x", ""].join("\n"));
const session = (dir, systemctl) => { script(dir, "systemctl", systemctl); script(dir, "launchctl", "exit 0\n"); return join(base, dir); };
const platformBin = session("platform-bin", `exec ${CAT} ${shq(SYSTEMD_OUTPUT)}\n`);
const failingPlatformBin = session("platform-failing-bin", "exit 1\n");
const CREATOR = { PATH: `${platformBin}:${SYSTEM}`, CREATOR_ONLY: "ambient", OATS_FIXTURE_CREATOR: "creator", AWEB_FIXTURE_TOKEN: "s3cret", CLAUDE_FIXTURE_TOKEN: "s3cret", LANG: "C.UTF-8" };

const tmuxOn = (socket, ...args) => execFileSync(TMUX, ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const globalEnv = (socket = OATS) => Object.fromEntries(lines(tmuxOn(socket, "show-environment", "-g")).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
async function killServer(socket = OATS) {
  let pid;
  try { pid = Number(tmuxOn(socket, "display-message", "-p", "#{pid}")); } catch { return; }
  tmuxOn(socket, "kill-server");
  await waitUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, `the server on ${socket} has exited`);
}
const ensureScript = `import(${JSON.stringify(CORE)}).then((core) => process.stdout.write(core.ensureOatsTmuxSession("login", ${JSON.stringify(base)}))).catch((e) => { process.stdout.write(JSON.stringify({ code: e.code, message: e.message })); process.exit(1); })`;
/** One process that creates the session (and so the server) with `env` over the fixture's, which
 *  holds none of the session variables (the worker's own are not the test's). */
async function ensureIn(env, { cwd = base } = {}) {
  await killServer();
  const fixture = { ...process.env };
  for (const name of LOGIN_SESSION_ENV) delete fixture[name];
  return spawnSync(process.execPath, ["-e", ensureScript], { cwd, env: { ...fixture, PWD: cwd, ...env }, encoding: "utf8", timeout: 30000 });
}
const created = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(r.stdout, OATS, "the server is the fixture's own"); return globalEnv(); };
const warnings = (r) => lines(r.stderr).filter((l) => l.startsWith("oats: "));
const VALUES = /s3cret|ambient|from the login shell|\/fixture\/|wayland-fixture|agent\.sock|run\/fixture/;
/** The fallback of a creator outside every instance: its own environment, and exactly one line that
 *  says why, with no value in it. */
function fellBack(r, why) {
  const server = created(r);
  const said = warnings(r);
  assert.equal(said.length, 1, r.stderr);
  assert.equal(said[0], `oats: warning: could not read your login environment (${why}); the OATS tmux server is started with this process's own environment instead: a fallback, neither a login environment nor a working agent socket is assured`);
  assert.doesNotMatch(r.stderr, VALUES, "no value is printed");
  assert.equal(server.CREATOR_ONLY, "ambient", "the creator's own environment");
  assert.equal(server.LOGIN_MARKER, undefined, "nothing of a rejected answer");
  return server;
}
const groupGone = (pidFile) => waitUntil(() => { const pid = Number(readFileSync(pidFile, "utf8").trim()); try { process.kill(pid, 0); return false; } catch { return true; } }, `the process ${pidFile} names is gone`);

const fx = v2Deployment();
const baselineOf = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
/** An instance home recorded as launched on `socket`. */
async function instanceOn(name, socket) {
  const path = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  let home;
  try { ({ home } = await fx.spawn("dev", { name, harness: "claude" })); } finally { process.env.PATH = path; }
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...readJson(join(home, "instance.json")), tmux: { session: "login", window: name, socket }, launched: true }, null, 2) + "\n");
  writeFileSync(baselineOf(home), JSON.stringify({ ...readJson(baselineOf(home)), runtime: { launched: true, tmux: { session: "login", window: name, socket } } }, null, 2) + "\n", { mode: 0o600 });
  return home;
}

test.after(async () => {
  await killServer();
  restoreEnvironment();
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fx.cleanup();
});

test("the login shell's answer becomes the server's environment: nothing of the creator's own (no AWEB_ or CLAUDE_ name, nothing ambient) but what the seed carries and the operator's OATS configuration, and the server is reached with the creator's TMUX_TMPDIR", async () => {
  const r = await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: fakeShell(RC) });
  const server = created(r);
  assert.deepEqual(warnings(r), [], r.stderr);
  assert.equal(server.LOGIN_MARKER, "from the login shell");
  assert.equal(server.PATH, LOGIN_PATH);
  assert.equal(server.HOME, HOME);
  assert.equal(server.TERM, "dumb", "the seed's");
  assert.equal(server.LANG, "C.UTF-8", "the creator's locale is in the seed");
  assert.equal(server.TMUX_TMPDIR, process.env.TMUX_TMPDIR, "the creator's");
  assert.equal(server.CREATOR_ONLY, undefined);
  assert.deepEqual(Object.keys(server).filter((name) => /^(AWEB_|CLAUDE|PI_AGENT)/.test(name)), [], "no creator's AWEB_ or CLAUDE_ name");
  // The operator's OATS configuration is the creator's (docs/execution-targets.md): exactly its
  // OATS_ names that are not the kernel's, with its values.
  assert.deepEqual(Object.fromEntries(Object.entries(server).filter(([name]) => name.startsWith("OATS_"))), { OATS_FIXTURE_CREATOR: "creator", OATS_HOME_DIR: process.env.OATS_HOME_DIR });
});

test("the operator's OATS configuration is the creator's over what the login shell sets, and the kernel's and the instance-identity names the login shell exports are never the server's", async () => {
  const rc = `${RC} OATS_HOME_DIR=/fixture/rc-home OATS_INSTANCE=rc OATS_INSTANCE_HOME=/fixture/rc OATS_TASK=rc TMUX=/fixture/rc,1,0 OATS_RC_ONLY=rc`;
  const server = created(await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: fakeShell(rc) }));
  assert.equal(server.OATS_HOME_DIR, process.env.OATS_HOME_DIR, "the creator's, not the rc's");
  assert.equal(server.OATS_RC_ONLY, "rc", "one only the rc sets is the login environment's");
  for (const name of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_TASK", "TMUX", "OATS_TEST_LOGIN_SHELL"]) assert.equal(name in server, false, name);
});

test("the seed: HOME, USER, LOGNAME and SHELL from the password database and a fixed PATH, never the creator's; a creator whose HOME is not the user's home has no login shell run without the seam", async () => {
  const seen = `SEEN_HOME="$HOME" SEEN_USER="$USER" SEEN_LOGNAME="$LOGNAME" SEEN_SHELL="$SHELL" SEEN_PATH="$PATH" SEEN_PWD="$(pwd)"`;
  const user = userInfo();
  const server = created(await ensureIn({ ...CREATOR, USER: "decoy", LOGNAME: "decoy", SHELL: "/fixture/decoy/sh", OATS_TEST_LOGIN_SHELL: fakeShell(`export ${seen}\nexport HOME=${shq(HOME)} SHELL=/bin/sh`) }));
  assert.equal(server.SEEN_HOME, user.homedir);
  assert.equal(server.SEEN_USER, user.username);
  assert.equal(server.SEEN_LOGNAME, user.username);
  assert.equal(server.SEEN_SHELL, user.shell);
  assert.equal(server.SEEN_PWD, realpathSync(user.homedir), "it starts in the user's home directory");
  assert.equal(server.SEEN_PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(server.PATH, "/usr/bin:/bin:/usr/sbin:/sbin", "the seed's PATH, where the rc sets none");
  fellBack(await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: "" }), "this process's HOME is not your home directory, so it does not run in your login session");
});

test("the functions bash exports (BASH_FUNC_name%%) are dropped from the answer, not a reason to reject it", async () => {
  const ENV = systemExecutable("env");
  const server = created(await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", `${RC}\nexec ${ENV} 'BASH_FUNC_which%%=() {  echo fixture; }' /bin/sh -c "$4"\n`) }));
  assert.equal(server.LOGIN_MARKER, "from the login shell");
  assert.deepEqual(Object.keys(server).filter((name) => name.startsWith("BASH_FUNC_")), []);
});

test("a login shell ended by a signal is an acquisition failure: its group is killed and the creator falls back", async () => {
  const pidFile = join(base, "signalled.pid");
  const r = await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", `${RC}\n${SLEEP} 60 >/dev/null &\necho $! > ${shq(pidFile)}\nkill -TERM $$\n`) });
  fellBack(r, "your login shell was ended by SIGTERM");
  await groupGone(pidFile);
});

test("a noisy start-up (text on stdout and stderr before and after the answer, some shaped like assignments, JSON or a frame with another nonce) is not the answer: only the one frame of this reading is", async () => {
  const evil = '{"PATH":"/evil","HOME":"/evil"}';
  const noise = `echo 'PATH=/evil; export PATH'; echo ${shq(evil)}; ${frame(evil, "0123456789abcdef0123456789abcdef")}; echo 'HOME=/evil' >&2; printf 'bash: no job control in this shell\\n' >&2`;
  const r = await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", `${noise}\n${RC}\n${noise}\n/bin/sh -c "$4" || exit 1\n${noise}\nexit 0\n`) });
  const server = created(r);
  assert.deepEqual(warnings(r), [], r.stderr);
  assert.equal(server.PATH, LOGIN_PATH);
  assert.equal(server.HOME, HOME);
  assert.doesNotMatch(JSON.stringify(server), /\/evil/);
});

test("an answer that is not whole is rejected whole, and the creator falls back to its own environment with one line that holds no value: oversize, partial, not an object, a value that is not text, a bad name, no HOME, no PATH, a non-zero exit, an unsupported shell, a shell that cannot run", async (t) => {
  const node = shq(process.execPath);
  const answer = (json) => `${RC}\n${frame(json)}\nexit 0`;
  const cases = [
    ["oversize", `${RC}\nexec ${node} -e 'require("fs").writeSync(1, JSON.stringify({ HOME: "/h", PATH: "/p", BIG: "x".repeat(2 * 1024 * 1024) }))'`, "its answer was larger than 1 MiB"],
    ["oversize chatter around a whole answer", `${RC}\n${node} -e 'require("fs").writeSync(1, "x".repeat(2 * 1024 * 1024))'\n${frame('{"HOME":"/h","PATH":"/p"}')}\nexit 0`, "its answer was larger than 1 MiB"],
    ["no end delimiter", `${RC}\nprintf '\\n%s%s\\n%s\\n' ${START} "\${4##* }" '{"HOME":"/h","PATH":"/p"}'\nexit 0`, "its answer was not exactly one complete frame"],
    ["no start delimiter", `${RC}\nprintf '%s\\n%s%s\\n' '{"HOME":"/h","PATH":"/p"}' ${END} "\${4##* }"\nexit 0`, "its answer was not exactly one complete frame"],
    ["end before start", `${RC}\nprintf '\\n%s%s\\n{}\\n%s%s\\n' ${END} "\${4##* }" ${START} "\${4##* }"\nexit 0`, "its answer was not exactly one complete frame"],
    ["two frames", `${RC}\n${frame('{"HOME":"/h","PATH":"/p"}')}\n${frame('{"HOME":"/h2","PATH":"/p2"}')}\nexit 0`, "its answer was not exactly one complete frame"],
    ["a frame of another nonce only", `${RC}\n${frame('{"HOME":"/h","PATH":"/p"}', "0123456789abcdef0123456789abcdef")}\nexit 0`, "your login shell gave no answer"],
    ["unframed JSON only", `${RC}\necho '{"HOME":"/h","PATH":"/p"}'\nexit 0`, "your login shell gave no answer"],
    ["an empty frame", answer(""), "its answer was not one complete JSON object"],
    ["partial", answer('{"HOME":"/h","PATH":"/p'), "its answer was not one complete JSON object"],
    ["not an object", answer('["HOME","/h"]'), "its answer was not one complete JSON object"],
    ["two objects", answer('{"HOME":"/h","PATH":"/p"}{"X":"y"}'), "its answer was not one complete JSON object"],
    ["not text", answer('{"HOME":"/h","PATH":"/p","N":1}'), "its answer held a value that is not text"],
    ["bad name", answer('{"HOME":"/h","PATH":"/p","BAD-NAME":"v"}'), "its answer held a name that is not a plain identifier"],
    ["no HOME", answer('{"PATH":"/p"}'), "its answer had no HOME"],
    ["no PATH", answer('{"HOME":"/h"}'), "its answer had no PATH"],
    ["no answer", `${RC}\nexit 0`, "your login shell gave no answer"],
    ["non-zero exit", `${RC}\n/bin/sh -c "$4"\nexit 3`, "your login shell exited with status 3"],
    ["a whole answer and a non-zero exit", `${RC}\n${frame('{"HOME":"/h","PATH":"/p"}')}\nexit 2`, "your login shell exited with status 2"],
  ];
  for (const [what, rc, why] of cases) {
    const shell = script(`shell-${++shells}`, "bash", `${rc}\n`);
    t.diagnostic(what);
    fellBack(await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: shell }), why);
  }
  const sh = script(`shell-${++shells}`, "sh", `${RC}\nexec /bin/sh -c "$4"\n`);
  fellBack(await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: sh }), "your login shell (sh) is not bash, zsh or fish");
  fellBack(await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: join(base, "nowhere", "zsh") }), "your login shell could not be started (ENOENT)");
});

test("the deadline: a login shell that does not answer, and one that exits while a descendant keeps its stdout open, are both ended at 5 s, their process group is killed, and the creator falls back", async () => {
  const hanging = join(base, "hanging.pid"), holding = join(base, "holding.pid");
  let r = await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", `echo $$ > ${shq(hanging)}\nexec ${SLEEP} 60\n`) });
  fellBack(r, "your login shell did not answer within 5 s");
  await groupGone(hanging);
  const started = Date.now();
  r = await ensureIn({ ...CREATOR, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", `${RC}\n${SLEEP} 60 &\necho $! > ${shq(holding)}\n${frame('{"HOME":"/h","PATH":"/p"}')}\nexit 0\n`) });
  fellBack(r, "your login shell did not answer within 5 s");
  assert.ok(Date.now() - started < 20000, "the read ended at the deadline, not when the descendant would have");
  await groupGone(holding);
});

test("session variables in the seed, per name from the first source that has it: the creator (a present empty value counts), then the user session, where systemd's C-escaped values are decoded and one that cannot be is absent", { skip: process.platform !== "linux" && "systemd's user session is Linux's" }, async () => {
  const r = await ensureIn({ ...CREATOR, SSH_AUTH_SOCK: "/creator/agent.sock", DISPLAY: "", OATS_TEST_LOGIN_SHELL: fakeShell(RC) });
  const server = created(r);
  assert.deepEqual(warnings(r), [], r.stderr);
  assert.equal(server.SSH_AUTH_SOCK, "/creator/agent.sock", "the creator's, before the session's");
  assert.equal(server.DISPLAY, "", "present and empty: the creator's, not the session's");
  assert.equal(server.WAYLAND_DISPLAY, "wayland-fixture", "absent from the creator: the session's");
  assert.equal(server.XDG_RUNTIME_DIR, "/run/fixture/étA", "a $'…' value, decoded");
  assert.equal("DBUS_SESSION_BUS_ADDRESS" in server, false, "a value that cannot be decoded is absent");
  assert.equal("UNRELATED" in server, false, "only the session variables are taken from the session");
  // What the login shell sets wins over the seed.
  const own = await ensureIn({ ...CREATOR, SSH_AUTH_SOCK: "/creator/agent.sock", OATS_TEST_LOGIN_SHELL: fakeShell(`${RC} SSH_AUTH_SOCK=/rc/agent.sock`) });
  assert.equal(created(own).SSH_AUTH_SOCK, "/rc/agent.sock");
});

test("the user session's tool runs with the OS user's own environment, never the creator's (no token, nothing ambient)", { skip: process.platform !== "linux" && "systemd's user session is Linux's" }, async () => {
  const dump = join(base, "systemctl-env.txt");
  const recording = session("platform-recording-bin", `${systemExecutable("env")} > ${shq(dump)}\nexec ${CAT} ${shq(SYSTEMD_OUTPUT)}\n`);
  const server = created(await ensureIn({ ...CREATOR, PATH: `${recording}:${SYSTEM}`, OATS_TEST_LOGIN_SHELL: fakeShell(RC) }));
  assert.equal(server.DISPLAY, ":9");
  const seen = Object.fromEntries(lines(readFileSync(dump, "utf8")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  for (const name of ["AWEB_FIXTURE_TOKEN", "CLAUDE_FIXTURE_TOKEN", "CREATOR_ONLY", "OATS_FIXTURE_CREATOR", "OATS_TEST_LOGIN_SHELL", "LANG"]) assert.equal(name in seen, false, name);
  const user = userInfo();
  assert.equal(seen.HOME, user.homedir);
  assert.equal(seen.USER, user.username);
  assert.equal(seen.XDG_RUNTIME_DIR, `/run/user/${user.uid}`);
});

test("a user session that cannot be read leaves its names absent and is noted without values; the login environment is still used", { skip: process.platform !== "linux" && "systemd's user session is Linux's" }, async () => {
  const r = await ensureIn({ ...CREATOR, PATH: `${failingPlatformBin}:${SYSTEM}`, OATS_TEST_LOGIN_SHELL: fakeShell(RC) });
  const server = created(r);
  assert.deepEqual(warnings(r), ["oats: warning: could not read the user session's environment (systemctl --user show-environment exited with status 1); SSH_AUTH_SOCK, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS came only from your login shell"]);
  assert.equal(server.LOGIN_MARKER, "from the login shell");
  for (const name of ["SSH_AUTH_SOCK", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) assert.equal(name in server, false, name);
});

test("systemd's show-environment is read as data: plain values as they are, $'…' values decoded as bytes then UTF-8, anything else of that form absent", () => {
  const names = ["A", "B", "C", "D", "E", "F", "G"];
  assert.deepEqual(parseSystemdEnvironment([
    "A=plain value", "B=$'tab\\there\\nnew \\'q\\' \\\\ \\x41\\101'", "C=$'\\303\\251'", "D=$'\\377'", "E=$'unterminated", "F=$'bad\\z'", "G=", "H=not asked", "=noname", "",
  ].join("\n"), names), { A: "plain value", B: "tab\there\nnew 'q' \\ AA", C: "é", G: "" });
});

test("an instance: the session variables come from the server its home records, never its own; when its login environment cannot be read it copies that server, or is refused, never its ambient environment", { skip: process.platform !== "linux" && "the session part reads systemd's user session" }, async () => {
  const other = join(base, "recorded.sock");
  tmuxOn(other, "new-session", "-d", "-s", "elsewhere", "-n", "hq", "-c", base);
  tmuxOn(other, "set-environment", "-g", "SSH_AUTH_SOCK", "/recorded/agent.sock");
  tmuxOn(other, "set-environment", "-g", "RECORDED_MARKER", "from the recorded server");
  tmuxOn(other, "set-environment", "-g", "SHELL", "/bin/sh");
  tmuxOn(other, "set-environment", "-g", "WAYLAND_DISPLAY", "");
  tmuxOn(other, "set-environment", "-g", "OATS_FIXTURE_RECORDED", "recorded config");
  const home = await instanceOn("login-caller", other);
  const as = { ...CREATOR, SSH_AUTH_SOCK: "/creator/agent.sock", DISPLAY: ":creator", WAYLAND_DISPLAY: "creator-wayland", OATS_INSTANCE: "login-caller", OATS_INSTANCE_HOME: home };
  try {
    // Read: the login environment, with the recorded server's session variables and the user
    // session's for the rest.
    let r = await ensureIn({ ...as, OATS_TEST_LOGIN_SHELL: fakeShell(RC) });
    let server = created(r);
    assert.equal(server.LOGIN_MARKER, "from the login shell");
    assert.equal(server.SSH_AUTH_SOCK, "/recorded/agent.sock", "the recorded server's, not the instance's own");
    assert.equal(server.DISPLAY, ":9", "the user session's: an instance's own is never a source");
    assert.equal(server.WAYLAND_DISPLAY, "", "present and empty on the recorded server: that, not the session's nor the instance's");
    assert.equal(server.OATS_FIXTURE_RECORDED, "recorded config", "the operator's OATS configuration, from the recorded server");
    assert.equal(server.OATS_FIXTURE_CREATOR, undefined, "never the instance's own OATS_ names");
    assert.equal(server.RECORDED_MARKER, undefined, "the rest of the recorded server is not copied when the login environment is read");
    assert.equal(server.CREATOR_ONLY, undefined);
    assert.equal(server.OATS_INSTANCE_HOME, undefined);
    // Not read: a copy of the recorded server, said in one line.
    r = await ensureIn({ ...as, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", "exit 1\n") });
    server = created(r);
    assert.deepEqual(warnings(r), ["oats: warning: could not read your login environment (your login shell exited with status 1); the OATS tmux server is started with a copy of the environment of the tmux server this instance's home records instead: a fallback, neither a login environment nor a working agent socket is assured"]);
    assert.equal(server.RECORDED_MARKER, "from the recorded server");
    assert.equal(server.CREATOR_ONLY, undefined, "never the instance's ambient environment");
    assert.equal(server.SSH_AUTH_SOCK, "/recorded/agent.sock");
  } finally { await killServer(other); }
  // Not read, and the recorded server is gone: refused, no server started.
  const r = await ensureIn({ ...as, OATS_TEST_LOGIN_SHELL: script(`shell-${++shells}`, "bash", "exit 1\n") });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const refusal = JSON.parse(r.stdout);
  assert.equal(refusal.code, "E_RUNTIME_ENDPOINT_UNKNOWN");
  assert.match(refusal.message, /the environment of the tmux server that login-caller is recorded on \(.*recorded\.sock\) could not be read/);
  assert.deepEqual(warnings(r), ["oats: warning: could not read your login environment (your login shell exited with status 1); and there is no fallback from inside an instance"]);
  assert.throws(() => tmuxOn(OATS, "list-sessions"), "no server was started");
});

test("--json stdout stays one valid envelope whatever the login shell prints, and the fallback line goes to stderr", async () => {
  const probeBin = join(base, "probe-bin");
  mkdirSync(probeBin, { recursive: true });
  writeFileSync(join(probeBin, "claude"), `#!/bin/sh\nexec ${SLEEP} 600\n`);
  chmodSync(join(probeBin, "claude"), 0o755);
  const noisy = `echo '{"ok":false}'; echo 'not json' >&2`;
  for (const [what, shell, fallback] of [["read", fakeShell(`${noisy}\n${RC} PATH=${shq(`${probeBin}:${SYSTEM}`)}`), false], ["not read", script(`shell-${++shells}`, "bash", `${noisy}\nexit 2\n`), true]]) {
    await killServer();
    const r = fx.cli(["spawn", "dev", "--name", `json-${what.replace(" ", "-")}`, "--harness", "claude", "--json"], { env: { ...CREATOR, PATH: `${probeBin}:${platformBin}:${SYSTEM}`, OATS_TEST_LOGIN_SHELL: shell, OATS_TMUX_SESSION: "json", PI_AGENTS_TMUX_SESSION: "json" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const envelope = JSON.parse(r.stdout); // the whole of stdout: one envelope
    assert.equal(envelope.ok, true, what);
    assert.deepEqual(warnings(r).map((l) => /could not read your login environment/.test(l)), fallback ? [true] : [], `${what}: ${r.stderr}`);
  }
});

test("a launch configuration cannot set the login-shell test seam: it is reserved, so no instance's launch can choose the program whose answer becomes a server's environment", () => {
  assert.throws(() => validateLaunchConfig("seam", { harness: "claude", env: { OATS_TEST_LOGIN_SHELL: "/fixture/bash" } }), (e) => e.code === "E_LAUNCH_CONFIG_INVALID" && /OATS_TEST_LOGIN_SHELL/.test(e.message));
});

// A real bash, started -l -i through the kernel's own capture and emitter: bash 5.3 marks the
// descriptors it inherits from 3 to 19 close-on-exec in a login interactive shell, so an answer on a
// descriptor of its own never reached the emitter (seen on a real host, bash 5.3.15). The wrapper is the seam: it
// gives the real bash --noprofile --norc and the fixture's HOME and directory, so no start-up file is
// read (the capture seeds HOME and its directory from the password database even under the seam),
// and exports what the answer must carry back as it is. zsh and fish are not run here.
const REAL_BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p));
test("a real bash started -l -i answers through the kernel's capture: the frame on stdout survives what bash does to inherited descriptors, and values come back exactly", { skip: !REAL_BASH && "no bash on this host" }, (t) => {
  t.diagnostic(execFileSync(REAL_BASH, ["--version"], { encoding: "utf8" }).split("\n")[0]);
  const tricky = `quote ' double " dollar $HOME backtick \` newline\nend é`;
  const wrapper = script(`shell-${++shells}`, "bash", `cd ${shq(HOME)} || exit 1\nexport HOME=${shq(HOME)} REAL_BASH_FIXTURE=ran ROUND_TRIP=${shq(tricky)}\nexec ${shq(REAL_BASH)} --noprofile --norc "$@"\n`);
  if (process.platform === "linux") {
    // Whether this bash is one that closes the old channel: an inherited descriptor 3, close-on-exec under -l -i.
    const probe = spawnSync(wrapper, ["-l", "-i", "-c", "while read -r k v; do [ \"$k\" = flags: ] && echo \"flags: $v\" >&2; done < /proc/$$/fdinfo/3"], { stdio: ["ignore", "ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5000 });
    const flags = probe.stderr.match(/flags:\s*([0-7]+)/)?.[1];
    t.diagnostic(`this bash marks an inherited descriptor 3 close-on-exec under -l -i: ${flags ? (parseInt(flags, 8) & 0o2000000 ? "yes" : "no") : "unknown"}`);
  }
  const r = captureLoginEnvironment({ creatorEnv: { HOME, PATH: CREATOR.PATH, LANG: "C.UTF-8" }, shell: wrapper });
  assert.equal(r.failure, undefined, r.failure);
  assert.equal(r.env.REAL_BASH_FIXTURE, "ran", "the answer is the real bash's environment, read by the emitter it ran");
  assert.equal(r.env.HOME, HOME);
  assert.equal(r.env.ROUND_TRIP, tricky, "a value comes back byte for byte");
  assert.ok(r.env.PATH);
});
