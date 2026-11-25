import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseConfigData } from "../lib/config-data.mjs";
import { SESSION_VARIABLES, isSessionVariable } from "./helpers/host-fixture.mjs";
import { SESSION_SUITES, poisonedSession } from "../scripts/test-session-inheritance.mjs";

test("direct main pushes retain the same read-only CI gates as pull requests", () => {
  const workflow = parseConfigData(readFileSync(new URL("../.github/workflows/pull-request.yml", import.meta.url))).value;
  // main and every release/** maintenance branch (release/0.24 → 0.24.x) get the
  // same gate on push and on pull request — the two lists must stay equal.
  assert.deepEqual(workflow.on.push.branches, ["main", "release/**"]);
  assert.deepEqual(workflow.on.pull_request.branches, workflow.on.push.branches);
  assert.equal(workflow.permissions.contents, "read");
  assert.match(workflow.concurrency.group, /github\.event\.pull_request\.number \|\| github\.sha/);
  // Every job runs on `ubuntu-latest`, on purpose: when GitHub moves that label to another
  // system, a break on it shows here first and not at a release. release.yml and
  // build-installers.yml name their runners by version (test/workflow-no-cache.test.mjs holds
  // their list), and moving them is then a decision with this workflow's evidence.
  assert.ok(Object.keys(workflow.jobs).length >= 5);
  for (const [name, job] of Object.entries(workflow.jobs)) assert.equal(job["runs-on"], "ubuntu-latest", `pull-request.yml, job ${name}`);
  const steps = workflow.jobs.verify.steps, commands = steps.map((step) => step.run);
  for (const command of ["npm run check", "npm run check:pi", "npm run validate", "npm run pack:check", "npm run smoke:tarball"]) {
    assert.ok(commands.includes(command), `missing gate: ${command}`);
  }
  // The legacy soul knowledge bundles (agents/*/soul/knowledge) moved to the central base,
  // which validates itself; the repository no longer carries a validate:okf gate.
  assert.ok(!commands.includes("npm run validate:okf"), "no gate for the removed soul bundles");
  // The suite runs sharded: every shard of the matrix runs `npm test -- --test-shard=k/N`,
  // and each shard installs the desktop deps (no Desktop suite silently skipped).
  const tests = workflow.jobs.tests, shards = tests.strategy.matrix.shard;
  const n = shards.length;
  assert.deepEqual(shards, Array.from({ length: n }, (_, i) => i + 1));
  assert.ok(tests.steps.some((step) => step.run === `npm test -- --test-shard=\${{ matrix.shard }}/${n}`), "every shard must run npm test with its shard");
  assert.ok(tests.steps.some((step) => step.run === "npm ci" && step["working-directory"] === "packages/desktop"), "Desktop regressions must not be silently skipped");
  assert.equal(tests.strategy["fail-fast"], false);
  // One stable check name gates on BOTH the shards and the static gates.
  const gate = workflow.jobs.gate;
  assert.equal(gate.name, "Node 22 / test, validate, pack, smoke");
  assert.deepEqual(gate.needs, ["tests", "verify", "desktop-standalone", "session-inheritance", "unsupported-node", "provider-lifecycle"]);
  assert.equal(gate.if, "always()");
  // `always()` runs the gate after a failed job too, so needing a job is not enough: the
  // gate must test each needed job's result itself, or that job's failure passes the gate.
  const checks = gate.steps.flatMap((step) => (step.run ?? "").split("\n").map((line) => line.trim()));
  for (const job of gate.needs) {
    // (One job may also be skipped: every schedule of the session-provider lifecycle, which runs
    // for a change that touches it. A failure or a cancellation of it still fails the gate.)
    const mustSucceed = `test "\${{ needs.${job}.result }}" = success`;
    const wanted = job === "provider-lifecycle" ? `${mustSucceed} || test "\${{ needs.${job}.result }}" = skipped` : mustSucceed;
    assert.ok(checks.includes(wanted), `the gate must fail when ${job} did not succeed`);
  }
});

test("CI exercises the early refusal on real Node 20 without installing the kernel's dependencies", () => {
  const workflow = parseConfigData(readFileSync(new URL("../.github/workflows/pull-request.yml", import.meta.url))).value;
  const job = workflow.jobs["unsupported-node"];
  const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(Number(setup.with["node-version"]), 20);
  assert.deepEqual(job.steps.filter((step) => step.run).map((step) => step.run), ["node scripts/check-unsupported-node.mjs"]);
  for (const part of [job, ...job.steps]) {
    assert.equal(part.if, undefined);
    assert.equal(part["continue-on-error"], undefined);
  }
});

test("pull-request CI runs the Desktop suite with only packages/desktop installed, as the release does", () => {
  const read = (name) => parseConfigData(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url))).value;
  const DESKTOP = "packages/desktop", INSTALL = /\bnpm\s+(ci|i|install|clean-install)\b/;
  // Every command line a job runs, with the directory it runs in (the repository root unless the step names one).
  const commands = (job) => job.steps.filter((step) => step.run).flatMap((step) => step.run.split("\n")
    .map((line) => line.trim()).filter(Boolean).map((line) => ({ line, dir: step["working-directory"] ?? "." })));
  const using = (job, action) => job.steps.find((step) => step.uses?.startsWith(`actions/${action}@`));

  // release.yml's desktop-build installs and tests in packages/desktop only, never at the
  // root. The shards install the root first, so they cannot see a Desktop test that reaches
  // a root-only dependency: this job is the one place pull-request CI runs it as the tag will.
  const job = read("pull-request.yml").jobs["desktop-standalone"];
  assert.ok(job, "pull-request CI must run the Desktop suite with a Desktop-only install");
  assert.equal(job["runs-on"], "ubuntu-latest");
  for (const { line, dir } of commands(job)) {
    assert.ok(!INSTALL.test(line) || dir === DESKTOP, `the Desktop-only job must not install outside ${DESKTOP}: \`${line}\` runs in ${dir}`);
  }
  const standalone = [{ line: "npm ci", dir: DESKTOP }, { line: "npm test", dir: DESKTOP }];
  assert.deepEqual(commands(job), standalone, "the Desktop-only job runs npm ci, then npm test, in packages/desktop, and nothing else");
  // A red run must stay red: nothing skips the job or a step, and no failure is tolerated.
  for (const part of [job, ...job.steps]) {
    assert.equal(part.if, undefined, "no condition may skip the Desktop-only job or one of its steps");
    assert.equal(part["continue-on-error"], undefined, "a Desktop-only failure must fail the job");
  }

  // Parity with the release: before packaging, desktop-build runs exactly these commands, on
  // the same Node and the same shallow checkout. Change how the release installs or tests
  // Desktop and this fails until the pull-request job is changed with it.
  const build = read("release.yml").jobs["desktop-build"];
  const dist = build.steps.find((step) => /^\s*npm run dist(\s|$)/m.test(step.run ?? ""));
  assert.ok(dist, "release desktop-build packages with npm run dist");
  const block = commands({ steps: [dist] });
  assert.deepEqual(block.slice(0, block.findIndex(({ line }) => /^npm run dist(\s|$)/.test(line))), standalone,
    "release desktop-build no longer runs npm ci then npm test in packages/desktop before npm run dist: change the desktop-standalone job with it");
  // Up to packaging, the release installs only in packages/desktop. After it, the Linux launch's fixture
  // onboards with this repository's kernel, so one root install may precede that launch, and nothing else.
  const distAt = build.steps.indexOf(dist);
  assert.deepEqual(commands({ steps: build.steps.slice(0, distAt + 1) }).filter(({ line }) => INSTALL.test(line)), [standalone[0]],
    "release desktop-build installs somewhere else too: the desktop-standalone job must install the same way");
  for (const step of build.steps.slice(distAt + 1).filter((entry) => INSTALL.test(entry.run ?? ""))) {
    assert.equal(step.run.trim(), "npm ci", "after packaging, only the launch fixture's root install");
    assert.equal(step["working-directory"], undefined, "the launch fixture's install is at the root");
    assert.equal(step.if, "runner.os == 'Linux'", "the launch fixture's install runs on the Linux leg only, as the launch does");
  }
  assert.equal(using(job, "setup-node").with["node-version"], using(build, "setup-node").with["node-version"]);
  for (const checkout of [using(job, "checkout"), using(build, "checkout")]) {
    assert.equal(checkout.with?.["fetch-depth"], undefined, "both check out shallow: history a Desktop test needs is missing at the tag too");
    // "Desktop only" is what is INSTALLED, not what is checked out. The Desktop imports the shared
    // home (packages/client) by relative path and its suite reads it, so both jobs check out the
    // whole tree: a checkout narrowed to packages/desktop would have no ../client.
    assert.equal(checkout.with?.["sparse-checkout"], undefined, "both check out the whole repository: packages/client is beside packages/desktop");
    assert.equal(checkout.with?.path, undefined, "both check out at the workspace root, so packages/desktop/../client is packages/client");
  }
  for (const part of [job, build]) {
    for (const step of part.steps.filter((entry) => entry["working-directory"])) {
      assert.equal(step["working-directory"], DESKTOP, "the Desktop jobs run from packages/desktop, from where ../client is the shared home");
    }
  }
  // Pull-request CI has no path filter: a change to packages/client alone runs the Desktop suite too.
  const pullRequest = read("pull-request.yml");
  assert.equal(pullRequest.on.pull_request.paths, undefined);
  assert.equal(pullRequest.on.pull_request["paths-ignore"], undefined);
});

test("pull-request CI runs every schedule of the session-provider lifecycle for a change that touches it, a nightly run does on main, and the gate requires the job", async () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const workflow = parseConfigData(read(".github/workflows/pull-request.yml")).value;
  // The shards run a seeded sample of the explorer's schedules (test/session-provider-explorer.test.mjs)
  // on every change; this job runs them all, by one command, the one a developer runs locally.
  const job = workflow.jobs["provider-lifecycle"];
  assert.ok(job, "pull-request CI must have the job that runs every schedule of the session-provider lifecycle");
  const commands = job.steps.filter((step) => step.run).map((step) => step.run.trim());
  assert.deepEqual(commands, ["node scripts/provider-lifecycle-changed.mjs", "npm ci", "npm run test:provider-lifecycle"]);
  assert.equal(JSON.parse(read("package.json")).scripts["test:provider-lifecycle"], "node scripts/test-provider-lifecycle.mjs");
  assert.match(read("scripts/test-provider-lifecycle.mjs"), /OATS_EXPLORER_COUNT: "all"/, "the script asks for every schedule");
  // The job always runs, and decides in a step of its own whether the change touches the
  // lifecycle: a job skipped as a whole would leave the gate nothing to wait on. Only the two
  // steps after that decision are conditional, on its answer and nothing else, and no failure
  // is tolerated: a red run stays red.
  const decision = job.steps.find((step) => step.id === "changes");
  assert.deepEqual([job.if, decision.if, { ...decision.env }], [undefined, undefined, { BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.before }}", HEAD_SHA: "${{ github.sha }}" }]);
  assert.deepEqual(job.steps.filter((step) => step.if !== undefined).map((step) => [step.run, step.if]), [["npm ci", "steps.changes.outputs.run != 'false'"], ["npm run test:provider-lifecycle", "steps.changes.outputs.run != 'false'"]], "only an explicit false skips: a decision that wrote nothing runs every schedule");
  assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/checkout")).with["fetch-depth"], 0, "the decision compares with the base: it needs the history");
  for (const part of [job, ...job.steps]) assert.equal(part["continue-on-error"], undefined, "no failure may be tolerated");
  assert.ok(workflow.jobs.gate.needs.includes("provider-lifecycle"));

  // What counts as touching the lifecycle, and what the decision answers when it cannot tell.
  const { LIFECYCLE_FILES, decide, touchesLifecycle } = await import("../scripts/provider-lifecycle-changed.mjs");
  // The list the release lane decided (every schedule is required for a change to any of these)…
  for (const file of ["lib/core.mjs", "lib/session-providers.mjs", "lib/session-inspect.mjs", "lib/session-resume.mjs", "lib/session-end.mjs", "lib/provider-call-child.mjs", "lib/provider-resume.mjs", "lib/provider-test-seams.mjs",
    "lib/instance-lifecycle.mjs", "lib/retire-admission.mjs", "lib/hook-env.mjs", "test/session-provider-explorer.test.mjs", "test/session-provider-lifecycle.test.mjs", "test/session-providers.test.mjs",
    "test/helpers/session-provider-fixture.mjs", "test/helpers/session-provider-verb.mjs", "scripts/test-provider-lifecycle.mjs", "docs/design/2026-11-20-provider-home-lifecycle.md", ".github/workflows/pull-request.yml"]) {
    assert.equal(touchesLifecycle([file]), true, file);
  }
  // …widened by what the explorer's invariants also stand on: the CLI its verbs run through, the
  // status rows, the claim, the locks, the home's events and the record's writer, process liveness
  // and process groups, the fixtures' deployment, and what decides and runs this.
  for (const file of ["bin/oats.mjs", "lib/instance-listing.mjs", "lib/claim.mjs", "lib/dir-lock.mjs", "lib/instance-events.mjs", "lib/write-through-private-file.mjs",
    "lib/worktree-hooks.mjs", "lib/process-group.mjs", "packages/record/lib/process-identity.mjs", "test/helpers/v2-deployment.mjs",
    "scripts/provider-lifecycle-changed.mjs", ".github/workflows/provider-lifecycle-nightly.yml",
    // What a provider home may run (its receipt's record of it), and the receipt's own leaf.
    "lib/home-integrity.mjs", "lib/session-receipt.mjs"]) {
    assert.equal(touchesLifecycle([file]), true, file);
  }
  for (const file of ["lib/servers.mjs", "lib/sessions.mjs", "lib/providers.mjs", "docs/capabilities.md", "packages/desktop/src/app.mjs", "test/session-restart.test.mjs", "test/helpers/fixtures.mjs", "lib/session-x/y.mjs"]) assert.equal(touchesLifecycle([file]), false, file);
  for (const file of LIFECYCLE_FILES) assert.doesNotThrow(() => read(file), `${file} is a file of this repository`);
  const changed = (files) => () => files;
  assert.equal(decide({ base: "a", head: "b", changed: changed(["docs/capabilities.md", "lib/core.mjs"]) }).run, true);
  assert.equal(decide({ base: "a", head: "b", changed: changed(["docs/capabilities.md"]) }).run, false);
  assert.equal(decide({ base: "a", head: "b", changed: changed([]) }).run, false);
  // No base (a new branch's first push), or a change that cannot be listed: every schedule runs.
  assert.equal(decide({ base: "0000000000000000000000000000000000000000", head: "b", changed: changed([]) }).run, true);
  assert.equal(decide({ base: undefined, head: "b", changed: changed([]) }).run, true);
  assert.equal(decide({ base: "a", head: "b", changed: () => { throw new Error("bad revision"); } }).run, true);

  // Every night on main, with no condition at all: what sees a change elsewhere that breaks an ordering.
  const nightly = parseConfigData(read(".github/workflows/provider-lifecycle-nightly.yml")).value;
  assert.ok(Array.isArray(nightly.on.schedule) && typeof nightly.on.schedule[0].cron === "string", "it runs on a schedule");
  assert.deepEqual({ ...nightly.permissions }, { contents: "read" }, "the run of the repository's code may write nothing");
  const every = nightly.jobs["provider-lifecycle"];
  assert.deepEqual(every.steps.filter((step) => step.run).map((step) => step.run.trim()), ["npm ci", "npm run test:provider-lifecycle"]);
  // It fails loudly. The run is red: nothing is tolerated, nothing skips the schedules, and a
  // schedule that never settles fails its step by the step's own bound (under the job's, whose
  // timeout would cancel the job, and a cancelled job is no failure).
  for (const part of [every, ...every.steps]) assert.deepEqual([part.if, part["continue-on-error"]], [undefined, undefined]);
  const schedules = every.steps.find((step) => step.run?.trim() === "npm run test:provider-lifecycle");
  assert.ok(schedules["timeout-minutes"] < every["timeout-minutes"], "the step's bound is under the job's");
  assert.equal(every.steps.find((step) => step.uses?.startsWith("actions/checkout")).with["persist-credentials"], false, "the token stays out of the checkout the install and the tests run in");
  // And a job of its own says so in an issue, on a failure only: the one job that may write an
  // issue, with no checkout and none of the repository's code.
  const report = nightly.jobs.report;
  assert.deepEqual([report.needs, report.if, { ...report.permissions }, report.steps.some((step) => step.uses !== undefined)], ["provider-lifecycle", "failure()", { issues: "write" }, false]);
  assert.deepEqual([report.steps.length, /gh issue create/.test(report.steps[0].run), /gh issue comment/.test(report.steps[0].run)], [1, true, true]);
});

test("pull-request CI runs the suites that followed a session variable with every one poisoned, and the gate requires it", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const workflow = parseConfigData(read(".github/workflows/pull-request.yml")).value;
  // awebai/oats#972: the shards run with none of a session's variables, so only this job sees a
  // test that reads one. It is one command, the one a developer runs locally.
  const job = workflow.jobs["session-inheritance"];
  assert.ok(job, "pull-request CI must run the suites under a poisoned session");
  assert.equal(job["runs-on"], "ubuntu-latest");
  const commands = job.steps.filter((step) => step.run).map((step) => step.run.trim());
  assert.deepEqual(commands, ["npm ci", "npm run test:session"], "it installs the root and runs the poisoned session, and nothing else");
  assert.equal(JSON.parse(read("package.json")).scripts["test:session"], "node scripts/test-session-inheritance.mjs");
  // A red run must stay red: nothing skips the job or a step, no failure is tolerated, and no
  // step gives the run an environment of its own in place of the script's.
  for (const part of [job, ...job.steps]) {
    assert.equal(part.if, undefined, "no condition may skip the job or one of its steps");
    assert.equal(part["continue-on-error"], undefined, "a failure under the poisoned session must fail the job");
    assert.equal(part.env, undefined, "the run's environment is the script's to build");
  }
  // The gate fails when it fails: needed, and its result tested (`always()` runs the gate anyway).
  const gate = workflow.jobs.gate;
  assert.ok(gate.needs.includes("session-inheritance"));
  assert.ok(gate.steps.flatMap((step) => (step.run ?? "").split("\n").map((line) => line.trim())).includes('test "${{ needs.session-inheritance.result }}" = success'));

  // The run's names are the helpers' own definition, not a second list: every name of it, and for
  // each prefix the names a session really has and one that nothing knows.
  const poison = poisonedSession(), names = Object.keys(poison);
  for (const name of SESSION_VARIABLES.names) assert.ok(names.includes(name), `the run does not set ${name}`);
  for (const prefix of SESSION_VARIABLES.prefixes) {
    assert.ok(names.filter((name) => name.startsWith(prefix)).length >= 2, `the run sets no name of the session, or none that nothing knows, under ${prefix}`);
    assert.ok(names.some((name) => name.startsWith(prefix) && /NOTHING_KNOWS_THIS$/.test(name)), `no unknown name under ${prefix}`);
  }
  for (const name of ["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "AWEB_IDENTITY_HOME", "AWEB_DELIVERY"]) assert.ok(names.includes(name), `the run does not set ${name}, which an instance's session has`);
  for (const name of names) assert.ok(isSessionVariable(name), `the run sets ${name}, which the definition does not cover: no helper removes it`);
  // Values that cannot work: no directory, home or socket the run names exists.
  for (const [name, value] of Object.entries(poison)) {
    assert.ok(value.length > 0, name);
    for (const path of value.split(",").filter((part) => part.startsWith("/"))) assert.equal(existsSync(path), false, `${name} names ${path}, which exists`);
  }
  // The suites that followed one are all still run, and exist.
  for (const suite of ["test/capabilities.test.mjs", "test/golden-fixtures.test.mjs", "test/harness-trust-launch.test.mjs", "test/login-environment.test.mjs"]) assert.ok(SESSION_SUITES.includes(suite), `the run no longer covers ${suite}`);
  for (const suite of SESSION_SUITES) assert.ok(existsSync(new URL(`../${suite}`, import.meta.url)), `${suite} does not exist`);
});
