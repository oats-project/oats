// A renamed official package through the real CLI (lib/package-moves.mjs, docs/workspaces.md "Renamed
// packages"): oats.engineering and oats.engineering-coordination are one package. The migration a
// deployment runs is one pin swap in oats-workspace.yaml and `oats sync`; nothing recorded (instance.json,
// the lock, oats-local.yaml, the workspace, schedules, triggers) is rewritten.
//
// Real git, no network: one bare package repository tagged v1.18.0 (manifest `package: oats.engineering`,
// soul code-reviewer) and v2.0.0 (`package: oats.engineering-coordination`, souls code-reviewer and
// dispatcher), a scratch catalog (OATS_PACKAGE_CATALOG) naming both ids, and the v2Deployment host pinning
// `oats.engineering: v1.18.0`. Spawns are --preview or --no-launch only.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { v2Deployment, git } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";

const S = await import("../lib/schedule.mjs");
const T = await import("../lib/triggers.mjs");

const OLD = "oats.engineering", NEW = "oats.engineering-coordination";
const note = (soul) => `package ${OLD} was renamed to ${NEW}: ${OLD}/${soul} is ${NEW}/${soul}`;
const RESPAWN = `package ${OLD} was renamed to ${NEW}: respawn the instance to move onto it`;

const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const fails = (r, code, what) => { const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.equal(j.error.code, code, `${what}: ${r.stdout}`); return j.error; };
/** A command whose answer is a bare JSON document (status, doctor). */
const doc = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); return JSON.parse(r.stdout); };
const lines = (r) => `${r.stdout}${r.stderr}`.split("\n");
const read = (path) => readFileSync(path, "utf8");

/** The package repository: v1.18.0 under the old id, v2.0.0 under the new one. The helper writes
 *  `manifest` over its own keys at each release, so changing `package` between them renames it. */
function renamedPackage() {
  const manifest = {};
  const pkg = packageRepo({ id: OLD, version: "1.18.0", souls: { "code-reviewer": {} }, manifest });
  manifest.package = NEW;
  pkg.commit2 = pkg.release("2.0.0", { "code-reviewer": {}, dispatcher: {} });
  // Served like GitHub (as v2Deployment's own repository): partial fetches, no whole-tree warning.
  git(pkg.bare, "config", "uploadpack.allowFilter", "true");
  git(pkg.bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  return pkg;
}

/** The deployment, pinned to `oats.engineering: v1.18.0`, the catalog naming both ids at their tags.
 *  fx.workspace(change) commits a change to oats-workspace.yaml; fx.swap() is the migration's pin swap. */
function fixture(t, { workspace = {}, local = {} } = {}) {
  const pkg = renamedPackage(); t.after(pkg.cleanup);
  const fx = v2Deployment({ t, workspace: { packages: { [OLD]: "v1.18.0" }, ...workspace }, local });
  const url = pkg.ref.replace(/^git:/, "");
  const catalog = join(fx.base, "catalog.json");
  writeFileSync(catalog, JSON.stringify({ packages: { [OLD]: { url, ref: "v1.18.0", path: "oats-package" }, [NEW]: { url, ref: "v2.0.0", path: "oats-package" } } }));
  fx.env.OATS_PACKAGE_CATALOG = catalog;
  fx.pkg = pkg;
  fx.workspace = (change) => {
    const ws = YAML.parse(read(join(fx.member, "oats-workspace.yaml")));
    change(ws);
    fx.commit({ "oats-workspace.yaml": { yaml: ws } }, "workspace change");
  };
  fx.swap = () => fx.workspace((ws) => { ws.packages = { [NEW]: "v2.0.0" }; });
  fx.sync = (what = "sync") => ok(fx.cli(["sync", "--json"]), what);
  fx.lock = () => read(join(fx.dep, "oats-lock.json"));
  return fx;
}

test("before the swap: oats.engineering/code-reviewer is the old package's soul, with no note", (t) => {
  const fx = fixture(t);
  fx.sync();
  const pv = ok(fx.cli(["spawn", `${OLD}/code-reviewer`, "--preview", "--json"]), "preview");
  assert.equal(pv.agent, "oats-engineering--code-reviewer");
  assert.equal(pv.modules[0].from.package, OLD);
  assert.equal(Object.hasOwn(pv, "notes"), false, "a selector that names the locked id exactly has no note");
  const text = fx.cli(["spawn", `${OLD}/code-reviewer`, "--preview"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.equal(lines(text).some((l) => l.startsWith("note:")), false, `${text.stdout}${text.stderr}`);
});

test("after the swap: a selector with the old id reaches the renamed soul in spawn, soul teams and soul launch, with one note", (t) => {
  const fx = fixture(t);
  fx.sync();
  fx.swap(); fx.sync("sync after the swap");

  // spawn --preview: the new package's soul, and the note in `notes` and in the text.
  const pv = ok(fx.cli(["spawn", `${OLD}/code-reviewer`, "--preview", "--json"]), "preview by the old id");
  assert.equal(pv.agent, "oats-engineering-coordination--code-reviewer");
  assert.equal(pv.modules[0].from.package, NEW);
  assert.deepEqual(pv.notes, [note("code-reviewer")]);
  const text = fx.cli(["spawn", `${OLD}/code-reviewer`, "--preview"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.deepEqual(lines(text).filter((l) => l.startsWith("note:")), [`note: ${note("code-reviewer")}`]);
  // The new id spelled exactly: no note at all.
  assert.equal(Object.hasOwn(ok(fx.cli(["spawn", `${NEW}/code-reviewer`, "--preview", "--json"]), "preview by the new id"), "notes"), false);

  // A real spawn (--no-launch): the same note; the new home records the new id (a new spawn is the new package's).
  const sp = ok(fx.cli(["spawn", `${OLD}/code-reviewer`, "--purpose", "new", "--no-launch", "--json"]), "spawn by the old id");
  assert.deepEqual(sp.notes, [note("code-reviewer")]);
  const meta = JSON.parse(read(join(sp.home, "instance.json")));
  assert.deepEqual([meta.agent, meta.workspace.soul.package.id, meta.workspace.soul.qualifiedName, meta.modules["acme-tool"].from.package],
    ["oats-engineering-coordination--code-reviewer", NEW, `${NEW}/code-reviewer`, NEW]);

  // soul teams: the soul v2.0.0 added, by the old id.
  const teams = ok(fx.cli(["soul", "teams", `${OLD}/dispatcher`, "--json"]), "soul teams");
  assert.deepEqual([teams.key, teams.notes], [`${NEW}/dispatcher`, [note("dispatcher")]]);
  assert.equal(fx.cli(["soul", "teams", `${OLD}/dispatcher`]).stdout.split("\n")[0], `note: ${note("dispatcher")}`);

  // soul launch set: writes the soul's own key (the new id), and says why.
  const set = ok(fx.cli(["soul", "launch", "set", `${OLD}/dispatcher`, "--harness", "pi", "--json"]), "soul launch set");
  assert.deepEqual([set.key, set.changed, set.after, set.notes], [`${NEW}/dispatcher`, true, { harness: "pi", model: null }, [note("dispatcher")]]);
  assert.deepEqual(YAML.parse(read(join(fx.dep, "oats-local.yaml"))).souls.launch, { [`${NEW}/dispatcher`]: { harness: "pi" } });

  // A soul the new package does not ship: unknown, and the message names the new id.
  const e = fails(fx.cli(["spawn", `${OLD}/nope`, "--preview", "--json"]), "E_SOUL_UNKNOWN", "unknown soul by the old id");
  assert.match(e.message, /\(package oats\.engineering was renamed to oats\.engineering-coordination, and no soul "oats\.engineering-coordination\/nope" is offered either\)/);
  assert.deepEqual(e.details.packages, [NEW]);
});

test("oats-local.yaml souls.launch and souls.disabled keys spelled with the old id apply to the renamed souls", (t) => {
  const fx = fixture(t, { local: { souls: { launch: { [`${OLD}/code-reviewer`]: { harness: "pi" } }, disabled: [`${OLD}/dispatcher`] } } });
  fx.sync();
  fx.swap(); fx.sync("sync after the swap");
  const localBefore = read(join(fx.dep, "oats-local.yaml"));

  // The renamed soul takes its launch from the old key.
  const pv = ok(fx.cli(["spawn", `${NEW}/code-reviewer`, "--preview", "--json"]), "preview the renamed soul");
  assert.equal(pv.harness, "pi");
  assert.deepEqual([pv.launch.from, pv.launch.at, pv.launch.problem], ["local", "oats-local.yaml#/souls/launch/oats.engineering~1code-reviewer", null]);
  // The old key names a soul: a soul that names no launch of its own is not refused as unmatched.
  const dev = fx.cli(["spawn", "dev", "--preview", "--json"]);
  assert.equal(dev.json().ok, true, `${dev.stdout}${dev.stderr}`);
  const souls = ok(fx.cli(["souls", "--json"]), "souls");
  assert.deepEqual((souls.problems || []).filter((p) => p.code === "E_LAUNCH_PREFERENCE_UNMATCHED"), []);
  const doctor = doc(fx.cli(["doctor", "--json"]), "doctor");
  const reported = JSON.stringify([doctor.problems, doctor.warnings, doctor.information]);
  assert.equal(reported.includes("E_LAUNCH_PREFERENCE_UNMATCHED"), false, reported);
  assert.equal(reported.includes(`${OLD}/`), false, `doctor says nothing about the old-id keys: ${reported}`);

  // The old-id disabled entry disables the renamed soul, by either name.
  for (const name of ["dispatcher", `${NEW}/dispatcher`, `${OLD}/dispatcher`]) {
    const e = fails(fx.cli(["spawn", name, "--preview", "--json"]), "E_SOUL_DISABLED", `spawn ${name}`);
    assert.equal(e.details.qualifiedName, `${NEW}/dispatcher`);
  }
  assert.equal(read(join(fx.dep, "oats-local.yaml")), localBefore, "oats-local.yaml is read, never rewritten");
});

test("workspace souls: keys and patterns with the old id apply to the renamed souls; an old home's teams follow either spelling", (t) => {
  const fx = fixture(t, { workspace: {
    teams: { global: { description: "Fixture team" }, reviewers: { description: "Review rota" }, coord: { description: "Coordination" } },
    souls: { [`${OLD}/*`]: { teams: ["reviewers"] }, [`${OLD}/dispatcher`]: { default: "coord" } },
  } });
  fx.sync();
  const old = ok(fx.cli(["spawn", "code-reviewer", "--purpose", "old", "--no-launch", "--json"]), "spawn before the swap").home;
  fx.swap(); fx.sync("sync after the swap");

  const reviewer = ok(fx.cli(["soul", "teams", `${NEW}/code-reviewer`, "--json"]), "soul teams code-reviewer");
  assert.deepEqual([reviewer.key, reviewer.match, reviewer.defaultMatch, reviewer.defaultTeam], [`${NEW}/code-reviewer`, `${OLD}/*`, null, null]);
  assert.deepEqual(reviewer.teams.map((r) => [r.label, r.via]), [["reviewers", ["workspace"]]]);
  const dispatcher = ok(fx.cli(["soul", "teams", `${NEW}/dispatcher`, "--json"]), "soul teams dispatcher");
  assert.deepEqual([dispatcher.match, dispatcher.defaultMatch, dispatcher.defaultTeam], [`${OLD}/dispatcher`, `${OLD}/dispatcher`, { label: "coord", team: null, from: "soul" }]);
  // An old-id key names a soul: no typo guard fires (the fixture's teams have no provider id: team-unmapped only).
  const problems = ok(fx.cli(["teams", "--json"]), "teams").problems;
  assert.deepEqual([...new Set(problems.map((p) => p.code))], ["team-unmapped"], JSON.stringify(problems));
  const doctor = doc(fx.cli(["doctor", "--json"]), "doctor");
  assert.equal(JSON.stringify([doctor.problems, doctor.warnings]).includes("team-soul-unknown"), false, JSON.stringify(doctor.problems));

  // The home spawned under the old id: its live teams from the old-id pattern, then from the new-id one.
  const homeTeams = () => { const r = ok(fx.cli(["inspect", "--home", old, "--json"]), "inspect --home"); return [r.teamsSource, r.teams.map((x) => x.label)]; };
  assert.deepEqual(homeTeams(), ["live", ["reviewers"]]);
  fx.workspace((ws) => { ws.souls = { [`${NEW}/*`]: { teams: ["reviewers"] } }; });
  assert.deepEqual(homeTeams(), ["live", ["reviewers"]], "a new-id pattern applies to a home recorded under the old id");
});

test("a schedule and a trigger naming oats.engineering/code-reviewer resolve and fire after the swap; their definitions are not rewritten", async (t) => {
  const fx = fixture(t);
  // A fake gh: logged in, the repository readable, one open PR to fire on.
  const gh = join(fx.base, "gh"); mkdirSync(gh, { recursive: true });
  const pr = { number: 1, html_url: "https://github.com/acme/knowledge/pull/1", title: "t", body: "", draft: false, head: { sha: "1".padEnd(40, "a"), ref: "h-1" }, base: { ref: "main" }, labels: [], created_at: "2026-09-26T10:01:00Z", updated_at: "2026-09-26T11:01:00Z" };
  writeFileSync(join(gh, "pulls.json"), JSON.stringify([pr]));
  writeFileSync(join(gh, "gh"), `#!/bin/sh
case "$*" in
  "auth status"*) echo "Logged in to github.com account kb-bot"; exit 0 ;;
  "api user"*) echo kb-bot; exit 0 ;;
  *"/pulls"*) cat "${gh}/pulls.json"; exit 0 ;;
  "api repos/"*) echo '{"full_name":"acme/knowledge","permissions":{"push":true}}'; exit 0 ;;
esac
echo "unexpected gh $*" >&2; exit 2
`);
  chmodSync(join(gh, "gh"), 0o755);
  fx.env.PATH = `${gh}:${fx.env.PATH}`;
  fx.sync();
  // Both declared while the old id is the locked one (as a deployment has them before it migrates).
  ok(fx.cli(["schedule", "add", "rv", `--spec-json=${JSON.stringify({ kind: "spawn", cron: "0 7 * * *", tz: "UTC", agent: `${OLD}/code-reviewer`, task: "Review." })}`, "--json"]), "schedule add");
  const file = join(fx.base, "trigger.json");
  writeFileSync(file, JSON.stringify({ id: "rvt", kind: "trigger", on: { source: "github.pull_request", repo: "github.com/acme/knowledge", events: ["opened"], poll: "2m" }, spawn: { soul: `${OLD}/code-reviewer`, purpose: "pr-{number}", task: "Review {url}." } }));
  ok(fx.cli(["trigger", "add", "--file", file, "--json"]), "trigger add");
  const stored = read(join(fx.dep, "oats-schedules.json"));
  fx.swap(); fx.sync("sync after the swap");

  const sched = ok(fx.cli(["schedule", "test", "rv", "--json"]), "schedule test").test;
  assert.deepEqual([sched.ok, sched.soul, sched.problems], [true, { name: `${OLD}/code-reviewer`, origin: null, resolves: true, error: null }, []]);
  const trig = ok(fx.cli(["trigger", "test", "rvt", "--json"]), "trigger test");
  assert.deepEqual([trig.ok, trig.soul, trig.problems], [true, { resolves: true, name: `${OLD}/code-reviewer`, agent: "oats-engineering-coordination--code-reviewer", messaging: null }, []]);

  // Fired once each, in process as the host tick runs them, never launched.
  const inGh = (fn) => fx.inEnv(async () => { const path = process.env.PATH; process.env.PATH = fx.env.PATH; try { return await fn(); } finally { process.env.PATH = path; } });
  const ran = await inGh(() => S.runNow(fx.dep, "rv", { io: { noLaunch: true } }));
  assert.equal(ran.run.outcome, "launched", JSON.stringify(ran.run));
  assert.match(ran.run.home, new RegExp(`/agents/oats-engineering-coordination--code-reviewer/instances/oats-engineering-coordination-code-reviewer-rv-\\d{12}$`));
  const fired = await inGh(async () => T.tickTriggers(fx.dep, { io: { noLaunch: true }, ctx: await S.scopeAutomations(fx.dep, {}) }));
  assert.deepEqual(fired.map((r) => r.action), ["fired"], JSON.stringify(fired));
  const live = T.liveTriggerInstances(fx.dep, "local/rvt");
  assert.deepEqual(live.map((r) => r.home), [join(fx.root, "oats-engineering-coordination--code-reviewer", "instances", "oats-engineering-coordination-code-reviewer-pr-1")]);
  for (const home of [ran.run.home, live[0].home]) assert.equal(JSON.parse(read(join(home, "instance.json"))).workspace.soul.package.id, NEW, home);

  // The definitions still name the old id: the rename is read, never written.
  const jobs = JSON.parse(read(join(fx.dep, "oats-schedules.json"))).jobs;
  assert.deepEqual([jobs.rv.agent, jobs.rvt.spawn.soul], [`${OLD}/code-reviewer`, `${OLD}/code-reviewer`]);
  assert.deepEqual(JSON.parse(stored).jobs.rv, jobs.rv);
});

test("the migration: swap the pin, oats sync; a home spawned under the old id is unchanged, reads moved and is kept by an upgrade", (t) => {
  const fx = fixture(t);
  fx.sync();
  const sp = ok(fx.cli(["spawn", "code-reviewer", "--purpose", "old", "--no-launch", "--json"]), "spawn before the swap");
  const metaFile = join(sp.home, "instance.json"), bytes = read(metaFile);
  const meta = JSON.parse(bytes);
  assert.deepEqual([meta.workspace.soul.package.id, meta.modules["acme-tool"].from.package], [OLD, OLD]);
  const doctorBefore = doc(fx.cli(["doctor", "--json"]), "doctor before");

  fx.swap();
  const synced = fx.sync("sync after the swap");
  assert.deepEqual(synced.packages.map((p) => [p.id, p.version]), [[NEW, "2.0.0"]]);
  assert.deepEqual(Object.keys(JSON.parse(fx.lock()).packages), [NEW]);

  // The home is untouched.
  assert.equal(read(metaFile), bytes, "instance.json is byte-identical");

  // status: soul and module moved (onto the new id's lock entry), never missing.
  const text = fx.cli(["status"]);
  assert.equal(text.status, 0, text.stderr);
  assert.doesNotMatch(text.stdout, /no longer locked|missing/, text.stdout);
  assert.match(text.stdout, /soul: code-reviewer from package oats\.engineering v1\.18\.0 @ [0-9a-f]{7} {2}\[package moved since \(now v2\.0\.0 @ [0-9a-f]{7}\)\]/);
  assert.match(text.stdout, /modules: acme-tool from package oats\.engineering v1\.18\.0 @ [0-9a-f]{7} {2}\[package moved since \(now @ [0-9a-f]{7}\)\]/);
  const status = doc(fx.cli(["status", "--json"]), "status --json");
  assert.equal(JSON.stringify(status).includes("package-absent"), false);
  const agentRow = status.agents.find((a) => a.name === "oats-engineering--code-reviewer");
  // The agent's soul stamp reads the new id's package soul too: moved, with the current commit.
  assert.deepEqual([agentRow.soulSource.status, agentRow.soulSource.current], ["moved", fx.pkg.commit2], JSON.stringify(agentRow.soulSource));
  const row = agentRow.instances[0];
  assert.deepEqual([row.soul.status, row.soul.package, row.soul.current, row.soul.currentVersion], ["moved", OLD, fx.pkg.commit2, "2.0.0"]);
  assert.deepEqual(row.modules.map((m) => [m.name, m.from.package, m.status, m.current]), [["acme-tool", OLD, "moved", { commit: fx.pkg.commit2, version: "2.0.0" }]]);

  // readiness: the home's package soul passes; nothing about the package fails.
  const ready = ok(fx.cli(["readiness", "--home", sp.home, "--json"]), "readiness");
  const items = Object.values(ready.checks).flatMap((c) => c.items);
  const pkgItem = items.find((i) => i.subject === `package ${OLD}/code-reviewer`);
  assert.equal(pkgItem?.status, "pass", JSON.stringify(pkgItem));
  assert.deepEqual(items.filter((i) => i.status === "fail" && /package|oats\.engineering/.test(JSON.stringify(i))), []);

  // upgrade --plan: the module is kept, naming the respawn; nothing moves.
  const plan = ok(fx.cli(["instance", "upgrade", sp.instance, "--plan", "--json"]), "upgrade --plan");
  assert.deepEqual([plan.modules, plan.kept], [[], [{ capability: "acme-tool", reason: RESPAWN }]]);
  assert.equal(read(metaFile), bytes, "a plan writes nothing");

  // doctor: exactly what it said before the swap (the fixture's own operator-soul problems), nothing new.
  const doctorAfter = doc(fx.cli(["doctor", "--json"]), "doctor after");
  assert.deepEqual([doctorAfter.problems, doctorAfter.warnings, doctorAfter.information], [doctorBefore.problems, doctorBefore.warnings, doctorBefore.information]);
});

test("oats sync refuses both ids declared at once (package-declared-twice), keeping the lock", (t) => {
  const fx = fixture(t);
  fx.sync();
  const lock = fx.lock();
  fx.workspace((ws) => { ws.packages = { [OLD]: "v1.18.0", [NEW]: "v2.0.0" }; });
  const e = fails(fx.cli(["sync", "--json"]), "E_WORKSPACE_SCHEMA", "sync with both ids");
  assert.deepEqual([e.details.reason, e.details.ids, e.details.keep, e.details.path], ["package-declared-twice", [OLD, NEW], NEW, `/packages/${OLD}`]);
  assert.match(e.message, /keep oats\.engineering-coordination and remove oats\.engineering, then run `oats sync` again/);
  assert.equal(fx.lock(), lock, "the lock is unchanged");
});
