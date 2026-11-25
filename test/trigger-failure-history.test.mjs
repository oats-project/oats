// Feature trigger-failure-history (oats-project/oats#2122, KP-15): a trigger's failed spawns as rows.
// `failures` (newest first, at most 50, one row per attempt per key) and `failuresTotal` (every failure
// since the trigger was added) are kept in the trigger's state and answered by `oats trigger status
// --json`; a later success of a key marks its earlier rows `resolved`. Every text is bounded and has the
// kernel's refused characters replaced. `lastError` is unchanged. The spawns are real (`oats spawn` as a
// child in a real deployment, --no-launch), with a fake `gh` on PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { KERNEL_FEATURES } from "../lib/kernel-features.mjs";

const T = await import("../lib/triggers.mjs");
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };

const REPO = "github.com/acme/knowledge";
const pr = (number) => ({ number, html_url: `https://github.com/acme/knowledge/pull/${number}`, title: "harvest", body: "", draft: false, head: { sha: `${String(number).padStart(2, "0")}${"a".repeat(38)}`, ref: `h-${number}` }, base: { ref: "main" }, labels: [], state: "open", updated_at: "2026-09-26T11:59:00Z", created_at: "2026-09-26T11:58:00Z" });

/** A fake `gh` that lists <dir>/pulls.json. */
function fakeGh(dir) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  *"/pulls"*) cat "${dir}/pulls.json"; exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 2
`);
  chmodSync(join(bin, "gh"), 0o755);
  const gh = { bin, pulls: (list) => writeFileSync(join(dir, "pulls.json"), JSON.stringify(list)) };
  gh.pulls([]);
  return gh;
}
/** A deployment with one soul and one trigger on it; `disabled` starts with the soul disabled on this host,
 *  so every spawn fails E_SOUL_DISABLED until enable() lifts it. */
function fixture(t, { disabled = true } = {}) {
  const fx = v2Deployment({ name: "acme", souls: { reviewer: { soul: {} } }, local: disabled ? { souls: { disabled: ["reviewer"] } } : {} });
  t.after(fx.cleanup);
  fx.gh = fakeGh(join(fx.base, "gh"));
  fx.env.PATH = `${fx.gh.bin}:${fx.env.PATH}`;
  fx.enable = () => writeFileSync(join(fx.dep, "oats-local.yaml"), YAML.stringify({ schemaVersion: 2, workspace: fx.ref }));
  fx.add = () => {
    const file = join(fx.base, "trigger.json");
    writeFileSync(file, JSON.stringify({ id: "kb-review", enabled: true, kind: "trigger", on: { source: "github.pull_request", repo: REPO, events: ["opened"], poll: "2m" }, spawn: { soul: "reviewer", purpose: "review-pr-{number}", task: "Review {repo}#{number}." }, concurrency: { max: 5, perKey: 1 } }));
    ok(fx.cli(["trigger", "add", "--file", file, "--json"]), "trigger add");
  };
  fx.add();
  return fx;
}
/** The tick as the host runs it, in process (no tmux), with the fake gh on PATH. */
const tick = (fx, iso, opts = {}) => fx.inEnv(() => {
  const path = process.env.PATH;
  process.env.PATH = fx.env.PATH;
  try { return T.tickTriggers(fx.dep, { now: new Date(iso), ...opts, io: { noLaunch: true, ...(opts.io || {}) } }); } finally { process.env.PATH = path; }
});
const status = (fx) => ok(fx.cli(["trigger", "status", "--json"]), "trigger status").triggers[0];
const stateFile = (fx) => join(fx.dep, ".agents", "schedules", "triggers.json");
const editState = (fx, change) => { const doc = JSON.parse(readFileSync(stateFile(fx), "utf8")); change(doc.triggers["local/kb-review"]); writeFileSync(stateFile(fx), JSON.stringify(doc, null, 2) + "\n"); };
/** An `oats` whose spawn (never its preview) answers `error` as a refusal. */
function refusingOats(fx, error) {
  const bin = join(fx.base, "refusing-oats.mjs");
  writeFileSync(bin, `import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2);
if (argv[0] === "spawn" && !argv.includes("--preview")) { process.stdout.write(JSON.stringify({ ok: false, error: ${JSON.stringify(error)} }) + "\\n"); process.exit(1); }
const r = spawnSync(process.execPath, [${JSON.stringify(join(import.meta.dirname, "..", "bin", "oats.mjs"))}, ...argv], { stdio: "inherit" });
process.exit(r.status ?? 1);
`);
  return bin;
}

test("the kernel lists the feature", () => {
  assert.ok(KERNEL_FEATURES.includes("trigger-failure-history"));
});

test("a trigger with no failed spawn answers an empty list and a zero total", async (t) => {
  const fx = fixture(t, { disabled: false });
  assert.deepEqual([status(fx).failures, status(fx).failuresTotal], [[], 0], "before any poll");
  fx.gh.pulls([pr(7)]);
  assert.deepEqual((await tick(fx, "2026-09-26T12:00:10Z")).map((r) => r.action), ["fired"]);
  const st = status(fx);
  assert.deepEqual([st.failures, st.failuresTotal, st.lastError], [[], 0, null]);
});

test("each failed attempt of a key is a row, newest first, and a later success marks them resolved and keeps them", async (t) => {
  const fx = fixture(t);
  fx.gh.pulls([pr(7)]);
  assert.deepEqual((await tick(fx, "2026-09-26T12:00:10Z")).map((r) => [r.action, r.code]), [["spawn-failed", "E_SOUL_DISABLED"]]);
  let st = status(fx);
  assert.equal(st.failuresTotal, 1);
  const key = st.pending[0].key;
  assert.deepEqual(Object.keys(st.failures[0]), ["attempt", "at", "key", "event", "subject", "number", "code", "message"], "a row that made no home has no instance, home or resolved");
  assert.deepEqual({ ...st.failures[0], message: null }, { attempt: 1, at: "2026-09-26T12:00:10.000Z", key, event: "opened", subject: "7", number: 7, code: "E_SOUL_DISABLED", message: null });
  assert.equal(st.failures[0].message, st.lastError.message, "the row says what lastError says");
  assert.deepEqual(st.lastError, { at: "2026-09-26T12:00:10.000Z", code: "E_SOUL_DISABLED", message: st.lastError.message, key }, "lastError is unchanged");

  // The same key fails again while another key fails for the first time: attempts are counted per key.
  fx.gh.pulls([pr(7), pr(8)]);
  await tick(fx, "2026-09-26T12:02:10Z");
  st = status(fx);
  assert.equal(st.failuresTotal, 3);
  assert.deepEqual(st.failures.map((f) => [f.at, f.subject, f.attempt]).sort(), [["2026-09-26T12:00:10.000Z", "7", 1], ["2026-09-26T12:02:10.000Z", "7", 2], ["2026-09-26T12:02:10.000Z", "8", 1]]);
  assert.equal(st.failures.at(-1).at, "2026-09-26T12:00:10.000Z", "the oldest row is last");
  assert.ok(st.failures.every((f) => !Object.hasOwn(f, "resolved")), "a row with no resolved is open");

  // Both spawn: every earlier row of each key gains `resolved` and stays listed; the total does not move.
  fx.enable();
  assert.deepEqual((await tick(fx, "2026-09-26T12:04:10Z")).map((r) => r.action), ["fired", "fired"]);
  st = status(fx);
  assert.equal(st.failuresTotal, 3);
  assert.equal(st.failures.length, 3);
  const firedBy = Object.fromEntries(st.fired.map((f) => [f.key, f.instance]));
  for (const f of st.failures) assert.deepEqual(f.resolved, { at: "2026-09-26T12:04:10.000Z", instance: firedBy[f.key] }, JSON.stringify(f));
  assert.equal(st.lastError.code, "E_SOUL_DISABLED", "lastError still names the last failure");
  assert.equal(T.readTriggerState(fx.dep).triggers["local/kb-review"].attempts, undefined, "a spawned key's attempt count ends");
});

test("the rows are cut to the newest 50, the total is every failure since the trigger was added, and removing and adding it starts again", async (t) => {
  const fx = fixture(t);
  fx.gh.pulls([pr(7)]);
  await tick(fx, "2026-09-26T12:00:10Z");
  // 50 older rows already kept, 120 failures counted: as a long-failing trigger's state file holds them.
  const old = Array.from({ length: 50 }, (_, i) => ({ attempt: 1, at: `2026-09-25T10:${String(59 - i).padStart(2, "0")}:00.000Z`, key: `old-${i}`, event: "opened", subject: String(100 + i), number: 100 + i, code: "E_SOUL_DISABLED", message: "old" }));
  editState(fx, (ts) => { ts.failures = old; ts.failuresTotal = 120; });
  assert.deepEqual([status(fx).failures.length, status(fx).failuresTotal], [50, 120], "the stored rows and total, read by another process");
  await tick(fx, "2026-09-26T12:02:10Z");
  let st = status(fx);
  assert.equal(st.failuresTotal, 121, "the total outlives the truncation");
  assert.equal(st.failures.length, 50);
  assert.deepEqual([st.failures[0].subject, st.failures[0].attempt, st.failures[1].key, st.failures.at(-1).key], ["7", 2, "old-0", "old-48"], "the newest row first, the oldest dropped");
  ok(fx.cli(["trigger", "remove", "kb-review", "--json"]), "trigger remove");
  fx.add();
  st = status(fx);
  assert.deepEqual([st.failures, st.failuresTotal], [[], 0], "a trigger removed and added again starts at zero");
});

test("a failure's texts are bounded and made safe, an unknown code reads E_TRIGGER_SPAWN, and a home the spawn left is named", async (t) => {
  const fx = fixture(t, { disabled: false });
  fx.gh.pulls([pr(7)]);
  const home = join(fx.dep, "agents", "reviewer", "instances", "reviewer-review-pr-7");
  const hostile = `first line\nsecond \u202Ereversed\u2066 \u200Bhidden\u{E0041} ${"x".repeat(2000)}`;
  await tick(fx, "2026-09-26T12:00:10Z", { io: { oatsBin: refusingOats(fx, { code: "not a code\n", message: hostile, details: { instance: "reviewer-review-pr-7", home } }) } });
  let [row] = status(fx).failures;
  assert.equal(row.code, "E_TRIGGER_SPAWN");
  assert.equal([...row.message].length, 500);
  assert.ok(row.message.endsWith("…"));
  assert.ok(row.message.startsWith("first line\uFFFDsecond \uFFFDreversed\uFFFD \uFFFDhidden\uFFFD "), JSON.stringify(row.message.slice(0, 60)));
  assert.doesNotMatch(row.message, /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200B\u{E0000}-\u{E007F}]/u);
  assert.deepEqual([row.instance, row.home], ["reviewer-review-pr-7", home], "the home a failed spawn left");
  assert.equal(status(fx).lastError.code, "not a code\n", "lastError is unchanged: it keeps what the spawn answered");

  // A code of the grammar is kept; an instance or a home that is not a name or an absolute path is not shown.
  await tick(fx, "2026-09-26T12:02:10Z", { io: { oatsBin: refusingOats(fx, { code: "E_REQUIRED_HOOK_FAILED", message: "refused", details: { instance: "Not A Name\n", home: "relative/\u202Epath" } }) } });
  [row] = status(fx).failures;
  assert.deepEqual(row, { attempt: 2, at: "2026-09-26T12:02:10.000Z", key: row.key, event: "opened", subject: "7", number: 7, code: "E_REQUIRED_HOOK_FAILED", message: "refused" });
  await tick(fx, "2026-09-26T12:04:10Z", { io: { oatsBin: refusingOats(fx, { code: `E_${"A".repeat(61)}`, message: "too long a code" }) } });
  assert.equal(status(fx).failures[0].code, "E_TRIGGER_SPAWN");
});

test("a dry run records no failure, and a state edited by hand reads as rows or as nothing", async (t) => {
  const fx = fixture(t);
  fx.gh.pulls([pr(7)]);
  assert.deepEqual((await tick(fx, "2026-09-26T12:00:10Z", { dryRun: true })).map((r) => r.action), ["spawn-failed"]);
  assert.deepEqual([status(fx).failures, status(fx).failuresTotal], [[], 0], "a dry run writes nothing");
  await tick(fx, "2026-09-26T12:00:10Z");
  const [row] = status(fx).failures;
  editState(fx, (ts) => { ts.failures = [row, "not a row", null, { at: 1 }]; ts.failuresTotal = -4; });
  assert.deepEqual([status(fx).failures, status(fx).failuresTotal], [[row], 1], "only rows are rows, and the total is never below them");
  // A row written by hand is shown by the rows' own rule: bounded, made safe, and no key of its own.
  editState(fx, (ts) => { ts.failures = [{ ...row, attempt: "3", code: "nope", message: `a\u202Eb${"y".repeat(900)}`, subject: "s".repeat(300), instance: "Bad Name", home: "relative", resolved: { at: "never", instance: "x" }, extra: true }]; });
  const [edited] = status(fx).failures;
  assert.deepEqual(Object.keys(edited), ["attempt", "at", "key", "event", "subject", "number", "code", "message"]);
  assert.deepEqual([edited.attempt, edited.code, [...edited.message].length, edited.message.slice(0, 3), [...edited.subject].length], [1, "E_TRIGGER_SPAWN", 500, "a\uFFFDb", 200]);
  editState(fx, (ts) => { ts.failures = { not: "a list" }; ts.failuresTotal = "many"; });
  assert.deepEqual([status(fx).failures, status(fx).failuresTotal], [[], 0]);
  await tick(fx, "2026-09-26T12:02:10Z");
  assert.deepEqual([status(fx).failures.length, status(fx).failuresTotal], [1, 1], "the next failure is recorded over it");
});
