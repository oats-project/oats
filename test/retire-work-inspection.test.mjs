// What the inspection reads and leaves out: a file that cannot be read, the home entries a capability
// declares disposable, the plan and its notes, Git settings that would redirect the reads, and refusals after
// the hooks. One part of what was retire-work-safety.test.mjs (awebai/oats#1061); the fixtures it shares with
// the other parts are in helpers/retire-work-safety-fixture.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { capabilityFiles } from "./helpers/v2-deployment.mjs";
import { NO_LAZY_FETCH_GIT } from "../lib/instance-git.mjs";
import { pathLimitSkip } from "./helpers/path-limit.mjs";
import { workRecoveryLines } from "../lib/retire-output.mjs";
import { lifecyclePlan } from "../packages/client/lifecycle-contract.mjs";
import {
  CLI, IDENT_DECLARED, IDENT_KEY, IDENT_NOT_COPIED, REFUSED_AFTER_HOOKS, RETIRE_WRITES_NOTHING, baselineOf,
  cli, fixture, fixtureGit, hookCapability, hookRan, identCapability, identHookRan, namesStartingWith,
  pathsNamed, porcelain, quietHook, readJson, recoveryRootOf, refusedBeforeHooks, spawn, spawnWithNote,
  staleUnderTextAttribute, statusRowsIn, storedBytes, under, withByte, write,
} from "./helpers/retire-work-safety-fixture.mjs";

// ---- A file of the worktree that cannot be read ----
// Proving the work unchanged reads every file of a provable worktree, also one under a work root a
// capability declared disposable, and also when the snapshot before the hooks holds the home only.
// A file that cannot be read (here: one without read permission) refuses the retire before its
// hooks. No flag skips that read.
test("a file without read permission under a declared disposable work root, with only a home note to preserve: the retire refuses with E_WORK_INSPECTION_FAILED before its hooks, with --force too, names the worktree, writes no recovery and keeps the home and the work", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root reads a file without read permission");
    return;
  }
  const capability = hookCapability(quietHook(""));
  capability["acme.hook"].manifest.retirement = { disposable: { work: ["cache"] } };
  const f = fixture({ capabilities: capability });
  const spawned = spawn(f, "large-file");
  const work = join(spawned.home, "work");
  assert.deepEqual(readJson(baselineOf(spawned.home)).disposableReceipts, [{ owner: "acme.hook", root: "cache" }], "fixture premise: the work root was declared disposable at spawn");
  write(join(spawned.home, "notes", "x.md"), "an authored note\n");
  const closed = join(work, "cache", "closed.bin");
  write(closed, "bytes no one may read\n");
  chmodSync(closed, 0o000);
  assert.deepEqual(statusRowsIn(porcelain(work)), ["!! cache/"], "fixture premise: Git reports the declared root as ignored whole, so only the home has something to preserve");

  for (const flags of [["--discard-worktree"], ["--force"]]) {
    const retired = cli(f, ["retire", basename(spawned.home), ...flags, "--json"]);
    assert.notEqual(retired.status, 0, `${flags[0]}: a worktree with a file that cannot be read was retired: ${retired.stdout}`);
    const error = JSON.parse(retired.stdout).error;
    assert.equal(error.code, "E_WORK_INSPECTION_FAILED", retired.stdout);
    assert.match(error.message, new RegExp(`^could not read the worktree at \\S+\\/work: .+\\. No recovery was written and nothing was deleted: ${basename(spawned.home)} is not retired and its home is kept; this retire stopped no session$`), `${flags[0]}: the message names the worktree, gives the reason the read failed, and says what this retire did and did not do`);
    assert.equal(hookRan(spawned.home), false, `${flags[0]}: no retire hook ran`);
    assert.equal(existsSync(recoveryRootOf(spawned.home)), false, `${flags[0]}: no recovery was written`);
    assert.equal(readFileSync(join(spawned.home, "notes", "x.md"), "utf8"), "an authored note\n", `${flags[0]}: the home is kept`);
    assert.equal(lstatSync(closed).mode & 0o7777, 0o000, `${flags[0]}: the work is kept as it was`);
  }
});

test("home entries a capability declared in retirement.disposable.home are not copied to recovery, stay for the retire hooks, and are named without their contents", () => {
  const f = fixture({ capabilities: identCapability() });
  const spawned = spawnWithNote(f, "ident");
  // Recorded at spawn, in the independent baseline: sorted by owner, then root.
  assert.deepEqual(readJson(baselineOf(spawned.home)).disposableHome, [".ident", ".ident-id-*", ".ident-state"].map((root) => ({ owner: "acme.ident", root })));
  const retired = cli(f, ["retire", "dev-ident", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const receipt = JSON.parse(retired.stdout);
  const recovery = receipt.workRecovery;
  const root = recoveryRootOf(spawned.home);
  assert.deepEqual(readdirSync(root), [basename(recovery.path)]);
  assert.deepEqual(pathsNamed(root, "signing.key"), [], "no key anywhere under recovery");
  for (const name of [".ident", ".ident-id-wide", ".ident-state"]) assert.deepEqual(pathsNamed(root, name), [], name);
  assert.equal(readFileSync(join(recovery.path, "home", "notes", "x.md"), "utf8"), "an authored note\n");
  // The hook-written .ident-state is declared too: named as not copied, and no post-hook copy was triggered by it.
  assert.deepEqual(recovery.notCopied, IDENT_NOT_COPIED);
  assert.equal(recovery.afterHooks, undefined);
  assert.equal(existsSync(join(recovery.path, "after-hooks")), false);
  assert.equal(recovery.home.paths.some((p) => p.path.startsWith(".ident")), false, JSON.stringify(recovery.home.paths));
  // Exclusion is "do not copy": the key was still in the home when the retire hook ran.
  assert.equal(identHookRan(spawned.home), true);
  assert.deepEqual(receipt.capabilityMeta["acme.ident"], { retired: true, keyPresent: true });
  // Names and owners only: no contents, sizes, hashes or modes of what was left out.
  const manifestText = readFileSync(join(recovery.path, "recovery.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.deepEqual(manifest.notCopied, recovery.notCopied);
  assert.equal(manifest.phase, "complete");
  for (const row of [...recovery.notCopied, ...manifest.notCopied]) assert.deepEqual(Object.keys(row).sort(), ["owner", "path", "scope"]);
  for (const [what, text] of [["recovery.json", manifestText], ["the receipt", retired.stdout]]) {
    assert.equal(text.includes(IDENT_KEY.trim()), false, `the key's bytes are in ${what}`);
    assert.equal(text.includes(Buffer.from(IDENT_KEY).toString("base64")), false, `the key's bytes are in ${what}, encoded`);
  }
  assert.equal(existsSync(spawned.home), false);

  // The text output names them once, by capability.
  const again = spawnWithNote(f, "ident-text");
  const text = cli(f, ["retire", "dev-ident-text"]);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.split("\n").includes("  not copied: .ident, .ident-id-wide, .ident-state (acme.ident)"), text.stdout);
  assert.equal(text.stdout.includes("after the retire hooks"), false, text.stdout);
  assert.equal(text.stdout.includes(IDENT_KEY.trim()), false);
  assert.deepEqual(pathsNamed(recoveryRootOf(again.home), "signing.key"), []);
});

test("positive control: the same provider without the declaration has its key copied to recovery, before and after the hooks", () => {
  const f = fixture({ capabilities: identCapability({ declare: false }) });
  const spawned = spawnWithNote(f, "undeclared");
  assert.deepEqual(readJson(baselineOf(spawned.home)).disposableHome, [], "nothing was declared, so nothing was recorded");
  const retired = cli(f, ["retire", "dev-undeclared", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const recovery = JSON.parse(retired.stdout).workRecovery;
  assert.equal(readFileSync(join(recovery.path, "home", ".ident", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(recovery.path, "home", ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(recovery.notCopied, undefined);
  // The hook's undeclared .ident-state write moves the home: the post-hook pass runs, in the same directory.
  assert.deepEqual(recovery.afterHooks, { home: true, work: false });
  assert.equal(readFileSync(join(recovery.path, "after-hooks", "home", ".ident-state", "retire.json"), "utf8"), JSON.stringify({ at: "retire" }));
  assert.deepEqual(readdirSync(recoveryRootOf(spawned.home)), [basename(recovery.path)]);
  assert.equal(pathsNamed(recoveryRootOf(spawned.home), "signing.key").length, 4, "the search used above finds a copied key");
});

test("a retire hook that reports incomplete cleanup keeps the home with its declared entries, and recovery still holds no copy of them", () => {
  const f = fixture({ capabilities: identCapability({ meta: { retired: false, reason: "remote unreachable" } }) });
  const spawned = spawnWithNote(f, "owed");
  const retired = cli(f, ["retire", "dev-owed", "--json"]);
  assert.equal(retired.status, 1, `${retired.stderr}\n${retired.stdout}`);
  const receipt = JSON.parse(retired.stdout);
  assert.ok(receipt.rollbackIncomplete?.some((item) => /acme\.ident: reported incomplete cleanup \(remote unreachable\)/.test(item)), retired.stdout);
  assert.equal(receipt.retainedHome, spawned.home);
  assert.equal(receipt.removedDir, false);
  assert.equal(identHookRan(spawned.home), true);
  // The credential a retry needs is where it was, with the hook's own state and the cleanup marker.
  assert.equal(readFileSync(join(spawned.home, ".ident", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(spawned.home, ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(existsSync(join(spawned.home, ".ident-state", "retire.json")), true);
  assert.equal(existsSync(join(spawned.home, ".oats-rollback-incomplete.json")), true);
  assert.deepEqual(pathsNamed(recoveryRootOf(spawned.home), "signing.key"), []);
  assert.equal(readFileSync(join(receipt.workRecovery.path, "home", "notes", "x.md"), "utf8"), "an authored note\n");
  assert.deepEqual(receipt.workRecovery.notCopied, IDENT_NOT_COPIED);
});

test("a forced removal past incomplete cleanup removes the home with its declared entries, and recovery holds no copy of them", () => {
  const f = fixture({ capabilities: identCapability({ meta: { retired: false, reason: "remote unreachable" } }) });
  const spawned = spawnWithNote(f, "forced");
  const retired = cli(f, ["retire", "dev-forced", "--force", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const receipt = JSON.parse(retired.stdout);
  assert.ok(receipt.forcedIncomplete?.some((item) => /acme\.ident: reported incomplete cleanup \(remote unreachable\)/.test(item)), retired.stdout);
  assert.equal(receipt.rollbackIncomplete, undefined);
  assert.equal(receipt.removedDir, true);
  assert.equal(identHookRan(spawned.home), true);
  assert.equal(existsSync(spawned.home), false, "the home is removed, and its declared entries with it");
  // What was declared went with the home: no copy of it anywhere under recovery.
  const root = recoveryRootOf(spawned.home);
  assert.deepEqual(readdirSync(root), [basename(receipt.workRecovery.path)], "one recovery");
  assert.deepEqual(pathsNamed(root, "signing.key"), [], "no key anywhere under recovery");
  for (const name of [".ident", ".ident-id-wide", ".ident-state"]) assert.deepEqual(pathsNamed(root, name), [], name);
  assert.equal(readFileSync(join(receipt.workRecovery.path, "home", "notes", "x.md"), "utf8"), "an authored note\n");
  assert.deepEqual(receipt.workRecovery.notCopied, IDENT_NOT_COPIED);
});

test("the fingerprint and the copy agree: a change to declared entries alone preserves nothing, an undeclared hidden entry is preserved", () => {
  const f = fixture({ capabilities: identCapability() });
  const quiet = spawn(f, "declared-only");
  write(join(quiet.home, ".ident", "rotated.key"), "rotated after spawn\n");
  write(join(quiet.home, ".ident-id-late", "signing.key"), IDENT_KEY);
  let retired = cli(f, ["retire", "dev-declared-only", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  assert.equal(JSON.parse(retired.stdout).workRecovery, undefined, "only declared entries changed (the test's and the retire hook's)");
  assert.equal(identHookRan(quiet.home), true);
  assert.equal(existsSync(recoveryRootOf(quiet.home)), false, "no recovery was written");
  assert.equal(existsSync(quiet.home), false);

  // Control: a hidden entry nobody declared is the instance's work.
  const loud = spawn(f, "undeclared-entry");
  write(join(loud.home, ".other", "x"), "undeclared\n");
  retired = cli(f, ["retire", "dev-undeclared-entry", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const recovery = JSON.parse(retired.stdout).workRecovery;
  assert.deepEqual(recovery.classes, ["changed instance-home bytes"]);
  assert.equal(readFileSync(join(recovery.path, "home", ".other", "x"), "utf8"), "undeclared\n");
  assert.deepEqual(pathsNamed(recoveryRootOf(loud.home), "signing.key"), []);
});

test("the spawn baseline is the only authority for exclusions: a declaration added afterwards to instance.json and to the home's module copy excludes nothing", () => {
  const f = fixture({ capabilities: identCapability({ declare: false }) });
  const spawned = spawnWithNote(f, "late-declare");
  const retirement = { disposable: { home: IDENT_DECLARED } };
  const metaPath = join(spawned.home, "instance.json");
  const meta = readJson(metaPath);
  const runtime = meta.capabilityRuntime.find((cap) => cap.id === "acme.ident");
  assert.ok(runtime, "fixture premise: instance.json records the provider's runtime row");
  runtime.retirement = retirement;
  for (const cap of meta.capabilities || []) if (cap.id === "acme.ident") cap.retirement = retirement;
  meta.retirement = retirement;
  meta.disposableHome = IDENT_DECLARED.map((root) => ({ owner: "acme.ident", root }));
  write(metaPath, JSON.stringify(meta, null, 2) + "\n");
  const modulePath = join(spawned.home, ".oats", "modules", "acme.ident", "oats.json");
  write(modulePath, JSON.stringify({ ...readJson(modulePath), retirement }, null, 2) + "\n");
  const retired = cli(f, ["retire", "dev-late-declare", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const recovery = JSON.parse(retired.stdout).workRecovery;
  assert.equal(readFileSync(join(recovery.path, "home", ".ident", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(recovery.path, "home", ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(recovery.notCopied, undefined);
});

test("an existing home gains no exclusions when its capability starts declaring them: it retires with the home copied whole, an instance spawned afterwards does not", () => {
  const f = fixture({ capabilities: identCapability({ declare: false }) });
  const before = spawnWithNote(f, "before-update");
  const declaring = identCapability()["acme.ident"];
  f.commit(capabilityFiles("acme.ident", declaring.manifest, declaring.files), "acme.ident declares its home state");
  const after = spawnWithNote(f, "after-update");
  assert.deepEqual(readJson(baselineOf(after.home)).disposableHome.map((row) => row.root), [".ident", ".ident-id-*", ".ident-state"], "fixture premise: the update reached a new spawn");

  let retired = cli(f, ["retire", "dev-before-update", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const old = JSON.parse(retired.stdout).workRecovery;
  assert.equal(readFileSync(join(old.path, "home", ".ident", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(old.path, "home", ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(old.path, "home", "notes", "x.md"), "utf8"), "an authored note\n");
  assert.equal(old.notCopied, undefined);
  assert.deepEqual(readdirSync(recoveryRootOf(before.home)), [basename(old.path)], "one directory");

  retired = cli(f, ["retire", "dev-after-update", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const fresh = JSON.parse(retired.stdout).workRecovery;
  assert.deepEqual(pathsNamed(fresh.path, "signing.key"), []);
  assert.deepEqual(fresh.notCopied, IDENT_NOT_COPIED);
  assert.equal(readdirSync(recoveryRootOf(after.home)).length, 2);
});

test("a declared name that is a symlink in the home is left out by its name, and its target is never read or copied", () => {
  const f = fixture({ capabilities: identCapability() });
  const spawned = spawnWithNote(f, "linked");
  const outside = join(f.base, "outside");
  write(join(outside, "outside-secret.txt"), "never copied\n");
  symlinkSync(outside, join(spawned.home, ".ident-id-link"));
  symlinkSync(outside, join(spawned.home, ".plain-link"));
  const retired = cli(f, ["retire", "dev-linked", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const recovery = JSON.parse(retired.stdout).workRecovery;
  assert.deepEqual(recovery.notCopied.map((row) => row.path), [".ident", ".ident-id-link", ".ident-id-wide", ".ident-state"]);
  assert.throws(() => lstatSync(join(recovery.path, "home", ".ident-id-link")), /ENOENT/, "the declared link is not in the copy");
  // Control: an undeclared link is copied, as a link. Neither is followed.
  assert.equal(lstatSync(join(recovery.path, "home", ".plain-link")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(recovery.path, "home", ".plain-link")), outside);
  assert.deepEqual(pathsNamed(recoveryRootOf(spawned.home), "outside-secret.txt"), []);
  assert.equal(readFileSync(join(outside, "outside-secret.txt"), "utf8"), "never copied\n");
});

test("a failed recovery copy refuses before any retire hook runs and keeps the home with its declared entries and its baseline", () => {
  const f = fixture({ capabilities: identCapability() });
  const spawned = spawnWithNote(f, "blocked");
  const baseline = readFileSync(baselineOf(spawned.home), "utf8");
  // The recovery storage is unusable: a file where the directory would be.
  write(recoveryRootOf(spawned.home), "not a directory");
  const retired = cli(f, ["retire", "dev-blocked", "--json"]);
  assert.notEqual(retired.status, 0, `a retire that could not copy must refuse: ${retired.stdout}`);
  assert.equal(identHookRan(spawned.home), false, "no retire hook ran");
  assert.equal(readFileSync(join(spawned.home, ".ident", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(spawned.home, ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(spawned.home, "notes", "x.md"), "utf8"), "an authored note\n");
  assert.equal(readJson(join(spawned.home, "instance.json")).instance, "dev-blocked");
  assert.equal(readFileSync(baselineOf(spawned.home), "utf8"), baseline, "the baseline is untouched");
  assert.equal(readFileSync(recoveryRootOf(spawned.home), "utf8"), "not a directory");
});

test("a recovery that fails verification refuses with E_WORK_PRESERVATION_FAILED, leaves no recovery directory and keeps the home with its declared entries", () => {
  // The status disagreement of the "names the differing status rows" test above.
  const f = fixture({ capabilities: identCapability() });
  const spawned = spawnWithNote(f, "unverified");
  const work = join(spawned.home, "work");
  const names = ["a.txt", "b.txt"];
  for (const n of names) write(join(work, n), `${n}\r\n`);
  execFileSync("git", ["-C", work, "add", ...names]);
  execFileSync("git", ["-C", work, "commit", "-qm", "crlf files"]);
  staleUnderTextAttribute(f.repo, f.base, names.map((n) => join(work, n)));
  write(join(work, "untracked.txt"), "forces a repository recovery\n");
  const retired = cli(f, ["retire", "dev-unverified", "--json"]);
  assert.equal(retired.status, 1, retired.stdout);
  const error = JSON.parse(retired.stdout).error;
  assert.equal(error.code, "E_WORK_PRESERVATION_FAILED");
  assert.match(error.message, /recovered Git index\/status disagreed with the source/);
  assert.deepEqual(readdirSync(recoveryRootOf(spawned.home)), [], "neither a recovery nor its staging is left behind");
  assert.equal(identHookRan(spawned.home), false, "no retire hook ran");
  assert.equal(existsSync(spawned.home), true, "the home is kept");
  assert.equal(readFileSync(join(spawned.home, ".ident", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(readFileSync(join(spawned.home, ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY);
  assert.equal(existsSync(baselineOf(spawned.home)), true);
});

test("without a valid baseline nothing is excluded, although the capability still declares: the baseline missing, of another version, or with a row outside the grammar", () => {
  const cases = {
    missing: (file) => rmSync(file),
    version: (file) => write(file, JSON.stringify({ ...readJson(file), version: 1 }, null, 2) + "\n"),
    // One bad row disqualifies the whole list: no row of it excludes anything.
    grammar: (file) => { const b = readJson(file); write(file, JSON.stringify({ ...b, disposableHome: [...b.disposableHome, { owner: "acme.ident", root: "notes" }] }, null, 2) + "\n"); },
  };
  for (const [name, damage] of Object.entries(cases)) {
    const f = fixture({ capabilities: identCapability() });
    const spawned = spawnWithNote(f, `baseline-${name}`);
    assert.equal(readJson(baselineOf(spawned.home)).disposableHome.length, 3, "fixture premise: the declaration was recorded at spawn");
    assert.deepEqual(readJson(join(spawned.home, ".oats", "modules", "acme.ident", "oats.json")).retirement, { disposable: { home: IDENT_DECLARED } }, "fixture premise: the home's module copy still declares");
    damage(baselineOf(spawned.home));
    const retired = cli(f, ["retire", `dev-baseline-${name}`, "--json"]);
    assert.equal(retired.status, 0, `${name}: ${retired.stderr}\n${retired.stdout}`);
    const recovery = JSON.parse(retired.stdout).workRecovery;
    assert.equal(readFileSync(join(recovery.path, "home", ".ident", "signing.key"), "utf8"), IDENT_KEY, name);
    assert.equal(readFileSync(join(recovery.path, "home", ".ident-id-wide", "signing.key"), "utf8"), IDENT_KEY, name);
    assert.equal(readFileSync(join(recovery.path, "home", "notes", "x.md"), "utf8"), "an authored note\n", name);
    assert.equal(recovery.notCopied, undefined, name);
    assert.equal(Object.hasOwn(readJson(join(recovery.path, "recovery.json")), "notCopied"), false, name);
  }
});

test("the recovery lines are one function for the local and the remote path: a historical receipt with workRecoveries prints a block per entry, a new one prints one block with what was copied, what was not, and the second snapshot", () => {
  const historical = { retired: "dev-1", workRecovery: { path: "/r/dev-1-BBB", classes: ["directory work bytes"], bytes: 2048 }, workRecoveries: [
    { path: "/r/dev-1-AAA", classes: ["changed instance-home bytes", "directory work bytes"], bytes: 1536, outputs: { paths: [{ path: "scratch/", bytes: 1024 }, { path: "note.txt", bytes: 12 }], bytes: 1036 } },
    { path: "/r/dev-1-BBB", classes: ["directory work bytes"], bytes: 2048 },
  ] };
  assert.deepEqual(workRecoveryLines(historical), [
    "Work that was not committed has been preserved: changed instance-home bytes, directory work bytes",
    "  /r/dev-1-AAA (1.5 KiB)",
    "  copied outputs: scratch/ (1.0 KiB), note.txt (12 B) — 1.0 KiB in total",
    "Work that was not committed has been preserved: directory work bytes",
    "  /r/dev-1-BBB (2.0 KiB)",
    "  to inspect, restore or dispose of a recovery: see docs/souls-and-instances.md#after-a-retire-inspect-restore-dispose",
  ]);
  assert.deepEqual(workRecoveryLines(historical, { host: "build.example" }), [
    "Work that was not committed has been preserved on build.example: changed instance-home bytes, directory work bytes",
    "  /r/dev-1-AAA (1.5 KiB)",
    "  copied outputs: scratch/ (1.0 KiB), note.txt (12 B) — 1.0 KiB in total",
    "Work that was not committed has been preserved on build.example: directory work bytes",
    "  /r/dev-1-BBB (2.0 KiB)",
    "  to inspect, restore or dispose of a recovery: see docs/souls-and-instances.md#after-a-retire-inspect-restore-dispose",
  ]);
  const current = { retired: "dev-1", workRecovery: {
    path: "/r/dev-1-CCC", classes: ["changed instance-home bytes", "untracked or ignored worktree bytes"], bytes: 3 * 1024 * 1024,
    home: { paths: [".oats/", "a/", "b/", "c/", "d/", "e/", "f/", "g/", "h.md", "i.md"].map((path, i) => ({ path, bytes: 2048 - i })), bytes: 20435 },
    outputs: { paths: [{ path: "scratch/", bytes: 1024 }], bytes: 1024 },
    notCopied: [{ scope: "home", path: ".aw", owner: "oats.aweb" }, { scope: "home", path: ".ident", owner: "acme.ident" }, { scope: "home", path: ".oats-aweb", owner: "oats.aweb" }],
    afterHooks: { home: true, work: false },
  } };
  const block = (preserved) => [
    preserved,
    "  /r/dev-1-CCC (3.0 MiB)",
    "  copied from the home: .oats/ (2.0 KiB), a/ (2.0 KiB), b/ (2.0 KiB), c/ (2.0 KiB), d/ (2.0 KiB), e/ (2.0 KiB), f/ (2.0 KiB), g/ (2.0 KiB), and 2 more — 20.0 KiB in total",
    "  copied outputs: scratch/ (1.0 KiB) — 1.0 KiB in total",
    "  not copied: .ident (acme.ident); .aw, .oats-aweb (oats.aweb)",
    "  after the retire hooks: home copied again under after-hooks/",
    "  to inspect, restore or dispose of a recovery: see docs/souls-and-instances.md#after-a-retire-inspect-restore-dispose",
  ];
  assert.deepEqual(workRecoveryLines(current), block("Work that was not committed has been preserved: changed instance-home bytes, untracked or ignored worktree bytes"));
  assert.deepEqual(workRecoveryLines(current, { host: "build.example" }), block("Work that was not committed has been preserved on build.example: changed instance-home bytes, untracked or ignored worktree bytes"));
  const variant = (afterHooks) => workRecoveryLines({ workRecovery: { path: "/r/x", classes: ["directory work bytes"], afterHooks } }).at(-2);
  assert.equal(variant({ home: false, work: true }), "  after the retire hooks: work copied again under after-hooks/");
  assert.equal(variant({ home: true, work: true }), "  after the retire hooks: home and work copied again under after-hooks/");
  assert.equal(variant(undefined), "  /r/x");
  assert.deepEqual(workRecoveryLines({ retired: "dev-1" }), [], "nothing preserved, nothing said");
});

test("the retire plan says where a recovery would be written and what is declared as not copied, per work mode, without changing the plan revision", () => {
  const notes = (f, instance) => { const r = cli(f, ["retire", instance, "--plan", "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout).result; };
  const recoveryNotes = (plan) => plan.notes.filter((n) => n.startsWith("recovery: "));
  const worktree = fixture({ capabilities: identCapability() });
  const a = spawn(worktree, "plan");
  const planned = notes(worktree, "dev-plan");
  assert.deepEqual(recoveryNotes(planned), [
    `recovery: the home is copied to ${recoveryRootOf(a.home)} before the home is removed, when it changed since spawn; not copied: .ident, .ident-id-*, .ident-state (acme.ident)`,
    "recovery: uncommitted worktree state is copied there too",
  ]);
  // Read from the baseline, never from the home: a changed baseline changes the note and the plan's revision (#1065).
  const baseline = readJson(baselineOf(a.home));
  write(baselineOf(a.home), JSON.stringify({ ...baseline, disposableHome: [{ owner: "acme.ident", root: ".ident" }] }, null, 2) + "\n");
  const narrowed = notes(worktree, "dev-plan");
  assert.equal(recoveryNotes(narrowed)[0], `recovery: the home is copied to ${recoveryRootOf(a.home)} before the home is removed, when it changed since spawn; not copied: .ident (acme.ident)`);
  assert.notEqual(narrowed.planRevision, planned.planRevision, "a changed baseline changes the note and the revision");
  // One note lists at most 16 declared roots, in the baseline's order, then counts the rest.
  const many = Array.from({ length: 17 }, (_, i) => `.r${String(i).padStart(2, "0")}`);
  write(baselineOf(a.home), JSON.stringify({ ...baseline, disposableHome: many.map((root) => ({ owner: "acme.ident", root })) }, null, 2) + "\n");
  assert.equal(recoveryNotes(notes(worktree, "dev-plan"))[0], `recovery: the home is copied to ${recoveryRootOf(a.home)} before the home is removed, when it changed since spawn; not copied: ${many.slice(0, 16).join(", ")} (acme.ident), and 1 more`);
  assert.equal(existsSync(recoveryRootOf(a.home)), false, "a plan writes nothing");

  const directory = fixture({ work: "directory", capabilities: hookCapability(RETIRE_WRITES_NOTHING) });
  const b = spawn(directory, "plan");
  assert.deepEqual(recoveryNotes(notes(directory, "dev-plan")), [
    `recovery: the home is copied to ${recoveryRootOf(b.home)} before the home is removed, when it changed since spawn`,
    "recovery: work/ is copied there when it is not empty",
  ]);
});

// awebai/oats#648: a worktree whose top level is not <home>/work is refused before its status is trusted.
const RETIRE_MARKS_RAN = "import {writeFileSync} from 'node:fs'; import {basename, dirname, join} from 'node:path'; writeFileSync(join(dirname(process.env.OATS_HOME), `retire-hook-ran-${basename(process.env.OATS_HOME)}`), 'ran\\n'); console.log(JSON.stringify({meta:{retired:true}}));\n";
const retireHookRan = (home) => existsSync(join(dirname(home), `retire-hook-ran-${basename(home)}`));
const registeredWorktrees = (repo) => execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
/** Point work/'s per-worktree core.worktree at another directory, as an agent could. */
function redirectWorktree(f, work) {
  const elsewhere = join(f.base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  execFileSync("git", ["-C", work, "config", "extensions.worktreeConfig", "true"]);
  execFileSync("git", ["-C", work, "config", "--worktree", "core.worktree", elsewhere]);
  return elsewhere;
}

test("#648 a worktree whose core.worktree names another directory is refused by the first inspection: nothing was stopped, run or removed, and the error names both directories", () => {
  const f = fixture({ capabilities: hookCapability(RETIRE_MARKS_RAN) });
  const spawned = spawn(f, "elsewhere");
  const work = join(spawned.home, "work");
  write(join(work, "wip.txt"), "uncommitted work the other directory's status does not show\n");
  const elsewhere = redirectWorktree(f, work);
  for (const flags of [[], ["--discard-worktree"], ["--force"]]) {
    const retired = cli(f, ["retire", "dev-elsewhere", ...flags, "--json"]);
    assert.notEqual(retired.status, 0, retired.stdout);
    const { error } = JSON.parse(retired.stdout);
    assert.equal(error.code, "E_WORK_INSPECTION_FAILED", retired.stdout);
    assert.ok(error.message.includes(work) && error.message.includes(realpathSync(elsewhere)), error.message);
    assert.match(error.message, /Nothing was stopped, run or removed\.$/);
  }
  assert.equal(retireHookRan(spawned.home), false, "no retire hook ran");
  assert.equal(readFileSync(join(work, "wip.txt"), "utf8"), "uncommitted work the other directory's status does not show\n");
  assert.equal(existsSync(join(spawned.home, "instance.json")), true, "the home is kept");
  assert.ok(registeredWorktrees(f.repo).includes(realpathSync(work)), "the worktree is still registered");
  assert.equal(existsSync(recoveryRootOf(spawned.home)) && readdirSync(recoveryRootOf(spawned.home)).length > 0, false, "no recovery was written");
});

test("#648 a retire hook that points core.worktree at another directory is refused by the inspection after the hooks: the home, the work and the pre-hook recovery are kept", () => {
  const hook = `import { execFileSync } from 'node:child_process'; import { mkdirSync } from 'node:fs'; import { join } from 'node:path';
const work = join(process.env.OATS_INSTANCE_HOME, 'work'), elsewhere = join(process.env.OATS_INSTANCE_HOME, '..', 'elsewhere-after-hooks');
mkdirSync(elsewhere, { recursive: true });
execFileSync('git', ['-C', work, 'config', 'extensions.worktreeConfig', 'true']);
execFileSync('git', ['-C', work, 'config', '--worktree', 'core.worktree', elsewhere]);
console.log(JSON.stringify({ meta: { retired: true } }));
`;
  const f = fixture({ capabilities: hookCapability(hook) });
  const spawned = spawn(f, "late-elsewhere");
  const work = join(spawned.home, "work");
  write(join(work, "wip.txt"), "uncommitted\n");
  const retired = cli(f, ["retire", "dev-late-elsewhere", "--json"]);
  assert.notEqual(retired.status, 0, retired.stdout);
  const { error } = JSON.parse(retired.stdout);
  assert.equal(error.code, "E_WORK_INSPECTION_FAILED", retired.stdout);
  assert.ok(error.message.includes(work), error.message);
  assert.ok(error.message.endsWith("The retire hooks have run; the home, its work and the pre-hook recovery (if any) are kept; this retire stopped no session."), error.message);
  assert.equal(readFileSync(join(work, "wip.txt"), "utf8"), "uncommitted\n");
  assert.equal(existsSync(join(spawned.home, "instance.json")), true, "the home is kept");
  assert.ok(registeredWorktrees(f.repo).includes(realpathSync(work)), "the worktree is still registered");
});

test("#648 a work/ reached through a symbolic link is the same directory: the retire goes on", () => {
  const f = fixture();
  const spawned = spawn(f, "linked");
  write(join(spawned.home, "work", "wip.txt"), "uncommitted\n");
  // The deployment through a link: the home, and so work/, are spelled through it, while Git reports the real path.
  const link = join(f.base, "deployment-link");
  symlinkSync(f.dep, link);
  const retired = spawnSync(process.execPath, [CLI, "retire", "dev-linked", "--home", join(link, relative(f.dep, spawned.home)), "--json", "--dir", link], { cwd: link, encoding: "utf8", env: f.env });
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const r = JSON.parse(retired.stdout);
  assert.equal(r.retention.worktree, "retained");
  assert.equal(readFileSync(join(r.retention.movedTo, "wip.txt"), "utf8"), "uncommitted\n");
  assert.equal(existsSync(spawned.home), false);
});

// awebai/oats#662: the operator's repository-local Git variables do not redirect what the retire reads.
for (const variable of ["GIT_INDEX_FILE", "GIT_DIR"]) {
  test(`an inherited ${variable} does not redirect the retire's reads: a clean worktree retires with no recovery`, () => {
    const f = fixture();
    const spawned = spawn(f, `env-${variable.toLowerCase().replace(/_/g, "-")}`);
    const foreign = join(f.base, "foreign");
    execFileSync("git", ["init", "-q", foreign]);
    f.env[variable] = variable === "GIT_DIR" ? join(foreign, ".git") : join(f.base, "foreign-index");
    const retired = cli(f, ["retire", spawned.instance, "--json"]);
    assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
    const r = JSON.parse(retired.stdout);
    assert.equal(r.workRecovery, undefined, JSON.stringify(r.workRecovery));
    assert.equal(r.retention.worktree, "retained");
    assert.equal(existsSync(spawned.home), false);
  });
}

test("#662 the retire's status reads leave the inspected index as it was: a file whose stat changed, not its bytes, is not refreshed into the index", () => {
  const f = fixture();
  const spawned = spawn(f, "stat");
  const work = join(spawned.home, "work");
  const index = join(execFileSync("git", ["-C", work, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(), "index");
  // Git would refresh this entry's cached stat data, and so rewrite the index, on a status with optional locks.
  const past = new Date("2020-01-01T00:00:00Z");
  utimesSync(join(work, "tracked.txt"), past, past);
  const before = readFileSync(index);
  const retired = cli(f, ["retire", "dev-stat", "--json"]);
  assert.equal(retired.status, 0, `${retired.stderr}\n${retired.stdout}`);
  const r = JSON.parse(retired.stdout);
  assert.equal(r.workRecovery, undefined);
  // The worktree was re-homed; its admin directory, and so its index, did not move.
  assert.ok(readFileSync(index).equals(before), "the index bytes are unchanged");
});

test("#679 --discard-worktree that Git refuses (a locked worktree) is a refusal: the worktree is there and registered, the home is kept, --force included", () => {
  const f = fixture();
  const spawned = spawn(f, "locked-work");
  const work = join(spawned.home, "work");
  execFileSync("git", ["-C", f.repo, "worktree", "lock", "--reason", "in use", work]);
  for (const flags of [["--discard-worktree"], ["--discard-worktree", "--force"]]) {
    const retired = cli(f, ["retire", "dev-locked-work", ...flags, "--json"]);
    assert.notEqual(retired.status, 0, retired.stdout);
    const { error } = JSON.parse(retired.stdout);
    assert.equal(error.code, "E_WORK_PRESERVATION_FAILED", retired.stdout);
    assert.ok(error.message.includes(`the worktree at ${work} could not be removed, or its removal could not be verified`), error.message);
    assert.match(error.message, /The retire hooks have run; the home is kept/);
    assert.equal(existsSync(join(work, "tracked.txt")), true, "the worktree is there");
    assert.ok(registeredWorktrees(f.repo).includes(realpathSync(work)), "and registered");
    assert.equal(existsSync(join(spawned.home, "instance.json")), true, "the home is kept");
  }
});

// Exercise a missing-object read only where the shared no-lazy-fetch floor admits a partial clone.
const [gitMajor, gitMinor] = (/(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" })) || []).slice(1).map(Number);
const gitHasNoLazyFetch = gitMajor > NO_LAZY_FETCH_GIT[0] || (gitMajor === NO_LAZY_FETCH_GIT[0] && gitMinor >= NO_LAZY_FETCH_GIT[1]);
test("#662 a retire's read of an object the repository lacks never fetches it: a promisor remote that the work's own configuration names does not run, and the copy refuses", { skip: !gitHasNoLazyFetch && `Git before ${NO_LAZY_FETCH_GIT.join(".")} refuses partial-clone reads` }, () => {
  const f = fixture();
  const spawned = spawn(f, "lazy");
  const work = join(spawned.home, "work");
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  write(join(work, "staged.txt"), "staged content no commit has\n");
  git("add", "staged.txt");
  const oid = git("rev-parse", ":staged.txt");
  rmSync(join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "objects", oid.slice(0, 2), oid.slice(2)));
  const marker = join(f.base, "remote-helper-ran");
  const helper = join(f.base, "remote-helper");
  write(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, 0o755);
  git("config", "remote.attack.url", `ext::${helper}`);
  git("config", "remote.attack.promisor", "true");
  git("config", "protocol.ext.allow", "always");
  const retired = cli(f, ["retire", "dev-lazy", "--json"]);
  assert.notEqual(retired.status, 0, retired.stdout);
  const { error } = JSON.parse(retired.stdout);
  assert.equal(error.code, "E_WORK_PRESERVATION_FAILED", retired.stdout);
  assert.ok(error.message.includes(oid), `the refusal names the object the copy lacks: ${error.message}`);
  assert.equal(existsSync(marker), false, "no command the repository's configuration names for a fetch was run");
  assert.equal(existsSync(join(spawned.home, "instance.json")), true, "the home is kept");
});

// ---- #658: the plan's notes fit what the Desktop reads (at most 64, each at most 4096 characters) ----

/** `target`, a directory under `base`, spelled as a path of exactly `length` characters: through
 *  symbolic links in `base` that each lead back to `base`, so nothing deeper exists on disk. */
function spelledAt(base, target, length) {
  const rest = target.slice(base.length + 1);
  let need = length - base.length - 1 - rest.length; // characters of "<link>/" segments
  assert.ok(need === 0 || need >= 2, `fixture premise: ${length} characters can be spelled`);
  const links = [];
  while (need > 0) {
    const segment = need > 251 ? (need - 251 < 2 ? 249 : 251) : need;
    const name = "l".repeat(segment - 1);
    try { lstatSync(join(base, name)); } catch { symlinkSync(".", join(base, name)); }
    links.push(name);
    need -= segment;
  }
  const spelled = [base, ...links, rest].join("/");
  assert.equal(spelled.length, length);
  assert.equal(realpathSync(spelled), target, "fixture premise: the spelling leads to the target");
  return spelled;
}
/** A retire plan as the CLI answers it, the deployment addressed by `dir`. */
function planAt(f, instance, dir = f.dep) {
  const r = spawnSync(process.execPath, [CLI, "retire", instance, "--plan", "--json", "--dir", dir], { cwd: f.dep, encoding: "utf8", env: f.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const plan = JSON.parse(r.stdout).result;
  assert.ok(plan.notes.length <= 64, `at most 64 notes: ${plan.notes.length}`);
  for (const note of plan.notes) assert.ok(note.length <= 4096, `a note of ${note.length} characters: ${note.slice(0, 200)}…`);
  return plan;
}
const homeRecoveryNote = (plan) => plan.notes.find((n) => n.startsWith("recovery: the home"));

test("the retire plan's recovery note fits 4096 characters: declared roots are listed within a budget and counted past it, and a root too long to list is counted", () => {
  const f = fixture({ capabilities: identCapability() });
  const a = spawn(f, "bounded");
  const baseline = readJson(baselineOf(a.home));
  const declare = (roots) => write(baselineOf(a.home), JSON.stringify({ ...baseline, disposableHome: roots.map((root) => ({ owner: "acme.ident", root })) }, null, 2) + "\n");
  const head = `recovery: the home is copied to ${recoveryRootOf(a.home)} before the home is removed, when it changed since spawn`;
  // No declared root: nothing is said about what is not copied.
  declare([]);
  assert.equal(homeRecoveryNote(planAt(f, "dev-bounded")), head);
  // 16 roots of 302 characters: three fit the list's 1024 characters, the other 13 are counted.
  const long = Array.from({ length: 16 }, (_, i) => `.r${String(i).padStart(2, "0")}${"x".repeat(298)}`);
  declare(long);
  const listed = `${long.slice(0, 3).join(", ")} (acme.ident), and 13 more`;
  assert.ok(listed.length <= 1024 && `${long.slice(0, 4).join(", ")} (acme.ident), and 12 more`.length > 1024, "fixture premise: three fit the budget, four do not");
  assert.equal(homeRecoveryNote(planAt(f, "dev-bounded")), `${head}; not copied: ${listed}`);
  // A root longer than the budget: not even one fits, so the roots are counted.
  declare([`.h${"x".repeat(1100)}`]);
  assert.equal(homeRecoveryNote(planAt(f, "dev-bounded")), `${head}; not copied: 1 declared root, too long to list here`);
  declare([`.h${"x".repeat(1100)}`, ".i"]);
  assert.equal(homeRecoveryNote(planAt(f, "dev-bounded")), `${head}; not copied: 2 declared roots, too long to list here`);
});

test("the retire plan's recovery note keeps a long recovery path whole while it fits 4096 characters, shortening the list first, and names where to find a path that does not fit", (t) => {
  // The deployment spelled through links in its parent: the plan names the recovery by that spelling.
  // The three roots acme.ident declares are listed as ".ident, .ident-id-*, .ident-state (acme.ident)".
  const f = fixture({ capabilities: identCapability() });
  const a = spawn(f, "deep");
  const instances = "/agents/dev/instances";
  const recoveryAt = (dep) => `${dep}${instances}/.oats-retirement/recovery`;
  const headAt = (dep) => `recovery: the home is copied to ${recoveryAt(dep)} before the home is removed, when it changed since spawn`;
  const all = "; not copied: .ident, .ident-id-*, .ident-state (acme.ident)";
  // The longest path the plan opens: the home's instance.json, under the deployment spelled for the longest note.
  const skip = pathLimitSkip(4096 - headAt("").length + 1 + `${instances}/dev-deep/instance.json`.length, f.base);
  if (skip) { t.skip(skip); return; }
  // A note of exactly 4096 characters: the path and every root.
  const exact = 4096 - headAt("").length - all.length;
  let dep = spelledAt(f.base, f.dep, exact);
  assert.equal(`${headAt(dep)}${all}`.length, 4096, "fixture premise: the whole note is 4096 characters");
  assert.equal(homeRecoveryNote(planAt(f, "dev-deep", dep)), `${headAt(dep)}${all}`);
  // One character more: the path stays whole and the list gives way.
  dep = spelledAt(f.base, f.dep, exact + 1);
  assert.equal(homeRecoveryNote(planAt(f, "dev-deep", dep)), `${headAt(dep)}; not copied: .ident, .ident-id-* (acme.ident), and 1 more`);
  // A recovery path whose note alone is past 4096 characters (about 4010): never cut, but named by where it is.
  dep = spelledAt(f.base, f.dep, 4096 - headAt("").length + 1);
  assert.ok(headAt(dep).length > 4096, "fixture premise: the path alone is too long for the note");
  const plan = planAt(f, "dev-deep", dep);
  assert.equal(homeRecoveryNote(plan), `recovery: the home is copied to the recovery directory beside the home before the home is removed, when it changed since spawn (its path is too long for this note: the retire receipt names it as workRecovery.path, and the retire summary prints it)${all}`);
  assert.equal(plan.notes.some((n) => n.includes(recoveryAt(dep).slice(-200))), false, "no note holds a cut piece of the path");
  assert.equal(existsSync(recoveryRootOf(a.home)), false, "a plan writes nothing");
});

// ---- #659: refusals after the retire hooks, and a staging directory that is read-only ----


/** A read-only (0555) directory with a file in it, under the ignored cache/ of `work`, as a Go
 *  module cache is: a recovery copies it with that mode. → a function that makes it writable again,
 *  so that the fixture can be removed. */
function readOnlyCache(work) {
  const dir = join(work, "cache", "modules");
  write(join(dir, "mod.txt"), "module bytes\n");
  chmodSync(dir, 0o555);
  return () => { try { chmodSync(dir, 0o755); } catch { /* gone with the work */ } };
}
/** Entries of a recovery root that are not complete recoveries: staging directories (dot-names). */
const stagingLeft = (home) => (existsSync(recoveryRootOf(home)) ? readdirSync(recoveryRootOf(home)).filter((name) => name.startsWith(".")) : []);

test("a copy that fails verification with a read-only directory in the work refuses with its own cause, not EACCES, and leaves no staging behind: before the hooks and after them", () => {
  // The fixture's own cleanup runs before a test's after hooks: modes are restored in `finally`.
  const restore = [];
  try {
  // Before the hooks: a tracked file whose status the source repository's attributes make ` M`, which
  // the recovery does not reproduce (see the E_WORK_PRESERVATION_FAILED status-row test above).
  const f = fixture();
  const spawned = spawn(f, "readonly");
  const work = join(spawned.home, "work");
  write(join(work, "crlf.txt"), "line\r\n");
  execFileSync("git", ["-C", work, "add", "crlf.txt"]);
  execFileSync("git", ["-C", work, "commit", "-qm", "crlf"]);
  restore.push(readOnlyCache(work));
  staleUnderTextAttribute(f.repo, f.base, [join(work, "crlf.txt")]);
  const retired = cli(f, ["retire", "dev-readonly", "--json"]);
  assert.equal(retired.status, 1, retired.stdout + retired.stderr);
  const error = JSON.parse(retired.stdout).error;
  assert.equal(error.code, "E_WORK_PRESERVATION_FAILED", error.message);
  assert.match(error.message, new RegExp(String.raw`recovered Git index\/status disagreed with the source: crlf\.txt \(source  M, recovery absent\)${refusedBeforeHooks("dev-readonly")}`));
  assert.doesNotMatch(error.message, /EACCES|permission denied/i);
  assert.deepEqual(stagingLeft(spawned.home), [], "the staging directory, read-only directory and all, is removed");
  assert.deepEqual(readdirSync(recoveryRootOf(spawned.home)), [], "and no recovery is written");
  assert.equal(existsSync(join(work, "cache", "modules", "mod.txt")), true, "the work is kept");

  // After the hooks: nothing to preserve before them; the retire hook makes the same disagreement
  // (it makes the file's stat stale under attributes set before) and the read-only directory, so
  // the one recovery is written after the hooks, and fails there.
  const g = fixture({ capabilities: hookCapability(`import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const work = join(process.env.OATS_INSTANCE_HOME, 'work');
utimesSync(join(work, 'crlf.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
mkdirSync(join(work, 'cache', 'modules'), { recursive: true });
writeFileSync(join(work, 'cache', 'modules', 'mod.txt'), 'module bytes\\n');
chmodSync(join(work, 'cache', 'modules'), 0o555);
console.log(JSON.stringify({ meta: { retired: true } }));
`) });
  const late = spawn(g, "readonly-late");
  const lateWork = join(late.home, "work");
  write(join(lateWork, "crlf.txt"), "line\r\n");
  // An older stat than the index's, so Git does not re-read the file (racily clean) before the hook.
  utimesSync(join(lateWork, "crlf.txt"), new Date(2019, 0, 1), new Date(2019, 0, 1));
  execFileSync("git", ["-C", lateWork, "add", "crlf.txt"]);
  execFileSync("git", ["-C", lateWork, "commit", "-qm", "crlf"]);
  const attributes = join(g.base, "attributes-late");
  write(attributes, "*.txt text\n");
  execFileSync("git", ["-C", g.repo, "config", "core.attributesFile", attributes]);
  assert.equal(execFileSync("git", ["-C", lateWork, "status", "--porcelain"], { encoding: "utf8" }), "", "fixture premise: nothing to preserve before the hooks");
  restore.push(() => { try { chmodSync(join(lateWork, "cache", "modules"), 0o755); } catch { /* not made */ } });
  const lateRetired = cli(g, ["retire", "dev-readonly-late", "--json"]);
  assert.equal(lateRetired.status, 1, lateRetired.stdout + lateRetired.stderr);
  const lateError = JSON.parse(lateRetired.stdout).error;
  assert.equal(lateError.code, "E_WORK_PRESERVATION_FAILED", lateError.message);
  assert.match(lateError.message, new RegExp(String.raw`recovered Git index\/status disagreed with the source: crlf\.txt \(source  M, recovery absent\)${REFUSED_AFTER_HOOKS}`));
  assert.doesNotMatch(lateError.message, /EACCES|permission denied/i);
  assert.deepEqual(readdirSync(recoveryRootOf(late.home)), [], "no staging and no recovery is left");
  assert.equal(existsSync(join(late.home, "instance.json")), true, "the home is kept");
  } finally { for (const undo of restore) undo(); }
});

test("#827 a copy that fails verification with a read-only directory whose name is not UTF-8 refuses with its own cause and leaves no staging behind", (t) => {
  // The copier carries names as bytes (#825); the clean-up reaches the directory by the same bytes,
  // or it is not made writable and the staging is left.
  if (process.getuid?.() === 0) {
    t.skip("root unlinks inside a directory of mode 0555, so the case cannot be built");
    return;
  }
  const f = fixture();
  const spawned = spawn(f, "readonly-name");
  const work = join(spawned.home, "work");
  write(join(work, "crlf.txt"), "line\r\n");
  fixtureGit(work, ["add", "crlf.txt"]);
  fixtureGit(work, ["commit", "-qm", "crlf"]);
  const cache = join(work, "cache");
  mkdirSync(cache, { recursive: true });
  const dir = under(cache, withByte("modules-", 0x80));
  if (!storedBytes(t, () => mkdirSync(dir), () => namesStartingWith(cache, "modules-"), withByte("modules-", 0x80).toString("hex"))) return;
  writeFileSync(under(dir, "mod.txt"), "module bytes\n");
  chmodSync(dir, 0o555);
  try {
    staleUnderTextAttribute(f.repo, f.base, [join(work, "crlf.txt")]);
    const retired = cli(f, ["retire", "dev-readonly-name", "--json"]);
    assert.equal(retired.status, 1, retired.stdout + retired.stderr);
    const error = JSON.parse(retired.stdout).error;
    assert.equal(error.code, "E_WORK_PRESERVATION_FAILED", error.message);
    assert.match(error.message, new RegExp(String.raw`recovered Git index\/status disagreed with the source: crlf\.txt \(source  M, recovery absent\)${refusedBeforeHooks("dev-readonly-name")}`));
    assert.doesNotMatch(error.message, /could not be removed/, "the refusal names no partial copy");
    assert.deepEqual(stagingLeft(spawned.home), [], "the staging directory, read-only directory and all, is removed");
    assert.deepEqual(readdirSync(recoveryRootOf(spawned.home)), [], "and no recovery is written");
    assert.equal(readFileSync(under(dir, "mod.txt"), "utf8"), "module bytes\n", "the work is kept");
  } finally { try { chmodSync(dir, 0o755); } catch { /* gone with the work */ } }
});

test("a recovery the retire hooks keep from being completed refuses saying the hooks have run and what is kept, like a refusal before them", () => {
  // The hook writes the home, so the post-hook pass has a part to add, and occupies the name that part
  // needs inside the recovery written before the hooks.
  const f = fixture({ capabilities: hookCapability(`import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const home = process.env.OATS_INSTANCE_HOME;
writeFileSync(join(home, 'hook-note.txt'), 'written by the retire hook');
const root = join(dirname(home), '.oats-retirement', 'recovery');
for (const name of readdirSync(root)) writeFileSync(join(root, name, 'after-hooks'), 'in the way');
console.log(JSON.stringify({ meta: { retired: true } }));
`) });
  const spawned = spawn(f, "blocked");
  write(join(spawned.home, "work", "human.txt"), "human bytes\n");
  const retired = cli(f, ["retire", "dev-blocked", "--json"]);
  assert.equal(retired.status, 1, retired.stdout + retired.stderr);
  const error = JSON.parse(retired.stdout).error;
  assert.equal(error.code, "E_WORK_PRESERVATION_FAILED");
  assert.match(error.message, new RegExp(String.raw`^retirement work remains at .*; recovery could not be verified: .*after-hooks already exists${REFUSED_AFTER_HOOKS}`));
  const [recovery] = readdirSync(recoveryRootOf(spawned.home));
  assert.equal(readFileSync(join(recoveryRootOf(spawned.home), recovery, "repo", "human.txt"), "utf8"), "human bytes\n", "the pre-hook recovery is kept");
  assert.equal(readJson(join(recoveryRootOf(spawned.home), recovery, "recovery.json")).phase, "before-hooks");
  assert.equal(readFileSync(join(spawned.home, "work", "human.txt"), "utf8"), "human bytes\n", "the home and its work are kept");
});

test("the retire plan's drift note fits 4096 characters with two long branch names, and the Desktop's own reader accepts the plan", (t) => {
  const f = fixture();
  const a = spawn(f, "drift");
  const work = join(a.home, "work");
  // Two valid branch names of 2291 characters each (12 components of 190): each fits its own field, not both one note.
  const long = (c) => Array.from({ length: 12 }, (_, i) => `${c}${i}`.padEnd(190, c)).join("/");
  // Git writes the branch as refs/heads/<name>.lock: a path that macOS does not open.
  const skip = pathLimitSkip(join(f.repo, ".git", "refs", "heads", `${long("a")}.lock`).length, f.base);
  if (skip) { t.skip(skip); return; }
  execFileSync("git", ["-C", work, "switch", "--quiet", "-c", long("a")]);
  const metaPath = join(a.home, "instance.json");
  write(metaPath, JSON.stringify({ ...readJson(metaPath), branch: long("b") }, null, 2) + "\n");
  const plan = planAt(f, "dev-drift");
  assert.equal(plan.facts.work.branch, long("a"));
  assert.equal(plan.facts.recordedBranch, long("b"));
  assert.deepEqual(plan.notes.filter((n) => n.startsWith("the worktree is")), [`the worktree is on the branch facts.work.branch in the plan JSON names, not the recorded ${long("b")}`],
    "the longer part gives way to a pointer, the other stays whole");
  assert.ok(lifecyclePlan(plan, { instance: plan.instance, home: plan.home }, "retire", {}), "the Desktop reads the plan");
});
