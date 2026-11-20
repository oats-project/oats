// Team model 3 (docs/design/2026-10-02-team-model-3.md, awebai/oats#484), the kernel half as the CLI
// exposes it: SHARED teams, the workspace's default and each soul pattern's default and teams committed in
// oats-workspace.yaml; LOCAL teams and the local default in the deployment's oats-local.yaml where the
// workspace allows them (`localTeams: true`), written by `oats teams` (config only). The kernel hands the
// messaging provider the soul's teams here — in the spawn preview, in `inspect`, in OATS_DEFAULT_TEAM* /
// OATS_TEAMS for a home's commands (live: the workspace and oats-local.yaml as they are now), and beside
// the settings in a provider check's environment (never on its stdin). Joining any team but the default
// is the provider's explicit act, and only an eligible one (an OATS_TEAMS row).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { homeTarget, runProviderCheck } from "../lib/instance-inspect.mjs";

const envProbe = "const u=(k)=>process.env[k]===undefined?null:process.env[k];console.log(JSON.stringify({schemaVersion:1,ok:true,result:{def:u('OATS_DEFAULT_TEAM'),id:u('OATS_DEFAULT_TEAM_ID'),from:u('OATS_DEFAULT_TEAM_FROM'),source:u('OATS_TEAMS_SOURCE'),old:[u('OATS_TEAM_LABEL'),u('OATS_TEAM_LABELS'),u('OATS_TEAM_ID')],teams:u('OATS_TEAMS')===null?null:JSON.parse(process.env.OATS_TEAMS)}}))\n";
// A binding check that answers `ready` and echoes, as a warning, the teams its ENVIRONMENT carries and
// the keys of its stdin request.
const echoCheck = `let raw = ""; process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", () => {
  const req = JSON.parse(raw);
  process.stdout.write(JSON.stringify({ schemaVersion: 1, phase: "check", slot: "messaging", capability: "acme.chat", ok: true,
    result: { status: "ready", problems: [], warnings: [{ code: "teams-seen", message: JSON.stringify({ def: process.env.OATS_DEFAULT_TEAM, teams: JSON.parse(process.env.OATS_TEAMS), source: process.env.OATS_TEAMS_SOURCE, contextKeys: Object.keys(req.input.context).sort() }) }] } }) + "\\n");
});\n`;

const SHARED = { oats: { team: "oats:oats.aweb.ai", description: "The OATS project" }, night: { description: "Night shift (not created yet)" } };
/** The fixture's single member is `ws`: its dev soul's key is `ws/dev`. Local teams are allowed unless `workspace` says otherwise. */
function fixture({ local = {}, messaging = true, workspace = {} } = {}) {
  return v2Deployment({
    name: "acme",
    local,
    souls: { dev: { soul: { capabilities: { "acme.env": { from: "here" }, ...(messaging ? { "acme.chat": { from: "here" } } : {}) } } } },
    capabilities: {
      "acme.env": { manifest: { layer: "knowledge", command: "envprobe", commands: { show: "show.mjs" }, operations: { show: { command: "show", context: "home" } } }, files: { "show.mjs": envProbe } },
      "acme.chat": { manifest: { layer: "messaging", settings: { join: { description: "labels to join at spawn" }, identity: { description: "the identity to use" } }, hooks: { spawn: "spawn.mjs", retire: "retire.mjs" }, binding: { version: 1, normalize: "bn", bind: "bb", check: "bc", reasons: ["not ready"] }, command: "chat", commands: { bn: "noop.mjs", bb: "noop.mjs", bc: "check.mjs", teams: "show.mjs" }, operations: { teams: { command: "teams", context: "home" } } },
        files: { "check.mjs": echoCheck, "noop.mjs": "process.exit(0);\n", "show.mjs": envProbe,
          "retire.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TEAMS_RETIRE_OUT, JSON.stringify({ def: process.env.OATS_DEFAULT_TEAM, id: process.env.OATS_DEFAULT_TEAM_ID, teams: JSON.parse(process.env.OATS_TEAMS) }));\nprocess.stdout.write("{}\\n");\n`,
          "spawn.mjs": `import { writeFileSync } from "node:fs"; import { join } from "node:path";\nwriteFileSync(join(process.env.OATS_INSTANCE_HOME, "spawn-teams.json"), JSON.stringify({ def: process.env.OATS_DEFAULT_TEAM, id: process.env.OATS_DEFAULT_TEAM_ID, from: process.env.OATS_DEFAULT_TEAM_FROM, teams: JSON.parse(process.env.OATS_TEAMS), settings: JSON.parse(process.env.OATS_SETTINGS) }));\nprocess.stdout.write("{}\\n");\n` } },
    },
    workspace: { teams: SHARED, messaging: { private: "per-human" }, localTeams: true, ...workspace },
  });
}
const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const refused = (r, code, what) => { const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}`); assert.equal(j.error.code, code, `${what}: ${r.stdout}`); return j.error; };
const localYaml = (fx) => YAML.parse(readFileSync(join(fx.dep, "oats-local.yaml"), "utf8"));
const MINE = { label: "mine", team: "mine:me.aweb.ai", default: true, from: "local", via: ["default", "local"] };
const OATS = { label: "oats", team: "oats:oats.aweb.ai", default: false, from: "shared", via: ["workspace"] };
const NIGHT = { label: "night", team: null, default: false, from: "shared", via: ["workspace"] };
const setWorkspace = (fx, change) => {
  const ws = YAML.parse(readFileSync(join(fx.base, "seed", "oats-workspace.yaml"), "utf8"));
  fx.commit({ "oats-workspace.yaml": YAML.stringify({ ...ws, ...change }, { lineWidth: 0 }) }, "workspace change");
};

test("oats teams: the deployment's teams, the workspace's souls:; add (the first becomes the default), default, remove refuses a referenced, shared or unknown label", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  writeFileSync(join(fx.dep, "oats-local.yaml"), `${readFileSync(join(fx.dep, "oats-local.yaml"), "utf8")}# a comment the verbs keep\n`);
  let doc = ok(fx.cli(["teams", "--json"]), "teams");
  assert.equal(doc.teamsApi, 2);
  assert.deepEqual([doc.localTeams, doc.defaultTeam, doc.souls], [true, null, {}]);
  assert.deepEqual(doc.teams.map((r) => [r.label, r.team, r.from, r.default]), [["night", null, "shared", false], ["oats", "oats:oats.aweb.ai", "shared", false]]);
  assert.match(doc.teams[1].at, /oats-workspace\.yaml#\/teams\/oats$/);
  assert.deepEqual(doc.problems.map((p) => [p.code, p.severity]), [["team-unmapped", "warning"]], "the workspace fills no messaging slot (the soul brings its own): no deployment-wide E_TEAM_UNCONFIGURED");

  doc = ok(fx.cli(["teams", "add", "mine", "--team", "mine:me.aweb.ai", "--description", "Mine", "--json"]), "teams add");
  assert.equal(doc.changed, true);
  assert.deepEqual(doc.defaultTeam, { label: "mine", team: "mine:me.aweb.ai", from: "deployment" }, "the first team added becomes the default");
  assert.deepEqual(localYaml(fx).teams, { mine: { team: "mine:me.aweb.ai", description: "Mine" } });
  assert.match(readFileSync(join(fx.dep, "oats-local.yaml"), "utf8"), /# a comment the verbs keep/, "the rest of the file is kept");
  assert.deepEqual(refused(fx.cli(["teams", "add", "oats", "--team", "x:y", "--json"]), "E_TEAM_EXISTS", "add a shared label").details, { label: "oats", from: "shared", observed: { label: "oats", team: "oats:oats.aweb.ai", from: "shared" } });
  assert.deepEqual(refused(fx.cli(["teams", "add", "mine", "--team", "x:y", "--json"]), "E_TEAM_EXISTS", "add twice").details, { label: "mine", from: "local", observed: { label: "mine", team: "mine:me.aweb.ai", from: "local" } });
  ok(fx.cli(["teams", "add", "spare", "--team", "spare:me.aweb.ai", "--json"]), "add a second");
  // A hostile provider id never reaches oats-local.yaml (the provider's argv later): the kernel's safety rule.
  const localBefore = readFileSync(join(fx.dep, "oats-local.yaml"), "utf8");
  for (const id of ["--json", "-x"]) refused(fx.cli(["teams", "add", "bad", `--team=${id}`, "--json"]), "E_BAD_ARGS", `option-like id ${id} (the CLI's own guard)`);
  for (const id of ["a b", "a\nb", "x".repeat(257)]) {
    assert.deepEqual(refused(fx.cli(["teams", "add", "bad", "--team", id, "--json"]), "E_BAD_ARGS", `hostile id ${JSON.stringify(id)}`).details, { label: "bad", team: id });
  }
  assert.equal(readFileSync(join(fx.dep, "oats-local.yaml"), "utf8"), localBefore, "nothing was written");
  assert.equal(localYaml(fx).defaultTeam, "mine", "only the first add sets the default");

  // The workspace's souls: are reported as committed.
  setWorkspace(fx, { souls: { "*": { teams: ["oats"] }, "ws/dev": { default: "oats", teams: "any" } } });
  assert.deepEqual(ok(fx.cli(["teams", "--json"]), "teams").souls, { "*": { teams: ["oats"] }, "ws/dev": { default: "oats", teams: "any" } });
  assert.deepEqual(refused(fx.cli(["teams", "remove", "mine", "--json"]), "E_TEAM_IN_USE", "remove the default").details, { label: "mine", usedBy: ["defaultTeam"] });
  assert.deepEqual(refused(fx.cli(["teams", "remove", "oats", "--json"]), "E_TEAM_SHARED", "remove a shared label").details.label, "oats");
  refused(fx.cli(["teams", "remove", "ghost", "--json"]), "E_TEAM_UNKNOWN", "remove an unknown label");
  refused(fx.cli(["teams", "default", "ghost", "--json"]), "E_TEAM_UNKNOWN", "default to an unknown label");

  doc = ok(fx.cli(["teams", "remove", "spare", "--json"]), "remove");
  assert.deepEqual(Object.keys(localYaml(fx).teams), ["mine"]);
  doc = ok(fx.cli(["teams", "default", "oats", "--json"]), "default to a shared team");
  assert.deepEqual(doc.defaultTeam, { label: "oats", team: "oats:oats.aweb.ai", from: "deployment" });
  assert.equal(ok(fx.cli(["teams", "default", "oats", "--json"]), "the same again").changed, false);
});

test("oats soul teams: a soul's teams here and why (read only); its edit flags were removed in 0.38.0", (t) => {
  const fx = fixture({ local: { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" },
    workspace: { souls: { "*": { teams: ["night"] }, "ws/*": { default: "oats" }, "ws/dev": { teams: ["oats"] } } } }); t.after(fx.cleanup);
  let doc = ok(fx.cli(["soul", "teams", "dev", "--json"]), "soul teams");
  assert.deepEqual(doc, { soulTeamsApi: 2, soul: "dev", key: "ws/dev", match: "ws/dev", defaultMatch: "ws/*",
    defaultTeam: { label: "oats", team: "oats:oats.aweb.ai", from: "soul" },
    teams: [{ ...OATS, default: true, via: ["default", "workspace"] }, { ...MINE, default: false, via: ["local"] }] });
  const every = ok(fx.cli(["soul", "teams", "*", "--json"]), "soul teams *");
  assert.deepEqual([every.soul, every.key, every.match, every.defaultTeam.from, every.teams.map((r) => r.label)], ["*", "*", "*", "deployment", ["mine", "night"]]);
  refused(fx.cli(["soul", "teams", "nobody", "--json"]), "E_SOUL_UNKNOWN", "an unknown soul");
  const before = readFileSync(join(fx.dep, "oats-local.yaml"), "utf8");
  for (const flag of ["--add", "--remove", "--default", "--clear-default"]) {
    const e = refused(fx.cli(["soul", "teams", "dev", flag, ...(flag === "--clear-default" ? [] : ["oats"]), "--json"]), "E_BAD_ARGS", flag);
    assert.deepEqual(e.details, { flag, replacement: "souls: in oats-workspace.yaml (a PR to the workspace file)" });
  }
  assert.equal(readFileSync(join(fx.dep, "oats-local.yaml"), "utf8"), before, "nothing was written");
});

test("spawn preview, inspect --soul and `oats souls` report the soul's teams here and its default; feature team-model-3", (t) => {
  const fx = fixture({ local: { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }, workspace: { souls: { "ws/dev": { teams: ["oats", "night"] } } } }); t.after(fx.cleanup);
  const preview = ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "spawn --preview");
  assert.deepEqual(preview.teams, [MINE, NIGHT, OATS], "default first, then by label; the unmapped row reported");
  assert.deepEqual(preview.defaultTeam, { label: "mine", team: "mine:me.aweb.ai", from: "deployment" });
  assert.equal("team" in preview, false, "no primary label");
  assert.deepEqual(preview.settings["acme.chat"], { private: "per-human" }, "teams are never settings");
  const doc = ok(fx.cli(["inspect", "--soul", "dev", "--json"]), "inspect --soul");
  assert.deepEqual([doc.teams, doc.defaultTeam, doc.teamsSource], [[MINE, NIGHT, OATS], preview.defaultTeam, "live"]);
  assert.equal("team" in doc.subject, false);
  assert.equal("team" in doc.souls[0], false);
  const row = ok(fx.cli(["souls", "--json"]), "souls").souls.find((s) => s.name === "dev");
  assert.deepEqual([row.teams, row.defaultTeam, "team" in row, "labels" in row], [[MINE, NIGHT, OATS], preview.defaultTeam, false, false]);
  const version = JSON.parse(fx.cli(["version", "--json"]).stdout);
  assert.ok(version.features.includes("team-model-3"));
  assert.equal(version.features.includes("team-model-2") || version.features.includes("teams"), false, "team-model-3 replaces team-model-2");
  const status = ok(fx.cli(["workspace", "status", "--json"]), "workspace status");
  assert.deepEqual(status.workspace.teams, [{ label: "night", team: null, description: "Night shift (not created yet)" }, { label: "oats", team: "oats:oats.aweb.ai", description: "The OATS project" }]);
  assert.equal("byTeam" in status.defaults, false);
  assert.deepEqual(status.warnings, []);
});

test("an unknown label in oats-local.yaml refuses the spawn preview and inspect --soul; readiness reports it", (t) => {
  const fx = fixture({ local: { defaultTeam: "ghost" } }); t.after(fx.cleanup);
  assert.deepEqual(refused(fx.cli(["spawn", "dev", "--preview", "--json"]), "E_TEAM_UNKNOWN", "preview").details, { label: "ghost", at: "oats-local.yaml#/defaultTeam" });
  refused(fx.cli(["inspect", "--soul", "dev", "--json"]), "E_TEAM_UNKNOWN", "inspect --soul");
  const rd = ok(fx.cli(["readiness", "--soul", "dev", "--json"]), "readiness reports it");
  const items = rd.checks.configured.items.filter((i) => i.producer === "team model");
  assert.deepEqual(items.map((i) => [i.subject, i.code, i.status, i.required]), [["team ghost", "E_TEAM_UNKNOWN", "fail", true]]);
  assert.equal(rd.checks.installed.items.some((i) => i.code === "E_TEAM_UNKNOWN"), false, "reported once, as configuration");
  assert.deepEqual(Object.keys(rd.checks), ["installed", "configured", "member", "providers"], "no fifth check");
});

test("readiness: no default with messaging is E_TEAM_UNCONFIGURED; an unmapped default blocks with team-unmapped default:true; unmapped extras warn", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const items = () => ok(fx.cli(["readiness", "--soul", "dev", "--json"]), "readiness").checks.configured.items.filter((i) => i.producer === "team model");
  assert.deepEqual(items().map((i) => [i.subject, i.code, i.required]), [["teams", "E_TEAM_UNCONFIGURED", true]]);
  ok(fx.cli(["teams", "default", "night", "--json"]), "default to the unmapped shared team");
  const [unmapped] = items();
  assert.deepEqual([unmapped.code, unmapped.label, unmapped.default, unmapped.required, unmapped.reason], ["team-unmapped", "night", true, true, "the default team night has no provider id yet"]);
  assert.equal(unmapped.remedy, "its owner runs `oats aweb setup`, then commits the id; or choose another default with `oats teams default`");
  const preview = ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview with an unmapped default");
  assert.deepEqual(preview.defaultTeam, { label: "night", team: null, from: "deployment" });
  ok(fx.cli(["teams", "default", "oats", "--json"]), "a mapped default");
  setWorkspace(fx, { souls: { "ws/dev": { teams: ["night"] } } }); // night as an extra
  assert.deepEqual(items().map((i) => [i.code, i.label, i.default, i.required]), [["team-unmapped", "night", false, false]]);
  // A shared label also declared locally (a local team is eligible for every soul): the committed definition wins; a warning.
  ok(fx.cli(["teams", "add", "zed", "--team", "zed:me.aweb.ai", "--json"]), "a local team");
  setWorkspace(fx, { teams: { ...SHARED, zed: { team: "zed:shared.aweb.ai" } } });
  const collision = items().find((i) => i.code === "team-label-collision");
  assert.deepEqual([collision.label, collision.required, collision.shared.team, collision.local.team], ["zed", false, "zed:shared.aweb.ai", "zed:me.aweb.ai"]);
  assert.equal(ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview").teams.find((r) => r.label === "zed").team, "zed:shared.aweb.ai");
  ok(fx.cli(["teams", "remove", "zed", "--json"]), "the collision's fix: the local copy goes even while referenced (the shared label still resolves)");
});

test("a home's teams are LIVE: its commands, operations, inspect --home and a provider check follow the workspace and oats-local.yaml; the spawn record stays frozen", async (t) => {
  const fx = fixture({ local: { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }, workspace: { souls: { "ws/dev": { teams: ["oats", "night"] } } } }); t.after(fx.cleanup);
  // Once the workspace gives dev a default of its own: oats, and mine stays eligible (a local team).
  const OATS_D = { ...OATS, default: true, via: ["default", "workspace"] }, MINE_X = { ...MINE, default: false, via: ["local"] };
  const { home } = await fx.spawn("dev", { instance: "dev-teams" });
  const meta0 = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
  assert.deepEqual(meta0.teams, [MINE, OATS], "spawn records what the providers received: mapped rows only");
  assert.deepEqual(meta0.defaultTeam, { label: "mine", team: "mine:me.aweb.ai", from: "deployment" });
  assert.equal("team" in meta0.workspace.soul || "labels" in meta0.workspace.soul, false);
  const spawnHook = JSON.parse(readFileSync(join(home, "spawn-teams.json"), "utf8"));
  assert.deepEqual(spawnHook, { def: "mine", id: "mine:me.aweb.ai", from: "deployment", teams: [MINE, OATS], settings: { private: "per-human" } });

  const inHome = (ns, sub) => ok(fx.cli([ns, sub, "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home, OATS_TEAM_ID: "ambient", OATS_DEFAULT_TEAM_ID: "ambient" } }), `${ns} ${sub} in the home`);
  let seen = inHome("chat", "teams");
  assert.deepEqual([seen.def, seen.id, seen.from, seen.source, seen.teams, seen.old], ["mine", "mine:me.aweb.ai", "deployment", "live", [MINE, OATS], [null, null, null]], "no pre-0.30 name, never an ambient value");
  // The workspace gives the soul a default of its own: the live views follow; the record does not.
  setWorkspace(fx, { souls: { "ws/dev": { default: "oats", teams: ["oats", "night"] } } });
  seen = inHome("chat", "teams");
  assert.deepEqual([seen.def, seen.from, seen.teams], ["oats", "soul", [OATS_D, MINE_X]]);
  seen = inHome("envprobe", "show");
  assert.deepEqual([seen.def, seen.teams, seen.source], ["mine", [MINE, OATS], "recorded"], "a non-messaging command reads no remote: the record");
  // The same split for provider operations run on the home: the messaging layer's live, others recorded.
  const operation = (address) => ok(fx.cli(["operation", "run", address, "--home", home, "--json"]), `operation run ${address}`).result;
  seen = operation("messaging:teams");
  assert.deepEqual([seen.def, seen.from, seen.teams, seen.source], ["oats", "soul", [OATS_D, MINE_X], "live"]);
  seen = operation("knowledge:show");
  assert.deepEqual([seen.def, seen.teams, seen.source], ["mine", [MINE, OATS], "recorded"], "a non-messaging operation reads no remote: the record");
  const doc = ok(fx.cli(["inspect", "--home", home, "--json"]), "inspect --home");
  assert.deepEqual([doc.defaultTeam, doc.recordedDefaultTeam, doc.teamsSource], [{ label: "oats", team: "oats:oats.aweb.ai", from: "soul" }, meta0.defaultTeam, "live"]);
  assert.deepEqual(doc.teams, [OATS_D, MINE_X, NIGHT], "live report rows include the unmapped one");
  const rd = ok(fx.cli(["readiness", "--home", home, "--json"]), "readiness --home");
  const changed = rd.checks.configured.items.find((i) => i.code === "default-team-changed");
  assert.deepEqual([changed.required, changed.recorded.label, changed.current.label, changed.remedy], [false, "mine", "oats", "respawn"]);
  const check = rd.checks.providers.items.find((i) => i.subject === "acme.chat");
  const echoed = JSON.parse(check.result.warnings.find((w) => w.code === "teams-seen").message);
  assert.deepEqual(echoed, { def: "oats", teams: [OATS_D, MINE_X], source: "live", contextKeys: ["deployment", "home", "instance", "kind", "soul", "workspace"] }, "no team on the released wire");
  // The workspace host unreachable → the spawn record, marked `recorded`.
  const bare = fx.repo, parked = `${fx.repo}.parked`;
  renameSync(bare, parked);
  try {
    seen = inHome("chat", "teams");
    assert.deepEqual([seen.def, seen.teams, seen.source], ["mine", [MINE, OATS], "recorded"]);
    const off = ok(fx.cli(["inspect", "--home", home, "--json"]), "inspect --home, host unreachable");
    assert.deepEqual([off.teams, off.defaultTeam, off.teamsSource], [[MINE, OATS], meta0.defaultTeam, "recorded"], "the record, marked recorded");
  } finally { renameSync(parked, bare); }
  assert.deepEqual(JSON.parse(readFileSync(join(home, "instance.json"), "utf8")).teams, meta0.teams, "the spawn record is evidence, never rewritten");
  const out = join(fx.base, "retire-teams.json");
  const retired = fx.cli(["retire", "dev-teams", "--json"], { env: { TEAMS_RETIRE_OUT: out } });
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { def: "mine", id: "mine:me.aweb.ai", teams: [MINE, OATS] }, "retire works from the record");
});

test("the workspace's default: from \"workspace\" in the preview, inspect, souls and the provider environment; OATS_TEAMS is exactly the eligible rows (a join of any other is the provider's refusal)", async (t) => {
  const fx = fixture({ workspace: { defaultTeam: "oats", localTeams: false, souls: { "ws/*": { teams: ["night"] } } } }); t.after(fx.cleanup);
  const DEF = { label: "oats", team: "oats:oats.aweb.ai", from: "workspace" };
  const rows = [{ ...OATS, default: true, via: ["default"] }, NIGHT];
  const preview = ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "preview");
  assert.deepEqual([preview.defaultTeam, preview.teams], [DEF, rows]);
  const doc = ok(fx.cli(["inspect", "--soul", "dev", "--json"]), "inspect --soul");
  assert.deepEqual([doc.defaultTeam, doc.teams], [DEF, rows]);
  const row = ok(fx.cli(["souls", "--json"]), "souls").souls.find((x) => x.name === "dev");
  assert.deepEqual([row.defaultTeam, row.teams], [DEF, rows]);
  const { home } = await fx.spawn("dev", { instance: "dev-ws-default" });
  const hook = JSON.parse(readFileSync(join(home, "spawn-teams.json"), "utf8"));
  assert.deepEqual([hook.def, hook.id, hook.from, hook.teams], ["oats", "oats:oats.aweb.ai", "workspace", [rows[0]]], "mapped eligible rows only: night has no id, nothing else is eligible");
});

test("an unmapped default reaches the provider as the label and FROM without the id", async (t) => {
  const fx = fixture({ local: { defaultTeam: "night" } }); t.after(fx.cleanup);
  const { home } = await fx.spawn("dev", { instance: "dev-unmapped" });
  const spawnHook = JSON.parse(readFileSync(join(home, "spawn-teams.json"), "utf8"));
  assert.deepEqual(spawnHook, { def: "night", from: "deployment", teams: [], settings: { private: "per-human" } }, "OATS_DEFAULT_TEAM_ID unset");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "instance.json"), "utf8")).defaultTeam, { label: "night", team: null, from: "deployment" });
});

test("the REAL bundled oats.aweb binding check decodes the kernel's check request: the teams never break its strict wire", async (t) => {
  const fx = fixture({ local: { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" }, workspace: { souls: { "ws/dev": { teams: ["oats"] } } } }); t.after(fx.cleanup);
  const { home } = await fx.spawn("dev", { instance: "dev-aweb" });
  const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
  const target = await homeTarget(home, meta);
  assert.deepEqual([target.teams, target.teamsSource], [[MINE, OATS], "live"]);
  const dir = fileURLToPath(new URL("../mirrors/oats-aweb", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(dir, "oats.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../package-catalog.json", import.meta.url)), "utf8"));
  assert.equal(`v${manifest.version}`, catalog.packages["oats.aweb"].ref, "the bundled provider is the catalog's pinned release");
  const aweb = { ...target, payloads: { ...target.payloads, "oats.aweb": {} }, slots: { ...target.slots, messaging: "oats.aweb" } };
  const out = runProviderCheck(aweb, { name: "oats.aweb", manifest }, dir);
  // Its decoder accepted the request: the answer is one of its check statuses, never its wire refusal
  // (`invalid-binding` / `provider-not-qualified`).
  assert.equal(out.outcome, "result", JSON.stringify(out));
  assert.equal(out.result.problems.some((p) => ["invalid-binding", "provider-not-qualified"].includes(p.code)), false, JSON.stringify(out));
  // What the bundled 1.21.1 answers under the 0.30 env (its actual output, recorded from this run):
  // needs-configuration for the missing messaging root only, named with its source since oats.aweb 1.44.0 (awebai/oats-aweb#291). It reads the kernel's default team
  // (OATS_DEFAULT_TEAM_ID), so the 1.16 "no team" problem is gone. An `aw` version problem depends on the machine.
  assert.equal(out.result.status, "needs-configuration", JSON.stringify(out));
  const reasons = out.result.problems.filter((p) => !/^aw /.test(p.message)).map((p) => [p.code, p.message.replace(/ at \S+ \(from /, " at <deployment> (from ")]);
  assert.deepEqual(reasons, [
    ["needs-configuration", "no messaging root at <deployment> (from the workspace directory): run oats aweb setup there or set settings.oats.aweb.root"],
  ], JSON.stringify(out));
  assert.deepEqual(out.result.warnings, [], JSON.stringify(out));
});

test("the spawn preview's modules and inspect's capabilities list the setting keys each manifest DECLARES (names only); feature settings-declared", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const declares = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.declares]));
  const preview = ok(fx.cli(["spawn", "dev", "--preview", "--json"]), "spawn --preview");
  assert.deepEqual(declares(preview.modules, "name"), { "acme.chat": ["identity", "join"], "acme.env": [] }, "sorted key names; a manifest with no settings declares []");
  const soul = ok(fx.cli(["inspect", "--soul", "dev", "--json"]), "inspect --soul");
  assert.deepEqual(declares(soul.capabilities, "id"), { "acme.chat": ["identity", "join"], "acme.env": [] });
  const { home } = await fx.spawn("dev", { instance: "dev-declares" });
  const doc = ok(fx.cli(["inspect", "--home", home, "--json"]), "inspect --home");
  assert.deepEqual(declares(doc.capabilities, "id"), { "acme.chat": ["identity", "join"], "acme.env": [] }, "a home answers from its own module copies");
  assert.equal(JSON.stringify(doc.capabilities).includes("labels to join at spawn"), false, "never a declaration's description");
  const version = JSON.parse(fx.cli(["version", "--json"]).stdout);
  assert.ok(version.features.includes("settings-declared"));
});

test("a package soul carrying the removed `team:` is refused (not listed), naming the move", async (t) => {
  const { discoverPackageSouls } = await import("../lib/workspace.mjs");
  const soulYaml = "schemaVersion: 2\nname: harvester\ndescription: d\nwork: directory\nteam: okf\n";
  const remote = {
    parseRepoRef: (ref) => ({ key: ref.replace(/^git:/, "") }),
    readRemoteFile: async () => ({ bytes: Buffer.from(soulYaml) }),
    observeRemote: async () => { throw new Error("not read"); }, listRemoteTree: async () => [],
  };
  const lock = { packages: { "oats.okf": { version: "4.0.1", commit: "a".repeat(40), path: "oats-package", url: "git:github.com/awebai/oats-okf", souls: [{ name: "harvester", path: "souls/harvester", digest: "sha256-x" }] } } };
  const { souls, problems } = await discoverPackageSouls({ packages: { "oats.okf": "v4.0.1" } }, lock, { remote });
  assert.deepEqual(souls, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, "E_WORKSPACE_SCHEMA");
  assert.match(problems[0].message, /a soul's teams are decided by souls: in oats-workspace\.yaml \(team model 3, OATS 0\.38\.0\)/);
});

test("an existing home refuses the removed local team keys like every other reader: its messaging commands and operations, inspect --home and readiness --home answer removed-key, never the record", async (t) => {
  const fx = fixture({ workspace: { defaultTeam: "oats" } }); t.after(fx.cleanup);
  const { home } = await fx.spawn("dev", { instance: "dev-removed" });
  const localFile = join(fx.dep, "oats-local.yaml");
  const original = readFileSync(localFile, "utf8");
  for (const [key, souls] of [["souls.default", { default: { dev: "oats" } }], ["souls.teams", { teams: { "*": ["night"] } }]]) {
    writeFileSync(localFile, YAML.stringify({ ...YAML.parse(original), souls }));
    const runs = [
      ["chat teams", fx.cli(["chat", "teams", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } })],
      ["inspect --home", fx.cli(["inspect", "--home", home, "--json"])],
      ["readiness --home", fx.cli(["readiness", "--home", home, "--json"])],
      ["operation run --home", fx.cli(["operation", "run", "messaging:teams", "--home", home, "--json"])],
      // A non-messaging operation reads no teams, and still refuses before its provider runs.
      ["operation run knowledge:show --home", fx.cli(["operation", "run", "knowledge:show", "--home", home, "--json"])],
    ];
    for (const [what, r] of runs) {
      const e = refused(r, "E_WORKSPACE_SCHEMA", `${what} with ${key}`);
      assert.equal(e.details.reason, "removed-key", `${what} with ${key}`);
      assert.equal(typeof e.details.replacement, "string", `${what} with ${key}: the souls: to commit`);
      assert.ok(e.details.problems.some((p) => p.path === `/${key.replace(".", "/")}`), `${what} names ${key}`);
    }
    // A non-messaging command reads no oats-local.yaml: it runs from the home's frozen record, as always.
    const recorded = ok(fx.cli(["envprobe", "show", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } }), `envprobe show with ${key}`);
    assert.equal(recorded.source, "recorded");
  }
  writeFileSync(localFile, original);
  ok(fx.cli(["chat", "teams", "--json"], { cwd: home, env: { OATS_INSTANCE_HOME: home } }), "migrated: the provider runs again");
});

/* ── awebai/oats#771: the conditional default and mapping-only add on the existing verbs ── */

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "bin", "oats.mjs");
/** The real CLI as a child process that runs concurrently with others (fx.cli is synchronous). */
const cliAsync = (fx, args) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: fx.dep, env: fx.env });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c)); child.stderr.on("data", (c) => (stderr += c));
  child.on("close", (status) => resolveRun({ status, stdout, stderr, json: () => JSON.parse(stdout.trim().split("\n").pop()) }));
});
const localText = (fx) => readFileSync(join(fx.dep, "oats-local.yaml"), "utf8");
const BASE_LOCAL = (fx) => localText(fx).replace(/\n(teams|defaultTeam):[\s\S]*$/, "\n");
const withLocalTeams = (fx, base, defaultTeam = null) => writeFileSync(join(fx.dep, "oats-local.yaml"),
  `${base}teams:\n  alpha: { team: "alpha:me.aweb.ai" }\n  beta: { team: "beta:me.aweb.ai" }\n${defaultTeam ? `defaultTeam: ${defaultTeam}\n` : ""}`);

test("oats teams default --if-absent / --expect and add --no-default: the CLI's answers and refusals; feature teams-conditional-default", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  assert.ok(fx.cli(["version", "--json"]).json().features.includes("teams-conditional-default"));
  const base = BASE_LOCAL(fx);

  let doc = ok(fx.cli(["teams", "add", "alpha", "--team", "alpha:me.aweb.ai", "--no-default", "--json"]), "add --no-default");
  assert.deepEqual([doc.changed, doc.reused, doc.defaultTeam], [true, undefined, null]);
  assert.equal(localYaml(fx).defaultTeam, undefined);
  doc = ok(fx.cli(["teams", "add", "alpha", "--team", "alpha:me.aweb.ai", "--no-default", "--json"]), "add --no-default again");
  assert.deepEqual([doc.changed, doc.reused], [false, true]);
  assert.deepEqual(refused(fx.cli(["teams", "add", "alpha", "--team", "other:me.aweb.ai", "--no-default", "--json"]), "E_TEAM_EXISTS", "another id").details,
    { label: "alpha", from: "local", observed: { label: "alpha", team: "alpha:me.aweb.ai", from: "local" } });
  const text = fx.cli(["teams", "add", "alpha", "--team", "alpha:me.aweb.ai", "--no-default"]);
  assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /already declared with that id|Nothing to change/);

  doc = ok(fx.cli(["teams", "default", "alpha", "--if-absent", "--json"]), "--if-absent with no default");
  assert.deepEqual([doc.changed, doc.defaultTeam], [true, { label: "alpha", team: "alpha:me.aweb.ai", from: "deployment" }]);
  ok(fx.cli(["teams", "add", "beta", "--team", "beta:me.aweb.ai", "--json"]), "plain add");
  let before = localText(fx);
  const e = refused(fx.cli(["teams", "default", "beta", "--if-absent", "--json"]), "E_TEAM_DEFAULT_MISMATCH", "--if-absent over a default");
  assert.deepEqual(e.details, { expected: { absent: true }, observed: { label: "alpha", team: "alpha:me.aweb.ai", from: "deployment" } });
  refused(fx.cli(["teams", "default", "beta", "--expect", "oats", "--json"]), "E_TEAM_DEFAULT_MISMATCH", "--expect another");
  refused(fx.cli(["teams", "default", "beta", "--if-absent", "--expect", "alpha", "--json"]), "E_BAD_ARGS", "both");
  refused(fx.cli(["teams", "default", "beta", "--expect", "--json"]), "E_BAD_ARGS", "--expect without a value");
  const plain = fx.cli(["teams", "default", "beta", "--if-absent"]);
  assert.notEqual(plain.status, 0); assert.match(plain.stderr, /the default team is alpha/);
  assert.equal(localText(fx), before, "no refusal wrote");
  doc = ok(fx.cli(["teams", "default", "beta", "--expect", "alpha", "--json"]), "--expect the current default");
  assert.deepEqual(doc.defaultTeam.label, "beta");

  // The workspace's default is the effective default where the local file has none.
  withLocalTeams(fx, base);
  setWorkspace(fx, { defaultTeam: "oats" });
  assert.deepEqual(refused(fx.cli(["teams", "default", "alpha", "--if-absent", "--json"]), "E_TEAM_DEFAULT_MISMATCH", "workspace default").details.observed,
    { label: "oats", team: "oats:oats.aweb.ai", from: "workspace" });
  assert.equal(ok(fx.cli(["teams", "default", "alpha", "--expect", "oats", "--json"]), "--expect the workspace's").defaultTeam.from, "deployment");
});

test("oats teams rejects a flag it does not take (E_USAGE naming it, nothing written); --dir, --json, the read form's --max-age and the kernel's --help are kept", (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  withLocalTeams(fx, BASE_LOCAL(fx), "alpha");
  const before = localText(fx);
  for (const [flagGiven, argv] of [
    ["--if-absent", ["teams", "--if-absent"]], ["--server", ["teams", "--server", "x"]], ["-x", ["teams", "-x"]],
    ["--if-absent", ["teams", "add", "gamma", "--team", "gamma:me.aweb.ai", "--if-absent"]],
    ["--bogus", ["teams", "add", "gamma", "--team", "gamma:me.aweb.ai", "--bogus"]],
    ["--no-default", ["teams", "remove", "beta", "--no-default"]],
    ["--no-default", ["teams", "default", "beta", "--no-default"]], ["--team", ["teams", "default", "beta", "--team", "x:y"]],
    ["--server", ["teams", "default", "beta", "--server", "s"]],
  ]) {
    const err = refused(fx.cli([...argv, "--json"]), "E_USAGE", argv.join(" "));
    assert.ok(err.message.includes(flagGiven), `${argv.join(" ")}: ${err.message}`);
    assert.match(err.message, /usage: oats teams/);
    assert.deepEqual(err.details, { flag: flagGiven });
  }
  // --help/-h after any kernel command is that command's usage (exit 0) before dispatch: teams keeps it.
  for (const argv of [["teams", "--help"], ["teams", "default", "beta", "--if-absent", "-h"]]) {
    assert.deepEqual(ok(fx.cli([...argv, "--json"]), argv.join(" ")).command, "teams");
    const text = fx.cli(argv);
    assert.equal(text.status, 0, text.stderr); assert.match(text.stdout, /oats teams/);
  }
  assert.equal(localText(fx), before, "nothing was written");
  // The global flags each form keeps.
  ok(fx.cli(["teams", "--dir", fx.dep, "--json"], { cwd: fx.base }), "read with --dir");
  ok(fx.cli(["teams", "--max-age", "60", "--json"]), "read with --max-age");
  ok(fx.cli(["teams", "remove", "beta", "--dir", fx.dep, "--json"], { cwd: fx.base }), "remove with --dir");
  ok(fx.cli(["teams", "add", "beta", "--team", "beta:me.aweb.ai", "--description", "B", "--no-default", "--dir", fx.dep, "--json"], { cwd: fx.base }), "add with every flag");
  ok(fx.cli(["teams", "default", "beta", "--expect", "alpha", "--dir", fx.dep, "--json"], { cwd: fx.base }), "default with --dir");
  refused(fx.cli(["teams", "remove", "beta", "--max-age", "5", "--json"]), "E_BAD_ARGS", "--max-age on a mutation keeps its own refusal");
});

test("two processes racing `default --if-absent` with different labels: exactly one wins, the other is E_TEAM_DEFAULT_MISMATCH, the file holds the winner", async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const base = BASE_LOCAL(fx);
  for (let round = 0; round < 4; round++) {
    withLocalTeams(fx, base);
    const runs = await Promise.all(["alpha", "beta"].map((label) => cliAsync(fx, ["teams", "default", label, "--if-absent", "--json"])));
    const answers = runs.map((r) => r.json());
    const winners = answers.filter((a) => a.ok);
    assert.equal(winners.length, 1, `round ${round}: exactly one wins: ${runs.map((r) => r.stdout).join(" | ")}`);
    const loser = answers.find((a) => !a.ok);
    assert.equal(loser.error.code, "E_TEAM_DEFAULT_MISMATCH", `round ${round}: ${JSON.stringify(loser)}`);
    const won = winners[0].result.defaultTeam.label;
    assert.equal(loser.error.details.observed.label, won, "the loser saw the winner's default");
    assert.equal(localYaml(fx).defaultTeam, won, "the file holds the winner");
  }
});
