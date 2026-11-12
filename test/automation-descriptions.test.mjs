// Automation descriptions (kernel 0.43.0): one rule (lib/automations.mjs validateDescription) for
// every schedule and trigger, local or in a workspace file header, plus the description-only
// update verbs and the `automation-descriptions` feature the Desktop gates its writes on. A label
// for people: a workspace header out of the rule is a warning (the entry still runs), never a stop.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";

const A = await import("../lib/automations.mjs");
const T = await import("../lib/triggers.mjs");
const S = await import("../lib/schedule.mjs");
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const fails = (r, code, what) => { const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.equal(j.error.code, code, `${what}: ${r.stdout}`); return j.error; };

const REPO = "github.com/acme/knowledge";
const OUT_OF_RULE = [7, null, "", "x".repeat(201), "a\nb", "a\rb", "a\tb", "a\0b", "a\x1bb", "a\x7fb", "a\u0085b", "a b", "a b"];
const on = { source: "github.pull_request", repo: REPO, events: ["opened"], labels: ["okf-harvest"], poll: "2m" };
const spawn = { soul: "reviewer", purpose: "review-pr-{number}", task: "Review {repo}#{number} ({url})." };
const localTrigger = (extra = {}) => ({ id: "kb-review", kind: "trigger", on, spawn, ...extra });
const header = { schemaVersion: 1, runsOn: "kb-host", owner: "github.com/kb-bot" };
const wsTrigger = { kind: "oats-trigger", ...header, on, spawn };
const wsSchedule = { kind: "oats-schedule", ...header, run: "spawn", cron: "0 7 * * *", tz: "UTC", agent: "reviewer", task: "Write the nightly digest." };

/** A fake `gh` logged in as kb-bot: `api user` only (no poll is made here). */
function fakeGh(dir) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n  "api user"*) echo kb-bot; exit 0 ;;\n  *"/pulls"*) echo "[]"; exit 0 ;;\nesac\necho "unexpected gh $*" >&2; exit 2\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}
function fixture({ files = {}, workspace = {} } = {}) {
  const fx = v2Deployment({ name: "acme", souls: { reviewer: {} }, local: { host: { name: "kb-host" }, automations: { trust: "*" } }, workspace, files });
  fx.env.PATH = `${fakeGh(join(fx.base, "gh"))}:${fx.env.PATH}`;
  return fx;
}
const triggerRow = (fx, id) => ok(fx.cli(["trigger", "show", id, "--json"]), `trigger show ${id}`).trigger;
const scheduleRow = (fx, id) => ok(fx.cli(["schedule", "show", id, "--json"]), `schedule show ${id}`).schedule;
const stored = (fx) => JSON.parse(readFileSync(join(fx.dep, "oats-schedules.json"), "utf8")).jobs;

test("one rule, one place: validateDescription refuses what is not one line of 1 to 200 characters free of control characters, with the kind's code", () => {
  assert.equal(A.DESCRIPTION_MAX, 200);
  for (const d of OUT_OF_RULE) {
    for (const code of ["E_SCHEDULE_INVALID", "E_TRIGGER_INVALID"]) assert.throws(() => A.validateDescription(d, code), (e) => e.code === code && e.field === "description" && e.details.field === "description" && /^description: one line of 1 to 200 characters/.test(e.message), JSON.stringify(d));
  }
  assert.equal(A.validateDescription("x".repeat(200)), "x".repeat(200));
  assert.equal(A.validateDescription("🙂".repeat(200)), "🙂".repeat(200), "characters, not UTF-16 units");
  assert.equal(A.validateDescription("  Review — harvest PRs  "), "  Review — harvest PRs  ", "kept as given");
  // Local triggers take it now: refused out of the rule as E_TRIGGER_INVALID {field: description}.
  for (const d of OUT_OF_RULE) assert.throws(() => T.validateTrigger(localTrigger({ description: d })), (e) => e.code === "E_TRIGGER_INVALID" && e.field === "description" && e.details.field === "description", JSON.stringify(d));
  assert.equal(T.validateTrigger(localTrigger({ description: "Review harvest PRs" })).description, "Review harvest PRs");
  assert.equal("description" in T.validateTrigger(localTrigger()), false, "absent stays absent");
});

test("a workspace header out of the rule is a warning: the entry still loads and runs, with description null, and the problem names the rule", async (t) => {
  const fx = fixture({ files: {
    "oats-triggers/kb-review.yaml": { yaml: { ...wsTrigger, description: "Review\nharvest PRs" } },
    "ops/nightly.oats-schedule.yaml": { yaml: { ...wsSchedule, description: "x".repeat(201) } },
    "ops/labelled.oats-schedule.yaml": { yaml: { ...wsSchedule, description: "The nightly digest" } },
  } });
  t.after(() => fx.cleanup());
  const sync = ok(fx.cli(["sync", "--json"]), "sync");
  assert.deepEqual([sync.automations.triggers, sync.automations.schedules], [1, 2], "the out-of-rule entries are listed");
  const problems = sync.problems.map((p) => [p.code, p.path, p.message]).sort();
  const msg = "description: one line of 1 to 200 characters without control characters — shorten it or remove it; the automation keeps running without one";
  assert.deepEqual(problems, [["E_AUTOMATION_SCHEMA", "oats-triggers/kb-review.yaml#/description", msg], ["E_AUTOMATION_SCHEMA", "ops/nightly.oats-schedule.yaml#/description", msg]]);
  const tr = triggerRow(fx, "ws/kb-review");
  assert.deepEqual([tr.description, tr.runsHere, "invalid" in tr], [null, true, false]);
  const sr = scheduleRow(fx, "ws/nightly");
  assert.deepEqual([sr.description, sr.runsHere, "invalid" in sr], [null, true, false]);
  assert.equal(scheduleRow(fx, "ws/labelled").description, "The nightly digest");
  // It runs: the tick launches the workspace schedule at its minute.
  const ctx = await fx.inEnv(async () => { const path = process.env.PATH; process.env.PATH = fx.env.PATH; try { return S.scopeAutomations(fx.dep, {}); } finally { process.env.PATH = path; } });
  const ran = await fx.inEnv(async () => S.tickWorkspace(fx.dep, { now: new Date("2026-09-27T07:00:10Z"), io: { noLaunch: true }, reg: { maxConcurrent: 4, workspaces: [fx.dep] }, wsList: [fx.dep], ctx }));
  assert.deepEqual(ran.map((r) => [r.id, r.action]).sort(), [["ws~labelled", "launched"], ["ws~nightly", "launched"]], JSON.stringify(ran));
  // The header keeps its other rules: a non-string is now a warning too, never a refusal.
  const parsed = A.parseAutomationFile(S.scheduleKind({ dep: "/dep" }), { stem: "n", path: "oats-schedules/n.yaml", bytes: Buffer.from(YAML.stringify({ ...wsSchedule, description: 7 })), member: "ws", repoKey: "k", commit: "c" });
  assert.deepEqual([parsed.entry.description, parsed.warning.path, parsed.problem], [null, "oats-schedules/n.yaml#/description", undefined]);
});

test("local triggers: add --file carries it, --description sets or overrides it, the row shows it; trigger update changes only it", async (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const file = join(fx.base, "t.json");
  writeFileSync(file, JSON.stringify(localTrigger({ description: "From the file" })));
  assert.equal(ok(fx.cli(["trigger", "add", "--file", file, "--json"]), "add").trigger.description, "From the file");
  assert.equal(ok(fx.cli(["trigger", "list", "--json"]), "list").triggers.find((r) => r.id === "local/kb-review").description, "From the file", "no longer null for a local trigger");
  assert.equal(ok(fx.cli(["trigger", "add", "--file", file, "--id", "second", "--description=--the flag wins", "--json"]), "add --description").trigger.description, "--the flag wins", "an inline value may start with --");
  assert.equal(ok(fx.cli(["trigger", "add", "--file", file, "--id", "third", "--description=", "--json"]), "add --description=").trigger.description, null, "an empty value removes the file's");
  assert.equal("description" in stored(fx).third, false);
  let e = fails(fx.cli(["trigger", "add", "--file", file, "--id", "fourth", "--description=a\tb", "--json"]), "E_TRIGGER_INVALID", "out of rule");
  assert.deepEqual(e.details, { field: "description" });
  fails(fx.cli(["trigger", "add", "--file", file, "--id", "fourth", "--description", "--json"]), "E_BAD_ARGS", "no value");

  // Fired and pending state is untouched; updatedAt moves; createdAt stays.
  const statePath = join(fx.dep, ".agents", "schedules", "triggers.json");
  mkdirSync(join(fx.dep, ".agents", "schedules"), { recursive: true });
  const state = { triggers: { "local/kb-review": { lastPollAt: "2026-09-26T12:00:00.000Z", prs: { 1: { headSha: "a", draft: false, labels: [], updatedAt: "x" } }, fired: { "k1": { at: "2026-09-26T12:00:00.000Z", event: "opened", number: 1 } }, pending: [{ key: "k2", event: "opened", number: 2 }] } } };
  writeFileSync(statePath, JSON.stringify(state));
  const before = stored(fx)["kb-review"];
  const updated = ok(fx.cli(["trigger", "update", "local/kb-review", "--description=Reviews every harvest PR", "--json"]), "update").trigger;
  assert.equal(updated.description, "Reviews every harvest PR");
  const after = stored(fx)["kb-review"];
  assert.deepEqual({ ...after, description: undefined, updatedAt: undefined }, { ...before, description: undefined, updatedAt: undefined }, "nothing else of the definition changes");
  assert.equal(after.createdAt, before.createdAt);
  assert.ok(after.updatedAt >= before.updatedAt);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), state, "fired and pending state untouched");
  assert.equal(ok(fx.cli(["trigger", "update", "kb-review", "--description=", "--json"]), "clear").trigger.description, null, "a bare id; empty clears");
  assert.equal("description" in stored(fx)["kb-review"], false);
  e = fails(fx.cli(["trigger", "update", "kb-review", "--description=x".padEnd(220, "x"), "--json"]), "E_TRIGGER_INVALID", "too long");
  assert.deepEqual(e.details, { field: "description" });
  e = fails(fx.cli(["trigger", "update", "kb-review", "--description=x", "--file", file, "--json"]), "E_BAD_ARGS", "another flag");
  assert.match(e.message, /only --description is supported for now/);
  fails(fx.cli(["trigger", "update", "kb-review", "--json"]), "E_BAD_ARGS", "no --description");
  fails(fx.cli(["trigger", "update", "nope", "--description=x", "--json"]), "E_TRIGGER_UNKNOWN", "unknown");
});

test("a workspace trigger or schedule is described in Git: update --description refuses it; add --workspace writes it to the header, never the body", async (t) => {
  const fx = fixture({ files: { "oats-triggers/kb-review.yaml": { yaml: wsTrigger }, "ops/nightly.oats-schedule.yaml": { yaml: wsSchedule } } });
  t.after(() => fx.cleanup());
  ok(fx.cli(["sync", "--json"]), "sync");
  const e = fails(fx.cli(["trigger", "update", "ws/kb-review", "--description=x", "--json"]), "E_AUTOMATION_WORKSPACE", "workspace trigger");
  assert.match(e.message, /defined in Git/);
  fails(fx.cli(["schedule", "update", "ws/nightly", "--description=x", "--json"]), "E_AUTOMATION_WORKSPACE", "workspace schedule");

  const defFile = join(fx.base, "t.json");
  writeFileSync(defFile, JSON.stringify({ on, spawn, description: "In the file" }));
  const add = (extra) => ok(fx.cli(["trigger", "add", "--file", defFile, "--id", "second", "--workspace", "ws", "--runs-on", "kb-host", "--owner", "github.com/kb-bot", ...extra, "--json"]), `trigger add --workspace ${extra}`);
  assert.deepEqual(YAML.parse(add([]).file.content), { kind: "oats-trigger", ...header, id: "second", description: "In the file", on, spawn }, "the file's goes to the header");
  assert.equal(YAML.parse(add(["--description=The flag wins"]).file.content).description, "The flag wins");
  fails(fx.cli(["trigger", "add", "--file", defFile, "--id", "second", "--workspace", "ws", "--runs-on", "kb-host", "--owner", "github.com/kb-bot", "--description=a\nb", "--json"]), "E_TRIGGER_INVALID", "the header is refused here, before a file is written");
  const spec = JSON.stringify({ kind: "spawn", cron: "0 6 * * *", tz: "UTC", agent: "reviewer", task: "Digest.", description: "In the spec" });
  const sched = (extra) => YAML.parse(ok(fx.cli(["schedule", "add", "digest", "--spec-json", spec, "--workspace", "ws", "--runs-on", "kb-host", "--owner", "github.com/kb-bot", ...extra, "--json"]), "schedule add --workspace").file.content);
  const doc = sched([]);
  assert.deepEqual(Object.keys(doc).slice(0, 4), ["kind", "schemaVersion", "id", "description"], "a header key");
  assert.equal(doc.description, "In the spec");
  assert.equal(sched(["--description=From the flag"]).description, "From the flag");
  assert.equal("description" in sched(["--description="]), false);
  fails(fx.cli(["schedule", "add", "digest", "--spec-json", spec, "--workspace", "ws", "--runs-on", "kb-host", "--owner", "github.com/kb-bot", "--description=" + "x".repeat(201), "--json"]), "E_SCHEDULE_INVALID", "schedule header refused");
});

test("schedule update --description alone changes only the description, under the same locks, even while the job runs; with --file it overrides the spec", async (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const job = { kind: "command", cron: "0 8 * * *", tz: "UTC", cwd: fx.dep, argv: ["oats", "status"] };
  ok(fx.cli(["schedule", "add", "mine", "--spec-json", JSON.stringify(job), "--description=Status every morning", "--json"]), "add --description");
  assert.equal(scheduleRow(fx, "mine").description, "Status every morning");
  const before = stored(fx).mine;
  // A job holding its slot: its identity cannot change, but its description can.
  S.acquireJobLock(fx.dep, "mine", { pid: process.pid });
  const r = ok(fx.cli(["schedule", "update", "local/mine", "--description=Morning status", "--json"]), "update while running").schedule;
  assert.deepEqual([r.description, r.running], ["Morning status", true]);
  const after = stored(fx).mine;
  assert.deepEqual({ ...after, description: undefined, updatedAt: undefined }, { ...before, description: undefined, updatedAt: undefined }, "nothing else changes");
  assert.equal(after.createdAt, before.createdAt);
  S.releaseJobLock(fx.dep, "mine");
  assert.equal(ok(fx.cli(["schedule", "update", "mine", "--description=", "--json"]), "clear").schedule.description, null);
  assert.equal("description" in stored(fx).mine, false);
  const e = fails(fx.cli(["schedule", "update", "mine", "--description=a b", "--json"]), "E_SCHEDULE_INVALID", "out of rule");
  assert.equal(e.details.field, "description");
  fails(fx.cli(["schedule", "update", "nope", "--description=x", "--json"]), "E_SCHEDULE_UNKNOWN", "unknown");
  // With --file / --spec-json, the flag sets or overrides the spec's (a full update otherwise drops it).
  const full = (extra, spec = job) => ok(fx.cli(["schedule", "update", "mine", "--spec-json", JSON.stringify(spec), ...extra, "--json"]), "full update").schedule.description;
  assert.equal(full(["--description=Set by flag"]), "Set by flag");
  assert.equal(full(["--description=Flag wins"], { ...job, description: "Spec" }), "Flag wins");
  assert.equal(full(["--description="], { ...job, description: "Spec" }), null);
  assert.equal(full([], { ...job, description: "Spec" }), "Spec");
  assert.equal(full([]), null, "a full update without one still drops it");
});

test("a package trigger template may carry definition.description: add --from copies it, --description overrides it; a workspace trigger shows the header's, else the template's", async (t) => {
  const template = {
    parameters: { repo: { path: "on.repo", required: true } },
    definition: { id: "harvest-review", enabled: true, kind: "trigger", description: "Review each harvest PR (template)",
      on: { source: "github.pull_request", repo: null, events: ["opened"], labels: ["okf-harvest"], poll: "2m" },
      spawn: { soul: "acme.pkg/keeper", purpose: "review-pr-{number}", task: "Review knowledge-base PR {repo}#{number}." } },
  };
  const pkg = packageRepo({ manifest: { triggers: [{ id: "harvest-review", file: "triggers/harvest-review.json" }, { id: "bad", file: "triggers/bad.json" }] },
    files: { "triggers/harvest-review.json": template, "triggers/bad.json": { ...template, definition: { ...template.definition, description: "two\nlines" } } } });
  const fromFile = (extra = {}) => ({ yaml: { kind: "oats-trigger", ...header, from: "acme.pkg:harvest-review", set: { repo: "github.com/kb-bot/knowledge" }, ...extra } });
  const fx = fixture({ workspace: { packages: { "acme.pkg": `${pkg.ref}@v1.0.0` } }, files: {
    "oats-triggers/from-template.yaml": fromFile(),
    "oats-triggers/from-header.yaml": fromFile({ description: "The header wins" }),
    "oats-triggers/from-bad-header.yaml": fromFile({ description: "a\tb" }),
  } });
  t.after(() => { try { fx.cleanup(); } finally { pkg.cleanup(); } });
  ok(fx.cli(["sync", "--json"]), "sync");
  const add = (extra) => ok(fx.cli(["trigger", "add", "--from", "acme.pkg:harvest-review", "--set", "repo=github.com/acme/knowledge", ...extra, "--json"]), `add --from ${extra}`).trigger;
  assert.equal(add([]).description, "Review each harvest PR (template)", "copied");
  assert.equal(add(["--id", "two", "--description=Mine"]).description, "Mine", "overridden");
  assert.equal(add(["--id", "three", "--description="]).description, null, "removed");
  const e = fails(fx.cli(["trigger", "add", "--from", "acme.pkg:bad", "--set", "repo=github.com/acme/knowledge", "--json"]), "E_TRIGGER_INVALID", "a template's goes through validateTrigger");
  assert.equal(e.details.field, "description");
  const rows = Object.fromEntries(ok(fx.cli(["trigger", "list", "--json"]), "list").triggers.map((r) => [r.id, r]));
  assert.equal(rows["ws/from-template"].description, "Review each harvest PR (template)", "the template's");
  assert.equal(rows["ws/from-header"].description, "The header wins");
  assert.equal(rows["ws/from-bad-header"].description, "Review each harvest PR (template)", "an out-of-rule header is null, so the template's shows");
  assert.equal(rows["ws/from-template"].runsHere, true);
});

test("the feature: oats version --json advertises automation-descriptions; a remote schedule --description needs it there", async (t) => {
  const fx = fixture();
  try {
    const v = JSON.parse(fx.cli(["version", "--json"]).stdout);
    assert.ok(v.features.includes("automation-descriptions"), JSON.stringify(v.features));
    // Each command's own --help names the flag and the description-only update.
    for (const kind of ["trigger", "schedule"]) {
      const help = fx.cli([kind, "--help"]).stdout;
      assert.match(help, new RegExp(`\\n  oats ${kind} (?:add|add\\|update)[^\\n]* --description=<text> `), `${kind} --help: add`);
      assert.match(help, new RegExp(`\\n  oats ${kind} update <id> --description=<text> `), `${kind} --help: update`);
    }
  } finally { fx.cleanup(); }
  // short, and its OATS_HOME_DIR is <base>/h: that holds ssh's control socket (ssh/<40 hex>), which ssh needs
  // within 86 bytes, under the root run's directory of the file (docs/implementation.md, fixtures)
  const base = realpathSync(mkdtempSync(join(tmpdir(), "o-dr-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const saved = process.env.OATS_HOME_DIR;
  process.env.OATS_HOME_DIR = join(base, "h");
  try {
    const { scheduleRemote } = await import("../lib/servers.mjs");
    mkdirSync(process.env.OATS_HOME_DIR, { recursive: true });
    writeFileSync(join(process.env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { s: { sshHost: "h", workspace: "/w" } } }));
    const sent = [];
    const remote = (features) => ({ execFileSync: (b, argv) => { const a = argv.join(" "); sent.push(argv.at(-1));
      return a.includes("version --json") ? JSON.stringify({ schemaVersion: 1, ok: true, result: { desktopApi: 1, version: "0.69.15", remote: ["schedule"], features, scheduleApi: 2 } })
        : JSON.stringify({ schemaVersion: 1, ok: true, result: {} }); } });
    assert.throws(() => scheduleRemote("s", ["update", "mine", "--description=x"], remote(["schedule", "harness"])), (e) => e.code === "E_REMOTE_INCOMPATIBLE" && /automation-descriptions/.test(e.message));
    assert.equal(sent.some((c) => c.includes("schedule update")), false, "nothing forwarded");
    scheduleRemote("s", ["update", "mine", "--description=x"], remote(["schedule", "harness", "automation-descriptions"]));
    assert.match(sent.at(-1), /schedule update mine '?--description=x'?/);
  } finally { if (saved === undefined) delete process.env.OATS_HOME_DIR; else process.env.OATS_HOME_DIR = saved; }
});
