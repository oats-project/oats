// The Teams board's "Default for" / "May join" (packages/desktop/renderer/computer-teams.mjs teamAudience)
// are derived in the renderer from the committed souls: map; the kernel is the authority on a soul's teams
// (lib/teams.mjs soulTeams). This pins the one to the other: for each fixture, the kernel builds the
// `oats teams --json` document (teamsDocument), the Desktop decodes it as its route does (teamsData) and
// states each team's audience; then every concrete soul the fixture implies is resolved by the kernel, and
// for every label:
//   - the label is the soul's kernel default  <=>  the audience puts the soul in Default for;
//   - the soul may join the label through its souls: entry or as a local team (kernel `via` workspace or
//     local), and the label is not its own souls: default  <=>  the audience puts the soul in May join.
// The deployment's or workspace's fallback default is its own Default for row, and does not take a soul out
// of May join: lab-agents' souls default to lab-all through the fallback, and their `any` also lists it.
// A kernel change to resolution breaks this test, not the UI. In process: no CLI, nothing written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { soulTeams, teamModel } from "../lib/teams.mjs";
import { teamsDocument } from "../lib/teams-verbs.mjs";
import { teamsData } from "../packages/client/deployment-data.mjs";
import { teamAudience } from "../packages/desktop/renderer/computer-teams.mjs";

const DEP = "/fixture/deployment";
const ids = (...labels) => Object.fromEntries(labels.map((label) => [label, { team: `${label}:acme.aweb.ai` }]));

const FIXTURES = {
  // The lab rig: three member repos, local teams closed, the workspace's default lab-all.
  lab: { workspace: { teams: ids("lab-ai-team", "lab-all", "lab-platform-team"), defaultTeam: "lab-all", souls: {
    "*": { teams: [] }, "lab-ai-engineering/*": { default: "lab-ai-team", teams: ["lab-all"] },
    "lab-ai-engineering/ai-reviewer": { default: "lab-ai-team", teams: ["lab-all", "lab-platform-team"] },
    "lab-platform/*": { default: "lab-platform-team", teams: ["lab-all"] }, "lab-agents/*": { teams: "any" } } } },
  // The solo rig: local teams open, this deployment's own default (mine) replaces the workspace's (engineering).
  solo: { workspace: { teams: { ...ids("engineering"), docs: {} }, defaultTeam: "engineering", localTeams: true,
    souls: { "*": { teams: ["engineering"] }, "acme-agents/writer": { default: "docs", teams: ["engineering"] } } },
  local: { teams: ids("mine", "pairing"), defaultTeam: "mine" } },
  // `any`, a <p>/* default with <p>/<s> exceptions (another default; no teams), a soul key under a teams-only pattern.
  exceptions: { workspace: { teams: ids("a", "b", "c"), defaultTeam: "c", souls: {
    "*": { teams: "any" }, "p/*": { default: "a", teams: ["b"] }, "p/x": { default: "b" }, "p/y": { teams: [] },
    "q/*": { teams: ["c"] }, "q/z": { default: "c", teams: "any" } } } },
  // A "*" that sets a default (no soul falls back), implied entries at every level, a soul with another default.
  starDefault: { workspace: { teams: ids("a", "b"), defaultTeam: "b", souls: {
    "*": { default: "a" }, "p/*": { default: "a" }, "p/x": { default: "a", teams: ["a"] }, "q/y": { default: "b" } } } },
  // "*" may join a, a repo whose default is a (its souls are said under Default for), one soul re-included.
  joinOverDefault: { workspace: { teams: ids("a", "b"), souls: {
    "*": { teams: ["a"] }, "p/*": { default: "a" }, "p/x": { teams: [] }, "p/y": { default: "b", teams: ["a"] } } } },
  // A package's souls, `any` on a package, and local teams open beside the workspace's default.
  packages: { workspace: { teams: ids("s", "t"), defaultTeam: "t", localTeams: true, souls: {
    "oats.okf/*": { default: "s", teams: "any" }, "oats.okf/curator": { teams: ["t"] } } }, local: { teams: ids("l") } },
  // No souls: at all: every soul has the default only.
  empty: { workspace: { teams: ids("a", "b"), defaultTeam: "a", souls: {} } },
  // The standalone view (no workspace file): this deployment's local teams and default.
  standalone: { workspace: null, local: { teams: ids("mine", "spare"), defaultTeam: "mine" } },
};

/** The concrete soul keys a fixture implies: each named soul, one more soul of every repo or package a key
 *  names, and one soul of a repository no key names (matched only by "*"). */
function soulKeysOf(souls) {
  const keys = new Set(["unlisted-repo/lone"]);
  for (const key of Object.keys(souls)) {
    if (key === "*") continue;
    const at = key.lastIndexOf("/"), repo = key.slice(0, at);
    keys.add(`${repo}/another-soul`);
    if (key.slice(at + 1) !== "*") keys.add(key);
  }
  return [...keys];
}

/** Does an audience entry name the soul `key` (`<repo>/<soul>`), its exceptions taken out? */
function names(entry, key) {
  const repo = key.slice(0, key.lastIndexOf("/"));
  const hit = (e) => e.kind === "every" || e.kind === "local" || (e.kind === "repo" && e.repo === repo) || (e.kind === "soul" && e.key === key);
  return hit(entry) && !(entry.except ?? []).some(hit);
}

for (const [name, { workspace, local = null }] of Object.entries(FIXTURES)) {
  test(`teamAudience agrees with the kernel's soulTeams: ${name}`, () => {
    const document = teamsData({ schemaVersion: 1, ok: true, result: teamsDocument({ deployment: DEP, workspace, local, workspaceKey: null, soulKeys: null }) }, DEP);
    const model = teamModel(workspace, local);
    const keys = soulKeysOf(model.souls);
    assert.ok(keys.some((k) => !Object.keys(model.souls).some((p) => p === k || p === `${k.slice(0, k.lastIndexOf("/"))}/*`)), "one soul is matched by \"*\" (or nothing) only");
    const kernel = new Map(keys.map((key) => [key, soulTeams(model, key)]));
    for (const { label } of document.teams) {
      const { defaultFor, mayJoin } = teamAudience(document, label);
      const fallback = defaultFor.find((e) => e.kind === "fallback");
      for (const [key, soul] of kernel) {
        const kernelDefault = soul.defaultTeam?.label === label;
        const row = soul.teams.find((t) => t.label === label);
        const ownDefault = kernelDefault && soul.defaultTeam.from === "soul";
        const kernelJoins = !ownDefault && !!row && row.via.some((v) => v === "workspace" || v === "local");
        // Default for: a named entry, or the fallback for a soul whose default does not come from souls:.
        const saysDefault = defaultFor.some((e) => e.kind !== "fallback" && names(e, key)) || (!!fallback && !fallback.nobody && soul.defaultTeam?.from !== "soul");
        const saysJoin = mayJoin.some((e) => names(e, key));
        const at = `${name}: ${key} / ${label} (kernel default ${soul.defaultTeam?.label ?? "none"} from ${soul.defaultTeam?.from ?? "-"}, teams ${soul.teams.map((t) => t.label).join(",") || "none"})`;
        assert.equal(saysDefault, kernelDefault, `Default for: ${at}`);
        assert.equal(saysJoin, kernelJoins, `May join: ${at}`);
      }
      // A quiet fallback ("every soul has its own default") is true of every soul here.
      if (fallback?.nobody) for (const [key, soul] of kernel) assert.equal(soul.defaultTeam?.from, "soul", `${name}: ${key} has its own default`);
    }
  });
}
