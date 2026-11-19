// A capability manifest's `triggerSources` (#669 PR 2b; lib/trigger-sources.mjs): the use-time validator and
// the published schema (docs/capability-manifest.schema.json) judge ONE shared fixture set alike — a manifest
// that validates must not be refused at use, nor the reverse — apart from the rules only use can check (a
// pattern compiles, `command` names one of `commands`, a default matches its pattern), listed apart. And
// containment: a malformed declaration never refuses the capability (the manifest contract is unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_FIELD_PATTERN, DEFAULT_PARAM_PATTERN, SOURCE_NAME_RE, triggerSourcesOf } from "../lib/trigger-sources.mjs";
import { manifestContractProblems } from "../lib/capability-contract.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const schema = JSON.parse(readFileSync(join(root, "docs", "capability-manifest.schema.json"), "utf8"));
const { default: Ajv2020 } = await import("ajv/dist/2020.js");
const validate = new Ajv2020({ strict: false, allowUnionTypes: true }).compile(schema);

const base = { capability: "acme.x", version: "1.0.0", compatibility: { oats: ">=0.6.2" }, description: "x", commands: { go: "bin/x.mjs poll --json", other: "bin/y.mjs", "review-source": "bin/oats-omnigraph-maintenance.mjs review-source" } };
const manifest = (triggerSources) => ({ ...base, triggerSources });
const src = (extra = {}) => ({ command: "go", events: ["opened"], ...extra });
const bySchema = (ts) => validate(manifest(ts));
const byUse = (ts) => triggerSourcesOf(manifest(ts)).problems.length === 0;

// lab's real declaration (lab-oats-workspace 9f639e90, capabilities/lab-omnigraph-maintenance/oats.json), its
// names replaced by invented ones; its shape is the original's.
const LAB = { "harvest-branches": { command: "review-source", description: "Harvest branches ready for review on the lab graph, one event per judged head; identifiers only.", events: ["opened", "updated"],
  fields: { graph: { pattern: "^[a-z0-9-]{1,40}$" }, branch: { pattern: "^harvest/[A-Za-z0-9._-]{1,191}$" }, headCommit: { pattern: "^[A-Za-z0-9.]{1,120}$" } } } };

/** The shared fixture set: [name, triggerSources, accepted]. Both judges must give `accepted`. */
const SHARED = [
  ["empty", {}, true],
  ["minimal", { a: src() }, true],
  ["every key", { "harvest-branches": src({ description: "Ready harvest/* branches, one event per judged head", events: ["opened", "updated"],
    parameters: { prefix: { default: "harvest/", required: false, description: "the branch prefix", pattern: "^[A-Za-z0-9._/-]{1,80}$" }, team: { required: true } },
    fields: { graph: { pattern: "^[a-z0-9-]{1,40}$" }, branch: {} }, urlHosts: ["graph.example.org", "x-1.example"] }) }, true],
  ["sixteen sources", Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`s${i}`, src()])), true],
  ["a 40-character name", { ["a".repeat(40)]: src() }, true],
  ["a 200-character description", { a: src({ description: "d".repeat(200) }) }, true],
  ["sixteen events", { a: src({ events: Array.from({ length: 16 }, (_, i) => `e${i}`) }) }, true],
  ["not an object", [], false],
  ["a string", "x", false],
  ["seventeen sources", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, src()])), false],
  ["an uppercase name", { Bad: src() }, false],
  ["a 41-character name", { ["a".repeat(41)]: src() }, false],
  ["a name starting with a dash", { "-a": src() }, false],
  ["a source that is not an object", { a: "go" }, false],
  ["an unknown key", { a: src({ cursor: true }) }, false],
  ["no command", { a: { events: ["opened"] } }, false],
  ["a command that is not a command name", { a: src({ command: "Go Now" }) }, false],
  ["no events", { a: { command: "go" } }, false],
  ["zero events", { a: src({ events: [] }) }, false],
  ["seventeen events", { a: src({ events: Array.from({ length: 17 }, (_, i) => `e${i}`) }) }, false],
  ["a duplicate event", { a: src({ events: ["opened", "opened"] }) }, false],
  ["an event name with a dash", { a: src({ events: ["entered-status"] }) }, false],
  ["an event that is not a string", { a: src({ events: [1] }) }, false],
  ["a description over 200", { a: src({ description: "d".repeat(201) }) }, false],
  ["a description over two lines", { a: src({ description: "one\ntwo" }) }, false],
  ["a description with a C1 control", { a: src({ description: "a\u0085b" }) }, false],
  ["a description with a line separator", { a: src({ description: "a\u2028b" }) }, false],
  ["seventeen parameters", { a: src({ parameters: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, {}])) }) }, false],
  ["a parameter name with a dash", { a: src({ parameters: { "a-b": {} } }) }, false],
  ["a parameter with an unknown key", { a: src({ parameters: { p: { type: "string" } } }) }, false],
  ["a parameter that is not an object", { a: src({ parameters: { p: "x" } }) }, false],
  ["required that is not a boolean", { a: src({ parameters: { p: { required: "yes" } } }) }, false],
  ["a default over 200", { a: src({ parameters: { p: { default: "x".repeat(201), pattern: ".*" } } }) }, false],
  ["a default that is not a string", { a: src({ parameters: { p: { default: 3 } } }) }, false],
  ["an empty pattern", { a: src({ fields: { f: { pattern: "" } } }) }, false],
  ["a field with an unknown key", { a: src({ fields: { f: { pattern: ".*", required: true } } }) }, false],
  ["seventeen fields", { a: src({ fields: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, {}])) }) }, false],
  ["urlHosts not a list", { a: src({ urlHosts: "graph.example.org" }) }, false],
  ["a URL host with a scheme", { a: src({ urlHosts: ["https://graph.example.org"] }) }, false],
  ["a URL host with a port", { a: src({ urlHosts: ["graph.example.org:443"] }) }, false],
  ["an uppercase URL host", { a: src({ urlHosts: ["Graph.example.org"] }) }, false],
  ["a wildcard URL host", { a: src({ urlHosts: ["*.example.org"] }) }, false],
  ["a duplicate URL host", { a: src({ urlHosts: ["a.example", "a.example"] }) }, false],
  ["seventeen URL hosts", { a: src({ urlHosts: Array.from({ length: 17 }, (_, i) => `h${i}.example`) }) }, false],
  ["lab's real declaration", LAB, true],
];
/** The rules JSON Schema cannot say: the schema accepts these, use refuses them. */
const USE_TIME_ONLY = [
  ["a command that names no command", { a: src({ command: "nope" }) }],
  ["a pattern that does not compile", { a: src({ fields: { f: { pattern: "[a-" } } }) }],
  ["a pattern invalid only under the u flag", { a: src({ fields: { f: { pattern: "\\q" } } }) }],
  ["a default that does not match its pattern", { a: src({ parameters: { p: { default: "B", pattern: "^[a-z]+$" } } }) }],
  ["a default that does not match the default pattern", { a: src({ parameters: { p: { default: "a;b" } } }) }],
];

test("the schema and the use-time validator accept and refuse the same triggerSources (one shared fixture set)", () => {
  assert.equal(validate(base), true, `the manifest every case extends is valid: ${JSON.stringify(validate.errors)}`);
  for (const [name, ts, accepted] of SHARED) {
    assert.equal(bySchema(ts), accepted, `schema, ${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(byUse(ts), accepted, `use, ${name}: ${JSON.stringify(triggerSourcesOf(manifest(ts)).problems)}`);
  }
  for (const [name, ts] of USE_TIME_ONLY) {
    assert.equal(bySchema(ts), true, `use-time only, the schema accepts ${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(byUse(ts), false, `use-time only, use refuses ${name}`);
  }
  // lab's whole manifest shape (its command present) validates too.
  assert.equal(validate({ ...base, commands: { "review-source": "bin/oats-omnigraph-maintenance.mjs review-source" }, triggerSources: LAB }), true, JSON.stringify(validate.errors));
});

test("triggerSourcesOf: the normalized source; lab's real declaration is well formed", () => {
  const lab = triggerSourcesOf({ commands: { "review-source": "bin/oats-omnigraph-maintenance.mjs review-source" }, triggerSources: LAB });
  assert.deepEqual(lab.problems, []);
  const s = lab.sources["harvest-branches"];
  assert.deepEqual({ ...s, fields: Object.keys(s.fields) }, { name: "harvest-branches", command: "review-source", script: "bin/oats-omnigraph-maintenance.mjs", args: ["review-source"],
    description: LAB["harvest-branches"].description, events: ["opened", "updated"], parameters: {}, fields: ["graph", "branch", "headCommit"], urlHosts: [] });
  assert.equal(s.fields.branch.pattern.test("harvest/2026-10-08.a"), true);
  assert.equal(s.fields.branch.pattern.test("main"), false);

  const one = triggerSourcesOf(manifest({ a: src({ parameters: { p: { required: true }, q: { default: "harvest/" } }, fields: { f: {} } }) })).sources.a;
  assert.deepEqual([one.script, one.args], ["bin/x.mjs", ["poll", "--json"]], "the command split on whitespace, as a provider check's");
  assert.deepEqual([one.parameters.p.required, one.parameters.p.default, one.parameters.q.required, one.parameters.q.default], [true, null, false, "harvest/"]);
  assert.equal(one.parameters.p.pattern.test("a b,c*@x/y:z"), true, "the default value pattern");
  assert.equal(one.parameters.p.pattern.test("a;b"), false);
  assert.equal(one.parameters.p.pattern.test(""), true, "an empty value matches the default value pattern");
  assert.equal(one.fields.f.pattern.test(""), false, "a field value is never empty under the default pattern");
  assert.equal(one.fields.f.pattern.test("PROJ-123"), true);
  assert.equal(one.description, null);
  assert.deepEqual(triggerSourcesOf({ capability: "x" }), { sources: {}, problems: [] }, "no triggerSources: nothing, no problem");
  for (const m of [null, undefined, 3, "x", []]) assert.deepEqual(triggerSourcesOf(m), { sources: {}, problems: [] }, `never throws: ${JSON.stringify(m)}`);
  assert.equal(SOURCE_NAME_RE.test("harvest-branches"), true);
  assert.deepEqual([DEFAULT_PARAM_PATTERN, DEFAULT_FIELD_PATTERN], ["^[A-Za-z0-9._/:@ ,*-]{0,200}$", "^[A-Za-z0-9._/:@-]{1,200}$"]);
});

test("triggerSourcesOf: patterns are compiled once and anchored as ^(?:…)$", () => {
  const field = (pattern) => triggerSourcesOf(manifest({ a: src({ fields: { f: { pattern } } }) })).sources.a.fields.f.pattern;
  const abc = field("abc");
  assert.equal(abc.source, "^(?:abc)$");
  assert.deepEqual(["abc", "xabc", "abcx"].map((v) => abc.test(v)), [true, false, false], "an unanchored pattern matches only the whole value");
  const alt = field("^a|b$");
  assert.equal(alt.source, "^(?:^a|b$)$");
  assert.deepEqual(["a", "b", "ax", "xb"].map((v) => alt.test(v)), [true, true, false, false], "each alternative is anchored");
  assert.equal(field("^[a-z]+$").test("ab"), true, "an anchored pattern keeps its meaning");
  assert.equal(abc.flags, "u");
  const bad = triggerSourcesOf(manifest({ a: src({ fields: { f: { pattern: "(" } } }) }));
  assert.deepEqual(bad.sources, {});
  assert.deepEqual(bad.problems.map((p) => [p.source, p.pointer]), [["a", "/triggerSources/a/fields/f/pattern"]]);
  assert.match(bad.problems[0].message, /^trigger source "a": pattern "\(" is not a valid regular expression$/);
  const def = triggerSourcesOf(manifest({ a: src({ parameters: { p: { default: "B", pattern: "[a-z]+" } } }) }));
  assert.deepEqual(def.problems.map((p) => p.pointer), ["/triggerSources/a/parameters/p/default"], "a default is checked against its (anchored) pattern");
});

test("triggerSourcesOf: a problem disables only its source; a malformed top level disables all; pointers are RFC 6901", () => {
  const per = triggerSourcesOf(manifest({ good: src(), bad: src({ events: ["opened", "Bad"], command: "nope", urlHosts: ["a.example", "A.example"] }) }));
  assert.deepEqual(Object.keys(per.sources), ["good"], "the well-formed sibling still works");
  assert.deepEqual(per.problems.map((p) => [p.source, p.pointer]), [["bad", "/triggerSources/bad/command"], ["bad", "/triggerSources/bad/events/1"], ["bad", "/triggerSources/bad/urlHosts/1"]]);
  assert.ok(per.problems.every((p) => p.message.startsWith('trigger source "bad": ')), JSON.stringify(per.problems));
  for (const ts of [[], "x", null, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, src()]))]) {
    const top = triggerSourcesOf(manifest(ts));
    assert.deepEqual(top.sources, {});
    assert.deepEqual(top.problems.map((p) => [p.source, p.pointer]), [[null, "/triggerSources"]], JSON.stringify(ts));
  }
  const esc = triggerSourcesOf(manifest({ "a/b~c": src() }));
  assert.deepEqual(esc.problems.map((p) => p.pointer), ["/triggerSources/a~1b~0c"], "~ and / are escaped");
  const deep = triggerSourcesOf(manifest({ a: src({ parameters: { p: { kind: "x" } }, fields: { "f-1": {} }, events: [] }) }));
  assert.deepEqual(deep.problems.map((p) => p.pointer).sort(), ["/triggerSources/a/events", "/triggerSources/a/fields/f-1", "/triggerSources/a/parameters/p/kind"]);
  const notObject = triggerSourcesOf(manifest({ a: 1 }));
  assert.deepEqual(notObject.problems.map((p) => p.pointer), ["/triggerSources/a"]);
});

test("containment: a malformed triggerSources never refuses the capability — the manifest contract reports nothing new", () => {
  const sound = { capability: "acme.x", commands: base.commands };
  const before = manifestContractProblems(sound);
  for (const [name, ts] of [...SHARED.filter(([, , accepted]) => !accepted), ...USE_TIME_ONLY]) {
    assert.deepEqual(manifestContractProblems({ ...sound, triggerSources: ts }), before, `${name}: the contract is unchanged`);
  }
  // The catalog and `capabilities show` of a member capability with a malformed declaration: test/capability-show.test.mjs.
});
