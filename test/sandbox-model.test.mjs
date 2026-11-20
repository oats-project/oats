// Sandboxes, the files (docs/design/2026-11-19-sandboxes.md C1, C2, C3, C3b; S1 Acceptance 1–3): the
// workspace's `sandboxes:` block, the rules that keep a sandboxed team a soul's own default, and the
// local keys that list sandboxes, give credentials or say a deployment runs inside one. Each refusal is
// E_WORKSPACE_SCHEMA with its reason, at its path; every comparison between teams is by provider id
// (two labels of one id are one team), or by label while a team has no id.
import test from "node:test";
import assert from "node:assert/strict";
import { validateLocal, validateWorkspace } from "../lib/workspace.mjs";
import { crossSandboxProblems, placementOf, SANDBOX_NAME_RE } from "../lib/sandbox-model.mjs";
import { KERNEL_FEATURES } from "../lib/kernel-features.mjs";
import { soulTeams, teamModel } from "../lib/teams.mjs";

const ID = "ingest:example.org";
/** A valid workspace with sandbox `ingest` for team `ingest-team`, `extra` merged over it. */
const ws = (extra = {}) => ({
  schemaVersion: 2, name: "acme", members: ["git:github.com/acme/agents"],
  teams: { global: {}, "ingest-team": { team: ID }, ...(extra.teams || {}) },
  sandboxes: { ingest: { team: "ingest-team" }, ...(extra.sandboxes || {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "teams" && k !== "sandboxes")),
});
const reasons = (problems) => problems.map((p) => p.reason).filter(Boolean);
const at = (problems, reason) => problems.filter((p) => p.reason === reason).map((p) => p.path);

test("C1: a sandbox's name is 1 to 32 lowercase letters, digits and inner hyphens", () => {
  for (const name of ["a", "ab", "a-b", "a".repeat(32)]) {
    assert.ok(SANDBOX_NAME_RE.test(name), name);
    assert.deepEqual(validateWorkspace(ws({ sandboxes: { [name]: { team: "global" } } })).filter((p) => p.path.startsWith("/sandboxes")), [], name);
  }
  for (const name of ["-a", "a-", "a".repeat(33), "A", "a_b", ""]) {
    assert.equal(SANDBOX_NAME_RE.test(name), false, name);
    assert.ok(validateWorkspace(ws({ sandboxes: { [name]: { team: "global" } } })).some((p) => p.path.startsWith("/sandboxes")), `refused: ${JSON.stringify(name)}`);
  }
});

test("C1: egress is a closed set, forge only with its feature; duplicates are refused; both lists default to []", () => {
  assert.deepEqual(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", egress: ["model", "source", "forge"] } } })), []);
  assert.ok(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", egress: ["ssh"] } } })).some((p) => p.path === "/sandboxes/ingest/egress/0"));
  const withoutForge = KERNEL_FEATURES.filter((f) => f !== "sandbox-egress-forge");
  assert.ok(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", egress: ["forge"] } } }), { features: withoutForge }).some((p) => p.path === "/sandboxes/ingest/egress/0"), "forge needs feature sandbox-egress-forge");
  assert.deepEqual(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", egress: ["model"] } } }), { features: withoutForge }), []);
  assert.deepEqual(at(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", egress: ["model", "model"] } } })), "duplicate-entry"), ["/sandboxes/ingest/egress/1"]);
  assert.deepEqual(at(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", credentials: ["gh", "gh"] } } })), "duplicate-entry"), ["/sandboxes/ingest/credentials/1"]);
  assert.ok(validateWorkspace(ws({ sandboxes: { ingest: { team: "ingest-team", credentials: ["Bad_Name"] } } })).some((p) => p.path === "/sandboxes/ingest/credentials/0"));
  // Defaults: a sandbox with neither list is valid, and is read as [] for both.
  assert.deepEqual(validateWorkspace(ws()), []);
});

test("C1: a kernel without feature sandboxes refuses the key, with the upgrade hint", () => {
  const problems = validateWorkspace(ws(), { features: KERNEL_FEATURES.filter((f) => f !== "sandboxes" && f !== "sandbox-egress-forge") });
  const p = problems.find((x) => x.path === "/sandboxes" || x.path === "");
  assert.ok(p, JSON.stringify(problems));
  assert.match(p.message, /upgrade OATS/i, p.message);
});

test("C2: sandbox-team-taken — a second sandbox naming the same team, by label or by another label of its id", () => {
  assert.deepEqual(at(validateWorkspace(ws({ sandboxes: { other: { team: "ingest-team" } } })), "sandbox-team-taken"), ["/sandboxes/other/team"]);
  const alias = ws({ teams: { "ingest-alias": { team: ID } } });
  delete alias.sandboxes.other;
  const problems = validateWorkspace({ ...alias, sandboxes: { ingest: { team: "ingest-team" }, other: { team: "ingest-alias" } } });
  assert.ok(reasons(problems).includes("sandbox-team-taken"), JSON.stringify(problems));
});

test("C2: sandboxed-team-alias — another shared label of the sandboxed team's id", () => {
  const problems = validateWorkspace(ws({ teams: { "ingest-alias": { team: ID } } }));
  assert.deepEqual(at(problems, "sandboxed-team-alias"), ["/teams/ingest-alias"]);
});

test("C2: sandboxed-team-by-wildcard — the workspace default team, or a pattern's default, is a sandboxed team (by label or id)", () => {
  assert.deepEqual(at(validateWorkspace(ws({ defaultTeam: "ingest-team" })), "sandboxed-team-by-wildcard"), ["/defaultTeam"]);
  assert.deepEqual(at(validateWorkspace(ws({ souls: { "*": { default: "ingest-team" } } })), "sandboxed-team-by-wildcard"), ["/souls/*/default"]);
  assert.deepEqual(at(validateWorkspace(ws({ souls: { "agents/*": { default: "ingest-team" } } })), "sandboxed-team-by-wildcard"), ["/souls/agents~1*/default"]);
  // A soul's own default is the one way into a sandbox.
  assert.deepEqual(validateWorkspace(ws({ souls: { "agents/ingester": { default: "ingest-team" } } })), []);
  // By its provider id: another label of the same id is the sandboxed team too.
  const alias = { teams: { "ingest-alias": { team: ID } } };
  assert.deepEqual(at(validateWorkspace(ws({ ...alias, defaultTeam: "ingest-alias" })), "sandboxed-team-by-wildcard"), ["/defaultTeam"]);
  assert.deepEqual(at(validateWorkspace(ws({ ...alias, souls: { "*": { default: "ingest-alias" } } })), "sandboxed-team-by-wildcard"), ["/souls/*/default"]);
});

test("C2: sandboxed-team-not-default — a soul's teams list names a sandboxed team; \"any\" never includes it", () => {
  assert.deepEqual(at(validateWorkspace(ws({ souls: { "agents/dev": { teams: ["global", "ingest-team"] } } })), "sandboxed-team-not-default"), ["/souls/agents~1dev/teams/1"]);
  // By its provider id: another label of the same id is the sandboxed team too.
  assert.deepEqual(at(validateWorkspace(ws({ teams: { "ingest-alias": { team: ID } }, souls: { "agents/dev": { teams: ["global", "ingest-alias"] } } })), "sandboxed-team-not-default"), ["/souls/agents~1dev/teams/1"]);
  const workspace = ws({ souls: { "agents/dev": { teams: "any" } } });
  assert.deepEqual(validateWorkspace(workspace), []);
  const model = teamModel(workspace, {});
  const { teams } = soulTeams(model, "agents/dev");
  assert.deepEqual(teams.map((t) => t.label), ["global"], `"any" leaves the sandboxed team out`);
});

test("C2: sandboxed-team-local — a local team naming the sandboxed team, by label or by its provider id", () => {
  const workspace = ws({ localTeams: true });
  assert.deepEqual(at(crossSandboxProblems(workspace, { teams: { "ingest-team": { team: "other:example.org" } } }), "sandboxed-team-local"), ["/teams/ingest-team"]);
  assert.deepEqual(at(crossSandboxProblems(workspace, { teams: { mine: { team: ID } } }), "sandboxed-team-local"), ["/teams/mine"]);
});

test("D-S1-2: a local defaultTeam naming the sandboxed label is sandboxed-team-local at /defaultTeam", () => {
  const p = crossSandboxProblems(ws({ localTeams: true }), { defaultTeam: "ingest-team" });
  assert.deepEqual(at(p, "sandboxed-team-local"), ["/defaultTeam"]);
});

test("D-S1-2: a local defaultTeam naming its provider id under another local label is sandboxed-team-local, naming the id", () => {
  const p = crossSandboxProblems(ws({ localTeams: true }), { teams: { mine: { team: ID } }, defaultTeam: "mine" });
  const found = p.filter((x) => x.reason === "sandboxed-team-local" && x.path === "/defaultTeam");
  assert.equal(found.length, 1, JSON.stringify(p));
  assert.match(found[0].message, new RegExp(ID.replace(/[.]/g, "\\.")));
});

test("C3: sandbox-unknown, duplicate-entry and sandbox-host-name-required", () => {
  assert.deepEqual(at(crossSandboxProblems(ws(), { host: { name: "h" }, sandboxes: ["ingest", "nope"] }), "sandbox-unknown"), ["/sandboxes/1"]);
  assert.deepEqual(at(crossSandboxProblems(ws(), { sandbox: { self: "nope" } }), "sandbox-unknown"), ["/sandbox/self"]);
  const local = (keys) => ({ schemaVersion: 2, workspace: "git:github.com/acme/ws", ...keys });
  assert.deepEqual(at(validateLocal(local({ host: { name: "h" }, sandboxes: ["ingest", "ingest"] })), "duplicate-entry"), ["/sandboxes/1"]);
  assert.deepEqual(at(validateLocal(local({ sandboxes: ["ingest"] })), "sandbox-host-name-required"), ["/sandboxes"]);
  assert.deepEqual(validateLocal(local({ host: { name: "h" }, sandboxes: ["ingest"], credentials: { gh: { fromFile: "/srv/gh" } } })), []);
  assert.ok(validateLocal(local({ host: { name: "h" }, credentials: { gh: { fromFile: "relative/gh" } } })).some((p) => p.path.startsWith("/credentials/gh")), "a credential's fromFile is absolute");
});

test("C3b: sandbox-self-conflict with each of sandboxes, credentials, local teams and a local defaultTeam", () => {
  const local = (keys) => ({ schemaVersion: 2, workspace: "git:github.com/acme/ws", host: { name: "h" }, sandbox: { self: "ingest" }, ...keys });
  for (const [key, value] of [["sandboxes", ["ingest"]], ["credentials", { gh: { fromFile: "/srv/gh" } }], ["teams", { mine: { team: "x:y" } }], ["defaultTeam", "global"]]) {
    assert.deepEqual(at(validateLocal(local({ [key]: value })), "sandbox-self-conflict"), [`/${key}`], key);
  }
  assert.deepEqual(validateLocal(local({})), []);
});

test("Placement: a soul whose default team is a sandbox's team runs in it (by id, else by label); any other soul runs on the host", () => {
  const workspace = ws();
  assert.equal(placementOf(workspace, { label: "ingest-team", team: ID }), "ingest");
  assert.equal(placementOf(workspace, { label: "renamed-locally", team: ID }), "ingest", "by provider id");
  assert.equal(placementOf(workspace, { label: "global", team: null }), null);
  const uncreated = ws({ teams: { "ingest-team": {} } });
  assert.equal(placementOf(uncreated, { label: "ingest-team", team: null }), "ingest", "by label while the team has no id");
});
