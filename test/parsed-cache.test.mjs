/** The parsed cache (lib/remote.mjs memoAtCommit): values derived from the bytes at (repo key, commit)
 *  kept on disk per kernel fingerprint — the revived value is deepStrictEqual to the computed one for
 *  every item kind, a corrupt entry is a miss, writes are atomic, the store is bounded (LRU, count and
 *  bytes), transient failures and unsafe values are never kept, and without a session nothing is. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import {
  createReadSession, kernelFingerprint, memoAtCommit, pruneStores, remoteTreeOids, runGit, PARSED_LIMITS,
} from "../lib/remote.mjs";
import { discoverWorkspace } from "../lib/workspace.mjs";
import { capabilityProvides, lockedPackageCapabilities } from "../lib/resolve.mjs";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
const roots = [];
function scratch() { const d = mkdtempSync(join(tmpdir(), "oats-parsed-")); roots.push(d); return d; }
test.after(() => { for (const d of roots) { try { chmodSync(d, 0o755); } catch {} rmSync(d, { recursive: true, force: true }); } });
const OID = "a".repeat(40), REF = "git:example.com/org/repo";
const parsedFiles = (root) => { const dir = join(root, ".parsed"); return existsSync(dir) ? readdirSync(dir).flatMap((fp) => readdirSync(join(dir, fp)).map((f) => join(dir, fp, f))) : []; };

/** A value shaped like the kernel's: YAML maps decode to null-prototype objects, JSON to plain ones. */
function richValue() {
  const soul = Object.assign(Object.create(null), { schemaVersion: 2, name: "dev", capabilities: Object.assign(Object.create(null), { "oats.core": Object.assign(Object.create(null), { from: "package" }) }), list: ["a", 1, true, null, { x: 1.5 }] });
  const manifest = JSON.parse('{"capability":"c","__proto__":{"own":"data"},"n":-1e-7,"s":"ünï\\ud83d\\ude00"}');
  return { souls: [{ name: "dev", definition: soul }], capabilities: [{ name: "c", manifest }], publishes: null, problems: [{ code: "E_WORKSPACE_SCHEMA", path: "x", message: "m" }] };
}

test("a revived entry is deepStrictEqual to the computed value — prototypes, own __proto__ keys and all — and a hit computes nothing", async () => {
  const cacheDir = scratch();
  const value = richValue();
  const computed = await memoAtCommit(REF, OID, "enumerate", async () => value, { cacheDir, session: createReadSession() });
  assert.equal(computed, value);
  const revived = await memoAtCommit(REF, OID, "enumerate", () => assert.fail("a hit must not compute"), { cacheDir, session: createReadSession() });
  assert.deepStrictEqual(revived, value);
  assert.notEqual(revived, value, "a fresh copy per hit");
  assert.equal(Object.getPrototypeOf(revived.souls[0].definition), null);
  assert.equal(Object.getPrototypeOf(revived.capabilities[0].manifest), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(revived.capabilities[0].manifest, "__proto__").value, { own: "data" });
  // The entry format.
  const [file] = parsedFiles(cacheDir);
  const entry = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(entry), ["v", "fingerprint", "key", "commit", "item", "nullProto", "value"]);
  assert.deepEqual([entry.v, entry.fingerprint, entry.key, entry.commit, entry.item], [1, kernelFingerprint(), "example.com/org/repo", OID, "enumerate"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(cacheDir, ".parsed")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(cacheDir, ".parsed", kernelFingerprint())).filter((f) => f.endsWith(".tmp")), [], "no temp file is left");
});

test("without a session nothing is cached or written (library callers keep today's behaviour)", async () => {
  const cacheDir = scratch();
  let n = 0;
  for (let i = 0; i < 2; i++) await memoAtCommit(REF, OID, "enumerate", async () => ++n, { cacheDir });
  assert.equal(n, 2);
  assert.equal(existsSync(join(cacheDir, ".parsed")), false);
});

test("never kept: transient failures, and any value whose JSON round trip would differ", async () => {
  const cycle = { a: 1 }; cycle.self = cycle;
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const extra = [1]; extra.note = "x";
  const getter = { get g() { return 1; } };
  const unsafe = {
    undefinedField: { a: undefined }, nan: { n: NaN }, infinity: [Infinity], negativeZero: { z: -0 }, date: { d: new Date(0) }, buffer: { b: Buffer.from("x") },
    map: { m: new Map() }, instance: { i: new (class X {})() }, cycle, sparse, extra, getter, symbol: { [Symbol("s")]: 1 },
    unreadable: { problems: [{ code: "E_REMOTE_UNREADABLE", message: "cannot read" }] },
    transientReason: { error: { code: "E_REMOTE_TREE_UNSAFE", reason: "network" } }, topUndefined: undefined,
  };
  for (const [name, value] of Object.entries(unsafe)) {
    const cacheDir = scratch();
    let n = 0;
    for (let i = 0; i < 2; i++) await memoAtCommit(REF, OID, "enumerate", async () => { n++; return value; }, { cacheDir, session: createReadSession() });
    assert.equal(n, 2, `${name}: computed every time`);
    assert.deepEqual(parsedFiles(cacheDir), [], `${name}: nothing written`);
  }
  // A thrown compute is never kept either.
  const cacheDir = scratch();
  await assert.rejects(memoAtCommit(REF, OID, "enumerate", async () => { throw Object.assign(new Error("x"), { code: "E_REMOTE_UNREADABLE" }); }, { cacheDir, session: createReadSession() }));
  assert.deepEqual(parsedFiles(cacheDir), []);
});

test("a corrupt, partial, zero-byte or mismatched entry is a miss: recomputed and replaced, never an error", async () => {
  const good = { souls: [], n: 1 };
  const damage = {
    garbage: () => "not json {",
    partial: (text) => text.slice(0, Math.floor(text.length / 2)),
    empty: () => "",
    wrongKey: (text) => JSON.stringify({ ...JSON.parse(text), key: "example.com/org/other" }),
    wrongCommit: (text) => JSON.stringify({ ...JSON.parse(text), commit: "b".repeat(40) }),
    wrongItem: (text) => JSON.stringify({ ...JSON.parse(text), item: "membership" }),
    wrongFingerprint: (text) => JSON.stringify({ ...JSON.parse(text), fingerprint: "0".repeat(64) }),
    wrongVersion: (text) => JSON.stringify({ ...JSON.parse(text), v: 2 }),
    noValue: (text) => { const e = JSON.parse(text); delete e.value; return JSON.stringify(e); },
    noNullProto: (text) => { const e = JSON.parse(text); delete e.nullProto; return JSON.stringify(e); },
    array: () => "[]",
  };
  for (const [name, hurt] of Object.entries(damage)) {
    const cacheDir = scratch();
    await memoAtCommit(REF, OID, "enumerate", async () => good, { cacheDir, session: createReadSession() });
    const [file] = parsedFiles(cacheDir);
    writeFileSync(file, hurt(readFileSync(file, "utf8")));
    let n = 0;
    const value = await memoAtCommit(REF, OID, "enumerate", async () => { n++; return { ...good, n: 2 }; }, { cacheDir, session: createReadSession() });
    assert.equal(n, 1, `${name}: a miss`);
    assert.deepEqual(value, { ...good, n: 2 });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).value.n, 2, `${name}: replaced by an intact entry`);
  }
});

test("invalidation: another kernel fingerprint (a CLI change) never reads this one's entries", async () => {
  const cacheDir = scratch();
  await memoAtCommit(REF, OID, "enumerate", async () => "one", { cacheDir, session: createReadSession({ fingerprint: "f".repeat(64) }) });
  let n = 0;
  assert.equal(await memoAtCommit(REF, OID, "enumerate", async () => { n++; return "two"; }, { cacheDir, session: createReadSession({ fingerprint: "e".repeat(64) }) }), "two");
  assert.equal(n, 1);
  assert.equal(await memoAtCommit(REF, OID, "enumerate", () => assert.fail("hit"), { cacheDir, session: createReadSession({ fingerprint: "f".repeat(64) }) }), "one");
  assert.match(kernelFingerprint(), /^[0-9a-f]{64}$/);
});

test("an unwritable cache root: the value is computed and returned, nothing is kept, nothing throws", async () => {
  const cacheDir = scratch();
  chmodSync(cacheDir, 0o500);
  try {
    let n = 0;
    for (let i = 0; i < 2; i++) assert.deepEqual(await memoAtCommit(REF, OID, "enumerate", async () => { n++; return { ok: true }; }, { cacheDir, session: createReadSession() }), { ok: true });
    assert.equal(n, 2);
  } finally { chmodSync(cacheDir, 0o755); }
  assert.equal(existsSync(join(cacheDir, ".parsed")), false);
});

test("a hit bumps the entry's mtime (LRU)", async () => {
  const cacheDir = scratch();
  await memoAtCommit(REF, OID, "enumerate", async () => 1, { cacheDir, session: createReadSession() });
  const [file] = parsedFiles(cacheDir);
  const old = new Date(Date.now() - 86_400_000);
  utimesSync(file, old, old);
  await memoAtCommit(REF, OID, "enumerate", () => assert.fail("hit"), { cacheDir, session: createReadSession() });
  assert.ok(statSync(file).mtimeMs > old.getTime() + 3_600_000);
});

test("invalidation: the kernel fingerprint covers the resolved yaml parser, not only the kernel version", () => {
  const repo = new URL("..", import.meta.url).pathname;
  const fingerprintWithYaml = (version) => {
    const root = mkdtempSync(join(tmpdir(), "oats-fp-"));
    try {
      cpSync(join(repo, "lib"), join(root, "lib"), { recursive: true });
      cpSync(join(repo, "packages", "record", "lib"), join(root, "packages", "record", "lib"), { recursive: true });
      mkdirSync(join(root, "docs"));
      for (const name of readdirSync(join(repo, "docs"))) if (name.endsWith(".schema.json")) cpSync(join(repo, "docs", name), join(root, "docs", name));
      cpSync(join(repo, "package.json"), join(root, "package.json"));
      mkdirSync(join(root, "node_modules", "yaml"), { recursive: true });
      writeFileSync(join(root, "node_modules", "yaml", "package.json"), JSON.stringify({ name: "yaml", version, main: "index.js" }));
      writeFileSync(join(root, "node_modules", "yaml", "index.js"), "");
      return execFileSync(process.execPath, ["--input-type=module", "-e", "const r = await import('./lib/remote.mjs'); process.stdout.write(r.kernelFingerprint());"], { cwd: root, encoding: "utf8" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const a = fingerprintWithYaml("2.9.1"), b = fingerprintWithYaml("2.9.2");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "a parser bump without a kernel version bump is another fingerprint");
  assert.equal(fingerprintWithYaml("2.9.1"), a, "and the same parser is the same fingerprint");
});

test("prune: least recently used entries go until count AND bytes are under the keep bounds; stale fingerprints, observations and temp files go; once per session", async () => {
  const root = scratch();
  const fp = "c".repeat(64);
  const dir = join(root, ".parsed", fp);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    const f = join(dir, `${String(i).padStart(2, "0")}.json`);
    writeFileSync(f, "x".repeat(100));
    const t = new Date(now - (20 - i) * 60_000); // 00 is the least recently used
    utimesSync(f, t, t);
  }
  const limits = { maxEntries: 16, keepEntries: 10, maxBytes: 1 << 30, keepBytes: 1 << 30 };
  assert.deepEqual(pruneStores(root, { fingerprint: fp, limits, now }), { removed: 10, entries: 10, bytes: 1000 });
  assert.deepEqual(readdirSync(dir).sort(), Array.from({ length: 10 }, (_, i) => `${String(i + 10).padStart(2, "0")}.json`));
  // The byte bound alone.
  assert.deepEqual(pruneStores(root, { fingerprint: fp, limits: { maxEntries: 1000, keepEntries: 1000, maxBytes: 900, keepBytes: 500 }, now }), { removed: 5, entries: 5, bytes: 500 });
  // Another kernel's directory: kept while in use, removed after the stale window; old observation records and temp files go.
  const fresh = join(root, ".parsed", "d".repeat(64)), stale = join(root, ".parsed", "e".repeat(64)), observed = join(root, ".observed");
  for (const d of [fresh, stale, observed]) mkdirSync(d, { recursive: true });
  const ago = (ms) => new Date(now - ms);
  utimesSync(stale, ago(PARSED_LIMITS.staleFingerprintMs + 60_000), ago(PARSED_LIMITS.staleFingerprintMs + 60_000));
  writeFileSync(join(observed, "old.json"), "{}"); utimesSync(join(observed, "old.json"), ago(PARSED_LIMITS.staleObservationMs + 60_000), ago(PARSED_LIMITS.staleObservationMs + 60_000));
  writeFileSync(join(observed, "new.json"), "{}");
  writeFileSync(join(dir, ".x.json.1.ab.tmp"), "partial"); utimesSync(join(dir, ".x.json.1.ab.tmp"), ago(PARSED_LIMITS.staleTempMs + 60_000), ago(PARSED_LIMITS.staleTempMs + 60_000));
  pruneStores(root, { fingerprint: fp, now });
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(stale), false);
  assert.deepEqual(readdirSync(observed), ["new.json"]);
  assert.equal(readdirSync(dir).some((f) => f.endsWith(".tmp")), false);
  // memoAtCommit prunes after its first write in a session, and only then.
  const root2 = scratch();
  const session = createReadSession({ fingerprint: fp, parsedLimits: { maxEntries: 2, keepEntries: 1, maxBytes: 1 << 30, keepBytes: 1 << 30 } });
  for (let i = 0; i < 4; i++) await memoAtCommit(REF, OID, `item-${i}`, async () => i, { cacheDir: root2, session });
  assert.equal(session.pruned, true);
  assert.equal(parsedFiles(root2).length, 4, "one prune per session: it ran after the first write, under the bound then");
  await memoAtCommit(REF, OID, "item-9", async () => 9, { cacheDir: root2, session: createReadSession({ fingerprint: fp, parsedLimits: { maxEntries: 2, keepEntries: 1, maxBytes: 1 << 30, keepBytes: 1 << 30 } }) });
  assert.equal(parsedFiles(root2).length, 1, "the next session's first write prunes to the keep bound");
});

test("two sessions writing the same entries at once: both answers correct, every entry intact", async () => {
  const cacheDir = scratch();
  const value = richValue();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => memoAtCommit(REF, OID, `item-${i % 2}`, async () => value, { cacheDir, session: createReadSession() })));
  for (const r of results) assert.deepStrictEqual(r, value);
  for (const f of parsedFiles(cacheDir)) { assert.ok(!f.endsWith(".tmp")); assert.equal(JSON.parse(readFileSync(f, "utf8")).v, 1); }
});

/* ── every item kind, over real bare repos: the cached answer is the uncached one ── */

const writeTree = (dir, files) => { for (const [rel, body] of Object.entries(files)) { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), typeof body === "string" ? body : rel.endsWith(".json") ? JSON.stringify(body) : YAML.stringify(body)); } };
function bareRepo(base, name, files) {
  const bare = join(base, `${name}.git`), work = join(base, `${name}-work`);
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  git(base, "init", "-q", "-b", "main", work);
  writeTree(work, files);
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", name); git(work, "push", "-q", bare, "HEAD:main");
  return { bare, ref: pathToFileURL(bare).href, key: `local/${bare}`, commit: git(work, "rev-parse", "HEAD") };
}
function kinds() {
  const base = scratch();
  const hostRef = pathToFileURL(join(base, "host.git")).href;
  const soul = (name, extra = {}) => ({ schemaVersion: 2, name, description: `${name}.`, work: "directory", ...extra });
  const pkg = bareRepo(base, "pkg", {
    "oats-package/oats-package.json": { package: "fx.pkg", version: "1.0.0", capabilities: ["capabilities/pc"], souls: ["souls/ps"] },
    "oats-package/capabilities/pc/oats.json": { capability: "pc", version: "1.0.0", compatibility: { oats: ">=0.24.0" }, skills: ["skills"] },
    "oats-package/capabilities/pc/skills/s1/SKILL.md": "s1\n",
    "oats-package/souls/ps/soul.yaml": soul("ps"), "oats-package/souls/ps/AGENTS.md": "# ps\n",
  });
  const ext = bareRepo(base, "ext", { "souls/ex/soul.yaml": soul("ex"), "souls/ex/AGENTS.md": "# ex\n" });
  const member = bareRepo(base, "member", {
    "oats-membership.yaml": { schemaVersion: 2, workspace: hostRef },
    "souls/dev/soul.yaml": soul("dev", { private: true }), "souls/dev/AGENTS.md": "# dev\n",
    "capabilities/tool/oats.json": { capability: "tool", version: "1.0.0", compatibility: { oats: ">=0.24.0" }, skills: ["skills"] },
    "capabilities/tool/skills/cut/SKILL.md": "cut\n",
    "capabilities/bad/oats.json": "{ not json",
    "oats-package/oats-package.json": { package: "fx.member", version: "2.0.0" },
  });
  const nobacklink = bareRepo(base, "nobacklink", { "README.md": "hi\n" });
  const host = bareRepo(base, "host", {
    "oats-workspace.yaml": { schemaVersion: 2, name: "kinds", members: [hostRef, member.ref, nobacklink.ref], packages: { "fx.pkg": `git:${pkg.ref}@v1` }, external: [{ source: `${ext.ref}@${ext.commit}`, soul: "souls/ex" }] },
    "oats-membership.yaml": { schemaVersion: 2, workspace: hostRef },
    "souls/lead/soul.yaml": soul("lead"), "souls/lead/AGENTS.md": "# lead\n",
  });
  const lock = { lockfileVersion: 3, packages: { "fx.pkg": { version: "1.0.0", source: `git:${pkg.key}@v1`, url: pkg.bare, commit: pkg.commit, integrity: "sha256-x", path: "oats-package", capabilities: ["pc"], souls: [{ name: "ps", path: "souls/ps", digest: "sha256-y" }] } } };
  return { base, host, member, pkg, ext, lock, cacheDir: join(base, "cache") };
}
const withoutTimes = (d) => JSON.parse(JSON.stringify(d, (k, v) => (k === "observedAt" ? undefined : v)));

test("every item kind (workspace, membership, enumerate, package-soul, external-soul, package-manifests, skill listing, tree-oids): the hit is the uncached answer, read without ls-tree or cat-file", async () => {
  const fx = kinds();
  const { cacheDir } = fx;
  const plain = await discoverWorkspace(fx.host.ref, { local: {}, lock: fx.lock, remoteOptions: { cacheDir } });
  const first = createReadSession();
  const cold = await discoverWorkspace(fx.host.ref, { local: {}, lock: fx.lock, remoteOptions: { cacheDir, session: first } });
  await first.close();
  const reads = [];
  const exec = (args, opts) => { reads.push(args.find((a) => ["ls-remote", "rev-parse", "ls-tree", "cat-file", "fetch"].includes(a))); return runGit(args, opts); };
  const second = createReadSession();
  const warm = await discoverWorkspace(fx.host.ref, { local: {}, lock: fx.lock, remoteOptions: { cacheDir, exec, session: second } });
  assert.deepStrictEqual(withoutTimes(cold), withoutTimes(plain));
  assert.deepStrictEqual(withoutTimes(warm), withoutTimes(plain));
  assert.deepStrictEqual(warm.members.map((m) => m.souls.map((s) => Object.getPrototypeOf(s.definition))), plain.members.map((m) => m.souls.map((s) => Object.getPrototypeOf(s.definition))));
  assert.deepEqual(reads.filter((r) => r === "ls-tree" || r === "cat-file"), [], "every declaration came from the parsed cache");
  assert.ok(warm.members.some((m) => m.reason === "no-backlink") && warm.packageSouls.length === 1 && warm.external.length === 1 && warm.problems.length > 0, "the fixture exercises every kind");

  const pkgPlain = await lockedPackageCapabilities("fx.pkg", fx.lock.packages["fx.pkg"], { remoteOptions: { cacheDir } });
  await lockedPackageCapabilities("fx.pkg", fx.lock.packages["fx.pkg"], { remoteOptions: { cacheDir, session: second } });
  const tool = warm.members.find((m) => m.key === fx.member.key).capabilities.find((c) => c.name === "tool");
  const provPlain = await capabilityProvides({ ref: fx.member.ref, commit: fx.member.commit, dir: tool.path, manifest: tool.manifest, remoteOptions: { cacheDir } });
  await capabilityProvides({ ref: fx.member.ref, commit: fx.member.commit, dir: tool.path, manifest: tool.manifest, remoteOptions: { cacheDir, session: second } });
  const oidsPlain = await remoteTreeOids(fx.member.ref, fx.member.commit, ["capabilities/tool", "souls/dev"], { cacheDir });
  await remoteTreeOids(fx.member.ref, fx.member.commit, ["capabilities/tool", "souls/dev"], { cacheDir, session: second });
  await second.close();
  reads.length = 0;
  const third = createReadSession();
  assert.deepStrictEqual(await lockedPackageCapabilities("fx.pkg", fx.lock.packages["fx.pkg"], { remoteOptions: { cacheDir, exec, session: third } }), pkgPlain);
  assert.deepStrictEqual(await capabilityProvides({ ref: fx.member.ref, commit: fx.member.commit, dir: tool.path, manifest: tool.manifest, remoteOptions: { cacheDir, exec, session: third } }), provPlain);
  assert.deepStrictEqual(await remoteTreeOids(fx.member.ref, fx.member.commit, ["capabilities/tool", "souls/dev"], { cacheDir, exec, session: third }), oidsPlain);
  assert.deepEqual(reads, [], "package manifests, skill listings and tree ids: no git at all on a hit");
  await third.close();
  const items = parsedFiles(cacheDir).map((f) => JSON.parse(readFileSync(f, "utf8")).item.split("\0")[0]);
  for (const kind of ["workspace", "membership", "enumerate", "package-soul", "external-soul", "package-manifests", "list", "tree-oids"]) assert.ok(items.includes(kind), kind);
});

test("invalidation: a package bump (the lock's commit moves) is read at the new commit — package souls and manifests follow the lock, never a cached older commit", async () => {
  const fx = kinds();
  const cacheDir = fx.cacheDir;
  // Warm every package entry at commit A.
  const warm = createReadSession();
  const atA = await discoverWorkspace(fx.host.ref, { local: {}, lock: fx.lock, remoteOptions: { cacheDir, session: warm } });
  await lockedPackageCapabilities("fx.pkg", fx.lock.packages["fx.pkg"], { remoteOptions: { cacheDir, session: warm } });
  await warm.close();
  assert.equal(atA.packageSouls[0].definition.description, "ps.");
  // Commit B: the package soul and its capability's manifest change.
  const work = join(fx.base, "pkg-work");
  writeTree(work, {
    "oats-package/souls/ps/soul.yaml": { schemaVersion: 2, name: "ps", description: "ps, bumped.", work: "directory" },
    "oats-package/capabilities/pc/oats.json": { capability: "pc", version: "1.1.0", compatibility: { oats: ">=0.24.0" }, skills: ["skills"] },
  });
  git(work, "add", "-A"); git(work, "commit", "-q", "-m", "bump"); git(work, "push", "-q", fx.pkg.bare, "HEAD:main");
  const commitB = git(work, "rev-parse", "HEAD");
  const lockB = { ...fx.lock, packages: { "fx.pkg": { ...fx.lock.packages["fx.pkg"], version: "1.1.0", commit: commitB } } };
  const session = createReadSession({ maxAge: 60 });
  const atB = await discoverWorkspace(fx.host.ref, { local: {}, lock: lockB, remoteOptions: { cacheDir, session } });
  const capsB = await lockedPackageCapabilities("fx.pkg", lockB.packages["fx.pkg"], { remoteOptions: { cacheDir, session } });
  await session.close();
  assert.equal(atB.packageSouls[0].commit, commitB);
  assert.equal(atB.packageSouls[0].definition.description, "ps, bumped.");
  assert.deepStrictEqual(withoutTimes(atB), withoutTimes(await discoverWorkspace(fx.host.ref, { local: {}, lock: lockB, remoteOptions: { cacheDir } })), "the uncached answer at B");
  assert.deepStrictEqual(capsB, await lockedPackageCapabilities("fx.pkg", lockB.packages["fx.pkg"], { remoteOptions: { cacheDir } }));
  assert.ok(JSON.stringify(capsB).includes('"1.1.0"'), "the capability's manifest at B");
  // And back to A: A's entries still answer for A.
  const back = createReadSession();
  const againA = await discoverWorkspace(fx.host.ref, { local: {}, lock: fx.lock, remoteOptions: { cacheDir, session: back } });
  await back.close();
  assert.equal(againA.packageSouls[0].definition.description, "ps.");
});

test("a value carrying a credential-bearing URL is never written to the parsed cache; an ssh user without a password is", async () => {
  const cacheDir = scratch();
  const session = createReadSession({ fingerprint: "f".repeat(64) });
  const commit = "a".repeat(40);
  const files = () => { try { return readdirSync(join(cacheDir, ".parsed", "f".repeat(64))).filter((f) => f.endsWith(".json")); } catch { return []; } };
  const opts = { cacheDir, session };
  for (const secret of ["https://tok3n@github.com/o/r", "https://x:tok3n@github.com/o/r", "ssh://u:tok3n@example.com/o/r"]) {
    const value = { members: [secret] };
    assert.deepStrictEqual(await memoAtCommit("https://github.com/o/r", commit, `ws\0${secret}`, async () => value, opts), value, "the value is still answered");
  }
  assert.deepEqual(files(), [], "nothing written");
  await memoAtCommit("https://github.com/o/r", commit, "ws-ssh", async () => ({ members: ["ssh://git@github.com/o/r"] }), opts);
  assert.equal(files().length, 1, "a user without a password is not a secret");
  for (const f of files()) assert.ok(!readFileSync(join(cacheDir, ".parsed", "f".repeat(64), f), "utf8").includes("tok3n"));
  await session.close();
});
