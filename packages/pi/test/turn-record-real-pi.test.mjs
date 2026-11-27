// The turn record in pi itself (turn-record.test.mjs drives the same events by hand): the session's
// first prompt, as a launch's `@TASK.md` is, reads working before its first end, and a run a person
// aborts ends with a turn-end, because pi fires agent_end for it. The cases run where a pi SDK is
// found (real-pi.mjs) and skip, saying why, where none is.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI, skip } from "./real-pi.mjs";

const RUNNER = fileURLToPath(new URL("./run-turn-record-real-pi.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("real pi: the first turn of a start reads working until it ends, and an aborted turn ends idle", { skip }, (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-turn-real-pi-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".oats"));
  writeFileSync(join(home, "instance.json"), "{}\n");
  // The home's start, as its row carries it: before pi is launched.
  const startedAt = new Date().toISOString();
  const env = { ...process.env, OATS_PKG_ROOT: REPO_ROOT };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, PI.root, PI.piAiEntry, home, startedAt], { env, encoding: "utf8", timeout: 90000 });
  assert.equal(r.status, 0, r.stderr);
  const { seen, events, promptError } = JSON.parse(r.stdout);
  assert.equal(promptError, null);
  assert.deepEqual(events, ["agent_start", "agent_end", "agent_start", "agent_end"], "one start and one end a turn, the aborted one included");
  assert.deepEqual(seen.beforeFirstPrompt, { event: null, activity: null, stopReason: null }, "a session that started writes nothing");
  assert.deepEqual([seen.firstTurnRunning.event, seen.firstTurnRunning.activity], ["turn-start", "working"]);
  assert.deepEqual(seen.firstTurnEnded, { event: "turn-end", activity: "idle", stopReason: "stop" });
  assert.deepEqual([seen.secondTurnRunning.event, seen.secondTurnRunning.activity], ["turn-start", "working"]);
  assert.deepEqual(seen.aborted, { event: "turn-end", activity: "idle", stopReason: "aborted" });
});
