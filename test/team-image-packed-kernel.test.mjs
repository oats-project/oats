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
