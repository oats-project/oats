// Static assertions on .github/workflows/release.yml — the binding v0.18.0
// release sequencing (desktop-dist contract):
//   * checkout the EXACT tag SHA (github.sha), never a branch ref;
//   * tag-derived version applied to root, packages/pi AND packages/desktop;
//   * every build/test/smoke step runs BEFORE any npm publication;
//   * the GitHub Release is created AFTER npm publication;
//   * the bump PR covers all three package manifests.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigData } from "../lib/config-data.mjs";

const yml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const desktopPkg = JSON.parse(readFileSync(new URL("../packages/desktop/package.json", import.meta.url), "utf8"));

test("release checks out the exact tag SHA, never a branch ref", () => {
  assert.match(yml, /ref: \$\{\{ github\.sha \}\}/, "checkout pins github.sha");
  assert.ok(!/ref:\s*main\b/.test(yml), "no checkout of the moving main ref");
  // the on-main ancestry gate remains
  assert.match(yml, /merge-base --is-ancestor "\$\{GITHUB_SHA\}" origin\/main/);
});

test("tag-derived version bumps root, pi, and desktop manifests", () => {
  // bump appears in build and publish jobs; each covers all three packages
  const bumps = yml.match(/npm version "[^"]*" --no-git-tag-version/g) || [];
  assert.ok(bumps.length >= 2, "version bumps in build and publish jobs");
  for (const block of yml.split(/- name: Bump all three packages/).slice(1)) {
    const head = block.slice(0, 400);
    assert.match(head, /packages\/pi && npm version/);
    assert.match(head, /packages\/desktop && npm version/);
  }
});

test("release installs root and Desktop test dependencies before npm test, in every one of six shards", () => {
  const testsJob = yml.slice(yml.indexOf("\n  tests:\n"), yml.indexOf("\n  build-and-test:\n"));
  assert.ok(testsJob.length > 0, "a sharded tests job precedes build-and-test");
  assert.match(testsJob, /fail-fast: false/, "one failing shard does not hide the others");
  assert.match(testsJob, /shard: \[1, 2, 3, 4, 5, 6\]/);
  assert.match(testsJob, /ref: \$\{\{ github\.sha \}\}/, "each shard tests the exact tag SHA");
  assert.match(testsJob, /- name: Bump all three packages/, "each shard tests the bumped tree");
  const testStep = testsJob.slice(testsJob.indexOf("Test capability resolution and package commands"));
  assert.match(testStep, /npm test -- --test-shard=\$\{\{ matrix\.shard \}\}\/6/, "each shard runs its share of the suite");
  assert.match(testStep, /npm ci --ignore-scripts/, "fresh release checkout installs root dev dependencies and the pi test binary");
  assert.match(testStep, /packages\/desktop && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci/, "Desktop test dependencies are installed separately");
  const testRun = testStep.lastIndexOf("npm test"); // ignore explanatory comment text
  assert.ok(testStep.indexOf("npm ci --ignore-scripts") < testRun, "root install precedes tests");
  assert.ok(testStep.indexOf("packages/desktop") < testRun, "Desktop install precedes root discovery of Desktop suites");
});

test("all build/smoke steps precede npm publication", () => {
  const publishJob = yml.indexOf("publish:\n");
  assert.ok(publishJob > 0);
  // publication is gated on both build jobs
  assert.match(yml.slice(publishJob), /needs: \[build-and-test, tests, desktop-build\]/, "every test shard gates publication");
  // the first `npm publish` occurs inside the publish job only
  const firstPublish = yml.indexOf("npm publish");
  assert.ok(firstPublish > publishJob, "no npm publish before the gated publish job");
  // smoke steps live in the pre-publish jobs
  for (const step of ["smoke:tarball", "pack:check", "npm test", "scripts/check-version-probe.mjs"]) {
    const at = yml.indexOf(step);
    assert.ok(at >= 0 && at < publishJob, `${step} runs before publication`);
  }
  // desktop build + artifact upload precede publish
  const desktopJob = yml.indexOf("desktop-build:");
  assert.ok(desktopJob > 0 && desktopJob < publishJob);
  assert.match(yml.slice(desktopJob, publishJob), /needs: build-and-test/);
  assert.match(yml.slice(desktopJob, publishJob), /upload-artifact/);
});

test("GitHub Release is created after npm publication, from the same assets", () => {
  const pubOats = yml.indexOf("Publish @awebai/oats");
  const pubPi = yml.indexOf("Publish @awebai/oats-pi");
  const ghRelease = yml.indexOf("gh release create");
  assert.ok(pubOats > 0 && pubPi > pubOats && ghRelease > pubPi, "order: oats → pi → GitHub Release");
  assert.match(yml, /--verify-tag/, "release verifies the pushed tag");
  assert.match(yml, /SHA256SUMS\.txt/, "checksums published");
  assert.match(yml, /attest-build-provenance/, "provenance attestation");
});

test("macOS legs gate a strict deep codesign verification of the packaged app (both workflows, identical, before upload)", () => {
  // Contract (macos-correct-installers): v0.18.2 arm64 shipped an INCOMPLETE
  // linker-generated ad-hoc signature (failed `codesign --verify --deep
  // --strict` with "code has no resources but signature indicates they must
  // be present") and x64 shipped unsigned. Both the release matrix and the
  // build-only matrix must verify the packaged .app with the SAME strict
  // command before smoke/artifact upload — and the two verifier run-blocks
  // must not diverge.
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  const extract = (text, name) => {
    const at = text.indexOf("Verify macOS ad-hoc signature");
    assert.ok(at > 0, `${name}: mac signature verification step present`);
    const runAt = text.indexOf("run: |", at);
    const end = text.indexOf("\n\n", runAt); // run-block ends at the first blank line
    return { at, block: text.slice(runAt, end > 0 ? end : undefined) };
  };
  const rel = extract(yml, "release.yml");
  const build = extract(bi, "build-installers.yml");
  for (const [name, { at, block }, text] of [["release.yml", rel, yml], ["build-installers.yml", build, bi]]) {
    assert.match(block, /codesign --verify --deep --strict --verbose=2/, `${name}: strict deep codesign command`);
    assert.match(block, /no packaged \.app found/, `${name}: fails hard when no .app is found`);
    // gated on macOS legs only, and BEFORE both the smoke and artifact upload
    const guard = text.slice(at - 400, at);
    assert.match(guard + text.slice(at, at + 200), /if: runner\.os == 'macOS'/, `${name}: verifier runs on the mac legs`);
    assert.ok(text.indexOf("dist:smoke", at) > 0, `${name}: verification precedes the installed-artifact smoke`);
    assert.ok(text.lastIndexOf("npm run dist:smoke") > at, `${name}: the smoke run-step follows verification`);
    assert.ok(at < text.indexOf("upload-artifact", at), `${name}: verification precedes artifact upload`);
    // and AFTER the build
    assert.ok(text.indexOf("npm run dist --") < at, `${name}: verification follows the installer build`);
  }
  // identical verifier: the run-blocks must match byte-for-byte
  assert.equal(rel.block, build.block, "release and build-only workflows must gate the IDENTICAL codesign verifier");
});

test("ad-hoc posture wording: workflows never claim 'unsigned' mac artifacts and reference no Apple signing secrets", () => {
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  for (const [name, text] of [["release.yml", yml], ["build-installers.yml", bi]]) {
    // historical mention of the v0.18.2 defect ("x64 shipped unsigned") is
    // allowed; any other 'unsigned' claim about current artifacts is not.
    assert.ok(!/unsigned/i.test(text.replace(/x64 shipped unsigned/g, "")), `${name}: mac artifacts are ad-hoc signed — 'unsigned' wording must not reappear`);
    assert.match(text, /ad-hoc signed/i, `${name}: states the ad-hoc signing posture`);
    assert.ok(!/notarytool|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID|CSC_LINK|CSC_KEY_PASSWORD/.test(text), `${name}: no Apple credentials/notarization surface`);
    assert.match(text, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/, `${name}: certificate auto-discovery stays disabled`);
  }
});

test("release fails fast when the tag has no matching release-notes file", () => {
  // `gh release create` ends the run with --notes-file
  // docs/release-notes/<tag>.md; a tag/filename mismatch must be caught in
  // build-and-test, before any build spend or publication.
  const guard = yml.indexOf("Verify release notes exist for this tag");
  assert.ok(guard > 0, "release-notes existence gate present");
  assert.ok(guard < yml.indexOf("publish:\n"), "gate runs pre-publication");
  assert.match(yml, /docs\/release-notes\/\$\{GITHUB_REF_NAME\}\.md/, "gate checks the tag-named notes file");
  assert.match(yml, /--notes-file docs\/release-notes\/\$\{GITHUB_REF_NAME\}\.md/, "gh release create uses the same tag-named file");
});

test("release refuses a tag while a release-notes entry is left unassembled, before the first bump", (t) => {
  // A pull request writes its entry under docs/release-notes/next/ and the
  // release-prep pull request moves the entries into the tag's notes file
  // (docs/release-lane.md, "Release-notes entries"). Anything still there is
  // missing from the notes the tag publishes and rides in the kernel tarball's
  // docs/, so the tag is refused where the notes-file gate is: in
  // build-and-test, before any build spend or publication.
  const workflow = parseConfigData(yml).value;
  const steps = workflow.jobs["build-and-test"].steps;
  const names = steps.map((step) => step.name);
  const gate = names.indexOf("Verify no release-notes entry is left unassembled");
  assert.ok(gate > 0, "the gate is a step of build-and-test");
  assert.equal(gate, names.indexOf("Verify release notes exist for this tag") + 1, "right after the notes-file gate");
  assert.ok(gate < steps.findIndex((step) => /\bnpm version\b/.test(step.run ?? "")), "before the first version bump of the job");
  assert.ok(workflow.jobs.publish.needs.includes("build-and-test"), "and publication needs the job");
  assert.ok(yml.indexOf("Verify no release-notes entry is left unassembled") < yml.indexOf("publish:\n"));
  assert.deepEqual(Object.keys(steps[gate]), ["name", "run"], "the step is unconditional and may not continue on error");

  // The step's own script, as the runner runs it (bash -e), in a directory that stands for the checkout.
  const dir = mkdtempSync(join(tmpdir(), "oats-release-entries-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => spawnSync("bash", ["-e", "-c", steps[gate].run], { cwd: dir, env: { PATH: process.env.PATH, GITHUB_REF_NAME: "v9.9.9" }, encoding: "utf8" });
  const passes = (why) => { const r = run(); assert.equal(r.status, 0, `${why}: ${r.stdout}${r.stderr}`); assert.equal(r.stdout, ""); };
  passes("no docs/release-notes/next");
  mkdirSync(join(dir, "docs", "release-notes"), { recursive: true });
  writeFileSync(join(dir, "docs", "release-notes", "v9.9.9.md"), "# OATS 9.9.9\n");
  passes("no directory beside the notes file");
  mkdirSync(join(dir, "docs", "release-notes", "next"));
  passes("an empty directory");

  writeFileSync(join(dir, "docs", "release-notes", "next", "1018-entry-files.md"), "## Changed\n\n- an entry\n");
  const refused = run();
  assert.notEqual(refused.status, 0, "one file there refuses the tag");
  const [line, ...rest] = refused.stdout.trimEnd().split("\n");
  assert.deepEqual(rest, [], "one annotation line");
  assert.match(line, /^::error::/);
  assert.ok(line.includes("`node scripts/assemble-release-notes.mjs --tag v9.9.9`"), "names the command with the tag");
  assert.match(line, /in the release-prep pull request/);
  assert.match(line, /docs\/release-notes\/next: 1018-entry-files\.md /, "lists what it found");
  // Anything in the directory counts, whatever its name: a hidden file, a directory.
  rmSync(join(dir, "docs", "release-notes", "next", "1018-entry-files.md"));
  writeFileSync(join(dir, "docs", "release-notes", "next", ".gitkeep"), "");
  assert.match(run().stdout, /next: \.gitkeep /);
  rmSync(join(dir, "docs", "release-notes", "next", ".gitkeep"));
  mkdirSync(join(dir, "docs", "release-notes", "next", "drafts"));
  assert.notEqual(run().status, 0);
});

test("ad-hoc signing posture: certificate auto-discovery disabled; supported matrix only", () => {
  assert.match(yml, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.ok(!/runs-on:\s*windows|os:\s*windows/i.test(yml), "no Windows matrix/job in 0.18.x");
  assert.ok(!/os:\s*macos-13/.test(yml), "release never depends on the sunset macos-13 runner");
  const desktopJob = yml.slice(yml.indexOf("desktop-build:"), yml.indexOf("\n  publish:", yml.indexOf("desktop-build:")));
  assert.match(desktopJob, /os:\s*macos-15[\s\S]*arch:\s*arm64[\s\S]*builder_args:\s*--arm64/, "macOS arm64 on macos-15");
  assert.match(desktopJob, /os:\s*macos-15[\s\S]*arch:\s*x64[\s\S]*builder_args:\s*--x64/, "macOS x64 cross-build on macos-15");
  assert.match(desktopJob, /os:\s*ubuntu-24\.04[\s\S]*arch:\s*x64/, "Linux x64");
  assert.match(desktopJob, /Install Rosetta[\s\S]*matrix\.arch == 'x64'/, "x64 leg installs Rosetta");
  assert.match(desktopJob, /npm run dist -- \$\{\{ matrix\.builder_args \}\}/, "matrix arch flag reaches electron-builder");
});

test("bump PR covers all three package manifests", () => {
  const prBlock = yml.slice(yml.indexOf("Open the version-bump PR"));
  assert.match(prBlock, /git add package\.json package-lock\.json packages\/pi\/package\.json packages\/desktop\/package\.json packages\/desktop\/package-lock\.json/);
  assert.match(prBlock, /gh pr create --base main/);
});

test("the workflow token may open the bump PR it creates", () => {
  // The step runs `gh pr create` with github.token. An explicit `permissions`
  // block grants only what it lists, so pull-requests: write must be listed:
  // every release run that reached this step failed at createPullRequest
  // (v0.40.1 and many before it), after npm and the Release were published.
  const prBlock = yml.slice(yml.indexOf("Open the version-bump PR"));
  assert.match(prBlock, /gh pr create /, "the bump step opens a pull request");
  assert.match(prBlock, /GH_TOKEN: \$\{\{ github\.token \}\}/, "with the workflow token");
  const top = yml.slice(yml.indexOf("\npermissions:"), yml.indexOf("\nconcurrency:"));
  assert.match(top, /^\s+pull-requests: write$/m, "workflow permissions list pull-requests: write");
});

test("the release run opens the bump PR and never merges it", () => {
  // The run tested the bumped tree at the tagged commit, not a later main, and
  // a PR opened with github.token gets no checks. Merging is a maintainer's act.
  assert.doesNotMatch(yml, /gh pr merge/, "no automatic merge anywhere in the release workflow");
  assert.doesNotMatch(yml, /git push origin [^\n]*refs\/heads\/main/, "no direct push to main");
  // [skip ci] on the bump commit would also suppress the checks a maintainer
  // starts by closing and reopening the PR.
  const prBlock = yml.slice(yml.indexOf("Open the version-bump PR"));
  assert.doesNotMatch(prBlock, /git commit -m "[^"]*\[skip ci\]/, "the bump commit carries no [skip ci]");
});

test("bump-PR branch push uses a fully-qualified destination ref (detached-HEAD safe)", () => {
  // The publish job checks out the exact tag SHA (ref: github.sha) → detached
  // HEAD. `git push origin HEAD:<name>` cannot infer refs/heads/ from a
  // detached HEAD and fails ("not a full refname"), which is what broke the
  // v0.18.2 bump-PR step. The destination must be fully qualified.
  const prBlock = yml.slice(yml.indexOf("Open the version-bump PR"));
  assert.match(prBlock, /git push origin "HEAD:refs\/heads\/\$\{BRANCH\}"/,
    "bump-PR push must target HEAD:refs/heads/${BRANCH}");
  // Reject the ambiguous partial-refname form that fails from a detached HEAD.
  assert.ok(!/git push origin "HEAD:\$\{BRANCH\}"/.test(yml),
    "the ambiguous HEAD:${BRANCH} form (no refs/heads/) must not reappear");
});

test("npm publication and GitHub Release are same-tag retryable (idempotent)", () => {
  // Re-running the publish job must skip already-live npm versions instead of
  // failing on npm's already-published rejection, and re-upload GH assets.
  const publishJob = yml.slice(yml.indexOf("publish:\n"));
  const oatsStep = publishJob.slice(publishJob.indexOf("Publish @awebai/oats"), publishJob.indexOf("Publish @awebai/oats-pi"));
  const piStep = publishJob.slice(publishJob.indexOf("Publish @awebai/oats-pi"), publishJob.indexOf("Download Desktop artifacts"));
  assert.match(oatsStep, /npm view "@awebai\/oats@\$\{V\}"/, "oats publish guarded by npm view");
  assert.match(piStep, /npm view "@awebai\/oats-pi@\$\{V\}"/, "pi publish guarded by npm view");
  for (const step of [oatsStep, piStep]) {
    assert.ok(step.indexOf("npm view") < step.indexOf("npm publish"), "guard precedes publish");
    assert.match(step, /already published/, "skip message on retry");
  }
  const ghStep = publishJob.slice(publishJob.indexOf("Create the GitHub Release"));
  assert.match(ghStep, /gh release view/, "release existence checked");
  assert.match(ghStep, /gh release upload .* --clobber/, "retry re-uploads assets");
  assert.ok(ghStep.indexOf("gh release view") < ghStep.indexOf("gh release create"));
});

test("desktop package scripts invoked by the workflow exist", () => {
  // The workflow's desktop-build job runs `npm test` and `npm run dist` in
  // packages/desktop — workflow text matching alone cannot catch a missing
  // script, so both are asserted here. The Desktop suite itself is not run
  // here: CI's `desktop-standalone` job (the release's `npm ci && npm test`
  // inside packages/desktop) is its gate, and the root shards run it too.
  // `dist`/`dist:smoke` are the Desktop owner's deliverable on this seam, but
  // the release path is broken without them — so their presence is asserted
  // UNCONDITIONALLY.
  assert.equal(typeof desktopPkg.scripts.test, "string", "packages/desktop has a test script");
  assert.match(yml, /npm run dist\b/, "workflow invokes npm run dist in packages/desktop");
  assert.equal(typeof desktopPkg.scripts.dist, "string",
    "packages/desktop needs a dist script (electron-builder packaging producing dist/oats-desktop-*) — the release workflow runs `npm run dist` in every desktop matrix leg; this is the Desktop owner's deliverable, landed via feature/desktop-dist");
  assert.ok(
    Object.keys(desktopPkg.devDependencies || {}).some((d) => d.includes("electron-builder")) || /electron-builder/.test(desktopPkg.scripts.dist),
    "dist script is electron-builder packaging");
});

test("electron-builder declares a filesystem-safe Linux executableName (AppImage/DEB name guard)", () => {
  // Without a safe executableName, electron-builder derives it from the
  // SCOPED package name "@awebai/oats-desktop" → "@awebaioats-desktop",
  // whose "@"/"/" fail the Linux AppImage/DEB build ("characters that cannot
  // be safely used in file paths"). This guards that regressing.
  const cfg = readFileSync(new URL("../packages/desktop/electron-builder.config.cjs", import.meta.url), "utf8");
  const m = cfg.match(/executableName:\s*["']([^"']+)["']/);
  assert.ok(m, "electron-builder.config.cjs must declare an executableName (Linux name safety)");
  const name = m[1];
  // filesystem-safe: no scoped-name metacharacters, path separators, or spaces
  assert.match(name, /^[a-z0-9][a-z0-9._-]*$/, `executableName "${name}" must be filesystem-safe (lowercase alnum/._- only)`);
  assert.ok(!/[@/\\ ]/.test(name), `executableName "${name}" must not contain @ / \\ or spaces`);
});

test("release desktop-build matrix does not fail-fast (one leg must not mask the others)", () => {
  // The Linux leg failing fast previously CANCELLED the mac legs, hiding
  // whether they built. Each matrix leg must report independently.
  const desktopJob = yml.indexOf("desktop-build:");
  assert.ok(desktopJob > 0, "desktop-build job present");
  const nextJob = yml.indexOf("\n  publish:", desktopJob);
  const jobText = yml.slice(desktopJob, nextJob > 0 ? nextJob : undefined);
  assert.match(jobText, /fail-fast:\s*false/, "desktop-build matrix sets fail-fast: false");
});

test("build-installers workflow is VERIFY-ONLY (no publish/release/tag surface)", () => {
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  // zero publish surface — the whole point is installer evidence without any release action
  assert.ok(!/npm publish/.test(bi), "must not npm publish");
  assert.ok(!/gh release|actions\/create-release|softprops\/action-gh-release/.test(bi), "must not create a GitHub Release");
  assert.ok(!/npm version|git tag|GITHUB_REF_NAME/.test(bi), "must not tag or bump versions");
  assert.ok(!/NPM_TOKEN|NODE_AUTH_TOKEN/.test(bi), "must not reference publish tokens");
  assert.ok(!/attest-build-provenance/.test(bi), "no attestation (that's the release job)");
  // read-only permissions
  assert.match(bi, /permissions:\s*\n\s*contents:\s*read/, "permissions: contents: read only");
  // same 3-leg matrix as the release desktop-build, fail-fast:false
  assert.match(bi, /fail-fast:\s*false/, "independent per-leg evidence");
  assert.ok(!/os:\s*macos-13/.test(bi), "build verification never depends on the sunset macos-13 runner");
  assert.match(bi, /os:\s*macos-15[\s\S]*arch:\s*arm64[\s\S]*builder_args:\s*--arm64/, "matrix includes mac arm64");
  assert.match(bi, /os:\s*macos-15[\s\S]*arch:\s*x64[\s\S]*builder_args:\s*--x64/, "matrix includes mac x64 cross-build");
  assert.match(bi, /os:\s*ubuntu-24\.04[\s\S]*arch:\s*x64/, "matrix includes Linux x64");
  assert.match(bi, /Install Rosetta[\s\S]*matrix\.arch == 'x64'/, "x64 leg installs Rosetta before smoke");
  assert.match(bi, /npm run dist -- \$\{\{ matrix\.builder_args \}\}/, "matrix arch flag reaches electron-builder");
  // it does build + smoke
  assert.match(bi, /npm run dist\b/, "builds installers");
  assert.match(bi, /npm run dist:smoke/, "runs the installed-artifact smoke");
  assert.match(bi, /upload-artifact/, "uploads the distributables for inspection");
});

test("release and build-only installer smoke are consistent build-verify gates", () => {
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  const desktopJob = yml.slice(yml.indexOf("desktop-build:"), yml.indexOf("\n  publish:", yml.indexOf("desktop-build:")));
  for (const [name, text] of [["release", desktopJob], ["build-installers", bi]]) {
    assert.match(text, /OATS_SMOKE_SKIP_LAUNCH:\s*"1"/, `${name} marks GUI launch skipped`);
    assert.match(text, /OATS_SMOKE_BUILD_VERIFY:\s*"1"/, `${name} explicitly authorizes build-verify mode`);
    assert.match(text, /OATS_SMOKE_TARGET_ARCH:\s*\$\{\{ matrix\.arch \}\}/, `${name} passes the matrix arch to the ABI probe`);
    assert.match(text, /npm run dist:smoke/, `${name} still gates inventory + codesign + node-pty ABI`);
    // The smoke's codesign phase is unconditional on darwin — both CI gates
    // rely on it; neither may set an env var that could skip it (there is
    // none, but the CSC posture below must hold for signing to happen).
    assert.match(text, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/, `${name} keeps certificate auto-discovery disabled (ad-hoc only)`);
  }
  // build-installers runs on pull_request: electron-builder skips mac signing
  // on PR builds (GITHUB_BASE_REF) unless CSC_FOR_PULL_REQUEST is set —
  // without it the PR legs would build the exact unsigned defect class the
  // codesign gate rejects. (Safe: no signing secrets exist; identity is the
  // deterministic ad-hoc "-".) The release workflow runs on tag push (no
  // GITHUB_BASE_REF), so it does not need the flag.
  assert.match(bi, /CSC_FOR_PULL_REQUEST:\s*"true"/, "build-installers must force signing on PR builds (ad-hoc, secret-free)");
  // npm args must reach electron-builder, not a cleanup command: dist is the
  // builder command and postdist owns clean-dist.
  assert.equal(desktopPkg.scripts.dist, "electron-builder --config electron-builder.config.cjs");
  assert.equal(desktopPkg.scripts.postdist, "node scripts/clean-dist.mjs");
});

test("the Linux leg launches the packaged window under xvfb, by the identical step in both workflows; no macOS leg does", () => {
  // The page imports the shared home (packages/client, beside app.asar) from app.asar/renderer.
  // Only a launched window shows that it loads, so the Linux leg runs the smoke once more with
  // its launch phase. The two workflows must not diverge on it, and the build-verify run of
  // the smoke (every leg, launch skipped) stays as it is.
  const jobs = {
    "release.yml": parseConfigData(yml).value.jobs["desktop-build"],
    "build-installers.yml": parseConfigData(readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url))).value.jobs["build-installers"],
  };
  const launches = {};
  for (const [name, job] of Object.entries(jobs)) {
    const smokes = job.steps.filter((step) => /\bnpm run dist:smoke\b/.test(step.run ?? ""));
    assert.equal(smokes.length, 2, `${name}: the build-verify smoke, then the launch`);
    const [verify, launch] = smokes;
    // Every leg: launch skipped, marked as build-verify.
    assert.equal(verify.if, undefined, `${name}: the build-verify smoke runs on every leg`);
    assert.equal(verify.env.OATS_SMOKE_SKIP_LAUNCH, "1");
    assert.equal(verify.env.OATS_SMOKE_BUILD_VERIFY, "1");
    // Linux only: the same smoke with nothing that skips its launch phase, on a virtual display.
    assert.equal(launch.if, "runner.os == 'Linux'", `${name}: the launch runs on the Linux leg only`);
    assert.deepEqual(Object.keys(launch.env), ["OATS_SMOKE_TARGET_ARCH"], `${name}: no OATS_SMOKE_SKIP_LAUNCH, no OATS_SMOKE_BUILD_VERIFY`);
    assert.equal(launch.env.OATS_SMOKE_TARGET_ARCH, "${{ matrix.arch }}");
    assert.equal(launch["working-directory"], "packages/desktop");
    assert.equal(launch["continue-on-error"], undefined, `${name}: a red launch fails the leg`);
    const lines = launch.run.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.equal(lines.at(-1), "xvfb-run -a npm run dist:smoke", `${name}: the smoke, launch phase included, under xvfb`);
    assert.match(lines[0], /^command -v xvfb-run >\/dev\/null \|\| \{ sudo apt-get update && sudo apt-get install -y xvfb; \}$/, `${name}: xvfb is there before it is used`);
    // After the build-verify smoke and the upload: a red launch leaves that evidence and the artifacts.
    const at = (step) => job.steps.indexOf(step), upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.ok(at(verify) < at(upload) && at(upload) < at(launch), `${name}: build-verify smoke, upload, then the launch`);
    assert.equal(at(launch), job.steps.length - 1, `${name}: the launch is the last step`);
    // No other step starts a display or the window, and none is conditioned on macOS to launch.
    assert.deepEqual(job.steps.filter((step) => /xvfb/.test(step.run ?? "")), [launch], `${name}: one step uses a virtual display`);
    for (const step of job.steps.filter((entry) => /macOS/.test(entry.if ?? ""))) {
      assert.doesNotMatch(step.run ?? "", /dist:smoke/, `${name}: no macOS step runs the smoke's launch`);
    }
    launches[name] = launch;
  }
  assert.deepEqual(launches["release.yml"], launches["build-installers.yml"], "release and build-only workflows must launch by the IDENTICAL step");
  // The launch phase onboards a fixture with this repository's kernel: each job installs the root dependencies before it
  // (v0.69.13's release.yml did not, and its Linux leg refused before publication).
  for (const [name, job] of Object.entries(jobs)) {
    const rootInstall = job.steps.findIndex((step) => step["working-directory"] === undefined && /^npm ci\b/m.test(step.run ?? ""));
    assert.ok(rootInstall >= 0 && rootInstall < job.steps.indexOf(launches[name]), `${name}: the root dependencies are installed before the launch`);
  }
  // In release.yml the step is in desktop-build, which publication needs: a window that does not come up publishes nothing.
  assert.ok(parseConfigData(yml).value.jobs.publish.needs.includes("desktop-build"));
  // Each workflow says why macOS has no launch step.
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  for (const [name, text] of [["release.yml", yml], ["build-installers.yml", bi]]) {
    assert.match(text, /macOS has no launch step: a runner gives an ad-hoc signed\s+# app without Developer ID trust no interactive windowserver/, `${name}: says why macOS has no launch step`);
  }
});

test("build-installers runs for a change to the shared home, which every installer carries", () => {
  // The app imports packages/client by relative path and the builder places it beside app.asar:
  // a pull request that touches only that directory changes every installer.
  const workflow = parseConfigData(readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url))).value;
  assert.deepEqual(workflow.on.pull_request.paths, ["packages/desktop/**", "packages/client/**", ".github/workflows/**"]);
  const builder = readFileSync(new URL("../packages/desktop/electron-builder.config.cjs", import.meta.url), "utf8");
  assert.match(builder, /extraResources: \[\{ from: "\.\.\/client", to: "client", filter: \["\*\*\/\*\.mjs"\] \}\]/, "the directory the filter names is the one the builder ships");
});

test("build-installers workflow: own concurrency group (never release.yml's), no tag-push trigger", () => {
  const bi = readFileSync(new URL("../.github/workflows/build-installers.yml", import.meta.url), "utf8");
  // must not collide with a real release run
  assert.ok(!/group:\s*release\b/.test(bi), "must NOT reuse release.yml's concurrency group: release");
  assert.match(bi, /concurrency:\s*\n\s*group:\s*build-installers/, "declares its own build-installers concurrency group");
  // triggered by PR + manual only, never by a tag push (that is release.yml)
  assert.ok(!/on:\s*[\s\S]*push:\s*[\s\S]*tags/.test(bi), "must not trigger on tag push (release.yml owns tags)");
  assert.match(bi, /workflow_dispatch:/, "manual trigger present");
  assert.match(bi, /pull_request:/, "pull_request trigger present");
  // its job name must not be the release matrix job name
  assert.ok(!/^\s*desktop-build:/m.test(bi), "distinct job name from release.yml's desktop-build");
});

test("release reuses the recursive syntax inventory and gates optional theory validation before publication", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.check, "node scripts/check-package-dry-runs.mjs --syntax-only");
  const syntaxStep = yml.slice(yml.indexOf("- name: Syntax-check all shipped JS"), yml.indexOf("- name: Check the kernel, the pi adapter and the project"));
  assert.match(syntaxStep, /run: node scripts\/check-package-dry-runs\.mjs --syntax-only/);
  assert.doesNotMatch(syntaxStep, /git ls-files/, "no narrower hand-maintained release-only pathspecs");
  for (const command of ["npm run check:pi", "npm run validate"]) {
    assert.ok(yml.indexOf(command) > 0 && yml.indexOf(command) < yml.indexOf("publish:\n"), `${command} gates publication`);
  }
  const validator = readFileSync(new URL("../scripts/validate-project.mjs", import.meta.url), "utf8");
  assert.match(validator, /checkKnowledgeTheoryPackage\(\{ repoRoot: root \}\)/);
});

test("every tag-driven npm version invocation permits an already-versioned candidate", () => {
  const commands = yml.split("\n").filter((line) => /npm version "/.test(line));
  assert.equal(commands.length, 10, "three per test shard (one matrix job), three build, one Desktop and three publish bumps");
  for (const command of commands) assert.match(command, /--no-git-tag-version --allow-same-version/);
  assert.match(yml, /git diff --cached --quiet/, "an already-aligned tag does not require a no-op bump PR");
});
