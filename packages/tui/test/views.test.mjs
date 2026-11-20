process.env.TZ = "UTC";
// The views of `oats tui`, drawn as the main loop draws them (helpers.mjs `draw`): the store's state
// through the real model, the frame and the screen's cell buffer. What a test claims about the
// screen (a width, a pane, a line of its own) it reads from the cells, never from a string's length.
// Every entry is made by the shared functions, and every sentence of the shared home is computed by
// calling it: the tests quote the TUI's own words only. One exception: the words that say who gave a
// row's text (`OATS says:` and the two that name the client) are the shared home's and are written
// out where a test expects them on the screen, because a test is the place that pins them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIONS, LEADER, backKeyLabel } from "../lib/actions.mjs";
import {
  DETAIL_WITHHELD, TERMS, UNMATCHED_SECTION, chordFamilyFrom, cliRemoteRoster, deploymentState, displayLine, heldHome, instanceActs, livenessAnswers, livenessInput, observeIdentities, observedEntry,
  originLead, panelInstances, primaryDeployment, remoteRosterState, rosterRows, rowReason, runtimeState, waitedText, waitingBelowText, waitingClock, waitingLabel, workspaceChoiceRows, workspaceChoices,
} from "../lib/client.mjs";
import { effectiveConfig } from "../lib/config.mjs";
import { OFFERED_SECTION, ROSTER_FAILED, heldOf, model, paletteItems, panelOf, roster, switcher } from "../lib/model.mjs";
import { reduce } from "../lib/store.mjs";
import { captureRows } from "../lib/term/capture.mjs";
import { createScreen } from "../lib/term/screen.mjs";
import { PLAIN, isStyle, style } from "../lib/term/style.mjs";
import { isSafeText, shown, textOf } from "../lib/term/text.mjs";
import { textWidth } from "../lib/term/width.mjs";
import { CAPABILITIES_TEXT } from "../lib/views/capabilities.mjs";
import { LIST_BESIDE, MIN_SIZE, PANEL_MIN, WIDE, frame } from "../lib/views/frame.mjs";
import { ACT_RULES, CHORD_OPEN_RULE, LEADER_AGAIN, MACHINES, NOT_YET, PALETTE_GROUP_WORDS, PALETTE_KEYS, VIEWS, helpRows, keysLabel } from "../lib/views/help.mjs";
import { EMPTY_TEXT, MARKS, NEEDS_INPUT, belowText, cutNote, instances, marksOf } from "../lib/views/instances.mjs";
import { SOUL_MARK } from "../lib/views/souls.mjs";
import { OPEN_MARK, SWITCHER_TEXT } from "../lib/views/switcher.mjs";
import { WAITING_DOT } from "../lib/views/workspaces.mjs";
import { CLI, DEPLOYMENT, NOW, draw, drawnName, failed, instanceRow, leaderEscape, leaderThen, observed, press, readTerminalOutput, rosterOf, stateOf } from "./helpers.mjs";

const size = (cols, rows) => ({ cols, rows });
const S80 = size(80, 24), S120 = size(120, 40), S79 = size(79, 24), S60 = size(60, 15);
const SIZES = [S80, S120, S79, S60];
const AT = new Date(NOW).toISOString();
const DIM = style({ dim: true });
/** The spec's own arithmetic for the list pane of a wide terminal. */
const listWidth = (cols) => Math.min(Math.max(Math.floor(cols * 0.48), 36), 60);
/** The glyphs the spec gives the frame, by mode. */
const GLYPHS = { utf8: { rule: "─", down: "┬", bar: "│", cut: "…" }, ascii: { rule: "-", down: "+", bar: "|", cut: "..." } };
const glyphsOf = (ascii) => (ascii ? GLYPHS.ascii : GLYPHS.utf8);
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** What no cell may hold: a control character (C0, DEL, C1) or a bidi control. */
const CONTROL = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** A list row as cellText reads it in a pane `pane` wide: `left` (the marks, the name and what
 *  follows it), then the needs-input tag at the pane's edge, its last cell (padding) cut as trailing
 *  blanks are. */
const tagged = (left, pane, words = NEEDS_INPUT) => `${left.padEnd(pane - words.length - 1)}${words}`;
/** The needs-input tag's looks: reverse video in the waiting colour, and on the selected row (in
 *  reverse already) the waiting colour not reversed. */
const TAG = style({ fg: "yellow", bold: true, reverse: true }), TAG_SELECTED = style({ fg: "yellow", bold: true });
/** The needs-input tag at the edge of row `r` of a pane `pane` wide, as drawn: the column it starts
 *  at, its words (padding cut) and its style; null when the row's last cell is not a tag's. */
function tagAt(d, r, pane) {
  const cells = d.cells[r].slice(0, pane), look = cells[pane - 1].style;
  if (look !== TAG && look !== TAG_SELECTED) return null;
  let col = pane;
  while (col > 0 && cells[col - 1].style === look) col--;
  return { col, words: cells.slice(col).map((cell) => cell.text).join("").trim(), style: look };
}
/** The needs-input mark of row `r`, as drawn: `{ col, style }` of the cell that holds `!` in the
 *  needs-input look before the row's name, or null. */
function waitMarkAt(d, r) {
  const col = d.cells[r].findIndex((cell) => cell.text === "!" && (cell.style === TAG || cell.style === TAG_SELECTED));
  return col < 0 || col > 2 + 2 * 5 ? null : { col, style: d.cells[r][col].style };
}
/** The text of a row of cells from column `from` up to `to`, trailing blanks cut. */
const textAt = (line, from = 0, to = line.length) => line.slice(from, to).map((cell) => cell.text).join("").trimEnd();
/** The text of the cells of row `r` from column `from` up to `to`, trailing blanks cut. */
const cellText = (d, r, from = 0, to = Infinity) => d.cells[r].slice(from, to).map((cell) => cell.text).join("").trimEnd();
/** The cell index at which `word` is last drawn in a row of cells (a string index is not one: the
 *  second cell of a wide grapheme holds no character), or -1. */
function cellIndexOf(cells, word) {
  for (let x = cells.length - word.length; x >= 0; x--) if (cells.slice(x, x + word.length).map((cell) => cell.text).join("") === word && cells.slice(x, x + word.length).every((cell) => cell.width === 1)) return x;
  return -1;
}
/** Whether a cell is drawn in reverse video: the second cell of a wide grapheme is drawn by its first. */
const reversed = (line, x) => (line[x].width === 0 ? line[x - 1] : line[x]).style.reverse;
/** Every row of a frame: there is no header and no footer, and the sidebar and the main area each
 *  span the whole height. */
const bodyRows = (sz) => Array.from({ length: sz.rows }, (_, i) => i);
/** The sidebar's width at a size, with no terminal open: the list's beside the main area from 80
 *  columns, the whole width under. */
const paneOf = (sz) => (sz.cols >= WIDE ? listWidth(sz.cols) : sz.cols);
/** Whether row `r` is one of the sidebar's rules: every cell of the sidebar's width (`d.cols`) a
 *  rule glyph. */
const isRule = (d, r) => d.cells[r].slice(0, d.cols).every((cell) => cell.text === GLYPHS.utf8.rule || cell.text === GLYPHS.ascii.rule);
/** The accordion's views, in their order, each with its key. */
const VIEW_ROWS = Object.freeze([["Instances", "1"], ["Souls", "2"], ["Capabilities", "3"]]);
/** The row of the open view's heading: under the list of workspaces, its name in bold at the margin, or the
 *  filter field's `/` while one is typed; -1 while no view is open (the switcher). */
const openRow = (d) => d.cells.findIndex((line, r) => r > 0 && line[1].style.bold && (line[1].text === "/" || VIEW_ROWS.some(([name]) => cellText(d, r, 1, 1 + name.length) === name)));
/** The rows of the open view's list in the sidebar: from the row under its heading to the rule
 *  after it (trailing empty rows are not drawn: what follows the list stands right under it). */
function listRows(d) {
  const rows = [], heading = openRow(d);
  for (let r = heading + 1; heading >= 0 && r < d.cells.length && !isRule(d, r); r++) rows.push(r);
  return rows;
}
/** The list's rows as strings, the sidebar's cells only, and the detail's (the cells right of the
 *  sidebar's rule from 80 columns, the whole width under), every row of the screen. */
const listLines = (d) => listRows(d).map((r) => cellText(d, r, 0, d.cols));
const detailLines = (d, sz) => d.cells.map((_, r) => cellText(d, r, sz.cols >= WIDE ? d.cols + 1 : 0));
/** The screen row that draws the instance whose name begins with `name`, in the list (as words). */
function rowOf(d, sz, name) {
  const found = listRows(d).filter((r) => cellText(d, r, 0, d.cols).includes(drawnName(name)));
  assert.equal(found.length, 1, `one list row draws ${name}`);
  return found[0];
}
/** The row that draws the fixture's instance `name`, read where its name is whole: at 79 columns
 *  the sidebar has the whole width, and its rows stand where they stand at every width of the same
 *  height. */
function rowAt(state, sz, name) {
  const reference = draw(state, size(79, sz.rows));
  const found = listRows(reference).filter((r) => `${cellText(reference, r)} `.includes(` ${drawnName(name)} `));
  assert.equal(found.length, 1, `one list row draws ${name}`);
  return found[0];
}
/** The state with the instance `name` on the screen at size `sz`: as it is, or, where the list is
 *  cut off at that size (60x15 holds seven rows of the eleven, the leader's row under them), with
 *  the selection moved to it. */
function onScreen(state, sz, name) {
  const reference = draw(state, size(79, sz.rows));
  return listRows(reference).some((r) => cellText(reference, r).includes(` ${drawnName(name)} `)) ? state : selecting(state, name, sz);
}
/** The cheat sheet's rows: the sidebar's cells under its last rule, down to the last row that holds
 *  something. */
function sheetOf(d) {
  const last = d.cells.findLastIndex((_, r) => isRule(d, r)), lines = d.cells.slice(last + 1).map((_, i) => cellText(d, last + 1 + i, 0, d.cols));
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines;
}
/** Under 80 columns the detail with the focus is a page over the whole screen: no sidebar, so no
 *  rule and no cheat sheet, and its title, ` > ` and the name, on the top row. */
const detailPage = (d) => !d.cells.some((_, r) => isRule(d, r)) && cellText(d, 0).startsWith(" > ");
/** A detail page's first row, `cols` wide: its title, then its keys (the cheat sheet's but for the
 *  leader, the palette, help and quit), dim at the right, ending one cell before the edge. */
const pageTop = (title, keys, cols) => `${title.padEnd(cols - 1 - keys.length)}${keys}`;
/** The cheat sheet's hints as `[key, what it does]`, read from its rows. */
const hintsOf = (d) => sheetOf(d).map((line) => line.trim().split(/ {2,}/));
/** Cheat-sheet rows as the spec draws them: one hint a row, its key from the margin and what it
 *  does in a column three cells after the widest key. */
function sheet(hints) {
  const widest = Math.max(...hints.map(([key]) => textWidth(key)));
  return hints.map(([key, word]) => ` ${key}${" ".repeat(widest - textWidth(key) + 3)}${word}`);
}
/** A row of the accordion `cols` cells wide: the view's name (or what its heading holds) from the
 *  margin, its key at the right edge, one cell before it. */
const viewLine = (name, key, cols = 38) => `${` ${name}`.padEnd(cols - 1 - key.length)}${key}`;
/** A row of the list of workspaces, as cellText reads it: the name from the row's third cell and,
 *  where an instance there needs input, the dot one cell after it (`●`, or `!` in ASCII or without
 *  colour). `cols`, the sidebar's width, is the caller's to say: the row holds no more. */
const workspaceLine = (name, _cols = 38, { waiting = false, ascii = false } = {}) => `  ${name}${waiting ? ` ${ascii ? WAITING_DOT.ascii : WAITING_DOT.utf8}` : ""}`;
/** Whether every cell of row `r` from `from` up to `to` is drawn in reverse video and bold: the open
 *  workspace's row of the list of workspaces while the list does not have the focus. */
const barred = (d, r, from, to) => d.cells[r].slice(from, to).every((cell, x) => reversed(d.cells[r], from + x) && (cell.width === 0 ? d.cells[r][from + x - 1] : cell).style.bold);
/** The open workspace's row, `cols` wide, in bold reverse video across it but for its dot, if it has
 *  one, a gap in the bar: the dot stands on the normal background. */
const openBarred = (d, cols) => {
  const dot = d.cells[0].slice(0, cols).findIndex((cell) => cell.text === WAITING_DOT.utf8 || cell.text === WAITING_DOT.ascii);
  return dot < 0 ? barred(d, 0, 0, cols) : barred(d, 0, 0, dot) && d.cells[0][dot].style.reverse !== true && barred(d, 0, dot + 1, cols);
};
/** One of the sidebar's rules, `cols` cells. */
const ruleLine = (cols, ascii = false) => glyphsOf(ascii).rule.repeat(cols);
/** The sidebar of the Instances view as the spec stacks it from the top: the list of workspaces
 *  (its one row, the open workspace's, `title`), an empty row,
 *  the open view's heading and its list, a rule, the two closed views, a rule, the cheat sheet. */
const instancesSide = (title, list, hints, { cols = 38, ascii = false } = {}) => [title, "", viewLine("Instances", "1", cols), ...list, ruleLine(cols, ascii), viewLine("Souls", "2", cols), viewLine("Capabilities", "3", cols), ruleLine(cols, ascii), ...sheet(hints)];
/** A frame from its two sides: the sidebar's rows, each `cols` cells, the rule column, and the
 *  main area's rows, over `rows` rows. */
const beside = (side, main, { bar = "│", rows = 24, cols = 38 } = {}) => Array.from({ length: rows }, (_, i) => `${(side[i] ?? "").padEnd(cols)}${bar}${main[i] ?? ""}`);
/** Move the selection to the instance called `name`, with the keys a person has. */
function selecting(state, name, sz = S80) {
  let next = press(state, ["g"], sz).state;
  for (let i = 0; i < 400 && !String(next.selected).endsWith(`/${name}`); i++) next = press(next, ["j"], sz).state;
  assert.equal(String(next.selected).endsWith(`/${name}`), true, `${name} can be selected`);
  return next;
}
/** The detail as facts: `{ title, focused, facts: [{ label, col, rows: [value row, …] }] }`, read
 *  from its lines by where a label and a value stand. */
function factsOf(lines) {
  const title = lines[0].trim(), focused = title.startsWith("> ");
  const labelCol = lines[0].indexOf(focused ? title.slice(2) : title);
  const facts = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const at = line.search(/\S/);
    if (at === labelCol) {
      const label = line.trim().split(" ")[0], rest = line.slice(labelCol + label.length);
      facts.push({ label, col: labelCol + label.length + rest.search(/\S/), rows: [rest.trim()] });
    } else facts.at(-1).rows.push(line.trim()), assert.equal(at, facts.at(-1).col, "a wrapped row stands under its fact's value");
  }
  return { title: focused ? title.slice(2) : title, focused, facts };
}
const fact = (detail, label) => detail.facts.find((f) => f.label === label) ?? null;
const labels = (detail) => detail.facts.map((f) => f.label);
/** An observed entry whose souls are in `team`, through the same shared calls helpers.mjs makes. */
function observedIn(rows, { team, workspace = "acme-platform" } = {}) {
  const document = rosterOf(rows, { team }), listed = rosterRows(document, CLI);
  const answers = listed.map((row) => ({ running: row.running, runtimeState: row.runtimeState, ...(row.runtimeError ? { runtimeError: row.runtimeError } : {}), tmux: row.tmux }));
  return observedEntry({ roster: document, workspaceStatus: { workspace: { name: workspace } }, observedAt: "2026-10-11T10:00:00.000Z" }, panelInstances(listed, answers), "2026-10-11T10:00:01.000Z");
}
/** What the liveness collector prints for a row: the answers the shared home documents for it
 *  (liveness.mjs `observeLiveness`, a program a test of the TUI does not load), in its order. A row
 *  of a session backend OATS no longer has, which a kernel reports with its own reason, is not
 *  probed and reads unsupported with that reason; a row the kernel answered `running: null` is not
 *  probed either and keeps the kernel's state and text; any other row is probed, and the probe
 *  agrees with the kernel unless `found(row)` says what it found instead. */
const collector = (found = () => ({})) => (row) => (row.runtimeState === "unsupported" && row.runtimeError ? { running: null, runtimeState: "unsupported", runtimeError: row.runtimeError, tmux: null }
  : row.running === null ? { running: null, runtimeState: row.runtimeState ?? "unreachable", ...(row.runtimeError ? { runtimeError: row.runtimeError } : {}) }
    : { tmux: row.tmux, running: row.running, runtimeState: row.runtimeState, ...found(row) });
/** An observed entry made by one read cycle as lib/read.mjs runs it, every step a shared function:
 *  the kernel's rows, the collector's input as the JSON it is given, what it printed, the answers,
 *  the panel's rows. Who gave a row's text is decided on this path (`livenessAnswers`, then
 *  `panelInstances`) and on no other: helpers.mjs `observed` hands `panelInstances` answers it
 *  made itself, so a text in one of its rows carries no speaker where a read would name one. A
 *  test about who gave a text makes its rows here. */
function readCycle(kernelRows, { collect = collector(), withheld } = {}) {
  const document = rosterOf(kernelRows, { withheld }), rows = rosterRows(document, CLI);
  const answers = livenessAnswers(rows, JSON.stringify(JSON.parse(JSON.stringify(livenessInput(rows))).map(collect)));
  return observedEntry({ roster: document, workspaceStatus: { workspace: { name: "acme-platform" } }, observedAt: "2026-10-11T09:59:00.000Z" }, panelInstances(rows, answers), "2026-10-11T10:00:00.000Z");
}
/** The state of a deployment as the shared home words it, for a state of the store. */
const sharedState = (state) => deploymentState(primaryDeployment(panelOf(state, AT).deployments));
const panelRow = (state, name) => panelOf(state, AT).instances.find((row) => row.instance === name);

// ── The fixture: one small roster, fixed. A cluster of three levels with a stopped leaf, a second
// cluster with two waiting rows, two single instances (one the kernel answered `running: null`),
// and one row the reader withheld. Kernel text here is ASCII.
//
// No test here says which GROUP a row is in, or where it stands among the groups, while a part of
// its cluster is hidden by a collapse or by the filter: the shared grouping decides that, and it is
// about to decide it differently (awebai/oats#971). The golden frames therefore draw the roster
// with nothing hidden, and a collapse is drawn cell for cell only over a roster of ONE cluster and
// no single instance, where there is no other group for the root to stand among.
const QUESTION = Object.freeze({ since: "2026-10-11T09:56:00.000Z", producer: "claude", reason: "question", message: "Which base should it use?" });
const UNREACHABLE = "E_TMUX_UNREACHABLE: no server running on /tmp/tmux-1000/default";
const KERNEL_EXPERT = "acme-ledger-expert-retire", KERNEL_DEV = "acme-ledger-developer-note-target", REVIEWER = "peer-reviewer-note";
const DESKTOP_EXPERT = "acme-console-expert-tui-read", DESKTOP_A = "acme-console-developer-panel", DESKTOP_B = "acme-console-developer-terms";
const MAINTAINER = "acme-maintainer-ops", EXPERT_TUI = "acme-expert-tui";
const ROSTER = () => [
  instanceRow("acme-ledger-expert", KERNEL_EXPERT),
  instanceRow("acme-ledger-developer", KERNEL_DEV, { parentInstance: KERNEL_EXPERT, waitingOnYou: { ...QUESTION } }),
  instanceRow("peer-reviewer", REVIEWER, { parentInstance: KERNEL_DEV, running: false, runtimeState: "stopped" }),
  instanceRow("acme-console-expert", DESKTOP_EXPERT),
  instanceRow("acme-console-developer", DESKTOP_A, { parentInstance: DESKTOP_EXPERT, waitingOnYou: { since: "2026-10-11T09:58:00.000Z", producer: "claude", reason: "permission" } }),
  instanceRow("acme-console-developer", DESKTOP_B, { parentInstance: DESKTOP_EXPERT, waitingOnYou: { since: "2026-10-11T08:30:00.000Z", producer: "claude", reason: "attention", message: "Ready for review." } }),
  instanceRow("acme-maintainer", MAINTAINER),
  instanceRow("acme-expert", EXPERT_TUI, { running: null, runtimeState: "unreachable", runtimeError: UNREACHABLE }),
];
const WITHHELD = [{ agent: "acme-ledger-developer", instance: "acme-ledger-developer-twin", reason: "duplicate-home" }];
const entry = () => observed(ROSTER(), { withheld: WITHHELD });
/** The roster as it arrives: everything expanded, the first row selected. */
const fresh = (options) => stateOf(entry(), options);
/** The golden state: nothing hidden, the waiting developer selected. */
const golden = (options) => selecting(fresh(options), KERNEL_DEV);
/** One cluster and no single instance, its root collapsed over the two rows that wait below it. */
const CLUSTER = () => ROSTER().slice(3, 6);
const folded = (options) => press(selecting(stateOf(observed(CLUSTER()), options), DESKTOP_EXPERT), ["h"]).state;
/** The shared home's words for the selected row's claim, as the detail's `needs` line holds them. */
const NEEDS = `${waitingLabel(QUESTION)}, ${waitedText(QUESTION.since, NOW)}`;
const STARTED = waitingClock("2026-10-11T09:00:00.000Z", NOW);
/** The leader as the cheat sheet and the help name it: tui.json's open.detachKey (the tests' C-\,
 *  helpers.mjs TEST_LEADER) spelt for people. It is the cheat sheet's first row in every focus. */
const LEADER_KEY = "Ctrl+\\";
const LEAD = Object.freeze([LEADER_KEY, "commands"]);
/** In the Ctrl+Alt family, without the kitty keyboard protocol, a terminal's cheat sheet names the
 *  Alt+Shift arrows after the leader's three. */
const ARROWS = Object.freeze([["Alt+Shift+Up/Down", "agent"]]);
/** keys.json with Ctrl+Alt chosen: the family whose chords the kitty keyboard protocol decides. */
const CTRL_ALT_READ = chordFamilyFrom('{ "chords": "ctrl+alt" }');
/** In the Alt family, the default, every chord comes without the protocol, so a terminal's cheat sheet
 *  leads with them (one tab: no tab hint). */
const FOCUS_CHORDS = Object.freeze([["Alt+K", "palette"], ["Alt+Shift+Up/Down", "agent"], ["Alt+W", "close"], ["Alt+Z", "zoom"]]);
/** The viewer's scroll key, after the leader's while a terminal has the focus (docs/tui.md, "Tabs"):
 *  Shift+PageUp alone where the panel's tmux has not said it forwards a key after C-b. */
const SCROLL_HINT = Object.freeze(["Shift+PageUp", "scroll back"]);
/** A terminal's cheat sheet with the focus in it, in the default family: its chords, then the
 *  leader, the leader then Esc, the leader twice and the viewer's scroll key. */
const FOCUS_SHEET = Object.freeze([...FOCUS_CHORDS, LEAD, [`${LEADER_KEY} Esc`, "the list"], [`${LEADER_KEY} ${LEADER_KEY}`, `types ${LEADER_KEY}`], SCROLL_HINT]);
/** The cheat sheet of the list. The selected row of the fixture runs, so Enter opens it and `open`
 *  stands after the leader and the palette; then `n spawn`, and `help` and `quit` last. The sheet
 *  is small: the acts, the list's own keys and the views are the leader's, the palette's and
 *  the help's (each row of the accordion carries its view's key). Where the rows are short the sheet
 *  gives hints up from its end: under the fixture's roster at 80x24 all six stand, at 60x15 the
 *  leader alone. */
const LIST_SHEET = Object.freeze([LEAD, ["Ctrl+K", "palette"], ["Enter", "open"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]]);
const SHEET_80 = LIST_SHEET.slice(0, 6);
/** The cheat sheet while the detail has the focus: `Tab back` after the palette, then Enter, spawn. */
const DETAIL_SHEET = Object.freeze([LEAD, ["Ctrl+K", "palette"], ["Tab", "back"], ["Enter", "open"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]]);
/** The acts the palette offers on the selected row, which are the acts whose key opens a
 *  confirmation now: the cheat sheet names none of them. */
const paletteActs = (state) => paletteItems(leaderThen(state, "k").state, AT).items.filter((item) => item.kind === "act").map((item) => item.does);
/** The cheat sheet over the help. */
const HELP_SHEET = Object.freeze([LEAD, ["Ctrl+K", "palette"], ["Esc", "close"], ["?", "help"], ["q", "quit"]]);
/** The fixture's list at 80 columns, the selected developer's row in it. */
const LIST_80 = Object.freeze([
  "  ● Acme console expert tui read",
  "    ! Acme console developer pan…",
  "    ! Acme console developer ter…",
  "",
  "  ? Acme expert tui  state unkno…",
  "",
  "  ● Acme ledger expert retire",
  ">   ! Acme ledger developer note…",
  "      ○ Peer reviewer note",
  "",
  "  ● Acme maintainer ops",
]);
/** The same in ASCII: its marks and its cut mark, which takes three cells. */
const LIST_80_ASCII = Object.freeze([
  "  * Acme console expert tui read",
  "    ! Acme console developer p...",
  "    ! Acme console developer t...",
  "",
  "  ? Acme expert tui  state unk...",
  "",
  "  * Acme ledger expert retire",
  ">   ! Acme ledger developer no...",
  "      - Peer reviewer note",
  "",
  "  * Acme maintainer ops",
]);

// ── Golden frames ────────────────────────────────────────────────────────────────────────────────

test("the Instances view at 80x24 in UTF-8, cell for cell: no header and no footer; the sidebar from the top (the list of workspaces' one row, the open workspace's in reverse video with its dot, an empty row, the open view's heading with its key, the roster, a rule, the closed views with theirs, a rule, the cheat sheet led by the leader), the rule column over the whole height, and the selected instance's detail beside it from the top row", () => {
  assert.deepEqual(draw(golden(), S80).lines, beside(instancesSide(workspaceLine("acme-platform", 38, { waiting: true }), LIST_80, SHEET_80), [
    "   acme-ledger-developer-note-target",
    "   soul     acme-ledger-developer",
    "   state    running",
    `   needs    ${NEEDS}`,
    "            the agent: \"Which base",
    "            should it use?\"",
    "   harness  claude, claude-opus-5-5 (so…",
    "   work     worktree, agents/acme-ledge…",
    "   team     eng",
    "   parent   acme-ledger-expert-retire",
    `   started  ${STARTED}`,
    "   home     …edger-developer-note-target",
  ]));
});

test("the Instances view at 80x24 in ASCII, cell for cell: the same screen with the rules, the rule column, the marks and the cut mark in ASCII", () => {
  assert.deepEqual(draw(golden({ ascii: true }), S80).lines, beside(instancesSide(workspaceLine("acme-platform", 38, { waiting: true, ascii: true }), LIST_80_ASCII, SHEET_80, { ascii: true }), [
    "   acme-ledger-developer-note-target",
    "   soul     acme-ledger-developer",
    "   state    running",
    `   needs    ${NEEDS}`,
    "            the agent: \"Which base",
    "            should it use?\"",
    "   harness  claude, claude-opus-5-5 (...",
    "   work     worktree, agents/acme-led...",
    "   team     eng",
    "   parent   acme-ledger-expert-retire",
    `   started  ${STARTED}`,
    "   home     ...ger-developer-note-target",
  ], { bar: "|" }));
});

test("at every size and in both modes the frame has its shape: the sidebar from the top row (the list of workspaces, its one row the open workspace's in bold reverse video, the open view's heading with its key, a rule after the list, the closed views, a rule, the cheat sheet led by the leader), and from 80 columns the rule column at the list's width over every row and no other bar", () => {
  for (const ascii of [false, true]) for (const sz of SIZES) {
    const d = draw(golden({ ascii }), sz), g = glyphsOf(ascii), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    const wide = sz.cols >= 80, list = listWidth(sz.cols), pane = paneOf(sz);
    assert.equal(d.cells.length, sz.rows, at);
    for (const line of d.cells) assert.equal(line.length, sz.cols, at);
    assert.equal(d.cols, pane, `${at}: the sidebar's width`);
    // The list of workspaces: the open workspace's one row, its name from the third cell and one cell
    // after it the dot of a waiting instance, in bold reverse video over the sidebar's width but for
    // the dot, which is on the normal background; no count and no time.
    assert.equal(cellText(d, 0, 0, pane), workspaceLine("acme-platform", pane, { waiting: true, ascii }), at);
    assert.equal(d.cells[0][1].style.bold, true, at);
    assert.equal(openBarred(d, pane), true, `${at}: the open workspace's row is in bold reverse video over the sidebar's width, but for its dot`);
    // The heading under an empty row; at 60x15 the empty row is given up for the list.
    const heading = sz.rows > 15 ? 2 : 1;
    assert.equal(openRow(d), heading, at);
    if (heading === 2) assert.equal(cellText(d, 1, 0, pane), "", at);
    assert.equal(cellText(d, heading, 0, pane), viewLine("Instances", "1", pane), at);
    const after = listRows(d).at(-1) + 1;
    assert.deepEqual([0, 1, 2, 3].map((i) => cellText(d, after + i, 0, pane)), [ruleLine(pane, ascii), viewLine("Souls", "2", pane), viewLine("Capabilities", "3", pane), ruleLine(pane, ascii)], at);
    // The cheat sheet in the rows that are left, the leader first.
    assert.deepEqual(sheetOf(d), sheet(LIST_SHEET.slice(0, sz.rows - after - 4)), at);
    assert.equal(sheetOf(d)[0], ` ${LEADER_KEY}   commands`, `${at}: the leader first`);
    // One rule column, on every row, and nowhere else; no rule reaches into the main area.
    for (const r of bodyRows(sz)) {
      if (wide) assert.equal(d.cells[r][list].text, g.bar, `${at}: row ${r} has the rule column at column ${list}`);
      if (!ascii) assert.equal(d.cells[r].filter((cell) => cell.text === g.bar).length, wide ? 1 : 0, `${at}: row ${r}`);
      if (wide) assert.equal(cellText(d, r, list + 1).includes(g.rule.repeat(2)), false, `${at}: row ${r}: no rule in the main area`);
    }
    assert.equal(d.page, sz.rows - 7, `${at}: the list's page is what the list of workspaces' one row, the three views, the two rules and the leader's row leave`);
  }
});

test("from 80 columns up the list takes clamp(floor(cols x 0.48), 36, 60) cells, one column is the rule, and the detail has the rest", () => {
  for (const [cols, list] of [[80, 38], [81, 38], [84, 40], [100, 48], [120, 57], [125, 60], [126, 60], [200, 60]]) {
    assert.equal(listWidth(cols), list);
    const sz = size(cols, 24), d = draw(golden(), sz);
    assert.equal(d.cols, list, `${cols}`);
    for (const r of bodyRows(sz)) assert.equal(d.cells[r][list].text, "│", `${cols}: row ${r}: the rule column runs over every row, with no joint`);
    const selected = rowAt(golden(), sz, KERNEL_DEV), mark = waitMarkAt(d, selected);
    // The selected row's bar is the list: every cell of it but its needs-input mark, and none past it.
    assert.deepEqual(mark, { col: 4, style: TAG_SELECTED }, `${cols}: the selected developer waits`);
    assert.deepEqual(d.cells[selected].map((cell) => cell.style.reverse), Array.from({ length: cols }, (_, x) => x < list && x !== mark.col), `${cols}`);
    // The detail starts after the rule, on the top row, and ends inside the screen.
    const title = d.cells[0].slice(list + 1).map((cell) => cell.text).join("");
    assert.equal(title.trim(), KERNEL_DEV, `${cols}`);
    assert.equal(cellText(d, 0, 0, list), workspaceLine("acme-platform", list, { waiting: true }), `${cols}: nothing of the detail is in the sidebar`);
  }
});

test("at 120x40 the names have room: the same roster with the names whole, the detail's lines uncut, and the whole cheat sheet under the views", () => {
  assert.deepEqual(draw(golden(), S120).lines, beside(instancesSide(workspaceLine("acme-platform", 57, { waiting: true }), [
    "  ● Acme console expert tui read",
    "    ! Acme console developer panel",
    "    ! Acme console developer terms",
    "",
    "  ? Acme expert tui                    state unknown",
    "",
    "  ● Acme ledger expert retire",
    ">   ! Acme ledger developer note target",
    "      ○ Peer reviewer note",
    "",
    "  ● Acme maintainer ops",
  ], LIST_SHEET, { cols: 57 }), [
    "   acme-ledger-developer-note-target",
    "   soul     acme-ledger-developer",
    "   state    running",
    `   needs    ${NEEDS}`,
    "            the agent: \"Which base should it use?\"",
    "   harness  claude, claude-opus-5-5 (soul)",
    "   work     worktree, agents/acme-ledger-developer-note-targ…",
    "   team     eng",
    `   parent   ${KERNEL_EXPERT}`,
    `   started  ${STARTED}`,
    "   home     …oper/instances/acme-ledger-developer-note-target",
  ], { rows: 40, cols: 57 }));
});

test("at 79x24 the sidebar takes the whole width: no rule column, no detail beside it, and the waiting marks and the views' keys at the right edge", () => {
  const d = draw(golden(), S79);
  assert.deepEqual(d.lines, instancesSide(workspaceLine("acme-platform", 79, { waiting: true }), [
    "  ● Acme console expert tui read",
    "    ! Acme console developer panel",
    "    ! Acme console developer terms",
    "",
    "  ? Acme expert tui                                          state unknown",
    "",
    "  ● Acme ledger expert retire",
    ">   ! Acme ledger developer note target",
    "      ○ Peer reviewer note",
    "",
    "  ● Acme maintainer ops",
  ], SHEET_80, { cols: 79 }));
  assert.deepEqual(d.cells[10].map((cell) => cell.style.reverse), Array.from({ length: 79 }, (_, x) => x !== 4), "the selected row's bar is the whole width but for its needs-input mark");
  assert.deepEqual([4, 10].map((r) => [d.cells[r][4].text, d.cells[r][4].style]), [["!", TAG], ["!", TAG_SELECTED]], "a waiting row's state mark is the needs-input mark");
  assert.deepEqual([4, 10].map((r) => cellText(d, r, 79 - 5)), ["", ""], "and no tag at its edge");
  for (const line of d.lines) assert.equal(line.includes("soul "), false, "no detail is drawn beside the list");
});

test("at 60x15, the smallest size drawn, the frame keeps its shape and the roster is still read: the cheat sheet gives its rows up down to the leader, the empty row under the list of workspaces goes, and the list scrolls in what is left", () => {
  const d = draw(golden(), S60);
  assert.deepEqual(d.lines, [
    workspaceLine("acme-platform", 60, { waiting: true }),
    viewLine("Instances", "1", 60),
    "    ! Acme console developer panel",
    "    ! Acme console developer terms",
    "",
    "  ? Acme expert tui                       state unknown",
    "",
    "  ● Acme ledger expert retire",
    ">   ! Acme ledger developer note target",
    `   ${cutNote(1, 3)}`,
    ruleLine(60), viewLine("Souls", "2", 60), viewLine("Capabilities", "3", 60), ruleLine(60),
    ...sheet([LEAD]),
  ]);
  assert.equal(d.page, 8, "the list scrolls in the rows the list of workspaces, the views, the rules and the leader's row leave it");
});

test("at 60x15 the short height is shared in the spec's order: the cheat sheet gives rows up from its end down to the leader, then the empty row under the list of workspaces goes, and only then does the list scroll", () => {
  for (let n = 1; n <= 10; n++) {
    const names = Array.from({ length: n }, (_, i) => `dev-${i}`), d = draw(stateOf(observed(names.map((name) => instanceRow("dev", name)))), S60), at = `${n} instances`;
    // The rows the list of workspaces' one row, the three views and the two rules leave: nine, the list's and the sheet's.
    const empty = n <= 7;
    assert.equal(cellText(d, 1), empty ? "" : viewLine("Instances", "1", 60), `${at}: ${empty ? "the empty row stays" : "the empty row is given up"}`);
    assert.equal(listRows(d).length, Math.min(n, 8), at);
    const drawn = listLines(d).filter((line) => /Dev \d/.test(line)).length;
    assert.equal(drawn, n <= 8 ? n : 7, `${at}: every instance, until the list scrolls`);
    if (n > 8) assert.equal(listLines(d).at(-1).trim(), cutNote(0, n - 7), `${at}: and its last row says what is cut off`);
    assert.deepEqual(sheetOf(d), sheet(LIST_SHEET.slice(0, empty ? 8 - n : 1)), `${at}: the cheat sheet in what is left, from its first row, the leader always`);
  }
});

test("a view answers exactly as many rows as the terminal has, and every span is safe text or a fill, at a cell index, in a style value: at every size, also 3000 columns wide and too small", () => {
  const tabbed = press(golden(), ["tab"]).state, helping = press(golden(), ["?"]).state;
  const filtered = press(fresh(), ["/", "z", "z", "z"]).state;
  const states = {
    list: golden(), "list, ascii": golden({ ascii: true }), collapsed: folded(), detail: tabbed, help: helping, "help, ascii": press(golden({ ascii: true }), ["?"]).state,
    reading: stateOf(), none: stateOf(observed([])), "no match": filtered,
    stale: stateOf(failed(entry(), { code: "E_REMOTE_UNREADABLE", message: "the mirror did not answer" })),
    unavailable: stateOf(failed(entry(), { code: "E_SOMETHING_NEW", message: "a refusal nobody has seen" })),
    "unavailable, the kernel's own refusal": stateOf(failed(entry(), REFUSED("a refusal nobody has seen"))),
    "this machine and another": reached(), "a machine not reached": lost(), "a machine with no row": rowless(),
    "the switcher": choosing(), "the switcher, nothing to list": stateOf(null, { deployment: null }), "the help over the switcher": press(choosing(), ["?"]).state,
    "the switcher, with all the list puts in it": listing(),
  };
  for (const [name, state] of Object.entries(states)) for (const sz of [...SIZES, size(3000, 24), size(200, 60), size(59, 15), size(60, 14), size(20, 3)]) {
    const d = draw(state, sz), at = `${name} at ${sz.cols}x${sz.rows}`;
    assert.equal(d.rows.length, sz.rows, at);
    for (const spans of d.rows) for (const span of spans) {
      assert.equal(Number.isInteger(span.col) && span.col >= 0, true, `${at}: a column is a cell index`);
      if (Object.hasOwn(span, "text")) assert.equal(isSafeText(span.text), true, `${at}: text is lit() or shown()`);
      else assert.equal(Number.isInteger(span.width) && span.width >= 0, true, `${at}: a span without text is a fill of a width`);
      if (span.width !== undefined) assert.equal(Number.isInteger(span.width) && span.width >= 0, true, `${at}: a width is a number of cells`);
      if (span.style !== undefined) assert.equal(isStyle(span.style), true, `${at}: a style is a style value`);
    }
    assert.equal(Number.isInteger(d.page) && d.page >= 1 && Number.isInteger(d.extent) && Number.isInteger(d.room) && d.room >= 1, true, at);
  }
});

test("on a terminal 3000 columns wide the sidebar stays 60 cells, its rules 60 cells, the rule column runs over every row, and the list of workspaces' one row is the open workspace's, its dot at the sidebar's edge", () => {
  const sz = size(3000, 24), d = draw(golden(), sz);
  assert.equal(d.cols, 60);
  for (const r of bodyRows(sz)) {
    assert.equal(d.cells[r][60].text, "│", `row ${r}`);
    assert.equal(d.cells[r].length, 3000, `row ${r}`);
  }
  assert.equal(cellText(d, 0, 0, 60), workspaceLine("acme-platform", 60, { waiting: true }));
  assert.equal(openBarred(d, 60), true, "the open workspace's row is in bold reverse video over the sidebar's 60 cells, but for its dot");
  assert.equal(d.cells[0].slice(61).some((cell) => cell.style.reverse), false, "and not past the sidebar");
  assert.equal(cellText(d, 14), `${"─".repeat(60)}│`, "row 14: the rule after the list, the sidebar's width, and nothing past the rule column");
  assert.deepEqual(sheetOf(d), sheet(SHEET_80));
});

test("in ASCII nothing on the screen is outside printable ASCII: the list, the detail, the help and each empty state, at every size", () => {
  const options = { ascii: true };
  const states = {
    list: golden(options), collapsed: folded(options), "collapsed, detail": press(folded(options), ["tab"]).state, detail: press(golden(options), ["tab"]).state, help: press(golden(options), ["?"]).state,
    "help, at its end": press(golden(options), ["?", "G"], S60).state,
    reading: stateOf(null, options), none: stateOf(observed([]), options), "no match": press(fresh(options), ["/", "z", "z", "z"]).state,
    "a kept filter": press(fresh(options), ["/", "t", "u", "i", "enter"]).state,
    stale: stateOf(failed(entry(), { code: "E_REMOTE_UNREADABLE", message: "the mirror did not answer" }), options),
    unavailable: stateOf(failed(entry(), { code: "E_SOMETHING_NEW", message: "a refusal nobody has seen" }), options),
    "unavailable, the kernel's own refusal": stateOf(failed(entry(), REFUSED("a refusal nobody has seen")), options),
    // Other machines, and the switcher of a workspace on this machine alone: a workspace on two
    // machines is listed with the shared home's own separator between them, which is not ASCII
    // and is not the TUI's (the switcher's ASCII golden frame says what is drawn there).
    "this machine and another": reached(options), "a machine not reached": lost(options), "a machine with no row": rowless(options),
    "the switcher": reduce(press(local(options), ["w", "w"]).state, { listed: LISTED }).state, "the switcher, nothing to list": stateOf(null, { deployment: null, ...options }),
    "the switcher, with all the list puts in it": listing(reduce(press(local(options), ["w", "w"]).state, { listed: LISTED }).state),
    // A kernel's message too long for the lead's rows: cut on its last row with the ASCII cut mark.
    "the switcher, a failed read's message cut": reduce(press(local(options), ["w", "w"]).state, { listed: { failure: { code: "E_DEPLOYMENTS_INVALID", message: "a message far too long to stand whole ".repeat(20) } } }).state,
  };
  for (const [name, state] of Object.entries(states)) for (const sz of [...SIZES, size(200, 60), size(59, 15)]) {
    const d = draw(state, sz);
    d.cells.forEach((line, r) => line.forEach((cell, x) => assert.match(cell.text, /^[\x20-\x7e]$/, `${name} at ${sz.cols}x${sz.rows}: row ${r}, column ${x}`)));
    for (const line of d.lines) assert.match(line, PRINTABLE_ASCII);
  }
});

test("in ASCII a held row's own words end in three full stops, never an ellipsis: the list's word, the detail's state, the help and a start's line (#1247)", () => {
  const rows = [instanceRow("dev", "dev-retiring", { retirePending: true }), instanceRow("dev", "dev-spawning", { spawnInProgress: true, running: false, runtimeState: "stopped" })];
  const sz = size(200, 110); // tall enough for the help's marks, under the leader's table (with the split's keys) and the spawn prompt's
  for (const ascii of [true, false]) {
    const at = `ascii ${ascii}`, list = stateOf(observed(rows), { ascii });
    const screens = { list, detail: press(list, ["tab"]).state, help: press(list, ["?"]).state };
    for (const [name, state] of Object.entries(screens)) {
      const text = draw(state, sz).lines.join("\n");
      assert.equal(text.includes(ascii ? "Retiring..." : "Retiring\u2026"), true, `${at}, ${name}: ${text}`);
      if (ascii) for (const line of draw(state, sz).lines) assert.match(line, PRINTABLE_ASCII, `${at}, ${name}`);
    }
    const lines = draw(list, sz).lines;
    // The spawning row's word: whole in UTF-8; in ASCII two cells wider than the column's WORD_MAX, so cut, with the ASCII cut mark.
    assert.equal(lines.some((line) => line.includes(ascii ? "Setting up worktr..." : "Setting up worktree\u2026")), true, `${at}: the spawning row's word`);
    const detail = draw(screens.detail, sz).lines.find((line) => /\bstate\b/.test(line) && line.includes("Retiring"));
    assert.ok(detail, `${at}: the detail's state is the list row's word`);
  }
});

test("without colour the screen is the same and still says everything: the bytes carry attributes only, and each state keeps a mark of its own shape", () => {
  const d = draw(golden(), S80);
  const coloured = readTerminalOutput(createScreen().render(d.rows, S80, { full: true }));
  const plain = readTerminalOutput(createScreen({ color: false }).render(d.rows, S80, { full: true }));
  assert.deepEqual(plain.foreign, []);
  assert.equal(plain.text, coloured.text, "the same cells");
  for (const { kind, body } of plain.sequences) if (kind === "sgr") assert.match(body, /^(?:[01247])(?:;[01247])*m$/, "an attribute, never a colour");
  for (const marks of [MARKS.utf8, MARKS.ascii]) assert.equal(new Set([marks.running, marks.stopped, marks.shell, marks.unknown, marks.held]).size, 5, "five states, five shapes");
});

// ── The empty states ─────────────────────────────────────────────────────────────────────────────

test("each empty state says so in one line of the list, in the TUI's words: before the first answer, with no instance (`No agents yet` and the key that spawns one), and with a filter that matches none", () => {
  assert.deepEqual({ ...EMPTY_TEXT }, { reading: "Reading the deployment.", none: "No agents yet", nomatch: "No instance matches the filter." });
  const cases = [
    [() => stateOf(), "Reading the deployment."],
    [() => stateOf(observed([])), `${EMPTY_TEXT.none}: n spawns one`],
    [() => press(fresh(), ["/", "z", "z", "z"]).state, "No instance matches the filter."],
    [() => press(fresh(), ["/", "z", "z", "z", "enter"]).state, "No instance matches the filter."],
  ];
  for (const [make, sentence] of cases) for (const sz of SIZES) {
    const d = draw(make(), sz), at = `${sentence} at ${sz.cols}x${sz.rows}`;
    const said = listLines(d, sz).map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(said, [sentence], `${at}: the list holds that line and nothing else`);
    for (const cell of d.cells[listRows(d)[0]].slice(0, d.cols).filter((c) => c.text !== " ")) assert.equal(cell.style, DIM, `${at}: dim`);
    assert.deepEqual(detailLines(d, sz).filter((line) => sz.cols >= WIDE && line.trim() !== ""), [], `${at}: and no detail`);
    assert.equal(d.lines.some((line) => /\bacme-\w+-/.test(line)), false, `${at}: no instance row`);
  }
});

test("the no-instances line names the key the user's table gives spawn, and says `No agents yet.` alone while spawn has no key", () => {
  for (const sz of SIZES) {
    const said = (keys) => listLines(draw(stateOf(observed([]), { actions: effectiveConfig({ keys }).actions }), sz)).map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(said({}), ["No agents yet: n spawns one"], `${sz.cols}x${sz.rows}`);
    assert.deepEqual(said({ spawn: ["f2"] }), ["No agents yet: F2 spawns one"], `${sz.cols}x${sz.rows}`);
    assert.deepEqual(said({ spawn: [] }), ["No agents yet."], `${sz.cols}x${sz.rows}`);
  }
});

test("before the first answer the list holds the TUI's own line and not the shared sentence for that moment, which names an installed CLI the TUI does not use", () => {
  const state = stateOf(), detail = sharedState(state).detail;
  assert.equal(typeof detail === "string" && detail.length > 0, true, "the shared home has a sentence for a pending deployment");
  for (const sz of SIZES) {
    // The words of the shared sentence that the TUI's own line does not use: none is on the screen.
    const d = draw(state, sz), own = EMPTY_TEXT.reading.toLowerCase(), words = textOf(shown(detail)).split(" ").filter((word) => word.length > 2 && !own.includes(word.toLowerCase()));
    assert.equal(words.length >= 3, true, "the shared sentence says more than the TUI's line");
    for (const line of d.lines) for (const word of words) assert.equal(line.includes(word), false, `${sz.cols}x${sz.rows}: ${word}`);
  }
});

test("the accordion is navigation, in every state: Instances, Souls and Capabilities in that order, each with its key dim at the right edge of the sidebar, the open view's name in bold, the others plain, none in reverse (QA note 1)", () => {
  const states = [stateOf(), stateOf(observed([])), press(fresh(), ["/", "z", "z", "z"]).state, golden(), press(golden(), ["?"]).state, stateOf(failed(entry(), { code: "E_SOMETHING_NEW", message: "no" })), stateOf(failed(entry(), REFUSED("no")))];
  for (const state of states) for (const sz of SIZES) {
    // Under 80 columns the help has the whole screen: no sidebar is drawn beside it.
    if (state.view === "help" && sz.cols < WIDE) continue;
    const d = draw(state, sz), pane = d.cols, at = `${sz.cols}x${sz.rows} ${state.view}`;
    const rows = VIEW_ROWS.map(([name, key]) => d.cells.findIndex((line, r) => r > 0 && line[pane - 2].text === key && line[pane - 2].style.dim && (cellText(d, r, 1, 1 + name.length) === name || line[1].text === "/")));
    assert.equal(rows[0] > 0 && rows[0] < rows[1] && rows[1] < rows[2], true, `${at}: the three views, in their order: ${rows}`);
    VIEW_ROWS.forEach(([name], i) => {
      const line = d.cells[rows[i]];
      assert.equal(line.slice(0, pane).some((cell) => cell.style.reverse), false, `${at}: ${name} is not in reverse`);
      if (line[1].text === "/") return; // the open view's heading is the filter field while one is typed
      assert.equal(cellText(d, rows[i], 0, pane), viewLine(name, VIEW_ROWS[i][1], pane), at);
      for (const cell of line.slice(1, 1 + name.length)) assert.deepEqual(cell.style, i === 0 ? style({ bold: true }) : PLAIN, `${at}: ${name} ${i === 0 ? "is the open view, in bold" : "is plain, not dim"}`);
    });
  }
});

// ── The open workspace's row of the list of workspaces ─────────────────────────────────────────

test("the list of workspaces' row of the open workspace is the workspace's name from its third cell, in bold reverse video, and the dot of a waiting instance, nothing else: no count of the instances stands anywhere on the screen", () => {
  const d = draw(stateOf(observed(ROSTER(), { withheld: WITHHELD, workspace: "another-workspace" })), S120);
  assert.equal(cellText(d, 0, 0, d.cols), workspaceLine("another-workspace", 57, { waiting: true }));
  for (const cell of d.cells[0].slice(0, 20)) assert.deepEqual(cell.style, style({ bold: true, reverse: true }));
  for (const line of d.lines) assert.doesNotMatch(line, /\b\d+ (running|stopped|unknown|withheld|needs? input)\b/, line);
});

test("no count is drawn for a roster of any kind: running, stopped, or none", () => {
  const states = [stateOf(observed([instanceRow("soul", "one"), instanceRow("soul", "two")])), stateOf(observed([instanceRow("soul", "one", { running: false, runtimeState: "stopped" })])), stateOf(observed([]))];
  for (const state of states) for (const sz of SIZES) {
    const d = draw(state, sz);
    assert.equal(cellText(d, 0, 0, d.cols), workspaceLine("acme-platform"), "the open workspace's row of the list of workspaces is its name alone");
    for (const line of d.lines) assert.doesNotMatch(line, /\b\d+ (running|stopped|unknown|withheld)\b|\b0 /, line);
  }
});

test("waiting instances are not counted on the screen: each waiting row carries its own mark, and no words", () => {
  const waiting = (n) => Array.from({ length: 3 }, (_, i) => instanceRow("soul", `dev-${i}`, i < n ? { waitingOnYou: { ...QUESTION } } : {}));
  for (const n of [0, 1, 2]) {
    const d = draw(stateOf(observed(waiting(n))), S80);
    for (const line of d.lines) assert.doesNotMatch(line, /needs? input/, `${n}: ${line}`);
    assert.equal(listLines(d).filter((line) => /^[> ] ! /.test(line)).length, n, `${n} waiting`);
    assert.equal(listLines(d).some((line) => line.includes(NEEDS_INPUT)), false, `${n}: no row says it in words`);
  }
});

test("a withheld row is never drawn as a row nor counted beside the list, and the help's top row counts it", () => {
  const d = draw(fresh(), S120);
  for (const line of d.lines) assert.equal(line.includes("acme-ledger-developer-twin") || line.includes("Acme ledger developer twin") || line.includes("withheld"), false, line);
  const help = draw(press(fresh(), ["?"], S120).state, S120);
  assert.equal(cellText(help, 0, help.cols + 1), "   read 10:00:00  1 withheld");
  const none = draw(press(stateOf(observed(ROSTER())), ["?"], S120).state, S120);
  assert.equal(cellText(none, 0, none.cols + 1), "   read 10:00:00", "with no row withheld the row says nothing of it");
});

test("the time of the read, `read HH:MM:SS`, is the help's top row, dim at its third cell, only when the deployment is live and with the cycle's own time; nothing beside the list says it", () => {
  const at = (iso, observedAt) => stateOf(observed(ROSTER(), { at: iso, observedAt }));
  /** The help's top row: in the main area from 80 columns, from column 0 under them (where the keys stand at its right). */
  const top = (state, sz) => { const d = draw(press(state, ["?"], sz).state, sz), from = sz.cols >= WIDE ? d.cols + 2 : 0; return { d, from, text: cellText(d, 0, from) }; };
  assert.equal(top(at("2026-10-11T14:03:27.000Z", "2026-10-11T14:02:27.000Z"), S80).text, "  read 14:03:27");
  assert.equal(top(at("2026-10-11T00:00:09.000Z", "2026-10-10T23:59:09.000Z"), S60).text.startsWith("  read 00:00:09  "), true);
  for (const sz of SIZES) {
    const live = at("2026-10-11T14:03:27.000Z", "2026-10-11T14:02:27.000Z"), { d, from } = top(live, sz);
    for (const cell of d.cells[0].slice(from + 2, from + 15)) assert.equal(cell.style, DIM, `${sz.cols}x${sz.rows}: dim`);
    assert.equal(draw(live, sz).lines.some((line) => /read \d\d:/.test(line)), false, `${sz.cols}x${sz.rows}: no time beside the list`);
  }
  // Kept over a failed read, the entry says since when by the same time: its last good read, on the state's row under the list of workspaces.
  const kept = stateOf(failed(observed(ROSTER(), { at: "2026-10-11T14:03:27.000Z", observedAt: "2026-10-11T14:02:27.000Z" }), { code: "E_REMOTE_UNREADABLE", message: "no" }, "2026-10-11T14:09:00.000Z"));
  assert.equal(sharedState(kept).key, "stale");
  for (const sz of SIZES) { const d = draw(kept, sz); assert.equal(cellText(d, 1, 0, d.cols).endsWith(" since 14:03:27"), true, `${sz.cols}x${sz.rows}: stale since the last good read`); }
  const notLive = [stateOf(), stateOf(failed(entry(), { code: "E_REMOTE_UNREADABLE", message: "no" })), stateOf(failed(entry(), { code: "E_SOMETHING_NEW", message: "no" })), stateOf(failed(entry(), REFUSED("no")))];
  for (const state of notLive) for (const sz of SIZES) {
    assert.notEqual(sharedState(state).key, "live");
    assert.equal(/read \d/.test(top(state, sz).text), false, `${sz.cols}x${sz.rows}: no read time`);
  }
});

// ── The not-observed reason ──────────────────────────────────────────────────────────────────────

/** The rows that hold the reason: the rows of the sidebar from `from`, under the state's row (the
 *  list of workspaces' rows, one where there is one workspace, then the state's), whose every cell
 *  of the sidebar, read from the cell buffer, is the next piece of `line` (the reason's display
 *  line). Nothing but the reason can be on such a row: a rule glyph, a time, a name or a word of
 *  the TUI's is not a piece of it. */
function reasonRows(d, line, cut, from = 2) {
  const rows = [];
  let rest = line, whole = false, cutShort = false;
  for (let r = from; r < d.cells.length && rows.length < 4; r++) {
    const text = d.cells[r].slice(0, d.cols).map((cell) => cell.text).join("").trim();
    if (text === "") break;
    if (rest === text) { rows.push(r); whole = true; break; }
    if (rest.startsWith(`${text} `)) { rows.push(r); rest = rest.slice(text.length + 1); continue; }
    if (text.endsWith(cut) && text.length > cut.length && rest.startsWith(text.slice(0, -cut.length).trimEnd())) { rows.push(r); cutShort = true; }
    break;
  }
  return { rows, whole, cutShort };
}
const STALE = (message) => ({ code: "E_REMOTE_UNREADABLE", message });
const UNAVAILABLE = (message) => ({ code: "E_SOMETHING_NEW", message });
/** The same failure as the kernel's own refusal: the shared reader marks the error the CLI printed
 *  (deployment-read-cli.mjs), and the shared sentence then says who speaks. A reason without the
 *  mark, as the two above, is one the reader made itself. */
const REFUSED = (message) => ({ ...UNAVAILABLE(message), origin: "kernel" });
const marked = (make) => (make("").origin ? ", marked as the kernel's" : "");
const SHORT_REASON = "the mirror at build-7 did not answer in time";
const LONG_REASON = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");

test("the not-observed reason of a stale deployment is the shared state's detail through shown(), on rows of its own under the state and its time, with the last observation still drawn below", () => {
  for (const ascii of [false, true]) for (const sz of SIZES) {
    const state = stateOf(failed(entry(), STALE(SHORT_REASON)), { ascii }), shared = sharedState(state), d = draw(state, sz), at = `${sz.cols}x${sz.rows}`;
    assert.equal(shared.key, "stale");
    assert.equal(shared.detail.includes(SHORT_REASON), true, "the detail carries the message the test chose");
    const line = textOf(shown(shared.detail)), reason = reasonRows(d, line, glyphsOf(ascii).cut);
    assert.equal(reason.whole, true, `${at}: the rows of the reason, joined with a space, are the detail's display line`);
    assert.equal(reason.rows[0], 2, `${at}: the reason starts on the row under the state`);
    // The row above, under the list of workspaces: the state in the shared home's word and the time of the last good read.
    const above = cellText(d, 1, 0, d.cols);
    assert.equal(above.startsWith(` ${shared.text}`), true, at);
    assert.equal(above.endsWith("since 10:00:00"), true, at);
    assert.equal(above.replace(shared.text, "").replace("since 10:00:00", "").trim(), "", `${at}: and nothing else`);
    // Nothing of the TUI's leads the reason, and no line attributes it.
    assert.equal(d.cells[2].find((cell) => cell.text !== " ").text, line[0], at);
    for (const text of d.lines) assert.equal(text.includes("the kernel:"), false, at);
    // Below it, the rows of the last observation.
    const below = d.lines.slice(reason.rows.at(-1) + 1);
    assert.equal(below.some((text) => text.includes("Acme ledger expert") || text.includes("Acme console expert")), true, `${at}: the last observation is still drawn`);
  }
});

test("the not-observed reason of an unavailable deployment is the shared state's detail through shown(), on rows of its own under the state, and no instance row is drawn", () => {
  for (const make of [UNAVAILABLE, REFUSED]) for (const ascii of [false, true]) for (const sz of SIZES) {
    const state = stateOf(failed(entry(), make(SHORT_REASON)), { ascii }), shared = sharedState(state), d = draw(state, sz), at = `${sz.cols}x${sz.rows}${marked(make)}`;
    assert.equal(shared.key, "unobserved");
    assert.equal(shared.detail.includes(SHORT_REASON), true, "the detail carries the message the test chose");
    const line = textOf(shown(shared.detail)), reason = reasonRows(d, line, glyphsOf(ascii).cut);
    assert.equal(reason.whole, true, `${at}: the rows of the reason, joined with a space, are the detail's display line`);
    assert.equal(reason.rows[0], 2, at);
    assert.equal(cellText(d, 1, 0, d.cols).trim(), shared.text, `${at}: the row above holds the state in the shared home's words`);
    assert.equal(d.cells[2].find((cell) => cell.text !== " ").text, line[0], at);
    for (const text of d.lines) assert.equal(text.includes("the kernel:"), false, at);
    assert.deepEqual(listLines(d), [], `${at}: the reason stands above the views, and the list holds no row`);
    for (const text of d.lines) assert.equal(/acme-(ledger|console|maintainer|expert)-|Acme (ledger|console|maintainer|expert) /.test(text), false, `${at}: no instance`);
  }
});

test("a reason longer than its row is wrapped onto rows that hold nothing else, at most four, and the last one ends in the cut mark", () => {
  for (const make of [STALE, UNAVAILABLE, REFUSED]) for (const ascii of [false, true]) for (const sz of SIZES) {
    const state = stateOf(failed(entry(), make(LONG_REASON)), { ascii }), d = draw(state, sz), at = `${make(LONG_REASON).code}${marked(make)} at ${sz.cols}x${sz.rows}`;
    const line = textOf(shown(sharedState(state).detail)), cut = glyphsOf(ascii).cut;
    const reason = reasonRows(d, line, cut);
    assert.equal(reason.cutShort, true, `${at}: every row is the next piece of the reason, and the last is cut`);
    assert.equal(reason.rows.length >= 2 && reason.rows.length <= 4, true, `${at}: wrapped, on ${reason.rows.length} rows`);
    assert.equal(cellText(d, reason.rows.at(-1), 0, d.cols).endsWith(cut), true, at);
    for (const r of reason.rows) assert.equal(textWidth(cellText(d, r)) <= sz.cols, true, at);
  }
});

test("a reason that needs more than four rows takes four where the body has the room, at 80x24 and at 120x40", () => {
  for (const make of [STALE, UNAVAILABLE, REFUSED]) for (const sz of [S80, S120]) {
    const state = stateOf(failed(entry(), make(Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ")))), d = draw(state, sz);
    assert.equal(reasonRows(d, textOf(shown(sharedState(state).detail)), "…").rows.length, 4, `${make("").code}${marked(make)} at ${sz.cols}x${sz.rows}`);
  }
});

test("a hostile message in the reason leaves no escape byte of its own on the screen: an ESC sequence, a bidi override, a C1 control and an OSC, stale and unavailable", () => {
  const hostile = {
    "an erase sequence": "wipe \x1b[2J the screen",
    "a bidi override": "safe\u202Etxt.exe was read",
    "a C1 control, the 8-bit CSI": "red \u009B31m alert \u009B2J",
    "an OSC that sets the title": "\x1b]0;owned\x07 and a tail",
  };
  for (const [name, message] of Object.entries(hostile)) for (const make of [STALE, UNAVAILABLE]) for (const sz of [S80, S120, S60]) {
    const state = stateOf(failed(entry(), make(message))), shared = sharedState(state), d = draw(state, sz), at = `${name}, ${make("").code}, ${sz.cols}x${sz.rows}`;
    assert.doesNotMatch(textOf(shown(message)), CONTROL, `${at}: the TUI's own filter leaves no control character of the message as it came`);
    const out = readTerminalOutput(createScreen().render(d.rows, sz, { full: true }));
    assert.deepEqual(out.foreign, [], `${at}: every ESC written begins a sequence of the TUI's own`);
    assert.deepEqual([...new Set(out.sequences.map((s) => s.kind))].filter((kind) => !["erase", "position", "sgr", "sync"].includes(kind)), [], at);
    assert.doesNotMatch(out.text, CONTROL, at);
    d.cells.forEach((line, r) => line.forEach((cell, x) => assert.doesNotMatch(cell.text, CONTROL, `${at}: row ${r}, column ${x}`)));
    const reason = reasonRows(d, textOf(shown(shared.detail)), "…");
    assert.equal(reason.whole, true, `${at}: what is drawn is the detail through shown()`);
    assert.equal(d.lines.some((line) => line.includes("owned")) && name.startsWith("an OSC"), false, at);
    // The half the shared home's filter cannot prove for us: the message handed RAW to the TUI's own
    // draw, as the notice's reason, in the model of that same state. Whatever the shared sentence did
    // or did not filter above, the frame's own shown() stands between this text and the terminal.
    const m = model(state, { page: d.page, now: NOW, at: AT, cols: d.cols });
    assert.equal(m.notice !== null && typeof m.notice.reason === "string", true, `${at}: the model of a deployment that is not live holds a notice with a reason`);
    const raw = frame({ ...m, notice: { ...m.notice, reason: message } }, sz), handed = `${at}, the message handed raw`;
    const written = readTerminalOutput(createScreen().render(raw.rows, sz, { full: true }));
    assert.deepEqual(written.foreign, [], `${handed}: every ESC written begins a sequence of the TUI's own`);
    assert.deepEqual([...new Set(written.sequences.map((s) => s.kind))].filter((kind) => !["erase", "position", "sgr", "sync"].includes(kind)), [], handed);
    assert.doesNotMatch(written.text, CONTROL, handed);
    createScreen().cells(raw.rows, sz).forEach((line, r) => line.forEach((cell, x) => assert.doesNotMatch(cell.text, CONTROL, `${handed}: row ${r}, column ${x}`)));
  }
});

test("the same hostile messages in the kernel's own refusal, a reason marked `origin: \"kernel\"`, leave no escape byte of their own on the screen either", () => {
  const hostile = {
    "an erase sequence": "wipe \x1b[2J the screen",
    "a bidi override": "safe\u202Etxt.exe was read",
    "a C1 control, the 8-bit CSI": "red \u009B31m alert \u009B2J",
    "an OSC that sets the title": "\x1b]0;owned\x07 and a tail",
  };
  for (const [name, message] of Object.entries(hostile)) for (const sz of [S80, S120, S60]) {
    const state = stateOf(failed(entry(), REFUSED(message))), shared = sharedState(state), d = draw(state, sz), at = `${name}, ${sz.cols}x${sz.rows}`;
    assert.equal(shared.key, "unobserved", at);
    assert.doesNotMatch(textOf(shown(message)), CONTROL, `${at}: the TUI's own filter leaves no control character of the message as it came`);
    const out = readTerminalOutput(createScreen().render(d.rows, sz, { full: true }));
    assert.deepEqual(out.foreign, [], `${at}: every ESC written begins a sequence of the TUI's own`);
    assert.deepEqual([...new Set(out.sequences.map((s) => s.kind))].filter((kind) => !["erase", "position", "sgr", "sync"].includes(kind)), [], at);
    assert.doesNotMatch(out.text, CONTROL, at);
    d.cells.forEach((line, r) => line.forEach((cell, x) => assert.doesNotMatch(cell.text, CONTROL, `${at}: row ${r}, column ${x}`)));
    assert.equal(reasonRows(d, textOf(shown(shared.detail)), "…").whole, true, `${at}: what is drawn is the detail through shown()`);
    assert.equal(d.lines.some((line) => line.includes("owned")), false, at);
  }
});

test("the kernel's own refusal is drawn in each of its three forms as the shared sentence gives it: with a message, with a message the display filter withholds, and with an empty one", () => {
  const SECRET = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const forms = { "a message": SHORT_REASON, "a message the display filter withholds": SECRET, "an empty message": "" };
  const details = {};
  for (const [form, message] of Object.entries(forms)) for (const ascii of [false, true]) for (const sz of SIZES) {
    const state = stateOf(failed(entry(), REFUSED(message)), { ascii }), shared = sharedState(state), d = draw(state, sz), at = `${form} at ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    assert.equal(shared.key, "unobserved", at);
    details[form] = shared.detail;
    const line = textOf(shown(shared.detail)), reason = reasonRows(d, line, glyphsOf(ascii).cut);
    assert.equal(reason.whole, true, `${at}: the rows of the reason, joined with a space, are the shared sentence's display line`);
    assert.equal(reason.rows[0], 2, `${at}: under the state`);
    assert.equal(cellText(d, 1, 0, d.cols).trim(), shared.text, `${at}: the row above holds the state in the shared home's words`);
    assert.deepEqual(listLines(d), [], `${at}: the reason stands above the views, and the list holds no row`);
    for (const text of d.lines) assert.equal(text.includes("ghp_"), false, `${at}: nothing of a withheld message is drawn`);
  }
  // Three sentences of the shared home, told apart by what it gives and by nothing written here.
  const [said, withheld, bare] = [details["a message"], details["a message the display filter withholds"], details["an empty message"]];
  const own = sharedState(stateOf(failed(entry(), UNAVAILABLE(SHORT_REASON)))).detail;
  assert.notEqual(said, own, "the mark changes the sentence: the reader's own `<code>: <message>` is not what a kernel's refusal reads");
  assert.equal(said.startsWith(bare) && said.endsWith(displayLine(SHORT_REASON)), true, "with a message: the first sentence, then the message");
  const lead = said.slice(bare.length, said.length - displayLine(SHORT_REASON).length).trim();
  assert.equal(lead.length > 0, true, "and between them the lead that says whose words follow");
  assert.equal(withheld.startsWith(bare) && withheld.endsWith(DETAIL_WITHHELD) && !withheld.includes(lead) && !withheld.includes("ghp_"), true, "a withheld message is not introduced: the first sentence and the shared word for what was withheld");
  assert.equal(bare.length > 0 && !bare.includes(lead), true, "an empty message leaves the first sentence alone");
});

test("the stale reason, which no line attributes, keeps 2b's two conditions, through the display filter and with no text of the TUI's on its rows, whatever its message is (a line, one the filter withholds, spaces only); a remote row's runtimeError stands under its state after its speaker's words, which are what the shared originLead answers for that row, and a text the filter withholds stands alone, with no speaker", () => {
  // The stale reason holds the kept message with no speaker. Whether the shared sentence filters the
  // message itself is the shared home's: what is pinned is that the rows are its sentence through
  // shown(), and that they hold nothing else.
  const messages = { "a line": SHORT_REASON, "a message the display filter withholds": "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "spaces only": "   " };
  for (const [kind, message] of Object.entries(messages)) for (const ascii of [false, true]) for (const sz of SIZES) {
    const state = stateOf(failed(entry(), STALE(message)), { ascii }), shared = sharedState(state), d = draw(state, sz), g = glyphsOf(ascii), at = `the stale reason, ${kind}, at ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    assert.equal(shared.key, "stale", at);
    const line = textOf(shown(shared.detail)), reason = reasonRows(d, line, g.cut);
    assert.equal(reason.whole, true, `${at}: through the display filter: the rows, joined with a space, are the shared detail's display line`);
    assert.equal(reason.rows[0], 2, `${at}: on rows of its own, from the row under the state`);
    // Around those rows: the state with its time above, the open view's heading below, an empty
    // row apart. No row of the reason holds a label, a speaker or a mark: reasonRows takes a row
    // only when every cell of it is the next piece of the line.
    assert.equal(cellText(d, 1, 0, d.cols).replace(shared.text, "").replace("since 10:00:00", "").trim(), "", at);
    assert.equal(openRow(d) > reason.rows.at(-1), true, `${at}: the open view's heading follows the reason`);
    for (let r = reason.rows.at(-1) + 1; r < openRow(d); r++) assert.equal(cellText(d, r, 0, d.cols), "", `${at}: and nothing but the empty row stands between them`);
    for (const text of d.lines) assert.equal(text.includes("the kernel:") || text.includes("ghp_"), false, at);
    d.cells.forEach((cells, r) => cells.forEach((cell, x) => assert.doesNotMatch(cell.text, CONTROL, `${at}: row ${r}, column ${x}`)));
  }
  // A remote row's runtimeError: what its host reported, or what the read of its machine failed
  // with. On rows of its own under `state`, after the words that say who gave it. Those words are
  // on its rows and are not the TUI's: they are what the shared originLead answers for the mark
  // the shared home put on the row. A host's text is its kernel's, relayed; both failed reads are
  // the read's own (an envelope the shared read writes for a child it ended is not one the
  // installed CLI printed). A text the filter withholds is not introduced: the withheld word alone.
  const erring = (runtimeError) => heard(local(), answered(group({ instances: [farRow(FAR_A, { running: null, runtimeState: "unreachable", runtimeError })] })), T1);
  const cases = {
    "a reached machine's row with the error its host reported": [erring(UNREACHABLE), "OATS says:"],
    "a reached machine's row with an error the display filter withholds": [erring("wipe \x1b[2J the screen"), "OATS says:"],
    "a row kept from a machine whose read answered an error": [lost(), "oats tui's read of other machines says:"],
    "a row kept from a machine whose read threw": [heard(reached(), { thrown: "spawn oats ENOENT" }, T2), "oats tui's read of other machines says:"],
  };
  for (const [kind, [made, lead]] of Object.entries(cases)) for (const sz of [S160, S80]) {
    const state = selecting(made, FAR_A, sz), row = panelRow(state, FAR_A), error = row.runtimeError, d = draw(state, sz), detail = factsOf(detailLines(d, sz)), at = `${kind}, at ${sz.cols}x${sz.rows}`;
    assert.equal(typeof error === "string" && error.trim() !== "", true, `${at}: the shared home gave the row an error`);
    assert.equal(originLead(row.runtimeErrorOrigin, TERMS), lead, `${at}: and said who gave it: the words are the shared originLead's for the row`);
    const rows = fact(detail, "state").rows, withheld = displayLine(error) === DETAIL_WITHHELD;
    assert.equal(withheld, kind.includes("withholds"), at);
    if (withheld) {
      assert.deepEqual(rows.slice(1), ["[withheld]"], `${at}: a withheld text is the TUI's withheld word alone`);
      // Every lead ends in `says:`, one word, which no wrap breaks: none of it is on the screen.
      for (const text of d.lines) assert.equal(text.includes("says:") || text.includes("\""), false, `${at}: no speaker introduces it, and no quotation mark stands around it`);
    } else {
      assert.equal(rows.slice(1).join(" "), `${lead} ${textOf(shown(error))}`, `${at}: through the display filter: the rows under the state are the speaker's words and the error's display line`);
      assert.equal(rows.length >= 2, true, `${at}: on rows of its own`);
    }
    assert.equal(labels(detail)[labels(detail).indexOf("state") + 1], "harness", `${at}: and no label or held line stands with it`);
    for (const text of d.lines) assert.equal(text.includes("the kernel:") || text.includes("the host:"), false, `${at}: no word of the TUI's names a speaker`);
    d.cells.forEach((cells, r) => cells.forEach((cell, x) => assert.doesNotMatch(cell.text, CONTROL, `${at}: row ${r}, column ${x}`)));
  }
});

// ── A list row ───────────────────────────────────────────────────────────────────────────────────

test("a list row is indented two cells per level, and a row deeper than the sixth level sits at the sixth", () => {
  const chain = Array.from({ length: 8 }, (_, i) => instanceRow("soul", `level-${i}`, i ? { parentInstance: `level-${i - 1}` } : {}));
  for (const sz of [S80, S120, S79, size(60, 20)]) {
    const d = draw(stateOf(observed(chain)), sz);
    const marks = chain.map((_, i) => d.cells[rowOf(d, sz, `level-${i}`)].findIndex((cell) => cell.text === "●"));
    const names = chain.map((_, i) => d.cells[rowOf(d, sz, `level-${i}`)].map((cell) => cell.text).join("").indexOf(drawnName(`level-${i}`)));
    for (let i = 1; i < 8; i++) {
      assert.equal(marks[i] - marks[i - 1], i <= 5 ? 2 : 0, `${sz.cols}: level ${i} against level ${i - 1}`);
      assert.equal(names[i] - names[i - 1], i <= 5 ? 2 : 0, `${sz.cols}: the name moves with its mark`);
    }
    assert.equal(marks[5] - marks[0], 10, "the sixth level is five steps in");
    assert.deepEqual([marks[6], marks[7]], [marks[5], marks[5]], "the seventh and eighth sit at the sixth");
  }
});

test("no row carries a disclosure mark: a child stands under its parent by indentation alone, two cells a level, and only a folded row says so, with `+n` after its name for the n instances it folds away", () => {
  for (const ascii of [false, true]) for (const sz of SIZES) {
    const marks = marksOf(ascii), state = fresh({ ascii });
    for (const [name, mark, depth] of [[KERNEL_EXPERT, marks.running, 0], [KERNEL_DEV, marks.waiting, 1], [REVIEWER, marks.stopped, 2], [DESKTOP_EXPERT, marks.running, 0], [DESKTOP_A, marks.waiting, 1], [DESKTOP_B, marks.waiting, 1], [MAINTAINER, marks.running, 0], [EXPERT_TUI, marks.unknown, 0]]) {
      // Where the list is cut off (60x15), the selection moved to the row brings it on the screen.
      const there = onScreen(state, sz, name), drawn = draw(there, sz), r = rowAt(there, sz, name);
      const cells = drawn.cells[r], at = `${name} at ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
      assert.equal(cells[2 + 2 * depth].text, mark, `${at}: the state mark stands at its level`);
      // Before the mark: the selection mark on the selected row, and nothing else.
      assert.deepEqual(cells.slice(1, 2 + 2 * depth).map((cell) => cell.text).join("").trim(), "", at);
      assert.equal(cells[3 + 2 * depth].text, " ", at);
      assert.equal(cellText(drawn, r, 0, drawn.cols).includes("+"), false, `${at}: an open row says nothing of its children`);
    }
    // Folded: the root of the one cluster folds its two children away.
    const shut = draw(folded({ ascii }), sz), row = cellText(shut, listRows(shut)[0], 0, shut.cols);
    assert.equal(row.slice(0, 4), `> ${marks.running} `, "the folded row's own cells are its marks, as any row's");
    assert.match(row, /^> . \S.* \+2 /, `${sz.cols}: \`+2\` after the name`);
  }
  for (const line of listLines(draw(fresh(), S120), S120)) assert.equal(/[▾▸]/.test(line), false, line);
});

/** One instance per state a row can be in, and what each row is to show. A retire the kernel reports
 *  interrupted didn't finish; an older kernel's pending one (no `retire`) is in progress (#1247). */
const STATES = () => [
  ["running", instanceRow("soul", "a-running")],
  ["stopped", instanceRow("soul", "b-stopped", { running: false, runtimeState: "stopped" })],
  ["shell", instanceRow("soul", "c-shell", { running: false, runtimeState: "shell" })],
  ["unknown", instanceRow("soul", "d-unreachable", { running: null, runtimeState: "unreachable", runtimeError: UNREACHABLE })],
  ["stopped", instanceRow("soul", "e-unsupported", { running: false, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: the session backend is gone" })],
  ["held", instanceRow("soul", "f-spawning", { running: false, runtimeState: "stopped", spawnInProgress: true })],
  ["held", instanceRow("soul", "g-half-spawned", { running: false, runtimeState: "stopped", rollbackIncomplete: true })],
  ["held", instanceRow("soul", "h-half-retired", { retirePending: true, retire: { state: "interrupted", since: "2026-10-15T00:00:00Z", self: true } })],
  ["held", instanceRow("soul", "i-retiring", { retirePending: true })],
];
/** The mark a row carries: the last thing drawn before its name. */
const markOf = (d, sz, name) => { const line = cellText(d, rowOf(d, sz, name)); return line.slice(0, line.indexOf(drawnName(name))).trim().split(/\s+/).at(-1); };

test("each state has a mark of its own shape, in UTF-8 and in ASCII: running, stopped, a shell left behind, unknown, and a home the kernel holds", () => {
  assert.deepEqual({ ...MARKS.utf8 }, { running: "●", stopped: "○", shell: "◌", unknown: "?", held: "◆", selected: ">", waiting: "!" });
  assert.deepEqual({ ...MARKS.ascii }, { running: "*", stopped: "-", shell: "~", unknown: "?", held: "#", selected: ">", waiting: "!" });
  for (const ascii of [false, true]) {
    const sz = S120, d = draw(stateOf(observed(STATES().map(([, row]) => row)), { ascii }), sz);
    for (const [mark, row] of STATES()) assert.equal(markOf(d, sz, row.instance), marksOf(ascii)[mark], `${row.instance}${ascii ? " in ASCII" : ""}`);
  }
});

test("a row has a word only where its mark can't say it: none for running, stopped or a shell left, the held home's state for a home the kernel holds, and the shared label of the row's reason, dim, in one column", () => {
  const rows = STATES().map(([, row]) => row), state = stateOf(observed(rows)), sz = S120, d = draw(state, sz);
  const held = (name) => heldHome(panelRow(state, name)).state;
  const reason = (name) => rowReason(panelRow(state, name)).label;
  const expected = { "d-unreachable": reason("d-unreachable"), "e-unsupported": `${reason("e-unsupported").slice(0, 19)}…`, "f-spawning": held("f-spawning"), "g-half-spawned": held("g-half-spawned"), "h-half-retired": held("h-half-retired"), "i-retiring": held("i-retiring") };
  assert.equal(textWidth(reason("e-unsupported")) > 20, true, "the shared label of a removed session backend is wider than the column");
  const list = listWidth(sz.cols);
  for (const name of ["a-running", "b-stopped", "c-shell"]) assert.equal(cellText(d, rowOf(d, sz, name), 0, list).endsWith(drawnName(name)), true, `${name}: its name and nothing after it`);
  const starts = Object.entries(expected).map(([name, word]) => { const line = cellText(d, rowOf(d, sz, name), 0, list); assert.equal(line.endsWith(word), true, `${name} shows ${word}`); return line.length - word.length; });
  assert.equal(new Set(starts).size, 1, "every word starts at the same column");
  assert.equal(starts[0] + 20 <= list, true, "and the widest ends inside the pane");
  for (const name of Object.keys(expected)) {
    const cells = d.cells[rowOf(d, sz, name)];
    assert.equal(cells[starts[0] - 1].text, " ", "a gap stands before the column");
    assert.equal(cells.slice(starts[0], starts[0] + 3).every((cell) => cell.style.dim), true, `${name}: the word is dim`);
  }
});

test("the word column is as wide as the widest word among all the rows, and never wider than 20 cells: a longer word is cut with the mark; a row without a word gives its name the column's cells, and a list with no word has no column", () => {
  const LONG = "n".repeat(130);
  const HELD = { running: false, runtimeState: "stopped", spawnInProgress: true };
  const HERDR = { running: false, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: the session backend is gone" };
  for (const sz of [S80, S120, S79]) {
    const list = sz.cols >= WIDE ? listWidth(sz.cols) : sz.cols;
    // No word anywhere: a long name runs to the cells kept for the waiting mark and a gap, and is
    // cut there; from its mark on, the row is the same in a list that has a word column.
    const cut = `● N${"n".repeat(list - 11)}…`;
    const quiet = draw(stateOf(observed([instanceRow("soul", LONG)])), sz);
    assert.equal(cellText(quiet, 3, 2, list), cut, `${sz.cols}: the name has every cell but the waiting mark's and a gap`);
    for (const extra of [HELD, HERDR]) {
      const state = stateOf(observed([instanceRow("soul", "row-0"), instanceRow("soul", LONG), instanceRow("soul", "worded", extra)]));
      const d = draw(state, sz), row = panelRow(state, "worded");
      const full = heldHome(row)?.state ?? rowReason(row).label;
      const shown = textWidth(full) > 20 ? `${full.slice(0, 19)}…` : full;
      const worded = cellText(d, rowOf(d, sz, "worded"), 0, list), column = worded.length - shown.length;
      assert.equal(worded.endsWith(shown), true, `${full} at ${sz.cols}`);
      assert.equal(list - 5 - column, Math.min(20, textWidth(full)), `${sz.cols}: the column is as wide as its widest word, at most 20`);
      assert.equal(d.cells[rowOf(d, sz, "worded")][column - 1].text, " ", "the name never runs into the word");
      // The long name of a row without a word is not cut by the column.
      assert.equal(cellText(d, rowOf(d, sz, LONG.slice(0, 20)), 2, list), cut, `${sz.cols}: a row without a word keeps the column's cells`);
    }
  }
});

test("the selected row is drawn in reverse video over the whole width of its pane, but for its needs-input mark, and carries `>` in its first cell: the selection never rests on an attribute alone", () => {
  for (const ascii of [false, true]) for (const name of [KERNEL_EXPERT, KERNEL_DEV, REVIEWER, DESKTOP_EXPERT, DESKTOP_A, DESKTOP_B, MAINTAINER, EXPERT_TUI]) {
    const state = selecting(fresh({ ascii }), name);
    for (const sz of [...SIZES, size(200, 30)]) {
      const d = draw(state, sz), at = `${name} at ${sz.cols}x${sz.rows}`;
      const pane = sz.cols >= WIDE ? listWidth(sz.cols) : sz.cols, selected = rowAt(state, sz, name);
      assert.equal(d.cells[selected][0].text, ">", at);
      const mark = waitMarkAt(d, selected);
      assert.equal(tagAt(d, selected, pane), null, `${at}: no tag at the edge`);
      assert.equal(mark !== null, [KERNEL_DEV, DESKTOP_A, DESKTOP_B].includes(name), `${at}: the needs-input mark only on a waiting row`);
      if (mark) assert.equal(mark.style, TAG_SELECTED, `${at}: the mark stands apart from the bar, not reversed`);
      assert.deepEqual(d.cells[selected].map((cell) => cell.style.reverse), Array.from({ length: sz.cols }, (_, x) => x < pane && x !== mark?.col), `${at}: every cell of the pane but the mark, and none past it`);
      // The accordion's open view is bold, never in reverse: the selection, the needs-input marks and
      // the open workspace's row of the list of workspaces (the top row, the sidebar's width, while
      // the list does not have the focus) are the only cells in reverse.
      assert.equal(openBarred(d, pane), true, `${at}: the open workspace's row of the list of workspaces is in bold reverse video over the sidebar's width, but for its dot`);
      const otherReverse = (line, r) => (r === 0 ? false : line.slice(0, pane).some((cell, x) => cell.style.reverse && x !== waitMarkAt(d, r)?.col)) || line.slice(pane).some((cell) => cell.style.reverse);
      assert.deepEqual(d.cells.flatMap((line, r) => (r !== selected && otherReverse(line, r) ? [r] : [])), [], `${at}: no other row is in reverse video, but for its needs-input mark and the open workspace's row of the list of workspaces in the sidebar`);
      assert.deepEqual(bodyRows(sz).filter((r) => r !== selected && d.cells[r][0].text === ">"), [], `${at}: no other row carries the selection mark`);
    }
  }
});

test("a waiting row's state mark is the needs-input mark, `!` at its level, and its edge carries nothing; an expanded row carries nothing for the rows that wait below it", () => {
  for (const ascii of [false, true]) for (const sz of SIZES) {
    const pane = sz.cols >= WIDE ? listWidth(sz.cols) : sz.cols, state = fresh({ ascii }), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    /** The row's needs-input mark, its tag and its last cells; where the list is cut off (60x15), with the selection moved to it. */
    const edge = (name) => {
      const there = onScreen(state, sz, name), d = draw(there, sz), r = rowAt(there, sz, name);
      return { mark: waitMarkAt(d, r), tag: tagAt(d, r, pane), selected: d.cells[r][0].text === ">", last: cellText(d, r, pane - 2, pane) };
    };
    for (const name of [KERNEL_DEV, DESKTOP_A, DESKTOP_B]) {
      const { mark, tag, selected, last } = edge(name);
      assert.deepEqual([mark, tag, last], [{ col: 4, style: selected ? TAG_SELECTED : TAG }, null, ""], `${name} at ${at}: the mark at the state mark's column, one level in, and nothing at the edge`);
    }
    for (const name of [KERNEL_EXPERT, DESKTOP_EXPERT, MAINTAINER, REVIEWER, EXPERT_TUI]) assert.deepEqual([edge(name).mark, edge(name).tag, edge(name).last], [null, null, ""], `${name} at ${at}`);
  }
});

test("a collapsed row carries `+n` after its name for the n instances it folds away and a tag for the N rows waiting below it, `N below` or `N` where the whole name does not fit beside the words, and the rows below it are not drawn: one cluster and no single instance, cell for cell", () => {
  const shut = model(folded(), { page: 19, now: NOW, at: AT }).list.find((row) => row?.selected);
  assert.deepEqual([shut.name, shut.folded, shut.below], ["Acme console expert tui read", 2, 2], "its name as words, two folded away, both waiting");
  const d80 = draw(folded(), S80), a80 = draw(folded({ ascii: true }), S80), d60 = draw(folded(), S60), d120 = draw(folded(), S120);
  assert.equal(cellText(d80, 0, 0, 38), workspaceLine("acme-platform", 38, { waiting: true }), "the open workspace's row of the list of workspaces: its name and the dot, and nothing counts the rows that wait");
  // The name is cut before the count is: `+2` stays whole after what is left of it.
  assert.equal(cellText(d80, 3, 0, 39), "> ● Acme console expert tui r… +2   2 │");
  assert.equal(cellText(a80, 3, 0, 39), "> * Acme console expert tui... +2   2 |");
  assert.equal(cellText(d60, 3), tagged(`> ● ${drawnName(DESKTOP_EXPERT)} +2`, 60, belowText(2)));
  assert.equal(cellText(d120, 3, 0, 58), `${tagged(`> ● ${drawnName(DESKTOP_EXPERT)} +2`, 57, belowText(2))} │`);
  assert.deepEqual(d80.cells[3].slice(31, 33).map((cell) => [cell.text, cell.style.reverse]), [["+", true], ["2", true]], "the count stands in the selection's bar");
  for (const [d, sz] of [[d80, S80], [a80, S80], [d60, S60], [d120, S120]]) {
    assert.deepEqual(listLines(d, sz).slice(1).filter((line) => line.trim()), [], "the rows below a collapsed row are not drawn, and no other row is");
    const pane = sz.cols >= WIDE ? listWidth(sz.cols) : sz.cols;
    const tag = tagAt(d, 3, pane), words = pane === 38 ? "2" : belowText(2);
    assert.deepEqual([tag?.words, tag?.col, tag?.style], [words, pane - words.length - 2, TAG_SELECTED], "the tag is inside the pane, at its edge, not reversed in the selection's bar");
    d.cells[3].forEach((cell, x) => assert.equal(cell.style.reverse, x < tag.col));
  }
  // Expanded again, the three rows are back and the roll-up is gone.
  const open = press(folded(), ["l"]).state, lines = listLines(draw(open, S79), S79).filter((line) => line.trim());
  assert.deepEqual(lines, [
    `> ● ${drawnName(DESKTOP_EXPERT)}`,
    `    ! ${drawnName(DESKTOP_A)}`,
    `    ! ${drawnName(DESKTOP_B)}`,
  ]);
});

// ── The needs-input tag, drawn by the list view alone over rows a test makes ─────────────────────
/** A row of the list as the model hands it to the view. */
const listItem = (name, more = {}) => ({ id: name, name, depth: 0, selected: false, mark: "running", word: null, waiting: false, folded: 0, below: 0, ...more });
/** The list view's rows for `items` in a pane `cols` wide, as the screen's cells, or (`bytes`) as
 *  what the screen writes for them, with colour or without. */
function listCells(items, cols, { ascii = false, wordWidth = 0 } = {}) {
  const sz = size(cols, items.length);
  return { cells: createScreen({ ascii }).cells(instances({ list: items, ascii, wordWidth, above: 0, below: 0 }, sz), sz) };
}
const listBytes = (items, cols, { color = true } = {}) => createScreen({ color }).render(instances({ list: items, ascii: false, wordWidth: 0, above: 0, below: 0 }, size(cols, items.length)), size(cols, items.length));
/** The kinds of row that carry a tag, each with its words and its short form: a row that folds
 *  waiting rows away, whether or not it waits itself. */
const TAGGED = Object.freeze([
  ["a folded row with 1 waiting row under it", { folded: 1, below: 1 }, "1 below", "1"],
  ["a folded row with 12", { folded: 30, below: 12 }, "12 below", "12"],
  ["a folded row with 120", { folded: 130, below: 120 }, "99+ below", "99+"],
  ["a waiting row that folds 2 waiting rows: its mark says its own claim, the tag the rest", { waiting: true, folded: 3, below: 2 }, "2 below", "2"],
]);
/** The state mark a list row of `more` draws: the needs-input mark on a waiting row, else running's. */
const markFor = (more, ascii) => (more.waiting ? "!" : ascii ? "*" : "●");

test("the roll-up tag's words are the Desktop's, from one place: `N below`, `99+ below` past 99; and `Needs input` is the shared home's word for a claim with no reason of its own", () => {
  assert.equal(NEEDS_INPUT, "Needs input");
  assert.equal(waitingLabel({ since: AT }), NEEDS_INPUT, "the detail says the shared home's word for a claim that names no reason");
  assert.deepEqual([1, 12, 99, 100, 120].map(belowText), ["1 below", "12 below", "99 below", "99+ below", "99+ below"]);
  // The Desktop's mark (packages/desktop/renderer/shell.mjs needsInputMark) writes its words in place: read them there.
  const shell = readFileSync(new URL("../../desktop/renderer/shell.mjs", import.meta.url), "utf8");
  const mark = shell.slice(shell.indexOf("function needsInputMark("), shell.indexOf("\n}\n", shell.indexOf("function needsInputMark(")));
  assert.match(mark, /`\$\{below\} below`/, "the Desktop's words for a folded row");
  assert.equal(mark.includes(NEEDS_INPUT), false, "the Desktop's mark is the roll-up only: a waiting row says it by its mark there too");
});

test("a waiting row's state mark is the needs-input mark whatever its state and colour: `!`, bold, in reverse video in the waiting colour, and on the selected row not reversed, a gap in the selection's bar; the same `!` in ASCII", () => {
  for (const ascii of [false, true]) {
    const marks = marksOf(ascii);
    // Its shape is none of the state marks'.
    assert.equal(["running", "stopped", "shell", "unknown", "held", "selected"].some((mark) => marks[mark] === marks.waiting), false, `${ascii ? "ASCII" : "UTF-8"}: a shape of its own`);
    for (const mark of ["running", "stopped", "shell", "unknown", "held"]) for (const color of [null, "yellow", "cyan"]) for (const selected of [false, true]) for (const depth of [0, 1, 5]) {
      const at = `${mark}${color ? `, ${color}` : ""}${selected ? ", selected" : ""}, depth ${depth}${ascii ? ", ascii" : ""}`;
      const d = listCells([listItem("dev", { waiting: true, mark, color, selected, depth })], 60, { ascii }), col = 2 + 2 * depth;
      assert.deepEqual([d.cells[0][col].text, d.cells[0][col].style], ["!", selected ? TAG_SELECTED : TAG], `${at}: in the state mark's cell`);
      assert.equal(textAt(d.cells[0]), `${selected ? ">" : " "} ${" ".repeat(2 * depth)}! dev`, `${at}: the name where it stands on any row, and nothing at the edge`);
      assert.deepEqual(d.cells[0].map((cell, x) => cell.style.reverse), Array.from({ length: 60 }, (_, x) => (x === col ? !selected : selected)), `${at}: the mark alone is reversed, or alone not in the selection's bar`);
    }
  }
});

test("a sand instance's mark is in the terminal's own foreground, not yellow, which says needs input and only that; waiting, it is the yellow `!` like any other", () => {
  // The first row is the selected one, drawn in reverse video whatever its colour.
  const rows = [instanceRow("soul", "aaa-selected"), instanceRow("soul", "dev-sand", { color: "sand" }), instanceRow("soul", "dev-waits", { color: "sand", waitingOnYou: { ...QUESTION } })];
  const d = draw(stateOf(observed(rows)), S120), mark = (name) => d.cells[rowOf(d, S120, name)][2];
  assert.deepEqual([mark("dev-sand").text, mark("dev-sand").style], ["●", style()]);
  assert.deepEqual([mark("dev-waits").text, mark("dev-waits").style.fg, mark("dev-waits").style.reverse], ["!", "yellow", true]);
});

test("under NO_COLOR the reverse video and the `!` carry a waiting row's mark: the waiting colour is dropped, reversed on a row and not reversed in the selection's bar, bold either way", () => {
  const CSI = "\x1b[";
  for (const color of [null, "cyan"]) {
    const plain = listBytes([listItem("dev", { waiting: true, color })], 40, { color: false }), picked = listBytes([listItem("dev", { waiting: true, color, selected: true })], 40, { color: false });
    assert.equal(plain.includes(`  ${CSI}0;1;7m!${CSI}0m dev`), true, `${color}: reversed and bold`);
    assert.equal(picked.includes(`${CSI}0;7m> ${CSI}0;1m!${CSI}0;7m dev`), true, `${color}, selected: bold, not reversed, in the bar`);
    for (const bytes of [plain, picked]) assert.doesNotMatch(bytes, /\x1b\[[\d;]*;3\dm/, `${color}: no colour`);
    assert.equal(listBytes([listItem("dev", { waiting: true, color })], 40).includes(`${CSI}0;1;7;33m!`), true, `${color}: with colour, in the waiting colour, not the instance's`);
    assert.equal(listBytes([listItem("dev", { waiting: true, color, selected: true })], 40).includes(`${CSI}0;1;33m!`), true, `${color}, selected: in the waiting colour`);
  }
});

test("the needs-input tag: its words padded by a cell each side at the pane's right edge, in reverse video in the waiting colour, and on the selected row not reversed, a gap in the selection's bar; the same words in ASCII", () => {
  for (const ascii of [false, true]) for (const [what, more, words] of TAGGED) for (const selected of [false, true]) {
    const at = `${what}${selected ? ", selected" : ""}${ascii ? ", ascii" : ""}`, d = listCells([listItem("dev", { selected, ...more })], 60, { ascii }), tag = tagAt(d, 0, 60);
    assert.deepEqual([tag?.words, tag?.col, tag?.style], [words, 60 - words.length - 2, selected ? TAG_SELECTED : TAG], at);
    assert.deepEqual([d.cells[0][tag.col].text, d.cells[0][59].text], [" ", " "], `${at}: a cell of padding either side`);
    assert.equal(d.cells[0][tag.col - 1].style.reverse, selected, `${at}: the cell before the tag is the row's own`);
    if (more.folded) assert.equal(textAt(d.cells[0]).startsWith(`${selected ? ">" : " "} ${markFor(more, ascii)} dev +${more.folded} `), true, `${at}: the fold's count stays after the name`);
  }
});

test("under NO_COLOR the reverse video alone carries the tag: the waiting colour is dropped, the tag is reversed on a row and not reversed in the selection's bar, and bold either way", () => {
  const CSI = "\x1b[";
  for (const [what, more, words] of TAGGED) {
    const plain = listBytes([listItem("dev", more)], 40, { color: false }), picked = listBytes([listItem("dev", { selected: true, ...more })], 40, { color: false });
    assert.equal(plain.includes(`${CSI}0;1;7m ${words} `), true, `${what}: reversed and bold`);
    // Its last cell, a blank that paints nothing without reverse video, is the row's erase.
    assert.equal(picked.includes(`${CSI}0;7m> `) && picked.includes(`${CSI}0;1m ${words}`), true, `${what}, selected: bold, not reversed, after the bar`);
    for (const bytes of [plain, picked]) assert.doesNotMatch(bytes, /\x1b\[[\d;]*;3\dm/, `${what}: no colour`);
    assert.equal(listBytes([listItem("dev", more)], 40).includes(`${CSI}0;1;7;33m ${words} `), true, `${what}: with colour, in the waiting colour`);
  }
});

test("a narrow row: the tag gives way first, to its short form, still reversed, and only then do the word and the name give way as on a row with no tag; it never takes a cell from the mark, the name or the word, from the whole-width sidebar down to the narrowest the frame draws, the sidebar beside an open terminal", () => {
  const narrowest = LIST_BESIDE, widest = WIDE - 1;
  assert.equal(narrowest, 30);
  const WORD = "state unknown";
  for (const [what, more, words, short] of TAGGED) for (const depth of [0, 1, 5]) for (const name of ["dev", "acme-ledger-dev", "acme-ledger-developer-note-target"]) for (const word of [null, WORD]) for (const ascii of [false, true]) {
    let shrunk = false;
    for (let cols = widest; cols >= narrowest; cols--) {
      const at = `${what}, ${name} at depth ${depth}${word ? " with a word" : ""}${ascii ? ", ascii" : ""}, ${cols} cells`;
      const options = { ascii, wordWidth: word ? WORD.length : 0 };
      const d = listCells([listItem(name, { depth, word, ...more })], cols, options), plain = listCells([listItem(name, { depth, word, folded: more.folded ?? 0, waiting: more.waiting ?? false })], cols, options);
      const tag = tagAt(d, 0, cols), edge = cols - 5;
      assert.equal(tag?.style, TAG, `${at}: the tag stands`);
      const nameCol = 4 + depth * 2, fold = more.folded ? ` +${more.folded}` : "";
      const whole = nameCol + name.length + fold.length + (word ? 2 + WORD.length : 0) + 1 + words.length + 2 <= cols;
      assert.equal(tag.words, whole ? words : short, `${at}: the words only where the whole name${word ? " and the word" : ""} fit beside them`);
      if (whole) {
        assert.equal(shrunk, false, `${at}: once short, a narrower row never has the words back`);
        const left = textAt(d.cells[0], 0, tag.col);
        assert.equal(left.startsWith(`${" ".repeat(nameCol - 2)}${markFor(more, ascii)} ${name}${fold}`), true, `${at}: the name whole`);
        if (word) assert.equal(left.endsWith(`  ${WORD}`), true, `${at}: the word whole, in its column before the tag: ${left}`);
      } else {
        shrunk = true;
        assert.equal(tag.col >= edge, true, `${at}: the short tag stands in the cells every row keeps`);
        assert.deepEqual(d.cells[0].slice(0, edge).map((cell) => cell.text), plain.cells[0].slice(0, edge).map((cell) => cell.text), `${at}: the mark, the name and the word as on the row with no tag`);
      }
    }
  }
});

test("collapsing a root in a roster of several clusters hides the rows below it, keeps the selection on it and gives it the roll-up and the count of what it folds away, wherever the shared grouping then puts the row", () => {
  const before = selecting(fresh(), DESKTOP_EXPERT), state = press(before, ["h"]).state;
  assert.equal(state.selected, before.selected, "the selection is the same instance");
  // At 60 columns, tall enough for the nine rows of the list without its scrolling.
  for (const sz of [S79, size(60, 18)]) {
    const lines = listLines(draw(state, sz), sz), drawn = (name) => lines.filter((line) => line.includes(` ${drawnName(name)} `) || line.trimEnd().endsWith(` ${drawnName(name)}`));
    assert.deepEqual([drawn(DESKTOP_A).length, drawn(DESKTOP_B).length], [0, 0], "the rows below it are not drawn");
    for (const name of [KERNEL_EXPERT, KERNEL_DEV, REVIEWER, MAINTAINER, EXPERT_TUI]) assert.equal(drawn(name).length, 1, `${name} is still drawn`);
    const root = drawn(DESKTOP_EXPERT);
    assert.equal(root.length, 1);
    assert.equal(root[0].startsWith(`> ● ${drawnName(DESKTOP_EXPERT)} +2 `), true, "selected, two instances folded away");
    assert.equal(root[0].endsWith(`  ${belowText(2)}`), true, "two rows wait below it");
    assert.equal(lines.filter((line) => line.startsWith(">")).length, 1);
  }
  // A filter draws every match whatever is collapsed, and leaves the collapse as it is.
  const filtered = press(state, ["/", "p", "a", "n", "e", "l", "enter"]).state, matched = listLines(draw(filtered, S79), S79).filter((line) => line.trim());
  assert.equal(matched.some((line) => line.includes(drawnName(DESKTOP_A))), true, "a match under a collapsed row is drawn");
  assert.equal(matched.some((line) => line.includes(drawnName(KERNEL_EXPERT)) || line.includes(drawnName(MAINTAINER)) || line.includes(drawnName(DESKTOP_B))), false, "and what does not match is not");
  const cleared = listLines(draw(press(filtered, ["escape"]).state, S79), S79);
  assert.equal(cleared.some((line) => line.includes(drawnName(DESKTOP_A))), false, "with the filter cleared the row is collapsed as before");
  assert.equal(cleared.some((line) => line.includes(`● ${drawnName(DESKTOP_EXPERT)} +2`)), true);
  assert.equal(matched.some((line) => line.includes("+2")), false, "a filter folds nothing away");
});

test("a waiting claim on a stale deployment is not drawn: no mark on the row, no `needs` line", () => {
  for (const sz of [S120, S79]) {
    const stale = selecting(stateOf(failed(entry(), STALE("the mirror did not answer"))), KERNEL_DEV), d = draw(stale, sz);
    assert.equal(d.lines.some((line) => line.includes("input")), false);
    assert.equal(d.lines.some((line) => line.includes("Acme ledger developer note")), true, "the row is drawn");
    for (const r of listRows(d)) assert.equal(waitMarkAt(d, r), null, `no needs-input mark: ${cellText(d, r, 0, d.cols)}`);
    for (const line of d.lines) assert.equal(/\bneeds\b/.test(line), false, "no needs line");
    const page = draw(press(stale, ["tab"], S79).state, S79);
    assert.equal(page.lines.some((line) => line.trim().startsWith("soul ")), true, "the detail is drawn");
    for (const line of page.lines) assert.equal(/\bneeds\b/.test(line), false);
  }
});

// ── Cells ────────────────────────────────────────────────────────────────────────────────────────

const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", FLAG = "\u{1F1EA}\u{1F1F8}", THUMB = "\u{1F44D}\u{1F3FD}";
const NAMES = {
  "wide graphemes": "名前".repeat(40),
  "wide graphemes after one narrow cell": `x${"名前".repeat(40)}`,
  "family emoji joined by ZWJ": FAMILY.repeat(30),
  "flags": FLAG.repeat(40),
  "emoji with a skin tone": THUMB.repeat(40),
  "emoji of every kind and text": `${FAMILY} dev ${FLAG} ${THUMB} `.repeat(12).trim(),
  "combining marks": "e\u0301a\u0308o\u0302".repeat(40),
  "10 000 characters": "n".repeat(10000),
  "10 000 wide characters": "字".repeat(10000),
};
const HOME = `${DEPLOYMENT}/agents/soul/instances`;
/** The shared display filter reads a run of 10 000 letters slowly (a third of a second of CPU a
 *  call: its credentialed-URL pattern backtracks), and every paint filters again: that name is
 *  drawn at one size, the others at four. 10 000 wide characters cost nothing. */
const SLOW = "10 000 characters";
const sizesFor = (kind, sizes) => (kind === SLOW ? sizes.slice(0, 1) : sizes);

test("a row whose name is wide graphemes, emoji sequences, combining marks or 10 000 characters never passes its pane: the panes' rule and the detail's cells are untouched", () => {
  // The row holds a word (a held home's state), so its name is cut before the word column.
  const rows = (second) => [instanceRow("soul", "aaa-anchor"), instanceRow("soul", second, { home: `${HOME}/zzz`, retirePending: true })];
  const HELD_WORD = heldHome({ retirePending: true }).state;
  for (const ascii of [false, true]) {
    // The TUI's own ellipsis is three full stops in ASCII (term/text.mjs ownEllipsis).
    const WORD = ascii ? HELD_WORD.replaceAll("\u2026", "...") : HELD_WORD;
    /** The anchor selected: its detail is what stands beside the list in both frames. */
    const anchored = (state) => (String(state.selected).endsWith("/aaa-anchor") ? state : selecting(state, "aaa-anchor"));
    const beside = anchored(stateOf(observed(rows("zzz")), { ascii })), g = glyphsOf(ascii);
    for (const [kind, name] of Object.entries(NAMES)) {
      if (kind === SLOW && ascii) continue;
      const state = anchored(stateOf(observed(rows(name)), { ascii }));
      for (const sz of sizesFor(kind, [S80, S120, size(81, 24), size(83, 24)])) {
        const subject = draw(state, sz), control = draw(beside, sz), list = listWidth(sz.cols), at = `${kind} at ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
        assert.deepEqual(bodyRows(sz).filter((r) => subject.cells[r][list].text !== g.bar), [], `${at}: every row still has the rule at column ${list}`);
        for (const r of bodyRows(sz)) assert.deepEqual(subject.cells[r].slice(list), control.cells[r].slice(list), `${at}: row ${r} of the detail is as it is beside a short name`);
        for (const r of [0, 1, 2, sz.rows - 2, sz.rows - 1]) assert.deepEqual(subject.cells[r], control.cells[r], `${at}: row ${r} of the frame is untouched`);
        // The row is drawn, cut, and ends in the cut mark before its word.
        const r = bodyRows(sz).find((row) => subject.lines[row] !== control.lines[row]);
        assert.notEqual(r, undefined, `${at}: the row is drawn`);
        const cells = subject.cells[r], word = cellIndexOf(cells.slice(0, list), WORD);
        assert.equal(word > 0, true, `${at}: the word is still drawn in its column`);
        const c = bodyRows(sz).find((row) => control.lines[row].includes("Zzz"));
        assert.equal(word, cellIndexOf(control.cells[c].slice(0, list), WORD), `${at}: and the column did not move`);
        assert.equal(cells[word - 1].text, " ", `${at}: the name stops before the word`);
        const drawn = cells.slice(0, word).filter((cell) => cell.text !== " " && cell.text !== "");
        assert.equal(drawn.slice(-g.cut.length).map((cell) => cell.text).join(""), g.cut, `${at}: the cut name ends in the cut mark`);
        assert.equal(drawn.length > g.cut.length + 2, true, `${at}: and some of the name is drawn before it`);
        // A wide grapheme is whole or absent: its two cells are both inside the pane.
        const split = cells.map((cell, x) => (cell.width === 2 && !(x + 1 < list && cells[x + 1].width === 0)) || (cell.width === 0 && cells[x - 1]?.width !== 2) ? x : null).filter((x) => x !== null);
        assert.deepEqual(split, [], `${at}: no wide grapheme is split, and none crosses the pane's edge`);
        assert.equal(cells.reduce((sum, cell) => sum + cell.width, 0), sz.cols, `${at}: the row's graphemes take exactly the terminal's columns`);
        if (!ascii && kind !== "combining marks" && !kind.startsWith("10 000 char")) assert.equal(cells.slice(0, word).some((cell) => cell.width === 2), true, `${at}: the name is drawn in two-cell graphemes`);
      }
    }
  }
});

test("the same holds for the selected row and in the detail beside it: a name of wide and joined graphemes is cut inside the list pane and inside the detail", () => {
  for (const [kind, name] of Object.entries(NAMES)) {
    const state = stateOf(observed([instanceRow("soul", name, { home: `${HOME}/zzz`, branch: kind === SLOW ? "agents/zzz" : name })]));
    assert.equal(state.selected, `${HOME}/zzz`);
    for (const sz of sizesFor(kind, [S80, S79, S120, S60])) {
      const d = draw(state, sz), at = `${kind} at ${sz.cols}x${sz.rows}`;
      const wide = sz.cols >= WIDE, list = wide ? listWidth(sz.cols) : sz.cols;
      assert.deepEqual(d.cells[3].map((_, x) => reversed(d.cells[3], x)), Array.from({ length: sz.cols }, (_, x) => x < list), `${at}: the bar is the pane`);
      assert.equal(d.cells[3][0].text, ">", at);
      if (wide) assert.deepEqual(bodyRows(sz).filter((r) => d.cells[r][list].text !== "│"), [], `${at}: the panes' rule is whole`);
      d.cells.forEach((line, r) => {
        const split = line.map((cell, x) => (cell.width === 2 && !(x + 1 < sz.cols && line[x + 1].width === 0 && (!wide || x < list === x + 1 < list))) || (cell.width === 0 && line[x - 1]?.width !== 2) ? x : null).filter((x) => x !== null);
        assert.deepEqual(split, [], `${at}: row ${r}: no wide grapheme is split, in a pane or across the two`);
        assert.equal(line.reduce((sum, cell) => sum + cell.width, 0), sz.cols, `${at}: row ${r}: the graphemes of a row take exactly the terminal's columns`);
      });
      // The name is drawn on its own row of the sidebar alone.
      assert.deepEqual(bodyRows(sz).filter((r) => r !== 3 && d.cells[r].slice(0, list).some((cell) => cell.width !== 1)), [], `${at}: no other row of the sidebar holds a part of it`);
      // The detail's title, on the top row, and its work line hold the name too, cut inside the detail.
      if (wide) assert.equal(d.cells[0].slice(list + 1).some((cell) => cell.text === "…"), true, `${at}: the title is cut with the mark`);
    }
  }
});

// ── Scrolling ────────────────────────────────────────────────────────────────────────────────────

test("a roster of 200 scrolled with the keys: the selected row is always on the screen, at most a page of instances is drawn, and the list's last row says what is cut off, in the TUI's words", () => {
  assert.equal(cutNote(0, 12), "12 more below");
  assert.equal(cutNote(0, 0), "");
  const names = Array.from({ length: 200 }, (_, i) => `inst-${String(i).padStart(3, "0")}`);
  const many = observed(names.map((name) => instanceRow("soul", name)));
  for (const sz of [S80, S60]) {
    let state = stateOf(many);
    const pane = sz.cols >= WIDE ? listWidth(sz.cols) : sz.cols;
    const check = (keys) => {
      const d = draw(state, sz), at = `${sz.cols}x${sz.rows} after ${keys}`;
      const rows = listRows(d), drawn = rows.map((r) => /Inst (\d{3})/.exec(cellText(d, r, 0, pane))).map((match) => (match ? Number(match[1]) : null));
      const onScreen = drawn.filter((n) => n !== null);
      assert.equal(onScreen.length <= d.page, true, `${at}: at most a page of instances`);
      assert.equal(onScreen.length >= d.page - 1, true, `${at}: and the list is full`);
      assert.deepEqual(onScreen, onScreen.map((_, i) => onScreen[0] + i), `${at}: in order, none left out`);
      const selected = names.indexOf(String(state.selected).split("/").at(-1));
      assert.equal(onScreen.includes(selected), true, `${at}: inst-${selected} is selected and on the screen`);
      assert.equal(d.cells[rows[drawn.indexOf(selected)]][0].text, ">", at);
      assert.equal(cellText(d, rows.at(-1), 0, pane).trim(), cutNote(onScreen[0], 199 - onScreen.at(-1)), `${at}: the list's last row, the one above the rule, says what is cut off`);
      return { first: onScreen[0], last: onScreen.at(-1), selected };
    };
    let seen = check("nothing");
    assert.deepEqual([seen.first, seen.selected], [0, 0]);
    for (let i = 1; i <= 6; i++) { state = press(state, ["pagedown"], sz).state; const next = check(`${i} page-down`); assert.equal(next.selected > seen.selected, true); seen = next; }
    state = press(state, ["pageup"], sz).state; assert.equal(check("page-up").selected < seen.selected, true);
    state = press(state, ["G"], sz).state; seen = check("G");
    assert.deepEqual([seen.last, seen.selected], [199, 199]);
    state = press(state, ["g"], sz).state; seen = check("g");
    assert.deepEqual([seen.first, seen.selected], [0, 0]);
    // The window moves the least that keeps the selection inside it.
    for (let i = 0; i < 24; i++) {
      state = press(state, ["j"], sz).state;
      const next = check(`${i + 1} down`);
      assert.equal(next.first - seen.first, next.selected > seen.last ? 1 : 0, `${sz.cols}x${sz.rows}: down ${i + 1} moves the window only when it must, by one row`);
      seen = next;
    }
    for (let i = 0; i < 24; i++) {
      state = press(state, ["k"], sz).state;
      const next = check(`${i + 1} up`);
      assert.equal(seen.first - next.first, next.selected < seen.first ? 1 : 0, `${sz.cols}x${sz.rows}: up ${i + 1}`);
      seen = next;
    }
  }
});

test("the word column does not move while the list scrolls: it is as wide as the widest word of the whole roster, not of the rows on the screen", () => {
  // The widest word, a held home's state (a retire that didn't finish), is on the first row; the
  // last row's word is narrower. At 120x24 the column fits beside the names (at 80 columns the
  // widest word is cut to what the name leaves, and the column stands after the name).
  const sz = size(120, 24), pane = listWidth(sz.cols);
  const rows = [instanceRow("soul", "inst-000", { retirePending: true, retire: { state: "interrupted", since: "2026-10-15T00:00:00Z", self: true } }), ...Array.from({ length: 198 }, (_, i) => instanceRow("soul", `inst-${String(i + 1).padStart(3, "0")}`)), instanceRow("soul", "inst-199", { running: null, runtimeState: "unreachable" })];
  const top = stateOf(observed(rows)), end = press(top, ["G"], sz).state;
  const held = heldHome(rows[0]).state, unknown = rowReason(panelRow(top, "inst-199")).label;
  assert.equal(textWidth(held) > textWidth(unknown), true);
  const column = (d, word) => cellText(d, bodyRows(sz).find((r) => cellText(d, r, 0, pane).endsWith(word)), 0, pane).length - word.length;
  assert.equal(draw(end, sz).lines.some((line) => line.includes("inst-199")), true);
  assert.equal(draw(end, sz).lines.some((line) => line.includes("inst-000")), false, "the widest word is not on the screen");
  assert.equal(column(draw(top, sz), held), column(draw(end, sz), unknown));
});

// ── The detail ───────────────────────────────────────────────────────────────────────────────────

const S160 = size(160, 40);
const detailOf = (state, sz = S160) => factsOf(detailLines(draw(state, sz), sz));

test("the detail is a label and a value per line, the labels the TUI's own and in the spec's order, under the instance's name", () => {
  const state = golden(), detail = detailOf(state);
  assert.equal(detail.title, KERNEL_DEV);
  assert.deepEqual(labels(detail), ["soul", "state", "needs", "harness", "work", "team", "parent", "started", "home"]);
  assert.equal(new Set(detail.facts.map((f) => f.col)).size, 1, "every value starts at the same column");
  assert.deepEqual(fact(detail, "soul").rows, ["acme-ledger-developer"]);
  assert.deepEqual(fact(detail, "state").rows, ["running"]);
  assert.deepEqual(fact(detail, "needs").rows, [NEEDS, 'the agent: "Which base should it use?"'], "the reason in words and how long, then the message as an attributed quote");
  assert.deepEqual(fact(detail, "harness").rows, ["claude, claude-opus-5-5 (soul)"], "the harness as its id, the model, and where the model came from in brackets");
  assert.deepEqual(fact(detail, "work").rows, [`worktree, agents/${KERNEL_DEV}`]);
  assert.deepEqual(fact(detail, "team").rows, ["eng"]);
  assert.deepEqual(fact(detail, "parent").rows, [KERNEL_EXPERT]);
  assert.deepEqual(fact(detail, "started").rows, [STARTED]);
  assert.deepEqual(fact(detail, "home").rows, [`${DEPLOYMENT}/agents/acme-ledger-developer/instances/${KERNEL_DEV}`]);
});

test("the waited time is the time of the paint: the same state drawn later says so, and nothing else on the screen counts up", () => {
  const state = golden(), later = NOW + 3 * 3600 * 1000;
  const early = draw(state, S160), late = draw(state, S160, { now: later });
  assert.deepEqual(fact(factsOf(detailLines(late, S160)), "needs").rows[0], `${waitingLabel(QUESTION)}, ${waitedText(QUESTION.since, later)}`);
  assert.notEqual(waitedText(QUESTION.since, later), waitedText(QUESTION.since, NOW));
  const changed = early.lines.map((line, r) => (line === late.lines[r] ? null : r)).filter((r) => r !== null);
  assert.equal(changed.length, 1, "one row differs between the two paints: the waited time's");
});

test("a line whose value is absent is left out of the detail", () => {
  const bare = instanceRow("soul", "bare", { harness: null, model: null, modelFrom: undefined, work: undefined, branch: null, startedAt: undefined });
  assert.deepEqual(labels(detailOf(stateOf(observedIn([bare], { team: "" })))), ["soul", "state", "home"]);
  const some = instanceRow("soul", "some", { model: null, modelFrom: undefined, branch: null });
  const detail = detailOf(stateOf(observed([some])));
  assert.deepEqual(labels(detail), ["soul", "state", "harness", "work", "team", "started", "home"]);
  assert.deepEqual(fact(detail, "harness").rows, ["claude"], "no model, no brackets");
  assert.deepEqual(fact(detail, "work").rows, ["worktree"], "no branch");
  const unsaid = detailOf(stateOf(observed([instanceRow("soul", "unsaid", { modelFrom: undefined })])));
  assert.deepEqual(fact(unsaid, "harness").rows, ["claude, claude-opus-5-5"], "where the model came from only when the row says");
});

test("the detail's parent line holds the parent, and `sibling of <names>` at both ends of a sibling link", () => {
  const rows = [instanceRow("soul", "root-a"), instanceRow("soul", "child", { parentInstance: "root-a" }), instanceRow("soul", "twin", { siblingInstance: "root-a" }), instanceRow("soul", "both", { parentInstance: "root-a", siblingInstance: "child" })];
  const state = stateOf(observed(rows));
  assert.deepEqual(fact(detailOf(selecting(state, "root-a")), "parent").rows, ["sibling of twin"], "the end that was linked to says so too");
  assert.deepEqual(fact(detailOf(selecting(state, "twin")), "parent").rows, ["sibling of root-a"]);
  for (const [name, sibling] of [["child", "both"], ["both", "child"]]) {
    const line = fact(detailOf(selecting(state, name)), "parent").rows.join(" ");
    assert.equal(line.startsWith("root-a, ") && line.endsWith(`sibling of ${sibling}`), true, `${name}: its parent, then its sibling`);
  }
});

test("the detail's state line holds the kernel's own name for the state, or the shared label of the row's reason when the shared home gives one, and the kernel's runtimeError on the rows under it, after `OATS says:`", () => {
  // The roster as a read cycle makes it: the kernel answered `running: null` for this row, with
  // its text, so the collector did not probe it and the text is the kernel's.
  const state = selecting(stateOf(readCycle(ROSTER(), { withheld: WITHHELD })), EXPERT_TUI);
  for (const sz of [S160, S120, S80]) {
    const detail = detailOf(state, sz), rows = fact(detail, "state").rows;
    assert.equal(rows[0], "unreachable", `${sz.cols}`);
    assert.equal(rows.slice(1).join(" "), `OATS says: ${textOf(shown(UNREACHABLE))}`, `${sz.cols}: who gave it and the error, whole, with no quotation mark, on rows of its own`);
    assert.equal(labels(detail)[labels(detail).indexOf("state") + 1], "harness", "and no line of its own label");
  }
  assert.equal(fact(detailOf(state, S80), "state").rows.length > 2, true, "at 80 columns it wraps");
  assert.deepEqual(fact(detailOf(selecting(golden(), REVIEWER)), "state").rows, ["stopped"]);
  const shell = stateOf(observed([instanceRow("soul", "sh", { running: false, runtimeState: "shell" })]));
  assert.deepEqual(fact(detailOf(shell), "state").rows, ["shell"]);
  // A session backend OATS no longer has, reported by a kernel that gives its own reason.
  const unsupported = stateOf(readCycle([instanceRow("soul", "old", { running: false, runtimeState: "unsupported", runtimeError: "E_HERDR_REMOVED: gone" })]));
  assert.deepEqual(fact(detailOf(unsupported), "state").rows, [rowReason(panelRow(unsupported, "old")).label, "OATS says: E_HERDR_REMOVED: gone"]);
});

test("the detail's held line is the sentence the shared home gives for a home the kernel holds, wrapped under its label", () => {
  const rows = STATES().map(([, row]) => row), all = stateOf(observed(rows));
  for (const name of ["f-spawning", "g-half-spawned", "h-half-retired", "i-retiring"]) {
    const state = selecting(all, name), acts = instanceActs(panelRow(state, name)), sentence = (acts.blocked ?? acts.limited).sentence;
    assert.equal(typeof sentence === "string" && sentence.includes(name), true);
    for (const sz of [S160, S80, S60]) {
      const d = draw(sz.cols < WIDE ? press(state, ["tab"], sz).state : state, sz), held = fact(factsOf(detailLines(d, sz)), "held");
      assert.equal(held.rows.join(" "), textOf(shown(sentence)), `${name} at ${sz.cols}`);
      // A retire in progress says the least: its sentence may fit the pane.
      if (sz.cols === 80 && name !== "i-retiring") assert.equal(held.rows.length > 1, true, `${name}: a sentence longer than the pane wraps`);
    }
  }
  for (const name of ["a-running", "b-stopped", "c-shell", "d-unreachable", "e-unsupported"]) assert.equal(fact(detailOf(selecting(all, name)), "held"), null, `${name} is not held`);
});

test("the detail's state line of a home the kernel holds is the held home's state, the same word the list shows at the row's right edge", () => {
  const rows = STATES().map(([, row]) => row), all = stateOf(observed(rows));
  for (const name of ["f-spawning", "g-half-spawned", "h-half-retired", "i-retiring"]) {
    const state = selecting(all, name), word = heldHome(panelRow(state, name)).state, d = draw(state, S160);
    assert.equal(cellText(d, rowOf(d, S160, name), 0, 60).endsWith(word), true, `${name}: the list shows the held home's state`);
    assert.deepEqual(fact(factsOf(detailLines(d, S160)), "state").rows, [textOf(shown(word))], `${name}: and so does the detail's state line`);
  }
});

test("the detail of a collapsed row with rows waiting below it says who, in the shared home's words", () => {
  const state = folded(), panel = panelOf(state, AT);
  const below = panel.instances.filter((row) => row.parentInstance === DESKTOP_EXPERT);
  assert.equal(below.length, 2);
  const detail = detailOf(state);
  assert.deepEqual(fact(detail, "below").rows, [waitingBelowText(below)]);
  assert.deepEqual(labels(detail), ["soul", "state", "below", "harness", "work", "team", "started", "home"]);
  assert.equal(fact(detail, "needs"), null, "the row itself waits for nothing");
  assert.equal(fact(detailOf(press(state, ["l"]).state), "below"), null, "an expanded row has no such line: the rows are on the screen");
  assert.equal(fact(detailOf(selecting(fresh(), DESKTOP_EXPERT)), "below"), null);
  assert.equal(fact(detailOf(selecting(fresh(), KERNEL_EXPERT)), "below"), null);
});

test("a waiting message the shared read withholds is not drawn: the reason in words alone, and no quote line", () => {
  for (const message of ["wipe \x1b[2J now", "safe\u202Etxt.exe", "a\u009B31mb", "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "x".repeat(300)]) {
    const claim = { since: QUESTION.since, producer: "claude", reason: "permission", message };
    const state = stateOf(observed([instanceRow("soul", "asks", { waitingOnYou: claim })])), d = draw(state, S160);
    assert.deepEqual(fact(factsOf(detailLines(d, S160)), "needs").rows, [`${waitingLabel(claim)}, ${waitedText(claim.since, NOW)}`], JSON.stringify(message.slice(0, 20)));
    for (const line of d.lines) assert.equal(line.includes("the agent:"), false);
    d.cells.forEach((line) => line.forEach((cell) => assert.doesNotMatch(cell.text, CONTROL)));
  }
});

test("the home path is cut from the left, so its end is read: the cut mark first, then the end of the path up to the pane's last cells", () => {
  const home = `${DEPLOYMENT}/agents/acme-ledger-developer/instances/${KERNEL_DEV}`;
  for (const ascii of [false, true]) for (const sz of [S80, S120, size(100, 24)]) {
    const d = draw(golden({ ascii }), sz), list = listWidth(sz.cols), cut = glyphsOf(ascii).cut;
    const r = bodyRows(sz).find((row) => cellText(d, row, list + 1).trim().startsWith("home "));
    const cells = d.cells[r].slice(list + 1), line = cells.map((cell) => cell.text).join("");
    const from = line.indexOf("home") + 4 + line.slice(line.indexOf("home") + 4).search(/\S/), value = line.slice(from).trimEnd();
    assert.equal(value.startsWith(cut), true, `${sz.cols}: the first cells of the value are the cut mark`);
    assert.equal(home.endsWith(value.slice(cut.length)), true, `${sz.cols}: the rest is the end of the path`);
    assert.equal(value.at(-1), home.at(-1));
    assert.equal(value.slice(cut.length).length >= 20, true, `${sz.cols}: as much of the path as the pane has cells`);
    assert.equal(list + 1 + from + value.length, sz.cols - 1, `${sz.cols}: the value ends one cell before the screen's edge`);
  }
  assert.deepEqual(fact(detailOf(golden()), "home").rows, [home], "a path that fits is whole, with no mark");
});

test("in the wide layout tab moves the focus to the detail, which says so with `>` beside its title, and the cheat sheet says what the detail's focus offers; tab or Esc moves it back", () => {
  for (const sz of [S80, S120, size(100, 24)]) {
    const list = golden(), focused = press(list, ["tab"], sz).state, before = draw(list, sz), after = draw(focused, sz), width = listWidth(sz.cols);
    assert.equal(cellText(before, 0, width + 1).trim(), KERNEL_DEV);
    assert.equal(cellText(after, 0, width + 1).trim(), `> ${KERNEL_DEV}`);
    assert.equal(factsOf(detailLines(after, sz)).focused, true);
    // The list is still drawn beside it, with its selection, and nothing else of the detail changes.
    assert.deepEqual(listLines(after, sz), listLines(before, sz));
    assert.deepEqual(detailLines(after, sz).slice(1), detailLines(before, sz).slice(1), "nothing else of the detail changes");
    assert.deepEqual(hintsOf(after), DETAIL_SHEET.slice(0, hintsOf(after).length), `${sz.cols}x${sz.rows}: the detail's hints, from the first`);
    if (sz.rows >= 40) assert.deepEqual(hintsOf(after), DETAIL_SHEET);
    for (const key of ["tab", "escape"]) assert.deepEqual(draw(press(focused, [key], sz).state, sz).lines, before.lines, `${key} returns to the list`);
  }
});

test("at 79 columns tab replaces the list by the detail, a page over the whole screen from its top row, and tab or Esc returns to the list", () => {
  const list = golden(), paged = press(list, ["tab"], S79).state, d = draw(paged, S79);
  assert.deepEqual(d.lines, [
    pageTop(` > ${KERNEL_DEV}`, "Tab back   Enter open   n spawn", 79),
    "   soul     acme-ledger-developer",
    "   state    running",
    `   needs    ${NEEDS}`,
    "            the agent: \"Which base should it use?\"",
    "   harness  claude, claude-opus-5-5 (soul)",
    `   work     worktree, agents/${KERNEL_DEV}`,
    "   team     eng",
    `   parent   ${KERNEL_EXPERT}`,
    `   started  ${STARTED}`,
    "   home     …acme-ledger-developer/instances/acme-ledger-developer-note-target",
    ...Array.from({ length: 13 }, () => ""),
  ]);
  // No list row is drawn under the page: no cell is in reverse.
  d.cells.forEach((line, r) => line.forEach((cell, x) => assert.equal(cell.style.reverse, false, `no list row is drawn under the page (${r}, ${x})`)));
  for (const key of ["tab", "escape"]) assert.deepEqual(draw(press(paged, [key], S79).state, S79).lines, draw(list, S79).lines, `${key} returns to the list`);
  // At 60x15 the page has every row of the screen, and this one is whole.
  const whole = draw(paged, S60);
  assert.deepEqual([whole.extent, whole.room], [11, 15]);
  assert.equal(whole.lines[10].trim().startsWith("home "), true, "its last fact on its eleventh row");
  // A page taller than its room (a held home that waits, with a long message) scrolls with the
  // movement keys and says what is cut off, on the screen's last row.
  const tall = { retirePending: true, retire: { state: "interrupted", since: "2026-10-15T00:00:00Z", self: true }, parentInstance: "root", siblingInstance: "twin", waitingOnYou: { ...QUESTION, message: TOLD } };
  const long = press(selecting(stateOf(observed([instanceRow("soul", "root"), instanceRow("soul", "twin"), instanceRow("soul", "held-tall", tall)])), "held-tall", S60), ["tab"], S60).state;
  const small = draw(long, S60);
  assert.equal(small.extent > small.room, true);
  assert.equal(small.lines[14].trim(), cutNote(0, small.extent - (small.room - 1)), "on the page's last row");
  const scrolled = press(long, ["G"], S60).state, end = draw(scrolled, S60);
  assert.equal(end.lines[14].trim(), cutNote(end.extent - (end.room - 1), 0));
  assert.equal(end.lines.slice(0, 14).some((line) => line.trim().startsWith("home ")), true, "the last fact is on the screen");
  // Scrolled, the page's first row is a fact's, and the keys still stand at its right, as many as fit
  // after it (`w workspaces` is given up first).
  assert.equal(end.lines[0].endsWith("   Tab back   n spawn"), true, end.lines[0]);
  // A held home does not open: its page's keys have no Enter.
  assert.equal(draw(press(scrolled, ["g"], S60).state, S60).lines[0], pageTop(" > held-tall", "Tab back   n spawn   w workspaces", 60));
});

test("a resize from 100 to 79 columns with the detail focused shows the detail as the page, and back at 100 the two sides", () => {
  const focused = press(golden(), ["tab"], size(100, 24)).state;
  const wide = draw(focused, size(100, 24)), narrow = draw(focused, S79);
  assert.equal(wide.cells[3][48].text, "│");
  assert.equal(wide.lines.some((line) => line.includes("Acme maintainer ops")), true, "at 100 columns the list is beside the detail");
  assert.equal(narrow.lines[0], pageTop(` > ${KERNEL_DEV}`, "Tab back   Enter open   n spawn", 79));
  assert.equal(narrow.lines.some((line) => line.includes("Acme maintainer ops")), false, "at 79 the detail is the page: no list row");
  assert.deepEqual(labels(factsOf(detailLines(narrow, S79))), ["soul", "state", "needs", "harness", "work", "team", "parent", "started", "home"]);
  assert.deepEqual(draw(focused, size(100, 24)).lines, wide.lines);
});

test("under 60x15 the screen is one line saying the terminal is too small, with the size found and the size needed, and back at 80x24 the same state is drawn as before", () => {
  assert.deepEqual({ ...MIN_SIZE }, { cols: 60, rows: 15 });
  for (const state of [golden(), press(golden(), ["tab"]).state, press(golden(), ["?"]).state, press(fresh(), ["/", "t", "u", "i"]).state, stateOf()]) {
    const before = draw(state, S80);
    for (const sz of [size(59, 15), size(60, 14), size(40, 10), size(79, 14), size(59, 40)]) {
      const d = draw(state, sz), said = d.lines.filter(Boolean);
      assert.equal(said.length, 1, `${sz.cols}x${sz.rows}: one line`);
      assert.equal(d.lines[0], said[0], "on the first row");
      assert.match(said[0], /too small/);
      assert.equal(said[0].includes(`${sz.cols}x${sz.rows}`) || sz.cols < 30, true, "it names the size found");
      assert.equal(said[0].includes("60x15") || sz.cols < 49, true, "and the size needed");
      d.cells.forEach((line) => line.forEach((cell) => assert.equal(cell.style.reverse, false)));
      // A key pressed on the small screen that changes nothing of the view leaves the state as it was.
      assert.deepEqual(draw(press(state, ["ctrl+l"], sz).state, S80).lines, before.lines);
    }
    assert.deepEqual(draw(state, S80).lines, before.lines, "back at 80x24 the state is drawn as before");
  }
});

// ── The cheat sheet ──────────────────────────────────────────────────────────────────────────────

test("the cheat sheet is small, one hint per row with its first key: led by the leader and the palette, then what Enter does now and `n spawn`, `help` and `quit` last; the acts and the list's own keys are not on it", () => {
  assert.deepEqual(sheetOf(draw(golden(), S120)), sheet(LIST_SHEET), "the list: Enter, `n spawn`, help and quit");
  assert.deepEqual(sheetOf(draw(golden(), S80)), sheet(SHEET_80), "at 80x24 the six rows under the roster hold the whole sheet");
  assert.deepEqual(sheetOf(draw(golden(), S60)), sheet([LEAD]), "at 60x15 the leader alone");
  assert.deepEqual(sheetOf(draw(press(golden(), ["tab"], S120).state, S120)), sheet(DETAIL_SHEET), "the detail's focus: `Tab back` after the palette, then Enter and `n spawn`");
  // The selected row's acts are the palette's (and their keys still open them): the sheet names none.
  assert.deepEqual(paletteActs(golden()), ["stop", "retire"]);
  assert.deepEqual(sheetOf(draw(press(golden(), ["?"], S120).state, S120)), sheet(HELP_SHEET), "over the help, its keys");
  for (const sz of SIZES) for (const state of [golden(), press(golden(), ["tab"]).state, press(golden(), ["/", "t", "u", "i", "enter"]).state, stateOf(), stateOf(observed([]))]) {
    // Under 80 columns the detail's focus has the whole screen, with no cheat sheet.
    if (state.focus === "detail" && sz.cols < WIDE) { assert.equal(detailPage(draw(state, sz)), true, `${sz.cols}x${sz.rows}: the detail's page`); continue; }
    const hints = hintsOf(draw(state, sz));
    assert.deepEqual(hints[0], LEAD, `${sz.cols}x${sz.rows}: the leader first, always`);
    if (sz.rows >= 40) assert.deepEqual(hints.slice(-2), [["?", "help"], ["q", "quit"]], `${sz.cols}x${sz.rows}: help and quit last where the sheet has the rows`);
  }
});

test("the cheat sheet is read from the effective table: a key the user's tui.json gave is the one shown, and an action it unbound is gone", () => {
  const config = effectiveConfig({ keys: { quit: ["x"], spawn: [] } });
  assert.equal(config.ok, true);
  for (const sz of [S120, size(80, 40), size(60, 40)]) {
    assert.deepEqual(hintsOf(draw(golden({ actions: config.actions }), sz)), [LEAD, ["Ctrl+K", "palette"], ["Enter", "open"], ["w", "workspaces"], ["?", "help"], ["x", "quit"]], `${sz.cols}x${sz.rows}`);
  }
  const rebound = effectiveConfig({ keys: { help: ["f1"], detail: ["d", "tab"], refresh: ["f5", "r"], close: ["backspace"] } });
  assert.deepEqual(hintsOf(draw(golden({ actions: rebound.actions }), S120)), [LEAD, ["Ctrl+K", "palette"], ["Enter", "open"], ["n", "spawn"], ["w", "workspaces"], ["F1", "help"], ["q", "quit"]]);
  // The detail's `back` is the detail action's first key.
  assert.deepEqual(hintsOf(draw(press(golden({ actions: rebound.actions }), ["d"], S120).state, S120)), [LEAD, ["Ctrl+K", "palette"], ["d", "back"], ["Enter", "open"], ["n", "spawn"], ["w", "workspaces"], ["F1", "help"], ["q", "quit"]]);
});

test("when the sidebar is short the cheat sheet gives its hints up from its end, down to the leader alone, and a long key stands whole on its row with the words in one column after the widest", () => {
  const kept = press(fresh(), ["/", "t", "u", "i", "enter"]).state, all = hintsOf(draw(kept, size(140, 40)));
  assert.deepEqual(all, LIST_SHEET, "with room, the whole sheet, help and quit last");
  for (let rows = 15; rows <= 40; rows++) {
    const hints = hintsOf(draw(kept, size(80, rows)));
    assert.equal(hints.length >= 1, true, `${rows} rows: the leader at least`);
    assert.deepEqual(hints, all.slice(0, hints.length), `${rows} rows: the first hints, in order`);
  }
  assert.equal(hintsOf(draw(kept, size(80, 15))).length < hintsOf(draw(kept, size(80, 24))).length, true, "fewer rows, fewer hints");
  const long = effectiveConfig({ keys: { help: ["ctrl+shift+f12"], quit: ["ctrl+shift+f11"] } });
  for (const sz of [size(60, 40), size(80, 40)]) {
    const d = draw(golden({ actions: long.actions }), sz);
    assert.deepEqual(sheetOf(d).slice(-2), [" Ctrl+Shift+F12   help", " Ctrl+Shift+F11   quit"], `${sz.cols}: whole, the words three cells after the widest key`);
    assert.equal(sheetOf(d)[0], ` ${LEADER_KEY}${" ".repeat(11)}commands`, `${sz.cols}: every word in that column`);
  }
});

test("while the filter field is open the open view's heading is the field, `/` in bold and the query, and the cheat sheet says how to keep and clear it", () => {
  for (const sz of SIZES) {
    const open = press(fresh(), ["/"], sz).state, typed = press(open, ["l", "e", "d", "g", "e", "r", "space", "d", "e", "v"], sz).state;
    for (const [state, query] of [[open, ""], [typed, "ledger dev"]]) {
      const d = draw(state, sz), r = openRow(d), at = `${sz.cols}x${sz.rows} /${query}`;
      assert.equal(cellText(d, r, 0, d.cols), viewLine(`/${query}`, "1", d.cols), `${at}: the field in the heading's place, the view's key kept`);
      assert.deepEqual(d.cells[r][1].style, style({ bold: true }), `${at}: \`/\` in bold`);
      // At 60x15 the whole roster under the empty field scrolls, and the sheet keeps the leader alone.
      assert.deepEqual(hintsOf(d), sz === S60 && query === "" ? [LEAD] : [LEAD, ["Enter", "keep"], ["Esc", "clear"]], `${at}: the field's keys and nothing else`);
    }
  }
  const rebound = effectiveConfig({ keys: { close: ["f2"] } });
  assert.deepEqual(hintsOf(draw(press(fresh({ actions: rebound.actions }), ["/"]).state, S80)).at(-1), ["F2", "clear"]);
});

test("a kept filter is named on the open view's heading, `Instances  /query` in bold, and the list holds the rows it matches; Esc clears it", () => {
  const kept = press(fresh(), ["/", "m", "a", "i", "n", "t", "enter"]).state;
  for (const sz of SIZES) {
    const d = draw(kept, sz), r = openRow(d), at = `${sz.cols}x${sz.rows}`;
    assert.equal(cellText(d, r, 0, d.cols), viewLine("Instances  /maint", "1", d.cols), at);
    for (const cell of d.cells[r].slice(12, 18)) assert.equal(cell.style.bold, true, `${at}: the filter is bold, as the name is`);
    const drawn = listLines(d, sz).filter((line) => line.trim());
    assert.equal(drawn.length === 1 && drawn[0].includes("Acme maintainer ops"), true, `${at}: the one instance that matches, and no other`);
    assert.equal(hintsOf(d).some(([key]) => key.startsWith("/m")), false, `${at}: the query is not in the cheat sheet`);
  }
  // The sheet is small: Esc, which clears the filter, is the help's and the palette's, not the sheet's.
  assert.deepEqual(hintsOf(draw(kept, S120)), LIST_SHEET, "the list's sheet, with no Esc");
  const cleared = draw(press(kept, ["escape"]).state, S120);
  assert.equal(cellText(cleared, 2, 0, 57), viewLine("Instances", "1", 57), "Esc clears a kept filter");
  assert.deepEqual(hintsOf(cleared), LIST_SHEET, "and the sheet is the same");
});

test("a query of 200 characters is cut inside the heading, open and kept, with the cut mark, and the view's key keeps its place at the right edge", () => {
  const query = "abcdefghij".repeat(20), keys = ["/", ...query];
  const open = press(fresh(), keys).state, kept = press(open, ["enter"]).state;
  assert.equal(open.filter.query, query);
  for (const ascii of [false, true]) for (const sz of [...SIZES, size(300, 24)]) {
    const cut = glyphsOf(ascii).cut;
    for (const [d, lead] of [[draw({ ...open, ascii }, sz), " /"], [draw({ ...kept, ascii }, sz), " Instances  /"]]) {
      const line = cellText(d, openRow(d), 0, d.cols), at = `${sz.cols}${ascii ? " ascii" : ""}: ${line}`;
      assert.equal(line.startsWith(`${lead}abcdefghij`), true, at);
      assert.equal(line.endsWith(" 1"), true, `${at}: the key at the right edge, a cell apart`);
      const shown_ = line.slice(lead.length, -2).trimEnd();
      assert.equal(shown_.endsWith(cut) && query.startsWith(shown_.slice(0, -cut.length)), true, `${at}: the query ends in the cut mark`);
      assert.equal(textWidth(line) <= d.cols - 1, true, `${at}: inside the sidebar's margin`);
    }
  }
});

// ── The help, at the smallest width ──────────────────────────────────────────────────────────────

test("at 60 columns, the smallest width the frame is drawn at, the help still names every command whole: what this version does not do is said with the oats command that does it", () => {
  for (const ascii of [false, true]) {
    const lines = helpLines(golden({ ascii }), size(60, 330)), cut = glyphsOf(ascii).cut;
    for (const command of [...NOT_YET.map((entry_) => entry_.command), ...VIEWS.flatMap((view) => view.commands)]) {
      assert.equal(commandIn(lines, command), true, `${command} is whole at 60 columns${ascii ? ", in ASCII" : ""}`);
    }
    for (const line of lines) assert.equal(line.endsWith(cut), false, `no row of the help is cut at 60 columns: ${line.trim()}`);
  }
});

test("at 60 columns the help's family lines (keys.json, docs/tui.md \"Switch family\") stand whole in the chords' section: each word once, in order, no row cut, in every family, the note too", () => {
  const ALT = 'Shortcuts: Alt. To leave Alt to the programs in your terminals, set "chords": "ctrl+alt" in keys.json (or "ctrl+shift", for foot and Alacritty) and restart.';
  const SAID = Object.freeze([
    [null, [ALT]],
    [chordFamilyFrom('{ "chords": "ctrl+alt" }'), ["Shortcuts: Ctrl+Alt, from keys.json, but this terminal does not confirm the kitty keyboard protocol: use the leader."]],
    [chordFamilyFrom('{ "chords": "ctrl+shift" }'), ["Shortcuts: Ctrl+Shift, from keys.json, but this terminal does not confirm the kitty keyboard protocol: use the leader."]],
    [chordFamilyFrom('{ "chords": 7 }'), [ALT, "keys.json: unknown chords value, using Alt"]],
  ]);
  for (const [keysRead, sentences] of SAID) {
    const state = golden({ platform: "linux", ...(keysRead ? { keysRead } : {}) });
    const lines = helpLines(state, size(60, 330)), cut = glyphsOf(false).cut;
    const from = lines.findIndex((line) => line.trim() === "Chords"), to = nextHeading(lines, from);
    assert.equal(from >= 0 && to > from, true, "the chords' section: first in the Alt family, after the leader's in the others (no protocol)");
    const section = lines.slice(from + 1, to).map((line) => line.trim()).filter(Boolean).join(" ");
    assert.equal(section.startsWith(sentences.join(" ")), true, `${section.slice(0, 160)}`);
    for (const line of lines.slice(from, to)) assert.equal(line.endsWith(cut), false, `no row is cut: ${line.trim()}`);
  }
});

// ── The help ─────────────────────────────────────────────────────────────────────────────────────

// Wide enough that the help, in the main area beside the sidebar, has 140 columns (203 less the
// sidebar's 60 and three cells), and tall enough for the whole help (T3 added the split's rows,
// keymap phase 3 the chords' section on Linux and Windows, and the Alt family all its chords there).
const HELP_SIZE = size(203, 260);
/** The help's rows under its top row (the time of the read), opened with `key`: the main area's
 *  cells from 80 columns, the whole width under them. */
function helpLines(state, sz = HELP_SIZE, key = "?") {
  const d = draw(press(state, [key], sz).state, sz), from = sz.cols >= WIDE ? d.cols + 2 : 0;
  assert.equal(d.extent <= d.room, true, "the whole help is on this screen");
  return d.cells.slice(1).map((_, i) => cellText(d, i + 1, from));
}
/** The help's first heading: the chords, where the default family, Alt, is read without the kitty
 *  keyboard protocol (the tests' platform is Linux: helpers.mjs TEST_PLATFORM). */
const FIRST_HEADING = "Chords";
/** The help's headings, in no order: a section of the help runs from its heading to the next. */
const HELP_HEADINGS = Object.freeze(["Keys", "Chords", "The leader", "The palette", "The spawn prompt", "Marks", "Views", "Machines", "Not in this version"]);
/** The row of the heading after row `from` of the help's `lines` (trimmed or not), or -1. The
 *  leader's section is followed by the chords', whose Alt+Shift arrows are read without the kitty
 *  keyboard protocol. */
const nextHeading = (lines, from) => lines.findIndex((line, i) => i > from && HELP_HEADINGS.includes(line.trim()));
/** Whether `command` starts on row `i` of the help's `lines` (as drawn, not trimmed): alone on it,
 *  or, wider than the area, broken before its flags onto the rows under it, each of those 2 cells
 *  further in than the first and starting with its flag, which read back in order are the
 *  command, nothing left out. */
function commandAt(lines, i, command) {
  const indent = (line) => line.length - line.trimStart().length;
  if (lines[i] === undefined || !(command === lines[i].trim() || command.startsWith(`${lines[i].trim()} --`))) return false;
  let read = lines[i].trim();
  for (let j = i + 1; read.length < command.length && lines[j] !== undefined && indent(lines[j]) === indent(lines[i]) + 2 && lines[j].trim().startsWith("--"); j++) read += ` ${lines[j].trim()}`;
  return read === command;
}
/** Whether `command` stands in the help's `lines`: on one row, or broken as commandAt reads it. */
const commandIn = (lines, command) => lines.some((line, i) => line.includes(command) || commandAt(lines, i, command));
/** A table row of the help: `left`, a gap, `right`. */
const pair = (lines, left, right) => lines.some((line) => { const text = line.trim(); return text.startsWith(`${left} `) && text.endsWith(` ${right}`) && text.slice(left.length, text.length - right.length).trim() === ""; });

test("the help lists every action of the table it is given with its keys, and an unbound action as `(no key)`", () => {
  const lines = helpLines(golden());
  // An action that does one thing in each view has a line per view, its keys on each.
  // An action with no key by default (the split's group-next, group-previous, tab-move and group-close, which the
  // leader reaches) is listed as `(no key)`, as one tui.json unbinds.
  const labelOf = (action) => (action.keys.length ? keysLabel(action) : "(no key)");
  for (const action of ACTIONS) for (const said of action.views ? action.views.map(([, words]) => words) : [action.label]) assert.equal(pair(lines, labelOf(action), said), true, `${action.id}: ${labelOf(action)} ${said}`);
  for (const [keys, label] of [["Up, k", "up"], ["Down, j", "down"], ["g, Home", "first"], ["G, End", "last"], ["PageUp", "page up"], ["PageDown", "page down"], ["Tab", "detail"], ["/", "filter"], ["r", "refresh"], ["1", "instances"], ["2", "souls"], ["3", "capabilities"], ["w", "workspaces"], ["Enter", "open the selected agent's terminal as a tab beside the list, or show its tab when it has one, in the list of instances"], ["z", "go to the shown terminal with the whole screen; the leader then Esc brings the list back"], ["c", "close the shown terminal and show its neighbour; the agent keeps running"], ["[", "show the terminal of the tab before the shown one"], ["]", "show the terminal of the tab after the shown one"], ["Enter", "open the selected workspace, in the switcher"], ["Delete", "remove the selected row of this computer's list of deployments, after a confirmation; its folder stays"], ["?", "help"], ["Esc", "close"], ["q, Ctrl+C", "quit"], ["Ctrl+Z", "suspend"], ["Ctrl+L", "redraw"]]) {
    assert.equal(pair(lines, keys, label), true, `${keys} ${label}`);
  }
  const config = effectiveConfig({ keys: { quit: ["x"], filter: [], refresh: ["r", "f5"], suspend: [] } });
  // The keys of the action table, before the leader's section: that one is fixed, and has a `/` of its own.
  const all = helpLines(golden({ actions: config.actions })), changed = all.slice(0, all.findIndex((line) => line.trim() === "The leader"));
  assert.equal(changed.length > 0 && pair(all.slice(changed.length), "/", "filter"), true, "the leader's `/` is its own");
  assert.equal(pair(changed, "x", "quit"), true);
  assert.equal(pair(changed, "(no key)", "filter"), true);
  assert.equal(pair(changed, "(no key)", "suspend"), true);
  assert.equal(pair(changed, "r, F5", "refresh"), true);
  assert.equal(pair(changed, "q, Ctrl+C", "quit") || pair(changed, "/", "filter"), false);
});

test("the help is generated from the table: another key and another action appear as given", () => {
  const table = Object.freeze([...ACTIONS.filter((action) => action.id !== "redraw"), Object.freeze({ id: "zap", keys: Object.freeze(["f9", "ctrl+y"]), label: "zap the thing" })]);
  const lines = helpLines(golden({ actions: table }));
  assert.equal(pair(lines, "F9, Ctrl+Y", "zap the thing"), true);
  assert.equal(lines.some((line) => line.includes("redraw") || line.includes("Ctrl+L")), false, "an action that is not in the table is not in the help");
  const keys = lines.slice(lines.findIndex((line) => line.trim() === "Keys") + 1, lines.findIndex((line) => line.trim() === "The leader")).filter((line) => line.trim());
  // One row per action and view; under the line of opening an agent, five rows of its own (the leader then Esc, the leader twice,
  // what the terminal takes, its limits, the pointer), and a sixth where there are chords (CHORD_OPEN_RULE: on Linux and Windows
  // the Alt+Shift arrows, read without the kitty keyboard protocol); under the line of the last act, the rows of ACT_RULES. Then the leader's
  // section: the leader, a row per key of its table, whatever the action table, and the leader again's row. The chords' section
  // follows it where there are chords (nextHeading), then the palette's and the spawn prompt's, with keys of their own.
  const at = lines.findIndex((line) => line.trim() === "The leader");
  const leader = lines.slice(at + 1, nextHeading(lines, at)).filter((line) => line.trim());
  assert.equal(leader.length, 2 + LEADER.length, "the leader, one row per key of its table, and the leader again");
  const rules = keys.filter((line) => ACT_RULES.some((sentence) => sentence.includes(line.trim())));
  assert.equal(rules.length >= ACT_RULES.length, true, "the rules of the acts stand under them");
  const chorded = keys.some((line) => line.trim() === CHORD_OPEN_RULE);
  assert.equal(chorded, true, "the chords' rule under the agent's line");
  assert.equal(keys.length, table.reduce((n, action) => n + (action.views?.length ?? 1), 0) + 5 + (chorded ? 1 : 0) + rules.length, "one row per action, and one more per view of an action that has two");
});

test("the help lists the marks with their words, in UTF-8 and in ASCII: each mark the list draws is there", () => {
  for (const ascii of [false, true]) {
    const lines = helpLines(golden({ ascii })), marks = marksOf(ascii);
    const from = lines.findIndex((line) => line.trim() === "Marks"), to = lines.findIndex((line) => line.trim() === "Views");
    assert.equal(from > 0 && to > from, true);
    const section = lines.slice(from + 1, to).map((line) => line.trim()).filter(Boolean);
    const said = (mark, word) => section.some((line) => line.split(" ")[0] === mark && line.slice(mark.length).includes(word));
    assert.equal(said(marks.running, "running"), true);
    assert.equal(said(marks.stopped, "stopped"), true);
    assert.equal(said(marks.shell, "shell"), true);
    assert.equal(said(marks.unknown, "state unknown"), true);
    assert.equal(said(marks.held, "held"), true);
    assert.equal(said(marks.waiting, `${NEEDS_INPUT}: in place of the state mark, in yellow and reverse video`), true, "the needs-input mark");
    assert.equal(said(marks.selected, "selected"), true);
    assert.equal(said("N", `N instances folded away below it need input: ${belowText("N")} where the whole name fits`), true, "and the roll-up of a collapsed row");
    assert.equal(said("+N", "folded away"), true, "a folded row's count: no fold mark");
    // The Souls view's and the spawn picker's: a soul, and a soul a spawn here would refuse.
    assert.equal(said(ascii ? SOUL_MARK.ascii : SOUL_MARK.utf8, "among the souls: a soul"), true, "the soul mark");
    assert.equal(said("!", "would be refused"), true, "the refused soul's mark");
    for (const [name, mark] of Object.entries(marks)) assert.equal(section.some((line) => line.split("  ")[0].split(" ").includes(mark) || line.startsWith(mark)), true, `${name}: ${mark}`);
  }
});

test("the help says what each view holds, and names no command for a view: the Souls view spawns now (n), and the Capabilities view lists the capabilities, a capability's skills and files being the one thing left to the kernel's command", () => {
  const lines = helpLines(golden());
  const line = (name) => lines.find((text) => text.trim().startsWith(name));
  assert.equal(line("2 Souls").includes("the souls of the open workspace") && line("2 Souls").includes("n an agent of the selected soul"), true);
  assert.equal(line("2 Souls").includes("oats spawn") || line("2 Souls").includes("not in this version"), false, "spawning is in this version: the Souls view names no command for it");
  assert.equal(line("3 Capabilities").includes("the capabilities of the open workspace and their detail, Enter on a soul that uses one shows it in Souls"), true);
  assert.equal(line("3 Capabilities").includes("oats capabilities") || line("3 Capabilities").includes("not in this version"), false, "the Capabilities view is in this version: it names no command");
  assert.deepEqual(VIEWS.map((view) => view.commands), [[], [], []], "no view names a command");
  assert.deepEqual(NOT_YET.filter((entry_) => entry_.command.startsWith("oats capabilities")), [{ what: "see a capability's skills and files", command: "oats capabilities show <name>" }], "what the view does not show is left to `oats capabilities show`");
  assert.equal(typeof line("1 Instances"), "string");
  for (const view of VIEWS) for (const command of view.commands) assert.equal(line(view.name).includes(command), true, `${view.name}: ${command}`);
  assert.deepEqual(VIEWS.map((view) => view.name), ["1 Instances", "2 Souls", "3 Capabilities"], "the views the frame names");
});

test("the help's last section, `Not in this version`, names every act this version does not have with the oats command that does it", () => {
  for (const ascii of [false, true]) for (const sz of [HELP_SIZE, size(60, 330), size(79, 300), size(200, 230)]) {
    const lines = helpLines(golden({ ascii }), sz), text = lines.map((line) => line.trim());
    const at = text.indexOf("Not in this version");
    assert.equal(at > 0, true);
    for (const heading of ["Keys", "Marks", "Views"]) assert.equal(text.indexOf(heading) >= 0 && text.indexOf(heading) < at, true, `${heading} comes before it`);
    const section = text.slice(at + 1), drawn = lines.slice(at + 1);
    // Each act with its command: beside it, or from the row under it where the width has no room
    // for both (broken before its flags where it is wider than the area).
    for (const { what, command } of NOT_YET) {
      const row = section.findIndex((line) => line === what || line.startsWith(`${what} `));
      assert.equal(row >= 0, true, what);
      assert.equal(pair([section[row]], what, command) || commandAt(drawn, row + 1, command), true, `${sz.cols}: ${what}: ${command}`);
    }
    // Stop, start, restart and retire are acts of this version: only another launch is left to the kernel's command.
    // A spawn on another machine, or with a harness, a model or a task, is the kernel's: the spawn prompt offers none of them.
    for (const command of ["oats session attach --home <home>", "oats session start --home <home>", "oats server connect", "oats server check", "oats server remove", "oats tui --dir <path>", "oats spawn <soul>"]) {
      assert.equal(section.some((line) => line.includes(command)), true, `the spec's ${command}`);
    }
    for (const command of ["oats instance stop", "oats retire"]) {
      assert.equal(section.some((line) => line.includes(command)), false, `${command}: an act of this version, not named as missing`);
    }
  }
});

test("the help scrolls: at 60x15 it does not fit, the screen's last row says what is cut off, and the movement keys move it to its end and back", () => {
  const sz = S60, open = press(golden(), ["?"], sz).state, d = draw(open, sz);
  assert.equal(d.extent > d.room, true);
  assert.equal(d.room, sz.rows - 1, "every row but the help's top row");
  const visible = d.room - 1;
  assert.equal(d.lines[1].trim(), FIRST_HEADING, "the Alt family's chords lead the help on Linux and Windows");
  assert.equal(d.lines[sz.rows - 1].trim(), cutNote(0, d.extent - visible));
  const down = draw(press(open, ["j"], sz).state, sz);
  assert.equal(down.lines[sz.rows - 1].trim(), cutNote(1, d.extent - visible - 1));
  assert.equal(down.lines[1], d.lines[2], "one row down");
  const paged = draw(press(open, ["pagedown"], sz).state, sz);
  assert.notEqual(paged.lines[1], d.lines[1]);
  const ended = press(open, ["j", "G"], sz).state, end = draw(ended, sz);
  assert.equal(end.lines[sz.rows - 1].trim(), cutNote(d.extent - visible, 0));
  assert.equal(end.lines.slice(1, sz.rows - 1).some((line) => line.includes(NOT_YET.at(-1).command)), true, "the last section is on the screen");
  assert.deepEqual(draw(press(ended, ["G", "j", "pagedown"], sz).state, sz).lines, end.lines, "it stops at its end");
  assert.deepEqual(draw(press(ended, ["g"], sz).state, sz).lines, d.lines, "and goes back to its start");
  assert.deepEqual(draw(press(ended, ["k"], sz).state, sz).lines[sz.rows - 1].trim(), cutNote(d.extent - visible - 1, 1));
  // Every row of the help is reached by scrolling: nothing is lost behind the note.
  const whole = helpLines(golden(), size(60, 330)).map((line) => line.trim()).filter(Boolean), seen = new Set();
  let state = open;
  for (let i = 0; i < d.extent; i++) { for (const line of draw(state, sz).lines.slice(1, sz.rows - 1)) seen.add(line.trim()); state = press(state, ["j"], sz).state; }
  for (const line of whole) assert.equal(seen.has(line), true, line);
  assert.deepEqual(draw(press(ended, ["escape"], sz).state, sz).lines, draw(golden(), sz).lines, "Esc closes it");
});

// ── Keys from tui.json on the screen ─────────────────────────────────────────────────────────────

test("every key a tui.json may give an action is drawn: the cheat sheet and the help name it through shown(), placed by cells, at every size, and nothing throws", () => {
  const keys = { help: ["日"], quit: ["é", "alt+é"], close: ["\u{1f44d}\u{1f3fd}"], filter: ["ctrl+alt+shift+f12"], detail: ["shift+tab", "+"], refresh: ["alt++", "f5"], up: ["名", "k"] };
  const made = effectiveConfig({ keys });
  assert.equal(made.ok, true);
  const labelOf = (id) => keysLabel(made.actions.find((action) => action.id === id));
  for (const sz of SIZES) for (const ascii of [false, true]) {
    const state = golden({ actions: made.actions, ascii });
    for (const [what, s] of [["the list", state], ["the detail's focus", press(state, ["shift+tab"], sz).state], ["the open filter field", press(state, ["ctrl+alt+shift+f12", "x"], sz).state], ["a kept filter", press(state, ["ctrl+alt+shift+f12", "o", "enter"], sz).state], ["the help", press(state, ["日"], sz).state]]) {
      const d = draw(s, sz), at = `${what} at ${sz.cols}x${sz.rows}${ascii ? ", ASCII marks" : ""}`;
      for (const line of d.cells) assert.equal(line.length, sz.cols, `${at}: a row of the screen's width`);
      // Under 80 columns the help has the whole screen: its first row carries its key, Esc's in tui.json's.
      if (what === "the help" && sz.cols < WIDE) { assert.ok(cellText(d, 0).endsWith(`${labelOf("close")} close`), `${at}: ${cellText(d, 0)}`); continue; }
      // Under 80 columns the detail's focus has the whole screen, with no cheat sheet.
      if (what === "the detail's focus" && sz.cols < WIDE) { assert.equal(detailPage(d), true, at); continue; }
      const hints = hintsOf(d);
      assert.deepEqual(hints[0], LEAD, `${at}: the leader first`);
      // The open field's keys are its own, and the clear key is tui.json's; elsewhere help and quit are last, by their keys, where the sheet has the rows.
      if (what === "the open filter field") assert.deepEqual(hints, [LEAD, ["Enter", "keep"], [labelOf("close"), "clear"]], at);
      else if (sz.rows >= 40) assert.deepEqual(hints.slice(-2), [["日", "help"], ["é", "quit"]], at);
    }
    // The wide key takes two cells of its row: the words of the sheet stand in one column whatever cells the keys take.
    if (sz.rows >= 40) {
      const d = draw(state, sz), help = d.cells.findIndex((line) => line[1].text === "日"), quit = d.cells.findIndex((line) => line[1].text === "é");
      assert.equal(d.cells[help][2].width, 0, "the second cell of the wide key");
      assert.equal(cellIndexOf(d.cells[help].slice(0, d.cols), "help"), cellIndexOf(d.cells[quit].slice(0, d.cols), "quit"));
    }
    // Tall enough for the whole help, the switcher's Remove among it.
    const big = size(163, 260), lines = helpLines(state, big, "日");
    for (const id of Object.keys(keys)) assert.ok(lines.some((line) => line.trim().startsWith(`${labelOf(id)}  `)), `the help lists ${id} under ${labelOf(id)}`);
    assert.ok(lines.some((line) => line.trim() === `${labelOf("close").split(", ")[0]} or 日 closes this help`), "the closing line names the two keys");
    // The meanings stand in one column, whatever cells the keys take.
    const d2 = draw(press(state, ["日"], big).state, big), from = d2.cols + 2;
    const columns = new Set(["up", "help", "quit", "close"].map((id) => { const word = made.actions.find((action) => action.id === id).label.split(" ")[0]; const r = d2.cells.findIndex((line, i) => cellText(d2, i, from).trim().startsWith(`${labelOf(id)}  `)); return cellIndexOf(d2.cells[r], word); }));
    assert.equal(columns.size, 1, `one column for the meanings: ${[...columns]}`);
  }
});

test("a kept filter is not in the cheat sheet, which is the same whatever the query; long keys stand whole on their rows, help and quit last, and no hint passes the sidebar's margin", () => {
  const long = effectiveConfig({ keys: { help: ["ctrl+alt+shift+f11"], quit: ["ctrl+alt+shift+f12"] } });
  assert.equal(long.ok, true);
  const kept = (query, actions, sz) => draw(press(golden({ actions }), ["/", ...query, "enter"], sz).state, sz);
  for (const sz of [size(60, 40), size(80, 40), S120]) {
    const a = kept("a", long.actions, sz), b = kept("acme-ledger", long.actions, sz);
    assert.deepEqual(hintsOf(a), hintsOf(b), `${sz.cols}: the same sheet whatever the query`);
    assert.deepEqual(hintsOf(a).slice(-2), [["Ctrl+Alt+Shift+F11", "help"], ["Ctrl+Alt+Shift+F12", "quit"]], `${sz.cols}: help and quit last, whole`);
    assert.equal(hintsOf(a).some(([key]) => key.startsWith("/a")), false, `${sz.cols}: the query is not in the sheet`);
    for (const row of sheetOf(a)) assert.equal(textWidth(row) <= paneOf(sz) - 1, true, `${sz.cols}: ${row}`);
  }
  // Help is the leader's too: wherever the sheet gave it up, it is a key away (the leader, then ?).
  assert.equal(LEADER.some((entry) => entry.does === "help"), true);
});

test("a key label is text from outside for the views too: a table that reached them with a key the config refuses is still drawn, through shown(), and puts no control or bidi character on the screen", () => {
  // effectiveConfig refuses these (config.test.mjs); the views do not rest on that.
  const hostile = ["\u202E", " \u0301", "\u200B"];
  const actions = ACTIONS.map((action) => (action.id === "quit" ? { ...action, keys: [hostile[0], "q"] } : action.id === "help" ? { ...action, keys: [hostile[1]] } : action.id === "close" ? { ...action, keys: [hostile[2]] } : action));
  for (const sz of SIZES) {
    const state = golden({ actions });
    for (const s of [state, { ...state, view: "help" }, press(state, ["/", "x"], sz).state, press(state, ["/", "x", "enter"], sz).state]) {
      const d = draw(s, sz);
      for (const line of d.lines) assert.equal(CONTROL.test(line), false, `no control or bidi character at ${sz.cols}x${sz.rows}: ${JSON.stringify(line)}`);
      assert.equal(d.cells.every((line) => line.length === sz.cols), true);
    }
  }
});

// ── Other machines ───────────────────────────────────────────────────────────────────────────────
// A view of more than one deployment: this machine's, whose roster reports a workspace identity, and
// the machines a roster read answered for. Every outcome of that read reaches the store as the loop
// hands it on (lib/read.mjs): through the shared remoteRosterState and observeIdentities, never as a
// state made here. A group has the kernel's form: its id is `<server>:<targetKey>`, the server name
// in lower case, and each of its rows says whether it can be addressed.
const IDENTITY = Object.freeze({ key: "github.com/acme/platform", ref: "main", keyFrom: "workspace", standalone: false, defaultTeam: Object.freeze({ label: "eng", team: "team-1" }), teams: Object.freeze({ eng: "team-1" }), teamsFrom: "observed" });
/** Another workspace, for a machine that moves to it. */
const ELSEWHERE = Object.freeze({ ...IDENTITY, key: "github.com/acme/billing" });
/** A deployment whose teams are its own: the shared home leaves a note for it. */
const STANDALONE = Object.freeze({ ...IDENTITY, standalone: true, defaultTeam: null, teams: Object.freeze({}), teamsFrom: "local" });
/** A kernel that reads other machines: without `roster` the shared home makes no roster read. */
const REMOTE_CLI = Object.freeze({ ...CLI, remote: Object.freeze(["roster"]) });
/** An observed entry of this machine's deployment whose roster reports `identity`, through the same
 *  shared calls helpers.mjs `observed` makes (its roster reports none). */
function reporting(rows, { identity = IDENTITY, workspace = "acme-platform" } = {}) {
  const document = { ...rosterOf(rows), workspace: { reachable: true, ...identity } }, listed = rosterRows(document, REMOTE_CLI);
  const answers = listed.map((row) => ({ running: row.running, runtimeState: row.runtimeState, ...(row.runtimeError ? { runtimeError: row.runtimeError } : {}), tmux: row.tmux }));
  return observedEntry({ roster: document, workspaceStatus: { workspace: { name: workspace } }, observedAt: "2026-10-11T09:59:00.000Z" }, panelInstances(listed, answers), "2026-10-11T10:00:00.000Z");
}
/** This machine's rows: a cluster of two and a stopped single instance. */
const NEAR = () => [
  instanceRow("acme-ledger-expert", KERNEL_EXPERT),
  instanceRow("acme-ledger-developer", KERNEL_DEV, { parentInstance: KERNEL_EXPERT }),
  instanceRow("acme-maintainer", MAINTAINER, { running: false, runtimeState: "stopped" }),
];
const FAR = "/home/dev/Agents/acme", FAR_A = "acme-ledger-far-a", FAR_B = "acme-ledger-far-b", FAR_Q = "acme-ledger-far-q";
/** One row of a machine's roster, as its kernel reports it. */
const farRow = (name, extra = {}, root = FAR) => ({
  instance: name, agent: "acme-ledger-developer", home: `${root}/agents/acme-ledger-developer/instances/${name}`, agentsRoot: `${root}/agents`,
  work: "worktree", harness: "claude", running: true, runtimeState: "running", addressable: true, ...extra,
});
/** The machine `garnet`: reached, reporting this workspace, with a running row and a stopped one its
 *  kernel does not report addressable. */
const group = (extra = {}) => ({
  id: "garnet:acme-1", server: "garnet", label: "garnet", registrationPresent: true, target: { workspace: FAR, sshHost: "garnet.example" }, probe: { ok: true },
  workspace: IDENTITY, agentsRoot: `${FAR}/agents`, souls: [], instances: [farRow(FAR_A), farRow(FAR_B, { addressable: false, running: false, runtimeState: "stopped" })], ...extra,
});
/** A second machine, `quartz`, with one row. */
const quartz = (extra = {}) => group({ id: "quartz:acme-7", server: "quartz", label: "quartz", target: { workspace: "/srv/acme", sshHost: "quartz.example" }, agentsRoot: "/srv/acme/agents", instances: [farRow(FAR_Q, {}, "/srv/acme")], ...extra });
const GARNET = "remote:garnet:acme-1";
/** The times of three roster reads, fifteen seconds apart, after this machine's own read at 10:00:00. */
const T1 = "2026-10-11T10:00:10.000Z", T2 = "2026-10-11T10:00:25.000Z", T3 = "2026-10-11T10:00:40.000Z";
/** The store after one outcome of the roster read, made as the loop makes it. */
function heard(state, outcome, at) {
  const next = remoteRosterState(state.remote, outcome, at);
  const kept = next.reported === null ? { memory: state.memory, notes: state.notes } : observeIdentities({ memory: state.memory, notes: state.notes }, next.reported, at);
  return reduce(state, { roster: { remote: { remoteGroups: next.remoteGroups, rosterAnswered: next.rosterAnswered, rosterFailure: next.rosterFailure }, memory: kept.memory, notes: kept.notes, at } }).state;
}
const answered = (...groups) => ({ envelope: { ok: true, result: { groups } } });
/** A read that came back as an error, and a probe of one machine that ssh could not make. */
const TIMEOUT = Object.freeze({ envelope: { ok: false, error: { code: "E_CLI_TIMEOUT", message: "garnet did not answer" } } });
const UNPROMPTED = Object.freeze({ ok: false, error: { code: "E_SSH", message: "Permission denied (publickey)." } });
/** This machine alone; with garnet reached; with garnet reached and then not; with garnet, which has
 *  no row, reached and then not. */
const local = (options) => stateOf(reporting(NEAR()), { cli: REMOTE_CLI, ...options });
const reached = (options) => heard(local(options), answered(group()), T1);
const lost = (options) => heard(reached(options), TIMEOUT, T2);
const rowless = (options, label = "garnet") => heard(heard(local(options), answered(group({ label, instances: [] })), T1), TIMEOUT, T2);
/** A row of this computer's deployments list, as the shared reader gives it (packages/client
 *  deployment-list.mjs), and a read of the list that answered two rows the run does not serve. */
const listedRow = (name, state = "ok") => Object.freeze({ path: `/home/u/${name}`, name, state });
const LISTED = Object.freeze({ rows: Object.freeze([listedRow("acme-billing"), listedRow("acme-docs")]) });
/** The switcher over a workspace on two machines, one of them not reached now, beside a machine that
 *  was never reached in this run and two rows of the list that are not opened. */
function choosing(options) {
  const never = quartz({ probe: UNPROMPTED, workspace: null, instances: [] });
  const state = heard(heard(local(options), answered(group(), never), T1), answered(group({ probe: UNPROMPTED }), never), T2);
  return reduce(press(state, ["w", "w"]).state, { listed: LISTED }).state;
}
/** A switcher with all the list can put in it: stale rows, a Remove asked over the selected one (the
 *  last), what an earlier Remove answered and a read of the list that failed, each the kernel's words. */
function listing(switcher = choosing()) {
  const stale = reduce(switcher, { listed: { rows: [listedRow("acme-billing", "missing"), listedRow("acme-docs", "unreadable")] } }).state;
  const asked = press(press(stale, ["G"]).state, ["delete"]).state;
  const told = reduce(asked, { removed: { path: "/home/u/acme-billing", name: "acme-billing", ok: false, reason: { code: "E_DEPLOYMENTS_LOCKED", message: "busy" } } }).state;
  return reduce(told, { listed: { failure: { code: "E_DEPLOYMENTS_LOCKED", message: "busy" } } }).state;
}
/** A deployment of the open view, as the shared home lists it, and the shared words for it. */
const deploymentOf = (state, id = GARNET) => panelOf(state, AT).deployments.find((d) => d.id === id);
const UNKNOWN = runtimeState({ running: null });
/** The shared label of the reached machine's row that can't be addressed, and of a row of a
 *  machine that was not reached: the word each of those rows has in the list. */
const AWAY = () => rowReason(panelRow(reached(), FAR_B)).label;
const NOT_REACHED = () => rowReason(panelRow(lost(), FAR_A)).label;
/** `text` cut to `cells` with the cut mark, as the screen cuts a span. */
const cutTo = (text, cells, ascii = false) => (text.length <= cells ? text : `${text.slice(0, cells - glyphsOf(ascii).cut.length)}${glyphsOf(ascii).cut}`);
/** The switcher's rows as the shared home words them. */
const choicesOf = (state) => workspaceChoiceRows(workspaceChoices(heldOf(state, AT), TERMS));
/** A row of the screen with each text at its column: a frame pins the columns, and takes a word of
 *  the shared home from the shared home. */
function placed(...parts) {
  const line = [];
  for (const [col, text] of parts) [...text].forEach((ch, i) => { line[col + i] = ch; });
  return Array.from(line, (ch) => ch ?? " ").join("").trimEnd();
}
/** A sentence on rows of at most `width` cells, broken at its spaces: what its wrapped rows are to
 *  hold. Every word of the sentences wrapped here is shorter than a row. */
function wrap(sentence, width) {
  return sentence.split(" ").reduce((rows, word) => {
    if (rows.length && rows.at(-1).length + 1 + word.length <= width) rows[rows.length - 1] = `${rows.at(-1)} ${word}`;
    else rows.push(word);
    return rows;
  }, []);
}
/** Every row of a frame takes exactly the terminal's columns, and no wide grapheme is split. */
function fits(d, sz, at) {
  assert.equal(d.cells.length, sz.rows, at);
  d.cells.forEach((line, r) => {
    assert.equal(line.length, sz.cols, `${at}: row ${r} has the terminal's cells`);
    assert.equal(line.reduce((sum, cell) => sum + cell.width, 0), sz.cols, `${at}: row ${r}: its graphemes take exactly the terminal's columns`);
    assert.equal(textWidth(d.lines[r]) <= sz.cols, true, `${at}: row ${r} is no wider than the terminal`);
  });
}

test("this machine and a reached machine in one view at 80x24 in UTF-8, cell for cell: the open workspace's name alone in its row of the list of workspaces, a heading per deployment, the machine's with the time of the roster read, and a `machine` line in the detail", () => {
  const d = draw(reached(), S80);
  assert.deepEqual(d.lines, beside(instancesSide(workspaceLine("acme-platform"), [
    " This machine",
    "> ● Acme ledger expert retire",
    "    ● Acme ledger developer note…",
    "",
    "  ○ Acme maintainer ops",
    " garnet                 read 10:00:10",
    "  ● Acme ledger far a",
    `  ○ Acme ledger far…  ${cutTo(AWAY(), 11)}`,
  ], LIST_SHEET), [
    "   acme-ledger-expert-retire",
    "   soul     acme-ledger-expert",
    "   machine  This machine",
    "   state    running",
    "   harness  claude, claude-opus-5-5 (so…",
    "   work     worktree, agents/acme-ledge…",
    "   team     eng",
    `   started  ${STARTED}`,
    "   home     …s/acme-ledger-expert-retire",
  ]));
  // What the cells say beyond their text: a heading's label is bold and is no row of the selection,
  // and the time of the roster read is dim. The machines are the headings' to name: the open
  // workspace's row says nothing of them.
  for (const [r, label] of [[3, "This machine"], [8, "garnet"]]) {
    for (const cell of d.cells[r].slice(1, 1 + label.length)) assert.equal(cell.style.bold && !cell.style.reverse, true, `${label} is bold`);
    assert.equal(d.cells[r][0].text, " ", "a heading carries no selection mark");
  }
  for (const cell of d.cells[8].slice(24, 37)) assert.equal(cell.style, DIM, "the time of the roster read is dim");
  assert.equal(cellText(d, 0, 0, 38), "  acme-platform");
});

test("this machine and a reached machine at 80x24 in ASCII, cell for cell: the same screen with the rules, the marks and the cut mark in ASCII", () => {
  assert.deepEqual(draw(reached({ ascii: true }), S80).lines, beside(instancesSide(workspaceLine("acme-platform"), [
    " This machine",
    "> * Acme ledger expert retire",
    "    * Acme ledger developer no...",
    "",
    "  - Acme maintainer ops",
    " garnet                 read 10:00:10",
    "  * Acme ledger far a",
    `  - Acme ledger f...  ${cutTo(AWAY(), 11, true)}`,
  ], LIST_SHEET, { ascii: true }), [
    "   acme-ledger-expert-retire",
    "   soul     acme-ledger-expert",
    "   machine  This machine",
    "   state    running",
    "   harness  claude, claude-opus-5-5 (...",
    "   work     worktree, agents/acme-led...",
    "   team     eng",
    `   started  ${STARTED}`,
    "   home     ...acme-ledger-expert-retire",
  ], { bar: "|" }));
});

test("the same view with the machine not reached, at 80x24 in UTF-8 and in ASCII, cell for cell: its heading holds the shared state and short reason and no time, its rows carry the unknown mark and the shared label `<machine> not reached`, and the detail of one says why under `machine`", () => {
  for (const ascii of [false, true]) {
    const state = press(lost({ ascii }), ["G"]).state, garnet = deploymentOf(state), said = deploymentState(garnet), g = glyphsOf(ascii), marks = marksOf(ascii);
    assert.equal(said.key, "remembered", "the machine answered earlier in the run, and is kept in its workspace");
    const cut = (text, cells) => `${text.slice(0, cells - g.cut.length)}${g.cut}`;
    // The selected row's machine was not reached and the kernel does not report it addressable: no
    // Enter, and no act in the palette. A name keeps 16 cells, and the word is cut to what is left.
    assert.deepEqual(draw(state, S80).lines, beside(instancesSide(workspaceLine("acme-platform"), [
      " This machine",
      `  ${marks.running} ${drawnName(KERNEL_EXPERT)}`,
      `    ${marks.running} ${cut(drawnName(KERNEL_DEV), 27)}`,
      "",
      `  ${marks.stopped} Acme maintainer ops`,
      ` garnet  ${said.text}  ${garnet.short}`,
      `  ${marks.unknown} ${cut(drawnName(FAR_A), 16)}  ${cut(NOT_REACHED(), 11)}`,
      `> ${marks.unknown} ${cut(drawnName(FAR_B), 16)}  ${cut(NOT_REACHED(), 11)}`,
    ], [LEAD, ["Ctrl+K", "palette"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]], { ascii }), [
      "   acme-ledger-far-b",
      "   soul     acme-ledger-developer",
      "   machine  garnet",
      ...wrap(textOf(shown(said.detail)), 28).map((row) => `            ${row}`),
      `   state    ${NOT_REACHED()}`,
      "            oats tui's read of other",
      "            machines says: garnet did",
      "            not answer",
      "   harness  claude",
      "   work     worktree",
      `   home     ${g.cut}${`instances/${FAR_B}`.slice(g.cut.length - 1)}`,
    ], { bar: g.bar }));
    assert.deepEqual(paletteActs(state), [], `${ascii ? "ascii" : "utf8"}: no act opens on it`);
  }
  // Nothing of the machine reads as stopped, or as running, that is only not reached.
  const d = draw(lost(), S120);
  assert.equal(NOT_REACHED().includes("garnet"), true, "the label names the machine");
  for (const name of [FAR_A, FAR_B]) {
    const line = cellText(d, rowOf(d, S120, name), 0, 57);
    assert.equal(line.endsWith(NOT_REACHED()) && line.trim().startsWith(MARKS.utf8.unknown), true, `${name}: ${line}`);
  }
  assert.equal(listLines(d, S120).some((line) => line.includes("read 10:00")), false, "a heading that is not live carries no time");
  // The state is plain and the short reason dim: neither is told by the attribute alone.
  const heading = d.cells[8], said = deploymentState(deploymentOf(lost())), at = 1 + "garnet".length + 2;
  assert.equal(cellText(d, 8, at, at + said.text.length), said.text);
  for (const cell of heading.slice(at, at + said.text.length)) assert.equal(cell.style.dim || cell.style.bold, false, "the state is plain");
  for (const cell of heading.slice(at + said.text.length + 2, at + said.text.length + 2 + deploymentOf(lost()).short.length)) assert.equal(cell.style, DIM, "the short reason is dim");
});

test("the view of two deployments at 120x40, 79x24 and 60x15: the same headings and rows, no row wider than the terminal, each time at the right edge of the sidebar and nothing of the list past it", () => {
  for (const ascii of [false, true]) for (const sz of [S120, S79, S60]) {
    const d = draw(reached({ ascii }), sz), pane = paneOf(sz), marks = marksOf(ascii), g = glyphsOf(ascii), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    fits(d, sz, at);
    // The word column ends five cells before the sidebar's edge (four for a waiting mark, one gap) and
    // is as wide as the widest word, the one row's that can't be addressed, cut to 20 cells; a time
    // ends one cell before the edge. The rows the marks say all of have no word.
    const word = pane - 5 - Math.min(20, AWAY().length), time = pane - 1 - "read 10:00:10".length;
    assert.deepEqual(listLines(d, sz), [
      " This machine",
      placed([0, `> ${marks.running} ${drawnName(KERNEL_EXPERT)}`]),
      placed([4, `${marks.running} ${drawnName(KERNEL_DEV)}`]),
      "",
      placed([2, `${marks.stopped} ${drawnName(MAINTAINER)}`]),
      placed([1, "garnet"], [time, "read 10:00:10"]),
      placed([2, `${marks.running} ${drawnName(FAR_A)}`]),
      placed([2, `${marks.stopped} ${drawnName(FAR_B)}`], [word, cutTo(AWAY(), 20, ascii)]),
    ], at);
    assert.equal(cellText(d, 0, 0, pane), workspaceLine("acme-platform"), `${at}: the open workspace's row of the list of workspaces, and no count`);
    assert.equal(d.lines.some((line) => line.includes("read 10:00:00")), false, `${at}: this machine's own read time is not beside the list: the help's top row has it`);
    const rows = listRows(d);
    assert.deepEqual([d.cells[rows[5]][pane - 2].text, d.cells[rows[5]][pane - 1].text], ["0", " "], `${at}: the heading's time ends one cell before the sidebar's edge`);
    if (sz.cols >= WIDE) {
      for (const r of bodyRows(sz)) assert.equal(d.cells[r][pane].text, g.bar, `${at}: row ${r} has the rule column at column ${pane}`);
      assert.equal(cellText(d, 2, pane + 1).trim(), "machine  This machine", `${at}: the detail's machine line`);
    } else assert.equal(d.lines.some((line) => line.includes("soul ")), false, `${at}: no detail beside the list`);
    assert.deepEqual(d.cells[rows[1]].map((cell) => cell.style.reverse), Array.from({ length: sz.cols }, (_, x) => x < pane), `${at}: the selected row's bar is the sidebar`);
    assert.deepEqual(hintsOf(d), sz.rows > 15 ? LIST_SHEET : [LEAD], `${at}: the whole sheet, or at 60x15 the leader alone`);
  }
});

test("the open workspace's row of the list of workspaces is its name alone at every width, whatever machines its view holds: one, two (one of them with two deployments), this machine alone, or none registered", () => {
  for (const sz of SIZES) assert.equal(cellText(draw(lost(), sz), 0, 0, paneOf(sz)), workspaceLine("acme-platform"), `${sz.cols}x${sz.rows}`);
  // Two machines, one with two deployments: still the name alone.
  const two = heard(local(), answered(group(), quartz(), quartz({ id: "quartz:acme-8", target: { workspace: "/srv/acme-two", sshHost: "quartz.example" }, instances: [] })), T1);
  assert.equal(cellText(draw(two, S120), 0, 0, 57), workspaceLine("acme-platform"));
  assert.equal(cellText(draw(local(), S80), 0, 0, 38), workspaceLine("acme-platform"), "this machine alone: nothing about machines");
  assert.equal(cellText(draw(heard(local(), answered(), T1), S80), 0, 0, 38), workspaceLine("acme-platform"), "no registered machine: nothing about machines");
});

test("a heading too narrow for all it holds gives up its path first, then its short reason, then cuts its label, and always keeps its state; a live machine's heading cuts its label and keeps its time", () => {
  const NAME = "garnet-machine-of-the-ledger-team-in-the-far-rack-number-0007";
  const live = (label, options) => heard(local(options), answered(group({ label })), T1);
  /** The one row of the list pane that starts with the machine's label at the margin. */
  const headingOf = (state, sz) => {
    const found = listLines(draw(state, sz), sz).filter((line) => line.startsWith(" garnet"));
    assert.equal(found.length, 1, "one heading names the machine");
    return found[0];
  };
  const garnet = deploymentOf(rowless()), said = deploymentState(garnet), path = garnet.label;
  assert.deepEqual([said.text.length, garnet.short.length, path.length], [10, 9, 13], "the widths the rows below were worked out for");
  // A machine with no row that is not reached: its label, its path, its state, its short reason.
  assert.equal(headingOf(rowless(), S60), ` garnet  ${path}  ${said.text}  ${garnet.short}`, "60 cells hold all four");
  assert.equal(headingOf(rowless(), S80), ` garnet  ${said.text}  ${garnet.short}`, "38 cells: the path is given up");
  assert.equal(headingOf(rowless({}, NAME.slice(0, 20)), S120), ` ${NAME.slice(0, 20)}  …${path.slice(-9)}  ${said.text}  ${garnet.short}`, "57 cells and a longer label: the path is cut first, and keeps its end");
  assert.equal(headingOf(rowless({}, NAME.slice(0, 20)), S80), ` ${NAME.slice(0, 20)}  ${said.text}`, "38 cells and a longer label: the short reason is given up too");
  assert.equal(headingOf(rowless({}, NAME.slice(0, 30)), S80), ` ${NAME.slice(0, 23)}…  ${said.text}`, "a label longer than the row is cut, and the state stands whole");
  assert.equal(headingOf(rowless({}, NAME), S60), ` ${NAME.slice(0, 45)}…  ${said.text}`);
  // A reached machine: its label and the time of the read.
  assert.equal(headingOf(live("garnet"), S80), placed([1, "garnet"], [24, "read 10:00:10"]));
  assert.equal(headingOf(live(NAME.slice(0, 30)), S80), ` ${NAME.slice(0, 20)}…  read 10:00:10`, "the label is cut two cells before the time");
  assert.equal(headingOf(live(NAME), S60), ` ${NAME.slice(0, 42)}…  read 10:00:10`);
  // The order holds at every width and for every label: what is given up later is whole while
  // anything given up earlier is still drawn.
  const shapes = new Set();
  for (const ascii of [false, true]) for (const length of [6, 12, 20, 30, 61]) for (const sz of [S60, S79, S80, S120]) {
    const label = NAME.slice(0, length), pane = paneOf(sz), at = `a label of ${length} at ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    const parts = headingOf(rowless({ ascii }, label), sz).trim().split("  "), state = parts.indexOf(said.text);
    assert.equal(state === 1 || state === 2, true, `${at}: the state stands whole after the label, or after the label and the path: ${parts.join(" | ")}`);
    const whole = parts[0] === label, why = parts.length > state + 1, where = state === 2;
    assert.equal(parts.length, state + (why ? 2 : 1), at);
    if (where) assert.equal(why && parts[state + 1] === garnet.short && whole, true, `${at}: a path is drawn only beside the whole short reason and the whole label`);
    if (why) assert.equal(whole, true, `${at}: a short reason is drawn only beside the whole label`);
    if (!whole) assert.equal(parts[0].endsWith(glyphsOf(ascii).cut) && label.startsWith(parts[0].slice(0, -glyphsOf(ascii).cut.length)), true, `${at}: a cut label ends in the cut mark`);
    shapes.add(`${whole ? "label" : "cut label"}${where ? ", path" : ""}, state${why ? ", short reason" : ""}`);
    assert.equal(textWidth(headingOf(rowless({ ascii }, label), sz)) <= pane - 1, true, `${at}: the heading ends inside its pane`);
    const reached_ = headingOf(live(label, { ascii }), sz);
    assert.equal(reached_.endsWith("  read 10:00:10") && textWidth(reached_) <= pane - 1, true, `${at}: the time stands whole, inside the pane: ${reached_}`);
  }
  assert.deepEqual([...shapes].sort(), ["cut label, state", "label, path, state, short reason", "label, state", "label, state, short reason"], "every step of the order was drawn");
});

test("a deployment's note stands under its heading in a view of several deployments, on wrapped rows that hold nothing else", () => {
  // garnet reported this workspace, and now reports the one quartz is in: the shared home leaves a note.
  const both = heard(local(), answered(group(), quartz({ workspace: ELSEWHERE })), T1);
  const moved = heard(both, answered(group({ workspace: ELSEWHERE }), quartz({ workspace: ELSEWHERE })), T2);
  const state = press(moved, ["w", "w", "j", "enter"]).state;
  assert.equal(state.open, GARNET, "the view of the other workspace is open, on its first machine");
  const note = deploymentOf(state).note;
  assert.equal(typeof note === "string" && note.length > 0, true, "the shared home gives the moved machine a note");
  const line = textOf(shown(note)), away = rowReason(panelRow(state, FAR_B)).label;
  for (const [sz, room] of [[S80, 34], [S60, 56], [S120, 53]]) {
    const d = draw(state, sz), pane = paneOf(sz), word = pane - 5 - Math.min(20, away.length), at = `${sz.cols}x${sz.rows}`;
    const rows = wrap(line, room);
    // The row with a word has its name cut before the word's column; at 80 columns the column does
    // not fit after the name's 16 cells, and the word is cut to the 11 they leave, two cells after.
    const [nameCells, wordAt, wordCells] = sz === S80 ? [16, 4 + 16 + 2, 11] : [word - 2 - 4, word, 20];
    // Both machines were read at the time the help's top row shows: each heading is its name alone.
    assert.deepEqual(listLines(d, sz).slice(0, rows.length + 5), [
      " garnet",
      ...rows.map((row) => `   ${row}`),
      placed([0, `> ● ${drawnName(FAR_A)}`]),
      placed([2, `○ ${cutTo(drawnName(FAR_B), nameCells)}`], [wordAt, cutTo(away, wordCells)]),
      " quartz",
      placed([2, `● ${drawnName(FAR_Q)}`]),
    ], at);
    if (sz === S80) assert.equal(rows.length, 2, "at 80 columns the note wraps");
    // The list of workspaces: acme-platform, then billing, the open one, by its name alone.
    assert.deepEqual([0, 1].map((r) => cellText(d, r, 0, pane)), ["  acme-platform", workspaceLine("billing")], `${at}: ${cellText(d, 0)}`);
    const help = draw(press(state, ["?"], sz).state, sz);
    assert.equal(cellText(help, 0, sz.cols >= WIDE ? help.cols + 2 : 0).startsWith("  read 10:00:25"), true, `${at}: in a view with no deployment of this machine the help's time is the roster read's`);
    for (const r of listRows(d).slice(1, 1 + rows.length)) assert.equal(d.cells[r].slice(0, pane).some((cell) => cell.style.reverse || cell.style.bold), false, `${at}: a note is no heading and no row of the selection`);
  }
  // The movement keys pass over a heading and a note: the selection stands on instances only.
  const walked = [state, ...["j", "j", "j", "k", "k", "k", "g", "G"].map((_, i, keys) => press(state, keys.slice(0, i + 1)).state)].map((s) => String(s.selected).split("/").at(-1));
  assert.deepEqual(walked, [FAR_A, FAR_B, FAR_Q, FAR_Q, FAR_B, FAR_A, FAR_A, FAR_A, FAR_Q]);
});

test("a deployment's note stands under the list of workspaces in a view of one deployment, after the notice when there is one, wrapped to the sidebar on at most two rows, an empty row before the open view's heading", () => {
  // garnet moves to a workspace nothing else is in: a view of its own, with no heading.
  const alone = press(heard(reached(), answered(group({ workspace: ELSEWHERE })), T2), ["w", "w", "j", "enter"]).state;
  assert.equal(alone.open, GARNET);
  const note = textOf(shown(deploymentOf(alone).note));
  // The list of workspaces has two rows, acme-platform and billing (the open one, `on garnet`).
  const top = 2;
  for (const ascii of [false, true]) for (const sz of SIZES) {
    const d = draw({ ...alone, ascii }, sz), pane = paneOf(sz), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`, rows = wrap(note, pane - 2);
    assert.deepEqual([0, 1].map((r) => cellText(d, r, 0, pane)), ["  acme-platform", workspaceLine("billing")], `${at}: the list of workspaces`);
    assert.equal(rows.length <= 2, true, `${at}: the note fits its two rows`);
    assert.deepEqual(rows.map((_, i) => cellText(d, top + i, 0, pane)), rows.map((row) => ` ${row}`), `${at}: the note under the list of workspaces, on rows of its own, from the margin`);
    assert.deepEqual([cellText(d, top + rows.length, 0, pane), openRow(d)], ["", top + 1 + rows.length], `${at}: an empty row, then the heading`);
    assert.equal(cellText(d, listRows(d)[0], 0, pane).startsWith(`> ${marksOf(ascii).running} ${drawnName(FAR_A)}`), true, `${at}: then the list, with no heading: ${d.lines[listRows(d)[0]]}`);
    assert.equal(listRows(d).some((r) => d.cells[r].slice(0, pane).some((cell) => cell.style.bold)), false, `${at}: and no heading anywhere in it`);
    assert.equal(d.page, sz.rows - 6 - top - rows.length, `${at}: the list of workspaces' two rows and the note take their rows from the list's`);
    fits(d, sz, at);
  }
  // Not reached in its new view: the state, its reason, then the note, then the heading.
  const failing = heard(alone, { thrown: "spawn oats ENOENT" }, T3), said = deploymentState(deploymentOf(failing));
  assert.equal(said.key, "remembered");
  for (const sz of SIZES) {
    const d = draw(failing, sz), pane = paneOf(sz), reason = reasonRows(d, textOf(shown(said.detail)), "…", top + 1), at = `not reached, ${sz.cols}x${sz.rows}`;
    assert.equal(cellText(d, top, 0, pane).trim(), said.text, `${at}: the state, under the list of workspaces`);
    assert.equal(reason.whole && reason.rows[0] === top + 1, true, `${at}: its reason on the rows under it`);
    assert.equal(cellText(d, reason.rows.at(-1) + 1, 0, pane), ` ${wrap(note, pane - 2)[0]}`, `${at}: the note after the notice`);
    assert.equal(openRow(d) > reason.rows.at(-1) + 1, true, `${at}: and the heading after the note`);
    const kept = cellText(d, listRows(d)[0], 0, pane);
    assert.match(kept, /^[> ] \? /, `${at}: the kept rows follow, unknown`);
    // At 80 columns the name keeps its 16 cells and the label is cut to the 11 they leave.
    const label = rowReason(panelRow(failing, FAR_A)).label, word = sz === S80 ? cutTo(label, 11) : label;
    assert.equal(kept.slice(4).startsWith(drawnName(FAR_A).slice(0, 6)) && kept.endsWith(word), true, `${at}: with the shared label of a machine not reached: ${kept}`);
  }
  // This machine's own deployment has one too: a standalone deployment's teams are its own.
  const standalone = stateOf(reporting(NEAR(), { identity: STANDALONE }), { cli: REMOTE_CLI }), own = textOf(shown(primaryDeployment(panelOf(standalone, AT).deployments).note));
  assert.equal(own.length > 0, true, "the shared home gives a standalone deployment a note");
  for (const sz of SIZES) {
    const d = draw(standalone, sz), pane = paneOf(sz);
    assert.equal(cellText(d, 1, 0, pane), ` ${wrap(own, pane - 2)[0]}`, `${sz.cols}x${sz.rows}`);
    assert.equal(cellText(d, listRows(d)[0], 0, pane).includes(drawnName(KERNEL_EXPERT).slice(0, 12)), true, `${sz.cols}x${sz.rows}: the list follows`);
  }
  // A note longer than two rows is cut at the second, with the mark.
  const wordy = "garnet in the far rack of the ledger team behind the second door on the third floor of the old building by the river";
  const long = press(heard(heard(local(), answered(group({ label: wordy })), T1), answered(group({ label: wordy, workspace: ELSEWHERE })), T2), ["w", "w", "j", "enter"]).state;
  const whole = textOf(shown(deploymentOf(long).note)), d = draw(long, S60), first = wrap(whole, 58)[0];
  assert.equal(wrap(whole, 58).length > 2, true, "the note needs more than two rows of 58 cells");
  assert.equal(d.lines[top], ` ${first}`, "under the list of workspaces' two rows");
  assert.equal(d.lines[top + 1].endsWith("…") && whole.slice(first.length + 1).startsWith(d.lines[top + 1].trim().slice(0, -1).trimEnd()), true, `the second row is the next piece, cut: ${d.lines[top + 1]}`);
  assert.deepEqual([d.lines[top + 2], openRow(d)], ["", top + 3], "then the empty row and the heading");
});

test("a deployment that is not live and has no row is listed after the sections: a heading with its path, its state and its short reason, and its reason on rows of its own", () => {
  const garnet = deploymentOf(rowless()), said = deploymentState(garnet);
  assert.equal(said.key !== "live" && said.detail.length > 0, true);
  assert.equal(panelOf(rowless(), AT).instances.some((row) => row.deployment.id === GARNET), false, "the machine has no row");
  for (const ascii of [false, true]) for (const [sz, room] of [[S80, 34], [S60, 56], [S79, 75], [S120, 53]]) {
    const state = rowless({ ascii }), d = draw(state, sz), pane = paneOf(sz), marks = marksOf(ascii), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    const lines = listLines(d, sz), heading = lines.findIndex((line) => line.startsWith(" garnet"));
    const last = lines.findLastIndex((line) => line.includes(drawnName(MAINTAINER)));
    assert.equal(heading, last + 1, `${at}: after every row of the sections`);
    assert.equal(lines[heading].includes(`  ${said.text}`), true, `${at}: the heading holds the state: ${lines[heading]}`);
    const rows = wrap(textOf(shown(said.detail)), room);
    assert.deepEqual(lines.slice(heading + 1, heading + 1 + rows.length), rows.map((row) => `   ${row}`), `${at}: the reason, whole, on the rows under it, and nothing of the TUI's with it`);
    assert.deepEqual(lines.slice(heading + 1 + rows.length).filter((line) => line.trim()), [], `${at}: and nothing after`);
    assert.equal(lines[0], " This machine", `${at}: this machine keeps its heading`);
    // It is no row: the selection never stands on it.
    const end = press(press(state, ["G"], sz).state, ["j", "pagedown"], sz).state;
    assert.equal(String(end.selected).endsWith(`/${MAINTAINER}`), true, `${at}: the last row is this machine's`);
    const after = draw(end, sz);
    assert.deepEqual(bodyRows(sz).filter((r) => after.cells[r][0].text === ">").map((r) => cellText(after, r, 0, pane).includes(drawnName(MAINTAINER))), [true], at);
    assert.equal(cellText(after, listRows(after)[heading], 0, pane).includes(marks.unknown), false, at);
    fits(d, sz, at);
  }
  // The path is dim, the state plain, the short reason dim, the label bold.
  const d = draw(rowless(), S60), r = listRows(d)[listLines(d, S60).findIndex((line) => line.startsWith(" garnet"))];
  const look = (word) => { const x = cellIndexOf(d.cells[r], word); assert.equal(x > 0, true, word); return d.cells[r][x].style; };
  assert.deepEqual([look("garnet").bold, look(garnet.label), look(said.text).dim, look(garnet.short)], [true, DIM, false, DIM]);
  // A machine that answers with no row is live: it has no section and is not listed.
  const empty = heard(local(), answered(group({ instances: [] })), T1);
  assert.equal(listLines(draw(empty, S80), S80).some((line) => line.includes("garnet")), false);
  assert.equal(cellText(draw(empty, S80), 0, 0, 38), workspaceLine("acme-platform"), "the open workspace's row is its name alone");
});

test("the roster read's own failure, while no answer has arrived, stands after the list: the TUI's line, and the failure on the rows after it", () => {
  assert.equal(ROSTER_FAILED, "Other machines were not read.");
  const outcomes = {
    "a read that threw": { thrown: "spawn oats ENOENT" },
    "an answer that is an error": { envelope: { ok: false, error: { code: "E_REGISTRY", message: "the registry of machines could not be read" } } },
  };
  for (const [kind, outcome] of Object.entries(outcomes)) for (const ascii of [false, true]) for (const [sz, room] of [[S80, 34], [S60, 56], [S79, 75], [S120, 53]]) {
    const state = heard(local({ ascii }), outcome, T1), failure = state.remote.rosterFailure, d = draw(state, sz), pane = paneOf(sz), at = `${kind}, ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    assert.equal(typeof failure === "string" && failure.length > 0, true, `${at}: the shared rule keeps the failure's sentence`);
    const lines = listLines(d, sz), own = lines.indexOf(`   ${ROSTER_FAILED}`), rows = wrap(textOf(shown(failure)), room);
    assert.equal(own > 0 && lines[own - 1] === "" && lines[own - 2].includes(drawnName(MAINTAINER)), true, `${at}: after the list, an empty row apart`);
    assert.deepEqual(lines.slice(own + 1, own + 1 + rows.length), rows.map((row) => `   ${row}`), `${at}: the failure through shown(), on rows of its own`);
    assert.deepEqual(lines.slice(own + 1 + rows.length).filter((line) => line.trim()), [], at);
    for (const cell of d.cells[listRows(d)[own]].slice(3, 3 + ROSTER_FAILED.length)) assert.equal(cell.style, DIM, `${at}: the TUI's own line is dim`);
    assert.equal(d.cells[listRows(d)[own + 1]].slice(0, pane).some((cell) => cell.style.dim), false, `${at}: the failure is not`);
    assert.equal(lines.some((line) => line.startsWith(" This machine")) || cellText(d, 0, 0, pane).includes("machine"), false, `${at}: no heading and no count: there is no machine to show`);
    fits(d, sz, at);
  }
  // It is no row either: the last row is the last instance.
  const state = heard(local(), { thrown: "spawn oats ENOENT" }, T1);
  assert.equal(String(press(state, ["G", "j"]).state.selected).endsWith(`/${MAINTAINER}`), true);
  // With no instance to list, or none read yet, the two rows follow the line that says so, an empty row apart.
  for (const [entry_, why] of [[reporting([]), `${EMPTY_TEXT.none}: n spawns one`], [null, EMPTY_TEXT.reading]]) {
    const none = heard(stateOf(entry_, { cli: REMOTE_CLI }), { thrown: "spawn oats ENOENT" }, T1);
    assert.deepEqual(listLines(draw(none, S60), S60), [`   ${why}`, "", `   ${ROSTER_FAILED}`, `   ${textOf(shown(none.remote.rosterFailure))}`], why);
  }
  // Once an answer has arrived a failed read is the machines' to say: the line is gone.
  for (const later of [heard(reached(), { thrown: "spawn oats ENOENT" }, T2), lost(), heard(heard(local(), { thrown: "spawn oats ENOENT" }, T1), answered(group()), T2)]) {
    assert.equal(later.remote.rosterFailure, null);
    assert.equal(draw(later, S120).lines.some((line) => line.includes(ROSTER_FAILED)), false);
  }
});

// ── The detail of a machine's row ────────────────────────────────────────────────────────────────

test("in a view of several deployments the detail says which machine the instance is on, under its soul, and a view of one deployment says it only when it is another machine's", () => {
  const state = reached();
  assert.deepEqual(labels(detailOf(selecting(state, FAR_A))), ["soul", "machine", "state", "harness", "work", "home"]);
  assert.deepEqual(fact(detailOf(selecting(state, FAR_A)), "machine").rows, ["garnet"]);
  assert.deepEqual(fact(detailOf(selecting(state, KERNEL_DEV)), "machine").rows, ["This machine"]);
  assert.deepEqual(labels(detailOf(selecting(state, KERNEL_DEV))), ["soul", "machine", "state", "harness", "work", "team", "parent", "started", "home"]);
  assert.equal(fact(detailOf(local()), "machine"), null, "this machine alone");
  const alone = press(heard(reached(), answered(group({ workspace: ELSEWHERE })), T2), ["w", "w", "j", "enter"]).state;
  assert.equal(draw(selecting(alone, FAR_A), S160).lines.some((line) => line.includes("   machine  garnet")), true, "a machine alone in its view: the detail names it, as nothing else does");
  // At 79 columns the detail is a page: the line is there too.
  const page = draw(press(selecting(state, FAR_A, S79), ["tab"], S79).state, S79);
  assert.equal(page.lines[2], "   machine  garnet");
});

test("the detail of a row whose deployment is not live says why under `machine`, in the shared sentence wrapped on rows of its own: the heading has room for the short reason only", () => {
  const outcomes = { "an answer that is an error": TIMEOUT, "a read that threw": { thrown: "spawn oats ENOENT" } };
  for (const [kind, outcome] of Object.entries(outcomes)) {
    const state = heard(reached(), outcome, T2), said = deploymentState(deploymentOf(state));
    assert.equal(said.key !== "live" && said.detail.length > 0, true, kind);
    for (const name of [FAR_A, FAR_B]) for (const sz of [S160, S120, S80]) {
      const rows = fact(detailOf(selecting(state, name, sz), sz), "machine").rows;
      assert.equal(rows[0], "garnet", `${kind}, ${name}`);
      assert.equal(rows.slice(1).join(" "), textOf(shown(said.detail)), `${kind}, ${name} at ${sz.cols}: the shared sentence, whole, through shown()`);
      if (sz === S80) assert.equal(rows.length > 2, true, "at 80 columns it wraps");
    }
    // This machine's rows, in the same view, say nothing of it: their deployment is live.
    assert.deepEqual(fact(detailOf(selecting(state, KERNEL_DEV)), "machine").rows, ["This machine"], kind);
  }
  // The same sentence at 79 columns, where the detail is a page.
  const state = lost(), page = draw(press(selecting(state, FAR_A, S79), ["tab"], S79).state, S79), said = deploymentState(deploymentOf(state));
  assert.deepEqual(page.lines.slice(2, 4), ["   machine  garnet", ...wrap(textOf(shown(said.detail)), 66).map((row) => `            ${row}`)].slice(0, 2));
});

test("the reason of a row that cannot be addressed on a machine that was not reached is drawn once, under its state after the words that say who gave it, with no `held` line; on a reached machine the `held` line holds the shared sentence", () => {
  // Both failures are the read's own, so both texts are given by the read of other machines: the
  // envelope of a read that did not answer in time is written by the shared read, never printed
  // by the installed CLI, and what a read threw is the client's by its nature.
  const outcomes = { "an answer that is an error": TIMEOUT, "a read that threw": { thrown: "spawn oats ENOENT" } };
  for (const [kind, outcome] of Object.entries(outcomes)) for (const sz of [S160, S80]) {
    const state = selecting(heard(reached(), outcome, T2), FAR_B, sz), row = panelRow(state, FAR_B), acts = instanceActs(row), at = `${kind} at ${sz.cols}`;
    assert.equal(row.addressable === false && acts.blocked !== null && acts.blocked.sentence === row.runtimeError, true, `${at}: the shared home blocks the row with the very text it carries as its runtimeError`);
    const d = draw(state, sz), detail = factsOf(detailLines(d, sz)), said = `oats tui's read of other machines says: ${textOf(shown(row.runtimeError))}`;
    assert.equal(originLead(row.runtimeErrorOrigin, TERMS), "oats tui's read of other machines says:", `${at}: the words are the shared home's for the row`);
    assert.equal(fact(detail, "held"), null, `${at}: no held line`);
    assert.deepEqual([fact(detail, "state").rows[0], fact(detail, "state").rows.slice(1).join(" ")], [rowReason(row).label, said], `${at}: the state is the shared label of its reason, and the reason stands under it, after who gave it, with no quotation mark`);
    const whole = detailLines(d, sz).map((line) => line.trim()).filter(Boolean).join(" ");
    assert.equal(whole.split(said).length - 1, 1, `${at}: once`);
    assert.deepEqual(labels(detail), ["soul", "machine", "state", "harness", "work", "home"], at);
    // A row of the same machine that can be addressed has the same line and nothing held either.
    const other = factsOf(detailLines(draw(selecting(state, FAR_A, sz), sz), sz));
    assert.equal(fact(other, "held") === null && fact(other, "state").rows.slice(1).join(" ") === said, true, `${at}: ${FAR_A}`);
  }
  // Reached: the kernel does not report the row addressable, and the shared sentence says so.
  for (const sz of [S160, S80]) {
    const state = selecting(reached(), FAR_B, sz), acts = instanceActs(panelRow(state, FAR_B)), detail = factsOf(detailLines(draw(state, sz), sz));
    assert.equal(acts.blocked !== null && typeof acts.blocked.sentence === "string", true);
    assert.equal(fact(detail, "held").rows.join(" "), textOf(shown(acts.blocked.sentence)), `${sz.cols}: the held line is the shared sentence`);
    assert.deepEqual(fact(detail, "state").rows, [AWAY()], `${sz.cols}: and the state is the shared label of its reason, with no text under it`);
    assert.equal(fact(factsOf(detailLines(draw(selecting(reached(), FAR_A, sz), sz), sz)), "held"), null, `${sz.cols}: a row that can be addressed is not held`);
  }
});

// ── Who gave a row's text ────────────────────────────────────────────────────────────────────────
// A row's own text stands under `state` after the words that say who gave it. Each row here is made
// on the path that decides its speaker, as lib/read.mjs runs it: this machine's by a read cycle
// (`readCycle`), a machine's by the shared roster read over a fake `exec`. No test sets a row's mark:
// where a row has none it was made by hand, and the test's title says so.

/** One roster read as lib/read.mjs makes it: the shared cliRemoteRoster over an `exec`, and its
 *  outcome as the loop hands it to the shared rule: what the read answered, or the message of what
 *  it threw. */
const rosterRead = (exec) => cliRemoteRoster(CLI.bin, { exec }).then((envelope) => ({ envelope }), (error) => ({ thrown: String(error?.message ?? error) }));
/** An installed CLI that prints a roster of `groups`, and a read that fails with `message` before a
 *  child answers. */
const printing = (...groups) => (bin, argv, options, callback) => { callback(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { groups } }), ""); };
const failing = (message) => () => { throw new Error(message); };
/** A row whose text is `text`, by who gives it. `lead`: the speaker's words as the shared home writes
 *  them, written out because this is where they are pinned; `name`: the row; `make`: a state that
 *  holds the row, selected.
 *    the kernel                  it answered `running: null` with the text, and such a row is not probed
 *    the terminal check          the kernel said running, and the collector's probe failed with the text
 *    the read of other machines  a machine reached once, then a roster read that failed with the text:
 *                                the shared rule keeps the machine's rows, and their text is its
 *                                sentence for a failed read, which ends in what was thrown
 *    nobody                      a row made by hand: helpers.mjs `observed` hands the panel an answer
 *                                that holds the text and no speaker, which no read does */
const SPEAKERS = {
  "the kernel": { lead: "OATS says:", name: KERNEL_DEV, make: (text, options) => stateOf(readCycle([instanceRow("acme-ledger-developer", KERNEL_DEV, { running: null, runtimeState: "unreachable", runtimeError: text })]), options) },
  "the terminal check": { lead: "oats tui's terminal check says:", name: KERNEL_DEV, make: (text, options) => stateOf(readCycle([instanceRow("acme-ledger-developer", KERNEL_DEV)], { collect: collector(() => ({ running: null, runtimeState: "unreachable", runtimeError: text })) }), options) },
  "the read of other machines": { lead: "oats tui's read of other machines says:", name: FAR_A, make: async (text, options) => selecting(heard(heard(local(options), await rosterRead(printing(group())), T1), await rosterRead(failing(text)), T2), FAR_A) },
  "nobody, on a row made by hand": { lead: null, name: KERNEL_DEV, make: (text, options) => stateOf(observed([instanceRow("acme-ledger-developer", KERNEL_DEV, { running: null, runtimeState: "unreachable", runtimeError: text })]), options) },
};
/** The four messages of the reason tests above, by what each tries. The display filter withholds
 *  the two that hold an ESC whole, and shows the two others with the character replaced. */
const HOSTILE_TEXTS = {
  "an erase sequence": "wipe \x1b[2J the screen",
  "a bidi override": "safe\u202Etxt.exe was read",
  "a C1 control, the 8-bit CSI": "red \u009B31m alert \u009B2J",
  "an OSC that sets the title": "\x1b]0;owned\x07 and a tail",
};
const WITHHELD_WHOLE = new Set(["an erase sequence", "an OSC that sets the title"]);

test("the four hostile messages as a row's runtimeError, given by each of the three speakers and by nobody (a row made by hand), in the detail at 80x24 and at 60x15, in UTF-8 and in ASCII: a message the filter shows stands after its speaker's words, one it withholds is the withheld word once with no speaker and no quotation mark, and none leaves a control character in a text or a cell, a sequence that is not the TUI's own or a row wider than the terminal", async () => {
  for (const [speaker, { lead, name, make }] of Object.entries(SPEAKERS)) for (const [tries, text] of Object.entries(HOSTILE_TEXTS)) for (const ascii of [false, true]) for (const sz of [S80, S60]) {
    const made = await make(text, { ascii }), state = sz.cols < WIDE ? press(made, ["tab"], sz).state : made, row = panelRow(state, name);
    const at = `${speaker}, ${tries}, at ${sz.cols}x${sz.rows}${ascii ? ", not UTF-8" : ""}`;
    // The row is the shared home's: its text ends in the message, and its mark, which no line here
    // wrote, names the speaker.
    assert.equal(row.runtimeError.endsWith(text), true, `${at}: the row's text holds the message`);
    assert.equal(originLead(row.runtimeErrorOrigin, TERMS), lead, `${at}: the shared home says who gave it`);
    const d = draw(state, sz, { utf8: !ascii }), detail = factsOf(detailLines(d, sz)), under = fact(detail, "state").rows.slice(1), line = displayLine(row.runtimeError);
    assert.equal(line === DETAIL_WITHHELD, WITHHELD_WHOLE.has(tries), `${at}: what the display filter makes of the text`);
    if (line === DETAIL_WITHHELD) {
      assert.deepEqual(under, ["[withheld]"], `${at}: under the state, the TUI's withheld word alone`);
      assert.equal(d.lines.join("\n").split("[withheld]").length - 1, 1, `${at}: once on the screen`);
      // Every lead ends in `says:`, one word, which no wrap breaks: no part of one is on the screen.
      for (const drawn of d.lines) assert.equal(drawn.includes("says:") || drawn.includes("\""), false, `${at}: no speaker introduces a withheld text and no quotation mark stands around it: ${drawn}`);
    } else {
      // With a speaker: its words, then the display line. With none, and no reason of the row
      // that vouches for the text: the display line in quotation marks, which names nobody.
      const said = lead === null ? `"${line}"` : `${lead} ${line}`;
      assert.equal(under.join(" "), ascii ? said.replace(/[^\x20-\x7e]/g, "?") : said, `${at}: under the state`);
      if (lead === null) for (const drawn of d.lines) assert.equal(drawn.includes("says:"), false, `${at}: nobody is named: ${drawn}`);
    }
    assert.equal(labels(detail)[labels(detail).indexOf("state") + 1], "harness", `${at}: and no held line repeats it`);
    // Whatever was shown: the bytes the real screen writes, every text of the frame, every cell.
    const out = readTerminalOutput(createScreen({ utf8: !ascii, ascii }).render(d.rows, sz, { full: true }));
    assert.deepEqual(out.foreign, [], `${at}: every ESC written begins a sequence of the TUI's own`);
    assert.deepEqual([...new Set(out.sequences.map((s) => s.kind))].filter((kind) => !["erase", "position", "sgr", "sync"].includes(kind)), [], `${at}: a frame writes positions, erases and styles in one synchronized update, and nothing else`);
    assert.doesNotMatch(out.text, CONTROL, `${at}: no control character is written`);
    if (ascii) assert.match(out.text, PRINTABLE_ASCII, `${at}: with a locale that is not UTF-8, nothing outside printable ASCII`);
    for (const spans of d.rows) for (const span of spans) if (Object.hasOwn(span, "text")) assert.doesNotMatch(textOf(span.text), CONTROL, `${at}: no text of the frame holds a control character`);
    d.cells.forEach((cells, r) => cells.forEach((cell, x) => assert.doesNotMatch(cell.text, CONTROL, `${at}: row ${r}, column ${x}`)));
    assert.equal(d.lines.some((drawn) => drawn.includes("owned")), false, `${at}: nothing of a withheld text is shown`);
    fits(d, sz, at);
  }
});

/** A text a kernel could give, long enough to take the six rows a wrapped value may. */
const TOLD = "tmux did not answer on /tmp/tmux-1000/default within 5 seconds; the session may still be live, so its state is left unknown";

test("the detail at 80x24 of a row whose kernel gave a text that wraps, in UTF-8 and in ASCII, cell for cell: `OATS says:` starts the fact under `state`, the rows after it stand under the value like any wrapped fact, no quotation mark stands around it, and the six rows are the same in both", () => {
  assert.equal(TOLD.length >= 120 && TOLD.length <= 200, true);
  const told = (options) => selecting(stateOf(readCycle(ROSTER().map((row) => (row.instance === EXPERT_TUI ? { ...row, runtimeError: TOLD } : row)), { withheld: WITHHELD }), options), EXPERT_TUI);
  const said = [
    "            OATS says: tmux did not",
    "            answer on",
    "            /tmp/tmux-1000/default",
    "            within 5 seconds; the",
    "            session may still be live,",
    "            so its state is left unknown",
  ];
  // Its state is not known: Enter does not open it, and the sheet has no Enter; its acts, stop and
  // retire, are the palette's.
  const hints = [LEAD, ["Ctrl+K", "palette"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]];
  assert.deepEqual(paletteActs(told()), ["stop", "retire"]);
  assert.deepEqual(draw(told(), S80).lines, beside(instancesSide(workspaceLine("acme-platform", 38, { waiting: true }), [
    "  ● Acme console expert tui read",
    "    ! Acme console developer pan…",
    "    ! Acme console developer ter…",
    "",
    "> ? Acme expert tui  state unkno…",
    "",
    "  ● Acme ledger expert retire",
    "    ! Acme ledger developer note…",
    "      ○ Peer reviewer note",
    "",
    "  ● Acme maintainer ops",
  ], hints), [
    "   acme-expert-tui",
    "   soul     acme-expert",
    "   state    unreachable",
    ...said,
    "   harness  claude, claude-opus-5-5 (so…",
    "   work     worktree, agents/acme-exper…",
    "   team     eng",
    `   started  ${STARTED}`,
    "   home     …t/instances/acme-expert-tui",
  ]));
  assert.deepEqual(draw(told({ ascii: true }), S80).lines, beside(instancesSide(workspaceLine("acme-platform", 38, { waiting: true, ascii: true }), [
    "  * Acme console expert tui read",
    "    ! Acme console developer p...",
    "    ! Acme console developer t...",
    "",
    "> ? Acme expert tui  state unk...",
    "",
    "  * Acme ledger expert retire",
    "    ! Acme ledger developer no...",
    "      - Peer reviewer note",
    "",
    "  * Acme maintainer ops",
  ], hints, { ascii: true }), [
    "   acme-expert-tui",
    "   soul     acme-expert",
    "   state    unreachable",
    ...said,
    "   harness  claude, claude-opus-5-5 (...",
    "   work     worktree, agents/acme-exp...",
    "   team     eng",
    `   started  ${STARTED}`,
    "   home     ...instances/acme-expert-tui",
  ], { bar: "|" }));
});

test("with `--ascii` and a locale that is not UTF-8 the words that say who gave a text are drawn as without: each of the three is ASCII whole, so the same cells hold the same characters and the screen writes the same bytes", async () => {
  for (const [speaker, { lead, name, make }] of Object.entries(SPEAKERS)) {
    if (lead === null) continue;
    assert.match(lead, PRINTABLE_ASCII, `${speaker}: every character of the words is ASCII, the apostrophe too`);
    const drawn = [];
    for (const ascii of [false, true]) {
      const state = await make("tmux: no server", { ascii }), d = draw(state, S160, { utf8: !ascii }), at = `${speaker}${ascii ? ", not UTF-8" : ""}`;
      const said = `${lead} ${textOf(shown(panelRow(state, name).runtimeError))}`;
      assert.deepEqual(fact(factsOf(detailLines(d, S160)), "state").rows.slice(1), [said], `${at}: the words and the text, on one row at this width`);
      assert.equal(readTerminalOutput(createScreen({ utf8: !ascii, ascii }).render(d.rows, S160, { full: true })).text.includes(said), true, `${at}: and so they are written`);
      const r = bodyRows(S160).find((i) => cellText(d, i, listWidth(S160.cols) + 1).trim() === said);
      drawn.push(d.cells[r].slice(listWidth(S160.cols) + 1).map((cell) => cell.text));
    }
    assert.deepEqual(drawn[1], drawn[0], `${speaker}: cell for cell the same row`);
  }
});

// ── The switcher ─────────────────────────────────────────────────────────────────────────────────
// From 80 columns the switcher stands in the main area (from the column two after the sidebar's
// rule, up to one cell before the edge) with the sidebar beside it; under 80 it has the whole
// screen, and its first row carries its keys at the right.

/** The sidebar while the switcher is shown: `workspaces` in the workspace's place, no view open. */
const switcherSide = (hints, { cols = 38, ascii = false } = {}) => [" workspaces", "", viewLine("Instances", "1", cols), viewLine("Souls", "2", cols), viewLine("Capabilities", "3", cols), ruleLine(cols, ascii), ...sheet(hints)];
/** The cheat sheet of the switcher with a workspace open to go back to. */
const SWITCHER_SHEET = Object.freeze([LEAD, ["Ctrl+K", "palette"], ["Enter", "open"], ["/", "filter"], ["r", "refresh"], ["Esc", "close"], ["?", "help"], ["q", "quit"]]);
/** The same with a row of this computer's list of deployments selected: its Remove before help and quit. */
const REMOVE_SHEET = Object.freeze([...SWITCHER_SHEET.slice(0, -2), ["Delete", "remove"], ...SWITCHER_SHEET.slice(-2)]);
/** A row of the main area for `beside`, its texts at the columns of the area (from 40 at 80 columns). */
const inMain = (...parts) => placed(...parts.map(([col, text]) => [col + 1, text]));
/** The columns the switcher stands from, and its rows' texts from there. */
const mainFrom = (d, sz) => (sz.cols >= WIDE ? d.cols + 2 : 0);
const mainRows = (d, sz) => d.cells.map((_, r) => cellText(d, r, mainFrom(d, sz)));
/** The same without the keys that stand at the right of the first row under 80 columns. */
const ownRows = (d, sz) => mainRows(d, sz).map((line, r) => (r === 0 && sz.cols < WIDE ? line.replace(/ {3,}Enter open\b.*$/, "") : line));

/** The indicator lines of choosing()'s workspace: this machine's deployment, live, and garnet's, not
 *  reached since its first answer, with the shared word for its state. */
const PLATFORM_LINES = Object.freeze(["This machine", "garnet · remembered"]);

test("the list of workspaces holds the switcher's workspaces, in its order, one line each with the name alone: a machine matched to no workspace is a row of the same flat list, with no heading and no state word, and this computer's rows not opened stay in the switcher; the leader then Down opens the machine", () => {
  const listed = press(choosing(), ["escape"]).state;
  const d = draw(listed, S80), side = d.cells.slice(0, 4).map((_, r) => cellText(d, r, 0, 38));
  assert.deepEqual(side, ["  acme-platform", "  quartz", "", " Instances                          1"]);
  assert.deepEqual(switcher(listed, AT).items.filter((item) => item.key !== undefined).map((item) => item.label), ["acme-platform", "quartz", "acme-billing", "acme-docs"], "the switcher still offers this computer's rows");
  // The leader then Down: the machine, opened as the switcher's Enter opens it.
  const moved = draw(leaderThen(listed, "down").state, S80);
  assert.notEqual(moved.cells[0][2].style.reverse, true, "acme-platform is no longer the open one");
  assert.equal(cellText(moved, 1, 0, 38), "  quartz");
  assert.equal(moved.cells[1][2].style.reverse, true, "quartz is");
});

test("the switcher at 80x24 in UTF-8, cell for cell: in the main area beside the sidebar, a workspace on two machines with a dim line under it per deployment (the one not live with its state word), the open mark, the shared heading over a machine matched to no workspace, the TUI's own over the rows of this computer's list not opened, and the selection", () => {
  assert.equal(OPEN_MARK, "*");
  assert.equal(OFFERED_SECTION, "On this machine, not opened");
  const state = press(choosing(), ["j", "j"]).state, [platform, never] = choicesOf(state);
  assert.deepEqual(choicesOf(state).map((row) => [row.label, row.unattached]), [["acme-platform", false], ["quartz", true]]);
  assert.equal(platform.place.includes("garnet") && never.place.length > 0, true, "the shared home words the machines, and why a machine is not matched");
  const d = draw(state, S80);
  // 39 cells: a workspace's name has the row; each of its deployments a dim line two cells in from it.
  assert.deepEqual(d.lines, beside(switcherSide(REMOVE_SHEET), [
    inMain([2, "*"], [4, "acme-platform"]),
    inMain([6, PLATFORM_LINES[0]]),
    inMain([6, PLATFORM_LINES[1]]),
    `   ${UNMATCHED_SECTION}`,
    inMain([4, "quartz"], [26, cutTo(never.place, 12)]),
    "   On this machine, not opened",
    inMain([0, ">"], [4, "acme-billing"], [26, cutTo("~/acme-billing", 12)]),
    inMain([4, "acme-docs"], [26, cutTo("~/acme-docs", 12)]),
  ]));
  // The selection is a bar over the switcher's cells with `>` in its first; no other row has either.
  assert.deepEqual(d.cells.flatMap((line, r) => (line.some((cell) => cell.style.reverse) ? [r] : [])), [6]);
  assert.deepEqual(d.cells[6].map((cell) => cell.style.reverse), Array.from({ length: 80 }, (_, x) => x >= 40 && x < 79), "over the switcher's cells");
  assert.deepEqual(bodyRows(S80).filter((r) => d.cells[r][40].text === ">"), [6]);
  // The two headings, the indicator lines and a place are dim; a workspace's name is not.
  for (const [r, from, to] of [[1, 46, 46 + PLATFORM_LINES[0].length], [2, 46, 46 + PLATFORM_LINES[1].length], [3, 42, 42 + UNMATCHED_SECTION.length], [5, 42, 42 + OFFERED_SECTION.length], [7, 66, 66 + "~/acme-docs".length]]) {
    for (const cell of d.cells[r].slice(from, to)) assert.equal(cell.style, DIM, `row ${r}`);
  }
  for (const cell of d.cells[0].slice(44, 44 + "acme-platform".length)) assert.equal(cell.style.dim, false);
  // While the switcher is shown the title names no workspace, and none of the three views is the
  // open one: none is bold, none in reverse, each plain (each is a view that opens).
  for (const r of [2, 3, 4]) for (const cell of d.cells[r].slice(0, 38)) assert.equal(cell.style.bold || cell.style.reverse, false, `row ${r}: no view is the open one`);
  for (const [r, name] of [[2, "Instances"], [3, "Souls"], [4, "Capabilities"]]) for (const cell of d.cells[r].slice(1, 1 + name.length)) assert.equal(cell.style, PLAIN, `${name} is plain`);
  // Before any key the selection is on the first choice, which is also the open one; its lines are not selected.
  const first = draw(choosing(), S80);
  assert.equal(cellText(first, 0, 39), inMain([0, ">"], [2, "*"], [4, "acme-platform"]));
  assert.equal(first.cells[0].slice(40, 79).every((cell) => cell.style.reverse), true);
  assert.equal(first.cells[1].some((cell) => cell.style.reverse), false);
});

test("the switcher at 80x24 in ASCII, cell for cell: the rules and the rule column in ASCII, and the shared home's words as it gives them", () => {
  const state = press(choosing({ ascii: true }), ["j", "j"]).state, [, never] = choicesOf(state);
  const d = draw(state, S80);
  assert.deepEqual(d.lines, beside(switcherSide(REMOVE_SHEET, { ascii: true }), [
    inMain([2, "*"], [4, "acme-platform"]),
    inMain([6, PLATFORM_LINES[0]]),
    inMain([6, PLATFORM_LINES[1]]),
    `   ${UNMATCHED_SECTION}`,
    inMain([4, "quartz"], [26, cutTo(never.place, 12, true)]),
    "   On this machine, not opened",
    inMain([0, ">"], [4, "acme-billing"], [26, cutTo("~/acme-billing", 12, true)]),
    inMain([4, "acme-docs"], [26, cutTo("~/acme-docs", 12, true)]),
  ], { bar: "|" }));
  // What is on the screen outside printable ASCII is the shared words' own (the ` · ` of an indicator
  // line), and nothing of the TUI's: with `--ascii` on a terminal that reads UTF-8 it is drawn as given,
  // and with a locale that is not UTF-8 the screen replaces each such character.
  const wide = draw(press(choosing({ ascii: true }), ["j", "j"], size(160, 24)).state, size(160, 24)), from = wide.cols + 2 + 6;
  const foreign = (cells) => cells.flatMap((line, r) => line.flatMap((cell, x) => (PRINTABLE_ASCII.test(cell.text) ? [] : [[r, x, cell.text]])));
  assert.deepEqual(foreign(wide.cells), [...PLATFORM_LINES[1]].flatMap((ch, i) => (PRINTABLE_ASCII.test(ch) ? [] : [[2, from + i, ch]])));
  assert.deepEqual(foreign(draw(state, S80, { utf8: false }).cells), []);
});

test("the switcher at 120x40, 79x24 and 60x15: no row wider than the terminal, a workspace's name and its lines in their columns, and where the room is short a row's place is cut before its label is", () => {
  for (const ascii of [false, true]) for (const [sz, place, cells] of [[S120, 26, 60], [S79, 32, 79], [S60, 26, 60]]) {
    const state = press(choosing({ ascii }), ["j", "j"], sz).state, [, never] = choicesOf(state), d = draw(state, sz), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    fits(d, sz, at);
    const from = mainFrom(d, sz);
    assert.deepEqual(ownRows(d, sz).slice(0, 8), [
      placed([2, "*"], [4, "acme-platform"]),
      placed([6, PLATFORM_LINES[0]]),
      placed([6, PLATFORM_LINES[1]]),
      `  ${UNMATCHED_SECTION}`,
      placed([4, "quartz"], [place, cutTo(never.place, cells - 1 - place, ascii)]),
      "  On this machine, not opened",
      placed([0, ">"], [4, "acme-billing"], [place, "~/acme-billing"]),
      placed([4, "acme-docs"], [place, "~/acme-docs"]),
    ], at);
    assert.deepEqual(d.cells[6].map((cell) => cell.style.reverse), Array.from({ length: sz.cols }, (_, x) => x >= from && x < from + cells), `${at}: the selection is the switcher's width`);
    if (sz.cols >= WIDE) assert.deepEqual(hintsOf(d), REMOVE_SHEET, at);
  }
  // A name longer than the labels' column has the row, as a workspace has no place on it: cut at the edge.
  const NAME = "acme-platform-of-the-ledger-team-and-its-friends-and-more-friends";
  const named = (sz) => { const state = heard(heard(stateOf(reporting(NEAR(), { workspace: NAME }), { cli: REMOTE_CLI }), answered(group()), T1), TIMEOUT, T2); const d = draw(press(state, ["w", "w"], sz).state, sz); return mainRows(d, sz)[0]; };
  assert.equal(named(S60), placed([0, ">"], [2, "*"], [4, cutTo(NAME, 55)]));
  assert.equal(named(S80), placed([0, ">"], [2, "*"], [4, cutTo(NAME, 34)]));
  assert.equal(named(S120), placed([0, ">"], [2, "*"], [4, cutTo(NAME, 55)]));
});

test("the switcher with nothing to list says so in the TUI's words, its sentences wrapped to its area, and names the command that opens a deployment whole on one row", () => {
  const { removed, notRemoved, unread, ...words } = SWITCHER_TEXT;
  assert.deepEqual({ ...words, none: [...words.none], states: { ...words.states }, removing: [...words.removing] }, {
    none: ["No workspace to show.", "Start it in a deployment, or name one:", "oats tui --dir <path>"],
    nomatch: "No workspace matches the filter.", gone: "That workspace is no longer listed.", refused: "Not an OATS deployment any more.",
    // A stale row of this computer's list, by the kernel's state, in place of its path.
    states: { missing: "Not found.", "not-a-deployment": "Not an OATS deployment any more.", unreadable: "Can't be read." },
    removing: ["Remove the selected row from this computer's list?", "Enter removes it; other keys keep it. Its folder stays."],
  });
  assert.deepEqual([removed("acme-docs"), notRemoved("acme-docs", "the list is busy"), unread("the list is busy")], [
    "acme-docs was removed from this computer's list.",
    "acme-docs was not removed from this computer's list: the list is busy",
    "This computer's list of deployments could not be read: the list is busy",
  ]);
  const state = stateOf(null, { deployment: null, cli: REMOTE_CLI });
  assert.deepEqual([state.view, state.open], ["switcher", null], "a run started outside every deployment shows the switcher");
  // The rows after the first, by the switcher's width: the second sentence and its command on one
  // row where they fit inside the margins (63 cells), else the command on a row of its own, never
  // cut; a sentence wider than the area is wrapped at its spaces (39 cells at 80 columns).
  const after = {
    80: ["  Start it in a deployment, or name", "  one:", "  oats tui --dir <path>"],
    120: ["  Start it in a deployment, or name one:", "  oats tui --dir <path>"],
    79: ["  Start it in a deployment, or name one: oats tui --dir <path>"], 63: ["  Start it in a deployment, or name one: oats tui --dir <path>"],
    62: ["  Start it in a deployment, or name one:", "  oats tui --dir <path>"], 60: ["  Start it in a deployment, or name one:", "  oats tui --dir <path>"],
  };
  for (const ascii of [false, true]) for (const sz of [...SIZES, size(62, 15), size(63, 15)]) {
    const d = draw({ ...state, ascii }, sz), rows = mainRows(d, sz), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    assert.equal(rows[0].startsWith("  No workspace to show."), true, `${at}: from the first row: ${rows[0]}`);
    assert.deepEqual(rows.slice(1).filter(Boolean), after[sz.cols], at);
    const from = mainFrom(d, sz);
    for (const r of [0, 1]) for (const cell of d.cells[r].slice(from, from + 40).filter((c) => c.text !== " ")) assert.equal(cell.style, DIM, `${at}: dim, as the list's own empty line is`);
    assert.equal(d.cells.some((line) => line.some((cell) => cell.style.reverse)) || bodyRows(sz).some((r) => d.cells[r][from].text === ">"), false, `${at}: nothing is selected`);
    // Esc is not offered: there is no view to go back to.
    if (sz.cols >= WIDE) {
      assert.equal(cellText(d, 0, 0, d.cols), " workspaces", at);
      assert.deepEqual(hintsOf(d), SWITCHER_SHEET.filter(([key]) => key !== "Esc"), at);
    } else assert.equal(cellText(d, 0).endsWith("   Enter open   / filter   r refresh"), true, `${at}: its keys on its first row: ${cellText(d, 0)}`);
    fits(d, sz, at);
  }
});

test("the switcher's filter: `/` opens its field on a row of its own at the top of the switcher, a row stays while its name, its place or (a workspace) its lines hold what was typed, and a filter that matches nothing says so", () => {
  for (const sz of SIZES) {
    const open = press(choosing(), ["/"], sz).state, typed = press(open, ["d", "o", "c", "s"], sz).state, d = draw(typed, sz), at = `${sz.cols}x${sz.rows}`, from = mainFrom(d, sz);
    assert.equal(mainRows(draw(open, sz), sz)[0].startsWith("  /"), true, at);
    assert.equal(mainRows(d, sz)[0].startsWith("  /docs"), true, `${at}: ${mainRows(d, sz)[0]}`);
    assert.deepEqual([d.cells[0][from + 2].text, d.cells[0][from + 2].style.bold], ["/", true], `${at}: \`/\` in bold`);
    if (sz.cols >= WIDE) assert.deepEqual(hintsOf(d), [LEAD, ["Enter", "keep"], ["Esc", "clear"]], at);
    else assert.equal(cellText(d, 0).endsWith("Enter keep   Esc clear"), true, `${at}: the field's keys at the right of its row`);
    const rows = mainRows(d, sz).slice(1).filter(Boolean);
    assert.equal(rows.length === 2 && rows[0] === "  On this machine, not opened" && rows[1].startsWith(">   acme-docs "), true, `${at}: the one row of the list that matches, under its heading, selected: ${rows}`);
    assert.equal(d.lines.some((line) => line.includes("acme-billing") || line.includes("quartz") || line.includes("acme-platf") || line.includes(UNMATCHED_SECTION)), false, `${at}: no other choice, and no heading without one`);
  }
  // Kept, the filter keeps its row, in bold, and the key that clears it is offered before `refresh`.
  const kept = (sz) => press(choosing(), ["/", "d", "o", "c", "s", "enter"], sz).state;
  for (const sz of [S80, S120]) {
    const d = draw(kept(sz), sz), from = mainFrom(d, sz);
    assert.equal(mainRows(d, sz)[0], "  /docs", `${sz.cols}`);
    assert.equal(d.cells[0].slice(from + 3, from + 7).every((cell) => cell.style.bold), true, `${sz.cols}: a kept filter is bold`);
    assert.deepEqual(hintsOf(d), [LEAD, ["Ctrl+K", "palette"], ["Enter", "open"], ["/", "filter"], ["Esc", "close"], ["r", "refresh"], ["Delete", "remove"], ["?", "help"], ["q", "quit"]], `${sz.cols}`);
  }
  assert.equal(cellText(draw(kept(S60), S60), 0).startsWith("  /docs   "), true);
  const cleared = draw(press(kept(S80), ["escape"]).state, S80);
  assert.deepEqual(hintsOf(cleared), SWITCHER_SHEET, "Esc clears a kept filter first: the selection is back on the first choice, a workspace");
  assert.equal(mainRows(cleared, S80)[0].includes("/"), false, "and its row is gone");
  assert.equal(mainRows(cleared, S80).filter((line) => line.includes("acme-")).length, 3, "and every choice is back");
  // A workspace's lines and a row's place are matched too, and upper case and spaces around what was typed do not matter.
  const by = (keys) => mainRows(draw(press(choosing(), ["/", ...keys, "enter"], S120).state, S120), S120).slice(1).filter(Boolean).map((line) => line.trim());
  assert.deepEqual(by(["G", "A", "R", "N", "E", "T"]), ["> * acme-platform", ...PLATFORM_LINES], "a machine's name finds its workspace, with its lines");
  assert.deepEqual(by(["q", "u", "a", "r", "t", "z"]).map((line) => line.split(" ")[0]), ["Not", ">"], "an unmatched machine keeps the shared heading over it");
  // Nothing matches: the TUI's line, no choice, and nothing selected.
  for (const keys of [["/", "z", "z", "z"], ["/", "z", "z", "z", "enter"]]) for (const sz of SIZES) {
    const d = draw(press(choosing(), keys, sz).state, sz), from = mainFrom(d, sz);
    assert.deepEqual(mainRows(d, sz).slice(1).filter(Boolean), ["  No workspace matches the filter."], `${keys.length} keys at ${sz.cols}x${sz.rows}`);
    assert.equal(d.cells.some((line) => line.some((cell) => cell.style.reverse)), false);
    for (const cell of d.cells[1].slice(from).filter((c) => c.text !== " ")) assert.equal(cell.style, DIM);
  }
});

test("the switcher's cheat sheet offers Esc only when a workspace is open to go back to, and `help` and `quit` last", () => {
  const none = reduce(stateOf(null, { deployment: null, cli: REMOTE_CLI }), { listed: LISTED }).state;
  for (const sz of [S80, S120]) {
    assert.deepEqual(hintsOf(draw(choosing(), sz)), SWITCHER_SHEET, `${sz.cols}`);
    assert.deepEqual(hintsOf(draw(none, sz)), REMOVE_SHEET.filter(([key]) => key !== "Esc"), `${sz.cols}: nothing is open: no Esc (a row of the list is selected)`);
  }
  // Under 80 columns its keys stand on its first row, after its heading, as many as fit, given up
  // from the end; with nothing open, no Esc.
  for (const [sz, keys] of [[S79, "Enter open   / filter   r refresh"], [S60, "Enter open   / filter"]]) assert.equal(cellText(draw(none, sz), 0), `  ${OFFERED_SECTION}`.padEnd(sz.cols - 1 - keys.length) + keys, `${sz.cols}`);
  // Esc does what the sheet says: back to the view with a workspace open, nothing without one. The
  // view's list of workspaces holds the rows of this computer's list the switcher read too.
  assert.deepEqual(draw(press(choosing(), ["escape"]).state, S80).lines, draw(reduce(heard(heard(local(), answered(group(), quartz({ probe: UNPROMPTED, workspace: null, instances: [] })), T1), answered(group({ probe: UNPROMPTED }), quartz({ probe: UNPROMPTED, workspace: null, instances: [] })), T2), { listed: LISTED }).state, S80).lines);
  assert.deepEqual(draw(press(none, ["escape"]).state, S80).lines, draw(none, S80).lines);
  // The keys are the effective table's.
  const rebound = effectiveConfig({ keys: { open: ["o"], close: ["backspace"], workspaces: ["f2"] } });
  assert.equal(rebound.ok, true);
  assert.deepEqual(hintsOf(draw(press(reached({ actions: rebound.actions }), ["f2", "f2"]).state, S120)), [LEAD, ["Ctrl+K", "palette"], ["o", "open"], ["/", "filter"], ["r", "refresh"], ["Backspace", "close"], ["?", "help"], ["q", "quit"]], "the close key as tui.json gave it");
  // The list's sheet names the workspaces key, which pressed twice opened the switcher above, as tui.json gave it.
  assert.deepEqual(hintsOf(draw(reached({ actions: rebound.actions }), S120)), [LEAD, ["Ctrl+K", "palette"], ["o", "open"], ["n", "spawn"], ["F2", "workspaces"], ["?", "help"], ["q", "quit"]], "the open and workspaces keys as tui.json gave them");
});

test("the switcher says in a line of its own that the open workspace is no longer listed, and that line hides no choice: 30 rows of the list at 80x15", () => {
  // garnet's own view is open, and the next answer lists no machine: no view holds what was open.
  const alone = press(heard(reached(), answered(group({ workspace: ELSEWHERE })), T2), ["w", "w", "j", "enter"]).state;
  const gone = heard(alone, answered(), T3);
  assert.deepEqual([gone.view, gone.open], ["switcher", null]);
  for (const sz of SIZES) {
    const d = draw(gone, sz), rows = mainRows(d, sz), from = mainFrom(d, sz), at = `${sz.cols}x${sz.rows}`;
    assert.equal(rows[0].startsWith("  That workspace is no longer listed."), true, `${at}: ${rows[0]}`);
    assert.equal(d.cells[0].slice(from, from + 37).some((cell) => cell.style.dim), false, "something that happened: not dim");
    assert.equal(rows[1].startsWith(">   acme-platform"), true, `${at}: the choices follow, the first selected, none marked open: ${rows[1]}`);
    if (sz.cols >= WIDE) assert.deepEqual(hintsOf(d), SWITCHER_SHEET.filter(([key]) => key !== "Esc"), `${at}: nothing is open: no Esc`);
  }
  // More choices than the switcher has rows: the line keeps its row, the screen's last row says
  // what is cut off, and every choice comes on the screen as the selection walks down.
  const names = Array.from({ length: 30 }, (_, i) => `acme-${String(i).padStart(2, "0")}`), sz = size(80, 15);
  let state = reduce(gone, { listed: { rows: names.map((name) => listedRow(name)) } }).state;
  const seen = new Set();
  for (let i = 0; i < 31; i++) {
    const body = mainRows(draw(state, sz), sz), at = `after ${i} down`;
    assert.equal(body[0], "  That workspace is no longer listed.", at);
    const selected = body.filter((line) => line.startsWith(">"));
    assert.equal(selected.length, 1, `${at}: the selected choice is on the screen`);
    assert.equal(selected[0].includes(i === 0 ? "acme-platform" : names[i - 1]), true, `${at}: ${selected[0]}`);
    const cut = /^ {2}(?:(\d+) more above)?(?:, )?(?:(\d+) more below)?$/.exec(body[14]);
    assert.notEqual(cut, null, `${at}: the last row says what is cut off: ${body[14]}`);
    const shown_ = body.slice(1, 14).filter(Boolean);
    assert.equal(shown_.length, 13, `${at}: the thirteen rows between hold choices, the workspace's line and the heading`);
    assert.equal(Number(cut[1] ?? 0) + Number(cut[2] ?? 0) + shown_.length, 33, `${at}: 31 choices, the workspace's one line and one heading, none lost`);
    for (const line of shown_) seen.add(line.trim().replace(/^> +/, "").split(" ")[0]);
    state = press(state, ["j"], sz).state;
  }
  for (const name of ["acme-platform", ...names]) assert.equal(seen.has(name), true, `${name} was on the screen`);
  // Picking a choice, or leaving the line behind with a key that opens something, clears it.
  assert.equal(draw(press(gone, ["enter", "w", "w"]).state, S80).lines.some((line) => line.includes("no longer listed")), false);
});

test("a row that turned out not to be a deployment says so in its row, where its path stood, and a stale row of the list says its state there in the TUI's words, plain, and does not open", () => {
  const rows = [listedRow("acme-billing"), listedRow("acme-docs"), listedRow("acme-gone", "missing"), listedRow("acme-old", "not-a-deployment"), listedRow("acme-locked", "unreadable")];
  const state = reduce(press(reached(), ["w", "w"]).state, { listed: { rows } }).state;
  const refused = reduce(press(state, ["j"]).state, { refused: "/home/u/acme-billing" }).state;
  for (const ascii of [false, true]) for (const [sz, place, cells] of [[S80, 26, 39], [S120, 26, 60], [S79, 32, 79], [S60, 26, 60]]) {
    const d = draw({ ...refused, ascii }, sz), from = mainFrom(d, sz), room = cells - 1 - place, at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    const said = (text) => cutTo(text, room, ascii);
    // Under the workspace and its two lines (this machine, garnet).
    assert.deepEqual(mainRows(d, sz).slice(3, 10), [
      "  On this machine, not opened",
      placed([0, ">"], [4, "acme-billing"], [place, said("Not an OATS deployment any more.")]),
      placed([4, "acme-docs"], [place, said("~/acme-docs")]),
      placed([4, "acme-gone"], [place, said("Not found.")]),
      placed([4, "acme-old"], [place, said("Not an OATS deployment any more.")]),
      placed([4, "acme-locked"], [place, said("Can't be read.")]),
      "",
    ], at);
    assert.equal(d.cells[5][from + place].style, DIM, `${at}: a path is dim`);
    // What the kernel says of a stale row is something to read where its path stood: plain, not dim.
    for (const [r, words] of [[6, "Not found."], [7, "Not an OATS deployment any more."], [8, "Can't be read."]]) {
      for (const cell of d.cells[r].slice(from + place, from + place + Math.min(words.length, room))) assert.equal(cell.style, PLAIN, `${at}: row ${r} is plain`);
    }
    fits(d, sz, at);
  }
  // Not dim where it is not selected either: it is what happened to the pick.
  const moved = draw(press(refused, ["j"]).state, S120), from = mainFrom(moved, S120);
  assert.equal(mainRows(moved, S120)[4], placed([4, "acme-billing"], [26, "Not an OATS deployment any more."]));
  assert.equal(moved.cells[4][from + 26].style.dim || moved.cells[4][from + 26].style.reverse, false);
  // Before the pick, the row that opens has its path.
  assert.equal(mainRows(draw(state, S120), S120)[4], placed([4, "acme-billing"], [26, "~/acme-billing"]));
  // A stale row does not open: Enter on it asks the loop for nothing, and the screen stays as it was.
  for (const down of [3, 4, 5]) {
    const on = press(state, Array.from({ length: down }, () => "j")).state, entered = press(on, ["enter"]);
    assert.equal(mainRows(draw(on, S80), S80)[3 + down].startsWith(">"), true, `${down} down: a stale row is selected`);
    assert.deepEqual(entered.effects, [], `${down} down`);
    assert.deepEqual(draw(entered.state, S80).lines, draw(on, S80).lines, `${down} down`);
  }
});

test("Delete on a row of the list asks over the rows in two sentences of the TUI's own, wrapped to the switcher's width and not dim, with the selected row still drawn under them; Enter removes it, and Esc or any other key keeps it, the switcher still shown", () => {
  assert.deepEqual(SWITCHER_TEXT.removing, ["Remove the selected row from this computer's list?", "Enter removes it; other keys keep it. Its folder stays."]);
  for (const [sz, cells] of [[S80, 39], [S120, 60], [S79, 79], [S60, 60]]) {
    const state = press(choosing(), ["j", "j"], sz).state, asking = press(state, ["delete"], sz).state, at = `${sz.cols}x${sz.rows}`;
    const d = draw(asking, sz), before = draw(state, sz), from = mainFrom(d, sz), rows = ownRows(d, sz);
    const asked = SWITCHER_TEXT.removing.flatMap((sentence) => wrap(sentence, cells - 3)).map((line) => `  ${line}`);
    assert.deepEqual(rows.slice(0, asked.length), asked, at);
    if (sz === S80) assert.equal(asked.length, 4, `${at}: each sentence on two rows in 39 cells`);
    // (Under 80 columns the keys stand dim at the right of the first row: the sentence's cells are checked.)
    for (let r = 0; r < asked.length; r++) for (const cell of d.cells[r].slice(from, from + asked[r].length).filter((c) => c.text !== " ")) assert.equal(cell.style, PLAIN, `${at}: row ${r} is something to read, not dim`);
    // The rows under them are the switcher's, as many rows down, the selected one among them.
    assert.deepEqual(rows.slice(asked.length, asked.length + 6), ownRows(before, sz).slice(0, 6), `${at}: the rows, under the question`);
    const selected = bodyRows(sz).filter((r) => d.cells[r][from].text === ">");
    assert.deepEqual(selected, [asked.length + 6], `${at}: the selected row is drawn`);
    assert.equal(rows[asked.length + 6].includes("acme-billing") && d.cells[asked.length + 6].slice(from, from + cells - 1).every((cell) => cell.style.reverse), true, `${at}: still marked`);
    fits(d, sz, at);
    // Esc keeps the row and closes the question, not the switcher.
    const kept = press(asking, ["escape"], sz);
    assert.deepEqual([kept.state.view, kept.effects], ["switcher", []], at);
    assert.deepEqual(draw(kept.state, sz).lines, before.lines, `${at}: Esc`);
    // Any other key keeps it too, and then does what it does.
    assert.deepEqual(draw(press(asking, ["j"], sz).state, sz).lines, draw(press(state, ["j"], sz).state, sz).lines, `${at}: j`);
    // Enter removes it: the loop is asked to, and the question goes.
    const removed = press(asking, ["enter"], sz);
    assert.deepEqual(removed.effects, [{ remove: { path: "/home/u/acme-billing", name: "acme-billing" } }], at);
    assert.deepEqual(draw(removed.state, sz).lines, before.lines, `${at}: Enter`);
  }
  // Delete on a workspace asks nothing.
  assert.deepEqual(draw(press(choosing(), ["delete"]).state, S80).lines, draw(choosing(), S80).lines);
});

test("what a Remove answered, and a read of the list that failed, stand over the rows: the TUI's sentence with the row's name and the kernel's message as it came, wrapped to the switcher's width and not cut, at most four rows each, not dim", () => {
  const MESSAGE = "the list of deployments is held by another oats process right now; run `oats deployments remove <path>` again once it has finished";
  const HUGE = Array.from({ length: 160 }, (_, i) => `step-${i}`).join(" ");
  const state = press(choosing(), ["j", "j"]).state;
  const answered_ = (ok, message) => reduce(state, { removed: { path: "/home/u/acme-billing", name: "acme-billing", ok, ...(ok ? {} : { reason: { code: "E_DEPLOYMENTS_LOCKED", message } }) } });
  // Each answer asks for the list to be read again.
  assert.deepEqual(answered_(true).effect, { list: true });
  assert.deepEqual(answered_(false, MESSAGE).effect, { list: true });
  const failing = (message) => reduce(state, { listed: { failure: { code: "E_DEPLOYMENTS_LOCKED", message } } }).state;
  for (const [sz, cells] of [[S80, 39], [S120, 60], [S79, 79], [S60, 60]]) {
    const at = `${sz.cols}x${sz.rows}`, width = cells - 3, before = ownRows(draw(state, sz), sz);
    /** The sentence's rows over the rows of the switcher, which follow them as they stood before. */
    const over = (d, sentence, most = 4) => {
      const rows = wrap(sentence, width).map((line) => `  ${line}`), main = ownRows(d, sz), from = mainFrom(d, sz);
      assert.deepEqual(main.slice(0, rows.length), rows, `${at}: ${sentence.slice(0, 30)}`);
      assert.deepEqual(main.slice(rows.length, rows.length + 4), before.slice(0, 4), `${at}: the rows follow`);
      for (let r = 0; r < rows.length; r++) for (const cell of d.cells[r].slice(from, from + rows[r].length).filter((c) => c.text !== " ")) assert.equal(cell.style, PLAIN, `${at}: row ${r} is not dim`);
      assert.equal(rows.length <= most, true, `${at}: at most ${most} rows`);
      fits(d, sz, at);
      return rows.length;
    };
    assert.equal(over(draw(answered_(true).state, sz), "acme-billing was removed from this computer's list."), sz === S80 ? 2 : 1, at);
    // The kernel's message, wrapped and whole where four rows hold it.
    if (cells >= 60) {
      const notRemoved = over(draw(answered_(false, MESSAGE).state, sz), `acme-billing was not removed from this computer's list: ${MESSAGE}`);
      const unread = over(draw(failing(MESSAGE), sz), `This computer's list of deployments could not be read: ${MESSAGE}`);
      if (cells === 60) assert.deepEqual([notRemoved, unread], [4, 4], at);
      if (cells === 79) assert.deepEqual([notRemoved, unread], [3, 3], at);
    }
    // A message longer than four rows hold is cut on the fourth, with the cut mark: the rows of the switcher still follow.
    const cut = ownRows(draw(answered_(false, HUGE).state, sz), sz), rows = wrap(`acme-billing was not removed from this computer's list: ${HUGE}`, width);
    assert.deepEqual(cut.slice(0, 3), rows.slice(0, 3).map((line) => `  ${line}`), at);
    assert.equal(cut[3].endsWith("…") && rows[3].startsWith(cut[3].slice(2, -1).trimEnd()), true, `${at}: ${cut[3]}`);
    assert.deepEqual(cut.slice(4, 8), before.slice(0, 4), `${at}: four rows, then the switcher's`);
    // What a Remove answered first, then the failure, each its own sentence.
    const both = ownRows(draw(reduce(answered_(true).state, { listed: { failure: { code: "E_DEPLOYMENTS_LOCKED", message: "busy" } } }).state, sz), sz);
    const said = [...wrap("acme-billing was removed from this computer's list.", width), ...wrap("This computer's list of deployments could not be read: busy", width)].map((line) => `  ${line}`);
    assert.deepEqual(both.slice(0, said.length), said, at);
  }
  // A read that answered takes the failure away.
  assert.deepEqual(draw(reduce(failing(MESSAGE), { listed: LISTED }).state, S80).lines, draw(state, S80).lines);
  // The sentences, pinned: a name and the kernel's message are put in as they came.
  assert.equal(SWITCHER_TEXT.removed("acme-billing"), "acme-billing was removed from this computer's list.");
  assert.equal(SWITCHER_TEXT.notRemoved("acme-billing", "busy"), "acme-billing was not removed from this computer's list: busy");
  assert.equal(SWITCHER_TEXT.unread("busy"), "This computer's list of deployments could not be read: busy");
});

test("the switcher's cheat sheet names the remove key on a row of this computer's list, after the keys that move about and before help and quit, and never on a workspace", () => {
  const on = (options) => press(choosing(options), ["j", "j"]).state;
  for (const sz of [S80, S120]) {
    assert.deepEqual(hintsOf(draw(on(), sz)), REMOVE_SHEET, `${sz.cols}`);
    // On a workspace it is not named.
    assert.deepEqual(hintsOf(draw(choosing(), sz)), SWITCHER_SHEET, `${sz.cols}: on a workspace`);
  }
  // A stale row is removed as any row of the list is.
  const stale = reduce(on(), { listed: { rows: [listedRow("acme-billing", "missing"), listedRow("acme-docs")] } }).state;
  assert.deepEqual(hintsOf(draw(stale, S80)), REMOVE_SHEET);
  // The key is the effective table's; with none, no hint.
  const rebound = effectiveConfig({ keys: { remove: ["f8"] } }), unbound = effectiveConfig({ keys: { remove: [] } });
  assert.deepEqual([rebound.ok, unbound.ok], [true, true]);
  assert.deepEqual(hintsOf(draw(on({ actions: rebound.actions }), S80)), REMOVE_SHEET.map((hint) => (hint[0] === "Delete" ? ["F8", "remove"] : hint)));
  assert.deepEqual(hintsOf(draw(on({ actions: unbound.actions }), S80)), SWITCHER_SHEET);
});

// ── The help, with machines and the switcher ─────────────────────────────────────────────────────

test("the help says every limit of this version: adding, checking and removing a machine and opening a deployment that is not listed with the oats command that does it, and what no command lifts in sentences of its own", () => {
  for (const ascii of [false, true]) for (const sz of [HELP_SIZE, size(60, 330), size(79, 300), size(200, 230)]) {
    const lines = helpLines(reached({ ascii }), sz), text = lines.map((line) => line.trim()), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    const machines = text.indexOf("Machines"), last = text.indexOf("Not in this version");
    assert.equal(machines > text.indexOf("Views") && last > machines, true, `${at}: Machines stands between Views and what is not in this version`);
    // The sentences, each whole when its rows are joined, in order, and nothing else in the section.
    assert.equal(text.slice(machines + 1, last).filter(Boolean).join(" "), MACHINES.join(" "), at);
    const section = text.slice(last + 1), drawn = lines.slice(last + 1);
    for (const [what, command] of [["add a machine to this workspace", "oats server connect <id> --ssh <alias> --dir <path on that machine>"], ["check a machine", "oats server check <id>"], ["remove a machine", "oats server remove <id>"], ["open a deployment that is not listed", "oats tui --dir <path>"]]) {
      const row = section.findIndex((line) => line === what || line.startsWith(`${what} `));
      assert.equal(row >= 0 && (pair([section[row]], what, command) || commandAt(drawn, row + 1, command)), true, `${at}: ${what}: ${command}`);
    }
    // It no longer says the TUI cannot read another machine.
    assert.equal(text.some((line) => line.includes("oats server roster") || /^other machines\b/.test(line)), false, at);
    assert.equal(text.find((line) => line.startsWith("1 Instances")).includes("on this machine"), false, `${at}: the Instances view is the open workspace's, not this machine's alone`);
  }
  // The three limits no command lifts, as the spec lists them: whose time a machine's rows carry,
  // that nothing is kept on disk, and whose Souls and Capabilities are shown.
  assert.equal(MACHINES.length, 3);
  assert.match(MACHINES[0], /machine's rows are what it reported at the time on its heading/);
  assert.match(MACHINES[0], /in a view of one machine, at the top of this help/);
  // Nothing of the TUI's own: this computer's list of deployments is the kernel's.
  assert.equal(MACHINES[1], "Nothing of its own is kept on disk: a machine not reached in this run is listed by its own name.");
  assert.deepEqual(NOT_YET.at(-1), { what: "open a deployment that is not listed", command: "oats tui --dir <path>" });
  assert.equal(NOT_YET.some((entry_) => entry_.what.includes("~/Agents")), false, "there is no folder of its own to be outside of");
  assert.equal(MACHINES[2], "Souls and Capabilities are this machine's.", "both views are built: no `when they come`");
  assert.equal(NOT_YET.some((entry_) => entry_.command === "oats server roster" || entry_.what === "other machines"), false);
  // The mark of the open workspace is listed with the others.
  for (const ascii of [false, true]) assert.equal(helpLines(reached({ ascii })).some((line) => line.trim().startsWith(`${OPEN_MARK}  `) && line.includes("workspaces")), true);
});

test("the help over the switcher keeps the switcher's sidebar, with the help's own keys in its cheat sheet, and closing it returns to the switcher", () => {
  for (const sz of SIZES) {
    const under = choosing(), helping = press(under, ["?"], sz).state, d = draw(helping, sz), at = `${sz.cols}x${sz.rows}`, from = mainFrom(d, sz);
    if (sz.cols >= WIDE) {
      assert.equal(cellText(d, 0, 0, d.cols), " workspaces", `${at}: no workspace is named`);
      for (const r of [2, 3, 4]) for (const cell of d.cells[r].slice(0, d.cols)) assert.equal(cell.style.bold || cell.style.reverse, false, `${at}: none of the three views is the open one`);
      assert.deepEqual(hintsOf(d), HELP_SHEET, at);
      assert.equal(cellText(d, 0, from), "", `${at}: no time on the help's top row: no deployment is read`);
    } else assert.equal(cellText(d, 0).trim(), "Esc close", `${at}: the help's first row holds its key and no time`);
    assert.equal(cellText(d, 1, from).trim(), FIRST_HEADING, at);
    for (const key of ["escape", "?"]) assert.deepEqual(draw(press(helping, [key], sz).state, sz).lines, draw(under, sz).lines, `${at}: ${key} returns to the switcher`);
    // Over the list the sidebar is the workspace's, and the help is the same help.
    const over = draw(press(reached(), ["?"], sz).state, sz);
    if (sz.cols >= WIDE) {
      assert.equal(cellText(over, 0, 0, over.cols), workspaceLine("acme-platform"), at);
      assert.deepEqual(hintsOf(over), HELP_SHEET, at);
      assert.deepEqual(over.cells[2][1].style, style({ bold: true }), `${at}: over the list, Instances is the open view`);
    }
    assert.deepEqual(over.cells.slice(1).map((_, i) => cellText(over, i + 1, from)), d.cells.slice(1).map((_, i) => cellText(d, i + 1, from)), `${at}: the same help under both`);
  }
  // With nothing open, the help still opens and closes over the switcher.
  const none = stateOf(null, { deployment: null }), helping = press(none, ["?"]).state;
  assert.equal(cellText(draw(helping, S80), 0, 0, 38), " workspaces");
  assert.deepEqual(draw(press(helping, ["escape"]).state, S80).lines, draw(none, S80).lines);
});

// ── The open workspace's row, and other machines ─────────────────────────────────────────────────
// The open workspace's row of the list of workspaces is its name alone, whatever machines its view
// holds: no words after the name say where its deployments are. The workspace's own pages say it,
// and a view whose only deployment is another machine's names it in the detail's `machine` line.
// Whether a deployment is this machine's is the shared entries' `local`; each state here is a
// roster outcome taken by the store, and a view of machines alone is opened from the switcher.
/** The second choice of the switcher, opened with the keys a person has. */
const second = (state) => press(state, ["w", "w", "j", "enter"]).state;
/** garnet alone in another workspace's view, and garnet and quartz together in it. */
const onGarnet = (extra = {}, key = ELSEWHERE.key, options) => second(heard(local(options), answered(group({ workspace: { ...IDENTITY, key }, ...extra })), T1));
const onBoth = (key = ELSEWHERE.key) => second(heard(local(), answered(group({ workspace: { ...IDENTITY, key } }), quartz({ workspace: { ...IDENTITY, key } })), T1));
/** What the model says of a view's machines, as the frame is given it. */
const machinesOf = (state) => { const d = draw(state, S80), m = model(state, { page: d.page, now: NOW, at: AT, cols: d.cols }); return { here: m.here, machines: m.machines, machine: m.machine }; };
const LONG_MACHINE = "garnet-machine-of-the-ledger-team-in-the-far-rack-number-0007", LONG_KEY = "github.com/acme/billing-of-the-ledger-team-and-friends", LONG_WORKSPACE = LONG_KEY.split("/").at(-1);
/** The row of the list of workspaces that is the open workspace's: in reverse video while the list
 *  does not have the focus. */
function openWorkspaceRow(d) {
  const found = d.cells.slice(0, 6).flatMap((line, r) => (line[0].text !== ">" && line[2].text !== " " && line[2].style.reverse ? [r] : []));
  assert.equal(found.length, 1, "one row of the list of workspaces is the open workspace's");
  return found[0];
}
/** The open workspace's row of the list of workspaces, which says what the title said. */
const titleOf = (state, sz) => { const d = draw(state, sz); return cellText(d, openWorkspaceRow(d), 0, d.cols); };

test("the open workspace's row of the list of workspaces is its name alone, whatever machines its view holds: they are the workspace's own pages' to say; a long name is cut with the mark inside the sidebar's margin", () => {
  const one = reached(), two = heard(local(), answered(group(), quartz()), T1);
  assert.deepEqual(machinesOf(one), { here: true, machines: 1, machine: null });
  assert.deepEqual(machinesOf(two), { here: true, machines: 2, machine: null });
  assert.deepEqual(machinesOf(onGarnet()), { here: false, machines: 1, machine: "garnet" });
  assert.deepEqual(machinesOf(onBoth()), { here: false, machines: 2, machine: null });
  for (const sz of [S60, S80, S120]) {
    for (const state of [one, two, local()]) assert.equal(titleOf(state, sz), workspaceLine("acme-platform"), `${sz.cols}`);
    for (const state of [onGarnet(), onBoth(), heard(onGarnet(), TIMEOUT, T2)]) assert.equal(titleOf(state, sz), workspaceLine("billing"), `${sz.cols}`);
  }
  for (const cell of draw(two, S80).cells[0].slice(0, 38)) assert.equal(cell.style.reverse, true, "the open workspace's bar, across the row");
  const named = heard(stateOf(reporting(NEAR(), { workspace: "acme-platform-of-the-ledger-team-and-friends" }), { cli: REMOTE_CLI }), answered(group()), T1);
  assert.equal(titleOf(named, S80), workspaceLine("acme-platform-of-the-ledger-team-a\u2026"));
  assert.equal(titleOf(named, S60), workspaceLine("acme-platform-of-the-ledger-team-and-friends"));
  for (const sz of [S60, S80, S120]) for (const state of [named, onBoth(LONG_KEY), onGarnet({ label: LONG_MACHINE }, LONG_KEY)]) {
    assert.equal(textWidth(titleOf(state, sz)) <= paneOf(sz) - 1, true, `${sz.cols}: inside the sidebar's margin: ${titleOf(state, sz)}`);
  }
});

test("a view whose only deployment is a machine that is not live and has no row kept is drawn as an unavailable deployment is: its state, its reason on rows of its own, and an empty list with no line about instances", () => {
  const state = heard(onGarnet({ instances: [] }), TIMEOUT, T2), said = deploymentState(deploymentOf(state));
  assert.equal(state.open, GARNET);
  assert.equal(said.key !== "live" && panelOf(state, AT).instances.length === 0, true);
  for (const ascii of [false, true]) for (const sz of SIZES) {
    const d = draw({ ...state, ascii }, sz), g = glyphsOf(ascii), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    // The list of workspaces has two rows, acme-platform and billing, the open one; the state under them.
    const reason = reasonRows(d, textOf(shown(said.detail)), g.cut, 3);
    assert.deepEqual([0, 1].map((r) => cellText(d, r, 0, d.cols)), ["  acme-platform", workspaceLine("billing")], `${at}: the open workspace's row is its name`);
    assert.equal(cellText(d, 2, 0, d.cols).trim(), said.text, `${at}: the state in the shared home's word`);
    assert.equal(reason.whole && reason.rows[0] === 3, true, `${at}: its reason, whole, on the rows under it`);
    assert.deepEqual(listLines(d), [], `${at}: and the list holds nothing: no line that says no instance is listed`);
    assert.equal(d.lines.some((line) => line.includes(EMPTY_TEXT.none)), false, at);
    if (sz.cols >= WIDE) assert.deepEqual(detailLines(d, sz).filter(Boolean), [], `${at}: and nothing beside it`);
    fits(d, sz, at);
  }
  // Reached with no row it is a deployment that was read: the list says it holds no instance.
  const live = draw(onGarnet({ instances: [] }), S80);
  assert.deepEqual(listLines(live, S80).filter(Boolean), [`   ${EMPTY_TEXT.none}: n spawns one`]);
  const help = draw(press(onGarnet({ instances: [] }), ["?"]).state, S80);
  assert.equal(cellText(help, 0, help.cols + 2), "  read 10:00:10", "the help's top row has the time of the read");
  // And with rows kept, the notice stands over the last rows it reported.
  const kept = draw(heard(onGarnet(), TIMEOUT, T2), S80);
  assert.equal(kept.lines.some((line) => line.includes(FAR_A)), true);
});

// ── The cheat sheet while Enter would open an agent's terminal ──────────────────────────────────────

const openable = (options) => stateOf(observed([instanceRow("dev", "dev-alpha"), instanceRow("dev", "dev-beta", { running: false, runtimeState: "stopped" })]), options);

test("the cheat sheet names Enter open whenever Enter would open, whatever the kernel, and is the same at every width: the leader, the palette, what Enter does, `n spawn`, help and quit, as many as its rows hold; under 80 columns the detail's focus has the whole screen and no sheet", () => {
  const state = openable(), stopped = press(state, ["j"]).state, detailed = press(state, ["tab"]).state, kept = press(state, ["/", "d", "enter"]).state;
  // The fixture's kernel has no session-start: the acts its rows offer are stop and retire, and
  // they are the palette's, not the sheet's. A kept filter adds nothing: the key that clears it is
  // the help's. No hint names the views.
  const P = ["Ctrl+K", "palette"], OPEN = ["Enter", "open"], END = [["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]];
  const cases = {
    "the list": [state, LIST_SHEET],
    "the detail": [detailed, DETAIL_SHEET],
    "a row Enter does not open": [stopped, [LEAD, P, ...END]],
    "a kept filter": [kept, [LEAD, P, OPEN, ...END]],
  };
  for (const [what, [s]] of Object.entries(cases)) assert.deepEqual(paletteActs(s), ["stop", "retire"], `${what}: the acts open as before`);
  for (const [what, [s, hints]] of Object.entries(cases)) for (const cols of [60, 65, 79, 80, 92, 104, 120, 151]) {
    // Under 80 columns the detail's focus has the whole screen, with no cheat sheet.
    if (what === "the detail" && cols < WIDE) { for (const rows of [40, 15]) assert.equal(detailPage(draw(s, size(cols, rows))), true, `${what} at ${cols}x${rows}`); continue; }
    assert.deepEqual(hintsOf(draw(s, size(cols, 40))), hints, `${what} at ${cols}x40`);
    const short = hintsOf(draw(s, size(cols, 15)));
    assert.deepEqual(short, hints.slice(0, short.length), `${what} at ${cols}x15: the first of them`);
  }
  // The hint's key is the effective table's; the leader is tui.json's open.detachKey and stands
  // first, by its own key (here F12), not beside open.
  const config = effectiveConfig({ keys: { open: ["o"] }, open: { detachKey: "F12" } });
  assert.deepEqual(hintsOf(draw(openable({ actions: config.actions, detachKey: config.detachKey }), S120)).slice(0, 3), [["F12", "commands"], P, ["o", "open"]]);
  assert.deepEqual(hintsOf(draw(openable({ actions: effectiveConfig({ keys: { open: [] } }).actions }), S120)), LIST_SHEET.filter(([key]) => key !== "Enter"), "an open with no key has no hint");
});

test("no hint of the cheat sheet names the views, whatever keys tui.json gives them: the accordion's rows carry their keys, rebound or unbound, and the sheet is the same", () => {
  const drawn = (keys) => draw(openable({ actions: effectiveConfig({ keys }).actions }), S120);
  for (const [keys, given] of [[{}, ["1", "2", "3"]], [{ capabilities: ["f3"] }, ["1", "2", "F3"]], [{ instances: [] }, [null, "2", "3"]], [{ instances: [], souls: [], capabilities: [] }, [null, null, null]]]) {
    const d = drawn(keys), at = JSON.stringify(keys);
    assert.deepEqual(hintsOf(d), LIST_SHEET, at);
    assert.doesNotMatch(sheetOf(d).join(" "), /views|Instances|Souls|Capabilities|\b[123]\b|F3/, at);
    const rows = d.cells.map((_, r) => cellText(d, r, 0, d.cols)).filter((line, r) => r > 0 && VIEW_ROWS.some(([name]) => line.startsWith(` ${name}`)));
    assert.deepEqual(rows, VIEW_ROWS.map(([name], i) => (given[i] ? viewLine(name, given[i], d.cols) : ` ${name}`)), `${at}: the accordion names the views with their keys`);
  }
});

test("while another machine is asked first the cheat sheet says Esc gives the open up, where the open hint stood, and Esc is not listed twice", () => {
  const preflight = Object.freeze({ ...openable(), opening: Object.freeze({ id: "x", phase: "preflight", name: "dev-alpha", machine: "garnet", routed: true }) });
  const all = [LEAD, ["Ctrl+K", "palette"], ["Esc", "stop opening"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]];
  assert.deepEqual(hintsOf(draw(preflight, S120)), all);
  assert.deepEqual(hintsOf(draw(preflight, S80)), all.slice(0, hintsOf(draw(preflight, S80)).length));
  assert.deepEqual(hintsOf(draw(preflight, S60)), all.slice(0, 6), "at 60x15 the six rows under the two instances hold all but its last");
  const filtered = hintsOf(draw(Object.freeze({ ...preflight, filter: Object.freeze({ editing: false, query: "d" }) }), S120));
  assert.deepEqual(filtered.filter(([key]) => key === "Esc"), [["Esc", "stop opening"]], "Esc once, and not as close");
});

test("the help lists Enter once per view with what it does there, the keys of the open terminal and the digits of the views, under the agent's line the leader then Esc, the leader twice, what the terminal takes and where the keys are listed, the leader's own section with every key of its table and the leader again, then the palette's keys", () => {
  const lines = helpLines(openable()).map((line) => line.trim());
  const text = lines.join(" ").replace(/ +/g, " ");
  assert.equal(text.includes("Enter open the selected agent's terminal as a tab beside the list, or show its tab when it has one, in the list of instances Ctrl+\\ Esc takes the focus from the terminal back to the list; the agent keeps running. Ctrl+\\ Ctrl+\\ types the leader into the terminal. While the terminal has the focus every key but its scroll keys goes to the agent, Ctrl+C and Ctrl+Z too. Up to 4 terminals, as tabs, no mouse. Shift+PageUp or Ctrl+B [ (tmux 3.3+) scrolls back; PageUp, PageDown move, q leaves. docs/tui.md has the keys that can be the leader."), true, text);
  assert.equal(text.includes("z go to the shown terminal with the whole screen; the leader then Esc brings the list back"), true);
  assert.equal(text.includes("c close the shown terminal and show its neighbour; the agent keeps running"), true);
  assert.equal(pair(lines, "Enter", "open the selected workspace, in the switcher"), true);
  assert.equal(pair(lines, "Enter", "show the selected soul's detail, and from the detail its instances, in the Souls view"), true);
  assert.equal(text.includes("Enter show the selected capability's detail, and from the detail the marked soul that uses it, in the Capabilities view"), true, text);
  // The keys' table names Enter once per view (the instances, the switcher, the Souls view and the
  // Capabilities view); the spawn prompt's section has its own Enter, once per step.
  const keys = lines.slice(0, lines.indexOf("The leader"));
  assert.equal(keys.filter((line) => line.startsWith("Enter ")).length, 4, "Enter four times, once per view");
  for (const [key, label] of [["1", "instances"], ["2", "souls"], ["3", "capabilities"]]) assert.equal(pair(lines, key, label), true, key);
  assert.equal(lines.some((line) => line.includes("open an agent in its own tmux window") && line.includes("oats session attach --home <home>")), true);
  // The leader's section, after the keys and before the marks (the chords' where there are chords,
  // the palette's and the spawn prompt's sections stand between it and them): the leader, then each
  // key of its table (actions.mjs LEADER) and what it does, from every focus, and last the leader
  // again. The chords' section leads the help where there are chords (the Alt family is read
  // without the kitty keyboard protocol), so the palette's follows it.
  const leader = lines.slice(lines.indexOf("The leader") + 1, nextHeading(lines, lines.indexOf("The leader"))).filter(Boolean);
  assert.equal(lines[nextHeading(lines, lines.indexOf("The leader"))], "The palette", "the palette's section after the leader's");
  assert.equal(lines.indexOf("Chords") >= 0 && lines.indexOf("Chords") < lines.indexOf("Keys"), true, "the chords first");
  assert.equal(lines.indexOf("The leader") > lines.indexOf("Keys") && lines.indexOf("The leader") < lines.indexOf("Marks"), true, "between the keys and the marks");
  assert.deepEqual(leader.map((line) => line.replace(/ {2,}/g, "  ")), [
    "Ctrl+\\ then one of these keys, from every focus; a terminal too:",
    "k, Space  palette", "1  instances", "2  souls", "3  capabilities", "Up  previous workspace", "Down  next workspace",
    "z  zoom, while a terminal is open", "b  hide or show the list", "w  close terminal, while a terminal is open",
    "Left  previous tab, while a terminal is open", "Right  next tab, while a terminal is open",
    "|, h  split right, while a terminal is open", "-, v  split down, while a terminal is open", "Tab  next group, while a terminal is open",
    "Shift+Tab  previous group, while a terminal is open", "m  move tab, while a terminal is open", "x  close group, while a terminal is open",
    "X  stop", "R  restart", "S  start", "D  retire", "n  spawn", "N  spawn another", "/  filter", "o  workspaces", "?  help",
    "Esc  the list",
    `Ctrl+\\  ${LEADER_AGAIN}`,
  ]);
  // The palette's section, between the leader's and the spawn prompt's: its keys are its own, and
  // after Up and Down its group keys (macOS has none: views.test's macOS help test).
  const palette = lines.slice(lines.indexOf("The palette") + 1, lines.indexOf("The spawn prompt")).filter(Boolean);
  const said = PALETTE_KEYS.map(([keys_, words_]) => `${keys_}  ${words_}`);
  said.splice(1, 0, `Alt+Shift+Up, Alt+Shift+Down  ${PALETTE_GROUP_WORDS}`);
  assert.deepEqual(palette.map((line) => line.replace(/ {2,}/g, "  ")), said);
  // The leader is tui.json's, text from outside: the help names it, then Esc and twice under the agent's line.
  const rebound = helpLines(openable({ detachKey: "F12" })).map((line) => line.trim());
  assert.equal(rebound.join(" ").replace(/ +/g, " ").includes("F12 Esc takes the focus from the terminal back to the list; the agent keeps running. F12 F12 types the leader into the terminal."), true);
  assert.equal(rebound.includes("F12 then one of these keys, from every focus; a terminal too:"), true);
});

test("a tui.json that unbinds open, or close, is drawn with a kept filter: the hint that has no key is not there, and nothing else moves (round 1 of the review)", () => {
  const noOpen = effectiveConfig({ keys: { open: [] } }).actions, noClose = effectiveConfig({ keys: { close: [] } }).actions;
  for (const sz of [S60, S80, S120]) {
    const kept = press(openable({ actions: noOpen }), ["/", "d", "enter"], sz).state;
    assert.equal(kept.filter.query, "d");
    const d = draw(kept, sz), hints = hintsOf(d);
    assert.equal(cellText(d, openRow(d), 0, d.cols).startsWith(" Instances  /d "), true, `${sz.cols}: the kept filter on the heading`);
    assert.deepEqual(hints[0], LEAD, `${sz.cols}`);
    assert.equal(hints.some(([, word]) => word === "open"), false, `${sz.cols}: no open hint without a key`);
    // While another machine is asked first, Esc's hint stands first; with no key for close there is none.
    const preflight = Object.freeze({ ...openable({ actions: noClose }), filter: Object.freeze({ editing: false, query: "d" }), opening: Object.freeze({ id: "x", phase: "preflight", name: "dev-alpha", machine: "garnet", routed: true }) });
    assert.equal(hintsOf(draw(preflight, sz)).some(([, word]) => word === "stop opening"), false, `${sz.cols}: no Esc hint without a key`);
  }
  assert.deepEqual(hintsOf(draw(press(openable({ actions: noOpen }), ["/", "d", "enter"]).state, size(80, 40))).slice(-2), [["?", "help"], ["q", "quit"]]);
});

// ── The terminal panel (T1) ───────────────────────────────────────────────────────────────────────

/** Two running agents, dev-a selected, and a key pressed as the loop hands it on. */
const PANEL_STATE = (options = {}) => { const s = stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-b")]), options); return Object.freeze({ ...s, selected: roster(s).rows.find(({ row }) => row.instance === "dev-a").id }); };
const keyed = (state, id) => reduce(state, { key: id, ...(id.length === 1 ? { text: id } : {}), page: 19, extent: 0, room: 19, cols: 38 }).state;
/** dev-a's terminal, open: "focus" (it has the focus), "list" (the leader, then Esc), "zoom" (z
 *  from the list), "detail" (Tab from the list); with `detachKey` as tui.json's, and keys.json's
 *  `keysRead` (none: the default family). */
function panelIn(how, { detachKey, status = "open", keysRead } = {}) {
  let s = keyed(PANEL_STATE(keysRead ? { keysRead } : {}), "enter");
  if (status === "open") s = reduce(s, { shown: { id: s.terminal.id } }).state;
  if (detachKey !== undefined) s = Object.freeze({ ...s, detachKey });
  if (how === "focus") return s;
  s = leaderEscape(s).state;
  return how === "zoom" ? keyed(s, "z") : how === "detail" ? keyed(s, "tab") : s;
}
/** The agent's screen as the panel hands it on: its first row a prompt, its second red text and a
 *  run longer than any panel; the cursor after the prompt. */
const AGENT = (cols, rows, visible = true) => ({ lines: captureRows(`$ hello\n\u001b[31mred\u001b[0m and ${"x".repeat(300)}`, { cols, rows }), cursor: { x: 2, y: 0, visible } });
/** Draw with the agent's screen at the size the frame gives the terminal (as the loop resizes it). */
function drawPanel(state, sz) {
  const t = draw(state, sz).terminal;
  return draw(state, sz, { screen: t ? AGENT(t.cols, t.rows) : null });
}
const PANEL_WIDE = [size(80, 24), size(100, 30), S120, size(200, 50)];
/** The cheat sheet of the list while a terminal is open: what Enter does on the row whose terminal
 *  is open, then the list's `n spawn`. The terminal's keys (zoom, close, the tabs) are the leader's,
 *  the palette's and the help's. */
const TERMINAL_SHEET = Object.freeze([LEAD, ["Ctrl+K", "palette"], ["Enter", "focus terminal"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]]);

test("Enter: the terminal stands beside the sidebar, where the detail was, edge to edge to the right and over every row; its top row names the agent, and its screen is placed from the row under it, the agent's colours kept and clipped to the panel", () => {
  for (const sz of PANEL_WIDE) {
    const d = drawPanel(panelIn("focus"), sz), t = d.terminal, at = `${sz.cols}x${sz.rows}`;
    assert.equal(t.col, d.cols + 1, `${at}: after the sidebar and its rule`);
    assert.equal(t.cols, sz.cols - d.cols - 1, `${at}: to the right edge`);
    assert.deepEqual([t.title, t.top, t.whole], [0, 1, false], at);
    assert.equal(t.rows, sz.rows - 1, `${at}: every row of the screen but the title`);
    // The list stays on screen, both rows of it.
    for (const name of ["dev-a", "dev-b"]) assert.equal(listLines(d).some((line) => line.includes(drawnName(name))), true, `${at}: ${name} in the list`);
    assert.equal(d.lines[0].slice(t.col).trim(), "[dev-a 1]", `${at}: the tab bar names the agent, its one tab the shown one, numbered 1`);
    assert.equal(d.cells[0][t.col + 1].style.bold && d.cells[0][t.col + 1].style.reverse, true, `${at}: the title of a focused terminal is drawn focused`);
    assert.equal(d.lines[1].slice(t.col), "$ hello", at);
    assert.equal(d.lines[2].slice(t.col, t.col + 7), "red and", at);
    assert.notEqual(d.cells[2][t.col].style.fg, null, `${at}: the agent's red`);
    assert.equal(d.cells[2][t.col + 4].style.fg, null, `${at}: the agent's reset`);
    assert.equal(d.lines[2].length, sz.cols, `${at}: the long run is clipped at the right edge`);
    assert.equal(d.lines[2].slice(t.col + 8), "x".repeat(t.cols - 8), at);
  }
});

test("in the Ctrl+Alt family, while the terminal has the focus the cheat sheet names the leader, the leader then Esc back to the list and the leader twice, which types it, then (without the kitty keyboard protocol, except on macOS) the Alt+Shift arrows that come; over the whole screen the terminal's title row carries the leader's keys at its right, and no chord, dim: each size, starting or open, zoomed or not, the default key and a rebound one (QA note 2); in the Alt family the chords lead both", () => {
  for (const sz of [S60, S79, S80, S120, size(200, 50)]) for (const detachKey of [undefined, "F12", "M-x", "C-]"]) for (const [how, status] of [["focus", "starting"], ["focus", "open"], ["zoom", "open"]]) {
    const d = drawPanel(panelIn(how, { detachKey, status, keysRead: CTRL_ALT_READ }), sz), key = detachKey === undefined ? LEADER_KEY : backKeyLabel(detachKey), at = `${sz.cols}x${sz.rows} ${how} ${status} ${detachKey}`;
    if (sz.cols < WIDE || how === "zoom") {
      // The viewer's scroll key after the leader's, where the row holds it; given up first where it does not.
      const leader = `${key} commands   ${key} Esc the list`, both = `${leader}   ${SCROLL_HINT.join(" ")}`;
      const keys = "[dev-a 1]".length + 3 + both.length <= sz.cols - 1 ? both : leader, row = cellText(d, 0);
      assert.equal(row.startsWith("[dev-a 1] ") && row.endsWith(keys), true, `${at}: ${row}`);
      assert.equal(d.cells[0].slice(sz.cols - 1 - keys.length, sz.cols - 1).every((cell) => cell.text === " " || cell.style.dim), true, `${at}: dim, a cell before the edge`);
      assert.equal(d.cells[0][sz.cols - 1].text, " ", `${at}: the last cell left empty`);
    } else assert.deepEqual(hintsOf(d), [[key, "commands"], [`${key} Esc`, "the list"], [`${key} ${key}`, `types ${key}`], SCROLL_HINT, ...ARROWS], at);
  }
  // The default family: the chords lead, in the rows and in a title row.
  assert.deepEqual(hintsOf(drawPanel(panelIn("focus"), S120)), FOCUS_SHEET, "the Alt family, 120x40");
  const title = cellText(drawPanel(panelIn("zoom"), S80), 0);
  assert.match(title, /^\[dev-a 1\] +Alt\+K palette   Alt\+Shift\+Up\/Down agent   Ctrl\+\\ commands$/, `a title row: the chords first, the leader last: ${title}`);
});

test("with the list focused and a terminal open, the cheat sheet names, after the leader and the palette, Enter to go to it on its row and Enter to open another on another row, and no key of the terminal's", () => {
  assert.deepEqual(hintsOf(drawPanel(panelIn("list"), S120)), TERMINAL_SHEET);
  assert.deepEqual(hintsOf(drawPanel(panelIn("list"), S80)), TERMINAL_SHEET, "at 80x24 every hint has its row under the two instances");
  // On another row, Enter opens that one (and closes this).
  const other = Object.freeze({ ...panelIn("list"), selected: roster(PANEL_STATE()).rows.find(({ row }) => row.instance === "dev-b").id });
  assert.deepEqual(hintsOf(drawPanel(other, S120)).slice(2), [["Enter", "open"], ["n", "spawn"], ["w", "workspaces"], ["?", "help"], ["q", "quit"]]);
  // The terminal goes on being drawn beside the list, its title no longer focused.
  const d = drawPanel(panelIn("list"), S120), t = d.terminal;
  assert.equal(d.lines[1].slice(t.col), "$ hello");
  assert.equal(d.cells[0][t.col + 1].style.reverse, false);
  assert.equal(d.cells[0][t.col + 1].style.bold, true);
});

test("zoom gives the terminal the whole screen: its title row on the first, the agent's screen under it over every other row and column, and no sidebar; the leader then Esc brings the list back with the panel", () => {
  for (const sz of PANEL_WIDE) {
    const d = drawPanel(panelIn("zoom"), sz), t = d.terminal, at = `${sz.cols}x${sz.rows}`;
    assert.deepEqual([t.col, t.cols, t.title, t.top, t.rows, t.whole], [0, sz.cols, 0, 1, sz.rows - 1, true], at);
    assert.equal(d.lines.some((line) => line.includes("Dev b") || line.includes("acme-platform")), false, `${at}: no sidebar`);
    assert.equal(d.cells.some((line) => line.some((cell) => cell.text === "│")), false, `${at}: no rule column`);
    assert.equal(d.lines[0].startsWith("[dev-a 1] "), true, at);
    assert.equal(d.lines[1], "$ hello", `${at}: the agent's screen from column 0`);
    assert.equal(d.lines[2].length, sz.cols, `${at}: to the last column`);
    const back = drawPanel(leaderEscape(panelIn("zoom")).state, sz);
    assert.equal(back.terminal.whole, false, at);
    assert.equal(back.terminal.col, back.cols + 1, at);
  }
});

test("under 80 columns the terminal is shown over the whole screen whenever it has the focus, and with the list focused the list is shown alone: the terminal lives on unseen, and the cheat sheet names Enter to see it again", () => {
  for (const sz of [S60, S79, size(70, 30)]) {
    const at = `${sz.cols}x${sz.rows}`;
    for (const how of ["focus", "zoom"]) {
      const t = drawPanel(panelIn(how), sz).terminal;
      assert.deepEqual([t.col, t.cols, t.top, t.rows, t.whole], [0, sz.cols, 1, sz.rows - 1, true], `${at} ${how}`);
    }
    const listed = drawPanel(panelIn("list"), sz);
    assert.equal(listed.terminal, null, at);
    assert.equal(listed.cursor, null, at);
    const hints = hintsOf(listed);
    assert.deepEqual(hints, TERMINAL_SHEET.slice(0, hints.length), at);
    assert.equal(hints.some(([key, word]) => key === "Enter" && word === "focus terminal"), true, at);
    assert.equal(listed.lines.some((line) => line.includes("$ hello")), false, at);
  }
});

test("beside the list the panel is never narrower than PANEL_MIN (40): at 80 columns and wider the list leaves it at least 41, and narrower terminals show it over the whole screen", () => {
  assert.equal(PANEL_MIN, 40);
  for (let cols = WIDE; cols <= 240; cols++) {
    const t = drawPanel(panelIn("focus"), size(cols, 24)).terminal;
    assert.equal(t.whole, false, `${cols}`);
    assert.equal(t.cols >= PANEL_MIN + 1, true, `${cols}: ${t.cols}`);
  }
  assert.equal(drawPanel(panelIn("focus"), size(WIDE - 1, 24)).terminal.whole, true);
});

test("with a terminal open, in the sidebar's 30 columns, a waiting row's state mark is the needs-input mark, reversed, and its name is cut as on a row that does not wait, with nothing at its edge; the open, selected row's mark is not reversed", () => {
  const LONG = "dev-z-with-a-name-far-longer-than-the-list";
  for (const ascii of [false, true]) {
    const rows = [instanceRow("dev", "dev-a", { waitingOnYou: { ...QUESTION } }), instanceRow("dev", "dev-b", { waitingOnYou: { ...QUESTION } }), instanceRow("dev", LONG, { waitingOnYou: { ...QUESTION } }), instanceRow("dev", "dev-c")];
    const all = stateOf(observed(rows), { ascii });
    let s = keyed(Object.freeze({ ...all, selected: roster(all).rows.find(({ row }) => row.instance === "dev-a").id }), "enter");
    s = leaderEscape(reduce(s, { shown: { id: s.terminal.id } }).state).state;
    for (const sz of PANEL_WIDE) {
      const d = drawPanel(s, sz), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`, row = (name) => listRows(d).find((r) => cellText(d, r, 0, LIST_BESIDE).includes(drawnName(name).slice(0, 12)));
      assert.equal(d.cols, LIST_BESIDE, at);
      const cut = glyphsOf(ascii).cut;
      assert.deepEqual([waitMarkAt(d, row("dev-a")), tagAt(d, row("dev-a"), LIST_BESIDE)], [{ col: 2, style: TAG_SELECTED }, null], `${at}: the open row, selected`);
      assert.equal(cellText(d, row("dev-b"), 0, LIST_BESIDE), "  ! Dev b", at);
      assert.deepEqual([waitMarkAt(d, row("dev-b")), tagAt(d, row("dev-b"), LIST_BESIDE)], [{ col: 2, style: TAG }, null], at);
      assert.equal(cellText(d, row(LONG), 0, LIST_BESIDE), `  ! ${drawnName(LONG).slice(0, LIST_BESIDE - 4 - 5 - cut.length)}${cut}`, `${at}: the name cut inside the cells a row keeps, as on a row that does not wait`);
      assert.deepEqual([waitMarkAt(d, row(LONG)), tagAt(d, row(LONG), LIST_BESIDE)], [{ col: 2, style: TAG }, null], at);
      assert.equal(cellText(d, row("dev-c"), 0, LIST_BESIDE), `  ${marksOf(ascii).running} Dev c`, `${at}: a row that does not wait has its state mark`);
      assert.deepEqual([waitMarkAt(d, row("dev-c")), tagAt(d, row("dev-c"), LIST_BESIDE)], [null, null], `${at}: and no needs-input mark`);
    }
  }
});

test("with a terminal open the sidebar keeps 30 columns at most, beside the terminal or the detail in its place, and a name longer than its row is cut there with the cut mark; closed, the sidebar has its width again", () => {
  assert.equal(LIST_BESIDE, 30);
  for (const sz of PANEL_WIDE) for (const how of ["focus", "list", "detail"]) {
    const d = drawPanel(panelIn(how), sz), at = `${sz.cols}x${sz.rows} ${how}`;
    assert.equal(d.cols, LIST_BESIDE, at);
    for (const r of bodyRows(sz)) assert.equal(d.cells[r][LIST_BESIDE].text, "│", `${at}: row ${r} has the rule column at column 30`);
    if (how === "detail") assert.equal(d.terminal, null, at);
    else assert.deepEqual([d.terminal.col, d.terminal.cols], [LIST_BESIDE + 1, sz.cols - LIST_BESIDE - 1], `${at}: the agent's screen has the rest`);
  }
  const LONG = "dev-z-with-a-name-far-longer-than-the-list-beside-a-terminal";
  for (const ascii of [false, true]) {
    const two = stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", LONG)]), { ascii });
    let s = keyed(Object.freeze({ ...two, selected: roster(two).rows.find(({ row }) => row.instance === "dev-a").id }), "enter");
    s = leaderEscape(reduce(s, { shown: { id: s.terminal.id } }).state).state;
    for (const sz of PANEL_WIDE) {
      const d = drawPanel(s, sz), r = listRows(d).find((row) => cellText(d, row, 0, LIST_BESIDE).includes(drawnName(LONG).slice(0, 12)));
      const cut = glyphsOf(ascii).cut, room = LIST_BESIDE - 4 - 5;
      assert.equal(cellText(d, r, 0, LIST_BESIDE), `  ${marksOf(ascii).running} ${drawnName(LONG).slice(0, room - cut.length)}${cut}`, `${sz.cols}${ascii ? " ascii" : ""}: cut inside the 30 columns`);
      // Closed, the sidebar has its own width again, and the name more of its cells.
      const closed = draw(keyed(s, "c"), sz);
      assert.deepEqual([closed.terminal ?? null, closed.cols], [null, listWidth(sz.cols)], `${sz.cols}: closed`);
    }
  }
});

test("Tab from the list with a terminal open shows the detail in the panel's place, until Tab or Esc again", () => {
  for (const sz of [S80, S120]) {
    const d = drawPanel(panelIn("detail"), sz);
    assert.equal(d.terminal, null);
    assert.equal(d.lines.some((line) => line.includes("$ hello")), false);
    assert.equal(d.lines.some((line) => line.includes("worktree")), true, "the detail's rows");
    for (const k of ["tab", "escape"]) assert.notEqual(drawPanel(keyed(panelIn("detail"), k), sz).terminal, null, k);
  }
});

test("close gives the right side back to the detail: the frame is the one with no terminal", () => {
  for (const sz of [S80, S120]) {
    const closed = keyed(panelIn("list"), "c");
    assert.equal(closed.terminal, null);
    assert.deepEqual(drawPanel(closed, sz).lines, draw(PANEL_STATE(), sz).lines);
  }
});

test("the cursor is shown where the agent's is, only while the terminal has the focus and the agent shows one", () => {
  const sz = S120;
  const focused = drawPanel(panelIn("focus"), sz), t = focused.terminal;
  assert.deepEqual(focused.cursor, { row: t.top, col: t.col + 2 });
  assert.equal(drawPanel(panelIn("list"), sz).cursor, null, "the list's focus: no cursor");
  const hidden = draw(panelIn("focus"), sz, { screen: AGENT(t.cols, t.rows, false) });
  assert.equal(hidden.cursor, null, "the agent hides its cursor");
  assert.equal(draw(panelIn("focus"), sz).cursor, null, "no capture yet: no cursor");
  const zoomed = drawPanel(panelIn("zoom"), sz);
  assert.deepEqual(zoomed.cursor, { row: zoomed.terminal.top, col: 2 });
});

test("the leader then Esc from a terminal opened from the detail's focus draws the list with the panel beside it, or the list alone under 80 columns (round 1 of the review)", () => {
  const state = keyed(keyed(PANEL_STATE(), "tab"), "enter");
  const back = leaderEscape(state).state;
  for (const sz of [S80, S120]) {
    const d = drawPanel(back, sz);
    assert.notEqual(d.terminal, null, `${sz.cols}`);
    assert.equal(d.terminal.whole, false, `${sz.cols}`);
    assert.deepEqual(hintsOf(d), TERMINAL_SHEET, `${sz.cols}`);
  }
  const narrow = drawPanel(back, S79);
  assert.equal(narrow.terminal, null);
  assert.deepEqual(hintsOf(narrow), TERMINAL_SHEET);
});

// ── While the leader waits (T1b) ─────────────────────────────────────────────────────────────────

/** The state while the leader waits for its key: the leader alone, from the focus the state has. */
const waiting = (state) => leaderThen(state, "escape").leader.state;
/** What a frame shows: every cell, its text and its style, the cursor, and the terminal's place. */
const seen = (d) => ({ cells: d.cells, cursor: d.cursor, terminal: d.terminal });
/** dev-a's and dev-b's terminals open, each a tab, dev-b's with the focus (the leader then Down). */
const twoTabs = () => { const s = leaderThen(panelIn("focus"), "down").state; return reduce(s, { shown: { id: s.terminal.id } }).state; };
/** Every view, focus and overlay the leader can be pressed in, each as it stands before it. */
const ARMED = () => ({
  "the list": golden(), "the list, ascii": golden({ ascii: true }), "the detail's focus": press(golden(), ["tab"]).state,
  "the default leader": golden({ detachKey: undefined }), "Alt+O": openable({ detachKey: "M-o" }), "F12": openable({ detachKey: "F12" }),
  "the terminal's focus": panelIn("focus"), "the terminal's focus, Alt+O": panelIn("focus", { detachKey: "M-o" }),
  "the terminal's focus, kitty": reduce(panelIn("focus"), { keyboard: 5 }).state, "the terminal's focus, ascii": Object.freeze({ ...panelIn("focus"), ascii: true }),
  "the list beside a terminal": panelIn("list"), "a zoomed terminal": panelIn("zoom"), "the detail beside a terminal": panelIn("detail"),
  "two tabs": twoTabs(), "two tabs, kitty": reduce(twoTabs(), { keyboard: 5 }).state, "two tabs, the list": leaderThen(twoTabs(), "escape").state,
  "a split": leaderThen(twoTabs(), "|").state, "a split, kitty": reduce(leaderThen(twoTabs(), "|").state, { keyboard: 5 }).state,
  "the switcher": press(golden(), ["w", "w"]).state, "the Souls view": press(golden(), ["2"]).state, "the Capabilities view": press(golden(), ["3"]).state,
  "the help": press(golden(), ["?"]).state, "the palette": paletteOpen(golden()), "the palette over a terminal": leaderThen(panelIn("focus"), "k").state,
  "the spawn prompt": press(golden(), ["n"]).state, "the filter field": press(golden(), ["/"]).state,
});

test("while the leader waits nothing on the screen changes: in every view, focus and overlay, at every size from 60x15 to 200x50, with the default leader, a rebound one and in ASCII, the frame is cell for cell the one before it, its cheat sheet the same rows and a zoomed terminal's title row the same keys", () => {
  const SIZES_ARMED = [S60, size(60, 24), size(79, 24), S80, size(80, 15), size(100, 30), S120, size(200, 50)];
  for (const [how, state] of Object.entries(ARMED())) {
    const armed = waiting(state);
    assert.equal(armed.leader?.waiting, true, `${how}: the leader waits`);
    for (const sz of SIZES_ARMED) {
      const at = `${how} at ${sz.cols}x${sz.rows}`, before = drawPanel(state, sz), after = drawPanel(armed, sz);
      assert.deepEqual(hintsOf(after), hintsOf(before), `${at}: the cheat sheet`);
      assert.deepEqual(after.lines, before.lines, `${at}: every row`);
      assert.deepEqual(seen(after), seen(before), `${at}: every cell and the cursor`);
    }
  }
});

test("while the leader waits the sheet is the one it stands in: the leader's `commands` first, in the list and beside a terminal; the terminal's three, then its chords, without the kitty keyboard protocol; with two tabs and a split", () => {
  assert.deepEqual(hintsOf(draw(waiting(golden()), S80)), SHEET_80, "the list at 80x24");
  assert.deepEqual(hintsOf(draw(waiting(golden()), S60)), [LEAD], "at 60x15 the leader alone");
  assert.deepEqual(hintsOf(drawPanel(waiting(panelIn("list")), S80)), TERMINAL_SHEET.slice(0, hintsOf(drawPanel(panelIn("list"), S80)).length), "the list beside a terminal");
  assert.deepEqual(hintsOf(drawPanel(waiting(panelIn("focus")), S120)), FOCUS_SHEET, "the terminal's focus");
  assert.deepEqual(hintsOf(drawPanel(waiting(panelIn("focus", { keysRead: CTRL_ALT_READ })), S120)), [LEAD, [`${LEADER_KEY} Esc`, "the list"], [`${LEADER_KEY} ${LEADER_KEY}`, `types ${LEADER_KEY}`], SCROLL_HINT, ...ARROWS], "the terminal's focus, in the Ctrl+Alt family");
  for (const state of [twoTabs(), leaderThen(twoTabs(), "|").state]) assert.deepEqual(hintsOf(drawPanel(waiting(state), S120)), hintsOf(drawPanel(state, S120)));
  assert.equal(hintsOf(drawPanel(waiting(golden()), size(80, 40))).some(([, word]) => word === "then"), false, "no `then`: the leader's table is the help's");
});

test("once the leader's next key comes the cheat sheet is as it was: Esc, the leader again, or a key not in its table in the list; from a terminal, Esc gives the list's sheet, and a key not in the table leaves the terminal's", () => {
  for (const key of ["escape", golden().leaderKey, "x", "q"]) assert.deepEqual(hintsOf(draw(leaderThen(golden(), key).state, S80)), SHEET_80, key);
  assert.deepEqual(hintsOf(drawPanel(leaderThen(panelIn("focus"), "escape").state, S80)), TERMINAL_SHEET);
  assert.deepEqual(hintsOf(drawPanel(leaderThen(panelIn("focus"), "x").state, S80)), FOCUS_SHEET);
  assert.deepEqual(hintsOf(drawPanel(leaderThen(panelIn("focus", { keysRead: CTRL_ALT_READ }), "x").state, S80)), [LEAD, [`${LEADER_KEY} Esc`, "the list"], [`${LEADER_KEY} ${LEADER_KEY}`, `types ${LEADER_KEY}`], SCROLL_HINT, ...ARROWS], "in the Ctrl+Alt family");
});

test("with no tui.json the leader is Ctrl+X on every platform, and the cheat sheet (the same while it waits) and the help name it so, the terminal's sheet with its Esc and its twice (#1433)", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const list = golden({ detachKey: undefined, platform });
    assert.deepEqual([list.detachKey, list.leaderKey], ["C-x", "ctrl+x"], platform);
    assert.deepEqual(hintsOf(draw(list, S80))[0], ["Ctrl+X", "commands"], `${platform}: the cheat sheet`);
    assert.deepEqual(hintsOf(draw(waiting(list), size(80, 40))), hintsOf(draw(list, size(80, 40))), `${platform}: the same while the leader waits`);
    const help = helpLines(openable({ detachKey: undefined, platform })).map((line) => line.trim()), text = help.join(" ").replace(/ +/g, " ");
    assert.equal(help.includes("Ctrl+X then one of these keys, from every focus; a terminal too:"), true, `${platform}: the leader's section`);
    assert.equal(help.some((line) => line.replace(/ {2,}/g, "  ") === `Ctrl+X  ${LEADER_AGAIN}`), true, `${platform}: the leader again`);
    assert.equal(text.includes("Ctrl+X Esc takes the focus from the terminal back to the list; the agent keeps running. Ctrl+X Ctrl+X types the leader into the terminal."), true, `${platform}: under the agent's line`);
    assert.equal(text.includes("Ctrl+\\") || /Alt\+O then/.test(text), false, `${platform}: no leader of before is named (Alt+O is the Alt family's chord for the workspaces)`);
    // A terminal with the focus: the leader, the leader then Esc, and the leader twice, which types it.
    const two = stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-b")]), { detachKey: undefined, platform });
    const open = keyed(Object.freeze({ ...two, selected: roster(two).rows.find(({ row }) => row.instance === "dev-a").id }), "enter");
    const showing = reduce(open, { shown: { id: open.terminal.id } }).state;
    assert.deepEqual(hintsOf(drawPanel(showing, S120)).filter(([keys]) => keys.startsWith("Ctrl+X")), [["Ctrl+X", "commands"], ["Ctrl+X Esc", "the list"], ["Ctrl+X Ctrl+X", "types Ctrl+X"]], `${platform}: the terminal's sheet`);
  }
});

// ── The palette (T1b) ────────────────────────────────────────────────────────────────────────────

/** The palette, opened as from anywhere: the leader, then `k`. */
const paletteOpen = (state) => leaderThen(state, "k").state;
/** Where an overlay stands at a size: from 80 columns the main area beside the sidebar (from the
 *  second cell after the rule column, to a cell before the right edge), under 80 the whole screen;
 *  and its rows' texts there. */
const areaOf = (d, sz) => (sz.cols >= WIDE ? [d.cols + 2, sz.cols - d.cols - 3] : [0, sz.cols]);
const areaLines = (d, sz) => { const [from, width] = areaOf(d, sz); return d.cells.map((_, r) => cellText(d, r, from, from + width)); };
/** The palette's own keys, last on its cheat sheet (the tests' platform is Linux: helpers.mjs
 *  TEST_PLATFORM; on macOS they hold ⌘, which no terminal passes). */
const PALETTE_GROUP = Object.freeze([["Alt+Shift+Up/Down", "group"]]);
/** The cheat sheet while the palette is open: how to work it. */
const PALETTE_SHEET = Object.freeze([LEAD, ["Enter", "run"], ["Up/Down", "move"], ["Esc", "close"], ...PALETTE_GROUP]);
/** A palette row as the spec draws it in `cols` cells: `>` on the selected one, an instance's state
 *  mark, its text from the fourth cell, cut two cells before the kind, and the kind word at the
 *  right edge. A group's label row: its label from the fourth cell to the edge, and nothing else. */
function paletteRow(item, selected, cols, ascii = false) {
  if (item.kind === "group") return `    ${cutTo(item.label, cols - 4, ascii)}`;
  const text = item.kind === "instance" ? `${item.name}${item.machine ? ` on ${item.machine}` : ""}` : item.kind === "act" ? `${item.label} ${item.name}` : item.label;
  return `${selected ? ">" : " "} ${item.kind === "instance" ? marksOf(ascii)[item.mark] : " "} ${cutTo(text, cols - 6 - item.kind.length, ascii)}`.padEnd(cols - item.kind.length) + item.kind;
}
/** A row of `cols` cells: `left`, then `kind` at the right edge. */
const edged = (left, kind, cols = 80) => `${left.padEnd(cols - kind.length)}${kind}`;

test("the palette at 80x24 in UTF-8 and in ASCII, cell for cell: in the main area beside the sidebar, the query's row on the top row, then the instances that can be opened in the list's order, each group under its label row, dim, then the views, the selected instance's acts and the commands, each cut two cells before its kind at the right edge; the first instance selected, in reverse with `>`; the sidebar stays, its cheat sheet saying how to work the palette", () => {
  const AREA = 39;
  for (const ascii of [false, true]) {
    const run = ascii ? "*" : "●", d = draw(paletteOpen(golden({ ascii })), S80);
    const row = (left, text, kind) => edged(`${left}${cutTo(text, AREA - 6 - kind.length, ascii)}`, kind, AREA);
    // The groups as the sidebar draws them, but acme-expert-tui's, whose one row cannot be opened:
    // each cluster under its root's name, and the single maintainer under `independent`.
    const main = [">",
      `    ${DESKTOP_EXPERT}`, row(`> ${run} `, DESKTOP_EXPERT, "instance"), row(`  ${run} `, DESKTOP_A, "instance"), row(`  ${run} `, DESKTOP_B, "instance"),
      `    ${KERNEL_EXPERT}`, row(`  ${run} `, KERNEL_EXPERT, "instance"), row(`  ${run} `, KERNEL_DEV, "instance"),
      "    independent", row(`  ${run} `, MAINTAINER, "instance"),
      row("    ", "Instances", "view"), row("    ", "Souls", "view"), row("    ", "Capabilities", "view"),
      row("    ", `Stop ${KERNEL_DEV}`, "act"), row("    ", `Retire ${KERNEL_DEV}`, "act"),
      row("    ", "Spawn an agent", "command"), row("    ", "Workspaces", "command"), row("    ", "Refresh", "command"), row("    ", "Help", "command"),
    ];
    const listed = ascii ? LIST_80_ASCII : LIST_80;
    assert.deepEqual(d.lines, beside(instancesSide(workspaceLine("acme-platform", 38, { waiting: true, ascii }), listed, PALETTE_SHEET, { ascii }), main.map((line) => ` ${line}`), { bar: ascii ? "|" : "│" }).map((line) => line.trimEnd()), ascii ? "ASCII" : "UTF-8");
    assert.deepEqual(d.cursor, { row: 0, col: 42 }, "the cursor after the empty query");
    assert.deepEqual(d.cells[0][40].style, style({ bold: true }), "the prompt");
    d.cells[2].slice(40, 40 + AREA).forEach((cell, x) => assert.equal(cell.style.reverse, true, `the selected row, cell ${40 + x}`));
    for (let r = 1; r <= 18; r++) if (r !== 2) assert.equal(d.cells[r].slice(39).some((cell) => cell.style.reverse), false, `row ${r} is not selected`);
    // A group's label row is dim from the fourth cell, its label alone: no mark, no kind.
    for (const r of [1, 5, 8]) {
      const label = areaLines(d, S80)[r].trim();
      for (const cell of d.cells[r].slice(44, 44 + label.length)) assert.deepEqual(cell.style, DIM, `row ${r}: the label`);
      assert.equal(d.cells[r].slice(40, 44).every((cell) => cell.text === " "), true, `row ${r}: no mark`);
      assert.equal(d.cells[r].slice(44 + label.length).every((cell) => cell.text === " " || cell.text === ""), true, `row ${r}: no kind`);
    }
    // A row's kind is dim; an instance's name is plain, and an act's instance dim after its label.
    for (const cell of d.cells[3].slice(40 + AREA - 8, 40 + AREA)) assert.deepEqual(cell.style, DIM);
    for (const cell of d.cells[3].slice(44, 44 + 24)) assert.deepEqual(cell.style, PLAIN);
    for (const cell of d.cells[13].slice(44, 48)) assert.deepEqual(cell.style, PLAIN);
    for (const cell of d.cells[13].slice(49, 49 + 24)) assert.deepEqual(cell.style, DIM);
  }
  // Ctrl+K from the list's focus opens the same palette.
  assert.deepEqual(draw(reduce(golden(), { key: "ctrl+k", read: 1 }).state, S80).lines, draw(paletteOpen(golden()), S80).lines);
});

test("the palette's rows are paletteItems' rows in its order, at 120x40, 80x24 and 60x15: an instance with its state mark and name, and `on <machine>` dim for another machine's; the selection moves with Down", () => {
  const states = [paletteOpen(golden()), paletteOpen(reached()), press(paletteOpen(golden()), ["down", "down"]).state];
  for (const state of states) for (const sz of [S120, S80, S60]) {
    const d = draw(state, sz), list = paletteItems(state, AT), at = `${sz.cols}x${sz.rows}`, [, width] = areaOf(d, sz);
    const rows = areaLines(d, sz).slice(1, sz.rows - 1).filter(Boolean);
    assert.equal(rows.length > 0, true, at);
    rows.forEach((line, i) => assert.equal(line, paletteRow(list.items[i], list.items[i].key === list.selected, width), `${at}: row ${i}`));
    fits(d, sz, at);
  }
  // Down twice moved the selection to the third instance, the fourth row under the query's: the
  // first is its group's label.
  assert.equal(areaLines(draw(states[2], S80), S80)[4].startsWith(`> ● ${DESKTOP_B.slice(0, 20)}`), true);
  assert.equal(areaLines(draw(states[2], S80), S80)[2].startsWith(`  ● ${DESKTOP_EXPERT.slice(0, 20)}`), true);
  assert.equal(areaLines(draw(states[2], S80), S80)[1], `    ${DESKTOP_EXPERT}`);
  // garnet's running instance, which can be opened, is listed with its machine, dim: at 120 columns
  // the main area has the room for both.
  const d = draw(states[1], S120), lines = areaLines(d, S120), r = lines.findIndex((line) => line.includes(FAR_A)), [from, width] = areaOf(d, S120);
  assert.equal(lines[r], edged(`  ● ${FAR_A} on garnet`, "instance", width));
  for (const cell of d.cells[r].slice(from + 4, from + 4 + FAR_A.length)) assert.deepEqual(cell.style, PLAIN);
  for (const x of [0, 1, 3, 4, 5, 6, 7, 8]) assert.deepEqual(d.cells[r][from + 5 + FAR_A.length + x].style, DIM, `the cell ${x} of "on garnet"`);
  // Its row that cannot be addressed is not listed (the sidebar's list has it, not the palette).
  assert.equal(lines.some((line) => line.includes(FAR_B)), false);
});

test("the palette's query row starts with `> `, the cursor stands after the query, and `Nothing matches.` stands under a query that matches nothing; a query longer than its row is cut inside it and the cursor stays on the screen", () => {
  const typed = press(paletteOpen(golden()), ["d", "e", "v"]).state;
  const d = draw(typed, S80);
  assert.equal(areaLines(d, S80)[0], "> dev");
  assert.deepEqual(d.cursor, { row: 0, col: 45 });
  const none = draw(press(typed, ["z", "z", "z"]).state, S80);
  assert.deepEqual(areaLines(none, S80), ["> devzzz", "    Nothing matches.", ...Array(22).fill("")]);
  assert.deepEqual(none.cursor, { row: 0, col: 48 });
  for (const cell of none.cells[1].slice(44, 44 + "Nothing matches.".length)) assert.deepEqual(cell.style, DIM);
  // A wide query: the cursor stands after its cells.
  assert.deepEqual(draw(press(paletteOpen(golden()), ["名", "前"]).state, S80).cursor, { row: 0, col: 46 });
  const long = Object.freeze({ ...typed, palette: Object.freeze({ ...typed.palette, query: "x".repeat(200) }) });
  for (const sz of [S80, S60]) {
    const drawn = draw(long, sz), [from, width] = areaOf(drawn, sz);
    assert.equal(areaLines(drawn, sz)[0], `> ${"x".repeat(width - 4)}…`, `${sz.cols}: under 80 columns no key is left the room on the row`);
    assert.deepEqual(drawn.cursor, { row: 0, col: from + width - 1 }, `${sz.cols}`);
  }
});

test("under 80 columns the palette has the whole screen and its query's row carries its keys at the right, dim; when its rows do not fit, the last row says what is cut off, in the TUI's words: below, then above once the selection went down to the last row", () => {
  const state = paletteOpen(golden()), list = paletteItems(state, AT), d = draw(state, S60);
  const keys = "Enter run   Up/Down move   Esc close";
  assert.equal(d.lines[0], `>${keys.padStart(S60.cols - 2)}`, "the keys end a cell before the edge");
  assert.equal(d.cells[0].slice(S60.cols - 1 - keys.length, S60.cols - 1).every((cell) => cell.text === " " || cell.style.dim), true);
  const drawn = d.lines.slice(1, 14).filter(Boolean).length;
  assert.equal(drawn < list.items.length, true, "at 60x15 the rows do not fit");
  assert.equal(drawn, 13, "every row between the query and the note holds a row of the palette: none is left empty");
  assert.equal(d.lines[14], `    ${list.items.length - drawn} more below`);
  for (const cell of d.cells[14].slice(4, d.lines[14].length)) assert.deepEqual(cell.style, DIM);
  let last = state;
  for (let i = 1; i < list.items.length; i++) last = press(last, ["down"], S60).state;
  const end = draw(last, S60), rows = end.lines.slice(1, 14).filter(Boolean);
  assert.equal(rows.length, 13, "scrolled to the end, too, no row is left empty");
  assert.equal(rows.at(-1), paletteRow(list.items.at(-1), true, 60), "the last row, selected, is on the screen");
  assert.equal(end.lines[14], `    ${list.items.length - rows.length} more above`);
  // Two machines' palette has fewer rows (the instances that can be opened): at 60x15 they fit, with no note.
  const two = paletteOpen(reached()), all = paletteItems(two, AT).items, shown_ = draw(two, S60);
  assert.equal(all[0].kind, "group", "the first row is a group's label");
  assert.deepEqual(shown_.lines.slice(1, 1 + all.length), all.map((item) => paletteRow(item, item.key === paletteItems(two, AT).selected, 60)));
  assert.deepEqual(shown_.lines.slice(1 + all.length), Array(14 - all.length).fill(""));
});

test("while the palette is open no terminal is drawn, even with one open: from 80 columns the palette stands beside the sidebar, which keeps the palette's cheat sheet, and under 80 it has the whole screen; closed with Esc, the terminal it came from is drawn again with the focus in it", () => {
  const opened = paletteOpen(panelIn("focus"));
  for (const sz of [S80, S120, S60]) {
    const d = draw(opened, sz, { screen: AGENT(sz.cols, sz.rows) }), at = `${sz.cols}`;
    assert.equal(d.terminal ?? null, null, at);
    assert.equal(d.cursor.row, 0, `${at}: the cursor is the query's`);
    assert.equal(d.lines.some((line) => line.includes("$ hello")), false, `${at}: nothing of the agent's screen`);
    if (sz.cols >= WIDE) {
      assert.equal(d.cols, LIST_BESIDE, `${at}: the sidebar keeps its width beside the open terminal`);
      for (const r of bodyRows(sz)) assert.equal(d.cells[r][LIST_BESIDE].text, "│", `${at}: row ${r}`);
      assert.deepEqual(hintsOf(d), PALETTE_SHEET, at);
    } else {
      assert.equal(d.lines.some((line) => line.includes("│")), false, `${at}: no sidebar`);
      assert.equal(d.lines[0].endsWith("Enter run   Up/Down move   Esc close"), true, at);
    }
  }
  // dev-a is the shown tab and the first recent entry, so the second instance is selected (T2); with a
  // terminal open the split commands are offered too.
  const d = draw(opened, S80), [, width] = areaOf(d, S80);
  assert.deepEqual(areaLines(d, S80).slice(0, 15), [
    ">",
    "    independent", edged("  ● dev-a", "instance", width), edged("> ● dev-b", "instance", width),
    edged("    Instances", "view", width), edged("    Souls", "view", width), edged("    Capabilities", "view", width),
    edged("    Stop dev-a", "act", width), edged("    Retire dev-a", "act", width),
    edged("    Spawn an agent", "command", width), edged("    Workspaces", "command", width), edged("    Refresh", "command", width), edged("    Help", "command", width),
    edged("    Split right", "command", width), edged("    Split down", "command", width),
  ]);
  const closed = drawPanel(press(opened, ["escape"]).state, S80);
  assert.equal(closed.terminal.whole, false);
  assert.deepEqual(hintsOf(closed), FOCUS_SHEET);
});

test("hostile text in an instance's name or in the query goes through shown(): no control or bidi character in any cell of the palette, and every row inside the terminal, at 80x24 and 60x15, in UTF-8 and in ASCII", () => {
  const HOSTILE = ["dev\x1b[31mred\x1b[0m", "safe‮txt.exe‭", "\u009B31mred\u009B2J", "ti\x1b]0;owned\x07tle", "名".repeat(60), `Z${"́".repeat(60)}algo`];
  for (const ascii of [false, true]) {
    const base = stateOf(observed(HOSTILE.map((name, i) => instanceRow("dev", `${name}-${i}`))), { ascii });
    for (const query of ["", ...HOSTILE]) {
      const open_ = paletteOpen(base), state = Object.freeze({ ...open_, palette: Object.freeze({ ...open_.palette, query }) });
      for (const sz of [S80, S60]) {
        const d = draw(state, sz), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""} ${JSON.stringify(query)}`;
        for (const line of d.cells) for (const cell of line) assert.doesNotMatch(cell.text, CONTROL, at);
        assert.equal(areaLines(d, sz)[0].startsWith(query ? "> " : ">"), true, at);
        fits(d, sz, at);
      }
    }
  }
});

test("a group's label row in the palette: its label dim from the rows' text column, with no mark, no kind and no selection, the instance under it selected; the label is text from outside, through shown(): a cluster's name with control and bidi characters, at 80x24 and 60x15, in UTF-8 and in ASCII", () => {
  const ROOT = "lead\x1b[31mred\x1b[0m‮evil";
  for (const ascii of [false, true]) {
    const state = paletteOpen(stateOf(observed([instanceRow("dev", ROOT), instanceRow("dev", "kid", { parentInstance: ROOT })]), { ascii }));
    assert.deepEqual(paletteItems(state, AT).items.slice(0, 3).map((item) => [item.kind, item.label]), [["group", ROOT], ["instance", ROOT], ["instance", "kid"]], "the cluster's name, as the shared grouping gives it");
    const label = textOf(shown(ROOT));
    for (const sz of [S80, S60]) {
      const d = draw(state, sz), [from, width] = areaOf(d, sz), at = `${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
      for (const line of d.cells) for (const cell of line) assert.doesNotMatch(cell.text, CONTROL, at);
      assert.equal(areaLines(d, sz)[1], `    ${cutTo(label, width - 4, ascii)}`, `${at}: the label alone, from the fourth cell`);
      for (const cell of d.cells[1].slice(from + 4, from + 4 + Math.min(label.length, width - 4))) assert.deepEqual(cell.style, DIM, `${at}: dim`);
      assert.equal(d.cells[1].slice(from, from + width).some((cell) => cell.style.reverse), false, `${at}: never selected`);
      assert.equal(areaLines(d, sz)[2].startsWith(`> ${marksOf(ascii).running} `), true, `${at}: the instance under it is`);
      fits(d, sz, at);
    }
  }
});

test("the palette's cheat sheet names its group keys last, `Alt+Shift+Up/Down group`, on Linux and Windows, and none on macOS, where the TUI has none: in the sidebar, and under 80 columns on the query's row, where they are the first given up; the help's palette section names them after Up and Down, and not on macOS", () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const mac = platform === "darwin", state = paletteOpen(golden({ platform }));
    const group = mac ? [] : [["Alt+Shift+Up/Down", "group"]];
    for (const sz of [S80, S120]) assert.deepEqual(hintsOf(draw(state, sz)), [LEAD, ["Enter", "run"], ["Up/Down", "move"], ["Esc", "close"], ...group], `${platform} ${sz.cols}`);
    // At 70 columns all four stand on the query's row; at 60 the group's, the last, is given up and Esc close stays.
    assert.equal(draw(state, size(70, 24)).lines[0].endsWith(mac ? "Enter run   Up/Down move   Esc close" : "Enter run   Up/Down move   Esc close   Alt+Shift+Up/Down group"), true, `${platform} 70`);
    assert.equal(draw(state, S60).lines[0].endsWith("Enter run   Up/Down move   Esc close"), true, `${platform} 60`);
    const lines = helpLines(golden({ platform })).map((line) => line.trim());
    const palette = lines.slice(lines.indexOf("The palette") + 1, lines.indexOf("The spawn prompt")).filter(Boolean).map((line) => line.replace(/ {2,}/g, "  "));
    assert.deepEqual(palette, [
      `${PALETTE_KEYS[0][0]}  ${PALETTE_KEYS[0][1]}`,
      ...(mac ? [] : [`Alt+Shift+Up, Alt+Shift+Down  ${PALETTE_GROUP_WORDS}`]),
      ...PALETTE_KEYS.slice(1).map(([keys_, said]) => `${keys_}  ${said}`),
    ], `${platform}: the help`);
  }
});

test("no view, focus or overlay draws a header or a footer: from 80 columns no row is a rule over the whole width and the rule column stands on every row beside the sidebar; no row names the views as tabs, and only the help's top row says when the roster was read", () => {
  const states = {
    "the list": golden(), "the detail's focus": press(golden(), ["tab"]).state, "the Souls view": press(golden(), ["2"]).state, "the Capabilities view": press(golden(), ["3"]).state,
    "the filter field": press(golden(), ["/"]).state, "a kept filter": press(golden(), ["/", "t", "u", "i", "enter"]).state,
    "the help": press(golden(), ["?"]).state, "the palette": paletteOpen(golden()), "the switcher": press(golden(), ["w", "w"]).state,
    "the terminal's focus": panelIn("focus"), "the list beside a terminal": panelIn("list"), "the leader waiting": waiting(golden()),
  };
  for (const [what, state] of Object.entries(states)) for (const ascii of [false, true]) for (const sz of SIZES) {
    const s = ascii ? Object.freeze({ ...state, ascii }) : state, d = drawPanel(s, sz), g = glyphsOf(ascii), at = `${what} at ${sz.cols}x${sz.rows}${ascii ? " ascii" : ""}`;
    if (sz.cols >= WIDE) for (const r of bodyRows(sz)) {
      assert.equal(d.cells[r].every((cell) => cell.text === g.rule), false, `${at}: row ${r} is no rule over the whole width`);
      assert.equal(d.cells[r][d.cols].text, g.bar, `${at}: row ${r} has the rule column`);
    }
    d.lines.forEach((line, r) => {
      assert.doesNotMatch(line, /Instances {2,}Souls {2,}Capabilities/, `${at}: row ${r}: no tabs of the views`);
      if (what !== "the help" || r !== 0) assert.doesNotMatch(line, /read \d\d:\d\d:\d\d/, `${at}: row ${r}: no read time`);
    });
  }
});

// An instance's siblings in the palette (#1315): the shared words after the name and the machine.
const PEER_LONG = `peer-long-${"0123456789".repeat(4)}zz`;
/** An anchor with three instances linked to it, one of them named to fill a row. */
const SIBLINGS = () => [instanceRow("dev", "anchor"), ...["peer-1", "peer-2", PEER_LONG].map((name) => instanceRow("dev", name, { siblingInstance: "anchor" }))];
/** The drawn row of the palette for the instance `name` (the rows stand from the palette's second
 *  row, in paletteItems' order), and the row the spec draws for it: `text` after the selection and
 *  the state marks, the kind at the right edge of the palette's area (`from`, `width`). */
function paletteLine(state, sz, name, text) {
  const d = draw(state, sz), list = paletteItems(state, AT), item = list.items.find((each) => each.kind === "instance" && each.name === name);
  const r = 1 + list.items.indexOf(item), [from, width] = areaOf(d, sz);
  return { d, r, from, drawn: areaLines(d, sz)[r], spec: edged(`${item.key === list.selected ? ">" : " "} ${marksOf(state.ascii)[item.mark]} ${text}`, "instance", width) };
}

test("the palette names an instance's siblings, both ends of each link, in the shared words after its name, dim; a query never matches them", () => {
  const state = paletteOpen(stateOf(observed(SIBLINGS()))), list = paletteItems(state, AT);
  const said = Object.fromEntries(list.items.filter((item) => item.kind === "instance").map((item) => [item.name, item.sibling]));
  assert.deepEqual(said, { anchor: `sibling of peer-1, peer-2 and ${PEER_LONG}`, "peer-1": "sibling of anchor", "peer-2": "sibling of anchor", [PEER_LONG]: "sibling of anchor" });
  // An instance with no sibling says nothing.
  assert.equal(paletteItems(paletteOpen(golden()), AT).items.filter((item) => item.kind === "instance").every((item) => item.sibling === null), true);
  // The query matches the name (and the machine), never the sibling's words.
  const typed = (query) => paletteItems(Object.freeze({ ...state, palette: Object.freeze({ ...state.palette, query }) }), AT).items.filter((item) => item.kind === "instance").map((item) => item.name);
  assert.deepEqual(typed("anchor"), ["anchor"]);
  assert.deepEqual(typed("sibling"), []);
  // Drawn: the name plain, the words dim, one cell after it.
  const { d, r, from, drawn, spec } = paletteLine(state, S80, "peer-1", "peer-1 sibling of anchor");
  assert.equal(drawn, spec);
  for (const cell of d.cells[r].slice(from + 4, from + 10)) assert.deepEqual(cell.style, PLAIN);
  assert.deepEqual(d.cells[r][from + 10].style, PLAIN, "the gap");
  for (const cell of d.cells[r].slice(from + 11, from + 11 + "sibling of anchor".length)) assert.deepEqual(cell.style, DIM);
});

test("the palette cuts an instance's siblings first: the name keeps the room, and the machine stands before them, at 200, 80 and 60 columns, in UTF-8 and ASCII", () => {
  for (const ascii of [false, true]) {
    const state = paletteOpen(stateOf(observed(SIBLINGS()), { ascii })), all = `sibling of peer-1, peer-2 and ${PEER_LONG}`;
    // The text's cells before the kind's gap: at 200 columns the main area's 137 leave 123, at 80
    // its 39 leave 25, and at 60 the whole screen's leave 46.
    for (const [sz, room] of [[size(200, 24), 123], [S80, 25], [S60, 46]]) {
      const at = `${sz.cols} columns${ascii ? ", ASCII" : ""}`;
      const anchor = paletteLine(state, sz, "anchor", `anchor ${cutTo(all, room - "anchor ".length, ascii)}`);
      assert.equal(anchor.drawn, anchor.spec, `${at}: the words are cut, the name whole`);
      const peer = paletteLine(state, sz, "peer-2", "peer-2 sibling of anchor");
      assert.equal(peer.drawn, peer.spec, `${at}: words that fit stand whole`);
      // A name of 52 cells: at 200 columns the words get what is left; at 80 and 60 the name is cut and they get nothing.
      const long = paletteLine(state, sz, PEER_LONG, room > PEER_LONG.length + 1 ? `${PEER_LONG} ${cutTo("sibling of anchor", room - PEER_LONG.length - 1, ascii)}` : cutTo(PEER_LONG, room, ascii));
      assert.equal(long.drawn, long.spec, `${at}: the name wins the room`);
      fits(long.d, sz, at);
    }
    // Another machine's instance: its name, `on <machine>`, then its siblings, of that machine.
    const far = paletteOpen(heard(local({ ascii }), answered(group({ instances: [farRow(FAR_A), farRow(`${FAR_A}-twin`, { siblingInstance: FAR_A })] })), T1));
    const words = `sibling of ${FAR_A}-twin`;
    for (const [sz, room] of [[size(200, 24), 123], [S60, 46]]) {
      const before = `${FAR_A} on garnet `, line = paletteLine(far, sz, FAR_A, `${before}${cutTo(words, room - before.length, ascii)}`);
      assert.equal(line.drawn, line.spec, `${sz.cols} columns${ascii ? ", ASCII" : ""}: the machine before the words, which are cut first`);
    }
  }
});

// ── The Souls and Capabilities views (T1b) ───────────────────────────────────────────────────────

/** The name of the accordion's open view: the bold heading under the list of workspaces. */
const openView = (d) => VIEW_ROWS.find(([name]) => cellText(d, openRow(d), 1, 1 + name.length) === name)?.[0] ?? null;
/** The text of the open view's list in the sidebar, its rows joined. */
const bodyText = (d) => listLines(d).map((line) => line.trim()).filter(Boolean).join(" ");

// The Souls view has its content (souls-view.test.mjs draws it), and so has the Capabilities view
// (capabilities-view.test.mjs draws its list and detail). Here: the view as the frame places it
// before its table is read, and after a read that listed none.
/** The loop telling the store it holds the fixture's capabilities table, read and listing none
 *  (capability-catalog.mjs, its projected entry), as lib/main.mjs does. */
const noCapabilities = (state) => reduce(state, { capabilities: { id: DEPLOYMENT, reading: false, entry: {
  key: "key", capabilities: { capabilitiesApi: 1, workspace: { name: "acme-platform" }, capabilities: [], problems: [] }, reason: null, at: 0, observedAt: "2026-10-11T09:59:30.000Z", stale: false, refreshing: false } } }).state;

test("the Capabilities view, before its table is read, says it is reading in the sidebar under its heading at every size, and the main area holds nothing; the accordion shows it open, bold, after the closed views and a rule, reached with 3 in the list or after the leader, and the leader then 1 comes back", () => {
  for (const [key, view, name] of [["3", "capabilities", "Capabilities"]]) {
    for (const state of [press(golden(), [key]).state, leaderThen(golden(), key).state, leaderThen(panelIn("focus"), key).state]) {
      assert.equal(state.view, view);
      for (const sz of SIZES) {
        const d = draw(state, sz), at = `${view} ${sz.cols}x${sz.rows}`;
        assert.equal(openView(d), name, at);
        assert.deepEqual([2, 3, 4, 5, 6, 7].map((r) => cellText(d, r, 0, d.cols)), [viewLine("Instances", "1", d.cols), viewLine("Souls", "2", d.cols), ruleLine(d.cols), viewLine(name, "3", d.cols), `   ${CAPABILITIES_TEXT.reading}`, ruleLine(d.cols)], at);
        assert.deepEqual([2, 3, 5].map((r) => d.cells[r][1].style.bold), [false, false, true], `${at}: the open view's heading is bold`);
        assert.equal(d.cells[5][d.cols - 2].style.dim, true, `${at}: its key dim at the right`);
        assert.equal(bodyText(d), CAPABILITIES_TEXT.reading, at);
        if (sz.cols >= WIDE) assert.deepEqual(bodyRows(sz).filter((r) => cellText(d, r, d.cols + 1) !== ""), [], `${at}: the main area holds nothing`);
        assert.equal(d.terminal ?? null, null, `${at}: no terminal`);
        fits(d, sz, at);
      }
    }
    assert.equal(openView(draw(leaderThen(press(golden(), [key]).state, "1").state, S80)), "Instances", `${view}: the leader then 1`);
  }
  assert.deepEqual(listLines(draw(press(golden(), ["3"]).state, S80)), ["   Reading capabilities…"]);
  assert.deepEqual(listLines(draw(press(golden({ ascii: true }), ["3"]).state, S80)), ["   Reading capabilities..."], "the ellipsis is three dots in ASCII");
});

test("the Capabilities view's cheat sheet before its table is read is small: the leader, the palette, help and quit at every width; Enter has nothing to show and the acts do nothing there, and neither is offered", () => {
  const all = [LEAD, ["Ctrl+K", "palette"], ["?", "help"], ["q", "quit"]];
  const at = { 120: all, 80: all, 60: all };
  for (const [key, view] of [["3", "capabilities"]]) {
    for (const base of [golden(), openable()]) {
      const state = press(base, [key]).state;
      for (const k of ["enter", "X", "D"]) {
        const step = press(state, [k]);
        assert.deepEqual([step.state.view, step.state.terminal, step.state.act ?? null, step.effects], [view, null, null, []], `${view}: ${k} does nothing`);
      }
      for (const sz of [S60, S80, S120]) assert.deepEqual(hintsOf(draw(state, sz)), at[sz.cols], `${view} at ${sz.cols}`);
    }
  }
});

test("the Capabilities view of a table that lists none says so in the sidebar and names its command whole on one row at every width from 60 to 200 columns: a command cut in two cannot be typed", () => {
  const state = noCapabilities(press(golden(), ["3"]).state);
  assert.equal(bodyText(draw(state, S80)), CAPABILITIES_TEXT.none);
  const command = CAPABILITIES_TEXT.none.match(/`[^`]+`/)[0];
  assert.equal(command, "`oats capabilities`");
  for (let cols = MIN_SIZE.cols; cols <= 200; cols++) {
    const sz = size(cols, 24), d = draw(state, sz), lines = listLines(d);
    assert.equal(lines.some((line) => line.includes(command)), true, `${command} at ${cols}: ${JSON.stringify(lines.filter(Boolean))}`);
    assert.equal(bodyText(d), CAPABILITIES_TEXT.none, `${cols}: the whole sentence`);
  }
});

// ── The help's leader section (T1b) ──────────────────────────────────────────────────────────────

test("at 60 columns the help's `The leader` section has every row whole: the sentence after the leader's key wrapped under its first row, the table's rows uncut, the leader again's wrapped under its words, none past the edge", () => {
  for (const [detachKey, key, lead] of [[undefined, "Ctrl+\\", ["  Ctrl+\\ then one of these keys, from every focus; a", "         terminal too:"]], ["C-F5", "Ctrl+F5", ["  Ctrl+F5 then one of these keys, from every focus; a", "          terminal too:"]]]) {
    const lines = helpLines(golden(detachKey ? { detachKey } : {}), size(60, 330));
    // The section ends where the next begins, the chords' or the palette's (spawn-view.test.mjs holds the spawn prompt's).
    const from = lines.indexOf("  The leader"), to = nextHeading(lines, from);
    assert.equal(from > 0 && to > from, true);
    assert.deepEqual(lines.slice(from, to - 1), [
      "  The leader",
      "",
      ...lead,
      "  k, Space    palette",
      "  1           instances",
      "  2           souls",
      "  3           capabilities",
      "  Up          previous workspace",
      "  Down        next workspace",
      "  z           zoom, while a terminal is open",
      "  b           hide or show the list",
      "  w           close terminal, while a terminal is open",
      "  Left        previous tab, while a terminal is open",
      "  Right       next tab, while a terminal is open",
      "  |, h        split right, while a terminal is open",
      "  -, v        split down, while a terminal is open",
      "  Tab         next group, while a terminal is open",
      "  Shift+Tab   previous group, while a terminal is open",
      "  m           move tab, while a terminal is open",
      "  x           close group, while a terminal is open",
      "  X           stop",
      "  R           restart",
      "  S           start",
      "  D           retire",
      "  n           spawn",
      "  N           spawn another",
      "  /           filter",
      "  o           workspaces",
      "  ?           help",
      "  Esc         the list",
      `  ${key.padEnd(12)}the leader again: types it into the terminal`,
      "              that has the focus; with the list focused,",
      "              cancels the leader",
    ], key);
    for (const line of lines.slice(from, to)) assert.equal(textWidth(line) <= 60 - 2, true, `the right margin is kept: ${line}`);
  }
});

// ── The main area beside the sidebar is narrow (39 cells at 80 columns): what an overlay draws
// there must still stand whole (round 1 of the review).

test("a confirmation beside the sidebar at 80x24 draws every offer, the act's own button among them, before and after the focus moves to it: buttons that do not fit one row go on to the next, never left out", () => {
  const cli = { ...CLI, lifecycleApi: 1, features: [...CLI.features, "lifecycle-plans", "retire-retention", "retire-home"] };
  const state = stateOf(observed([instanceRow("dev", "dev-a")], { cli }), { cli });
  for (const [key, verb] of [["X", "Stop"], ["D", "Retire"]]) {
    const opened = press(state, [key]).state;
    assert.equal(opened.view, "act", verb);
    // The shared confirmation's review offers: Cancel, Review again and the act (acts.test.mjs).
    const reviewing = reduce(opened, { acted: { n: opened.act.n, confirmation: { phase: "review", offers: ["close", "refresh", "apply"], view: { title: `${verb} dev-a?` } } } }).state;
    const focused = press(reviewing, ["tab", "tab"]).state;
    assert.equal(focused.act.focus, "apply", verb);
    for (const [s, marked] of [[reviewing, "> Cancel <"], [focused, `> ${verb} <`]]) {
      const d = draw(s, S80), main = d.lines.map((line) => line.slice(d.cols + 2));
      const shown = main.join("\n");
      for (const label of ["Cancel", "Review again", verb]) assert.equal(shown.includes(` ${label} `), true, `${verb}: ${label} is drawn`);
      assert.equal(shown.includes(marked), true, `${verb}: the focused offer is drawn between > and <`);
      assert.equal(main.every((line) => textWidth(line) <= S80.cols - d.cols - 2), true, `${verb}: no button passes the main area`);
    }
  }
});

test("the help in the main area beside the sidebar at 80 columns cuts no command: a command wider than its column starts further left, inside the area, and one wider than the area is broken before its flags, the rows after the first 2 cells further in", () => {
  const cols = S80.cols - draw(stateOf(observed([instanceRow("dev", "dev-a")])), S80).cols - 3;
  const rows = helpRows(ACTIONS, false, cols, "M-o").map((row) => row.filter((span) => span.text !== undefined));
  /** The spans `command` stands in from each row it starts on: one, or its broken rows in order. */
  const placed = (command) => rows.flatMap((row, i) => row.filter((span) => command === textOf(span.text) || command.startsWith(`${textOf(span.text)} --`)).flatMap((first) => {
    const spans = [first];
    for (let j = i + 1; spans.map((span) => textOf(span.text)).join(" ").length < command.length && rows[j]?.length === 1 && rows[j][0].col === first.col + 2 && textOf(rows[j][0].text).startsWith("--"); j++) spans.push(rows[j][0]);
    return spans.map((span) => textOf(span.text)).join(" ") === command ? [spans] : [];
  }));
  for (const { command } of NOT_YET) {
    const found = placed(command);
    // A command can stand for more than one omission (`oats spawn <soul>`): each of its rows.
    assert.equal(found.length, NOT_YET.filter((each) => each.command === command).length, command);
    for (const spans of found) {
      for (const span of spans) assert.equal(span.col >= 0 && span.col + textOf(span.text).length <= cols, true, `${command} stands whole in ${cols} cells`);
      assert.equal(spans.length > 1, command.length > cols, `${command} is broken only when it is wider than the ${cols} cells`);
    }
  }
  assert.deepEqual(placed("oats server connect <id> --ssh <alias> --dir <path on that machine>").map((spans) => spans.map((span) => textOf(span.text))), [["oats server connect <id> --ssh <alias>", "--dir <path on that machine>"]], "each flag with its value");
});

// ── A row's name and its word; a detail page's keys ─────────────────────────────────────────────

test("an instance row's name wins over its word: beside an open terminal (30 cells) a name of 16 cells keeps them and its word is left out, a short name keeps its word; at 36 cells the word is cut to the 9 cells the name's 16 leave, and at 48 the word column fits", () => {
  const HELD = "developer-twelve";
  const base = stateOf(observed([instanceRow("dev", "dev-a"), instanceRow("dev", "dev-2", { running: null, runtimeState: "unreachable" }), instanceRow("dev", HELD, { running: false, runtimeState: "stopped", rollbackIncomplete: true })]));
  const spawn = heldHome(instanceRow("dev", HELD, { running: false, runtimeState: "stopped", rollbackIncomplete: true })).state, unknown = rowReason(panelRow(base, "dev-2")).label;
  assert.deepEqual([spawn, textWidth(HELD)], ["Spawn didn't finish", 16]);
  // dev-a's terminal open, the list focused: the sidebar keeps 30 cells, 21 for a name, a gap and a word.
  let open = keyed(Object.freeze({ ...base, selected: roster(base).rows.find(({ row }) => row.instance === "dev-a").id }), "enter");
  open = leaderEscape(reduce(open, { shown: { id: open.terminal.id } }).state).state;
  for (const sz of [S80, S120]) {
    const d = drawPanel(open, sz);
    assert.equal(d.cols, LIST_BESIDE, `${sz.cols}`);
    assert.deepEqual(listLines(d), [`  ? Dev 2  ${unknown}`, "> ● Dev a", `  ◆ Developer twelve`], `${sz.cols}: the short name keeps its word two cells after it; the long one is whole, with no word`);
  }
  // The mark and the detail still say it.
  assert.equal(fact(detailOf(selecting(base, HELD)), "state").rows[0], spawn);
  // No frame gives the sidebar 36 or 48 cells (from 80 columns it takes 38 at least, beside a
  // terminal 30): the view draws its rows at those widths.
  const rowsAt = (cols) => createScreen({ utf8: true }).cells(instances(model(base, { page: 8, now: NOW, at: AT, cols }), size(cols, 8)), size(cols, 8)).map((line) => line.map((cell) => cell.text).join("").trimEnd()).filter(Boolean);
  assert.deepEqual(rowsAt(30), [`> ? Dev 2  ${unknown}`, "  ● Dev a", `  ◆ Developer twelve`], "the view at 30 cells draws what the frame does");
  assert.deepEqual(rowsAt(36), [`> ? Dev 2   ${unknown}`, "  ● Dev a", `  ◆ Developer twelve  ${cutTo(spawn, 9)}`], "at 36 the word column fits after dev-2, not after the long name: its word is cut to 9 cells");
  assert.deepEqual(rowsAt(48), [`> ? Dev 2               ${unknown}`, "  ● Dev a", `  ◆ Developer twelve    ${spawn}`], "at 48 the column fits for both, as before");
});

test("an instance row shows its name as words, the Desktop's sidebar label, a nested row too; the detail, the filter, the palette and a tab keep the instance's name", () => {
  const LANES = "oats-expert-maintainer-lanes", HINT = "tui-leader-hint-developer-2";
  const two = stateOf(observed([instanceRow("oats-expert", LANES), instanceRow("oats-kernel-developer", HINT, { parentInstance: LANES })]));
  const state = Object.freeze({ ...two, selected: roster(two).rows.find(({ row }) => row.instance === LANES).id });
  const d = draw(state, S120);
  assert.deepEqual(listLines(d).filter((line) => line.trim()), ["> ● Oats expert maintainer lanes", "    ● Tui leader hint developer 2"], "each `-` a space, the first letter upper-case");
  assert.equal(cellText(d, 0, d.cols + 1).trim(), LANES, "the detail's title is the instance's name");
  // The filter matches the instance's name: `oats-expert` still finds the row, drawn as words.
  const filtered = draw(press(state, ["/", ..."oats-expert", "enter"]).state, S120), matched = listLines(filtered).filter((line) => line.trim());
  assert.equal(matched.length === 1 && matched[0].endsWith("Oats expert maintainer lanes"), true, `the one row the name matches: ${matched}`);
  assert.deepEqual(paletteItems(paletteOpen(state), AT).items.filter((item) => item.kind === "instance").map((item) => item.label).sort(), [LANES, HINT], "the palette names the instances");
  const open = drawPanel(keyed(state, "enter"), S120);
  assert.equal(open.lines[0].slice(open.terminal.col).trim(), `[${LANES} 1]`, "a tab is named by the instance's name");
  assert.equal(listLines(open).some((line) => line.startsWith("> ● Oats expert maint")), true, "while its row beside it shows the words, cut to the sidebar's 30 cells");
});

test("a name the display filter withholds is withheld on its row as it came: it is never made words first, which would hide what made it unsafe; the names around it are words", () => {
  // Synthetic names a machine's roster can report (its rows are not held to the kernel's grammar): a
  // credential's URL whose `-` the words would make a space, and a control character the words would trim.
  const UNSAFE = ["https://u:p-ass@h", "\rordinary-name"];
  for (const name of UNSAFE) {
    assert.equal(displayLine(name), DETAIL_WITHHELD, `${JSON.stringify(name)}: the filter withholds the name as it came`);
    assert.notEqual(displayLine(drawnName(name)), DETAIL_WITHHELD, `${JSON.stringify(name)}: and would let its words through`);
  }
  const state = heard(local(), answered(group({ instances: [farRow(FAR_A), ...UNSAFE.map((name) => farRow(name))] })), T1);
  assert.deepEqual(UNSAFE.map((name) => panelRow(state, name)?.instance), UNSAFE, "the rows keep the names they came with");
  for (const sz of [S120, S80]) {
    const lines = listLines(draw(state, sz), sz), at = `${sz.cols}x${sz.rows}`;
    assert.equal(lines.some((line) => line.includes(drawnName(FAR_A))), true, `${at}: a name the filter lets through is words`);
    assert.equal(lines.filter((line) => /^[> ] +[●○◌?◆] \[withheld\]$/.test(line)).length, 2, `${at}: each unsafe name is drawn withheld: ${JSON.stringify(lines)}`);
    for (const line of lines) assert.doesNotMatch(line, /Https|p ass|ordinary/i, `${at}: nothing of an unsafe name is drawn`);
  }
});

test("under 80 columns the Instances detail page's first row carries its keys at the right, dim, ending a cell before the edge: `Tab back`, what Enter does, `n spawn` and `w workspaces`, given up from the end as the name grows; `Tab back` always stands, the name cut to leave it room (round 3 of the review)", () => {
  const page = (name, sz, options = {}) => draw(press(stateOf(observed([instanceRow("dev", name)]), options), ["tab"], sz).state, sz);
  const ALL = "Tab back   Enter open   n spawn   w workspaces", SPAWN = "Tab back   Enter open   n spawn";
  for (const sz of [size(70, 20), S79]) {
    const d = page("dev-2", sz), at = `${sz.cols}x${sz.rows}`;
    assert.equal(detailPage(d), true, at);
    assert.equal(d.lines[0], pageTop(" > dev-2", ALL, sz.cols), at);
    const from = sz.cols - 1 - ALL.length;
    d.cells[0].slice(from, sz.cols - 1).forEach((cell, x) => { if (cell.text !== " ") assert.equal(cell.style, DIM, `${at}: the keys are dim (cell ${from + x})`); });
    d.cells[0].slice(3, 8).forEach((cell) => assert.equal(cell.style.dim, false, `${at}: the name is not`));
  }
  // At 70 columns the keys and their 3-cell gap fit after ` > ` and a name of up to 17 cells; a
  // longer one gives `w workspaces` up (up to 32 cells), then `n spawn`, then Enter's hint; `Tab back`
  // stays, and a name longer than the 55 cells it leaves is cut.
  const named = (cells) => `dev-${"x".repeat(cells - 4)}`;
  for (const [cells, keys] of [[17, ALL], [18, SPAWN], [32, SPAWN], [33, "Tab back   Enter open"], [42, "Tab back   Enter open"], [43, "Tab back"], [55, "Tab back"], [56, "Tab back"], [80, "Tab back"]]) {
    const name = named(cells), d = page(name, size(70, 20));
    assert.equal(d.lines[0], pageTop(` > ${cutTo(name, 55)}`, keys, 70), `a name of ${cells} cells`);
  }
  // At 60x15 a 46-cell name is cut to 45, and with the detail's key rebound it is that key.
  assert.equal(page(named(46), S60).lines[0], pageTop(` > ${cutTo(named(46), 45)}`, "Tab back", 60));
  const rebound = effectiveConfig({ keys: { detail: ["f6", "tab"] } });
  assert.equal(page(named(46), S60, { actions: rebound.actions }).lines[0], pageTop(` > ${cutTo(named(46), 46)}`, "F6 back", 60));
});

test("the list of workspaces with the focus: its sheet names the keys as tui.json binds them, and an action with no key has no hint", () => {
  const focused = (keys, focus = ["w"]) => press(stateOf(observed([instanceRow("dev", "dev-a")]), { actions: effectiveConfig({ keys }).actions }), focus).state;
  assert.deepEqual(hintsOf(draw(focused({}), S120)), [LEAD, ["Enter", "open"], ["Up/Down", "move"], ["Esc", "back"], ["w", "all workspaces"], ["?", "help"], ["q", "quit"]]);
  const rebound = focused({ open: ["o"], up: ["k"], down: ["j"], close: ["backspace"], workspaces: ["f2"] }, ["f2"]);
  assert.equal(rebound.focus, "workspaces");
  assert.deepEqual(hintsOf(draw(rebound, S120)), [LEAD, ["o", "open"], ["k/j", "move"], ["Backspace", "back"], ["F2", "all workspaces"], ["?", "help"], ["q", "quit"]]);
  assert.deepEqual(hintsOf(draw(focused({ open: [], down: [] }), S120)), [LEAD, ["Up", "move"], ["Esc", "back"], ["w", "all workspaces"], ["?", "help"], ["q", "quit"]]);
});
