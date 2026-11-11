// What is at `<home>/work`, for the retire and for its plan alike (awebai/oats#962). One function
// answers it (core instanceWork): the instance's own tree, a directory of the home, or what the
// record says. A real directory that is not the instance's own tree is bytes of the home: the
// retire copies it to recovery, checks the copy and removes it with the home, and the plan says so
// beforehand. It is never read as a work tree to move, never removed through Git, and never left
// out of the copy. Every case runs the real CLI against a scratch deployment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const FILE = "only-copy.txt", BYTES = "work that exists nowhere else\n";
const REST = ", delete branch false, stop children true";
const HOME_DIRECTORY_LINE = `  defaults: no work tree of its own (work/ is a real directory of the home: copied to recovery when not empty and then removed with the home)${REST}`;
const OWN_TREE_LINE = `  defaults: retain worktree true${REST}`;
const HOME_DIRECTORY_NOTE = "work/ is a real directory of the home and not a work tree of the instance's own: the retire copies it to recovery when it is not empty (a .git in it included), checks the copy, and removes it with the home";
const WORK_COPIED_NOTE = "recovery: work/ is copied there when it is not empty";
const NOT_OBSERVED = { observed: false, reason: "E_NO_WORKTREE" };
const SOULS = { dev: { soul: { work: "worktree" } }, dir: { soul: { work: "directory" } }, wsp: { soul: { work: "workspace" } }, chk: { soul: { work: "checkout" } } };

/** Every entry under `dir` → Map(path relative to it → what it is and holds): a file's bytes, a
 *  link's target, a directory's name alone. What "byte for byte" compares. */
function entries(dir, out = new Map(), root = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name), rel = relative(root, path);
    if (e.isSymbolicLink()) out.set(rel, `link:${readlinkSync(path)}`);
    else if (e.isDirectory()) { out.set(rel, "dir"); entries(path, out, root); }
    else out.set(rel, `file:${readFileSync(path).toString("base64")}`);
  }
  return out;
}

/** A scratch deployment and what the cases do in it. `checkout`: the deployment directory is a Git
 *  checkout, so Git answers for every plain directory under it. */
function deployment(t, { checkout = false } = {}) {
  const fx = v2Deployment({ souls: SOULS, t });
  // An in-process spawn looks for the harness's executable on this process's PATH, with
  // `launch: false` too: the fixture's PATH has the inert harnesses, a bare runner's has none.
  const hostPath = process.env.PATH; process.env.PATH = fx.env.PATH; t.after(() => { process.env.PATH = hostPath; });
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: fx.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (checkout) { execFileSync("git", ["init", "-q", fx.dep], { env: fx.env }); git(fx.dep, "commit", "--allow-empty", "-qm", "the deployment is a checkout"); }
  const envelope = (r) => { try { return r.json(); } catch { assert.fail(`no envelope: ${r.stdout}${r.stderr}`); } };
  /** The plan of one instance: its JSON result, its text, and the text's `defaults:` line. */
  const plan = (instance) => {
    const json = envelope(fx.cli(["retire", instance, "--plan", "--json"]));
    assert.equal(json.ok, true, JSON.stringify(json.error));
    const text = fx.cli(["retire", instance, "--plan"]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    const lines = text.stdout.split("\n").filter((l) => l.startsWith("  defaults: "));
    assert.equal(lines.length, 1, text.stdout);
    return { ...json.result, text: text.stdout, line: lines[0] };
  };
  /** `oats retire <instance> --json` → { status, result } or { status, error }. A retire that is
   *  done prints its receipt, over several lines; one that is refused prints the envelope. */
  const retire = (instance, flags = []) => {
    const r = fx.cli(["retire", instance, "--json", ...flags]);
    let out;
    try { out = JSON.parse(r.stdout); } catch { assert.fail(`no JSON: ${r.stdout}${r.stderr}`); }
    return out.ok === false ? { status: r.status, error: out.error } : { status: r.status, result: out.ok === true ? out.result : out };
  };
  const retired = (instance, flags) => { const r = retire(instance, flags); assert.equal(r.status, 0, JSON.stringify(r.error)); return r.result; };
  const refused = (instance, flags, code) => { const r = retire(instance, flags); assert.equal(r.status, 1, JSON.stringify(r.result)); assert.equal(r.error.code, code, r.error.message); return r.error; };
  /** `oats instance git <instance> --json` → its envelope. */
  const instanceGit = (instance) => envelope(fx.cli(["instance", "git", instance, "--json"]));
  /** Rewrite a home's record through `change(record)`; a returned value replaces the record. */
  const record = (home, change) => {
    const path = join(home, "instance.json"), meta = readJson(path);
    writeFileSync(path, JSON.stringify(change(meta) ?? meta, null, 2) + "\n");
  };
  const baselines = (home) => join(dirname(home), ".oats-retirement", "baselines");
  /** An instance attached to `owner`'s work/: a home that was given a link, with a valid receipt. */
  const attached = (owner, purpose) => {
    const e = envelope(fx.cli(["spawn", "dev", "--work", "attached", "--work-dir", join(owner.home, "work"), "--repo", fx.member, "--purpose", purpose, "--no-launch", "--json"]));
    assert.equal(e.ok, true, JSON.stringify(e.error));
    return e.result;
  };
  /** Make `home`'s work/ a real directory holding the one file, in place of the link it was given. */
  const realDirectory = (home) => {
    const work = join(home, "work");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work);
    writeFileSync(join(work, FILE), BYTES);
    return work;
  };
  /** Where the one file is under the deployment, relative to it. */
  const fileAt = () => [...entries(fx.dep).keys()].filter((p) => p.endsWith(`/${FILE}`) || p === FILE);
  return { fx, git, plan, retire, retired, refused, instanceGit, record, baselines, attached, realDirectory, fileAt };
}

/** What a plan says of a directory of the home: nothing is retained, the line and the notes say what
 *  the retire does, and nothing says that a worktree is retained. */
function assertPlansHomeDirectory(seen, label) {
  assert.deepEqual(seen.defaults, { retainWorktree: false, deleteBranch: false, stopChildren: true, retainChildren: true }, label);
  assert.equal(seen.line, HOME_DIRECTORY_LINE, label);
  assert.ok(seen.notes.includes(HOME_DIRECTORY_NOTE), `${label}: ${JSON.stringify(seen.notes)}`);
  assert.ok(seen.notes.includes(WORK_COPIED_NOTE), `${label}: ${JSON.stringify(seen.notes)}`);
  for (const note of seen.notes) assert.doesNotMatch(note, /retained with the worktree|the worktree is on|uncommitted worktree state/, label);
}
/** What a retire of a directory of the home answers and leaves: done, the home gone, no worktree
 *  step, the class in the receipt, and `work/` in the recovery as `held` had it. */
function assertCopiedAndRemoved(result, home, held, label) {
  assert.equal(result.removedDir, true, label);
  assert.equal(result.retention, null, `${label}: no worktree step`);
  assert.equal(result.worktreeRemoved, false, label);
  assert.ok(result.workRecovery?.classes.includes("directory work bytes"), `${label}: ${JSON.stringify(result.workRecovery?.classes)}`);
  assert.equal(existsSync(home), false, `${label}: the home is removed`);
  assert.deepEqual(entries(join(result.workRecovery.path, "work")), held, `${label}: work/ is in the recovery, byte for byte`);
}

for (const checkout of [false, true]) {
  test(`a real directory at work/ that is not the instance's own tree is copied to recovery and removed with the home, and the plan says so${checkout ? ", in a deployment that is a Git checkout too" : ""} (#962)`, async (t) => {
    const d = deployment(t, { checkout });
    const owner = await d.fx.spawn("dev", { instance: "dev-owner" });
    // The record as it is found beside the directory: the mode that was given the link, no work
    // mode, and `worktree` (a valid receipt says no tree was given: the record does not decide);
    // each with and without a repository. Then the flags that force and discard, which change nothing.
    const cases = [];
    for (const work of ["attached", undefined, "worktree"]) for (const repo of [true, false]) cases.push({ work, repo, flags: [] });
    if (!checkout) for (const flags of [["--force"], ["--discard-worktree"], ["--force", "--discard-worktree"]]) cases.push({ work: "attached", repo: true, flags });
    for (const [i, c] of cases.entries()) {
      const label = `record work ${JSON.stringify(c.work)}, repo ${c.repo ? "recorded" : "not recorded"}${c.flags.length ? `, ${c.flags.join(" ")}` : ""}`;
      const kid = d.attached(owner, `home-${i}`);
      const work = d.realDirectory(kid.home);
      d.record(kid.home, (meta) => { if (c.work === undefined) delete meta.work; else meta.work = c.work; if (!c.repo) delete meta.repo; });
      const seen = d.plan(kid.instance);
      assertPlansHomeDirectory(seen, label);
      // No work tree is observed: not the checkout that encloses the home, when there is one.
      assert.deepEqual(seen.facts.work, NOT_OBSERVED, label);
      assert.equal(seen.facts.workMode, c.work ?? null, label);
      const read = d.instanceGit(kid.instance);
      assert.equal(read.ok, false, label);
      assert.equal(read.error.code, "E_NO_WORKTREE", read.error.message);
      const held = entries(work);
      const result = d.retired(kid.instance, c.flags);
      assertCopiedAndRemoved(result, kid.home, held, label);
      assert.equal(readFileSync(join(result.workRecovery.path, "work", FILE), "utf8"), BYTES, label);
      assert.equal((result.warnings ?? []).some((w) => /registered worktree/.test(w)), false, label);
    }
    // Nothing of the owner's was read as this instance's or touched.
    assert.equal(lstatSync(join(owner.home, "work")).isDirectory(), true);
    assert.equal(d.git(d.fx.member, "worktree", "list", "--porcelain").includes(realpathSync(join(owner.home, "work"))), true);
  });
}

test("a directory of the home that is a repository of its own is copied whole, its .git with it, where a record without a repository once had it removed uncopied (#962)", async (t) => {
  const d = deployment(t);
  const owner = await d.fx.spawn("dev", { instance: "dev-owner" });
  const cases = [];
  for (const work of ["attached", undefined]) for (const repo of [true, false]) cases.push({ work, repo, committed: false, flags: [] });
  cases.push({ work: "attached", repo: false, committed: true, flags: [] });
  for (const flags of [["--discard-worktree"], ["--force"]]) cases.push({ work: "attached", repo: true, committed: false, flags });
  cases.push({ work: "attached", repo: true, committed: true, flags: ["--discard-worktree"] });
  for (const [i, c] of cases.entries()) {
    const label = `record work ${JSON.stringify(c.work)}, repo ${c.repo ? "recorded" : "not recorded"}, the file ${c.committed ? "committed" : "untracked"}${c.flags.length ? `, ${c.flags.join(" ")}` : ""}`;
    const kid = d.attached(owner, `own-${i}`);
    const work = d.realDirectory(kid.home);
    execFileSync("git", ["init", "-q", "-b", "mine", work], { env: d.fx.env });
    if (c.committed) { d.git(work, "add", FILE); d.git(work, "commit", "-qm", "the one file"); }
    d.record(kid.home, (meta) => { if (c.work === undefined) delete meta.work; else meta.work = c.work; if (!c.repo) delete meta.repo; });
    const seen = d.plan(kid.instance);
    assertPlansHomeDirectory(seen, label);
    // The rule is the path: `work/` is the top level of a repository of its own, and is observed.
    assert.equal(seen.facts.work.observed, true, label);
    assert.equal(seen.facts.work.branch, "mine", label);
    assert.equal(seen.facts.work.untracked, c.committed ? 0 : 1, label);
    const read = d.instanceGit(kid.instance);
    assert.equal(read.ok, true, JSON.stringify(read.error));
    assert.equal(read.result.observation.branch, "mine", label);
    const held = entries(work);
    assert.equal(held.get(".git"), "dir", label);
    assert.ok(held.has(join(".git", "HEAD")), label);
    const result = d.retired(kid.instance, c.flags);
    assertCopiedAndRemoved(result, kid.home, held, label);
    // The copy is the repository: Git reads it where it is.
    assert.equal(d.git(join(result.workRecovery.path, "work"), "symbolic-ref", "--short", "HEAD"), "mine", label);
    assert.deepEqual(d.fileAt().filter((p) => !p.includes(".oats-retirement")), [], `${label}: the file is nowhere but in the recovery`);
  }
});

test("a directory of the home that cannot be copied whole refuses before the home is touched, --force included (#962)", async (t) => {
  const d = deployment(t);
  const owner = await d.fx.spawn("dev", { instance: "dev-owner" });
  const kid = d.attached(owner, "fifo");
  const work = d.realDirectory(kid.home);
  execFileSync("mkfifo", [join(work, "pipe")]);
  assertPlansHomeDirectory(d.plan(kid.instance), "the plan");
  for (const flags of [[], ["--force"]]) {
    const error = d.refused(kid.instance, flags, "E_WORK_INSPECTION_FAILED");
    assert.match(error.message, /work\/pipe has an unsupported filesystem type: it is not a file, a directory or a symbolic link, so it cannot be read or copied\. Safely stop the process or resource that owns it, or move the entry elsewhere, before retrying\. Nothing was stopped, run or removed\.$/);
    assert.equal(error.details.reached.phase, "before-effects");
    assert.equal(error.details.reached.home, "kept");
    assert.equal(error.details.reached.recovery, null);
    assert.equal(lstatSync(join(work, "pipe")).isFIFO(), true);
    assert.equal(readFileSync(join(work, FILE), "utf8"), BYTES);
  }
  assert.equal(existsSync(join(dirname(kid.home), ".oats-retirement", "recovery")), false, "no recovery was written");
  // The step by hand: the entry is moved out, and the same retire then ends as any other.
  rmSync(join(work, "pipe"));
  const held = entries(work);
  assertCopiedAndRemoved(d.retired(kid.instance), kid.home, held, "after the entry is removed");
});

test("the record's `directory` is held against the spawn's receipt as before: a home in directory mode, or one that was given a link, whose record says the other is refused (#962)", async (t) => {
  const d = deployment(t);
  const DISAGREES = /directory work mode disagrees with independent retirement authority/;
  // A directory instance whose record no longer says so: its owned bytes are never read as a link's target.
  const dir = await d.fx.spawn("dir", { instance: "dir-flipped" });
  writeFileSync(join(dir.home, "work", FILE), BYTES);
  // (`worktree` too: the receipt says no tree was given, so nothing there is read as one without
  // its admin entry, and the record's `directory` is still held against the receipt.)
  for (const work of ["attached", undefined, "worktree"]) {
    d.record(dir.home, (meta) => { if (work === undefined) delete meta.work; else meta.work = work; });
    for (const flags of [[], ["--force"], ["--discard-worktree"]]) {
      const error = d.refused(dir.instance, flags, "E_WORK_INSPECTION_FAILED");
      assert.match(error.message, DISAGREES, `record work ${JSON.stringify(work)} ${flags.join(" ")}`);
      assert.equal(error.details.reached.phase, "before-effects");
      assert.equal(readFileSync(join(dir.home, "work", FILE), "utf8"), BYTES);
    }
  }
  // A home that was given a link, with a real directory there now, whose record says `directory`.
  const owner = await d.fx.spawn("dev", { instance: "dev-owner" });
  const kid = d.attached(owner, "says-directory");
  const work = d.realDirectory(kid.home);
  d.record(kid.home, (meta) => { meta.work = "directory"; });
  const error = d.refused(kid.instance, [], "E_WORK_INSPECTION_FAILED");
  assert.match(error.message, DISAGREES);
  assert.equal(error.details.reached.phase, "before-effects");
  assert.equal(readFileSync(join(work, FILE), "utf8"), BYTES);
});

/** The record a spawn leaves before its hooks have run (lib/materialize.mjs): no work mode, no
 *  repository, no branch. */
const stub = (meta) => ({ modules: meta.modules, providers: meta.providers, resolutionRevision: meta.resolutionRevision });
/** A whole record that lost those three: what a home with its spawn's receipt can hold and still be
 *  retired (the receipt is held against the record's endpoint, which a stub does not have). */
const withoutWork = (meta) => { delete meta.work; delete meta.repo; delete meta.branch; };

for (const receipt of [true, false]) {
  test(`a record with no work mode and no repository beside the spawn's registered worktree: the tree is retained with what it holds, by the repository Git names for it, ${receipt ? "by the spawn's receipt" : "with no receipt, by what Git confirms"} (#962)`, async (t) => {
    const d = deployment(t);
    const inst = await d.fx.spawn("dev", { instance: "dev-stub" });
    const work = join(inst.home, "work");
    writeFileSync(join(work, FILE), BYTES);
    const branch = d.git(work, "symbolic-ref", "--short", "HEAD");
    d.record(inst.home, receipt ? withoutWork : stub);
    if (!receipt) rmSync(d.baselines(inst.home), { recursive: true });
    const repo = realpathSync(d.fx.member);
    const seen = d.plan(inst.instance);
    assert.deepEqual(seen.defaults, { retainWorktree: true, deleteBranch: false, stopChildren: true, retainChildren: true });
    assert.equal(seen.line, OWN_TREE_LINE);
    assert.equal(seen.facts.workMode, null);
    assert.equal(seen.facts.repo, null);
    assert.equal(seen.facts.work.observed, true);
    assert.equal(seen.facts.work.untracked, 1);
    assert.ok(seen.notes.includes(`the record names no repository for the work tree: the retire uses the one Git names for it, ${repo}, and does not write it into the record`), JSON.stringify(seen.notes));
    assert.ok(seen.notes.includes("0 changed and 1 untracked file(s) would be retained with the worktree"), JSON.stringify(seen.notes));
    // A stub does not say which retire hooks to run: the retire refuses it, and --force is the way
    // through (test/retire-after-interrupted-spawn.test.mjs). What it does with the tree is the same.
    if (!receipt) {
      const error = d.refused(inst.instance, [], "E_UNIDENTIFIED_INSTANCE_HOME");
      assert.equal(error.details.reached.phase, "before-effects");
      assert.equal(readFileSync(join(work, FILE), "utf8"), BYTES);
    }
    const result = d.retired(inst.instance, receipt ? [] : ["--force"]);
    assert.equal(result.removedDir, true);
    assert.equal(result.retention.worktree, "retained");
    assert.equal(result.retention.branch, branch);
    assert.equal(readFileSync(join(result.retention.movedTo, FILE), "utf8"), BYTES, "the file is in the retained tree");
    assert.equal(d.git(d.fx.member, "worktree", "list", "--porcelain").includes(`worktree ${realpathSync(result.retention.movedTo)}\n`), true, "the tree is registered at its new path");
    // (A stub also records no capability hooks, which the retire says as it did.)
    const SAID = `the record names no repository for the work tree at ${work}: the retire used the one Git names for it, ${repo}; the record was not changed`;
    assert.deepEqual(result.warnings.filter((w) => !w.startsWith("this home records no capability hooks")), [SAID]);
    // The record was not written: the home's copy in the recovery is the record as it was.
    assert.deepEqual(readJson(join(result.workRecovery.path, "home", "instance.json")).repo, undefined);
    assert.equal(existsSync(inst.home), false);
  });
}

test("a home with no recorded work mode whose work/ Git confirms is its registered worktree: the plan says it is retained, as the retire does; discarded, what it held is in the recovery (#962)", async (t) => {
  const d = deployment(t);
  for (const [i, flags] of [[], ["--discard-worktree"]].entries()) {
    const inst = await d.fx.spawn("dev", { instance: `dev-nomode-${i}` });
    const work = join(inst.home, "work");
    writeFileSync(join(work, FILE), BYTES);
    d.record(inst.home, (meta) => { delete meta.work; });
    rmSync(d.baselines(inst.home), { recursive: true });
    const seen = d.plan(inst.instance);
    assert.equal(seen.defaults.retainWorktree, true, "true exactly when work/ is the instance's own tree");
    assert.equal(seen.line, OWN_TREE_LINE);
    assert.equal(seen.facts.workMode, null);
    assert.equal(seen.notes.some((n) => /record names no repository/.test(n)), false, "the record names its repository");
    const result = d.retired(inst.instance, flags);
    assert.equal(result.removedDir, true);
    assert.equal(result.warnings, undefined);
    if (!flags.length) {
      assert.equal(result.retention.worktree, "retained");
      assert.equal(readFileSync(join(result.retention.movedTo, FILE), "utf8"), BYTES);
    } else {
      assert.equal(result.retention.worktree, "removed");
      assert.equal(readFileSync(join(result.workRecovery.path, "repo", FILE), "utf8"), BYTES, "what the discarded tree held is in the recovery");
      assert.equal(d.git(d.fx.member, "worktree", "list", "--porcelain").includes(`${realpathSync(dirname(inst.home))}/`), false, "its entry is gone from the repository");
    }
  }
});

test("a registered worktree at work/ under a record that was given a link is a directory of the home: copied and removed with it, its entry left in its repository and said so (#962)", async (t) => {
  const d = deployment(t);
  const inst = await d.fx.spawn("dev", { instance: "dev-registered" });
  const work = join(inst.home, "work");
  writeFileSync(join(work, FILE), BYTES);
  const branch = d.git(work, "symbolic-ref", "--short", "HEAD"), commit = d.git(work, "rev-parse", "HEAD");
  // No receipt, and a record that says `attached`: the record decides, and it says a link was given.
  d.record(inst.home, (meta) => { meta.work = "attached"; });
  rmSync(d.baselines(inst.home), { recursive: true });
  const repo = realpathSync(d.fx.member);
  const prune = `git -C '${repo}' worktree prune`;
  const seen = d.plan(inst.instance);
  assertPlansHomeDirectory(seen, "the plan");
  assert.equal(seen.facts.work.observed, true, "its own top level: observed");
  assert.ok(seen.notes.includes(`work/ is registered as a worktree of ${repo}: the retire leaves its entry there until a prune (${prune}), and does not touch its branch or its commits`), JSON.stringify(seen.notes));
  const held = entries(work);
  assert.match(held.get(".git"), /^file:/, "a linked worktree's .git is a file");
  const result = d.retired(inst.instance);
  assertCopiedAndRemoved(result, inst.home, held, "the retire");
  assert.deepEqual(result.warnings, [`${work} was a registered worktree of ${repo} and not this instance's own tree: it was copied to recovery and removed with the home as a directory of the home. Its entry stays in that repository until a prune (${prune}); its branch and commits are untouched`]);
  // No Git removal: the entry is still there, and so are the branch and its commit.
  assert.equal(d.git(d.fx.member, "worktree", "list", "--porcelain").includes(`worktree ${join(realpathSync(dirname(inst.home)), inst.instance, "work")}\n`), true);
  assert.equal(d.git(d.fx.member, "rev-parse", `refs/heads/${branch}`), commit);
  // The command the warning gives is the step by hand.
  d.git(repo, "worktree", "prune");
  assert.equal(d.git(d.fx.member, "worktree", "list", "--porcelain").includes(inst.instance), false);
  assert.equal(d.git(d.fx.member, "rev-parse", `refs/heads/${branch}`), commit);
});

test("what work/ is is part of the plan's revision: a guarded apply refuses as stale when an own tree became a directory of the home, or the other way round, since the plan was shown (#962)", async (t) => {
  const d = deployment(t);
  const inst = await d.fx.spawn("dev", { instance: "dev-guarded" });
  const work = join(inst.home, "work");
  writeFileSync(join(work, FILE), BYTES);
  // No receipt: the record decides. Nothing but the record's work mode changes below; the
  // registered worktree, its branch, its file and its repository stay as they are.
  rmSync(d.baselines(inst.home), { recursive: true });
  const guarded = (revision, key) => ["--plan-revision", revision, "--idempotency-key", key];
  const stale = (revision, key) => {
    // E_PLAN_STALE says that nothing was done; what is on disk says the same below.
    const error = d.refused(inst.instance, guarded(revision, key), "E_PLAN_STALE");
    assert.equal(readFileSync(join(work, FILE), "utf8"), BYTES, "nothing was copied away or removed");
    assert.equal(d.git(d.fx.member, "worktree", "list", "--porcelain").includes(`worktree ${realpathSync(work)}\n`), true, "the tree is where it was");
    return error.details.plan;
  };
  const retained = d.plan(inst.instance);
  assert.equal(retained.defaults.retainWorktree, true);
  // The own tree becomes a directory of the home: the plan that said "retained" no longer applies.
  d.record(inst.home, (meta) => { meta.work = "attached"; });
  const copied = d.plan(inst.instance);
  assert.equal(copied.defaults.retainWorktree, false);
  assert.ok(copied.notes.includes(HOME_DIRECTORY_NOTE));
  assert.deepEqual({ ...copied.facts.work, upstream: null }, { ...retained.facts.work, upstream: null }, "what Git says of work/ is the same");
  assert.notEqual(copied.planRevision, retained.planRevision);
  assert.equal(stale(retained.planRevision, "shown-as-retained").planRevision, copied.planRevision, "the refusal carries the fresh plan");
  // The other way round: the plan that said "copied and removed" does not apply to an own tree.
  d.record(inst.home, (meta) => { meta.work = "worktree"; });
  assert.equal(d.plan(inst.instance).planRevision, retained.planRevision, "the same home, the same plan");
  stale(copied.planRevision, "shown-as-copied");
  // The plan as it is applies.
  const result = d.retired(inst.instance, guarded(retained.planRevision, "as-it-is"));
  assert.equal(result.retention.worktree, "retained");
  assert.equal(readFileSync(join(result.retention.movedTo, FILE), "utf8"), BYTES);
});

test("an own tree with no repository, recorded or read from Git, is never removed with the home: refused before anything, --force included (#962)", async (t) => {
  const d = deployment(t);
  const inst = await d.fx.spawn("dev", { instance: "dev-norepo" });
  const work = join(inst.home, "work");
  // The spawn's receipt says the instance was given a tree. What is there now is a repository of
  // its own, which Git does not confirm as a registered worktree, under a record with no repository.
  d.git(d.fx.member, "worktree", "remove", "--force", work);
  mkdirSync(work);
  execFileSync("git", ["init", "-q", work], { env: d.fx.env });
  writeFileSync(join(work, FILE), BYTES);
  d.record(inst.home, withoutWork);
  assert.equal(d.plan(inst.instance).defaults.retainWorktree, true, "the instance's own tree, by its receipt");
  for (const flags of [[], ["--force"], ["--discard-worktree"]]) {
    const error = d.refused(inst.instance, flags, "E_WORK_PRESERVATION_FAILED");
    assert.match(error.message, /work is the instance's own work tree, but its record names no repository and Git does not read it as a registered worktree of one, so the retire can neither re-home it nor copy it, and retiring the home would delete it with whatever it holds; move it out or delete it by hand, then retire again; nothing was run or removed$/);
    assert.equal(error.details.reached.phase, "before-effects");
    assert.equal(readFileSync(join(work, FILE), "utf8"), BYTES);
  }
});

test("a real directory at work/ is the instance's work tree only when Git names it as its own top level, in every work mode; a link is read as what it leads to (#962)", async (t) => {
  const d = deployment(t, { checkout: true });
  const noTree = (instance, label) => {
    const read = d.instanceGit(instance);
    assert.equal(read.ok, false, label);
    assert.equal(read.error.code, "E_NO_WORKTREE", read.error.message);
    assert.match(read.error.message, /work is not a git work tree of its own: Git reads it as a directory inside another work tree$/, label);
    assert.deepEqual(d.plan(instance).facts.work, NOT_OBSERVED, label);
  };
  // A directory instance in a deployment that is a checkout: the checkout is not its work.
  const dir = await d.fx.spawn("dir", { instance: "dir-plain" });
  writeFileSync(join(dir.home, "work", FILE), BYTES);
  noTree(dir.instance, "a directory home");
  // Its retire is what it was: its bytes are copied and the home removed.
  const held = entries(join(dir.home, "work"));
  assertCopiedAndRemoved(d.retired(dir.instance), dir.home, held, "a directory home's retire");
  // A directory instance whose work/ is the top level of a repository of its own: observed, as before.
  const own = await d.fx.spawn("dir", { instance: "dir-own" });
  execFileSync("git", ["init", "-q", "-b", "mine", join(own.home, "work")], { env: d.fx.env });
  writeFileSync(join(own.home, "work", FILE), BYTES);
  const ownRead = d.instanceGit(own.instance);
  assert.equal(ownRead.ok, true, JSON.stringify(ownRead.error));
  assert.equal(ownRead.result.workMode, "directory");
  assert.equal(ownRead.result.observation.worktree, join(own.home, "work"));
  assert.equal(ownRead.result.observation.branch, "mine");
  assert.equal(ownRead.result.summary.untracked, 1);
  const ownPlan = d.plan(own.instance);
  assert.equal(ownPlan.facts.work.observed, true);
  assert.equal(ownPlan.facts.work.branch, "mine");
  assert.equal(ownPlan.facts.work.untracked, 1);
  assert.equal(ownPlan.defaults.retainWorktree, false);
  // Its files are observed, and no note says that they would be retained: they are copied to recovery
  // and removed with the home.
  assert.deepEqual(ownPlan.notes.filter((n) => /retained/.test(n)), [], JSON.stringify(ownPlan.notes));
  assert.ok(ownPlan.notes.includes("recovery: work/ is copied there when it is not empty"), JSON.stringify(ownPlan.notes));
  // A workspace instance's work/ is a link to the deployment directory, which is above its home:
  // a link is read as what it leads to, so the deployment's checkout is its work, as before.
  const wsp = await d.fx.spawn("wsp", { instance: "wsp-link" });
  assert.equal(realpathSync(join(wsp.home, "work")), realpathSync(d.fx.dep));
  const wspRead = d.instanceGit(wsp.instance);
  assert.equal(wspRead.ok, true, JSON.stringify(wspRead.error));
  assert.equal(wspRead.result.workMode, "workspace");
  assert.equal(wspRead.result.observation.branch, d.git(d.fx.dep, "symbolic-ref", "--short", "HEAD"));
  assert.equal(d.plan(wsp.instance).facts.work.observed, true);
  // A worktree instance's own tree is its own top level: observed, as before.
  const tree = await d.fx.spawn("dev", { instance: "dev-tree" });
  const treeRead = d.instanceGit(tree.instance);
  assert.equal(treeRead.ok, true, JSON.stringify(treeRead.error));
  assert.equal(treeRead.result.observation.branch, d.git(join(tree.home, "work"), "symbolic-ref", "--short", "HEAD"));
  // The same home with a plain directory where its tree was: not the enclosing checkout's.
  d.git(d.fx.member, "worktree", "remove", "--force", join(tree.home, "work"));
  mkdirSync(join(tree.home, "work"));
  noTree(tree.instance, "a worktree home whose tree is gone");
  // A home that was made a repository: `work/` in it is a directory of that one, not a tree.
  const owner = await d.fx.spawn("dev", { instance: "dev-owner" });
  const kid = d.attached(owner, "in-home-repo");
  d.realDirectory(kid.home);
  execFileSync("git", ["init", "-q", kid.home], { env: d.fx.env });
  noTree(kid.instance, "a home that is a repository");
});

test("the work modes as they were: an own tree is retained, a link goes with the home and what it leads to is not touched, a directory instance's bytes are copied (#962)", async (t) => {
  const d = deployment(t);
  const defaults = (retainWorktree) => ({ retainWorktree, deleteBranch: false, stopChildren: true, retainChildren: true });
  const owner = await d.fx.spawn("dev", { instance: "dev-owner" });
  writeFileSync(join(owner.home, "work", FILE), BYTES);
  // Links: attached, checkout, workspace.
  const kid = d.attached(owner, "kid");
  const chk = await d.fx.spawn("chk", { instance: "chk-a" });
  const wsp = await d.fx.spawn("wsp", { instance: "wsp-a" });
  for (const [inst, mode, target] of [[kid, "attached", join(owner.home, "work")], [chk, "checkout", d.fx.member], [wsp, "workspace", d.fx.dep]]) {
    assert.equal(lstatSync(join(inst.home, "work")).isSymbolicLink(), true, mode);
    const before = mode === "workspace" ? null : entries(target);
    const seen = d.plan(inst.instance);
    assert.deepEqual(seen.defaults, defaults(false), mode);
    assert.equal(seen.facts.workMode, mode);
    assert.equal(seen.notes.includes(HOME_DIRECTORY_NOTE), false, mode);
    const result = d.retired(inst.instance);
    assert.equal(result.removedDir, true, mode);
    assert.equal(result.retention, null, mode);
    assert.equal((result.workRecovery?.classes ?? []).includes("directory work bytes"), false, mode);
    assert.equal(result.warnings, undefined, mode);
    assert.equal(lstatSync(target).isDirectory(), true, `${mode}: what the link led to is there`);
    if (before) assert.deepEqual(entries(target), before, `${mode}: and as it was`);
  }
  // A directory instance.
  const dir = await d.fx.spawn("dir", { instance: "dir-a" });
  writeFileSync(join(dir.home, "work", FILE), BYTES);
  const dirPlan = d.plan(dir.instance);
  assert.deepEqual(dirPlan.defaults, defaults(false));
  assert.equal(dirPlan.notes.includes(HOME_DIRECTORY_NOTE), false);
  assert.deepEqual(dirPlan.facts.work, NOT_OBSERVED);
  const held = entries(join(dir.home, "work"));
  assertCopiedAndRemoved(d.retired(dir.instance), dir.home, held, "a directory instance");
  // The owner, last: its own tree is retained with what it holds.
  const ownerPlan = d.plan(owner.instance);
  assert.deepEqual(ownerPlan.defaults, defaults(true));
  assert.equal(ownerPlan.line, OWN_TREE_LINE);
  const result = d.retired(owner.instance);
  assert.equal(result.retention.worktree, "retained");
  assert.equal(result.warnings, undefined);
  assert.equal(readFileSync(join(result.retention.movedTo, FILE), "utf8"), BYTES);
});
