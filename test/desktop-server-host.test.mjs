// createServerHost — the REAL production seam for child lifecycle, ownership
// and trust-state transitions (review wsadd3: regressions that reimplement
// `|| transition` or cache invalidation in mocks pin nothing; these import
// the module main.mjs composes, so reverting a production line fails here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServerHost } from "../packages/desktop/server-host.mjs";
import { createBackendClient } from "../packages/desktop/backend-client.mjs";

function fakeChild() {
  const c = new EventEmitter();
  c.killed = [];
  c.kill = (sig) => { c.killed.push(sig || "SIGTERM"); };
  c.exitNow = () => c.emit("exit", 0);
  return c;
}

function makeHost(over = {}) {
  const state = { spawned: [], invalidations: 0, removed: 0 };
  const host = createServerHost({
    client: createBackendClient({ request: () => { throw new Error("no request in these tests"); } }),
    spawnChild: (dirs) => { const c = fakeChild(); c.dirs = dirs; state.spawned.push(c); return { child: c, socketPath: `/run/oats-d-${state.spawned.length}/s`, secret: "s".repeat(43), remove: () => { state.removed++; } }; },
    onInvalidate: () => { state.invalidations++; },
    forceKillMs: 50,
    ...over,
  });
  return { state, host };
}

test("ownership persists through the WHOLE replacement (deferred old-child exit)", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  assert.equal(host.owned(), true);
  const replacing = host.replace(["/w/base", "/w/new"]);
  await new Promise((ok) => setImmediate(ok));
  // old child killed but exit not yet emitted: ref cleared, transition live
  assert.equal(host.current(), null, "child ref cleared during transition");
  assert.equal(host.owned(), true, "ownership PERSISTS — mid-transition adds must not see foreign");
  assert.equal(host.inTransition(), true);
  first.exitNow();
  await replacing;
  assert.equal(host.owned(), true);
  assert.equal(host.inTransition(), false);
  assert.deepEqual(state.spawned[1].dirs, ["/w/base", "/w/new"]);
});

test("trust state is invalidated at replacement START, exactly once per replace", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  assert.equal(state.invalidations, 0, "start() does not invalidate");
  const replacing = host.replace(["/w/base", "/w/new"]);
  assert.equal(state.invalidations, 1, "invalidated the moment the transition began");
  first.exitNow();
  await replacing;
  assert.equal(state.invalidations, 1);
});

test("an old child's late exit never clears the successor's reference", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  const replacing = host.replace(["/w/x"]);
  first.exitNow();
  await replacing;
  const second = host.current();
  assert.ok(second && second !== first);
  first.emit("exit", 0); // late duplicate exit from the dead predecessor
  assert.equal(host.current(), second, "successor reference intact");
});

test("replace force-kills a child that ignores SIGTERM, then proceeds", async () => {
  const { state, host } = makeHost();
  const stubborn = host.start(["/w/base"]);
  const replacing = host.replace(["/w/y"]);
  await new Promise((ok) => setTimeout(ok, 80)); // > forceKillMs
  assert.ok(stubborn.killed.includes("SIGKILL"), "escalated to SIGKILL");
  stubborn.exitNow();
  await replacing;
  assert.equal(host.current().dirs[0], "/w/y");
});

test("stop() kills and clears; owned() false afterwards", () => {
  const { host } = makeHost();
  const c = host.start(["/w/base"]);
  const stopped = host.stop();
  assert.equal(stopped, c);
  assert.equal(host.owned(), false);
  assert.ok(c.killed.length >= 1);
});

test("each generation's socket directory is removed when it ends, and at stop()", async () => {
  const { state, host } = makeHost();
  const first = host.start(["/w/base"]);
  const replacing = host.replace(["/w/x"]);
  first.exitNow();
  await replacing;
  assert.equal(state.removed >= 1, true, "the outgoing generation's directory is gone");
  const before = state.removed;
  host.stop();
  assert.equal(state.removed, before + 1, "stop() removes the current one");
});
