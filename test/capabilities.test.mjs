import test from "node:test";
import { fixture as okfFixture } from "./helpers/okf-v2.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import {
  KERNEL_HOME_RECEIPTS, capabilityManifest, completeDeferredRetirement, composeInstanceAgentsMd, deferredRetireResultPath, findAgent, findInstanceHomes, retirePendingMarkerPath,
  FAILED_SPAWN_BRANCH_LEFT, listInstances, RETIRE_DELETE_BRANCH_REFUSED, retireInstance, runLifecycleHooks, spawnInstanceAsync,
} from "@awebai/oats/core";
import { inertHarnessPath } from "./helpers/runtime-stub.mjs";
import { DISPOSABLE_HOME_ACCEPTED, DISPOSABLE_HOME_REFUSED, disposableHomeRefusal } from "./helpers/disposable-home.mjs";
import { capabilityFiles, setProcessEnvironment, soulFiles, v2Deployment } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";
import { killAndReap } from "./helpers/host-fixture.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);
// Captured aw output and its provenance live together in this fixture directory.
const AW_VERSION_OUTPUT = readFileSync(new URL("./fixtures/aw-1.36.33/aw-version.txt", import.meta.url), "utf8");
const AW_VERSION_SHELL = "printf '%s' '" + AW_VERSION_OUTPUT.replaceAll("'", "'\\''") + "'";
/** Parse a `--json` CLI success envelope (Desktop CLI API v1): stdout must be
 *  exactly one JSON object {schemaVersion:1,ok:true,result} — no progress prose. */
function jsonResult(r) {
  const env = JSON.parse(r.stdout); // throws on any stdout contamination
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.ok, true, JSON.stringify(env.error));
  return env.result;
}
// Assert the producer's structural outcome independently of its operator wording.
function rollbackError(message, unconfirmed) {
  return (error) => {
    assert.match(error.message, message);
    assert.equal(error.details?.unconfirmed, unconfirmed);
    return true;
  };
}
/** Every directory temp() made. Each is removed when the file has ended: also one whose test has no
 *  removal of its own, or failed before it. */
const temps = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), "oats-cap-test-")); temps.push(dir); return dir; }
test.after(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }

/** A fake `aw` at <bin>/aw that the shipped oats.aweb hook can run. The hook reads `aw version` under a
 *  10 s ceiling (readAwVersion), and the first exec of a freshly written executable can stall for longer
 *  than that while the OS checks it (macOS assesses each new executable once, serially, so a busy suite
 *  queues behind it): the hook would then take its version-floor path, not the path under test. One
 *  untimed exec here takes that cost. */
function fakeAw(bin, script) {
  write(join(bin, "aw"), script);
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  execFileSync(join(bin, "aw"), ["version"]);
}
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  write(join(dir, ".gitignore"), "\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}

function capability(repo, folder, manifest, files = {}) {
  const dir = join(repo, ".agents", "capabilities", "owned", folder);
  write(join(dir, "oats.json"), JSON.stringify({ version: "1.0.0", compatibility: { oats: ">=0.6.2" }, description: "Test capability.", ...manifest }, null, 2));
  for (const [name, body] of Object.entries(files)) write(join(dir, name), body);
  return dir;
}
function fakeHarnesses(base) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  for (const name of ["pi", "claude"]) { write(join(bin, name), "#!/bin/sh\nexit 0\n"); execFileSync("chmod", ["+x", join(bin, name)]); }
  return `${bin}:${inertHarnessPath(base)}`;
}

/** A `pi` stub that answers `pi list` the way pi actually does: a two-space spec
 * line with an optional "(filtered)" marker, and the install path line ONLY when
 * the package is really installed — pi's list command guards it with
 * `if (pkg.installedPath)`. A stub that always printed a path made a
 * configured-but-never-installed package look installed, which is how a stale
 * row slipped through the gate (reviewer-6ad0dde). */
function fakePiWithPackages(base, rows) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const body = ["User packages:", ...rows.flatMap((r) => [
    `  ${r.source}${r.filtered ? " (filtered)" : ""}`,
    ...(r.dir ? [`    ${r.dir}`] : []),
  ])].join("\n");
  write(join(bin, "pi"), `#!/bin/sh\nif [ "$1" = "list" ]; then cat <<'EOF'\n${body}\nEOF\nfi\nexit 0\n`);
  write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  return `${bin}:${process.env.PATH}`;
}

function fixtureSoul(base, harness = "pi", type) {
  const repo = join(base, "repo"); gitRepo(repo);
  const root = join(base, "agents");
  const soul = join(root, "dev", "soul");
  write(join(soul, "soul.yaml"), `name: dev\nkind: persistent\n${type ? `type: ${type}\n` : ""}repo: ${repo}\nwork: checkout\nharness: ${harness}\n`);
  write(join(soul, "AGENTS.md"), "# Canonical dev\n\nNever mutate me.\n");
  symlinkSync("AGENTS.md", join(soul, "CLAUDE.md"));
  mkdirSync(join(root, "dev", "instances"), { recursive: true });
  return { repo, root, soul, agent: findAgent(root, "dev") };
}

/** A workspace-model deployment for one test (test/helpers/v2-deployment.mjs):
 *  souls and member capabilities of one repo, spawned through the real prepared
 *  path. The test runs in the fixture's isolated environment: the real process.env
 *  is made to hold exactly fx.env, and what was there is put back after. (Never by
 *  assigning another object to process.env: a child the kernel starts with no `env`
 *  does not get a replaced object on every Node, helpers/v2-deployment.mjs.) */
function v2(t, opts = {}) {
  const fx = v2Deployment(opts);
  const saved = { ...process.env };
  setProcessEnvironment(fx.env);
  const baseline = { ...fx.env };
  // fx.spawn/fx.prepare run in the fixture's environment; a test's own changes to
  // process.env since (a fake PATH, a polluted identity, a fault switch) ride along.
  const inEnv = fx.inEnv;
  fx.inEnv = (fn) => {
    const delta = Object.keys({ ...baseline, ...process.env }).filter((k) => process.env[k] !== baseline[k]).map((k) => [k, process.env[k]]);
    return inEnv(() => { for (const [k, v] of delta) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } return fn(); });
  };
  t.after(() => { setProcessEnvironment(saved); fx.cleanup(); });
  return fx;
}
/** soul.yaml `capabilities:` declaring member capabilities of the same repo. */
const here = (...ids) => Object.fromEntries(ids.map((id) => [id, { from: "here" }]));
/** A member capability: its manifest and files (test/helpers/v2-deployment.mjs capabilityFiles). */
const cap = (manifest, files = {}) => ({ manifest, files });
/** The common shape: one `dev` soul that declares every given member capability. */
function v2Dev(t, capabilities = {}, { soul = {}, souls = {}, ...rest } = {}) {
  return v2(t, { souls: { dev: { soul: { capabilities: here(...Object.keys(capabilities)), ...soul } }, ...souls }, capabilities, ...rest });
}
/** Replace a member capability's manifest (and add files) in a new commit. */
const recap = (fx, manifest, files = {}) => fx.commit(capabilityFiles(manifest.capability, manifest, files));
const instanceMeta = (home) => JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));
/** fx.spawn through another spelling of the agents root (e.g. a symlink to fx.root). */
async function spawnAt(fx, root, soul, opts = {}) {
  const { prepared, agent } = await fx.prepare(soul);
  const work = opts.work || agent.work || "directory";
  return spawnInstanceAsync(root, findAgent(root, soul), { launch: false, ...opts, prepared, repo: work === "directory" ? fx.dep : fx.member });
}

test("pi and Claude instances receive the same exact local skills and generated instructions", async (t) => {
  const fx = v2(t, {
    souls: { dev: { soul: { work: "checkout", capabilities: here("acme.review") }, agents: "# Canonical dev\n\nNever mutate me.\n", skills: { private: { description: "Private.", text: "# Private" } } } },
    capabilities: { "acme.review": { manifest: { description: "review", skills: ["skills/review"], inject: "inject.md" }, files: { "skills/review/SKILL.md": "---\nname: review\ndescription: Review.\n---\n# Review\n", "inject.md": "## Review capability\n\nUse review." } } },
  });
  write(join(fx.member, ".agents", "skills", "pollution", "SKILL.md"), "---\nname: pollution\ndescription: No.\n---\n# No\n");
  process.env.PATH = fakeHarnesses(fx.base);
  const pi = await fx.spawn("dev", { instance: "dev-pi", harness: "pi" });
  const claude = await fx.spawn("dev", { instance: "dev-claude", harness: "claude" });
  const soul = join(fx.root, "dev", "soul");
  const canonical = readFileSync(join(soul, "AGENTS.md"), "utf8");
  for (const meta of [pi, claude]) {
    const names = readdirSync(join(meta.home, ".agents", "skills")).sort();
    assert.deepEqual(names, ["private", "review"], "the soul's own skills and each module's, flat — no kernel-shipped fallback trio");
    assert.equal(lstatSync(join(meta.home, ".agents", "skills", "review")).isDirectory(), true);
    assert.equal(existsSync(join(meta.home, ".agents", "skills", "pollution")), false);
    assert.equal(lstatSync(join(meta.home, "AGENTS.md")).isSymbolicLink(), false);
    assert.equal(readlinkSync(join(meta.home, "CLAUDE.md")), "AGENTS.md");
    assert.match(readFileSync(join(meta.home, "AGENTS.md"), "utf8"), /Review capability/);
    const diskMeta = JSON.parse(readFileSync(join(meta.home, "instance.json"), "utf8"));
    assert.ok(diskMeta.capabilities.some((c) => c.id === "acme.review"));
    assert.deepEqual(diskMeta.skills.map((s) => [s.name, s.source]), [["private", "soul"], ["review", "module:acme.review"]],
      "instance.json.skills records the soul's own skills and each module skill with its module:<cap> source");
    if (meta.harness === "pi") {
      // Workspace model, decision 13: the harness starts NORMALLY. The composed
      // skills live at <home>/.agents/skills (pi discovers them from its cwd),
      // the instance's AGENTS.md is delivered by --append-system-prompt, and no
      // ambient-discovery flags are passed (ambient vs composed = harness precedence).
      assert.doesNotMatch(meta.command, /--no-skills/);
      assert.doesNotMatch(meta.command, /--no-context-files/);
      assert.doesNotMatch(meta.command, /--no-prompt-templates/);
      // Extensions stay AMBIENT by founder ruling: operators run cross-agent
      // pi extensions (web search, formatting) that every instance keeps.
      assert.doesNotMatch(meta.command, /--no-extensions/);
      assert.doesNotMatch(meta.command, / -e /);
      assert.match(meta.command, /--append-system-prompt/);
    }
    else assert.doesNotMatch(meta.command, /CLAUDE_CONFIG_DIR/);
  }
  assert.equal(readFileSync(join(soul, "AGENTS.md"), "utf8"), canonical);
});

test("duplicate skill names fail the spawn closed (decision 16): across modules, and between a soul's own skill and a module's (skills are flat)", async (t) => {
  const shared = { "skills/shared/SKILL.md": "---\nname: shared\ndescription: A.\n---\n" };
  const fx = v2(t, {
    souls: {
      dev: { soul: { capabilities: here("acme.dup", "acme.dup2") } },
      own: { soul: { capabilities: here("acme.dup") }, skills: { shared: { description: "B." } } },
    },
    capabilities: { "acme.dup": { manifest: { skills: ["skills/shared"] }, files: shared }, "acme.dup2": { manifest: { skills: ["skills/shared"] }, files: shared } },
  });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(fx.spawn("dev", { instance: "dev-bad" }), (e) => e.code === "E_SKILL_DUPLICATE");
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-bad")), false, "nothing was created");
  await assert.rejects(fx.spawn("own", { instance: "own-bad" }), (e) => e.code === "E_SKILL_DUPLICATE" && /skill "shared" from soul collides with module acme\.dup's skill/.test(e.message));
  assert.equal(existsSync(join(fx.root, "own", "instances", "own-bad")), false, "nothing was created");
});

test("claude runs this host's claude default launch configuration and hooks contribute launch args", async (t) => {
  // A spawn hook contributes harness launch args (the aweb channel-plugin pattern).
  const script = `console.log(JSON.stringify({ launch: { claude: "--extra-flag", pi: "--never-used" } }));`;
  // The host names its claude executable once, as the claude default (0.32); `--harness claude` names no configuration.
  const fx = v2Dev(t, { "acme.chan": cap({ hooks: { spawn: "hook.mjs" } }, { "hook.mjs": script }) }, { local: { "launch-configs": { personal: { harness: "claude", executable: "claude-personal", default: true } } } });
  const bin = join(fx.base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "claude-personal"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["+x", join(bin, "claude-personal")]);
  process.env.PATH = `${bin}:${fakeHarnesses(fx.base)}`;
  const res = await fx.spawn("dev", { instance: "dev-cl", harness: "claude" });
  const meta = instanceMeta(res.home);
  assert.equal(meta.harness, "claude");
  assert.match(meta.command, /claude-personal/);
  assert.equal(meta.launch.launchConfig, "personal");
  assert.equal(meta.launch.launchConfigDefault, true, "the record says the configuration came from the harness default");
  assert.match(meta.command, /--extra-flag/);
  assert.doesNotMatch(meta.command, /--never-used/);
  // "--" must terminate option parsing BEFORE the prompt: hook-contributed
  // flags can be greedy/variadic (aweb's --dangerously-load-development-
  // channels), and without the separator the TASK.md prompt is consumed
  // as the flag's next value — claude exits with a parse error and the
  // spawn looks silently stuck (operator report, dev-coordinator-claude-
  // sessions).
  assert.match(meta.command, /--extra-flag -- '@TASK\.md'$/, "prompt is separated from hook launch args by --");
});

test("pi task positional precedes capability-contributed launch args", async (t) => {
  const script = `console.log(JSON.stringify({ launch: { pi: "--append-system-prompt" } }));`;
  const fx = v2Dev(t, { "acme.chan": cap({ hooks: { spawn: "hook.mjs" } }, { "hook.mjs": script }) });
  process.env.PATH = fakeHarnesses(fx.base);
  const res = await fx.spawn("dev", { instance: "dev-pi-order", harness: "pi" });
  const meta = instanceMeta(res.home);
  const taskIndex = meta.command.indexOf("@TASK.md");
  const contributedArgIndex = meta.command.lastIndexOf("--append-system-prompt");
  assert.ok(taskIndex >= 0, meta.command);
  assert.ok(contributedArgIndex > taskIndex, `task must precede contributed args: ${meta.command}`);
  assert.doesNotMatch(meta.command, /--no-skills/); // decision 13: harness starts normally
});

test("spawn hook environment reaches exact Pi and Claude processes and overrides ambient values", async (t) => {
  const fx0 = { base: temp() };
  const externalHome = join(fx0.base, "principal home's credentials");
  mkdirSync(externalHome, { recursive: true });
  const fx = v2Dev(t, { "aweb.identity": cap({ environment: ["AWEB_A_FIRST", "AWEB_IDENTITY_HOME", "AWEB_Z_LAST"], hooks: { spawn: "hook.mjs" } },
    { "hook.mjs": `console.log(JSON.stringify({ env: { AWEB_Z_LAST: "z", AWEB_IDENTITY_HOME: ${JSON.stringify(externalHome)}, AWEB_A_FIRST: "a" } }));` }) });
  const bin = join(fx.base, "bin"); mkdirSync(bin);
  for (const harness of ["pi", "claude"]) {
    write(join(bin, harness), "#!/bin/sh\nprintf '%s' \"$AWEB_IDENTITY_HOME\" > \"$OATS_CAPTURE\"\n");
    execFileSync("chmod", ["+x", join(bin, harness)]);
  }
  process.env.PATH = `${bin}:${process.env.PATH}`;
  for (const harness of ["pi", "claude"]) {
    const capture = join(fx.base, `${harness}.identity-home`);
    const result = await fx.spawn("dev", { instance: `dev-env-${harness}`, harness });
    // The spawn answer's command is public (env values withheld); the persisted one runs.
    result.command = instanceMeta(result.home).command;
    execFileSync("/bin/sh", ["-c", result.command], {
      cwd: result.home,
      env: { ...process.env, AWEB_IDENTITY_HOME: join(fx.base, "wrong ambient"), OATS_CAPTURE: capture },
    });
    assert.equal(readFileSync(capture, "utf8"), externalHome);
    assert.match(result.command, /AWEB_IDENTITY_HOME=/);
    assert.ok(result.command.indexOf("AWEB_A_FIRST=") < result.command.indexOf("AWEB_IDENTITY_HOME="));
    assert.ok(result.command.indexOf("AWEB_IDENTITY_HOME=") < result.command.indexOf("AWEB_Z_LAST="));
  }
  rmSync(fx0.base, { recursive: true, force: true });
});

test("spawn hook environment rejects invalid values, namespace violations, core names, and collisions before metadata", async (t) => {
  const hookPrinting = (env) => ({ "hook.mjs": `console.log(${JSON.stringify(JSON.stringify({ env }))});` });
  const invalidCases = [
    ["non-string", { AWEB_IDENTITY_HOME: 42 }, /string/],
    ["newline", { AWEB_IDENTITY_HOME: "one\ntwo" }, /newline/],
    ["carriage-return", { AWEB_IDENTITY_HOME: "one\rtwo" }, /newline/],
    ["nul", { AWEB_IDENTITY_HOME: "one\0two" }, /NUL/],
    ["array-container", [], /object of string values/],
    ["null-container", null, /object of string values/],
    ["invalid-name", { "AWEB-BAD": "x" }, /name/],
    ["oversize", { AWEB_IDENTITY_HOME: "x".repeat(8193) }, /8192/],
    ["bootstrap-path", { PATH: "/tmp/evil" }, /process bootstrap/],
    ["core", { OATS_INSTANCE: "other" }, /reserved core/],
  ];
  // Declared (or undeclared) environment per capability, one soul per case, one deployment.
  const declaredCases = [
    ["node.evil", { NODE_OPTIONS: "--require=evil" }, /process bootstrap/, true],
    ["java.evil", { JAVA_TOOL_OPTIONS: "-javaagent:evil.jar" }, /process bootstrap/, true],
    ["dotnet.evil", { DOTNET_STARTUP_HOOKS: "evil.dll" }, /process bootstrap/, true],
    ["aweb.undeclared", { AWEB_IDENTITY_HOME: "/undeclared" }, /AWEB_IDENTITY_HOME is not declared in its trusted manifest environment/, false],
    ["glibc.undeclared", { GLIBC_TUNABLES: "glibc.malloc.check=3" }, /process bootstrap/, false],
    ["electron.undeclared", { ELECTRON_RUN_AS_NODE: "1" }, /process bootstrap/, false],
  ];
  const capabilities = {}, souls = {};
  invalidCases.forEach(([label, env], i) => {
    capabilities[`aweb.case${i}`] = cap({ environment: ["AWEB_IDENTITY_HOME"], hooks: { spawn: "hook.mjs" } }, hookPrinting(env));
    souls[`case-${label}`] = { soul: { capabilities: here(`aweb.case${i}`) } };
  });
  declaredCases.forEach(([id, env, , declared], i) => {
    capabilities[id] = cap({ ...(declared ? { environment: Object.keys(env) } : {}), hooks: { spawn: "hook.mjs" } }, hookPrinting(env));
    souls[`declared-${i}`] = { soul: { capabilities: here(id) } };
  });
  for (const name of ["one", "two"]) capabilities[`aweb.${name}`] = cap({ environment: ["AWEB_IDENTITY_HOME"], hooks: { spawn: "hook.mjs" } }, hookPrinting({ AWEB_IDENTITY_HOME: `/${name}` }));
  souls.collide = { soul: { capabilities: here("aweb.one", "aweb.two") } };
  capabilities["aweb.invalid"] = cap({ environment: ["AWEB_IDENTITY_HOME"], hooks: { spawn: "hook.mjs" } }, hookPrinting({ AWEB_IDENTITY_HOME: 42 }));
  souls.wt = { soul: { work: "worktree", capabilities: here("aweb.invalid") } };
  const fx = v2(t, { souls, capabilities });
  process.env.PATH = fakeHarnesses(fx.base);
  const refused = async (soul, instance, error) => {
    await assert.rejects(fx.spawn(soul, { name: instance }), error, `${soul}: ${error}`);
    assert.equal(existsSync(join(fx.root, soul, "instances", instance)), false, `${soul}: fatal env contract failure rolls back the scaffold`);
  };
  for (const [label, , error] of invalidCases) await refused(`case-${label}`, `dev-env-${label}`, error);
  for (const [i, [, , error]] of declaredCases.entries()) await refused(`declared-${i}`, `dev-hostile-env-${i}`, error);
  await refused("collide", "dev-env-collision", /both claim.*AWEB_IDENTITY_HOME/);

  // Launch environment authority requires a dotted lowercase ID: an undotted one is refused where
  // the manifest is read (discovery), so the soul that declares it never resolves and no hook runs.
  const undotted = v2Deployment({ souls: { dev: { soul: { capabilities: here("aweb-evil.identity") } } }, capabilities: { "aweb-evil.identity": cap({ environment: ["AWEB_IDENTITY_HOME"], hooks: { spawn: "hook.mjs" } }, hookPrinting({ AWEB_IDENTITY_HOME: "/stolen" })) } });
  try {
    await assert.rejects(undotted.spawn("dev", { name: "dev-hostile-env" }), (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details?.reason === "manifest-contract" && /lowercase dotted ID/.test(e.message));
    assert.equal(existsSync(join(undotted.root, "dev", "instances", "dev-hostile-env")), false);
  } finally { undotted.cleanup(); }
  // Workspace-model grammar (^[a-z0-9][a-z0-9._-]*$): `@`, `/` and upper case are refused at
  // manifest load — discovery reports the capability, and it never resolves.
  const grammar = v2Deployment({ capabilities: Object.fromEntries(["aweb@evil", "aweb/evil", "aweb.evil@other", "aweb.evil/other"].map((id, i) => [`hostile-${i}`, cap({ capability: id, environment: ["AWEB_IDENTITY_HOME"], hooks: { spawn: "hook.mjs" } }, hookPrinting({ AWEB_IDENTITY_HOME: "/stolen" }))])) });
  try {
    const problems = grammar.cli(["workspace", "status", "--json"]).json().result.problems;
    assert.deepEqual(problems.map((p) => [p.code, p.path]), [0, 1, 2, 3].map((i) => ["E_WORKSPACE_SCHEMA", `capabilities/hostile-${i}/oats.json#/capability`]));
    for (const p of problems) assert.match(p.message, /does not match \^\[a-z0-9\]/);
  } finally { grammar.cleanup(); }

  // A worktree spawn's fatal env contract removes the worktree and its branch, and the name is retryable.
  const worktreePath = join(fx.root, "wt", "instances", "dev-invalid-worktree", "work");
  const worktreeBranch = "agents/dev-invalid-worktree";
  await assert.rejects(fx.spawn("wt", { name: "dev-invalid-worktree", work: "worktree" }), /string/);
  assert.equal(existsSync(join(fx.root, "wt", "instances", "dev-invalid-worktree")), false);
  assert.doesNotMatch(execFileSync("git", ["-C", fx.member, "worktree", "list", "--porcelain"], { encoding: "utf8" }), new RegExp(worktreePath));
  const branchProbe = spawnSync("git", ["-C", fx.member, "rev-parse", "--verify", "--quiet", `refs/heads/${worktreeBranch}`]);
  assert.equal(branchProbe.status, 1, "fatal env contract rollback removes its worktree branch");
  fx.commit({ "capabilities/aweb.invalid/hook.mjs": `console.log(JSON.stringify({ env: { AWEB_IDENTITY_HOME: "/retry-succeeds" } }));` });
  const retried = await fx.spawn("wt", { name: "dev-invalid-worktree", work: "worktree" });
  assert.equal(existsSync(join(retried.home, "instance.json")), true, "same name is retryable after fatal contract rollback");
  retireInstance(fx.root, "dev-invalid-worktree", { keepDir: false, tmuxSession: "oats-test-nosuch" });
});

test("fatal hook environment contract compensates every attempted hook in reverse", async (t) => {
  const events = join(temp(), "hook-events");
  const fx = v2Dev(t, {
    "aweb.one": cap({ environment: ["AWEB_ONE"], hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, {
      "hook.mjs": `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(events)}, "one:" + process.env.OATS_EVENT + "\\n");
if (process.env.OATS_EVENT === "spawn") console.log(JSON.stringify({ env: { AWEB_ONE: "1" } }));`,
    }),
    "aweb.two": cap({ environment: ["AWEB_TWO"], hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, {
      "hook.mjs": `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(events)}, "two:" + process.env.OATS_EVENT + "\\n");
console.log(JSON.stringify({ env: { AWEB_TWO: 2 } }));`,
    }),
  });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(fx.spawn("dev", { instance: "dev-env-compensate" }), rollbackError(/rollback INCOMPLETE.*retire hook aweb.two.*supported only for spawn/, true));
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-env-compensate", ".oats-rollback-incomplete.json")), true);
  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), [
    "one:spawn", "two:spawn", "two:retire", "one:retire",
  ]);
  retireInstance(fx.root, "dev-env-compensate", { tmuxSession: "oats-test-nosuch", force: true });
  rmSync(dirname(events), { recursive: true, force: true });
});

test("fatal hook environment contract reports missing compensation without hiding side effects", async (t) => {
  const outside = temp(); const externalMarker = join(outside, "spawn-side-effect");
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const fx = v2Dev(t, { "aweb.sideeffect": cap({ environment: ["AWEB_IDENTITY_HOME"], hooks: { spawn: "hook.mjs" } }, {
    "hook.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(externalMarker)}, "spawn ran");
console.log(JSON.stringify({ meta: { created: true }, env: { AWEB_IDENTITY_HOME: 42 } }));`,
  }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(fx.spawn("dev", { instance: "dev-env-sideeffect" }), (error) => {
    assert.equal(error.details?.unconfirmed, true);
    assert.match(error.message, /rollback INCOMPLETE.*reported state it created.*no retire hook/);
    assert.doesNotMatch(error.message, /hooks compensated/);
    return true;
  });
  assert.equal(readFileSync(externalMarker, "utf8"), "spawn ran", "external side effect is observable and never claimed compensated");
  const retained = join(fx.root, "dev", "instances", "dev-env-sideeffect");
  assert.equal(existsSync(join(retained, ".oats-rollback-incomplete.json")), true, "cleanup evidence is retained");
  retireInstance(fx.root, "dev-env-sideeffect", { tmuxSession: "oats-test-nosuch", force: true });
});

test("hook environment is rejected outside the spawn event", async (t) => {
  const events = ["retire", "soul-scaffold"];
  const fx = v2(t, {
    souls: Object.fromEntries(events.map((event, i) => [`ev${i}`, { soul: { capabilities: here(`aweb.event${i}`) } }])),
    capabilities: Object.fromEntries(events.map((event, i) => [`aweb.event${i}`, cap({ environment: ["AWEB_IDENTITY_HOME"], hooks: { [event]: "hook.mjs" } }, {
      "hook.mjs": `console.log(JSON.stringify({ env: { AWEB_IDENTITY_HOME: "/ignored" } }));`,
    })])),
  });
  process.env.PATH = fakeHarnesses(fx.base);
  for (const [i, event] of events.entries()) {
    // The hook rows a home carries (instance.json capabilityRuntime) — what retire runs.
    const spawned = await fx.spawn(`ev${i}`, { name: `ev${i}-event` });
    const meta = instanceMeta(spawned.home);
    const result = runLifecycleHooks(event, {
      home: spawned.home, instance: meta.instance, agentName: meta.agent, contextDir: fx.dep, resolved: { capabilities: meta.capabilityRuntime },
    });
    assert.deepEqual(result.failures.map((f) => ({ event: f.event, required: f.required, contract: f.contract })), [
      { event, required: true, contract: "environment" },
    ]);
    assert.match(result.failures[0].message, new RegExp(`hook env is supported only for spawn and launch, not ${event}`));
  }
});

test("workspace mode links work to the deployment and records no branch", async (t) => {
  const fx = v2(t, { souls: { coord: { soul: { work: "workspace" } } } });
  process.env.PATH = fakeHarnesses(fx.base);
  const res = await fx.spawn("coord", { instance: "coord-1", work: "workspace" });
  assert.equal(res.work, "workspace");
  assert.equal(readlinkSync(join(res.home, "work")), resolve(fx.dep));
  assert.ok(readFileSync(join(res.home, "TASK.md"), "utf8").includes("WHOLE WORKSPACE"));
  assert.ok(readFileSync(join(res.home, "AGENTS.md"), "utf8").includes("Work mode: workspace"));
  assert.equal(instanceMeta(res.home).branch, undefined);
  // Retire never touches the deployment tree.
  retireInstance(fx.root, "coord-1", { tmuxSession: "oats-test-nosuch" });
  assert.ok(existsSync(join(fx.member, ".git")));
  assert.ok(existsSync(join(fx.dep, "oats-local.yaml")));
});

test("model preference lists resolve to the first available provider/model", async () => {
  const { resolveModelPreference } = await import("@awebai/oats/core");
  // single entries and empties pass through untouched (no probe)
  assert.equal(resolveModelPreference("", "pi"), "");
  assert.equal(resolveModelPreference("github-copilot/claude-fable-5:high", "pi"), "github-copilot/claude-fable-5:high");
  // claude: pi-style patterns TRANSLATE or DROP — claude takes aliases/bare
  // ids only (operator report: a pi-pattern soul default harness-overridden
  // to claude made claude reject the model at launch)
  assert.equal(resolveModelPreference("anthropic/claude-opus-4-5:high", "claude"), "claude-opus-4-5", "anthropic pattern → bare id, thinking stripped");
  assert.equal(resolveModelPreference("opus", "claude"), "opus", "alias passes through");
  assert.equal(resolveModelPreference("claude-fable-5", "claude"), "claude-fable-5", "bare id passes through");
  assert.equal(resolveModelPreference("github-copilot/claude-fable-5:high", "claude"), "", "non-anthropic provider entry drops to claude default");
  assert.equal(resolveModelPreference("github-copilot/x, anthropic/claude-sonnet-4-5, opus", "claude"), "claude-sonnet-4-5", "first usable list entry wins");
  // pi probing: fake `pi` whose --list-models only knows provider2/model-x
  const base = temp(); const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "pi"), "#!/bin/sh\necho 'provider2  model-x  1M  128K  yes  yes'\n");
  execFileSync("chmod", ["+x", join(bin, "pi")]);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${process.env.PATH}`;
  try {
    assert.equal(resolveModelPreference("provider1/model-x:high, provider2/model-x:high", "pi"), "provider2/model-x:high");
    // nothing available -> first preference (pi errors loudly at launch)
    assert.equal(resolveModelPreference("p/none, q/none", "pi"), "p/none");
  } finally { process.env.PATH = oldPath; }
});

test("hooks run in deterministic order, with retire reversing spawn", async (t) => {
  const order = join(temp(), "order");
  t.after(() => rmSync(dirname(order), { recursive: true, force: true }));
  const script = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(order)}, process.env.OATS_EVENT + ':' + process.env.OATS_CAPABILITY + '\\n');`;
  const fx = v2Dev(t, { "acme.z": cap({ hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, { "hook.mjs": script }), "acme.a": cap({ hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, { "hook.mjs": script }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await fx.spawn("dev", { instance: "dev-1" });
  retireInstance(fx.root, "dev-1", { tmuxSession: "oats-test-nosuch" });
  assert.deepEqual(readFileSync(order, "utf8").trim().split("\n"), ["spawn:acme.a", "spawn:acme.z", "retire:acme.z", "retire:acme.a"]);
});

/** One entry of a deployment's module store (<deployment>/.oats/modules/<id>@<commit>/),
 * the one directory outside a home whose manifest the kernel reads. */
function storeEntry(manifest) {
  const deployment = temp(); write(join(deployment, "oats-local.yaml"), "workspace: store-test\n");
  const dir = join(deployment, ".oats", "modules", "entry@0000000"); // a fixed name: ids under test carry `/`
  write(join(dir, "oats.json"), JSON.stringify({ version: "1.0.0", compatibility: { oats: ">=0.6.2" }, description: "Test capability.", ...manifest }, null, 2));
  return dir;
}

test("a capability may declare extra environment namespaces it speaks for, disclosed and never reserved", () => {
  const mk = (extra) => storeEntry({ capability: "acme.aw", environment: ["AWEB_DELIVERY"], ...(extra !== undefined ? { environmentNamespaces: extra } : {}) });
  assert.throws(() => capabilityManifest("acme.aw", mk(undefined)), /outside its ACME_ namespace \(declare another in environmentNamespaces\)/);
  assert.equal(capabilityManifest("acme.aw", mk(["AWEB_"])).environment.includes("AWEB_DELIVERY"), true);
  assert.throws(() => capabilityManifest("acme.aw", mk(["OATS_"])), /reserved namespace/);
  assert.throws(() => capabilityManifest("acme.aw", mk(["PATH"])), /uppercase prefix ending in an underscore|reserved namespace/);
  assert.throws(() => capabilityManifest("acme.aw", mk(["aweb_"])), /uppercase prefix/);
});

test("the kernel loader refuses a retirement declaration through the manifest contract, with the problem's pointer on the error", (t) => {
  const deployments = [];
  t.after(() => { for (const dir of deployments) rmSync(dir, { recursive: true, force: true }); });
  const load = (retirement) => {
    const entry = storeEntry({ capability: "acme.x", retirement });
    deployments.push(dirname(dirname(dirname(entry)))); // <deployment>/.oats/modules/<entry>
    return capabilityManifest("acme.x", entry);
  };
  // The receipts the list above takes from the kernel are really there: the set is not empty by accident.
  for (const name of [".oats-events.jsonl", ".oats-stop.json", ".oats-restart.json"]) assert.ok(KERNEL_HOME_RECEIPTS.has(name), name);
  for (const name of KERNEL_HOME_RECEIPTS) assert.ok(DISPOSABLE_HOME_REFUSED.some(([value, why]) => value === name && why === "kernel-owned"), `${name} is in the refused list`);
  // The entry under test is second, after a sound one: the pointer's index is the entry's own.
  for (const [value, why] of DISPOSABLE_HOME_REFUSED) {
    assert.throws(() => load({ disposable: { home: [".ok", value] } }), (e) => {
      assert.equal(e.pointer, "/retirement/disposable/home/1", JSON.stringify(value));
      assert.equal(e.message, disposableHomeRefusal("acme.x", value, why));
      return true;
    }, `${JSON.stringify(value)} is refused (${why})`);
  }
  for (const value of DISPOSABLE_HOME_ACCEPTED) {
    assert.deepEqual(load({ disposable: { home: [".ok", value] } }).retirement.disposable.home, [".ok", value], JSON.stringify(value));
  }
  assert.deepEqual(load({ disposable: { home: DISPOSABLE_HOME_ACCEPTED } }).retirement.disposable.home, DISPOSABLE_HOME_ACCEPTED);
  // The shape of the declaration: a `disposable` map, only `home` and `work`, each an array of strings.
  for (const [retirement, pointer, why] of [
    [{}, "/retirement", /^capability acme\.x manifest retirement must contain a disposable map$/],
    [{ disposable: [] }, "/retirement", /^capability acme\.x manifest retirement must contain a disposable map$/],
    [{ disposable: {}, extra: 1 }, "/retirement", /^capability acme\.x manifest retirement has unsupported keys: extra$/],
    [{ disposable: { other: [] } }, "/retirement", /^capability acme\.x manifest retirement has unsupported keys: other$/],
    [{ disposable: { home: ".aw" } }, "/retirement/disposable/home", /^capability acme\.x manifest retirement\.disposable\.home must be an array of relative roots$/],
    [{ disposable: { work: [1] } }, "/retirement/disposable/work", /^capability acme\.x manifest retirement\.disposable\.work must be an array of relative roots$/],
  ]) {
    assert.throws(() => load(retirement), (e) => {
      assert.equal(e.pointer, pointer, JSON.stringify(retirement));
      assert.match(e.message, why);
      return true;
    }, `${JSON.stringify(retirement)} is refused`);
  }
  assert.deepEqual(load({ disposable: { work: ["node_modules"] } }).retirement, { disposable: { work: ["node_modules"] } });
  assert.deepEqual(load({ disposable: {} }).retirement, { disposable: {} });
  // A work root: the grammar spawn records (lib/core.mjs retirementDisposableRoots), refused at the entry's own pointer.
  for (const value of ["", "/abs", "C:/x", "../x", "a/../b", "a//b", ".", "a/./b"]) {
    assert.throws(() => load({ disposable: { work: ["ok", value] } }), (e) => {
      assert.equal(e.pointer, "/retirement/disposable/work/1", JSON.stringify(value));
      assert.equal(e.message, `capability acme.x manifest retirement.disposable.work entry ${JSON.stringify(value)} must be a relative path under work/ with no empty, "." or ".." segment`);
      return true;
    }, `${JSON.stringify(value)} is refused`);
  }
  assert.deepEqual(load({ disposable: { work: ["build", "./dist/", "a/b", "a\\c"] } }).retirement.disposable.work, ["build", "./dist/", "a/b", "a\\c"], "accepted as declared: spawn normalizes");
  // Two entries of one manifest that are one root after normalization, or one inside the other, at the later entry.
  for (const [roots, at, other] of [
    [["build", "./build/"], 1, "build"],
    [["a", "b", "a/b"], 2, "a"],
    [["a/b", "a"], 1, "a/b"],
    [["a\\b", "x", "a/b/c"], 2, "a\\b"],
  ]) {
    assert.throws(() => load({ disposable: { work: roots } }), (e) => {
      assert.equal(e.pointer, `/retirement/disposable/work/${at}`, JSON.stringify(roots));
      assert.equal(e.message, `capability acme.x manifest retirement.disposable.work entry ${JSON.stringify(roots[at])} overlaps entry ${JSON.stringify(other)}: the same root, or one inside the other`);
      return true;
    }, `${JSON.stringify(roots)} overlap`);
  }
  // A prefix of a name is not a directory above it.
  assert.deepEqual(load({ disposable: { work: ["build", "build-cache", "a/b", "a/bc"] } }).retirement.disposable.work, ["build", "build-cache", "a/b", "a/bc"]);
});

// What the manifest cannot see, spawn refuses where it records the work roots (lib/core.mjs
// retirementDisposableRoots): a declared root that is a symlink in the work, and roots of
// different capabilities that overlap. Both are a broken capability, and the spawn rolls back.
test("a worktree spawn refuses a declared work root that is a symlink in the work, or overlapping roots of two capabilities, with E_CAPABILITY_BROKEN", async (t) => {
  const fx = v2(t, {
    souls: {
      linked: { soul: { work: "worktree", capabilities: here("acme.linked") } },
      dangling: { soul: { work: "worktree", capabilities: here("acme.dangling") } },
      overlap: { soul: { work: "worktree", capabilities: here("acme.outer", "acme.inner") } },
    },
    capabilities: {
      "acme.linked": cap({ retirement: { disposable: { work: ["cache"] } } }),
      "acme.dangling": cap({ retirement: { disposable: { work: ["lost"] } } }),
      "acme.outer": cap({ retirement: { disposable: { work: ["gen"] } } }),
      "acme.inner": cap({ retirement: { disposable: { work: ["./gen/inner/"] } } }),
    },
  });
  process.env.PATH = fakeHarnesses(fx.base);
  // A tracked symlink to a directory of the work, so the worktree spawn checks out has it.
  symlinkSync("souls", join(fx.base, "seed", "cache"));
  // And one whose target does not exist: a link all the same.
  symlinkSync("nowhere", join(fx.base, "seed", "lost"));
  fx.commit({}, "symlinked roots");
  for (const [soul, name, message] of [
    ["linked", "linked-1", /^retirement disposable root from acme\.linked is a symlink: cache — spawn rolled back$/],
    ["dangling", "dangling-1", /^retirement disposable root from acme\.dangling is a symlink: lost — spawn rolled back$/],
    ["overlap", "overlap-1", /^overlapping retirement disposable roots: gen(\/inner)? — spawn rolled back$/],
  ]) {
    await assert.rejects(fx.spawn(soul, { name, work: "worktree" }), (e) => {
      assert.equal(e.code, "E_CAPABILITY_BROKEN", `${soul}: ${e.code} ${e.message}`);
      assert.match(e.message, message);
      return true;
    }, soul);
    assert.equal(existsSync(join(fx.root, soul, "instances", name)), false, `${soul}: the spawn rolled back`);
    // The CLI names the refusal in its JSON error.
    const r = fx.cli(["spawn", soul, "--name", `${name}-cli`, "--no-launch", "--json"]);
    assert.notEqual(r.status, 0, `${soul}: ${r.stdout}`);
    assert.match(r.json().error.message, message, `${soul}: ${r.stdout}`);
    assert.equal(existsSync(join(fx.root, soul, "instances", `${name}-cli`)), false, `${soul}: the CLI spawn rolled back`);
  }
});

test("a hook may set a variable under a declared extra namespace at spawn, and the harness refuses one it did not declare", async (t) => {
  const out = join(temp(), "hook-out.json");
  t.after(() => rmSync(dirname(out), { recursive: true, force: true }));
  const fx = v2Dev(t, { "acme.aw": cap({ environment: ["AWEB_DELIVERY"], environmentNamespaces: ["AWEB_"], hooks: { spawn: "hook.mjs" } },
    { "hook.mjs": `import { writeFileSync } from "node:fs"; const name = process.env.EMIT_NAME || "AWEB_DELIVERY"; const out = { meta: {}, env: { [name]: "session" } }; writeFileSync(${JSON.stringify(out)}, JSON.stringify({ out, emit: process.env.EMIT_NAME || null })); console.log(JSON.stringify(out));` }) });
  process.env.PATH = fakeHarnesses(fx.base);
  try {
    // the manifest permits it AND the harness accepts it: the variable reaches the launch
    const r = await fx.spawn("dev", { instance: "dev-env", harness: "pi" });
    assert.match(instanceMeta(r.home).command, /AWEB_DELIVERY='?session'?/, "the declared namespace variable is in the launch command (persisted; the answer withholds env values)");
    retireInstance(fx.root, "dev-env", { tmuxSession: "oats-test-nosuch" });
    // an undeclared namespace is refused at spawn even though the manifest loaded
    process.env.EMIT_NAME = "OTHER_THING";
    await assert.rejects(fx.spawn("dev", { instance: "dev-env2", harness: "pi" }), /OTHER_THING is outside its ACME_, AWEB_ namespaces/);
  } finally { delete process.env.EMIT_NAME; }
});

test("launch environment authority requires an unambiguous dotted capability ID", () => {
  // Workspace-model grammar refuses `@`, `/` and upper case at manifest load;
  // an id that passes the grammar but is not dotted still fails the authority rule.
  for (const id of ["aweb@evil", "aweb/evil", "aweb.evil@other", "aweb.evil/other", "Aweb.evil"]) {
    assert.throws(() => capabilityManifest(id, storeEntry({ capability: id, environment: ["AWEB_IDENTITY_HOME"] })), /capability ID must match/);
  }
  for (const id of ["aweb-evil", "aweb_evil.x-"]) {
    assert.throws(() => capabilityManifest(id, storeEntry({ capability: id, environment: ["AWEB_IDENTITY_HOME"] })), /must use a lowercase dotted ID/);
  }

  // A capability that requests no environment authority needs only the grammar.
  assert.equal(capabilityManifest("aweb-evil", storeEntry({ capability: "aweb-evil" })).capability, "aweb-evil");
});

test("executable and nested skill paths cannot escape the package integrity boundary", async (t) => {
  const fx = v2(t, {
    souls: { hook: { soul: { capabilities: here("acme.escape") } }, skill: { soul: { capabilities: here("acme.escape-skill") } } },
    capabilities: {
      "acme.escape": cap({ hooks: { spawn: "../../../../outside.mjs" } }),
      "acme.escape-skill": cap({ skills: ["skills/escape"] }, {
        "skills/escape/SKILL.md": "---\nname: escape\ndescription: Escape.\n---\n",
        "skills/escape/outside.md": { symlink: "../../../../outside.md" },
      }),
    },
  });
  // The hook path leaves the capability directory — to a file that exists there — and the
  // manifest is refused where discovery reads it: nothing runs, no home is left behind.
  const marker = join(fx.base, "outside-ran");
  write(join(fx.root, "hook", "instances", "outside.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  await assert.rejects(fx.spawn("hook", { name: "hook-escape" }), (e) => e.code === "E_WORKSPACE_SCHEMA" && /hook "spawn" script "\.\.\/\.\.\/\.\.\/\.\.\/outside\.mjs" escapes the capability directory/.test(e.message));
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(fx.root, "hook", "instances", "hook-escape")), false);
  // A symlink inside a skill tree never enters the fetched module.
  await assert.rejects(fx.spawn("skill", { name: "skill-escape" }), (e) => e.code === "E_REMOTE_TREE_UNSAFE" && /skills\/escape\/outside\.md is a symlink/.test(e.message));
  assert.equal(existsSync(join(fx.root, "skill", "instances", "skill-escape")), false);
});

test("operational commands are gated by active instance metadata; doctor exposes final instructions", async (t) => {
  const fx = v2(t, {
    souls: { dev: { soul: { capabilities: here("acme.ops") }, agents: "# Canonical dev\n\nNever mutate me.\n" }, plain: {} },
    capabilities: { "acme.ops": cap({ command: "ops", commands: { ping: "ping.mjs" }, inject: "inject.md" }, { "ping.mjs": "console.log('pong')\n", "inject.md": "## Ops instructions" }) },
  });
  // Outside an instance home a capability command resolves as the soul whose resolution provides it:
  // --soul's, or without it the first soul that provides the namespace (named on stderr).
  let r = fx.cli(["ops", "ping"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pong/);
  assert.match(r.stderr, /oats ops: using the settings and teams of soul [\w.-]+\/dev,/);
  r = fx.cli(["ops", "ping", "--soul", "plain"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /unknown command "ops"/);
  r = fx.cli(["ops", "ping", "--soul", "dev"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pong/);
  // Inside a home, the recorded modules gate it.
  const home = (await fx.spawn("dev", { name: "dev-ops" })).home;
  r = fx.cli(["ops", "ping"], { cwd: home });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pong/);
  const plainHome = (await fx.spawn("plain", { name: "plain-ops" })).home;
  const notHere = (h, by) => new RegExp(`no capability of the instance home ${h} \\(soul plain\\), which ${by} chose, provides "ops"`);
  r = fx.cli(["ops", "ping"], { cwd: plainHome });
  assert.equal(r.status, 1); assert.match(r.stderr, notHere(plainHome, "the working directory"));
  // OATS_INSTANCE_HOME, the canonical identity, is recognised on its own and wins over OATS_HOME.
  r = fx.cli(["ops", "ping"], { cwd: fx.base, env: { OATS_INSTANCE_HOME: home } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pong/);
  r = fx.cli(["ops", "ping"], { cwd: fx.base, env: { OATS_INSTANCE_HOME: plainHome, OATS_HOME: home } });
  assert.equal(r.status, 1); assert.match(r.stderr, notHere(plainHome, "OATS_INSTANCE_HOME"));
  assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /Ops instructions/);
  const tree = () => spawnSync("find", [fx.dep, "-path", `${fx.member}`, "-prune", "-o", "-print"], { encoding: "utf8" }).stdout.split("\n").sort().join("\n");
  const before = tree();
  r = fx.cli(["doctor", "--soul", "dev", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const doctor = JSON.parse(r.stdout); assert.match(doctor.composedInstructions, /Canonical dev/);
  // No oats.core: no operating instructions at all (the kernel ships no "You run on OATS" copy since 0.26), and doctor says so.
  // Operator coverage (#671) reports on its own lines; this pins the oats.core note.
  assert.deepEqual(doctor.information.filter((l) => !l.startsWith("operator-coverage-unknown:")), ["soul dev has no oats.core capability (the workspace default); it gets no OATS operating instructions"]);
  assert.doesNotMatch(doctor.composedInstructions, /You run on OATS/);
  assert.ok(doctor.instructionBlocks.some((b) => b.source === "kernel:instance-boundary"));
  // The module's inject is part of what doctor shows, as it is of what a spawned home carries.
  assert.match(doctor.composedInstructions, /Ops instructions/);
  assert.deepEqual(doctor.instructionBlocks.filter((b) => b.source === "capability:acme.ops").map((b) => [b.file, b.content]), [[".oats/modules/acme.ops/inject.md", "## Ops instructions"]]);
  assert.equal(tree(), before, "doctor --soul writes nothing in the deployment");
  r = fx.cli(["doctor", "--soul", "dev"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Final composed AGENTS\.md for dev:[\s\S]*Ops instructions/);
  r = fx.cli(["doctor", "--soul", "nope", "--json"]);
  assert.equal(r.json().error.code, "E_SOUL_UNKNOWN");
  assert.equal(readFileSync(join(fx.member, "souls", "dev", "AGENTS.md"), "utf8"), "# Canonical dev\n\nNever mutate me.\n");
});

test("a capability command whose provider dies of a signal exits as the shell reports it (128 + n), not 1", (t) => {
  const fx = v2(t, {
    souls: { dev: { soul: { capabilities: here("acme.ops") } } },
    capabilities: { "acme.ops": cap({ command: "ops", commands: { die: "die.mjs" } }, { "die.mjs": "process.kill(process.pid, 'SIGINT');\nsetTimeout(() => {}, 5000);\n" }) },
  });
  const r = fx.cli(["ops", "die", "--soul", "dev"]);
  assert.equal(r.status, 130, r.stderr);
});

test("inject eject is a removed verb", () => {
  const base = temp(); const repo = join(base, "repo"); gitRepo(repo);
  // `inject eject` was removed by the workspace model (a capability's inject is
  // edited in its member repo).
  const r = spawnSync(process.execPath, [CLI, "inject", "eject", "acme.chat", "--dir", repo], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /removed by the workspace model/);
  assert.equal(existsSync(join(repo, ".agents", "injections")), false);
});

test("spawn lineage is explicit: ambient env never sets parent; --parent and attached owner do", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  const env = { PATH: fakeHarnesses(fx.base) };
  // 1. An unresolved caller name supplies no valid instance context: operator
  //    origin, top-level without --parent, and the task still lands in TASK.md.
  const polluted = { ...env, OATS_INSTANCE: "dev-existing", PI_AGENT_INSTANCE: "dev-existing" };
  let r = fx.cli(["spawn", "dev", "--task", "manual human task", "--purpose", "manual", "--no-launch", "--json"], { env: polluted });
  assert.equal(r.status, 0, r.stderr);
  const manual = jsonResult(r);
  assert.equal(manual.parent, null);
  assert.equal(manual.spawnOrigin, "operator");
  assert.match(readFileSync(join(manual.home, "TASK.md"), "utf8"), /manual human task/);
  // 2. --parent with an unknown instance is rejected before scaffolding.
  r = fx.cli(["spawn", "dev", "--parent", "no-such-instance", "--purpose", "bad", "--no-launch"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--parent "no-such-instance" does not match any known instance/);
  // 3. Explicit --parent naming a real instance nests, and a --task-file task lands.
  const tf = join(fx.base, "task.md"); writeFileSync(tf, "task from a file\n");
  r = fx.cli(["spawn", "dev", "--parent", manual.instance, "--task-file", tf, "--purpose", "child", "--no-launch", "--json"], { env });
  assert.equal(r.status, 0, r.stderr);
  const child = jsonResult(r);
  assert.equal(child.parent, manual.instance);
  assert.equal(child.spawnOrigin, "operator");
  assert.match(readFileSync(join(child.home, "TASK.md"), "utf8"), /task from a file/);
  // 4. --task without a value fails loudly instead of writing a broken TASK.md.
  r = fx.cli(["spawn", "dev", "--task", "--purpose", "oops", "--no-launch"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--task needs a value/);
  // 5. Kernel: attached ownership supplies lineage; the unresolved caller stays operator.
  process.env.PATH = fakeHarnesses(fx.base);
  const oldInst = process.env.OATS_INSTANCE; const oldPiInst = process.env.PI_AGENT_INSTANCE;
  process.env.OATS_INSTANCE = "dev-existing"; process.env.PI_AGENT_INSTANCE = "dev-existing";
  try {
    const attached = await fx.spawn("dev", { instance: "dev-svc", work: "attached", workDir: join(manual.home, "work"), task: "attached task" });
    assert.equal(attached.parentInstance, manual.instance, "attached fallback: work-tree owner is the parent");
    assert.equal(attached.spawnOrigin, "operator");
    assert.match(readFileSync(join(attached.home, "TASK.md"), "utf8"), /attached task/);
    // 6. Kernel: explicit o.parent supplies lineage; caller attribution stays operator.
    const nested = await fx.spawn("dev", { instance: "dev-sub", parent: manual.instance, task: "sub task" });
    assert.equal(nested.parentInstance, manual.instance);
    assert.equal(nested.spawnOrigin, "operator");
    // 7. Kernel: no relation stays top-level; the unresolved caller stays operator.
    const top = await fx.spawn("dev", { instance: "dev-top" });
    assert.equal(top.parentInstance, undefined);
    assert.equal(top.spawnOrigin, "operator");
    assert.match(readFileSync(join(top.home, "TASK.md"), "utf8"), /No task was provided/);
  } finally {
    if (oldInst === undefined) delete process.env.OATS_INSTANCE; else process.env.OATS_INSTANCE = oldInst;
    if (oldPiInst === undefined) delete process.env.PI_AGENT_INSTANCE; else process.env.PI_AGENT_INSTANCE = oldPiInst;
  }
});

test("a capability-agent home an earlier kernel left (0.29.0 creates none) stays listed, anchors a --parent spawn, and retires", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "directory" } } } });
  const env = { PATH: fakeHarnesses(fx.base) };
  // What a 0.28 spawn of a manifest `agents:` soul left, made by the kernel itself: an agent
  // record of kind "capability" whose dir under the agents root holds no soul, only instances/.
  const { prepared, agent } = await fx.prepare("dev");
  const legacy = { ...agent, name: "reviewer", kind: "capability", capability: "acme.rev", _dir: join(fx.root, "reviewer"), _soulDir: agent._soulDir ?? join(agent._dir, "soul") };
  const made = await fx.inEnv(() => spawnInstanceAsync(fx.root, legacy, { launch: false, prepared, repo: fx.dep, work: "directory", instance: "reviewer-abc" }));
  assert.equal(made.home, join(fx.root, "reviewer", "instances", "reviewer-abc"));
  assert.equal(existsSync(join(fx.root, "reviewer", "soul")), false, "a soul-less agent dir");
  // Then the home is rewritten into the exact 0.28 shape (re-review A #3), since the kernel spawn
  // above only supplies the independent retirement baseline a real 0.28 spawn also took:
  // instance.json records NO workspace.soul, and its soulDir is the capability module's copy in
  // the deployment's store, `.oats/modules/<cap>@<commit12>/agents/<name>`.
  const commit12 = "0123456789ab";
  const soulDir = join(fx.dep, ".oats", "modules", `acme.rev@${commit12}`, "agents", "reviewer");
  mkdirSync(soulDir, { recursive: true });
  writeFileSync(join(soulDir, "soul.yaml"), "name: reviewer\nkind: capability\nwork: directory\nharness: pi\ndescription: Reviewer.\n");
  writeFileSync(join(soulDir, "AGENTS.md"), "# Reviewer\n");
  const metaFile = join(made.home, "instance.json");
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  if (meta.workspace && typeof meta.workspace === "object") delete meta.workspace.soul;
  Object.assign(meta, { agent: "reviewer", soulDir });
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  assert.equal(JSON.parse(readFileSync(metaFile, "utf8")).workspace?.soul, undefined, "0.28-shaped: no workspace.soul");

  const status = JSON.parse(fx.cli(["status", "--json"], { env }).stdout);
  const row = status.agents.find((a) => a.name === "reviewer");
  assert.deepEqual([row?.kind, row?.instances.map((i) => i.instance)], ["capability", ["reviewer-abc"]], JSON.stringify(status.agents));
  const r = fx.cli(["spawn", "dev", "--parent", "reviewer-abc", "--task", "child work", "--purpose", "child", "--no-launch", "--json"], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(jsonResult(r).parent, "reviewer-abc");
  const retired = fx.cli(["retire", "reviewer-abc", "--json"], { env });
  assert.equal(retired.status, 0, retired.stdout + retired.stderr);
  assert.equal(existsSync(made.home), false, "retired: the home is gone");
});

test("spawn relations: child/sibling/parent/unrelated, sugar equivalence, validation", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const env = { PATH: fakeHarnesses(base) };
  const spawn = (...extra) => fx.cli(["spawn", "dev", "--no-launch", "--json", ...extra], { env });
  const metaOf = (home) => JSON.parse(readFileSync(join(home, "instance.json"), "utf8"));

  // Root anchor: no relation flags → unrelated (as today).
  let r = spawn("--purpose", "anchor");
  assert.equal(r.status, 0, r.stderr);
  const anchor = jsonResult(r);
  assert.equal(anchor.parent, null); assert.equal(anchor.relation, null);

  // child: --relation child --relative-to === --parent sugar (same recorded fields).
  r = spawn("--purpose", "kid", "--relation", "child", "--relative-to", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const kid = jsonResult(r);
  assert.equal(kid.parent, anchor.instance);
  assert.equal(kid.relation, "child");
  assert.equal(kid.spawnOrigin, "operator");
  r = spawn("--purpose", "kid-sugar", "--parent", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const sugar = jsonResult(r);
  assert.equal(sugar.parent, anchor.instance);
  assert.equal(sugar.relation, "child", "--parent is sugar for --relation child");
  const kidMeta = metaOf(kid.home); const sugarMeta = metaOf(sugar.home);
  assert.equal(kidMeta.parentInstance, sugarMeta.parentInstance);
  assert.equal(kidMeta.relation, sugarMeta.relation);
  assert.equal(kidMeta.siblingInstance, undefined);

  // sibling of a CHILD: shares the child's parent (same cluster, same level).
  r = spawn("--purpose", "peer", "--relation", "sibling", "--relative-to", kid.instance);
  assert.equal(r.status, 0, r.stderr);
  const peer = jsonResult(r);
  assert.equal(peer.parent, anchor.instance, "sibling of a child shares the parent");
  assert.equal(peer.sibling, null);
  assert.equal(metaOf(peer.home).relativeTo, kid.instance);

  // sibling of a ROOT: no parent to share → explicit siblingInstance link keeps one cluster.
  r = spawn("--purpose", "rootpeer", "--relation", "sibling", "--relative-to", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const rootPeer = jsonResult(r);
  assert.equal(rootPeer.parent, null);
  assert.equal(rootPeer.sibling, anchor.instance, "root sibling records siblingInstance");
  assert.equal(metaOf(rootPeer.home).siblingInstance, anchor.instance);

  // parent: the NEW instance becomes the anchor's parent; anchor lineage re-pointed.
  r = spawn("--purpose", "boss", "--relation", "parent", "--relative-to", kid.instance);
  assert.equal(r.status, 0, r.stderr);
  const boss = jsonResult(r);
  assert.equal(boss.parent, anchor.instance, "new parent inherits the anchor's old slot");
  assert.equal(metaOf(kid.home).parentInstance, boss.instance, "anchor re-pointed to the new instance");

  // parent of a ROOT: new instance is top-level, anchor nests under it.
  r = spawn("--purpose", "rootboss", "--relation", "parent", "--relative-to", anchor.instance);
  assert.equal(r.status, 0, r.stderr);
  const rootBoss = jsonResult(r);
  assert.equal(rootBoss.parent, null);
  assert.equal(metaOf(anchor.home).parentInstance, rootBoss.instance);

  // unrelated: explicit flag behaves like the default and takes no --relative-to.
  r = spawn("--purpose", "stranger", "--relation", "unrelated");
  assert.equal(r.status, 0, r.stderr);
  const stranger = jsonResult(r);
  assert.equal(stranger.parent, null); assert.equal(stranger.relation, null);
  assert.equal(stranger.spawnOrigin, "operator");

  // status --json exposes the lineage fields desktop consumes.
  r = fx.cli(["status", "--json"], { env });
  assert.equal(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  const insts = status.agents.find((a) => a.name === "dev").instances;
  const sKid = insts.find((i) => i.instance === kid.instance);
  assert.equal(sKid.parentInstance, boss.instance);
  const sPeer = insts.find((i) => i.instance === rootPeer.instance);
  assert.equal(sPeer.siblingInstance, anchor.instance);

  // Validation errors (E_BAD_ARGS / not-found), all before scaffolding.
  // JSON mode: failures are a stdout envelope with a stable error code.
  const fail = (re, ...extra) => {
    const x = spawn("--purpose", "bad", ...extra);
    assert.equal(x.status, 1);
    const env2 = JSON.parse(x.stdout);
    assert.equal(env2.ok, false);
    assert.match(env2.error?.message || "", re);
  };
  fail(/--relation child requires --relative-to/, "--relation", "child");
  fail(/--relation sibling requires --relative-to/, "--relation", "sibling");
  fail(/--relation parent requires --relative-to/, "--relation", "parent");
  fail(/unknown --relation "boss"/, "--relation", "boss", "--relative-to", anchor.instance);
  fail(/--relative-to requires --relation/, "--relative-to", anchor.instance);
  fail(/--relation unrelated takes no --relative-to/, "--relation", "unrelated", "--relative-to", anchor.instance);
  fail(/use one form, not both/, "--parent", anchor.instance, "--relation", "child", "--relative-to", anchor.instance);
  fail(/--relation needs a value/, "--relation", "--relative-to", anchor.instance);
  fail(/does not match any known instance/, "--relation", "sibling", "--relative-to", "no-such-instance");

  // ATTACHED agents are ALWAYS children of the work-tree owner (design
  // decision): no relation flags → auto-parent from the canonically resolved
  // owner; non-child relations → rejected; a non-instance work dir requires an
  // explicit --parent naming the owner.
  r = spawn("--purpose", "cli-att-un", "--work", "attached", "--work-dir", join(anchor.home, "work"), "--repo", fx.member, "--relation", "unrelated");
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error?.message || "", /always children/);
  r = spawn("--purpose", "cli-att-par", "--work", "attached", "--work-dir", join(anchor.home, "work"), "--repo", fx.member, "--relation", "parent", "--relative-to", anchor.instance);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error?.message || "", /always children/);
  r = spawn("--purpose", "cli-att", "--work", "attached", "--work-dir", join(anchor.home, "work"), "--repo", fx.member);
  assert.equal(r.status, 0, r.stderr);
  const cliAtt = jsonResult(r);
  assert.equal(cliAtt.parent, anchor.instance, "CLI: attached auto-parents under the work-tree owner");
  process.env.PATH = fakeHarnesses(base);
  {
    const att = await fx.spawn("dev", { instance: "dev-att", work: "attached", workDir: join(anchor.home, "work") });
    assert.equal(att.parentInstance, anchor.instance, "attached auto-parents under the work-tree owner");
    // Kernel enforces the invariant too (covers soul-default attached mode):
    // contradictory relations rejected; redundant child-of-owner allowed.
    await assert.rejects(fx.spawn("dev", { instance: "dev-att-un", work: "attached", workDir: join(anchor.home, "work"), relation: "unrelated" }), /always children/);
    await assert.rejects(fx.spawn("dev", { instance: "dev-att-sib", work: "attached", workDir: join(anchor.home, "work"), relation: "sibling", relativeTo: anchor.instance }), /always children/);
    const attKid = await fx.spawn("dev", { instance: "dev-att-kid", work: "attached", workDir: join(anchor.home, "work"), parent: anchor.instance });
    assert.equal(attKid.parentInstance, anchor.instance, "redundant child-of-owner is accepted");
    // Ownership is CANONICAL, not lexical: a path merely SHAPED like <owner>/work
    // never records a nonexistent parent, and a non-instance tree (e.g. a
    // coordinator's integration worktree) requires an explicit --parent owner.
    const fakeOwner = join(base, "not-an-instance", "work"); mkdirSync(fakeOwner, { recursive: true });
    await assert.rejects(fx.spawn("dev", { instance: "dev-att-fake", work: "attached", workDir: fakeOwner }), /not a known instance/);
    const integ = join(base, "integration-tree"); mkdirSync(integ, { recursive: true });
    await assert.rejects(fx.spawn("dev", { instance: "dev-att-integ", work: "attached", workDir: integ }), /not a known instance/);
    const owned = await fx.spawn("dev", { instance: "dev-att-owned", work: "attached", workDir: integ, parent: anchor.instance });
    assert.equal(owned.parentInstance, anchor.instance, "non-instance tree with explicit --parent owner attaches as its child");

    // Direct-kernel rejection happens BEFORE scaffolding and hooks: no home dir remains.
    const assertNoHome = async (name, fn, re) => {
      await assert.rejects(fn(), re);
      assert.equal(existsSync(join(root, "dev", "instances", name)), false, `${name}: no instance dir left behind`);
    };
    await assertNoHome("dev-badrel", () => fx.spawn("dev", { instance: "dev-badrel", relation: "boss", relativeTo: anchor.instance }), /unknown relation/);
    await assertNoHome("dev-norel", () => fx.spawn("dev", { instance: "dev-norel", relation: "sibling" }), /needs a relative-to/);
    await assertNoHome("dev-noanchor", () => fx.spawn("dev", { instance: "dev-noanchor", relation: "sibling", relativeTo: "no-such-instance" }), /was not found/);
    // Kernel validates the RAW option combination (programmatic callers bypass
    // the CLI): contradictory shapes are rejected, never silently normalized.
    await assertNoHome("dev-dangling", () => fx.spawn("dev", { instance: "dev-dangling", relativeTo: anchor.instance }), /needs a relation/);
    await assertNoHome("dev-unrel-rt", () => fx.spawn("dev", { instance: "dev-unrel-rt", relation: "unrelated", relativeTo: anchor.instance }), /takes no relativeTo/);
    await assertNoHome("dev-both", () => fx.spawn("dev", { instance: "dev-both", parent: anchor.instance, relation: "child", relativeTo: anchor.instance }), /one form, not both/);
    await assertNoHome("dev-rr-only", () => fx.spawn("dev", { instance: "dev-rr-only", relativeRoot: root }), /only qualifies/);
  }
});


test("anchor enumeration sees intra-root duplicates (generated-name collisions)", async (t) => {
  // Two agents whose generated names collide: agent "dev" with purpose "foo-1"
  // and agent "dev-foo" with purpose "1" both yield instance "dev-foo-1".
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } }, "dev-foo": { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  process.env.PATH = fakeHarnesses(base);
  try {
    await fx.spawn("dev", { instance: "dev-foo-1" });
    await fx.spawn("dev-foo", { instance: "dev-foo-1" });
    // findInstanceHomes surfaces both; first-match findInstanceHome sees one.
    assert.equal(findInstanceHomes(root, "dev-foo-1").length, 2, "both same-named homes enumerated");
    // A relation anchored on the duplicated name is inherently ambiguous —
    // --relative-root cannot split two matches under ONE root.
    await assert.rejects(fx.spawn("dev", { instance: "dev-kid-dup", relation: "child", relativeTo: "dev-foo-1", relativeRoot: root }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS" && /inherently ambiguous/.test(e.message),
      "intra-root duplicate anchor rejected even with --relative-root");
    await assert.rejects(fx.spawn("dev", { instance: "dev-kid-dup", relation: "child", relativeTo: "dev-foo-1" }),
      (e) => e.code === "E_RELATIVE_AMBIGUOUS",
      "intra-root duplicate anchor rejected without qualifier too");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-kid-dup")), false, "no stray home");
  } finally { process.env.PATH = oldPath; }
});

test("retire refuses a same-named twin by name alone and retires exactly the home it is given", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } }, "dev-foo": { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  process.env.PATH = fakeHarnesses(base);
  try {
    await fx.spawn("dev", { instance: "dev-foo-1" });
    await fx.spawn("dev-foo", { instance: "dev-foo-1" });
    const homes = findInstanceHomes(root, "dev-foo-1");
    assert.equal(homes.length, 2);
    const first = join(root, "dev", "instances", "dev-foo-1"), second = join(root, "dev-foo", "instances", "dev-foo-1");
    // By name alone: refused, both homes named, nothing removed.
    assert.throws(() => retireInstance(root, "dev-foo-1", { keepDir: false }), (e) => e.code === "E_AMBIGUOUS_INSTANCE" && e.message.includes(first) && e.message.includes(second));
    assert.equal(existsSync(first), true); assert.equal(existsSync(second), true);
    // A home that is not one of that name's homes: refused.
    assert.throws(() => retireInstance(root, "dev-foo-1", { home: join(root, "dev", "instances", "other") }), (e) => e.code === "E_HOME_MISMATCH");
    assert.equal(existsSync(first), true); assert.equal(existsSync(second), true);
    // The second twin, by home: only it goes; the first-match twin survives.
    const r = retireInstance(root, "dev-foo-1", { home: second });
    assert.equal(r.retired, "dev-foo-1"); assert.equal(r.agent, "dev-foo");
    assert.equal(existsSync(second), false, "the addressed twin is retired");
    assert.equal(existsSync(first), true, "the first-match twin is untouched");
    // One home left: the bare name resolves again.
    assert.equal(retireInstance(root, "dev-foo-1", {}).agent, "dev");
    assert.equal(existsSync(first), false);
  } finally { process.env.PATH = oldPath; }
});

test("a deferred self-retirement of a same-named twin completes with the home recorded in its intent", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } }, "dev-foo": { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  process.env.PATH = fakeHarnesses(base);
  try {
    await fx.spawn("dev", { instance: "dev-foo-1" });
    await fx.spawn("dev-foo", { instance: "dev-foo-1" });
    const first = join(root, "dev", "instances", "dev-foo-1"), second = join(root, "dev-foo", "instances", "dev-foo-1");
    // The intent the deferral writes for the second twin (options.home is
    // what scheduleDeferredSelfRetirement records); the completion must
    // pass it on, or it hits the ambiguity refusal it was recorded to avoid.
    const resultPath = join(base, "result.json");
    const intent = { instance: "dev-foo-1", agent: "dev-foo", root, requestedAt: new Date().toISOString(), requestedByPid: process.pid, delaySec: 0, options: { home: second, deleteBranch: false, tmuxSession: "oats" }, resultPath };
    const ok = completeDeferredRetirement(intent, { quiesce: false });
    assert.equal(ok, true, existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "completion returned false without recording");
    assert.equal(existsSync(second), false, "the twin named by the intent is retired");
    assert.equal(existsSync(first), true, "the first-match twin survives");
    const noHome = { ...intent, instance: "dev-foo-1", options: { deleteBranch: false }, resultPath: join(base, "r2.json") };
    await fx.spawn("dev-foo", { instance: "dev-foo-1" });
    assert.equal(completeDeferredRetirement(noHome, { quiesce: false }), false, "without a home the ambiguous completion fails closed");
    assert.match(readFileSync(noHome.resultPath, "utf8"), /E_AMBIGUOUS_INSTANCE/);
    assert.equal(existsSync(first), true); assert.equal(existsSync(second), true);
  } finally { process.env.PATH = oldPath; }
});

test("retire splices lineage: orphans inherit the retiree's links (parent-relation reviewer cycle)", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  process.env.PATH = fakeHarnesses(base);
  const metaOf = (name) => JSON.parse(readFileSync(join(root, "dev", "instances", name, "instance.json"), "utf8"));
  try {
      // coordinator → developer (child) → reviewer (parent relation over the developer).
    const coord = await fx.spawn("dev", { instance: "dev-coord" });
    const developer = await fx.spawn("dev", { instance: "dev-worker", relation: "child", relativeTo: coord.instance });
    const reviewer = await fx.spawn("dev", { instance: "dev-rev", relation: "parent", relativeTo: developer.instance });
    assert.equal(reviewer.parentInstance, coord.instance, "reviewer takes the developer's slot under the coordinator");
    assert.equal(metaOf(developer.instance).parentInstance, reviewer.instance);
    // Reviewer retires → the developer returns to the coordinator (no dangling parent).
    const r = retireInstance(root, reviewer.instance, { keepDir: false });
    assert.ok(r.relinked?.some((x) => x.instance === developer.instance && x.parentInstance === coord.instance), "retire reports the splice");
    assert.equal(metaOf(developer.instance).parentInstance, coord.instance, "developer re-pointed to its previous parent");
    // Root-parent case: reviewer over a ROOT instance → on retire the root becomes a root again.
    const solo = await fx.spawn("dev", { instance: "dev-solo" });
    const rev2 = await fx.spawn("dev", { instance: "dev-rev2", relation: "parent", relativeTo: solo.instance });
    assert.equal(metaOf(solo.instance).parentInstance, rev2.instance);
    retireInstance(root, rev2.instance, { keepDir: false });
    assert.equal(metaOf(solo.instance).parentInstance, undefined, "root anchor is a root again after its reviewer retires");
    // Sibling-link splice: root sibling link to a retiring instance is dropped.
    // parent-relation anchor rewrite is committed only AFTER a successful
    // launch: force a launch failure (PATH without tmux) and assert the
    // anchor's lineage is untouched — no edge to a zombie spawn.
    const rev4 = await (async () => {
      const restore = process.env.PATH;
      // pi/claude/git available, tmux NOT: which() must fail on tmux only.
      const noTmux = join(base, "bin-notmux"); mkdirSync(noTmux, { recursive: true });
      for (const t of ["pi", "claude"]) write(join(noTmux, t), "#!/bin/sh\nexit 0\n");
      execFileSync("chmod", ["-R", "+x", noTmux]);
      const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      symlinkSync(gitPath, join(noTmux, "git"));
      process.env.PATH = noTmux;
      try {
        await assert.rejects(fx.spawn("dev", { instance: "dev-rev4", relation: "parent", relativeTo: solo.instance, launch: true }),
          /tmux not installed/,
          "launch failure surfaces");
      } finally { process.env.PATH = restore; }
    })();
    void rev4;
    assert.equal(metaOf(solo.instance).parentInstance, undefined, "anchor NOT re-pointed by the failed launch");
    // Anchor-write failure AFTER successful scaffold/launch is COMPENSATED:
    // make the anchor's instance.json unwritable, spawn a parent relation, and
    // assert the spawn throws AND the new home is rolled back (no zombie).
    const soloMetaPath = join(root, "dev", "instances", solo.instance, "instance.json");
    execFileSync("chmod", ["444", soloMetaPath]);
    execFileSync("chmod", ["555", dirname(soloMetaPath)]);
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-rev5", relation: "parent", relativeTo: solo.instance }),
        rollbackError(/failed to re-point anchor.*rolled back/s, undefined),
        "anchor-write failure is compensated");
    } finally {
      execFileSync("chmod", ["755", dirname(soloMetaPath)]);
      execFileSync("chmod", ["644", soloMetaPath]);
    }
    assert.equal(existsSync(join(root, "dev", "instances", "dev-rev5")), false, "rolled-back spawn leaves no home");
    assert.equal(metaOf(solo.instance).parentInstance, undefined, "anchor unchanged after compensated failure");
    const peer = await fx.spawn("dev", { instance: "dev-peer", relation: "sibling", relativeTo: solo.instance });
    assert.equal(metaOf(peer.instance).siblingInstance, solo.instance);
    // Mixed edge types: reviewer R as parent over root-sibling peer absorbs
    // peer's sibling link (R.siblingInstance = solo). Retiring R must restore
    // BOTH: peer loses parent AND regains the sibling link — the orphan inherits
    // the retiree's COMPLETE lineage, not just the same-typed edge.
    const rev3 = await fx.spawn("dev", { instance: "dev-rev3", relation: "parent", relativeTo: peer.instance });
    assert.equal(rev3.siblingInstance, solo.instance, "parent-relation reviewer absorbs the anchor's sibling link");
    assert.equal(metaOf(peer.instance).parentInstance, rev3.instance);
    assert.equal(metaOf(peer.instance).siblingInstance, undefined);
    retireInstance(root, rev3.instance, { keepDir: false });
    assert.equal(metaOf(peer.instance).parentInstance, undefined, "peer is a root again");
    assert.equal(metaOf(peer.instance).siblingInstance, solo.instance, "cross-type splice restores the sibling cluster link");
    retireInstance(root, solo.instance, { keepDir: false });
    assert.equal(metaOf(peer.instance).siblingInstance, undefined, "dangling sibling link dropped on retire");
  } finally { process.env.PATH = oldPath; }
});

test("parent-relation rollback after LAUNCH kills the window, compensates hooks, and never truncates the anchor", async (t) => {
  // Capability whose spawn/retire hooks record every event — compensation must
  // fire retire for the rolled-back instance.
  const logDir = temp(); t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const hookLog = join(logDir, "hook-events");
  const script = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(hookLog)}, process.env.OATS_EVENT + ':' + process.env.OATS_INSTANCE + '\\n');`;
  const fx = v2Dev(t, { "acme.comp": cap({ hooks: { spawn: "hook.mjs", retire: "hook.mjs" } }, { "hook.mjs": script }) }, { soul: { work: "checkout" } });
  const { base, root } = fx; const repo = fx.member;
  // STATEFUL fake tmux: tracks window names in a file so list-windows reflects
  // new-window/kill-window; TMUX_FAKE_STUBBORN names a window that kill-window
  // silently fails to remove (for truth-telling assertions). The kernel addresses a
  // server first (-u, then -L oats or -S <socket>): the command follows. No session
  // exists (list-sessions prints nothing), so each launch creates it and is answered
  // its socket and first window. TMUX_FAKE_LIST_FAIL breaks list-windows only AFTER a
  // kill-window: the compensation's probe, not the launch's own collision check.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const tmuxLog = join(base, "tmux-log");
  const tmuxWins = join(base, "tmux-windows");
  write(tmuxWins, "");
  write(join(bin, "tmux"), [
    "#!/bin/sh",
    `echo "$@" >> ${tmuxLog}`,
    'while :; do case "$1" in -u) shift ;; -L|-S) shift 2 ;; *) break ;; esac; done',
    'cmd="$1"',
    'case "$cmd" in',
    `  new-session) printf '' > ${tmuxWins}.killed; printf '/tmp/oats-test-fake.sock\\t@0\\n' ;;`,
    // The server has the PATH of the client that started it, as tmux's does: a pane looks its harness up there.
    `  show-environment) printf 'PATH="%s"; export PATH;\\n' "$PATH" ;;`,
    "  new-window)",
    `    while [ $# -gt 0 ]; do if [ "$1" = "-n" ]; then echo "$2" >> ${tmuxWins}; fi; shift; done`,
    "    echo @1 ;;",
    "  kill-window)",
    `    echo 1 > ${tmuxWins}.killed`,
    '    while [ $# -gt 0 ]; do if [ "$1" = "-t" ]; then t="$2"; fi; shift; done',
    "    name=$(printf '%s' \"$t\" | sed 's/.*:=//')",
    `    if [ "$name" != "$TMUX_FAKE_STUBBORN" ]; then grep -v -x "$name" ${tmuxWins} > ${tmuxWins}.n || true; mv ${tmuxWins}.n ${tmuxWins}; fi ;;`,
    "  list-windows)",
    `    if [ -n "$TMUX_FAKE_LIST_FAIL" ] && [ -s ${tmuxWins}.killed ]; then echo "list-windows broken" >&2; exit 1; fi`,
    `    cat ${tmuxWins} ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  for (const t of ["pi", "claude"]) write(join(bin, t), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  for (const t of ["git", "node", "chmod", "sh", "grep", "sed", "mv", "cat", "printf"]) symlinkSync(execFileSync("which", [t], { encoding: "utf8" }).trim(), join(bin, t));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}`;
  try {
    const anchor = await fx.spawn("dev", { instance: "dev-anchor", tmuxSession: "oats-test-fake" });
    const anchorMetaPath = join(anchor.home, "instance.json");
    const before = readFileSync(anchorMetaPath, "utf8");
    // Force the ATOMIC anchor write to fail AFTER a successful launch: 555 on
    // the anchor's home blocks the same-directory temp file creation — the
    // target instance.json is never truncated (rename never happens).
    execFileSync("chmod", ["555", anchor.home]);
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake", launch: true }),
        rollbackError(/failed to re-point anchor.*rolled back/s, undefined));
    } finally { execFileSync("chmod", ["755", anchor.home]); }
    // Anchor file NEVER truncated or altered (atomic temp+rename path).
    assert.equal(readFileSync(anchorMetaPath, "utf8"), before, "anchor instance.json byte-identical");
    // The launched window was killed with an exact-match target.
    const tmuxCalls = readFileSync(tmuxLog, "utf8");
    assert.match(tmuxCalls, /new-window .*dev-zomb/, "window was launched");
    assert.match(tmuxCalls, /kill-window -t =oats-test-fake:=dev-zomb/, "launched window killed exact-match");
    // Spawn hooks were compensated with retire for the rolled-back instance.
    const events = readFileSync(hookLog, "utf8").trim().split("\n");
    assert.ok(events.includes("spawn:dev-zomb"), "spawn hook ran");
    assert.ok(events.includes("retire:dev-zomb"), "retire hook compensated the rolled-back spawn");
    // Scaffold removed; no temp file remains next to the anchor meta.
    assert.equal(existsSync(join(root, "dev", "instances", "dev-zomb")), false, "no zombie home");
    assert.ok(!readdirSync(anchor.home).some((f) => f.includes(".tmp-")), "no leftover temp file");

    // Temp-cleanup failure must not abort the rollback: pre-create a NON-EMPTY
    // DIRECTORY at the deterministic temp path — writeFileSync fails (EISDIR,
    // the original error) AND rmSync(tmpPath, {force:true}) throws (EISDIR/
    // ENOTEMPTY without recursive), which previously aborted all remaining
    // compensation (window kill, hooks, scaffold removal).
    const tmpDir = `${anchorMetaPath}.tmp-dev-zomb2`;
    mkdirSync(tmpDir); write(join(tmpDir, "blocker"), "x");
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb2", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake", launch: true }),
        rollbackError(/failed to re-point anchor.*rollback INCOMPLETE.*tmp-dev-zomb2/s, true),
        "original anchor-write error surfaces, and the unremovable temp is reported for manual cleanup");
    } finally { rmSync(tmpDir, { recursive: true, force: true }); }
    assert.equal(readFileSync(anchorMetaPath, "utf8"), before, "anchor still byte-identical");
    const tmuxCalls2 = readFileSync(tmuxLog, "utf8");
    assert.match(tmuxCalls2, /kill-window -t =oats-test-fake:=dev-zomb2/, "window killed despite temp-cleanup failure");
    const events2 = readFileSync(hookLog, "utf8").trim().split("\n");
    assert.ok(events2.includes("retire:dev-zomb2"), "hooks compensated despite temp-cleanup failure");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-zomb2")), false, "scaffold removed despite temp-cleanup failure");

    // Home-removal failure must be REPORTED as incomplete with the failed
    // path — never claimed as cleaned up. The retire hook (which compensation
    // runs BEFORE home removal) plants a read-only subdir inside the home so
    // rmSync(home) fails: the zombie home remains and the message says so.
    const tmpDir3 = `${anchorMetaPath}.tmp-dev-zomb3`;
    mkdirSync(tmpDir3); write(join(tmpDir3, "blocker"), "x"); // anchor write fails again
    fx.commit({ "capabilities/acme.comp/hook.mjs":
      `import {appendFileSync, mkdirSync, writeFileSync, chmodSync} from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(hookLog)}, process.env.OATS_EVENT + ':' + process.env.OATS_INSTANCE + '\\n');\n` +
      `if (process.env.OATS_EVENT === 'retire' && process.env.OATS_INSTANCE === 'dev-zomb3') {\n` +
      `  const d = process.env.OATS_HOME + '/locked'; mkdirSync(d); writeFileSync(d + '/pin', 'x'); chmodSync(d, 0o555);\n` +
      `}\n` });
    const zombHome = join(root, "dev", "instances", "dev-zomb3");
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb3", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake" }),
        rollbackError(/failed to re-point anchor.*rollback INCOMPLETE.*instance home/s, true),
        "unremovable home reported as incomplete with the failed path");
      assert.ok(existsSync(zombHome), "zombie home really remains (message told the truth)");
    } finally {
      rmSync(tmpDir3, { recursive: true, force: true });
      if (existsSync(join(zombHome, "locked"))) execFileSync("chmod", ["755", join(zombHome, "locked")]);
      rmSync(zombHome, { recursive: true, force: true });
    }

    // Stubborn window: kill-window "succeeds" (exit 0) but the window remains
    // — the effect check must report it (exit codes are not truth).
    const tmpDir4 = `${anchorMetaPath}.tmp-dev-zomb4`;
    mkdirSync(tmpDir4); write(join(tmpDir4, "blocker"), "x");
    process.env.TMUX_FAKE_STUBBORN = "dev-zomb4";
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb4", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake", launch: true }),
        rollbackError(/rollback INCOMPLETE.*tmux window oats-test-fake:dev-zomb4 still running/s, true),
        "unkillable window reported despite kill-window exiting 0");
    } finally {
      delete process.env.TMUX_FAKE_STUBBORN;
      rmSync(tmpDir4, { recursive: true, force: true });
    }

    // Probe failure is NOT confirmation: when list-windows itself fails, the
    // rollback must fail CLOSED and report could-not-verify, not success.
    const tmpDir4b = `${anchorMetaPath}.tmp-dev-zomb4b`;
    mkdirSync(tmpDir4b); write(join(tmpDir4b, "blocker"), "x");
    process.env.TMUX_FAKE_LIST_FAIL = "1";
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb4b", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake", launch: true }),
        rollbackError(/rollback INCOMPLETE.*tmux window oats-test-fake:dev-zomb4b: could not verify removal/s, true),
        "failed verification probe reported as could-not-verify, never as success");
    } finally {
      delete process.env.TMUX_FAKE_LIST_FAIL;
      rmSync(tmpDir4b, { recursive: true, force: true });
    }

    // Failing retire hook: runLifecycleHooks catches hook errors internally,
    // so the rollback must read the structured failures field.
    const tmpDir5 = `${anchorMetaPath}.tmp-dev-zomb5`;
    mkdirSync(tmpDir5); write(join(tmpDir5, "blocker"), "x");
    fx.commit({ "capabilities/acme.comp/hook.mjs":
      `import {appendFileSync} from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(hookLog)}, process.env.OATS_EVENT + ':' + process.env.OATS_INSTANCE + '\\n');\n` +
      `if (process.env.OATS_EVENT === 'retire' && process.env.OATS_INSTANCE === 'dev-zomb5') process.exit(3);\n` });
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb5", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake" }),
        rollbackError(/rollback INCOMPLETE.*retire hook acme\.comp/s, true),
        "nonzero retire hook reported via structured failures");
    } finally { rmSync(tmpDir5, { recursive: true, force: true }); }

    // Failed worktree removal: a foreign file inside the worktree with
    // worktree remove blocked — verify via `git worktree list` effect check.
    const tmpDir6 = `${anchorMetaPath}.tmp-dev-zomb6`;
    mkdirSync(tmpDir6); write(join(tmpDir6, "blocker"), "x");
    fx.commit({ "capabilities/acme.comp/hook.mjs":
      `import {appendFileSync, mkdirSync as mk, writeFileSync as wf, chmodSync} from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(hookLog)}, process.env.OATS_EVENT + ':' + process.env.OATS_INSTANCE + '\\n');\n` +
      `if (process.env.OATS_EVENT === 'retire' && process.env.OATS_INSTANCE === 'dev-zomb6') {\n` +
      `  const d = process.env.OATS_HOME + '/work/pin'; mk(d); wf(d + '/x', 'x'); chmodSync(d, 0o555); chmodSync(process.env.OATS_HOME + '/work', 0o555);\n` +
      `}\n` });
    const zomb6Home = join(root, "dev", "instances", "dev-zomb6");
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb6", work: "worktree", relation: "parent", relativeTo: anchor.instance, tmuxSession: "oats-test-fake" }),
        rollbackError(/rollback INCOMPLETE.*(git worktree .* still registered|instance home)/s, true),
        "failed worktree cleanup reported");
    } finally {
      rmSync(tmpDir6, { recursive: true, force: true });
      if (existsSync(join(zomb6Home, "work"))) {
        execFileSync("chmod", ["-R", "755", join(zomb6Home, "work")]);
        try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(zomb6Home, "work")], { stdio: "ignore" }); } catch { /* cleanup best-effort */ }
      }
      rmSync(zomb6Home, { recursive: true, force: true });
      try { execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch { /* cleanup best-effort */ }
    }

    // SECURITY regression: branch names may contain valid-but-hostile shell
    // metacharacters ($(…) passes check-ref-format). The rollback's branch
    // verification must never interpolate them into a shell.
    const marker = join(base, "pwn-marker");
    const evilBranch = `agents/pwn$(touch\${IFS}${marker})`;
    execFileSync("git", ["check-ref-format", `refs/heads/${evilBranch}`]); // fixture sanity: valid ref
    const tmpDir7 = `${anchorMetaPath}.tmp-dev-zomb7`;
    mkdirSync(tmpDir7); write(join(tmpDir7, "blocker"), "x");
    const zomb7Home = join(root, "dev", "instances", "dev-zomb7");
    try {
      await assert.rejects(fx.spawn("dev", { instance: "dev-zomb7", work: "worktree", relation: "parent", relativeTo: anchor.instance, branch: evilBranch, tmuxSession: "oats-test-fake" }),
        /failed to re-point anchor/s,
        "rollback runs with the hostile branch name");
      assert.equal(existsSync(marker), false, "no command injection: metacharacter branch never executed");
    } finally {
      rmSync(tmpDir7, { recursive: true, force: true });
      if (existsSync(join(zomb7Home, "work"))) {
        try { execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(zomb7Home, "work")], { stdio: "ignore" }); } catch { /* best-effort */ }
      }
      rmSync(zomb7Home, { recursive: true, force: true });
      try { execFileSync("git", ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch { /* best-effort */ }
      try { execFileSync("git", ["-C", repo, "branch", "-D", evilBranch], { stdio: "ignore" }); } catch { /* best-effort */ }
    }
  } finally { process.env.PATH = oldPath; }
});

test("rollback detects a still-registered canonical worktree through a symlinked agents root", async (t) => {
  // Compensation hook can remove one target's worktree directory BEFORE Git
  // verification, reproducing the canonical-path-loss race from review.
  const vanishHook = `import {rmSync} from 'node:fs'; if (process.env.OATS_EVENT === 'retire' && process.env.OATS_INSTANCE === 'dev-sym-missing') rmSync(process.env.OATS_HOME + '/work', {recursive:true, force:true});`;
  const fx = v2Dev(t, { "acme.vanish": cap({ hooks: { retire: "hook.mjs" } }, { "hook.mjs": vanishHook }) }, { soul: { work: "checkout" } });
  const { base } = fx; const repo = fx.member; const realRoot = fx.root;
  const linkedRoot = join(base, "agents-link"); symlinkSync(realRoot, linkedRoot);

  // Git wrapper delegates normally, but can force selected cleanup/probe operations to fail.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  // The command's words are read after any leading `-c name=value` pairs: c3, c4 and c5 are the third,
  // fourth and fifth words of `git -C <repo> <command> <verb> <path>`.
  write(join(bin, "git"), `#!/bin/sh\ni=0; lead=1; skip=0; c3=; c4=; c5=\nfor a in "$@"; do\n  if [ $skip = 1 ]; then skip=0; continue; fi\n  if [ $lead = 1 ] && [ "$a" = "-c" ]; then skip=1; continue; fi\n  lead=0; i=$((i+1))\n  if [ $i = 3 ]; then c3=$a; fi; if [ $i = 4 ]; then c4=$a; fi; if [ $i = 5 ]; then c5=$a; fi\ndone\nif [ "$GIT_FAKE_VANISH_AFTER_ADD" = "1" ] && [ "$c3" = "worktree" ] && [ "$c4" = "add" ]; then ${realGit} "$@"; s=$?; if [ $s -eq 0 ]; then /bin/rm -rf "$c5"; fi; exit $s; fi\nif [ "$GIT_FAKE_FAIL_REMOVE" = "1" ] && [ "$c3" = "worktree" ] && [ "$c4" = "remove" ]; then echo forced-remove-failure >&2; exit 7; fi\nif [ "$GIT_FAKE_FAIL_PRUNE" = "1" ] && [ "$c3" = "worktree" ] && [ "$c4" = "prune" ]; then echo forced-prune-failure >&2; exit 6; fi\nif [ "$GIT_FAKE_FAIL_LIST" = "1" ] && [ "$c3" = "worktree" ] && [ "$c4" = "list" ]; then echo forced-list-failure >&2; exit 8; fi\nif [ "$GIT_FAKE_FAIL_REVP" = "1" ] && [ "$c3" = "rev-parse" ] && [ "$c4" = "--verify" ]; then echo forced-rev-parse-failure >&2; exit 9; fi\nexec ${realGit} "$@"\n`);
  for (const t of ["pi", "claude"]) write(join(bin, t), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let branch;
  try {
    // Post-add canonicalization failure: wrapper removes the just-added tree
    // before `realpathSync(wt)`, while remove+prune cleanup also fail. The
    // error must retain the original canonicalization failure AND report the
    // stranded Git state as rollback INCOMPLETE (never silently best-effort).
    const earlyBranch = "agents/dev-early-canon";
    process.env.GIT_FAKE_VANISH_AFTER_ADD = "1";
    process.env.GIT_FAKE_FAIL_REMOVE = "1";
    process.env.GIT_FAKE_FAIL_PRUNE = "1";
    try {
      await assert.rejects(
        spawnAt(fx, linkedRoot, "dev", { instance: "dev-early-canon", work: "worktree", branch: earlyBranch }),
        (err) => err.details?.unconfirmed === true && /git worktree add\/canonicalization failed/.test(err.message)
          && /rollback INCOMPLETE/.test(err.message)
          && /remove failed \(forced-remove-failure\)/.test(err.message)
          && /prune failed \(forced-prune-failure\)/.test(err.message)
          && /could not verify removal \(canonical path unavailable after add\)/.test(err.message),
        "post-add canonicalization failure reports incomplete Git cleanup");
      assert.equal(existsSync(join(linkedRoot, "dev", "instances", "dev-early-canon")), false, "failed spawn home removed");
    } finally {
      delete process.env.GIT_FAKE_VANISH_AFTER_ADD;
      delete process.env.GIT_FAKE_FAIL_REMOVE;
      delete process.env.GIT_FAKE_FAIL_PRUNE;
      execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
      try { execFileSync(realGit, ["-C", repo, "branch", "-D", earlyBranch], { stdio: "ignore" }); } catch { /* cleanup */ }
    }

    const anchor = await spawnAt(fx, linkedRoot, "dev", { instance: "dev-sym-anchor" });
    const anchorMetaPath = join(anchor.home, "instance.json");
    const tmpBlock = `${anchorMetaPath}.tmp-dev-sym-child`;
    mkdirSync(tmpBlock); write(join(tmpBlock, "blocker"), "x");
    branch = "agents/dev-sym-child";
    process.env.GIT_FAKE_FAIL_REMOVE = "1";
    try {
      await assert.rejects(
        spawnAt(fx, linkedRoot, "dev", { instance: "dev-sym-child", relation: "parent", relativeTo: anchor.instance, work: "worktree", branch }),
        (err) => err.details?.unconfirmed === true && /rollback INCOMPLETE/.test(err.message)
          && /git worktree .*dev-sym-child\/work: still registered/.test(err.message)
          && !err.message.includes(linkedRoot + "/dev/instances/dev-sym-child/work"),
        "canonical registered path is detected and reported, not the lexical symlink path");
    } finally {
      delete process.env.GIT_FAKE_FAIL_REMOVE;
      rmSync(tmpBlock, { recursive: true, force: true });
    }
    // Rollback removed the files but the forced Git failure left registration;
    // prune after the path is gone clears metadata, then remove the branch.
    execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
    try { execFileSync(realGit, ["-C", repo, "branch", "-D", branch], { stdio: "ignore" }); } catch { /* cleanup */ }

    // Canonical path was captured immediately after add. The compensation hook
    // now REMOVES the directory before rollback; remove and prune are forced to
    // fail, while list succeeds and still returns Git's canonical registration.
    // Re-realpath-at-rollback would fail/fall back lexical and miss this record.
    const missingAnchor = await spawnAt(fx, linkedRoot, "dev", { instance: "dev-missing-anchor" });
    const tmpMissing = `${join(missingAnchor.home, "instance.json")}.tmp-dev-sym-missing`;
    mkdirSync(tmpMissing); write(join(tmpMissing, "blocker"), "x");
    const missingBranch = "agents/dev-sym-missing";
    process.env.GIT_FAKE_FAIL_REMOVE = "1";
    process.env.GIT_FAKE_FAIL_PRUNE = "1";
    try {
      await assert.rejects(
        spawnAt(fx, linkedRoot, "dev", { instance: "dev-sym-missing", relation: "parent", relativeTo: missingAnchor.instance, work: "worktree", branch: missingBranch }),
        (err) => err.details?.unconfirmed === true && /rollback INCOMPLETE/.test(err.message)
          && /git worktree .*dev-sym-missing\/work: still registered/.test(err.message)
          && !err.message.includes(linkedRoot + "/dev/instances/dev-sym-missing/work"),
        "captured canonical path detects stale registration after the directory vanished");
    } finally {
      delete process.env.GIT_FAKE_FAIL_REMOVE;
      delete process.env.GIT_FAKE_FAIL_PRUNE;
      rmSync(tmpMissing, { recursive: true, force: true });
      execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
      try { execFileSync(realGit, ["-C", repo, "branch", "-D", missingBranch], { stdio: "ignore" }); } catch { /* cleanup */ }
    }

    // Probe failure is distinct from confirmed absence: let removal/deletion
    // succeed, but force BOTH verification commands to fail. Rollback must
    // report could-not-verify for each instead of treating failed probes as
    // proof that worktree/ref are gone.
    const anchor2 = await spawnAt(fx, linkedRoot, "dev", { instance: "dev-probe-anchor" });
    const tmpBlock2 = `${join(anchor2.home, "instance.json")}.tmp-dev-sym-probe`;
    mkdirSync(tmpBlock2); write(join(tmpBlock2, "blocker"), "x");
    const probeBranch = "agents/dev-sym-probe";
    process.env.GIT_FAKE_FAIL_LIST = "1";
    process.env.GIT_FAKE_FAIL_REVP = "1";
    try {
      await assert.rejects(
        spawnAt(fx, linkedRoot, "dev", { instance: "dev-sym-probe", relation: "parent", relativeTo: anchor2.instance, work: "worktree", branch: probeBranch }),
        (err) => err.details?.unconfirmed === true && /rollback INCOMPLETE/.test(err.message)
          && /git worktree .*could not verify removal \(forced-list-failure\)/s.test(err.message)
          && /git branch agents\/dev-sym-probe: could not verify deletion \(forced-rev-parse-failure\)/s.test(err.message),
        "failed Git probes report could-not-verify, never confirmed absence");
    } finally {
      delete process.env.GIT_FAKE_FAIL_LIST;
      delete process.env.GIT_FAKE_FAIL_REVP;
      rmSync(tmpBlock2, { recursive: true, force: true });
      execFileSync(realGit, ["-C", repo, "worktree", "prune"]);
      try { execFileSync(realGit, ["-C", repo, "branch", "-D", probeBranch], { stdio: "ignore" }); } catch { /* cleanup */ }
    }
  } finally {
    delete process.env.GIT_FAKE_VANISH_AFTER_ADD;
    delete process.env.GIT_FAKE_FAIL_REMOVE;
    delete process.env.GIT_FAKE_FAIL_PRUNE;
    delete process.env.GIT_FAKE_FAIL_LIST;
    delete process.env.GIT_FAKE_FAIL_REVP;
    process.env.PATH = oldPath;
    try { execFileSync(realGit, ["-C", repo, "worktree", "prune"], { stdio: "ignore" }); } catch { /* cleanup */ }
    if (branch) try { execFileSync(realGit, ["-C", repo, "branch", "-D", branch], { stdio: "ignore" }); } catch { /* cleanup */ }
  }
});


test("lineage is deployment-local: --parent from an unrelated deployment is rejected", async (t) => {
  // Deployment A: the caller's instance lives here.
  const a = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  // Deployment B: a separate workspace and deployment (oats-support's --dir <deployment> case).
  const b = v2Deployment({ souls: { expert: { soul: { work: "checkout" } } } });
  t.after(() => b.cleanup());
  const env = { PATH: fakeHarnesses(a.base) };
  // A real instance in deployment A…
  let r = a.cli(["spawn", "dev", "--purpose", "caller", "--no-launch", "--json"], { env });
  assert.equal(r.status, 0, r.stderr);
  const caller = jsonResult(r);
  // …is NOT a valid parent when spawning into deployment B (its hierarchy
  // cannot resolve foreign instances — cross-deployment spawns are operator-origin).
  r = a.cli(["spawn", "expert", "--dir", b.dep, "--parent", caller.instance, "--purpose", "x", "--no-launch"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match any known instance/);
  // Without --parent the cross-deployment spawn lands top-level in B.
  r = a.cli(["spawn", "expert", "--dir", b.dep, "--task", "support question", "--purpose", "x", "--no-launch", "--json"], { env });
  assert.equal(r.status, 0, r.stderr);
  const expert = jsonResult(r);
  assert.equal(expert.spawnOrigin, "operator");
  assert.equal(expert.parent, null);
  assert.ok(expert.home.startsWith(join(b.root, "expert", "instances") + "/"), expert.home);
  assert.match(readFileSync(join(expert.home, "TASK.md"), "utf8"), /support question/);
});

test("traversal names are rejected: --parent and retire cannot reach outside instances/", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const env = { PATH: fakeHarnesses(base) };
  // A real instance to anchor the fixture (and prove normal lookups still work).
  process.env.PATH = fakeHarnesses(base);
  const real = await fx.spawn("dev", { instance: "dev-real" });
  const soul = join(root, "dev", "soul");
  const core = await import("@awebai/oats/core");
  // Kernel: traversal / separator / dotted names never resolve…
  for (const bad of ["../../dev/soul", "..", "dev/soul", "./dev-real", "dev-real/../../soul"]) {
    assert.equal(core.findInstanceHome(root, bad), undefined, `rejected: ${bad}`);
  }
  // …while the plain name still does, as an immediate child of instances/.
  assert.ok(core.findInstanceHome(root, "dev-real"));
  // CLI spawn --parent with a traversal name fails BEFORE scaffolding.
  const before = readdirSync(join(root, "dev", "instances"));
  let r = fx.cli(["spawn", "dev", "--parent", "../../dev/soul", "--purpose", "evil", "--no-launch"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match any known instance/);
  assert.deepEqual(readdirSync(join(root, "dev", "instances")), before, "no home scaffolded");
  // CLI retire with a traversal name fails BEFORE any delete — the soul copy survives.
  r = fx.cli(["retire", "../../dev/soul"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no instance named/);
  assert.ok(existsSync(join(soul, "soul.yaml")), "soul.yaml survives");
  assert.ok(existsSync(join(soul, "AGENTS.md")), "AGENTS.md survives");
  // Kernel retire with a traversal name also refuses.
  assert.throws(() => core.retireInstance(root, "../../dev/soul", { tmuxSession: "oats-test-nosuch" }), /no instance named/);
  assert.ok(existsSync(join(soul, "soul.yaml")));
  // A VALIDLY NAMED symlink inside instances/ that points OUTSIDE must also be
  // rejected — this exercises the realpath containment guard independently of
  // the charset regex (the target's basename intentionally matches the name).
  const outside = join(base, "outside", "dev-linked");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "precious.txt"), "keep me");
  symlinkSync(outside, join(root, "dev", "instances", "dev-linked"));
  assert.equal(core.findInstanceHome(root, "dev-linked"), undefined, "escaping symlink rejected by containment");
  assert.throws(() => core.retireInstance(root, "dev-linked", { tmuxSession: "oats-test-nosuch" }), /no instance named/);
  assert.ok(existsSync(join(outside, "precious.txt")), "symlink target untouched");
  // Real instance still retires normally.
  core.retireInstance(root, "dev-real", { tmuxSession: "oats-test-nosuch" });
  assert.ok(!existsSync(real.home));
});

test("OKF service agents stay memory-less: the harvester package soul composes its own capability only and is never a knowledge source", async t => {
  // 5.0 requires an actual recorded source proposal even though the harvester
  // itself is knowledge:none. Generic kernel relation choices do not alter composition.
  const f = okfFixture(t), proposal = f.proposal({ file: join(f.base, "proposal.md") });
  const sources = () => existsSync(join(f.base, "state", "sources"));
  assert.equal(sources(), false);
  const check = (worker, how) => {
    for (const p of ["STATE.md", "notes", ".okf-source.json"]) assert.equal(existsSync(join(worker.home, p)), false, `${how}: no ${p}`);
    assert.doesNotMatch(readFileSync(join(worker.home, "AGENTS.md"), "utf8"), /Knowledge: OKF|oats:capability:oats\.okf -->/, `${how}: no memory protocol`);
    const meta = instanceMeta(worker.home);
    assert.deepEqual(Object.keys(meta.modules), ["oats.okf-harvest"], `${how}: its own capability and nothing else`);
    assert.equal(meta.agent, "oats-okf--knowledge-harvester");
    assert.ok(existsSync(join(worker.home, ".oats", "modules", "oats.okf-harvest", "oats.json")), `${how}: the module is materialized`);
    assert.equal(existsSync(join(worker.home, ".aw")), false, `${how}: no messaging identity`);
    assert.equal(sources(), false, `${how}: never registered as a knowledge source`);
  };
  const withParent = f.cli(["spawn", "oats.okf/knowledge-harvester", "--task-file", proposal, "--name", "okf-harvester-anchored", "--parent", f.source.instance, "--harness", "pi", "--no-launch", "--json"]);
  check(withParent, "with a parent");
  f.retire(withParent.instance);
  const orphan = f.cli(["spawn", "oats.okf/knowledge-harvester", "--task-file", proposal, "--name", "okf-harvester-orphan", "--relation", "unrelated", "--harness", "pi", "--no-launch", "--json"]);
  check(orphan, "no parent");
  f.retire(orphan.instance); f.retire(f.source.instance);
  const gone = f.raw(["spawn", "oats.okf/knowledge-harvester", "--task-file", proposal, "--name", "okf-harvester-gone", "--relation", "unrelated", "--no-launch", "--json"]);
  assert.equal(gone.status, 1); assert.match(gone.stdout + gone.stderr, /E_SOURCE/);
  assert.equal(existsSync(join(f.context, "agents/oats-okf--knowledge-harvester/instances/okf-harvester-gone")), false, "a gone source cannot admit a new harvester");
});

// ---------- canonical deployment root (instance homes never in a linked worktree) ----------

/** A repo with a soul, plus a linked worktree of it. Mirrors the real shape:
 *  agents/ is committed, agents/<soul>/instances/ is gitignored, so a home
 *  created in the worktree is invisible AND dies with the tree. */
function repoWithWorktree(base) {
  const repo = join(base, "repo"); gitRepo(repo);
  write(join(repo, ".gitignore"), "agents/*/instances/\n");
  const root = join(repo, "agents");
  write(join(root, "dev", "soul", "soul.yaml"), `name: dev\nkind: persistent\nrepo: ${repo}\nwork: checkout\nharness: pi\n`);
  write(join(root, "dev", "soul", "AGENTS.md"), "# Canonical dev\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "soul"]);
  const wt = join(base, "wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "feature/x"]);
  return { repo, root, wt, wtRoot: join(wt, "agents") };
}

test("canonicalAgentsRoot maps a linked worktree's agents root onto the primary checkout", async () => {
  const core = await import("@awebai/oats/core");
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  // The bug this exists to prevent: discovery from the worktree yields the
  // worktree's own agents/ dir.
  assert.equal(core.findRoot(wt), wtRoot, "findRoot still follows the invocation directory");
  // Canonicalization redirects it to the primary checkout, by Git identity —
  // never by branch name.
  // Git reports canonical paths, so the redirect lands on the primary
  // checkout's REAL path (/private/var/... on macOS, not /var/...).
  const real = (p) => realpathSync(p);
  assert.equal(core.canonicalAgentsRoot(wtRoot), real(root));
  assert.equal(core.ensureRoot(wt), real(root), "ensureRoot resolves the canonical deployment root");
  assert.equal(core.ensureRoot(join(wt, "lib")), real(root), "…from any depth inside the worktree");
  // The primary checkout is left exactly as it is.
  assert.equal(core.canonicalAgentsRoot(root), root);
  assert.equal(core.ensureRoot(repo), root);
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});

test("canonicalAgentsRoot leaves non-git and out-of-tree roots untouched", async () => {
  const core = await import("@awebai/oats/core");
  const base = temp();
  // Not a Git work tree at all: nothing to canonicalize, behavior unchanged.
  const plain = join(base, "plain", "agents"); mkdirSync(plain, { recursive: true });
  assert.equal(core.canonicalAgentsRoot(plain), plain);
  // A scope whose agents/ does not exist yet still resolves.
  const bare = join(base, "bare"); mkdirSync(bare);
  assert.equal(core.canonicalAgentsRoot(join(bare, "agents")), join(bare, "agents"));
  rmSync(base, { recursive: true, force: true });
});

/** A v2 deployment whose directory is itself a Git checkout with a linked worktree
 *  that carries the same agents/<soul> layout (the silent-bug shape). */
async function v2WithWorktree(t) {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  await fx.prepare("dev");
  gitRepo(fx.dep);
  write(join(fx.dep, ".gitignore"), "agents/*/instances/\nws/\n");
  execFileSync("git", ["-C", fx.dep, "add", "-A"]);
  execFileSync("git", ["-C", fx.dep, "commit", "-qm", "deployment"]);
  const wt = join(fx.base, "wt");
  execFileSync("git", ["-C", fx.dep, "worktree", "add", "-q", wt, "-b", "feature/x"]);
  return { fx, root: fx.root, wt, wtRoot: join(wt, "agents") };
}

test("spawnInstance refuses to create an instance home inside a linked worktree", async (t) => {
  const { fx, root, wtRoot } = await v2WithWorktree(t);
  const agent = findAgent(wtRoot, "dev");
  assert.ok(agent, "the soul is present in the worktree too — which is what makes the bug silent");
  process.env.PATH = fakeHarnesses(fx.base);
  // The kernel is its own validation boundary: direct callers (desktop server,
  // adapters, tests) bypass the CLI's ensureRoot canonicalization.
  await assert.rejects(
    spawnAt(fx, wtRoot, "dev", { instance: "dev-wt" }),
    (e) => e.code === "E_NO_CANONICAL_ROOT" && /primary checkout/.test(e.message),
  );
  // Fail closed means fail clean: no home, not even a partial one.
  assert.equal(existsSync(join(wtRoot, "dev", "instances", "dev-wt")), false, "no scaffold left in the worktree");
  assert.equal(existsSync(join(root, "dev", "instances", "dev-wt")), false, "and none in the primary checkout");
  // Spawning against the canonical root is unaffected.
  const spawned = await fx.spawn("dev", { instance: "dev-ok" });
  assert.equal(spawned.home, join(root, "dev", "instances", "dev-ok"));
  retireInstance(root, "dev-ok", { tmuxSession: "oats-test-nosuch" });
});

test("spawnInstance validates the AGENT DIR, not just the root (reviewer-2366d09)", async (t) => {
  const { fx, root, wtRoot } = await v2WithWorktree(t);
  // The hole: canonicalize the root, but keep an agent resolved from the LINKED
  // root. A root-only guard passes and the home is still built under
  // `agent._dir/instances/…` — inside the worktree.
  const linkedAgent = findAgent(wtRoot, "dev");
  assert.equal(linkedAgent._dir, join(wtRoot, "dev"), "the agent carries the linked dir");
  process.env.PATH = fakeHarnesses(fx.base);
  const { prepared } = await fx.prepare("dev");
  await assert.rejects(
    spawnInstanceAsync(root, linkedAgent, { instance: "dev-mixed", launch: false, prepared, repo: fx.member }),
    (e) => e.code === "E_NO_CANONICAL_ROOT" && /agent directory for "dev"/.test(e.message),
    "canonical root + linked agent dir must still fail closed",
  );
  assert.equal(existsSync(join(wtRoot, "dev", "instances", "dev-mixed")), false, "no home in the worktree");
});

test("a failed Git probe fails closed instead of passing as a non-Git scope (reviewer-2366d09)", async () => {
  const core = await import("@awebai/oats/core");
  const base = temp();
  const { repo, root, wt, wtRoot } = repoWithWorktree(base);
  // git unavailable / dubious ownership / unreadable metadata: rev-parse fails
  // while the location is still plainly Git-owned. Treating that as "not a repo"
  // would let the linked worktree through — the fail-open this guards.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "git"), `#!/bin/sh\necho "fatal: detected dubious ownership" >&2\nexit 128\n`);
  execFileSync("chmod", ["+x", join(bin, "git")]);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    assert.throws(
      () => core.canonicalAgentsRoot(wtRoot),
      (e) => e.code === "E_NO_CANONICAL_ROOT" && /could not be read/.test(e.message),
      "a Git-owned location with an unreadable repository must not pass as non-Git",
    );
    // A genuinely non-Git scope (no .git marker anywhere above) still passes through.
    const plain = join(base, "plain", "agents"); mkdirSync(plain, { recursive: true });
    assert.equal(core.canonicalAgentsRoot(plain), plain);
  } finally { process.env.PATH = oldPath; }
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", wt]);
  rmSync(base, { recursive: true, force: true });
});

test("OATS_INSTANCE_HOME is exported to the harness and to lifecycle hooks; no PI_AGENT_* aliases", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  // A hook that records the env it was given.
  const probe = `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(out, "hook-env.json"))}, JSON.stringify({
  instanceHome: process.env.OATS_INSTANCE_HOME || null,
  legacyHome: process.env.OATS_HOME || null,
  storeDir: process.env.OATS_HOME_DIR || null,
}));
console.log('{}');`;
  const fx = v2Dev(t, { "acme.envprobe": cap({ hooks: { spawn: "hook.mjs" } }, { "hook.mjs": probe }) }, { soul: { work: "checkout" } });
  process.env.PATH = fakeHarnesses(fx.base);
  const r = await fx.spawn("dev", { instance: "dev-env", harness: "pi" });
  const seen = JSON.parse(readFileSync(join(out, "hook-env.json"), "utf8"));
  assert.equal(seen.instanceHome, r.home, "hooks receive the runtime-neutral name");
  assert.equal(seen.legacyHome, r.home, "OATS_HOME stays a compatibility alias for shipped capability hooks");
  // The package STORE root is a different concept and must never be conflated.
  assert.notEqual(seen.storeDir, r.home);
  // Every harness gets the neutral name only; the pi extension reads OATS_INSTANCE_HOME too.
  assert.match(r.command, new RegExp(`OATS_INSTANCE_HOME='${r.home}'`));
  assert.doesNotMatch(r.command, /PI_AGENT_/);
  retireInstance(fx.root, "dev-env", { tmuxSession: "oats-test-nosuch" });
});

test("symlinks on the path to the home cannot smuggle it into a linked worktree (reviewer-249aa7b)", async (t) => {
  const { fx, root, wtRoot } = await v2WithWorktree(t);
  process.env.PATH = fakeHarnesses(fx.base);
  const { prepared } = await fx.prepare("dev");
  const spawnWith = (r, agent, opts) => spawnInstanceAsync(r, agent, { launch: false, ...opts, prepared, repo: fx.member });
  // (1) An agent dir in the PRIMARY checkout that is a symlink to an agent in
  // the linked worktree. Every lexical check sees the primary checkout.
  symlinkSync(join(wtRoot, "dev"), join(root, "alias"));
  const aliased = findAgent(root, "alias");
  assert.equal(aliased._dir, join(root, "alias"), "lexically it is in the primary checkout");
  await assert.rejects(
    spawnWith(root, aliased, { instance: "alias-x" }),
    (e) => e.code === "E_NO_CANONICAL_ROOT" && /resolves to/.test(e.message),
  );
  assert.equal(existsSync(join(wtRoot, "dev", "instances", "alias-x")), false, "nothing created through the symlink");

  // (2) The agent dir is genuinely in the primary checkout, but its
  // instances/ dir is a symlink into the worktree.
  const smuggler = join(root, "dev2");
  mkdirSync(smuggler);
  symlinkSync(join(root, "dev", "soul"), join(smuggler, "soul"));
  mkdirSync(join(wtRoot, "dev", "instances"), { recursive: true });
  symlinkSync(join(wtRoot, "dev", "instances"), join(smuggler, "instances"));
  await assert.rejects(
    spawnWith(root, { ...findAgent(root, "dev"), _dir: smuggler }, { instance: "dev2-x" }),
    (e) => e.code === "E_NO_CANONICAL_ROOT" && /resolves to/.test(e.message),
  );
  assert.equal(existsSync(join(wtRoot, "dev", "instances", "dev2-x")), false, "nothing created through the instances symlink");

  // A plain symlinked agents root that stays within the primary checkout is
  // still perfectly fine — this guard is about the destination, not symlinks.
  const linkRoot = join(fx.base, "agents-link"); symlinkSync(root, linkRoot);
  const viaLink = await spawnAt(fx, linkRoot, "dev", { instance: "dev-via-link" });
  assert.equal(realpathSync(viaLink.home), join(realpathSync(root), "dev", "instances", "dev-via-link"));
  retireInstance(linkRoot, "dev-via-link", { tmuxSession: "oats-test-nosuch" });
});

// ---------- composition preflight: declared resources must exist ----------

test("a capability whose declared skill does not resolve fails the spawn closed, with no scaffold", async (t) => {
  // The reported shape: a manifest declaring skills under a dependency path that
  // only exists after an ad-hoc install. In a fresh checkout it resolves to
  // nothing, and the instance used to be born without them while the
  // capability's injection still told the agent to load them.
  const fx = v2Dev(t, { "acme.ghost": cap({ skills: ["node_modules/@vendor/pkg/skills/ghost-skill"] }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(
    fx.spawn("dev", { instance: "dev-ghost" }),
    (e) => e.code === "E_CAPABILITY_MISSING"
      && /acme\.ghost .*declares skills entry "node_modules\/@vendor\/pkg\/skills\/ghost-skill" but no SKILL\.md is there/.test(e.message),
  );
  // Preflight runs before the home exists, so there is nothing to roll back.
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-ghost")), false, "no instance home");
});

test("preflight distinguishes declared-and-missing from declared-nothing", async (t) => {
  // acme.quiet declares no skills and no injection at all — contributes nothing,
  // and that is not a missing resource; acme.loud declares an injection that DOES resolve.
  const fx = v2Dev(t, { "acme.quiet": cap({}), "acme.loud": cap({ inject: "injects/loud.md" }, { "injects/loud.md": "## Loud\n" }) });
  process.env.PATH = fakeHarnesses(fx.base);
  const r = await fx.spawn("dev", { instance: "dev-quiet" });
  const meta = instanceMeta(r.home);
  assert.ok(meta.composition, "instance.json records the composition");
  assert.ok(meta.composition.expected.some((e) => e.source === "acme.loud" && e.type === "injection"),
    "a resolved injection is recorded as expected with its provenance");
  assert.equal(meta.composition.expected.some((e) => e.source === "acme.quiet"), false,
    "a capability declaring nothing contributes nothing");
  assert.match(readFileSync(join(r.home, "AGENTS.md"), "utf8"), /## Loud/);
  retireInstance(fx.root, "dev-quiet", { tmuxSession: "oats-test-nosuch" });
});

test("instance.json records expected == materialized, and the .claude/skills alias is verified", async (t) => {
  const fx = v2Dev(t, { "acme.withskill": cap({ skills: ["skills/cap-skill"] }, { "skills/cap-skill/SKILL.md": "---\nname: cap-skill\ndescription: A capability skill.\n---\nbody\n" }) },
    { soul: { work: "checkout" }, souls: {} });
  fx.commit({ "souls/dev/skills/soul-skill/SKILL.md": "---\nname: soul-skill\ndescription: A soul-private skill.\n---\nbody\n" });
  process.env.PATH = fakeHarnesses(fx.base);
  const r = await fx.spawn("dev", { instance: "dev-mat" });
  const meta = instanceMeta(r.home);
  // The soul's own skills are recorded by name; a module skill is recorded with its
  // `module:<cap>` source. Both live flat at .agents/skills/<skill>/.
  const names = meta.composition.materialized.skills.map((s) => s.name);
  assert.ok(names.includes("soul-skill"), `soul skills materialized: ${names}`);
  assert.deepEqual(meta.composition.materialized.skills.map((s) => [s.name, s.source]), [["soul-skill", "soul"], ["cap-skill", "module:acme.withskill"]]);
  for (const s of meta.composition.materialized.skills) {
    const at = join(r.home, ".agents", "skills", s.name);
    assert.ok(lstatSync(join(at, "SKILL.md")).isFile(), `${s.name} is a real copy`);
  }
  const tree = meta.composition.expected.find((e) => e.type === "skill-tree" && e.source === "acme.withskill");
  assert.equal(tree?.resolved, join(r.home, ".agents", "skills"));
  assert.equal(lstatSync(join(tree.resolved, "cap-skill", "SKILL.md")).isFile(), true, "the module skill is a real copy");
  // .agents/skills is canonical; .claude/skills aliases it and must resolve
  // exactly onto it — the founder's canonical layout.
  assert.equal(lstatSync(join(r.home, ".claude", "skills")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(r.home, ".claude", "skills")), realpathSync(join(r.home, ".agents", "skills")));
  assert.equal(readlinkSync(join(r.home, "CLAUDE.md")), "AGENTS.md");
  // Every expected resource carries provenance for audit.
  for (const e of meta.composition.expected) assert.ok(e.type && e.source && e.declared, `provenance on ${JSON.stringify(e)}`);
  retireInstance(fx.root, "dev-mat", { tmuxSession: "oats-test-nosuch" });
});

test("a declared skill tree that exists but yields no skills fails closed (reviewer-400c1e6)", async (t) => {
  // The tree RESOLVES — so a mere existence check passes — but contributes
  // nothing: no SKILL.md of its own, and no child directory with one. The
  // capability would spawn with zero of its promised skills.
  const fx = v2Dev(t, { "acme.hollow": cap({ skills: ["skills/not-a-skill"] }, { "skills/not-a-skill/README.md": "no SKILL.md here\n" }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(
    fx.spawn("dev", { instance: "dev-hollow" }),
    (e) => e.code === "E_CAPABILITY_MISSING" && /skills entry "skills\/not-a-skill" but no SKILL\.md is there/.test(e.message),
  );
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-hollow")), false);
});

test("a skill directory represented by a symlink is reported, never silently dropped", async (t) => {
  // A symlinked child skill dir — even one that stays INSIDE the capability — is
  // refused when the module tree is read, so the capability never starts with a
  // real sibling skill and without the aliased one.
  const aliased = {
    "real/aliased-skill/SKILL.md": "---\nname: aliased-skill\ndescription: Reached only through a symlink.\n---\nbody\n",
    "skills/aliased-skill": { symlink: join("..", "real", "aliased-skill") },
  };
  const fx = v2Dev(t, { "acme.linked": cap({ skills: ["skills"] }, { ...aliased, "skills/plain/SKILL.md": "---\nname: plain\ndescription: Plain.\n---\n" }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(
    fx.spawn("dev", { instance: "dev-linked" }),
    (e) => e.code === "E_REMOTE_TREE_UNSAFE" && /capabilities\/acme\.linked\/skills\/aliased-skill is a symlink/.test(e.message),
  );
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-linked")), false);
  // The symlink alone: the tree yields no skill and fails closed.
  fx.commit({ "capabilities/acme.linked/skills/plain": null });
  await assert.rejects(
    fx.spawn("dev", { instance: "dev-linked" }),
    (e) => e.code === "E_CAPABILITY_MISSING" && /skills entry "skills" but no SKILL\.md is there/.test(e.message),
  );
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-linked")), false);
});

test("an empty soul skills/ dir is not a broken promise, unlike a declared capability tree", async (t) => {
  // Git tracks no empty directory: the soul's skills/ holds only a placeholder
  // file — it exists and declares nothing.
  const fx = v2(t, { files: { "souls/dev/skills/.gitkeep": "" } });
  process.env.PATH = fakeHarnesses(fx.base);
  const r = await fx.spawn("dev", { instance: "dev-emptysoul" });
  assert.ok(existsSync(join(r.home, "instance.json")), "spawn succeeds");
  retireInstance(fx.root, "dev-emptysoul", { tmuxSession: "oats-test-nosuch" });
});

test("a SKILL.md that is not a regular file does not count as a skill (reviewer-d70bc8b)", async (t) => {
  // existsSync() is true for a DIRECTORY named SKILL.md, which would let the
  // tree pass preflight, be copied, pass the post-check, and launch an instance
  // with no readable skill document.
  const fx = v2Dev(t, { "acme.fakedoc": cap({ skills: ["skills/fake"] }, { "skills/fake/SKILL.md/placeholder": "x\n" }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(
    fx.spawn("dev", { instance: "dev-fakedoc" }),
    (e) => e.code === "E_CAPABILITY_MISSING" && /skills entry "skills\/fake" but no SKILL\.md is there/.test(e.message),
  );
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-fakedoc")), false);
});

// ---------- harness extensions: strict launch resolves them, or refuses ----------

test("harness requirements may be conditional on capability settings (when) and carry a version floor (minVersion)", async (t) => {
  const chan = (floor = {}) => ({
    settings: { delivery: { default: "channel", values: ["channel", "session"], description: "x" } },
    requires: [
      { harness: "pi", package: "npm:@awebai/pi", why: "native channel", when: { delivery: "channel" } },
      { harness: "pi", package: "npm:@awebai/pi", minVersion: "0.3.10", ...floor, why: "must honour the opt-out", when: { delivery: "session" } },
    ],
  });
  const fx = v2Dev(t, { "acme.chan": cap(chan()) });
  const { base, root } = fx;
  const pkgDir = (version) => { const d = join(base, `pi-pkg-${version}`); write(join(d, "package.json"), JSON.stringify({ name: "@awebai/pi", version })); return d; };
  // The capability's settings reach the spawn as its provider payload.
  const spawn = (instance, delivery) => fx.spawn("dev", { instance, harness: "pi", providers: delivery === undefined ? {} : { "acme.chan": { delivery } } });
  process.env.HOME = join(base, "nohome");
  // session + old extension: the floor refuses, naming both versions and the remedy
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:@awebai/pi", dir: pkgDir("0.3.9") }]);
  await assert.rejects(
    spawn("dev-old", "session"),
    (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /at 0\.3\.10 or later; 0\.3\.9 is installed/.test(e.message) && /'pi' 'install' 'npm:@awebai\/pi'/.test(e.message) && !/oats install|--accept-requirement/.test(e.message),
  );
  // session + current extension: passes
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:@awebai/pi", dir: pkgDir("0.3.10") }]);
  const ok = await spawn("dev-new", "session");
  assert.equal(ok.instance, "dev-new");
  retireInstance(root, "dev-new", { tmuxSession: "oats-test-nosuch" });
  // channel: the floor row does not apply; the plain row does and is satisfied by any install
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:@awebai/pi", dir: pkgDir("0.3.9") }]);
  const ch = await spawn("dev-ch", "channel");
  assert.equal(ch.instance, "dev-ch");
  retireInstance(root, "dev-ch", { tmuxSession: "oats-test-nosuch" });
  // UNSET: the manifest default (channel) applies, so the plain channel row is a requirement and a missing package refuses (the default path keeps its requirements)
  process.env.PATH = fakeHarnesses(base);
  await assert.rejects(spawn("dev-unset"), (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /requires the pi package npm:@awebai\/pi, which is not installed/.test(e.message));
  // session with NO pi extension at all: the floor row is ifInstalled, absence is fine
  recap(fx, { capability: "acme.chan", ...chan({ ifInstalled: true }) });
  const none = await spawn("dev-none", "session");
  assert.equal(none.instance, "dev-none");
  retireInstance(root, "dev-none", { tmuxSession: "oats-test-nosuch" });
  // a malformed when is a problem, not an unconditional row
  recap(fx, { capability: "acme.chan", requires: [{ harness: "pi", package: "npm:@awebai/pi", why: "x", when: "channel" }] });
  await assert.rejects(spawn("dev-bad"), /`when` must be an object/);
  // session + a version the harness cannot report: fails closed
  recap(fx, { capability: "acme.chan", ...chan() });
  mkdirSync(join(base, "pi-pkg-noversion"), { recursive: true });
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:@awebai/pi", dir: join(base, "pi-pkg-noversion") }]);
  await assert.rejects(spawn("dev-unk", "session"), /installed version cannot be established/);
});

test("a misspelled conditional setting is refused outright, never a silent skip of every row", async (t) => {
  const manifest = cap({
    settings: { delivery: { default: "channel", values: ["channel", "session"], description: "x" } },
    requires: [{ harness: "pi", package: "npm:@awebai/pi", why: "native channel", when: { delivery: "channel" } }],
  });
  const fx = v2Dev(t, { "acme.chan": manifest });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(fx.spawn("dev", { instance: "dev-typo", harness: "pi", providers: { "acme.chan": { delivery: "sesion" } } }),
    (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details?.reason === "setting-value" && e.details.at === "--provider acme.chan"
      && /acme\.chan: setting "delivery" is "sesion", not one of "channel", "session" \(set at --provider acme\.chan\)/.test(e.message));
  assert.equal(existsSync(join(fx.root, "dev", "instances", "dev-typo")), false, "refused before a home exists");
  // The host layer is checked the same way, and names where it was set.
  const host = v2Dev(t, { "acme.chan": manifest }, { local: { settings: { "acme.chan": { delivery: "sesion" } } } });
  await assert.rejects(host.spawn("dev", { instance: "dev-typo" }),
    (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details?.at === "oats-local.yaml#/settings/acme.chan");
});

test("the manifest contract is checked where a workspace reads the manifest: discovery lists a broken one as a problem, never a module", async (t) => {
  const broken = {
    "acme.req": { manifest: { hooks: { retire: { command: "bin/h.mjs retire", required: true } } }, why: /hook "retire" cannot be required/, pointer: "/hooks/retire/required" },
    "acme.esc": { manifest: { hooks: { spawn: "../outside.mjs spawn" } }, why: /hook "spawn" script "\.\.\/outside\.mjs" escapes the capability directory/, pointer: "/hooks/spawn" },
    "acme.env": { manifest: { environment: ["PATH_EXTRA", "ACME_OK"] }, why: /environment name PATH_EXTRA is outside its ACME_ namespace/, pointer: "/environment/0" },
    "acme.ns": { manifest: { environment: ["OATS_X"], environmentNamespaces: ["OATS_"] }, why: /environmentNamespaces entry OATS_ is a reserved namespace/, pointer: "/environmentNamespaces/0" },
    undotted: { manifest: { hooks: { launch: "bin/h.mjs launch" } }, why: /declares hooks but its id has no dotted lowercase vendor component/, pointer: "/hooks" },
  };
  const fx = v2(t, { souls: { dev: {} }, capabilities: Object.fromEntries(Object.entries(broken).map(([id, b]) => [id, cap(b.manifest, { "bin/h.mjs": "" })])) });
  const status = fx.cli(["workspace", "status", "--json"]).json();
  for (const [id, b] of Object.entries(broken)) {
    const problem = JSON.stringify(status).includes(`capabilities/${id}/oats.json#${b.pointer}`);
    assert.ok(problem, `${id}: workspace status names capabilities/${id}/oats.json#${b.pointer}\n${JSON.stringify(status).slice(0, 2000)}`);
  }
  const { loadLocal } = await import("../lib/workspace.mjs");
  const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
  const discovery = await fx.inEnv(() => discoverOrStandalone(loadLocal(fx.dep).local, { remoteOptions: fx.remoteOptions }));
  for (const [id, b] of Object.entries(broken)) {
    const mine = discovery.problems.filter((p) => p.path.startsWith(`capabilities/${id}/`));
    assert.ok(mine.length && mine.every((p) => p.code === "E_WORKSPACE_SCHEMA"), id);
    assert.match(mine.map((p) => p.message).join("\n"), b.why, id);
  }
  assert.deepEqual(discovery.members[0].capabilities, [], "no broken manifest is listed as a capability");
  // A soul that declares one is refused with the manifest problem, not "missing".
  fx.commit(soulFiles("dev", { soul: { capabilities: { "acme.req": { from: "here" } } } }));
  await assert.rejects(fx.spawn("dev"), (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details?.reason === "manifest-contract" && /capabilities\/acme\.req\/oats\.json#\/hooks\/retire\/required: .*cannot be required/.test(e.message));
});

test("discovery refuses a retirement.disposable.home entry at the entry's own pointer, and lists only the manifest whose entries are sound", async (t) => {
  // One member capability per refused entry (acme.h01 …), the entry second after a sound one.
  const refused = Object.fromEntries(DISPOSABLE_HOME_REFUSED.map(([value, why], i) => [`acme.h${String(i + 1).padStart(2, "0")}`, { value, why }]));
  const fx = v2(t, { souls: { dev: {} }, capabilities: {
    ...Object.fromEntries(Object.entries(refused).map(([id, { value }]) => [id, cap({ retirement: { disposable: { home: [".ok", value] } } })])),
    "acme.ok": cap({ retirement: { disposable: { home: DISPOSABLE_HOME_ACCEPTED } } }),
  } });
  const status = JSON.stringify(fx.cli(["workspace", "status", "--json"]).json());
  for (const [id, { value }] of Object.entries(refused)) {
    const at = `capabilities/${id}/oats.json#/retirement/disposable/home/1`;
    assert.ok(status.includes(at), `${id} (${JSON.stringify(value)}): workspace status names ${at}\n${status.slice(0, 2000)}`);
  }
  const { loadLocal } = await import("../lib/workspace.mjs");
  const { discoverOrStandalone } = await import("../lib/instance-resolution.mjs");
  const discovery = await fx.inEnv(() => discoverOrStandalone(loadLocal(fx.dep).local, { remoteOptions: fx.remoteOptions }));
  for (const [id, { value, why }] of Object.entries(refused)) {
    const mine = discovery.problems.filter((p) => p.path.startsWith(`capabilities/${id}/`));
    assert.deepEqual(mine.map((p) => ({ code: p.code, path: p.path, message: p.message })),
      [{ code: "E_WORKSPACE_SCHEMA", path: `capabilities/${id}/oats.json#/retirement/disposable/home/1`, message: disposableHomeRefusal(id, value, why) }],
      `${id}: ${JSON.stringify(value)} is one problem, at its own index`);
  }
  assert.deepEqual(discovery.problems.filter((p) => p.path.startsWith("capabilities/acme.ok/")), [], "sound entries are no problem");
  assert.deepEqual(discovery.members[0].capabilities.map((c) => c.name), ["acme.ok"], "only the manifest with sound entries is listed as a capability");
  assert.deepEqual(discovery.members[0].capabilities[0].manifest.retirement.disposable.home, DISPOSABLE_HOME_ACCEPTED);
});

test("spawn fails closed when a capability's harness package is missing, even after a Claude-only reconciliation", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:@awebai/pi", why: "channel extension for pi sessions" }],
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const oldHome = process.env.HOME; process.env.HOME = join(base, "nohome"); // no pi packages
  try {
    // Claude is unaffected: it never needed the pi package.
    const claude = await fx.spawn("dev", { instance: "dev-claude", harness: "claude" });
    retireInstance(root, "dev-claude", { tmuxSession: "oats-test-nosuch" });
    assert.doesNotMatch(claude.command, /-e /);

    // --harness pi is a per-spawn choice, made long after install-time
    // reconciliation decided this host was Claude-only. Spawn is the
    // authoritative check, and it must refuse rather than launch a pi instance
    // whose channel silently vanished under --no-extensions.
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-pi", harness: "pi" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING"
        && /acme\.chan requires the pi package npm:@awebai\/pi/.test(e.message)
        && /'pi' 'install' 'npm:@awebai\/pi'/.test(e.message) && !/oats install|--accept-requirement/.test(e.message),
      "spawn names the direct operator-run remedy",
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-pi")), false, "no scaffold left behind");
  } finally { process.env.PATH = oldPath; process.env.HOME = oldHome; }
});


test("a required harness package is verified and recorded, and pi loads it through its own discovery", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  // A relocated pi config dir (PI_CODING_AGENT_DIR) holding the package entry.
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel@1.2.3"] }));
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel@1.2.3", dir: pkgDir }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    const r = await fx.spawn("dev", { instance: "dev-ext", harness: "pi" });
    // We do NOT name extensions on the command line: pi resolves them itself
    // (its manifest supports globs and conventional directories), and passing
    // them too would load the same extension twice.
    assert.doesNotMatch(r.command, / -e /);
    assert.doesNotMatch(r.command, /--no-extensions/);
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const pkgs = meta.composition.materialized.harnessPackages;
    assert.equal(pkgs.length, 1);
    assert.equal(pkgs[0].capability, "acme.chan");
    assert.equal(pkgs[0].package, "npm:fake-channel");
    assert.equal(pkgs[0].loadedBy, "harness-discovery", "provenance says how it reaches the session");
    retireInstance(root, "dev-ext", { tmuxSession: "oats-test-nosuch" });
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("PI_PACKAGE_DIR pointing elsewhere does not break detection (reviewer-ad1b9f0)", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: pkgDir }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  const oldPkg = process.env.PI_PACKAGE_DIR; process.env.PI_PACKAGE_DIR = join(base, "nix-store-elsewhere");
  try {
    // PI_PACKAGE_DIR is pi's own asset dir, not `pi install` output. Detection
    // must key off the agent dir alone, or a Nix/Guix-style host fails every spawn.
    const r = await fx.spawn("dev", { instance: "dev-nix", harness: "pi" });
    assert.ok(existsSync(join(r.home, "instance.json")));
    retireInstance(root, "dev-nix", { tmuxSession: "oats-test-nosuch" });
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
    if (oldPkg === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = oldPkg;
  }
});

test('a settings entry with "extensions": [] fails the spawn — it loads none of them (reviewer-8518c49)', async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  const piDir = join(base, "pi-agent");
  // Installed and listed, but the operator disabled every extension from it.
  // A settings row is not proof the capability's extension will load.
  write(join(piDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:fake-channel", extensions: [] }] }));
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: pkgDir, filtered: true }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-off", harness: "pi" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /"extensions": \[\], which loads none of them/.test(e.message),
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-off")), false);
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("a stale settings row whose files were never installed fails the spawn (reviewer-8518c49)", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  // Configured but never installed: pi prints the source line and NO path line,
  // exactly as its list command does when installedPath is unset. Presence in
  // settings — or a parser that shrugs at the missing line — would pass this.
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel" }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-ghost", harness: "pi" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /reports no installed location, so it was never installed/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("a non-empty extensions filter fails as unverifiable; a skills-only filter still passes", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  const piDir = join(base, "pi-agent");
  const pkgDir = join(piDir, "npm", "node_modules", "fake-channel");
  write(join(pkgDir, "package.json"), JSON.stringify({ name: "fake-channel" }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: pkgDir, filtered: true }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    // A non-empty extensions filter may name a wrong or nonexistent path, or
    // simply omit the capability's extension. Proving otherwise means
    // implementing pi's matcher, so this is unverifiable — not merely auditable.
    write(join(piDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:fake-channel", extensions: ["./dist/*.js"] }] }));
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-filt", harness: "pi" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /filters its extensions/.test(e.message) && /skills-only filter is fine/.test(e.message),
    );

    // A filter on OTHER resource kinds is unrelated and must keep working —
    // the real oats-aweb entry filters skills only, and pi still marks the row
    // "(filtered)", so the two must not be conflated.
    write(join(piDir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:fake-channel", skills: ["skills/one"] }] }));
    const r = await fx.spawn("dev", { instance: "dev-skillfilt", harness: "pi" });
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const pkg = meta.composition.materialized.harnessPackages[0];
    assert.equal(pkg.filtered, true, "pi's own (filtered) marker is recorded…");
    assert.equal(pkg.dir, pkgDir, "…along with where the harness says it lives");
    retireInstance(root, "dev-skillfilt", { tmuxSession: "oats-test-nosuch" });
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("a directory pi names but that does not exist also fails the spawn", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  const oldPath = process.env.PATH;
  process.env.PATH = fakePiWithPackages(base, [{ source: "npm:fake-channel", dir: join(piDir, "npm", "node_modules", "gone") }]);
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-gonedir", harness: "pi" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /but nothing is installed there/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("when pi cannot be run, a config entry is not accepted as an installation", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "pi", package: "npm:fake-channel", why: "channel extension" }],
  }) });
  const { base, root } = fx;
  const piDir = join(base, "pi-agent");
  write(join(piDir, "settings.json"), JSON.stringify({ packages: ["npm:fake-channel"] }));
  // `pi list` fails, so only settings are readable — which record intent, never
  // installation. Fail closed rather than trust a config file.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "pi"), "#!/bin/sh\nexit 3\n");
  write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${process.env.PATH}`;
  const oldPi = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-noverify", harness: "pi" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /could not verify it is installed/.test(e.message),
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldPi;
  }
});

test("instance.json records the harness posture — what is composed, curtailed, and ambient", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  process.env.PATH = fakeHarnesses(fx.base);
  for (const harness of ["pi", "claude"]) {
    const r = await fx.spawn("dev", { instance: `dev-${harness}`, harness });
    const posture = instanceMeta(r.home).composition.materialized.harnessPosture;
    assert.ok(posture.oatsComposed, `${harness} records the composed surface`);
    assert.ok(posture.ambient?.length, `${harness} states what remains ambient`);
    assert.ok(posture.why, `${harness} records why`);
    if (harness === "pi") assert.ok(posture.curtailed?.includes("user skills"), "pi curtails ambient skills");
    // Claude keeps its own global and per-repo configuration by founder ruling.
    else assert.ok(posture.ambient.some((a) => /plugins/.test(a)), "claude keeps user/project plugins");
    retireInstance(fx.root, `dev-${harness}`, { tmuxSession: "oats-test-nosuch" });
  }
});

test("a failing REQUIRED spawn hook fails the spawn and rolls it back", async (t) => {
  // A capability that cannot configure itself. Left best-effort, the instance
  // would start believing this capability works.
  const fx = v2Dev(t, { "acme.chan": cap({ hooks: { spawn: { command: "hook.mjs spawn", required: true } } }, { "hook.mjs": "process.stderr.write('identity minting failed\\n'); process.exit(1);" }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-reqhook", harness: "pi" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED"
        && /acme\.chan spawn hook \(declared required\)/.test(e.message)
        && /spawn rolled back/.test(e.message),
    );
    assert.equal(existsSync(join(root, "dev", "instances", "dev-reqhook")), false, "no half-configured instance left behind");
  } finally { process.env.PATH = oldPath; }
});

test("a failing hook that is NOT required still only warns", async (t) => {
  // Advisory work — memory scaffolding and the like — must not become a spawn
  // blocker just because required hooks now exist.
  const fx = v2Dev(t, { "acme.soft": cap({ hooks: { spawn: "hook.mjs spawn" } }, { "hook.mjs": "process.stderr.write('scaffolding failed\\n'); process.exit(1);" }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    const r = await fx.spawn("dev", { instance: "dev-soft", harness: "pi" });
    assert.ok(r.warnings?.some((w) => /acme\.soft spawn hook failed/.test(w)), `failure is surfaced: ${JSON.stringify(r.warnings)}`);
    retireInstance(root, "dev-soft", { tmuxSession: "oats-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
});

test("a required worktree spawn rolls back the worktree and branch too", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({ hooks: { spawn: { command: "hook.mjs spawn", required: true } } }, { "hook.mjs": "process.exit(1);" }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-wtreq", harness: "pi", work: "worktree" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && /spawn rolled back/.test(e.message),
    );
    const wts = execFileSync("git", ["-C", fx.member, "worktree", "list"], { encoding: "utf8" });
    assert.doesNotMatch(wts, /dev-wtreq/, "worktree deregistered");
    const branches = execFileSync("git", ["-C", fx.member, "branch", "--list"], { encoding: "utf8" });
    assert.doesNotMatch(branches, /dev-wtreq/, "branch deleted");
  } finally { process.env.PATH = oldPath; }
});

test("a clean rollback reports no verification problems (probe stderr regression)", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({ hooks: { spawn: { command: "hook.mjs spawn", required: true } } }, { "hook.mjs": "process.exit(1);" }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    // execFileSync with encoding:"utf8" gives stderr === "" for a silent
    // command, so `stderr || message` fell through to "Command failed: …" and
    // an absent ref — the SUCCESS signal of `rev-parse --verify --quiet` —
    // looked like an unverifiable probe. Every clean rollback then reported
    // INCOMPLETE, training readers to ignore the one message that matters.
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-cleanrb", harness: "pi", work: "worktree" }),
      (e) => e.details?.unconfirmed === undefined && /spawn rolled back/.test(e.message) && !/rollback INCOMPLETE/.test(e.message),
      "a rollback that fully succeeded must say so",
    );
    const cli = fx.cli(["spawn", "dev", "--name", "dev-cleanrb-cli", "--harness", "pi", "--work", "worktree", "--no-launch", "--json"], { env: { PATH: process.env.PATH } });
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    const failure = cli.json();
    assert.equal(failure.ok, false);
    // A required spawn hook's failure keeps its typed code (0.49.0; E_SPAWN_FAILED before), with the
    // hooks' receipt; a clean rollback carries no `unconfirmed` and never `home`.
    assert.equal(failure.error.code, "E_REQUIRED_HOOK_FAILED");
    assert.deepEqual(failure.error.details, { hooks: [{ capability: "acme.chan", ok: false, required: true, log: null }] });
    assert.match(failure.error.message, /spawn rolled back/);
    assert.equal(existsSync(join(root, "dev", "instances", "dev-cleanrb-cli")), false);
  } finally { process.env.PATH = oldPath; }
});

test("a failed required hook hands back its metadata so compensation can undo external state", async (t) => {
  // The hook creates external state, reports it, then fails. Its stdout is the
  // ONLY channel for that state; discarding it strands whatever it created.
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  const marker = join(out, "external-identity");
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, rmSync, existsSync} from 'node:fs';
const marker = ${JSON.stringify(marker)};
if (process.env.OATS_EVENT === 'spawn') {
  writeFileSync(marker, 'joined');                       // external state exists now
  console.log(JSON.stringify({ meta: { alias: 'probe-alias' } }));
  process.exit(1);                                        // …and then we fail
}
const meta = JSON.parse(process.env.OATS_META || '{}');
if (meta.alias === 'probe-alias' && existsSync(marker)) rmSync(marker);   // compensate
console.log('{}');`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-comp", harness: "pi" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && e.details?.unconfirmed === undefined,
    );
    assert.equal(existsSync(marker), false, "the retire hook received the failed hook's metadata and undid its external state");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-comp")), false);
  } finally { process.env.PATH = oldPath; }
});

// The workspace facts the kernel's teamEnv exports to every hook since 0.26 (OATS_TEAM_SCOPE alone is
// the classic environment, which oats.aweb 1.14 refuses up front — a kernel no longer produces it), in
// the 0.30 team model v2 shape oats.aweb 1.17 reads: the default team (OATS_DEFAULT_TEAM*) and the mapped
// rows { label, team, default, from } (OATS_TEAMS). The primary identity's team is OATS_DEFAULT_TEAM_ID only.
const AWEB_V2_ENV = { OATS_WORKSPACE_KEY: "example.invalid/acme/workspace", OATS_WORKSPACE_NAME: "acme", OATS_DEFAULT_TEAM: "default", OATS_DEFAULT_TEAM_ID: "default:acme.aweb.ai", OATS_DEFAULT_TEAM_FROM: "deployment", OATS_TEAMS: JSON.stringify([{ label: "default", team: "default:acme.aweb.ai", default: true, from: "local" }]), OATS_SETTINGS: "{}" };
/** The same environment with no team configured (what 1.16 resolved from the root's active team). */
const AWEB_NO_TEAM_ENV = { OATS_DEFAULT_TEAM: "", OATS_DEFAULT_TEAM_ID: "", OATS_DEFAULT_TEAM_FROM: "", OATS_TEAMS: "[]" };

test("the SHIPPED aweb spawn hook exits nonzero when it cannot mint an identity", () => {
  // The required-hook contract is worthless if the capability that declares it
  // swallows its own failures. This executes the real hook, not a fixture.
  const base = temp();
  const hook = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
  // A floor-satisfying `aw` that answers only `version`, so the hook deterministically reaches the root
  // check whatever aw the host has (1.16's no-root and no-aw refusals shared one phrase; 1.17's differ).
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  fakeAw(bin, `#!/bin/sh\nif [ "$1" = "version" ]; then ${AW_VERSION_SHELL}; exit 0; fi\necho "unexpected aw $*" 1>&2; exit 2\n`);
  const r = spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "spawn", OATS_INSTANCE: "probe", OATS_HOME: join(base, "no-such-home"), OATS_WORKSPACE: base, OATS_CONTEXT: base, OATS_TEAM_SCOPE: base, ...AWEB_V2_ENV },
  });
  assert.notEqual(r.status, 0, `no aweb root must be fatal, got exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout, /no messaging root at .*could not mint this instance/);
  const manifest = JSON.parse(readFileSync(resolve(new URL("../mirrors/oats-aweb/oats.json", import.meta.url).pathname), "utf8"));
  assert.equal(manifest.hooks.spawn.required, true, "and the manifest declares it required, so the kernel acts on that exit code");
  rmSync(base, { recursive: true, force: true });
});

test("the manifest schema rejects `required` on non-spawn hooks, matching harness validation", async () => {
  // A schema more permissive than the harness lets authoring approve a manifest
  // OATS then refuses to load.
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");   // the schema declares draft 2020-12, as validate-project.mjs does
  const schema = JSON.parse(readFileSync(resolve(new URL("../docs/capability-manifest.schema.json", import.meta.url).pathname), "utf8"));
  const validate = new Ajv2020({ strict: false, allowUnionTypes: true }).compile(schema);
  const manifest = (hooks) => ({ capability: "acme.x", version: "1.0.0", compatibility: { oats: ">=0.6.2" }, description: "x", hooks });
  assert.equal(validate(manifest({ spawn: { command: "h.mjs spawn", required: true } })), true, "spawn may be required");
  assert.equal(validate(manifest({ retire: { command: "h.mjs retire", required: true } })), false, "retire may not");
  assert.equal(validate(manifest({ "soul-scaffold": { command: "h.mjs s", required: true } })), false, "soul-scaffold may not");
  assert.equal(validate(manifest({ retire: "h.mjs retire" })), true, "the plain string form still validates");
});

test("the SHIPPED aweb hook is fatal on every terminal pre-mint path (reviewer-5b78764)", () => {
  const base = temp();
  const hook = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
  // A stub `aw` that reports an initialized root but NO team, so the hook gets
  // past the root check and reaches team resolution — the paths that used to
  // warn-and-exit-0 while minting nothing.
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // CURRENT aw shape: memberships, not teams. Using the stale key here is what
  // let a real field drift pass review (reviewer-602627c).
  fakeAw(bin, `#!/bin/sh\nif [ "$1" = "version" ]; then ${AW_VERSION_SHELL}; exit 0; fi\nif [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"memberships":[],"active_team":null}'; exit 0; fi\nexit 0\n`);
  const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
  const run = (env) => spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "spawn", OATS_INSTANCE: "probe", OATS_HOME: root, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_TEAM_SCOPE: root, ...AWEB_V2_ENV, ...env },
  });

  // Root present, no team resolvable at all.
  const noTeam = run(AWEB_NO_TEAM_ENV);
  assert.notEqual(noTeam.status, 0, `no active team must be fatal, got ${noTeam.status}: ${noTeam.stdout}`);
  assert.match(noTeam.stdout, /no teams configured: run `oats aweb setup`/);

  // RETIRED (oats.aweb 1.17): "a bare team name with no matching membership" (settings.oats.aweb.team resolved
  // against the root's memberships). 1.17 has no team setting and no name-only resolution: see the floor
  // "a name-only default team id is refused …" below.
  rmSync(base, { recursive: true, force: true });
});

test("a compensation hook that reports incomplete cleanup is not announced as a clean rollback", async (t) => {
  // Retire exits 0 but says it could not undo its external state — the shape of
  // aweb's self-delete failure. Announcing "spawn rolled back" would be a lie,
  // AND the home holds the only credential that can retry the cleanup.
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OATS_EVENT === 'spawn') {
  console.log(JSON.stringify({ meta: { alias: 'probe' }, warning: 'oats-chan: minting failed — run: chan setup' }));
  process.exit(1);
}
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-badcomp", harness: "pi" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED"
        && e.details?.unconfirmed === true
        && /rollback INCOMPLETE/.test(e.message)
        && /external state may remain/.test(e.message)
        && /instance home is RETAINED/.test(e.message)
        // …and the hook's OWN diagnosis reaches the operator, not just "Command failed: node …".
        && /run: chan setup/.test(e.message),
      "the failure must name the cause, admit the incomplete cleanup, and say the home is kept",
    );
    // The home SURVIVES: deleting it would destroy the credentials a retry needs,
    // turning a transient cleanup failure into permanent external residue.
    const kept = join(root, "dev", "instances", "dev-badcomp");
    assert.equal(existsSync(kept), true, "the home is quarantined, not destroyed");
    const marker = JSON.parse(readFileSync(join(kept, ".oats-rollback-incomplete.json"), "utf8"));
    assert.equal(marker.instance, "dev-badcomp");
    assert.ok(marker.incomplete.length, "the marker records what is outstanding");
    assert.equal(JSON.stringify(marker).includes("chan setup"), false, "and carries no hook output");
    // status must read it as retained state, never as a live instance.
    const listed = listInstances(root, "oats-test-nosuch").flatMap((a) => a.instances || []).find((i) => i.instance === "dev-badcomp");
    assert.ok(listed?.rollbackIncomplete, "status identifies the quarantine");
    assert.equal(listed.running, false);
    rmSync(kept, { recursive: true, force: true });
    const cli = fx.cli(["spawn", "dev", "--name", "dev-badcomp-cli", "--harness", "pi", "--no-launch", "--json"], { env: { PATH: process.env.PATH } });
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    const failure = cli.json();
    assert.equal(failure.ok, false);
    // The typed code keeps `unconfirmed` beside the hooks' receipt (0.49.0; E_SPAWN_FAILED before).
    assert.equal(failure.error.code, "E_REQUIRED_HOOK_FAILED");
    assert.deepEqual(failure.error.details, { hooks: [{ capability: "acme.chan", ok: false, required: true, log: null }], unconfirmed: true });
    assert.equal(existsSync(join(root, "dev", "instances", "dev-badcomp-cli", ".oats-rollback-incomplete.json")), true);
  } finally { process.env.PATH = oldPath; }
});

test("a compensation hook with nothing to undo still counts as a clean rollback", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OATS_EVENT === 'spawn') { console.log(JSON.stringify({ warning: 'nope' })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'nothing-to-delete' } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-nooop", harness: "pi" }),
      (e) => e.details?.unconfirmed === undefined && /spawn rolled back/.test(e.message) && !/rollback INCOMPLETE/.test(e.message),
      "nothing to undo is completion, not failure",
    );
  } finally { process.env.PATH = oldPath; }
});

// RETIRED (oats.aweb 1.17): "a name-only team config resolves against the CURRENT aw memberships shape
// (reviewer-602627c)". 1.17 takes the primary team only from OATS_DEFAULT_TEAM_ID and no longer resolves a bare
// name against `aw team list` memberships; a name-only id is refused up front. Floor:
test("a name-only default team id is refused with the provider's id-shape message before any aw call", () => {
  const base = temp();
  const hook = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const log = join(base, "aw.log");
  write(join(bin, "aw"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nif [ "$1" = "version" ]; then ${AW_VERSION_SHELL}; exit 0; fi\nif [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"active_team":null,"memberships":[{"team_id":"default:acme.aweb.ai","alias":"x"}]}'; exit 0; fi\nexit 0\n`);
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
  const r = spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "spawn", OATS_INSTANCE: "probe", OATS_HOME: root, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_TEAM_SCOPE: root, ...AWEB_V2_ENV, OATS_DEFAULT_TEAM_ID: "default", OATS_TEAMS: JSON.stringify([{ label: "default", team: "default", default: true, from: "local" }]) },
  });
  assert.notEqual(r.status, 0, `a name-only team id must be refused, got ${r.status}: ${r.stdout} ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).warning, "oats-aweb: aweb team ids must have shape <name>:<namespace> (name matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$; namespace is a hostname)");
  assert.equal(existsSync(log), false, "refused before any aw call: nothing resolved against memberships, nothing minted");
  rmSync(base, { recursive: true, force: true });
});

test("no failure path discloses the invite token (reviewer-aggregate2, reviewer-1a6e82e)", () => {
  const hook = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
  const TOKEN = "inv_SUPERSECRET_TOKEN_9f3a";
  // execFileSync puts the whole argv in its error message, JSON.parse quotes the
  // malformed input in its SyntaxError, and a command that MINTS a credential can
  // print it while failing — at which point there is nothing for the caller to
  // scrub, because the token is exactly what it never received. This hook's
  // failures are surfaced by the kernel into CLI/Desktop logs, so every one of
  // those paths is a disclosure.
  const cases = {
    "the join fails, echoing the token": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo "join rejected for token ${TOKEN}" 1>&2; exit 3; fi`,
    "the INVITE fails after printing the token it minted": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo "minted ${TOKEN} then failed" 1>&2; exit 3; fi`,
    "the invite returns malformed JSON containing the token": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"'; exit 0; fi`,
    "the join returns malformed JSON containing the token": `if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo '{"alias":"probe" ${TOKEN}'; exit 0; fi`,
    // oats.aweb 1.17.4 mints with ONE \`aw init --join-from\`: the token is created and spent inside aw,
    // which can still print it while failing. The same disclosure paths, on the command the hook now runs.
    "the --join-from mint fails, echoing the token": `if [ "$1" = "init" ]; then case "$*" in *--join-from=*) echo "accept rejected for token ${TOKEN}" 1>&2; exit 3;; esac; fi`,
    "the --join-from mint prints the token on stdout, then fails": `if [ "$1" = "init" ]; then case "$*" in *--join-from=*) echo "minted ${TOKEN}"; echo "then failed" 1>&2; exit 3;; esac; fi`,
    "the --join-from mint returns malformed JSON containing the token": `if [ "$1" = "init" ]; then case "$*" in *--join-from=*) echo '{"alias":"probe" ${TOKEN}'; exit 0;; esac; fi`,
  };
  for (const [label, script] of Object.entries(cases)) {
    const base = temp();
    const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
    fakeAw(bin, `#!/bin/sh
if [ "$1" = "version" ]; then ${AW_VERSION_SHELL}; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"active_team":"default:acme.aweb.ai","memberships":[{"team_id":"default:acme.aweb.ai","alias":"x"}]}'; exit 0; fi
${script}
exit 0
`);
    const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
    const r = spawnSync(process.execPath, [hook, "spawn"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "spawn", OATS_INSTANCE: "probe", OATS_HOME: root, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_TEAM_SCOPE: root, ...AWEB_V2_ENV },
    });
    assert.notEqual(r.status, 0, `${label}: the spawn still fails`);
    assert.doesNotMatch(r.stdout, new RegExp(TOKEN), `${label}: the token must not reach stdout`);
    assert.doesNotMatch(r.stderr, new RegExp(TOKEN), `${label}: nor stderr`);
    assert.match(r.stderr + r.stdout, /identity minting failed|no usable/, `${label}: while the failure is still reported`);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a WELL-FORMED mint response cannot reflect a token-shaped value into the alias or team, and the hook holds no token (reviewer-a6aa1c5)", () => {
  const base = temp();
  const hook = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  // Suppressing the FAILURE paths achieves nothing if a successful reply is
  // copied into meta and the briefing verbatim. Before oats.aweb 1.17.4 the hook
  // held the invite token and rejected any reply field carrying it. From 1.17.4
  // the token is created and spent inside one \`aw init --join-from\` and never
  // reaches the hook or any argv, so the hook has nothing to compare against.
  // A team id that is not <name>:<domain> (a token has no colon) falls back to
  // the requested team. A token-shaped ALIAS would pass the alias rule, so from
  // oats.aweb 1.17.5 the requested alias always stands in, and a different
  // reported alias is named by a warning that quotes nothing from the reply.
  const TOKEN = "inv_SUPERSECRET_TOKEN_9f3a";
  const log = join(base, "aw.log");
  fakeAw(bin, `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = "version" ]; then ${AW_VERSION_SHELL}; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "list" ]; then echo '{"active_team":"default:acme.aweb.ai","memberships":[{"team_id":"default:acme.aweb.ai","alias":"x"}]}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "invite" ]; then echo '{"token":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "team" ] && [ "$2" = "join" ]; then echo '{"team_id":"${TOKEN}","alias":"${TOKEN}"}'; exit 0; fi
if [ "$1" = "init" ]; then case "$*" in *--join-from=*) echo '{"team_id":"${TOKEN}","alias":"${TOKEN}","status":"connected"}'; exit 0;; esac; fi
exit 0
`);
  const root = join(base, "awroot"); mkdirSync(join(root, ".aw"), { recursive: true });
  const r = spawnSync(process.execPath, [hook, "spawn"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "spawn", OATS_INSTANCE: "probe", OATS_HOME: root, OATS_WORKSPACE: root, OATS_CONTEXT: root, OATS_TEAM_SCOPE: root, ...AWEB_V2_ENV },
  });
  assert.doesNotMatch(r.stdout, new RegExp(TOKEN), "no emitted field may carry the token");
  assert.doesNotMatch(r.stderr, new RegExp(TOKEN));
  // The spawn still succeeds, using what WE asked for: the requested alias and
  // team are always known, so a rejected field has an honest fallback.
  assert.equal(r.status, 0, `a successful mint stays successful: ${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.meta.alias, "probe", "the requested alias stands in");
  assert.match(doc.brief, /alias "probe"/);
  assert.equal(doc.warning, 'oats-aweb: aw reported a different alias than requested; using the requested alias "probe"');
  assert.match(r.stdout, /default:acme\.aweb\.ai/, "the requested team stands in");
  // And the token never passed through the hook: no invite, no join, no argv carrying it.
  const calls = readFileSync(log, "utf8");
  assert.doesNotMatch(calls, /^team (invite|join)/m, "one mint; no separate invite or join");
  assert.match(calls, /^init --join-from=/m);
  assert.doesNotMatch(calls, new RegExp(TOKEN), "no aw argv carries the token");
  rmSync(base, { recursive: true, force: true });
});

test("an alias minted with no local key is incomplete cleanup, not 'nothing to delete'", () => {
  const base = temp();
  const hook = resolve(new URL("../mirrors/oats-aweb/bin/oats-aweb.mjs", import.meta.url).pathname);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  write(join(bin, "aw"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["+x", join(bin, "aw")]);
  const homeDir = join(base, "home"); mkdirSync(homeDir, { recursive: true });   // no .aw
  const r = spawnSync(process.execPath, [hook, "retire"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "retire", OATS_INSTANCE: "probe", OATS_HOME: homeDir, OATS_META: JSON.stringify({ alias: "probe", team: "default:acme.aweb.ai" }) },
  });
  // The remote record exists and its key is gone: the self-delete cannot be
  // authenticated, so this must NOT read as a vacuous no-op.
  assert.notEqual(r.status, 0, `missing key must be incomplete, got ${r.status}: ${r.stdout}`);
  assert.match(r.stdout, /no-local-identity-key/);
  assert.doesNotMatch(r.stdout, /nothing-to-delete/);

  // …while a retire with no alias at all genuinely has nothing to undo.
  const noAlias = spawnSync(process.execPath, [hook, "retire"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OATS_EVENT: "retire", OATS_INSTANCE: "probe", OATS_HOME: homeDir, OATS_META: "{}" },
  });
  assert.equal(noAlias.status, 0);
  assert.match(noAlias.stdout, /nothing-to-delete/);
  rmSync(base, { recursive: true, force: true });
});

// ---------- Claude harness packages (consented, never installed at spawn) ----------

/** A `claude` stub answering `plugin list --json` in Claude's real shape, and
 * REFUSING every other `plugin` subcommand so an imperative install during spawn
 * fails loudly instead of passing silently. `name` lets a test install two
 * differently-named wrappers (e.g. `claude` and `claude-personal`) reporting
 * DIFFERENT plugin states. */
function fakeClaudeWithPlugins(base, rows, { name = "claude", keepPath = false } = {}) {
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const json = JSON.stringify(rows.map((r) => ({
    id: r.name, version: "1.0.0", scope: r.scope || "user", enabled: r.disabled !== true,
    ...(r.projectPath ? { projectPath: r.projectPath } : {}),
    installPath: join(base, "plugins", r.name),
  })));
  // Claude advertises an installPath, so the fixture must MAKE it: a stub that
  // names a directory it never creates would prove the preflight passes on a
  // registration whose install is gone — the very thing it must reject.
  // `missing: true` keeps the row without the directory, for that case.
  for (const r of rows) {
    const dir = join(base, "plugins", r.name);
    if (r.missing) rmSync(dir, { recursive: true, force: true });   // an earlier fixture in the same test may have made it
    else mkdirSync(dir, { recursive: true });
  }
  write(join(bin, name), `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then cat <<'EOF'
${json}
EOF
exit 0; fi
if [ "$1" = "plugin" ]; then echo "REFUSED: spawn must not install plugins" >&2; exit 9; fi
exit 0
`);
  if (!existsSync(join(bin, "pi"))) write(join(bin, "pi"), "#!/bin/sh\nexit 0\n");
  if (!existsSync(join(bin, "claude"))) write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  return keepPath ? `${bin}:${process.env.PATH}` : `${bin}:${process.env.PATH}`;
}

test("a Claude capability plugin is verified at spawn, never installed there", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  // The stub REFUSES any `claude plugin` subcommand other than list, so an
  // imperative install during spawn would fail loudly rather than pass silently.
  process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace" }]);
  try {
    const r = await fx.spawn("dev", { instance: "dev-cc", harness: "claude" });
    const meta = JSON.parse(readFileSync(join(r.home, "instance.json"), "utf8"));
    const pkg = meta.composition.materialized.harnessPackages[0];
    assert.equal(pkg.harness, "claude");
    assert.equal(pkg.package, "chan@acme-marketplace");
    retireInstance(root, "dev-cc", { tmuxSession: "oats-test-nosuch" });
  } finally { process.env.PATH = oldPath; }
});

test("a missing or DISABLED Claude plugin fails the spawn with the operator remedy", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  try {
    // Absent entirely: the remedy names both direct install steps, in order.
    process.env.PATH = fakeClaudeWithPlugins(base, []);
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-miss", harness: "claude" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING"
        && !/oats install|--accept-requirement/.test(e.message)
        && /'claude' 'plugin' 'marketplace' 'add' 'acme\/claude-plugins' && 'claude' 'plugin' 'install' 'chan@acme-marketplace'/.test(e.message),
    );
    // Installed but switched off will not load, so it does not satisfy the requirement.
    process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace", disabled: true }]);
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-off", harness: "claude" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /installed but DISABLED/.test(e.message),
    );
    // REGISTERED but gone: Claude still lists the plugin and names an installPath
    // that no longer exists (a cleared cache, a pruned directory). The row is not
    // the install — a registration OATS accepts on the strength of the row alone
    // starts an instance whose required channel is simply absent
    // (reviewer-aggregate2).
    process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace", missing: true }]);
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-gone", harness: "claude" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING",
      "a plugin whose advertised install directory is gone does not satisfy the requirement",
    );
  } finally { process.env.PATH = oldPath; }
});

test("the shipped aweb capability declares the Claude channel instead of installing it", () => {
  const dir = resolve(new URL("../mirrors/oats-aweb", import.meta.url).pathname);
  const manifest = JSON.parse(readFileSync(join(dir, "oats.json"), "utf8"));
  const req = (manifest.requires || []).find((r) => r.runtime === "claude"); // the released manifest names it `runtime` (read as `harness`)
  assert.ok(req, "the Claude channel plugin is a declared requirement");
  assert.equal(req.package, "aweb-channel@awebai-marketplace");
  assert.equal(req.marketplace, "awebai/claude-plugins");
  // …and the hook no longer mutates the operator's Claude installation at spawn.
  const hook = readFileSync(join(dir, "bin", "oats-aweb.mjs"), "utf8");
  assert.doesNotMatch(hook, /claude plugin marketplace add/, "no imperative marketplace registration");
  assert.doesNotMatch(hook, /claude plugin install/, "no imperative plugin install");
});

test("the aweb hook runs argv only, and detects `aw` without a shell builtin", () => {
  const dir = resolve(new URL("../mirrors/oats-aweb", import.meta.url).pathname);
  const hook = readFileSync(join(dir, "bin", "oats-aweb.mjs"), "utf8");
  // This is a REQUIRED spawn hook: it gates every spawn, and team ids, aliases,
  // instance names and invite tokens all flow through it. argv removes the
  // injection class rather than relying on one quoting helper staying correct.
  assert.doesNotMatch(hook, /execSync\(/, "no shell-string execution");
  assert.doesNotMatch(hook, /shq\s*\(/, "no shell quoting helper left to get wrong");
  // `command -v` is a SHELL BUILTIN — spawning it as a program depends on a
  // /usr/bin/command binary that many hosts do not ship, and its absence would
  // read as "aw is missing" on every one of them.
  assert.doesNotMatch(hook, /"command",\s*"-v"/, "PATH lookup is resolved in-process");
  assert.match(hook, /function onPath\(/);

  // Drive it with a PATH that has no `aw`: the diagnosis must name the CLI.
  const base = temp();
  const r = spawnSync(process.execPath, [join(dir, "bin", "oats-aweb.mjs"), "spawn"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", OATS_EVENT: "spawn", OATS_INSTANCE: "probe", OATS_HOME: join(base, "nope") },
  });
  assert.notEqual(r.status, 0, "a missing aw CLI is fatal for a required spawn hook");
  assert.match(r.stdout, /aw CLI not on PATH/);
  rmSync(base, { recursive: true, force: true });
});

test("the plugin probe uses the SELECTED claude executable (the host's claude default), not the literal one (reviewer-6f1bb9c)", async (t) => {
  // The claude default names a wrapper — a separate account with its own plugins.
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  }) }, { local: { "launch-configs": { personal: { harness: "claude", executable: "claude-personal", default: true } } } });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  try {
    // Default `claude` HAS the plugin; the selected `claude-personal` does NOT.
    // Probing the literal executable would pass preflight and launch an
    // instance claiming a channel the real harness lacks.
    fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace" }], { name: "claude" });
    process.env.PATH = fakeClaudeWithPlugins(base, [], { name: "claude-personal" });
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-wrap", harness: "claude" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING" && /chan@acme-marketplace/.test(e.message),
      "the wrapper's missing plugin must fail, despite `claude` having it",
    );
    // And the reverse: the wrapper has it, the default does not → spawn succeeds.
    const base2 = temp();
    fakeClaudeWithPlugins(base2, [], { name: "claude" });
    process.env.PATH = fakeClaudeWithPlugins(base2, [{ name: "chan@acme-marketplace" }], { name: "claude-personal" });
    const r = await fx.spawn("dev", { instance: "dev-wrap2", harness: "claude" });
    assert.match(r.command, /claude-personal/, "and the session launches with that same executable");
    retireInstance(root, "dev-wrap2", { tmuxSession: "oats-test-nosuch" });
    rmSync(base2, { recursive: true, force: true });
  } finally { process.env.PATH = oldPath; }
});

test("a plugin installed for an UNRELATED project does not satisfy the requirement", async (t) => {
  const fx = v2Dev(t, { "acme.chan": cap({
    requires: [{ harness: "claude", package: "chan@acme-marketplace", marketplace: "acme/claude-plugins", why: "push events" }],
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH;
  try {
    // Enabled and matching, but scoped to someone else's project. Human `plugin
    // list` output loses this distinction entirely.
    process.env.PATH = fakeClaudeWithPlugins(base, [
      { name: "chan@acme-marketplace", scope: "project", projectPath: join(base, "somebody-elses-repo") },
    ]);
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-otherproj", harness: "claude" }),
      (e) => e.code === "E_HARNESS_RESOURCE_MISSING",
      "a project-scoped install elsewhere must not count",
    );
    // A user-scope install does apply everywhere.
    process.env.PATH = fakeClaudeWithPlugins(base, [{ name: "chan@acme-marketplace", scope: "user" }]);
    const r = await fx.spawn("dev", { instance: "dev-userscope", harness: "claude" });
    retireInstance(root, "dev-userscope", { tmuxSession: "oats-test-nosuch" });
    assert.ok(r.home);
  } finally { process.env.PATH = oldPath; }
});

test("a quarantined home can be cleaned up on retry, and only then removed", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  // EXTERNAL state stands in for a remote identity. Cleanup must actually RUN on
  // retry and remove it — asserting only that the directory disappeared passes
  // even when every retire hook is skipped, which is exactly the bug this covers
  // (reviewer-453d793).
  const remote = join(out, "remote-identity");
  const allowCleanup = join(out, "cleanup-works");
  const credential = "identity.key";
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
const home = process.env.OATS_HOME;
const remote = ${JSON.stringify(remote)};
if (process.env.OATS_EVENT === 'spawn') {
  writeFileSync(remote, 'joined');
  writeFileSync(join(home, ${JSON.stringify(credential)}), 'key');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(1);
}
const meta = JSON.parse(process.env.OATS_META || '{}');
if (!meta.alias) { console.log(JSON.stringify({ meta: { retired: false, reason: 'nothing-to-delete' } })); process.exit(0); }
if (!existsSync(join(home, ${JSON.stringify(credential)}))) { console.log(JSON.stringify({ meta: { retired: false, reason: 'credential-gone' } })); process.exit(1); }
if (!existsSync(${JSON.stringify(allowCleanup)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(1); }
rmSync(remote);
console.log(JSON.stringify({ meta: { retired: true } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-retry");
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-retry", harness: "pi", work: "worktree" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && e.details?.unconfirmed === true && /RETAINED/.test(e.message),
    );
    assert.equal(existsSync(remote), true, "external state exists and cleanup has not succeeded");
    assert.equal(existsSync(join(home, credential)), true, "its credential is preserved");
    // The marker must carry what a retry NEEDS, not only what went wrong.
    const marker = JSON.parse(readFileSync(join(home, ".oats-rollback-incomplete.json"), "utf8"));
    assert.equal(marker.cleanup.repo, fx.member, "cleanup descriptor records the context");
    assert.equal(marker.cleanup.capabilityMeta["acme.chan"].alias, "probe", "and the failed hook's metadata");
    assert.ok(marker.cleanup.capabilityRuntime.some((c) => c.id === "acme.chan"), "and the capability harness");

    // Retry while the cause persists: cleanup runs, still fails, home SURVIVES.
    const first = retireInstance(root, "dev-retry", { tmuxSession: "oats-test-nosuch" });
    assert.ok(first.rollbackIncomplete, "an unsuccessful retry reports incomplete");
    assert.equal(first.removedDir, false, "and must not delete the credential it still needs");
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(remote), true, "external state is still there");

    // Operator fixes the cause; retry removes the EXTERNAL state, then the home.
    writeFileSync(allowCleanup, "ok");
    const second = retireInstance(root, "dev-retry", { tmuxSession: "oats-test-nosuch" });
    assert.equal(second.rollbackIncomplete, undefined, "cleanup completed");
    assert.equal(existsSync(remote), false, "the retire hook actually ran and removed the external state");
    assert.equal(existsSync(home), false, "and only then is the home removed");
  } finally { process.env.PATH = oldPath; }
});

test("a quarantine retry re-runs and VERIFIES the rollback-owned Git cleanup; the spawn's branch is left, and the debt clears once Git has deleted it (reviewer-d6e916d, #436)", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  const allow = join(out, "cleanup-works");
  // Retire fails until the operator fixes the cause, so the spawn genuinely
  // quarantines. Hooks then succeed on retry — which is the point: hook-only
  // verification would clear the home while Git residue survives.
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {existsSync} from 'node:fs';
if (process.env.OATS_EVENT === 'spawn') { console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
if (!existsSync(${JSON.stringify(allow)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: true } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-git");
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-git", harness: "pi", work: "worktree" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && e.details?.unconfirmed === true && /RETAINED/.test(e.message),
    );
    assert.equal(existsSync(home), true, "the spawn quarantined the home");

    // Git residue the initial rollback left behind: a rollback-owned branch that
    // still exists. Cleanup is NOT complete until it is gone, and no retire
    // deletes a branch (#436).
    execFileSync("git", ["-C", fx.member, "branch", "dev-git-leftover"]);
    const markerPath = join(home, ".oats-rollback-incomplete.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.cleanup.work = "worktree";
    marker.cleanup.branch = "dev-git-leftover";
    // A Git-ONLY quarantine: hooks finished, the branch did not go. It is the one
    // shape whose outstanding hook list is legitimately empty, and it must stay
    // retryable — the Git verification is its proof (reviewer-2baa631).
    marker.cleanup.outstanding = { hooks: [], git: ["branch"] };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    writeFileSync(allow, "ok");                 // hooks will now succeed
    const branches = () => execFileSync("git", ["-C", fx.member, "branch", "--list"], { encoding: "utf8" });
    // The branch stays, and the debt is said, never silent.
    const kept = retireInstance(root, "dev-git", { tmuxSession: "oats-test-nosuch" });
    assert.match(branches(), /dev-git-leftover/, "a retry does not delete the branch");
    assert.deepEqual(kept.rollbackIncomplete, [FAILED_SPAWN_BRANCH_LEFT]);
    assert.equal(kept.branchDeleted, false);
    assert.equal(existsSync(home), true, "the home stays while the debt does");
    // Asking for the deletion is refused before anything happens.
    assert.throws(() => retireInstance(root, "dev-git", { tmuxSession: "oats-test-nosuch", deleteBranch: true }),
      (e) => e.code === "E_BAD_ARGS" && e.message === RETIRE_DELETE_BRANCH_REFUSED);
    assert.match(branches(), /dev-git-leftover/);
    assert.equal(existsSync(home), true);
    // The operator deletes the branch with Git: the retry shows it gone, and cleanup then reports complete.
    execFileSync("git", ["-C", fx.member, "branch", "-D", "dev-git-leftover"]);
    const r = retireInstance(root, "dev-git", { tmuxSession: "oats-test-nosuch" });
    assert.equal(r.branchDeleted, false, "the retire deleted nothing");
    assert.equal(r.rollbackIncomplete, undefined, "and cleanup then reports complete");
    assert.equal(existsSync(home), false);
  } finally { process.env.PATH = oldPath; }
});

test("a home with no instance.json and no cleanup descriptor is not silently deleted", () => {
  const base = temp();
  const { root } = fixtureSoul(base, "pi");
  // Reachable for real: the spawn path tolerates a failed marker write, leaving
  // a retained home that identifies as nothing. Deleting it would destroy
  // whatever external state it still owns.
  const orphan = join(root, "dev", "instances", "dev-orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "identity.key"), "secret");
  assert.throws(
    () => retireInstance(root, "dev-orphan", { tmuxSession: "oats-test-nosuch" }),
    (e) => e.code === "E_UNIDENTIFIED_INSTANCE_HOME" && /no cleanup descriptor/.test(e.message),
  );
  assert.equal(existsSync(join(orphan, "identity.key")), true, "nothing was destroyed");
  // force is the deliberate manual-cleanup escape.
  retireInstance(root, "dev-orphan", { tmuxSession: "oats-test-nosuch", force: true });
  assert.equal(existsSync(orphan), false);
  rmSync(base, { recursive: true, force: true });
});

test("--force clears a home whose quarantine marker cannot drive a retry (reviewer-adff009, reviewer-45ff039r2, reviewer-0ad27d1, reviewer-dd03a98)", () => {
  const base = temp();
  const { root } = fixtureSoul(base, "pi");
  // The cleanup descriptor is a strict contract with exactly one producer (the
  // required-hook rollback), so each case below is that contract with ONE field
  // broken. A marker that cannot drive the retry identifies nothing: retire must
  // refuse by default, and --force — the documented escape — has to work.
  // Tolerating any of these produced a retry that resolved nothing, reported no
  // failures, and CLEARED the quarantine: the credential deleted while the
  // external state it was held for survived.
  //
  // The positive control is not here but in the real-spawn quarantine tests
  // above, which drive this same contract end to end.
  const valid = () => ({
    reason: "required spawn hook failed and compensation did not complete",
    failed: [{ capability: "acme.chan", event: "spawn" }],
    cleanup: {
      version: 1, repo: join(base, "repo"), work: "checkout", branch: "main",
      outstanding: { hooks: ["acme.chan"], git: [] },
      capabilityRuntime: [{ id: "acme.chan", hooks: { retire: "hook.mjs retire" } }],
      capabilityMeta: { "acme.chan": { alias: "probe" } },
    },
  });
  const broken = (fn) => { const m = valid(); fn(m); return JSON.stringify(m); };
  const unusable = {
    "truncated JSON": '{"cleanup": {"repo":',
    "no descriptor at all": '{"reason": "required spawn hook failed"}',
    "an array descriptor": '{"cleanup": []}',
    "an empty descriptor": '{"cleanup": {}}',
    // The contract version: a marker this kernel cannot interpret must not drive
    // a retry on a guess.
    "no contract version": broken((m) => { delete m.cleanup.version; }),
    "a future contract version": broken((m) => { m.cleanup.version = 2; }),
    // repo: retire resolves capabilities and reruns every hook from it.
    "no context repo": broken((m) => { delete m.cleanup.repo; }),
    "a blank context repo": broken((m) => { m.cleanup.repo = "   "; }),
    "a mistyped context repo": broken((m) => { m.cleanup.repo = 17; }),
    // work/branch: the rollback-owned Git steps. An unrecognised mode skips them
    // silently and calls the cleanup complete.
    "no work mode": broken((m) => { delete m.cleanup.work; }),
    "an unknown work mode": broken((m) => { m.cleanup.work = "wortree"; }),
    "a worktree with no branch": broken((m) => { m.cleanup.work = "worktree"; delete m.cleanup.branch; }),
    "a worktree with a mistyped branch": broken((m) => { m.cleanup.work = "worktree"; m.cleanup.branch = ["a"]; }),
    // capabilityRuntime IS the capability set handed to runLifecycleHooks.
    "no capability set": broken((m) => { delete m.cleanup.capabilityRuntime; }),
    "a mistyped capability set": broken((m) => { m.cleanup.capabilityRuntime = {}; }),
    "an empty capability set": broken((m) => { m.cleanup.capabilityRuntime = []; }),
    "capability entries that are not capabilities": broken((m) => { m.cleanup.capabilityRuntime = [{}]; }),
    "a null capability entry": broken((m) => { m.cleanup.capabilityRuntime = [null]; }),
    "an id-less capability entry": broken((m) => { m.cleanup.capabilityRuntime = [{ id: "  " }]; }),
    "a capability set missing the outstanding capability": broken((m) => { m.cleanup.capabilityRuntime = [{ id: "acme.other" }]; }),
    // outstanding.hooks is what the retry must PROVE it reran.
    "no outstanding record": broken((m) => { delete m.cleanup.outstanding; }),
    "a mistyped outstanding record": broken((m) => { m.cleanup.outstanding = ["acme.chan"]; }),
    "a mistyped outstanding hook list": broken((m) => { m.cleanup.outstanding = { hooks: "acme.chan" }; }),
    "a mistyped outstanding hook id": broken((m) => { m.cleanup.outstanding = { hooks: [{ id: "acme.chan" }], git: [] }; }),
    "a missing outstanding git list": broken((m) => { delete m.cleanup.outstanding.git; }),
    "a mistyped outstanding git list": broken((m) => { m.cleanup.outstanding.git = "branch"; }),
    "an unknown outstanding git item": broken((m) => { m.cleanup.outstanding.git = ["stash"]; }),
    // The rollback owns Git steps only for a worktree, so debt claimed anywhere
    // else describes a quarantine that could not have happened.
    "git debt in a non-worktree mode": broken((m) => { m.cleanup.outstanding.git = ["branch"]; }),
    // NOTHING outstanding is a proof obligation of zero: the retry runs, proves
    // nothing, and deletes the home and its credential. The ID-only capability
    // entry is the shape that makes it look plausible (reviewer-2baa631).
    "nothing outstanding at all": broken((m) => {
      m.cleanup.outstanding = { hooks: [], git: [] };
      m.cleanup.capabilityRuntime = [{ id: "acme.chan" }];
    }),
    "a mistyped capabilityMeta": broken((m) => { m.cleanup.capabilityMeta = []; }),
  };
  for (const [label, marker] of Object.entries(unusable)) {
    const home = join(root, "dev", "instances", "dev-broken");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "identity.key"), "secret");
    writeFileSync(join(home, ".oats-rollback-incomplete.json"), marker);
    assert.throws(
      () => retireInstance(root, "dev-broken", { tmuxSession: "oats-test-nosuch" }),
      (e) => e.code === "E_UNIDENTIFIED_INSTANCE_HOME",
      `${label}: an unusable marker is an unidentified home, not a retryable quarantine`,
    );
    assert.equal(existsSync(join(home, "identity.key")), true, `${label}: nothing was destroyed`);
    const r = retireInstance(root, "dev-broken", { tmuxSession: "oats-test-nosuch", force: true });
    assert.equal(r.rollbackIncomplete, undefined, `${label}: force does not report an incompletion it cannot retry`);
    assert.equal(r.removedDir, true, `${label}: removedDir`);
    assert.equal(existsSync(home), false, `${label}: the operator's escape hatch actually removes the home`);
  }
  rmSync(base, { recursive: true, force: true });
});

test("a retry that reruns NO outstanding hook fails closed, and --force is the way out (reviewer-dd03a98)", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  const remote = join(out, "remote-identity");
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync} from 'node:fs';
if (process.env.OATS_EVENT === 'spawn') { writeFileSync(${JSON.stringify(remote)}, 'joined'); console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(1);`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-nohook");
  try {
    await assert.rejects(fx.spawn("dev", { instance: "dev-nohook", harness: "pi" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED");
    const markerPath = join(home, ".oats-rollback-incomplete.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["acme.chan"], "the marker records WHICH hook still owes cleanup");

    // The descriptor stays structurally valid and still names the outstanding
    // capability — it simply carries no retire hook for it. Whether that comes
    // from a hand-edited marker or from config drift since the spawn, the retry
    // resolves nothing to run: zero hooks, zero failures. Reporting that as a
    // completed cleanup deletes the credential while the remote identity lives on.
    marker.cleanup.capabilityRuntime = [{ id: "acme.chan" }];
    writeFileSync(markerPath, JSON.stringify(marker, null, 2));

    const r = retireInstance(root, "dev-nohook", { tmuxSession: "oats-test-nosuch" });
    // Either way the retry resolved nothing to run for acme.chan — whether the
    // entry names no retire hook or the capability is gone from config — and a
    // hook that never ran cannot count as cleanup done.
    assert.ok(r.rollbackIncomplete?.some((f) => /acme\.chan/.test(f) && /did not run|cannot verify or undo/.test(f)),
      `a hook that never ran cannot count as cleanup done, got ${JSON.stringify(r.rollbackIncomplete)}`);
    assert.equal(r.removedDir, false);
    assert.equal(existsSync(home), true, "the home survives");
    assert.equal(existsSync(remote), true, "and so does the external state nobody cleaned up");

    // ...and because that state can persist forever, the operator must still have
    // a way out. --force removes the home and NAMES what it is leaving behind,
    // rather than reporting a clean retirement.
    const env = { ...process.env, OATS_TMUX_SESSION: "oats-test-nosuch", PI_AGENTS_TMUX_SESSION: "oats-test-nosuch" };
    delete env.PI_AGENTS_ROOT;
    const cli = spawnSync(process.execPath, [CLI, "retire", "dev-nohook", "--dir", root, "--force", "--json"], { encoding: "utf8", env });
    assert.equal(cli.status, 0, `a forced removal succeeded, so it exits 0: ${cli.stderr}`);
    const f = JSON.parse(cli.stdout);
    assert.equal(f.rollbackIncomplete, undefined);
    assert.ok(f.forcedIncomplete?.length, "forced removal reports what was left outstanding");
    assert.equal(f.removedDir, true);
    assert.match(cli.stderr, /NOT cleaned up/, "and says so to the human, not only in the JSON");
    assert.match(cli.stderr, /acme\.chan/, "naming the state they now own");
    assert.equal(existsSync(home), false, "the home is gone because the operator said so");
  } finally { process.env.PATH = oldPath; }
});

// The founder-approved home/work boundary. These assertions are about what the
// composed text MEANS for the agent reading it, not which literals it contains:
// a contract that merely restates its own strings passes while contradicting the
// mode it was composed for (reviewer-focus-c6e3680).
const BOUNDARY_MUST_SAY = [
  "$OATS_INSTANCE_HOME",                                   // the runtime-neutral name
  "It is not your user home (`~`), not the repository root, and not the work tree",
  "commands from active capabilities, from instance home",   // the shape, not the sentence
  "for example, when the aweb messaging capability is active",  // an optional capability is CITED, never commanded
  "oats <cmd> --dir <path>",                               // the deliberate alternate scope
  "How your own learnings reach your soul is your knowledge capability's business", // the boundary defers; ONE block owns the protocol
];
// Human decision 2026-09-24: nothing in a briefing points an instance at a soul link.
const BOUNDARY_MUST_NOT_SAY = /The home's `soul` link|`\.\/soul`/;
// The instruction that taught the root-placement bug, in any shipped surface.
const SETTLE_IN_WORK = /cd work\/? once|and stay there|where you live|Start in `work\/`/i;
/** Compare wording, not line wrapping: the contract is what the agent reads. */
const flat = (t) => t.replace(/\s+/g, " ");

/** A workspace soul's composed instructions for one work mode (and kind), exactly as a
 *  prepared spawn composes them. */
async function composedFor(fx, mode, kind) {
  const { prepared } = await fx.prepare("dev");
  return flat(composeInstanceAgentsMd(join(fx.root, "dev", "soul"), fx.dep, "dev", mode, kind, prepared).text);
}

test("every work mode's generated instructions carry the home/work boundary (maintainer contract)", async (t) => {
  const fx = v2(t);
  for (const mode of ["worktree", "checkout", "attached", "workspace"]) {
    const text = await composedFor(fx, mode);
    for (const must of BOUNDARY_MUST_SAY) {
      assert.ok(text.includes(flat(must)), `${mode}: generated instructions must say ${JSON.stringify(must)}`);
    }
    assert.doesNotMatch(text, SETTLE_IN_WORK, `${mode}: must not teach settling in the work tree`);
    assert.doesNotMatch(text, BOUNDARY_MUST_NOT_SAY, `${mode}: must not point the instance at a soul link`);
    assert.ok(text.includes(`Work mode: ${mode}`), `${mode}: and still carries its own mode block`);
    assert.ok(text.indexOf("Your two directories") < text.indexOf(`Work mode: ${mode}`),
      `${mode}: the boundary precedes the mode rules it frames`);
    // The boundary must DEFER to the mode on what is permitted. An unqualified
    // "everything happens in work/" is false for workspace mode (read-only, not
    // a repo) and forbids the episodic state the same text puts in the home.
    assert.ok(text.includes(flat("What your mode permits is the mode block's call")),
      `${mode}: the boundary must defer to the mode on permitted operations`);
    assert.doesNotMatch(text, /Nothing you produce belongs anywhere else/,
      `${mode}: an absolute output ban contradicts episodic state and role artifacts`);
  }
});

test("the boundary does not contradict a read-only workspace instance (reviewer-focus-c6e3680)", async (t) => {
  const fx = v2(t);
  const text = await composedFor(fx, "workspace");
  // Workspace `work` is the deployment scope, not a repo, and it is read-only.
  assert.ok(text.includes("never edit or commit inside them"), "the mode's read-only rule survives");
  assert.ok(text.includes(flat("`<instance-home>/work` is your repository or workspace view")),
    "and the boundary calls it a repository OR WORKSPACE view, not simply the repository");
  assert.doesNotMatch(text, /work` is the repository\b/, "no unqualified 'work is the repository' claim");
});

test("a REAL spawned package soul gets the boundary and keeps its own report path (reviewer-focus-c6e3680)", (t) => {
  // A package soul of the attached reviewer's shape (oats.engineering/code-reviewer), spawned through
  // the real CLI from a tagged package — not a synthetic composer call. Its own instructions
  // require writing a report to a temp file before delivering it, so a boundary forbidding
  // output outside work/ would contradict the very agent the package ships.
  const pkg = packageRepo({ id: "acme.dev", souls: { reviewer: { soul: { knowledge: "none" }, agents: "# reviewer\n\nWrite the report to a temp file first, then deliver it to your spawner.\n" } } });
  const fx = v2(t, { workspace: { packages: { "acme.dev": `${pkg.ref}@v1.0.0` } } });
  t.after(pkg.cleanup);
  const env = { PATH: fakeHarnesses(fx.base) };
  assert.equal(fx.cli(["sync", "--json"], { env }).status, 0);
  const owner = jsonResult(fx.cli(["spawn", "dev", "--name", "dev-owner", "--no-launch", "--json"], { env }));
  const r = fx.cli(["spawn", "reviewer", "--purpose", "boundary", "--parent", owner.instance, "--no-launch", "--json"], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const res = jsonResult(r);
  assert.equal(res.home, join(fx.root, "acme-dev--reviewer", "instances", "acme-dev-reviewer-boundary"));
  const text = flat(readFileSync(join(res.home, "AGENTS.md"), "utf8"));
  for (const must of BOUNDARY_MUST_SAY) {
    assert.ok(text.includes(flat(must)), `spawned reviewer: must say ${JSON.stringify(must)}`);
  }
  assert.doesNotMatch(text, SETTLE_IN_WORK);
  // Its mandated artifact must remain possible.
  assert.match(text, /Write the report to a temp file first/,
    "the reviewer's own report artifact survives composition — the boundary must not forbid it");
  assert.doesNotMatch(text, /Nothing you produce belongs anywhere else/,
    "and the boundary must not forbid the temp file that instruction requires");
});

// Notes and checkpoint proposals come from the oats.okf capability. An instance
// without it has neither, and a capability service agent has its knowledge layer
// SUPPRESSED by design — the shipped reviewer is told in its own soul not to
// write notes/ and not to run any harvest. So the kernel-composed blocks must
// stay knowledge-provider-neutral: prescribing that protocol unconditionally
// tells those instances to use machinery they do not have, or that their own
// instructions forbid (reviewer-focus-b512782).
// PRESCRIPTION, not mention: naming "harvesters" as a kind of service agent is
// fine; telling an instance to write `notes/`, run a harvest, or promising how
// its promotions are delivered is what only the knowledge layer may do.
const KNOWLEDGE_PROTOCOL = /notes\/|okf harvest|oats spawn oats\.okf\/knowledge-harvester|memory promotion|harvester(,? which| that)? promot|promot\w* (it |them |your learnings )?(in)?to (its|your|the) soul|knowledge (promotion|updates) (arrive|are delivered)/i;

test("kernel-composed blocks never prescribe a knowledge protocol they cannot guarantee (reviewer-focus-b512782)", async (t) => {
  // No oats.okf capability anywhere in this deployment (knowledge: none): whatever
  // these blocks say, no notes/ dir is scaffolded and no `oats okf harvest` exists.
  const fx = v2(t);
  for (const mode of ["worktree", "checkout", "attached", "workspace"]) {
    for (const kind of [undefined, "capability"]) {
      const text = await composedFor(fx, mode, kind);
      for (const must of BOUNDARY_MUST_SAY) {
        assert.ok(text.includes(flat(must)), `${mode}/${kind}: must say ${JSON.stringify(must)}`);
      }
      assert.doesNotMatch(text, KNOWLEDGE_PROTOCOL,
        `${mode}/${kind}: kernel blocks must not prescribe notes//harvest — no knowledge layer is composed here`);
      assert.doesNotMatch(text, SETTLE_IN_WORK, `${mode}/${kind}`);
    }
  }
});

test("with the knowledge layer active, ONE block owns the protocol (reviewer-focus-b512782)", async (t) => {
  // The REAL oats.okf bound to the knowledge slot (test/helpers/okf-v2.mjs), and a
  // persistent soul spawned in every work mode.
  const f = okfFixture(t, { spawnSource: false });
  const spawn = (mode, ...extra) => f.cli(["spawn", "source", "--purpose", mode, "--work", mode, "--harness", "pi", "--no-launch", "--json", ...extra]);
  const owner = spawn("checkout", "--repo", f.fx.member);
  const homes = {
    worktree: spawn("worktree", "--repo", f.fx.member).home,
    checkout: owner.home,
    attached: spawn("attached", "--repo", f.fx.member, "--work-dir", join(owner.home, "work")).home,
    workspace: spawn("workspace").home,
  };
  // The knowledge block prescribes the protocol; the kernel boundary defers to it
  // and speaks only about ASSIGNED soul work.
  // Count OWNING BLOCKS, not matches in flattened prose: "at least one match"
  // passed while a second block carried its own competing rule (the workspace
  // briefing's "Memory promotion writes there, on a branch, delivered as a PR")
  // — which the old narrow regex could not even see (reviewer-focus-d357cee).
  const blocks = (home) => [...readFileSync(join(home, "AGENTS.md"), "utf8").matchAll(/<!-- oats:(\S+) src=[^>]*-->\n([\s\S]*?)<!-- \/oats:\1 -->/g)]
    .map(([, source, content]) => ({ source, content }));
  for (const [mode, home] of Object.entries(homes)) {
    assert.deepEqual(blocks(home).filter((b) => KNOWLEDGE_PROTOCOL.test(b.content)).map((b) => b.source), ["capability:oats.okf"],
      `${mode}: exactly one block may own the knowledge protocol`);
  }
  const text = flat(readFileSync(join(homes.worktree, "AGENTS.md"), "utf8"));
  assert.ok(text.includes(flat("How your own learnings reach your soul is your knowledge capability's business")),
    "and the boundary defers rather than competing with it");
  assert.ok(text.includes(flat("If your TASK is to change soul content that lives in this repository")),
    "assigned soul-maintenance work is distinguished from promotion of learnings");
});

test("capability instructions and package skills give an independent harvester the proposal, not completion custody", t => {
  const f = okfFixture(t);
  write(join(f.home, "notes/lesson.md"), "A durable source observation.\n");
  assert.doesNotMatch(readFileSync(join(f.home, "TASK.md"), "utf8"), /harvest|propos|okf-propose/i);
  const instructions = readFileSync(join(f.home, "AGENTS.md"), "utf8");
  assert.match(instructions, /IMPORTANT/);
  assert.match(instructions, /\*\*okf-propose\*\* skill is \*\*compulsory\*\*/);
  assert.deepEqual(f.cli(["okf", "status", "--json"], f.as(f.source)), { harvest: "on", reason: "default" });
  assert.match(readFileSync(join(f.home, ".agents/skills/okf-propose/SKILL.md"), "utf8"), /oats spawn oats\.okf\/knowledge-harvester --name <harvester-name> --task-file <proposal> --relation unrelated/);
  const file = f.proposal(), run = f.propose({ file });
  assert.equal(lstatSync(join(run.home, "work")).isSymbolicLink(), false);
  assert.ok(readFileSync(join(run.home, "TASK.md"), "utf8").includes(readFileSync(file, "utf8").trim()));
  const skill = readFileSync(join(run.home, ".agents/skills/knowledge-harvest/SKILL.md"), "utf8");
  assert.match(skill, /okf-publication\.mjs' commit/);
  assert.match(skill, /okf-publication\.mjs' create/);
  assert.match(skill, /okf-publication\.mjs' screen-text/);
  const publisher = readFileSync(join(run.home, ".agents/skills/okf-authoring/scripts/okf-publication.mjs"), "utf8");
  assert.match(publisher, /'--title', 'OKF knowledge proposal'/, "the publication gate retains the fixed PR title");
  assert.match(skill, /retire/);
  assert.equal(existsSync(join(run.home, "work/input.json")), false);
  assert.equal(existsSync(join(run.home, "work/staging.json")), false);
  f.retire(run.instance);
  assert.equal(readFileSync(join(f.home, "notes/lesson.md"), "utf8"), "A durable source observation.\n", "harvester lifecycle never deletes source notes");
  f.retire(f.source.instance);
});

test("the package mirrors respect the actual public kernel module boundary", async () => {
  // docs/design/package-harness-api.md: "independently released packages MUST
  // NOT import kernel-private lib/core.mjs (including via `oats root` + dynamic
  // import)". Everything under mirrors/ is a byte-identical copy of an
  // independently released package, so the rule applies to every file there.
  //
  // Scan for private-file escapes, including dynamically assembled paths.
  // Separately prove the actual package export boundary below: direct kernel
  // unit tests may use public exports; capability execution stays on the CLI.
  const capsDir = resolve(new URL("../mirrors", import.meta.url).pathname);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (e.isFile()) files.push(p);
    }
  };
  walk(capsDir);
  assert.ok(files.length > 20, `expected the full mirrored capability set, saw ${files.length}`);
  const code = files.filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  assert.ok(code.length >= 4, `expected the mirrored executables, saw ${code.length}`);
  for (const f of code) {
    const text = readFileSync(f, "utf8");
    // Match the FILENAME, not the path: the violation that shipped wrote it as
    // join(FRAMEWORK_ROOT, "lib", "core.mjs"), which a /lib\/core\.mjs/ pattern
    // reads straight past.
    assert.doesNotMatch(text, /core\.mjs/, `${relative(capsDir, f)} names the kernel-private module`);
    assert.doesNotMatch(text, /@awebai\/oats\/(?!(?:core|package\.json)["'`])[^"'`]+/, `${relative(capsDir, f)} imports a non-public kernel subpath`);
    assert.doesNotMatch(text, /\boats root\b/, `${relative(capsDir, f)} resolves kernel files through \`oats root\``);
  }
  // OKF execution reaches the kernel through dispatch-supplied OATS_CLI_BIN;
  // inspecting a package export must never be substituted for harness coverage.
  const okfIO = readFileSync(join(capsDir, "oats-okf", "lib", "io.mjs"), "utf8");
  assert.match(okfIO, /OATS_CLI_BIN/, "oats.okf executes the CLI through the dispatch-supplied absolute path");
  const publicAPI = await import("@awebai/oats/core");
  assert.equal(typeof publicAPI.spawnInstance, "function");
  assert.equal((await import("@awebai/oats")).spawnInstance, publicAPI.spawnInstance);
  await assert.rejects(import("@awebai/oats/lib/core.mjs"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("the package mirrors carry the versions package-catalog.json pins", () => {
  // The mirrors exist only as copies of the published payloads (the clean-room
  // smoke wraps mirrors/oats-okf as the "official" oats.okf).
  //
  // This checks VERSION drift and nothing more. It does NOT detect a copy that
  // differs from its payload while claiming the payload's version — the bundled
  // oats.okf this replaced claimed 1.4.1 and differed, and would have passed
  // here. Parity was established by comparing the trees byte for byte against
  // the catalog-pinned payloads at sync time; no assertion in this repo
  // re-establishes it. The kernel coupling that made the old copy wrong is
  // caught by the no-private-import test above.
  const pkgRoot = resolve(new URL("..", import.meta.url).pathname);
  const catalog = JSON.parse(readFileSync(join(pkgRoot, "package-catalog.json"), "utf8"));
  // Capability version == package version only where the package says so; the
  // catalog pins a PACKAGE ref, so compare against the package that supplies
  // each capability; a capability a package exports under another identity is
  // mapped, not assumed.
  const expected = { "oats-okf": "oats.okf", "oats-aweb": "oats.aweb", "oats-aweb-tasks": "oats.aweb", "oats-jira": "oats.jira", "oats-linear": "oats.linear", "oats-authoring": "oats.authoring",
    "oats-folio": "oats.apps", "oats-library": "oats.apps" };
  for (const [slug, pkg] of Object.entries(expected)) {
    const ref = catalog.packages[pkg]?.ref;
    assert.ok(ref, `package-catalog.json pins no ref for ${pkg}`);
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "mirrors", slug, "oats.json"), "utf8"));
    assert.equal(manifest.version, String(ref).replace(/^v/, ""), `mirrors/${slug} must carry the version ${pkg} is pinned at`);
  }
  // oats.engineering is frozen at v1.18.0: its entry and its four aliases stay, so
  // existing pins resolve. This workspace doesn't pin it (its souls compose the
  // member copy of the engineering template), so it has no mirror here (as oats.cloning).
  assert.equal(catalog.packages["oats.engineering"].ref, "v1.18.0");
  const workspacePackages = YAML.parse(readFileSync(join(pkgRoot, "oats-workspace.yaml"), "utf8")).packages;
  assert.equal(Object.hasOwn(workspacePackages, "oats.engineering"), false, "this workspace no longer pins oats.engineering");
  for (const [slug, id] of [["oats-engineering-expert", "oats.engineering-expert"], ["oats-developer", "oats.developer"], ["oats-code-review", "oats.code-review"], ["oats-maintainer", "oats.maintainer"]]) {
    assert.equal(catalog.capabilities[id], "oats.engineering", `${id} is still aliased to the frozen oats.engineering package`);
    assert.equal(existsSync(join(pkgRoot, "mirrors", slug)), false, `mirrors/${slug}: no mirror of an unpinned package`);
  }
  // oats.cloning exports one capability under the package's own id: no alias; the cloner is a package soul.
  // This workspace does not pin it, so it has no mirror here (as oats.machine).
  assert.equal(catalog.packages["oats.cloning"].ref, "v1.1.0");
  assert.equal(catalog.capabilities["oats.cloning"], undefined, "an identity mapping needs no alias");
  // oats.apps exports two capabilities under their own ids; the catalog aliases each to the package.
  assert.equal(catalog.packages["oats.apps"].ref, "v1.0.0");
  for (const [slug, id] of [["oats-folio", "oats.folio"], ["oats-library", "oats.library"]]) {
    assert.equal(JSON.parse(readFileSync(join(pkgRoot, "mirrors", slug, "oats.json"), "utf8")).capability, id);
    assert.equal(catalog.capabilities[id], "oats.apps", `${id} is supplied by the oats.apps package`);
  }
  // oats.dev is retired: no package, alias or mirror remains.
  assert.equal(catalog.packages["oats.dev"], undefined, "oats.dev is no longer listed");
  for (const [alias, target] of Object.entries(catalog.capabilities)) {
    assert.notEqual(typeof target === "string" ? target : target.package, "oats.dev", `alias ${alias} still points at the retired oats.dev`);
  }
  for (const dir of ["capabilities", "mirrors"]) assert.equal(existsSync(join(pkgRoot, dir, "oats-review")), false, `the oats.review copy is gone from ${dir}/`);
});

test("no shipped instructional surface teaches settling in the work tree (maintainer contract)", () => {
  // One line in one file caused this; pin the property across every surface an
  // agent or operator can read, present and future.
  const pkg = resolve(new URL("..", import.meta.url).pathname);
  const surfaces = [];
  const walk = (dir, filter) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, filter);
      else if (filter(e.name)) surfaces.push(p);
    }
  };
  walk(join(pkg, "injects"), (n) => n.endsWith(".md"));
  walk(join(pkg, "docs"), (n) => n.endsWith(".md"));
  walk(join(pkg, "skills"), (n) => n === "SKILL.md");
  walk(join(pkg, "capabilities"), (n) => n.endsWith(".md"));
  walk(join(pkg, "mirrors"), (n) => n.endsWith(".md"));
  surfaces.push(join(pkg, "README.md"));
  assert.ok(surfaces.length > 10, `expected the full instructional surface, saw ${surfaces.length}`);
  for (const f of surfaces) {
    assert.doesNotMatch(readFileSync(f, "utf8"), SETTLE_IN_WORK, `${relative(pkg, f)} teaches the root-placement bug`);
  }
});

test("the independently targetable coordination capabilities (the member copy of the engineering template) assume no knowledge or messaging layer", () => {
  // Each may be composed into a deployment that has replaced or disabled either
  // layer — `requires` is for host commands and harness packages, never
  // capability dependencies (maintainer ruling). These are BOUNDED, observable
  // properties. Provider neutrality as a whole is not machine-decidable from
  // prose: when these surfaces change, it needs semantic review by the
  // maintainer, which the PR process already provides.
  for (const slug of ["oats-engineering-expert", "oats-developer", "oats-code-review", "oats-maintainer", "oats-landing-rules", "oats-dispatcher"]) {
    const dir = resolve(new URL(`../capabilities/${slug}`, import.meta.url).pathname);
    const manifest = JSON.parse(readFileSync(join(dir, "oats.json"), "utf8"));
    for (const r of manifest.requires || []) {
      assert.ok(!r.capability && !r.layer, `${slug}: requires must not carry layer dependencies: ${JSON.stringify(r)}`);
    }
    // The surfaces that ship INDEPENDENTLY of any layer issue no command
    // belonging to one.
    const files = [manifest.inject, ...manifest.skills.map((s) => `${s}/SKILL.md`)];
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      assert.doesNotMatch(text, /\baw\b/i, `${slug}/${f} commands the aweb CLI`);
      assert.doesNotMatch(text, /\boats okf\b/i, `${slug}/${f} commands the OKF layer`);
    }
  }
  // The reviewer's report states the no-layer delivery: what an instance needs
  // to behave correctly with, and without, a messaging layer.
  const reviewer = readFileSync(resolve(new URL("../capabilities/oats-code-review/injects/reviewer.md", import.meta.url).pathname), "utf8");
  assert.match(reviewer, /messaging layer if one is active[\s\S]*otherwise print it as your final message/, "the reviewer's report falls back to its own session");
});

test("the accepted trust boundary is DOCUMENTED, not left as a code comment (maintainer contract)", () => {
  // The maintainer accepted the narrow filesystem TOCTOU residual as a deployment
  // trust boundary — which only holds if operators are TOLD. A prerequisite that
  // lives in a source comment is one no deployment ever reads.
  const doc = readFileSync(resolve(new URL("../docs/souls-and-instances.md", import.meta.url).pathname), "utf8");
  const flatDoc = doc.replace(/\s+/g, " ");
  for (const must of [
    "must be owned by the operator and not writable by untrusted users or processes",
    "openat",                                    // why the kernel cannot close it
    "E_NO_CANONICAL_ROOT",                       // what failure looks like
    "OATS_INSTANCE_HOME",                         // how an instance learns its home
    "soul-owning repo's primary checkout",       // where homes actually land
  ]) {
    assert.ok(flatDoc.includes(must.replace(/\s+/g, " ")), `public docs must state ${JSON.stringify(must)}`);
  }
});

test("instance homes stay inside the deployment: every layout, every symlink escape (reviewer-aggregate2, reviewer-1a6e82e)", async (t) => {
  const checkout = { soul: { work: "checkout" } };
  const fx = v2(t, { souls: { dev: checkout, esc1: checkout, esc2: checkout } });
  const { base, root } = fx;
  // A SECOND primary Git repo standing in for "somewhere else entirely" — the
  // escapes below are only interesting because the home would land in a real,
  // unrelated deployment-looking place, taking any credential a hook writes.
  const foreign = join(base, "foreign"); gitRepo(foreign);
  process.env.PATH = fakeHarnesses(base);
  // --- Legitimate layouts still work. ------------------------------------
  const persistent = (await fx.spawn("dev", { instance: "dev-ok" })).home;
  assert.equal(realpathSync(persistent), join(realpathSync(join(root, "dev")), "instances", "dev-ok"));

  // --- Every escape is refused, and NOTHING is created outside. ----------
  // Each soul is prepared (fetched into agents/<soul>/) first, then its layout
  // is redirected, so only the placement guard stands between it and the spawn.
  const escapes = {
    // The instances/ dir itself redirects the home.
    "a symlinked instances/ dir": (dir) => {
      rmSync(join(dir, "instances"), { recursive: true, force: true });
      symlinkSync(foreign, join(dir, "instances"));
    },
    // The agent dir redirects one level up.
    "a symlinked agent dir": (dir) => {
      const outside = join(base, "outside-soul");
      cpSync(dir, outside, { recursive: true, verbatimSymlinks: true });
      rmSync(dir, { recursive: true, force: true });
      symlinkSync(outside, dir);
    },
  };
  for (const [[label, redirect], soul] of Object.entries(escapes).map((e, i) => [e, `esc${i + 1}`])) {
    const { prepared } = await fx.prepare(soul);
    redirect(join(root, soul));
    const agent = findAgent(root, soul);
    assert.ok(agent, `${label}: precondition — the agent resolves, so only the placement guard can stop it`);
    const before = readdirSync(foreign).length;
    await assert.rejects(
      spawnInstanceAsync(root, agent, { instance: `${soul}-x`, launch: false, prepared, repo: fx.member }),
      (e) => e.code === "E_NO_CANONICAL_ROOT",
      `${label}: the home would land outside the deployment`,
    );
    assert.equal(readdirSync(foreign).length, before, `${label}: nothing was created outside`);
  }
});

test("a path swapped AFTER validation is caught before anything is written (reviewer-a6aa1c5)", async (t) => {
  // The placement checks run before composition and the harness preflight, both
  // of which shell out — a real window. The fake `pi` swaps instances/ for a link
  // to the foreign repo WHILE the preflight is running, which is exactly the
  // race: mkdirSync then follows the link, and everything after it (scaffolding,
  // the identity hook and its key) would land outside the deployment.
  const fx = v2Dev(t, { "acme.chan": cap({ requires: [{ harness: "pi", package: "npm:@acme/chan", why: "channel" }] }) });
  const { base, root } = fx;
  const foreign = join(base, "foreign"); gitRepo(foreign);
  const bin = join(base, "bin"); mkdirSync(bin, { recursive: true });
  const instances = join(root, "dev", "instances");
  const pkgDir = join(base, "pkg"); mkdirSync(pkgDir, { recursive: true });
  write(join(bin, "pi"), `#!/bin/sh
if [ "$1" = "list" ]; then
  rm -rf ${JSON.stringify(instances)}
  ln -s ${JSON.stringify(foreign)} ${JSON.stringify(instances)}
  echo "User packages:"
  echo "  npm:@acme/chan"
  echo "    ${pkgDir}"
fi
exit 0
`);
  write(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  execFileSync("chmod", ["-R", "+x", bin]);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  await assert.rejects(
    fx.spawn("dev", { instance: "dev-race", harness: "pi" }),
    (e) => e.code === "E_NO_CANONICAL_ROOT" && /after it was validated|not at/.test(e.message),
    "a destination that changed after validation must not be used",
  );
  assert.deepEqual(readdirSync(foreign).filter((f) => f !== ".git" && f !== ".gitignore"), [],
    "and nothing — not even the empty home — is left outside the deployment");
});

test("a rollback AFTER launch quarantines too — every path, not just required hooks (reviewer-terminal54a87fd)", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  // The spawn SUCCEEDS, then re-pointing the parent anchor fails, so the kernel
  // rolls back an instance that already exists. That path deleted the home
  // unconditionally — including while its own retire hook was reporting failure
  // — which strands the external state the hook could not undo and destroys the
  // credential that was the only way to retry. Same defect the required-hook
  // path was fixed for; a second copy of the logic is how it survived.
  const remote = join(out, "remote-identity");
  const allow = join(out, "cleanup-works");
  const fx = v2Dev(t, { "acme.comp": cap({ hooks: { spawn: "hook.mjs spawn", retire: "hook.mjs retire" } }, {
    "hook.mjs": `import {writeFileSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
if (process.env.OATS_EVENT === 'spawn') {
  writeFileSync(${JSON.stringify(remote)}, 'joined');
  writeFileSync(join(process.env.OATS_HOME, 'identity.key'), 'key');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(0);
}
if (!existsSync(${JSON.stringify(allow)})) { console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } })); process.exit(3); }
// Actually undo the external state — a hook that only REPORTS success would let
// the test pass while the remote identity survived.
rmSync(${JSON.stringify(remote)}, { force: true });
console.log(JSON.stringify({ meta: { retired: true } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-child");
  try {
    const anchorInst = await fx.spawn("dev", { instance: "dev-anchor", harness: "pi" });
    // Make the anchor's atomic re-point fail: a DIRECTORY where its temp file goes.
    mkdirSync(join(anchorInst.home, "instance.json.tmp-dev-child"), { recursive: true });
    write(join(anchorInst.home, "instance.json.tmp-dev-child", "x"), "x");

    await assert.rejects(
      fx.spawn("dev", { instance: "dev-child", harness: "pi", relation: "parent", relativeTo: "dev-anchor" }),
      (e) => e.details?.unconfirmed === true && /failed to re-point anchor/.test(e.message) && /RETAINED/.test(e.message),
      "a rollback that could not compensate must not report a clean one",
    );
    assert.equal(existsSync(join(home, "identity.key")), true, "the credential the retry needs survives");
    assert.equal(existsSync(remote), true, "and the external state nobody cleaned up is still there");
    const marker = JSON.parse(readFileSync(join(home, ".oats-rollback-incomplete.json"), "utf8"));
    assert.equal(marker.cleanup.version, 1, "the quarantine carries the same cleanup contract");
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["acme.comp"], "naming the hook that still owes cleanup");

    // The home this path retains ALREADY HAS instance.json — it was written
    // before the anchor step — and gating the marker on its absence made retire
    // ignore the quarantine entirely, take the ordinary path where hook failures
    // do not retain, and delete the credential (reviewer-final0130bc8).
    assert.equal(existsSync(join(home, "instance.json")), true, "precondition: a live-looking home");
    assert.equal(marker.cleanup.capabilityMeta["acme.comp"]?.alias, "probe",
      "the descriptor keeps the SPAWN metadata a retry needs, not the failed compensation's report");

    // FIRST retry, cause unfixed: must retain everything and not claim success.
    const first = retireInstance(root, "dev-child", { tmuxSession: "oats-test-nosuch" });
    assert.ok(first.rollbackIncomplete?.length, "a failing retry reports incomplete");
    assert.equal(first.removedDir, false);
    assert.equal(existsSync(join(home, "identity.key")), true, "the credential survives the failed retry");
    assert.equal(existsSync(join(home, ".oats-rollback-incomplete.json")), true, "and so does the marker");
    assert.equal(existsSync(remote), true, "and the external state it exists to undo");
    const after = JSON.parse(readFileSync(join(home, ".oats-rollback-incomplete.json"), "utf8"));
    assert.equal(after.cleanup.capabilityMeta["acme.comp"]?.alias, "probe",
      "the spawn metadata is not displaced by the retry's own failure report");

    // SECOND retry, cause fixed: external cleanup verified, then removal.
    writeFileSync(allow, "ok");
    const r = retireInstance(root, "dev-child", { tmuxSession: "oats-test-nosuch" });
    assert.equal(r.rollbackIncomplete, undefined, `the retry completes: ${JSON.stringify(r.rollbackIncomplete)}`);
    assert.equal(existsSync(remote), false, "the remote state is actually gone");
    assert.equal(existsSync(home), false, "and only then is the home removed");
  } finally { process.env.PATH = oldPath; }
});

test("a marker beside a live instance.json is authoritative, usable or not (reviewer-final0130bc8)", async (t) => {
  const fx = v2(t, { souls: { dev: { soul: { work: "checkout" } } } });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    // An UNUSABLE marker next to instance.json is evidence that cleanup was
    // interrupted, not noise to skip: OATS cannot tell what remains, so it fails
    // closed and `--force` is the deliberate escape.
    const a = await fx.spawn("dev", { instance: "dev-broke" });
    writeFileSync(join(a.home, "identity.key"), "secret");
    writeFileSync(join(a.home, ".oats-rollback-incomplete.json"), '{"cleanup": {"repo":');
    assert.throws(
      () => retireInstance(root, "dev-broke", { tmuxSession: "oats-test-nosuch" }),
      (e) => e.code === "E_UNIDENTIFIED_INSTANCE_HOME",
      "an unusable marker must not be ignored just because instance.json exists",
    );
    assert.equal(existsSync(join(a.home, "identity.key")), true, "nothing destroyed");
    retireInstance(root, "dev-broke", { tmuxSession: "oats-test-nosuch", force: true });
    assert.equal(existsSync(a.home), false, "and --force still clears it");

    // An ordinary live instance with NO marker retires normally — the guard must
    // not turn every retire into a quarantine.
    const b = await fx.spawn("dev", { instance: "dev-plain" });
    const r = retireInstance(root, "dev-plain", { tmuxSession: "oats-test-nosuch" });
    assert.equal(r.rollbackIncomplete, undefined, "no marker, no quarantine");
    assert.equal(r.removedDir, true);
    assert.equal(existsSync(b.home), false);
  } finally { process.env.PATH = oldPath; }
});

test("a required spawn hook with NO retire hook quarantines instead of deleting the credential (reviewer-446ebe1)", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  // The manifest permits this shape: a required spawn hook and no retire hook.
  // The hook creates remote state and a local key, then fails. Compensation has
  // nothing to run, so it reports nothing wrong — and the clean-rollback path
  // deleted the home, taking the only key that could ever reach the remote state.
  // Silence from a capability that declares no cleanup is not evidence of a clean
  // rollback.
  const remote = join(out, "remote-identity");
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true } },
  }, {
    "hook.mjs": `import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(${JSON.stringify(remote)}, 'joined');
writeFileSync(join(process.env.OATS_HOME, 'identity.key'), 'key');
console.log(JSON.stringify({ meta: { alias: 'probe' } }));
process.exit(1);`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-nocomp");
  try {
    await assert.rejects(
      fx.spawn("dev", { instance: "dev-nocomp", harness: "pi" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED" && e.details?.unconfirmed === true && /RETAINED/.test(e.message),
      "a rollback that could not compensate must not report a clean one",
    );
    assert.equal(existsSync(join(home, "identity.key")), true, "the key the hook wrote survives");
    assert.equal(existsSync(remote), true, "and so does the remote state it created");
    const marker = JSON.parse(readFileSync(join(home, ".oats-rollback-incomplete.json"), "utf8"));
    assert.deepEqual(marker.cleanup.outstanding.hooks, ["acme.chan"], "which is recorded as outstanding");

    // A retry cannot fix this — there is no hook to run — so it must keep saying
    // so, and point at the only exit rather than quietly clearing.
    const r = retireInstance(root, "dev-nocomp", { tmuxSession: "oats-test-nosuch" });
    assert.ok(r.rollbackIncomplete?.some((f) => /declares no retire hook/.test(f)),
      `the reason must name the real situation, got ${JSON.stringify(r.rollbackIncomplete)}`);
    assert.equal(existsSync(join(home, "identity.key")), true, "nothing was destroyed on the retry either");

    const f = retireInstance(root, "dev-nocomp", { tmuxSession: "oats-test-nosuch", force: true });
    assert.ok(f.forcedIncomplete?.length, "and --force reports what the operator now owns");
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(remote), true, "the remote state is still theirs to clean up");
  } finally { process.env.PATH = oldPath; }
});

test("an incomplete cleanup names the home's REAL path (reviewer-adff009)", async (t) => {
  // A reconstructed path sends the operator to a directory that may not exist, on
  // the one message that asks them to go clean up by hand. (A capability agent
  // composes its providing module with no hooks — Q1 — so only a soul's spawn can
  // leave outstanding cleanup.)
  const fx = v2Dev(t, { "acme.review": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OATS_EVENT === 'spawn') { console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));`,
  }) });
  process.env.PATH = fakeHarnesses(fx.base);
  await assert.rejects(fx.spawn("dev", { instance: "dev-q" }), (e) => e.code === "E_REQUIRED_HOOK_FAILED");
  const home = findInstanceHomes(fx.root, "dev-q")[0].home;
  assert.equal(home, join(fx.root, "dev", "instances", "dev-q"), "precondition: it homes under the agents root");

  const r = retireInstance(fx.root, "dev-q", { tmuxSession: "oats-test-nosuch" });
  assert.ok(r.rollbackIncomplete, "cleanup is incomplete");
  assert.equal(realpathSync(r.retainedHome), realpathSync(home), "the result names the home that actually survived");

  const cli = fx.cli(["retire", "dev-q"], { env: { PATH: process.env.PATH, OATS_TMUX_SESSION: "oats-test-nosuch", PI_AGENTS_TMUX_SESSION: "oats-test-nosuch" } });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    `the diagnostic must point at the retained home, got: ${cli.stderr}`);
});

test("`oats retire` reports an incomplete cleanup and exits nonzero, not 'Retired'", async (t) => {
  // Compensation keeps failing, so the home and its external state remain. A
  // zero exit here tells a human — and any script — that the work is done.
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: { command: "hook.mjs spawn", required: true }, retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `if (process.env.OATS_EVENT === 'spawn') { console.log(JSON.stringify({ meta: { alias: 'probe' } })); process.exit(1); }
console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  try {
    await assert.rejects(fx.spawn("dev", { instance: "dev-cli", harness: "pi" }),
      (e) => e.code === "E_REQUIRED_HOOK_FAILED");
    const env = { ...process.env, OATS_TMUX_SESSION: "oats-test-nosuch", PI_AGENTS_TMUX_SESSION: "oats-test-nosuch" };
    delete env.PI_AGENTS_ROOT;
    const r = spawnSync(process.execPath, [CLI, "retire", "dev-cli", "--dir", root], { encoding: "utf8", env });
    assert.notEqual(r.status, 0, `an incomplete cleanup must exit nonzero, got ${r.status}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /^Retired /m, "and must not claim the instance was retired");
    assert.match(r.stderr, /INCOMPLETE/);
    assert.match(r.stderr, /self-delete-failed/, "the outstanding failure is named");
    assert.equal(existsSync(join(root, "dev", "instances", "dev-cli")), true, "the home is still retained");
  } finally { process.env.PATH = oldPath; }
});

test("ORDINARY retirement blocks and preserves evidence when a retire hook reports incomplete cleanup", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  // External state stands in for a remote identity the hook could not remove.
  // The spawn SUCCEEDS here — this is the ordinary path, not a quarantine retry,
  // which is exactly the asymmetry under test: a first failure was discarded
  // while a retry was careful.
  const remote = join(out, "remote-identity");
  const allowCleanup = join(out, "cleanup-works");
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: "hook.mjs spawn", retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, existsSync} from 'node:fs';
const remote = ${JSON.stringify(remote)};
if (process.env.OATS_EVENT === 'spawn') {
  writeFileSync(remote, 'joined');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(0);
}
if (!existsSync(${JSON.stringify(allowCleanup)})) {
  console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));
  process.exit(1);
}
console.log(JSON.stringify({ meta: { retired: true } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-ord");
  try {
    await fx.spawn("dev", { instance: "dev-ord", harness: "pi" });
    assert.equal(existsSync(home), true, "ordinary spawn succeeded — no quarantine");
    assert.equal(existsSync(join(home, ".oats-rollback-incomplete.json")), false, "and no marker yet");
    assert.equal(existsSync(remote), true, "external state exists");

    // FIRST failure on the ordinary path must retain, not delete.
    const r = retireInstance(root, "dev-ord", { tmuxSession: "oats-test-nosuch" });
    assert.ok(r.rollbackIncomplete, "incomplete cleanup is reported, not discarded");
    assert.equal(r.removedDir, false, "the home is NOT removed");
    assert.equal(existsSync(home), true, "the home and its credentials survive");
    assert.equal(existsSync(remote), true, "the external state it still owes cleanup for is untouched");
    // The evidence a retry needs: capabilities named as IDs, not only prose.
    const marker = JSON.parse(readFileSync(join(home, ".oats-rollback-incomplete.json"), "utf8"));
    assert.ok(marker.cleanup.capabilityRuntime.some((c) => c.id === "acme.chan"),
      "the retained descriptor names the owing capability as an ID a retry can verify");

    // MIRROR: a hook that completes must still delete exactly as before, or the
    // fix has broken ordinary retirement in order to fix a corner of it.
    writeFileSync(allowCleanup, "ok");
    const done = retireInstance(root, "dev-ord", { tmuxSession: "oats-test-nosuch" });
    assert.equal(done.rollbackIncomplete, undefined, "a completing hook reports clean");
    assert.equal(existsSync(home), false, "and the home is removed as usual");
  } finally { process.env.PATH = oldPath; }
});

test("self-retire defers everything: the caller runs no hooks and removes nothing; the deferred completion retires as an external operator and reports an incomplete hook explicitly", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  const remote = join(out, "remote-identity");
  const retireRan = join(out, "retire-ran");
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: "hook.mjs spawn", retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, existsSync, unlinkSync} from 'node:fs';
if (process.env.OATS_EVENT === 'spawn') {
  writeFileSync(${JSON.stringify(remote)}, 'joined');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(0);
}
writeFileSync(${JSON.stringify(retireRan)}, 'ran');
if (existsSync(${JSON.stringify(join(out, "block-cleanup"))})) {
  console.log(JSON.stringify({ meta: { retired: false, reason: 'self-delete-failed' } }));
  process.exit(1);
}
unlinkSync(${JSON.stringify(remote)});
console.log(JSON.stringify({ meta: { retired: true } }));`,
  }) });
  const { base, root } = fx;
  writeFileSync(join(out, "block-cleanup"), "the remote refuses");
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const home = join(root, "dev", "instances", "dev-self");
  let completion; // the detached completion child: ended below whatever the test's outcome, before the fixture is
  try {
    await fx.spawn("dev", { instance: "dev-self", harness: "pi" });
    // Long delay: the detached child must not race the assertions below; the
    // completion under test is driven synchronously with delaySec 0.
    const r = retireInstance(root, "dev-self", { tmuxSession: "oats-test-nosuch", self: true, selfKillDelaySec: 600 });
    completion = r.completionPid;
    assert.equal(r.deferred, true);
    assert.equal(r.selfKillScheduled, undefined, "no kill is promised: the completion's quiesce is what ends the window");
    assert.equal(r.resultPath, deferredRetireResultPath(home));
    assert.equal(existsSync(retireRan), false, "the retire hook did not run in the caller");
    assert.equal(existsSync(home), true, "the instance home remains untouched by the caller");
    assert.equal(existsSync(join(home, ".oats-retire-pending.json")), false, "and carries no marker of its own");
    assert.equal(existsSync(remote), true, "capability-required state remains untouched by the caller");
    const intent = JSON.parse(readFileSync(retirePendingMarkerPath(home), "utf8"));
    assert.equal(intent.instance, "dev-self");
    assert.equal(intent.root, resolve(root));
    // Status reads the owed retirement without completing it.
    const listed = listInstances(root, "oats-test-nosuch").find((a) => a.name === "dev").instances.find((i) => i.instance === "dev-self");
    assert.equal(listed.retirePending.instance, "dev-self");
    assert.equal(existsSync(home), true, "status is read-only: the home is still there");
    // The completion is run here instead: the scheduled one, which the marker names, is gone first.
    await killAndReap(r.completionPid);

    // The completion is an ORDINARY retirement: the hook runs, reports it did
    // not finish, and the home is retained under quarantine with an explicit
    // failed outcome beside it — never a silent success.
    // Not retried: what a retry does is test/retire-hook-retry.test.mjs's.
    assert.equal(completeDeferredRetirement(retirePendingMarkerPath(home), { delaySec: 0, retryDelaysMs: [] }), false);
    assert.equal(existsSync(retireRan), true, "the retire hook ran in the completion");
    assert.equal(existsSync(home), true, "an incomplete hook retains the home");
    assert.equal(JSON.parse(readFileSync(r.resultPath, "utf8")).result?.workRecovery, undefined, "the caller changed no home bytes, so nothing was needlessly preserved");
    assert.equal(existsSync(join(home, ".oats-rollback-incomplete.json")), true, "under the usual quarantine");
    const outcome = JSON.parse(readFileSync(r.resultPath, "utf8"));
    assert.equal(outcome.ok, false);
    assert.match(outcome.result.rollbackIncomplete.join("\n"), /self-delete-failed/);
    assert.match(outcome.retry, /^oats retire dev-self --home \S+\/dev\/instances\/dev-self$/, "the retry names the kept home");
    const dev = listInstances(root, "oats-test-nosuch").find((a) => a.name === "dev");
    assert.equal(dev.retireFailures.length, 1, "status surfaces the failed deferred retirement");
    assert.equal(dev.retireFailures[0].instance, "dev-self");
    assert.equal(dev.instances.find((i) => i.instance === "dev-self").retirePending.instance, "dev-self", "the retained home still reads as owed a retirement");

    // The documented retry: the operator fixes the cause and runs a plain
    // external retire. It pays the debt and clears every file the deferred
    // lane left beside the home — marker, outcome, log.
    rmSync(join(out, "block-cleanup"));
    const retried = retireInstance(root, "dev-self", { tmuxSession: "oats-test-nosuch" });
    assert.equal(retried.rollbackIncomplete, undefined);
    assert.equal(existsSync(home), false, "the retry removes the home");
    assert.equal(existsSync(remote), false, "and the hook released the external state");
    assert.equal(existsSync(retirePendingMarkerPath(home)), false, "marker cleared");
    assert.equal(existsSync(r.resultPath), false, "failed outcome cleared");
    assert.equal(existsSync(r.logPath), false, "completion log cleared");
    assert.equal(listInstances(root, "oats-test-nosuch").find((a) => a.name === "dev").retireFailures, undefined, "status is clean");
  } finally { process.env.PATH = oldPath; if (completion !== undefined) await killAndReap(completion); }
});

test("self-retire completes without a later operator command: the detached child retires the instance and records success", async (t) => {
  const out = temp(); t.after(() => rmSync(out, { recursive: true, force: true }));
  const remote = join(out, "remote-identity");
  const fx = v2Dev(t, { "acme.chan": cap({
    hooks: { spawn: "hook.mjs spawn", retire: "hook.mjs retire" },
  }, {
    "hook.mjs": `import {writeFileSync, unlinkSync} from 'node:fs';
if (process.env.OATS_EVENT === 'spawn') {
  writeFileSync(${JSON.stringify(remote)}, 'joined');
  console.log(JSON.stringify({ meta: { alias: 'probe' } }));
  process.exit(0);
}
unlinkSync(${JSON.stringify(remote)});
console.log(JSON.stringify({ meta: { retired: true } }));`,
  }) });
  const { base, root } = fx;
  const oldPath = process.env.PATH; process.env.PATH = fakeHarnesses(base);
  const oldInst = process.env.OATS_INSTANCE; process.env.OATS_INSTANCE = "dev-self";
  const home = join(root, "dev", "instances", "dev-self");
  let completion; // the detached completion child: ended below whatever the test's outcome, before the fixture is
  try {
    await fx.spawn("dev", { instance: "dev-self", harness: "pi" });
    const r = retireInstance(root, "dev-self", { tmuxSession: "oats-test-nosuch", self: true, selfKillDelaySec: 0 });
    completion = r.completionPid;
    assert.equal(r.deferred, true);
    assert.equal(existsSync(r.pendingMarker), true, "the promise is on disk once a completion process exists");
    // Success leaves nothing beside the home; the last thing the child does
    // is remove its own log, so its absence is the completion signal.
    const deadline = Date.now() + 20_000;
    const done = () => !existsSync(home) && !existsSync(r.pendingMarker) && !existsSync(r.logPath);
    while (!done() && !existsSync(r.resultPath) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    assert.equal(existsSync(r.resultPath), false, `the completion reported a failure: ${existsSync(r.resultPath) ? readFileSync(r.resultPath, "utf8") : ""}`);
    assert.equal(existsSync(home), false, `the home is gone with no operator command; log:\n${existsSync(r.logPath) ? readFileSync(r.logPath, "utf8") : "(none)"}`);
    assert.equal(existsSync(r.pendingMarker), false, "the marker went with the home");
    assert.equal(existsSync(remote), false, "the retire hook ran and released the external state");
    const leftovers = readdirSync(join(root, "dev", "instances")).filter((f) => f.startsWith(".oats-retired-") || f.startsWith(".oats-retire-pending-"));
    assert.deepEqual(leftovers, [], "success leaves no file beside the home");
    assert.equal(existsSync(join(root, "dev", "instances", ".oats-retirement", "recovery")), false, "and preserved nothing, since the caller changed no home bytes");
    assert.equal(listInstances(root, "oats-test-nosuch").find((a) => a.name === "dev").retireFailures, undefined, "a success is not a failure to surface");
  } finally {
    process.env.PATH = oldPath; if (oldInst === undefined) delete process.env.OATS_INSTANCE; else process.env.OATS_INSTANCE = oldInst;
    if (completion !== undefined) await killAndReap(completion);
  }
});

for (const [harness, selectorKind] of [["pi", "absolute"], ["pi", "tilde"], ["pi", "home"], ["pi", "relative"], ["claude", "absolute"]]) test(`${harness} missing-package remedy preserves ${selectorKind} resource directory, selected executable and shell quoting without installing during preflight`, async (t) => {
  const spec = harness === "pi" ? "npm:@awebai/pi@0.3.10" : "chan@acme-marketplace";
  const fx = v2Dev(t, { "acme.chan": cap({ requires: [{ harness, package: spec, ...(harness === "claude" ? { marketplace: "acme/claude-plugins" } : {}), why: "channel" }] }) });
  process.env.PATH = fakeHarnesses(fx.base);
  const wrapper = join(fx.base, "selected harness's bin", `${harness} wrapper`);
  const launchHome = join(fx.base, "launch home's $(literal)");
  const resourceDir = selectorKind === "tilde" ? "~/resource dir's $(literal)" : selectorKind === "home" ? "~" : selectorKind === "relative" ? "relative resource dir's $(literal)" : join(fx.base, "resource dir's $(literal)");
  const expectedDir = selectorKind === "tilde" ? join(launchHome, resourceDir.slice(2)) : selectorKind === "home" ? launchHome : resolve(resourceDir);
  const log = join(fx.base, "manager-calls.jsonl");
  const selector = harness === "pi" ? "PI_CODING_AGENT_DIR" : "CLAUDE_CONFIG_DIR";
  write(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const selector = process.env[${JSON.stringify(selector)}];
const resource = path.resolve(selector === '~' ? process.env.HOME : selector.startsWith('~/') ? path.join(process.env.HOME, selector.slice(2)) : selector);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), resource }) + '\\n');
if (process.argv[2] === 'plugin' && process.argv[3] === 'list') process.stdout.write('[]');
`);
  execFileSync("chmod", ["+x", wrapper]);
  const localFile = join(fx.dep, "oats-local.yaml");
  write(localFile, readFileSync(localFile, "utf8") + `\nlaunch-configs:\n  remedy:\n    harness: ${harness}\n    executable: ${JSON.stringify(wrapper)}\n    env:\n      HOME: ${JSON.stringify(launchHome)}\n      ${selector}: ${JSON.stringify(resourceDir)}\n`);
  let message;
  await assert.rejects(fx.spawn("dev", { instance: `dev-remedy-${harness}`, launchConfig: "remedy" }), (e) => {
    assert.equal(e.code, "E_HARNESS_RESOURCE_MISSING"); message = e.message; return true;
  });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls().every((r) => !r.args.includes("install") && !r.args.includes("marketplace")), "preflight probes only, never installs");
  assert.ok(calls().length > 0, "selected wrapper was probed");
  for (const r of calls()) assert.equal(r.resource, expectedDir, "probe uses launch-config HOME and original working directory");
  assert.doesNotMatch(message, /oats install|--accept-requirement/);
  const command = /operator to run `([^`]+)`/.exec(message)?.[1];
  assert.ok(command, message);
  writeFileSync(log, "");
  // Only the fixture's inert package-manager stub runs: prove the guidance is
  // executable shell text even when executable/config paths contain quotes.
  execFileSync("/bin/sh", ["-c", command], { cwd: fx.base, env: { ...process.env, [selector]: "/wrong-resource-dir" } });
  assert.deepEqual(calls().map((r) => r.args), harness === "pi" ? [["install", spec]] : [["plugin", "marketplace", "add", "acme/claude-plugins"], ["plugin", "install", spec]]);
  for (const r of calls()) { assert.equal(r.resource, expectedDir); assert.equal(r.cwd, fx.dep); }
  assert.equal(existsSync(join(fx.root, "dev", "instances", `dev-remedy-${harness}`)), false);
});
