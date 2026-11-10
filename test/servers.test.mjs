// Server registry and remote routing (lib/servers.mjs, `oats server`,
// `--server`). The SSH contract is exercised locally: a fake `ssh` on PATH
// records how it was called and runs the remote command through `sh -c`
// exactly as a login shell would, against the REAL kernel in a temp
// workspace. What is proven here is the routing, the quoting, the envelope
// handling and the snapshot lifecycle — not that any real host works.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fakeBin } from "./helpers/fake-ssh.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { dirname, join, resolve } from "node:path";

import { FAILED_SPAWN_BRANCH_LEFT, spawnInstanceAsync } from "../lib/core.mjs";
import { attachArgv, checkRemoteSupport, hostFeatures, hostSessionViewer, listSnapshots, REMOTE_SNAPSHOT_DIR, resolveRoute, rosterGroups, routeCommand, runRemote, compareSemver, remoteQuote, SERVERS_FILE, snapshotPath, sshArgv, validateServer, writeServers } from "../lib/servers.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
/** This kernel's own features: what a roster relays from a host that runs it (feature server-probe-features). */
const KERNEL_FEATURES = JSON.parse(execFileSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" })).features;

// In-process routes prepare the ssh control directory under OATS_HOME_DIR:
// never the operator's own ~/.oats. Tests that need their own set and restore it.
const isolatedHomeDir = mkdtempSync("/tmp/oats-servers-oh-");
const outerHomeDir = process.env.OATS_HOME_DIR;
process.env.OATS_HOME_DIR = isolatedHomeDir;
test.after(() => {
  if (outerHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = outerHomeDir;
  rmSync(isolatedHomeDir, { recursive: true, force: true });
});

function write(p, c) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

/** The registered "remote" workspace: a workspace deployment (oats-local.yaml
 *  over a one-repo workspace) whose soul dev works in a checkout of the member
 *  clone. `base` owns it: removed with the test's temp directory. */
const deployments = [];
function remoteDeployment(souls = {}) {
  const fx = v2Deployment({ souls: { dev: { soul: { work: "checkout" }, agents: "You are dev.\n" }, ...souls } });
  deployments.push(fx);
  return fx;
}
function remoteWorkspace() { return remoteDeployment().dep; }
test.after(() => { for (const fx of deployments) fx.cleanup(); });

function oats(env, args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: opts.cwd || env.HOME });
  if (r.error) throw r.error;
  return { ...r, json: () => { try { return JSON.parse(r.stdout.trim()); } catch { throw new Error(`no JSON on stdout: ${r.stdout}\n${r.stderr}`); } } };
}

test("remoteQuote/sshArgv: every argument survives the remote login shell byte for byte", () => {
  const args = ["plain", "with space", "it's", '"dq"', "$(touch NEVER_RUN)", "`id`", "a\nb", "", "--flag=v", "~/x", "*", "%s"];
  const target = { sshHost: "h", workspace: "/w", oatsPath: "oats" };
  const argv = sshArgv(target, args);
  assert.deepEqual(argv.slice(0, 5), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]);
  const end = argv.indexOf("--");
  assert.equal(argv[end + 1], "h"); assert.equal(argv.length, end + 3);
  // Run the produced command word through a real sh, with `oats` replaced by an argv echo.
  const cmd = argv[end + 2].replace(/^oats /, "");
  const out = execFileSync("sh", ["-c", `node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${cmd}`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), args);
  assert.equal(existsSync("NEVER_RUN"), false);
  assert.equal(remoteQuote("safe.path/x=1"), "safe.path/x=1");
  assert.equal(remoteQuote(""), "''");
  // A ~/ path prefix expands on the REMOTE shell; a spaced one stays quoted; $PATH is the remote's.
  // A cwd prefix is quoted like any argument and precedes the PATH prefix.
  const withCwd = sshArgv({ sshHost: "h", workspace: "/w", oatsPath: "oats" }, ["okf", "harvest"], { cwd: "/w/it's here/$(touch NEVER_RUN)" });
  assert.equal(withCwd.at(-1), `cd '/w/it'\\''s here/$(touch NEVER_RUN)' && oats okf harvest`);
  const cwdSeen = execFileSync("/bin/sh", ["-c", withCwd.at(-1).replace(/ && oats okf harvest$/, " 2>/dev/null || printf %s \"$1\"") , "--", "cd-failed-as-expected"], { encoding: "utf8" });
  assert.equal(cwdSeen, "cd-failed-as-expected"); assert.equal(existsSync("NEVER_RUN"), false);
  const withPath = sshArgv({ sshHost: "h", workspace: "/w", oatsPath: "oats", path: "~/.local/bin:/opt/my tools/bin" }, ["version"]);
  assert.equal(withPath.at(-1), `PATH="$HOME"/.local/bin:'/opt/my tools/bin':"$PATH" oats version`);
  const seen = execFileSync("/bin/sh", ["-c", withPath.at(-1).replace(/ oats version$/, "; printf %s \"$PATH\"")], { encoding: "utf8", env: { HOME: "/home/remote", PATH: "/usr/bin:/bin" } });
  assert.equal(seen, "/home/remote/.local/bin:/opt/my tools/bin:/usr/bin:/bin");
});

test("validateServer: a registration is where and how, never credentials or ssh options", () => {
  assert.ok(validateServer("build", { sshHost: "build-host", workspace: "/srv/team" }));
  assert.throws(() => validateServer("Build", { sshHost: "h", workspace: "/w" }), /lowercase/);
  assert.throws(() => validateServer("b", { sshHost: "root@h", workspace: "/w" }), /no user@/);
  assert.throws(() => validateServer("b", { sshHost: "-oProxyCommand=x", workspace: "/w" }), /host alias/);
  assert.throws(() => validateServer("b", { sshHost: "h", workspace: "relative" }), /absolute/);
  assert.throws(() => validateServer("b", { sshHost: "h", workspace: "/w", password: "x" }), /never keys or passwords/);
  assert.throws(() => validateServer("b", { sshHost: "h", workspace: "/w", privateKey: "x" }), /unknown field/);
  assert.equal(compareSemver("0.22.2", "0.22.1") > 0, true);
  assert.equal(compareSemver("0.22.1", "0.22.1"), 0);
  assert.equal(compareSemver("1.0.0", "0.99.9") > 0, true);
  assert.throws(() => snapshotPath("build", "../etc"), /bad instance name/);
});

test("runRemote: a bare retire answer with cleanup still owed is not ok, so a routed retire cannot report success (D2)", () => {
  const bare = JSON.stringify({ retired: "dev-x", agent: "dev", removedDir: false, rollbackIncomplete: ["retire hook acme.chan: reported incomplete cleanup"], retainedHome: "/srv/agents/dev/instances/dev-x" });
  const exec = () => { const e = new Error("exit 1"); e.status = 1; e.stdout = bare; e.stderr = ""; throw e; };
  const { envelope, status } = runRemote({ sshHost: "h", workspace: "/w", oatsPath: "oats" }, ["retire", "dev-x", "--json"], { execFileSync: exec });
  assert.equal(status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "E_RETIRE_INCOMPLETE");
  assert.match(envelope.error.message, /retained there: retire hook acme.chan/);
  assert.equal(envelope.result.retired, "dev-x", "the remote's own result stays visible");
  // Through the route, the failed envelope still names the server and target (R2).
  // With no saved route, the name resolves through the host's roster first.
  const roster = JSON.stringify({ root: "/srv/agents", agents: [{ name: "dev", instances: [{ instance: "dev-x", home: "/srv/agents/dev/instances/dev-x" }] }] });
  const routed = routeCommand("build", "retire", ["dev-x"], { server: { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" }, execFileSync: (bin, argv) => (String(argv.at(-1)).includes("version --json") ? JSON.stringify({ schemaVersion: 1, name: "@awebai/oats", version: "0.22.2", desktopApi: 1 }) : String(argv.at(-1)).includes("status --json") ? roster : exec()) });
  assert.equal(routed.envelope.ok, false);
  assert.equal(routed.envelope.result.server, "build");
  assert.equal(routed.envelope.result.target.sshHost, "h");
  const clean = () => JSON.stringify({ retired: "dev-x", agent: "dev", removedDir: true });
  assert.equal(runRemote({ sshHost: "h", workspace: "/w", oatsPath: "oats" }, ["retire", "dev-x", "--json"], { execFileSync: clean }).envelope.ok, true);
});

test("checkRemoteSupport: a request is held to what the remote kernel advertises, soul defaults included", () => {
  const legacy = { version: "0.22.1", harnesses: ["pi", "claude"], sessionBackends: [], launchOptions: [], features: [], advertised: false };
  const modern = { version: "0.22.2", harnesses: ["pi", "claude", "codex"], sessionBackends: ["tmux"], launchOptions: ["yolo"], features: [], advertised: true };
  const current = { ...modern, version: "0.27.0", features: ["harness"] };
  const target = { sshHost: "h" };
  const roster = { agents: [{ name: "dev", harness: "codex" }, { name: "rev", harness: "claude" }] };
  assert.deepEqual(checkRemoteSupport(legacy, target, ["rev", "--purpose", "x"], roster), { harness: "claude", backend: undefined, yolo: false });
  // --harness or --runtime (its pre-0.27 name) is the choice on a host of any version: the
  // forwarded flag is spelled in the host's names (hostHarnessArgs). A 0.26.x roster says `runtime`.
  assert.deepEqual(checkRemoteSupport(legacy, target, ["rev", "--harness", "claude"], roster), { harness: "claude", backend: undefined, yolo: false });
  assert.deepEqual(checkRemoteSupport(modern, target, ["x"], { agents: [{ name: "x", runtime: "codex" }] }), { harness: "codex", backend: undefined, yolo: false });
  assert.throws(() => checkRemoteSupport(legacy, target, ["rev", "--runtime", "codex"], roster), /harness codex was not established/);
  assert.deepEqual(checkRemoteSupport(legacy, target, ["rev", "--runtime", "pi"], roster), { harness: "pi", backend: undefined, yolo: false });
  assert.deepEqual(checkRemoteSupport(current, target, ["rev", "--harness", "codex"], roster), { harness: "codex", backend: undefined, yolo: false });
  assert.throws(() => checkRemoteSupport(legacy, target, ["rev", "--yolo"], roster), /yolo launch option/);
  assert.throws(() => checkRemoteSupport(legacy, target, ["rev", "--backend", "tmux"], roster), /session backend tmux/);
  assert.deepEqual(checkRemoteSupport(modern, target, ["dev", "--backend", "tmux", "--yolo"], roster), { harness: "codex", backend: "tmux", yolo: true });
  assert.throws(() => checkRemoteSupport(modern, target, ["dev", "--backend", "screen"], roster), /session backend screen/);
});

test("oats server + --server: registry, check, remote spawn with a hostile task, status, retire from the snapshot after the registration is gone", () => {
  const base = mkdtempSync("/tmp/oats-servers-"); // short: the control socket path must fit in 104 bytes
  try {
    const { bin, log, tools } = fakeBin(base);
    const { dep: repo, key: workspaceKey } = remoteDeployment();
    // Only enumerated tools and fake ssh/tmux, not even node's parent bin
    // directory: it may contain globally installed model harnesses.
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = env.OATS_HOME_DIR;
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];

    // registry
    let r = oats(env, ["server", "list", "--json"]);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.json().result.servers, []);
    r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", CLI, "--label", "Build box", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const reg = JSON.parse(readFileSync(join(env.OATS_HOME_DIR, "servers.json"), "utf8"));
    // The workspace key is the host's own answer (its status --json), learned at add.
    assert.deepEqual(reg.servers.build, { sshHost: "build-host", workspace: repo, oatsPath: CLI, label: "Build box", workspaceKey });
    r = oats(env, ["server", "add", "build", "--ssh", "other", "--workspace", repo, "--json"]);
    assert.notEqual(r.status, 0); assert.equal(r.json().error.code, "E_SERVER_EXISTS");
    r = oats(env, ["server", "add", "bad", "--ssh", "root@x", "--workspace", repo, "--json"]);
    assert.equal(r.json().error.code, "E_SERVER_INVALID");

    // check: version probe and status, no mutation
    r = oats(env, ["server", "check", "build", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const chk = r.json().result;
    assert.equal(chk.remote.desktopApi, 1); assert.equal(typeof chk.remote.version, "string");
    // A workspace deployment lists a soul under agents/ once it has been spawned
    // (its per-commit copy); none has been yet.
    assert.equal(chk.workspaceReachable, true); assert.equal(chk.agents, 0);
    const sshLines = readFileSync(log, "utf8");
    const controlPath = join(env.OATS_HOME_DIR, "ssh", "%C");
    assert.ok(sshLines.startsWith(["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=60", "--", "build-host", ""].join("\n")), `non-interactive, kept alive, one control master, options ended with -- before the host:\n${sshLines}`);

    // remote spawn: the task travels as text and lands byte for byte
    const hostile = "Review `this` and $(touch NEVER_RUN) 'quotes' \"dq\"\nsecond line % and * and ~\n";
    const taskFile = join(base, "task.md"); writeFileSync(taskFile, hostile);
    // Without --path the remote preflight cannot find the harness: a typed
    // failure from the remote kernel, relayed as its own envelope.
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "probe", "--task-file", taskFile, "--no-launch", "--json"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.json().error.message, /pi binary not found/);
    assert.equal(existsSync(join(repo, "agents", "dev", "instances", "dev-probe")), false, "missing harness refuses before creating a home");
    r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--replace", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "probe", "--task-file", taskFile, "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const sp = r.json();
    assert.equal(sp.ok, true, JSON.stringify(sp));
    assert.equal(sp.result.server, "build");
    assert.equal(sp.result.target.sshHost, "build-host");
    assert.equal(sp.result.instance, "dev-probe");
    const home = join(repo, "agents", "dev", "instances", "dev-probe");
    assert.equal(existsSync(home), true, "the remote kernel created the home in the registered workspace");
    assert.equal(readFileSync(join(home, "TASK.md"), "utf8").includes(hostile.trim()), true, "task text intact through ssh quoting");
    assert.equal(existsSync(join(process.cwd(), "NEVER_RUN")), false);
    const snap = JSON.parse(readFileSync(join(env.OATS_HOME_DIR, "remote", "build", "dev-probe.json"), "utf8"));
    assert.equal(snap.target.workspace, repo); assert.equal(snap.home, home); assert.equal(snap.remote.schemaVersion, 1);
    assert.equal(snap.agentsRoot, join(repo, "agents"), "the agents root comes from the remote roster, not guessed from the workspace");
    // A request beyond what the remote advertises is refused BEFORE any spawn
    // reaches it. This fake remote is this kernel, which advertises pi, claude
    // and codex on tmux with the yolo option; ask for what it lacks.
    const before = readFileSync(log, "utf8");
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "nope", "--harness", "gemini", "--no-launch", "--json"]);
    assert.equal(r.json().error.code, "E_REMOTE_INCOMPATIBLE");
    assert.match(r.json().error.message, /harness gemini was not established as supported there \(it advertises harnesses pi, claude, codex/, "an advertising remote's list is quoted, nothing more is claimed");
    assert.equal(readFileSync(log, "utf8").includes("spawn dev --purpose nope"), false, "no spawn command was sent");
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "nope", "--backend", "screen", "--no-launch", "--json"]);
    assert.equal(r.json().error.code, "E_REMOTE_INCOMPATIBLE");
    assert.match(r.json().error.message, /session backend screen/);
    // --runtime, the pre-0.27 name, is routed too: the forwarded envelope keeps ONE deprecated-runtime-name
    // warning, this command's note merged with whatever the host said (lead call 6).
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "alias", "--runtime", "pi", "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().warnings?.length, 1, r.stdout);
    assert.equal(r.json().warnings[0].code, "deprecated-runtime-name");
    assert.ok(r.json().warnings[0].sources.includes("the --runtime flag (use --harness)"), JSON.stringify(r.json().warnings));
    assert.equal(r.stderr.includes("oats: warning"), false, "delivered in the envelope");
    r = oats(env, ["retire", "dev-alias", "--server", "build", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // A flag this side reads (a routed preview) is sent in the host's names, and the note joins the envelope.
    r = oats(env, ["launch-config", "preview", "--server", "build", "--instance", "dev-probe", "--runtime", "pi", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json().warnings?.map((w) => [w.code, w.sources]), [["deprecated-runtime-name", ["the --runtime flag (use --harness)"]]], r.stdout);
    assert.match(readFileSync(log, "utf8"), /launch-config preview --harness pi --home /, "the 0.27 host is sent --harness");
    // The viewer route: ssh -t, saved target, remote home from the snapshot; --print shows it.
    const att = attachArgv("build", { instance: "dev-probe" }, { skipVersionCheck: true }); // route resolution only; the version gate is exercised through the CLI above
    assert.deepEqual(att.argv.slice(0, 2), ["ssh", "-t"]);
    assert.equal(att.home, home);
    assert.match(att.argv.at(-1), new RegExp(`session attach --home ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "ghost", "--print"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no instance "ghost" on server build: neither a saved route here nor its roster names one/);
    assert.deepEqual(resolveRoute("build", { instance: "dev-probe" }).target, snap.target, "inspect and attach share the saved route");
    // Session routes need a remote whose probe advertises session; this fake remote is this kernel, which does, so the inspect runs there against the snapshot's home and its envelope is relayed.
    r = oats(env, ["session", "inspect", "--server", "build", "--instance", "dev-probe", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().ok, true);
    assert.equal(r.json().result.home, home);
    assert.equal(r.json().result.server, "build");
    assert.match(readFileSync(log, "utf8"), new RegExp(`session inspect --home ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --json`), "the inspect ran on the host against the snapshot's home");
    r = oats(env, ["session", "inspect", "--server", "build", "--instance", "ghost", "--json"]);
    assert.equal(r.json().error.code, "E_SNAPSHOT_UNKNOWN");
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "dev-probe", "--print"]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^ssh -t -o 'BatchMode=yes' .* -o 'ControlPersist=60' -- build-host /);
    // the snapshot store is read with OATS_HOME_DIR in effect for the in-process calls above
    void before;
    assert.equal(snap.target.path, tools, "the PATH prefix is part of the frozen route");
    assert.match(readFileSync(log, "utf8"), new RegExp(`PATH=${tools.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:"\\$PATH" `), "PATH prefix precedes the remote command, $PATH left for the remote shell");
    // --dir and --server do not mix
    r = oats(env, ["spawn", "dev", "--server", "build", "--dir", repo, "--json"]);
    assert.equal(r.json().error.code, "E_BAD_ARGS");

    // status pulled from the remote kernel, with this machine's snapshots
    r = oats(env, ["status", "--server", "build", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const st = r.json().result;
    assert.deepEqual(st.agents.find((a) => a.name === "dev").instances.map((i) => i.instance), ["dev-probe"], "the roster lists homes only, never the .oats-retirement bookkeeping dir (oats-5xl)");
    assert.deepEqual(st.snapshots.map((s) => s.instance), ["dev-probe"]);
    r = oats(env, ["status", "--server", "build"]);
    assert.match(r.stdout, /server build .*build-host/); assert.match(r.stdout, /dev-probe/);

    // spawn's text answer: the attach line is the routed viewer, never a bare tmux command for the host
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "txt", "--no-launch"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^  attach: oats session attach --server build --instance dev-txt$/m);
    assert.doesNotMatch(r.stdout, /tmux attach/);
    r = oats(env, ["retire", "dev-txt", "--server", "build", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    // the registration disappears; the snapshot still routes the retirement
    r = oats(env, ["server", "remove", "build", "--json"]);
    assert.deepEqual(r.json().result.remoteInstancesStillTracked, ["dev-probe"]);
    r = oats(env, ["retire", "dev-probe", "--server", "build", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().result.retired, "dev-probe");
    assert.equal(existsSync(home), false, "the remote kernel removed the home");
    assert.equal(existsSync(join(env.OATS_HOME_DIR, "remote", "build", "dev-probe.json")), false, "snapshot cleared on a completed retirement");

    // an unknown server is a typed failure, and ssh's own failure is E_SSH
    r = oats(env, ["status", "--server", "nope", "--json"]);
    assert.equal(r.json().error.code, "E_SERVER_UNKNOWN");
    r = oats(env, ["server", "add", "down", "--ssh", "down-host", "--workspace", "/nonexistent", "--oats", "/no/such/oats", "--json"]);
    assert.equal(r.status, 0);
    r = oats(env, ["server", "check", "down", "--json"]);
    assert.notEqual(r.status, 0);
    assert.match(r.json().error.code, /^E_(SSH|REMOTE_ENVELOPE)$/);
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("oats server roster, okf harvest --server, and the changed-registration guard", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-servers-roster-"));
  try {
    const { bin, log, tools } = fakeBin(base);
    const repo = remoteWorkspace();
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];

    let r = oats(env, ["server", "roster", "--json"]);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(r.json().result.groups, []);
    r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--label", "Build box", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "r1", "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const home = r.json().result.home;

    // The roster: one group per (server, route target), one status pull each,
    // souls from the remote, instances joined with the saved routes.
    r = oats(env, ["server", "roster", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    let out = r.json().result;
    assert.equal(out.groups.length, 1);
    const g = out.groups[0];
    assert.equal(g.server, "build"); assert.equal(g.label, "Build box"); assert.equal(g.registrationPresent, true);
    assert.deepEqual(g.probe, { ok: true, features: KERNEL_FEATURES, sessionViewer: { prefixScroll: true } }, "the host's features, relayed from its status answer");
    assert.equal(typeof g.agentsRoot, "string");
    assert.deepEqual(g.souls.map((s) => s.name), ["dev"]);
    assert.equal(g.souls[0].agentsRoot, g.agentsRoot);
    assert.equal(g.instances.length, 1);
    assert.equal(g.instances[0].instance, "dev-r1"); assert.equal(g.instances[0].agent, "dev");
    assert.equal(g.instances[0].savedRoute, true); assert.equal(g.instances[0].running, false);
    assert.equal(g.instances[0].home, home);
    assert.deepEqual([g.instances[0].retirePending, g.instances[0].rollbackIncomplete, g.instances[0].missingRemotely], [false, false, false]);
    assert.deepEqual(g.retireFailures, []);
    assert.equal(typeof out.bounds.perTargetTimeoutMs, "number");
    assert.match(readFileSync(log, "utf8"), /status --json --dir/, "the roster pulled remote status");
    r = oats(env, ["server", "roster"]);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /dev-r1\s+idle/);

    // An unreachable target: the group stays, probe carries the error, no
    // instance is invented. (The fake ssh runs the command locally, so a
    // workspace that does not exist stands in for a host that fails.)
    r = oats(env, ["server", "add", "down", "--ssh", "down-host", "--workspace", join(base, "no-such-ws"), "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "roster", "--json"]);
    out = r.json().result;
    const down = out.groups.find((x) => x.server === "down");
    assert.equal(down.probe.ok, false); assert.equal(typeof down.probe.error.message, "string");
    assert.equal("features" in down.probe || "sessionViewer" in down.probe, false, "a remote ok:false carries no features and no sessionViewer key");
    assert.deepEqual(down.instances, []); assert.deepEqual(down.souls, []); assert.deepEqual(down.retireFailures, []);
    r = oats(env, ["server", "roster", "--server", "nope", "--json"]);
    assert.equal(r.json().error.code, "E_SERVER_UNKNOWN");
    assert.equal(out.groups.find((x) => x.server === "build").probe.ok, true);
    r = oats(env, ["server", "roster", "--server", "down", "--json"]);
    assert.deepEqual(r.json().result.groups.map((x) => x.server), ["down"]);

    // Harvest routes to the instance's SAVED home on the host: `cd <home> &&`
    // in the remote command word, never a path from the caller. This remote
    // workspace has no knowledge layer, so the package's own refusal is relayed.
    r = oats(env, ["okf", "harvest", "--server", "build", "--instance", "nope", "--json"]);
    assert.notEqual(r.status, 0); assert.equal(r.json().error.code, "E_SNAPSHOT_UNKNOWN");
    r = oats(env, ["okf", "harvest", "--server", "build", "--instance", "dev-r1", "--json"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(r.json().ok, false);
    const sshLog = readFileSync(log, "utf8");
    assert.ok(sshLog.includes(`cd ${remoteQuote(home)} && `), "harvest ran in the saved home");
    assert.match(sshLog, /okf harvest --json/);
    // Any other okf command with --server is refused, never run locally.
    r = oats(env, ["okf", "status", "--server", "build", "--json"]);
    assert.equal(r.json().error.code, "E_USAGE");
    // The route outlives the registration, like retire: remove it, harvest
    // still reaches the saved home; a saved route the remote no longer lists
    // is flagged, not invented as idle.
    const savedReg = readFileSync(join(env.OATS_HOME_DIR, "servers.json"), "utf8");
    r = oats(env, ["server", "remove", "build", "--json"]); assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["okf", "harvest", "--server", "build", "--instance", "dev-r1", "--json"]);
    assert.notEqual(r.json().error?.code, "E_SERVER_UNKNOWN", r.stdout);
    r = oats(env, ["server", "roster", "--server", "build", "--json"]);
    assert.equal(r.json().result.groups[0].registrationPresent, false);
    assert.equal(r.json().result.groups[0].instances[0].missingRemotely, false);
    writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), savedReg);
    // A --replace that only moves the binary is the same target: no refusal.
    const movedOats = join(base, "oats-moved"); symlinkSync(CLI, movedOats);
    r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", movedOats, "--path", tools, "--replace", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "moved", "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = oats(env, ["retire", "dev-moved", "--server", "build", "--json"]); assert.equal(r.status, 0, r.stderr + r.stdout);

    // The guard: a registration edited to another target must not overwrite
    // the saved routes spawned through the old one.
    const repo2 = join(base, "remote-ws-2"); mkdirSync(repo2);
    r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo2, "--oats", CLI, "--path", tools, "--replace", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "r2", "--no-launch", "--json"]);
    assert.notEqual(r.status, 0);
    assert.equal(r.json().error.code, "E_ROUTE_CHANGED");
    assert.match(r.json().error.message, /dev-r1/);
    assert.equal(existsSync(snapshotPath("build", "dev-r2")), false);
    // The roster keeps both: the new target (registration, nothing spawned)
    // and the old one (saved routes only) with its instance.
    r = oats(env, ["server", "roster", "--server", "build", "--json"]);
    out = r.json().result;
    assert.equal(out.groups.length, 2);
    const fresh = out.groups.find((x) => x.registrationPresent), old = out.groups.find((x) => !x.registrationPresent);
    assert.equal(fresh.target.workspace, repo2); assert.deepEqual(fresh.instances, []);
    assert.equal(old.target.workspace, repo); assert.deepEqual(old.instances.map((i) => i.instance), ["dev-r1"]);
    // A saved route whose instance is gone on the host: the roster flags it,
    // the guard still counts it, and only `server forget` drops it.
    rmSync(home, { recursive: true, force: true });
    r = oats(env, ["server", "roster", "--server", "build", "--json"]);
    assert.equal(r.json().result.groups.find((x) => !x.registrationPresent).instances[0].missingRemotely, true);
    r = oats(env, ["server", "roster", "--server", "build"]);
    assert.match(r.stdout, /dev-r1\s+GONE on the host/, "the human roster names a stale route");
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "r3", "--no-launch", "--json"]);
    assert.equal(r.json().error?.code, "E_ROUTE_CHANGED");
    r = oats(env, ["server", "forget", "build", "--instance", "nope", "--json"]);
    assert.equal(r.json().error?.code, "E_SNAPSHOT_UNKNOWN");
    r = oats(env, ["server", "forget", "build", "--instance", "dev-r1", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(r.json().result.forgotten, true); assert.equal(r.json().result.home, home);
    assert.equal(existsSync(snapshotPath("build", "dev-r1")), false);
    r = oats(env, ["server", "roster", "--server", "build", "--json"]);
    assert.deepEqual(r.json().result.groups.map((x) => x.instances.length), [0]);
    // With no saved route left, the registration may point anywhere again.
    r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--replace", "--json"]); assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "r3", "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = oats(env, ["retire", "dev-r3", "--server", "build", "--json"]); assert.equal(r.status, 0, r.stderr + r.stdout);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("routed retire with same-named twins: exact home on a 0.22.3 remote, refusal on an older one", async () => {
  const base = mkdtempSync(join(tmpdir(), "oats-servers-twins-"));
  try {
    const { bin, tools } = fakeBin(base);
    // A second soul whose name can collide with dev's: dev --purpose foo-1 and
    // dev-foo --purpose 1 both derived dev-foo-1 before 0.26.0. A 0.26 spawn
    // de-duplicates names deployment-wide (it would derive dev-foo-1-2), but
    // homes an earlier kernel created keep sharing the name — the twins below.
    const fx = remoteDeployment({ "dev-foo": { soul: { work: "checkout" }, agents: "You are dev-foo.\n" } });
    const repo = fx.dep;
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = env.OATS_HOME_DIR;
    try {
    // An "old" remote: the real kernel, but its version probe carries no features.
    const oldOats = join(base, "old-oats");
    write(oldOats, `#!/bin/sh\nif [ "$1" = version ] && [ "$2" = --json ]; then ${remoteQuote(process.execPath)} ${remoteQuote(CLI)} version --json | sed 's/,"features":\\[[^]]*\\]//'; exit $?; fi\nexec ${remoteQuote(process.execPath)} ${remoteQuote(CLI)} "$@"\n`);
    chmodSync(oldOats, 0o755);
    let r = oats(env, ["server", "add", "new", "--ssh", "h", "--workspace", repo, "--oats", CLI, "--path", tools, "--json"]); assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "add", "old", "--ssh", "h", "--workspace", repo, "--oats", oldOats, "--path", tools, "--json"]); assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "check", "old", "--json"]); assert.deepEqual(r.json().result.remote.features, [], "the old remote advertises no features");
    // The saved route: dev-foo-1 of agent dev, through "new" and through "old".
    r = oats(env, ["spawn", "dev", "--server", "new", "--purpose", "foo-1", "--no-launch", "--json"]); assert.equal(r.status, 0, r.stderr + r.stdout);
    const devHome = r.json().result.home;
    // The same route saved through the old registration: the snapshot's own
    // target (the old binary) is what the route runs with.
    mkdirSync(dirname(snapshotPath("old", "dev-foo-1")), { recursive: true });
    const snapNew = JSON.parse(readFileSync(snapshotPath("new", "dev-foo-1"), "utf8"));
    writeFileSync(snapshotPath("old", "dev-foo-1"), JSON.stringify({ ...snapNew, serverId: "old", target: { ...snapNew.target, oatsPath: oldOats } }));
    // The twin: dev-foo's home of the same name, as an earlier kernel left it on
    // the remote (created here by a direct kernel call naming the instance; a
    // 0.26 spawn never derives it). It has no saved route here. That a routed
    // spawn reporting a colliding name never overwrites a saved route
    // (routeConflict) is lib/servers.mjs's own, covered by the routeCommand test.
    const makeTwin = async () => {
      const prevPath = process.env.PATH; process.env.PATH = `${tools}:${bin}`;
      try {
        const { prepared, agent } = await fx.prepare("dev-foo");
        return (await spawnInstanceAsync(fx.root, agent, { prepared, instance: "dev-foo-1", repo: fx.member, launch: false })).home;
      } finally { process.env.PATH = prevPath; }
    };
    const twinHome = await makeTwin();
    assert.notEqual(devHome, twinHome);
    const routesBefore = listSnapshots("new");
    r = oats(env, ["spawn", "dev-foo", "--server", "new", "--purpose", "1", "--no-launch", "--preview", "--json"]); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().result.instance, "dev-foo-1-2", "a 0.26 spawn skips the name the twins share");
    // A routed preview saves no route (#610): none for the previewed name, the saved ones as they were.
    assert.equal(existsSync(snapshotPath("new", "dev-foo-1-2")), false, "no route for the previewed instance");
    assert.deepEqual(listSnapshots("new"), routesBefore);
    assert.equal(JSON.parse(readFileSync(snapshotPath("new", "dev-foo-1"), "utf8")).home, devHome, "the saved route is untouched");
    // The roster gives the saved route to the row with the saved HOME only;
    // the twin under dev-foo is observed, never actionable from here.
    r = oats(env, ["server", "roster", "--server", "new", "--json"]);
    const rows = r.json().result.groups[0].instances.filter((i) => i.instance === "dev-foo-1");
    assert.deepEqual(rows.map((i) => [i.agent, i.savedRoute]).sort(), [["dev", true], ["dev-foo", false]]);
    // An explicit name that already has a saved route here is refused before
    // the remote spawn; a generated collision never overwrites the route.
    r = oats(env, ["spawn", "dev-foo", "--server", "new", "--instance", "dev-foo-1", "--no-launch", "--json"]);
    assert.equal(r.json().error?.code, "E_ROUTE_EXISTS");
    assert.equal(JSON.parse(readFileSync(snapshotPath("new", "dev-foo-1"), "utf8")).home, devHome, "the saved route is untouched");
    // Old remote, twins there: refused before any mutation, with the upgrade named.
    r = oats(env, ["retire", "dev-foo-1", "--server", "old", "--json"]);
    assert.equal(r.json().error?.code, "E_REMOTE_INCOMPATIBLE", r.stdout + r.stderr); assert.match(r.json().error.message, /0\.22\.3/);
    assert.equal(existsSync(devHome), true); assert.equal(existsSync(twinHome), true);
    // Old remote, explicit --home: never sent where it cannot be honoured.
    r = oats(env, ["retire", "dev-foo-1", "--server", "old", "--home", devHome, "--json"]);
    assert.equal(r.json().error?.code, "E_REMOTE_INCOMPATIBLE");
    // A viewer addresses the HOME: the twin (no saved route) is reachable by
    // its home, the saved instance by name, and a name with the wrong home
    // is refused; the ssh command word carries the home either way.
    for (const [addr, wantHome] of [[["--instance", "dev-foo-1"], devHome], [["--home", twinHome], twinHome]]) {
      const mark = readFileSync(join(base, "ssh.log"), "utf8").length;
      r = oats(env, ["session", "inspect", "--server", "new", ...addr, "--json"]);
      assert.ok(readFileSync(join(base, "ssh.log"), "utf8").slice(mark).includes(`session inspect --home ${remoteQuote(wantHome)}`), `viewer route for ${addr.join(" ")}: ${r.stdout}`);
    }
    r = oats(env, ["session", "inspect", "--server", "new", "--instance", "dev-foo-1", "--home", twinHome, "--json"]);
    assert.equal(r.json().error?.code, "E_HOME_MISMATCH");
    // Old remote, one instance of that name only, but not at the saved home
    // (the route drifted): refused as a stale route, nothing retired.
    const driftSnap = JSON.parse(readFileSync(snapshotPath("old", "dev-foo-1"), "utf8"));
    writeFileSync(snapshotPath("old", "dev-foo-1"), JSON.stringify({ ...driftSnap, home: join(repo, "agents", "dev", "instances", "dev-foo-9") }));
    rmSync(twinHome, { recursive: true, force: true });
    r = oats(env, ["retire", "dev-foo-1", "--server", "old", "--json"]);
    assert.equal(r.json().error?.code, "E_HOME_MISMATCH", r.stdout); assert.match(r.json().error.message, /stale/);
    assert.equal(existsSync(devHome), true);
    writeFileSync(snapshotPath("old", "dev-foo-1"), JSON.stringify(driftSnap));
    assert.equal(await makeTwin(), twinHome, "the earlier-kernel twin is back");
    // New remote, an explicit home that is not the saved route: refused.
    r = oats(env, ["retire", "dev-foo-1", "--server", "new", "--home", twinHome, "--json"]);
    assert.equal(r.json().error?.code, "E_HOME_MISMATCH"); assert.equal(existsSync(twinHome), true);
    // New remote: the saved home travels as --home; the twin survives.
    const logBefore = readFileSync(join(base, "ssh.log"), "utf8").length;
    r = oats(env, ["retire", "dev-foo-1", "--server", "new", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(readFileSync(join(base, "ssh.log"), "utf8").slice(logBefore).includes(`retire dev-foo-1 --home ${remoteQuote(devHome)}`), "the saved home was sent as --home");
    assert.equal(existsSync(devHome), false, "the saved-route instance is retired");
    assert.equal(existsSync(twinHome), true, "the twin under the other agent is untouched");
    assert.equal(existsSync(snapshotPath("new", "dev-foo-1")), false);
    } finally { if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir; }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("routed spawn: a success reply without a home never replaces an existing saved route", () => {
  const base = mkdtempSync("/tmp/oats-nohome-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const target = { sshHost: "h", workspace: "/w", oatsPath: "oats" };
    mkdirSync(dirname(snapshotPath("build", "dev-x")), { recursive: true });
    const prior = { serverId: "build", target, remote: { version: "0.22.3", schemaVersion: 1 }, instance: "dev-x", agent: "dev", home: "/w/agents/dev/instances/dev-x", agentsRoot: "/w/agents", spawnedAt: "2026-09-05T00:00:00.000Z" };
    writeFileSync(snapshotPath("build", "dev-x"), JSON.stringify(prior));
    const probe = { schemaVersion: 1, name: "@awebai/oats", version: "0.22.3", desktopApi: 1, runtimes: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "retire", "status", "session", "roster", "harvest"], features: ["retire-home"] };
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", runtime: "pi", instances: [] }] } };
    let calls = 0;
    const exec = (bin, argv) => {
      calls++;
      const word = String(argv.at(-1));
      if (word.includes("version --json")) return JSON.stringify(probe);
      if (word.includes(" status ")) return JSON.stringify(status);
      if (word.includes(" spawn ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "dev-x", agent: "dev", launched: false, warnings: [] } });
      throw new Error(`unexpected remote call: ${word}`);
    };
    const routed = routeCommand("build", "spawn", ["dev", "--purpose", "x", "--no-launch"], { server, execFileSync: exec });
    assert.equal(calls, 3);
    assert.equal(routed.envelope.ok, true);
    assert.equal(routed.envelope.result.snapshot, null, "no route written for a home-less result");
    assert.deepEqual(routed.envelope.result.routeConflict, { instance: "dev-x", existingHome: prior.home });
    assert.deepEqual(JSON.parse(readFileSync(snapshotPath("build", "dev-x"), "utf8")), prior, "the existing route survives byte for byte");
    // The same home in the reply is the same route: replaced, no conflict.
    const same = (bin, argv) => (String(argv.at(-1)).includes(" spawn ") ? JSON.stringify({ schemaVersion: 1, ok: true, result: { instance: "dev-x", agent: "dev", home: prior.home, launched: false, warnings: [] } }) : exec(bin, argv));
    const again = routeCommand("build", "spawn", ["dev", "--purpose", "x", "--no-launch"], { server, execFileSync: same });
    assert.equal(again.envelope.result.routeConflict, undefined); assert.equal(typeof again.envelope.result.snapshot, "string");
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn: bound to the host's preview and a key of the request; a link that drops under the apply answers E_SSH with the decision and the key, and the same spawn with them answers the one instance", () => {
  const base = mkdtempSync("/tmp/oats-rsi-"); // short: the control socket path must fit in 104 bytes
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const { bin, tools } = fakeBin(base);
    const { dep: repo } = remoteDeployment();
    const env = { ...process.env, PATH: bin, HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    const server = { id: "build", sshHost: "h", workspace: repo, oatsPath: CLI, path: tools };
    // The transport: the fake ssh runs each call on the REAL kernel. The first spawn that is not a
    // preview runs there to its end, and its answer is lost as ssh loses it when the link drops
    // (exit 255, nothing on stdout).
    let drops = 0;
    const spawns = [];
    const exec = (file, argv, options) => {
      const word = String(argv.at(-1));
      const spawning = word.includes(" spawn ");
      if (spawning) spawns.push(word);
      const out = execFileSync(join(bin, "ssh"), argv, { ...options, env });
      if (spawning && !word.includes("--preview") && drops++ === 0) throw Object.assign(new Error("ssh exited 255"), { status: 255, stdout: "", stderr: "client_loop: send disconnect: Broken pipe\n" });
      return out;
    };
    const homes = () => readdirSync(join(repo, "agents", "dev", "instances")).filter((n) => !n.startsWith("."));
    const args = ["dev", "--no-launch"];
    let lost;
    try { routeCommand("build", "spawn", args, { server, execFileSync: exec }); } catch (e) { lost = e; }
    assert.equal(lost?.code, "E_SSH", String(lost?.stack));
    assert.equal(spawns.length, 2, spawns.join("\n"));
    assert.match(spawns[0], / spawn dev --no-launch --preview --dir \S+ --json$/, "the host's preview first");
    const { decision, idempotencyKey, fix } = lost.details;
    assert.match(decision.revision, /^[0-9a-f]{24}$/);
    assert.match(idempotencyKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    assert.ok(spawns[1].includes(` spawn dev --no-launch --expect-decision ${decision.revision} --idempotency-key ${idempotencyKey} --dir `), `the apply is bound to the previewed decision and the key: ${spawns[1]}`);
    assert.ok(fix.includes(`--expect-decision ${decision.revision} --idempotency-key ${idempotencyKey}`), fix);
    assert.ok(lost.message.includes(fix), "text mode prints the message alone: it carries the fix");
    assert.deepEqual(homes(), [decision.instance], "the host created the instance before the link dropped");
    assert.equal(existsSync(snapshotPath("build", decision.instance)), false, "no route was saved for the lost answer");

    // The same spawn with the decision and the key: forwarded as given, no preview; the host replays.
    const routed = routeCommand("build", "spawn", [...args, "--expect-decision", decision.revision, "--idempotency-key", idempotencyKey], { server, execFileSync: exec });
    assert.equal(spawns.length, 3, spawns.join("\n")); assert.equal(spawns[2], spawns[1]);
    assert.equal(routed.envelope.ok, true, JSON.stringify(routed.envelope));
    assert.deepEqual(homes(), [decision.instance], "exactly one instance on the host");
    assert.equal(routed.envelope.result.instance, decision.instance, "the answer names the instance the first attempt created");
    assert.equal(routed.envelope.result.home, join(repo, "agents", "dev", "instances", decision.instance));
    assert.equal(routed.envelope.result.replayed, true);
    assert.equal(JSON.parse(readFileSync(snapshotPath("build", decision.instance), "utf8")).home, routed.envelope.result.home, "its route is saved");

    // A link that holds: the host's keyed answer, relayed as it gave it, and one more instance.
    const held = routeCommand("build", "spawn", ["dev", "--purpose", "held", "--no-launch"], { server, execFileSync: exec }).envelope;
    assert.equal(held.ok, true, JSON.stringify(held));
    assert.equal(held.result.instance, "dev-held"); assert.equal(held.result.replayed, false);
    assert.match(held.result.decision.revision, /^[0-9a-f]{24}$/);
    assert.deepEqual(held.result.wake, { requested: false, saved: null, error: null });
    assert.deepEqual(held.result.warnings, []);
    assert.deepEqual(homes().sort(), [decision.instance, "dev-held"].sort());
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn: a host that does not advertise the keyed spawn gets one spawn as given, and its answer warns that a dropped link cannot be retried safely; --suggest-name previews with it and applies the previewed name", () => {
  const base = mkdtempSync("/tmp/oats-rsk-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.24.9", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "pi", instances: [] }] } };
    const spawned = (instance, more = {}) => ({ schemaVersion: 1, ok: true, result: { instance, agent: "dev", home: `/w/agents/dev/instances/${instance}`, launched: false, warnings: ["the host's own warning"], ...more } });
    const remote = (features, answers) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) { sent.push(word); return JSON.stringify(answers[word.includes("--preview") ? "preview" : "apply"]); }
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { sent, exec };
    };
    const KEYED = ["spawn-preview-2", "spawn-apply-2", "spawn-idempotency-2"];

    // Each of the three features is needed: without one, the spawn travels once, as given.
    for (const missing of KEYED) {
      const host = remote(KEYED.filter((f) => f !== missing), { apply: spawned(`dev-${missing}`) });
      const { envelope } = routeCommand("build", "spawn", ["dev", "--no-launch"], { server, execFileSync: host.exec });
      assert.deepEqual(host.sent, ["oats spawn dev --no-launch --dir /w --json"], missing);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.result.warnings.length, 2, JSON.stringify(envelope.result.warnings));
      assert.equal(envelope.result.warnings[0], "the host's own warning");
      assert.match(envelope.result.warnings[1], new RegExp(`oats 0\\.24\\.9 at h does not advertise ${missing}: .*link.*cannot be retried safely`), envelope.result.warnings[1]);
      assert.equal(typeof envelope.result.snapshot, "string", "its route is saved as before");
    }

    // --suggest-name: the preview carries it; the apply carries the name the preview chose, and the answer how it was chosen.
    const naming = { source: "suggested", harness: "pi", model: null, ms: 12 };
    const preview = { schemaVersion: 1, ok: true, result: { spawnPreviewApi: 2, preview: true, agent: "dev", instance: "dev-tidy", home: "/w/agents/dev/instances/dev-tidy", naming, decision: { instance: "dev-tidy", revision: "0123456789abcdef01234567" } } };
    const host = remote([...KEYED, "spawn-suggest-name", "spawn-apply-suggest-name", "spawn-name"], { preview, apply: spawned("dev-tidy", { decision: preview.result.decision, replayed: false }) });
    const { envelope } = routeCommand("build", "spawn", ["dev", "--suggest-name", "--task", "tidy up", "--no-launch"], { server, execFileSync: host.exec });
    assert.equal(host.sent.length, 2, host.sent.join("\n"));
    assert.equal(host.sent[0], "oats spawn dev --suggest-name --task 'tidy up' --no-launch --preview --dir /w --json");
    assert.match(host.sent[1], /^oats spawn dev --task 'tidy up' --no-launch --name dev-tidy --expect-decision 0123456789abcdef01234567 --idempotency-key \S+ --dir \/w --json$/);
    assert.equal(envelope.result.instance, "dev-tidy"); assert.deepEqual(envelope.result.naming, naming);
    assert.deepEqual(envelope.result.warnings, ["the host's own warning"]);

    // A link that drops under that apply: the fix names the previewed name too.
    const dropping = remote([...KEYED, "spawn-suggest-name", "spawn-apply-suggest-name", "spawn-name"], { preview });
    const drop = (bin, argv) => { const word = String(argv.at(-1)); if (word.includes(" spawn ") && !word.includes("--preview")) throw Object.assign(new Error("ssh exited 255"), { status: 255, stdout: "", stderr: "Connection to h closed by remote host.\n" }); return dropping.exec(bin, argv); };
    assert.throws(() => routeCommand("build", "spawn", ["dev", "--suggest-name", "--no-launch"], { server, execFileSync: drop }), (e) => {
      assert.equal(e.code, "E_SSH"); assert.deepEqual(e.details.decision, preview.result.decision);
      assert.match(e.details.fix, /--name dev-tidy in place of --suggest-name/); assert.ok(e.details.fix.includes(`--expect-decision 0123456789abcdef01234567 --idempotency-key ${e.details.idempotencyKey}`));
      return true;
    });

    // The host's refusal of the preview is the spawn's answer: relayed, and nothing is applied.
    const refusal = { schemaVersion: 1, ok: false, error: { code: "E_SOUL_UNKNOWN", message: "soul \"dev\" is not in /w/agents" } };
    const refusing = remote(KEYED, { preview: refusal });
    assert.deepEqual(routeCommand("build", "spawn", ["dev", "--no-launch"], { server, execFileSync: refusing.exec }).envelope, refusal);
    assert.equal(refusing.sent.length, 1);

    // A caller's own decision or key travels as given: no preview, no second key.
    const own = remote(KEYED, { apply: spawned("dev-own") });
    routeCommand("build", "spawn", ["dev", "--no-launch", "--expect-decision", "r1", "--idempotency-key", "k1"], { server, execFileSync: own.exec });
    assert.deepEqual(own.sent, ["oats spawn dev --no-launch --expect-decision r1 --idempotency-key k1 --dir /w --json"]);
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

/** Every file and directory under `dir`, by relative path, with its bytes: two
 *  captures are equal only when nothing was added, removed or rewritten. */
function treeBytes(dir, { skip = [] } = {}) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(r)) continue;
      if (e.isDirectory()) { out[`${r}/`] = "dir"; walk(join(d, e.name), r); }
      else out[r] = readFileSync(join(d, e.name)).toString("base64");
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

test("routed spawn --preview (#610): the host's preview, printed as the local one naming the server; nothing written here, nothing created there; an old host is refused before the spawn is sent", () => {
  const base = mkdtempSync("/tmp/oats-pv-"); // short: the control socket path must fit in 104 bytes
  const prevHomeDir = process.env.OATS_HOME_DIR;
  try {
    const { bin, log, tools } = fakeBin(base);
    const repo = remoteWorkspace();
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    process.env.OATS_HOME_DIR = env.OATS_HOME_DIR;
    // An "old" host: the real kernel, but its version probe carries no features.
    const oldOats = join(base, "old-oats");
    write(oldOats, `#!/bin/sh\nif [ "$1" = version ] && [ "$2" = --json ]; then ${remoteQuote(process.execPath)} ${remoteQuote(CLI)} version --json | sed 's/,"features":\\[[^]]*\\]//'; exit $?; fi\nexec ${remoteQuote(process.execPath)} ${remoteQuote(CLI)} "$@"\n`);
    chmodSync(oldOats, 0o755);
    let r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--json"]); assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "add", "old", "--ssh", "old-host", "--workspace", repo, "--oats", oldOats, "--path", tools, "--json"]); assert.equal(r.status, 0, r.stderr);
    // Saved routes the previews must leave as they are: a live instance, and a
    // stale route for the name a preview of --purpose stale derives (its home is gone).
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "keep", "--no-launch", "--json"]); assert.equal(r.status, 0, r.stderr + r.stdout);
    const keep = JSON.parse(readFileSync(snapshotPath("build", "dev-keep"), "utf8"));
    const goneHome = join(repo, "agents", "dev", "instances", "dev-stale-gone");
    writeFileSync(snapshotPath("build", "dev-stale"), JSON.stringify({ ...keep, instance: "dev-stale", home: goneHome }, null, 2) + "\n");
    // Everything under the oats home but ssh/, the control-master directory every routed
    // command shares (a transport cache, made by the first ssh to any server, not route state).
    const capture = () => ({ home: treeBytes(env.OATS_HOME_DIR, { skip: ["ssh"] }), routes: treeBytes(REMOTE_SNAPSHOT_DIR()), servers: readFileSync(SERVERS_FILE()).toString("base64") });
    const before = capture();
    assert.deepEqual(Object.keys(before.routes).sort(), ["build/", "build/dev-keep.json", "build/dev-stale.json"]);
    const unchanged = (label) => assert.deepEqual(capture(), before, `${label}: saved routes, registry and every file here byte-identical`);
    const instances = () => readdirSync(join(repo, "agents", "dev", "instances")).sort();
    const made = instances();

    // Text: the local preview's line naming the server, and none of the apply's lines.
    // A --task-file travels as --task text, --harness in the host's names.
    const taskFile = join(base, "task.md"); writeFileSync(taskFile, "preview me\n");
    let mark = readFileSync(log, "utf8").length;
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "pv", "--harness", "pi", "--task-file", taskFile, "--no-launch", "--preview"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines[0], /^preview dev → dev-pv on build \(checkout\) harness pi .*; nothing was created/, r.stdout);
    for (const apply of [/Spawned/, /remote home:/, /route snapshot:/, /attach:/]) assert.doesNotMatch(r.stdout, apply);
    const sent = readFileSync(log, "utf8").slice(mark);
    assert.ok(sent.includes(` spawn dev --purpose pv --harness pi --task ${remoteQuote("preview me\n")} --no-launch --preview --dir `), sent);
    unchanged("text preview");
    assert.deepEqual(instances(), made, "nothing was created on the host");
    // The same line as a local preview of that deployment prints, with " on build" added.
    const local = oats({ ...env, PATH: `${tools}:${bin}` }, ["spawn", "dev", "--purpose", "pv", "--harness", "pi", "--task-file", taskFile, "--no-launch", "--preview", "--dir", repo]);
    assert.equal(local.status, 0, local.stderr + local.stdout);
    // (The local run's deployment note, "(workspace soul: …)", is not the preview's.)
    const localPreview = local.stdout.split("\n").filter((l) => !l.startsWith("(workspace soul: ")).join("\n");
    assert.equal(r.stdout, localPreview.replace("preview dev → dev-pv (", "preview dev → dev-pv on build ("), "the routed text is the local preview's, naming the server");

    // JSON: the host's preview with server and target, and no snapshot key.
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "pv", "--no-launch", "--preview", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const pv = r.json().result;
    assert.equal(pv.preview, true); assert.equal(pv.spawnPreviewApi, 2);
    assert.equal(pv.instance, "dev-pv"); assert.equal(pv.home, join(repo, "agents", "dev", "instances", "dev-pv"));
    assert.equal(pv.server, "build");
    assert.deepEqual(pv.target, keep.target);
    assert.equal("snapshot" in pv, false, "a preview never says what was saved");
    assert.equal("routeConflict" in pv, false);
    unchanged("JSON preview");

    // A saved route already holding the name: the preview says a spawn would save none.
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "stale", "--no-launch", "--preview", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const stale = r.json().result;
    assert.equal(stale.instance, "dev-stale");
    assert.equal(stale.warnings.filter((w) => w.startsWith("a spawn would save no route: ")).length, 1, JSON.stringify(stale.warnings));
    assert.ok(stale.warnings.includes(`a spawn would save no route: dev-stale already names ${goneHome} through build; that instance (${stale.home}) would not be managed from here, and would be retired on the host with oats retire dev-stale --home ${stale.home}`), JSON.stringify(stale.warnings));
    assert.equal("snapshot" in stale, false);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "stale", "--no-launch", "--preview"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^ {2}WARNING: a spawn would save no route: dev-stale already names /m);
    unchanged("collision preview");

    // The apply's own refusals, on the preview path: nothing sent, nothing written.
    for (const [args, code] of [[["--server", "build", "--instance", "dev-keep"], "E_ROUTE_EXISTS"], [["--server", "old", "--purpose", "pv"], "E_REMOTE_INCOMPATIBLE"]]) {
      mark = readFileSync(log, "utf8").length;
      r = oats(env, ["spawn", "dev", ...args, "--no-launch", "--preview", "--json"]);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.json().error.code, code, r.stdout);
      assert.doesNotMatch(readFileSync(log, "utf8").slice(mark), / spawn /, `${code}: no spawn was sent`);
      unchanged(code);
    }
    // The old host (no features): its version, the missing feature, nothing sent.
    const version = JSON.parse(execFileSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" })).version;
    assert.equal(r.json().error.message, `remote oats ${version} at old-host does not advertise spawn-preview-2; upgrade it there; nothing was sent`);
    assert.deepEqual(instances(), made, "nothing was created on the host");
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routeCommand spawn --preview (#610): the host's result with server and target only; the apply's checks first, spawn-preview-2 required; a refusal relayed; an answer that spawned is recorded as the apply records it", () => {
  const base = mkdtempSync("/tmp/oats-pvu-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const target = { sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.55.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "pi", instances: [] }] } };
    const hostPreview = { spawnPreviewApi: 2, preview: true, warnings: ["the host's own warning"], agent: "dev", kind: "persistent", instance: "dev-x", home: "/w/agents/dev/instances/dev-x", work: "checkout", harness: "pi", modelSource: "harness default", decision: { revision: "r1" } };
    const remote = (features, spawnAnswer) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        sent.push(word);
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) return JSON.stringify(spawnAnswer);
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { sent, exec, spawned: () => sent.filter((w) => w.includes(" spawn ")) };
    };
    const args = ["dev", "--purpose", "x", "--no-launch", "--preview"];
    const ok = { schemaVersion: 1, ok: true, result: hostPreview };

    // The host's fields unchanged, plus server and target; no snapshot key, no file.
    let host = remote(["spawn-preview-2"], ok);
    let routed = routeCommand("build", "spawn", args, { server, execFileSync: host.exec });
    assert.deepEqual(routed.envelope, { ...ok, result: { ...hostPreview, server: "build", target } });
    assert.equal(host.spawned().length, 1); assert.match(host.spawned()[0], / --preview --dir \/w --json$/);
    assert.equal(existsSync(REMOTE_SNAPSHOT_DIR()), false, "nothing written here");

    // A saved route for that name at another home: one more warning, the route byte-identical.
    mkdirSync(dirname(snapshotPath("build", "dev-x")), { recursive: true });
    const prior = JSON.stringify({ serverId: "build", target, remote: { version: "0.55.0", schemaVersion: 1 }, instance: "dev-x", agent: "dev", home: "/w/agents/other/instances/dev-x", agentsRoot: "/w/agents", spawnedAt: "2026-10-01T00:00:00.000Z" });
    writeFileSync(snapshotPath("build", "dev-x"), prior);
    host = remote(["spawn-preview-2"], ok);
    routed = routeCommand("build", "spawn", args, { server, execFileSync: host.exec });
    assert.deepEqual(routed.envelope.result.warnings, ["the host's own warning", "a spawn would save no route: dev-x already names /w/agents/other/instances/dev-x through build; that instance (/w/agents/dev/instances/dev-x) would not be managed from here, and would be retired on the host with oats retire dev-x --home /w/agents/dev/instances/dev-x"]);
    assert.equal("snapshot" in routed.envelope.result, false); assert.equal("routeConflict" in routed.envelope.result, false);
    assert.equal(readFileSync(snapshotPath("build", "dev-x"), "utf8"), prior);
    // A saved route naming the previewed home is the same route: no warning added.
    writeFileSync(snapshotPath("build", "dev-x"), JSON.stringify({ ...JSON.parse(prior), home: hostPreview.home }));
    routed = routeCommand("build", "spawn", args, { server, execFileSync: remote(["spawn-preview-2"], ok).exec });
    assert.deepEqual(routed.envelope.result.warnings, ["the host's own warning"]);
    rmSync(REMOTE_SNAPSHOT_DIR(), { recursive: true, force: true });

    // A host without spawn-preview-2 might spawn for real: refused, the spawn never sent.
    host = remote(["harness"], ok);
    assert.throws(() => routeCommand("build", "spawn", args, { server, execFileSync: host.exec }),
      (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message === "remote oats 0.55.0 at h does not advertise spawn-preview-2; upgrade it there; nothing was sent");
    assert.deepEqual(host.spawned(), []);
    // The apply's refusals come first, as the apply orders them: a retargeted registration before anything is asked.
    mkdirSync(dirname(snapshotPath("build", "dev-old")), { recursive: true });
    writeFileSync(snapshotPath("build", "dev-old"), JSON.stringify({ serverId: "build", target: { ...target, workspace: "/elsewhere" }, instance: "dev-old", home: "/elsewhere/agents/dev/instances/dev-old" }));
    host = remote(["spawn-preview-2"], ok);
    assert.throws(() => routeCommand("build", "spawn", args, { server, execFileSync: host.exec }), (e) => e.code === "E_ROUTE_CHANGED");
    assert.deepEqual(host.sent, [], "nothing was asked of the host");
    rmSync(REMOTE_SNAPSHOT_DIR(), { recursive: true, force: true });

    // The host refuses the preview: its envelope relayed as is, nothing written.
    const refused = { schemaVersion: 1, ok: false, error: { code: "E_SOUL_UNKNOWN", message: "no soul dev" } };
    routed = routeCommand("build", "spawn", args, { server, execFileSync: remote(["spawn-preview-2"], refused).exec });
    assert.deepEqual(routed.envelope, refused);
    assert.equal(existsSync(REMOTE_SNAPSHOT_DIR()), false);
    // An ok answer that is not a preview created an instance: its route is recorded, as the apply records it.
    const spawned = { schemaVersion: 1, ok: true, result: { instance: "dev-x", agent: "dev", home: hostPreview.home, launched: false, warnings: [] } };
    routed = routeCommand("build", "spawn", args, { server, execFileSync: remote(["spawn-preview-2"], spawned).exec });
    assert.equal(routed.envelope.result.snapshot, snapshotPath("build", "dev-x"));
    assert.equal(JSON.parse(readFileSync(snapshotPath("build", "dev-x"), "utf8")).home, hostPreview.home);
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn --preview --suggest-name (#1421 §3) needs a host that advertises spawn-suggest-name: refused before the spawn is sent, else the flag and the task travel and the host's naming is relayed", () => {
  const base = mkdtempSync("/tmp/oats-pvn-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.67.0", desktopApi: 1, harnesses: ["pi", "claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "claude", instances: [] }] } };
    const naming = { source: "suggested", ms: 2310, harness: "claude", model: "haiku" };
    const hostPreview = { spawnPreviewApi: 2, preview: true, agent: "dev", kind: "persistent", instance: "fix-login-dev", home: "/w/agents/dev/instances/fix-login-dev", work: "checkout", harness: "claude", modelSource: "harness default", decision: { revision: "r1" }, naming };
    const remote = (features) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        sent.push(word);
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: hostPreview });
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { sent, exec, spawned: () => sent.filter((w) => w.includes(" spawn ")) };
    };
    const args = ["dev", "--preview", "--suggest-name", "--task", "Fix the login bug"];
    const old = remote(["spawn-preview-2"]);
    assert.throws(() => routeCommand("build", "spawn", args, { server, execFileSync: old.exec }),
      (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message === "remote oats 0.67.0 at h does not advertise spawn-suggest-name; upgrade it there; nothing was sent");
    assert.deepEqual(old.spawned(), []);
    const current = remote(["spawn-preview-2", "spawn-suggest-name"]);
    const routed = routeCommand("build", "spawn", args, { server, execFileSync: current.exec });
    assert.deepEqual(routed.envelope.result.naming, naming);
    assert.equal(routed.envelope.result.instance, "fix-login-dev");
    assert.equal(current.spawned().length, 1);
    assert.match(current.spawned()[0], / spawn dev --preview --suggest-name --task 'Fix the login bug' --dir \/w --json$/);
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn --name needs a host that advertises spawn-name: refused before the spawn is sent, else the exact name travels; a saved route under that name refuses first (E_ROUTE_EXISTS)", () => {
  const base = mkdtempSync("/tmp/oats-rsn-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.25.0", desktopApi: 1, harnesses: ["pi", "claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "claude", instances: [] }] } };
    const made = { instance: "api-v2-dev", agent: "dev", home: "/w/agents/dev/instances/api-v2-dev", launched: false, warnings: [] };
    const remote = (features) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        sent.push(word);
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: made });
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { sent, exec, spawned: () => sent.filter((w) => w.includes(" spawn ")) };
    };
    const args = ["dev", "--name", "api-v2-dev", "--task", "Ship it"];
    // A host before 0.26 takes no exact name: refused here, nothing sent.
    const old = remote(["spawn-preview-2"]);
    assert.throws(() => routeCommand("build", "spawn", args, { server, execFileSync: old.exec }),
      (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message === "remote oats 0.25.0 at h does not advertise spawn-name; upgrade it there; nothing was sent");
    assert.deepEqual(old.spawned(), []);
    // A purpose needs no spawn-name: today's route, unchanged.
    const purposeOnly = remote([]);
    routeCommand("build", "spawn", ["dev", "--purpose", "api-v2", "--task", "Ship it"], { server, execFileSync: purposeOnly.exec });
    assert.match(purposeOnly.spawned()[0], / spawn dev --purpose api-v2 --task 'Ship it' --dir \/w --json$/);
    rmSync(REMOTE_SNAPSHOT_DIR(), { recursive: true, force: true });
    // A host with spawn-name: --name travels untouched, and the route is saved under the name the host reports.
    const current = remote(["spawn-name"]);
    const routed = routeCommand("build", "spawn", args, { server, execFileSync: current.exec });
    assert.equal(current.spawned().length, 1);
    assert.match(current.spawned()[0], / spawn dev --name api-v2-dev --task 'Ship it' --dir \/w --json$/);
    assert.equal(routed.envelope.result.instance, "api-v2-dev");
    assert.equal(routed.envelope.result.snapshot, snapshotPath("build", "api-v2-dev"));
    // That name now has a saved route here: a second --name spawn of it is refused before the spawn is sent.
    const again = remote(["spawn-name"]);
    assert.throws(() => routeCommand("build", "spawn", args, { server, execFileSync: again.exec }), (e) => e.code === "E_ROUTE_EXISTS" && e.message.startsWith("a saved route for api-v2-dev through server build already exists"));
    assert.deepEqual(again.spawned(), []);
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn --suggest-name on an apply (#1490 §3) needs the host's spawn-apply-suggest-name, a preview still spawn-suggest-name: refused before the spawn is sent, never dropped; else the flag travels and the host's naming is relayed", () => {
  const base = mkdtempSync("/tmp/oats-pvn-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.67.0", desktopApi: 1, harnesses: ["pi", "claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "claude", instances: [] }] } };
    const naming = { source: "suggested", ms: 2310, harness: "claude", model: "haiku" };
    const hostApply = { instance: "fix-login-dev", agent: "dev", home: "/w/agents/dev/instances/fix-login-dev", work: "checkout", harness: "claude", launched: true, naming };
    const hostPreview = { spawnPreviewApi: 2, preview: true, agent: "dev", kind: "persistent", instance: "fix-login-dev", home: "/w/agents/dev/instances/fix-login-dev", work: "checkout", harness: "claude", modelSource: "harness default", decision: { revision: "r1" }, naming };
    const remote = (features) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        sent.push(word);
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: word.includes(" --preview ") ? hostPreview : hostApply });
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { sent, exec, spawned: () => sent.filter((w) => w.includes(" spawn ")) };
    };
    const apply = ["dev", "--suggest-name", "--task", "Fix the login bug"];
    const preview = ["dev", "--preview", "--suggest-name", "--task", "Fix the login bug"];
    // A host that names previews only: an apply's flag is refused, never dropped.
    const previewsOnly = remote(["spawn-preview-2", "spawn-suggest-name"]);
    assert.throws(() => routeCommand("build", "spawn", apply, { server, execFileSync: previewsOnly.exec }),
      (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message === "remote oats 0.67.0 at h does not advertise spawn-apply-suggest-name; upgrade it there; nothing was sent");
    assert.deepEqual(previewsOnly.spawned(), []);
    // A host that names applies only: a preview still needs spawn-suggest-name.
    const appliesOnly = remote(["spawn-preview-2", "spawn-apply-suggest-name"]);
    assert.throws(() => routeCommand("build", "spawn", preview, { server, execFileSync: appliesOnly.exec }),
      (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message.includes("does not advertise spawn-suggest-name"));
    assert.deepEqual(appliesOnly.spawned(), []);
    const routed = routeCommand("build", "spawn", apply, { server, execFileSync: appliesOnly.exec });
    assert.deepEqual(routed.envelope.result.naming, naming);
    assert.equal(routed.envelope.result.instance, "fix-login-dev");
    assert.equal(appliesOnly.spawned().length, 1);
    assert.match(appliesOnly.spawned()[0], / spawn dev --suggest-name --task 'Fix the login bug' --dir \/w --json$/);
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn --same-work (#1577) needs the host's instance-same-work: refused before the spawn is sent, a preview's included; else the flag travels as given", () => {
  const base = mkdtempSync("/tmp/oats-rsw-");
  const prevHomeDir = process.env.OATS_HOME_DIR; process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  try {
    const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
    const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.68.1", desktopApi: 1, harnesses: ["pi", "claude"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features });
    const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "claude", instances: [] }] } };
    const made = { instance: "dev-kid", agent: "dev", home: "/w/agents/dev/instances/dev-kid", work: "checkout", harness: "claude", launched: false, parent: "boss" };
    const preview = { spawnPreviewApi: 2, preview: true, agent: "dev", kind: "persistent", instance: "dev-kid", home: "/w/agents/dev/instances/dev-kid", work: "checkout", harness: "claude", modelSource: "harness default", decision: { revision: "r1" }, parentInstance: "boss" };
    const remote = (features) => {
      const sent = [];
      const exec = (bin, argv) => {
        const word = String(argv.at(-1));
        sent.push(word);
        if (word.includes("version --json")) return JSON.stringify(probe(features));
        if (word.includes(" status ")) return JSON.stringify(status);
        if (word.includes(" spawn ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: word.includes(" --preview ") ? preview : made });
        throw new Error(`unexpected remote call: ${word}`);
      };
      return { sent, exec, spawned: () => sent.filter((w) => w.includes(" spawn ")) };
    };
    const apply = ["dev", "--purpose", "kid", "--parent", "boss", "--same-work"];
    for (const args of [apply, [...apply, "--preview"]]) {
      const old = remote(["spawn-preview-2"]);
      assert.throws(() => routeCommand("build", "spawn", args, { server, execFileSync: old.exec }),
        (e) => e.code === "E_REMOTE_INCOMPATIBLE" && e.message === "remote oats 0.68.1 at h does not advertise instance-same-work; upgrade it there; nothing was sent", args.join(" "));
      assert.deepEqual(old.spawned(), [], `${args.join(" ")}: nothing was sent`);
    }
    // Without the flag, nothing about the feature is asked.
    const without = remote([]);
    routeCommand("build", "spawn", ["dev", "--purpose", "kid", "--parent", "boss"], { server, execFileSync: without.exec });
    assert.equal(without.spawned().length, 1);
    rmSync(REMOTE_SNAPSHOT_DIR(), { recursive: true, force: true });
    const current = remote(["spawn-preview-2", "instance-same-work"]);
    routeCommand("build", "spawn", apply, { server, execFileSync: current.exec });
    assert.equal(current.spawned().length, 1);
    assert.match(current.spawned()[0], / spawn dev --purpose kid --parent boss --same-work --dir \/w --json$/);
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("routed spawn --preview (#610), text: the host's answer picks the printer: a pre-0.27 host's preview reads its runtime, its default launch configuration is the server's; an answer that spawned prints as the spawn it was, its route saved", () => {
  const base = mkdtempSync("/tmp/oats-pvt-");
  const prevHomeDir = process.env.OATS_HOME_DIR;
  try {
    const { bin } = fakeBin(base);
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    process.env.OATS_HOME_DIR = env.OATS_HOME_DIR;
    // A 0.26.0 host, scripted: it advertises spawn-preview-2 and names the harness `runtime`;
    // its spawn answers whatever FAKE_SPAWN holds.
    const host = join(base, "host-oats");
    write(host, `#!${process.execPath}
const a = process.argv.slice(2), out = (v) => process.stdout.write(JSON.stringify(v));
if (a[0] === "version") out({ schemaVersion: 1, name: "@awebai/oats", version: "0.26.0", desktopApi: 1, runtimes: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features: ["spawn-preview-2"] });
else if (a[0] === "status") out({ schemaVersion: 1, ok: true, result: { root: "/srv/ws/agents", agents: [{ name: "dev", runtime: "pi", instances: [] }] } });
else if (a[0] === "spawn") out({ schemaVersion: 1, ok: true, result: JSON.parse(process.env.FAKE_SPAWN) });
else process.exit(9);
`);
    chmodSync(host, 0o755);
    writeServers({ legacy: { sshHost: "legacy-host", workspace: "/srv/ws", oatsPath: host } });
    const home = "/srv/ws/agents/dev/instances/dev-x";
    const run = (answer) => oats({ ...env, FAKE_SPAWN: JSON.stringify(answer) }, ["spawn", "dev", "--server", "legacy", "--purpose", "x", "--no-launch", "--preview"]);

    let r = run({ spawnPreviewApi: 2, preview: true, agent: "dev", kind: "persistent", instance: "dev-x", home, work: "worktree", branch: "agents/dev-x", base: { ref: "origin/main", oid: "0123456789abcdef" }, runtime: "pi", model: null, modelSource: "native default", launchConfig: null, yolo: false });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.stdout, "preview dev → dev-x on legacy (worktree, branch agents/dev-x from origin/main@0123456789ab) harness pi (native default); nothing was created\n");
    // The launch configuration a routed preview names is the server's default, not this machine's.
    r = run({ spawnPreviewApi: 2, preview: true, agent: "dev", kind: "persistent", instance: "dev-x", home, work: "checkout", runtime: "pi", model: "m1", launchConfig: "fast", launchConfigDefault: true, yolo: false });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.stdout, "preview dev → dev-x on legacy (checkout) harness pi model m1 via launch configuration fast (the server's pi default); nothing was created\n");
    // A host that names where the configuration was declared: its directory, as the host answered it.
    r = run({ spawnPreviewApi: 2, preview: true, agent: "dev", kind: "persistent", instance: "dev-x", home, work: "checkout", runtime: "pi", model: "m1", launchConfig: "fast", launchConfigSource: "/srv/home/.oats/config", launchConfigDefault: true, yolo: false });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.stdout, "preview dev → dev-x on legacy (checkout) harness pi model m1 via launch configuration fast (the server's pi default) from /srv/home/.oats/config; nothing was created\n");
    assert.equal(existsSync(REMOTE_SNAPSHOT_DIR()), false, "nothing written here");

    // A host that spawned although asked for a preview: the apply's lines, and its route, as the apply records it.
    for (const [work, branch] of [["worktree", "agents/dev-x"], ["checkout", null]]) {
      r = run({ instance: "dev-x", agent: "dev", home, work, branch, launched: false, warnings: [] });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(r.stdout.split("\n")[0], `Spawned dev-x on legacy (${work}${branch ? `, branch ${branch}` : ""}) — not launched`, r.stdout);
      assert.match(r.stdout, /route snapshot: .*dev-x\.json/);
      assert.doesNotMatch(r.stdout, /nothing was created/);
      assert.equal(JSON.parse(readFileSync(snapshotPath("legacy", "dev-x"), "utf8")).home, home);
    }
  } finally {
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
    rmSync(base, { recursive: true, force: true });
  }
});

test("roster: each group relays the host's status `workspace` verbatim (an older host's reachability-only one too), or null from a host that reports none", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-servers-ws-"));
  try {
    const { bin, tools } = fakeBin(base);
    const repo = remoteWorkspace(); // nothing spawned: an empty remote deployment still reports its workspace
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    // A host whose status answer is rewritten by `edit` (a JS expression over the parsed answer `j`).
    const hostWith = (name, edit) => {
      const file = join(base, name);
      write(file, `#!/bin/sh
if [ "$1" = status ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@" | ${JSON.stringify(process.execPath)} -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const j=JSON.parse(s);${edit};process.stdout.write(JSON.stringify(j))})'
else exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"; fi
`);
      chmodSync(file, 0o755);
      return file;
    };
    // A host before workspace-identity answers the reachability-only object; one that reports no
    // workspace at all (as a deployment without oats-local.yaml does) omits it.
    const older = hostWith("older-oats", "j.workspace={reachable:j.workspace.reachable}");
    const none = hostWith("none-oats", "delete j.workspace");
    let r = oats(env, ["server", "add", "current", "--ssh", "current-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "add", "older", "--ssh", "older-host", "--workspace", repo, "--oats", older, "--path", tools, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "add", "none", "--ssh", "none-host", "--workspace", repo, "--oats", none, "--path", tools, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "add", "down", "--ssh", "down-host", "--workspace", join(base, "no-such-ws"), "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr);

    r = oats(env, ["server", "roster", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const groups = Object.fromEntries(r.json().result.groups.map((g) => [g.server, g]));
    // What the host itself answers, run where the fake ssh runs it.
    const own = oats(env, ["status", "--json", "--dir", repo]);
    assert.equal(own.status, 0, own.stderr);
    const hostWorkspace = JSON.parse(own.stdout).workspace;
    assert.equal(typeof hostWorkspace.key, "string", "the host reports its workspace identity");
    assert.deepEqual(groups.current.probe, { ok: true, features: KERNEL_FEATURES, sessionViewer: { prefixScroll: true } });
    assert.deepEqual(groups.current.workspace, hostWorkspace, "relayed verbatim");
    assert.deepEqual(groups.current.instances, []);
    assert.deepEqual(groups.older.probe, { ok: true, features: KERNEL_FEATURES, sessionViewer: { prefixScroll: true } });
    assert.deepEqual(groups.older.workspace, { reachable: true }, "an older host's reachability-only object is relayed as it is");
    assert.deepEqual(groups.none.probe, { ok: true, features: KERNEL_FEATURES, sessionViewer: { prefixScroll: true } });
    assert.equal(groups.none.workspace, null, "a host that reports no workspace relays null");
    assert.equal(groups.down.probe.ok, false);
    assert.equal(groups.down.workspace, null, "an unreachable host relays null");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("roster (feature server-probe-features): a group's probe relays the host's status `features` only when every entry passes, else null; a failed pull has no features key", async () => {
  const prevHomeDir = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = mkdtempSync(join(tmpdir(), "oats-servers-pf-"));
  try {
    const status = { root: "/srv/ws/agents", agents: [] };
    // One group from a fake host answering `status --json` with `answer` (a JS value, or a throw).
    const probeOf = async (answer) => {
      writeServers({ build: { sshHost: "build-host", workspace: "/srv/ws" } });
      const exec = async () => { if (answer instanceof Error) throw answer; return JSON.stringify(answer); };
      const out = await rosterGroups({ server: "build", io: { execFileAsync: exec, serverId: `build-${Math.random()}` } });
      assert.equal(out.groups.length, 1);
      return out.groups[0].probe;
    };
    const withFeatures = (features) => probeOf({ ...status, features });
    const valid = ["retire-home", "a", "0", "x2-y3", "a".repeat(64), "retire-home"];
    assert.deepEqual(await withFeatures(valid), { ok: true, features: valid, sessionViewer: null }, "relayed as answered: order and a duplicate kept");
    assert.deepEqual(await probeOf(status), { ok: true, features: null, sessionViewer: null }, "an older host (no key): unknown");
    // Its viewer fact, from the same answer (feature session-attach-prefix-scroll).
    for (const prefixScroll of [true, false]) assert.deepEqual((await probeOf({ ...status, sessionViewer: { prefixScroll } })).sessionViewer, { prefixScroll });
    for (const sessionViewer of [null, "yes", { prefixScroll: "true" }, {}]) assert.equal((await probeOf({ ...status, sessionViewer })).sessionViewer, null, JSON.stringify(sessionViewer));
    assert.deepEqual(await withFeatures([]), { ok: true, features: [], sessionViewer: null }, "[] is a valid answer, not unknown");
    const exactly256 = Array.from({ length: 256 }, (_, i) => `f${i}`);
    assert.deepEqual((await withFeatures(exactly256)).features, exactly256, "256 entries is the limit");
    for (const [why, features] of [
      ["null", null], ["a string", "retire-home"], ["an object", { 0: "retire-home" }], ["a number", 1],
      ["a non-string entry", ["retire-home", 1]], ["an uppercase entry", ["Retire-home"]], ["an entry with a space", ["retire home"]],
      ["an empty entry", [""]], ["a leading hyphen", ["-retire"]], ["a trailing hyphen", ["retire-"]], ["a double hyphen", ["retire--home"]],
      ["a 65-character entry", ["a".repeat(65)]], ["257 entries", Array.from({ length: 257 }, (_, i) => `f${i}`)],
      ["one bad entry among good ones (never filtered)", ["retire-home", "session-start", "Bad", "operations"]],
    ]) assert.deepEqual(await withFeatures(features), { ok: true, features: null, sessionViewer: null }, why);
    // A failed pull: exactly the error, never a features key.
    const failed = async (answer) => { const p = await probeOf(answer); assert.equal(p.ok, false); assert.equal("features" in p || "sessionViewer" in p, false); return p; };
    assert.equal((await failed(Object.assign(new Error("ssh: connect to host build-host: Connection refused"), { status: 255, stderr: "ssh: connect to host build-host: Connection refused" }))).error.code, "E_SSH");
    assert.deepEqual((await failed({ schemaVersion: 1, ok: false, error: { code: "E_NO_DEPLOYMENT", message: "no deployment" } })).error, { code: "E_NO_DEPLOYMENT", message: "no deployment" }, "a remote ok:false is relayed as today");
    // A success envelope whose result is not an object is unknown too, and never sinks a healthy group.
    for (const [why, answer] of [["result null", { schemaVersion: 1, ok: true, result: null }], ["result omitted", { schemaVersion: 1, ok: true }],
      ["result a string", { schemaVersion: 1, ok: true, result: "x" }], ["result a number", { schemaVersion: 1, ok: true, result: 7 }], ["result an array", { schemaVersion: 1, ok: true, result: ["retire-home"] }]]) {
      writeServers({ odd: { sshHost: "odd-host", workspace: "/srv/odd" }, healthy: { sshHost: "healthy-host", workspace: "/srv/healthy" } });
      const exec = async (_bin, argv) => JSON.stringify(argv.join(" ").includes("odd-host") ? answer : { root: "/srv/healthy/agents", agents: [], features: ["session-start"] });
      const groups = Object.fromEntries((await rosterGroups({ io: { execFileAsync: exec, serverId: `pair-${Math.random()}` } })).groups.map((g) => [g.server, g]));
      assert.deepEqual(groups.odd.probe, { ok: true, features: null, sessionViewer: null }, why);
      assert.deepEqual(groups.odd.instances, [], why);
      assert.deepEqual(groups.healthy.probe, { ok: true, features: ["session-start"], sessionViewer: null }, `${why}: the healthy group survives`);
    }
    // The host's viewer fact (feature session-attach-prefix-scroll), relayed the same way: only
    // { prefixScroll: <boolean> } is relayed, as a copy; anything else, or no key, is null.
    assert.deepEqual(hostSessionViewer({ sessionViewer: { prefixScroll: true } }), { prefixScroll: true });
    assert.deepEqual(hostSessionViewer({ sessionViewer: { prefixScroll: false, later: 1 } }), { prefixScroll: false }, "a field it does not know is not relayed");
    for (const result of [undefined, null, 42, {}, { sessionViewer: null }, { sessionViewer: [] }, { sessionViewer: "yes" }, { sessionViewer: {} }, { sessionViewer: { prefixScroll: "true" } }, { sessionViewer: { prefixScroll: 1 } }]) assert.equal(hostSessionViewer(result), null, JSON.stringify(result));
    // The predicate alone: a result that is not an object, or carries no key, is unknown.
    for (const result of [undefined, null, "features", 42, ["retire-home"]]) assert.equal(hostFeatures(result), null);
    const own = { features: ["a"] };
    assert.notEqual(hostFeatures(own), own.features, "a copy, never the host's own array");
  } finally {
    rmSync(process.env.OATS_HOME_DIR, { recursive: true, force: true });
    if (prevHomeDir === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prevHomeDir;
  }
});

test("roster: every target is probed at once, each within its own deadline: hosts that never answer cost their own entries and nothing else", () => {
  const base = mkdtempSync(join(tmpdir(), "oats-servers-budget-"));
  try {
    const { bin, tools } = fakeBin(base);
    const fx = remoteDeployment();
    const repo = fx.dep;
    // The roster lists a workspace soul once it has been spawned (its per-commit copy under agents/).
    const seeded = fx.cli(["spawn", "dev", "--purpose", "seed", "--no-launch", "--json"]);
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    // A "host" whose oats stops answering `status` once it is registered (registering asks it too):
    // the remote command word runs this.
    const slow = join(base, "slow-oats"), down = join(base, "slow-hosts-down");
    write(slow, `#!/bin/sh\nif [ "$1" = status ] && [ -e ${JSON.stringify(down)} ]; then sleep 20; exit 255; fi\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`); chmodSync(slow, 0o755);
    // Registered first, as the offline host's four registrations were (#1117): the healthy one is last.
    const SLOW = ["slow1", "slow2", "slow3", "slow4"];
    let r;
    for (const id of SLOW) {
      r = oats(env, ["server", "add", id, "--ssh", `${id}-host`, "--workspace", repo, "--oats", slow, "--json"]);
      assert.equal(r.status, 0, r.stderr);
    }
    r = oats(env, ["server", "add", "good", "--ssh", "good-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    write(down, "");
    const t0 = Date.now();
    r = oats(env, ["server", "roster", "--json", "--per-target", "3000"]);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = r.json().result;
    // In sequence the four would cost 12 s before the healthy host was asked.
    assert.ok(elapsed < 8000, `roster took ${elapsed} ms: the targets were not probed at once`);
    assert.deepEqual(out.groups.map((g) => g.server), [...SLOW, "good"], "registration order, whatever order the probes finished in");
    assert.deepEqual(out.groups[4].probe, { ok: true, features: KERNEL_FEATURES, sessionViewer: { prefixScroll: true } });
    assert.deepEqual(out.groups[4].souls.map((s) => s.name), ["dev"]);
    for (const g of out.groups.slice(0, 4)) {
      assert.deepEqual(Object.keys(g.probe).sort(), ["error", "ok"], "a failed ssh carries no features key");
      assert.deepEqual(g.probe.error, { code: "E_SSH", message: `ssh to ${g.target.sshHost} timed out: no answer within 3 s` });
    }
    assert.deepEqual(Object.keys(out.bounds).sort(), ["budgetMs", "elapsedMs", "perTargetTimeoutMs"]);
    assert.equal(out.bounds.budgetMs, 45000); assert.equal(out.bounds.perTargetTimeoutMs, 3000);
    // The answer deadline caps every probe's own allowance.
    r = oats(env, ["server", "roster", "--json", "--budget", "2000", "--per-target", "4000"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const g of r.json().result.groups.slice(0, 4)) assert.equal(g.probe.error.message, `ssh to ${g.target.sshHost} timed out: no answer within 2 s`);
    r = oats(env, ["server", "roster", "--json", "--budget", "5"]);
    assert.equal(r.json().error.code, "E_BAD_ARGS");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// In-process roster probes over an injected asynchronous transport (`io.execFileAsync`), each call
// answered by the ssh host it names. Small deadlines keep these fast.
const sshHostOf = (argv) => argv[argv.indexOf("--") + 1];
const statusOf = (host) => JSON.stringify({ root: `/srv/${host}/agents`, agents: [{ name: "dev", harness: "claude", instances: [{ instance: `dev-${host}`, home: `/srv/${host}/agents/dev/instances/dev-${host}`, running: true }] }] });
const after = (ms, value) => new Promise((done) => setTimeout(() => done(value), ms));
/** A host that never answers on its own: its call settles only when aborted, as execFile's does. */
const hangs = (aborted) => (opts) => new Promise((_, reject) => opts.signal.addEventListener("abort", () => { aborted.push(true); reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })); }));
/** A host that ignores the abort too: the deadline must hold without the transport's help. */
const neverAnswers = () => new Promise(() => {});
/** The roster of `registrations` (server ids; registration `<id>` names ssh host `<id>-host`, unless
 *  `hostOf` says otherwise), `answers[host](opts, argv)` answering each call; in a fresh OATS home. */
async function parallelRoster(registrations, answers, { perTargetTimeoutMs = 400, hostOf = (id) => `${id}-host` } = {}) {
  const prevHomeDir = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = mkdtempSync("/tmp/oats-servers-par-"); // short: the control socket path must fit
  try {
    writeServers(Object.fromEntries(registrations.map((id) => [id, { sshHost: hostOf(id), workspace: `/srv/${id}` }])));
    const execFileAsync = async (_bin, argv, opts) => answers[sshHostOf(argv)](opts, argv);
    const t0 = Date.now();
    const out = await rosterGroups({ io: { execFileAsync, perTargetTimeoutMs } });
    return { out, elapsed: Date.now() - t0, groups: Object.fromEntries(out.groups.map((g) => [g.server, g])) };
  } finally {
    rmSync(process.env.OATS_HOME_DIR, { recursive: true, force: true });
    process.env.OATS_HOME_DIR = prevHomeDir;
  }
}

test("roster (#1117): a target that never answers fails with its own timeout; the healthy one beside it comes back with its instances, in about one per-target timeout", async () => {
  const aborted = [];
  const { out, elapsed, groups } = await parallelRoster(["hung", "good"], { "hung-host": hangs(aborted), "good-host": () => statusOf("good") });
  assert.deepEqual(out.groups.map((g) => g.server), ["hung", "good"]);
  assert.deepEqual(groups.good.probe, { ok: true, features: null, sessionViewer: null });
  assert.deepEqual(groups.good.instances.map((i) => [i.instance, i.running]), [["dev-good", true]]);
  assert.equal(groups.hung.probe.ok, false);
  assert.equal(groups.hung.probe.error.code, "E_SSH");
  assert.match(groups.hung.probe.error.message, /^ssh to hung-host timed out: no answer within /);
  assert.deepEqual(aborted, [true], "the hung call was aborted: the transport kills its ssh");
  assert.ok(elapsed >= 400 && elapsed < 800, `${elapsed} ms: one per-target timeout, not the sum`);
});

test("roster (#1117): five targets of which the first four never answer: the fifth is probed and ok, and nothing reports a budget", async () => {
  const hung = ["altair", "altair-aweb", "altair-jro", "altair-oats"];
  const answers = { "nactiva-host": () => after(50, statusOf("nactiva")) };
  for (const id of hung) answers[`${id}-host`] = neverAnswers;
  const { out, elapsed, groups } = await parallelRoster([...hung, "nactiva"], answers);
  assert.deepEqual(out.groups.map((g) => g.server), [...hung, "nactiva"]);
  assert.deepEqual(groups.nactiva.probe, { ok: true, features: null, sessionViewer: null });
  assert.deepEqual(groups.nactiva.instances.map((i) => i.instance), ["dev-nactiva"]);
  for (const id of hung) assert.match(groups[id].probe.error.message, new RegExp(`^ssh to ${id}-host timed out: no answer within `), id);
  assert.deepEqual([...new Set(out.groups.filter((g) => !g.probe.ok).map((g) => g.probe.error.code))], ["E_SSH"]);
  assert.deepEqual(Object.keys(out.bounds).sort(), ["budgetMs", "elapsedMs", "perTargetTimeoutMs"]);
  assert.ok(elapsed < 800, `${elapsed} ms: four hung targets cost one per-target timeout together`);
});

test("roster (#1117): a target whose ssh fails at once reports its own E_SSH; the others are unaffected", async () => {
  const refused = () => { throw Object.assign(new Error("Command failed: ssh"), { status: 255, stderr: "ssh: connect to host down-host port 22: Connection refused\n" }); };
  const { groups } = await parallelRoster(["up1", "down", "up2"], { "up1-host": () => statusOf("up1"), "down-host": refused, "up2-host": () => after(20, statusOf("up2")) });
  assert.deepEqual(groups.down.probe, { ok: false, error: { code: "E_SSH", message: "ssh to down-host failed: ssh: connect to host down-host port 22: Connection refused" } });
  assert.deepEqual(groups.down.instances, []);
  for (const id of ["up1", "up2"]) {
    assert.deepEqual(groups[id].probe, { ok: true, features: null, sessionViewer: null }, id);
    assert.deepEqual(groups[id].instances.map((i) => i.instance), [`dev-${id}`], id);
  }
});

test("roster (#1117): the answer's group order is the registration order, whatever order the probes finish in", async () => {
  const { out } = await parallelRoster(["first", "second", "third"], {
    "first-host": () => after(120, statusOf("first")), "second-host": () => after(60, statusOf("second")), "third-host": () => statusOf("third"),
  });
  assert.deepEqual(out.groups.map((g) => [g.server, g.probe.ok]), [["first", true], ["second", true], ["third", true]]);
});

test("roster (#1117): two registrations of one host are probed at once over the shared control master, and both succeed", async () => {
  const calls = [];
  let inFlight = 0, most = 0;
  const shared = async (_opts, argv) => {
    calls.push(argv); most = Math.max(most, ++inFlight);
    try { return await after(50, statusOf("shared")); } finally { inFlight--; }
  };
  const { groups } = await parallelRoster(["one", "two"], { "shared-host": shared }, { hostOf: () => "shared-host" });
  assert.equal(most, 2, "both calls to the host were in flight together");
  for (const id of ["one", "two"]) assert.deepEqual(groups[id].probe, { ok: true, features: null, sessionViewer: null }, id);
  const control = (argv) => argv.filter((a) => a.startsWith("Control"));
  assert.ok(control(calls[0]).includes("ControlMaster=auto"), "the calls share the per-user control master");
  assert.deepEqual(control(calls[0]), control(calls[1]), "one ControlPath for the host");
});

// --workspace-key (feature roster-workspace-key, #1124): the roster probes only the groups that can
// belong to the given workspaces. Registration `<id>` names ssh host `<id>-host` and workspace
// `/srv/<id>`; a saved route is written as a snapshot under the fresh OATS home.
const TEAM = "github.com/acme/team", OTHER = "github.com/acme/other", THIRD = "github.com/acme/third";
async function keyedRoster({ registrations = {}, routes = [], workspaceKeys, server, answers = {} }) {
  const prevHomeDir = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = mkdtempSync("/tmp/oats-servers-key-"); // short: the control socket path must fit
  try {
    writeServers(Object.fromEntries(Object.entries(registrations).map(([id, extra]) => [id, { sshHost: `${id}-host`, workspace: `/srv/${id}`, ...extra }])));
    for (const { server: id, host, instance } of routes) {
      write(snapshotPath(id, instance), JSON.stringify({ serverId: id, target: { sshHost: host, workspace: `/srv/${id}`, oatsPath: "oats" }, instance, agent: "dev", home: `/srv/${id}/agents/dev/instances/${instance}` }));
    }
    const asked = [];
    const execFileAsync = async (_bin, argv, opts) => { const host = sshHostOf(argv); asked.push(host); return (answers[host] || (() => statusOf(host)))(opts, argv); };
    const t0 = Date.now();
    const out = await rosterGroups({ server, workspaceKeys, io: { execFileAsync, perTargetTimeoutMs: 400 } });
    return { out, elapsed: Date.now() - t0, asked: asked.sort(), returned: out.groups.map((g) => `${g.server}@${g.target.sshHost}`) };
  } finally {
    rmSync(process.env.OATS_HOME_DIR, { recursive: true, force: true });
    process.env.OATS_HOME_DIR = prevHomeDir;
  }
}

test("roster --workspace-key (#1124): a dead host registered only for another workspace is neither probed nor returned, its saved routes with it; a route-only server is still probed", async () => {
  const { out, elapsed, asked, returned } = await keyedRoster({
    registrations: { mine: { workspaceKey: TEAM }, dead: { workspaceKey: OTHER }, unknown: {} },
    // dead's saved route under its registered target goes with it; one under a target its
    // registration no longer names is a group of its own, route-only, always probed.
    routes: [{ server: "dead", host: "dead-host", instance: "dev-d1" }, { server: "dead", host: "dead-old-host", instance: "dev-d0" }, { server: "gone", host: "gone-host", instance: "dev-g1" }],
    workspaceKeys: [TEAM],
    answers: { "dead-host": neverAnswers },
  });
  assert.deepEqual(asked, ["dead-old-host", "gone-host", "mine-host", "unknown-host"], "the dead host was never asked");
  assert.deepEqual(returned.slice(0, 2), ["mine@mine-host", "unknown@unknown-host"], "registrations first, in their order");
  assert.deepEqual(returned.slice(2).sort(), ["dead@dead-old-host", "gone@gone-host"]);
  const byHost = Object.fromEntries(out.groups.map((g) => [g.target.sshHost, g]));
  assert.equal(byHost["dead-old-host"].registrationPresent, false);
  assert.equal(byHost["gone-host"].registrationPresent, false);
  assert.deepEqual(byHost["gone-host"].instances.map((i) => [i.instance, i.savedRoute]), [["dev-gone-host", false], ["dev-g1", true]]);
  for (const g of out.groups) { assert.equal(g.probe.ok, true, g.id); assert.equal("_workspaceKey" in g, false, g.id); }
  assert.ok(elapsed < 400, `${elapsed} ms: nothing waited for the dead host`);
});

test("roster --workspace-key (#1124): matching and unknown registrations are probed; two keys each select their own; duplicates are harmless; a key that matches nothing leaves the unknown and route-only groups", async () => {
  const registrations = { team: { workspaceKey: TEAM }, other: { workspaceKey: OTHER }, third: { workspaceKey: THIRD }, unknown: {} };
  const routes = [{ server: "gone", host: "gone-host", instance: "dev-g1" }];
  let r = await keyedRoster({ registrations, routes, workspaceKeys: [TEAM] });
  assert.deepEqual(r.asked, ["gone-host", "team-host", "unknown-host"]);
  assert.deepEqual(r.returned, ["team@team-host", "unknown@unknown-host", "gone@gone-host"]);
  r = await keyedRoster({ registrations, routes, workspaceKeys: [OTHER, TEAM, OTHER] });
  assert.deepEqual(r.asked, ["gone-host", "other-host", "team-host", "unknown-host"]);
  assert.deepEqual(r.returned, ["team@team-host", "other@other-host", "unknown@unknown-host", "gone@gone-host"]);
  r = await keyedRoster({ registrations, routes, workspaceKeys: ["github.com/acme/none"] });
  assert.deepEqual(r.returned, ["unknown@unknown-host", "gone@gone-host"]);
  // A key is compared as given: never canonicalized, so a repo-ref spelling of the same workspace matches nothing.
  r = await keyedRoster({ registrations, workspaceKeys: [`git:${TEAM}`] });
  assert.deepEqual(r.returned, ["unknown@unknown-host"]);
});

test("roster --workspace-key (#1124): without keys every group is probed and returned, as before; --server and the keys both narrow", async () => {
  const registrations = { team: { workspaceKey: TEAM }, other: { workspaceKey: OTHER }, unknown: {} };
  const routes = [{ server: "other", host: "other-host", instance: "dev-o1" }, { server: "gone", host: "gone-host", instance: "dev-g1" }];
  let r = await keyedRoster({ registrations, routes });
  assert.deepEqual(r.asked, ["gone-host", "other-host", "team-host", "unknown-host"]);
  assert.deepEqual(r.returned, ["team@team-host", "other@other-host", "unknown@unknown-host", "gone@gone-host"]);
  assert.deepEqual(r.out.groups.find((g) => g.server === "other").instances.map((i) => i.instance), ["dev-other-host", "dev-o1"]);
  r = await keyedRoster({ registrations, routes, workspaceKeys: [] });
  assert.deepEqual(r.returned, ["unknown@unknown-host", "gone@gone-host"], "an empty list is a filter that admits no registered key");
  r = await keyedRoster({ registrations, routes, server: "other", workspaceKeys: [TEAM] });
  assert.deepEqual([r.asked, r.returned], [[], []]);
  r = await keyedRoster({ registrations, routes, server: "team", workspaceKeys: [TEAM, OTHER] });
  assert.deepEqual([r.asked, r.returned], [["team-host"], ["team@team-host"]]);
  r = await keyedRoster({ registrations, routes, server: "gone", workspaceKeys: [TEAM] });
  assert.deepEqual(r.returned, ["gone@gone-host"]);
  // No servers file and no saved routes: no groups, as without keys.
  r = await keyedRoster({ workspaceKeys: [TEAM] });
  assert.deepEqual([r.asked, r.returned], [[], []]);
});

test("roster --workspace-key (#1124): a key that is not a canonical workspace key is E_BAD_ARGS before anything is asked", async () => {
  for (const bad of ["", "a b", "a\tb", "a\u0000b", "a\u007fb", 7, null]) {
    await assert.rejects(keyedRoster({ registrations: { team: { workspaceKey: TEAM } }, workspaceKeys: [TEAM, bad] }), (e) => e.code === "E_BAD_ARGS", JSON.stringify(bad));
  }
  await assert.rejects(keyedRoster({ workspaceKeys: TEAM }), (e) => e.code === "E_BAD_ARGS", "a string, not a list");
});

test("oats server roster --workspace-key (#1124): every occurrence counts; a missing, empty or bad value is E_BAD_ARGS; text mode names an empty filtered answer", () => {
  const base = mkdtempSync("/tmp/oats-servers-keycli-");
  try {
    const empty = join(base, "bin"); mkdirSync(empty); // no ssh: every probe fails at once, the grouping is what is checked
    const env = { ...process.env, PATH: empty, OATS_HOME_DIR: join(base, "oh"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    write(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: {
      team: { sshHost: "team-host", workspace: "/srv/team", workspaceKey: TEAM },
      other: { sshHost: "other-host", workspace: "/srv/other", workspaceKey: OTHER },
      third: { sshHost: "third-host", workspace: "/srv/third", workspaceKey: THIRD },
    } }));
    let r = oats(env, ["server", "roster", "--workspace-key", TEAM, "--json", "--workspace-key", THIRD]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json().result.groups.map((g) => g.server), ["team", "third"]);
    r = oats(env, ["server", "roster", `--workspace-key=${OTHER}`, "--json"]);
    assert.deepEqual(r.json().result.groups.map((g) => g.server), ["other"]);
    // The `=` form, one argv element per key (what the Desktop passes), selects what the separate form does.
    r = oats(env, ["server", "roster", `--workspace-key=${TEAM}`, `--workspace-key=${THIRD}`, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.json().result.groups.map((g) => g.server), ["team", "third"]);
    r = oats(env, ["server", "roster", "--json"]);
    assert.deepEqual(r.json().result.groups.map((g) => g.server), ["team", "other", "third"], "no key: today's answer");
    r = oats(env, ["server", "roster", "--workspace-key", "github.com/acme/none"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "no remote groups for the given workspace keys");
    r = oats(env, ["server", "roster"]);
    assert.match(r.stdout, /team-host/, "without keys the text roster is unchanged");
    for (const argv of [["--workspace-key"], ["--workspace-key", "--json"], ["--workspace-key", ""], ["--workspace-key="], ["--workspace-key=--x"], [`--workspace-key=${TEAM}`, "--workspace-key="], ["--workspace-key", TEAM, "--workspace-key"], ["--workspace-key", "a b"], ["--workspace-key", "a\u0001b"]]) {
      r = oats(env, ["server", "roster", ...argv, "--json"]);
      assert.notEqual(r.status, 0, JSON.stringify(argv));
      const doc = r.json();
      assert.equal(doc.ok, false, JSON.stringify(argv));
      assert.equal(doc.error.code, "E_BAD_ARGS", JSON.stringify(argv));
    }
    r = oats(env, ["server", "roster", "--workspace-key"]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /--workspace-key needs a workspace key/);
    r = oats(env, ["help"]);
    assert.match(r.stdout, /--workspace-key <key>/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("routed retire: the branch a failed spawn's quarantine still owes is named on its own line, from the host's receipt", () => {
  const base = mkdtempSync("/tmp/oats-servers-"); // short: the control socket path must fit in 104 bytes
  try {
    const { bin, tools } = fakeBin(base);
    const repo = remoteWorkspace();
    const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
    mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
    for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
    // The host's oats: the real kernel, except that a retire answers with the receipt the test wrote,
    // with its exit status. No retirement runs. Shell builtins only: the fixture's PATH has no cat.
    const receipt = join(base, "receipt.json"), exit = join(base, "receipt-exit");
    const hostOats = join(base, "host-oats");
    writeFileSync(hostOats, `#!/bin/sh
case " $* " in *" retire "*) case " $* " in *" --plan "*) ;; *)
  while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < ${JSON.stringify(receipt)}
  read -r code < ${JSON.stringify(exit)}; exit "$code" ;; esac ;; esac
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"
`);
    chmodSync(hostOats, 0o755);
    let r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", hostOats, "--path", tools, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "owes", "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const home = r.json().result.home;
    const answer = (doc, status) => { writeFileSync(receipt, JSON.stringify(doc)); writeFileSync(exit, String(status)); };
    const itemThenBranch = (stderr, branchLine) => {
      const lines = stderr.split("\n");
      const at = lines.indexOf(`  ${FAILED_SPAWN_BRANCH_LEFT}`);
      assert.ok(at >= 0, stderr);
      assert.equal(lines[at + 1], branchLine, stderr);
    };

    // Incomplete, the worktree step ran: the receipt's recorded branch.
    answer({ retired: "dev-owes", agent: "dev", removedDir: false, branchDeleted: false, retainedHome: home, rollbackIncomplete: [FAILED_SPAWN_BRANCH_LEFT],
      retention: { worktree: "removed", branch: null, recordedBranch: "agents/dev-owes" } }, 1);
    r = oats(env, ["retire", "dev-owes", "--server", "build"]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    itemThenBranch(r.stderr, "  branch: agents/dev-owes");

    // Incomplete, no worktree step ran: where the retained home records it, on the host.
    answer({ retired: "dev-owes", agent: "dev", removedDir: false, branchDeleted: false, retainedHome: home, rollbackIncomplete: ["retire hook x: reported incomplete cleanup", FAILED_SPAWN_BRANCH_LEFT], retention: null }, 1);
    r = oats(env, ["retire", "dev-owes", "--server", "build"]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    itemThenBranch(r.stderr, `  branch: the "branch" recorded in ${join(home, "instance.json")} on build-host`);

    // Forced past the debt: the host's own stderr is not relayed on success, so the name comes from the receipt.
    answer({ retired: "dev-owes", agent: "dev", removedDir: true, branchDeleted: false, forcedIncomplete: [FAILED_SPAWN_BRANCH_LEFT],
      retention: { worktree: "removed", branch: null, recordedBranch: "agents/dev-owes" } }, 0);
    r = oats(env, ["retire", "dev-owes", "--server", "build", "--force"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    itemThenBranch(r.stderr, "  branch: agents/dev-owes");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("routed inspect --instructions needs a remote that advertises soul-composed-instructions: refused before anything is sent, else the flag travels", () => {
  const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
  const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.46.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features, operationsApi: 2 });
  const remote = (features) => {
    const sent = [];
    const exec = (bin, argv) => {
      const word = String(argv.at(-1));
      if (word.includes("version --json")) return JSON.stringify(probe(features));
      sent.push(word);
      if (word.includes(" inspect ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { souls: [{ name: "dev" }] } });
      throw new Error(`unexpected remote call: ${word}`);
    };
    return { sent, exec };
  };
  // An older host would ignore the flag and answer without the field: refused, nothing sent.
  const old = remote(["operations"]);
  assert.throws(() => routeCommand("build", "inspect", ["--soul", "dev", "--instructions"], { server, execFileSync: old.exec }),
    (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /soul-composed-instructions/.test(e.message) && /nothing was sent/.test(e.message));
  assert.deepEqual(old.sent, [], "no inspect was sent to a host without the feature");
  // Without the flag that host still answers inspect.
  const plain = routeCommand("build", "inspect", ["--soul", "dev"], { server, execFileSync: old.exec });
  assert.equal(plain.envelope.ok, true);
  assert.equal(old.sent.length, 1);
  assert.ok(!old.sent[0].includes("--instructions"));
  // A host that advertises it gets the flag, scoped to the registered workspace.
  const current = remote(["operations", "soul-composed-instructions"]);
  const routed = routeCommand("build", "inspect", ["--soul", "dev", "--instructions"], { server, execFileSync: current.exec });
  assert.equal(routed.envelope.ok, true);
  assert.equal(routed.envelope.result.server, "build");
  assert.equal(current.sent.length, 1);
  assert.match(current.sent[0], /(^| )oats inspect --soul dev --instructions --dir \/w --json$/);
});

test("routed inspect --skills needs a remote that advertises soul-skills: refused before anything is sent, else the flag travels (with --instructions too)", () => {
  const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
  const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.56.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features, operationsApi: 2 });
  const remote = (features) => {
    const sent = [];
    const exec = (bin, argv) => {
      const word = String(argv.at(-1));
      if (word.includes("version --json")) return JSON.stringify(probe(features));
      sent.push(word);
      if (word.includes(" inspect ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { souls: [{ name: "dev" }] } });
      throw new Error(`unexpected remote call: ${word}`);
    };
    return { sent, exec };
  };
  // A host without the feature would ignore the flag and answer without the field: refused, nothing sent —
  // including a host that has soul-composed-instructions, asked for both.
  for (const features of [["operations"], ["operations", "soul-composed-instructions"]]) {
    const old = remote(features);
    for (const argv of [["--soul", "dev", "--skills"], ["--soul", "dev", "--instructions", "--skills"]]) {
      if (argv.includes("--instructions") && !features.includes("soul-composed-instructions")) continue;
      assert.throws(() => routeCommand("build", "inspect", argv, { server, execFileSync: old.exec }),
        (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /does not advertise soul-skills/.test(e.message) && /nothing was sent/.test(e.message), JSON.stringify({ features, argv }));
    }
    assert.deepEqual(old.sent, [], "no inspect was sent to a host without the feature");
  }
  // A host that advertises it gets the flag, scoped to the registered workspace; with --instructions, both.
  const current = remote(["operations", "soul-composed-instructions", "soul-skills"]);
  const routed = routeCommand("build", "inspect", ["--soul", "dev", "--skills"], { server, execFileSync: current.exec });
  assert.equal(routed.envelope.ok, true);
  assert.equal(routed.envelope.result.server, "build");
  routeCommand("build", "inspect", ["--soul", "dev", "--instructions", "--skills"], { server, execFileSync: current.exec });
  assert.equal(current.sent.length, 2);
  assert.match(current.sent[0], /(^| )oats inspect --soul dev --skills --dir \/w --json$/);
  assert.match(current.sent[1], /(^| )oats inspect --soul dev --instructions --skills --dir \/w --json$/);
});

test("routed inspect --composed-skills needs a remote that advertises soul-composed-skills: refused before anything is sent, else the flag travels (with --instructions too)", () => {
  const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
  const probe = (features) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.66.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features, operationsApi: 2 });
  const remote = (features) => {
    const sent = [];
    const exec = (bin, argv) => {
      const word = String(argv.at(-1));
      if (word.includes("version --json")) return JSON.stringify(probe(features));
      sent.push(word);
      if (word.includes(" inspect ")) return JSON.stringify({ schemaVersion: 1, ok: true, result: { souls: [{ name: "dev" }] } });
      throw new Error(`unexpected remote call: ${word}`);
    };
    return { sent, exec };
  };
  // A host with --skills and --instructions but not this feature would ignore the flag: refused, nothing sent.
  const old = remote(["operations", "soul-composed-instructions", "soul-skills"]);
  for (const argv of [["--soul", "dev", "--composed-skills"], ["--soul", "dev", "--instructions", "--composed-skills"]]) {
    assert.throws(() => routeCommand("build", "inspect", argv, { server, execFileSync: old.exec }),
      (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /does not advertise soul-composed-skills/.test(e.message) && /nothing was sent/.test(e.message), JSON.stringify(argv));
  }
  assert.deepEqual(old.sent, [], "no inspect was sent to a host without the feature");
  const current = remote(["operations", "soul-composed-instructions", "soul-skills", "soul-composed-skills"]);
  assert.equal(routeCommand("build", "inspect", ["--soul", "dev", "--composed-skills"], { server, execFileSync: current.exec }).envelope.ok, true);
  routeCommand("build", "inspect", ["--soul", "dev", "--instructions", "--composed-skills"], { server, execFileSync: current.exec });
  assert.match(current.sent[0], /(^| )oats inspect --soul dev --composed-skills --dir \/w --json$/);
  assert.match(current.sent[1], /(^| )oats inspect --soul dev --instructions --composed-skills --dir \/w --json$/);
});

// ---- session attach --detach-key (feature session-attach-detach-key, awebai/oats#856) -----------
const DETACH_KEY = "C-\\"; // C-\ : one backslash on argv
const DETACH_FEATURE = "session-attach-detach-key";
const detachRefusal = (version, sshHost) => `remote oats ${version} at ${sshHost} does not advertise ${DETACH_FEATURE}; upgrade it there, or attach without --detach-key; nothing was sent`;
/** The fake ssh's log, one entry per ssh call: its options (everything before `--`), the host and
 *  the one command word the remote shell is given. */
function sshCalls(log) {
  const chunks = readFileSync(log, "utf8").split("\n--\n");
  const calls = [];
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const [host, ...word] = chunks[i + 1].split("\n");
    calls.push({ opts: chunks[i].split("\n"), host, word: word.join("\n") });
  }
  return calls;
}
/** A registered fake host that runs this kernel (`build`), and its environment. */
function detachKeyHost(base) {
  const { bin, log, tools } = fakeBin(base);
  const { dep: repo } = remoteDeployment();
  const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
  const r = oats(env, ["server", "add", "build", "--ssh", "build-host", "--workspace", repo, "--oats", CLI, "--path", tools, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { bin, log, tools, repo, env };
}

test("routed session attach --detach-key: the key travels, one quoted word, only to a host that advertises session-attach-detach-key; a host without it gets the probe alone and the refusal, --print included; a bad key makes no ssh call", () => {
  const base = mkdtempSync("/tmp/oats-servers-dk-"); // short: the control socket path must fit in 104 bytes
  try {
    const { log, tools, repo, env } = detachKeyHost(base);
    const version = oats(env, ["version", "--json"]).json().version;
    assert.ok(KERNEL_FEATURES.includes(DETACH_FEATURE), "this kernel advertises the feature");
    let r = oats(env, ["spawn", "dev", "--server", "build", "--purpose", "dk", "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const home = r.json().result.home;
    const prefix = `PATH=${remoteQuote(tools)}:"$PATH" `;
    const attachWord = (oatsPath, ...flags) => prefix + [oatsPath, "session", "attach", "--home", home, ...flags].map(remoteQuote).join(" ");
    const probeWord = (oatsPath) => `${prefix}${remoteQuote(oatsPath)} version --json`;
    const words = () => sshCalls(log).map((c) => c.word);
    const reset = () => writeFileSync(log, "");
    /** What a shell makes of a printed command line: its words. */
    const shellWords = (line) => execFileSync("/bin/sh", ["-c", `for word in ${line}; do printf '%s\\n' "$word"; done`], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.equal(remoteQuote(DETACH_KEY), "'C-\\'", "C-\\ travels single-quoted");
    assert.ok(attachWord(CLI, "--detach-key", DETACH_KEY).endsWith(` session attach --home ${remoteQuote(home)} --detach-key 'C-\\'`));

    // ---- a host that advertises the feature: this kernel
    // Without a key, --print asks the host nothing (as before this flag existed).
    reset();
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "dev-dk", "--print"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(words(), [], "--print without a key makes no ssh call");
    assert.deepEqual(shellWords(r.stdout.trim()).at(-1), attachWord(CLI), "and prints the attach without the flag");
    // With a key the probe runs under --print too, and the printed word carries the key.
    reset();
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "dev-dk", "--detach-key", DETACH_KEY, "--print"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(words(), [probeWord(CLI)], "with a key, --print probes the host: the version probe, nothing else");
    let printed = shellWords(r.stdout.trim());
    assert.deepEqual(printed.slice(0, 2), ["ssh", "-t"]);
    assert.deepEqual(printed.slice(-3), ["--", "build-host", attachWord(CLI, "--detach-key", DETACH_KEY)]);
    // --detach-key=<key> is the same.
    reset();
    r = oats(env, ["session", "attach", "--server", "build", "--home", home, "--detach-key=F12", "--print"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(words(), [probeWord(CLI)]);
    assert.equal(shellWords(r.stdout.trim()).at(-1), attachWord(CLI, "--detach-key", "F12"));
    // Run: the host gets the probe, then the attach with the key, through ssh -t. The host's own
    // attach reads the flag and goes on to its own refusal (this home was never launched), relayed.
    reset();
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "dev-dk", "--detach-key", DETACH_KEY]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /instance was not launched/, "the host's attach took the key and answered for the home");
    const sent = sshCalls(log);
    assert.deepEqual(sent.map((c) => c.word), [probeWord(CLI), attachWord(CLI, "--detach-key", DETACH_KEY)]);
    assert.equal(sent[1].opts[0], "-t", "the attach is the interactive ssh");
    assert.equal(sent[1].host, "build-host");

    // ---- a host without the feature: this kernel, its version probe answered without the name
    const oldOats = join(base, "old-oats");
    write(oldOats, `#!/bin/sh\nif [ "$1" = version ] && [ "$2" = --json ]; then ${remoteQuote(process.execPath)} ${remoteQuote(CLI)} version --json | sed 's/,"${DETACH_FEATURE}"//'; exit $?; fi\nexec ${remoteQuote(process.execPath)} ${remoteQuote(CLI)} "$@"\n`);
    chmodSync(oldOats, 0o755);
    r = oats(env, ["server", "add", "old", "--ssh", "old-host", "--workspace", repo, "--oats", oldOats, "--path", tools, "--json"]); assert.equal(r.status, 0, r.stderr);
    r = oats(env, ["server", "check", "old", "--json"]);
    assert.deepEqual(r.json().result.remote.features, KERNEL_FEATURES.filter((f) => f !== DETACH_FEATURE), "the old host advertises everything but the detach key");
    const message = detachRefusal(version, "old-host");
    for (const print of [[], ["--print"]]) {
      const what = print.length ? "with --print" : "without --print";
      reset();
      r = oats(env, ["session", "attach", "--server", "old", "--home", home, "--detach-key", DETACH_KEY, ...print, "--json"]);
      assert.equal(r.status, 1, `${what}: ${r.stderr}${r.stdout}`);
      assert.deepEqual(r.json(), { schemaVersion: 1, ok: false, error: { code: "E_REMOTE_INCOMPATIBLE", message, details: { feature: DETACH_FEATURE } } }, what);
      assert.deepEqual(words(), [probeWord(oldOats)], `${what}: the host was sent the version probe and nothing else`);
      reset();
      r = oats(env, ["session", "attach", "--server", "old", "--home", home, "--detach-key", DETACH_KEY, ...print]);
      assert.equal(r.status, 1, what);
      assert.equal(r.stderr, `oats: ${message}\n`, what);
      assert.equal(r.stdout, "", `${what}: no argv is printed for a host that would ignore the flag`);
      assert.deepEqual(words(), [probeWord(oldOats)], what);
    }
    // A name with no saved route here is resolved through the host's roster. With a key the
    // feature is asked first: the host without it gets the probe alone, whether its roster holds
    // the name (dev-dk, whose saved route belongs to the other registration) or not.
    for (const name of ["dev-dk", "not-on-the-roster"]) for (const print of [[], ["--print"]]) {
      const what = `--instance ${name} ${print.join(" ")}`;
      reset();
      r = oats(env, ["session", "attach", "--server", "old", "--instance", name, "--detach-key", DETACH_KEY, ...print, "--json"]);
      assert.equal(r.status, 1, `${what}: ${r.stderr}${r.stdout}`);
      assert.deepEqual(r.json(), { schemaVersion: 1, ok: false, error: { code: "E_REMOTE_INCOMPATIBLE", message, details: { feature: DETACH_FEATURE } } }, what);
      assert.deepEqual(words(), [probeWord(oldOats)], `${what}: the version probe and nothing else, the roster was not read`);
    }
    // Without a key that name is resolved as before, the roster read first and no probe under --print.
    reset();
    r = oats(env, ["session", "attach", "--server", "old", "--instance", "dev-dk", "--print"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(words().length, 1);
    assert.match(words()[0], / status --json --dir /);
    assert.equal(shellWords(r.stdout.trim()).at(-1), attachWord(oldOats));
    // On the advertising host: the probe, then the roster, then the attach with the key.
    reset();
    r = oats(env, ["server", "forget", "build", "--instance", "dev-dk", "--json"]); assert.equal(r.status, 0, r.stderr + r.stdout);
    reset();
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "dev-dk", "--detach-key", DETACH_KEY, "--print"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(words().length, 2, words().join(" | "));
    assert.equal(words()[0], probeWord(CLI));
    assert.match(words()[1], / status --json --dir /);
    assert.equal(shellWords(r.stdout.trim()).at(-1), attachWord(CLI, "--detach-key", DETACH_KEY));
    // Without a key that host is attached as before: nothing is asked of it under --print.
    reset();
    r = oats(env, ["session", "attach", "--server", "old", "--home", home, "--print"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(words(), []);
    assert.equal(shellWords(r.stdout.trim()).at(-1), attachWord(oldOats));

    // ---- a bad key: refused here, before any ssh, also when the name would be resolved through the host's roster
    const addresses = [["--home", home], ["--instance", "dev-dk"], ["--instance", "no-saved-route"]];
    const badKeys = [
      [["--detach-key", "C-i"], /^--detach-key must be one key: C-<a letter except h, i and m, or one of .* \(got "C-i"\)$/],
      [["--detach-key", "C-h"], /^--detach-key must be one key: .* \(got "C-h"\)$/],
      [["--detach-key", "C-]; kill-server"], /^--detach-key must be one key: .* \(got "C-\]; kill-server"\)$/],
      [["--detach-key", "C-b d"], /\(got "C-b d"\)$/],
      [["--detach-key"], /^--detach-key needs a value$/],
      [["--detach-key", "--print"], /^--detach-key needs a value$/],
      [["--detach-key="], /^--detach-key= needs a value$/],
    ];
    for (const address of addresses) for (const [flags, expected] of badKeys) for (const print of [[], ["--print"]]) {
      const argv = ["session", "attach", "--server", "build", ...address, ...flags, ...(flags.includes("--print") ? [] : print)];
      reset();
      r = oats(env, [...argv, "--json"]);
      assert.equal(r.status, 1, argv.join(" "));
      assert.equal(r.json().error.code, "E_BAD_ARGS", argv.join(" "));
      assert.match(r.json().error.message, expected, argv.join(" "));
      assert.deepEqual(words(), [], `no ssh call: ${argv.join(" ")}`);
    }
    reset();
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "no-saved-route", "--detach-key", "C-m"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^oats: --detach-key must be one key: /);
    assert.deepEqual(words(), []);
    // The same name with a key the grammar admits is resolved through the roster, as without a key.
    r = oats(env, ["session", "attach", "--server", "build", "--instance", "no-saved-route", "--detach-key", DETACH_KEY, "--json"]);
    assert.equal(r.json().error.code, "E_SNAPSHOT_UNKNOWN");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("routed session attach relays the host's status: 20 (left by the detach key), also when SIGQUIT reaches this process while ssh is ending; on ssh's own 255 the reattach line carries the key, and without a key it is the line it always was", () => {
  const base = mkdtempSync("/tmp/oats-servers-dk-");
  try {
    const { bin, log, env: hostEnv } = detachKeyHost(base);
    // An ssh in front of the fixture's: it answers every command as the fixture does (this kernel
    // is the host), except the attach, which it ends itself with $FAKE_ATTACH_STATUS. With
    // $FAKE_QUIT_SENT it first sends SIGQUIT to its parent, the routed `oats`, and records that
    // the signal was sent: the QUIT a second press of C-\ raises once ssh has given the tty back.
    const front = join(base, "front");
    write(join(front, "ssh"), `#!/bin/sh
printf '%s\\n' "$@" >> ${remoteQuote(log)}
printf -- '--\\n' >> ${remoteQuote(log)}
while [ "$1" != "--" ]; do shift; done
shift; shift
case "$1" in
  *" session attach "*)
    if [ -n "$FAKE_QUIT_SENT" ]; then kill -QUIT "$PPID" && : > "$FAKE_QUIT_SENT"; fi
    exit "$FAKE_ATTACH_STATUS" ;;
esac
exec sh -c "$1"
`);
    chmodSync(join(front, "ssh"), 0o755);
    const home = "/srv/team/agents/dev/instances/dev-dk";
    const attach = (extra, more = {}) => {
      writeFileSync(log, "");
      const r = spawnSync(process.execPath, [CLI, "session", "attach", "--server", "build", "--home", home, ...extra], { encoding: "utf8", cwd: hostEnv.HOME, env: { ...hostEnv, PATH: `${front}:${bin}`, ...more } });
      if (r.error) throw r.error;
      const sent = sshCalls(log).map((c) => c.word);
      assert.equal(sent.length, 2, `the probe, then the attach: ${sent.join(" | ")}`);
      assert.match(sent[0], / version --json$/);
      return { ...r, attachWord: sent[1] };
    };
    const keyed = ["--detach-key", DETACH_KEY];

    // The host's attach ended by its detach key: 20, relayed.
    let r = attach(keyed, { FAKE_ATTACH_STATUS: "20" });
    assert.ok(r.attachWord.endsWith(` session attach --home ${home} --detach-key 'C-\\'`), r.attachWord);
    assert.equal(r.status, 20, r.stderr);
    assert.equal(r.signal, null);
    assert.equal(r.stderr, "", "a relayed 20 is not an ssh failure: nothing is said");
    // The same, with SIGQUIT sent to this `oats` by the ssh under it just before that ssh exits 20.
    // With a key the routed CLI holds SIGQUIT, so the host's status is still what it answers.
    // (Without a key nothing listens and the same signal ends Node by its default action, 131 in a
    // shell: not run here, it would leave a core dump on a host configured to keep them.)
    const quitSent = join(base, "quit-sent");
    r = attach(keyed, { FAKE_ATTACH_STATUS: "20", FAKE_QUIT_SENT: quitSent });
    assert.equal(existsSync(quitSent), true, "the fake ssh sent SIGQUIT to the routed oats");
    assert.equal(r.signal, null, "SIGQUIT did not end the routed oats");
    assert.equal(r.status, 20, r.stderr);
    // A status other than 20 is relayed as it is, QUIT or not: the listener decides nothing.
    r = attach(keyed, { FAKE_ATTACH_STATUS: "0", FAKE_QUIT_SENT: quitSent });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.signal, null);
    r = attach(keyed, { FAKE_ATTACH_STATUS: "1" });
    assert.equal(r.status, 1, r.stderr);

    // ssh's own failure under the viewer: 255, and the line that says how to reattach.
    const lost = `\noats: ssh to build-host ended with an error (exit 255); if the link was lost, the instance keeps running on build. Reattach with: oats session attach --server build --home ${home}`;
    r = attach([], { FAKE_ATTACH_STATUS: "255" });
    assert.ok(r.attachWord.endsWith(` session attach --home ${home}`), r.attachWord);
    assert.equal(r.status, 255);
    assert.equal(r.stderr, `${lost}\n`, "without a key: the line as it was before the flag existed");
    r = attach(keyed, { FAKE_ATTACH_STATUS: "255" });
    assert.equal(r.status, 255);
    assert.equal(r.stderr, `${lost} --detach-key 'C-\\'\n`, "with a key: the reattach command keeps it, quoted for a shell");
    r = attach(["--detach-key", "F12"], { FAKE_ATTACH_STATUS: "255" });
    assert.equal(r.status, 255);
    assert.equal(r.stderr, `${lost} --detach-key F12\n`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("attachArgv with a detach key: validated before anything is asked of the host; the probe runs even where the version check is skipped; a host without the feature is refused on the probe alone, also one without the session commands", () => {
  const server = { id: "build", sshHost: "h", workspace: "/w", oatsPath: "oats" };
  const home = "/srv/dk/agents/dev/instances/dev-dk";
  const probe = (features, remote) => ({ schemaVersion: 1, name: "@awebai/oats", version: "0.50.0", desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote, features });
  /** A host: every remote command word it was sent, the version probe included. Its roster, when
   *  it has one, holds the instance dev-dk at `home`. */
  const host = (features, remote = ["spawn", "status", "session"], { roster = false } = {}) => {
    const sent = [];
    const exec = (bin, argv) => {
      const word = String(argv.at(-1));
      sent.push(word);
      if (word.includes("version --json")) return JSON.stringify(probe(features, remote));
      if (roster && word.includes("status --json")) return JSON.stringify({ root: "/srv/dk/agents", agents: [{ name: "dev", instances: [{ instance: "dev-dk", home }] }] });
      throw new Error(`unexpected remote call: ${word}`);
    };
    return { sent, io: { server, execFileSync: exec } };
  };
  const ROSTER = "oats status --json --dir /w";
  const PROBE = "oats version --json";
  const plainWord = `oats session attach --home ${home}`;
  const keyedWord = `${plainWord} --detach-key 'C-\\'`;

  // A value outside the grammar: E_BAD_ARGS, and the host is never called, with a home or with a
  // name that only the host's roster could resolve.
  for (const bad of ["C-h", "C-i", "C-m", "C-[", "C-]; kill-server", "C-b d", "C-a\n", "c-a", "Any", "", true, null, 12]) {
    for (const address of [{ home }, { instance: "no-saved-route" }]) for (const skipVersionCheck of [false, true]) {
      const h = host([DETACH_FEATURE]);
      assert.throws(() => attachArgv("build", { ...address, detachKey: bad }, { ...h.io, skipVersionCheck }),
        (e) => e.code === "E_BAD_ARGS" && e.message.startsWith("--detach-key must be one key: ") && e.message.endsWith(`(got ${JSON.stringify(bad)})`), JSON.stringify(bad));
      assert.deepEqual(h.sent, [], `no call for ${JSON.stringify(bad)}`);
    }
  }
  // A host that advertises the feature: the key is appended, quoted with the rest; one probe.
  for (const skipVersionCheck of [false, true]) {
    const h = host(["operations", DETACH_FEATURE]);
    const att = attachArgv("build", { home, detachKey: DETACH_KEY }, { ...h.io, skipVersionCheck });
    assert.deepEqual(att.argv.slice(0, 2), ["ssh", "-t"]);
    assert.equal(att.argv.at(-1), keyedWord);
    assert.equal(att.home, home);
    assert.deepEqual(h.sent, [PROBE], `skipVersionCheck ${skipVersionCheck}: the probe always runs with a key`);
    const f12 = attachArgv("build", { home, detachKey: "S-F12" }, { ...h.io, skipVersionCheck });
    assert.equal(f12.argv.at(-1), `${plainWord} --detach-key S-F12`);
  }
  // --no-status-line travels as it is, with or without a key: a host that does not know it
  // ignores it and shows its status line, so it asks no probe of its own.
  let h = host(["operations", DETACH_FEATURE]);
  assert.equal(attachArgv("build", { home, statusLine: false }, { ...h.io, skipVersionCheck: true }).argv.at(-1), `${plainWord} --no-status-line`);
  assert.deepEqual(h.sent, [], "no probe for it");
  assert.equal(attachArgv("build", { home, detachKey: DETACH_KEY, statusLine: false }, { ...h.io, skipVersionCheck: true }).argv.at(-1), `${keyedWord} --no-status-line`);
  // Without a key nothing changes: no probe where the version check is skipped, the same word.
  h = host(["operations", DETACH_FEATURE]);
  assert.equal(attachArgv("build", { home }, { ...h.io, skipVersionCheck: true }).argv.at(-1), plainWord);
  assert.deepEqual(h.sent, []);
  h = host(["operations"]);
  assert.equal(attachArgv("build", { home }, h.io).argv.at(-1), plainWord, "a host without the feature is attached without a key as before");
  assert.deepEqual(h.sent, [PROBE]);
  // A host without the feature: refused on the probe, nothing else sent.
  const refused = (e) => {
    assert.equal(e.code, "E_REMOTE_INCOMPATIBLE");
    assert.equal(e.message, detachRefusal("0.50.0", "h"));
    assert.deepEqual(e.details, { feature: DETACH_FEATURE });
    return true;
  };
  for (const skipVersionCheck of [false, true]) {
    h = host(["operations", "session-attach"]);
    assert.throws(() => attachArgv("build", { home, detachKey: DETACH_KEY }, { ...h.io, skipVersionCheck }), refused);
    assert.deepEqual(h.sent, [PROBE], `skipVersionCheck ${skipVersionCheck}`);
    // A name with no saved route here would be resolved through the host's roster: with a key the
    // feature is asked first, so the host without it is sent the probe and never the roster read,
    // whether or not its roster holds the name.
    for (const name of ["dev-dk", "not-on-the-roster"]) {
      h = host(["operations"], undefined, { roster: true });
      assert.throws(() => attachArgv("build", { instance: name, detachKey: DETACH_KEY }, { ...h.io, skipVersionCheck }), refused, name);
      assert.deepEqual(h.sent, [PROBE], `${name}, skipVersionCheck ${skipVersionCheck}`);
    }
    // A host with the feature: the probe, once, then the roster; the name it holds is attached
    // with the key, and one it does not hold is unknown as it is without a key.
    h = host([DETACH_FEATURE], undefined, { roster: true });
    assert.equal(attachArgv("build", { instance: "dev-dk", detachKey: DETACH_KEY }, { ...h.io, skipVersionCheck }).argv.at(-1), keyedWord);
    assert.deepEqual(h.sent, [PROBE, ROSTER], `skipVersionCheck ${skipVersionCheck}`);
    h = host([DETACH_FEATURE], undefined, { roster: true });
    assert.throws(() => attachArgv("build", { instance: "not-on-the-roster", detachKey: DETACH_KEY }, { ...h.io, skipVersionCheck }), (e) => e.code === "E_SNAPSHOT_UNKNOWN");
    assert.deepEqual(h.sent, [PROBE, ROSTER]);
    // Without a key the roster is read first, as before, and the probe only where it always was.
    h = host(["operations"], undefined, { roster: true });
    assert.equal(attachArgv("build", { instance: "dev-dk" }, { ...h.io, skipVersionCheck }).argv.at(-1), plainWord);
    assert.deepEqual(h.sent, skipVersionCheck ? [ROSTER] : [ROSTER, PROBE]);
    // A host that has neither the feature nor the session commands gets the same refusal: the
    // roster read behind the older refusal's hint is not sent.
    h = host([], ["spawn", "status"]);
    assert.throws(() => attachArgv("build", { home, detachKey: DETACH_KEY }, { ...h.io, skipVersionCheck }), refused);
    assert.deepEqual(h.sent, [PROBE], `no session commands, skipVersionCheck ${skipVersionCheck}`);
  }
});
