import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const metadata = (name, version, dependencies = {}) => ({ name, version, dependencies: structuredClone(dependencies),
  dist: { integrity, tarball: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz` } });
function fixture() {
  const sourceManifest = { name: "oats-agent-image", private: true, version: "1.0.0", dependencies: {
    "@awebai/oats": "0.69.18", "@awebai/aw": "1.36.59", "@anthropic-ai/claude-code": "2.1.322",
  } };
  const entry = (m) => ({ version: m.version, resolved: m.dist.tarball, integrity: m.dist.integrity, dependencies: structuredClone(m.dependencies) });
  const deps = { croner: "10.0.1", yaml: "2.9.1" };
  const packages = { "": structuredClone(sourceManifest),
    "node_modules/@awebai/oats": entry(metadata("@awebai/oats", "0.69.18", deps)),
    "node_modules/@awebai/aw": entry(metadata("@awebai/aw", "1.36.59")),
    "node_modules/@anthropic-ai/claude-code": entry(metadata("@anthropic-ai/claude-code", "2.1.322")),
    "node_modules/croner": entry(metadata("croner", "10.0.1")),
    "node_modules/yaml": entry(metadata("yaml", "2.9.1")),
    "node_modules/unchanged-transitive": entry(metadata("unchanged-transitive", "1.2.3")),
  };
  const sourceLock = { name: sourceManifest.name, version: "1.0.0", lockfileVersion: 3, requires: true, packages };
  const manifest = structuredClone(sourceManifest), lock = structuredClone(sourceLock);
  manifest.dependencies["@awebai/oats"] = "0.69.19";
  lock.packages[""].dependencies["@awebai/oats"] = "0.69.19";
  const kernel = metadata("@awebai/oats", "0.69.19", deps);
  lock.packages["node_modules/@awebai/oats"] = entry(kernel);
  return { refType: "tag", refName: "v0.69.19", sourceManifest, sourceLock, manifest, lock, metadata: {
    "@awebai/oats": kernel, croner: metadata("croner", "10.0.1"), yaml: metadata("yaml", "2.9.1"),
  } };
}

test("release context permits the exact tag kernel and its exact runtime dependencies only", async () => {
  const { checkGeneratedLock } = await import("../.github/scripts/team-image-release-context.mjs");
  assert.doesNotThrow(() => checkGeneratedLock(fixture()));
  const f = fixture();
  f.metadata["@awebai/oats"].dependencies.yaml = "2.9.2";
  f.metadata.yaml = metadata("yaml", "2.9.2");
  f.lock.packages["node_modules/@awebai/oats"].dependencies.yaml = "2.9.2";
  f.lock.packages["node_modules/yaml"] = { version: "2.9.2", resolved: f.metadata.yaml.dist.tarball, integrity, dependencies: {} };
  assert.doesNotThrow(() => checkGeneratedLock(f));
});

test("release context rejects unrelated lock updates, additions and removals", async () => {
  const { checkGeneratedLock } = await import("../.github/scripts/team-image-release-context.mjs");
  const changes = [
    (f) => { f.lock.packages["node_modules/@awebai/aw"].integrity = "changed"; },
    (f) => { f.lock.packages["node_modules/@anthropic-ai/claude-code"].version = "2.1.323"; },
    (f) => { f.lock.packages["node_modules/unchanged-transitive"].version = "1.2.4"; },
    (f) => { delete f.lock.packages["node_modules/unchanged-transitive"]; },
    (f) => { f.lock.packages["node_modules/added"] = { version: "1.0.0" }; },
    (f) => { f.lock.name = "different"; },
    (f) => { f.lock.packages[""].version = "2.0.0"; },
    (f) => { f.manifest.private = false; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.throws(() => checkGeneratedLock(f), /unrelated|only the manifest/);
  }
});

test("a claimed kernel dependency cannot change the committed Claude CLI", async () => {
  const { checkGeneratedLock } = await import("../.github/scripts/team-image-release-context.mjs");
  const f = fixture(), name = "@anthropic-ai/claude-code";
  f.metadata["@awebai/oats"].dependencies[name] = "2.1.323";
  f.metadata[name] = metadata(name, "2.1.323");
  f.lock.packages["node_modules/@awebai/oats"].dependencies[name] = "2.1.323";
  f.lock.packages[`node_modules/${name}`] = { version: "2.1.323", resolved: f.metadata[name].dist.tarball, integrity, dependencies: {} };
  assert.throws(() => checkGeneratedLock(f), /unrelated|protected/);
});

test("release context copies the image allowlist, regenerates a private lock and leaves source unchanged", async () => {
  const { prepareReleaseContext } = await import("../.github/scripts/team-image-release-context.mjs");
  const root = mkdtempSync(join(tmpdir(), "oats-release-context-test-"));
  try {
    const source = join(root, "source"); mkdirSync(source);
    const f = fixture();
    writeFileSync(join(source, ".dockerignore"), "**\n!Dockerfile\n!package.json\n!package-lock.json\n!entrypoint.sh\n");
    writeFileSync(join(source, "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(source, "entrypoint.sh"), "fixture entrypoint\n");
    writeFileSync(join(source, "not-an-image-input"), "must not be copied\n");
    const original = JSON.stringify(f.sourceManifest), originalLock = JSON.stringify(f.sourceLock);
    writeFileSync(join(source, "package.json"), original);
    writeFileSync(join(source, "package-lock.json"), originalLock);
    let regenerated = false;
    const runNpm = (args, { cwd, env }) => {
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.ok(args.includes("--registry=https://registry.npmjs.org"));
      if (args[0] === "view") {
        const request = args[1], name = request.slice(0, request.lastIndexOf("@"));
        return JSON.stringify(f.metadata[name]);
      }
      assert.equal(args[0], "install");
      for (const flag of ["--ignore-scripts", "--package-lock-only", "--no-audit", "--no-fund"]) assert.ok(args.includes(flag));
      assert.notEqual(cwd, source);
      assert.deepEqual(JSON.parse(readFileSync(join(cwd, "package.json"))), f.manifest);
      writeFileSync(join(cwd, "package-lock.json"), JSON.stringify(f.lock));
      regenerated = true;
      return "";
    };
    const prepared = prepareReleaseContext({ refType: "tag", refName: "v0.69.19", sourceDir: source, sourceCommit: "a".repeat(40), tempDir: root, runNpm });
    assert.equal(regenerated, true);
    const evidence = JSON.parse(readFileSync(prepared.metadataPath));
    assert.equal(evidence.sourceCommit, "a".repeat(40));
    assert.equal(evidence.sourceTag, "v0.69.19");
    assert.equal(prepared.kernelVersion, "0.69.19");
    assert.equal(prepared.kernelIntegrity, integrity);
    assert.match(prepared.lockDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(readdirSync(prepared.contextDir).sort(), [".dockerignore", "Dockerfile", "entrypoint.sh", "package-lock.json", "package.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(prepared.contextDir, "package-lock.json"))), f.lock);
    assert.equal(readFileSync(join(source, "package.json"), "utf8"), original);
    assert.equal(readFileSync(join(source, "package-lock.json"), "utf8"), originalLock);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release context refuses registry mismatches and non-exact kernel dependencies", async () => {
  const { checkGeneratedLock } = await import("../.github/scripts/team-image-release-context.mjs");
  const cases = [
    (f) => { f.metadata["@awebai/oats"].version = "0.69.20"; },
    (f) => { f.lock.packages["node_modules/@awebai/oats"].integrity = "sha512-wrong"; },
    (f) => { f.metadata["@awebai/oats"].dist.tarball = "https://unapproved.example/oats.tgz"; },
    (f) => { f.metadata["@awebai/oats"].dependencies.yaml = "^2.9.1"; },
    (f) => { f.lock.packages["node_modules/yaml"].version = "2.9.0"; },
    (f) => { f.refType = "branch"; },
    (f) => { f.refName = "v0.69.19-rc.1"; },
  ];
  for (const change of cases) { const f = fixture(); change(f); assert.throws(() => checkGeneratedLock(f)); }
});

test("kernel dependency names cannot supply npm options or escape the package path", async () => {
  const { checkGeneratedLock } = await import("../.github/scripts/team-image-release-context.mjs");
  for (const name of ["--global", "../outside", "x/../../outside"]) {
    const f = fixture(); f.metadata["@awebai/oats"].dependencies[name] = "1.0.0";
    assert.throws(() => checkGeneratedLock(f), /package name/);
  }
});

test("the installed kernel version must equal the release version", async () => {
  const { checkInstalledVersion } = await import("../.github/scripts/check-team-image-release.mjs");
  assert.equal(checkInstalledVersion('{"version":"0.69.19"}', "0.69.19"), "0.69.19");
  for (const raw of ['{"version":"0.69.18"}', '{"version":"0.69.20"}', '{"version":"0.69.19-rc.1"}', '{}', 'not JSON']) {
    assert.throws(() => checkInstalledVersion(raw, "0.69.19"));
  }
});

test("a relocated kernel dependency cannot hide a change to its old shared entry", async () => {
  const { checkGeneratedLock } = await import("../.github/scripts/team-image-release-context.mjs");
  const f = fixture();
  f.lock.packages["node_modules/@awebai/oats/node_modules/yaml"] = structuredClone(f.lock.packages["node_modules/yaml"]);
  f.lock.packages["node_modules/yaml"].integrity = "changed-shared-entry";
  assert.throws(() => checkGeneratedLock(f), /unrelated/);
});

test("release receipt limits its claims and replaces only its own immutable-image block", async () => {
  const { updateReceipt } = await import("../.github/scripts/team-image-receipt.mjs");
  const evidence = { imageReference: `ghcr.io/oats-project/team-agent@sha256:${"a".repeat(64)}`,
    sourceTag: "v0.69.19", sourceCommit: "b".repeat(40), kernelVersion: "0.69.19",
    lockDigest: `sha256:${"c".repeat(64)}`, kernelIntegrity: integrity };
  const notes = "Original release notes.\n\nUser-managed text.\n";
  const first = updateReceipt(notes, evidence);
  assert.ok(first.startsWith(notes));
  assert.match(first, /PASS: image build; non-root user; read-only root; sshd startup; image\/configuration digest binding/);
  assert.match(first, /NOT RUN: supervisor startup; admitted-seat spawn; wake delivery; package sync/);
  assert.match(first, /platform containment and network\/egress-bypass checks/);
  assert.match(first, /does not establish agent readiness/);
  assert.equal(updateReceipt(first, evidence), first);
  const updated = updateReceipt(first, { ...evidence, lockDigest: `sha256:${"d".repeat(64)}` });
  assert.equal(updated.split("### Team agent image").length, 2);
  assert.ok(updated.includes("User-managed text."));
  assert.ok(!updated.includes(evidence.lockDigest));
  assert.throws(() => updateReceipt(notes, { ...evidence, kernelVersion: "0.69.18" }), /equal/);
});
