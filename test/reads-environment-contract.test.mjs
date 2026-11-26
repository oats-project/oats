// `readsEnvironment`: what a capability's module commands may read from the environment of whoever
// runs them outside a launch (a readiness check, `oats operation run`). A list of exact variable
// names and of prefixes ending in an underscore. It grants no right to set anything: `environment`
// and `environmentNamespaces` say what a capability's hooks may set in a launch, and are separate.
// This file holds the manifest's side: the shape the kernel accepts and the entries it refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { manifestContract } from "../lib/capability-contract.mjs";

const manifest = (readsEnvironment) => ({ capability: "acme.messaging", ...(readsEnvironment === undefined ? {} : { readsEnvironment }) });
const problems = (value) => manifestContract(manifest(value)).problems;

test("a manifest without the field, with an empty list, and with names and prefixes is accepted", () => {
  for (const value of [undefined, [], ["AW_"], ["CLAUDE_CONFIG_DIR"], ["AW_", "CLAUDE_CONFIG_DIR", "AWEB_URL", "My_Tool_"]]) assert.deepEqual(problems(value), [], JSON.stringify(value));
});

test("the field is a list of distinct strings", () => {
  for (const value of ["AW_", { AW_: true }, [1], [null], ["AW_", 2]]) {
    assert.deepEqual(problems(value), [{ pointer: "/readsEnvironment", message: "capability acme.messaging manifest readsEnvironment must be an array of variable names and of prefixes ending in an underscore" }], JSON.stringify(value));
  }
  assert.deepEqual(problems(["AW_", "AW_"]), [{ pointer: "/readsEnvironment", message: "capability acme.messaging manifest readsEnvironment contains duplicate entries" }]);
});

test("an entry that is no variable name, or a prefix too wide to mean one tool, is refused by name", () => {
  for (const [entry, why] of [
    ["", "is not a variable name or a prefix"], ["AW-", "is not a variable name or a prefix"], ["9AW_", "is not a variable name or a prefix"], ["A B", "is not a variable name or a prefix"],
    ["_", "is too wide: a prefix has at least two characters before its underscore"], ["A_", "is too wide: a prefix has at least two characters before its underscore"], ["__", "is too wide: a prefix has at least two characters before its underscore"],
  ]) {
    assert.deepEqual(problems(["AW_", entry]), [{ pointer: "/readsEnvironment/1", message: `capability acme.messaging manifest readsEnvironment entry ${JSON.stringify(entry)} ${why}` }], JSON.stringify(entry));
  }
});

test("the kernel's own names are never a capability's to read from the caller", () => {
  for (const entry of ["OATS_", "OATS_SETTINGS", "OAS_", "OAS_HOME", "PI_", "PI_AGENT_", "PI_AGENT_HOME"]) {
    assert.deepEqual(problems([entry]), [{ pointer: "/readsEnvironment/0", message: `capability acme.messaging manifest readsEnvironment entry ${JSON.stringify(entry)} is reserved: the kernel sets the OATS_, OAS_ and PI_ names itself` }], entry);
  }
});

test("the field changes nothing about what a capability may set", () => {
  const set = { capability: "acme.messaging", environment: ["ACME_URL"], readsEnvironment: ["AW_"] };
  assert.deepEqual(manifestContract(set).problems, []);
  // A name it may read is not thereby one it may declare for a launch.
  assert.deepEqual(manifestContract({ ...set, environment: ["AW_HOME"] }).problems.map((p) => p.pointer), ["/environment/0"]);
});

test("the manifest schema carries the field, beside the two that say what a capability may set", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/capability-manifest.schema.json", import.meta.url)), "utf8"));
  const field = schema.properties.readsEnvironment;
  assert.deepEqual([field.type, field.uniqueItems, field.items.type], ["array", true, "string"]);
  for (const ok of ["AW_", "CLAUDE_CONFIG_DIR", "My_Tool_"]) assert.match(ok, new RegExp(field.items.pattern), ok);
  for (const bad of ["", "AW-", "9AW_", "A B"]) assert.doesNotMatch(bad, new RegExp(field.items.pattern), JSON.stringify(bad));
  assert.match(field.description, /grants no right to set/);
});
