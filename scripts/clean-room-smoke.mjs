#!/usr/bin/env node
// Clean-room tarball smoke for the WORKSPACE MODEL (lock v3, oats-local.yaml,
// oats-workspace.yaml, materialized per-instance modules). It packs the kernel
// and the pi adapter, installs both into an isolated app from the tarballs, and
// drives the packed CLI end to end against the REAL official OKF package and the
// packed kernel's own oats.framework payload — never against the checkout.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Test-driver helpers only. Runtime imports resolve against installed bytes.
// The optional Git payloads are copied once into isolated fixture repositories;
// all post-sync reads use installed/materialized bytes after their deletion.
import { CAPABILITY_PATH, EXPERT_PATH, SKILL_PATH, checkKnowledgeTheoryPackage, checkReferenceClosure, treeFiles } from "./check-knowledge-theory-package.mjs";
import { checkJavaScript, checkKernelPackFiles } from "./check-package-dry-runs.mjs";
import { CAPABILITY_PATHS, capabilityEntries, checkOkfMirror, checkOkfPayload, materializeOkfGitPayload, payloadEntries } from "./check-okf-mirror.mjs";

const started = Date.now();
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const room = realpathSync(mkdtempSync(join(tmpdir(), "oats-packed-smoke-")));
const keep = process.env.OATS_KEEP_SMOKE === "1";
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "ignore", ...options,
});
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function pack(cwd, destination) {
  const output = run("npm", ["pack", "--json", "--pack-destination", destination], { cwd, capture: true });
  const parsed = JSON.parse(output);
  if (parsed.length !== 1) throw new Error(`unexpected npm pack output from ${cwd}`);
  if (cwd === repo) checkKernelPackFiles(parsed[0]);
  return join(destination, parsed[0].filename);
}
function gitRepo(path, message = "smoke fixture") {
  mkdirSync(path, { recursive: true });
  if (!existsSync(join(path, ".git"))) run("git", ["init", "-q", path]);
  run("git", ["-C", path, "config", "user.name", "OATS Smoke"]);
  run("git", ["-C", path, "config", "user.email", "smoke@example.invalid"]);
  run("git", ["-C", path, "add", "-A"]);
  run("git", ["-C", path, "commit", "-qm", message]);
  return run("git", ["-C", path, "rev-parse", "HEAD"], { capture: true }).trim();
}
const fingerprint = (root) => treeFiles(root).map((file) => {
  const path = join(root, file);
  return `${file}:${lstatSync(path).isSymbolicLink() ? `link:${readlinkSync(path)}` : createHash("sha256").update(readFileSync(path)).digest("hex")}`;
});

try {
  const app = join(room, "app");
  const kernelRoot = join(app, "node_modules", "@awebai", "oats");
  const adapterRoot = join(app, "node_modules", "@awebai", "oats-pi");
  const oats = join(app, "node_modules", ".bin", "oats");
  const catalog = join(room, "catalog.json");
  const home = join(room, "home"); const fakeBin = join(room, "bin"); mkdirSync(home); mkdirSync(fakeBin);
  const unexpectedExec = join(room, "unexpected-exec");
  const statusProbes = join(room, "stubbed-status-probes");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const name of ["pi", "claude", "codex", "tmux", "gh", "launchctl", "systemctl", "crontab", "schtasks"]) {
    // Public CLI discovery can query session/timer status even for no-launch.
    // Answer only those read-only probes locally (inactive); every other
    // invocation still fails the no-runtime/no-host-mutation marker. Embed the
    // paths: capability cleanEnv intentionally strips arbitrary OATS_* vars.
    // tmux: the default server's has-session (a home that records no socket), and the
    // window list of the OATS tmux server that an explicit --name is checked against.
    const status = name === "tmux" ? '{ [ "$1" = has-session ] || [ "$1 $2 $3 $4" = "-u -L oats list-windows" ]; }'
      : name === "launchctl" ? '[ "$1" = print ]'
      : name === "systemctl" ? '[ "$1" = --user ] && [ "$2" = is-active ]' : "false";
    write(join(fakeBin, name), `#!/bin/sh\nif ${status}; then\n  printf "%s\\n" "$0 $*" >> ${quote(statusProbes)}\n  exit 1\nfi\nprintf "%s\\n" "$0 $*" >> ${quote(unexpectedExec)}\nexit 97\n`);
    chmodSync(join(fakeBin, name), 0o755);
  }

  // No inherited instance identity, provider credentials, custom native roots,
  // scheduler config, npm/node hooks or real user Git configuration. Set this
  // BEFORE any npm/git command and before importing the installed kernel.
  // The remote cache lives under $HOME/.cache (kernel default) — inside the room.
  const env = Object.fromEntries(["PATH", "SystemRoot", "ComSpec", "PATHEXT", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    HOME: home, SHELL: "/bin/sh",
    OATS_HOME_DIR: join(home, ".oats"),
    OATS_PKG_ROOT: kernelRoot,
    OATS_PACKAGE_CATALOG: catalog,
    OATS_TMUX_SESSION: `none-${process.pid}`,
    OATS_SMOKE_UNEXPECTED_EXEC: unexpectedExec,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), PI_CODING_AGENT_DIR: join(home, ".pi/agent"), CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), XDG_RUNTIME_DIR: join(home, "run"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    PATH: `${fakeBin}:${dirname(oats)}:${process.env.PATH}`,
  });
  write(env.GIT_CONFIG_GLOBAL, "");
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);

  const tarballs = join(room, "tarballs"); mkdirSync(tarballs);
  const kernelTgz = pack(repo, tarballs);
  const adapterTgz = pack(join(repo, "packages", "pi"), tarballs);

  mkdirSync(app);
  write(join(app, "package.json"), JSON.stringify({ name: "oats-clean-room", private: true, type: "module" }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", kernelTgz, adapterTgz], { cwd: app });

  for (const path of [join(kernelRoot, "lib", "core.mjs"), join(adapterRoot, "extension", "index.ts"), oats]) {
    if (!existsSync(path)) throw new Error(`packed install missing ${path}`);
  }
  // Capabilities resolve from Git at the locked commit: the kernel package
  // carries neither the repository's own capabilities nor the package mirrors.
  for (const dir of ["capabilities", "mirrors"]) assert.ok(!existsSync(join(kernelRoot, dir)), `npm kernel must not ship ${dir}/`);
  if (kernelRoot.startsWith(repo) || adapterRoot.startsWith(repo)) throw new Error("smoke install did not leave the checkout");
  const installedJsChecked = checkJavaScript(kernelRoot);
  run(process.execPath, ["--check", join(adapterRoot, "extension/core-loader.mjs")]);
  run(process.execPath, ["--experimental-strip-types", "--check", join(adapterRoot, "extension/index.ts")]);

  // After npm dependency installation, enforce offline Git acquisition.
  env.GIT_ALLOW_PROTOCOL = process.env.GIT_ALLOW_PROTOCOL = "file";
  assert.ok(!existsSync(join(kernelRoot, "oats-package")), "npm kernel must not ship a partial Git-only optional package");
  // The "official" oats.okf is the checkout's verified mirror (mirrors/),
  // materialized as the exact standalone Git payload: never invent wrapper
  // bytes or synthesize CLAUDE.md.
  const inventory = checkOkfMirror({ repoRoot: repo });
  const officialRepo = join(room, "official", "oats-okf");
  const payload = join(officialRepo, "oats-package");
  materializeOkfGitPayload(payload, { repoRoot: repo });
  checkOkfPayload(payload, inventory);
  assert.equal(readFileSync(join(payload, "oats-package.json"), "utf8"), inventory.distributionManifestText);
  assert.equal(readFileSync(join(payload, "LICENSE"), "utf8"), inventory.distributionLicenseText);
  const packedCatalog = readJson(join(kernelRoot, "package-catalog.json"));
  const pinnedRef = packedCatalog.packages?.["oats.okf"]?.ref;
  const mirroredVersion = readJson(join(payload, "capabilities/oats-okf/oats.json")).version;
  assert.equal(pinnedRef, `v${mirroredVersion}`, "okf mirror and packed official catalog version drift");
  assert.equal(mirroredVersion, "5.8.0");
  // The PACKED tarball's catalog carries this release's provider pins, each equal to the checkout's mirror of it.
  for (const [id, slug, version] of [["oats.aweb", "oats-aweb", "1.37.0"], ["oats.apps", "oats-folio", "1.0.0"], ["oats.apps", "oats-library", "1.0.0"]]) {
    const mirrored = readJson(join(repo, "mirrors", slug, "oats.json")).version;
    assert.equal(mirrored, version, `${id}: the mirror is ${mirrored}`);
    assert.equal(packedCatalog.packages?.[id]?.ref, `v${version}`, `${id}: the packed catalog pins ${packedCatalog.packages?.[id]?.ref}`);
  }
  // The frozen oats.engineering keeps its catalog entry, so existing pins resolve; this
  // workspace doesn't pin it, so the checkout keeps no mirror of it.
  assert.equal(packedCatalog.packages?.["oats.engineering"]?.ref, "v1.18.0", "the packed catalog keeps the frozen oats.engineering at v1.18.0");
  for (const slug of ["oats-engineering-expert", "oats-developer", "oats-code-review", "oats-maintainer"]) assert.ok(!existsSync(join(repo, "mirrors", slug)), `mirrors/${slug}: no mirror of an unpinned package`);
  const okfCommit = gitRepo(officialRepo, "okf");
  const okfTag = `v${mirroredVersion}`;
  run("git", ["-C", officialRepo, "tag", okfTag]);
  // okf 4.0.0 has no capability agents (the harvester is the package soul oats.okf/knowledge-harvester)
  // and ships no symlinks: none in the release commit's capability trees.
  assert.equal(run("git", ["-C", officialRepo, "ls-tree", okfCommit, "--", "oats-package/capabilities/oats-okf/agents"], { capture: true }).trim(), "", "okf 4.0.0 ships no capability agents");
  for (const cap of CAPABILITY_PATHS) assert.deepEqual(payloadEntries(join(payload, cap)).filter((e) => e.type === "symlink"), [], `the okf ${cap} tree has no symlinks`);

  // Optional theory uses a DIFFERENT release channel: the exact self-contained
  // Git payload (oats.framework), not an npm copy with its source CLAUDE.md
  // symlink missing. Copy the whole candidate payload verbatim into an isolated
  // Git fixture tagged with its manifest version; the catalog resolves it.
  checkKnowledgeTheoryPackage({ repoRoot: repo });
  const theoryRepo = join(room, "official", "oats-framework");
  const theorySource = join(theoryRepo, "oats-package");
  cpSync(join(repo, "oats-package"), theorySource, { recursive: true, verbatimSymlinks: true });
  checkKnowledgeTheoryPackage({ packageRoot: theorySource, parity: false });
  const distribution = readJson(join(theorySource, "oats-package.json"));
  assert.equal(distribution.package, "oats.framework");
  const theoryTag = `v${distribution.version}`;
  const theoryCommit = gitRepo(theoryRepo, "framework");
  run("git", ["-C", theoryRepo, "tag", theoryTag]);
  const theoryAliasPath = `oats-package/${EXPERT_PATH}/CLAUDE.md`;
  assert.match(run("git", ["-C", theoryRepo, "ls-tree", theoryCommit, "--", theoryAliasPath], { capture: true }), /^120000 blob /, "Git payload must track the source alias as a symlink");
  assert.equal(run("git", ["-C", theoryRepo, "show", `${theoryCommit}:${theoryAliasPath}`], { capture: true }), "AGENTS.md");
  const theoryCap = join(theorySource, CAPABILITY_PATH);
  const theorySkill = join(theoryCap, SKILL_PATH);
  const expectedClosure = checkReferenceClosure(theorySkill);
  const canonicalRefs = ["knowledge-capability-authoring.md", ...treeFiles(join(kernelRoot, "docs/knowledge-reference")).map((f) => `knowledge-reference/${f}`)];
  assert.deepEqual(treeFiles(join(theorySkill, "references")), canonicalRefs.sort());
  for (const file of canonicalRefs) assert.ok(readFileSync(join(kernelRoot, "docs", file)).equals(readFileSync(join(theorySkill, "references", file))), `packed reference drift: ${file}`);
  const skillFingerprint = fingerprint(theorySkill);
  const capFingerprint = fingerprint(theoryCap);
  // The expert is an oats.framework PACKAGE SOUL (0.29.0: capability-defined agents were removed).
  const expertInstructions = readFileSync(join(theorySource, EXPERT_PATH, "AGENTS.md"), "utf8");
  assert.equal(readlinkSync(join(theorySource, EXPERT_PATH, "CLAUDE.md")), "AGENTS.md");

  // The offline official catalog: both packages by tag, from file:// fixtures.
  write(catalog, JSON.stringify({ packages: {
    "oats.okf": { url: pathToFileURL(officialRepo).href, ref: okfTag, path: "oats-package" },
    "oats.framework": { url: pathToFileURL(theoryRepo).href, ref: theoryTag, path: "oats-package" },
  } }, null, 2));

  const adapterLoader = await import(pathToFileURL(join(adapterRoot, "extension", "core-loader.mjs")).href);
  if (adapterLoader.OATS_PKG_ROOT !== kernelRoot) throw new Error("packed pi adapter did not resolve packed kernel");
  const kernelPackage = readJson(join(kernelRoot, "package.json"));
  if (adapterLoader.kernelVersion() !== kernelPackage.version) throw new Error("packed adapter/kernel version mismatch");
  // Resolve the installed public export, not a private kernel filesystem path.
  const installedRequire = createRequire(join(app, "package.json"));
  assert.equal(installedRequire.resolve("@awebai/oats/package.json"), join(kernelRoot, "package.json"));
  const core = await import(pathToFileURL(installedRequire.resolve("@awebai/oats")).href);
  // The package's declared capabilities, as the workspace sync below resolves and the
  // spawn of the theory's author soul copies them (the v2 path reads them there).
  assert.deepEqual(distribution.capabilities.map((path) => readJson(join(theorySource, path, "oats.json")).capability), ["oats.knowledge-theory", "oats.core", "oats.setup", "oats.support", "oats.onboarding", "oats.coordination-setup"]);

  // ---- The workspace: one host repo that is also its single member, holding
  // the souls. The deployment is a separate directory with only oats-local.yaml.
  const hostRepo = join(room, "workspace-host");
  const hostRef = pathToFileURL(hostRepo).href; // bare absolute paths are refused in oats-workspace.yaml
  const soulsDir = join(hostRepo, "souls");
  write(join(hostRepo, "oats-workspace.yaml"), [
    "schemaVersion: 2", "name: smoke",
    "members:", `  - ${hostRef}`,
    "packages:", `  oats.okf: ${okfTag}`, `  oats.framework: ${theoryTag}`,
    "teams:", "  global: { description: all }", "  okf: { description: knowledge operations }",
    "defaults:", "  knowledge:", "    oats.okf: { from: package }",
    "",
  ].join("\n"));
  write(join(hostRepo, "oats-membership.yaml"), `schemaVersion: 2\nworkspace: ${hostRef}\n`);
  const canonical = "# Packed probe\n\nCanonical instructions.\n";
  write(join(soulsDir, "probe/soul.yaml"), "schemaVersion: 2\nname: probe\ndescription: Packed OKF probe\nwork: directory\n");
  write(join(soulsDir, "probe/AGENTS.md"), canonical);
  write(join(soulsDir, "probe/okf.json"), JSON.stringify({ version: 1, owner: "smoke-owner", owns: ["project/expert"], reads: [] }));
  write(join(soulsDir, "probe/skills/private/SKILL.md"), "---\nname: private\ndescription: Packed private smoke skill.\n---\n# Private\n");
  write(join(soulsDir, "quiet/soul.yaml"), "schemaVersion: 2\nname: quiet\ndescription: Consult-only smoke probe\nwork: directory\nknowledge: { harvest: off }\n");
  write(join(soulsDir, "quiet/AGENTS.md"), "# Quiet\nConsultation only.\n");
  write(join(soulsDir, "quiet/okf.json"), JSON.stringify({ version: 1, owner: "smoke-owner", owns: [], reads: ["project/expert"] }));
  // A soul that opts out of the knowledge default and pulls the optional theory
  // from the oats.framework package (a package without executables).
  write(join(soulsDir, "author/soul.yaml"), "schemaVersion: 2\nname: author\ndescription: Knowledge theory author\nwork: directory\nknowledge: none\ncapabilities:\n  oats.knowledge-theory: { from: package }\n");
  write(join(soulsDir, "author/AGENTS.md"), "# Author\n\nAuthor canonical instructions.\n");
  const hostCommit = gitRepo(hostRepo, "workspace host");

  const deployment = join(room, "deployment"); const agentsRoot = join(deployment, "agents"); mkdirSync(agentsRoot, { recursive: true });
  const bindings = join(room, "okf-bindings.json");
  const accepted = join(room, "accepted"); // created by `okf init`, never pre-seeded
  // Explicit bindings and stable owner: state-dir/bases live in the bindings
  // document. An explicit legacy host key deliberately exercises the 5.0 guard
  // after sync, followed by its guard-exempt cleanup before normal spawns.
  write(bindings, JSON.stringify({ version: 1, stateDir: join(room, "okf-state"), bases: {
    project: { id: "smoke-base", kind: "directory", path: accepted },
  } }));
  write(join(deployment, "oats-local.yaml"), `schemaVersion: 2\nworkspace: ${hostRef}\nsettings:\n  oats.okf:\n    bindings-file: ${bindings}\n    harvest: "on"\n`);

  const cliEnv = { ...env, PI_AGENTS_ROOT: agentsRoot };
  /** One packed-CLI run, its exit status asserted → the whole result (stdout and stderr). */
  const cliRun = (args, { cwd = deployment, identity = false, env: extra = {}, expectExit = 0 } = {}) => {
    // Scaffold-only probes have no harness to supply the normal launch identity.
    const id = identity ? { OATS_INSTANCE: basename(cwd), OATS_INSTANCE_HOME: cwd } : {};
    const r = spawnSync(oats, args, { cwd, env: { ...cliEnv, ...id, ...extra }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    if (r.error) throw r.error;
    assert.equal(r.status, expectExit, `oats ${args.join(" ")} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    return r;
  };
  const cli = (args, options) => cliRun(args, options).stdout;
  const boundary = (args, options = {}) => {
    const text = cli(args, options);
    const answer = JSON.parse(text);
    assert.equal(answer.schemaVersion, 1, text);
    assert.equal(answer.ok, true, text);
    return answer.result;
  };
  // `oats retire --json` answers with the retirement record itself (no envelope).
  const retire = (instance, homeDir) => {
    const r = JSON.parse(cli(["retire", instance, "--dir", deployment, "--home", homeDir, "--json"]));
    assert.equal(r.retired, instance, JSON.stringify(r));
    assert.equal(r.removedDir, true, JSON.stringify(r));
    assert.ok(!existsSync(homeDir), `${instance} home survived retirement`);
    return r;
  };

  // ---- sync: resolve + lock (v3) both packages at exact commit + integrity.
  // No approval step: declaring a package in packages: is the trust decision.
  const syncText = cli(["sync", "--dir", deployment, "--json"]);
  const synced = JSON.parse(syncText);
  assert.equal(synced.ok, true, syncText);
  assert.deepEqual(synced.result.members.map((m) => m.status), ["confirmed"], syncText);
  assert.deepEqual(synced.result.packages.map((p) => p.id).sort(), ["oats.framework", "oats.okf"]);
  assert.ok(!Object.hasOwn(synced.result, "approvalNeeded"), "sync reports no approval");
  const lockPath = join(deployment, "oats-lock.json");
  const checkLockShape = (lock) => {
    assert.equal(lock.lockfileVersion, 3);
    assert.ok(!Object.hasOwn(lock, "capabilities"), "lock v3 has no top-level capabilities map");
    assert.deepEqual(Object.keys(lock.packages).sort(), ["oats.framework", "oats.okf"]);
    for (const [id, row] of Object.entries(lock.packages)) {
      assert.match(row.commit, /^[0-9a-f]{40}$/, id);
      assert.match(row.integrity, /^sha256-[0-9a-f]{64}$/, id);
      assert.equal(row.path, "oats-package", id);
      assert.equal(row.source, `catalog:${id}`, id);
    }
    assert.equal(lock.packages["oats.okf"].commit, okfCommit);
    assert.equal(lock.packages["oats.okf"].version, mirroredVersion);
    assert.equal(lock.packages["oats.framework"].commit, theoryCommit);
    assert.equal(lock.packages["oats.framework"].version, distribution.version);
    assert.doesNotMatch(JSON.stringify(lock), /"lockfileVersion":\s*2/);
  };
  const locked = readJson(lockPath);
  checkLockShape(locked);
  for (const row of Object.values(locked.packages)) assert.ok(!Object.hasOwn(row, "approved"), "lock v3 entries carry no approval");
  assert.ok(!Object.hasOwn(JSON.parse(cli(["sync", "--dir", deployment, "--json"])).result, "approvalNeeded"), "a second sync exits 0");
  assert.deepEqual(readJson(lockPath), locked, "a second sync is a no-op on the lock");
  for (const residue of [".agents/capabilities/installed", ".agents/capabilities", "oats-config.yaml", ".agents/packages"]) {
    assert.ok(!existsSync(join(deployment, residue)), `workspace model wrote v1 residue ${residue}`);
  }
  const freshDoctor = JSON.parse(cli(["doctor", deployment, "--json"]));
  assert.equal(freshDoctor.lockError ?? null, null, `packed doctor refuses the lock it just wrote: ${JSON.stringify(freshDoctor.lockError)}`);
  assert.ok(!freshDoctor.legacyLockFiles?.length && !freshDoctor.officialMigration, "packed doctor asked a fresh deployment to migrate");

  // ---- OKF's own provisioning: the accepted base must exist before the soul
  // can spawn (its required spawn hook refuses to bootstrap on read).
  const nodes = join(room, "okf-nodes.json");
  write(nodes, JSON.stringify({ expert: { path: "expert", owner: "smoke-owner" } }));
  // Operator-level dispatch (contracts doc, "Post-0.25.0 clarifications"): from
  // the deployment (no instance home) `oats okf init --soul probe` resolves
  // exactly as `oats spawn probe` would, fetches oats.okf into the deployment's
  // module store <deployment>/.oats/modules/oats.okf@<commit12>/ and runs THAT
  // copy with the soul's merged oats.okf payload (bindings-file) as OATS_SETTINGS.
  // Without --soul it resolves as the first soul that provides the namespace
  // (feature operator-default-soul), named on stderr; a namespace no soul
  // provides is E_BAD_ARGS naming --soul, and a refused dispatch fetches nothing.
  const noProvider = JSON.parse(cli(["nothing", "init", "--json"], { expectExit: 1 }));
  assert.equal(noProvider.ok, false); assert.equal(noProvider.error.code, "E_BAD_ARGS", JSON.stringify(noProvider));
  assert.equal(noProvider.error.message, "no soul of this deployment provides the nothing namespace; pass --soul <name>");
  assert.ok(!existsSync(join(deployment, ".oats", "modules")), "a refused dispatch fetches nothing");
  // The same soul answers with and without --soul (read-only: okf init refuses to run twice).
  const helpDefault = cliRun(["okf", "--help", "--json"]);
  assert.match(helpDefault.stderr, /oats okf: using the settings and teams of soul [\w.-]+\/probe, the first soul by name in this deployment that provides "okf"/, helpDefault.stderr);
  assert.deepEqual(JSON.parse(helpDefault.stdout), JSON.parse(cli(["okf", "--help", "--soul", "probe", "--json"])), "without --soul the dispatch resolves as --soul probe");
  // The 5.0 package is synced, but the explicit old host key still blocks use.
  // Both a command and a new spawn must name the supported cleanup remedy.
  const localFile = join(deployment, "oats-local.yaml");
  const legacyBytes = readFileSync(localFile), legacyMode = lstatSync(localFile).mode & 0o777;
  const guarded = JSON.parse(cli(["okf", "inspect", "--soul", "probe", "--json"], { expectExit: 1 }));
  assert.equal(guarded.error.code, "E_REMOVED");
  assert.match(guarded.error.message, /settings\.oats\.okf\.harvest from host/);
  assert.ok(guarded.error.message.includes("setup --remove-legacy-settings"));
  const blocked = cliRun(["spawn", "probe", "--name", "blocked-before-cleanup", "--no-launch", "--json"], { expectExit: 1 });
  assert.match(blocked.stdout + blocked.stderr, /E_REMOVED/);
  assert.ok((blocked.stdout + blocked.stderr).includes("setup --remove-legacy-settings"));
  assert.ok(!existsSync(join(agentsRoot, "probe", "instances", "blocked-before-cleanup")), "guard failure leaves no instance home");
  const cleanupArgs = ["okf", "setup", "--remove-legacy-settings", "--soul", "probe"];
  const planned = boundary([...cleanupArgs, "--plan", "--json"]);
  assert.deepEqual(planned, { file: localFile, removed: ["settings.oats.okf.harvest"], plan: true, written: false });
  assert.deepEqual(readFileSync(localFile), legacyBytes, "cleanup plan changes no bytes");
  assert.deepEqual(boundary([...cleanupArgs, "--json"]), { file: localFile, removed: ["settings.oats.okf.harvest"], written: true });
  assert.equal(readFileSync(localFile, "utf8"), legacyBytes.toString().replace('    harvest: "on"\n', ''), "only the explicit legacy line is removed");
  assert.equal(lstatSync(localFile).mode & 0o777, legacyMode, "cleanup preserves file permissions");
  assert.deepEqual(boundary([...cleanupArgs, "--json"]), { file: localFile, removed: [], written: false }, "cleanup is idempotent");

  // The init itself, without --soul: the default soul's run is the real one.
  const defaultInit = cliRun(["okf", "init", "--base", "project", "--nodes", nodes, "--confirm", "--json"]);
  assert.match(defaultInit.stderr, /using the settings and teams of soul [\w.-]+\/probe,/, defaultInit.stderr);
  const initEnvelope = JSON.parse(defaultInit.stdout);
  assert.equal(initEnvelope.schemaVersion, 1, defaultInit.stdout); assert.equal(initEnvelope.ok, true, defaultInit.stdout);
  const okfInitAnswer = initEnvelope.result;
  assert.equal(okfInitAnswer.status, "accepted", defaultInit.stdout);
  // A second init is the provider's own refusal: knowledge is never overwritten.
  assert.equal(JSON.parse(cli(["okf", "init", "--base", "project", "--nodes", nodes, "--confirm", "--soul", "probe", "--json"], { expectExit: 1 })).error.code, "E_BASE");
  assert.ok(existsSync(join(accepted, "okf-base.json")), "okf init wrote the accepted base");
  const storeEntries = readdirSync(join(deployment, ".oats", "modules")).filter((n) => !n.startsWith("."));
  assert.deepEqual(storeEntries.map((n) => n.replace(/@[0-9a-f]{12}$/, "@<commit12>")), ["oats.okf@<commit12>"], `module store: ${storeEntries.join(", ")}`);
  assert.equal(storeEntries[0].slice("oats.okf@".length), locked.packages["oats.okf"].commit.slice(0, 12), "the store copy is the LOCKED commit");
  assert.ok(existsSync(join(deployment, ".oats", "modules", storeEntries[0], "bin", "oats-okf.mjs")), "the store copy carries the executable that ran");
  // The generic kernel keeps native-record/retirement bookkeeping beside
  // homes even after a refused spawn. Exclude ONLY those two known directories,
  // not arbitrary dot-prefixed homes or an unexpected retained instance.
  const instanceNames = root => (existsSync(root) ? readdirSync(root) : [])
    .filter(name => ![".oats-native-record", ".oats-retirement"].includes(name)).sort();
  const probeInstances = join(agentsRoot, "probe", "instances");
  assert.deepEqual(instanceNames(probeInstances), [], "guard and init left no instance home");

  // ---- spawn the OKF probe through the packed CLI, scaffold only.
  const spawned = boundary(["spawn", "probe", "--dir", deployment, "--agents-root", agentsRoot, "--purpose", "packed", "--no-launch", "--json"]);
  const probeHome = realpathSync(spawned.home);
  assert.equal(probeHome, join(realpathSync(agentsRoot), "probe", "instances", spawned.instance));
  const meta = readJson(join(probeHome, "instance.json"));
  assert.equal(meta.launched, false);
  assert.equal(meta.work, "directory");
  assert.ok(meta.modules && typeof meta.modules === "object", "instance.json records materialized modules");
  assert.equal(meta.modules["oats.okf"].commit, okfCommit);
  assert.equal(meta.modules["oats.okf"].from.kind, "package");
  assert.equal(meta.modules["oats.okf"].from.package, "oats.okf");
  const okfRow = meta.capabilities.find((c) => c.id === "oats.okf");
  assert.ok(okfRow, "instance.json.capabilities lists oats.okf");
  assert.deepEqual([...okfRow.hooks].sort(), ["soul-scaffold", "spawn", "upgrade"], "5.x has no retire capture hook; 5.4.0 adds the upgrade hook");
  assert.equal(meta.capabilityMeta?.["oats.okf"], undefined, "the spawn hook creates no external custody or compensation debt");
  assert.equal(okfRow.settings?.["bindings-file"], bindings, "effective settings come from oats-local.yaml");
  const okfModule = join(probeHome, ".oats/modules/oats.okf");
  assert.equal(readJson(join(okfModule, "oats.json")).hooks.spawn.required, true);
  assert.ok(!existsSync(join(okfModule, "agents")), "okf 4.0.0 ships no capability agents");
  // The materialized module is the ENTIRE verified inventory: nothing added,
  // nothing dropped (3.0.0's has no symlink).
  const checkOkfModule = () => assert.deepEqual(payloadEntries(okfModule), capabilityEntries(inventory), "materialized package module must match the OKF source inventory exactly");
  checkOkfModule();
  // Skills are materialized flat (<home>/.agents/skills/<skill>/), the soul's own
  // beside each module's, one level deep where the harness discovers them.
  const skillsRoot = join(probeHome, ".agents", "skills");
  const skills = readdirSync(skillsRoot).sort();
  assert.deepEqual(skills, ["knowledge-theory", "okf-consultation", "okf-instance-knowledge", "okf-propose", "private"], "5.2 consultation, capture, proposing and theory plus the private skill, flat");
  for (const name of skills) assert.ok(existsSync(join(skillsRoot, name, "SKILL.md")) && existsSync(join(probeHome, ".claude", "skills", name, "SKILL.md")), `${name}/SKILL.md one level deep, also through .claude/skills`);
  // The soul's own skill and each module skill by its `module:<cap>` source (record order is not a contract).
  assert.deepEqual(meta.skills.map((s) => [s.name, s.source]).sort(), [["knowledge-theory", "module:oats.okf"], ["okf-consultation", "module:oats.okf"], ["okf-instance-knowledge", "module:oats.okf"], ["okf-propose", "module:oats.okf"], ["private", "soul"]]);
  assert.equal(lstatSync(join(probeHome, "AGENTS.md")).isSymbolicLink(), false);
  assert.equal(readlinkSync(join(probeHome, "CLAUDE.md")), "AGENTS.md");
  const composed = readFileSync(join(probeHome, "AGENTS.md"), "utf8");
  assert.ok(composed.includes("Canonical instructions"), "canonical soul instructions composed");
  assert.ok(composed.includes("<!-- oats:capability:oats.okf"), "OKF injection composed");
  assert.equal(readFileSync(join(agentsRoot, "probe/soul/AGENTS.md"), "utf8"), canonical, "the fetched soul copy is the member's soul");
  assert.doesNotMatch(meta.command, /--no-skills/, "the launch command must let the harness load the materialized skills");
  assert.ok(meta.command.includes(join(probeHome, "AGENTS.md")), meta.command);
  assert.ok(!existsSync(join(probeHome, ".okf-source.json")), "5.0 never registers a durable source");
  assert.ok(!existsSync(join(room, "okf-state", "sources")), "no source custody created");
  assert.doesNotMatch(readFileSync(join(probeHome, "TASK.md"), "utf8"), /harvest|propos|okf-propose/i);
  assert.match(composed, /IMPORTANT/);
  assert.match(composed, /\*\*okf-propose\*\* skill is \*\*compulsory\*\*/);
  assert.match(readFileSync(join(skillsRoot, "okf-propose/SKILL.md"), "utf8"), /oats spawn oats\.okf\/knowledge-harvester --name <harvester-name> --task-file <proposal> --relation unrelated/);
  assert.deepEqual(boundary(["okf", "status", "--json"], { cwd: probeHome, identity: true }), { harvest: "on", reason: "default" });
  assert.ok(!existsSync(join(probeHome, "knowledge")), "okf 3.0.0 materializes no ./knowledge/ view: instances consult the accepted state");
  const doctor = JSON.parse(cli(["doctor", deployment, "--json"]));
  assert.equal(doctor.lockError ?? null, null);

  // The fixture repositories are gone from here on: every resolution, module
  // materialization and read must come from the lock + the deployment's own
  // remote cache, never from a source checkout.
  rmSync(officialRepo, { recursive: true });
  rmSync(theoryRepo, { recursive: true });
  assert.ok(!existsSync(officialRepo) && !existsSync(theoryRepo));

  // Both the provider's stdout and the kernel operation envelope cross real
  // pipes. All documents exceed a pipe buffer but stay under the documented
  // per-document preview cap; compare complete Unicode bodies, not prefixes.
  const largeState = "# Working state\n" + "Live state α, not a processing receipt.\n".repeat(5000);
  const largeLog = "# Log\n" + "Observed β limitation in the source.\n".repeat(5000);
  const largeNote = "# Pending note\n" + "A live γ note for inspection.\n".repeat(6000);
  for (const text of [largeState, largeLog, largeNote]) assert.ok(Buffer.byteLength(text) > 128 * 1024 && Buffer.byteLength(text) < 256 * 1024);
  write(join(probeHome, "STATE.md"), largeState);
  write(join(probeHome, "log.md"), largeLog);
  write(join(probeHome, "notes/live.md"), largeNote);
  // Scope commands (no home) run from the source home with its identity: the
  // dispatcher resolves the capability from that instance's materialized modules.
  const inHome = { cwd: probeHome, identity: true };
  const discovered = boundary(["inspect", "--home", probeHome, "--json"]);
  assert.equal(discovered.knowledge.provider, "oats.okf");
  assert.equal(discovered.knowledge.operations.find((op) => op.name === "inspect").available, true);
  for (const result of [
    boundary(["okf", "inspect", "--json"], inHome),
    boundary(["operation", "run", "knowledge:inspect", "--home", probeHome, "--json"]).result,
  ]) {
    assert.equal(result.liveMemory.available, true);
    assert.deepEqual(result.documents.slice(0, 3).map(({ label, kind, text, truncated }) => [label, kind, text, truncated]), [
      ["Working state (STATE.md)", "markdown", largeState, undefined],
      ["Log (log.md)", "markdown", largeLog, undefined],
      ["Pending note: live.md", "markdown", largeNote, undefined],
    ]);
    assert.equal(result.documents.length, 3, "only the home's working memory, no invented processing receipts");
    assert.deepEqual(result.owns, ["project/expert"]);
    assert.equal(result.bases.project.kind, "directory");
  }
  // There is no source-scoped inspector or completion engine to fall back to.
  // The replacement contract is an explicit refusal, never reads of an old home.
  for (const args of [["inspect", "--source", join(room, "missing-source.json")], ["run-source"], ["complete"], ["harvest"], ["refresh"], ["read"]]) {
    const refused = JSON.parse(cli(["okf", ...args, "--json"], { ...inHome, expectExit: 1 }));
    assert.equal(refused.error.code, "E_REMOVED", JSON.stringify(refused));
  }
  const baseline = readFileSync(join(accepted, "expert/index.md"), "utf8");
  assert.equal(boundary(["okf", "cat", "--base", "project", "expert/index.md", "--json"], inHome).text, baseline);
  const acceptedBefore = fingerprint(accepted), sourceBefore = readFileSync(join(probeHome, "instance.json"));
  const proposal = `# Knowledge proposal\n\nSource: instance ${spawned.instance}, home ${probeHome}, soul probe\n\n## What and why\nWorking-memory inspections must preserve complete Unicode documents so a reviewer does not judge truncated evidence.\n\n## Evidence\nThe packed fixture compares all three document bodies.\n\n## Backing notes\n- notes/live.md\n`;
  write(join(probeHome, "proposals/checkpoint.md"), proposal);
  const harvesterRoot = join(agentsRoot, "oats-okf--knowledge-harvester", "instances");
  const harvesterHomes = () => instanceNames(harvesterRoot);
  const spawnHarvester = (file, options = inHome) => cliRun(["spawn", "oats.okf/knowledge-harvester", "--task-file", file, "--relation", "unrelated", "--no-launch", "--json"], options);
  write(join(probeHome, "proposals/invalid.md"), "# Not a proposal\nNo Source line.\n");
  const invalid = spawnHarvester("proposals/invalid.md", { ...inHome, expectExit: 1 });
  assert.match(invalid.stdout + invalid.stderr, /E_SOURCE/);
  assert.deepEqual(harvesterHomes(), [], "invalid proposal leaves no retained harvester home");
  const requestedEnvelope = JSON.parse(spawnHarvester("proposals/checkpoint.md").stdout);
  assert.equal(requestedEnvelope.ok, true);
  const requested = requestedEnvelope.result;
  const workerMeta = readJson(join(requested.home, "instance.json"));
  assert.equal(workerMeta.launched, false);
  assert.equal(workerMeta.work, "directory");
  assert.equal(workerMeta.agent, "oats-okf--knowledge-harvester");
  assert.equal(dirname(dirname(realpathSync(requested.home))), realpathSync(join(agentsRoot, "oats-okf--knowledge-harvester")), "package-soul harvester homes under the agents root");
  for (const key of ["parentInstance", "siblingInstance", "relation", "relativeTo"]) assert.equal(workerMeta[key], undefined, `${key}: unrelated is top-level`);
  // The source home's caller identity supplies attribution independently of lineage.
  assert.equal(workerMeta.spawnOrigin, "instance");
  assert.deepEqual(readFileSync(join(probeHome, "instance.json")), sourceBefore, "proposal spawn does not change source lineage");
  assert.equal(workerMeta.capabilityMeta?.["oats.okf-harvest"], undefined, "source gate creates no compensation debt");
  assert.deepEqual(Object.keys(workerMeta.modules), ["oats.okf-harvest"], "harvester is knowledge:none with its own capability");
  assert.equal(workerMeta.modules["oats.okf-harvest"].commit, okfCommit);
  assert.deepEqual(payloadEntries(join(requested.home, ".oats/modules/oats.okf-harvest")), capabilityEntries(inventory, "capabilities/oats-okf-harvest"));
  assert.equal(readJson(join(requested.home, ".oats/modules/oats.okf-harvest/oats.json")).hooks.spawn.required, true);
  for (const name of ["STATE.md", "log.md", "notes", ".okf-source.json", "work/input.json", "work/staging.json"]) assert.ok(!existsSync(join(requested.home, name)), `harvester has no automatic ${name}`);
  assert.ok(readFileSync(join(requested.home, "TASK.md"), "utf8").includes(proposal.trim()), "the harvester receives the author's own proposal");
  checkOkfModule();

  // A real opted-out soul consults normally, has no duty despite the shared
  // conditional inject, and is refused by the source gate with no extra home.
  const quiet = boundary(["spawn", "quiet", "--purpose", "packed", "--no-launch", "--json"]);
  const quietInHome = { cwd: quiet.home, identity: true };
  assert.equal(boundary(["okf", "cat", "--base", "project", "expert/index.md", "--json"], quietInHome).text, baseline);
  assert.doesNotMatch(readFileSync(join(quiet.home, "TASK.md"), "utf8"), /harvest|propos|okf-propose/i);
  assert.deepEqual(boundary(["okf", "status", "--json"], quietInHome), { harvest: "off", reason: "soul-opt-out" });
  assert.match(readFileSync(join(quiet.home, "AGENTS.md"), "utf8"), /knowledge: \{ harvest: off \}.*has no harvest duty/);
  write(join(quiet.home, "proposal.md"), `# Forbidden proposal\n\nSource: instance ${quiet.instance}, home ${quiet.home}, soul quiet\n\nThis source opted out.\n`);
  const beforeRefusal = harvesterHomes();
  const optedOut = spawnHarvester("proposal.md", { ...quietInHome, expectExit: 1 });
  assert.match(optedOut.stdout + optedOut.stderr, /E_OPTED_OUT/);
  assert.deepEqual(harvesterHomes(), beforeRefusal, "opted-out proposal leaves no extra harvester home");
  retire(quiet.instance, quiet.home);

  // Retirement does not capture or publish. The already admitted unrelated
  // harvester survives the source, carrying the self-contained proposal only.
  const retiredProbe = retire(spawned.instance, probeHome);
  assert.equal(retiredProbe.capabilityMeta?.["oats.okf"], undefined, "no automatic retire capture");
  assert.ok(existsSync(requested.home), "unrelated harvester survives source retirement");
  assert.ok(readFileSync(join(requested.home, "TASK.md"), "utf8").includes(proposal.trim()));
  assert.ok(!existsSync(join(room, "okf-state", "sources")), "no durable source engine at retirement");
  assert.deepEqual(fingerprint(accepted), acceptedBefore, "no model or PR acceptance: accepted knowledge is unchanged");
  // Also exercise the packed public API against the independent scaffold.
  core.retireInstance(agentsRoot, requested.instance, { home: requested.home });
  assert.ok(!existsSync(requested.home), "independent no-launch harvester retired");
  const fresh = boundary(["spawn", "probe", "--dir", deployment, "--agents-root", agentsRoot, "--purpose", "fresh", "--no-launch", "--json"]);
  const freshHome = realpathSync(fresh.home);
  assert.ok(!existsSync(join(freshHome, "knowledge")), "fresh reader has no local knowledge view");
  assert.equal(boundary(["okf", "cat", "--base", "project", "expert/index.md", "--fresh", "--json"], { cwd: freshHome, identity: true }).text, baseline, "fresh reader consults accepted bytes, not a fabricated completion");
  assert.equal(readJson(join(freshHome, "instance.json")).modules["oats.okf"].commit, okfCommit);
  assert.deepEqual(payloadEntries(join(freshHome, ".oats/modules/oats.okf")), capabilityEntries(inventory));
  retire(fresh.instance, freshHome);
  const schedules = boundary(["schedule", "list", "--dir", deployment, "--json"]);
  assert.notEqual(schedules.scheduler.active, true);
  assert.deepEqual(schedules.schedules, [], "the provider created no scheduled harvest jobs");
  assert.deepEqual(readJson(lockPath), locked, "lifecycle never mutates the lock");

  // ---- Optional theory from the oats.framework package: a soul that opts out
  // of the knowledge default and pulls oats.knowledge-theory from the package.
  // The module bytes and the composed instance are what is asserted; the expert
  // is the package's own soul (spawned below).
  const theoryProbes = [];
  for (const harness of ["pi", "claude"]) {
    const author = boundary(["spawn", "author", "--dir", deployment, "--agents-root", agentsRoot, "--purpose", `theory-${harness}`, "--harness", harness, "--no-launch", "--json"]);
    const authorHome = realpathSync(author.home);
    try {
      const authorMeta = readJson(join(authorHome, "instance.json"));
      assert.equal(authorMeta.launched, false);
      assert.equal(authorMeta.harness, harness);
      assert.equal(readlinkSync(join(authorHome, "CLAUDE.md")), "AGENTS.md");
      assert.deepEqual(Object.keys(authorMeta.modules).sort(), ["oats.knowledge-theory"], "knowledge: none drops the OKF default; the theory package is the only module");
      assert.equal(authorMeta.modules["oats.knowledge-theory"].commit, theoryCommit);
      assert.equal(authorMeta.modules["oats.knowledge-theory"].from.package, "oats.framework");
      const theoryModule = join(authorHome, ".oats/modules/oats.knowledge-theory");
      assert.deepEqual(fingerprint(theoryModule), capFingerprint, "materialized module preserves the full capability including the source alias");
      assert.ok(!existsSync(join(theoryModule, "agents")), "the capability ships no agent (the expert is a package soul)");
      const materializedSkill = join(authorHome, ".agents/skills", basename(SKILL_PATH));
      assert.deepEqual(fingerprint(materializedSkill), skillFingerprint, "complete packed skill materialized without a source");
      assert.deepEqual(checkReferenceClosure(materializedSkill), expectedClosure);
      assert.deepEqual(readdirSync(join(authorHome, ".agents/skills")), [basename(SKILL_PATH)]);
      const text = readFileSync(join(authorHome, "AGENTS.md"), "utf8");
      assert.ok(text.includes("Author canonical instructions"));
      assert.doesNotMatch(text, /Knowledge: OKF|oats:capability:oats\.okf/, "theory must not inject knowledge runtime policy");
      assert.ok(!text.includes(expertInstructions.trim()), "the expert's instructions are the expert agent's, not the author's");
      assert.ok(!authorMeta.capabilities.some((c) => c.id === "oats.okf"));
      for (const absent of ["STATE.md", "notes", "log.md", ".okf-source.json", "soul/knowledge"]) assert.ok(!existsSync(join(authorHome, absent)), `knowledge none created ${absent}`);
    } finally {
      retire(author.instance, authorHome);
    }
    theoryProbes.push(`directory/${harness}`);
  }
  // The expert: oats.framework's package soul, by its qualified name, at the locked commit.
  const expert = boundary(["spawn", "oats.framework/knowledge-theory-expert", "--dir", deployment, "--agents-root", agentsRoot, "--purpose", "theory", "--work", "directory", "--harness", "pi", "--no-launch", "--json"]);
  const expertHome = realpathSync(expert.home);
  try {
    assert.equal(expertHome, realpathSync(join(agentsRoot, "oats-framework--knowledge-theory-expert", "instances", "oats-framework-knowledge-theory-expert-theory")));
    const expertMeta = readJson(join(expertHome, "instance.json"));
    assert.equal(expertMeta.workspace.soul.package.id, "oats.framework");
    assert.deepEqual(Object.keys(expertMeta.modules).sort(), ["oats.knowledge-theory"], "knowledge: none; the theory capability from its own package");
    assert.ok(readFileSync(join(expertHome, "AGENTS.md"), "utf8").includes(expertInstructions.trim()), "the expert's instructions");
    assert.equal(readlinkSync(join(expertHome, "CLAUDE.md")), "AGENTS.md");
  } finally {
    retire(expert.instance, expertHome);
  }
  theoryProbes.push("package-soul/knowledge-theory-expert");
  assert.deepEqual(readJson(lockPath), locked, "theory spawns never mutate the lock");

  // The terminal client (`oats tui`, packages/tui), from the installed package. With no terminal
  // it loads its whole module graph, the shared reader in packages/client included, BEFORE it
  // refuses: a module missing from the package's `files` fails here as a module that cannot be
  // found, where an import-graph test on a checkout would pass. Nothing is drawn: no escape byte
  // goes to a stream that is not a terminal.
  const tui = cliRun(["tui"], { expectExit: 1 });
  assert.equal(tui.stderr, "oats: `oats tui` needs a terminal on stdin and stdout (E_NO_TERMINAL); `oats status` prints the instances once\n");
  assert.equal(tui.stdout, "", "nothing on stdout without a terminal");
  const tuiJson = cliRun(["tui", "--json"], { expectExit: 1 });
  assert.deepEqual(JSON.parse(tuiJson.stdout), { schemaVersion: 1, ok: false, error: { code: "E_BAD_ARGS", message: "oats tui is interactive and has no --json form; `oats status --json` is the machine view" } });
  for (const file of ["packages/tui/bin/tui.mjs", "packages/tui/lib/client.mjs", "packages/client/display-text.mjs"]) assert.ok(existsSync(join(kernelRoot, file)), `the installed package holds ${file}`);
  assert.ok(!existsSync(join(kernelRoot, "packages/tui/test")) && !existsSync(join(kernelRoot, "packages/client/test")), "the clients' tests are not installed");

  assert.ok(!existsSync(env.OATS_SMOKE_UNEXPECTED_EXEC), "a runtime/backend/host scheduler was invoked");

  console.log(JSON.stringify({
    passed: true, seconds: Math.round((Date.now() - started) / 1000),
    kernelTarball: basename(kernelTgz), adapterTarball: basename(adapterTgz),
    adapterResolvedPackedKernel: true, installedJsChecked,
    workspace: { host: hostCommit, lockfileVersion: 3, packages: Object.keys(locked.packages).sort(), okfIntegrity: locked.packages["oats.okf"].integrity, v1Residue: false, doctorLockError: null },
    exactSkills: skills, canonicalSoulUnchanged: true, launchLoadsSkills: true,
    stubbedInactiveStatusProbes: existsSync(statusProbes) ? readFileSync(statusProbes, "utf8").trim().split("\n").length : 0,
    okf: { version: mirroredVersion, catalogRef: pinnedRef, excludedFromNpm: true,
      acquiredFromVerifiedGit: true, exactCommit: okfCommit, sourceRemoved: true,
      trackedSourceAliasPreserved: true, moduleMatchesInventory: true, requiredHooks: true, dispatchFromModules: true, largePipedInspection: true,
      legacyKeyGuardAndCleanup: true, proposalGate: true, optedOutSourceRefused: true,
      independentHarvester: true, automaticCapture: false, acceptedKnowledgeUnchanged: true,
      scaffoldedAndRetired: ["source", "harvester", "opted-out-reader", "fresh-reader"], liveLaunches: 0,
      operatorDispatchFromDeployment: { command: "okf init --soul probe", store: storeEntries[0], soulRequired: true } },
    optionalTheory: { package: distribution.package, excludedFromNpm: true, acquiredFromGitFixture: true, exactCommit: theoryCommit, sourceRemoved: true,
      references: expectedClosure.length - 1, trackedSourceAliasPreserved: true, scaffoldedAndRetired: theoryProbes, liveLaunches: 0 },
    tui: { noTerminalRefusal: "E_NO_TERMINAL", jsonRefusal: "E_BAD_ARGS", moduleGraphLoadedFromPackage: true, testsInstalled: false },
  }, null, 2));
} finally {
  if (keep) console.error(`OATS_KEEP_SMOKE=1: retained ${room}`);
  else rmSync(room, { recursive: true, force: true });
}
