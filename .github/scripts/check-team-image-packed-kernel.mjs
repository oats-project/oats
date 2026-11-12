import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [container, inventoryFile] = process.argv.slice(2);
assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/, "invalid acceptance container name");
const input = readFileSync(inventoryFile), expected = JSON.parse(input);
const digest = `sha256:${createHash("sha256").update(input).digest("hex")}`;
assert.equal(digest, process.env.TEAM_IMAGE_PACKED_INVENTORY_DIGEST, "HEAD inventory changed after context preparation");
assert.equal(expected.name, "@awebai/oats");
assert.match(expected.sourceCommit, /^[a-f0-9]{40}$/);
assert.match(expected.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/);
const program = readFileSync(new URL("./team-image-installed-kernel.cjs", import.meta.url), "utf8");
const observed = JSON.parse(execFileSync("docker", ["exec", "-i", container, "node", "-e", program,
  "/opt/agent/node_modules/@awebai/oats"], { input, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }));
assert.equal(observed.version, expected.version);
assert.equal(observed.files, expected.files.length);
assert.ok(process.env.GITHUB_OUTPUT && process.env.GITHUB_STEP_SUMMARY, "runner evidence outputs are required");
appendFileSync(process.env.GITHUB_OUTPUT, `kernel-version=${observed.version}\n`);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Packed kernel source: \`${expected.sourceCommit}\`; ${observed.files} files match HEAD paths, sizes, modes and hashes; inventory \`${digest}\`.\n`);
console.log(`Verified ${observed.files} installed kernel files from ${expected.sourceCommit}`);
