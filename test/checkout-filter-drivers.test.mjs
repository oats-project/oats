// A checkout OATS makes runs no filter driver that the repository's configuration defines
// (awebai/oats#1799): Git runs a smudge or process filter when it writes a work-tree file that
// carries the `filter` attribute, and whoever works in a clone can write its configuration. The
// checkouts are a spawn's `git worktree add`, and the `git worktree add` and `git switch` of
// `oats worktree add`. The files are written as their committed bytes.
// Nor does one run the file monitor that configuration names (`core.fsmonitor`), which Git asks
// when a checkout refreshes the index of the tree it writes.
// Real Git and real filter commands: each one records that it ran in a marker file.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, FIXTURE_GIT_ENV, cli, fixture, fixtureGit, write } from "./helpers/retire-work-safety-fixture.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const ATTRIBUTES = "tracked.txt filter=smudged\nprocessed.txt filter=proc\n";
/** Two filter commands under `base` that each record that they ran (`ran()` names them). The
 *  smudge one writes other bytes than the committed ones. The process one answers Git's handshake
 *  with Git's own lines: Git then writes the file unfiltered. `config` is what defines them:
 *  { "filter.smudged.smudge": <command>, "filter.proc.process": <command> }. */
function filterCommands(base) {
  const markers = { smudge: join(base, "smudge-filter-ran"), process: join(base, "process-filter-ran") };
  const helpers = { smudge: join(base, "smudge-filter.sh"), process: join(base, "process-filter.sh") };
  write(helpers.smudge, `#!/bin/sh\necho ran >> '${markers.smudge}'\ncat > /dev/null\nprintf 'smudged by the repository\\n'\n`, 0o700);
  write(helpers.process, `#!/bin/sh\necho ran >> '${markers.process}'\nexec cat\n`, 0o700);
  return {
    config: { "filter.smudged.smudge": helpers.smudge, "filter.proc.process": helpers.process },
    ran: () => Object.keys(markers).filter((kind) => existsSync(markers[kind])),
  };
}
/** A worktree-mode deployment whose member repository commits ATTRIBUTES and the two files, and
 *  whose clone's configuration defines the two drivers. */
function spawnFixture() {
  const f = fixture();
  f.commit({ ".gitattributes": ATTRIBUTES, "processed.txt": "stored\n" });
  const filters = filterCommands(f.base);
  for (const [key, value] of Object.entries(filters.config)) fixtureGit(f.repo, ["config", key, value]);
  return { f, filters };
}

test("a spawn into a worktree runs no smudge or process filter the repository's configuration defines, and writes the committed bytes", () => {
  const { f, filters } = spawnFixture();
  const spawned = cli(f, ["spawn", "dev", "--purpose", "filters", "--no-launch", "--json"]);
  assert.equal(spawned.status, 0, spawned.stdout + spawned.stderr);
  assert.deepEqual(filters.ran(), [], "the spawn ran no filter");
  const work = join(JSON.parse(spawned.stdout).result.home, "work");
  assert.equal(readFileSync(join(work, "tracked.txt"), "utf8"), "base\n", "the smudge filter's file holds its committed bytes");
  assert.equal(readFileSync(join(work, "processed.txt"), "utf8"), "stored\n", "the process filter's file holds its committed bytes");
});

test("a spawn into a worktree, for a driver the operator's own configuration also defines: the operator's command writes the file, and the repository's command for that name never runs", () => {
  const { f, filters } = spawnFixture();
  const operatorRan = join(f.base, "operator-filter-ran");
  const operatorFilter = join(f.base, "operator-filter.sh");
  write(operatorFilter, `#!/bin/sh\necho ran >> '${operatorRan}'\ncat > /dev/null\nprintf 'smudged by the operator\\n'\n`, 0o700);
  const globalConfig = join(f.base, "operator-gitconfig");
  write(globalConfig, `[filter "smudged"]\n\tsmudge = ${operatorFilter}\n`);
  const spawned = cli({ ...f, env: { ...f.env, GIT_CONFIG_GLOBAL: globalConfig } }, ["spawn", "dev", "--purpose", "operator", "--no-launch", "--json"]);
  assert.equal(spawned.status, 0, spawned.stdout + spawned.stderr);
  assert.deepEqual(filters.ran(), [], "the repository's commands did not run");
  assert.equal(existsSync(operatorRan), true, "the operator's command for the driver ran");
  assert.equal(readFileSync(join(JSON.parse(spawned.stdout).result.home, "work", "tracked.txt"), "utf8"), "smudged by the operator\n");
});

/** A checkout instance of a member whose remote's main is one commit ahead of the clone: the
 *  clone's commit holds ATTRIBUTES and the two files, the remote's changes both files. So
 *  `oats worktree add --base main` writes each file twice: `git worktree add` at the clone's
 *  commit, then `git switch` at the fetched one. */
async function addFixture(t) {
  const fx = v2Deployment({ souls: { dev: { soul: { work: "checkout" } } }, files: { ".gitattributes": ATTRIBUTES, "tracked.txt": "committed\n", "processed.txt": "stored\n" } });
  t.after(fx.cleanup);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: { ...fx.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const { home } = await fx.spawn("dev", { instance: "dev-filters", work: "checkout" });
  fx.commit({ "tracked.txt": "committed on the remote\n", "processed.txt": "stored on the remote\n" });
  git(fx.member, "reset", "--quiet", "--hard", "HEAD~1");
  const add = () => fx.cli(["worktree", "add", "--purpose", "filters", "--branch", "agents/filters", "--base", "main", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } });
  return { fx, git, add, tree: join(home, ".work-filters") };
}

test("oats worktree add runs no smudge or process filter the repository's configuration defines, in its worktree add or in its switch, and writes the committed bytes", async (t) => {
  const w = await addFixture(t);
  const filters = filterCommands(w.fx.base);
  for (const [key, value] of Object.entries(filters.config)) w.git(w.fx.member, "config", key, value);
  const added = w.add();
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.deepEqual(filters.ran(), [], "the add ran no filter");
  assert.equal(readFileSync(join(w.tree, "tracked.txt"), "utf8"), "committed on the remote\n", "the smudge filter's file holds the bytes committed at the base");
  assert.equal(readFileSync(join(w.tree, "processed.txt"), "utf8"), "stored on the remote\n", "the process filter's file holds the bytes committed at the base");
});

test("oats worktree add in a repository with a filter driver whose name Git's -c cannot carry is refused before Git checks anything out", async (t) => {
  const w = await addFixture(t);
  const ran = join(w.fx.base, "unnameable-filter-ran");
  const helper = join(w.fx.base, "unnameable-filter.sh");
  writeFileSync(helper, `#!/bin/sh\necho ran >> '${ran}'\nexec cat\n`, { mode: 0o700 });
  w.git(w.fx.member, "config", "filter.a=b.smudge", helper);
  writeFileSync(join(w.git(w.fx.member, "rev-parse", "--absolute-git-dir"), "info", "attributes"), "tracked.txt filter=a=b\n");
  const added = w.add();
  assert.notEqual(added.status, 0, added.stdout);
  const error = added.json().error;
  assert.equal(error.code, "E_GIT_FAILED", added.stdout);
  assert.match(error.message, /^git worktree add failed in \S+: the repository's configuration defines a filter driver whose name cannot be overridden.* — the tree was removed$/);
  assert.equal(existsSync(ran), false, "the filter did not run");
  assert.equal(existsSync(w.tree), false, "no tree is left");
  assert.equal(w.git(w.fx.member, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1, "no worktree is left registered");
});

/** A file monitor command under `base` that records each directory Git ran it in (`ranIn()`). */
function fileMonitor(base) {
  const marker = join(base, "file-monitor-ran");
  const command = join(base, "file-monitor.sh");
  write(command, `#!/bin/sh\npwd -P >> '${marker}'\n`, 0o700);
  return { command, ranIn: () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : []) };
}

test("a spawn into a worktree does not run the file monitor the repository's configuration names", () => {
  const f = fixture();
  const monitor = fileMonitor(f.base);
  fixtureGit(f.repo, ["config", "core.fsmonitor", monitor.command]);
  const spawned = cli(f, ["spawn", "dev", "--purpose", "monitor", "--no-launch", "--json"]);
  assert.equal(spawned.status, 0, spawned.stdout + spawned.stderr);
  assert.deepEqual(monitor.ranIn(), [], "the spawn ran no file monitor");
  assert.equal(readFileSync(join(JSON.parse(spawned.stdout).result.home, "work", "tracked.txt"), "utf8"), "base\n");
});

test("oats worktree add does not run the file monitor the repository's configuration names, in its worktree add or in its switch", async (t) => {
  const w = await addFixture(t);
  const monitor = fileMonitor(w.fx.base);
  w.git(w.fx.member, "config", "core.fsmonitor", monitor.command);
  const added = w.add();
  assert.equal(added.status, 0, added.stdout + added.stderr);
  assert.deepEqual(monitor.ranIn(), [], "the add ran no file monitor");
  assert.equal(readFileSync(join(w.tree, "tracked.txt"), "utf8"), "committed on the remote\n");
});

test("oats package remove, which asks Git whether oats-workspace.yaml is tracked in the checkout that holds it, does not run the file monitor that checkout's configuration names", (t) => {
  const base = mkdtempSync(join(tmpdir(), "oats-workspace-checkout-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const checkout = join(base, "workspace");
  fixtureGit(null, ["init", "-q", checkout]);
  write(join(checkout, "oats-workspace.yaml"), "schemaVersion: 2\nname: fixture\n");
  fixtureGit(checkout, ["add", "oats-workspace.yaml"]);
  fixtureGit(checkout, ["commit", "-q", "-m", "workspace"]);
  const monitor = fileMonitor(base);
  fixtureGit(checkout, ["config", "core.fsmonitor", monitor.command]);
  const remove = () => spawnSync(process.execPath, [CLI, "package", "remove", "absent", "--json", "--dir", checkout],
    { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...FIXTURE_GIT_ENV, OATS_HOME_DIR: join(base, "oats-home"), OATS_REMOTE_CACHE: join(base, "cache") } });
  // The file is read as tracked: the refusal is the tracked checkout's, naming the file.
  const tracked = { code: "E_PACKAGE_MISSING", message: `packages.absent is not in ${join(checkout, "oats-workspace.yaml")}`, details: { id: "absent", path: join(checkout, "oats-workspace.yaml") } };
  const refused = remove();
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.deepEqual(JSON.parse(refused.stdout).error, tracked);
  assert.deepEqual(monitor.ranIn(), [], "the command ran no file monitor");

  // The same answer as in a checkout that names no file monitor.
  fixtureGit(checkout, ["config", "--unset", "core.fsmonitor"]);
  assert.deepEqual(JSON.parse(remove().stdout).error, tracked);
});
