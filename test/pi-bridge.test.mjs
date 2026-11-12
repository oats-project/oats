// awebai/oats#991, #852, #1011: the pi folders of a deployment, the bridge found in each and the
// plan `oats update` runs, forward only and on a checked registry answer (lib/pi-bridge.mjs). The
// module's functions alone, on a temporary tree; the CLI over them is test/pi-bridge-cli.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { PI_BRIDGE, bridgeLookup, bridgeLookupProblem, kernelLookup, kernelLookupResult, piBridgeFailure, piBridgeFolders, piBridgeSkewWarnings, piBridgeState, piBridgeStepProblem, piFolders, planCliUpdate, desktopFirstLine, planPiBridges, piBridgePlanLines, registryVersion, whyLookedAt } from "../lib/pi-bridge.mjs";
import { compareVersions, parseVersion } from "../lib/resolve.mjs";

const bases = [];
test.after(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });
/** A temporary host: `home`, an environment with nothing but it, and `bridge(dir, version)`. */
function host() {
  const base = fixtureBase("oats-pib-");
  bases.push(base);
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const bridgeFile = (dir) => join(dir, "npm", "node_modules", "@awebai", "oats-pi", "package.json");
  const bridge = (dir, version, text) => { mkdirSync(join(bridgeFile(dir), ".."), { recursive: true }); writeFileSync(bridgeFile(dir), text ?? JSON.stringify({ name: PI_BRIDGE, version })); return dir; };
  return { base, home, env: { HOME: home }, defaultDir: join(home, ".pi", "agent"), bridge, bridgeFile };
}
const pi = (name, env, more = {}) => ({ name, harness: "pi", args: [], env, ...more });
const configs = (...list) => Object.fromEntries(list.map((c) => [c.name, c]));

// A launch configuration's pi folder is read by launchConfigFolder (lib/harness-trust.mjs), the one
// reader for every harness: test/harness-trust.test.mjs pins it, pi's leading ~ included.

test("piFolders: the default alone, when nothing else names a folder", () => {
  const h = host();
  const folders = piFolders({ env: h.env });
  assert.deepEqual(folders, [{ dir: h.defaultDir, real: h.defaultDir, reasons: [{ kind: "default" }] }]);
  assert.equal(whyLookedAt(folders[0]), "the default");
  assert.deepEqual(piFolders({ env: { ...h.env, PI_CODING_AGENT_DIR: "" } }), folders, "an empty variable is not set");
});

test("piFolders: the default, this shell's, then each pi launch configuration's in name order; other harnesses are not read", () => {
  const h = host();
  const folders = piFolders({ env: { ...h.env, PI_CODING_AGENT_DIR: join(h.base, "shell") }, launchConfigs: configs(
    pi("zeta", { PI_CODING_AGENT_DIR: join(h.base, "z") }),
    pi("alpha", { PI_CODING_AGENT_DIR: join(h.base, "a") }),
    pi("host-folder", { OTHER: "x" }),
    { name: "claude-one", harness: "claude", args: [], env: { PI_CODING_AGENT_DIR: join(h.base, "claude") } },
  ) });
  assert.deepEqual(folders.map((f) => [f.dir, whyLookedAt(f)]), [
    [h.defaultDir, "the default"],
    [join(h.base, "shell"), "this shell's PI_CODING_AGENT_DIR"],
    [join(h.base, "a"), "launch configuration alpha"],
    [join(h.base, "z"), "launch configuration zeta"],
  ]);
});

test("piFolders: one folder keeps every reason it is listed for: two configurations, a configuration naming the default, a symlink, this shell's", () => {
  const h = host();
  const shared = join(h.base, "shared");
  mkdirSync(shared);
  mkdirSync(h.defaultDir, { recursive: true });
  symlinkSync(shared, join(h.base, "link"));
  const folders = piFolders({ env: { ...h.env, PI_CODING_AGENT_DIR: shared }, launchConfigs: configs(
    pi("a", { PI_CODING_AGENT_DIR: shared }),
    pi("b", { PI_CODING_AGENT_DIR: join(h.base, "link") }),
    pi("c", { PI_CODING_AGENT_DIR: "~/.pi/agent" }),
    pi("d", { PI_CODING_AGENT_DIR: `${shared}/` }),
  ) });
  assert.deepEqual(folders.map((f) => [f.dir, whyLookedAt(f)]), [
    [h.defaultDir, "the default, launch configuration c"],
    [shared, "this shell's PI_CODING_AGENT_DIR, launch configurations a, b, d"],
  ]);
  assert.equal(folders[1].real, shared);
});

test("piFolders: a folder that does not exist yet is deduplicated by its resolved path", () => {
  const h = host();
  const folders = piFolders({ env: h.env, launchConfigs: configs(pi("a", { PI_CODING_AGENT_DIR: join(h.base, "new") }), pi("b", { PI_CODING_AGENT_DIR: join(h.base, "x", "..", "new") })) });
  assert.deepEqual(folders.slice(1).map((f) => [f.dir, whyLookedAt(f)]), [[join(h.base, "new"), "launch configurations a, b"]]);
});

test("piFolders: a folder that cannot be resolved is listed with its problem, never dropped or merged", () => {
  const h = host();
  const folders = piFolders({ env: { ...h.env, PI_CODING_AGENT_DIR: "relative/shell" }, launchConfigs: configs(
    pi("ci", { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } }),
    pi("ci-two", { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } }),
    pi("rel", { PI_CODING_AGENT_DIR: "rel/pi" }),
  ) });
  assert.deepEqual(folders.slice(1), [
    { dir: null, real: null, reasons: [{ kind: "shell" }], problem: 'PI_CODING_AGENT_DIR "relative/shell" is not an absolute path' },
    { dir: null, real: null, reasons: [{ kind: "launch-config", name: "ci" }], problem: "PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host", fromEnv: "PI_CI_DIR" },
    { dir: null, real: null, reasons: [{ kind: "launch-config", name: "ci-two" }], problem: "PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host", fromEnv: "PI_CI_DIR" },
    { dir: null, real: null, reasons: [{ kind: "launch-config", name: "rel" }], problem: 'PI_CODING_AGENT_DIR "rel/pi" is not an absolute path' },
  ]);
  // The reference resolves from the environment given, not from this process's.
  assert.equal(piFolders({ env: { ...h.env, PI_CI_DIR: "/srv/ci" }, launchConfigs: configs(pi("ci", { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } })) })[1].dir, "/srv/ci");
});

test("piFolders: a configuration's executable is kept, a relative path resolved against the deployment as a launch does", () => {
  const h = host();
  const folders = piFolders({ env: h.env, launchConfigs: configs(
    pi("abs", { PI_CODING_AGENT_DIR: "/srv/1" }, { executable: "/opt/pi-box", source: "/dep" }),
    pi("bare", { PI_CODING_AGENT_DIR: "/srv/2" }, { executable: "pi-box", source: "/dep" }),
    pi("rel", { PI_CODING_AGENT_DIR: "/srv/3" }, { executable: "bin/pi-box", source: "/dep" }),
  ) });
  assert.deepEqual(folders.slice(1).map((f) => f.reasons[0].executable), ["/opt/pi-box", "pi-box", "/dep/bin/pi-box"]);
});

test("piBridgeState: no folder, no bridge, a version, and a package.json that cannot be read", () => {
  const h = host();
  const dir = join(h.base, "pi");
  assert.deepEqual(piBridgeState(dir), { status: "no-folder", file: h.bridgeFile(dir) });
  mkdirSync(dir);
  assert.deepEqual(piBridgeState(dir), { status: "no-bridge", file: h.bridgeFile(dir) });
  h.bridge(dir, "0.52.0");
  assert.deepEqual(piBridgeState(dir), { status: "installed", file: h.bridgeFile(dir), version: "0.52.0" });
  for (const [text, problem] of [["{ not json", "cannot be read as JSON"], ["null", "cannot be read as JSON"], ["{}", "names no version"], ['{"version":7}', "names no version"], ['{"version":""}', "names no version"]]) {
    h.bridge(dir, null, text);
    assert.deepEqual(piBridgeState(dir), { status: "unreadable", file: h.bridgeFile(dir), problem: `${h.bridgeFile(dir)} ${problem}` }, text);
  }
});

/** One folder of every kind, read from disk. */
function everyKind(h, env = h.env) {
  h.bridge(h.defaultDir, "0.52.0");
  const at = (name) => join(h.base, name);
  h.bridge(at("behind dir"), "0.51.0");
  h.bridge(at("current"), "0.53.0");
  h.bridge(at("boxed"), "0.52.0");
  h.bridge(at("mixed"), "0.52.0");
  h.bridge(at("broken"), null, "{ not json");
  mkdirSync(at("empty"));
  return piBridgeFolders({ env, launchConfigs: configs(
    pi("behind", { PI_CODING_AGENT_DIR: at("behind dir") }),
    pi("boxed", { PI_CODING_AGENT_DIR: at("boxed") }, { executable: "bin/pi box", source: "/dep" }),
    pi("boxed-too", { PI_CODING_AGENT_DIR: at("boxed") }, { executable: "/opt/other-box" }),
    pi("broken", { PI_CODING_AGENT_DIR: at("broken") }),
    pi("ci", { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } }, { executable: "/opt/ci-box" }),
    pi("current", { PI_CODING_AGENT_DIR: at("current") }),
    pi("empty", { PI_CODING_AGENT_DIR: at("empty") }),
    pi("gone", { PI_CODING_AGENT_DIR: at("gone") }),
    pi("mixed-box", { PI_CODING_AGENT_DIR: at("mixed") }, { executable: "/opt/pi-box" }),
    pi("mixed-plain", { PI_CODING_AGENT_DIR: at("mixed") }),
    pi("rel", { PI_CODING_AGENT_DIR: "rel/pi" }),
  ) });
}

test("planPiBridges: move, leave, none and skip, each with its line, its command and its step", () => {
  const h = host();
  const at = (name) => join(h.base, name);
  const plan = planPiBridges(everyKind(h), "0.53.0", { env: h.env });
  const spec = "npm:@awebai/oats-pi@0.53.0";
  assert.deepEqual(plan.map((e) => [e.reasons.map((r) => r.name ?? r.kind).join("+"), e.action, e.detail, e.commands ?? null, e.step?.display ?? null]), [
    ["default", "move", "bridge 0.52.0: move to 0.53.0", null, `npm_config_prefer_online=true pi install ${spec}`],
    ["behind", "move", "bridge 0.51.0: move to 0.53.0", null, `PI_CODING_AGENT_DIR='${at("behind dir")}' npm_config_prefer_online=true pi install ${spec}`],
    ["boxed+boxed-too", "skip", "bridge 0.52.0: not touched: launch configurations boxed, boxed-too run their own executable, and `oats update` runs no wrapper", [
      // Every distinct executable, one command each, with the configuration it is for: not the first alone (#1011).
      { command: `PI_CODING_AGENT_DIR=${at("boxed")} '/dep/bin/pi box' install ${spec}`, where: "for launch configuration boxed" },
      { command: `PI_CODING_AGENT_DIR=${at("boxed")} /opt/other-box install ${spec}`, where: "for launch configuration boxed-too" },
    ], null],
    ["broken", "skip", `bridge not read: not touched: ${h.bridgeFile(at("broken"))} cannot be read as JSON`, [{ command: `PI_CODING_AGENT_DIR=${at("broken")} pi install ${spec}` }], null],
    ["ci", "skip", "not touched: PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host", [{ command: `PI_CODING_AGENT_DIR="$PI_CI_DIR" /opt/ci-box install ${spec}`, where: "where PI_CI_DIR is set" }], null],
    ["current", "leave", "bridge 0.53.0: left alone, already at 0.53.0", null, null],
    ["empty", "none", "no bridge: not touched", null, null],
    ["gone", "none", "no bridge (the folder does not exist): not touched", null, null],
    ["mixed-box+mixed-plain", "move", "bridge 0.52.0: move to 0.53.0", null, `PI_CODING_AGENT_DIR=${at("mixed")} npm_config_prefer_online=true pi install ${spec}`],
    ["rel", "skip", 'not touched: PI_CODING_AGENT_DIR "rel/pi" is not an absolute path', null, null],
  ]);
  // The step is arguments and an environment, never a shell string: a folder with a space is one value.
  assert.deepEqual(plan[1].step, { argv: ["pi", "install", spec], env: { PI_CODING_AGENT_DIR: at("behind dir"), npm_config_prefer_online: "true" }, display: plan[1].step.display });
  assert.deepEqual(plan[0].step.env, { npm_config_prefer_online: "true" }, "the default folder, when nothing sets one: pi is left to find it");
});

test("planPiBridges: a single configuration with its own executable, in the singular", () => {
  const h = host();
  h.bridge(join(h.base, "boxed"), "0.52.0");
  const plan = planPiBridges(piBridgeFolders({ env: h.env, launchConfigs: configs(pi("boxed", { PI_CODING_AGENT_DIR: join(h.base, "boxed") }, { executable: "pi-box" })) }), "0.53.0", { env: h.env });
  assert.equal(plan[1].detail, "bridge 0.52.0: not touched: launch configuration boxed runs its own executable, and `oats update` runs no wrapper");
  assert.deepEqual(plan[1].commands, [{ command: `PI_CODING_AGENT_DIR=${join(h.base, "boxed")} pi-box install npm:@awebai/oats-pi@0.53.0` }]);
});

test("#1011 planPiBridges: the by-hand commands of a folder only wrapped configurations name: one per distinct executable, with the configurations it is for", () => {
  const h = host();
  const dir = h.bridge(join(h.base, "boxed"), "0.52.0");
  const spec = "npm:@awebai/oats-pi@0.53.0";
  const planOf = (...list) => planPiBridges(piBridgeFolders({ env: h.env, launchConfigs: configs(...list) }), "0.53.0", { env: h.env })[1];
  const boxed = (name, executable) => pi(name, { PI_CODING_AGENT_DIR: dir }, executable ? { executable } : {});
  // Two configurations, one executable: one command, and nothing to tell apart.
  const same = planOf(boxed("a", "/opt/pi-box"), boxed("b", "/opt/pi-box"));
  assert.equal(same.detail, "bridge 0.52.0: not touched: launch configurations a, b run their own executable, and `oats update` runs no wrapper");
  assert.deepEqual(same.commands, [{ command: `PI_CODING_AGENT_DIR=${dir} /opt/pi-box install ${spec}` }]);
  // Three configurations, two executables: the configurations of one executable share its command, in name order.
  const three = planOf(boxed("c", "/opt/pi-box"), boxed("a", "/opt/pi-box"), boxed("b", "/opt/other box"));
  assert.deepEqual(three.commands, [
    { command: `PI_CODING_AGENT_DIR=${dir} /opt/pi-box install ${spec}`, where: "for launch configurations a, c" },
    { command: `PI_CODING_AGENT_DIR=${dir} '/opt/other box' install ${spec}`, where: "for launch configuration b" },
  ]);
  assert.deepEqual(piBridgePlanLines([three]).slice(2), [
    `    run there, for launch configurations a, c: PI_CODING_AGENT_DIR=${dir} /opt/pi-box install ${spec}`,
    `    run there, for launch configuration b: PI_CODING_AGENT_DIR=${dir} '/opt/other box' install ${spec}`,
  ]);
  // The same for a bridge that cannot be read there.
  h.bridge(dir, null, "{");
  assert.deepEqual(planOf(boxed("a", "/opt/pi-box"), boxed("b", "/opt/other-box")).commands.map((c) => c.where), ["for launch configuration a", "for launch configuration b"]);
  // One wrapped and one plain configuration: the folder is not wrapped, and the plain `pi` is named.
  assert.deepEqual(planOf(boxed("a", "/opt/pi-box"), boxed("b")).commands, [{ command: `PI_CODING_AGENT_DIR=${dir} pi install ${spec}` }]);
  h.bridge(dir, "0.52.0");
  assert.deepEqual(planOf(boxed("a", "/opt/pi-box"), boxed("b")).step.argv, ["pi", "install", spec]);
});

test("planPiBridges: with this shell's PI_CODING_AGENT_DIR set, the default folder's step names the default folder", () => {
  const h = host();
  h.bridge(h.defaultDir, "0.52.0");
  const shell = h.bridge(join(h.base, "shell"), "0.52.0");
  const env = { ...h.env, PI_CODING_AGENT_DIR: shell };
  const plan = planPiBridges(piBridgeFolders({ env }), "0.53.0", { env });
  assert.deepEqual(plan.map((e) => e.step.env.PI_CODING_AGENT_DIR), [h.defaultDir, shell]);
  // The shell's variable naming the default folder itself: one folder, the variable kept as it is.
  const same = { ...h.env, PI_CODING_AGENT_DIR: h.defaultDir };
  assert.deepEqual(planPiBridges(piBridgeFolders({ env: same }), "0.53.0", { env: same }).map((e) => [whyLookedAt(e), e.step.env.PI_CODING_AGENT_DIR]), [["the default, this shell's PI_CODING_AGENT_DIR", h.defaultDir]]);
});

test("#1011 the ordering the forward-only rule rests on (compareVersions, resolve.mjs): a prerelease is below its release", () => {
  const order = (a, b) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)));
  assert.equal(order("0.53.0", "0.53.0-rc.1"), 1, "a release is above its own prerelease");
  assert.equal(order("0.53.0-rc.1", "0.53.0"), -1);
  assert.equal(order("0.53.0-rc.1", "0.53.0-rc.2"), -1, "rc.1 is below rc.2");
  assert.equal(order("0.53.0-rc.1", "0.52.0"), 1, "a prerelease of a higher triple is above a lower release");
  assert.equal(order("0.53.0", "0.52.9"), 1);
  assert.equal(order("0.9.0", "0.10.0"), -1, "numbers, not text");
  assert.equal(order("0.53.0", "0.53.0"), 0);
  assert.equal(order("0.53.0+build.1", "0.53.0"), 0, "build metadata orders nothing");
});

test("#1011 planPiBridges: a bridge ahead of the target is left alone and said to be ahead; one behind is moved", () => {
  const h = host();
  const planFor = (version, target = "0.53.0") => { h.bridge(h.defaultDir, version); return planPiBridges(piBridgeFolders({ env: h.env }), target, { env: h.env })[0]; };
  const ahead = planFor("0.54.0");
  assert.deepEqual([ahead.action, ahead.ahead, ahead.detail, ahead.step, ahead.commands], ["leave", true, "bridge 0.54.0: left alone, ahead of 0.53.0", undefined, undefined]);
  assert.equal(planFor("0.53.1-rc.1").detail, "bridge 0.53.1-rc.1: left alone, ahead of 0.53.0");
  // A prerelease is below its release: a bridge at the release is ahead of a kernel at its prerelease, and the reverse is behind.
  assert.equal(planFor("0.53.0", "0.53.0-rc.1").detail, "bridge 0.53.0: left alone, ahead of 0.53.0-rc.1");
  assert.equal(planFor("0.53.0-rc.1").detail, "bridge 0.53.0-rc.1: move to 0.53.0");
  assert.equal(planFor("0.52.0").detail, "bridge 0.52.0: move to 0.53.0");
  assert.equal(planFor("0.53.0").ahead, undefined, "at the target: left alone, and not ahead");
  // The same version under another spelling (a local build of the kernel): at the target, never moved to it.
  assert.deepEqual([planFor("0.53.0", "0.53.0+build.1").action, planFor("0.53.0", "0.53.0+build.1").detail], ["leave", "bridge 0.53.0: left alone, already at 0.53.0+build.1"]);
  // Ahead, in a folder only a wrapped configuration names: left alone, and no command to run there.
  const boxed = h.bridge(join(h.base, "boxed"), "0.54.0");
  const wrapped = planPiBridges(piBridgeFolders({ env: h.env, launchConfigs: configs(pi("boxed", { PI_CODING_AGENT_DIR: boxed }, { executable: "/opt/pi-box" })) }), "0.53.0", { env: h.env })[1];
  assert.deepEqual([wrapped.action, wrapped.detail, wrapped.commands], ["leave", "bridge 0.54.0: left alone, ahead of 0.53.0", undefined]);
});

test("#1011 planPiBridges: a bridge whose version cannot be compared is another version: moved, as before", () => {
  const h = host();
  for (const version of ["banana", "99", "latest", "0.54.0 beta"]) {
    h.bridge(h.defaultDir, version);
    const entry = planPiBridges(piBridgeFolders({ env: h.env }), "0.53.0", { env: h.env })[0];
    assert.deepEqual([entry.action, entry.detail], version === "99" ? ["leave", "bridge 99: left alone, ahead of 0.53.0"] : ["move", `bridge ${version}: move to 0.53.0`], version);
  }
});

test("#1011 registryVersion: the registry's answer is one version and nothing else, or a problem that is safe to print", () => {
  const lookup = "npm view @awebai/oats version";
  for (const good of ["0.52.0", "0.53.0-rc.1", "10.20.30-beta.2-x", "0.0.0"]) {
    assert.deepEqual(registryVersion(`${good}\n`, lookup), { version: good }, good);
    assert.deepEqual(registryVersion(good, lookup), { version: good });
    assert.deepEqual(registryVersion(`${good}\r\n`, lookup), { version: good });
  }
  const refused = (answer) => { const r = registryVersion(answer, lookup); assert.equal(r.version, undefined, JSON.stringify(answer)); return r.problem; };
  const says = (shown) => `\`${lookup}\` answered ${shown}, which is not a version`;
  assert.equal(refused(""), says("nothing"));
  assert.equal(refused("\n"), says("nothing"));
  assert.equal(refused(undefined), says("nothing"));
  assert.equal(refused("0.52.0\n0.53.0\n"), says('"0.52.0\\n0.53.0"'), "two lines");
  assert.equal(refused("0.52.0\n\n"), says('"0.52.0\\n"'), "a blank line after it");
  assert.equal(refused("0.52.0 (latest)\n"), says('"0.52.0 (latest)"'), "a version with trailing text");
  assert.equal(refused(" 0.52.0\n"), says('" 0.52.0"'));
  assert.equal(refused("0.52.0 \n"), says('"0.52.0 "'));
  assert.equal(refused('[\n  "0.51.0",\n  "0.52.0"\n]\n'), says('"[\\n  \\"0.51.0\\",\\n  \\"0.52.0\\"\\n]"'), "the JSON array npm prints for a range");
  assert.equal(refused("\u001b[31m0.52.0\u001b[0m\n"), says('"\\u001b[31m0.52.0\\u001b[0m"'), "an ANSI sequence is shown, not sent to the terminal");
  assert.equal(refused("0.52.0\u009b31m\u202e\n"), says('"0.52.0\uFFFD31m\uFFFD"'), "C1 and bidi characters are replaced");
  for (const bad of ["v0.52.0", "0.52", "1", "0.52.x", "0.52.0+build.1", "0.52.0-", "0.52.0-rc_1", "^0.52.0", "latest", "0.52.0; rm -rf /", "$(id)", "0.52.0 --registry=http://x", "-0.52.0", "0.52.0\u0000"]) refused(`${bad}\n`);
  // A very long line: refused, and the message is bounded whatever came.
  const long = refused(`${"9".repeat(100_000)}\n`);
  assert.equal([...long].length, [...says("")].length + 80);
  assert.ok(long.includes("…, which is not a version"), long.slice(-40));
  assert.equal(refused(`0.52.0-${"a".repeat(300)}\n`).length, long.length, "the shape, but longer than a version is");
  assert.deepEqual(registryVersion(`0.52.0-${"a".repeat(249)}`, lookup), { version: `0.52.0-${"a".repeat(249)}` });
});

test("#1011 planCliUpdate: the CLI moves forward only, and the bridges' target is the version the kernel has after the run", () => {
  const step = (version) => ({ argv: ["npm", "install", "-g", `@awebai/oats@${version}`], display: `npm install -g @awebai/oats@${version}` });
  // Behind: the step, and the bridges go where the CLI goes.
  assert.deepEqual(planCliUpdate("0.52.0", "0.53.0"), { installed: "0.52.0", registry: "0.53.0", target: "0.53.0", ahead: false, step: step("0.53.0") });
  // Equal: nothing for the CLI.
  assert.deepEqual(planCliUpdate("0.53.0", "0.53.0"), { installed: "0.53.0", registry: "0.53.0", target: "0.53.0", ahead: false });
  // Ahead (the issue's own case: main says 0.53.0 while npm's latest is 0.52.0): no step, one line with both versions.
  assert.deepEqual(planCliUpdate("0.53.0", "0.52.0"), { installed: "0.53.0", registry: "0.52.0", target: "0.53.0", ahead: true, note: "The installed 0.53.0 is ahead of the registry's 0.52.0: nothing to do for the CLI." });
  // A prerelease kernel: ahead of an older release, behind its own release.
  assert.deepEqual([planCliUpdate("0.53.0-rc.1", "0.52.0").ahead, planCliUpdate("0.53.0-rc.1", "0.52.0").step, planCliUpdate("0.53.0-rc.1", "0.52.0").target], [true, undefined, "0.53.0-rc.1"]);
  assert.deepEqual(planCliUpdate("0.53.0-rc.1", "0.53.0").step, step("0.53.0"));
  assert.deepEqual(planCliUpdate("0.53.0-rc.2", "0.53.0-rc.1").ahead, true);
  assert.deepEqual(planCliUpdate("0.53.0-rc.1", "0.53.0-rc.2").step, step("0.53.0-rc.2"));
  assert.equal(planCliUpdate("0.9.0", "0.10.0").target, "0.10.0", "compared as numbers");
  // A local build of the version the registry lists: the same version, so no step, and the bridges' target stays the installed kernel's.
  assert.deepEqual(planCliUpdate("0.53.0+build.1", "0.53.0"), { installed: "0.53.0+build.1", registry: "0.53.0", target: "0.53.0+build.1", ahead: false });
  assert.deepEqual(planCliUpdate("0.53.0+build.1", "0.54.0").step, step("0.54.0"));
  assert.equal(planCliUpdate("0.53.0+build.1", "0.52.0").ahead, true);
  // An installed version that cannot be compared is another version: the step, as before.
  assert.deepEqual(planCliUpdate("banana", "0.53.0").step, step("0.53.0"));
});

test("#1107 desktopFirstLine: the line when the CLI's install moves it to another minor or major version, null otherwise", () => {
  // #1879: a Desktop above its tested bound holds back what it was not tested with; the last hard-ceiling Desktop refuses.
  const line = (version) => `An OATS Desktop older than ${version.split(".").slice(0, 2).join(".").replace(/-.*$/, "")} holds actions back with this CLI. `
    + `Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop ${version}. `
    + "(An OATS Desktop of 0.69.17 or older refuses this CLI until then.)";
  const said = (installed, registry) => desktopFirstLine(planCliUpdate(installed, registry));
  // Another minor, or another major: the line, with the version the plan installs.
  assert.equal(said("0.55.1", "0.56.0"), line("0.56.0"));
  assert.equal(said("0.56.0-rc.1", "0.57.0"), line("0.57.0"));
  assert.equal(said("0.56.0", "1.0.0"), line("1.0.0"));
  assert.equal(said("0.9.0", "0.10.0"), line("0.10.0"), "compared as numbers");
  assert.equal(said("0.56.0", "0.57.0-rc.1"), line("0.57.0-rc.1"), "the registry's version as npm listed it");
  // Within the minor: a patch, a prerelease to its release or to a later prerelease, a local build.
  assert.equal(said("0.55.0", "0.55.1"), null);
  assert.equal(said("0.56.0-rc.1", "0.56.0"), null);
  assert.equal(said("0.56.0-rc.1", "0.56.0-rc.2"), null);
  assert.equal(said("0.56.0+build.1", "0.56.1"), null, "build metadata compares as its release");
  assert.equal(said("0.55.0+build.1", "0.56.0"), line("0.56.0"));
  // No CLI step: up to date, a local build of the same version, or the CLI ahead of the registry.
  assert.equal(said("0.56.0", "0.56.0"), null);
  assert.equal(said("0.56.0+build.1", "0.56.0"), null);
  assert.equal(said("0.57.0", "0.56.0"), null);
  assert.equal(said("1.0.0", "0.56.0"), null);
  // An installed version that cannot be read is another version: the step, and the line with it.
  assert.equal(said("banana", "0.56.0"), line("0.56.0"));
});

test("#1011 kernelLookupResult: the version, or the message that stops the update; nothing npm printed is in it as it came, from either stream", () => {
  assert.deepEqual(kernelLookup(), ["npm", "view", "@awebai/oats", "version"]);
  assert.deepEqual(kernelLookupResult({ status: 0, stdout: "0.53.0\n", stderr: "" }), { version: "0.53.0" });
  // A lookup that ended well: its error output (a notice, a warning) is dropped, whatever it holds.
  assert.deepEqual(kernelLookupResult({ status: 0, stdout: "0.53.0\n", stderr: "\u001b[2Jnpm notice\n" }), { version: "0.53.0" });
  assert.deepEqual(kernelLookupResult({ status: 0, stdout: "not a version\n", stderr: "\u001b[2Juntrusted\n" }),
    { problem: '`npm view @awebai/oats version` answered "not a version", which is not a version. Nothing was changed. Run `oats update` again.' });
  // A failed lookup: how it ended, then what npm said, bounded and safe to print.
  assert.deepEqual(kernelLookupResult({ status: 17, stdout: "", stderr: "" }), { problem: "cannot check npm for the latest version: exit 17" });
  assert.deepEqual(kernelLookupResult({ status: 1, stdout: "0.53.0\n", stderr: "npm error code E404\n\u001b[31mnpm error 404\u001b[0m\u009b\u202e\n" }),
    { problem: 'cannot check npm for the latest version: exit 1: "npm error code E404\\n\\u001b[31mnpm error 404\\u001b[0m\uFFFD\uFFFD"' });
  const long = kernelLookupResult({ status: 1, stdout: "", stderr: "x".repeat(100_000) }).problem;
  assert.equal([...long].length, "cannot check npm for the latest version: exit 1: ".length + 300);
  assert.ok(long.endsWith("…"));
  assert.deepEqual(kernelLookupResult({ error: new Error("spawnSync npm ENOENT"), status: null, stdout: "", stderr: "" }), { problem: "cannot check npm for the latest version: spawnSync npm ENOENT" });
  assert.deepEqual(kernelLookupResult({ status: null, signal: "SIGKILL", stdout: "0.53.0\n", stderr: "" }), { problem: "cannot check npm for the latest version: exit SIGKILL" });
});

test("#1011 bridgeLookupProblem: seen is exit 0 and the checked answer equal to the target; anything else stops the update", () => {
  const cli = planCliUpdate("0.52.0", "0.53.0");
  assert.deepEqual(bridgeLookup("0.53.0"), ["npm", "view", "@awebai/oats-pi@0.53.0", "version", "--prefer-online"]);
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "0.53.0\n" }, cli), null);
  const later = ": a version is listed a few minutes after it is published. Nothing was changed, and every bridge is in place. Run `oats update` again in a few minutes.";
  const notSeen = (why) => `@awebai/oats-pi@0.53.0 was not seen on the registry (npm view: ${why})${later}`;
  assert.equal(bridgeLookupProblem({ status: 1, stdout: "" }, cli), notSeen("exit 1"));
  assert.equal(bridgeLookupProblem({ status: 1, stdout: "0.53.0\n" }, cli), notSeen("exit 1"), "a failed run's output is not an answer");
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "" }, cli), notSeen("no answer"), "an older npm: exit 0 and no output for a version that does not exist");
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "\n" }, cli), notSeen("no answer"));
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "0.52.0\n" }, cli), notSeen("it answered 0.52.0"));
  assert.equal(bridgeLookupProblem({ error: new Error("spawnSync npm ETIMEDOUT"), status: null, stdout: "0.53.0\n" }, cli), notSeen("spawnSync npm ETIMEDOUT"));
  // An answer that is not a version: said to be that, with the lookup that answered, safe to print.
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "\u001b[2J0.53.0\nnpm notice\n" }, cli),
    '`npm view @awebai/oats-pi@0.53.0 version --prefer-online` answered "\\u001b[2J0.53.0\\nnpm notice", which is not a version. Nothing was changed, and every bridge is in place. Run `oats update` again.');
  assert.match(bridgeLookupProblem({ status: 0, stdout: '[ "0.53.0" ]\n' }, cli), /^`npm view @awebai\/oats-pi@0\.53\.0 version --prefer-online` answered "\[ \\"0\.53\.0\\" \]", which is not a version\./);
  // The installed kernel ahead of the registry: its bridge is not one that appears in a few minutes.
  const ahead = planCliUpdate("0.53.0", "0.52.0");
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "0.53.0\n" }, ahead), null);
  assert.equal(bridgeLookupProblem({ status: 1, stdout: "" }, ahead),
    "@awebai/oats-pi@0.53.0 was not seen on the registry (npm view: exit 1): the installed kernel 0.53.0 is ahead of the registry's 0.52.0, so its bridge may not be published. Nothing was changed, and every bridge is in place. Run `oats update` again once npm lists 0.53.0.");
  assert.match(bridgeLookupProblem({ status: 0, stdout: "" }, ahead), /\(npm view: no answer\): the installed kernel 0\.53\.0 is ahead of the registry's 0\.52\.0/);
});

test("#1011 a local build of the version the registry lists, with a bridge behind: the bridge moves, npm's `0.53.0` is the version asked for, and the folder at `0.53.0` is the step done", () => {
  const h = host();
  h.bridge(h.defaultDir, "0.52.0");
  const cli = planCliUpdate("0.53.0+build.1", "0.53.0");
  assert.deepEqual([cli.step, cli.target], [undefined, "0.53.0+build.1"]);
  const entry = planPiBridges(piBridgeFolders({ env: h.env }), cli.target, { env: h.env })[0];
  assert.deepEqual([entry.action, entry.detail, entry.step.argv], ["move", "bridge 0.52.0: move to 0.53.0+build.1", ["pi", "install", "npm:@awebai/oats-pi@0.53.0+build.1"]]);
  // npm resolves the build's spec to the version it lists, and prints that one.
  assert.deepEqual(bridgeLookup(cli.target), ["npm", "view", "@awebai/oats-pi@0.53.0+build.1", "version", "--prefer-online"]);
  assert.equal(bridgeLookupProblem({ status: 0, stdout: "0.53.0\n" }, cli), null);
  // Still the checked value, and still exit 0: another version, a bad answer and a failed run are not "seen".
  assert.match(bridgeLookupProblem({ status: 0, stdout: "0.52.0\n" }, cli), /^@awebai\/oats-pi@0\.53\.0\+build\.1 was not seen on the registry \(npm view: it answered 0\.52\.0\)/);
  assert.match(bridgeLookupProblem({ status: 0, stdout: "0.53.0-rc.1\n" }, cli), /\(npm view: it answered 0\.53\.0-rc\.1\)/);
  assert.match(bridgeLookupProblem({ status: 0, stdout: "0.53.0+build.1\n" }, cli), /answered "0\.53\.0\+build\.1", which is not a version\./);
  assert.match(bridgeLookupProblem({ status: 1, stdout: "0.53.0\n" }, cli), /\(npm view: exit 1\)/);
  // After the step: pi wrote the published version, which is the target's.
  assert.equal(piBridgeStepProblem(entry, cli.target, null), "pi ended without an error, but the bridge there is not 0.53.0+build.1", "the bridge is still 0.52.0");
  h.bridge(h.defaultDir, "0.53.0");
  assert.equal(piBridgeStepProblem(entry, cli.target, null), null);
  assert.equal(piBridgeStepProblem(entry, cli.target, "exit 1"), "exit 1");
  // And the next run finds nothing to do there, as doctor finds no skew.
  assert.equal(planPiBridges(piBridgeFolders({ env: h.env }), cli.target, { env: h.env })[0].action, "leave");
  assert.deepEqual(piBridgeSkewWarnings(piBridgeFolders({ env: h.env }), cli.target), []);
});

test("piBridgePlanLines: the folder and why, what happens there, and the command where update does not run it", () => {
  const h = host();
  const at = (name) => join(h.base, name);
  const lines = piBridgePlanLines(planPiBridges(everyKind(h), "0.53.0", { env: h.env }));
  assert.deepEqual(lines.slice(0, 2), [`  ${h.defaultDir}  (the default)`, "    bridge 0.52.0: move to 0.53.0"]);
  const ci = lines.indexOf("  (not resolved)  (launch configuration ci)");
  assert.deepEqual(lines.slice(ci, ci + 3), ["  (not resolved)  (launch configuration ci)", "    not touched: PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host", '    run there, where PI_CI_DIR is set: PI_CODING_AGENT_DIR="$PI_CI_DIR" /opt/ci-box install npm:@awebai/oats-pi@0.53.0']);
  const boxed = lines.indexOf(`  ${at("boxed")}  (launch configurations boxed, boxed-too)`);
  assert.deepEqual(lines.slice(boxed + 2, boxed + 4), [
    `    run there, for launch configuration boxed: PI_CODING_AGENT_DIR=${at("boxed")} '/dep/bin/pi box' install npm:@awebai/oats-pi@0.53.0`,
    `    run there, for launch configuration boxed-too: PI_CODING_AGENT_DIR=${at("boxed")} /opt/other-box install npm:@awebai/oats-pi@0.53.0`,
  ]);
  assert.equal(lines.length, 2 * 10 + 4, "two lines a folder, one more for each command");
});

test("#1011 piBridgePlanLines: the installed kernel ahead of the registry and a bridge to move to its version: one line says the move needs that version published", () => {
  const h = host();
  h.bridge(h.defaultDir, "0.50.0");
  const current = h.bridge(join(h.base, "current"), "0.53.0");
  const folders = () => piBridgeFolders({ env: h.env, launchConfigs: configs(pi("work", { PI_CODING_AGENT_DIR: current })) });
  const linesFor = (cli) => piBridgePlanLines(planPiBridges(folders(), cli.target, { env: h.env }), cli);
  const note = "  A bridge moves to 0.53.0 only if @awebai/oats-pi@0.53.0 is published: the installed kernel is ahead of the registry's 0.52.0, and a run checks that before any step.";
  // Ahead, with a move: the folders as in any plan, then the line, once.
  assert.deepEqual(linesFor(planCliUpdate("0.53.0", "0.52.0")), [
    `  ${h.defaultDir}  (the default)`,
    "    bridge 0.50.0: move to 0.53.0",
    `  ${current}  (launch configuration work)`,
    "    bridge 0.53.0: left alone, already at 0.53.0",
    note,
  ]);
  // Not ahead, with a move: the version is the registry's own, or the installed one it lists. No line.
  for (const cli of [planCliUpdate("0.52.0", "0.53.0"), planCliUpdate("0.53.0", "0.53.0")]) assert.ok(!linesFor(cli).some((l) => l.includes("only if")), JSON.stringify(cli));
  assert.equal(linesFor(planCliUpdate("0.52.0", "0.53.0"))[1], "    bridge 0.50.0: move to 0.53.0");
  // Ahead, with no move: nothing is promised, so nothing is qualified.
  h.bridge(h.defaultDir, "0.53.0");
  assert.deepEqual(linesFor(planCliUpdate("0.53.0", "0.52.0")).filter((l) => !l.startsWith("    ")), [`  ${h.defaultDir}  (the default)`, `  ${current}  (launch configuration work)`]);
  h.bridge(h.defaultDir, "0.54.0");
  assert.ok(!linesFor(planCliUpdate("0.53.0", "0.52.0")).some((l) => l.includes("only if")), "a bridge ahead is left alone: no move");
  // A plan's lines alone, as before.
  h.bridge(h.defaultDir, "0.50.0");
  assert.equal(piBridgePlanLines(planPiBridges(folders(), "0.53.0", { env: h.env })).length, 4);
});

test("piBridgeSkewWarnings: one per folder whose bridge is not the kernel's version or could not be looked at; none for a folder without a bridge", () => {
  const h = host();
  const at = (name) => join(h.base, name);
  assert.deepEqual(piBridgeSkewWarnings(everyKind(h), "0.53.0"), [
    `version skew — kernel 0.53.0, pi bridge 0.52.0 in ${h.defaultDir} (the default); run \`oats update\` (they publish in lockstep)`,
    `version skew — kernel 0.53.0, pi bridge 0.51.0 in ${at("behind dir")} (launch configuration behind); run \`oats update\` (they publish in lockstep)`,
    `version skew — kernel 0.53.0, pi bridge 0.52.0 in ${at("boxed")} (launch configurations boxed, boxed-too); run \`oats update\` (they publish in lockstep)`,
    `pi bridge not checked in ${at("broken")} (launch configuration broken) — ${h.bridgeFile(at("broken"))} cannot be read as JSON; \`oats update\` says what to run there`,
    "pi bridge not checked — launch configuration ci: PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host, so its pi folder could not be looked at; `oats update` says what to run there",
    `version skew — kernel 0.53.0, pi bridge 0.52.0 in ${at("mixed")} (launch configurations mixed-box, mixed-plain); run \`oats update\` (they publish in lockstep)`,
    'pi bridge not checked — launch configuration rel: PI_CODING_AGENT_DIR "rel/pi" is not an absolute path, so its pi folder could not be looked at; `oats update` says what to run there',
  ]);
  const quiet = host();
  assert.deepEqual(piBridgeSkewWarnings(piBridgeFolders({ env: quiet.env }), "0.53.0"), [], "no pi folder at all: nothing to say");
});

test("#1011 piBridgeSkewWarnings: a bridge ahead of the kernel is still a skew, and the warning says what ends it instead of `run oats update`", () => {
  const h = host();
  const warned = (bridge, kernel) => { h.bridge(h.defaultDir, bridge); return piBridgeSkewWarnings(piBridgeFolders({ env: h.env }), kernel); };
  const ahead = (bridge, kernel) => `version skew — kernel ${kernel}, pi bridge ${bridge} in ${h.defaultDir} (the default); the bridge is ahead of the kernel, and \`oats update\` never moves a bridge back. The skew ends when the kernel is at ${bridge} (\`oats update\` moves it once npm lists that version), or when the kernel's bridge is installed there by hand (docs/upgrading.md, "By hand")`;
  const behind = (bridge, kernel) => `version skew — kernel ${kernel}, pi bridge ${bridge} in ${h.defaultDir} (the default); run \`oats update\` (they publish in lockstep)`;
  assert.deepEqual(warned("0.53.0", "0.52.0"), [ahead("0.53.0", "0.52.0")]);
  assert.deepEqual(warned("0.53.0", "0.53.0-rc.1"), [ahead("0.53.0", "0.53.0-rc.1")], "a release is ahead of its prerelease");
  assert.deepEqual(warned("0.53.0-rc.1", "0.53.0"), [behind("0.53.0-rc.1", "0.53.0")]);
  assert.deepEqual(warned("0.52.0", "0.53.0"), [behind("0.52.0", "0.53.0")]);
  assert.deepEqual(warned("banana", "0.53.0"), [behind("banana", "0.53.0")], "a version that cannot be compared is not ahead");
  assert.deepEqual(warned("0.53.0", "0.53.0"), []);
  assert.deepEqual(warned("0.53.0", "0.53.0+build.1"), [], "a local build of the bridge's version is that version: no skew `oats update` would leave in place");
});

test("piBridgeStepProblem and piBridgeFailure: what the folder holds is read from it after the step", () => {
  const h = host();
  h.bridge(h.defaultDir, "0.52.0");
  const a = h.bridge(join(h.base, "a"), "0.52.0"), b = h.bridge(join(h.base, "b"), "0.52.0");
  const plan = planPiBridges(piBridgeFolders({ env: h.env, launchConfigs: configs(pi("a", { PI_CODING_AGENT_DIR: a }), pi("b", { PI_CODING_AGENT_DIR: b })) }), "0.53.0", { env: h.env });
  const entry = plan[1], display = entry.step.display;
  assert.equal(piBridgeStepProblem(entry, "0.53.0", "exit 1"), "exit 1");
  assert.equal(piBridgeStepProblem(entry, "0.53.0", null), "pi ended without an error, but the bridge there is not 0.53.0");
  const failure = (problem) => piBridgeFailure({ entry, display, problem, notReached: [plan[2]] });
  assert.equal(failure("exit 1"), [
    `step failed in ${a} (launch configuration a): exit 1`,
    "  the bridge there is still 0.52.0",
    `  run it again: ${display}`,
    "  not reached (run `oats update` again for it):",
    `    ${b}  (launch configuration b)`,
  ].join("\n"));
  h.bridge(a, "0.52.5");
  assert.match(failure("exit 1"), /\n {2}the bridge there is now 0\.52\.5\n/);
  h.bridge(a, null, "{");
  assert.match(failure("exit 1"), /\n {2}the bridge there cannot be read \(.*cannot be read as JSON\)\n/);
  rmSync(join(a, "npm"), { recursive: true });
  assert.match(failure("exit 1"), /\n {2}the bridge is now ABSENT there: a pi session started with this folder has no OATS extension until the step succeeds\n/);
  h.bridge(a, "0.53.0");
  assert.equal(piBridgeStepProblem(entry, "0.53.0", null), null);
  // The CLI's own step: no folder was reached.
  assert.equal(piBridgeFailure({ display: "npm install -g @awebai/oats@0.53.0", problem: "exit 1", notReached: [plan[0], plan[1]] }), [
    "step failed: npm install -g @awebai/oats@0.53.0: exit 1",
    "  no pi folder was touched",
    "  not reached (run `oats update` again for them):",
    `    ${h.defaultDir}  (the default)`,
    `    ${a}  (launch configuration a)`,
  ].join("\n"));
  assert.equal(piBridgeFailure({ entry: plan[2], display: "x", problem: "exit 1" }).split("\n").length, 3, "the last folder: nothing was left to reach");
});
