process.env.TZ = "UTC";
// The leader and the palette in the store (docs/tui.md, "The leader" and "The palette"; spec T1b,
// Done 0 to 2): every event carries the number of the read of input it came in, as the loop hands
// it on, because what the leader and the palette take depends on which read a key arrived in.
// Every entry is made by the shared functions (helpers.mjs); no test needs a terminal.
import test from "node:test";
import assert from "node:assert/strict";
import { instanceId } from "../lib/client.mjs";
import { LEADER_WORDS, LIST_WORDS, WORKSPACE_WORDS, memoryKey, paletteItems, recentOf, roster } from "../lib/model.mjs";
import { initialState, reduce } from "../lib/store.mjs";
import { CLI, instanceRow, leaderEscape, leaderThen, leaderTwice, observed, stateOf } from "./helpers.mjs";

/** A kernel that starts and restarts sessions and plans stops and retires: every act is offered. */
const ACTS_CLI = Object.freeze({ ...CLI, lifecycleApi: 1, features: Object.freeze([...CLI.features, "session-start", "session-restart", "lifecycle-plans", "retire-retention", "retire-home"]) });
const STOPPED = { running: false, runtimeState: "stopped" };
/** The geometry of the frame before each key: the store reads it for a move, never keeps it. */
const AT = Object.freeze({ page: 19, extent: 0, room: 19, cols: 38 });

/** Drawn dev-a, dev-c, dev-b: the stopped one last, and it cannot be opened. */
const THREE = () => stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-b", STOPPED), instanceRow("dev", "dev-c")], { cli: ACTS_CLI }), { cli: ACTS_CLI });
/** Drawn alpha, alpha-kid, lead, child-a, grandchild, child-b, the empty row, solo-x, solo-y;
 *  alpha, child-b and solo-y are stopped. `options` are initialState's (a `platform`). */
const TREE = (options = {}) => stateOf(observed([
  instanceRow("dev", "solo-y", STOPPED),
  instanceRow("dev", "grandchild", { parentInstance: "child-a" }),
  instanceRow("dev", "lead"),
  instanceRow("dev", "child-b", { parentInstance: "lead", ...STOPPED }),
  instanceRow("dev", "alpha", STOPPED),
  instanceRow("dev", "solo-x"),
  instanceRow("dev", "child-a", { parentInstance: "lead" }),
  instanceRow("dev", "alpha-kid", { parentInstance: "alpha" }),
]), options);

let reads = 0;
/** A key in a read of its own (or in `read`); a one-character id types itself. */
const key = (state, id, read = ++reads) => reduce(state, { key: id, ...(id === "space" ? { text: " " } : id.length === 1 ? { text: id } : {}), read, ...AT });
/** Keys, each in a read of its own. -> the last step */
function keys(state, ...ids) {
  let step = { state, effect: null };
  for (const id of ids) step = key(step.state, id);
  return step;
}
/** The leader alone, in a read of its own (or in `read`): `{ back }` from the terminal's focus, else
 *  the leader's key. */
const leader = (state, read = ++reads, rest = false) => (state.terminal?.focus === "terminal" && state.view === "instances" && state.palette === null
  ? reduce(state, { back: true, read, rest, ...AT })
  : reduce(state, { key: state.leaderKey, read, ...AT }));
/** The leader twice, each in a read of its own, from any focus (helpers.mjs leaderTwice is the
 *  terminal's: from the list its `{ back }` is no key). From the list's focus it only cancels the
 *  leader; from the terminal's it types the leader's bytes into the agent. */
const twice = (state) => key(leader(state).state, state.leaderKey);
/** The instance's id and its row, by name. */
const idOf = (state, name) => instanceId(rowOf(state, name));
const rowOf = (state, name) => roster(state).instances.find((row) => row.instance === name);
/** The state with `name` selected, as the list's moves leave it. */
const on = (state, name) => Object.freeze({ ...state, selected: idOf(state, name) });
/** `name`'s terminal opened from the list and shown by the panel: the focus is in it. */
function opened(state, name) {
  const open = key(on(state, name), "enter").state;
  return reduce(open, { shown: { id: idOf(state, name) }, ...AT }).state;
}
/** What openDecision gives for a row of this machine, as the `open` effect carries it. */
const decision = (state, name) => ({ open: true, id: idOf(state, name), name, machine: null, target: { home: rowOf(state, name).home }, routed: false });
/** The state but its leader: what the leader's step leaves when it changed nothing else. */
const butLeader = (state) => ({ ...state, leader: null });
/** The palette's rows as `kind label`. */
const rows = (state) => paletteItems(state).items.map((item) => `${item.kind} ${item.label}`);

// ── The leader in the list ───────────────────────────────────────────────────────────────────────

test("in the list, the leader then a key of its table in a later read does what that action does: ? the help, 2 Souls, 3 Capabilities, o the workspaces, / the filter field, 1 back to the instances", () => {
  const state = THREE();
  for (const [k, plain] of [["?", "?"], ["2", "2"], ["3", "3"], ["o", "w"], ["/", "/"]]) {
    const led = leaderThen(state, k, AT), pressed = key(state, plain);
    assert.deepEqual([led.leader.state.leader.waiting, led.leader.effect], [true, null], `${k}: the leader waits`);
    assert.equal(led.state.leader.waiting, false, `${k}: the leader is spent`);
    assert.deepEqual([butLeader(led.state), led.effect], [butLeader(pressed.state), pressed.effect], `${k} after the leader is ${plain} in the list`);
  }
  assert.deepEqual([leaderThen(state, "?", AT).state.view, leaderThen(state, "?", AT).state.back], ["help", "instances"]);
  assert.deepEqual([leaderThen(state, "o", AT).state.view, leaderThen(state, "o", AT).state.focus, leaderThen(state, "o", AT).effect], ["instances", "workspaces", null], "o: the list of workspaces' focus");
  assert.deepEqual(leaderThen(state, "/", AT).state.filter, { editing: true, query: "" });
  const souls = leaderThen(state, "2", AT).state;
  assert.equal(souls.view, "souls");
  const back = leaderThen(souls, "1", AT);
  assert.deepEqual([back.state.view, back.state.back, back.state.selected, back.effect], ["instances", "instances", state.selected, null]);
});

/** The line of a leader whose key came in its own read, with the test's leader: a line of one key. */
const MERGED = { said: LEADER_WORDS.merged("Ctrl+\\"), under: [], once: true };

test("a key in the leader's own read cancels it and does nothing but say so: a paste cannot run a command, and the key after it in a later read is a plain key again", () => {
  const state = THREE();
  const read = ++reads, waiting = leader(state, read).state;
  assert.deepEqual(waiting.leader, { read, waiting: true });
  for (const k of ["?", "2", "o", "X", "k", "escape"]) {
    const same = key(waiting, k, read);
    assert.deepEqual([same.state.leader, same.effect], [{ read, waiting: false }, null], k);
    assert.deepEqual(same.state.outcome, MERGED, `${k}: the line says why nothing ran`);
    assert.deepEqual(butLeader({ ...same.state, outcome: null }), butLeader(state), `${k}: nothing else changed`);
    // The rest of that read is dropped too, and the line stays.
    const rest = key(same.state, "j", read);
    assert.deepEqual([rest.state.outcome, rest.state.selected, rest.effect], [MERGED, same.state.selected, null], `${k}: the rest of the read`);
  }
  // The leader no longer waits: `o` is the leader's workspaces only after it, and bound to nothing in the list.
  const after = key(key(waiting, "?", read).state, "o");
  assert.deepEqual([after.state.view, after.state.leader, after.effect], ["instances", null, null]);
  assert.equal(after.state.outcome, null, "a key bound to nothing, in a later read, clears the line: a line of one key");
  assert.equal(key(key(waiting, "?", read).state, "j").state.outcome, null, "a key of the list in a later read clears the line, as it clears any");
});

test("a key not in the leader's table cancels it and is dropped: no action runs, and nothing is typed into an open filter field, nor pasted", () => {
  const state = THREE();
  for (const k of ["q", "j", "enter", "x", "c", "tab", "ctrl+c"]) {
    const led = leaderThen(state, k, AT);
    assert.deepEqual([led.state.leader.waiting, led.effect], [false, null], k);
    assert.deepEqual(butLeader(led.state), butLeader(state), `${k}: dropped`);
  }
  const typing = keys(state, "/", "d", "e").state;
  assert.deepEqual(typing.filter, { editing: true, query: "de" });
  for (const k of ["x", "q", "backspace", "enter"]) {
    const led = leaderThen(typing, k, AT);
    assert.deepEqual([led.state.filter, led.state.leader.waiting, led.effect], [{ editing: true, query: "de" }, false, null], k);
  }
  const pasted = reduce(leader(typing).state, { paste: "v-a", read: ++reads, ...AT });
  assert.deepEqual([pasted.state.filter, pasted.state.leader.waiting, pasted.effect], [{ editing: true, query: "de" }, false, null], "a paste after the leader is dropped");
  // The leader spent, the field takes text again.
  assert.deepEqual(key(leaderThen(typing, "x", AT).state, "v").state.filter, { editing: true, query: "dev" });
});

// ── The leader from a terminal ───────────────────────────────────────────────────────────────────

test("from the terminal's focus the leader waits and the terminal keeps the focus; then k or Space in a later read opens the palette from the terminal, with the list's focus, and Esc gives the focus back to the terminal", () => {
  const state = opened(THREE(), "dev-a"), a = idOf(state, "dev-a");
  assert.deepEqual([state.terminal.id, state.terminal.focus, state.terminal.status], [a, "terminal", "open"]);
  const read = ++reads, waiting = leader(state, read);
  assert.deepEqual([waiting.state.leader, waiting.state.terminal, waiting.effect], [{ read, waiting: true }, state.terminal, null]);
  for (const k of ["k", "space"]) {
    const later = ++reads, open = key(waiting.state, k, later);
    assert.deepEqual([open.state.palette, open.effect], [{ query: "", selected: null, top: 0, read: later, from: "terminal" }, null], k);
    assert.deepEqual([open.state.terminal.focus, open.state.terminal.zoom, open.state.leader], ["list", false, { read: later, waiting: false }], k);
    for (const close of ["escape", "ctrl+k"]) {
      const shut = key(open.state, close);
      assert.deepEqual([shut.state.palette, shut.state.terminal.focus, shut.state.view, shut.effect], [null, "terminal", "instances", null], `${k}, then ${close}`);
    }
  }
});

test("the leader typed in the terminal with more bytes after it in the same read does not wait: what followed it cancelled it", () => {
  const state = opened(THREE(), "dev-a");
  const read = ++reads, step = leader(state, read, true);
  assert.deepEqual([step.state.leader, step.state.terminal, step.state.outcome, step.effect], [{ read, waiting: false }, state.terminal, MERGED, null]);
  // What the person types on goes to the agent (the loop's `passed`), and the line goes with it.
  assert.equal(reduce(step.state, { passed: true }).state.outcome, null, "typing on in the terminal clears the line");
  // The next leader, alone in its read, waits again.
  assert.deepEqual(leader(step.state).state.leader.waiting, true);
});

test("the add of the deployment the run started in, refused while a terminal has the focus, zoomed or not, is held, and said once the list has the focus again", () => {
  // Under 80 columns a terminal with the focus has the whole screen, and zoomed it has it at any
  // width: the sidebar, and its line under the title, are not drawn (awebai/oats#1390).
  const reason = { code: "E_DEPLOYMENTS_BUSY", message: "the list is locked" }, said = { said: LIST_WORDS.notAdded(reason.message), under: [] };
  const state = opened(THREE(), "dev-a");
  const zoomed = key(leaderEscape(state).state, "z").state;
  for (const from of [state, zoomed]) {
    const held = reduce(from, { notListed: reason }).state;
    assert.deepEqual([held.outcome, held.notice], [null, said], `zoom ${from.terminal.zoom}`);
    const back = leaderEscape(held).state;
    assert.deepEqual([back.terminal.focus, back.outcome, back.notice], ["list", said, null], `zoom ${from.terminal.zoom}: said once the list has the focus`);
  }
});

test("the leader then Esc from the terminal gives the list the focus, unzoomed, and the terminal stays open", () => {
  const state = opened(THREE(), "dev-a");
  const zoomed = key(leaderEscape(state).state, "z").state;
  assert.deepEqual([zoomed.terminal.focus, zoomed.terminal.zoom], ["terminal", true]);
  for (const from of [state, zoomed]) {
    for (const step of [leaderEscape(from), leaderThen(from, "escape", AT)]) {
      assert.deepEqual([step.state.terminal, step.state.focus, step.state.view, step.state.leader.waiting, step.effect],
        [{ ...state.terminal, focus: "list", zoom: false }, "list", "instances", false, null]);
    }
  }
});

test("the leader twice from the terminal types the leader's own bytes into the agent, the terminal keeping the focus and its zoom; the leader is spent: 0x18 for C-x (the default), ESC o for M-o, 0x1c for C-\\, a function key's first form", () => {
  const state = opened(THREE(), "dev-a");
  const zoomed = leaderThen(state, "z", AT).state;
  assert.deepEqual([zoomed.terminal.focus, zoomed.terminal.zoom], ["terminal", true]);
  for (const from of [state, zoomed]) {
    const step = leaderTwice(from);
    assert.deepEqual([step.state.terminal, step.state.focus, step.state.view, step.state.leader.waiting, step.state.palette], [from.terminal, from.focus, "instances", false, null]);
    assert.deepEqual(Object.keys(step.effect), ["input"]);
    assert.deepEqual([...step.effect.input], [0x1c], "C-\\, the tests' leader");
    assert.deepEqual(butLeader(step.state), butLeader(from), "nothing else changes");
  }
  for (const [detachKey, leaderKey, bytes] of [["C-x", "ctrl+x", [0x18]], ["M-o", "alt+o", [0x1b, 0x6f]], ["C-]", "ctrl+]", [0x1d]], ["F12", "f12", [0x1b, 0x5b, 0x32, 0x34, 0x7e]], ["S-F1", "shift+f1", [0x1b, 0x5b, 0x31, 0x3b, 0x32, 0x50]]]) {
    const keyed = opened(stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-b", STOPPED), instanceRow("dev", "dev-c")], { cli: ACTS_CLI }), { cli: ACTS_CLI, detachKey }), "dev-a");
    assert.equal(keyed.leaderKey, leaderKey, detachKey);
    const step = leaderTwice(keyed);
    assert.deepEqual([step.state.terminal.focus, step.state.leader.waiting, [...step.effect.input]], ["terminal", false, bytes], detachKey);
  }
  // The second leader in the leader's own read is a paste's: it cancels the leader, and types nothing.
  const read = ++reads, first = leader(state, read);
  const same = reduce(first.state, { key: state.leaderKey, read, ...AT });
  assert.deepEqual([same.state.leader.waiting, same.state.terminal.focus, same.effect], [false, "terminal", null]);
  // A second { back } while the leader waits from an earlier read is the leader twice too.
  const again = reduce(first.state, { back: true, read: ++reads, rest: false, ...AT });
  assert.deepEqual([again.state.leader.waiting, again.state.terminal.focus, [...again.effect.input]], [false, "terminal", [0x1c]]);
});

test("the leader twice from the list's focus, or the leader then Esc, only cancels the leader: nothing else changes, also with a terminal open (Settled 5)", () => {
  const plain = THREE(), withTerminal = leaderEscape(opened(THREE(), "dev-a")).state;
  for (const state of [plain, withTerminal]) {
    for (const step of [twice(state), leaderThen(state, "escape", AT)]) {
      assert.deepEqual([step.state.leader.waiting, step.effect], [false, null]);
      assert.deepEqual(butLeader(step.state), butLeader(state));
    }
  }
  // From the detail, the help and an open filter field, the leader then Esc gives the list its
  // focus; the leader twice only cancels the leader there too.
  const detail = key(plain, "tab").state;
  assert.equal(detail.focus, "detail");
  assert.deepEqual(butLeader(leaderThen(detail, "escape", AT).state), butLeader(plain));
  const helped = key(plain, "?").state;
  assert.deepEqual(butLeader(leaderThen(helped, "escape", AT).state), butLeader(plain));
  for (const from of [detail, helped]) {
    const step = twice(from);
    assert.deepEqual([butLeader(step.state), step.effect], [butLeader(from), null], from.view);
  }
  const field = leaderThen(keys(plain, "/", "d").state, "escape", AT).state;
  assert.deepEqual([field.filter, field.view], [{ editing: false, query: "d" }, "instances"]);
  // Under the palette opened from the terminal the terminal has not the focus: twice types nothing.
  const palette = leaderThen(opened(THREE(), "dev-a"), "k", AT).state;
  assert.deepEqual(twice(palette).effect, null);
});

test("the leader is the default without a tui.json: C-x (read as ctrl+x) on Linux, Windows and macOS alike", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const state = initialState({ deployment: null, cli: CLI, home: "/home/u", platform });
    assert.deepEqual([state.detachKey, state.leaderKey], ["C-x", "ctrl+x"], platform);
  }
  assert.equal(initialState({ deployment: null, cli: CLI, home: "/home/u", platform: "linux", detachKey: "F12" }).leaderKey, "f12", "tui.json's key wins");
  assert.equal(initialState({ deployment: null, cli: CLI, home: "/home/u", platform: "linux", detachKey: "M-o" }).leaderKey, "alt+o", "M-o, the default before, as tui.json names it");
});

test("the default leader twice from the terminal types 0x18 once into the agent, on every platform; Alt+O there is no leader: from the list it is a key of its own (#1433)", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const base = stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-b", STOPPED), instanceRow("dev", "dev-c")], { cli: ACTS_CLI }), { cli: ACTS_CLI, platform, detachKey: undefined });
    assert.equal(base.leaderKey, "ctrl+x", platform);
    const state = opened(base, "dev-a");
    const step = leaderTwice(state);
    assert.deepEqual([step.state.terminal.focus, step.state.leader.waiting, Object.keys(step.effect), [...step.effect.input]], ["terminal", false, ["input"], [0x18]], platform);
    // From the list's focus, alt+o neither arms the leader nor cancels it.
    const list = key(base, "alt+o");
    assert.equal(list.state.leader?.waiting ?? false, false, `${platform}: alt+o is not the leader`);
    const open = leader(base);
    assert.equal(open.state.leader.waiting, true, `${platform}: ctrl+x is`);
  }
});

test("the leader then z zooms the terminal that has the focus, in and out; then w closes it, the agent left running; with no terminal open w and z do nothing", () => {
  const state = opened(THREE(), "dev-a"), a = idOf(state, "dev-a");
  const zoomed = leaderThen(state, "z", AT);
  assert.deepEqual([zoomed.state.terminal, zoomed.effect], [{ ...state.terminal, zoom: true }, null]);
  const unzoomed = leaderThen(zoomed.state, "z", AT);
  assert.deepEqual([unzoomed.state.terminal, unzoomed.effect], [state.terminal, null]);
  // From the list's focus, z goes to the terminal zoomed, as the list's z does.
  const fromList = leaderThen(leaderEscape(state).state, "z", AT);
  assert.deepEqual([fromList.state.terminal.focus, fromList.state.terminal.zoom, fromList.effect], ["terminal", true, null]);
  for (const from of [state, zoomed.state, leaderEscape(state).state]) {
    const closed = leaderThen(from, "w", AT);
    assert.deepEqual([closed.state.terminal, closed.state.view, closed.effect], [null, "instances", { close: [a] }]);
  }
  const none = THREE();
  for (const k of ["w", "z"]) {
    const step = leaderThen(none, k, AT);
    assert.deepEqual([butLeader(step.state), step.effect], [butLeader(none), null], k);
  }
});

test("the leader then X, D or R from the terminal acts on the terminal's instance, not the selection: its confirmation opens, and closing it gives the focus back to the terminal", () => {
  const base = opened(THREE(), "dev-a"), a = idOf(base, "dev-a");
  // The selection moved to dev-c, then z went back to the terminal, zoomed.
  const state = key(on(leaderEscape(base).state, "dev-c"), "z").state;
  assert.deepEqual([state.selected, state.terminal.id, state.terminal.focus], [idOf(base, "dev-c"), a, "terminal"]);
  for (const [k, verb, kind] of [["X", "stop", "lifecycle"], ["D", "retire", "lifecycle"], ["R", "restart", "start"]]) {
    const step = leaderThen(state, k, AT);
    assert.deepEqual([step.state.view, step.state.back, step.state.act.verb, step.state.act.kind, step.state.act.id, step.state.act.after], ["act", "instances", verb, kind, a, "terminal"], k);
    assert.deepEqual(step.effect, kind === "start" ? null : { act: { n: 1, verb, id: a, row: rowOf(state, "dev-a"), label: null } }, k);
    assert.deepEqual([step.state.terminal.id, step.state.terminal.focus, step.state.terminal.zoom], [a, "list", false], `${k}: the confirmation has the keys`);
    const shut = key(step.state, "escape");
    assert.deepEqual([shut.state.view, shut.state.act, shut.state.terminal.focus, shut.state.terminal.zoom, shut.effect], ["instances", null, "terminal", false, { dismiss: 1 }], `${k}, then Esc`);
  }
  // From the list's focus they act on the selection, and closing leaves the focus in the list.
  const listed = leaderThen(on(leaderEscape(base).state, "dev-c"), "X", AT);
  assert.deepEqual([listed.state.act.id, listed.state.act.after], [idOf(base, "dev-c"), null]);
  assert.equal(key(listed.state, "escape").state.terminal.focus, "list");
});

test("the leader then S on the terminal's running instance opens nothing: the line says it can't be started, and the focus is the list's", () => {
  const state = opened(THREE(), "dev-a");
  const step = leaderThen(state, "S", AT);
  assert.deepEqual([step.state.view, step.state.act, step.effect], ["instances", null, null]);
  assert.deepEqual(step.state.outcome, { said: [{ shown: "dev-a" }, { own: " can't be started here." }], under: [] });
  assert.deepEqual([step.state.terminal.focus, step.state.terminal.zoom], ["list", false]);
});

/** The previous or the next instance (`up`, `down`): the chords' alone, Alt+Shift+Up and Down (the
 *  leader's Up and Down move between workspaces): from a terminal's focus as its scanner hands
 *  them on (`{ chord }`), else as keys. */
function stepTo(state, dir, at = AT) {
  const does = dir === "down" ? "next" : "previous";
  return state.terminal?.focus === "terminal" && state.view === "instances" ? reduce(state, { chord: does, read: ++reads, ...at }) : reduce(state, { key: `alt+shift+${dir}`, read: ++reads, ...at });
}

test("Alt+Shift+Down or Up opens the next or previous instance that can be opened, selected and with the focus, passing over the stopped rows and the empty row, and stops at both ends without wrapping", () => {
  const state = TREE();
  assert.equal(state.selected, idOf(state, "alpha"));
  // From the selection, no terminal open: alpha (stopped) to alpha-kid.
  const first = stepTo(state, "down");
  assert.deepEqual(first.effect, { open: decision(state, "alpha-kid") });
  assert.deepEqual([first.state.selected, first.state.terminal.id, first.state.terminal.focus, recentOf(first.state)], [idOf(state, "alpha-kid"), idOf(state, "alpha-kid"), "terminal", [idOf(state, "alpha-kid")]]);
  // From the open terminal: each next instance opens as a tab of its own after the shown one, and
  // nothing is closed (T2, Done 3), up to the cap.
  let at = reduce(first.state, { shown: { id: idOf(state, "alpha-kid") }, ...AT }).state;
  for (const [from, to] of [["alpha-kid", "lead"], ["lead", "child-a"], ["child-a", "grandchild"]]) {
    const step = stepTo(at, "down");
    assert.deepEqual(step.effect, { open: decision(state, to) }, `${from} down`);
    assert.deepEqual([step.state.selected, step.state.terminal.id, step.state.terminal.focus], [idOf(state, to), idOf(state, to), "terminal"], `${from} down`);
    at = reduce(step.state, { shown: { id: idOf(state, to) }, ...AT }).state;
  }
  assert.deepEqual(at.tabs.map((tab) => tab.id), ["alpha-kid", "lead", "child-a", "grandchild"].map((name) => idOf(state, name)));
  // The fifth: every tab is taken, nothing opens and nothing closes, and the line says so.
  const full = stepTo(at, "down");
  assert.deepEqual([full.effect, full.state.tabs.length, full.state.terminal.id], [null, 4, idOf(state, "grandchild")]);
  assert.equal(full.state.outcome.said.map((part) => part.own ?? part.shown).join(""), "4 terminals are open; close one with Ctrl+\\ w.");
  // Up from the shown tab: the instance above is a tab, and is shown.
  const shownUp = stepTo(at, "up");
  assert.deepEqual([shownUp.effect, shownUp.state.terminal.id, shownUp.state.terminal.focus], [{ show: idOf(state, "child-a") }, idOf(state, "child-a"), "terminal"]);
  // solo-y under solo-x is stopped: the end. alpha above alpha-kid is stopped: the end.
  const bottom = reduce(opened(TREE(), "solo-x"), { shown: { id: idOf(state, "solo-x") }, ...AT }).state;
  const last = stepTo(bottom, "down");
  assert.deepEqual([butLeader(last.state), last.effect], [butLeader(bottom), null], "no wrap at the bottom");
  const top = opened(TREE(), "alpha-kid"), firstUp = stepTo(top, "up");
  assert.deepEqual([butLeader(firstUp.state), firstUp.effect], [butLeader(top), null], "no wrap at the top");
  const back = stepTo(bottom, "up");
  assert.deepEqual(back.effect, { open: decision(state, "grandchild") }, "solo-x up passes over the empty row and child-b");
  // From the selection when none is open: child-b (stopped) up to grandchild.
  const fromStopped = stepTo(on(state, "child-b"), "up");
  assert.deepEqual(fromStopped.effect, { open: decision(state, "grandchild") });
});

test("Alt+Shift+Up or Down moves from the open terminal's instance, not from the selection, also from the list's focus", () => {
  const state = leaderEscape(opened(TREE(), "child-a")).state, child = idOf(state, "child-a");
  const moved = on(state, "solo-x");
  for (const [k, to] of [["down", "grandchild"], ["up", "lead"]]) {
    const step = stepTo(moved, k);
    assert.deepEqual(step.effect, { open: decision(state, to) }, k);
    assert.deepEqual(step.state.tabs.map((tab) => tab.id), [child, idOf(state, to)], `${k}: a tab of its own beside child-a's`);
    assert.deepEqual([step.state.selected, step.state.terminal.id, step.state.terminal.focus], [idOf(state, to), idOf(state, to), "terminal"], k);
  }
});

// ── The palette ──────────────────────────────────────────────────────────────────────────────────

test("the palette lists the instances that can be opened under their group's label row, the views, the acts the selected instance offers, then Spawn an agent, Workspaces, Refresh and Help; an instance's row carries its mark, name, machine and siblings", () => {
  const state = key(THREE(), "ctrl+k").state;
  assert.deepEqual(rows(state), [
    "group independent", "instance dev-a", "instance dev-c",
    "view Instances", "view Souls", "view Capabilities",
    "act Stop", "act Retire", "act Restart",
    "command Spawn an agent", "command Workspaces", "command Refresh", "command Help",
  ]);
  const a = idOf(state, "dev-a");
  // The label row is the shared group's: its key, and its label, three single instances' `independent`.
  assert.deepEqual(paletteItems(state).items[0], { key: `group\u0000independent:${a}`, kind: "group", label: "independent" });
  assert.deepEqual(paletteItems(state).items[1], { key: `instance\u0000${a}`, kind: "instance", label: "dev-a", id: a, name: "dev-a", machine: null, mark: "running", sibling: null, text: "dev-a " });
  assert.deepEqual(paletteItems(state).items[6], { key: "act\u0000stop", kind: "act", label: "Stop", does: "stop", id: a, name: "dev-a", text: "Stop dev-a" });
  assert.equal(paletteItems(state).selected, `instance\u0000${a}`, "the first row that can be selected is: the instance under the label row");
  // The acts are the selected instance's: dev-b is stopped, so it is started, not restarted.
  assert.deepEqual(rows(key(on(THREE(), "dev-b"), "ctrl+k").state).filter((row) => row.startsWith("act ")), ["act Stop", "act Retire", "act Start"]);
});

test("the palette lists the instances most recently opened in this run first, then in the list's order", () => {
  const state = THREE(), a = idOf(state, "dev-a"), c = idOf(state, "dev-c");
  const openedC = opened(state, "dev-c");
  assert.deepEqual(recentOf(openedC), [c]);
  assert.deepEqual(rows(key(leaderEscape(openedC).state, "ctrl+k").state).slice(0, 3), ["group independent", "instance dev-c", "instance dev-a"]);
  const thenA = key(on(leaderEscape(openedC).state, "dev-a"), "enter").state;
  assert.deepEqual(recentOf(thenA), [a, c]);
  assert.deepEqual(rows(key(leaderEscape(thenA).state, "ctrl+k").state).slice(0, 3), ["group independent", "instance dev-a", "instance dev-c"]);
});

test("typing filters each group by the subsequence score, a prefix first and a tie in the group's order; a query that matches nothing leaves no row; Backspace takes a character off", () => {
  const open = key(THREE(), "ctrl+k").state;
  const c = key(open, "c").state;
  assert.deepEqual([c.palette.query, rows(c)], ["c", ["group independent", "instance dev-c", "view Capabilities", "view Instances", "command Workspaces"]]);
  const re = keys(open, "r", "e").state;
  assert.deepEqual([re.palette.query, rows(re)], ["re", ["act Retire", "act Restart", "command Refresh", "command Workspaces"]]);
  const none = keys(open, "z", "z", "z").state;
  assert.deepEqual([rows(none), paletteItems(none).selected], [[], null]);
  // Enter with no row runs nothing.
  assert.deepEqual([key(none, "enter").state, key(none, "enter").effect], [none, null]);
  const back = key(re, "backspace").state;
  assert.deepEqual([back.palette.query, back.palette.selected], ["r", null]);
  assert.deepEqual(key(open, "backspace").state.palette, open.palette, "Backspace on an empty query");
});

test("Up and Down move the palette's selection among its rows and stop at both ends", () => {
  // The rows that can be selected: a group's label row is never one (see the groups' tests below).
  const open = key(THREE(), "ctrl+k").state, all = paletteItems(open).items.filter((item) => item.kind !== "group").map((item) => item.key);
  assert.equal(key(open, "up").state.palette.selected, all[0]);
  assert.equal(key(open, "down").state.palette.selected, all[1]);
  assert.equal(keys(open, "down", "down", "up").state.palette.selected, all[1]);
  assert.equal(keys(open, ...all.map(() => "down"), "down").state.palette.selected, all.at(-1));
  // j and k are the query's.
  assert.deepEqual([key(open, "j").state.palette.query, key(open, "k").state.palette.query], ["j", "k"]);
});

test("Enter in the read that opened the palette runs nothing, and in a later read runs the selected row: an instance opens its terminal, with the focus", () => {
  const state = THREE(), read = ++reads, open = key(state, "ctrl+k", read).state;
  assert.equal(open.palette.read, read);
  const same = key(open, "enter", read);
  assert.deepEqual([same.state, same.effect], [open, null]);
  // From the leader, the read is the k's.
  const led = leaderThen(state, "k", AT).state;
  assert.deepEqual([key(led, "enter", led.palette.read).state, key(led, "enter", led.palette.read).effect], [led, null]);
  const ran = key(key(open, "down").state, "enter");
  assert.deepEqual(ran.effect, { open: decision(state, "dev-c") });
  assert.deepEqual([ran.state.palette, ran.state.selected, ran.state.terminal.id, ran.state.terminal.focus], [null, idOf(state, "dev-c"), idOf(state, "dev-c"), "terminal"]);
});

test("an instance run from the palette opened from a terminal opens it as a tab of its own beside the open one (T2: nothing is closed)", () => {
  const state = opened(THREE(), "dev-a"), a = idOf(state, "dev-a"), c = idOf(state, "dev-c");
  const open = leaderThen(state, "k", AT).state;
  assert.deepEqual(rows(open).slice(0, 3), ["group independent", "instance dev-a", "instance dev-c"]);
  const ran = keys(open, "d", "e", "v", "-", "c", "enter");
  assert.deepEqual(ran.effect, { open: decision(state, "dev-c") });
  assert.deepEqual(ran.state.tabs.map((tab) => tab.id), [a, c]);
  assert.deepEqual([ran.state.palette, ran.state.selected, ran.state.terminal.id, ran.state.terminal.focus, recentOf(ran.state)], [null, c, c, "terminal", [c, a]]);
  // The first row is the shown tab's instance (the most recent): the second is selected (T2, Done
  // 4), so Enter goes to the terminal before it.
  assert.equal(paletteItems(open).selected, `instance\u0000${c}`);
  // The open terminal's own row, chosen, gives it the focus back, and opens nothing.
  const own = keys(leaderThen(state, "k", AT).state, "d", "e", "v", "-", "a", "enter");
  assert.deepEqual([own.state.palette, own.state.terminal, own.effect], [null, state.terminal, null]);
});

test("a view run from the palette switches to it, and from a terminal gives the list the focus; Souls asks the loop to settle its catalog, and Capabilities its table and the souls catalog its Used by reads", () => {
  const ran = keys(key(THREE(), "ctrl+k").state, "s", "o", "u", "l", "s", "enter");
  assert.deepEqual([ran.state.palette, ran.state.view, ran.state.back, ran.effect], [null, "souls", "souls", { souls: "settle" }]);
  const fromTerminal = keys(leaderThen(opened(THREE(), "dev-a"), "k", AT).state, "c", "a", "p", "enter");
  assert.deepEqual([fromTerminal.state.palette, fromTerminal.state.view, fromTerminal.state.terminal.focus, fromTerminal.effect], [null, "capabilities", "list", { souls: "settle", capabilities: "settle" }]);
  const instances = keys(key(key(THREE(), "2").state, "ctrl+k").state, "i", "n", "s", "enter");
  assert.deepEqual([instances.state.view, instances.state.palette], ["instances", null]);
});

test("an act run from the palette opens its confirmation on the palette's instance: the terminal's when opened from it, whose focus closing it gives back", () => {
  const state = THREE(), a = idOf(state, "dev-a");
  const ran = keys(key(state, "ctrl+k").state, "s", "t", "o", "p", "enter");
  assert.deepEqual([ran.state.palette, ran.state.view, ran.state.act.verb, ran.state.act.id, ran.state.act.after], [null, "act", "stop", a, null]);
  assert.deepEqual(ran.effect, { act: { n: 1, verb: "stop", id: a, row: rowOf(state, "dev-a"), label: null } });
  // From the terminal on dev-a, with dev-c selected.
  const base = opened(state, "dev-a"), moved = key(on(leaderEscape(base).state, "dev-c"), "z").state;
  const open = leaderThen(moved, "k", AT).state;
  assert.deepEqual(paletteItems(open).items.filter((item) => item.kind === "act").map((item) => [item.does, item.id]), [["stop", a], ["retire", a], ["restart", a]]);
  const restart = keys(open, "r", "e", "s", "t", "enter");
  assert.deepEqual([restart.state.view, restart.state.act.verb, restart.state.act.kind, restart.state.act.id, restart.state.act.after, restart.effect], ["act", "restart", "start", a, "terminal", null]);
  const shut = key(restart.state, "escape");
  assert.deepEqual([shut.state.view, shut.state.terminal.focus, shut.effect], ["instances", "terminal", { dismiss: restart.state.act.n }]);
});

test("Workspaces, Refresh and Help run from the palette do what their actions do", () => {
  const state = THREE(), open = key(state, "ctrl+k").state;
  const run = (query) => keys(open, ...query, "enter");
  for (const [query, plain] of [["works", "w"], ["refr", "r"], ["help", "?"]]) {
    const ran = run([...query]), pressed = key(state, plain);
    assert.deepEqual([butLeader(ran.state), ran.effect], [butLeader(pressed.state), pressed.effect], query);
  }
  assert.deepEqual([run([..."works"]).state.view, run([..."works"]).state.focus, run([..."works"]).effect], ["instances", "workspaces", null], "Workspaces: the list of workspaces' focus");
  assert.deepEqual([run([..."refr"]).state.palette, run([..."refr"]).effect], [null, { refresh: { live: true } }]);
  assert.deepEqual([run([..."help"]).state.view, run([..."help"]).state.back], ["help", "instances"]);
});

test("a paste into the palette is its query's, its first line only, and runs nothing", () => {
  const open = key(THREE(), "ctrl+k").state;
  const pasted = reduce(open, { paste: "dev-c\nenter", read: ++reads, ...AT });
  assert.deepEqual([pasted.state.palette.query, pasted.effect, rows(pasted.state)], ["dev-c", null, ["group independent", "instance dev-c"]]);
  // A paste in the read that opened it is the query's too, and an Enter with it runs nothing.
  const read = ++reads, same = reduce(key(THREE(), "ctrl+k", read).state, { paste: "dev", read, ...AT }).state;
  assert.equal(same.palette.query, "dev");
  assert.deepEqual([key(same, "enter", read).state, key(same, "enter", read).effect], [same, null]);
});

test("Ctrl+K opens the palette from the list and Ctrl+K again closes it; Esc closes it; Ctrl+C still quits while it is open, and q is the query's", () => {
  const state = THREE(), read = ++reads;
  const open = key(state, "ctrl+k", read);
  assert.deepEqual([open.state.palette, open.effect], [{ query: "", selected: null, top: 0, read, from: "list" }, null]);
  for (const close of ["ctrl+k", "escape"]) assert.deepEqual([butLeader(key(open.state, close).state), key(open.state, close).effect], [butLeader(state), null], close);
  assert.deepEqual([key(open.state, "ctrl+c").state, key(open.state, "ctrl+c").effect], [open.state, "quit"]);
  assert.deepEqual([key(open.state, "q").state.palette.query, key(open.state, "q").effect], ["q", null]);
});

// ── The palette's groups (docs/tui.md, "The palette") ─────────────────────────────────────────────

/** TREE on Linux, where the palette has its own keys, with `names` opened in this run, the latest
 *  first (the store's `recent`, the open workspace's). */
const RECENT = (names, platform = "linux") => {
  const state = TREE({ platform });
  return Object.freeze({ ...state, recent: new Map([[memoryKey(state, state.open), Object.freeze(names.map((name) => idOf(state, name)))]]) });
};
/** The palette's rows as `kind label`, a group's label row with its key. */
const grouped = (state) => paletteItems(state).items.map((item) => (item.kind === "group" ? `group ${item.label} ${item.key.split("\u0000")[1]}` : `${item.kind} ${item.label}`));
/** The key of the palette's row of the instance `name`, or of the row of `kind` labelled `label`. */
const rowKey = (state, name) => `instance\u0000${idOf(state, name)}`;
const kindKey = (state, kind, label) => paletteItems(state).items.find((item) => item.kind === kind && item.label === label).key;
/** A key with the page the store reads for PageUp and PageDown (`page` rows of the body). */
const paged = (state, id, page) => reduce(state, { key: id, read: ++reads, ...AT, page });
/** The views, the acts and the commands TREE's palette lists after its instances, alpha selected. */
const TREE_KINDS = Object.freeze(["view Instances", "view Souls", "view Capabilities", "act Stop", "act Retire", "command Spawn an agent", "command Workspaces", "command Refresh", "command Help"]);

test("the palette groups the instances that can be opened as the sidebar does, each group under its label row (a cluster's name, or independent), and orders them by recency as the Desktop's palette does (#1383): the group, the cluster, the root and the child opened most recently first; a group with no row that can be opened has none", () => {
  const solo = (state, name) => `independent:${idOf(state, name)}`;
  // Nothing opened yet: the sidebar's order. alpha is stopped, so its group lists alpha-kid alone;
  // solo-y is stopped, and child-b, so neither is listed.
  const fresh = key(TREE({ platform: "linux" }), "ctrl+k").state;
  assert.deepEqual(grouped(fresh), [
    "group alpha cluster:0:alpha", "instance alpha-kid",
    "group lead cluster:1:lead", "instance lead", "instance child-a", "instance grandchild",
    `group independent ${solo(fresh, "solo-x")}`, "instance solo-x",
    ...TREE_KINDS,
  ]);
  // solo-x opened last, grandchild before it: solo-x's run first, then lead's cluster (its
  // grandchild was opened), then alpha's, never opened; under lead the child on grandchild's path
  // first. The shared grouping keys a group by the order it is made in.
  const recent = key(RECENT(["solo-x", "grandchild"]), "ctrl+k").state;
  assert.deepEqual(grouped(recent), [
    `group independent ${solo(recent, "solo-x")}`, "instance solo-x",
    "group lead cluster:0:lead", "instance lead", "instance child-a", "instance grandchild",
    "group alpha cluster:1:alpha", "instance alpha-kid",
    ...TREE_KINDS,
  ]);
  // alpha-kid opened last: its cluster first, the rest as they were.
  assert.deepEqual(grouped(key(RECENT(["alpha-kid", "solo-x", "grandchild"]), "ctrl+k").state).slice(0, 8), [
    "group alpha cluster:0:alpha", "instance alpha-kid",
    `group independent ${solo(recent, "solo-x")}`, "instance solo-x",
    "group lead cluster:1:lead", "instance lead", "instance child-a", "instance grandchild",
  ]);
  // The runs the palette's own keys move between: each instance group's rows, then each kind's.
  assert.deepEqual(paletteItems(recent).runs.map((run) => run.length), [1, 3, 1, 3, 2, 4]);
  assert.equal(paletteItems(recent).runs.flat().some((each) => each.startsWith("group\u0000")), false, "no label row is in a run");
});

test("a group's label row is never selected: the palette opens on its first row that can be selected, and Up, Down, PageUp and PageDown pass over every label row; as it opens on the shown terminal's instance, the instance shown before it is selected, wherever its group puts it", () => {
  const open = key(RECENT(["solo-x", "grandchild"]), "ctrl+k").state, items = paletteItems(open).items;
  assert.equal(items[0].kind, "group");
  assert.equal(paletteItems(open).selected, rowKey(open, "solo-x"), "the first row that can be selected");
  // Down from a group's last row is the next group's first; Up from it, the group before's last.
  assert.equal(key(open, "down").state.palette.selected, rowKey(open, "lead"));
  assert.equal(key(key(open, "down").state, "up").state.palette.selected, rowKey(open, "solo-x"));
  assert.equal(key(open, "up").state.palette.selected, rowKey(open, "solo-x"), "Up from the first row stays: the label row above it is no row to stand on");
  assert.equal(keys(open, "down", "down", "down", "down").state.palette.selected, rowKey(open, "alpha-kid"));
  // From every row, every move lands on a row that can be selected, at every page.
  const selectable = paletteItems(open).runs.flat();
  for (const from of selectable) for (const move of ["up", "down", "pageup", "pagedown"]) for (const page of [3, 4, 19]) {
    const at = Object.freeze({ ...open, palette: Object.freeze({ ...open.palette, selected: from }) });
    assert.equal(selectable.includes(paged(at, move, page).state.palette.selected), true, `${move} at a page of ${page} from ${from}`);
  }
  // A page of 4 rows moves two rows that can be selected: from solo-x past lead's label to child-a, and back.
  assert.equal(paged(open, "pagedown", 4).state.palette.selected, rowKey(open, "child-a"));
  assert.equal(paged(paged(open, "pagedown", 4).state, "pageup", 4).state.palette.selected, rowKey(open, "solo-x"));
  assert.equal(paged(open, "pageup", 4).state.palette.selected, rowKey(open, "solo-x"), "PageUp at the top stays on the first row that can be selected");
  // The shown terminal is solo-x's, the most recent: the palette opens on the instance shown before
  // it, grandchild, deep in lead's group: not lead, the second instance in the list.
  const shown = reduce(key(on(RECENT(["grandchild"]), "solo-x"), "enter").state, { shown: { id: idOf(open, "solo-x") }, ...AT }).state;
  assert.deepEqual(recentOf(shown), [idOf(open, "solo-x"), idOf(open, "grandchild")]);
  const fromTerminal = leaderThen(shown, "k", AT).state;
  assert.deepEqual(grouped(fromTerminal).slice(0, 3), [`group independent independent:${idOf(open, "solo-x")}`, "instance solo-x", "group lead cluster:0:lead"]);
  assert.equal(paletteItems(fromTerminal).selected, rowKey(open, "grandchild"));
  assert.equal(key(fromTerminal, "enter").effect?.open?.id, idOf(open, "grandchild"), "Enter goes back to it (it has no tab here: it opens)");
  // Typed, the first row that can be selected is.
  assert.equal(paletteItems(key(fromTerminal, "s").state).selected, rowKey(open, "solo-x"));
});

test("under a query an instance group keeps its rows that match in its own order, and a group with none loses its label row; the kinds after the groups keep their matches the best first", () => {
  const open = key(RECENT(["solo-x", "grandchild"]), "ctrl+k").state;
  // `a` matches lead (and child-a, grandchild) and alpha-kid, never solo-x: its group is gone. alpha-kid,
  // a prefix, does not go before lead's group, as the views' Capabilities goes before Instances.
  assert.deepEqual(grouped(key(open, "a").state), [
    "group lead cluster:0:lead", "instance lead", "instance child-a", "instance grandchild",
    "group alpha cluster:1:alpha", "instance alpha-kid",
    "view Capabilities", "view Instances", "act Stop", "act Retire", "command Spawn an agent", "command Workspaces",
  ]);
  assert.equal(paletteItems(key(open, "a").state).selected, rowKey(open, "lead"));
  // `ch`: lead's group keeps child-a and grandchild, in its order (child-a scores no better).
  assert.deepEqual(grouped(keys(open, "c", "h").state), ["group lead cluster:0:lead", "instance child-a", "instance grandchild"]);
  // A query that matches no instance leaves no label row.
  assert.deepEqual(grouped(keys(open, "h", "e", "l", "p").state), ["command Help"]);
});

test("Alt+Shift+Down and Alt+Shift+Up move the palette's selection to the first row of the next group and of the one before, across the instance groups and the kinds, and wrap past either end; with one group, its first row; under a query, among the groups that are left", () => {
  const open = key(RECENT(["solo-x", "grandchild"]), "ctrl+k").state;
  const firsts = [rowKey(open, "solo-x"), rowKey(open, "lead"), rowKey(open, "alpha-kid"), kindKey(open, "view", "Instances"), kindKey(open, "act", "Stop"), kindKey(open, "command", "Spawn an agent")];
  assert.deepEqual(paletteItems(open).runs.map((run) => run[0]), firsts);
  let s = open;
  for (const want of [...firsts.slice(1), firsts[0]]) { s = key(s, "alt+shift+down").state; assert.equal(s.palette.selected, want, "next"); }
  s = open;
  for (const want of [...firsts].reverse()) { s = key(s, "alt+shift+up").state; assert.equal(s.palette.selected, want, "previous"); }
  // From the middle of a group: next is the next group's first row, previous the group before's, not its own.
  const mid = keys(open, "down", "down").state;
  assert.equal(mid.palette.selected, rowKey(open, "child-a"));
  assert.equal(key(mid, "alt+shift+down").state.palette.selected, rowKey(open, "alpha-kid"));
  assert.equal(key(mid, "alt+shift+up").state.palette.selected, rowKey(open, "solo-x"));
  // The query is kept, and nothing else of the palette changes.
  const moved = key(open, "alt+shift+down").state;
  assert.deepEqual(moved.palette, { ...open.palette, selected: rowKey(open, "lead") });
  // One group: both keys go to its first row.
  const one = keys(open, "c", "h").state;
  assert.deepEqual([key(one, "alt+shift+down").state.palette.selected, key(key(one, "down").state, "alt+shift+up").state.palette.selected], [rowKey(open, "child-a"), rowKey(open, "child-a")]);
  // Under a query, among the groups it leaves: lead's, alpha's, the views', the acts', the commands'.
  const a = key(open, "a").state;
  assert.equal(key(a, "alt+shift+up").state.palette.selected, kindKey(a, "command", "Spawn an agent"), "wrapped back to the last group");
  // No row: nothing moves.
  const none = keys(open, "z", "z", "z").state;
  assert.deepEqual([key(none, "alt+shift+down").state, key(none, "alt+shift+down").effect], [none, null]);
});

test("while the palette is open Alt+Shift+Down and Up are its own, with and without the kitty keyboard protocol: they move the group, and open no agent nor close the palette; closed, they are the chords next and previous again; a chord from a terminal's scanner does nothing while it is open; on macOS the palette has no such key", () => {
  for (const kitty of [false, true]) {
    const base = RECENT(["solo-x", "grandchild"]), state = kitty ? reduce(base, { keyboard: 5 }).state : base, how = kitty ? "under the protocol" : "without it";
    assert.equal(state.keyboard !== null, kitty, how);
    const open = key(on(state, "lead"), "ctrl+k").state;
    for (const [id, want] of [["alt+shift+down", rowKey(open, "lead")], ["alt+shift+up", kindKey(open, "command", "Spawn an agent")]]) {
      const step = key(open, id);
      assert.deepEqual([step.effect, step.state.palette?.selected, step.state.terminal, step.state.tabs], [null, want, null, []], `${how}: ${id}`);
    }
    // Closed, the same key is the chord: the instance after the selection's opens.
    const shut = key(on(state, "lead"), "alt+shift+down");
    assert.equal(shut.effect?.open?.id, idOf(state, "child-a"), `${how}: the chord next with the palette closed`);
    // The palette opened from a terminal: the terminal has no focus while it is open, so no chord
    // comes from its scanner; one that came would open nothing, and the palette stays.
    const fromTerminal = leaderThen(opened(state, "lead"), "k", AT).state;
    assert.equal(fromTerminal.terminal.focus, "list", how);
    const chord = reduce(fromTerminal, { chord: "next", read: ++reads, ...AT });
    assert.deepEqual([chord.state, chord.effect], [fromTerminal, null], `${how}: a chord event`);
    // It opens on the instance shown before lead's (solo-x): the key goes to the group after solo-x's.
    const list = paletteItems(fromTerminal), at = list.runs.findIndex((run) => run.includes(list.selected));
    assert.equal(list.selected, rowKey(fromTerminal, "solo-x"), `${how}: the terminal shown before`);
    const moved = key(fromTerminal, "alt+shift+down");
    assert.deepEqual([moved.effect, moved.state.palette.selected, moved.state.terminal.id], [null, list.runs[(at + 1) % list.runs.length][0], idOf(state, "lead")], `${how}: from a terminal`);
    // The leader then Down is the leader's still, the palette open or not: the next workspace, of
    // which there is no other here; the palette closes and the line says so.
    const led = key(leader(open).state, "down");
    assert.deepEqual([led.effect, led.state.palette, led.state.outcome?.said], [null, null, WORKSPACE_WORDS.noOther()], `${how}: the leader then Down`);
  }
  // On macOS the TUI has no group key and no chord: the key does nothing in the palette.
  const mac = key(RECENT(["solo-x", "grandchild"], "darwin"), "ctrl+k").state;
  assert.deepEqual(mac.paletteKeys, new Map());
  for (const id of ["alt+shift+down", "alt+shift+up"]) assert.deepEqual([key(mac, id).state, key(mac, id).effect], [mac, null], `darwin: ${id}`);
});

// ── The views of this machine ────────────────────────────────────────────────────────────────────

/** What showing a view asks of the loop: Souls, that its catalog be settled (docs/tui.md, "The
 *  Souls view"); Capabilities, that its table be settled and the souls catalog its Used by reads
 *  (docs/tui.md, "The Capabilities view"). */
const SHOWN_ASKS = Object.freeze({ souls: { souls: "settle" }, capabilities: { souls: "settle", capabilities: "settle" } });

test("2 and 3, plain or after the leader, show Souls and Capabilities from the list; Esc, 1 and the leader then 1 go back to the instances, the selection as it was", () => {
  const state = on(THREE(), "dev-c");
  for (const [k, view] of [["2", "souls"], ["3", "capabilities"]]) {
    for (const shown of [key(state, k), leaderThen(state, k, AT)]) {
      assert.deepEqual([shown.state.view, shown.state.back, shown.effect], [view, view, SHOWN_ASKS[view]], k);
      for (const back of [key(shown.state, "escape"), key(shown.state, "1"), leaderThen(shown.state, "1", AT), leaderThen(shown.state, "escape", AT)]) {
        assert.deepEqual([back.state.view, back.state.back, back.state.selected, back.effect], ["instances", "instances", state.selected, null], `${k}, then back`);
      }
    }
  }
});

test("with no workspace open, 2 and 3, plain or after the leader, show Souls and Capabilities from the switcher; Esc, 1 and the leader then 1 go back to the switcher", () => {
  const none = initialState({ deployment: null, cli: CLI, home: "/home/u" });
  assert.equal(none.view, "switcher");
  for (const [k, view] of [["2", "souls"], ["3", "capabilities"]]) {
    for (const shown of [key(none, k), leaderThen(none, k, AT)]) {
      assert.deepEqual([shown.state.view, shown.effect], [view, SHOWN_ASKS[view]], k);
      for (const back of [key(shown.state, "escape"), key(shown.state, "1"), leaderThen(shown.state, "1", AT), leaderThen(shown.state, "escape", AT)]) {
        assert.deepEqual([back.state.view, back.state.back, back.state.open, back.effect], ["switcher", "switcher", null, null], `${k}, then back`);
      }
    }
  }
  // The leader then 2 and 3 are not typed into the switcher's filter field.
  const typing = keys(none, "/", "a").state;
  assert.deepEqual([leaderThen(typing, "2", AT).state.view, leaderThen(typing, "2", AT).state.switcher.query, leaderThen(typing, "2", AT).state.switcher.editing], ["souls", "a", false]);
});

// ── From every view: the terminal's commands go to the Instances view ─────────────────────────────

/** What can be shown under a command, each reached from the list of THREE with dev-a selected and
 *  no terminal open: the views of this machine, the help, the switcher, a confirmation, a filter
 *  field being typed in. */
const SHOWN = Object.freeze([
  ["Souls", (s) => key(s, "2").state],
  ["Capabilities", (s) => key(s, "3").state],
  ["the help", (s) => key(s, "?").state],
  ["the switcher", (s) => key(s, "w").state],
  ["a restart confirmation", (s) => key(s, "R").state],
  ["the filter field", (s) => keys(s, "/", "d").state],
]);
/** The palette opened by the leader, `query` typed, the row it selects checked to be `label`'s and
 *  to be its first row that can be selected (a group's label row may stand above it), then Enter
 *  in a later read. -> the step */
function runFromPalette(state, query, label) {
  let s = key(leader(state).state, "k").state;
  for (const ch of query) s = key(s, ch).state;
  const list = paletteItems(s), first = list.items.find((item) => item.kind !== "group");
  assert.equal(first?.key, list.selected, `${query}: the first row that can be selected is selected`);
  assert.equal(first?.label ?? first?.name, label, `${query}: the first row`);
  return key(s, "enter");
}
/** What a confirmation that was open under a command is told: closed (the loop's `dismiss`). */
const dismissed = (before, effect) => (before.act ? assert.equal(effect?.dismiss, before.act.n, "the confirmation is closed, the loop told") : undefined);

test("an instance run from the palette opens in the Instances view with the focus in its terminal, from any view: Souls, Capabilities, the help, the switcher, a confirmation (closed, the loop told) and a filter field (kept, as Enter keeps it)", () => {
  for (const [what, reach] of SHOWN) {
    const before = reach(on(THREE(), "dev-a"));
    const step = runFromPalette(before, "dev-c", "dev-c");
    assert.equal(step.effect?.open?.id, idOf(before, "dev-c"), what);
    assert.deepEqual([step.state.view, step.state.palette, step.state.act, step.state.terminal?.focus, step.state.filter.editing], ["instances", null, null, "terminal", false], what);
    assert.equal(step.state.selected, idOf(before, "dev-c"), `${what}: its row selected`);
    dismissed(before, step.effect);
  }
});

test("an act run from the palette opens its confirmation from any view, a confirmation that was open closed first and the loop told; Esc then gives the Instances view", () => {
  for (const [what, reach] of SHOWN) {
    const before = reach(on(THREE(), "dev-a"));
    const step = runFromPalette(before, "stop", "Stop");
    assert.deepEqual([step.state.view, step.state.act?.verb, step.state.act?.id, step.state.palette, step.state.filter.editing], ["act", "stop", idOf(before, "dev-a"), null, false], what);
    assert.deepEqual(step.effect?.act?.verb, "stop", what);
    dismissed(before, step.effect);
    assert.equal(key(step.state, "escape").state.view, "instances", `${what}: Esc`);
  }
});

test("a view run from the palette over a confirmation closes it (the loop told), and over a filter field keeps the filter and ends the typing, so no field's keys stand in the view's footer", () => {
  const confirming = key(on(THREE(), "dev-a"), "R").state;
  const fromAct = runFromPalette(confirming, "souls", "Souls");
  assert.deepEqual([fromAct.state.view, fromAct.state.act, fromAct.effect], ["souls", null, { dismiss: confirming.act.n, souls: "settle" }]);
  const typing = keys(on(THREE(), "dev-a"), "/", "d", "e", "v").state;
  const fromField = runFromPalette(typing, "souls", "Souls");
  assert.deepEqual([fromField.state.view, fromField.state.filter.editing, fromField.state.filter.query], ["souls", false, "dev"]);
});

test("Alt+Shift+Down or Up opens the next or previous instance in the Instances view from any view; at the end of the list nothing moves and the view stays (in the palette they are its own: below)", () => {
  for (const [what, reach] of SHOWN) {
    const before = reach(on(THREE(), "dev-a"));
    const step = stepTo(before, "down");
    assert.equal(step.effect?.open?.id, idOf(before, "dev-c"), what);
    assert.deepEqual([step.state.view, step.state.palette, step.state.act, step.state.terminal?.focus, step.state.filter.editing], ["instances", null, null, "terminal", false], what);
    dismissed(before, step.effect);
    const atEnd = reach(on(THREE(), "dev-c"));
    const still = stepTo(atEnd, "down");
    assert.deepEqual([still.effect, still.state.view], [null, atEnd.view], `${what}: dev-b, the last row, cannot be opened, so nothing moves`);
  }
  const top = stepTo(key(on(THREE(), "dev-a"), "2").state, "up");
  assert.deepEqual([top.effect, top.state.view], [null, "souls"], "Up from the first row: nothing moves");
});

test("with a terminal open, the leader then z zooms it and the leader then w closes it from any view: the Instances view comes back, a confirmation closed and the loop told", () => {
  for (const [what, reach] of SHOWN) {
    const listed = leaderEscape(opened(THREE(), "dev-a")).state;
    assert.equal(listed.terminal.focus, "list");
    const before = reach(listed);
    const zoomed = key(leader(before).state, "z");
    assert.deepEqual([zoomed.state.view, zoomed.state.terminal?.focus, zoomed.state.terminal?.zoom, zoomed.state.act], ["instances", "terminal", true, null], `${what}: z`);
    dismissed(before, zoomed.effect);
    const closed = key(leader(before).state, "w");
    assert.deepEqual([closed.state.view, closed.state.terminal, closed.effect?.close], ["instances", null, [idOf(before, "dev-a")]], `${what}: w`);
    dismissed(before, closed.effect);
  }
});

test("with no workspace open the leader's terminal commands do nothing from the switcher: Down, Up, z and w", () => {
  const none = stateOf(null, { deployment: null, cli: ACTS_CLI });
  assert.equal(none.view, "switcher");
  for (const k of ["down", "up", "z", "w"]) {
    const step = key(leader(none).state, k);
    assert.deepEqual([step.state.view, step.effect], ["switcher", null], k);
  }
});

// The shared table's `b` (the Desktop's sidebar; the Desktop UI rework, slice 4): the TUI's list is its sidebar.
test("the leader then b gives the shown terminal the whole screen, and again gives the list back; with no terminal, nothing", () => {
  const state = opened(THREE(), "dev-a");
  const hidden = leaderThen(state, "b", AT).state;
  assert.deepEqual([hidden.terminal.focus, hidden.terminal.zoom], ["terminal", true], "the list hidden: the terminal has the screen and the focus");
  const back = leaderThen(hidden, "b", AT).state;
  assert.deepEqual([back.terminal.focus, back.terminal.zoom, back.focus], ["list", false, "list"], "the list back, with the focus");
  const none = THREE();
  const nothing = leaderThen(none, "b", AT);
  assert.equal(nothing.state.terminal, null); assert.equal(nothing.state.view, "instances");
});
