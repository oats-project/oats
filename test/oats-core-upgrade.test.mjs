// oats.core across `oats instance upgrade` (#1549): a home the real kernel spawned on a
// released oats.core (the bytes of its framework tag) moves to this checkout's oats.core,
// and its next start composes. oats.core records no meta, so its upgrade hook adopts an
// empty OATS_META and refuses anything else with the respawn remedy.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { oatsSocket } from "./helpers/host-fixture.mjs";
import { v2Deployment, git, writeFixtureExecutable, insideFixture } from "./helpers/v2-deployment.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { writeLock } from "../lib/packages.mjs";
import { planUpgrade, applyUpgrade } from "../lib/instance-upgrade.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CORE = "oats-package/capabilities/oats-core";
const HOOK = join(ROOT, CORE, "bin/oats-core.mjs");
const PKG = "fixture.framework";
const json = p => JSON.parse(readFileSync(p, "utf8"));

/** Every file under `dir`, as writeTree entries under the package's oats-core path. */
function treeFiles(dir) {
  const files = { [CORE]: null };
  const walk = d => { for (const name of readdirSync(d)) {
    const abs = join(d, name);
    if (statSync(abs).isDirectory()) walk(abs);
    else files[`${CORE}/${relative(dir, abs)}`] = { text: readFileSync(abs, "utf8"), mode: statSync(abs).mode & 0o777 };
  } };
  walk(dir);
  return files;
}
/** oats.core as a released framework tag carries it, read from this checkout's history
 *  (CI checks out with every tag); never fetched. */
function releasedCore(base, tag) {
  const out = join(base, "released", tag.replaceAll("/", "-"));
  mkdirSync(out, { recursive: true });
  const archive = execFileSync("git", ["-C", ROOT, "archive", tag, CORE], { maxBuffer: 16 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", out], { input: archive });
  return treeFiles(join(out, CORE));
}
function packageFiles(version, core) {
  return { "oats-package/oats-package.json": { json: { package: PKG, version, capabilities: ["capabilities/oats-core"] } }, ...core };
}
function lock(fx, version) {
  const commit = git(fx.member, "rev-parse", "HEAD");
  writeLock(fx.dep, { lockfileVersion: 3, packages: { [PKG]: { source: `git:${fx.key}@main`, url: fx.ref, path: "oats-package", version, commit, integrity: contentDigest(join(fx.member, "oats-package")), capabilities: ["oats.core"] } } });
}
/** A Claude home spawned on oats.core from `tag`, its lock then moved to this checkout's oats.core. */
async function releasedHome(t, tag) {
  const fx = v2Deployment({ t, souls: { dev: { soul: { capabilities: { "oats.core": { from: "package" } } } } } });
  const old = releasedCore(fx.base, tag);
  fx.commit({ ...packageFiles("1.0.0", old), "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "fixture", members: [fx.ref], defaults: { knowledge: "none", messaging: "none", tasks: "none" }, packages: { [PKG]: `git:${fx.key}@main` } } } });
  lock(fx, "1.0.0");
  // The in-process spawn looks the harness up on this process's PATH: the fixture's, whose inert `claude` comes first.
  const path = process.env.PATH;
  t.after(() => { process.env.PATH = path; });
  process.env.PATH = fx.env.PATH;
  const { home } = await fx.spawn("dev", { name: "seat", harness: "claude", noLaunch: true });
  const recorded = json(join(home, "instance.json")).launch.executable;
  assert.ok(insideFixture(fx.base, recorded), `the home's recorded harness (${recorded}) is a file of the fixture (${fx.base}), never one of this machine`);
  const oldVersion = JSON.parse(old[`${CORE}/oats.json`].text).version;
  assert.equal(json(join(home, ".oats/modules/oats.core/oats.json")).version, oldVersion, `the home runs oats.core ${oldVersion} from ${tag}`);
  assert.equal(Object.hasOwn(json(join(home, "instance.json")).capabilityMeta || {}, "oats.core"), false, "no released oats.core records meta");
  fx.commit({ ...packageFiles("2.0.0", treeFiles(join(ROOT, CORE))) });
  lock(fx, "2.0.0");
  return { fx, home, oldVersion,
    plan: opts => fx.inEnv(() => planUpgrade(fx.dep, fx.root, "seat", { remoteOptions: fx.remoteOptions, ...opts })),
    apply: opts => fx.inEnv(() => applyUpgrade(fx.dep, fx.root, "seat", { remoteOptions: fx.remoteOptions, ...opts })),
  };
}
const coreRow = plan => plan.modules.find(m => m.capability === "oats.core");
/** oats.core's waiting-hook commands in the home's Claude settings. */
function waitingCommands(home) {
  const settings = json(join(home, ".claude/settings.json"));
  return Object.values(settings.hooks).flat().flatMap(g => g.hooks).map(h => h.command).filter(c => c.includes("claude-waiting.sh"));
}

for (const tag of ["oats-framework/v1.4.1", "oats-framework/v1.8.0", "oats-framework/v1.14.1"]) {
  test(`oats.core upgrade: a Claude home spawned on ${tag} plans adopt, applies and starts on this oats.core`, { timeout: 240_000 }, async t => {
    const { fx, home, oldVersion, plan, apply } = await releasedHome(t, tag);
    const script = join(realpathSync(home), ".oats/modules/oats.core/bin/claude-waiting.sh");
    // What a real home of that release holds: the waiting hooks only once oats.core had them.
    const spawnedWithHooks = (() => { try { return waitingCommands(home).length > 0; } catch { return false; } })();
    assert.equal(spawnedWithHooks, tag !== "oats-framework/v1.4.1", `${tag}'s spawn wrote oats.core's settings entries iff that oats.core had hooks`);
    const shown = await plan();
    assert.equal(coreRow(shown).provider.decision, "adopt", JSON.stringify(coreRow(shown).provider));
    const result = await apply({ planRevision: shown.planRevision, idempotencyKey: "core-move" });
    assert.equal(result.status, "complete");
    const meta = json(join(home, "instance.json"));
    assert.equal(json(join(home, ".oats/modules/oats.core/oats.json")).version, json(join(ROOT, CORE, "oats.json")).version);
    assert.equal(meta.modules["oats.core"].previous.from.version, "1.0.0", `the previous copy (oats.core ${oldVersion}) is kept`);
    assert.deepEqual(meta.capabilityMeta["oats.core"], {}, "apply carries the empty meta unchanged");

    // The next start composes on the moved module: its launch hook writes the settings anew.
    execFileSync("tmux", ["-S", oatsSocket(fx.env.TMUX_TMPDIR), "new-session", "-d", "-s", fx.env.OATS_TMUX_SESSION, "-n", "hq", "-c", fx.base], { env: fx.env, stdio: "ignore" });
    // (The recorded harness is the fixture's inert `claude`: releasedHome spawned with the fixture's PATH.)
    writeFixtureExecutable(fx.base, meta.launch.executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.300 (Claude Code)'; exit 0; fi\nexec sleep 600\n");
    const started = fx.cli(["session", "start", "--home", home, "--json"]);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    assert.deepEqual(started.json().result.warnings.filter(w => w.includes("oats.core")), [], "oats.core's launch hook ran clean");
    assert.equal(json(join(home, "instance.json")).launched, true);
    const commands = waitingCommands(home);
    assert.ok(commands.length > 0, "the start wrote oats.core's waiting hooks");
    assert.ok(commands.every(c => c.includes(script)), "every waiting hook names the home's moved module copy");
    // The session ends with the fixture's own tmux server, at its cleanup.
  });
}

for (const [label, recorded] of [["a non-empty object", { team: "t:example" }], ["an array", [1]], ["a string", "core"]]) {
  test(`oats.core upgrade: recorded oats.core meta that is ${label} refuses with the respawn remedy`, { timeout: 240_000 }, async t => {
    const { home, plan, apply } = await releasedHome(t, "oats-framework/v1.14.1");
    const file = join(home, "instance.json"), meta = json(file);
    meta.capabilityMeta = { ...(meta.capabilityMeta || {}), "oats.core": recorded };
    writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
    const before = readFileSync(file, "utf8");
    const shown = await plan();
    const provider = coreRow(shown).provider;
    assert.equal(provider.decision, "refuse");
    assert.match(provider.reason, /OATS_META/);
    assert.equal(provider.remedy, "respawn the instance: oats retire seat, then oats spawn");
    await assert.rejects(apply({ planRevision: shown.planRevision, idempotencyKey: "refused" }), e => e.code === "E_UPGRADE_REFUSED" && e.message.includes("oats retire seat, then oats spawn"));
    assert.equal(readFileSync(file, "utf8"), before, "a refused move leaves the record alone");
  });
}

test("oats.core upgrade: recorded oats.core meta that is null reaches the hook as {} (the kernel's OATS_META), so it adopts and becomes {}", { timeout: 240_000 }, async t => {
  const { home, plan, apply } = await releasedHome(t, "oats-framework/v1.14.1");
  const file = join(home, "instance.json"), meta = json(file);
  meta.capabilityMeta = { ...(meta.capabilityMeta || {}), "oats.core": null };
  writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
  const shown = await plan();
  assert.equal(coreRow(shown).provider.decision, "adopt", JSON.stringify(coreRow(shown).provider));
  assert.equal((await apply({ planRevision: shown.planRevision, idempotencyKey: "null-meta" })).status, "complete");
  assert.deepEqual(json(file).capabilityMeta["oats.core"], {});
});

/** The hook as the kernel runs it for an upgrade phase. */
function upgradeHook(env) {
  const r = spawnSync(process.execPath, [HOOK, "upgrade"], { env: { PATH: process.env.PATH, OATS_EVENT: "upgrade", OATS_INSTANCE: "seat", ...env }, encoding: "utf8" });
  return { status: r.status, answer: JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) || "null"), stderr: r.stderr };
}

test("oats.core upgrade hook: plan adopts the empty meta and apply returns it unchanged", () => {
  assert.deepEqual(upgradeHook({ OATS_UPGRADE_PHASE: "plan", OATS_META: "{}" }), { status: 0, answer: { adopt: true }, stderr: "" });
  assert.deepEqual(upgradeHook({ OATS_UPGRADE_PHASE: "apply", OATS_META: "{}" }), { status: 0, answer: { meta: {} }, stderr: "" });
});

test("oats.core upgrade hook: malformed meta refuses at plan and fails apply with a warning", () => {
  for (const meta of ["not json", "[]", "\"core\"", "null", "{\"team\":\"t\"}", undefined]) {
    const env = meta === undefined ? {} : { OATS_META: meta };
    const planned = upgradeHook({ OATS_UPGRADE_PHASE: "plan", ...env });
    assert.equal(planned.status, 0, `plan answers, never fails (${meta})`);
    assert.equal(planned.answer.adopt, false);
    assert.match(planned.answer.reason, /OATS_META/);
    assert.equal(planned.answer.remedy, "respawn the instance: oats retire seat, then oats spawn");
    const applied = upgradeHook({ OATS_UPGRADE_PHASE: "apply", ...env });
    assert.equal(applied.status, 1, `apply fails (${meta})`);
    assert.match(applied.answer.warning, /^oats\.core: .*OATS_META/);
    assert.equal(applied.answer.meta, undefined);
  }
});

test("oats.core upgrade hook: an unknown phase fails with a warning", () => {
  for (const phase of [undefined, "", "commit"]) {
    const r = upgradeHook({ ...(phase === undefined ? {} : { OATS_UPGRADE_PHASE: phase }), OATS_META: "{}" });
    assert.equal(r.status, 1);
    assert.match(r.answer.warning, /OATS_UPGRADE_PHASE must be plan or apply/);
  }
});
