#!/usr/bin/env node
// Root test runner for `npm test`.
//
// The suite is still `node --test` over the same globs; the only thing this
// adds is a decision about Desktop suites and root/Desktop integration. They need jsdom, marked,
// dompurify and highlight.js, which are packages/desktop's dependencies and not
// the root's. Handing them to node --test on a checkout that has only run root
// `npm ci` produced 17 ERR_MODULE_NOT_FOUND failures — the state of every fresh
// clone — which made a red root suite the normal, and therefore ignored, result.
//
// So: run them when they can load, and when they cannot, say so loudly and run
// the rest. The root files that load Desktop modules are explicitly included in
// the same group; their .integration.mjs suffix keeps them out of the root-only
// globs.
// Absence of an optional package's node_modules is a property of the
// checkout, not a defect in the code under test, so this exits 0 in that case;
// nothing is skipped silently. Both CI lanes (.github/workflows/pull-request.yml
// and release.yml) install the desktop dependencies before `npm test`, and
// test/release-workflow.test.mjs pins release.yml's install step, so the skip
// path cannot quietly become CI's normal behaviour.
//
// Any extra arguments are forwarded to node --test.

import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  DESKTOP_TEST_DEPS_INSTALL,
  REPO_ROOT,
  desktopTestDeps,
} from "./desktop-test-deps.mjs";

// Explicit globs, never a bare `node --test`: with no arguments node walks the
// whole tree, and a checkout that hosts agents carries nested instance worktrees
// (full copies of this repository) under agents/ and .agents/ — a bare run
// executes every copy of the suite, against the wrong trees.
const KERNEL_GLOBS = ["test/**/*.test.mjs", "tests/**/*.test.mjs", "capabilities/**/*.test.mjs"];

const { ok: desktopReady, missing } = desktopTestDeps();

// With the desktop dependencies present, keep the single packages/** glob so a
// newly added package is discovered without touching this file. Without them,
// enumerate the package directories and drop only desktop — same property.
const packageGlobs = desktopReady
  ? ["packages/**/*.test.mjs"]
  : readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "desktop")
      .map((e) => `packages/${e.name}/**/*.test.mjs`);

// Root files that load Desktop modules (and so the desktop dependencies): run
// with the Desktop suites, omitted with them.
const DESKTOP_INTEGRATION = ["test/desktop-schedule-roundtrip.integration.mjs", "tests/desktop-views.integration.mjs"];
const desktopIntegration = desktopReady ? DESKTOP_INTEGRATION : [];

const RULE = "=".repeat(78);
const notice = [
  RULE,
  "NOTICE: Desktop suites and root/Desktop integration coverage were SKIPPED — this run does NOT cover them.",
  `Root integration omitted: ${DESKTOP_INTEGRATION.join(", ")}`,
  `Reason: packages/desktop dependencies are not installed (missing: ${missing.join(", ")}).`,
  `To run them: ${DESKTOP_TEST_DEPS_INSTALL}`,
  RULE,
].join("\n");

if (!desktopReady) console.log(`\n${notice}\n`);

// Forwarded flags go BEFORE the globs: node --test reads a flag after the first
// positional as another file pattern, so `npm test -- --test-shard=k/N` silently
// ran the whole suite in every CI shard. Extra file patterns still work (they
// only narrow, alongside the default globs).
const extra = process.argv.slice(2);
const flags = extra.filter((a) => a.startsWith("-")), files = extra.filter((a) => !a.startsWith("-"));

// Test output is pristine (awebai/oats#910): an expected warning is captured and
// asserted by the test or by its fixture, never left in the output. So the run
// fails when a test file's output holds an `oats: warning:` line, even if every
// test passed. A second reporter reads each file's stderr and stdout as the run
// received them (scripts/test-warnings-reporter.mjs: it knows the file, and sees
// a line whether the worker wrote it or a child that has the worker's stderr)
// and writes what it finds to a file of this run.
//
// node --test picks its reporter only when none is named, so the one a person
// reads is named here as node would pick it: spec on a terminal and, in a pipe,
// tap before Node 23 and spec from it. A reporter given on the command line
// stays the one that is read.
const namesReporter = flags.some((f) => /^--test-reporter(=|$)/.test(f));
const namesDestination = flags.some((f) => /^--test-reporter-destination(=|$)/.test(f));
const shown = namesReporter
  ? (namesDestination ? [] : ["--test-reporter-destination=stdout"])
  : [`--test-reporter=${process.stdout.isTTY || Number(process.versions.node.split(".")[0]) >= 23 ? "spec" : "tap"}`, "--test-reporter-destination=stdout"];

// A test file leaves nothing behind (awebai/oats#1025): where a directory is made, its removal is
// registered. So the run fails, too, when a file leaves something in its temporary directory, and
// names the file and what is left. Each file's process is preloaded with scripts/test-file-tmpdir.mjs,
// which gives it a directory of its own inside this run's directory as its temporary directory and
// as tmux's default place; the fixture helpers that go to /tmp when the temporary directory's path
// is long make theirs there as well. When the run has ended every such directory is empty, but for
// Node's own compile cache (NODE_COMPILE_CACHE below).
//
// The run's directory holds everything of the run, and is removed when the run has ended, whatever
// its files left. A run that is killed leaves that one directory. It is under the temporary
// directory, or under /tmp when that path is long (macOS: about 49 characters): a file's directory
// is the start of every path its fixtures make, and a socket's path has about 104 bytes in all.
const SHORT_TMPDIR = 20;
// Where the tests of the deployments auto-add make their bases outside the temporary directories, and
// how those are named: test/helpers/outside-temporary.mjs, whose two names these are. Copied, not
// imported: this runner imports nothing of the repository's tests or lib (test/left-behind.test.mjs
// runs a copy of scripts/ alone).
const OUTSIDE_TEMPORARY_PARENT = "/var/tmp";
const OUTSIDE_TEMPORARY_PREFIX = "oats-deployments-test-";
/** Remove a tree whatever a test left of its permissions: each directory is made writable first. */
function removeWritable(path) {
  const writable = (p) => {
    try { if (!lstatSync(p).isDirectory()) return; chmodSync(p, 0o700); for (const entry of readdirSync(p)) writable(join(p, entry)); } catch { /* gone */ }
  };
  writable(path);
  rmSync(path, { recursive: true, force: true });
}
const runDir = mkdtempSync(join(tmpdir().length > SHORT_TMPDIR ? "/tmp" : tmpdir(), "ot-"));
const warningsFile = join(runDir, "warnings.jsonl");
const guard = [`--test-reporter=${new URL("./test-warnings-reporter.mjs", import.meta.url).href}`, `--test-reporter-destination=${warningsFile}`];
const ownTmpdir = `--import=${new URL("./test-file-tmpdir.mjs", import.meta.url).href}`;
/** What a file may leave in its directory: Node makes its compile cache under the temporary
 *  directory when a tool a test starts asks for one (npm does). It is Node's, not the file's. */
const NODE_COMPILE_CACHE = "node-compile-cache";

const args = ["--test", ownTmpdir, ...flags, ...shown, ...guard, ...KERNEL_GLOBS, ...packageGlobs, ...desktopIntegration, ...files];
// The run's processes inherit no compile cache: with the developer's NODE_COMPILE_CACHE, every one of
// them, and every tool a test starts, would write into that cache. A tool that asks for one makes it
// in its file's directory (above).
const { NODE_COMPILE_CACHE: _developersCache, ...env } = process.env;
// No test writes the person's own deployments list (awebai/oats#1390): an explicit add or an onboard
// lists a deployment, and so does any kernel command run in one outside the temporary directories
// (awebai/oats#1397), where the auto-add tests make theirs (OUTSIDE_TEMPORARY_PARENT above). Each
// file's process gets an OATS_HOME_DIR of its own (scripts/test-file-tmpdir.mjs); a row added to the
// person's list during the run, under a temporary directory or one of those bases, means a test
// reached the real one, and the run fails naming it.
const personalList = join(process.env.OATS_HOME_DIR || join(homedir(), ".oats"), "config", "deployments.json");
const runStartedAt = new Date().toISOString();
const run = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: "inherit", env: { ...env, OATS_TEST_RUN_DIR: runDir } });

let found = "";
const left = []; // { file, entries } for each test file that left something
try {
  // The file is node's to create: it is absent only when node never started the run.
  try { found = readFileSync(warningsFile, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const name of readdirSync(runDir).filter((entry) => /^\d+$/.test(entry)).sort((a, b) => a - b)) {
    const entries = readdirSync(join(runDir, name), { withFileTypes: true }).filter((entry) => entry.name !== NODE_COMPILE_CACHE);
    if (!entries.length) continue;
    let file = "(a file the run did not name)";
    try { file = readFileSync(join(runDir, `${name}.file`), "utf8") || file; } catch (e) { if (e.code !== "ENOENT") throw e; }
    left.push({ file, entries: entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort() });
  }
  // The bases a file made outside the temporary directories (test/helpers/outside-temporary.mjs) are
  // named for this run and the file: one still there was left behind. It is removed with the run's.
  const ours = `${OUTSIDE_TEMPORARY_PREFIX}${basename(runDir)}.`;
  let outside = [];
  try { outside = readdirSync(OUTSIDE_TEMPORARY_PARENT).filter((entry) => entry.startsWith(ours)); } catch { /* no /var/tmp: none made */ }
  for (const entry of outside.sort()) {
    const name = entry.slice(ours.length).split("-")[0];
    let file = "(a file the run did not name)";
    try { file = readFileSync(join(runDir, `${name}.file`), "utf8") || file; } catch (e) { if (e.code !== "ENOENT") throw e; }
    left.push({ file, entries: [`${join(OUTSIDE_TEMPORARY_PARENT, entry)}/`] });
    removeWritable(join(OUTSIDE_TEMPORARY_PARENT, entry));
  }
} finally { rmSync(runDir, { recursive: true, force: true }); }
const records = found.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const skippedRealAw = records.filter(row => row.kind === "skipped-real-aw");
const warnings = records.filter(row => row.kind !== "skipped-real-aw");
// The temporary directories, and the bases tests make outside them (test/helpers/outside-temporary.mjs).
const temporary = [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].flatMap((p) => { try { return [p, realpathSync(p)]; } catch { return [p]; } }))];
const outsideBases = [...new Set([OUTSIDE_TEMPORARY_PARENT].flatMap((p) => { try { return [p, realpathSync(p)]; } catch { return [p]; } }))].map((p) => join(p, OUTSIDE_TEMPORARY_PREFIX));
const reachedPersonalList = (() => {
  let doc;
  try { doc = JSON.parse(readFileSync(personalList, "utf8")); } catch { return []; }
  return (Array.isArray(doc?.deployments) ? doc.deployments : [])
    .filter((row) => typeof row?.path === "string" && typeof row.addedAt === "string" && row.addedAt >= runStartedAt
      && (temporary.some((dir) => row.path === dir || row.path.startsWith(`${dir}/`)) || outsideBases.some((base) => row.path.startsWith(base))))
    .map((row) => row.path);
})();

if (run.error) throw run.error;

// Repeat it after node --test's summary so the last thing on screen says the
// desktop suites did not run, whatever the counts above claim.
if (!desktopReady) console.log(`\n${notice}`);

const relativeFile = (file) => relative(REPO_ROOT, file) || file;

if (skippedRealAw.length) {
  console.error([
    "", RULE,
    `SKIPPED REAL-AW TESTS: ${skippedRealAw.length}. The run FAILS: native-path evidence was not exercised.`,
    ...skippedRealAw.map(({ file, name }) => `  ${relativeFile(file)}: ${name}`),
    RULE,
  ].join("\n"));
}

if (warnings.length) {
  const byFile = new Map();
  for (const { file, line } of warnings) byFile.set(file, [...(byFile.get(file) ?? []), line]);
  const named = [...byFile].map(([file, lines]) => {
    const distinct = [...new Set(lines.map((line) => line.trim()))];
    return [`  ${relativeFile(file)}: ${lines.length} line${lines.length === 1 ? "" : "s"}`,
      ...distinct.slice(0, 3).map((line) => `    ${line.length > 300 ? `${line.slice(0, 300)}…` : line}`),
      ...(distinct.length > 3 ? [`    … and ${distinct.length - 3} more different lines`] : [])].join("\n");
  });
  console.error([
    "", RULE,
    `UNASSERTED WARNINGS: ${warnings.length} \`oats: warning:\` line${warnings.length === 1 ? "" : "s"} reached the test output, from ${byFile.size} test file${byFile.size === 1 ? "" : "s"}. The run FAILS.`,
    "Test output is pristine: an expected warning is captured and asserted by the test or by its fixture",
    "(docs/implementation.md, \"Tests and gates\"; test/helpers/host-fixture.mjs expectLoginFallback).",
    ...named,
    RULE,
  ].join("\n"));
}

if (left.length) {
  // A tmux client that runs with no TMUX_TMPDIR of a fixture makes this directory, and on a host
  // with a live deployment it would have reached that deployment's server.
  const tmuxDefault = `tmux-${process.getuid?.()}/`;
  const named = left.map(({ file, entries }) => [`  ${relativeFile(file)}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`,
    ...entries.slice(0, 5).map((entry) => `    ${entry}${entry === tmuxDefault ? "  (tmux's default place: a tmux client ran with no TMUX_TMPDIR of a fixture)" : ""}`),
    ...(entries.length > 5 ? [`    … and ${entries.length - 5} more`] : [])].join("\n"));
  console.error([
    "", RULE,
    `LEFT BEHIND: ${left.length} test file${left.length === 1 ? "" : "s"} left something in ${left.length === 1 ? "its" : "their"} temporary directory. The run FAILS.`,
    "A test file leaves nothing behind: where a directory is made, its removal is registered, so a test",
    "that fails still removes it (docs/implementation.md, \"Tests and gates\"; v2Deployment({ t }) ends a fixture).",
    ...named,
    RULE,
  ].join("\n"));
}

if (reachedPersonalList.length) {
  console.error([
    "", RULE,
    `PERSONAL LIST WRITTEN: ${reachedPersonalList.length} temporary deployment${reachedPersonalList.length === 1 ? " was" : "s were"} added to ${personalList} during this run. The run FAILS.`,
    "A test runs the CLI with an OATS_HOME_DIR of its own (scripts/test-file-tmpdir.mjs gives each file one; a test that",
    "builds its environment from nothing names one). Remove these rows with `oats deployments remove <path>`:",
    ...reachedPersonalList.slice(0, 5).map((path) => `  ${path}`),
    ...(reachedPersonalList.length > 5 ? [`  … and ${reachedPersonalList.length - 5} more`] : []),
    RULE,
  ].join("\n"));
}

process.exit(skippedRealAw.length || warnings.length || left.length || reachedPersonalList.length ? run.status || 1 : run.status ?? 1);
