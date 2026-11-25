import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffInstanceFile, observeInstanceGit } from "../lib/instance-git.mjs";
import * as instanceGit from "../lib/instance-git.mjs";
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

async function retirement(t, { retireScript, workMode = "worktree" } = {}) {
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
    souls: { dev: { soul: { work: workMode, capabilities: { "test.hook": { from: "here" } } }, agents: "# Dev\n" } },
    capabilities: { "test.hook": { manifest: { hooks: { retire: "retire.mjs" } }, files: { "retire.mjs": retireScript ?? 'import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(join(process.env.OATS_INSTANCE_HOME, "hook-ran"), "ran\\n");\n' } } },
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

test("an observer keeps E_NO_WORKTREE for a dangling gitfile", (t) => {
  const f = observer(t);
  rmSync(join(f.work, ".git"), { recursive: true });
  writeFileSync(join(f.work, ".git"), `gitdir: ${join(f.home, "gone")}\n`);
  assert.throws(() => observeInstanceGit(f.home, { gitVersion: () => assert.fail("not a repository") }), { code: "E_NO_WORKTREE" });
});

test("a plain work directory inside a partial parent keeps E_NO_WORKTREE", (t) => {
  const f = observer(t);
  rmSync(join(f.work, ".git"), { recursive: true });
  git(f.home, "init", "-q");
  git(f.home, "config", "remote.origin.promisor", "true");
  assert.throws(() => observeInstanceGit(f.home, { gitVersion: () => "git version 2.44.0" }), { code: "E_NO_WORKTREE" });
});

test("an unreadable full-clone directory keeps plan success and the attributed inspection refusal", async (t) => {
  const { f, spawned, work } = await retirement(t);
  const locked = join(work, "locked");
  mkdirSync(join(locked, "in"), { recursive: true });
  f.beforeCleanup(() => { if (existsSync(locked)) chmodSync(locked, 0o700); });
  chmodSync(locked, 0o000);
  await f.inEnv(() => {
    const gitVersion = () => assert.fail("full clones never probe the version");
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    if (process.getuid?.() === 0) {
      assert.equal(retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true }).removedDir, true);
    } else {
      assert.throws(() => retireInstance(f.root, spawned.instance, { gitVersion }), (e) => {
        assert.equal(e.code, "E_WORK_INSPECTION_FAILED");
        assert.match(e.message, /Nothing was stopped, run or removed/);
        return true;
      });
    }
  });
});

function populatedSubmodules(t, work) {
  const leaf = observer(t), middle = observer(t);
  const add = (parent, source, path) => git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, path);
  add(middle.work, leaf.work, "inner");
  git(middle.work, "add", ".");
  git(middle.work, "commit", "-qm", "nested submodule");
  add(work, middle.work, "modules/top");
  git(work, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--quiet");
  git(work, "add", ".");
  git(work, "commit", "-qm", "populated submodules");
  writeFileSync(join(work, "file.txt"), "modified after submodule commit\n");
  return { path: "modules/top/inner", work: join(work, "modules/top", "inner") };
}

test("a partial submodule at depth two refuses old or unknown Git before observation, diff, retire or copying", async (t) => {
  const { f, spawned, work, recovery } = await retirement(t);
  const nested = populatedSubmodules(t, work);
  const seen = observeInstanceGit(spawned.home);
  git(nested.work, "config", "remote.origin.promisor", "true");
  const file = seen.files.find((entry) => entry.path === "file.txt");
  const before = [exactTreeDigest(spawned.home), exactTreeDigest(f.member)];
  for (const [version, found] of [["git version 2.44.9", "2.44.9"], ["unknown", "an unknown version"]]) {
    const gitVersion = () => version;
    const refused = (e) => {
      assert.equal(e.code, "E_GIT_UNSUPPORTED");
      assert.equal(e.details.submodule, nested.path);
      assert.equal(e.details.found, found);
      assert.equal(e.details.minimum, "2.45");
      assert.equal(e.details.reason, "partial-clone");
      assert.equal(e.message.split("; nothing was done")[0], `the submodule ${nested.path} is a partial clone, and reading it safely needs Git 2.45 or later; this is Git ${found}`);
      return true;
    };
    await f.inEnv(() => {
      assert.throws(() => observeInstanceGit(spawned.home, { gitVersion }), refused);
      assert.throws(() => diffInstanceFile(spawned.home, { gitVersion, fileId: file.id, revision: seen.observation.revision }), refused);
      assert.throws(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }), refused);
      assert.throws(() => retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true }), refused);
      assert.throws(() => core.copyRecoveryWork({ work, branchExists: true }, { work: "worktree", repo: f.member, branch: spawned.branch }, join(f.base, "copy"), { gitVersion }), refused);
    });
    assert.deepEqual([exactTreeDigest(spawned.home), exactTreeDigest(f.member)], before);
    assert.equal(existsSync(join(f.base, "copy")), false);
    assert.equal(existsSync(recovery), false);
    assert.equal(existsSync(join(spawned.home, "hook-ran")), false);
  }
  // Depth-two recovery's relative gitfile handling is a separate preservation issue (aweb-adxj).
  // At the floor the shared admission and plan still accept this same tree without a child config read.
  const trace = join(f.base, "admission.trace");
  await f.inEnv(() => {
    const gitVersion = () => "git version 2.45.0";
    const prior = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = trace;
    try {
      const meta = JSON.parse(readFileSync(join(spawned.home, "instance.json"), "utf8"));
      instanceGit.withGitReadSafety(gitVersion, () => core.retireInstanceWork(spawned.home, meta));
    } finally {
      if (prior === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = prior;
    }
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
  });
  const commands = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "start");
  const configReads = commands.filter((event) => event.argv.includes("config") && event.argv.includes("--list"));
  assert.ok(configReads.length > 0, "trace records the real root admission config reads");
  assert.equal(configReads.some((event) => event.argv.some((arg) => arg.startsWith(join(work, "modules", "top")))), false);
});

test("modern Git observes partial submodules without the guard reading any submodule config", (t) => {
  const f = observer(t);
  const nested = populatedSubmodules(t, f.work);
  git(nested.work, "config", "extensions.partialClone", "origin");
  let calls = 0;
  const gitVersion = () => { calls++; return "git version 2.45.0"; };
  assert.equal(observeInstanceGit(f.home, { gitVersion }).files.length, 1);
  assert.equal(calls, 1);
  const trace = join(f.home, "guard.trace");
  // Trace real Git invocations of the shared guard alone; the later status is Git's own reader.
  instanceGit.withGitReadSafety(gitVersion, () => instanceGit.assertSafeGitSubmodules(f.work, {
    configEnv: { PATH: process.env.PATH, HOME: f.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TRACE: trace },
  }));
  const commands = readFileSync(trace, "utf8");
  assert.match(commands, /ls-files --stage -z/);
  assert.doesNotMatch(commands, /config --list/);
  assert.equal(calls, 2, "one probe for each independent call");
});

test("old Git observes full-clone submodules recursively, with a single version probe", (t) => {
  const f = observer(t);
  populatedSubmodules(t, f.work);
  let calls = 0;
  const seen = observeInstanceGit(f.home, { gitVersion: () => { calls++; return "git version 2.44.9"; } });
  assert.equal(seen.files.length, 1);
  assert.equal(calls, 1);
});

test("a retire hook making a submodule partial is refused at the post-hook inspection", async (t) => {
  const { f, spawned, work } = await retirement(t, { retireScript: `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const home = process.env.OATS_INSTANCE_HOME, work = join(home, "work");
const common = execFileSync("git", ["-C", work, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
execFileSync("git", ["-C", work, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", dirname(common), "modules/late"]);
execFileSync("git", ["-C", join(work, "modules", "late"), "config", "remote.origin.promisor", "true"]);
writeFileSync(join(home, "hook-ran"), "ran");
` });
  await f.inEnv(() => {
    assert.throws(() => retireInstance(f.root, spawned.instance, { gitVersion: () => "git version 2.44.9", discardWorktree: true }), (e) => {
      assert.equal(e.code, "E_WORK_INSPECTION_FAILED", e.message);
      assert.equal(e.details.reached.phase, "after-hooks");
      assert.match(e.message, /the submodule modules\/late is a partial clone/);
      return true;
    });
  });
  assert.equal(readFileSync(join(spawned.home, "hook-ran"), "utf8"), "ran");
  assert.equal(existsSync(work), true);
});

test("old Git retires a full worktree when only the main checkout has a populated partial submodule", async (t) => {
  const { f, spawned, work } = await retirement(t);
  const leaf = observer(t);
  git(f.member, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", leaf.work, "vendor/lib");
  git(f.member, "add", ".");
  git(f.member, "commit", "-qm", "main checkout submodule");
  git(work, "merge", "--quiet", "--ff-only", "main");
  git(join(f.member, "vendor", "lib"), "config", "remote.origin.promisor", "true");
  assert.equal(existsSync(join(work, "vendor", "lib", ".git")), false, "the instance's submodule is not populated");
  writeFileSync(join(work, "file.txt"), "authored\n"); // require a copier source read too
  let probes = 0;
  const gitVersion = () => { probes++; return "git version 2.44.9"; };
  await f.inEnv(() => {
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    const result = retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true });
    assert.equal(result.removedDir, true, JSON.stringify(result));
    assert.equal(readFileSync(join(result.workRecovery.path, "repo", "file.txt"), "utf8"), "authored\n");
  });
  assert.equal(probes, 0, "object-only sources do not inspect or probe for their own submodules");
});

test("Git at the floor plans and retires a tree with a populated partial submodule", async (t) => {
  const { f, spawned, work } = await retirement(t);
  const leaf = observer(t);
  git(work, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", leaf.work, "vendor/lib");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one populated submodule");
  git(join(work, "vendor", "lib"), "config", "remote.origin.promisor", "true");
  writeFileSync(join(work, "file.txt"), "authored\n");
  await f.inEnv(() => {
    const gitVersion = () => "git version 2.45.0";
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    const result = retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true });
    assert.equal(result.removedDir, true, JSON.stringify(result));
    assert.equal(readFileSync(join(result.workRecovery.path, "repo", "file.txt"), "utf8"), "authored\n");
  });
});

test("an owned tree without work/.git still suppresses filters and refuses an old partial clone", (t) => {
  const f = observer(t);
  renameSync(join(f.work, ".git"), join(f.home, ".git"));
  git(f.home, "config", "core.worktree", f.work);
  const sentinel = join(f.home, "filter-ran");
  git(f.work, "config", "filter.fixture.clean", `touch '${sentinel}'; cat`);
  writeFileSync(join(f.work, ".gitattributes"), "file.txt filter=fixture\n");
  writeFileSync(join(f.work, "file.txt"), "changed enough to read the working file\n");
  const seen = observeInstanceGit(f.home, { gitVersion: () => assert.fail("full clone never probes") });
  assert.ok(seen.files.some((entry) => entry.path === "file.txt"));
  assert.equal(existsSync(sentinel), false, "the repository's clean filter never ran");
  git(f.work, "config", "remote.origin.promisor", "true");
  assert.throws(() => observeInstanceGit(f.home, { gitVersion: () => "git version 2.44.0" }), unsupported("2.44.0"));
  assert.equal(existsSync(sentinel), false);
});

test("directory-mode work inside a partial enclosing checkout retires without a version probe", async (t) => {
  const { f, spawned, work } = await retirement(t, { workMode: "directory" });
  git(f.base, "init", "-q");
  git(f.base, "config", "remote.origin.promisor", "true");
  writeFileSync(join(work, "authored.txt"), "authored\n");
  let probes = 0;
  await f.inEnv(() => {
    const gitVersion = () => { probes++; return "git version 2.44.9"; };
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    const result = retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true });
    assert.equal(result.removedDir, true, JSON.stringify(result));
  });
  assert.equal(probes, 0, "a directory does not read its enclosing checkout's objects");
});

test("submodule admission refuses a failed real index listing, including output overflow", (t) => {
  const f = observer(t);
  const nested = populatedSubmodules(t, f.work);
  git(nested.work, "config", "remote.origin.promisor", "true");
  for (const version of ["git version 2.44.9", "unknown"]) {
    assert.throws(() => instanceGit.withGitReadSafety(() => version, () =>
      instanceGit.assertSafeGitSubmodules(f.work, { maxBuffer: 1 })), (e) => {
      assert.equal(e.code, "E_GIT_FAILED");
      assert.match(e.message, /could not list populated submodules.*ENOBUFS/s);
      return true;
    });
  }
  assert.doesNotThrow(() => instanceGit.withGitReadSafety(() => "git version 2.45.0", () =>
    instanceGit.assertSafeGitSubmodules(f.work, { maxBuffer: 1 })));
  writeFileSync(join(f.work, ".git", "index"), "invalid index\n");
  assert.throws(() => instanceGit.withGitReadSafety(() => "git version 2.44.9", () =>
    instanceGit.assertSafeGitSubmodules(f.work)), { code: "E_GIT_FAILED" });
});

test("a nested partial source with its work tree elsewhere refuses plan and apply before effects", async (t) => {
  const { f, spawned, work, recovery } = await retirement(t);
  const nested = join(work, "nested"), foreign = join(f.base, "foreign-work");
  mkdirSync(nested);
  mkdirSync(foreign);
  git(nested, "init", "-q");
  writeFileSync(join(nested, "kept.txt"), "kept\n");
  git(nested, "add", ".");
  git(nested, "commit", "-qm", "nested source");
  git(nested, "config", "core.worktree", foreign);
  git(nested, "config", "remote.fixture.promisor", "true");
  const snapshot = () => [exactTreeDigest(spawned.home), exactTreeDigest(f.member), existsSync(recovery) ? exactTreeDigest(recovery) : null];
  const before = snapshot();
  await f.inEnv(() => {
    const gitVersion = () => "git version 2.44.9";
    const refused = (e) => {
      assert.equal(e.code, "E_GIT_UNSUPPORTED");
      assert.equal(e.details.reason, "partial-clone");
      assert.equal(e.details.found, "2.44.9");
      assert.match(e.message, /nothing was done/i);
      return true;
    };
    assert.throws(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }), refused);
    assert.throws(() => retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true }), refused);
  });
  assert.deepEqual(snapshot(), before);
  assert.equal(existsSync(recovery), false);
  assert.equal(existsSync(join(spawned.home, "hook-ran")), false);
});

for (const version of ["git version 2.45.0", "git version 2.44.9", "unknown"]) {
  test(`failed discovery in a full clone probes once and decides safely at ${version}`, (t) => {
    const f = observer(t);
    let probes = 0;
    const gitVersion = () => { probes++; return version; };
    instanceGit.withGitReadSafety(gitVersion, () => instanceGit.assertSafeGitRepository(f.work));
    assert.equal(probes, 0, "a successful empty listing never probes");
    instanceGit.withGitReadSafety(gitVersion, () => {
      for (let call = 0; call < 2; call++) {
        const read = () => instanceGit.assertSafeGitRepository(f.work, { maxBuffer: 1 });
        if (version === "git version 2.45.0") assert.doesNotThrow(read);
        else assert.throws(read, (e) => {
          assert.equal(e.code, "E_GIT_FAILED");
          assert.match(e.message, /could not list populated submodules.*ENOBUFS/s);
          return true;
        });
      }
    });
    assert.equal(probes, 1, "failed discovery shares one probe for the operation");
  });
}

test("a partial submodule in a nested source's foreign tree refuses plan and apply before effects", async (t) => {
  const { f, spawned, work, recovery } = await retirement(t);
  const leaf = observer(t), nested = join(work, "nested"), foreign = join(f.base, "foreign-tree");
  mkdirSync(nested);
  mkdirSync(foreign);
  git(nested, "init", "-q");
  writeFileSync(join(nested, "kept.txt"), "kept\n");
  git(nested, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", leaf.work, "sub");
  git(nested, "add", ".");
  git(nested, "commit", "-qm", "nested with submodule");
  const moduleDir = git(join(nested, "sub"), "rev-parse", "--absolute-git-dir");
  for (const name of ["kept.txt", ".gitmodules", "sub"]) renameSync(join(nested, name), join(foreign, name));
  writeFileSync(join(foreign, "sub", ".git"), `gitdir: ${moduleDir}\n`);
  git(foreign, "--git-dir", moduleDir, "--work-tree", join(foreign, "sub"), "config", "core.worktree", join(foreign, "sub"));
  git(nested, "config", "core.worktree", foreign);
  git(join(foreign, "sub"), "config", "remote.origin.promisor", "true");
  const snapshot = () => [exactTreeDigest(spawned.home), exactTreeDigest(f.member), exactTreeDigest(foreign), existsSync(recovery) ? exactTreeDigest(recovery) : null];
  const before = snapshot();
  await f.inEnv(() => {
    const gitVersion = () => "git version 2.44.9";
    const refused = (e) => {
      assert.equal(e.code, "E_GIT_UNSUPPORTED");
      assert.equal(e.details.submodule, "sub");
      assert.equal(e.details.reason, "partial-clone");
      assert.equal(e.details.found, "2.44.9");
      assert.match(e.message, /the submodule sub is a partial clone/);
      assert.match(e.message, /nothing was done/i);
      return true;
    };
    assert.throws(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }), refused);
    assert.throws(() => retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true }), refused);
    assert.throws(() => core.copyRecoveryWork({ work, branchExists: true }, { work: "worktree", repo: f.member, branch: spawned.branch }, join(f.base, "copy"), { gitVersion }), (e) => {
      assert.equal(e.code, "E_GIT_UNSUPPORTED");
      assert.equal(e.details.submodule, "sub");
      return true;
    });
  });
  assert.deepEqual(snapshot(), before);
  assert.equal(existsSync(join(f.base, "copy")), false);
  assert.equal(existsSync(join(spawned.home, "hook-ran")), false);
});

test("an invalid empty nested .git does not admit a partial enclosing checkout", async (t) => {
  const { f, spawned, work } = await retirement(t, { workMode: "directory" });
  git(f.base, "init", "-q");
  git(f.base, "config", "remote.origin.promisor", "true");
  mkdirSync(join(work, "sub", ".git"), { recursive: true });
  let probes = 0;
  await f.inEnv(() => {
    const gitVersion = () => { probes++; return "git version 2.44.9"; };
    assert.doesNotThrow(() => planRetire(f.dep, f.root, spawned.instance, { gitVersion }));
    assert.equal(retireInstance(f.root, spawned.instance, { gitVersion, discardWorktree: true }).removedDir, true);
  });
  assert.equal(probes, 0);
});
