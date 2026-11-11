// The deployment reads' per-call state (awebai/oats#1630, lib/read-call.mjs READ_STATE): a process that answers
// `oats status` and `oats workspace status` many times must forget, between calls, everything a one-shot CLI
// forgets at exit. A tripwire: the reads' import closure (the leaves lib/hot-reads.mjs lists for both reads, and
// every module those import, statically or by a literal `import()`) is scanned for module-level state
// (test/helpers/module-state.mjs: every module-scope `let`/`var` declarator, and every module-scope `const`
// Map, Set, WeakMap, WeakSet, object or array that its module or an importer writes or lets out of sight), and
// each binding found must have its row in READ_STATE: reset per call, scoped to the call, or safe with a
// reason. A new one fails here, by module and name, until it has one. Packages (yaml) are not scanned: the
// reads only call its parser. The caches outside the closure (OUTSIDE) must stay outside it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { hotLeaves, hotRead } from "../lib/hot-reads.mjs";
import { moduleState } from "./helpers/module-state.mjs";
import { READ_STATE, resetReadState } from "../lib/read-call.mjs";
import { noteRuntimeName, runtimeNameWarning } from "../lib/deprecation.mjs";
import { activateLocalInputs, localRevision, recordLocalInput } from "../lib/local-inputs.mjs";
import { observeResolvedDeployment, resolvedDeployment, settleResolvedDeployment } from "../lib/resolved-deployment.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const rel = (file) => relative(ROOT, file).split("\\").join("/");
/** Module-level caches the reads cannot reach, named so that a move into the closure is a decision: the scan
 *  would then find them, and they would need a READ_STATE row. */
const OUTSIDE = [
  { module: "lib/core.mjs", binding: "whichMemo" },
  { module: "lib/servers.mjs", binding: "probeCaches" },
];

/** Every module the two reads can load: the hot-read leaves, then their imports, transitively. */
function readClosure() {
  const roots = new Set();
  for (const argv of [["status"], ["workspace", "status"]]) {
    const read = hotRead(argv);
    for (const line of Object.keys(read.lines)) for (const leaf of hotLeaves(read, line)) roots.add(join(ROOT, "lib", `${leaf}.mjs`));
  }
  const seen = new Map(), queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    // A specifier that is not one literal would hide a module from this scan.
    assert.doesNotMatch(source, /\bimport\s*\(\s*(?!["'])/, `${rel(file)} imports a module by a non-literal specifier`);
    for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)["'](\.{1,2}\/[^"']+)["']/gm)) queue.push(resolve(dirname(file), m[1]));
  }
  return seen;
}

/** Who imports what in `closure` (file → source): `{ [file]: [{ from, imported, local, namespace }] }`. An
 *  import of a relative module in a form not read here fails, so that no importer goes unseen. */
function importsIn(closure) {
  const out = {};
  const names = (list) => list.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^([\w$]+)(?:\s+as\s+|\s*:\s*)?([\w$]+)?$/.exec(x);
    assert.ok(m, `an import entry this test cannot read: ${x}`);
    return [m[1], m[2] ?? m[1]];
  });
  for (const [file, source] of closure) {
    const rows = out[file] = [];
    const at = (spec) => resolve(dirname(file), spec);
    let read = 0;
    for (const m of source.matchAll(/\b(?:import|export)\s*\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g)) { read++; for (const [imported, local] of names(m[1])) rows.push({ from: at(m[2]), imported, local }); }
    for (const m of source.matchAll(/\bimport\s*\*\s*as\s+([\w$]+)\s+from\s*["'](\.{1,2}\/[^"']+)["']/g)) { read++; rows.push({ from: at(m[2]), local: m[1], namespace: true }); }
    for (const m of source.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) { read++; for (const [imported, local] of names(m[1])) rows.push({ from: at(m[2]), imported, local }); }
    for (const m of source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) { read++; rows.push({ from: at(m[2]), local: m[1], namespace: true }); }
    const all = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^import\s+)["'](\.{1,2}\/[^"']+)["']/gm)].length;
    assert.equal(read, all, `${rel(file)} imports a relative module in a form this test cannot follow`);
  }
  return out;
}

/** The module-level state of every module of `closure`: `["<module> <binding>"]`. */
function closureState(closure) {
  const imports = importsIn(closure);
  // The importers of `file`'s export `name`, through re-exports (`export { name } from`) too.
  const importersOf = (file, name, seen = new Set()) => {
    if (seen.has(`${file}\0${name}`)) return [];
    seen.add(`${file}\0${name}`);
    const found = [];
    for (const [importer, rows] of Object.entries(imports)) for (const row of rows) {
      if (row.from !== file) continue;
      if (row.namespace) found.push({ source: closure.get(importer), local: row.local, member: name });
      else if (row.imported === name) {
        found.push({ source: closure.get(importer), local: row.local });
        found.push(...importersOf(importer, row.local, seen));
      }
    }
    return found;
  };
  const found = [];
  for (const [file, source] of closure) for (const binding of moduleState(source, { importersOf: (name) => importersOf(file, name) })) found.push(`${rel(file)} ${binding}`);
  return found;
}

test("every module-level state the deployment reads write has its row in READ_STATE", () => {
  const closure = readClosure();
  assert.ok(closure.size > 20, "the closure was read");
  const modules = new Set([...closure.keys()].map(rel));
  for (const leaf of ["lib/roster-read.mjs", "lib/workspace-read.mjs", "lib/read-call.mjs", "lib/member-clone.mjs", "lib/drift.mjs", "lib/deployments.mjs"]) assert.ok(modules.has(leaf), `${leaf} is in the closure`);
  // Leaves: never core.mjs, nor bin. Of the packages, only the process identity the kernel's locks are judged by.
  for (const m of modules) assert.ok(m === "packages/record/lib/process-identity.mjs" || (m.startsWith("lib/") && m !== "lib/core.mjs"), `${m} may not be in the reads' closure`);
  const rows = new Map(READ_STATE.map((row) => [`${row.module} ${row.binding}`, row]));
  const found = new Set(closureState(closure));
  const missing = [...found].filter((key) => !rows.has(key));
  assert.deepEqual(missing, [], `module-level state the reads can reach with no READ_STATE row in lib/read-call.mjs (reset it per call, or list it as safe with its reason): ${missing.join(", ")}`);
  const stale = [...rows.keys()].filter((key) => !found.has(key));
  assert.deepEqual(stale, [], `READ_STATE rows the scan no longer finds (remove them): ${stale.join(", ")}`);
  for (const row of READ_STATE) {
    assert.ok(["reset", "scoped", "safe"].includes(row.how), `${row.module} ${row.binding}: how`);
    if (row.how === "reset") assert.equal(typeof row.reset, "function", `${row.module} ${row.binding}: its reset`);
    else assert.ok(typeof row.why === "string" && row.why.length > 20, `${row.module} ${row.binding}: why it is ${row.how}`);
  }
});

test("the caches outside the reads' closure are found where they are, and stay outside it", () => {
  const modules = new Set([...readClosure().keys()].map(rel));
  for (const { module, binding } of OUTSIDE) {
    assert.ok(moduleState(readFileSync(join(ROOT, module), "utf8")).includes(binding), `the scan finds ${module} ${binding}`);
    assert.ok(!modules.has(module), `${module} (${binding}) entered the reads' closure: give ${binding} a READ_STATE row first`);
  }
});

test("resetReadState forgets what the last read noted", () => {
  noteRuntimeName("a test");
  activateLocalInputs();
  recordLocalInput(join(ROOT, "package.json"), "x");
  let settled = "not settled";
  observeResolvedDeployment((dir) => { settled = dir; }, { atExit: false });
  resolvedDeployment("/somewhere", { canonical: true });
  resetReadState();
  assert.equal(runtimeNameWarning(), null, "the deprecated-name sources");
  assert.equal(localRevision(), null, "the local inputs, no longer recorded");
  // The observer is kept (it is the call's to settle); what was reported before the reset is not.
  settleResolvedDeployment();
  assert.equal(settled, "not settled", "nothing reported before the reset reaches the observer");
});

test("the scan sees every declarator and every write, however it is spelled, and passes reads", () => {
  const cases = [
    ["let inputs = null, staleHead = null;\nexport function readHead() { return staleHead ??= \"first deployment\"; }", ["inputs", "staleHead"]],
    ["var a = 1,\n  b = [1, 2],\n  c;", ["a", "b", "c"]],
    ["let { a, b: c, ...d } = x;\nlet [e, f = 1] = y;", ["a", "c", "d", "e", "f"]],
    ["const stale = new Map();\nexport function memo() { stale.set (\"head\", 1); }", ["stale"]],
    ["const m = new WeakMap();\nexport const f = (k) => m?.\n  delete(k);", ["m"]],
    ["const r = { canonical: null };\nexport const f = (d) => { r . canonical = d; };", ["r"]],
    ["const q = [];\nexport const f = (x) => { q[q.length] = x; };", ["q"]],
    ["const o = {};\nexport const f = () => Object.assign(o, { a: 1 });", ["o"]],
    ["const m = new Map();\nexport const f = () => g(m);", ["m"], "passed out"],
    ["const m = new Map();\nexport const f = () => m;", ["m"], "returned"],
    ["const R = /[a-z{]/g;\nconst s = `${\"{\"}`;\n// let hidden = 1;\nlet z = 1;", ["z"], "comments, strings, templates and regexes hide nothing"],
    ["const T = new Set([\"a\"]);\nexport const f = (x) => T.has(x) && [...T].length > 0;", [], "read only"],
    ["const P = [2, 45];\nexport function g() { const [major, minor] = P; return major + minor; }", [], "destructured"],
  ];
  for (const [src, want, why] of cases) assert.deepEqual(moduleState(src), want, why ?? src);
  // An export is followed into its importers: a write there, or a namespace passed on whole, is the exporter's state.
  const lib = "export const L = [\"a\"];\nexport const S = new Set();";
  assert.deepEqual(moduleState(lib, { importersOf: () => [{ source: "import { L, S as s } from \"./lib.mjs\";\nL.map((x) => x); s.has(1);", local: "L" }] }), []);
  assert.deepEqual(moduleState(lib, { importersOf: (name) => [{ source: "import { S as s } from \"./lib.mjs\";\ns.add(1);", local: name === "S" ? "s" : "nothing" }] }), ["S"]);
  assert.deepEqual(moduleState(lib, { importersOf: (name) => [{ source: "import * as lib from \"./lib.mjs\";\nuse({ remote: lib });", local: "lib", member: name }] }), ["L", "S"]);
  assert.deepEqual(moduleState(lib, { importersOf: (name) => [{ source: "import * as lib from \"./lib.mjs\";\nlib.L.map(String);", local: "lib", member: name }] }), []);
  // What is not exported is not reachable from an importer.
  assert.deepEqual(moduleState("const H = new Set();\nexport const has = (x) => H.has(x);", { importersOf: () => [{ source: "import * as m from \"./h.mjs\";\nuse(m);", local: "m", member: "H" }] }), []);
});
