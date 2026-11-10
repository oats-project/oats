import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parsePorcelainV2, parseRemoteUrl } from "../lib/instance-git.mjs";
import { deploymentsImported } from "./helpers/host-fixture.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-instance-git-")));
deploymentsImported(join(base, "oats-home"));
test.after(() => rmSync(base, { recursive: true, force: true }));
const write = (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(dir, { remote = true } = {}) {
  mkdirSync(dir, { recursive: true }); git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid"); git(dir, "config", "user.name", "T");
  write(join(dir, "README.md"), "hello\n"); write(join(dir, "src", "a.txt"), "a\n"); git(dir, "add", "."); git(dir, "commit", "-qm", "init");
  if (remote) {
    const bare = dir + ".git"; execFileSync("git", ["clone", "-q", "--bare", dir, bare]);
    git(dir, "remote", "add", "origin", bare); git(dir, "fetch", "-q", "origin"); git(dir, "remote", "set-head", "origin", "main");
    git(dir, "branch", "-u", "origin/main", "main");
  }
  return dir;
}
const env = () => { const e = { ...process.env, OATS_HOME_DIR: join(base, "oats-home") }; for (const k of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "PI_AGENT_INSTANCE", "PI_AGENTS_ROOT", "OATS_DEPLOYMENT", "OATS_RESOLUTION"]) delete e[k]; return e; };
function oats(args, cwd = base) {
  const r = spawnSync(process.execPath, [CLI, ...args, "--json"], { encoding: "utf8", env: env(), cwd });
  let envelope = null; try { envelope = JSON.parse(r.stdout); } catch { /* reported by caller */ }
  return { ...r, envelope };
}
/** A scope with an agent whose instance home links `work` to a git tree. */
function scope(name, { work, instance = "dev-1", agent = "dev", branch = "feat/x" } = {}) {
  const ws = join(base, name); mkdirSync(ws, { recursive: true });
  write(join(ws, "oats-config.yaml"), "name: t\n");
  write(join(ws, "agents", agent, "soul", "soul.yaml"), `name: ${agent}\nkind: persistent\nrepo: .\nwork: worktree\nharness: pi\n`);
  write(join(ws, "agents", agent, "soul", "AGENTS.md"), "# dev\n");
  const home = join(ws, "agents", agent, "instances", instance);
  write(join(home, "instance.json"), JSON.stringify({ agent, instance, home, repo: ws, work: "worktree", branch }));
  if (work) symlinkSync(work, join(home, "work"));
  return { ws, home };
}

test("porcelain v2 NUL records: renames keep both paths, detached/unborn/upstream headers parse, paths with spaces survive", () => {
  const raw = ["# branch.oid abc", "# branch.head (detached)", "# branch.upstream origin/main", "# branch.ab +3 -1",
    "1 .M N... 100644 100644 100644 aaa bbb my file.txt", "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt", "old name.txt",
    "u UU N... 100644 100644 100644 100644 a b c conflict.txt", "? untracked.txt", "! ignored.txt", ""].join("\0");
  const p = parsePorcelainV2(raw);
  assert.deepEqual(p.branch, { oid: "abc", head: null, upstream: "origin/main", ahead: 3, behind: 1 });
  assert.deepEqual(p.entries.map((e) => [e.kind, e.path, e.origPath]), [
    ["changed", "my file.txt", null], ["renamed", "new name.txt", "old name.txt"], ["unmerged", "conflict.txt", null], ["untracked", "untracked.txt", null], ["ignored", "ignored.txt", null]]);
  assert.deepEqual(parsePorcelainV2("# branch.oid (initial)\0# branch.head main\0").branch, { oid: null, head: "main", upstream: null, ahead: null, behind: null });
});

test("instance git: branch/status from the TREE (recorded branch drift named), upstream and base comparisons reported separately, renames kept, ids opaque", () => {
  const work = repo(join(base, "r1"));
  git(work, "checkout", "-qb", "feat/y"); // tree says feat/y; the home recorded feat/x
  write(join(work, "src", "b.txt"), "b\n"); git(work, "add", "."); git(work, "commit", "-qm", "ahead one");
  git(work, "mv", "src/a.txt", "src/renamed a.txt"); write(join(work, "README.md"), "hello\nmore\n"); write(join(work, "new.txt"), "n\n");
  const { ws } = scope("s1", { work });
  const r = oats(["instance", "git", "dev-1", "--dir", ws]);
  assert.equal(r.status, 0, r.stdout + r.stderr); const g = r.envelope.result;
  assert.equal(g.instanceGitApi, 1); assert.equal(g.instance, "dev-1"); assert.equal(g.observation.branch, "feat/y"); assert.equal(g.observation.detached, false);
  assert.equal(g.observation.revision, git(work, "rev-parse", "HEAD")); assert.equal(realpathSync(g.observation.worktree), realpathSync(work));
  assert.deepEqual(g.recorded, { branch: "feat/x", repo: ws, drift: true }, "the recorded spawn branch is reported as recorded, never as the truth");
  assert.deepEqual(g.upstream, { ref: null, ahead: null, behind: null }, "no upstream on the new branch is unknown, not 0/0");
  assert.equal(g.base.ref, "origin/main"); assert.equal(g.base.source, "origin/HEAD"); assert.equal(g.base.ahead, 1); assert.equal(g.base.behind, 0);
  assert.equal(g.base.mergeBase, git(work, "rev-parse", "origin/main"));
  const byPath = Object.fromEntries(g.files.map((f) => [f.path, f]));
  assert.deepEqual([byPath["src/renamed a.txt"].kind, byPath["src/renamed a.txt"].origPath], ["renamed", "src/a.txt"]);
  assert.equal(byPath["README.md"].kind, "changed"); assert.equal(byPath["new.txt"].kind, "untracked");
  assert.deepEqual(g.summary, { changed: 1, renamed: 1, copied: 0, unmerged: 0, untracked: 1 });
  for (const f of g.files) assert.match(f.id, /^[a-f0-9]{24}$/);
  assert.ok(g.notes.some((n) => /no upstream/.test(n)));
  // P1: the remote is reported (parsed, no network) so an ADE can pick a forge backend without running Git.
  assert.equal(g.remote.name, "origin"); assert.equal(g.remote.source, "origin"); assert.equal(g.remote.host, null, "a local bare path has no host");
  assert.equal(g.remote.url, work + ".git");
  // With an upstream, ahead/behind come from git's own branch.ab.
  git(work, "push", "-q", "-u", "origin", "feat/y"); write(join(work, "src", "c.txt"), "c\n"); git(work, "add", "src/c.txt"); git(work, "commit", "-qm", "local only");
  const g2 = oats(["instance", "git", "dev-1", "--dir", ws]).envelope.result;
  assert.deepEqual(g2.upstream, { ref: "origin/feat/y", ahead: 1, behind: 0 }); assert.equal(g2.base.ahead, 2);
});

test("instance git: per-file line counts (numstat) against the captured HEAD, staged + unstaged combined; binary, untracked and renames as the contract says; paths with spaces intact", () => {
  const work = repo(join(base, "r-numstat"));
  write(join(work, "bin0.dat"), Buffer.from([0, 1, 2, 3])); git(work, "add", "bin0.dat"); git(work, "commit", "-qm", "binary");
  // README: one line staged, a second unstaged → +2 combined, as the status letters (MM) imply.
  write(join(work, "README.md"), "hello\nstaged\n"); git(work, "add", "README.md");
  write(join(work, "README.md"), "hello\nstaged\nunstaged\n");
  // A rename to a path with a space, edited after the move: counts land on the NEW path.
  git(work, "mv", "src/a.txt", "src/b c.txt"); write(join(work, "src/b c.txt"), "a\nb\n");
  write(join(work, "bin0.dat"), Buffer.from([0, 9, 9, 9, 0]));
  write(join(work, "new file.txt"), "one\ntwo\n");
  const { ws } = scope("s-numstat", { work });
  const g = oats(["instance", "git", "dev-1", "--dir", ws]).envelope.result;
  const f = (p) => { const e = g.files.find((x) => x.path === p); assert.ok(e, `${p} listed`); return e; };
  assert.deepEqual([f("README.md").additions, f("README.md").deletions, f("README.md").binary], [2, 0, false]);
  assert.equal(f("src/b c.txt").kind, "renamed"); assert.equal(f("src/b c.txt").origPath, "src/a.txt");
  assert.deepEqual([f("src/b c.txt").additions, f("src/b c.txt").deletions, f("src/b c.txt").binary], [1, 0, false]);
  assert.deepEqual([f("bin0.dat").additions, f("bin0.dat").deletions, f("bin0.dat").binary], [null, null, true]);
  assert.equal(f("new file.txt").kind, "untracked");
  assert.deepEqual([f("new file.txt").additions, f("new file.txt").deletions, f("new file.txt").binary], [null, null, null], "untracked: no baseline, contents unread");
  assert.equal(g.instanceGitApi, 1, "additive fields: the API integer stays");
  // An unborn tree counts against the empty tree.
  const fresh = join(base, "r-numstat-unborn"); mkdirSync(fresh); git(fresh, "init", "-q", "-b", "main");
  write(join(fresh, "first.txt"), "1\n2\n3\n"); git(fresh, "add", "first.txt");
  const u = oats(["instance", "git", "dev-1", "--dir", scope("s-numstat-unborn", { work: fresh }).ws]).envelope.result;
  assert.equal(u.observation.unborn, true);
  assert.deepEqual([u.files[0].additions, u.files[0].deletions, u.files[0].binary], [3, 0, false]);
});

test("instance diff: bounded, against HEAD or empty, staged/renamed/untracked/binary handled, and a moved tree or foreign id REFUSES with the current observation", () => {
  const work = repo(join(base, "r2"));
  write(join(work, "README.md"), "hello\nchanged\n"); write(join(work, "big.txt"), "x".repeat(300 * 1024) + "\n"); write(join(work, "bin.dat"), Buffer.from([0, 1, 2, 255, 0, 3]));
  git(work, "mv", "src/a.txt", "src/moved.txt");
  const { ws } = scope("s2", { work });
  const g = oats(["instance", "git", "dev-1", "--dir", ws]).envelope.result;
  const rev = g.observation.revision, idx = g.observation.indexRevision, id = (p) => g.files.find((f) => f.path === p).id;
  const d = (p, extra = []) => oats(["instance", "diff", "dev-1", "--dir", ws, "--file", id(p), "--revision", rev, "--index-revision", idx, ...extra]);
  const readme = d("README.md"); assert.equal(readme.status, 0, readme.stdout + readme.stderr);
  assert.equal(readme.envelope.result.against, rev, "the diff names the captured revision it was taken against, not the moving HEAD"); assert.match(readme.envelope.result.patch, /\+changed/); assert.equal(readme.envelope.result.truncated, false);
  const moved = d("src/moved.txt").envelope.result; assert.equal(moved.file.origPath, "src/a.txt"); assert.match(moved.patch, /rename from src\/a\.txt/);
  const big = d("big.txt").envelope.result; assert.equal(big.against, "empty"); assert.equal(big.truncated, true); assert.equal(big.limit, 256 * 1024); assert.ok(Buffer.byteLength(big.patch) <= 256 * 1024);
  const bin = d("bin.dat").envelope.result; assert.equal(bin.binary, true); assert.equal(bin.patch, "");
  // Move the tree: same file id, same revision claim → refused, never served.
  git(work, "add", "README.md");
  const stale = d("README.md"); assert.equal(stale.status, 1); assert.equal(stale.envelope.error.code, "E_STALE_OBSERVATION");
  assert.equal(stale.envelope.error.details.observation.revision, rev, "index moved, HEAD did not: the index revision is what changed");
  assert.notEqual(stale.envelope.error.details.observation.indexRevision, idx);
  const bogus = oats(["instance", "diff", "dev-1", "--dir", ws, "--file", "0".repeat(24), "--revision", rev]);
  assert.equal(bogus.envelope.error.code, "E_STALE_OBSERVATION");
  const bad = oats(["instance", "diff", "dev-1", "--dir", ws, "--file", "../etc/passwd", "--revision", rev]);
  assert.equal(bad.envelope.error.code, "E_BAD_ARGS", "the file selector is the opaque id, never a path");
});

test("instance addressing: unknown, ambiguous (twins refuse with candidates; --home resolves), --home mismatch, missing work tree, detached HEAD, no default branch", () => {
  const work = repo(join(base, "r3"), { remote: false });
  const { ws, home } = scope("s3", { work });
  // Twin: same instance name under another agent.
  const twinHome = join(ws, "agents", "ops", "instances", "dev-1");
  write(join(ws, "agents", "ops", "soul", "soul.yaml"), "name: ops\nkind: persistent\nrepo: .\nwork: worktree\nharness: pi\n"); write(join(ws, "agents", "ops", "soul", "AGENTS.md"), "# ops\n");
  write(join(twinHome, "instance.json"), JSON.stringify({ agent: "ops", instance: "dev-1", home: twinHome, repo: ws, work: "worktree", branch: "z" }));
  const amb = oats(["instance", "git", "dev-1", "--dir", ws]);
  assert.equal(amb.status, 1); assert.equal(amb.envelope.error.code, "E_AMBIGUOUS_INSTANCE");
  assert.deepEqual(amb.envelope.error.details.candidates.map((c) => c.agent).sort(), ["dev", "ops"]);
  const byHome = oats(["instance", "git", "dev-1", "--dir", ws, "--home", home]); assert.equal(byHome.status, 0, byHome.stdout + byHome.stderr);
  assert.equal(byHome.envelope.result.base.ref, "main", "no remote: the local default branch is the base"); assert.equal(byHome.envelope.result.base.source, "well-known");
  assert.equal(oats(["instance", "git", "other-1", "--dir", ws, "--home", home]).envelope.error.code, "E_HOME_MISMATCH");
  assert.equal(oats(["instance", "git", "ghost-1", "--dir", ws]).envelope.error.code, "E_SESSION_UNKNOWN");
  const noWork = oats(["instance", "git", "dev-1", "--dir", ws, "--home", twinHome]); assert.equal(noWork.envelope.error.code, "E_NO_WORKTREE");
  git(work, "checkout", "-q", "--detach");
  const det = oats(["instance", "git", "dev-1", "--dir", ws, "--home", home]).envelope.result;
  assert.equal(det.observation.branch, null); assert.equal(det.observation.detached, true); assert.equal(det.recorded.drift, true);
  // Rename the only branch away from every well-known default: base is unknown, said so.
  git(work, "branch", "-m", "main", "trunk");
  const nobase = oats(["instance", "git", "dev-1", "--dir", ws, "--home", home]).envelope.result;
  assert.deepEqual(nobase.base, { ref: null, source: null, mergeBase: null, ahead: null, behind: null }); assert.ok(nobase.notes.some((n) => /no default branch/.test(n)));
  assert.equal(oats(["instance", "git"]).envelope.error.code, "E_BAD_ARGS"); assert.equal(oats(["instance", "nope", "dev-1", "--dir", ws]).envelope.error.code, "E_BAD_ARGS");
});

test("hardening: configured external diff/textconv/fsmonitor helpers NEVER execute, the observation writes no object and no index byte, and a HEAD/index/content move during the read refuses", () => {
  const work = repo(join(base, "r4"));
  const sentinel = join(base, "r4-helper-ran");
  const helper = join(base, "r4-helper.sh"); writeFileSync(helper, `#!/bin/sh\necho ran > '${sentinel}'\necho HOSTILE-PATCH\n`, { mode: 0o700 });
  // Hostile repo-local config: an agent working in the tree can write these.
  git(work, "config", "diff.external", helper); git(work, "config", "core.fsmonitor", helper);
  git(work, "config", "diff.evil.textconv", helper); write(join(work, ".gitattributes"), "*.txt diff=evil\n");
  write(join(work, "src", "a.txt"), "a\nchanged\n"); write(join(work, "README.md"), "hello\nedit\n"); git(work, "add", "README.md");
  const { ws } = scope("s4", { work });
  // The fixture's OWN git calls would trigger the helper too (that is the point of the finding);
  // run them helper-free and reset the sentinel so only the kernel's reads are measured.
  const safe = (...a) => execFileSync("git", ["-c", "core.fsmonitor=false", "-C", work, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const objectsBefore = safe("count-objects", "-v"), indexBefore = readFileSync(join(work, ".git", "index"));
  rmSync(sentinel, { force: true });
  const g = oats(["instance", "git", "dev-1", "--dir", ws]); assert.equal(g.status, 0, g.stdout + g.stderr);
  const rev = g.envelope.result.observation.revision, idx = g.envelope.result.observation.indexRevision, id = (p) => g.envelope.result.files.find((f) => f.path === p).id;
  const d = oats(["instance", "diff", "dev-1", "--dir", ws, "--file", id("src/a.txt"), "--revision", rev, "--index-revision", idx]);
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.envelope.result.patch, /\+changed/); assert.doesNotMatch(d.envelope.result.patch, /HOSTILE/);
  assert.equal(existsSync(sentinel), false, "no configured helper executed during observation or diff");
  assert.equal(safe("count-objects", "-v"), objectsBefore, "observing and diffing wrote no git object");
  assert.deepEqual(readFileSync(join(work, ".git", "index")), indexBefore, "observing and diffing changed no index byte");
  assert.deepEqual(d.envelope.result.readOnly, { helpers: "disabled", optionalLocks: "off", objectsWritten: 0 });
  // Index moved between observation and diff (README was staged before, now unstaged) → refused.
  safe("reset", "-q", "README.md");
  const moved = oats(["instance", "diff", "dev-1", "--dir", ws, "--file", id("README.md"), "--revision", rev, "--index-revision", idx]);
  assert.equal(moved.envelope.error.code, "E_STALE_OBSERVATION");
  // A caller who omits --index-revision still cannot get a diff for a file whose content changed under it:
  // the file id is bound to the index revision, so it is not in the new observation.
  const g2 = oats(["instance", "git", "dev-1", "--dir", ws]).envelope.result;
  assert.notEqual(g2.observation.indexRevision, idx); assert.ok(!g2.files.some((f) => f.id === id("README.md")));
});

/** A repository an agent has given a filter driver: `configure(work, helper)` writes the hostile
 *  configuration after the fixture's own commit, then a tracked file is rewritten (same size, so
 *  Git must read its content to compare it) and an untracked one is added. `helper` records that it
 *  ran in `sentinel`. */
function filteredRepo(name, configure) {
  const work = repo(join(base, name));
  const sentinel = join(base, `${name}-helper-ran`);
  const helper = join(base, `${name}-helper.sh`); writeFileSync(helper, `#!/bin/sh\necho ran > '${sentinel}'\ncat\n`, { mode: 0o700 });
  configure(work, helper);
  write(join(work, "src", "a.txt"), "b\n"); write(join(work, "new.txt"), "new\n");
  rmSync(sentinel, { force: true });
  return { work, sentinel, helper, ...scope(`s-${name}`, { work }) };
}
/** `oats instance git`, then `oats instance diff` of every file it lists → { result, patches: path → patch }. */
function observeAndDiff(ws) {
  const g = oats(["instance", "git", "dev-1", "--dir", ws]); assert.equal(g.status, 0, g.stdout + g.stderr);
  const result = g.envelope.result, patches = {};
  for (const f of result.files) {
    const d = oats(["instance", "diff", "dev-1", "--dir", ws, "--file", f.id, "--revision", result.observation.revision, "--index-revision", result.observation.indexRevision]);
    assert.equal(d.status, 0, d.stdout + d.stderr);
    patches[f.path] = d.envelope.result.patch;
  }
  return { result, patches };
}
const FILTER_NOTE = /filter driver/;

test("hardening: a clean, smudge or process filter the repository's configuration defines NEVER executes, wherever its attribute and its definition come from, and the observation is the unfiltered one", () => {
  const inTree = (work) => write(join(work, ".gitattributes"), "* filter=evil\n");
  const inInfo = (work) => write(join(work, ".git", "info", "attributes"), "* filter=evil\n");
  const cases = {
    "clean": (work, helper) => { git(work, "config", "filter.evil.clean", helper); inTree(work); },
    "clean-required": (work, helper) => { git(work, "config", "filter.evil.clean", helper); git(work, "config", "filter.evil.required", "true"); inTree(work); },
    "smudge": (work, helper) => { git(work, "config", "filter.evil.smudge", helper); inTree(work); },
    "process": (work, helper) => { git(work, "config", "filter.evil.process", helper); inTree(work); },
    "info-attributes": (work, helper) => { git(work, "config", "filter.evil.clean", helper); inInfo(work); },
    "included": (work, helper) => {
      const included = join(base, "r5-included.gitconfig"); writeFileSync(included, `[filter "evil"]\n\tclean = ${helper}\n\tprocess = ${helper}\n`);
      git(work, "config", "include.path", included); inInfo(work);
    },
    "worktree-config": (work, helper) => { git(work, "config", "extensions.worktreeConfig", "true"); git(work, "config", "--worktree", "filter.evil.clean", helper); inInfo(work); },
    "name-with-dots": (work, helper) => { git(work, "config", "filter.Évil.v2.x.clean", helper); write(join(work, ".gitattributes"), "* filter=Évil.v2.x\n"); },
  };
  const executed = [], observed = {};
  for (const [name, configure] of Object.entries(cases)) {
    const fx = filteredRepo(`r5-${name}`, configure);
    observed[name] = observeAndDiff(fx.ws);
    if (existsSync(fx.sentinel)) executed.push(name);
  }
  assert.deepEqual(executed, [], "no filter the configuration defines executed during an observation or a diff");
  for (const [name, { result, patches }] of Object.entries(observed)) {
    const row = (path) => { const f = result.files.find((x) => x.path === path); assert.ok(f, `${name}: ${path} is listed: ${JSON.stringify(result.files.map((x) => x.path))}`); return f; };
    assert.deepEqual([row("src/a.txt").kind, row("src/a.txt").xy, row("src/a.txt").additions, row("src/a.txt").deletions], ["changed", ".M", 1, 1], name);
    assert.equal(row("new.txt").kind, "untracked", name);
    assert.match(patches["src/a.txt"], /^-a\n\+b$/m, name);
    assert.match(patches["new.txt"], /^\+new$/m, name);
    assert.ok(result.notes.some((n) => FILTER_NOTE.test(n)), `${name}: the observation says a filter driver was not run: ${JSON.stringify(result.notes)}`);
  }
});

test("hardening: a filter in use (stored form differs from the work tree's) is not run: a touched file reads as changed, its diff is the stored form against the work tree's bytes, and a note says so; a repository with no filter driver has no such note", () => {
  const work = repo(join(base, "r6"));
  const sentinel = join(base, "r6-helper-ran");
  const helper = join(base, "r6-helper.sh"); writeFileSync(helper, `#!/bin/sh\necho ran > '${sentinel}'\ntr a-z A-Z\n`, { mode: 0o700 });
  git(work, "config", "filter.upper.clean", helper); write(join(work, ".gitattributes"), "*.dat filter=upper\n");
  write(join(work, "big.dat"), "payload\n"); git(work, "add", "."); git(work, "commit", "-qm", "a filtered file");
  assert.equal(git(work, "cat-file", "blob", "HEAD:big.dat"), "PAYLOAD", "the fixture's own commit stored the filtered form");
  assert.equal(git(work, "status", "--porcelain"), "", "with its filter, the tree is clean");
  write(join(work, "big.dat"), "payload\n"); // the same bytes, written again: Git must read the content to compare it
  rmSync(sentinel, { force: true });
  const { ws } = scope("s6", { work });
  const { result, patches } = observeAndDiff(ws);
  assert.equal(existsSync(sentinel), false, "the filter was not run");
  const f = result.files.find((x) => x.path === "big.dat");
  assert.deepEqual([f?.kind, f?.xy, f?.additions, f?.deletions], ["changed", ".M", 1, 1], JSON.stringify(result.files));
  assert.match(patches["big.dat"], /^-PAYLOAD\n\+payload$/m);
  assert.equal(result.notes.filter((n) => FILTER_NOTE.test(n)).length, 1, JSON.stringify(result.notes));

  const plain = repo(join(base, "r6-plain")); write(join(plain, "src", "a.txt"), "b\n");
  const g = oats(["instance", "git", "dev-1", "--dir", scope("s6-plain", { work: plain }).ws]);
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.deepEqual(g.envelope.result.notes, [], "no filter driver, no note");
});

test("hardening: a filter driver whose name Git's -c cannot carry refuses the observation, and the filter is not run", () => {
  const fx = filteredRepo("r7", (work, helper) => { git(work, "config", "filter.a=b.clean", helper); write(join(work, ".git", "info", "attributes"), "* filter=a=b\n"); });
  const g = oats(["instance", "git", "dev-1", "--dir", fx.ws]);
  assert.notEqual(g.status, 0, g.stdout + g.stderr);
  assert.equal(g.envelope.error.code, "E_GIT_FAILED", g.stdout);
  assert.match(g.envelope.error.message, /filter driver/);
  assert.equal(existsSync(fx.sentinel), false, "the filter was not run");
});

// GIT_NO_LAZY_FETCH is Git 2.44's; an older Git ignores it, and there is no protection to test.
const [gitMajor, gitMinor] = (/(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" })) || []).slice(1).map(Number);
const gitHasNoLazyFetch = gitMajor > 2 || (gitMajor === 2 && gitMinor >= 44);
test("hardening: an object the repository lacks is never fetched, so a promisor remote its configuration names never runs; the observation fails instead", { skip: !gitHasNoLazyFetch && "Git before 2.44 has no GIT_NO_LAZY_FETCH" }, () => {
  const work = repo(join(base, "r-lazy"));
  write(join(work, "later.txt"), "later\n"); git(work, "add", "later.txt"); git(work, "commit", "-qm", "a commit only this repository has");
  const head = git(work, "rev-parse", "HEAD");
  rmSync(join(work, ".git", "objects", head.slice(0, 2), head.slice(2)));
  const sentinel = join(base, "r-lazy-helper-ran");
  const helper = join(base, "r-lazy-helper.sh"); writeFileSync(helper, `#!/bin/sh\ntouch '${sentinel}'\nexit 1\n`, { mode: 0o700 });
  // Hostile repo-local config: a fetch of a missing object would run the helper.
  git(work, "config", "remote.attack.url", `ext::${helper}`); git(work, "config", "remote.attack.promisor", "true"); git(work, "config", "protocol.ext.allow", "always");
  const { ws } = scope("s-lazy", { work });
  const g = oats(["instance", "git", "dev-1", "--dir", ws]);
  assert.notEqual(g.status, 0, "the observation fails: the commit is missing");
  assert.equal(existsSync(sentinel), false, "no command the repository's configuration names for a fetch was run");
});

test("remote url parsing: ssh scp-like, ssh://, https with user, .git suffix, ports; local paths and junk are null", () => {
  assert.deepEqual(parseRemoteUrl("git@github.com:awebai/oats.git"), { host: "github.com", path: "awebai/oats" });
  assert.deepEqual(parseRemoteUrl("https://github.com/awebai/oats.git"), { host: "github.com", path: "awebai/oats" });
  assert.deepEqual(parseRemoteUrl("https://GitHub.com/awebai/oats/"), { host: "github.com", path: "awebai/oats" });
  assert.deepEqual(parseRemoteUrl("ssh://git@gitlab.example.com:2222/group/sub/repo.git"), { host: "gitlab.example.com", path: "group/sub/repo" });
  assert.deepEqual(parseRemoteUrl("https://user@dev.azure.com/org/proj/_git/repo"), { host: "dev.azure.com", path: "org/proj/_git/repo" });
  assert.deepEqual(parseRemoteUrl("/local/path/repo.git"), { host: null, path: null });
  assert.deepEqual(parseRemoteUrl("not a url"), { host: null, path: null });
  assert.deepEqual(parseRemoteUrl(""), { host: null, path: null }); assert.deepEqual(parseRemoteUrl(null), { host: null, path: null });
});

test("remote: branch-configured remote wins over origin; no remote at all is null (never invented)", () => {
  const work = repo(join(base, "r5"), { remote: false });
  const { ws, home } = scope("s5", { work });
  assert.equal(oats(["instance", "git", "dev-1", "--dir", ws, "--home", home]).envelope.result.remote, null);
  git(work, "remote", "add", "origin", "git@github.com:acme/one.git"); git(work, "remote", "add", "fork", "https://github.com/me/one.git");
  const viaOrigin = oats(["instance", "git", "dev-1", "--dir", ws, "--home", home]).envelope.result.remote;
  assert.deepEqual(viaOrigin, { name: "origin", url: "git@github.com:acme/one.git", host: "github.com", path: "acme/one", source: "origin" });
  git(work, "config", "branch.main.remote", "fork");
  const viaBranch = oats(["instance", "git", "dev-1", "--dir", ws, "--home", home]).envelope.result.remote;
  assert.deepEqual(viaBranch, { name: "fork", url: "https://github.com/me/one.git", host: "github.com", path: "me/one", source: "branch-upstream" });
});
