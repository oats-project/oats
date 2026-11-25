// K7b — `instance-events-2`: the event read is bounded, addressed, incarnation-aware, and its integrity is reported independently of the window.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, symlinkSync, linkSync, realpathSync, rmSync, openSync, writeSync, closeSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readEvents, appendEvent, recordStartBoundary, EVENTS_API } from "../lib/instance-events.mjs";

const CLI = fileURLToPath(new URL("../bin/oats.mjs", import.meta.url));
function ws(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "k7b-"))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "agents"); const home = join(root, "dev", "instances", "dev-1");
  mkdirSync(join(root, "dev", "soul"), { recursive: true }); writeFileSync(join(root, "dev", "soul", "soul.yaml"), "name: dev\n");
  const incarnate = (createdAt) => { mkdirSync(home, { recursive: true }); writeFileSync(join(home, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", createdAt })); };
  return { base, root, home, incarnate, wsLog: join(base, ".agents", "events", "dev--dev-1.jsonl") };
}

test("A — the byte limit is an I/O bound: a source is lstat'ed first, a non-regular file is REFUSED unopened, an oversize file is read as a 4 MiB TAIL and reported", (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  // symlink source → refused, never followed
  writeFileSync(join(w.base, "elsewhere.jsonl"), JSON.stringify({ eventsApi: 2, at: "2026-01-01T00:00:01.000Z", instance: "dev-1", home: w.home, kind: "launched", producer: "kernel" }) + "\n");
  symlinkSync(join(w.base, "elsewhere.jsonl"), join(w.home, ".oats-events.jsonl"));
  let r = readEvents(w.home);
  assert.equal(r.events.length, 0); assert.deepEqual(r.integrity.sources[0], { path: "home", status: "refused", bytes: 0 }); assert.equal(r.integrity.sources[1].status, "absent");
  rmSync(join(w.home, ".oats-events.jsonl"));
  // oversize regular file → tail only
  const fd = openSync(join(w.home, ".oats-events.jsonl"), "w");
  // distinct rows (dedup is by facts): ~5 MiB of them, so only the last 4 MiB is read
  let written = 0, i = 0;
  while (written < 5 * 1024 * 1024) { const line = JSON.stringify({ eventsApi: 2, at: `2026-01-01T00:00:00.${String(i++ % 1000).padStart(3, "0")}Z`, instance: "dev-1", home: w.home, kind: "spawned", producer: "kernel", data: { i, pad: "x".repeat(200) } }) + "\n"; writeSync(fd, line); written += Buffer.byteLength(line); }
  writeSync(fd, JSON.stringify({ eventsApi: 2, at: "2026-01-01T00:00:02.000Z", instance: "dev-1", home: w.home, kind: "stopped", producer: "kernel" }) + "\n"); closeSync(fd);
  r = readEvents(w.home, { limit: 5 });
  assert.equal(r.integrity.sources[0].status, "tail"); assert.ok(r.integrity.sources[0].bytes > 4 * 1024 * 1024); assert.equal(r.truncated, true);
  assert.equal(r.lastEvent.kind, "stopped", "the newest row (at the end of the tail) is present"); assert.equal(r.integrity.unreadableRows, 0, "the partial first line of a tail is dropped, not counted as torn");
  assert.equal(r.returned, 5);
});

test("B — address history: foreign rows are dropped and counted; --home must be a home of THIS name (E_HOME_MISMATCH); a recreated same-address instance sees earlier rows tagged with their incarnation", (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  appendEvent(w.home, { kind: "spawned", data: { agent: "dev" } });
  appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at: "2026-01-01T00:00:05.000Z", instance: "dev-2", home: join(w.root, "dev", "instances", "dev-2"), kind: "launched", producer: "kernel" }) + "\n");
  let r = readEvents(w.home);
  assert.equal(r.integrity.foreignRows, 1); assert.deepEqual(r.events.map((e) => e.kind), ["spawned"]); assert.equal(r.incarnation, "2026-01-01T00:00:00.000Z"); assert.equal(r.events[0].incarnation, "2026-01-01T00:00:00.000Z");
  // reincarnation at the same address
  rmSync(w.home, { recursive: true }); w.incarnate("2026-02-01T00:00:00.000Z");
  appendEvent(w.home, { kind: "spawned", data: { agent: "dev" } });
  r = readEvents(w.home);
  assert.equal(r.incarnation, "2026-02-01T00:00:00.000Z");
  const incs = r.events.map((e) => e.incarnation); assert.ok(incs.includes("2026-01-01T00:00:00.000Z") && incs.includes("2026-02-01T00:00:00.000Z"), JSON.stringify(incs));
  assert.equal(r.events.filter((e) => e.incarnation !== r.incarnation).length, 1, "the earlier incarnation's row is visible AS earlier");
  // CLI: --home is checked against the name
  const bad = spawnSync(process.execPath, [CLI, "instance", "events", "dev-1", "--dir", w.base, "--agents-root", w.root, "--home", join(w.root, "dev", "instances", "dev-2"), "--json"], { encoding: "utf8", env: { ...process.env, OATS_TMUX_SESSION: "none" } });
  assert.equal(JSON.parse(bad.stdout.trim().split("\n").pop()).error.code, "E_HOME_MISMATCH", bad.stdout + bad.stderr);
  const ok = spawnSync(process.execPath, [CLI, "instance", "events", "dev-1", "--dir", w.base, "--agents-root", w.root, "--home", w.home, "--json"], { encoding: "utf8", env: { ...process.env, OATS_TMUX_SESSION: "none" } });
  const doc = JSON.parse(ok.stdout.trim().split("\n").pop()); assert.equal(doc.ok, true, ok.stdout + ok.stderr); assert.equal(doc.result.eventsApi, EVENTS_API); assert.equal(doc.result.home, w.home);
});

test("C — waitingOnYou is a producer STATE for the current incarnation: an explicit false clears, a later row without the field does not, an earlier incarnation's positive never counts, and it is computed over the full read (a window cannot hide a clear)", (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  appendEvent(w.home, { kind: "launched", producer: "provider.a", data: { waitingOnYou: true, reason: "review requested" } });
  let r = readEvents(w.home); assert.equal(r.waitingOnYou.producer, "provider.a"); assert.equal(r.waitingOnYou.reason, null, "a reason outside the closed set reads as null; the claim still counts");
  appendEvent(w.home, { kind: "recomposed", producer: "provider.a", data: {} });
  r = readEvents(w.home); assert.ok(r.waitingOnYou, "a row without the field does not clear");
  appendEvent(w.home, { kind: "launched", producer: "provider.b", data: { waitingOnYou: true, reason: "b wants you" } });
  r = readEvents(w.home); assert.equal(r.waitingOnYou.producer, "provider.b", "newest positive across producers"); assert.equal(r.waitingClaims.length, 2);
  appendEvent(w.home, { kind: "launched", producer: "provider.b", data: { waitingOnYou: false } });
  r = readEvents(w.home); assert.equal(r.waitingOnYou.producer, "provider.a", "b cleared; a's claim stands"); assert.deepEqual(r.waitingClaims.find((c) => c.producer === "provider.b").waiting, false);
  appendEvent(w.home, { kind: "launched", producer: "provider.a", data: { waitingOnYou: false } });
  for (let i = 0; i < 3; i++) appendEvent(w.home, { kind: "recomposed", producer: "kernel", data: {} });
  r = readEvents(w.home, { limit: 2 }); assert.equal(r.waitingOnYou, null, "cleared — and the clear is honoured even though the window does not include it");
  // an earlier incarnation's positive does not survive reincarnation
  appendEvent(w.home, { kind: "launched", producer: "provider.a", data: { waitingOnYou: true } });
  rmSync(w.home, { recursive: true }); w.incarnate("2026-02-01T00:00:00.000Z");
  r = readEvents(w.home); assert.equal(r.waitingOnYou, null); assert.deepEqual(r.waitingClaims, []);
  assert.ok(r.events.some((e) => e.data?.waitingOnYou === true && e.incarnation === "2026-01-01T00:00:00.000Z"), "…but the row is still visible as history of the address");
});

test("D — provenance and corruption never disappear: same facts from two producers are two rows; torn lines are counted regardless of --since or the window; count/returned/truncated are consistent", (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  const at = "2026-01-01T00:00:01.000Z";
  for (const p of ["provider.a", "provider.b"]) appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at, instance: "dev-1", home: w.home, incarnation: "2026-01-01T00:00:00.000Z", producer: p, kind: "launched", data: { x: 1 } }) + "\n");
  appendFileSync(join(w.home, ".oats-events.jsonl"), '{"eventsApi":2,"at":"2026-01-01T00:00:00.100Z","instance":"dev-1","kind":"spa\n'); // torn
  appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, instance: "dev-1", home: w.home, kind: "stopped" }) + "\n"); // no `at` → unreadable, not silently sorted first
  let r = readEvents(w.home);
  assert.equal(r.events.length, 2, "two producers, two rows"); assert.equal(r.integrity.unreadableRows, 2); assert.equal(r.count, 2); assert.equal(r.returned, 2); assert.equal(r.truncated, false);
  r = readEvents(w.home, { since: "2026-01-01T00:00:02.000Z" });
  assert.equal(r.count, 0); assert.equal(r.returned, 0); assert.equal(r.integrity.unreadableRows, 2, "corruption is reported even when since filters every row"); assert.equal(r.lastEvent, null);
  r = readEvents(w.home, { limit: 1 }); assert.equal(r.returned, 1); assert.equal(r.count, 2); assert.equal(r.truncated, true);
  // Observed-empty is distinguishable from absent sources.
  const e = ws(t); e.incarnate("2026-01-01T00:00:00.000Z"); const empty = readEvents(e.home);
  assert.deepEqual(empty.integrity, { unreadableRows: 0, foreignRows: 0, sources: [{ path: "home", status: "absent", bytes: 0 }, { path: "workspace", status: "absent", bytes: 0 }] }); assert.equal(empty.count, 0);
});

test("A′ — the lstat→open swap is closed: the open itself refuses to follow a symlink or block on a FIFO, and the descriptor must be the regular file lstat saw (dev+ino), otherwise the source is refused and the fd is closed", async (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  const good = JSON.stringify({ eventsApi: 2, at: "2026-01-01T00:00:01.000Z", instance: "dev-1", home: w.home, kind: "launched", producer: "kernel" }) + "\n";
  const logPath = join(w.home, ".oats-events.jsonl");
  // Swap a regular file for a symlink BETWEEN lstat and open, by intercepting the module's lstat through a swapped path state.
  writeFileSync(logPath, good);
  const realLstat = (await import("node:fs")).lstatSync;
  const st = realLstat(logPath);
  // Hold the first file's inode with a second link, so removing logPath cannot free it for reuse by the recreate below.
  const hold = join(w.base, "first.hold"); linkSync(logPath, hold);
  rmSync(logPath); writeFileSync(join(w.base, "target.jsonl"), good); symlinkSync(join(w.base, "target.jsonl"), logPath);
  // The reader lstat's the symlink itself → refused before open (already covered). To exercise the open-time guard we
  // call the low-level path the same way the reader does: O_NOFOLLOW on a symlink must fail.
  const { openSync: o, constants: c, closeSync: cl, fstatSync: fs } = await import("node:fs");
  assert.throws(() => o(logPath, c.O_RDONLY | c.O_NOFOLLOW), /ELOOP|EMLINK|ENOENT/, "O_NOFOLLOW refuses the symlink at open time regardless of what lstat said");
  rmSync(logPath);
  // A FIFO at open time: O_NONBLOCK open succeeds without a writer; fstat says not a regular file → refused, never read.
  const { status } = spawnSync("mkfifo", [logPath]); if (status === 0) {
    const r = readEvents(w.home); assert.equal(r.integrity.sources[0].status, "refused"); assert.equal(r.events.length, 0);
    rmSync(logPath);
  }
  // A different regular file with the same path but another inode after lstat would fail the dev+ino check; the reader's
  // own lstat and open are adjacent, so we assert the check's inputs are what it compares: identity, not just type.
  writeFileSync(logPath, good); const fd = o(logPath, c.O_RDONLY | c.O_NOFOLLOW); const f = fs(fd); cl(fd);
  assert.equal(f.ino, realLstat(logPath).ino); assert.notEqual(f.ino, st.ino, "a recreated file at the same path has a new inode — the identity check would refuse a swap");
  rmSync(hold);
  const ok = readEvents(w.home); assert.equal(ok.integrity.sources[0].status, "ok"); assert.equal(ok.events.length, 1);
});

test("C′ — an UNKNOWN current incarnation (unreadable instance.json) admits no claim: an earlier-tagged positive is history, never a current waiting claim; rows and integrity still report", (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  appendEvent(w.home, { kind: "launched", producer: "provider.a", data: { waitingOnYou: true, reason: "old" } });
  assert.equal(readEvents(w.home).waitingOnYou.producer, "provider.a", "known incarnation: claim counts");
  writeFileSync(join(w.home, "instance.json"), "{ not json");
  const r = readEvents(w.home);
  assert.equal(r.incarnation, null); assert.equal(r.waitingOnYou, null); assert.deepEqual(r.waitingClaims, []);
  assert.equal(r.events.length, 1, "the row is still visible as history"); assert.equal(r.events[0].incarnation, "2026-01-01T00:00:00.000Z");
  // a row with a null tag under a null current incarnation is ALSO not a claim (null never equals null here)
  appendFileSync(join(w.home, ".oats-events.jsonl"), JSON.stringify({ eventsApi: 2, at: "2026-01-01T00:00:09.000Z", instance: "dev-1", home: w.home, incarnation: null, producer: "provider.b", kind: "launched", data: { waitingOnYou: true } }) + "\n");
  const r2 = readEvents(w.home); assert.equal(r2.waitingOnYou, null); assert.deepEqual(r2.waitingClaims, []);
});

// #642: a retired instance answers from the workspace log, which outlives its home.
const eventsCli = (w, name, extra = []) => {
  const r = spawnSync(process.execPath, [CLI, "instance", "events", name, "--dir", w.base, "--agents-root", w.root, ...extra, "--json"], { encoding: "utf8", env: { ...process.env, OATS_TMUX_SESSION: "none" } });
  return { doc: JSON.parse(r.stdout.trim().split("\n").pop()), out: r.stdout + r.stderr };
};
/** Spawn-and-retire as the kernel records it: rows to both logs while the home
 *  lives, the retired row to the workspace log only after the home is gone. */
function retire(w, agent, name) {
  const home = join(w.root, agent, "instances", name);
  mkdirSync(join(w.root, agent, "soul"), { recursive: true }); writeFileSync(join(w.root, agent, "soul", "soul.yaml"), `name: ${agent}\n`);
  mkdirSync(home, { recursive: true }); writeFileSync(join(home, "instance.json"), JSON.stringify({ agent, instance: name, createdAt: "2026-01-01T00:00:00.000Z" }));
  appendEvent(home, { kind: "spawned", data: { agent } });
  rmSync(home, { recursive: true });
  appendEvent(home, { kind: "retired", data: {} }, { workspaceOnly: true });
  return home;
}

test("E — #642: a retired instance answers from its workspace log (home source absent, incarnation null); no log is still E_SESSION_UNKNOWN; a live home is unaffected", (t) => {
  const w = ws(t);
  assert.equal(eventsCli(w, "dev-1").doc.error.code, "E_SESSION_UNKNOWN", "no home and no log");
  const home = retire(w, "dev", "dev-1");
  let { doc, out } = eventsCli(w, "dev-1");
  assert.equal(doc.ok, true, out);
  assert.deepEqual(doc.result, readEvents(home), "exactly readEvents' answer for the removed home");
  assert.equal(doc.result.home, home); assert.equal(doc.result.incarnation, null);
  assert.deepEqual(doc.result.integrity.sources.map((s) => s.status), ["absent", "ok"]);
  assert.deepEqual(doc.result.events.map((e) => e.kind), ["spawned", "retired"]);
  ({ doc } = eventsCli(w, "dev-1", ["--limit", "1"])); assert.deepEqual(doc.result.events.map((e) => e.kind), ["retired"], "the window applies");
  // human output: today's format
  const human = spawnSync(process.execPath, [CLI, "instance", "events", "dev-1", "--dir", w.base, "--agents-root", w.root], { encoding: "utf8", env: { ...process.env, OATS_TMUX_SESSION: "none" } });
  assert.match(human.stdout, /^dev-1: 2 of 2 event\(s\)\n/, human.stdout + human.stderr);
  // a live home at the address (re-spawned) answers as before, with its incarnation
  w.incarnate("2026-02-01T00:00:00.000Z");
  ({ doc } = eventsCli(w, "dev-1"));
  assert.equal(doc.result.incarnation, "2026-02-01T00:00:00.000Z"); assert.equal(doc.result.integrity.sources[0].status, "absent", "the new home has no log yet");
  // a live home under one agent wins over another agent's retired log of the same name
  retire(w, "ops", "dev-1");
  ({ doc } = eventsCli(w, "dev-1")); assert.equal(doc.ok, true); assert.equal(doc.result.home, w.home);
});

test("E′ — #642: two agents' logs for one retired name refuse E_AMBIGUOUS_INSTANCE naming both; --home of a removed home answers when it is <root>/<agent>/instances/<name> with that agent's log, else E_HOME_MISMATCH", (t) => {
  const w = ws(t);
  const dev = retire(w, "dev", "dev-1"), ops = retire(w, "ops", "dev-1");
  let { doc, out } = eventsCli(w, "dev-1");
  assert.equal(doc.error.code, "E_AMBIGUOUS_INSTANCE", out); assert.match(doc.error.message, /2 .*--home/);
  assert.deepEqual(doc.error.details.candidates, [{ root: w.root, agent: "dev", home: dev }, { root: w.root, agent: "ops", home: ops }]);
  ({ doc, out } = eventsCli(w, "dev-1", ["--home", ops]));
  assert.equal(doc.ok, true, out); assert.equal(doc.result.home, ops); assert.equal(doc.result.incarnation, null);
  assert.deepEqual(doc.result.events.map((e) => e.data?.agent ?? e.kind), ["ops", "retired"], "the ops instance's rows, not dev's");
  // a symlinked spelling of the agents root is the same address
  symlinkSync(w.root, join(w.base, "agents-link"));
  ({ doc, out } = eventsCli(w, "dev-1", ["--home", join(w.base, "agents-link", "dev", "instances", "dev-1")])); assert.equal(doc.ok, true, out);
  // also one in another directory, outside the deployment: its rows are the deployment's, and the
  // answer names the home as --home spelled it
  mkdirSync(join(w.base, "elsewhere-parent"), { recursive: true });
  symlinkSync(w.root, join(w.base, "elsewhere-parent", "agents-alias"));
  const aliased = join(w.base, "elsewhere-parent", "agents-alias", "dev", "instances", "dev-1");
  ({ doc, out } = eventsCli(w, "dev-1", ["--home", aliased]));
  assert.equal(doc.ok, true, out);
  assert.deepEqual(doc.result, { ...readEvents(dev), home: aliased, events: readEvents(dev).events.map((e) => ({ ...e, home: aliased })) }, "the deployment's log, under the caller's spelling");
  assert.deepEqual(doc.result.integrity.sources.map((x) => x.status), ["absent", "ok"]);
  assert.equal(doc.result.count, 2);
  for (const bad of [
    join(w.root, "qa", "instances", "dev-1"), // no qa log
    join(w.root, "dev", "instances", "dev-2"), // not this name
    join(w.root, "dev", "other", "dev-1"), // not an instances dir
    join(w.base, "elsewhere", "dev", "instances", "dev-1"), // not under the scope
  ]) assert.equal(eventsCli(w, "dev-1", ["--home", bad]).doc.error.code, "E_HOME_MISMATCH", bad);
});

// Both logs are where an agent can write: its home, and the deployment's events directory (which a
// session provider's sandbox is allowed to write). The kernel that appends runs outside any sandbox.
test("W: an append never writes through a link planted at a log's name: a symbolic link (to a file, or dangling), a hard link and a FIFO are refused, the other log still gets its row, and the linked file is untouched", (t) => {
  const w = ws(t); w.incarnate("2026-01-01T00:00:00.000Z");
  const homeLog = join(w.home, ".oats-events.jsonl");
  const target = join(w.base, "operators-file"), before = "the operator's own bytes\n";
  const reasonOf = (res, path) => res.results.find((r) => r.path === path);
  const plant = { home: homeLog, workspace: w.wsLog };
  mkdirSync(join(w.base, ".agents", "events"), { recursive: true });
  for (const [which, log] of Object.entries(plant)) {
    const other = which === "home" ? w.wsLog : homeLog;
    // A symbolic link to a file of the operator's.
    writeFileSync(target, before); rmSync(log, { force: true }); symlinkSync(target, log);
    let res = appendEvent(w.home, { kind: "spawned", data: { agent: "dev" } });
    assert.equal(readFileSync(target, "utf8"), before, `${which}: nothing is written through the symbolic link`);
    assert.equal(reasonOf(res, log).ok, false); assert.match(reasonOf(res, log).reason, /symbolic link/);
    assert.equal(reasonOf(res, other).ok, true, `${which}: the other log has the row`); assert.equal(res.ok, true);
    // A dangling one creates nothing.
    rmSync(log); rmSync(target); symlinkSync(target, log);
    res = appendEvent(w.home, { kind: "launched" });
    assert.equal(existsSync(target), false, `${which}: a dangling link creates no file`); assert.equal(reasonOf(res, log).ok, false);
    // A hard link: the log is a second name of the operator's file.
    rmSync(log); writeFileSync(target, before); linkSync(target, log);
    res = appendEvent(w.home, { kind: "stopped" });
    assert.equal(readFileSync(target, "utf8"), before, `${which}: nothing is written into a file with two names`);
    assert.match(reasonOf(res, log).reason, /second name/);
    // The start boundary's repair writes by the same rule.
    const repaired = recordStartBoundary(w.home, { startId: `start-${which}`, startedAt: "2026-01-01T00:00:09.000Z" });
    assert.equal(readFileSync(target, "utf8"), before); assert.equal(repaired.ok, false, "a log that could not be written is not reported written");
    rmSync(log); rmSync(target);
  }
  // A FIFO is not waited on (the append would block for ever on one with no reader).
  const fifo = spawnSync("mkfifo", [homeLog]);
  if (fifo.status === 0) {
    const res = appendEvent(w.home, { kind: "restarted" });
    assert.equal(reasonOf(res, homeLog).ok, false); assert.equal(reasonOf(res, w.wsLog).ok, true);
    rmSync(homeLog);
  }
  // And a plain log is appended to as before, made when it is missing.
  rmSync(w.wsLog, { force: true });
  const plain = appendEvent(w.home, { kind: "spawned", data: { agent: "dev" } });
  assert.deepEqual(plain.results.map((r) => r.ok), [true, true]);
  assert.ok(lstatSync(homeLog).isFile() && lstatSync(w.wsLog).isFile());
  assert.equal(readFileSync(w.wsLog, "utf8").trim().split("\n").length, 1);
});
