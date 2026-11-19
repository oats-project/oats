// No workflow in this repository restores an Actions cache. A workflow here runs a branch's code
// in the default branch's cache scope, and every pull request's CI reads that scope: a restored
// entry would stand between a job and its result. Nothing here reads a cache at all, and this
// pins it for every file under .github/workflows/, whatever files exist there.
//
// The rule can only speak for an action somebody has read, at the version that was read. So one
// table below says what was read, and a workflow may use what it holds and nothing else: not an
// action off the table, not another ref of a listed one, not a local action, not a reusable
// workflow, whose steps are in another file.
//
// The same table holds the release workflow to the code that was read. release.yml publishes, so
// it names every action by the full commit id of a row, and so does build-installers.yml, whose
// installer steps are release.yml's, and tui-macos.yml, by the release lane's call. Every other
// workflow names the major of a row by its tag.
//
// The system release.yml and build-installers.yml run on is the same question one layer down, and
// those two answer it the same way: every job of theirs runs on a runner of the list below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseConfigData } from "../lib/config-data.mjs";

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url);
const WHY = "No workflow in this repository restores an Actions cache: a workflow here runs a branch's code in the default branch's cache scope, which every pull request's CI reads.";

/** The majors of actions/setup-node that never cache unless asked to: their action.yml has the
 *  `cache` input and no `package-manager-cache`. From v5 on (read at the tags v5, v6 and v7) the
 *  action has `package-manager-cache`, `default: true`: it caches by itself when package.json
 *  names a package manager, unless that input is false. v4 does not know the input and would
 *  warn about it, so a v4 step is kept from caching by its major, a later one by the input. */
const SETUP_NODE_WITHOUT_AUTOMATIC_CACHE = /^v[1-4](\.\d+){0,2}$/;

/** What was read: each action a workflow here may use, at the commit that was read for whether
 *  the action saves or restores a cache by itself, with the exact version whose tag pointed at
 *  that commit. Both rules of this file read it, and there is no other list.
 *
 *  A row gives a workflow two refs and no other. Its `id` is the ref of the files that name actions
 *  by commit (BY_ID). The major of its `version` (`v4` of `v4.4.0`) is the ref of every other
 *  workflow, by its tag. A later major is another program until it is read; a minor or patch
 *  tag, a branch and a commit that is not a row are not in the table either.
 *
 *  Of these only actions/setup-node can cache, and two rules hold it together. The table says
 *  which of its versions were read. `restoresCache` below says what a step of a version must
 *  carry, and it takes the version of a commit id from the row: adding a row does not satisfy
 *  it. A version that caches by itself (v5 and later) still needs `package-manager-cache: false`
 *  on every step, by its id as by its tag. */
const ACTIONS_READ = [
  { action: "actions/checkout", id: "11d5960a326750d5838078e36cf38b85af677262", version: "v4.4.0" },
  { action: "actions/setup-node", id: "49933ea5288caeca8642d1e84afbd3f7d6820020", version: "v4.4.0" },
  { action: "actions/upload-artifact", id: "ea165f8d65b6e75b540449e92b4886f43607fa02", version: "v4.6.2" },
  { action: "actions/download-artifact", id: "d3f86a106a0bac45b974a628896c90dbdf5c8093", version: "v4.3.0" },
  { action: "actions/attest-build-provenance", id: "ef244123eb79f2f7a7e75d99086184180e6d0018", version: "v1.4.4" },
];
/** The two files that publish: release.yml and build-installers.yml, whose installer steps are
 *  release.yml's. They run on the runners of the list below. */
const RELEASE_FILES = ["release.yml", "build-installers.yml"];
/** The files that name every action by a row's commit id: the two that publish, and
 *  tui-macos.yml, the TUI's tests on macOS at pull-request time, by the release lane's call
 *  (2026-10-27). The workflows outside them keep tags, and that is the decision, not an
 *  oversight: nothing is published from them, and an id there is upkeep nobody decided to take
 *  on. `usesUnreadAction` holds both halves. */
// Team image verification also requires immutable action references.
const BY_ID = [...RELEASE_FILES, "tui-macos.yml", "team-image.yml"];
/** Names said as a person lists them: `a and b`, `a, b and c`. */
const listed = (names) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const FULL_ID = /^[0-9a-f]{40}$/;
const HOW_TO_ADD = "A row is added to the table of actions that were read by whoever has read that commit for whether the action saves or restores a cache by itself: its action.yml, the actions and packages it depends on, and what its entry points call of a cache. Its id is the commit that an exact version tag of the action's own repository points at (docs/release-lane.md, \"The workflow's actions are named by commit\").";

const majorOf = (version) => version.split(".")[0];
const rowsOf = (action, table) => table.filter((row) => row.action === action);
const majorsOf = (rows) => [...new Set(rows.map((row) => majorOf(row.version)))];
const held = (rows) => rows.map((row) => `${row.id} (${row.version})`).join(", ");

/** A `uses` value as { action, ref }: the action's name in lower case (the runner matches it
 *  whatever its case) and what follows the last `@`. A local action has no ref. */
function parseUses(uses) {
  const at = uses.lastIndexOf("@");
  return { action: (at < 0 ? uses : uses.slice(0, at)).toLowerCase(), ref: at < 0 ? "" : uses.slice(at + 1) };
}
/** Why `step` uses an action, or a ref of one, nobody has read for this rule; null when the
 *  table holds it, or the step uses no action. The name must be a row's exactly: a path under a
 *  listed action (`actions/cache/save`) is another action. So must the ref. With `byId` (a step
 *  of the files of BY_ID) it is a row's id, 40 lower-case hexadecimal characters; otherwise it is the
 *  major of a row's version: `v4`, and not `v4.1.0`, `V4`, `main` or an id. */
function usesUnreadAction(step, { byId = false, table = ACTIONS_READ } = {}) {
  if (step?.uses === undefined) return null;
  if (typeof step.uses !== "string") return "its `uses` is not a string";
  const { action, ref } = parseUses(step.uses);
  if (action.startsWith("./") || action.startsWith("../")) return `it uses the local action ${step.uses}: its steps are not in the workflow file, so the rule cannot read them`;
  const rows = rowsOf(action, table);
  if (!rows.length) return `it uses ${step.uses}, which is not in the table of actions that were read (${[...new Set(table.map((row) => row.action))].join(", ")}). ${HOW_TO_ADD}`;
  if (byId) {
    if (rows.some((row) => row.id === ref)) return null;
    if (!FULL_ID.test(ref)) return `it uses ${step.uses}: ${listed(BY_ID)} name every action by a full commit id, 40 lower-case hexadecimal characters, and the table of actions that were read holds ${action} at ${held(rows)}`;
    return `it uses ${step.uses}, a commit that is not in the table of actions that were read, which holds ${action} at ${held(rows)}. ${HOW_TO_ADD}`;
  }
  const majors = majorsOf(rows);
  if (majors.includes(ref)) return null;
  if (/^[0-9a-f]{40}$/i.test(ref)) return `it uses ${step.uses}: only ${listed(BY_ID)} name an action by commit id, and every other workflow keeps the tag of a major that was read (${majors.map((major) => `${action}@${major}`).join(", ")})`;
  return `it uses ${step.uses}, and the table of actions that were read holds ${action} at ${majors.join(", ")}: a ref is the major of a version that was read exactly, not a later major, a minor or patch tag, or a branch. ${HOW_TO_ADD}`;
}
/** Why a job is refused as a whole; null when its steps are its own. A job that calls a reusable
 *  workflow (`uses:` on the job) has its steps in another file, or another repository. */
function callsWorkflow(definition) {
  return definition?.uses === undefined ? null : `it calls the reusable workflow ${definition.uses}: its steps are not in the workflow file, so the rule cannot read them`;
}

/** The runners that were decided: the labels a job of the two files may run on, and no other.
 *  Each is a system of GitHub's own, named by its version, that somebody chose for the release
 *  and its installers, as each row of the table above is an action somebody read. The form of a
 *  label is not the rule: `build-1` has the form of a version's name and would be somebody's own
 *  runner. A label is added by whoever decides the runner, in a pull request that changes it in
 *  the two files as well and says what the installers then need. */
const RELEASE_RUNNERS = ["ubuntu-24.04", "macos-15"];
/** What a label of the list must still be: a system's name with its version (`macos-15-large`
 *  too). It is the one thing the list cannot say of itself: with `ubuntu-latest` on it, every
 *  job would pass on a label that GitHub moves to another system on a date of its own. */
const VERSIONED_RUNNER = /^[a-z]+-\d+(\.\d+)?(-[a-z0-9]+)*$/;
/** The runner labels a job can run on, { labels }, or { why } when the rule cannot read them. A
 *  `runs-on` is one label, or `${{ matrix.<key> }}`, whose values are that key's in the job's
 *  own matrix: its list, and each leg of `include`. Anything else (another expression, a list of
 *  labels, a runner group, a matrix that is itself an expression, a leg without the key) could
 *  run the job on a system the file does not name, so it is refused and not guessed. */
function runnerLabels(definition) {
  const runsOn = definition?.["runs-on"];
  if (typeof runsOn !== "string") return { why: `its \`runs-on\` is ${runsOn === undefined ? "missing" : "not a single label"}: the rule cannot read which system it runs on` };
  if (!runsOn.includes("${{")) return { labels: [runsOn] };
  const key = /^\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}$/.exec(runsOn)?.[1];
  const matrix = definition.strategy?.matrix;
  const unread = { why: `its \`runs-on\` is ${runsOn}, which the rule cannot resolve to the labels it stands for` };
  if (!key || !matrix || typeof matrix !== "object") return unread;
  const listed = matrix[key] ?? [], legs = matrix.include ?? [];
  if (!Array.isArray(listed) || !Array.isArray(legs)) return unread;
  // A leg of `include` without the key takes the list's values when there is a list; without a
  // list it would leave the label empty.
  const labels = [...listed, ...legs.filter((leg) => listed.length === 0 || leg?.[key] !== undefined).map((leg) => leg?.[key])];
  if (!labels.length || labels.some((label) => typeof label !== "string" || label.includes("${{"))) return unread;
  return { labels: [...new Set(labels)] };
}
/** Why a job of the two files runs on a system nobody decided; null when every label it can run
 *  on is on the list, exactly as the list spells it. */
function runsOnUnlistedRunner(definition, runners = RELEASE_RUNNERS) {
  const { labels, why } = runnerLabels(definition);
  if (why) return why;
  const unlisted = labels.filter((label) => !runners.includes(label));
  return unlisted.length ? `it runs on ${unlisted.join(", ")}, not on the list of runners (${runners.join(", ")}): the release and its installers are built on a system somebody decided. A label is added to the list by whoever decides the runner, in a pull request that says what the installers then need (docs/release-lane.md, "The workflow's actions are named by commit")` : null;
}

/** The actions that `steps` name by more than one ref, as `action: ref, ref`. The files of BY_ID
 *  name one commit an action, whatever the table holds: the two that publish are one release's
 *  steps, and tui-macos.yml names release.yml's. */
function namedBySeveralRefs(steps) {
  const refs = new Map();
  for (const step of steps) {
    if (typeof step?.uses !== "string") continue;
    const { action, ref } = parseUses(step.uses);
    refs.set(action, (refs.get(action) ?? new Set()).add(ref));
  }
  return [...refs].filter(([, of]) => of.size > 1).map(([action, of]) => `${action}: ${[...of].join(", ")}`);
}
/** Every `uses:` line of a workflow's text, as { uses, comment }: the comment is what follows the
 *  `#` on that line. The reader of YAML drops comments, and the version beside an id is one. */
function usesLines(text) {
  return text.split("\n").map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*?))?\s*$/.exec(line)).filter(Boolean).map(([, uses, comment]) => ({ uses, comment: comment ?? "" }));
}
/** Why the comment beside an id misleads its reader; null when it is the row's version exactly,
 *  or the id is no row's (which `usesUnreadAction` refuses). An id says nothing to a reviewer:
 *  the version beside it is what a pull request that moves it is read by. */
function versionNotBeside({ uses, comment }, table = ACTIONS_READ) {
  const { action, ref } = parseUses(uses);
  const row = rowsOf(action, table).find(({ id }) => id === ref);
  if (!row || comment === row.version) return null;
  return `${uses} is ${row.version} in the table of actions that were read, and the comment beside it ${comment ? `says \`${comment}\`` : "is missing"}: the id and its version are changed together`;
}

const isFalse = (value) => value === false || value === "false";
/** A step's inputs by lower-cased name: the runner matches an input's name whatever its case
 *  (`CACHE: npm` is the action's `cache`), so the rule does too. */
const inputsOf = (step) => new Map(Object.entries(step?.with ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
/** Why `step` restores an Actions cache, or could begin to by itself; null when it cannot. A
 *  `cache` input is refused whatever its value: no step names a cache at all, and what turns a
 *  later actions/setup-node's own caching off is its `package-manager-cache`, not `cache`.
 *
 *  An actions/setup-node named by a commit id is the version its row gives: the row's `v4.4.0`
 *  is kept from caching by its major, as the tag `v4` is, and needs no input it does not know.
 *  An id that is no row's has no version to go by, and is refused whatever its inputs. */
function restoresCache(step, table = ACTIONS_READ) {
  if (typeof step?.uses !== "string") return null;
  const { action, ref } = parseUses(step.uses);
  const inputs = inputsOf(step);
  if (action === "actions/cache" || action === "actions/cache/restore") return `it uses ${step.uses}`;
  if (inputs.has("cache")) return `it gives ${step.uses} the input \`cache: ${inputs.get("cache")}\``;
  if (action !== "actions/setup-node") return null;
  const row = rowsOf(action, table).find(({ id }) => id === ref);
  if (!row && /^[0-9a-f]{40}$/i.test(ref)) return `it uses ${step.uses}, a commit that is not in the table of actions that were read: the rule cannot tell whether that actions/setup-node caches by itself`;
  if (!SETUP_NODE_WITHOUT_AUTOMATIC_CACHE.test(row ? row.version : ref) && !isFalse(inputs.get("package-manager-cache"))) {
    return `it uses ${step.uses}${row ? ` (${row.version})` : ""} without \`package-manager-cache: false\`: from v5 on, actions/setup-node caches by itself when package.json names a package manager (a v4 step needs no input)`;
  }
  return null;
}

/** Every job of every workflow file in the directory, { file, job, definition }, and every step
 *  of each, { file, job, step }. */
function workflowSteps() {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).sort();
  const jobs = files.flatMap((file) => {
    const workflow = parseConfigData(readFileSync(new URL(file, WORKFLOWS))).value;
    return Object.entries(workflow.jobs ?? {}).map(([job, definition]) => ({ file, job, definition }));
  });
  return { files, jobs, steps: jobs.flatMap(({ file, job, definition }) => (definition.steps ?? []).map((step) => ({ file, job, step }))) };
}

test("no workflow under .github/workflows/ restores an Actions cache, and no setup action can begin to by itself", () => {
  const { files, steps } = workflowSteps();
  // The directory is read, not listed here: a workflow added later is held to the same rule.
  assert.ok(files.includes("pull-request.yml") && files.length >= 3, `the workflows are read from the directory: ${files.join(", ")}`);
  const setupNode = steps.filter(({ step }) => /^actions\/setup-node@/i.test(step.uses ?? ""));
  assert.ok(setupNode.length > 0, "the rule is checked against real steps: the workflows set up Node");
  // By its tag and by its commit id: the rule is checked against real steps of both kinds.
  for (const kind of [/@v\d+$/, /@[0-9a-f]{40}$/]) assert.ok(setupNode.some(({ step }) => kind.test(step.uses)), `no actions/setup-node step is named as ${kind}`);
  const found = steps.map(({ file, job, step }) => ({ file, job, why: restoresCache(step) })).filter(({ why }) => why);
  assert.deepEqual(found.map(({ file, job, why }) => `${file}, job ${job}: ${why}`), [], WHY);
  // A cache-dependency-path without a cache names a cache that is not there: it goes with it.
  for (const { file, job, step } of steps) assert.equal(inputsOf(step).has("cache-dependency-path"), false, `${file}, job ${job}: \`cache-dependency-path\` is an input of a cache. ${WHY}`);
});

test("a workflow uses only what the table of actions that were read holds: no other action or ref, no local action, no reusable workflow", () => {
  const { files, jobs, steps } = workflowSteps();
  for (const file of BY_ID) assert.ok(files.includes(file), `${file} is one of the files that name actions by commit id`);
  // Those files by a row's commit id; every other workflow by the tag of a row's major.
  const refused = steps.map(({ file, job, step }) => ({ file, job, why: usesUnreadAction(step, { byId: BY_ID.includes(file) }) })).filter(({ why }) => why);
  assert.deepEqual(refused.map(({ file, job, why }) => `${file}, job ${job}: ${why}`), [], `${WHY} ${HOW_TO_ADD}`);
  const called = jobs.map(({ file, job, definition }) => ({ file, job, why: callsWorkflow(definition) })).filter(({ why }) => why);
  assert.deepEqual(called.map(({ file, job, why }) => `${file}, job ${job}: ${why}`), [], WHY);
  assert.ok(steps.some(({ step }) => step.uses !== undefined) && jobs.length > 0, "the rule is checked against real jobs and steps");
  assert.ok(steps.some(({ file, step }) => !BY_ID.includes(file) && step.uses !== undefined), "and against a workflow that keeps tags");
});

test("SHA-pinned workflows name every action by a full commit id of the table, one id an action, its version beside it", () => {
  const { steps } = workflowSteps();
  const pair = steps.filter(({ file, step }) => BY_ID.includes(file) && step.uses !== undefined);
  // Every `uses:` of those files is a row's id: 40 lower-case hexadecimal characters, read.
  for (const { file, job, step } of pair) {
    assert.match(parseUses(String(step.uses)).ref, FULL_ID, `${file}, job ${job}: ${step.uses} is not named by a full commit id`);
    assert.equal(usesUnreadAction(step, { byId: true }), null, `${file}, job ${job}`);
  }
  // The same action is the same commit in every one of the files, and in every step of each.
  assert.deepEqual(namedBySeveralRefs(pair.map(({ step }) => step)), [], `${listed(BY_ID)} name one commit for an action`);
  // Checked against the real files: each uses actions, and the second one's are all the first's.
  const usedBy = (name) => [...new Set(pair.filter(({ file }) => file === name).map(({ step }) => parseUses(step.uses).action))];
  assert.ok(usedBy("release.yml").length > 0 && usedBy("build-installers.yml").length > 0);
  assert.deepEqual(usedBy("build-installers.yml").filter((action) => !usedBy("release.yml").includes(action)), [], "an action of build-installers.yml that release.yml does not use");
  // Beside each id, the exact version the table gives it. The lines are read as text, since a
  // comment is not in the parsed document, and they are the parsed steps' own, in order.
  for (const file of BY_ID) {
    const lines = usesLines(readFileSync(new URL(file, WORKFLOWS), "utf8"));
    assert.deepEqual(lines.map((line) => line.uses), pair.filter((entry) => entry.file === file).map(({ step }) => step.uses), `${file}: every \`uses:\` line is a step's`);
    assert.deepEqual(lines.map((line) => versionNotBeside(line)).filter(Boolean), [], `${file}: the comment beside an id names its version`);
  }
});

test("release.yml and build-installers.yml run every job on a runner of the list, and on the same Linux in both", () => {
  // pull-request.yml keeps `ubuntu-latest`, on purpose: when GitHub moves that label, a break on
  // the new system shows in pull-request CI first and not at a release. Moving these two files
  // is then a decision with that evidence. test/continuous-integration.test.mjs holds that label
  // for every job of that file.
  const { jobs } = workflowSteps();
  const pair = jobs.filter(({ file }) => RELEASE_FILES.includes(file));
  const unlisted = pair.map(({ file, job, definition }) => ({ file, job, why: runsOnUnlistedRunner(definition) })).filter(({ why }) => why);
  assert.deepEqual(unlisted.map(({ file, job, why }) => `${file}, job ${job}: ${why}`), []);
  // The list is what the two files name and nothing more: a label left on it after a move, or
  // put on it ahead of one, would let a job change its system without the list changing.
  const named = [...new Set(pair.flatMap(({ definition }) => runnerLabels(definition).labels))];
  assert.deepEqual(RELEASE_RUNNERS.filter((label) => !named.includes(label)), [], "a label on the list of runners that no job of the two files runs on");
  // And each label of it names a version: `ubuntu-latest` is not made a runner of these files by listing it.
  for (const label of RELEASE_RUNNERS) assert.match(label, VERSIONED_RUNNER, `${label} is on the list of runners and names no version`);
  assert.equal(new Set(RELEASE_RUNNERS).size, RELEASE_RUNNERS.length);
  // One Linux for both files: the installer legs are the same steps, on the same system.
  const linuxOf = (name) => [...new Set(pair.filter(({ file }) => file === name).flatMap(({ definition }) => runnerLabels(definition).labels).filter((label) => label.startsWith("ubuntu-")))];
  assert.equal(linuxOf("release.yml").length, 1, `release.yml runs on one Linux: ${linuxOf("release.yml").join(", ")}`);
  assert.deepEqual(linuxOf("build-installers.yml"), linuxOf("release.yml"), "build-installers.yml builds on release.yml's Linux");
  // Checked against the real files: jobs with a label of their own, and jobs that take it from a matrix.
  for (const file of RELEASE_FILES) assert.ok(pair.some((entry) => entry.file === file && String(entry.definition["runs-on"]).includes("matrix.")), `${file} has an installer matrix`);
  assert.ok(pair.some(({ definition }) => !String(definition["runs-on"]).includes("${{")));
  assert.ok(pair.flatMap(({ definition }) => runnerLabels(definition).labels).some((label) => label.startsWith("macos-")), "and macOS legs");
});

test("the rule: which runner labels a job can run on, and which of them the list holds", () => {
  const legs = [{ os: "macos-15", arch: "arm64" }, { os: "macos-15", arch: "x64" }, { os: "ubuntu-24.04", arch: "x64" }];
  const RUNNERS = ["ubuntu-24.04", "macos-15"];
  assert.deepEqual(runnerLabels({ "runs-on": "ubuntu-24.04" }), { labels: ["ubuntu-24.04"] });
  assert.deepEqual(runnerLabels({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { include: legs } } }), { labels: ["macos-15", "ubuntu-24.04"] });
  assert.deepEqual(runnerLabels({ "runs-on": "${{matrix.os}}", strategy: { matrix: { os: ["ubuntu-24.04", "macos-15"] } } }), { labels: ["ubuntu-24.04", "macos-15"] });
  // A list and legs: a leg with the key adds a label, a leg without it takes the list's.
  assert.deepEqual(runnerLabels({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { os: ["ubuntu-24.04"], include: [{ os: "macos-15" }, { node: 22 }] } } }), { labels: ["ubuntu-24.04", "macos-15"] });
  const unresolved = [
    { "runs-on": "${{ inputs.os }}" },
    { "runs-on": "${{ matrix.os }}" },
    { "runs-on": "${{ matrix.os }}", strategy: { matrix: "${{ fromJSON(needs.plan.outputs.matrix) }}" } },
    { "runs-on": "${{ matrix.os }}", strategy: { matrix: { include: "${{ fromJSON(inputs.legs) }}" } } },
    { "runs-on": "${{ matrix.os }}", strategy: { matrix: { arch: ["x64"] } } },
    { "runs-on": "${{ matrix.os }}", strategy: { matrix: { include: [{ os: "ubuntu-24.04" }, { arch: "x64" }] } } },
    { "runs-on": "${{ matrix.os }}", strategy: { matrix: { os: ["ubuntu-24.04", "${{ inputs.os }}"] } } },
    { "runs-on": "${{ matrix.os }}", strategy: { matrix: { os: [24] } } },
    { "runs-on": "${{ matrix.os || 'ubuntu-24.04' }}", strategy: { matrix: { os: ["ubuntu-24.04"] } } },
    { "runs-on": "ubuntu-${{ matrix.version }}", strategy: { matrix: { version: ["24.04"] } } },
  ];
  for (const definition of unresolved) {
    assert.match(runnerLabels(definition).why, /which the rule cannot resolve to the labels it stands for$/, JSON.stringify(definition));
    assert.equal(runsOnUnlistedRunner(definition, RUNNERS), runnerLabels(definition).why);
  }
  // Not one label: a list of labels, a runner group, nothing.
  for (const runsOn of [["self-hosted", "linux"], { group: "larger" }, { group: "big", labels: "ubuntu-24.04" }]) assert.match(runsOnUnlistedRunner({ "runs-on": runsOn }, RUNNERS), /its `runs-on` is not a single label/);
  assert.match(runsOnUnlistedRunner({ steps: [] }, RUNNERS), /its `runs-on` is missing/);

  // A label of the list, exactly as the list spells it. The rule is tested against a list of its
  // own, so that moving a runner changes the list above and the two files, and no test.
  for (const label of RUNNERS) assert.equal(runsOnUnlistedRunner({ "runs-on": label }, RUNNERS), null, label);
  assert.equal(runsOnUnlistedRunner({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { include: legs } } }, RUNNERS), null);
  const unlisted = [
    // A label that moves by itself; another version, or another flavour, of a listed system.
    "ubuntu-latest", "macos-latest", "ubuntu-slim", "ubuntu-22.04", "ubuntu-26.04", "macos-26", "macos-15-large", "ubuntu-24.04-arm", "windows-2025",
    // The form of a version's name is not the rule: these would be somebody's own runners.
    "build-1", "self-hosted", "release-2",
    // Not the listed spelling.
    "Ubuntu-24.04", "ubuntu-24.04 ", "ubuntu-24", "",
  ];
  for (const label of unlisted) {
    assert.match(String(runsOnUnlistedRunner({ "runs-on": label }, RUNNERS)), /not on the list of runners \(ubuntu-24\.04, macos-15\): the release and its installers are built on a system somebody decided\. A label is added to the list by whoever decides the runner, in a pull request that says what the installers then need/, JSON.stringify(label));
  }
  // One unlisted label among a matrix's is enough, and the message names it alone.
  assert.match(runsOnUnlistedRunner({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { include: [...legs, { os: "ubuntu-latest", arch: "x64" }] } } }, RUNNERS), /^it runs on ubuntu-latest, not on the list of runners/);
  // A list that holds two Linuxes accepts either: that both files build on one is another check.
  assert.equal(runsOnUnlistedRunner({ "runs-on": "ubuntu-22.04" }, [...RUNNERS, "ubuntu-22.04"]), null);

  // What a label of the list must be. `build-1` has the form, which is why the form is not the rule.
  for (const label of ["ubuntu-24.04", "macos-15", "macos-15-large", "ubuntu-24.04-arm", "windows-2025", "build-1"]) assert.match(label, VERSIONED_RUNNER);
  for (const label of ["ubuntu-latest", "macos-latest", "macos-latest-large", "ubuntu", "ubuntu-slim", "self-hosted", "Ubuntu-24.04", "ubuntu-24.04 ", ""]) assert.doesNotMatch(label, VERSIONED_RUNNER);
});

/** A table for the tests of the rule itself, with ids nobody could take for a commit's. The
 *  rule is tested against it and not against the table above, so that moving an id, or adding a
 *  row, changes that row and the workflows' lines and no test. */
const CHECKOUT = "1".repeat(40), SETUP_NODE = "2".repeat(40), UPLOAD = "3".repeat(40), UNREAD = "0".repeat(40);
const FIXTURE = [
  { action: "actions/checkout", id: CHECKOUT, version: "v4.4.0" },
  { action: "actions/setup-node", id: SETUP_NODE, version: "v4.4.0" },
  { action: "actions/upload-artifact", id: UPLOAD, version: "v4.6.2" },
  { action: "actions/attest-build-provenance", id: "4".repeat(40), version: "v1.4.4" },
];
const unread = (step, options = {}) => usesUnreadAction(step, { table: FIXTURE, ...options });

test("the rule: which actions a step may use and at which ref, and what a job may not do", () => {
  const how = /A row is added to the table of actions that were read by whoever has read that commit for whether the action saves or restores a cache by itself: its action\.yml, the actions and packages it depends on, and what its entry points call of a cache\. Its id is the commit that an exact version tag of the action's own repository points at \(docs\/release-lane\.md, "The workflow's actions are named by commit"\)\.$/;
  const refused = [
    // The three that passed before the table existed.
    [{ uses: "./.github/actions/setup" }, /it uses the local action \.\/\.github\/actions\/setup/],
    [{ uses: "actions/setup-go@v5" }, /actions\/setup-go@v5, which is not in the table of actions that were read/],
    [{ uses: "actions/cache/save@v4", with: { path: "~/.npm", key: "k" } }, /actions\/cache\/save@v4, which is not in the table/],
    [{ uses: "actions/cache@v4" }, /not in the table/],
    [{ uses: "actions/cache/restore@v4" }, /not in the table/],
    [{ uses: "actions/setup-python@v5" }, /not in the table/],
    [{ uses: "someone/some-action@v1" }, /not in the table/],
    [{ uses: "docker://alpine:3" }, /not in the table/],
    [{ uses: "../actions/setup" }, /local action/],
    // The listed name exactly: not a path under it, not a longer or a shorter name.
    [{ uses: "actions/checkout/sub@v4" }, /not in the table/],
    [{ uses: "actions/upload-artifact/merge@v4" }, /not in the table/],
    [{ uses: "actions/checkout-extra@v4" }, /not in the table/],
    [{ uses: "actions@v4" }, /not in the table/],
    [{ uses: "" }, /not in the table/],
    [{ uses: 4 }, /is not a string/],
  ];
  // Whichever kind of file the step is in.
  for (const byId of [false, true]) for (const [step, why] of refused) assert.match(String(unread(step, { byId })), why, JSON.stringify(step));
  // What to do about it, and what to read first, is in the message, once. An action off the
  // table is told the actions it holds.
  assert.match(unread({ uses: "actions/setup-go@v5" }), how);
  assert.match(unread({ uses: "actions/setup-go@v5" }), /\(actions\/checkout, actions\/setup-node, actions\/upload-artifact, actions\/attest-build-provenance\)/);

  assert.match(callsWorkflow({ uses: "./.github/workflows/build.yml" }), /it calls the reusable workflow \.\/\.github\/workflows\/build\.yml/);
  assert.match(callsWorkflow({ uses: "someone/somewhere/.github/workflows/build.yml@v1", with: { cache: false } }), /it calls the reusable workflow/);
  assert.equal(callsWorkflow({ "runs-on": "ubuntu-latest", steps: [{ run: "npm ci" }] }), null);

  // A workflow that keeps tags: a listed action at the major of a version that was read, exactly.
  const exactly = /a ref is the major of a version that was read exactly/;
  const onTags = [
    // A later or an earlier major, a minor or patch tag, a branch, no ref, another spelling.
    [{ uses: "actions/checkout@v5" }, /actions\/checkout@v5, and the table of actions that were read holds actions\/checkout at v4: a ref is the major of a version that was read exactly/],
    [{ uses: "actions/checkout@v3" }, exactly],
    [{ uses: "actions/setup-node@v7" }, /holds actions\/setup-node at v4: a ref is the major/],
    [{ uses: "actions/setup-node@v4.1.0" }, exactly],
    // The very version that was read is not the ref either: the tag of a workflow is the major.
    [{ uses: "actions/setup-node@v4.4.0" }, exactly],
    [{ uses: "actions/checkout@v4.2" }, exactly],
    [{ uses: "actions/checkout@main" }, exactly],
    [{ uses: "actions/checkout@releases/v4" }, exactly],
    [{ uses: "actions/checkout" }, exactly],
    [{ uses: "actions/checkout@" }, exactly],
    [{ uses: "actions/checkout@V4" }, exactly],
    [{ uses: "actions/checkout@4" }, exactly],
    [{ uses: "actions/checkout@1111111" }, exactly],
    // A major is one action's: v4 of the others is not v4 of this one, nor v1 the others'.
    [{ uses: "actions/attest-build-provenance@v4" }, /holds actions\/attest-build-provenance at v1/],
    [{ uses: "actions/checkout@v1" }, /holds actions\/checkout at v4/],
    // A commit id, a row's or not, in either case of its digits: these workflows keep tags.
    [{ uses: `actions/checkout@${CHECKOUT}` }, /only release\.yml, build-installers\.yml, tui-macos\.yml and team-image\.yml name an action by commit id, and every other workflow keeps the tag of a major that was read \(actions\/checkout@v4\)$/],
    [{ uses: `actions/checkout@${UNREAD}` }, /only release\.yml, build-installers\.yml, tui-macos\.yml and team-image\.yml name an action by commit id/],
    [{ uses: "actions/setup-node@ABCDEF0123456789ABCDEF0123456789ABCDEF01" }, /only release\.yml, build-installers\.yml, tui-macos\.yml and team-image\.yml name an action by commit id/],
  ];
  for (const [step, why] of onTags) assert.match(String(unread(step)), why, JSON.stringify(step));
  assert.match(unread({ uses: "actions/checkout@v5" }), how);
  // An id is refused there without the way to add a row: no reading makes it that workflow's ref.
  assert.doesNotMatch(unread({ uses: `actions/checkout@${CHECKOUT}` }), /A row is added/);
  const acceptedOnTags = [
    ...FIXTURE.map((row) => ({ uses: `${row.action}@${majorOf(row.version)}` })),
    // An action's name is matched whatever its case. Its ref is not.
    { uses: "Actions/Checkout@v4" },
    { run: "npm ci" },
    { name: "a step that names an action in a command uses none", run: "echo actions/cache@v4" },
  ];
  for (const step of acceptedOnTags) assert.equal(unread(step), null, JSON.stringify(step));

  // One of the files of BY_ID: a listed action at a row's commit id, exactly.
  const byFullId = /release\.yml, build-installers\.yml, tui-macos\.yml and team-image\.yml name every action by a full commit id, 40 lower-case hexadecimal characters, and the table of actions that were read holds/;
  const inThePair = [
    // A tag, the major's or the version's; a branch; a shortened id; no ref.
    [{ uses: "actions/checkout@v4" }, /actions\/checkout@v4: release\.yml, build-installers\.yml, tui-macos\.yml and team-image\.yml name every action by a full commit id, 40 lower-case hexadecimal characters, and the table of actions that were read holds actions\/checkout at 1{40} \(v4\.4\.0\)$/],
    [{ uses: "actions/checkout@v4.4.0" }, byFullId],
    [{ uses: "actions/checkout@main" }, byFullId],
    [{ uses: "actions/checkout@1111111" }, byFullId],
    [{ uses: `actions/checkout@${CHECKOUT.slice(0, 39)}` }, byFullId],
    [{ uses: "actions/checkout" }, byFullId],
    // A full id is in lower case, and has not a character more.
    [{ uses: "actions/checkout@ABCDEF0123456789ABCDEF0123456789ABCDEF01" }, byFullId],
    [{ uses: `actions/checkout@${CHECKOUT}1` }, byFullId],
    // A full id that is no row's of that action: unread, or another action's.
    [{ uses: `actions/checkout@${UNREAD}` }, /a commit that is not in the table of actions that were read, which holds actions\/checkout at 1{40} \(v4\.4\.0\)\. A row is added/],
    [{ uses: `actions/checkout@${SETUP_NODE}` }, /a commit that is not in the table/],
  ];
  for (const [step, why] of inThePair) assert.match(String(unread(step, { byId: true })), why, JSON.stringify(step));
  assert.match(unread({ uses: `actions/checkout@${UNREAD}` }, { byId: true }), how);
  const acceptedInThePair = [
    ...FIXTURE.map((row) => ({ uses: `${row.action}@${row.id}` })),
    { uses: `Actions/Checkout@${CHECKOUT}` },
    { run: "npm ci" },
  ];
  for (const step of acceptedInThePair) assert.equal(unread(step, { byId: true }), null, JSON.stringify(step));
});

test("the table of actions that were read: full commit ids, exact versions, and no id twice", () => {
  for (const { action, id, version } of ACTIONS_READ) {
    assert.match(id, FULL_ID, action);
    assert.match(version, /^v\d+\.\d+\.\d+$/, `${action}: an exact version, not a major`);
    assert.equal(action, action.toLowerCase(), "a row's name is in lower case, as a step's is compared");
  }
  assert.equal(new Set(ACTIONS_READ.map((row) => row.id)).size, ACTIONS_READ.length);
});

test("the rule: the files that name actions by commit name one commit for an action, and the comment beside an id is its version", () => {
  const A = CHECKOUT, B = SETUP_NODE, beside = (line) => versionNotBeside(line, FIXTURE);
  assert.deepEqual(namedBySeveralRefs([{ uses: `actions/checkout@${A}` }, { uses: `actions/setup-node@${B}` }, { uses: `Actions/Checkout@${A}` }, { run: "npm ci" }]), []);
  // Two commits for one action, wherever the two steps are; a tag beside an id is a second ref too.
  assert.deepEqual(namedBySeveralRefs([{ uses: `actions/checkout@${A}` }, { uses: `actions/checkout@${B}` }]), [`actions/checkout: ${A}, ${B}`]);
  assert.deepEqual(namedBySeveralRefs([{ uses: `actions/checkout@${A}` }, { uses: "actions/checkout@v4" }, { uses: `actions/setup-node@${B}` }]), [`actions/checkout: ${A}, v4`]);

  const text = [
    "    steps:",
    `      - uses: actions/checkout@${A} # v4.4.0`,
    "        with:",
    "          ref: ${{ github.sha }}",
    "      - name: Set up Node",
    `        uses: actions/setup-node@${B}   #   v4.4.0  `,
    `      - uses: actions/upload-artifact@${UPLOAD}`,
    "      - run: echo uses nothing",
  ].join("\n");
  assert.deepEqual(usesLines(text), [
    { uses: `actions/checkout@${A}`, comment: "v4.4.0" },
    { uses: `actions/setup-node@${B}`, comment: "v4.4.0" },
    { uses: `actions/upload-artifact@${UPLOAD}`, comment: "" },
  ]);
  assert.equal(beside({ uses: `actions/checkout@${A}`, comment: "v4.4.0" }), null);
  // No comment, the major only, another version, a version with more beside it.
  assert.match(beside({ uses: `actions/checkout@${A}`, comment: "" }), /is v4\.4\.0 in the table of actions that were read, and the comment beside it is missing: the id and its version are changed together$/);
  assert.match(beside({ uses: `actions/checkout@${A}`, comment: "v4" }), /the comment beside it says `v4`/);
  assert.match(beside({ uses: `actions/checkout@${A}`, comment: "v4.4.1" }), /says `v4\.4\.1`/);
  assert.match(beside({ uses: `actions/checkout@${A}`, comment: "v4.4.0, pinned" }), /says `v4\.4\.0, pinned`/);
  // An id that is no row's is the other rule's to refuse.
  assert.equal(beside({ uses: `actions/checkout@${UNREAD}`, comment: "v9.9.9" }), null);
});

test("the two rules together: a version of actions/setup-node added to the table is still kept from caching by itself", () => {
  // Today a later major is refused by the table, whatever its inputs.
  const bare = { uses: "actions/setup-node@v6", with: { "node-version": 22 } };
  const told = { uses: "actions/setup-node@v6", with: { "node-version": 22, "package-manager-cache": false } };
  for (const step of [bare, told]) assert.match(unread(step), /holds actions\/setup-node at v4/, JSON.stringify(step));
  // The day somebody reads a v6 and adds its row, the table accepts both steps by its major, and
  // the cache rule still refuses the one that does not turn the action's own caching off.
  const V6 = "6666666666666666666666666666666666666666";
  const later = [...FIXTURE, { action: "actions/setup-node", id: V6, version: "v6.1.0" }];
  for (const step of [bare, told]) assert.equal(usesUnreadAction(step, { table: later }), null, JSON.stringify(step));
  assert.match(restoresCache(bare, later), /without `package-manager-cache: false`/);
  assert.equal(restoresCache(told, later), null);
  // By its commit id as by its tag: the rule takes the version from the row.
  const bareById = { uses: `actions/setup-node@${V6}`, with: { "node-version": 22 } };
  const toldById = { uses: `actions/setup-node@${V6}`, with: { "node-version": 22, "package-manager-cache": false } };
  for (const step of [bareById, toldById]) assert.equal(usesUnreadAction(step, { byId: true, table: later }), null, JSON.stringify(step));
  assert.match(restoresCache(bareById, later), /actions\/setup-node@6{40} \(v6\.1\.0\) without `package-manager-cache: false`/);
  assert.equal(restoresCache(toldById, later), null);
  // Without the row that id has no version: both rules refuse it, whatever its inputs.
  for (const step of [bareById, toldById]) {
    assert.match(unread(step, { byId: true }), /a commit that is not in the table/, JSON.stringify(step));
    assert.match(restoresCache(step, FIXTURE), /a commit that is not in the table of actions that were read: the rule cannot tell whether that actions\/setup-node caches by itself$/, JSON.stringify(step));
  }
  // A major the table holds is still the only tag of it: the table does not open its minors.
  assert.match(usesUnreadAction({ uses: "actions/setup-node@v6.1.0" }, { table: later }), /holds actions\/setup-node at v4, v6: a ref is the major/);
  assert.match(usesUnreadAction({ uses: "actions/setup-node@v5" }, { table: later }), /a ref is the major/);
});

test("the rule: what counts as restoring a cache, and what keeps actions/setup-node from caching by itself", () => {
  const V4 = SETUP_NODE;
  const refused = [
    { uses: "actions/cache@v4", with: { path: "~/.npm", key: "k" } },
    { uses: "actions/cache/restore@v4", with: { path: "~/.npm", key: "k" } },
    { uses: "Actions/Cache@v4" },
    { uses: "actions/setup-node@v4", with: { "node-version": 22, cache: "npm" } },
    { uses: "actions/setup-node@v4", with: { "node-version": 22, cache: "" } },
    { uses: "actions/setup-python@v5", with: { cache: "pip" } },
    { uses: "actions/setup-go@v5", with: { cache: true } },
    // An input's name is matched whatever its case.
    { uses: "actions/setup-node@v4", with: { "node-version": 22, CACHE: "npm" } },
    { uses: "actions/setup-node@v4", with: { "node-version": 22, Cache: "npm" } },
    // No `cache` input at all, whatever it says: not `false` either, and not beside a row's id.
    { uses: "actions/setup-go@v5", with: { cache: false } },
    { uses: "actions/setup-node@v4", with: { "node-version": 22, cache: "false" } },
    { uses: "actions/setup-node@v6", with: { "package-manager-cache": false, CACHE: false } },
    { uses: `actions/setup-node@${V4}`, with: { "node-version": 22, cache: "npm" } },
    // A later major caches by itself unless told not to; so may a ref whose major cannot be read.
    { uses: "actions/setup-node@v5", with: { "node-version": 22 } },
    { uses: "actions/setup-node@v6" },
    { uses: "actions/setup-node@v7", with: { "package-manager-cache": true } },
    { uses: "actions/setup-node@main", with: { "node-version": 22 } },
    { uses: "actions/setup-node", with: { "node-version": 22 } },
    // A commit id that is no row's has no version: refused with the input and without it, in
    // either case of its digits.
    { uses: `actions/setup-node@${UNREAD}`, with: { "node-version": 22 } },
    { uses: `actions/setup-node@${UNREAD}`, with: { "package-manager-cache": false } },
    { uses: "actions/setup-node@ABCDEF0123456789ABCDEF0123456789ABCDEF01", with: { "package-manager-cache": false } },
    // Another action's id is not this action's row.
    { uses: `actions/setup-node@${CHECKOUT}`, with: { "package-manager-cache": false } },
  ];
  for (const step of refused) assert.equal(typeof restoresCache(step, FIXTURE), "string", JSON.stringify(step));
  const accepted = [
    { uses: "actions/setup-node@v4", with: { "node-version": 22 } },
    { uses: "actions/setup-node@v4.4.0", with: { "node-version": 22, "registry-url": "https://registry.npmjs.org" } },
    { uses: "actions/setup-node@v6", with: { "node-version": 22, "package-manager-cache": false } },
    { uses: "actions/setup-node@v6", with: { "node-version": 22, "Package-Manager-Cache": false } },
    // A row's id is its version: the v4.4.0 that was read needs no input it does not know.
    { uses: `actions/setup-node@${V4}`, with: { "node-version": 22 } },
    { uses: `Actions/Setup-Node@${V4}`, with: { "node-version": 22, "registry-url": "https://registry.npmjs.org" } },
    { uses: "actions/checkout@v4", with: { "fetch-depth": 0 } },
    { uses: `actions/checkout@${CHECKOUT}`, with: { ref: "${{ github.sha }}" } },
    { uses: "actions/upload-artifact@v4", with: { name: "dist", path: "dist" } },
    { run: "npm ci" },
    { name: "a step that names a cache in a command restores none", run: "npm ci --cache .npm" },
  ];
  for (const step of accepted) assert.equal(restoresCache(step, FIXTURE), null, JSON.stringify(step));
});
