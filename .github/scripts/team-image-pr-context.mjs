import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRelease } from "./check-team-image-release.mjs";
import { checkImageLockDiff } from "./team-image-lock-diff.mjs";
import { checkMetadata, checkResolved, resolvedPath, packageName, imageInputs, runNpmCommand } from "./team-image-release-context.mjs";
import { packKernel } from "./team-image-packed-kernel.mjs";

const KERNEL = "@awebai/oats", KERNEL_PATH = `node_modules/${KERNEL}`;
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const PR_KERNEL_SPEC = "file:../oats-build-inputs/oats-pr-kernel.tgz";

function requireBaseline(manifest, lock) {
  try { checkRelease("tag", `v${manifest.dependencies?.[KERNEL]}`, manifest, lock); }
  catch (cause) { throw new Error("packed PR image requires a compatible committed image baseline; migrate it instead of widening the guard", { cause }); }
}

// The baseline is a released image closure; the candidate kernel is the exact
// local pack, not a registry version or a fallback to the committed kernel.
export function checkPrImageLock({ sourceManifest, sourceLock, manifest, lock, kernel, metadata }) {
  requireBaseline(sourceManifest, sourceLock);
  assert.equal(kernel.name, KERNEL, "local pack must be the kernel");
  assert.equal(kernel.manifest.name, KERNEL);
  assert.equal(kernel.manifest.version, kernel.version);
  assert.match(kernel.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.equal(manifest.dependencies[KERNEL], PR_KERNEL_SPEC, "fixed local kernel spec required");
  checkResolved(KERNEL_PATH, lock, { ...kernel.manifest, dist: { tarball: PR_KERNEL_SPEC, integrity: kernel.integrity } });
  const allowed = new Set([KERNEL_PATH]);
  for (const [name, pin] of Object.entries(kernel.manifest.dependencies ?? {})) {
    assert.match(pin, EXACT, `kernel dependency must be an exact stable version: ${name}`);
    const dependency = checkMetadata(name, pin, metadata[name]);
    const target = resolvedPath(lock, name);
    assert.ok(target, `missing exact kernel dependency: ${name}`);
    checkResolved(target, lock, dependency);
    allowed.add(target);
    const previous = resolvedPath(sourceLock, name);
    if (previous && !lock.packages[previous]) allowed.add(previous);
  }
  checkImageLockDiff({ sourceManifest, sourceLock, manifest, lock }, allowed);
}

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

export function preparePrContext({ sourceDir, sourceCommit, tempDir = tmpdir(), runNpm = runNpmCommand }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, "source commit must be a full commit ID");
  const source = realpathSync(sourceDir), imageDir = join(source, "container/agent");
  const sourceManifest = json(join(imageDir, "package.json")), sourceLock = json(join(imageDir, "package-lock.json"));
  requireBaseline(sourceManifest, sourceLock);
  const root = mkdtempSync(join(tempDir, "oats-pr-image-"));
  try {
    const kernel = packKernel({ sourceDir: source, sourceCommit, tempDir: root, runNpm });
    const contextDir = join(root, "context");
    mkdirSync(contextDir, { mode: 0o700 });
    for (const name of imageInputs(imageDir)) {
      const input = join(imageDir, name), bytes = readFileSync(input);
      const head = execFileSync("git", ["show", `${sourceCommit}:container/agent/${name}`], { cwd: source,
        env: { PATH: process.env.PATH, HOME: root, GIT_NO_REPLACE_OBJECTS: "1" }, maxBuffer: 8 * 1024 * 1024 });
      assert.ok(bytes.equals(head), `image input differs from HEAD: ${name}`);
      copyFileSync(input, join(contextDir, name));
    }
    const tarName = "oats-pr-kernel.tgz", sibling = join(root, "oats-build-inputs");
    mkdirSync(sibling, { mode: 0o700 });
    for (const dir of [contextDir, sibling]) {
      const destination = join(dir, tarName);
      copyFileSync(kernel.tarball, destination);
      assert.equal(`sha512-${createHash("sha512").update(readFileSync(destination)).digest("base64")}`, kernel.integrity, "private kernel copy integrity mismatch");
    }
    const ignore = join(contextDir, ".dockerignore");
    writeFileSync(ignore, `${readFileSync(ignore, "utf8").trimEnd()}\n!${tarName}\n`);
    const manifest = structuredClone(sourceManifest);
    manifest.dependencies[KERNEL] = PR_KERNEL_SPEC;
    writeFileSync(join(contextDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(root, name), "");
    const env = { PATH: process.env.PATH, HOME: root, NPM_CONFIG_CACHE: join(root, "npm-cache"),
      NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc") };
    const options = { cwd: contextDir, env }, registry = "--registry=https://registry.npmjs.org";
    const metadata = Object.create(null);
    for (const [name, pin] of Object.entries(kernel.manifest.dependencies ?? {})) {
      packageName(name);
      assert.match(pin, EXACT, `kernel dependency must be an exact stable version: ${name}`);
      metadata[name] = checkMetadata(name, pin, JSON.parse(runNpm(["view", `${name}@${pin}`, "--json", registry], options)));
    }
    runNpm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", registry], options);
    checkPrImageLock({ sourceManifest, sourceLock, manifest: json(join(contextDir, "package.json")),
      lock: json(join(contextDir, "package-lock.json")), kernel, metadata });
    const inventoryPath = join(root, "packed-kernel.json");
    writeFileSync(inventoryPath, `${JSON.stringify({ sourceCommit, name: kernel.name, version: kernel.version, integrity: kernel.integrity, files: kernel.files }, null, 2)}\n`);
    const result = { root, contextDir, inventoryPath, metadataPath: join(root, "build-inputs.json"), sourceCommit,
      kernelVersion: kernel.version, kernelIntegrity: kernel.integrity, inventoryDigest: sha256(inventoryPath),
      lockDigest: sha256(join(contextDir, "package-lock.json")) };
    writeFileSync(result.metadataPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  const prepared = preparePrContext({ sourceDir: process.cwd(), sourceCommit: process.env.TEAM_IMAGE_SOURCE_SHA, tempDir: process.env.RUNNER_TEMP });
  const outputs = { context: prepared.contextDir, inventory: prepared.inventoryPath, metadata: prepared.metadataPath,
    "kernel-version": prepared.kernelVersion, "kernel-integrity": prepared.kernelIntegrity,
    "lock-digest": prepared.lockDigest, "inventory-digest": prepared.inventoryDigest };
  for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`Prepared PR kernel ${prepared.sourceCommit}; pack ${prepared.kernelIntegrity}; lock ${prepared.lockDigest}`);
}
