import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffInstanceFile, observeInstanceGit } from "../lib/instance-git.mjs";
import { exactTreeDigest, retireInstance, retirementRecoveryRoot } from "../lib/core.mjs";
import { planRetire } from "../lib/instance-lifecycle.mjs";
import { BEFORE_EFFECT_CODES } from "../lib/errors.mjs";
import * as core from "../lib/core.mjs";
import { git, v2Deployment } from "./helpers/v2-deployment.mjs";

function observer(t) {
  const home = mkdtempSync(join(tmpdir(), "oats-git-floor-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const work = join(home, "work");
  mkdirSync(work);
  git(work, "init", "-qb", "main");
  writeFileSync(join(work, "file.txt"), "before\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "initial");
  writeFileSync(join(work, "file.txt"), "after\n");
  writeFileSync(join(home, "instance.json"), JSON.stringify({ instance: "test", work: "worktree" }));
  return { home, work };
}

const unsupported = (found) => (e) => {
  assert.equal(e.code, "E_GIT_UNSUPPORTED");
  assert.equal(e.message.split("; nothing was done")[0], `this repository is a partial clone, and reading it safely needs Git 2.45 or later; this is Git ${found}`);
  assert.deepEqual(e.details, { found, minimum: "2.45", reason: "partial-clone" });
  return true;
};

for (const marker of ["extensions.partialClone", "remote.origin.promisor"]) {
  for (const [version, found] of [["git version 2.44.9", "2.44.9"], ["not a Git version", "an unknown version"]]) {
    test(`partial clone (${marker}) refuses ${version} for observation and diff`, (t) => {
      const f = observer(t);
      const seen = observeInstanceGit(f.home);
      git(f.work, "config", marker, marker.startsWith("remote.") ? "true" : "origin");
      const gitVersion = () => version;
      assert.throws(() => observeInstanceGit(f.home, { gitVersion }), unsupported(found));
      assert.throws(() => diffInstanceFile(f.home, { fileId: seen.files[0].id, revision: seen.observation.revision, gitVersion }), unsupported(found));
    });
  }
}

for (const version of ["git version 2.45.0", "git version 2.54.0 (Apple Git-157)", "git version 3.0.0"]) {
  test(`partial clone is observed at ${version}, with one version probe per call`, (t) => {
    const f = observer(t);
    git(f.work, "config", "remote.other.promisor", "true");
    let calls = 0;
    const gitVersion = () => { calls++; return version; };
    const seen = observeInstanceGit(f.home, { gitVersion });
    assert.equal(calls, 1);
    const patch = diffInstanceFile(f.home, { fileId: seen.files[0].id, revision: seen.observation.revision, gitVersion });
    assert.match(patch.patch, /\+after/);
    assert.equal(calls, 2, "a diff probes once, and does not reuse the observation's probe");
  });
}

test("full clone and a false promisor setting need no version probe", (t) => {
  const f = observer(t);
  git(f.work, "config", "remote.origin.promisor", "false");
  const seen = observeInstanceGit(f.home, { gitVersion: () => assert.fail("full clones never probe the version") });
  assert.equal(seen.files.length, 1);
});

test("included and valueless promisor settings are detected, and the last boolean wins", (t) => {
  const f = observer(t);
  const included = join(f.home, "included-config");
  writeFileSync(included, '[remote "other"]\n\tpromisor\n');
  git(f.work, "config", "include.path", included);
  assert.throws(() => observeInstanceGit(f.home, { gitVersion: () => "git version 2.44.0" }), unsupported("2.44.0"));
  git(f.work, "config", "remote.other.promisor", "false");
  assert.equal(observeInstanceGit(f.home, { gitVersion: () => assert.fail("last value is false") }).files.length, 1);
});

for (const value of ["01", "-01", "1k", "0x1"]) {
  test(`Git's true integer boolean ${value} marks a partial clone`, (t) => {
    const f = observer(t);
    git(f.work, "config", "remote.origin.promisor", value);
    assert.equal(git(f.work, "config", "--bool", "--get", "remote.origin.promisor"), "true");
    assert.throws(() => observeInstanceGit(f.home, { gitVersion: () => "git version 2.44.0" }), unsupported("2.44.0"));
  });
}

test("the recovery copier refuses a partial source before copying anything", (t) => {
  const f = observer(t);
  git(f.work, "config", "extensions.partialClone", "origin");
  const before = exactTreeDigest(f.home);
  assert.throws(() => core.copyRecoveryWork(
    { work: f.work, branchExists: true }, { work: "worktree", repo: f.work, branch: "main" }, join(f.home, "recovery"),
    { gitVersion: () => "git version 2.44.9" },
  ), unsupported("2.44.9"));
  assert.equal(exactTreeDigest(f.home), before);
});

async function retirement(t) {
  // v2Deployment clones its empty local remote once before seeding it. Hold precisely that
  // expected Git warning; every other diagnostic still reaches stderr.
  const stderr = process.stderr.write;
  let emptyCloneWarnings = 0;
  process.stderr.write = function (chunk, ...args) {
    if (String(chunk) === "warning: You appear to have cloned an empty repository.\n") { emptyCloneWarnings++; return true; }
    return stderr.call(this, chunk, ...args);
  };
  let f;
  try { f = v2Deployment({
    souls: { dev: { soul: { work: "worktree", capabilities: { "test.hook": { from: "here" } } }, agents: "# Dev\n" } },
    capabilities: { "test.hook": { manifest: { hooks: { retire: "retire.mjs" } }, files: { "retire.mjs": 'import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(join(process.env.OATS_INSTANCE_HOME, "hook-ran"), "ran\\n");\n' } } },
    files: { "file.txt": "before\n" },
  }); } finally { process.stderr.write = stderr; }
  assert.equal(emptyCloneWarnings, 1, "the fixture's one empty seed clone is expected");
  t.after(() => f.cleanup());
  const spawned = await f.spawn("dev", { purpose: "floor" });
  return { f, spawned, work: join(spawned.home, "work"), recovery: retirementRecoveryRoot(join(spawned.home, "..")) };
}

for (const where of ["work", "source", "nested", "extra"]) {
  test(`retire and its plan refuse an old Git for a partial-clone ${where} before effects`, async (t) => {
    const { f, spawned, work, recovery } = await retirement(t);
    let source = where === "source" ? f.member : work;
    if (where === "nested") {
      source = join(work, "nested");
      mkdirSync(source);
      git(source, "init", "-q");
    }
    if (where === "extra") {
      source = join(spawned.home, ".work-extra");
      git(f.member, "worktree", "add", "--quiet", "--detach", source);
      git(f.member, "config", "extensions.worktreeConfig", "true");
    }
    // The source case gives the copier a repository with no work directory.
    if (where === "source") git(f.member, "worktree", "remove", "--force", work);
    git(source, "config", ...(where === "extra" ? ["--worktree"] : []), "remote.fixture.promisor", "true");
    const snapshot = () => [exactTreeDigest(spawned.home), exactTreeDigest(f.member), existsSync(recovery) ? exactTreeDigest(recovery) : null];
    const before = snapshot();
    const gitVersion = () => "git version 2.44.9";
    await f.inEnv(() => {
      assert.throws(() => planRetire({ root: f.root, dir: f.dep }, f.root, spawned.instance, { gitVersion }), (e) => {
        assert.equal(e.code, "E_GIT_UNSUPPORTED");
        assert.equal(e.details.reason, "partial-clone");
        return true;
      });
      assert.throws(() => retireInstance(f.root, spawned.instance, { discardWorktree: true, gitVersion }), (e) => {
        assert.equal(e.code, "E_GIT_UNSUPPORTED");
        assert.equal(e.details.reason, "partial-clone");
        assert.match(e.message, /nothing was done/i);
        return true;
      });
    });
    assert.deepEqual(snapshot(), before, "home, work, refs, source and recovery bytes all stay unchanged");
    assert.equal(existsSync(recovery), false);
    assert.equal(existsSync(join(spawned.home, "hook-ran")), false);
  });
}

test("full clone retires without probing an old version", async (t) => {
  const { f, spawned } = await retirement(t);
  const result = await f.inEnv(() => retireInstance(f.root, spawned.instance, {
    discardWorktree: true, gitVersion: () => assert.fail("full clones never probe the version"),
  }));
  assert.equal(result.removedDir, true, JSON.stringify(result));
  assert.equal(existsSync(spawned.home), false);
  assert.ok(git(f.member, "rev-parse", `refs/heads/${spawned.branch}`));
});

test("a full-clone worktree whose repository is gone keeps the existing orphan recovery behavior", async (t) => {
  const { f, spawned, work } = await retirement(t);
  rmSync(f.member, { recursive: true });
  const before = exactTreeDigest(work);
  await f.inEnv(() => {
    const gitVersion = () => assert.fail("a missing full clone needs no version probe");
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    const result = retireInstance(f.root, spawned.instance, { gitVersion });
    assert.match(result.rollbackIncomplete.join("\n"), /admin entry is missing/);
    assert.equal(existsSync(spawned.home), true);
    assert.equal(readFileSync(join(spawned.home, "hook-ran"), "utf8"), "ran\n");
    assert.equal(exactTreeDigest(work), before);
  });
});

test("a stale nested gitfile keeps the full clone's existing copier refusal", async (t) => {
  const { f, spawned, work } = await retirement(t);
  const nested = join(work, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, ".git"), `gitdir: ${join(f.base, "gone")}\n`);
  writeFileSync(join(nested, "kept.txt"), "kept\n");
  await f.inEnv(() => {
    const gitVersion = () => assert.fail("full clones never probe the version");
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    assert.throws(() => retireInstance(f.root, spawned.instance, { gitVersion }), (e) => {
      assert.equal(e.code, "E_WORK_PRESERVATION_FAILED");
      return true;
    });
  });
  assert.equal(readFileSync(join(nested, "kept.txt"), "utf8"), "kept\n");
  assert.equal(existsSync(join(spawned.home, "hook-ran")), false);
});

test("the partial-clone refusal is a before-effect code for retire", () => {
  assert.ok(BEFORE_EFFECT_CODES.retire.includes("E_GIT_UNSUPPORTED"));
});
