// Run with real Node 20 in CI, without installing dependencies: the CLI must refuse
// before any command, compile-cache setup, install stamp or kernel import can run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.match(process.versions.node, /^20\./, "this CI check requires actual Node 20");
const cli = fileURLToPath(new URL("../bin/oats.mjs", import.meta.url));
const base = mkdtempSync(join(tmpdir(), "oats-unsupported-node-"));
const oatsHome = join(base, "oats-home");
const message = `oats needs Node.js 22 or later; this is Node.js ${process.versions.node}`;
const run = (args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: base, encoding: "utf8", timeout: 10000,
  env: { HOME: base, PATH: process.env.PATH, OATS_HOME_DIR: oatsHome },
});
try {
  for (const args of [
    ["version", "--json"],
    ["status", "--json"], // The non-version hot-read form, before argv normalization.
    ["--json", "status"], // The flag also works anywhere in argv.
    ["reader", "--stdio", "--json"],
    ["fixture-capability", "ping", "--json"],
  ]) {
    const child = run(args);
    assert.equal(child.status, 1, JSON.stringify(child));
    assert.equal(child.stderr, "");
    // JSON.parse rejects multiple documents or any extra output on stdout.
    assert.deepEqual(JSON.parse(child.stdout), { schemaVersion: 1, ok: false, error: {
      code: "E_NODE_UNSUPPORTED", message,
      details: { found: process.versions.node, minimum: "22" },
    } });
  }
  const plain = run(["version"]);
  assert.equal(plain.status, 1, JSON.stringify(plain));
  assert.equal(plain.stdout, "");
  assert.equal(plain.stderr, `${message}\n`);
  assert.equal(existsSync(oatsHome), false, "startup made no OATS home or compile cache");
  console.log(`Node ${process.versions.node}: version, hot read, reader, capability and plain refusals passed`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
