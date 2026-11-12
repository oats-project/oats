import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { checkRelease } from "./check-team-image-release.mjs";
import { appendFileSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const KERNEL = "@awebai/oats";
const KERNEL_PATH = `node_modules/${KERNEL}`;
const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const packageName = (name) => assert.match(name, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, "invalid npm package name");

function checkMetadata(name, version, value) {
  packageName(name);
  assert.equal(value?.name, name, `registry metadata name: ${name}`);
  assert.equal(value.version, version, `registry metadata version: ${name}`);
  assert.match(value.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, `registry SHA512 integrity: ${name}`);
  const url = new URL(value.dist.tarball);
  assert.ok(url.protocol === "https:" && url.hostname === "registry.npmjs.org" && !url.port && !url.username && !url.password && !url.search && !url.hash, `public registry tarball required: ${name}`);
  for (const dependency of Object.keys(value.dependencies ?? {})) packageName(dependency);
  return value;
}

function resolvedPath(lock, name) {
  for (const path of [`${KERNEL_PATH}/node_modules/${name}`, `node_modules/${name}`]) {
    if (lock.packages?.[path]) return path;
  }
  return undefined;
}

function checkResolved(path, lock, metadata) {
  const entry = lock.packages?.[path];
  assert.equal(entry?.version, metadata.version, `resolved version: ${path}`);
  assert.equal(entry.resolved, metadata.dist.tarball, `resolved registry tarball: ${path}`);
  assert.equal(entry.integrity, metadata.dist.integrity, `resolved integrity: ${path}`);
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(entry[key] ?? {}, metadata[key] ?? {}, `resolved ${key}: ${path}`);
  }
}

// The temporary lock may update the release kernel and its exact dependencies.
// Everything else, including unrelated removals, must retain the committed lock.
export function checkGeneratedLock({ refType, refName, sourceManifest, sourceLock, manifest, lock, metadata }) {
  const version = refName?.slice(1);
  assert.ok(refType === "tag" && refName?.startsWith("v") && EXACT.test(version), "stable release tag required");
  const kernel = checkMetadata(KERNEL, version, metadata[KERNEL]);
  const expectedManifest = structuredClone(sourceManifest);
  expectedManifest.dependencies[KERNEL] = version;
  assert.deepEqual(manifest, expectedManifest, "only the manifest's exact OATS pin may change");
  assert.equal(sourceLock.packages?.[""]?.dependencies?.[KERNEL], sourceManifest.dependencies[KERNEL], "committed image lock root must match its OATS pin");
  assert.equal(sourceLock.packages?.[KERNEL_PATH]?.version, sourceManifest.dependencies[KERNEL], "committed image lock must resolve its OATS pin");
  checkRelease(refType, refName, manifest, lock);
  checkResolved(KERNEL_PATH, lock, kernel);
  for (const name of Object.keys(sourceManifest.dependencies)) {
    if (name === KERNEL) continue;
    const path = `node_modules/${name}`;
    assert.ok(isDeepStrictEqual(lock.packages[path], sourceLock.packages[path]), `unrelated protected CLI lock entry changed: ${name}`);
  }
  const allowed = new Set([KERNEL_PATH]);
  for (const [name, pin] of Object.entries(kernel.dependencies ?? {})) {
    assert.match(pin, EXACT, `kernel dependency must be an exact stable version: ${name}`);
    const dependency = checkMetadata(name, pin, metadata[name]);
    const targetPath = resolvedPath(lock, name);
    assert.ok(targetPath, `missing exact kernel dependency: ${name}`);
    checkResolved(targetPath, lock, dependency);
    allowed.add(targetPath);
    const sourcePath = resolvedPath(sourceLock, name);
    // A dependency moved under the kernel may leave a shared root entry.
    // That surviving entry is unrelated to the kernel's new resolution.
    if (sourcePath && !lock.packages[sourcePath]) allowed.add(sourcePath);
  }
  const expectedRoot = structuredClone(sourceLock.packages[""]);
  expectedRoot.dependencies[KERNEL] = version;
  assert.deepEqual(lock.packages[""], expectedRoot, "unrelated lock root change");
  assert.deepEqual({ ...lock, packages: undefined }, { ...sourceLock, packages: undefined }, "unrelated lock metadata change");
  for (const path of new Set([...Object.keys(sourceLock.packages), ...Object.keys(lock.packages)])) {
    if (path === "" || allowed.has(path)) continue;
    assert.ok(isDeepStrictEqual(sourceLock.packages[path], lock.packages[path]), `unrelated lock entry changed: ${path}; migrate the committed image baseline instead of widening this allowance`);
  }
}

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const runNpmCommand = (args, options) => execFileSync("npm", args, {
  ...options, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});

function imageInputs(source) {
  const regular = (name) => assert.ok(lstatSync(join(source, name)).isFile(), `image input must be a regular file: ${name}`);
  regular(".dockerignore");
  const rules = readFileSync(join(source, ".dockerignore"), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  assert.equal(rules.shift(), "**", "image allowlist must begin with **");
  const names = [".dockerignore"];
  for (const rule of rules) {
    assert.match(rule, /^![A-Za-z0-9][A-Za-z0-9._-]*$/, "release context supports only literal file allowlist entries");
    const name = rule.slice(1);
    regular(name);
    names.push(name);
  }
  for (const name of ["Dockerfile", "package.json", "package-lock.json"]) assert.ok(names.includes(name), `image allowlist must include ${name}`);
  return [...new Set(names)];
}

// npm is a system boundary. Neither a session credential nor the runner's npm
// configuration is inherited by this public-registry, scripts-disabled operation.
export function prepareReleaseContext({ refType, refName, sourceDir, sourceCommit, tempDir = tmpdir(), runNpm = runNpmCommand }) {
  assert.ok(refType === "tag" && refName?.startsWith("v") && EXACT.test(refName.slice(1)), "stable release tag required");
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, "source commit must be a full commit ID");
  const version = refName.slice(1), source = realpathSync(sourceDir);
  const files = imageInputs(source);
  const root = mkdtempSync(join(tempDir, "oats-release-context-"));
  try {
    const contextDir = join(root, "context");
    mkdirSync(contextDir, { mode: 0o700 });
    for (const file of files) copyFileSync(join(source, file), join(contextDir, file));
    const sourceManifest = json(join(contextDir, "package.json")), sourceLock = json(join(contextDir, "package-lock.json"));
    const manifest = structuredClone(sourceManifest);
    manifest.dependencies[KERNEL] = version;
    writeFileSync(join(contextDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const userConfig = join(root, "user.npmrc"), globalConfig = join(root, "global.npmrc");
    writeFileSync(userConfig, ""); writeFileSync(globalConfig, "");
    const env = { PATH: process.env.PATH, HOME: root, NPM_CONFIG_CACHE: join(root, "npm-cache"), NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig };
    const options = { cwd: contextDir, env }, registry = "--registry=https://registry.npmjs.org";
    const readMetadata = (name, pin) => {
      packageName(name);
      return checkMetadata(name, pin, JSON.parse(runNpm(["view", `${name}@${pin}`, "--json", registry], options)));
    };
    const metadata = Object.create(null);
    metadata[KERNEL] = readMetadata(KERNEL, version);
    for (const [name, pin] of Object.entries(metadata[KERNEL].dependencies ?? {})) {
      assert.match(pin, EXACT, `kernel dependency must be an exact stable version: ${name}`);
      metadata[name] = readMetadata(name, pin);
    }
    runNpm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", registry], options);
    const lock = json(join(contextDir, "package-lock.json"));
    checkGeneratedLock({ refType, refName, sourceManifest, sourceLock, manifest: json(join(contextDir, "package.json")), lock, metadata });
    const result = { contextDir, metadataPath: join(root, "build-inputs.json"), sourceCommit, sourceTag: refName, kernelVersion: version, kernelIntegrity: metadata[KERNEL].dist.integrity,
      lockDigest: `sha256:${createHash("sha256").update(readFileSync(join(contextDir, "package-lock.json"))).digest("hex")}` };
    writeFileSync(join(root, "build-inputs.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prepared = prepareReleaseContext({ refType: process.env.GITHUB_REF_TYPE, refName: process.env.GITHUB_REF_NAME,
    sourceDir: resolve("container/agent"), sourceCommit: process.env.GITHUB_SHA, tempDir: process.env.RUNNER_TEMP });
  assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  const outputs = { context: prepared.contextDir, metadata: prepared.metadataPath, "kernel-version": prepared.kernelVersion,
    "kernel-integrity": prepared.kernelIntegrity, "lock-digest": prepared.lockDigest };
  for (const [key, value] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`Prepared OATS ${prepared.kernelVersion}; image lock ${prepared.lockDigest}`);
}
