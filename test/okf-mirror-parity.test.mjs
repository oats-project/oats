import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import {
  REPO_ROOT, CAPABILITY_PATH, CAPABILITY_PATHS, INVENTORY_PATH, MIRROR_PATHS, checkOkfMirror, checkOkfPayload,
  distributionEntries, finalizeOkfMirror, generateOkfSourceInventory, materializeOkfGitPayload, mirrorPath, payloadEntries,
  syncOkfMirror, verifyOkfSource,
} from "../scripts/check-okf-mirror.mjs";

const CHECKER = join(REPO_ROOT, "scripts/check-okf-mirror.mjs");
// Where a framework root keeps the oats.okf mirror (mirrors/oats-okf); inventory
// entries and a distribution root keep the package-relative CAPABILITY_PATH.
const MIRROR = mirrorPath(CAPABILITY_PATH);
const mirrorEntries = (root) => distributionEntries(root, { mirror: true });
// okf 4.0.0 ships no symlink; the symlink rules get a fixture alias beside a real file.
const ALIAS = "lib/alias.mjs";
const FILE = "lib/config.mjs";
const SOUL_FILE = "souls/knowledge-harvester/soul.yaml";
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function temp(t) {
  // Keep all test writes under this checkout; no live OATS config, kernel,
  // scheduler, harness or network is involved in mirror verification.
  mkdirSync(join(REPO_ROOT, ".agents"), { recursive: true });
  const base = mkdtempSync(join(REPO_ROOT, ".agents/okf-mirror-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function copyMirror(base) {
  const root = join(base, "framework");
  for (const cap of MIRROR_PATHS) cpSync(join(REPO_ROOT, cap), join(root, cap), { recursive: true, verbatimSymlinks: true });
  write(join(root, INVENTORY_PATH), readFileSync(join(REPO_ROOT, INVENTORY_PATH)));
  return root;
}
function isolatedEnv(base) {
  const env = Object.fromEntries(["PATH", "SystemRoot", "PATHEXT", "TMPDIR", "TEMP", "TMP"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    HOME: join(base, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
    GIT_AUTHOR_NAME: "Mirror test", GIT_AUTHOR_EMAIL: "mirror@example.invalid",
    GIT_COMMITTER_NAME: "Mirror test", GIT_COMMITTER_EMAIL: "mirror@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  mkdirSync(env.HOME, { recursive: true });
  return env;
}
function command(command, args, cwd, env) {
  const run = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.error || ""}\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
}
function standaloneFixture(base) {
  const root = join(base, "standalone");
  materializeOkfGitPayload(join(root, "oats-package"));
  // These obsolete/unexported copies must NEVER be inventoried or mirrored.
  write(join(root, "bin/oats-okf.mjs"), "throw new Error('not exported');\n");
  write(join(root, "oats-package/bin/obsolete.mjs"), "throw new Error('stale root copy');\n");
  const env = isolatedEnv(base);
  const git = (...args) => command("git", ["-c", "core.hooksPath=" + devNull, "-c", "commit.gpgsign=false", ...args], root, env);
  git("init", "--quiet", "--initial-branch=fixture");
  git("add", ".");
  git("commit", "--quiet", "-m", "Isolated source fixture");
  return { root, env, git };
}

/** A mirror whose standalone ships a symlink. 3.0.0 and 4.0.0 ship none (npm drops them); 2.x shipped
 *  a CLAUDE.md -> AGENTS.md alias. A fixture alias gives the symlink rules a real subject. */
function copyMirrorWithAlias(base) {
  const fixture = standaloneFixture(base);
  symlinkSync("config.mjs", join(fixture.root, "oats-package", CAPABILITY_PATH, ALIAS));
  const root = copyMirror(base);
  syncOkfMirror(fixture.root, { repoRoot: root });
  assert.ok(lstatSync(join(root, MIRROR, ALIAS)).isSymbolicLink());
  return root;
}
function publishFixture(base, fixture, { annotated = true, publish = true } = {}) {
  const repository = join(base, "origin.git");
  fixture.git("init", "--quiet", "--bare", repository);
  fixture.git("remote", "add", "origin", repository);
  const finalCommit = fixture.git("rev-parse", "HEAD").trim();
  const finalTag = `v${checkOkfMirror().version}`;
  fixture.git("-c", "tag.gpgsign=false", "tag", ...(annotated ? ["-a", "-m", "Fixture release"] : []), finalTag, finalCommit);
  if (publish) fixture.git("push", "--quiet", "origin", `refs/tags/${finalTag}`);
  return { repository, finalTag, finalCommit };
}
function assertMirrorUnchanged(root, run, pattern) {
  const before = readFileSync(join(root, INVENTORY_PATH));
  const payloadBefore = mirrorEntries(root);
  assert.throws(run, pattern);
  assert.deepEqual(readFileSync(join(root, INVENTORY_PATH)), before, "failed finalization must not stamp inventory");
  assert.deepEqual(mirrorEntries(root), payloadBefore, "failed finalization must not touch mirror");
}

test("checked-in mirror is a complete standalone inventory with consistent pending or published provenance", () => {
  const inventory = checkOkfMirror();
  assert.equal(inventory.version, "6.0.2");
  assert.equal(inventory.source.repository, "https://github.com/awebai/oats-okf.git");
  assert.equal(inventory.release.plannedTag, `v${inventory.version}`);
  if (inventory.release.status === "pending") {
    assert.equal(inventory.release.published, false);
    assert.equal(inventory.release.finalMergedCommit, null);
    assert.equal(inventory.release.finalTag, null);
  } else {
    assert.equal(inventory.release.status, "published");
    assert.equal(inventory.release.published, true);
    assert.equal(inventory.release.finalMergedCommit, inventory.source.head);
    assert.equal(inventory.release.finalTag, `v${inventory.version}`);
    assert.equal(inventory.source.dirty, false);
  }
  assert.ok(inventory.entries.some((entry) => entry.path === `${CAPABILITY_PATH}/lib/inspection.mjs`));
  assert.ok(!inventory.entries.some((entry) => entry.path.endsWith("/lib/harvest-branch.mjs")));
  for (const cap of CAPABILITY_PATHS) assert.ok(inventory.entries.some((entry) => entry.path === `${cap}/oats.json`), `${cap} is mirrored`);
  assert.deepEqual(JSON.parse(inventory.distributionManifestText).capabilities, CAPABILITY_PATHS);
  // This repository keeps the mirror outside capabilities/, where member discovery would list it as its own.
  assert.deepEqual(inventory.mirrorPaths, ["mirrors/oats-okf", "mirrors/oats-okf-harvest", "mirrors/oats-okf-maintenance"]);
  for (const cap of CAPABILITY_PATHS) assert.ok(!existsSync(join(REPO_ROOT, cap)), `no mirror at ${cap}: it would be discovered as a member capability of this repository`);
  // 4.0.0's package souls and trigger are recorded as exact text, never mirrored into this repository's souls/.
  assert.deepEqual(inventory.distributionFiles.map((file) => file.path), ["souls/knowledge-harvester/AGENTS.md", SOUL_FILE, "souls/knowledge-maintainer/AGENTS.md", "souls/knowledge-maintainer/soul.yaml", "triggers/harvest-review.json", "triggers/proposal-review.json"]);
  assert.ok(!existsSync(join(REPO_ROOT, "souls/knowledge-harvester")), "no package soul in this repository's own souls/");
  assert.match(inventory.distributionLicenseText, /^MIT License\n/);
  assert.ok(!JSON.stringify(inventory).includes(REPO_ROOT), "inventory has no machine paths");
  // 3.0.0 dropped the memory-harvest CLAUDE.md alias (npm drops symlinks; the kernel composes a home's CLAUDE.md), and 4.0.0 has no agents/.
  assert.deepEqual(inventory.entries.filter((entry) => entry.type === "symlink"), [], "4.0.0 ships no symlink");
  assert.ok(!inventory.entries.some((entry) => entry.path.startsWith(`${CAPABILITY_PATH}/agents`)), "4.0.0 ships no capability agents");
});

test("verification needs only the mirror and checked-in inventory: no source clone or Git", (t) => {
  const base = temp(t);
  const root = copyMirror(base);
  const env = isolatedEnv(base);
  env.PATH = ""; // Fail if verification starts git/npm or tries to reacquire source.
  const stdout = command(process.execPath, [CHECKER, "--verify", "--repo-root", root], root, env);
  assert.equal(JSON.parse(stdout).ok, true);
  assert.deepEqual(checkOkfMirror({ repoRoot: root }), checkOkfMirror());
});

for (const [label, mutate, pattern] of [
  ["missing file", (cap) => rmSync(join(cap, "lib/inspection.mjs")), /file-set drift/],
  ["extra obsolete file", (cap) => write(join(cap, "lib/harvest-branch.mjs"), "obsolete\n"), /file-set drift/],
  ["extra empty directory", (cap) => mkdirSync(join(cap, "obsolete")), /file-set drift/],
  ["changed file bytes", (cap) => writeFileSync(join(cap, FILE), "changed\n"), /payload drift/],
  ["changed executable mode", (cap) => chmodSync(join(cap, FILE), 0o755), /payload drift/],
  ["missing symlink", (cap) => rmSync(join(cap, ALIAS)), /file-set drift/],
  ["symlink replaced by identical regular bytes", (cap) => { rmSync(join(cap, ALIAS)); writeFileSync(join(cap, ALIAS), readFileSync(join(cap, FILE))); }, /payload drift/],
  ["regular file replaced by symlink", (cap) => { rmSync(join(cap, "injects/okf.md")); symlinkSync("../" + FILE, join(cap, "injects/okf.md")); }, /payload drift/],
  ["symlink target bytes drift despite same resolution", (cap) => { rmSync(join(cap, ALIAS)); symlinkSync("./config.mjs", join(cap, ALIAS)); }, /payload drift/],
  ["symlink target drift to another file", (cap) => { rmSync(join(cap, ALIAS)); symlinkSync("consult.mjs", join(cap, ALIAS)); }, /payload drift/],
  ["absolute symlink escape", (cap) => { rmSync(join(cap, ALIAS)); symlinkSync(join(REPO_ROOT, MIRROR, FILE), join(cap, ALIAS)); }, /unsafe symlink/],
  ["relative symlink escape", (cap) => { rmSync(join(cap, ALIAS)); symlinkSync("../../../../package.json", join(cap, ALIAS)); }, /symlink escapes/],
  ["dangling symlink", (cap) => { rmSync(join(cap, ALIAS)); symlinkSync("MISSING.md", join(cap, ALIAS)); }, /ENOENT/],
  ["missing file in another exported capability", (cap) => rmSync(join(cap, "../oats-okf-harvest/oats.json")), /ENOENT|file-set drift/],
  ["changed bytes in another exported capability", (cap) => writeFileSync(join(cap, "../oats-okf-maintenance/oats.json"), "{}\n"), /payload drift/],
]) {
  test(`mirror rejects ${label}`, (t) => {
    const root = copyMirrorWithAlias(temp(t));
    mutate(join(root, MIRROR));
    assert.throws(() => checkOkfMirror({ repoRoot: root }), pattern);
  });
}

test("Git payload materialization preserves exact wrappers and symlinks; never repairs a bad mirror", (t) => {
  const base = temp(t);
  const root = copyMirrorWithAlias(base);
  const destination = join(base, "git-repo/oats-package");
  const inventory = materializeOkfGitPayload(destination, { repoRoot: root });
  for (const [file, text] of [["oats-package.json", inventory.distributionManifestText], ["LICENSE", inventory.distributionLicenseText]]) {
    assert.deepEqual(readFileSync(join(destination, file)), Buffer.from(text, "utf8"));
  }
  for (const file of inventory.distributionFiles) assert.deepEqual(readFileSync(join(destination, file.path)), Buffer.from(file.text, "utf8"), `package file ${file.path}`);
  assert.ok(lstatSync(join(destination, CAPABILITY_PATH, ALIAS)).isSymbolicLink());
  assert.equal(readlinkSync(join(destination, CAPABILITY_PATH, ALIAS)), "config.mjs");
  assert.deepEqual(distributionEntries(destination), inventory.entries);
  assert.deepEqual(checkOkfPayload(destination, inventory), inventory);
  assert.throws(() => materializeOkfGitPayload(destination, { repoRoot: root }), /must be empty/);
  const overlapping = join(root, MIRROR, "do-not-create");
  assert.throws(() => materializeOkfGitPayload(overlapping, { repoRoot: root }), /must not overlap/);
  assert.ok(!existsSync(overlapping));
  rmSync(join(root, MIRROR, ALIAS));
  const absent = join(base, "must-not-be-created");
  assert.throws(() => materializeOkfGitPayload(absent, { repoRoot: root }), /file-set drift/);
  assert.ok(!existsSync(absent), "verify source before creating destination");
  assert.ok(!existsSync(join(root, MIRROR, ALIAS)), "no alias repair");
});

test("generation captures dirty/untracked exported bytes deterministically, prunes obsolete files and ignores unexported copies", (t) => {
  const base = temp(t);
  const fixture = standaloneFixture(base);
  const sourceCap = join(fixture.root, "oats-package", CAPABILITY_PATH);
  // Deliberately preserve whitespace/CRLF: wrapper text must not be synthesized.
  const manifestFile = join(fixture.root, "oats-package/oats-package.json");
  const originalManifest = readFileSync(manifestFile, "utf8");
  writeFileSync(manifestFile, originalManifest.replaceAll("\n", "\r\n") + " \r\n");
  write(join(sourceCap, "untracked.txt"), "actual untracked working bytes\n");
  writeFileSync(join(sourceCap, FILE), readFileSync(join(sourceCap, FILE), "utf8") + "\nWorking change.\n");
  const inventory = generateOkfSourceInventory(fixture.root);
  assert.deepEqual(generateOkfSourceInventory(fixture.root), inventory);
  assert.equal(inventory.source.dirty, true);
  assert.deepEqual(inventory.release, { status: "pending", finalMergedCommit: null, plannedTag: `v${inventory.version}`, finalTag: null, published: false });
  assert.equal(inventory.source.head, fixture.git("rev-parse", "HEAD").trim());
  assert.ok(inventory.source.workingTreeStatus.some((row) => row.status === "??" && row.path.endsWith("untracked.txt")));
  assert.ok(inventory.entries.some((entry) => entry.path === `${CAPABILITY_PATH}/untracked.txt`));
  assert.ok(!inventory.entries.some((entry) => entry.path.endsWith("bin/obsolete.mjs")));
  assert.equal(inventory.distributionManifestText, readFileSync(manifestFile, "utf8"));
  const sourceBefore = payloadEntries(sourceCap);
  const root = copyMirror(base);
  write(join(root, MIRROR, "obsolete.txt"), "must disappear\n");
  syncOkfMirror(fixture.root, { repoRoot: root });
  assert.deepEqual(checkOkfMirror({ repoRoot: root }), inventory);
  assert.ok(!existsSync(join(root, MIRROR, "obsolete.txt")));
  assert.deepEqual(verifyOkfSource(fixture.root, { repoRoot: root }), inventory);
  const inventoryBytes = readFileSync(join(root, INVENTORY_PATH));
  command(process.execPath, [CHECKER, "--generate", "--source", fixture.root, "--repo-root", root], base, fixture.env);
  assert.deepEqual(readFileSync(join(root, INVENTORY_PATH)), inventoryBytes, "deterministic generated JSON");
  assert.deepEqual(payloadEntries(sourceCap), sourceBefore, "standalone remains read only");
  const dest = join(base, "recreated/oats-package");
  materializeOkfGitPayload(dest, { repoRoot: root });
  assert.deepEqual(readFileSync(join(dest, "oats-package.json")), readFileSync(manifestFile));
  writeFileSync(join(sourceCap, "untracked.txt"), "new drift\n");
  assert.throws(() => verifyOkfSource(fixture.root, { repoRoot: root }), /snapshot\/provenance differs/);
});

test("generation requires explicit source and safely restricts distribution enumeration before copying", (t) => {
  const base = temp(t);
  const { root: source, env } = standaloneFixture(base);
  const root = copyMirror(base);
  assert.throws(() => generateOkfSourceInventory(), /explicit --source/);
  const cli = spawnSync(process.execPath, [CHECKER, "--generate", "--repo-root", root], { env, encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /explicit --source/);
  const file = join(source, "oats-package/oats-package.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  const before = readFileSync(join(root, INVENTORY_PATH));
  const mirrorBefore = mirrorEntries(root);
  for (const capabilities of [["../outside"], ["/absolute"], [...CAPABILITY_PATHS, "bin"], [CAPABILITY_PATH], ["capabilities/../capabilities/oats-okf"], [{ path: CAPABILITY_PATH }]]) {
    writeFileSync(file, JSON.stringify({ ...original, capabilities }));
    assert.throws(() => syncOkfMirror(source, { repoRoot: root }), /must export exactly/);
    assert.deepEqual(readFileSync(join(root, INVENTORY_PATH)), before);
    assert.deepEqual(mirrorEntries(root), mirrorBefore);
  }
  for (const [change, pattern] of [[{ souls: ["../outside"] }, /unsafe payload path/], [{ souls: ["agents/x"] }, /outside souls/], [{ triggers: [{ id: "x", file: "../x.json" }] }, /unsafe payload path/], [{ triggers: [{ id: "x", file: "bin/x.json" }] }, /outside triggers/]]) {
    writeFileSync(file, JSON.stringify({ ...original, ...change }));
    assert.throws(() => syncOkfMirror(source, { repoRoot: root }), pattern);
    assert.deepEqual(readFileSync(join(root, INVENTORY_PATH)), before);
  }
  writeFileSync(file, JSON.stringify({ ...original, templates: ["../unexpected"] }));
  assert.throws(() => syncOkfMirror(source, { repoRoot: root }), /new distribution surfaces/);
  writeFileSync(file, JSON.stringify(original));
  const cap = join(source, "oats-package", CAPABILITY_PATH);
  assert.ok(!existsSync(join(cap, ALIAS)), "the 4.0.0 source ships no alias");
  syncOkfMirror(source, { repoRoot: root });
  assert.ok(!existsSync(join(cap, ALIAS)) && !existsSync(join(root, MIRROR, ALIAS)), "generation never synthesizes an alias");
  assert.deepEqual(mirrorEntries(root), mirrorBefore);
  rmSync(cap, { recursive: true });
  symlinkSync(join(REPO_ROOT, MIRROR), cap);
  assert.throws(() => syncOkfMirror(source, { repoRoot: root }), /real directory, not symlink/);
});

test("inventory wrapper-byte tampering is rejected", (t) => {
  const root = copyMirror(temp(t));
  const path = join(root, INVENTORY_PATH);
  const original = readFileSync(path, "utf8");
  for (const key of ["distributionManifestText", "distributionLicenseText"]) {
    const inventory = JSON.parse(original);
    inventory[key] += "\n";
    writeFileSync(path, JSON.stringify(inventory));
    assert.throws(() => checkOkfMirror({ repoRoot: root }), /bytes drift/);
  }
  const inventory = JSON.parse(original);
  inventory.distributionFiles.find((f) => f.path === SOUL_FILE).text += "\n";
  writeFileSync(path, JSON.stringify(inventory));
  assert.throws(() => checkOkfMirror({ repoRoot: root }), /distribution file bytes drift/, "package soul/trigger text is verified like the wrappers");
  // The mirror location is recorded, and a mirror back under capabilities/ is refused.
  for (const mirrorPaths of [undefined, CAPABILITY_PATHS]) {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), mirrorPaths }));
    assert.throws(() => checkOkfMirror({ repoRoot: root }), /record where this repository mirrors/);
  }
});

for (const annotated of [true, false]) {
  test(`finalization proves ${annotated ? "annotated" : "lightweight"} origin tag, preserves payload and verifies without branch-name dependence`, (t) => {
    const base = temp(t);
    const fixture = standaloneFixture(base);
    // Include committed binary bytes, executable mode and literal symlink target.
    const cap = join(fixture.root, "oats-package", CAPABILITY_PATH);
    write(join(cap, "binary.dat"), Buffer.from([0, 0xff, 0xfe, 13, 10]));
    chmodSync(join(cap, FILE), 0o755);
    symlinkSync("./binary.dat", join(cap, "binary-link"));
    const license = join(fixture.root, "oats-package/LICENSE");
    chmodSync(license, 0o755);
    fixture.git("add", ".");
    fixture.git("commit", "--quiet", "-m", "Accepted byte and mode changes");
    const options = publishFixture(base, fixture, { annotated });
    const pending = generateOkfSourceInventory(fixture.root);
    assert.equal(pending.release.status, "pending", "a published tag does not implicitly finalize generation");
    assert.equal(pending.release.published, false);
    assert.equal(pending.release.finalMergedCommit, null);
    const root = copyMirror(base);
    const beforeSource = distributionEntries(join(fixture.root, "oats-package"));
    const inventory = finalizeOkfMirror(fixture.root, { ...options, repoRoot: root });
    assert.deepEqual(inventory.release, {
      status: "published", finalMergedCommit: options.finalCommit,
      plannedTag: options.finalTag, finalTag: options.finalTag, published: true,
      remote: "origin", tagObject: fixture.git("rev-parse", `refs/tags/${options.finalTag}`).trim(),
    });
    assert.equal(inventory.source.repository, options.repository, "fixture provenance names its real remote, never GitHub");
    assert.equal(inventory.source.dirty, false);
    assert.deepEqual(inventory.source.workingTreeStatus, []);
    assert.deepEqual(inventory.entries, beforeSource);
    assert.deepEqual(mirrorEntries(root), beforeSource);
    assert.deepEqual(distributionEntries(join(fixture.root, "oats-package")), beforeSource, "finalization leaves source untouched");
    assert.equal(inventory.distributionLicenseMode, "100755");
    const materialized = join(base, "finalized/oats-package");
    materializeOkfGitPayload(materialized, { repoRoot: root });
    assert.deepEqual(distributionEntries(materialized), beforeSource);
    assert.equal(lstatSync(join(materialized, "LICENSE")).mode & 0o111, 0o111);
    assert.deepEqual(readFileSync(join(materialized, "LICENSE")), readFileSync(license));
    const written = readFileSync(join(root, INVENTORY_PATH));
    finalizeOkfMirror(fixture.root, { ...options, repoRoot: root });
    assert.deepEqual(readFileSync(join(root, INVENTORY_PATH)), written, "finalization is deterministic");
    fixture.git("branch", "-m", "renamed-after-publication");
    assert.deepEqual(verifyOkfSource(fixture.root, { repoRoot: root, repository: options.repository }), inventory);
    fixture.git("checkout", "--quiet", "--detach", options.finalCommit);
    assert.deepEqual(verifyOkfSource(fixture.root, { repoRoot: root, repository: options.repository }), inventory);
    // Release verification stays offline even when neither clone nor origin exists.
    rmSync(fixture.root, { recursive: true });
    rmSync(options.repository, { recursive: true });
    const env = { ...fixture.env, PATH: "" };
    const offline = command(process.execPath, [CHECKER, "--verify", "--repo-root", root], root, env);
    assert.equal(JSON.parse(offline).release.status, "published");
  });
}

test("finalization CLI requires explicit immutable refs and cannot use flags or a foreign origin to fabricate publication", (t) => {
  const base = temp(t);
  const fixture = standaloneFixture(base);
  const root = copyMirror(base);
  const options = publishFixture(base, fixture);
  for (const [args, pattern] of [
    [["--finalize"], /explicit --final-tag/],
    [["--finalize", "--final-tag", options.finalTag], /explicit --final-commit/],
    [["--finalize", "--final-tag", options.finalTag, "--final-commit", "HEAD"], /full immutable commit ID/],
    [["--finalize", "--final-tag", options.finalTag, "--final-commit", options.finalCommit.slice(0, 12)], /full immutable commit ID/],
    [["--generate", "--published"], /unknown option/],
    [["--generate", "--final-tag", options.finalTag], /require --finalize/],
    [["--finalize", "--generate"], /choose one/],
    [["--finalize", "--final-tag", options.finalTag, "--final-commit", options.finalCommit], /origin does not match expected repository/],
  ]) {
    const before = readFileSync(join(root, INVENTORY_PATH));
    const cli = spawnSync(process.execPath, [CHECKER, ...args, "--source", fixture.root, "--repo-root", root], { env: fixture.env, encoding: "utf8" });
    assert.notEqual(cli.status, 0, cli.stdout);
    assert.match(cli.stderr, pattern);
    assert.deepEqual(readFileSync(join(root, INVENTORY_PATH)), before);
  }
  assertMirrorUnchanged(root, () => finalizeOkfMirror(fixture.root, { repoRoot: root, published: true }), /explicit --final-tag/);
});

for (const [label, mutate, pattern] of [
  ["tracked source dirt outside export", (f) => write(join(f.root, "bin/oats-okf.mjs"), "dirty\n"), /clean accepted source tree/],
  ["untracked source file", (f) => write(join(f.root, "untracked.txt"), "unaccepted\n"), /clean accepted source tree/],
  ["masked source dirt outside export", (f) => {
    f.git("update-index", "--assume-unchanged", "bin/oats-okf.mjs");
    write(join(f.root, "bin/oats-okf.mjs"), "hidden dirty bytes\n");
    assert.equal(f.git("status", "--porcelain"), "");
  }, /unmasked source index/],
  ["wrong final version tag", (f, opts) => { opts.finalTag = "v9.9.9"; }, /tag must match distribution version/],
  ["wrong accepted commit", (f, opts) => { opts.finalCommit = "f".repeat(40); }, /HEAD must be the accepted final commit/],
  ["mismatched local tag commit", (f, opts) => {
    f.git("commit", "--quiet", "--allow-empty", "-m", "Other accepted commit");
    opts.finalCommit = f.git("rev-parse", "HEAD").trim();
  }, /local final tag does not resolve/],
  ["missing local tag", (f, opts) => f.git("tag", "-d", opts.finalTag), /rev-parse/],
  ["unpublished remote tag", (f, opts) => f.git("push", "--quiet", "origin", `:refs/tags/${opts.finalTag}`), /ls-remote/],
  ["moved remote tag", (f, opts) => {
    f.git("commit", "--quiet", "--allow-empty", "-m", "Unaccepted different commit");
    f.git("push", "--quiet", "origin", `+HEAD:refs/tags/${opts.finalTag}`);
    f.git("checkout", "--quiet", "--detach", opts.finalCommit);
  }, /published origin tag object differs/],
  ["missing origin", (f) => f.git("remote", "remove", "origin"), /remote get-url/],
  ["unreachable origin", (f, opts) => rmSync(opts.repository, { recursive: true }), /ls-remote/],
  ["wrong origin identity", (f, opts) => { opts.repository += "-wrong"; }, /origin does not match expected repository/],
  ["multiple origin URLs", (f, opts) => f.git("remote", "set-url", "--add", "origin", opts.repository + "-other"), /exactly one origin/],
  ["canonical URL rewritten to a fixture", (f, opts) => {
    f.git("remote", "set-url", "origin", "https://github.com/awebai/oats-okf.git");
    f.git("config", `url.${opts.repository}.insteadOf`, "https://github.com/awebai/oats-okf.git");
    delete opts.repository;
  }, /origin does not match expected repository/],
  ["moved URL rewritten to a fixture", (f, opts) => {
    f.git("remote", "set-url", "origin", "https://github.com/oats-project/oats-okf.git");
    f.git("config", `url.${opts.repository}.insteadOf`, "https://github.com/oats-project/oats-okf.git");
    delete opts.repository;
  }, /origin does not match expected repository/],
]) {
  test(`finalization rejects ${label} without altering mirror or provenance`, (t) => {
    const base = temp(t);
    const fixture = standaloneFixture(base);
    const options = publishFixture(base, fixture);
    const root = copyMirror(base);
    mutate(fixture, options);
    assertMirrorUnchanged(root, () => finalizeOkfMirror(fixture.root, { ...options, repoRoot: root }), pattern);
  });
}

for (const [label, mutate, pattern] of [
  ["assume-unchanged byte edits", (f, cap) => {
    f.git("update-index", "--assume-unchanged", `oats-package/${CAPABILITY_PATH}/${FILE}`);
    writeFileSync(join(cap, FILE), "not the accepted blob\n");
  }, /working payload differs from immutable commit/],
  ["skip-worktree byte edits", (f, cap) => {
    f.git("update-index", "--skip-worktree", `oats-package/${CAPABILITY_PATH}/${FILE}`);
    writeFileSync(join(cap, FILE), "not the accepted blob\n");
  }, /working payload differs from immutable commit/],
  ["filemode=false executable edits", (f, cap) => {
    f.git("config", "core.filemode", "false");
    chmodSync(join(cap, FILE), 0o755);
  }, /working payload differs from immutable commit/],
  ["ignored exported files", (f, cap) => {
    write(join(f.root, ".git/info/exclude"), "ignored.txt\n");
    write(join(cap, "ignored.txt"), "not in Git\n");
  }, /working payload differs from immutable commit/],
  ["untracked empty directory", (f, cap) => mkdirSync(join(cap, "empty")), /working payload differs from immutable commit/],
  ["assume-unchanged symlink target", (f, cap) => {
    const path = "extra-link";
    f.git("update-index", "--assume-unchanged", `oats-package/${CAPABILITY_PATH}/${path}`);
    rmSync(join(cap, path));
    symlinkSync("./" + FILE, join(cap, path));
  }, /working payload differs from immutable commit/],
  ["assume-unchanged wrapper bytes", (f) => {
    f.git("update-index", "--assume-unchanged", "oats-package/LICENSE");
    writeFileSync(join(f.root, "oats-package/LICENSE"), "not the committed license\n");
  }, /working wrapper bytes differ from immutable commit/],
  ["filemode=false wrapper mode", (f) => {
    f.git("config", "core.filemode", "false");
    chmodSync(join(f.root, "oats-package/LICENSE"), 0o755);
  }, /working wrapper mode differs from immutable commit/],
  ["assume-unchanged package soul bytes", (f) => {
    f.git("update-index", "--assume-unchanged", `oats-package/${SOUL_FILE}`);
    writeFileSync(join(f.root, "oats-package", SOUL_FILE), "not the accepted soul\n");
  }, /working package souls\/triggers differ from immutable commit/],
]) {
  test(`finalization checks raw Git objects despite false-clean status: ${label}`, (t) => {
    const base = temp(t);
    const fixture = standaloneFixture(base);
    const cap = join(fixture.root, "oats-package", CAPABILITY_PATH);
    symlinkSync(FILE, join(cap, "extra-link"));
    fixture.git("add", ".");
    fixture.git("commit", "--quiet", "-m", "Include literal symlink target");
    const options = publishFixture(base, fixture);
    const root = copyMirror(base);
    mutate(fixture, cap);
    assert.equal(fixture.git("status", "--porcelain"), "", "fixture must fool ordinary Git status");
    assertMirrorUnchanged(root, () => finalizeOkfMirror(fixture.root, { ...options, repoRoot: root }), pattern);
  });
}

test("finalized verify-source rejects dirty trees, lost publication and retagging even at the same commit", (t) => {
  const base = temp(t);
  const fixture = standaloneFixture(base);
  const options = publishFixture(base, fixture);
  const root = copyMirror(base);
  const inventory = finalizeOkfMirror(fixture.root, { ...options, repoRoot: root });
  const verify = () => verifyOkfSource(fixture.root, { repoRoot: root, repository: options.repository });
  write(join(fixture.root, "untracked.txt"), "dirty\n");
  assert.throws(verify, /clean accepted source tree/);
  rmSync(join(fixture.root, "untracked.txt"));
  fixture.git("push", "--quiet", "origin", `:refs/tags/${options.finalTag}`);
  assert.throws(verify, /ls-remote/);
  fixture.git("push", "--quiet", "origin", `refs/tags/${options.finalTag}`);
  assert.deepEqual(verify(), inventory);
  fixture.git("-c", "tag.gpgsign=false", "tag", "-f", "-a", "-m", "Different tag object, same commit", options.finalTag, options.finalCommit);
  assert.throws(verify, /published origin tag object differs/);
  fixture.git("push", "--quiet", "origin", `+refs/tags/${options.finalTag}`);
  assert.throws(verify, /immutable source\/payload provenance differs/, "recorded tag object is immutable even when commit is unchanged");
  assert.deepEqual(checkOkfMirror({ repoRoot: root }), inventory, "verification never rewrites provenance");
});

test("offline verification rejects contradictory release metadata without treating a boolean as publication", (t) => {
  const base = temp(t);
  const fixture = standaloneFixture(base);
  const root = copyMirror(base);
  syncOkfMirror(fixture.root, { repoRoot: root });
  const path = join(root, INVENTORY_PATH);
  const pending = readFileSync(path, "utf8");
  for (const change of [{ published: true }, { finalTag: "v2.0.0" }, { finalMergedCommit: "a".repeat(40) }, { status: "released" }, { status: "published", published: true }]) {
    const inventory = JSON.parse(pending);
    Object.assign(inventory.release, change);
    writeFileSync(path, JSON.stringify(inventory));
    assert.throws(() => checkOkfMirror({ repoRoot: root }));
  }
  const options = publishFixture(base, fixture);
  const final = finalizeOkfMirror(fixture.root, { ...options, repoRoot: root });
  for (const mutate of [
    (i) => { i.release.published = false; },
    (i) => { i.release.finalTag = "v9.9.9"; },
    (i) => { i.release.finalMergedCommit = "b".repeat(40); },
    (i) => { i.release.tagObject = "HEAD"; },
    (i) => { i.release.remote = "other"; },
    (i) => { i.source.dirty = true; i.source.workingTreeStatus = [{ status: "??", path: "untracked" }]; },
    (i) => { delete i.distributionLicenseMode; },
    (i) => { i.distributionManifestMode = i.distributionManifestMode === "100644" ? "100755" : "100644"; },
  ]) {
    const inventory = structuredClone(final);
    mutate(inventory);
    writeFileSync(path, JSON.stringify(inventory));
    assert.throws(() => checkOkfMirror({ repoRoot: root }));
  }
});

test("a commit published only on a branch does not prove tag publication", (t) => {
  const base = temp(t);
  const fixture = standaloneFixture(base);
  const options = publishFixture(base, fixture, { publish: false });
  fixture.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const root = copyMirror(base);
  assertMirrorUnchanged(root, () => finalizeOkfMirror(fixture.root, { ...options, repoRoot: root }), /ls-remote/);
});

test("remote evidence query does not inherit source-local transport configuration", (t) => {
  const base = temp(t);
  const fixture = standaloneFixture(base);
  const options = publishFixture(base, fixture);
  fixture.git("config", "protocol.file.allow", "never");
  fixture.git("config", "remote.origin.uploadpack", "false");
  const root = copyMirror(base);
  const inventory = finalizeOkfMirror(fixture.root, { ...options, repoRoot: root });
  assert.equal(inventory.release.status, "published");
  assert.deepEqual(verifyOkfSource(fixture.root, { ...options, repoRoot: root }), inventory);
});
