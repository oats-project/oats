// RecordStore behavior: owner-only append, torn-tail tolerance and repair,
// dedupe, tombstones, objects, merge.

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { finishTurn } from "../lib/canonical.mjs";
import { processStartToken, thisBoot } from "../lib/process-identity.mjs";
import { parseJournal, RecordStore, StoreError } from "../lib/store.mjs";

function tempStore(t, owner = "alice") {
  const root = mkdtempSync(join(tmpdir(), "turn-record-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new RecordStore(root, { owner });
}

function noteCore(from, text) {
  return {
    v: 1,
    ts: "2026-02-22T10:00:00Z",
    from,
    kind: "note",
    body: { text },
    provenance: { source: "test", fidelity: "verbatim" },
  };
}

test("append requires ownership and a correct id", (t) => {
  const store = tempStore(t, "alice");
  const turn = finishTurn(noteCore("alice", "mine"));
  store.append("alice~notes", turn);
  assert.equal(store.readStream("alice~notes").length, 1);

  assert.throws(() => store.append("bob~notes", turn), /owner-only/);
  assert.throws(
    () => store.append("alice~notes", { ...turn, id: "t1:" + "0".repeat(64) }),
    /does not match/,
  );
  assert.throws(() => store.append("alice~notes", noteCore("alice", "no id")), StoreError);
});

test("torn tail is ignored by readers and repaired by the next append", (t) => {
  const store = tempStore(t, "alice");
  const a = finishTurn(noteCore("alice", "one"));
  store.append("alice~notes", a);
  const path = store.journalPath("alice~notes");

  appendFileSync(path, '{"v":1,"truncated'); // torn write
  assert.equal(store.readStream("alice~notes").length, 1, "torn tail ignored");

  const b = finishTurn(noteCore("alice", "two"));
  store.append("alice~notes", b);
  const turns = store.readStream("alice~notes");
  assert.deepEqual(
    turns.map((x) => x.id),
    [a.id, b.id],
    "repair removed the torn bytes, then appended",
  );
  assert.ok(!readFileSync(path, "utf8").includes("truncated"));
});

test("valid JSON without a trailing newline is still a torn tail", () => {
  const a = finishTurn(noteCore("alice", "one"));
  const { turns, torn } = parseJournal(JSON.stringify(a));
  assert.equal(turns.length, 0);
  assert.ok(torn);
});

test("interior corruption throws rather than silently dropping turns", (t) => {
  const store = tempStore(t, "alice");
  const path = store.journalPath("alice~notes");
  const a = finishTurn(noteCore("alice", "one"));
  store.append("alice~notes", a);
  writeFileSync(path, "not json\n" + readFileSync(path, "utf8"));
  assert.throws(() => store.readStream("alice~notes"), /corrupt interior/);

  // The WRITE path fails loud too: a fresh instance validates the journal
  // before its first append instead of appending past the damage.
  const fresh = new RecordStore(store.root, { owner: "alice" });
  const b = finishTurn(noteCore("alice", "two"));
  assert.throws(() => fresh.append("alice~notes", b), /corrupt interior/);
  // The same instance that wrote the stream earlier trusts its own appends;
  // only a NEW instance (a new process) re-validates. Both must refuse here.
  assert.throws(() => fresh.appendBatch("alice~notes", [b]), /corrupt interior/);
});

test("appendBatch chunked writes produce the same journal as one write", (t) => {
  const a = tempStore(t, "alice");
  const b = tempStore(t, "alice");
  const turns = [];
  for (let i = 0; i < 20; i++) turns.push(finishTurn(noteCore("alice", `turn ${i} `.repeat(10))));
  a.appendBatch("alice~notes", turns);
  // Force many flushes: a chunk cap smaller than a single line still writes
  // every turn (a line larger than the cap gets its own chunk).
  b.appendBatch("alice~notes", turns, 64);
  assert.deepEqual(b.readStream("alice~notes"), a.readStream("alice~notes"));
  assert.equal(b.readStream("alice~notes").length, 20);
});

test("appendCore dedupes by content id", (t) => {
  const store = tempStore(t, "alice");
  const core = noteCore("alice", "same");
  const r1 = store.appendCore("alice~notes", core);
  const r2 = store.appendCore("alice~notes", core);
  assert.ok(r1.appended);
  assert.ok(!r2.appended);
  assert.equal(store.readStream("alice~notes").length, 1);
});

test("tombstones hide by author or record owner, not by strangers", (t) => {
  const store = tempStore(t, "owner");
  const target = finishTurn(noteCore("owner", "to delete"));
  store.append("owner~notes", target);
  const byAuthor = finishTurn({
    ...noteCore("owner", ""),
    kind: "tombstone",
    links: [{ rel: "tombstones", ref: target.id }],
  });
  store.append("owner~notes", byAuthor);
  assert.deepEqual([...store.hiddenIds()], [target.id]);

  // A stranger's tombstone (different from, not owner) must not hide.
  const store2 = tempStore(t, "mallory");
  const victim = finishTurn(noteCore("someone", "keep me"));
  const strangerCore = {
    ...noteCore("mallory", ""),
    kind: "tombstone",
    links: [{ rel: "tombstones", ref: victim.id }],
  };
  store2.append("mallory~notes", finishTurn(strangerCore));
  // Import the victim's stream as a foreign copy.
  store2.mergeStreamCopy("someone~notes", [victim]);
  const store2AsReader = new RecordStore(store2.root, { owner: "reader" });
  assert.equal(store2AsReader.hiddenIds().size, 0, "stranger tombstone has no effect");
});

test("blank lines in a journal are tolerated, not fatal", (t) => {
  const store = tempStore(t, "alice");
  const a = finishTurn(noteCore("alice", "one"));
  store.append("alice~notes", a);
  const path = store.journalPath("alice~notes");
  appendFileSync(path, "\n"); // stray extra newline
  assert.deepEqual(
    store.readStream("alice~notes").map((x) => x.id),
    [a.id],
  );
  const b = finishTurn(noteCore("alice", "two"));
  store.append("alice~notes", b); // self-heals, does not throw
  assert.equal(store.readStream("alice~notes").length, 2);

  // A journal that is only a newline reads as empty.
  const store2 = tempStore(t, "alice");
  mkdirSync(join(store2.streamsDir(), "alice~x"), { recursive: true });
  writeFileSync(store2.journalPath("alice~x"), "\n");
  assert.deepEqual(store2.readStream("alice~x"), []);
});

test("stream lock: untokened lock blocks while fresh, is reclaimed once aged", (t) => {
  // A lock with no readable owner token (older version, or hand-written):
  // liveness is not knowable, so age is the fallback that still applies.
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 200; // keep the blocked case fast
  const turn = finishTurn(noteCore("alice", "locked"));
  const dir = join(store.streamsDir(), "alice~notes");
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, ".lock");

  writeFileSync(lockPath, "99999");
  assert.throws(() => store.append("alice~notes", turn), /timed out waiting for lock/);
  assert.deepEqual(store.readStream("alice~notes"), []);

  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  store.append("alice~notes", turn);
  assert.equal(store.readStream("alice~notes").length, 1);
});

test("stream lock: a dead holder's lock is reclaimed at once, without waiting out its age", (t) => {
  // Crash recovery. The pid is a process that really has exited, so the
  // reclaim is proven by liveness rather than assumed from a made-up pid,
  // and the lock's mtime is fresh — far younger than lockStaleMs.
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 200;
  store.lockStaleMs = 60_000; // age alone would never reclaim this lock
  const dir = join(store.streamsDir(), "alice~notes");
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, ".lock");

  const corpse = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  return new Promise((resolve) => corpse.on("exit", resolve)).then(() => {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: corpse.pid,
        host: hostname(),
        nonce: "deadbeefdeadbeefdeadbeef",
        acquiredAt: new Date().toISOString(),
      }) + "\n",
    );
    // Observe lock polling, not elapsed disk/fsync/scheduler time. A loaded CI
    // host can take >200ms AFTER successful acquisition without waiting on the
    // holder at all. Advancing only the retry clock also makes an age-only
    // regression hit the deadline deterministically instead of sleeping here.
    let clock = Date.now();
    const waits = [];
    t.mock.method(Date, "now", () => clock);
    t.mock.method(Atomics, "wait", (_array, _index, _value, ms) => {
      waits.push(ms); clock += ms; return "timed-out";
    });
    store.append("alice~notes", finishTurn(noteCore("alice", "after the crash")));
    assert.equal(store.readStream("alice~notes").length, 1);
    assert.deepEqual(waits, [25], "a dead holder needs only the bounded retry after reclaim, not an age wait");
  });
});

test("stream lock: a late contender never acquires against a live holder", (t) => {
  // The reachable defect: the waiter's timeout starts when the contender
  // arrives, while the old age test measured from the lock's creation — so
  // a contender arriving after lockStaleMs stole a lock whose holder was
  // still inside its critical section. Scaled thresholds, same shape.
  const store = tempStore(t, "alice");
  const lib = new URL("../lib/", import.meta.url).href;
  const holderCode = `
    import { RecordStore } from ${JSON.stringify(lib + "store.mjs")};
    const store = new RecordStore(${JSON.stringify(store.root)},
      { owner: "alice", lockTimeoutMs: 100, lockStaleMs: 500 });
    store.withStreamLock("alice~notes", () => {
      console.log("acquired");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1600);
      console.log("released");
    });
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderCode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => holder.kill());
  let holderOut = "";
  holder.stdout.on("data", (chunk) => (holderOut += chunk));

  const acquired = new Promise((resolve) => holder.stdout.once("data", resolve));
  const exited = new Promise((resolve) => holder.on("exit", resolve));

  return acquired
    .then(() => new Promise((resolve) => setTimeout(resolve, 700))) // arrive late
    .then(() => {
      const contender = new RecordStore(store.root, {
        owner: "alice",
        lockTimeoutMs: 100,
        lockStaleMs: 500, // contender arrives at 700ms: older than stale
      });
      assert.ok(!holderOut.includes("released"), "holder is still in its critical section");
      assert.throws(
        () => contender.withStreamLock("alice~notes", () => assert.fail("stole a live lock")),
        /timed out waiting for lock/,
        "a live holder's lock must never be stolen, however old it is",
      );
      return exited;
    })
    .then(() => {
      assert.ok(holderOut.includes("released"), "holder ran to completion");
      assert.equal(existsSync(join(store.streamsDir(), "alice~notes", ".lock")), false);
    });
});

/** The lock of `stream`, held by the holder `token` names, as a stream lock is written. → its path. */
function plantStreamLock(store, stream, token) {
  const dir = join(store.streamsDir(), stream);
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, ".lock");
  writeFileSync(lockPath, JSON.stringify({ host: hostname(), nonce: "deadbeefdeadbeefdeadbeef", acquiredAt: new Date().toISOString(), ...token }) + "\n");
  return lockPath;
}
/** This test process, as a stream lock names a holder that runs. */
const runningHolder = () => ({ pid: process.pid, bootId: thisBoot(), processStart: processStartToken(process.pid) });
const OTHER_HOST = `not-${hostname()}`;

test("stream lock: the token names its holder by pid, host, boot and start", (t) => {
  const store = tempStore(t, "alice");
  const token = store.withStreamLock("alice~notes", () => JSON.parse(readFileSync(join(store.streamsDir(), "alice~notes", ".lock"), "utf8")));
  assert.deepEqual(Object.keys(token).sort(), ["acquiredAt", "bootId", "host", "nonce", "pid", "processStart"]);
  assert.deepEqual([token.pid, token.host, token.bootId, token.processStart], [process.pid, hostname(), thisBoot(), processStartToken(process.pid)]);
  assert.equal(typeof token.processStart, "string", "this host reads a process's start");
});

test("stream lock: a lock whose pid runs with another start (a reused pid), or taken in another boot, is reclaimed at once", (t) => {
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 2000;
  store.lockStaleMs = 60_000; // age alone would never reclaim these locks
  plantStreamLock(store, "alice~notes", { ...runningHolder(), processStart: "proc:1" });
  store.append("alice~notes", finishTurn(noteCore("alice", "after a reused pid")));
  plantStreamLock(store, "alice~notes", { ...runningHolder(), bootId: `another-boot-than-${thisBoot()}` });
  store.append("alice~notes", finishTurn(noteCore("alice", "after another boot")));
  assert.equal(store.readStream("alice~notes").length, 2);
});

test("stream lock: another host's name does not keep the lock of a holder that is gone", (t) => {
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 2000;
  store.lockStaleMs = 60_000; // age alone would never reclaim this lock
  plantStreamLock(store, "alice~notes", { pid: 999999999, host: OTHER_HOST, bootId: thisBoot(), processStart: "proc:1" });
  store.append("alice~notes", finishTurn(noteCore("alice", "after the other host")));
  assert.equal(store.readStream("alice~notes").length, 1);
});

test("stream lock: a live holder of this boot with the recorded start is never stolen from, whatever host it names and however old the lock", (t) => {
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 200;
  store.lockStaleMs = 500;
  for (const host of [hostname(), OTHER_HOST]) {
    const lockPath = plantStreamLock(store, "alice~notes", { ...runningHolder(), host });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const before = readFileSync(lockPath, "utf8");
    assert.throws(() => store.append("alice~notes", finishTurn(noteCore("alice", "stolen"))), new RegExp(`timed out waiting for lock .*held by pid ${process.pid} on `), host);
    assert.equal(readFileSync(lockPath, "utf8"), before, `${host}: the live holder's lock is untouched`);
    rmSync(lockPath);
  }
  assert.deepEqual(store.readStream("alice~notes"), []);
});

test("stream lock: a token that names no boot or start is judged by its pid on this host, and by the lock's age on another", (t) => {
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 200;
  store.lockStaleMs = 30_000;
  const turn = finishTurn(noteCore("alice", "locked"));
  // This host, a pid that runs: held, however old the lock.
  let lockPath = plantStreamLock(store, "alice~notes", { pid: process.pid });
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  assert.throws(() => store.append("alice~notes", turn), /timed out waiting for lock/);
  rmSync(lockPath);
  // Another host: its pid says nothing here, so the lock is held while fresh and reclaimed once aged.
  lockPath = plantStreamLock(store, "alice~notes", { pid: 999999999, host: OTHER_HOST });
  assert.throws(() => store.append("alice~notes", turn), /timed out waiting for lock/);
  utimesSync(lockPath, old, old);
  store.append("alice~notes", turn);
  assert.equal(store.readStream("alice~notes").length, 1);
});

test("stream lock: an unreadable lock fails fast and actionably, it does not spin", (t) => {
  // Regression for the bounded-retry defect: readLock treated EVERY error as
  // "the lock vanished", and the acquire loop retried that branch without
  // ever consulting its deadline — so a lock that could not be read spun
  // hot forever instead of failing. A directory where the lock file belongs
  // is a deterministic, permission-free way to produce a non-ENOENT read
  // error (EISDIR on both macOS and Linux).
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 2000; // a spin, or any waiting at all, would take this long
  const dir = join(store.streamsDir(), "alice~notes");
  const lockPath = join(dir, ".lock");
  mkdirSync(lockPath, { recursive: true });

  const started = Date.now();
  assert.throws(
    () => store.append("alice~notes", finishTurn(noteCore("alice", "blocked"))),
    (err) =>
      err instanceof StoreError &&
      /cannot read stream lock/.test(err.message) &&
      /EISDIR/.test(err.message) &&
      err.message.includes(lockPath),
    "the underlying code and path must reach the operator",
  );
  assert.ok(
    Date.now() - started < 500,
    "an unclearable condition must fail at once, not be retried to the deadline",
  );
  assert.deepEqual(store.readStream("alice~notes"), []);
});

test("stream lock: a lock that always reads as vanished is bounded, not spun on", (t) => {
  // The other half of the bounded-retry defect. A dangling symlink where the
  // lock file belongs makes createLock fail (the NAME exists, so the link
  // is EEXIST) while readLock's stat follows it and reports ENOENT — a
  // genuine "vanished" reading, forever. Any branch allowed to retry
  // without consulting the deadline spins here until killed.
  const store = tempStore(t, "alice");
  store.lockTimeoutMs = 300;
  const dir = join(store.streamsDir(), "alice~notes");
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(dir, "no-such-target"), join(dir, ".lock"));

  const started = Date.now();
  assert.throws(
    () => store.append("alice~notes", finishTurn(noteCore("alice", "blocked"))),
    /timed out waiting for lock/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= store.lockTimeoutMs, `waited its timeout (${elapsed}ms)`);
  assert.ok(elapsed < 5000, `and stopped at it rather than spinning (${elapsed}ms)`);
  assert.deepEqual(store.readStream("alice~notes"), []);
});

test("stream lock: a holder does not release a replacement lock it does not own", (t) => {
  // The other half of the defect: the old release unlinked .lock
  // unconditionally, so a holder whose lock had been reclaimed deleted the
  // NEW holder's lock on its way out, leaving two writers unserialized.
  const store = tempStore(t, "alice");
  const dir = join(store.streamsDir(), "alice~notes");
  const lockPath = join(dir, ".lock");
  const replacement =
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      nonce: "someoneelsesnonce0000000",
      acquiredAt: new Date().toISOString(),
    }) + "\n";

  store.withStreamLock("alice~notes", () => {
    // Simulate the reclaim: while we hold it, the lock becomes someone else's.
    writeFileSync(lockPath, replacement);
  });

  assert.equal(existsSync(lockPath), true, "the replacement lock survived our release");
  assert.equal(readFileSync(lockPath, "utf8"), replacement, "and it is still the new holder's");
});

test("torn-tail repair happens under the lock (no stale-offset truncation)", (t) => {
  // Regression shape for the reviewed race: a torn tail exists, one writer
  // repairs+appends, a second writer must see the *new* state, not its
  // pre-read offset. Single-process equivalent: two appends in sequence
  // against a torn tail both survive.
  const store = tempStore(t, "alice");
  const a = finishTurn(noteCore("alice", "first"));
  store.append("alice~notes", a);
  appendFileSync(store.journalPath("alice~notes"), '{"torn');
  const b = finishTurn(noteCore("alice", "second"));
  const c = finishTurn(noteCore("alice", "third"));
  store.append("alice~notes", b);
  store.append("alice~notes", c);
  assert.deepEqual(
    store.readStream("alice~notes").map((x) => x.id),
    [a.id, b.id, c.id],
  );
});

test("two real processes racing on a torn-tail journal lose nothing", (t) => {
  // The reviewed data-loss scenario: torn tail present, two owner-side
  // writers append concurrently. Under the stream lock both turns survive.
  const store = tempStore(t, "alice");
  const a = finishTurn(noteCore("alice", "base"));
  store.append("alice~notes", a);
  appendFileSync(store.journalPath("alice~notes"), '{"torn');

  const lib = new URL("../lib/", import.meta.url).href;
  const script = (text) => `
    import { RecordStore } from ${JSON.stringify(lib + "store.mjs")};
    import { finishTurn } from ${JSON.stringify(lib + "canonical.mjs")};
    const store = new RecordStore(${JSON.stringify(store.root)}, { owner: "alice" });
    const turn = finishTurn({ v: 1, ts: "2026-02-22T10:00:00Z", from: "alice", kind: "note",
      body: { text: ${JSON.stringify(text)} },
      provenance: { source: "test", fidelity: "verbatim" } });
    store.append("alice~notes", turn);
  `;
  const children = ["racer-one", "racer-two"].map((text) =>
    spawn(process.execPath, ["--input-type=module", "-e", script(text)], { stdio: "inherit" }),
  );
  return Promise.all(
    children.map(
      (child) =>
        new Promise((resolve, reject) => {
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        }),
    ),
  ).then(() => {
    const texts = store
      .readStream("alice~notes")
      .map((x) => x.body.text)
      .sort();
    assert.deepEqual(texts, ["base", "racer-one", "racer-two"], "no turn was truncated away");
  });
});

test("objects: put is idempotent and content-addressed", (t) => {
  const store = tempStore(t);
  const ref = store.putObject(Buffer.from("hello"));
  assert.equal(ref, store.putObject(Buffer.from("hello")));
  assert.ok(store.hasObject(ref));
  assert.equal(store.getObject(ref).toString(), "hello");
  assert.throws(() => store.getObject("sha256:zz"), StoreError);
});

test("mergeStreamCopy extends by suffix and quarantines non-prefix", (t) => {
  const store = tempStore(t, "alice");
  const a = finishTurn(noteCore("bob", "one"));
  const b = finishTurn(noteCore("bob", "two"));
  const c = finishTurn(noteCore("bob", "three"));

  assert.equal(store.mergeStreamCopy("bob~notes", [a, b]).extended, 2);
  assert.equal(store.mergeStreamCopy("bob~notes", [a]).extended, 0, "shorter copy is stale");
  assert.equal(store.mergeStreamCopy("bob~notes", [a, b, c]).extended, 1);
  assert.deepEqual(
    store.readStream("bob~notes").map((x) => x.id),
    [a.id, b.id, c.id],
  );
  assert.throws(() => store.mergeStreamCopy("bob~notes", [a, c, b]), /quarantined/);
});
