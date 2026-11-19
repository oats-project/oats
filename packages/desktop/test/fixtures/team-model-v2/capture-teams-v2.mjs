// Team model v2 capture (0.30 D1b, feature team-model-2): the REAL K1 kernel (feat/030-team-model)
// on a scratch Northwind build (the kernel tree's own test/fixtures/northwind/build.mjs). Runs
// `oats teams` / `oats soul teams` with the Desktop's exact argv (option values as ONE
// --flag=value token), their refusals, and every other v2 document the Desktop reads
// (souls, workspace status, capabilities, inspect, preview, status, readiness).
// Isolated HOME/cache/catalog; inert pi/claude/codex stubs satisfy launch resolution for
// --no-launch. No runtime, tmux, network or global state is touched.
// Usage: OUT=out node capture-teams-v2.mjs <kernel-tree>
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [REPO] = process.argv.slice(2);
if (!REPO?.startsWith("/")) throw new Error("repo root required");
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(REPO, "bin/oats.mjs");
const { buildNorthwind } = await import(join(REPO, "test/fixtures/northwind/build.mjs"));
const OUT = join(HERE, process.env.OUT || "out"); rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const scratch = join(HERE, `scratch-${process.pid}`); mkdirSync(scratch, { recursive: true });
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
delete env.TMUX; delete env.OATS_DEFAULT_TEAM; delete env.OATS_TEAM_LABEL;
const kernel = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const commit = process.env.CAPTURE_COMMIT || "unknown";
const redact = s => (s || "").split(base).join("<base>").split(REPO).join("<oats>");

const dep = join(base, "northwind-workspace"); mkdirSync(dep);
const prov = [];
function run(name, args, { expect = 0 } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: base, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  prov.push({ name, argv: ["oats", ...args].map(redact), exit: r.status, kernel, commit, stderrTail: redact(r.stderr).slice(-300) });
  const ok = expect === "any" || (expect === null ? r.status !== 0 : r.status === expect);
  console.log(`${ok ? "ok  " : "FAIL"} ${name} exit=${r.status} (expected ${expect === null ? "a refusal" : expect})`);
  writeFileSync(join(OUT, `${name}.json`), redact(r.stdout));
  if (!ok) console.log(redact(r.stdout).slice(0, 1500), redact(r.stderr).slice(0, 600));
  return r;
}
const result = r => JSON.parse(r.stdout).result;
run("version", ["version", "--json"]);
const onboard = spawnSync(process.execPath, [CLI, "onboard", dep, "--workspace", fx.refs.agents, "--json"], { cwd: base, env, encoding: "utf8" });
console.log(`onboard exit=${onboard.status}`); if (onboard.status) console.log(redact(onboard.stdout).slice(0, 1500));
for (const c of JSON.parse(onboard.stdout).result.next.clone) execFileSync("git", ["clone", "-q", c.url, c.dir], { env, stdio: "ignore" });
const root = join(dep, "agents");
const d = ["--dir", dep, "--json"];

// oats teams: the Desktop's argv (cliTeams).
run("teams-initial", ["teams", ...d]);
run("teams-add", ["teams", "add", "mine", "--team=mine:alex.aweb.ai", "--description=My own team", ...d]);
run("teams-add-exists", ["teams", "add", "mine", "--team=mine:alex.aweb.ai", ...d], { expect: null });
run("teams-add-shared", ["teams", "add", "engineering", "--team=eng:northwind.aweb.ai", ...d], { expect: null });
run("teams-default", ["teams", "default", "mine", ...d]);
// oats soul teams: the Desktop's argv (cliSoulTeams).
run("soul-teams-show", ["soul", "teams", "release-manager", ...d]);
run("soul-teams-add", ["soul", "teams", "release-manager", "--add=mine,engineering", ...d]);
run("soul-teams-default", ["soul", "teams", "release-manager", "--default=engineering", ...d]);
run("soul-teams-star-add", ["soul", "teams", "*", "--add=global", ...d]);
run("soul-teams-star-show", ["soul", "teams", "*", ...d]);
run("soul-teams-unknown", ["soul", "teams", "release-manager", "--add=nope", ...d], { expect: null });
run("soul-teams-star-default", ["soul", "teams", "*", "--default=global", ...d], { expect: null });
run("teams-remove-in-use", ["teams", "remove", "mine", ...d], { expect: null });
run("teams-remove-shared", ["teams", "remove", "engineering", ...d], { expect: null });
run("teams-after", ["teams", ...d]);
// Every other v2 document the Desktop reads, with teams configured.
run("souls", ["souls", ...d]);
run("workspace-status", ["workspace", "status", ...d]);
run("capabilities", ["capabilities", ...d]);
run("inspect-soul", ["inspect", "--dir", dep, "--soul", "release-manager", "--agents-root", root, "--json"]);
run("readiness-soul", ["readiness", "--dir", dep, "--soul", "release-manager", "--agents-root", root, "--policy", "--json"], { expect: "any" });
const spawn = (extra = []) => ["spawn", "release-manager", "--dir", dep, "--agents-root", root, "--purpose", "teams", ...extra];
const preview = result(run("preview", [...spawn(), "--preview", "--json"]));
const applied = run("apply", [...spawn(), "--expect-decision", preview.decision.revision, "--idempotency-key", "e".repeat(64), "--no-launch", "--json"]);
run("status", ["status", "--dir", dep, "--json"]);
run("inspect-home", ["inspect", "--home", result(applied).home, "--json"]);
run("soul-teams-clear-default", ["soul", "teams", "release-manager", "--clear-default", ...d]);
run("teams-final", ["teams", ...d]);

writeFileSync(join(OUT, "provenance.json"), JSON.stringify({ capturedBy: "oats-desktop-engineer for the Desktop team model v2 decoders + routes (0.30 D1b)",
  kernelTree: `oats feat/030-team-model @${commit} (git archive; node_modules linked from a checkout with identical dependencies)`,
  fixture: "test/fixtures/northwind/build.mjs (the kernel tree's own); shared teams global/engineering/marketing (unmapped); a local team `mine`",
  script: "capture-teams-v2.mjs", kernel, documents: prov }, null, 2) + "\n");
rmSync(scratch, { recursive: true, force: true });
