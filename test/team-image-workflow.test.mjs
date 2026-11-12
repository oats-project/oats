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
  assert.throws(() => checkRelease("tag", "v1.0.0", manifest("0.70.0"), lock("0.70.0")), /equal the release tag/);
  for (const version of ["0.69.15", "0.69.17", "0.69.18-rc.1", "^0.69.18", "latest"]) {
    assert.throws(() => checkRelease("tag", "v0.69.18", manifest(version), lock(version)), /0\.69\.18|exact stable/);
  }
  for (const [type, tag] of [["branch", "v0.69.18"], ["tag", "main"], ["tag", "v0.69.18-rc.1"], ["tag", "v0.69.17"]]) {
    assert.throws(() => checkRelease(type, tag, manifest("0.69.18"), lock("0.69.18")), /release tag/);
  }
  assert.throws(() => checkRelease("tag", "v0.69.18", manifest("0.69.19"), lock("0.69.19")), /equal the release tag/);
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
    // Skopeo 1.13.3 uses logrus.Fatal; redirected stderr is quoted key=value
    // output. Keep this exact format rather than a bare registry error string.
    const registryError = (reason) => String.raw`time="2026-11-12T20:00:00Z" level=fatal msg="Error parsing image name \"docker://ghcr.io/oats-project/team-agent:0.69.18\": reading manifest 0.69.18 in ghcr.io/oats-project/team-agent: ${reason}"`;
    const missing = registryError("manifest unknown"), unauthorized = registryError("unauthorized"), denied = registryError("denied");
    const unknownRepository = registryError("name unknown");
    const boundary = `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
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
} else if (tool === "skopeo" && args[0] === "inspect" && args.at(-1).startsWith("docker://")) {
  if (process.env.TAG_STATE === "auth-failure") { console.error(${JSON.stringify(unauthorized)}); process.exit(1); }
  if (process.env.TAG_STATE === "bare-missing") { console.error("manifest unknown"); process.exit(1); }
  if (process.env.TAG_STATE === "unknown-repository") { console.error(${JSON.stringify(unknownRepository)}); process.exit(1); }
  if (process.env.TAG_STATE === "denied") { console.error(${JSON.stringify(denied)}); process.exit(1); }
  if (process.env.TAG_STATE === "conflict") { process.stdout.write('{"config":{"digest":"sha256:other"}}'); }
  else if (process.env.TAG_STATE === "same" || existsSync(join(dir, "tag-copy.json"))) process.stdout.write(${JSON.stringify(manifest)});
  else { console.error(${JSON.stringify(missing)}); process.exit(1); }
} else if (tool === "skopeo" && args[0] === "inspect") {
  if (!args.includes("--raw") || !args.includes("--config")) process.exit(2);
  process.stdout.write(readFileSync(args.at(-1).slice("docker-archive:".length)));
} else if (tool === "skopeo" && args[0] === "manifest-digest") {
  if (!readFileSync(args[1], "utf8").includes("config")) process.exit(2);
  console.log("sha256:" + createHash("sha256").update(readFileSync(args[1])).digest("hex"));
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
  const destination = args.at(-1);
  if (!destination.endsWith("@" + ${JSON.stringify(digest)}) && !destination.endsWith(":0.69.18")) process.exit(2);
  writeFileSync(join(dir, destination.includes("@sha256:") ? "copy.json" : "tag-copy.json"), JSON.stringify(args));
} else if (tool === "gh" && args[1] === "view") {
  console.log(JSON.stringify({ body: existsSync(join(dir, "notes.md")) ? readFileSync(join(dir, "notes.md"), "utf8") : "Existing release notes." }));
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
      ACCEPTED_IMAGE_ID: config, INSTALLED_OATS_VERSION: "0.69.18", GITHUB_SHA: "a".repeat(40),
      BUILD_INPUTS: join(dir, "build-inputs.json"),
      GITHUB_TOKEN: "fixture-token", GITHUB_REF_NAME: "v0.69.18", GITHUB_ACTOR: "fixture",
      GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"),
    };
    writeFileSync(env.BUILD_INPUTS, JSON.stringify({ sourceTag: "v0.69.18", sourceCommit: "a".repeat(40),
      kernelVersion: "0.69.18", lockDigest: "sha256:" + "3".repeat(64), kernelIntegrity: "sha512-" + Buffer.alloc(64, 1).toString("base64") }));
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
    const tagged = JSON.parse(readFileSync(join(dir, "tag-copy.json"), "utf8"));
    assert.ok(tagged.includes("--preserve-digests"));
    assert.equal(tagged.at(-1), "docker://ghcr.io/oats-project/team-agent:0.69.18");
    assert.equal(tagged.at(-2), copied.at(-2), "both copies use the same prepared manifest");
    const firstNotes = readFileSync(join(dir, "notes.md"), "utf8");
    assert.match(firstNotes, /NOT RUN: supervisor startup/);
    assert.match(firstNotes, /Installed kernel:.*0\.69\.18/);
    rmSync(join(dir, "tag-copy.json"));
    assert.equal(run({ TAG_STATE: "same" }).status, 0);
    assert.equal(existsSync(join(dir, "tag-copy.json")), false, "same digest does not rewrite the version tag");
    assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), firstNotes);
    const containerd = run({ IMAGE_STORE: "containerd", ACCEPTED_IMAGE_ID: `sha256:${"2".repeat(64)}` });
    assert.equal(containerd.status, 0, containerd.stderr);
    assert.equal(readFileSync(join(dir, "saved-id"), "utf8"), `sha256:${"2".repeat(64)}`);
    for (const file of ["copy.json", "login", "notes.md"]) rmSync(join(dir, file));
    rmSync(join(dir, "tag-copy.json"));
    for (const state of ["conflict", "auth-failure", "denied", "bare-missing", "unknown-repository"]) {
      const refused = run({ TAG_STATE: state });
      assert.notEqual(refused.status, 0, state);
      assert.equal(existsSync(join(dir, "copy.json")), false, state);
      assert.equal(existsSync(join(dir, "tag-copy.json")), false, state);
      assert.equal(existsSync(join(dir, "notes.md")), false, state);
    }
    const changedImage = run({ ACCEPTED_IMAGE_ID: "sha256:" + "f".repeat(64) });
    assert.notEqual(changedImage.status, 0);
    assert.match(changedImage.stderr, /accepted image ID/);
    rmSync(join(dir, "login"));
    const substituted = run({ SUBSTITUTE: "yes" });
    assert.notEqual(substituted.status, 0);
    assert.match(substituted.stderr, /differs from the accepted Docker image/);
    for (const file of ["copy.json", "login", "notes.md"]) assert.equal(existsSync(join(dir, file)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release image builds a preserved generated context and retains its lock artifact", () => {
  const job = workflow("release.yml").jobs["publish-team-image"];
  const prepare = job.steps.findIndex((s) => s.run === "node .github/scripts/team-image-release-context.mjs");
  assert.ok(prepare >= 0, "release context is prepared");
  assert.equal(job.steps[prepare].id, "context");
  const build = job.steps.find((s) => s.run?.startsWith("docker build "));
  assert.equal(build.env.TEAM_IMAGE_BUILD_CONTEXT, "${{ steps.context.outputs.context }}");
  assert.match(build.run, /"\$TEAM_IMAGE_BUILD_CONTEXT"$/);
  const artifact = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
  assert.match(artifact.with.path, /steps\.context\.outputs\.context.*package-lock\.json/);
  assert.match(artifact.with.path, /steps\.context\.outputs\.metadata/);
  const accept = job.steps.find((s) => s.run === "bash .github/scripts/team-image-accept.sh");
  assert.equal(accept.env.EXPECTED_OATS_VERSION, "${{ steps.context.outputs.kernel-version }}");
});

test("the release image lane pins and verifies the reviewed Skopeo package", () => {
  const install = workflow("release.yml").jobs["publish-team-image"].steps.find((s) => s.run?.includes("apt-get install"));
  assert.match(install.run, /skopeo=1\.13\.3\+ds1-2ubuntu0\.24\.04\.3/);
  assert.match(install.run, /dpkg-query/);
  assert.match(install.run, /1\.13\.3\+ds1-2ubuntu0\.24\.04\.3/);
});

test("PR verification uses the available Skopeo package and records its version", () => {
  const install = workflow("team-image.yml").jobs.verify.steps.find((s) => s.run?.includes("apt-get install"));
  assert.doesNotMatch(read(".github/workflows/team-image.yml"), /skopeo=[^\s]+/, "PR verification must carry no exact apt pin");
  assert.match(install.run, /apt-get install -y --no-install-recommends skopeo\s/);
  assert.match(install.run, /dpkg-query/);
  assert.match(install.run, />> "\$GITHUB_STEP_SUMMARY"/);
});
