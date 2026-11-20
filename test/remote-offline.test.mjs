/** The offline read session (lib/remote.mjs, OFFLINE): `createReadSession({ offline: true })` never
 *  reaches a remote. A head is the one this host last observed, of any age; a commit and a file are
 *  read only when the cache holds them; whatever is not there is E_REMOTE_UNREADABLE with reason
 *  "not-cached", naming the repository, and no ls-remote and no fetch is ever run. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadSession, observeRemote, readRemoteFile, runGit } from "../lib/remote.mjs";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
const roots = [];
function scratch() { const d = mkdtempSync(join(tmpdir(), "oats-offline-")); roots.push(d); return d; }
test.after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });
function repo(base, files) {
  const bare = join(base, "a.git"), work = join(base, "a-work");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  git(base, "init", "-q", "-b", "main", work);
  const push = (more) => {
    for (const [rel, body] of Object.entries(more)) { mkdirSync(join(work, rel, ".."), { recursive: true }); writeFileSync(join(work, rel), body); }
    git(work, "add", "-A"); git(work, "commit", "-q", "-m", "c"); git(work, "push", "-q", bare, "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  return { bare, commit: push(files), push };
}
/** A git runner that records each verb, and fails the test on one that reaches a remote. */
function watched() {
  const calls = [];
  const verb = (args) => args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-C" && args[i - 1] !== "-c") ?? args[0];
  const exec = (args, opts) => { calls.push(verb(args)); return runGit(args, opts); };
  return { exec, calls, reached: () => calls.filter((c) => c === "ls-remote" || c === "fetch" || c === "clone") };
}
const notCached = (what) => (e) => { assert.equal(e.code, "E_REMOTE_UNREADABLE"); assert.equal(e.details.reason, "not-cached"); assert.match(e.message, what); return true; };
const offline = () => createReadSession({ offline: true });
const text = (file) => Buffer.from(file.bytes).toString("utf8");

test("offline: the head is the one this host last observed, of any age, and the files it read are read again, with no git process that reaches a remote", async () => {
  const base = scratch(), r = repo(base, { "a.txt": "one\n", "b.txt": "two\n" }), cacheDir = join(base, "cache");
  const live = await observeRemote(r.bare, { cacheDir, session: createReadSession() });
  assert.equal(text(await readRemoteFile(r.bare, live.commit, "a.txt", { cacheDir, session: createReadSession() })), "one\n");
  // The remote moves on, and the record ages past every maxAge: the offline read still answers what this host read.
  r.push({ "a.txt": "moved\n" });
  const records = join(cacheDir, ".observed");
  for (const f of readdirSync(records)) writeFileSync(join(records, f), JSON.stringify({ ...JSON.parse(readFileSync(join(records, f), "utf8")), observedAt: "2020-01-01T00:00:00.000Z" }));
  const w = watched(), session = offline();
  const seen = await observeRemote(r.bare, { cacheDir, exec: w.exec, session });
  assert.deepEqual([seen.commit, seen.reused, seen.observedAt], [live.commit, true, "2020-01-01T00:00:00.000Z"]);
  assert.equal(text(await readRemoteFile(r.bare, seen.commit, "a.txt", { cacheDir, exec: w.exec, session })), "one\n");
  assert.deepEqual(w.reached(), [], JSON.stringify(w.calls));
  session.close();
  // And it recorded nothing: a live read after it observes the remote's own head.
  assert.equal(JSON.parse(readFileSync(join(records, readdirSync(records)[0]), "utf8")).observedAt, "2020-01-01T00:00:00.000Z");
});

test("offline: a repository never observed here, a commit the cache does not hold and a file it does not hold are each not-cached, by name, and nothing is fetched", async () => {
  const base = scratch(), r = repo(base, { "a.txt": "one\n", "b.txt": "two\n" }), cacheDir = join(base, "cache");
  const w = watched();
  // Never observed on this host.
  await assert.rejects(observeRemote(r.bare, { cacheDir, exec: w.exec, session: offline() }), notCached(/cannot read .+a\.git without reaching it: this host has not observed it yet/));
  // Observed, and one file read: the other file's blob is not in the (partial) cache.
  const live = await observeRemote(r.bare, { cacheDir, session: createReadSession() });
  await readRemoteFile(r.bare, live.commit, "a.txt", { cacheDir, session: createReadSession() });
  const missing = await readRemoteFile(r.bare, live.commit, "b.txt", { cacheDir, exec: w.exec, session: offline() }).then((file) => ({ file }), (error) => ({ error }));
  // (A git that cannot keep a partial cache fetches whole: then the file is there, and read.)
  if (missing.error) assert.ok(notCached(/this host's cache does not hold a file of its commit/)(missing.error));
  else assert.equal(text(missing.file), "two\n");
  // A commit this host never fetched.
  const next = r.push({ "a.txt": "moved\n" });
  await assert.rejects(readRemoteFile(r.bare, next, "a.txt", { cacheDir, exec: w.exec, session: offline() }), notCached(new RegExp(`this host's cache does not hold its commit ${next}`)));
  assert.deepEqual(w.reached(), [], JSON.stringify(w.calls));
});

test("offline is true or false, and a session without it is as it was", () => {
  assert.throws(() => createReadSession({ offline: "yes" }), /offline must be true or false/);
  assert.equal(createReadSession().offline, false);
});
