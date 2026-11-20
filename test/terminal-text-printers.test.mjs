// awebai/oats#1006: the plan notes, the WARNING lines of spawn (local and routed), of the session
// commands and of doctor, and the retire's lines for recovery, extra trees and warnings (local and
// routed) spell, in text, every character of the kernel's refused set that a terminal would act on
// (lib/refused-text.mjs terminalText): a name cannot clear the screen, write a line of its own or
// reverse what follows it. The JSON of the same command holds the text as it is. Every case runs the
// real CLI: in a fixture deployment, or, for the routed commands, against a fake host.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { terminalText } from "../lib/refused-text.mjs";

/** Printed as it is, this clears the screen, writes a line of its own and reverses what follows. */
const HOSTILE = "\x1b[2J\nRetired everything‮";
const SPELLED = "\\u{1b}[2J\\u{a}Retired everything\\u{202e}";
/** For a path Git has to read: Git takes a newline in a tree's path as the end of a record. */
const HOSTILE_PATH = "\x1b[2J-here‮";
/** A branch name: Git refuses every control character in one, not a bidi override. */
const BIDI = "‮";
const RAW = /[\x1b‮]/u;
const KERNEL = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const linesWith = (text, needle) => text.split("\n").filter((line) => line.includes(needle));
/** A command's JSON on stdout, printed on one line or several; an envelope's result, else the document. */
const answer = (r) => { const doc = JSON.parse(r.stdout); return doc.schemaVersion === 1 && "result" in doc ? doc.result : doc; };

test("the fixture premise: terminalText spells the hostile text as these tests expect it", () => {
  assert.equal(terminalText(HOSTILE), SPELLED);
  assert.equal(terminalText(HOSTILE_PATH), "\\u{1b}[2J-here\\u{202e}");
});

/** Soul `dev` (worktree) with capability acme.warns, whose spawn and launch hooks answer a warning
 *  that holds HOSTILE. */
function warningDeployment(t) {
  const hook = (event) => `console.log(JSON.stringify({ warning: ${JSON.stringify(`${event} hook says ${HOSTILE}`)} }));\n`;
  return v2Deployment({
    t,
    souls: { dev: { soul: { work: "worktree", capabilities: { "acme.warns": { from: "here" } } }, agents: "# Dev\n" } },
    capabilities: { "acme.warns": { manifest: { description: "warns", hooks: { spawn: "spawn.mjs", launch: "launch.mjs" } }, files: { "spawn.mjs": hook("spawn"), "launch.mjs": hook("launch") } } },
  });
}

test("oats spawn: a hook's warning is spelled on its WARNING line, and the spawn's JSON holds it as the hook wrote it", (t) => {
  const fx = warningDeployment(t);
  const text = fx.cli(["spawn", "dev", "--purpose", "text", "--no-launch"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.deepEqual(linesWith(text.stdout, "WARNING"), [`  WARNING: spawn hook says ${SPELLED}`]);
  assert.doesNotMatch(text.stdout + text.stderr, RAW, "no escape and no bidi override reaches the terminal");
  const json = fx.cli(["spawn", "dev", "--purpose", "json", "--no-launch", "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.ok(json.json().result.warnings.includes(`spawn hook says ${HOSTILE}`), JSON.stringify(json.json().result.warnings));
});

test("oats session start: a launch hook's warning is spelled on its WARNING line on stderr, and the start's JSON holds it as the hook wrote it", (t) => {
  const fx = warningDeployment(t);
  const homes = ["text", "json"].map((purpose) => {
    const r = fx.cli(["spawn", "dev", "--purpose", purpose, "--no-launch", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.json().result.home;
  });
  const text = fx.cli(["session", "start", "--home", homes[0]]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.deepEqual(linesWith(text.stderr, "WARNING"), [`  WARNING: launch hook says ${SPELLED}`]);
  assert.doesNotMatch(text.stderr, RAW, "no escape and no bidi override reaches the terminal");
  assert.ok(JSON.parse(text.stdout).warnings.includes(`launch hook says ${HOSTILE}`), "the result printed on stdout is the JSON, as it is");
  const json = fx.cli(["session", "start", "--home", homes[1], "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.ok(json.json().result.warnings.includes(`launch hook says ${HOSTILE}`), JSON.stringify(json.json().result.warnings));
});

test("oats doctor: the version-skew WARNING spells the pi folder it names", (t) => {
  const fx = v2Deployment({ t });
  const folder = join(fx.base, `pi-${HOSTILE}`);
  const bridge = join(folder, "npm", "node_modules", "@awebai", "oats-pi", "package.json");
  mkdirSync(dirname(bridge), { recursive: true });
  writeFileSync(bridge, JSON.stringify({ name: "@awebai/oats-pi", version: "0.40.0" }));
  const r = fx.cli(["doctor"], { env: { PI_CODING_AGENT_DIR: folder } });
  assert.deepEqual(linesWith(r.stdout, "pi bridge 0.40.0"), [`WARNING: version skew — kernel ${KERNEL}, pi bridge 0.40.0 in ${terminalText(folder)} (this shell's PI_CODING_AGENT_DIR); run \`oats update\` (they publish in lockstep)`]);
  assert.doesNotMatch(linesWith(r.stdout, "WARNING").join("\n"), RAW, "no escape and no bidi override reaches the terminal");
});

/** A worktree instance whose branch has moved to one named with a bidi override, with an extra tree
 *  `.work-<HOSTILE_PATH>` of the member repository on a branch named so too, and a home file named
 *  with HOSTILE: what the plan's notes and the retire's lines name. */
function hostileHome(fx, purpose) {
  const r = fx.cli(["spawn", "dev", "--purpose", purpose, "--no-launch", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { home, instance } = r.json().result;
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
  git(join(home, "work"), "switch", "-q", "-c", `moved-${BIDI}-${purpose}`);
  const extra = join(home, `.work-${HOSTILE_PATH}`);
  git(fx.member, "worktree", "add", "-q", "-b", `extra-${BIDI}-${purpose}`, extra);
  writeFileSync(join(home, `note-${HOSTILE}.txt`), "a note\n");
  return { home, instance, extra };
}

test("oats retire: the plan's notes, the recovery line, the extra-tree line and the receipt's text spell the names they hold, and the JSON holds them as they are", (t) => {
  const fx = v2Deployment({ t, souls: { dev: { soul: { work: "worktree" }, agents: "# Dev\n" } } });
  const asText = hostileHome(fx, "text");
  const plan = fx.cli(["retire", asText.instance, "--plan"]);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  const notes = linesWith(plan.stdout, "  note: ");
  assert.ok(notes.some((n) => n.includes(`moved-\\u{202e}-text`)), `the drift note names the branch, spelled:\n${plan.stdout}`);
  assert.ok(notes.some((n) => n.includes(`extra worktree ${terminalText(asText.extra)} (branch extra-\\u{202e}-text)`)), `the extra tree's note, spelled:\n${plan.stdout}`);
  assert.doesNotMatch(notes.join("\n"), RAW, "no escape and no bidi override reaches the terminal");
  const planJson = fx.cli(["retire", asText.instance, "--plan", "--json"]);
  assert.ok(answer(planJson).notes.some((n) => n.includes(`extra worktree ${asText.extra} (branch extra-${BIDI}-text)`)), "the plan's JSON holds the path and the branch as they are");

  const retired = fx.cli(["retire", asText.instance]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.deepEqual(linesWith(retired.stdout, "copied from the home").map((l) => l.includes(`note-${SPELLED}.txt`)), [true], retired.stdout);
  assert.deepEqual(linesWith(retired.stdout, "Extra worktree ").map((l) => l.startsWith(`Extra worktree ${terminalText(asText.extra)} `) && l.includes(`(branch extra-\\u{202e}-text)`)), [true], retired.stdout);
  assert.doesNotMatch(retired.stdout + retired.stderr, RAW, "no escape and no bidi override reaches the terminal");

  const asJson = hostileHome(fx, "json");
  const receipt = answer(fx.cli(["retire", asJson.instance, "--json"]));
  assert.ok(receipt.workRecovery.home.paths.some((p) => p.path === `note-${HOSTILE}.txt`), JSON.stringify(receipt.workRecovery.home));
  assert.ok(receipt.extraWorktrees.some((x) => x.path === asJson.extra && x.branch === `extra-${BIDI}-json`), JSON.stringify(receipt.extraWorktrees));
});

// ---- Routed: the host's answer, printed here ----

const CLI = new URL("../bin/oats.mjs", import.meta.url).pathname;
const PROBE = { schemaVersion: 1, name: "@awebai/oats", version: KERNEL, desktopApi: 1, harnesses: ["pi"], sessionBackends: ["tmux"], launchOptions: [], remote: ["spawn", "retire", "status", "session"], features: ["harness", "retire-home"] };
const WS = "/srv/ws";
const HOME = `${WS}/agents/dev/instances/dev-a`;
const ROSTER = { root: `${WS}/agents`, agents: [{ name: "dev", instances: [{ instance: "dev-a", home: HOME, running: false }] }] };
const ok = (result) => JSON.stringify({ schemaVersion: 1, ok: true, result });

/** A fake ssh that runs the remote command word through sh -c, and a fake remote oats that answers
 *  the probe and each subcommand line that holds one of `answers`' patterns. The base is short: the
 *  ssh control socket's path must fit in 104 bytes. */
function routed(t, answers) {
  const dir = mkdtempSync("/tmp/oats-tt-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift; shift\nexec sh -c "$1"\n`);
  const literal = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
  const cases = Object.entries({ [`status --json --dir ${WS}`]: JSON.stringify(ROSTER), [`status --dir ${WS} --json`]: JSON.stringify(ROSTER), ...answers }).map(([pattern, stdout]) => `  *${JSON.stringify(pattern)}*) printf '%s' ${literal(stdout)};;`).join("\n");
  const oatsPath = join(dir, "remote-oats");
  writeFileSync(oatsPath, `#!/bin/sh\ncase "$*" in\n  "version --json") printf '%s' ${literal(JSON.stringify(PROBE))};;\n${cases}\n  *) echo "unexpected: $*" >&2; exit 2;;\nesac\n`);
  chmodSync(join(bin, "ssh"), 0o755); chmodSync(oatsPath, 0o755);
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, OATS_HOME_DIR: join(dir, "oh"), HOME: join(dir, "home") };
  mkdirSync(env.OATS_HOME_DIR, { recursive: true }); mkdirSync(env.HOME, { recursive: true });
  writeFileSync(join(env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: WS, oatsPath } } }));
  return (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: env.HOME });
}

test("oats spawn --server: the host's warnings are spelled on their WARNING lines here, and its JSON is relayed as it is", (t) => {
  const run = routed(t, { "spawn dev": ok({ instance: "dev-a", agent: "dev", home: HOME, work: "worktree", branch: "agents/dev-a", launched: false, warnings: [`the host's hook says ${HOSTILE}`] }) });
  const text = run(["spawn", "dev", "--server", "build", "--purpose", "a", "--no-launch"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  // The host of this file's probe advertises none of the keyed spawn's features, so the route adds its own warning.
  const warnings = linesWith(text.stdout, "WARNING");
  assert.equal(warnings.length, 2, text.stdout);
  assert.equal(warnings[0], `  WARNING: the host's hook says ${SPELLED}`);
  assert.match(warnings[1], /^  WARNING: remote oats \S+ at build-host does not advertise spawn-preview-2, spawn-apply-2, spawn-idempotency-2: /);
  assert.doesNotMatch(text.stdout + text.stderr, RAW, "no escape and no bidi override reaches the terminal");
  const json = run(["spawn", "dev", "--server", "build", "--purpose", "a", "--no-launch", "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  assert.ok(JSON.parse(json.stdout).result.warnings.includes(`the host's hook says ${HOSTILE}`), json.stdout);
});

test("oats retire --server: the text prints the receipt's warnings as a local retire does, spelled, and its recovery and extra-tree lines spell what they name", (t) => {
  const receipt = {
    retired: "dev-a", agent: "dev", removedDir: true,
    workRecovery: { path: `${WS}/agents/dev/.oats-retirement/recovery/dev-a-${HOSTILE}`, classes: ["instance-home bytes"], bytes: 7 },
    extraWorktrees: [{ path: `${HOME}/.work-${HOSTILE}`, outcome: "removed", branch: `extra-${BIDI}`, repo: `${WS}/ws` }],
    warnings: [`the retire read the repository ${WS}/ws-${HOSTILE} from Git`],
  };
  const run = routed(t, { "retire dev-a": ok(receipt) });
  const text = run(["retire", "dev-a", "--server", "build"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.deepEqual(linesWith(text.stdout, "WARNING"), [`  WARNING: the retire read the repository ${WS}/ws-${SPELLED} from Git`]);
  assert.deepEqual(linesWith(text.stdout, "/.oats-retirement/recovery/"), [`  ${WS}/agents/dev/.oats-retirement/recovery/dev-a-${SPELLED} (7 B)`]);
  assert.deepEqual(linesWith(text.stdout, "Extra worktree "), [`Extra worktree ${HOME}/.work-${SPELLED} removed (branch extra-\\u{202e}); its branch and commits stay in ${WS}/ws on build-host`]);
  assert.doesNotMatch(text.stdout + text.stderr, RAW, "no escape and no bidi override reaches the terminal");
  const json = run(["retire", "dev-a", "--server", "build", "--json"]);
  assert.equal(json.status, 0, json.stdout + json.stderr);
  const result = JSON.parse(json.stdout).result;
  assert.deepEqual([result.warnings, result.workRecovery.path, result.extraWorktrees[0].path], [receipt.warnings, receipt.workRecovery.path, receipt.extraWorktrees[0].path]);
});
