import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseConfigData } from "../lib/config-data.mjs";
import { writeDeployManifest } from "../container/agent/deploy-manifest.mjs";
import { verifyDeploy, checkExtractedScripts } from "../.github/scripts/team-image-deploy-check.mjs";
import { checkRelease } from "../.github/scripts/check-team-image-release.mjs";
import { checkPrImageLock, PR_KERNEL_SPEC } from "../.github/scripts/team-image-pr-context.mjs";
import { probeComposeBoundary } from "../container/agent/egress/probe-compose-boundary.mjs";
import * as acceptance from "../container/agent/accept.mjs";
import * as deployCheck from "../.github/scripts/team-image-deploy-check.mjs";

const source = fileURLToPath(new URL("../container/agent/", import.meta.url));
const sha = "a".repeat(40);
const agentFiles = ["accept.mjs", "accept.sh", "compose.agent.inputs.yaml", "compose.agent.mirrors.yaml", "compose.agent.outbox.yaml", "compose.agent.trust.yaml", "compose.agent.work.yaml", "compose.agent.yaml", "supervisor.mjs"];
const egressFiles = ["accept.mjs", "compose.agent.yaml", "egress/boundary.mjs", "egress/canary.mjs", "egress/compose.egress.yaml", "egress/compose.minimal.yaml", "egress/policy.mjs", "egress/preflight-network.mjs", "egress/probe-compose-boundary.mjs", "egress/probe-runtime.mjs", "egress/probe-services-backends.mjs", "egress/split.mjs", "supervisor.mjs"];
const installed = { agent: { oats: "0.70.7", aw: "1.36.59", claude: "2.1.322" }, egress: { coredns: "1.15.0", nginx: "1.22.1" } };

function stage(t, image) {
  const directory = mkdtempSync(join(tmpdir(), "oats-deploy-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dockerfile = readFileSync(join(source, image === "agent" ? "Dockerfile" : "egress/Dockerfile"), "utf8");
  for (const line of dockerfile.split("\n")) {
    if (!line.startsWith("COPY --chmod=") || !line.includes("/opt/oats/deploy/")) continue;
    const tokens = line.split(/\s+/), destination = tokens.at(-1).slice("/opt/oats/deploy/".length);
    for (const name of tokens.slice(2, -1)) {
      const target = join(directory, destination.endsWith("/") || !destination ? destination + name.split("/").at(-1) : destination);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(source, name), target);
    }
  }
  return directory;
}

test("Compose boundary refuses missing and unknown plan schemas before engine access", async () => {
  for (const [plan, found] of [[{}, "none"], [{ schema: 3 }, "3"], [{ schema: "1" }, "invalid string"], [null, "none"]]) {
    await assert.rejects(probeComposeBoundary(plan), error => {
      assert.equal(error.code, "E_EGRESS_PLAN_SCHEMA");
      assert.equal(error.message, `E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found ${found}; regenerate the plan with schema: 1 or schema: 2`);
      return true;
    });
  }
});

for (const image of ["agent", "egress"]) test(`${image} deploy files are a complete portable copy with a source-bound manifest`, t => {
  const directory = stage(t, image);
  const manifest = writeDeployManifest({ directory, image, source: sha, installed: installed[image] });
  const expected = image === "agent" ? agentFiles : egressFiles;
  if (image === "agent") assert.deepEqual(expected.filter(name => name.startsWith("compose.agent")).sort(),
    readdirSync(source).filter(name => /^compose\.agent.*\.yaml$/.test(name)).sort(), "every agent Compose fragment ships");
  assert.deepEqual(Object.keys(manifest.files).sort(), expected);
  assert.deepEqual(manifest.installed, installed[image]);
  assert.equal(lstatSync(join(directory, "manifest.json")).mode & 0o777, 0o644);
  assert.deepEqual(verifyDeploy(directory, image, sha, source), manifest);
  for (const name of expected) {
    const file = join(directory, name);
    assert.equal(manifest.files[name], "sha256:" + createHash("sha256").update(readFileSync(file)).digest("hex"));
    if (!name.endsWith(".mjs")) continue;
    for (const [, imported] of readFileSync(file, "utf8").matchAll(/(?:from\s+|import\s*\()?["'](\.[^"']+\.mjs)["']/g)) {
      const target = resolve(dirname(file), imported);
      assert.ok(!relative(directory, target).startsWith(".."), `${name} import escapes copy`);
      assert.ok(lstatSync(target).isFile(), `${name} missing import ${imported}`);
    }
  }
  checkExtractedScripts(directory, image);
  assert.deepEqual(verifyDeploy(directory, image, sha, source), manifest, "script validation leaves the copy intact");
  writeFileSync(join(directory, "extra"), "unexpected");
  assert.throws(() => verifyDeploy(directory, image, sha, source), /complete extracted file inventory/);
  rmSync(join(directory, "extra"));
  writeFileSync(join(directory, "accept.mjs"), "changed");
  assert.throws(() => verifyDeploy(directory, image, sha, source), /complete extracted file inventory/);
});

test("deploy manifests refuse absent or ambiguous source pins and non-file inputs", t => {
  const directory = stage(t, "agent");
  for (const source of [undefined, "", "unknown", "abc", "a".repeat(39), "../source"]) {
    assert.throws(() => writeDeployManifest({ directory, image: "agent", source, installed: installed.agent }), /TEAM_IMAGE_SOURCE_SHA/);
  }
  symlinkSync(join(source, "accept.mjs"), join(directory, "outside.mjs"));
  assert.throws(() => writeDeployManifest({ directory, image: "agent", source: sha, installed: installed.agent }), /regular file/);
  const result = spawnSync(process.execPath, [join(source, "deploy-manifest.mjs"), "agent", directory], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEAM_IMAGE_SOURCE_SHA must be a full source commit SHA/);
});

test("every fragment path resolves within the extracted set or an explicit host input", t => {
  for (const image of ["agent", "egress"]) {
    const directory = stage(t, image);
    for (const name of (image === "agent" ? agentFiles : egressFiles).filter(name => name.endsWith(".yaml"))) {
      const file = join(directory, name), data = parseConfigData(readFileSync(file, "utf8")).value;
      const containedFile = value => {
        assert.equal(typeof value, "string");
        assert.ok(!value.includes("${") && !value.startsWith("/"));
        const target = resolve(dirname(file), value);
        assert.ok(!relative(directory, target).startsWith(".."), `${name}: ${value} escapes copy`);
        assert.ok(lstatSync(target).isFile(), `${name}: ${value} absent`);
      };
      for (const service of Object.values(data.services)) {
        if (service.extends?.file) containedFile(service.extends.file);
        assert.equal(service.build, undefined, "deployment fragments select images, never checkout build contexts");
        assert.equal(service.env_file, undefined);
        for (const volume of service.volumes ?? []) {
          assert.equal(volume.type, "bind");
          assert.match(volume.source, /^\$\{[A-Z_]+:\?[^}]+\}$/, "bind paths must be explicit host inputs without a relative default");
        }
        for (const entry of service.configs ?? []) if (entry.file) containedFile(entry.file);
        for (const entry of service.secrets ?? []) if (entry.file) containedFile(entry.file);
      }
      for (const kind of ["configs", "secrets"]) for (const item of Object.values(data[kind] ?? {})) if (item.file) containedFile(item.file);
      assert.equal(data.include, undefined);
    }
  }
});

test("egress build context admits only pinned runtime and deploy inputs", () => {
  const rules = readFileSync(join(source, "egress/Dockerfile.dockerignore"), "utf8").trim().split("\n");
  assert.deepEqual(rules, ["**", "!egress/", "egress/**", "!egress/Dockerfile", "!egress/policy.mjs", "!egress/supervisor.mjs", "!egress/external.mjs", "!egress/health.mjs", "!egress/probe-ingress.mjs", "!egress/compose.egress.yaml", "!egress/compose.minimal.yaml", "!egress/probe-compose-boundary.mjs", "!egress/boundary.mjs", "!egress/canary.mjs", "!egress/probe-runtime.mjs", "!egress/preflight-network.mjs", "!egress/split.mjs", "!egress/probe-services-backends.mjs", "!accept.mjs", "!supervisor.mjs", "!compose.agent.yaml", "!deploy-manifest.mjs"]);
  const dockerfile = readFileSync(join(source, "egress/Dockerfile"), "utf8");
  const runtimeCopy = dockerfile.split("\n").find(line => line.startsWith("COPY --chmod=") && line.endsWith(" ./"));
  assert.equal(runtimeCopy, "COPY --chmod=644 egress/policy.mjs egress/supervisor.mjs egress/external.mjs egress/health.mjs egress/probe-ingress.mjs ./");
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "node", "\/opt\/egress\/supervisor.mjs"\]/);
  for (const line of dockerfile.split("\n").filter(line => line.startsWith("COPY --chmod="))) {
    for (const name of line.split(/\s+/).slice(2, -1)) assert.ok(rules.includes("!" + name), name);
  }
});

test("committed image pins pass the unchanged release and packed baseline guards", () => {
  const manifest = JSON.parse(readFileSync(join(source, "package.json")));
  const lock = JSON.parse(readFileSync(join(source, "package-lock.json")));
  assert.deepEqual(manifest.dependencies, { "@awebai/oats": "0.70.7", "@awebai/aw": "1.36.59", "@anthropic-ai/claude-code": "2.1.322" });
  assert.equal(checkRelease("tag", "v0.70.7", manifest, lock), "0.70.7");
  const candidate = structuredClone(manifest), candidateLock = structuredClone(lock);
  const entry = candidateLock.packages["node_modules/@awebai/oats"];
  const kernel = { name: "@awebai/oats", version: "0.70.7", integrity: "sha512-" + Buffer.alloc(64, 1).toString("base64"),
    manifest: { name: "@awebai/oats", version: "0.70.7", dependencies: entry.dependencies } };
  candidate.dependencies["@awebai/oats"] = PR_KERNEL_SPEC;
  candidateLock.packages[""].dependencies["@awebai/oats"] = PR_KERNEL_SPEC;
  entry.resolved = PR_KERNEL_SPEC;
  entry.integrity = kernel.integrity;
  const metadata = Object.fromEntries(Object.entries(entry.dependencies).map(([name]) => {
    const value = lock.packages[`node_modules/${name}`];
    return [name, { name, ...value, dist: { tarball: value.resolved, integrity: value.integrity } }];
  }));
  checkPrImageLock({ sourceManifest: manifest, sourceLock: lock, manifest: candidate, lock: candidateLock, kernel, metadata });
});

test("every extracted egress CLI entrypoint is exercised", t => {
  for (const script of ["preflight-network.mjs", "probe-runtime.mjs", "probe-services-backends.mjs"]) {
    const directory = stage(t, "egress");
    appendFileSync(join(directory, "egress", script), '\nif (process.argv[2] === "--help" && import.meta.url === pathToFileURL(process.argv[1]).href) process.stderr.write("broken entrypoint\\n");\n');
    assert.throws(() => checkExtractedScripts(directory, "egress"), /broken entrypoint/, `${script} must be executed`);
  }
});

test("a deploy pair refuses mixed source commits and differing shared files", () => {
  const files = Object.fromEntries(["accept.mjs", "compose.agent.yaml", "supervisor.mjs"].map(name => [name, "sha256:" + "b".repeat(64)]));
  const agent = { image: "agent", source: sha, files }, egress = { image: "egress", source: sha, files: { ...files } };
  assert.throws(() => deployCheck.verifyDeployPair(agent, { ...egress, source: "c".repeat(40) }), /same source commit/);
  for (const name of Object.keys(files)) assert.throws(() => deployCheck.verifyDeployPair(agent, { ...egress, files: { ...files, [name]: "sha256:" + "d".repeat(64) } }), /shared deploy file/);
  deployCheck.verifyDeployPair(agent, egress);
});

test("resolver admission requires a readable non-empty file", t => {
  const directory = mkdtempSync(join(tmpdir(), "oats-resolver-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "resolv.conf");
  const refused = () => assert.throws(() => acceptance.resolverCheck(fs, path), error => {
    assert.equal(error.code, "E_AGENT_RESOLVER");
    assert.equal(error.message, "E_AGENT_RESOLVER: /etc/resolv.conf must be readable and non-empty by the runtime UID");
    return true;
  });
  writeFileSync(path, "");
  refused();
  writeFileSync(path, "nameserver 127.0.0.1\n");
  chmodSync(path, 0);
  try { refused(); } finally { chmodSync(path, 0o644); }
  assert.equal(acceptance.resolverCheck(fs, path), "resolver readable and non-empty by runtime UID");
});
