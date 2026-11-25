// The terms both hand-started test workflows share (.github/workflows/macos-tests.yml and
// linux-tests.yml), pinned by reading their files: the one trigger, the read-only token, no secret,
// no artifact, no cache step, no input in a shell line, the two trees, the bounds, a concurrency
// group per run. test/macos-tests-workflow.test.mjs and test/linux-tests-workflow.test.mjs call
// these with what is each workflow's own; docs/named-test-runs.md states the terms.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseConfigData } from "../../lib/config-data.mjs";
import { MAX_FILES } from "../../scripts/named-test-run.mjs";

const DIR = new URL("../../.github/workflows/", import.meta.url);
const text = (name) => readFileSync(new URL(name, DIR), "utf8");
// As plain objects: the reader builds its values without a prototype, and deepEqual tells the two apart.
export const read = (name) => JSON.parse(JSON.stringify(parseConfigData(text(name)).value));
/** The page that owns both workflows. */
export const page = () => readFileSync(new URL("../../docs/named-test-runs.md", import.meta.url), "utf8");

/** A workflow file → { file, workflow, source, job, steps }. */
export function load(file) {
  const workflow = read(file);
  return { file, workflow, source: text(file), job: workflow.jobs.run, steps: workflow.jobs.run.steps };
}

/** Every string of a parsed document, with the keys that lead to it. */
function strings(value, path = []) {
  if (typeof value === "string") return [{ value, path }];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, child]) => strings(child, [...path, key]));
  return [];
}
export const using = (document, action) => Object.values(document.jobs).flatMap((j) => j.steps ?? []).filter((step) => step.uses?.split("@")[0] === action || step.uses?.startsWith(`${action}/`));

/** Started by hand and by nothing else, with the input names given, `ref` and `files` required strings. */
export function assertDispatchOnly({ workflow }, inputNames) {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"], "no push, pull_request or schedule trigger");
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(Object.keys(inputs), inputNames, "the bounds are the script's constants, not inputs");
  for (const name of ["ref", "files"]) assert.deepEqual({ required: inputs[name].required, type: inputs[name].type }, { required: true, type: "string" });
}

/** The token reads contents only, no secret is named, and no step uploads an artifact or saves or
 *  restores a cache. */
export function assertReadOnly({ workflow, source, job, steps }) {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["run"]);
  assert.equal(job.permissions, undefined, "the job widens nothing");
  // Its check is its own: a run must never read as one of pull-request CI's, the gate above all.
  const ciNames = Object.entries(read("pull-request.yml").jobs).flatMap(([key, j]) => [key, j.name]);
  assert.ok(ciNames.includes("Node 22 / test, validate, pack, smoke") && !ciNames.includes(job.name) && !ciNames.includes("run"), `the job's name or key is one of pull-request CI's: ${job.name}`);
  for (const word of ["secrets.", "github.token", "GITHUB_TOKEN"]) assert.ok(!source.includes(word), `the workflow names ${word}`);
  // The two actions pull-request CI uses, as it references them, and no other: no
  // actions/upload-artifact, no actions/cache.
  assert.deepEqual(steps.filter((step) => step.uses).map((step) => step.uses), ["actions/checkout@v4", "actions/setup-node@v4"]);
  // No `cache:`: a cache written here would be in the scope of the branch the run belongs to,
  // which is the default branch's for a run that counts as evidence, and every branch reads that.
  // (A later major of actions/setup-node caches by itself where package.json names a package
  // manager: moving off v4 needs its switch for that turned off, and this line changed with it.)
  assert.deepEqual(using(workflow, "actions/setup-node")[0].with, { "node-version": 22 });
  const ciTests = read("pull-request.yml").jobs.tests;
  assert.equal(using({ jobs: { tests: ciTests } }, "actions/setup-node")[0].with["node-version"], 22, "Node as pull-request CI's test shards");
}

/** No input is written into a shell line: inputs appear `inputCount` times (`inputsWhy` says where),
 *  only under `env:` and `if:`, and the shell lines are exactly `runLines`. */
export function assertNoInputInShell({ workflow, steps }, { inputCount, inputsWhy, runLines }) {
  const all = strings(workflow);
  for (const step of steps.filter((s) => s.run !== undefined)) {
    assert.ok(!step.run.includes("${{"), `an expression in a shell line: ${step.run}`);
    assert.ok(!/\binputs\b|github\.event/.test(step.run), `an input in a shell line: ${step.run}`);
  }
  // An expression is expanded before the step exists. Under `env:` and `with:` it becomes a value,
  // under `if:` a condition; anywhere else it could become part of what runs.
  const placed = ({ path }) => path.at(-1) === "if" || path.includes("env") || path.includes("with") || path.join(".") === "concurrency.group";
  for (const s of all.filter(({ value }) => value.includes("${{"))) assert.ok(placed(s), `an expression outside env:, with: and if: at ${s.path.join(".")}`);
  for (const s of all.filter(({ value }) => value.includes("inputs."))) assert.ok(placed(s) && s.path.join(".") !== "concurrency.group", `an input outside env:, with: and if: at ${s.path.join(".")}`);
  assert.equal(all.filter(({ value }) => value.includes("inputs.")).length, inputCount, inputsWhy);
  // The shell lines themselves, whole: nothing else runs.
  assert.deepEqual(steps.filter((s) => s.run !== undefined).map((s) => s.run), runLines);
}

/** Two trees, and the request is validated before anything of the ref is installed or run → the
 *  index of the validation step. `script` is the command that runs the runner's script, `request`
 *  the validation and run steps' `env:`, `conditional` every step with an `if:`. */
export function assertTwoTrees({ workflow, job, steps }, { script, request, conditional }) {
  // The checkout is the workflow's own commit (no `ref:`), in `runner/`, with every branch and tag
  // of origin and without the token in its configuration.
  assert.deepEqual(using(workflow, "actions/checkout")[0].with, { path: "runner", "fetch-depth": 0, "persist-credentials": false });
  const at = (line) => steps.findIndex((step) => step.run === line), prepare = at(`${script} prepare tested`), run = at(`${script} run tested`);
  assert.deepEqual(steps[prepare].env, request);
  assert.deepEqual(steps[run].env, request);
  // Every step that works in the ref's tree comes after the validation, and the run is the last.
  const inTree = steps.map((step, i) => ({ step, i })).filter(({ step }) => step["working-directory"] !== undefined);
  assert.deepEqual(inTree.map(({ step }) => [step.run, step["working-directory"], step.env ?? null]), [
    ["npm ci", "tested", null],
    ["npm ci", "tested/packages/desktop", { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" }],
  ], "the installs are pull-request CI's shards', in the ref's tree");
  assert.ok(inTree.every(({ i }) => i > prepare && i < run));
  assert.equal(run, steps.length - 1);
  // The same installs as the shards: change how pull-request CI installs and this fails until the
  // workflow is changed with it.
  const shard = read("pull-request.yml").jobs.tests.steps.filter((step) => step.run === "npm ci");
  assert.deepEqual(shard.map((step) => [step["working-directory"] ?? ".", step.env ?? null]), [[".", null], ["packages/desktop", { ELECTRON_SKIP_BINARY_DOWNLOAD: "1" }]]);
  // A red step stays red, and only the steps named are conditional.
  for (const part of [job, ...steps]) assert.equal(part["continue-on-error"], undefined);
  assert.deepEqual(steps.filter((step) => step.if !== undefined).map((step) => [step.run, step.if, step.env]), conditional);
  assert.equal(job.if, undefined);
  return prepare;
}

/** A job timeout that is the runner's constant and holds its bounds (and `extraMs` more), and a
 *  concurrency group no run shares. */
export function assertBoundsAndConcurrency({ file, workflow, job }, { prefix, fileTimeoutMs, jobTimeoutMinutes, extraMs = 0 }) {
  assert.equal(job["timeout-minutes"], jobTimeoutMinutes);
  assert.ok(MAX_FILES * fileTimeoutMs + extraMs < jobTimeoutMinutes * 60_000, "the job outlasts a run of the most files, each at its timeout");
  // GitHub ends a job on a hosted runner after 6 hours whatever its timeout says.
  assert.ok(jobTimeoutMinutes <= 360, "the job's timeout is within GitHub's limit for a job");
  // One group per run and no cancelling: a fixed group would let a third run cancel the pending second.
  assert.deepEqual(workflow.concurrency, { group: `${prefix}-\${{ github.run_id }}`, "cancel-in-progress": false });
  for (const name of readdirSync(DIR).filter((other) => other !== file)) {
    assert.ok(!String(read(name).concurrency?.group ?? "").startsWith(prefix), `${name} uses this workflow's concurrency group`);
  }
}

/** The page that owns the workflows states this one's bounds as the script has them, names its two
 *  steps and its job, and states its name as the guard contract. */
export function assertPage({ workflow, job, steps }, { script, fileTimeoutMs, jobTimeoutMinutes }) {
  const text = page();
  for (const bound of [`at most ${MAX_FILES} files`, `${fileTimeoutMs / 60_000} minutes`, `${jobTimeoutMinutes} minutes`, job["runs-on"]]) {
    assert.ok(text.includes(bound), `docs/named-test-runs.md does not state: ${bound}`);
  }
  // The page sends a reader to two steps of the log by name: the names are the workflow's.
  for (const line of [`${script} prepare tested`, `${script} run tested`]) {
    const { name } = steps.find((step) => step.run === line);
    assert.ok(text.includes(`**${name}**`), `docs/named-test-runs.md does not name the step: ${name}`);
  }
  // And says under which name a run is among a commit's check runs: the job's.
  assert.ok(text.includes(`\`${job.name}\``), `docs/named-test-runs.md does not name the job: ${job.name}`);
  // Test files guard on the workflow's name: the page's guard contract states it exactly.
  const guard = text.slice(text.indexOf("## Guard contract"));
  assert.ok(text.includes("## Guard contract") && guard.includes(`\`GITHUB_WORKFLOW\` is \`${workflow.name}\``), `docs/named-test-runs.md's guard contract does not state the name: ${workflow.name}`);
}
