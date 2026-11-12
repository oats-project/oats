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

test("PR context generation preserves HEAD and uses only its bound private tarball", async () => {
  const { preparePrContext } = await import("../.github/scripts/team-image-pr-context.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const root = mkdtempSync(join(tmpdir(), "oats-pr-context-test-"));
  try {
    const source = join(root, "source"), original = fileURLToPath(new URL("../", import.meta.url));
    const gitEnv = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (args, cwd = source) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["clone", "--quiet", "--shared", original, source], root);
    const f = localLockFixture();
    writeFileSync(join(source, "container/agent/package.json"), JSON.stringify(f.sourceManifest));
    writeFileSync(join(source, "container/agent/package-lock.json"), JSON.stringify(f.sourceLock));
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-am", "fixture compatible image baseline"]);
    const sourceCommit = git(["rev-parse", "HEAD"]);
    const before = git(["status", "--porcelain"]);
    const runNpm = (args, options) => {
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.ok(args.includes("--registry=https://registry.npmjs.org"));
      if (args[0] === "pack") {
        assert.ok(args.includes("--ignore-scripts"));
        return execFileSync("npm", args, options);
      }
      if (args[0] === "view") return JSON.stringify(f.metadata[args[1].split("@")[0]]);
      assert.equal(args[0], "install");
      for (const flag of ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]) assert.ok(args.includes(flag));
      const lock = structuredClone(f.sourceLock), cwd = options.cwd;
      lock.packages[""].dependencies["@awebai/oats"] = f.manifest.dependencies["@awebai/oats"];
      Object.assign(lock.packages["node_modules/@awebai/oats"], { resolved: f.manifest.dependencies["@awebai/oats"],
        integrity: `sha512-${createHash("sha512").update(readFileSync(join(cwd, "oats-pr-kernel.tgz"))).digest("base64")}` });
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(lock));
      return "";
    };
    const prepared = preparePrContext({ sourceDir: source, sourceCommit, tempDir: root, runNpm });
    assert.equal(git(["status", "--porcelain"]), before);
    const effective = JSON.parse(readFileSync(join(prepared.contextDir, "package.json")));
    assert.equal(effective.dependencies["@awebai/oats"], "file:../oats-build-inputs/oats-pr-kernel.tgz");
    assert.deepEqual(readdirSync(prepared.contextDir).sort(), [".dockerignore", "Dockerfile", "agent-trust.sh", "entrypoint.sh", "liveness.mjs", "oats-pr-kernel.tgz", "package-lock.json", "package.json", "sshd_config", "supervisor.mjs"]);
    assert.ok(readFileSync(join(prepared.contextDir, ".dockerignore"), "utf8").endsWith("!oats-pr-kernel.tgz\n"));
    assert.deepEqual(readFileSync(join(prepared.contextDir, "oats-pr-kernel.tgz")), readFileSync(join(prepared.root, "oats-build-inputs/oats-pr-kernel.tgz")));
    const proof = JSON.parse(readFileSync(prepared.inventoryPath));
    assert.equal(proof.sourceCommit, sourceCommit);
    assert.ok(proof.files.some((entry) => entry.path === "lib/core.mjs" && entry.size > 0));
    assert.match(prepared.lockDigest, /^sha256:[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the container source probe receives only the accepted container and HEAD inventory", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "oats-source-exec-"));
  try {
    const bin = join(root, "bin"), pkg = join(root, "package"); mkdirSync(bin); mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), '{"name":"@awebai/oats","version":"0.69.18"}\n');
    const inventory = join(root, "inventory.json"), output = join(root, "output");
    writeFileSync(inventory, JSON.stringify({ sourceCommit: "a".repeat(40), name: "@awebai/oats", version: "0.69.18",
      integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`, files: [
        { path: "package.json", size: 44, mode: 0o644, sha256: "8e70d404831d1b86d7cacca96f69c7ef4025bb5e0f8f2edd8fbabb2145209521" },
      ] }));
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const assert = require("node:assert/strict"), fs = require("node:fs"), cp = require("node:child_process");
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 5), ["exec", "-i", "oats-agent-fixture", "node", "-e"]);
assert.equal(args.length, 7);
assert.equal(args[6], "/opt/agent/node_modules/@awebai/oats");
process.stdout.write(cp.execFileSync(process.execPath, ["-e", args[5], process.env.FIXTURE_PACKAGE], { input: fs.readFileSync(0) }));
`, { mode: 0o755 });
    const script = new URL("../.github/scripts/check-team-image-packed-kernel.mjs", import.meta.url);
    const { createHash } = await import("node:crypto");
    const env = { PATH: `${bin}:${process.env.PATH}`, FIXTURE_PACKAGE: pkg, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(root, "summary"),
      TEAM_IMAGE_PACKED_INVENTORY_DIGEST: `sha256:${createHash("sha256").update(readFileSync(inventory)).digest("hex")}` };
    const run = () => spawnSync(process.execPath, [script.pathname, "oats-agent-fixture", inventory], { env, encoding: "utf8" });
    const valid = run(); assert.equal(valid.status, 0, valid.stderr);
    assert.equal(readFileSync(output, "utf8"), "kernel-version=0.69.18\n");
    rmSync(output);
    const originalInventory = readFileSync(inventory);
    writeFileSync(inventory, `${originalInventory} `);
    assert.notEqual(run().status, 0, "the prepared inventory digest must still match");
    writeFileSync(inventory, originalInventory);
    writeFileSync(join(pkg, "unexpected"), "same version, altered installed tree");
    assert.notEqual(run().status, 0);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the default-path proof compares installed payloads without requiring image-ID equality", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "oats-default-proof-test-"));
  try {
    for (const dir of ["bin", "current", "legacy"]) mkdirSync(join(root, dir));
    for (const dir of ["current", "legacy"]) writeFileSync(join(root, dir, "installed"), "same payload\n");
    writeFileSync(join(root, "bin/docker"), `#!/usr/bin/env node
const fs = require("node:fs"), cp = require("node:child_process"), assert = require("node:assert/strict"), path = require("node:path");
const args = process.argv.slice(2), root = process.env.FIXTURE_DIR;
if (args[0] === "image" && args[1] === "inspect") console.log("sha256:" + (args.at(-1).includes("default") ? "b" : "a").repeat(64));
else if (args[0] === "build") {
  const file = fs.readFileSync(path.join(args.at(-1), "Dockerfile"), "utf8");
  assert.ok(file.includes("RUN npm ci --ignore-scripts --no-audit --no-fund"));
  assert.ok(!file.includes("--mount=type=bind"));
} else if (args[0] === "run") {
  assert.ok(args.includes("--read-only") && args.includes("--network=none"));
  const image = args.find((arg) => arg.startsWith("sha256:"));
  const source = path.join(root, image === "sha256:" + "a".repeat(64) ? "current" : "legacy");
  process.stdout.write(cp.execFileSync(process.execPath, ["-e", args[args.indexOf("-e") + 1], source]));
} else if (args[0] === "image" && args[1] === "rm") fs.writeFileSync(path.join(root, "cleaned"), "yes");
else process.exit(2);
`, { mode: 0o755 });
    const script = new URL("../.github/scripts/team-image-default-proof.sh", import.meta.url);
    const env = { PATH: `${join(root, "bin")}:${process.env.PATH}`, FIXTURE_DIR: root, RUNNER_TEMP: root,
      AGENT_IMAGE: "oats-team-agent:fixture", ACCEPTED_IMAGE_ID: `sha256:${"a".repeat(64)}`, GITHUB_SHA: "c".repeat(40), GITHUB_STEP_SUMMARY: join(root, "summary") };
    const run = () => spawnSync("bash", [script.pathname], { env, encoding: "utf8" });
    const equal = run(); assert.equal(equal.status, 0, equal.stderr);
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /Default installed payload.*PASS/);
    assert.equal(readFileSync(join(root, "cleaned"), "utf8"), "yes");
    writeFileSync(join(root, "legacy/installed"), "changed payload\n");
    const changed = run(); assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /payload differs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("packed verification is manual-only until the compatible baseline lands", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseConfigData } = await import("../lib/config-data.mjs");
  const workflow = JSON.parse(JSON.stringify(parseConfigData(readFileSync(new URL("../.github/workflows/team-image.yml", import.meta.url), "utf8")).value));
  assert.equal(workflow.on.workflow_dispatch.inputs.packed_kernel.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.default_payload_proof.default, false);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const packed = workflow.jobs.packed;
  assert.equal(packed.if, "${{ github.event_name == 'workflow_dispatch' && inputs.packed_kernel }}");
  const prepare = packed.steps.findIndex((s) => s.run === "node .github/scripts/team-image-pr-context.mjs");
  const build = packed.steps.findIndex((s) => s.run?.startsWith("docker build "));
  assert.ok(prepare >= 0 && build > prepare);
  assert.equal(packed.steps[prepare].env.TEAM_IMAGE_SOURCE_SHA, "${{ github.sha }}");
  assert.match(packed.steps[build].run, /"\$TEAM_IMAGE_BUILD_CONTEXT"$/);
  const accept = packed.steps.find((s) => s.run === "bash .github/scripts/team-image-accept.sh");
  assert.equal(accept.env.TEAM_IMAGE_PACKED_INVENTORY_DIGEST, "${{ steps.context.outputs.inventory-digest }}");
  const defaultProof = workflow.jobs.verify.steps.find((s) => s.run === "bash .github/scripts/team-image-default-proof.sh");
  assert.equal(defaultProof.if, "${{ github.event_name == 'workflow_dispatch' && inputs.default_payload_proof }}");
  assert.doesNotMatch(JSON.stringify(packed), /GITHUB_TOKEN|packages: write|pull_request_target/);
});
