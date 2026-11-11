// awebai/oats#991, #852, #1011: `oats doctor` and `oats update` over every pi folder of a deployment,
// through the real CLI in a fixture deployment, with a fake `pi` and a fake `npm` first on PATH
// and the fixture's HOME. Nothing here reaches the registry or the host's own pi.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureBase } from "./helpers/host-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const KERNEL = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const NEXT = "99.0.0", OLD = "0.40.0";
const SPEC = `npm:@awebai/oats-pi@${NEXT}`;

/** `npm`: `view @awebai/oats version` prints $FAKE_VIEW_STDERR to its error output when it is set,
 *  then answers $FAKE_LATEST, byte for byte and a line ending (exits 17 when $FAKE_VIEW_FAILS is
 *  set); `view @awebai/oats-pi@X version` answers X, or
 *  $FAKE_BRIDGE_ANSWER when it is set, or fails as npm 11 does when $FAKE_BRIDGE_UNLISTED is set,
 *  with a coloured error (prints nothing and exits 0, as an older npm does, when it is "quiet"); `install -g` exits
 *  $FAKE_NPM_INSTALL (0). Every call is logged. */
const FAKE_NPM = `#!/bin/sh
echo "npm $*" >> "$FAKE_LOG"
case "$1 $2" in
  "view @awebai/oats") if [ -n "$FAKE_VIEW_STDERR" ]; then printf '%s\\n' "$FAKE_VIEW_STDERR" >&2; fi; if [ -n "$FAKE_VIEW_FAILS" ]; then exit 17; fi; printf '%s\\n' "$FAKE_LATEST"; exit 0 ;;
  "view @awebai/oats-pi@"*)
    if [ "$FAKE_BRIDGE_UNLISTED" = quiet ]; then exit 0; fi
    if [ -n "$FAKE_BRIDGE_UNLISTED" ]; then printf '\\033[31mnpm error code E404\\033[0m\\n' >&2; exit 1; fi
    if [ -n "$FAKE_BRIDGE_ANSWER" ]; then printf '%s\\n' "$FAKE_BRIDGE_ANSWER"; exit 0; fi
    echo "\${2##*@}"; exit 0 ;;
  "install -g") exit "\${FAKE_NPM_INSTALL:-0}" ;;
esac
exit 2
`;
/** `pi install npm:@awebai/oats-pi@X`: writes X as the bridge of its folder, as pi does over an
 *  installed one. In $FAKE_PI_FAILS_IN it fails and leaves the folder as it was; in
 *  $FAKE_PI_REMOVES_IN it fails after removing the bridge; in $FAKE_PI_IDLE_IN it exits 0 and
 *  changes nothing. Any other subcommand is a failure: update runs no `uninstall`. */
const FAKE_PI = `#!/bin/sh
dir="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
echo "pi $* | folder=\${PI_CODING_AGENT_DIR-unset} | prefer_online=\${npm_config_prefer_online-unset}" >> "$FAKE_LOG"
[ "$1" = install ] || exit 2
pkg="$dir/npm/node_modules/@awebai/oats-pi"
if [ "$dir" = "$FAKE_PI_FAILS_IN" ]; then echo "npm error code ETARGET" >&2; exit 1; fi
if [ "$dir" = "$FAKE_PI_REMOVES_IN" ]; then rm -rf "$pkg"; exit 1; fi
if [ "$dir" = "$FAKE_PI_IDLE_IN" ]; then exit 0; fi
mkdir -p "$pkg"
printf '{"name":"@awebai/oats-pi","version":"%s"}\\n' "\${2##*@}" > "$pkg/package.json"
`;

const bridgeFile = (dir) => join(dir, "npm", "node_modules", "@awebai", "oats-pi", "package.json");
const setBridge = (dir, version, text) => { mkdirSync(dirname(bridgeFile(dir)), { recursive: true }); writeFileSync(bridgeFile(dir), text ?? JSON.stringify({ name: "@awebai/oats-pi", version })); return dir; };
const bridgeIn = (dir) => existsSync(bridgeFile(dir)) ? JSON.parse(readFileSync(bridgeFile(dir), "utf8")).version : null;

/** A deployment with `launchConfigs`, the fakes first on PATH, and `run(args, { cwd, env })`:
 *  the CLI, never a terminal, with the calls the fakes logged. */
function fixture(t, launchConfigs = {}) {
  const fx = v2Deployment({ t, local: { "launch-configs": launchConfigs } });
  const bin = join(fx.base, "fake-bin"), log = join(fx.base, "fake.log");
  mkdirSync(bin);
  for (const [name, text] of [["npm", FAKE_NPM], ["pi", FAKE_PI]]) { writeFileSync(join(bin, name), text); chmodSync(join(bin, name), 0o755); }
  const env = { PATH: `${bin}:${fx.env.PATH}`, FAKE_LOG: log, FAKE_LATEST: NEXT, PI_CODING_AGENT_DIR: undefined };
  const run = (args, { cwd = fx.dep, env: extra = {} } = {}) => {
    rmSync(log, { force: true });
    const r = fx.cli(args, { cwd, env: { ...env, ...extra } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  return { ...fx, run, at: (name) => join(fx.base, name), defaultDir: join(fx.env.HOME, ".pi", "agent") };
}
const piConfig = (dir, more = {}) => ({ harness: "pi", env: { PI_CODING_AGENT_DIR: dir }, ...more });
const VIEW_KERNEL = "npm view @awebai/oats version", VIEW_BRIDGE = `npm view @awebai/oats-pi@${NEXT} version --prefer-online`;
const install = (folder) => `pi install ${SPEC} | folder=${folder} | prefer_online=true`;
const lastLine = (text) => text.trimEnd().split("\n").pop();
/** The line under the steps when the CLI's install is of another minor (#1107); the fixture's
 *  NEXT is another major than the kernel under test. */
// #1879: a Desktop above its tested bound holds back what it was not tested with; the last hard-ceiling Desktop refuses.
const desktopFirst = (version) => `An OATS Desktop older than ${version.split(".").slice(0, 2).join(".").replace(/-.*$/, "")} holds actions back with this CLI. `
  + `Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop ${version}. `
  + "(An OATS Desktop of 0.69.17 or older refuses this CLI until then.)";

/** Every kind of folder a deployment can name, beside the default one. */
function everyKind(t) {
  const base = fixtureBase("oats-pif-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const at = (name) => join(base, name);
  const fx = fixture(t, {
    behind: piConfig(at("behind dir")),
    "behind-too": piConfig(at("behind dir")),
    boxed: piConfig(at("boxed"), { executable: "bin/pi-box" }),
    ci: { harness: "pi", env: { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } } },
    "claude-one": { harness: "claude", env: { PI_CODING_AGENT_DIR: at("claude") } },
    current: piConfig(at("current")),
    gone: piConfig(at("gone")),
    linked: piConfig(at("link")),
    rel: piConfig("rel/pi"),
  });
  setBridge(fx.defaultDir, OLD);
  setBridge(at("behind dir"), OLD);
  symlinkSync(at("behind dir"), at("link"));
  setBridge(at("boxed"), OLD);
  setBridge(at("claude"), OLD);
  return { ...fx, at };
}

test("#991 oats doctor: one warning per pi folder whose bridge is not the kernel's version, naming the folder and why it is looked at", (t) => {
  const fx = everyKind(t);
  setBridge(fx.at("current"), KERNEL);
  const r = fx.run(["doctor"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => /pi bridge/.test(l)), [
    `WARNING: version skew — kernel ${KERNEL}, pi bridge ${OLD} in ${fx.defaultDir} (the default); run \`oats update\` (they publish in lockstep)`,
    `WARNING: version skew — kernel ${KERNEL}, pi bridge ${OLD} in ${fx.at("behind dir")} (launch configurations behind, behind-too, linked); run \`oats update\` (they publish in lockstep)`,
    `WARNING: version skew — kernel ${KERNEL}, pi bridge ${OLD} in ${fx.at("boxed")} (launch configuration boxed); run \`oats update\` (they publish in lockstep)`,
    "WARNING: pi bridge not checked — launch configuration ci: PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host, so its pi folder could not be looked at; `oats update` says what to run there",
    'WARNING: pi bridge not checked — launch configuration rel: PI_CODING_AGENT_DIR "rel/pi" is not an absolute path, so its pi folder could not be looked at; `oats update` says what to run there',
  ]);
  assert.deepEqual(r.calls, [], "doctor runs neither pi nor npm");
  // The reference resolves from this shell: the folder it names is then looked at, and it holds no bridge.
  const resolved = fx.run(["doctor"], { env: { PI_CI_DIR: fx.at("ci") } });
  assert.ok(!resolved.stdout.includes("launch configuration ci"), resolved.stdout);
  // This shell's own folder is one of them.
  setBridge(fx.at("shell"), OLD);
  assert.ok(fx.run(["doctor"], { env: { PI_CODING_AGENT_DIR: fx.at("shell") } }).stdout.includes(`pi bridge ${OLD} in ${fx.at("shell")} (this shell's PI_CODING_AGENT_DIR); run \`oats update\``));
});

test("#991 oats doctor: every bridge at the kernel's version, or no bridge at all, says nothing; --json carries no skew", (t) => {
  const fx = fixture(t, { work: piConfig("/nonexistent/oats-pi-folder") });
  const quiet = fx.run(["doctor"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(!/pi bridge|version skew/.test(quiet.stdout), quiet.stdout);
  setBridge(fx.defaultDir, KERNEL);
  assert.ok(!/pi bridge|version skew/.test(fx.run(["doctor"]).stdout));
  setBridge(fx.defaultDir, OLD);
  assert.match(fx.run(["doctor"]).stdout, /\n\nWARNING: version skew — .*\n\n+Workspace/, "the warnings stand apart, above the report");
  const json = fx.run(["doctor", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.ok(!/pi bridge|version skew/.test(json.stdout), "the skew is in the text output only");
});

test("#991 oats doctor: a bridge whose package.json cannot be parsed is a warning, not a crash", (t) => {
  const fx = fixture(t);
  setBridge(fx.defaultDir, null, "{ not json");
  const r = fx.run(["doctor"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`WARNING: pi bridge not checked in ${fx.defaultDir} (the default) — ${bridgeFile(fx.defaultDir)} cannot be read as JSON; \`oats update\` says what to run there`), r.stdout);
});

test("#991 oats update --check: the plan lists every pi folder with the bridge found there and what happens, and runs nothing", (t) => {
  const fx = everyKind(t);
  setBridge(fx.at("current"), NEXT);
  const r = fx.run(["update", "--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    `@awebai/oats  installed: ${KERNEL}  latest: ${NEXT}`,
    "",
    `@awebai/oats-pi ${NEXT} (published in lockstep), by pi folder of ${fx.dep}:`,
    `  ${fx.defaultDir}  (the default)`,
    `    bridge ${OLD}: move to ${NEXT}`,
    `  ${fx.at("behind dir")}  (launch configurations behind, behind-too, linked)`,
    `    bridge ${OLD}: move to ${NEXT}`,
    `  ${fx.at("boxed")}  (launch configuration boxed)`,
    `    bridge ${OLD}: not touched: launch configuration boxed runs its own executable, and \`oats update\` runs no wrapper`,
    `    run there: PI_CODING_AGENT_DIR=${fx.at("boxed")} ${join(fx.dep, "bin/pi-box")} install ${SPEC}`,
    "  (not resolved)  (launch configuration ci)",
    "    not touched: PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host",
    `    run there, where PI_CI_DIR is set: PI_CODING_AGENT_DIR="$PI_CI_DIR" pi install ${SPEC}`,
    `  ${fx.at("current")}  (launch configuration current)`,
    `    bridge ${NEXT}: left alone, already at ${NEXT}`,
    `  ${fx.at("gone")}  (launch configuration gone)`,
    "    no bridge (the folder does not exist): not touched",
    "  (not resolved)  (launch configuration rel)",
    '    not touched: PI_CODING_AGENT_DIR "rel/pi" is not an absolute path',
    "",
    "Update steps:",
    `  npm install -g @awebai/oats@${NEXT}`,
    `  npm_config_prefer_online=true pi install ${SPEC}`,
    `  PI_CODING_AGENT_DIR='${fx.at("behind dir")}' npm_config_prefer_online=true pi install ${SPEC}`,
    "",
    desktopFirst(NEXT),
    "",
    "(--check: not executing)",
    "",
  ].join("\n"));
  // The plan alone: the kernel's latest is asked for, the bridge's own lookup belongs to the run.
  assert.deepEqual(r.calls, [VIEW_KERNEL]);
  assert.equal(bridgeIn(fx.defaultDir), OLD);
  assert.equal(existsSync(fx.at("gone")), false, "a folder is never created");
});

test("#991 oats update, not a terminal and no --yes: the plan and nothing run, as before", (t) => {
  const fx = everyKind(t);
  const r = fx.run(["update"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\nUpdate steps:\n/);
  assert.ok(r.stdout.endsWith(`\n\n${desktopFirst(NEXT)}\n\nNon-interactive: pass --yes to execute, or run the steps yourself.\n`), r.stdout);
  assert.deepEqual(r.calls, [VIEW_KERNEL]);
  assert.equal(bridgeIn(fx.at("behind dir")), OLD);
});

test("#1107 oats update: a patch update of the CLI says nothing of the Desktop; another minor says it under the steps", (t) => {
  const fx = fixture(t);
  setBridge(fx.defaultDir, OLD);
  const [major, minor, patch] = KERNEL.split(/[.+-]/).map(Number);
  const nextPatch = `${major}.${minor}.${patch + 1}`, nextMinor = `${major}.${minor + 1}.0`;
  const steps = (version) => `\nUpdate steps:\n  npm install -g @awebai/oats@${version}\n  npm_config_prefer_online=true pi install npm:@awebai/oats-pi@${version}\n\n`;
  const patchCheck = fx.run(["update", "--check"], { env: { FAKE_LATEST: nextPatch } });
  assert.equal(patchCheck.status, 0, patchCheck.stderr);
  assert.ok(patchCheck.stdout.endsWith(`${steps(nextPatch)}(--check: not executing)\n`), patchCheck.stdout);
  assert.ok(!patchCheck.stdout.includes("OATS Desktop"), patchCheck.stdout);
  const minorCheck = fx.run(["update", "--check"], { env: { FAKE_LATEST: nextMinor } });
  assert.equal(minorCheck.status, 0, minorCheck.stderr);
  assert.ok(minorCheck.stdout.endsWith(`${steps(nextMinor)}${desktopFirst(nextMinor)}\n\n(--check: not executing)\n`), minorCheck.stdout);
  // No CLI step, a bridge to move: nothing of the Desktop either.
  const bridgeOnly = fx.run(["update", "--check"], { env: { FAKE_LATEST: KERNEL } });
  assert.equal(bridgeOnly.status, 0, bridgeOnly.stderr);
  assert.match(bridgeOnly.stdout, /\nUpdate steps:\n/);
  assert.ok(!bridgeOnly.stdout.includes("OATS Desktop"), bridgeOnly.stdout);
});

test("#991 #852 oats update --yes: the bridge's version is seen on the registry first, then each folder is moved with its own PI_CODING_AGENT_DIR, by one install and no uninstall", (t) => {
  const fx = everyKind(t);
  setBridge(fx.at("current"), NEXT);
  const r = fx.run(["update", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [
    VIEW_KERNEL,
    VIEW_BRIDGE,
    `npm install -g @awebai/oats@${NEXT}`,
    install("unset"), // the default folder, and nothing sets one: pi is left to find it
    install(fx.at("behind dir")), // one folder, three configurations, a space in its path: one run, one argument
  ]);
  assert.deepEqual([fx.defaultDir, fx.at("behind dir"), fx.at("current")].map(bridgeIn), [NEXT, NEXT, NEXT]);
  // Not touched: a configuration with its own executable, another harness's folder, and no folder is created.
  assert.equal(bridgeIn(fx.at("boxed")), OLD);
  assert.equal(bridgeIn(fx.at("claude")), OLD);
  assert.equal(existsSync(fx.at("gone")), false);
  assert.ok(r.stdout.includes(`install ${SPEC}\n\n${desktopFirst(NEXT)}\n\n$ ${VIEW_BRIDGE}\n`), r.stdout);
  assert.match(lastLine(r.stdout), new RegExp(`^Updated to ${NEXT.replaceAll(".", "\\.")}\\. 3 pi folders were not touched: see above for what to run there\\. Now verify each deployment: run \`oats doctor\``));
  // Run again, the kernel's version aside: nothing is left to move, and the untouched ones are still named.
  // The bridges just moved are now ahead of the kernel: they are not moved back (#1011).
  const again = fx.run(["update", "--yes"], { env: { FAKE_LATEST: KERNEL } });
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.calls, [VIEW_KERNEL]);
  assert.ok(again.stdout.includes(`  ${fx.defaultDir}  (the default)\n    bridge ${NEXT}: left alone, ahead of ${KERNEL}\n`), again.stdout);
  assert.equal(lastLine(again.stdout), "Nothing for `oats update` to run. 3 pi folders were not touched: see above for what to run there.");
  assert.deepEqual([fx.defaultDir, fx.at("behind dir")].map(bridgeIn), [NEXT, NEXT]);
});

test("#991 oats update: the CLI already at the latest version and one folder's bridge behind: the bridge steps alone", (t) => {
  const fx = fixture(t, { work: piConfig("/nonexistent/oats-pi-folder") });
  setBridge(fx.defaultDir, OLD);
  const r = fx.run(["update", "--yes"], { env: { FAKE_LATEST: KERNEL } });
  assert.equal(r.status, 0, r.stderr);
  const spec = `npm:@awebai/oats-pi@${KERNEL}`;
  assert.match(r.stdout, new RegExp(`\nUpdate steps:\n  npm_config_prefer_online=true pi install ${spec.replaceAll(".", "\\.")}\n\n`));
  assert.deepEqual(r.calls, [VIEW_KERNEL, `npm view @awebai/oats-pi@${KERNEL} version --prefer-online`, `pi install ${spec} | folder=unset | prefer_online=true`]);
  assert.equal(bridgeIn(fx.defaultDir), KERNEL);
  // Now everything is at the target: a folder at it is left alone, nothing is looked up or run.
  const done = fx.run(["update", "--yes"], { env: { FAKE_LATEST: KERNEL } });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`bridge ${KERNEL.replaceAll(".", "\\.")}: left alone, already at`));
  assert.equal(lastLine(done.stdout), "Up to date.");
  assert.deepEqual(done.calls, [VIEW_KERNEL]);
});

test("#991 oats update: nothing to run, and a folder it does not touch is still behind: it says so instead of 'Up to date'", (t) => {
  const fx = fixture(t, { boxed: piConfig("/nonexistent/oats-pi-folder", { executable: "/opt/pi-box" }), ci: { harness: "pi", env: { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } } } });
  const r = fx.run(["update", "--yes"], { env: { FAKE_LATEST: KERNEL } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastLine(r.stdout), "Nothing for `oats update` to run. 1 pi folder was not touched: see above for what to run there.");
  assert.deepEqual(r.calls, [VIEW_KERNEL]);
});

test("#852 oats update --yes: the bridge's version does not resolve on the registry: nothing is removed or run, in any folder", (t) => {
  for (const [unlisted, answer] of [["npm-11", "exit 1"], ["quiet", "no answer"]]) {
    const fx = everyKind(t);
    const r = fx.run(["update", "--yes"], { env: { FAKE_BRIDGE_UNLISTED: unlisted } });
    assert.equal(r.status, 1, unlisted);
    assert.ok(r.stderr.includes(`oats: @awebai/oats-pi@${NEXT} was not seen on the registry (npm view: ${answer}): a version is listed a few minutes after it is published. Nothing was changed, and every bridge is in place. Run \`oats update\` again in a few minutes.`), r.stderr);
    assert.ok(!r.stderr.includes("\u001b"), "npm's own error output of the lookup is not sent to the terminal");
    // Not the CLI's own install either: no kernel ahead of its bridges.
    assert.deepEqual(r.calls, [VIEW_KERNEL, VIEW_BRIDGE], unlisted);
    assert.deepEqual([fx.defaultDir, fx.at("behind dir"), fx.at("boxed")].map(bridgeIn), [OLD, OLD, OLD]);
  }
});

/** Three folders update moves, in order: the default, `a`, `b`. */
function threeFolders(t) {
  const fx = fixture(t);
  writeFileSync(join(fx.dep, "oats-local.yaml"), readFileSync(join(fx.dep, "oats-local.yaml"), "utf8").replace(/launch-configs:.*\n/, `launch-configs:\n  a:\n    harness: pi\n    env:\n      PI_CODING_AGENT_DIR: ${fx.at("pi-a")}\n  b:\n    harness: pi\n    env:\n      PI_CODING_AGENT_DIR: ${fx.at("pi-b")}\n`));
  for (const dir of [fx.defaultDir, fx.at("pi-a"), fx.at("pi-b")]) setBridge(dir, OLD);
  return fx;
}

test("#852 oats update --yes: pi fails its install in the second of three folders: that folder and step are named, the first is done, the third is listed as not reached", (t) => {
  const fx = threeFolders(t);
  const r = fx.run(["update", "--yes"], { env: { FAKE_PI_FAILS_IN: fx.at("pi-a") } });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.endsWith([
    `oats: step failed in ${fx.at("pi-a")} (launch configuration a): exit 1`,
    `  the bridge there is still ${OLD}`,
    `  run it again: PI_CODING_AGENT_DIR=${fx.at("pi-a")} npm_config_prefer_online=true pi install ${SPEC}`,
    "  not reached (run `oats update` again for it):",
    `    ${fx.at("pi-b")}  (launch configuration b)`,
    "",
  ].join("\n")), r.stderr);
  assert.deepEqual([fx.defaultDir, fx.at("pi-a"), fx.at("pi-b")].map(bridgeIn), [NEXT, OLD, OLD]);
  // It stopped at the first failure.
  assert.deepEqual(r.calls.slice(3), [install("unset"), install(fx.at("pi-a"))]);
});

test("#852 oats update --yes: a failed step that left no bridge says the bridge is absent; one that ended well without moving it is a failure too", (t) => {
  const fx = threeFolders(t);
  const removed = fx.run(["update", "--yes"], { env: { FAKE_PI_REMOVES_IN: fx.at("pi-b") } });
  assert.equal(removed.status, 1);
  assert.ok(removed.stderr.includes(`oats: step failed in ${fx.at("pi-b")} (launch configuration b): exit 1\n  the bridge is now ABSENT there: a pi session started with this folder has no OATS extension until the step succeeds\n  run it again: PI_CODING_AGENT_DIR=${fx.at("pi-b")} npm_config_prefer_online=true pi install ${SPEC}\n`), removed.stderr);
  assert.ok(!removed.stderr.includes("not reached"), "it was the last folder");
  // The folder now holds no bridge, so update does not touch it: a first bridge is never installed.
  setBridge(fx.at("pi-b"), OLD);
  const idle = fx.run(["update", "--yes"], { env: { FAKE_PI_IDLE_IN: fx.at("pi-b"), FAKE_LATEST: KERNEL } });
  assert.equal(idle.status, 1);
  assert.ok(idle.stderr.includes(`oats: step failed in ${fx.at("pi-b")} (launch configuration b): pi ended without an error, but the bridge there is not ${KERNEL}\n  the bridge there is still ${OLD}\n`), idle.stderr);
});

test("#852 oats update --yes: the CLI's own install fails: no pi folder is touched, and each is listed as not reached", (t) => {
  const fx = threeFolders(t);
  const r = fx.run(["update", "--yes"], { env: { FAKE_NPM_INSTALL: "1" } });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`oats: step failed: npm install -g @awebai/oats@${NEXT}: exit 1\n  no pi folder was touched\n  not reached (run \`oats update\` again for them):\n    ${fx.defaultDir}  (the default)\n    ${fx.at("pi-a")}  (launch configuration a)\n    ${fx.at("pi-b")}  (launch configuration b)\n`), r.stderr);
  assert.deepEqual([fx.defaultDir, fx.at("pi-a"), fx.at("pi-b")].map(bridgeIn), [OLD, OLD, OLD]);
});

test("#991 oats update with no deployment in reach: the default folder and this shell's, and the last line says no launch configuration was looked at", (t) => {
  const fx = everyKind(t);
  const shell = setBridge(fx.at("shell"), OLD);
  const none = `No launch configuration was looked at: no deployment at or above ${fx.base}. Run \`oats update\` in each deployment, or with --dir <deployment>.`;
  const check = fx.run(["update", "--check"], { cwd: fx.base, env: { PI_CODING_AGENT_DIR: shell } });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, [
    `@awebai/oats  installed: ${KERNEL}  latest: ${NEXT}`,
    "",
    `@awebai/oats-pi ${NEXT} (published in lockstep), by pi folder:`,
    `  ${fx.defaultDir}  (the default)`,
    `    bridge ${OLD}: move to ${NEXT}`,
    `  ${shell}  (this shell's PI_CODING_AGENT_DIR)`,
    `    bridge ${OLD}: move to ${NEXT}`,
    `  ${none}`,
    "",
    "Update steps:",
    `  npm install -g @awebai/oats@${NEXT}`,
    `  PI_CODING_AGENT_DIR=${fx.defaultDir} npm_config_prefer_online=true pi install ${SPEC}`,
    `  PI_CODING_AGENT_DIR=${shell} npm_config_prefer_online=true pi install ${SPEC}`,
    "",
    desktopFirst(NEXT),
    "",
    "(--check: not executing)",
    "",
    none,
    "",
  ].join("\n"));
  const r = fx.run(["update", "--yes"], { cwd: fx.base, env: { PI_CODING_AGENT_DIR: shell } });
  assert.equal(r.status, 0, r.stderr);
  // With this shell's variable set, the default folder is named to pi: it would otherwise move the shell's twice.
  assert.deepEqual(r.calls.slice(3), [install(fx.defaultDir), install(shell)]);
  assert.deepEqual([fx.defaultDir, shell, fx.at("behind dir")].map(bridgeIn), [NEXT, NEXT, OLD]);
  assert.equal(lastLine(r.stdout), none, "an operator reads the end");
  // The same last line when nothing is left to run, and under a failure.
  setBridge(fx.defaultDir, KERNEL);
  assert.deepEqual(fx.run(["update", "--yes"], { cwd: fx.base, env: { FAKE_LATEST: KERNEL } }).stdout.trimEnd().split("\n").slice(-3), ["Up to date.", "", none]);
  setBridge(fx.defaultDir, OLD);
  const failed = fx.run(["update", "--yes"], { cwd: fx.base, env: { FAKE_BRIDGE_UNLISTED: "1" } });
  assert.equal(failed.status, 1);
  assert.equal(lastLine(failed.stderr), none);
  // And when npm cannot say what the latest version is: nothing was looked at at all.
  const early = fx.run(["update", "--check"], { cwd: fx.base, env: { FAKE_VIEW_FAILS: "1" } });
  assert.equal(early.status, 1);
  assert.match(early.stderr, /^oats: cannot check npm for the latest version: exit 17\n/);
  assert.equal(lastLine(early.stderr), none);
  assert.equal(early.stdout, "");
});

test("#991 oats update --dir: the deployment named, from anywhere; a directory with no deployment at or above it is refused and nothing runs", (t) => {
  const fx = everyKind(t);
  const inside = fx.run(["update", "--check"]);
  const named = fx.run(["update", "--check", "--dir", join(fx.dep, "agents")], { cwd: fx.base });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stdout, inside.stdout, "the deployment at or above --dir, as at or above the working directory");
  const refused = fx.run(["update", "--yes", "--dir", fx.at("nowhere")], { cwd: fx.dep });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^oats: no oats-local\.yaml found walking up from .*nowhere/);
  assert.deepEqual(refused.calls, []);
  // A 0.25 configuration there is no deployment either: refused the same, not "one that does not load".
  mkdirSync(fx.at("legacy"));
  writeFileSync(join(fx.at("legacy"), "oats-config.yaml"), "agents: {}\n");
  const legacy = fx.run(["update", "--yes", "--dir", fx.at("legacy")], { cwd: fx.dep });
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /^oats: no oats-local\.yaml found walking up from .*legacy/);
  assert.deepEqual(legacy.calls, [], "neither npm nor pi ran");
  assert.equal(bridgeIn(fx.defaultDir), OLD);
  // Without --dir, from inside it, the update goes on with the default folder and says why nothing else was looked at.
  const inLegacy = fx.run(["update", "--check"], { cwd: fx.at("legacy") });
  assert.equal(inLegacy.status, 0, inLegacy.stderr);
  assert.match(lastLine(inLegacy.stdout), /^No launch configuration was looked at: the deployment does not load \(no oats-local\.yaml found walking up from .*legacy/);
  const help = fx.run(["update", "--help"]);
  assert.match(help.stdout, /oats update \[--check\] \[--yes\][\s\S]*\[--dir <deployment>\]/);
});

test("#991 oats update in a deployment whose launch configurations do not load: it goes on with the default folder and says so, first and last", (t) => {
  const fx = everyKind(t);
  const local = join(fx.dep, "oats-local.yaml");
  writeFileSync(local, readFileSync(local, "utf8").replace("harness: claude", "harness: not-a-harness"));
  const r = fx.run(["update", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  const last = lastLine(r.stdout);
  assert.match(last, /^No launch configuration was looked at: the .* not load \(.*\)\. Run `oats doctor` there, then `oats update` again\.$/);
  assert.ok(r.stdout.includes(`  ${fx.defaultDir}  (the default)\n    bridge ${OLD}: move to ${NEXT}\n  ${last}\n`), r.stdout);
  assert.deepEqual(r.calls.slice(3), [install("unset")]);
  assert.deepEqual([fx.defaultDir, fx.at("behind dir")].map(bridgeIn), [NEXT, OLD]);
});

test("#991 launch configurations the kernel refuses (two defaults for pi): doctor warns that only the default folder was looked at, update says so first and last", (t) => {
  const fx = fixture(t, { a: piConfig("/nonexistent/oats-pi-a", { default: true }), b: piConfig("/nonexistent/oats-pi-b", { default: true }) });
  setBridge(fx.defaultDir, OLD);
  const why = `launch configurations "a" and "b" in ${join(fx.dep, "oats-local.yaml")} are both default: true for pi`;
  const doctor = fx.run(["doctor"]);
  assert.deepEqual(doctor.stdout.split("\n").filter((l) => /pi bridge/.test(l)).map((l) => l.includes(why) ? l.slice(0, l.indexOf(why) + why.length) : l), [
    `WARNING: version skew — kernel ${KERNEL}, pi bridge ${OLD} in ${fx.defaultDir} (the default); run \`oats update\` (they publish in lockstep)`,
    `WARNING: pi bridge — the launch configurations could not be read, so only the default pi folder and this shell's were looked at: ${why}`,
  ]);
  const update = fx.run(["update", "--check"]);
  assert.equal(update.status, 0, update.stderr);
  assert.ok(lastLine(update.stdout).startsWith(`No launch configuration was looked at: the launch configurations of ${fx.dep} do not load (${why}`), update.stdout);
  assert.ok(update.stdout.includes(`by pi folder:\n  ${fx.defaultDir}  (the default)\n    bridge ${OLD}: move to ${NEXT}\n  No launch configuration was looked at`), update.stdout);
});

test("#991 oats update: a bridge whose package.json cannot be parsed is listed with that problem and not touched", (t) => {
  const fx = fixture(t);
  setBridge(fx.defaultDir, null, "{ not json");
  const r = fx.run(["update", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`  ${fx.defaultDir}  (the default)\n    bridge not read: not touched: ${bridgeFile(fx.defaultDir)} cannot be read as JSON\n    run there: PI_CODING_AGENT_DIR=${fx.defaultDir} pi install ${SPEC}\n`), r.stdout);
  assert.deepEqual(r.calls, [VIEW_KERNEL, `npm install -g @awebai/oats@${NEXT}`], "no bridge to move: no lookup of it, and no pi");
  assert.equal(readFileSync(bridgeFile(fx.defaultDir), "utf8"), "{ not json");
});

// ---------- awebai/oats#1011: forward only, and the registry's answer checked ----------

const KERNEL_SPEC = `npm:@awebai/oats-pi@${KERNEL}`;
const VIEW_KERNEL_BRIDGE = `npm view @awebai/oats-pi@${KERNEL} version --prefer-online`;
const AHEAD_NOTE = `  A bridge moves to ${KERNEL} only if @awebai/oats-pi@${KERNEL} is published: the installed kernel is ahead of the registry's ${OLD}, and a run checks that before any step.`;

test("#1011 oats update: an installed version above the registry's gives no CLI step, and one line says so; a bridge behind the installed kernel moves to it, one ahead is left alone", (t) => {
  const fx = fixture(t, { ahead: piConfig("{AHEAD}"), behind: piConfig("{BEHIND}") });
  const local = join(fx.dep, "oats-local.yaml");
  writeFileSync(local, readFileSync(local, "utf8").replace("{AHEAD}", fx.at("pi-ahead")).replace("{BEHIND}", fx.at("pi-behind")));
  setBridge(fx.defaultDir, KERNEL);
  setBridge(fx.at("pi-ahead"), NEXT);
  setBridge(fx.at("pi-behind"), OLD);
  // The registry lists an older CLI than the one installed: a checkout, or a build not yet published.
  const env = { FAKE_LATEST: OLD };
  const check = fx.run(["update", "--check"], { env });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, [
    `@awebai/oats  installed: ${KERNEL}  latest: ${OLD}`,
    `The installed ${KERNEL} is ahead of the registry's ${OLD}: nothing to do for the CLI.`,
    "",
    `@awebai/oats-pi ${KERNEL} (published in lockstep), by pi folder of ${fx.dep}:`,
    `  ${fx.defaultDir}  (the default)`,
    `    bridge ${KERNEL}: left alone, already at ${KERNEL}`,
    `  ${fx.at("pi-ahead")}  (launch configuration ahead)`,
    `    bridge ${NEXT}: left alone, ahead of ${KERNEL}`,
    `  ${fx.at("pi-behind")}  (launch configuration behind)`,
    `    bridge ${OLD}: move to ${KERNEL}`,
    // The plan makes no lookup: it says what the move depends on, not whether the version is published.
    AHEAD_NOTE,
    "",
    "Update steps:",
    `  PI_CODING_AGENT_DIR=${fx.at("pi-behind")} npm_config_prefer_online=true pi install ${KERNEL_SPEC}`,
    "",
    "(--check: not executing)",
    "",
  ].join("\n"));
  assert.deepEqual(check.calls, [VIEW_KERNEL], "--check prints the plan and runs nothing");
  const r = fx.run(["update", "--yes"], { env });
  assert.equal(r.status, 0, r.stderr);
  // No `npm install -g` of the older CLI; the bridge's lookup is for the installed kernel's version.
  assert.deepEqual(r.calls, [VIEW_KERNEL, VIEW_KERNEL_BRIDGE, `pi install ${KERNEL_SPEC} | folder=${fx.at("pi-behind")} | prefer_online=true`]);
  assert.deepEqual([fx.defaultDir, fx.at("pi-ahead"), fx.at("pi-behind")].map(bridgeIn), [KERNEL, NEXT, KERNEL]);
  assert.match(lastLine(r.stdout), new RegExp(`^Updated to ${KERNEL.replaceAll(".", "\\.")}\\. Now verify`));
  assert.ok(r.stdout.includes(`\n${AHEAD_NOTE}\n\nUpdate steps:\n`), "the same line in a run's plan");
  // Nothing left to move, with the CLI and a bridge ahead: it runs nothing, and does not say "Up to date".
  const done = fx.run(["update", "--yes"], { env });
  assert.equal(done.status, 0, done.stderr);
  assert.ok(!done.stdout.includes("only if"), "no move, no such line");
  assert.deepEqual(done.calls, [VIEW_KERNEL]);
  assert.equal(lastLine(done.stdout), "Nothing for `oats update` to run.");
  assert.deepEqual([fx.defaultDir, fx.at("pi-ahead"), fx.at("pi-behind")].map(bridgeIn), [KERNEL, NEXT, KERNEL]);
});

test("#1011 oats update: the CLI moves to the registry's newer version, and a bridge ahead of that version is left alone", (t) => {
  const fx = fixture(t);
  setBridge(fx.defaultDir, "100.0.0-rc.1");
  const r = fx.run(["update", "--yes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`    bridge 100.0.0-rc.1: left alone, ahead of ${NEXT}\n\nUpdate steps:\n  npm install -g @awebai/oats@${NEXT}\n`), r.stdout);
  assert.deepEqual(r.calls, [VIEW_KERNEL, `npm install -g @awebai/oats@${NEXT}`], "no bridge moves: no lookup of it, and no pi");
  assert.equal(bridgeIn(fx.defaultDir), "100.0.0-rc.1");
});

test("#1011 oats update --yes: the installed kernel is ahead of the registry and its bridge is not published: the message says so, not to wait a few minutes", (t) => {
  for (const [unlisted, answer] of [["npm-11", "exit 1"], ["quiet", "no answer"]]) {
    const fx = fixture(t);
    setBridge(fx.defaultDir, OLD);
    const r = fx.run(["update", "--yes"], { env: { FAKE_LATEST: OLD, FAKE_BRIDGE_UNLISTED: unlisted } });
    assert.equal(r.status, 1, unlisted);
    assert.ok(r.stderr.includes(`oats: @awebai/oats-pi@${KERNEL} was not seen on the registry (npm view: ${answer}): the installed kernel ${KERNEL} is ahead of the registry's ${OLD}, so its bridge may not be published. Nothing was changed, and every bridge is in place. Run \`oats update\` again once npm lists ${KERNEL}.`), r.stderr);
    assert.ok(!r.stderr.includes("few minutes"), r.stderr);
    assert.deepEqual(r.calls, [VIEW_KERNEL, VIEW_KERNEL_BRIDGE], unlisted);
    assert.equal(bridgeIn(fx.defaultDir), OLD);
  }
});

/** Answers that are not one version, each with how it is shown: empty, two lines, a version with
 *  trailing text, the JSON array npm prints for a range, an ANSI sequence, a very long line. */
const BAD_ANSWERS = [
  ["", "nothing"],
  [`${NEXT}\n${OLD}`, JSON.stringify(`${NEXT}\n${OLD}`)],
  [`${NEXT} (latest)`, `"${NEXT} (latest)"`],
  [`[ '${OLD}', '${NEXT}' ]`, `"[ '${OLD}', '${NEXT}' ]"`],
  [`\u001b[31m${NEXT}\u001b[0m`, `"\\u001b[31m${NEXT}\\u001b[0m"`],
  [`${NEXT}-${"a".repeat(5000)}`, `"${NEXT}-${"a".repeat(79 - 2 - NEXT.length)}…`],
  [`v${NEXT}`, `"v${NEXT}"`],
  [`${NEXT}; touch pwned`, `"${NEXT}; touch pwned"`],
];

test("#1011 oats update: an answer of the registry that is not one version stops the update before any step, with nothing changed and nothing of it on the screen", (t) => {
  const fx = everyKind(t);
  for (const [answer, shown] of BAD_ANSWERS) for (const mode of ["--yes", "--check"]) {
    const r = fx.run(["update", mode], { env: { FAKE_LATEST: answer } });
    assert.equal(r.status, 1, shown);
    assert.equal(r.stdout, "", "no plan, no step: nothing the registry printed reaches the screen unchecked");
    assert.equal(r.stderr, `oats: \`npm view @awebai/oats version\` answered ${shown}, which is not a version. Nothing was changed. Run \`oats update\` again.\n`);
    assert.ok(!r.stderr.includes("\u001b"), "no control character reaches the terminal");
    assert.deepEqual(r.calls, [VIEW_KERNEL], shown);
    assert.deepEqual([fx.defaultDir, fx.at("behind dir"), fx.at("boxed")].map(bridgeIn), [OLD, OLD, OLD]);
  }
  assert.equal(existsSync(join(fx.dep, "pwned")), false);
  // With no deployment in reach, the refusal still ends with what was not looked at.
  const outside = fx.run(["update", "--yes"], { cwd: fx.base, env: { FAKE_LATEST: "latest" } });
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /^oats: `npm view @awebai\/oats version` answered "latest", which is not a version\. Nothing was changed\. Run `oats update` again\.\nNo launch configuration was looked at: /);
});

test("#1011 oats update: what npm prints to its error output during the lookup never reaches the terminal as it came", (t) => {
  const fx = everyKind(t);
  const noise = `\u001b[2Juntrusted \u009b31m${"x".repeat(5000)}`;
  // The lookup ends well: its error output is dropped, and the plan is the plan.
  const fine = fx.run(["update", "--check"], { env: { FAKE_VIEW_STDERR: noise } });
  assert.equal(fine.status, 0, fine.stderr);
  assert.equal(fine.stderr, "");
  assert.equal(fine.stdout, fx.run(["update", "--check"]).stdout);
  for (const mode of ["--yes", "--check"]) {
    // It ends well with an answer that is not a version: the refusal alone.
    const refused = fx.run(["update", mode], { env: { FAKE_VIEW_STDERR: noise, FAKE_LATEST: "not a version" } });
    assert.equal(refused.status, 1);
    assert.equal(refused.stderr, "oats: `npm view @awebai/oats version` answered \"not a version\", which is not a version. Nothing was changed. Run `oats update` again.\n");
    // It fails: how it ended, then what npm said, bounded, with its control characters shown or replaced.
    const failed = fx.run(["update", mode], { env: { FAKE_VIEW_STDERR: noise, FAKE_VIEW_FAILS: "1" } });
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr, `oats: cannot check npm for the latest version: exit 17: "\\u001b[2Juntrusted \uFFFD31m${"x".repeat(300 - 1 - '"\\u001b[2Juntrusted \uFFFD31m'.length)}…\n`);
    for (const r of [refused, failed]) {
      assert.equal(r.stdout, "");
      assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(r.stderr), "no control character but the line ending");
      assert.deepEqual(r.calls, [VIEW_KERNEL], "no lookup of the bridge, no install");
    }
  }
  assert.deepEqual([fx.defaultDir, fx.at("behind dir"), fx.at("boxed")].map(bridgeIn), [OLD, OLD, OLD]);
});

test("#1011 oats update --yes: the bridge's own lookup answers something that is not one version: nothing is run, and the message names that lookup", (t) => {
  const fx = everyKind(t);
  for (const [answer, shown] of BAD_ANSWERS.slice(1)) {
    const r = fx.run(["update", "--yes"], { env: { FAKE_BRIDGE_ANSWER: answer } });
    assert.equal(r.status, 1, shown);
    assert.equal(lastLine(r.stderr), `oats: \`${VIEW_BRIDGE}\` answered ${shown}, which is not a version. Nothing was changed, and every bridge is in place. Run \`oats update\` again.`);
    assert.ok(!r.stderr.includes("\u001b"));
    // Not the CLI's own install either.
    assert.deepEqual(r.calls, [VIEW_KERNEL, VIEW_BRIDGE], shown);
    assert.deepEqual([fx.defaultDir, fx.at("behind dir"), fx.at("boxed")].map(bridgeIn), [OLD, OLD, OLD]);
  }
  // Another version than the one asked for is "not seen", as before, and the checked value is what is printed.
  const other = fx.run(["update", "--yes"], { env: { FAKE_BRIDGE_ANSWER: OLD } });
  assert.equal(other.status, 1);
  assert.ok(other.stderr.includes(`oats: @awebai/oats-pi@${NEXT} was not seen on the registry (npm view: it answered ${OLD}): a version is listed a few minutes after it is published.`), other.stderr);
  assert.deepEqual(other.calls, [VIEW_KERNEL, VIEW_BRIDGE]);
});

test("#1011 oats update: a folder named only by wrapped launch configurations gets one by-hand command per distinct executable, each with the configurations it is for", (t) => {
  const dir = "/nonexistent/oats-pi-boxed";
  const fx = fixture(t, {
    "box-a": piConfig(dir, { executable: "/opt/pi-box" }),
    "box-b": piConfig(dir, { executable: "bin/other box" }),
    "box-c": piConfig(dir, { executable: "/opt/pi-box" }),
    "same-a": piConfig("/nonexistent/oats-pi-same", { executable: "/opt/pi-box" }),
    "same-b": piConfig("/nonexistent/oats-pi-same", { executable: "/opt/pi-box" }),
    "mixed-box": piConfig("/nonexistent/oats-pi-mixed", { executable: "/opt/pi-box" }),
    "mixed-plain": piConfig("/nonexistent/oats-pi-mixed"),
    ci: { harness: "pi", executable: "/opt/ci-box", env: { PI_CODING_AGENT_DIR: { fromEnv: "PI_CI_DIR" } } },
  });
  // The configurations are written with placeholders, then pointed at the fixture's folders.
  const boxed = setBridge(fx.at("boxed"), OLD), same = setBridge(fx.at("same"), OLD), mixed = setBridge(fx.at("mixed"), null, "{");
  const local = join(fx.dep, "oats-local.yaml");
  writeFileSync(local, readFileSync(local, "utf8").replaceAll(dir, boxed).replaceAll("/nonexistent/oats-pi-same", same).replaceAll("/nonexistent/oats-pi-mixed", mixed));
  const r = fx.run(["update", "--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").slice(5, 17), [
    `  ${boxed}  (launch configurations box-a, box-b, box-c)`,
    `    bridge ${OLD}: not touched: launch configurations box-a, box-b, box-c run their own executable, and \`oats update\` runs no wrapper`,
    `    run there, for launch configurations box-a, box-c: PI_CODING_AGENT_DIR=${boxed} /opt/pi-box install ${SPEC}`,
    `    run there, for launch configuration box-b: PI_CODING_AGENT_DIR=${boxed} '${join(fx.dep, "bin/other box")}' install ${SPEC}`,
    "  (not resolved)  (launch configuration ci)",
    "    not touched: PI_CODING_AGENT_DIR references PI_CI_DIR, not set on this host",
    `    run there, where PI_CI_DIR is set: PI_CODING_AGENT_DIR="$PI_CI_DIR" /opt/ci-box install ${SPEC}`,
    // One wrapped and one plain configuration: not wrapped, the plain `pi`.
    `  ${mixed}  (launch configurations mixed-box, mixed-plain)`,
    `    bridge not read: not touched: ${bridgeFile(mixed)} cannot be read as JSON`,
    `    run there: PI_CODING_AGENT_DIR=${mixed} pi install ${SPEC}`,
    // Two configurations, one executable: one command.
    `  ${same}  (launch configurations same-a, same-b)`,
    `    bridge ${OLD}: not touched: launch configurations same-a, same-b run their own executable, and \`oats update\` runs no wrapper`,
  ]);
  assert.ok(r.stdout.includes(`runs no wrapper\n    run there: PI_CODING_AGENT_DIR=${same} /opt/pi-box install ${SPEC}\n\nUpdate steps:\n  npm install -g @awebai/oats@${NEXT}\n\n`), r.stdout);
  // A folder a plain configuration also names is moved with the plain `pi`, as before.
  setBridge(mixed, OLD);
  const run = fx.run(["update", "--yes"]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.slice(3), [install(mixed)]);
  assert.deepEqual([boxed, same, mixed].map(bridgeIn), [OLD, OLD, NEXT]);
});

test("#1011 oats doctor: a bridge ahead of the kernel is still a skew, and the warning says what ends it, not to run `oats update`", (t) => {
  const fx = fixture(t, { work: piConfig("{WORK}") });
  const local = join(fx.dep, "oats-local.yaml");
  writeFileSync(local, readFileSync(local, "utf8").replace("{WORK}", fx.at("pi-work")));
  setBridge(fx.defaultDir, NEXT);
  setBridge(fx.at("pi-work"), OLD);
  const r = fx.run(["doctor"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => /pi bridge/.test(l)), [
    `WARNING: version skew — kernel ${KERNEL}, pi bridge ${NEXT} in ${fx.defaultDir} (the default); the bridge is ahead of the kernel, and \`oats update\` never moves a bridge back. The skew ends when the kernel is at ${NEXT} (\`oats update\` moves it once npm lists that version), or when the kernel's bridge is installed there by hand (docs/upgrading.md, "By hand")`,
    `WARNING: version skew — kernel ${KERNEL}, pi bridge ${OLD} in ${fx.at("pi-work")} (launch configuration work); run \`oats update\` (they publish in lockstep)`,
  ]);
  assert.deepEqual(r.calls, []);
  // The pointer names a heading the page has.
  assert.match(readFileSync(new URL("../docs/upgrading.md", import.meta.url), "utf8"), /^## By hand$/m);
});
