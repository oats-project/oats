// A retire runs no filter driver that the configuration of the instance's repository defines
// (awebai/oats#1798): an agent working in the worktree can write that configuration, and Git runs
// a clean or process filter during the `git status` the retire asks for, as whoever retires. The
// worktree is read as its bytes are, so a change such a filter would hide is still work to
// preserve. Real Git and real filter commands: each one records that it ran in a marker file.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  cli, commonDirOf, fixture, fixtureGit, hookCapability, hookRan, porcelain, recoveryRootOf, spawn, write,
} from "./helpers/retire-work-safety-fixture.mjs";

/** A retire hook that runs no Git: it records that it ran (hookRan) and reports the retire as done. */
const HOOK = `import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(join(dirname(home), 'hook-saw-' + basename(home)), '{}');
console.log(JSON.stringify({ meta: { retired: true } }));
`;
const MEMBERSHIP = "oats-membership.yaml";
/** Git's status of `work` with the repository's filters run, as an agent's own Git reads it. It
 *  leaves the index as it is (--no-optional-locks): a status that refreshed it would record the
 *  size and times of a file its filter reads as unchanged, and Git would not read that file again. */
const filteredStatus = (work) => fixtureGit(work, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8" });

/** A spawned worktree instance whose agent has configured filter drivers in the repository:
 *  `drivers` is { <name>: "clean" | "process" }, `attributes` the lines of the repository's
 *  info/attributes. Each of the two commands records that it ran (`ran()` names them). The clean
 *  one prints the committed bytes of tracked.txt, so it makes any content of a file read as that
 *  committed content. The process one answers Git's handshake with Git's own lines: Git then
 *  compares the file unfiltered. */
function filtered(purpose, drivers, attributes) {
  const f = fixture({ capabilities: hookCapability(HOOK) });
  const spawned = spawn(f, purpose);
  const work = join(spawned.home, "work");
  const markers = { clean: join(f.base, "clean-filter-ran"), process: join(f.base, "process-filter-ran") };
  const helpers = { clean: join(f.base, "clean-filter.sh"), process: join(f.base, "process-filter.sh") };
  write(helpers.clean, `#!/bin/sh\necho ran >> '${markers.clean}'\nprintf 'base\\n'\n`, 0o700);
  write(helpers.process, `#!/bin/sh\necho ran >> '${markers.process}'\nexec cat\n`, 0o700);
  for (const [name, variable] of Object.entries(drivers)) fixtureGit(work, ["config", `filter.${name}.${variable}`, helpers[variable]]);
  write(join(commonDirOf(work), "info", "attributes"), attributes);
  return {
    f, spawned, work, instance: basename(spawned.home),
    ran: () => Object.keys(markers).filter((kind) => existsSync(markers[kind])),
    forget: () => { for (const marker of Object.values(markers)) rmSync(marker, { force: true }); },
  };
}

test("a clean filter and a process filter the repository's configuration defines do not run in a retire's plan or in the retire, and the files they apply to are preserved as changed", () => {
  const w = filtered("filters", { hide: "clean", proc: "process" }, `tracked.txt filter=hide\n${MEMBERSHIP} filter=proc\n`);
  write(join(w.work, "tracked.txt"), "work\n");
  // The same size as the committed file, so Git must read its content to compare it.
  const membership = readFileSync(join(w.work, MEMBERSHIP), "utf8").replace("schemaVersion", "schemaVersioN");
  assert.notEqual(membership, readFileSync(join(w.work, MEMBERSHIP), "utf8"), "fixture premise: the file is changed");
  write(join(w.work, MEMBERSHIP), membership);
  assert.equal(filteredStatus(w.work), ` M ${MEMBERSHIP}\0`, "fixture premise: with its filters run, Git hides the change to tracked.txt");
  assert.deepEqual(w.ran(), ["clean", "process"], "fixture premise: a status without the overrides runs both filters");
  w.forget();

  const plan = cli(w.f, ["retire", w.instance, "--plan", "--json"]);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.deepEqual(w.ran(), [], "the plan ran no filter");
  const work = JSON.parse(plan.stdout).result.facts.work;
  assert.deepEqual({ observed: work.observed, changed: work.changed, untracked: work.untracked }, { observed: true, changed: 2, untracked: 0 }, "the plan counts both files as changed");

  const retired = cli(w.f, ["retire", w.instance, "--json"]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.deepEqual(w.ran(), [], "the retire ran no filter");
  const receipt = JSON.parse(retired.stdout);
  assert.equal(hookRan(w.spawned.home), true, "the retire hook ran");
  assert.ok(receipt.workRecovery?.classes.includes("tracked or index worktree state"), `the worktree's changes are a class to preserve: ${retired.stdout}`);
  const copy = join(receipt.workRecovery.path, "repo");
  assert.equal(readFileSync(join(copy, "tracked.txt"), "utf8"), "work\n", "the recovery holds the bytes the clean filter would have hidden");
  assert.equal(readFileSync(join(copy, MEMBERSHIP), "utf8"), membership, "the recovery holds the bytes the process filter applies to");
  assert.equal(porcelain(copy), ` M ${MEMBERSHIP}\0 M tracked.txt\0`, "the recovery's own status names both, with no filter configured in it");
  assert.equal(existsSync(w.spawned.home), false, "the instance is retired");
});

test("--discard-worktree: a worktree whose only change a clean filter would hide is not read as clean, and its change is in the recovery before the worktree is removed", () => {
  const w = filtered("hidden", { hide: "clean" }, "tracked.txt filter=hide\n");
  write(join(w.work, "tracked.txt"), "work\n");
  assert.equal(filteredStatus(w.work), "", "fixture premise: with its filter run, Git reads the worktree as clean");
  assert.deepEqual(w.ran(), ["clean"], "fixture premise: a status without the overrides runs the filter");
  w.forget();

  const retired = cli(w.f, ["retire", w.instance, "--discard-worktree", "--json"]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.deepEqual(w.ran(), [], "the retire ran no filter");
  const receipt = JSON.parse(retired.stdout);
  assert.ok(receipt.workRecovery?.path, `a recovery was written: ${retired.stdout}`);
  assert.ok(receipt.workRecovery.classes.includes("tracked or index worktree state"), retired.stdout);
  assert.equal(readFileSync(join(receipt.workRecovery.path, "repo", "tracked.txt"), "utf8"), "work\n", "the recovery holds the changed bytes");
  assert.equal(receipt.retention.worktree, "removed");
  assert.equal(existsSync(w.work), false, "the worktree is gone");
});

test("a filter driver whose name Git's -c cannot carry refuses the retire before its hooks, with --discard-worktree and --force too: no filter runs, and the home and the work are kept", () => {
  const w = filtered("unnameable", { "a=b": "clean" }, "tracked.txt filter=a=b\n");
  write(join(w.work, "tracked.txt"), "work\n");

  const plan = cli(w.f, ["retire", w.instance, "--plan", "--json"]);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).result.facts.work, { observed: false, reason: "E_GIT_FAILED" }, "the plan says the work was not observed, never that it is clean");
  assert.deepEqual(w.ran(), [], "the plan ran no filter");

  for (const flags of [[], ["--discard-worktree"], ["--force"]]) {
    const label = flags[0] ?? "no flag";
    const retired = cli(w.f, ["retire", w.instance, ...flags, "--json"]);
    assert.notEqual(retired.status, 0, `${label}: ${retired.stdout}`);
    const error = JSON.parse(retired.stdout).error;
    assert.equal(error.code, "E_WORK_INSPECTION_FAILED", retired.stdout);
    assert.match(error.message, /^could not inspect instance worktree: git status was not run in \S+\/work: the repository's configuration defines a filter driver whose name cannot be overridden/, label);
    assert.match(error.message, /\. Nothing was stopped, run or removed\.$/, label);
    assert.deepEqual(w.ran(), [], `${label}: no filter ran`);
    assert.equal(hookRan(w.spawned.home), false, `${label}: no retire hook ran`);
    assert.equal(existsSync(recoveryRootOf(w.spawned.home)), false, `${label}: no recovery was written`);
    assert.equal(readFileSync(join(w.work, "tracked.txt"), "utf8"), "work\n", `${label}: the work is kept as it was`);
    assert.equal(existsSync(join(w.spawned.home, "instance.json")), true, `${label}: the home is kept`);
  }
});

test("a spawn into a worktree of a repository with a filter driver whose name Git's -c cannot carry is refused and rolled back: the status its baseline is taken from is not run", () => {
  const f = fixture();
  fixtureGit(f.repo, ["config", "filter.a=b.clean", "cat"]);
  const spawned = cli(f, ["spawn", "dev", "--purpose", "unnameable", "--no-launch", "--json"]);
  assert.notEqual(spawned.status, 0, spawned.stdout);
  const error = JSON.parse(spawned.stdout).error;
  assert.equal(error.code, "E_WORK_INSPECTION_FAILED", spawned.stdout);
  assert.match(error.message, /^could not inspect instance worktree: git status was not run in \S+\/work: the repository's configuration defines a filter driver whose name cannot be overridden.* — spawn rolled back$/);
  assert.equal(existsSync(join(f.root, "dev", "instances", "dev-unnameable")), false, "no home is left");
  assert.equal(fixtureGit(f.repo, ["worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n").filter((line) => line.startsWith("worktree ")).length, 1, "no worktree is left registered");
});

test("a driver the operator's own configuration also defines: the retire succeeds, the operator's command runs, and the repository's command for that name never does", () => {
  const w = filtered("both", { lfs: "clean" }, "tracked.txt filter=lfs\n");
  // The operator's driver of the same name, in the operator's global configuration. It stores a
  // file as it is, so what is committed is what it stores, as with a driver in real use.
  const operatorRan = join(w.f.base, "operator-filter-ran");
  const operatorFilter = join(w.f.base, "operator-filter.sh");
  write(operatorFilter, `#!/bin/sh\npwd -P >> '${operatorRan}'\nexec cat\n`, 0o700);
  const globalConfig = join(w.f.base, "operator-gitconfig");
  write(globalConfig, `[filter "lfs"]\n\tclean = ${operatorFilter}\n`);
  const operator = { ...w.f, env: { ...w.f.env, GIT_CONFIG_GLOBAL: globalConfig } };
  // Rewritten with the bytes it has: its times are no longer the index's, so Git compares content.
  write(join(w.work, "tracked.txt"), readFileSync(join(w.work, "tracked.txt")));
  // Work to preserve, in a file no filter applies to: the retire copies the repository and compares
  // the copy's status with the worktree's.
  write(join(w.work, MEMBERSHIP), readFileSync(join(w.work, MEMBERSHIP), "utf8").replace("schemaVersion", "schemaVersioN"));

  const retired = cli(operator, ["retire", w.instance, "--json"]);
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.deepEqual(w.ran(), [], "the repository's command for the driver did not run");
  assert.equal(existsSync(operatorRan), true, "the operator's command for the driver ran");
  assert.equal(hookRan(w.spawned.home), true, "the retire hook ran");
  const receipt = JSON.parse(retired.stdout);
  assert.ok(receipt.workRecovery?.path, `a recovery was written, its status agreeing with the worktree's: ${retired.stdout}`);
});
