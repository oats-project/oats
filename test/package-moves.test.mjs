// lib/package-moves.mjs and what compares through it: a renamed official package's old id
// (`oats.engineering`) and its new id (`oats.engineering-coordination`) name one package wherever two ids
// meet (docs/workspaces.md "Renamed packages"). Read-time only: every answer keeps the id as it was
// declared or recorded. Pure functions over in-memory fixtures (a hand-built discovery, lock, team model
// and instance.json); no network, no Git, no files written.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { currentPackageId, samePackage } from "../lib/package-moves.mjs";
import { currentSoulKey, memberNameOf, soulKeyIn, soulTeams, teamModel, teamProblems } from "../lib/teams.mjs";
import { launchKeysUnmatched, launchLayers } from "../lib/launch-preference.mjs";
import { disabledEntry, findSoulEntry, homeSoulMatches, renamedSelectorNote, soulNameMatches } from "../lib/instance-resolution.mjs";
import { soulIndexOf, soulOriginOf } from "../lib/automations.mjs";
import { selectCapabilityRow } from "../lib/capability-show.mjs";
import { driftOf, lockedPackageEntry, soulDriftOf } from "../lib/drift.mjs";
import { packageRespawnWarning, packageUpgradeDrift } from "../lib/upgrade-state.mjs";
import { resolvePackages } from "../lib/packages.mjs";
import { packageSoulAgentName } from "../lib/workspace.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OLD = "oats.engineering", NEW = "oats.engineering-coordination";
const OID = (seed) => seed.repeat(40).slice(0, 40);
const A = OID("a"), B = OID("b"), C = OID("c"), D = OID("d");
const PKG_REPO = "github.com/oats-project/oats-engineering";

/** A package soul as lib/workspace.mjs discoverPackageSouls lists it. */
const packageSoul = (pkg, name, { commit = B, version = "2.0.0" } = {}) => ({
  name, path: `oats-package/souls/${name}`, repoKey: PKG_REPO, ref: "refs/tags/v2.0.0", commit, private: false,
  definition: { schemaVersion: 2, name, description: `${name} of ${pkg}`, work: "worktree", capabilities: {} },
  package: pkg, version, qualifiedName: `${pkg}/${name}`, agentName: packageSoulAgentName(pkg, name), digest: `sha256-${"0".repeat(64)}`,
});
const discoveryOf = (packageSouls, members = []) => ({ members, external: [], packageSouls });
/** A confirmed member that ships `souls`. */
const member = (key, souls) => ({ key, confirmed: true, commit: C, souls: souls.map((name) => ({ name, path: `souls/${name}`, definition: { name } })) });
/** findSoulEntry's (or any kernel call's) refusal: its code and details. */
function refusal(fn) {
  try { fn(); } catch (e) { return { code: e.code, details: e.details, message: e.message }; }
  assert.fail("expected a refusal");
}

// ---------- lib/package-moves.mjs ----------

test("the table: exactly one rename, oats.engineering → oats.engineering-coordination, read from the file itself", () => {
  // Pinned on the source text: a second entry, or a changed target, is a decision this test makes visible.
  const text = readFileSync(join(REPO, "lib/package-moves.mjs"), "utf8");
  const body = text.match(/const RENAMED = Object\.assign\(Object\.create\(null\), \{([\s\S]*?)\}\);/);
  assert.ok(body, "RENAMED is a null-prototype object literal");
  const entries = [...body[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(([, from, to]) => [from, to]);
  assert.deepEqual(entries, [[OLD, NEW]]);
  // And by behavior.
  assert.equal(currentPackageId(OLD), NEW);
  assert.equal(currentPackageId(NEW), NEW, "the new id is current");
});

test("currentPackageId: any other value comes back as it went in, prototype names included (null prototype)", () => {
  for (const other of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "acme.pkg", "oats.framework",
    "oats.engineering-coordination-x", "Oats.Engineering", "oats.engineering ", "", null, undefined, 7]) {
    assert.equal(currentPackageId(other), other, `${String(other)} is not renamed`);
  }
});

test("samePackage: reflexive, symmetric, old and new are one, unrelated ids are not", () => {
  for (const id of [OLD, NEW, "acme.pkg", "constructor", "__proto__"]) assert.equal(samePackage(id, id), true, `${id} is itself`);
  assert.equal(samePackage(OLD, NEW), true);
  assert.equal(samePackage(NEW, OLD), true);
  for (const [a, b] of [[OLD, "acme.pkg"], [NEW, "acme.pkg"], ["acme.pkg", "acme.other"], [OLD, "oats.framework"], ["constructor", "toString"], ["__proto__", OLD]]) {
    assert.equal(samePackage(a, b), false, `${a} vs ${b}`);
    assert.equal(samePackage(b, a), false, `${b} vs ${a}`);
  }
});

// ---------- lib/teams.mjs ----------

test("currentSoulKey: a renamed package's soul key and pattern take the new id; bare names, member keys and other values are untouched", () => {
  assert.equal(currentSoulKey(`${OLD}/code-reviewer`), `${NEW}/code-reviewer`);
  assert.equal(currentSoulKey(`${OLD}/*`), `${NEW}/*`);
  assert.equal(currentSoulKey(`${NEW}/code-reviewer`), `${NEW}/code-reviewer`);
  for (const same of ["code-reviewer", "*", "oats-engineering/code-reviewer", "acme.pkg/x", "github.com/acme/oats.engineering/x",
    `/${OLD}`, `x/${OLD}`]) {
    assert.equal(currentSoulKey(same), same, same);
  }
  // A key with nothing before its slash is not a package key.
  assert.equal(currentSoulKey("/code-reviewer"), "/code-reviewer");
  for (const v of [null, undefined, 3, {}]) assert.equal(currentSoulKey(v), v);
});

test("soulKeyIn: the exact key wins; else the other spelling, either direction; null when none, or for a non-object", () => {
  const both = { [`${OLD}/code-reviewer`]: 1, [`${NEW}/code-reviewer`]: 2 };
  assert.equal(soulKeyIn(both, `${OLD}/code-reviewer`), `${OLD}/code-reviewer`);
  assert.equal(soulKeyIn(both, `${NEW}/code-reviewer`), `${NEW}/code-reviewer`);
  assert.equal(soulKeyIn({ [`${OLD}/code-reviewer`]: 1 }, `${NEW}/code-reviewer`), `${OLD}/code-reviewer`, "new key finds the old spelling");
  assert.equal(soulKeyIn({ [`${NEW}/code-reviewer`]: 1 }, `${OLD}/code-reviewer`), `${NEW}/code-reviewer`, "old key finds the new spelling");
  assert.equal(soulKeyIn({ [`${OLD}/*`]: 1 }, `${NEW}/*`), `${OLD}/*`, "patterns too");
  assert.equal(soulKeyIn({ [`${NEW}/planner`]: 1, "acme.pkg/code-reviewer": 1 }, `${OLD}/code-reviewer`), null, "another soul, another package");
  assert.equal(soulKeyIn({ "code-reviewer": 1 }, `${OLD}/code-reviewer`), null, "a bare name is not a package key");
  assert.equal(soulKeyIn({}, `${OLD}/code-reviewer`), null);
  for (const entries of [null, undefined, [], "x"]) assert.equal(soulKeyIn(entries, `${OLD}/code-reviewer`), null);
  assert.equal(soulKeyIn(both, null), null);
  // Ties by codepoint: with one rename in the table a key has exactly one other spelling, so the
  // ordering is not observable through the real table; only the one answer is.
  assert.equal(soulKeyIn({ "constructor": 1 }, "constructor"), "constructor");
  assert.equal(soulKeyIn({}, "constructor"), null, "an own key, never a prototype one");
});

const TEAMS = { eng: { team: "acme:eng" }, coord: { team: "acme:coord" }, all: { team: "acme:all" } };
const model = (souls) => teamModel({ schemaVersion: 2, name: "ws", teams: TEAMS, souls }, null);
const row = (label, via = ["workspace"], d = false) => ({ label, team: TEAMS[label].team, default: d, from: "shared", via });

test("soulTeams: an old-id pattern or key applies to the new id's soul, and a new-id one to an old home's key", () => {
  const oldPattern = model({ [`${OLD}/*`]: { teams: ["eng"] } });
  assert.deepEqual(soulTeams(oldPattern, `${NEW}/code-reviewer`),
    { key: `${NEW}/code-reviewer`, match: `${OLD}/*`, defaultMatch: null, defaultTeam: null, teams: [row("eng")] });
  assert.deepEqual(soulTeams(oldPattern, `${OLD}/code-reviewer`),
    { key: `${OLD}/code-reviewer`, match: `${OLD}/*`, defaultMatch: null, defaultTeam: null, teams: [row("eng")] });

  const oldExact = model({ [`${OLD}/code-reviewer`]: { teams: ["eng"], default: "eng" } });
  assert.deepEqual(soulTeams(oldExact, `${NEW}/code-reviewer`), {
    key: `${NEW}/code-reviewer`, match: `${OLD}/code-reviewer`, defaultMatch: `${OLD}/code-reviewer`,
    defaultTeam: { label: "eng", team: "acme:eng", from: "soul" }, teams: [row("eng", ["default", "workspace"], true)],
  });
  assert.deepEqual(soulTeams(oldExact, `${NEW}/planner`).match, null, "another soul of the package is not that key");

  const newPattern = model({ [`${NEW}/*`]: { teams: ["coord"] } });
  assert.deepEqual(soulTeams(newPattern, `${OLD}/code-reviewer`),
    { key: `${OLD}/code-reviewer`, match: `${NEW}/*`, defaultMatch: null, defaultTeam: null, teams: [row("coord")] });
  // An unrelated package is untouched.
  assert.deepEqual(soulTeams(oldPattern, "acme.pkg/code-reviewer"),
    { key: "acme.pkg/code-reviewer", match: null, defaultMatch: null, defaultTeam: null, teams: [] });
});

test("soulTeams: with both spellings of a pattern, exactly one applies (the key's own spelling), never merged", () => {
  const both = model({ [`${OLD}/*`]: { teams: ["eng"], default: "eng" }, [`${NEW}/*`]: { teams: ["coord"], default: "coord" } });
  assert.deepEqual(soulTeams(both, `${NEW}/code-reviewer`), {
    key: `${NEW}/code-reviewer`, match: `${NEW}/*`, defaultMatch: `${NEW}/*`,
    defaultTeam: { label: "coord", team: "acme:coord", from: "soul" }, teams: [row("coord", ["default", "workspace"], true)],
  });
  assert.deepEqual(soulTeams(both, `${OLD}/code-reviewer`), {
    key: `${OLD}/code-reviewer`, match: `${OLD}/*`, defaultMatch: `${OLD}/*`,
    defaultTeam: { label: "eng", team: "acme:eng", from: "soul" }, teams: [row("eng", ["default", "workspace"], true)],
  });
});

test("soulTeams: an exact key beats a pattern whatever their spellings", () => {
  const m = model({ [`${OLD}/code-reviewer`]: { teams: ["eng"] }, [`${NEW}/*`]: { teams: ["coord"] }, "*": { teams: ["all"] } });
  assert.deepEqual(soulTeams(m, `${NEW}/code-reviewer`),
    { key: `${NEW}/code-reviewer`, match: `${OLD}/code-reviewer`, defaultMatch: null, defaultTeam: null, teams: [row("eng")] });
  const m2 = model({ [`${NEW}/code-reviewer`]: { teams: ["coord"] }, [`${OLD}/*`]: { teams: ["eng"] } });
  assert.deepEqual(soulTeams(m2, `${OLD}/code-reviewer`),
    { key: `${OLD}/code-reviewer`, match: `${NEW}/code-reviewer`, defaultMatch: null, defaultTeam: null, teams: [row("coord")] });
  // The pattern still applies to the package's other souls; "*" to everything else.
  assert.equal(soulTeams(m, `${OLD}/planner`).match, `${NEW}/*`);
  assert.equal(soulTeams(m, "acme.pkg/planner").match, "*");
});

test("teamProblems: an old-id souls: key naming a soul offered under the new id is known; a truly unknown key is still reported", () => {
  const m = model({ [`${OLD}/code-reviewer`]: { teams: ["eng"] }, [`${OLD}/nope`]: { teams: ["eng"] }, [`${NEW}/planner`]: { teams: ["eng"] }, [`${OLD}/*`]: { teams: ["eng"] } });
  const soulKeys = new Set([`${NEW}/code-reviewer`, `${OLD}/planner`]);
  assert.deepEqual(teamProblems(m, { soulKeys }), [{
    code: "team-soul-unknown", severity: "warning", key: `${OLD}/nope`, at: "oats-workspace.yaml#/souls/oats.engineering~1nope",
    message: `souls: ${OLD}/nope names no soul of this workspace (a pattern is "*" or <member|package>/*)`,
    fix: "correct the key to a soul's qualified name (oats souls lists them), or remove it",
  }]);
  // Without the souls known, no typo guard at all (as before).
  assert.deepEqual(teamProblems(m, { soulKeys: null }), []);
});

// ---------- lib/launch-preference.mjs ----------

const LAUNCH_ENTRY = (pkg) => packageSoul(pkg, "code-reviewer");
const offeredOf = (keys, packages = {}) => ({ keys, unread: { all: null, bare: null, packages } });

test("launchLayers: a souls.launch key applies through the rename, either direction; the exact key wins when both are present", () => {
  const oldOnly = { souls: { launch: { [`${OLD}/code-reviewer`]: "fast" } } };
  assert.deepEqual(launchLayers({ definition: {}, entry: LAUNCH_ENTRY(NEW), key: `${NEW}/code-reviewer`, local: oldOnly }), {
    declared: null, key: `${NEW}/code-reviewer`, unmatched: [],
    layer: { from: "local", at: "oats-local.yaml#/souls/launch/oats.engineering~1code-reviewer", value: "fast" },
  });
  const newOnly = { souls: { launch: { [`${NEW}/code-reviewer`]: { harness: "claude", model: "opus" } } } };
  assert.deepEqual(launchLayers({ definition: {}, entry: LAUNCH_ENTRY(OLD), key: `${OLD}/code-reviewer`, local: newOnly }), {
    declared: null, key: `${OLD}/code-reviewer`, unmatched: [],
    layer: { from: "local", at: "oats-local.yaml#/souls/launch/oats.engineering-coordination~1code-reviewer", value: { harness: "claude", model: "opus" } },
  });
  const both = { souls: { launch: { [`${OLD}/code-reviewer`]: "old", [`${NEW}/code-reviewer`]: "new", "*": "default" } } };
  assert.equal(launchLayers({ definition: {}, entry: LAUNCH_ENTRY(NEW), key: `${NEW}/code-reviewer`, local: both }).layer.value, "new");
  assert.equal(launchLayers({ definition: {}, entry: LAUNCH_ENTRY(OLD), key: `${OLD}/code-reviewer`, local: both }).layer.value, "old");
  // Another soul of the package falls to "*".
  assert.deepEqual(launchLayers({ definition: {}, entry: packageSoul(NEW, "planner"), key: `${NEW}/planner`, local: both }).layer,
    { from: "local-default", at: "oats-local.yaml#/souls/launch/*", value: "default" });
  // With an offered read: the old key names the offered new-id soul, so nothing is unmatched.
  assert.deepEqual(launchLayers({ definition: {}, entry: LAUNCH_ENTRY(NEW), key: `${NEW}/code-reviewer`, local: oldOnly, offered: offeredOf([`${NEW}/code-reviewer`]) }).unmatched, []);
});

test("launchKeysUnmatched: an old-id key names an offered new-id soul; a typo is still unmatched; an unread new package leaves an old key unchecked", () => {
  const local = { souls: { launch: {
    [`${OLD}/code-reviewer`]: "fast",
    [`${OLD}/code-reviewr`]: "fast",
    [`${NEW}/code-reviewer`]: "slow",
    "*": "default",
  } } };
  assert.deepEqual(launchKeysUnmatched({ local, offered: offeredOf([`${NEW}/code-reviewer`]) }), {
    unmatched: [{ key: `${OLD}/code-reviewr`, at: "oats-local.yaml#/souls/launch/oats.engineering~1code-reviewr", value: "fast", suggestions: [`${NEW}/code-reviewer`] }],
    unchecked: [],
  });
  // The other direction: an old lock offers the old id; a new-id key names it.
  assert.deepEqual(launchKeysUnmatched({ local: { souls: { launch: { [`${NEW}/code-reviewer`]: "x" } } }, offered: offeredOf([`${OLD}/code-reviewer`]) }),
    { unmatched: [], unchecked: [] });
  // The new package is declared and unread: an old-id key under it is unchecked, with that reason.
  assert.deepEqual(launchKeysUnmatched({ local: { souls: { launch: { [`${OLD}/planner`]: "x" } } }, offered: offeredOf([], { [NEW]: "package-unlocked" }) }), {
    unmatched: [],
    unchecked: [{ key: `${OLD}/planner`, at: "oats-local.yaml#/souls/launch/oats.engineering~1planner", value: "x", reason: "package-unlocked" }],
  });
  // Either way round: the old id is declared and unread, and the key spells the new id.
  assert.deepEqual(launchKeysUnmatched({ local: { souls: { launch: { [`${NEW}/planner`]: "x" } } }, offered: offeredOf([], { [OLD]: "package-unlocked" }) }), {
    unmatched: [],
    unchecked: [{ key: `${NEW}/planner`, at: "oats-local.yaml#/souls/launch/oats.engineering-coordination~1planner", value: "x", reason: "package-unlocked" }],
  });
  // An unrelated package's unread state does not cover it.
  assert.deepEqual(launchKeysUnmatched({ local: { souls: { launch: { [`${OLD}/planner`]: "x" } } }, offered: offeredOf([], { "acme.pkg": "package-unlocked" }) }), {
    unmatched: [{ key: `${OLD}/planner`, at: "oats-local.yaml#/souls/launch/oats.engineering~1planner", value: "x", suggestions: [] }],
    unchecked: [],
  });
});

// ---------- lib/instance-resolution.mjs ----------

test("soulNameMatches / homeSoulMatches: either id names a package soul; another package does not", () => {
  const soul = { name: "code-reviewer", package: NEW };
  assert.equal(soulNameMatches(`${OLD}/code-reviewer`, soul), true);
  assert.equal(soulNameMatches(`${NEW}/code-reviewer`, soul), true);
  assert.equal(soulNameMatches("code-reviewer", soul), true);
  assert.equal(soulNameMatches("acme.pkg/code-reviewer", soul), false);
  assert.equal(soulNameMatches(`${OLD}/planner`, soul), false);
  assert.equal(soulNameMatches(`${NEW}/code-reviewer`, { name: "code-reviewer", package: OLD }), true, "an old lock's soul, new spelling");

  const oldHome = { agent: "code-reviewer", workspace: { soul: { name: "code-reviewer", repoKey: PKG_REPO, commit: A, package: { id: OLD, version: "1.18.0" } } } };
  assert.equal(homeSoulMatches(`${NEW}/code-reviewer`, oldHome), true);
  assert.equal(homeSoulMatches(`${OLD}/code-reviewer`, oldHome), true);
  assert.equal(homeSoulMatches("acme.pkg/code-reviewer", oldHome), false);
  const newHome = { agent: "code-reviewer", workspace: { soul: { name: "code-reviewer", repoKey: PKG_REPO, commit: B, package: { id: NEW, version: "2.0.0" } } } };
  assert.equal(homeSoulMatches(`${OLD}/code-reviewer`, newHome), true);
});

test("findSoulEntry: the old id finds the renamed package's soul; the new id and a bare name work as before", () => {
  const discovery = discoveryOf([packageSoul(NEW, "code-reviewer"), packageSoul(NEW, "planner")]);
  for (const name of [`${OLD}/code-reviewer`, `${NEW}/code-reviewer`, "code-reviewer"]) {
    const hit = findSoulEntry(discovery, name);
    assert.equal(hit.qualifiedName, `${NEW}/code-reviewer`, name);
    assert.equal(hit.package, NEW, `${name}: the entry keeps its own id`);
  }
});

test("findSoulEntry: an old lock with both ids — the exactly-spelled id wins, a bare name is ambiguous", () => {
  const discovery = discoveryOf([packageSoul(OLD, "code-reviewer", { commit: A, version: "1.18.0" }), packageSoul(NEW, "code-reviewer")]);
  assert.equal(findSoulEntry(discovery, `${OLD}/code-reviewer`).qualifiedName, `${OLD}/code-reviewer`);
  assert.equal(findSoulEntry(discovery, `${NEW}/code-reviewer`).qualifiedName, `${NEW}/code-reviewer`);
  const r = refusal(() => findSoulEntry(discovery, "code-reviewer"));
  assert.equal(r.code, "E_SOUL_AMBIGUOUS");
  assert.deepEqual(r.details, { name: "code-reviewer", repos: [PKG_REPO, PKG_REPO], qualified: [`${OLD}/code-reviewer`, `${NEW}/code-reviewer`] });
});

test("findSoulEntry: an old-id name with no such soul is E_SOUL_UNKNOWN and names the rename", () => {
  const discovery = discoveryOf([packageSoul(NEW, "code-reviewer")]);
  const r = refusal(() => findSoulEntry(discovery, `${OLD}/nope`));
  assert.equal(r.code, "E_SOUL_UNKNOWN");
  assert.equal(r.message, `no soul "${OLD}/nope" among the confirmed members, external souls or package souls of this workspace (package ${OLD} was renamed to ${NEW}, and no soul "${NEW}/nope" is offered either)`);
  assert.deepEqual(r.details, { name: `${OLD}/nope`, members: [], packages: [NEW] });
  // A new-id or unrelated name carries no rename words.
  const plain = refusal(() => findSoulEntry(discovery, `${NEW}/nope`));
  assert.equal(plain.code, "E_SOUL_UNKNOWN");
  assert.equal(plain.message, `no soul "${NEW}/nope" among the confirmed members, external souls or package souls of this workspace`);
});

test("disabledEntry: an old-id entry disables the renamed soul and is the entry returned; a member soul is not disabled by a package spelling", () => {
  const soul = packageSoul(NEW, "code-reviewer");
  assert.equal(disabledEntry({ souls: { disabled: [`${OLD}/code-reviewer`] } }, soul), `${OLD}/code-reviewer`);
  assert.equal(disabledEntry({ souls: { disabled: [`${NEW}/code-reviewer`] } }, packageSoul(OLD, "code-reviewer")), `${NEW}/code-reviewer`);
  assert.equal(disabledEntry({ souls: { disabled: [`${OLD}/planner`, "acme.pkg/code-reviewer"] } }, soul), null);
  assert.equal(disabledEntry({ souls: { disabled: ["code-reviewer"] } }, soul), "code-reviewer", "a bare name, as before");
  // A member whose name happens to spell the new id: a package-spelled entry with the old id is not its name.
  const memberSoul = { name: "code-reviewer", repoKey: `github.com/acme/${NEW}` };
  assert.equal(disabledEntry({ souls: { disabled: [`${OLD}/code-reviewer`] } }, memberSoul), null);
  assert.equal(disabledEntry({ souls: { disabled: [`${NEW}/code-reviewer`] } }, memberSoul), `${NEW}/code-reviewer`, "its own qualified name, as before");
});

test("renamedSelectorNote: one line only when an old-id selector reached the soul", () => {
  const soul = packageSoul(NEW, "code-reviewer");
  assert.equal(renamedSelectorNote(`${OLD}/code-reviewer`, soul), `package ${OLD} was renamed to ${NEW}: ${OLD}/code-reviewer is ${NEW}/code-reviewer`);
  assert.equal(renamedSelectorNote(`${NEW}/code-reviewer`, soul), null);
  assert.equal(renamedSelectorNote("code-reviewer", soul), null);
  assert.equal(renamedSelectorNote(`${OLD}/code-reviewer`, packageSoul(OLD, "code-reviewer")), null, "an old lock's own soul");
  assert.equal(renamedSelectorNote(`${OLD}/code-reviewer`, { name: "code-reviewer", repoKey: "github.com/acme/oats-engineering" }), null, "a member soul");
  assert.equal(renamedSelectorNote(null, soul), null);
});

// ---------- lib/automations.mjs ----------

test("soulOriginOf: a qualified old-id name finds the origin indexed under the new id; an exact entry still wins", () => {
  const index = soulIndexOf(discoveryOf([packageSoul(NEW, "x")], [member("github.com/acme/tools", ["y"])]), memberNameOf);
  const origin = { kind: "package", package: NEW, version: "2.0.0" };
  assert.deepEqual(soulOriginOf(index, `${OLD}/x`), origin);
  assert.deepEqual(soulOriginOf(index, `${NEW}/x`), origin);
  assert.equal(soulOriginOf(index, `${OLD}/y`), null);
  assert.equal(soulOriginOf(index, "acme.pkg/x"), null);
  const oldLock = soulIndexOf(discoveryOf([packageSoul(OLD, "x", { version: "1.18.0" }), packageSoul(NEW, "x")]), memberNameOf);
  assert.deepEqual(soulOriginOf(oldLock, `${OLD}/x`), { kind: "package", package: OLD, version: "1.18.0" });
});

// ---------- lib/capability-show.mjs ----------

test("selectCapabilityRow: --package with the old id selects the renamed package's row", () => {
  const rows = [
    { name: "review", kind: "package", package: NEW, origin: `package ${NEW}` },
    { name: "review", kind: "member", repoKey: "github.com/acme/tools", origin: "member github.com/acme/tools" },
  ];
  assert.equal(selectCapabilityRow(rows, "review", { package: OLD }), rows[0]);
  assert.equal(selectCapabilityRow(rows, "review", { package: NEW }), rows[0]);
  const r = refusal(() => selectCapabilityRow(rows, "review", { package: "acme.pkg" }));
  assert.equal(r.code, "E_CAPABILITY_UNKNOWN");
  assert.deepEqual(r.details, { name: "review", package: "acme.pkg" });
});

// ---------- lib/drift.mjs ----------

const lockOf = (packages) => ({ lockfileVersion: 3, packages });
const moduleFrom = (pkg, version, commit) => ({ from: { kind: "package", package: pkg, version, commit } });

test("lockedPackageEntry: its own entry, else the new id's; null when neither is locked", () => {
  const entry = { version: "2.0.0", commit: B, capabilities: ["review"] };
  const lock = lockOf({ [NEW]: entry });
  assert.deepEqual(lockedPackageEntry(lock, OLD), { id: NEW, entry });
  assert.deepEqual(lockedPackageEntry(lock, NEW), { id: NEW, entry });
  const oldEntry = { version: "1.18.0", commit: A, capabilities: ["review"] };
  assert.deepEqual(lockedPackageEntry(lockOf({ [OLD]: oldEntry, [NEW]: entry }), OLD), { id: OLD, entry: oldEntry }, "an old id still locked reads its own");
  assert.equal(lockedPackageEntry(lockOf({ [OLD]: oldEntry }), NEW), null, "the new id never reads the old one's entry");
  assert.equal(lockedPackageEntry(lockOf({ "acme.pkg": entry }), OLD), null);
  assert.equal(lockedPackageEntry(lock, "constructor"), null);
  assert.equal(lockedPackageEntry(lock, null), null);
  assert.equal(lockedPackageEntry({}, OLD), null);
  assert.equal(lockedPackageEntry(null, OLD), null);
});

test("driftOf: a module recorded under the old id is moved against the new id's entry; the recorded id stays", () => {
  const meta = { modules: { review: moduleFrom(OLD, "1.18.0", A) } };
  const from = { kind: "package", package: OLD, version: "1.18.0", commit: A };
  const recorded = { repoKey: null, package: OLD, version: "1.18.0", commit: A };
  assert.deepEqual(driftOf(meta, null, { lock: lockOf({ [NEW]: { version: "2.0.0", commit: B, capabilities: ["review"] } }) }),
    [{ module: "review", from, recorded, current: { commit: B, version: "2.0.0" }, status: "moved" }]);
  assert.deepEqual(driftOf(meta, null, { lock: lockOf({ "acme.pkg": { version: "1.0.0", commit: B, capabilities: ["review"] } }) }),
    [{ module: "review", from, recorded, current: null, status: "missing", reason: "package-absent" }], "neither id locked: as before");
  assert.deepEqual(driftOf(meta, null, { lock: lockOf({ [OLD]: { version: "1.18.0", commit: A, capabilities: ["review"] }, [NEW]: { version: "2.0.0", commit: B, capabilities: ["review"] } }) }),
    [{ module: "review", from, recorded, current: { commit: A, version: "1.18.0" }, status: "current" }], "the old id still locked reads its own entry");
  assert.deepEqual(driftOf(meta, null, { lock: lockOf({ [NEW]: { version: "2.0.0", commit: B, capabilities: ["other"] } }) }),
    [{ module: "review", from, recorded, current: { commit: B, version: "2.0.0" }, status: "missing", reason: "capability-absent" }]);
});

test("soulDriftOf: a soul recorded under the old id is compared with the new id's package souls", () => {
  const meta = { agent: "code-reviewer", workspace: { soul: { name: "code-reviewer", repoKey: PKG_REPO, commit: A, package: { id: OLD, version: "1.18.0" } } } };
  const base = { name: "code-reviewer", repoKey: PKG_REPO, commit: A, package: OLD, version: "1.18.0" };
  assert.deepEqual(soulDriftOf(meta, discoveryOf([packageSoul(NEW, "code-reviewer")])), { ...base, current: { commit: B, version: "2.0.0" }, status: "moved" });
  assert.deepEqual(soulDriftOf(meta, discoveryOf([packageSoul(NEW, "planner")])), { ...base, current: null, status: "missing", reason: "soul-absent" });
  assert.deepEqual(soulDriftOf(meta, discoveryOf([packageSoul("acme.pkg", "code-reviewer")])), { ...base, current: null, status: "missing", reason: "package-absent" });
});

// ---------- lib/upgrade-state.mjs ----------

test("packageUpgradeDrift / packageRespawnWarning: a renamed module is not offered as an upgrade and its start names the respawn", () => {
  const meta = { modules: { review: moduleFrom(OLD, "1.18.0", A), tool: moduleFrom("acme.pkg", "1.0.0", C) } };
  const lock = lockOf({ [NEW]: { version: "2.0.0", commit: B, capabilities: ["review"] }, "acme.pkg": { version: "1.1.0", commit: D, capabilities: ["tool"] } });
  assert.deepEqual(packageUpgradeDrift(meta, { lock }), [{ capability: "tool", recorded: { version: "1.0.0", commit: C }, locked: { version: "1.1.0", commit: D } }]);
  assert.equal(packageRespawnWarning(meta, { lock }),
    `1 package module(s) cannot move in place (review: package ${OLD} was renamed to ${NEW}); an upgrade keeps them as they are, so respawn this instance to move it onto the lock`);
});

test("packageRespawnWarning: for every package — gone from the lock, or no longer providing the capability", () => {
  const meta = { modules: { a: moduleFrom("acme.pkg", "1.0.0", C), b: moduleFrom("acme.other", "1.0.0", C), c: moduleFrom(OLD, "1.18.0", A) } };
  const lock = lockOf({ "acme.other": { version: "1.0.0", commit: C, capabilities: ["not-b"] }, [NEW]: { version: "2.0.0", commit: B, capabilities: ["c"] } });
  assert.equal(packageRespawnWarning(meta, { lock }),
    `3 package module(s) cannot move in place (a: package acme.pkg is no longer locked; b: package acme.other no longer provides it; c: package ${OLD} was renamed to ${NEW}); an upgrade keeps them as they are, so respawn this instance to move it onto the lock`);
  assert.deepEqual(packageUpgradeDrift(meta, { lock }), []);
  // A module recorded under the old id whose new package no longer provides it: the line names the id the lock holds.
  const dropped = lockOf({ [NEW]: { version: "2.0.0", commit: B, capabilities: ["other"] } });
  assert.equal(packageRespawnWarning({ modules: { c: moduleFrom(OLD, "1.18.0", A) } }, { lock: dropped }),
    `1 package module(s) cannot move in place (c: package ${NEW} no longer provides it); an upgrade keeps them as they are, so respawn this instance to move it onto the lock`);
});

test("packageRespawnWarning: null when every package module is current or moves in place (the old id still locked included)", () => {
  const meta = { modules: { review: moduleFrom(OLD, "1.18.0", A), tool: moduleFrom("acme.pkg", "1.0.0", C) } };
  const inPlace = lockOf({ [OLD]: { version: "1.19.0", commit: B, capabilities: ["review"] }, "acme.pkg": { version: "1.1.0", commit: D, capabilities: ["tool"] } });
  assert.equal(packageRespawnWarning(meta, { lock: inPlace }), null);
  assert.deepEqual(packageUpgradeDrift(meta, { lock: inPlace }), [
    { capability: "review", recorded: { version: "1.18.0", commit: A }, locked: { version: "1.19.0", commit: B } },
    { capability: "tool", recorded: { version: "1.0.0", commit: C }, locked: { version: "1.1.0", commit: D } },
  ]);
  const current = lockOf({ [OLD]: { version: "1.18.0", commit: A, capabilities: ["review"] }, "acme.pkg": { version: "1.0.0", commit: C, capabilities: ["tool"] } });
  assert.equal(packageRespawnWarning(meta, { lock: current }), null);
  assert.equal(packageRespawnWarning(meta, {}), null, "no lock: every package module is current");
  // A renamed module whose new id's entry is at the recorded commit is current, not a respawn.
  assert.equal(packageRespawnWarning({ modules: { review: moduleFrom(OLD, "1.18.0", A) } }, { lock: lockOf({ [NEW]: { version: "2.0.0", commit: A, capabilities: ["review"] } }) }), null);
});

// ---------- lib/packages.mjs ----------

/** A remote that records every call and answers none: a refusal before it is read leaves `calls` empty. */
function recordingRemote() {
  const calls = [];
  const refuse = (name) => async (...args) => { calls.push([name, ...args]); const e = new Error(`${name} must not be called`); e.code = "E_TEST_REMOTE_CALLED"; throw e; };
  return { calls, remote: { observeRemote: refuse("observeRemote"), readRemoteFile: refuse("readRemoteFile"), listRemoteTree: refuse("listRemoteTree") } };
}

test("resolvePackages: both ids declared is refused before any remote read, naming the id to keep", async () => {
  const { calls, remote } = recordingRemote();
  await assert.rejects(resolvePackages({ packages: { [OLD]: "v1.18.0", [NEW]: "v2.0.0" } }, { remote }), (e) => {
    assert.equal(e.code, "E_WORKSPACE_SCHEMA");
    assert.deepEqual(e.details, { path: `/packages/${OLD}`, reason: "package-declared-twice", ids: [OLD, NEW], keep: NEW });
    assert.equal(e.message, `packages: declares ${OLD} and ${NEW}, which are one package (${OLD} was renamed to ${NEW}): keep ${NEW} and remove ${OLD}, then run \`oats sync\` again`);
    return true;
  });
  assert.deepEqual(calls, []);
  // Declared in the other order, the same answer.
  await assert.rejects(resolvePackages({ packages: { [NEW]: "v2.0.0", [OLD]: "v1.18.0" } }, { remote }), (e) => e.details?.reason === "package-declared-twice");
  assert.deepEqual(calls, []);
});

test("resolvePackages: either id alone is not that refusal", async () => {
  for (const id of [OLD, NEW]) {
    const { remote } = recordingRemote();
    // With no catalog a bare version fails on its own terms (E_PACKAGE_MISSING), before the remote.
    await assert.rejects(resolvePackages({ packages: { [id]: "v2.0.0" } }, { remote }), (e) => {
      assert.equal(e.code, "E_PACKAGE_MISSING", `${id}: ${e.message}`);
      assert.notEqual(e.details?.reason, "package-declared-twice");
      return true;
    });
    // A git value reaches the remote: the refusal is the remote's, not the rename's.
    const rec = recordingRemote();
    await assert.rejects(resolvePackages({ packages: { [id]: `git:${PKG_REPO}@v2.0.0` } }, { remote: rec.remote }), (e) => e.code === "E_TEST_REMOTE_CALLED");
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0][0], "observeRemote");
  }
});
