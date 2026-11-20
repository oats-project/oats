// Standalone Node program: stdin is the HEAD inventory, argv's last item is the
// installed package root. The same bytes run via node -e in the accepted image.
const assert = require("node:assert/strict");
const { lstatSync, readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

const expected = JSON.parse(readFileSync(0, "utf8"));
const root = process.argv.at(-1);
assert.ok(lstatSync(root).isDirectory(), "installed kernel root must be a real directory");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(manifest.name, expected.name, "installed kernel name mismatch");
assert.equal(manifest.version, expected.version, "installed kernel version mismatch");
const files = [];
function walk(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Independently resolved dependencies are governed by the image lock;
    // they are not files belonging to the kernel's own npm tarball.
    if (!prefix && entry.name === "node_modules") {
      assert.ok(entry.isDirectory(), "kernel dependency directory must not be a link");
      continue;
    }
    const path = prefix + entry.name, absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, `${path}/`);
    else {
      assert.ok(entry.isFile(), `installed kernel path is not a regular file: ${path}`);
      const bytes = readFileSync(absolute), stat = lstatSync(absolute);
      files.push({ path, size: bytes.length, mode: stat.mode & 0o7777,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
walk(root);
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
assert.deepEqual(files.sort(byPath), [...expected.files].sort(byPath), "installed kernel file paths/sizes/modes/hashes differ from HEAD");
console.log(JSON.stringify({ name: manifest.name, version: manifest.version, files: files.length }));
