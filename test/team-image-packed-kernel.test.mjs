import test from "node:test";
import assert from "node:assert/strict";

test("a packed kernel lists only literal package.files paths", async () => {
  const { checkPackListing } = await import("../.github/scripts/team-image-packed-kernel.mjs");
  const manifest = { name: "@awebai/oats", version: "0.69.18", files: ["package.json", "LICENSE", "bin/", "lib/"] };
  const pack = { name: "@awebai/oats", version: "0.69.18", files: [
    { path: "package.json", size: 100, mode: 0o644 },
    { path: "LICENSE", size: 20, mode: 0o644 },
    { path: "bin/oats.mjs", size: 40, mode: 0o755 },
    { path: "lib/core.mjs", size: 80, mode: 0o644 },
  ] };
  assert.doesNotThrow(() => checkPackListing(manifest, pack));
  for (const path of ["outside", "package.json/extra", "../outside", "/outside", "lib/../outside", "lib\\escape", "lib/line\nbreak"]) {
    assert.throws(() => checkPackListing(manifest, { ...pack, files: [...pack.files, { path, size: 1, mode: 0o644 }] }));
  }
  assert.throws(() => checkPackListing(manifest, { ...pack, files: [...pack.files, pack.files[0]] }), /duplicate/);
  for (const change of [ { name: "other" }, { version: "0.69.17" }, { files: [{ path: "LICENSE", size: -1, mode: 0o644 }] },
    { files: [{ path: "LICENSE", size: 1, mode: 0o4644 }] } ]) {
    assert.throws(() => checkPackListing(manifest, { ...pack, ...change }));
  }
  assert.throws(() => checkPackListing({ ...manifest, files: ["**"] }, pack), /literal/);
});

test("packing binds archive bytes and file inventory to the exact HEAD", async () => {
  const { packKernel } = await import("../.github/scripts/team-image-packed-kernel.mjs");
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, rmSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const sourceDir = fileURLToPath(new URL("../", import.meta.url));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
  const packed = packKernel({ sourceDir, sourceCommit });
  try {
    assert.equal(packed.sourceCommit, sourceCommit);
    assert.equal(packed.name, "@awebai/oats");
    assert.match(packed.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    const { createHash } = await import("node:crypto");
    assert.equal(packed.integrity, `sha512-${createHash("sha512").update(readFileSync(packed.tarball)).digest("base64")}`);
    const main = packed.files.find((f) => f.path === "bin/oats.mjs");
    assert.equal(main.mode, 0o755);
    const source = execFileSync("git", ["show", `${sourceCommit}:bin/oats.mjs`], { cwd: sourceDir });
    assert.equal(main.size, source.length);
    assert.equal(main.sha256, createHash("sha256").update(source).digest("hex"));
    assert.ok(packed.files.some((f) => f.path === "LICENSE"));
  } finally { rmSync(packed.root, { recursive: true, force: true }); }
});

test("a packed kernel with HEAD's version but substituted bytes or modes is refused", async () => {
  const { packKernel } = await import("../.github/scripts/team-image-packed-kernel.mjs");
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join } = await import("node:path");
  const { gunzipSync, gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const sourceDir = fileURLToPath(new URL("../", import.meta.url));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceDir, encoding: "utf8" }).trim();
  for (const substitution of ["bytes", "mode"]) {
    let returned;
    const runNpm = (args, options) => {
      const result = JSON.parse(execFileSync("npm", args, options));
      const path = join(args[args.indexOf("--pack-destination") + 1], result[0].filename);
      const archive = gunzipSync(readFileSync(path));
      if (substitution === "bytes") {
        const license = execFileSync("git", ["show", `${sourceCommit}:LICENSE`], { cwd: sourceDir });
        const at = archive.indexOf(license);
        assert.ok(at >= 0);
        archive[at] ^= 1;
      } else {
        // POSIX tar mode/checksum fields. Production uses tar's listing,
        // independently of this fixture's archive-byte manipulation.
        const at = archive.indexOf(Buffer.from("package/bin/oats.mjs\0"));
        assert.ok(at >= 0 && at % 512 === 0);
        archive.write("0000644\0", at + 100);
        archive.fill(32, at + 148, at + 156);
        const sum = archive.subarray(at, at + 512).reduce((a, b) => a + b, 0);
        archive.write(`${sum.toString(8).padStart(6, "0")}\0 `, at + 148);
      }
      const altered = gzipSync(archive);
      writeFileSync(path, altered);
      result[0].integrity = `sha512-${createHash("sha512").update(altered).digest("base64")}`;
      return JSON.stringify(result);
    };
    try {
      assert.throws(() => { returned = packKernel({ sourceDir, sourceCommit, runNpm }); }, /differ(?:s)? from HEAD/, substitution);
    } finally { if (returned) rmSync(returned.root, { recursive: true, force: true }); }
  }
});

test("installed packed files match exact paths, sizes, hashes and modes", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, renameSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../.github/scripts/team-image-installed-kernel.cjs", import.meta.url);
  const expected = { name: "@awebai/oats", version: "0.69.18", files: [
    { path: "package.json", size: 44, mode: 0o644, sha256: "8e70d404831d1b86d7cacca96f69c7ef4025bb5e0f8f2edd8fbabb2145209521" },
    { path: "lib/core.mjs", size: 5, mode: 0o644, sha256: "34d6a94dacb895403529caac12a19aed745c6caca7a8d0f4ed631999044f76e8" },
  ] };
  for (const change of ["none", "same-version-bytes", "size", "mode", "extra", "missing", "renamed", "link"]) {
    const root = mkdtempSync(join(tmpdir(), "oats-installed-kernel-"));
    try {
      mkdirSync(join(root, "lib"));
      writeFileSync(join(root, "package.json"), '{"name":"@awebai/oats","version":"0.69.18"}\n', { mode: 0o644 });
      const core = join(root, "lib/core.mjs");
      writeFileSync(core, "HEAD\n", { mode: 0o644 });
      if (change === "same-version-bytes") writeFileSync(core, "OLD!\n");
      if (change === "size") writeFileSync(core, "HEAD\nextra");
      if (change === "mode") chmodSync(core, 0o755);
      if (change === "extra") writeFileSync(join(root, "lib/extra.mjs"), "HEAD\n");
      if (change === "missing" || change === "link") rmSync(core);
      if (change === "renamed") renameSync(core, join(root, "lib/other.mjs"));
      if (change === "link") symlinkSync("../package.json", core);
      const result = spawnSync(process.execPath, [script.pathname, root], { input: JSON.stringify(expected), encoding: "utf8" });
      if (change === "none") assert.equal(result.status, 0, result.stderr);
      else assert.notEqual(result.status, 0, change);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

function localLockFixture() {
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const deps = { croner: "10.0.1", yaml: "2.9.1" };
  const sourceManifest = { name: "oats-agent-image", version: "1.0.0", private: true, dependencies: {
    "@awebai/oats": "0.69.18", "@awebai/aw": "1.36.59", "@anthropic-ai/claude-code": "2.1.322",
  } };
  const metadata = Object.fromEntries(Object.entries(deps).map(([name, version]) => [name, { name, version,
    dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` } }]));
  const sourceLock = { name: sourceManifest.name, version: "1.0.0", lockfileVersion: 3, packages: {
    "": structuredClone(sourceManifest),
    "node_modules/@awebai/oats": { version: "0.69.18", dependencies: deps },
    "node_modules/@awebai/aw": { version: "1.36.59" },
    "node_modules/@anthropic-ai/claude-code": { version: "2.1.322" },
    ...Object.fromEntries(Object.entries(metadata).map(([name, m]) => [`node_modules/${name}`, { version: m.version, integrity, resolved: m.dist.tarball }])),
  } };
  const manifest = structuredClone(sourceManifest), lock = structuredClone(sourceLock);
  const spec = "file:../oats-build-inputs/oats-pr-kernel.tgz";
  manifest.dependencies["@awebai/oats"] = spec;
  lock.packages[""].dependencies["@awebai/oats"] = spec;
  Object.assign(lock.packages["node_modules/@awebai/oats"], { resolved: spec, integrity });
  const kernel = { name: "@awebai/oats", version: "0.69.18", integrity, manifest: { name: "@awebai/oats", version: "0.69.18", dependencies: deps } };
  return { sourceManifest, sourceLock, manifest, lock, kernel, metadata };
}

test("the PR image lock accepts only its bound local pack and exact dependencies", async () => {
  const { checkPrImageLock } = await import("../.github/scripts/team-image-pr-context.mjs");
  assert.doesNotThrow(() => checkPrImageLock(localLockFixture()));
  for (const change of [
    (f) => { f.lock.packages["node_modules/@awebai/oats"].integrity = "different"; },
    (f) => { f.lock.packages["node_modules/@awebai/oats"].resolved = "https://registry.npmjs.org/other"; },
    (f) => { f.lock.packages["node_modules/@awebai/aw"].version = "1.36.60"; },
    (f) => { delete f.lock.packages["node_modules/@anthropic-ai/claude-code"]; },
    (f) => { f.lock.packages["node_modules/new"] = { version: "1.0.0" }; },
    (f) => { f.kernel.manifest.dependencies.yaml = "^2.9.1"; },
    (f) => { f.manifest.private = false; },
    (f) => { f.lock.lockfileVersion = 4; },
    (f) => { f.sourceManifest.dependencies["@awebai/oats"] = "0.69.15"; },
  ]) { const f = localLockFixture(); change(f); assert.throws(() => checkPrImageLock(f)); }
});

test("the image uses only the owner's additive read-only npm-ci context mount", async () => {
  const { readFileSync } = await import("node:fs");
  const current = readFileSync(new URL("../container/agent/Dockerfile", import.meta.url), "utf8");
  const mounted = "RUN --mount=type=bind,source=.,target=/opt/oats-build-inputs,readonly npm ci --ignore-scripts --no-audit --no-fund";
  assert.ok(current.includes(mounted));
  assert.equal([...current.matchAll(/npm ci --ignore-scripts/g)].length, 1);
  assert.match(current, /&& node -e 'require\.resolve\("@awebai\/aw-linux-"/);
  assert.match(current, /RUN --network=none npm rebuild @awebai\/aw --ignore-scripts=false --offline/);
  assert.doesNotMatch(current, /^ARG |^COPY .*oats-pr-kernel/m);
});
