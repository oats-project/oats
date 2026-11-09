// Team model 3 (awebai/oats#484, prepared in 0.36.x by #485): the workspace commits its default team
// (`defaultTeam`), whether deployments may declare their own teams (`localTeams`) and, per soul pattern,
// the default and the other teams a soul may join (`souls:`).
import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkspace } from "../lib/workspace.mjs";

const TEAMS = { engineering: { team: "engineering:acme.aweb.ai" }, security: { team: "security:acme.aweb.ai" }, docs: {} };
const ws = (extra) => ({ schemaVersion: 2, name: "acme", teams: TEAMS, ...extra });
const pick = (problems) => problems.map((p) => [p.path, p.message]);

test("the workspace accepts defaultTeam, localTeams and souls: whose labels are shared teams", () => {
  assert.deepEqual(validateWorkspace(ws({
    defaultTeam: "engineering",
    localTeams: false,
    souls: {
      "*": { teams: [] },
      "security-souls/*": { default: "security", teams: ["engineering"] },
      "security-souls/incident-responder": { default: "security", teams: ["engineering", "docs"] },
      "oats.engineering/*": { teams: "any" },
      "acme-docs/writer": {},
    },
  })), []);
  assert.deepEqual(validateWorkspace(ws({ localTeams: true })), []);
  // An unmapped shared team (declared, no provider id yet) is a shared label.
  assert.deepEqual(validateWorkspace(ws({ defaultTeam: "docs" })), []);
});

test("a label that is not a shared team of this file is a schema problem where it is written", () => {
  assert.deepEqual(pick(validateWorkspace(ws({ defaultTeam: "night" }))), [
    ["/defaultTeam", "\"night\" is not a shared team: declare it in teams: of this file"],
  ]);
  assert.deepEqual(pick(validateWorkspace(ws({ souls: { "a/b": { default: "night", teams: ["docs", "ops"] } } }))), [
    ["/souls/a~1b/default", "\"night\" is not a shared team: declare it in teams: of this file"],
    ["/souls/a~1b/teams/1", "\"ops\" is not a shared team: declare it in teams: of this file"],
  ]);
  // No teams: at all → every label is unknown.
  assert.deepEqual(pick(validateWorkspace({ schemaVersion: 2, name: "acme", defaultTeam: "engineering" })), [
    ["/defaultTeam", "\"engineering\" is not a shared team: declare it in teams: of this file"],
  ]);
});

test("souls: keys are \"*\", <member|package>/* or <member|package>/<soul>; entries are { default?, teams?: [labels] | \"any\" }", () => {
  const bad = (souls) => validateWorkspace(ws({ souls })).map((p) => p.path);
  assert.deepEqual(bad({ "*": {}, "a/*": { teams: [] }, "a.b-c/dev-x": { teams: "any" } }), [], "{} and teams: [] are both default-only");
  assert.ok(bad({ dev: {} }).length > 0, "a bare soul name is not a pattern");
  assert.ok(bad({ "a/b/c": {} }).length > 0);
  assert.ok(bad({ "*/dev": {} }).length > 0);
  assert.ok(bad({ "A/dev": {} }).length > 0);
  assert.ok(bad({ "a/*": { teams: "all" } }).length > 0, "teams is a list or \"any\"");
  assert.ok(bad({ "a/*": { teams: ["docs", "docs"] } }).length > 0, "labels are unique");
  assert.ok(bad({ "a/*": { join: ["docs"] } }).length > 0, "no other keys");
  assert.ok(bad({ "a/*": { default: "any" } }).length > 0, "a default is a shared label, never any");
  assert.ok(validateWorkspace(ws({ localTeams: "yes" })).some((p) => p.path === "/localTeams"));
});

/* ───────────── 0.38.0: the removed local keys, and local teams the workspace does not allow ───────────── */

const { v2Deployment } = await import("./helpers/v2-deployment.mjs");
const YAML = (await import("yaml")).default;
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { loadLocal } = await import("../lib/workspace.mjs");

test("oats-local.yaml souls.teams / souls.default are refused naming each key, with the souls: to commit instead", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-tm3-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "oats-local.yaml"), YAML.stringify({ schemaVersion: 2, workspace: "git:github.com/acme/agents",
    souls: { teams: { "*": ["engineering"], dev: ["docs"], "oats.okf/harvester": ["okf"] }, default: { dev: "security", reviewer: "docs" }, disabled: ["x"] } }));
  let e;
  try { loadLocal(dir); } catch (err) { e = err; }
  assert.equal(e?.code, "E_WORKSPACE_SCHEMA");
  assert.equal(e.details.reason, "removed-key");
  assert.deepEqual(e.details.problems.map((p) => p.path), ["/souls/teams", "/souls/default"], "each key found");
  // What a v2 deployment gave each soul (its default ∪ "*" ∪ its own), as souls: patterns, which never merge.
  const replacement = YAML.parse(e.details.replacement);
  assert.deepEqual(replacement, { souls: {
    "*": { teams: ["engineering"] },
    "<member>/dev": { default: "security", teams: ["engineering", "docs"] },
    "oats.okf/harvester": { teams: ["engineering", "okf"] },
    "<member>/reviewer": { default: "docs", teams: ["engineering"] },
  } });
  assert.ok(e.message.includes("/souls/teams: souls.teams was removed in 0.38.0 (team model 3): which teams a soul may join is souls: in oats-workspace.yaml"), e.message);
  assert.ok(e.message.includes("/souls/default: souls.default was removed in 0.38.0 (team model 3): a soul's default team is souls: in oats-workspace.yaml (default:)"), e.message);
  assert.ok(e.message.endsWith(`commit this in oats-workspace.yaml (<member> is the soul's member repository name, as souls.disabled names it), then remove souls.teams and souls.default from oats-local.yaml:\n${e.details.replacement}`), e.message);
});

function deployment(local, workspace = {}) {
  return v2Deployment({ name: "acme", local, souls: { dev: { soul: {} } }, workspace: { teams: { docs: { team: "docs:acme.aweb.ai" } }, ...workspace } });
}
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok ?? true, true, `${what}: ${r.stdout}`); return j.result ?? j; };
const setWorkspace = (fx, change) => {
  const file = YAML.parse(readFileSync(join(fx.base, "seed", "oats-workspace.yaml"), "utf8"));
  fx.commit({ "oats-workspace.yaml": YAML.stringify({ ...file, ...change }, { lineWidth: 0 }) }, "workspace change");
};
const CLOSED_FIX = "either (a) add `localTeams: true` to oats-workspace.yaml, or (b) commit the teams and defaultTeam in oats-workspace.yaml, then remove them from oats-local.yaml";
const closedProblem = (keys) => ({ code: "E_WORKSPACE_SCHEMA", severity: "failure", condition: "local-teams-closed", path: "oats-local.yaml", keys,
  message: `oats-local.yaml declares ${keys.join(", ")}, but oats-workspace.yaml does not allow local teams (localTeams: true): ${CLOSED_FIX}`, fix: CLOSED_FIX });

test("local teams the workspace does not allow: spawn and inspect refuse, oats teams and readiness report a failure; localTeams: true lets them apply", (t) => {
  const fx = deployment({ teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }); t.after(fx.cleanup);
  for (const args of [["spawn", "dev", "--preview"], ["inspect", "--soul", "dev"]]) {
    const r = fx.cli([...args, "--json"]).json();
    assert.deepEqual([r.ok, r.error?.code, r.error?.details], [false, "E_WORKSPACE_SCHEMA", { reason: "local-teams-closed", path: "oats-local.yaml", keys: ["teams", "defaultTeam"] }], args.join(" "));
  }
  const teams = ok(fx.cli(["teams", "--json"]), "teams");
  assert.deepEqual([teams.localTeams, teams.problems], [false, [closedProblem(["teams", "defaultTeam"])]]);
  const items = ok(fx.cli(["readiness", "--soul", "dev", "--json"]), "readiness").checks.configured.items.filter((i) => i.producer === "team model");
  const p = closedProblem(["teams", "defaultTeam"]);
  assert.deepEqual(items, [{ subject: "teams", status: "fail", required: true, reason: p.message, producer: "team model", evidence: null, remedy: p.fix, code: p.code, condition: p.condition, path: p.path, keys: p.keys }]);
  setWorkspace(fx, { localTeams: true });
  const preview = ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview with localTeams: true");
  assert.deepEqual([preview.defaultTeam, preview.teams], [{ label: "mine", team: "mine:me.aweb.ai", from: "deployment" },
    [{ label: "mine", team: "mine:me.aweb.ai", default: true, from: "local", via: ["default", "local"] }]]);
  assert.deepEqual(ok(fx.cli(["teams", "--json"]), "teams").problems, []);
});

test("doctor checks local-teams-closed offline: from the cached workspace file, else it says it couldn't be checked; a removed key is its typed refusal", (t) => {
  const fx = deployment({ teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }); t.after(fx.cleanup);
  const UNCHECKED = "local-teams-closed: whether oats-workspace.yaml allows oats-local.yaml teams/defaultTeam (localTeams: true) couldn't be checked: this deployment hasn't observed its workspace yet; run oats sync";
  let doc = JSON.parse(fx.cli(["doctor", "--json"]).stdout);
  assert.equal((doc.problems ?? []).some((p) => p.condition === "local-teams-closed"), false, "not known offline yet");
  // Operator coverage (#671) and the hook-event check (0.49.0) report on their own lines; this test pins the local-teams line.
  const own = (lines) => lines.filter((l) => !l.startsWith("operator-coverage-unknown:") && !l.startsWith("hook-events-unchecked:"));
  assert.deepEqual(own(doc.information), [UNCHECKED]);
  assert.ok(fx.cli(["doctor"]).stdout.includes(`INFO: ${UNCHECKED}`));
  ok(fx.cli(["teams", "--json"]), "teams observes the workspace");
  doc = JSON.parse(fx.cli(["doctor", "--json"]).stdout);
  assert.deepEqual([doc.problems.filter((p) => p.condition === "local-teams-closed"), own(doc.information)], [[closedProblem(["teams", "defaultTeam"])], []]);
  assert.ok(fx.cli(["doctor"]).stdout.includes(`! E_WORKSPACE_SCHEMA (local-teams-closed): ${closedProblem(["teams", "defaultTeam"]).message}`));
  setWorkspace(fx, { localTeams: true });
  ok(fx.cli(["teams", "--json"]), "observe the change");
  assert.equal(JSON.parse(fx.cli(["doctor", "--json"]).stdout).problems?.some((p) => p.condition === "local-teams-closed") ?? false, false);
  // A removed key: doctor answers the typed refusal, the snippet included.
  const local = YAML.parse(readFileSync(join(fx.dep, "oats-local.yaml"), "utf8"));
  writeFileSync(join(fx.dep, "oats-local.yaml"), YAML.stringify({ ...local, souls: { teams: { "*": ["docs"] } } }));
  const refused = JSON.parse(fx.cli(["doctor", "--json"]).stdout);
  assert.deepEqual([refused.ok, refused.error.code, refused.error.details.reason, YAML.parse(refused.error.details.replacement)],
    [false, "E_WORKSPACE_SCHEMA", "removed-key", { souls: { "*": { teams: ["docs"] } } }]);
  assert.ok(fx.cli(["doctor"]).stderr.includes(refused.error.details.replacement));
});

test("team-soul-unknown: a souls: key that is no discovered soul's qualified name, or a pattern that matches none, warns, in oats teams and readiness", (t) => {
  const fx = deployment({}, { defaultTeam: "docs", souls: { "ws/dev": { teams: [] }, "ws/devv": { teams: [] }, "ws/*": {}, "other/*": {}, "oats.okf/harvester": {} } }); t.after(fx.cleanup);
  const warning = (key) => ({ code: "team-soul-unknown", severity: "warning", key, at: `${fx.key}:oats-workspace.yaml#/souls/${key.replace(/\//g, "~1")}`,
    message: `souls: ${key} names no soul of this workspace (a pattern is "*" or <member|package>/*)`, fix: "correct the key to a soul's qualified name (oats souls lists them), or remove it" });
  // `other/*`: no member or package named `other` has souls here (#1759); `ws/*` matches ws/dev and is silent.
  const patternWarning = (key) => ({ ...warning(key), message: `souls: ${key} is a pattern that matches no soul of this workspace`,
    fix: "correct the prefix to a member's or package's name (oats souls lists them), or remove the key" });
  assert.deepEqual(ok(fx.cli(["teams", "--json"]), "teams").problems, [warning("oats.okf/harvester"), patternWarning("other/*"), warning("ws/devv")]);
  const items = ok(fx.cli(["readiness", "--soul", "dev", "--json"]), "readiness").checks.configured.items.filter((i) => i.code === "team-soul-unknown");
  assert.deepEqual(items.map((i) => [i.subject, i.required, i.key, i.reason, i.remedy]), [warning("oats.okf/harvester"), patternWarning("other/*"), warning("ws/devv")].map((w) => ["teams", false, w.key, w.message, w.fix]));
});
