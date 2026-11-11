// Direct terminal jumps retain explicit content focus; restoration stays
// focus-neutral. The shipped-shell DOM/async ownership regressions live in
// selection-ownership.test.mjs, with lifecycle cleanup in terminal-tab.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { DEFAULT_KEYMAP } from "../renderer/keybindings.mjs";
import { fillEmptyGroup, requestSplit } from "../renderer/split-layout.mjs";
import { createSelectionOwnership } from "../renderer/selection-ownership.mjs";
import { canAddressRemote, rowReason } from "../../client/remote-address.mjs";
import { rowReasonLine, runtimeErrorLine } from "../renderer/speaker-line.mjs";
import { otherIncarnation, terminalOrigin } from "../renderer/retired-tabs.mjs";
import { MARKUP, CONTROL, DETAIL_WITHHELD, shown } from "./helpers/speaker-cases.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(PKG, f), "utf8");

test("selectTab carries explicit focusContent intent; activateTab remains restoration-only", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /function selectTab\(id, \{ focusContent = false, intent = tabOpenIntents\.begin\(\) \} = \{\}\)/,
    "focusContent defaults FALSE — side-effect activations must not steal focus");
  assert.match(src, /if \(focusContent\) tabs\.get\(id\)\?\.focusContent\?\.\(\);/,
    "content focus runs only on explicit user intent, after activation/onShow");
});

test("terminal tabs provide readiness-aware focusContent and fresh-open dedup focuses", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /focusContent: \(\) => tab\.focus\(\)/,
    "terminal tab requests readiness-aware input focus");
  assert.match(src, /focusOnActivate: focusContent/,
    "addTab dedup follows the opener focus option");
});

test("existing-terminal jumps focus input, fill an empty split without another attach, and ignore stale workspaces", async () => {
  const src = read("renderer/shell.mjs");
  // Exercise the actual shell flow without booting Electron. Do not pin its
  // formatting: adding the split transition must preserve the focus contract.
  const flow = src.match(/async function openTerminalTabFlow\(ref, notify, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(flow, "terminal open flow exists");
  for (const scenario of ["flat", "empty-split", "workspace-changed"]) {
    const initial = scenario === "flat" ? null : requestSplit(null, "row", [1, 2], 2).split;
    const activated = [];
    let workspace = "workspace-a";
    const context = {
      split: initial, connectionGeneration: 0, tabs: new Map([[1, { key: "other" }], [2, { key: "selected" }]]),
      setSidebarMode() {}, setNavActive() {}, refreshContextRoster() {},
      currentWorkspace: () => workspace, workspaceGeneration: () => 0,
      fillEmptyGroup,
      api: async () => ({ instances: [] }),
      resolveTerminalOpen: () => ({ inst: {}, key: "selected" }),
      whenKeyFree: async () => { if (scenario === "workspace-changed") workspace = "workspace-b"; },
      selectTab: (id, options) => activated.push({ id, focusContent: options.focusContent }),
      pendingTerms: new Set(), panelReads: 0, otherIncarnation, terminalOrigin,
      openTerminalTabInner: () => assert.fail("an existing tab must not attach again"),
    };
    context.tabOpenIntents = createSelectionOwnership(context);
    const run = runInNewContext(`(${flow})`, context);
    await run({}, () => assert.fail("existing terminal must resolve"));
    assert.deepEqual(activated, scenario === "workspace-changed" ? [] : [{ id: 2, focusContent: true }], scenario);
    if (scenario === "empty-split") {
      assert.deepEqual(context.split.groups.map((g) => g.tabs), [[1], [2]]);
    } else assert.equal(context.split, initial, "flat or stale layout stays unchanged");
  }
});

test("workspace-switch restoration does NOT steal focus (side-effect activation)", () => {
  const src = read("renderer/shell.mjs");
  const restore = src.match(/const restored = restoreTerminalTab[\s\S]*?activateTab\(restored\[0\]\)([^;]*)/);
  assert.ok(restore, "restoration path present");
  assert.ok(!/focusContent/.test(restore[1]), "restoration activates without focusContent");
});

test("terminal.focusActive is a registered rebindable action with NO default chord", () => {
  const src = read("renderer/shell.mjs");
  assert.match(src, /id: "terminal\.focusActive", label: [^,]+, context: "global"/,
    "editor-visible global action");
  assert.equal(DEFAULT_KEYMAP["terminal.focusActive"], undefined,
    "no default chord — Ctrl chords belong to the pty on Linux/Windows; bind in the editor");
  assert.match(src, /Terminal: focus the active terminal input/, "palette-discoverable");
  assert.match(src, /function focusActiveTerminal\(\)[\s\S]*?kind === "terminal"\) selectTab\(activeTab, \{ focusContent: true \}\)/,
    "focuses only when the active tab IS a terminal");
});

test("post-spawn auto-open is QUIET: openTerminalTab failures route through notify, never a bare alert (spawn-modal fix)", () => {
  const src = read("renderer/shell.mjs");
  // the quiet option exists and selects console.warn over alert()
  assert.match(src, /async function openTerminalTab\(ref, \{ quiet = false,[^\n]*\} = \{\}\)/,
    "openTerminalTab accepts a quiet option");
  assert.match(src, /const notify = onError \|\| \(quiet \? \(msg\) => console\.warn\(`\[terminal open\] \$\{msg\}`\) : \(msg\) => alert\(msg\)\);/,
    "quiet opens warn instead of blocking with alert");
  // the WHOLE open flow runs under runOpenFlow so quiet transport failures
  // (panel fetch, tab mount) can never escape as an unhandled rejection —
  // behavioral coverage lives in open-intent.test.mjs (review ff70e1c nit)
  // (#1246: the post-spawn open's `followed` rides in the same options object, and so may further
  // options of the flow, each a plain name: #1247's palette `refuse`.)
  assert.match(src, /return runOpenFlow\(\(\) => openTerminalTabFlow\(ref, notify, \{ inSplit, expected, valid, followed(?:, \w+)* \}\), \{ quiet, notify \}\);/,
    "quiet rejection containment wraps the whole flow via the importable runOpenFlow");
  assert.match(src, /import \{ createIntentGate, prepareOwnedOpen, runOpenFlow \} from "\.\/open-intent\.mjs";/,
    "shell imports runOpenFlow from the tested module");
  // ctx.openTerminal forwards opts so views can request the quiet handoff
  assert.match(src, /openTerminal: \(instance, opts\) => openTerminalTab\(instance, opts\)/,
    "shell ctx.openTerminal forwards the options seam");
  // both user-facing refusals inside the open path go through notify
  assert.match(src, /return notify\(r\.error === "ambiguous"/,
    "resolution refusals use notify");
  assert.match(src, /if \(!inst\.running \|\| \(!inst\.server && !inst\.tmux\?\.session\)\) return notify\(runtimeErrorLine\(inst\) \|\| `"\$\{name\}" has no live terminal session`\);/,
    "the no-live-terminal refusal uses notify (the original stuck-modal alert)");
  // and the spawn view's handoff actually asks for quiet + closes the modal first
  const spawnSrc = read("renderer/views/spawn.mjs");
  assert.match(spawnSrc, /closeSpawnModal\(s\); s\.ctx\.openTerminal\(ref, \{ quiet: true \}\);/,
    "the local handoff closes the modal then opens the terminal quietly");
  assert.match(spawnSrc, /closeSpawnModal\(s\);\n\s*s\.ctx\.openTerminal\(ref, \{ quiet: true \}\);\n\s*return \{ created: true \};/,
    "the execution-server handoff closes the modal then opens the terminal quietly");
});

/* ── #982: the notice of a terminal that cannot open says who made the row's text ── */
test("opening a terminal that cannot open: the notice carries the row's text with its speaker, and attaches nothing", async () => {
  const inner = read("renderer/shell.mjs").match(/async function openTerminalTabInner\(inst, ws, key, owns,[\s\S]*?\n\}/)?.[0];
  assert.ok(inner, "the terminal open function exists");
  // The two refusals return before the function touches the page: any other name it reaches fails the run.
  const open = runInNewContext(`(${inner})`, { canAddressRemote, rowReason, rowReasonLine, runtimeErrorLine });
  const notice = async (inst) => { const said = []; await open(inst, "A", "key", () => true, (message) => said.push(message), () => assert.fail("no destination is committed")); return said; };
  const text = "the session did not answer";
  for (const [origin, line] of shown(text)) {
    const mark = origin ? { runtimeErrorOrigin: origin } : {};
    assert.deepEqual(await notice({ instance: "dev-a", running: null, runtimeError: text, ...mark }), [line], `not running: ${origin}`);
    assert.deepEqual(await notice({ instance: "dev-a", running: true, tmux: null, runtimeError: text, ...mark }), [line], `no session: ${origin}`);
    assert.deepEqual(await notice({ instance: "dev-a", server: "box", repoName: "box-repo", addressable: false, serverUnreached: true, running: null, runtimeError: text, ...mark }), [line], `not addressable: ${origin}`);
  }
  assert.deepEqual(await notice({ instance: "dev-a", running: false }), ['"dev-a" has no live terminal session'], "a row with no text keeps the sentence written here");
  assert.deepEqual(await notice({ instance: "dev-a", running: false, runtimeErrorOrigin: "kernel" }), ['"dev-a" has no live terminal session'], "a mark beside no text names nobody");
  assert.deepEqual(await notice({ instance: "dev-a", server: "box", repoName: "box-repo", addressable: false, running: true }), ["box-repo did not report this instance as reachable."]);
  assert.deepEqual(await notice({ instance: "dev-a", running: null, runtimeError: MARKUP, runtimeErrorOrigin: "kernel" }), [`OATS says: ${MARKUP}`], "the notice is given text, never markup of its own");
  assert.deepEqual(await notice({ instance: "dev-a", running: null, runtimeError: CONTROL, runtimeErrorOrigin: "kernel" }), [DETAIL_WITHHELD]);
});
