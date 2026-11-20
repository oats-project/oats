// The codes a stop and a retire answer only BEFORE any effect (awebai/oats#895). A client reads each
// of them as "refused, nothing happened": no process was signalled, no hook ran, nothing of a home
// was written, copied or removed. That reading used to be a list each client kept for itself, and a
// retire answered two of its codes after effects. The kernel now holds the list, by verb
// (lib/errors.mjs BEFORE_EFFECT_CODES), and holds itself to it by construction (afterFirstEffect:
// test/retire-late-answers.test.mjs).
//
// One list has three copies that can drift, and this file ties them:
//   1. the table of docs/desktop-cli-api.md (anchor `before-effect-codes`) is the constant, cell by
//      cell: a code the kernel gains or loses changes the page in the same commit;
//   2. the list is at least what the Desktop treated as refusals when the rule was written, and
//      holds none of the codes that may follow an effect;
//   3. a client's own set lies INSIDE the kernel's list for each verb. Inside, never equal: a
//      client may know fewer codes than the kernel answers (it then shows an unknown one as a
//      failure, which is safe), and it may never treat as "nothing happened" a code the kernel does
//      not promise that for.
// The rule itself, on real answers, is held by the walk (test/lifecycle-door-walk.test.mjs: an
// answer of a retire or a stop apply whose code is listed has reached nothing) and by
// test/lifecycle-pair-table.test.mjs for every cell of the pair table.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BEFORE_EFFECT_CODES, isKernelCode } from "../lib/errors.mjs";
import { tableAfter } from "./helpers/docs-table.mjs";

const DOC = fileURLToPath(new URL("../docs/desktop-cli-api.md", import.meta.url));
const VERBS = ["instance stop", "retire"];
/** The Desktop's module that turns a lifecycle command's answer into "refused" or "failed". */
const DESKTOP_MODULE = "packages/client/instance-lifecycle.mjs";

/** The docs table → { <verb>: [code, in the table's order] }, the codes marked `yes` for the verb. A
 *  row is a code in backticks and, for each verb, `yes` or an empty cell: anything else fails. */
function documentedCodes() {
  const { header, body } = tableAfter(DOC, "before-effect-codes");
  assert.deepEqual(header, ["Code", ...VERBS.map((verb) => `\`oats ${verb}\``)], "the table's columns are the code and one column for each verb of the kernel's list, named as the command is typed");
  const listed = Object.fromEntries(VERBS.map((verb) => [verb, []]));
  const seen = [];
  for (const [cell, ...marks] of body) {
    const m = /^`([^`]+)`$/.exec(cell);
    assert.ok(m, `the first cell of a row is one code in backticks: ${JSON.stringify(cell)}`);
    const code = m[1];
    assert.equal(seen.includes(code), false, `${code} has one row in the table, not two`);
    seen.push(code);
    marks.forEach((mark, n) => {
      assert.ok(mark === "yes" || mark === "", `the cell (${code}, oats ${VERBS[n]}) is "yes" or empty: ${JSON.stringify(mark)}`);
      if (mark === "yes") listed[VERBS[n]].push(code);
    });
    assert.ok(marks.includes("yes"), `${code} is in the table because at least one verb answers it only before any effect`);
  }
  return listed;
}

test("the kernel's list is one frozen object keyed by exactly the two verbs, each a frozen list of kernel codes without a duplicate", () => {
  assert.deepEqual(Object.keys(BEFORE_EFFECT_CODES).sort(), [...VERBS].sort(), "the keys are the verbs as lib/errors.mjs afterFirstEffect is given them: \"instance stop\" and \"retire\"");
  assert.equal(Object.isFrozen(BEFORE_EFFECT_CODES), true, "the constant is frozen: a caller cannot add a verb, or point one at another list");
  for (const verb of VERBS) {
    const codes = BEFORE_EFFECT_CODES[verb];
    assert.equal(Array.isArray(codes), true, `${verb}: a list`);
    assert.equal(Object.isFrozen(codes), true, `${verb}: its list is frozen, so no caller can add a code to it`);
    assert.ok(codes.length > 0, `${verb}: the list is not empty`);
    for (const code of codes) {
      assert.match(String(code), /^E_[A-Z0-9_]+$/, `${verb}: ${JSON.stringify(code)} is a kernel code`);
      assert.equal(isKernelCode(code), true, `${verb}: ${JSON.stringify(code)} is what lib/errors.mjs calls a kernel code`);
    }
    assert.deepEqual(codes.filter((code, n) => codes.indexOf(code) !== n), [], `${verb}: no code is listed twice`);
  }
});

test("the table of docs/desktop-cli-api.md (\"The codes a stop and a retire answer only before any effect\") is the kernel's list, verb by verb: the codes marked yes are the constant's, no more and no fewer", () => {
  const documented = documentedCodes();
  for (const verb of VERBS) {
    const kernel = BEFORE_EFFECT_CODES[verb];
    assert.deepEqual(kernel.filter((code) => !documented[verb].includes(code)), [], `oats ${verb}: codes of lib/errors.mjs BEFORE_EFFECT_CODES that the docs table does not mark "yes" for it`);
    assert.deepEqual(documented[verb].filter((code) => !kernel.includes(code)), [], `oats ${verb}: codes the docs table marks "yes" that lib/errors.mjs BEFORE_EFFECT_CODES does not list for it`);
    assert.equal(documented[verb].length, kernel.length, `oats ${verb}: as many codes in the table as in the constant`);
  }
});

/** The least the list holds: what the Desktop read as "refused, nothing happened" when the rule was
 *  written, and E_UNIDENTIFIED_INSTANCE_HOME, which both verbs answer before they act on a home. */
const AT_LEAST = ["E_BAD_ARGS", "E_PLAN_STALE", "E_INSTANCE_RETIRING", "E_LIFECYCLE_BUSY", "E_HOME_MISMATCH", "E_SESSION_UNKNOWN", "E_AMBIGUOUS_INSTANCE",
  "E_REMOTE_INCOMPATIBLE", "E_AMBIGUOUS", "E_SNAPSHOT_UNKNOWN", "E_UNIDENTIFIED_INSTANCE_HOME"];
/** Codes that may follow an effect: a signal sent, a hook run, a copy made. None is ever listed. */
const NEVER = ["E_CHILDREN_RUNNING", "E_SESSION_STOP_FAILED", "E_RUNTIME_QUIESCE_FAILED", "E_WORK_PRESERVATION_FAILED", "E_WORK_INSPECTION_FAILED", "E_LIFECYCLE_FAILED"];

test("both verbs list at least the ten codes a client already read as a refusal and E_UNIDENTIFIED_INSTANCE_HOME, and neither lists a code that may follow an effect (E_CHILDREN_RUNNING, E_SESSION_STOP_FAILED, E_RUNTIME_QUIESCE_FAILED, E_WORK_PRESERVATION_FAILED, E_WORK_INSPECTION_FAILED, E_LIFECYCLE_FAILED)", () => {
  for (const verb of VERBS) {
    const codes = BEFORE_EFFECT_CODES[verb];
    assert.deepEqual(AT_LEAST.filter((code) => !codes.includes(code)), [], `oats ${verb}: a code a client reads as "nothing happened" left the list, so that client now reads it as a failure after effects`);
    assert.deepEqual(NEVER.filter((code) => codes.includes(code)), [], `oats ${verb}: a code that may follow an effect is in the list, so a client would read "nothing happened" of a command that signalled, ran or copied`);
  }
});

test("both verbs list E_USAGE: a missing instance, refused before anything is read and before a --server route is taken", () => {
  for (const verb of VERBS) assert.equal(BEFORE_EFFECT_CODES[verb].includes("E_USAGE"), true, `oats ${verb}`);
});

test("the Desktop's own set of refusals lies inside the kernel's list, for a stop and for a retire: it exports it as BEFORE_EFFECT_CODES, and every code in it is one the kernel answers only before any effect", async () => {
  // The module loads under plain Node, without the Desktop's own dependencies, as the other root
  // tests that import from packages/desktop/server do (test/desktop-trigger-sources-kernel.test.mjs): it needs no
  // `.integration.mjs` name (scripts/run-tests.mjs).
  const desktop = await import(`../${DESKTOP_MODULE}`);
  // An export that is gone or renamed fails here, by name: without it nothing ties the codes the
  // Desktop reads as "refused, nothing happened" to the kernel's list.
  const codes = desktop.BEFORE_EFFECT_CODES;
  assert.ok(Array.isArray(codes), `${DESKTOP_MODULE} does not export BEFORE_EFFECT_CODES as a list (${codes === undefined ? "it exports no such name" : `what it exports under that name is no array: ${typeof codes}`}): the one list, for a stop and for a retire, that this test holds inside lib/errors.mjs BEFORE_EFFECT_CODES`);
  assert.ok(codes.length > 0, "the list is not empty");
  for (const code of codes) assert.equal(typeof code, "string", `every entry is a string: ${JSON.stringify(code)}`);
  // Inside, never equal: the client may know fewer codes than the kernel lists.
  for (const verb of VERBS) {
    assert.deepEqual(codes.filter((code) => !BEFORE_EFFECT_CODES[verb].includes(code)), [], `the Desktop reads these codes as "refused, nothing happened" for oats ${verb}, and the kernel does not promise that of them (lib/errors.mjs BEFORE_EFFECT_CODES[${JSON.stringify(verb)}])`);
  }
});
