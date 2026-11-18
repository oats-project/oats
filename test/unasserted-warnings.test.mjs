// awebai/oats#910: test output is pristine. The root run (scripts/run-tests.mjs) fails when a test
// file's output holds an `oats: warning:` line, even if every test passed, and names the file.
// Each case is a real nested run of the runner over one small test file.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureBase, inheritedEnv } from "./helpers/host-fixture.mjs";
import { describeNestedTestFailure } from "./helpers/nested-test-failure.mjs";
import unassertedWarnings, { WARNING_MARK } from "../scripts/test-warnings-reporter.mjs";

const LINE = "oats: warning: could not read your login environment (a reason no fixture expects); and nothing else";
const HEAD = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { spawnSync } from "node:child_process";\n`;
/** A `node -e` that writes LINE to its stderr. */
const CHILD = `spawnSync(process.execPath, ["-e", ${JSON.stringify(`process.stderr.write(${JSON.stringify(`${LINE}\n`)})`)}]`;

/** A repository of one test file, with the root runner as it is → the nested run's result. */
function rootRun(t, name, source, flags = []) {
  const root = fixtureBase("oats-uw-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const script of ["run-tests.mjs", "desktop-test-deps.mjs", "test-warnings-reporter.mjs", "test-file-tmpdir.mjs"]) cpSync(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
  for (const dir of ["packages/pi", "test"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "test", name), source);
  const env = inheritedEnv();
  delete env.NODE_TEST_CONTEXT; // the nested run is a run of its own, not a subtest of this one
  const r = spawnSync(process.execPath, [join(root, "scripts", "run-tests.mjs"), ...flags], { cwd: root, env, encoding: "utf8", timeout: 120000 });
  return { ...r, root, file: `test/${name}` };
}
const says = (r) => `the nested run said:\n${r.stdout}\n${r.stderr}`;
function failsNaming(r, { lines = 1 } = {}) {
  assert.notEqual(r.status, 0, `the run fails though every test passed. ${says(r)}`);
  assert.match(r.stdout, /(^# pass 1$|ℹ pass 1$)/m, "its one test passed");
  assert.match(r.stdout, /(^# fail 0$|ℹ fail 0$)/m);
  assert.match(r.stderr, /UNASSERTED WARNINGS/);
  assert.ok(r.stderr.includes(`  ${r.file}: ${lines} line${lines === 1 ? "" : "s"}`), `it names the file and the count. ${says(r)}`);
  assert.ok(r.stderr.includes(`    ${LINE}`), "and shows the line");
}
function passes(r) {
  assert.equal(r.status, 0, describeNestedTestFailure(r, "the nested root run"));
  assert.doesNotMatch(r.stderr, /UNASSERTED WARNINGS/);
}

test("a passing test file whose worker writes a warning to stderr fails the root run, which names the file", (t) => {
  failsNaming(rootRun(t, "in-process.test.mjs", `${HEAD}test("passes, and writes the line", () => { process.stderr.write(${JSON.stringify(`${LINE}\n`)}); });\n`));
});

test("a child that has the worker's stderr and writes the warning fails the root run too", (t) => {
  failsNaming(rootRun(t, "inherited.test.mjs", `${HEAD}test("passes, and its child writes the line", () => { assert.equal(${CHILD}, { stdio: "inherit" }).status, 0); });\n`));
});

test("a warning on the worker's stdout fails the root run, and every line is counted", (t) => {
  const r = rootRun(t, "stdout.test.mjs", `${HEAD}test("passes, and prints the line twice", () => { console.log(${JSON.stringify(LINE)}); console.log(${JSON.stringify(LINE)}); });\n`);
  failsNaming(r, { lines: 2 });
});

test("a warning a child wrote into a pipe the test reads is the test's: the root run passes", (t) => {
  passes(rootRun(t, "captured.test.mjs", `${HEAD}test("captures and asserts its child's line", () => {
  const r = ${CHILD}, { encoding: "utf8" });
  assert.equal(r.stderr, ${JSON.stringify(`${LINE}\n`)});
});\n`));
});

test("a run with no warning passes, and a failing test fails it as before, with no word of warnings", (t) => {
  passes(rootRun(t, "clean.test.mjs", `${HEAD}test("passes", () => { process.stderr.write("oats: a line that is not a warning\\n"); });\n`));
  const r = rootRun(t, "failing.test.mjs", `${HEAD}test("fails", () => { assert.equal(1, 2); });\n`);
  assert.equal(r.status, 1, says(r));
  assert.doesNotMatch(r.stderr, /UNASSERTED WARNINGS/);
});

test("what a person reads is what node --test prints by itself: the same lines, in the same reporter", (t) => {
  const source = `${HEAD}test("passes", () => {});\ntest("passes too", () => { console.log("a line of its own"); });\n`;
  const guarded = rootRun(t, "shown.test.mjs", source);
  passes(guarded);
  const env = inheritedEnv();
  delete env.NODE_TEST_CONTEXT;
  const plain = spawnSync(process.execPath, ["--test", "test/**/*.test.mjs"], { cwd: guarded.root, env, encoding: "utf8", timeout: 120000 });
  assert.equal(plain.status, 0, describeNestedTestFailure(plain, "the plain node --test run"));
  // Durations differ from run to run: every number with a fraction is one.
  const lines = (out) => out.replace(/\d+\.\d+/g, "N").split("\n").filter((line) => !/NOTICE|SKIPPED|omitted|Reason:|To run them|^=+$|^$/.test(line));
  assert.deepEqual(lines(guarded.stdout), lines(plain.stdout));
});

test("a reporter named on the command line stays the one that is read, and the guard still holds", (t) => {
  const r = rootRun(t, "named.test.mjs", `${HEAD}test("passes, and writes the line", () => { process.stderr.write(${JSON.stringify(`${LINE}\n`)}); });\n`, ["--test-reporter=dot"]);
  assert.notEqual(r.status, 0, says(r));
  assert.match(r.stdout, /^\.\s*$/m, "the dot reporter printed");
  assert.match(r.stderr, /UNASSERTED WARNINGS/);
});

test("the reporter reads lines, whole: one split over two events is one, and an unfinished last line counts", async () => {
  const file = "/repo/test/a.test.mjs";
  const events = [
    { type: "test:start", data: { name: "x", file } },
    { type: "test:stderr", data: { file, message: `before\n${WARNING_MARK} first ha` } },
    { type: "test:stdout", data: { file, message: `nothing here\n` } },
    { type: "test:stderr", data: { file, message: `lf\nafter\n` } },
    { type: "test:stdout", data: { file: "/repo/test/b.test.mjs", message: `${WARNING_MARK} with no newline` } },
    { type: "test:diagnostic", data: { file, message: `${WARNING_MARK} a diagnostic is not output` } },
  ];
  const found = [];
  for await (const line of unassertedWarnings((async function* () { yield* events; })())) found.push(JSON.parse(line));
  assert.deepEqual(found, [
    { file, stream: "stderr", line: `${WARNING_MARK} first half` },
    { file: "/repo/test/b.test.mjs", stream: "stdout", line: `${WARNING_MARK} with no newline` },
  ]);
});

test("a skipped real-aw path fails the root run and names the missing coverage", t => {
  const r = rootRun(t, "native-aw.test.mjs", `${HEAD}test("real aw custody status", { skip: "native fixture absent" }, () => {});\n`);
  assert.notEqual(r.status, 0, says(r));
  assert.match(r.stderr, /SKIPPED REAL-AW TESTS: 1/);
  assert.ok(r.stderr.includes("native-aw.test.mjs"));
  assert.ok(r.stderr.includes("real aw custody status"));
});

test("a platform skip outside the real-aw path keeps its ordinary test-runner meaning", t => {
  passes(rootRun(t, "platform.test.mjs", `${HEAD}test("another platform", { skip: "not this platform" }, () => {});\n`));
});
