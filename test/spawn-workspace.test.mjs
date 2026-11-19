// bin/oats.mjs — the live workspace-model spawn chain as a test (module contract §5/§6,
// decisions 7, 13, 14, 17).
//
// Runs the REAL CLI as a child process over the Northwind fixture (real bare Git remotes,
// real lib/remote.mjs): `oats sync` → `oats spawn <workspace soul> --no-launch --provider …` → the home on disk →
// `spawn --preview` (changedSince) → a member move → `oats status` drift → refusals.
// Never invokes bare `oats setup`; never touches ~/.cache (OATS_REMOTE_CACHE) or the
// operator's HOME; never creates a tmux session (--no-launch + a non-existent session name).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNorthwind, moveMember, dropBacklink } from "./fixtures/northwind/build.mjs";
import { privateTmuxTmpdir, removeTmuxTmpdir } from "./helpers/host-fixture.mjs";
import { inertHarnessPath } from "./helpers/runtime-stub.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
const HEX40 = /^[0-9a-f]{40}$/;

/** A fixture base without whitespace or "@" (repo keys embed it) under the OS temp dir. */
function fixtureBase() {
  const base = mkdtempSync(join(tmpdir(), "oats-spawn-ws-"));
  if (/[\s@]/.test(base)) { rmSync(base, { recursive: true, force: true }); throw new Error(`tmpdir ${base} contains whitespace or @`); }
  return base;
}

/** Where this file's CLI children look for a tmux server (status and spawn ask tmux for its sessions):
 *  a directory of the file, never tmux's default place, where a host's live deployment has its server. */
const TMUX_TMPDIR = privateTmuxTmpdir();
test.after(() => removeTmuxTmpdir(TMUX_TMPDIR));

/** Run the CLI non-interactively: stdin is /dev/null (never a TTY); HOME, cache and catalog are isolated. */
function oats(args, { cwd, env = {}, base }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PATH: inertHarnessPath(base), PI_AGENT_HOME: "", OATS_HOME: "", PI_AGENTS_ROOT: "",
      OATS_REMOTE_CACHE: join(base, "cache"), HOME: join(base, "home"),
      // Never a real tmux session: --no-launch everywhere, and liveness lookups hit a session that does not exist.
      OATS_TMUX_SESSION: `none-${process.pid}`, PI_AGENTS_TMUX_SESSION: `none-${process.pid}`, TMUX_TMPDIR,
      ...env,
    },
  });
}
/** stdout must be exactly one JSON envelope. */
function envelope(r) {
  const doc = JSON.parse(r.stdout);
  assert.equal(r.stdout.trim(), JSON.stringify(doc), "stdout is exactly one compact JSON object");
  assert.equal(doc.schemaVersion, 1);
  return doc;
}
const isDir = (p) => existsSync(p) && statSync(p).isDirectory() && !lstatSync(p).isSymbolicLink();
const isRegular = (p) => existsSync(p) && lstatSync(p).isFile();
const isRelativeLink = (p) => lstatSync(p).isSymbolicLink() && !readlinkSync(p).startsWith("/");

test("workspace spawn chain over Northwind: sync → spawn materializes whole modules, composes AGENTS.md, records provenance/providers; preview changedSince; status drift; refusals", { timeout: 600_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }, null, 2));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    mkdirSync(join(base, "home"));
    // The deployment: <name>-workspace/ with oats-local.yaml naming the workspace host by its bare-repo path.
    const dep = join(base, "northwind-workspace");
    const agentsRoot = join(dep, "agents");
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    const spawnArgs = (soul, ...extra) => ["spawn", soul, "--dir", dep, "--agents-root", agentsRoot, "--purpose", "x", "--work", "directory", "--no-launch", ...extra, "--json"];

    // ---- sync (exit 0, lock written; declaring a package in packages: is the trust decision) ----
    let r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `sync exits 0\n${r.stdout}\n${r.stderr}`);
    assert.equal(envelope(r).ok, true);
    assert.equal("approvalNeeded" in envelope(r).result, false, "the sync report carries no approval step");
    const lockFile = join(dep, "oats-lock.json");
    assert.ok(existsSync(lockFile), "the lock is written");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    assert.equal(lock.lockfileVersion, 3);
    assert.deepEqual(Object.keys(lock.packages), ["nw.tools", "oats.framework", "oats.okf"]);
    assert.ok(Object.values(lock.packages).every((p) => !("approved" in p)), "lock v3 entries carry no approval");

    // ---- Phase C (H5): preview BEFORE any apply of this soul: modules[] listed, soulFetched:true, no instance ----
    r = oats(spawnArgs("release-manager", "--preview", "--provider", "oats.okf", "state-dir=/tmp/x"), { cwd: dep, env, base });
    assert.equal(r.status, 0, `preview before apply\n${r.stdout}\n${r.stderr}`);
    const firstPreview = envelope(r).result;
    assert.equal(firstPreview.preview, true);
    assert.deepEqual(firstPreview.modules.map((m) => m.name).sort(), ["nw-deploy", "nw-house-style", "nw-release-tooling", "oats.core", "oats.okf"]);
    assert.ok(firstPreview.modules.every((m) => m.changedSince === null), "no previous instance → changedSince null");
    assert.equal(firstPreview.soulFetched, true, "the preview fetched the soul SOURCE (to a temporary copy) and says so");
    assert.ok(!existsSync(join(agentsRoot, "release-manager")), "a preview writes no soul copy and no instance under <agents-root>");
    // Addendum 5: a manifest's declared setting default (oats.okf harvest-runtime: pi) is the LOWEST
    // payload layer — the preview shows it with its origin, and the decision binds exactly that payload.
    assert.equal(firstPreview.settings["oats.okf"]["harvest-runtime"], "pi", "the manifest default reaches the merged payload");
    assert.deepEqual(firstPreview.settingsOrigins["oats.okf"]["/harvest-runtime"], { kind: "manifest-default", at: "oats.json#/settings/harvest-runtime/default" });
    assert.deepEqual(firstPreview.settingsOrigins["oats.okf"]["/state-dir"], { kind: "spawn", at: "--provider oats.okf" });
    assert.deepEqual(firstPreview.decision.effective.providers, firstPreview.settings, "the decision binds the previewed payload, defaults included");
    r = oats(spawnArgs("release-manager", "--preview", "--provider", "oats.okf", "state-dir=/tmp/x", "--provider", "oats.okf", "harvest-runtime=claude"), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const overridden = envelope(r).result;
    assert.equal(overridden.settings["oats.okf"]["harvest-runtime"], "claude", "a spawn flag overrides the manifest default");
    assert.equal(overridden.settingsOrigins["oats.okf"]["/harvest-runtime"].kind, "spawn");
    assert.notEqual(overridden.decision.revision, firstPreview.decision.revision, "the override changes the bound decision");
    // Lead decision 2: launch configurations are the deployment's (oats-local.yaml `launch-configs:`),
    // selected by name on a workspace spawn; an undeclared name is refused before anything is written.
    const localText = readFileSync(join(dep, "oats-local.yaml"), "utf8");
    writeFileSync(join(dep, "oats-local.yaml"), `${localText}launch-configs:\n  fast:\n    harness: pi\n    args: ["--x"]\n    model: nw-fast-model\n`);
    r = oats(spawnArgs("release-manager", "--preview", "--launch-config", "fast", "--provider", "oats.okf", "state-dir=/tmp/x"), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const launched = envelope(r).result;
    assert.equal(launched.launchConfig, "fast"); assert.equal(launched.decision.effective.launchConfig, "fast");
    assert.equal(launched.model, "nw-fast-model", "the configuration's model applies");
    r = oats(spawnArgs("release-manager", "--preview", "--launch-config", "nope", "--provider", "oats.okf", "state-dir=/tmp/x"), { cwd: dep, env, base });
    assert.equal(envelope(r).error.code, "E_LAUNCH_CONFIG_UNKNOWN", r.stdout);
    writeFileSync(join(dep, "oats-local.yaml"), localText);
    r = oats(spawnArgs("release-manager", "--preview", "--provider", "oats.okf", "state-dir=/tmp/x"), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(envelope(r).result.soulFetched, true, "every preview before a spawn fetches again: nothing is cached by a preview");
    r = oats(spawnArgs("release-manager", "--preview").filter((a) => a !== "--json"), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^preview release-manager → release-manager-x .*nothing was created \(the soul source was fetched to a temporary copy, not kept\)$/m, "text preview: says the soul copy was temporary");
    assert.ok(!existsSync(join(agentsRoot, "release-manager")), "still nothing under <agents-root>");

    // ---- spawn release-manager with an instance-level provider payload ----
    r = oats(spawnArgs("release-manager", "--provider", "oats.okf", "state-dir=/tmp/x"), { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn\n${r.stdout}\n${r.stderr}`);
    let doc = envelope(r);
    assert.equal(doc.ok, true);
    const spawned = doc.result;
    assert.equal(spawned.instance, "release-manager-x");
    assert.equal(spawned.launched, false);
    assert.match(r.stderr, /workspace soul: "release-manager" from .*agents\.git @ [0-9a-f]{12}; soul source fetched\)/, "progress goes to stderr (the spawn, not the previews, fills the soul cache)");
    const home = spawned.home;
    assert.equal(home, join(agentsRoot, "release-manager", "instances", "release-manager-x"));
    r = oats(spawnArgs("release-manager", "--preview", "--provider", "oats.okf", "state-dir=/tmp/x"), { cwd: dep, env, base });
    assert.equal(envelope(r).result.soulFetched, false, "a preview after the spawn reads the cached copy of the same commit");

    // The home on disk: every module copied WHOLE under .oats/modules/<name>/ (decision 7).
    const modulesDir = join(home, ".oats", "modules");
    const expectedModules = ["nw-deploy", "nw-house-style", "nw-release-tooling", "oats.core", "oats.okf"];
    for (const m of expectedModules) {
      assert.ok(isDir(join(modulesDir, m)), `${m} is a real directory under .oats/modules`);
      assert.ok(isRegular(join(modulesDir, m, "oats.json")), `${m}/oats.json travels with the copy`);
    }
    const deployBin = join(modulesDir, "nw-deploy", "bin", "nw-deploy.mjs");
    assert.ok(isRegular(deployBin), "the package executable is copied");
    assert.equal(statSync(deployBin).mode & 0o777, 0o755, "git mode 755 is preserved on the executable");
    assert.ok(isRegular(join(modulesDir, "nw-release-tooling", "bin", "nw-release.mjs")));
    assert.ok(isRegular(join(modulesDir, "nw-release-tooling", "injects", "release-policy.md")));
    assert.ok(isRegular(join(modulesDir, "nw-house-style", "injects", "house-style.md")));
    // Skills are copied (not symlinked) FLAT to where the harness already looks (decision 13):
    // .agents/skills/<skill>/SKILL.md, one level deep, and the same through .claude/skills.
    for (const skill of ["deploy", "cut-release", "oats-operate", "okf"]) {
      const f = join(home, ".agents", "skills", skill, "SKILL.md");
      assert.ok(isRegular(f), `.agents/skills/${skill}/SKILL.md is a regular file`);
      assert.ok(!lstatSync(join(home, ".agents", "skills", skill)).isSymbolicLink(), `.agents/skills/${skill} is not a symlink`);
      assert.ok(isRegular(join(home, ".claude", "skills", skill, "SKILL.md")), `.claude/skills/${skill}/SKILL.md resolves through the alias`);
    }
    for (const cap of ["nw-deploy", "nw-release-tooling", "oats.core", "oats.okf"]) assert.ok(!existsSync(join(home, ".agents", "skills", cap)), `no grouped .agents/skills/${cap}/`);
    // Composed instructions: soul AGENTS.md + each module's inject (nw-deploy has none), the soul's own in its
    // listing order, then the workspace defaults in the workspace's order; the kernel's blocks close the file.
    const agentsMd = readFileSync(join(home, "AGENTS.md"), "utf8");
    const markers = agentsMd.match(/<!-- oats:capability:[^ ]+/g) || [];
    assert.deepEqual(markers, ["<!-- oats:capability:nw-release-tooling", "<!-- oats:capability:oats.core", "<!-- oats:capability:nw-house-style", "<!-- oats:capability:oats.okf"]);
    assert.deepEqual((agentsMd.match(/<!-- oats:\S+/g) || []).slice(-2), ["<!-- oats:kernel:instance-boundary", "<!-- oats:work-mode:directory"], "the kernel's blocks are last");
    // Canonical-plus-alias construction (relative symlinks).
    assert.ok(isRelativeLink(join(home, "CLAUDE.md")), "CLAUDE.md is a relative symlink");
    assert.equal(readlinkSync(join(home, "CLAUDE.md")), "AGENTS.md");
    assert.ok(isRelativeLink(join(home, ".claude", "skills")), ".claude/skills is a relative symlink");
    assert.equal(readlinkSync(join(home, ".claude", "skills")), join("..", ".agents", "skills"));

    // instance.json records provenance (from/commit/digest), providers and the resolution revision.
    const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
    assert.deepEqual(Object.keys(meta.modules).sort(), expectedModules);
    for (const [name, rec] of Object.entries(meta.modules)) {
      assert.ok(["member", "package"].includes(rec.from.kind), `${name}: from.kind`);
      assert.match(rec.commit, HEX40, `${name}: commit is a full OID`);
      assert.match(rec.from.commit, HEX40, `${name}: from.commit is a full OID`);
      assert.match(rec.digest, /^sha256-[0-9a-f]{64}$/, `${name}: digest`);
    }
    assert.equal(meta.modules["nw-deploy"].from.kind, "package"); assert.equal(meta.modules["nw-deploy"].from.package, "nw.tools"); assert.equal(meta.modules["nw-deploy"].from.version, "0.4.0");
    assert.equal(meta.modules["nw-deploy"].commit, fx.commits["nw-tools"], "non-collapse: nw-deploy comes from the nw.tools package at the locked tag");
    assert.equal(meta.modules["oats.okf"].from.kind, "package"); assert.equal(meta.modules["oats.okf"].commit, fx.commits["pkg-okf"]);
    assert.equal(meta.modules["nw-house-style"].from.kind, "member"); assert.equal(meta.modules["nw-house-style"].from.repoKey, fx.keys.agents); assert.equal(meta.modules["nw-house-style"].commit, fx.commits.agents);
    assert.equal(meta.modules["nw-release-tooling"].from.kind, "member"); assert.equal(meta.modules["nw-release-tooling"].from.repoKey, fx.keys.agents);
    assert.equal(meta.providers["oats.okf"]["state-dir"], "/tmp/x", "the --provider payload is recorded under providers.<cap>");
    assert.equal(meta.providers["oats.okf"]["harvest-runtime"], "pi", "the provider receives the manifest default it was previewed with");
    assert.equal(meta.providers["oats.okf"].owns, "release-manager", "…merged over the soul's own payload");
    assert.match(meta.workspace.resolution, /^[0-9a-f]{24}$/, "the resolution revision is recorded");
    assert.equal(meta.workspace.soul.repoKey, fx.keys.agents); assert.equal("team" in meta.workspace.soul, false, "a soul's teams are the workspace's souls:, never the soul's");
    assert.deepEqual([meta.teams, meta.defaultTeam], [[], null], "this deployment declares no teams");
    // M5/3a: the workspace's name and the deployment directory are recorded at spawn.
    assert.equal(meta.workspace.name, "northwind"); assert.equal(meta.workspace.deployment, dep);
    // Harness starts normally: no ambient-skill exclusion anywhere in the launch.
    const launchText = `${meta.command || ""} ${JSON.stringify(meta.launch || {})} ${JSON.stringify(spawned.launch || {})}`;
    assert.ok(!launchText.includes("--no-skills"), "the launch has no --no-skills");
    assert.ok(!/skills?-?(exclude|profile)/i.test(launchText), "no skill exclusion arguments/profile keys");
    // The soul source was copied under <agents-root>/<soul>/soul/ for the classic skeleton.
    assert.ok(isRegular(join(agentsRoot, "release-manager", "soul", "soul.yaml")));
    assert.ok(isRegular(join(agentsRoot, "release-manager", "soul", "AGENTS.md")));

    // ---- Phase C (H2): the soul copy is a per-commit cache — a later spawn sees the member's CURRENT soul ----
    const stampFile = join(agentsRoot, "release-manager", ".oats-soul-source.json");
    const stampBefore = JSON.parse(readFileSync(stampFile, "utf8"));
    assert.equal(stampBefore.commit, fx.commits.agents);
    assert.equal(meta.workspace.soul.commit, stampBefore.commit, "instance.json.workspace.soul.commit == the stamp commit");
    const soulMove = await moveMember(fx, "agents", async (work, { fs, path }) => {
      await fs.appendFile(path.join(work, "souls", "release-manager", "AGENTS.md"), "\nH2: release policy revised after the first spawn.\n");
    }, { message: "agents: revise release-manager soul" });
    assert.notEqual(soulMove.commit, stampBefore.commit);
    r = oats(spawnArgs("release-manager", "--provider", "oats.okf", "state-dir=/tmp/x").map((a) => (a === "x" ? "h2" : a)), { cwd: dep, env, base });
    assert.equal(r.status, 0, `second spawn after the soul moved\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /workspace soul: "release-manager" from .*agents\.git @ [0-9a-f]{12}; soul source fetched\)/, "the moved soul is fetched again");
    const homeH2 = envelope(r).result.home;
    assert.equal(homeH2, join(agentsRoot, "release-manager", "instances", "release-manager-h2"));
    assert.match(readFileSync(join(homeH2, "AGENTS.md"), "utf8"), /H2: release policy revised after the first spawn\./, "the new home is composed from the CURRENT soul");
    assert.doesNotMatch(readFileSync(join(home, "AGENTS.md"), "utf8"), /H2: release policy revised/, "the first instance never changes under itself (decision 7)");
    const stampAfter = JSON.parse(readFileSync(stampFile, "utf8"));
    assert.equal(stampAfter.commit, soulMove.commit, "the soul stamp follows the member");
    const metaH2 = JSON.parse(readFileSync(join(homeH2, "instance.json"), "utf8"));
    assert.equal(metaH2.workspace.soul.commit, soulMove.commit, "instance.json.workspace.soul.commit == the refreshed stamp commit");
    assert.match(readFileSync(join(agentsRoot, "release-manager", "soul", "AGENTS.md"), "utf8"), /H2: release policy revised/, "the soul copy under <agents-root>/<soul>/soul/ is refreshed");
    // The member's OTHER items moved with that commit too: nw-house-style / nw-release-tooling are member-tier.
    assert.equal(metaH2.modules["nw-house-style"].commit, soulMove.commit);

    // ---- preview: modules[] with changedSince false against the NEWEST instance (release-manager-h2) ----
    const rmProvider = ["--provider", "oats.okf", "state-dir=/tmp/x"];
    r = oats(spawnArgs("release-manager", "--preview", ...rmProvider), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    doc = envelope(r);
    let preview = doc.result;
    assert.equal(preview.preview, true); assert.equal(preview.spawnPreviewApi, 2);
    assert.equal("team" in preview, false, "no primary label since 0.30");
    assert.deepEqual([preview.teams, preview.defaultTeam], [[], null]);
    assert.equal(preview.resolution, metaH2.workspace.resolution, "same inputs (incl. the provider payload) → same revision");
    assert.equal(preview.decision?.resolution, metaH2.workspace.resolution, "the decision binds the resolution revision");
    assert.notEqual(metaH2.workspace.resolution, meta.workspace.resolution, "the member move changed the revision of the member-tier modules");
    r = oats(spawnArgs("release-manager", "--preview"), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.notEqual(envelope(r).result.resolution, metaH2.workspace.resolution, "the instance-level payload is part of the revision (decision 14)");
    assert.deepEqual(preview.modules.map((m) => m.name).sort(), expectedModules);
    assert.ok(preview.modules.every((m) => m.changedSince === false), `nothing changed since release-manager-h2: ${JSON.stringify(preview.modules.map((m) => [m.name, m.changedSince]))}`);
    assert.equal(preview.modules.find((m) => m.name === "oats.okf").layer, "knowledge");
    assert.ok(!existsSync(join(agentsRoot, "release-manager", "instances", "release-manager-x2")), "a preview creates nothing");

    // ---- spawn tools-expert once BEFORE the move (so status can show 'moved' for nw-tools-dev) ----
    r = oats(spawnArgs("tools-expert"), { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn tools-expert\n${r.stdout}\n${r.stderr}`);
    const toolsHome = envelope(r).result.home;
    const toolsMeta = JSON.parse(readFileSync(join(toolsHome, "instance.json"), "utf8"));
    assert.deepEqual(Object.keys(toolsMeta.modules).sort(), ["nw-house-style", "nw-lint", "nw-release-tooling", "nw-tools-dev", "oats.core", "oats.okf"]);
    assert.equal(toolsMeta.modules["nw-tools-dev"].from.kind, "member"); assert.equal(toolsMeta.modules["nw-tools-dev"].commit, fx.commits["nw-tools"]);
    assert.equal(toolsMeta.modules["nw-lint"].from.kind, "package", "non-collapse: nw-lint is package-tier even though nw-tools is a member");
    assert.ok(isRegular(join(toolsHome, ".agents", "skills", "package-conventions", "SKILL.md")));

    // ---- status before the nw-tools move: release-manager-x (spawned before the agents soul move) shows the
    // agents member moved (H2 above); release-manager-h2 and tools-expert-x are current ----
    r = oats(["status", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let st = JSON.parse(r.stdout);
    assert.deepEqual(st.workspace, { reachable: true, key: fx.keys.agents, ref: fx.refs.agents, keyFrom: "workspace", standalone: false, defaultTeam: null,
      teams: { engineering: null, global: null, marketing: null }, teamsFrom: "observed" });
    const instanceOf = (payload, name) => payload.agents.flatMap((a) => a.instances).find((i) => i.instance === name);
    let rm = instanceOf(st, "release-manager-h2");
    assert.ok(Array.isArray(rm.modules) && rm.modules.length === 5, "--json: instances[].modules[] has 5 rows");
    assert.ok(rm.modules.every((m) => m.status === "current"), JSON.stringify(rm.modules.map((m) => [m.name, m.status])));
    const rmOld = instanceOf(st, "release-manager-x");
    assert.equal(rmOld.modules.find((m) => m.name === "nw-house-style").status, "moved", "the first instance records the agents member before the soul move");
    assert.equal(rmOld.modules.find((m) => m.name === "nw-deploy").status, "current");
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /unreachable/);
    assert.doesNotMatch(r.stdout, /nw-tools-dev/, "nothing of nw-tools moved yet");
    r = oats(["status", "--dir", dep, "--verbose"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`modules: nw-house-style from agents @ ${fx.commits.agents.slice(0, 7)}$`, "m"), "--verbose lists every module (release-manager-h2 is at the current agents commit)");
    assert.match(r.stdout, new RegExp(`modules: nw-deploy from package nw\\.tools v0\\.4\\.0 @ ${fx.commits["nw-tools"].slice(0, 7)}$`, "m"));
    assert.doesNotMatch(r.stdout, /no longer present/);

    // ---- move nw-tools (edit the MEMBER capability); the package tag does not move ----
    const move = await moveMember(fx, "nw-tools", async (work, { fs, path }) => {
      await fs.appendFile(path.join(work, "capabilities", "nw-tools-dev", "injects", "nw-tools-dev.md"), "\nMoved: conventions v2.\n");
    });
    assert.match(move.commit, HEX40); assert.notEqual(move.commit, move.previous);

    // release-manager: nw-deploy is PACKAGE-tier (pinned at the tag) → unchanged; nothing else moved.
    r = oats(spawnArgs("release-manager", "--preview", ...rmProvider), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    preview = envelope(r).result;
    assert.equal(preview.modules.find((m) => m.name === "nw-deploy").changedSince, false, "a member move never touches the package pinned from that repo");
    assert.equal(preview.modules.find((m) => m.name === "nw-deploy").from.commit, fx.tags["nw-tools"].commit);
    assert.ok(preview.modules.every((m) => m.changedSince === false));
    assert.equal(preview.resolution, metaH2.workspace.resolution, "release-manager's revision is unchanged by the nw-tools move");
    // tools-expert: nw-tools-dev is MEMBER-tier → changedSince names the previous instance and its commit.
    r = oats(spawnArgs("tools-expert", "--preview"), { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    preview = envelope(r).result;
    const dev = preview.modules.find((m) => m.name === "nw-tools-dev");
    assert.deepEqual(dev.changedSince, { instance: "tools-expert-x", was: move.previous });
    assert.equal(dev.from.commit, move.commit, "the preview resolves the member's latest state");
    assert.equal(preview.modules.find((m) => m.name === "nw-lint").changedSince, false, "nw-lint (package) did not move");
    assert.notEqual(preview.resolution, toolsMeta.workspace.resolution, "a moved member changes the revision (→ E_DECISION_STALE for a stale confirmed preview)");
    // A confirmed decision from before the move is stale now: nothing is created.
    r = oats(spawnArgs("tools-expert", "--expect-decision", "0".repeat(24)), { cwd: dep, env, base });
    assert.equal(r.status, 1); assert.equal(envelope(r).error.code, "E_DECISION_STALE");
    assert.ok(!existsSync(join(agentsRoot, "tools-expert", "instances", "tools-expert-x2")));

    // ---- status after the move: drift shown, not prevented (decision 17) ----
    r = oats(["status", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    st = JSON.parse(r.stdout);
    rm = instanceOf(st, "release-manager-h2");
    assert.equal(rm.modules.length, 5);
    assert.ok(!rm.modules.some((m) => m.name === "nw-tools-dev"), "release-manager never had nw-tools-dev");
    assert.ok(rm.modules.every((m) => m.status === "current"), `release-manager is unaffected by the move: ${JSON.stringify(rm.modules.map((m) => [m.name, m.status]))}`);
    const te = instanceOf(st, "tools-expert-x");
    const teDev = te.modules.find((m) => m.name === "nw-tools-dev");
    assert.equal(teDev.status, "moved"); assert.equal(teDev.commit, move.previous); assert.equal(teDev.current.commit, move.commit);
    assert.equal(te.modules.find((m) => m.name === "nw-lint").status, "current", "the package is pinned: no drift");
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`modules: nw-tools-dev from nw-tools @ ${move.previous.slice(0, 7)} {2}\\[member moved since \\(now @ ${move.commit.slice(0, 7)}\\)\\]`));
    // Default view: only moved/missing rows — nw-tools-dev (tools-expert-x) plus release-manager-x's two agents-tier modules moved by the H2 soul commit.
    assert.equal((r.stdout.match(/modules: nw-tools-dev/g) || []).length, 1, "the moved nw-tools module appears once");
    assert.equal((r.stdout.match(/modules:/g) || []).length, 3, "only moved modules appear in the default view (nw-tools-dev + release-manager-x's nw-house-style/nw-release-tooling)");

    // ---- a capability removed from a member → 'capability no longer present' ----
    await moveMember(fx, "nw-tools", async (work, { fs, path }) => { await fs.rm(path.join(work, "capabilities", "nw-tools-dev"), { recursive: true }); });
    r = oats(["status", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    st = JSON.parse(r.stdout);
    const gone = instanceOf(st, "tools-expert-x").modules.find((m) => m.name === "nw-tools-dev");
    assert.equal(gone.status, "missing"); assert.equal(gone.reason, "capability-absent");
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.match(r.stdout, /modules: nw-tools-dev from nw-tools @ [0-9a-f]{7} {2}\[capability no longer present\]/);

    // ---- a soul in an unconfirmed member (backlink dropped) cannot be spawned ----
    await dropBacklink(fx, "platform");
    r = oats(spawnArgs("platform-engineer"), { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const unconfirmed = envelope(r).error;
    assert.ok(["E_SOUL_UNKNOWN", "E_MEMBERSHIP_UNCONFIRMED"].includes(unconfirmed.code), `got ${unconfirmed.code}: ${unconfirmed.message}`);
    // Reported for the record: the unconfirmed member contributes nothing but its row, so the soul is not
    // discovered at all (E_SOUL_UNKNOWN) rather than found-then-gated (E_MEMBERSHIP_UNCONFIRMED).
    assert.ok(!existsSync(join(agentsRoot, "platform-engineer")), "nothing is created for a refused soul");

    // ---- --provider naming a capability the soul does not resolve → E_CAPABILITY_MISSING ----
    r = oats(spawnArgs("release-manager", "--provider", "oats.aweb", "x=y"), { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const missing = envelope(r).error;
    assert.equal(missing.code, "E_CAPABILITY_MISSING");
    assert.equal(missing.details?.capability, "oats.aweb");
    assert.ok(!existsSync(join(agentsRoot, "release-manager", "instances", "release-manager-x2")), "nothing is created");

    // ---- offline: an unreachable workspace host → status still answers, drift unknown ----
    // Point the deployment at a workspace host that cannot be read (a non-existent bare repo) in a
    // sibling deployment sharing the same agents root layout.
    const offline = join(base, "offline-workspace");
    mkdirSync(join(offline, "agents"), { recursive: true });
    writeFileSync(join(offline, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${join(base, "nowhere.git")}\n`);
    // Carry one materialized instance over so drift has something to compute against.
    spawnSync("cp", ["-R", join(agentsRoot, "release-manager"), join(offline, "agents", "release-manager")]);
    r = oats(["status", "--dir", offline], { cwd: offline, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /workspace: unreachable \(.+\) — drift unknown/);
    assert.match(r.stdout, /release-manager-x/);
    r = oats(["status", "--dir", offline, "--json"], { cwd: offline, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    st = JSON.parse(r.stdout);
    assert.equal(st.workspace.reachable, false);
    assert.equal(st.workspace.code, "E_REMOTE_UNREADABLE");
    assert.ok(!Array.isArray(instanceOf(st, "release-manager-x").modules), "without discovery, modules stay the recorded map (no drift rows)");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- 0.25.1 B2: `work: workspace` on a v2 deployment — ./work is the deployment directory ----
// Contract (docs/design/2026-09-23-workspace-module-contracts.md, "Post-0.25.0 clarifications"): a coordination
// soul's ./work is the deployment boundary — the directory holding oats-local.yaml (the taught <name>-workspace/,
// member clones beside it), NOT a Git tree: no branch recorded, no `team:` scope or oats-config.yaml required.
// A v2 `work: workspace` soul is committed into the Northwind agents member (moveMember shows how) and spawned
// through the real CLI; the classic (non-prepared) workspace-mode path is exercised by directory-work-mode.test.mjs.
test("B2: a v2 `work: workspace` soul spawns on a plain deployment — home/work → the oats-local.yaml directory, no branch, no oats-config.yaml", { timeout: 600_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }, null, 2));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    mkdirSync(join(base, "home"));
    const dep = join(base, "northwind-workspace");
    const agentsRoot = join(dep, "agents");
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    assert.ok(!existsSync(join(dep, ".git")) && !existsSync(join(dep, "oats-config.yaml")), "the deployment is a plain directory: no Git, no oats-config.yaml");
    // The coordination soul lives in the agents member.
    const added = await moveMember(fx, "agents", async (work, { fs, path }) => {
      await fs.mkdir(path.join(work, "souls", "coordinator"), { recursive: true });
      await fs.writeFile(path.join(work, "souls", "coordinator", "soul.yaml"), "schemaVersion: 2\nname: coordinator\ndescription: cross-repo coordinator — routes work, edits nothing\nwork: workspace\ncapabilities:\n  oats.core: { from: package }\n");
      await fs.writeFile(path.join(work, "souls", "coordinator", "AGENTS.md"), "# coordinator\n\nYou coordinate across member clones; ./work is the deployment boundary.\n");
    }, { message: "agents: add coordinator (work: workspace)" });
    assert.match(added.commit, HEX40);
    let r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `sync\n${r.stdout}\n${r.stderr}`);
    // spawn: no --work override, no --repo — the soul's `work: workspace` decides
    r = oats(["spawn", "coordinator", "--dir", dep, "--agents-root", agentsRoot, "--purpose", "b2", "--no-launch", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn coordinator\n${r.stdout}\n${r.stderr}`);
    const doc = envelope(r);
    assert.equal(doc.ok, true);
    const home = doc.result.home;
    assert.equal(home, join(agentsRoot, "coordinator", "instances", "coordinator-b2"));
    assert.equal(doc.result.work, "workspace");
    assert.ok(lstatSync(join(home, "work")).isSymbolicLink(), "home/work is a link (the deployment is nobody's to own)");
    assert.equal(realpathSync(join(home, "work")), realpathSync(dep), "home/work → the directory holding oats-local.yaml");
    assert.ok(existsSync(join(home, "work", "oats-local.yaml")), "…so ./work/oats-local.yaml is the deployment's");
    const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
    assert.equal(meta.work, "workspace");
    assert.ok(meta.branch === undefined || meta.branch === null, `no branch is recorded for a workspace boundary (got ${JSON.stringify(meta.branch)})`);
    assert.equal(meta.workspace.soul.commit, added.commit);
    assert.equal("team" in meta.workspace.soul, false);
    assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /oats:work-mode:workspace/, "the workspace work-mode briefing is composed in");
    // The M1 soul cache shape holds for this soul too: the home records souls/<commit12>/ (no soul link), agents/<name>/soul is the pointer.
    assert.throws(() => lstatSync(join(home, "soul")), { code: "ENOENT" }, "an instance home carries no soul link");
    assert.equal(meta.soulDir, realpathSync(join(agentsRoot, "coordinator", "souls", added.commit.slice(0, 12))));
    assert.ok(lstatSync(join(agentsRoot, "coordinator", "soul")).isSymbolicLink());
    // preview is fine on the same soul (nothing created)
    r = oats(["spawn", "coordinator", "--dir", dep, "--agents-root", agentsRoot, "--purpose", "b2p", "--no-launch", "--preview", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `preview coordinator\n${r.stdout}\n${r.stderr}`);
    assert.equal(envelope(r).result.work, "workspace");
    assert.ok(!existsSync(join(agentsRoot, "coordinator", "instances", "coordinator-b2p")));
    // classic root unchanged: a spawn of a checkout-mode soul still records its branch
    r = oats(["spawn", "release-manager", "--dir", dep, "--agents-root", agentsRoot, "--purpose", "rm", "--work", "directory", "--no-launch", "--provider", "oats.okf", "state-dir=/tmp/x", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn release-manager (directory)\n${r.stdout}\n${r.stderr}`);
    assert.ok(isDir(join(envelope(r).result.home, "work")), "directory mode still owns a real ./work");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- 0.25.2 R1/R2: member clones through oats-local.yaml + the convention path; sync creates agents/ ----
// docs/workspaces.md, docs/configuration.md and `oats onboard` all say "the kernel finds a member's clone
// through oats-local.yaml (`clones:`) or at <deployment>/<member name>"; 0.25.0/1 never read either, so every
// `work: worktree|checkout` spawn/preview of a workspace soul failed "has no repo configured" until --repo was
// given. And a hand-written oats-local.yaml + `oats sync` left no agents/, so spawn answered E_NO_DEPLOYMENT with
// a v1 remedy (`oats create --local`). Northwind's platform-engineer is `work: worktree` in the platform member.
test("R1/R2: worktree soul finds its clone — convention <dep>/<member>, clones: entry, E_CLONE_MISMATCH, E_CLONE_MISSING (both remedies), --repo wins; sync creates agents/", { timeout: 600_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }, null, 2));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    mkdirSync(join(base, "home"));
    // The operator's hand-written deployment: oats-local.yaml only — NO agents/.
    const dep = join(base, "northwind-workspace");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    const agentsRoot = join(dep, "agents");
    const spawnArgs = (purpose, ...extra) => ["spawn", "platform-engineer", "--dir", dep, "--purpose", purpose, "--no-launch", ...extra, "--json"];

    // R2 (remedy): before any sync, spawn names the missing instance root and how to get it — not a v1 verb.
    let r = oats(spawnArgs("pre"), { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    let err = envelope(r).error;
    assert.equal(err.code, "E_NO_DEPLOYMENT");
    assert.match(err.message, new RegExp(`mkdir ${agentsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(or run \`oats sync`));
    assert.doesNotMatch(err.message, /oats create/);

    // R2 (sync): `oats sync` creates <deployment>/agents/ — the deployment is complete after the guide's §3–§4.
    r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `sync\n${r.stdout}\n${r.stderr}`);
    assert.ok(isDir(agentsRoot), "sync created <deployment>/agents/");

    // R1 (nothing on this machine): preview AND apply refuse E_CLONE_MISSING, naming BOTH remedies and --repo.
    const conventionDir = join(dep, "platform");
    for (const extra of [["--preview"], []]) {
      r = oats(spawnArgs("none", ...extra), { cwd: dep, env, base });
      assert.equal(r.status, 1, `${extra.join(" ")}\n${r.stdout}\n${r.stderr}`);
      err = envelope(r).error;
      assert.equal(err.code, "E_CLONE_MISSING", `${extra.join(" ")}: ${err.message}`);
      assert.match(err.message, new RegExp(`git clone ${fx.refs.platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${conventionDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "remedy 1: git clone <url> <deployment>/<member name>");
      assert.match(err.message, new RegExp(`clones: \\{ ${fx.keys.platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: <abs path> \\}`), "remedy 2: the oats-local.yaml clones: entry");
      assert.match(err.message, /--repo <path>/, "…and --repo for a one-off");
      assert.equal(err.details.repoKey, fx.keys.platform); assert.equal(err.details.convention, conventionDir); assert.equal(err.details.work, "worktree");
    }
    assert.ok(!existsSync(join(agentsRoot, "platform-engineer", "instances")), "a refused spawn leaves no instance");

    // R1 (wrong repo at the convention path): E_CLONE_MISMATCH — never silently work in it.
    spawnSync("git", ["clone", "-q", fx.refs.data, conventionDir], { encoding: "utf8" });
    r = oats(spawnArgs("wrong", "--preview"), { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    err = envelope(r).error;
    assert.equal(err.code, "E_CLONE_MISMATCH");
    assert.equal(err.details.path, conventionDir); assert.equal(err.details.expected, fx.keys.platform);
    assert.deepEqual(err.details.found, [fx.keys.data]);
    rmSync(conventionDir, { recursive: true, force: true });

    // R1 (the convention): clone platform at <deployment>/platform → preview and apply succeed with no --repo.
    spawnSync("git", ["clone", "-q", fx.refs.platform, conventionDir], { encoding: "utf8" });
    r = oats(spawnArgs("conv", "--preview"), { cwd: dep, env, base });
    assert.equal(r.status, 0, `preview via convention\n${r.stdout}\n${r.stderr}`);
    assert.equal(envelope(r).result.work, "worktree");
    assert.equal(realpathSync(envelope(r).result.repo), realpathSync(conventionDir), "the preview resolves the same clone the apply will use");
    r = oats(spawnArgs("conv"), { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn via convention\n${r.stdout}\n${r.stderr}`);
    let spawned = envelope(r).result;
    assert.equal(spawned.work, "worktree");
    assert.equal(realpathSync(spawned.repo), realpathSync(conventionDir));
    assert.equal(spawned.branch, "agents/platform-engineer-conv");
    const wt = join(spawned.home, "work");
    assert.equal(spawnSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim(), "agents/platform-engineer-conv", "home/work is a worktree of the member clone");
    assert.equal(realpathSync(spawnSync("git", ["-C", wt, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim()), realpathSync(join(conventionDir, ".git")));
    assert.ok(existsSync(join(wt, "souls", "platform-engineer", "soul.yaml")), "…and it is the platform member's tree");

    // R1 (clones: entry): the clone lives elsewhere, named in oats-local.yaml → succeeds, no --repo.
    rmSync(conventionDir, { recursive: true, force: true });
    const elsewhere = join(base, "elsewhere", "plat");
    spawnSync("git", ["clone", "-q", fx.refs.platform, elsewhere], { encoding: "utf8" });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\nclones:\n  "${fx.keys.platform}": ${elsewhere}\n`);
    r = oats(spawnArgs("cl"), { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn via clones:\n${r.stdout}\n${r.stderr}`);
    spawned = envelope(r).result;
    assert.equal(realpathSync(spawned.repo), realpathSync(elsewhere));
    assert.equal(realpathSync(spawnSync("git", ["-C", join(spawned.home, "work"), "rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim()), realpathSync(join(elsewhere, ".git")));

    // R1 (clones: entry pointing at the wrong repo): E_CLONE_MISMATCH names the entry.
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\nclones:\n  "${fx.keys.platform}": ${fx.refs.data}\n`);
    r = oats(spawnArgs("clw", "--preview"), { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    err = envelope(r).error;
    assert.equal(err.code, "E_CLONE_MISMATCH"); assert.match(err.details.via, /clones:/);

    // R1 (--repo wins): an explicit --repo overrides the (wrong) clones: entry.
    r = oats(spawnArgs("flag", "--repo", elsewhere), { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn with --repo\n${r.stdout}\n${r.stderr}`);
    assert.equal(realpathSync(envelope(r).result.repo), realpathSync(elsewhere));

    // Other work modes are untouched: a directory-mode spawn needs no clone.
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    r = oats(["spawn", "release-manager", "--dir", dep, "--purpose", "d", "--work", "directory", "--no-launch", "--provider", "oats.okf", "state-dir=/tmp/x", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `directory spawn\n${r.stdout}\n${r.stderr}`);
    assert.equal(envelope(r).result.work, "directory");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- lane 3 (0.25.2) ----
// R4 (decision 17 for the SOUL SOURCE): `oats status` reports each instance's soul row — the member
// and commit the soul was fetched from (instance.json.workspace.soul) against the member's CURRENT
// commit — and the roster's `[work: …, repo: …]` names the member @ commit for a workspace soul
// instead of `?`. The operator's shape: a soul whose modules are ALL package-tier (support-triager →
// oats.core only). A soul-only member move changes no module row, so before this fix `oats status`
// printed nothing at all for it; the soul row is the one signal.
test("0.25.2 R4: status shows the soul source per instance (moved / no longer present), repo: <member> @ <c7> for workspace souls, --json instances[].soul", { timeout: 600_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }, null, 2));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    mkdirSync(join(base, "home"));
    const dep = join(base, "dep");
    const agentsRoot = join(dep, "agents");
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    let r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // The operator's way: no --agents-root, cwd = the deployment (homes land under <dep>/agents).
    r = oats(["spawn", "support-triager", "--purpose", "x", "--no-launch", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn support-triager\n${r.stdout}\n${r.stderr}`);
    const home = envelope(r).result.home;
    assert.equal(realpathSync(home), realpathSync(join(agentsRoot, "support-triager", "instances", "support-triager-x")), "the home lands under <dep>/agents (cwd = the deployment, no --agents-root)");
    const meta = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
    assert.deepEqual(Object.keys(meta.modules), ["oats.core"], "every module of this soul is package-tier: no member module can ever show drift");
    assert.equal(meta.workspace.soul.commit, fx.commits.agents);
    const c0 = fx.commits.agents;

    // (c) the roster line: a workspace soul names its member @ commit, never `repo: ?`.
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^  support-triager  \\[work: directory, repo: agents @ ${c0.slice(0, 7)}\\]$`, "m"), `repo: names the member and commit\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /repo: \?/);
    assert.doesNotMatch(r.stdout, /soul: /, "default view: a current soul prints no row");
    // (a) --verbose lists the soul row even when current; --json carries it.
    r = oats(["status", "--dir", dep, "--verbose"], { cwd: dep, env, base });
    assert.match(r.stdout, new RegExp(`^ {10}soul: support-triager from agents @ ${c0.slice(0, 7)}$`, "m"), r.stdout);
    assert.match(r.stdout, /^ {10}modules: oats\.core from package oats\.framework v1\.1\.3 @ [0-9a-f]{7}$/m);
    r = oats(["status", "--dir", dep, "--json"], { cwd: dep, env, base });
    let st = JSON.parse(r.stdout);
    const agentRow = () => st.agents.find((a) => a.name === "support-triager");
    const instRow = () => agentRow().instances.find((i) => i.instance === "support-triager-x");
    assert.deepEqual(instRow().soul, { repoKey: meta.workspace.soul.repoKey, commit: c0, current: c0, status: "current" });
    assert.equal(agentRow().soulSource.status, "current");

    // (b) the SOUL SOURCE moves (only souls/support-triager/AGENTS.md changes): no module row can move —
    // the soul row is what reports it, in the default view, and the roster line says the member moved on.
    const move = await moveMember(fx, "agents", async (work, { fs, path }) => { await fs.appendFile(path.join(work, "souls", "support-triager", "AGENTS.md"), "\nMoved.\n"); });
    assert.notEqual(move.commit, c0);
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^ {10}soul: support-triager from agents @ ${c0.slice(0, 7)} {2}\\[member moved since \\(now @ ${move.commit.slice(0, 7)}\\)\\]$`, "m"), `the moved soul row prints in the DEFAULT view\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /modules: /, "no module moved (all package-tier) — the soul row is the only drift line");
    assert.match(r.stdout, new RegExp(`repo: agents @ ${c0.slice(0, 7)} \\(member now @ ${move.commit.slice(0, 7)}\\)\\]`), "the roster's repo: column shows the pointer lagging the member");
    r = oats(["status", "--dir", dep, "--json"], { cwd: dep, env, base });
    st = JSON.parse(r.stdout);
    assert.deepEqual(instRow().soul, { repoKey: meta.workspace.soul.repoKey, commit: c0, current: move.commit, status: "moved" });
    assert.deepEqual(instRow().modules.map((m) => m.status), ["current"]);
    assert.equal(agentRow().soulSource.status, "moved"); assert.equal(agentRow().soulSource.current, move.commit);

    // (b') a member move that edits a MEMBER capability of a soul with member-tier modules: the module
    // row prints too (the operator's "modules rows did not print" is the package-only shape, not a swallow).
    r = oats(["spawn", "release-manager", "--purpose", "rm", "--work", "directory", "--no-launch", "--provider", "oats.okf", "state-dir=/tmp/x", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `spawn release-manager\n${r.stdout}\n${r.stderr}`);
    const move2 = await moveMember(fx, "agents", async (work, { fs, path }) => { await fs.appendFile(path.join(work, "capabilities", "nw-release-tooling", "oats.json"), "\n"); });
    r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base }); // a re-sync changes nothing about drift: the lock pins packages only
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^ {10}modules: nw-release-tooling from agents @ ${move.commit.slice(0, 7)} {2}\\[member moved since \\(now @ ${move2.commit.slice(0, 7)}\\)\\]$`, "m"), `the moved module row prints\n${r.stdout}`);
    assert.match(r.stdout, new RegExp(`^ {10}soul: release-manager from agents @ ${move.commit.slice(0, 7)} {2}\\[member moved since \\(now @ ${move2.commit.slice(0, 7)}\\)\\]$`, "m"));

    // the soul removed from the member → 'soul no longer present'
    await moveMember(fx, "agents", async (work, { fs, path }) => { await fs.rm(path.join(work, "souls", "support-triager"), { recursive: true }); });
    r = oats(["status", "--dir", dep], { cwd: dep, env, base });
    assert.match(r.stdout, new RegExp(`^ {10}soul: support-triager from agents @ ${c0.slice(0, 7)} {2}\\[soul no longer present\\]$`, "m"), r.stdout);
    r = oats(["status", "--dir", dep, "--json"], { cwd: dep, env, base });
    st = JSON.parse(r.stdout);
    assert.equal(instRow().soul.status, "missing"); assert.equal(instRow().soul.reason, "soul-absent");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---- 0.25.3: OATS_SOUL_ID — a soul's stable identity for provider state ----
test("0.25.3 OATS_SOUL_ID: hooks of a workspace spawn receive `<repo key>#<soul>` (stable across member commits) while OATS_SOUL is the per-commit directory; instance.json records workspace.soul.id", { timeout: 240_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    const dep = join(base, "dep"); mkdirSync(join(dep, "agents"), { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    let r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stderr);
    const spawn = (purpose) => oats(["spawn", "release-manager", "--dir", dep, "--agents-root", join(dep, "agents"), "--purpose", purpose, "--work", "directory", "--no-launch", "--json"], { cwd: dep, env, base });
    r = spawn("a"); assert.equal(r.status, 0, r.stdout + r.stderr);
    const homeA = envelope(r).result.home;
    const envA = JSON.parse(readFileSync(join(homeA, ".okf-hook-env.json"), "utf8"));
    const expectedId = `${fx.keys.agents}#release-manager`;
    assert.equal(envA.OATS_SOUL_ID, expectedId, "stable id = <repo key>#<soul name>");
    assert.match(envA.OATS_SOUL, /\/souls\/[0-9a-f]{12}$/, "OATS_SOUL is the per-commit content directory");
    const metaA = JSON.parse(readFileSync(join(homeA, "instance.json"), "utf8"));
    assert.equal(metaA.workspace.soul.id, expectedId);
    // A workspace spawn's hooks get the team and workspace facts — scope = the deployment, the
    // workspace's name and canonical key, and the soul's teams here (team model v2): this deployment
    // declares none, so no default is set and OATS_TEAMS is empty; the pre-0.30 names are never set.
    assert.equal(envA.OATS_TEAM_SCOPE, dep, "team scope = the deployment directory (as the operator named it)");
    assert.equal(envA.OATS_WORKSPACE_NAME, "northwind");
    assert.equal(envA.OATS_WORKSPACE_KEY, fx.keys.agents);
    assert.equal(envA.OATS_TEAMS, "[]");
    for (const k of ["OATS_DEFAULT_TEAM", "OATS_DEFAULT_TEAM_ID", "OATS_DEFAULT_TEAM_FROM", "OATS_TEAM_LABEL", "OATS_TEAM_LABELS", "OATS_TEAM_ID"]) assert.equal(k in envA, false, `${k} unset`);
    // the member commits → a different per-commit directory, the SAME identity
    const moved = await moveMember(fx, "agents", async (work, { fs, path }) => { await fs.appendFile(path.join(work, "souls/release-manager/AGENTS.md"), "\n## moved\n"); });
    r = spawn("b"); assert.equal(r.status, 0, r.stdout + r.stderr);
    const homeB = envelope(r).result.home;
    const envB = JSON.parse(readFileSync(join(homeB, ".okf-hook-env.json"), "utf8"));
    assert.equal(envB.OATS_SOUL_ID, expectedId, "identity unchanged across the member commit");
    assert.notEqual(envB.OATS_SOUL, envA.OATS_SOUL, "content directory differs per commit");
    assert.equal(JSON.parse(readFileSync(join(homeB, "instance.json"), "utf8")).workspace.soul.commit, moved.commit);
    // a classic (non-workspace) soul keeps today's value: the realpath of agents/<name>/soul
    const { stableSoulId } = await import("../lib/core.mjs");
    const classicDir = join(base, "classic-soul"); mkdirSync(classicDir, { recursive: true });
    assert.equal(stableSoulId({ soulDir: classicDir }), realpathSync(classicDir));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("0.25.4 quarantine retry: a workspace home retained after a required spawn-hook failure carries a PRE-HOOK instance.json stub; `oats retire` must read the cleanup descriptor, re-run the owed retire hook, keep the home while it fails and remove it once it succeeds", { timeout: 300_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    // A package edition whose spawn/retire hooks fail while <deployment>/FAIL exists.
    const moved = await moveMember(fx, "pkg-okf", async (work, { fs, path }) => {
      const p = path.join(work, "oats-package/capabilities/oats-okf/bin/oats-okf.mjs");
      const s = await fs.readFile(p, "utf8");
      await fs.writeFile(p, s.replace('const [cmd = "help", ...rest] = process.argv.slice(2);',
        'const [cmd = "help", ...rest] = process.argv.slice(2);\nif (cmd === "retire" && process.env.OATS_INSTANCE_HOME) (await import("node:fs")).writeFileSync(process.env.OATS_INSTANCE_HOME + "/../../../../retire-env.json", JSON.stringify({ OATS_SOUL: process.env.OATS_SOUL, OATS_SOUL_ID: process.env.OATS_SOUL_ID }));\nif ((cmd === "spawn" || cmd === "retire") && process.env.OATS_INSTANCE_HOME && (await import("node:fs")).existsSync(process.env.OATS_INSTANCE_HOME + "/../../../../FAIL")) { process.stderr.write("fixture: " + cmd + " hook failing on purpose\\n"); process.exit(3); }'));
    });
    spawnSync("git", ["-C", fx.refs["pkg-okf"].replace(/^file:\/\//, ""), "tag", "-f", "v2.1.3", moved.commit], { stdio: "ignore" });
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    const dep = join(base, "dep"); mkdirSync(join(dep, "agents"), { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    let r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stderr);
    // checkout mode: the member clone at <deployment>/agents-repo (R1 convention)
    spawnSync("git", ["clone", "-q", fx.refs.agents.replace(/^file:\/\//, ""), join(dep, "agents-repo")], { stdio: "ignore" });
    writeFileSync(join(dep, "FAIL"), "1");
    r = oats(["spawn", "release-manager", "--dir", dep, "--agents-root", join(dep, "agents"), "--purpose", "q", "--work", "checkout", "--no-launch", "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(envelope(r).error.code, "E_REQUIRED_HOOK_FAILED", "a required spawn hook's failure keeps its typed code (0.49.0)");
    assert.equal(envelope(r).error.details.unconfirmed, true, "a quarantined home's effects are unconfirmed");
    assert.ok(envelope(r).error.details.hooks.some((h) => h.capability === "oats.okf" && h.ok === false && h.log === null), JSON.stringify(envelope(r).error.details));
    assert.equal(envelope(r).error.details.home, undefined);
    const home = join(dep, "agents", "release-manager", "instances", "release-manager-q");
    assert.ok(existsSync(join(home, ".oats-rollback-incomplete.json")), "home quarantined");
    const stub = JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
    assert.equal(stub.repo, undefined, "precondition: the retained instance.json is the pre-hook materialization stub, not a spawn record");
    const q = JSON.parse(readFileSync(join(home, ".oats-rollback-incomplete.json"), "utf8"));
    assert.equal(q.cleanup.repo, join(dep, "agents-repo")); assert.deepEqual(q.cleanup.outstanding.hooks, ["oats.okf"]);
    // The descriptor carries the soul the spawn hooks saw — the stub records neither — so the
    // retried retire hook gets the per-commit directory and the stable id, not the pointer.
    const perCommit = join(dep, "agents", "release-manager", "souls", String(fx.commits.agents).slice(0, 12));
    assert.equal(q.cleanup.soulDir, realpathSync(perCommit), "descriptor records the per-commit soul directory");
    assert.equal(q.cleanup.soulId, `${fx.keys.agents}#release-manager`, "descriptor records the stable soul id");
    // retry while the hook still fails: the hook RUNS (its failure is reported), the home stays
    r = oats(["retire", "release-manager-q", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 1, r.stdout);
    const doc1 = JSON.parse(r.stdout);
    const incomplete = doc1.rollbackIncomplete ?? doc1.result?.rollbackIncomplete ?? [];
    assert.ok(incomplete.some((m) => /^retire hook oats\.okf: Command failed/.test(m)), `hook was re-run: ${JSON.stringify(incomplete)}`);
    assert.ok(!incomplete.some((m) => /lost its context repo|did not run on this retry/.test(m)), `descriptor was read: ${JSON.stringify(incomplete)}`);
    assert.ok(existsSync(home), "home retained while cleanup is owed");
    const retireEnv = JSON.parse(readFileSync(join(dep, "retire-env.json"), "utf8"));
    assert.equal(retireEnv.OATS_SOUL, realpathSync(perCommit), "the retried retire hook sees the spawn's per-commit soul");
    assert.equal(retireEnv.OATS_SOUL_ID, `${fx.keys.agents}#release-manager`, "…and its stable id");
    // the hook can now succeed: the retry completes and removes the home
    rmSync(join(dep, "FAIL"));
    r = oats(["retire", "release-manager-q", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(home), "quarantine cleared without --force");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("declaration is the trust decision: an edited lock capability list and a package no longer declared are refused at spawn, preview and sync — no home, no module store", { timeout: 600_000 }, async () => {
  const base = fixtureBase();
  try {
    const fx = await buildNorthwind(join(base, "fx"));
    const catalogFile = join(base, "catalog.json");
    writeFileSync(catalogFile, JSON.stringify({ packages: fx.catalog }, null, 2));
    const env = { OATS_PACKAGE_CATALOG: catalogFile };
    mkdirSync(join(base, "home"));
    const dep = join(base, "northwind-workspace");
    const agentsRoot = join(dep, "agents");
    mkdirSync(agentsRoot, { recursive: true });
    writeFileSync(join(dep, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${fx.refs.agents}\n`);
    const spawnArgs = (...extra) => ["spawn", "release-manager", "--dir", dep, "--agents-root", agentsRoot, "--purpose", "x", "--work", "directory", "--no-launch", "--provider", "oats.okf", "state-dir=/tmp/x", ...extra, "--json"];
    const noSideEffects = (what) => {
      assert.equal(existsSync(join(agentsRoot, "release-manager", "instances")), false, `${what}: no home`);
      assert.equal(existsSync(join(dep, ".oats", "modules")), false, `${what}: no module store write`);
    };
    let r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `sync\n${r.stdout}\n${r.stderr}`);
    const lockFile = join(dep, "oats-lock.json");
    const good = readFileSync(lockFile, "utf8");

    // ---- an edited capability list: refused at preview, apply and sync ----
    const lock = JSON.parse(good);
    // (a phantom name: every capability the soul draws still has its provider, so the refusal is the list check)
    lock.packages["nw.tools"].capabilities = [...lock.packages["nw.tools"].capabilities, "nw-phantom"].sort();
    writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
    for (const extra of [["--preview"], []]) {
      r = oats(spawnArgs(...extra), { cwd: dep, env, base });
      assert.equal(r.status, 1, `edited lock ${extra.join(" ")}\n${r.stdout}\n${r.stderr}`);
      assert.equal(envelope(r).error.code, "E_PACKAGE_INTEGRITY");
      noSideEffects(`edited lock ${extra.join(" ")}`);
    }
    r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 1, `sync over an edited lock is refused, not kept\n${r.stdout}\n${r.stderr}`);
    assert.equal(envelope(r).error.code, "E_PACKAGE_INTEGRITY");
    assert.match(envelope(r).error.message, /capabilities/);
    writeFileSync(lockFile, good);

    // ---- a package the workspace no longer declares (stale lock, no sync since): refused ----
    await moveMember(fx, "agents", async (work) => {
      const file = join(work, "oats-workspace.yaml");
      const text = readFileSync(file, "utf8");
      const next = text.split("\n").filter((l) => !/nw\.tools/.test(l)).join("\n");
      assert.notEqual(next, text, "fixture: the host declares nw.tools");
      writeFileSync(file, next);
    }, { message: "agents: drop nw.tools from packages:" });
    for (const extra of [["--preview"], []]) {
      r = oats(spawnArgs(...extra), { cwd: dep, env, base });
      assert.equal(r.status, 1, `undeclared package ${extra.join(" ")}\n${r.stdout}\n${r.stderr}`);
      assert.equal(envelope(r).error.code, "E_PACKAGE_MISSING");
      assert.match(envelope(r).error.message, /no longer declared/);
      noSideEffects(`undeclared package ${extra.join(" ")}`);
    }
    r = oats(["sync", "--dir", dep, "--json"], { cwd: dep, env, base });
    assert.equal(r.status, 0, `sync drops the undeclared package\n${r.stdout}\n${r.stderr}`);
    assert.equal("nw.tools" in JSON.parse(readFileSync(lockFile, "utf8")).packages, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
