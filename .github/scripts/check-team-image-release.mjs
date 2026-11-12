import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const compare = (left, right) => {
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
};

// The image's supervisor needs the shutdown/broker fixes released in 0.69.18.
// Check the committed pin, not the root manifest (which release.yml bumps).
export function checkRelease(refType, refName, manifest, lock) {
  assert.ok(refType === "tag" && refName?.startsWith("v") && stable.test(refName.slice(1)), "image publication requires a stable vX.Y.Z release tag");
  const version = manifest.dependencies?.["@awebai/oats"];
  assert.ok(typeof version === "string" && stable.test(version), "image OATS dependency must be an exact stable version");
  assert.ok(compare(version, "0.69.18") >= 0, "image publication requires OATS 0.69.18 or newer; update container/agent/package.json and regenerate its lock after the OATS release");
  assert.ok(compare(version, refName.slice(1)) <= 0, "image OATS pin is newer than the release tag; publish that OATS release first");
  assert.equal(lock.packages?.[""]?.dependencies?.["@awebai/oats"], version, "image lock root must match the exact OATS pin");
  assert.equal(lock.packages?.["node_modules/@awebai/oats"]?.version, version, "image lock must resolve the exact OATS pin");
  const aw = manifest.dependencies?.["@awebai/aw"];
  assert.ok(typeof aw === "string" && stable.test(aw), "image aw dependency must be an exact stable version");
  assert.ok(compare(aw, "1.36.59") >= 0, "image publication requires aw 1.36.59 or newer; regenerate the image lock after the final aw release");
  assert.equal(lock.packages?.[""]?.dependencies?.["@awebai/aw"], aw, "image aw lock root must match the exact pin");
  assert.equal(lock.packages?.["node_modules/@awebai/aw"]?.version, aw, "image aw lock must resolve the exact pin");
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = (file) => JSON.parse(readFileSync(file, "utf8"));
  const version = checkRelease(process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME,
    json("container/agent/package.json"), json("container/agent/package-lock.json"));
  console.log(`Image uses released OATS ${version}`);
}
