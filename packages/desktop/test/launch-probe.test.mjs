// Launch-probe helpers (scripts/launch-probe.mjs) — deterministic tests for
// the packaged-launch readiness logic (review ee04a44-r2 finding 4: the
// launch logic shipped untested). Pure/injected — no Electron, no real
// processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  PHASE_BUDGET_MS, PHASE_BUDGET_SUM, WATCHDOG_MS,
  boundedTail, readDevToolsPort, awaitClose,
} from "../scripts/launch-probe.mjs";

test("WATCHDOG_MS exceeds the sum of phase budgets (finding 1 \u2014 no premature kill)", () => {
  assert.equal(PHASE_BUDGET_SUM, Object.values(PHASE_BUDGET_MS).reduce((a, b) => a + b, 0));
  assert.ok(WATCHDOG_MS > PHASE_BUDGET_SUM, `watchdog ${WATCHDOG_MS} must exceed summed budgets ${PHASE_BUDGET_SUM}`);
  // and the launch pole (readiness + evaluate) alone must fit under it
  assert.ok(WATCHDOG_MS > PHASE_BUDGET_MS.launchFixture + PHASE_BUDGET_MS.launchReady
    + PHASE_BUDGET_MS.cdpEvaluate + PHASE_BUDGET_MS.instanceLaunchReady + PHASE_BUDGET_MS.instanceCdpEvaluate,
  "both independent GUI launches and fixture setup fit the watchdog");
  assert.equal(PHASE_BUDGET_MS.stoppedLaunches, ["launchFixture", "instanceLaunchReady", "instanceCdpEvaluate", "instanceObservation",
    "repeatedLaunch", "repeatedObservation", "instanceLaunchCleanup"].reduce((sum, key) => sum + PHASE_BUDGET_MS[key], 0),
  "the stopped fixture has a separate full first and repeated launch budget");
  assert.ok(PHASE_BUDGET_MS.fixtureStop >= 10000 + 10000 + 2000, "fixture stop plan/apply and server close fit the watchdog");
  for (const key of ["launchCleanup", "instanceLaunchCleanup"]) {
    assert.ok(PHASE_BUDGET_MS[key] >= 5000 + 5000 + 2000 + 10 * (500 + 5000), `${key} includes bounded quit, viewer checks and close drain`);
  }
});

test("boundedTail keeps only the last `max` bytes; memory cannot balloon", () => {
  let buf = "";
  for (let i = 0; i < 10000; i++) buf = boundedTail(buf, "0123456789", 4096);
  assert.equal(buf.length, 4096, "tail is bounded");
  buf = boundedTail("", "short", 4096);
  assert.equal(buf, "short", "under the bound, content is preserved");
  assert.ok(boundedTail("abcdef", "ghij", 4).endsWith("ghij"), "keeps the newest bytes");
});

const io = (files, clock) => ({
  join: (...p) => p.join("/"),
  existsSync: (f) => files.has(f),
  readFileSync: (f) => { const v = files.get(f); if (v instanceof Error) throw v; return v; },
  now: () => clock.t,
  sleep: async (ms) => { clock.t += ms; },
});

test("readDevToolsPort: returns the port Chromium wrote (identity-bound, race-free)", async () => {
  const clock = { t: 0 };
  const files = new Map();
  // file appears after ~750ms of polling
  const base = io(files, clock);
  base.existsSync = (f) => clock.t >= 750 && f === "/ud/DevToolsActivePort";
  base.readFileSync = () => "45123\n/devtools/browser/abc";
  const r = await readDevToolsPort("/ud", base, { timeoutMs: 90_000, pollMs: 250 });
  assert.equal(r.port, 45123);
  assert.equal(r.wsPath, "/devtools/browser/abc");
});

test("readDevToolsPort: aborts fast when the child exits before writing the file", async () => {
  const clock = { t: 0 };
  const base = io(new Map(), clock);
  let exited = false;
  const p = readDevToolsPort("/ud", base, { timeoutMs: 90_000, pollMs: 250, childExited: () => exited });
  exited = true;
  const r = await p;
  assert.match(r.error, /child exited/);
});

test("readDevToolsPort: times out (bounded) when the file never appears", async () => {
  const clock = { t: 0 };
  const base = io(new Map(), clock);
  const r = await readDevToolsPort("/ud", base, { timeoutMs: 3000, pollMs: 250 });
  assert.match(r.error, /not written within 3s/);
  assert.ok(clock.t >= 3000 && clock.t < 3500, "respected the bounded timeout");
});

test("readDevToolsPort: tolerates a mid-write file (partial/garbage) then succeeds", async () => {
  const clock = { t: 0 };
  const files = new Map();
  const base = io(files, clock);
  base.existsSync = () => true;
  let reads = 0;
  base.readFileSync = () => { reads++; if (reads === 1) throw new Error("EBUSY: file busy mid-write"); return reads < 4 ? "" : "51999\n/ws"; }; // throw, then empty, then valid
  const r = await readDevToolsPort("/ud", base, { timeoutMs: 90_000, pollMs: 100 });
  assert.equal(r.port, 51999);
  assert.ok(reads >= 4, "retried past the throw AND the partial writes");
});

function fakeChild() {
  const c = new EventEmitter();
  c.exitCode = null; c.signalCode = null;
  return c;
}

test("awaitClose: settles on 'close', not 'exit' (data between exit and close is drained)", async () => {
  const c = fakeChild();
  let settled = false;
  const p = awaitClose(c, { drainMs: 5000 }).then(() => { settled = true; });
  c.emit("exit", 0);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "must not settle at exit");
  c.emit("close", 0);
  await p;
  assert.equal(settled, true, "settles once stdio closed");
});

test("awaitClose: a LIVE child (never exits/closes) is bounded by drainMs (review 7bdaf1e-r2 finding 2)", async () => {
  const c = fakeChild();                                 // no exit, no close ever
  let fired = 0;
  const fakeSt = (fn) => { fired++; fn(); return 1; };   // fire the total-bound timer immediately
  await awaitClose(c, { drainMs: 2000, setTimeout: fakeSt, clearTimeout: () => {} });
  assert.equal(fired, 1, "total bound armed at call and resolved without any exit/close");
});

test("awaitClose: close resolves before the bound and clears the timer", async () => {
  const c = fakeChild();
  let cleared = 0;
  const p = awaitClose(c, { drainMs: 5000, setTimeout: () => 7, clearTimeout: () => { cleared++; } });
  c.emit("close", 0);
  await p;
  assert.equal(cleared, 1, "the total-bound timer is cleared when close wins");
});
