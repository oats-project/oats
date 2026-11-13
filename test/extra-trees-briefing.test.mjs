// The "Extra trees" briefing. The worktree and checkout work-mode injects share one section that
// tells an agent how to make a tree of its own for another branch or repository. These tests hold
// that section to two things: it is the same text in both injects (and so in every composed
// AGENTS.md of those modes), and its commands do what the prose around them says — run verbatim, as
// the command lines taken from the inject itself (`oats worktree add|remove`, #796), from a real
// instance home of a scratch deployment whose member clone has a bare origin:
//   - the tree starts from the remote's current state even when the clone's remote-tracking refs
//     are stale, and creating it moves none of the clone's refs beyond the new branch;
//   - `add` refuses a branch name that already exists in the clone;
//   - reworking an existing remote branch under `<instance>/<branch>` and pushing with
//     `HEAD:<remote-branch>` changes that one remote branch and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const HEADING = "### Extra trees";
const injectText = (mode) => readFileSync(join(ROOT, "injects", `work-${mode}.md`), "utf8");
const sectionOf = (text) => {
  const at = text.indexOf(HEADING);
  return at < 0 ? null : text.slice(at);
};
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The briefing's commands, read from the inject text rather than retyped here. */
function briefingCommands(mode = "worktree") {
  const section = sectionOf(injectText(mode));
  const create = section.split("\n").filter((line) => line.startsWith("    oats ")).map((line) => line.slice(4));
  const remove = section.match(/`(oats worktree remove [^`]+)`/)?.[1];
  const push = section.match(/`(git push origin HEAD:<remote-branch>)`/)?.[1];
  assert.equal(create.length, 1, "the briefing has one indented create command");
  assert.match(create[0], /^oats worktree add /);
  assert.ok(remove, "the briefing names its remove command");
  assert.ok(push, "the briefing names its push command");
  return { create: create[0], remove, push };
}

const cleanups = [];
test.afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A scratch world: a deployment whose member clone (`clone`) has a bare `upstream` as origin, a seed
 *  repo that pushes to it behind the clone's back, and an instance home (checkout mode, no capability). */
async function world(t, { work = "checkout" } = {}) {
  const fx = v2Deployment({ souls: { dev: { soul: { work } } } });
  cleanups.push(fx.cleanup);
  const hostPath = process.env.PATH; process.env.PATH = fx.env.PATH; t.after(() => { process.env.PATH = hostPath; });
  // A workspace home records the deployment as its repository, as `oats spawn` does (lib/core.mjs).
  const { home } = await fx.spawn("dev", { instance: "inst", work, ...(work === "workspace" ? { repo: fx.dep } : {}) });
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-extra-trees-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...fx.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const git = (...args) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const upstream = fx.repo, clone = fx.member, seed = join(base, "seed");
  git("clone", "-q", upstream, seed);
  let n = 0;
  /** Commit on the seed's current branch and push it to upstream (the clone does not fetch); returns the commit. */
  const seedCommit = (branch) => {
    writeFileSync(join(seed, "file.txt"), `change ${++n}\n`);
    git("-C", seed, "add", "file.txt");
    git("-C", seed, "commit", "-q", "-m", `change ${n}`);
    git("-C", seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    return git("-C", seed, "rev-parse", "HEAD").trim();
  };
  /** Run one briefing line from the home, its placeholders substituted: `oats …` through the real CLI, else /bin/sh. */
  const run = (line, values, cwd = home) => {
    let cmd = line;
    for (const [name, value] of Object.entries(values)) cmd = cmd.replaceAll(`<${name}>`, value);
    assert.doesNotMatch(cmd, /<[a-z-]+>/, `every placeholder is substituted in: ${cmd}`);
    if (cmd.startsWith("oats ")) return fx.cli([...cmd.slice(5).split(/\s+/), "--json"], { cwd, env: { OATS_INSTANCE_HOME: home } });
    return spawnSync("/bin/sh", ["-c", `cd ${shq(cwd)} && ${cmd}`], { env, encoding: "utf8" });
  };
  const ok = (result) => assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const refs = (repo, ...patterns) => git("-C", repo, "for-each-ref", ...patterns);
  return { base, env, git, upstream, seed, clone, home, seedCommit, run, ok, refs, tree: (purpose) => join(home, `.work-${purpose}`) };
}

const lines = (text) => text.split("\n").filter(Boolean);

test("the Extra trees section is byte-identical in the worktree and checkout injects", () => {
  const worktree = sectionOf(injectText("worktree"));
  const checkout = sectionOf(injectText("checkout"));
  assert.ok(worktree, "work-worktree.md has the Extra trees section");
  assert.ok(checkout, "work-checkout.md has the Extra trees section");
  assert.equal(checkout, worktree);
});

test("every composed worktree and checkout golden carries the shared section with its placeholders intact", () => {
  const section = sectionOf(injectText("worktree")).trim();
  const cases = readdirSync(join(ROOT, "test", "golden")).filter((name) => /-(worktree|checkout)-/.test(name));
  assert.ok(cases.some((name) => name.includes("-worktree-")) && cases.some((name) => name.includes("-checkout-")));
  for (const name of cases) {
    const agents = readFileSync(join(ROOT, "test", "golden", name, "AGENTS.md"), "utf8");
    assert.ok(agents.includes(section), `${name}/AGENTS.md contains the Extra trees section verbatim`);
    for (const literal of ["oats worktree add --purpose <purpose> --branch <branch> --base <base>", "oats worktree remove --purpose <purpose>", "git push origin HEAD:<remote-branch>"]) {
      assert.ok(agents.includes(literal), `${name}/AGENTS.md keeps ${literal}`);
    }
  }
});

/** The section's bullets, from its first naming rule to its end: the part every mode shares. */
const sharedBullets = (section) => section.slice(section.indexOf("- Name `<branch>`"));

test("the workspace inject teaches extra trees: the shared bullets, and a create command that always names --repo", () => {
  const shared = sectionOf(injectText("worktree"));
  const workspace = sectionOf(injectText("workspace"));
  assert.ok(workspace, "work-workspace.md has the Extra trees section");
  assert.equal(sharedBullets(workspace), sharedBullets(shared), "the naming, timeout, push and remove rules are the shared ones");
  assert.equal(briefingCommands("workspace").create, `${briefingCommands().create} --repo <repo>`, "the create command is the shared one plus --repo <repo>");
  assert.equal(briefingCommands("workspace").remove, briefingCommands().remove);
  assert.equal(briefingCommands("workspace").push, briefingCommands().push);
  const cases = readdirSync(join(ROOT, "test", "golden")).filter((name) => /-workspace-/.test(name));
  assert.ok(cases.length > 0);
  for (const name of cases) {
    const agents = readFileSync(join(ROOT, "test", "golden", name, "AGENTS.md"), "utf8");
    assert.ok(agents.includes(workspace.trim()), `${name}/AGENTS.md contains the workspace Extra trees section verbatim`);
  }
});

test("the workspace inject keeps member clones read-only and no longer forbids extra trees", () => {
  const text = injectText("workspace");
  const before = text.slice(0, text.indexOf(HEADING));
  assert.match(before, /never edit or\s+commit there, and NEVER change a member clone's Git state/, "the clones stay read-only");
  assert.doesNotMatch(before, /stashes or worktrees/, "worktrees are no longer among the forbidden Git operations");
  assert.match(before, /`git worktree` run by hand/, "only hand-run `git worktree` is, beside the other state changes");
});

test("from a workspace home, the briefing's create command with --repo starts from the remote's tip and moves no clone ref", async (t) => {
  const { create, remove } = briefingCommands("workspace");
  const w = await world(t, { work: "workspace" });
  const tip = w.seedCommit("main");
  assert.notEqual(w.git("-C", w.clone, "rev-parse", "origin/main").trim(), tip, "the clone is stale");
  const refsBefore = w.refs(w.clone, "refs/heads", "refs/remotes");
  const headBefore = w.git("-C", w.clone, "symbolic-ref", "HEAD").trim();
  const values = { purpose: "x", base: "main", branch: "agents/inst-x", repo: w.clone };
  w.ok(w.run(create, values));

  const tree = w.tree("x");
  assert.equal(w.git("-C", tree, "rev-parse", "HEAD").trim(), tip, "the tree is at the upstream tip");
  const after = lines(w.refs(w.clone, "refs/heads", "refs/remotes"));
  const added = after.filter((line) => !lines(refsBefore).includes(line));
  assert.deepEqual(added, [`${tip} commit\trefs/heads/agents/inst-x`], "exactly one new ref: the tree's branch");
  assert.equal(after.filter((line) => !added.includes(line)).join("\n") + "\n", refsBefore, "every other clone ref is byte-identical");
  assert.equal(w.git("-C", w.clone, "symbolic-ref", "HEAD").trim(), headBefore, "the clone's checked-out branch did not switch");
  assert.equal(w.git("-C", w.clone, "status", "--porcelain"), "", "the clone's work tree is untouched");

  w.ok(w.run(remove, values));
  assert.equal(existsSync(tree), false);
});

test("from a workspace home, add without --repo is refused and makes nothing: the home's repository is the deployment", async (t) => {
  const w = await world(t, { work: "workspace" });
  const refused = w.run("oats worktree add --purpose x --branch agents/inst-x --base main", {});
  assert.notEqual(refused.status, 0);
  assert.equal(refused.json().error.code, "E_CLONE_MISSING");
  assert.equal(existsSync(w.tree("x")), false, "nothing was made");
});

test("a fresh extra tree starts from the remote's tip, not the clone's stale origin/main, and moves no clone ref", async (t) => {
  const { create, remove } = briefingCommands();
  const w = await world(t);
  const tip = w.seedCommit("main"); // the clone's origin/main is now stale
  const stale = w.git("-C", w.clone, "rev-parse", "origin/main").trim();
  assert.notEqual(stale, tip);

  const clonesFetchHead = join(w.clone, ".git", "FETCH_HEAD");
  const fetchHeadBefore = existsSync(clonesFetchHead) ? readFileSync(clonesFetchHead) : null;
  const refsBefore = w.refs(w.clone, "refs/heads", "refs/remotes");
  const values = { purpose: "x", base: "main", branch: "agents/inst-x" };
  w.ok(w.run(create, values));

  const tree = w.tree("x");
  assert.equal(w.git("-C", tree, "rev-parse", "HEAD").trim(), tip, "the tree is at the upstream tip");
  assert.equal(w.git("-C", tree, "symbolic-ref", "HEAD").trim(), "refs/heads/agents/inst-x");

  const after = lines(w.refs(w.clone, "refs/heads", "refs/remotes"));
  const added = after.filter((line) => !lines(refsBefore).includes(line));
  assert.deepEqual(added, [`${tip} commit\trefs/heads/agents/inst-x`], "exactly one new ref: the tree's branch");
  assert.equal(after.filter((line) => !added.includes(line)).join("\n") + "\n", refsBefore, "every other clone ref is byte-identical");
  if (fetchHeadBefore === null) assert.equal(existsSync(clonesFetchHead), false, "the clone's own FETCH_HEAD is not written");
  else assert.deepEqual(readFileSync(clonesFetchHead), fetchHeadBefore, "the clone's own FETCH_HEAD is unchanged");

  w.ok(w.run(remove, values));
  const list = w.git("-C", w.clone, "worktree", "list", "--porcelain", "-z");
  assert.equal(list.includes(tree), false, "the clone no longer lists the tree");
  assert.equal(existsSync(tree), false);
});

test("add refuses a branch name that already exists in the clone, and leaves that branch alone", async (t) => {
  const { create } = briefingCommands();
  const w = await world(t);
  w.seedCommit("main");
  w.git("-C", w.clone, "branch", "agents/inst-x", "origin/main");
  const existing = w.git("-C", w.clone, "rev-parse", "refs/heads/agents/inst-x").trim();

  const values = { purpose: "x", base: "main", branch: "agents/inst-x" };
  const refused = w.run(create, values);
  assert.notEqual(refused.status, 0, "add fails on an existing branch name");
  assert.equal(refused.json().error.code, "E_BRANCH_EXISTS", "it fails because the branch exists");
  assert.match(refused.json().error.message, /inst\/agents\/inst-x/, "and names the <instance>/<branch> remedy");
  assert.equal(w.git("-C", w.clone, "rev-parse", "refs/heads/agents/inst-x").trim(), existing, "the existing branch did not move");
  assert.equal(existsSync(w.tree("x")), false, "nothing was made");
});

test("reworking an existing remote branch as <instance>/<branch> and pushing HEAD:<remote-branch> changes only that remote branch", async (t) => {
  const { create, push } = briefingCommands();
  const w = await world(t);
  w.git("-C", w.seed, "switch", "-q", "-c", "feature");
  w.seedCommit("feature");
  w.git("-C", w.clone, "fetch", "-q", "origin");
  w.git("-C", w.clone, "branch", "feature", "origin/feature"); // the name collides with the remote branch
  const featureTip = w.seedCommit("feature"); // and the clone is stale against it

  const cloneBefore = w.refs(w.clone, "refs/heads", "refs/remotes");
  const localFeature = w.git("-C", w.clone, "rev-parse", "refs/heads/feature").trim();
  const values = { purpose: "feature", base: "feature", branch: "inst/feature" };
  w.ok(w.run(create, values));
  const tree = w.tree("feature");
  assert.equal(w.git("-C", tree, "rev-parse", "HEAD").trim(), featureTip);

  writeFileSync(join(tree, "rework.txt"), "rework\n");
  w.git("-C", tree, "add", "rework.txt");
  w.git("-C", tree, "commit", "-q", "-m", "rework");
  const pushed = w.git("-C", tree, "rev-parse", "HEAD").trim();

  const upstreamBefore = w.refs(w.upstream);
  w.ok(w.run(push, { "remote-branch": "feature" }, tree));

  const upstreamOld = lines(upstreamBefore), upstreamNew = lines(w.refs(w.upstream));
  assert.deepEqual(upstreamOld.filter((line) => !upstreamNew.includes(line)), [`${featureTip} commit\trefs/heads/feature`]);
  assert.deepEqual(upstreamNew.filter((line) => !upstreamOld.includes(line)), [`${pushed} commit\trefs/heads/feature`], "upstream changed only refs/heads/feature, to the pushed commit");

  const cloneOld = lines(cloneBefore), cloneNew = lines(w.refs(w.clone, "refs/heads", "refs/remotes"));
  const gone = cloneOld.filter((line) => !cloneNew.includes(line));
  const added = cloneNew.filter((line) => !cloneOld.includes(line));
  assert.deepEqual(added.filter((line) => line.includes("\trefs/heads/")), [`${pushed} commit\trefs/heads/inst/feature`], "the clone's branches gained only inst/feature");
  assert.equal(gone.some((line) => line.includes("\trefs/heads/")), false, "no clone branch moved");
  assert.equal(w.git("-C", w.clone, "rev-parse", "refs/heads/feature").trim(), localFeature, "the clone's local feature is unchanged");
  assert.deepEqual(gone.filter((line) => line.includes("\trefs/remotes/")).map((line) => line.split("\t")[1]), ["refs/remotes/origin/feature"]);
  assert.deepEqual(added.filter((line) => line.includes("\trefs/remotes/")), [`${pushed} commit\trefs/remotes/origin/feature`], "only origin/feature moved, to the pushed commit");
});

test("the instance-boundary block, composed into every instance, defers extra trees to the mode block and no longer says `only there`", () => {
  const boundary = readFileSync(join(ROOT, "injects", "instance-boundary.md"), "utf8");
  const rule = "- **Repository work happens there, or in the extra trees your mode block\n  grants, and nowhere else**: reading, editing, building, testing, git and\n  commits, on repository content. Never from the main checkout or from your\n  home root, beyond what your mode block names.\n";
  assert.ok(boundary.includes(rule), "the boundary rule grants extra trees only through the mode block");
  assert.ok(!boundary.includes("there and only there"), "the old rule, which contradicted the extra-trees paragraph, is gone");
  assert.ok(!/\b(worktree|checkout|attached|workspace|directory)` mode/.test(boundary), "the boundary block names no work mode");
  for (const dir of readdirSync(join(ROOT, "test", "golden"))) {
    const composed = readFileSync(join(ROOT, "test", "golden", dir, "AGENTS.md"), "utf8");
    assert.ok(composed.includes(rule), `${dir}: the composed boundary carries the rule`);
  }
});
