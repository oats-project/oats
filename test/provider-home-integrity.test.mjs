// The kernel's part of a provider home's integrity (docs/capabilities.md "Session providers", "What
// the kernel trusts in a provider home"): nothing the home's agent can write is run, or read as
// configuration, by the kernel. Every home here is a real spawn through the kernel on the fake
// provider (test/helpers/session-provider-fixture.mjs); a tmux home's side is in the tmux tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { restartInstanceSession, startInstanceSession } from "../lib/core.mjs";
import { providerDeployment } from "./helpers/session-provider-fixture.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const receiptOf = (home) => join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
const recordOf = (home) => readJson(join(home, "instance.json"));
const codeOf = async (call) => { try { await call(); } catch (e) { return e.code; } return null; };

test("a launch hook is told the backend the home was last launched on, from the receipt: none at a first launch, the provider's after it, and never what the home's own record says", async (t) => {
  const fx = providerDeployment(t);
  // A home that launches nothing at its spawn: its first launch is a start.
  const { home } = await fx.spawn("dev", { name: "mover", backend: "fake", launchConfig: "claude" });
  const told = () => fx.hooks("launch").map((h) => [h.backend, h.previousBackend]);
  // An ambient value (a kernel started from inside a hook) is never passed on.
  const ambient = (run) => fx.inEnv(async () => { process.env.OATS_PREVIOUS_BACKEND = "ambient"; try { return await run(); } finally { delete process.env.OATS_PREVIOUS_BACKEND; } });
  await ambient(() => startInstanceSession(home));
  assert.deepEqual(told(), [["fake", null]], "a first launch: no previous backend");
  // Launched before: the receipt names the backend.
  fx.clearCalls();
  await ambient(() => restartInstanceSession(home));
  assert.deepEqual(told(), [["fake", "fake"]]);
  assert.equal(readJson(receiptOf(home)).runtime.backend, "fake");
  // The home's own record is not where it is read: a record that names another backend gives
  // that name to no hook (the launch is refused, since the record contradicts the receipt).
  fx.clearCalls();
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...recordOf(home), backend: "forged" }));
  assert.equal(await codeOf(() => ambient(() => restartInstanceSession(home))), "E_RUNTIME_AUTHORITY_MISMATCH");
  assert.deepEqual(told(), []);
});
