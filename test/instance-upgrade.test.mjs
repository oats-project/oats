/** Package upgrades use real committed package trees and spawned scratch homes. Provider
 * hooks leave adoption evidence in the home, so rollback and forward-only retries are
 * checked against effects rather than a mocked composer or lifecycle implementation. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { killAndReap, oatsSocket } from "./helpers/host-fixture.mjs";
import { join } from "node:path";
import { CLI, v2Deployment, git } from "./helpers/v2-deployment.mjs";
import { runFaulted, startGated } from "./helpers/fs-gate-preload.mjs";
import { recordLaunch } from "./helpers/recorded-tmux-server.mjs";
import { contentDigest } from "../lib/remote.mjs";
import { readLock, writeLock } from "../lib/packages.mjs";
import { planUpgrade, applyUpgrade } from "../lib/instance-upgrade.mjs";
import { claimHomeFor, homeClaimHolder, releaseHomeClaim, retirementBaselinePath, writeRetirementBaseline, retireInstance, startInstanceSession } from "../lib/core.mjs";
import { readEvents } from "../lib/instance-events.mjs";
import { readInstanceBackground, writeInstanceBackground } from "../lib/instance-background.mjs";
import { readSameWork, writeSameWork } from "../lib/instance-same-work.mjs";

const json = p => JSON.parse(readFileSync(p, "utf8"));
function pkg(version, mode = "adopt", names = ["acme.one"], launch = false) {
  const files = { "oats-package/oats-package.json": { json: { package: "acme.pkg", version, capabilities: names.map(n => "capabilities/" + n) } } };
  for (const name of names) {
    const behavior = typeof mode === "object" ? mode[name] ?? "adopt" : mode;
    const base = "oats-package/capabilities/" + name;
    const launches = typeof launch === "object" ? launch[name] === true : launch;
    const envName = "ACME_UPGRADE_" + name.toUpperCase().replaceAll(".", "_");
    const hooks = { retire: "retire.mjs", ...(behavior === "no-upgrade" ? {} : { upgrade: "upgrade.mjs" }), ...(launches ? { spawn: "spawn.mjs", launch: "launch.mjs" } : {}) };
    files[base + "/oats.json"] = { json: { capability: name, version, description: "Fixture capability", skills: ["skills"], inject: "inject.md", hooks, ...(launches ? { environment: [envName] } : {}) } };
    if (launches) {
      const answer = { meta: { version }, launch: { claude: "--fixture-" + name + "-" + version }, env: { [envName]: version } };
      files[base + "/spawn.mjs"] = "console.log(" + JSON.stringify(JSON.stringify(answer)) + ");";
      files[base + "/launch.mjs"] = "console.log(" + JSON.stringify(JSON.stringify(answer)) + ");";
    }
    files[base + "/skills/" + name + "/SKILL.md"] = "---\nname: " + name + "\ndescription: fixture\n---\n" + version;
    files[base + "/inject.md"] = "Instructions " + name + " " + version;
    files[base + "/retire.mjs"] = "console.log(JSON.stringify({meta:{retired:true}}));";
    files[base + "/upgrade.mjs"] = `import fs from 'node:fs'; import path from 'node:path';
if (process.env.OATS_EVENT !== 'upgrade') process.exit(2);
if (process.env.OATS_UPGRADE_PHASE === 'plan') console.log(JSON.stringify(${behavior === "refuse" ? "{adopt:false,reason:'cannot adopt',remedy:'respawn'}" : "{adopt:true}"}));
else {
  if (${JSON.stringify(behavior)} === 'fail' && !fs.existsSync(path.join(process.env.OATS_INSTANCE_HOME, 'allow'))) process.exit(1);
  const p = path.join(process.env.OATS_INSTANCE_HOME, 'adopt-' + process.env.OATS_CAPABILITY);
  if (${JSON.stringify(behavior)} === 'succeed-once' && fs.existsSync(p) && !fs.existsSync(path.join(process.env.OATS_INSTANCE_HOME, 'allow'))) process.exit(1);
  fs.appendFileSync(p, '${version}\\n');
  console.log(JSON.stringify({meta:{version:'${version}',before:JSON.parse(process.env.OATS_META),from:JSON.parse(process.env.OATS_UPGRADE_FROM),to:JSON.parse(process.env.OATS_UPGRADE_TO)}}));
}
`;
  }
  return files;
}
function lock(fx, version) {
  const commit = git(fx.member, "rev-parse", "HEAD");
  const capabilities = json(join(fx.member, "oats-package/oats-package.json")).capabilities.map(p => p.split("/").at(-1));
  const entry = { source: `git:${fx.key}@main`, url: fx.ref, path: "oats-package", version, commit, integrity: contentDigest(join(fx.member, "oats-package")), capabilities };
  writeLock(fx.dep, { lockfileVersion: 3, packages: { "acme.pkg": entry } });
  return entry;
}
async function fixture(t, { names = ["acme.one"], oldMode = "adopt", nextMode = "adopt", memberModule = false, oldLaunch = false, nextLaunch = false, workMode = "directory" } = {}) {
  const fx = v2Deployment({ t,
    souls: { dev: { soul: { work: workMode, capabilities: Object.fromEntries([["oats.core", "off"], ...names.map(n => [n, { from: "package" }]), ...(memberModule ? [["local.style", { from: "here" }]] : [])]) }, skills: { "soul-guide": { text: "Keep this recorded soul skill." } } } },
    files: pkg("1.0.0", oldMode, names, oldLaunch),
    capabilities: memberModule ? { "local.style": { manifest: { inject: "inject.md" }, files: { "inject.md": "Recorded member instructions." } } } : {},
  });
  fx.commit({ "oats-workspace.yaml": { yaml: { schemaVersion: 2, name: "fixture", members: [fx.ref], defaults: { knowledge: "none", messaging: "none", tasks: "none" }, packages: { "acme.pkg": `git:${fx.key}@main` } } } });
  const old = lock(fx, "1.0.0");
  const { home } = await fx.spawn("dev", { name: "seat", noLaunch: true });
  fx.commit(pkg("2.0.0", nextMode, names, nextLaunch));
  const next = lock(fx, "2.0.0");
  return { fx, home, old, next,
    plan: opts => fx.inEnv(() => planUpgrade(fx.dep, fx.root, "seat", { remoteOptions: fx.remoteOptions, ...opts })),
    apply: opts => fx.inEnv(() => applyUpgrade(fx.dep, fx.root, "seat", { remoteOptions: fx.remoteOptions, ...opts })),
  };
}
const composed = home => ({
  modules: contentDigest(join(home, ".oats/modules"), { allowSymlinks: () => true }),
  skills: contentDigest(join(home, ".agents/skills"), { allowSymlinks: () => true }),
  agents: readFileSync(join(home, "AGENTS.md"), "utf8"),
  instance: readFileSync(join(home, "instance.json"), "utf8"),
});
function noStaging(home) {
  assert.ok(!readdirSync(join(home, ".oats")).some(n => n.startsWith(".staging-upgrade-")), "no abandoned upgrade staging");
}
function normalized(value, home, soulDir = json(join(home, "instance.json")).soulDir) {
  if (typeof value === "string") return (typeof soulDir === "string" && soulDir ? value.replaceAll(soulDir, "<recorded-soul>") : value).replaceAll(home, "<home>");
  if (Array.isArray(value)) return value.map(v => normalized(v, home, soulDir));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !["materializedAt", "previous"].includes(k)).map(([k, v]) => [k, normalized(v, home, soulDir)]));
  return value;
}

test("package upgrade acceptance: read-only plan; whole-module apply, replay and undo", async t => {
  const f = await fixture(t); const { fx, home, old, next } = f;
  const before = contentDigest(home, { allowSymlinks: () => true });
  const oldModuleBytes = contentDigest(join(home, ".oats/modules"));
  const oldSkillBytes = contentDigest(join(home, ".agents/skills"));
  const plan = await f.plan();
  assert.equal(contentDigest(home, { allowSymlinks: () => true }), before, "planning writes no home bytes");
  assert.equal((await f.plan()).planRevision, plan.planRevision, "unchanged facts produce the same revision");
  assert.equal(plan.modules[0].from.commit, old.commit);
  assert.deepEqual(plan.modules[0].to, { version: next.version, commit: next.commit, integrity: next.integrity });
  assert.deepEqual(plan.modules[0].skills.changed, ["acme.one"]);
  assert.equal(plan.modules[0].inject, true);
  const result = await f.apply({ planRevision: plan.planRevision, idempotencyKey: "move" });
  assert.equal(result.status, "complete");
  const meta = json(join(home, "instance.json"));
  assert.equal(meta.modules["acme.one"].commit, next.commit);
  assert.equal(meta.modules["acme.one"].previous.commit, old.commit);
  assert.equal(meta.modules["acme.one"].digest, contentDigest(join(home, ".oats/modules/acme.one")));
  assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /Instructions acme.one 2.0.0/);
  assert.match(readFileSync(join(home, ".agents/skills/acme.one/SKILL.md"), "utf8"), /2.0.0/);
  assert.match(readFileSync(join(home, ".agents/skills/soul-guide/SKILL.md"), "utf8"), /recorded soul skill/);
  assert.ok(meta.capabilityRuntime[0].hooks.retire.includes(join(home, ".oats/modules/acme.one/retire.mjs")));
  assert.equal(meta.capabilityMeta["acme.one"].version, "2.0.0");
  assert.equal(meta.capabilityMeta["acme.one"].from.commit, old.commit);
  assert.deepEqual(meta.capabilityMeta["acme.one"].to, next, "hook receives the full locked entry");
  noStaging(home);
  assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1);
  const fresh = await fx.spawn("dev", { name: "fresh", noLaunch: true });
  const freshMeta = json(join(fresh.home, "instance.json"));
  assert.equal(contentDigest(join(home, ".agents/skills")), contentDigest(join(fresh.home, ".agents/skills")), "skill copies match a spawn at the lock");
  assert.equal(normalized(readFileSync(join(home, "AGENTS.md"), "utf8"), home), normalized(readFileSync(join(fresh.home, "AGENTS.md"), "utf8"), fresh.home));
  for (const field of ["modules", "capabilities", "capabilityRuntime", "skills", "instructions", "composition"]) {
    assert.deepEqual(normalized(meta[field], home), normalized(freshMeta[field], fresh.home), field + " matches fresh composition");
  }
  assert.deepEqual(normalized(meta.launch?.hooks?.contributions, home), normalized(freshMeta.launch?.hooks?.contributions, fresh.home));
  const replay = await f.apply({ planRevision: plan.planRevision, idempotencyKey: "move" });
  assert.equal(replay.replayed, true);
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
  assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1, "replay emits no second event");
  const undo = await f.plan({ undo: true });
  await f.apply({ undo: true, planRevision: undo.planRevision, idempotencyKey: "undo" });
  assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, old.commit);
  assert.match(readFileSync(join(home, ".agents/skills/acme.one/SKILL.md"), "utf8"), /1.0.0/);
  assert.equal(contentDigest(join(home, ".oats/modules")), oldModuleBytes, "undo restores the previous module bytes");
  assert.equal(contentDigest(join(home, ".agents/skills")), oldSkillBytes, "undo restores the previous skill copies");
});

test("package upgrade acceptance: the recomposed AGENTS.md keeps the home's recorded capability order and puts the kernel's blocks last", async t => {
  // The soul lists acme.two before acme.one; name order is the reverse.
  const f = await fixture(t, { names: ["acme.two", "acme.one"] }); const { fx, home } = f;
  const markers = h => [...readFileSync(join(h, "AGENTS.md"), "utf8").matchAll(/^<!-- oats:(\S+) src=/gm)].map(m => m[1]);
  const kernel = ["kernel:instance-boundary", "work-mode:directory"];
  assert.deepEqual(markers(home), ["capability:acme.two", "capability:acme.one", ...kernel], "spawn: the soul's order, kernel last");
  // A home spawned before this order: its record (and file) put the kernel's blocks first and the capabilities by name.
  const meta = json(join(home, "instance.json"));
  const byName = ["capability:acme.one", "capability:acme.two"].map(source => meta.instructions.find(b => b.source === source));
  const kernelRows = meta.instructions.filter(b => kernel.includes(b.source));
  meta.instructions = [...kernelRows, ...byName];
  writeFileSync(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
  const plan = await f.plan();
  assert.equal((await f.apply({ planRevision: plan.planRevision, idempotencyKey: "order" })).status, "complete");
  const order = ["capability:acme.one", "capability:acme.two", ...kernel];
  assert.deepEqual(markers(home), order, "the recorded capability order, not the soul's; the kernel's blocks last");
  const after = json(join(home, "instance.json"));
  assert.deepEqual(after.instructions.map(b => b.source), order, "instance.json instructions");
  assert.deepEqual(after.composition.materialized.instructions.map(b => b.source), order);
  assert.deepEqual(after.composition.expected.filter(r => r.type === "instruction-block").map(r => r.source), order, "composition.expected");
  assert.deepEqual(Object.keys(after.modules), ["acme.one", "acme.two"], "modules keep name order");
  // A fresh spawn at the lock composes in the soul's order.
  const fresh = await fx.spawn("dev", { name: "fresh", noLaunch: true });
  assert.deepEqual(markers(fresh.home), ["capability:acme.two", "capability:acme.one", ...kernel]);
});

test("package upgrade acceptance: refusal and stale plans leave composed bytes alone", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const plan = await f.plan(), before = composed(home);
  fx.commit(pkg("3.0.0", "refuse")); lock(fx, "3.0.0");
  await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "stale" }), e => e.code === "E_PLAN_STALE" && !!e.plan);
  const refused = await f.plan();
  assert.equal(refused.modules[0].provider.decision, "refuse");
  assert.match(refused.modules[0].provider.reason, /cannot adopt/);
  await assert.rejects(f.apply({ planRevision: refused.planRevision, idempotencyKey: "refused" }), e => e.code === "E_UPGRADE_REFUSED");
  assert.deepEqual(composed(home), before);
  assert.ok(!existsSync(join(home, "adopt-acme.one")));
  assert.ok(!existsSync(join(home, ".oats/previous")));
  noStaging(home);
});

test("package upgrade acceptance: first failed apply hook rolls back before adoption", async t => {
  const f = await fixture(t, { nextMode: "fail" }); const { home } = f;
  const before = composed(home), plan = await f.plan();
  await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "first-fails" }), e => e.code === "E_UPGRADE_REFUSED");
  assert.deepEqual(composed(home), before);
  assert.ok(!existsSync(join(home, "adopt-acme.one")));
  assert.ok(!existsSync(join(home, ".oats/previous")));
  noStaging(home);
});

test("package upgrade acceptance: later failure is partial and retry runs only pending hooks", async t => {
  const f = await fixture(t, { names: ["acme.one", "acme.two"], nextMode: { "acme.two": "fail" } }); const { fx, home, old } = f;
  const plan = await f.plan();
  await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "partial" }), e => e.code === "E_UPGRADE_PARTIAL" && /partial/.test(e.message));
  await assert.rejects(fx.inEnv(() => startInstanceSession(home)), e => e.code === "E_UPGRADE_PARTIAL" && /partial/.test(e.message));
  assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, old.commit, "all copies remain staged until every hook adopts");
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
  assert.ok(!existsSync(join(home, "adopt-acme.two")));
  writeFileSync(join(home, "allow"), "yes");
  const done = await f.apply({ planRevision: plan.planRevision, idempotencyKey: "partial" });
  assert.equal(done.status, "complete");
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n", "successful hook is not rerun");
  assert.equal(readFileSync(join(home, "adopt-acme.two"), "utf8"), "2.0.0\n");
  assert.equal(json(join(home, "instance.json")).modules["acme.two"].from.version, "2.0.0");
  assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1);
  noStaging(home);
});

test("package upgrade acceptance: running and unreadable sessions refuse at plan and apply", async t => {
  const f = await fixture(t); const { home, fx } = f;
  const plan = await f.plan();
  recordLaunch(home, "seat", join(fx.base, "private-socket"));
  const before = composed(home);
  for (const state of ["running", "unreadable"]) {
    const io = { exec: (bin, args) => {
      assert.equal(bin, "tmux"); assert.ok(args.includes("list-panes"), "inspection alone is permitted");
      if (state === "unreadable") throw Object.assign(new Error("cannot inspect"), { stderr: "Permission denied" });
      return "%1\t0\tfixture-agent\t999999\t80\t24\n";
    } };
    const refusal = e => e.code === "E_SESSION_RUNNING" && /oats instance stop seat/.test(e.message);
    await assert.rejects(f.plan({ io }), refusal);
    await assert.rejects(f.apply({ io, planRevision: plan.planRevision, idempotencyKey: state }), refusal);
    assert.deepEqual(composed(home), before);
  }
  noStaging(home);
});

test("package upgrade acceptance: locked package integrity is verified before any adoption", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const plan = await f.plan(), before = composed(home), locked = readLock(fx.dep);
  locked.packages["acme.pkg"].integrity = "sha256-" + "0".repeat(64);
  writeLock(fx.dep, locked);
  await assert.rejects(f.plan(), e => e.code === "E_PACKAGE_INTEGRITY");
  await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "bad-integrity" }), e => e.code === "E_PACKAGE_INTEGRITY");
  assert.deepEqual(composed(home), before);
  assert.ok(!existsSync(join(home, "adopt-acme.one")));
  noStaging(home);
});

test("package upgrade acceptance: undo refuses a previous version without adoption hook", async t => {
  const f = await fixture(t, { oldMode: "no-upgrade" }); const { home } = f;
  const plan = await f.plan();
  await f.apply({ planRevision: plan.planRevision, idempotencyKey: "move" });
  const before = composed(home), undo = await f.plan({ undo: true });
  assert.equal(undo.modules[0].provider.decision, "refuse");
  assert.match(undo.modules[0].provider.reason, /upgrade hook.*respawn/);
  await assert.rejects(f.apply({ undo: true, planRevision: undo.planRevision, idempotencyKey: "undo-refused" }), e => e.code === "E_UPGRADE_REFUSED");
  assert.deepEqual(composed(home), before);
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
});

test("package upgrade acceptance: undo needs a retained verified previous copy", async t => {
  const f = await fixture(t); const { home } = f;
  const plan = await f.plan();
  await f.apply({ planRevision: plan.planRevision, idempotencyKey: "move" });
  const undo = await f.plan({ undo: true });
  const previous = json(join(home, "instance.json")).modules["acme.one"].previous;
  const backup = join(home, ".oats/previous", previous.receipt);
  writeFileSync(join(backup, "modules/acme.one/inject.md"), "tampered");
  await assert.rejects(f.plan({ undo: true }), e => e.code === "E_UPGRADE_UNDO");
  rmSync(backup, { recursive: true });
  const before = composed(home);
  await assert.rejects(f.plan({ undo: true }), e => e.code === "E_UPGRADE_UNDO");
  await assert.rejects(f.apply({ undo: true, planRevision: undo.planRevision, idempotencyKey: "lost-undo" }), e => e.code === "E_UPGRADE_UNDO");
  assert.deepEqual(composed(home), before);
});

test("package upgrade acceptance: retire after completed upgrade and receipt replay sees no unexplained home changes", async t => {
  const f = await fixture(t); const { fx, home } = f;
  // Feature instance-background: the record is presentation, kept by the upgrade and never work at retire.
  writeInstanceBackground(home, true);
  const plan = await f.plan();
  await f.apply({ planRevision: plan.planRevision, idempotencyKey: "baseline" });
  await f.apply({ planRevision: plan.planRevision, idempotencyKey: "baseline" });
  assert.equal(readInstanceBackground(home), true, "the upgrade keeps the background record");
  const receipt = readdirSync(join(home, ".oats")).find(n => /^upgrade-receipt\..+\.json$/.test(n));
  assert.ok(receipt, "completed upgrade has a durable receipt");
  const path = join(home, ".oats", receipt);
  writeFileSync(path, JSON.stringify(json(path), null, 4) + "\n", { mode: 0o600 });
  const retired = await fx.inEnv(() => retireInstance(fx.root, "seat", { tmuxSession: "oats-test-nosuch" }));
  assert.equal(retired.workRecovery?.classes?.includes("changed instance-home bytes") ?? false, false, JSON.stringify(retired.workRecovery));
  assert.equal(retired.removedDir, true);
});

test("package upgrade acceptance: state requires adoption but a stateless skills module needs no hook", async t => {
  const f = await fixture(t, { oldMode: "no-upgrade", nextMode: "no-upgrade" }); const { home, next } = f;
  const file = join(home, "instance.json"), original = json(file);
  writeFileSync(file, JSON.stringify({ ...original, capabilityMeta: { "acme.one": { providerState: true } } }, null, 2) + "\n");
  const refused = await f.plan();
  assert.equal(refused.modules[0].provider.decision, "refuse");
  assert.match(refused.modules[0].provider.reason, /upgrade hook.*respawn/);
  await assert.rejects(f.apply({ planRevision: refused.planRevision, idempotencyKey: "state-refused" }), e => e.code === "E_UPGRADE_REFUSED");
  writeFileSync(file, JSON.stringify(original, null, 2) + "\n");
  const plan = await f.plan();
  assert.equal(plan.modules[0].provider.decision, "adopt");
  const result = await f.apply({ planRevision: plan.planRevision, idempotencyKey: "stateless" });
  assert.equal(result.status, "complete");
  assert.equal(json(file).modules["acme.one"].commit, next.commit);
  assert.ok(!existsSync(join(home, "adopt-acme.one")), "no provider hook ran for stateless content");
  noStaging(home);
});


test("package upgrade acceptance: source soul and member changes remain frozen during a package move", async t => {
  const f = await fixture(t, { memberModule: true }); const { fx, home } = f;
  const before = json(join(home, "instance.json"));
  const member = before.modules["local.style"];
  const soulSkill = readFileSync(join(home, ".agents/skills/soul-guide/SKILL.md"), "utf8");
  fx.commit({ "souls/dev/AGENTS.md": "# Changed source soul\n", "capabilities/local.style/inject.md": "Changed source member instructions." });
  lock(fx, "2.0.0");
  const plan = await f.plan();
  assert.deepEqual(plan.modules.map(m => m.capability), ["acme.one"]);
  assert.ok(plan.kept.some(m => m.capability === "local.style" && /member/.test(m.reason)));
  assert.ok(plan.memberDrift.some(m => m.module === "local.style" && m.status === "moved"));
  await f.apply({ planRevision: plan.planRevision, idempotencyKey: "frozen" });
  const after = json(join(home, "instance.json"));
  assert.deepEqual(after.workspace.soul, before.workspace.soul, "recorded soul commit stays fixed");
  assert.deepEqual(after.modules["local.style"], member, "member source record and timestamps stay fixed");
  assert.equal(contentDigest(join(home, ".oats/modules/local.style")), member.digest);
  assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /^# dev\n/);
  assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /Recorded member instructions/);
  assert.doesNotMatch(readFileSync(join(home, "AGENTS.md"), "utf8"), /Changed source/);
  assert.equal(readFileSync(join(home, ".agents/skills/soul-guide/SKILL.md"), "utf8"), soulSkill);
});


test("package upgrade acceptance: lifecycle claims exclude plan and apply without disturbing their holder", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const plan = await f.plan(), before = composed(home);
  for (const action of ["upgrade", "stop", "retire"]) {
    const held = await fx.inEnv(() => claimHomeFor(action, "seat", home));
    try {
      const code = action === "retire" ? "E_INSTANCE_RETIRING" : "E_LIFECYCLE_BUSY";
      await assert.rejects(f.plan(), e => e.code === code, action + " excludes a plan");
      await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "claim-" + action }), e => e.code === code, action + " excludes apply");
      const holder = await fx.inEnv(() => homeClaimHolder(home));
      assert.equal(holder.action, action);
      assert.equal(holder.holder.nonce, held.me.nonce, "a refused upgrade never releases another act's claim");
      assert.deepEqual(composed(home), before);
    } finally {
      await fx.inEnv(() => releaseHomeClaim(held));
    }
    assert.equal(await fx.inEnv(() => homeClaimHolder(home)), null);
  }
  assert.equal((await f.plan()).planRevision, plan.planRevision);
  noStaging(home);
});

test("package upgrade acceptance: CLI text and JSON plan and apply operate on the scratch deployment", async t => {
  const f = await fixture(t); const { fx, home, old, next } = f;
  const before = composed(home);
  const text = fx.cli(["instance", "upgrade", "seat", "--plan"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  const revision = text.stdout.match(/package upgrade seat: plan ([a-f0-9]{24})/);
  assert.ok(revision, text.stdout);
  assert.match(text.stdout, /home changed since spawn: no/);
  assert.match(text.stdout, /acme\.one: 1\.0\.0 @ [a-f0-9]+ → 2\.0\.0 @ [a-f0-9]+/);
  assert.ok(text.stdout.includes("--plan-revision " + revision[1] + " --idempotency-key <key>"));
  const planned = fx.cli(["instance", "upgrade", "seat", "--plan", "--json"]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const envelope = planned.json();
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.result.planRevision, revision[1]);
  assert.equal(envelope.result.home, home);
  assert.equal(envelope.result.modules[0].from.commit, old.commit);
  assert.equal(envelope.result.modules[0].to.commit, next.commit);
  assert.deepEqual(composed(home), before, "both CLI planning modes are read-only");
  const args = ["instance", "upgrade", "seat", "--plan-revision", revision[1], "--idempotency-key", "cli-roundtrip"];
  const applied = fx.cli([...args, "--json"]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(applied.json().ok, true);
  assert.equal(applied.json().result.status, "complete");
  const replay = fx.cli(args);
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  assert.match(replay.stdout, /package upgrade seat: complete \(replayed receipt\)/);
  assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, next.commit);
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
  noStaging(home);
});

for (const point of ["swap", "metadata", "baseline"]) {
  test("package upgrade acceptance: " + point + " write failure after adoption resumes forward in another process", async t => {
    const f = await fixture(t); const { fx, home, next } = f;
    const plan = await f.plan(), key = "fault-" + point;
    const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", key, "--json"];
    // Fail between the two AGENTS.md renames, when modules/skills are already
    // new but the final instruction path is absent. This is a recoverable
    // transaction boundary, so retry must reopen staging before checking the
    // temporarily incomplete published composition. The metadata fault likewise
    // removes the old instance.json before failing its replacement rename; retry
    // recovers identity through the receipt. A baseline fault occurs after the
    // complete swap and must retain that new composition as well.
    const gate = point === "baseline"
      ? { name: point, fn: "renameSync", arg: 1, path: retirementBaselinePath(home), throws: "ENOSPC" }
      : { name: point, fn: "renameSync", arg: 1, path: join(home, point === "metadata" ? "instance.json" : "AGENTS.md"), throws: "EIO" };
    const failed = runFaulted(args, { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "faults-" + point), gates: [{ ...gate, armed: join(home, "adopt-acme.one") }] });
    assert.deepEqual(failed.fired, [point], "the intended filesystem operation failed");
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.equal(failed.json().error.code, "E_UPGRADE_PARTIAL", failed.stdout + failed.stderr);
    assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
    const receipt = json(join(home, ".oats", "upgrade-receipt." + key + ".json"));
    assert.equal(receipt.status, "partial");
    assert.deepEqual(receipt.steps.hooks, ["acme.one"]);
    assert.equal(receipt.step, point === "metadata" ? "swap" : point);
    if (point === "metadata") assert.equal(existsSync(join(home, "instance.json")), false, "the fault opens the intended metadata gap");
    assert.equal(contentDigest(join(home, ".oats/modules/acme.one")), receipt.nextMeta.modules["acme.one"].digest, "adopted module bytes remain published");
    await assert.rejects(fx.inEnv(() => startInstanceSession(home)), e => e.code === "E_UPGRADE_PARTIAL");
    const retry = fx.cli(args.slice(1));
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(retry.json().result.status, "complete");
    assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n", "retry does not rerun the successful hook");
    assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, next.commit);
    assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /Instructions acme.one 2.0.0/);
    assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1);
    noStaging(home);
  });
}


test("package upgrade acceptance: consecutive moves prune removed launch contributions and undo restores the prior launch", async t => {
  const names = ["acme.one", "acme.two"];
  const f = await fixture(t, { names, oldLaunch: true, nextLaunch: true }); const { fx, home } = f;
  const spawned = json(join(home, "instance.json"));
  assert.deepEqual(spawned.launch.hooks.env, { ACME_UPGRADE_ACME_ONE: "1.0.0", ACME_UPGRADE_ACME_TWO: "1.0.0" });
  assert.deepEqual(spawned.launch.hooks.contributions.map(c => c.capability), names, "real spawn hooks supply the recorded contributions");
  const first = await f.plan();
  const movedA = await f.apply({ planRevision: first.planRevision, idempotencyKey: "launch-a" });
  assert.equal(movedA.status, "complete");
  const retained = json(join(home, "instance.json"));
  assert.deepEqual(retained.launch.hooks.env, spawned.launch.hooks.env, "a moved version with a launch hook keeps its contribution until the next start");
  assert.equal(retained.launch.hooks.launch.claude, spawned.launch.hooks.launch.claude);
  assert.deepEqual(retained.launch.hooks.contributions.map(c => c.capability), names);
  fx.commit(pkg("3.0.0", "adopt", names, { "acme.one": false, "acme.two": true }));
  const third = lock(fx, "3.0.0");
  const second = await f.plan();
  const movedB = await f.apply({ planRevision: second.planRevision, idempotencyKey: "launch-b" });
  assert.equal(movedB.status, "complete");
  const pruned = json(join(home, "instance.json"));
  assert.equal(pruned.modules["acme.one"].commit, third.commit);
  assert.deepEqual(pruned.launch.hooks.contributions.map(c => c.capability), ["acme.two"]);
  assert.deepEqual(pruned.launch.hooks.env, { ACME_UPGRADE_ACME_TWO: "1.0.0" }, "removed contribution loses its owned environment in the same swap");
  assert.equal(pruned.launch.hooks.launch.claude, "--fixture-acme.two-1.0.0", "aggregate args are recomputed from the remaining contribution");
  assert.equal(pruned.launched, false, "neither move starts the session");
  const undo = await f.plan({ undo: true });
  const restored = await f.apply({ undo: true, planRevision: undo.planRevision, idempotencyKey: "launch-undo" });
  assert.equal(restored.status, "complete");
  const afterUndo = json(join(home, "instance.json"));
  assert.deepEqual(afterUndo.launch.hooks, retained.launch.hooks, "undo restores contributions, owned values and aggregate args from previous instance.json");
  assert.equal(afterUndo.modules["acme.one"].commit, retained.modules["acme.one"].commit);
  assert.equal(afterUndo.launched, false);
  noStaging(home);
});

test("package upgrade acceptance: committed cleanup failure retries cleanup alone and fences another move", async t => {
  const f = await fixture(t); const { fx, home, next, old } = f;
  const plan = await f.plan(), key = "cleanup-committed";
  const receiptFile = join(home, ".oats", "upgrade-receipt." + key + ".json");
  const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", key, "--json"];
  // The preparatory removal happens before this receipt exists. Once the
  // receipt is written, refuse every staging cleanup attempt in this CLI
  // process; the retry runs without the preload in a fresh process.
  const failed = runFaulted(args, { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "faults-cleanup"), gates: [{
    name: "cleanup", fn: "rmSync", prefix: join(home, ".oats", ".staging-upgrade-"), armed: receiptFile, throws: "EACCES", every: true,
  }] });
  assert.deepEqual(failed.fired, ["cleanup"]);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.equal(failed.json().error.code, "E_UPGRADE_CLEANUP", failed.stdout + failed.stderr);
  assert.ok(failed.json().error.message.includes(key), "cleanup error names the original retry key");
  const committed = json(receiptFile);
  assert.equal(committed.status, "complete", "durable completion precedes staging cleanup");
  assert.equal(committed.steps.cleaned, false);
  assert.equal(committed.steps.swapped, true);
  assert.equal(committed.steps.baseline, true);
  assert.equal(committed.steps.event, true);
  assert.deepEqual(committed.steps.hooks, ["acme.one"]);
  assert.ok(existsSync(join(home, ".oats", ".staging-upgrade-" + committed.receipt)));
  let beforeCleanup = composed(home);
  assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, next.commit);
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
  assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1);
  for (const undo of [false, true]) {
    await assert.rejects(f.plan({ undo }), e => e.code === "E_UPGRADE_CLEANUP" && e.message.includes(key), "a new plan must finish the prior move's cleanup first");
  }
  // This is the actual committed home left by the failed process. A start
  // may use it before cleanup, and the same-key cleanup can run while its harness runs.
  execFileSync("tmux", ["-S", oatsSocket(fx.env.TMUX_TMPDIR), "new-session", "-d", "-s", fx.env.OATS_TMUX_SESSION, "-n", "hq", "-c", fx.base], { env: fx.env, stdio: "ignore" });
  const executable = json(join(home, "instance.json")).launch.executable;
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'pi fixture'; exit 0; fi\nexec sleep 600\n", { mode: 0o755 });
  const started = fx.cli(["session", "start", "--home", home, "--json"]);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.ok(started.json().result.warnings.some(w=>w.includes("staging cleanup remains")&&w.includes(key)));
  assert.equal(json(join(home, "instance.json")).launched, true);
  beforeCleanup = composed(home);
  const retry = fx.cli(args.slice(1));
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  const replay = retry.json();
  assert.equal(replay.ok, true);
  assert.equal(replay.result.status, "complete");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.steps.cleaned, true);
  assert.equal(json(receiptFile).steps.cleaned, true);
  assert.deepEqual(composed(home), beforeCleanup, "cleanup retry never rewrites the committed composition");
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n", "cleanup retry runs no provider hooks");
  assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1, "cleanup retry records no second move");
  noStaging(home);
  execFileSync("tmux", ["-S", oatsSocket(fx.env.TMUX_TMPDIR), "kill-window", "-t", `=${fx.env.OATS_TMUX_SESSION}:=seat`], { env: fx.env, stdio: "ignore" });
  const undo = await f.plan({ undo: true });
  assert.equal(undo.modules[0].to.commit, old.commit, "another move becomes available once cleanup completes");
});


for (const point of ["swap", "baseline"]) {
  test("package upgrade acceptance: stateless " + point + " failure restores composition and retirement baseline", async t => {
    const f = await fixture(t, { oldMode: "no-upgrade", nextMode: "no-upgrade" }); const { fx, home } = f;
    const before = composed(home), baselinePath = retirementBaselinePath(home), baseline = readFileSync(baselinePath);
    const plan = await f.plan(), key = "stateless-" + point;
    const receiptFile = join(home, ".oats", "upgrade-receipt." + key + ".json");
    const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", key, "--json"];
    // The receipt is written before the swap, even without provider hooks. Arm
    // there rather than on adoption evidence, which a stateless move never creates.
    const gate = point === "swap"
      ? { name: point, fn: "renameSync", arg: 1, path: join(home, "AGENTS.md"), throws: "EIO" }
      : { name: point, fn: "renameSync", arg: 1, path: baselinePath, throws: "ENOSPC" };
    const failed = runFaulted(args, { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "faults-stateless-" + point), gates: [{ ...gate, armed: receiptFile }] });
    assert.deepEqual(failed.fired, [point], "the intended operation failed after staging");
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.equal(failed.json().ok, false);
    assert.notEqual(failed.json().error.code, "E_UPGRADE_PARTIAL", "a move without successful provider hooks rolls back fully");
    assert.deepEqual(composed(home), before, "module roots, skills and both metadata files are restored exactly");
    assert.deepEqual(readFileSync(baselinePath), baseline, "the independent retirement baseline is restored byte for byte");
    assert.ok(!existsSync(join(home, "adopt-acme.one")));
    assert.ok(!existsSync(join(home, ".oats/previous")));
    assert.ok(!existsSync(join(home, ".oats-start.lock")));
    assert.ok(!existsSync(receiptFile), "a rolled-back attempt leaves no partial receipt");
    assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 0);
    noStaging(home);
    assert.equal((await f.plan()).planRevision, plan.planRevision, "the original move can be planned again after rollback");
  });
}

for (const mode of ["adopt", "no-upgrade"]) test("package upgrade regression: new declared skill and inject paths use the " + mode + " new tree", async t => {
  const f = await fixture(t, { oldMode: mode, nextMode: mode }); const { fx, home } = f;
  fx.commit({
    ...pkg("2.1.0"),
    "oats-package/capabilities/acme.one/oats.json": { json: { capability: "acme.one", version: "2.1.0", description: "Changed layout", skills: ["abilities"], inject: "instructions/new.md", hooks: { ...(mode === "adopt" ? { upgrade: "upgrade.mjs" } : {}), retire: "hooks/retire.mjs" } } },
    "oats-package/capabilities/acme.one/skills": null,
    "oats-package/capabilities/acme.one/abilities/new-guide/SKILL.md": "---\nname: new-guide\ndescription: New layout\n---\nNew layout skill.\n",
    "oats-package/capabilities/acme.one/instructions/new.md": "New layout instruction.",
    "oats-package/capabilities/acme.one/hooks/retire.mjs": "console.log('{}');",
  });
  lock(fx, "2.1.0");
  const plan = await f.plan();
  assert.deepEqual(plan.modules[0].skills.added, ["new-guide"]);
  assert.deepEqual(plan.modules[0].skills.removed, ["acme.one"]);
  await f.apply({ planRevision: plan.planRevision, idempotencyKey: "changed-layout" });
  assert.equal(existsSync(join(home, ".agents/skills/acme.one")), false);
  assert.match(readFileSync(join(home, ".agents/skills/new-guide/SKILL.md"), "utf8"), /New layout skill/);
  assert.match(readFileSync(join(home, "AGENTS.md"), "utf8"), /New layout instruction/);
  assert.ok(json(join(home, "instance.json")).capabilityRuntime[0].hooks.retire.includes("/hooks/retire.mjs"));
});


/** Every killed process belongs to this gated CLI. Never release a still-live
 * process on an assertion failure: terminate and reap it before fixture cleanup. */
async function killAtCheckpoint(run, name, inspect) {
  try {
    await run.waitGate(name);
    inspect();
    await killAndReap(run.child.pid);
    const exited = await run.done;
    assert.equal(exited.signal, "SIGKILL");
    assert.deepEqual(exited.timedOut, []);
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) await killAndReap(run.child.pid);
    await run.finish();
  }
}

test("package upgrade regression: killed short baseline write preserves session authority for same-key recovery", async t => {
  const f = await fixture(t); const { fx, home, next } = f;
  const baseline = retirementBaselinePath(home), original = readFileSync(baseline);
  const current = json(join(home, "instance.json"));
  assert.throws(() => writeRetirementBaseline(home, join(home, "work"), current.work, [], { launched: false }, { exclusive: true }), e => e.code === "EEXIST", "spawn's exclusive receipt creation still refuses an existing baseline");
  assert.deepEqual(readFileSync(baseline), original);
  const plan = await f.plan(), key = "short-baseline";
  const receiptFile = join(home, ".oats", "upgrade-receipt." + key + ".json");
  const marker = join(fx.base, "short-write-reached"), preload = join(fx.base, "short-baseline-write.mjs");
  // Simulate a write that opens its destination and writes only a prefix before
  // SIGKILL. Match both the old direct destination and its atomic private sibling.
  // This never touches a host file: both paths are in the scratch deployment.
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = function(path, bytes, options) {
  if (String(path).startsWith(${JSON.stringify(baseline)}) && fs.existsSync(${JSON.stringify(join(home, "adopt-acme.one"))})) {
    original.call(this, path, Buffer.from(bytes).subarray(0, 24), options);
    original(${JSON.stringify(marker)}, String(path));
    process.kill(process.pid, 'SIGKILL');
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
`);
  const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", key, "--json"];
  const scratch = killedCliScratch(fx);
  const killed = spawnSync(process.execPath, ["--import", preload, ...args], { cwd: fx.dep, env: scratch.env, encoding: "utf8", timeout: 30000 });
  assert.equal(killed.signal, "SIGKILL", killed.stdout + killed.stderr);
  assert.ok(existsSync(marker), "the replacement write was interrupted after its first bytes");
  scratch.assertClean();
  const receipt = json(receiptFile);
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.step, "baseline");
  assert.deepEqual(receipt.steps.hooks, ["acme.one"]);
  assert.deepEqual(readFileSync(join(home, ".oats", ".staging-upgrade-" + receipt.receipt, "retirement-baseline.json")), original, "the original independent authority remains saved in staging");
  const stillValid = readFileSync(baseline).equals(original);
  const retried = fx.cli(args.slice(1));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal(retried.json().result.status, "complete");
  assert.equal(stillValid, true, "an incomplete private write never truncates published session authority");
  assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, next.commit);
  assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n", "successful hook is never repeated");
  noStaging(home);
});

function killedCliScratch(fx) {
  const path = join(fx.base, "killed-cli-tmp");
  mkdirSync(path);
  return { path, env: { ...fx.env, TMPDIR: path },
    assertClean() { assert.deepEqual(readdirSync(path).filter(name => name.startsWith("oats-upgrade-plan-")), [], "planner scratch is discarded before resumable work begins"); } };
}

for (const checkpoint of ["before-hook", "after-hook"]) {
  test("package upgrade acceptance: killed " + checkpoint + " outcome remains uncertain across retry refusal", async t => {
    const f = await fixture(t, { nextMode: checkpoint === "after-hook" ? "succeed-once" : "fail" }); const { fx, home, next } = f;
    const plan = await f.plan(), key = "killed-" + checkpoint;
    const receiptFile = join(home, ".oats", "upgrade-receipt." + key + ".json"), adoption = join(home, "adopt-acme.one");
    const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", key, "--json"];
    // Initial receipt, then inFlight receipt, then acknowledged outcome. Kill
    // after publishing inFlight but before spawning, or before the acknowledged
    // outcome replaces it after the hook has already returned successfully.
    const scratch = killedCliScratch(fx);
    const gate = checkpoint === "before-hook"
      ? { name: checkpoint, fn: "renameSync", arg: 1, path: receiptFile, nth: 2, when: "after" }
      : { name: checkpoint, fn: "renameSync", arg: 1, path: receiptFile, armed: adoption };
    const run = startGated(args, { cwd: fx.dep, env: scratch.env, gateDir: join(fx.base, "gates-" + checkpoint), gates: [gate] });
    await killAtCheckpoint(run, checkpoint, () => {
      scratch.assertClean();
      const interrupted = json(receiptFile);
      assert.equal(interrupted.hooks.inFlight, "acme.one", "the durable receipt precedes invocation");
      assert.deepEqual(interrupted.steps.hooks, [], "no acknowledged outcome has been durably recorded");
      assert.equal(existsSync(adoption), checkpoint === "after-hook");
    });
    const retried = fx.cli(args.slice(1));
    assert.notEqual(retried.status, 0, retried.stdout + retried.stderr);
    assert.equal(retried.json().error.code, "E_UPGRADE_PARTIAL", "an uncertain prior outcome forbids rollback even when retry refuses");
    const uncertain = json(receiptFile);
    assert.equal(uncertain.status, "partial");
    assert.deepEqual(uncertain.uncertain, ["acme.one"]);
    assert.deepEqual(uncertain.steps.hooks, []);
    const staging = join(home, ".oats", ".staging-upgrade-" + uncertain.receipt);
    assert.ok(existsSync(staging), "retry refusal keeps the exact staged versions");
    assert.ok(existsSync(join(home, ".oats/previous", uncertain.receipt)), "previous-state evidence remains available");
    await assert.rejects(fx.inEnv(() => startInstanceSession(home)), e => e.code === "E_UPGRADE_PARTIAL");
    if (checkpoint === "after-hook") assert.equal(readFileSync(adoption, "utf8"), "2.0.0\n", "the retry refused before applying another effect");
    else assert.equal(existsSync(adoption), false, "conservative uncertainty also covers an invocation that never began");
    // A later integrity refusal has the same irreversible boundary. Restore only
    // the staged new version's fixture bytes, so the original act can finish.
    const stagedInject = join(staging, "modules/acme.one/inject.md"), inject = readFileSync(stagedInject);
    try {
      writeFileSync(stagedInject, "tampered staged bytes");
      const invalid = fx.cli(args.slice(1));
      assert.notEqual(invalid.status, 0, invalid.stdout + invalid.stderr);
      assert.equal(invalid.json().error.code, "E_UPGRADE_PARTIAL");
      assert.deepEqual(json(receiptFile).uncertain, ["acme.one"]);
      assert.ok(existsSync(staging));
      await assert.rejects(fx.inEnv(() => startInstanceSession(home)), e => e.code === "E_UPGRADE_PARTIAL");
    } finally {
      writeFileSync(stagedInject, inject);
    }
    writeFileSync(join(home, "allow"), "provider is ready to adopt");
    const completed = fx.cli(args.slice(1));
    assert.equal(completed.status, 0, completed.stdout + completed.stderr);
    assert.equal(completed.json().result.status, "complete");
    assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, next.commit);
    assert.equal(readFileSync(adoption, "utf8"), checkpoint === "after-hook" ? "2.0.0\n2.0.0\n" : "2.0.0\n");
    assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 1);
    noStaging(home);
  });
}

for (const checkpoint of ["empty-mutex", "first-receipt"]) {
  test("package upgrade acceptance: killed " + checkpoint + " owner is reclaimed without deleting its mutex by hand", async t => {
    const f = await fixture(t); const { fx, home, next } = f;
    const before = composed(home), plan = await f.plan(), key = "mutex-" + checkpoint;
    const mutex = join(home, ".oats-start.lock"), receiptFile = join(home, ".oats", "upgrade-receipt." + key + ".json");
    const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", key, "--json"];
    const scratch = killedCliScratch(fx);
    const gate = checkpoint === "empty-mutex"
      ? { name: checkpoint, fn: "openSync", path: mutex, when: "after" }
      : { name: checkpoint, fn: "renameSync", arg: 1, path: receiptFile };
    const run = startGated(args, { cwd: fx.dep, env: scratch.env, gateDir: join(fx.base, "gates-" + checkpoint), gates: [gate] });
    await killAtCheckpoint(run, checkpoint, () => {
      scratch.assertClean();
      assert.equal(lstatSync(mutex).isFile(), true, "the upgrade mutex is an exclusive regular file");
      assert.equal(existsSync(receiptFile), false, "the owner has not published its first receipt");
      if (checkpoint === "empty-mutex") assert.equal(readFileSync(mutex, "utf8"), "", "the process dies after creation and before writing owner bytes");
      else {
        const owner = json(mutex);
        assert.equal(owner.idempotencyKey, key);
        assert.equal(owner.planRevision, plan.planRevision);
        assert.equal(owner.undo, false);
      }
      assert.deepEqual(composed(home), before);
    });
    assert.equal(lstatSync(mutex).isFile(), true, "SIGKILL leaves the mutex for the retry to reclaim");
    const completed = fx.cli(args.slice(1));
    assert.equal(completed.status, 0, completed.stdout + completed.stderr);
    assert.equal(completed.json().result.status, "complete");
    assert.equal(json(join(home, "instance.json")).modules["acme.one"].commit, next.commit);
    assert.equal(readFileSync(join(home, "adopt-acme.one"), "utf8"), "2.0.0\n");
    assert.equal(existsSync(mutex), false, "completion releases the recovered mutex");
    noStaging(home);
  });
}

test("package upgrade acceptance: an earlier OATS's start lock directory excludes upgrade, is named, and is never reclaimed", async t => {
  const f = await fixture(t); const { home } = f;
  const plan = await f.plan(), before = composed(home), mutex = join(home, ".oats-start.lock");
  mkdirSync(mutex);
  try {
    await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "start-holds" }), e => e.code === "E_SESSION_RUNNING"
      && e.message === `seat: ${mutex} is a start lock left by an earlier OATS; upgrade never removes it. Once no earlier oats is running, remove that directory and retry`);
    assert.equal(lstatSync(mutex).isDirectory(), true, "the directory is left as it is");
    assert.deepEqual(composed(home), before);
    assert.ok(!existsSync(join(home, "adopt-acme.one")));
    noStaging(home);
  } finally {
    rmSync(mutex, { recursive: true });
  }
});

test("package upgrade acceptance: an entry at .oats-start.lock that is neither an upgrade's file nor a directory is named and never reclaimed", async t => {
  const f = await fixture(t); const { home } = f;
  const plan = await f.plan(), before = composed(home), mutex = join(home, ".oats-start.lock");
  symlinkSync(join(home, "instance.json"), mutex);
  try {
    await assert.rejects(f.apply({ planRevision: plan.planRevision, idempotencyKey: "start-link" }), e => e.code === "E_SESSION_RUNNING"
      && e.message === `seat: ${mutex} is neither an upgrade's file nor a start lock left by an earlier OATS; upgrade never removes it. Remove it and retry`);
    assert.equal(lstatSync(mutex).isSymbolicLink(), true, "the link is left as it is");
    assert.deepEqual(composed(home), before);
  } finally {
    rmSync(mutex);
  }
});

test("package upgrade acceptance: a start lock that appears after the upgrade checked the path is named for what it can be", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const plan = await f.plan(), before = composed(home), mutex = join(home, ".oats-start.lock");
  const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", plan.planRevision, "--idempotency-key", "appeared", "--json"];
  // The path is there when the upgrade creates its file, as an earlier OATS's start or another
  // writer could make it between the upgrade's check and its create.
  const failed = runFaulted(args, { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "faults-appeared"), gates: [{ name: "appeared", fn: "openSync", path: mutex, throws: "EEXIST" }] });
  assert.deepEqual(failed.fired, ["appeared"], "the upgrade's create met an existing entry");
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  const error = failed.json().error;
  assert.deepEqual([error.code, error.message], ["E_SESSION_RUNNING", `seat: ${mutex} appeared after the upgrade checked it: a start lock left by an earlier OATS, or a file made there between the check and the create. Once no earlier oats is running, remove it and retry`]);
  assert.deepEqual(composed(home), before);
});

test("package upgrade acceptance: a leftover regular upgrade mutex remains changed home bytes at retirement", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const plan = await f.plan(), key = "mutex-debt";
  const moved = await f.apply({ planRevision: plan.planRevision, idempotencyKey: key });
  assert.equal(moved.status, "complete");
  assert.equal(existsSync(join(home, ".oats-start.lock")), false);
  // Model an interrupted final release after the completed receipt. The
  // baseline's one-time projection must not hide a later regular file here.
  const debt = JSON.stringify({ idempotencyKey: key, planRevision: plan.planRevision, undo: false }) + "\n";
  writeFileSync(join(home, ".oats-start.lock"), debt, { mode: 0o600 });
  const retired = await fx.inEnv(() => retireInstance(fx.root, "seat", { tmuxSession: "oats-test-nosuch" }));
  assert.ok(retired.workRecovery?.classes?.includes("changed instance-home bytes"), JSON.stringify(retired.workRecovery));
  assert.equal(readFileSync(join(retired.workRecovery.path, "home/.oats-start.lock"), "utf8"), debt, "retirement preserves the unexplained mutex bytes in recovery");
  assert.equal(retired.removedDir, true);
});

test("package upgrade regression: baseline projection accepts only present exact regular files", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const baselinePath = retirementBaselinePath(home), original = readFileSync(baselinePath);
  const project = paths => writeRetirementBaseline(home, join(home, "work"), "directory", [], { launched: false }, { transientHomePaths: paths });
  for (const paths of [["../outside"], [".oats/*"]]) {
    assert.throws(() => project(paths), e => e.code === "E_BAD_ARGS");
    assert.deepEqual(readFileSync(baselinePath), original);
  }
  for (const paths of [[".missing-projection"], [".agents/skills"]]) {
    assert.throws(() => project(paths), e => e.code === "E_WORK_INSPECTION_FAILED");
    assert.deepEqual(readFileSync(baselinePath), original);
  }
  const temporary = join(home, ".projection-file");
  writeFileSync(temporary, "transaction-owned temporary file");
  await fx.inEnv(() => project([".projection-file"]));
  assert.equal(json(baselinePath).homeFingerprint, JSON.parse(original).homeFingerprint, "one-time projection holds the final home bytes after the file is removed");
  rmSync(temporary);
});

for (const [scope, workMode, relativePath, expectedClass, copyRoot] of [
  ["home", "directory", "STATE.md", "changed instance-home bytes", "home"],
  ["worktree", "worktree", "session-work.txt", "untracked or ignored worktree bytes", "repo"],
]) test(`package upgrade regression: pre-upgrade ${scope} edits remain retirement work`, async t => {
  const { fx, home, plan, apply } = await fixture(t, { workMode, oldMode: "no-upgrade", nextMode: "no-upgrade" });
  const baselineBytes = readFileSync(retirementBaselinePath(home));
  const baselineBefore = JSON.parse(baselineBytes);
  const bytes = "agent work written before the upgrade\n";
  writeFileSync(join(home, ...(scope === "home" ? [] : ["work"]), relativePath), bytes);
  const shown = await plan();
  assert.equal(shown.homeChangedSinceSpawn, scope === "home");
  await apply({ planRevision: shown.planRevision, idempotencyKey: "preserve-work" });
  if (scope === "home") assert.deepEqual(readFileSync(retirementBaselinePath(home)), baselineBytes, "a dirty home preserves the entire baseline for older kernels");
  if (scope === "home") {
    fx.commit(pkg("3.0.0", "no-upgrade")); lock(fx, "3.0.0");
    const later = await plan();
    assert.equal(later.homeChangedSinceSpawn, true);
    await apply({ planRevision: later.planRevision, idempotencyKey: "preserve-again" });
    assert.deepEqual(readFileSync(retirementBaselinePath(home)), baselineBytes, "later moves also keep the original dirty baseline");
  }
  const baselineAfter = json(retirementBaselinePath(home));
  assert.equal(baselineAfter.digestVersion, baselineBefore.digestVersion, "upgrade preserves the recorded digest version");
  if (scope === "worktree") assert.equal(baselineAfter.generatedWorkFingerprint, baselineBefore.generatedWorkFingerprint, "upgrade never retakes the generated work baseline");
  const retired = await fx.inEnv(() => retireInstance(fx.root, "seat", { tmuxSession: "oats-test-nosuch" }));
  assert.ok(retired.workRecovery?.classes?.includes(expectedClass), JSON.stringify(retired.workRecovery));
  assert.equal(readFileSync(join(retired.workRecovery.path, copyRoot, relativePath), "utf8"), bytes, "recovery keeps the pre-upgrade edit");
});

test("package upgrade regression: clean home retires without recovery", async t => {
  const f = await fixture(t, { oldMode: "no-upgrade", nextMode: "no-upgrade" });
  const shown = await f.plan();
  assert.equal(shown.homeChangedSinceSpawn, false);
  await f.apply({ planRevision: shown.planRevision, idempotencyKey: "clean-home" });
  const retired = await f.fx.inEnv(() => retireInstance(f.fx.root, "seat", { tmuxSession: "oats-test-nosuch" }));
  assert.equal(retired.workRecovery, undefined);
  assert.equal(retired.removedDir, true);
});

test("package upgrade regression: the same-work flag (#1577) is kept, is no home change, and the home still retires without recovery", async t => {
  const f = await fixture(t, { oldMode: "no-upgrade", nextMode: "no-upgrade" });
  writeSameWork(f.home, "lead");
  const shown = await f.plan();
  assert.equal(shown.homeChangedSinceSpawn, false, "the flag's record is kernel presentation, not a home change");
  await f.apply({ planRevision: shown.planRevision, idempotencyKey: "same-work" });
  assert.equal(readSameWork(f.home), "lead", "the upgrade keeps the record");
  const retired = await f.fx.inEnv(() => retireInstance(f.fx.root, "seat", { tmuxSession: "oats-test-nosuch" }));
  assert.equal(retired.workRecovery, undefined);
  assert.equal(retired.removedDir, true);
});

test("package upgrade regression: stray previous entries refuse before plan hooks", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const invoked = join(fx.base, "plan-hook-ran");
  fx.commit({ ...pkg("2.1.0"), "oats-package/capabilities/acme.one/upgrade.mjs": `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(invoked)}, 'ran'); console.log('{"adopt":true}');` });
  lock(fx, "2.1.0");
  mkdirSync(join(home, ".oats/previous"));
  writeFileSync(join(home, ".oats/previous/stray"), "inspect me");
  await assert.rejects(f.plan(), e => e.code === "E_UPGRADE_INTEGRITY" && /previous-state entry/.test(e.message));
  assert.equal(existsSync(invoked), false, "no hook runs before the previous-state preflight");
});

test("package upgrade regression: old spawn and launch state requires adoption even without recorded meta", async t => {
  const f = await fixture(t, { oldLaunch: true, nextMode: "no-upgrade", nextLaunch: false });
  const file = join(f.home, "instance.json"), meta = json(file);
  delete meta.capabilityMeta["acme.one"];
  writeFileSync(file, JSON.stringify(meta, null, 2) + "\n");
  const shown = await f.plan();
  assert.equal(shown.modules[0].provider.decision, "refuse");
  assert.match(shown.modules[0].provider.reason, /does not declare an upgrade hook/);
});

for (const report of ["stderr", "warning"]) test(`package upgrade regression: failed hook preserves bounded ${report} diagnosis`, async t => {
  const f = await fixture(t); const { fx } = f;
  const diagnostic = "provider diagnosis " + report + " ";
  fx.commit({ ...pkg("2.1.0"), "oats-package/capabilities/acme.one/upgrade.mjs": `if(process.env.OATS_UPGRADE_PHASE==='plan')console.log('{"adopt":true}');else { ${report === "warning" ? "console.log(JSON.stringify({warning:" + JSON.stringify(diagnostic) + "+'x'.repeat(6000)}));" : "process.stderr.write(" + JSON.stringify(diagnostic) + "+'x'.repeat(6000));"} process.exit(1); }` });
  lock(fx, "2.1.0"); const shown = await f.plan();
  await assert.rejects(f.apply({ planRevision: shown.planRevision, idempotencyKey: "diagnosis-" + report }), e => {
    assert.ok(e.message.includes(diagnostic), e.message);
    assert.ok(e.message.length < 4096, "provider output stays bounded");
    return e.code === "E_UPGRADE_REFUSED";
  });
});

test("package upgrade regression: hook receives final module directory in plan and apply", async t => {
  const f = await fixture(t); const { fx, home } = f;
  const final = join(home, ".oats/modules/acme.one");
  const planPath = join(fx.base, "plan-module-dir");
  fx.commit({ ...pkg("2.1.0"), "oats-package/capabilities/acme.one/upgrade.mjs": `import fs from 'node:fs'; const dir=process.env.OATS_UPGRADE_MODULE_DIR; if(process.env.OATS_UPGRADE_PHASE==='plan'){fs.writeFileSync(${JSON.stringify(planPath)},String(dir));console.log('{"adopt":true}');}else console.log(JSON.stringify({meta:{registeredModuleDir:dir}}));` });
  lock(fx, "2.1.0"); const shown = await f.plan();
  assert.equal(readFileSync(planPath, "utf8"), final);
  await f.apply({ planRevision: shown.planRevision, idempotencyKey: "final-dir" });
  assert.equal(json(join(home, "instance.json")).capabilityMeta["acme.one"].registeredModuleDir, final);
  assert.equal(existsSync(final), true);
});

test("package upgrade regression: member drift stays informational across plan and apply", async t => {
  const f = await fixture(t, { memberModule: true });
  const shown = await f.plan();
  f.fx.commit({ "capabilities/local.style/inject.md": "new member source, not part of the package move" });
  const again = await f.plan();
  assert.notDeepEqual(again.memberDrift, shown.memberDrift);
  assert.equal(again.planRevision, shown.planRevision, "member movement must not stale a package move");
  assert.equal((await f.apply({ planRevision: shown.planRevision, idempotencyKey: "member-info" })).status, "complete");
});

test("package upgrade regression: rendered hook commands survive a quoted home path", async t => {
  const f = await fixture(t); const { fx } = f;
  const root = fx.root + "'quoted";
  renameSync(fx.root, root);
  const home = f.home.replace(fx.root, root);
  // Model a deployment rooted under a quoted parent with valid spawn authority.
  // The package repository paths stay unchanged, because repo refs reject quotes.
  const meta = json(join(home, "instance.json"));
  meta.soulDir = meta.soulDir.replace(fx.root, root);
  writeFileSync(join(home, "instance.json"), JSON.stringify(meta, null, 2) + "\n");
  writeRetirementBaseline(home, join(home, "work"), meta.work, [], { launched: false });
  const shown = await fx.inEnv(() => planUpgrade(fx.dep, root, "seat", { remoteOptions: fx.remoteOptions }));
  await fx.inEnv(() => applyUpgrade(fx.dep, root, "seat", { remoteOptions: fx.remoteOptions, planRevision: shown.planRevision, idempotencyKey: "quote" }));
  const row = json(join(home, "instance.json")).capabilityRuntime.find(c => c.id === "acme.one");
  assert.ok(home.includes("'"));
  assert.doesNotMatch(row.hooks.retire, /staging-upgrade/);
  const ran = spawnSync(row.hooks.retire, { shell: true, cwd: home, env: fx.env, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
});

test("package upgrade regression: stateless failure publishing commit leaves no success event", async t => {
  const f = await fixture(t, { oldMode: "no-upgrade", nextMode: "no-upgrade" }); const { fx, home } = f;
  const shown = await f.plan(), key = "commit-failure";
  const args = [CLI, "instance", "upgrade", "seat", "--plan-revision", shown.planRevision, "--idempotency-key", key, "--json"];
  const before = composed(home);
  const failed = runFaulted(args, { cwd: fx.dep, env: fx.env, gateDir: join(fx.base, "commit-fault"), gates: [{ name: "commit", fn: "writeFileSync", prefix: "", contains: '\"status\": \"complete\"', throws: "ENOSPC" }] });
  assert.deepEqual(failed.fired, ["commit"]);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(composed(home), before);
  assert.equal(readEvents(home).events.filter(e => e.kind === "modules-upgraded").length, 0, "rolled back moves must not be announced");
});
