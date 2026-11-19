// A retire hook's warnings stay readable in the instance's events after the retire (oats-project/oats#1749).
//
// retireInstance appends each entry of its retire hooks' `warnings` as one row of the kind
// RETIRE_HOOK_WARNING_KIND (lib/instance-events.mjs; the tests read the kind from it),
// `data: {message}`, to the workspace log only, as soon as the hooks return. This file pins:
//   - after `oats retire`, `oats instance events --json` returns one row per hook warning, in the
//     answer's order and with its text, producer kernel, before the `retired` row; the home is gone
//     (or, with --keep-dir, its own log has none of them);
//   - a retire whose hooks warn nothing writes no such row;
//   - a retire that ends quarantined, or refuses after the hooks ran, still keeps the rows, and a
//     retry of a quarantined retire adds its own, the earlier ones kept byte for byte;
//   - a row of either warning kind stores its message made safe and bounded (lib/refused-text.mjs
//     REFUSED_TEXT, WARNING_MESSAGE_MAX UTF-16 code units), and the answer keeps the text as the hook said it.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { RETIRE_HOOK_WARNING_KIND as KIND, WARNING_MESSAGE_MAX, appendEvent, readEvents } from "../lib/instance-events.mjs";

const ROOT = process.getuid?.() === 0;
const A = "test.warn-a", B = "test.warn-b";
const ACTION = "run: aw id team remove-member x --cert-id y";
const SECOND = "revoke the grant by hand: aw id grant revoke g-1";
/** A warning with a newline, an ESC and a bidi override, longer than a row keeps; and that warning
 *  as a row stores it: each of the three replaced with U+FFFD, cut to WARNING_MESSAGE_MAX UTF-16
 *  code units ending in `…`. */
const DIRTY = `renew\nnow \u001b[2J \u202Eevil ${"x".repeat(3000)}`;
const STORED = `${"renew\uFFFDnow \uFFFD[2J \uFFFDevil " + "x".repeat(3000)}`.slice(0, WARNING_MESSAGE_MAX - 1) + "…";

/** A retire hook of `cap`. It prints `<agents root>/warning-<cap>` as its `warning`, when that file
 *  exists; with `<agents root>/incomplete-<cap>` it reports its cleanup incomplete (exit 0); with
 *  `<agents root>/unreadable-<cap>` it leaves in the home a file nobody may read, so the inspection after
 *  the hooks refuses the retire. */
const hook = (cap) => `import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.OATS_ROOT, home = process.env.OATS_INSTANCE_HOME;
const at = (name) => join(root, name);
if (existsSync(at("unreadable-${cap}"))) { const left = join(home, "left-by-the-hook"); writeFileSync(left, "x\\n"); chmodSync(left, 0o000); }
const answer = { meta: existsSync(at("incomplete-${cap}")) ? { retired: false, reason: "the provider did not answer" } : { retired: true } };
if (existsSync(at("warning-${cap}"))) answer.warning = readFileSync(at("warning-${cap}"), "utf8");
console.log(JSON.stringify(answer));
`;

function deployment(t) {
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: "directory", capabilities: { [A]: { from: "here" }, [B]: { from: "here" } } } } },
    capabilities: Object.fromEntries([A, B].map((cap) => [cap, { manifest: { hooks: { retire: "hook.mjs" } }, files: { "hook.mjs": hook(cap) } }])),
  });
  fx.beforeCleanup(() => { try { rmSync(join(fx.root, "dev", "instances", "dev-w", "left-by-the-hook"), { force: true }); } catch { /* none */ } });
  const rowsOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const name = "dev-w", home = join(fx.root, "dev", "instances", name);
  return {
    fx, name, home,
    workspaceLog: join(fx.dep, ".agents", "events", `dev--${name}.jsonl`),
    homeLog: join(home, ".oats-events.jsonl"),
    rowsOf,
    spawn: async () => {
      const hostPath = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      try { assert.equal((await fx.inEnv(() => fx.spawn("dev", { name }))).home, home); } finally { process.env.PATH = hostPath; }
    },
    warn: (cap, text) => writeFileSync(join(fx.root, `warning-${cap}`), text),
    /** `oats retire --json`: its answer (no envelope) is one JSON document over several lines. */
    retire: (...flags) => { const r = fx.cli(["retire", name, "--json", ...flags]); return { ...r, json: () => JSON.parse(r.stdout) }; },
    events: () => { const r = fx.cli(["instance", "events", name, "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr); return r.json().result.events; },
  };
}

test("after `oats retire`, the events hold one warning row per retire hook warning, as the answer says it, in the workspace log only", async (t) => {
  const d = deployment(t);
  await d.spawn();
  d.warn(A, ACTION);
  d.warn(B, SECOND);
  const r = d.retire();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const answer = r.json();
  assert.equal(answer.removedDir, true);
  assert.equal(existsSync(d.home), false, "the home is gone");
  const fromHooks = answer.warnings.filter((w) => w === ACTION || w === SECOND);
  assert.equal(fromHooks.length, 2, `both hook warnings are in the answer: ${JSON.stringify(answer.warnings)}`);

  const events = d.events();
  const rows = events.filter((e) => e.kind === KIND);
  assert.deepEqual(rows.map((e) => e.data), fromHooks.map((message) => ({ message })), "one row per warning, its text exactly, in the answer's order");
  for (const row of rows) assert.equal(row.producer, "kernel");
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.lastIndexOf(KIND) < kinds.indexOf("retired"), `the rows come before the retired row: ${kinds}`);
  assert.equal(d.rowsOf(d.workspaceLog).filter((e) => e.kind === KIND).length, 2, "they are the workspace log's rows");
});

test("with --keep-dir, the home's own log has none of the rows", async (t) => {
  const d = deployment(t);
  await d.spawn();
  d.warn(A, ACTION);
  const r = d.retire("--keep-dir");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.json().warnings.includes(ACTION));
  assert.equal(existsSync(d.home), true, "the home is kept");
  assert.deepEqual(d.rowsOf(d.workspaceLog).filter((e) => e.kind === KIND).map((e) => e.data), [{ message: ACTION }]);
  assert.equal(d.rowsOf(d.homeLog).some((e) => e.kind === KIND), false, "never the home's log");
});

test("a retire whose hooks warn nothing writes no warning row", async (t) => {
  const d = deployment(t);
  await d.spawn();
  const r = d.retire();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const events = d.events();
  assert.ok(events.some((e) => e.kind === "retired"), "fixture premise: the retire is recorded");
  assert.equal(events.some((e) => e.kind === KIND), false);
});

test("a retire that ends quarantined because a hook reported incomplete cleanup keeps the hook's warning as a row", async (t) => {
  const d = deployment(t);
  await d.spawn();
  d.warn(B, ACTION);
  writeFileSync(join(d.fx.root, `incomplete-${B}`), "");
  const r = d.retire();
  const doc = r.json();
  assert.ok(doc.rollbackIncomplete?.length, `fixture premise: the home is quarantined\n${r.stdout}\n${r.stderr}`);
  assert.ok(doc.warnings.includes(ACTION));
  assert.equal(existsSync(d.home), true);
  assert.deepEqual(d.events().filter((e) => e.kind === KIND).map((e) => e.data), [{ message: ACTION }]);
  assert.equal(d.rowsOf(d.homeLog).some((e) => e.kind === KIND), false, "never the home's log");
});

test("a retire that refuses after the hooks ran keeps their warnings as rows", { skip: ROOT && "root reads a file nobody may read" }, async (t) => {
  const d = deployment(t);
  await d.spawn();
  d.warn(A, ACTION);
  writeFileSync(join(d.fx.root, `unreadable-${A}`), "");
  const r = d.retire();
  assert.notEqual(r.status, 0, r.stdout);
  assert.equal(r.json().error.code, "E_WORK_INSPECTION_FAILED", r.stdout + r.stderr);
  assert.equal(existsSync(d.home), true);
  assert.deepEqual(d.events().filter((e) => e.kind === KIND).map((e) => e.data), [{ message: ACTION }]);
  chmodSync(join(d.home, "left-by-the-hook"), 0o600);
});

test("a retry of a quarantined retire adds its own rows; the earlier rows are kept byte for byte", async (t) => {
  const d = deployment(t);
  await d.spawn();
  d.warn(B, ACTION);
  writeFileSync(join(d.fx.root, `incomplete-${B}`), "");
  assert.ok(d.retire().json().rollbackIncomplete?.length, "fixture premise: the first retire quarantines the home");
  const before = readFileSync(d.workspaceLog, "utf8");
  rmSync(join(d.fx.root, `incomplete-${B}`));
  d.warn(B, "second attempt: nothing left to remove");
  const r = d.retire();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json().removedDir, true, "the retry completes");
  const after = readFileSync(d.workspaceLog, "utf8");
  assert.ok(after.startsWith(before), "the earlier rows are unchanged");
  assert.deepEqual(d.rowsOf(d.workspaceLog).filter((e) => e.kind === KIND).map((e) => e.data.message), [ACTION, "second attempt: nothing left to remove"], "each run of the hooks has its own row");
});

test("a retire-warning row stores the hook's warning made safe and bounded; the answer keeps the original", async (t) => {
  const d = deployment(t);
  await d.spawn();
  d.warn(A, DIRTY);
  const r = d.retire();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.json().warnings.includes(DIRTY), "the answer's warning is the hook's text as given");
  assert.deepEqual(d.events().filter((e) => e.kind === KIND).map((e) => e.data), [{ message: STORED }]);
});

test("both warning kinds store a message made safe and bounded, whichever writer appends it; a value that is not a string is stored as its JSON", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "warn-rows-"))); t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "agents", "dev", "instances", "dev-1");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "instance.json"), JSON.stringify({ agent: "dev", instance: "dev-1", createdAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal(STORED.length, WARNING_MESSAGE_MAX);
  for (const kind of ["launch-warning", KIND]) {
    const message = (written) => { assert.equal(written.ok, true); return written.row.data.message; };
    assert.equal(message(appendEvent(home, { kind, data: { message: DIRTY } })), STORED, kind);
    assert.equal(message(appendEvent(home, { kind, data: { message: "x".repeat(WARNING_MESSAGE_MAX) } })), "x".repeat(WARNING_MESSAGE_MAX), `${kind}: one at the bound is kept whole`);
    assert.equal(message(appendEvent(home, { kind, data: { message: { action: "renew" } } })), '{"action":"renew"}', `${kind}: an object`);
  }
  // Astral characters are two units each: the cut counts units, and never splits a pair.
  const astral = "\u{1F600}".repeat(3000);
  for (const kind of ["launch-warning", KIND]) {
    const stored = appendEvent(home, { kind, data: { message: astral } }).row.data.message;
    assert.ok(stored.length <= WARNING_MESSAGE_MAX, `${kind}: ${stored.length} units`);
    assert.ok(stored.endsWith("…"), kind);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(stored), false, `${kind}: no lone surrogate`);
    assert.equal(stored, `${"\u{1F600}".repeat(1023)}…`, `${kind}: as many whole pairs as fit before the mark`);
  }
  const rows = readEvents(home).events.filter((e) => e.data.message !== `${"\u{1F600}".repeat(1023)}…`);
  assert.deepEqual(rows.map((e) => e.data.message), [STORED, "x".repeat(WARNING_MESSAGE_MAX), '{"action":"renew"}', STORED, "x".repeat(WARNING_MESSAGE_MAX), '{"action":"renew"}'], "as read back");
});
