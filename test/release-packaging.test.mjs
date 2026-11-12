import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  ROOT, checkJavaScript, checkKernelPackFiles, checkNodeFloor, checkReleaseVersions, shippedJavaScript,
} from "../scripts/check-package-dry-runs.mjs";
import { EXPERT_PATH, checkKnowledgeTheoryPackage, treeFiles } from "../scripts/check-knowledge-theory-package.mjs";
import { MIRROR_PATHS } from "../scripts/check-okf-mirror.mjs";
import { ACCEPT_RANGE, acceptProbe, testedBound } from "../packages/client/cli-locator.mjs";
import { LAST_HARD_CEILING_DESKTOP } from "../lib/pi-bridge.mjs";
import { parseVersion, compareVersions } from "../lib/resolve.mjs";

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "oats-release-packaging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
const json = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));

test("a production kernel install brings no pi messaging extension or harness", () => {
  const manifest = json("package.json");
  const lock = json("package-lock.json");
  assert.equal(manifest.dependencies["@awebai/pi"], undefined);
  assert.equal(lock.packages["node_modules/@awebai/pi"], undefined);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (/node_modules\/(?:@awebai\/pi|@earendil-works\/pi-[^/]+)$/.test(path)) {
      assert.equal(entry.dev, true, `${path} must not be installed in production`);
    }
  }
});

test("all release manifests and lock roots agree; Desktop accepts the actual CLI probe", () => {
  const version = checkReleaseVersions();
  const probe = JSON.parse(execFileSync(process.execPath, [join(ROOT, "bin/oats.mjs"), "version", "--json"], { encoding: "utf8" }));
  assert.equal(probe.version, version);
  assert.equal(probe.desktopApi, 1);
  // The Desktop of this release judges its own kernel inside its tested bound: no notice, nothing held back (#1879).
  assert.deepEqual(acceptProbe(probe, json("packages/desktop/package.json").version), { ok: true });
  assert.ok(existsSync(join(ROOT, "docs/release-notes", `v${version}.md`)), "candidate needs matching release notes");
  assert.ok(!json("package.json").files.includes("oats-package/"), "Git-only optional payload is not an npm export");
  for (const dir of ["capabilities/", "mirrors/"]) assert.ok(!json("package.json").files.includes(dir), `${dir} is Git content, not an npm export`);
});

// #1879 acceptance 2 (one source): the Desktop's tested bound is the minor of the version the release manifests
// carry, read from the Desktop's own manifest where it runs (the server's MANIFEST, packages/desktop/package.json),
// and no file spells an upper bound: nothing in release prep moves it by hand.
test("the tested bound is the minor of the version the release manifests carry, from one source, and no file spells an upper bound", () => {
  const version = checkReleaseVersions();
  const { major, minor } = parseVersion(version);
  assert.deepEqual(testedBound(json("packages/desktop/package.json").version), [major, minor]);
  assert.deepEqual(Object.keys(ACCEPT_RANGE), ["min"], "the range keeps its floor and nothing else");
  // The server judges every probe against its own manifest, the one the version-bump PR moves.
  const server = readFileSync(join(ROOT, "packages/desktop/server/oats-web.mjs"), "utf8");
  assert.match(server, /const MANIFEST = \(\(\) => \{\n\s*const p = JSON\.parse\(readFileSync\(join\(HERE, "\.\.", "package\.json"\), "utf8"\)\);/);
  assert.match(server, /testedVersion: MANIFEST\.version,/);
  // No code file spells a ceiling: no `maxExclusive`, no `<x.y.z` range, under the clients, the kernel or the CLI.
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}(),])\/\/[^\n]*/g, "$1");
  const files = execFileSync("git", ["ls-files", "packages/client", "packages/desktop", "packages/tui/lib", "packages/tui/bin", "lib", "bin"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((f) => /\.(mjs|cjs|js)$/.test(f) && !/\/(test|vendor|node_modules)\//.test(f));
  assert.ok(files.length > 100, "the scan reads the sources");
  const spelled = files.filter((f) => existsSync(join(ROOT, f)) && /maxExclusive|<\s*\d+\.\d+\.\d+/.test(code(readFileSync(join(ROOT, f), "utf8"))));
  assert.deepEqual(spelled, [], "an upper bound is spelled here");
});

// The release-prep pull request updates the upgrade page with the notes (docs/release-lane.md,
// "For the tag owner"); oats.setup's oats-upgrade reads the page at the tag, so the tag must carry it.
// Up to the last Desktop with the hard ceiling (LAST_HARD_CEILING_DESKTOP, lib/pi-bridge.mjs) the page states that
// Desktop's band and that it goes first. From the next version it states the floor and the tested bound, and either
// order works (#1879): release prep writes that form from then on.
test("the upgrade page opens with the version being tagged and only its Desktop's range", () => {
  const version = checkReleaseVersions();
  const page = readFileSync(join(ROOT, "docs/upgrading.md"), "utf8");
  const headings = [...page.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.equal(headings[0], "Upgrading to the latest version", "the page opens with the latest version");
  const section = page.slice(page.indexOf("## Upgrading to the latest version"), page.indexOf(`## ${headings[1]}`));
  const { major, minor } = parseVersion(version);
  const floor = ACCEPT_RANGE.min.join(".");
  const hard = compareVersions(parseVersion(version), parseVersion(LAST_HARD_CEILING_DESKTOP)) <= 0;
  const bandText = `>=${floor} <${major}.${minor + 1}.0`;
  const named = [`**OATS ${version}**`, `(release-notes/v${version}.md)`, `npm install -g @awebai/oats@${version}`,
    ...(hard ? [`Desktop ${version} first`, `The ${version} Desktop accepts OATS CLIs \`${bandText}\``]
      : [`Desktop ${version}, in either order`, `The ${version} Desktop accepts OATS CLIs \`>=${floor}\`, tested through ${major}.${minor}`])];
  for (const name of named) assert.ok(section.includes(name), `"Upgrading to the latest version" names ${name}`);
  if (!hard) assert.ok(!section.includes(`Desktop ${version} first`), "either order works from the soft ceiling on");
  const allowed = hard ? [version, floor, `${major}.${minor + 1}.0`] : [version, floor, LAST_HARD_CEILING_DESKTOP];
  for (const [other] of section.matchAll(/\b\d+\.\d+\.\d+\b/g)) {
    assert.ok(allowed.includes(other), `"Upgrading to the latest version" names ${other}, not the version being tagged (${version})`);
  }
  assert.deepEqual([...page.matchAll(/`>=[^`<]*<[^`]*`/g)].map((m) => m[0]), hard ? [`\`${bandText}\``] : [], "the page states only the current Desktop's range");
});

test("release alignment rejects stale lock metadata even when all three manifests agree", (t) => {
  const root = scratch(t);
  for (const file of ["package.json", "package-lock.json", "packages/pi/package.json", "packages/desktop/package.json", "packages/desktop/package-lock.json"]) {
    write(join(root, file), readFileSync(join(ROOT, file)));
  }
  assert.equal(checkReleaseVersions(root), json("package.json").version);
  const file = join(root, "packages/desktop/package-lock.json");
  const lock = JSON.parse(readFileSync(file));
  lock.packages[""].version = "0.0.0";
  write(file, JSON.stringify(lock));
  assert.throws(() => checkReleaseVersions(root), /root entry version differs/);
});

// CI runs Node 22, and the record package the kernel ships needs node:sqlite (22.5).
test("the kernel declares its Node floor, the lock carries it, and no package declares a lower one", (t) => {
  assert.equal(checkNodeFloor(), "22.5.0");
  assert.deepEqual(json("package.json").engines, { node: ">=22.5.0" });
  const fixture = (change) => {
    const root = scratch(t);
    const files = { "package.json": json("package.json"), "package-lock.json": json("package-lock.json"), "packages/record/package.json": json("packages/record/package.json") };
    change(files);
    for (const [file, value] of Object.entries(files)) write(join(root, file), JSON.stringify(value));
    return root;
  };
  assert.equal(checkNodeFloor(fixture(() => {})), "22.5.0");
  assert.throws(() => checkNodeFloor(fixture((files) => { delete files["package.json"].engines; })), /package\.json declares no engines\.node/);
  assert.throws(() => checkNodeFloor(fixture((files) => { files["package.json"].engines.node = "22"; })), /package\.json engines\.node must be ">=x\.y\.z", not "22"/);
  assert.throws(() => checkNodeFloor(fixture((files) => { delete files["package-lock.json"].packages[""].engines; })), /package-lock\.json root entry engines differ/);
  assert.throws(() => checkNodeFloor(fixture((files) => { files["packages/record/package.json"].engines.node = ">=22.4.9"; })), /packages\/record\/package\.json engines\.node >=22\.4\.9 is below the kernel's >=22\.5\.0/);
  const noFloor = fixture((files) => { delete files["packages/record/package.json"].engines; });
  assert.equal(checkNodeFloor(noFloor), "22.5.0", "a package that declares no floor declares no lower one");
});

test("v2 preparation aligns standalone OKF and Git-only theory catalog pins", () => {
  for (const cap of MIRROR_PATHS) {
    assert.equal(json(`${cap}/oats.json`).version, "6.0.3");
    assert.equal(json(`${cap}/oats.json`).compatibility.oats, ">=0.69.2", `${cap}: OKF 5.6.0+ package souls say background:, which a kernel before 0.69.2 refuses; provider CI separately qualifies the real kernel`);
  }
  assert.equal(json("package-catalog.json").packages["oats.okf"].ref, "v6.0.3");
  // The getting-started skill writes a workspace file pinning oats.framework only (#1314): that version is the catalog's.
  const gettingStarted = readFileSync(join(ROOT, "skills/oats-getting-started/SKILL.md"), "utf8");
  assert.match(gettingStarted, /^  oats\.framework: v1\.24\.1\b/m, "the getting-started skill shows the catalog's oats.framework version");
  const catalog = json("package-catalog.json");
  const onboarding = readFileSync(join(ROOT, "oats-package/capabilities/oats-setup/skills/oats-onboarding/SKILL.md"), "utf8");
  const okfVersion = catalog.packages["oats.okf"].ref.slice(1);
  assert.ok(onboarding.includes("`oats.okf` " + okfVersion), "onboarding names the catalog's OKF release");
  assert.ok(onboarding.includes("oats.okf: v" + okfVersion), "onboarding's workspace example pins that release");
  const okfFloor = json(`${MIRROR_PATHS[0]}/oats.json`).compatibility.oats.replace(/^>=/, "");
  assert.ok(onboarding.includes("kernel ≥ " + okfFloor), "onboarding carries the mirrored provider's kernel floor");
  assert.equal(catalog.packages["oats.knowledge-theory"], undefined, "the theory package identity was renamed to oats.framework");
  const framework = catalog.packages["oats.framework"];
  assert.equal(framework.ref, "oats-framework/v1.24.1", "catalog uses the published distribution tag, not a pending kernel release tag");
  assert.equal(framework.path, "oats-package");
  for (const id of ["oats.knowledge-theory", "oats.core", "oats.setup", "oats.onboarding"]) assert.equal(catalog.capabilities[id], "oats.framework");
});

test("syntax inventory recurses through new capability libs, record and package scripts without Git", (t) => {
  const root = scratch(t);
  write(join(root, "package.json"), '{"type":"module"}\n');
  const files = ["bin/oats.mjs", "lib/core.mjs", "capabilities/provider/lib/nested/io.mjs", "capabilities/provider/scripts/nested/check.js", "mirrors/provider/lib/nested/io.mjs", "oats-package/capabilities/theory/lib/deep/entry.mjs", "oats-package/prepare.cjs", "packages/record/lib/capture/deep.mjs", "packages/record/bin/recall.mjs", "packages/pi/extension/core-loader.mjs", "packages/client/reader.mjs", "packages/tui/bin/tui.mjs", "packages/tui/lib/term/deep/keys.mjs", "scripts/pack/new-gate.mjs"];
  for (const file of files) write(join(root, file), "console.log('valid');\n");
  // packages/tui/test is not a root of the inventory: the TUI's tests are never shipped.
  for (const file of [".agents/ignored.mjs", "agents/fixture/state.mjs", "capabilities/provider/node_modules/dep/broken.mjs", "oats-package/.agents/scratch.mjs", "packages/tui/test/broken.test.mjs"]) write(join(root, file), "export const = broken;\n");
  const outside = join(root, "outside"); write(join(outside, "broken.mjs"), "export const = broken;\n");
  symlinkSync(outside, join(root, "capabilities/link"));
  assert.deepEqual(shippedJavaScript(root), files.sort());
  assert.equal(checkJavaScript(root), files.length);
  for (const file of files.filter((f) => /capabilities|mirrors|record|client|tui|scripts/.test(f))) {
    write(join(root, file), "export const = broken;\n");
    assert.throws(() => checkJavaScript(root), (error) => error.message.includes(`syntax error in ${file}`), `must check ${file}`);
    write(join(root, file), "console.log('valid');\n");
  }
});

test("actual npm inventory ships public docs but no partial optional package, capabilities or mirrors; omissions and leaks fail", { timeout: 60_000 }, () => {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" }));
  const files = checkKernelPackFiles(pack);
  const canonical = ["docs/knowledge-capability-authoring.md", ...treeFiles(join(ROOT, "docs/knowledge-reference")).map((file) => `docs/knowledge-reference/${file}`)];
  // The terminal client and the shared reader it imports ship inside the kernel package.
  for (const file of ["bin/oats.mjs", "package-catalog.json", "share/oats-login-receive", "packages/tui/bin/tui.mjs", "packages/tui/lib/client.mjs", "packages/client/display-text.mjs", ...canonical]) {
    assert.ok(files.has(file));
    assert.throws(() => checkKernelPackFiles({ ...pack, files: pack.files.filter((f) => f.path !== file) }), (error) => error.message.includes(`missing ${file}`));
  }
  for (const path of ["oats-package", ...treeFiles(join(ROOT, "oats-package")).map((file) => `oats-package/${file}`)]) {
    assert.ok(!files.has(path), `Git-only file must not be shipped in npm: ${path}`);
    assert.throws(() => checkKernelPackFiles({ ...pack, files: [...pack.files, { path }] }), /Git-only optional package/);
  }
  // The package mirrors and the repository's own capabilities are Git content:
  // capabilities resolve from their remotes at the locked commit, never from the kernel package.
  for (const dir of ["capabilities", "mirrors"]) {
    const shipped = [...files].filter((path) => path === dir || path.startsWith(`${dir}/`));
    assert.deepEqual(shipped, [], `npm must not ship ${dir}/`);
    for (const path of [`${dir}/oats-okf/oats.json`, `${dir}/oats-workspace-experts/injects/oats-experts.md`]) {
      assert.throws(() => checkKernelPackFiles({ ...pack, files: [...pack.files, { path }] }), /Git-only capability file/);
    }
  }
  for (const path of ["agents/live/soul/AGENTS.md", "oats-config.yaml", "oats-lock.json", "capabilities/example/.agents/state.json", "capabilities/example/agents/expert/instances/live/instance.json"]) {
    assert.throws(() => checkKernelPackFiles({ ...pack, files: [...pack.files, { path }] }), /leaks non-runtime/);
  }
  // Every module of the terminal client is packed, and none of its tests or the shared home's.
  const tuiModules = shippedJavaScript().filter((path) => path.startsWith("packages/tui/"));
  assert.ok(tuiModules.length >= 10 && tuiModules.every((path) => files.has(path)), "every packages/tui module is in the tarball");
  assert.ok(files.has("packages/tui/README.md") && files.has("packages/tui/package.json"));
  assert.deepEqual([...files].filter((path) => /^packages\/(?:tui|client)\/test(?:\/|$)/.test(path)), []);
  assert.deepEqual([...files].filter((path) => path.startsWith("packages/client/") && !path.endsWith(".mjs")), [], "the shared home ships modules only");
  for (const path of ["packages/tui/test/keys.test.mjs", "packages/tui/test/helpers.mjs", "packages/client/test/display-text.test.mjs"]) {
    assert.throws(() => checkKernelPackFiles({ ...pack, files: [...pack.files, { path }] }), (error) => error.message.includes(`contains a test file ${path}`));
  }
  // The separate Git payload remains full and canonical, including its SOURCE
  // alias. No npm hooks, duplicate CLAUDE.md, or acquisition-time alias repair.
  assert.equal(checkKnowledgeTheoryPackage().ok, true);
  const soul = join(ROOT, "oats-package", EXPERT_PATH);
  assert.equal(readlinkSync(join(soul, "CLAUDE.md")), "AGENTS.md");
  assert.equal(lstatSync(join(soul, "AGENTS.md")).isFile(), true);
});

test("the credential receiver ships byte-identical and executable in the npm tarball", { timeout: 60_000 }, (t) => {
  const destination = scratch(t);
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { cwd: ROOT, encoding: "utf8" }));
  const files = checkKernelPackFiles(pack);
  assert.ok(files.has("share/oats-login-receive"));
  const bytes = execFileSync("tar", ["-xOf", join(destination, pack.filename), "package/share/oats-login-receive"]);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7ad3ac4aea73519a8c69751cf6ea6e978f9259f8a820b7e3a7cfef0e569bce10");
  assert.equal(pack.files.find((file) => file.path === "share/oats-login-receive").mode & 0o777, 0o755);
});


// Retired 0.29.0: "every framework-shipped capability with an inject declares a helperInjection policy".
// A manifest's helperInjection has been IGNORED since 0.26 (docs/capabilities.md: it served the captured
// path 0.26 removed). okf 4.0.0's new capabilities (oats.okf-harvest, oats.okf-maintenance) ship injects
// without one, legitimately: the guard enforced a contract with no effect.
