// awebai/oats#1010: a fixture forces its environment on the real process.env, never by replacing
// the object. A kernel call that starts a child with no `env` option (the tmux lookups, git) gives
// it the process's environment, and which one that is after `process.env = {…}` depends on the Node
// that runs the suite: from v26.11.0 the child gets the real environment, not the replacement. A
// fixture that replaced the object then let those calls out, onto the operator's own tmux server.
//
// The cases that start a child run in a `node` of their own, with a session's variables in its
// environment and a PATH that holds only a stand-in `tmux` and a few tools: no real tmux can be
// reached from them, whatever environment a call ends up with.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureBase, linkExecutables } from "./helpers/host-fixture.mjs";
import { inFixture } from "./helpers/trigger-source-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const HELPERS = new URL("./helpers/", import.meta.url).href;
const bases = [];
test.after(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });

/** What an instance's session gives the process that runs the suite: a fixture leaves all of it. */
const SESSION = { TMUX: "/nonexistent/runner/tmux-socket,4094,0", TMUX_PANE: "%4094", DISPLAY: ":4094", CLAUDE_CONFIG_DIR: "/nonexistent/runner/claude",
  OATS_INSTANCE: "the-runner", OATS_INSTANCE_HOME: "/nonexistent/runner/home", OATS_HOME: "/nonexistent/runner/home", AWEB_IDENTITY_HOME: "/nonexistent/runner/home", PI_AGENT_HOME: "/nonexistent/runner/home" };

/** Run `body` (the source of an async function of `{ base, v2Deployment, inFixture, child }`) in a
 *  `node` of its own → { result, calls }: what it returns, and every call of the stand-in tmux as
 *  { tmpdir, args }. That process starts with SESSION, a HOME of its own and a PATH of one
 *  directory: git, sh and node, and a `tmux` that logs the TMUX_TMPDIR and arguments it was given
 *  and answers as a tmux with no server. `child()` starts a `node` with NO `env` option and returns
 *  the environment it got. */
function inRunner(body) {
  const base = fixtureBase("oats-re-");
  bases.push(base);
  const bin = join(base, "bin"), log = join(base, "tmux-calls.tsv"), home = join(base, "runner-home");
  linkExecutables(bin, ["node", "sh", "git", "cat", "env", "sleep", "which", "ps"]);
  mkdirSync(home);
  writeFileSync(join(bin, "tmux"), `#!/bin/sh
printf '%s\\t%s\\n' "\${TMUX_TMPDIR-<unset>}" "$*" >> '${log}'
[ "$1" = "-V" ] && { echo "tmux 3.5a"; exit 0; }
echo "no server running on ${join(base, "no-server")}" >&2
exit 1
`, { mode: 0o755 });
  // A harness for a launch configuration to name. It never runs: the stand-in tmux starts nothing.
  writeFileSync(join(base, "harness-stand-in"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
  const file = join(base, "runner.mjs");
  writeFileSync(file, `import { execFileSync } from "node:child_process";
import { v2Deployment } from ${JSON.stringify(`${HELPERS}v2-deployment.mjs`)};
import { inFixture } from ${JSON.stringify(`${HELPERS}trigger-source-fixture.mjs`)};
const child = () => JSON.parse(execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { encoding: "utf8" }));
const result = await (${body})({ base: ${JSON.stringify(base)}, v2Deployment, inFixture, child });
process.stdout.write("\\n" + JSON.stringify(result) + "\\n");
`);
  // The temporary directory the suite was given stays the runner's: its fixtures go where this
  // file's own do.
  const tmp = process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR };
  const r = spawnSync(process.execPath, [file], { cwd: base, env: { ...SESSION, ...tmp, PATH: bin, HOME: home, LANG: "C" }, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `the runner failed\n${r.stdout}\n${r.stderr}`);
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => ({ tmpdir: line.slice(0, line.indexOf("\t")), args: line.slice(line.indexOf("\t") + 1) })) : [];
  return { result: JSON.parse(r.stdout.trim().split("\n").pop()), calls, home };
}
const sessionNamesIn = (env) => Object.keys(SESSION).filter((name) => name in env);

test("inside fx.inEnv and inFixture, process.env is the same object, and a child started with no env gets the fixture's HOME and TMUX_TMPDIR and none of the session's variables", () => {
  const { result: seen, home } = inRunner(`async ({ v2Deployment, inFixture, child }) => {
    const outside = process.env, before = { ...process.env };
    const fx = v2Deployment();
    try {
      const inEnv = await fx.inEnv(async () => { await null; return { same: process.env === outside, own: { ...process.env }, child: child() }; });
      const between = { same: process.env === outside, own: { ...process.env }, child: child() };
      const tick = inFixture(fx, () => ({ same: process.env === outside, own: { ...process.env }, child: child() }), { EXTRA_FOR_THE_TICK: "1" });
      const after = { same: process.env === outside, own: { ...process.env }, child: child() };
      return { before, inEnv, between, tick, after, fixture: { HOME: fx.env.HOME, TMUX_TMPDIR: fx.env.TMUX_TMPDIR, OATS_HOME_DIR: fx.env.OATS_HOME_DIR } };
    } finally { fx.cleanup(); }
  }`);
  for (const [what, inside] of [["fx.inEnv", seen.inEnv], ["inFixture", seen.tick]]) {
    assert.equal(inside.same, true, `${what}: process.env is the object it was, not a replacement`);
    for (const [where, env] of [["the process", inside.own], ["a child started with no env", inside.child]]) {
      assert.equal(env.HOME, seen.fixture.HOME, `${what}, ${where}: the fixture's HOME`);
      assert.equal(env.TMUX_TMPDIR, seen.fixture.TMUX_TMPDIR, `${what}, ${where}: the fixture's TMUX_TMPDIR`);
      assert.equal(env.OATS_HOME_DIR, seen.fixture.OATS_HOME_DIR, `${what}, ${where}`);
      assert.deepEqual(sessionNamesIn(env), [], `${what}, ${where}: none of the session's variables`);
    }
  }
  assert.equal(seen.tick.child.EXTRA_FOR_THE_TICK, "1", "inFixture's extra reaches the child too");
  // Outside the calls exactly what was there is back: the session's variables with their values,
  // and no name the fixture set (TMUX_TMPDIR, OATS_HOME_DIR, the extra) is left behind.
  for (const [when, outside] of [["between the calls", seen.between], ["after them", seen.after]]) {
    assert.equal(outside.same, true, when);
    assert.deepEqual(outside.own, seen.before, when);
    assert.equal(outside.child.HOME, home, when);
    for (const [name, value] of Object.entries(SESSION)) assert.equal(outside.child[name], value, `${when}: ${name}`);
    for (const name of ["TMUX_TMPDIR", "OATS_HOME_DIR", "OATS_REMOTE_CACHE", "EXTRA_FOR_THE_TICK"]) assert.equal(name in outside.child, false, `${when}: ${name}`);
  }
});

test("the kernel's tmux lookups in a fixture's spawn all carry the fixture's TMUX_TMPDIR, those it starts with no env included", (t) => {
  const { result: seen, calls } = inRunner(`async ({ base, v2Deployment }) => {
    const fx = v2Deployment({ local: { "launch-configs": { "stand-in": { harness: "pi", executable: base + "/harness-stand-in" } } } });
    // An in-process spawn finds its harness and its tmux on this process's PATH: the fixture's
    // inert harnesses, then the stand-in tmux.
    process.env.PATH = fx.env.PATH;
    let error = null;
    try { await fx.spawn("dev", { name: "lookup", launch: true, launchConfig: "stand-in" }); }
    catch (e) { error = { code: e.code ?? null, message: String(e.message) }; }
    finally { fx.cleanup(); }
    return { error, tmuxTmpdir: fx.env.TMUX_TMPDIR };
  }`);
  // The stand-in is a tmux with no server that starts none, so the launch cannot succeed: what is
  // read is which directory each call was given.
  t.diagnostic(`${calls.length} tmux calls, ${calls.filter(({ tmpdir }) => tmpdir === seen.tmuxTmpdir).length} with the fixture's TMUX_TMPDIR: ${[...new Set(calls.map(({ args }) => args.replace(/none-\d+/g, "none-<pid>").replace(/\S*\/tmux-\d+\/\S+/g, "<socket>")))].join(" | ")}`);
  assert.ok(seen.error, "the stand-in tmux starts no session");
  t.diagnostic(`the spawn's refusal: ${seen.error.code} ${seen.error.message.slice(0, 300)}`);
  const server = calls.filter(({ args }) => /(^| )-L oats( |$)/.test(args));
  assert.ok(server.some(({ args }) => / list-sessions( |$)/.test(args)), `the spawn looked for the fixture's server: ${JSON.stringify(calls)}`);
  assert.ok(seen.tmuxTmpdir && seen.tmuxTmpdir.startsWith("/"), "the fixture has a private TMUX_TMPDIR");
  assert.deepEqual(calls.filter(({ tmpdir }) => tmpdir !== seen.tmuxTmpdir), [], `every tmux call the spawn made carries the fixture's TMUX_TMPDIR (${seen.tmuxTmpdir})`);
});

test("what was there is put back exactly, also when the call throws or rejects, and a name that was absent is deleted again", async (t) => {
  const fx = v2Deployment({ t });
  const outside = process.env;
  process.env.FIXTURE_REAL_ENV_PRESENT = "kept";
  // A name the fixture sets is absent before the call, whatever the runner of this file has.
  const runnersCache = process.env.OATS_REMOTE_CACHE;
  delete process.env.OATS_REMOTE_CACHE;
  t.after(() => { delete process.env.FIXTURE_REAL_ENV_PRESENT; if (runnersCache !== undefined) process.env.OATS_REMOTE_CACHE = runnersCache; });
  const before = { ...process.env };
  const inside = () => { assert.equal(process.env.HOME, fx.env.HOME); assert.equal(process.env.OATS_REMOTE_CACHE, fx.env.OATS_REMOTE_CACHE); process.env.SET_INSIDE_THE_CALL = "1"; delete process.env.FIXTURE_REAL_ENV_PRESENT; };
  const restored = (when) => { assert.equal(process.env, outside, when); assert.deepEqual({ ...process.env }, before, when); };

  await fx.inEnv(inside);
  restored("after a call that returns");
  await assert.rejects(fx.inEnv(() => { inside(); throw new Error("thrown inside"); }), /thrown inside/);
  restored("after a call that throws");
  await assert.rejects(fx.inEnv(async () => { inside(); await null; throw new Error("rejected inside"); }), /rejected inside/);
  restored("after a call that rejects");
  assert.equal(inFixture(fx, () => { inside(); return process.env.ONLY_FOR_THIS_TICK; }, { ONLY_FOR_THIS_TICK: "tick" }), "tick");
  restored("after inFixture");
  assert.throws(() => inFixture(fx, () => { inside(); throw new Error("thrown in the tick"); }, { ONLY_FOR_THIS_TICK: "tick" }), /thrown in the tick/);
  restored("after an inFixture that throws");
  fx.cleanup();
  restored("after the fixture's cleanup");
});

test("calls of one fixture that nest or overlap keep its environment until the last one ends", async (t) => {
  const fx = v2Deployment({ t });
  const before = { ...process.env };
  const forced = () => process.env.HOME === fx.env.HOME && process.env.TMUX_TMPDIR === fx.env.TMUX_TMPDIR;
  // Nested: the inner call's end does not take the environment from under the outer one, and puts
  // back what the outer call had when the inner one began, whatever happened to it meanwhile.
  await fx.inEnv(async () => {
    assert.ok(forced());
    process.env.SET_BY_THE_OUTER_CALL = "outer";
    await fx.inEnv(async () => { assert.ok(forced()); assert.equal(process.env.SET_BY_THE_OUTER_CALL, "outer"); process.env.SET_BY_THE_INNER_CALL = "inner"; });
    assert.ok(forced(), "still the fixture's after an inner call ended");
    assert.equal(process.env.SET_BY_THE_OUTER_CALL, "outer");
    assert.equal("SET_BY_THE_INNER_CALL" in process.env, false, "what the inner call set ended with it");
    inFixture(fx, () => assert.ok(forced()), { ONLY_FOR_THIS_TICK: "tick" });
    assert.ok(forced(), "and after an inner tick");
    assert.equal("ONLY_FOR_THIS_TICK" in process.env, false);
    // A wrapper that restores a name before its async function has finished (it does not await it)
    // does so while the inner call is in flight: the inner call's end puts the outer value back.
    const inner = fx.inEnv(async () => { await null; });
    process.env.SET_BY_THE_OUTER_CALL = "changed while the inner call was in flight";
    await inner;
    assert.equal(process.env.SET_BY_THE_OUTER_CALL, "outer", "the environment is the outer call's again, as it was when the inner one began");
  });
  assert.deepEqual({ ...process.env }, before);
  // Overlapping: the first to finish does not restore under the one still in flight.
  let endFirst, endSecond;
  const first = fx.inEnv(() => new Promise((resolve) => { endFirst = resolve; }));
  const second = fx.inEnv(() => new Promise((resolve) => { endSecond = resolve; }));
  assert.ok(forced(), "both in flight");
  endFirst(); await first;
  assert.ok(forced(), "the first ended: the second still runs in the fixture's environment");
  endSecond(); await second;
  assert.deepEqual({ ...process.env }, before, "the last ended: what was there is back");
  // Three, ended oldest first, newest first and in between: never restored under one in flight.
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]]) {
    const ends = [], flights = [0, 1, 2].map((i) => fx.inEnv(() => new Promise((resolve) => { ends[i] = resolve; })));
    for (const [n, i] of order.entries()) {
      assert.ok(forced(), `order ${order}: before ending call ${i}`);
      ends[i](); await flights[i];
      assert.equal(forced(), n < 2, `order ${order}: after ending call ${i}`);
    }
    assert.deepEqual({ ...process.env }, before, `order ${order}`);
  }
});

test("a call of another fixture while one is in flight is refused by name, and runs once that one has ended", async (t) => {
  const a = v2Deployment({ t }), b = v2Deployment({ t });
  const before = { ...process.env };
  const refusal = (e) => e.message.includes(`the fixture ${b.base} cannot force its environment`) && e.message.includes(`the fixture ${a.base} has an in-process call in flight`);
  let end;
  const flight = a.inEnv(() => new Promise((resolve) => { end = resolve; }));
  let ran = false;
  await assert.rejects(b.inEnv(() => { ran = true; }), refusal);
  assert.throws(() => inFixture(b, () => { ran = true; }), refusal);
  assert.equal(ran, false, "nothing of the second fixture ran");
  assert.equal(process.env.HOME, a.env.HOME, "the first fixture's environment is untouched");
  end(); await flight;
  assert.deepEqual({ ...process.env }, before);
  assert.equal(await b.inEnv(() => process.env.HOME), b.env.HOME, "once the first has ended the second runs");
  assert.deepEqual({ ...process.env }, before);
});

test("no test file and no test helper assigns to process.env", () => {
  // Every script under test/, tests/ and packages/*/test/, read as code: comments are left out.
  const root = new URL("../", import.meta.url);
  const packages = readdirSync(new URL("packages/", root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `packages/${e.name}/test/`);
  const scripts = (dir) => (existsSync(new URL(dir, root)) ? readdirSync(new URL(dir, root), { withFileTypes: true }) : []).flatMap((e) => (
    e.isDirectory() ? (e.name === "node_modules" ? [] : scripts(`${dir}${e.name}/`)) : /\.[cm]?js$/.test(e.name) ? [`${dir}${e.name}`] : []));
  const files = ["test/", "tests/", ...packages].flatMap(scripts);
  for (const expected of ["test/helpers/v2-deployment.mjs", "test/capabilities.test.mjs", "tests/desktop-views.integration.mjs", "packages/pi/test/opening-task.test.mjs"]) assert.ok(files.includes(expected), `the search reads ${expected}`);
  const assigned = [];
  for (const file of files) {
    const lines = readFileSync(new URL(file, root), "utf8").split("\n");
    lines.forEach((line, i) => { if (/\bprocess\.env\s*=[^=]/.test(line.replace(/^\s*(\/\*|\*).*$/, "").replace(/\/\/.*$/, ""))) assigned.push(`${file}:${i + 1}`); });
  }
  assert.deepEqual(assigned, [], "a test sets names on the real process.env and puts them back (test/helpers/v2-deployment.mjs: forceEnvironment for a fixture's call, setProcessEnvironment for a test's own): a child started with no env does not get a replaced object on every Node");
});
