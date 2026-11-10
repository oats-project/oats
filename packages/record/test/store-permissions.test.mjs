// What the record store creates is private to its owner: files 0600,
// directories 0700 (docs/turn-record-sot.md, "Store layout").

import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { finishTurn } from "../lib/canonical.mjs";
import { createCaptureScratch } from "../lib/capture-scratch.mjs";
import { RecordIndex } from "../lib/index-db.mjs";
import { RecordStore, StoreError } from "../lib/store.mjs";

const skip = process.platform === "win32" ? "POSIX mode bits" : false;

function note(from, text) {
  return finishTurn({
    v: 1,
    ts: "2026-02-22T10:00:00Z",
    from,
    kind: "note",
    body: { text },
    provenance: { source: "test", fidelity: "verbatim" },
  });
}

/** A store root that does not exist yet, under a private temporary directory. */
function absentRoot(t) {
  const base = mkdtempSync(join(tmpdir(), "turn-record-permissions-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return join(base, "record");
}

/** Every path under `root` (and `root`), with its permission bits in octal. */
function modes(root) {
  const found = new Map([[".", lstatSync(root)]]);
  for (const name of readdirSync(root, { recursive: true })) found.set(String(name), lstatSync(join(root, String(name))));
  return [...found].map(([name, stat]) => ({ name, directory: stat.isDirectory(), mode: (stat.mode & 0o777).toString(8) }));
}

function assertPrivate(root, expected) {
  const all = modes(root);
  for (const name of expected) assert.ok(all.some((entry) => entry.name === name), `the store created ${name}`);
  const wide = all.filter((entry) => entry.mode !== (entry.directory ? "700" : "600"));
  assert.deepEqual(wide, [], "files are created 0600 and directories 0700");
}

test("a journal, its stream directory and the derived state are created private", { skip }, (t) => {
  const root = absentRoot(t);
  const store = new RecordStore(root, { owner: "alice" });
  store.append("alice~notes", note("alice", "mine"));
  assertPrivate(root, ["streams", join("streams", "alice~notes"), join("streams", "alice~notes", "journal.jsonl"), "index", join("index", "capture.db")]);
});

test("an object and its directories are created private", { skip }, (t) => {
  const root = absentRoot(t);
  const store = new RecordStore(root, { owner: "alice" });
  const digest = store.putObject(Buffer.from("attachment")).slice("sha256:".length);
  assertPrivate(root, ["objects", join("objects", "sha256"), join("objects", "sha256", digest.slice(0, 2), digest)]);
});

test("a merged journal and a quarantined foreign copy are created private", { skip }, (t) => {
  const root = absentRoot(t);
  const store = new RecordStore(root, { owner: "alice" });
  store.mergeStreamCopy("bob~notes", [note("bob", "one")]);
  assert.throws(() => store.mergeStreamCopy("bob~notes", [note("bob", "another")]), StoreError);
  const quarantined = readdirSync(join(root, "streams", "bob~notes")).find((name) => name.startsWith("quarantine-"));
  assert.ok(quarantined, "the foreign copy is quarantined");
  assertPrivate(root, [join("streams", "bob~notes", "journal.jsonl"), join("streams", "bob~notes", quarantined)]);
});

test("the index database is created private", { skip }, (t) => {
  const root = absentRoot(t);
  const store = new RecordStore(root, { owner: "alice" });
  store.append("alice~notes", note("alice", "mine"));
  const index = new RecordIndex(store);
  try { index.update(); } finally { index.close(); }
  assertPrivate(root, [join("index", "turns.db")]);
});

test("capture scratch creates the store root private", { skip }, (t) => {
  const root = absentRoot(t);
  createCaptureScratch(root, "receipt");
  assertPrivate(root, [".capture-tmp"]);
});
