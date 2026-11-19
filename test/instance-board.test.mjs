// Feature instance-board (boardApi 1): the agent's board, the facts it keeps in view for its person and the
// questions it asks them, in a home file of its own (`.oats-board.json`, lib/instance-board.mjs). Written only by
// the agent from its own session (`oats instance board set|unset|ask|ask --clear`), read on `oats status --json`
// rows (`board`), on `oats inspect --home <h> --board` (history and context), and relayed on remote roster rows.
//
// What is pinned here:
// - set/unset: upsert by key, the history (its last 20 values), order first set, nothing written for no change;
// - ask/clear: ids q<n>, numbered per home and never reused; an explicit --id; 2 to 4 options; a retry of the
//   same question is no change, another under an open id is refused; --clear of an id not open is no change;
// - text rules: the refused characters, the lengths, the key and id shape, the link, the context file;
// - the bounds: 12 facts, 9 open questions, the 8 KiB row (E_BOARD_FULL), nothing written by a refusal;
// - the claim: producer oats.board, reason attention, the oldest question's text, cleared on the last --clear;
//   it holds no scheduled wake;
// - the session rule: questions asked before the latest launched/restarted/stopped boundary are not live and a
//   write drops them; facts persist;
// - the reads: `board` null with no file, an empty board for a malformed one, never an error; the row carries no
//   history or context; inspect --board carries both; the file is 0600 and kernel-owned;
// - refusals: --home, --dir and --server, and outside an instance home.
// The remote roster's relay is pinned in test/remote-parity.test.mjs; the probe's boardApi and the feature in
// test/cli-json-contract.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { v2Deployment, CLI } from "./helpers/v2-deployment.mjs";
import { BOARD_FILE, ROW_MAX, boardRow, readBoardDocument, readBoardRow, readRemoteBoard } from "../lib/instance-board.mjs";
import { appendEvent, readEvents, waitingHold } from "../lib/instance-events.mjs";
import { disposableHomeRootProblem } from "../lib/capability-contract.mjs";
import { KERNEL_HOME_RECEIPTS } from "../lib/core.mjs";

const fx = v2Deployment();
test.after(() => fx.cleanup());

let n = 0;
/** A fresh home of soul dev, spawned without a launch. */
async function freshHome() { return (await fx.spawn("dev", { name: `board-${++n}` })).home; }
/** The CLI as the agent of `home` runs it: in its session, $OATS_INSTANCE_HOME set. */
const agent = (home, args, env = {}) => {
  const r = fx.cli(["instance", "board", ...args, "--json"], { cwd: home, env: { TMUX: undefined, OATS_HOME: undefined, OATS_INSTANCE_HOME: home, ...env } });
  let doc = null; try { doc = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* not JSON */ }
  return { ...r, doc };
};
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); assert.equal(r.doc.ok, true, what); return r.doc.result; };
const refused = (r, code, what) => { assert.notEqual(r.status, 0, what); assert.equal(r.doc?.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.equal(r.doc.error.code, code, `${what}: ${r.doc.error.message}`); return r.doc.error; };
const statusRow = (home) => JSON.parse(fx.cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).find((i) => i.home === home);
const fileOf = (home) => readFileSync(join(home, BOARD_FILE), "utf8");

test("set upserts by key, in the order first set; history keeps the last 20 values; no change writes nothing; unset removes the key and its history", async () => {
  const home = await freshHome();
  assert.equal(statusRow(home).board, null, "no board file: null");
  const first = ok(agent(home, ["set", "pr", "--label", "Pull request", "--value", "#1990", "--link", "https://github.com/oats-project/oats/pull/1990"]), "set pr");
  assert.deepEqual(Object.keys(first), ["boardApi", "instance", "home", "key", "changed", "board"]);
  assert.equal(first.boardApi, 1); assert.equal(first.key, "pr"); assert.equal(first.changed, true); assert.equal(first.home, home);
  assert.equal(statSync(join(home, BOARD_FILE)).mode & 0o777, 0o600);
  ok(agent(home, ["set", "1", "--label", "Best score", "--value", "0.91", "--unit", "F1"]), "set 1");
  const fact = first.board.facts[0];
  assert.deepEqual(Object.keys(fact), ["key", "label", "value", "unit", "link", "at"]);
  assert.equal(fact.unit, null);
  let row = statusRow(home).board;
  assert.deepEqual(row.facts.map((f) => f.key), ["pr", "1"], "first-set order, a numeric key included");
  assert.deepEqual(row.questions, []);
  const bytes = fileOf(home);
  const same = ok(agent(home, ["set", "pr", "--label", "Pull request", "--value", "#1990", "--link", "https://github.com/oats-project/oats/pull/1990"]), "same set");
  assert.equal(same.changed, false); assert.equal(fileOf(home), bytes, "no change: nothing written");
  for (let i = 0; i < 25; i++) ok(agent(home, ["set", "1", "--label", "Best score", "--value", `0.${i}`, "--unit", "F1"]), `score ${i}`);
  ok(agent(home, ["set", "1", "--label", "Best F1", "--value", "0.24", "--unit", "F1"]), "a new label, the same value");
  row = statusRow(home).board;
  assert.deepEqual(row.facts.map((f) => f.key), ["pr", "1"], "an update keeps its place");
  assert.equal(row.facts[1].label, "Best F1"); assert.equal(row.facts[1].value, "0.24");
  assert.equal(Object.hasOwn(row.facts[1], "history"), false, "the row carries no history");
  const doc = readBoardDocument(home);
  assert.deepEqual(doc.facts[1].history.map((h) => h.value), Array.from({ length: 20 }, (_, i) => `0.${i + 5}`), "the last 20 values; a label change adds none");
  const gone = ok(agent(home, ["unset", "pr"]), "unset");
  assert.equal(gone.changed, true); assert.deepEqual(gone.board.facts.map((f) => f.key), ["1"]);
  assert.equal(ok(agent(home, ["unset", "pr"]), "unset again").changed, false);
  ok(agent(home, ["set", "pr", "--label", "Pull request", "--value", "#2000"]), "set again");
  assert.deepEqual(readBoardDocument(home).facts.map((f) => [f.key, f.history.length]), [["1", 20], ["pr", 1]], "a key set again is new: last, with a history of its own");
});

test("ask opens questions q1, q2…, never reusing an id; --id; 2 to 4 options; a retry is no change; --clear closes; the claim is oats.board's, reason attention, the oldest question, and holds no wake", async () => {
  const home = await freshHome();
  const q1 = ok(agent(home, ["ask", "Squash before merging?", "--option", "Yes, one clean commit", "--option", "No, keep the history"]), "ask");
  assert.deepEqual(Object.keys(q1), ["boardApi", "instance", "home", "id", "changed", "board"]);
  assert.equal(q1.id, "q1"); assert.equal(q1.changed, true);
  assert.deepEqual(Object.keys(q1.board.questions[0]), ["id", "question", "options", "hasContext", "since"]);
  assert.deepEqual(q1.board.questions[0].options, ["Yes, one clean commit", "No, keep the history"]);
  assert.equal(q1.board.questions[0].hasContext, false);
  let events = readEvents(home);
  assert.deepEqual(events.waitingOnYou && { producer: events.waitingOnYou.producer, reason: events.waitingOnYou.reason, message: events.waitingOnYou.message },
    { producer: "oats.board", reason: "attention", message: "Squash before merging?" });
  assert.equal(waitingHold(home), null, "reason attention: no scheduled wake is held");

  const q2 = ok(agent(home, ["ask", "Which base?", "--option", "main", "--option", "next", "--option", "release", "--option", "none"]), "four options");
  assert.equal(q2.id, "q2");
  refused(agent(home, ["ask", "One option?", "--option", "only"]), "E_BAD_ARGS", "one option");
  refused(agent(home, ["ask", "Five?", "--option", "a", "--option", "b", "--option", "c", "--option", "d", "--option", "e"]), "E_BAD_ARGS", "five options");
  refused(agent(home, ["ask", "--option", "a", "--option", "b"]), "E_BAD_ARGS", "no question");
  const named = ok(agent(home, ["ask", "Deploy now?", "--option", "yes", "--option", "later", "--id", "deploy"]), "--id");
  assert.equal(named.id, "deploy");
  const retry = ok(agent(home, ["ask", "Deploy now?", "--option", "yes", "--option", "later", "--id", "deploy"]), "the same again");
  assert.equal(retry.changed, false);
  refused(agent(home, ["ask", "Deploy tomorrow?", "--option", "yes", "--option", "later", "--id", "deploy"]), "E_BAD_ARGS", "other text under an open id");
  refused(agent(home, ["ask", "--clear", "q1", "--option", "x"]), "E_BAD_ARGS", "--clear takes nothing else");

  const cleared = ok(agent(home, ["ask", "--clear", "q1"]), "clear q1");
  assert.equal(cleared.id, "q1"); assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.board.questions.map((q) => q.id), ["q2", "deploy"], "the order asked");
  assert.equal(readEvents(home).waitingOnYou.message, "Which base?", "the claim follows the oldest open question");
  assert.equal(ok(agent(home, ["ask", "--clear", "q1"]), "clear q1 again").changed, false, "an id not open: no change");
  const q3 = ok(agent(home, ["ask", "Rebase?", "--option", "yes", "--option", "no"]), "after a clear");
  assert.equal(q3.id, "q3", "q1 is never reused");
  ok(agent(home, ["ask", "Tag it?", "--option", "yes", "--option", "no", "--id", "q7"]), "an explicit q7");
  assert.equal(ok(agent(home, ["ask", "Ship?", "--option", "yes", "--option", "no"]), "after q7").id, "q8", "the count moves past an explicit q<n>");
  for (const id of ["q2", "deploy", "q3", "q7"]) ok(agent(home, ["ask", "--clear", id]), `clear ${id}`);
  assert.equal(readEvents(home).waitingOnYou.message, "Ship?");
  ok(agent(home, ["ask", "--clear", "q8"]), "the last clear");
  events = readEvents(home);
  assert.equal(events.waitingOnYou, null, "the last --clear removes the claim");
  assert.deepEqual(events.waitingClaims.find((c) => c.producer === "oats.board")?.waiting, false);
  assert.deepEqual(statusRow(home).board, { facts: [], questions: [] }, "a board with nothing on it is empty, not null");
});

test("the context: from a file, newlines kept, on inspect --board only; the row says hasContext; inspect --board carries each fact's history", async () => {
  const home = await freshHome();
  const ctx = join(home, "context.txt");
  writeFileSync(ctx, "The branch has 14 commits.\nThree are fixups of the first.\n");
  ok(agent(home, ["set", "pr", "--label", "Pull request", "--value", "#1"]), "set");
  ok(agent(home, ["set", "pr", "--label", "Pull request", "--value", "#2"]), "set again");
  const asked = ok(agent(home, ["ask", "Squash?", "--option", "yes", "--option", "no", "--context-file", ctx]), "ask with context");
  assert.equal(asked.board.questions[0].hasContext, true);
  assert.equal(Object.hasOwn(statusRow(home).board.questions[0], "context"), false, "the row carries no context");
  const r = fx.cli(["inspect", "--home", home, "--board", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const board = JSON.parse(r.stdout).result.instance.board;
  assert.equal(board.questions[0].context, "The branch has 14 commits.\nThree are fixups of the first.");
  assert.deepEqual(board.facts[0].history.map((h) => h.value), ["#1", "#2"]);
  assert.ok(board.facts[0].history.every((h) => typeof h.at === "string"));
  const plain = fx.cli(["inspect", "--home", home, "--json"]);
  assert.equal(Object.hasOwn(JSON.parse(plain.stdout).result.instance, "board"), false, "without --board, no board");
  const text = fx.cli(["inspect", "--home", home, "--board"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Board: 1 fact, 1 open question/);
  const soul = fx.cli(["inspect", "--soul", "dev", "--board", "--json"]);
  assert.equal(JSON.parse(soul.stdout).error.code, "E_BAD_ARGS", "--board takes --home, not --soul");
  writeFileSync(ctx, "a\rb");
  refused(agent(home, ["ask", "Again?", "--option", "a", "--option", "b", "--context-file", ctx]), "E_BAD_ARGS", "a CR in the context");
  writeFileSync(ctx, "x".repeat(2001));
  refused(agent(home, ["ask", "Again?", "--option", "a", "--option", "b", "--context-file", ctx]), "E_BAD_ARGS", "a context over 2000 characters");
  refused(agent(home, ["ask", "Again?", "--option", "a", "--option", "b", "--context-file", join(home, "absent.txt")]), "E_BAD_ARGS", "a context file that is not there");
});

test("text rules: refused characters, lengths, the key and id shape, the link; nothing is written by a refusal", async () => {
  const home = await freshHome();
  ok(agent(home, ["set", "keep", "--label", "Kept", "--value", "1"]), "a first fact");
  const before = fileOf(home);
  const cases = [
    [["set", "Bad", "--label", "l", "--value", "v"], "an uppercase key"],
    [["set", "-x", "--label", "l", "--value", "v"], "a key that starts with a hyphen"],
    [["set", "k".repeat(17), "--label", "l", "--value", "v"], "a key over 16"],
    [["set", "k", "--value", "v"], "no label"],
    [["set", "k", "--label", "l"], "no value"],
    [["set", "k", "--label", "a\u202Eb", "--value", "v"], "a bidi override in the label"],
    [["set", "k", "--label", "l", "--value", "a\u0007b"], "a control character in the value"],
    [["set", "k", "--label", "x".repeat(41), "--value", "v"], "a label over 40"],
    [["set", "k", "--label", "l", "--value", "x".repeat(81)], "a value over 80"],
    [["set", "k", "--label", "l", "--value", "v", "--unit", "x".repeat(17)], "a unit over 16"],
    [["set", "k", "--label", "l", "--value", "v", "--link", "http://example.com"], "a link that is not https"],
    [["set", "k", "--label", "l", "--value", "v", "--link", "https://"], "a link with no host"],
    [["set", "k", "--label", "l", "--value", "v", "--link", `https://example.com/${"x".repeat(500)}`], "a link over 512"],
    [["set", "k", "--label", "l", "--value", "v", "--link", "https://exämple.com"], "a link that is not ASCII"],
    [["set", "k", "--label", "l", "--value", "v", "--label", "m"], "a flag given twice"],
    [["ask", "x".repeat(201), "--option", "a", "--option", "b"], "a question over 200"],
    [["ask", "Line\u2028two", "--option", "a", "--option", "b"], "a line separator in the question"],
    [["ask", "Q?", "--option", "x".repeat(61), "--option", "b"], "an option over 60"],
    [["ask", "Q?", "--option", "a\u200Bb", "--option", "b"], "U+200B in an option"],
    [["ask", "Q?", "--option", "a", "--option", "b", "--id", "Q1"], "an uppercase id"],
  ];
  for (const [argv, what] of cases) refused(agent(home, argv), "E_BAD_ARGS", what);
  assert.equal(fileOf(home), before, "nothing was written");
  ok(agent(home, ["set", "k", "--label", "x".repeat(40), "--value", "é".repeat(80), "--unit", "x".repeat(16), "--link", `https://example.com/${"x".repeat(492)}`]), "every bound exactly");
});

test("the bounds: 12 facts, 9 open questions, and the 8 KiB row are E_BOARD_FULL; a refusal writes nothing", async () => {
  const home = await freshHome();
  for (let i = 0; i < 12; i++) ok(agent(home, ["set", `f${i}`, "--label", "l", "--value", "v"]), `fact ${i}`);
  let before = fileOf(home);
  refused(agent(home, ["set", "f12", "--label", "l", "--value", "v"]), "E_BOARD_FULL", "a 13th fact");
  assert.equal(fileOf(home), before);
  ok(agent(home, ["set", "f0", "--label", "l", "--value", "w"]), "an update at 12 still goes");
  for (let i = 0; i < 9; i++) ok(agent(home, ["ask", `Q${i}?`, "--option", "a", "--option", "b"]), `question ${i}`);
  before = fileOf(home);
  refused(agent(home, ["ask", "A tenth?", "--option", "a", "--option", "b"]), "E_BOARD_FULL", "a 10th question");
  assert.equal(fileOf(home), before);

  // The row bound: wide characters fill 8 KiB long before the counts do.
  const wide = await freshHome();
  let full = null;
  for (let i = 0; i < 12 && !full; i++) {
    const r = agent(wide, ["set", `w${i}`, "--label", "界".repeat(40), "--value", "界".repeat(80), "--unit", "界".repeat(16), "--link", `https://example.com/${"x".repeat(492)}`]);
    if (r.status !== 0) full = { i, error: refused(r, "E_BOARD_FULL", `wide fact ${i}`) };
  }
  assert.ok(full, "the row bound refuses before 12 wide facts");
  assert.equal(full.error.details.max, ROW_MAX);
  assert.ok(full.error.details.bytes > ROW_MAX);
  const row = statusRow(wide).board;
  assert.ok(Buffer.byteLength(JSON.stringify(row), "utf8") <= ROW_MAX, "the row is within its bound");
  assert.equal(row.facts.length, full.i);
});

test("questions are per session: a launched, restarted or stopped boundary ends them, and the next write drops them; facts persist", async () => {
  const home = await freshHome();
  ok(agent(home, ["set", "pr", "--label", "Pull request", "--value", "#1"]), "a fact");
  ok(agent(home, ["ask", "Squash?", "--option", "yes", "--option", "no"]), "a question");
  assert.equal(statusRow(home).board.questions.length, 1);
  for (const kind of ["restarted", "stopped", "launched"]) {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(appendEvent(home, { kind }).ok, true);
    const row = statusRow(home).board;
    assert.deepEqual(row.questions, [], `after ${kind}: no question`);
    assert.deepEqual(row.facts.map((f) => f.key), ["pr"], `after ${kind}: the fact stays`);
    assert.equal(readEvents(home).waitingOnYou, null, `after ${kind}: no claim`);
    await new Promise((r) => setTimeout(r, 5));
    const again = ok(agent(home, ["ask", "Squash now?", "--option", "yes", "--option", "no"]), `ask after ${kind}`);
    assert.deepEqual(again.board.questions.map((q) => q.question), ["Squash now?"], "the ended session's question is dropped");
    assert.equal(readBoardDocument(home).questions.length, 1, "and is gone from the file");
    assert.equal(readEvents(home).waitingOnYou.message, "Squash now?");
  }
});

test("reads: no file is null; a malformed, linked, oversize or foreign file is an empty board, never an error; an unreadable record admits no question; the file is kernel-owned", async () => {
  const home = await freshHome();
  const file = join(home, BOARD_FILE);
  assert.equal(readBoardRow(home), null);
  const empty = { facts: [], questions: [] };
  for (const [bytes, what] of [["{", "not JSON"], ["[]", "not an object"], [JSON.stringify({ boardApi: 2, facts: {}, questions: [] }), "another boardApi"],
    [JSON.stringify({ boardApi: 1, facts: { Bad: { label: "l", value: "v", unit: null, link: null, at: "2026-11-19T00:00:00.000Z", seq: 0, history: [{ value: "v", at: "2026-11-19T00:00:00.000Z" }] } }, questions: [] }), "a key out of its rule"],
    [JSON.stringify({ boardApi: 1, facts: {}, questions: [{ id: "q1", question: "Q?", options: ["only"], context: null, since: "2026-11-19T00:00:00.000Z" }] }), "a question with one option"],
    ["x".repeat(300 * 1024), "over the file bound"]]) {
    writeFileSync(file, bytes);
    assert.deepEqual(readBoardRow(home), empty, what);
    assert.deepEqual(statusRow(home).board, empty, `${what}: on the row`);
  }
  rmSync(file);
  const elsewhere = join(fx.base, "board-elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify({ boardApi: 1, facts: {}, questions: [] }));
  symlinkSync(elsewhere, file);
  assert.deepEqual(readBoardRow(home), empty, "a link is never followed");
  ok(agent(home, ["set", "k", "--label", "l", "--value", "v"]), "a write replaces the link with a board");
  assert.equal(statSync(file).isFile(), true);
  assert.equal(readFileSync(elsewhere, "utf8"), JSON.stringify({ boardApi: 1, facts: {}, questions: [] }), "the link's target is untouched");
  ok(agent(home, ["ask", "Q?", "--option", "a", "--option", "b"]), "a question");
  const record = readFileSync(join(home, "instance.json"), "utf8");
  writeFileSync(join(home, "instance.json"), "{");
  assert.deepEqual(readBoardRow(home).questions, [], "no readable instance.json: no question, as no claim");
  writeFileSync(join(home, "instance.json"), record);
  assert.equal(disposableHomeRootProblem(BOARD_FILE), "kernel-owned");
  assert.equal(disposableHomeRootProblem(".oats-board.lock"), "kernel-owned");
  assert.ok(KERNEL_HOME_RECEIPTS.has(BOARD_FILE), "retire never counts the board as work");
});

test("parallel writes of one agent lose none", async () => {
  const home = await freshHome();
  const env = { ...fx.env, TMUX: "", OATS_INSTANCE_HOME: home };
  delete env.TMUX;
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "instance", "board", ...args, "--json"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i % 2 ? ["set", `k${i}`, "--label", "l", "--value", `${i}`] : ["ask", `Q${i}?`, "--option", "a", "--option", "b"])));
  for (const r of results) assert.equal(r.code, 0, r.out);
  const doc = readBoardDocument(home);
  assert.deepEqual(doc.facts.map((f) => f.key).sort(), ["k1", "k3", "k5", "k7"]);
  assert.deepEqual(doc.questions.map((q) => q.id).sort(), ["q1", "q2", "q3", "q4"]);
  assert.equal(readEvents(home).waitingOnYou.producer, "oats.board");
});

test("refused with --home, --dir or --server, and outside an instance home", async () => {
  const home = await freshHome();
  for (const flag of ["--home", "--dir", "--server"]) {
    const e = refused(agent(home, ["set", "k", "--label", "l", "--value", "v", flag, home]), "E_BAD_ARGS", flag);
    assert.match(e.message, new RegExp(`has no ${flag}`));
  }
  for (const value of [undefined, "relative/home", join(fx.base, "not-a-home")]) {
    if (value) mkdirSync(join(fx.base, "not-a-home"), { recursive: true });
    const e = refused(agent(home, ["ask", "Q?", "--option", "a", "--option", "b"], { OATS_INSTANCE_HOME: value }), "E_USAGE", `OATS_INSTANCE_HOME ${value}`);
    assert.match(e.message, /runs inside an instance session/);
  }
  refused(agent(home, ["pin", "k"]), "E_BAD_ARGS", "an unknown verb");
});

test("readRemoteBoard: a host's board read by this kernel's rule; null stays null; anything out of it is an empty board", () => {
  const at = "2026-11-19T10:00:00.000Z";
  const board = { facts: [{ key: "pr", label: "PR", value: "#1", unit: null, link: "https://example.com/1", at }], questions: [{ id: "q1", question: "Q?", options: ["a", "b"], hasContext: true, since: at }] };
  assert.deepEqual(readRemoteBoard(board), board);
  assert.equal(readRemoteBoard(null), null);
  const empty = { facts: [], questions: [] };
  for (const bad of [undefined, "x", [], { facts: [] }, { ...board, facts: [{ ...board.facts[0], link: "javascript:alert(1)" }] }, { ...board, questions: [{ ...board.questions[0], hasContext: "yes" }] },
    { ...board, facts: [board.facts[0], board.facts[0]] }, { ...board, facts: [{ ...board.facts[0], key: undefined }] }, { facts: Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: "界".repeat(40), value: "界".repeat(80), unit: "界".repeat(16), link: `https://example.com/${"x".repeat(492)}`, at })), questions: [] }]) {
    assert.deepEqual(readRemoteBoard(bad), empty, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(boardRow({ facts: [], questions: [] }), empty);
});
