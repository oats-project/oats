/** Package module upgrades are explicit stopped-home acts. Composition is materialize's
 * transaction; this module owns adoption, durable forward recovery and the plan fence.
 * A successful provider hook is the irreversible boundary: old modules must never be
 * restored under host state adopted by a new provider. */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { oatsError } from "./errors.mjs";
import { resolveInstance } from "./instance-lifecycle.mjs";
import {
  claimHomeFor,
  releaseHomeClaim,
  homeClaimHolder,
  lifecycleClaimRefusals,
  retirePendingMarkerPath,
  identifiedHomeRecord,
  inspectInstanceSession,
  lifecycleHookEnv,
  resolvedFromHome,
  materializedHookCommands,
  shq,
  composeInstanceAgentsMd,
  retirementHomeChanged,
  rebaseUpgradeRetirementBaseline,
  planInstanceResources,
  orderInstructionBlocks,
  findRetirementBaseline,
  officialPackageCatalog,
} from "./core.mjs";
import {
  stageMaterialize,
  driftOf,
  moduleSkills,
  refForKey,
} from "./materialize.mjs";
import {
  toCapabilityRows,
  discoverOrStandalone,
} from "./instance-resolution.mjs";
import {
  lockedPackageCapabilities,
  lockedCapability,
  revisionOf,
  kernelCompatibility,
} from "./resolve.mjs";
import { readLock, writeFileAtomic } from "./packages.mjs";
import { loadLocal, memberSoulPath } from "./workspace.mjs";
import { copyTreeSafe, treeDisagreement } from "./tree-copy.mjs";
import { appendEvent, readEvents } from "./instance-events.mjs";
import {
  assertNoPartialUpgrade,
  readUpgradeReceipts,
} from "./upgrade-state.mjs";
import * as remote from "./remote.mjs";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAP = /^[a-z0-9][a-z0-9._-]*$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const readJson = (path) => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (object(value)) return value;
  } catch {
    /* invalid or unavailable state is an input refusal */
  }
  throw fail(
    "E_UPGRADE_INTEGRITY",
    `${path} cannot be read as a JSON object; restore the recorded bytes or respawn the instance`,
  );
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const fileDigest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
const receiptPath = (home, key) =>
  join(home, ".oats", `upgrade-receipt.${key}.json`);
const writeJson = (p, v) =>
  writeFileAtomic(p, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
function fail(code, message, details) {
  return Object.assign(oatsError(code, message), { details });
}
function realDir(path) {
  if (!lstatSync(path).isDirectory())
    throw fail(
      "E_UPGRADE_INTEGRITY",
      `${path} is not a real directory; respawn the instance`,
    );
}
function safeHomePaths(home) {
  realDir(home);
  for (const p of [".oats", ".oats/modules", ".agents", ".agents/skills"])
    realDir(join(home, p));
  for (const p of ["instance.json", "AGENTS.md"])
    if (!lstatSync(join(home, p)).isFile())
      throw fail(
        "E_UPGRADE_INTEGRITY",
        `${p} is not a regular file; respawn the instance`,
      );
  const previous = join(home, ".oats/previous");
  if (existsSync(previous)) realDir(previous);
}
function target(ctx, root, name, opts) {
  const found = resolveInstance(ctx, root, name, opts);
  const meta = identifiedHomeRecord(found.home).meta;
  if (!object(meta?.modules) || !meta.workspace?.soul?.commit)
    throw fail(
      "E_UNSUPPORTED_MODE",
      `${name} has no recorded workspace modules and soul commit; respawn the instance`,
    );
  safeHomePaths(found.home);
  return { ...found, meta };
}
function stopped(home, name, opts, absentMeta) {
  let session;
  try {
    session = inspectInstanceSession(home, { io: opts.io, absentMeta });
  } catch {
    /* unreadable is not stopped */
  }
  if (session?.running !== false)
    throw fail(
      "E_SESSION_RUNNING",
      `${name}'s session is running or cannot be read; run oats instance stop ${name}, then upgrade, then oats session start --home ${home}`,
    );
}
function unclaimed(home, name, own = false) {
  if (existsSync(retirePendingMarkerPath(home)))
    throw fail(
      "E_INSTANCE_RETIRING",
      `${name} is being retired; no modules were upgraded`,
    );
  if (!own) {
    const held = homeClaimHolder(home);
    if (held && held.state !== "gone")
      throw lifecycleClaimRefusals("upgrade", name, home, held.lock).busy(
        held.holder,
        held.state === "unknown" ? held.reason : null,
      );
  }
}
function hookCommand(manifest) {
  const h = manifest.hooks?.upgrade;
  return typeof h === "string" ? h : h?.command;
}
function runHook(phase, { home, meta, module, dir, to, root }) {
  const cap = toCapabilityRows(
    {
      modules: [module],
      payloads: meta.providers,
      payloadOrigins: {
        [module.name]:
          meta.capabilityRuntime?.find((c) => c.id === module.name)
            ?.settingsOrigins ?? {},
      },
    },
    home,
    { moduleDirs: { [module.name]: dir } },
  )[0];
  cap.dir = dir;
  cap.hooks = materializedHookCommands(
    { ...cap, hooks: { upgrade: hookCommand(module.manifest) } },
    home,
  );
  const env = lifecycleHookEnv("upgrade", cap, {
    home,
    instance: meta.instance,
    agentName: meta.agent,
    soulDir: meta.soulDir,
    contextDir: meta.repo || dirname(root),
    workspaceDir: dirname(root),
    rootDir: root,
    resolved: resolvedFromHome(home, meta),
    priorMeta: meta.capabilityMeta || {},
    extraEnv: {
      OATS_UPGRADE_PHASE: phase,
      OATS_UPGRADE_MODULE_DIR: join(home, ".oats/modules", module.name),
      OATS_UPGRADE_FROM: JSON.stringify({
        from: meta.modules[module.name].from,
        commit: meta.modules[module.name].commit,
        digest: meta.modules[module.name].digest,
      }),
      OATS_UPGRADE_TO: JSON.stringify(to),
    },
  });
  let answer,
    observedExitZero = false;
  try {
    const output = execSync(cap.hooks.upgrade, {
      cwd: home,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    observedExitZero = true;
    answer = JSON.parse(
      output.trim().split("\n").filter(Boolean).at(-1) || "null",
    );
  } catch (cause) {
    let reported;
    try {
      const output = JSON.parse(String(cause.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) || "null");
      if (typeof output?.warning === "string") reported = output.warning.trim();
    } catch { /* stderr remains useful when the provider did not report JSON */ }
    const diagnosis = String(reported || cause.stderr || cause.message || cause).trim().slice(0, 2048);
    throw Object.assign(
      fail(
        "E_UPGRADE_REFUSED",
        `${module.name} upgrade hook reported failure in ${phase}${diagnosis ? `: ${diagnosis}` : ""}; host effects are the provider's responsibility (a failed apply must compensate its own effects); respawn if it cannot adopt`,
        { capability: module.name, phase },
      ),
      {
        hookRefused:
          !observedExitZero &&
          Number.isInteger(cause.status) &&
          cause.status > 0 &&
          !cause.signal,
      },
    );
  }
  if (
    !object(answer) ||
    (phase === "plan"
      ? typeof answer.adopt !== "boolean"
      : !object(answer.meta))
  )
    throw fail(
      "E_UPGRADE_REFUSED",
      `${module.name} upgrade hook returned an invalid ${phase} answer; expected ${phase === "plan" ? "{adopt: boolean}" : "{meta}"}; respawn if it cannot adopt`,
      { capability: module.name, phase },
    );
  return answer;
}
function adoption(home, meta, module, dir, to, root, undo, oldManifest) {
  if (!hookCommand(module.manifest)) {
    if (
      undo ||
      Object.hasOwn(meta.capabilityMeta || {}, module.name) ||
      module.manifest.hooks?.spawn ||
      module.manifest.hooks?.launch ||
      oldManifest.hooks?.spawn ||
      oldManifest.hooks?.launch
    )
      return {
        decision: "refuse",
        reason: `${module.name} does not declare an upgrade hook; respawn the instance to change it`,
      };
    return {
      decision: "adopt",
      reason: "skills/inject only; no provider state",
    };
  }
  const answer = runHook("plan", { home, meta, module, dir, to, root });
  return answer.adopt
    ? { decision: "adopt", reason: null }
    : {
        decision: "refuse",
        reason: answer.reason || "provider refused adoption",
        ...(answer.remedy ? { remedy: answer.remedy } : {}),
      };
}
function skillDiff(oldDir, newDir, name, oldManifest, newManifest) {
  const rows = (manifest, dir) =>
    new Map(
      moduleSkills({}, { name, manifest }, dir).map((s) => [
        s.name,
        remote.contentDigest(join(dir, s.path)),
      ]),
    );
  const a = rows(oldManifest, oldDir),
    b = rows(newManifest, newDir);
  return {
    added: [...b.keys()].filter((k) => !a.has(k)).sort(),
    removed: [...a.keys()].filter((k) => !b.has(k)).sort(),
    changed: [...b.keys()]
      .filter((k) => a.has(k) && a.get(k) !== b.get(k))
      .sort(),
  };
}
function injectBytes(manifest, dir) {
  const paths = typeof manifest.inject === "string" ? [manifest.inject] : [];
  return paths.map((p) => {
    const abs = resolve(dir, p),
      rel = relative(dir, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`))
      throw fail("E_UPGRADE_INTEGRITY", `inject path escapes ${dir}`);
    return readFileSync(abs, "utf8");
  });
}
function verifyPrevious(home, record, name) {
  try {
    if (!record || !/^[a-f0-9]{24}$/.test(record.receipt))
      throw fail(
        "E_UPGRADE_UNDO",
        `${name} has no latest verified previous state; respawn the instance`,
      );
    const base = join(home, ".oats/previous", record.receipt);
    realDir(base);
    realDir(join(base, "modules"));
    const dir = join(base, "modules", name);
    realDir(dir);
    if (
      remote.contentDigest(dir, {
        allowSymlinks: remote.OATS_ALIAS_SYMLINK,
      }) !== record.digest
    )
      throw fail(
        "E_UPGRADE_UNDO",
        `${name}'s previous copy no longer verifies; respawn the instance`,
      );
    const receipt = readUpgradeReceipts(home)
      .map((row) => row.receipt)
      .find((r) => r.receipt === record.receipt && r.status === "complete");
    for (const file of ["instance.json", "AGENTS.md"])
      if (
        !receipt?.previousDigests?.[file] ||
        fileDigest(join(base, file)) !== receipt.previousDigests[file]
      )
        throw fail(
          "E_UPGRADE_UNDO",
          `${name}'s previous ${file} no longer verifies; respawn the instance`,
        );
    const meta = readJson(join(base, "instance.json"));
    const { previous, ...saved } = meta.modules?.[name] || {};
    const { receipt: previousReceipt, ...expected } = record;
    if (hash(saved) !== hash(expected))
      throw fail(
        "E_UPGRADE_UNDO",
        `${name}'s previous record no longer verifies; respawn the instance`,
      );
    return { dir, record: meta.modules[name], meta };
  } catch (error) {
    if (error.code === "E_UPGRADE_UNDO") throw error;
    throw fail(
      "E_UPGRADE_UNDO",
      `${name}'s previous copy is missing or cannot be verified; respawn the instance`,
    );
  }
}
function cleanupPending(home) {
  for (const { receipt } of readUpgradeReceipts(home)) {
    if (
      receipt.action === "upgrade" &&
      receipt.status === "complete" &&
      receipt.steps?.cleaned === false
    )
      throw fail(
        "E_UPGRADE_CLEANUP",
        `the previous upgrade of ${receipt.instance} is committed but staging cleanup remains; retry oats instance upgrade ${receipt.instance}${receipt.undo ? " --undo" : ""} --plan-revision ${receipt.planRevision} --idempotency-key ${receipt.idempotencyKey} before planning another move`,
      );
  }
}
function finishCleanup(home, path, receipt) {
  try {
    if (!receipt.steps.event) {
      receipt.step = "event";
      writeJson(path, receipt);
      // A crash after append but before the receipt must not duplicate the event.
      if (
        !readEvents(home, { limit: 2000 }).events.some(
          (e) =>
            e.kind === "modules-upgraded" &&
            e.data?.receipt === receipt.receipt,
        )
      ) {
        const event = appendEvent(home, {
          kind: "modules-upgraded",
          data: {
            receipt: receipt.receipt,
            modules: receipt.modules.map((m) => ({
              capability: m.capability,
              from: m.from,
              to: m.to,
            })),
          },
        });
        if (!event.ok)
          throw fail(
            "E_UPGRADE_EVENT",
            `could not record modules-upgraded: ${event.reason}`,
          );
      }
      receipt.steps.event = true;
      writeJson(path, receipt);
    }
    rmSync(join(home, ".oats", `.staging-upgrade-${receipt.receipt}`), {
      recursive: true,
      force: true,
    });
    const complete = {
      ...receipt,
      steps: { ...receipt.steps, cleaned: true },
      step: "complete",
    };
    writeJson(path, complete);
    return complete;
  } catch (error) {
    throw fail(
      "E_UPGRADE_CLEANUP",
      `${receipt.instance} upgrade is committed; staging cleanup remains (${error.code || "unavailable"}). Retry oats instance upgrade ${receipt.instance}${receipt.undo ? " --undo" : ""} --plan-revision ${receipt.planRevision} --idempotency-key ${receipt.idempotencyKey}; no hooks or copies will run`,
      { receipt: receipt.receipt, step: "cleanup" },
    );
  }
}
/** Build the exact frozen composition, leaving unchanged modules at their recorded bytes. */
async function prepare(ctx, root, name, opts, { own = false } = {}) {
  const { home, meta } = target(ctx, root, name, opts);
  unclaimed(home, name, own);
  assertNoPartialUpgrade(home);
  cleanupPending(home);
  const previous = join(home, ".oats/previous");
  if (existsSync(previous)) for (const entry of readdirSync(previous)) {
    if (!/^[a-f0-9]{24}$/.test(entry)) throw fail("E_UPGRADE_INTEGRITY", `unexpected previous-state entry ${entry}; inspect it before retrying`);
  }
  stopped(home, name, opts);
  const homeChangedSinceSpawn = retirementHomeChanged(home, { transientHomePaths: own ? [".oats-start.lock"] : [] });
  const deployment = dirname(root),
    lock = readLock(deployment);
  const scratch = mkdtempSync(join(tmpdir(), "oats-upgrade-plan-"));
  try {
    const modules = [],
      existingModules = {},
      hookTargets = {},
      moving = [],
      kept = [],
      packages = new Map(),
      restored = {};
    const previousReceipts = [
      ...new Set(
        Object.values(meta.modules)
          .map((m) => m.previous?.receipt)
          .filter(
            (id) =>
              typeof id === "string" &&
              /^[a-f0-9]{24}$/.test(id) &&
              existsSync(join(home, ".oats/previous", id)),
          ),
      ),
    ];
    if (opts.undo && previousReceipts.length > 1)
      throw fail(
        "E_UPGRADE_UNDO",
        "more than one previous move remains; finish the pending upgrade or respawn",
      );
    const latestPrevious = previousReceipts[0];
    const ids = [
      ...new Set([
        ...(meta.capabilityRuntime || []).map((c) => c.id),
        ...Object.keys(meta.modules),
      ]),
    ];
    for (const id of ids) {
      if (!CAP.test(id) || !Object.hasOwn(meta.modules, id))
        throw fail(
          "E_UPGRADE_INTEGRITY",
          `invalid module ${id}; respawn the instance`,
        );
      const recorded = meta.modules[id],
        oldDir = join(home, ".oats/modules", id);
      realDir(oldDir);
      const oldManifest = readJson(join(oldDir, "oats.json"));
      const base = {
        name: id,
        from: recorded.from,
        digest: recorded.digest,
        manifest: oldManifest,
      };
      let next = null,
        dir = null,
        to = null;
      const entry = lock.packages[recorded.from?.package];
      if (
        recorded.from?.kind === "package" &&
        opts.undo &&
        recorded.previous &&
        (!latestPrevious || recorded.previous.receipt === latestPrevious)
      ) {
        const prev = verifyPrevious(home, recorded.previous, id);
        dir = prev.dir;
        restored[id] = {
          contribution: prev.meta.launch?.hooks?.contributions?.find(
            (c) => c.capability === id,
          ),
          env: prev.meta.launch?.hooks?.env || {},
        };
        next = {
          name: id,
          from: prev.record.from,
          digest: prev.record.digest,
          manifest: readJson(join(dir, "oats.json")),
        };
        to = {
          ...prev.record.from,
          commit: prev.record.commit,
          digest: prev.record.digest,
        };
      } else if (
        recorded.from?.kind === "package" &&
        !opts.undo &&
        entry &&
        entry.capabilities.includes(id) &&
        entry.commit !== recorded.commit
      ) {
        const pkgid = recorded.from.package;
        if (!packages.has(pkgid)) {
          const found = await lockedPackageCapabilities(pkgid, entry, {
            catalog: opts.catalog ?? officialPackageCatalog(),
            remoteOptions: opts.remoteOptions,
          });
          const tree = join(scratch, `package-${packages.size}`);
          await remote.fetchRemoteTree(
            found.ref,
            entry.commit,
            entry.path,
            tree,
            { ...opts.remoteOptions, allowSymlinks: remote.OATS_ALIAS_SYMLINK },
          );
          const digest = remote.contentDigest(tree, {
            allowSymlinks: remote.OATS_ALIAS_SYMLINK,
          });
          if (digest !== entry.integrity)
            throw fail(
              "E_PACKAGE_INTEGRITY",
              `package ${pkgid} does not match locked integrity`,
              { package: pkgid, expected: entry.integrity, actual: digest },
            );
          packages.set(pkgid, { ...found, tree });
        }
        const pkg = packages.get(pkgid),
          cap = lockedCapability(id, pkgid, entry, pkg.capabilities);
        next = {
          name: id,
          from: {
            kind: "package",
            package: pkgid,
            version: entry.version,
            commit: entry.commit,
            integrity: entry.integrity,
            repoKey: remote.parseRepoRef(pkg.ref).key,
          },
          dir: cap.dir,
          manifest: cap.manifest,
        };
        dir = join(pkg.tree, relative(entry.path, cap.dir));
        to = clone(entry);
      }
      if (!next) {
        modules.push(base);
        existingModules[id] = oldDir;
        kept.push({
          capability: id,
          reason:
            recorded.from?.kind === "member"
              ? "member module"
              : !entry
                ? "package no longer locked"
                : opts.undo
                  ? "not part of the latest previous move"
                  : !entry.capabilities.includes(id)
                    ? "package no longer provides capability"
                    : "current",
        });
        continue;
      }
      const compatibility = kernelCompatibility(next.manifest);
      if (compatibility && compatibility.ok === false)
        throw fail(
          "E_UPGRADE_REFUSED",
          `${id} is incompatible with this kernel; upgrade the kernel before its modules`,
        );
      next.digest = remote.contentDigest(dir, {
        allowSymlinks: remote.OATS_ALIAS_SYMLINK,
      });
      modules.push(next);
      existingModules[id] = dir;
      const provider = adoption(home, meta, next, dir, to, root, !!opts.undo, oldManifest);
      hookTargets[id] = to;
      moving.push({
        capability: id,
        from: {
          version: recorded.from.version,
          commit: recorded.commit,
          digest: recorded.digest,
        },
        to: {
          version: next.from.version,
          commit: next.from.commit,
          integrity: next.from.integrity,
        },
        skills: skillDiff(oldDir, dir, id, oldManifest, next.manifest),
        inject:
          JSON.stringify(injectBytes(oldManifest, oldDir)) !==
          JSON.stringify(injectBytes(next.manifest, dir)),
        hooks:
          JSON.stringify(oldManifest.hooks || {}) !==
          JSON.stringify(next.manifest.hooks || {}),
        provider,
      });
    }
    if (opts.undo && !moving.length)
      throw fail(
        "E_UPGRADE_UNDO",
        `${name} has no previous move to undo; respawn the instance`,
      );
    const soul = meta.workspace.soul,
      path = soul.package?.path || memberSoulPath(meta.agent);
    let body;
    try {
      body = (
        await remote.readRemoteFile(
          refForKey(soul.repoKey),
          soul.commit,
          `${path}/AGENTS.md`,
          opts.remoteOptions,
        )
      ).bytes.toString("utf8");
    } catch {
      throw fail(
        "E_UPGRADE_SOUL",
        `${name}'s soul body cannot be read at recorded commit ${soul.commit}; restore access to that commit or respawn`,
      );
    }
    const resolution = {
      resolutionApi: 1,
      modules,
      instructionOrder: recordedInstructionOrder(meta, modules),
      payloads: meta.providers || {},
      payloadOrigins: Object.fromEntries(
        (meta.capabilityRuntime || []).map((c) => [
          c.id,
          c.settingsOrigins || {},
        ]),
      ),
    };
    resolution.revision = revisionOf({
      modules: modules.map((m) => ({ name: m.name, from: m.from })),
      soul,
    });
    const composition = composeInstanceAgentsMd(
      meta.soulDir,
      meta.repo,
      meta.agent,
      meta.work,
      meta.kind,
      { resolution },
    );
    const blocks = composition.blocks.filter(
      (b) => !b.source.startsWith("capability:"),
    );
    let memberDrift = [];
    if (Object.values(meta.modules).some((m) => m.from.kind === "member")) {
      const local = loadLocal(deployment).local;
      const discovery = await discoverOrStandalone(local, {
        deployment,
        lock,
        remoteOptions: opts.remoteOptions,
      });
      memberDrift = driftOf(meta, discovery, { lock }).filter(
        (r) => r.from?.kind === "member" && r.status !== "current",
      );
    }
    const facts = {
      instance: meta.instance,
      createdAt: meta.createdAt,
      undo: !!opts.undo,
      modules: meta.modules,
      capabilityMeta: meta.capabilityMeta || {},
      providers: meta.providers || {},
      launch: meta.launch,
      body,
      blocks,
      moving,
      kept,
      lock,
    };
    const plan = {
      lifecycleApi: 1,
      action: "upgrade",
      instance: name,
      home,
      undo: !!opts.undo,
      modules: moving,
      kept,
      memberDrift,
      homeChangedSinceSpawn,
      planRevision: hash(facts),
    };
    return {
      plan,
      home,
      meta,
      resolution,
      existingModules,
      hookTargets,
      soulAgentsMd: body,
      blocks,
      lock,
      scratch,
      restored,
    };
  } catch (e) {
    rmSync(scratch, { recursive: true, force: true });
    throw e;
  }
}
export async function planUpgrade(ctx, root, name, opts = {}) {
  const p = await prepare(ctx, root, name, opts);
  try {
    return p.plan;
  } finally {
    rmSync(p.scratch, { recursive: true, force: true });
  }
}

function derivedMetadata(p, tx, receipt) {
  const { meta, resolution, home } = p,
    outcome = tx.outcome;
  const moving = new Set(receipt.modules.map((m) => m.capability));
  const rows = toCapabilityRows(resolution, home, {
    moduleDirs: Object.fromEntries(
      resolution.modules.map((m) => [
        m.name,
        join(tx.staging, "modules", m.name),
      ]),
    ),
  });
  for (const row of rows) {
    const stagedDir = join(tx.staging, "modules", row.id);
    row.dir = stagedDir;
    row.hooks = Object.fromEntries(
      Object.entries(materializedHookCommands(row, home)).map(([e, cmd]) => [
        e,
        cmd.split(shq(stagedDir).slice(1, -1)).join(shq(join(home, ".oats/modules", row.id)).slice(1, -1)),
      ]),
    );
    row.skills = outcome.skills
      .filter((s) => s.module === row.id)
      .map((s) => s.path);
    row.inject = row.manifest.inject
      ? join(home, ".oats/modules", row.id, row.manifest.inject)
      : undefined;
  }
  const modules = clone(outcome.instanceJson.modules);
  for (const [id, old] of Object.entries(meta.modules)) {
    if (!moving.has(id)) modules[id] = clone(old);
    else {
      const { previous, ...from } = old;
      modules[id].previous = { ...from, receipt: receipt.receipt };
    }
  }
  const soulSkills = (meta.skills || []).filter((s) => s.source === "soul");
  for (const skill of soulSkills) {
    if (!/^(?!\.+$)[^/\\\0]+$/.test(skill.name))
      throw fail("E_UPGRADE_INTEGRITY", "invalid recorded soul skill name");
    if (
      outcome.skills.some(
        (s) => s.name.toLowerCase() === skill.name.toLowerCase(),
      )
    )
      throw fail(
        "E_SKILL_DUPLICATE",
        `soul skill ${skill.name} collides with a module skill`,
      );
    copyTreeSafe(
      join(home, ".agents/skills", skill.name),
      join(tx.staging, "skills", skill.name),
    );
  }
  const skills = [
    ...soulSkills,
    ...outcome.skills.map((s) => ({
      name: s.name,
      source: `module:${s.module}`,
    })),
  ];
  const instructions = outcome.blocks.map(({ source, file }) => ({
    source,
    file,
  }));
  const capabilities = rows.map((cap) => ({
    id: cap.id,
    layer: cap.layer,
    command: cap.command,
    origin: cap.origin,
    level: cap.level,
    settings: cap.settings,
    settingsOrigins: cap.settingsOrigins,
    provenance: cap.provenance,
    skills: cap.skills,
    hooks: Object.keys(cap.hooks),
    trusted: !!cap.trust?.trusted,
    ...(cap.environment.length ? { environment: cap.environment } : {}),
    ...(cap.environmentNamespaces.length
      ? { environmentNamespaces: cap.environmentNamespaces }
      : {}),
  }));
  const capabilityRuntime = rows.map((cap) => ({
    id: cap.id,
    layer: cap.layer,
    level: cap.level,
    settings: cap.settings,
    settingsOrigins: cap.settingsOrigins,
    hooks: cap.hooks,
    requiredHooks: cap.requiredHooks,
    environment: cap.environment,
    environmentNamespaces: cap.environmentNamespaces,
    missingRequires: cap.missingRequires,
    trust: cap.trust,
    executable: cap.executable,
  }));
  const expected = [
    ...(meta.composition?.expected || [])
      .filter((r) => r.source === "soul")
      .map((r) => ({ ...r, path: r.resolved })),
    ...planInstanceResources({
      resolved: {
        capabilities: rows.map((row) => ({ ...row, planned: true })),
      },
      agent: { name: meta.agent },
      contextDir: meta.repo,
      composition: { blocks: p.blocks },
    }),
  ];
  for (const resource of expected) {
    if (resource.deferred !== "materialize") continue;
    const row = rows.find((r) => r.id === resource.module);
    if (resource.type === "injection") resource.path = row.inject;
    if (resource.type === "skill-tree") {
      resource.path = join(home, ".agents/skills");
      resource.entries = row.skills.map((path) => path.split(sep).at(-1));
    }
  }
  for (const block of outcome.blocks.filter((b) =>
    b.source.startsWith("capability:"),
  ))
    expected.push({
      type: "instruction-block",
      source: block.source,
      declared: block.file,
      path: block.file,
      materialized: true,
    });
  orderInstructionBlocks(expected, outcome.blocks);
  const composition = {
    ...meta.composition,
    expected: expected.map((r) => ({
      type: r.type,
      source: r.source,
      declared: r.declared,
      resolved: r.path,
      origin: r.origin,
      level: r.level,
      ...(r.deferred ? { deferred: r.deferred } : {}),
    })),
    materialized: {
      ...meta.composition?.materialized,
      skills: [
        ...(meta.composition?.materialized?.skills || []).filter(
          (s) => s.source === "soul",
        ),
        ...outcome.skills.map((s) => ({
          name: s.name,
          source: `module:${s.module}`,
          from: join(home, s.from),
        })),
      ],
      instructions,
    },
  };
  let launch = meta.launch;
  if (launch?.hooks) {
    let contributions = clone(launch.hooks.contributions || []);
    const env = { ...launch.hooks.env };
    for (const row of rows.filter((r) => moving.has(r.id))) {
      const existing = contributions.find((c) => c.capability === row.id);
      // Undo restores the saved contribution as data; no launch hook runs here.
      const restore = p.restored?.[row.id];
      if (restore) {
        for (const name of existing?.env || []) delete env[name];
        contributions = contributions.filter((c) => c.capability !== row.id);
        if (restore.contribution) {
          contributions.push(clone(restore.contribution));
          for (const name of restore.contribution.env || [])
            env[name] = restore.env[name];
        }
      }
      const contribution = contributions.find((c) => c.capability === row.id);
      if (!row.hooks.launch) {
        for (const name of contribution?.env || []) delete env[name];
        contributions = contributions.filter((c) => c.capability !== row.id);
      } else if (contribution) {
        Object.assign(contribution, {
          settings: row.settings,
          settingsOrigins: row.settingsOrigins,
          trust: {
            trusted: !!row.trust?.trusted,
            integrity: row.trust?.integrity || null,
          },
        });
      }
    }
    const args = {},
      owners = new Map();
    for (const c of contributions) {
      for (const name of c.env || []) {
        if (owners.has(name) && owners.get(name) !== c.capability)
          throw fail(
            "E_UPGRADE_REFUSED",
            `${name} would have two launch environment owners; respawn the instance`,
          );
        owners.set(name, c.capability);
      }
      for (const [harness, text] of Object.entries(c.launch || {}))
        if (text)
          args[harness] = `${args[harness] ? args[harness] + " " : ""}${text}`;
    }
    launch = {
      ...launch,
      hooks: { ...launch.hooks, launch: args, env, contributions },
    };
  }
  return {
    ...meta,
    modules,
    capabilities,
    capabilityRuntime,
    skills,
    instructions,
    composition,
    launch,
    resolutionRevision: resolution.revision,
  };
}
/** The home's capability-block order, from the `instructions` it recorded (its AGENTS.md as
 *  spawned or last upgraded); a module with no recorded block follows, by name. An upgrade
 *  keeps that order, and the kernel's blocks close the recomposed AGENTS.md. */
function recordedInstructionOrder(meta, modules) {
  const names = modules.map((m) => m.name),
    order = [];
  for (const row of Array.isArray(meta.instructions) ? meta.instructions : []) {
    const name =
      typeof row?.source === "string" && row.source.startsWith("capability:")
        ? row.source.slice("capability:".length)
        : null;
    if (name && names.includes(name) && !order.includes(name)) order.push(name);
  }
  return [...order, ...names.filter((n) => !order.includes(n)).sort()];
}
function keepPrevious(home, receipt, meta) {
  const root = join(home, ".oats/previous");
  if (existsSync(root)) realDir(root);
  else mkdirSync(root, { mode: 0o700 });
  const dest = join(root, receipt.receipt);
  mkdirSync(join(dest, "modules"), { recursive: true, mode: 0o700 });
  for (const row of receipt.modules) {
    const src = join(home, ".oats/modules", row.capability),
      to = join(dest, "modules", row.capability);
    copyTreeSafe(src, to);
    const comparison = treeDisagreement(src, to);
    if (
      remote.contentDigest(to, { allowSymlinks: remote.OATS_ALIAS_SYMLINK }) !==
        meta.modules[row.capability].digest ||
      !comparison.complete ||
      comparison.entries.length
    )
      throw fail(
        "E_UPGRADE_INTEGRITY",
        `previous copy of ${row.capability} does not verify`,
      );
  }
  receipt.previousDigests = {};
  for (const file of ["instance.json", "AGENTS.md"]) {
    copyTreeSafe(join(home, file), join(dest, file));
    receipt.previousDigests[file] = fileDigest(join(dest, file));
    if (!readFileSync(join(home, file)).equals(readFileSync(join(dest, file))))
      throw fail(
        "E_UPGRADE_INTEGRITY",
        `previous copy of ${file} does not verify`,
      );
  }
}
function partial(receipt, error) {
  const pending = receipt.modules
    .filter((m) => !receipt.steps.hooks.includes(m.capability))
    .map((m) => m.capability);
  return fail(
    "E_UPGRADE_PARTIAL",
    `${receipt.instance} upgrade is partial at ${receipt.step}${pending.length ? ` (pending modules: ${pending.join(", ")})` : ""}: ${error.message}. Retry oats instance upgrade ${receipt.instance}${receipt.undo ? " --undo" : ""} --plan-revision ${receipt.planRevision} --idempotency-key ${receipt.idempotencyKey}; if it cannot finish, respawn the instance`,
    {
      receipt: receipt.receipt,
      step: receipt.step,
      completed: receipt.steps,
      pending,
    },
  );
}
function reclaimUpgradeMutex(home, name) {
  const path = join(home, ".oats-start.lock");
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isFile())
    throw fail(
      "E_SESSION_RUNNING",
      `${name} has a start in progress; its directory mutex is never reclaimed by upgrade`,
    );
  rmSync(path);
}
function releaseUpgradeMutex(home, identity) {
  if (!identity) return;
  const path = join(home, ".oats-start.lock");
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino)
    rmSync(path);
}
/** Apply a fenced plan, or continue its exact staged versions after provider adoption.
 * Receipt progress is written before each irreversible operation; hooks must be
 * idempotent so an interrupted invocation can safely be retried. */
export async function applyUpgrade(ctx, root, name, opts = {}) {
  if (
    typeof opts.planRevision !== "string" ||
    !opts.planRevision ||
    typeof opts.idempotencyKey !== "string" ||
    !KEY.test(opts.idempotencyKey)
  )
    throw fail(
      "E_BAD_ARGS",
      "upgrade needs --plan-revision <rev> and --idempotency-key <key> (1–128 safe characters)",
    );
  const { home } = resolveInstance(ctx, root, name, opts);
  realDir(home);
  realDir(join(home, ".oats"));
  const path = receiptPath(home, opts.idempotencyKey);
  let stored =
    readUpgradeReceipts(home).find((row) => row.path === path)?.receipt || null;
  const checkReceipt = () => {
    if (
      stored &&
      (stored.action !== "upgrade" ||
        stored.instance !== name ||
        stored.home !== home ||
        !/^[a-f0-9]{24}$/.test(stored.receipt) ||
        stored.undo !== !!opts.undo ||
        stored.planRevision !== opts.planRevision)
    )
      throw fail(
        "E_IDEMPOTENCY_CONFLICT",
        "this idempotency key belongs to another upgrade plan; use its original arguments or another key",
      );
  };
  checkReceipt();
  if (stored?.status !== "partial") target(ctx, root, name, opts);
  if (stored?.status === "complete") {
    const claim = claimHomeFor("upgrade", name, home);
    try {
      // The receipt already records the invocation's final state, so a stale
      // upgrade file may be released even when its harness is running.
      reclaimUpgradeMutex(home, name);
      if (stored.steps?.cleaned === false)
        return { ...finishCleanup(home, path, stored), replayed: true };
      writeJson(path, stored);
      return { ...stored, replayed: true };
    } finally {
      releaseHomeClaim(claim);
    }
  }
  const holding = claimHomeFor("upgrade", name, home);
  let mutexIdentity,
    p,
    tx,
    receipt = stored,
    forwardOnly = !!(
      stored?.steps?.hooks?.length ||
      stored?.uncertain?.length ||
      stored?.hooks?.inFlight
    );
  try {
    unclaimed(home, name, true);
    if (stored?.status === "partial" && stored.hooks?.inFlight) {
      receipt.uncertain = [
        ...new Set([...(receipt.uncertain || []), stored.hooks.inFlight]),
      ];
      forwardOnly = true;
      // Unknown is not a refusal. Make that boundary durable before any retry
      // can inspect staging or run another hook, even if its retry later fails.
      writeJson(path, receipt);
    }
    stopped(home, name, opts, stored?.priorMeta);
    // One path, two atomic shapes: start owns a mkdir directory; upgrade owns
    // an exclusive regular file. Under our lifecycle claim a prior upgrade
    // cannot still run, so even an empty interrupted wx file is reclaimable.
    // A directory or symlink is never reclaimed by this act.
    reclaimUpgradeMutex(home, name);
    const startMutex = join(home, ".oats-start.lock");
    let fd;
    try {
      fd = openSync(startMutex, "wx", 0o600);
      mutexIdentity = fstatSync(fd);
      writeFileSync(
        fd,
        JSON.stringify({
          action: "upgrade",
          instance: name,
          home,
          planRevision: opts.planRevision,
          idempotencyKey: opts.idempotencyKey,
          undo: !!opts.undo,
        }) + "\n",
      );
    } catch (error) {
      if (error.code === "EEXIST")
        throw fail(
          "E_SESSION_RUNNING",
          `${name} has a start in progress; wait for it to finish before upgrading`,
        );
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    stored =
      readUpgradeReceipts(home).find((row) => row.path === path)?.receipt ||
      null;
    checkReceipt();
    receipt = stored;
    if (stored?.status === "complete")
      return {
        ...(stored.steps?.cleaned === false
          ? finishCleanup(home, path, stored)
          : stored),
        replayed: true,
      };
    if (stored?.status === "partial") {
      if (
        !Array.isArray(stored.steps?.hooks) ||
        !object(stored.priorMeta) ||
        !object(stored.resolution) ||
        !Array.isArray(stored.resolution.modules) ||
        !object(stored.nextMeta) ||
        !Array.isArray(stored.modules)
      )
        throw fail(
          "E_UPGRADE_PARTIAL",
          "the partial upgrade receipt cannot be resumed safely; inspect its recorded state or respawn the instance",
        );
      forwardOnly = !!(
        stored.steps.hooks.length ||
        stored.uncertain?.length ||
        stored.hooks?.inFlight
      );
      if (!stored.steps.cleaned)
        tx = await stageMaterialize(null, home, {
          staging: join(home, ".oats", `.staging-upgrade-${stored.receipt}`),
          resume: true,
        });
    } else {
      p = await prepare(ctx, root, name, opts, { own: true });
      if (p.home !== home)
        throw fail(
          "E_PLAN_STALE",
          "instance address changed; review a fresh plan",
        );
      if (p.plan.planRevision !== opts.planRevision)
        throw Object.assign(
          fail(
            "E_PLAN_STALE",
            `the upgrade plan changed (${opts.planRevision} → ${p.plan.planRevision}); review the fresh plan`,
          ),
          { plan: p.plan },
        );
      const refusals = p.plan.modules.filter(
        (m) => m.provider.decision === "refuse",
      );
      if (refusals.length)
        throw fail(
          "E_UPGRADE_REFUSED",
          refusals
            .map(
              (m) =>
                `${m.capability}: ${m.provider.reason}${m.provider.remedy ? `; ${m.provider.remedy}` : ""}`,
            )
            .join("\n"),
          { modules: refusals },
        );
      const id = hash({
        home,
        key: opts.idempotencyKey,
        revision: opts.planRevision,
      });
      if (!p.plan.modules.length) {
        const complete = {
          lifecycleApi: 1,
          action: "upgrade",
          status: "complete",
          instance: name,
          home,
          undo: !!opts.undo,
          idempotencyKey: opts.idempotencyKey,
          planRevision: opts.planRevision,
          receipt: id,
          modules: [],
          at: new Date().toISOString(),
        };
        writeJson(path, complete);
        return complete;
      }
      // No receipt means no hook was invoked. An interrupted preparation is
      // disposable under this claim; the same key can stage its plan again.
      rmSync(join(home, ".oats", `.staging-upgrade-${id}`), {
        recursive: true,
        force: true,
      });
      rmSync(join(home, ".oats/previous", id), {
        recursive: true,
        force: true,
      });
      receipt = {
        lifecycleApi: 1,
        action: "upgrade",
        status: "partial",
        instance: name,
        home,
        undo: !!opts.undo,
        idempotencyKey: opts.idempotencyKey,
        planRevision: opts.planRevision,
        receipt: id,
        at: new Date().toISOString(),
        modules: p.plan.modules,
        homeChangedSinceSpawn: p.plan.homeChangedSinceSpawn,
        hookTargets: p.hookTargets,
        hooks: { inFlight: null },
        uncertain: [],
        steps: {
          hooks: [],
          metadata: false,
          swapped: false,
          baseline: false,
          event: false,
          cleaned: false,
        },
        step: "stage",
        resolution: p.resolution,
        priorMeta: p.meta,
      };
      tx = await stageMaterialize(p.resolution, home, {
        replace: true,
        staging: join(home, ".oats", `.staging-upgrade-${id}`),
        existingModules: p.existingModules,
        soulAgentsMd: p.soulAgentsMd,
        blocks: p.blocks,
        lock: p.lock,
      });
      receipt.nextMeta = derivedMetadata(p, tx, receipt);
      tx.updateInstance(receipt.nextMeta);
      receipt.step = "previous";
      keepPrevious(home, receipt, p.meta);
      const baseline = findRetirementBaseline(home);
      if (existsSync(baseline))
        copyTreeSafe(baseline, join(tx.staging, "retirement-baseline.json"));
      // All replacement bytes now belong to the durable staging transaction.
      // Drop temporary planning copies before a killed resumable invocation can
      // strand them outside the receipt's staging tree.
      rmSync(p.scratch, { recursive: true, force: true });
      // A durable partial fence precedes the hook. If the process dies before
      // recording its success, retry re-runs that idempotent hook, never restores.
      writeJson(path, receipt);
    }
    const save = () => writeJson(path, receipt);
    for (const row of receipt.modules) {
      if (receipt.steps.hooks.includes(row.capability)) continue;
      const module = receipt.resolution.modules.find(
        (m) => m.name === row.capability,
      );
      if (!hookCommand(module.manifest)) continue;
      const moduleDirectory = join(tx.staging, "modules", module.name);
      const manifest = readJson(join(moduleDirectory, "oats.json"));
      if (
        manifest.capability !== module.name ||
        remote.contentDigest(moduleDirectory, {
          allowSymlinks: remote.OATS_ALIAS_SYMLINK,
        }) !== receipt.nextMeta.modules[module.name].digest
      )
        throw fail(
          "E_UPGRADE_INTEGRITY",
          `${module.name}'s staged copy no longer verifies; respawn if it cannot finish`,
        );
      module.manifest = manifest;
      if (!hookCommand(module.manifest)) continue;
      receipt.step = `hook ${row.capability}`;
      receipt.hooks = { ...(receipt.hooks || {}), inFlight: module.name };
      save();
      let answer;
      try {
        answer = runHook("apply", {
          home,
          meta: receipt.priorMeta,
          module,
          dir: join(tx.staging, "modules", module.name),
          to: receipt.hookTargets?.[row.capability] ?? row.to,
          root,
        });
      } catch (error) {
        if (error.hookRefused === true) {
          receipt.hooks.inFlight = null;
          receipt.hooks.refused = module.name;
          try {
            save();
          } catch (writeError) {
            // Without a durable outcome the marker remains authoritative.
            receipt.hooks.inFlight = module.name;
            forwardOnly = true;
            throw writeError;
          }
        } else {
          receipt.uncertain = [
            ...new Set([...(receipt.uncertain || []), module.name]),
          ];
          forwardOnly = true;
          save();
        }
        throw error;
      }
      forwardOnly = true;
      receipt.nextMeta.capabilityMeta = {
        ...receipt.nextMeta.capabilityMeta,
        [module.name]: answer.meta,
      };
      if (answer.warning)
        receipt.warnings = [...(receipt.warnings || []), answer.warning];
      receipt.steps.hooks.push(module.name);
      receipt.hooks.inFlight = null;
      delete receipt.hooks.refused;
      save();
    }
    if (!receipt.steps.swapped) {
      receipt.step = "swap";
      save();
      if (!receipt.steps.metadata) {
        tx.updateInstance(receipt.nextMeta);
        receipt.steps.metadata = true;
        save();
      }
      tx.commit({ preserveOnFailure: forwardOnly, retainStaging: true });
      receipt.steps.swapped = true;
      save();
    }
    // Only one previous move survives. The current backups remain ordinary
    // home content and count against an unchanged dirty retirement baseline.
    const previous = join(home, ".oats/previous");
    const history = tx ? join(tx.staging, "previous-history") : null;
    for (const entry of readdirSync(previous))
      if (entry !== receipt.receipt) {
        if (!/^[a-f0-9]{24}$/.test(entry))
          throw fail(
            "E_UPGRADE_INTEGRITY",
            `unexpected previous-state entry ${entry}; inspect it before retrying`,
          );
        mkdirSync(history, { recursive: true });
        renameSync(join(previous, entry), join(history, entry));
      }
    if (!receipt.steps.baseline) {
      receipt.step = "baseline";
      save();
      rebaseUpgradeRetirementBaseline(home, {
        homeChangedSinceSpawn: receipt.homeChangedSinceSpawn !== false,
      });
      receipt.steps.baseline = true;
      save();
    }
    const complete = {
      ...receipt,
      status: "complete",
      step: "cleanup",
      steps: { ...receipt.steps, cleaned: false },
      completedAt: new Date().toISOString(),
    };
    delete complete.hookTargets;
    delete complete.resolution;
    delete complete.priorMeta;
    delete complete.nextMeta;
    // Publishing this receipt is the commit. Only committed moves emit success.
    // Garbage collection cannot undo a fully composed home; a same-key retry
    // after this point finishes event publication and staging cleanup only.
    writeJson(path, complete);
    receipt = complete;
    return finishCleanup(home, path, receipt);
  } catch (error) {
    if (receipt?.status === "complete") throw error;
    if (
      receipt?.status === "partial" &&
      (forwardOnly || receipt.steps?.hooks?.length)
    ) {
      try {
        writeJson(path, receipt);
      } catch {
        /* the pre-hook fence remains authoritative */
      }
      throw partial(receipt, error);
    }
    if (tx && existsSync(tx.staging)) {
      const history = join(tx.staging, "previous-history");
      if (existsSync(history))
        for (const entry of readdirSync(history))
          renameSync(join(history, entry), join(home, ".oats/previous", entry));
      const baseline = join(tx.staging, "retirement-baseline.json");
      if (existsSync(baseline))
        writeFileAtomic(findRetirementBaseline(home), readFileSync(baseline), { mode: 0o600 });
      tx.rollback();
    }
    if (receipt?.receipt) {
      rmSync(join(home, ".oats/previous", receipt.receipt), {
        recursive: true,
        force: true,
      });
      rmSync(path, { force: true });
      const previous = join(home, ".oats/previous");
      if (existsSync(previous) && readdirSync(previous).length === 0)
        rmSync(previous, { recursive: true });
    }
    appendEvent(
      home,
      {
        kind: "upgrade-refused",
        data: {
          step: receipt?.step || "plan",
          reason: String(error.message).slice(0, 2048),
        },
      },
      { workspaceOnly: true },
    );
    throw error;
  } finally {
    if (p) rmSync(p.scratch, { recursive: true, force: true });
    releaseUpgradeMutex(home, mutexIdentity);
    releaseHomeClaim(holding);
  }
}
