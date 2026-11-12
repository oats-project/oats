import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKernelPackFiles } from "../../scripts/check-package-dry-runs.mjs";

function relativeFile(path) {
  assert.ok(typeof path === "string" && path && !/[\x00-\x1f\x7f\\]/.test(path), "unsafe package path");
  assert.ok(path.split("/").every((part) => part && part !== "." && part !== ".."), "unsafe package path");
}

// npm has mandatory metadata inclusions; the manifest must declare those too.
// Directory rules end in '/', so a file rule cannot admit a child path.
export function checkPackListing(manifest, pack) {
  assert.equal(manifest.name, "@awebai/oats", "pack the kernel package only");
  assert.equal(pack.name, manifest.name, "packed package name differs from HEAD");
  assert.equal(pack.version, manifest.version, "packed package version differs from HEAD");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length, "literal package.files is required");
  for (const rule of manifest.files) {
    assert.ok(typeof rule === "string" && !/[*?\[\]!]/.test(rule), "package.files requires literal entries");
    relativeFile(rule.endsWith("/") ? rule.slice(0, -1) : rule);
  }
  const paths = new Set();
  assert.ok(Array.isArray(pack.files) && pack.files.length, "empty packed package");
  for (const file of pack.files) {
    relativeFile(file.path);
    assert.ok(!paths.has(file.path), `duplicate packed path: ${file.path}`);
    paths.add(file.path);
    assert.ok(manifest.files.some((rule) => rule.endsWith("/") ? file.path.startsWith(rule) : file.path === rule), `packed file outside package.files: ${file.path}`);
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, "invalid packed size");
    assert.ok(Number.isInteger(file.mode) && file.mode >= 0 && file.mode <= 0o777, "invalid packed mode");
  }
}

// Archive tools are read-only: list types first, then stream regular bytes to
// stdout. No archive member is extracted onto the runner's filesystem.
const runNpmCommand = (args, options) => execFileSync("npm", args, options);
export function packKernel({ sourceDir, sourceCommit, tempDir = tmpdir(), runNpm = runNpmCommand }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, "source commit must be a full commit ID");
  const source = realpathSync(sourceDir), root = mkdtempSync(join(tempDir, "oats-pr-pack-"));
  try {
    for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(join(root, name), "");
    const env = { PATH: process.env.PATH, HOME: root, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1",
      NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
      NPM_CONFIG_CACHE: join(root, "npm-cache"), NPM_CONFIG_UPDATE_NOTIFIER: "false" };
    const options = { cwd: source, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
    const run = (tool, args) => execFileSync(tool, args, options);
    assert.equal(run("git", ["rev-parse", "HEAD"]).toString().trim(), sourceCommit, "checkout differs from the PR head");
    const blob = (path) => run("git", ["show", `${sourceCommit}:${path}`]);
    const manifest = JSON.parse(blob("package.json"));
    const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", root,
      "--registry=https://registry.npmjs.org"], options));
    assert.equal(packed.length, 1, "pack exactly one kernel");
    const [pack] = packed;
    checkPackListing(manifest, pack);
    checkKernelPackFiles(pack, source);
    assert.match(pack.filename, /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/, "unsafe packed filename");
    const tarball = join(root, pack.filename);
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    assert.equal(pack.integrity, integrity, "packed tarball integrity mismatch");
    const members = run("tar", ["-tzf", tarball]).toString().trimEnd().split("\n");
    const types = run("tar", ["-tvzf", tarball]).toString().trimEnd().split("\n");
    assert.equal(types.length, members.length, "ambiguous archive listing");
    assert.ok(types.every((line) => line.startsWith("-")), "packed members must be regular files, not links or directories");
    const entries = new Map(pack.files.map((f) => [`package/${f.path}`, f]));
    assert.deepEqual([...members].sort(), [...entries.keys()].sort(), "archive paths differ from the npm listing");
    const modes = new Map(run("git", ["ls-tree", "-r", "-z", sourceCommit]).toString().split("\0").filter(Boolean)
      .map((line) => { const at = line.indexOf("\t"); return [line.slice(at + 1), line.slice(0, 6)]; }));
    const payload = run("tar", ["-xOzf", tarball]), files = [];
    let offset = 0;
    for (const [index, member] of members.entries()) {
      const file = entries.get(member), head = blob(file.path);
      const mode = modes.get(file.path);
      assert.ok(mode === "100644" || mode === "100755", `packed path must be a regular HEAD file: ${file.path}`);
      assert.equal(file.mode, mode === "100755" ? 0o755 : 0o644, `packed mode differs from HEAD: ${file.path}`);
      assert.equal(types[index].slice(0, 10), mode === "100755" ? "-rwxr-xr-x" : "-rw-r--r--", `archive mode differs from HEAD: ${file.path}`);
      const bytes = payload.subarray(offset, offset + file.size);
      offset += file.size;
      assert.equal(file.size, head.length, `packed size differs from HEAD: ${file.path}`);
      assert.ok(bytes.equals(head), `packed bytes differ from HEAD: ${file.path}`);
      files.push({ path: file.path, size: head.length, mode: file.mode, sha256: createHash("sha256").update(head).digest("hex") });
    }
    assert.equal(offset, payload.length, "unexpected archive payload bytes");
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { root, sourceCommit, name: pack.name, version: pack.version, manifest, tarball, integrity, files };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
