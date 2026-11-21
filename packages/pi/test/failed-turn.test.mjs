// A turn that ends in a provider error is reported through the kernel's waiting
// claim, and only once pi has finished trying (awebai/oats#1667). The events are
// those of pi 1.3.0 against a provider answering 422, 503 and 503-then-200: each
// attempt has its own agent_start and agent_end, and one agent_settled ends them.
// The last test runs the real kernel CLI through the home's shim.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { liveWaiting, setWaiting, validWaitingMessage } from "../../../lib/instance-events.mjs";
import { REFUSED_TEXT } from "../../../lib/refused-text.mjs";

import { failedTurnMessage, MESSAGE_REFUSED, reportFailedTurn } from "../extension/failed-turn.mjs";
import { waitingClaim } from "../extension/waiting-claim.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const failed = (errorMessage) => ({ messages: [{ role: "user" }, { role: "assistant", stopReason: "error", errorMessage }] });
const ended = (stopReason) => ({ messages: [{ role: "assistant", stopReason }] });

/** The report in a home, with pi's events driven by hand. */
function session(home) {
  const handlers = new Map();
  const pi = { on: (event, handler) => handlers.set(event, handler) };
  reportFailedTurn(pi, waitingClaim(pi, home));
  return (event, payload = {}) => handlers.get(event)(payload);
}

const settle = async (done) => { const end = Date.now() + 15000; while (!done()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };

/** A home whose kernel shim records each call's argv, one JSON line each. */
function recordingHome(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-failed-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "instance.json"), "{}\n");
  mkdirSync(join(home, ".oats", "bin"), { recursive: true });
  const shim = join(home, ".oats", "bin", "oats"), log = join(home, "calls");
  writeFileSync(shim, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  chmodSync(shim, 0o755);
  // The shim writes a line and its newline as one buffer, but the file exists before they arrive: only
  // what a newline ends is a call, so a read in between sees none, not an empty or half line.
  const all = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(0, -1).map((line) => JSON.parse(line)) : [];
  return { home, log, all, calls: () => all().slice(1) };
}

const setArgv = (home, message) => ["instance", "waiting", "set", "--reason", "attention", `--message=${message}`, "--producer", "oats.pi", "--home", home, "--json"];
const clearArgv = (home) => ["instance", "waiting", "clear", "--producer", "oats.pi", "--home", home, "--json"];

test("the shim's log, read while it writes: an empty file holds no call, and neither does a line with no newline yet", (t) => {
  const { log, all } = recordingHome(t);
  assert.deepEqual(all(), [], "no file yet");
  writeFileSync(log, "");
  assert.deepEqual(all(), [], "created, nothing in it");
  writeFileSync(log, '["one"]\n["tw');
  assert.deepEqual(all(), [["one"]], "the half line waits");
  writeFileSync(log, '["one"]\n["two"]\n');
  assert.deepEqual(all(), [["one"], ["two"]]);
});

test("a provider refusal: the claim is set once pi settles, not at agent_end, and the next run clears it", async (t) => {
  const { home, all, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await settle(() => all().length === 1);
  await fire("agent_end", failed("422: cyber_policy"));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(calls(), [], "nothing at agent_end: pi may yet retry");
  await fire("agent_settled", { aborted: false });
  await settle(() => calls().length === 1);
  assert.deepEqual(calls()[0], setArgv(home, "Turn failed: 422: cyber_policy"));
  await fire("agent_start");
  await settle(() => calls().length === 2);
  assert.deepEqual(calls()[1], clearArgv(home));
});

test("a transient error pi retries raises nothing: not while it retries, and not when a retry works", async (t) => {
  const { home, all, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await settle(() => all().length === 1);
  await fire("agent_end", failed("503: overloaded"));
  await fire("agent_start");
  await fire("agent_end", ended("stop"));
  await fire("agent_settled", { aborted: false });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls(), []);
});

test("retries that run out are reported once, with the last error", async (t) => {
  const { home, calls } = recordingHome(t);
  const fire = session(home);
  for (const error of ["503: first", "503: second", "503: third"]) {
    await fire("agent_start");
    await fire("agent_end", failed(error));
  }
  await fire("agent_settled", { aborted: false });
  await settle(() => calls().length === 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls(), [setArgv(home, "Turn failed: 503: third")]);
});

test("an aborted run and a finished run raise nothing, and a run with no claim to clear starts no process", async (t) => {
  const { home, all, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await settle(() => all().length === 1);
  await fire("agent_end", ended("aborted"));
  await fire("agent_settled", { aborted: true });
  await fire("agent_start");
  await fire("agent_end", ended("stop"));
  await fire("agent_settled", { aborted: false });
  await fire("agent_start");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls(), []);
});

test("an abort during a retry's backoff is not a failure: agent_settled says so, with no agent_end after the error", async (t) => {
  const { home, all, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await settle(() => all().length === 1);
  await fire("agent_end", failed("503: overloaded"));
  await fire("agent_settled", { aborted: true });
  await fire("agent_settled", { aborted: false });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls(), [], "the error is dropped, not kept for a later settle");
});

test("a session that ends waits for its writes, so a /reload's next reporter cannot be overtaken", async (t) => {
  const { home, all, calls } = recordingHome(t);
  const shim = join(home, ".oats", "bin", "oats");
  const fire = session(home);
  await fire("agent_start");
  await settle(() => all().length === 1);
  writeFileSync(shim, `#!/bin/sh\nsleep 0.3\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(`${shim}.record`)} "$@"\n`);
  writeFileSync(`${shim}.record`, `require("node:fs").appendFileSync(${JSON.stringify(join(home, "calls"))}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  await fire("agent_end", failed("422: refused"));
  await fire("agent_settled", { aborted: false });
  assert.deepEqual(calls(), [], "the set is still under way");
  await fire("session_shutdown");
  assert.deepEqual(calls(), [setArgv(home, "Turn failed: 422: refused")]);
});

test("the first run of a process clears what an earlier pi in the session left, once", async (t) => {
  const { home, all } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await fire("agent_start");
  await settle(() => all().length >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(all(), [clearArgv(home)]);
});

test("an agent_end with no messages raises nothing and throws nothing", async (t) => {
  const { home, all, calls } = recordingHome(t);
  const fire = session(home);
  await fire("agent_start");
  await settle(() => all().length === 1);
  await fire("agent_end");
  await fire("agent_settled", {});
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(calls(), []);
});

test("a home with no shim, or a kernel that fails, never reaches the session", async (t) => {
  for (const shim of [null, `#!/bin/sh\necho boom >&2\nexit 3\n`]) {
    const { home } = recordingHome(t);
    rmSync(join(home, ".oats", "bin", "oats"));
    if (shim) { writeFileSync(join(home, ".oats", "bin", "oats"), shim); chmodSync(join(home, ".oats", "bin", "oats"), 0o755); }
    const fire = session(home);
    await fire("agent_start");
    await fire("agent_end", failed("422: refused"));
    await fire("agent_settled", { aborted: false });
    await fire("agent_start");
    await new Promise((r) => setTimeout(r, 100));
  }
});

test("the message is one the kernel accepts, whatever the provider said, and the bridge's refused set is the kernel's", () => {
  assert.equal(failedTurnMessage("422: refused"), "Turn failed: 422: refused");
  assert.equal(failedTurnMessage(undefined), "Turn failed");
  assert.equal(failedTurnMessage("   "), "Turn failed");
  for (const error of ["a\n\tb\u2028c", "\u001b[2Jx\u202ey\u200b", "é".repeat(500), "😀".repeat(300)]) {
    const message = failedTurnMessage(error);
    assert.ok(validWaitingMessage(message), JSON.stringify(message));
  }
  assert.equal([...failedTurnMessage("é".repeat(500))].length, 200);
  assert.ok(failedTurnMessage("é".repeat(500)).endsWith("…"));
  assert.equal(MESSAGE_REFUSED.source, REFUSED_TEXT.source);
  assert.ok(MESSAGE_REFUSED.flags.includes("u"));
});

test("real kernel: the claim reads back on the instance, beside the agent's own, and the clear leaves that one", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-pi-failed-real-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "agents", "dev", "instances", "dev-1");
  mkdirSync(join(home, ".oats", "bin"), { recursive: true });
  writeFileSync(join(home, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", createdAt: "2026-01-01T00:00:00.000Z" }));
  symlinkSync(join(REPO_ROOT, "bin", "oats.mjs"), join(home, ".oats", "bin", "oats"));
  const fire = session(home);
  setWaiting(home, { producer: "agent", waiting: true, reason: "attention", message: "my own question" });
  await new Promise((r) => setTimeout(r, 2));
  await fire("agent_start");
  await fire("agent_end", failed("422: cyber_policy"));
  await fire("agent_settled", { aborted: false });
  await settle(() => liveWaiting(home)?.producer === "oats.pi");
  assert.deepEqual(liveWaiting(home).message, "Turn failed: 422: cyber_policy");
  assert.equal(liveWaiting(home).reason, "attention");
  await fire("agent_start");
  await settle(() => liveWaiting(home)?.producer === "agent");
  assert.equal(liveWaiting(home).message, "my own question", "the agent's own claim stands");
});
