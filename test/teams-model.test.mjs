// Team model 3 (docs/design/2026-10-02-team-model-3.md, awebai/oats#484), the kernel's pure half
// (lib/teams.mjs): the committed SHARED teams, the workspace's `defaultTeam`, `localTeams` and `souls:`
// patterns, and the deployment's LOCAL teams and default when the workspace allows them — as the rows
// the reports, OATS_TEAMS and instance.json carry.
import test from "node:test";
import assert from "node:assert/strict";
import { soulTeams, teamKeyOf, teamModel, teamProblems, teamReferences, teamsEnv } from "../lib/teams.mjs";

const SHARED = { engineering: { team: "engineering:acme.aweb.ai" }, security: { team: "security:acme.aweb.ai" }, docs: { description: "not created yet" } };
const ws = (extra = {}) => ({ schemaVersion: 2, name: "acme", teams: SHARED, ...extra });
const model = (workspace, local = null) => teamModel(workspace, local, { workspaceKey: "github.com/acme/agents" });
const code = (fn) => { try { fn(); } catch (e) { return [e.code, e.details]; } assert.fail("expected a refusal"); };
const ENG = { label: "engineering", team: "engineering:acme.aweb.ai", from: "shared" };
const SEC = { label: "security", team: "security:acme.aweb.ai", from: "shared" };
const DOCS = { label: "docs", team: null, from: "shared" };
const MINE = { label: "mine", team: "mine:me.aweb.ai", from: "local" };
const row = (t, isDefault, via) => ({ label: t.label, team: t.team, default: isDefault, from: t.from, via });

const PATTERNS = {
  "*": { teams: [] },
  "security-souls/*": { default: "security", teams: ["engineering"] },
  "security-souls/incident-responder": { teams: ["engineering", "docs"] },
  "oats.engineering/*": { teams: "any" },
};

test("a soul's key is its qualified name: <package>/<soul>, or <member>/<soul> (the member's repo name)", () => {
  assert.equal(teamKeyOf({ name: "dev", repoKey: "github.com/acme/security-souls" }), "security-souls/dev");
  assert.equal(teamKeyOf({ name: "dev", repoKey: "local//srv/repos/Tools.git" }), "Tools/dev");
  assert.equal(teamKeyOf({ name: "harvester", package: "oats.okf", qualifiedName: "oats.okf/harvester", repoKey: "github.com/awebai/oats-okf" }), "oats.okf/harvester");
});

test("the most specific souls: key wins outright for teams; the default comes from the most specific key that sets one", () => {
  const m = model(ws({ defaultTeam: "engineering", souls: PATTERNS }));
  // The soul's own key: its teams only (no merging with security-souls/*), its default from security-souls/*.
  assert.deepEqual(soulTeams(m, "security-souls/incident-responder"), {
    key: "security-souls/incident-responder", match: "security-souls/incident-responder", defaultMatch: "security-souls/*",
    defaultTeam: { label: "security", team: "security:acme.aweb.ai", from: "soul" },
    teams: [row(SEC, true, ["default"]), row(DOCS, false, ["workspace"]), row(ENG, false, ["workspace"])],
  });
  assert.deepEqual(soulTeams(m, "security-souls/scanner").teams, [row(SEC, true, ["default"]), row(ENG, false, ["workspace"])]);
  // `any`: every shared team, unmapped included.
  assert.deepEqual(soulTeams(m, "oats.engineering/dev"), {
    key: "oats.engineering/dev", match: "oats.engineering/*", defaultMatch: null,
    defaultTeam: { label: "engineering", team: "engineering:acme.aweb.ai", from: "workspace" },
    teams: [row(ENG, true, ["default", "workspace"]), row(DOCS, false, ["workspace"]), row(SEC, false, ["workspace"])],
  });
  // "*": unlisted souls.
  assert.deepEqual(soulTeams(m, "platform/dev"), { key: "platform/dev", match: "*", defaultMatch: null,
    defaultTeam: { label: "engineering", team: "engineering:acme.aweb.ai", from: "workspace" }, teams: [row(ENG, true, ["default"])] });
  assert.deepEqual(soulTeams(m, "*").match, "*");
});

test("a soul no key matches, with no \"*\" entry, gets its default only, member and package souls alike", () => {
  const m = model(ws({ defaultTeam: "engineering", souls: { "security-souls/*": { teams: "any" } } }));
  for (const key of ["platform/dev", "oats.okf/harvester"]) {
    assert.deepEqual(soulTeams(m, key), { key, match: null, defaultMatch: null, defaultTeam: { ...ENG, from: "workspace" }, teams: [row(ENG, true, ["default"])] });
  }
  assert.deepEqual(soulTeams(model(ws()), "platform/dev"), { key: "platform/dev", match: null, defaultMatch: null, defaultTeam: null, teams: [] });
});

test("the default, in order: the soul's souls: default; the deployment's, only with localTeams: true; the workspace's; none", () => {
  const local = { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" };
  const souls = { "security-souls/*": { default: "security" } };
  const def = (workspace, l, key = "security-souls/dev") => soulTeams(model(workspace, l), key).defaultTeam;
  // 1. the soul's own, whatever else is set.
  assert.deepEqual(def(ws({ localTeams: true, defaultTeam: "engineering", souls }), local), { ...SEC, from: "soul" });
  // 2. the deployment's, only when the workspace allows local teams.
  assert.deepEqual(def(ws({ localTeams: true, defaultTeam: "engineering" }), local, "platform/dev"), { ...MINE, from: "deployment" });
  assert.deepEqual(def(ws({ localTeams: true, defaultTeam: "engineering" }), { defaultTeam: "security" }, "platform/dev"), { ...SEC, from: "deployment" }, "a local default may name a shared team");
  // 3. the workspace's.
  assert.deepEqual(def(ws({ localTeams: true, defaultTeam: "engineering" }), null, "platform/dev"), { ...ENG, from: "workspace" });
  assert.deepEqual(def(ws({ defaultTeam: "engineering" }), null, "platform/dev"), { ...ENG, from: "workspace" });
  // 4. none.
  assert.equal(def(ws({ localTeams: true }), null, "platform/dev"), null);
  assert.equal(def(ws(), null, "platform/dev"), null);
});

test("with localTeams: true, every local team is eligible for any soul; a local default no file declares is E_TEAM_UNKNOWN", () => {
  const local = { teams: { mine: { team: "mine:me.aweb.ai" }, night: { team: "night:me.aweb.ai" } } };
  const m = model(ws({ localTeams: true, defaultTeam: "engineering", souls: { "*": { teams: ["security"] } } }), local);
  assert.deepEqual(soulTeams(m, "platform/dev").teams, [row(ENG, true, ["default"]), row(MINE, false, ["local"]),
    row({ label: "night", team: "night:me.aweb.ai", from: "local" }, false, ["local"]), row(SEC, false, ["workspace"])]);
  // A local default that is a local team: eligible as both.
  assert.deepEqual(soulTeams(model(ws({ localTeams: true }), { ...local, defaultTeam: "mine" }), "platform/dev").teams[0], row(MINE, true, ["default", "local"]));
  assert.deepEqual(code(() => soulTeams(model(ws({ localTeams: true }), { defaultTeam: "ghost" }), "platform/dev")), ["E_TEAM_UNKNOWN", { label: "ghost", at: "oats-local.yaml#/defaultTeam" }]);
});

test("without localTeams: true, local teams and a local defaultTeam are refused (E_WORKSPACE_SCHEMA local-teams-closed), naming both fixes", () => {
  const FIX = "either (a) add `localTeams: true` to oats-workspace.yaml, or (b) commit the teams and defaultTeam in oats-workspace.yaml, then remove them from oats-local.yaml";
  for (const workspace of [ws(), ws({ localTeams: false })]) {
    const [c, details] = code(() => soulTeams(model(workspace, { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }), "platform/dev"));
    assert.deepEqual([c, details], ["E_WORKSPACE_SCHEMA", { reason: "local-teams-closed", path: "oats-local.yaml", keys: ["teams", "defaultTeam"] }]);
  }
  let message;
  try { soulTeams(model(ws(), { defaultTeam: "engineering" }), "platform/dev"); } catch (e) { message = e.message; }
  assert.equal(message, `oats-local.yaml declares defaultTeam, but oats-workspace.yaml does not allow local teams (localTeams: true): ${FIX}`);
  // As a problem (oats teams, readiness): a failure with the same facts.
  assert.deepEqual(teamProblems(model(ws(), { defaultTeam: "engineering" })), [{ code: "E_WORKSPACE_SCHEMA", severity: "failure", condition: "local-teams-closed",
    path: "oats-local.yaml", keys: ["defaultTeam"], message, fix: FIX }]);
  assert.deepEqual(teamProblems(model(ws(), { defaultTeam: "engineering" }), { key: "platform/dev" }).map((p) => p.condition), ["local-teams-closed"]);
});

test("the standalone view (no workspace file) has no workspace rules: local teams and the local default apply", () => {
  const m = model(null, { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" });
  assert.deepEqual(soulTeams(m, "tools/dev"), { key: "tools/dev", match: null, defaultMatch: null, defaultTeam: { ...MINE, from: "deployment" }, teams: [row(MINE, true, ["default", "local"])] });
  assert.deepEqual(teamProblems(m), []);
  assert.deepEqual(soulTeams(teamModel(null, null), "tools/dev"), { key: "tools/dev", match: null, defaultMatch: null, defaultTeam: null, teams: [] });
});

test("a label in BOTH files (only possible with localTeams: true): the committed definition wins, a warning", () => {
  const m = model(ws({ localTeams: true }), { teams: { engineering: { team: "engineering:mine.aweb.ai", description: "mine" } }, defaultTeam: "engineering" });
  assert.deepEqual(soulTeams(m, "platform/dev").teams, [row(ENG, true, ["default", "local"])], "the deployment declares it too");
  assert.deepEqual(teamProblems(m).find((p) => p.code === "team-label-collision"), {
    code: "team-label-collision", label: "engineering", severity: "warning",
    shared: { team: "engineering:acme.aweb.ai", description: null, at: "github.com/acme/agents:oats-workspace.yaml#/teams/engineering" },
    local: { team: "engineering:mine.aweb.ai", description: "mine", at: "oats-local.yaml#/teams/engineering" },
    message: "team engineering is declared in both oats-workspace.yaml (shared) and oats-local.yaml (local); the shared definition wins",
    fix: "rename the local label in oats-local.yaml",
  });
});

test("the deployment's problems: unmapped shared teams (blocking when the default), an unknown local default, no default with messaging", () => {
  assert.deepEqual(teamProblems(model(ws({ defaultTeam: "docs" })), { messaging: true }).map((p) => [p.code, p.label ?? null, p.severity, p.default ?? null]), [
    ["team-unmapped", "docs", "failure", true],
  ]);
  assert.deepEqual(teamProblems(model(ws({ localTeams: true }), { defaultTeam: "ghost" }), { messaging: true }).map((p) => [p.code, p.label ?? null, p.severity]), [
    ["E_TEAM_UNKNOWN", "ghost", "failure"], ["team-unmapped", "docs", "warning"],
  ], "a default is configured, so not E_TEAM_UNCONFIGURED");
  assert.deepEqual(teamProblems(model(ws()), { messaging: true }).map((p) => [p.code, p.severity]), [["team-unmapped", "warning"], ["E_TEAM_UNCONFIGURED", "failure"]]);
  assert.equal(teamProblems(model(ws()), { messaging: false }).some((p) => p.code === "E_TEAM_UNCONFIGURED"), false, "no messaging layer: no default is fine");
});

test("a soul's problems: only what concerns it; `default` marks ITS default", () => {
  const m = model(ws({ defaultTeam: "engineering", souls: { "a/dev": { teams: ["docs"] } } }));
  assert.deepEqual(teamProblems(m, { key: "a/dev" }).map((p) => [p.code, p.label, p.default]), [["team-unmapped", "docs", false]]);
  assert.deepEqual(teamProblems(m, { key: "a/other" }), [], "a soul that may not join docs is not told about it");
  assert.deepEqual(teamProblems(model(ws({ souls: { "a/*": { default: "docs" } } })), { key: "a/dev", messaging: true }).map((p) => [p.code, p.default]), [["team-unmapped", true]]);
});

test("team-soul-unknown: a souls: key that is no discovered soul, or a <prefix>/* pattern that matches none, warns; \"*\" never does", () => {
  const SOULS = new Set(["platform/dev", "oats.engineering/code-reviewer"]);
  const unknownOf = (m, opts) => teamProblems(m, opts).filter((p) => p.code === "team-soul-unknown");
  const keysOf = (souls) => unknownOf(model(ws({ souls })), { soulKeys: SOULS }).map((p) => p.key);
  const at = (key) => `github.com/acme/agents:oats-workspace.yaml#/souls/${key.replace(/\//g, "~1")}`;
  const exact = (key) => ({ code: "team-soul-unknown", severity: "warning", key, at: at(key),
    message: `souls: ${key} names no soul of this workspace (a pattern is "*" or <member|package>/*)`, fix: "correct the key to a soul's qualified name (oats souls lists them), or remove it" });
  const pattern = (key) => ({ code: "team-soul-unknown", severity: "warning", key, at: at(key),
    message: `souls: ${key} is a pattern that matches no soul of this workspace`, fix: "correct the prefix to a member's or package's name (oats souls lists them), or remove the key" });
  // A typo'd (or renamed, or dropped) prefix: the same code and fields as an exact key; exact keys keep their text.
  assert.deepEqual(unknownOf(model(ws({ souls: { "platfrom/*": {}, "platfrom/dev": {} } })), { soulKeys: SOULS }), [pattern("platfrom/*"), exact("platfrom/dev")]);
  // A pattern that matches at least one discovered soul, and "*", are silent.
  assert.deepEqual(keysOf({ "*": {}, "platform/*": {}, "oats.engineering/*": { teams: "any" }, "platform/dev": {} }), []);
  // The slash is compared: a prefix of another name matches none of its souls.
  assert.deepEqual(keysOf({ "oats.eng/*": {}, "plat/*": {} }), ["oats.eng/*", "plat/*"]);
  // A prefix with a slash, or an empty one, matches no soul key.
  assert.deepEqual(keysOf({ "platform/dev/*": {}, "/*": {} }), ["/*", "platform/dev/*"]);
  // An unconfirmed member has no discovered souls: its pattern warns, as its exact keys do.
  assert.deepEqual(keysOf({ "unconfirmed/*": {}, "unconfirmed/dev": {} }), ["unconfirmed/*", "unconfirmed/dev"]);
  // Souls not known (soulKeys null): no key warns.
  assert.deepEqual(unknownOf(model(ws({ souls: { "platfrom/*": {}, "platfrom/dev": {} } }))), []);
  // A soul's problems (readiness) carry the same warnings.
  assert.deepEqual(unknownOf(model(ws({ souls: { "platfrom/*": {} } })), { key: "platform/dev", soulKeys: SOULS }), [pattern("platfrom/*")]);
});

test("every reference to a local label, as `oats teams remove` names them: the local default only", () => {
  const m = model(ws({ localTeams: true }), { teams: { mine: { team: "mine:me.aweb.ai" }, spare: { team: "spare:me.aweb.ai" } }, defaultTeam: "mine" });
  assert.deepEqual(teamReferences(m, "mine"), ["defaultTeam"]);
  assert.deepEqual(teamReferences(m, "spare"), []);
});

test("the provider environment: the eligible rows with `via` (mapped only); FROM soul|deployment|workspace; no default sets none", () => {
  const env = (workspace, local, key, source = "live") => teamsEnv({ ...soulTeams(model(workspace, local), key), source });
  assert.deepEqual(env(ws({ defaultTeam: "engineering", souls: PATTERNS }), null, "security-souls/incident-responder"), {
    OATS_DEFAULT_TEAM: "security", OATS_DEFAULT_TEAM_ID: "security:acme.aweb.ai", OATS_DEFAULT_TEAM_FROM: "soul",
    OATS_TEAMS: JSON.stringify([row(SEC, true, ["default"]), row(ENG, false, ["workspace"])]),
    OATS_TEAMS_SOURCE: "live", OATS_TEAM_LABEL: undefined, OATS_TEAM_LABELS: undefined, OATS_TEAM_ID: undefined,
  });
  assert.equal(env(ws({ defaultTeam: "engineering" }), null, "a/b").OATS_DEFAULT_TEAM_FROM, "workspace");
  assert.equal(env(ws({ localTeams: true }), { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }, "a/b").OATS_DEFAULT_TEAM_FROM, "deployment");
  const unmapped = env(ws({ defaultTeam: "docs" }), null, "a/b", "recorded");
  assert.deepEqual([unmapped.OATS_DEFAULT_TEAM, unmapped.OATS_DEFAULT_TEAM_ID, unmapped.OATS_DEFAULT_TEAM_FROM, unmapped.OATS_TEAMS, unmapped.OATS_TEAMS_SOURCE],
    ["docs", undefined, "workspace", "[]", "recorded"]);
  const none = env(ws(), null, "a/b");
  assert.deepEqual([none.OATS_DEFAULT_TEAM, none.OATS_DEFAULT_TEAM_ID, none.OATS_DEFAULT_TEAM_FROM, none.OATS_TEAMS], [undefined, undefined, undefined, "[]"]);
  assert.deepEqual(Object.values(teamsEnv(null)).filter((v) => v !== undefined), []);
});

test("the removed team keys are schema problems naming their replacement (no alias, no fallback)", async () => {
  const { validateWorkspace, validateMembership, validateSoul, validateLocal } = await import("../lib/workspace.mjs");
  const MOVED = "a soul's teams are decided by souls: in oats-workspace.yaml (team model 3, OATS 0.38.0)";
  const pick = (problems) => problems.map((p) => [p.path, p.reason ?? null, p.message]);
  // 0.38.0: oats-local.yaml souls.teams / souls.default (team model v2) moved to the workspace's souls:.
  const local = { schemaVersion: 2, workspace: "git:github.com/a/b", souls: { teams: { "*": ["oats"] }, default: { dev: "oats" }, disabled: ["x"] } };
  assert.deepEqual(pick(validateLocal(local)), [
    ["/souls/teams", "removed-key", "souls.teams was removed in 0.38.0 (team model 3): which teams a soul may join is souls: in oats-workspace.yaml"],
    ["/souls/default", "removed-key", "souls.default was removed in 0.38.0 (team model 3): a soul's default team is souls: in oats-workspace.yaml (default:)"],
  ]);
  assert.deepEqual(pick(validateMembership({ schemaVersion: 2, workspace: "git:github.com/a/b", team: "global" })), [["/team", "removed-key", MOVED]]);
  assert.deepEqual(pick(validateSoul({ schemaVersion: 2, name: "dev", description: "d", work: "directory", team: ["a", "b"] })), [["/team", "removed-key", MOVED]]);
  const ws = { schemaVersion: 2, name: "acme", teams: { oats: { team: "oats:oats.aweb.ai" }, later: {} },
    messaging: { byTeam: { oats: { team: "x" } } }, defaults: { byTeam: { oats: { capabilities: {} } } },
    external: [{ source: `git:github.com/a/b@${"a".repeat(40)}`, soul: "s", team: "oats" }] };
  assert.deepEqual(pick(validateWorkspace(ws)), [
    ["/messaging/byTeam", "removed-key", "messaging.byTeam was removed in 0.30: a team's provider id is teams.<label>.team (committed, shared) or oats-local.yaml teams.<label>.team (local)"],
    ["/defaults/byTeam", "removed-key", "defaults.byTeam was removed in 0.30: capabilities compose from defaults.capabilities and the soul only"],
    ["/external/0/team", "removed-key", MOVED],
  ]);
  assert.deepEqual(validateWorkspace({ schemaVersion: 2, name: "acme", teams: { oats: { team: "oats:oats.aweb.ai", description: "d" }, later: {} } }), [], "a shared team with or without its id");
});

test("a team id must pass the kernel's safety rule in BOTH files: never '-'-led, no whitespace or control characters, bounded (the provider checks its own shape)", async () => {
  const { validateWorkspace, validateLocal } = await import("../lib/workspace.mjs");
  const { TEAM_ID_RE } = await import("../lib/teams.mjs");
  const hostile = ["--json", "-x", "a b", "a\tb", "a\nb", "a\u0007b", "x".repeat(257), " lead", ""];
  const fine = ["oats:oats.aweb.ai", "ENG", "team@host/ns+1", "a", "x".repeat(256)];
  for (const id of hostile) {
    assert.equal(TEAM_ID_RE.test(id), false, JSON.stringify(id));
    assert.ok(validateWorkspace({ schemaVersion: 2, name: "acme", teams: { t: { team: id } } }).some((p) => p.path === "/teams/t/team"), `workspace refuses ${JSON.stringify(id)}`);
    assert.ok(validateLocal({ schemaVersion: 2, workspace: "git:github.com/a/b", teams: { t: { team: id } } }).some((p) => p.path === "/teams/t/team"), `local refuses ${JSON.stringify(id)}`);
  }
  for (const id of fine) {
    assert.equal(TEAM_ID_RE.test(id), true, id);
    assert.deepEqual(validateWorkspace({ schemaVersion: 2, name: "acme", teams: { t: { team: id } } }), []);
    assert.deepEqual(validateLocal({ schemaVersion: 2, workspace: "git:github.com/a/b", teams: { t: { team: id } } }), []);
  }
  // The schemas and the kernel's constant are one rule.
  const { readFileSync } = await import("node:fs");
  for (const f of ["oats-local.schema.json", "oats-workspace.schema.json"]) assert.ok(readFileSync(new URL(`../docs/${f}`, import.meta.url), "utf8").includes(JSON.stringify(TEAM_ID_RE.source).slice(1, -1)), f);
});

test("remedies point where the fix belongs: the workspace file unless local teams are allowed; a default is changed where it comes from", () => {
  const unconfigured = (m) => teamProblems(m, { messaging: true }).find((p) => p.code === "E_TEAM_UNCONFIGURED").fix;
  assert.equal(unconfigured(model(ws())), "run `oats aweb setup` to create a team, then commit it in oats-workspace.yaml as defaultTeam (or as a soul's default in souls:)");
  assert.equal(unconfigured(model(ws({ localTeams: true }))), "run `oats aweb setup` to create a team, then commit it in oats-workspace.yaml as defaultTeam (or as a soul's default in souls:), or record it here with `oats teams add <label> --team <id>`");
  assert.equal(unconfigured(model(null)), "run `oats aweb setup` (it creates the teams and sets the default), or `oats teams add <label> --team <id>`");
  const unmapped = (workspace, local, key = "a/x") => teamProblems(model(workspace, local), { key }).find((p) => p.code === "team-unmapped" && p.default).fix;
  const OWNER = "its owner runs `oats aweb setup`, then commits the id";
  assert.equal(unmapped(ws({ souls: { "a/*": { default: "docs" } } })), `${OWNER}; or choose another default in the souls: entry a/* of oats-workspace.yaml`);
  assert.equal(unmapped(ws({ defaultTeam: "docs" })), `${OWNER}; or choose another defaultTeam in oats-workspace.yaml`);
  assert.equal(unmapped(ws({ localTeams: true }), { defaultTeam: "docs" }), `${OWNER}; or choose another default with \`oats teams default\``);
});
