// runtime → harness (0.27.0, human vocabulary; lead decisions on the harness rename).
// Outputs speak the new names only (JSON fields, `version.harnesses`, error codes).
// Every input written before 0.27.0 keeps working — read either, write new (lead
// call 6): `--runtime` on every command that took it, a launch configuration's
// `runtime:`, a stored schedule's `runtime`, a 0.26.0 home's instance.json and its
// version-1 recipe. Each command that read an old name answers ONE
// deprecated-runtime-name warning (the envelope's `warnings[]`, or stderr in text
// mode). What released providers read or write keeps its old name beside the new
// one, without a warning (the operator cannot fix a provider's file): the hook env
// OATS_RUNTIME/OATS_PREVIOUS_RUNTIME, soul.yaml `runtime:`, requires[].runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { setProcessEnvironment, v2Deployment } from "./helpers/v2-deployment.mjs";
import { soulHarnessField, requirementHarness, applicableRequirements, assertLaunchRecipe, upgradeHomeMeta, upgradeLaunchRecipe, LAUNCH_RECIPE_VERSION } from "../lib/core.mjs";
import { runtimeNameWarning, resetRuntimeNames } from "../lib/deprecation.mjs";
import { checkRemote } from "../lib/servers.mjs";
import { createHash } from "node:crypto";
import { canonicalJson } from "../lib/canonical-json.mjs";

const fail = (r) => { const j = r.json(); assert.equal(j.ok, false, r.stdout); return j.error; };
const ok = (r) => { const j = r.json(); assert.equal(j.ok, true, r.stdout + r.stderr); return j.result; };
/** The command's one deprecated-runtime-name warning, naming each old name it read. */
const warned = (r, ...sources) => {
  const w = r.json().warnings;
  assert.equal(w?.length, 1, `one warning: ${r.stdout}`);
  assert.equal(w[0].code, "deprecated-runtime-name");
  assert.equal(w[0].key, "runtime"); assert.equal(w[0].replacement, "harness");
  assert.match(w[0].message, /^`runtime` was renamed to `harness` in 0\.27\.0; the old name is still read here \(.+\) and a later release drops it$/);
  for (const s of sources) assert.ok(w[0].sources.some((x) => s instanceof RegExp ? s.test(x) : x.includes(s)), `${s} in ${JSON.stringify(w[0].sources)}`);
  // Only this warning is the test's subject: another (the older-git partial-cache notice, #389) may print.
  assert.equal(r.stderr.includes("oats: warning: `runtime` was renamed"), false, "delivered in the envelope, not again on stderr");
  return w[0];
};
const quiet = (r) => assert.equal(Object.hasOwn(r.json(), "warnings"), false, r.stdout);

test("version --json advertises harnesses and the harness feature, and no runtimes", (t) => {
  const fx = v2Deployment(); t.after(fx.cleanup);
  const v = JSON.parse(fx.cli(["version", "--json"]).stdout);
  assert.deepEqual(v.harnesses, ["pi", "claude", "codex"]);
  assert.equal(Object.hasOwn(v, "runtimes"), false, "no alias: the Desktop gates on the feature");
  assert.ok(v.features.includes("harness"));
});

test("--runtime is --harness on spawn, session start|restart and launch-config preview, with the warning; both, disagreeing, are refused", (t) => {
  const fx = v2Deployment(); t.after(fx.cleanup);
  const spawnNew = fx.cli(["spawn", "dev", "--preview", "--harness", "codex", "--json"]);
  assert.equal(ok(spawnNew).harness, "codex"); quiet(spawnNew);
  const spawnOld = fx.cli(["spawn", "dev", "--preview", "--runtime", "claude", "--json"]);
  assert.equal(ok(spawnOld).harness, "claude", "--runtime is read as --harness");
  warned(spawnOld, "the --runtime flag (use --harness)");
  assert.equal(ok(fx.cli(["spawn", "dev", "--preview", "--harness", "claude", "--runtime", "claude", "--json"])).harness, "claude", "both, agreeing");
  const both = fx.cli(["spawn", "dev", "--preview", "--harness", "pi", "--runtime", "claude", "--json"]);
  assert.equal(fail(both).code, "E_BAD_ARGS");
  assert.equal(fail(both).message, "--harness pi and --runtime claude disagree; --runtime is the pre-0.27 name of --harness — give one");

  const home = ok(fx.cli(["spawn", "dev", "--harness", "pi", "--no-launch", "--json"])).home;
  const preview = fx.cli(["launch-config", "preview", "--home", home, "--runtime", "codex", "--json"]);
  assert.equal(ok(preview).harness, "codex"); warned(preview, "--runtime");
  assert.equal(fail(fx.cli(["launch-config", "preview", "--home", home, "--runtime", "codex", "--harness", "pi", "--json"])).code, "E_BAD_ARGS");
  for (const verb of ["start", "restart"]) {
    // The flag is accepted (the missing home is what refuses), and the failure carries the warning too.
    const r = fx.cli(["session", verb, "--home", "/nonexistent/home", "--runtime", "pi", "--json"]);
    assert.notEqual(fail(r).code, "E_BAD_ARGS", `${verb}: ${r.stdout}`);
    warned(r, "--runtime");
    assert.equal(fail(fx.cli(["session", verb, "--home", "/nonexistent/home", "--runtime", "pi", "--harness", "claude", "--json"])).code, "E_BAD_ARGS");
    assert.equal(fail(fx.cli(["session", verb, "--home", "/nonexistent/home", "--runtime", "gemini", "--json"])).message, "--harness must be one of pi, claude, codex");
  }
  // Text mode: the warning is one stderr line.
  const text = fx.cli(["spawn", "dev", "--preview", "--runtime", "pi"]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stderr.split("\n").filter((l) => l.startsWith("oats: warning: `runtime` was renamed to `harness` in 0.27.0")).length, 1, text.stderr);
});

test("a launch configuration's `runtime:` is its harness, with the warning; both, disagreeing, E_WORKSPACE_SCHEMA; `set` writes `harness`", (t) => {
  const fx = v2Deployment({ local: { "launch-configs": { fast: { harness: "claude", model: "sonnet" } } } }); t.after(fx.cleanup);
  const current = fx.cli(["launch-config", "list", "--json"]);
  assert.equal(ok(current).configurations.find((c) => c.name === "fast").harness, "claude"); quiet(current);
  const local = join(fx.dep, "oats-local.yaml");
  const doc = YAML.parse(readFileSync(local, "utf8"));
  writeFileSync(local, YAML.stringify({ ...doc, "launch-configs": { fast: { runtime: "codex", model: "o4" } } }));
  const old = fx.cli(["launch-config", "list", "--json"]);
  const row = ok(old).configurations.find((c) => c.name === "fast");
  assert.equal(row.harness, "codex"); assert.equal(Object.hasOwn(row, "runtime"), false, "outputs speak the new name");
  warned(old, "launch-configs.fast.runtime");
  const spawned = fx.cli(["spawn", "dev", "--preview", "--launch-config", "fast", "--json"]);
  assert.equal(ok(spawned).harness, "codex", "a spawn on it launches its harness"); warned(spawned, "launch-configs.fast.runtime");

  writeFileSync(local, YAML.stringify({ ...doc, "launch-configs": { fast: { harness: "pi", runtime: "claude" } } }));
  const e = fail(fx.cli(["launch-config", "list", "--json"]));
  assert.equal(e.code, "E_WORKSPACE_SCHEMA");
  assert.match(e.message, /\/launch-configs\/fast\/runtime: harness "pi" and runtime "claude" disagree: `runtime` is the pre-0\.27 name of `harness`/);
  writeFileSync(local, YAML.stringify(doc));

  const file = join(fx.base, "old.json");
  writeFileSync(file, JSON.stringify({ runtime: "pi", model: "m" }));
  const set = fx.cli(["launch-config", "set", "old", "--file", file, "--json"]);
  ok(set); warned(set, "runtime in the --file definition (written as harness)");
  assert.deepEqual(YAML.parse(readFileSync(local, "utf8"))["launch-configs"].old, { harness: "pi", model: "m" }, "written in the new name");
  writeFileSync(file, JSON.stringify({ runtime: "pi", harness: "codex" }));
  assert.equal(fail(fx.cli(["launch-config", "set", "both", "--file", file, "--json"])).code, "E_LAUNCH_CONFIG_INVALID");
});

test("a 0.26.0 home's instance.json (`runtime`, a version-1 recipe) is read in the new names; a current one is untouched", () => {
  resetRuntimeNames();
  const recipe = { version: 1, runtime: "pi", executable: "/bin/pi", args: [] };
  assert.deepEqual(upgradeLaunchRecipe(recipe), { version: LAUNCH_RECIPE_VERSION, harness: "pi", executable: "/bin/pi", args: [] });
  assert.equal(runtimeNameWarning(), null, "the recipe alone is noted by its home");
  const old = { instance: "dev-x", runtime: "pi", model: "m", launch: recipe };
  const read = upgradeHomeMeta(old, "/h/dev-x");
  assert.deepEqual(read, { instance: "dev-x", harness: "pi", model: "m", launch: { version: 2, harness: "pi", executable: "/bin/pi", args: [] } });
  assert.deepEqual(runtimeNameWarning().sources, ["instance.json of /h/dev-x (a 0.26.0 home: its next start or restart records harness)"]);
  resetRuntimeNames();
  const now = { instance: "dev-y", harness: "codex", launch: { version: 2, harness: "codex" } };
  assert.equal(upgradeHomeMeta(now, "/h/dev-y"), now, "the same object: nothing to read differently");
  assert.equal(runtimeNameWarning(), null);
  // A version-1 recipe is version 2 to the planner; an unknown version is still refused.
  assert.equal(LAUNCH_RECIPE_VERSION, 2);
  assert.equal(assertLaunchRecipe({ ...recipe, launchConfig: null, launchConfigSource: null, executableDeclared: null, executableResolvedFrom: "PATH", env: {}, hooks: { env: {}, contributions: [] } }, "dev-x").harness, "pi");
  assert.throws(() => assertLaunchRecipe({ version: 3, harness: "pi" }, "dev-z"), (e) => e.code === "E_LAUNCH_RECIPE_UNSUPPORTED");
  resetRuntimeNames();
});

test("soul.yaml: `harness:` or `runtime:` (released souls) are read the same; both, disagreeing, E_BAD_MANIFEST", () => {
  assert.deepEqual(soulHarnessField({ name: "a", runtime: "claude" }, "f"), { name: "a", harness: "claude" });
  assert.deepEqual(soulHarnessField({ name: "a", harness: "codex" }, "f"), { name: "a", harness: "codex" });
  assert.deepEqual(soulHarnessField({ name: "a", harness: "pi", runtime: "pi" }, "f"), { name: "a", harness: "pi" });
  assert.throws(() => soulHarnessField({ harness: "pi", runtime: "claude" }, "/x/soul.yaml"), (e) => e.code === "E_BAD_MANIFEST"
    && e.message === "/x/soul.yaml declares harness: pi and runtime: claude; `runtime` is the pre-0.27 name of `harness` — keep one");
});

test("a 1.13.1-shaped capability (requires[].runtime) still syncs without a warning", (t) => {
  const fx = v2Deployment({
    name: "acme",
    capabilities: { "acme.chat": { manifest: {
      requires: [{ runtime: "claude", package: "chat@market", why: "channel", when: { delivery: "channel" } }],
    } } },
  });
  t.after(fx.cleanup);
  const synced = fx.cli(["sync", "--json"]);
  ok(synced); quiet(synced);
});

test("requires[]: `harness` or `runtime` names the harness package's harness", () => {
  assert.equal(requirementHarness({ harness: "pi" }), "pi");
  assert.equal(requirementHarness({ runtime: "claude" }), "claude");
  const cap = (row) => ({ id: "acme.x", settings: {}, manifest: { requires: [row] } });
  assert.deepEqual(applicableRequirements("claude", [cap({ runtime: "claude", package: "p@m" })]), [{ capability: "acme.x", package: "p@m" }]);
  assert.deepEqual(applicableRequirements("claude", [cap({ harness: "claude", package: "p@m" })]), [{ capability: "acme.x", package: "p@m" }]);
  assert.deepEqual(applicableRequirements("pi", [cap({ runtime: "claude", package: "p@m" })]), []);
});

test("a requires[] row naming both `harness` and `runtime` fails the spawn before anything is probed", (t) => {
  const fx = v2Deployment({
    souls: { dev: { soul: { capabilities: { "acme.both": { from: "here" } } } } },
    capabilities: { "acme.both": { manifest: { requires: [{ harness: "pi", runtime: "pi", package: "npm:@acme/pi", why: "x" }] } } },
  });
  t.after(fx.cleanup);
  const e = fail(fx.cli(["spawn", "dev", "--harness", "pi", "--no-launch", "--json"]));
  assert.equal(e.code, "E_HARNESS_RESOURCE_MISSING", JSON.stringify(e)); // the gate's own code (E_SPAWN_FAILED before #1047)
  assert.match(e.message, /acme\.both: a requirement declares both `harness` and `runtime` \(its pre-0\.27 name\); keep one/);
});

test("hooks see OATS_HARNESS and OATS_RUNTIME at spawn, and both PREVIOUS names when a start switches the harness", (t) => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), "oats-harness-env-")));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const hook = `import { writeFileSync } from "node:fs";
const e = process.env;
writeFileSync(${JSON.stringify(out)} + "/" + e.OATS_EVENT + ".json", JSON.stringify({ h: e.OATS_HARNESS, r: e.OATS_RUNTIME, ph: e.OATS_PREVIOUS_HARNESS ?? null, pr: e.OATS_PREVIOUS_RUNTIME ?? null }));
console.log("{}");
`;
  const fx = v2Deployment({
    souls: { dev: { soul: { capabilities: { "acme.env": { from: "here" } } } } },
    capabilities: { "acme.env": { manifest: { launchPreview: true, hooks: { spawn: "hook.mjs", launch: "hook.mjs" } }, files: { "hook.mjs": hook } } },
  });
  t.after(fx.cleanup);
  const spawned = ok(fx.cli(["spawn", "dev", "--harness", "pi", "--no-launch", "--json"]));
  assert.deepEqual(JSON.parse(readFileSync(join(out, "spawn.json"), "utf8")), { h: "pi", r: "pi", ph: null, pr: null });
  // A harness switch prepares the new harness's launch through the launch hook (preview runs nothing else).
  ok(fx.cli(["launch-config", "preview", "--home", spawned.home, "--harness", "claude", "--json"]));
  assert.deepEqual(JSON.parse(readFileSync(join(out, "launch.json"), "utf8")), { h: "claude", r: "claude", ph: "pi", pr: "pi" });
});

test("a 0.26.0 home's `runtime` is its harness to launch-config preview, with the warning naming the home", (t) => {
  const fx = v2Deployment(); t.after(fx.cleanup);
  const home = ok(fx.cli(["spawn", "dev", "--harness", "pi", "--no-launch", "--json"])).home;
  const metaPath = join(home, "instance.json");
  const { harness, launch, ...rest } = JSON.parse(readFileSync(metaPath, "utf8"));
  const { harness: recipeHarness, ...recipe } = launch;
  writeFileSync(metaPath, JSON.stringify({ ...rest, runtime: harness, launch: { ...recipe, version: 1, runtime: recipeHarness } }, null, 2));
  const r = fx.cli(["launch-config", "preview", "--home", home, "--json"]);
  assert.equal(ok(r).harness, "pi");
  warned(r, `instance.json of ${home}`);
  const both = fx.cli(["launch-config", "preview", "--home", home, "--runtime", "claude", "--json"]);
  assert.equal(ok(both).harness, "claude");
  assert.equal(warned(both, "--runtime", `instance.json of ${home}`).sources.length, 2, "one warning, both sources");
});

test("schedules: a definition's `runtime` is its harness at add and when stored, with the warning, and is saved as `harness`; both, disagreeing, are invalid", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-harness-sched-")));
  const saved = { ...process.env };
  process.env.OATS_HOME_DIR = join(base, "oats-home");
  try {
    const S = await import("../lib/schedule.mjs");
    const ws = join(base, "ws");
    mkdirSync(join(ws, "agents", "dev", "soul"), { recursive: true });
    writeFileSync(join(ws, "agents", "dev", "soul", "soul.yaml"), "name: dev\nwork: worktree\nharness: claude\n");
    writeFileSync(join(ws, "agents", "dev", "soul", "AGENTS.md"), "# Developer\n");
    writeFileSync(join(ws, "oats-local.yaml"), "schemaVersion: 2\nworkspace: example.invalid/acme/workspace\n");
    const job = { cron: "0 * * * *", tz: "UTC", kind: "spawn", agent: "dev", task: "t" };
    resetRuntimeNames();
    S.addSchedule(ws, { ...job, id: "added", runtime: "pi" });
    assert.deepEqual(runtimeNameWarning().sources, ["schedule added: runtime (written as harness)"]);
    const stored = () => JSON.parse(readFileSync(S.definitionsPath(ws), "utf8")).jobs;
    assert.equal(stored().added.harness, "pi"); assert.equal(Object.hasOwn(stored().added, "runtime"), false, "saved in the new name");
    assert.throws(() => S.addSchedule(ws, { ...job, id: "both", harness: "pi", runtime: "codex" }), (e) => e.code === "E_SCHEDULE_INVALID" && e.field === "runtime");
    // A job stored by 0.26.0 in the old name, and one naming both, differently.
    const defs = JSON.parse(readFileSync(S.definitionsPath(ws), "utf8"));
    defs.jobs.old = { ...job, id: "old", enabled: true, runtime: "codex" };
    defs.jobs.both = { ...job, id: "both", enabled: true, harness: "pi", runtime: "codex" };
    S.writeDefinitions(ws, defs);
    resetRuntimeNames();
    const listed = S.listSchedules(ws, { inspect: () => ({ present: false, state: "shell" }) });
    const rows = listed.jobs || listed.schedules || listed;
    const row = (id) => (Array.isArray(rows) ? rows.find((j) => j.id === id) : rows[id]);
    assert.equal(row("old").harness ?? row("old").definition?.harness, "codex", JSON.stringify(row("old")));
    assert.ok(runtimeNameWarning().sources.some((s) => s.startsWith("schedule old in ")), JSON.stringify(runtimeNameWarning()));
    const calls = [];
    const io = { spawn: (root, agent, opts) => { calls.push(opts); const h = join(ws, "agents", "dev", "instances", `dev-${opts.purpose}`); mkdirSync(h, { recursive: true }); writeFileSync(join(h, "instance.json"), JSON.stringify({ instance: `dev-${opts.purpose}`, home: h, agent: "dev" })); return { instance: `dev-${opts.purpose}`, home: h, launched: true }; },
      inspect: () => ({ present: true, state: "unknown" }) };
    const acts = S.tickWorkspace(ws, { now: new Date("2026-09-25T10:00:00Z"), io, reg: { ...S.readRegistry(), maxConcurrent: 5 } });
    assert.equal(acts.find((a) => a.id === "both")?.action, "invalid", JSON.stringify(acts));
    assert.match(acts.find((a) => a.id === "both").error, /harness and runtime \(its pre-0\.27 name\) disagree/);
    assert.equal(calls.find((o) => o.purpose.startsWith("old-"))?.harness, "codex", `the stored \`runtime\` launches its harness: ${JSON.stringify(acts)} ${JSON.stringify(calls)}`);
    assert.equal(calls.find((o) => o.purpose.startsWith("added-"))?.harness, "pi");
    // A run recorded by 0.26.0 said `startedRuntime`: its history still reads as a launch.
    const st = S.readState(ws);
    st.jobs.old = { ...(st.jobs.old || {}), recentRuns: [{ runId: "r-026", scheduledFor: "2026-09-24T10:00:00.000Z", startedAt: "2026-09-24T10:00:01.000Z", outcome: "ended", startedRuntime: true }] };
    S.writeState(ws, st);
    const history = S.listSchedules(ws, { inspect: () => ({ present: false, state: "shell" }) }).schedules.find((j) => j.id === "old").recentRuns;
    assert.equal(history.find((r) => r.runId === "r-026")?.session?.delivery, "launched", JSON.stringify(history));
    S.updateSchedule(ws, "old", { ...job, id: "old", harness: "codex" });
    assert.equal(Object.hasOwn(stored().old, "runtime"), false, "the next save stores the new name");
    assert.equal(stored().old.harness, "codex");
  } finally {
    resetRuntimeNames();
    setProcessEnvironment(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("remote schedules and probes: a spec is sent in the host's names; a host's legacy `runtimes` is its harness list", async () => {
  // short, and its OATS_HOME_DIR is <base>/h: that holds ssh's control socket (ssh/<40 hex>), which ssh needs
  // within 86 bytes, under the root run's directory of the file (docs/implementation.md, fixtures)
  const base = realpathSync(mkdtempSync(join(tmpdir(), "o-hr-")));
  const saved = { ...process.env };
  process.env.OATS_HOME_DIR = join(base, "h");
  try {
    const { scheduleRemote } = await import("../lib/servers.mjs");
    mkdirSync(process.env.OATS_HOME_DIR, { recursive: true });
    writeFileSync(join(process.env.OATS_HOME_DIR, "servers.json"), JSON.stringify({ servers: { s: { sshHost: "h", workspace: "/w" } } }));
    const sent = [];
    const remote = (features, extra = {}) => ({ execFileSync: (b, argv) => { const a = argv.join(" "); sent.push(argv.at(-1));
      return a.includes("version --json") ? JSON.stringify({ schemaVersion: 1, ok: true, result: { desktopApi: 1, version: "0.69.15", remote: ["session"], features, scheduleApi: 2, ...extra } })
        : JSON.stringify({ schemaVersion: 1, ok: true, result: {} }); } });
    resetRuntimeNames();
    const add = (spec) => ["add", "x", "--spec-json", JSON.stringify(spec)];
    const specOf = () => { const cmd = sent.at(-1); const m = cmd.match(/--spec-json ('(?:[^']|'\\'')*'|\S+)/); return JSON.parse(m[1].startsWith("'") ? m[1].slice(1, -1).replace(/'\\''/g, "'") : m[1]); };
    scheduleRemote("s", add({ kind: "spawn", harness: "pi" }), remote(["schedule"]));
    assert.deepEqual(specOf(), { kind: "spawn", runtime: "pi" }, "a host without the harness feature reads `runtime`");
    scheduleRemote("s", add({ kind: "spawn", runtime: "pi" }), remote(["schedule", "harness"]));
    assert.deepEqual(specOf(), { kind: "spawn", harness: "pi" }, "a host with the harness feature reads `harness`");
    assert.ok(runtimeNameWarning()?.sources.includes("runtime in the schedule spec (sent as the host's harness key)"), "the old key read here is noted");
    resetRuntimeNames();
    const before = sent.length;
    assert.throws(() => scheduleRemote("s", add({ kind: "spawn", harness: "pi", runtime: "codex" }), remote(["schedule", "harness"])), (e) => e.code === "E_SCHEDULE_INVALID" && /no request was forwarded/.test(e.message));
    assert.equal(sent.slice(before).some((c) => c.includes("schedule add")), false);

    const probe = (result) => checkRemote({ sshHost: "h", workspace: "/w" }, { execFileSync: () => JSON.stringify({ schemaVersion: 1, ok: true, result: { desktopApi: 1, version: "0.69.15", ...result } }) });
    const old = probe({ runtimes: ["pi", "claude", "codex"] });
    assert.deepEqual(old.harnesses, ["pi", "claude", "codex"]); assert.equal(old.advertised, true);
    assert.deepEqual(probe({ harnesses: ["pi", "codex"], runtimes: ["pi"] }).harnesses, ["pi", "codex"], "the new name wins");
    const silent = probe({});
    assert.deepEqual(silent.harnesses, ["pi", "claude"]); assert.equal(silent.advertised, false);
  } finally {
    setProcessEnvironment(saved);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a spawn decision minted in 0.26's names (`effective.runtime`) is stale at apply, answered with the fresh decision", (t) => {
  const fx = v2Deployment(); t.after(fx.cleanup);
  const { decision } = ok(fx.cli(["spawn", "dev", "--preview", "--purpose", "d", "--harness", "claude", "--json"]));
  assert.equal(decision.effective.harness, "claude");
  const { revision, ...body } = decision;
  assert.equal(createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 24), revision, "the revision digests the decision, key names included");
  const { harness, ...effective } = body.effective;
  const old = createHash("sha256").update(canonicalJson({ ...body, effective: { ...effective, runtime: harness } })).digest("hex").slice(0, 24);
  const e = fail(fx.cli(["spawn", "dev", "--purpose", "d", "--harness", "claude", "--expect-decision", old, "--no-launch", "--json"]));
  assert.equal(e.code, "E_DECISION_STALE");
  assert.equal(e.details?.decision?.revision, revision, JSON.stringify(e));
});
