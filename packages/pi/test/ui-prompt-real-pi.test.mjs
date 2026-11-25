// A dialog in pi itself raises the home's waiting claim and holds a scheduled
// wake, and is cleared when it is answered and when the session ends
// (ui-prompt.test.mjs drives the same by hand). The cases run where a pi SDK
// is found (real-pi.mjs: pi 0.85 and later, which all fire `ui_prompt_start`
// and `ui_prompt_end`) and skip, saying why, where none is.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI, skip } from "./real-pi.mjs";

const RUNNER = fileURLToPath(new URL("./run-ui-prompt-real-pi.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const QUESTION = "Which option should I take?";
const OPEN = { waiting: { producer: "oats.pi", reason: "question", message: QUESTION }, hold: { claimReason: "question", producer: "oats.pi" } };
const CLOSED = { waiting: null, hold: null };

function run(t, scenario) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-prompt-real-pi-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "agents", "dev", "instances", "dev-1");
  mkdirSync(join(home, ".oats", "bin"), { recursive: true });
  writeFileSync(join(home, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", createdAt: "2026-01-01T00:00:00.000Z" }));
  symlinkSync(join(REPO_ROOT, "bin", "oats.mjs"), join(home, ".oats", "bin", "oats"));
  const env = { ...process.env, OATS_PKG_ROOT: REPO_ROOT };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [RUNNER, PI.root, PI.piAiEntry, scenario, home], { env, encoding: "utf8", timeout: 90000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("real pi: a tool's dialog raises a question claim that holds a wake, and answering it leaves neither", { skip }, (t) => {
  const seen = run(t, "answered");
  assert.equal(seen.promptError, null);
  assert.equal(seen.shown, QUESTION, "the dialog the person saw");
  assert.deepEqual(seen.events, [{ type: "ui_prompt_start", kind: "select", title: QUESTION }, { type: "ui_prompt_end", kind: "select", title: QUESTION }]);
  assert.deepEqual(seen.open, OPEN);
  assert.deepEqual(seen.closed, CLOSED);
  assert.equal(seen.toolResult, "chosen: Option A", "the run went on with the answer");
});

test("real pi: a session that ends with the dialog open has cleared the claim by the time its shutdown handlers return", { skip }, (t) => {
  const seen = run(t, "session-ends");
  assert.deepEqual(seen.open, OPEN);
  assert.deepEqual(seen.closed, CLOSED);
});
