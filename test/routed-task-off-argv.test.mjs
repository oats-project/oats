// A routed spawn's task text never travels on a command line (awebai/oats#1788): not in the
// argv of the local ssh process, and not in the remote command line that ssh carries. It goes to
// the host on the ssh session's standard input, to its preview and to its apply alike, and the
// host reads it there (`--task-file -`, feature spawn-task-stdin). A host that does not advertise
// the feature is refused before any spawn is sent.
// The end-to-end test runs the real kernel behind a fake `ssh` that records how it was called.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeBin } from "./helpers/fake-ssh.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { routeCommand } from "../lib/servers.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const FEATURE = "spawn-task-stdin";

test("a routed spawn with a task: neither the ssh argv nor the remote command holds any of the task, in the preview or in the apply, and the instance on the host has it", (t) => {
  const base = mkdtempSync("/tmp/oats-rto-"); // short: the control socket path must fit in 104 bytes
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fx = v2Deployment({ souls: { dev: { soul: { work: "checkout" }, agents: "You are dev.\n" } } });
  t.after(fx.cleanup);
  const { bin, log, tools } = fakeBin(base);
  const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
  const oats = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: env.HOME });
    if (r.error) throw r.error;
    return r;
  };
  let r = oats(["server", "add", "build", "--ssh", "build-host", "--workspace", fx.dep, "--oats", CLI, "--path", tools, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);

  /** The remote commands of the spawns the fake ssh has run since `from` (a length of its log). */
  const spawnsSince = (from) => readFileSync(log, "utf8").slice(from).split("\n--\n").map((call) => call.split("\n").at(-1)).filter((command) => command.includes(" spawn "));
  const cases = [
    { purpose: "from-file", token: "ZEBRA-FILE-7f3a9", flags: (task) => { const file = join(base, "task.md"); writeFileSync(file, task); return ["--task-file", file]; } },
    { purpose: "inline", token: "ZEBRA-INLINE-51c2e", flags: (task) => ["--task", task] },
  ];
  for (const { purpose, token, flags } of cases) {
    const task = `Review \`this\` and $(touch NEVER_RUN) 'quotes'\nthe ${token} line\n`;
    const from = readFileSync(log, "utf8").length;
    r = oats(["spawn", "dev", "--server", "build", "--purpose", purpose, ...flags(task), "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const recorded = readFileSync(log, "utf8").slice(from);
    assert.equal(recorded.includes(token), false, `${purpose}: the task is in no argument of ssh, the remote command included`);
    assert.equal(recorded.includes("NEVER_RUN"), false, `${purpose}: no other part of the task is there either`);
    const spawns = spawnsSince(from);
    assert.equal(spawns.length, 2, `${purpose}: a preview and an apply\n${spawns.join("\n")}`);
    assert.ok(spawns[0].includes(" --preview ") && !spawns[1].includes(" --preview "), spawns.join("\n"));
    for (const command of spawns) assert.ok(command.includes(" --task-file - "), `${purpose}: the host is told to read the task from its standard input: ${command}`);
    const home = JSON.parse(r.stdout).result.home;
    assert.equal(home, join(fx.dep, "agents", "dev", "instances", `dev-${purpose}`));
    assert.equal(readFileSync(join(home, "TASK.md"), "utf8").includes(task.trim()), true, `${purpose}: the instance on the host has the task, byte for byte`);
    assert.equal(existsSync(join(env.HOME, "NEVER_RUN")), false);
  }
});

/** A host that answers the probe with `features`, a roster, and a spawn's preview and apply.
 *  `calls` is every ssh call it saw: its argv, and the bytes given to its standard input. */
function fakeHost(features, { keyed = true, version = "0.69.15" } = {}) {
  const KEYED = keyed ? ["spawn-preview-2", "spawn-apply-2", "spawn-idempotency-2"] : [];
  const probe = { schemaVersion: 1, name: "@awebai/oats", version, desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "status"], features: [...KEYED, ...features] };
  const status = { schemaVersion: 1, ok: true, result: { root: "/w/agents", agents: [{ name: "dev", harness: "pi", instances: [] }] } };
  const decision = { instance: "dev-1", revision: "0123456789abcdef01234567" };
  const preview = { schemaVersion: 1, ok: true, result: { spawnPreviewApi: 2, preview: true, agent: "dev", instance: "dev-1", home: "/w/agents/dev/instances/dev-1", decision } };
  const apply = { schemaVersion: 1, ok: true, result: { instance: "dev-1", agent: "dev", home: "/w/agents/dev/instances/dev-1", launched: false, warnings: [], decision, replayed: false } };
  const calls = [];
  const exec = (bin, argv, options) => {
    const command = String(argv.at(-1));
    calls.push({ argv: [bin, ...argv], command, input: options.input === undefined ? undefined : Buffer.from(options.input).toString("utf8") });
    if (command.includes("version --json")) return JSON.stringify(probe);
    if (command.includes(" status ")) return JSON.stringify(status);
    if (command.includes(" spawn ")) return JSON.stringify(command.includes("--preview") ? preview : apply);
    throw new Error(`unexpected remote call: ${command}`);
  };
  return { calls, exec };
}
/** routeCommand with its snapshots under a directory of the test's own. */
function routed(t, args, host) {
  const base = mkdtempSync("/tmp/oats-rto-");
  const prior = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = join(base, "oats-home"); mkdirSync(process.env.OATS_HOME_DIR);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  try { return routeCommand("build", "spawn", args, { server: { id: "build", sshHost: host.sshHost || "h", workspace: "/w", oatsPath: "oats" }, execFileSync: host.exec }); }
  finally { if (prior === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = prior; }
}

test("both routing refusals keep the upgrade command within Desktop's first 300 characters", (t) => {
  for (const host of [fakeHost([], { keyed: false, version: "0.69.14" }), fakeHost([], { keyed: false })]) {
    host.sshHost = "user@a-long-host-name.example.internal";
    assert.throws(() => routed(t, ["dev", "--task", "ZEBRA-MUST-NOT-LEAK"], host), (e) => {
      assert.equal(e.code, "E_REMOTE_INCOMPATIBLE");
      assert.ok(e.message.slice(0, 300).includes("npm install -g @awebai/oats@latest"), e.message);
      assert.ok(e.message.includes(`at ${host.sshHost}`));
      if (e.message.includes(FEATURE)) {
        assert.ok(e.message.indexOf("npm install -g @awebai/oats@latest") < e.message.indexOf(FEATURE), "the upgrade command precedes the missing-feature detail");
      }
      return true;
    });
    assert.equal(host.calls.length, 1);
  }
});

test("a high-version host missing a required spawn feature is refused before any spawn", (t) => {
  const required = [FEATURE, "spawn-preview-2", "spawn-apply-2", "spawn-idempotency-2"];
  for (const missing of required) {
    for (const extra of [[], ["--preview"], ["--expect-decision", "r1", "--idempotency-key", "k1"]]) {
      const host = fakeHost(required.filter((f) => f !== missing), { keyed: false, version: "99.0.0" });
      assert.throws(() => routed(t, ["dev", "--task", "ZEBRA-MUST-NOT-LEAK", ...extra], host), (e) => {
        assert.equal(e.code, "E_REMOTE_INCOMPATIBLE");
        assert.ok(e.message.includes(missing), e.message);
        assert.ok(e.message.includes("npm install -g @awebai/oats@latest"), e.message);
        return true;
      });
      assert.equal(host.calls.some((call) => call.command.includes(" spawn ")), false);
      assert.equal(host.calls.some((call) => call.argv.join(" ").includes("ZEBRA")), false);
    }
  }
});

test("a routed spawn gives the host's preview and its apply the same task on standard input, and no other call any input", (t) => {
  const host = fakeHost([FEATURE]);
  const task = "the ZEBRA-ROUTE-93d1b task\n";
  const { envelope } = routed(t, ["dev", "--task", task, "--no-launch"], host);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  for (const call of host.calls) assert.equal(call.argv.join("\n").includes("ZEBRA"), false, `the task is in no argument: ${call.command}`);
  const spawns = host.calls.filter((call) => call.command.includes(" spawn "));
  assert.equal(spawns[0].command, "oats spawn dev --task-file - --no-launch --preview --dir /w --json");
  assert.match(spawns[1].command, /^oats spawn dev --task-file - --no-launch --expect-decision 0123456789abcdef01234567 --idempotency-key \S+ --dir \/w --json$/);
  assert.deepEqual(spawns.map((call) => call.input), [task, task], "the preview and the apply read the same task");
  assert.deepEqual(host.calls.filter((call) => !call.command.includes(" spawn ")).map((call) => call.input), [undefined, undefined], "the probe and the roster read are given nothing");
});

test("a host below the routing floor is refused with the upgrade command before any spawn", (t) => {
  for (const version of ["0.22.1", "0.69.14"]) {
    const host = fakeHost([FEATURE], { version });
    assert.throws(() => routed(t, ["dev", "--task", "ZEBRA-OLD-HOST", "--no-launch"], host), (e) => {
      assert.equal(e.code, "E_REMOTE_INCOMPATIBLE");
      assert.ok(e.message.includes(`remote oats ${version} at h`));
      assert.ok(e.message.includes("minimum 0.69.15"));
      assert.ok(e.message.includes("npm install -g @awebai/oats@latest"));
      return true;
    });
    assert.equal(host.calls.length, 1, "only the version probe is sent");
    assert.equal(host.calls.some((call) => call.argv.join(" ").includes("ZEBRA")), false);
  }
});

test("a host missing stdin or keyed spawn is refused even when no task is given", (t) => {
  for (const host of [fakeHost([]), fakeHost([FEATURE], { keyed: false })]) {
    assert.throws(() => routed(t, ["dev", "--no-launch"], host), { code: "E_REMOTE_INCOMPATIBLE" });
    assert.equal(host.calls.length, 1);
  }
});

test("a routed spawn through a host without spawn-task-stdin refuses without sending the task or creating an instance", (t) => {
  const base = mkdtempSync("/tmp/oats-rto-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const fx = v2Deployment({ souls: { dev: { soul: { work: "checkout" }, agents: "You are dev.\n" } } });
  t.after(fx.cleanup);
  const { bin, log, tools } = fakeBin(base);
  // The host's oats: this kernel, its probe answered without the feature.
  const older = join(base, "older-oats");
  writeFileSync(older, `#!/bin/sh\nif [ "$1" = version ]; then node '${CLI}' "$@" | sed 's/,"${FEATURE}"//'; else exec node '${CLI}' "$@"; fi\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|PI_AGENT)/.test(k)) delete env[k];
  const oats = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: env.HOME });
  let r = oats(["server", "add", "build", "--ssh", "build-host", "--workspace", fx.dep, "--oats", older, "--path", tools, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const from = readFileSync(log, "utf8").length;
  const task = "the ZEBRA-OLDER-E2E-6d0f3 task\n";
  r = oats(["spawn", "dev", "--server", "build", "--purpose", "older", "--task", task, "--no-launch", "--json"]);
  assert.notEqual(r.status, 0, r.stderr + r.stdout);
  const error = JSON.parse(r.stdout).error;
  assert.equal(error.code, "E_REMOTE_INCOMPATIBLE");
  assert.ok(error.message.includes(FEATURE));
  assert.ok(error.message.includes("npm install -g @awebai/oats@latest"));
  const recorded = readFileSync(log, "utf8").slice(from);
  assert.equal(recorded.includes(" spawn "), false, "no spawn was sent to the host");
  assert.equal(recorded.includes("ZEBRA"), false, "the task is in no ssh argument");
  assert.equal(existsSync(join(fx.dep, "agents", "dev", "instances", "dev-older")), false);
});
