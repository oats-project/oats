// The clients' instance-name grammar (packages/client/instance-name.mjs validInstanceName) agrees with the kernel's
// own --name check on every case.
import test from "node:test";
import assert from "node:assert/strict";
import { validInstanceName } from "../packages/client/instance-name.mjs";
import { explicitInstanceName, MAX_INSTANCE_NAME } from "../lib/core.mjs";

/** Names the kernel's `--name` rule takes and refuses, the same cases for both copies. */
export const VALIDITY_CASES = Object.freeze([
  "a", "dev-2", "desktop-instance-focus-developer", "0day", "x".repeat(64),
  "x".repeat(65), "", "-a", "a-", "a--b", "A", "Dev", "a_b", "a b", "a.b", "../x", "a/b", "é", "a\n", " a", "--dir", "a\u0000",
]);

test("validInstanceName: the kernel's own --name check (lib/core.mjs explicitInstanceName) decides every case alike", () => {
  const kernelTakes = (name) => { try { explicitInstanceName(name); return true; } catch (e) { assert.equal(e.code, "E_INSTANCE_NAME_INVALID"); return false; } };
  const taken = VALIDITY_CASES.filter(kernelTakes);
  assert.ok(taken.length >= 5 && taken.length < VALIDITY_CASES.length, "the cases hold names on both sides of the rule");
  assert.equal(MAX_INSTANCE_NAME, 64);
  for (const name of VALIDITY_CASES) assert.equal(validInstanceName(name), kernelTakes(name), JSON.stringify(name));
  for (const v of [undefined, null, 7, {}, ["a"]]) assert.equal(validInstanceName(v), false);
});
