// Feature waiting-on-you: producers record "this instance needs input from a human" as `waiting`
// events (`oats instance waiting`, `oats instance attention`); the claim is live only after the
// incarnation's latest kernel session boundary, and status rows and session inspect carry it for a
// running instance. Real tmux servers on private sockets for the running rows.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, liveWaiting, readEvents, recordStartBoundary, setWaiting, validWaitingMessage, EVENT_KINDS } from "../lib/instance-events.mjs";
import { fingerprintTree } from "../lib/core.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

// ---- unit: the writer, the reader and the boundary rule, on a bare home ----
function bare(t) {
  // The real path: rows are keyed by it (the symlink spellings are test/instance-waiting-symlink.test.mjs).
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-waiting-"))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "agents"), home = join(root, "dev", "instances", "dev-1");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", createdAt: "2026-01-01T00:00:00.000Z" }));
  const rows = (file = join(home, ".oats-events.jsonl")) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { base, root, home, rows, wsLog: join(base, ".agents", "events", "dev--dev-1.jsonl") };
}
const code = (c) => (e) => e.code === c;

test("waiting is an event kind; set appends ONE row to both logs and is idempotent; clear appends only over a live positive claim", (t) => {
  const w = bare(t);
  assert.ok(EVENT_KINDS.includes("waiting"));
  const first = setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "permission" });
  assert.equal(first.changed, true); assert.equal(first.eventsApi, 2); assert.equal(first.instance, "dev-1"); assert.equal(first.home, w.home); assert.equal(first.producer, "oats.core");
  assert.deepEqual(first.waitingOnYou, { since: first.waitingOnYou.since, producer: "oats.core", reason: "permission", message: null });
  for (const file of [join(w.home, ".oats-events.jsonl"), w.wsLog]) {
    const r = w.rows(file); assert.equal(r.length, 1, file);
    assert.equal(r[0].kind, "waiting"); assert.equal(r[0].producer, "oats.core"); assert.deepEqual(r[0].data, { waitingOnYou: true, reason: "permission" });
  }
  const again = setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "permission" });
  assert.equal(again.changed, false); assert.equal(again.waitingOnYou.since, first.waitingOnYou.since); assert.equal(w.rows().length, 1, "an identical set appends nothing");
  // A different reason, then a message, is a change; the same message again is not.
  assert.equal(setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "question" }).changed, true);
  assert.equal(setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "question", message: "which branch?" }).changed, true);
  assert.equal(setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "question", message: "which branch?" }).changed, false);
  assert.equal(w.rows().length, 3);
  // Events reflect it unchanged in shape, message included.
  const ev = readEvents(w.home);
  assert.deepEqual(ev.waitingOnYou, { since: ev.events.at(-1).at, producer: "oats.core", reason: "question", message: "which branch?" });
  assert.deepEqual(ev.waitingClaims, [{ producer: "oats.core", waiting: true, since: ev.events.at(-1).at, reason: "question", message: "which branch?" }]);
  // Clear: once over the positive claim, then nothing.
  const cleared = setWaiting(w.home, { producer: "oats.core", waiting: false });
  assert.equal(cleared.changed, true); assert.equal(cleared.waitingOnYou, null); assert.deepEqual(w.rows().at(-1).data, { waitingOnYou: false });
  assert.equal(setWaiting(w.home, { producer: "oats.core", waiting: false }).changed, false); assert.equal(w.rows().length, 4);
  assert.equal(setWaiting(w.home, { producer: "never.set", waiting: false }).changed, false, "a producer with no claim: clear appends nothing");
  assert.equal(w.rows().length, 4);
  // Producers are independent: a clear by one never touches another's claim.
  setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "need the npm token" });
  setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "permission" });
  setWaiting(w.home, { producer: "oats.core", waiting: false });
  assert.deepEqual(liveWaiting(w.home), { since: liveWaiting(w.home).since, producer: "agent", reason: "attention", message: "need the npm token" });
});

test("the writer's refusals: producer grammar and kernel reserved, the closed reason set, --reason and --message refused on clear, a home without instance.json", (t) => {
  const w = bare(t);
  for (const producer of [undefined, "", "Upper", "-lead", "a b", "x".repeat(65), "kernel"]) assert.throws(() => setWaiting(w.home, { producer, waiting: true, reason: "permission" }), code("E_BAD_ARGS"), String(producer));
  assert.equal(setWaiting(w.home, { producer: "a/b-c.d_e", waiting: true, reason: "permission" }).changed, true, "the grammar admits . _ / -");
  assert.equal(setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention" }).changed, true, "agent stays allowed: attention is defined as that call");
  for (const reason of [undefined, "idle", "Permission", ""]) assert.throws(() => setWaiting(w.home, { producer: "p", waiting: true, reason }), code("E_BAD_ARGS"), String(reason));
  assert.throws(() => setWaiting(w.home, { producer: "p", waiting: false, reason: "permission" }), code("E_BAD_ARGS"));
  assert.throws(() => setWaiting(w.home, { producer: "p", waiting: false, message: "x" }), code("E_BAD_ARGS"));
  assert.throws(() => setWaiting(join(w.base, "nowhere"), { producer: "p", waiting: true, reason: "question" }), code("E_SESSION_UNKNOWN"));
});

test("message validation: 200 characters OK, 201 refused; control characters, line separators, bidi controls, U+200B, U+2060, U+FEFF, tag characters and non-strings refused; ZWJ, ZWNJ, LRM, RLM, ALM and soft hyphen allowed", (t) => {
  const w = bare(t);
  assert.equal(validWaitingMessage("x".repeat(200)), true);
  assert.equal(validWaitingMessage("é".repeat(200)), true, "characters, not bytes");
  assert.equal(validWaitingMessage("👩‍💻".repeat(66)), true, "code points: 66 ZWJ sequences of 3 are 198");
  assert.equal(validWaitingMessage("x".repeat(201)), false);
  for (const bad of ["", "a\nb", "a\rb", "a\tb", "a\u001b[31mb", "a\u007fb", "a\u0085b", "a\u009bb", "a\u2028b", "a\u2029b", 42, null, {}, ["x"]]) {
    assert.equal(validWaitingMessage(bad), false, JSON.stringify(bad));
    if (typeof bad === "string" || bad === 42) assert.throws(() => setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: bad }), code("E_BAD_ARGS"), JSON.stringify(bad));
  }
  // The maintainer's refused set: every bidi embedding, override and isolate, the
  // invisible hiders, and the tag characters (first, a letter, last).
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x2060, 0xfeff, 0xe0000, 0xe0041, 0xe007f]) {
    const c = String.fromCodePoint(cp), bad = `pay ${c}evil${c} now`;
    assert.equal(validWaitingMessage(bad), false, `U+${cp.toString(16).toUpperCase()}`);
    assert.throws(() => setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: bad }), (e) => e.code === "E_BAD_ARGS" && /--message/.test(e.message), `U+${cp.toString(16)}`);
  }
  // Everything else is allowed: ZWJ and ZWNJ (emoji sequences, Persian), LRM, RLM, ALM,
  // the soft hyphen, and characters just outside the refused ranges.
  const allowed = ["need the npm token from Alex", "¿listo? ✓ — 日本語 🚀", "שלום world", "👩‍💻 review needed", "می‌خواهم", "a\u200cb", "a\u200db", "a\u200eb", "a\u200fb", "a\u061cb", "a\u00adb", "a\u2065b", "a\u206ab", "a\u{e0080}b"];
  for (const ok of allowed) assert.equal(validWaitingMessage(ok), true, JSON.stringify(ok));
  assert.equal(w.rows().length, 0, "a refused message appends nothing");
  setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "👩‍💻 می‌خواهم" });
  assert.equal(liveWaiting(w.home).message, "👩‍💻 می‌خواهم", "a ZWJ and a ZWNJ message is stored and read back");
});

test("the reader re-validates a stored message and reason: an invalid one (a hand-edited log) reads as null and the claim still counts", (t) => {
  const w = bare(t);
  const row = (data, at) => appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at, instance: "dev-1", home: w.home, incarnation: "2026-01-01T00:00:00.000Z", producer: "agent", kind: "waiting", data }) + "\n");
  row({ waitingOnYou: true, reason: "attention", message: "line one\nline two" }, "2026-01-01T00:00:01.000Z");
  assert.deepEqual(liveWaiting(w.home), { since: "2026-01-01T00:00:01.000Z", producer: "agent", reason: "attention", message: null });
  assert.equal(readEvents(w.home).waitingClaims[0].message, null);
  row({ waitingOnYou: true, reason: "attention\u001b[2J", message: "x".repeat(201) }, "2026-01-01T00:00:02.000Z");
  assert.deepEqual(liveWaiting(w.home), { since: "2026-01-01T00:00:02.000Z", producer: "agent", reason: null, message: `${"x".repeat(199)}…` }, "a reason that would print a control character reads as null too; a message over 200 is cut");
  row({ waitingOnYou: true, reason: "attention", message: "pay \u202eexe.txt" }, "2026-01-01T00:00:03.000Z");
  assert.deepEqual(liveWaiting(w.home), { since: "2026-01-01T00:00:03.000Z", producer: "agent", reason: "attention", message: null }, "a stored bidi control reads as null");
  assert.equal(readEvents(w.home).waitingClaims[0].message, null);
  for (const [i, bad] of ["hid\u200Bden", "tag\u{E0041}ged"].entries()) {
    const at = `2026-01-01T00:00:03.${100 + i}Z`;
    row({ waitingOnYou: true, reason: "attention", message: bad }, at);
    assert.deepEqual(liveWaiting(w.home), { since: at, producer: "agent", reason: "attention", message: null }, `a stored ${JSON.stringify(bad)} reads as null`);
  }
  row({ waitingOnYou: true, reason: "attention", message: "zw\u200Cnj \u200Fmark" }, "2026-01-01T00:00:03.500Z");
  assert.equal(liveWaiting(w.home).message, "zw\u200Cnj \u200Fmark", "a stored ZWNJ and RLM read as given");
  row({ waitingOnYou: true, reason: "review requested" }, "2026-01-01T00:00:04.000Z");
  assert.equal(liveWaiting(w.home).reason, null, "a reason outside permission | question | attention reads as null");
});

test("the reader cuts a stored message over 200 code points to 200, the last one …, for every producer and every old row; one of 200 reads as it is; the cut counts code points, so a surrogate pair is never split", (t) => {
  const w = bare(t);
  const row = (producer, message, at) => appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at, instance: "dev-1", home: w.home, incarnation: "2026-01-01T00:00:00.000Z", producer, kind: "waiting", data: { waitingOnYou: true, reason: "attention", message } }) + "\n");
  const read = () => { const live = liveWaiting(w.home).message; assert.equal(readEvents(w.home).waitingOnYou.message, live, "instance events read the same"); return live; };
  const cases = [
    ["250 letters", "a".repeat(250), `${"a".repeat(199)}…`],
    ["exactly 200", "b".repeat(200), "b".repeat(200)],
    ["250 emoji, each a surrogate pair", "😀".repeat(250), `${"😀".repeat(199)}…`],
    ["200 emoji", "😀".repeat(200), "😀".repeat(200)],
    ["base letters and combining marks, 300 code points", "e\u0301".repeat(150), `${"e\u0301".repeat(99)}e…`],
  ];
  cases.forEach(([what, message, expected], i) => {
    row(i % 2 ? "oats.core" : "agent", message, `2026-01-01T00:00:0${i + 1}.000Z`);
    const got = read();
    assert.equal(got, expected, what);
    assert.ok([...got].length <= 200, `${what}: at most 200 code points`);
    assert.equal(validWaitingMessage(got), true, `${what}: what the reader gives is a message the writer accepts`);
  });
  // A refused character anywhere, even past the cut, makes it no message (a home of its own: with
  // the claims above, the newest with text would be shown in its place).
  const v = bare(t);
  appendFileSync(join(v.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at: "2026-01-01T00:00:09.000Z", instance: "dev-1", home: v.home, incarnation: "2026-01-01T00:00:00.000Z", producer: "agent", kind: "waiting", data: { waitingOnYou: true, reason: "attention", message: `${"c".repeat(250)}\u001b` } }) + "\n");
  assert.equal(liveWaiting(v.home).message, null, "a refused character makes it no message, however long");
  assert.equal(readEvents(v.home).waitingClaims[0].message, null);
});

test("a claim with no text never hides one with text (#1502): the newest claim with a message is shown, a text-less claim only fills its missing reason, and without any text the newest claim is shown", (t) => {
  const w = bare(t);
  const row = (producer, data, at) => appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at, instance: "dev-1", home: w.home, incarnation: "2026-01-01T00:00:00.000Z", producer, kind: "waiting", data }) + "\n");
  const both = (expected, why) => { assert.deepEqual(liveWaiting(w.home), expected, why); assert.deepEqual(readEvents(w.home).waitingOnYou, expected, `${why} (instance events)`); };
  const question = { since: "2026-01-01T00:00:01.000Z", producer: "agent", reason: "attention", message: "yes/no on upgrading Claude Code?" };
  row("agent", { waitingOnYou: true, reason: "attention", message: question.message }, question.since);
  row("oats.core", { waitingOnYou: true, reason: "permission" }, "2026-01-01T00:00:05.000Z");
  both(question, "the agent's question stands over a later text-less permission claim");
  assert.equal(readEvents(w.home).waitingClaims.length, 2, "both claims are still listed");
  row("oats.core", { waitingOnYou: true, reason: "permission", message: "Claude needs your permission to use Bash" }, "2026-01-01T00:00:06.000Z");
  both({ since: "2026-01-01T00:00:06.000Z", producer: "oats.core", reason: "permission", message: "Claude needs your permission to use Bash" }, "among claims with text, the newest is shown");
  row("oats.core", { waitingOnYou: false }, "2026-01-01T00:00:07.000Z");
  both(question, "the permission cleared: the question is shown again");
  // A claim with text whose stored reason reads as null takes the reason of the newest text-less claim.
  row("provider.x", { waitingOnYou: true, reason: "review requested", message: "review PR 42" }, "2026-01-01T00:00:08.000Z");
  row("oats.core", { waitingOnYou: true, reason: "question" }, "2026-01-01T00:00:09.000Z");
  both({ since: "2026-01-01T00:00:08.000Z", producer: "provider.x", reason: "question", message: "review PR 42" }, "the text-less claim adds only the reason the shown claim lacks");
  // No claim with text: the newest one is shown, as before.
  for (const p of ["agent", "provider.x"]) row(p, { waitingOnYou: false }, "2026-01-01T00:00:10.000Z");
  row("agent", { waitingOnYou: true, reason: "attention" }, "2026-01-01T00:00:11.000Z");
  both({ since: "2026-01-01T00:00:11.000Z", producer: "agent", reason: "attention", message: null }, "with no text anywhere, the newest claim is shown");
});

test("the reader admits a claim only from `kernel` or a valid producer id: a hand-edited producer is no claim at all", (t) => {
  const w = bare(t);
  const row = (producer, data, at) => appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at, instance: "dev-1", home: w.home, incarnation: "2026-01-01T00:00:00.000Z", producer, kind: "waiting", data }) + "\n");
  const claim = { waitingOnYou: true, reason: "attention", message: "x" };
  ["Bad Producer!", "evil\u001b[2J", "agent\nkernel", "", "-dash", "x".repeat(65), 42, ["agent"], { id: "agent" }].forEach((p, i) => row(p, claim, `2026-01-01T00:00:0${i}.000Z`));
  assert.equal(liveWaiting(w.home), null, "none of them is a claim");
  assert.deepEqual(readEvents(w.home).waitingClaims, []);
  row("oats.core", { waitingOnYou: true, reason: "permission" }, "2026-01-01T00:00:10.000Z");
  assert.deepEqual(liveWaiting(w.home), { since: "2026-01-01T00:00:10.000Z", producer: "oats.core", reason: "permission", message: null }, "a valid producer's claim counts");
  // A bad producer's clear does not clear anyone either.
  row("Bad Producer!", { waitingOnYou: false }, "2026-01-01T00:00:11.000Z");
  assert.equal(liveWaiting(w.home).producer, "oats.core");
});

test("the reader validates a claim's time too: a waiting row whose `at` is not a date (a hand-edited log) is no claim, and its clear clears nothing", (t) => {
  const w = bare(t);
  const row = (producer, data, at) => appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at, instance: "dev-1", home: w.home, incarnation: "2026-01-01T00:00:00.000Z", producer, kind: "waiting", data }) + "\n");
  // Each sorts after every real time, so it would be the latest claim if it counted.
  for (const at of ["not a date", "soon", "2026-13-45T99:00:00.000Z", "\u001b[2J"]) row("agent", { waitingOnYou: true, reason: "attention", message: "x" }, at);
  assert.equal(liveWaiting(w.home), null, "none of them is a claim");
  assert.deepEqual(readEvents(w.home).waitingClaims, []);
  assert.equal(readEvents(w.home).waitingOnYou, null);
  assert.equal(setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention" }).changed, true, "the writer sees no live claim, and records one");
  const since = liveWaiting(w.home).since;
  assert.ok(Number.isFinite(Date.parse(since)));
  row("agent", { waitingOnYou: false }, "zzz");
  assert.deepEqual(liveWaiting(w.home), { since, producer: "agent", reason: "attention", message: null }, "a clear with no valid time clears nothing");
});

test("boundary rule: a claim older than the incarnation's latest kernel launched | restarted | stopped row is not live; a producer's own 'launched' row is not a boundary", (t) => {
  for (const kind of ["launched", "restarted", "stopped"]) {
    const w = bare(t);
    setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "permission" });
    assert.ok(liveWaiting(w.home));
    appendEvent(w.home, { kind, producer: "provider.x" }); // not the kernel: no boundary
    assert.ok(liveWaiting(w.home), `${kind} by a provider is not a boundary`);
    appendEvent(w.home, { kind, data: { phase: "start" } });
    assert.equal(liveWaiting(w.home), null, `a kernel ${kind} voids the earlier claim`);
    const ev = readEvents(w.home);
    assert.equal(ev.waitingOnYou, null); assert.deepEqual(ev.waitingClaims, [], "the voided claim is not listed");
    assert.ok(ev.events.some((e) => e.kind === "waiting"), "the row is still history");
    // After the boundary the claim is gone, so a clear appends nothing and a set appends again.
    assert.equal(setWaiting(w.home, { producer: "oats.core", waiting: false }).changed, false);
    assert.equal(setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "permission" }).changed, true);
    assert.ok(liveWaiting(w.home), "a claim after the boundary is live");
  }
  // An earlier incarnation's boundary does not void the current incarnation's claim.
  const w = bare(t);
  appendEvent(w.home, { kind: "stopped" }, { incarnation: "2025-01-01T00:00:00.000Z" });
  setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "question" });
  appendEvent(w.home, { kind: "launched" }, { incarnation: "2025-01-01T00:00:00.000Z" });
  assert.ok(liveWaiting(w.home));
});

test("rows that repeat within one log all count, even in the same millisecond; the same row in both logs counts once (a multiset union)", (t) => {
  const T = "2026-02-01T00:00:00.000Z";
  const set = { kind: "waiting", producer: "oats.core", data: { waitingOnYou: true, reason: "permission" } };
  const clear = { kind: "waiting", producer: "oats.core", data: { waitingOnYou: false } };
  const waitingRows = (ev) => ev.events.filter((e) => e.kind === "waiting").map((e) => e.data.waitingOnYou);
  // set, clear, set at one instant, written to both logs: three rows, and the claim is live.
  const w = bare(t);
  for (const e of [set, clear, set]) appendEvent(w.home, e, { at: T });
  assert.deepEqual(waitingRows(readEvents(w.home)), [true, false, true], "both logs hold all three: each counts once, in order");
  assert.equal(liveWaiting(w.home)?.since, T, "the repeated set is not mistaken for a copy of the first");
  assert.equal(readEvents(w.home).waitingOnYou?.producer, "oats.core");
  // One log holds a row twice and the other once: it counts twice. A row only in the other log counts once.
  const v = bare(t);
  const line = (e) => JSON.stringify({ eventsApi: 2, at: T, instance: "dev-1", home: v.home, incarnation: "2026-01-01T00:00:00.000Z", producer: e.producer, kind: e.kind, data: e.data }) + "\n";
  mkdirSync(dirname(v.wsLog), { recursive: true });
  writeFileSync(join(v.home, ".oats-events.jsonl"), line(set) + line(set));
  writeFileSync(v.wsLog, line(set) + line(clear));
  assert.deepEqual(waitingRows(readEvents(v.home)), [true, true, false], "max(2, 1) copies of the set, and the clear the home log lacks");
});

test("a write either log refuses is E_EVENTS_FAILED naming it, and the next call repairs that log rather than trusting the other", (t) => {
  for (const which of ["home", "workspace"]) {
    const w = bare(t);
    const file = which === "home" ? join(w.home, ".oats-events.jsonl") : w.wsLog;
    const blocked = (fn) => { const saved = readFileSync(file); rmSync(file); mkdirSync(file); try { fn(); } finally { rmSync(file, { recursive: true }); writeFileSync(file, saved); } };
    setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "need a token" });
    // A clear that reaches only the other log.
    blocked(() => assert.throws(() => setWaiting(w.home, { producer: "agent", waiting: false }), (e) => e.code === "E_EVENTS_FAILED" && e.message.includes(file), which));
    const retry = setWaiting(w.home, { producer: "agent", waiting: false });
    assert.equal(retry.changed, true, `${which}: the retry repairs the log that missed the clear`);
    assert.equal(liveWaiting(w.home), null, which); assert.equal(readEvents(w.home).waitingOnYou, null, which);
    assert.equal(setWaiting(w.home, { producer: "agent", waiting: false }).changed, false, `${which}: then it is idempotent again`);
    // A set that reaches only the other log.
    blocked(() => assert.throws(() => setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "again" }), (e) => e.code === "E_EVENTS_FAILED", which));
    assert.equal(setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "again" }).changed, true, `${which}: the retry repairs the set`);
    assert.equal(liveWaiting(w.home)?.message, "again", which); assert.equal(readEvents(w.home).waitingOnYou?.message, "again", which);
    assert.equal(setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "again" }).changed, false, which);
  }
});

test("a start boundary either log refuses is reported incomplete; the next call copies the SAME row (time, data) into that log only, without duplicating it in the other or voiding a newer claim", (t) => {
  for (const which of ["home", "workspace"]) {
    const w = bare(t);
    const file = which === "home" ? join(w.home, ".oats-events.jsonl") : w.wsLog;
    const other = which === "home" ? w.wsLog : join(w.home, ".oats-events.jsonl");
    // The ended session's claim, in both logs, before the start.
    appendEvent(w.home, { kind: "waiting", producer: "oats.core", data: { waitingOnYou: true, reason: "permission" } }, { at: "2026-01-02T00:00:00.000Z" });
    const startedAt = "2026-01-03T00:00:00.000Z";
    const receipt = { startId: "s-1", startedAt, harness: "claude", backend: "tmux", launchConfig: null, phase: "start" };
    const boundaries = (f) => w.rows(f).filter((r) => r.kind === "launched" && r.data?.startId === "s-1");
    const saved = readFileSync(file); rmSync(file); mkdirSync(file);
    const partial = recordStartBoundary(w.home, receipt);
    assert.equal(partial.ok, false, `${which}: partial evidence is not reported complete`);
    assert.equal(partial.existed, undefined, which);
    rmSync(file, { recursive: true }); writeFileSync(file, saved);
    assert.equal(boundaries(file).length, 0, which); assert.equal(boundaries(other).length, 1, which);
    // The new session claims before the start is recovered.
    setWaiting(w.home, { producer: "agent", waiting: true, reason: "attention", message: "newer" });
    const repaired = recordStartBoundary(w.home, { ...receipt, phase: "recovered" });
    assert.equal(repaired.ok, true, which); assert.equal(repaired.repaired, true, which);
    assert.deepEqual(boundaries(file), boundaries(other), `${which}: the copy is the original row`);
    assert.equal(boundaries(file)[0].at, startedAt, which); assert.equal(boundaries(file)[0].data.phase, "start", which);
    assert.equal(boundaries(other).length, 1, `${which}: the complete log gets no duplicate`);
    for (const view of [liveWaiting(w.home), readEvents(w.home).waitingOnYou]) assert.equal(view?.message, "newer", `${which}: the older claim is voided, the newer one kept`);
    const homeLog = readFileSync(join(w.home, ".oats-events.jsonl"));
    rmSync(join(w.home, ".oats-events.jsonl"));
    assert.equal(liveWaiting(w.home)?.message, "newer", `${which}: the workspace log alone says the same`);
    writeFileSync(join(w.home, ".oats-events.jsonl"), homeLog);
    const counts = () => [w.rows().length, w.rows(w.wsLog).length];
    const before = counts();
    assert.deepEqual(recordStartBoundary(w.home, receipt), { ok: true, existed: true }, `${which}: then it is complete`);
    assert.deepEqual(counts(), before, which);
  }
});

test("liveWaiting reads the home log, and the workspace log only when the home log is absent; a home with no instance.json is null", (t) => {
  const w = bare(t);
  setWaiting(w.home, { producer: "oats.core", waiting: true, reason: "permission" });
  rmSync(join(w.home, ".oats-events.jsonl"));
  assert.equal(liveWaiting(w.home)?.producer, "oats.core", "the workspace log answers when the home log is absent");
  rmSync(join(w.home, "instance.json"));
  assert.equal(liveWaiting(w.home), null);
});

test("retirement fingerprint: an instance home ignores exactly its .claude/settings.json (harness project settings are configuration, not work); any other change, or the same path in another tree, still counts", (t) => {
  const w = bare(t);
  mkdirSync(join(w.home, ".claude"));
  const fp = (tree = w.home, instanceHome = true) => fingerprintTree(tree, { excludeRoot: new Set(["work"]), instanceHome });
  const before = fp(), plainBefore = fp(w.home, false);
  writeFileSync(join(w.home, ".claude", "settings.json"), "{}\n");
  assert.equal(fp(), before, "the home's harness project settings are not the instance's work");
  assert.notEqual(fp(w.home, false), plainBefore, "outside an instance-home fingerprint they are bytes like any other");
  writeFileSync(join(w.home, ".claude", "settings.local.json"), "{}\n");
  assert.notEqual(fp(), before, "a sibling file in .claude counts");
  rmSync(join(w.home, ".claude", "settings.local.json"));
  writeFileSync(join(w.home, ".oats-waiting-claude"), "");
  assert.notEqual(fp(), before, "no capability's private file is excluded");
  rmSync(join(w.home, ".oats-waiting-claude"));
  mkdirSync(join(w.home, "sub", ".claude"), { recursive: true }); writeFileSync(join(w.home, "sub", ".claude", "settings.json"), "{}\n");
  assert.notEqual(fp(), before, "only the home-relative path is excluded");
});

// ---- the CLI, status rows and session inspect, on a deployment with real tmux ----
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-waiting-cli-")));
const sock = join(base, "agents.sock");
const tmux = (...args) => execFileSync("tmux", ["-f", "/dev/null", "-u", "-S", sock, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const fx = v2Deployment();
test.after(() => { try { tmux("kill-server"); } catch { /* gone */ } rmSync(base, { recursive: true, force: true }); fx.cleanup(); });

/** A spawned home recorded as launched in oats-agents:<name> on the private socket. */
async function recordedHome(name) {
  const { home } = await fx.spawn("dev", { name });
  const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
  const tmuxRec = { session: "oats-agents", window: name, socket: sock };
  writeFileSync(join(home, "instance.json"), JSON.stringify({ ...meta, launched: true, tmux: tmuxRec }, null, 2) + "\n");
  const baselinePath = join(dirname(home), ".oats-retirement", "baselines", `${createHash("sha256").update(home).digest("hex")}.json`);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  writeFileSync(baselinePath, JSON.stringify({ ...baseline, runtime: { launched: true, tmux: tmuxRec } }, null, 2) + "\n", { mode: 0o600 });
  return home;
}
const cli = (args, env = {}, cwd) => { const r = fx.cli(args, { ...(cwd ? { cwd } : {}), env: { TMUX: undefined, OATS_INSTANCE_HOME: undefined, OATS_HOME: undefined, ...env } }); return { ...r, doc: (() => { try { return JSON.parse(r.stdout.trim().split("\n").pop()); } catch { return null; } })() }; };
const statusRows = () => Object.fromEntries(JSON.parse(cli(["status", "--json"]).stdout).agents.flatMap((a) => a.instances).map((i) => [i.instance, i]));

test("CLI: waiting set/clear answer and idempotency; status rows carry waitingOnYou only while running; session inspect carries it beside an unchanged state; plain status shows the marker; attention is the agent's sugar", async () => {
  tmux("new-session", "-d", "-s", "oats-agents", "-n", "w-run", "sleep 600");
  const run = await recordedHome("w-run"), idle = await recordedHome("w-idle");
  let rows = statusRows();
  assert.equal(rows["w-run"].running, true); assert.equal(rows["w-run"].waitingOnYou, null, "running, no claim: null");
  assert.equal(rows["w-idle"].running, false); assert.equal(rows["w-idle"].waitingOnYou, null);

  const set = cli(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "permission", "--home", run, "--json"]);
  assert.equal(set.status, 0, set.stdout + set.stderr);
  assert.deepEqual(Object.keys(set.doc.result).sort(), ["changed", "eventsApi", "home", "instance", "producer", "waitingOnYou"]);
  assert.equal(set.doc.result.changed, true); assert.equal(set.doc.result.waitingOnYou.reason, "permission");
  assert.equal(cli(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "permission", "--home", run, "--json"]).doc.result.changed, false);
  assert.equal(readFileSync(join(run, ".oats-events.jsonl"), "utf8").trim().split("\n").filter((l) => JSON.parse(l).kind === "waiting").length, 1);
  // A claim on a stopped row never shows.
  assert.equal(cli(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "question", "--home", idle, "--json"]).doc.result.changed, true);

  rows = statusRows();
  assert.deepEqual(rows["w-run"].waitingOnYou, { since: set.doc.result.waitingOnYou.since, producer: "oats.core", reason: "permission", message: null });
  assert.equal(rows["w-idle"].waitingOnYou, null, "not running: null whatever the log says");
  const inspected = cli(["session", "inspect", "--home", run, "--json"]).doc.result;
  assert.equal(inspected.present, true); assert.equal(inspected.state, "unknown", "the state enum is unchanged");
  assert.equal(inspected.running, rows["w-run"].running, "inspect's running is the status row's");
  assert.equal(cli(["session", "inspect", "--home", idle, "--json"]).doc.result.running, false);
  assert.equal(inspected.waitingOnYou.producer, "oats.core");
  assert.equal(cli(["session", "inspect", "--home", idle, "--json"]).doc.result.waitingOnYou, null);

  // The agent's attention, from inside its session: shown on plain status with its message.
  const att = cli(["instance", "attention", "--message", "need the npm token from Alex", "--json"], { OATS_INSTANCE_HOME: run });
  assert.equal(att.status, 0, att.stdout + att.stderr);
  assert.deepEqual({ producer: att.doc.result.producer, changed: att.doc.result.changed, reason: att.doc.result.waitingOnYou.reason, message: att.doc.result.waitingOnYou.message }, { producer: "agent", changed: true, reason: "attention", message: "need the npm token from Alex" });
  const plain = cli(["status"]);
  assert.match(plain.stdout, /• w-run\s+RUNNING[^\n]*\n {10}! needs input \(attention\) since (?:[A-Z][a-z]{2} \d{1,2} |\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}, under a minute: need the npm token from Alex\n/, plain.stdout);
  assert.doesNotMatch(plain.stdout, /• w-idle[^\n]*\n {10}! needs input/, "no marker on a row that is not running");
  // The emitter-style clear of oats.core leaves the agent's claim; --clear clears it.
  cli(["instance", "waiting", "clear", "--producer", "oats.core", "--home", run, "--json"]);
  assert.equal(statusRows()["w-run"].waitingOnYou.producer, "agent");
  const clr = cli(["instance", "attention", "--clear", "--json"], { OATS_INSTANCE_HOME: run });
  assert.equal(clr.doc.result.changed, true); assert.equal(clr.doc.result.waitingOnYou, null);
  assert.equal(statusRows()["w-run"].waitingOnYou, null);
  // The home comes from $OATS_INSTANCE_HOME for waiting too, when --home is not given.
  assert.equal(cli(["instance", "waiting", "set", "--producer", "p", "--reason", "question", "--json"], { OATS_INSTANCE_HOME: run }).doc.result.home, run);

  // A kernel session boundary voids the claim on the status row.
  appendEvent(run, { kind: "launched", data: { harness: "claude", backend: "tmux", launchConfig: null, phase: "start" } });
  assert.equal(statusRows()["w-run"].waitingOnYou, null);
});

test("a kept window whose harness is gone (a crash's fallback shell, a retained dead pane) is not running and shows no claim, as session inspect does", async () => {
  tmux("new-window", "-d", "-t", "oats-agents:", "-n", "w-shell", "sh");
  tmux("set-option", "-g", "remain-on-exit", "on");
  tmux("new-window", "-d", "-t", "oats-agents:", "-n", "w-dead", "true");
  // Read once tmux has marked the pane dead: until then it answers the pane live while ps no longer
  // lists its process, which reads unknown (#1641).
  for (const deadline = Date.now() + 10000; tmux("display-message", "-p", "-t", "=oats-agents:=w-dead", "#{pane_dead}").trim() !== "1";) {
    assert.ok(Date.now() < deadline, "tmux marks w-dead's pane dead");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const shell = await recordedHome("w-shell"), dead = await recordedHome("w-dead");
  tmux("set-option", "-g", "remain-on-exit", "off");
  for (const home of [shell, dead]) setWaiting(home, { producer: "agent", waiting: true, reason: "attention", message: "old session question" });
  const rows = statusRows();
  for (const [name, home, state] of [["w-shell", shell, "shell"], ["w-dead", dead, "stopped"]]) {
    assert.equal(rows[name].running, false, `${name}: the window remains but the harness is gone`);
    if (state === "shell") assert.equal(rows[name].runtimeState, "shell");
    assert.equal(rows[name].waitingOnYou, null, `${name}: no harness, no claim`);
    const inspected = cli(["session", "inspect", "--home", home, "--json"]).doc.result;
    assert.equal(inspected.state, state); assert.equal(inspected.waitingOnYou, null);
    assert.equal(inspected.running, rows[name].running, `${name}: inspect's running is the status row's`);
  }
  assert.doesNotMatch(cli(["status"]).stdout, /old session question/);
});

test("both verbs work from a cwd outside the deployment: the scope is the agents root the home sits in, unless --dir names one", async () => {
  const home = await recordedHome("w-out");
  const outside = join(base, "outside"); mkdirSync(outside);
  const set = cli(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "permission", "--home", home, "--json"], {}, outside);
  assert.equal(set.doc?.ok, true, set.stdout + set.stderr); assert.equal(set.doc.result.changed, true);
  const att = cli(["instance", "attention", "--message", "from outside", "--json"], { OATS_INSTANCE_HOME: home }, outside);
  assert.equal(att.doc?.ok, true, att.stdout + att.stderr); assert.equal(att.doc.result.waitingOnYou.message, "from outside");
  const clr = cli(["instance", "waiting", "clear", "--producer", "oats.core", "--home", home, "--dir", fx.dep, "--json"], {}, outside);
  assert.equal(clr.doc?.ok, true, clr.stdout + clr.stderr); assert.equal(clr.doc.result.changed, true, "an explicit --dir still scopes it");
  const wrong = cli(["instance", "waiting", "clear", "--producer", "oats.core", "--home", home, "--dir", outside, "--json"], {}, outside);
  assert.equal(wrong.doc?.ok, false, "a --dir that is not a deployment is refused");
});

test("CLI refusals: attention needs $OATS_INSTANCE_HOME to be a home and has no --home; waiting validates its flags and its home; nothing routes to a server", async () => {
  const home = await recordedHome("w-ref");
  const err = (r) => r.doc?.error?.code;
  assert.equal(err(cli(["instance", "attention", "--json"])), "E_USAGE", "unset");
  assert.equal(err(cli(["instance", "attention", "--json"], { OATS_INSTANCE_HOME: join(base, "nope") })), "E_USAGE", "not a home");
  assert.equal(err(cli(["instance", "attention", "--json"], { OATS_INSTANCE_HOME: "relative/home" })), "E_USAGE");
  assert.equal(err(cli(["instance", "attention", "--home", home, "--json"], { OATS_INSTANCE_HOME: home })), "E_BAD_ARGS", "no --home flag");
  assert.equal(err(cli(["instance", "attention", "--clear", "--message", "x", "--json"], { OATS_INSTANCE_HOME: home })), "E_BAD_ARGS");
  assert.equal(err(cli(["instance", "attention", "--message", "a\tb", "--json"], { OATS_INSTANCE_HOME: home })), "E_BAD_ARGS");
  assert.match(cli(["instance", "attention", "--message", "x".repeat(201), "--json"], { OATS_INSTANCE_HOME: home }).doc.error.message, /--message/);
  const w = (...a) => err(cli(["instance", "waiting", ...a, "--json"]));
  assert.equal(w("set", "--producer", "kernel", "--reason", "permission", "--home", home), "E_BAD_ARGS");
  for (const verb of [["set", "--reason", "attention"], ["clear"]]) {
    const r = cli(["instance", "waiting", verb[0], "--producer", "agent", ...verb.slice(1), "--home", home, "--json"]);
    assert.equal(err(r), "E_BAD_ARGS", `waiting ${verb[0]} --producer agent`); assert.match(r.doc.error.message, /oats instance attention/);
  }
  assert.equal(w("set", "--producer", "oats.core", "--home", home), "E_BAD_ARGS", "--reason is required for set");
  assert.equal(w("set", "--producer", "oats.core", "--reason", "idle", "--home", home), "E_BAD_ARGS");
  assert.equal(w("clear", "--producer", "oats.core", "--reason", "permission", "--home", home), "E_BAD_ARGS");
  assert.equal(w("clear", "--producer", "oats.core", "--message", "x", "--home", home), "E_BAD_ARGS");
  assert.equal(w("toggle", "--producer", "oats.core", "--home", home), "E_BAD_ARGS");
  assert.equal(w("set", "--producer", "oats.core", "--reason", "permission", "--home", "relative"), "E_BAD_ARGS");
  const stray = join(base, "agents-x", "dev", "instances", "w-ref"); mkdirSync(stray, { recursive: true });
  assert.equal(w("set", "--producer", "oats.core", "--reason", "permission", "--home", stray), "E_SESSION_UNKNOWN", "no instance.json");
  assert.equal(err(cli(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "permission", "--home", home, "--server", "nowhere", "--json"])) !== undefined, true, "--server is refused (local only)");
  assert.equal(existsSync(join(home, ".oats-events.jsonl")) ? readFileSync(join(home, ".oats-events.jsonl"), "utf8").includes('"waiting"') : false, false, "no refusal wrote a claim");
});

test("a message may start with --: --message=<text> carries it (and is never read as a flag); the spaced form says so", async () => {
  const home = await recordedHome("w-dash");
  const set = cli(["instance", "attention", "--message=--deploy failed, need a hand", "--json"], { OATS_INSTANCE_HOME: home });
  assert.equal(set.doc?.ok, true, set.stdout + set.stderr); assert.equal(set.doc.result.waitingOnYou.message, "--deploy failed, need a hand");
  const notClear = cli(["instance", "attention", "--message=--clear", "--json"], { OATS_INSTANCE_HOME: home });
  assert.equal(notClear.doc.result.waitingOnYou?.message, "--clear", "the value is a message, not the --clear switch");
  const waiting = cli(["instance", "waiting", "set", "--producer", "oats.core", "--reason", "question", "--message=--which branch?", "--home", home, "--json"]);
  assert.equal(waiting.doc.result.waitingOnYou.message, "--which branch?");
  const spaced = cli(["instance", "attention", "--message", "--deploy", "--json"], { OATS_INSTANCE_HOME: home });
  assert.equal(spaced.doc?.error?.code, "E_BAD_ARGS"); assert.match(spaced.doc.error.message, /--message=<text>/);
  assert.equal(cli(["status", "--model=--yolo", "--json"]).doc?.ok, false, "other flags still refuse an inline value that is an option");
});

test("version --json advertises waiting-on-you", () => {
  const r = cli(["version", "--json"]);
  assert.ok(JSON.parse(r.stdout.trim().split("\n").pop()).features.includes("waiting-on-you"));
});
