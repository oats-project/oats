import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseConfigData } from "../lib/config-data.mjs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const workflow = (name) => JSON.parse(JSON.stringify(parseConfigData(read(`.github/workflows/${name}`)).value));

test("team image verification builds the exact PR head and runs real acceptance without write permissions", () => {
  assert.ok(existsSync(new URL("../.github/workflows/team-image.yml", import.meta.url)), "real image CI workflow exists");
  const w = workflow("team-image.yml");
  assert.deepEqual(Object.keys(w.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.deepEqual(w.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(w.jobs), ["verify"]);
  const job = w.jobs.verify;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha || github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const build = job.steps.findIndex((s) => s.run?.includes("docker build "));
  const accept = job.steps.findIndex((s) => s.run === "bash .github/scripts/team-image-accept.sh");
  assert.ok(build > 0 && accept > build, "the runner builds before invoking acceptance");
  const prepare = job.steps.findIndex((s) => s.run === "bash .github/scripts/team-image-publish.sh --verify");
  assert.ok(prepare > accept, "the PR exercises real export, compression and digest binding after acceptance");
  assert.ok(job.steps.some((s, i) => i < prepare && s.run?.includes("apt-get install -y --no-install-recommends skopeo")));
  assert.match(job.steps[build].run, /--platform linux\/amd64/);
  assert.match(job.steps[build].run, /container\/agent/);
  assert.equal(job.env.AGENT_IMAGE, "oats-team-agent:${{ github.event.pull_request.head.sha || github.sha }}");
  for (const s of job.steps) assert.equal(s["continue-on-error"], undefined);
  assert.doesNotMatch(read(".github/workflows/team-image.yml"), /secrets\.|packages: write|pull_request_target/);
});

test("the shared acceptance fixture runs the image owner's acceptance against Compose", () => {
  const script = read(".github/scripts/team-image-accept.sh");
  assert.match(script, /docker compose/);
  assert.match(script, /container\/agent\/compose\.agent\.yaml/);
  assert.match(script, /up -d --wait --wait-timeout/);
  assert.match(script, /container\/agent\/accept\.sh "oats-agent-\$TEAM" --evidence target-amd64/);
  assert.match(script, /trap cleanup EXIT/);
  assert.doesNotMatch(script, /claude-token|CLAUDE_CODE_OAUTH_TOKEN|docker\.sock/);
});

test("image publication follows the OATS release and stays disabled until the target is confirmed", () => {
  const release = workflow("release.yml"), job = release.jobs["publish-team-image"];
  assert.ok(job, "image publication job exists");
  assert.equal(job.needs, "publish");
  assert.equal(job.if, "${{ false }}", "single explicit approval switch");
  assert.deepEqual(job.permissions, { contents: "write", packages: "write" });
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job.env.IMAGE_REPOSITORY, "ghcr.io/oats-project/team-agent");
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const at = (fragment) => job.steps.findIndex((s) => s.run?.includes(fragment));
  assert.ok(at("check-team-image-release.mjs") < at("docker build "));
  assert.ok(at("docker build ") < at("team-image-accept.sh"));
  assert.ok(at("team-image-accept.sh") < at("team-image-publish.sh"));
  for (const [name, other] of Object.entries(release.jobs)) {
    if (name !== "publish-team-image") assert.notEqual(other.permissions?.packages, "write");
  }
  for (const s of job.steps) {
    assert.equal(s["continue-on-error"], undefined);
    if (s.env?.GITHUB_TOKEN) assert.equal(s.env.GITHUB_TOKEN, "${{ github.token }}");
    assert.doesNotMatch(s.run ?? "", /\$\{\{/);
  }
});

test("the image workflows name every action by a full commit SHA", () => {
  for (const file of ["team-image.yml", "release.yml"]) {
    for (const job of Object.values(workflow(file).jobs)) {
      for (const s of job.steps ?? []) if (s.uses) assert.match(s.uses, /@[a-f0-9]{40}$/);
    }
  }
});

test("publication rejects old kernels, branch refs, prereleases and inconsistent locks", async () => {
  const { checkRelease } = await import("../.github/scripts/check-team-image-release.mjs");
  const manifest = (v) => ({ dependencies: { "@awebai/oats": v, "@awebai/aw": "1.36.59" } });
  const lock = (v) => ({ packages: { "": manifest(v), "node_modules/@awebai/oats": { version: v }, "node_modules/@awebai/aw": { version: "1.36.59" } } });
  assert.equal(checkRelease("tag", "v0.69.18", manifest("0.69.18"), lock("0.69.18")), "0.69.18");
  assert.equal(checkRelease("tag", "v1.0.0", manifest("0.70.0"), lock("0.70.0")), "0.70.0");
  for (const version of ["0.69.15", "0.69.17", "0.69.18-rc.1", "^0.69.18", "latest"]) {
    assert.throws(() => checkRelease("tag", "v0.69.18", manifest(version), lock(version)), /0\.69\.18|exact stable/);
  }
  for (const [type, tag] of [["branch", "v0.69.18"], ["tag", "main"], ["tag", "v0.69.18-rc.1"], ["tag", "v0.69.17"]]) {
    assert.throws(() => checkRelease(type, tag, manifest("0.69.18"), lock("0.69.18")), /release tag|newer than/);
  }
  assert.throws(() => checkRelease("tag", "v0.69.18", manifest("0.69.19"), lock("0.69.19")), /newer than/);
  const inconsistent = lock("0.69.18");
  inconsistent.packages["node_modules/@awebai/oats"].version = "0.69.15";
  assert.throws(() => checkRelease("tag", "v0.69.18", manifest("0.69.18"), inconsistent), /lock/);
  const staleRoot = lock("0.69.18");
  staleRoot.packages[""].dependencies["@awebai/oats"] = "0.69.15";
  assert.throws(() => checkRelease("tag", "v0.69.18", manifest("0.69.18"), staleRoot), /lock/);
});

test("publication requires the final aw release in both image manifest and lock", async () => {
  const { checkRelease } = await import("../.github/scripts/check-team-image-release.mjs");
  const manifest = (aw) => ({ dependencies: { "@awebai/oats": "0.69.18", "@awebai/aw": aw } });
  const lock = (aw) => ({ packages: { "": manifest(aw), "node_modules/@awebai/oats": { version: "0.69.18" }, "node_modules/@awebai/aw": { version: aw } } });
  assert.equal(checkRelease("tag", "v0.69.18", manifest("1.36.59"), lock("1.36.59")), "0.69.18");
  for (const aw of ["1.36.58", "1.36.59-rc.1", "^1.36.59"]) {
    assert.throws(() => checkRelease("tag", "v0.69.18", manifest(aw), lock(aw)), /aw.*1\.36\.59|exact stable/);
  }
  const mismatch = lock("1.36.59");
  mismatch.packages["node_modules/@awebai/aw"].version = "1.36.58";
  assert.throws(() => checkRelease("tag", "v0.69.18", manifest("1.36.59"), mismatch), /aw.*lock/);
});

test("publishing preserves the accepted image and records an immutable digest receipt", () => {
  const script = read(".github/scripts/team-image-publish.sh");
  assert.match(script, /docker save "\$tested" --output/);
  assert.match(script, /docker-archive:/);
  assert.doesNotMatch(script, /docker-daemon:|oci:/);
  assert.match(script, /skopeo copy --dest-compress/);
  assert.match(script, /config\.digest/);
  assert.match(script, /docker image inspect/);
  assert.match(script, /skopeo copy --preserve-digests/);
  assert.match(script, /docker:\/\/\$IMAGE_REPOSITORY@\$digest/);
  assert.match(script, /GITHUB_OUTPUT/);
  assert.match(script, /GITHUB_STEP_SUMMARY/);
  assert.match(script, /gh release edit .*--notes-file/);
  assert.doesNotMatch(script, /docker push|:latest|secrets\./);
});

test("the publisher copies by digest, retains release notes and rejects a substituted image", () => {
  const dir = mkdtempSync(join(tmpdir(), "oats-image-publish-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Docker, the registry client and GitHub are system boundaries. No real
    // credential, network, Docker daemon or release is used by this fixture.
    const configBlob = '{"rootfs":{"type":"layers","diff_ids":[]},"config":{"User":"agent"}}';
    const config = `sha256:${createHash("sha256").update(configBlob).digest("hex")}`;
    const manifest = JSON.stringify({ config: { digest: config } });
    const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
    const boundary = `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
const args = process.argv.slice(2), dir = process.env.FIXTURE_DIR;
const tool = basename(process.argv[1]);
const imageID = process.env.IMAGE_STORE === "containerd" ? "sha256:" + "2".repeat(64) : ${JSON.stringify(config)};
if (tool === "docker" && args[0] === "image") {
  console.log(imageID);
} else if (tool === "docker" && args[0] === "save") {
  if (args[1] !== imageID || args[2] !== "--output") process.exit(2);
  writeFileSync(args[3], ${JSON.stringify(configBlob)});
  writeFileSync(join(dir, "saved-id"), args[1]);
} else if (tool === "skopeo" && args[0] === "login") {
  writeFileSync(join(dir, "login"), "called");
} else if (tool === "skopeo" && args[1]?.startsWith("docker-daemon:")) {
  console.error("client version 1.22 is too old");
  process.exit(1);
} else if (tool === "skopeo" && args[0] === "inspect") {
  if (!args.includes("--raw") || !args.includes("--config")) process.exit(2);
  process.stdout.write(readFileSync(args.at(-1).slice("docker-archive:".length)));
} else if (tool === "skopeo" && args[0] === "manifest-digest") {
  if (!readFileSync(args[1], "utf8").includes("config")) process.exit(2);
  console.log(${JSON.stringify(digest)});
} else if (tool === "skopeo" && args.some((a) => a.startsWith("docker-archive:"))) {
  const source = args.find((a) => a.startsWith("docker-archive:"));
  if (readFileSync(source.slice("docker-archive:".length), "utf8") !== ${JSON.stringify(configBlob)}) process.exit(2);
  if (args.at(-1).startsWith("oci:")) {
    console.error("OCI conversion rewrites Docker configuration bytes");
    process.exit(1);
  }
  if (!args.includes("--dest-compress") || !args.at(-1).startsWith("dir:")) process.exit(2);
  const layout = args.at(-1).slice(4);
  const manifest = process.env.SUBSTITUTE === "yes" ? '{"config":{"digest":"sha256:wrong"}}' : ${JSON.stringify(manifest)};
  mkdirSync(layout, { recursive: true });
  writeFileSync(join(layout, "manifest.json"), manifest);
} else if (tool === "skopeo" && args[0] === "copy") {
  writeFileSync(join(dir, "copy.json"), JSON.stringify(args));
} else if (tool === "gh" && args[1] === "view") {
  console.log("Existing release notes.");
} else if (tool === "gh" && args[1] === "edit") {
  writeFileSync(join(dir, "notes.md"), readFileSync(args.at(-1)));
} else {
  console.error("Unexpected boundary invocation", tool, args);
  process.exit(1);
}
`;
    for (const tool of ["docker", "skopeo", "gh"]) writeFileSync(join(bin, tool), boundary, { mode: 0o755 });
    const env = {
      PATH: `${bin}:${process.env.PATH}`, FIXTURE_DIR: dir, RUNNER_TEMP: dir,
      AGENT_IMAGE: "oats-team-agent:reviewed", IMAGE_REPOSITORY: "ghcr.io/oats-project/team-agent",
      GITHUB_TOKEN: "fixture-token", GITHUB_REF_NAME: "v0.69.18", GITHUB_ACTOR: "fixture",
      GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"),
    };
    const script = new URL("../.github/scripts/team-image-publish.sh", import.meta.url);
    const run = (extra = {}) => spawnSync("bash", [script.pathname], { env: { ...env, ...extra }, encoding: "utf8" });
    const verifyEnv = { ...env };
    for (const key of ["GITHUB_TOKEN", "GITHUB_ACTOR", "GITHUB_REF_NAME", "IMAGE_REPOSITORY"]) delete verifyEnv[key];
    const verified = spawnSync("bash", [script.pathname, "--verify"], { env: verifyEnv, encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    for (const file of ["copy.json", "login", "notes.md"]) assert.equal(existsSync(join(dir, file)), false);
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), `digest=${digest}\n`);
    rmSync(env.GITHUB_OUTPUT);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const copied = JSON.parse(readFileSync(join(dir, "copy.json"), "utf8"));
    assert.ok(copied.includes("--preserve-digests"));
    assert.equal(copied.at(-1), `docker://ghcr.io/oats-project/team-agent@${digest}`);
    assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), `digest=${digest}\n`);
    assert.match(readFileSync(join(dir, "notes.md"), "utf8"), /^Existing release notes\./);
    assert.ok(readFileSync(join(dir, "notes.md"), "utf8").includes(`ghcr.io/oats-project/team-agent@${digest}`));
    assert.equal(readFileSync(join(dir, "saved-id"), "utf8"), config);
    const containerd = run({ IMAGE_STORE: "containerd" });
    assert.equal(containerd.status, 0, containerd.stderr);
    assert.equal(readFileSync(join(dir, "saved-id"), "utf8"), `sha256:${"2".repeat(64)}`);
    for (const file of ["copy.json", "login", "notes.md"]) rmSync(join(dir, file));
    const substituted = run({ SUBSTITUTE: "yes" });
    assert.notEqual(substituted.status, 0);
    assert.match(substituted.stderr, /differs from the accepted Docker image/);
    for (const file of ["copy.json", "login", "notes.md"]) assert.equal(existsSync(join(dir, file)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
