// The keys the TUI shares with the Desktop are the shared keymap's (packages/client/keymap.mjs, read
// through lib/client.mjs): the leader's table, the plain keys of the list, the default leader and
// the palette's own keys.
// The TUI holds no copy of them, and every `does` of the shared table is one the TUI acts on: a row
// the TUI does not handle fails here, never becomes a key that does nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, LEADER, LEADER_KEYS, LEADER_OWN, leaderHandles, paletteKeys } from "../lib/actions.mjs";
import { LEADER_TABLE, PALETTE_KEYS, PLAIN_KEYS, leaderKey } from "../lib/client.mjs";
import { defaultDetachKey, effectiveConfig } from "../lib/config.mjs";
import { paletteStep } from "../lib/model.mjs";
import { initialState } from "../lib/store.mjs";
import { legacyChord } from "../lib/term/kitty.mjs";
import { backKeyId, isBackKey } from "../lib/term/through.mjs";

test("the leader's table is the shared one, and its keys are read as it says", () => {
  assert.equal(LEADER, LEADER_TABLE);
  assert.deepEqual([...LEADER_KEYS], LEADER_TABLE.flatMap((row) => row.keys.map((key) => [key, row.does])));
});

test("every does of the shared leader table is one the TUI handles", () => {
  const unhandled = LEADER_TABLE.map((row) => row.does).filter((does) => !leaderHandles(does));
  assert.deepEqual(unhandled, [], "a does of the shared table with no handler in the TUI");
  assert.equal(leaderHandles("not-a-thing-the-tui-does"), false, "the check itself refuses an unknown does");
});

test("the leader's own does are its own, and each is in the shared table", () => {
  for (const does of LEADER_OWN) {
    assert.equal(ACTIONS.some((action) => action.id === does), false, `${does} is no action of ACTIONS`);
    assert.equal(LEADER_TABLE.some((row) => row.does === does), true, `${does} is in the shared table`);
  }
});

test("the plain keys the TUI shares are the shared ones, action by action", () => {
  for (const { does, keys } of PLAIN_KEYS) {
    const action = ACTIONS.find((each) => each.id === does);
    assert.notEqual(action, undefined, `${does} is an action of ACTIONS`);
    assert.deepEqual(action.keys, keys, `${does}'s keys`);
  }
});

test("the keys the TUI has beyond the shared ones stay its own", () => {
  const own = ACTIONS.filter((action) => !PLAIN_KEYS.some((entry) => entry.does === action.id)).map((action) => [action.id, action.keys]);
  assert.deepEqual(own, [
    ["detail", ["tab"]], ["palette", ["ctrl+k"]], ["remove", ["delete"]], ["soul-instances", ["i"]],
    ["group-next", []], ["group-previous", []], ["tab-move", []], ["group-close", []],
    ["spawn-check", ["C"]], ["pin", ["p"]], ["close", ["escape"]], ["quit", ["q", "ctrl+c"]], ["suspend", ["ctrl+z"]], ["redraw", ["ctrl+l"]],
  ]);
});

test("the default leader is the shared one, in the back key's spelling, and open.detachKey overrides it", () => {
  for (const [platform, isMac, spelt] of [["darwin", true, "C-x"], ["linux", false, "C-x"], ["win32", false, "C-x"]]) {
    const key = defaultDetachKey(platform);
    assert.equal(key, spelt, platform);
    assert.equal(isBackKey(key), true, `${platform}: a back key`);
    assert.equal(backKeyId(key), leaderKey(isMac), `${platform}: read as the shared leader`);
    assert.equal(effectiveConfig({}, ACTIONS, platform).detachKey, spelt, `${platform}: a file that names none`);
    assert.equal(effectiveConfig({ open: { detachKey: "F12" } }, ACTIONS, platform).detachKey, "F12", `${platform}: the file's key`);
  }
});

test("the default leader is Ctrl+X on every platform: the shared leaderKey is ctrl+x on macOS and elsewhere, and defaultDetachKey C-x on each (#1433)", () => {
  assert.equal(leaderKey(true), "ctrl+x", "macOS");
  assert.equal(leaderKey(false), "ctrl+x", "Linux and Windows");
  assert.deepEqual(["darwin", "linux", "win32"].map((platform) => defaultDetachKey(platform)), ["C-x", "C-x", "C-x"]);
  assert.equal(backKeyId("C-x"), "ctrl+x", "read as the shared leader");
  for (const platform of ["darwin", "linux", "win32"]) assert.equal(initialState({ cli: {}, home: "/h", platform }).leaderKey, "ctrl+x", `${platform}: the store's leader without a tui.json`);
});

test("the palette's own keys are the shared ones (PALETTE_KEYS), read through paletteKeys: on Linux and Windows the Alt+Shift arrows, which a terminal sends with or without the kitty keyboard protocol, and on macOS none, each of its being a Command key; each does is one the palette moves by, and the store holds the platform's", () => {
  assert.deepEqual([...paletteKeys(false)], PALETTE_KEYS.map((entry) => [entry.other, entry.does]));
  assert.deepEqual([...paletteKeys(true)], [], "macOS: a terminal never passes Command");
  for (const entry of PALETTE_KEYS) {
    assert.equal(entry.mac.startsWith("cmd+"), true, `${entry.does}: macOS's is a Command key`);
    assert.equal(legacyChord(entry.other), true, `${entry.does}: ${entry.other} is read without the protocol too`);
  }
  // model.mjs paletteStep acts on each does of the table, and on no other: a row the TUI does not
  // handle fails here, never becomes a key that does nothing.
  const list = Object.freeze({ runs: [["a", "b"], ["c"]], selected: "b" });
  assert.deepEqual(PALETTE_KEYS.map((entry) => [entry.does, paletteStep(list, entry.does)]), [["palette-next-group", "c"], ["palette-previous-group", "c"]]);
  assert.equal(paletteStep(list, "not-a-thing-the-palette-does"), null);
  for (const [platform, isMac] of [["darwin", true], ["linux", false], ["win32", false]]) {
    assert.deepEqual(initialState({ cli: {}, home: "/h", platform }).paletteKeys, paletteKeys(isMac), platform);
  }
});
