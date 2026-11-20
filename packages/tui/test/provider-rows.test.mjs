process.env.TZ = "UTC";
// A row on a session provider (spec C1: a capability's session backend, "bb" say) in the TUI: Enter opens
// nothing and says where the agent runs, with the provider's link printed under it; the palette and a
// workspace's remembered tabs never open it. Whether a row is one is the shared openAct's
// (packages/desktop/test/instance-acts.test.mjs); the rows are made by the shared reader (helpers.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { instanceActs, instanceId, openAct } from "../lib/client.mjs";
import { model, openDecision, paletteItems, roster } from "../lib/model.mjs";
import { TAB_LIMIT, reduce } from "../lib/store.mjs";
import { DEPLOYMENT, NOW, instanceRow, observed, press, stateOf, took } from "./helpers.mjs";

const SENTENCE = "Runs in a bb thread; open it in bb.";
const LINK = Object.freeze({ label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" });
/** A bb row as the shared reader hands it on: no tmux target, the kernel's own state. */
const bbRow = (name, extra = {}) => instanceRow("dev", name, { backend: "bb", tmux: null, runtimeState: "unknown",
  session: { provider: "oats.bb", threadId: "thr_x" }, open: LINK, ...extra });
const rowOf = (state, name) => roster(state).instances.find((row) => row.instance === name);
const on = (state, name) => Object.freeze({ ...state, selected: instanceId(rowOf(state, name)) });

test("Enter on a provider row opens nothing in any state and says the shared sentence; its link is printed under it, as the kernel's", () => {
  const state = stateOf(observed([instanceRow("dev", "dev-t"), bbRow("dev-run"), bbRow("dev-idle", { running: null }),
    bbRow("dev-stopped", { running: false, runtimeState: "stopped", open: null })]));
  for (const [name, under] of [["dev-run", [SENTENCE, `OATS says: ${LINK.label}: ${LINK.url}`]], ["dev-idle", [SENTENCE, `OATS says: ${LINK.label}: ${LINK.url}`]], ["dev-stopped", [SENTENCE]]]) {
    const row = rowOf(state, name), act = openAct(row);
    assert.equal(act.reason.code, "no-terminal", name);
    assert.deepEqual(openDecision(state, row, instanceActs(row)), { open: false, said: { said: [], under } }, name);
    const { state: after, effects } = press(on(state, name), ["enter"]);
    assert.deepEqual([effects, after.opening, after.terminal, after.tabs], [[], null, null, []], `${name}: nothing is opened`);
    assert.deepEqual(after.outcome, { said: [], under }, `${name}: the line says why`);
  }
  // The tmux row beside them opens as it always did.
  assert.equal(press(on(state, "dev-t"), ["enter"]).effects[0].open.open, true);
});

test("a provider row is not one the palette opens", () => {
  const state = stateOf(observed([instanceRow("dev", "dev-t"), bbRow("dev-run")]));
  const listed = paletteItems(press(state, ["ctrl+k"]).state).items.filter((item) => item.kind === "instance").map((item) => item.name);
  assert.deepEqual(listed, ["dev-t"]);
});

// ── A4: the tab set ──
const AT = Object.freeze({ page: 19, extent: 0, room: 19, cols: 38, panel: Object.freeze({ cols: 89, rows: 40 }) });
let reads = 0;
const key = (state, id) => reduce(state, { key: id, ...(id.length === 1 ? { text: id } : {}), read: ++reads, ...AT });
const shown = (state) => { const tab = state.tabs.find((each) => each.status === "starting"); return tab ? reduce(state, { shown: { id: tab.id }, ...AT }) : { state, effect: null }; };
const enter = (state, name) => shown(key(on(state, name), "enter").state).state;
const OTHER = "/srv/other";
const go = (state, id) => reduce(state, { admitted: id, at: "2026-10-11T10:01:00.000Z", ...AT });

test("A4: a remembered tab whose row is now a provider's is not restored, and nothing errors; the others open as they were", () => {
  const names = ["dev-a", "dev-b", "dev-c"];
  let a = stateOf(observed(names.map((name) => instanceRow("dev", name))));
  for (const name of names) a = enter(a, name);
  assert.deepEqual(a.tabs.map((tab) => tab.name), names);
  // Away to another workspace: A's tabs are remembered.
  let away = go(a, OTHER).state;
  away = took(away, observed([instanceRow("ops", "ops-a", { home: `${OTHER}/agents/ops/instances/ops-a` })], { workspace: "acme-billing" }), 2, OTHER);
  // Meanwhile A is read again: dev-a's home now runs on bb (retired and spawned again under its name).
  away = took(away, observed([bbRow("dev-a"), instanceRow("dev", "dev-b"), instanceRow("dev", "dev-c")]), 3, DEPLOYMENT);
  let back = go(away, a.open), opened = [];
  for (let i = 0; i < 2 * TAB_LIMIT && (back.effect?.open || back.state.tabs.some((tab) => tab.status === "starting")); i++) {
    if (back.effect?.open) opened.push(back.effect.open.name);
    back = shown(back.state);
  }
  assert.deepEqual(opened, ["dev-b", "dev-c"], "dev-a is passed over, quietly");
  assert.deepEqual([back.state.tabs.map((tab) => tab.name), back.state.restoring, back.state.opening], [["dev-b", "dev-c"], null, null]);
  assert.equal(back.state.outcome ?? null, null, "and no line is said for it");
});

test("the detail's state of a provider row agrees with its mark: running or stopped when the kernel says so, the kernel's own word when it does not", () => {
  const state = stateOf(observed([bbRow("dev-run"), bbRow("dev-stopped", { running: false, runtimeState: "stopped" }), bbRow("dev-idle", { running: null }),
    bbRow("dev-lost", { running: null, runtimeState: "unreachable", runtimeError: "E_SESSION_UNAVAILABLE: bb did not answer" }), instanceRow("dev", "dev-t")]));
  const stateOfRow = (name) => model(on(state, name), { page: 19, now: NOW, at: new Date(NOW).toISOString() }).detail.facts.find((fact) => fact.label === "state").value;
  assert.equal(rowOf(state, "dev-run").runtimeState, "unknown", "the provider's word while it runs");
  assert.equal(stateOfRow("dev-run"), "running");
  assert.equal(stateOfRow("dev-stopped"), "stopped");
  assert.equal(stateOfRow("dev-idle"), "unknown");
  assert.equal(stateOfRow("dev-lost"), "unreachable");
  assert.equal(stateOfRow("dev-t"), "running", "a tmux row's word is the one reported, as before");
});
