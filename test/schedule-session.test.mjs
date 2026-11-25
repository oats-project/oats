import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { addSchedule, tickWorkspace, withHostLock } from "../lib/schedule.mjs";
import { inspectInstanceSession, inputInstanceSession } from "../lib/core.mjs";
import { setWaiting } from "../lib/instance-events.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { ensureOatsSocketDir, leaveEnclosingInstance, privateTmuxTmpdir, removeTmuxTmpdir } from "./helpers/host-fixture.mjs";

// Exercise the actual scheduler -> session start -> tmux -> harness stdin
// boundary. All homes, receipts, binaries and the tmux socket are fixtures;
// no model, identity, user's tmux server or host timer is involved.
test("scheduled wakes deliver literal text once and give the next cold home the slot after a harness stops", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-schedule-session-")));
  // The fixture's own `oats` server (a private TMUX_TMPDIR): where a start creates its window.
  const tmuxTmpdir = privateTmuxTmpdir();
  const socket = ensureOatsSocketDir(tmuxTmpdir);
  // A workspace deployment; the schedule scope is its directory (oats-local.yaml).
  const fx = v2Deployment({ souls: { dev: { soul: { work: "worktree" } } } });
  const ws = fx.dep;
  const savedEnv = new Map(["TMUX_TMPDIR", "OATS_HOME_DIR", "SHELL", "ENV", "BASH_ENV", "OATS_INSTANCE", "OATS_INSTANCE_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT"].map(k => [k, process.env[k]]));
  process.env.OATS_HOME_DIR = join(base, "host");
  process.env.TMUX_TMPDIR = tmuxTmpdir;
  process.env.SHELL = "/bin/sh";
  for (const key of ["ENV", "BASH_ENV", "OATS_INSTANCE", "OATS_INSTANCE_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME", "PI_AGENTS_ROOT"]) delete process.env[key];
  const comeBack = leaveEnclosingInstance(base); // this worker starts a tmux server: as no instance
  const tmux = (...args) => execFileSync("tmux", ["-u", "-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const shq = s => `'${s.replace(/'/g, `'\\''`)}'`;
  const waitFor = async (fn, why) => {
    const deadline = Date.now() + 10000;
    while (!fn()) { assert.ok(Date.now() < deadline, why); await new Promise(r => setTimeout(r, 75)); }
  };
  const received = h => existsSync(h.log) ? readFileSync(h.log, "utf8").trim().split("\n").map(line => JSON.parse(line)).join("") : "";
  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "fixture", "-n", "anchor", "-c", base, "/bin/sh");
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    tmux("set-environment", "-g", "SHELL", "/bin/sh");
    const homes = [];
    for (const id of ["one", "two"]) {
      const instance = `dev-${id}`;
      // Spawned with the fixture's inert harnesses on PATH, then given a frozen
      // command in place of the launch recipe (the persisted-command start path).
      const path = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      let spawned;
      try { spawned = await fx.spawn("dev", { instance, harness: "claude" }); } finally { process.env.PATH = path; }
      const home = spawned.home;
      const harness = join(base, `fixture-${id}.mjs`), log = join(home, "received.jsonl"), ready = join(base, `fixture-${id}.ready`);
      // The harness announces itself once it reads stdin. Session start runs
      // other processes first (the native-start recorder, `cat TASK.md`), so a
      // non-shell pane alone does not prove the harness is the one running.
      // Like every real harness it visibly reacts to a submitted line: session
      // input judges an Enter by whether it changed the pane.
      writeFileSync(harness, `#!${process.execPath}\nimport {appendFileSync,writeFileSync} from 'node:fs';
process.stdin.setEncoding('utf8'); let input='', lines=0;
process.stdin.on('data',data=>{appendFileSync(${JSON.stringify(log)},JSON.stringify(data)+'\\n');input+=data;if(data.includes('\\n'))process.stdout.write('fixture: line '+(++lines)+' received\\n');if(input.includes('STOP-FIXTURE'))process.exit(0);});
writeFileSync(${JSON.stringify(ready)},String(process.pid));
setTimeout(()=>process.exit(0),30000);\n`);
      chmodSync(harness, 0o755);
      writeFileSync(join(home, "TASK.md"), "Fixture only\n");
      const command = `OATS_INSTANCE=${shq(instance)} OATS_INSTANCE_HOME=${shq(home)} ${shq(harness)} --dangerously-skip-permissions -- "$(cat TASK.md)"`;
      const target = { session: "fixture", window: instance, socket };
      const { launch: _recipe, ...spawnedMeta } = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
      writeFileSync(join(home, "instance.json"), JSON.stringify({ ...spawnedMeta, tmux: target, command, launched: false }));
      // The spawn wrote the independent session receipt; no receipt for a real home is touched.
      assert.ok(existsSync(join(dirname(home), ".oats-retirement", "baselines", createHash("sha256").update(home).digest("hex") + ".json")));
      const message = `literal ${id}: $(touch NEVER) and \`echo no\``;
      addSchedule(ws, { id, cron: "* * * * *", tz: "UTC", kind: "wake", home, message });
      homes.push({ home, log, ready, message });
    }
    const tick = time => withHostLock(() => tickWorkspace(ws, { now: new Date(time), reg: { maxConcurrent: 1 }, wsList: [ws] }));
    let result = tick("2026-09-07T12:00:00Z");
    assert.equal(result.find(r => r.id === "one").action, "started");
    assert.equal(result.find(r => r.id === "two").action, "skipped", "two cold homes cannot both start under cap one");
    assert.equal(existsSync(homes[1].log), false);
    await waitFor(() => existsSync(homes[0].ready) && inspectInstanceSession(homes[0].home).state === "unknown", "first dummy harness becomes active");
    result = tick("2026-09-07T12:00:10Z");
    const delivered = result.find(r => r.id === "one");
    assert.equal(delivered.action, "delivered", delivered.reason);
    await waitFor(() => received(homes[0]).includes("\n"), "wake reaches real stdin");
    const before = received(homes[0]);
    assert.equal(before, homes[0].message + "\n", "shell metacharacters arrive as literal text");
    assert.equal(existsSync(join(homes[0].home, "NEVER")), false);
    result = tick("2026-09-07T12:00:20Z");
    assert.equal(result.some(r => r.id === "one" && r.action === "delivered"), false, "same-minute tick sends no duplicate");
    assert.equal(received(homes[0]), before);
    // A live claim holds the wake on the real path: no byte reaches the harness, and it stays pending.
    setWaiting(homes[0].home, { producer: "oats.core", waiting: true, reason: "permission" });
    const held = tick("2026-09-07T12:01:00Z").find(r => r.id === "one");
    assert.deepEqual([held.action, held.reason, held.pending, held.held.claimReason], ["skipped", "waiting-on-you", true, "permission"]);
    await new Promise(r => setTimeout(r, 300));
    assert.equal(received(homes[0]), before, "a held wake sends no key");
    // `oats session input` is refused over a permission claim too (#2125): its Enter would answer the prompt. No byte is typed.
    assert.throws(() => inputInstanceSession(homes[0].home, "typed by hand"), (e) => e.code === "E_SESSION_PROMPT_OPEN" && /nothing was sent/.test(e.message));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(received(homes[0]), before, "a refused input sends no key");
    // Over any other claim it is unchanged: it types with the claim set (a question's, which holds the wake as well).
    setWaiting(homes[0].home, { producer: "oats.core", waiting: true, reason: "question" });
    assert.equal(tick("2026-09-07T12:01:05Z").find(r => r.id === "one").held.claimReason, "question");
    assert.equal(inputInstanceSession(homes[0].home, "typed by hand").submitted, true);
    await waitFor(() => received(homes[0]).includes("typed by hand\n"), "session input reaches stdin with a claim set");
    const typed = received(homes[0]);
    setWaiting(homes[0].home, { producer: "oats.core", waiting: false });
    assert.equal(tick("2026-09-07T12:01:10Z").find(r => r.id === "one").action, "delivered", "the claim cleared: the pending wake goes");
    await waitFor(() => received(homes[0]).length > typed.length, "the held wake reaches real stdin");
    assert.equal(received(homes[0]), typed + homes[0].message + "\n");
    inputInstanceSession(homes[0].home, "STOP-FIXTURE");
    await waitFor(() => existsSync(join(homes[0].home, ".oats-start-exited")) && inspectInstanceSession(homes[0].home).state === "shell", "dummy exits to fallback shell");
    result = tick("2026-09-07T12:02:00Z");
    assert.equal(result.find(r => r.id === "two").action, "started", "the never-launched home gets the free slot");
    assert.ok(existsSync(homes[0].home), "stopping a harness does not require deleting its persistent home");
  } finally {
    try { tmux("kill-server"); } catch { /* fixture server already gone */ }
    comeBack();
    removeTmuxTmpdir(tmuxTmpdir);
    // The tmux server exits asynchronously and may still be writing under base: bounded retry on ENOTEMPTY/EBUSY.
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fx.cleanup();
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
