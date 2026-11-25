// OATS_NODE_BIN (awebai/oats#997): the kernel hands every hook, provider check and dispatched
// command the node to write into anything that outlives the process, by the one rule of
// lib/stable-node.mjs (a Homebrew keg's opt link, else the same node on PATH, else the path as it
// is, with a warning). oats.core writes it into the Claude Code waiting hooks of a home.
//
// The kernel runs in this process, so the node "running the kernel" is process.execPath, set here
// to a fake that still runs (a script that execs the real node): what the kernel starts with it works.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RESERVED_LAUNCH_ENV, lifecycleHookEnv, planLaunch, resolvedFromHome, restartInstanceSession, startInstanceSession, validateLaunchConfig } from "../lib/core.mjs";
import * as H from "../lib/schedule-host.mjs";
import { kernelNode, stableNode, unitPathEntries } from "../lib/stable-node.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { isolateSessionEnvironment, oatsSocket, waitUntil } from "./helpers/host-fixture.mjs";

const REAL_NODE = process.execPath;
const KERNEL_BIN = realpathSync(resolve(new URL("../bin/oats.mjs", import.meta.url).pathname));
const CAP = resolve(new URL("../oats-package/capabilities/oats-core", import.meta.url).pathname);
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-stable-node-")));
const session = "n";
const restoreEnvironment = isolateSessionEnvironment(base);
const socket = oatsSocket(); // the fixture's own `oats` server: where the kernel creates windows
const tmux = (...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
test.after(() => { process.execPath = REAL_NODE; try { tmux("kill-server"); } catch { /* gone */ } finally { restoreEnvironment(); rmSync(base, { recursive: true, force: true }); } });
function write(p, c, mode) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); if (mode) chmodSync(p, mode); return p; }
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

let n = 0;
/** A node that runs, at a path of the test's choosing. */
const fakeNode = (path) => write(path, `#!/bin/sh\nexec ${shq(REAL_NODE)} "$@"\n`, 0o755);
/** A Homebrew-shaped prefix: <prefix>/Cellar/node/<version>/bin/node, and opt/node -> that keg. */
function brew() {
  const prefix = join(base, `brew-${++n}`);
  const node = fakeNode(join(prefix, "Cellar", "node", "22.1.0", "bin", "node"));
  mkdirSync(join(prefix, "opt"));
  symlinkSync(join("..", "Cellar", "node", "22.1.0"), join(prefix, "opt", "node"));
  return { prefix, node, opt: join(prefix, "opt", "node", "bin", "node") };
}
/** A node in a directory of its own, on no PATH: the rule has no stable answer for it. */
const loose = () => fakeNode(join(base, `loose-${++n}`, "node"));
/** Run `fn` as a kernel whose node is `node`. */
async function asKernel(node, fn) {
  const saved = process.execPath;
  process.execPath = node;
  try { return await fn(); } finally { process.execPath = saved; }
}
const NOT_STABLE = (node) => `the node path ${node} is not stable (no Homebrew opt link and no node on PATH resolves to it)`;
const HOME_WARNING = (node) => `${NOT_STABLE(node)}: what this home's hooks record with it stops working when it goes away; install a node with a stable path and restart the instance`;
const unstable = (warnings) => (warnings || []).filter((w) => /not stable/.test(w));

// A harness that records its pid, then idles (an `exec`ed sleep: the session never reads as a shell).
const binDir = join(base, "bin");
const probe = write(join(binDir, "probe"), `#!/bin/sh\n[ "$1" = --version ] && { echo '2.1.308 (Claude Code)'; exit 0; }\necho $$ > "$OATS_INSTANCE_HOME/pid.txt"\nexec sleep 86400\n`, 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

// oats.core as every copy before this change wrote it: the hook's own node, whatever the kernel hands it.
const current = readFileSync(join(CAP, "bin", "oats-core.mjs"), "utf8");
const READS_VARIABLE = /^ {2}const node = typeof env\.OATS_NODE_BIN .*$/m;
assert.match(current, READS_VARIABLE, "oats.core reads OATS_NODE_BIN on one line");
const earlier = join(base, "oats-core-earlier");
cpSync(CAP, earlier, { recursive: true });
writeFileSync(join(earlier, "bin", "oats-core.mjs"), current.replace(READS_VARIABLE, "  const node = process.execPath;"));

// A provider command that answers the two paths the kernel handed it.
const show = `console.log(JSON.stringify({ schemaVersion: 1, ok: true, result: { node: process.env.OATS_NODE_BIN ?? null, cli: process.env.OATS_CLI_BIN ?? null } }));\n`;
const fx = v2Deployment({
  souls: { dev: { soul: { capabilities: { "oats.core": { from: "here" }, "test.paths": { from: "here" } } } } },
  capabilityDirs: { "oats-core": earlier },
  capabilities: { "test.paths": { manifest: { command: "paths", commands: { show: "show.mjs" } }, files: { "show.mjs": show } } },
  local: { "launch-configs": { probe: { harness: "claude", executable: probe }, piprobe: { harness: "pi", executable: probe } } },
});
test.after(() => fx.cleanup());

/** A spawned home, not launched, pointed at the private tmux socket as a started home would be. */
async function spawnHome(name, { launchConfig = "probe", ...opts } = {}) {
  const spawned = await fx.spawn("dev", { name, work: "checkout", launch: false, launchConfig, ...opts });
  if (opts.preview) return spawned;
  const { home } = spawned;
  const meta = { ...readJson(join(home, "instance.json")), tmux: { session, window: name, socket }, launched: true };
  write(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
  const baselinePath = join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
  write(baselinePath, JSON.stringify({ ...readJson(baselinePath), runtime: { launched: true, tmux: { session, window: name, socket } } }, null, 2) + "\n");
  return spawned;
}
/** The node and the CLI every waiting hook of a home names: `… <action> '<node>' '<cli>' '<marker>' '<home>' >/dev/null 2>&1; exit 0`. */
function baked(home) {
  const commands = Object.values(readJson(join(home, ".claude", "settings.json")).hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((e) => e.command)));
  assert.equal(commands.length, 15, "oats.core's fifteen entries, and no second copy of any");
  const pairs = commands.map((c) => { const m = / '([^']+)' '([^']+)' '[^']*' '[^']*' >\/dev\/null 2>&1; exit 0$/.exec(c); assert.ok(m, c); return `${m[1]} ${m[2]}`; });
  assert.equal(new Set(pairs).size, 1, `every command names one node and one CLI: ${[...new Set(pairs)].join(" | ")}`);
  const [node, cli] = pairs[0].split(" ");
  return { node, cli };
}

test("the rule states the fact and its caller words the consequence; the unit's sentence is what it was", () => {
  const node = loose();
  assert.deepEqual(stableNode({ execPath: node, envPath: "/usr/bin" }), { node, warning: NOT_STABLE(node) });
  assert.deepEqual(stableNode({ execPath: node, envPath: "/usr/bin", consequence: "X stops", remedy: "do Y" }),
    { node, warning: `${NOT_STABLE(node)}: X stops; install a node with a stable path and do Y` });
  // The host timer's unit (#916): byte for byte, through both of schedule-host's own entries.
  const unit = `the node path ${node} is not stable (no Homebrew opt link and no node on PATH resolves to it): the timer stops when it goes away; install a node with a stable path and run \`oats schedule host install\` again`;
  assert.deepEqual(H.stableNode({ execPath: node, envPath: "/usr/bin" }), { node, warning: unit });
  assert.deepEqual(H.hostUnitPlan({ execPath: node, envPath: "/usr/bin" }).warnings, [unit]);
  assert.equal(H.unitPathEntries, unitPathEntries, "one filter of the PATH, not two");
  // One rule: the unit's node and the kernel's are the same answer for the same node and PATH.
  const keg = brew();
  assert.deepEqual(H.stableNode({ execPath: keg.node, envPath: "/usr/bin" }), stableNode({ execPath: keg.node, envPath: "/usr/bin" }));
});

test("the kernel's node: the rule on its own execPath and PATH, computed once for them", async () => {
  const keg = brew();
  await asKernel(keg.node, () => {
    const answer = kernelNode();
    assert.deepEqual(answer, { node: keg.opt });
    // Not read again while the kernel runs with the same node and PATH: the opt link may go, the answer stays.
    rmSync(join(keg.prefix, "opt", "node"));
    assert.equal(kernelNode(), answer);
  });
  const node = loose();
  await asKernel(node, () => assert.deepEqual(kernelNode(), { node, warning: HOME_WARNING(node) }));
  // The PATH is the kernel process's own, without the entries inside an instance home and inside a keg.
  const noOpt = brew(); rmSync(join(noOpt.prefix, "opt", "node"));
  const home = join(base, "an-instance-home"), tools = join(home, "tools"), outside = join(base, `links-${++n}`);
  for (const dir of [tools, outside]) { mkdirSync(dir, { recursive: true }); symlinkSync(noOpt.node, join(dir, "node")); }
  const saved = { PATH: process.env.PATH, home: process.env.OATS_INSTANCE_HOME };
  try {
    process.env.OATS_INSTANCE_HOME = home;
    process.env.PATH = `${tools}:${dirname(noOpt.node)}:${saved.PATH}`;
    await asKernel(noOpt.node, () => assert.deepEqual(kernelNode(), { node: noOpt.node, warning: HOME_WARNING(noOpt.node) }, "a node inside the home, and the keg's own bin, are not stable paths"));
    process.env.PATH = `${tools}:${dirname(noOpt.node)}:${outside}:${saved.PATH}`;
    await asKernel(noOpt.node, () => assert.deepEqual(kernelNode(), { node: join(outside, "node") }));
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.home === undefined) delete process.env.OATS_INSTANCE_HOME; else process.env.OATS_INSTANCE_HOME = saved.home;
  }
});

test("OATS_NODE_BIN is a kernel name: reserved for a launch, authored by the kernel for every hook", async () => {
  assert.ok(RESERVED_LAUNCH_ENV.has("OATS_NODE_BIN"));
  assert.throws(() => validateLaunchConfig("mine", { harness: "claude", env: { OATS_NODE_BIN: "/usr/bin/node" } }), (e) => e.code === "E_LAUNCH_CONFIG_INVALID" && e.message.includes("OATS_NODE_BIN"));
  const keg = brew();
  const saved = process.env.OATS_NODE_BIN;
  process.env.OATS_NODE_BIN = "/poison/from-the-ambient-environment";
  try {
    await asKernel(keg.node, () => {
      for (const event of ["soul-scaffold", "spawn", "launch", "retire", "worktree"]) {
        const env = lifecycleHookEnv(event, { id: "test.any" }, { home: join(base, "h"), instance: "dev-1", agentName: "dev", contextDir: base, rootDir: join(base, "agents"), resolved: {}, extraEnv: { OATS_NODE_BIN: "/poison/from-extra-env" } });
        assert.equal(env.OATS_NODE_BIN, keg.opt, event);
        assert.equal(env.OATS_CLI_BIN, KERNEL_BIN, event);
      }
    });
  } finally { if (saved === undefined) delete process.env.OATS_NODE_BIN; else process.env.OATS_NODE_BIN = saved; }
});

test("a dispatched command receives OATS_NODE_BIN beside OATS_CLI_BIN, from the kernel and never from its caller", () => {
  // The CLI is its own process here, run by the real node on the fixture's PATH: the rule's answer for those.
  const expected = stableNode({ execPath: REAL_NODE, envPath: fx.env.PATH, instanceHome: undefined }).node;
  const r = fx.cli(["paths", "show", "--soul", "dev", "--json"], { env: { OATS_NODE_BIN: "/poison/from-the-caller" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json().result, { node: expected, cli: KERNEL_BIN });
});

test("a kernel run from a Homebrew keg: a spawn's hooks name the opt link, and neither a spawn nor a start warns", { timeout: 180_000 }, async () => {
  // The deployment's oats.core is this repository's from here on; a home spawned before keeps its copy.
  const before = await spawnHome("earlier-copy");
  fx.commit({ "capabilities/oats-core/bin/oats-core.mjs": current }, "oats.core reads OATS_NODE_BIN");
  const keg = brew();
  const spawned = await asKernel(keg.node, () => spawnHome("from-a-keg"));
  assert.deepEqual(baked(spawned.home), { node: keg.opt, cli: KERNEL_BIN }, "the opt link, never the versioned keg");
  assert.equal(execFileSync(baked(spawned.home).node, ["-p", "1 + 1"], { encoding: "utf8" }).trim(), "2", "and it is a node that runs");
  assert.deepEqual(unstable(spawned.warnings), []);
  const started = await asKernel(keg.node, () => startInstanceSession(spawned.home));
  await waitUntil(() => existsSync(join(spawned.home, "pid.txt")), "the harness to start");
  assert.deepEqual(unstable(started.warnings), []);
  assert.deepEqual(baked(spawned.home), { node: keg.opt, cli: KERNEL_BIN });

  // The hook a start runs is the home's own copy of oats.core, not the deployment's current one:
  // a copy from before this change writes the node its hook runs under, at every start.
  const itsOwn = execSync("node -p process.execPath", { cwd: before.home, encoding: "utf8" }).trim();
  const gone = "/opt/homebrew/Cellar/node/26.10.0_2/bin/node", file = join(before.home, ".claude", "settings.json");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(shq(baked(before.home).node), shq(gone)));
  assert.equal(baked(before.home).node, gone, "its hooks name a node an upgrade removed");
  const restarted = await asKernel(keg.node, () => startInstanceSession(before.home));
  await waitUntil(() => existsSync(join(before.home, "pid.txt")), "the earlier home's harness to start");
  assert.deepEqual(baked(before.home), { node: itsOwn, cli: KERNEL_BIN }, "rewritten, with the hook's own node");
  assert.notEqual(itsOwn, keg.opt);
  assert.deepEqual(unstable(restarted.warnings), []);
});

test("no stable path: a spawn and a start each say so once, a preview never; a start under a stable node rewrites the hooks", { timeout: 180_000 }, async () => {
  const node = loose(), keg = brew();
  const preview = await asKernel(node, () => spawnHome("no-stable-preview", { preview: true }));
  assert.deepEqual(unstable(preview.warnings), [], "a spawn preview runs no hook and says nothing of the node");
  const spawned = await asKernel(node, () => spawnHome("no-stable"));
  const { home } = spawned;
  assert.deepEqual(unstable(spawned.warnings), [HOME_WARNING(node)], "one line, in the spawn's own warnings");
  assert.deepEqual(baked(home), { node, cli: KERNEL_BIN }, "the path as it is");

  // A launch preview: the planner a start uses, in preview mode. The hook writes nothing and no warning is added.
  const settings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
  const meta = readJson(join(home, "instance.json"));
  const plan = await asKernel(keg.node, () => fx.inEnv(() => planLaunch({ home, instance: meta.instance, meta, contextDir: fx.dep, agentLike: { harness: meta.harness }, selection: {}, resolvedCfg: resolvedFromHome(home, meta), preview: true })));
  assert.deepEqual(plan.previewedHooks, ["oats.core"], "the launch hook ran for the preview");
  assert.deepEqual(unstable(plan.warnings), []);
  const planLoose = await asKernel(node, () => fx.inEnv(() => planLaunch({ home, instance: meta.instance, meta, contextDir: fx.dep, agentLike: { harness: meta.harness }, selection: {}, resolvedCfg: resolvedFromHome(home, meta), preview: true })));
  assert.deepEqual(unstable(planLoose.warnings), []);
  assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), settings, "a preview rewrites nothing");

  // An existing home whose hooks name an old path: the launch event of a start rewrites them.
  const started = await asKernel(keg.node, () => startInstanceSession(home));
  await waitUntil(() => existsSync(join(home, "pid.txt")), "the harness to start");
  assert.deepEqual(baked(home), { node: keg.opt, cli: KERNEL_BIN }, "after a start, the new path");
  assert.deepEqual(unstable(started.warnings), []);
  // And of a restart. Its launch hook runs twice (the preflight's preview, then for real): one line, not two.
  rmSync(join(home, "pid.txt"));
  const restarted = await asKernel(node, () => restartInstanceSession(home, { stopGraceMs: 5000 }));
  await waitUntil(() => existsSync(join(home, "pid.txt")), "the restarted harness");
  assert.deepEqual(unstable(restarted.warnings), [HOME_WARNING(node)]);
  assert.deepEqual(baked(home), { node, cli: KERNEL_BIN });
});

test("a version manager: the kernel's PATH holds the version's own bin and the manager's shims; the version's path, no warning", { timeout: 120_000 }, async () => {
  // As a manager's shim starts a program (measured with mise): the directory of every tool it
  // manages on PATH, and its shims directory, whose `node` is a link to the manager itself.
  const manager = join(base, "manager"), versionBin = join(manager, "installs", "node", "26.8.2", "bin"), shims = join(manager, "shims");
  const node = fakeNode(join(versionBin, "node"));
  write(join(manager, "bin", "manager"), `#!/bin/sh\nexec ${shq(node)} "$@"\n`, 0o755);
  mkdirSync(shims); symlinkSync(join(manager, "bin", "manager"), join(shims, "node"));
  const saved = process.env.PATH;
  try {
    for (const entries of [[versionBin, shims], [shims, versionBin]]) {
      process.env.PATH = `${entries.join(":")}:${saved}`;
      await asKernel(node, () => assert.deepEqual(kernelNode(), { node }, "the version's own path, as the unit records it (#916)"));
    }
    const spawned = await asKernel(node, () => spawnHome("under-a-manager"));
    assert.deepEqual(unstable(spawned.warnings), []);
    assert.deepEqual(baked(spawned.home), { node, cli: KERNEL_BIN });
    const started = await asKernel(node, () => startInstanceSession(spawned.home));
    await waitUntil(() => existsSync(join(spawned.home, "pid.txt")), "the harness to start");
    assert.deepEqual(unstable(started.warnings), []);
    // Only the shims on PATH (a kernel that the shim did not start): the shim is not this node, and
    // which node it runs depends on the directory it is run from, so it is never the answer.
    process.env.PATH = `${shims}:${saved}`;
    await asKernel(node, () => assert.deepEqual(kernelNode(), { node, warning: HOME_WARNING(node) }));
  } finally { process.env.PATH = saved; }
});

test("pi: oats.core writes no hooks, and the variable is still every harness's, so the warning is said", { timeout: 120_000 }, async () => {
  const node = loose();
  const spawned = await asKernel(node, () => spawnHome("no-stable-pi", { launchConfig: "piprobe" }));
  assert.ok(!existsSync(join(spawned.home, ".claude", "settings.json")), "nothing written for pi");
  assert.deepEqual(unstable(spawned.warnings), [HOME_WARNING(node)]);
});
