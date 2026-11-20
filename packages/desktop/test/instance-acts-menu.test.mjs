// Decide, then build: the roster row's context menu is drawn from packages/client/instance-acts.mjs, and it
// is the menu it was. The proof is a capture: fixtures/instance-menu/before-instance-acts.json is what
// helpers/instance-menu-probe.mjs reported for every row of its table on the code before the rebuild (the
// fixture names the commit). The same probe runs here on the menu as it is now.
//
// #1559 removed the menu's ⋯ trigger: the menu opens from its row (a right-click, Shift+F10, the Menu key). The
// capture is left as it was taken; `asContextMenu` maps what it says of the trigger onto the row, and its own test
// proves the mapping drops nothing but the trigger's own name.
//
// One difference, named below: a remote row the kernel does not report addressable used to carry items in a
// menu that no path could open; it now carries none. The capture proves they could not be reached before,
// and the probe proves the menu still cannot be opened.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { instanceActions } from "../renderer/instance-actions.mjs";
import { instanceActs } from "../../client/instance-acts.mjs";
import { ROWS, probeAll, probeMenu } from "./helpers/instance-menu-probe.mjs";

const capture = JSON.parse(readFileSync(new URL("./fixtures/instance-menu/before-instance-acts.json", import.meta.url), "utf8"));
/** The capture's report of a row, its trigger mapped onto the row's context menu: a disabled trigger is a held menu,
 * which says the trigger's title instead of opening and marks the row with nothing; a click on the trigger is a
 * right-click on the row, its ↑ and ↓ the one key's contextmenu on the row (Shift+F10, the Menu key), so a menu that
 * opened hands its `run` out once fewer (`handedOut` counts one per way it opened). */
function asContextMenu({ trigger, opens, handedOut, ...rest }) {
  return { ...rest, handedOut: handedOut - (opens["ArrowUp on the trigger"] ? 1 : 0),
    row: { held: trigger.disabled, said: trigger.disabled ? [trigger.title] : [], marked: [] },
    opens: { "a right-click on the row": opens["a click on the trigger"], openActionMenu: opens.openActionMenu,
      "a key on the row (Shift+F10, the Menu key)": opens["ArrowDown on the trigger"], "the popover's own toggle": opens["the popover's own toggle"] } };
}
const before = { ...capture, rows: Object.fromEntries(Object.entries(capture.rows).map(([name, row]) => [name, asContextMenu(row)])) };
const after = await probeAll(instanceActions);

/** The rows whose menu used to hold items nobody could reach: every row that is not addressable, but for the two whose menu was already empty (a spawning home). */
const INERT_ITEMS_GONE = [
  "unaddressable",
  "unaddressable (gone from the server)",
  "unaddressable (not reported)",
  "unaddressable (server not reached)",
  "unaddressable and held: spawn incomplete",
  "unaddressable and held: retire incomplete",
  "all three: unaddressable, held and an unsupported session",
];
/** The rows whose held menu (the capture's disabled trigger) says why a spawning home offers nothing. The sentence is the shared one
 * (instance-tree.mjs `heldHome`), and it changed after the capture: it no longer says that the row opens. */
const SENTENCE_CHANGED = ["held: spawning", "held: spawning, and an unsupported session"];
const SPAWNING_WAS = "dev-one is setting up its worktree. It opens once the spawn finishes.";
const SPAWNING_IS = "dev-one is setting up its worktree. It can't be used until the spawn finishes.";
const NO_WAY_IN = { "a right-click on the row": false, openActionMenu: false, "a key on the row (Shift+F10, the Menu key)": false,
  "the popover's own toggle": { opened: false, refused: true } };
/** A menu no path opens: it is held, opening by any way leaves it closed (the popover's own toggle is refused), its `run` is never handed to the shell, and activating an item does nothing. */
function assertCannotOpen(report, name) {
  assert.equal(report.row.held, true, `${name}: the menu is held`);
  assert.equal(report.row.said.length, 1, `${name}: it says one thing, why`);
  assert.deepEqual(report.opens, NO_WAY_IN, `${name}: no way of opening it opens it`);
  assert.equal(report.handedOut, 0, `${name}: the menu never hands its execute to the shell`);
  for (const [action, did] of Object.entries(report.acts)) assert.deepEqual(did, { clicked: [], run: null }, `${name}: ${action} does nothing`);
}

test("the capture and the probe cover the same rows, and the capture is of a menu that worked", () => {
  assert.match(before.capturedFrom, /^packages\/desktop\/renderer\/instance-actions\.mjs at [0-9a-f]{40} /);
  assert.deepEqual(Object.keys(before.rows), Object.keys(ROWS));
  assert.deepEqual(Object.keys(after), Object.keys(ROWS));
  // Not a capture of an empty page: the ordinary rows open by every way and their items act.
  const stopped = capture.rows.stopped;
  assert.deepEqual(stopped.items.map((item) => item.action), ["open-split", "open-pr", "inspect", "start", "stop", "retire"]);
  assert.deepEqual(stopped.opens, { "a click on the trigger": true, openActionMenu: true, "ArrowDown on the trigger": true, "ArrowUp on the trigger": true,
    "the popover's own toggle": { opened: true, refused: false } });
  assert.deepEqual(stopped.acts.start, { clicked: ["invoke start"], run: ["invoke start"] });
  assert.deepEqual(stopped.acts.retire, { clicked: ["lifecycle retire"], run: ["lifecycle retire"] });
});

/** The rows compared whole with the capture: every row but the two named differences. */
const AS_IT_WAS = Object.keys(ROWS).filter((name) => !INERT_ITEMS_GONE.includes(name) && !SENTENCE_CHANGED.includes(name));

test("the rows not compared whole with the capture are the two named differences, and no other", () => {
  // A row that left the comparison without being named here would be a menu nobody checks.
  assert.deepEqual(SENTENCE_CHANGED, ["held: spawning", "held: spawning, and an unsupported session"]);
  for (const name of [...INERT_ITEMS_GONE, ...SENTENCE_CHANGED]) assert.ok(Object.hasOwn(before.rows, name) && Object.hasOwn(ROWS, name), `${name} is in the capture and in the probe`);
  assert.deepEqual(INERT_ITEMS_GONE.filter((name) => SENTENCE_CHANGED.includes(name)), [], "a row is one difference or the other");
  assert.equal(AS_IT_WAS.length, Object.keys(ROWS).length - INERT_ITEMS_GONE.length - 2);
  assert.deepEqual(Object.keys(ROWS).filter((name) => !AS_IT_WAS.includes(name)).sort(), [...INERT_ITEMS_GONE, ...SENTENCE_CHANGED].sort());
  // The sentence is on no other row of the capture: these two are every row it changes.
  assert.deepEqual(Object.keys(before.rows).filter((name) => JSON.stringify(before.rows[name]).includes("It opens once the spawn finishes")), SENTENCE_CHANGED);
});

test("the capture's trigger maps onto the row's context menu, and the mapping drops only the trigger's own name", () => {
  for (const [name, { trigger, opens, handedOut }] of Object.entries(capture.rows)) {
    // Its marking: never aria-disabled or described in the capture (no act in flight), titled only while disabled.
    assert.equal(trigger.ariaDisabled, null, name); assert.equal(trigger.description, null, name);
    assert.equal(trigger.title !== "", trigger.disabled, `${name}: a title exactly when it is disabled`);
    // Its ways in agree: a click, ↓ and ↑ opened it alike, so the row's right-click and its key carry all three.
    assert.equal(opens["ArrowDown on the trigger"], opens["a click on the trigger"], name);
    assert.equal(opens["ArrowUp on the trigger"], opens["a click on the trigger"], name);
    assert.equal(handedOut, Object.values(opens).filter((way) => way === true || way?.opened === true).length, `${name}: one \`run\` per way it opened`);
    // Its name is the button's own, gone with it; the menu keeps its own label (compared whole below).
    assert.equal(trigger.label, `Actions for dev-one${ROWS[name].server ? " on host" : ""}`, name);
  }
});

for (const name of AS_IT_WAS) {
  test(`the menu is what it was: ${name}`, () => {
    // Everything the probe reports: whether the menu is held and what it says, each item's action, label, disabled
    // state, title, note, shortcut and icon in order, which ways open the menu, and what each item does.
    assert.deepEqual(after[name], before.rows[name]);
  });
}

for (const name of INERT_ITEMS_GONE) {
  test(`the one difference, items no path could reach are gone: ${name}`, () => {
    const was = before.rows[name], now = after[name];
    assert.equal(instanceActs(ROWS[name]).blocked?.code, "unaddressable", "the row the difference is about");
    // Before: a menu with items, which could not be opened and whose items did nothing.
    assert.ok(was.items.length > 0, "the capture has the items");
    assert.deepEqual(Object.keys(was.acts), was.items.map((item) => item.action));
    assertCannotOpen(was, `${name}, before`);
    // After: the same held menu, saying the same thing, with no items, that still cannot be opened.
    assert.deepEqual(now.items, []);
    assert.deepEqual(now.acts, {});
    assertCannotOpen(now, `${name}, after`);
    assert.deepEqual({ ...now, items: was.items, acts: was.acts }, was, "nothing else differs: the hold, what it says and every way of opening");
  });
}

test("every row instanceActs blocks has a menu that cannot be opened, before and after, and says why when asked", () => {
  const blockedRows = Object.keys(ROWS).filter((name) => instanceActs(ROWS[name]).blocked);
  assert.ok(blockedRows.length >= INERT_ITEMS_GONE.length + 3, "the rows of the difference, and the spawning homes");
  for (const name of INERT_ITEMS_GONE) assert.ok(blockedRows.includes(name), name);
  for (const name of blockedRows) {
    assertCannotOpen(before.rows[name], `${name}, before`); assertCannotOpen(after[name], `${name}, after`);
    assert.deepEqual(after[name].row.said, [instanceActs(ROWS[name]).blocked.sentence], `${name}: it says the reason's sentence`);
    // The spawning homes' sentence changed after the capture (their own test, at the end); every other blocked row's is the capture's.
    if (!SENTENCE_CHANGED.includes(name)) assert.deepEqual(after[name].row.said, before.rows[name].row.said);
  }
  // And only those: a row that is not blocked opens.
  for (const name of Object.keys(ROWS).filter((row) => !blockedRows.includes(row))) {
    assert.deepEqual(after[name].row, { held: false, said: [], marked: [] }, name);
    assert.equal(after[name].opens.openActionMenu, true, name);
  }
});

test("a limited row gets none of the caller's own items; a row that offers everything gets them in front", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    const { blocked, limited, acts } = instanceActs(row), items = after[name].items.map((item) => item.action);
    assert.deepEqual(items, [...(blocked || limited ? [] : ["open-split", "open-pr"]), ...acts.map((act) => act.verb)], name);
    for (const act of acts) {
      const item = after[name].items.find((entry) => entry.action === act.verb);
      assert.equal(item.disabled, !act.enabled, `${name}: ${act.verb}`);
      assert.equal(item.title, act.reason?.sentence ?? "", `${name}: ${act.verb} carries its reason`);
    }
  }
});

test("source pin: the menu decides nothing itself", () => {
  // The four helpers the menu used to decide with. If it needs one again, the decision has not fully moved.
  const source = readFileSync(new URL("../renderer/instance-actions.mjs", import.meta.url), "utf8");
  for (const name of ["heldHome", "unsupportedSession", "canAddressRemote", "rowReason"]) assert.ok(!source.includes(name), `instance-actions.mjs names ${name}`);
  // It draws them from the shared table through desktop-acts.mjs, which adds only the acts held back above the
  // tested bound (#1879, packages/client/above-tested.mjs heldBackActs).
  assert.match(source, /import \{ desktopActs \} from "\.\/desktop-acts\.mjs";/);
  const acts = readFileSync(new URL("../renderer/desktop-acts.mjs", import.meta.url), "utf8");
  assert.match(acts, /import \{ instanceActs \} from '\.\.\/\.\.\/client\/instance-acts\.mjs';/);
  assert.match(acts, /heldBackActs\(instanceActs\(instance\), cli\)/);
  assert.ok(!/\.running\b/.test(source), "nor does it read the row's liveness");
});

for (const name of SENTENCE_CHANGED) {
  test(`the menu is what it was, but for the sentence it says: ${name}`, () => {
    // The capture is left as it was taken. One string differs, and it is the one named here.
    assert.equal(capture.rows[name].trigger.title, SPAWNING_WAS);
    assert.deepEqual(after[name].row.said, [SPAWNING_IS]);
    assert.equal(instanceActs(ROWS[name]).blocked.sentence, SPAWNING_IS, "the menu says the shared sentence");
    assert.deepEqual({ ...after[name], row: { ...after[name].row, said: [SPAWNING_WAS] } }, before.rows[name]);
    assertCannotOpen(after[name], name);
  });
}

// #1247: a home being retired (a bare `retirePending`, an older kernel's; the kernel's running or unknown `retire`; this
// window's own retire in flight) offers Retire alone, as a retire that didn't finish does, but secondary: the same menu,
// opened the same ways, its Retire acting the same, and only never the menu's default (no autofocus).
test("a retiring row: the retire-incomplete menu of the capture, but Retire is not its default", async () => {
  const { retire: _interrupted, ...base } = ROWS["held: retire incomplete"];
  const was = before.rows["held: retire incomplete"];
  for (const row of [{ ...base, retirePending: true }, { ...base, retire: { state: "running", since: "2026-10-15T00:00:00Z", self: false } },
    { ...base, retire: { state: "unknown", since: "2026-10-15T00:00:00Z", self: true } }, { ...base, retireInFlight: true }]) {
    const at = JSON.stringify(row);
    assert.deepEqual(instanceActs(row).acts, [{ verb: "retire", enabled: true, reason: null, secondary: true }], at);
    const now = await probeMenu(instanceActions, row);
    assert.deepEqual(now.items.map((item) => [item.action, item.disabled, item.autofocus]), [["retire", false, false]], at);
    assert.deepEqual({ ...now, items: now.items.map((item) => ({ ...item, autofocus: true })) }, was, `${at}: nothing else differs`);
  }
});
