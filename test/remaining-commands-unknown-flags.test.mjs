// The rest of the kernel's state-changing commands refuse a flag they do not define before anything
// happens (oats-project/oats#1791, after #1813), through the one declaration (lib/command-flags.mjs).
//
// This file pins:
//   - for every command declared here, a typo of one of its flags is one E_BAD_ARGS envelope,
//     `oats <command>: unknown flag <flag>` and the command's usage line, `details.flag`; in text mode the
//     same words on stderr and nothing on stdout; and nothing in the fixture changed;
//   - each one's defined flags are still read (one smoke case per command);
//   - the commands that answer in their own words keep them: `oats update <word>` and `--to`, an
//     argument where `oats teams` takes a form (E_USAGE), `oats instance attention`'s flags of
//     `oats instance waiting`;
//   - the declaration's row-level fields, by the check itself: an optional argument (`required`), a value
//     flag of two words (`arity`), and a row's own answers (`unknown`, `extra`).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { commandArgvProblem } from "../lib/command-flags.mjs";

/** Every file under `dir`, with its bytes, but the CLI's compile cache (each run may write it). */
function tree(dir, under = "") {
  return readdirSync(join(dir, under), { withFileTypes: true }).filter((e) => e.name !== "compile-cache").sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? tree(dir, join(under, e.name)) : [[join(under, e.name), e.isFile() ? readFileSync(join(dir, under, e.name), "base64") : "(not a file)"]]));
}

async function deployment(t) {
  const fx = v2Deployment({ t, souls: { dev: { soul: { work: "directory" } } } });
  const hostPath = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  let home;
  try { home = (await fx.inEnv(() => fx.spawn("dev", { name: "dev-one" }))).home; } finally { process.env.PATH = hostPath; }
  writeFileSync(join(home, "NOTES.md"), "notes the instance wrote\n");
  const text = join(fx.base, "text.txt");
  writeFileSync(text, "hello\n");
  const missing = join(fx.base, "no-such-file.json");
  const elsewhere = join(fx.base, "not-a-deployment");
  mkdirSync(elsewhere);
  const inHome = { cwd: home, env: { OATS_INSTANCE_HOME: home } };
  /** `oats <argv>` → its one `--json` failure envelope's error. */
  const refusal = (argv, opts) => {
    const r = fx.cli(argv, opts);
    assert.equal(r.status, 1, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `one envelope on stdout: ${r.stdout}`);
    const envelope = JSON.parse(lines[0]);
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.ok, false);
    return envelope.error;
  };
  return { fx, home, text, missing, elsewhere, inHome, refusal };
}

/** The refusal of `flag` by `command`: its two lines, the name and the usage. */
function assertUnknown(error, command, flag, what) {
  assert.equal(error.code, "E_BAD_ARGS", `${what}: ${error.message}`);
  assert.deepEqual(error.details, { flag }, what);
  const [first, usage, ...more] = error.message.split("\n");
  assert.equal(first, `oats ${command}: unknown flag ${flag}`, what);
  assert.ok(usage?.startsWith(`usage: oats ${command} `), `${what}: the usage of ${command} follows: ${usage}`);
  assert.deepEqual(more, [], `${what}: the usage is one line`);
}

/** [command, argv with the typo, the typo, options] — the typo is one of a flag the command defines. */
const TYPOS = (d) => [
  ["instance color", ["instance", "color", "dev-one", "--claer"], "--claer"],
  ["instance background", ["instance", "background", "dev-one", "on", "--dri", d.fx.dep], "--dri"],
  ["instance same-work", ["instance", "same-work", "dev-one", "on", "--hom", d.home], "--hom"],
  ["instance waiting set", ["instance", "waiting", "set", "--producer", "oats.core", "--reason", "permission", "--home", d.home, "--mesage", "x"], "--mesage"],
  ["instance waiting clear", ["instance", "waiting", "clear", "--producer", "oats.core", "--home", d.home, "--resaon", "permission"], "--resaon"],
  ["instance attention", ["instance", "attention", "--claer"], "--claer", d.inHome],
  ["schedule add", ["schedule", "add", "nightly", "--fiel", d.missing], "--fiel"],
  ["schedule update", ["schedule", "update", "nightly", "--descripton=x"], "--descripton"],
  ["schedule tick", ["schedule", "tick", "--dry-rn"], "--dry-rn"],
  ["schedule host install", ["schedule", "host", "install", "--prnt"], "--prnt"],
  ["trigger add", ["trigger", "add", "--fom", "oats.okf:harvest-review"], "--fom"],
  ["trigger poll", ["trigger", "poll", "prs", "--run-sorce"], "--run-sorce"],
  ["trigger test", ["trigger", "test", "prs", "--run-sorce"], "--run-sorce"],
  ["session input", ["session", "input", "--home", d.home, "--text-fil", d.text], "--text-fil"],
  ["session receive", ["session", "receive", "--home", d.home, "--nam", "x.txt"], "--nam"],
  ["session upload", ["session", "upload", "--home", d.home, "--fil", d.text], "--fil"],
  ["session attach", ["session", "attach", "--home", d.home, "--no-status-lin"], "--no-status-lin"],
  ["server check", ["server", "check", "build", "--forse"], "--forse"],
  ["update", ["update", "--chek"], "--chek"],
];

test("a typo of a flag is refused by every command declared here, in one envelope naming it, and nothing changes", async (t) => {
  const d = await deployment(t);
  const before = tree(d.fx.base);
  for (const [command, argv, flag, opts] of TYPOS(d)) {
    await t.test(command, () => {
      assertUnknown(d.refusal([...argv, "--json"], opts), command, flag, `${argv.join(" ")} --json`);
      const words = command.split(" ").length;
      assertUnknown(d.refusal([...argv.slice(0, words), "--json", ...argv.slice(words)], opts), command, flag, "--json before the typo");
      const text = d.fx.cli(argv, opts);
      assert.equal(text.status, 1, text.stdout + text.stderr);
      assert.equal(text.stdout, "", `${command}: nothing on stdout`);
      assert.match(text.stderr, new RegExp(`^oats: oats ${command}: unknown flag ${flag}\nusage: oats ${command} [^\n]*\n$`), command);
      assert.deepEqual(tree(d.fx.base), before, `${command}: nothing in the fixture changed`);
    });
  }
});

test("the commands that answer in their own words keep them, and nothing changes", async (t) => {
  const d = await deployment(t);
  const before = tree(d.fx.base);
  const update = "oats update takes no package: pin package versions in oats-workspace.yaml (`oats package add <id> <version>`), then `oats sync`; bare `oats update [--check] [--yes]` updates the kernel";
  assert.deepEqual(d.refusal(["update", "oats.okf", "--json"]), { code: "E_BAD_ARGS", message: update, details: { argument: "oats.okf" } });
  assert.deepEqual(d.refusal(["update", "--to", "1.2.3", "--json"]), { code: "E_BAD_ARGS", message: update, details: { flag: "--to" } });
  const teams = d.refusal(["teams", "frobnicate", "--json"]);
  assert.equal(teams.code, "E_USAGE"); assert.match(teams.message, /^usage: oats teams /);
  const attention = d.refusal(["instance", "attention", "--home", d.home, "--json"], d.inHome);
  assert.deepEqual(attention, { code: "E_BAD_ARGS", message: "oats instance attention has no --home: it records the agent's own claim on the instance it runs in ($OATS_INSTANCE_HOME); usage: oats instance attention [--message=<text>] [--clear] [--json]", details: { flag: "--home" } });
  // A message that starts with --, spaced: the usage names the form that carries it.
  assert.match(d.refusal(["instance", "attention", "--message", "--deploy", "--json"], d.inHome).message, /--message=<text>/);
  assert.deepEqual(d.refusal(["instance", "suggest-name", "--soul", "dev", "--task", "t", "--server", "build", "--json"]).message,
    "instance suggest-name takes no --server: it runs this machine's harness, for a spawn that may land on another; the host it lands on makes the name unique (or names an unnamed --suggest-name spawn itself)");
  assertUnknown(d.refusal(["instance", "suggest-name", "--soul", "dev", "--taks", "t", "--json"]), "instance suggest-name", "--taks", "suggest-name");
  assertUnknown(d.refusal(["session", "resume", "--plna", "--json"]), "session resume", "--plna", "session resume");
  assert.deepEqual(tree(d.fx.base), before, "nothing in the fixture changed");
});

test("each command's defined flags are read: one smoke case per command", async (t) => {
  const d = await deployment(t);
  const ok = (argv, opts) => { const r = d.fx.cli(argv, opts); assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`); return JSON.parse(r.stdout).result; };
  /** The command's own answer to `argv`: its code, never this check's refusal. */
  const own = (argv, code, opts) => {
    const error = d.refusal(argv, opts);
    assert.equal(error.code, code, `${argv.join(" ")}: ${error.message}`);
    assert.doesNotMatch(error.message, /unknown flag|takes no value|unexpected argument/, argv.join(" "));
    return error;
  };
  const at = ["--home", d.home, "--dir", d.fx.dep, "--json"];
  assert.equal(ok(["instance", "color", "dev-one", "--clear", ...at]).color, null);
  assert.equal(ok(["instance", "background", "dev-one", "on", ...at]).background, true);
  assert.equal(ok(["instance", "same-work", "dev-one", "off", ...at]).sameWork, false);
  assert.equal(ok(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "permission", "--message=a question", ...at]).waitingOnYou.message, "a question");
  assert.equal(ok(["instance", "waiting", "clear", "--producer", "oats.core", ...at]).waitingOnYou, null);
  assert.equal(ok(["instance", "attention", "--message", "look", "--json"], d.inHome).waitingOnYou.message, "look");
  assert.equal(ok(["instance", "attention", "--clear", "--json"], d.inHome).waitingOnYou, null);
  assert.match(own(["schedule", "add", "nightly", "--file", d.missing, "--description=d", "--dir", d.fx.dep, "--json"], "E_BAD_ARGS").message, /^spec file not found/);
  own(["schedule", "update", "nightly", "--description=d", "--dir", d.fx.dep, "--json"], "E_SCHEDULE_UNKNOWN");
  assert.ok(Array.isArray(ok(["schedule", "tick", "--dry-run", "--dir", d.fx.dep, "--json"]).considered));
  assert.equal(typeof ok(["schedule", "host", "install", "--print", "--os", "linux", "--dir", d.fx.dep, "--json"]).files, "object");
  assert.match(own(["trigger", "add", "--file", d.missing, "--description=d", "--dir", d.fx.dep, "--json"], "E_BAD_ARGS").message, /^--file not found/);
  own(["trigger", "poll", "prs", "--run-source", "--dir", d.fx.dep, "--json"], "E_TRIGGER_UNKNOWN");
  own(["trigger", "test", "prs", "--run-source", "--dir", d.fx.dep, "--json"], "E_TRIGGER_UNKNOWN");
  own(["session", "input", "--home", d.home, "--text-file", d.text, "--json"], "E_SESSION_NOT_RUNNING");
  assert.match(own(["session", "receive", "--home", d.home, "--json"], "E_BAD_ARGS").message, /^session receive needs --name/);
  assert.match(own(["session", "upload", "--home", d.home, "--json"], "E_BAD_ARGS").message, /^session upload needs --file/);
  assert.match(own(["session", "attach", "--home", d.home, "--detach-key", "C-q", "--no-status-line", "--json"], "E_BAD_ARGS").message, /is interactive; omit --json/);
  own(["server", "check", "build", "--json"], "E_SERVER_UNKNOWN");
  const update = d.fx.cli(["update", "--check", "--yes", "--dir", d.elsewhere]);
  assert.equal(update.status, 1, update.stdout + update.stderr);
  assert.doesNotMatch(update.stderr, /unknown flag|unexpected argument/);
  assert.match(update.stderr, /^oats: no oats-local\.yaml found walking up from /);
});

test("the declaration's row fields, by the check: an optional argument, a flag of two words, a row's own answers", () => {
  // instance color's colour is optional (--clear): a routed color without it is sent; without the instance it is E_USAGE here.
  assert.equal(commandArgvProblem(["instance", "color", "dev-one", "--clear", "--server", "build"]), undefined);
  assert.equal(commandArgvProblem(["instance", "color", "--clear", "--server", "build"]).code, "E_USAGE");
  // instance background takes both, routed too.
  assert.equal(commandArgvProblem(["instance", "background", "dev-one", "--server", "build"]).code, "E_USAGE");
  // --provider takes two words, spaced or with its first after `=`.
  assert.equal(commandArgvProblem(["spawn", "dev", "--provider", "oats.aweb", "join=oats", "--preview"]), undefined);
  assert.equal(commandArgvProblem(["spawn", "dev", "--provider=oats.aweb", "join=oats", "--preview"]), undefined);
  assert.deepEqual(commandArgvProblem(["spawn", "dev", "--provider", "oats.aweb", "join=oats", "extra"]),
    { code: "E_BAD_ARGS", message: 'oats spawn: unexpected argument "extra" after the soul "dev": spawn takes one soul' });
  // spawn's own answers carry no details; the shared ones do.
  assert.deepEqual(commandArgvProblem(["spawn", "dev", "--frobnicate"]), { code: "E_BAD_ARGS", message: "oats spawn: unknown flag --frobnicate" });
  assert.equal(commandArgvProblem(["spawn", "--server", "build"]).code, "E_USAGE", "a routed spawn without its soul is never sent");
  // soul launch: every name it was given, in its own words.
  assert.match(commandArgvProblem(["soul", "launch", "remove", "dev", "writer", "reviewer"]).message, /^oats soul launch remove takes one soul or key, and got 3: "dev", "writer", "reviewer"/);
});
