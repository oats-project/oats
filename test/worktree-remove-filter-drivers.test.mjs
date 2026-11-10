// `oats worktree remove` runs no filter driver that the repository's configuration defines
// (awebai/oats#1798): its own status of the tree, the clean check inside `git worktree remove`, and
// the comparison of an unregistered tree's surviving files with the recorded branch all read the
// tree's files as their bytes are. A change such a filter would hide still refuses the removal.
// Real Git and real filter commands: each one records that it ran in a marker file.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

/** A checkout instance with an extra tree `<home>/.work-filters` on agents/filters, and two filter
 *  commands that each record that they ran (`ran()` names them). The clean one prints the committed
 *  bytes of tracked.txt, so it makes any content of a file read as that committed content (the
 *  tests change tracked.txt to bytes of the same size: Git reads a file of another size as changed
 *  without reading it). The
 *  process one answers Git's handshake with Git's own lines: Git then compares the file unfiltered.
 *  `configure({ <name>: "clean" | "process" }, attributes)` defines the drivers in the repository's
 *  configuration and writes its info/attributes. */
async function fixture(t) {
  const fx = v2Deployment({ souls: { dev: { soul: { work: "checkout" } } }, files: { "tracked.txt": "committed\n", "other.txt": "also committed\n" } });
  t.after(fx.cleanup);
  const { home } = await fx.spawn("dev", { instance: "dev-filters", work: "checkout" });
  const cli = (...args) => fx.cli(["worktree", ...args, "--purpose", "filters", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } });
  const added = cli("add", "--branch", "agents/filters", "--base", "main");
  assert.equal(added.status, 0, added.stderr + added.stdout);
  const tree = join(home, ".work-filters");
  const record = join(home, ".oats", "trees", "filters.json");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: { ...fx.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const registered = () => git(fx.member, "worktree", "list", "--porcelain").split("\n").includes(`worktree ${tree}`);
  const gitdir = git(tree, "rev-parse", "--absolute-git-dir");
  const markers = { clean: join(fx.base, "clean-filter-ran"), process: join(fx.base, "process-filter-ran") };
  const helpers = { clean: join(fx.base, "clean-filter.sh"), process: join(fx.base, "process-filter.sh") };
  writeFileSync(helpers.clean, `#!/bin/sh\necho ran >> '${markers.clean}'\nprintf 'committed\\n'\n`, { mode: 0o700 });
  writeFileSync(helpers.process, `#!/bin/sh\necho ran >> '${markers.process}'\nexec cat\n`, { mode: 0o700 });
  const configure = (drivers, attributes) => {
    for (const [name, variable] of Object.entries(drivers)) git(tree, "config", `filter.${name}.${variable}`, helpers[variable]);
    writeFileSync(join(git(fx.member, "rev-parse", "--absolute-git-dir"), "info", "attributes"), attributes);
  };
  /** The tree as Git leaves it when its admin entry is gone: unregistered, its `.git` file dangling. */
  const orphan = () => { rmSync(gitdir, { recursive: true }); assert.equal(registered(), false); };
  /** Git's status of the tree with the filters run, the index left as it is. */
  const filteredStatus = () => git(tree, "--no-optional-locks", "status", "--porcelain");
  return { fx, tree, record, cli, git, registered, configure, orphan, filteredStatus, ran: () => Object.keys(markers).filter((kind) => existsSync(markers[kind])), forget: () => { for (const marker of Object.values(markers)) rmSync(marker, { force: true }); } };
}
const refusal = (result) => { assert.notEqual(result.status, 0, result.stdout); return result.json().error; };

test("remove of a registered tree runs no clean or process filter, and a change the clean filter would hide refuses the removal", async (t) => {
  const w = await fixture(t);
  w.configure({ hide: "clean", proc: "process" }, "tracked.txt filter=hide\nother.txt filter=proc\n");
  writeFileSync(join(w.tree, "tracked.txt"), "COMMITTED\n");
  // The process filter's file: its times differ from the index's, so Git reads its content.
  utimesSync(join(w.tree, "other.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.equal(w.filteredStatus(), "", "fixture premise: with its filters run, Git reads the tree as clean, and `git worktree remove` would remove it");
  assert.deepEqual(w.ran(), ["clean", "process"], "fixture premise: a status without the overrides runs both filters");
  w.forget();

  const error = refusal(w.cli("remove"));
  assert.equal(error.code, "E_WORKTREE_DIRTY", JSON.stringify(error));
  assert.deepEqual(w.ran(), [], "no filter ran");
  assert.equal(readFileSync(join(w.tree, "tracked.txt"), "utf8"), "COMMITTED\n", "the changed file is kept");
  assert.ok(w.registered(), "the tree is still registered");
  assert.ok(existsSync(w.record), "the record is kept");
});

test("remove of a registered tree whose files are as committed removes it without running the filter that applies to them", async (t) => {
  const w = await fixture(t);
  w.configure({ hide: "clean", proc: "process" }, "tracked.txt filter=hide\nother.txt filter=proc\n");
  for (const file of ["tracked.txt", "other.txt"]) utimesSync(join(w.tree, file), new Date(2020, 0, 1), new Date(2020, 0, 1));

  const result = w.cli("remove");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(w.ran(), [], "no filter ran");
  assert.equal(existsSync(w.tree), false);
  assert.equal(existsSync(w.record), false);
  assert.equal(w.registered(), false);
});

test("remove of an unregistered tree compares its surviving files without running a filter, and a change the clean filter would hide refuses the removal", async (t) => {
  const w = await fixture(t);
  w.configure({ hide: "clean", proc: "process" }, "tracked.txt filter=hide\nother.txt filter=proc\n");
  w.orphan();
  writeFileSync(join(w.tree, "tracked.txt"), "COMMITTED\n");

  const error = refusal(w.cli("remove"));
  assert.equal(error.code, "E_WORKTREE_DIRTY", JSON.stringify(error));
  assert.ok(error.message.includes("tracked.txt"), error.message);
  assert.equal(error.message.includes("other.txt"), false, `a file that is as committed is not listed: ${error.message}`);
  assert.deepEqual(w.ran(), [], "no filter ran");
  assert.equal(readFileSync(join(w.tree, "tracked.txt"), "utf8"), "COMMITTED\n", "the changed file is kept");
  assert.ok(existsSync(w.record), "the record is kept");
});

for (const [state, prepare] of [["registered", () => {}], ["unregistered", (w) => w.orphan()]]) {
  test(`remove refuses when a filter driver's name cannot be carried by Git's -c (${state} tree): no filter runs, nothing is removed and the record is kept`, async (t) => {
    const w = await fixture(t);
    w.configure({ "a=b": "clean" }, "tracked.txt filter=a=b\n");
    prepare(w);
    writeFileSync(join(w.tree, "tracked.txt"), "COMMITTED\n");

    const error = refusal(w.cli("remove"));
    assert.equal(error.code, "E_WORK_PRESERVATION_FAILED", JSON.stringify(error));
    assert.match(error.message, /filter driver whose name cannot be overridden/);
    assert.match(error.message, /no files were removed by this command \(the record is kept\)$/);
    assert.deepEqual(w.ran(), [], "no filter ran");
    assert.equal(readFileSync(join(w.tree, "tracked.txt"), "utf8"), "COMMITTED\n", "the tree is kept as it was");
    assert.equal(w.registered(), state === "registered");
    assert.ok(existsSync(w.record), "the record is kept");
  });
}
