// The state-changing commands refuse a flag they do not define before anything happens
// (oats-project/oats#1791): a mistyped protective flag (`--no-recursve` for `--no-recursive`) must not
// do the unprotected thing, here or on a `--server` route.
//
// This file pins, for every command lib/command-flags.mjs declares:
//   - a typo of one of its flags is one E_BAD_ARGS envelope, `oats <command>: unknown flag <flag>` and the
//     command's usage line, `details.flag`; in text mode the same words on stderr and nothing on stdout;
//   - nothing in the fixture (the deployment, the instance home, HOME, the server registry) changed;
//   - a routed command refuses it before the route is taken (no server is registered: a command that got
//     as far as its route answers E_SERVER_UNKNOWN);
//   - a switch given a value, an argument after the last one, `--` and a flag a command refuses with its
//     own words are refused the same way;
//   - each command's defined flags are still read (one smoke case per command).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

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
  const definition = join(fx.base, "fast.json");
  writeFileSync(definition, JSON.stringify({ harness: "pi" }));
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
  return { fx, home, definition, elsewhere, inHome, refusal };
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
  ["retire", ["retire", "dev-one", "--keep-dirs"], "--keep-dirs"],
  ["instance stop", ["instance", "stop", "dev-one", "--plan", "--no-recursve"], "--no-recursve"],
  ["instance upgrade", ["instance", "upgrade", "dev-one", "--plan", "--undoo"], "--undoo"],
  ["worktree add", ["worktree", "add", "--purpose", "p", "--branch", "agents/p", "--base", "main", "--previw"], "--previw", d.inHome],
  ["worktree remove", ["worktree", "remove", "--purpose", "p", "--forse"], "--forse", d.inHome],
  ["session start", ["session", "start", "--home", d.home, "--resum"], "--resum"],
  ["session restart", ["session", "restart", "--home", d.home, "--stop-grase", "5"], "--stop-grase"],
  ["schedule remove", ["schedule", "remove", "nightly", "--forse"], "--forse"],
  ["schedule run", ["schedule", "run", "nightly", "--forse"], "--forse"],
  ["schedule enable", ["schedule", "enable", "nightly", "--dri", d.fx.dep], "--dri"],
  ["schedule disable", ["schedule", "disable", "nightly", "--servr", "build"], "--servr"],
  ["schedule reconcile", ["schedule", "reconcile", "nightly", "--claer"], "--claer"],
  ["schedule host uninstall", ["schedule", "host", "uninstall", "--dri", d.fx.dep], "--dri"],
  ["trigger remove", ["trigger", "remove", "prs", "--dri", d.fx.dep], "--dri"],
  // trigger has no --server route: the flag was never read, and the trigger was changed here.
  ["trigger enable", ["trigger", "enable", "prs", "--server", "build"], "--server"],
  ["trigger disable", ["trigger", "disable", "prs", "--forse"], "--forse"],
  ["server remove", ["server", "remove", "build", "--forse"], "--forse"],
  ["server forget", ["server", "forget", "build", "--instnace", "dev-one"], "--instnace"],
  ["package add", ["package", "add", "acme.tools", "v1.0.0", "--dri", d.fx.dep], "--dri"],
  ["package remove", ["package", "remove", "acme.tools", "--dri", d.fx.dep], "--dri"],
  ["launch-config set", ["launch-config", "set", "fast", "--file", d.definition, "--keep-envv"], "--keep-envv"],
  ["launch-config remove", ["launch-config", "remove", "fast", "--dri", d.fx.dep], "--dri"],
  ["automations refresh", ["automations", "refresh", "--dri", d.fx.dep], "--dri"],
];

test("a typo of a flag is refused by every state-changing command, in one envelope naming it, and nothing changes", async (t) => {
  const d = await deployment(t);
  const before = tree(d.fx.base);
  for (const [command, argv, flag, opts] of TYPOS(d)) {
    await t.test(command, () => {
      assertUnknown(d.refusal([...argv, "--json"], opts), command, flag, `${argv.join(" ")} --json`);
      // --json before the typo: it is read wherever it stands.
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

test("a routed command refuses the typo before its route is taken", async (t) => {
  const d = await deployment(t);
  const before = tree(d.fx.base);
  const routed = [
    ["instance stop", ["instance", "stop", "dev-one", "--plan", "--home", d.home], "--no-recursve"],
    ["session start", ["session", "start", "--home", d.home], "--modle"],
    ["session restart", ["session", "restart", "--home", d.home], "--stop-grase"],
    ["schedule remove", ["schedule", "remove", "nightly"], "--forse"],
    ["schedule host uninstall", ["schedule", "host", "uninstall"], "--forse"],
    ["launch-config set", ["launch-config", "set", "fast", "--file", d.definition], "--keep-envv"],
    ["launch-config remove", ["launch-config", "remove", "fast"], "--forse"],
  ];
  for (const [command, argv, typo] of routed) {
    // The premise: without the typo the command reaches its route, and no server `nosuch` is registered.
    assert.equal(d.refusal([...argv, "--server", "nosuch", "--json"]).code, "E_SERVER_UNKNOWN", `${command}: fixture premise: it is routed`);
    assertUnknown(d.refusal([...argv, "--server", "nosuch", typo, "--json"]), command, typo, `${command} --server`);
  }
  assert.deepEqual(tree(d.fx.base), before, "nothing in the fixture changed");
});

test("a switch given a value, an argument after the last, `--` and a flag a command refuses in its own words are refused before anything", async (t) => {
  const d = await deployment(t);
  const before = tree(d.fx.base);
  const usage = (command) => d.refusal([...command.split(" "), "--nosuch", "--json"]).message.split("\n")[1];
  const stopUsage = usage("instance stop");
  assert.deepEqual(d.refusal(["instance", "upgrade", "dev-one", "--plan", "--undo=yes", "--json"]),
    { code: "E_BAD_ARGS", message: `oats instance upgrade: --undo takes no value (got --undo=yes)\n${usage("instance upgrade")}`, details: { flag: "--undo" } });
  assert.deepEqual(d.refusal(["instance", "stop", "dev-one", "--no-recursive", "yes", "--plan", "--json"]),
    { code: "E_BAD_ARGS", message: `oats instance stop: unexpected argument "yes" after the instance "dev-one": instance stop takes one instance\n${stopUsage}`, details: { argument: "yes" } });
  assert.deepEqual(d.refusal(["session", "restart", "--home", d.home, "now", "--json"]),
    { code: "E_BAD_ARGS", message: `oats session restart: unexpected argument "now": session restart takes no argument\n${usage("session restart")}`, details: { argument: "now" } });
  assert.deepEqual(d.refusal(["package", "add", "acme.tools", "v1.0.0", "v2.0.0", "--dir", d.fx.dep, "--json"]),
    { code: "E_BAD_ARGS", message: `oats package add: unexpected argument "v2.0.0" after the version "v1.0.0": package add takes one id and one version\n${usage("package add")}`, details: { argument: "v2.0.0" } });
  assertUnknown(d.refusal(["instance", "stop", "dev-one", "--", "--plan", "--json"]), "instance stop", "--", "`--` is a flag stop does not define");
  // A value flag's value is its value, also when it looks like an argument: never refused as one.
  assert.notEqual(d.refusal(["instance", "stop", "dev-one", "--apply", "--plan-revision", "rev", "--idempotency-key", "k", "--grace-ms", "10", "--json"]).details?.argument, "rev");
  // The flags a command refuses with its own words keep them, with details.flag.
  const own = [
    [["instance", "upgrade", "dev-one", "--plan", "--server", "build", "--json"], "--server", "instance upgrade supports local homes only; run it on the deployment host", {}],
    [["worktree", "add", "--purpose", "p", "--dir", d.fx.dep, "--json"], "--dir", /^oats worktree has no --dir: it acts on the instance home it runs in; usage: oats worktree add /, d.inHome],
    [["worktree", "remove", "--purpose", "p", "--server", "build", "--json"], "--server", "oats worktree runs in an instance home on this machine; --server is not accepted", d.inHome],
    [["launch-config", "set", "fast", "--file", d.definition, "--home", d.home, "--json"], "--home", "launch-config set writes the deployment's oats-local.yaml: address it with --dir, not --home or --soul", {}],
    [["launch-config", "remove", "fast", "--soul", "dev", "--server", "nosuch", "--json"], "--soul", "launch-config remove writes the deployment's oats-local.yaml: address it with --dir, not --home or --soul", {}],
    [["session", "restart", "--home", d.home, "--resume", "--json"], "--resume", "--resume exists on session start only: it brings back a session that was lost", {}],
  ];
  for (const [argv, flag, message, opts] of own) {
    const error = d.refusal(argv, opts);
    assert.equal(error.code, "E_BAD_ARGS", argv.join(" "));
    assert.deepEqual(error.details, { flag }, argv.join(" "));
    if (typeof message === "string") assert.equal(error.message, message, argv.join(" ")); else assert.match(error.message, message, argv.join(" "));
  }
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
  assert.match(ok(["instance", "stop", "dev-one", "--plan", "--no-recursive", "--home", d.home, "--dir", d.fx.dep, "--json"]).planRevision, /\S/);
  own(["instance", "upgrade", "dev-one", "--undo", "--plan", "--home", d.home, "--dir", d.fx.dep, "--json"], "E_UPGRADE_UNDO");
  assert.match(own(["worktree", "remove", "--purpose", "none", "--json"], "E_BAD_ARGS", d.inHome).message, /^no tree of purpose none was made by oats worktree add in this home/);
  assert.match(own(["worktree", "add", "--purpose", "p", "--branch", "agents/p", "--base", "main", "--repo", "nosuch", "--preview", "--json"], "E_CLONE_MISSING", d.inHome).message, /^--repo nosuch: /);
  assert.match(own(["session", "start", "--home", d.home, "--resume", "--model", "m", "--json"], "E_BAD_ARGS").message, /^--resume runs the launch this home recorded; it cannot be combined with --model/);
  assert.match(own(["session", "restart", "--home", d.home, "--stop-grace", "0", "--json"], "E_BAD_ARGS").message, /^--stop-grace needs a number of seconds/);
  for (const [verb, flag] of [["remove", "--force"], ["run", "--force"], ["enable"], ["disable"], ["reconcile", "--clear"]]) {
    own(["schedule", verb, "nightly", ...(flag ? [flag] : []), "--dir", d.fx.dep, "--json"], "E_SCHEDULE_UNKNOWN");
  }
  own(["schedule", "host", "uninstall", "--dir", d.elsewhere, "--json"], "E_LOCAL_MISSING");
  for (const verb of ["remove", "enable", "disable"]) own(["trigger", verb, "prs", "--dir", d.fx.dep, "--json"], "E_TRIGGER_UNKNOWN");
  own(["server", "remove", "build", "--json"], "E_SERVER_UNKNOWN");
  own(["server", "forget", "build", "--instance", "dev-one", "--json"], "E_SNAPSHOT_UNKNOWN");
  assert.equal(ok(["package", "add", "acme.tools", "v1.0.0", "--dir", d.fx.dep, "--json"]).id, "acme.tools");
  own(["package", "remove", "acme.tools", "--dir", d.fx.dep, "--json"], "E_PACKAGE_MISSING");
  assert.equal(ok(["launch-config", "set", "fast", "--file", d.definition, "--dir", d.fx.dep, "--json"]).action, "set");
  assert.equal(ok(["launch-config", "set", "fast", "--file", d.definition, "--keep-env", "--dir", d.fx.dep, "--json"]).action, "set");
  assert.equal(ok(["launch-config", "remove", "fast", "--dir", d.fx.dep, "--json"]).action, "remove");
  assert.equal(typeof ok(["automations", "refresh", "--dir", d.fx.dep, "--json"]).snapshot, "string");
});
