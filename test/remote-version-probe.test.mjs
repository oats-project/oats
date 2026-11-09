/** A failed version probe must leave an existing partial cache and both of its pins intact. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadSession, gitVersion, observeRemote, parseRepoRef, readRemoteFile, runGit } from "../lib/remote.mjs";
import { olderGitNotice, skipPartialMechanics } from "./helpers/partial-git.mjs";

const modern = () => ({ stdout: Buffer.from("git version 2.54.0\n"), stderr: Buffer.alloc(0) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(setImmediate);
const roots = [];
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "oats-version-probe-")); roots.push(root);
  const env = { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
  const seed = join(root, "seed"), bare = join(root, "remote.git"), cacheDir = join(root, "cache");
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "gc.auto", "0"); git(seed, "config", "maintenance.auto", "false");
  writeFileSync(join(seed, "small"), "one\n"); git(seed, "add", "."); git(seed, "commit", "-qm", "one");
  const one = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "small"), "two\n"); git(seed, "commit", "-qam", "two");
  const two = git(seed, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--bare", seed, bare);
  git(bare, "config", "uploadpack.allowFilter", "true"); git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  await observeRemote(bare, { cacheDir, at: one });
  await observeRemote(bare, { cacheDir, at: two });
  const dir = join(cacheDir, createHash("sha256").update(parseRepoRef(bare).key).digest("hex"));
  // A concrete file also makes a whole rebuild observable even if the filesystem reuses the directory inode.
  writeFileSync(join(dir, "probe-evidence"), "keep both pins\n");
  return { bare, cacheDir, dir, one, two };
}

// Filesystem inspection only: no diagnostic Git process enters the kernel-owned cache.
function snapshot(dir) {
  const files = {};
  const walk = (rel = "") => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = join(rel, name), full = join(dir, path), st = statSync(full);
      if (st.isDirectory()) walk(path);
      else files[path] = { hash: createHash("sha256").update(readFileSync(full)).digest("hex"), mode: st.mode };
    }
  };
  walk();
  const config = readFileSync(join(dir, "config"), "utf8");
  const mode = /\[oats\][\s\S]*?fetch = (\w+)/.exec(config)?.[1];
  const pins = Object.fromEntries(Object.keys(files).filter((p) => p.startsWith("refs/oats/commits/"))
    .map((p) => [p, readFileSync(join(dir, p), "utf8").trim()]));
  return { inode: statSync(dir).ino, mode, pins, files };
}

for (const kind of ["EAGAIN", "spawn-sync", "unparseable", "early-timeout", "early-timeout-no-session", "deadline", "abort"]) {
  test(`version ${kind}: both pins, every cache file and mode survive; same exec retries`, { skip: skipPartialMechanics }, async (t) => {
    const f = await fixture(), before = snapshot(f.dir);
    assert.equal(before.mode, "partial");
    assert.deepEqual(Object.values(before.pins).sort(), [f.one, f.two].sort());
    const session = ["early-timeout", "deadline", "abort"].includes(kind)
      ? createReadSession({ deadline: kind === "abort" ? null : Date.now() + 20_000 }) : undefined;
    const entered = deferred(), pending = deferred();
    let broken = true, probes = 0, probeOpts;
    const exec = (args, opts) => {
      if (args[0] !== "--version") return runGit(args, opts);
      probes++; probeOpts = opts; entered.resolve();
      if (!broken) return Promise.resolve(modern());
      if (kind === "unparseable") return Promise.resolve({ stdout: Buffer.from("unparseable-private-output@secret"), stderr: Buffer.alloc(0) });
      if (kind === "deadline" || kind === "abort") return pending.promise;
      const error = Object.assign(new Error("synthetic version failure"), { code: kind === "EAGAIN" ? "EAGAIN" : "FIXTURE",
        timedOut: kind.startsWith("early-timeout"), stderr: Buffer.alloc(0) });
      if (kind === "spawn-sync") throw error;
      return Promise.reject(error);
    };
    if (kind === "deadline") t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const read = readRemoteFile(f.bare, f.one, "small", { cacheDir: f.cacheDir, exec, session });
      const failure = assert.rejects(read, (error) => {
        assert.equal(error.code, "E_REMOTE_UNREADABLE");
        assert.equal(error.details.reason, ["early-timeout", "early-timeout-no-session", "deadline"].includes(kind) ? "timeout" : "unknown");
        assert.equal(error.details.stage, "fetch");
        assert.ok(!JSON.stringify(error).includes("unparseable-private-output"));
        assert.ok(!error.message.includes("unparseable-private-output"));
        return true;
      });
      await entered.promise;
      if (kind === "deadline") t.mock.timers.tick(probeOpts.timeout);
      if (kind === "abort") await session.close();
      await failure;
      assert.deepEqual(snapshot(f.dir), before, "refusal changes no cache byte, permission, inode, mode or pin");
      if (kind === "early-timeout") assert.equal(session.expired(), false, "the probe's own timeout survives a future deadline");
      // End even an exec double which ignores its timeout/signal before the next operation.
      pending.reject(Object.assign(new Error("late failure"), { timedOut: true }));
      // Only the deadline/abort double consumes this promise.
      await pending.promise.catch(() => {});
      if (kind === "deadline") t.mock.timers.reset();
      if (session) await session.close();
      broken = false;
      assert.equal((await readRemoteFile(f.bare, f.two, "small", { cacheDir: f.cacheDir, exec })).bytes.toString(), "two\n");
      assert.equal(probes, 2, "same exec reprobes after failure");
      assert.equal((await gitVersion(exec)).text, "2.54.0");
      assert.equal((await readRemoteFile(f.bare, f.one, "small", { cacheDir: f.cacheDir, exec })).bytes.toString(), "one\n");
      assert.equal(probes, 2, "strict reads and compatibility helper share the successful memo");
      assert.deepEqual(snapshot(f.dir), before, "retry reads the second pin without rebuilding");
    } finally { if (session) await session.close(); }
  });
}

test("only a parsed old version rebuilds both-pin partial cache; modern Git keeps recorded full mode", { skip: skipPartialMechanics }, async () => {
  const f = await fixture(), before = snapshot(f.dir), session = createReadSession();
  let probes = 0;
  const exec = (args, opts) => {
    if (args[0] !== "--version") return runGit(args, opts);
    probes++; return Promise.resolve({ stdout: Buffer.from("git version 2.44.9\n"), stderr: Buffer.alloc(0) });
  };
  try {
    assert.equal((await readRemoteFile(f.bare, f.one, "small", { cacheDir: f.cacheDir, exec, session })).bytes.toString(), "one\n");
    const after = snapshot(f.dir);
    assert.equal(after.mode, "full");
    assert.equal(after.files["probe-evidence"], undefined);
    assert.deepEqual(Object.values(after.pins), [f.one]);
    assert.notDeepEqual(after.files, before.files);
    assert.deepEqual(session.notices, [olderGitNotice("2.44.9")]);
    assert.equal((await readRemoteFile(f.bare, f.two, "small", { cacheDir: f.cacheDir, exec })).bytes.toString(), "two\n");
    assert.equal(probes, 1);
    assert.equal((await readRemoteFile(f.bare, f.one, "small", { cacheDir: f.cacheDir })).bytes.toString(), "one\n");
    assert.equal(snapshot(f.dir).mode, "full", "successful modern version never migrates recorded full mode");
  } finally { await session.close(); }
});

test("compatibility helper retries rejection and unparseable output, sharing only parsed success", async () => {
  for (const result of [() => { throw new Error("spawn failed"); }, () => ({ stdout: Buffer.from("unknown") })]) {
    let probes = 0;
    const exec = () => { probes++; return result(); };
    assert.equal(await gitVersion(exec), null); assert.equal(await gitVersion(exec), null);
    assert.equal(probes, 2);
  }
  let probes = 0;
  const gate = deferred(), entered = deferred();
  const exec = () => { probes++; entered.resolve(); return gate.promise; };
  const a = gitVersion(exec), b = gitVersion(exec);
  await entered.promise; gate.resolve(modern());
  assert.deepEqual(await a, { text: "2.54.0", major: 2, minor: 54 });
  assert.deepEqual(await b, await gitVersion(exec));
  assert.equal(probes, 1);
});

for (const ending of ["timeout", "abort"]) {
  for (const late of ["success", "failure"]) {
    test(`shared probe: independent waiter ${ending}, late old ${late} cannot erase or overwrite replacement`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
      const owner = new AbortController(), waiter = new AbortController();
      let probes = 0;
      const exec = (args, opts) => {
        assert.deepEqual(args, ["--version"]);
        const n = probes++;
        if (n === 0) assert.deepEqual(opts, { timeout: 1000, signal: owner.signal }, "launch options are truthful");
        entered[n].resolve(); return gates[n].promise;
      };
      const peer = gitVersion(exec, { timeout: 1000, signal: owner.signal });
      await entered[0].promise;
      const short = gitVersion(exec, { timeout: 10, signal: waiter.signal });
      if (ending === "timeout") t.mock.timers.tick(10); else waiter.abort();
      assert.equal(await short, null);
      assert.equal(owner.signal.aborted, false);
      let peerDone = false; void peer.then(() => { peerDone = true; });
      await turn(); assert.equal(peerDone, false, "an unexpired peer still awaits its probe");
      const retry = gitVersion(exec, { timeout: 1000 });
      await entered[1].promise;
      gates[1].resolve(modern());
      assert.equal((await retry).text, "2.54.0");
      if (late === "failure") gates[0].reject(Object.assign(new Error("old probe failed"), { timedOut: true }));
      else gates[0].resolve({ stdout: Buffer.from("git version 2.44.9"), stderr: Buffer.alloc(0) });
      assert.equal((await peer)?.text ?? null, late === "failure" ? null : "2.44.9", "peer receives its original outcome");
      assert.equal((await gitVersion(exec)).text, "2.54.0", "newer successful memo survives old completion");
      assert.equal(probes, 2);
    });
  }
}


test("an already-ended session refuses before probing and preserves both pins", { skip: skipPartialMechanics }, async () => {
  const f = await fixture(), before = snapshot(f.dir);
  const session = createReadSession({ deadline: Date.now() - 1 });
  let probes = 0;
  const exec = (args, opts) => { if (args[0] === "--version") probes++; return runGit(args, opts); };
  try {
    await assert.rejects(readRemoteFile(f.bare, f.one, "small", { cacheDir: f.cacheDir, exec, session }),
      (e) => e.code === "E_REMOTE_UNREADABLE" && e.details.reason === "timeout");
    assert.equal(probes, 0);
    assert.deepEqual(snapshot(f.dir), before);
  } finally { await session.close(); }
});

test("pre-aborted compatibility wait starts no probe and does not discard an existing success", async () => {
  const controller = new AbortController(); controller.abort();
  let probes = 0;
  const exec = () => { probes++; return modern(); };
  assert.equal(await gitVersion(exec, { signal: controller.signal }), null);
  assert.equal(probes, 0);
  assert.equal((await gitVersion(exec)).text, "2.54.0");
  assert.equal(await gitVersion(exec, { signal: controller.signal }), null);
  assert.equal((await gitVersion(exec)).text, "2.54.0");
  assert.equal(probes, 1);
});
