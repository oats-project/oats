// A spawn killed after its spawn hooks started and before its record is written (SIGKILL, a
// container stop, a dropped connection), and the retire of the home it leaves. The spawn hook of
// the fixture's capability takes a seat outside the home (a file under OATS_ROOT) and its retire
// hook gives it back: a retire that removes the home without running the retire hook leaves the
// seat taken with nothing on disk that knows about it. Every spawn and retire is the real CLI
// against a scratch deployment; the spawn is a real process, killed while its hook runs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";

/** The spawn hook: takes the seat, then, told to (`spawn-sleep`), writes its pid whole and sleeps:
 *  the point a test kills the spawn at. It answers its receipt (`meta`) only when it ends. */
const SPAWN = `import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT;
writeFileSync(join(root, "seat-" + process.env.OATS_INSTANCE), "taken\\n");
if (existsSync(join(root, "spawn-sleep"))) {
  writeFileSync(join(root, "spawn-sleeping.tmp"), String(process.pid));
  renameSync(join(root, "spawn-sleeping.tmp"), join(root, "spawn-sleeping"));
  await new Promise((r) => setTimeout(r, 60000));
}
console.log(JSON.stringify({ meta: { made: true } }));
`;
/** The retire hook: records what it was handed and whether the home was still there, then gives
 *  the seat back. A seat that was never taken is nothing to give back. */
const RETIRE = `import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT, seat = join(root, "seat-" + process.env.OATS_INSTANCE);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OATS_")));
appendFileSync(join(root, "retire-runs.jsonl"), JSON.stringify({ instance: process.env.OATS_INSTANCE, env, homeThere: existsSync(process.env.OATS_INSTANCE_HOME), seatTaken: existsSync(seat) }) + "\\n");
rmSync(seat, { force: true });
console.log(JSON.stringify({ meta: { retired: true } }));
`;

function deployment(t, work) {
  const capabilities = { "test.seat": { manifest: { hooks: { spawn: { command: "spawn.mjs", required: true }, retire: "retire.mjs" } }, files: { "spawn.mjs": SPAWN, "retire.mjs": RETIRE } } };
  const fx = v2Deployment({ souls: { dev: { soul: { work, capabilities: { "test.seat": { from: "here" } } } } }, capabilities, t });
  // No system or global Git configuration, no prompt and no credential helper: the kernel's Git must
  // never wait on the host's.
  Object.assign(fx.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" });
  const spawnArgs = (name) => ["spawn", "dev", "--name", name, "--work", work, "--no-launch", "--json"];
  const home = (name) => join(fx.root, "dev", "instances", name);
  const seat = (name) => join(fx.root, `seat-${name}`);
  const retireRuns = (name) => (existsSync(join(fx.root, "retire-runs.jsonl")) ? readFileSync(join(fx.root, "retire-runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).filter((r) => r.instance === name);
  /** A spawn of `name` as a process of its own, stopped inside its spawn hook: → { child, done, hook }. */
  const spawnInHook = async (name) => {
    writeFileSync(join(fx.root, "spawn-sleep"), "");
    const child = spawnChild(process.execPath, [CLI, ...spawnArgs(name)], { cwd: fx.dep, env: fx.env, stdio: "ignore" });
    const done = new Promise((resolve) => child.on("close", resolve));
    const end = Date.now() + 60000;
    while (!existsSync(join(fx.root, "spawn-sleeping")) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(join(fx.root, "spawn-sleeping")), "fixture premise: the spawn reached its spawn hook");
    const hook = Number(readFileSync(join(fx.root, "spawn-sleeping"), "utf8"));
    // Whatever the test does, the hook and the spawn end before the fixture's leftover check.
    fx.beforeCleanup(() => { for (const pid of [hook, child.pid]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
    return { child, done, hook };
  };
  /** A spawn of `name` SIGKILLed inside its spawn hook, the hook it left ended too: the home as the
   *  kill leaves it. */
  const killedInHook = async (name) => {
    const sp = await spawnInHook(name);
    sp.child.kill("SIGKILL");
    await sp.done;
    try { process.kill(sp.hook, "SIGKILL"); } catch { /* gone */ }
    rmSync(join(fx.root, "spawn-sleep"));
    rmSync(join(fx.root, "spawn-sleeping"));
    assert.equal(existsSync(seat(name)), true, "fixture premise: the spawn hook took the seat");
    assert.equal(JSON.parse(readFileSync(join(home(name), "instance.json"), "utf8")).repo, undefined, "fixture premise: the spawn never wrote its record");
    return home(name);
  };
  /** The row `oats status --json` gives the instance `name`, wherever the answer holds it. */
  const statusRow = (name) => {
    const r = fx.cli(["status", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const find = (v) => Array.isArray(v) ? v.map(find).find(Boolean) : v && typeof v === "object" ? (v.instance === name && typeof v.home === "string" ? v : Object.values(v).map(find).find(Boolean)) : undefined;
    const row = find(JSON.parse(r.stdout));
    assert.ok(row, `no status row for ${name}: ${r.stdout}`);
    return row;
  };
  return { fx, spawnArgs, home, seat, retireRuns, spawnInHook, killedInHook, statusRow };
}

/** The retire hook environment of `run`, as another instance's would read: the instance's name in
 *  every value replaced, and without OATS_META (the spawn hook's receipt, compared by itself). */
const comparableEnv = (run, name) => Object.fromEntries(Object.entries(run.env).filter(([k]) => k !== "OATS_META").map(([k, v]) => [k, v.replaceAll(name, "<instance>")]));

for (const work of ["checkout", "worktree", "directory"]) {
  test(`a spawn killed inside its spawn hook (work: ${work}): retire runs the retire hook, with the environment a retire of a whole home gives, and only then removes the home`, async (t) => {
    const d = deployment(t, work);
    // What a retire hands the retire hook of a home whose spawn finished.
    const whole = d.fx.cli(d.spawnArgs("dev-whole"));
    assert.equal(whole.status, 0, whole.stderr + whole.stdout);
    assert.equal(d.fx.cli(["retire", "dev-whole", "--json"]).status, 0);
    const [wholeRun] = d.retireRuns("dev-whole");

    const home = await d.killedInHook("dev-killed");
    const r = d.fx.cli(["retire", "dev-killed", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const ran = d.retireRuns("dev-killed");
    assert.equal(ran.length, 1, `the retire hook ran once: ${r.stdout}${r.stderr}`);
    assert.equal(ran[0].homeThere, true, "the home was still there when the retire hook ran");
    assert.equal(ran[0].seatTaken, true, "the seat the spawn hook took was there to give back");
    assert.deepEqual(comparableEnv(ran[0], "dev-killed"), comparableEnv(wholeRun, "dev-whole"));
    // The spawn hook was killed before it answered: there is no receipt of it to hand over.
    assert.equal(ran[0].env.OATS_META, "{}");
    assert.equal(wholeRun.env.OATS_META, JSON.stringify({ made: true }));
    assert.equal(existsSync(d.seat("dev-killed")), false, "the seat is given back");
    assert.equal(existsSync(home), false, "the home is removed");
  });
}

test("while a spawn runs its spawn hooks its home is a spawn in progress: status says so and retire refuses, --force included", async (t) => {
  const d = deployment(t, "checkout");
  const sp = await d.spawnInHook("dev-busy");
  const row = d.statusRow("dev-busy");
  assert.equal(row.spawnInProgress, true, JSON.stringify(row));
  assert.equal(row.rollbackIncomplete, undefined);
  for (const flags of [[], ["--force"]]) {
    const r = d.fx.cli(["retire", "dev-busy", "--json", ...flags]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(r.json().error.code, "E_LIFECYCLE_BUSY", r.stdout);
    assert.ok(r.json().error.message.includes(`dev-busy is still being spawned (pid ${sp.child.pid},`), r.stdout);
  }
  assert.equal(d.retireRuns("dev-busy").length, 0);
  assert.equal(existsSync(d.home("dev-busy")), true);
});

test("a home whose record does not say which retire hooks to run: retire refuses, naming --force, and removes nothing; --force removes it without running a hook", async (t) => {
  const d = deployment(t, "checkout");
  const home = await d.killedInHook("dev-stub");
  // The home as a kernel that wrote nothing before its spawn hooks leaves it: the record
  // lib/materialize.mjs writes, and nothing beside it that names the hooks.
  rmSync(join(home, ".oats-rollback-incomplete.json"), { force: true });
  const r = d.fx.cli(["retire", "dev-stub", "--json"]);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const error = r.json().error;
  assert.equal(error.code, "E_UNIDENTIFIED_INSTANCE_HOME", JSON.stringify(error));
  assert.match(error.message, /records neither a repository nor its capabilities' hooks/);
  assert.match(error.message, /oats retire dev-stub --force/);
  assert.equal(error.details.reached.phase, "before-effects");
  assert.equal(d.retireRuns("dev-stub").length, 0, "no retire hook ran");
  assert.equal(existsSync(home), true, "the home is kept");
  assert.equal(existsSync(d.seat("dev-stub")), true);
  // The operator's explicit escape, after cleaning up by hand: the home goes, and no hook runs.
  const forced = d.fx.cli(["retire", "dev-stub", "--json", "--force"]);
  assert.equal(forced.status, 0, forced.stderr + forced.stdout);
  assert.equal(d.retireRuns("dev-stub").length, 0);
  assert.equal(existsSync(home), false);
});

test("a home whose spawn finished retires as before: no marker is left by the spawn, the retire hook gets the spawn hook's receipt, and the home is removed", async (t) => {
  const d = deployment(t, "checkout");
  const spawned = d.fx.cli(d.spawnArgs("dev-done"));
  assert.equal(spawned.status, 0, spawned.stderr + spawned.stdout);
  const home = d.home("dev-done");
  assert.equal(existsSync(join(home, ".oats-rollback-incomplete.json")), false, "a finished spawn leaves no marker");
  const row = d.statusRow("dev-done");
  assert.equal(row.spawnInProgress, undefined);
  assert.equal(row.rollbackIncomplete, undefined);
  const r = d.fx.cli(["retire", "dev-done", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const ran = d.retireRuns("dev-done");
  assert.equal(ran.length, 1);
  assert.equal(ran[0].homeThere, true);
  assert.equal(ran[0].env.OATS_META, JSON.stringify({ made: true }));
  assert.equal(existsSync(d.seat("dev-done")), false);
  assert.equal(existsSync(home), false);
});
