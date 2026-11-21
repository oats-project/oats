// A dialog an extension opens raises the home's waiting claim, reason `question`,
// and closing it clears the claim. The events are those of pi 1.5.2
// (core/extensions/runner.js withUIPrompt): `ui_prompt_start` with the dialog's
// kind and, when it has one, its title, then `ui_prompt_end`; nested dialogs are
// one span. The claim is the bridge's one claim, shared with a failed turn's. The
// last tests run the real kernel CLI through the home's shim, and the bridge
// itself (extension/index.ts) in and outside an instance home.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveWaiting, validWaitingMessage, waitingHold } from "../../../lib/instance-events.mjs";

import { reportFailedTurn } from "../extension/failed-turn.mjs";
import { reportUiPrompt } from "../extension/ui-prompt.mjs";
import { claimMessage, waitingClaim } from "../extension/waiting-claim.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNNER = fileURLToPath(new URL("./run-ui-prompt.mjs", import.meta.url));

const failed = (errorMessage) => ({ messages: [{ role: "assistant", stopReason: "error", errorMessage }] });
const opened = (kind, title) => ({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });

/** The bridge's reports in a home, as index.ts wires them, with pi's events driven by hand:
 *  every handler of an event, in registration order, awaited as pi awaits them. */
function session(home) {
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) };
  const claim = waitingClaim(pi, home);
  reportFailedTurn(pi, claim);
  reportUiPrompt(pi, claim);
  return async (event, payload = {}) => { for (const handler of handlers.get(event) ?? []) await handler(payload); };
}

const settle = async (done) => { const end = Date.now() + 15000; while (!done()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };
const quiet = () => new Promise((r) => setTimeout(r, 100));

/** A home whose kernel shim records each call's argv, one JSON line each. Only what a
 *  newline ends is a call (failed-turn.test.mjs pins that read). */
function recordingHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-prompt-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "instance.json"), "{}\n");
  mkdirSync(join(home, ".oats", "bin"), { recursive: true });
  const shim = join(home, ".oats", "bin", "oats"), log = join(home, "calls");
  writeFileSync(shim, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  chmodSync(shim, 0o755);
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line)) : [];
  return { home, shim, log, calls };
}

/** A home the real kernel CLI writes to, through the shim a launch leaves. */
function kernelHome(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-prompt-real-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "agents", "dev", "instances", "dev-1");
  mkdirSync(join(home, ".oats", "bin"), { recursive: true });
  writeFileSync(join(home, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", createdAt: "2026-01-01T00:00:00.000Z" }));
  symlinkSync(join(REPO_ROOT, "bin", "oats.mjs"), join(home, ".oats", "bin", "oats"));
  return home;
}

const tail = (home) => ["--producer", "oats.pi", "--home", home, "--json"];
const questionArgv = (home, message) => ["instance", "waiting", "set", "--reason", "question", ...(message === undefined ? [] : [`--message=${message}`]), ...tail(home)];
const attentionArgv = (home, message) => ["instance", "waiting", "set", "--reason", "attention", `--message=${message}`, ...tail(home)];
const clearArgv = (home) => ["instance", "waiting", "clear", ...tail(home)];

test("a dialog sets a question claim with its title, and closing it clears the claim", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  await fire("ui_prompt_start", opened("select", "Which option should I take?"));
  await settle(() => calls().length === 1);
  assert.deepEqual(calls()[0], questionArgv(home, "Which option should I take?"));
  await quiet();
  assert.equal(calls().length, 1, "the claim stands while the dialog is open");
  await fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Which option should I take?" });
  await settle(() => calls().length === 2);
  assert.deepEqual(calls()[1], clearArgv(home));
});

test("a dialog with no title (a custom screen) sets the claim with no text", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  for (const event of [opened("custom"), { ...opened("input"), title: "  \n " }, {}, undefined]) {
    await fire("ui_prompt_start", event);
    await fire("ui_prompt_end");
  }
  await settle(() => calls().length === 8);
  assert.deepEqual(calls(), Array.from({ length: 4 }, () => [questionArgv(home), clearArgv(home)]).flat());
});

test("the claim's text is one the kernel accepts, whatever the title, bounded as a failed turn's is", () => {
  assert.equal(claimMessage("Which option?"), "Which option?");
  assert.equal(claimMessage("  Deploy\n\tto   production? "), "Deploy to production?");
  assert.equal(claimMessage(undefined), "");
  assert.equal(claimMessage(42), "");
  for (const title of ["a\n\tb\u2028c", "\u001b[2Jx\u202ey\u200b", "é".repeat(500), "😀".repeat(300)]) {
    assert.ok(validWaitingMessage(claimMessage(title)), JSON.stringify(claimMessage(title)));
  }
  assert.equal([...claimMessage("😀".repeat(300))].length, 200);
  assert.ok(claimMessage("😀".repeat(300)).endsWith("…"));
});

test("a dialog answered before the bridge heard it open leaves no claim: pi does not await a start's handlers before the end", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  await fire("ui_prompt_end");
  await fire("ui_prompt_start", opened("confirm", "Continue?"));
  await settle(() => calls().length >= 1);
  await quiet();
  assert.deepEqual(calls(), [clearArgv(home)], "this process's first write, and no set after it");
  await fire("ui_prompt_start", opened("confirm", "And now?"));
  await settle(() => calls().length === 2);
  assert.deepEqual(calls()[1], questionArgv(home, "And now?"), "the next dialog is reported");
});

test("the claim stands until the last of two overlapping spans closes", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  await fire("ui_prompt_start", opened("select", "First?"));
  await fire("ui_prompt_start", opened("select", "Second?"));
  await fire("ui_prompt_end");
  await settle(() => calls().length === 2);
  await quiet();
  assert.deepEqual(calls(), [questionArgv(home, "First?"), questionArgv(home, "Second?")], "still open");
  await fire("ui_prompt_end");
  await settle(() => calls().length === 3);
  assert.deepEqual(calls()[2], clearArgv(home));
});

test("a run that starts while a dialog is open leaves the question's claim", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  await fire("ui_prompt_start", opened("select", "Which one?"));
  await fire("agent_start");
  await fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await fire("agent_settled", { aborted: false });
  await settle(() => calls().length === 1);
  await quiet();
  assert.deepEqual(calls(), [questionArgv(home, "Which one?")]);
});

test("a dialog is shown over a failed turn, and the failed turn again once it closes", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await fire("agent_end", failed("422: refused"));
  await fire("agent_settled", { aborted: false });
  await fire("ui_prompt_start", opened("confirm", "Retry?"));
  await fire("ui_prompt_end");
  await settle(() => calls().length === 4);
  assert.deepEqual(calls(), [clearArgv(home), attentionArgv(home, "Turn failed: 422: refused"), questionArgv(home, "Retry?"), attentionArgv(home, "Turn failed: 422: refused")]);
  await fire("agent_start");
  await settle(() => calls().length === 5);
  assert.deepEqual(calls()[4], clearArgv(home), "the next run clears it");
});

test("a turn that fails while a dialog is open waits for it: the question stands, then the failed turn", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await fire("ui_prompt_start", opened("select", "Which one?"));
  await fire("agent_end", failed("503: overloaded"));
  await fire("agent_settled", { aborted: false });
  await settle(() => calls().length === 2);
  await quiet();
  assert.deepEqual(calls(), [clearArgv(home), questionArgv(home, "Which one?")]);
  await fire("ui_prompt_end");
  await settle(() => calls().length === 3);
  assert.deepEqual(calls()[2], attentionArgv(home, "Turn failed: 503: overloaded"));
});

test("a session that ends with a dialog open clears the claim, and waits for the clear", async (t) => {
  const { home, shim, log, calls } = recordingHome(t);
  const fire = session(home);
  writeFileSync(shim, `#!/bin/sh\nsleep 0.3\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${shim}.record`)} "$@"\n`);
  writeFileSync(`${shim}.record`, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  await fire("ui_prompt_start", opened("select", "Which one?"));
  assert.deepEqual(calls(), [], "the set is still under way");
  await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.deepEqual(calls(), [questionArgv(home, "Which one?"), clearArgv(home)], "both landed before the session let go");
});

test("a session that ends after its dialog closed waits for that clear, and adds none", async (t) => {
  const { home, shim, log, calls } = recordingHome(t);
  const fire = session(home);
  await fire("ui_prompt_start", opened("select", "Which one?"));
  await settle(() => calls().length === 1);
  writeFileSync(shim, `#!/bin/sh\nsleep 0.3\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${shim}.record`)} "$@"\n`);
  writeFileSync(`${shim}.record`, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  await fire("ui_prompt_end");
  assert.equal(calls().length, 1, "the clear is still under way");
  await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.deepEqual(calls(), [questionArgv(home, "Which one?"), clearArgv(home)]);
});

test("a home with no shim, or a kernel that fails, never reaches the session", async (t) => {
  for (const shim of [null, `#!/bin/sh\necho boom >&2\nexit 3\n`]) {
    const { home } = recordingHome(t);
    rmSync(join(home, ".oats", "bin", "oats"));
    if (shim) { writeFileSync(join(home, ".oats", "bin", "oats"), shim); chmodSync(join(home, ".oats", "bin", "oats"), 0o755); }
    const fire = session(home);
    await fire("ui_prompt_start", opened("select", "Which one?"));
    await fire("ui_prompt_end");
    await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("real kernel: the question reads back on the instance and holds a scheduled wake, and neither is left once it is answered", async (t) => {
  const home = kernelHome(t);
  const fire = session(home);
  assert.equal(waitingHold(home), null, "no claim, no hold");
  await fire("ui_prompt_start", opened("select", "Which option should I take?"));
  await settle(() => liveWaiting(home) !== null);
  const { since, ...shown } = liveWaiting(home);
  assert.deepEqual(shown, { producer: "oats.pi", reason: "question", message: "Which option should I take?" });
  assert.ok(!Number.isNaN(Date.parse(since)));
  assert.deepEqual(waitingHold(home), { claimReason: "question", producer: "oats.pi" }, "the schedule's read: a wake's Enter would answer the dialog");
  await fire("ui_prompt_end");
  await settle(() => liveWaiting(home) === null);
  assert.equal(waitingHold(home), null, "answered: the wake goes");
});

test("real kernel: a dialog with no title is a question with no text, and it holds too", async (t) => {
  const home = kernelHome(t);
  const fire = session(home);
  await fire("ui_prompt_start", opened("custom"));
  await settle(() => liveWaiting(home) !== null);
  assert.equal(liveWaiting(home).reason, "question");
  assert.equal(liveWaiting(home).message, null);
  assert.deepEqual(waitingHold(home), { claimReason: "question", producer: "oats.pi" });
  await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(liveWaiting(home), null, "the session's end cleared it before it returned");
});

/** The bridge itself, loaded as pi loads it, in one process: which events it listens to, and
 *  the kernel calls a dialog and the session's end made. */
function bridge({ home, env = {} }) {
  const run = { ...process.env, OATS_PKG_ROOT: REPO_ROOT, ...env };
  delete run.NODE_TEST_CONTEXT;
  if (!("OATS_INSTANCE_HOME" in env)) delete run.OATS_INSTANCE_HOME;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", RUNNER], { cwd: home, env: run, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("the bridge in an instance home reports a dialog and clears it when the session ends", async (t) => {
  const { home, calls } = recordingHome(t);
  const { listens } = bridge({ home, env: { OATS_INSTANCE_HOME: home } });
  assert.ok(listens.includes("ui_prompt_start") && listens.includes("ui_prompt_end"));
  assert.deepEqual(calls(), [questionArgv(home, "Which option should I take?"), clearArgv(home)]);
});

test("no claim outside an OATS home: no instance, or a directory that is not one, listens to no dialog and calls nothing", async (t) => {
  const { home, calls } = recordingHome(t);
  rmSync(join(home, "instance.json"));
  for (const env of [{}, { OATS_INSTANCE_HOME: home }]) {
    const { listens } = bridge({ home, env });
    assert.deepEqual(listens, ["resources_discover"]);
  }
  assert.deepEqual(calls(), []);
});
