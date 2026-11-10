/** lib/remote.mjs — partial fetches into the cache (awebai/oats#384): a commit arrives with its trees and only
 * the blobs up to SMALL_BLOB_LIMIT; a read or a materialization fetches the larger blobs it needs, one batched
 * fetch per request; a server that cannot serve that gets whole trees, recorded per cache and said once; git
 * never fetches lazily. Tests build SMALL repos inline. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  classifyRemoteFailure, contentDigest, createReadSession, fetchRemoteTree, listRemoteFiles, listRemoteTree, observeRemote, parseRepoRef, readRemoteFile, runGit, scrubGitLine,
  FILE_BUDGET, GIT_LINE_MAX, OATS_ALIAS_SYMLINK, PARTIAL_FETCH_GIT, SMALL_BLOB_LIMIT, gitVersion, keepsPartialCache,
} from "../lib/remote.mjs";
import { thisBoot } from "../lib/session-seen.mjs";
import { processStartToken } from "../lib/worktree-hooks.mjs";
import { PARTIAL_GIT, olderGitNotice, skipPartialMechanics } from "./helpers/partial-git.mjs";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).toString("utf8").trim();
const gitInput = (cwd, input, ...args) => execFileSync("git", args, { cwd, env: { ...GIT_ENV, GIT_NO_LAZY_FETCH: "1" }, input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim();

const roots = [];
function scratch() { const d = mkdtempSync(join(tmpdir(), "oats-remote-partial-")); roots.push(d); return d; }
test.after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const write = (dir, rel, content) => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), content); };
/** `n` bytes that do not compress, the same for the same seed. */
function noise(n, seed = "oats") {
  const out = Buffer.alloc(n);
  let h = createHash("sha256").update(seed).digest();
  for (let i = 0; i < n; i += 32) { h = createHash("sha256").update(h).digest(); h.copy(out, i); }
  return out;
}

/** A bare remote whose server is configured by `server` ("partial": serves filters and blob wants, as GitHub
 *  does; "plain": a default git, no filters; "no-blob-wants": filters, but protocol v0 without
 *  allowAnySHA1InWant, so it refuses a want of a blob by id). The tree: small files the kernel would read, a
 *  module dir with one large file, and large files nothing reads. */
function fixture(server = "partial") {
  const base = scratch();
  const bare = join(base, "remote.git"), work = join(base, "work");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  if (server !== "plain") git(bare, "config", "uploadpack.allowFilter", "true");
  if (server === "partial") git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(base, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", bare);
  write(work, "oats-membership.yaml", "schemaVersion: 2\n");
  write(work, "souls/dev/soul.yaml", "name: dev\n");
  write(work, "souls/dev/AGENTS.md", "# dev\n");
  write(work, "elsewhere/tools/oats.json", "{\"capability\":\"tools\"}\n");
  write(work, "elsewhere/tools/data/model.bin", noise(SMALL_BLOB_LIMIT * 3, "model"));
  write(work, "assets/huge-1.bin", noise(SMALL_BLOB_LIMIT * 4, "huge-1"));
  write(work, "assets/huge-2.bin", noise(SMALL_BLOB_LIMIT * 4, "huge-2"));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "one");
  git(work, "push", "-q", "origin", "HEAD:main");
  const commit = git(work, "rev-parse", "HEAD");
  const blob = (path) => git(work, "rev-parse", `HEAD:${path}`);
  const cacheDir = join(base, "cache");
  const repoDir = join(cacheDir, createHash("sha256").update(parseRepoRef(bare).key).digest("hex"));
  /** Which of `paths` have their blob in the cache (never fetching one to find out). */
  const present = (...paths) => Object.fromEntries(paths.map((p) => [p, !gitInput(repoDir, `${blob(p)}\n`, "cat-file", "--batch-check").endsWith(" missing")]));
  return { base, bare, work, commit, blob, cacheDir, repoDir, present };
}

/** The fetches an exec wrapper saw, and what each asked for on stdin. */
function counting() {
  const fetches = [];
  const exec = (args, o) => { if (args.includes("fetch")) fetches.push({ args, input: o?.input ?? null }); return runGit(args, o); };
  return { fetches, exec };
}

/** Run `fn` with git's global config replaced by `text` (the cache's git reads it, as an operator's would). */
async function withGlobalGitConfig(base, text, fn) {
  const file = join(base, "global.gitconfig");
  writeFileSync(file, text);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  try { return await fn(); } finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
}

// ---------------------------------------------------------------------------
// a server that serves partial fetches
// ---------------------------------------------------------------------------

test("a commit arrives with its trees and its small blobs only (with an older git, its whole tree, said once); the cache never stores the url", async () => {
  const f = fixture();
  const session = createReadSession();
  try {
    const obs = await observeRemote(f.bare, { cacheDir: f.cacheDir, session });
    assert.equal(obs.commit, f.commit);
    const large = !PARTIAL_GIT; // an older git (#389) fetches every blob: the fallback is the assertion there
    assert.deepEqual(f.present("oats-membership.yaml", "souls/dev/soul.yaml", "elsewhere/tools/oats.json", "elsewhere/tools/data/model.bin", "assets/huge-1.bin"),
      { "oats-membership.yaml": true, "souls/dev/soul.yaml": true, "elsewhere/tools/oats.json": true, "elsewhere/tools/data/model.bin": large, "assets/huge-1.bin": large });
    if (PARTIAL_GIT) {
      assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "partial");
      assert.equal(git(f.repoDir, "config", "--get", "remote.origin.promisor"), "true");
      assert.deepEqual(session.notices, []);
    } else {
      assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
      assert.deepEqual(session.notices, [olderGitNotice()]);
    }
    assert.throws(() => git(f.repoDir, "config", "--get-all", "remote.origin.url"), "the url (it may carry credentials) is never written");
  } finally { await session.close(); }
});

test("listing never needs a blob: complete listings, no fetch, and rows carry no size", async () => {
  const f = fixture();
  const { fetches, exec } = counting();
  const opts = { cacheDir: f.cacheDir, exec };
  const listed = await listRemoteTree(f.bare, f.commit, "", { ...opts, depth: 3 });
  assert.deepEqual(listed.map((r) => r.path), ["assets", "assets/huge-1.bin", "assets/huge-2.bin", "elsewhere", "elsewhere/tools", "elsewhere/tools/data",
    "elsewhere/tools/oats.json", "oats-membership.yaml", "souls", "souls/dev", "souls/dev/AGENTS.md", "souls/dev/soul.yaml"]);
  assert.ok(listed.every((r) => !("size" in r)), "no row carries a size");
  assert.equal(fetches.length, 1, "only the commit's own fetch");
});

test("reading a small file costs no fetch; reading a large one fetches exactly that blob", { skip: skipPartialMechanics }, async () => {
  for (const withSession of [false, true]) {
    const f = fixture();
    const { fetches, exec } = counting();
    const session = withSession ? createReadSession() : undefined;
    const opts = { cacheDir: f.cacheDir, exec, ...(session ? { session } : {}) };
    try {
      assert.equal((await readRemoteFile(f.bare, f.commit, "souls/dev/soul.yaml", opts)).bytes.toString(), "name: dev\n");
      assert.equal(fetches.length, 1, "the commit's fetch only");
      const big = await readRemoteFile(f.bare, f.commit, "elsewhere/tools/data/model.bin", opts);
      assert.ok(big.bytes.equals(noise(SMALL_BLOB_LIMIT * 3, "model")));
      assert.equal(fetches.length, 2, "one more fetch, for that blob");
      assert.equal(fetches[1].input, `${f.blob("elsewhere/tools/data/model.bin")}\n`);
      assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": false }, "nothing else came with it");
      await readRemoteFile(f.bare, f.commit, "elsewhere/tools/data/model.bin", opts);
      assert.equal(fetches.length, 2, "a blob already fetched is never fetched again");
    } finally { await session?.close(); }
  }
});

test("listRemoteFiles (capability-show): every regular file below a dir with its real size, the sizes a partial cache lacks in ONE fetch; symlinks and gitlinks omitted", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  write(f.work, "elsewhere/tools/data/b.txt", "bee\n");
  write(f.work, "elsewhere/tools/data/second.bin", noise(SMALL_BLOB_LIMIT * 2, "second"));
  symlinkSync("oats.json", join(f.work, "elsewhere/tools/link"));
  git(f.work, "add", "-A");
  git(f.work, "update-index", "--add", "--cacheinfo", `160000,${f.commit},elsewhere/tools/sub`);
  git(f.work, "commit", "-q", "-m", "two"); git(f.work, "push", "-q", "origin", "HEAD:main");
  const c2 = git(f.work, "rev-parse", "HEAD");
  const large = [git(f.work, "rev-parse", "HEAD:elsewhere/tools/data/model.bin"), git(f.work, "rev-parse", "HEAD:elsewhere/tools/data/second.bin")];
  for (const withSession of [false, true]) {
    const { fetches, exec } = counting();
    const session = withSession ? createReadSession() : undefined;
    const opts = { cacheDir: join(f.base, `cache-${withSession}`), exec, ...(session ? { session } : {}) };
    try {
      const all = [
        { path: "data/b.txt", size: 4 }, { path: "data/model.bin", size: SMALL_BLOB_LIMIT * 3 }, { path: "data/second.bin", size: SMALL_BLOB_LIMIT * 2 },
        { path: "oats.json", size: Buffer.byteLength("{\"capability\":\"tools\"}\n") },
      ];
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "elsewhere/tools", opts), { files: all, total: 4 }, `the symlink and the gitlink are not listed (session: ${withSession})`);
      assert.equal(fetches.length, 2, "the commit, then ONE fetch for every size the cache lacked");
      assert.deepEqual(fetches[1].input.trim().split("\n").sort(), [...large].sort());
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "elsewhere/tools/data", opts), { files: [
        { path: "b.txt", size: 4 }, { path: "model.bin", size: SMALL_BLOB_LIMIT * 3 }, { path: "second.bin", size: SMALL_BLOB_LIMIT * 2 }], total: 3 });
      assert.equal(fetches.length, 2, "blobs already fetched are never fetched again");
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "elsewhere/tools", { ...opts, limit: 2 }), { files: all.slice(0, 2), total: 4 }, "a limit lists the first files, counts them all");
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "elsewhere/tools", { ...opts, limit: 0 }), { files: [], total: 4 });
      const none = { files: [], total: 0 };
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "nowhere", opts), none, "a missing dir lists nothing");
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "elsewhere/tools/oats.json", opts), none, "a file is not a dir");
      assert.deepEqual(await listRemoteFiles(f.bare, c2, "elsewhere/tools/link", opts), none, "a symlink is not a dir");
      for (const limit of [-1, 1.5, "2"]) {
        await assert.rejects(listRemoteFiles(f.bare, c2, "elsewhere/tools", { ...opts, limit }), (e) => e.code === "E_REPO_REF", String(limit));
      }
    } finally { await session?.close(); }
  }
});

test("listRemoteFiles with a limit (#409): only the first `limit` blobs by path are fetched to learn their sizes, in ONE fetch; total counts them all", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  const count = 203, limit = 200;
  const names = Array.from({ length: count }, (_, i) => `f${String(i).padStart(3, "0")}.bin`);
  for (const name of names) write(f.work, `crowded/${name}`, noise(SMALL_BLOB_LIMIT + 1, name)); // every blob above the partial filter
  git(f.work, "add", "-A"); git(f.work, "commit", "-q", "-m", "crowded"); git(f.work, "push", "-q", "origin", "HEAD:main");
  const c2 = git(f.work, "rev-parse", "HEAD");
  const ids = names.map((n) => git(f.work, "rev-parse", `HEAD:crowded/${n}`));
  for (const withSession of [false, true]) {
    const { fetches, exec } = counting();
    const session = withSession ? createReadSession() : undefined;
    const opts = { cacheDir: join(f.base, `cache-cap-${withSession}`), exec, ...(session ? { session } : {}) };
    try {
      const listed = await listRemoteFiles(f.bare, c2, "crowded", { ...opts, limit });
      assert.deepEqual(listed, { files: names.slice(0, limit).map((path) => ({ path, size: SMALL_BLOB_LIMIT + 1 })), total: count });
      assert.equal(fetches.length, 2, `the commit, then ONE fetch (session: ${withSession})`);
      assert.deepEqual(fetches[1].input.trim().split("\n").sort(), ids.slice(0, limit).sort(), "exactly the first 200 blob ids");
      const present = (oid) => !gitInput(join(opts.cacheDir, createHash("sha256").update(parseRepoRef(f.bare).key).digest("hex")), `${oid}\n`, "cat-file", "--batch-check").endsWith(" missing");
      assert.deepEqual(ids.slice(limit).map(present), [false, false, false], "nothing past the limit was fetched");
    } finally { await session?.close(); }
  }
});

test("listRemoteFiles with a limit still refuses an unsafe name past it: the scan covers every entry", async () => {
  const f = fixture();
  const run = (input, ...args) => execFileSync("git", args, { cwd: f.work, env: GIT_ENV, input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim();
  const blob = run("x\n", "hash-object", "-w", "--stdin");
  const mkTree = (entries) => run(Buffer.concat(entries.map(({ mode, name, oid }) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]))), "hash-object", "-w", "-t", "tree", "--stdin", "--literally");
  const bad = mkTree([{ mode: "100644", name: ".git", oid: blob }]);
  const dir = mkTree([{ mode: "100644", name: "a.md", oid: blob }, { mode: "100644", name: "b.md", oid: blob }, { mode: "040000", name: "zzz", oid: bad }]);
  const c = run("", "commit-tree", mkTree([{ mode: "040000", name: "skill", oid: dir }]), "-m", "unsafe past the limit");
  git(f.work, "push", "-q", "origin", `${c}:refs/heads/unsafe-late`);
  for (const session of [undefined, createReadSession()]) {
    try {
      const e = await listRemoteFiles(f.bare, c, "skill", { cacheDir: f.cacheDir, limit: 1, ...(session ? { session } : {}) }).then(() => assert.fail("expected a refusal"), (x) => x);
      assert.deepEqual([e.code, e.details.path], ["E_REMOTE_TREE_UNSAFE", "skill/zzz/.git"]);
    } finally { await session?.close(); }
  }
});

test("listRemoteFiles refuses an entry name that could escape a checkout anywhere below the dir (E_REMOTE_TREE_UNSAFE)", async () => {
  const f = fixture();
  const run = (input, ...args) => execFileSync("git", args, { cwd: f.work, env: GIT_ENV, input, stdio: ["pipe", "pipe", "pipe"] }).toString("utf8").trim();
  const blob = run("x\n", "hash-object", "-w", "--stdin");
  const mkTree = (entries) => run(Buffer.concat(entries.map(({ mode, name, oid }) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")]))), "hash-object", "-w", "-t", "tree", "--stdin", "--literally");
  for (const bad of [".git", ".GIT", "..", "a\\b"]) {
    const deep = mkTree([{ mode: "100644", name: bad, oid: blob }]);
    const skill = mkTree([{ mode: "100644", name: "SKILL.md", oid: blob }, { mode: "040000", name: "deep", oid: deep }]);
    const c = run("", "commit-tree", mkTree([{ mode: "040000", name: "skill", oid: skill }]), "-m", "unsafe");
    git(f.work, "push", "-q", "origin", `${c}:refs/heads/unsafe-${c.slice(0, 8)}`);
    for (const session of [undefined, createReadSession()]) {
      try {
        const e = await listRemoteFiles(f.bare, c, "skill", { cacheDir: f.cacheDir, ...(session ? { session } : {}) }).then(() => assert.fail(`expected a refusal of ${bad}`), (x) => x);
        assert.equal(e.code, "E_REMOTE_TREE_UNSAFE", bad);
        assert.deepEqual({ why: e.details.why, path: e.details.path }, { why: "path", path: `skill/deep/${bad}` });
      } finally { await session?.close(); }
    }
  }
});

test("materializing a directory fetches its missing blobs in ONE fetch, and digests like a checkout", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  const { fetches, exec } = counting();
  const opts = { cacheDir: f.cacheDir, exec };
  await observeRemote(f.bare, { ...opts, at: f.commit });
  const dest = join(f.base, "out", "tools");
  const r = await fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", dest, opts);
  assert.equal(fetches.length, 2, "the commit, then one fetch for the directory");
  assert.equal(r.digest, contentDigest(join(f.work, "elsewhere", "tools")));
  assert.equal(r.files, 2);
  assert.deepEqual(f.present("assets/huge-1.bin", "assets/huge-2.bin"), { "assets/huge-1.bin": false, "assets/huge-2.bin": false });
});

test("an unknown size never passes a budget: a missing blob is fetched, then FILE_BUDGET and TREE_BUDGET apply before any write", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  write(f.work, "big/over.bin", noise(FILE_BUDGET + 1, "over"));
  git(f.work, "add", "-A"); git(f.work, "commit", "-q", "-m", "two"); git(f.work, "push", "-q", "origin", "HEAD:main");
  const c2 = git(f.work, "rev-parse", "HEAD");
  const opts = { cacheDir: f.cacheDir };
  await observeRemote(f.bare, { ...opts, at: c2 });
  // What git itself reports for a blob the cache lacks: the size is "BAD", and the listing still succeeds.
  assert.match(gitInput(f.repoDir, "", "ls-tree", "-l", c2, "big/over.bin"), /\sBAD\tbig\/over\.bin$/);
  const e = await readRemoteFile(f.bare, c2, "big/over.bin", opts).then(() => assert.fail("expected oversize"), (x) => x);
  assert.equal(e.code, "E_REMOTE_FILE_OVERSIZE");
  assert.equal(e.details.size, FILE_BUDGET + 1);
  // fetchRemoteTree: the sizes it budgets are the fetched blobs' real sizes, never NaN.
  const { fetches, exec } = counting();
  const dest = join(f.base, "out", "big");
  const r = await fetchRemoteTree(f.bare, c2, "big", dest, { ...opts, exec });
  assert.equal(r.bytes, FILE_BUDGET + 1);
  assert.equal(fetches.length, 0, "the blob fetched for the refused read is not fetched again");
});

test("a read whose blob was not fetched fails loudly: git never fetches lazily from a cache", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  await observeRemote(f.bare, { cacheDir: f.cacheDir });
  const e = await runGit(["-C", f.repoDir, "cat-file", "blob", f.blob("assets/huge-1.bin")]).then(() => assert.fail("expected a failure"), (x) => x);
  assert.match(e.stderr.toString(), new RegExp(`${f.blob("assets/huge-1.bin")}: bad file`));
  assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": false }, "and nothing was fetched");
});

test("a cache filled by whole-tree fetches keeps working and fetches the next commit partially", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  mkdirSync(f.repoDir, { recursive: true });
  git(f.base, "init", "-q", "--bare", f.repoDir);
  git(f.repoDir, "fetch", "-q", "--depth", "1", "--no-tags", f.bare, f.commit);
  git(f.repoDir, "update-ref", `refs/oats/commits/${f.commit}`, f.commit);
  const { fetches, exec } = counting();
  const opts = { cacheDir: f.cacheDir, exec };
  assert.ok((await readRemoteFile(f.bare, f.commit, "assets/huge-1.bin", opts)).bytes.equals(noise(SMALL_BLOB_LIMIT * 4, "huge-1")));
  assert.equal(fetches.length, 0, "every blob is already there");
  write(f.work, "assets/huge-3.bin", noise(SMALL_BLOB_LIMIT * 4, "huge-3"));
  git(f.work, "add", "-A"); git(f.work, "commit", "-q", "-m", "two"); git(f.work, "push", "-q", "origin", "HEAD:main");
  const c2 = git(f.work, "rev-parse", "HEAD");
  await observeRemote(f.bare, { ...opts, at: c2 });
  assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "partial");
  assert.equal(gitInput(f.repoDir, `${git(f.work, "rev-parse", "HEAD:assets/huge-3.bin")}\n`, "cat-file", "--batch-check").endsWith(" missing"), true);
});

// ---------------------------------------------------------------------------
// servers that cannot serve partial fetches
// ---------------------------------------------------------------------------

test("a server without filters: whole trees, recorded per cache, said once in the session's notices", { skip: skipPartialMechanics }, async () => {
  const f = fixture("plain");
  const session = createReadSession();
  try {
    const opts = { cacheDir: f.cacheDir, session };
    assert.equal((await readRemoteFile(f.bare, f.commit, "elsewhere/tools/data/model.bin", opts)).bytes.length, SMALL_BLOB_LIMIT * 3);
    assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": true }, "the whole tree arrived");
    assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
    write(f.work, "x.txt", "x\n");
    git(f.work, "add", "-A"); git(f.work, "commit", "-q", "-m", "two"); git(f.work, "push", "-q", "origin", "HEAD:main");
    await observeRemote(f.bare, { ...opts, at: git(f.work, "rev-parse", "HEAD") });
    assert.deepEqual(session.notices, [`${f.bare} does not serve partial fetches; OATS fetches whole trees from it`]);
  } finally { await session.close(); }
  // A later command does not say it again: the cache remembers.
  const later = createReadSession();
  try {
    await readRemoteFile(f.bare, f.commit, "souls/dev/soul.yaml", { cacheDir: f.cacheDir, session: later });
    assert.deepEqual(later.notices, []);
  } finally { await later.close(); }
});

test("a server that filters but refuses blob wants: the commit is fetched again in full, recorded, said once", { skip: skipPartialMechanics }, async () => {
  const f = fixture("no-blob-wants");
  await withGlobalGitConfig(f.base, "[protocol]\n\tversion = 0\n", async () => {
    const session = createReadSession();
    try {
      const opts = { cacheDir: f.cacheDir, session };
      await observeRemote(f.bare, { ...opts, at: f.commit });
      assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": false }, "the filter was honoured");
      const r = await readRemoteFile(f.bare, f.commit, "elsewhere/tools/data/model.bin", opts);
      assert.ok(r.bytes.equals(noise(SMALL_BLOB_LIMIT * 3, "model")));
      assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
      assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": true }, "the refetch brought the whole tree");
      const dest = join(f.base, "out", "tools");
      assert.equal((await fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", dest, opts)).digest, contentDigest(join(f.work, "elsewhere", "tools")));
      assert.deepEqual(session.notices, [`${f.bare} does not serve partial fetches; OATS fetches whole trees from it`]);
    } finally { await session.close(); }
  });
});

test("without a session a fallback is recorded and nothing is printed", async () => {
  const f = fixture("plain");
  assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir })).commit, f.commit);
  assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
});

// ---------------------------------------------------------------------------
// a git too old to keep a partial cache honest
// ---------------------------------------------------------------------------

/** An exec that runs real git but answers `git --version` as `version` (an older git than the one installed). */
const olderGit = (version) => (args, o) => args.length === 1 && args[0] === "--version"
  ? Promise.resolve({ stdout: Buffer.from(`git version ${version}\n`), stderr: Buffer.alloc(0) })
  : runGit(args, o);

test(`a git older than ${PARTIAL_FETCH_GIT.join(".")} (no GIT_NO_LAZY_FETCH) fetches whole trees, recorded per cache, said once`, async () => {
  const f = fixture();
  const fetches = [];
  const older = olderGit("2.43.0");
  const exec = (args, o) => { if (args.includes("fetch")) fetches.push(args); return older(args, o); };
  const session = createReadSession();
  try {
    const opts = { cacheDir: f.cacheDir, exec, session };
    assert.ok((await readRemoteFile(f.bare, f.commit, "elsewhere/tools/data/model.bin", opts)).bytes.equals(noise(SMALL_BLOB_LIMIT * 3, "model")));
    assert.ok(fetches.length > 0 && fetches.every((a) => !a.some((x) => x.startsWith("--filter"))), `no fetch asks the (partial-capable) server for a filter: ${JSON.stringify(fetches)}`);
    assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": true }, "a whole tree, never a partial one");
    assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
    assert.deepEqual(session.notices, [olderGitNotice("2.43.0")]);
  } finally { await session.close(); }
});

test(`a git older than ${PARTIAL_FETCH_GIT.join(".")} says so once per session, however many caches it starts or rebuilds`, async () => {
  const a = fixture(), b = fixture(), c = fixture();
  // c's cache exists before the session: partial where this git keeps one, so the older git must rebuild it.
  await observeRemote(c.bare, { cacheDir: c.cacheDir, at: c.commit });
  assert.equal(git(c.repoDir, "config", "--get", "oats.fetch"), PARTIAL_GIT ? "partial" : "full");
  const exec = olderGit("2.43.0");
  const session = createReadSession();
  try {
    for (const f of [a, b, c]) {
      assert.ok((await readRemoteFile(f.bare, f.commit, "elsewhere/tools/data/model.bin", { cacheDir: f.cacheDir, exec, session })).bytes.equals(noise(SMALL_BLOB_LIMIT * 3, "model")));
      assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full", "every cache records whole-tree fetches");
    }
    assert.deepEqual(c.present("assets/huge-1.bin"), { "assets/huge-1.bin": true }, "the rebuilt cache holds the whole tree");
    assert.deepEqual(session.notices, [olderGitNotice("2.43.0")], "one line for two new caches and a rebuild");
  } finally { await session.close(); }
});

test(`the kernel's git probe: a partial cache from ${PARTIAL_FETCH_GIT.join(".")} on, never from an older or unreadable git`, async () => {
  for (const [text, keeps] of [["2.44.9", false], ["2.45.0", true], ["2.45.0.windows.1", true], ["2.54.0", true], ["3.0.0", true], ["1.99.0", false]]) {
    assert.equal(keepsPartialCache(await gitVersion(olderGit(text))), keeps, text);
  }
  assert.equal(await gitVersion((args, o) => Promise.reject(new Error("no git"))), null);
  assert.equal(keepsPartialCache(null), false);
});

test("a partial cache met by an older git is rebuilt with whole trees, and reads keep working", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit });
  assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "partial");
  const exec = olderGit("2.39.5");
  const opts = { cacheDir: f.cacheDir, exec };
  assert.ok((await readRemoteFile(f.bare, f.commit, "assets/huge-2.bin", opts)).bytes.equals(noise(SMALL_BLOB_LIMIT * 4, "huge-2")));
  assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
  assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": true });
  const dest = join(f.base, "out", "tools");
  assert.equal((await fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", dest, opts)).digest, contentDigest(join(f.work, "elsewhere", "tools")));
});

// ---------------------------------------------------------------------------
// two processes on one fresh cache
// ---------------------------------------------------------------------------

/** Run observeRemote(bare, { cacheDir, at: commit }) in `n` separate processes at once → each one's printed outcome. */
function firstFetchRace(f, n) {
  const script = `import { observeRemote } from ${JSON.stringify(new URL("../lib/remote.mjs", import.meta.url).href)};
    try { const r = await observeRemote(process.argv[1], { cacheDir: process.argv[2], at: process.argv[3] }); console.log(r.commit); }
    catch (e) { console.log(\`FAIL \${e.code} \${e.details?.reason} \${e.message}\`); }`;
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, f.bare, f.cacheDir, f.commit], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => resolve(out.trim()));
  });
  return Promise.all(Array.from({ length: n }, run));
}

// awebai/oats#386: processes making the first fetch of one cache at once (two spawns, two Desktop previews) all
// succeed — the cache's `git init`, its config and its pins are each written by whichever gets there first, and
// a lost race is never an error, let alone a "network" one.
test("processes making the first fetch of one cache all succeed: git init included, then config and pins (#386)", { timeout: 300_000 }, async () => {
  const f = fixture();
  for (let round = 0; round < 6; round++) {
    rmSync(f.cacheDir, { recursive: true, force: true });
    assert.deepEqual(await firstFetchRace(f, 6), Array(6).fill(f.commit), `round ${round}`);
    assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), PARTIAL_GIT ? "partial" : "full");
    assert.equal(git(f.repoDir, "rev-parse", `refs/oats/commits/${f.commit}`), f.commit);
    assert.deepEqual(readdirSync(f.cacheDir).filter((n) => n.includes(".init-") || n.includes(".stale-")), [], "no private init directory left");
  }
});

test("processes making the first fetch of an already-initialised cache all succeed (git's config lock is a race, not a failure)", { timeout: 300_000 }, async () => {
  const f = fixture();
  for (let round = 0; round < 4; round++) {
    rmSync(f.repoDir, { recursive: true, force: true });
    mkdirSync(f.repoDir, { recursive: true });
    git(f.base, "init", "-q", "--bare", f.repoDir);
    assert.deepEqual(await firstFetchRace(f, 4), Array(4).fill(f.commit), `round ${round}`);
    assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), PARTIAL_GIT ? "partial" : "full");
  }
});

/** Hold `<repoDir>/<ref>.lock` as a concurrent writer would; `release()` removes it. */
function holdRefLock(f, ref) {
  const lock = join(f.repoDir, `${ref}.lock`);
  mkdirSync(join(lock, ".."), { recursive: true });
  writeFileSync(lock, "");
  return { lock, release: () => rmSync(lock, { force: true }) };
}

test("a pin whose ref another process holds locked is written once the lock is released (update-ref retries a lost race)", async () => {
  const f = fixture();
  git(f.base, "init", "-q", "--bare", f.repoDir);
  const held = holdRefLock(f, `refs/oats/commits/${f.commit}`);
  setTimeout(held.release, 2_000); // held past the fetch: the pin meets it
  const r = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit });
  assert.equal(r.commit, f.commit);
  assert.equal(git(f.repoDir, "rev-parse", `refs/oats/commits/${f.commit}`), f.commit);
});

test("a pin another process already wrote with the same value counts as written, even while its lock is still held", async () => {
  const f = fixture();
  git(f.base, "init", "-q", "--bare", f.repoDir);
  // The other writer's result (a loose ref holding the commit) and its lock, not yet removed.
  mkdirSync(join(f.repoDir, "refs", "oats", "commits"), { recursive: true });
  writeFileSync(join(f.repoDir, "refs", "oats", "commits", f.commit), `${f.commit}\n`);
  const held = holdRefLock(f, `refs/oats/commits/${f.commit}`);
  try {
    assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit })).commit, f.commit);
  } finally { held.release(); }
});

test("a stale pin lock (its process died) fails bounded, as reason cache naming the cache directory — never network", async () => {
  const f = fixture();
  git(f.base, "init", "-q", "--bare", f.repoDir);
  const held = holdRefLock(f, `refs/oats/commits/${f.commit}`);
  try {
    const started = Date.now();
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit }).then(() => assert.fail("expected a failure"), (x) => x);
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.equal(e.details.reason, "cache");
    assert.equal(e.details.stage, "pin");
    assert.equal(e.details.cacheDir, f.repoDir);
    const lock = join(f.repoDir, "refs", "oats", "commits", `${f.commit}.lock`);
    assert.equal(e.details.lock.replace(/^\/private\//, "/"), lock.replace(/^\/private\//, "/"), "the lock file, named");
    assert.ok(e.message.includes(e.details.lock), e.message);
    assert.match(e.message, /\(cache, pin\): .*\.lock is still held by another git process, or left by one that died; it is safe to remove once no oats or git process is running$/);
    assert.ok(Date.now() - started < 15_000, "bounded wait (LOCK_WAIT_MS), never unbounded");
  } finally { held.release(); }
  // Once the lock is gone the next read pins and succeeds.
  assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit })).commit, f.commit);
});

test("a half-initialised cache directory (no HEAD: a crash's leftover) is replaced, never wedging the cache", async () => {
  const f = fixture();
  mkdirSync(join(f.repoDir, "objects"), { recursive: true });
  writeFileSync(join(f.repoDir, "config"), "[core]\n");
  const r = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit });
  assert.equal(r.commit, f.commit);
  assert.equal(git(f.repoDir, "rev-parse", `refs/oats/commits/${f.commit}`), f.commit);
  assert.deepEqual(readdirSync(f.cacheDir).filter((n) => n.includes(".init-") || n.includes(".stale-")), []);
  // An empty directory (an older kernel's mkdir before its init) is simply taken.
  const g = fixture();
  mkdirSync(g.repoDir, { recursive: true });
  assert.equal((await observeRemote(g.bare, { cacheDir: g.cacheDir, at: g.commit })).commit, g.commit);
});

test("a cache init that fails is reason cache, stage init, naming the directory — never network", async () => {
  const f = fixture();
  const exec = (args, o) => (args[0] === "init" ? Promise.reject(Object.assign(new Error("init failed"), { code: 128, stderr: Buffer.from("fatal: cannot mkdir: Permission denied\n") })) : runGit(args, o));
  const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, exec }).then(() => assert.fail("expected a failure"), (x) => x);
  assert.equal(e.code, "E_REMOTE_UNREADABLE");
  assert.deepEqual([e.details.reason, e.details.stage, e.details.cacheDir], ["cache", "init", f.repoDir]);
  assert.match(e.message, /^cannot write the cache of .* at .* \(cache, init\): fatal: cannot mkdir: Permission denied$/, "git's own words");
  assert.equal(existsSync(f.repoDir), false, "nothing half-made in its place");
  assert.deepEqual(readdirSync(f.cacheDir), [".locks"], "only the write locks' directory");
  assert.deepEqual(readdirSync(join(f.cacheDir, ".locks")), [], "the write lock was released");
});

test("classifyRemoteFailure: a git lock still held is cache, never network; a timeout stays timeout", () => {
  const lock = (text) => Object.assign(new Error("x"), { code: 128, stderr: Buffer.from(text) });
  assert.equal(classifyRemoteFailure(lock("fatal: Unable to create '/c/refs/oats/commits/a.lock': File exists.\n")), "cache");
  assert.equal(classifyRemoteFailure(lock("error: could not lock config file /c/config: File exists\n")), "cache");
  assert.equal(classifyRemoteFailure(lock("fatal: unable to access 'https://h/r/': Could not resolve host: h\n")), "network");
  assert.equal(classifyRemoteFailure({ ...lock("Unable to create 'x.lock': File exists"), timedOut: true }), "timeout");
});
// ---------------------------------------------------------------------------
// #386 addendum: the cache write lock, stale git locks, and the graceful kill
// ---------------------------------------------------------------------------

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);
/** A git lock file `rel` in the cache repo, as a git killed mid-write leaves it; `old` dates it past the longest fetch. */
function leftoverGitLock(f, rel, { old = true } = {}) {
  const file = join(f.repoDir, rel);
  writeFileSync(file, "");
  if (old) utimesSync(file, HOUR_AGO(), HOUR_AGO());
  return file;
}
const initCache = (f) => { mkdirSync(f.cacheDir, { recursive: true }); git(f.base, "init", "-q", "--bare", f.repoDir); };

test("a killed fetch's shallow.lock (older than the longest fetch) is removed under the write lock, said once, and the fetch succeeds", async () => {
  const f = fixture();
  initCache(f);
  const lock = leftoverGitLock(f, "shallow.lock");
  const session = createReadSession();
  try {
    const r = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session });
    assert.equal(r.commit, f.commit);
    assert.equal(existsSync(lock), false, "the stale lock is gone");
    assert.equal(session.notices.length, 1);
    assert.match(session.notices[0], /^removed a stale git lock .*shallow\.lock \(left by a git process that was killed mid-write\)$/);
  } finally { await session.close(); }
  // Only a lock git names is ever removed: fetchRemoteTree's blob fetch (no shallow update) never meets this one,
  // copies the tree, and leaves it alone.
  const g = fixture();
  await observeRemote(g.bare, { cacheDir: g.cacheDir, at: g.commit });
  const lock2 = leftoverGitLock(g, "shallow.lock");
  const s2 = createReadSession();
  try {
    const r = await fetchRemoteTree(g.bare, g.commit, "elsewhere/tools", join(g.base, "out", "tools"), { cacheDir: g.cacheDir, session: s2 });
    assert.equal(r.digest, contentDigest(join(g.work, "elsewhere", "tools")));
    assert.equal(existsSync(lock2), true, "a lock no write met is not touched");
    assert.deepEqual(s2.notices, []);
  } finally { await s2.close(); }
});

test("a young git lock (it may be an older oats's live fetch) is never removed: reason cache, naming the file and what to do", async () => {
  const f = fixture();
  initCache(f);
  const lock = leftoverGitLock(f, "shallow.lock", { old: false });
  const session = createReadSession();
  try {
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session }).then(() => assert.fail("expected a refusal"), (x) => x);
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.equal(e.details.reason, "cache");
    assert.equal(e.details.stage, "fetch");
    assert.ok(e.message.includes(e.details.lock) && e.details.lock.endsWith("/shallow.lock"), e.message);
    assert.match(e.message, /is still held by another git process, or left by one that died; it is safe to remove once no oats or git process is running$/);
    assert.equal(existsSync(lock), true, "never deleted");
    assert.deepEqual(session.notices, []);
  } finally { await session.close(); }
});

test("a symlinked git lock is never removed, whatever its age, and neither is what it points to", async () => {
  const f = fixture();
  initCache(f);
  const target = join(f.base, "outside.txt");
  writeFileSync(target, "keep me\n");
  const link = join(f.repoDir, "shallow.lock");
  symlinkSync(target, link);
  lutimesSync(link, HOUR_AGO(), HOUR_AGO());
  const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit }).then(() => assert.fail("expected a refusal"), (x) => x);
  assert.equal(e.details.reason, "cache");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "the link is left");
  assert.equal(readFileSync(target, "utf8"), "keep me\n", "its target is untouched");
});

test("a git lock git names OUTSIDE the cache repo is never removed", async () => {
  const f = fixture();
  initCache(f);
  const outside = join(f.base, "elsewhere.lock");
  writeFileSync(outside, "");
  utimesSync(outside, HOUR_AGO(), HOUR_AGO());
  // A git whose fetch reports a lock outside the cache (a hostile or confused path): only that report is faked.
  const dir = join(f.base, "outside-shim");
  mkdirSync(dir, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/bash\nfor a in "$@"; do if [ "$a" = "fetch" ]; then echo "fatal: Unable to create '${outside}': File exists." >&2; exit 128; fi; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit }).then(() => assert.fail("expected a refusal"), (x) => x);
    assert.equal(e.details.reason, "cache");
    assert.equal(e.details.lock, outside);
  } finally { process.env.PATH = saved; }
  assert.equal(existsSync(outside), true, "never deleted");
});

/** The cache repo's write lock file, held by `pid` (a JSON owner as this kernel writes it), with the
 *  holder's `identity` (`{ bootId, processStart }`) when given; without it, the record an earlier kernel writes. */
function holdWriteLock(f, pid, identity = {}) {
  const lock = join(f.cacheDir, ".locks", `${f.repoDir.split("/").pop()}.lock`);
  mkdirSync(join(lock, ".."), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid, token: "t".repeat(24), startedAt: "2026-10-01T00:00:00.000Z", ...identity }) + "\n");
  return lock;
}
/** The refusal a write lock held past the deadline ends in: the holder's pid, and how to tell whether the lock is safe to remove. */
const heldLockRefusal = (pid, lock) => new RegExp(`(?<!oats )process ${pid} has been writing it since .*; try again once it finishes; check whether pid ${pid} is an oats process: once no oats process holds it, the lock ${lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is safe to remove$`);

test("a live holder of the cache write lock is waited for (bounded) and never stolen from: reason cache naming its pid", async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const lock = holdWriteLock(f, holder.pid);
    const before = readFileSync(lock, "utf8");
    const session = createReadSession({ cacheWriteWaitMs: 800 });
    const started = Date.now();
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session }).then(() => assert.fail("expected a refusal"), (x) => x);
    await session.close();
    assert.ok(Date.now() - started >= 700, "it waited");
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.deepEqual([e.details.reason, e.details.stage, e.details.holderPid, e.details.lock], ["cache", "fetch", holder.pid, lock]);
    assert.match(e.message, heldLockRefusal(holder.pid, lock));
    assert.equal(readFileSync(lock, "utf8"), before, "the live holder's lock is untouched");
    assert.equal(existsSync(f.repoDir), false, "nothing was written");
  } finally { holder.kill(); }
});

test("a live holder named by its boot and start is waited for (bounded) and never stolen from: reason cache naming its pid", async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => holder.on("spawn", r));
    const lock = holdWriteLock(f, holder.pid, { bootId: thisBoot(), processStart: processStartToken(holder.pid) });
    const before = readFileSync(lock, "utf8");
    const session = createReadSession({ cacheWriteWaitMs: 800 });
    const started = Date.now();
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session }).then(() => assert.fail("expected a refusal"), (x) => x);
    await session.close();
    assert.ok(Date.now() - started >= 700, "it waited");
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.deepEqual([e.details.reason, e.details.stage, e.details.holderPid, e.details.lock], ["cache", "fetch", holder.pid, lock]);
    assert.match(e.message, heldLockRefusal(holder.pid, lock));
    assert.equal(readFileSync(lock, "utf8"), before, "the live holder's lock is untouched");
    assert.equal(existsSync(f.repoDir), false, "nothing was written");
  } finally { holder.kill(); }
});

test("a cache write lock taken in another boot is reclaimed at once, though its pid is alive with the recorded start", async () => {
  const f = fixture();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    await new Promise((r) => holder.on("spawn", r));
    const lock = holdWriteLock(f, holder.pid, { bootId: `another-boot-than-${thisBoot()}`, processStart: processStartToken(holder.pid) });
    // A lock waited for to the deadline is refused: a write that succeeds reclaimed it.
    const session = createReadSession({ cacheWriteWaitMs: 10_000 });
    const r = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session });
    await session.close();
    assert.equal(r.commit, f.commit);
    assert.equal(existsSync(lock), false, "reclaimed, then released");
  } finally { holder.kill(); }
});

test("a cache write lock whose pid runs with another start (a reused pid) is reclaimed at once", async () => {
  const f = fixture();
  // This process's own pid, recorded with a start it never had: the pid of a holder that is gone, now another process's.
  const lock = holdWriteLock(f, process.pid, { bootId: thisBoot(), processStart: "proc:1" });
  // A lock waited for to the deadline is refused: a write that succeeds reclaimed it.
  const session = createReadSession({ cacheWriteWaitMs: 10_000 });
  const r = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session });
  await session.close();
  assert.equal(r.commit, f.commit);
  assert.equal(existsSync(lock), false, "reclaimed, then released");
});

test("the cache write lock this kernel takes names its holder by pid, token, start, boot and process start", async () => {
  const f = fixture();
  const lockDir = join(f.cacheDir, ".locks");
  const seen = [];
  const watcher = setInterval(() => {
    try { for (const n of readdirSync(lockDir)) if (n.endsWith(".lock")) seen.push(JSON.parse(readFileSync(join(lockDir, n), "utf8"))); } catch { /* not yet */ }
  }, 1);
  try { await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit }); } finally { clearInterval(watcher); }
  assert.ok(seen.length > 0, "the lock was seen while held");
  const [record] = seen;
  assert.deepEqual(Object.keys(record).sort(), ["bootId", "pid", "processStart", "startedAt", "token"]);
  assert.deepEqual([record.pid, record.bootId, record.processStart], [process.pid, thisBoot(), processStartToken(process.pid)]);
});

test("a dead holder's cache write lock is reclaimed at once, and the fetch proceeds", async () => {
  const f = fixture();
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => dead.on("close", r));
  const lock = holdWriteLock(f, dead.pid);
  const r = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit });
  assert.equal(r.commit, f.commit);
  assert.equal(existsSync(lock), false, "reclaimed, then released");
});

test("a fetch our own timer ends gets SIGTERM first: git's lock files are cleaned up, and the failure is still reason timeout", async () => {
  const f = fixture();
  initCache(f);
  // A git whose fetch holds a lock file the way git does: removed on SIGTERM (git's lockfile signal cleanup), never on SIGKILL.
  const lock = join(f.repoDir, "shallow.lock");
  const dir = join(f.base, "slow-shim");
  mkdirSync(dir, { recursive: true });
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/bash
for a in "$@"; do if [ "$a" = "fetch" ]; then
  trap 'rm -f "${lock}"; exit 143' TERM
  : > "${lock}"
  sleep 30 & wait
fi; done
exec "${real}" "$@"
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  const session = createReadSession({ fetchTimeoutMs: 500 });
  try {
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session }).then(() => assert.fail("expected a timeout"), (x) => x);
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.equal(e.details.reason, "timeout", "our own timer's kill is a timeout, whichever signal ended git");
    for (let i = 0; i < 50 && existsSync(lock); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(lock), false, "git cleaned up its lock: it was sent SIGTERM, not SIGKILL");
  } finally { process.env.PATH = saved; await session.close(); }
});

// ---------------------------------------------------------------------------
// #386 review regressions
// ---------------------------------------------------------------------------

test("two processes reclaiming one dead write lock never both write: one paused before its unlink cannot delete the other's live lock", { timeout: 120_000 }, async () => {
  const base = scratch();
  const script = new URL("./fixtures/remote-reclaim/reclaimer.mjs", import.meta.url).pathname;
  const remoteUrl = new URL("../lib/remote.mjs", import.meta.url).href;
  const code = await new Promise((r) => spawn(process.execPath, [script, "A", remoteUrl, base], { stdio: "inherit" }).on("close", r));
  assert.equal(code, 0);
  const report = JSON.parse(execFileSync("cat", [join(base, "report.json")], { encoding: "utf8" }));
  assert.deepEqual(report, { bActiveDuringPause: false, simultaneous: false, lockLeft: false },
    "B could not take the lock while A was paused inside the reclaim, the two never fetched at once, and both released");
});

test("a reclaim guard left by a reclaimer that died is never removed: every contender refuses at once naming it, none writes; removed by hand, the cache heals", { timeout: 60_000 }, async () => {
  const f = fixture();
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => dead.on("close", r));
  const lock = holdWriteLock(f, dead.pid);
  const guard = `${lock}.reclaim`;
  writeFileSync(guard, JSON.stringify({ pid: dead.pid, token: "g".repeat(24) }) + "\n");
  const remoteUrl = new URL("../lib/remote.mjs", import.meta.url).href;
  // Three processes meet the dead lock and the dead guard at once (the interleaving where removing a dead guard
  // let two reclaimers each delete the other's live guard, then lock, and both fetch).
  const code = `const { observeRemote } = await import(${JSON.stringify(remoteUrl)});
    try { await observeRemote(${JSON.stringify(f.bare)}, { cacheDir: ${JSON.stringify(f.cacheDir)}, at: ${JSON.stringify(f.commit)} }); console.log(JSON.stringify({ ok: true })); }
    catch (e) { console.log(JSON.stringify({ code: e.code, details: e.details, message: e.message })); }`;
  const started = Date.now();
  const outs = await Promise.all([0, 1, 2].map(() => new Promise((r) => {
    let out = "";
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    c.stdout.on("data", (d) => { out += d; });
    c.on("close", () => r(JSON.parse(out)));
  })));
  assert.ok(Date.now() - started < 15_000, "refused at once, not at the write deadline");
  for (const e of outs) {
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.deepEqual([e.details.reason, e.details.stage, e.details.guard, e.details.lock, e.details.holderPid], ["cache", "fetch", guard, lock, dead.pid]);
    assert.ok(e.message.endsWith(`: ${guard} was left by oats process ${dead.pid}, which died while reclaiming the write lock ${lock}; it is safe to remove once no oats process is running`), e.message);
  }
  assert.equal(existsSync(guard), true, "no contender removes the guard");
  assert.equal(readFileSync(lock, "utf8").includes(`"pid":${dead.pid}`), true, "nor the lock it guards");
  assert.equal(existsSync(join(f.repoDir, "HEAD")), false, "and none wrote the cache");
  rmSync(guard);
  assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit })).commit, f.commit, "the dead lock is then reclaimed");
  assert.equal(existsSync(lock), false);
});

/** Record every process.kill to a group (a negative pid) while `fn` runs. */
async function spyGroupKills(fn) {
  const kills = [], real = process.kill;
  process.kill = function (pid, signal) { if (pid < 0) kills.push([-pid, signal]); return real.call(process, pid, signal); };
  try { await fn(kills); } finally { process.kill = real; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("terminateGroup sends no SIGKILL to a group that closed within the grace, and no signal at all once closed (its id may be reused)", async () => {
  const { terminateGroup, watchGroup } = await import("../lib/process-group.mjs");
  await spyGroupKills(async (kills) => {
    const child = watchGroup(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] }));
    await new Promise((r) => child.once("spawn", r));
    assert.equal(terminateGroup(child, 300), true);
    await new Promise((r) => child.once("close", r));
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(kills.filter(([, sig]) => sig !== 0), [[child.pid, "SIGTERM"]], "the group was empty at close: no SIGKILL");
    assert.equal(terminateGroup(child, 300), false);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(kills, [[child.pid, "SIGTERM"], [child.pid, 0]], "a closed child's group is never signalled again (one probe, at its close)");
  });
});

/** A detached leader that starts a descendant in its group; the descendant handles SIGTERM with `onTerm` (code). The
 *  leader ends on SIGTERM. `pipes`: the leader's stdio are pipes and the descendant inherits them (an ssh, a remote
 *  helper); else the descendant holds none (stdio "ignore"), so the leader's 'close' comes while it still runs. */
async function groupWithDescendant(onTerm, { pipes }) {
  const { watchGroup } = await import("../lib/process-group.mjs");
  const pidFile = join(scratch(), "descendant.pid");
  const descendantCode = `process.on('SIGTERM', () => { ${onTerm} }); const fs = require('node:fs'); fs.writeFileSync(process.env.PID_FILE + '.tmp', String(process.pid)); fs.renameSync(process.env.PID_FILE + '.tmp', process.env.PID_FILE); setInterval(() => {}, 1000);`;
  const leaderCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: ${JSON.stringify(pipes ? "inherit" : "ignore")} }); setInterval(() => {}, 1000);`;
  const leader = watchGroup(spawn(process.execPath, ["-e", leaderCode], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PID_FILE: pidFile } }));
  leader.stdout.resume(); leader.stderr.resume();
  for (let i = 0; i < 250 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
  return { leader, descendant: Number(readFileSync(pidFile, "utf8")), closed: new Promise((r) => leader.once("close", r)) };
}

for (const pipes of [true, false]) {
  test(`terminateGroup kills a descendant that survives SIGTERM after its leader exits, ${pipes ? "holding the leader's pipes (an ssh or remote helper)" : "holding none of its pipes (so the leader's close comes first)"}`, { timeout: 30_000 }, async () => {
    const { terminateGroup } = await import("../lib/process-group.mjs");
    const { leader, descendant, closed } = await groupWithDescendant("", { pipes });
    try {
      await spyGroupKills(async (kills) => {
        assert.equal(terminateGroup(leader, 400), true);
        await new Promise((r) => leader.once("exit", r));
        assert.equal(leader.signalCode, "SIGTERM", "the leader ended on SIGTERM");
        await closed;
        // Killed, it may linger briefly as a zombie until its new parent reaps it (Linux: kill(pid, 0) still succeeds).
        for (let i = 0; i < 100 && alive(descendant); i++) await new Promise((r) => setTimeout(r, 50));
        assert.equal(alive(descendant), false, "the TERM-resistant descendant was killed after the grace");
        assert.deepEqual(kills.filter(([, sig]) => sig !== 0), [[leader.pid, "SIGTERM"], [leader.pid, "SIGKILL"]]);
      });
    } finally { try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ } }
  });
}

test("terminateGroup sends no SIGKILL once the group is seen empty: a descendant that ends within the grace, after its leader closed", { timeout: 30_000 }, async () => {
  const { terminateGroup } = await import("../lib/process-group.mjs");
  const { leader, descendant, closed } = await groupWithDescendant("setTimeout(() => process.exit(0), 300);", { pipes: false });
  try {
    await spyGroupKills(async (kills) => {
      // The grace is long enough for the exited descendant to be reaped: a zombie is still a member of its group.
      const grace = 6_000, end = Date.now() + grace;
      assert.equal(terminateGroup(leader, grace), true);
      await closed;
      for (let i = 0; i < 100 && alive(descendant); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(descendant), false, "the descendant ended on its own");
      await new Promise((r) => setTimeout(r, end + 500 - Date.now()));
      assert.deepEqual(kills.filter(([, sig]) => sig !== 0), [[leader.pid, "SIGTERM"]], "the group was seen empty: no SIGKILL at the end of the grace");
    });
  } finally { try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ } }
});

test("runGit's kill (an abort, or its timeout: one path) reaches a descendant that survives SIGTERM and holds git's output: it is killed after the grace", { timeout: 30_000 }, async () => {
  const { TERM_GRACE_MS } = await import("../lib/process-group.mjs");
  const base = scratch();
  const dir = join(base, "shim"), pidFile = join(base, "descendant.pid");
  mkdirSync(dir, { recursive: true });
  // git starts a helper that ignores SIGTERM and inherits git's stdout, as ssh does.
  writeFileSync(join(dir, "git"), `#!/bin/bash
( trap '' TERM; exec sh -c 'echo $$ > "${pidFile}"; exec sleep 60' ) &
sleep 60
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  let descendant = null;
  try {
    const aborter = new AbortController();
    const run = runGit(["fetch"], { cwd: base, signal: aborter.signal }).then(() => assert.fail("expected an abort"), (x) => x);
    for (let i = 0; i < 500 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 100 && !(descendant > 0); i++) { await new Promise((r) => setTimeout(r, 20)); descendant = Number(readFileSync(pidFile, "utf8")); }
    assert.ok(descendant > 0, "the helper started");
    aborter.abort();
    assert.equal((await run).code, "ABORT_ERR");
    assert.equal(alive(descendant), true, "SIGTERM alone does not end it");
    for (let i = 0; i < (TERM_GRACE_MS + 2_000) / 50 && alive(descendant); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(descendant), false, "the group SIGKILL ended it");
  } finally { process.env.PATH = saved; if (descendant) try { process.kill(descendant, "SIGKILL"); } catch { /* gone */ } }
});

test("an old config.lock (git names it relatively) is recovered; a young one is refused naming its absolute path", async () => {
  const f = fixture();
  initCache(f);
  const lock = leftoverGitLock(f, "config.lock");
  const session = createReadSession();
  try {
    assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit, session })).commit, f.commit);
    assert.equal(existsSync(lock), false);
    assert.ok(session.notices.some((n) => /^removed a stale git lock \/.*\/config\.lock /.test(n)), session.notices.join("\n"));
  } finally { await session.close(); }
  const g = fixture();
  initCache(g);
  const young = leftoverGitLock(g, "config.lock", { old: false });
  const e = await observeRemote(g.bare, { cacheDir: g.cacheDir, at: g.commit }).then(() => assert.fail("expected a refusal"), (x) => x);
  assert.deepEqual([e.details.reason, e.details.stage], ["cache", "config"]);
  assert.ok(isAbsolute(e.details.lock) && e.details.lock.endsWith("/config.lock"), e.details.lock);
  assert.ok(e.message.includes(e.details.lock));
  assert.equal(existsSync(young), true, "never deleted");
});

test("a fetch that cannot write the local cache (FETCH_HEAD unwritable, or a directory) is reason cache with git's words — never auth or network", async () => {
  for (const [name, spoil] of [
    ["unwritable", (file) => { writeFileSync(file, ""); chmodSync(file, 0o444); }],
    ["a directory", (file) => mkdirSync(file)],
  ]) {
    const f = fixture();
    initCache(f);
    spoil(join(f.repoDir, "FETCH_HEAD"));
    const e = await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit }).then(() => assert.fail("expected a refusal"), (x) => x);
    assert.equal(e.code, "E_REMOTE_UNREADABLE", name);
    assert.deepEqual([e.details.reason, e.details.stage, e.details.cacheDir], ["cache", "fetch", f.repoDir], name);
    assert.match(e.message, /\(cache, fetch\): .*cannot open 'FETCH_HEAD': .*; check that .* is writable by this user and its disk has room$/, name);
  }
});

// ---------------------------------------------------------------------------
// fetchRemoteTree through a read session's `cat-file --batch` reader, on a partial cache
// ---------------------------------------------------------------------------

test("a session's batch reader opened before ensureBlobs fetched a blob reads it afterwards: the tree copies as a checkout", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  const session = createReadSession();
  try {
    const opts = { cacheDir: f.cacheDir, session };
    // A small read opens the cache's reader while model.bin (over SMALL_BLOB_LIMIT) is not in the cache.
    await readRemoteFile(f.bare, f.commit, "souls/dev/soul.yaml", opts);
    const reader = session.batches.get(f.repoDir);
    assert.ok(reader, "the reader is open");
    assert.deepEqual(f.present("elsewhere/tools/data/model.bin"), { "elsewhere/tools/data/model.bin": false });
    const dest = join(f.base, "out", "tools");
    const r = await fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", dest, opts);
    assert.equal(r.digest, contentDigest(join(f.work, "elsewhere", "tools")));
    assert.equal(r.digest, contentDigest(dest));
    assert.equal(session.batches.get(f.repoDir), reader, "the same reader read the blob ensureBlobs fetched after it opened");
    assert.deepEqual(f.present("assets/huge-1.bin"), { "assets/huge-1.bin": false }, "nothing beyond the subtree was fetched");
  } finally { await session.close(); }
});

/** A `git` shim first on PATH whose `cat-file --batch-check` says every MISSING object is a 9-byte blob (so
 *  ensureBlobs believes a blob is present and fetches nothing); every other call, `--batch` included, is the
 *  real git. Each `fetch` is logged. */
async function withLyingBatchCheck(base, fn) {
  const dir = join(base, "lying-shim"), log = join(base, "fetches.log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(log, "");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(dir, "git"), `#!/bin/bash
for a in "$@"; do [ "$a" = "fetch" ] && echo "$*" >> "${log}"; done
for a in "$@"; do
  if [ "$a" = "--batch-check" ]; then "${real}" "$@" | sed -E 's/^([0-9a-f]{40}) missing$/\\1 blob 9/'; exit "\${PIPESTATUS[0]}"; fi
done
exec "${real}" "$@"
`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { return await fn(() => execFileSync("cat", [log], { encoding: "utf8" }).split("\n").filter(Boolean)); }
  finally { process.env.PATH = saved; }
}

test("a blob still missing when the batch reader reads it fails exactly as without a session: never a lazy fetch, never a hang, nothing left", { skip: skipPartialMechanics }, async () => {
  const f = fixture();
  await observeRemote(f.bare, { cacheDir: f.cacheDir, at: f.commit });
  assert.deepEqual(f.present("elsewhere/tools/data/model.bin"), { "elsewhere/tools/data/model.bin": false });
  await withLyingBatchCheck(f.base, async (fetches) => {
    const session = createReadSession({ batchTimeoutMs: 10_000 });
    const dest = join(f.base, "out", "tools");
    const failure = (opts) => fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", dest, { cacheDir: f.cacheDir, ...opts }).then(() => assert.fail("expected a failure"), (x) => x);
    const shape = (x) => ({ code: x.code, reason: x.details.reason, path: x.details.path, commit: x.details.commit });
    const plain = await failure({});
    const started = Date.now();
    const e = await failure({ session });
    assert.deepEqual(shape(e), shape(plain), "the same error as without a session");
    assert.equal(e.code, "E_REMOTE_UNREADABLE");
    assert.equal(e.details.path, "data/model.bin");
    assert.ok(Date.now() - started < 5_000, "answered at once, not by a timeout");
    assert.deepEqual(fetches(), [], "neither ensureBlobs (it was lied to) nor git (GIT_NO_LAZY_FETCH) fetched");
    assert.deepEqual(f.present("elsewhere/tools/data/model.bin"), { "elsewhere/tools/data/model.bin": false });
    assert.deepEqual(readdirSync(join(f.base, "out")), [], "no staging directory, no destination");
    await session.close();
  });
});

test("a symlink target over its 64 KiB cap fails exactly as without a session, whatever its id spells (an oid holding 403 is not an auth failure)", async () => {
  const f = fixture();
  // The reviewer's deterministic blob: 65,540 bytes, oid 8cc834859992ea403d394e514826263be431fb85.
  const oid = execFileSync("git", ["-C", f.work, "hash-object", "-w", "--stdin"], { input: "a".repeat(65537) + "216", encoding: "utf8" }).trim();
  assert.equal(oid, "8cc834859992ea403d394e514826263be431fb85");
  write(f.work, "aliased/AGENTS.md", "# aliased\n");
  git(f.work, "add", "-A");
  git(f.work, "update-index", "--add", "--cacheinfo", `120000,${oid},aliased/CLAUDE.md`);
  git(f.work, "commit", "-q", "-m", "long link"); git(f.work, "push", "-q", "origin", "HEAD:main");
  const commit = git(f.work, "rev-parse", "HEAD");
  const failure = (opts, out) => fetchRemoteTree(f.bare, commit, "aliased", join(f.base, out, "aliased"), { cacheDir: f.cacheDir, allowSymlinks: OATS_ALIAS_SYMLINK, ...opts })
    .then(() => assert.fail("expected a failure"), (x) => x);
  const shape = (x) => ({ code: x.code, reason: x.details?.reason, path: x.details?.path });
  const plain = await failure({}, "plain");
  const session = createReadSession();
  try {
    const batched = await failure({ session }, "batch");
    assert.deepEqual(shape(batched), shape(plain), "the same error as without a session");
    // git's words for it show nothing the kernel recognises, the network least of all (awebai/oats#1059).
    assert.deepEqual(shape(batched), { code: "E_REMOTE_UNREADABLE", reason: "unknown", path: "CLAUDE.md" });
    assert.deepEqual(readdirSync(join(f.base, "batch")), [], "nothing left");
  } finally { await session.close(); }
});

test("a full-mode cache (a server without filters) copies the same tree through the batch reader as without a session", async () => {
  const f = fixture("plain");
  const session = createReadSession();
  try {
    const batched = await fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", join(f.base, "batch", "tools"), { cacheDir: f.cacheDir, session });
    assert.equal(git(f.repoDir, "config", "--get", "oats.fetch"), "full");
    assert.equal(session.batches.size, 1, "read through the batch reader");
    const plain = await fetchRemoteTree(f.bare, f.commit, "elsewhere/tools", join(f.base, "plain", "tools"), { cacheDir: f.cacheDir });
    assert.deepStrictEqual(batched, plain);
    assert.equal(batched.digest, contentDigest(join(f.work, "elsewhere", "tools")));
  } finally { await session.close(); }
});

// ---------------------------------------------------------------------------
// awebai/oats#1059: the fetch of a commit into a cache that holds another; what git could not explain; leftovers
// ---------------------------------------------------------------------------

/** `n` lines of text that differ from one another and compress: two versions of one file made of them are
 *  what a server sends as a delta of one against the other. */
const prose = (n) => Array.from({ length: n }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog ${(i * 7919) % 10007}\n`).join("");
const UNDER = prose(900), OVER = prose(1400);
/**
 * A remote where one file crosses the cache's filter between two commits, as a file of a real repository does
 * when it grows or is split: `first` is the older commit and `second` the default branch's head. `grows` has
 * the file under the filter at `first` and over it at `second` (a pinned commit beside a newer head); `shrinks`
 * the other way (a new head beside the last one). → the fixture's fields, with `first`, `second`, and what the
 * cache of this remote holds.
 */
function crossing(shape) {
  const base = scratch();
  const bare = join(base, "remote.git"), work = join(base, "work");
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "uploadpack.allowFilter", "true");
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(base, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", bare);
  const [one, two] = shape === "grows" ? [UNDER, OVER] : [OVER, UNDER];
  assert.ok(Buffer.byteLength(UNDER) < SMALL_BLOB_LIMIT && Buffer.byteLength(OVER) > SMALL_BLOB_LIMIT, "the two versions are on either side of the filter");
  write(work, "souls/dev/soul.yaml", "name: dev\n");
  write(work, "test/crossing.txt", one);
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "first"); git(work, "push", "-q", "origin", "HEAD:main");
  const first = git(work, "rev-parse", "HEAD");
  /** One more commit on the default branch: the file's other version. → its commit. */
  const advance = () => {
    write(work, "test/crossing.txt", two);
    git(work, "add", "-A"); git(work, "commit", "-q", "-m", "second"); git(work, "push", "-q", "origin", "HEAD:main");
    return git(work, "rev-parse", "HEAD");
  };
  const cacheDir = join(base, "cache");
  const repoDir = join(cacheDir, createHash("sha256").update(parseRepoRef(bare).key).digest("hex"));
  const blobAt = (commit) => git(work, "rev-parse", `${commit}:test/crossing.txt`);
  const holds = (oid) => !gitInput(repoDir, `${oid}\n`, "cat-file", "--batch-check").endsWith(" missing");
  return { base, bare, work, first, advance, cacheDir, repoDir, blobAt, holds, one, two };
}
/** Every file under the cache repository's object store, with its size: what a fetch that failed must leave as it was. */
function objectStore(repoDir) {
  const out = {};
  const walk = (dir, rel) => { for (const name of readdirSync(dir).sort()) { const p = join(dir, name), r = rel ? `${rel}/${name}` : name; const st = lstatSync(p); if (st.isDirectory()) walk(p, r); else out[r] = st.size; } };
  walk(join(repoDir, "objects"), "");
  return out;
}
const temporaries = (repoDir) => Object.keys(objectStore(repoDir)).filter((file) => /(^|\/)tmp_/.test(file));
/** An exec that counts the fetches of `commit` and keeps what git said when one failed; `fail(n, args)` may
 *  return (or resolve to) an error to reject the n-th of them with, instead of running git. */
function commitFetches(commit, fail = () => null) {
  const fetches = [];
  const exec = async (args, o) => {
    if (!args.includes("fetch") || !args.includes(commit)) return runGit(args, o);
    const seen = { args, negotiates: !args.includes("fetch.negotiationAlgorithm=noop"), stderr: null };
    fetches.push(seen);
    const stubbed = await fail(fetches.length, args);
    if (stubbed) { seen.stderr = String(stubbed.stderr ?? ""); throw stubbed; }
    try { return await runGit(args, o); } catch (error) { seen.stderr = String(error.stderr ?? ""); throw error; }
  };
  return { fetches, exec };
}
const gitError = (stderr, extra = {}) => Object.assign(new Error("Command failed: git fetch"), { code: 128, signal: null, killed: false, timedOut: false, overflowed: false, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr), ...extra });
/** What git said on the host where awebai/oats#1059 was found, about the blob `oid`. */
const ISSUE_STDERR = (oid) => `warning: lazy fetching disabled; some objects may not be available\nfatal: could not fetch ${oid} from promisor remote\nfatal: fetch-pack: invalid index-pack output\n`;
const refusedRead = (promise) => promise.then(() => assert.fail("expected a refusal"), (x) => x);

test("a pinned commit is fetched into a cache that holds a newer head: the pack that needs a blob the filter left out is asked for again, whole (#1059)", { skip: skipPartialMechanics }, async () => {
  for (const withSession of [false, true]) {
    const f = crossing("grows");
    const head = f.advance();
    const session = withSession ? createReadSession() : undefined;
    try {
      // The head is read first, as a workspace's is: its version of the file is over the filter and stays out.
      const obs = await observeRemote(f.bare, { cacheDir: f.cacheDir, ...(session ? { session } : {}) });
      assert.equal(obs.commit, head);
      assert.deepEqual([f.holds(f.blobAt(head)), f.holds(f.blobAt(f.first))], [false, false]);
      // Then the older commit, as a pinned package's is. The fetch tells the server the cache holds the head, and
      // the server sends the older file as a delta against the head's, which the cache does not hold.
      const { fetches, exec } = commitFetches(f.first);
      const read = await readRemoteFile(f.bare, f.first, "test/crossing.txt", { cacheDir: f.cacheDir, exec, ...(session ? { session } : {}) });
      assert.equal(read.bytes.toString(), f.one, "the file reads back with the older commit's bytes");
      assert.deepEqual(fetches.map((x) => x.negotiates), [true, false], "two fetches of the commit, the second without negotiation");
      assert.match(fetches[0].stderr, /could not fetch [0-9a-f]{40} from promisor remote/, "the first failed as it does in a deployment: git may not fetch the delta's base on its own");
      assert.ok(fetches[0].stderr.includes(f.blobAt(head)), "and the base it lacked is the head's version of the file");
      assert.equal(fetches[1].stderr, null);
      assert.deepEqual(fetches[1].args.slice(fetches[1].args.indexOf("fetch")), fetches[0].args.slice(fetches[0].args.indexOf("fetch")), "otherwise the same fetch");
      // The first attempt's pack stays for now: it cannot be told from one another git is writing, so it goes by its age.
      const left = temporaries(f.repoDir);
      assert.deepEqual(left.map((file) => file.replace(/_[^_]+$/, "_")), ["pack/tmp_pack_"], "one pack, the failed attempt's");
      assert.equal(git(f.repoDir, "rev-parse", `refs/oats/commits/${f.first}`), f.first, "pinned");
      assert.equal(f.holds(f.blobAt(head)), false, "git fetched nothing on its own: the head's large file is still out");
      assert.deepEqual(session?.notices ?? [], [], "no notice: the fetch succeeded");
      // Read again: present, no fetch.
      const again = commitFetches(f.first);
      await readRemoteFile(f.bare, f.first, "souls/dev/soul.yaml", { cacheDir: f.cacheDir, exec: again.exec });
      assert.equal(again.fetches.length, 0);
      // Once it is older than the longest fetch, the next fetch into the entry (here, of the head's large file) removes it.
      utimesSync(join(f.repoDir, "objects", left[0]), HOUR_AGO(), HOUR_AGO());
      assert.equal((await readRemoteFile(f.bare, head, "test/crossing.txt", { cacheDir: f.cacheDir, ...(session ? { session } : {}) })).bytes.toString(), f.two);
      assert.deepEqual(temporaries(f.repoDir), [], "nothing is left in the object store");
    } finally { await session?.close(); }
  }
});

test("the default branch's new head is fetched into a cache that holds the last one, where a file came under the filter (#1059)", { skip: skipPartialMechanics }, async () => {
  const f = crossing("shrinks");
  assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir })).commit, f.first);
  assert.equal(f.holds(f.blobAt(f.first)), false, "the last head's version is over the filter");
  const head = f.advance();
  const { fetches, exec } = commitFetches(head);
  const obs = await observeRemote(f.bare, { cacheDir: f.cacheDir, exec });
  assert.equal(obs.commit, head, "the observation of the new head answers");
  assert.deepEqual(fetches.map((x) => x.negotiates), [true, false]);
  assert.match(fetches[0].stderr, /could not fetch [0-9a-f]{40} from promisor remote/);
  assert.equal((await readRemoteFile(f.bare, head, "test/crossing.txt", { cacheDir: f.cacheDir })).bytes.toString(), f.two);
  assert.equal(temporaries(f.repoDir).length, 1, "the failed attempt's pack, which goes by its age");
  // A head beside the last one where nothing crosses the filter still arrives in one negotiated fetch.
  write(f.work, "souls/dev/AGENTS.md", "# dev\n");
  git(f.work, "add", "-A"); git(f.work, "commit", "-q", "-m", "third"); git(f.work, "push", "-q", "origin", "HEAD:main");
  const third = git(f.work, "rev-parse", "HEAD");
  const next = commitFetches(third);
  assert.equal((await observeRemote(f.bare, { cacheDir: f.cacheDir, exec: next.exec })).commit, third);
  assert.deepEqual(next.fetches.map((x) => x.negotiates), [true], "the common fetch is one fetch, negotiated");
});

test("a commit's fetch that fails for a reason the kernel names is made once: no second attempt (#1059)", async () => {
  const f = fixture();
  const cases = {
    auth: gitError("remote: Invalid username or token.\nfatal: Authentication failed for 'https://example.com/org/repo.git/'\n"),
    "not-found": gitError(`fatal: remote error: upload-pack: not our ref ${f.commit}\n`),
    network: gitError("fatal: unable to access 'https://example.com/org/repo.git/': Could not resolve host: example.com\n"),
    timeout: gitError("", { code: null, killed: true, signal: "SIGTERM", timedOut: true }),
    cache: gitError("error: unable to write file ./objects/pack/pack-1.pack: No space left on device\nfatal: index-pack failed\n"),
    killed: gitError("", { code: null, signal: "SIGKILL" }),
  };
  for (const [reason, error] of Object.entries(cases)) {
    const { fetches, exec } = commitFetches(f.commit, () => error);
    const e = await refusedRead(observeRemote(f.bare, { cacheDir: join(f.base, `cache-${reason}`), at: f.commit, exec }));
    assert.deepEqual([e.code, e.details.reason, fetches.length], ["E_REMOTE_UNREADABLE", reason, 1], reason);
    assert.equal(e.details.commit, f.commit, reason);
  }
  // Nor is a read the command gave up: it shows nothing the kernel classifies, and is still not asked again.
  const aborted = commitFetches(f.commit, () => Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", overflowed: false, timedOut: false }));
  const e = await refusedRead(observeRemote(f.bare, { cacheDir: join(f.base, "cache-aborted"), at: f.commit, exec: aborted.exec }));
  assert.deepEqual([e.details.reason, aborted.fetches.length, e.message], ["unknown", 1, `cannot read remote ${f.bare} (unknown)`]);
});

test("a commit's fetch the kernel cannot classify gets its second attempt, whatever an object id in git's words spells; a second failure is the answer (#1059)", async () => {
  const f = fixture();
  // The id of a blob that holds 403: git's line about it is no refusal of the operator's credentials.
  const oid = "8cc834859992ea403d394e514826263be431fb85";
  assert.equal(classifyRemoteFailure(gitError(ISSUE_STDERR(oid))), "unknown");
  // The second attempt runs and succeeds.
  const healed = commitFetches(f.commit, (n) => (n === 1 ? gitError(ISSUE_STDERR(oid)) : null));
  assert.equal((await observeRemote(f.bare, { cacheDir: join(f.base, "cache-healed"), at: f.commit, exec: healed.exec })).commit, f.commit);
  assert.deepEqual(healed.fetches.map((x) => x.negotiates), [true, false]);
  // The second attempt fails too: two fetches, never a third, and the answer is the second's, with its own reason.
  const twice = commitFetches(f.commit, (n) => gitError(n === 1 ? ISSUE_STDERR(oid) : "fatal: unable to access 'https://example.com/org/repo.git/': Failed to connect to example.com port 443\n"));
  const network = await refusedRead(observeRemote(f.bare, { cacheDir: join(f.base, "cache-twice"), at: f.commit, exec: twice.exec }));
  assert.deepEqual([network.details.reason, twice.fetches.map((x) => x.negotiates)], ["network", [true, false]]);
  assert.equal(network.message, `cannot read remote ${f.bare} (network)`, "a reason the kernel names carries no line of git's");
  // And when the kernel cannot classify the second either, the message carries the second's last line.
  const unknown = commitFetches(f.commit, (n) => gitError(n === 1 ? ISSUE_STDERR(oid) : "remote: Enumerating objects: 3, done.\rremote: Total 3\nerror: the frobnicator is out of alignment\nfatal: something nobody has seen before\n"));
  const e = await refusedRead(observeRemote(f.bare, { cacheDir: join(f.base, "cache-unknown"), at: f.commit, exec: unknown.exec }));
  assert.equal(unknown.fetches.length, 2);
  assert.deepEqual(e.details, { url: f.bare, key: parseRepoRef(f.bare).key, reason: "unknown", commit: f.commit }, "no field added");
  assert.equal(e.message, `cannot read remote ${f.bare} (unknown): fatal: something nobody has seen before`);
});

test("what git could not explain is unknown, with git's last line scrubbed; network is what the text shows to be the network (#1059)", async () => {
  const oid = "e1ee9920902346c7d0b534009d66a7d435c78a12";
  assert.equal(classifyRemoteFailure(gitError(ISSUE_STDERR(oid))), "unknown", "the stderr of the issue");
  assert.equal(classifyRemoteFailure(gitError(ISSUE_STDERR(oid).replace("invalid index-pack output", "index-pack failed"))), "unknown", "and over the file transport");
  assert.equal(classifyRemoteFailure(gitError("")), "unknown", "nothing said");
  assert.equal(classifyRemoteFailure(gitError("", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM", overflowed: true })), "unknown", "an overflow with no text");
  assert.equal(classifyRemoteFailure(gitError("fatal: Authentication failed", { overflowed: true })), "auth", "an overflow is what its text shows");
  // An object id is evidence of nothing; an HTTP status is.
  for (const id of ["8cc834859992ea403d394e514826263be431fb85", `${"a".repeat(30)}403${"b".repeat(31)}`]) assert.equal(classifyRemoteFailure(gitError(`fatal: could not fetch ${id} from promisor remote\n`)), "unknown", id);
  assert.equal(classifyRemoteFailure(gitError("fatal: unable to access 'https://h/r/': The requested URL returned error: 403\n")), "auth");
  // The network, as git, libcurl and ssh say it.
  for (const text of [
    "fatal: unable to access 'https://h/r/': Could not resolve host: h", "ssh: Could not resolve hostname h: Name or service not known", "fatal: unable to look up h (port 9418) (Temporary failure in name resolution)",
    "fatal: unable to access 'https://h/r/': Could not resolve proxy: p", "error: Failed to connect to h port 443 after 2 ms: Couldn't connect to server", "ssh: connect to host h port 22: No route to host",
    "ssh: connect to host h port 22: Operation timed out", "ssh: connect to host h port 22: Connection timed out", "ssh: connect to host h port 22: Connection refused", "Connection closed by 192.0.2.1 port 22",
    "kex_exchange_identification: Connection closed by remote host", "fetch-pack: unexpected disconnect while reading sideband packet", "fatal: the remote end hung up unexpectedly", "fatal: early EOF",
    "ssh: connect to host h port 22: Network is unreachable", "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
  ]) assert.equal(classifyRemoteFailure(gitError(`${text}\n`)), "network", text);
  // Git prose is one disclosure decision, never a partially recovered sentence.
  const notice = "Git's diagnostic was withheld; run the same Git operation by hand to see Git's own words.";
  const safe = "https://example.com/org/repo";
  for (const [line, source] of [
    ["fatal: unable to access 'https://x-access-token:ghp_secret@example.com/org/repo.git/': bad thing", undefined],
    ["ssh://bot:s3cr%40t@example.com/org/repo refused s3cr@t (bot:s3cr%40t)", "ssh://bot:s3cr%40t@example.com/org/repo"],
    ["git@example.com:org/repo.git: a user name alone is no secret", "git@example.com:org/repo.git"],
    ["bot is not allowed here", "ssh://bot@example.com/org/repo"],
    ["remote: tok%5Fbare was refused (tok_bare)", "https://tok%5Fbare@example.com/org/repo"],
    ["remote: tok_user was refused with x-oauth-basic", "https://tok_user:x-oauth-basic@example.com/org/repo"],
    ["remote: TOK_UPPER was refused", "HTTP://TOK_UPPER@example.com/org/repo"],
  ]) assert.equal(scrubGitLine(line, source), notice);
  assert.equal(scrubGitLine(" \x00‮\t ", safe), "");
  assert.equal(scrubGitLine("ssh: bad\tthing\x1b[31m\x07", safe), "ssh: bad thing");
  const long = scrubGitLine(`fatal: ${"x".repeat(5000)}`, safe);
  assert.deepEqual([[...long].length, long.endsWith("…")], [GIT_LINE_MAX, true]);
  // Through a read: the message ends with git's last line, and a credential of the url is in neither.
  const url = "ssh://bot:s3cret@example.com/org/repo";
  const said = (stderr) => refusedRead(observeRemote(url, { cacheDir: join(scratch(), "cache"), exec: async (args) => { if (args.includes("ls-remote")) throw gitError(stderr); return runGit(args); } }));
  const e = await said(`warning: redirecting\nfatal: '${url}' is being difficult: s3cret\n`);
  assert.deepEqual(e.details, { url: "ssh://example.com/org/repo", key: "example.com/org/repo", reason: "unknown", at: null }, "no field added; the url has no user information");
  // The message prints the url as the cache's messages do, without its user information (displayRepoRef).
  assert.equal(e.message, `cannot read remote ssh://example.com/org/repo (unknown): ${notice}`);
  assert.ok(!e.message.includes("s3cret"));
  assert.equal((await said("")).message, "cannot read remote ssh://example.com/org/repo (unknown)", "no stderr means no Git line, even when Node supplies error.message");
  assert.equal((await said("\x1b[0m\n \n")).message, `cannot read remote ssh://example.com/org/repo (unknown): ${notice}`, "control removal cannot bypass the original-reference decision");
  // A reason the kernel names: the same url, and no line of git's.
  const named = await said(`fatal: unable to access '${url}/': Could not resolve host: example.com\n`);
  assert.deepEqual([named.details.reason, named.details.url, named.message], ["network", "ssh://example.com/org/repo", "cannot read remote ssh://example.com/org/repo (network)"]);
  // Rebuilding even ordinary SSH userinfo withholds the whole Git line; its safe URL stays.
  const plain = await refusedRead(observeRemote("ssh://bot@example.com/org/repo", { cacheDir: join(scratch(), "cache"), exec: async (args) => { if (args.includes("ls-remote")) throw gitError("fatal: bot was refused\n"); return runGit(args); } }));
  assert.deepEqual([plain.details.url, plain.message], ["ssh://example.com/org/repo", `cannot read remote ssh://example.com/org/repo (unknown): ${notice}`]);
  // A token as the user of an http(s) url never reaches a read: such a url is no repository reference, so no
  // read's message is built over one. The scrub above is what holds for git's line, whatever url it is handed.
  for (const ref of ["https://tok_bare0secret@example.com/org/repo", "https://bot:s3cret@example.com/org/repo.git", "http://tok_bare0secret@example.com/org/repo"]) {
    const refused = await refusedRead(observeRemote(ref, { cacheDir: join(scratch(), "cache"), exec: async () => { throw new Error("git is not run"); } }));
    assert.equal(refused.code, "E_REPO_REF", ref);
  }
});

test("a fetch first removes the temporary files older than the longest fetch, and no younger one: not its own failed attempt's, not another writer's (#1059)", { skip: skipPartialMechanics }, async () => {
  const f = crossing("grows");
  const head = f.advance();
  await observeRemote(f.bare, { cacheDir: f.cacheDir, at: head });
  // What earlier failures and another writer may have left: git's temporary files, old and young.
  const leftover = (rel, { old }) => { const file = join(f.repoDir, "objects", rel); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "x".repeat(700)); if (old) utimesSync(file, HOUR_AGO(), HOUR_AGO()); return rel; };
  const young = [leftover("pack/tmp_pack_young1", { old: false }), leftover("ab/tmp_obj_young2", { old: false }), leftover("tmp_young3", { old: false })];
  const old = [leftover("pack/tmp_pack_old001", { old: true }), leftover("pack/tmp_idx_old002", { old: true }), leftover("ab/tmp_obj_old003", { old: true }), leftover("tmp_old004", { old: true })];
  // Never a file that is not git's temporary file, whatever its age; never through a symbolic link.
  const kept = [leftover("pack/not_tmp_pack", { old: true }), leftover("info/tmp_elsewhere", { old: true })];
  symlinkSync(join(f.repoDir, "objects", kept[0]), join(f.repoDir, "objects", "pack", "tmp_pack_link"));
  lutimesSync(join(f.repoDir, "objects", "pack", "tmp_pack_link"), HOUR_AGO(), HOUR_AGO());
  // Never outside the cache entry: a directory of the object store that is a symbolic link is not looked into.
  const outside = join(f.base, "outside");
  mkdirSync(outside);
  const sentinel = join(outside, "tmp_obj_unrelated");
  writeFileSync(sentinel, "not the cache's"); utimesSync(sentinel, HOUR_AGO(), HOUR_AGO());
  symlinkSync(outside, join(f.repoDir, "objects", "00"));
  const before = objectStore(f.repoDir);
  // The real failing fetch (it receives a pack it cannot complete), then a second attempt that fails too. While
  // that one runs, another git starts writing a pack into the entry, as an older kernel's fetch would (it takes
  // no write lock), and a file appears that nobody holds.
  let writer = null, writerPack = null;
  const { fetches, exec } = commitFetches(f.first, async (n) => {
    if (n !== 2) return null;
    const had = new Set(temporaries(f.repoDir));
    writer = spawn("git", ["-C", f.repoDir, "index-pack", "--stdin"], { stdio: ["pipe", "ignore", "ignore"] });
    for (let i = 0; i < 250 && !writerPack; i++) { await new Promise((r) => setTimeout(r, 20)); writerPack = temporaries(f.repoDir).find((file) => !had.has(file)) ?? null; if (!writerPack) writer.stdin.write(Buffer.from("PACK")); }
    leftover("pack/tmp_pack_during", { old: false });
    return gitError("fatal: the second attempt failed as well\n");
  });
  try {
    const e = await refusedRead(readRemoteFile(f.bare, f.first, "test/crossing.txt", { cacheDir: f.cacheDir, exec }));
    assert.deepEqual([e.details.reason, fetches.length], ["unknown", 2]);
    assert.match(fetches[0].stderr, /promisor remote/, "the first attempt ran git, which left its pack behind");
    assert.ok(writerPack, "the other writer made its temporary pack while the fetch was failing");
    const after = objectStore(f.repoDir);
    assert.deepEqual(Object.keys(before).filter((file) => !(file in after)).sort(), [...old].sort(), "the old leftovers are gone, and nothing else");
    assert.equal(writer.exitCode, null, "the other writer is still running");
    for (const file of [...young, ...kept, "pack/tmp_pack_link", "pack/tmp_pack_during", writerPack]) assert.ok(file in after, `${file} stays`);
    const appeared = Object.keys(after).filter((file) => !(file in before)).sort();
    assert.equal(appeared.length, 3, `the failed attempt's own pack is there too, with the two that appeared beside it: ${appeared}`);
    assert.ok(appeared.every((file) => /^pack\/tmp_pack_/.test(file)));
    assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([file]) => file in before && before[file] !== after[file])), {}, "no file changed");
    assert.equal(existsSync(sentinel), true, "a file behind a linked directory is outside the cache, whatever its name and age");
    // The fetch that then succeeds removes nothing more: a young file may be another writer's.
    assert.equal((await readRemoteFile(f.bare, f.first, "test/crossing.txt", { cacheDir: f.cacheDir })).bytes.toString(), f.one);
    const later = objectStore(f.repoDir);
    for (const file of [...young, ...kept, "pack/tmp_pack_link", ...appeared]) assert.ok(file in later, `${file} still stays`);
    assert.equal(writer.exitCode, null);
    assert.equal(existsSync(sentinel), true);
    // A session whose own fetch may run longer than the longest fetch waits that long before it calls a file old.
    const patient = createReadSession({ fetchTimeoutMs: 2 * 60 * 60 * 1000 });
    const hourOld = leftover("pack/tmp_pack_hour01", { old: true });
    try {
      await readRemoteFile(f.bare, head, "test/crossing.txt", { cacheDir: f.cacheDir, session: patient });
      assert.ok(hourOld in objectStore(f.repoDir), "an hour is not old to a session that allows a fetch two");
    } finally { await patient.close(); }
  } finally { writer?.stdin.destroy(); writer?.kill("SIGKILL"); }
  // Nor when the object store itself is a link: nothing is looked for there at all.
  const g = crossing("grows");
  const gHead = g.advance();
  await observeRemote(g.bare, { cacheDir: g.cacheDir, at: gHead });
  const moved = join(g.base, "moved-objects");
  renameSync(join(g.repoDir, "objects"), moved);
  symlinkSync(moved, join(g.repoDir, "objects"));
  const old2 = join(moved, "pack", "tmp_pack_old001");
  writeFileSync(old2, "x"); utimesSync(old2, HOUR_AGO(), HOUR_AGO());
  assert.equal((await readRemoteFile(g.bare, g.first, "test/crossing.txt", { cacheDir: g.cacheDir })).bytes.toString(), g.one, "the fetch itself still works through the link, as git does");
  assert.equal(existsSync(old2), true, "the kernel removes nothing through a link");
});
