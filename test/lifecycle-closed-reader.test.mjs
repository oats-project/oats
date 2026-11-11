// A lifecycle verb does not need its caller to finish, as a spawn does not
// (test/spawn-closed-stdout.test.mjs): `oats retire`, `oats session start`, `oats session restart`
// and `oats instance stop --apply` commit under the home's lifecycle claim, and a caller that closed
// its ends of stdout and stderr before the answer was written only stopped reading. The act
// completes, and the exit status is the act's own (0), never the 1 of an unhandled EPIPE.
//
// Each test runs the real CLI as a child whose stdout and stderr are pipes, closes their read ends
// before the verb writes its answer, and reads what the act left on disk.
//
// One of them writes while it acts: a start that starts the OATS tmux server says, on stderr, which
// environment it starts the server with. The first test starts a server with a reader, to show
// the line; the others have no reader for it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "../lib/core.mjs";
import { CLI, v2Deployment } from "./helpers/v2-deployment.mjs";
import { waitUntil } from "./helpers/host-fixture.mjs";

const hasTmux = !spawnSync("tmux", ["-V"], { stdio: "ignore" }).error;
const TMUX = { skip: !hasTmux && "tmux is not installed" };
const WAIT_MS = 120000;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The retire hook: it appends to `<agents root>/retire.log`, and while `<agents root>/hold-retire`
 *  exists it writes `retire-running` and waits for `retire-release`. */
const HOOK = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT;
appendFileSync(join(root, "retire.log"), process.env.OATS_INSTANCE + "\\n");
if (existsSync(join(root, "hold-retire"))) {
  writeFileSync(join(root, "retire-running"), String(process.pid));
  for (const end = Date.now() + ${WAIT_MS}; !existsSync(join(root, "retire-release")) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log(JSON.stringify({ meta: { retired: true } }));
`;

const fixtures = [];
test.afterEach(() => { for (const fx of fixtures.splice(0)) fx.cleanup(); });

/** A deployment whose soul `dev` has the retire hook above, and what the tests do in it. A home's
 *  session, once started, runs a fixture in place of a harness: it writes its pid to `harness-ready`
 *  in the home and execs a sleep (as test/host-stop.test.mjs does). */
function deployment() {
  const fx = v2Deployment({
    souls: { dev: { soul: { work: "directory", capabilities: { "test.hook": { from: "here" } } } } },
    capabilities: { "test.hook": { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": HOOK } } } });
  fixtures.push(fx);
  const harness = join(fx.base, "fixture-harness");
  writeFileSync(harness, `#!/bin/sh\necho $$ > "$OATS_INSTANCE_HOME/harness-ready.tmp"\n/bin/mv "$OATS_INSTANCE_HOME/harness-ready.tmp" "$OATS_INSTANCE_HOME/harness-ready"\nexec sleep 600\n`, { mode: 0o755 });
  const ok = (r, what) => { assert.equal(r.status, 0, `${what}\n${r.stdout}${r.stderr}`); return r; };
  const f = {
    fx,
    /** A home that was never launched → { instance, home }. */
    home: (purpose) => {
      const { home, instance } = ok(fx.cli(["spawn", "dev", "--purpose", purpose, "--harness", "claude", "--no-launch", "--json"]), "the spawn").json().result;
      const { launch: _recipe, ...meta } = readJson(join(home, "instance.json"));
      writeFileSync(join(home, "instance.json"), JSON.stringify({ ...meta, command: `OATS_INSTANCE=${shq(instance)} OATS_INSTANCE_HOME=${shq(home)} ${shq(harness)} --dangerously-skip-permissions -- "$(cat TASK.md)"`, launched: false }));
      return { instance, home };
    },
    /** The pid of the command that runs in the home's session, or null while it does not run. */
    harnessPid: (home) => {
      try {
        const pid = Number(readFileSync(join(home, "harness-ready"), "utf8").trim());
        return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim().split("/").pop() === "sleep" ? pid : null;
      } catch { return null; }
    },
    runs: (home) => waitUntil(() => f.harnessPid(home) !== null, "the home's command to run", WAIT_MS),
    /** A home whose session runs, started by a command that was read to its end. */
    running: async (purpose) => {
      const i = f.home(purpose);
      ok(fx.cli(["session", "start", "--home", i.home, "--json"]), "the start");
      await f.runs(i.home);
      return i;
    },
    /** `oats <argv>` as a child whose caller has gone: the read ends of its stdout and stderr are
     *  closed, at once or when `when` first answers true → `{ code, signal }` once it has ended. */
    unread: async (argv, when = () => true) => {
      const child = spawn(process.execPath, [CLI, ...argv], { cwd: fx.dep, env: fx.env, stdio: ["ignore", "pipe", "pipe"] });
      let exited = false;
      child.on("exit", () => { exited = true; });
      const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
      await waitUntil(() => exited || when(), "the moment the caller goes away", WAIT_MS);
      assert.equal(exited, false, "fixture premise: the caller went away while the command ran");
      child.stdout.destroy(); child.stderr.destroy();
      return { ended };
    },
    retireRuns: () => (existsSync(join(fx.root, "retire.log")) ? readFileSync(join(fx.root, "retire.log"), "utf8").split("\n").filter(Boolean).length : 0),
  };
  return f;
}

test("a start that starts the OATS tmux server writes to stderr while it acts; with its caller gone it starts the session all the same and exits 0", TMUX, async (t) => {
  // With a reader: the line the start writes before its answer.
  const read = deployment();
  const shown = read.home("read");
  const r = read.fx.cli(["session", "start", "--home", shown.home, "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /^oats: warning: could not read your login environment /m, "fixture premise: this start says on stderr how it starts the server");
  await read.runs(shown.home);

  const f = deployment();
  const i = f.home("unread");
  const run = await f.unread(["session", "start", "--home", i.home, "--json"]);
  assert.deepEqual(await run.ended, { code: 0, signal: null }, "the start ends as a start that was read to its end does");
  await f.runs(i.home);
  const meta = readJson(join(i.home, "instance.json"));
  assert.deepEqual([meta.launched, typeof meta.startId], [true, "string"], "the home's record says it was started");
  const status = f.fx.cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).agents.flatMap((agent) => agent.instances).find((row) => row.instance === i.instance)?.running, true, "oats status reads it running");
});

test("a restart whose caller is gone stops the session and starts it again, and exits 0", TMUX, async (t) => {
  const f = deployment();
  const i = await f.running("again");
  const before = { pid: f.harnessPid(i.home), startId: readJson(join(i.home, "instance.json")).startId };
  const run = await f.unread(["session", "restart", "--home", i.home, "--stop-grace", "10"]);
  assert.deepEqual(await run.ended, { code: 0, signal: null });
  await waitUntil(() => { const pid = f.harnessPid(i.home); return pid !== null && pid !== before.pid; }, "the home's command to run again", WAIT_MS);
  assert.equal(alive(before.pid), false, "the session that ran was stopped");
  assert.notEqual(readJson(join(i.home, "instance.json")).startId, before.startId, "the record names the start that followed");
});

test("a stop apply whose caller is gone stops the session, stores its receipt and exits 0: the same key answers it again", TMUX, async (t) => {
  const f = deployment();
  const i = await f.running("stopped");
  const pid = f.harnessPid(i.home);
  const shown = f.fx.cli(["instance", "stop", i.instance, "--plan", "--json"]);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const apply = ["instance", "stop", i.instance, "--apply", "--plan-revision", shown.json().result.planRevision, "--idempotency-key", "stop-unread", "--grace-ms", "10000"];
  const run = await f.unread(apply);
  assert.deepEqual(await run.ended, { code: 0, signal: null });
  assert.equal(alive(pid), false, "the session's command was stopped");
  assert.equal(readJson(join(i.home, ".oats-stop.json")).stop.exited, true, "the home's stop record says so");
  const again = f.fx.cli([...apply, "--json"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual([again.json().result.replayed, again.json().result.results.map((row) => [row.instance, row.ok, row.stopped])], [true, [[i.instance, true, true]]], "the answer nobody read is the stored receipt");
});

test("a retire whose caller goes away while its retire hook runs removes the home, with the hook run once, and exits 0", async (t) => {
  const f = deployment();
  const i = f.home("retired");
  writeFileSync(join(f.fx.root, "hold-retire"), "");
  const run = await f.unread(["retire", i.instance, "--json"], () => existsSync(join(f.fx.root, "retire-running")));
  writeFileSync(join(f.fx.root, "retire-release"), "");
  assert.deepEqual(await run.ended, { code: 0, signal: null });
  assert.equal(existsSync(i.home), false, "the home is gone");
  assert.equal(f.retireRuns(), 1);
  rmSync(join(f.fx.root, "hold-retire"));
  const status = f.fx.cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).agents.flatMap((agent) => agent.instances).map((row) => row.instance), [], "oats status lists no instance");
});
