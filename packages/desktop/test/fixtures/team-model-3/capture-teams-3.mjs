// Team model 3 capture (0.38.0, feature team-model-3): the REAL kernel of this repository on a scratch
// Northwind build (test/fixtures/northwind/build.mjs). Runs `oats teams` / `oats soul teams` with the
// Desktop's exact argv (option values as ONE --flag=value token), their refusals, and the team rows of
// the other documents the Desktop reads (souls, readiness, preview), in two phases of the workspace
// file: local teams closed (the default), then `localTeams: true`.
// Isolated HOME/cache/catalog; inert pi/claude/codex stubs satisfy launch resolution for --preview.
// No runtime, tmux, network or global state is touched.
// Usage: CAPTURE_COMMIT=<sha> node capture-teams-3.mjs <repo root>
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [REPO] = process.argv.slice(2);
if (!REPO?.startsWith("/")) throw new Error("repo root required");
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(REPO, "bin/oats.mjs");
const { buildNorthwind, moveMember } = await import(join(REPO, "test/fixtures/northwind/build.mjs"));
const YAML = (await import(join(REPO, "node_modules/yaml/dist/index.js"))).default;
const OUT = HERE;
// Outside any git tree: the kernel resolves a deployment's scope through an enclosing repository.
const scratch = mkdtempSync(join(tmpdir(), "oats-team-model-3-"));
const base = realpathSync(scratch);
const fx = await buildNorthwind(join(base, "fx"));
const catalogFile = join(base, "catalog.json"); writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }, null, 2));
mkdirSync(join(base, "home")); mkdirSync(join(base, "bin"));
for (const b of ["pi", "claude", "codex"]) { writeFileSync(join(base, "bin", b), "#!/bin/sh\nexit 0\n"); chmodSync(join(base, "bin", b), 0o755); }
const env = { ...process.env, PI_AGENT_HOME: "", OATS_HOME: "", PI_AGENTS_ROOT: "", OATS_INSTANCE_HOME: "", OATS_INSTANCE: "",
  OATS_REMOTE_CACHE: join(base, "cache"), HOME: join(base, "home"), OATS_PACKAGE_CATALOG: catalogFile,
  OATS_TMUX_SESSION: `none-${process.pid}`, PI_AGENTS_TMUX_SESSION: `none-${process.pid}`,
  GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", PATH: `${join(base, "bin")}:${process.env.PATH}` };
for (const k of ["TMUX", "TMUX_PANE", "OATS_DEFAULT_TEAM", "OATS_DEFAULT_TEAM_ID", "OATS_TEAMS", "OATS_HOME_DIR"]) delete env[k];
const kernel = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const commit = process.env.CAPTURE_COMMIT || "unknown";
const redact = s => (s || "").split(base).join("<base>").split(REPO).join("<oats>");

const dep = join(base, "northwind-workspace"); mkdirSync(dep);
const prov = [];
function run(name, args, { expect = 0, save = true } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: base, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  prov.push({ name, argv: ["oats", ...args].map(redact), exit: r.status, kernel, commit });
  const ok = expect === "any" || (expect === null ? r.status !== 0 : r.status === expect);
  console.log(`${ok ? "ok  " : "FAIL"} ${name} exit=${r.status} (expected ${expect === null ? "a refusal" : expect})`);
  if (save) writeFileSync(join(OUT, `${name}.json`), redact(r.stdout));
  if (!ok) console.log(redact(r.stdout).slice(0, 1500), redact(r.stderr).slice(0, 600));
  return r;
}
const result = r => JSON.parse(r.stdout).result;
/** Commit a change to the workspace file (the host member `agents`), then let the deployment observe it. */
async function workspaceFile(mutate, message) {
  await moveMember(fx, "agents", async (work) => {
    const file = join(work, "oats-workspace.yaml");
    const doc = YAML.parse(readFileSync(file, "utf8"));
    mutate(doc);
    writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }));
  }, { message });
  run(`sync-${prov.length}`, ["sync", "--dir", dep, "--json"], { expect: "any", save: false });
}
function localFile(mutate) {
  const file = join(dep, "oats-local.yaml");
  const doc = YAML.parse(readFileSync(file, "utf8"));
  mutate(doc);
  writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }));
}

run("version", ["version", "--json"]);
const onboard = spawnSync(process.execPath, [CLI, "onboard", dep, "--workspace", fx.refs.agents, "--json"], { cwd: base, env, encoding: "utf8" });
console.log(`onboard exit=${onboard.status}`); if (onboard.status) console.log(redact(onboard.stdout).slice(0, 1500));
for (const c of JSON.parse(onboard.stdout).result.next.clone) execFileSync("git", ["clone", "-q", c.url, c.dir], { env, stdio: "ignore" });
const root = join(dep, "agents");
const d = ["--dir", dep, "--json"];
const souls = result(run("souls-initial", ["souls", ...d], { save: false }));
// A member soul's key is `<member>/<soul>`, the member named by its repository's name (as souls.disabled names it).
const soul = souls.souls.find((s) => s.name === "release-manager");
const member = soul.repoKey.split("/").pop().replace(/\.git$/, "");
const key = `${member}/${soul.name}`;
console.log(`release-manager key=${key}`);

// Phase 1: shared teams mapped (one unmapped), a workspace defaultTeam, souls: patterns (one a typo), local teams closed.
await workspaceFile((doc) => {
  doc.teams = { global: { team: "global:northwind.aweb.ai", description: doc.teams.global.description },
    engineering: { team: "engineering:northwind.aweb.ai", description: doc.teams.engineering.description },
    marketing: { description: doc.teams.marketing.description } };
  doc.defaultTeam = "global";
  doc.souls = { "*": { teams: [] }, [`${member}/*`]: { teams: ["engineering"] },
    [key]: { default: "engineering", teams: ["marketing"] }, [`${member}/no-such-soul`]: { teams: ["global"] } };
}, "team model 3: teams, defaultTeam, souls");
run("teams-closed", ["teams", ...d]);
run("teams-add-closed", ["teams", "add", "mine", "--team=mine:alex.aweb.ai", "--description=My own team", ...d], { expect: null });
run("teams-default-closed", ["teams", "default", "global", ...d], { expect: null });
run("soul-teams-show", ["soul", "teams", key, ...d]);
run("soul-teams-star-show", ["soul", "teams", "*", ...d]);
run("soul-teams-add-removed", ["soul", "teams", key, "--add=global", ...d], { expect: null });
run("soul-teams-default-removed", ["soul", "teams", key, "--default=global", ...d], { expect: null });
run("soul-teams-clear-default-removed", ["soul", "teams", key, "--clear-default", ...d], { expect: null });
run("souls", ["souls", ...d]);
run("readiness-soul", ["readiness", "--dir", dep, "--soul", key, "--agents-root", root, "--policy", "--json"], { expect: "any" });
run("preview", ["spawn", key, "--dir", dep, "--agents-root", root, "--purpose", "teams", "--preview", "--json"], { expect: "any" });
// Local teams declared while closed: the local-teams-closed failure; remove still runs there.
localFile((doc) => { doc.teams = { mine: { team: "mine:alex.aweb.ai" }, spare: { team: "spare:alex.aweb.ai" } }; });
run("teams-closed-local", ["teams", ...d]);
run("teams-remove-closed", ["teams", "remove", "spare", ...d]);
run("soul-teams-show-closed-local", ["soul", "teams", key, ...d], { expect: "any" });
localFile((doc) => { delete doc.teams; });

// Phase 2: local teams allowed.
await workspaceFile((doc) => { doc.localTeams = true; }, "team model 3: localTeams true");
run("teams-open", ["teams", ...d]);
run("teams-add", ["teams", "add", "mine", "--team=mine:alex.aweb.ai", "--description=My own team", ...d]);
run("teams-add-exists", ["teams", "add", "mine", "--team=mine:alex.aweb.ai", ...d], { expect: null });
run("teams-add-shared", ["teams", "add", "engineering", "--team=eng:northwind.aweb.ai", ...d], { expect: null });
run("teams-default", ["teams", "default", "mine", ...d]);
run("teams-remove-in-use", ["teams", "remove", "mine", ...d], { expect: null });
run("teams-remove-shared", ["teams", "remove", "engineering", ...d], { expect: null });
run("soul-teams-show-local", ["soul", "teams", key, ...d]);
run("soul-teams-star-show-local", ["soul", "teams", "*", ...d]);
run("teams-after", ["teams", ...d]);

writeFileSync(join(OUT, "provenance.json"), JSON.stringify({ capturedBy: "oats-desktop-developer for the Desktop team model 3 adaptation (teamsApi 2, soulTeamsApi 2)",
  kernelTree: `this repository @${commit} (bin/oats.mjs, its own node_modules)`,
  fixture: "test/fixtures/northwind/build.mjs; the host's oats-workspace.yaml given mapped global/engineering, unmapped marketing, defaultTeam global and souls: patterns (one naming no soul), then localTeams: true; local teams mine/spare written to oats-local.yaml while closed",
  script: "capture-teams-3.mjs", kernel, soulKey: key, documents: prov }, null, 2) + "\n");
rmSync(scratch, { recursive: true, force: true });
