import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findAgent, fingerprintTree, listInstances, RETIRE_DELETE_BRANCH_REFUSED, retireInstance, spawnInstanceAsync, startInstanceSession } from "../lib/core.mjs";
import { expectLoginFallback, leaveEnclosingInstance } from "./helpers/host-fixture.mjs";
import { git, v2Deployment } from "./helpers/v2-deployment.mjs";

const CLI = realpathSync(new URL("../bin/oats.mjs", import.meta.url));
const HOST_PATH = process.env.PATH;
const GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
function write(file, body) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); }
/** A workspace deployment whose `worker` soul (work: directory) activates the
 *  member capability example.worker. The deployment directory is the directory
 *  execution context; it is not a Git checkout unless `git` asks for one.
 *  f.cap is the capability in the member clone: edits there are committed
 *  before the next spawn, exactly as a member change would be. */
function fixture(t, { git: gitContext = false, hook = false } = {}) {
  const manifest = { description: "Provider-neutral execution fixture.", skills: ["skills"], inject: "inject.md", ...(hook ? { hooks: { spawn: "spawn.mjs", retire: "retire.mjs" } } : {}) };
  const files = {
    "skills/worker-skill/SKILL.md": "---\nname: worker-skill\ndescription: Generic worker fixture.\n---\n# Worker skill\n",
    "inject.md": "## Generic worker capability\n",
    ...(hook ? {
      "spawn.mjs": `import { writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync(e.OATS_INSTANCE_HOME + '/work/from-hook.txt', 'spawn bytes');
console.log(JSON.stringify({meta: {context: e.OATS_CONTEXT, repo: e.OATS_REPO, root: e.OATS_ROOT, work: e.OATS_WORK, branch: e.OATS_BRANCH, cli: e.OATS_CLI_BIN}}));\n`,
      "retire.mjs": `console.log(JSON.stringify({meta: {retired: true}}));\n`,
    } : {}),
  };
  const fx = v2Deployment({
    souls: { worker: { soul: { work: "directory", capabilities: { "example.worker": { from: "here" } } }, agents: "# Generic worker\n" } },
    capabilities: { "example.worker": { manifest, files } },
  });
  const saved = { ...process.env };
  // A worker inside an instance home (a developer agent running the suite from its work tree) is
  // that instance to the kernel, and a launch then reads its recorded server's environment instead
  // of the one built below: the fixture leaves it.
  const comeBack = leaveEnclosingInstance(fx.base);
  t.after(() => {
    comeBack();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fx.cleanup();
  });
  const base = fx.base, context = fx.dep, root = fx.root;
  // No host identity, credentials, config, harness or scheduler can leak into a
  // no-launch probe. Harnesses are inert executables for preflight only; Git is
  // on PATH (its own directory) because the workspace is read over Git.
  for (const key of Object.keys(process.env)) delete process.env[key];
  const bin = join(base, "bin"), gitBin = join(base, "git-bin");
  // The fixture's TMUX_TMPDIR is part of it: a tmux client the kernel starts, here or in a CLI child,
  // looks for the fixture's server, never at tmux's default place, where a host's live server is.
  Object.assign(process.env, { HOME: fx.env.HOME, OATS_HOME_DIR: fx.env.OATS_HOME_DIR, OATS_REMOTE_CACHE: fx.env.OATS_REMOTE_CACHE, OATS_TMUX_SESSION: fx.env.OATS_TMUX_SESSION,
    TMUX_TMPDIR: fx.env.TMUX_TMPDIR, PATH: `${bin}:${gitBin}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(base, "gitconfig") });
  write(process.env.GIT_CONFIG_GLOBAL, "");
  mkdirSync(bin); mkdirSync(gitBin);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(GIT, join(gitBin, "git"));
  for (const name of ["pi", "claude", "codex"]) {
    write(join(bin, name), `#!/bin/sh\necho unexpected-harness-launch >&2\nexit 99\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // The deployment's own event directory exists before any listing is taken.
  mkdirSync(join(context, ".agents"), { recursive: true });
  if (gitContext) {
    process.env.PATH += `:${HOST_PATH}`;
    execFileSync("git", ["init", "-q", context]);
    execFileSync("git", ["-C", context, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "baseline"]);
  }
  const cap = join(fx.member, "capabilities", "example.worker");
  const commitMember = () => {
    if (!git(fx.member, "status", "--porcelain")) return;
    git(fx.member, "add", "-A"); git(fx.member, "commit", "-qm", "fixture edit"); git(fx.member, "push", "-q", "origin", "HEAD:main");
  };
  const prepare = async () => { commitMember(); return fx.prepare("worker"); };
  const agent = () => findAgent(root, "worker");
  /** The kernel spawn exactly as `oats spawn` drives it: a prepared resolution,
   *  the deployment as the directory context; `options` override everything. */
  /** How many times the kernel said, during the last `spawn`, that it could not read the login environment. */
  let loginFallbacks = 0;
  const spawn = async (purpose, options = {}, pre) => {
    const { prepared, agent: soul } = pre || await prepare();
    // A launch plans the start of the OATS tmux server from this fixture's environment, whose HOME is
    // not the user's and which names no login shell: the kernel says, once, that it could not read
    // the login environment. That line is asserted here, never left in the output (host-fixture.mjs
    // expectLoginFallback): once for a spawn that launches, never for one that does not. A spawn
    // that throws gives its own error, and the test that expects the refusal asserts the count
    // (`loginFallbacks`).
    const warning = expectLoginFallback({ reason: "not-home" });
    let result;
    try { result = await spawnInstanceAsync(root, soul, { purpose, launch: false, repo: context, ...options, prepared }); }
    catch (e) { loginFallbacks = warning.end({ assert: false }); throw e; }
    loginFallbacks = warning.end();
    assert.equal(loginFallbacks, options.launch === true ? 1 : 0, "the kernel says that it could not read the login environment once where it plans a launch, and nowhere else");
    return result;
  };
  /** Change the soul's work mode in its member repository. */
  const setWork = (work) => {
    const file = join(fx.member, "souls", "worker", "soul.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^work: .*$/m, `work: ${work}`));
    commitMember();
  };
  return { fx, base, context, root, cap, agent, spawn, prepare, setWork, loginFallbacks: () => loginFallbacks };
}
function cli(f, args, cwd = f.context) {
  return spawnSync(process.execPath, [CLI, ...args, "--dir", f.context, "--json"], { cwd, env: process.env, encoding: "utf8" });
}
function cliSpawn(f, args = [], cwd) {
  const result = cli(f, ["spawn", "worker", "--purpose", "cli", "--no-launch", ...args], cwd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.result;
}
function readJson(file) { return JSON.parse(readFileSync(file, "utf8")); }
/** A failed spawn writes no instance record. On the workspace model the home may
 *  hold materialize's module record (instance.json with modules/providers only,
 *  written before the hooks that read it), never the spawn's own fields. */
function noSpawnRecord(home) {
  const file = join(home, "instance.json");
  if (!existsSync(file)) return true;
  const meta = readJson(file);
  return meta.instance === undefined && meta.launched === undefined && meta.agent === undefined;
}

test("actual core spawn: directory mode has no Git work tree, canonical composition and launch metadata", async (t) => {
  const f = fixture(t, { hook: true });
  const result = await f.spawn("core", { harness: "claude" });
  assert.equal(result.work, "directory");
  assert.equal(result.repo, f.context);
  assert.equal(result.branch, undefined);
  assert.equal(result.launched, false);
  assert.equal(result.launch.harness, "claude");
  assert.equal(result.capabilityRuntime[0].trust.trusted, true);
  assert.equal(lstatSync(join(result.home, "work")).isDirectory(), true);
  assert.equal(lstatSync(join(result.home, "work")).isSymbolicLink(), false);
  assert.equal(existsSync(join(result.home, "work", ".git")), false);
  assert.equal(readlinkSync(join(result.home, "CLAUDE.md")), "AGENTS.md");
  assert.equal(readlinkSync(join(result.home, ".claude", "skills")), "../.agents/skills");
  assert.ok(existsSync(join(result.home, ".agents", "skills", "worker-skill", "SKILL.md")), "the module skill is materialized, flat");
  assert.match(readFileSync(join(result.home, "AGENTS.md"), "utf8"), /Work mode: directory/);
  assert.match(readFileSync(join(result.home, "TASK.md"), "utf8"), /configuration only/);
  assert.deepEqual(result.capabilityMeta["example.worker"], { context: f.context, repo: f.context, root: f.root, work: "directory", branch: "", cli: CLI });
  assert.equal(listInstances(f.root)[0].instances[0].instance, result.instance);
  const retired = retireInstance(f.root, result.instance);
  assert.equal(retired.worktreeRemoved, false);
  assert.equal(retired.branchDeleted, false);
  assert.equal(readFileSync(join(retired.workRecovery.path, "work", "from-hook.txt"), "utf8"), "spawn bytes");
});

test("explicit CLI directory override works; ambient source context and workDir are never adopted", async (t) => {
  const f = fixture(t);
  f.setWork("checkout");
  const source = join(f.base, "source"); write(join(source, "sentinel.txt"), "source");
  const result = cliSpawn(f, ["--work", "directory"], source);
  const meta = readJson(join(result.home, "instance.json"));
  assert.equal(meta.repo, f.context);
  assert.equal(meta.work, "directory");
  assert.deepEqual(readdirSync(join(result.home, "work")), []);
  retireInstance(f.root, result.instance);
  assert.equal(readFileSync(join(source, "sentinel.txt"), "utf8"), "source");
});

test("directory repo selector resolves a non-Git relative path; capabilities stay the soul's resolution, never the work context's", async (t) => {
  const f = fixture(t);
  const external = join(f.base, "other-context"); write(join(external, "sentinel.txt"), "not owned");
  const result = await f.spawn("context", { repo: "../other-context" });
  assert.equal(result.repo, external);
  assert.deepEqual(readdirSync(join(result.home, "work")), []);
  assert.ok(existsSync(join(result.home, ".agents", "skills", "worker-skill", "SKILL.md")), "capabilities come from the soul's resolution, not from the selected context");
  // Asking for a branch deletion is refused before anything happens; the retire touches nothing of the context.
  assert.throws(() => retireInstance(f.root, result.instance, { deleteBranch: true }), (e) => e.code === "E_BAD_ARGS" && e.message === RETIRE_DELETE_BRANCH_REFUSED);
  assert.equal(existsSync(result.home), true);
  retireInstance(f.root, result.instance);
  assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "not owned");
});

test("core rejects contradictory, poisoned or escaping options before creating homes", async (t) => {
  const f = fixture(t);
  const outside = join(f.base, "outside"); write(join(outside, "sentinel"), "keep");
  for (const options of [
    ...[outside, "../../outside", "", true, false, "--branch", "/tmp/x\0y"].map((workDir) => ({ workDir })),
    ...["main", "../../outside", "", true, false, "--worktree"].map((branch) => ({ branch })),
    ...[null, true, false, "", "missing", "bad\0path", join(outside, "sentinel")].map((repo) => ({ repo })),
  ]) {
    await assert.rejects(f.spawn("invalid", options), (e) => e.code === "E_BAD_ARGS", JSON.stringify(options));
    assert.equal(existsSync(join(f.root, "worker", "instances", "worker-invalid")), false);
  }
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
});

test("CLI rejects directory branch/work-dir combinations and missing values as E_BAD_ARGS", async (t) => {
  const f = fixture(t);
  const outside = join(f.base, "outside"); write(join(outside, "sentinel"), "keep");
  for (const args of [["--branch", "main"], ["--work-dir", outside], ["--work-dir", "../../outside"], ["--work-dir"], ["--branch"], ["--repo"], ["--work", "directory", "--branch", "main"]]) {
    const result = cli(f, ["spawn", "worker", "--purpose", "invalid", "--no-launch", ...args]);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(JSON.parse(result.stdout).error.code, "E_BAD_ARGS", result.stdout + result.stderr);
    assert.equal(existsSync(join(f.root, "worker", "instances", "worker-invalid")), false);
  }
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep");
});

test("directory spawn rejects symlink escapes in home placement", async (t) => {
  const f = fixture(t);
  const outside = join(f.base, "outside"); mkdirSync(outside);
  const pre = await f.prepare(); // fetches the soul under agents/worker/
  symlinkSync(outside, join(f.root, "worker", "instances"));
  await assert.rejects(f.spawn("escape", {}, pre), (e) => e.code === "E_NO_CANONICAL_ROOT");
  assert.deepEqual(readdirSync(outside), []);
});

test("ordinary directory work, hidden files, empty directories, executable bits and links survive verified recovery", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("recover");
  const work = join(result.home, "work");
  write(join(work, "authored.txt"), "precious\n");
  write(join(work, ".hidden"), "hidden\n");
  write(join(work, "run"), "#!/bin/sh\nexit 0\n"); chmodSync(join(work, "run"), 0o755);
  mkdirSync(join(work, "empty"));
  const external = join(f.base, "external"); write(external, "external");
  symlinkSync(external, join(work, "link")); symlinkSync("missing", join(work, "dangling"));
  write(join(result.home, "notes.txt"), "home notes\n");
  const retired = retireInstance(f.root, result.instance);
  assert.equal(existsSync(result.home), false);
  assert.ok(retired.workRecovery.classes.includes("directory work bytes"));
  const recovered = join(retired.workRecovery.path, "work");
  assert.equal(readFileSync(join(recovered, "authored.txt"), "utf8"), "precious\n");
  assert.equal(readFileSync(join(recovered, ".hidden"), "utf8"), "hidden\n");
  assert.equal(lstatSync(join(recovered, "run")).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(recovered, "empty")).isDirectory(), true);
  assert.equal(readlinkSync(join(recovered, "link")), external);
  assert.equal(readlinkSync(join(recovered, "dangling")), "missing");
  assert.equal(readFileSync(join(retired.workRecovery.path, "home", "notes.txt"), "utf8"), "home notes\n");
  assert.equal(readFileSync(external, "utf8"), "external");
});

test("post-retire-hook changes with unchanged filenames get a second verified directory snapshot, under after-hooks/ of the one recovery", async (t) => {
  const f = fixture(t, { hook: true });
  write(join(f.cap, "retire.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/from-hook.txt', 'retire bytes');
console.log(JSON.stringify({meta: {retired: true}}));\n`);
  const result = await f.spawn("post-hook");
  const retired = retireInstance(f.root, result.instance);
  assert.equal(Object.hasOwn(retired, "workRecoveries"), false, "one recovery: workRecoveries is no longer emitted");
  const recovery = retired.workRecovery.path;
  assert.deepEqual(readdirSync(dirname(recovery)), [basename(recovery)], "one recovery directory");
  assert.equal(readFileSync(join(recovery, "work", "from-hook.txt"), "utf8"), "spawn bytes");
  assert.equal(readFileSync(join(recovery, "after-hooks", "work", "from-hook.txt"), "utf8"), "retire bytes");
  // Only the part the hook moved is copied again.
  assert.deepEqual(retired.workRecovery.afterHooks, { home: false, work: true });
  assert.deepEqual(readdirSync(join(recovery, "after-hooks")), ["work"]);
  assert.deepEqual(readJson(join(recovery, "recovery.json")).afterHooks, { home: false, work: true });
  assert.equal(readJson(join(recovery, "recovery.json")).phase, "complete");
});

test("a clean directory instance whose retire hook creates work gets its one recovery after the hooks, before the home is removed", async (t) => {
  const f = fixture(t, { hook: true });
  write(join(f.cap, "spawn.mjs"), `console.log(JSON.stringify({meta: {configured: true}}));\n`);
  write(join(f.cap, "retire.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/from-retire.txt', 'retire bytes');
console.log(JSON.stringify({meta: {retired: true}}));\n`);
  const result = await f.spawn("late-work");
  assert.deepEqual(readdirSync(join(result.home, "work")), [], "fixture premise: nothing to preserve before the hooks");
  const retired = retireInstance(f.root, result.instance);
  const recovery = retired.workRecovery.path;
  assert.deepEqual(readdirSync(dirname(recovery)), [basename(recovery)]);
  assert.equal(readFileSync(join(recovery, "work", "from-retire.txt"), "utf8"), "retire bytes");
  assert.equal(existsSync(join(recovery, "after-hooks")), false, "written by the post-hook pass as the first and only snapshot");
  assert.equal(retired.workRecovery.afterHooks, undefined);
  assert.equal(readJson(join(recovery, "recovery.json")).phase, "complete");
  assert.equal(existsSync(result.home), false);
});

test("a failed second phase keeps the home and the untouched pre-hook snapshot at before-hooks; a retry starts over in its own recovery", async (t) => {
  const f = fixture(t, { hook: true });
  const manifest = readJson(join(f.cap, "oats.json"));
  manifest.retirement = { disposable: { home: [".ident"] } };
  write(join(f.cap, "oats.json"), JSON.stringify(manifest));
  write(join(f.cap, "spawn.mjs"), `import { mkdirSync, writeFileSync } from 'node:fs';
const home = process.env.OATS_INSTANCE_HOME;
mkdirSync(home + '/.ident');
writeFileSync(home + '/.ident/signing.key', 'directory-ident-key');
writeFileSync(home + '/work/from-hook.txt', 'spawn bytes');
console.log(JSON.stringify({meta: {minted: true}}));\n`);
  // The retire hook changes the home (an undeclared file), so the post-hook pass has a part to add. While
  // <context>/misbehave exists it also occupies the name that part needs, inside the recovery it finds beside the home.
  write(join(f.cap, "retire.mjs"), `import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(join(home, 'hook-note.txt'), 'written by the retire hook');
if (existsSync(join(process.env.OATS_CONTEXT, 'misbehave'))) {
  const root = join(dirname(home), '.oats-retirement', 'recovery');
  for (const name of readdirSync(root)) writeFileSync(join(root, name, 'after-hooks'), 'in the way');
}
console.log(JSON.stringify({meta: {retired: true}}));\n`);
  write(join(f.context, "misbehave"), "1");
  const result = await f.spawn("second-phase");
  const root = join(dirname(result.home), ".oats-retirement", "recovery");
  const preHookHome = fingerprintTree(result.home, { excludeRoot: new Set(["work", ".ident"]), instanceHome: true });
  const preHookWork = fingerprintTree(join(result.home, "work"));

  assert.throws(() => retireInstance(f.root, result.instance), (e) => {
    assert.equal(e.code, "E_WORK_PRESERVATION_FAILED");
    assert.match(e.message, /^retirement work remains at .*; recovery could not be verified: .*after-hooks already exists\. The retire hooks have run; the home, its work and the pre-hook recovery \(if any\) are kept; this retire stopped no session\.$/);
    return true;
  });
  // The home is kept, with the entry it declared and with what the hook wrote.
  assert.equal(readFileSync(join(result.home, ".ident", "signing.key"), "utf8"), "directory-ident-key");
  assert.equal(readFileSync(join(result.home, "hook-note.txt"), "utf8"), "written by the retire hook", "fixture premise: the hook ran and moved the home");
  assert.equal(readFileSync(join(result.home, "work", "from-hook.txt"), "utf8"), "spawn bytes");
  assert.equal(existsSync(join(result.home, "instance.json")), true);
  // The pre-hook snapshot is byte-identical to the home and work as they were before the hooks.
  const [name] = readdirSync(root);
  const first = join(root, name);
  assert.deepEqual(readdirSync(root), [name], "one recovery, and no staging beside it");
  assert.deepEqual(readdirSync(first).sort(), ["after-hooks", "home", "recovery.json", "work"], "no staging directory and no temporary manifest are left inside it");
  assert.equal(readFileSync(join(first, "after-hooks"), "utf8"), "in the way", "the entry that was in the way is not replaced");
  assert.equal(fingerprintTree(join(first, "home"), { instanceHome: true }), preHookHome);
  assert.equal(fingerprintTree(join(first, "work")), preHookWork);
  assert.equal(existsSync(join(first, "home", "hook-note.txt")), false);
  assert.equal(existsSync(join(first, "home", ".ident")), false, "the declared entry was not copied");
  // An interrupted second phase is never reported complete.
  const interrupted = readJson(join(first, "recovery.json"));
  assert.equal(interrupted.phase, "before-hooks");
  assert.equal(Object.hasOwn(interrupted, "afterHooks"), false);
  const firstBytes = fingerprintTree(first);

  // The hook behaves; the retry runs from the start and writes a recovery of its own.
  rmSync(join(f.context, "misbehave"));
  const retired = retireInstance(f.root, result.instance);
  assert.equal(existsSync(result.home), false);
  assert.equal(Object.hasOwn(retired, "workRecoveries"), false);
  assert.notEqual(retired.workRecovery.path, first, "the receipt names only the retry's own recovery");
  assert.deepEqual(readdirSync(root).sort(), [name, basename(retired.workRecovery.path)].sort());
  assert.equal(readJson(join(retired.workRecovery.path, "recovery.json")).phase, "complete");
  assert.equal(readFileSync(join(retired.workRecovery.path, "home", "hook-note.txt"), "utf8"), "written by the retire hook");
  assert.equal(readFileSync(join(retired.workRecovery.path, "work", "from-hook.txt"), "utf8"), "spawn bytes");
  assert.equal(existsSync(join(retired.workRecovery.path, "home", ".ident")), false);
  assert.deepEqual(retired.workRecovery.notCopied, [{ scope: "home", path: ".ident", owner: "example.worker" }]);
  // The earlier directory is not read, amended, completed or deleted.
  assert.equal(fingerprintTree(first), firstBytes, "the first recovery is unchanged");
  assert.equal(readJson(join(first, "recovery.json")).phase, "before-hooks");
});

test("a retire hook that redirects recovery storage after the pre-hook snapshot is refused: nothing is written through the link and the home is kept", async (t) => {
  const f = fixture(t, { hook: true });
  // The hook moves the recovery storage away, leaves a link in its place, and changes work/: the post-hook pass
  // has a part to add, and the only path to the recovery it would add it to now leads outside the owned storage.
  write(join(f.cap, "retire.mjs"), `import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const home = process.env.OATS_INSTANCE_HOME;
const root = join(dirname(home), '.oats-retirement', 'recovery');
const moved = join(process.env.OATS_CONTEXT, 'moved-recovery');
renameSync(root, moved);
symlinkSync(moved, root);
writeFileSync(join(home, 'work', 'late.txt'), 'written by the retire hook');
console.log(JSON.stringify({meta: {retired: true}}));\n`);
  const result = await f.spawn("late-redirect");
  const root = join(dirname(result.home), ".oats-retirement", "recovery");
  const moved = join(f.context, "moved-recovery");

  assert.throws(() => retireInstance(f.root, result.instance), (e) => {
    assert.equal(e.code, "E_WORK_PRESERVATION_FAILED");
    assert.match(e.message, /^retirement work remains at .*; recovery could not be verified: directory recovery storage was redirected\. The retire hooks have run; the home, its work and the pre-hook recovery \(if any\) are kept; this retire stopped no session\.$/);
    return true;
  });
  assert.equal(lstatSync(root).isSymbolicLink(), true, "fixture premise: the hook redirected the storage");
  assert.equal(readFileSync(join(result.home, "work", "late.txt"), "utf8"), "written by the retire hook", "fixture premise: the hook moved the work");
  // The home and its work are kept.
  assert.equal(readFileSync(join(result.home, "work", "from-hook.txt"), "utf8"), "spawn bytes");
  assert.equal(existsSync(join(result.home, "instance.json")), true);
  // The pre-hook snapshot, where the hook put it, gained nothing: no after-hooks/, no staging, no rewritten manifest.
  const [name] = readdirSync(moved);
  assert.deepEqual(readdirSync(moved), [name]);
  assert.deepEqual(readdirSync(join(moved, name)).sort(), ["home", "recovery.json", "work"], "nothing was written through the link");
  assert.equal(readJson(join(moved, name, "recovery.json")).phase, "before-hooks");
  assert.equal(existsSync(join(moved, name, "work", "late.txt")), false);
});

test("incomplete retire hooks retain directory work and cleanup metadata for a safe retry", async (t) => {
  const f = fixture(t, { hook: true });
  write(join(f.cap, "retire.mjs"), `import { existsSync } from 'node:fs';
console.log(JSON.stringify({meta: {retired: existsSync(process.env.OATS_CONTEXT + '/retry-ready')}}));\n`);
  const result = await f.spawn("retry");
  const first = retireInstance(f.root, result.instance);
  assert.ok(first.rollbackIncomplete?.length);
  assert.equal(existsSync(result.home), true);
  assert.equal(readFileSync(join(first.workRecovery.path, "work", "from-hook.txt"), "utf8"), "spawn bytes");
  write(join(f.context, "retry-ready"), "ready");
  const second = retireInstance(f.root, result.instance);
  assert.equal(second.rollbackIncomplete, undefined);
  assert.equal(existsSync(result.home), false);
});

test("retirement fails closed for exchanged work roots, missing authority and poisoned work-mode metadata", async (t) => {
  const f = fixture(t);
  for (const kind of ["symlink", "dangling-root", "metadata", "missing-authority"]) {
    const result = await f.spawn(kind);
    const work = join(result.home, "work"); write(join(work, "authored"), "keep");
    if (kind === "symlink" || kind === "dangling-root") {
      rmSync(work, { recursive: true });
      const outside = join(f.base, kind); if (kind === "symlink") write(join(outside, "sentinel"), "keep");
      symlinkSync(outside, work);
    } else if (kind === "metadata") {
      const file = join(result.home, "instance.json"), meta = readJson(file);
      meta.work = "checkout"; meta.branch = "main"; write(file, JSON.stringify(meta));
    } else rmSync(join(dirname(result.home), ".oats-retirement", "baselines"), { recursive: true });
    assert.throws(() => retireInstance(f.root, result.instance, { force: true }), (e) => e.code === "E_WORK_INSPECTION_FAILED");
    assert.equal(existsSync(result.home), true);
  }
});

/** The one spawn baseline of the instance at `home`, alone among its siblings. */
function soleBaseline(home) {
  const dir = join(dirname(home), ".oats-retirement", "baselines"), [name, ...more] = readdirSync(dir);
  assert.equal(more.length, 0);
  return join(dir, name);
}
const EXCHANGED = (name) => (e) => e.code === "E_WORK_INSPECTION_FAILED" && e.message === `directory ${name} was exchanged; restore the owned root before retrying start`;

test("#1261: a directory start refuses a home or work that another directory was renamed into", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("exchange"), home = result.home, work = join(home, "work");
  const roots = readJson(soleBaseline(home)).directoryRoots;
  for (const [name, path] of [["home", home], ["work", work]]) {
    const st = lstatSync(path, { bigint: true });
    assert.deepEqual(roots[name], { dev: Number(st.dev), ino: Number(st.ino), birthtimeNs: String(st.birthtimeNs) });
  }
  for (const [name, path] of [["work", work], ["home", home]]) {
    const saved = join(f.base, `saved-${name}`), other = join(f.base, `other-${name}`);
    mkdirSync(join(other, "work"), { recursive: true });
    renameSync(path, saved); renameSync(other, path);
    assert.throws(() => startInstanceSession(home), EXCHANGED(name));
    rmSync(path, { recursive: true }); renameSync(saved, path);
  }
});

test("#1261: a released baseline with no birth time whose recorded dev changed (a macOS remount) starts on darwin and is refused elsewhere", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("remount"), file = soleBaseline(result.home), baseline = readJson(file);
  const moved = ({ dev, ino }) => ({ dev: dev + 1, ino });
  writeFileSync(file, JSON.stringify({ ...baseline, directoryRoots: { home: moved(baseline.directoryRoots.home), work: moved(baseline.directoryRoots.work) } }), { mode: 0o600 });
  // The guard is the start's first check of the roots; past it, this fixture's start stops at the launch, which finds no tmux.
  if (process.platform === "darwin") assert.throws(() => startInstanceSession(result.home), (e) => e.code === "E_RUNTIME_ENDPOINT_UNKNOWN" && /tmux was not found/.test(e.message));
  else assert.throws(() => startInstanceSession(result.home), EXCHANGED("home"));
});

test("#1266: a baseline whose recorded dev changed (a btrfs reboot) starts when the birth time matches, and is refused when it does not", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("reboot"), file = soleBaseline(result.home), baseline = readJson(file);
  const roots = baseline.directoryRoots;
  const write = (shift) => writeFileSync(file, JSON.stringify({ ...baseline, directoryRoots: { home: shift(roots.home), work: shift(roots.work) } }), { mode: 0o600 });
  // The guard is the start's first check of the roots; past it, this fixture's start stops at the launch, which finds no tmux.
  const PASSED_GUARD = (e) => e.code === "E_RUNTIME_ENDPOINT_UNKNOWN" && /tmux was not found/.test(e.message);
  write((root) => ({ ...root, dev: root.dev + 1 }));
  // Off darwin a changed dev needs a recorded birth time; a filesystem that has none records "0".
  if (process.platform === "darwin" || roots.home.birthtimeNs !== "0") assert.throws(() => startInstanceSession(result.home), PASSED_GUARD);
  else assert.throws(() => startInstanceSession(result.home), EXCHANGED("home"));
  write((root) => ({ ...root, dev: root.dev + 1, birthtimeNs: String(BigInt(root.birthtimeNs) + 1n) }));
  assert.throws(() => startInstanceSession(result.home), EXCHANGED("home"));
});

test("retirement preserves work in place if recovery storage is unusable", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("blocked-recovery");
  write(join(result.home, "work", "authored"), "keep");
  write(join(dirname(result.home), ".oats-retirement", "recovery"), "not a directory");
  assert.throws(() => retireInstance(f.root, result.instance));
  assert.equal(readFileSync(join(result.home, "work", "authored"), "utf8"), "keep");
});

test("a non-Git context does not weaken the Git work modes; workspace mode is the deployment itself", async (t) => {
  const f = fixture(t);
  for (const work of ["checkout", "worktree", "attached"]) {
    await assert.rejects(f.spawn(`not-${work}`, { work, repo: ".", ...(work === "attached" ? { workDir: f.context } : {}) }), /not a git repo/);
  }
  // Workspace model: ./work of a `work: workspace` instance is the deployment directory,
  // which is not a Git checkout — never a repository the instance could branch in.
  const workspace = await f.spawn("not-workspace", { work: "workspace", repo: "." });
  assert.equal(realpathSync(join(workspace.home, "work")), f.context);
  assert.equal(existsSync(join(f.context, ".git")), false);
  retireInstance(f.root, workspace.instance);
  const unknown = cli(f, ["spawn", "worker", "--work", "nonGit", "--no-launch"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout, /unknown work mode/);
});

test("existing Git checkout, worktree, attached and workspace modes keep their layout and retirement semantics", async (t) => {
  const f = fixture(t, { git: true });
  const checkout = await f.spawn("checkout", { work: "checkout", repo: "." });
  assert.equal(realpathSync(join(checkout.home, "work")), f.context);
  const worktree = await f.spawn("tree", { work: "worktree", repo: "." });
  assert.equal(existsSync(join(worktree.home, "work", ".git")), true);
  assert.equal(worktree.branch, `agents/${worktree.instance}`);
  const attached = await f.spawn("attached", { work: "attached", repo: ".", workDir: join(worktree.home, "work") });
  assert.equal(attached.parentInstance, worktree.instance);
  assert.equal(realpathSync(join(attached.home, "work")), realpathSync(join(worktree.home, "work")));
  const workspace = await f.spawn("workspace", { work: "workspace", repo: "." });
  assert.equal(realpathSync(join(workspace.home, "work")), f.context);
  assert.equal(workspace.branch, undefined);
  retireInstance(f.root, attached.instance);
  assert.equal(existsSync(join(worktree.home, "work")), true);
  retireInstance(f.root, workspace.instance);
  retireInstance(f.root, checkout.instance);
  assert.equal(existsSync(join(f.context, ".git")), true);
  retireInstance(f.root, worktree.instance, { discardWorktree: true });
  assert.equal(existsSync(worktree.home), false);
  assert.equal(execFileSync("git", ["-C", f.context, "branch", "--list", worktree.branch], { encoding: "utf8" }).trim().replace(/^[*+] /, ""), worktree.branch, "the worktree's branch is left");
});

test("the retire plan's text says what is true of each work mode's work, and its JSON defaults are as they were (#959)", async (t) => {
  const f = fixture(t, { git: true });
  const tree = await f.spawn("plan-tree", { work: "worktree", repo: "." });
  const homes = {
    worktree: tree,
    attached: await f.spawn("plan-attached", { work: "attached", repo: ".", workDir: join(tree.home, "work") }),
    checkout: await f.spawn("plan-checkout", { work: "checkout", repo: "." }),
    workspace: await f.spawn("plan-workspace", { work: "workspace", repo: "." }),
    directory: await f.spawn("plan-directory"),
  };
  /** The plan of one instance through the CLI: its text, the `defaults:` line of it, and the `defaults` of its JSON. */
  const plan = (instance) => {
    const text = spawnSync(process.execPath, [CLI, "retire", instance, "--plan", "--dir", f.context], { cwd: f.context, env: process.env, encoding: "utf8" });
    assert.equal(text.status, 0, text.stdout + text.stderr);
    const lines = text.stdout.split("\n").filter((l) => l.startsWith("  defaults: "));
    assert.equal(lines.length, 1, text.stdout);
    const json = cli(f, ["retire", instance, "--plan"]);
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const result = JSON.parse(json.stdout).result;
    return { text: text.stdout, line: lines[0], defaults: result.defaults, workMode: result.facts.workMode };
  };
  const REST = ", delete branch false, stop children true";
  const LINES = {
    worktree: `  defaults: retain worktree true${REST}`,
    attached: `  defaults: no work tree of its own (work/ links to its owner's tree and that tree is not touched)${REST}`,
    checkout: `  defaults: no work tree of its own (work/ links to the shared checkout and that checkout is not touched)${REST}`,
    workspace: `  defaults: no work tree of its own (work/ links to the deployment directory and that directory is not touched)${REST}`,
    directory: `  defaults: no work tree (work/ is the home's own directory: copied to recovery when not empty and then removed with the home)${REST}`,
  };
  const defaults = (retainWorktree) => ({ retainWorktree, deleteBranch: false, stopChildren: true, retainChildren: true });
  for (const [mode, home] of Object.entries(homes)) {
    const seen = plan(home.instance);
    assert.equal(seen.workMode, mode);
    assert.equal(seen.line, LINES[mode], mode);
    assert.deepEqual(seen.defaults, defaults(mode === "worktree"), `${mode}: the JSON's defaults`);
    if (mode !== "worktree") assert.doesNotMatch(seen.line, /retain worktree/, mode);
  }
  // A record with no work mode, and one with a mode this kernel does not know: said, never "retain
  // worktree false", and in the kernel's words alone. The value is the record's: none of its text is
  // printed, whatever it is. A value that is not a string is never read as a mode's name (an array
  // of one known name would be, as a key), and never fails the text.
  const record = join(homes.checkout.home, "instance.json"), meta = readJson(record);
  const UNKNOWN = "work mode not known to this kernel";
  for (const [work, said, absent] of [[undefined, "work mode not recorded", []], ["zq-some-mode", UNKNOWN, ["zq-"]],
    [["attached"], UNKNOWN, ["attached", "owner"]], [{ toString: null, "zq-key": "zq-value" }, UNKNOWN, ["zq-", "toString"]]]) {
    writeFileSync(record, JSON.stringify({ ...meta, work }, null, 2) + "\n");
    const seen = plan(homes.checkout.instance);
    assert.deepEqual(seen.workMode, work ?? null, "the JSON holds the value as recorded");
    assert.equal(seen.line, `  defaults: ${said}${REST}`);
    for (const part of absent) assert.equal(seen.text.includes(part), false, `no text of the value in the plan's text (${part}): ${seen.text}`);
    assert.deepEqual(seen.defaults, defaults(false));
  }
});

test("a checkout or attached spawn records the branch HEAD names, or null when HEAD is detached or names no branch OATS carries, never \"HEAD\" (#641)", async (t) => {
  const f = fixture(t, { git: true });
  /** The branch as the spawn result, instance.json and `status --json` give it: the key's presence and its value. */
  const recorded = (result) => {
    const meta = readJson(join(result.home, "instance.json"));
    const status = cli(f, ["status", "--json"]);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    const row = JSON.parse(status.stdout).agents.flatMap((a) => a.instances).find((i) => i.instance === result.instance);
    const pick = (o) => ("branch" in o ? o.branch : "absent");
    const seen = { result: pick(result), meta: pick(meta), status: pick(row) };
    assert.notEqual(meta.branch, "HEAD");
    return seen;
  };
  const same = (value) => ({ result: value, meta: value, status: value });
  /** The work line of the instance's TASK.md: with a branch, worded as it always was. */
  const workLine = (result) => readFileSync(join(result.home, "TASK.md"), "utf8").split("\n").find((l) => l.startsWith("- Work tree: ./work"));
  const NO_BRANCH = "no branch that OATS can name, e.g. a detached HEAD";

  const onBranch = cliSpawn(f, ["--work", "checkout", "--repo", ".", "--purpose", "on-branch"]);
  assert.deepEqual(recorded(onBranch), same(git(f.context, "symbolic-ref", "--short", "HEAD")));
  assert.ok(workLine(onBranch).endsWith(`work on the currently checked-out branch (${onBranch.branch}) and do not switch branches without being asked`), workLine(onBranch));

  git(f.context, "checkout", "-q", "--detach");
  const detached = cliSpawn(f, ["--work", "checkout", "--repo", ".", "--purpose", "detached"]);
  assert.deepEqual(recorded(detached), same(null), "a detached checkout records null");
  assert.ok(workLine(detached).endsWith(`work on what is checked out (${NO_BRANCH}) and do not switch branches without being asked`), workLine(detached));

  const tree = await f.spawn("tree", { work: "worktree", repo: "." });
  const treeWork = join(tree.home, "work");
  const attached = cliSpawn(f, ["--work", "attached", "--repo", ".", "--work-dir", treeWork, "--purpose", "attached"]);
  assert.deepEqual(recorded(attached), same(tree.branch), "an attached instance records its owner's branch");
  assert.ok(workLine(attached).includes(`(${treeWork}, branch ${tree.branch}) — you share it`), workLine(attached));
  git(treeWork, "checkout", "-q", "--detach");
  const attachedDetached = cliSpawn(f, ["--work", "attached", "--repo", ".", "--work-dir", treeWork, "--purpose", "attached-detached"]);
  assert.deepEqual(recorded(attachedDetached), same(null), "an attached instance on a detached tree records null");
  assert.ok(workLine(attachedDetached).includes(`(${treeWork}, ${NO_BRANCH}) — you share it`), workLine(attachedDetached));

  // A branch whose name is not valid UTF-8. Git stores a loose ref as a file of that name: a
  // filesystem that refuses such names (APFS) cannot hold this part of the fixture.
  const probe = Buffer.concat([Buffer.from(join(f.base, "probe-caf")), Buffer.from([0xe9])]);
  let utf8Only = false;
  try { writeFileSync(probe, ""); rmSync(probe); } catch (err) { if (err.code !== "EILSEQ") throw err; utf8Only = true; }
  if (!utf8Only) {
    const ref = Buffer.concat([Buffer.from("refs/heads/caf"), Buffer.from([0xe9])]);
    const commit = git(f.context, "rev-parse", "HEAD");
    execFileSync("git", ["-C", f.context, "update-ref", "--stdin"], { input: Buffer.concat([Buffer.from("update "), ref, Buffer.from(` ${commit}\n`)]), stdio: ["pipe", "pipe", "pipe"] });
    writeFileSync(join(f.context, ".git", "HEAD"), Buffer.concat([Buffer.from("ref: "), ref, Buffer.from("\n")]));
    assert.equal(execFileSync("git", ["-C", f.context, "symbolic-ref", "HEAD"]).subarray(0, -1).equals(ref), true, "fixture premise: HEAD names the ref by its bytes");
    const notUtf8 = cliSpawn(f, ["--work", "checkout", "--repo", ".", "--purpose", "not-utf8"]);
    assert.deepEqual(recorded(notUtf8), same(null), "a branch whose name is not valid UTF-8 records null");
  } else t.diagnostic("filesystem refuses non-UTF-8 names (APFS): the not-UTF-8 branch case is covered on Linux");

  // An attached tree whose HEAD cannot be read records no branch at all, as before. Every home
  // here sits inside the deployment's checkout, so a directory instance's work would read that
  // checkout's HEAD: a .git that names no repository makes it a tree Git cannot read.
  const dir = await f.spawn("dir", { work: "directory" });
  writeFileSync(join(dir.home, "work", ".git"), `gitdir: ${join(f.base, "no-such-repository")}\n`);
  const attachedDir = cliSpawn(f, ["--work", "attached", "--repo", ".", "--work-dir", join(dir.home, "work"), "--purpose", "attached-dir"]);
  assert.deepEqual(recorded(attachedDir), { ...same("absent"), result: null }, "a tree whose HEAD cannot be read records no key; the CLI's spawn result always carries one, null");
});

test("Git-owned home placement still fails closed when Git is unavailable even for explicit directory execution", async (t) => {
  const f = fixture(t, { git: true });
  const pre = await f.prepare(); // the workspace is read over Git; placement then runs without it
  process.env.PATH = join(f.base, "bin");
  await assert.rejects(f.spawn("no-git-owned", {}, pre), (e) => e.code === "E_NO_CANONICAL_ROOT");
});

test("the Desktop work-mode schema forwards explicit directory mode without loosening argv validation", async () => {
  const { spawnArgv } = await import("../packages/client/cli-adapter.mjs");
  const argv = spawnArgv("worker", "/context", "/task", { work: "directory" });
  assert.equal(argv[argv.indexOf("--work") + 1], "directory");
  assert.throws(() => spawnArgv("worker", "/context", "/task", { work: "directory --work-dir /source" }), /invalid/);
});

test("CLI --dir isolates directory execution from the invoking Git checkout", async (t) => {
  const f = fixture(t);
  const source = join(f.base, "source-repo"); mkdirSync(source);
  process.env.PATH += `:${HOST_PATH}`;
  execFileSync("git", ["init", "-q", source]);
  write(join(source, "sentinel.txt"), "unrelated source\n");
  const result = cliSpawn(f, [], source);
  assert.equal(readJson(join(result.home, "instance.json")).repo, f.context);
  assert.equal(existsSync(join(result.home, "work", ".git")), false);
  retireInstance(f.root, result.instance);
  assert.equal(existsSync(join(source, ".git")), true);
});

test("failed spawn preserves directory results before and after compensation instead of deleting them", async (t) => {
  const f = fixture(t, { hook: true });
  const manifest = readJson(join(f.cap, "oats.json"));
  manifest.hooks.spawn = { command: "spawn.mjs", required: true };
  write(join(f.cap, "oats.json"), JSON.stringify(manifest));
  write(join(f.cap, "spawn.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/result.txt', 'before compensation');
process.exitCode = 1;\n`);
  write(join(f.cap, "retire.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/result.txt', 'after compensation');
console.log(JSON.stringify({meta: {retired: true}}));\n`);
  await assert.rejects(f.spawn("rollback"), (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /directory work preserved at/.test(e.message));
  const home = join(f.root, "worker", "instances", "worker-rollback");
  assert.equal(existsSync(home), false);
  const recovery = join(dirname(home), ".oats-retirement", "recovery");
  const copies = readdirSync(recovery).map((entry) => readFileSync(join(recovery, entry, "work", "result.txt"), "utf8")).sort();
  assert.deepEqual(copies, ["after compensation", "before compensation"]);
});

test("directory recovery refuses storage redirected into disposable work or an arbitrary outside path", async (t) => {
  const f = fixture(t);
  for (const target of ["work", "outside"]) {
    const result = await f.spawn(`redirected-${target}`);
    write(join(result.home, "work", "authored"), "keep");
    const recovery = join(dirname(result.home), ".oats-retirement", "recovery");
    const destination = target === "work" ? join(result.home, "work") : join(f.base, "outside-recovery");
    if (target === "outside") mkdirSync(destination);
    symlinkSync(destination, recovery);
    assert.throws(() => retireInstance(f.root, result.instance), (e) => e.code === "E_WORK_PRESERVATION_FAILED");
    assert.equal(readFileSync(join(result.home, "work", "authored"), "utf8"), "keep");
    rmSync(recovery);
  }
});

test("unsupported filesystem entries fail retirement closed, even with force", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("fifo");
  write(join(result.home, "work", "authored"), "keep");
  execFileSync("mkfifo", [join(result.home, "work", "pipe")], { env: { ...process.env, PATH: HOST_PATH } });
  assert.throws(() => retireInstance(f.root, result.instance, { force: true }), (e) => e.code === "E_WORK_INSPECTION_FAILED");
  assert.equal(readFileSync(join(result.home, "work", "authored"), "utf8"), "keep");
});

test("directory mode is runtime-neutral and records the frozen no-launch recipe for every supported harness", async (t) => {
  const f = fixture(t);
  for (const harness of ["pi", "claude", "codex"]) {
    const result = await f.spawn(`harness-${harness}`, { harness });
    const meta = readJson(join(result.home, "instance.json"));
    assert.equal(meta.launch.harness, harness);
    assert.equal(meta.harness, harness);
    assert.equal(meta.launched, false);
    assert.equal(meta.work, "directory");
    assert.ok(meta.command.includes(result.home));
    assert.equal(lstatSync(join(result.home, "work")).isDirectory(), true);
    retireInstance(f.root, result.instance);
  }
});

test("keep-dir retirement retains the owned directory as well as a recovery receipt", async (t) => {
  const f = fixture(t);
  const result = await f.spawn("keep");
  write(join(result.home, "work", "authored"), "keep");
  const retired = retireInstance(f.root, result.instance, { keepDir: true });
  assert.equal(retired.removedDir, false);
  assert.equal(readFileSync(join(result.home, "work", "authored"), "utf8"), "keep");
  assert.equal(readFileSync(join(retired.workRecovery.path, "work", "authored"), "utf8"), "keep");
});

for (const phase of ["before", "after-incomplete", "after-complete"]) {
  test(`failed directory spawn: recovery failure ${phase} compensation retains original cleanup authority without instance.json`, async (t) => {
    const f = fixture(t, { hook: true });
    const manifest = readJson(join(f.cap, "oats.json"));
    manifest.hooks.spawn = { command: "spawn.mjs", required: true };
    write(join(f.cap, "oats.json"), JSON.stringify(manifest));
    const home = join(f.root, "worker/instances/worker-recovery-fail");
    const recovery = join(dirname(home), ".oats-retirement/recovery");
    const events = join(f.context, "compensation.jsonl");
    write(join(f.cap, "spawn.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/result.txt', 'before compensation');
console.log(JSON.stringify({meta: {receipt: 'original-external-id'}}));
process.exitCode = 1;`);
    write(join(f.cap, "retire.mjs"), `import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(events)}, process.env.OATS_META + '\\n');
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/result.txt', 'after compensation');
const retry = existsSync(process.env.OATS_CONTEXT + '/retry-ready');
if (${phase !== "before"} && !retry) {
  renameSync(${JSON.stringify(recovery)}, ${JSON.stringify(recovery + "-first")});
  writeFileSync(${JSON.stringify(recovery)}, 'storage temporarily unavailable');
}
console.log(JSON.stringify({meta: {retired: retry || ${phase === "after-complete"}, receipt: 'not-the-spawn-receipt'}}));`);
    if (phase === "before") write(recovery, "storage temporarily unavailable");
    await assert.rejects(f.spawn("recovery-fail"), (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /home is RETAINED/.test(e.message));
    assert.ok(noSpawnRecord(home), "the failed spawn wrote no instance record");
    const markerPath = join(home, ".oats-rollback-incomplete.json");
    const marker = readJson(markerPath);
    assert.deepEqual(marker.cleanup.capabilityMeta, { "example.worker": { receipt: "original-external-id" } });
    assert.deepEqual(marker.cleanup.outstanding, { hooks: ["example.worker"], git: [], directory: true });
    assert.equal(marker.cleanup.work, "directory");
    assert.equal(marker.cleanup.launched, false);
    assert.ok(marker.cleanup.capabilityRuntime[0].hooks.retire);
    if (phase !== "before") assert.equal(marker.compensationReported["example.worker"].receipt, "not-the-spawn-receipt");
    const baselines = join(dirname(home), ".oats-retirement/baselines");
    const baseline = readJson(join(baselines, readdirSync(baselines)[0]));
    assert.equal(baseline.home, home);
    assert.equal(baseline.directoryWork, true);
    assert.deepEqual(baseline.runtime, { launched: false });
    // A retry while storage is still broken must keep the receipt and must not
    // run the destructive hook ahead of preserving the outstanding work bytes.
    assert.throws(() => retireInstance(f.root, "worker-recovery-fail"));
    assert.deepEqual(readJson(markerPath), marker);
    assert.equal(existsSync(events), phase !== "before");
    assert.equal(readFileSync(join(home, "work/result.txt"), "utf8"), phase === "before" ? "before compensation" : "after compensation");
    rmSync(recovery);
    if (phase !== "before") renameSync(recovery + "-first", recovery);
    write(join(f.context, "retry-ready"), "ready");
    const retired = retireInstance(f.root, "worker-recovery-fail");
    assert.equal(retired.rollbackIncomplete, undefined);
    assert.equal(retired.removedDir, true);
    assert.equal(existsSync(home), false);
    const receipts = readFileSync(events, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(receipts, Array(phase === "before" ? 1 : 2).fill({ receipt: "original-external-id" }));
    const entries = readdirSync(recovery);
    if (phase === "before") {
      // The failed spawn could not write its copy (the storage was unusable), so this retire wrote the one
      // recovery: the work as the spawn hook left it, and under after-hooks/ the work as the retire hook left it.
      assert.deepEqual(entries, [basename(retired.workRecovery.path)], "one recovery, written by this retire");
      const entry = join(recovery, entries[0]);
      assert.equal(readFileSync(join(entry, "work/result.txt"), "utf8"), "before compensation");
      assert.equal(readFileSync(join(entry, "after-hooks/work/result.txt"), "utf8"), "after compensation");
      const recorded = readJson(join(entry, "recovery.json"));
      assert.equal(recorded.phase, "complete");
      assert.deepEqual(recorded.afterHooks, { home: false, work: true });
    } else {
      // Two directories here, and the second does not come from the retire: the failed spawn wrote its own copy
      // before its compensation hook ran (issue #598), and the retire wrote one, of the work that hook left.
      const copies = entries.map((entry) => readFileSync(join(recovery, entry, "work/result.txt"), "utf8"));
      assert.ok(copies.includes("before compensation"));
      assert.ok(copies.includes("after compensation"));
    }
  });
}

for (const launch of [false, true]) for (const kind of ["symlink", "dangling", "missing", "file"]) {
  test(`post-spawn hook work root ${kind} cannot succeed or reach backend (launch=${launch})`, async (t) => {
    const f = fixture(t, { hook: true });
    const events = join(f.base, "backend.jsonl");
    write(join(f.base, "bin/tmux"), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(events)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'display-message') console.log(${JSON.stringify(join(f.base, "fake.sock"))});
`);
    chmodSync(join(f.base, "bin/tmux"), 0o755);
    write(join(f.context, "sentinel"), "not owned");
    const untouched = readdirSync(f.context).sort();
    write(join(f.cap, "spawn.mjs"), `import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(home + '/work/authored', 'keep original work');
renameSync(home + '/work', home + '/original-work');
if (${kind === "symlink" || kind === "dangling"}) symlinkSync(process.env.OATS_CONTEXT + ${JSON.stringify(kind === "dangling" ? "/absent" : "")}, home + '/work');
if (${kind === "file"}) writeFileSync(home + '/work', 'not a directory');
console.log(JSON.stringify({meta: {receipt: 'original-hook-receipt'}}));`);
    write(join(f.cap, "retire.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_CONTEXT + '/retired.json', process.env.OATS_META);
console.log(JSON.stringify({meta: {retired: true}}));`);
    const home = join(f.root, "worker/instances/worker-substituted");
    await assert.rejects(f.spawn("substituted", { launch, tmuxSession: "inert-fixture-only" }), (e) => e.code === "E_WORK_INSPECTION_FAILED" && /RETAINED/.test(e.message));
    assert.equal(f.loginFallbacks(), launch ? 1 : 0, "the refused spawn had planned its launch, once, before it was refused; with no launch it plans none");
    // A launch reads the OATS server before any hook runs (its harness is looked up where its pane will look):
    // that read is all. Nothing is created, killed or sent, so no command can reach the substituted root.
    const afterSpawn = existsSync(events) ? readFileSync(events, "utf8") : "";
    const backend = afterSpawn.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(backend.filter((argv) => !argv.includes("list-sessions") && !argv.includes("show-environment")), [], "no backend command may run with the substituted root");
    assert.ok(noSpawnRecord(home), "the failed spawn wrote no instance record");
    assert.equal(existsSync(join(home, "TASK.md")), false);
    assert.deepEqual(readdirSync(f.context).sort(), untouched, "must not compensate through or write into the substituted target");
    const marker = readJson(join(home, ".oats-rollback-incomplete.json"));
    assert.deepEqual(marker.cleanup.capabilityMeta, { "example.worker": { receipt: "original-hook-receipt" } });
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["example.worker"]);
    assert.equal(marker.cleanup.outstanding.directory, true);
    assert.throws(() => retireInstance(f.root, "worker-substituted", { force: true }), (e) => e.code === "E_WORK_INSPECTION_FAILED");
    assert.equal(readFileSync(join(f.context, "sentinel"), "utf8"), "not owned");
    if (kind !== "missing") rmSync(join(home, "work")); // unlink only; never recurse through a target
    renameSync(join(home, "original-work"), join(home, "work"));
    const retired = retireInstance(f.root, "worker-substituted");
    assert.equal(retired.rollbackIncomplete, undefined);
    assert.equal(readFileSync(join(retired.workRecovery.path, "work/authored"), "utf8"), "keep original work");
    assert.deepEqual(readJson(join(f.context, "retired.json")), { receipt: "original-hook-receipt" });
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(events) ? readFileSync(events, "utf8") : "", afterSpawn, "the retire ran no backend command");
  });
}

for (const kind of ["symlink", "missing", "file"]) {
  test(`post-spawn hook ${kind} home keeps cleanup beside it without following the replacement`, async (t) => {
    const f = fixture(t, { hook: true });
    const savedHome = join(f.base, "original-home");
    write(join(f.context, "sentinel"), "keep");
    const untouched = readdirSync(f.context).sort();
    write(join(f.cap, "spawn.mjs"), `import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(home + '/work/authored', 'keep');
renameSync(home, ${JSON.stringify(savedHome)});
if (${kind === "symlink"}) symlinkSync(process.env.OATS_CONTEXT, home);
if (${kind === "file"}) writeFileSync(home, 'not the home');
console.log(JSON.stringify({meta: {receipt: 'original-home-receipt'}}));`);
    write(join(f.cap, "retire.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_CONTEXT + '/retired.json', process.env.OATS_META);
console.log(JSON.stringify({meta: {retired: true}}));`);
    const home = join(f.root, "worker/instances/worker-home-replaced");
    await assert.rejects(f.spawn("home-replaced"), (e) => e.code === "E_WORK_INSPECTION_FAILED");
    assert.deepEqual(readdirSync(f.context).sort(), untouched);
    const markerPath = join(dirname(home), ".oats-directory-rollback-worker-home-replaced.json");
    const marker = readJson(markerPath);
    assert.deepEqual(marker.cleanup.capabilityMeta, { "example.worker": { receipt: "original-home-receipt" } });
    assert.deepEqual(marker.cleanup.outstanding, { hooks: ["example.worker"], git: [], directory: true });
    if (kind === "missing") await assert.rejects(f.spawn("home-replaced"), /cleanup is still owed/);
    assert.throws(() => retireInstance(f.root, "worker-home-replaced", { force: true }));
    assert.throws(() => startInstanceSession(home), (e) => e.code === "E_INSTANCE_RETIRING");
    assert.deepEqual(readdirSync(f.context).sort(), untouched);
    if (kind !== "missing") rmSync(home);
    renameSync(savedHome, home);
    assert.ok(listInstances(f.root)[0].instances[0].rollbackIncomplete);
    assert.throws(() => startInstanceSession(home), (e) => e.code === "E_INSTANCE_RETIRING");
    const retired = retireInstance(f.root, "worker-home-replaced");
    assert.equal(retired.removedDir, true);
    assert.equal(retired.rollbackIncomplete, undefined);
    assert.equal(existsSync(markerPath), false);
    assert.deepEqual(readJson(join(f.context, "retired.json")), { receipt: "original-home-receipt" });
    assert.equal(readFileSync(join(retired.workRecovery.path, "work/authored"), "utf8"), "keep");
  });
}

test("directory preservation alone is retryable debt; it does not invent a missing retire hook", async (t) => {
  const f = fixture(t, { hook: true });
  const manifest = readJson(join(f.cap, "oats.json"));
  delete manifest.hooks.retire;
  write(join(f.cap, "oats.json"), JSON.stringify(manifest));
  write(join(f.cap, "spawn.mjs"), `import { mkdirSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/authored', 'keep');
mkdirSync(process.env.OATS_INSTANCE_HOME + '/TASK.md');`);
  const home = join(f.root, "worker/instances/worker-preservation-only");
  const recovery = join(dirname(home), ".oats-retirement/recovery");
  write(recovery, "temporarily unavailable");
  await assert.rejects(f.spawn("preservation-only"), /RETAINED/);
  const marker = readJson(join(home, ".oats-rollback-incomplete.json"));
  assert.deepEqual(marker.cleanup.outstanding, { hooks: [], git: [], directory: true });
  assert.ok(noSpawnRecord(home), "the failed spawn wrote no instance record");
  rmSync(recovery);
  const retired = retireInstance(f.root, "worker-preservation-only");
  assert.equal(retired.rollbackIncomplete, undefined);
  assert.equal(retired.removedDir, true);
  assert.equal(readFileSync(join(retired.workRecovery.path, "work/authored"), "utf8"), "keep");
});

test("compensation cannot substitute the directory root or replace the original retry receipt", async (t) => {
  const f = fixture(t, { hook: true });
  const manifest = readJson(join(f.cap, "oats.json"));
  manifest.hooks.spawn = { command: "spawn.mjs", required: true };
  write(join(f.cap, "oats.json"), JSON.stringify(manifest));
  write(join(f.context, "sentinel"), "not owned");
  write(join(f.cap, "spawn.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/authored', 'keep');
console.log(JSON.stringify({meta: {receipt: 'original'}}));
process.exitCode = 1;`);
  write(join(f.cap, "retire.mjs"), `import { appendFileSync, existsSync, renameSync, symlinkSync } from 'node:fs';
appendFileSync(process.env.OATS_CONTEXT + '/receipts.jsonl', process.env.OATS_META + '\\n');
const retry = existsSync(process.env.OATS_CONTEXT + '/retry-ready');
if (!retry) {
  renameSync(process.env.OATS_INSTANCE_HOME + '/work', process.env.OATS_INSTANCE_HOME + '/original-work');
  symlinkSync(process.env.OATS_CONTEXT, process.env.OATS_INSTANCE_HOME + '/work');
}
console.log(JSON.stringify({meta: {retired: retry, receipt: 'compensation-report-only'}}));`);
  const home = join(f.root, "worker/instances/worker-compensation-swap");
  await assert.rejects(f.spawn("compensation-swap"), (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /prior work recovery/.test(e.message));
  const marker = readJson(join(home, ".oats-rollback-incomplete.json"));
  assert.deepEqual(marker.cleanup.capabilityMeta, { "example.worker": { receipt: "original" } });
  assert.equal(marker.compensationReported["example.worker"].receipt, "compensation-report-only");
  assert.throws(() => retireInstance(f.root, "worker-compensation-swap", { force: true }), (e) => e.code === "E_WORK_INSPECTION_FAILED");
  assert.equal(readFileSync(join(f.context, "sentinel"), "utf8"), "not owned");
  rmSync(join(home, "work"));
  renameSync(join(home, "original-work"), join(home, "work"));
  write(join(f.context, "retry-ready"), "ready");
  const retired = retireInstance(f.root, "worker-compensation-swap");
  assert.equal(retired.removedDir, true);
  assert.equal(retired.rollbackIncomplete, undefined);
  assert.deepEqual(readFileSync(join(f.context, "receipts.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [{ receipt: "original" }, { receipt: "original" }]);
  assert.equal(readFileSync(join(retired.workRecovery.path, "work/authored"), "utf8"), "keep");
});

test("directory preservation debt never clears an external receipt with no retire hook", async (t) => {
  const f = fixture(t, { hook: true });
  const manifest = readJson(join(f.cap, "oats.json"));
  manifest.hooks.spawn = { command: "spawn.mjs", required: true };
  delete manifest.hooks.retire;
  write(join(f.cap, "oats.json"), JSON.stringify(manifest));
  write(join(f.cap, "spawn.mjs"), `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.OATS_INSTANCE_HOME + '/work/authored', 'keep');
console.log(JSON.stringify({meta: {receipt: 'external-state'}}));
process.exitCode = 1;`);
  const home = join(f.root, "worker/instances/worker-missing-cleanup");
  const recovery = join(dirname(home), ".oats-retirement/recovery");
  write(recovery, "blocked");
  await assert.rejects(f.spawn("missing-cleanup"), (e) => e.code === "E_REQUIRED_HOOK_FAILED");
  rmSync(recovery);
  const retired = retireInstance(f.root, "worker-missing-cleanup");
  assert.equal(retired.removedDir, false);
  assert.match(retired.rollbackIncomplete.join("\n"), /declares no retire hook/);
  assert.equal(readFileSync(join(home, "work/authored"), "utf8"), "keep");
  assert.deepEqual(readJson(join(home, ".oats-rollback-incomplete.json")).cleanup.capabilityMeta, { "example.worker": { receipt: "external-state" } });
});

