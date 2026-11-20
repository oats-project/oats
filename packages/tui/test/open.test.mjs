process.env.TZ = "UTC";
// Opening an agent's terminal (awebai/oats#855, PR 4, and the panel of T1): what Enter decides for a
// row, the line after the viewer ends or after a preflight fails, the stderr of the viewer, the
// preflight of another machine's agent, and the screen of each, drawn as the main loop draws it
// (helpers.mjs `draw`). The panel's focus, zoom and close are model.test.mjs's and views.test.mjs's.
// The rows are made by the shared reader (helpers.mjs `observed`, the roster's own functions for
// another machine); a shared sentence is read from the row or the shared function, never written
// out: only the TUI's own words are literals.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  DETACH_KEY_FEATURE, DETAIL_WITHHELD, PREFIX_SCROLL_FEATURE, TERMS, deployments, displayLine, instanceActs, instanceId, kernelLines, observeIdentities, observedEntry, openAct, originLead,
  panelInstances, preflightFailure, prepareRemoteTerm, remoteRosterState, rosterRows, sessionAttachArgv,
} from "../lib/client.mjs";
import { effectiveConfig } from "../lib/config.mjs";
import { OPEN_WORDS, heldOf, model, openDecision, outcomeOf, preflightLine, roster } from "../lib/model.mjs";
import { layout } from "../lib/views/frame.mjs";
import { reduce } from "../lib/store.mjs";
import { CLI, NOW, draw, instanceRow, observed, press, rosterOf, stateOf } from "./helpers.mjs";

const size = (cols, rows) => ({ cols, rows });
const S80 = size(80, 24), S120 = size(120, 40);
const AT = new Date(NOW).toISOString();

/** A kernel that reads other machines and opens their agents. It lists no detach key: the viewer is
 *  given none (the TUI takes the back key before the pane sees it), so no kernel is asked for one. */
const KEYED = Object.freeze({ ...CLI, remote: Object.freeze(["roster", "session"]) });

/** The words the TUI writes around an open, as the screen shows them: a part from outside is
 *  given here as it is (the fixture's names are plain). */
const words = (parts) => parts.map((part) => part.own ?? part.shown).join("");

// ── This machine ──────────────────────────────────────────────────────────────────────────────────

const ALPHA = "dev-alpha", BETA = "dev-beta";
const HERE = () => [
  instanceRow("dev", ALPHA),
  instanceRow("dev", BETA, { running: false, runtimeState: "stopped" }),
  instanceRow("dev", "dev-unknown", { running: null, runtimeState: "unreachable", runtimeError: "tmux: no server running" }),
  instanceRow("dev", "dev-half", { running: false, runtimeState: "stopped", rollbackIncomplete: true }),
  instanceRow("dev", "dev-herdr", { running: null, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: Herdr is gone; tmux is the only session backend" }),
];
const here = (options = {}) => stateOf(observed(HERE(), { cli: options.cli ?? KEYED }), { cli: KEYED, ...options });
/** The state with `name` selected (from the first row, moving down). */
function on(state, name, sz = S80) {
  for (let i = 0; i < 20 && rowOf(state)?.instance !== name; i++) state = press(state, ["j"], sz).state;
  assert.equal(rowOf(state).instance, name, `${name} is selected`);
  return state;
}
const rowOf = (state) => roster(state).instances.find((row) => instanceId(row) === state.selected);
/** The sidebar's rows (docs/tui.md, "What it shows"), each cut at its width (the rule beside it
 *  and the main area left out) and trimmed. */
function sidebarOf(state, sz = S80) {
  const d = draw(state, sz);
  return d.cells.map((row) => row.slice(0, d.cols).map((cell) => cell.text).join("").trim());
}
/** The rows under the sidebar's title, as the layout counts them: what stands above the views. */
function above(state, sz = S80) {
  const r = roster(state, AT);
  const g = layout(r.notice, sz, { note: r.note, ascii: state.ascii, outcome: outcomeOf(state), terminal: state.terminal !== null });
  return sidebarOf(state, sz).slice(1, 1 + g.above);
}
/** That the rows under the title are `texts`, each on rows of its own and wrapped to the sidebar's
 *  width as a reason is: a row ends at a space, so each text is the next rows joined by one. */
function assertSaid(state, texts, sz = S80, message) {
  const rows = above(state, sz), made = [];
  let i = 0;
  for (const text of texts) {
    if (i >= rows.length) break;
    let joined = rows[i++];
    while (i < rows.length && joined !== text && text.startsWith(`${joined} ${rows[i]}`)) joined = `${joined} ${rows[i++]}`;
    made.push(joined);
  }
  assert.deepEqual([...made, ...rows.slice(i)], texts, message);
}
/** The cheat sheet, the sidebar's rows after its last rule: each hint as `key word`, one space
 *  between them (the sheet sets the word in a column of its own). */
/** In the Alt family, the default, every chord is read without the kitty keyboard protocol, so a
 *  terminal's sheet leads with them, before the leader's three (docs/tui.md, "Chords"). The states
 *  are Linux's (helpers.mjs TEST_PLATFORM). */
const CHORDS_FIRST = Object.freeze(["Alt+K palette", "Alt+Shift+Up/Down agent", "Alt+W close", "Alt+Z zoom"]);
function sheetOf(state, sz = S80) {
  const rows = sidebarOf(state, sz), rule = rows.findLastIndex((line) => /^[─-]+$/.test(line));
  return rows.slice(rule + 1).filter(Boolean).map((line) => line.split(/ {2,}/).join(" "));
}
/** The cheat sheet of the list of instances with nothing given up, after what Enter does there:
 *  it names no act, and the list's other keys are the leader's, the palette's and the help's. */
const LISTED = ["n spawn", "w workspaces", "? help", "q quit"];

test("Enter on a running instance of this machine opens it at once in the panel: the effect carries the decision with the shared target, and the store holds the terminal, starting, with the focus", () => {
  const state = on(here(), ALPHA);
  assert.deepEqual(sheetOf(state), ["Ctrl+\\ commands", "Ctrl+K palette", "Enter open", ...LISTED], "at 80x24 the sheet gives up nothing: the leader, the palette, Enter, then spawn, workspaces, help and quit, and no act");
  const { state: opening, effects } = press(state, ["enter"]);
  const row = rowOf(state);
  assert.deepEqual(effects, [{ open: { open: true, id: instanceId(row), name: ALPHA, machine: null, target: { home: row.home }, routed: false } }]);
  assert.deepEqual([opening.opening, opening.terminal], [null, { id: instanceId(row), name: ALPHA, machine: null, routed: false, group: 0, focus: "terminal", zoom: false, status: "starting" }]);
  // The target is what the shared home builds the viewer's arguments from: nothing of them is the
  // TUI's, and no key is among them.
  assert.deepEqual(sessionAttachArgv(KEYED, effects[0].open.target), ["session", "attach", "--home", row.home]);
  // Enter on the row whose terminal is open goes to it: nothing is opened a second time.
  const again = reduce(opening, { key: "enter", page: 19, extent: 0, room: 19, cols: 38 });
  assert.deepEqual([again.state.terminal, again.effect], [opening.terminal, null]);
});

/** A state that opened `name` and heard its viewer end with `status` and `stderr` (`asked`: the
 *  person closed it). */
function returned(state, status, stderr = "", asked = false) {
  const opened = press(state, ["enter"]).state;
  return reduce(opened, { returned: { id: opened.terminal.id, status, stderr, asked } });
}

test("after a viewer ended: each word of the shared attachExit, read for a viewer with no key, is the line of the TUI's own the table says, the instances are read again at once, and no terminal is open", () => {
  const state = on(here(), ALPHA);
  const cases = [
    [20, "", [words(OPEN_WORDS.unknown(ALPHA))], "20 is a key's exit, and the viewer has none: unknown"],
    [0, "", [], "ended: nothing of its own, the list shows the agent as the kernel now reports it"],
    [1, "oats: session no longer exists\n", [words(OPEN_WORDS.failed(ALPHA)), '"oats: session no longer exists"'], "failed, with what it printed"],
    [1, "", [words(OPEN_WORDS.failed(ALPHA))], "failed, with nothing printed: no row for it"],
    [255, "ssh: connect to host garnet port 22: timed out\n", [words(OPEN_WORDS.unknown(ALPHA))], "255 on this machine is no link: unknown"],
    [null, "", [words(OPEN_WORDS.unknown(ALPHA))], "ended by a signal: unknown"],
    [2, "", [words(OPEN_WORDS.unknown(ALPHA))], "any other status"],
  ];
  for (const [status, stderr, lines, why] of cases) {
    const after = returned(state, status, stderr);
    assert.deepEqual(after.effect, { refresh: { live: true } }, why);
    assert.equal(after.state.terminal, null, why);
    assertSaid(after.state, lines, S80, why);
    // A viewer the person closed is said nothing of, whatever its status.
    assert.deepEqual(above(returned(state, status, stderr, true).state), [], `${why}, closed by the person`);
  }
  assert.equal(OPEN_WORDS.left, undefined, "nobody leaves a viewer by a key any more");
  assert.equal(words(OPEN_WORDS.failed(ALPHA)), `${ALPHA} could not be opened.`);
  assert.equal(words(OPEN_WORDS.unknown(ALPHA)), `The viewer of ${ALPHA} ended without saying why.`);
  // An end of another id, or with no terminal open, changes nothing.
  const opened = press(state, ["enter"]).state;
  assert.equal(reduce(opened, { returned: { id: "elsewhere", status: 1, stderr: "" } }).state, opened);
  assert.equal(reduce(state, { returned: { id: opened.terminal.id, status: 1, stderr: "" } }).state, state);
});

test("a viewer the panel could not start: no tmux, or one too old, is said in the TUI's words; any other refusal is a failed open with tmux's words quoted under it, through the display filter", () => {
  const state = on(here(), ALPHA);
  const opened = press(state, ["enter"]).state;
  const refused = (how, stderr = "") => reduce(opened, { returned: { id: opened.terminal.id, status: null, stderr, refused: how } });
  const tmux = refused("tmux");
  assert.deepEqual([tmux.state.terminal, tmux.effect], [null, { refresh: { live: true } }]);
  assertSaid(tmux.state, [words(OPEN_WORDS.noTmux(ALPHA))], S120);
  assert.equal(words(OPEN_WORDS.noTmux(ALPHA)), `${ALPHA} could not be opened: the terminal panel needs tmux 3.2 or later on this machine.`);
  assertSaid(refused("start", "error connecting to /tmp/x/tmux (File name too long)\n").state, [words(OPEN_WORDS.failed(ALPHA)), '"error connecting to /tmp/x/tmux (File name too long)"'], S120);
  assert.deepEqual(above(refused("start", "\u001b]0;owned\u0007").state, S120).slice(0, 1), [words(OPEN_WORDS.failed(ALPHA))]);
  for (const row of draw(refused("start", "\u001b]0;owned\u0007 x").state, S120).cells) for (const cell of row) assert.doesNotMatch(cell.text, /[\u0000-\u001f\u007f]/);
});

test("the line stands until the next key bound to an action; a key bound to nothing and a paste leave it", () => {
  const after = returned(on(here(), ALPHA), 2).state;
  const line = [words(OPEN_WORDS.unknown(ALPHA))];
  for (const key of ["y", "f5", "ctrl+y", "insert"]) assertSaid(press(after, [key]).state, line, S80, key);
  assertSaid(reduce(after, { paste: "x" }).state, line, S80, "a paste");
  for (const key of ["j", "r", "ctrl+l", "?", "tab", "escape"]) assert.deepEqual(above(press(after, [key]).state).filter(Boolean), [], key);
  // The key a user's tui.json gives an action is what counts.
  const config = effectiveConfig({ keys: { refresh: ["f5"] } });
  const rebound = returned(on(here({ actions: config.actions }), ALPHA), 2).state;
  assertSaid(press(rebound, ["r"]).state, line, S80, "r is bound to nothing there");
  assert.deepEqual(above(press(rebound, ["f5"]).state), [], "f5 refreshes there");
});

test("Enter where open is not offered opens nothing and says why: not running, state unknown, held, a removed session backend; a kernel record without the detach key opens alike", () => {
  const state = here();
  const say = (name, cli) => {
    const at = on(cli ? here({ cli }) : state, name);
    const { state: after, effects } = press(at, ["enter"]);
    assert.deepEqual([effects, after.opening, after.terminal], [[], null, null], `${name}: nothing is opened`);
    return { after, row: rowOf(at) };
  };
  assertSaid(say(BETA).after, [`${BETA} is not running, so it has no terminal to open.`], S120);
  assertSaid(say("dev-unknown").after, ["Whether dev-unknown runs is not known, so it is not opened."], S120);
  // Held: the row's own reason, as the detail draws it (a sentence of the shared home's, as written).
  const half = say("dev-half");
  const held = instanceActs(half.row).limited;
  assert.equal(openAct(half.row), null);
  assert.equal(held.origin, undefined);
  assertSaid(half.after, [displayLine(held.sentence)], S120);
  // A session backend OATS no longer has: the reason's sentence, after its speaker's words when it has one.
  const herdr = say("dev-herdr");
  const reason = openAct(herdr.row).reason;
  assert.equal(reason.code, "unsupported-session");
  const lead = originLead(reason.origin, TERMS);
  assertSaid(herdr.after, [reason.origin === undefined ? displayLine(reason.sentence) : lead !== null ? `${lead} ${displayLine(reason.sentence)}` : `"${displayLine(reason.sentence)}"`], S120);
  // A kernel that lists no detach key opens like any other: the viewer is given no key.
  assert.equal(CLI.features.includes(DETACH_KEY_FEATURE), false);
  assert.equal(press(on(here({ cli: CLI }), ALPHA), ["enter"]).effects[0].open.open, true);
  assert.equal(OPEN_WORDS.noKey, undefined, "and the line that refused one is gone");
  // No hint of Enter in the cheat sheet for a row Enter does not open.
  for (const name of [BETA, "dev-unknown", "dev-half", "dev-herdr"]) assert.doesNotMatch(sheetOf(on(state, name)).join("\n"), /Enter/, name);
});

// ── Another machine ───────────────────────────────────────────────────────────────────────────────

const IDENTITY = Object.freeze({ key: "github.com/acme/platform", ref: "main", keyFrom: "workspace", standalone: false, defaultTeam: Object.freeze({ label: "eng", team: "team-1" }), teams: Object.freeze({ eng: "team-1" }), teamsFrom: "observed" });
/** This machine's entry, reporting the workspace a machine's group joins. */
function reporting(rows) {
  const document = { ...rosterOf(rows), workspace: { reachable: true, ...IDENTITY } }, listed = rosterRows(document, KEYED);
  return observedEntry({ roster: document, workspaceStatus: { workspace: { name: "acme-platform" } }, observedAt: "2026-10-11T09:59:00.000Z" }, panelInstances(listed, listed.map((row) => ({ running: row.running, runtimeState: row.runtimeState, tmux: row.tmux }))), "2026-10-11T10:00:00.000Z");
}
const FAR = "/home/dev/Agents/acme", FAR_A = "dev-far-a", FAR_B = "dev-far-b";
const farRow = (name, extra = {}) => ({ instance: name, agent: "dev", home: `${FAR}/agents/dev/instances/${name}`, agentsRoot: `${FAR}/agents`, work: "worktree", harness: "claude", running: true, runtimeState: "running", addressable: true, ...extra });
/** The machine `garnet`, whose OATS lists the detach key among its features. */
const group = (extra = {}) => ({
  id: "garnet:acme-1", server: "garnet", label: "garnet", registrationPresent: true, target: { workspace: FAR, sshHost: "garnet.example" }, probe: { ok: true, features: [DETACH_KEY_FEATURE] },
  workspace: IDENTITY, agentsRoot: `${FAR}/agents`, souls: [], instances: [farRow(FAR_A), farRow(FAR_B, { addressable: false, running: false, runtimeState: "stopped" })], ...extra,
});
/** The store after one outcome of the roster read, made as the loop makes it. */
function heard(state, groups, at = "2026-10-11T10:00:10.000Z") {
  const next = remoteRosterState(state.remote, { envelope: { ok: true, result: { groups } } }, at);
  const kept = next.reported === null ? { memory: state.memory, notes: state.notes } : observeIdentities({ memory: state.memory, notes: state.notes }, next.reported, at);
  return reduce(state, { roster: { remote: { remoteGroups: next.remoteGroups, rosterAnswered: next.rosterAnswered, rosterFailure: next.rosterFailure }, memory: kept.memory, notes: kept.notes, at } }).state;
}
const both = (groups = [group()], options = {}) => heard(stateOf(reporting([instanceRow("dev", ALPHA)]), { cli: KEYED, ...options }), groups);

test("a row of another machine is opened through the preflight whatever its machine's OATS lists: the viewer has no key, so no host is asked for one", () => {
  for (const probe of [{ ok: true, features: [DETACH_KEY_FEATURE] }, { ok: true, features: ["waiting-on-you"] }, { ok: true, features: null }, { ok: true }]) {
    const state = on(both([group({ probe })]), FAR_A), row = rowOf(state);
    const entry = deployments(heldOf(state, "2026-10-11T10:00:30.000Z")).find((d) => d.id === row.deployment.id);
    assert.equal(entry?.group?.server, "garnet", "the row's tag names the deployment of its group");
    const decision = openDecision(state, row, instanceActs(row));
    assert.deepEqual([decision.open, decision.routed], [true, true], JSON.stringify(probe));
    assert.deepEqual(sheetOf(state).slice(0, 3), ["Ctrl+\\ commands", "Ctrl+K palette", "Enter open"], JSON.stringify(probe));
  }
});

test("another machine's tab names the scroll keys its host's kernel says its viewer takes, from the roster probe, never this machine's: Shift+PageUp where the host lists session-attach-prefix-scroll, Ctrl+B [ too where its probe.sessionViewer.prefixScroll is true, and no hint at all where the host does not list the feature", () => {
  // This machine's viewer takes C-b [: a remote tab must not borrow it.
  const local = Object.freeze({ ...KEYED, features: [...KEYED.features, PREFIX_SCROLL_FEATURE, "server-probe-features"], sessionViewer: { prefixScroll: true } });
  const focusedOn = (probe) => {
    const state = on(both([group({ probe })], { cli: local }), FAR_A), id = instanceId(rowOf(state));
    const started = reduce(press(state, ["enter"]).state, { prepared: { id } }).state;
    return reduce(started, { shown: { id } }).state;
  };
  const LISTED = [DETACH_KEY_FEATURE, PREFIX_SCROLL_FEATURE];
  for (const [why, probe, hint] of [
    ["the host's viewer takes C-b [", { ok: true, features: LISTED, sessionViewer: { prefixScroll: true } }, "Ctrl+B [ scroll back"],
    ["the host's tmux is older", { ok: true, features: LISTED, sessionViewer: { prefixScroll: false } }, "Shift+PageUp scroll back"],
    ["a local CLI that does not relay the fact", { ok: true, features: LISTED, sessionViewer: null }, "Shift+PageUp scroll back"],
    ["a host before the feature", { ok: true, features: [DETACH_KEY_FEATURE], sessionViewer: { prefixScroll: true } }, null],
    ["a host whose features are not known", { ok: true, features: null }, null],
    ["a host before the probe relayed features", { ok: true }, null],
  ]) {
    const shown = focusedOn(probe);
    assert.equal(shown.terminal?.focus, "terminal", why);
    const sheet = sheetOf(shown).filter((row) => row.endsWith("scroll back"));
    assert.deepEqual(sheet, hint === null ? [] : [hint], `${why}: ${JSON.stringify(sheetOf(shown))}`);
  }
});

test("Enter on a running instance of another machine: the preflight first, the cheat sheet says so, Enter again does nothing, and Esc gives it up", () => {
  const state = on(both(), FAR_A), row = rowOf(state);
  assert.deepEqual(sheetOf(state).slice(0, 3), ["Ctrl+\\ commands", "Ctrl+K palette", "Enter open"]);
  const { state: asking, effects } = press(state, ["enter"]);
  assert.deepEqual(effects, [{ open: { open: true, id: instanceId(row), name: FAR_A, machine: "garnet", target: { serverId: "garnet", instance: FAR_A, home: row.home }, routed: true } }]);
  assert.deepEqual([asking.opening, asking.terminal], [{ id: instanceId(row), phase: "preflight", name: FAR_A, machine: "garnet", routed: true }, null]);
  assert.deepEqual(sheetOf(asking), ["Ctrl+\\ commands", "Ctrl+K palette", "Esc stop opening", ...LISTED], "Esc in Enter's place while it is asked");
  assert.doesNotMatch(sheetOf(asking).join("\n"), /Enter|Esc close/);
  assert.deepEqual(press(asking, ["enter"]).effects, [], "a second Enter does nothing");
  const given = press(asking, ["escape"]);
  assert.deepEqual([given.effects, given.state.opening], [[{ abandon: true }], null]);
  // What the preflight answers after it was given up is dropped.
  assert.equal(reduce(given.state, { prepared: { id: instanceId(row) } }).state, given.state);
});

test("the preflight ends: the viewer is started in the panel for the row selected at Enter, by its id, whatever is selected now; not when that row has left the roster; and a suspend gives it up with nothing said", () => {
  const state = on(both(), FAR_A), id = instanceId(rowOf(state));
  const asking = press(press(state, ["enter"]).state, ["k"]).state;
  assert.notEqual(asking.selected, id, "the selection moved during the preflight");
  const started = reduce(asking, { prepared: { id } });
  assert.deepEqual([started.effect, started.state.opening, started.state.terminal], [{ panel: id }, null, { id, name: FAR_A, machine: "garnet", routed: true, group: 0, focus: "terminal", zoom: false, status: "starting" }]);
  const after = reduce(started.state, { returned: { id, status: 1, stderr: "" } });
  assertSaid(after.state, [words(OPEN_WORDS.failed(FAR_A))], S80, "the line names the row of the Enter");
  // The row went away while the preflight ran.
  const gone = heard(press(state, ["enter"]).state, [group({ instances: [farRow(FAR_B, { addressable: false, running: false, runtimeState: "stopped" })] })], "2026-10-11T10:00:25.000Z");
  const dropped = reduce(gone, { prepared: { id } });
  assert.deepEqual([dropped.effect, dropped.state.opening, above(dropped.state)], [null, null, []]);
  // A suspend: the loop gives it up and tells the store.
  const given = reduce(press(state, ["enter"]).state, { given: true });
  assert.deepEqual([given.state.opening, above(given.state)], [null, []]);
});

/** execFile's signature over a canned answer, returning a child that closes after the callback, as
 *  the shared runner waits for both. */
const execWith = (answer) => (bin, argv, options, callback) => {
  const child = Object.assign(new EventEmitter(), { pid: 1, kill() {} });
  queueMicrotask(() => { answer(callback); child.emit("close", 0, null); });
  return child;
};
const refused = (error) => (callback) => { const stdout = JSON.stringify({ schemaVersion: 1, ok: false, error }); callback(Object.assign(new Error("Command failed"), { code: 1, stdout, stderr: "" }), stdout, ""); };
/** What the shared prepareRemoteTerm throws for an answer. */
async function thrown(answer, options = {}) {
  try { await prepareRemoteTerm(KEYED, { serverId: "garnet", instance: FAR_A, home: `${FAR}/agents/dev/instances/${FAR_A}` }, { exec: execWith(answer), ...options }); } catch (error) { return error; }
  assert.fail("the preflight was expected to fail");
}

// Session providers (spec C1): the home moved to one while its preflight ran.
test("the preflight ends for a row the roster now shows on a session provider: no viewer is started; Enter's line says where it runs, a restore says nothing; a row still in tmux starts as before", () => {
  const state = on(both(), FAR_A), id = instanceId(rowOf(state));
  const asking = press(state, ["enter"]).state;
  const moved = farRow(FAR_A, { backend: "bb", tmux: null, runtimeState: "unknown", session: { provider: "oats.bb" }, open: { label: "Open in bb", url: "http://127.0.0.1:38886/t/thr_x" } });
  const later = heard(asking, [group({ instances: [moved] })], "2026-10-11T10:00:25.000Z");
  assert.deepEqual(later.opening, asking.opening, "the preflight is still under way when the roster brings the row");
  const refused = reduce(later, { prepared: { id } });
  assert.deepEqual([refused.effect, refused.state.opening, refused.state.terminal, refused.state.tabs], [null, null, null, []], "no viewer, no tab");
  // Another machine's row carries no link: the sentence alone, as Enter on that row says it.
  assert.deepEqual(refused.state.outcome, { said: [], under: ["Runs in a bb thread; open it in bb."] });
  // A restore's preflight: dropped quietly, as any tab a restore cannot open.
  const restoring = Object.freeze({ ...later, opening: Object.freeze({ ...later.opening, restore: true }) });
  const quiet = reduce(restoring, { prepared: { id } });
  assert.deepEqual([quiet.effect, quiet.state.opening, quiet.state.tabs, quiet.state.outcome ?? null], [null, null, [], null]);
  // The same sequence with the row still in tmux: started, as before.
  const same = heard(asking, [group()], "2026-10-11T10:00:25.000Z");
  assert.deepEqual(reduce(same, { prepared: { id } }).effect, { panel: id });
});

test("a preflight that failed: the shared table's sentence and, when the kernel said something, its lines under it; a withheld text is the TUI's [withheld]; the person's own giving up says nothing", async () => {
  const state = on(both(), FAR_A), asking = press(state, ["enter"]).state, id = asking.opening.id;
  const after = (error) => reduce(asking, { prepared: { id, error } });
  const cases = [
    await thrown(refused({ code: "E_SSH", message: "ssh: connect to host garnet port 22: timed out", details: { sshStarted: true } })),
    await thrown((callback) => callback(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { present: false } }), "")),
    await thrown(refused({ code: "E_SERVER_UNKNOWN", message: "no server named garnet is registered", details: { fix: "oats server list names them" } })),
    await thrown(refused({ code: "E_X", message: "failed: token=abc123", details: { fix: "run oats server check garnet" } })),
    await thrown((callback) => callback(Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM", code: null }), "", "")),
  ];
  for (const error of cases) {
    const failure = preflightFailure(error, "garnet");
    const said = failure.said === null ? [] : kernelLines(failure.said.message, failure.said.fix, TERMS).map((line) => (line === DETAIL_WITHHELD ? "[withheld]" : line));
    const next = after(error);
    assert.deepEqual([next.effect, next.state.opening], [null, null], failure.code);
    assertSaid(next.state, [failure.sentence, ...said], S120, failure.code);
  }
  // The table's sentence stands first (wrapped as a reason is), the kernel's lines under it.
  assert.equal(after(cases[3]).state.outcome.under[1], DETAIL_WITHHELD, "the shared word for a withheld text reaches the view as it came");
  assert.equal(above(after(cases[3]).state, S120)[1], "[withheld]");
  const aborted = new AbortController();
  aborted.abort();
  const own = await thrown(() => assert.fail("nothing runs"), { signal: aborted.signal });
  assert.equal(preflightFailure(own, "garnet").code, "E_TERM_CONTEXT_CHANGED");
  assert.deepEqual([after(own).state.opening, above(after(own).state)], [null, []], "nothing is said");
});

test("a row of another machine the kernel does not report addressable: the row's own reason, and no act of the TUI's; a link that ended is said with the machine's name", () => {
  // A row the kernel does not report addressable: the row's own reason, and no act of the TUI's.
  const blocked = on(both(), FAR_B), reason = instanceActs(rowOf(blocked)).blocked;
  assert.equal(openAct(rowOf(blocked)), null);
  const lead = originLead(reason.origin, TERMS);
  assertSaid(press(blocked, ["enter"]).state, [reason.origin === undefined ? displayLine(reason.sentence) : lead !== null ? `${lead} ${displayLine(reason.sentence)}` : `"${displayLine(reason.sentence)}"`], S120);
  // The link: ssh's own failure, under a routed viewer.
  const started = reduce(press(on(both(), FAR_A), ["enter"]).state, { prepared: { id: instanceId(rowOf(on(both(), FAR_A))) } }).state;
  const link = reduce(started, { returned: { id: started.terminal.id, status: 255, stderr: "Connection to garnet.example closed by remote host.\n" } }).state;
  assertSaid(link, [words(OPEN_WORDS.link("garnet")), '"Connection to garnet.example closed by remote host."'], S120);
  assert.equal(words(OPEN_WORDS.link("garnet")), "The connection to garnet ended.");
});

test("a row gone from its machine (a saved route to an instance its machine no longer has, as the kernel reports it): Enter opens nothing, and the line says why in the shared words, with the command that removes it from this computer", () => {
  // The kernel's row for it: no state, its route saved, not addressable, missing remotely.
  const GONE = "dev-far-gone";
  const state = on(both([group({ instances: [farRow(FAR_A), farRow(GONE, { running: null, runtimeState: undefined, savedRoute: true, addressable: false, missingRemotely: true })] })]), GONE);
  const row = rowOf(state), acts = instanceActs(row);
  assert.deepEqual([acts.blocked.code, acts.blocked.key, acts.blocked.origin], ["unaddressable", "missing", undefined]);
  assert.equal(openAct(row), null);
  assert.deepEqual(openDecision(state, row, acts), { open: false, said: { said: [], under: [acts.blocked.sentence] } });
  assert.equal(acts.blocked.sentence.includes(`oats server forget garnet --instance ${GONE}`), true, "the shared sentence names the command");
  const { state: refused, effects } = press(state, ["enter"]);
  assert.deepEqual(effects, [], "nothing is opened, and no machine is asked");
  assert.equal(above(refused, S120).join(" "), acts.blocked.sentence, "the shared home's own sentence, as it is written, wrapped as a reason is");
  assert.doesNotMatch(sheetOf(state).join("\n"), /Enter/);
});

// ── The viewer's stderr ───────────────────────────────────────────────────────────────────────────

/** The kernel's first row of #855 (comment 6138104215): a tmux command line with the agents'
 *  socket, a line feed, tmux's own line, two line feeds. */
const SOCKET = "/tmp/oats-tmux-1000/agents";
const KERNEL_FIRST_ROW = `oats: Command failed: tmux -u -S ${SOCKET} list-panes -t =oats-agents:=dev-alpha -F #{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_pid}\nerror connecting to ${SOCKET} (Permission denied)\n\n`;

test("the stderr is drawn unvouched as ONE text: its lines and tabs made one line by the display filter, in quotation marks, naming nobody (the kernel's first row, at 60 and 80 columns)", () => {
  const after = returned(on(here(), ALPHA), 1, KERNEL_FIRST_ROW).state;
  const line = displayLine(KERNEL_FIRST_ROW);
  assert.equal(line.includes("\t") || line.includes("\n"), false);
  assert.deepEqual(after.outcome.under, [`"${line}"`], "one text, quoted");
  for (const sz of [S80, size(60, 24)]) {
    const rows = above(after, sz);
    assert.equal(rows[0], words(OPEN_WORDS.failed(ALPHA)));
    const quoted = rows.slice(1).join(" ");
    assert.equal(quoted.startsWith('"oats: Command failed: tmux -u -S'), true, `${sz.cols}: ${quoted}`);
    assert.doesNotMatch(quoted, /OATS says|oats tui says/, "no speaker's words before it");
    // Cut as a reason is cut (the notice's rule): a quarter of the screen, at most four rows.
    assert.equal(rows.length - 1 <= Math.min(4, Math.max(1, Math.floor(sz.rows / 4))), true);
  }
});

test("the stderr is compared with nothing: a row whose own text is tmux's same line keeps it in the detail, and the line after the return shows the stderr once", () => {
  const TMUX = `error connecting to ${SOCKET} (Permission denied)`;
  // Made by hand: a running row that carries tmux's line as its own text, as a race can leave it.
  const state = on(stateOf(observed([instanceRow("dev", ALPHA, { runtimeError: TMUX })], { cli: KEYED }), { cli: KEYED }), ALPHA);
  const after = returned(state, 1, `${TMUX}\n`).state;
  // Wrapped to the sidebar's width, its rows read as one text beside the main area.
  const said = above(after, S120).join(" ");
  assert.equal(said.split(`"${TMUX}"`).length - 1, 1, "the stderr, quoted, under the sidebar's title");
  assertSaid(after, [words(OPEN_WORDS.failed(ALPHA)), `"${TMUX}"`], S120, "shown once there");
  assert.equal(model(after, { page: 30, now: 0, at: new Date(0).toISOString(), cols: 57 }).detail.facts.some((fact) => fact.value.includes(TMUX)), true, "and the detail still has the row's own reason");
});

test("the stderr: a withheld text is [withheld] alone, one with nothing to show draws no row, and a control sequence never reaches the screen", () => {
  const state = on(here(), ALPHA);
  assertSaid(returned(state, 1, "failed: token=abc123\n").state, [words(OPEN_WORDS.failed(ALPHA)), "[withheld]"]);
  assertSaid(returned(state, 1, "   \n\n\t").state, [words(OPEN_WORDS.failed(ALPHA))]);
  const hostile = returned(state, 1, "boom \u001b[2J\u001b]0;owned\u0007 ‮evil").state;
  const d = draw(hostile, S80);
  for (const row of d.cells) for (const cell of row) assert.doesNotMatch(cell.text, /[\u0000-\u001f\u007f‮]/);
});

// ── The new keys of the store, and the roster ─────────────────────────────────────────────────────

test("opening, terminal, outcome and detachKey are kept by the store and read by the model beside the roster, never through it: changing each changes the screen (MADE_FROM)", () => {
  const state = on(both(), FAR_A);
  const before = draw(state).lines;
  // opening: the cheat sheet says the preflight runs.
  const asking = press(state, ["enter"]).state;
  assert.equal(asking.opening.phase, "preflight");
  assert.notDeepEqual(draw(asking).lines, before);
  assert.equal(roster(asking).instances, roster(state).instances, "the roster is the one already made");
  // outcome: a line under the sidebar's title.
  const said = reduce(asking, { prepared: { id: asking.opening.id, error: Object.assign(new Error("x"), { code: "E_TERM_PREPARE_TIMEOUT" }) } }).state;
  assert.notDeepEqual(draw(said).lines, draw({ ...said, outcome: null }).lines);
  // terminal: the panel stands where the detail was. Its tab is the panel's (the loop and the
  // layout read the sidebar's width from the tabs).
  const shown = { id: asking.opening.id, name: FAR_A, machine: "garnet", routed: true, group: 0 };
  const terminal = Object.freeze({ ...state, tabs: Object.freeze([Object.freeze({ ...shown, status: "open", activity: false })]), terminal: Object.freeze({ ...shown, focus: "terminal", zoom: false, status: "open" }) });
  assert.notDeepEqual(draw(terminal).lines, before);
  assert.equal(roster(terminal).instances, roster(state).instances, "the roster is the one already made");
  // detachKey: the cheat sheet names it, it then Esc, and it twice, while the terminal has the
  // focus, and the help names the two, in a main area wide enough for each sentence on one row.
  const f12 = Object.freeze({ ...terminal, detachKey: "F12" });
  // garnet's kernel lists no session-attach-prefix-scroll: no scroll keys are named for its tab.
  assert.deepEqual(sheetOf(f12), [...CHORDS_FIRST, "F12 commands", "F12 Esc the list", "F12 F12 types F12"]);
  assert.notDeepEqual(draw(f12).lines, draw(terminal).lines);
  const helped = draw(press(on(both([group()], { detachKey: "F12" }), FAR_A), ["?"]).state, size(200, 100)).lines.join("\n");
  assert.match(helped, /F12 Esc takes the focus from the terminal back to the list; the agent keeps running\./);
  assert.match(helped, /F12 F12 types the leader into the terminal\./);
});

test("a name from outside in the line after an open goes through the display filter on its own; the TUI's words around it are never filtered with it", () => {
  const NAME = "dev-\u001b[31mred‮";
  const state = on(stateOf(observed([instanceRow("dev", NAME, { running: false, runtimeState: "stopped" })], { cli: KEYED }), { cli: KEYED }), NAME);
  // One sentence, wrapped to the sidebar's width: its rows read as one text.
  const text = above(press(state, ["enter"]).state, S120).join(" ");
  assert.equal(text.endsWith(" is not running, so it has no terminal to open."), true, text);
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f‮]/);
});

test("a sentence from outside is wrapped as a reason is, on the reason's rows, never cut to one row as a name is: the preflight table's sentence with its remedy, and a held row's reason, at 60 columns (round 1 of the review)", () => {
  const S60 = size(60, 24);
  // The preflight's: ssh missing here, its remedy at the end of the shared sentence.
  const failure = preflightFailure(Object.assign(new Error("ssh is not available on this computer"), { code: "E_TERM_REMOTE_NO_SSH" }), "garnet");
  const asked = Object.freeze({ ...here(), outcome: preflightLine({ machine: "garnet" }, Object.assign(new Error("ssh is not available on this computer"), { code: "E_TERM_REMOTE_NO_SSH" })) });
  const rows = above(asked, S60);
  assert.equal(rows.length > 1, true, rows.join("\n"));
  assert.equal(rows.join(" "), failure.sentence, "the whole sentence, the remedy included, on as many rows as it needs");
  // A held row's: the shared home's reason, as Enter says it, with no row cut.
  const half = on(here(), "dev-half", S60), held = instanceActs(rowOf(half));
  const reason = (held.blocked ?? held.limited).sentence;
  const said = above(press(half, ["enter"], S60).state, S60);
  assert.equal(said.join(" ").includes(displayLine(reason)), true, said.join("\n"));
  assert.equal(said.some((line) => line.endsWith("\u2026")), false, "nothing cut");
});

test("a preflight that ends while the filter field is open gives the terminal the focus and settles the field, its text kept: the cheat sheet names the chords, then the leader, the leader then Esc and the leader twice, and none of the field's keys; no key goes to the field (round 1 of the review)", () => {
  const state = on(both(), FAR_A), id = instanceId(rowOf(state));
  const typing = press(press(state, ["enter"]).state, ["/", "d", "e", "v"]).state;
  assert.deepEqual([typing.filter.editing, typing.opening?.phase], [true, "preflight"]);
  const started = reduce(typing, { prepared: { id } }).state;
  assert.deepEqual([started.terminal.focus, started.filter, started.focus], ["terminal", { editing: false, query: "dev" }, "list"]);
  // garnet's kernel lists no session-attach-prefix-scroll: no scroll keys are named for its tab.
  const focused = [...CHORDS_FIRST, "Ctrl+\\ commands", "Ctrl+\\ Esc the list", "Ctrl+\\ Ctrl+\\ types Ctrl+\\"];
  assert.deepEqual(sheetOf(started), focused);
  assert.deepEqual(sheetOf(started, S120), focused);
});
