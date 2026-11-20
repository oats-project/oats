// Inventory the installed npm payload without following links or retaining mtimes.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const root = process.argv.at(-1), entries = [];
function walk(absolute, relative) {
  const stat = fs.lstatSync(absolute), mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) entries.push({ path: relative, type: "link", mode, target: fs.readlinkSync(absolute) });
  else if (stat.isDirectory()) {
    entries.push({ path: relative, type: "directory", mode });
    for (const name of fs.readdirSync(absolute)) walk(path.join(absolute, name), relative ? `${relative}/${name}` : name);
  } else {
    assert.ok(stat.isFile(), `unexpected installed payload type: ${relative}`);
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024), fd = fs.openSync(absolute, "r");
    try { let n; while ((n = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, n)); }
    finally { fs.closeSync(fd); }
    entries.push({ path: relative, type: "file", mode, size: stat.size, sha256: hash.digest("hex") });
  }
}
walk(root, "");
entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
console.log(JSON.stringify(entries));
