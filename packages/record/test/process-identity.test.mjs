// The state of the holder a lock record names (identityHolderState): the one place the rule "gone when
// taken in another boot, else what the process says" is composed, for the kernel's cache write lock
// (lib/remote.mjs) and this package's capture and stream locks (lib/lock-holder.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { identityHolderState, namesIdentity, processStartToken, thisBoot } from "../lib/process-identity.mjs";

const BOOT = "boot-a";
const never = (what) => () => assert.fail(`${what} was consulted`);
/** identityHolderState over seams: this boot is BOOT, the process answers `process`, the pid answers `pid`. */
const state = (holder, { boot = BOOT, process = never("the process"), pid = never("the pid") } = {}) =>
  identityHolderState(holder, { boot, liveness: () => (typeof process === "function" ? process() : process), exists: () => (typeof pid === "function" ? pid() : { state: pid }) });

test("a record names its holder's identity when it holds a boot or a start, whatever their values", () => {
  for (const holder of [{ pid: 1, bootId: BOOT }, { pid: 1, processStart: "proc:1" }, { pid: 1, bootId: null, processStart: null }]) assert.equal(namesIdentity(holder), true, JSON.stringify(holder));
  for (const holder of [{ pid: 1 }, { pid: 1, host: "h", startedAt: "x" }]) assert.equal(namesIdentity(holder), false, JSON.stringify(holder));
});

test("a record taken in another boot is gone, whatever its process reads as; in this boot, or without a boot on either side, the process answers", () => {
  const alive = { state: "alive" };
  assert.equal(state({ pid: 7, bootId: "boot-b", processStart: "proc:1" }), "gone", "another boot: neither the process nor the pid is read");
  assert.equal(state({ pid: 7, bootId: "boot-b" }), "gone", "another boot, no start");
  assert.equal(state({ pid: 7, bootId: BOOT, processStart: "proc:1" }, { process: alive }), "alive", "this boot");
  assert.equal(state({ pid: 7, processStart: "proc:1" }, { process: alive }), "alive", "a start and no boot");
  assert.equal(state({ pid: 7, bootId: null, processStart: "proc:1" }, { process: alive }), "alive", "a record that could read no boot");
  assert.equal(state({ pid: 7, bootId: "", processStart: "proc:1" }, { process: alive }), "alive", "an empty boot is none");
  assert.equal(state({ pid: 7, bootId: "boot-b", processStart: "proc:1" }, { boot: null, process: alive }), "alive", "this host reads no boot");
});

test("a record that names its identity has its process's state: alive, gone (a reused pid, a zombie), or unknown (a start that cannot be read, a boot and no start)", () => {
  const holder = { pid: 7, bootId: BOOT, processStart: "proc:1" };
  for (const [process, expected] of [
    [{ state: "alive" }, "alive"],
    [{ state: "gone" }, "gone"],
    [{ state: "gone", zombie: true }, "gone"],
    [{ state: "unknown", reason: "the start could not be read" }, "unknown"],
  ]) assert.equal(state(holder, { process }), expected, JSON.stringify(process));
  assert.equal(state({ pid: 7, bootId: BOOT }, { process: { state: "unknown", reason: "no start to compare" } }), "unknown", "a boot and no start, its pid running");
});

test("a record that names neither boot nor start is judged by its pid alone: one that exists (another user's too) is alive, one that is gone is gone, one that cannot be read is unknown", () => {
  for (const [pid, expected] of [["exists", "alive"], ["gone", "gone"], ["unknown", "unknown"]]) assert.equal(state({ pid: 7 }, { pid }), expected, pid);
});

test("without seams it reads this boot and the real processes", () => {
  const mine = { pid: process.pid, bootId: thisBoot(), processStart: processStartToken(process.pid) };
  assert.equal(typeof mine.processStart, "string", "this host reads a process's start");
  assert.equal(identityHolderState(mine), "alive", "this process, as it would record itself");
  assert.equal(identityHolderState({ pid: process.pid }), "alive", "this process, by its pid alone");
  assert.equal(identityHolderState({ ...mine, processStart: "proc:1" }), "gone", "this pid with a start it never had");
  assert.equal(identityHolderState({ ...mine, bootId: `another-boot-than-${thisBoot()}` }), "gone", "this pid, in another boot");
  assert.equal(identityHolderState({ pid: 999999999 }), "gone", "a pid that does not exist");
  assert.equal(identityHolderState({ pid: 999999999, bootId: thisBoot(), processStart: "proc:1" }), "gone", "a pid that does not exist, with an identity");
  // PID 1 always exists; for anyone but root, kill(1, 0) answers EPERM, which is a pid that exists.
  assert.equal(identityHolderState({ pid: 1 }), "alive", "a pid that exists, another user's or not");
});
