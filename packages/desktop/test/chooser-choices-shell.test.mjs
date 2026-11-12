// A window with no workspace (#481) reads nothing, but its switcher's choices follow what main serves
// (#521): the shell's roster poll, while choosing, asks main for the choices and repaints the switcher.
// The shipped shell functions run in a vm.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { withShellWindowGlobals } from "./helpers/shell-window-globals.mjs";

const source = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
const fn = (name) => { const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`)); assert.ok(found, name); return found[0]; };
const REMOTE = [{ id: "ws:aaaaaaaaaaaaaaaaaaaa", name: "web", remote: true }];

function shell({ state = "choosing", choices = async () => REMOTE } = {}) {
  const c = {
    windowState: () => c.state, state, chose: [], reads: [],
    refreshChoices: async () => { c.asked = (c.asked ?? 0) + 1; return choices(); },
    workspaceLabel: { choose: (list) => c.chose.push(list), begin: () => () => true },
    contextRosterEl: {}, api: (path) => { c.reads.push(path); return new Promise(() => {}); },
  };
  const s = runInNewContext(`${["refreshChooserChoices", "refreshContextRoster"].map(fn).join("\n")}\n({ refreshContextRoster });`, withShellWindowGlobals(c));
  return { c, s };
}

test("a choosing window's roster poll repaints its switcher with main's current choices and reads nothing", async () => {
  const { c, s } = shell();
  await s.refreshContextRoster();
  assert.equal(c.asked, 1);
  assert.deepEqual(c.chose, [REMOTE], "the remote workspaces served since its first claim are choices now");
  assert.deepEqual(c.reads, [], "no workspace read");
});

test("no answer, a refusal, or a bind before the answer leaves the switcher as it is", async () => {
  const refused = shell({ choices: async () => null });
  await refused.s.refreshContextRoster();
  assert.deepEqual(refused.c.chose, []);
  let resolve; const late = shell({ choices: () => new Promise((r) => { resolve = r; }) });
  const polling = late.s.refreshContextRoster();
  late.c.state = "bound"; resolve(REMOTE); await polling;
  assert.deepEqual(late.c.chose, [], "bound meanwhile: its own roster read paints it");
});
