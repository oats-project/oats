process.env.TZ = "UTC";
// Pinned instances (feature instance-pin) in the TUI: the list follows the shared order, pinned first in its
// machine's list (a pinned child lifts its group), only when this run's kernel lists the feature; `p` pins or
// unpins the selected row at once through the kernel's verb (lib/main.mjs pinAct, over the shared pinInstance),
// and the line under the sidebar's title says what it did, or why it did nothing. Every entry is made by the shared
// functions (helpers.mjs); no test needs a terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { PIN_FEATURE, instanceId, pinInstance } from "../lib/client.mjs";
import { PIN_WORDS, pinLine, roster } from "../lib/model.mjs";
import { reduce } from "../lib/store.mjs";
import { ACTIONS } from "../lib/actions.mjs";
import { helpRows } from "../lib/views/help.mjs";
import { CLI, instanceRow, observed, press, rowStrings, stateOf } from "./helpers.mjs";

/** The kernel record of a run whose kernel lists the feature; CLI's does not. */
const PIN_CLI = Object.freeze({ ...CLI, features: Object.freeze([...CLI.features, PIN_FEATURE]) });
const at = (day) => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`;
/** newest (a root), lead with its children kid-old (pinned) and kid-new, and solo (old, pinned when asked). */
const ROWS = (extra = {}) => [
  instanceRow("dev", "newest", { createdAt: at(10), ...extra.newest }),
  instanceRow("dev", "lead", { createdAt: at(2), ...extra.lead }),
  instanceRow("ops", "kid-old", { createdAt: at(3), parentInstance: "lead", ...extra["kid-old"] }),
  instanceRow("ops", "kid-new", { createdAt: at(4), parentInstance: "lead", ...extra["kid-new"] }),
  instanceRow("dev", "solo", { createdAt: at(1), ...extra.solo }),
];
const run = (rows = ROWS(), cli = PIN_CLI) => stateOf(observed(rows, { cli }), { cli });
const order = (state) => roster(state).rows.map((item) => item.row.instance);
const rowOf = (state, name) => roster(state).instances.find((row) => row.instance === name);
/** The state with `name` selected. */
const selecting = (state, name) => ({ ...state, selected: instanceId(rowOf(state, name)) });
/** A line's words, as the TUI says them (`own` and `shown` parts in order). */
const words = (said) => said.map((part) => part.own ?? part.shown).join("");

test("the feature's name is the kernel's", () => {
  assert.equal(PIN_FEATURE, "instance-pin");
});

test("without a pin the list is the roster's order: spawn time, newest first; a child under its parent", () => {
  assert.deepEqual(order(run()), ["newest", "lead", "kid-new", "kid-old", "solo"]);
});

test("a pinned child lifts its group to the top, and rises among its siblings; a pinned root leads by itself", () => {
  const s = run(ROWS({ "kid-old": { pinned: true } }));
  assert.deepEqual(order(s), ["lead", "kid-old", "kid-new", "newest", "solo"]);
  const two = run(ROWS({ "kid-old": { pinned: true }, solo: { pinned: true } }));
  assert.deepEqual(order(two), ["lead", "kid-old", "kid-new", "solo", "newest"], "two pinned groups by spawn time, newest first");
});

test("without the kernel's feature a row's pinned is ignored, and a stray value never pins", () => {
  assert.deepEqual(order(run(ROWS({ solo: { pinned: true } }), CLI)), ["newest", "lead", "kid-new", "kid-old", "solo"]);
  assert.deepEqual(order(run(ROWS({ solo: { pinned: "true" } }))), ["newest", "lead", "kid-new", "kid-old", "solo"]);
});

test("p pins the selected row at once: the line says so, and the loop runs the verb; on a pinned row it unpins", () => {
  const s = selecting(run(), "solo");
  const { state, effects } = press(s, ["p"]);
  assert.equal(effects.length, 1);
  const { id, row, pinned: value } = effects[0].pin;
  assert.deepEqual([id, row.instance, row.home, value], [instanceId(rowOf(s, "solo")), "solo", rowOf(s, "solo").home, true]);
  assert.equal(words(state.outcome.said), "Pinning solo…");
  assert.ok(state.pinning.has(instanceId(rowOf(s, "solo"))));
  const pinned = selecting(run(ROWS({ solo: { pinned: true } })), "solo");
  const off = press(pinned, ["p"]);
  assert.equal(off.effects[0].pin.pinned, false);
  assert.equal(words(off.state.outcome.said), "Unpinning solo…");
});

test("a second p while the pin of that row is changing sends nothing and says so", () => {
  const first = press(selecting(run(), "solo"), ["p"]).state;
  const again = press(first, ["p"]);
  assert.deepEqual(again.effects, []);
  assert.equal(words(again.state.outcome.said), "The pin of solo is still changing.");
});

test("without the kernel's feature p does nothing, and the line says why and names the command", () => {
  const { state, effects } = press(selecting(run(ROWS(), CLI), "solo"), ["p"]);
  assert.deepEqual(effects, []);
  assert.deepEqual(state.outcome.said, PIN_WORDS.unavailable);
  assert.match(words(state.outcome.said), /instance-pin/);
  assert.match(words(state.outcome.said), /oats instance pin <name> on\|off/);
});

test("a held or retiring row: p does nothing, and the line gives the row's reason", () => {
  for (const held of [{ retirePending: true }, { spawnInProgress: true }, { rollbackIncomplete: true }]) {
    const { state, effects } = press(selecting(run(ROWS({ solo: held })), "solo"), ["p"]);
    assert.deepEqual(effects, [], JSON.stringify(held));
    assert.ok(state.outcome.under.length > 0, `${JSON.stringify(held)}: says why`);
  }
});

test("the answer: the line says the pin, the row is free again, and the rows are read again", () => {
  const s = press(selecting(run(), "solo"), ["p"]).state, id = instanceId(rowOf(s, "solo"));
  const done = reduce(s, { pinned: { id, name: "solo", pinned: true, answer: { status: "ok", instance: "solo", pinned: true, changed: true } } });
  assert.deepEqual(done.effect, { refresh: { live: true } });
  assert.equal(done.state.pinning.has(id), false);
  assert.equal(words(done.state.outcome.said), "solo is pinned to the top of its machine's list.");
  const refused = reduce(s, { pinned: { id, name: "solo", pinned: true, answer: { status: "refused", reason: { code: "E_INSTANCE_RETIRING", message: "solo is being retired" } } } });
  assert.equal(words(refused.state.outcome.said), "The pin of solo was not changed.");
  assert.ok(refused.state.outcome.under.some((line) => line.includes("solo is being retired")), "the kernel's words under it");
  assert.deepEqual(refused.effect, { refresh: { live: true } });
  for (const answer of [{ status: "unknown", reason: { code: "E_CLI_TIMEOUT" } }, null, { status: "ok", instance: "solo", pinned: false, changed: true }]) {
    assert.equal(words(reduce(s, { pinned: { id, name: "solo", pinned: true, answer } }).state.outcome.said), "OATS didn't confirm the pin of solo. The list shows it once it is read again.", JSON.stringify(answer));
  }
  assert.equal(words(pinLine("solo", false, { status: "ok", instance: "solo", pinned: false, changed: false }).said), "solo is unpinned.");
});

test("the help lists p, what it does, and the command it runs; the key is the action table's own", () => {
  const pin = ACTIONS.find((action) => action.id === "pin");
  assert.deepEqual(pin.keys, ["p"]);
  const text = rowStrings(helpRows(ACTIONS, false, 400), 400).join("\n");
  assert.match(text, /\bp +pin the selected agent at the top of its list or unpin it, as oats instance pin <name> on\|off; needs instance-pin$/m, "one row: the key, the act, the command and the feature it needs");
});

test("pinInstance runs the kernel's verb as argv and reads its answer by the shared rule", async () => {
  const runs = [];
  const exec = (bin, argv, options, done) => {
    runs.push({ bin, argv, cwd: options.cwd });
    done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instancePinApi: 1, instance: "solo", home: "/d/agents/dev/instances/solo", pinned: true, changed: true } }), "");
  };
  const answer = await pinInstance("/opt/oats/bin/oats.mjs", { instance: "solo", home: "/d/agents/dev/instances/solo", pinned: true, context: "/d" }, { exec });
  assert.deepEqual(answer, { status: "ok", instance: "solo", pinned: true, changed: true });
  assert.deepEqual(runs, [{ bin: "/opt/oats/bin/oats.mjs", argv: ["instance", "pin", "solo", "on", "--home", "/d/agents/dev/instances/solo", "--dir", "/d", "--json"], cwd: "/d" }]);
  const other = await pinInstance("/opt/oats/bin/oats.mjs", { instance: "other", home: "/d/agents/dev/instances/other", pinned: true, context: "/d" }, { exec });
  assert.equal(other.status, "unknown", "an answer for another instance is no success");
  const never = () => assert.fail("must not run");
  assert.equal((await pinInstance("/opt/oats/bin/oats.mjs", { instance: "solo", home: "relative", pinned: true, context: "/d" }, { exec: never })).status, "unknown", "refused before running: no kernel answer");
});
