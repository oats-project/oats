// An entry of oats-local.yaml `souls.disabled` that names no soul keeps nothing off this machine, and
// before oats-project/oats#1772 nothing said so: spawn matches each entry by exact name only
// (disabledEntry), so after a rename or a removed package pin the soul it was meant to keep off spawns
// again under its new name. The entry fails OPEN, where a stale souls.launch key fails closed. `oats
// doctor` now reports such an entry with the nearest souls and the hand edit, by the launch check's
// discipline: from this machine's last read, an entry it could not check as information, never a
// failure of doctor, and nothing else changes (spawn, oats souls, readiness, inspect).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { git, v2Deployment } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";
import { REF, world } from "./helpers/memory-workspace.mjs";
import { disabledEntriesUnmatched, disabledEntry, soulCandidates, soulsOffered } from "../lib/instance-resolution.mjs";

const CODE = "disabled-soul-unmatched";
const INFO = "disabled-soul-unchecked: ";
const LOCAL = "oats-local.yaml";
const at = (index) => `${LOCAL}#/souls/disabled/${index}`;

/* ───────────────────────────── the decider, over reads held in memory ─── */

// world(): `agents` (the host) offers reviewer and planner, `platform` reviewer and builder, the
// locked package acme.pkg keeper.
const decide = async (disabled, edit, read = (d) => d) => disabledEntriesUnmatched({ local: { souls: { disabled } }, discovery: read(await world(edit).discover()) });

test("an entry that spawn's rule matches for some offered soul is matched: bare, <member>/<soul>, <package>/<soul>, a package soul's bare name, a soul of two members", async () => {
  assert.deepEqual(await decide(["planner", "agents/planner", "platform/builder", "acme.pkg/keeper", "keeper", "reviewer"]), { unmatched: [], unchecked: [] });
});

test("unmatched rows are in file order, at their index, each with at most three qualified names ranked as the launch check ranks", async () => {
  const found = await decide(["planner", "agents/builder", "quartermaster", "other.pkg/keeper", "planer"]);
  assert.deepEqual(found.unchecked, []);
  assert.deepEqual(found.unmatched, [
    // Spawn's exact rule: builder is platform's, so agents/builder keeps nothing off; its suggestion is the other member's.
    { entry: "agents/builder", at: at(1), suggestions: ["platform/builder"] },
    { entry: "quartermaster", at: at(2), suggestions: [] },
    { entry: "other.pkg/keeper", at: at(3), suggestions: ["acme.pkg/keeper"] },
    // Same bare name first, then within two edits by distance, then by code point.
    { entry: "planer", at: at(4), suggestions: ["agents/planner"] },
  ]);
  const near = await decide(["reviewr"]);
  assert.deepEqual(near.unmatched[0].suggestions, ["agents/reviewer", "platform/reviewer"]);
});

test("a disabled soul is still offered: the entries that disable souls match", async () => {
  const discovery = await world().discover();
  const local = { souls: { disabled: ["builder", "acme.pkg/keeper"] } };
  // disabledEntry holds for those souls (the spawn's refusal), and the check finds both entries matched.
  assert.equal(soulCandidates(discovery).filter((c) => disabledEntry(local, c.entry) !== null).length, 2);
  assert.deepEqual(disabledEntriesUnmatched({ local, discovery }), { unmatched: [], unchecked: [] });
});

test("proof per entry: a bare entry or one under no offered package is unchecked while a member is unconfirmed; one under an offered package is checked; one under an unlocked package is unchecked for that", async () => {
  const unconfirmed = (repos, workspace) => { delete repos.platform.files["oats-membership.yaml"]; workspace.packages["new.pkg"] = "v2.0.0"; };
  const found = await decide(["ghost", "acme.pkg/gone", "platform/ghost", "gone.pkg/x", "new.pkg/x", "planner"], unconfirmed);
  assert.deepEqual(found.unmatched, [{ entry: "acme.pkg/gone", at: at(1), suggestions: [] }]);
  assert.deepEqual(found.unchecked, [
    { entry: "ghost", at: at(0), reason: "member-unconfirmed" },
    { entry: "platform/ghost", at: at(2), reason: "member-unconfirmed" },
    // A prefix that is no offered package may be a member's name: unchecked while the bare souls are unproven.
    { entry: "gone.pkg/x", at: at(3), reason: "member-unconfirmed" },
    { entry: "new.pkg/x", at: at(4), reason: "package-unlocked" },
  ]);
  // A locked package with a soul that failed to read: its entries are unchecked for that.
  const skipped = await decide(["acme.pkg/other"], (repos, workspace, lock) => { lock.packages["acme.pkg"].souls.push({ name: "gone", path: "souls/gone", digest: `sha256-${"0".repeat(64)}` }); });
  assert.deepEqual(skipped, { unmatched: [], unchecked: [{ entry: "acme.pkg/other", at: at(0), reason: "package-soul-unread" }] });
  // With everything read, the same stale entries are rows.
  assert.deepEqual((await decide(["ghost", "gone.pkg/x"])).unmatched.map((r) => r.entry), ["ghost", "gone.pkg/x"]);
});

test("a read that establishes nothing leaves every unmatched entry unchecked: the standalone view of an unreadable host, and a discovery with no record of what it skipped; an explicit standalone is checked", async () => {
  const disabled = ["ghost", "acme.pkg/gone", "builder"];
  const config = (ref) => ({ schemaVersion: 2, ...(ref ? { standalone: ref } : { workspace: REF("agents") }), souls: { disabled } });
  const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
  const alone = world((repos) => { repos.agents.unreadable = true; });
  const view = await discoverOrStandalone({ workspace: REF("platform") }, { lock: alone.lock, remote: alone.remote });
  assert.equal(soulsOffered(view).unread.all, "standalone");
  assert.deepEqual(disabledEntriesUnmatched({ local: config(), discovery: view }), { unmatched: [], unchecked: [{ entry: "ghost", at: at(0), reason: "standalone" }, { entry: "acme.pkg/gone", at: at(1), reason: "standalone" }] }, "builder is platform's, matched");
  const { soulsUnread: _dropped, ...unrecorded } = await world().discover();
  assert.deepEqual(disabledEntriesUnmatched({ local: config(), discovery: unrecorded }).unchecked.map((u) => [u.entry, u.reason]), [["ghost", "unrecorded"], ["acme.pkg/gone", "unrecorded"]]);
  const w = world();
  const explicit = await discoverOrStandalone(config(REF("platform")), { lock: w.lock, remote: w.remote });
  assert.equal(soulsOffered(explicit).unread.all, null);
  assert.deepEqual(disabledEntriesUnmatched({ local: config(REF("platform")), discovery: explicit }).unmatched.map((r) => r.entry), ["ghost", "acme.pkg/gone"]);
});

test("souls.disabled absent, empty or not a list: nothing, as disabledEntry reads it", async () => {
  const discovery = await world().discover();
  for (const local of [{}, { souls: {} }, { souls: { disabled: [] } }, { souls: { disabled: "ghost" } }, { souls: { disabled: { 0: "ghost" } } }, null]) {
    assert.deepEqual(disabledEntriesUnmatched({ local, discovery }), { unmatched: [], unchecked: [] }, JSON.stringify(local));
  }
});

/* ───────────────────────────── oats doctor, through the CLI ───────────── */

function deployment(t, { local = {}, souls } = {}) {
  return v2Deployment({ t, name: "acme", souls: souls ?? { dev: {}, writer: {}, "code-reviewer": {} }, local });
}
const localOf = (fx) => readFileSync(join(fx.dep, LOCAL), "utf8");
const setLocal = (fx, edit) => { const v = YAML.parse(localOf(fx)); edit(v); writeFileSync(join(fx.dep, LOCAL), YAML.stringify(v, { lineWidth: 0 })); };
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
// `oats doctor --json` prints its own document (workspaceApi 2), not the envelope.
const doctor = (fx) => { const r = fx.cli(["doctor", "--json"]); assert.equal(r.status, 0, r.stdout + r.stderr); const d = JSON.parse(r.stdout); assert.equal(d.workspaceApi, 2); return d; };
const ours = (d) => ({ problems: (d.problems ?? []).filter((p) => p.code === CODE), information: d.information.filter((l) => l.startsWith(INFO)) });
const textDoctor = (fx) => { const r = fx.cli(["doctor"]); assert.equal(r.status, 0, r.stderr); return r.stdout; };
/** A workspace with the package acme.pkg (souls reviewer and keeper) declared and locked. */
function withPackage(t, fx) {
  const pkg = packageRepo({ souls: { reviewer: {}, keeper: {} } });
  t.after(pkg.cleanup);
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], packages: { "acme.pkg": `${pkg.ref}@v1.0.0` }, teams: { global: { description: "Fixture team" } }, defaults: { knowledge: "none", messaging: "none", tasks: "none" } } } });
  ok(fx.cli(["sync", "--json"]), "sync");
  return pkg;
}

test("A1: the scratch-run case: oats.engineering/code-reviewer with only a member's code-reviewer is one row with the member's soul as nearest, said in text as the launch rows are; spawn is not refused", (t) => {
  const fx = deployment(t, { local: { souls: { disabled: ["oats.engineering/code-reviewer"] } } });
  ok(fx.cli(["souls", "--json"]), "souls");
  const d = ours(doctor(fx));
  assert.deepEqual(d.information, []);
  assert.equal(d.problems.length, 1);
  const [row] = d.problems;
  assert.deepEqual(Object.keys(row), ["code", "entry", "at", "suggestions", "message", "remedy"]);
  assert.deepEqual([row.entry, row.at, row.suggestions], ["oats.engineering/code-reviewer", at(0), ["ws/code-reviewer"]]);
  for (const text of [row.message, row.remedy]) assert.ok(text.includes(`"oats.engineering/code-reviewer"`) && text.includes("ws/code-reviewer"), text);
  assert.equal(row.message, `oats-local.yaml souls.disabled names "oats.engineering/code-reviewer" (nearest: ws/code-reviewer), which is no soul in this machine's last read of the souls this workspace offers, so it keeps no soul off this machine. A spawn reads the workspace itself and is the authority`);
  assert.equal(row.remedy, `in oats-local.yaml souls.disabled, replace "oats.engineering/code-reviewer" with the soul it was meant to keep off this machine (nearest: ws/code-reviewer; oats souls lists them), or remove it`);
  const text = textDoctor(fx);
  assert.ok(text.includes(`\n! ${CODE}: ${row.message}\n  ${row.remedy}\n`), text);
  // No new refusal: the soul the entry was meant to keep off still spawns.
  ok(fx.cli(["spawn", "code-reviewer", "--preview", "--json"]), "spawn code-reviewer --preview");
});

test("A2: entries that match are silent (a member soul's bare name, <member>/<soul>, <package>/<soul>, a package soul's bare name), and a spawn of a soul they name is still E_SOUL_DISABLED", (t) => {
  const fx = deployment(t, { local: { souls: { disabled: ["dev", "ws/writer", "acme.pkg/reviewer", "keeper"] } } });
  withPackage(t, fx);
  ok(fx.cli(["souls", "--json"]), "souls");
  assert.deepEqual(ours(doctor(fx)), { problems: [], information: [] });
  assert.ok(!textDoctor(fx).includes(CODE));
  for (const soul of ["dev", "writer", "acme.pkg/reviewer", "keeper"]) {
    const r = fx.cli(["spawn", soul, "--preview", "--json"]);
    assert.notEqual(r.status, 0, soul);
    assert.equal(r.json().error.code, "E_SOUL_DISABLED", `${soul}: ${r.stdout}`);
  }
});

test("A3: spawn's exact rule: <member>/<soul> for a soul only another member offers is a row whose suggestions name the other member's soul", (t) => {
  const fx = deployment(t, { local: { souls: { disabled: ["ws/auditor"] } } });
  // A second member, `m`, which offers auditor.
  const bare = join(fx.base, "remotes", "m.git"), seed = join(fx.base, "m-seed");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare");
  for (const k of ["uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"]) git(bare, "config", k, "true");
  git(bare, "config", "maintenance.auto", "false");
  git(fx.base, "clone", "-q", bare, seed);
  git(seed, "config", "maintenance.auto", "false");
  mkdirSync(join(seed, "souls", "auditor"), { recursive: true });
  writeFileSync(join(seed, "oats-membership.yaml"), YAML.stringify({ schemaVersion: 2, workspace: fx.ref }));
  writeFileSync(join(seed, "souls", "auditor", "soul.yaml"), YAML.stringify({ schemaVersion: 2, name: "auditor", description: "auditor fixture soul.", work: "directory" }));
  writeFileSync(join(seed, "souls", "auditor", "AGENTS.md"), "# auditor\n");
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "member"); git(seed, "push", "-q", "origin", "HEAD:main");
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref, pathToFileURL(bare).href], teams: { global: { description: "Fixture team" } }, defaults: { knowledge: "none", messaging: "none", tasks: "none" } } } });
  const souls = ok(fx.cli(["souls", "--json"]), "souls");
  assert.ok(souls.souls.some((s) => s.name === "auditor"), "the other member's soul is offered");
  const d = ours(doctor(fx));
  assert.deepEqual(d.information, []);
  assert.deepEqual(d.problems.map((p) => [p.entry, p.at]), [["ws/auditor", at(0)]]);
  assert.ok(d.problems[0].suggestions.includes("m/auditor"), JSON.stringify(d.problems[0]));
});

test("A4: proof per entry: while a member soul fails to read, a bare stale entry is information and a stale entry under a locked package a row; an entry under a declared, unlocked package is information naming that", (t) => {
  const fx = deployment(t, { local: { souls: { disabled: ["ghostly", "acme.pkg/gone"] } } });
  const pkg = withPackage(t, fx);
  fx.commit({ "souls/ghost/soul.yaml": "schemaVersion: 2\nname: Not A Slug\n", "souls/ghost/AGENTS.md": "# ghost\n" });
  ok(fx.cli(["souls", "--json"]), "souls, after the member soul broke");
  const d = ours(doctor(fx));
  assert.deepEqual(d.problems.map((p) => [p.entry, p.at]), [["acme.pkg/gone", at(1)]]);
  assert.deepEqual(d.information, [`${INFO}oats-local.yaml souls.disabled "ghostly" was not checked against the souls this workspace offers: a member's or an external soul could not be read, and the entry may be that soul's; this is this machine's last read, and a spawn reads the workspace itself`]);
  assert.ok(textDoctor(fx).includes(`\nINFO: ${d.information[0]}\n`));
  // A package declared and not locked.
  fx.commit({ "souls/ghost/soul.yaml": null, "souls/ghost/AGENTS.md": null, "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "acme", members: [fx.ref], packages: { "acme.pkg": `${pkg.ref}@v1.0.0`, "new.pkg": `${pkg.ref}@v1.0.0` }, teams: { global: { description: "Fixture team" } }, defaults: { knowledge: "none", messaging: "none", tasks: "none" } } } });
  setLocal(fx, (v) => { v.souls.disabled = ["new.pkg/x"]; });
  fx.cli(["souls", "--json"]);
  const unlocked = ours(doctor(fx));
  assert.deepEqual(unlocked.problems, []);
  assert.deepEqual(unlocked.information, [`${INFO}oats-local.yaml souls.disabled "new.pkg/x" was not checked against the souls this workspace offers: its package is declared and not locked (oats sync); this is this machine's last read, and a spawn reads the workspace itself`]);
});

test("A5: a cold cache: no row, and one information line that names the entries, the first three then how many more", (t) => {
  const fx = deployment(t, { local: { souls: { disabled: ["oats.engineering/code-reviewer", "dev"] } } });
  const d = ours(doctor(fx));
  assert.deepEqual(d.problems, []);
  assert.equal(d.information.length, 1);
  assert.match(d.information[0], /^disabled-soul-unchecked: the entries of oats-local\.yaml souls\.disabled \("oats\.engineering\/code-reviewer", "dev"\) were not checked against the souls this workspace offers: this machine's cache cannot answer \(.*\); oats sync, then oats souls, then run doctor again$/);
  setLocal(fx, (v) => { v.souls.disabled = ["e", "d", "c", "b", "a"]; });
  assert.match(ours(doctor(fx)).information[0], /^disabled-soul-unchecked: the entries of oats-local\.yaml souls\.disabled \("e", "d", "c" and 2 more\) were not checked /, "in file order");
  assert.ok(textDoctor(fx).includes("\nINFO: disabled-soul-unchecked: the entries of oats-local.yaml souls.disabled (\"e\", \"d\", \"c\" and 2 more) "));
});

test("A6: nothing to say: no souls.disabled, or an empty one, adds no row and no line", (t) => {
  const fx = deployment(t);
  for (const state of ["cold", "warm"]) {
    if (state === "warm") ok(fx.cli(["souls", "--json"]), "souls");
    for (const edit of [(v) => { delete v.souls; }, (v) => { v.souls = { disabled: [] }; }]) {
      setLocal(fx, edit);
      assert.deepEqual(ours(doctor(fx)), { problems: [], information: [] }, state);
      assert.ok(!textDoctor(fx).includes("disabled-soul-"), state);
    }
  }
});

test("doctor's other checks and oats souls are unchanged by a stale entry: exit 0, no new oats souls row", (t) => {
  const fx = deployment(t, { local: { souls: { disabled: ["oats.engineering/code-reviewer"] } } });
  const souls = ok(fx.cli(["souls", "--json"]), "souls");
  assert.deepEqual((souls.problems ?? []).filter((p) => /disabled/.test(`${p.code} ${p.message}`)), []);
  assert.deepEqual(souls.souls.map((s) => s.name).sort(), ["code-reviewer", "dev", "writer"]);
});
