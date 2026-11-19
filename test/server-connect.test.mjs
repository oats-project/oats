// `oats server connect` (awebai/oats#517, feature server-connect): put this
// workspace on a machine and register it, in one idempotent run of six steps
// (ssh, oats, git, deployment, register, readiness), each re-checked every run.
// The host is this kernel behind the fake ssh (helpers/fake-ssh.mjs); a fake
// npm "installs" OATS by putting this CLI on the host's PATH.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync as execFileSyncReal, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeBin, fakeLoginShell } from "./helpers/fake-ssh.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { connectServer } from "../lib/servers.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const STEPS = ["ssh", "oats", "git", "deployment", "register", "readiness"];

/** A soul set whose readiness fails the same way for two souls (a capability needing a command
 *  the host lacks), plus a third, disabled on the host, that would fail the same way. */
const ACME = { "acme.tool": { manifest: { requires: [{ command: "acme-cli", why: "the acme CLI", install: "brew install acme" }] } } };
const acmeSoul = { soul: { capabilities: { "acme.tool": { from: "here" } } } };

function setup(opts = {}) {
  const base = mkdtempSync("/tmp/oats-sc-"); // short: the control socket path must fit in 104 bytes
  const { bin, log } = fakeBin(base);
  const fx = v2Deployment(opts);
  const npmDir = join(base, "npm-bin"); mkdirSync(npmDir);
  const npmLog = join(base, "npm.log");
  writeFileSync(join(npmDir, "npm"), `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(npmLog)}
printf -- '--\\n' >> ${JSON.stringify(npmLog)}
case "$1" in
  --version) echo 10.9.0 ;;
  install)
    if [ -e ${JSON.stringify(join(base, "npm-fails"))} ]; then echo "npm error 404 Not Found - GET https://registry.npmjs.org/@awebai%2foats" >&2; exit 1; fi
    printf '#!/bin/sh\\nexec %s %s "$@"\\n' ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} > ${JSON.stringify(join(npmDir, "oats"))}
    /bin/chmod 755 ${JSON.stringify(join(npmDir, "oats"))}
    echo "added 1 package" ;;
esac
`);
  chmodSync(join(npmDir, "npm"), 0o755);
  const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home"), OATS_REMOTE_CACHE: join(base, "cache") };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|OATS_HOME$|PI_AGENT|SSH_CONNECTION)/.test(k)) delete env[k];
  const oats = (args, { cwd = fx.dep } = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd });
    return { ...r, json: () => { try { return JSON.parse(r.stdout.trim()); } catch { throw new Error(`no JSON on stdout: ${r.stdout}\n${r.stderr}`); } } };
  };
  const serversFile = join(env.OATS_HOME_DIR, "servers.json");
  const servers = () => (existsSync(serversFile) ? JSON.parse(readFileSync(serversFile, "utf8")).servers : {});
  const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").split("--\n").filter(Boolean).map((c) => c.trim().split("\n")) : []);
  const cleanup = () => { fx.cleanup(); rmSync(base, { recursive: true, force: true }); };
  return { base, bin, log, fx, env, npmDir, oats, servers, serversFile, npmCalls, cleanup, hostDir: join(env.HOME, "acme") };
}
const statuses = (res) => res.steps.map((s) => s.status);
/** The command line of every ssh call the fake ssh logged, in order. */
const sshCommands = (s) => {
  const lines = existsSync(s.log) ? readFileSync(s.log, "utf8").split("\n") : [];
  return lines.flatMap((line, i) => (line === "--" && /-host$|^nowhere$/.test(lines[i + 1] ?? "") ? [lines[i + 2]] : []));
};
/** What the host's sshd asks the login shell for first: its own name. */
const SHELL_ASK = "printf '%s\\n' \"$SHELL\"";
/** The host user's login shell is a fake `name` (helpers/fake-ssh.mjs) reading s.env.HOME's files. */
function loginShell(s, name = "zsh", files = {}) {
  const shell = fakeLoginShell(join(s.base, "remote-shells"), name);
  s.env.FAKE_REMOTE_SHELL = shell;
  for (const [file, text] of Object.entries(files)) writeFileSync(join(s.env.HOME, file), text);
  return shell;
}
const shellCalls = (s) => (existsSync(join(s.env.HOME, ".shell-calls")) ? readFileSync(join(s.env.HOME, ".shell-calls"), "utf8").split("\n").filter(Boolean) : []);
/** A directory holding an `oats` that is this CLI. */
function oatsDir(s) {
  const dir = join(s.base, "oats-bin"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oats"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(dir, "oats"), 0o755);
  return dir;
}
const stepOf = (res, name) => res.steps.find((s) => s.step === name);

test("a fresh host: no npm, then no oats, then installed, onboarded, registered and ready; a re-run does nothing", () => {
  const s = setup();
  try {
    // No npm on the host's PATH: the human installs Node or names where it lives.
    let r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    let res = r.json().result;
    assert.equal(r.json().ok, true);
    assert.equal(res.id, "box"); assert.equal(res.ready, false); assert.equal(res.registration, null);
    assert.deepEqual(res.steps.map((x) => x.step), STEPS);
    assert.deepEqual(statuses(res), ["ok", "needs-human", "skipped", "skipped", "skipped", "skipped"]);
    assert.equal(stepOf(res, "ssh").detail, "could not read box-host's login-shell PATH (its login shell (sh) is not bash, zsh or fish); using ssh's own PATH");
    assert.equal(stepOf(res, "oats").detail, "no oats at oats on box-host, and no npm on ssh's PATH");
    assert.equal(stepOf(res, "oats").remedy, "install Node.js 22.5+ (npm) on box-host where a non-interactive ssh command finds it, then check again (run the same connect); from the CLI, --path <the directory holding npm> names it instead");
    for (const name of STEPS.slice(2)) assert.equal(stepOf(res, name).detail, "waits for oats");
    assert.deepEqual(res.human, [stepOf(res, "oats").remedy]);
    assert.deepEqual(s.servers(), {}, "nothing registered");

    // npm there but no oats, without --install-oats: the exact command, for the human to run.
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--path", s.npmDir, "--json"]);
    res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "needs-human", "skipped", "skipped", "skipped", "skipped"]);
    assert.equal(stepOf(res, "oats").remedy, `on box-host: \`npm install -g @awebai/oats@${VERSION}\` (or pass --install-oats)`);
    assert.deepEqual(s.npmCalls(), [["--version"]], "npm was asked its version, nothing installed");

    // --install-oats: installed exactly this kernel's version, then the rest in the same run.
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--path", s.npmDir, "--install-oats", "--label", "Box", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "done", "ok", "done", "done", "ok"], JSON.stringify(res.steps, null, 1));
    assert.equal(stepOf(res, "oats").detail, `installed @awebai/oats ${VERSION} (was missing)`);
    assert.deepEqual(s.npmCalls().slice(1), [["--version"], ["install", "-g", `@awebai/oats@${VERSION}`]], "argv fixed: exactly this kernel's version");
    assert.equal(res.ready, true);
    assert.deepEqual(res.human, []);
    const registration = { sshHost: "box-host", workspace: s.hostDir, path: s.npmDir, label: "Box", workspaceKey: s.fx.key };
    assert.deepEqual(res.registration, registration);
    assert.deepEqual(s.servers().box, registration);
    assert.equal(existsSync(join(s.hostDir, "oats-local.yaml")), true, "onboarded at --dir on the host");

    // Idempotent: every step re-checked, nothing done twice.
    const before = s.npmCalls().length;
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--path", s.npmDir, "--install-oats", "--label", "Box", "--json"]);
    res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "ok", "ok", "ok", "ok", "ok"], JSON.stringify(res.steps, null, 1));
    assert.equal(res.ready, true);
    assert.deepEqual(s.npmCalls().slice(before), [], "an up-to-date host never reaches npm");

    // Text mode prints the steps.
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--path", s.npmDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ssh\s+ok/); assert.match(r.stdout, /readiness\s+ok/); assert.match(r.stdout, /ready/);
  } finally { s.cleanup(); }
});

test("--dir is required, inside a deployment too: E_BAD_ARGS names the host, before ssh is asked anything; a registration made before stays as it is", () => {
  const s = setup();
  try {
    const message = "--dir <path on the host> is required: the folder on box-host for this deployment (absolute, or ~/… resolved there)";
    assert.equal(s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--oats", CLI, "--json"]).status, 0);
    const registered = s.servers();
    assert.equal(registered.box.workspace, s.hostDir);
    const calls = existsSync(s.log) ? readFileSync(s.log, "utf8") : "";
    for (const cwd of [s.fx.dep, s.base]) {
      const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--workspace-ref", s.fx.repo, "--oats", CLI, "--json"], { cwd });
      assert.equal(r.status, 1, cwd);
      assert.deepEqual([r.json().error.code, r.json().error.message], ["E_BAD_ARGS", message], cwd);
    }
    const inside = s.oats(["server", "connect", "box", "--ssh", "box-host", "--oats", CLI, "--json"]);
    assert.deepEqual([inside.status, inside.json().error.code, inside.json().error.message], [1, "E_BAD_ARGS", message], "the workspace ref still defaults from the deployment; the folder does not");
    const text = s.oats(["server", "connect", "box", "--ssh", "box-host", "--oats", CLI]);
    assert.equal(text.status, 1);
    assert.ok(text.stderr.includes(message), text.stderr);
    assert.equal(existsSync(s.log) ? readFileSync(s.log, "utf8") : "", calls, "ssh was asked nothing");
    assert.deepEqual(s.servers(), registered, "the registration is unchanged");
  } finally { s.cleanup(); }
});

test("an existing deployment: ok through, readiness problems become human lines once each, disabled souls skipped", () => {
  const s = setup({ capabilities: ACME, souls: { dev: acmeSoul, qa: acmeSoul, old: acmeSoul }, local: { souls: { disabled: ["old"] } } });
  try {
    const r = s.oats(["server", "connect", "here", "--ssh", "here-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "ok", "ok", "ok", "done", "needs-human"], JSON.stringify(res.steps, null, 1));
    assert.equal(stepOf(res, "deployment").detail, `${s.fx.dep} realizes ${s.fx.key}`);
    const line = "dev, qa: acme.tool requires acme-cli: the acme CLI → brew install acme";
    assert.deepEqual(res.human, [line], "one line for the problem both souls share; the disabled soul is not checked");
    assert.equal(stepOf(res, "readiness").remedy, line);
    assert.equal(res.ready, false);
    assert.deepEqual(s.servers().here, { sshHost: "here-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: s.fx.key });
  } finally { s.cleanup(); }
});

test("git cannot read the workspace remote: needs-human at git, the rest waits; a re-run after the fix completes", () => {
  const s = setup();
  try {
    const away = `${s.fx.repo}.away`;
    renameSync(s.fx.repo, away);
    let r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    let res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "ok", "needs-human", "skipped", "skipped", "skipped"]);
    const git = stepOf(res, "git");
    assert.equal(git.code, "E_REMOTE_UNREADABLE");
    assert.match(git.detail, /cannot read remote .*not-found/);
    assert.match(git.remedy, /on box-host: make .* readable by git there/);
    assert.ok(git.remedy.includes(`\`git ls-remote ${s.fx.repo}\``), `a runnable check in backticks: ${git.remedy}`);
    for (const name of ["deployment", "register", "readiness"]) assert.equal(stepOf(res, name).detail, "waits for git");
    assert.deepEqual(res.human, [git.remedy]);
    assert.equal(existsSync(s.hostDir), false, "nothing written on the host");

    renameSync(away, s.fx.repo);
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--oats", CLI, "--json"]);
    res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "ok", "ok", "done", "done", "ok"], JSON.stringify(res.steps, null, 1));
    assert.equal(res.ready, true);
  } finally { s.cleanup(); }
});

test("a deployment of another workspace at --dir fails the run with the steps so far", () => {
  const s = setup();
  const other = v2Deployment({ name: "other" });
  try {
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", other.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 1, r.stdout);
    const { ok, error } = r.json();
    assert.equal(ok, false);
    assert.equal(error.code, "E_SERVER_WORKSPACE_MISMATCH");
    assert.deepEqual(error.details.steps.map((x) => [x.step, x.status]), [["ssh", "ok"], ["oats", "ok"], ["git", "ok"], ["deployment", "failed"]]);
    assert.equal(error.details.steps[3].code, "E_SERVER_WORKSPACE_MISMATCH");
    assert.deepEqual(s.servers(), {});
  } finally { other.cleanup(); s.cleanup(); }
});

test("a non-empty directory without oats-local.yaml is never written into", () => {
  const s = setup();
  try {
    const full = join(s.base, "full"); mkdirSync(full); writeFileSync(join(full, "notes.txt"), "mine\n");
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", full, "--oats", CLI, "--json"]);
    assert.equal(r.status, 1);
    assert.equal(r.json().error.code, "E_DIR_NOT_EMPTY");
    assert.deepEqual(r.json().error.details.steps.at(-1).step, "deployment");
    assert.deepEqual(readdirSync(full), ["notes.txt"]);
    // A relative --dir is refused before anything runs.
    const rel = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "Agents/x", "--json"]);
    assert.equal(rel.json().error.code, "E_BAD_ARGS");
  } finally { s.cleanup(); }
});

test("register: an id taken by another target fails unless --replace; the same target under another id is reported, not duplicated; a contradicted key is refused", () => {
  const s = setup();
  try {
    const write = (servers) => writeFileSync(s.serversFile, JSON.stringify({ servers }, null, 2) + "\n");
    write({ box: { sshHost: "elsewhere", workspace: "/srv/other" } });
    let r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 1);
    assert.equal(r.json().error.code, "E_SERVER_EXISTS");
    assert.equal(r.json().error.details.steps.at(-1).step, "register");
    assert.deepEqual(s.servers().box, { sshHost: "elsewhere", workspace: "/srv/other" });
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--replace", "--json"]);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(stepOf(r.json().result, "register").status, "done");
    assert.equal(s.servers().box.sshHost, "box-host");

    write({ old: { sshHost: "box-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: s.fx.key } });
    r = s.oats(["server", "connect", "new", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stdout);
    let reg = stepOf(r.json().result, "register");
    assert.equal(reg.status, "ok");
    assert.match(reg.detail, /already registered as old/);
    assert.deepEqual(Object.keys(s.servers()), ["old"], "not duplicated");
    // The same target without a key yet: the key is recorded on THAT registration (done), still not duplicated.
    write({ old: { sshHost: "box-host", workspace: s.fx.dep, oatsPath: CLI } });
    r = s.oats(["server", "connect", "new", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    reg = stepOf(r.json().result, "register");
    assert.equal(reg.status, "done");
    assert.match(reg.detail, /already registered as old/);
    assert.deepEqual(s.servers(), { old: { sshHost: "box-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: s.fx.key } });

    write({ box: { sshHost: "box-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: "github.com/acme/other" } });
    const before = readFileSync(s.serversFile, "utf8");
    r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 1);
    assert.equal(r.json().error.code, "E_SERVER_WORKSPACE_MISMATCH");
    assert.deepEqual(r.json().error.details.steps.at(-1).details, { recorded: "github.com/acme/other", reported: s.fx.key });
    assert.equal(readFileSync(s.serversFile, "utf8"), before);
  } finally { s.cleanup(); }
});

test("a failed npm install is relayed and ends the run", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "npm-fails"), "");
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--path", s.npmDir, "--install-oats", "--json"]);
    assert.equal(r.status, 1);
    const { error } = r.json();
    assert.equal(error.code, "E_REMOTE_INSTALL");
    assert.match(error.message, /npm error 404 Not Found/);
    assert.deepEqual(error.details.steps.map((x) => x.status), ["ok", "failed"]);
  } finally { s.cleanup(); }
});

test("an unreachable host fails at ssh", () => {
  const s = setup();
  try {
    writeFileSync(join(s.bin, "ssh"), "#!/bin/sh\necho 'ssh: Could not resolve hostname nowhere' >&2\nexit 255\n");
    const r = s.oats(["server", "connect", "box", "--ssh", "nowhere", "--dir", "~/acme", "--json"]);
    assert.equal(r.status, 1);
    assert.equal(r.json().error.code, "E_SSH");
    assert.deepEqual(r.json().error.details.steps.map((x) => [x.step, x.status]), [["ssh", "failed"]]);
  } finally { s.cleanup(); }
});

test("server check reports whether the host's git reads the workspace remote", () => {
  const s = setup();
  try {
    let r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.json().result.ready, true, r.stdout);
    r = s.oats(["server", "check", "box", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().result.workspaceReadable, true);
    assert.equal(Object.hasOwn(r.json().result, "workspaceReadError"), false);
    renameSync(s.fx.repo, `${s.fx.repo}.away`);
    r = s.oats(["server", "check", "box", "--json"]);
    assert.equal(r.json().result.workspaceReadable, false, r.stdout);
    assert.equal(r.json().result.workspaceReadError.code, "E_REMOTE_UNREADABLE");
    assert.equal(r.json().result.workspaceReadError.reason, "not-found");
    renameSync(`${s.fx.repo}.away`, s.fx.repo);
  } finally { s.cleanup(); }
});

test("readiness is bounded: souls the budget does not reach become one line naming the command", () => {
  // In process, over an injected transport and clock: each readiness call costs 35 s of a 60 s budget.
  let now = 0;
  const souls = ["a", "b", "c", "d"].map((name) => ({ name, problem: null }));
  const answer = (cmd) => {
    if (cmd === "true") return "";
    if (cmd === SHELL_ASK) return "/bin/sh\n";
    if (/ version --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, desktopApi: 1, name: "@awebai/oats", version: "99.0.0", features: ["server-connect"] });
    if (/ onboard .* --check --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { check: true, dir: "/srv/ws", state: "deployment", workspace: { ref: "git:github.com/acme/ws", key: "github.com/acme/ws" }, remote: { readable: true, commit: "a".repeat(40) } } });
    if (/ status --json --dir \/srv\/ws$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { root: "/srv/ws/agents", agents: [], workspace: { key: "github.com/acme/ws" } } });
    if (/ souls --json --dir \/srv\/ws$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { souls } });
    if (/ readiness --soul [a-d] --dir \/srv\/ws --json$/.test(cmd)) { now += 35000; return JSON.stringify({ schemaVersion: 1, ok: true, result: { summary: { ready: true }, checks: {} } }); }
    throw new Error(`unexpected remote command: ${cmd}`);
  };
  const execFileSync = (bin, argv) => answer(argv.at(-1));
  const prev = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = mkdtempSync("/tmp/oats-scb-");
  try {
    const res = connectServer({ id: "b", sshHost: "b-host", workspaceRef: "git:github.com/acme/ws", dir: "/srv/ws", localVersion: "0.39.0" }, { execFileSync, now: () => now });
    assert.deepEqual(statuses(res), ["ok", "ok", "ok", "ok", "done", "needs-human"]);
    assert.equal(stepOf(res, "oats").detail, "oats 99.0.0 (this kernel 0.39.0)");
    assert.deepEqual(res.human, ["readiness not checked for 2 souls: run `oats readiness --soul <s> --server b` for c, d"]);
  } finally { rmSync(process.env.OATS_HOME_DIR, { recursive: true, force: true }); if (prev === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prev; }
});

test("the requested id's own target conflict comes before the same-target twin, and text mode names the id that serves", () => {
  const s = setup();
  try {
    const write = (servers) => writeFileSync(s.serversFile, JSON.stringify({ servers }, null, 2) + "\n");
    write({ box: { sshHost: "elsewhere", workspace: "/srv/other", workspaceKey: "github.com/acme/other" }, twin: { sshHost: "box-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: s.fx.key } });
    let r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.json().error.code, "E_SERVER_EXISTS", "box still routes elsewhere: never reported ready");
    assert.equal(s.servers().box.sshHost, "elsewhere");

    // A new id whose target is already registered as twin: the success line names twin, the id that exists.
    r = s.oats(["server", "connect", "fresh", "--ssh", "box-host", "--dir", s.fx.dep, "--oats", CLI]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /twin is ready: oats spawn <soul> --server twin/);
    assert.equal(Object.hasOwn(s.servers(), "fresh"), false);
  } finally { s.cleanup(); }
});

/** The bounded-readiness transport: the fixed host answers of the budget test, with `readiness`
 *  (and optionally `souls`) handed to a REAL child process under the timeout runRemote gives it. */
function hostAnswers(souls) {
  return (cmd) => {
    if (cmd === "true") return "";
    if (cmd === SHELL_ASK) return "/bin/sh\n";
    if (/ version --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, desktopApi: 1, name: "@awebai/oats", version: "99.0.0", features: ["server-connect"] });
    if (/ onboard .* --check --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { check: true, dir: "/srv/ws", state: "deployment", workspace: { ref: "git:github.com/acme/ws", key: "github.com/acme/ws" }, remote: { readable: true, commit: "a".repeat(40) } } });
    if (/ status --json --dir \/srv\/ws$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { root: "/srv/ws/agents", agents: [], workspace: { key: "github.com/acme/ws" } } });
    if (/ souls --json --dir \/srv\/ws$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { souls: souls.map((name) => ({ name, problem: null })) } });
    throw new Error(`unexpected remote command: ${cmd}`);
  };
}
const slowChild = (opts) => execFileSyncReal(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], opts);
const isolatedHome = (fn) => {
  const prev = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = mkdtempSync("/tmp/oats-scb-");
  try { return fn(); } finally { rmSync(process.env.OATS_HOME_DIR, { recursive: true, force: true }); if (prev === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prev; }
};
const budgetOptions = { id: "b", sshHost: "b-host", workspaceRef: "git:github.com/acme/ws", dir: "/srv/ws", localVersion: "0.39.0" };

test("readiness: a check the budget cuts off is not checked (needs-human), never an ssh failure; the listing gets the budget too", () => isolatedHome(() => {
  const answer = hostAnswers(["a", "b"]);
  let listTimeout;
  const execFileSync = (bin, argv, opts) => {
    const cmd = argv.at(-1);
    if (/ souls /.test(cmd)) listTimeout = opts.timeout;
    if (/ readiness --soul a /.test(cmd)) return slowChild(opts);
    return answer(cmd);
  };
  const res = connectServer(budgetOptions, { execFileSync, readinessBudgetMs: 1500 });
  assert.ok(listTimeout <= 1500, `the soul listing runs within the budget (got ${listTimeout})`);
  assert.deepEqual(statuses(res), ["ok", "ok", "ok", "ok", "done", "needs-human"]);
  assert.deepEqual(res.human, ["readiness not checked for 2 souls: run `oats readiness --soul <s> --server b` for a, b"]);
}));

test("readiness: a soul listing the budget cuts off is one human line; a real transport failure still fails", () => isolatedHome(() => {
  const answer = hostAnswers(["a"]);
  let res = connectServer(budgetOptions, { readinessBudgetMs: 1500, execFileSync: (bin, argv, opts) => (/ souls /.test(argv.at(-1)) ? slowChild(opts) : answer(argv.at(-1))) });
  assert.equal(stepOf(res, "readiness").status, "needs-human");
  assert.deepEqual(res.human, ["readiness not checked: the host did not list its souls within 2 s; run `oats readiness --soul <s> --server b` for each soul"]);

  const lost = (bin, argv) => {
    if (/ readiness /.test(argv.at(-1))) throw Object.assign(new Error("ssh failed"), { status: 255, stdout: "", stderr: "Connection reset by peer" });
    return answer(argv.at(-1));
  };
  assert.throws(() => connectServer(budgetOptions, { execFileSync: lost }), (e) => e.code === "E_SSH" && e.details.steps.at(-1).step === "readiness");
}));

test("a --dir under ~ is registered as the absolute path the host resolved", () => {
  const s = setup();
  try {
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/x", "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const res = r.json().result;
    const abs = join(s.env.HOME, "x");
    assert.equal(res.registration.workspace, abs);
    assert.equal(s.servers().box.workspace, abs, "stored absolute, never ~");
    assert.equal(stepOf(res, "deployment").detail, `onboarded ${abs} into ${s.fx.key}`);
    assert.equal(JSON.stringify(res).includes("~"), false, "no ~ anywhere in the result");
  } finally { s.cleanup(); }
});

/** The commands of a remedy as a Markdown reader copies them: outside a span a backslash escapes the
 *  ASCII punctuation character after it (another backslash included, so `\\` then a backtick is a
 *  literal backslash and an ACTIVE backtick);
 *  otherwise a run of N backticks opens a code span that the next run of exactly N closes, with one
 *  space of padding stripped when both ends have it. */
function codeSpans(text) {
  const spans = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\" && /[!-/:-@[-`{-~]/.test(text[i + 1] ?? "")) { i += 2; continue; }
    if (text[i] !== "`") { i++; continue; }
    let n = 0; while (text[i + n] === "`") n++;
    const open = i + n;
    let close = -1;
    for (let j = open; j < text.length;) {
      if (text[j] !== "`") { j++; continue; }
      let m = 0; while (text[j + m] === "`") m++;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) { i = open; continue; }
    let body = text.slice(open, close);
    if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ")) body = body.slice(1, -1);
    spans.push(body);
    i = close + n;
  }
  return spans;
}

test("a copyable remedy passes each dynamic value as ONE literal argument, whatever it contains", () => isolatedHome(() => {
  const base = mkdtempSync("/tmp/oats-scq-");
  try {
    const marker = join(base, "MARK");
    // Odd and even runs of backslashes before a backtick: an even run leaves the backtick active once
    // Markdown has read the backslashes as escaped backslashes.
    for (const slashes of ["", "\\", "\\\\", "\\\\\\"]) {
    rmSync(join(process.env.OATS_HOME_DIR, "servers.json"), { force: true }); // each pass registers b afresh
    const hostile = join(base, `a b;touch ${marker} ${slashes}\`touch ${marker} # \` $(touch ${marker}) it's`);
    const record = join(base, "argv.json");
    const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
    for (const tool of ["git", "oats"]) {
      writeFileSync(join(bin, tool), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    const copyAndRun = (command) => {
      rmSync(record, { force: true });
      const r = spawnSync("/bin/sh", ["-c", command], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(readFileSync(record, "utf8"));
    };

    // git: the workspace remote, unreadable.
    let res = connectServer({ ...budgetOptions, workspaceRef: hostile }, { execFileSync: (bin, argv) => {
      const cmd = argv.at(-1);
      if (cmd === "true") return "";
      if (cmd === SHELL_ASK) return "/bin/sh\n";
      if (/ version --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, desktopApi: 1, version: "99.0.0", features: ["server-connect"] });
      return JSON.stringify({ schemaVersion: 1, ok: true, result: { check: true, dir: "/srv/ws", state: "absent", workspace: { ref: hostile, key: `local/${hostile}`, url: hostile }, remote: { readable: false, error: { code: "E_REMOTE_UNREADABLE", reason: "not-found", message: "missing" } } } });
    } });
    const gitSpans = codeSpans(stepOf(res, "git").remedy);
    assert.equal(gitSpans.length, 1, `the reference in the prose opens no code span of its own: ${stepOf(res, "git").remedy}`);
    assert.deepEqual(copyAndRun(gitSpans[0]), ["ls-remote", hostile]);
    assert.equal(existsSync(marker), false, "nothing but the check ran");

    // readiness: the host could not list its souls in a deployment at a hostile path.
    const answer = hostAnswers([]);
    res = connectServer({ ...budgetOptions, dir: hostile }, { execFileSync: (bin, argv) => {
      const cmd = argv.at(-1);
      if (/ onboard .* --check --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { check: true, dir: hostile, state: "deployment", workspace: { ref: "git:github.com/acme/ws", key: "github.com/acme/ws", url: "https://github.com/acme/ws" }, remote: { readable: true, commit: "a".repeat(40) } } });
      if (/ status --json --dir /.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: true, result: { agents: [], workspace: { key: "github.com/acme/ws" } } });
      if (/ souls --json --dir /.test(cmd)) return JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_CONFIG_BROKEN", message: `broken at ${hostile}` } });
      return answer(cmd);
    } });
    const soulsSpans = codeSpans(stepOf(res, "readiness").remedy);
    assert.equal(soulsSpans.length, 1, `the host's message opens no code span of its own: ${stepOf(res, "readiness").remedy}`);
    assert.deepEqual(copyAndRun(soulsSpans[0]), ["souls", "--dir", hostile]);
    assert.equal(existsSync(marker), false);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
}));

test("a host kernel of this version that does not advertise server-connect is not taken for one that does", () => isolatedHome(() => {
  // A release build of the same version (or a development kernel) without the commands connect runs there.
  let installed = false;
  const npmCalls = [];
  const execFileSync = (bin, argv) => {
    const cmd = argv.at(-1);
    if (cmd === "true") return "";
    if (cmd === SHELL_ASK) return "/bin/sh\n";
    if (/ version --json$/.test(cmd)) return JSON.stringify({ schemaVersion: 1, desktopApi: 1, version: "0.39.0", features: installed ? ["server-connect"] : ["workspace-identity"] });
    if (/^npm --version$/.test(cmd)) { npmCalls.push("version"); return "10.9.0\n"; }
    if (/^npm install -g @awebai\/oats@0\.39\.0$/.test(cmd)) { npmCalls.push("install"); installed = true; return "added 1 package\n"; }
    return hostAnswers([])(cmd);
  };
  let res = connectServer(budgetOptions, { execFileSync });
  assert.deepEqual(statuses(res), ["ok", "needs-human", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(stepOf(res, "oats").detail, "oats 0.39.0 at oats on b-host does not advertise server-connect, which connect needs there");
  assert.equal(stepOf(res, "oats").remedy, "on b-host: `npm install -g @awebai/oats@0.39.0` (or pass --install-oats)");
  assert.deepEqual(npmCalls, ["version"]);
  res = connectServer({ ...budgetOptions, installOats: true }, { execFileSync });
  assert.equal(stepOf(res, "oats").status, "done");
  assert.equal(stepOf(res, "oats").detail, "installed @awebai/oats 0.39.0 (was 0.39.0 without server-connect)");
  // An install that leaves the feature missing fails, naming it.
  installed = false;
  const stuck = (bin, argv) => (/^npm install /.test(argv.at(-1)) ? "added 0 packages\n" : execFileSync(bin, argv));
  assert.throws(() => connectServer({ ...budgetOptions, installOats: true }, { execFileSync: stuck }), (e) => e.code === "E_REMOTE_INSTALL" && /does not advertise server-connect/.test(e.message));
}));

// awebai/oats#1517: without --path, connect reads the PATH of the host user's own login shell
// ($SHELL there, run -l -i), records it as the registration's `path`, and every later hop uses it.

test("a PATH only the host's login files set is found: oats installs and resolves through it, and every later hop uses it, a later --server command too", () => {
  const s = setup();
  try {
    loginShell(s, "zsh", { ".zprofile": `PATH=${s.npmDir}:"$PATH"; export PATH\n` });
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--install-oats", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "done", "ok", "done", "done", "ok"], JSON.stringify(res.steps, null, 1));
    assert.equal(stepOf(res, "ssh").detail, "PATH from box-host's login shell (zsh -l -i), used by every later step");
    const path = `${s.npmDir}:${s.bin}`;
    const registration = { sshHost: "box-host", workspace: s.hostDir, oatsPath: join(s.npmDir, "oats"), path, workspaceKey: s.fx.key };
    assert.deepEqual(res.registration, registration);
    assert.deepEqual(s.servers().box, registration);
    assert.deepEqual(shellCalls(s).filter((c) => c.includes("-l")), ["-l -i"], "asked once, as a login and interactive shell");

    // ssh's `true`, the shell's name, the login shell's PATH; then every hop with the recorded PATH.
    const commands = sshCommands(s);
    assert.equal(commands[0], "true");
    assert.equal(commands[1], SHELL_ASK);
    assert.match(commands[2], new RegExp(`^exec ${s.env.FAKE_REMOTE_SHELL} -l -i -c `));
    const later = commands.slice(3);
    assert.ok(later.length >= 6, later.join("\n"));
    for (const cmd of later) assert.ok(cmd.startsWith(`PATH=${path}:"$PATH" `), `a hop without the login PATH: ${cmd}`);
    assert.ok(later.some((cmd) => cmd.includes(`${join(s.npmDir, "oats")} onboard `)), "the resolved oats, by its absolute path");

    // A later command against the registration: the same PATH and oats.
    const before = sshCommands(s).length;
    const check = s.oats(["server", "check", "box", "--json"]);
    assert.equal(check.status, 0, check.stderr + check.stdout);
    const routed = sshCommands(s).slice(before);
    assert.ok(routed.length > 0);
    for (const cmd of routed) assert.ok(cmd.startsWith(`PATH=${path}:"$PATH" ${join(s.npmDir, "oats")} `), cmd);
  } finally { s.cleanup(); }
});

test("a PATH only the interactive rc sets is found too: the login shell runs -i as well as -l", () => {
  const s = setup();
  try {
    // ~/.zshrc is read only by an interactive shell: a login-only read (-l) would not find npm here.
    loginShell(s, "zsh", { ".zprofile": "LOGIN_ONLY=1\n", ".zshrc": `echo 'welcome to box-host'\nPATH="$PATH":${s.npmDir}; export PATH\n` });
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--json"]);
    const res = r.json().result;
    assert.deepEqual(statuses(res), ["ok", "needs-human", "skipped", "skipped", "skipped", "skipped"]);
    assert.equal(stepOf(res, "ssh").detail, "PATH from box-host's login shell (zsh -l -i), used by every later step");
    assert.equal(stepOf(res, "oats").remedy, `on box-host: \`npm install -g @awebai/oats@${VERSION}\` (or pass --install-oats)`, "npm found on the rc's PATH");
    assert.deepEqual(s.npmCalls(), [["--version"]]);
    assert.deepEqual(shellCalls(s).filter((c) => c.includes("-l")), ["-l -i"]);
  } finally { s.cleanup(); }
});

test("even the login shell has no npm: the remedy names the login shell's PATH and a check to run there, acted on by checking again", () => {
  const s = setup();
  try {
    const shell = loginShell(s, "zsh");
    const res = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--install-oats", "--json"]).json().result;
    assert.deepEqual(statuses(res), ["ok", "needs-human", "skipped", "skipped", "skipped", "skipped"]);
    assert.equal(stepOf(res, "oats").detail, "no oats at oats on box-host, and no npm on the PATH of box-host's login shell (zsh -l -i)");
    const remedy = stepOf(res, "oats").remedy;
    assert.equal(remedy, `install Node.js 22.5+ (npm) on box-host so that its login shell finds it (there, \`${shell} -l -i -c 'command -v npm'\` prints its path), then check again (run the same connect); from the CLI, --path <the directory holding npm> names it instead`);
    assert.deepEqual(codeSpans(remedy), [`${shell} -l -i -c 'command -v npm'`], "one command, for the Desktop's copy button");
    assert.deepEqual(res.human, [remedy]);
    assert.deepEqual(s.servers(), {});
  } finally { s.cleanup(); }
});

test("an explicit --path wins: the login shell is never asked", () => {
  const s = setup();
  try {
    loginShell(s, "zsh", { ".zprofile": "PATH=/never:\"$PATH\"; export PATH\n" });
    const r = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--path", s.npmDir, "--install-oats", "--json"]);
    const res = r.json().result;
    assert.equal(res.ready, true, r.stdout);
    assert.equal(Object.hasOwn(stepOf(res, "ssh"), "detail"), false);
    assert.deepEqual(s.servers().box.path, s.npmDir);
    assert.equal(Object.hasOwn(s.servers().box, "oatsPath"), false, "oats stays as --path finds it");
    assert.equal(sshCommands(s).some((cmd) => cmd.includes("$SHELL") || cmd.includes(" -l -i ")), false, sshCommands(s).join("\n"));
    assert.deepEqual(shellCalls(s).filter((c) => c.includes("-l")), []);
  } finally { s.cleanup(); }
});

test("a login shell that is not bash, zsh or fish is never run: ssh's own PATH, with the detail", () => {
  const s = setup();
  try {
    loginShell(s, "tcsh", { ".zprofile": `PATH=${s.npmDir}:"$PATH"; export PATH\n` });
    const res = s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", "~/acme", "--json"]).json().result;
    assert.equal(stepOf(res, "ssh").status, "ok");
    assert.equal(stepOf(res, "ssh").detail, "could not read box-host's login-shell PATH (its login shell (tcsh) is not bash, zsh or fish); using ssh's own PATH");
    assert.equal(stepOf(res, "oats").detail, "no oats at oats on box-host, and no npm on ssh's PATH");
    assert.deepEqual(shellCalls(s).filter((c) => c.includes("-l")), [], "never run as a login shell");
  } finally { s.cleanup(); }
});

test("a login shell that does not answer in time is given up on: ssh's own PATH, with the detail", () => isolatedHome(() => {
  const s = setup();
  try {
    loginShell(s, "zsh", { ".zshrc": "exec sleep 30\n" });
    const execFileSync = (bin, argv, opts) => execFileSyncReal(join(s.bin, bin), argv, { ...opts, env: s.env });
    const started = Date.now();
    const res = connectServer({ ...budgetOptions, sshHost: "box-host", dir: "~/acme" }, { execFileSync, loginShellTimeoutMs: 1000 });
    assert.ok(Date.now() - started < 10000, "bounded");
    assert.equal(stepOf(res, "ssh").detail, "could not read box-host's login-shell PATH (its login shell did not answer within 1 s); using ssh's own PATH");
    assert.equal(stepOf(res, "oats").detail, "no oats at oats on box-host, and no npm on ssh's PATH");
  } finally { s.cleanup(); }
}));

test("register: a login-shell path and oats fill what an existing registration lacks, never change what it has, and replace it under --replace", () => {
  const s = setup();
  try {
    const bin = oatsDir(s);
    loginShell(s, "zsh", { ".zprofile": `PATH=${bin}:"$PATH"; export PATH\n` });
    const write = (servers) => writeFileSync(s.serversFile, JSON.stringify({ servers }, null, 2) + "\n");
    const connect = (...more) => s.oats(["server", "connect", "box", "--ssh", "box-host", "--dir", s.fx.dep, ...more, "--json"]);
    const path = `${bin}:${s.bin}`, oats = join(bin, "oats");

    // Registered before the login-shell PATH was read: filled in, the rest unchanged.
    write({ box: { sshHost: "box-host", workspace: s.fx.dep, label: "Box", workspaceKey: s.fx.key } });
    let r = connect();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    let reg = stepOf(r.json().result, "register");
    assert.deepEqual([reg.status, reg.detail], ["done", "recorded oatsPath, path"]);
    assert.deepEqual(s.servers().box, { sshHost: "box-host", workspace: s.fx.dep, label: "Box", workspaceKey: s.fx.key, oatsPath: oats, path });

    // Values it has are kept, and not reported as differing: they were not asked for.
    const own = { sshHost: "box-host", workspace: s.fx.dep, oatsPath: CLI, path: "/opt/own/bin", workspaceKey: s.fx.key };
    write({ box: own });
    r = connect();
    reg = stepOf(r.json().result, "register");
    assert.deepEqual([reg.status, Object.hasOwn(reg, "detail")], ["ok", false], JSON.stringify(reg));
    assert.deepEqual(s.servers().box, own);

    // --replace rewrites them with what this run found.
    r = connect("--replace");
    reg = stepOf(r.json().result, "register");
    assert.deepEqual([reg.status, reg.detail], ["done", "updated oatsPath, path"]);
    assert.deepEqual(s.servers().box, { sshHost: "box-host", workspace: s.fx.dep, oatsPath: oats, path, workspaceKey: s.fx.key });
  } finally { s.cleanup(); }
});
