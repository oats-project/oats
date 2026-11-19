import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { ACTIONS, bindings } from "../lib/actions.mjs";
import { KEYS_LIMIT, chordFamilyNote, keysPath } from "../lib/client.mjs";
import { CONFIG_LIMIT, MAX_PROBLEMS, MIGRATED, configPath, defaultDetachKey, effectiveConfig, loadConfig, loadKeys, oldConfigPath } from "../lib/config.mjs";
import { isKeyId } from "../lib/term/keys.mjs";
import { BACK_KEY_RULE } from "../lib/term/through.mjs";

const FILE = "/cfg/config/tui.json";
const IDS = "up, down, top, bottom, page-up, page-down, collapse, expand, detail, filter, refresh, instances, souls, capabilities, workspaces, palette, open, remove, soul-instances, zoom, close-terminal, tab-previous, tab-next, split-right, split-down, group-next, group-previous, tab-move, group-close, stop, retire, start, restart, spawn, spawn-another, spawn-check, pin, help, close, quit, suspend, redraw";
const KEY_IDS = "key ids look like q, ctrl+c, shift+tab, f5, space";
/** The whole line of a refusal, as it is printed. */
const line = (clause, file = FILE) => `oats: \`oats tui\` cannot use ${file}: ${clause} (E_TUI_CONFIG)`;
/** A line fit for a terminal: printable ASCII and nothing else. */
const PRINTABLE = /^[\x20-\x7e]*$/;

/** The default leader, C-x (Ctrl+X) on every platform; Linux is the platform every test here gives
 *  loadConfig and effectiveConfig unless it says another, so no answer depends on the host's. */
const LEADER = "C-x";
/** loadConfig over a file that exists only here, at the path read now, on `platform`. `content`
 *  is its text, or a value written as JSON; there is no file at the old path (`entry`, the move's
 *  look, finds none there), so nothing is moved. `calls` records what was asked of the file system
 *  to read it. */
function load(content, { stat, read, env = { OATS_HOME_DIR: "/cfg" }, home = "/home/u", platform = "linux" } = {}) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const calls = [];
  const io = {
    entry(file) { return file === oldConfigPath(env, home) ? null : { ino: 1 }; },
    stat(file) { calls.push(["stat", file]); return stat ? stat(file) : { file: true, size: Buffer.byteLength(text) }; },
    read(file) { calls.push(["read", file]); return read ? read(file) : text; },
  };
  return { ...loadConfig({ env, home, io, platform }), calls };
}
/** The keys of an effective table, by action id. */
const keysOf = (actions) => Object.fromEntries(actions.map((action) => [action.id, [...action.keys]]));
const DEFAULT_KEYS = keysOf(ACTIONS);
const deepFrozen = (actions) => Object.isFrozen(actions) && actions.every((action) => Object.isFrozen(action) && Object.isFrozen(action.keys));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oats-tui-config-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let homes = 0;
/** A fresh OATS_HOME_DIR on disk, with its config directory, and the path tui.json has in it. */
function onDisk() {
  const home = path.join(dir, `home-${++homes}`);
  fs.mkdirSync(path.join(home, "config"), { recursive: true });
  return { env: { OATS_HOME_DIR: home }, home: "/nonexistent", file: path.join(home, "config", "tui.json") };
}

// --- The path -------------------------------------------------------------------

test("the path is $OATS_HOME_DIR/config/tui.json when that is set and not empty, else <home>/.oats/config/tui.json, the kernel's rule for its files; XDG_CONFIG_HOME is not read for it", () => {
  assert.equal(configPath({ OATS_HOME_DIR: "/x/oats" }, "/home/u"), path.join("/x/oats", "config", "tui.json"));
  const fallback = path.join("/home/u", ".oats", "config", "tui.json");
  assert.equal(configPath({}, "/home/u"), fallback);
  assert.equal(configPath({ OATS_HOME_DIR: "" }, "/home/u"), fallback, "empty");
  assert.equal(configPath({ OATS_HOME_DIR: undefined }, "/home/u"), fallback);
  assert.equal(configPath({ OATS_HOME_DIR: 7 }, "/home/u"), fallback, "not a string");
  assert.equal(configPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u"), fallback, "XDG_CONFIG_HOME is not read");
  assert.equal(configPath({ OATS_HOME_DIR: "/x/oats" }, undefined), path.join("/x/oats", "config", "tui.json"), "the home is not asked for when it is not used");
});

test("the old path, looked at only to move it, is the old rule's: $XDG_CONFIG_HOME/oats/tui.json when that is set, not empty and absolute, else <home>/.config/oats/tui.json", () => {
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u"), path.join("/x/cfg", "oats", "tui.json"));
  const fallback = path.join("/home/u", ".config", "oats", "tui.json");
  assert.equal(oldConfigPath({}, "/home/u"), fallback);
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: "" }, "/home/u"), fallback, "empty");
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: "cfg" }, "/home/u"), fallback, "relative");
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: "./cfg" }, "/home/u"), fallback, "relative");
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: "~/.config" }, "/home/u"), fallback, "a tilde is not expanded: relative");
  assert.equal(oldConfigPath({ XDG_CONFIG_HOME: 7 }, "/home/u"), fallback, "not a string");
  assert.equal(oldConfigPath({ OATS_HOME_DIR: "/x/oats" }, "/home/u"), fallback, "OATS_HOME_DIR is not the old rule's");
});

test("loadConfig reads the path configPath gives, whatever XDG_CONFIG_HOME says", () => {
  const fallback = path.join("/home/u", ".oats", "config", "tui.json");
  for (const env of [{}, { OATS_HOME_DIR: "" }, { XDG_CONFIG_HOME: "/x/cfg" }, { XDG_CONFIG_HOME: "relative/cfg" }]) {
    const loaded = load({ ascii: true }, { env });
    assert.equal(loaded.path, fallback);
    assert.deepEqual(loaded.calls, [["stat", fallback], ["read", fallback]]);
  }
  assert.equal(load({}, { env: { OATS_HOME_DIR: "/x/oats", XDG_CONFIG_HOME: "/x/cfg" } }).path, path.join("/x/oats", "config", "tui.json"));
});

// --- The defaults ---------------------------------------------------------------

test("no file is the defaults: the action table itself, ascii false, the default detach key (C-x on every platform), and the path that was looked at; nothing is read", () => {
  const loaded = load("", { stat: () => null });
  assert.deepEqual(Object.keys(loaded), ["ok", "actions", "ascii", "detachKey", "path", "calls"]);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.actions, ACTIONS);
  assert.equal(loaded.ascii, false);
  assert.equal(loaded.detachKey, "C-x");
  assert.equal(loaded.path, FILE);
  assert.deepEqual(loaded.calls, [["stat", FILE]]);
  for (const [platform, key] of [["linux", "C-x"], ["win32", "C-x"], ["freebsd", "C-x"], ["darwin", "C-x"]]) {
    assert.equal(defaultDetachKey(platform), key, platform);
    assert.equal(load("", { stat: () => null, platform }).detachKey, key, platform);
    assert.equal(effectiveConfig({}, ACTIONS, platform).detachKey, key, platform);
  }
  assert.equal(defaultDetachKey(), defaultDetachKey(process.platform), "without one, the platform it runs on");
  assert.equal(effectiveConfig({}).detachKey, defaultDetachKey(process.platform));
});

test("an empty object, or one that names no action, is the defaults: an equal table, frozen like the one it was made from", () => {
  for (const value of [{}, { keys: {} }, { ascii: false }, { ascii: false, keys: {} }]) {
    const result = effectiveConfig(value, ACTIONS, "linux");
    assert.deepEqual(Object.keys(result), ["ok", "actions", "ascii", "detachKey"]);
    assert.deepEqual(result.actions, ACTIONS);
    assert.equal(deepFrozen(result.actions), true);
    assert.equal(result.ascii, false);
    assert.equal(result.detachKey, LEADER);
  }
  assert.equal(deepFrozen(ACTIONS), true);
  assert.equal(ACTIONS.every((action) => action.keys.every(isKeyId)), true, "every default key is a key id");
});

test("ascii true is --ascii; it is false when absent, and anything but a boolean is refused", () => {
  assert.equal(effectiveConfig({ ascii: true }).ascii, true);
  assert.equal(effectiveConfig({ ascii: false }).ascii, false);
  assert.equal(effectiveConfig({ keys: { quit: ["x"] } }).ascii, false);
  assert.equal(load({ ascii: true, keys: { quit: ["x"] } }).ascii, true);
  for (const ascii of [1, 0, "true", "yes", null, [], {}]) {
    assert.deepEqual(load({ ascii }).lines, [line("ascii must be true or false")], JSON.stringify(ascii));
  }
});

// --- Replacement ----------------------------------------------------------------

test("a list replaces that action's keys, an empty list unbinds it, and an action that is not named keeps its keys", () => {
  const result = effectiveConfig({ keys: { quit: ["q"], refresh: ["r", "f5"], suspend: [] }, ascii: false });
  assert.equal(result.ok, true);
  assert.deepEqual(keysOf(result.actions), { ...DEFAULT_KEYS, quit: ["q"], refresh: ["r", "f5"], suspend: [] });
  assert.deepEqual(result.actions.map(({ id, label }) => [id, label]), ACTIONS.map(({ id, label }) => [id, label]), "same order, ids and labels");
  assert.deepEqual(result.actions.map((action) => Object.keys(action)), ACTIONS.map((action) => Object.keys(action)), "rows shaped like the table's");
  assert.equal(deepFrozen(result.actions), true);
  const map = bindings(result.actions);
  assert.equal(map.get("f5"), "refresh");
  assert.equal(map.has("ctrl+c"), false, "quit's list replaced its keys: ctrl+c went with them");
  assert.equal(map.has("ctrl+z"), false, "suspend is unbound");
  assert.equal(map.get("ctrl+l"), "redraw", "an action not named keeps its key");
  assert.deepEqual(keysOf(ACTIONS), DEFAULT_KEYS, "the table it was made from is untouched");
});

test("a key an action gave up is free for another, whatever the order they are written in", () => {
  for (const keys of [{ quit: ["x"], refresh: ["q"] }, { refresh: ["q"], quit: ["x"] }]) {
    const result = effectiveConfig({ keys });
    assert.equal(result.ok, true, JSON.stringify(keys));
    assert.deepEqual([bindings(result.actions).get("q"), bindings(result.actions).get("x")], ["refresh", "quit"]);
  }
  const swapped = effectiveConfig({ keys: { up: ["j", "down"], down: ["k", "up"] } });
  assert.deepEqual([swapped.actions[0].keys, swapped.actions[1].keys], [["j", "down"], ["k", "up"]], "two actions may trade their keys");
});

test("the table answered holds its own lists: changing what was parsed afterwards changes nothing", () => {
  const value = { keys: { quit: ["x"] } };
  const result = effectiveConfig(value);
  value.keys.quit.push("y");
  assert.deepEqual(result.actions.find((action) => action.id === "quit").keys, ["x"]);
  assert.throws(() => result.actions.find((action) => action.id === "quit").keys.push("z"), TypeError);
});

test("a key id a terminal may never send is accepted: what is asked is whether it is a key id", () => {
  const keys = { refresh: ["f12", "ctrl+alt+shift+f12"], help: ["alt+é", "é"], detail: ["shift+tab", "alt+enter", "space", "alt++", "+"], instances: ["\u{1f44d}\u{1f3fd}"] };
  const result = effectiveConfig({ keys });
  assert.equal(result.ok, true);
  assert.deepEqual(keysOf(result.actions), { ...DEFAULT_KEYS, ...keys });
});

test("refused: a key the help cannot name, one whose label the display filter would change, though it is a key id", () => {
  // A bidi override, a zero-width space and a combining mark on a space: each one grapheme, so a
  // key id; drawn, each would name another key or none.
  for (const key of ["\u202e", "\u200b", " \u0301", "alt+\u202e"]) {
    assert.equal(isKeyId(key), true, `${JSON.stringify(key)} is a key id`);
    assert.deepEqual(load({ keys: { quit: [key] } }).lines, [line("a key of quit that cannot be shown is a key the help cannot name; give a key whose character can be shown")], JSON.stringify(key));
    assert.deepEqual(effectiveConfig({ keys: { help: ["x", key] } }), { ok: false, problems: ["a key of help that cannot be shown is a key the help cannot name; give a key whose character can be shown"] });
  }
  // Every default key can be named.
  assert.equal(effectiveConfig({ keys: Object.fromEntries(ACTIONS.map((action) => [action.id, [...action.keys]])) }).ok, true);
});

test("effectiveConfig checks against the table it is given", () => {
  const table = Object.freeze([{ id: "a", keys: ["x"], label: "A", extra: 1 }, { id: "b", keys: ["y"], label: "B" }]);
  assert.deepEqual(effectiveConfig({ keys: { b: ["z"] } }, table, "linux"), { ok: true, actions: [{ id: "a", keys: ["x"], label: "A", extra: 1 }, { id: "b", keys: ["z"], label: "B" }], ascii: false, detachKey: LEADER });
  assert.deepEqual(effectiveConfig({ keys: { quit: ["q"] } }, table), { ok: false, problems: ["unknown action quit; the actions are a, b"] });
  assert.deepEqual(effectiveConfig({ keys: { b: ["x"] } }, table), { ok: false, problems: ["the key x is given to a and to b; a key does one thing"] });
  assert.deepEqual(effectiveConfig({ keys: { b: [] } }, table).ok, true, "only quit must keep a key");
  const defect = [{ id: "a", keys: ["x"], label: "A" }, { id: "b", keys: ["x"], label: "B" }];
  assert.throws(() => bindings(defect));
  assert.deepEqual(effectiveConfig({}, defect), { ok: false, problems: ["the key x is given to a and to b; a key does one thing"] }, "a table that binds a key twice is a problem, never a throw");
  assert.equal(effectiveConfig({ keys: { b: ["y"] } }, defect).ok, true, "and the file can mend it");
});

// --- The refusals, each by name --------------------------------------------------

test("refused: not a regular file (a directory, a FIFO, a device), without reading it", () => {
  const loaded = load("{}", { stat: () => ({ file: false, size: 2 }) });
  assert.deepEqual(Object.keys(loaded), ["ok", "lines", "calls"]);
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.lines, [line("it is not a regular file")]);
  assert.deepEqual(loaded.calls, [["stat", FILE]], "it was not read");
});

test("refused: it cannot be read, with the error's code when it is a plain one and never its text", () => {
  const fail = (code, message = "EACCES: permission denied, stat '/cfg/config/tui.json'") => () => { throw Object.assign(new Error(message), code === undefined ? {} : { code }); };
  assert.deepEqual(load("{}", { stat: fail("EACCES") }).lines, [line("it cannot be read (EACCES)")]);
  assert.deepEqual(load("{}", { stat: fail("ELOOP") }).lines, [line("it cannot be read (ELOOP)")]);
  assert.deepEqual(load("{}", { read: fail("EISDIR") }).lines, [line("it cannot be read (EISDIR)")]);
  assert.deepEqual(load("{}", { read: fail("EIO") }).lines, [line("it cannot be read (EIO)")]);
  for (const code of [undefined, "", "eacces", "E ACCES", "E\x1b[2J", "E".repeat(32), 13, null, { toString: () => "EACCES" }]) {
    assert.deepEqual(load("{}", { stat: fail(code, "\x1b[2Jhostile") }).lines, [line("it cannot be read")], String(code));
    assert.deepEqual(load("{}", { read: fail(code, "\x1b[2Jhostile") }).lines, [line("it cannot be read")], String(code));
  }
  assert.deepEqual(load("{}", { stat: () => { throw "a string"; } }).lines, [line("it cannot be read")]);
  assert.deepEqual(load("{}", { read: () => { throw null; } }).lines, [line("it cannot be read")]);
  assert.deepEqual(load("{}", { stat: fail("ENOENT") }).lines, [line("it cannot be read (ENOENT)")], "only a null from stat means no file: an injected stat that throws is a failure");
});

test("refused: larger than 64 KiB, by its size alone: a file exactly at the limit is read, one byte over is never read", () => {
  assert.equal(CONFIG_LIMIT, 64 * 1024);
  const padded = (size) => { const head = '{"ascii": true, "keys": {"quit": ["x"]}}'; return head + " ".repeat(size - head.length); };
  const at = load(padded(CONFIG_LIMIT));
  assert.equal(at.ok, true);
  assert.deepEqual([at.ascii, bindings(at.actions).get("x")], [true, "quit"]);
  assert.deepEqual(at.calls, [["stat", FILE], ["read", FILE]]);

  const over = load(padded(CONFIG_LIMIT + 1));
  assert.deepEqual(over.lines, [line("it is larger than 64 KiB")]);
  assert.deepEqual(over.calls, [["stat", FILE]], "read was not called");
  for (const size of [CONFIG_LIMIT + 1, 2 ** 40, Infinity, NaN, undefined, "12"]) {
    const huge = load("{}", { stat: () => ({ file: true, size }), read: () => assert.fail("read was called") });
    assert.deepEqual(huge.lines, [line("it is larger than 64 KiB")], String(size));
  }
  const grew = load("{}", { read: () => { throw Object.assign(new Error("grew"), { code: "EFBIG" }); } });
  assert.deepEqual(grew.lines, [line("it is larger than 64 KiB")], "a file that grew past the limit after it was measured");
});

test("refused: not valid JSON, and the parser's own words never reach the line", () => {
  for (const text of ["", " ", "{", "{'keys': {}}", '{"keys": {"quit": ["q"],}}', "// keys\n{}", '{"ascii": true} {"ascii": false}', "\uFEFF{}", "\x1b[2J", "{\"keys\": {\"quit\": [\"\x1b[2J\"]}}", "undefined", "NaN", '{"a\x00": 1'] ) {
    assert.deepEqual(load(text).lines, [line("it is not valid JSON")], JSON.stringify(text));
  }
});

test("refused: valid JSON that is not one object", () => {
  for (const text of ["[]", '[{"ascii": true}]', '"keys"', "null", "true", "false", "0", "12.5"]) {
    assert.deepEqual(load(text).lines, [line('it is not one JSON object, like {"keys": {"quit": ["q"]}}')], text);
  }
  for (const value of [undefined, null, [], "keys", 1, true, () => ({})]) {
    assert.deepEqual(effectiveConfig(value), { ok: false, problems: ['it is not one JSON object, like {"keys": {"quit": ["q"]}}'] });
  }
});

test("refused: a top-level key other than keys, ascii and open", () => {
  assert.deepEqual(load({ theme: "dark" }).lines, [line("unknown setting theme; the settings are keys, ascii and open")]);
  assert.deepEqual(load({ Keys: {} }).lines, [line("unknown setting Keys; the settings are keys, ascii and open")]);
  assert.deepEqual(load('{"__proto__": {"ascii": true}}').lines, [line("unknown setting __proto__; the settings are keys, ascii and open")]);
  assert.deepEqual(load('{"constructor": 1}').lines, [line("unknown setting constructor; the settings are keys, ascii and open")]);
  assert.deepEqual(load({ "": 1 }).lines, [line("a setting whose name cannot be shown is unknown; the settings are keys, ascii and open")]);
});

test("refused: keys that is not an object", () => {
  for (const keys of [[], [["quit", ["q"]]], "q", 1, true, null]) {
    assert.deepEqual(load({ keys }).lines, [line('keys must be an object, like {"quit": ["q"]}')], JSON.stringify(keys));
  }
});

test("a refusal of the file's shape is one line and ends the check: the first in the file's order, and nothing about its keys", () => {
  const broken = { quit: [], reload: ["x"], up: ["Ctrl+C"] };
  assert.equal(load({ keys: broken }).lines.length, 3);
  assert.deepEqual(load({ keys: broken, theme: 1 }).lines, [line("unknown setting theme; the settings are keys, ascii and open")]);
  assert.deepEqual(load({ keys: broken, ascii: "yes" }).lines, [line("ascii must be true or false")]);
  assert.deepEqual(load({ ascii: "yes", theme: 1, keys: [] }).lines, [line("ascii must be true or false")]);
  assert.deepEqual(load({ theme: 1, ascii: "yes", keys: [] }).lines, [line("unknown setting theme; the settings are keys, ascii and open")]);
  assert.deepEqual(load({ keys: [], ascii: "yes", theme: 1 }).lines, [line('keys must be an object, like {"quit": ["q"]}')]);
});

test("refused: an unknown action id, with the ids there are", () => {
  assert.deepEqual(load({ keys: { reload: ["f5"] } }).lines, [line(`unknown action reload; the actions are ${IDS}`)]);
  assert.equal(IDS, ACTIONS.map((action) => action.id).join(", "));
  for (const id of ["Quit", "QUIT", "page_up", "pageup", "toString", "constructor", "hasOwnProperty"]) {
    assert.deepEqual(load({ keys: { [id]: ["f5"] } }).lines, [line(`unknown action ${id}; the actions are ${IDS}`)], id);
  }
  assert.deepEqual(load('{"keys": {"__proto__": ["f5"]}}').lines, [line(`unknown action __proto__; the actions are ${IDS}`)]);
  assert.deepEqual(load({ keys: { "": ["f5"] } }).lines, [line(`an action id that cannot be shown is unknown; the actions are ${IDS}`)]);
  assert.deepEqual(load({ keys: { reload: 7 } }).lines, [line(`unknown action reload; the actions are ${IDS}`)], "its value is not looked at");
});

test("refused: a value that is not a list of strings, once for the action", () => {
  const clause = (id) => `${id} must be a list of key ids, like ["q", "ctrl+c"]`;
  for (const value of ["q", 1, true, null, {}, { 0: "q" }, [1], ["q", 1], [null], [["q"]], [{ key: "q" }], ["x", 1, null, {}]]) {
    assert.deepEqual(load({ keys: { refresh: value } }).lines, [line(clause("refresh"))], JSON.stringify(value));
  }
  assert.deepEqual(load({ keys: { quit: "q" } }).lines, [line(clause("quit"))], "and not that quit has no key: what it was meant to hold is not known");
  assert.deepEqual(load({ keys: { refresh: "q", help: ["r"] } }).lines, [line(clause("refresh"))], "nor is its default key held against another action");
  assert.deepEqual(load({ keys: { help: ["r"], refresh: ["q", 1], quit: ["x"] } }).lines, [line(clause("refresh"))], "nor a string of the refused list");
});

test("refused: a string that is not a key id, each one, with what a key id looks like", () => {
  assert.deepEqual(load({ keys: { quit: ["Ctrl+C"] } }).lines, [line(`the key Ctrl+C of quit is not a key id; ${KEY_IDS}`)]);
  assert.deepEqual(load({ keys: { quit: ["q", "ctrl+shift+alt+x", "esc", "f13", "ab", "alt+"], help: ["ctrl+h"] } }).lines, [
    line(`the key ctrl+shift+alt+x of quit is not a key id; ${KEY_IDS}`),
    line(`the key esc of quit is not a key id; ${KEY_IDS}`),
    line(`the key f13 of quit is not a key id; ${KEY_IDS}`),
    line(`the key ab of quit is not a key id; ${KEY_IDS}`),
    line(`the key alt+ of quit is not a key id; ${KEY_IDS}`),
    line(`the key ctrl+h of help is not a key id; ${KEY_IDS}`),
  ]);
  assert.deepEqual(load({ keys: { quit: [""] } }).lines, [line(`an empty key of quit is not a key id; ${KEY_IDS}`)]);
  assert.deepEqual(load({ keys: { quit: [" "] } }).lines, [line(`a key of quit that cannot be shown is not a key id; ${KEY_IDS}`)], "the space is written space");
  assert.deepEqual(load({ keys: { quit: ["\t", "q"] } }).lines, [line(`a key of quit that cannot be shown is not a key id; ${KEY_IDS}`)]);
  assert.deepEqual(load({ keys: { quit: ["bogus"], refresh: ["q"] } }).lines, [line(`the key bogus of quit is not a key id; ${KEY_IDS}`)], "quit is named, so its default keys are free");
});

test("refused: one key given to two actions, naming the key and both; a user's key against a default of an action the file does not name", () => {
  assert.deepEqual(load({ keys: { refresh: ["q"] } }).lines, [line("the key q is given to quit and to refresh; a key does one thing")]);
  assert.deepEqual(load({ keys: { quit: ["r"] } }).lines, [line("the key r is given to refresh and to quit; a key does one thing")]);
  assert.deepEqual(load({ keys: { help: ["f1", "ctrl+c", "escape"] } }).lines, [
    line("the key ctrl+c is given to quit and to help; a key does one thing"),
    line("the key escape is given to close and to help; a key does one thing"),
  ]);
  assert.deepEqual(effectiveConfig({ keys: { refresh: ["q"] } }), { ok: false, problems: ["the key q is given to quit and to refresh; a key does one thing"] });
  // The switcher's two actions hold `w` and `enter` by default: a file written before they
  // existed that gives one of them to another action is refused like any other, and is
  // honoured once it gives the switcher's action another key, or none.
  assert.deepEqual(load({ keys: { refresh: ["w"] } }).lines, [line("the key w is given to workspaces and to refresh; a key does one thing")]);
  assert.deepEqual(load({ keys: { detail: ["enter"] } }).lines, [line("the key enter is given to open and to detail; a key does one thing")]);
  assert.equal(load({ keys: { refresh: ["w"], workspaces: ["f2"] } }).ok, true);
  assert.equal(load({ keys: { detail: ["enter"], open: [] } }).ok, true);
});

test("the switcher's Remove holds Delete by default, and no letter: a file that gives x or m to an action is still taken; one that gives Delete to another action is refused naming both, until it rebinds remove", () => {
  assert.deepEqual(ACTIONS.find((action) => action.id === "remove").keys, ["delete"]);
  assert.equal(bindings(ACTIONS).get("delete"), "remove");
  // The free letters a file is likeliest to use: a file written before Remove existed keeps working.
  for (const letter of ["x", "m"]) for (const id of ["refresh", "remove", "help"]) {
    const loaded = load({ keys: { [id]: [letter] } });
    assert.equal(loaded.ok, true, `${letter} to ${id}`);
    assert.equal(bindings(loaded.actions).get(letter), id);
  }
  // Delete, as any default that is taken: refused, naming the key and both actions.
  assert.deepEqual(load({ keys: { refresh: ["delete"] } }).lines, [line("the key delete is given to remove and to refresh; a key does one thing")]);
  assert.deepEqual(effectiveConfig({ keys: { close: ["escape", "delete"] } }), { ok: false, problems: ["the key delete is given to remove and to close; a key does one thing"] });
  // Rebound or unbound like the rest: then Delete is free for another action.
  const rebound = load({ keys: { refresh: ["delete"], remove: ["x"] } });
  assert.equal(rebound.ok, true);
  assert.deepEqual([bindings(rebound.actions).get("delete"), bindings(rebound.actions).get("x")], ["refresh", "remove"]);
  const unbound = load({ keys: { refresh: ["r", "delete"], remove: [] } });
  assert.equal(unbound.ok, true);
  assert.deepEqual([unbound.actions.find((action) => action.id === "remove").keys, bindings(unbound.actions).get("delete")], [[], "refresh"]);
});

test("pin holds p by default (feature instance-pin): a file that gives p to another action is refused at the start, naming the key and both actions, until that action moves or pin gets another key", () => {
  assert.deepEqual(ACTIONS.find((action) => action.id === "pin").keys, ["p"]);
  assert.equal(bindings(ACTIONS).get("p"), "pin");
  // A file written before pin existed, that gives p to an action: the line that refuses it says what to change.
  assert.deepEqual(load({ keys: { refresh: ["p"] } }).lines, [line("the key p is given to pin and to refresh; a key does one thing")]);
  assert.deepEqual(load({ keys: { help: ["?", "p"] } }).lines, [line("the key p is given to pin and to help; a key does one thing")]);
  assert.equal(load({ keys: { refresh: ["p"] } }).ok, false);
  // Either change the release note names makes it taken: the action moves off p, or pin gets another key.
  assert.equal(load({ keys: { refresh: ["f5"] } }).ok, true);
  const rebound = load({ keys: { refresh: ["p"], pin: ["P"] } });
  assert.equal(rebound.ok, true);
  assert.deepEqual([bindings(rebound.actions).get("p"), bindings(rebound.actions).get("P")], ["refresh", "pin"]);
  assert.equal(load({ keys: { refresh: ["p"], pin: [] } }).ok, true, "or none: then only `oats instance pin` pins");
});

test("refused: one key given to two actions by two lists of the file, found at the second", () => {
  assert.deepEqual(load({ keys: { quit: ["x"], refresh: ["x"] } }).lines, [line("the key x is given to quit and to refresh; a key does one thing")]);
  assert.deepEqual(load({ keys: { refresh: ["x"], quit: ["x"] } }).lines, [line("the key x is given to refresh and to quit; a key does one thing")]);
  assert.deepEqual(load({ keys: { up: ["x"], down: ["x"], top: ["x"] } }).lines, [
    line("the key x is given to up and to down; a key does one thing"),
    line("the key x is given to up and to top; a key does one thing"),
  ], "the first to hold it keeps it: there is no last wins");
  assert.deepEqual(load({ keys: { help: ["é"], close: ["é"] } }).lines, [line("a key that cannot be shown is given to help and to close; a key does one thing")]);
});

test("refused: the same key twice in one action's list", () => {
  assert.deepEqual(load({ keys: { quit: ["q", "q"] } }).lines, [line("the key q is given to quit twice; list it once")]);
  assert.deepEqual(load({ keys: { refresh: ["r", "f5", "r", "f5", "r"] } }).lines, [
    line("the key r is given to refresh twice; list it once"),
    line("the key f5 is given to refresh twice; list it once"),
    line("the key r is given to refresh twice; list it once"),
  ]);
  assert.deepEqual(load({ keys: { help: ["日", "日"] } }).lines, [line("a key that cannot be shown is given to help twice; list it once")]);
});

test("refused: quit left with no key", () => {
  assert.deepEqual(load({ keys: { quit: [] } }).lines, [line("quit has no key; give it one")]);
  assert.deepEqual(effectiveConfig({ keys: { quit: [] } }), { ok: false, problems: ["quit has no key; give it one"] });
  assert.deepEqual(load({ keys: { quit: [], refresh: ["q", "ctrl+c"] } }).lines, [line("quit has no key; give it one")], "giving its keys to another action does not help");
  for (const action of ACTIONS.filter((a) => a.id !== "quit")) assert.equal(effectiveConfig({ keys: { [action.id]: [] } }).ok, true, `${action.id} may be unbound`);
  assert.equal(effectiveConfig({ keys: Object.fromEntries(ACTIONS.map((a) => [a.id, a.id === "quit" ? ["q"] : []])) }).ok, true, "quit alone is enough");
});

test("every problem inside keys is said, one line each, in the file's order", () => {
  const keys = { reload: ["x"], quit: [], refresh: ["q", "Ctrl+C", "f5", "f5"], help: "?", up: ["x"], down: ["x", "r"], redraw: ["ctrl+l"] };
  assert.deepEqual(load({ ascii: true, keys }).lines, [
    line(`unknown action reload; the actions are ${IDS}`),
    line("quit has no key; give it one"),
    line(`the key Ctrl+C of refresh is not a key id; ${KEY_IDS}`),
    line("the key f5 is given to refresh twice; list it once"),
    line('help must be a list of key ids, like ["q", "ctrl+c"]'),
    line("the key x is given to up and to down; a key does one thing"),
  ]);
  assert.deepEqual(Object.keys(load({ keys })), ["ok", "lines", "calls"], "a refusal answers no table");
});

test("at most MAX_PROBLEMS problems are printed: a file with more says the first ones, in the file's order, and then how many it left out", () => {
  const bad = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`nope${String(i).padStart(2, "0")}`, ["x"]]));
  const unknown = (i) => line(`unknown action nope${String(i).padStart(2, "0")}; the actions are ${IDS}`);
  assert.equal(MAX_PROBLEMS, 20);
  const atLimit = load({ keys: bad(MAX_PROBLEMS) }).lines;
  assert.deepEqual(atLimit, Array.from({ length: MAX_PROBLEMS }, (_, i) => unknown(i)), "exactly the limit: every problem, and no count");
  const over = load({ keys: bad(MAX_PROBLEMS + 1) }).lines;
  assert.deepEqual(over, [...atLimit, line("1 more problem is not listed")]);
  const many = load({ keys: bad(500) }).lines;
  assert.equal(many.length, MAX_PROBLEMS + 1);
  assert.deepEqual(many.slice(0, MAX_PROBLEMS), atLimit);
  assert.equal(many.at(-1), line("480 more problems are not listed"));
});

// --- What reaches a terminal ------------------------------------------------------

const HOSTILE = ["\x1b[2J", "\x1b]0;title\x07", "a\x07b", "q\x00", "\u009b31m", "\u0085", "x\ny", "x\ry", "tab\there", "a b", " ", "é", "日本", "\u202Eevil", "\u{1f600}", "\uFEFFq", "\x7f", "x".repeat(41), "x".repeat(5000)];

test("a name from the file reaches a line only when it is plain printable ASCII of at most 40 characters", () => {
  const forty = "x".repeat(40), fortyOne = "x".repeat(41);
  assert.deepEqual(load({ [forty]: 1 }).lines, [line(`unknown setting ${forty}; the settings are keys, ascii and open`)]);
  assert.deepEqual(load({ [fortyOne]: 1 }).lines, [line("a setting whose name cannot be shown is unknown; the settings are keys, ascii and open")]);
  assert.deepEqual(load({ keys: { [forty]: [] } }).lines, [line(`unknown action ${forty}; the actions are ${IDS}`)]);
  assert.deepEqual(load({ keys: { [fortyOne]: [] } }).lines, [line(`an action id that cannot be shown is unknown; the actions are ${IDS}`)]);
  assert.deepEqual(load({ keys: { help: [forty] } }).lines, [line(`the key ${forty} of help is not a key id; ${KEY_IDS}`)]);
  assert.deepEqual(load({ keys: { help: [fortyOne] } }).lines, [line(`a key of help that cannot be shown is not a key id; ${KEY_IDS}`)]);
  assert.deepEqual(load({ keys: { help: ["!~", "(E_TUI_CONFIG)"] } }).lines, [line(`the key !~ of help is not a key id; ${KEY_IDS}`), line(`the key (E_TUI_CONFIG) of help is not a key id; ${KEY_IDS}`)]);
});

test("a hostile name never appears in a line, wherever the file puts it, and every line is printable ASCII", () => {
  const all = [];
  const refused = (loaded, what) => { assert.equal(loaded.ok, false, what); assert.ok(loaded.lines.length > 0, what); return loaded.lines; };
  const table = (name) => [{ id: "north", keys: ["x"], label: "N" }, { id: name, keys: ["y", "x"], label: name }, { id: "south", keys: [], label: "S" }];
  for (const name of HOSTILE) {
    const label = JSON.stringify(name).slice(0, 30);
    const lines = [
      ...refused(load({ [name]: 1 }), `setting ${label}`),
      ...refused(load({ keys: { [name]: ["x"] } }), `action ${label}`),
      ...refused(load({ keys: { [name]: name } }), `action and value ${label}`),
      ...refused(load({ keys: { help: [name, "Ctrl+C"] } }), `key ${label}`),
      ...refused(load({ keys: { help: [name, "x"], close: [name, "x"], up: [name, name] } }), `key twice ${label}`),
      ...refused(load({ keys: { quit: name } }), `value ${label}`),
      ...refused(load({ ascii: name }), `ascii ${label}`),
      ...refused(load({ keys: name }), `keys ${label}`),
      ...refused(load(name), `content ${label}`),
      ...refused(load(JSON.stringify(name)), `a JSON string ${label}`),
      ...refused(load("{}", { stat: () => { throw Object.assign(new Error(name), { code: name }); } }), `stat error ${label}`),
      ...refused(load("{}", { read: () => { throw Object.assign(new Error(name), { code: name }); } }), `read error ${label}`),
      // The program's own table is trusted, and still an id of it that is not plain is not echoed.
      ...effectiveConfig({ keys: { [name]: [name], north: [name, name], south: ["x", name] } }, table(name)).problems,
      ...effectiveConfig({}, table(name)).problems,
    ];
    assert.ok(lines.length >= 16, label);
    // A lone space is in every line; every other name here must be in none.
    for (const produced of lines) if (name !== " ") assert.equal(produced.includes(name), false, `${label} in: ${produced.slice(0, 200)}`);
    // In the path the rule is the path's: a space and 41 characters are plain there.
    const inPath = refused(load({ theme: 1 }, { env: { OATS_HOME_DIR: `/cfg/${name}` } }), `path ${label}`);
    if (!PRINTABLE.test(name) || name.length > 200) assert.deepEqual(inPath, [line("unknown setting theme; the settings are keys, ascii and open", "its configuration file")], label);
    const inMove = fakeMove({ env: { OATS_HOME_DIR: `/o/${name}`, XDG_CONFIG_HOME: `/x/${name}` }, rename() { throw failing(name, name); } }).lines;
    if (!PRINTABLE.test(name) || name.length > 200) assert.deepEqual(inMove, [cannotMove("it failed", "its old configuration file", "its configuration file")], `move ${label}`);
    all.push(...lines, ...inPath, ...inMove);
  }
  assert.ok(all.length > 300, `${all.length} lines`);
  for (const produced of all) assert.match(produced, PRINTABLE);
});

test("the path is echoed only when it is printable ASCII of at most 200 characters; otherwise the line says its configuration file", () => {
  const withHome = (own) => load({ theme: 1 }, { env: { OATS_HOME_DIR: own } }).lines;
  const clause = "unknown setting theme; the settings are keys, ascii and open";
  assert.deepEqual(withHome("/my config"), [line(clause, path.join("/my config", "config", "tui.json"))], "a space is printable");
  for (const xdg of ["/cfg/\x1b[2J", "/cfg/a\nb", "/cfg/é", "/cfg/日本", "/cfg/a\tb", "/cfg/\x7f", "/cfg/\u009b"]) {
    assert.deepEqual(withHome(xdg), [line(clause, "its configuration file")], JSON.stringify(xdg));
  }
  const tail = path.join("x", "config", "tui.json").length - 1; // what configPath adds after the home's last character
  const fits = `/${"d".repeat(200 - 1 - tail)}`;
  assert.equal(configPath({ OATS_HOME_DIR: fits }, "/h").length, 200);
  assert.deepEqual(withHome(fits), [line(clause, configPath({ OATS_HOME_DIR: fits }, "/h"))]);
  assert.deepEqual(withHome(`${fits}d`), [line(clause, "its configuration file")], "201 characters");
  assert.equal(load({}, { env: { OATS_HOME_DIR: "/cfg/\x1b[2J" } }).path, path.join("/cfg/\x1b[2J", "config", "tui.json"), "the path answered is the real one: it is for opening, not for printing");
});

// --- Real files -------------------------------------------------------------------

test("on disk: no file is the defaults, a file is read, and what it says is used", () => {
  const { env, home, file } = onDisk();
  assert.deepEqual(loadConfig({ env, home, platform: "linux" }), { ok: true, actions: ACTIONS, ascii: false, detachKey: LEADER, path: file });
  assert.equal(loadConfig({ env, home }).actions, ACTIONS);
  fs.writeFileSync(file, JSON.stringify({ keys: { quit: ["q"], refresh: ["r", "f5"], suspend: [] }, ascii: true }));
  const loaded = loadConfig({ env, home });
  assert.deepEqual([loaded.ok, loaded.ascii, loaded.path], [true, true, file]);
  assert.deepEqual(keysOf(loaded.actions), { ...DEFAULT_KEYS, quit: ["q"], refresh: ["r", "f5"], suspend: [] });
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [line("it is not valid JSON", file)] });
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "the file is never written");
});

test("on disk: with no config directory at all, or a config home that is not a directory, there is no file", () => {
  const missing = path.join(dir, "no-such-home");
  assert.deepEqual(loadConfig({ env: { OATS_HOME_DIR: missing }, home: "/nonexistent", platform: "linux" }), { ok: true, actions: ACTIONS, ascii: false, detachKey: LEADER, path: path.join(missing, "config", "tui.json") });
  assert.deepEqual(loadConfig({ env: {}, home: missing, platform: "darwin" }), { ok: true, actions: ACTIONS, ascii: false, detachKey: LEADER, path: path.join(missing, ".oats", "config", "tui.json") });
  assert.equal(fs.existsSync(missing), false, "and nothing is made where nothing is moved");
  const notADirectory = path.join(dir, "a-file");
  fs.writeFileSync(notADirectory, "");
  assert.equal(loadConfig({ env: { OATS_HOME_DIR: notADirectory }, home: "/nonexistent" }).ok, true, "as OATS_HOME_DIR=/dev/null");
});

test("on disk: a symbolic link to a regular file is read; a link to a directory, a directory and a FIFO are refused", (t) => {
  const linked = onDisk();
  const target = path.join(dir, "real-keys.json");
  fs.writeFileSync(target, JSON.stringify({ keys: { quit: ["x"] } }));
  fs.symlinkSync(target, linked.file);
  const loaded = loadConfig(linked);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.actions.find((action) => action.id === "quit").keys, ["x"]);
  assert.equal(loaded.path, linked.file, "the path is the link's");

  const twice = onDisk();
  fs.symlinkSync(linked.file, twice.file);
  assert.deepEqual(loadConfig(twice).actions.find((action) => action.id === "quit").keys, ["x"], "a link to a link to a file");

  const toDirectory = onDisk();
  fs.symlinkSync(dir, toDirectory.file);
  assert.deepEqual(loadConfig(toDirectory), { ok: false, lines: [line("it is not a regular file", toDirectory.file)] });

  const directory = onDisk();
  fs.mkdirSync(directory.file);
  assert.deepEqual(loadConfig(directory), { ok: false, lines: [line("it is not a regular file", directory.file)] });

  const dangling = onDisk();
  fs.symlinkSync(path.join(dir, "nothing-here"), dangling.file);
  assert.deepEqual(loadConfig({ ...dangling, platform: "linux" }), { ok: true, actions: ACTIONS, ascii: false, detachKey: LEADER, path: dangling.file }, "a link to nothing is no file");

  const loop = onDisk();
  fs.symlinkSync(loop.file, loop.file);
  assert.deepEqual(loadConfig(loop), { ok: false, lines: [line("it cannot be read (ELOOP)", loop.file)] });

  const fifo = onDisk();
  if (spawnSync("mkfifo", [fifo.file]).status !== 0) { t.diagnostic("no mkfifo here: the FIFO is not tried"); return; }
  assert.deepEqual(loadConfig(fifo), { ok: false, lines: [line("it is not a regular file", fifo.file)] }, "and it is not opened: opening a FIFO would wait for a writer");
});

test("on disk: a file exactly at the limit is read and one byte over is refused", () => {
  const { env, home, file } = onDisk();
  fs.writeFileSync(file, `{"ascii": true}${" ".repeat(CONFIG_LIMIT - 15)}`);
  assert.equal(fs.statSync(file).size, CONFIG_LIMIT);
  assert.equal(loadConfig({ env, home }).ascii, true);
  fs.appendFileSync(file, " ");
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [line("it is larger than 64 KiB", file)] });
});

test("on disk: a file that cannot be opened is refused with the code", (t) => {
  if (typeof process.getuid !== "function" || process.getuid() === 0) { t.skip("needs a user that a file mode can stop"); return; }
  const { env, home, file } = onDisk();
  fs.writeFileSync(file, "{}", { mode: 0o000 });
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [line("it cannot be read (EACCES)", file)] });
});

test("on disk: a file whose size says less than it holds is still never read past the limit", (t) => {
  // A file of /proc is regular and says size 0, whatever it holds.
  const endless = "/proc/kallsyms";
  let size = -1;
  try { if (fs.statSync(endless).isFile()) size = fs.statSync(endless).size; } catch { /* not this system */ }
  if (size !== 0) { t.skip(`no ${endless} that says size 0`); return; }
  const fd = fs.openSync(endless, "r"), probe = Buffer.alloc(CONFIG_LIMIT + 2);
  let held = 0, got = 0;
  try { while (held < probe.length && (got = fs.readSync(fd, probe, held, probe.length - held, null)) > 0) held += got; } finally { fs.closeSync(fd); }
  if (held <= CONFIG_LIMIT) { t.skip(`${endless} holds too little here`); return; }
  const { env, home, file } = onDisk();
  fs.symlinkSync(endless, file);
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [line("it is larger than 64 KiB", file)] });
});

// --- The move from the old path (awebai/oats#1390 §3) ------------------------------------
/** A fresh place on disk for the move: an OATS_HOME_DIR and an XDG_CONFIG_HOME of its own, with
 *  the directory the old file was in and nothing in it. `old` is the file the old rule found,
 *  `file` the one read now, `aside` what the old one is renamed to. */
function moving() {
  const root = path.join(dir, `move-${++homes}`);
  const env = { OATS_HOME_DIR: path.join(root, "oats"), XDG_CONFIG_HOME: path.join(root, "xdg") };
  const old = path.join(root, "xdg", "oats", "tui.json");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  return { env, home: path.join(root, "home"), root, old, file: path.join(root, "oats", "config", "tui.json"), aside: path.join(root, "xdg", "oats", MIGRATED) };
}
const cannotMove = (reason, old, file) => `oats: \`oats tui\` cannot move ${old} to ${file} (${reason}); move it yourself (E_TUI_CONFIG)`;
const bothThere = (old, file) => `oats: \`oats tui\`: ${old} is no longer read: the TUI reads ${file}. Copy what you need into ${file}, then remove ${old} (E_TUI_CONFIG)`;
const modeOf = (file) => fs.statSync(file).mode & 0o777;
const exists = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };

test("the move, old present and new absent: the old file's bytes are copied to the new path (mode 0600, the directories made 0700), the old file is renamed tui.json.migrated beside it, and the new one is read", () => {
  const { env, home, old, file, aside } = moving();
  const bytes = Buffer.from('{ "ascii": true,\n  "keys": { "quit": ["x"] } }\n');
  fs.writeFileSync(old, bytes, { mode: 0o644 });
  const loaded = loadConfig({ env, home, platform: "linux" });
  assert.deepEqual([loaded.ok, loaded.ascii, loaded.path], [true, true, file]);
  assert.deepEqual(loaded.actions.find((action) => action.id === "quit").keys, ["x"]);
  assert.deepEqual(fs.readFileSync(file), bytes, "byte for byte");
  assert.equal(fs.lstatSync(file).isFile(), true);
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
  assert.equal(modeOf(env.OATS_HOME_DIR), 0o700);
  assert.equal(exists(old), false);
  assert.deepEqual(fs.readFileSync(aside), bytes, "the old file is kept, renamed");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["tui.json"], "no file of its own is left behind");
  const again = loadConfig({ env, home, platform: "linux" });
  assert.deepEqual([again.ok, again.ascii], [true, true], "the next start reads the new file and moves nothing");
  assert.deepEqual(fs.readFileSync(aside), bytes);
});

test("the move copies bytes, not settings: an old file that is not valid JSON is moved, then refused against the new path", () => {
  const { env, home, old, file, aside } = moving();
  fs.writeFileSync(old, "{ not json");
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [line("it is not valid JSON", file)] });
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  assert.equal(fs.readFileSync(aside, "utf8"), "{ not json");
});

test("the move into an OATS home that exists already: only what is missing is made, and what is there keeps its mode", () => {
  const { env, home, old, file } = moving();
  fs.mkdirSync(env.OATS_HOME_DIR, { mode: 0o755 });
  fs.chmodSync(env.OATS_HOME_DIR, 0o755);
  fs.writeFileSync(old, "{}");
  assert.equal(loadConfig({ env, home }).ok, true);
  assert.equal(modeOf(env.OATS_HOME_DIR), 0o755);
  assert.equal(modeOf(path.dirname(file)), 0o700);
  assert.equal(modeOf(file), 0o600);
});

test("the move, both present: refused naming both, and neither is touched; a link to nothing at the new path is present too", () => {
  const { env, home, old, file, aside } = moving();
  fs.writeFileSync(old, '{"ascii": true}');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}");
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [bothThere(old, file)] });
  assert.equal(fs.readFileSync(old, "utf8"), '{"ascii": true}');
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
  assert.equal(exists(aside), false);
  fs.rmSync(file);
  fs.symlinkSync(path.join(dir, "nothing-here"), file);
  assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [bothThere(old, file)] });
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test("the move, old absent: the new file is read when it is there, and the defaults are used when neither is, with nothing made", () => {
  const { env, home, file } = moving();
  assert.deepEqual(loadConfig({ env, home, platform: "linux" }), { ok: true, actions: ACTIONS, ascii: false, detachKey: LEADER, path: file });
  assert.equal(exists(env.OATS_HOME_DIR), false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"ascii": true}');
  assert.equal(loadConfig({ env, home }).ascii, true);
});

test("the move, a rename that fails: the copy just made is deleted, the old file stays, and the move is refused", (t) => {
  if (typeof process.getuid !== "function" || process.getuid() === 0) { t.skip("needs a user that a directory's mode can stop"); return; }
  const { env, home, old, file, aside } = moving();
  fs.writeFileSync(old, '{"ascii": true}');
  fs.chmodSync(path.dirname(old), 0o500);
  try {
    assert.deepEqual(loadConfig({ env, home }), { ok: false, lines: [cannotMove("EACCES", old, file)] });
  } finally { fs.chmodSync(path.dirname(old), 0o700); }
  assert.equal(exists(file), false, "the copy is deleted");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [], "and no file of its own is left");
  assert.equal(fs.readFileSync(old, "utf8"), '{"ascii": true}');
  assert.equal(exists(aside), false);
});

test("the move into an OATS home whose config is a file: refused, the old file kept, and the defaults never used", () => {
  const { env, home, old, file, aside } = moving();
  fs.mkdirSync(env.OATS_HOME_DIR);
  fs.writeFileSync(path.join(env.OATS_HOME_DIR, "config"), "");
  fs.writeFileSync(old, '{"ascii": true, "keys": {"quit": ["x"]}}');
  const loaded = loadConfig({ env, home });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.lines.length, 1);
  assert.ok(["EEXIST", "ENOTDIR"].some((code) => loaded.lines[0] === cannotMove(code, old, file)), loaded.lines[0]);
  assert.equal(fs.readFileSync(old, "utf8"), '{"ascii": true, "keys": {"quit": ["x"]}}');
  assert.equal(exists(aside), false);
});

/** node:fs's link(2) replaced by `link` while `run` runs (config.mjs's imports follow it), each
 *  start's own file a name of its own. */
function withLink(link, run) {
  const native = fs.linkSync, now = Date.now;
  let ticks = now();
  try {
    Date.now = () => ++ticks;
    fs.linkSync = (from, to) => link(from, to, native);
    syncBuiltinESMExports();
    return run();
  } finally {
    fs.linkSync = native;
    Date.now = now;
    syncBuiltinESMExports();
  }
}
/** Two starts at once on real files: `first` is started, and `second` is run whole at the
 *  instant the first links its copy into place. Answers both starts' answers. */
function twoStarts(first, second) {
  let nested = 0, inner;
  return withLink((from, to, native) => {
    if (to === configPath(first.env, first.home) && nested === 0) { nested += 1; inner = loadConfig(second); }
    return native(from, to);
  }, () => {
    const outer = loadConfig(first);
    assert.equal(nested, 1, "exactly one start ran inside the first");
    return { outer, inner };
  });
}
const quitOf = (loaded) => loaded.actions.find((action) => action.id === "quit").keys;

test("the move, two starts at once moving the same old file: one moves it, the other reads what it moved once it is moved, and nothing is lost", () => {
  const { env, home, old, file, aside } = moving();
  const bytes = '{"ascii": true, "keys": {"quit": ["x"]}}';
  fs.writeFileSync(old, bytes);
  const { outer, inner } = twoStarts({ env, home }, { env, home });
  assert.deepEqual([inner.ok, inner.ascii, quitOf(inner)], [true, true, ["x"]], "the start that moved it");
  assert.deepEqual([outer.ok, outer.ascii, quitOf(outer)], [true, true, ["x"]], "the start that found it moved");
  assert.equal(fs.readFileSync(file, "utf8"), bytes, "the new file stays, with the old file's bytes");
  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.readFileSync(aside, "utf8"), bytes);
  assert.equal(exists(old), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["tui.json"], "no file of its own is left behind");
  assert.equal(loadConfig({ env, home }).ascii, true, "and the next start reads it");
});

test("the move, two starts at once with one OATS home and two XDG_CONFIG_HOMEs: the new file is never written over; the start that finds another's beside its own old file refuses as for both", () => {
  const { env, home, root, file } = moving();
  const ownXdg = (name, bytes) => {
    const xdg = path.join(root, name), old = path.join(xdg, "oats", "tui.json");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, bytes);
    return { env: { ...env, XDG_CONFIG_HOME: xdg }, home, old };
  };
  const first = ownXdg("xdg-first", '{"ascii": true, "keys": {"quit": ["x"]}}'), second = ownXdg("xdg-second", '{"keys": {"quit": ["f11"]}}');
  const { outer, inner } = twoStarts(first, second);
  assert.deepEqual([inner.ok, inner.ascii, quitOf(inner)], [true, false, ["f11"]], "the start that placed the file");
  assert.deepEqual(outer, { ok: false, lines: [bothThere(first.old, file)] }, "the other refuses, its settings never written over the first's");
  assert.equal(fs.readFileSync(file, "utf8"), '{"keys": {"quit": ["f11"]}}');
  assert.equal(fs.readFileSync(first.old, "utf8"), '{"ascii": true, "keys": {"quit": ["x"]}}', "the refused start's old file kept");
  assert.equal(exists(second.old), false);
  assert.deepEqual(quitOf(loadConfig(second)), ["f11"], "the next start of the one that moved it reads its own settings");
  assert.deepEqual(loadConfig(first), { ok: false, lines: [bothThere(first.old, file)] });
});

test("the move on a file system without hard links is refused, saying so, and nothing is touched: there the file cannot be put in place whole and never over another", () => {
  for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
    const { env, home, old, file, aside } = moving();
    fs.writeFileSync(old, '{"ascii": true}');
    const loaded = withLink(() => { throw Object.assign(new Error("links unsupported"), { code }); }, () => loadConfig({ env, home }));
    assert.deepEqual(loaded, { ok: false, lines: [cannotMove("this file system has no hard links", old, file)] }, code);
    assert.equal(fs.readFileSync(old, "utf8"), '{"ascii": true}', `${code}: the old file kept`);
    assert.equal(exists(file), false, `${code}: no new file`);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [], `${code}: and no file of its own left`);
    assert.equal(exists(aside), false);
  }
  // Another refusal of the link is said by its code.
  const { env, home, old, file } = moving();
  fs.writeFileSync(old, "{}");
  assert.deepEqual(withLink(() => { throw Object.assign(new Error("no"), { code: "EACCES" }); }, () => loadConfig({ env, home })), { ok: false, lines: [cannotMove("EACCES", old, file)] });
  assert.equal(exists(file), false);
});

test("the move, a link as the old file: what it points at is copied, the link itself is renamed, and its target is untouched", () => {
  const { env, home, root, old, file, aside } = moving();
  const target = path.join(root, "dotfiles", "tui.json");
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, '{"ascii": true}');
  fs.symlinkSync(target, old);
  assert.equal(loadConfig({ env, home }).ascii, true);
  assert.equal(fs.lstatSync(file).isFile(), true, "the new file is a file, not a link");
  assert.equal(fs.readFileSync(file, "utf8"), '{"ascii": true}');
  assert.equal(fs.lstatSync(aside).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(aside), target);
  assert.equal(fs.readFileSync(target, "utf8"), '{"ascii": true}');
  assert.equal(exists(old), false);
});

test("the move refuses what it cannot copy, and touches nothing: a link to nothing, a directory, a file over the limit, a backup already there", () => {
  const dangling = moving();
  fs.symlinkSync(path.join(dir, "nothing-here"), dangling.old);
  assert.deepEqual(loadConfig(dangling), { ok: false, lines: [cannotMove("it is a link to nothing", dangling.old, dangling.file)] }, "reported, not guessed at");
  assert.equal(fs.lstatSync(dangling.old).isSymbolicLink(), true);
  assert.equal(exists(dangling.env.OATS_HOME_DIR), false);

  const directory = moving();
  fs.mkdirSync(directory.old);
  assert.deepEqual(loadConfig(directory), { ok: false, lines: [cannotMove("it is not a regular file", directory.old, directory.file)] });
  assert.equal(exists(directory.env.OATS_HOME_DIR), false);

  const large = moving();
  fs.writeFileSync(large.old, " ".repeat(CONFIG_LIMIT + 1));
  assert.deepEqual(loadConfig(large), { ok: false, lines: [cannotMove("it is larger than 64 KiB", large.old, large.file)] });
  assert.equal(exists(large.env.OATS_HOME_DIR), false);

  const backup = moving();
  fs.writeFileSync(backup.old, '{"ascii": true}');
  fs.writeFileSync(backup.aside, "an earlier move");
  assert.deepEqual(loadConfig(backup), { ok: false, lines: [cannotMove(`${MIGRATED} is there already`, backup.old, backup.file)] }, "a backup is never written over");
  assert.equal(fs.readFileSync(backup.aside, "utf8"), "an earlier move");
  assert.equal(fs.readFileSync(backup.old, "utf8"), '{"ascii": true}');
  assert.equal(exists(backup.env.OATS_HOME_DIR), false);
});

test("the move's two paths: from $XDG_CONFIG_HOME/oats when that is absolute, else <home>/.config/oats (a relative XDG_CONFIG_HOME is ignored); to $OATS_HOME_DIR/config, else <home>/.oats/config", () => {
  const { root } = moving();
  const home = path.join(root, "home");
  const homeOld = path.join(home, ".config", "oats", "tui.json");
  fs.mkdirSync(path.dirname(homeOld), { recursive: true });
  fs.writeFileSync(homeOld, '{"ascii": true}');

  const absolute = { XDG_CONFIG_HOME: path.join(root, "xdg"), OATS_HOME_DIR: path.join(root, "own") };
  fs.writeFileSync(path.join(root, "xdg", "oats", "tui.json"), "{}");
  assert.equal(loadConfig({ env: absolute, home }).ascii, false, "the file under XDG_CONFIG_HOME is moved");
  assert.equal(fs.readFileSync(path.join(root, "own", "config", "tui.json"), "utf8"), "{}");
  assert.equal(fs.readFileSync(homeOld, "utf8"), '{"ascii": true}', "and the one in the home is not looked at");

  const relative = { XDG_CONFIG_HOME: "xdg" };
  assert.equal(loadConfig({ env: relative, home }).ascii, true, "a relative XDG_CONFIG_HOME is ignored: the home's file is moved");
  assert.equal(fs.readFileSync(path.join(home, ".oats", "config", "tui.json"), "utf8"), '{"ascii": true}', "to <home>/.oats/config: OATS_HOME_DIR is not set");
  assert.equal(exists(homeOld), false);
  assert.equal(fs.readFileSync(path.join(home, ".config", "oats", MIGRATED), "utf8"), '{"ascii": true}');
});

/** loadConfig over a file system that exists only here, for the move: `there` gives each path's
 *  entry ({ ino }, an error to throw, or a function answering one of those each time it is
 *  looked at); the old file is there unless `there` says otherwise. `rename` and `place`, when
 *  given, replace what those do. `calls` records every call. */
function fakeMove({ there = {}, rename, place, stat, env = { OATS_HOME_DIR: "/o", XDG_CONFIG_HOME: "/x" } } = {}) {
  const OLD = oldConfigPath(env, "/h"), NEW = configPath(env, "/h"), bytes = Buffer.from('{"ascii": true}');
  const calls = [];
  const entries = new Map(Object.entries({ [OLD]: { ino: 1 }, ...there }));
  const io = {
    entry(file) {
      calls.push(["entry", file]);
      const value = entries.get(file), entry = typeof value === "function" ? value() : value;
      if (entry instanceof Error) throw entry;
      return entry ?? null;
    },
    stat(file) { calls.push(["stat", file]); return stat ? stat(file) : { file: true, size: bytes.length }; },
    bytes(file) { calls.push(["bytes", file]); return bytes; },
    read(file) { calls.push(["read", file]); return bytes.toString("utf8"); },
    place(given, file) { calls.push(["place", file]); if (place) return place(given, file, entries); entries.set(file, { ino: 7 }); return { ino: 7 }; },
    rename(from, to) { calls.push(["rename", from, to]); if (rename) return rename(from, to, entries); entries.set(to, entries.get(from)); entries.delete(from); },
    remove(file) { calls.push(["remove", file]); entries.delete(file); },
  };
  return { ...loadConfig({ env, home: "/h", io, platform: "linux" }), calls, OLD, NEW };
}
const failing = (code, message = "it failed here") => Object.assign(new Error(message), code === undefined ? {} : { code });
const named = (calls, name) => calls.filter((call) => call[0] === name);

test("the move, a rename that fails: the copy is deleted only while it is still the one this run made", () => {
  const ours = fakeMove({ rename() { throw failing("EXDEV"); } });
  assert.deepEqual(ours.lines, [cannotMove("EXDEV", ours.OLD, ours.NEW)]);
  assert.deepEqual(named(ours.calls, "remove"), [["remove", ours.NEW]]);
  assert.deepEqual(named(ours.calls, "read"), [], "and nothing is read");

  const replaced = fakeMove({ rename(from, to, entries) { entries.set("/o/config/tui.json", { ino: 8 }); throw failing("EXDEV"); } });
  assert.deepEqual(replaced.lines, [cannotMove("EXDEV", replaced.OLD, replaced.NEW)]);
  assert.deepEqual(named(replaced.calls, "remove"), [], "a file put there since is not this run's to delete");

  // Another run moved the old file meanwhile: the new file is read, this run's copy or the other's.
  const movedMeanwhile = fakeMove({ rename(from, to, entries) { entries.delete(from); throw failing("ENOENT"); } });
  assert.equal(movedMeanwhile.ok, true);
  assert.deepEqual(named(movedMeanwhile.calls, "remove"), []);
  assert.deepEqual(named(movedMeanwhile.calls, "read"), [["read", movedMeanwhile.NEW]]);
});

test("the move, a run that loses the race to another starting asks the table again: it reads the file that run placed once that run moved the old file, and refuses as for both while an old file is there", () => {
  const placedFirst = fakeMove({ place(given, file, entries) { entries.set(file, { ino: 9 }); entries.delete("/x/oats/tui.json"); return { ino: 7, taken: true }; } });
  assert.equal(placedFirst.ok, true);
  assert.equal(placedFirst.ascii, true);
  assert.deepEqual(named(placedFirst.calls, "rename"), []);
  assert.deepEqual(named(placedFirst.calls, "read"), [["read", placedFirst.NEW]]);
  const oldStill = fakeMove({ place(given, file, entries) { entries.set(file, { ino: 9 }); return { ino: 7, taken: true }; } });
  assert.deepEqual(oldStill.lines, [bothThere(oldStill.OLD, oldStill.NEW)], "this run's old file beside the new one is both: never another's settings read in its place");
  assert.deepEqual(named(oldStill.calls, "rename"), []);
  const goneAgain = fakeMove({ place() { return { ino: 7, taken: true }; } });
  assert.deepEqual(goneAgain.lines, [cannotMove("EEXIST", goneAgain.OLD, goneAgain.NEW)], "an entry that was there and is gone again is no file to read");
  // An EEXIST thrown on the way (a directory that is a file, its own file's name taken) is no race.
  const thrown = fakeMove({ place() { throw failing("EEXIST"); } });
  assert.deepEqual(thrown.lines, [cannotMove("EEXIST", thrown.OLD, thrown.NEW)]);
  assert.deepEqual(named(thrown.calls, "read"), []);

  // The other run placed the new file and renamed the old one between this run's looks.
  const afterFirstLook = (first, then) => { let looks = 0; return () => (looks++ === 0 ? first : then); };
  const backupMade = fakeMove({ there: { "/x/oats/tui.json": afterFirstLook({ ino: 1 }, null), "/o/config/tui.json": afterFirstLook(null, { ino: 9 }), [path.join("/x/oats", MIGRATED)]: { ino: 1 } } });
  assert.equal(backupMade.ok, true, "its backup found");
  assert.deepEqual(named(backupMade.calls, "place"), []);
  const oldGone = fakeMove({ there: { "/x/oats/tui.json": afterFirstLook({ ino: 1 }, null), "/o/config/tui.json": afterFirstLook(null, { ino: 9 }) }, stat: (file) => (file === "/x/oats/tui.json" ? null : { file: true, size: 15 }) });
  assert.equal(oldGone.ok, true, "the old file gone");
  assert.deepEqual(named(oldGone.calls, "place"), []);
  const aBackupOfItsOwn = fakeMove({ there: { "/o/config/tui.json": afterFirstLook(null, { ino: 9 }), [path.join("/x/oats", MIGRATED)]: { ino: 1 } } });
  assert.deepEqual(aBackupOfItsOwn.lines, [bothThere(aBackupOfItsOwn.OLD, aBackupOfItsOwn.NEW)], "a new file placed meanwhile beside this run's old file is both");
});

test("the move's other failures refuse with the code of the error and never its text, before anything is changed when they come first", () => {
  const look = fakeMove({ there: { "/x/oats/tui.json": failing("EACCES") } });
  assert.deepEqual(look.lines, [cannotMove("EACCES", look.OLD, look.NEW)]);
  const lookNew = fakeMove({ there: { "/o/config/tui.json": failing("ELOOP") } });
  assert.deepEqual(lookNew.lines, [cannotMove("ELOOP", lookNew.OLD, lookNew.NEW)]);
  const full = fakeMove({ place() { throw failing("ENOSPC"); } });
  assert.deepEqual(full.lines, [cannotMove("ENOSPC", full.OLD, full.NEW)]);
  assert.deepEqual(named(full.calls, "rename"), []);
  for (const error of [failing(undefined, "\x1b[2J secret"), failing("not a code \x1b[2J"), "a string"]) {
    const moved = fakeMove({ rename() { throw error; } });
    assert.deepEqual(moved.lines, [cannotMove("it failed", moved.OLD, moved.NEW)]);
  }
});

test("the move's lines echo a path only when it is printable ASCII of at most 200 characters", () => {
  const hostile = fakeMove({ env: { OATS_HOME_DIR: "/o\x1b[2J", XDG_CONFIG_HOME: "/x‮" }, rename() { throw failing("EXDEV"); } });
  assert.deepEqual(hostile.lines, [cannotMove("EXDEV", "its old configuration file", "its configuration file")]);
  const both = fakeMove({ env: { OATS_HOME_DIR: `/${"d".repeat(300)}`, XDG_CONFIG_HOME: "/x" }, there: { [configPath({ OATS_HOME_DIR: `/${"d".repeat(300)}` }, "/h")]: { ino: 2 } } });
  assert.deepEqual(both.lines, [bothThere("/x/oats/tui.json", "its configuration file")]);
  for (const text of [...hostile.lines, ...both.lines]) assert.match(text, PRINTABLE);
});

// --- open.detachKey ---------------------------------------------------------------

test("open.detachKey is the back key, the key that takes the focus from an agent's terminal back to the list: any key of the TUI's own grammar, C-\\ and M-o (the defaults before C-x) on every platform among them, and a file without it has the default, C-x on every platform", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const key of ["F12", "C-]", "M-x", "S-F5", "C-\\", "M-o", "C-x", "C-a", "M-0", "C-F1"]) {
      const loaded = load({ open: { detachKey: key } }, { platform });
      assert.equal(loaded.ok, true, key);
      assert.equal(loaded.detachKey, key, `${key} on ${platform}`);
    }
  }
  assert.equal(load({ open: {} }).detachKey, LEADER, "an open object that names no key");
  assert.equal(load({ keys: { quit: ["q"] }, ascii: true }).detachKey, LEADER, "a file that names no key: the platform's default");
  assert.equal(load({ keys: { quit: ["q"] }, ascii: true }, { platform: "darwin" }).detachKey, LEADER, "and on macOS the same");
  const all = load({ keys: { open: ["o"] }, ascii: true, open: { detachKey: "F12" } });
  assert.deepEqual([all.ok, all.ascii, all.detachKey, bindings(all.actions).get("o")], [true, true, "F12", "open"]);
});

test("refused when the file is read, naming it: an open.detachKey outside the TUI's grammar (term/through.mjs pins the set), an unknown member of open, and an open that is not an object", () => {
  const rule = `open.detachKey must be one key: ${BACK_KEY_RULE}`;
  for (const key of ["", "not a key at all", "x".repeat(17), "C-m", "C-h", "C-i", "Escape", "M-[", "F13", "C-\u00e9", "C-\n", "\u001b[A", "-", "--detach-key", " ", " F12", "F12 ", 12, null, true, ["F12"], { key: "F12" }]) {
    assert.deepEqual(load({ open: { detachKey: key } }).lines, [line(rule)], JSON.stringify(key));
  }
  assert.deepEqual(load({ open: { detachKey: "F12", command: "x" } }).lines, [line("unknown member command of open; open has detachKey")]);
  assert.deepEqual(load({ open: { "\u001b": 1 } }).lines, [line("a member of open whose name cannot be shown is unknown; open has detachKey")]);
  for (const open of ["F12", [], null, 1, true]) assert.deepEqual(load({ open }).lines, [line('open must be an object, like {"detachKey": "F12"}')], JSON.stringify(open));
  // A refusal of open is a refusal of the file's shape: one line, before anything about its keys.
  assert.deepEqual(load({ keys: { nope: ["x"] }, open: { detachKey: "-x" } }).lines, [line(rule)]);
});

test("open.detachKey is the leader, read as a key wherever the TUI reads keys: a leader an action's key already is is refused, naming both, and one whose action was given another key is not (docs/tui.md, \"The leader\")", () => {
  const taken = (key, as, id, which = `open.detachKey ${key}`) => line(`${which} is read as ${as}, the key of ${id}; give the leader a key no action has, or give ${id} another`);
  for (const [key, as, id] of [["C-l", "Ctrl+L", "redraw"], ["C-k", "Ctrl+K", "palette"], ["C-j", "Enter", "open"], ["C-c", "Ctrl+C", "quit"], ["C-z", "Ctrl+Z", "suspend"]]) {
    assert.deepEqual(load({ open: { detachKey: key } }).lines, [taken(key, as, id)], key);
  }
  // A key the file gives an action is that action's: the leader may not be it.
  assert.deepEqual(load({ keys: { help: ["f12"] }, open: { detachKey: "F12" } }).lines, [taken("F12", "F12", "help")]);
  // Moved away, the key is free for the leader.
  const freed = load({ keys: { redraw: ["f5"] }, open: { detachKey: "C-l" } });
  assert.deepEqual([freed.ok, freed.detachKey, bindings(freed.actions).get("ctrl+l"), bindings(freed.actions).get("f5")], [true, "C-l", undefined, "redraw"]);
  // The default leader is no action's key, on any platform: C-x reads as Ctrl+X.
  for (const platform of ["linux", "win32", "darwin"]) assert.equal(load({}, { platform }).ok, true, platform);
  assert.equal(ACTIONS.some((action) => action.keys.includes("ctrl+x")), false);
  // A file that gives an action the default leader's key is refused on every platform, and told it
  // is the default: the file names no open.detachKey.
  for (const platform of ["linux", "win32", "darwin"]) {
    assert.deepEqual(load({ keys: { help: ["ctrl+x"] } }, { platform }).lines, [taken("C-x", "Ctrl+X", "help", "the default leader C-x")], platform);
  }
  // Alt+O, the default before C-x, is a key an action may have, unless the file makes it the leader.
  for (const platform of ["linux", "darwin"]) assert.equal(load({ keys: { help: ["alt+o"] } }, { platform }).ok, true, `${platform}: alt+o is help's`);
  assert.deepEqual(load({ keys: { help: ["alt+o"] }, open: { detachKey: "M-o" } }).lines, [taken("M-o", "Alt+O", "help")]);
  assert.equal(load({ keys: { help: ["ctrl+x"] }, open: { detachKey: "M-o" } }).ok, true, "and ctrl+x is free for an action when the file names another leader");
});

test("a file that names open-workspace, the action's name before it became open, is refused with the name it has now", () => {
  assert.deepEqual(load({ keys: { "open-workspace": ["o"] } }).lines, [line("open-workspace is called open now; rename it")]);
  assert.deepEqual(load({ keys: { "open-workspace": [] } }).lines, [line("open-workspace is called open now; rename it")]);
  assert.equal(load({ keys: { open: ["o"] } }).ok, true);
  // Against a table that has no open, the old name is just unknown.
  assert.deepEqual(effectiveConfig({ keys: { "open-workspace": ["o"] } }, Object.freeze([{ id: "a", keys: ["x"], label: "A" }])), { ok: false, problems: ["unknown action open-workspace; the actions are a"] });
});

// --- keys.json: the chord family (docs/tui.md, "Switch family") ---------

const KEYS_FILE = "/cfg/config/keys.json";
/** loadKeys over a keys.json that exists only here: `content` its text (a value is written as JSON),
 *  or `stat`/`keys` in place of the file system's own. `calls` records what was asked of it. */
function keysLoad(content, { stat, keys, env = { OATS_HOME_DIR: "/cfg" }, home = "/home/u" } = {}) {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  const calls = [];
  const io = {
    stat(file) { calls.push(["stat", file]); return stat ? stat(file) : { file: true, size: Buffer.byteLength(text) }; },
    keys(file) { calls.push(["keys", file]); return keys ? keys(file) : text; },
  };
  return { read: loadKeys({ env, home, io }), calls };
}
const family = (read) => ({ family: read.family, why: read.why });

test("keys.json is config/keys.json beside tui.json, resolved the same way, and loadKeys reads that path", () => {
  assert.equal(keysPath({ OATS_HOME_DIR: "/x/oats" }, "/home/u"), path.join("/x/oats", "config", "keys.json"));
  assert.equal(keysPath({}, "/home/u"), path.join("/home/u", ".oats", "config", "keys.json"));
  assert.equal(path.dirname(keysPath({ OATS_HOME_DIR: "/x" }, "/h")), path.dirname(configPath({ OATS_HOME_DIR: "/x" }, "/h")));
  assert.deepEqual(keysLoad({ chords: "ctrl+shift" }).calls, [["stat", KEYS_FILE], ["keys", KEYS_FILE]]);
  assert.deepEqual(keysLoad({}, { env: {}, home: "/home/u" }).calls[0], ["stat", path.join("/home/u", ".oats", "config", "keys.json")]);
});

test("keys.json: a good file chooses the family; missing, unreadable (EACCES), not a regular file, bad JSON, a missing key and an unknown value are all Alt, the default, each with why, and none is an error; a Ctrl+Alt written is a choice, and kept", () => {
  assert.deepEqual(family(keysLoad({ chords: "ctrl+shift" }).read), { family: "ctrl+shift", why: null });
  assert.deepEqual(family(keysLoad({ chords: "ctrl+alt", later: { kept: true } }).read), { family: "ctrl+alt", why: null }, "Ctrl+Alt chosen, kept now that the default is Alt; another key is a later client's, and ignored");
  assert.deepEqual(family(keysLoad({ chords: "alt" }).read), { family: "alt", why: null });
  assert.equal(Object.isFrozen(keysLoad({ chords: "ctrl+shift" }).read), true);
  const none = keysLoad({}, { stat: () => null });
  assert.deepEqual(family(none.read), { family: "alt", why: "missing" });
  assert.deepEqual(none.calls.map(([what]) => what), ["stat"], "no file: nothing is read");
  assert.equal(chordFamilyNote(none.read), null, "no file: nothing to say");
  const eacces = () => { throw Object.assign(new Error("permission denied, open '/cfg/config/keys.json'"), { code: "EACCES" }); };
  for (const [name, options, why] of [
    ["the read refused (EACCES)", { keys: eacces }, "unreadable"],
    ["the stat refused (EACCES)", { stat: eacces }, "unreadable"],
    ["a directory", { stat: () => ({ file: false, size: 4096 }) }, "unreadable"],
    ["a thrown nothing", { keys: () => { throw undefined; } }, "unreadable"],
  ]) {
    const got = keysLoad({}, options);
    assert.deepEqual(family(got.read), { family: "alt", why }, name);
    assert.equal(chordFamilyNote(got.read), "keys.json cannot be read, using Alt", name);
  }
  assert.deepEqual(keysLoad({}, { stat: () => ({ file: false, size: 0 }) }).calls.map(([what]) => what), ["stat"], "what is no regular file is never opened (a FIFO would hold the start)");
  for (const [content, why, note] of [
    ["{", "not-json", "keys.json is not JSON, using Alt"],
    ["[]", "not-object", "keys.json is not an object, using Alt"],
    [{}, "no-chords", "keys.json names no chords, using Alt"],
    [{ chords: "ctrl+meta" }, "unknown-chords", "keys.json: unknown chords value, using Alt"],
    [{ chords: "CTRL+SHIFT" }, "unknown-chords", "keys.json: unknown chords value, using Alt"],
    ["x".repeat(KEYS_LIMIT + 1), "too-large", "keys.json is too large, using Alt"],
  ]) {
    const got = keysLoad(content);
    assert.deepEqual(family(got.read), { family: "alt", why }, JSON.stringify(content).slice(0, 40));
    assert.equal(chordFamilyNote(got.read), note);
  }
});

test("on disk: keys.json is read from the OATS home given, never past the limit, and every failure is the default", (t) => {
  const { env, home } = onDisk();
  const file = keysPath(env, home);
  assert.deepEqual(family(loadKeys({ env, home })), { family: "alt", why: "missing" }, "no file");
  fs.writeFileSync(file, '{ "chords": "ctrl+shift" }\n');
  assert.deepEqual(family(loadKeys({ env, home })), { family: "ctrl+shift", why: null });
  fs.writeFileSync(file, '{ "chords": "ctrl+shift"');
  assert.deepEqual(family(loadKeys({ env, home })), { family: "alt", why: "not-json" });
  // Over the limit, in characters that take two bytes each: a part of it is never read as the whole.
  fs.writeFileSync(file, `{ "chords": "ctrl+shift", "pad": "${"é".repeat(KEYS_LIMIT)}" }`);
  assert.deepEqual(family(loadKeys({ env, home })), { family: "alt", why: "too-large" });
  fs.writeFileSync(file, `{ "chords": "ctrl+shift", "pad": "${"x".repeat(KEYS_LIMIT - 40)}" }`);
  assert.ok(fs.statSync(file).size <= KEYS_LIMIT);
  assert.deepEqual(family(loadKeys({ env, home })), { family: "ctrl+shift", why: null }, "a file within the limit is read");
  // The bytes as the shared reader decodes them, the Desktop's too (packages/desktop/test/chord-family-main.test.mjs
  // has the same two files): a byte-order mark is no text, and a byte that is not UTF-8 makes the file none.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "chords": "ctrl+shift" }')]));
  assert.deepEqual(family(loadKeys({ env, home })), { family: "ctrl+shift", why: null }, "a byte-order mark");
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{ "chords": "ctrl+shift", "x": "'), Buffer.from([0xc3]), Buffer.from('" }')]));
  assert.deepEqual(family(loadKeys({ env, home })), { family: "alt", why: "not-utf8" }, "not UTF-8, in a value nobody reads");
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepEqual(family(loadKeys({ env, home })), { family: "alt", why: "unreadable" }, "a directory");
  fs.rmdirSync(file);
  assert.deepEqual(family(loadKeys({ env: { OATS_HOME_DIR: "/dev/null" }, home })), { family: "alt", why: "missing" }, "an OATS home that is not a directory: no file");
  if (typeof process.getuid !== "function" || process.getuid() === 0) { t.skip("needs a user that a file mode can stop"); return; }
  fs.writeFileSync(file, '{ "chords": "ctrl+shift" }', { mode: 0o000 });
  assert.deepEqual(family(loadKeys({ env, home })), { family: "alt", why: "unreadable" }, "EACCES");
});
